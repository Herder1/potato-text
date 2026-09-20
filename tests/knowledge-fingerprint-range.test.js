const assert = require("node:assert/strict");
const test = require("node:test");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");

function question(id) {
  return {
    id,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第一章 语音 ＞ 第一节 语音单位",
    primaryKnowledgePoint: "语音单位",
    knowledgePoints: ["语音单位"],
    subKnowledgePoints: [],
    type: "single_choice",
    typeLabel: "单选题",
    stem: "下列说法正确的是（ ）。",
    options: [{ key: "A", text: "选项一" }, { key: "B", text: "选项二" }],
    correctAnswer: ["A"],
    referenceAnswer: "选项一",
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    maxScore: 1,
    difficultyScore: 40,
    version: 1,
    versions: [],
  };
}

function seedStructure(store, sourceQuestion) {
  const structure = store.generate({
    bookId: sourceQuestion.bookId,
    catalogNodes: [
      { id: "range-anchor-chapter", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
      { id: "range-anchor-section", level: 2, title: "第一节 语音单位", startPage: 1, endPage: 20 },
      { id: "range-branch-a", level: 3, title: "音节", startPage: 2, endPage: 8 },
      { id: "range-leaf-a", level: 4, title: "音节结构", startPage: 3, endPage: 5 },
      { id: "range-branch-b", level: 3, title: "语素", startPage: 9, endPage: 15 },
      { id: "range-leaf-b", level: 4, title: "语素结构", startPage: 10, endPage: 12 },
    ],
    outlineNodes: [],
    chunks: [],
    questions: [sourceQuestion],
  });
  const state = store.exportState();
  const record = state.records.find((item) => item.bookId === sourceQuestion.bookId);
  record.fingerprints = record.fingerprints.map((fingerprint) => ({
    ...fingerprint,
    primaryNodeId: "range-leaf-a",
    primaryKnowledgePoint: "音节结构",
    knowledgePath: "第一章 语音 > 第一节 语音单位 > 音节 > 音节结构",
    requiredNodeIds: ["range-leaf-a"],
    // Simulate an older edit whose range still contains a second branch.
    problemKnowledgeRangeNodeIds: ["range-leaf-a", "range-leaf-b"],
    knowledgeThemeRangeAnchorNodeId: "range-branch-a",
    scopeAnchorNodeId: "range-branch-a",
    status: "confirmed",
    source: "manual_review",
  }));
  store.replaceState(state);
  return structure;
}

async function startServer(sourceQuestion) {
  const questionStore = createMemoryQuestionStore([sourceQuestion]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  seedStructure(knowledgeStructureStore, sourceQuestion);
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft(sourceQuestion.bookId, [
    { id: "range-anchor-chapter", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
    { id: "range-anchor-section", level: 2, title: "第一节 语音单位", startPage: 1, endPage: 20 },
    { id: "range-branch-a", level: 3, title: "音节", startPage: 2, endPage: 8 },
    { id: "range-leaf-a", level: 4, title: "音节结构", startPage: 3, endPage: 5 },
    { id: "range-branch-b", level: 3, title: "语素", startPage: 9, endPage: 15 },
    { id: "range-leaf-b", level: 4, title: "语素结构", startPage: 10, endPage: 12 },
  ], { source: "test" });
  textbookCatalogStore.confirm(sourceQuestion.bookId, "测试");
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    knowledgeStructureStore,
    questionFamilyStore: createMemoryQuestionFamilyStore(),
    textbookCatalogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    questionStore,
    knowledgeStructureStore,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

test("explicit problem range replaces stale cross-branch nodes before theme-anchor validation", async (context) => {
  const sourceQuestion = question("range-anchor-replacement-q");
  const runtime = await startServer(sourceQuestion);
  context.after(() => new Promise((resolve) => runtime.server.close(resolve)));

  const detail = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}`).then((response) => response.json());
  assert.deepEqual(detail.question.knowledgeFingerprint.problemKnowledgeRangeNodeIds, ["range-leaf-a", "range-leaf-b"]);

  const response = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "range-leaf-a",
      requiredNodeIds: ["range-leaf-a"],
      problemKnowledgeRangeNodeIds: ["range-leaf-a"],
      knowledgeThemeRangeAnchorNodeId: "range-branch-a",
      scopeAnchorNodeId: "range-branch-a",
      assessmentAction: "结构判断",
    }),
  });
  const saved = await response.json();
  assert.equal(response.status, 200, JSON.stringify(saved));
  assert.deepEqual(saved.question.knowledgeFingerprint.problemKnowledgeRangeNodeIds, ["range-leaf-a"]);
  assert.equal(saved.question.knowledgeFingerprint.knowledgeThemeRangeAnchorNodeId, "range-branch-a");
});

test("an explicit empty theme anchor clears a stale anchor without changing required knowledge", async (context) => {
  const sourceQuestion = question("range-anchor-clear-q");
  const runtime = await startServer(sourceQuestion);
  context.after(() => new Promise((resolve) => runtime.server.close(resolve)));

  const detail = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}`).then((response) => response.json());
  const response = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "range-leaf-a",
      requiredNodeIds: ["range-leaf-a"],
      problemKnowledgeRangeNodeIds: ["range-leaf-a"],
      knowledgeThemeRangeAnchorNodeId: "",
      scopeAnchorNodeId: "",
      assessmentAction: "结构判断",
    }),
  });
  const saved = await response.json();
  assert.equal(response.status, 200, JSON.stringify(saved));
  assert.equal(saved.question.knowledgeFingerprint.knowledgeThemeRangeAnchorNodeId, "");
  assert.equal(saved.question.knowledgeFingerprint.scopeAnchorNodeId, "");
  assert.deepEqual(saved.question.knowledgeFingerprint.requiredNodeIds, ["range-leaf-a"]);
});

