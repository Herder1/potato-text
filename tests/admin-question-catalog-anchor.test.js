const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { fixture, question, bookId } = require("./helpers/library-completion-fixture");

const anchorPath = "第一章 绪论 > 第一节 现代汉语 > 一、现代汉语的含义";
async function setup(t) {
  const f = fixture({
    questions: [question("anchor-question"), question("untouched")],
    fingerprints: [{ questionId: "anchor-question", status: "confirmed", primaryNodeId: "merged-meaning", requiredNodeIds: ["merged-meaning"] }],
    families: [{ id: "anchor-family", name: "已确认题族", bookId, status: "confirmed", knowledgeNodeId: "merged-meaning", members: [
      { questionId: "anchor-question", role: "prototype", reviewStatus: "confirmed", reviewedAt: 100, reviewedBy: "原审核员", isPrimary: true },
      { questionId: "untouched", role: "similar", reviewStatus: "confirmed", reviewedAt: 100, reviewedBy: "原审核员", isPrimary: true },
    ] }],
  });
  const server = createServer({ ...f.stores, aiConfigStore: createMemoryAiConfigStore(), operationLogStore: createMemoryAdminOperationStore() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (body, endpoint = "/api/admin/questions/anchor-question", method = "PUT") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = () => JSON.stringify([f.questionStore.exportState(), f.knowledgeStructureStore.exportState(), f.questionFamilyStore.exportState()]);
  return { ...f, request, snapshot };
}

test("details expose a textbook catalog anchor while retaining the original chapter field", () => {
  const html = fs.readFileSync(path.join(__dirname, "../apps/admin/index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  assert.match(html, /<span id="question-catalog-anchor-label">教材目录位置<\/span>\s*<select id="question-catalog-anchor"/);
  assert.match(html, /<input id="question-chapter" type="hidden"/);
  assert.match(app, /enrichmentCatalogNodes\(questionCatalogAnchorTextbooks\.find/);
  assert.match(app, /未匹配已确认教材目录/);
  assert.match(app, /select\.value = current/);
  assert.match(app, /expectedQuestionVersion: original\.version/);
});

test("changing only the anchor uses the textbook source node and preserves all existing knowledge and family facts", async t => {
  const f = await setup(t);
  assert.equal(f.knowledgeStructureStore.get(bookId).nodes.some(node => node.id === "meaning"), false);
  const beforeQuestion = f.questionStore.get("anchor-question");
  const beforeKnowledge = f.knowledgeStructureStore.exportState();
  const beforeFamilies = f.questionFamilyStore.exportState();
  const untouched = f.questionStore.get("untouched");
  const result = await f.request({ chapter: anchorPath, textbookCatalogNodeId: "meaning", expectedQuestionVersion: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.question.chapter, anchorPath);
  assert.equal(result.body.question.version, 2);
  assert.deepEqual(result.body.affectedFamilyIds, []);
  const after = f.questionStore.get("anchor-question");
  for (const key of Object.keys(beforeQuestion)) {
    if (["chapter", "version", "versions", "updatedAt", "updatedBy"].includes(key)) continue;
    assert.deepEqual(after[key], beforeQuestion[key], key);
  }
  assert.equal(Object.hasOwn(after, "textbookCatalogNodeId"), false);
  assert.equal(Object.hasOwn(after, "expectedQuestionVersion"), false);
  assert.deepEqual(f.knowledgeStructureStore.exportState(), beforeKnowledge);
  assert.deepEqual(f.questionFamilyStore.exportState(), beforeFamilies);
  assert.deepEqual(f.questionStore.get("untouched"), untouched);
});

for (const [name, payload, status, error] of [
  ["edited knowledge-tree nodes are not textbook directory nodes", { chapter: anchorPath, textbookCatalogNodeId: "merged-meaning", expectedQuestionVersion: 1 }, 422, "question_catalog_anchor_invalid"],
  ["foreign-book directory selections are rejected", { bookId: "modern-chinese-7-2", chapter: anchorPath, textbookCatalogNodeId: "meaning", expectedQuestionVersion: 1 }, 422, "question_catalog_anchor_invalid"],
  ["stale question versions cannot overwrite newer content", { chapter: anchorPath, textbookCatalogNodeId: "meaning", expectedQuestionVersion: 2 }, 409, "question_version_conflict"],
  ["changed catalog paths require reloading", { chapter: "过期目录路径", textbookCatalogNodeId: "meaning", expectedQuestionVersion: 1 }, 409, "question_catalog_anchor_changed"],
  ["nonempty paths cannot bypass the selected node check", { chapter: anchorPath, textbookCatalogNodeId: "", expectedQuestionVersion: 1 }, 422, "question_catalog_anchor_invalid"],
  ["a node cannot be saved without a textbook", { bookId: "", chapter: anchorPath, textbookCatalogNodeId: "meaning", expectedQuestionVersion: 1 }, 422, "question_catalog_anchor_invalid"],
]) {
  test(name, async t => {
    const f = await setup(t);
    const before = f.snapshot();
    const result = await f.request(payload);
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.error, error);
    assert.equal(f.snapshot(), before);
  });
}

test("clearing only the anchor does not clear knowledge points or confirmed membership", async t => {
  const f = await setup(t);
  const before = f.questionStore.get("anchor-question");
  const families = f.questionFamilyStore.exportState();
  const knowledge = f.knowledgeStructureStore.exportState();
  const result = await f.request({ chapter: "", textbookCatalogNodeId: "", expectedQuestionVersion: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.question.chapter, "");
  assert.deepEqual(result.body.question.knowledgePoints, before.knowledgePoints);
  assert.deepEqual(f.questionFamilyStore.exportState(), families);
  assert.deepEqual(f.knowledgeStructureStore.exportState(), knowledge);
});

test("draft-only catalog nodes cannot be selected as confirmed anchors", async t => {
  const f = await setup(t);
  f.textbookCatalogStore.setDraft(bookId, [{ id: "draft-only", level: 1, title: "未确认章节", startPage: 1, endPage: 2 }], {}, "测试员");
  const before = f.snapshot();
  const result = await f.request({ chapter: "未确认章节", textbookCatalogNodeId: "draft-only", expectedQuestionVersion: 1 });
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(f.snapshot(), before);
});

test("legacy directory values remain valid when no new anchor is selected", async t => {
  const f = await setup(t);
  const original = f.questionStore.get("anchor-question");
  const result = await f.request({ chapter: original.chapter, expectedQuestionVersion: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.question.chapter, original.chapter);
});

test("new questions can use a confirmed textbook anchor without creating fingerprints or memberships", async t => {
  const f = await setup(t);
  const source = question("new");
  delete source.id;
  const knowledge = f.knowledgeStructureStore.exportState();
  const families = f.questionFamilyStore.exportState();
  const result = await f.request({ ...source, chapter: anchorPath, textbookCatalogNodeId: "meaning" }, "/api/admin/questions", "POST");
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.question.chapter, anchorPath);
  assert.deepEqual(f.knowledgeStructureStore.exportState(), knowledge);
  assert.deepEqual(f.questionFamilyStore.exportState(), families);
});
