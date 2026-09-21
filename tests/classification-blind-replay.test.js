const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildFamilyLeakageAudit,
  buildEvaluation,
  buildGoldStandard,
  buildGoldStandardFromFrozenItem,
  buildOptionKnowledgeEvaluation,
  buildMarkdownReport,
  buildReplayModePlan,
  compareAssessmentActions,
  evaluateCandidateFamilyDraft,
  frozenQuestionFromItem,
  independentFamilyMembers,
  normalizeAssessmentActionSemantics,
  parseArgs,
  questionContentSignature,
  resolveReplayMode,
  sanitizeExperienceState,
  sanitizeKnowledgeStructureState,
  sanitizeQuestionFamilyState,
  sanitizeQuestionForBlindReplay,
  setMetrics,
  summarizeReplayRetries,
} = require("../scripts/classification/run-classification-blind-replay");

test("frozen replay restores the official library shell only inside memory", () => {
  const frozen = frozenQuestionFromItem({
    questionId: "q-frozen",
    questionSnapshot: { bookId: "book-1", stem: "题干" },
    answerAndEvidence: { correctAnswer: ["A"] },
  });
  assert.equal(frozen.id, "q-frozen");
  assert.equal(frozen.library, "official");
  assert.equal(frozen.status, "official");
  assert.deepEqual(frozen.correctAnswer, ["A"]);
});

test("blind replay reads option knowledge relations from frozen and legacy gold", () => {
  const baseItem = {
    questionId: "q-option-relations",
    replayMode: "mature",
    goldStatus: "confirmed",
    includedInAccuracy: true,
    questionSnapshot: { bookId: "book-1" },
    answerAndEvidence: {},
    knowledgeGold: {
      coreKnowledge: { id: "node-core", path: "第一章 > 核心知识" },
      requiredKnowledge: [{ id: "node-core", path: "第一章 > 核心知识" }],
      optionKnowledge: [
        { key: "A", knowledgeRelation: "question_only", knowledgeNodeIds: [] },
        { key: "B", knowledgeRelation: "undetermined", knowledgeLabels: [] },
        { key: "C", knowledgeRelation: "option_specific", knowledgeNodeIds: ["node-c"] },
        { key: "D", knowledgeLabels: ["旧数据知识"] },
        { key: "E" },
      ],
    },
    familyGold: {
      replayMode: "mature",
      decision: "join_existing",
      primaryFamilyId: "family-1",
      families: [{ id: "family-1", independentMemberQuestionIds: ["q-option-relations", "q-other"] }],
    },
  };

  const gold = buildGoldStandardFromFrozenItem(baseItem);
  assert.equal(gold.primaryNodeRole, "core");
  assert.deepEqual(gold.optionKnowledge.map((option) => option.knowledgeRelation), [
    "question_only",
    "undetermined",
    "option_specific",
    "unreviewed",
    "unreviewed",
  ]);
  assert.equal(gold.includedInAccuracy, true);
  assert.deepEqual(gold.optionKnowledge[0].knowledgeNodeIds, []);
  assert.deepEqual(gold.optionKnowledge[2].knowledgeNodeIds, ["node-c"]);
  assert.equal(gold.optionKnowledge[3].legacyKnowledgeHints[0], "旧数据知识");
});

test("blind replay propagates scope-anchor roles and scores the role as part of the focus", () => {
  const frozenItem = {
    questionId: "q-scope-anchor",
    replayMode: "mature",
    goldStatus: "confirmed",
    includedInAccuracy: true,
    questionSnapshot: { bookId: "book-1" },
    knowledgeGold: {
      coreKnowledge: { id: "node-scope", path: "词汇 > 词汇单位" },
      coreKnowledgeRole: "scope_anchor",
      requiredKnowledge: [{ id: "node-answer", path: "词汇 > 语素识别" }],
    },
    familyGold: {
      replayMode: "mature",
      decision: "join_existing",
      primaryFamilyId: "family-answer",
      families: [{
        id: "family-answer",
        independentMemberQuestionIds: ["q-scope-anchor", "q-peer"],
      }],
    },
  };
  const gold = buildGoldStandardFromFrozenItem(frozenItem);
  assert.equal(gold.primaryNodeRole, "scope_anchor");
  assert.deepEqual(gold.requiredNodeIds, ["node-answer"]);

  const matched = buildEvaluation({
    agent2Verification: {
      primaryNodeId: "node-scope",
      primaryNodeRole: "scope_anchor",
      requiredNodeIds: ["node-answer"],
      primaryFamilyId: "family-answer",
      relatedFamilyIds: [],
    },
  }, gold, { mode: "mature" });
  assert.equal(matched.primaryNodeRoleExact, true);
  assert.equal(matched.coreKnowledgeExact, true);
  assert.equal(matched.modelGeneralizationSuccess, true);

  const missingRoleDefaultsToCore = buildEvaluation({
    agent2Verification: {
      primaryNodeId: "node-scope",
      requiredNodeIds: ["node-answer"],
      primaryFamilyId: "family-answer",
      relatedFamilyIds: [],
    },
  }, gold, { mode: "mature" });
  assert.equal(missingRoleDefaultsToCore.predictedPrimaryNodeRole, "core");
  assert.equal(missingRoleDefaultsToCore.primaryNodeRoleExact, false);
  assert.equal(missingRoleDefaultsToCore.coreKnowledgeExact, false);
  assert.equal(missingRoleDefaultsToCore.modelGeneralizationSuccess, false);
});

test("live blind gold uses formal fingerprint roles when building required knowledge", () => {
  const question = { id: "q-live-scope", bookId: "book-1" };
  const structureState = {
    records: [{
      bookId: "book-1",
      nodes: [
        { id: "node-scope", path: "词汇 > 词汇单位" },
        { id: "node-answer", path: "词汇 > 语素识别" },
      ],
      fingerprints: [{
        questionId: question.id,
        primaryNodeId: "node-scope",
        primaryNodeRole: "scope_anchor",
        requiredNodeIds: ["node-answer"],
        status: "confirmed",
      }],
    }],
  };
  const gold = buildGoldStandard(question, structureState, { families: [] });
  assert.equal(gold.primaryNodeRole, "scope_anchor");
  assert.deepEqual(gold.requiredNodeIds, ["node-answer"]);
});

test("blind replay scores only answer-essential related families and keeps reference relations diagnostic", () => {
  const family = (id, name) => ({
    id,
    name,
    independentMemberQuestionIds: ["q-joint", `${id}-other`],
  });
  const gold = buildGoldStandardFromFrozenItem({
    questionId: "q-joint",
    replayMode: "mature",
    goldStatus: "confirmed",
    includedInAccuracy: true,
    questionSnapshot: { bookId: "book-1" },
    knowledgeGold: {
      coreKnowledge: { id: "node-core" },
      requiredKnowledge: [{ id: "node-core" }, { id: "node-extra" }],
    },
    familyGold: {
      replayMode: "mature",
      decision: "join_existing",
      primaryFamilyId: "family-primary",
      relatedFamilyIds: ["family-required", "family-reference"],
      relatedFamilyRelations: [
        { familyId: "family-required", coverageRole: "required" },
        { familyId: "family-reference", coverageRole: "reference" },
      ],
      families: [
        family("family-primary", "主题族"),
        family("family-required", "作答必需关联族"),
        family("family-reference", "普通关联族"),
      ],
    },
  });

  assert.deepEqual(gold.requiredRelatedFamilyIds, ["family-required"]);
  assert.deepEqual(gold.referenceRelatedFamilyIds, ["family-reference"]);
  assert.deepEqual(gold.familyIds, ["family-primary", "family-required"]);
  assert.equal(gold.families.find((entry) => entry.id === "family-reference").coverageRole, "reference");
  const evaluation = buildEvaluation({
    agent2Verification: {
      primaryNodeId: "node-core",
      requiredNodeIds: ["node-core", "node-extra"],
      primaryFamilyId: "family-primary",
      relatedFamilyIds: ["family-required"],
    },
  }, gold, { mode: "mature" });
  assert.equal(evaluation.familyMemberships.exact, true);
  assert.equal(evaluation.modelGeneralizationSuccess, true);
});

