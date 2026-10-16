const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./helpers/admin-auth");
const { workspaceFixture } = require("./helpers/question-workspace-fixture");
const { fixture, question } = require("./helpers/library-completion-fixture");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { matchesWorkspaceStatus, workspaceFamilySets } = require("../apps/api/src/question-workspace-filter");

test("workspace status derives review and membership independently", () => {
  const q = { status: "official", answerReviewStatus: "verified" };
  assert.equal(matchesWorkspaceStatus(q, "unarchived", []), true);
  assert.equal(matchesWorkspaceStatus(q, "unarchived", [{ familyStatus: "pending_review", reviewStatus: "pending_fit" }]), false);
  assert.equal(matchesWorkspaceStatus(q, "checked", [{ familyStatus: "confirmed", reviewStatus: "pending_fit" }]), false);
  assert.equal(matchesWorkspaceStatus(q, "pending", [{ familyStatus: "confirmed", reviewStatus: "pending_fit" }]), true);
  assert.equal(matchesWorkspaceStatus(q, "checked", [{ familyStatus: "confirmed", reviewStatus: "confirmed" }]), true);
  assert.equal(matchesWorkspaceStatus({ ...q, status: "offline" }, "unarchived", []), false);
});

test("workspace keeps matching family-set ancestors without empty unrelated containers", () => {
  const sets = [{ id: "root", items: [{ type: "set", id: "child" }] }, { id: "child", parentSetId: "root", items: [{ type: "family", id: "match" }] }, { id: "unrelated", items: [] }];
  assert.deepEqual(workspaceFamilySets(sets, [{ id: "match" }], true).map(s => s.id), ["root", "child"]);
  assert.deepEqual(workspaceFamilySets(sets, [], true), []);
  assert.deepEqual(workspaceFamilySets(sets, [], false), sets);
});

