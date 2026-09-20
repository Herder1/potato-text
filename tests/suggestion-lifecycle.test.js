const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SUGGESTION_SOURCES,
  SUGGESTION_SOURCE_VALUES,
  SUGGESTION_REVIEW_STATUSES,
  normalizeSuggestionSource,
  normalizeSuggestionReviewStatus,
} = require("../apps/api/src/suggestion-lifecycle");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");

// 《链路职责矩阵》第 1 批 · 第 1/2 项：
//   第 1 项 建议层补"来源标识" —— 题目完善与 AI 巡检的建议都能区分来源；
//   第 2 项 AI 巡检接入与题目完善同一套状态机（recommended → applied / rejected，含 appliedFields/appliedVersion）。
// 这两条解决的是同一个问题：两条产线的"建议"形状不一致，没法用统一入口分流、筛选与追溯。
// 边界（B3）：算法不合并、流程统一 —— 只统一词汇，不碰各自提示词/模型/调度。

test("suggestion lifecycle: 两条产线共用同一套来源标识与裁决词汇", () => {
  assert.deepEqual(SUGGESTION_SOURCE_VALUES, ["question_enrichment", "knowledge_inspection"]);
  assert.deepEqual(SUGGESTION_REVIEW_STATUSES, ["recommended", "applied", "rejected"]);
  assert.equal(SUGGESTION_SOURCES.QUESTION_ENRICHMENT, "question_enrichment");
  assert.equal(SUGGESTION_SOURCES.KNOWLEDGE_INSPECTION, "knowledge_inspection");
});

test("suggestion lifecycle: 来源标识只接受已知取值，未知值退回本条产线的自身来源", () => {
  assert.equal(normalizeSuggestionSource("knowledge_inspection", "question_enrichment"), "knowledge_inspection");
  assert.equal(normalizeSuggestionSource("", "question_enrichment"), "question_enrichment");
  assert.equal(normalizeSuggestionSource("随便写的", "question_enrichment"), "question_enrichment");
  assert.equal(normalizeSuggestionSource("", ""), "");
  // 不得被伪造：不属于两条产线的值一律不采信
  assert.equal(normalizeSuggestionSource("manual", "knowledge_inspection"), "knowledge_inspection");
});

test("suggestion lifecycle: 巡检历史上的 reviewStatus=pending 归一为 recommended", () => {
  assert.equal(normalizeSuggestionReviewStatus("pending"), "recommended");
  assert.equal(normalizeSuggestionReviewStatus("recommended"), "recommended");
  assert.equal(normalizeSuggestionReviewStatus("applied"), "applied");
  assert.equal(normalizeSuggestionReviewStatus("rejected"), "rejected");
  // 未知/缺失都落到"待人工处理"，不能落到"已采纳"
  assert.equal(normalizeSuggestionReviewStatus(""), "recommended");
  assert.equal(normalizeSuggestionReviewStatus("whatever"), "recommended");
});

test("suggestion lifecycle: 题目完善建议带来源标识，且不覆盖显式传入的合法值", () => {
  const store = createMemoryQuestionEnrichmentStore();
  const created = store.addSuggestion({
    id: "enrichment-1",
    questionId: "q1",
    questionVersion: 3,
    chapterNodeId: "node-1",
    catalogPath: "第一章 > 第一节",
    knowledgePoints: ["现代汉语共同语"],
  });
  assert.equal(created.source, "question_enrichment");

  const explicit = store.addSuggestion({
    id: "enrichment-2",
    questionId: "q2",
    questionVersion: 1,
    source: "knowledge_inspection",
  });
  assert.equal(explicit.source, "knowledge_inspection");

  const forged = store.addSuggestion({
    id: "enrichment-3",
    questionId: "q3",
    questionVersion: 1,
    source: "自己编的",
  });
  assert.equal(forged.source, "question_enrichment");
});

test("suggestion lifecycle: 巡检结果带来源标识，历史 pending 记录读出来就是 recommended", () => {
  const store = createMemoryKnowledgeClassificationStore();
  store.replaceState({
    jobs: [],
    results: [
      { id: "result-legacy", questionId: "q1", status: "pending_review", agent2Status: "completed", reviewStatus: "pending" },
      { id: "result-forged", questionId: "q2", status: "pending_review", agent2Status: "completed", source: "manual" },
    ],
  });
  const [legacy, forged] = store.results();
  // 历史上"待人工处理"写成 pending，读取时归一
  assert.equal(legacy.reviewStatus, "recommended");
  assert.equal(legacy.status, "pending_review", "管线的 status 词汇不受影响");
  assert.equal(legacy.source, "knowledge_inspection");
  assert.deepEqual(legacy.appliedFields, []);
  assert.equal(legacy.appliedVersion, 0);
  assert.equal(forged.source, "knowledge_inspection", "伪造来源不采信");
});

test("suggestion lifecycle: 巡检采纳记录 appliedFields 与 appliedVersion（与题目完善同一套）", () => {
  const store = createMemoryKnowledgeClassificationStore();
  store.replaceState({
    jobs: [],
    results: [{
      id: "result-1",
      questionId: "q1",
      bookId: "modern-chinese-7-1",
      status: "pending_review",
      agent2Status: "completed",
    }],
  });

  const applied = store.applyResult(
    "result-1",
    "超级管理员",
    "教材证据充分",
    { primaryNodeId: "method", requiredNodeIds: ["method"] },
    ["primaryNodeId", "primaryNodeRole", "requiredNodeIds"],
    4,
  );
  assert.equal(applied.reviewStatus, "applied");
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.appliedFields, ["primaryNodeId", "primaryNodeRole", "requiredNodeIds"]);
  assert.equal(applied.appliedVersion, 4);
  // 重新读一遍也要保留（留痕必须落盘，不能只活在返回值里）
  const reread = store.getResult("result-1");
  assert.deepEqual(reread.appliedFields, ["primaryNodeId", "primaryNodeRole", "requiredNodeIds"]);
  assert.equal(reread.appliedVersion, 4);
});

test("suggestion lifecycle: 巡检驳回不留下任何采纳留痕", () => {
  const store = createMemoryKnowledgeClassificationStore();
  store.replaceState({
    jobs: [],
    results: [{
      id: "result-2",
      questionId: "q2",
      bookId: "modern-chinese-7-1",
      status: "pending_review",
      agent2Status: "completed",
      reviewStatus: "pending",
      appliedFields: ["primaryNodeId"],
      appliedVersion: 9,
    }],
  });

  const rejected = store.rejectResult("result-2", "超级管理员", "教材证据不足");
  assert.equal(rejected.reviewStatus, "rejected");
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(rejected.appliedFields, [], "驳回后不得残留上一次的采纳留痕");
  assert.equal(rejected.appliedVersion, 0);
});