test("an out-of-range theme anchor reports the uncovered nodes and usable anchor candidates", async (context) => {
  const sourceQuestion = question("range-anchor-invalid-q");
  const runtime = await startServer(sourceQuestion);
  context.after(() => new Promise((resolve) => runtime.server.close(resolve)));

  const detail = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}`).then((response) => response.json());
  const response = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "range-leaf-a",
      requiredNodeIds: ["range-leaf-a"],
      problemKnowledgeRangeNodeIds: ["range-leaf-a", "range-leaf-b"],
      // 只覆盖本分支，覆盖不到另一分支的 range-leaf-b
      knowledgeThemeRangeAnchorNodeId: "range-leaf-a",
      scopeAnchorNodeId: "range-leaf-a",
      assessmentAction: "结构判断",
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 422, JSON.stringify(body));
  assert.equal(body.error, "knowledge_assignment_theme_anchor_invalid");
  // 必须说清是哪个节点没被覆盖，并给出可以直接采用的候选锚点（最深优先）
  assert.deepEqual(body.details.uncoveredNodeIds, ["range-leaf-b"]);
  assert.ok(body.details.uncoveredLabels[0].includes("语素结构"), body.details.uncoveredLabels[0]);
  assert.equal(body.details.validAnchorNodeIds[0], "range-anchor-section");
  assert.ok(body.details.validAnchorLabels[0].includes("语音单位"), body.details.validAnchorLabels[0]);
  assert.ok(body.details.validAnchorNodeIds.includes("range-anchor-chapter"));

  // 采用服务端给出的候选锚点后应当可以保存
  const retry = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "range-leaf-a",
      requiredNodeIds: ["range-leaf-a"],
      problemKnowledgeRangeNodeIds: ["range-leaf-a", "range-leaf-b"],
      knowledgeThemeRangeAnchorNodeId: body.details.validAnchorNodeIds[0],
      scopeAnchorNodeId: body.details.validAnchorNodeIds[0],
      assessmentAction: "结构判断",
    }),
  });
  const saved = await retry.json();
  assert.equal(retry.status, 200, JSON.stringify(saved));
  assert.equal(saved.question.knowledgeFingerprint.knowledgeThemeRangeAnchorNodeId, "range-anchor-section");
});

test("option knowledge submitted with the fingerprint is persisted end-to-end", async (context) => {
  // 端到端：前端表格提交的载荷（形状见 admin 的 questionOptionKnowledgePayloadForSave）
  // → PUT /knowledge-fingerprint → 落到正式指纹，并遵守既有合同。
  const sourceQuestion = question("option-knowledge-e2e-q");
  const runtime = await startServer(sourceQuestion);
  context.after(() => new Promise((resolve) => runtime.server.close(resolve)));

  const detail = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}`)
    .then((response) => response.json());
  const response = await fetch(`${runtime.baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "range-leaf-a",
      requiredNodeIds: ["range-leaf-a"],
      problemKnowledgeRangeNodeIds: ["range-leaf-a", "range-leaf-b"],
      knowledgeThemeRangeAnchorNodeId: "range-anchor-section",
      scopeAnchorNodeId: "range-anchor-section",
      assessmentAction: "结构判断",
      optionKnowledge: [
        {
          key: "A",
          text: "甲",
          protocolVersion: "option-knowledge-v2",
          knowledgeRelation: "option_specific",
          knowledgeNodeIds: ["range-leaf-b"],
          knowledgeLabels: ["分支B > 叶b"],
          role: "distractor",
          provenance: "admin_edit",
        },
        {
          key: "B",
          text: "乙",
          protocolVersion: "option-knowledge-v2",
          knowledgeRelation: "question_only",
          // 故意带上节点：合同要求"仅题目知识"不得携带，服务端必须清空
          knowledgeNodeIds: ["range-leaf-a"],
          knowledgeLabels: ["分支A > 叶a"],
          role: "answer",
          provenance: "admin_edit",
        },
      ],
    }),
  });
  const saved = await response.json();
  assert.equal(response.status, 200, JSON.stringify(saved));

  const persisted = saved.question.knowledgeFingerprint.optionKnowledge;
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].key, "A");
  assert.equal(persisted[0].protocolVersion, "option-knowledge-v2");
  assert.equal(persisted[0].knowledgeRelation, "option_specific");
  assert.deepEqual(persisted[0].knowledgeNodeIds, ["range-leaf-b"]);
  assert.equal(persisted[0].role, "distractor");
  assert.equal(persisted[1].knowledgeRelation, "question_only");
  assert.deepEqual(persisted[1].knowledgeNodeIds, [], "仅题目知识不得携带涉及知识");
  assert.equal(persisted[1].role, "answer");

  // 直接读存储：确认真正落盘，而不是只出现在响应里
  const stored = runtime.knowledgeStructureStore.get(sourceQuestion.bookId).fingerprints
    .find((item) => item.questionId === sourceQuestion.id);
  assert.equal(stored.optionKnowledge.length, 2);
  assert.equal(stored.optionKnowledge[0].provenance, "admin_edit");
});
