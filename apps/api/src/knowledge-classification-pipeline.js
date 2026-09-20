const { compareAssessmentActions } = require("../../../packages/domain/assessment-action-semantics");
const { validateRelatedFamilySuggestionsContract } = require("./classification-verification-policy");

const AGENT1_DECISIONS = new Set(["node", "stay", "multiple", "unable", "none_of_candidates", "previous_level_wrong"]);
const AGENT1_STOP_REASONS = new Set(["leaf", "stay", "multiple", "unable", "none_of_candidates", "previous_level_wrong"]);
const AGENT2_DECISIONS = new Set(["confirm", "move_parent", "move_sibling", "cross_knowledge", "unable", "missing_node"]);
const GLOBAL_RECOVERY_DECISIONS = new Set(["recover", "unable", "missing_node"]);
const FAMILY_DECISIONS = new Set(["join_existing", "create_new", "needs_merge", "unresolved"]);
const PRIMARY_NODE_ROLES = new Set(["core", "scope_anchor"]);
const AGENT3_CONTRACT_ERRORS = new Set([
  "knowledge_classification_agent3_json_invalid",
  "knowledge_classification_agent3_selection_outside_candidates",
  "knowledge_classification_agent2_output_invalid",
  "knowledge_classification_agent2_result_count_mismatch",
  "knowledge_classification_agent2_verification_invalid",
  "knowledge_classification_agent2_question_mismatch",
  "knowledge_classification_agent2_decision_invalid",
  "knowledge_classification_agent2_unresolved_nodes_invalid",
  "knowledge_classification_agent2_primary_node_invalid",
  "knowledge_classification_agent2_primary_role_invalid",
  "knowledge_classification_agent2_scope_anchor_invalid",
  "knowledge_classification_agent2_required_nodes_invalid",
  "knowledge_classification_agent2_confirm_mismatch",
  "knowledge_classification_agent2_parent_mismatch",
  "knowledge_classification_agent2_sibling_mismatch",
  "knowledge_classification_agent2_cross_knowledge_required",
  "knowledge_classification_agent2_single_knowledge_required",
  "knowledge_classification_agent2_focus_required",
  "knowledge_classification_agent2_confidence_invalid",
  "knowledge_classification_agent2_evidence_invalid",
  "knowledge_classification_family_draft_anchor_invalid",
  "knowledge_classification_family_draft_core_invalid",
  "knowledge_classification_family_draft_evidence_invalid",
  "knowledge_classification_family_draft_evidence_required",
  "knowledge_classification_family_draft_fields_required",
  "knowledge_classification_family_draft_required",
  "knowledge_classification_family_draft_required_invalid",
  "knowledge_classification_family_draft_unexpected",
  "knowledge_classification_agent3_required_assessments_invalid",
  "knowledge_classification_agent3_required_assessment_refs_invalid",
  "knowledge_classification_agent3_required_deletion_test_failed",
  "knowledge_classification_agent3_required_absorbed_by_core",
  "knowledge_classification_agent3_option_relation_assessments_invalid",
  "knowledge_classification_agent3_option_relation_assessment_decision_invalid",
  "knowledge_classification_agent3_option_relation_assessment_correction_invalid",
  "knowledge_classification_agent3_option_relation_assessment_nodes_invalid",
  "knowledge_classification_agent3_option_relation_assessment_evidence_required",
  "knowledge_classification_agent3_option_relation_assessment_evidence_invalid",
  "knowledge_classification_agent3_related_family_refs_invalid",
  "knowledge_classification_agent3_related_family_ids_duplicate",
  "knowledge_classification_agent3_related_family_assessment_refs_invalid",
  "knowledge_classification_agent3_related_family_assessment_duplicate",
  "knowledge_classification_agent3_related_family_assessment_missing",
  "knowledge_classification_agent3_related_family_deletion_test_invalid",
  "knowledge_classification_agent3_related_family_relation_invalid",
  "knowledge_classification_agent3_related_family_relation_duplicate",
  "knowledge_classification_agent3_related_family_relation_missing",
  "knowledge_classification_agent3_reference_family_contribution_forbidden",
  "knowledge_classification_agent3_related_family_not_confirmed",
  "knowledge_classification_agent3_required_family_knowledge_invalid",
  "knowledge_classification_agent3_join_primary_required",
  "knowledge_classification_agent3_join_family_not_confirmed",
  "knowledge_classification_agent3_join_core_mismatch",
  "knowledge_classification_agent3_join_required_set_mismatch",
  "knowledge_classification_agent3_join_action_mismatch",
  "knowledge_classification_agent3_primary_family_unexpected",
  "knowledge_classification_agent3_family_decision_invalid",
  "knowledge_classification_agent3_family_decision_required",
  "knowledge_classification_agent3_family_refs_invalid",
  "knowledge_classification_agent3_family_refs_duplicate",
  "knowledge_classification_agent3_draft_core_mismatch",
  "knowledge_classification_agent3_draft_required_set_mismatch",
  "knowledge_classification_agent3_draft_anchor_outside_candidates",
]);
const AGENT2_CORE_PATH_STATUSES = new Set(["core_path_viable", "core_path_not_viable", "uncertain"]);
const AGENT2_NAVIGATION_CONTRACT_ERRORS = new Set([
  "knowledge_classification_agent2_navigation_output_invalid",
  "knowledge_classification_agent2_navigation_question_mismatch",
  "knowledge_classification_agent2_navigation_decision_invalid",
  "knowledge_classification_agent2_navigation_selection_outside_candidates",
  "knowledge_classification_agent2_navigation_single_selection_required",
  "knowledge_classification_agent2_navigation_multiple_selection_invalid",
  "knowledge_classification_agent2_navigation_multiple_not_offered",
  "knowledge_classification_agent2_navigation_stay_invalid",
  "knowledge_classification_agent2_navigation_control_selection_invalid",
  "knowledge_classification_agent2_navigation_previous_level_invalid",
  "knowledge_classification_agent2_navigation_confidence_invalid",
  "knowledge_classification_agent2_navigation_core_path_status_invalid",
  "knowledge_classification_agent2_navigation_core_path_conflict",
  "knowledge_classification_agent2_navigation_auxiliary_gap_invalid",
  "knowledge_classification_agent2_navigation_auxiliary_gap_reference_invalid",
  "knowledge_classification_agent2_navigation_candidate_rejections_invalid",
  "knowledge_classification_agent2_navigation_json_invalid",
]);

function cleanText(value, limit = 1000) {
  return String(value || "").trim().slice(0, limit);
}

function uniqueIds(value, limit = Number.MAX_SAFE_INTEGER) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].slice(0, limit);
}

function normalizePrimaryNodeRole(value, errorCode = "knowledge_classification_agent2_primary_role_invalid") {
  const role = String(value || "").trim();
  if (!role) return "core";
  if (!PRIMARY_NODE_ROLES.has(role)) throw new Error(errorCode);
  return role;
}

function isProperKnowledgeAncestor(adjacency, ancestorId, nodeId) {
  let current = adjacency.byId.get(String(nodeId || ""));
  const wanted = String(ancestorId || "");
  while (current?.parentId) {
    current = adjacency.byId.get(current.parentId);
    if (current?.id === wanted) return true;
  }
  return false;
}

function strictConfidence(value, errorCode) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(errorCode);
  return confidence;
}

