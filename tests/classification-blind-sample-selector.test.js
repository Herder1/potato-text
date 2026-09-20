const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertOutputOutsideRuntime,
  buildSelectionManifest,
  createCandidateInventory,
  defaultOutputRoot,
  parseArgs,
  questionContentSignature,
  selectBalancedCandidates,
  writeSelectionReports,
} = require("../scripts/select-classification-blind-samples");

function question(id, stem, overrides = {}) {
  return {
    id,
    library: "official",
    status: "official",
    subjectId: "subject-1",
    bookId: "book-1",
    type: "single_choice",
    stem,
    material: "",
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
    correctAnswer: ["A"],
    referenceAnswer: "A 项符合教材。",
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    answerVerified: true,
    chapter: "旧章",
    knowledgePoints: ["旧知识"],
    primaryKnowledgePoint: "旧知识",
    subKnowledgePoints: [],
    ...overrides,
  };
}

function fixture() {
  const questions = [
    question("q-mature", "下列说法正确的是（ ）。"),
    question("q-mature-peer", "下面哪项符合规则（ ）。", { correctAnswer: ["B"] }),
    question("q-singleton", "结合两个知识判断本题（ ）。"),
    question("q-unmatched", "以下哪项错误（ ）。"),
  ];
  const familyState = {
    families: [
      {
        id: "family-mature",
        bookId: "book-1",
        name: "成熟题族",
        status: "confirmed",
        source: "manual_family",
        coreKnowledgeNodeId: "node-single",
        requiredKnowledgeNodeIds: ["node-single"],
        textbookAnchorNodeIds: ["node-single"],
        members: [
          { questionId: "q-mature", isPrimary: true },
          { questionId: "q-mature-peer", isPrimary: true },
        ],
      },
      {
        id: "family-singleton",
        bookId: "book-1",
        name: "单题题族",
        status: "confirmed",
        source: "manual_family",
        coreKnowledgeNodeId: "node-cross-a",
        requiredKnowledgeNodeIds: ["node-cross-a", "node-cross-b"],
        textbookAnchorNodeIds: ["node-cross-a"],
        members: [{ questionId: "q-singleton", isPrimary: true }],
      },
    ],
  };
  const structureState = {
    records: [{
      bookId: "book-1",
      nodes: [
        { id: "catalog-root", path: "第一章" },
        { id: "node-single", parentId: "catalog-root", path: "第一章 > 单知识" },
        { id: "node-cross-a", parentId: "catalog-root", path: "第一章 > 知识甲" },
        { id: "node-cross-b", parentId: "catalog-root", path: "第一章 > 知识乙" },
      ],
      fingerprints: [
        { questionId: "q-mature", status: "confirmed", primaryNodeId: "node-single", requiredNodeIds: ["node-single"], knowledgePath: "第一章 > 单知识", crossKnowledge: false },
        { questionId: "q-mature-peer", status: "confirmed", primaryNodeId: "node-single", requiredNodeIds: ["node-single"], knowledgePath: "第一章 > 单知识", crossKnowledge: false },
        { questionId: "q-singleton", status: "confirmed", primaryNodeId: "node-cross-a", requiredNodeIds: ["node-cross-a", "node-cross-b"], knowledgePath: "第一章 > 知识甲", crossKnowledge: true },
        { questionId: "q-unmatched", status: "suggested", primaryNodeId: "node-single", requiredNodeIds: ["node-single"], knowledgePath: "第一章 > 单知识", crossKnowledge: false },
      ],
    }],
  };
  const catalogs = [{
    bookId: "book-1",
    status: "confirmed",
    confirmed: { nodes: [{ id: "catalog-root" }] },
  }];
  const dossierState = {
    dossiers: [{
      id: "dossier-single",
      canonicalName: "单知识",
      status: "draft",
      claims: [{ evidence: [{ chunkId: "chunk-1" }] }],
      occurrences: [{ nodeId: "node-single", path: "第一章 > 单知识", printedPageStart: 1, printedPageEnd: 1 }],
    }],
  };
  const experienceState = {
    messages: [{ id: "feedback-q", questionId: "q-mature", resultId: "result-q" }],
    cases: [],
    corrections: [],
    ruleExceptions: [],
    rules: [{ id: "rule-q", sourceQuestionId: "q-mature", statement: "旧规则" }],
  };
  return { questions, familyState, structureState, catalogs, dossierState, experienceState };
}

