const assert = require("node:assert/strict");
const test = require("node:test");
const {
  batchByTerminalNode,
  buildCandidateRound,
  buildHierarchyIndex,
  buildKnowledgeAdjacency,
  controlOptionAvailability,
  directChildCandidates,
  groupForVerification,
  normalizeBatchVerification,
  normalizeAgent1Output,
  normalizeAgent1Trajectory,
  normalizeAgent2NavigationOutput,
  isAgent2NavigationContractError,
  isAgent3ContractError,
  normalizeAgent2Output,
  normalizeGlobalRecoveryOutput,
  normalizeNavigationDecision,
  normalizeOptionRelationAssessments,
  validateAgent3VerificationContract,
} = require("../apps/api/src/knowledge-classification-pipeline");

const nodes = [
  { id: "chapter-a", parentId: "", kind: "chapter", title: "第一章", order: 1 },
  { id: "chapter-b", parentId: "", kind: "chapter", title: "第二章", order: 2 },
  { id: "section", parentId: "chapter-a", kind: "section", title: "辅音", order: 1 },
  { id: "method", parentId: "section", kind: "knowledge", title: "发音方法", order: 1 },
  { id: "place", parentId: "section", kind: "knowledge", title: "发音部位", order: 2 },
  { id: "voice", parentId: "method", kind: "knowledge", title: "声带振动", order: 1 },
  { id: "airflow", parentId: "method", kind: "knowledge", title: "气流强弱", order: 2 },
  { id: "obstruction", parentId: "method", kind: "knowledge", title: "阻碍方式", order: 3 },
  { id: "extra-1", parentId: "method", kind: "knowledge", title: "其他一", order: 4 },
  { id: "extra-2", parentId: "method", kind: "knowledge", title: "其他二", order: 5 },
  { id: "extra-3", parentId: "method", kind: "knowledge", title: "其他三", order: 6 },
];

test("adjacency returns at most five ranked direct children", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const candidates = directChildCandidates(adjacency, "method", {
    scores: { "extra-3": 0.95, voice: 0.8 },
    limit: 99,
  });
  assert.equal(candidates.length, 5);
  assert.equal(candidates[0].id, "extra-3");
  assert.equal(candidates[1].id, "voice");
  assert.equal(candidates.every((node) => node.parentId === "method"), true);
  assert.deepEqual(controlOptionAvailability(adjacency, "method", candidates.map((node) => node.id)), {
    stay: true,
    multiple: true,
    unable: true,
    none_of_candidates: true,
    previous_level_wrong: true,
  });
  assert.equal(controlOptionAvailability(adjacency, "section", ["method"]).stay, false);
  assert.equal(controlOptionAvailability(adjacency, "", ["chapter-a"]).previous_level_wrong, false);
});

test("server-facing pipeline aliases expose the agreed contract", () => {
  const hierarchy = buildHierarchyIndex(nodes);
  const round = buildCandidateRound(hierarchy, "section");
  assert.deepEqual(round.candidateNodeIds, ["method", "place"]);
  assert.equal(round.controlOptions.previous_level_wrong, true);
  const decision = normalizeNavigationDecision({
    questionId: "alias-question",
    decision: "node",
    selectedNodeIds: ["place"],
    confidence: 0.9,
  }, {
    adjacency: hierarchy,
    questionId: "alias-question",
    currentNodeId: "section",
    candidateNodeIds: round.candidateNodeIds,
  });
  assert.equal(decision.stopReason, "leaf");
  assert.equal(groupForVerification([{ questionId: "alias-question", trajectories: [{ terminalNodeIds: ["place"] }] }]).batches.length, 1);
  const verification = normalizeBatchVerification({ verifications: [{
    questionId: "alias-question",
    decision: "confirm",
    primaryNodeId: "place",
    requiredNodeIds: ["place"],
    focusKey: "place",
    focusLabel: "发音部位",
    action: "分类判断",
    confidence: 0.9,
  }] }, {
    adjacency: hierarchy,
    questionIds: ["alias-question"],
    terminalNodeIdsByQuestion: { "alias-question": ["place"] },
  });
  assert.equal(verification.verifications[0].primaryNodeId, "place");
});

test("Agent 1 normalization enforces options and tree relationships", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const candidates = ["voice", "airflow", "obstruction", "extra-1", "extra-2"];
  const selected = normalizeAgent1Output({
    questionId: "q1",
    decision: "node",
    selectedNodeIds: ["voice"],
    confidence: 0.91,
    reason: "考查清浊音",
  }, { adjacency, questionId: "q1", currentNodeId: "method", candidateNodeIds: candidates });
  assert.equal(selected.terminal, true);
  assert.deepEqual(selected.terminalNodeIds, ["voice"]);
  assert.equal(selected.stopReason, "leaf");

  const stayed = normalizeAgent1Output({ questionId: "q1", decision: "stay", selectedNodeIds: [], confidence: 0.6 }, {
    adjacency, questionId: "q1", currentNodeId: "method", candidateNodeIds: candidates,
  });
  assert.deepEqual(stayed.terminalNodeIds, ["method"]);
  assert.throws(() => normalizeAgent1Output({ questionId: "q1", decision: "stay", selectedNodeIds: [], confidence: 0.6 }, {
    adjacency, questionId: "q1", currentNodeId: "section", candidateNodeIds: ["method", "place"],
  }), /stay_invalid/);
  assert.throws(() => normalizeAgent1Output({ questionId: "q1", decision: "node", selectedNodeIds: ["place"], confidence: 0.6 }, {
    adjacency, questionId: "q1", currentNodeId: "method", candidateNodeIds: candidates,
  }), /outside_candidates/);
  assert.throws(() => normalizeAgent1Output({ questionId: "q1", decision: "multiple", selectedNodeIds: ["voice"], confidence: 0.6 }, {
    adjacency, questionId: "q1", currentNodeId: "method", candidateNodeIds: candidates,
  }), /multiple_selection_invalid/);

  const wrongLevel = normalizeAgent1Output({
    questionId: "q1", decision: "previous_level_wrong", selectedNodeIds: [], confidence: 0.72, reason: "当前分支不包含考点",
  }, { adjacency, questionId: "q1", currentNodeId: "method", candidateNodeIds: candidates });
  assert.equal(wrongLevel.terminal, true);
  assert.equal(wrongLevel.stopReason, "previous_level_wrong");
  assert.deepEqual(wrongLevel.terminalNodeIds, []);
  assert.throws(() => normalizeAgent1Output({
    questionId: "q1", decision: "previous_level_wrong", selectedNodeIds: [], confidence: 0.6,
  }, { adjacency, questionId: "q1", currentNodeId: "", candidateNodeIds: ["chapter-a", "chapter-b"] }), /previous_level_invalid/);
});

