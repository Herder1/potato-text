const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createFileKnowledgeClassificationStore,
  createMemoryKnowledgeClassificationStore,
} = require("../apps/api/src/knowledge-classification-store");

const trajectory = {
  terminalNodeId: "method",
  terminalNodeIds: ["method"],
  stopReason: "leaf",
  confidence: 0.88,
  steps: [{
    parentNodeId: "consonant",
    candidateNodeIds: ["method", "place"],
    decision: "node",
    selectedNodeIds: ["method"],
    confidence: 0.88,
    reason: "题目询问发音方法",
    terminal: true,
    terminalNodeIds: ["method"],
    stopReason: "leaf",
  }],
};

const verification = {
  questionId: "q1",
  decision: "confirm",
  primaryNodeId: "method",
  requiredNodeIds: ["method"],
  focusKey: "consonant-method-obstruction",
  focusLabel: "辅音发音方法·阻碍方式",
  action: "分类判断",
  confidence: 0.94,
  reason: "教材正文直接说明阻碍方式",
  uncertainty: "",
  evidenceChunkIds: ["chunk-1"],
  optionRelationAssessments: [{
    key: "A",
    agent1KnowledgeRelation: "option_specific",
    decision: "confirm",
    verifiedKnowledgeNodeIds: ["voice"],
    proposedKnowledgeRelation: "",
    proposedKnowledgeNodeIds: [],
    evidenceChunkIds: ["chunk-1"],
    reason: "独立核验后确认该选项需要清浊音知识。",
  }],
};

test("classification store preserves revisions and staged review results", () => {
  const store = createMemoryKnowledgeClassificationStore();
  const created = store.createJob({
    id: "job-1",
    bookId: "modern-chinese-7-1",
    questionIds: ["q1", "q2", "q1"],
    baseQuestionVersions: { q1: 3, q2: 7, ignored: 9 },
    baseKnowledgeRevision: 101,
    knowledgeRevisionFormat: "topology-v1",
    baseFamilyRevision: 202,
    textbookKnowledgeVersion: 12,
  });

  assert.equal(created.job.total, 2);
  assert.deepEqual(created.job.baseQuestionVersions, { q1: 3, q2: 7 });
  assert.equal(created.results.length, 2);
  const result = store.resultForQuestion("job-1", "q1");
  assert.equal(result.baseQuestionVersion, 3);
  assert.equal(result.baseKnowledgeRevision, 101);
  assert.equal(result.knowledgeRevisionFormat, "topology-v1");
  assert.equal(result.baseFamilyRevision, 202);
  assert.equal(result.textbookKnowledgeVersion, 12);

  const afterAgent1 = store.saveAgent1(result.id, [trajectory]);
  assert.equal(afterAgent1.status, "processing");
  assert.equal(afterAgent1.agent1Status, "completed");
  assert.equal(afterAgent1.agent1Trajectories[0].terminalNodeId, "method");

  const afterAgent2 = store.saveAgent2(result.id, verification);
  assert.equal(afterAgent2.status, "pending_review");
  assert.equal(afterAgent2.agent2Verification.focusKey, "consonant-method-obstruction");
  assert.deepEqual(afterAgent2.agent2Verification.optionRelationAssessments[0].verifiedKnowledgeNodeIds, ["voice"]);

  const applied = store.applyResult(result.id, "reviewer", "教材证据充分", {
    primaryNodeId: "method",
    requiredNodeIds: ["method", "place", "method"],
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.reviewStatus, "applied");
  assert.equal(applied.reviewedBy, "reviewer");
  assert.deepEqual(applied.reviewSelection, {
    primaryNodeId: "method",
    primaryNodeRole: "core",
    requiredNodeIds: ["method", "place"],
    problemKnowledgeRangeNodeIds: ["method", "place"],
    knowledgeThemeRangeAnchorNodeId: "",
    scopeAnchorNodeId: "",
  });
  assert.ok(applied.appliedAt > 0);
  assert.throws(() => store.applyResult(result.id), /not_reviewable/);

  const rejected = store.rejectResult(store.resultForQuestion("job-1", "q2").id, "reviewer", "无法确定");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reviewStatus, "rejected");
});