test("candidate-family replay can still require visible existing related families", () => {
  const gold = {
    goldStatus: "confirmed",
    includedInAccuracy: true,
    primaryNodeId: "node-core",
    requiredNodeIds: ["node-core", "node-extra"],
    requiredRelatedFamilyIds: ["family-required"],
    referenceRelatedFamilyIds: [],
    primaryFamilyId: "",
    familyIds: ["family-required"],
    hiddenGoldFamilyIds: [],
    primaryFamily: {
      name: "候选主题族",
      coreKnowledgeNodeId: "node-core",
      requiredKnowledgeNodeIds: ["node-core"],
      textbookAnchorNodeIds: ["node-core"],
      assessmentAction: "综合判断",
    },
  };
  const evaluation = buildEvaluation({
    agent2Verification: {
      primaryNodeId: "node-core",
      requiredNodeIds: ["node-core", "node-extra"],
      familyDecision: "create_new",
      primaryFamilyId: "",
      relatedFamilyIds: ["family-required"],
      candidateFamilyDraft: {
        name: "候选主题族",
        coreKnowledgeNodeId: "node-core",
        requiredKnowledgeNodeIds: ["node-core"],
        textbookAnchorNodeIds: ["node-core"],
        assessmentAction: "综合判断",
        inclusionBoundary: "纳入联合判断",
        exclusionBoundary: "排除单知识题",
        textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材证据" },
      },
    },
  }, gold, { mode: "unmatched", unmatchedGoldStatus: "confirmed" });
  assert.equal(evaluation.familyMemberships.applicable, true);
  assert.equal(evaluation.familyMemberships.exact, true);
  assert.equal(evaluation.hiddenGoldFamilyIdReturned, false);
  assert.equal(evaluation.modelGeneralizationSuccess, true);
});

test("option relation evaluation keeps Agent 1 errors visible and separates node metrics", () => {
  const gold = {
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
    choiceStructure: "direct_options",
    optionKnowledge: [
      { key: "A", knowledgeRelation: "question_only", knowledgeNodeIds: [] },
      { key: "B", knowledgeRelation: "option_specific", knowledgeNodeIds: ["node-b"] },
      { key: "C", knowledgeRelation: "question_only", knowledgeNodeIds: [] },
      { key: "D", knowledgeRelation: "undetermined", uncertaintyNote: "证据不足" },
      { key: "E", knowledgeRelation: "option_specific", knowledgeNodeIds: ["node-e1", "node-e2"] },
    ],
  };
  const result = {
    agent1Features: {
      optionFeatures: [
        { key: "A", knowledgeRelation: "question_only" },
        { key: "B", knowledgeRelation: "undetermined" },
        { key: "C", knowledgeRelation: "option_specific" },
        { key: "D", knowledgeRelation: "undetermined" },
        { key: "E", knowledgeRelation: "option_specific" },
      ],
    },
    agent2Verification: {
      optionRelationAssessments: [
        { key: "A", agent1KnowledgeRelation: "question_only", decision: "confirm", verifiedKnowledgeNodeIds: [] },
        { key: "B", agent1KnowledgeRelation: "undetermined", decision: "confirm", verifiedKnowledgeNodeIds: [] },
        { key: "C", agent1KnowledgeRelation: "option_specific", decision: "confirm", verifiedKnowledgeNodeIds: ["node-c"] },
        { key: "D", agent1KnowledgeRelation: "undetermined", decision: "confirm", verifiedKnowledgeNodeIds: [] },
        { key: "E", agent1KnowledgeRelation: "option_specific", decision: "confirm", verifiedKnowledgeNodeIds: ["node-e1", "node-extra"] },
      ],
      // 历史占位字段即使存在，也不得再进入 V2 节点指标。
      optionKnowledge: [
        { key: "B", knowledgeNodeIds: ["node-b"] },
        { key: "C", knowledgeNodeIds: ["node-c"] },
        { key: "E", knowledgeNodeIds: ["node-e1", "node-e2"] },
      ],
    },
  };

  const evaluation = buildOptionKnowledgeEvaluation(result, gold);
  assert.equal(evaluation.eligibleCount, 4);
  assert.equal(evaluation.correctCount, 2);
  assert.equal(evaluation.accuracy, 0.5);
  assert.equal(evaluation.confusionMatrix.option_specific.undetermined, 1);
  assert.equal(evaluation.falseAbstentionCount, 1);
  assert.equal(evaluation.falseAbstentionRate, 0.25);
  assert.equal(evaluation.questionExact, false);
  assert.equal(evaluation.goldUndetermined.count, 1);
  assert.equal(evaluation.goldUndetermined.recall, 1);
  assert.equal(evaluation.nodeEndToEnd.truePositive, 1);
  assert.equal(evaluation.nodeEndToEnd.falsePositive, 2);
  assert.equal(evaluation.nodeEndToEnd.falseNegative, 2);
  assert.equal(evaluation.nodeEndToEnd.f1, 1 / 3);
  assert.equal(evaluation.nodeConditional.f1, 0.5);
});

test("node end-to-end metrics count nodes from a false option-specific relation as false positives", () => {
  const evaluation = buildOptionKnowledgeEvaluation({
    agent1Features: {
      optionFeatures: [{ key: "A", knowledgeRelation: "option_specific" }],
    },
    agent2Verification: {
      optionRelationAssessments: [{
        key: "A",
        agent1KnowledgeRelation: "option_specific",
        decision: "confirm",
        verifiedKnowledgeNodeIds: ["node-spurious"],
      }],
    },
  }, {
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
    choiceStructure: "direct_options",
    optionKnowledge: [{ key: "A", knowledgeRelation: "question_only", knowledgeNodeIds: [] }],
  });

  assert.equal(evaluation.nodeEndToEnd.falsePositive, 1);
  assert.equal(evaluation.nodeEndToEnd.unitCount, 1);
  assert.equal(evaluation.nodeConditional.unitCount, 0);
});

test("frozen gold exclusion remains excluded even when its gold status is confirmed", () => {
  const item = {
    questionId: "q-explicitly-excluded",
    replayMode: "mature",
    goldStatus: "confirmed",
    includedInAccuracy: false,
    questionSnapshot: { bookId: "book-1" },
    knowledgeGold: {
      coreKnowledge: { id: "node-core" },
      requiredKnowledge: [{ id: "node-core" }],
    },
    familyGold: {
      replayMode: "mature",
      primaryFamilyId: "family-1",
      families: [{ id: "family-1" }],
    },
  };
  const gold = buildGoldStandardFromFrozenItem(item);
  const evaluation = buildEvaluation({
    status: "pending_review",
    agent2Verification: {
      primaryNodeId: "node-core",
      requiredNodeIds: ["node-core"],
      primaryFamilyId: "family-1",
      relatedFamilyIds: [],
    },
  }, gold, { mode: "mature" });

  assert.equal(gold.includedInAccuracy, false);
  assert.equal(evaluation.includedInAccuracy, false);
  assert.equal(evaluation.countedResult, null);
  assert.equal(evaluation.accuracyExclusionReason, "gold_excluded_from_accuracy");
});

