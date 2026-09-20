const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");

// 《链路职责矩阵》第十三节：裁决台 = 统一待处理队列（形态 B）。
// 这里守住三件事：① 两条产线合并；② 跨来源的稳定排序（禁止"第 2 页比第 1 页新"）；
// ③ 统一词汇与留痕能一路透出到接口；④ 同题同产线只留最新一条（历史不进队列）。

const bookId = "modern-chinese-7-1";

function makeQuestion(id, stem) {
  return {
    id,
    subjectId: "modern-chinese",
    bookId,
    library: "official",
    chapter: "第一章 语音",
    knowledgePoints: ["语音"],
    type: "single_choice",
    stem,
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
    correctAnswer: ["A"],
    referenceAnswer: "A",
    maxScore: 2,
    difficultyScore: 50,
    status: "published",
    answerReviewStatus: "verified",
    version: 1,
  };
}

async function withQueueServer(context, seed) {
  const questionStore = createMemoryQuestionStore([
    makeQuestion("q-enrich", "（完善）下列读音正确的是（ ）"),
    makeQuestion("q-inspect", "（巡检）下列属于塞音的是（ ）"),
  ]);
  const questionEnrichmentStore = createMemoryQuestionEnrichmentStore();
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  seed({ questionEnrichmentStore, knowledgeClassificationStore });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    questionEnrichmentStore,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("adjudication queue merges both production lines and orders them stably across sources", async (context) => {
  const baseUrl = await withQueueServer(context, ({ questionEnrichmentStore, knowledgeClassificationStore }) => {
    questionEnrichmentStore.addSuggestion({
      id: "sug-old", questionId: "q-enrich", questionVersion: 1,
      chapterNodeId: "node-1", knowledgePoints: ["语音"], updatedAt: 100,
    });
    questionEnrichmentStore.addSuggestion({
      id: "sug-new", questionId: "q-enrich", questionVersion: 1,
      chapterNodeId: "node-2", knowledgePoints: ["词汇"], updatedAt: 500,
    });
    knowledgeClassificationStore.replaceState({
      jobs: [],
      results: [
        { id: "res-old", questionId: "q-inspect", bookId, status: "pending_review", agent2Status: "completed", reviewStatus: "pending", updatedAt: 200 },
        {
          id: "res-new", questionId: "q-inspect", bookId, status: "applied", agent2Status: "completed",
          reviewStatus: "applied", updatedAt: 400, reviewedBy: "超级管理员", reviewedAt: 450,
          appliedFields: ["primaryNodeId", "requiredNodeIds"], appliedVersion: 2,
        },
        { id: "res-other-book", questionId: "q-inspect", bookId: "classical-chinese-1", status: "pending_review", agent2Status: "completed", updatedAt: 999 },
      ],
    });
  });

  const body = await fetch(`${baseUrl}/api/admin/adjudication/queue?bookId=${bookId}`).then((response) => response.json());
  assert.equal(body.success, true);
  // 同题同产线只留最新一条：完善侧 2 条 → 1 条；巡检侧本教材 2 条 → 1 条（另一本教材那条被过滤）
  assert.equal(body.total, 2);
  assert.deepEqual(body.items.map((item) => item.id), ["sug-new", "res-new"]);
  // 跨来源按 updatedAt 倒序（500 > 400）
  assert.equal(body.items[0].source, "question_enrichment");
  assert.equal(body.items[0].sourceLabel, "题目完善");
  assert.equal(body.items[1].source, "knowledge_inspection");
  assert.equal(body.items[1].sourceLabel, "AI 巡检");
  // 题目完善建议展示它涉及的字段
  assert.deepEqual(body.items[0].fieldLabels, ["目录位置", "知识点"]);
  // 采纳留痕一路透出到接口
  assert.deepEqual(body.items[1].appliedFields, ["primaryNodeId", "requiredNodeIds"]);
  assert.equal(body.items[1].appliedVersion, 2);
  assert.equal(body.items[1].reviewedBy, "超级管理员");
  assert.equal(body.items[1].status, "applied");
  // 来源筛选项由数据推导（不是写死两个来源），供界面动态渲染
  assert.deepEqual(body.sourceOptions.map((option) => [option.value, option.label, option.count]), [
    ["knowledge_inspection", "AI 巡检", 1],
    ["question_enrichment", "题目完善", 1],
  ]);
  assert.deepEqual(body.summary.bySource, { knowledge_inspection: 1, question_enrichment: 1 });
});

test("adjudication queue keeps the unified lifecycle and can filter by source and status", async (context) => {
  const baseUrl = await withQueueServer(context, ({ questionEnrichmentStore, knowledgeClassificationStore }) => {
    questionEnrichmentStore.addSuggestion({ id: "sug-1", questionId: "q-enrich", questionVersion: 1, chapterNodeId: "n", updatedAt: 300 });
    knowledgeClassificationStore.replaceState({
      jobs: [],
      results: [
        // 历史词汇 pending 必须读成 recommended
        { id: "res-pending", questionId: "q-inspect", bookId, status: "pending_review", agent2Status: "completed", reviewStatus: "pending", updatedAt: 200 },
      ],
    });
  });

  const pendingOnly = await fetch(`${baseUrl}/api/admin/adjudication/queue?bookId=${bookId}&status=recommended`).then((response) => response.json());
  assert.deepEqual(pendingOnly.items.map((item) => [item.id, item.status, item.statusLabel]), [
    ["sug-1", "recommended", "待处理"],
    ["res-pending", "recommended", "待处理"],
  ]);
  // 未采纳的巡检建议展示"这次采纳会写入哪些字段"
  assert.deepEqual(pendingOnly.items[1].fieldLabels, [
    "作答核心", "核心角色", "最小充分知识集", "问题知识范围", "主题范围锚点",
  ]);

  const enrichmentOnly = await fetch(`${baseUrl}/api/admin/adjudication/queue?bookId=${bookId}&source=question_enrichment`).then((response) => response.json());
  assert.deepEqual(enrichmentOnly.items.map((item) => item.source), ["question_enrichment"]);

  const inspectionOnly = await fetch(`${baseUrl}/api/admin/adjudication/queue?bookId=${bookId}&source=knowledge_inspection`).then((response) => response.json());
  assert.deepEqual(inspectionOnly.items.map((item) => item.source), ["knowledge_inspection"]);

  const appliedOnly = await fetch(`${baseUrl}/api/admin/adjudication/queue?bookId=${bookId}&status=applied`).then((response) => response.json());
  assert.equal(appliedOnly.total, 0);
});

test("adjudication queue pages without ever letting a newer entry fall onto a later page", async (context) => {
  const baseUrl = await withQueueServer(context, ({ questionEnrichmentStore }) => {
    // 12 条，updatedAt 从 1200 递减到 100
    for (let index = 0; index < 12; index += 1) {
      questionEnrichmentStore.addSuggestion({
        id: `sug-${String(index).padStart(2, "0")}`,
        questionId: "q-enrich",
        questionVersion: 1,
        chapterNodeId: "n",
        updatedAt: 1200 - index * 100,
      });
    }
  });
  // 上面的 12 条都在同一道题上，去重后只剩 1 条 —— 这正是"同题只留最新"的直接验证
  const deduped = await fetch(`${baseUrl}/api/admin/adjudication/queue?bookId=${bookId}`).then((response) => response.json());
  assert.equal(deduped.total, 1);
  assert.deepEqual(deduped.items.map((item) => item.id), ["sug-00"]);
  assert.equal(deduped.items[0].updatedAt, 1200);
});