test("Agent 1 feature handoff is persisted before navigation and cannot be overwritten by Agent 2", () => {
  const store = createMemoryKnowledgeClassificationStore();
  const { results } = store.createJob({ bookId: "book", questionIds: ["q-feature"] });
  const features = {
    questionMode: "option_judgement",
    stemKeywords: ["正确的是"],
    coreKeywords: ["辅音发音方法"],
    primaryKnowledgeHints: ["阻碍方式"],
    optionFeatures: [{
      key: "A",
      text: "塞音",
      knowledgeHints: ["阻碍方式"],
      isCorrect: true,
      role: "answer",
      weight: 0.4,
      decisionRole: "supports_answer",
      requiredForDecision: true,
      basis: "直接验证答案",
    }],
    dependencySteps: [{ order: 1, label: "判断阻碍方式", source: "stem", necessity: "core" }],
    primaryBasis: "题干直接询问辅音发音方法。",
    extractionSource: "model",
  };

  const handedOff = store.saveAgent1Features(results[0].id, features, {
    source: "model",
    configuredSceneId: "knowledge_hierarchy_navigation",
    model: "classification-model",
  });
  assert.equal(handedOff.agent1FeatureHandoff.status, "completed");
  assert.equal(handedOff.agent1FeatureHandoff.sceneId, "knowledge_feature_extraction");
  assert.equal(handedOff.agent1FeatureHandoff.configuredSceneId, "knowledge_hierarchy_navigation");
  assert.deepEqual(handedOff.agent1FeatureHandoff.features, handedOff.agent1Features);

  const afterNavigation = store.saveAgent1(results[0].id, [trajectory], "completed", {
    features: { stemKeywords: ["不得覆盖"] },
  });
  assert.deepEqual(afterNavigation.agent1Features, handedOff.agent1Features);
  assert.deepEqual(afterNavigation.agent1FeatureHandoff, handedOff.agent1FeatureHandoff);
});

test("classification store persists Agent 2 auxiliary gaps and contract diagnostics", () => {
  const store = createMemoryKnowledgeClassificationStore();
  const { results } = store.createJob({ bookId: "book", questionIds: ["q-contract"] });
  const gapTrajectory = {
    ...trajectory,
    steps: trajectory.steps.map((step) => ({
      ...step,
      corePathStatus: "core_path_viable",
      auxiliaryGap: {
        type: "auxiliary_gap",
        dependencyStepRefs: ["dep-2"],
        dependencies: [{ ref: "dep-2", label: "气流强弱", nodeIds: ["airflow"], necessity: "secondary" }],
        reason: "辅助排除依赖不在当前分支。",
      },
      candidateRejections: [],
    })),
  };
  const updated = store.saveAgent1(results[0].id, [gapTrajectory], "completed", {
    classificationOutcome: "auxiliary_gap",
    navigationDiagnostics: [{
      depth: 1,
      parentNodeId: "consonant",
      candidateNodeIds: ["method", "place"],
      contractAttempt: 2,
      taskId: "task-2",
      retryOfTaskId: "task-1",
      status: "valid",
      rawOutput: "{\"decision\":\"node\"}",
      parsedOutput: { decision: "node" },
    }],
  });
  assert.equal(updated.classificationOutcome, "auxiliary_gap");
  assert.equal(updated.agent1Trajectories[0].steps[0].auxiliaryGap.dependencies[0].label, "气流强弱");
  assert.equal(updated.agent2NavigationDiagnostics[0].contractAttempt, 2);
  assert.equal(updated.agent2NavigationDiagnostics[0].retryOfTaskId, "task-1");
});