test("selector distinguishes mature, singleton and unmatched without declaring gold", () => {
  const inventory = createCandidateInventory(fixture());
  const byId = new Map(inventory.candidates.map((candidate) => [candidate.question.id, candidate]));

  assert.equal(byId.get("q-mature").mode, "mature");
  assert.equal(byId.get("q-mature").existingReference.topicFamilies[0].independentMemberCount, 2);
  assert.equal(byId.get("q-mature").existingReference.topicFamilies[0].remainingNovelIndependentMemberCountAfterLeaveOne, 1);
  assert.equal(byId.get("q-singleton").mode, "singleton");
  assert.equal(byId.get("q-singleton").existingReference.topicFamilies[0].independentMemberCount, 1);
  assert.equal(byId.get("q-unmatched").mode, "unmatched");

  for (const candidate of inventory.candidates) {
    assert.equal(candidate.referenceGate.automatedGoldDeclared, false);
    assert.equal(candidate.referenceGate.scoringEligible, false);
  }
  assert.equal(byId.get("q-unmatched").referenceGate.status, "explicit_human_no_match_gold_required");
});

test("selector reports coverage, answer review and masking leaks", () => {
  const inventory = createCandidateInventory(fixture());
  const byId = new Map(inventory.candidates.map((candidate) => [candidate.question.id, candidate]));
  const mature = byId.get("q-mature");
  const singleton = byId.get("q-singleton");

  assert.equal(mature.coverage.knowledgeScope, "single_knowledge");
  assert.equal(mature.coverage.optionJudgment, true);
  assert.equal(singleton.coverage.knowledgeScope, "cross_knowledge");
  assert.equal(mature.answerReview.authority, "verified_source");
  assert.equal(mature.answerReview.usableForBlindReplay, true);
  assert.ok(mature.leakageRisk.items.some((item) => item.code === "current_question_labels"));
  assert.ok(mature.leakageRisk.items.some((item) => item.code === "knowledge_fingerprint"));
  assert.ok(mature.leakageRisk.items.some((item) => item.code === "target_family_membership"));
  assert.ok(mature.leakageRisk.items.some((item) => item.code === "self_experience"));
  assert.ok(singleton.leakageRisk.items.some((item) => item.code === "singleton_family_context"));
  assert.equal(mature.existingReference.dossierEvidence[0].evidencedClaimCount, 1);
});

test("selector propagates scope-anchor roles without counting the anchor as required knowledge", () => {
  const data = fixture();
  const fingerprint = data.structureState.records[0].fingerprints
    .find((item) => item.questionId === "q-unmatched");
  fingerprint.primaryNodeId = "catalog-root";
  fingerprint.primaryNodeRole = "scope_anchor";
  fingerprint.requiredNodeIds = ["node-single"];
  fingerprint.crossKnowledge = false;

  const inventory = createCandidateInventory(data);
  const candidate = inventory.candidates.find((item) => item.question.id === "q-unmatched");
  assert.equal(candidate.coverage.primaryNodeRole, "scope_anchor");
  assert.deepEqual(candidate.coverage.requiredNodeIds, ["node-single"]);
  assert.equal(candidate.coverage.knowledgeScope, "single_knowledge");
  assert.equal(candidate.existingReference.knowledgeFingerprint.primaryNodeRole, "scope_anchor");
  assert.deepEqual(candidate.existingReference.knowledgeFingerprint.requiredNodeIds, ["node-single"]);
});

