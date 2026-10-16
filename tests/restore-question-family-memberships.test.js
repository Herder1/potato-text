const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { buildQuestionFamilyCatalogProjection } = require("../apps/api/src/question-family-catalog-projection");
const { buildRestoration, run, parseArguments, sha256, runtimeHashes } = require("../scripts/maintenance/restore-question-family-memberships");

function fixture() {
  const family = { id: "old-family", subjectId: "subject", bookId: "book", name: "Original family",
    knowledgeNodeId: "node", coreKnowledgeNodeId: "node", requiredKnowledgeNodeIds: ["node"],
    textbookAnchorNodeIds: ["node"], knowledgePath: "Chapter > Node", assessmentAction: "identify",
    status: "confirmed", source: "manual_family", createdAt: 10, updatedAt: 20, reviewedAt: 20, reviewedBy: "Original reviewer",
    members: [
      { questionId: "q1", role: "prototype", isPrimary: true },
      { questionId: "q2", role: "similar", isPrimary: true },
      { questionId: "q3", role: "similar", isPrimary: true },
    ] };
  const current = createMemoryQuestionFamilyStore({
    families: [{ ...family, id: "existing-family", name: "Existing family",
      members: [{ questionId: "q3", role: "prototype", isPrimary: true, reviewStatus: "confirmed" }] }],
    historyByBook: { book: [{ kept: true }] }, membershipRevisionByQuestion: { q1: 5, q3: 9 },
  }).exportState();
  return { current, source: { families: [family] },
    questions: ["q1", "q2", "q3"].map((id) => ({ id, subjectId: "subject", bookId: "book", status: "official" })),
    structures: { records: [{ bookId: "book", nodes: [{ id: "node" }, { id: "other-node" }],
      fingerprints: [{ questionId: "q1", status: "suggested", primaryNodeId: "node" },
        { questionId: "q2", status: "confirmed", primaryNodeId: "other-node" }] }] },
    targets: ["q1", "q2"].map((questionId) => ({ questionId, familyId: "old-family" })) };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-family-restore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDirectory = path.join(root, "runtime");
  fs.mkdirSync(runtimeDirectory);
  const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const data = fixture();
  const sourcePath = path.join(root, "source.json");
  write(sourcePath, data.source);
  write(path.join(runtimeDirectory, "question-families.json"), data.current);
  write(path.join(runtimeDirectory, "questions.json"), data.questions);
  write(path.join(runtimeDirectory, "knowledge-structures.json"), data.structures);
  write(path.join(runtimeDirectory, "admin-actions.json"), [{ id: "existing-audit", action: "existing.operation" }]);
  write(path.join(runtimeDirectory, "unrelated.json"), { preserved: true });
  const planPath = path.join(root, "plan.json");
  write(planPath, { sourcePath, sourceSha256: sha256(fs.readFileSync(sourcePath)), targets: data.targets });
  return { options: { planPath, runtimeDirectory }, root, data, sourcePath, write };
}

test("recovery restores only selected historical links and advances only affected revisions", () => {
  const data = fixture();
  const before = structuredClone(data);
  const result = buildRestoration(data);
  assert.deepStrictEqual(data, before);
  assert.deepStrictEqual(result.next.families[0], data.current.families[0]);
  const family = result.next.families.find((item) => item.id === "old-family");
  assert.deepStrictEqual(family.members.map((member) => member.questionId), ["q1", "q2"]);
  assert.equal(family.status, "confirmed");
  assert.equal(family.reviewedAt, 20);
  assert.equal(family.reviewedBy, "Original reviewer");
  assert.deepStrictEqual(result.next.membershipRevisionByQuestion, { q1: 6, q2: 1, q3: 9 });
});

test("legacy family confirmation never auto-approves recovered member fit or contributions", () => {
  const result = buildRestoration(fixture());
  const family = result.next.families.find((item) => item.id === "old-family");
  for (const member of family.members) {
    assert.equal(member.reviewStatus, "pending_fit");
    assert.equal(member.reviewedAt, null);
    assert.equal(member.reviewedBy, "");
    assert.deepStrictEqual(member.contributionKnowledgeNodeIds, []);
  }
  assert.equal(result.warnings[1].coreDiffers, true);
  assert.deepStrictEqual(buildQuestionFamilyCatalogProjection({ families: [family] }).byQuestionId, {});
  const store = createMemoryQuestionFamilyStore(result.next);
  assert.deepStrictEqual(store.confirmedForQuestion("q1"), []);
});

test("single historical prototype may be restored without restoring unrelated members", () => {
  const data = fixture();
  data.targets = data.targets.slice(0, 1);
  const result = buildRestoration(data);
  assert.equal(result.next.families.find((item) => item.id === "old-family").members.length, 1);
});

