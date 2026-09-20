const assert = require("node:assert/strict");
const test = require("node:test");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { buildFamilyCandidates, createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");

const bookId = "rich-fingerprint-book";
const catalogNodes = [
  { id: "chapter", level: 1, title: "第一章 语法", startPage: 1, endPage: 20 },
  { id: "section", level: 2, title: "第一节 词类", startPage: 2, endPage: 20 },
  { id: "noun", level: 3, title: "一、名词", startPage: 3, endPage: 8 },
  { id: "noun-kind", level: 4, title: "（一）名词的种类", startPage: 4, endPage: 6 },
  { id: "verb", level: 3, title: "二、动词", startPage: 9, endPage: 15 },
];

function question(id, stem = "比较名词和动词的语法作用。") {
  return {
    id,
    bookId,
    subjectId: "modern-chinese",
    library: "official",
    status: "official",
    chapter: "第一章 语法 > 第一节 词类",
    primaryKnowledgePoint: "词类",
    knowledgePoints: ["词类"],
    subKnowledgePoints: [],
    type: "short_answer",
    stem,
    options: [],
    referenceAnswer: "略",
  };
}

function generatedStore(questions) {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes: [], chunks: [], questions });
  return store;
}

test("rich assignments persist a confirmed multi-point fingerprint and recompute derived fields", () => {
  const questions = [question("q1")];
  const store = generatedStore(questions);
  const result = store.assignQuestions(bookId, [{
    questionId: "q1",
    primaryNodeId: "noun",
    requiredNodeIds: ["verb", "noun"],
    focus: {
      key: "词类比较",
      label: "名词与动词比较",
      action: "比较说明",
      confidence: 0.93,
      source: "agent_consensus",
      reason: "题干要求比较两个词类。",
    },
    evidenceChunkIds: ["chunk-2", "chunk-1", "chunk-2"],
    classificationJobId: "classification-job-1",
    questionVersion: 7,
    source: "human_confirmed_agent_proposal",
  }]);

  const fingerprint = result.structure.fingerprints.find((item) => item.questionId === "q1");
  assert.equal(fingerprint.primaryNodeId, "noun");
  assert.deepEqual(fingerprint.requiredNodeIds, ["noun", "verb"]);
  assert.deepEqual(fingerprint.auxiliaryNodeIds, []);
  assert.equal(fingerprint.span, "same_branch");
  assert.equal(fingerprint.crossKnowledge, true);
  assert.deepEqual(fingerprint.relations, ["共同作答"]);
  assert.equal(fingerprint.status, "confirmed");
  assert.equal(fingerprint.source, "human_confirmed_agent_proposal");
  assert.equal(fingerprint.focus.key, "词类比较");
  assert.deepEqual(fingerprint.evidenceChunkIds, ["chunk-2", "chunk-1"]);
  assert.equal(fingerprint.classificationJobId, "classification-job-1");
  assert.equal(fingerprint.questionVersion, 7);
  assert.equal(result.assignments[0].nodeId, "noun");

  const storedOverride = store.exportState().editsByBook[bookId].fingerprintOverrides.q1;
  assert.equal(storedOverride.primaryNodeId, "noun");
  assert.deepEqual(storedOverride.requiredNodeIds, ["noun", "verb"]);

  const regenerated = store.generate({ bookId, catalogNodes, outlineNodes: [], chunks: [], questions });
  const regeneratedFingerprint = regenerated.fingerprints.find((item) => item.questionId === "q1");
  assert.equal(regeneratedFingerprint.focus.key, "词类比较");
  assert.deepEqual(regeneratedFingerprint.requiredNodeIds, ["noun", "verb"]);
  assert.equal(regeneratedFingerprint.status, "confirmed");
});