test("Agent 1 trajectory must follow selected branches and stop", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const trajectory = normalizeAgent1Trajectory({
    questionId: "q1",
    steps: [
      { questionId: "q1", candidateNodeIds: ["chapter-a", "chapter-b"], decision: "node", selectedNodeIds: ["chapter-a"], confidence: 0.95 },
      { questionId: "q1", candidateNodeIds: ["section"], decision: "node", selectedNodeIds: ["section"], confidence: 0.92 },
      { questionId: "q1", candidateNodeIds: ["method", "place"], decision: "node", selectedNodeIds: ["method"], confidence: 0.9 },
      { questionId: "q1", candidateNodeIds: ["voice", "airflow", "obstruction"], decision: "node", selectedNodeIds: ["obstruction"], confidence: 0.88 },
    ],
    terminalNodeId: "obstruction",
    stopReason: "leaf",
  }, { adjacency, questionId: "q1" });
  assert.equal(trajectory.terminalNodeId, "obstruction");
  assert.equal(trajectory.confidence, 0.88);
  assert.equal(trajectory.steps.length, 4);

  assert.throws(() => normalizeAgent1Trajectory({
    questionId: "q1",
    steps: [{ questionId: "q1", candidateNodeIds: ["chapter-a"], decision: "node", selectedNodeIds: ["chapter-a"], confidence: 0.8 }],
  }, { adjacency, questionId: "q1" }), /trajectory_incomplete/);
});

test("Agent 2 keeps a viable core path while handing an auxiliary gap to Agent 3", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const normalized = normalizeAgent2NavigationOutput({
    questionId: "q-gap",
    decision: "node",
    selectedNodeIds: ["voice"],
    corePathStatus: "core_path_viable",
    auxiliaryGap: {
      type: "auxiliary_gap",
      dependencyStepRefs: ["dep-2"],
      reason: "气流强弱是辅助排除依赖，但不应阻断声带振动的核心路径。",
    },
    candidateRejections: [],
    confidence: 0.86,
    reason: "核心考查仍由声带振动承载。",
  }, {
    adjacency,
    questionId: "q-gap",
    currentNodeId: "method",
    candidateNodeIds: ["voice", "airflow", "obstruction"],
    dependencySteps: [
      { ref: "dep-1", label: "声带振动", necessity: "core", nodeIds: ["voice"] },
      { ref: "dep-2", label: "气流强弱", necessity: "secondary", nodeIds: ["airflow"] },
    ],
  });
  assert.equal(normalized.decision, "node");
  assert.equal(normalized.corePathStatus, "core_path_viable");
  assert.deepEqual(normalized.auxiliaryGap.dependencyStepRefs, ["dep-2"]);
  assert.throws(() => normalizeAgent2NavigationOutput({
    questionId: "q-gap",
    decision: "none_of_candidates",
    selectedNodeIds: [],
    corePathStatus: "core_path_viable",
    auxiliaryGap: null,
    candidateRejections: [
      { nodeId: "voice", reason: "x" },
      { nodeId: "airflow", reason: "x" },
      { nodeId: "obstruction", reason: "x" },
    ],
    confidence: 0.5,
    reason: "错误地放弃核心路径。",
  }, {
    adjacency,
    questionId: "q-gap",
    currentNodeId: "method",
    candidateNodeIds: ["voice", "airflow", "obstruction"],
    dependencySteps: [],
  }), (error) => isAgent2NavigationContractError(error) && /core_path_conflict/.test(error.message));
});

test("Agent 2 none-of-candidates must reject every offered candidate", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const context = {
    adjacency,
    questionId: "q-none",
    currentNodeId: "method",
    candidateNodeIds: ["voice", "airflow", "obstruction"],
    dependencySteps: [],
  };
  assert.throws(() => normalizeAgent2NavigationOutput({
    questionId: "q-none",
    decision: "none_of_candidates",
    selectedNodeIds: [],
    corePathStatus: "core_path_not_viable",
    auxiliaryGap: null,
    candidateRejections: [{ nodeId: "voice", reason: "不是核心考查" }],
    confidence: 0.7,
    reason: "当前分支不合适。",
  }, context), /candidate_rejections_invalid/);
  const accepted = normalizeAgent2NavigationOutput({
    questionId: "q-none",
    decision: "none_of_candidates",
    selectedNodeIds: [],
    corePathStatus: "core_path_not_viable",
    auxiliaryGap: null,
    candidateRejections: context.candidateNodeIds.map((nodeId) => ({ nodeId, reason: "不能承载核心考查" })),
    confidence: 0.7,
    reason: "当前分支不合适。",
  }, context);
  assert.equal(accepted.stopReason, "none_of_candidates");
});