test("composed option relation evaluation scores atomic statements instead of wrapper choices", () => {
  const evaluation = buildOptionKnowledgeEvaluation({
    agent1Features: {
      optionFeatures: [{ key: "A", knowledgeRelation: "option_specific" }],
      atomicStatements: [
        { key: "1", knowledgeRelation: "question_only" },
        { key: "2", knowledgeRelation: "option_specific" },
      ],
    },
    agent2Verification: {
      optionRelationAssessments: [
        { key: "1", agent1KnowledgeRelation: "question_only", decision: "confirm", verifiedKnowledgeNodeIds: [] },
        { key: "2", agent1KnowledgeRelation: "option_specific", decision: "confirm", verifiedKnowledgeNodeIds: ["node-2"] },
      ],
      atomicStatements: [{ key: "2", knowledgeNodeIds: ["wrong-legacy-node"] }],
    },
  }, {
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
    choiceStructure: "composed_options",
    atomicStatements: [
      { key: "1", knowledgeRelation: "question_only" },
      { key: "2", knowledgeRelation: "option_specific", knowledgeNodeIds: ["node-2"] },
    ],
  });

  assert.equal(evaluation.eligibleCount, 2);
  assert.equal(evaluation.questionExact, true);
  assert.equal(evaluation.nodeEndToEnd.f1, 1);
});

test("node metrics read Agent 3 option-specific correction nodes without changing Agent 1 relation scoring", () => {
  const evaluation = buildOptionKnowledgeEvaluation({
    agent1Features: {
      optionFeatures: [{ key: "A", knowledgeRelation: "option_specific" }],
    },
    agent2Verification: {
      optionRelationAssessments: [{
        key: "A",
        agent1KnowledgeRelation: "option_specific",
        decision: "correction",
        proposedKnowledgeRelation: "option_specific",
        proposedKnowledgeNodeIds: ["node-corrected"],
      }],
      optionKnowledge: [{ key: "A", knowledgeNodeIds: ["wrong-legacy-node"] }],
    },
  }, {
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
    choiceStructure: "direct_options",
    optionKnowledge: [{
      key: "A",
      knowledgeRelation: "option_specific",
      knowledgeNodeIds: ["node-corrected"],
    }],
  });

  assert.equal(evaluation.correctCount, 1);
  assert.equal(evaluation.nodeEndToEnd.f1, 1);
  assert.equal(evaluation.nodeConditional.f1, 1);
});

const targetQuestion = {
  id: "question-target",
  bookId: "book-1",
  chapter: "第一章 > 第一节",
  knowledgePoints: ["旧知识"],
  primaryKnowledgePoint: "旧知识",
  subKnowledgePoints: ["旧小点"],
  stem: "（某大学2020年）下列哪项正确（ ）。",
  material: "材料",
  options: [{ key: "A", text: "选项 A" }, { key: "B", text: "选项 B" }],
  correctAnswer: ["A"],
  referenceAnswer: "A 项正确。",
  answerVariants: { official: "A 项正确。", ai: "AI 旧答案", community: "社区答案" },
  answerSource: "team_verified",
  answerReviewStatus: "verified",
  answerVerified: true,
  versions: [{
    version: 1,
    previousSnapshot: {
      id: "question-target",
      chapter: "旧章",
      knowledgePoints: ["旧知识"],
      primaryKnowledgePoint: "旧知识",
      subKnowledgePoints: ["旧小点"],
    },
  }],
};

test("blind replay masks manual question labels while retaining legitimate answer evidence", () => {
  const masked = sanitizeQuestionForBlindReplay(targetQuestion);
  assert.equal(masked.chapter, "");
  assert.deepEqual(masked.knowledgePoints, []);
  assert.equal(masked.primaryKnowledgePoint, "");
  assert.deepEqual(masked.subKnowledgePoints, []);
  assert.equal(masked.stem, targetQuestion.stem);
  assert.deepEqual(masked.options, targetQuestion.options);
  assert.deepEqual(masked.correctAnswer, ["A"]);
  assert.equal(masked.referenceAnswer, "A 项正确。");
  assert.equal(masked.answerVariants.official, "A 项正确。");
  assert.equal(masked.answerVariants.ai, "");
  assert.equal(masked.answerVariants.community, "");
  assert.equal(masked.versions[0].previousSnapshot.chapter, "");
  assert.deepEqual(masked.versions[0].previousSnapshot.knowledgePoints, []);
});

test("blind replay removes target fingerprints and manual overrides only", () => {
  const state = {
    version: 1,
    records: [{
      bookId: "book-1",
      fingerprints: [
        { questionId: "question-target", primaryNodeId: "node-gold" },
        { questionId: "question-other", primaryNodeId: "node-other" },
      ],
    }],
    editsByBook: {
      "book-1": {
        fingerprintOverrides: {
          "question-target": { primaryNodeId: "node-gold" },
          "question-other": { primaryNodeId: "node-other" },
        },
      },
    },
  };
  const masked = sanitizeKnowledgeStructureState(state, ["question-target"]);
  assert.deepEqual(masked.records[0].fingerprints.map((item) => item.questionId), ["question-other"]);
  assert.equal(masked.editsByBook["book-1"].fingerprintOverrides["question-target"], undefined);
  assert.equal(masked.editsByBook["book-1"].fingerprintOverrides["question-other"].primaryNodeId, "node-other");
  assert.equal(state.records[0].fingerprints.length, 2);
});

test("blind replay retains family definitions but removes target membership and revision", () => {
  const state = {
    version: 4,
    families: [{
      id: "family-gold",
      name: "正确题族",
      members: [
        { questionId: "question-target", isPrimary: true },
        { questionId: "question-other", isPrimary: false },
      ],
    }],
    membershipRevisionByQuestion: { "question-target": 5, "question-other": 2 },
    unresolvedByBook: { "book-1": ["question-target", "question-other"] },
  };
  const masked = sanitizeQuestionFamilyState(state, ["question-target"]);
  assert.equal(masked.families[0].name, "正确题族");
  assert.deepEqual(masked.families[0].members.map((member) => member.questionId), ["question-other"]);
  assert.equal(masked.membershipRevisionByQuestion["question-target"], undefined);
  assert.equal(masked.membershipRevisionByQuestion["question-other"], 2);
  assert.deepEqual(masked.unresolvedByBook["book-1"], ["question-other"]);
});

test("blind replay removes self cases, feedback, corrections and directly derived rules", () => {
  const state = {
    messages: [
      { id: "feedback-target", questionId: "question-target", resultId: "result-target" },
      { id: "feedback-other", questionId: "question-other", resultId: "result-other" },
    ],
    cases: [
      { id: "case-target", questionId: "question-target", resultId: "result-target" },
      { id: "case-other", questionId: "question-other", resultId: "result-other" },
    ],
    corrections: [{ id: "correction-target", questionId: "question-target", resultId: "result-target" }],
    ruleExceptions: [{ id: "exception-target", questionId: "question-target", resultId: "result-target" }],
    reviewEvents: [{ id: "event-target", questionId: "question-target", resultId: "result-target" }],
    dossierSuggestions: [{ id: "suggestion-target", questionId: "question-target", resultId: "result-target" }],
    rules: [
      { id: "rule-source-question", sourceQuestionId: "question-target", statement: "直接来源" },
      { id: "rule-source-feedback", sourceFeedbackIds: ["feedback-target"], statement: "反馈来源" },
      { id: "rule-exact-example", statement: "规则", positiveExamples: ["下列哪项正确（ ）。"] },
      { id: "rule-other", sourceQuestionId: "question-other", statement: "其他题的规则" },
    ],
  };
  const masked = sanitizeExperienceState(state, [targetQuestion]);
  assert.deepEqual(masked.messages.map((item) => item.id), ["feedback-other"]);
  assert.deepEqual(masked.cases.map((item) => item.id), ["case-other"]);
  assert.deepEqual(masked.corrections, []);
  assert.deepEqual(masked.ruleExceptions, []);
  assert.deepEqual(masked.reviewEvents, []);
  assert.deepEqual(masked.dossierSuggestions, []);
  assert.deepEqual(masked.rules.map((rule) => rule.id), ["rule-other"]);
  assert.equal(state.rules.length, 4);
});