test("file classification store persists and recovers interrupted work", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-classification-"));
  const filePath = path.join(directory, "classification.json");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = createFileKnowledgeClassificationStore(filePath, { recoverInterrupted: false });
  const created = first.createJob({
    id: "running-job",
    bookId: "book-1",
    questionIds: ["q1", "q2"],
    baseQuestionVersions: { q1: 1, q2: 2 },
    baseKnowledgeRevision: 55,
    baseFamilyRevision: 66,
    textbookKnowledgeVersion: 4,
  });
  first.updateJob(created.job.id, { status: "running", stage: "agent1", startedAt: Date.now() });
  first.updateResult(created.results[0].id, { status: "processing", agent1Status: "running" });
  const reviewed = first.createJob({
    id: "reviewed-job",
    bookId: "book-1",
    questionIds: ["q3"],
    baseQuestionVersions: { q3: 1 },
  });
  first.saveAgent1(reviewed.results[0].id, [trajectory]);
  first.saveAgent2(reviewed.results[0].id, { ...verification, questionId: "q3" });
  first.applyResult(reviewed.results[0].id, "reviewer", "人工取舍", {
    primaryNodeId: "method",
    requiredNodeIds: ["method", "place"],
  });

  const recovered = createFileKnowledgeClassificationStore(filePath);
  assert.equal(recovered.getJob("running-job").status, "interrupted");
  assert.equal(recovered.getJob("running-job").stage, "interrupted");
  assert.equal(recovered.getResult(created.results[0].id).status, "interrupted");
  assert.equal(recovered.getResult(created.results[0].id).agent1Status, "interrupted");
  assert.equal(recovered.getResult(created.results[1].id).status, "interrupted");
  assert.deepEqual(recovered.getResult(reviewed.results[0].id).reviewSelection, {
    primaryNodeId: "method",
    primaryNodeRole: "core",
    requiredNodeIds: ["method", "place"],
    problemKnowledgeRangeNodeIds: ["method", "place"],
    knowledgeThemeRangeAnchorNodeId: "",
    scopeAnchorNodeId: "",
  });

  const reopened = createFileKnowledgeClassificationStore(filePath);
  assert.equal(reopened.getJob("running-job").baseFamilyRevision, 66);
  assert.equal(reopened.results({ jobId: "running-job" }).length, 2);
});

test("classification store validates job and review transitions", () => {
  const store = createMemoryKnowledgeClassificationStore();
  assert.throws(() => store.createJob({ questionIds: ["q1"] }), /book_required/);
  assert.throws(() => store.createJob({ bookId: "book" }), /questions_required/);
  const { results } = store.createJob({ bookId: "book", questionIds: ["q1"] });
  assert.throws(() => store.applyResult(results[0].id), /not_reviewable/);
  assert.throws(() => store.saveAgent1(results[0].id, [], "running"), /agent1_status_invalid/);
  assert.throws(() => store.saveAgent2(results[0].id, null, "pending"), /agent2_status_invalid/);
});

test("classification store persists valid scope anchors and rejects anchor coverage", () => {
  const store = createMemoryKnowledgeClassificationStore();
  const { results } = store.createJob({ bookId: "book", questionIds: ["q-scope", "q-invalid", "q-selection"] });
  results.forEach((result) => store.saveAgent1(result.id, [trajectory]));

  const scopeVerification = {
    ...verification,
    questionId: "q-scope",
    primaryNodeId: "method",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["place"],
  };
  const pending = store.saveAgent2(results[0].id, scopeVerification);
  assert.equal(pending.agent2Verification.primaryNodeRole, "scope_anchor");
  assert.deepEqual(pending.agent2Verification.requiredNodeIds, ["place"]);
  const applied = store.applyResult(results[0].id, "reviewer", "确认范围锚点", {
    primaryNodeId: "method",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["place"],
  });
  assert.deepEqual(applied.reviewSelection, {
    primaryNodeId: "method",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["place"],
    problemKnowledgeRangeNodeIds: ["place"],
    knowledgeThemeRangeAnchorNodeId: "method",
    scopeAnchorNodeId: "method",
  });

  assert.throws(() => store.saveAgent2(results[1].id, {
    ...scopeVerification,
    questionId: "q-invalid",
    requiredNodeIds: ["method", "place"],
  }), /knowledge_classification_agent2_verification_invalid/);

  store.saveAgent2(results[2].id, { ...verification, questionId: "q-selection" });
  assert.throws(() => store.applyResult(results[2].id, "reviewer", "", {
    primaryNodeId: "method",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["method"],
  }), /knowledge_classification_review_selection_invalid/);
});