function compareOrderPath(left, right) {
  const leftPath = Array.isArray(left.orderPath) ? left.orderPath : [];
  const rightPath = Array.isArray(right.orderPath) ? right.orderPath : [];
  const length = Math.max(leftPath.length, rightPath.length);
  for (let index = 0; index < length; index += 1) {
    const difference = Number(leftPath[index] || 0) - Number(rightPath[index] || 0);
    if (difference) return difference;
  }
  return Number(left.order || 0) - Number(right.order || 0)
    || String(left.displayTitle || left.title || "").localeCompare(String(right.displayTitle || right.title || ""), "zh-CN");
}

function buildKnowledgeAdjacency(nodes = []) {
  const byId = new Map();
  (Array.isArray(nodes) ? nodes : []).forEach((source) => {
    const id = String(source && source.id || "");
    if (!id) throw new Error("knowledge_classification_node_id_required");
    if (byId.has(id)) throw new Error("knowledge_classification_node_id_duplicate");
    byId.set(id, { ...source, id, parentId: String(source.parentId || "") });
  });
  const childrenByParentId = new Map();
  byId.forEach((node) => {
    if (node.parentId && !byId.has(node.parentId)) throw new Error("knowledge_classification_parent_not_found");
    if (!childrenByParentId.has(node.parentId)) childrenByParentId.set(node.parentId, []);
    childrenByParentId.get(node.parentId).push(node);
  });
  childrenByParentId.forEach((children) => children.sort(compareOrderPath));
  return {
    byId,
    childrenByParentId,
    roots: (childrenByParentId.get("") || []).slice(),
  };
}

function ensureAdjacency(value) {
  return value && value.byId instanceof Map && value.childrenByParentId instanceof Map
    ? value : buildKnowledgeAdjacency(value);
}

function scoreForNode(scores, nodeId) {
  if (scores instanceof Map) return Number(scores.get(nodeId)) || 0;
  if (scores && typeof scores === "object") return Number(scores[nodeId]) || 0;
  return 0;
}

function directChildCandidates(adjacencyOrNodes, parentNodeId = "", options = {}) {
  const adjacency = ensureAdjacency(adjacencyOrNodes);
  const parentId = String(parentNodeId || "");
  if (parentId && !adjacency.byId.has(parentId)) throw new Error("knowledge_classification_parent_not_found");
  const preferred = new Map(uniqueIds(options.preferredNodeIds).map((id, index) => [id, index]));
  const limit = Math.min(5, Math.max(1, Number(options.limit) || 5));
  return (adjacency.childrenByParentId.get(parentId) || []).slice().sort((left, right) => {
    const scoreDifference = scoreForNode(options.scores, right.id) - scoreForNode(options.scores, left.id);
    if (scoreDifference) return scoreDifference;
    const leftPreferred = preferred.has(left.id) ? preferred.get(left.id) : Number.MAX_SAFE_INTEGER;
    const rightPreferred = preferred.has(right.id) ? preferred.get(right.id) : Number.MAX_SAFE_INTEGER;
    return leftPreferred - rightPreferred || compareOrderPath(left, right);
  }).slice(0, limit).map((node) => ({ ...node }));
}

function controlOptionAvailability(adjacencyOrNodes, currentNodeId = "", candidateNodeIds = []) {
  const adjacency = ensureAdjacency(adjacencyOrNodes);
  const currentId = String(currentNodeId || "");
  const current = currentId ? adjacency.byId.get(currentId) : null;
  return {
    stay: Boolean(current && current.kind === "knowledge"),
    multiple: uniqueIds(candidateNodeIds).length >= 2,
    unable: true,
    none_of_candidates: true,
    previous_level_wrong: Boolean(currentId),
  };
}

function normalizeAuxiliaryGap(value, dependencySteps = []) {
  if (value === null || value === undefined || value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("knowledge_classification_agent2_navigation_auxiliary_gap_invalid");
  }
  const validSteps = new Map((Array.isArray(dependencySteps) ? dependencySteps : []).map((step, index) => {
    const ref = String(step?.ref || `dep-${index + 1}`);
    return [ref, { ...step, ref }];
  }));
  const dependencyStepRefs = uniqueIds(value.dependencyStepRefs, 12);
  if (!dependencyStepRefs.length || dependencyStepRefs.some((ref) => {
    const step = validSteps.get(ref);
    const dependencyRole = step?.dependencyRole
      || (step?.necessity === "incidental" ? "incidental" : "independent_required");
    return !step || step.necessity === "incidental" || dependencyRole !== "independent_required";
  })) {
    throw new Error("knowledge_classification_agent2_navigation_auxiliary_gap_reference_invalid");
  }
  const reason = cleanText(value.reason, 1000);
  if (!reason) throw new Error("knowledge_classification_agent2_navigation_auxiliary_gap_invalid");
  return {
    type: "auxiliary_gap",
    dependencyStepRefs,
    dependencies: dependencyStepRefs.map((ref) => {
      const step = validSteps.get(ref);
      return {
        ref,
        label: cleanText(step?.label, 240),
        nodeIds: uniqueIds(step?.nodeIds, 20),
        necessity: cleanText(step?.necessity, 40),
      };
    }),
    reason,
  };
}

function mapAgent1NavigationError(error) {
  const code = String(error?.message || error || "");
  const prefix = "knowledge_classification_agent1_";
  if (!code.startsWith(prefix)) return error instanceof Error ? error : new Error(code);
  return new Error(`knowledge_classification_agent2_navigation_${code.slice(prefix.length)}`);
}

function normalizeAgent2NavigationOutput(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("knowledge_classification_agent2_navigation_output_invalid");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "questionId") || !String(raw.questionId || "").trim()) {
    throw new Error("knowledge_classification_agent2_navigation_question_mismatch");
  }
  if (!Array.isArray(raw.selectedNodeIds)) {
    throw new Error("knowledge_classification_agent2_navigation_control_selection_invalid");
  }
  if (!cleanText(raw.reason, 1000)) {
    throw new Error("knowledge_classification_agent2_navigation_output_invalid");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "auxiliaryGap")
    && !Object.prototype.hasOwnProperty.call(raw, "auxiliary_gap")) {
    throw new Error("knowledge_classification_agent2_navigation_auxiliary_gap_invalid");
  }
  if (!Array.isArray(raw.candidateRejections)) {
    throw new Error("knowledge_classification_agent2_navigation_candidate_rejections_invalid");
  }
  let normalized;
  try {
    normalized = normalizeAgent1Output(raw, context);
  } catch (error) {
    throw mapAgent1NavigationError(error);
  }
  const corePathStatus = String(raw.corePathStatus || raw.core_path_status || "");
  if (!AGENT2_CORE_PATH_STATUSES.has(corePathStatus)) {
    throw new Error("knowledge_classification_agent2_navigation_core_path_status_invalid");
  }
  const viableDecision = ["node", "stay", "multiple"].includes(normalized.decision);
  const nonViableDecision = ["none_of_candidates", "previous_level_wrong"].includes(normalized.decision);
  if ((viableDecision && corePathStatus !== "core_path_viable")
    || (nonViableDecision && corePathStatus !== "core_path_not_viable")
    || (normalized.decision === "unable" && corePathStatus !== "uncertain")) {
    throw new Error("knowledge_classification_agent2_navigation_core_path_conflict");
  }
  const auxiliaryGap = normalizeAuxiliaryGap(raw.auxiliaryGap ?? raw.auxiliary_gap, context.dependencySteps);
  if (auxiliaryGap && corePathStatus !== "core_path_viable") {
    throw new Error("knowledge_classification_agent2_navigation_core_path_conflict");
  }
  const candidateRejections = (Array.isArray(raw.candidateRejections) ? raw.candidateRejections : []).map((item) => ({
    nodeId: String(item?.nodeId || ""),
    reason: cleanText(item?.reason, 500),
  })).filter((item) => item.nodeId && item.reason);
  if (normalized.decision === "none_of_candidates") {
    const expectedIds = new Set(normalized.candidateNodeIds);
    const rejectedIds = new Set(candidateRejections.map((item) => item.nodeId));
    if (candidateRejections.length !== expectedIds.size
      || [...expectedIds].some((id) => !rejectedIds.has(id))
      || [...rejectedIds].some((id) => !expectedIds.has(id))) {
      throw new Error("knowledge_classification_agent2_navigation_candidate_rejections_invalid");
    }
  } else if (candidateRejections.length) {
    throw new Error("knowledge_classification_agent2_navigation_candidate_rejections_invalid");
  }
  return { ...normalized, corePathStatus, auxiliaryGap, candidateRejections };
}