test("terminal grouping batches resolved questions and keeps uncertain ones aside", () => {
  const source = Array.from({ length: 12 }, (_, index) => ({
    questionId: `q${index + 1}`,
    agent1Trajectories: [{ terminalNodeId: "voice", terminalNodeIds: ["voice"] }],
  }));
  source.push({ questionId: "uncertain", agent1Trajectories: [{ terminalNodeIds: [], stopReason: "unable" }] });
  const grouped = batchByTerminalNode(source, { batchSize: 5 });
  assert.deepEqual(grouped.batches.map((batch) => batch.questionIds.length), [5, 5, 2]);
  assert.deepEqual(grouped.batches[0].terminalNodeIds, ["voice"]);
  assert.deepEqual(grouped.unresolvedQuestionIds, ["uncertain"]);
});

test("Agent 2 normalization validates complete batches, moves and cross-knowledge output", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const normalized = normalizeAgent2Output({
    verifications: [
      {
        questionId: "q1",
        decision: "confirm",
        primaryNodeId: "voice",
        requiredNodeIds: ["voice"],
        focusKey: "voicing",
        focusLabel: "声带振动",
        action: "分类判断",
        confidence: 0.94,
        reason: "教材明确区分清浊音",
        evidenceChunkIds: ["chunk-1"],
      },
      {
        questionId: "q2",
        decision: "cross_knowledge",
        primaryNodeId: "voice",
        requiredNodeIds: ["voice", "airflow"],
        focusKey: "combined",
        focusLabel: "发音方法综合判断",
        action: "综合判断",
        confidence: 0.87,
        reason: "同时需要声带和气流维度",
        evidenceChunkIds: ["chunk-2"],
      },
    ],
  }, {
    adjacency,
    questionIds: ["q1", "q2"],
    terminalNodeIdsByQuestion: { q1: ["voice"], q2: ["voice"] },
    evidenceChunkIdsByQuestion: { q1: ["chunk-1"], q2: ["chunk-2", "chunk-3"] },
  });
  assert.equal(normalized.verifications[0].decision, "confirm");
  assert.deepEqual(normalized.verifications[1].requiredNodeIds, ["voice", "airflow"]);

  const moved = normalizeAgent2Output({ verifications: [{
    questionId: "q3",
    decision: "move_sibling",
    primaryNodeId: "airflow",
    requiredNodeIds: ["airflow"],
    focusKey: "airflow",
    focusLabel: "气流强弱",
    action: "分类判断",
    confidence: 0.8,
  }] }, {
    adjacency,
    questionIds: ["q3"],
    terminalNodeIdsByQuestion: { q3: ["voice"] },
  });
  assert.equal(moved.verifications[0].primaryNodeId, "airflow");

  assert.throws(() => normalizeAgent2Output({ verifications: [] }, {
    adjacency, questionIds: ["q1"], terminalNodeIdsByQuestion: { q1: ["voice"] },
  }), /result_count_mismatch/);
  assert.throws(() => normalizeAgent2Output({ verifications: [{
    questionId: "q1", decision: "confirm", primaryNodeId: "airflow", requiredNodeIds: ["airflow"],
    focusKey: "x", focusLabel: "x", action: "x", confidence: 0.8,
  }] }, {
    adjacency, questionIds: ["q1"], terminalNodeIdsByQuestion: { q1: ["voice"] },
  }), /confirm_mismatch/);
  assert.throws(() => normalizeAgent2Output({ verifications: [{
    questionId: "q1", decision: "confirm", primaryNodeId: "voice", requiredNodeIds: ["voice"],
    focusKey: "x", focusLabel: "x", action: "x", confidence: 0.8, evidenceChunkIds: ["invented"],
  }] }, {
    adjacency, questionIds: ["q1"], terminalNodeIdsByQuestion: { q1: ["voice"] }, evidenceChunkIdsByQuestion: { q1: ["chunk-1"] },
  }), /evidence_invalid/);
});

test("scope-anchor verification excludes the anchor itself and remains a constrained-retry error", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const accepted = normalizeAgent2Output({ verifications: [{
    questionId: "q-scope",
    decision: "confirm",
    primaryNodeId: "method",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["voice"],
    focusKey: "method-scope",
    focusLabel: "发音方法范围",
    action: "分类判断",
    confidence: 0.9,
  }] }, {
    adjacency,
    questionIds: ["q-scope"],
    terminalNodeIdsByQuestion: { "q-scope": ["method"] },
  });
  assert.equal(accepted.verifications[0].primaryNodeRole, "scope_anchor");
  assert.deepEqual(accepted.verifications[0].requiredNodeIds, ["voice"]);

  let contractError;
  try {
    normalizeAgent2Output({ verifications: [{
      questionId: "q-scope",
      decision: "cross_knowledge",
      primaryNodeId: "method",
      primaryNodeRole: "scope_anchor",
      requiredNodeIds: ["method", "voice"],
      focusKey: "method-scope",
      focusLabel: "发音方法范围",
      action: "分类判断",
      confidence: 0.9,
    }] }, {
      adjacency,
      questionIds: ["q-scope"],
      terminalNodeIdsByQuestion: { "q-scope": ["method"] },
    });
  } catch (error) {
    contractError = error;
  }
  assert.equal(contractError?.message, "knowledge_classification_agent2_scope_anchor_invalid");
  assert.equal(isAgent3ContractError(contractError), true);

  assert.throws(() => normalizeAgent2Output({ verifications: [{
    questionId: "q-scope",
    decision: "confirm",
    primaryNodeId: "voice",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["airflow"],
    focusKey: "invalid-scope",
    focusLabel: "非法范围",
    action: "分类判断",
    confidence: 0.8,
  }] }, {
    adjacency,
    questionIds: ["q-scope"],
    terminalNodeIdsByQuestion: { "q-scope": ["voice"] },
  }), /knowledge_classification_agent2_scope_anchor_invalid/);

  assert.throws(() => normalizeGlobalRecoveryOutput({ recoveries: [{
    questionId: "q-global-scope",
    decision: "recover",
    primaryNodeId: "method",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["method", "voice"],
    confidence: 0.8,
  }] }, { adjacency, questionIds: ["q-global-scope"] }), /knowledge_classification_global_recovery_scope_anchor_invalid/);
});