for (const [label, change] of [
  ["existing membership", (data) => data.current.families[0].members.push({ ...data.current.families[0].members[0], questionId: "q1", role: "similar" })],
  ["same-name family", (data) => { data.current.families[0].name = "Original family"; }],
  ["alias collision", (data) => { data.current.familyAliases["old-family"] = "existing-family"; }],
  ["missing question", (data) => { data.questions = data.questions.filter((q) => q.id !== "q1"); }],
  ["changed textbook", (data) => { data.questions[0].bookId = "another-book"; }],
  ["missing knowledge node", (data) => { data.structures.records[0].nodes = []; }],
  ["missing original prototype", (data) => { data.targets = data.targets.slice(1); }],
  ["duplicate target", (data) => { data.targets.push(data.targets[0]); }],
  ["unconfirmed old definition", (data) => { data.source.families[0].status = "pending_review"; }],
  ["unsupported historical relationship", (data) => { data.targets[0].familyId = "not-in-backup"; }],
]) {
  test(`recovery refuses ${label}`, () => { const data = fixture(); change(data); assert.throws(() => buildRestoration(data)); });
}

test("dry run is read-only and execute requires the exact current preview", (t) => {
  const { options } = workspace(t);
  const before = runtimeHashes(options.runtimeDirectory);
  const preview = run(options);
  assert.equal(preview.mode, "dry-run");
  assert.deepStrictEqual(runtimeHashes(options.runtimeDirectory), before);
  assert.ok(!fs.existsSync(path.join(options.runtimeDirectory, "maintenance-backups")));
  assert.throws(() => run({ ...options, execute: true, confirm: "wrong" }), /Preview changed/);
  assert.deepStrictEqual(runtimeHashes(options.runtimeDirectory), before);
});

test("execution backs up, uses formal Stores, preserves data and audits, and reruns without writes", (t) => {
  const { options, data } = workspace(t);
  const before = runtimeHashes(options.runtimeDirectory);
  const result = run({ ...options, execute: true, confirm: run(options).previewHash });
  assert.equal(result.status, "committed");
  const audit = JSON.parse(fs.readFileSync(path.join(options.runtimeDirectory, "admin-actions.json")));
  assert.equal(audit.length, 2);
  assert.equal(audit[0].actorRole, "maintenance");
  assert.equal(audit[0].actorId, "");
  assert.deepStrictEqual(audit[1], { id: "existing-audit", action: "existing.operation" });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(result.backupDirectory, "question-families.before.json"))), data.current);
  assert.equal(result.afterHashes["questions.json"], before["questions.json"]);
  assert.equal(result.afterHashes["knowledge-structures.json"], before["knowledge-structures.json"]);
  const after = runtimeHashes(options.runtimeDirectory);
  assert.equal(run({ ...options, execute: true }).changed, false);
  assert.deepStrictEqual(runtimeHashes(options.runtimeDirectory), after);
});

test("tampered backup is rejected before any write", (t) => {
  const { options, sourcePath } = workspace(t);
  const before = runtimeHashes(options.runtimeDirectory);
  fs.appendFileSync(sourcePath, " ");
  assert.throws(() => run(options), /backup hash mismatch/);
  assert.deepStrictEqual(runtimeHashes(options.runtimeDirectory), before);
});

test("a concurrent update before commit is not overwritten", (t) => {
  const { options, write } = workspace(t);
  const before = runtimeHashes(options.runtimeDirectory);
  assert.throws(() => run({ ...options, execute: true, confirm: run(options).previewHash }, {
    beforeCommit: () => write(path.join(options.runtimeDirectory, "unrelated.json"), { userChange: true }),
  }), /Runtime changed/);
  const after = runtimeHashes(options.runtimeDirectory);
  assert.equal(after["question-families.json"], before["question-families.json"]);
  assert.equal(after["admin-actions.json"], before["admin-actions.json"]);
  assert.notEqual(after["unrelated.json"], before["unrelated.json"]);
});

test("a failure before audit safely compensates only this recovery", (t) => {
  const { options } = workspace(t);
  const before = runtimeHashes(options.runtimeDirectory);
  assert.throws(() => run({ ...options, execute: true, confirm: run(options).previewHash }, {
    afterFamilyWrite: () => { throw new Error("simulated audit failure"); },
  }), /simulated audit failure/);
  assert.deepStrictEqual(runtimeHashes(options.runtimeDirectory), before);
  const directory = fs.readdirSync(path.join(options.runtimeDirectory, "maintenance-backups"))[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(options.runtimeDirectory, "maintenance-backups", directory, "manifest.json")));
  assert.equal(manifest.status, "rolled_back");
});

test("a later writer is never rolled back when recovery fails", (t) => {
  const { options, write } = workspace(t);
  let later;
  assert.throws(() => run({ ...options, execute: true, confirm: run(options).previewHash }, {
    afterFamilyWrite: () => {
      const file = path.join(options.runtimeDirectory, "question-families.json");
      later = JSON.parse(fs.readFileSync(file));
      later.membershipRevisionByQuestion.q3 += 1;
      write(file, later);
      throw new Error("concurrent writer");
    },
  }), /concurrent writer/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(options.runtimeDirectory, "question-families.json"))), later);
});

test("command arguments require explicit target paths and reject unknown or missing values", () => {
  assert.deepStrictEqual(parseArguments(["--plan", "plan.json", "--runtime", "runtime", "--execute", "--confirm", "digest"]),
    { planPath: "plan.json", runtimeDirectory: "runtime", execute: true, confirm: "digest" });
  assert.throws(() => parseArguments(["--plan"]));
  assert.throws(() => parseArguments(["--all"]));
});