test("classification store preserves an unconfirmed candidate family and its explicit human decision", () => {
  const store = createMemoryKnowledgeClassificationStore();
  const { results } = store.createJob({ bookId: "book", questionIds: ["q-candidate"] });
  store.saveAgent1(results[0].id, [trajectory]);
  const candidateFamilyDraft = {
    name: "发音方法综合辨析",
    coreKnowledgeNodeId: "method",
    requiredKnowledgeNodeIds: ["method", "place"],
    textbookAnchorNodeIds: ["method"],
    assessmentAction: "综合判断",
    inclusionBoundary: "需要同时判断两个维度。",
    exclusionBoundary: "单一维度题不纳入。",
    textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材证据" },
  };
  const pending = store.saveAgent2(results[0].id, {
    ...verification,
    questionId: "q-candidate",
    requiredNodeIds: ["method", "place"],
    familyDecision: "create_new",
    candidateFamilyDraft,
  });
  assert.equal(pending.agent2Verification.candidateFamilyDraft.name, candidateFamilyDraft.name);
  assert.equal(store.applyResult(results[0].id, "reviewer", "", {
    primaryNodeId: "method",
    requiredNodeIds: ["method", "place"],
    createCandidateFamily: true,
    candidateFamilyDraft,
  }).reviewSelection.createCandidateFamily, true);
});

test("legacy related families cannot bypass the deletion-test policy", () => {
  const store = createMemoryKnowledgeClassificationStore();
  const { results } = store.createJob({ bookId: "book", questionIds: ["q-legacy-related"] });
  store.saveAgent1(results[0].id, [trajectory]);

  const pending = store.saveAgent2(results[0].id, {
    ...verification,
    questionId: "q-legacy-related",
    primaryFamilyId: "family-primary",
    relatedFamilyIds: ["family-primary", "family-passed", "family-unchecked"],
    relatedFamilyAssessments: [{
      familyId: "family-passed",
      necessaryAfterDeletionTest: true,
      deletionTest: "去掉该题族对应能力后无法排除关键干扰项。",
      reason: "该能力参与最终判断。",
      accepted: false,
    }, {
      familyId: "family-failed",
      necessaryAfterDeletionTest: false,
      deletionTest: "去掉后仍可作答。",
      reason: "只属于背景知识。",
      accepted: true,
    }],
    matchedFamilyIds: ["family-primary"],
  });

  assert.deepEqual(pending.agent2Verification.relatedFamilyIds, ["family-passed"]);
  assert.deepEqual(pending.agent2Verification.matchedFamilyIds, [
    "family-primary",
    "family-unchecked",
    "family-failed",
  ]);
  assert.equal(pending.agent2Verification.relatedFamilyAssessments
    .find((item) => item.familyId === "family-passed").accepted, true);
  assert.match(pending.agent2Verification.relatedFamilyAssessments
    .find((item) => item.familyId === "family-unchecked").reason, /未提供逐题删除检验/);
  assert.equal(pending.agent2Verification.relatedFamilyAssessments
    .find((item) => item.familyId === "family-failed").accepted, false);
});

test("classification store preserves previous-level correction trajectories", () => {
  const store = createMemoryKnowledgeClassificationStore();
  const { results } = store.createJob({ bookId: "book", questionIds: ["q1"] });
  const updated = store.saveAgent1(results[0].id, [{
    terminalNodeIds: [],
    stopReason: "previous_level_wrong",
    confidence: 0.7,
    steps: [{
      parentNodeId: "method",
      candidateNodeIds: ["voice", "airflow"],
      decision: "previous_level_wrong",
      selectedNodeIds: [],
      confidence: 0.7,
      reason: "上一层分支选择错误",
      terminal: true,
      terminalNodeIds: [],
      stopReason: "previous_level_wrong",
    }],
  }], "uncertain");
  assert.equal(updated.agent1Trajectories[0].stopReason, "previous_level_wrong");
  assert.equal(updated.agent1Trajectories[0].steps[0].decision, "previous_level_wrong");
});

