const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");
const {
  createFileQuestionEnrichmentStore,
  createMemoryQuestionEnrichmentStore,
  questionEnrichmentNeeds,
} = require("../apps/api/src/question-enrichment-store");

const pendingQuestion = {
  id: "pending-enrichment-question",
  subjectId: "modern-chinese",
  bookId: "modern-chinese-7-1",
  chapter: "待归类",
  knowledgePoints: ["待归类"],
  type: "short_answer",
  stem: "普通话的定义是什么？",
  referenceAnswer: "普通话是现代汉民族共同语。",
  maxScore: 4,
  scoringPoints: [],
};

test("question enrichment needs distinguish catalog, knowledge and scoring gaps", () => {
  assert.deepEqual(questionEnrichmentNeeds({
    ...pendingQuestion,
    scoringPointStatus: "needs_split",
  }), {
    needs: ["chapter", "knowledge_points", "scoring_points"],
    needsChapter: true,
    needsKnowledgePoints: true,
    needsScoringPoints: true,
    complete: false,
  });
  assert.equal(questionEnrichmentNeeds({
    ...pendingQuestion,
    chapter: "第一章 绪论",
    knowledgePoints: ["现代汉语共同语"],
    scoringPointStatus: "complete",
  }).complete, true);
});

test("question enrichment suggestions and jobs persist and interrupted jobs recover", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-enrichment-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "enrichment.json");
  const store = createFileQuestionEnrichmentStore(filePath);
  const job = store.createJob(["q-1", "q-2"]);
  store.updateJob(job.id, { status: "running", completed: 1, succeeded: 1 });
  store.addSuggestion({
    questionId: "q-1",
    questionVersion: 2,
    chapterNodeId: "node-1",
    catalogPath: "第一章",
    knowledgePoints: ["知识点"],
    confidence: 0.91,
  });

  const reloaded = createFileQuestionEnrichmentStore(filePath);
  assert.equal(reloaded.latest("q-1").confidence, 0.91);
  assert.equal(reloaded.getJob(job.id).status, "interrupted");
  assert.equal(reloaded.getJob(job.id).error, "server_interrupted");
});

test("admin enrichment list, field-level apply and revert preserve official answers", async (context) => {
  const questionStore = createMemoryQuestionStore([]);
  const question = questionStore.create(pendingQuestion, "测试编辑");
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft(question.bookId, [{
    id: "catalog-modern-definition",
    level: 1,
    title: "第一章 绪论",
    startPage: 1,
    endPage: 12,
    knowledgePoints: ["现代汉语共同语"],
  }], { source: "test" }, "测试编辑");
  const textbook = textbookCatalogStore.confirm(question.bookId, "测试编辑");
  const node = textbook.confirmed.nodes[0];
  const questionEnrichmentStore = createMemoryQuestionEnrichmentStore();
  const suggestion = questionEnrichmentStore.addSuggestion({
    questionId: question.id,
    questionVersion: question.version,
    chapterNodeId: node.id,
    catalogPath: "第一章 绪论",
    knowledgePoints: ["现代汉语共同语"],
    scoringPoints: [{
      description: "指出普通话的性质",
      score: 4,
      textbookPage: "1-2",
      pageBasis: "confirmed_catalog",
      sourceNote: "现代汉语 · 第一章 绪论",
    }],
    confidence: 0.94,
  });
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    textbookCatalogStore,
    questionEnrichmentStore,
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/question-enrichment?bookId=${question.bookId}`).then((response) => response.json());
  assert.equal(listing.summary.chapter, 1);
  assert.equal(listing.summary.scoringPoints, 1);
  assert.equal(listing.items[0].suggestion.id, suggestion.id);

  const appliedResponse = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestionId: suggestion.id }),
  });
  const applied = await appliedResponse.json();
  assert.equal(appliedResponse.status, 200);
  assert.equal(applied.question.chapter, "第一章 绪论");
  assert.deepEqual(applied.question.knowledgePoints, ["现代汉语共同语"]);
  assert.equal(applied.question.scoringPointStatus, "complete");
  assert.equal(applied.question.referenceAnswer, pendingQuestion.referenceAnswer);
  assert.equal(applied.question.version, 2);

  const revertedResponse = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/revert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestionId: suggestion.id }),
  });
  const reverted = await revertedResponse.json();
  assert.equal(revertedResponse.status, 200);
  assert.equal(reverted.question.chapter, "待归类");
  assert.deepEqual(reverted.question.knowledgePoints, ["待归类"]);
  assert.deepEqual(reverted.question.scoringPoints, []);
  assert.equal(reverted.question.referenceAnswer, pendingQuestion.referenceAnswer);
  assert.equal(reverted.question.version, 3);
  assert.equal(operationLogStore.list({ category: "question" }).items.length, 2);
});