test("theme range anchors may use the shared textbook section or chapter", () => {
  const questions = [question("q-theme")];
  const store = generatedStore(questions);
  const result = store.assignQuestions(bookId, [{
    questionId: "q-theme",
    primaryNodeId: "noun",
    requiredNodeIds: ["noun", "verb"],
    problemKnowledgeRangeNodeIds: ["noun", "verb"],
    knowledgeThemeRangeAnchorNodeId: "section",
    source: "manual_review",
  }]);
  const fingerprint = result.structure.fingerprints.find((item) => item.questionId === "q-theme");
  assert.equal(fingerprint.knowledgeThemeRangeAnchorNodeId, "section");
  assert.equal(fingerprint.scopeAnchorNodeId, "section");
  assert.deepEqual(fingerprint.requiredNodeIds, ["noun", "verb"]);
});

test("scope anchors persist separately from required knowledge and reject invalid assignments", () => {
  const questions = [question("q1")];
  const store = generatedStore(questions);
  const result = store.assignQuestions(bookId, [{
    questionId: "q1",
    primaryNodeId: "noun",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["noun-kind"],
  }]);
  const fingerprint = result.structure.fingerprints.find((item) => item.questionId === "q1");
  assert.equal(fingerprint.primaryNodeRole, "scope_anchor");
  assert.deepEqual(fingerprint.requiredNodeIds, ["noun-kind"]);

  const storedOverride = store.exportState().editsByBook[bookId].fingerprintOverrides.q1;
  assert.equal(storedOverride.primaryNodeRole, "scope_anchor");
  assert.deepEqual(storedOverride.requiredNodeIds, ["noun-kind"]);

  const regenerated = store.generate({ bookId, catalogNodes, outlineNodes: [], chunks: [], questions });
  const regeneratedFingerprint = regenerated.fingerprints.find((item) => item.questionId === "q1");
  assert.equal(regeneratedFingerprint.primaryNodeRole, "scope_anchor");
  assert.deepEqual(regeneratedFingerprint.requiredNodeIds, ["noun-kind"]);

  assert.throws(() => store.assignQuestions(bookId, [{
    questionId: "q1",
    primaryNodeId: "noun",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["noun", "noun-kind"],
  }]), /knowledge_assignment_scope_anchor_invalid/);
  assert.throws(() => store.assignQuestions(bookId, [{
    questionId: "q1",
    primaryNodeId: "noun",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["verb"],
  }]), /knowledge_assignment_scope_anchor_invalid/);
});

test("legacy string overrides and legacy nodeId assignments remain compatible", () => {
  const questions = [question("q1")];
  const base = generatedStore(questions).exportState();
  base.editsByBook = { [bookId]: { fingerprintOverrides: { q1: "verb" } } };
  const restored = createMemoryKnowledgeStructureStore(base);

  let structure = restored.generate({ bookId, catalogNodes, outlineNodes: [], chunks: [], questions });
  let fingerprint = structure.fingerprints.find((item) => item.questionId === "q1");
  assert.equal(fingerprint.primaryNodeId, "verb");
  assert.deepEqual(fingerprint.requiredNodeIds, ["verb"]);
  assert.equal(fingerprint.source, "manual_review");
  assert.equal(fingerprint.status, "confirmed");

  const assigned = restored.assignQuestions(bookId, [{ questionId: "q1", nodeId: "noun" }]);
  fingerprint = assigned.structure.fingerprints.find((item) => item.questionId === "q1");
  assert.equal(fingerprint.primaryNodeId, "noun");
  assert.equal(assigned.assignments[0].nodeId, "noun");
  assert.equal(assigned.assignments[0].primaryNodeId, "noun");
});

test("flat Agent 2 focus fields normalize into the rich fingerprint shape", () => {
  const store = generatedStore([question("q1")]);
  const assigned = store.assignQuestions(bookId, [{
    questionId: "q1",
    primaryNodeId: "noun",
    requiredNodeIds: ["noun"],
    focusKey: "词类判断",
    focusLabel: "名词判断",
    action: "分类判断",
    confidence: 0.88,
    reason: "Agent 2 已核验。",
    evidenceChunkIds: ["chunk-1"],
  }]);
  const fingerprint = assigned.structure.fingerprints.find((item) => item.questionId === "q1");
  assert.deepEqual(fingerprint.focus, {
    key: "词类判断",
    label: "名词判断",
    action: "分类判断",
    confidence: 0.88,
    source: "",
    reason: "Agent 2 已核验。",
  });
});