test("classification store persists live Agent progress fields", () => {
  const store = createMemoryKnowledgeClassificationStore();
  const { job } = store.createJob({ bookId: "book", questionIds: ["q1", "q2"] });
  const updated = store.updateJob(job.id, {
    status: "running",
    stage: "pipeline",
    agent1Processed: 1,
    agent2Processed: 1,
    agent2Queued: 1,
    reviewReady: 1,
    agent1CurrentQuestionId: "q2",
    agent1CurrentQuestionIndex: 2,
    agent1CurrentDepth: 4,
    agent2CurrentQuestionId: "q1",
    agent2CurrentQuestionIndex: 1,
    currentQuestionIndex: 2,
    currentDepth: 4,
    progressMessage: "正在分析第 2/2 题 · 第 4 层候选",
  });
  assert.equal(updated.stage, "pipeline");
  assert.equal(updated.agent1Processed, 1);
  assert.equal(updated.agent2Processed, 1);
  assert.equal(updated.agent2Queued, 1);
  assert.equal(updated.reviewReady, 1);
  assert.equal(updated.agent1CurrentQuestionId, "q2");
  assert.equal(updated.agent1CurrentDepth, 4);
  assert.equal(updated.agent2CurrentQuestionId, "q1");
  assert.equal(updated.currentQuestionIndex, 2);
  assert.equal(updated.currentDepth, 4);
  assert.match(updated.progressMessage, /第 4 层候选/);
});

test("classification store keeps all three verification layers for later audit", () => {
  // 逐层留痕：① 模型原始输出（agent3Diagnostics.rawOutput）② 合同校验后的结果（familyActionRisk
  // 等校验期字段）③ 最终采用结果（familyDecision / primaryFamilyId / familyMemberships）。
  const store = createMemoryKnowledgeClassificationStore();
  store.createJob({
    id: "job-layers",
    bookId: "modern-chinese-7-1",
    questionIds: ["q1"],
    baseQuestionVersions: { q1: 1 },
    baseKnowledgeRevision: 1,
    knowledgeRevisionFamily: "topology-v1",
    baseFamilyRevision: 1,
    textbookKnowledgeVersion: 1,
  });
  const result = store.resultForQuestion("job-layers", "q1");
  store.saveAgent2(result.id, {
    ...verification,
    primaryNodeRole: "core",
    familyDecision: "join_existing",
    primaryFamilyId: "family-voice",
    familyMemberships: [{
      familyId: "family-voice",
      isPrimary: true,
      coverageRole: "required",
      contributionKnowledgeNodeIds: ["method"],
    }],
    // ② 合同校验期产出：考查动作不一致只作风险提示
    familyActionRisk: {
      code: "family_action_mismatch",
      familyId: "family-voice",
      familyAction: "概念识别",
      predicted: { type: "classification", label: "分类/归类", normalizedText: "分类判断" },
      expected: { type: "concept_recognition", label: "概念/术语识别", normalizedText: "概念识别" },
      method: "action_taxonomy",
      similarity: 0.25,
    },
    // ① 模型原始输出
    agent3Diagnostics: [{
      contractAttempt: 1,
      taskId: "task-1",
      status: "valid",
      errorCode: "",
      rawOutput: "{\"questionId\":\"q1\",\"familyDecision\":\"join_existing\"}",
      parsedOutput: { questionId: "q1", familyDecision: "join_existing" },
      createdAt: 1,
    }],
    agent3ContractStatus: "valid",
  }, "completed");

  const saved = store.resultForQuestion("job-layers", "q1").agent2Verification;
  // ① 模型原始输出
  assert.equal(saved.agent3Diagnostics.length, 1);
  assert.match(saved.agent3Diagnostics[0].rawOutput, /join_existing/);
  assert.equal(saved.agent3Diagnostics[0].parsedOutput.questionId, "q1");
  // ② 合同校验后的结果（风险字段必须落库可见）
  assert.equal(saved.familyActionRisk.code, "family_action_mismatch");
  assert.equal(saved.familyActionRisk.expected.type, "concept_recognition");
  assert.equal(saved.familyActionRisk.predicted.type, "classification");
  assert.equal(saved.familyActionRisk.method, "action_taxonomy");
  // ③ 最终采用结果
  assert.equal(saved.familyDecision, "join_existing");
  assert.equal(saved.primaryFamilyId, "family-voice");
  assert.equal(saved.familyMemberships[0].familyId, "family-voice");
  // 没有风险时必须为空，不能凭空造出风险
  const clean = store.resultForQuestion("job-layers", "q1");
  store.saveAgent2(clean.id, { ...verification, primaryNodeRole: "core" }, "completed");
  assert.equal(store.resultForQuestion("job-layers", "q1").agent2Verification.familyActionRisk, null);
});