test("blind replay builds confirmed gold and scores exact knowledge and family matches", () => {
  const structureState = {
    records: [{
      bookId: "book-1",
      nodes: [{ id: "node-gold", title: "直接知识", path: "章 > 直接知识" }],
      fingerprints: [{
        questionId: "question-target",
        primaryNodeId: "node-gold",
        requiredNodeIds: ["node-gold"],
        knowledgePath: "章 > 直接知识",
        status: "confirmed",
      }],
    }],
  };
  const familyState = {
    families: [{
      id: "family-gold",
      bookId: "book-1",
      name: "正确题族",
      status: "confirmed",
      coreKnowledgeNodeId: "node-gold",
      requiredKnowledgeNodeIds: ["node-gold"],
      assessmentAction: "判断",
      members: [{ questionId: "question-target", isPrimary: true }],
    }],
  };
  const gold = buildGoldStandard(targetQuestion, structureState, familyState);
  const evaluation = buildEvaluation({
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-gold",
      requiredNodeIds: ["node-gold"],
      familyDecision: "join_existing",
      primaryFamilyId: "family-gold",
      relatedFamilyIds: [],
    },
  }, gold);
  assert.equal(evaluation.coreKnowledgeExact, true);
  assert.equal(evaluation.requiredKnowledge.exact, true);
  assert.equal(evaluation.primaryFamilyExact, true);
  assert.equal(evaluation.familyMemberships.exact, true);
  assert.equal(evaluation.unresolved, false);
});

test("set metrics expose partial recall instead of collapsing to a binary score", () => {
  const metrics = setMetrics(["a"], ["a", "b"]);
  assert.equal(metrics.exact, false);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 0.5);
  assert.equal(Math.round(metrics.f1 * 1000) / 1000, 0.667);
  assert.equal(metrics.jaccard, 0.5);
});

test("blind replay parses and validates DEC-026 modes and gold status", () => {
  const parsed = parseArgs([
    "--question-id", "question-1",
    "--gold-snapshot", "gold.json",
    "--replay-context", "context.json",
    "--mode", "singleton",
    "--gold-status", "gold_needs_review",
    "--unmatched-gold", "confirmed",
    "--timeout-ms", "2000",
  ]);
  assert.equal(parsed.mode, "singleton");
  assert.equal(parsed.goldStatus, "gold_needs_review");
  assert.equal(parsed.unmatchedGoldStatus, "confirmed");
  assert.equal(parsed.timeoutMs, 2000);
  const required = ["--gold-snapshot", "gold.json", "--replay-context", "context.json"];
  assert.throws(() => parseArgs([...required, "--mode", "legacy"]), /blind_replay_mode_invalid/);
  assert.throws(() => parseArgs([...required, "--gold-status", "draft"]), /blind_replay_gold_status_invalid/);
  assert.throws(() => parseArgs([...required, "--unmatched-gold", "assumed"]), /blind_replay_unmatched_gold_status_invalid/);
  assert.throws(() => parseArgs(["--gold-snapshot", "gold.json"]), /blind_replay_context_required/);
});