function isAgent2NavigationContractError(error) {
  return AGENT2_NAVIGATION_CONTRACT_ERRORS.has(String(error?.message || error || ""));
}

function assertCandidateSet(adjacency, currentNodeId, candidateNodeIds) {
  const candidates = uniqueIds(candidateNodeIds);
  if (!candidates.length || candidates.length > 5) throw new Error("knowledge_classification_agent1_candidates_invalid");
  const directIds = new Set((adjacency.childrenByParentId.get(currentNodeId) || []).map((node) => node.id));
  if (candidates.some((id) => !directIds.has(id))) throw new Error("knowledge_classification_agent1_candidate_not_direct_child");
  return candidates;
}

function normalizeAgent1Output(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("knowledge_classification_agent1_output_invalid");
  const adjacency = ensureAdjacency(context.adjacency || context.nodes || []);
  const expectedQuestionId = String(context.questionId || "");
  const questionId = String(raw.questionId || expectedQuestionId);
  if (!questionId || (expectedQuestionId && questionId !== expectedQuestionId)) throw new Error("knowledge_classification_agent1_question_mismatch");
  const currentNodeId = String(context.currentNodeId || context.parentNodeId || "");
  if (currentNodeId && !adjacency.byId.has(currentNodeId)) throw new Error("knowledge_classification_agent1_current_node_invalid");
  const candidateNodeIds = assertCandidateSet(adjacency, currentNodeId, context.candidateNodeIds);
  const candidateSet = new Set(candidateNodeIds);
  const decision = String(raw.decision || "");
  if (!AGENT1_DECISIONS.has(decision)) throw new Error("knowledge_classification_agent1_decision_invalid");
  const selectedNodeIds = uniqueIds(raw.selectedNodeIds, 3);
  if (selectedNodeIds.some((id) => !candidateSet.has(id))) throw new Error("knowledge_classification_agent1_selection_outside_candidates");
  const availability = controlOptionAvailability(adjacency, currentNodeId, candidateNodeIds);

  if (decision === "node" && selectedNodeIds.length !== 1) throw new Error("knowledge_classification_agent1_single_selection_required");
  if (decision === "multiple" && (!availability.multiple || selectedNodeIds.length !== 2)) {
    throw new Error("knowledge_classification_agent1_multiple_selection_invalid");
  }
  if (decision === "stay" && (!availability.stay || selectedNodeIds.length)) throw new Error("knowledge_classification_agent1_stay_invalid");
  if (["unable", "none_of_candidates", "previous_level_wrong"].includes(decision) && selectedNodeIds.length) {
    throw new Error("knowledge_classification_agent1_control_selection_invalid");
  }
  if (decision === "previous_level_wrong" && !availability.previous_level_wrong) {
    throw new Error("knowledge_classification_agent1_previous_level_invalid");
  }

  let terminal = false;
  let terminalNodeIds = [];
  let stopReason = "";
  if (decision === "node") {
    const selected = selectedNodeIds[0];
    if (!(adjacency.childrenByParentId.get(selected) || []).length) {
      terminal = true;
      terminalNodeIds = [selected];
      stopReason = "leaf";
    }
  } else if (decision === "stay") {
    terminal = true;
    terminalNodeIds = [currentNodeId];
    stopReason = "stay";
  } else if (decision === "multiple") {
    terminal = true;
    terminalNodeIds = selectedNodeIds;
    stopReason = "multiple";
  } else {
    terminal = true;
    stopReason = decision;
  }
  return {
    questionId,
    parentNodeId: currentNodeId,
    candidateNodeIds,
    decision,
    selectedNodeIds,
    confidence: strictConfidence(raw.confidence, "knowledge_classification_agent1_confidence_invalid"),
    reason: cleanText(raw.reason, 1000),
    terminal,
    terminalNodeIds,
    stopReason,
    ...(raw.corePathStatus || raw.core_path_status ? {
      corePathStatus: cleanText(raw.corePathStatus || raw.core_path_status, 40),
    } : {}),
    ...(raw.auxiliaryGap || raw.auxiliary_gap ? {
      auxiliaryGap: raw.auxiliaryGap || raw.auxiliary_gap,
    } : {}),
    ...(Array.isArray(raw.candidateRejections) ? {
      candidateRejections: raw.candidateRejections,
    } : {}),
  };
}

function normalizeAgent1Trajectory(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("knowledge_classification_agent1_trajectory_invalid");
  const adjacency = ensureAdjacency(context.adjacency || context.nodes || []);
  const expectedQuestionId = String(context.questionId || raw.questionId || "");
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!rawSteps.length || rawSteps.length > 20) throw new Error("knowledge_classification_agent1_steps_invalid");
  let currentNodeId = String(context.startNodeId || "");
  const steps = [];
  rawSteps.forEach((step) => {
    if (steps.length && steps[steps.length - 1].terminal) throw new Error("knowledge_classification_agent1_step_after_terminal");
    const candidateNodeIds = uniqueIds(step.candidateNodeIds);
    const normalized = normalizeAgent1Output(step, {
      adjacency,
      questionId: expectedQuestionId,
      currentNodeId,
      candidateNodeIds,
    });
    if (!normalized.terminal) currentNodeId = normalized.selectedNodeIds[0];
    steps.push(normalized);
  });
  const last = steps[steps.length - 1];
  if (!last.terminal) throw new Error("knowledge_classification_agent1_trajectory_incomplete");
  const suppliedTerminalIds = uniqueIds(raw.terminalNodeIds || (raw.terminalNodeId ? [raw.terminalNodeId] : []), 2);
  if (suppliedTerminalIds.length && (suppliedTerminalIds.length !== last.terminalNodeIds.length
    || suppliedTerminalIds.some((id, index) => id !== last.terminalNodeIds[index]))) {
    throw new Error("knowledge_classification_agent1_terminal_mismatch");
  }
  const stopReason = String(raw.stopReason || last.stopReason);
  if (!AGENT1_STOP_REASONS.has(stopReason) || stopReason !== last.stopReason) {
    throw new Error("knowledge_classification_agent1_stop_reason_invalid");
  }
  return {
    questionId: expectedQuestionId,
    terminalNodeId: last.terminalNodeIds[0] || "",
    terminalNodeIds: last.terminalNodeIds,
    stopReason,
    confidence: raw.confidence === undefined
      ? Math.min(...steps.map((step) => step.confidence))
      : strictConfidence(raw.confidence, "knowledge_classification_agent1_confidence_invalid"),
    steps,
  };
}

