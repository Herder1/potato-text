const assert = require("node:assert/strict");
const test = require("node:test");
const {
  activationProblems,
  createMemoryKnowledgeDossierStore,
  relationProblems,
} = require("../apps/api/src/knowledge-dossier-store");

function verifiedDossier(overrides = {}) {
  return {
    bookId: "modern-chinese-7-1",
    canonicalName: "普通话声韵拼合规律",
    aliases: ["声韵拼合规律"],
    definition: "普通话声母和韵母组合时受到的系统性限制。",
    inclusionCriteria: ["能够直接判断某一声母和韵母能否拼合"],
    exclusionCriteria: ["只要求说明音节结构或韵母构成"],
    claims: [{
      statement: "舌面音只能与齐齿呼、撮口呼韵母相拼。",
      evidence: [{ chunkId: "chunk-1", printedPage: 60, excerpt: "舌面音只能跟齐齿呼、撮口呼韵母相拼。" }],
    }],
    occurrences: [
      { nodeId: "node-overview", path: "语音 > 音节 > 概说", role: "overview", chunkIds: ["chunk-1"] },
      { nodeId: "node-rules", path: "语音 > 音节 > 声韵拼合规律", role: "defines", chunkIds: ["chunk-2"] },
    ],
    relations: [],
    verification: {
      evidenceCoverage: 1,
      claimsVerified: true,
      boundaryComplete: true,
      sourceRolesClear: true,
      relationCyclesValid: true,
      conflicts: [],
    },
    ...overrides,
  };
}

function approvedDecisions(dossier, fallbackEvidenceId = "chunk-1") {
  return dossier.reviewDecisions.map((decision) => ({
    ...decision,
    status: "approved",
    evidenceChunkIds: decision.evidenceChunkIds.length ? decision.evidenceChunkIds : [fallbackEvidenceId],
  }));
}

test("a canonical dossier can record one concept in multiple textbook locations", () => {
  const store = createMemoryKnowledgeDossierStore();
  const draft = store.save(verifiedDossier());
  const dossier = store.save({ ...draft, reviewDecisions: approvedDecisions(draft), status: "active" }, "审核员");
  assert.equal(dossier.status, "active");
  assert.equal(dossier.occurrences.length, 2);
  assert.deepEqual(dossier.occurrences.map((item) => item.role), ["overview", "defines"]);
  assert.equal(store.list({ nodeId: "node-overview" })[0].id, dossier.id);
});

test("activation is blocked until evidence and concept boundaries pass verification", () => {
  const store = createMemoryKnowledgeDossierStore();
  const draft = store.save(verifiedDossier({
    status: "draft",
    exclusionCriteria: [],
    verification: { evidenceCoverage: 0.5, claimsVerified: false, boundaryComplete: false },
  }));
  assert.ok(activationProblems(draft).includes("boundary_required"));
  assert.throws(() => store.save({ ...draft, status: "active" }, "审核员"), (error) => {
    assert.equal(error.message, "knowledge_dossier_activation_blocked");
    assert.ok(error.details.problems.includes("evidence_verification_required"));
    return true;
  });
});

test("Agent 4 deltas remain pending and duplicate feedback reuses the original suggestion", () => {
  const store = createMemoryKnowledgeDossierStore();
  const dossier = store.save(verifiedDossier({ status: "boundary_verified" }));
  const input = {
    bookId: dossier.bookId,
    dossierId: dossier.id,
    questionId: "question-1",
    resultId: "result-1",
    type: "exception",
    title: "人工修正案例",
    reason: "这道题只需调用声韵拼合规律。",
    sourceAgent: "Agent 4",
  };
  const first = store.createDelta(input);
  const repeated = store.createDelta(input);
  assert.equal(first.id, repeated.id);
  assert.equal(store.deltas({ status: "pending" }).length, 1);
  const reviewed = store.reviewDelta(first.id, "rejected", "审核员", "不改变概念边界");
  assert.equal(reviewed.status, "rejected");
  assert.equal(reviewed.reviewNote, "不改变概念边界");
});