test("Agent 3 can only propose a complete evidence-bound candidate family draft", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const normalized = normalizeAgent2Output({ verifications: [{
    questionId: "q-new-family",
    decision: "cross_knowledge",
    primaryNodeId: "voice",
    requiredNodeIds: ["voice", "airflow"],
    focusKey: "voice-airflow-contrast",
    focusLabel: "清浊与送气综合辨析",
    action: "综合判别",
    confidence: 0.86,
    evidenceChunkIds: ["chunk-voice"],
    familyDecision: "create_new",
    candidateFamilyDraft: {
      name: "清浊与送气综合辨析",
      coreKnowledgeNodeId: "voice",
      requiredKnowledgeNodeIds: ["voice", "airflow"],
      textbookAnchorNodeIds: ["method"],
      assessmentAction: "同时判断声带振动与气流强弱",
      inclusionBoundary: "必须同时调用清浊和送气两个维度才能作答。",
      exclusionBoundary: "只考清浊或只考送气的单维题不纳入。",
      textbookEvidence: { chunkIds: ["chunk-voice"], summary: "教材分别给出两个发音方法维度。" },
      reason: "现有题族均为单维考查。",
    },
  }] }, {
    adjacency,
    questionIds: ["q-new-family"],
    terminalNodeIdsByQuestion: { "q-new-family": ["voice"] },
    evidenceChunkIdsByQuestion: { "q-new-family": ["chunk-voice"] },
  });
  const draft = normalized.verifications[0].candidateFamilyDraft;
  assert.equal(normalized.verifications[0].familyDecision, "create_new");
  assert.equal(draft.knowledgeNodeId, "method");
  assert.deepEqual(draft.requiredKnowledgeNodeIds, ["voice", "airflow"]);
  assert.deepEqual(draft.membership.contributionKnowledgeNodeIds, ["voice", "airflow"]);

  assert.throws(() => normalizeAgent2Output({ verifications: [{
    questionId: "q-new-family",
    decision: "confirm",
    primaryNodeId: "voice",
    requiredNodeIds: ["voice"],
    focusKey: "voice",
    focusLabel: "清浊",
    action: "判断",
    confidence: 0.8,
    familyDecision: "create_new",
  }] }, {
    adjacency,
    questionIds: ["q-new-family"],
    terminalNodeIdsByQuestion: { "q-new-family": ["voice"] },
  }), /family_draft_required/);
});

test("Agent 3 global recovery can leave the failed five-candidate branch but cannot invent nodes", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const recovered = normalizeGlobalRecoveryOutput({ recoveries: [{
    questionId: "q-global",
    decision: "recover",
    primaryNodeId: "place",
    requiredNodeIds: ["place"],
    confidence: 0.88,
    reason: "完整知识树中的发音部位节点才是最小充分知识",
    evidenceChunkIds: ["chunk-place"],
  }] }, {
    adjacency,
    questionIds: ["q-global"],
    evidenceChunkIdsByQuestion: { "q-global": ["chunk-place"] },
  });
  assert.equal(recovered.recoveries[0].primaryNodeId, "place");
  assert.throws(() => normalizeGlobalRecoveryOutput({ recoveries: [{
    questionId: "q-global",
    decision: "recover",
    primaryNodeId: "place",
    requiredNodeIds: ["place"],
    confidence: 0.88,
    reason: "超出限时备用候选",
  }] }, { adjacency, questionIds: ["q-global"], allowedNodeIds: ["voice", "airflow"] }), /selection_outside_scope/);
  assert.throws(() => normalizeGlobalRecoveryOutput({ recoveries: [{
    questionId: "q-global",
    decision: "recover",
    primaryNodeId: "invented",
    requiredNodeIds: ["invented"],
    confidence: 0.5,
  }] }, { adjacency, questionIds: ["q-global"] }), /primary_invalid/);
});

test("Agent 3 global recovery preserves unable and missing-node exits", () => {
  const adjacency = buildKnowledgeAdjacency(nodes);
  const unresolved = normalizeGlobalRecoveryOutput({ recoveries: [{
    questionId: "q-global",
    decision: "unable",
    primaryNodeId: "",
    requiredNodeIds: [],
    confidence: 0.4,
    reason: "教材证据不足",
    uncertainty: "需人工审核",
  }] }, { adjacency, questionIds: ["q-global"] });
  assert.equal(unresolved.recoveries[0].decision, "unable");
  assert.deepEqual(unresolved.recoveries[0].requiredNodeIds, []);
});