test("blind replay consumes a pre-masked C1 item context instead of live runtime or gold-built input", () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/classification/run-classification-blind-replay.js"), "utf8");
  const runSource = source.slice(source.indexOf("async function runBlindReplay"), source.indexOf("async function main"));
  assert.match(runSource, /replayContext\.data\.itemContexts\?\.\[options\.questionId\]/);
  assert.match(runSource, /itemContext\.input\?\.questionFamilies/);
  assert.doesNotMatch(runSource, /readJson\(path\.join\(runtimeDir/);
  assert.doesNotMatch(runSource, /buildReplayModePlan\(/);
  assert.doesNotMatch(runSource, /sanitizeQuestionFamilyState\(/);
  assert.doesNotMatch(runSource, /sanitizeKnowledgeStructureState\(/);
  assert.doesNotMatch(runSource, /sanitizeExperienceState\(/);
  assert.doesNotMatch(source, /status:\s*"confirmed"[\s\S]{0,500}frozenFamily/);
});

test("mature replay requires two independent members and leaves another real member visible", () => {
  const familyState = {
    version: 4,
    families: [{
      id: "family-mature",
      bookId: "book-1",
      status: "confirmed",
      name: "成熟题族",
      coreKnowledgeNodeId: "node-gold",
      requiredKnowledgeNodeIds: ["node-gold"],
      assessmentAction: "判断",
      members: [
        { questionId: "question-target", isPrimary: true },
        { questionId: "question-other", isPrimary: true },
        { questionId: "question-other", isPrimary: false },
      ],
    }],
    familyAliases: {},
    familySetLinks: [],
    historyByBook: {},
  };
  const gold = {
    questionId: "question-target",
    primaryFamilyId: "family-mature",
    primaryFamilyIndependentMemberCount: 2,
    familyIds: ["family-mature"],
    families: [{ id: "family-mature", isPrimary: true }],
  };
  const plan = buildReplayModePlan("auto", gold, familyState);
  assert.equal(plan.mode, "mature");
  assert.equal(plan.retainedIndependentMemberCount, 1);
  assert.deepEqual(plan.hiddenFamilyIds, []);
  const masked = sanitizeQuestionFamilyState(familyState, ["question-target"], plan);
  assert.deepEqual(masked.families[0].members.map((member) => member.questionId), ["question-other", "question-other"]);
  const audit = buildFamilyLeakageAudit(familyState, masked, "question-target", plan);
  assert.equal(audit.retainedOtherPrimaryMembers, 1);
  assert.equal(audit.matureLeaveOneSatisfied, true);
  assert.equal(audit.candidateContextClean, true);

  const staleFrozenGold = { ...gold, primaryFamilyRetainedIndependentMemberQuestionIds: [] };
  const staleFrozenPlan = buildReplayModePlan("mature", staleFrozenGold, familyState);
  assert.deepEqual(staleFrozenPlan.retainedIndependentMemberQuestionIds, ["question-other"]);
  assert.equal(buildFamilyLeakageAudit(familyState, masked, "question-target", staleFrozenPlan).candidateContextClean, true);
  assert.throws(() => resolveReplayMode("mature", { primaryFamilyId: "family-single", primaryFamilyIndependentMemberCount: 1 }),
    /blind_replay_mature_family_requires_two_independent_members/);
});

test("mature membership counts distinct question content instead of historical duplicate ids", () => {
  const duplicateQuestion = {
    ...targetQuestion,
    id: "question-duplicate",
    options: [{ key: "B", text: "选项 B" }, { key: "A", text: "选项 A" }],
  };
  const distinctQuestion = {
    ...targetQuestion,
    id: "question-distinct",
    stem: "另一道真正独立的题目。",
  };
  const ordinaryQuestion = {
    ...targetQuestion,
    id: "question-ordinary",
    stem: "只作为普通副归属成员的题目。",
  };
  assert.equal(questionContentSignature(targetQuestion), questionContentSignature(duplicateQuestion));
  const family = {
    id: "family-content",
    bookId: "book-1",
    status: "confirmed",
    name: "内容去重题族",
    coreKnowledgeNodeId: "node-gold",
    requiredKnowledgeNodeIds: ["node-gold"],
    members: [
      { questionId: "question-target", isPrimary: true },
      { questionId: "question-duplicate", isPrimary: true },
    ],
  };
  assert.equal(independentFamilyMembers(family, [targetQuestion, duplicateQuestion]).length, 1);
  const structureState = {
    records: [{
      bookId: "book-1",
      nodes: [{ id: "node-gold", title: "直接知识", path: "章 > 直接知识" }],
      fingerprints: [{ questionId: "question-target", primaryNodeId: "node-gold", requiredNodeIds: ["node-gold"], status: "confirmed" }],
    }],
  };
  const singletonGold = buildGoldStandard(targetQuestion, structureState, { families: [family] }, {
    questionState: [targetQuestion, duplicateQuestion],
  });
  assert.equal(singletonGold.primaryFamilyIndependentMemberCount, 1);
  assert.equal(resolveReplayMode("auto", singletonGold), "singleton");
  assert.throws(() => resolveReplayMode("mature", singletonGold), /blind_replay_mature_family_requires_two_independent_members/);

  // 普通副归属成员（isPrimary=false）不是独立成员：即使内容唯一也不能计数。
  const matureFamily = {
    ...family,
    members: [
      ...family.members,
      { questionId: "question-distinct", isPrimary: true },
      { questionId: "question-ordinary", isPrimary: false },
    ],
  };
  const matureQuestionState = [targetQuestion, duplicateQuestion, distinctQuestion, ordinaryQuestion];
  assert.deepEqual(independentFamilyMembers(matureFamily, matureQuestionState).map((item) => item.questionId).sort(),
    ["question-distinct", "question-target"]);
  const matureGold = buildGoldStandard(targetQuestion, structureState, { families: [matureFamily] }, {
    questionState: matureQuestionState,
  });
  assert.equal(matureGold.primaryFamilyIndependentMemberCount, 2);
  assert.equal(matureGold.primaryFamilyRetainedIndependentMemberCount, 2);
  assert.equal(resolveReplayMode("auto", matureGold), "mature");
});

test("singleton replay hides the complete gold family context and scores a semantic draft instead of its old ID", () => {
  const familyState = {
    version: 4,
    families: [{
      id: "family-single",
      bookId: "book-1",
      status: "confirmed",
      name: "拼合规律运用",
      knowledgeNodeId: "node-anchor",
      coreKnowledgeNodeId: "node-gold",
      requiredKnowledgeNodeIds: ["node-gold"],
      textbookAnchorNodeIds: ["node-anchor"],
      assessmentAction: "根据拼合规律判断音节能否成立",
      inclusionBoundary: "直接运用声韵拼合限制",
      exclusionBoundary: "仅识别音节结构",
      members: [{ questionId: "question-target", isPrimary: true }],
    }, {
      id: "family-other",
      bookId: "book-1",
      status: "confirmed",
      name: "其他题族",
      members: [{ questionId: "question-other", isPrimary: true }],
    }],
    familyAliases: {
      "family-single-old": "family-single",
      "family-single-older": "family-single-old",
      "family-other-old": "family-other",
    },
    familySets: [{ id: "set-1", bookId: "book-1", knowledgeNodeId: "node-anchor", name: "拼音" }],
    familySetLinks: [
      { id: "link-single", setId: "set-1", memberType: "family", memberId: "family-single" },
      { id: "link-single-alias", setId: "set-1", memberType: "family", memberId: "family-single-older" },
      { id: "link-other", setId: "set-1", memberType: "family", memberId: "family-other" },
    ],
    historyByBook: {
      "book-1": [{
        families: [
          { id: "family-single", name: "历史拼合规律" },
          { id: "family-single-old", name: "历史旧拼合规律" },
          { id: "family-single-older", name: "更早历史拼合规律" },
          { id: "family-other", name: "历史其他" },
        ],
        familyAliases: { "family-single-old": "family-single" },
      }],
    },
  };
  const expectedFamily = familyState.families[0];
  const gold = {
    goldStatus: "confirmed",
    questionId: "question-target",
    primaryNodeId: "node-gold",
    requiredNodeIds: ["node-gold"],
    primaryFamilyId: "family-single",
    primaryFamilyIndependentMemberCount: 1,
    familyIds: ["family-single"],
    families: [{ ...expectedFamily, id: "family-single", isPrimary: true }],
    primaryFamily: { ...expectedFamily, id: "family-single", isPrimary: true },
  };
  const plan = buildReplayModePlan("auto", gold, familyState);
  assert.equal(plan.mode, "singleton");
  assert.deepEqual(plan.hiddenFamilyIds, ["family-single"]);
  const masked = sanitizeQuestionFamilyState(familyState, ["question-target"], plan);
  assert.deepEqual(masked.families.map((family) => family.id), ["family-other"]);
  assert.deepEqual(masked.familyAliases, { "family-other-old": "family-other" });
  assert.deepEqual(masked.familySetLinks.map((link) => link.id), ["link-other"]);
  assert.deepEqual(masked.historyByBook["book-1"][0].families.map((family) => family.id), ["family-other"]);
  const audit = buildFamilyLeakageAudit(familyState, masked, "question-target", plan);
  assert.equal(audit.removedFamilyDefinitions, 1);
  assert.equal(audit.removedFamilyAliases, 2);
  assert.equal(audit.removedFamilySetLinks, 2);
  assert.equal(audit.removedHistoricalFamilyDefinitions, 3);
  assert.equal(audit.candidateContextClean, true);

  const leakedIdEvaluation = buildEvaluation({
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-gold",
      requiredNodeIds: ["node-gold"],
      familyDecision: "join_existing",
      primaryFamilyId: "family-single",
    },
  }, gold, { mode: "singleton" });
  assert.equal(leakedIdEvaluation.primaryFamilyExact, null);
  assert.equal(leakedIdEvaluation.hiddenGoldFamilyIdReturned, true);
  assert.equal(leakedIdEvaluation.modelGeneralizationSuccess, false);

  const draftEvaluation = buildEvaluation({
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-gold",
      requiredNodeIds: ["node-gold"],
      familyDecision: "create_new",
      primaryFamilyId: "",
      candidateFamilyDraft: {
        name: "声韵拼合规律应用",
        coreKnowledgeNodeId: "node-gold",
        requiredKnowledgeNodeIds: ["node-gold"],
        textbookAnchorNodeIds: ["node-anchor"],
        assessmentAction: "运用拼合规律判断音节是否成立",
        inclusionBoundary: "判断声母和韵母是否可以拼合",
        exclusionBoundary: "排除只问音节结构定义的题",
        textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材列明拼合限制。" },
      },
    },
  }, gold, { mode: "singleton" });
  assert.equal(draftEvaluation.candidateFamilyDraft.complete, true);
  assert.equal(draftEvaluation.candidateFamilyDraft.semanticMatch, true);
  assert.equal(draftEvaluation.modelGeneralizationSuccess, true);
});

test("candidate family action scoring uses normalized action semantics instead of lexical similarity alone", () => {
  const expectedFamily = {
    id: "family-action",
    name: "拼合合法性判断",
    knowledgeNodeId: "node-anchor",
    coreKnowledgeNodeId: "node-gold",
    requiredKnowledgeNodeIds: ["node-gold"],
    textbookAnchorNodeIds: ["node-anchor"],
    assessmentAction: "根据拼合规律判断音节能否成立",
    inclusionBoundary: "直接判断拼合结果",
    exclusionBoundary: "排除概念识别",
  };
  const baseDraft = {
    name: "音节成立条件判断",
    coreKnowledgeNodeId: "node-gold",
    requiredKnowledgeNodeIds: ["node-gold"],
    textbookAnchorNodeIds: ["node-anchor"],
    inclusionBoundary: "判断音节拼合是否合法",
    exclusionBoundary: "不含概念名称识别",
    textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材给出拼合条件。" },
  };

  const synonymous = evaluateCandidateFamilyDraft({
    ...baseDraft,
    assessmentAction: "运用拼合限制判定音节是否成立",
  }, expectedFamily);
  assert.equal(synonymous.actionSemantics.predicted.type, "validity_judgement");
  assert.equal(synonymous.actionSemantics.expected.type, "validity_judgement");
  assert.equal(synonymous.actionSemanticMatch, true);
  assert.equal(synonymous.semanticMatch, true);

  const feasibilityExpressions = [
    "判断给定声母、韵母与声调组合是否构成现代汉语可能的音节",
    "判断给定结构能否成立",
    "检验这种组合可不可以形成合规结构",
    "判定给定条件有无可能成立",
  ];
  for (const expression of feasibilityExpressions) {
    const comparison = compareAssessmentActions(expression, "判断普通话音节组合是否合法");
    assert.equal(comparison.predicted.type, "validity_judgement", expression);
    assert.equal(comparison.expected.type, "validity_judgement", expression);
    assert.equal(comparison.match, true, expression);
    assert.equal(comparison.method, "action_taxonomy", expression);
  }

  assert.equal(normalizeAssessmentActionSemantics("判断该说法是否正确").type, "correctness_judgement");
  assert.equal(normalizeAssessmentActionSemantics("识别题干所述概念").type, "concept_recognition");

  const different = evaluateCandidateFamilyDraft({
    ...baseDraft,
    assessmentAction: "概念识别",
  }, { ...expectedFamily, assessmentAction: "合法性判断" });
  assert.equal(normalizeAssessmentActionSemantics("概念辨认").type, "concept_recognition");
  assert.equal(compareAssessmentActions("概念识别", "合法性判断").method, "action_taxonomy");
  assert.equal(different.actionSemantics.predicted.type, "concept_recognition");
  assert.equal(different.actionSemantics.expected.type, "validity_judgement");
  assert.equal(different.actionSemanticMatch, false);
  assert.equal(different.semanticMatch, false);
  assert.equal(different.fieldDifferences.find((item) => item.key === "assessmentAction").status, "different");
});

test("unmatched replay removes exact semantic equivalents and treats family boundaries as optional diagnostics", () => {
  const familyBase = {
    bookId: "book-1",
    status: "confirmed",
    knowledgeNodeId: "node-anchor",
    coreKnowledgeNodeId: "node-gold",
    requiredKnowledgeNodeIds: ["node-gold"],
    textbookAnchorNodeIds: ["node-anchor"],
    assessmentAction: "辨析术语",
  };
  const familyState = {
    families: [
      { ...familyBase, id: "family-gold", name: "术语辨析", members: [{ questionId: "question-target", isPrimary: true }] },
      { ...familyBase, id: "family-equivalent", name: "同义定义", assessmentAction: "识别并辨认术语概念", members: [{ questionId: "question-other", isPrimary: true }] },
      { ...familyBase, id: "family-different", name: "不同动作", assessmentAction: "举例说明", members: [] },
    ],
    familyAliases: {},
    familySetLinks: [],
    historyByBook: {},
  };
  const gold = {
    goldStatus: "confirmed",
    questionId: "question-target",
    primaryNodeId: "node-gold",
    requiredNodeIds: ["node-gold"],
    primaryFamilyId: "family-gold",
    primaryFamilyIndependentMemberCount: 1,
    familyIds: ["family-gold"],
    families: [{ ...familyState.families[0], isPrimary: true }],
    primaryFamily: { ...familyState.families[0], isPrimary: true },
  };
  const plan = buildReplayModePlan("unmatched", gold, familyState);
  assert.deepEqual(new Set(plan.hiddenFamilyIds), new Set(["family-gold", "family-equivalent"]));
  const masked = sanitizeQuestionFamilyState(familyState, ["question-target"], plan);
  assert.deepEqual(masked.families.map((family) => family.id), ["family-different"]);
  const incomplete = evaluateCandidateFamilyDraft({
    name: "术语辨析",
    coreKnowledgeNodeId: "node-gold",
    requiredKnowledgeNodeIds: ["node-gold"],
    textbookAnchorNodeIds: ["node-anchor"],
    assessmentAction: "辨析术语",
    inclusionBoundary: "直接辨析",
    exclusionBoundary: "",
    textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材证据" },
  }, gold.primaryFamily);
  assert.equal(incomplete.fields.exclusionBoundary, false);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.requiredComplete, true);
  assert.equal(incomplete.boundaryComplete, false);
  assert.equal(incomplete.semanticMatch, true);
});

test("auto mode supports a reviewed no-existing-family sample and scores draft completeness without inventing family ID gold", () => {
  const structureState = {
    records: [{
      bookId: "book-1",
      nodes: [{ id: "node-gold", title: "直接知识", path: "章 > 直接知识" }],
      fingerprints: [{
        questionId: "question-target",
        primaryNodeId: "node-gold",
        requiredNodeIds: ["node-gold"],
        status: "needs_review",
      }],
    }],
  };
  const gold = buildGoldStandard(targetQuestion, structureState, { families: [] }, { goldStatus: "gold_needs_review" });
  assert.equal(gold.primaryFamilyId, "");
  assert.equal(gold.goldStatus, "gold_needs_review");
  const plan = buildReplayModePlan("auto", gold, { families: [] });
  assert.equal(plan.mode, "unmatched");
  const evaluation = buildEvaluation({
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-gold",
      requiredNodeIds: ["node-gold"],
      familyDecision: "create_new",
      candidateFamilyDraft: {
        name: "直接知识判断",
        coreKnowledgeNodeId: "node-gold",
        requiredKnowledgeNodeIds: ["node-gold"],
        textbookAnchorNodeIds: ["node-gold"],
        assessmentAction: "判断",
        inclusionBoundary: "直接考查该知识",
        exclusionBoundary: "排除只作背景的题",
        textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材原文支持。" },
      },
    },
  }, gold, { mode: "unmatched" });
  assert.equal(evaluation.candidateFamilyDraft.complete, true);
  assert.equal(evaluation.candidateFamilyDraft.semanticComparable, false);
  assert.equal(evaluation.modelGeneralizationSuccess, true);
  assert.equal(evaluation.countedResult, null);
});

test("unmatched mode remains diagnostic until no-equivalent-family gold is explicitly confirmed", () => {
  const gold = {
    goldStatus: "confirmed",
    primaryNodeId: "node-gold",
    requiredNodeIds: ["node-gold"],
    primaryFamilyId: "",
    familyIds: [],
    primaryFamily: null,
  };
  const result = {
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-gold",
      requiredNodeIds: ["node-gold"],
      familyDecision: "create_new",
      candidateFamilyDraft: {
        name: "直接知识判断",
        coreKnowledgeNodeId: "node-gold",
        requiredKnowledgeNodeIds: ["node-gold"],
        textbookAnchorNodeIds: ["node-gold"],
        assessmentAction: "判断",
        inclusionBoundary: "直接考查",
        exclusionBoundary: "排除背景提及",
        textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材证据" },
      },
    },
  };
  const unreviewed = buildEvaluation(result, gold, { mode: "unmatched" });
  assert.equal(unreviewed.modelGeneralizationSuccess, true);
  assert.equal(unreviewed.includedInAccuracy, false);
  assert.equal(unreviewed.countedResult, null);
  assert.equal(unreviewed.accuracyExclusionReason, "unmatched_gold_unreviewed");

  const confirmed = buildEvaluation(result, gold, { mode: "unmatched", unmatchedGoldStatus: "confirmed" });
  assert.equal(confirmed.includedInAccuracy, true);
  assert.equal(confirmed.countedResult, true);
  assert.equal(confirmed.accuracyExclusionReason, "");
});

