const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, question, bookId } = require("./helpers/library-completion-fixture");
const { createQuestionCompletion } = require("../apps/api/src/question-completion");
const { dossierNodeIds, questionNodeIds } = require("../apps/api/src/library-directories");
const item = (row, fingerprint = Boolean(row.fingerprint), familyId = row.family?.candidates[0]?.id || (row.family?.draft ? "new" : "")) => ({ questionId: row.questionId, token: row.token, fingerprint, familyId });
const snapshot = (f) => ({ questions: f.questionStore.list({ status: "all" }), structure: f.knowledgeStructureStore.exportState(), families: f.questionFamilyStore.exportState() });

test("directory reads preserve source tree and use identity links only where IDs actually match", () => {
  const f = fixture({ mapped: false });
  const before = snapshot(f);
  const d = f.directories.read(bookId);
  assert.deepEqual(d.dossierNodes.map((n) => [n.id, n.title, n.parentId]), f.source.nodes.map((n) => [n.id, n.title, n.parentId]));
  assert.equal(d.questionNodes.some((n) => n.id === "merged-meaning"), true);
  assert.equal(d.dossierNodes.some((n) => n.id === "merged-meaning"), false);
  assert.deepEqual(d.mappings.find((m) => m.questionNodeId === "standard").dossierNodeIds, ["standard"]);
  assert.deepEqual(d.mappings.find((m) => m.questionNodeId === "merged-meaning").dossierNodeIds, []);
  assert.deepEqual(snapshot(f), before);
});

test("many-to-many mappings and explicit unlink preserve all existing domain records", () => {
  const f = fixture();
  const before = snapshot(f);
  let d = f.directories.read(bookId);
  d = f.directories.save(bookId, "merged-meaning", ["meaning", "standard"], d.revision);
  d = f.directories.save(bookId, "standard", ["meaning"], d.revision);
  assert.deepEqual(questionNodeIds(d, "meaning").sort(), ["merged-meaning", "standard"]);
  assert.deepEqual(dossierNodeIds(d, "merged-meaning").sort(), ["meaning", "standard"]);
  d = f.directories.save(bookId, "standard", [], d.revision);
  assert.deepEqual(d.mappings.find((m) => m.questionNodeId === "standard").dossierNodeIds, []);
  assert.deepEqual(f.knowledgeStructureStore.exportState().records, before.structure.records);
  assert.deepEqual(snapshot(f).questions, before.questions);
  assert.deepEqual(snapshot(f).families, before.families);
});

test("mapping rejects stale revisions, missing source nodes and invalid working nodes", () => {
  const f = fixture();
  const d = f.directories.read(bookId);
  assert.throws(() => f.directories.save(bookId, "merged-meaning", ["fake"], d.revision), /target_invalid/);
  assert.throws(() => f.directories.save(bookId, "fake", ["meaning"], d.revision), /node_not_found/);
  f.directories.save(bookId, "merged-meaning", [], d.revision);
  assert.throws(() => f.directories.save(bookId, "merged-meaning", ["meaning"], d.revision), /stale/);
});

test("preview is read-only and single-question candidate can be confirmed after time advances", async () => {
  const f = fixture();
  const before = snapshot(f);
  const [row] = f.completion.preview([f.questions[0]]);
  assert.equal(row.fingerprint.primaryNodeId, "merged-meaning");
  assert.ok(row.family.draft);
  assert.deepEqual(snapshot(f), before);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = f.completion.commit([item(row)], "tester");
  assert.deepEqual(result, { fingerprintsAdded: 1, membershipsAdded: 1, familiesCreated: 1 });
  const [family] = f.questionFamilyStore.list({ bookId, status: "all" }).families;
  assert.equal(family.status, "pending_review");
  assert.equal(family.members[0].reviewStatus, "pending_fit");
  assert.deepEqual(snapshot(f).questions, before.questions);
  assert.deepEqual(f.knowledgeStructureStore.get(bookId).nodes, before.structure.records[0].nodes);
  assert.throws(() => f.completion.commit([item(row)], "tester"), /stale/);
  assert.equal(f.questionFamilyStore.list({ bookId, status: "all" }).families.length, 1);
});