test("workspace reuses missing structures per textbook and never reads a bookless structure", async () => {
  const missingBookId = "modern-literature-30-years-3";
  const legacyBookId = "legacy-book-not-in-current-catalog";
  const questions = Array.from({ length: 30 }, (_, i) => question(`missing-tree-${i}`, { bookId: missingBookId }))
    .concat(Array.from({ length: 30 }, (_, i) => question(`bookless-${i}`, { bookId: "" })))
    .concat(Array.from({ length: 30 }, (_, i) => question(`legacy-book-${i}`, { bookId: legacyBookId })));
  const f = fixture({ questions });
  const structureState = f.knowledgeStructureStore.exportState();
  structureState.records.push({ ...structuredClone(structureState.records[0]), bookId: legacyBookId });
  f.knowledgeStructureStore.replaceState(structureState);
  const reads = new Map();
  const getStructure = f.knowledgeStructureStore.get.bind(f.knowledgeStructureStore);
  f.knowledgeStructureStore.get = bookId => {
    reads.set(bookId, (reads.get(bookId) || 0) + 1);
    return getStructure(bookId);
  };
  const server = createServer({ ...f.stores, aiConfigStore: createMemoryAiConfigStore(), operationLogStore: createMemoryAdminOperationStore() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const before = JSON.stringify([f.questionStore.exportState(), f.knowledgeStructureStore.exportState()]);
  try {
    for (const route of ["question-families", "questions"]) {
      reads.clear();
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/${route}?bookId=all&workspaceStatus=all`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      const items = payload.ungroupedQuestions || payload.questions;
      assert.equal(items.length, questions.length);
      assert.ok(items.every(q => q.knowledgeFingerprint === null && q.candidateKnowledgeFingerprint === null));
      assert.equal(reads.get("") || 0, 0, `${route}: no textbook means no structure lookup`);
      assert.ok(reads.get(missingBookId) > 0 && reads.get(missingBookId) <= 3, `${route}: missing trees must not be read per question`);
      assert.equal(reads.get(legacyBookId), 1, `${route}: legacy textbook structures remain available and are read once`);
    }
    assert.equal(JSON.stringify([f.questionStore.exportState(), f.knowledgeStructureStore.exportState()]), before);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("workspace API applies shared intersections without changing formal content", async t => {
  const f = workspaceFixture();
  const snapshot = () => JSON.stringify([f.questionStore.exportState(), f.questionFamilyStore.exportState(), f.knowledgeStructureStore.exportState()]);
  const server = createServer({ ...f.stores, aiConfigStore: createMemoryAiConfigStore(), operationLogStore: createMemoryAdminOperationStore() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const before = snapshot();
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route, filters = {}) => {
    const response = await fetch(`${base}/api/admin/${route}?${new URLSearchParams({ bookId: "all", workspaceStatus: "all", ...filters })}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const ids = result => result.questions.map(q => q.id).sort();
  const familyIds = result => [...result.families.flatMap(family => family.workspaceMemberIds), ...result.ungroupedQuestions.map(q => q.id)].sort();
  try {
    await t.test("all books includes another subject and bookless questions", async () => {
      const questions = await get("questions");
      const families = await get("question-families");
      assert.ok(ids(questions).includes("other-book"));
      assert.ok(ids(questions).includes("unassigned"));
      assert.deepEqual([...new Set(familyIds(families))].sort(), ids(questions));
      assert.ok(families.families.find(family => family.id === "other-book-family").coreKnowledgeNode);
    });
    for (const filters of [
      { workspaceStatus: "checked" }, { workspaceStatus: "pending" }, { workspaceStatus: "unarchived" },
      { subjectId: "modern-chinese", workspaceStatus: "checked" },
      { subjectId: "modern-chinese", bookId: f.bookId, workspaceStatus: "checked", type: "single_choice", importBatchId: "completion-test" },
      { subjectId: "classical-chinese", bookId: f.bookId },
      { type: "short_answer", importBatchId: "completion-test", workspaceStatus: "checked" },
      { type: "single_choice", importBatchId: "batch-2" },
    ]) await t.test(`same question and family results: ${JSON.stringify(filters)}`, async () => {
      const questions = await get("questions", filters);
      const families = await get("question-families", filters);
      assert.deepEqual([...new Set(familyIds(families))].sort(), ids(questions));
    });
    await t.test("pending members remain visible under confirmed family", async () => {
      const result = await get("question-families", { workspaceStatus: "pending" });
      const mixed = result.families.find(family => family.id === "mixed");
      assert.equal(mixed.status, "confirmed");
      assert.deepEqual(mixed.workspaceMemberIds.sort(), ["pending-answer", "pending-member"]);
      assert.equal(mixed.members.length, 5, "editing still receives all members");
      assert.ok(result.families.some(family => family.id === "pending-definition-family"));
      assert.ok(result.families.some(family => family.id === "empty-pending"));
      assert.ok(!result.families.some(family => family.id === "empty-checked"));
    });
    await t.test("unarchived excludes pending relationships and includes unspecified textbooks", async () => {
      const result = await get("question-families", { workspaceStatus: "unarchived" });
      assert.deepEqual(result.families, []);
      assert.deepEqual(result.ungroupedQuestions.map(q => q.id).sort(), ["unarchived", "unassigned"]);
    });
    await t.test("type and batch never match empty families", async () => {
      const result = await get("question-families", { type: "single_choice", importBatchId: "batch-2" });
      assert.deepEqual(result.families.map(f => f.id), ["mixed"]);
      assert.deepEqual(result.families[0].workspaceMemberIds, ["other-batch"]);
      assert.equal(result.families[0].members.length, 5);
    });
    await t.test("subject summary excludes families from other subjects", async () => {
      const result = await get("question-families", { subjectId: "classical-chinese" });
      assert.equal(result.summary.total, 1);
      assert.equal(result.summary.activeQuestionCount, 1);
      assert.equal(result.summary.pendingMemberCount, 0);
    });
    await t.test("search cannot match a question excluded by batch", async () => {
      const result = await get("question-families", { query: "other-batch", importBatchId: "completion-test" });
      assert.deepEqual(result.families, []);
    });
    assert.equal(snapshot(), before, "filtering must not mutate any store");
  } finally { await new Promise(resolve => server.close(resolve)); }
});
