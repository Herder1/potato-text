const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");

test("classification experience keeps feedback, versioned rules and confirmed cases separate", () => {
  const store = createMemoryKnowledgeClassificationExperienceStore();
  const feedback = store.addMessage({
    resultId: "result-1",
    questionId: "question-1",
    bookId: "book-1",
    agent: "agent2",
    role: "reviewer",
    message: "声带振动、气流强弱和阻碍方式必须分开归类。",
    createdBy: "审核员",
  });
  const draft = store.createRule({
    bookId: "book-1",
    title: "区分辅音发音方法维度",
    statement: feedback.message,
    scopeNodeIds: ["method", "voicing", "airflow", "obstruction"],
    scopePath: "语音 > 辅音与声母 > 辅音的发音方法",
    questionTypes: ["single_choice"],
    triggerTerms: ["声带", "气流", "阻碍"],
    status: "draft",
    sourceFeedbackId: feedback.id,
  });
  assert.equal(store.context({ bookId: "book-1", nodeIds: ["voicing"], questionType: "single_choice", text: "声带是否振动" }).rules.length, 0);

  const active = store.updateRule(draft.id, { status: "active" }, "总审核员");
  assert.equal(active.status, "active");
  assert.equal(active.version, 2);
  assert.equal(active.history.length, 1);
  assert.equal(active.approvedBy, "总审核员");

  const confirmedCase = store.addCase({
    bookId: "book-1",
    questionId: "question-1",
    resultId: "result-1",
    questionType: "single_choice",
    stem: "根据声带是否振动判断清音和浊音",
    primaryNodeId: "voicing",
    requiredNodeIds: ["voicing"],
    knowledgePath: "语音 > 辅音与声母 > 看声带是否振动",
    focusKey: "声带振动",
    focusLabel: "清音和浊音",
    reason: "教材以声带是否振动区分清音和浊音。",
    ruleIds: [active.id],
    confirmedBy: "总审核员",
  });
  const context = store.context({
    bookId: "book-1",
    nodeIds: ["voicing"],
    questionType: "single_choice",
    text: "下列声母中哪个声带振动",
  });
  assert.deepEqual(context.rules.map((rule) => rule.id), [active.id]);
  assert.deepEqual(context.cases.map((item) => item.id), [confirmedCase.id]);
  assert.equal(store.context({ bookId: "book-2", nodeIds: ["voicing"], questionType: "single_choice", text: "声带" }).rules.length, 0);
  assert.equal(store.summary({ bookId: "book-1" }).active, 1);
  assert.equal(store.messages({ resultId: "result-1" })[0].message, feedback.message);
});

test("classification rule edits retain rollback history", () => {
  const store = createMemoryKnowledgeClassificationExperienceStore();
  const draft = store.createRule({
    bookId: "book-1",
    title: "初始规则",
    statement: "初始内容",
    triggerTerms: ["初始"],
  });
  const active = store.updateRule(draft.id, { title: "修订规则", statement: "修订内容", status: "active" }, "审核员");
  const inactive = store.updateRule(draft.id, { status: "inactive" }, "审核员");
  assert.equal(inactive.version, 3);
  assert.equal(inactive.history.length, 2);
  assert.equal(inactive.history[0].title, "初始规则");
  assert.equal(inactive.history[1].title, active.title);
});

test("similar feedback updates the original draft and rules in every status can be deleted", () => {
  const store = createMemoryKnowledgeClassificationExperienceStore();
  const first = store.upsertDraftRule({
    bookId: "book-1",
    sourceQuestionId: "q1",
    sourceAgent: "agent2",
    title: "选项判断题归类",
    statement: "必须检查全部选项。",
    scopeNodeIds: ["node-1"],
    triggerTerms: ["下列"],
    sourceFeedbackId: "feedback-1",
  }, "审核员");
  const second = store.upsertDraftRule({
    bookId: "book-1",
    sourceQuestionId: "q1",
    sourceAgent: "agent2",
    title: "选项判断题补充",
    statement: "多数干扰项集中于同一知识点时，要提高其训练权重。",
    scopeNodeIds: ["node-1", "node-2"],
    triggerTerms: ["正确的是"],
    sourceFeedbackId: "feedback-2",
  }, "审核员");
  assert.equal(first.action, "created");
  assert.equal(second.action, "updated");
  assert.equal(second.rule.id, first.rule.id);
  assert.equal(second.rule.version, 2);
  assert.deepEqual(second.rule.sourceFeedbackIds, ["feedback-1", "feedback-2"]);
  assert.equal(store.rules({ bookId: "book-1" }).length, 1);
  const active = store.updateRule(second.rule.id, { status: "active" }, "审核员");
  assert.equal(store.deleteRule(active.id).id, active.id);
  assert.equal(store.getRule(active.id), null);
  const disposable = store.createRule({ bookId: "book-1", title: "待删", statement: "待删内容", status: "draft" });
  assert.equal(store.deleteRule(disposable.id).id, disposable.id);
  assert.equal(store.getRule(disposable.id), null);
});