test("Agent 3 separates a family range anchor from member contribution and still enforces action semantics", () => {
  const verification = {
    questionId: "q-family-contract",
    decision: "confirm",
    primaryNodeId: "obstruction",
    requiredNodeIds: ["obstruction"],
    action: "分类判断",
    familyDecision: "join_existing",
    primaryFamilyId: "family-compatible",
  };
  const compatible = {
    id: "family-compatible",
    status: "confirmed",
    coreKnowledgeNodeId: "method",
    requiredKnowledgeNodeIds: ["obstruction", "voice"],
    assessmentAction: "类别判定",
  };
  const accepted = validateAgent3VerificationContract(verification, {
    rawVerification: { requiredNodeAssessments: [] },
    dependencySteps: [],
    candidateFamilies: [compatible],
  });
  assert.equal(accepted.primaryFamilyId, compatible.id);
  assert.deepEqual(accepted.familyMemberships, [{
    familyId: compatible.id,
    isPrimary: true,
    coverageRole: "required",
    contributionKnowledgeNodeIds: ["obstruction"],
  }]);

  const reject = (family, code, rawVerification = { requiredNodeAssessments: [] }) => assert.throws(() => validateAgent3VerificationContract(verification, {
    rawVerification,
    dependencySteps: [],
    candidateFamilies: [family],
  }), new RegExp(code));
  reject({ ...compatible, status: "pending_review" }, "join_family_not_confirmed");
  reject({ ...compatible, requiredKnowledgeNodeIds: ["voice"] }, "join_core_mismatch");
  reject(compatible, "required_family_knowledge_invalid", {
    requiredNodeAssessments: [],
    primaryFamilyContributionKnowledgeNodeIds: ["voice"],
  });
  // 考查动作不再是加入现有题族的门禁：动作类型不一致时允许加入，只记录风险。
  const actionMismatch = validateAgent3VerificationContract(verification, {
    rawVerification: { requiredNodeAssessments: [] },
    dependencySteps: [],
    candidateFamilies: [{ ...compatible, assessmentAction: "概念识别" }],
  });
  assert.equal(actionMismatch.primaryFamilyId, compatible.id);
  assert.equal(actionMismatch.familyActionRisk?.code, "family_action_mismatch");
  assert.equal(actionMismatch.familyActionRisk?.expected.type, "concept_recognition");
  assert.equal(actionMismatch.familyActionRisk?.predicted.type, "classification");
  // 动作一致时不记风险
  assert.equal(accepted.familyActionRisk, null);
  assert.throws(() => validateAgent3VerificationContract({ ...verification, primaryFamilyId: "" }, {
    rawVerification: { requiredNodeAssessments: [] }, dependencySteps: [], candidateFamilies: [compatible],
  }), /join_primary_required/);
});

test("an empty candidate family draft placeholder does not block joining an existing family", () => {
  // 模型在 join_existing 时会习惯性带上空的 candidateFamilyDraft 占位（各字段空串/空数组）。
  // 这类空占位必须视为"未提供草稿"，否则会把本身正确的加入判定挡掉：
  // 空草稿 → family_draft_required_invalid；补全草稿 → family_draft_unexpected，两者互斥。
  const verification = {
    questionId: "q-join-with-blank-draft",
    decision: "confirm",
    primaryNodeId: "method",
    primaryNodeRole: "core",
    requiredNodeIds: ["method"],
    action: "概念识别",
    familyDecision: "join_existing",
    primaryFamilyId: "family-compatible",
  };
  const family = {
    id: "family-compatible",
    status: "confirmed",
    coreKnowledgeNodeId: "method",
    requiredKnowledgeNodeIds: ["method"],
    assessmentAction: "概念识别",
  };
  const blankDraft = {
    name: "",
    focusKey: "",
    coreKnowledgeNodeId: "",
    requiredKnowledgeNodeIds: [],
    textbookAnchorNodeIds: [],
    assessmentAction: "",
    inclusionBoundary: "",
    exclusionBoundary: "",
    membership: { coverageRole: "required", contributionKnowledgeNodeIds: [] },
  };
  const accepted = validateAgent3VerificationContract(
    { ...verification, candidateFamilyDraft: blankDraft },
    {
      rawVerification: { requiredNodeAssessments: [], candidateFamilyDraft: blankDraft },
      dependencySteps: [],
      candidateFamilies: [family],
    },
  );
  assert.equal(accepted.primaryFamilyId, family.id);
  assert.equal(accepted.familyMemberships[0].familyId, family.id);
  // 归一化层把空占位转成"无草稿"（normalizeAgent2Output 是真实管道入口）
  const normalized = normalizeAgent2Output({
    verifications: [{
      questionId: "q-join-with-blank-draft",
      decision: "confirm",
      primaryNodeId: "method",
      primaryNodeRole: "core",
      requiredNodeIds: ["method"],
      focusKey: "concept-key",
      focusLabel: "概念焦点",
      action: "概念识别",
      confidence: 0.9,
      familyDecision: "join_existing",
      primaryFamilyId: "family-compatible",
      candidateFamilyDraft: blankDraft,
    }],
  }, {
    adjacency: [{
      id: "method", parentId: "", bookId: "book-1", kind: "knowledge",
      title: "方法", path: "章 > 方法", level: 1, catalogLevel: 0, order: 1,
    }],
    questionIds: ["q-join-with-blank-draft"],
    terminalNodeIdsByQuestion: { "q-join-with-blank-draft": ["method"] },
    evidenceChunkIdsByQuestion: { "q-join-with-blank-draft": [] },
  });
  assert.equal(normalized.verifications[0].candidateFamilyDraft, null);
  assert.equal(normalized.verifications[0].familyDecision, "join_existing");
  // 但真正填了字段的草稿在 join_existing 下仍按原规则拒绝（该检查在归一化入口）
  const filledDraft = {
    name: "新族",
    focusKey: "new-family-focus",
    coreKnowledgeNodeId: "method",
    requiredKnowledgeNodeIds: ["method"],
    textbookAnchorNodeIds: ["method"],
    assessmentAction: "概念识别",
    textbookEvidence: { chunkIds: ["chunk-1"] },
    membership: { coverageRole: "required", contributionKnowledgeNodeIds: ["method"] },
  };
  assert.throws(() => normalizeAgent2Output({
    verifications: [{
      questionId: "q-join-with-blank-draft",
      decision: "confirm",
      primaryNodeId: "method",
      primaryNodeRole: "core",
      requiredNodeIds: ["method"],
      focusKey: "concept-key",
      focusLabel: "概念焦点",
      action: "概念识别",
      confidence: 0.9,
      familyDecision: "join_existing",
      primaryFamilyId: "family-compatible",
      candidateFamilyDraft: filledDraft,
    }],
  }, {
    adjacency: [{
      id: "method", parentId: "", bookId: "book-1", kind: "knowledge",
      title: "方法", path: "章 > 方法", level: 1, catalogLevel: 0, order: 1,
    }],
    questionIds: ["q-join-with-blank-draft"],
    terminalNodeIdsByQuestion: { "q-join-with-blank-draft": ["method"] },
    evidenceChunkIdsByQuestion: { "q-join-with-blank-draft": ["chunk-1"] },
  }), /family_draft_unexpected/);
});