test("gold_needs_review keeps diagnostics but is excluded from accuracy", () => {
  const gold = {
    goldStatus: "gold_needs_review",
    primaryNodeId: "node-gold",
    requiredNodeIds: ["node-gold"],
    primaryFamilyId: "family-gold",
    familyIds: ["family-gold"],
  };
  const evaluation = buildEvaluation({
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-gold",
      requiredNodeIds: ["node-gold"],
      familyDecision: "join_existing",
      primaryFamilyId: "family-gold",
      relatedFamilyIds: [],
    },
  }, gold, { mode: "mature" });
  assert.equal(evaluation.coreKnowledgeExact, true);
  assert.equal(evaluation.primaryFamilyExact, true);
  assert.equal(evaluation.includedInAccuracy, false);
  assert.equal(evaluation.countedResult, null);
  assert.equal(evaluation.accuracyExclusionReason, "gold_needs_review");
});

test("provider failures are infrastructure exclusions instead of classification errors", () => {
  const evaluation = buildEvaluation({
    status: "failed",
    error: "provider_timeout",
    agent2Verification: null,
  }, {
    goldStatus: "confirmed",
    primaryNodeId: "node-gold",
    requiredNodeIds: ["node-gold"],
    primaryFamilyId: "family-gold",
    familyIds: ["family-gold"],
  }, {
    mode: "mature",
    job: { status: "failed", error: "knowledge_classification_job_failed" },
  });

  assert.equal(evaluation.executionFailed, true);
  assert.equal(evaluation.executionFailureCode, "provider_timeout");
  assert.equal(evaluation.includedInAccuracy, false);
  assert.equal(evaluation.countedResult, null);
  assert.equal(evaluation.accuracyExclusionReason, "execution_failed/provider_timeout");
  assert.equal(evaluation.assessmentStatus, "unassessed");
});