function buildCandidateRound(adjacencyOrNodes, currentNodeId = "", options = {}) {
  const adjacency = ensureAdjacency(adjacencyOrNodes);
  const candidates = directChildCandidates(adjacency, currentNodeId, options);
  const candidateNodeIds = candidates.map((node) => node.id);
  return {
    parentNodeId: String(currentNodeId || ""),
    currentNode: currentNodeId ? { ...adjacency.byId.get(String(currentNodeId)) } : null,
    candidates,
    candidateNodeIds,
    controlOptions: controlOptionAvailability(adjacency, currentNodeId, candidateNodeIds),
  };
}

function batchByTerminalNode(results = [], options = {}) {
  const batchSize = Math.min(20, Math.max(1, Number(options.batchSize) || 10));
  const groups = new Map();
  const unresolvedQuestionIds = [];
  (Array.isArray(results) ? results : []).forEach((result) => {
    const questionId = String(result && result.questionId || "");
    const trajectories = Array.isArray(result && result.agent1Trajectories)
      ? result.agent1Trajectories : (Array.isArray(result && result.trajectories) ? result.trajectories : []);
    const terminalNodeIds = uniqueIds(trajectories.flatMap((trajectory) => (
      Array.isArray(trajectory.terminalNodeIds) ? trajectory.terminalNodeIds : [trajectory.terminalNodeId]
    )), 2);
    if (!questionId || !terminalNodeIds.length) {
      if (questionId) unresolvedQuestionIds.push(questionId);
      return;
    }
    const groupKey = terminalNodeIds.slice().sort().join("|");
    if (!groups.has(groupKey)) groups.set(groupKey, { terminalNodeIds: terminalNodeIds.slice().sort(), questionIds: [] });
    groups.get(groupKey).questionIds.push(questionId);
  });
  const batches = [];
  groups.forEach((group, groupKey) => {
    for (let index = 0; index < group.questionIds.length; index += batchSize) {
      batches.push({
        id: `${groupKey}:${Math.floor(index / batchSize) + 1}`,
        terminalNodeIds: group.terminalNodeIds,
        questionIds: group.questionIds.slice(index, index + batchSize),
      });
    }
  });
  return { batches, unresolvedQuestionIds: uniqueIds(unresolvedQuestionIds) };
}

function parentOf(adjacency, nodeId) {
  const node = adjacency.byId.get(nodeId);
  return node && node.parentId ? adjacency.byId.get(node.parentId) || null : null;
}

function normalizeGlobalRecoveryOutput(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("knowledge_classification_global_recovery_output_invalid");
  const adjacency = ensureAdjacency(context.adjacency || context.nodes || []);
  const expectedQuestionIds = uniqueIds(context.questionIds);
  if (!expectedQuestionIds.length) throw new Error("knowledge_classification_global_recovery_questions_required");
  const expectedSet = new Set(expectedQuestionIds);
  const rawRecoveries = Array.isArray(raw.recoveries) ? raw.recoveries : [];
  if (rawRecoveries.length !== expectedQuestionIds.length) throw new Error("knowledge_classification_global_recovery_result_count_mismatch");
  const offeredEvidenceByQuestion = context.evidenceChunkIdsByQuestion || {};
  const allowedNodeIds = context.allowedNodeIds ? new Set(uniqueIds(context.allowedNodeIds, 1000)) : null;
  const seen = new Set();
  const recoveries = rawRecoveries.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("knowledge_classification_global_recovery_item_invalid");
    const questionId = String(item.questionId || "");
    if (!expectedSet.has(questionId) || seen.has(questionId)) throw new Error("knowledge_classification_global_recovery_question_mismatch");
    seen.add(questionId);
    const decision = String(item.decision || "");
    if (!GLOBAL_RECOVERY_DECISIONS.has(decision)) throw new Error("knowledge_classification_global_recovery_decision_invalid");
    const primaryNodeId = String(item.primaryNodeId || "");
    const primaryNodeRole = normalizePrimaryNodeRole(item.primaryNodeRole, "knowledge_classification_global_recovery_primary_role_invalid");
    const requiredNodeIds = uniqueIds(item.requiredNodeIds, 8);
    if (decision === "recover") {
      const primary = adjacency.byId.get(primaryNodeId);
      if (!primary || primary.kind !== "knowledge") throw new Error("knowledge_classification_global_recovery_primary_invalid");
      if (!requiredNodeIds.length || (primaryNodeRole === "core" && !requiredNodeIds.includes(primaryNodeId))) {
        throw new Error("knowledge_classification_global_recovery_required_invalid");
      }
      if (requiredNodeIds.some((id) => adjacency.byId.get(id)?.kind !== "knowledge")) {
        throw new Error("knowledge_classification_global_recovery_required_invalid");
      }
      if (allowedNodeIds && (requiredNodeIds.some((id) => !allowedNodeIds.has(id)) || !allowedNodeIds.has(primaryNodeId))) {
        throw new Error("knowledge_classification_global_recovery_selection_outside_scope");
      }
      if (primaryNodeRole === "scope_anchor" && (requiredNodeIds.includes(primaryNodeId)
        || !requiredNodeIds.some((nodeId) => (
          isProperKnowledgeAncestor(adjacency, primaryNodeId, nodeId)
        )))) throw new Error("knowledge_classification_global_recovery_scope_anchor_invalid");
    } else if (primaryNodeId || requiredNodeIds.length) {
      throw new Error("knowledge_classification_global_recovery_unresolved_nodes_invalid");
    }
    const evidenceChunkIds = uniqueIds(item.evidenceChunkIds, 20);
    const offeredEvidence = offeredEvidenceByQuestion instanceof Map
      ? offeredEvidenceByQuestion.get(questionId) : offeredEvidenceByQuestion[questionId];
    if (offeredEvidence !== undefined) {
      const offeredSet = new Set(uniqueIds(offeredEvidence, 100));
      if (evidenceChunkIds.some((id) => !offeredSet.has(id))) throw new Error("knowledge_classification_global_recovery_evidence_invalid");
    }
    return {
      questionId,
      decision,
      primaryNodeId,
      primaryNodeRole,
      requiredNodeIds,
      confidence: strictConfidence(item.confidence, "knowledge_classification_global_recovery_confidence_invalid"),
      reason: cleanText(item.reason, 2000),
      uncertainty: cleanText(item.uncertainty, 1000),
      evidenceChunkIds,
    };
  });
  const byQuestion = new Map(recoveries.map((item) => [item.questionId, item]));
  return { recoveries: expectedQuestionIds.map((questionId) => byQuestion.get(questionId)) };
}

// 全空草稿对象视为"未提供草稿"。模型在 join_existing 时经常仍会带上
// candidateFamilyDraft 的空占位（各字段为空串或空数组）；若把它当成"字段不全的草稿"，
// 会直接抛 family_draft_required_invalid / fields_required，把本身正确的加入判定挡掉。
function isBlankCandidateFamilyDraft(raw = {}) {
  const blank = (value) => value == null
    || (typeof value === "string" && !value.trim())
    || (Array.isArray(value) && !value.length);
  const membership = raw.membership && typeof raw.membership === "object" ? raw.membership : {};
  return blank(raw.name)
    && blank(raw.focusKey)
    && blank(raw.coreKnowledgeNodeId)
    && blank(raw.knowledgeNodeId)
    && blank(raw.requiredKnowledgeNodeIds)
    && blank(raw.textbookAnchorNodeIds)
    && blank(raw.assessmentAction)
    && blank(raw.action)
    && blank(raw.inclusionBoundary)
    && blank(raw.exclusionBoundary)
    && blank(raw.textbookEvidence?.chunkIds)
    && blank(raw.evidenceChunkIds)
    && blank(raw.contributionKnowledgeNodeIds)
    && blank(membership.contributionKnowledgeNodeIds);
}

