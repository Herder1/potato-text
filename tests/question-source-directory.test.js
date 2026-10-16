const test = require("node:test");
const assert = require("node:assert/strict");
const { questionSourceDirectory, sourcePathKey } = require("../apps/api/src/question-source-directory");
const { fixture, question, bookId } = require("./helpers/library-completion-fixture");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");

test("source path only normalizes presentation, retaining qualifiers and complete hierarchy", () => {
  assert.equal(sourcePathKey("第一章 绪论·第一节 现代汉语·一、现代汉语的含义"), sourcePathKey("绪论 > 现代汉语 > 现代汉语的含义"));
  assert.equal(sourcePathKey("第四章 语法 > 第二节 词类（上）"), sourcePathKey("语法 > 词类(上)"));
  assert.notEqual(sourcePathKey("语法 > 词类(上)"), sourcePathKey("语法 > 词类(下)"));
  assert.notEqual(sourcePathKey("语法 > 词类(上) > 实词"), sourcePathKey("语法 > 词类(上)"));
});

test("source counts roll up stable IDs, include missing fingerprints, and reject ambiguous paths", () => {
  const directory = { bookId, dossierNodes: [
    { id: "root", path: "语法" }, { id: "upper", parentId: "root", path: "语法 > 词类(上)" },
    { id: "lower", parentId: "root", path: "语法 > 词类(下)" },
    { id: "duplicate-a", parentId: "root", path: "语法 > 同名" }, { id: "duplicate-b", parentId: "root", path: "语法 > 同名" },
  ] };
  const questions = [question("upper", { chapter: "语法 > 词类（上）" }), question("lower", { chapter: "语法 > 词类(下)" }),
    question("deep-missing", { chapter: "语法 > 词类(上) > 实词" }), question("ambiguous", { chapter: "语法 > 同名" }),
    question("empty", { chapter: "" }), question("fuzzy", { chapter: "语法 > 词类" })];
  const result = questionSourceDirectory(questions, directory, "root");
  assert.deepEqual(result.questions.map(q => q.id), ["upper", "lower"]);
  assert.equal(result.treeSummary.questionCount, 6);
  assert.equal(result.treeSummary.nodeQuestionCounts.root, 2);
  assert.equal(result.treeSummary.unlocatedQuestionCount, 4);
  assert.equal(questionSourceDirectory(questions, directory, "__unlocated__").questions.length, 4);
  assert.deepEqual(questionSourceDirectory(questions, directory, "invalid").questions, []);
  assert.equal(questionSourceDirectory([...questions, questions[0]], directory).treeSummary.nodeQuestionCounts.root, 2);
  assert.equal(questionSourceDirectory(questions, { bookId, dossierNodes: [] }).treeSummary.unlocatedQuestionCount, 6);
});

test("source-directory API shares source nodes, filters and counts without changing formal facts", async t => {
  const checked = { answerReviewStatus: "verified" };
  const chapter = "第一章 绪论 > 第一节 现代汉语 > 一、现代汉语的含义";
  const f = fixture({ questions: [
    question("source-only", { ...checked, chapter }),
    question("pending", { chapter, answerSource: "pdf_answer", answerReviewStatus: "unreviewed", status: "pending_review" }),
    question("standard", { ...checked, chapter: "绪论 > 现代汉语 > 普通话的标准" }),
    question("unlocated", { ...checked, chapter: "已删除的旧目录" }),
    question("short", { ...checked, chapter, type: "short_answer", importBatchId: "batch-2" }),
    question("bookless", { ...checked, bookId: "", chapter: "", knowledgePoints: [] }),
  ], families: [{ id: "confirmed", bookId, name: "已确认", status: "confirmed", knowledgeNodeId: "merged-meaning",
    members: [{ questionId: "standard", isPrimary: true, reviewStatus: "confirmed" }] }],
  fingerprints: [{ questionId: "source-only", status: "confirmed", primaryNodeId: "standard", requiredNodeIds: ["standard"] }] });
  const snapshot = () => JSON.stringify(Object.values(f.stores).map(store => store.exportState()));
  const server = createServer({ ...f.stores, aiConfigStore: createMemoryAiConfigStore(), operationLogStore: createMemoryAdminOperationStore() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const before = snapshot();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = async filters => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/questions?${new URLSearchParams({ bookId, directory: "source", ...filters })}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const ids = result => result.questions.map(q => q.id).sort();
  const all = await get({});
  assert.equal(all.treeSummary.questionCount, 5);
  assert.equal(all.treeSummary.locatedQuestionCount, 4);
  assert.equal(all.treeSummary.unlocatedQuestionCount, 1);
  const source = await get({ sourceNodeId: "meaning", knowledgeNodeId: "standard" });
  assert.deepEqual(ids(source), ["pending", "short", "source-only"]);
  assert.equal(source.questions.length, source.treeSummary.nodeQuestionCounts.meaning);
  assert.equal((await get({ sourceNodeId: "chapter" })).questions.length, 4);
  assert.deepEqual(ids(await get({ sourceNodeId: "__unlocated__" })), ["unlocated"]);
  assert.deepEqual(ids(await get({ sourceNodeId: "merged-meaning" })), []);
  assert.deepEqual(ids(await get({ sourceNodeId: "meaning", workspaceStatus: "pending" })), ["pending"]);
  for (const filters of [
    { workspaceStatus: "checked" }, { workspaceStatus: "unarchived" },
    { subjectId: "modern-chinese", workspaceStatus: "checked", type: "single_choice", importBatchId: "completion-test" },
    { type: "short_answer", importBatchId: "batch-2" }, { subjectId: "classical-chinese" }, { query: "source-only" },
  ]) {
    const result = await get({ ...filters, sourceNodeId: "meaning" });
    assert.equal(result.questions.length, result.treeSummary.nodeQuestionCounts.meaning, JSON.stringify(filters));
    const whole = await get(filters);
    assert.equal(whole.questions.length, result.treeSummary.questionCount);
  }
  const everyBook = await get({ bookId: "all" });
  assert.equal(everyBook.questions.length, 6);
  assert.equal(everyBook.treeSummary, null);
  const legacy = await get({ directory: "", knowledgeNodeId: "standard" });
  assert.ok(ids(legacy).includes("source-only"), "legacy knowledge-node filtering remains supported");
  assert.equal(snapshot(), before, "reads do not change chapters, fingerprints, mappings, versions or memberships");
});