test("Agent 1 provider timeout with heuristic fallback is excluded even when the job reaches review", () => {
  const evaluation = buildEvaluation({
    status: "pending_review",
    error: "",
    agent1FeatureHandoff: {
      status: "completed",
      source: "heuristic",
      warning: "provider_timeout",
    },
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-predicted",
      requiredNodeIds: ["node-predicted"],
      familyDecision: "unresolved",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      candidateFamilyDraft: null,
    },
  }, {
    goldStatus: "confirmed",
    primaryNodeId: "node-gold",
    requiredNodeIds: ["node-gold"],
    primaryFamilyId: "family-gold",
    familyIds: ["family-gold"],
  }, {
    mode: "singleton",
    job: { status: "completed", error: "" },
    modelTasks: [{
      id: "agent1-timeout-task",
      sceneId: "knowledge_feature_extraction",
      status: "failed",
      errorCode: "provider_timeout",
      failureStage: "knowledge_feature_extraction",
      inputSummary: {
        retryCount: 1,
        firstFailure: "provider_timeout",
      },
    }],
  });

  assert.equal(evaluation.executionFailed, true);
  assert.equal(evaluation.executionFailureCode, "provider_timeout");
  assert.equal(evaluation.assessmentStatus, "unassessed");
  assert.equal(evaluation.includedInAccuracy, false);
  assert.equal(evaluation.countedResult, null);
  assert.equal(evaluation.accuracyExclusionReason, "execution_failed/provider_timeout");
});

test("Agent 3 contract degradation is excluded even when the job reaches review", () => {
  const evaluation = buildEvaluation({
    status: "pending_review",
    error: "",
    agent1FeatureHandoff: {
      status: "completed",
      source: "model",
      warning: "",
    },
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-predicted",
      requiredNodeIds: ["node-predicted"],
      familyDecision: "unresolved",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      candidateFamilyDraft: null,
      agent3ContractStatus: "failed",
      agent3Diagnostics: [{
        contractAttempt: 2,
        status: "degraded",
        errorCode: "agent3_contract_degraded",
      }],
    },
  }, {
    goldStatus: "confirmed",
    primaryNodeId: "node-gold",
    requiredNodeIds: ["node-gold"],
    primaryFamilyId: "family-gold",
    familyIds: ["family-gold"],
  }, {
    mode: "singleton",
    job: { status: "completed", error: "" },
    modelTasks: [],
  });

  assert.equal(evaluation.executionFailed, true);
  assert.equal(evaluation.executionFailureCode, "agent3_contract_failed");
  assert.equal(evaluation.assessmentStatus, "unassessed");
  assert.equal(evaluation.includedInAccuracy, false);
  assert.equal(evaluation.countedResult, null);
  assert.equal(evaluation.accuracyExclusionReason, "execution_failed/agent3_contract_failed");
});

test("blind replay summarizes provider, contract and recovery retries with the first failure", () => {
  const summary = summarizeReplayRetries([{
    id: "task-provider",
    sceneId: "knowledge_feature_extraction",
    startedAt: 1,
    inputSummary: { providerRetryCount: 1, firstFailure: "provider_timeout" },
  }, {
    id: "task-contract-1",
    sceneId: "knowledge_hierarchy_navigation",
    startedAt: 2,
    inputSummary: { questionId: "q1", depth: 1, contractAttempt: 1 },
  }, {
    id: "task-contract-2",
    sceneId: "knowledge_hierarchy_navigation",
    startedAt: 3,
    inputSummary: { questionId: "q1", depth: 1, contractAttempt: 2, priorContractError: "candidate_not_offered" },
  }, {
    id: "task-agent3-primary",
    sceneId: "knowledge_batch_verification",
    startedAt: 4,
    inputSummary: { contractAttempt: 1, attemptKind: "primary" },
  }, {
    id: "task-agent3-repair",
    sceneId: "knowledge_batch_verification",
    startedAt: 5,
    inputSummary: { contractAttempt: 2, attemptKind: "contract_repair", fallbackReason: "family_draft_required" },
  }, {
    id: "task-recovery-fallback",
    sceneId: "knowledge_global_recovery",
    startedAt: 6,
    inputSummary: { attemptIndex: 2, attemptKind: "fallback_scoped", fallbackReason: "primary_timeout" },
  }], {
    agent2NavigationDiagnostics: [
      { depth: 1, contractAttempt: 1, status: "contract_invalid", errorCode: "candidate_not_offered" },
      { depth: 1, contractAttempt: 2, status: "valid", errorCode: "" },
    ],
  });
  assert.equal(summary.providerRetryCount, 1);
  assert.equal(summary.constraintRetryCount, 2);
  assert.equal(summary.fallbackAttemptCount, 1);
  assert.equal(summary.totalRetryCount, 4);
  assert.equal(summary.firstFailureReason, "provider_timeout");
});