function normalizeCandidateFamilyDraft(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (isBlankCandidateFamilyDraft(raw)) return null;
  const adjacency = ensureAdjacency(context.adjacency || context.nodes || []);
  const coreKnowledgeNodeId = String(raw.coreKnowledgeNodeId || context.primaryNodeId || "");
  const coreNode = adjacency.byId.get(coreKnowledgeNodeId);
  if (!coreNode || coreNode.kind !== "knowledge") {
    throw new Error("knowledge_classification_family_draft_core_invalid");
  }
  const requiredKnowledgeNodeIds = uniqueIds(
    Array.isArray(raw.requiredKnowledgeNodeIds) ? raw.requiredKnowledgeNodeIds : context.requiredNodeIds || [],
    20,
  );
  if (!requiredKnowledgeNodeIds.length
    || requiredKnowledgeNodeIds.some((id) => adjacency.byId.get(id)?.kind !== "knowledge")) {
    throw new Error("knowledge_classification_family_draft_required_invalid");
  }
  const textbookAnchorNodeIds = uniqueIds([
    ...(Array.isArray(raw.textbookAnchorNodeIds) ? raw.textbookAnchorNodeIds : []),
    raw.knowledgeNodeId,
    ...(!raw.textbookAnchorNodeIds?.length && !raw.knowledgeNodeId ? [coreKnowledgeNodeId] : []),
  ].filter(Boolean), 20);
  if (!textbookAnchorNodeIds.length || textbookAnchorNodeIds.some((id) => !adjacency.byId.has(id))) {
    throw new Error("knowledge_classification_family_draft_anchor_invalid");
  }
  const name = cleanText(raw.name, 200);
  const focusKey = cleanText(raw.focusKey || context.focusKey, 240);
  const assessmentAction = cleanText(raw.assessmentAction || raw.action, 240);
  const inclusionBoundary = cleanText(raw.inclusionBoundary, 2000);
  const exclusionBoundary = cleanText(raw.exclusionBoundary, 2000);
  if (!name || !focusKey || !assessmentAction) {
    throw new Error("knowledge_classification_family_draft_fields_required");
  }
  const offeredEvidence = new Set(uniqueIds(context.evidenceChunkIds, 100));
  const evidenceChunkIds = uniqueIds(raw.textbookEvidence?.chunkIds || raw.evidenceChunkIds, 20);
  if (offeredEvidence.size && evidenceChunkIds.some((id) => !offeredEvidence.has(id))) {
    throw new Error("knowledge_classification_family_draft_evidence_invalid");
  }
  if (!evidenceChunkIds.length) throw new Error("knowledge_classification_family_draft_evidence_required");
  const rawMembership = raw.membership && typeof raw.membership === "object" ? raw.membership : {};
  const hasExplicitContribution = Object.prototype.hasOwnProperty.call(rawMembership, "contributionKnowledgeNodeIds")
    || Object.prototype.hasOwnProperty.call(raw, "contributionKnowledgeNodeIds");
  const contributionKnowledgeNodeIds = uniqueIds(hasExplicitContribution
    ? (rawMembership.contributionKnowledgeNodeIds || raw.contributionKnowledgeNodeIds)
    : requiredKnowledgeNodeIds.filter((nodeId) => uniqueIds(context.requiredNodeIds, 20).includes(nodeId)), 20);
  return {
    name,
    focusKey,
    coreKnowledgeNodeId,
    requiredKnowledgeNodeIds,
    textbookAnchorNodeIds,
    knowledgeNodeId: textbookAnchorNodeIds[0],
    assessmentAction,
    inclusionBoundary,
    exclusionBoundary,
    membership: {
      coverageRole: "required",
      contributionKnowledgeNodeIds,
    },
    textbookEvidence: {
      chunkIds: evidenceChunkIds,
      summary: cleanText(raw.textbookEvidence?.summary || raw.evidenceSummary, 1600),
    },
    reason: cleanText(raw.reason, 1600),
  };
}