test("verification claim checks survive normalization and saves always advance updatedAt", async () => {
  const store = createMemoryKnowledgeDossierStore();
  const dossier = store.save(verifiedDossier({ verification: {
    claimChecks: [{ claimId: "claim-1", supported: false, issue: "证据不足", evidenceChunkIds: ["chunk-1"] }],
  }}));
  assert.equal(dossier.verification.claimChecks[0].supported, false);
  const before = dossier.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 3));
  const saved = store.save({ ...dossier, definition: "更新后的定义" });
  assert.ok(saved.updatedAt > before);
  assert.equal(store.get(dossier.id).verification.claimChecks[0].issue, "证据不足");
});

test("confirmed relations need stable non-self targets before activation", () => {
  const store = createMemoryKnowledgeDossierStore();
  const dossier = store.save(verifiedDossier({ relations: [{ type: "is_a", targetName: "上位概念", status: "confirmed" }] }));
  assert.deepEqual(relationProblems(dossier), ["confirmed_relation_target_required"]);
  assert.throws(() => store.save({ ...dossier, status: "active" }), (error) => {
    assert.ok(error.details.problems.includes("confirmed_relation_target_required"));
    return true;
  });
});

test("legacy string boundaries gain stable review item ids", () => {
  const store = createMemoryKnowledgeDossierStore();
  const first = store.save(verifiedDossier());
  const ids = first.boundaryItems.map((item) => item.id);
  const second = store.save({ ...first, aliases: ["拼合限制"] });
  assert.deepEqual(second.boundaryItems.map((item) => item.id), ids);
  assert.deepEqual(second.inclusionCriteria, ["能够直接判断某一声母和韵母能否拼合"]);
  assert.ok(second.reviewDecisions.some((item) => item.itemType === "definition"));
  assert.equal(second.reviewDecisions.filter((item) => ["inclusion", "exclusion"].includes(item.itemType)).length, 2);
});

test("manual review decisions and evidence are required before activation", () => {
  const store = createMemoryKnowledgeDossierStore();
  const draft = store.save(verifiedDossier());
  assert.throws(() => store.save({ ...draft, status: "active" }, "审核员"), (error) => {
    assert.ok(error.details.problems.includes("manual_review_required"));
    return true;
  });
  const withoutDefinitionEvidence = approvedDecisions(draft).map((item) => item.itemType === "definition"
    ? { ...item, evidenceChunkIds: [] }
    : item);
  assert.throws(() => store.save({ ...draft, reviewDecisions: withoutDefinitionEvidence, status: "active" }, "审核员"), (error) => {
    assert.ok(error.details.problems.includes("manual_review_evidence_required"));
    return true;
  });
});

test("editing approved content resets its decision and machine verification", () => {
  const store = createMemoryKnowledgeDossierStore();
  const draft = store.save(verifiedDossier());
  const reviewed = store.save({ ...draft, reviewDecisions: approvedDecisions(draft) }, "审核员");
  const changed = store.save({
    ...reviewed,
    claims: reviewed.claims.map((claim, index) => index ? claim : { ...claim, statement: "修改后的事实声明。" }),
  }, "审核员");
  assert.equal(changed.reviewDecisions.find((item) => item.itemType === "claim").status, "pending_review");
  assert.equal(changed.verification.claimsVerified, false);
  assert.equal(changed.verification.evidenceCoverage, 0);
  assert.equal(changed.verification.verifiedAt, 0);
});

test("interrupted dossier runs are recovered at startup", () => {
  const store = createMemoryKnowledgeDossierStore({ runs: [
    { id: "run-1", bookId: "book", nodeId: "node", status: "compiling" },
    { id: "run-2", bookId: "book", nodeId: "node", status: "verifying" },
    { id: "run-3", bookId: "book", nodeId: "node", status: "completed" },
  ] });
  assert.equal(store.recoverInterruptedRuns(), 2);
  assert.deepEqual(store.runs({ bookId: "book" }).map((run) => run.status).sort(), ["completed", "failed", "failed"]);
  assert.ok(store.runs({ bookId: "book" }).every((run) => run.status !== "failed" || run.error === "server_interrupted"));
});