test("blind replay report does not fabricate token usage and uses source-answer wording", () => {
  const reportInput = {
    replayId: "replay-1",
    question: { id: "q1", bookId: "book-1", stem: "题干", options: [], correctAnswer: ["A"], answerReviewStatus: "verified", answerSource: "team_verified" },
    gold: { goldStatus: "confirmed", primaryNodePath: "章 > 知识", requiredNodes: [], families: [], primaryFamilyId: "", primaryFamilyIndependentMemberCount: 0 },
    result: { status: "pending_review", agent1Trajectories: [], agent2Verification: { requiredNodeIds: [], relatedFamilyIds: [] } },
    evaluation: {
      includedInAccuracy: true,
      coreKnowledgeExact: false,
      requiredKnowledge: { exact: false, f1: 0, jaccard: 0 },
      primaryFamilyMetricApplicable: false,
      primaryFamilyExact: null,
      familyMemberships: { applicable: false, exact: false, f1: 0, jaccard: 0 },
      candidateFamilyDraft: { complete: false, semanticComparable: false, semanticMatch: null, fields: {}, coreKnowledgeExact: null, actionSimilarity: null },
      unresolved: true,
      modelGeneralizationSuccess: false,
      accuracyExclusionReason: "",
    },
    maskAudit: {
      removedFingerprints: 1, removedFamilyMemberships: 0, removedCases: 0, removedCorrections: 0,
      removedMessages: 0, removedReviewEvents: 0, removedRules: 0, removedFamilyDefinitions: 0,
      removedFamilyAliases: 0, removedFamilySetLinks: 0, removedHistoricalFamilyDefinitions: 0,
    },
    leakageAudit: {
      remainingTargetMemberships: 0, remainingHiddenDefinitions: 0, remainingAliases: 0,
      remainingFamilySetLinks: 0, remainingHistoricalDefinitions: 0, retainedOtherPrimaryMembers: 0,
      candidateContextClean: true,
    },
    isolation: { formalStateUnchanged: true },
    modePlan: { requestedMode: "unmatched", mode: "unmatched" },
    modelTasks: [{ sceneId: "knowledge_batch_verification", model: "model-x", status: "succeeded", usage: null, durationMs: 321 }],
    knowledgeNodes: [],
    questionFamilies: [],
    evidence: [],
  };
  const report = buildMarkdownReport(reportInput);
  assert.match(report, /供应商未返回\/成本不可计算/);
  assert.match(report, /321 ms/);
  assert.match(report, /来源答案\/平台核验答案/);
  assert.doesNotMatch(report, /官方答案/);
  assert.doesNotMatch(report, /\| 0 \| 321 ms \|/);

  const failedReport = buildMarkdownReport({
    ...reportInput,
    result: { status: "failed", error: "provider_timeout", agent1Trajectories: [], agent2Verification: { requiredNodeIds: [], relatedFamilyIds: [] } },
    evaluation: {
      ...reportInput.evaluation,
      includedInAccuracy: false,
      countedResult: null,
      executionFailed: true,
      executionFailureCode: "provider_timeout",
      accuracyExclusionReason: "execution_failed/provider_timeout",
    },
  });
  assert.match(failedReport, /基础设施或供应商执行失败（provider_timeout）/);
  assert.match(failedReport, /评估状态：未评估（技术或执行失败）/);
  assert.match(failedReport, /\| 核心知识 exact \| 未评估 \|/);
  assert.match(failedReport, /不得记作模型分类错误/);
  assert.doesNotMatch(failedReport, /\| 核心知识 exact \| 未通过 \|/);
});

test("gold_needs_review report displays field differences without declaring semantic failure", () => {
  const expectedFamily = {
    id: "family-current",
    name: "旧题族名称",
    knowledgeNodeId: "node-anchor",
    coreKnowledgeNodeId: "node-gold",
    requiredKnowledgeNodeIds: ["node-gold"],
    textbookAnchorNodeIds: ["node-anchor"],
    assessmentAction: "概念识别",
    inclusionBoundary: "识别概念",
    exclusionBoundary: "排除合法性判断",
  };
  const candidateFamilyDraft = {
    name: "成立条件判断",
    coreKnowledgeNodeId: "node-gold",
    requiredKnowledgeNodeIds: ["node-gold"],
    textbookAnchorNodeIds: ["node-anchor"],
    assessmentAction: "合法性判断",
    inclusionBoundary: "判断形式是否合法",
    exclusionBoundary: "排除概念名称识别",
    textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材给出成立条件。" },
  };
  const gold = {
    goldStatus: "gold_needs_review",
    primaryNodeId: "node-gold",
    primaryNodePath: "第一章 > 核心知识",
    requiredNodeIds: ["node-gold"],
    requiredNodes: [{ id: "node-gold", path: "第一章 > 核心知识" }],
    primaryFamilyId: "family-current",
    primaryFamilyIndependentMemberCount: 1,
    familyIds: ["family-current"],
    families: [{ ...expectedFamily, isPrimary: true }],
    primaryFamily: expectedFamily,
  };
  const result = {
    status: "pending_review",
    agent1Trajectories: [],
    agent2Verification: {
      decision: "confirm",
      primaryNodeId: "node-gold",
      requiredNodeIds: ["node-gold"],
      familyDecision: "create_new",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      candidateFamilyDraft,
    },
  };
  const evaluation = buildEvaluation(result, gold, { mode: "singleton" });
  assert.equal(evaluation.candidateFamilyDraft.actionSemanticMatch, false);
  assert.equal(evaluation.includedInAccuracy, false);
  const report = buildMarkdownReport({
    replayId: "replay-gold-review",
    question: { id: "q-review", bookId: "book-1", stem: "题干", options: [], correctAnswer: ["A"], answerReviewStatus: "verified", answerSource: "team_verified" },
    gold,
    result,
    evaluation,
    maskAudit: {
      removedFingerprints: 1, removedFamilyMemberships: 1, removedCases: 0, removedCorrections: 0,
      removedMessages: 0, removedReviewEvents: 0, removedRules: 0, removedFamilyDefinitions: 1,
      removedFamilyAliases: 0, removedFamilySetLinks: 0, removedHistoricalFamilyDefinitions: 0,
    },
    leakageAudit: {
      remainingTargetMemberships: 0, remainingHiddenDefinitions: 0, remainingAliases: 0,
      remainingFamilySetLinks: 0, remainingHistoricalDefinitions: 0, retainedOtherPrimaryMembers: 0,
      candidateContextClean: true,
    },
    isolation: { formalStateUnchanged: true },
    modePlan: { requestedMode: "singleton", mode: "singleton" },
    modelTasks: [],
    knowledgeNodes: [
      { id: "node-gold", path: "第一章 > 核心知识" },
      { id: "node-anchor", path: "第一章 > 教材锚点" },
    ],
    questionFamilies: [{ id: "family-current", name: "旧题族名称" }],
    evidence: [],
  });
  assert.match(report, /候选新题族字段差异 \| 待教研复核/);
  assert.match(report, /### 待复核字段差异/);
  assert.match(report, /\| 考查动作 \| 合法性判断 \| 概念识别 \| 有差异 \|/);
  assert.match(report, /只展示逐字段差异并等待教研复核/);
  assert.doesNotMatch(report, /候选新题族语义 \| 未通过/);
  assert.doesNotMatch(report, /语义未通过/);
});