test("identical question content does not turn a one-case family into mature", () => {
  const data = fixture();
  const duplicate = question("q-mature-copy", "（某校2024年）下列说法正确的是（ ）。");
  data.questions = [data.questions[0], duplicate];
  data.familyState.families = [{
    ...data.familyState.families[0],
    members: [
      { questionId: "q-mature", isPrimary: true },
      { questionId: "q-mature-copy", isPrimary: true },
    ],
  }];
  data.structureState.records[0].fingerprints = [
    { questionId: "q-mature", status: "confirmed", primaryNodeId: "node-single", requiredNodeIds: ["node-single"] },
    { questionId: "q-mature-copy", status: "confirmed", primaryNodeId: "node-single", requiredNodeIds: ["node-single"] },
  ];
  const inventory = createCandidateInventory(data);
  const target = inventory.candidates.find((candidate) => candidate.question.id === "q-mature");

  assert.equal(questionContentSignature(data.questions[0]), questionContentSignature(duplicate));
  assert.equal(target.mode, "singleton");
  assert.equal(target.existingReference.topicFamilies[0].activeMemberCount, 2);
  assert.equal(target.existingReference.topicFamilies[0].independentMemberCount, 1);
  assert.deepEqual(target.duplicateQuestionIds, ["q-mature-copy"]);
  assert.equal(target.leakageRisk.blocksRecommendation, true);
});

test("balanced recommendations cover single, cross and option judgment where available", () => {
  const inventory = createCandidateInventory(fixture());
  const selected = selectBalancedCandidates(inventory.candidates, 3);
  assert.ok(selected.some((candidate) => candidate.coverage.knowledgeScope === "single_knowledge"));
  assert.ok(selected.some((candidate) => candidate.coverage.knowledgeScope === "cross_knowledge"));
  assert.ok(selected.some((candidate) => candidate.coverage.optionJudgment));

  const manifest = buildSelectionManifest(inventory, { limitPerMode: 3 });
  assert.equal(manifest.automatedGoldDeclaration, false);
  assert.equal(manifest.summary.coverageGaps.length, 0);
  assert.equal(manifest.summary.selectedByMode.mature, 2);
  assert.equal(manifest.summary.selectedByMode.singleton, 1);
  assert.equal(manifest.summary.selectedByMode.unmatched, 1);
});

test("CLI validates limits and default output stays outside runtime", () => {
  assert.deepEqual(parseArgs(["--book-id", "book-1", "--limit-per-mode=5"]), {
    bookId: "book-1",
    limitPerMode: 5,
    outputRoot: "",
    help: false,
  });
  assert.throws(() => parseArgs(["--limit-per-mode", "0"]), /limit_per_mode/);
  const projectRoot = path.join("D:\\workspace", "题库");
  const runtimeDir = path.join(projectRoot, ".runtime");
  const outputRoot = defaultOutputRoot(projectRoot);
  assert.doesNotThrow(() => assertOutputOutsideRuntime(outputRoot, runtimeDir));
  assert.throws(() => assertOutputOutsideRuntime(path.join(runtimeDir, "reports"), runtimeDir), /runtime_forbidden/);
});

test("report writer creates only the requested external output directory", (context) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blind-sample-selector-"));
  context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const runtimeDir = path.join(tempRoot, ".runtime");
  const outputRoot = path.join(tempRoot, "outputs");
  fs.mkdirSync(runtimeDir);
  const manifest = buildSelectionManifest(createCandidateInventory(fixture()), { limitPerMode: 2 });
  const result = writeSelectionReports(manifest, {
    outputRoot,
    runtimeDir,
    now: new Date("2026-08-31T02:00:00.000Z"),
  });

  assert.equal(fs.existsSync(result.jsonPath), true);
  assert.equal(fs.existsSync(result.markdownPath), true);
  assert.deepEqual(fs.readdirSync(runtimeDir), []);
  assert.match(fs.readFileSync(result.markdownPath, "utf8"), /自动确认金标准：否/);
});