test("Agent 3 lets a scope anchor use nonempty descendant contributions without carrying the anchor", () => {
  const verification = {
    questionId: "q-scope-family",
    decision: "confirm",
    primaryNodeId: "method",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["voice"],
    action: "分类判断",
    familyDecision: "join_existing",
    primaryFamilyId: "family-voice",
  };
  const family = {
    id: "family-voice",
    status: "confirmed",
    coreKnowledgeNodeId: "method",
    requiredKnowledgeNodeIds: ["voice"],
    assessmentAction: "类别判定",
  };
  const accepted = validateAgent3VerificationContract(verification, {
    rawVerification: {
      requiredNodeAssessments: [{
        nodeId: "voice",
        dependencyStepRefs: ["dep-voice"],
        necessaryAfterDeletionTest: true,
        deletionTest: "删除声带振动知识后无法判断答案。",
        entailedByPrimaryRule: false,
        reason: "该后代节点是实际作答所需知识。",
      }],
      primaryFamilyContributionKnowledgeNodeIds: ["voice"],
    },
    dependencySteps: [{
      ref: "dep-voice",
      dependencyRole: "independent_required",
      coveredByStepRef: "",
      necessity: "required",
    }],
    candidateFamilies: [family],
  });
  assert.deepEqual(accepted.primaryFamilyContributionKnowledgeNodeIds, ["voice"]);
  assert.equal(accepted.primaryFamilyContributionKnowledgeNodeIds.includes("method"), false);
});

test("Agent 3 combines a primary or candidate family with required related families while ignoring references", () => {
  const requiredNodeAssessment = {
    nodeId: "voice",
    dependencyStepRefs: ["dep-voice"],
    necessaryAfterDeletionTest: true,
    deletionTest: "删除声带振动知识后无法完成第二步判断。",
    entailedByPrimaryRule: false,
    reason: "该节点独立参与作答。",
  };
  const relatedAssessment = {
    familyId: "family-voice",
    necessaryAfterDeletionTest: true,
    deletionTest: "删除该题族能力后无法完成声带振动判断。",
    reason: "它补齐主题族未覆盖的必需知识。",
  };
  const dependencySteps = [{
    ref: "dep-voice",
    dependencyRole: "independent_required",
    coveredByStepRef: "",
    necessity: "required",
  }];
  const primaryFamily = {
    id: "family-obstruction",
    status: "confirmed",
    coreKnowledgeNodeId: "obstruction",
    requiredKnowledgeNodeIds: ["obstruction"],
    assessmentAction: "类别判定",
  };
  const requiredFamily = {
    id: "family-voice",
    status: "confirmed",
    coreKnowledgeNodeId: "voice",
    requiredKnowledgeNodeIds: ["voice"],
    assessmentAction: "清浊辨析",
  };
  const referenceFamily = {
    id: "family-airflow",
    status: "confirmed",
    coreKnowledgeNodeId: "airflow",
    requiredKnowledgeNodeIds: ["airflow"],
    assessmentAction: "送气辨析",
  };
  const verification = {
    questionId: "q-family-union",
    decision: "cross_knowledge",
    primaryNodeId: "obstruction",
    requiredNodeIds: ["obstruction", "voice"],
    action: "分类判断",
    familyDecision: "join_existing",
    primaryFamilyId: primaryFamily.id,
  };
  const rawVerification = {
    requiredNodeAssessments: [requiredNodeAssessment],
    relatedFamilyIds: [requiredFamily.id, referenceFamily.id],
    relatedFamilyRelations: [
      { familyId: requiredFamily.id, coverageRole: "required" },
      { familyId: referenceFamily.id, coverageRole: "reference" },
    ],
    relatedFamilyAssessments: [
      relatedAssessment,
      {
        familyId: referenceFamily.id,
        necessaryAfterDeletionTest: false,
        deletionTest: "删除后仍可完成本题。",
        reason: "只保留为相邻考查维度的参考关系。",
      },
    ],
  };
  const context = {
    rawVerification,
    dependencySteps,
    candidateFamilies: [primaryFamily, requiredFamily, referenceFamily],
  };

  const joined = validateAgent3VerificationContract(verification, context);
  assert.deepEqual(joined.relatedFamilyIds, [requiredFamily.id, referenceFamily.id]);
  assert.deepEqual(joined.relatedFamilyRelations.map((item) => item.coverageRole), ["required", "reference"]);
  assert.deepEqual(joined.familyMemberships, [
    {
      familyId: primaryFamily.id,
      isPrimary: true,
      coverageRole: "required",
      contributionKnowledgeNodeIds: ["obstruction"],
    },
    {
      familyId: requiredFamily.id,
      isPrimary: false,
      coverageRole: "required",
      contributionKnowledgeNodeIds: ["voice"],
    },
    {
      familyId: referenceFamily.id,
      isPrimary: false,
      coverageRole: "reference",
      contributionKnowledgeNodeIds: [],
    },
  ]);

  const created = validateAgent3VerificationContract({
    ...verification,
    familyDecision: "create_new",
    primaryFamilyId: "",
    candidateFamilyDraft: {
      coreKnowledgeNodeId: "method",
      requiredKnowledgeNodeIds: ["obstruction"],
      textbookAnchorNodeIds: ["obstruction"],
    },
  }, {
    ...context,
    rawVerification: { ...rawVerification, familyDecision: "create_new", primaryFamilyId: "" },
  });
  assert.equal(created.familyDecision, "create_new");

  assert.throws(() => validateAgent3VerificationContract(verification, {
    ...context,
    rawVerification: {
      ...rawVerification,
      relatedFamilyRelations: rawVerification.relatedFamilyRelations.map((relation) => (
        relation.familyId === requiredFamily.id ? { ...relation, coverageRole: "reference" } : relation
      )),
      relatedFamilyAssessments: rawVerification.relatedFamilyAssessments.map((assessment) => (
        assessment.familyId === requiredFamily.id
          ? { ...assessment, necessaryAfterDeletionTest: false }
          : assessment
      )),
    },
  }), /join_required_set_mismatch/);

});