function sameIdSet(left, right) {
  const leftIds = [...new Set((Array.isArray(left) ? left : []).map(String).filter(Boolean))].sort();
  const rightIds = [...new Set((Array.isArray(right) ? right : []).map(String).filter(Boolean))].sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

function familyRequiredKnowledgeNodeIds(family = {}) {
  return uniqueIds(family.requiredKnowledgeNodeIds, 20);
}

function validateRequiredFamilyCoverage(questionRequiredNodeIds, primaryNodeId, primaryFamily, relatedFamilies, options = {}) {
  const expected = uniqueIds(questionRequiredNodeIds, 20);
  const expectedSet = new Set(expected);
  const normalizeContribution = (rawContribution, family) => {
    const coverage = familyRequiredKnowledgeNodeIds(family);
    const explicit = rawContribution !== undefined;
    const contribution = uniqueIds(explicit ? rawContribution : coverage.filter((nodeId) => expectedSet.has(nodeId)), 20);
    if (!coverage.length || contribution.some((nodeId) => !expectedSet.has(nodeId) || !coverage.includes(nodeId))) {
      throw new Error("knowledge_classification_agent3_required_family_knowledge_invalid");
    }
    return contribution;
  };
  const primaryContribution = normalizeContribution(options.primaryContributionKnowledgeNodeIds, primaryFamily);
  if (!primaryContribution.length || (options.primaryNodeRole !== "scope_anchor"
    && !primaryContribution.includes(String(primaryNodeId || "")))) {
    throw new Error(options.coreMismatchError);
  }
  const memberships = [{
    familyId: String(primaryFamily?.id || ""),
    isPrimary: true,
    coverageRole: "required",
    contributionKnowledgeNodeIds: primaryContribution,
  }];
  (Array.isArray(relatedFamilies) ? relatedFamilies : []).forEach(({ family, relation }) => {
    const coverageRole = String(relation?.coverageRole || "");
    const hasExplicitContribution = relation?.contributionKnowledgeNodeIdsProvided === true;
    const contribution = normalizeContribution(
      hasExplicitContribution
        ? relation.contributionKnowledgeNodeIds
        : (coverageRole === "reference" ? [] : undefined),
      family,
    );
    if (coverageRole === "reference" && contribution.length) {
      throw new Error("knowledge_classification_agent3_reference_family_contribution_forbidden");
    }
    if (coverageRole === "required" && !contribution.length) {
      throw new Error("knowledge_classification_agent3_required_family_knowledge_invalid");
    }
    memberships.push({
      familyId: String(family?.id || ""),
      isPrimary: false,
      coverageRole,
      contributionKnowledgeNodeIds: coverageRole === "reference" ? [] : contribution,
    });
  });
  const covered = uniqueIds(memberships
    .filter((membership) => membership.isPrimary || membership.coverageRole === "required")
    .flatMap((membership) => membership.contributionKnowledgeNodeIds), 40);
  if (!sameIdSet(covered, expected)) throw new Error(options.mismatchError);
  return memberships;
}

function normalizeRequiredNodeAssessments(raw, context = {}) {
  const primaryNodeId = String(context.primaryNodeId || "");
  const expectedNodeIds = uniqueIds(context.requiredNodeIds, 8).filter((id) => id !== primaryNodeId);
  const assessments = Array.isArray(raw) ? raw : [];
  const assessmentIds = assessments.map((item) => String(item?.nodeId || "")).filter(Boolean);
  if (!sameIdSet(expectedNodeIds, assessmentIds) || assessments.length !== expectedNodeIds.length) {
    throw new Error("knowledge_classification_agent3_required_assessments_invalid");
  }
  const dependencySteps = new Map((Array.isArray(context.dependencySteps) ? context.dependencySteps : []).map((step, index) => {
    const ref = String(step?.ref || `dep-${index + 1}`);
    return [ref, { ...step, ref }];
  }));
  return expectedNodeIds.map((nodeId) => {
    const item = assessments.find((assessment) => String(assessment?.nodeId || "") === nodeId);
    const dependencyStepRefs = uniqueIds(item?.dependencyStepRefs, 12);
    if (!dependencyStepRefs.length || dependencyStepRefs.some((ref) => {
      const step = dependencySteps.get(ref);
      return !step || step.dependencyRole !== "independent_required" || step.coveredByStepRef;
    })) {
      throw new Error("knowledge_classification_agent3_required_assessment_refs_invalid");
    }
    if (item?.necessaryAfterDeletionTest !== true || !cleanText(item?.deletionTest, 1200) || !cleanText(item?.reason, 1200)) {
      throw new Error("knowledge_classification_agent3_required_deletion_test_failed");
    }
    if (item?.entailedByPrimaryRule !== false) {
      throw new Error("knowledge_classification_agent3_required_absorbed_by_core");
    }
    return {
      nodeId,
      dependencyStepRefs,
      necessaryAfterDeletionTest: true,
      deletionTest: cleanText(item.deletionTest, 1200),
      entailedByPrimaryRule: false,
      reason: cleanText(item.reason, 1200),
    };
  });
}

function normalizeOptionRelationAssessments(raw, context = {}) {
  const featureProfile = context.featureProfile || {};
  const sourceItems = featureProfile.choiceStructure === "composed_options"
    ? (featureProfile.atomicStatements || []) : (featureProfile.optionFeatures || []);
  const requiresV2Assessment = featureProfile.optionKnowledgeProtocolVersion === "option-knowledge-v2"
    && sourceItems.length > 0;
  if (raw == null) {
    if (requiresV2Assessment) throw new Error("knowledge_classification_agent3_option_relation_assessments_invalid");
    return [];
  }
  if (!Array.isArray(raw)) throw new Error("knowledge_classification_agent3_option_relation_assessments_invalid");
  const expected = sourceItems.map((item) => String(item?.key || "").toUpperCase()).filter(Boolean);
  const expectedSet = new Set(expected);
  const rawKeys = raw.map((item) => String(item?.key || "").toUpperCase()).filter(Boolean);
  if (raw.length !== expected.length || rawKeys.length !== new Set(rawKeys).size
    || expected.some((key) => !rawKeys.includes(key))) {
    throw new Error("knowledge_classification_agent3_option_relation_assessments_invalid");
  }
  const allowedNodeIds = context.allowedKnowledgeNodeIds instanceof Set
    ? context.allowedKnowledgeNodeIds : new Set(uniqueIds(context.allowedKnowledgeNodeIds, 100));
  const allowedEvidenceIds = new Set(uniqueIds(context.evidenceChunkIds, 100));
  const relations = new Set(["question_only", "option_specific", "undetermined"]);
  const decisions = new Set(["confirm", "dispute", "correction"]);
  const sourceByKey = new Map(sourceItems.map((item) => [String(item?.key || "").toUpperCase(), item]));
  return expected.map((key) => {
    const item = raw.find((candidate) => String(candidate?.key || "").toUpperCase() === key) || {};
    const decision = String(item.decision || "");
    if (!expectedSet.has(key) || !decisions.has(decision)) {
      throw new Error("knowledge_classification_agent3_option_relation_assessment_decision_invalid");
    }
    const source = sourceByKey.get(key) || {};
    const agent1KnowledgeRelation = String(source.knowledgeRelation || "unreviewed");
    const verifiedKnowledgeNodeIds = uniqueIds(item.verifiedKnowledgeNodeIds, 12);
    const proposedKnowledgeRelation = String(item.proposedKnowledgeRelation || "");
    const proposedKnowledgeNodeIds = uniqueIds(item.proposedKnowledgeNodeIds, 12);
    const evidenceChunkIds = uniqueIds(item.evidenceChunkIds, 12);
    const reason = cleanText(item.reason, 1200);
    if (!reason || (decision === "correction" && !relations.has(proposedKnowledgeRelation))) {
      throw new Error("knowledge_classification_agent3_option_relation_assessment_correction_invalid");
    }
    if (decision !== "correction" && (proposedKnowledgeRelation || proposedKnowledgeNodeIds.length)) {
      throw new Error("knowledge_classification_agent3_option_relation_assessment_correction_invalid");
    }
    if (decision === "confirm") {
      if (agent1KnowledgeRelation === "option_specific" && !verifiedKnowledgeNodeIds.length) {
        throw new Error("knowledge_classification_agent3_option_relation_assessment_nodes_invalid");
      }
      if (agent1KnowledgeRelation !== "option_specific" && verifiedKnowledgeNodeIds.length) {
        throw new Error("knowledge_classification_agent3_option_relation_assessment_nodes_invalid");
      }
    } else if (verifiedKnowledgeNodeIds.length) {
      throw new Error("knowledge_classification_agent3_option_relation_assessment_nodes_invalid");
    }
    if (decision === "correction") {
      if (proposedKnowledgeRelation === "option_specific" && !proposedKnowledgeNodeIds.length) {
        throw new Error("knowledge_classification_agent3_option_relation_assessment_nodes_invalid");
      }
      if (proposedKnowledgeRelation !== "option_specific" && proposedKnowledgeNodeIds.length) {
        throw new Error("knowledge_classification_agent3_option_relation_assessment_nodes_invalid");
      }
      if (proposedKnowledgeNodeIds.some((nodeId) => !allowedNodeIds.has(nodeId))) {
        throw new Error("knowledge_classification_agent3_option_relation_assessment_nodes_invalid");
      }
    }
    if (verifiedKnowledgeNodeIds.some((nodeId) => !allowedNodeIds.has(nodeId))) {
      throw new Error("knowledge_classification_agent3_option_relation_assessment_nodes_invalid");
    }
    if (allowedEvidenceIds.size && evidenceChunkIds.some((id) => !allowedEvidenceIds.has(id))) {
      throw new Error("knowledge_classification_agent3_option_relation_assessment_evidence_invalid");
    }
    if (allowedEvidenceIds.size && !evidenceChunkIds.length) {
      throw new Error("knowledge_classification_agent3_option_relation_assessment_evidence_required");
    }
    return {
      key,
      agent1KnowledgeRelation,
      decision,
      verifiedKnowledgeNodeIds: decision === "confirm" && agent1KnowledgeRelation === "option_specific"
        ? verifiedKnowledgeNodeIds : [],
      proposedKnowledgeRelation: decision === "correction" ? proposedKnowledgeRelation : "",
      proposedKnowledgeNodeIds: decision === "correction" && proposedKnowledgeRelation === "option_specific"
        ? proposedKnowledgeNodeIds : [],
      evidenceChunkIds,
      reason,
    };
  });
}

function validateAgent3VerificationContract(verification, context = {}) {
  if (!verification || typeof verification !== "object") throw new Error("knowledge_classification_agent2_verification_invalid");
  const unresolved = ["unable", "missing_node"].includes(verification.decision);
  const requiredNodeAssessments = unresolved ? [] : normalizeRequiredNodeAssessments(
    context.rawVerification?.requiredNodeAssessments,
    {
      primaryNodeId: verification.primaryNodeId,
      primaryNodeRole: verification.primaryNodeRole,
      requiredNodeIds: verification.requiredNodeIds,
      dependencySteps: context.dependencySteps,
    },
  );
  const optionRelationAssessments = normalizeOptionRelationAssessments(
    context.rawVerification?.optionRelationAssessments,
    {
      featureProfile: context.featureProfile,
      allowedKnowledgeNodeIds: context.allowedKnowledgeNodeIds,
      evidenceChunkIds: context.evidenceChunkIds,
    },
  );
  const rawFamilyDecision = String(context.rawVerification?.familyDecision || "");
  if (rawFamilyDecision && !FAMILY_DECISIONS.has(rawFamilyDecision)) {
    throw new Error("knowledge_classification_agent3_family_decision_invalid");
  }
  const familyDecision = FAMILY_DECISIONS.has(String(verification.familyDecision || ""))
    ? String(verification.familyDecision) : "unresolved";
  if (!unresolved && rawFamilyDecision === "unresolved" && context.allowUnresolvedFamilyDecision !== true) {
    throw new Error("knowledge_classification_agent3_family_decision_required");
  }
  const primaryFamilyId = String(verification.primaryFamilyId || "");
  const candidateFamilies = Array.isArray(context.candidateFamilies) ? context.candidateFamilies : [];
  const validFamilyIds = new Set(candidateFamilies.map((family) => String(family?.id || "")).filter(Boolean));
  const validateFamilyRefs = (value) => {
    if (value == null) return;
    if (!Array.isArray(value)) throw new Error("knowledge_classification_agent3_family_refs_invalid");
    const ids = value.map((id) => String(id || ""));
    if (ids.some((id) => !id || !validFamilyIds.has(id))) {
      throw new Error("knowledge_classification_agent3_family_refs_invalid");
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error("knowledge_classification_agent3_family_refs_duplicate");
    }
  };
  if (primaryFamilyId && !validFamilyIds.has(primaryFamilyId)) {
    throw new Error("knowledge_classification_agent3_family_refs_invalid");
  }
  validateFamilyRefs(context.rawVerification?.matchedFamilyIds);
  validateFamilyRefs(context.rawVerification?.duplicateFamilyIds);
  const relatedFamilyPolicy = validateRelatedFamilySuggestionsContract({
    validFamilyIds,
    primaryFamilyId,
    rawRelatedFamilyIds: context.rawVerification?.relatedFamilyIds,
    rawRelations: context.rawVerification?.relatedFamilyRelations,
    rawAssessments: context.rawVerification?.relatedFamilyAssessments,
  });
  const relatedFamilyRelationById = new Map(relatedFamilyPolicy.relatedFamilyRelations
    .map((relation) => [relation.familyId, relation]));
  const selectedRelatedFamilies = relatedFamilyPolicy.relatedFamilyIds.map((familyId) => {
    const family = candidateFamilies.find((item) => String(item?.id || "") === familyId);
    if (!family || family.status !== "confirmed") {
      throw new Error("knowledge_classification_agent3_related_family_not_confirmed");
    }
    return { family, relation: relatedFamilyRelationById.get(familyId) };
  });
  let familyMemberships = [];
  let familyActionRisk = null;
  if (familyDecision === "join_existing") {
    if (!primaryFamilyId) throw new Error("knowledge_classification_agent3_join_primary_required");
    const family = candidateFamilies.find((item) => String(item?.id || "") === primaryFamilyId);
    if (!family || family.status !== "confirmed") {
      throw new Error("knowledge_classification_agent3_join_family_not_confirmed");
    }
    familyMemberships = validateRequiredFamilyCoverage(
      verification.requiredNodeIds,
      verification.primaryNodeId,
      family,
      selectedRelatedFamilies,
      {
        primaryContributionKnowledgeNodeIds: context.rawVerification?.primaryFamilyContributionKnowledgeNodeIds,
        primaryNodeRole: verification.primaryNodeRole,
        coreMismatchError: "knowledge_classification_agent3_join_core_mismatch",
        mismatchError: "knowledge_classification_agent3_join_required_set_mismatch",
      },
    );
    // 考查动作只作参考信号，不再作为"能否加入现有题族"的门禁。
    // 实测依据：100 个已确认题族里 74% 把考查动作写成同一个"概念识别"标签（退化为常量），
    // 10 种取值里有 4 种连系统自己的语义分类器都认不出，且约 20% 的题族成员本身跨多个动作类型。
    // 用这样一个近乎恒定、且人机取值口径不一致的字段去门禁，会把合法成员整族挡掉
    // （校准轮实测 18/18 全部不匹配、成熟题族 7/7 因此误判）。
    // 一致性改为记录风险，供人工审核时参考；真正的门禁仍是核心知识、最小充分知识集覆盖与边界适用性。
    const actionComparison = compareAssessmentActions(verification.action, family.assessmentAction);
    if (!actionComparison.match) {
      familyActionRisk = {
        code: "family_action_mismatch",
        familyId: String(family.id || ""),
        familyAction: String(family.assessmentAction || ""),
        predicted: actionComparison.predicted,
        expected: actionComparison.expected,
        method: actionComparison.method,
        similarity: actionComparison.similarity,
      };
    }
  } else if (primaryFamilyId) {
    throw new Error("knowledge_classification_agent3_primary_family_unexpected");
  }
  if (familyDecision === "create_new") {
    const draft = verification.candidateFamilyDraft;
    const candidateMemberships = validateRequiredFamilyCoverage(
      verification.requiredNodeIds,
      verification.primaryNodeId,
      draft,
      selectedRelatedFamilies,
      {
        primaryContributionKnowledgeNodeIds: draft?.membership?.contributionKnowledgeNodeIds,
        primaryNodeRole: verification.primaryNodeRole,
        coreMismatchError: "knowledge_classification_agent3_draft_core_mismatch",
        mismatchError: "knowledge_classification_agent3_draft_required_set_mismatch",
      },
    );
    verification.candidateFamilyDraft = {
      ...draft,
      membership: {
        coverageRole: "required",
        contributionKnowledgeNodeIds: candidateMemberships[0].contributionKnowledgeNodeIds,
      },
    };
    familyMemberships = candidateMemberships.slice(1);
    const allowedKnowledgeNodeIds = context.allowedKnowledgeNodeIds instanceof Set
      ? context.allowedKnowledgeNodeIds
      : new Set(uniqueIds(context.allowedKnowledgeNodeIds, 100));
    if (allowedKnowledgeNodeIds.size && (draft?.textbookAnchorNodeIds || [])
      .some((nodeId) => !allowedKnowledgeNodeIds.has(String(nodeId)))) {
      throw new Error("knowledge_classification_agent3_draft_anchor_outside_candidates");
    }
  }
  const contributionByFamilyId = new Map(familyMemberships
    .map((membership) => [membership.familyId, membership.contributionKnowledgeNodeIds]));
  const relatedFamilyRelations = relatedFamilyPolicy.relatedFamilyRelations.map((relation) => ({
    familyId: relation.familyId,
    coverageRole: relation.coverageRole,
    requiredForAnswer: relation.coverageRole === "required",
    contributionKnowledgeNodeIds: contributionByFamilyId.get(relation.familyId) || [],
  }));
  const primaryMembership = familyMemberships.find((membership) => membership.isPrimary);
  return {
    ...verification,
    familyDecision,
    primaryFamilyId,
    relatedFamilyIds: relatedFamilyPolicy.relatedFamilyIds,
    relatedFamilyRelations,
    relatedFamilyAssessments: relatedFamilyPolicy.assessments,
    familyMemberships,
    familyActionRisk,
    primaryFamilyContributionKnowledgeNodeIds: primaryMembership?.contributionKnowledgeNodeIds || [],
    requiredNodeAssessments,
    optionRelationAssessments,
  };
}

function isAgent3ContractError(error) {
  return AGENT3_CONTRACT_ERRORS.has(String(error?.message || error || ""));
}

function normalizeAgent2Output(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("knowledge_classification_agent2_output_invalid");
  const adjacency = ensureAdjacency(context.adjacency || context.nodes || []);
  const expectedQuestionIds = uniqueIds(context.questionIds);
  if (!expectedQuestionIds.length) throw new Error("knowledge_classification_agent2_questions_required");
  const expectedSet = new Set(expectedQuestionIds);
  const rawVerifications = Array.isArray(raw.verifications) ? raw.verifications : [];
  if (rawVerifications.length !== expectedQuestionIds.length) throw new Error("knowledge_classification_agent2_result_count_mismatch");
  const seen = new Set();
  const terminalByQuestion = context.terminalNodeIdsByQuestion || {};
  const offeredEvidenceByQuestion = context.evidenceChunkIdsByQuestion || {};

  const verifications = rawVerifications.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("knowledge_classification_agent2_verification_invalid");
    const questionId = String(item.questionId || "");
    if (!expectedSet.has(questionId) || seen.has(questionId)) throw new Error("knowledge_classification_agent2_question_mismatch");
    seen.add(questionId);
    const decision = String(item.decision || "");
    if (!AGENT2_DECISIONS.has(decision)) throw new Error("knowledge_classification_agent2_decision_invalid");
    const terminalNodeIds = uniqueIds(terminalByQuestion instanceof Map
      ? terminalByQuestion.get(questionId) : terminalByQuestion[questionId], 2);
    const terminalSet = new Set(terminalNodeIds);
    const primaryNodeId = String(item.primaryNodeId || "");
    const primaryNodeRole = normalizePrimaryNodeRole(item.primaryNodeRole);
    const requiredNodeIds = uniqueIds(item.requiredNodeIds, 8);
    const unresolved = ["unable", "missing_node"].includes(decision);
    if (unresolved) {
      if (primaryNodeId || requiredNodeIds.length) throw new Error("knowledge_classification_agent2_unresolved_nodes_invalid");
    } else {
      const primary = adjacency.byId.get(primaryNodeId);
      if (!primary || primary.kind !== "knowledge") throw new Error("knowledge_classification_agent2_primary_node_invalid");
      if (!requiredNodeIds.length || (primaryNodeRole === "core" && !requiredNodeIds.includes(primaryNodeId))) {
        throw new Error("knowledge_classification_agent2_required_nodes_invalid");
      }
      if (requiredNodeIds.some((id) => !adjacency.byId.has(id) || adjacency.byId.get(id).kind !== "knowledge")) {
        throw new Error("knowledge_classification_agent2_required_nodes_invalid");
      }
      if (primaryNodeRole === "scope_anchor" && (requiredNodeIds.includes(primaryNodeId)
        || !requiredNodeIds.some((nodeId) => (
          isProperKnowledgeAncestor(adjacency, primaryNodeId, nodeId)
        )))) throw new Error("knowledge_classification_agent2_scope_anchor_invalid");
      if (decision === "confirm" && !terminalSet.has(primaryNodeId)) throw new Error("knowledge_classification_agent2_confirm_mismatch");
      if (decision === "move_parent") {
        const validParents = new Set(terminalNodeIds.map((id) => parentOf(adjacency, id)?.id).filter(Boolean));
        if (!validParents.has(primaryNodeId)) throw new Error("knowledge_classification_agent2_parent_mismatch");
      }
      if (decision === "move_sibling") {
        const siblingIds = new Set(terminalNodeIds.flatMap((id) => {
          const terminal = adjacency.byId.get(id);
          return terminal ? (adjacency.childrenByParentId.get(terminal.parentId) || []).map((node) => node.id) : [];
        }).filter((id) => !terminalSet.has(id)));
        if (!siblingIds.has(primaryNodeId)) throw new Error("knowledge_classification_agent2_sibling_mismatch");
      }
      if (decision === "cross_knowledge" && requiredNodeIds.length < 2) {
        throw new Error("knowledge_classification_agent2_cross_knowledge_required");
      }
      if (decision !== "cross_knowledge" && requiredNodeIds.length !== 1) {
        throw new Error("knowledge_classification_agent2_single_knowledge_required");
      }
    }
    const focusKey = cleanText(item.focusKey, 240);
    const focusLabel = cleanText(item.focusLabel, 200);
    const action = cleanText(item.action, 80);
    if (!unresolved && (!focusKey || !focusLabel || !action)) throw new Error("knowledge_classification_agent2_focus_required");
    const evidenceChunkIds = uniqueIds(item.evidenceChunkIds, 20);
    const offeredEvidence = offeredEvidenceByQuestion instanceof Map
      ? offeredEvidenceByQuestion.get(questionId) : offeredEvidenceByQuestion[questionId];
    if (offeredEvidence !== undefined) {
      const offeredSet = new Set(uniqueIds(offeredEvidence, 100));
      if (evidenceChunkIds.some((id) => !offeredSet.has(id))) throw new Error("knowledge_classification_agent2_evidence_invalid");
    }
    const familyDecision = FAMILY_DECISIONS.has(String(item.familyDecision || ""))
      ? String(item.familyDecision) : "unresolved";
    const candidateFamilyDraft = normalizeCandidateFamilyDraft(item.candidateFamilyDraft, {
      adjacency,
      primaryNodeId,
      requiredNodeIds,
      focusKey,
      evidenceChunkIds: offeredEvidence,
    });
    if (familyDecision === "create_new" && !candidateFamilyDraft) {
      throw new Error("knowledge_classification_family_draft_required");
    }
    if (familyDecision !== "create_new" && candidateFamilyDraft) {
      throw new Error("knowledge_classification_family_draft_unexpected");
    }
    return {
      questionId,
      decision,
      primaryNodeId,
      primaryNodeRole,
      requiredNodeIds,
      focusKey,
      focusLabel,
      action,
      confidence: strictConfidence(item.confidence, "knowledge_classification_agent2_confidence_invalid"),
      reason: cleanText(item.reason, 2000),
      uncertainty: cleanText(item.uncertainty, 1000),
      evidenceChunkIds,
      familyDecision,
      candidateFamilyDraft,
    };
  });
  const byQuestion = new Map(verifications.map((item) => [item.questionId, item]));
  return { verifications: expectedQuestionIds.map((questionId) => byQuestion.get(questionId)) };
}

module.exports = {
  AGENT1_DECISIONS,
  AGENT2_DECISIONS,
  AGENT2_CORE_PATH_STATUSES,
  AGENT2_NAVIGATION_CONTRACT_ERRORS,
  AGENT3_CONTRACT_ERRORS,
  batchByTerminalNode,
  buildKnowledgeAdjacency,
  controlOptionAvailability,
  directChildCandidates,
  normalizeAgent1Output,
  normalizeAgent1Trajectory,
  normalizeAgent2NavigationOutput,
  isAgent2NavigationContractError,
  isAgent3ContractError,
  normalizeAgent2Output,
  normalizeRequiredNodeAssessments,
  normalizeOptionRelationAssessments,
  validateAgent3VerificationContract,
  normalizeGlobalRecoveryOutput,
  normalizeCandidateFamilyDraft,
  buildHierarchyIndex: buildKnowledgeAdjacency,
  buildCandidateRound,
  normalizeNavigationDecision: normalizeAgent1Output,
  groupForVerification: batchByTerminalNode,
  normalizeBatchVerification: normalizeAgent2Output,
};