test("rich assignments reject missing and non-knowledge nodes", () => {
  const store = generatedStore([question("q1")]);
  assert.throws(() => store.assignQuestions(bookId, [{
    questionId: "q1",
    primaryNodeId: "noun",
    requiredNodeIds: ["missing"],
  }]), /knowledge_node_not_found/);
  assert.throws(() => store.assignQuestions(bookId, [{
    questionId: "q1",
    primaryNodeId: "chapter",
  }]), /knowledge_assignment_node_required/);
});

function confirmedFingerprints(requiredNodeIds = ["noun", "verb"], status = "confirmed") {
  return ["q1", "q2"].map((questionId) => ({
    questionId,
    primaryNodeId: "noun",
    primaryKnowledgePoint: "名词",
    knowledgePath: "语法 > 词类 > 名词",
    requiredNodeIds,
    status,
    focus: {
      key: "词类比较",
      label: "名词与动词比较",
      action: "比较说明",
      confidence: 0.94,
      source: "agent_consensus",
      reason: "两道题考查相同的跨知识点比较。",
    },
  }));
}

test("families use only confirmed fingerprint focus and stable IDs include sorted required nodes", () => {
  const questions = [question("q1"), question("q2")];
  const first = buildFamilyCandidates(questions, bookId, { fingerprints: confirmedFingerprints(["verb", "noun"]) });
  const reordered = buildFamilyCandidates(questions, bookId, { fingerprints: confirmedFingerprints(["noun", "verb"]) });
  assert.equal(first.families[0].id, reordered.families[0].id);
  assert.equal(first.families[0].focusKey, "词类比较");
  assert.equal(first.families[0].name, "名词与动词比较");
  assert.equal(first.families[0].source, "agent_consensus");
  assert.equal(first.families[0].members.every((member) => member.action === "比较说明"), true);

  const changedRequired = buildFamilyCandidates(questions, bookId, { fingerprints: confirmedFingerprints(["noun"]) });
  assert.notEqual(first.families[0].id, changedRequired.families[0].id);

  const suggested = buildFamilyCandidates([
    question("q1", "从发音方法来说，声母 b 是（ ）。"),
    question("q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ], bookId, { fingerprints: confirmedFingerprints(["noun"], "suggested") });
  assert.equal(suggested.families[0].focusKey, "声母发音方法·阻碍方式");
  assert.notEqual(suggested.families[0].focusKey, "词类比较");
});

test("automatic families keep a scope anchor as the family anchor without adding it to coverage", () => {
  const questions = [question("q1"), question("q2")];
  const fingerprints = confirmedFingerprints(["noun-kind"]).map((fingerprint) => ({
    ...fingerprint,
    primaryNodeRole: "scope_anchor",
  }));
  const candidate = buildFamilyCandidates(questions, bookId, { fingerprints }).families[0];
  assert.equal(candidate.coreKnowledgeNodeId, "noun");
  assert.deepEqual(candidate.textbookAnchorNodeIds, ["noun"]);
  assert.deepEqual(candidate.requiredKnowledgeNodeIds, ["noun-kind"]);
});

test("family ID migration preserves only semantically unchanged reviews", () => {
  const questions = [question("q1"), question("q2")];
  const fingerprints = confirmedFingerprints(["noun", "verb"]);
  const candidate = buildFamilyCandidates(questions, bookId, { fingerprints }).families[0];
  const store = createMemoryQuestionFamilyStore({
    version: 1,
    families: [{
      ...candidate,
      id: "question-family-legacy-id",
      status: "confirmed",
      reviewedAt: 123,
      reviewedBy: "人工审核员",
    }],
  });

  let regenerated = store.generate(questions, bookId, { fingerprints });
  assert.equal(regenerated.families[0].id, "question-family-legacy-id");
  assert.equal(store.get(candidate.id).id, "question-family-legacy-id");
  assert.equal(regenerated.families[0].status, "confirmed");
  assert.equal(regenerated.families[0].reviewedBy, "人工审核员");

  regenerated = store.generate(questions, bookId, { fingerprints: confirmedFingerprints(["noun"]) });
  assert.equal(regenerated.families[0].id, "question-family-legacy-id");
  assert.deepEqual(regenerated.families[0].requiredKnowledgeNodeIds, ["noun"]);
  assert.equal(regenerated.families[0].status, "pending_review");
  assert.equal(regenerated.families[0].reviewedBy, "");
});

test("option knowledge persists on the formal fingerprint and follows the v2 contract", () => {
  // 逐选项知识进入正式指纹（沿用金标既有的 option-knowledge-v2 形状）：
  // 此前人工确认的选项知识只留在金标审核条目里，正式指纹没有该字段，
  // 编辑页看不到、学生端也用不上（见《链路职责矩阵》产出 6）。
  const store = generatedStore([question("q-option")]);
  const result = store.assignQuestions(bookId, [{
    questionId: "q-option",
    primaryNodeId: "noun",
    requiredNodeIds: ["noun"],
    source: "manual_review",
    optionKnowledge: [
      // 另有选项知识：保留节点与标签
      {
        key: "a",
        text: "名词",
        knowledgeRelation: "option_specific",
        knowledgeNodeIds: ["noun-kind"],
        knowledgeLabels: ["语法 > 词类 > 名词 > 名词的种类"],
        role: "neutral",
        basis: "需知道名词种类才能排除",
        provenance: "human_gold_review",
      },
      // 仅题目知识：按合同必须清空节点与标签
      {
        key: "B",
        text: "动词",
        knowledgeRelation: "question_only",
        knowledgeNodeIds: ["verb"],
        knowledgeLabels: ["语法 > 词类 > 动词"],
        role: "answer",
      },
      // 非法关系 → 归一为 unreviewed
      { key: "C", text: "其他", knowledgeRelation: "not_a_relation", role: "not_a_role" },
      // 缺 key → 丢弃
      { text: "无选项号" },
    ],
  }]);

  const fingerprint = result.structure.fingerprints.find((item) => item.questionId === "q-option");
  assert.equal(Array.isArray(fingerprint.optionKnowledge), true);
  assert.equal(fingerprint.optionKnowledge.length, 3, "缺 key 的条目应被丢弃");

  const [optionA, optionB, optionC] = fingerprint.optionKnowledge;
  assert.equal(optionA.key, "A", "选项号归一为大写");
  assert.equal(optionA.protocolVersion, "option-knowledge-v2");
  assert.equal(optionA.knowledgeRelation, "option_specific");
  assert.deepEqual(optionA.knowledgeNodeIds, ["noun-kind"]);
  assert.equal(optionA.role, "neutral");
  assert.equal(optionA.provenance, "human_gold_review");

  assert.equal(optionB.key, "B");
  assert.equal(optionB.knowledgeRelation, "question_only");
  assert.deepEqual(optionB.knowledgeNodeIds, [], "仅题目知识不得携带节点");
  assert.deepEqual(optionB.knowledgeLabels, [], "仅题目知识不得携带标签");
  assert.equal(optionB.role, "answer");

  assert.equal(optionC.knowledgeRelation, "unreviewed", "非法关系归一为未判断");
  assert.equal(optionC.role, "unreviewed", "非法角色归一为未判断");

  // 重新读取（经过一次完整归一化）后字段仍然存在，证明它真正落盘而非仅存在于返回值
  const reread = store.get(bookId).fingerprints.find((item) => item.questionId === "q-option");
  assert.equal(reread.optionKnowledge.length, 3);
  assert.equal(reread.optionKnowledge[0].protocolVersion, "option-knowledge-v2");
});