test("a later correction can replace a conflicting draft while preserving its history and feedback sources", () => {
  const store = createMemoryKnowledgeClassificationExperienceStore();
  const first = store.upsertDraftRule({
    bookId: "book-1",
    sourceQuestionId: "q1",
    sourceAgent: "agent4",
    title: "旧结论",
    statement: "必须保留上位知识点。",
    scopeNodeIds: ["parent-node"],
    triggerTerms: ["旧触发词"],
    sourceFeedbackId: "feedback-1",
  }, "审核员");
  const corrected = store.upsertDraftRule({
    bookId: "book-1",
    sourceQuestionId: "q1",
    sourceAgent: "agent4",
    title: "最小充分知识",
    statement: "直接知识已经足够时，不重复标注上位知识。",
    scopeNodeIds: ["direct-node"],
    triggerTerms: ["最小充分知识"],
    sourceFeedbackId: "feedback-2",
    mergeMode: "replace",
  }, "审核员");
  assert.equal(corrected.action, "updated");
  assert.equal(corrected.rule.id, first.rule.id);
  assert.equal(corrected.rule.title, "最小充分知识");
  assert.equal(corrected.rule.statement, "直接知识已经足够时，不重复标注上位知识。");
  assert.deepEqual(corrected.rule.scopeNodeIds, ["direct-node"]);
  assert.deepEqual(corrected.rule.triggerTerms, ["最小充分知识"]);
  assert.deepEqual(corrected.rule.sourceFeedbackIds, ["feedback-1", "feedback-2"]);
  assert.equal(corrected.rule.history.at(-1).statement, "必须保留上位知识点。");
});

test("Agent 4 stores corrections and rule exceptions without rewriting active rules", () => {
  const store = createMemoryKnowledgeClassificationExperienceStore();
  const active = store.updateRule(store.createRule({
    bookId: "book-1",
    title: "原规则",
    statement: "按 A 归类",
    scopeNodeIds: ["A"],
  }).id, { status: "active" }, "审核员");
  const correction = store.addCorrection({
    bookId: "book-1",
    questionId: "q1",
    resultId: "result-1",
    suggestedPrimaryNodeId: "A",
    finalPrimaryNodeId: "B",
    finalRequiredNodeIds: ["B"],
    reason: "题干实际询问 B。",
    correctedBy: "审核员",
  });
  const exception = store.addRuleException({
    ruleId: active.id,
    bookId: "book-1",
    questionId: "q1",
    resultId: "result-1",
    suggestedPrimaryNodeId: "A",
    finalPrimaryNodeId: "B",
    reason: correction.reason,
  });
  assert.equal(store.getRule(active.id).statement, "按 A 归类");
  assert.equal(store.corrections({ questionId: "q1" })[0].id, correction.id);
  assert.equal(store.ruleExceptions({ ruleId: active.id })[0].id, exception.id);
  assert.equal(store.summary({ bookId: "book-1" }).openExceptions, 1);
});

test("Agent 4 records audit events first and promotes only after three independent questions", () => {
  const store = createMemoryKnowledgeClassificationExperienceStore();
  const record = (questionId, reason = "题干实际考 B。") => store.recordReviewEvent({
    bookId: "book-1",
    questionId,
    resultId: `result-${questionId}`,
    eventType: "classification_correction",
    topicKey: "classification-correction:A->B",
    reason,
    suggestedPrimaryNodeId: "A",
    finalPrimaryNodeId: "B",
    proposal: {
      type: "rule",
      title: "A 到 B 的人工改判",
      statement: "题干实际询问 B 时不得按 A 归类。",
      scopeNodeIds: ["B"],
      triggerTerms: ["B"],
    },
  }, "审核员");

  assert.equal(record("q1").thresholdReached, false);
  const repeated = record("q1", "补充：A 只是前置背景。");
  assert.equal(repeated.independentCaseCount, 1);
  assert.equal(store.reviewEvents({ topicKey: "classification-correction:A->B" }).length, 1);
  assert.equal(record("q2").thresholdReached, false);
  const promoted = record("q3");
  assert.equal(promoted.thresholdReached, true);
  assert.equal(promoted.independentCaseCount, 3);
  assert.equal(promoted.rule.status, "draft");
  assert.equal(store.rules({ bookId: "book-1" }).length, 1);
  assert.equal(store.summary({ bookId: "book-1" }).reviewEvents, 3);
});

test("three dossier events create a review suggestion without editing an active dossier", () => {
  const store = createMemoryKnowledgeClassificationExperienceStore();
  const record = (questionId) => store.recordReviewEvent({
    bookId: "book-1",
    questionId,
    eventType: "classification_confirmation",
    topicKey: "dossier-boundary:dossier-1",
    reason: "该边界在三道题中均出现。",
    proposal: {
      type: "dossier",
      dossierId: "dossier-1",
      title: "档案边界补充",
      statement: "建议补充排除边界。",
      patch: { exclusionCriteria: ["前置背景不计入最小充分知识集"] },
    },
  }, "Agent 4");
  record("q1");
  record("q2");
  const promoted = record("q3");
  assert.equal(promoted.thresholdReached, true);
  assert.equal(promoted.dossierSuggestion.status, "draft");
  assert.deepEqual(promoted.dossierSuggestion.supportingQuestionIds, ["q3", "q2", "q1"]);
  assert.equal(store.dossierSuggestions({ dossierId: "dossier-1" }).length, 1);
});