test("Agent 3 rejects non-core required knowledge that is a supplied label, lacks deletion proof, or is absorbed by core", () => {
  const verification = {
    questionId: "q-required-contract",
    decision: "cross_knowledge",
    primaryNodeId: "voice",
    requiredNodeIds: ["voice", "airflow"],
    action: "分类判断",
    familyDecision: "unresolved",
    primaryFamilyId: "",
  };
  const independentSteps = [{ ref: "dep-1", dependencyRole: "independent_required", coveredByStepRef: "", necessity: "required" }];
  const assessment = {
    nodeId: "airflow",
    dependencyStepRefs: ["dep-1"],
    necessaryAfterDeletionTest: true,
    deletionTest: "删除后无法判断气流强弱对应的答案。",
    entailedByPrimaryRule: false,
    reason: "该步骤独立决定一个选项。",
  };
  const accepted = validateAgent3VerificationContract(verification, {
    rawVerification: { requiredNodeAssessments: [assessment] },
    dependencySteps: independentSteps,
    candidateFamilies: [],
  });
  assert.deepEqual(accepted.requiredNodeAssessments[0].dependencyStepRefs, ["dep-1"]);

  assert.throws(() => validateAgent3VerificationContract(verification, {
    rawVerification: { requiredNodeAssessments: [assessment] },
    dependencySteps: [{ ...independentSteps[0], dependencyRole: "input_descriptor" }],
    candidateFamilies: [],
  }), /required_assessment_refs_invalid/);
  assert.throws(() => validateAgent3VerificationContract(verification, {
    rawVerification: { requiredNodeAssessments: [{ ...assessment, necessaryAfterDeletionTest: false }] },
    dependencySteps: independentSteps,
    candidateFamilies: [],
  }), /required_deletion_test_failed/);
  assert.throws(() => validateAgent3VerificationContract(verification, {
    rawVerification: { requiredNodeAssessments: [{ ...assessment, entailedByPrimaryRule: true }] },
    dependencySteps: independentSteps,
    candidateFamilies: [],
  }), /required_absorbed_by_core/);
});

test("Agent 3 related-family contract errors trigger the single constrained correction", () => {
  const verification = {
    questionId: "q-related-contract",
    decision: "confirm",
    primaryNodeId: "voice",
    requiredNodeIds: ["voice"],
    action: "分类判断",
    familyDecision: "unresolved",
    primaryFamilyId: "",
  };
  const context = {
    rawVerification: {
      requiredNodeAssessments: [],
      relatedFamilyIds: ["family-related"],
      relatedFamilyAssessments: [],
      matchedFamilyIds: ["family-similar"],
    },
    dependencySteps: [],
    candidateFamilies: [
      { id: "family-related", status: "confirmed" },
      { id: "family-similar", status: "confirmed" },
    ],
  };
  let contractError;
  try {
    validateAgent3VerificationContract(verification, context);
  } catch (error) {
    contractError = error;
  }
  assert.match(contractError?.message || "", /related_family_relation_missing/);
  assert.equal(isAgent3ContractError(contractError), true);

  const matchedOnly = validateAgent3VerificationContract(verification, {
    ...context,
    rawVerification: {
      ...context.rawVerification,
      relatedFamilyIds: [],
      relatedFamilyRelations: [],
      relatedFamilyAssessments: [],
    },
  });
  assert.deepEqual(matchedOnly.relatedFamilyIds || [], []);
});