test("existing family is preferred and old definition, membership and fingerprint stay unchanged", () => {
  const f = fixture();
  const [first] = f.completion.preview([f.questions[0]]);
  f.completion.commit([item(first)], "tester");
  const initial = f.questionFamilyStore.exportState();
  initial.families[0].status = "confirmed";
  initial.families[0].reviewedBy = "original reviewer";
  initial.families[0].members[0].reviewStatus = "confirmed";
  f.questionFamilyStore.replaceState(initial);
  const before = snapshot(f);
  const [row] = f.completion.preview([f.questions[1]]);
  assert.equal(row.family.draft, null);
  assert.equal(row.family.candidates.length, 1);
  const result = f.completion.commit([item(row)], "tester");
  assert.equal(result.familiesCreated, 0);
  const after = f.questionFamilyStore.exportState().families[0];
  const old = before.families.families[0];
  for (const [key, value] of Object.entries(old)) {
    if (!["members", "updatedAt"].includes(key)) assert.deepEqual(after[key], value, key);
  }
  assert.deepEqual(after.members[0], old.members[0]);
  assert.equal(after.members[1].reviewStatus, "pending_fit");
  assert.deepEqual(f.knowledgeStructureStore.get(bookId).fingerprints[0], before.structure.records[0].fingerprints[0]);
});

test("multiple selected singleton candidates share one newly created family", () => {
  const f = fixture();
  const rows = f.completion.preview(f.questions);
  assert.deepEqual(f.completion.commit(rows.map((r) => item(r)), "tester"), { fingerprintsAdded: 2, membershipsAdded: 2, familiesCreated: 1 });
});

test("existing invalid confirmed fingerprints are never repaired by completion", () => {
  const fp = { primaryNodeId: "retired", requiredNodeIds: ["retired"], status: "confirmed", reviewedBy: "original", revision: 9 };
  const f = fixture({ questions: [question("existing", { knowledgeFingerprint: fp })] });
  const before = snapshot(f);
  const [row] = f.completion.preview(f.questions);
  assert.equal(row.hasFingerprint, true);
  assert.equal(row.fingerprint, null);
  assert.equal(row.family, null);
  assert.match(row.issues.join(" "), /保留原值/);
  assert.throws(() => f.completion.commit([item(row, true, "")], "tester"), /selection_invalid/);
  assert.deepEqual(snapshot(f), before);
});

test("any existing family relationship is preserved while only its missing fingerprint is added", () => {
  const f = fixture({ families: [{ id: "already", bookId, knowledgeNodeId: "standard", name: "人工族", status: "rejected", members: [{ questionId: "missing-1", reviewStatus: "inactive" }] }] });
  const before = f.questionFamilyStore.exportState();
  const [row] = f.completion.preview([f.questions[0]]);
  assert.equal(row.hasFamily, true);
  assert.equal(row.family, null);
  f.completion.commit([item(row, true, "")], "tester");
  assert.deepEqual(f.questionFamilyStore.exportState(), before);
});

test("unmapped and ambiguous source nodes are flagged without generating fallback assignments", () => {
  const f = fixture({ mapped: false });
  assert.equal(f.completion.preview([f.questions[0]])[0].fingerprint, null);
  let d = f.directories.read(bookId);
  d = f.directories.save(bookId, "merged-meaning", ["meaning"], d.revision);
  f.directories.save(bookId, "standard", ["meaning"], d.revision);
  const [row] = f.completion.preview([f.questions[0]]);
  assert.equal(row.fingerprint, null);
  assert.match(row.issues.join(" "), /多个/);
});

test("stale mapping and forged choices cannot write any state", () => {
  const f = fixture();
  const [row] = f.completion.preview([f.questions[0]]);
  assert.throws(() => f.completion.commit([item(row, false, "new")], "tester"), /fingerprint_required/);
  assert.throws(() => f.completion.commit([item(row, true, "fake")], "tester"), /selection_invalid/);
  f.directories.save(bookId, "merged-meaning", [], f.directories.read(bookId).revision);
  const before = snapshot(f);
  assert.throws(() => f.completion.commit([item(row)], "tester"), /stale/);
  assert.deepEqual(snapshot(f), before);
});

test("caught cross-store failure rolls back fingerprints and family creation", () => {
  const f = fixture();
  const completion = createQuestionCompletion({ ...f.stores, directories: f.directories,
    questionFamilyStore: { ...f.questionFamilyStore, addMembers() { throw new Error("injected_failure"); } } });
  const before = snapshot(f);
  const [row] = completion.preview([f.questions[0]]);
  assert.throws(() => completion.commit([item(row)], "tester"), /injected_failure/);
  assert.deepEqual(snapshot(f), before);
});

test("rollback failure blocks all subsequent completion commits", () => {
  const f = fixture();
  const completion = createQuestionCompletion({ ...f.stores, directories: f.directories,
    questionFamilyStore: { ...f.questionFamilyStore, addMembers() { throw new Error("injected_failure"); }, replaceState() { throw new Error("rollback_failure"); } } });
  const [row] = completion.preview([f.questions[0]]);
  assert.throws(() => completion.commit([item(row)], "tester"), /completion_rollback_failed/);
  assert.throws(() => completion.commit([item(row)], "tester"), /completion_rollback_failed/);
});