test("Agent 3 records option-relation confirmation and correction without overwriting Agent 1", () => {
  const featureProfile = {
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
    choiceStructure: "direct_options",
    optionFeatures: [
      { key: "A", knowledgeRelation: "question_only" },
      { key: "B", knowledgeRelation: "option_specific" },
    ],
  };
  const assessments = normalizeOptionRelationAssessments([{
    key: "A",
    decision: "confirm",
    proposedKnowledgeRelation: "",
    proposedKnowledgeNodeIds: [],
    evidenceChunkIds: ["chunk-1"],
    reason: "题目层规则足以判断 A。",
  }, {
    key: "B",
    decision: "correction",
    proposedKnowledgeRelation: "question_only",
    proposedKnowledgeNodeIds: [],
    evidenceChunkIds: ["chunk-1"],
    reason: "删除选项提示后仍可由题目层规则排除 B。",
  }], {
    featureProfile,
    allowedKnowledgeNodeIds: new Set(["voice"]),
    evidenceChunkIds: ["chunk-1"],
  });
  assert.deepEqual(assessments.map((item) => item.agent1KnowledgeRelation), ["question_only", "option_specific"]);
  assert.equal(assessments[1].proposedKnowledgeRelation, "question_only");
  assert.equal(featureProfile.optionFeatures[1].knowledgeRelation, "option_specific");
  assert.throws(() => normalizeOptionRelationAssessments([{
    key: "A", decision: "confirm", evidenceChunkIds: [], reason: "确认",
  }, {
    key: "B", decision: "correction", proposedKnowledgeRelation: "option_specific",
    proposedKnowledgeNodeIds: ["invented"], evidenceChunkIds: [], reason: "修正",
  }], {
    featureProfile,
    allowedKnowledgeNodeIds: new Set(["voice"]),
  }), /option_relation_assessment_nodes_invalid/);
  assert.throws(() => normalizeOptionRelationAssessments(null, {
    featureProfile,
    allowedKnowledgeNodeIds: new Set(["voice"]),
    evidenceChunkIds: ["chunk-1"],
  }), /option_relation_assessments_invalid/);
  assert.deepEqual(normalizeOptionRelationAssessments(null, {
    featureProfile: { ...featureProfile, optionKnowledgeProtocolVersion: "legacy" },
    allowedKnowledgeNodeIds: new Set(["voice"]),
    evidenceChunkIds: ["chunk-1"],
  }), []);
  assert.throws(() => normalizeOptionRelationAssessments([{
    key: "A", decision: "confirm", evidenceChunkIds: [], reason: "确认",
  }, {
    key: "B", decision: "confirm", verifiedKnowledgeNodeIds: ["voice"],
    evidenceChunkIds: ["chunk-1"], reason: "确认",
  }], {
    featureProfile,
    allowedKnowledgeNodeIds: new Set(["voice"]),
    evidenceChunkIds: ["chunk-1"],
  }), /option_relation_assessment_evidence_required/);
  assert.throws(() => normalizeOptionRelationAssessments([{
    key: "A", decision: "confirm", evidenceChunkIds: ["not-offered"], reason: "确认",
  }, {
    key: "B", decision: "confirm", verifiedKnowledgeNodeIds: ["voice"],
    evidenceChunkIds: ["chunk-1"], reason: "确认",
  }], {
    featureProfile,
    allowedKnowledgeNodeIds: new Set(["voice"]),
    evidenceChunkIds: ["chunk-1"],
  }), /option_relation_assessment_evidence_invalid/);
});

test("Agent 3 persists independently verified nodes for confirmed option-specific relations", () => {
  const featureProfile = {
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
    choiceStructure: "direct_options",
    optionFeatures: [
      { key: "A", knowledgeRelation: "option_specific" },
      { key: "B", knowledgeRelation: "question_only" },
    ],
  };
  const assessments = normalizeOptionRelationAssessments([{
    key: "A",
    decision: "confirm",
    verifiedKnowledgeNodeIds: ["voice"],
    evidenceChunkIds: ["chunk-1"],
    reason: "教材证据确认 A 必须独立调用清浊音知识。",
  }, {
    key: "B",
    decision: "correction",
    proposedKnowledgeRelation: "option_specific",
    proposedKnowledgeNodeIds: ["tone"],
    evidenceChunkIds: ["chunk-1"],
    reason: "B 还需独立调用声调知识。",
  }], {
    featureProfile,
    allowedKnowledgeNodeIds: new Set(["voice", "tone"]),
    evidenceChunkIds: ["chunk-1"],
  });
  assert.deepEqual(assessments[0].verifiedKnowledgeNodeIds, ["voice"]);
  assert.deepEqual(assessments[0].proposedKnowledgeNodeIds, []);
  assert.deepEqual(assessments[1].verifiedKnowledgeNodeIds, []);
  assert.deepEqual(assessments[1].proposedKnowledgeNodeIds, ["tone"]);
  assert.equal(featureProfile.optionFeatures[0].knowledgeRelation, "option_specific");
  assert.throws(() => normalizeOptionRelationAssessments([{
    key: "A", decision: "confirm", evidenceChunkIds: ["chunk-1"], reason: "缺少独立节点",
  }, {
    key: "B", decision: "confirm", evidenceChunkIds: ["chunk-1"], reason: "确认",
  }], {
    featureProfile,
    allowedKnowledgeNodeIds: new Set(["voice"]),
    evidenceChunkIds: ["chunk-1"],
  }), /option_relation_assessment_nodes_invalid/);
});

test("Agent 3 reviews composed questions by every atomic statement key", () => {
  const featureProfile = {
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
    choiceStructure: "composed_options",
    optionFeatures: [{ key: "A", role: "answer" }, { key: "B", role: "distractor" }],
    atomicStatements: [
      { key: "①", knowledgeRelation: "question_only" },
      { key: "②", knowledgeRelation: "undetermined" },
      { key: "③", knowledgeRelation: "option_specific" },
    ],
    optionComposition: [
      { optionKey: "A", atomicKeys: ["①", "②"] },
      { optionKey: "B", atomicKeys: ["②", "③"] },
    ],
  };
  const assessments = normalizeOptionRelationAssessments([
    { key: "①", decision: "confirm", evidenceChunkIds: ["chunk-1"], reason: "确认陈述一" },
    { key: "②", decision: "confirm", evidenceChunkIds: ["chunk-1"], reason: "确认陈述二" },
    { key: "③", decision: "confirm", verifiedKnowledgeNodeIds: ["node-3"], evidenceChunkIds: ["chunk-1"], reason: "确认陈述三" },
  ], { featureProfile, allowedKnowledgeNodeIds: new Set(["node-3"]), evidenceChunkIds: ["chunk-1"] });
  assert.deepEqual(assessments.map((item) => item.key), ["①", "②", "③"]);
  assert.deepEqual(assessments.map((item) => item.agent1KnowledgeRelation), [
    "question_only", "undetermined", "option_specific",
  ]);
  assert.throws(() => normalizeOptionRelationAssessments([
    { key: "A", decision: "confirm", evidenceChunkIds: ["chunk-1"], reason: "错误地审核组合项" },
    { key: "②", decision: "confirm", evidenceChunkIds: ["chunk-1"], reason: "确认陈述二" },
    { key: "③", decision: "confirm", evidenceChunkIds: ["chunk-1"], reason: "确认陈述三" },
  ], { featureProfile, evidenceChunkIds: ["chunk-1"] }), /option_relation_assessments_invalid/);
});
