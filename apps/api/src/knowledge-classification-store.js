const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  SUGGESTION_SOURCES,
  normalizeSuggestionSource,
  normalizeSuggestionReviewStatus,
} = require("./suggestion-lifecycle");

const MAX_JOBS = 200;
const MAX_RESULTS = 10000;

const jobStatuses = new Set(["queued", "running", "completed", "partial", "failed", "interrupted"]);
const jobStages = new Set(["queued", "agent1", "agent2", "pipeline", "review", "completed", "failed", "interrupted"]);
const resultStatuses = new Set(["queued", "processing", "pending_review", "applied", "rejected", "failed", "interrupted", "stale"]);
const agent1Statuses = new Set(["pending", "running", "completed", "uncertain", "failed", "interrupted"]);
const agent2Statuses = new Set(["pending", "running", "completed", "uncertain", "skipped", "failed", "interrupted"]);
const featureHandoffStatuses = new Set(["completed", "fallback"]);
const classificationOutcomes = new Set([
  "",
  "auxiliary_gap",
  "agent1_contract_failed",
  "agent2_contract_failed",
  "semantic_no_candidate",
  "provider_or_infrastructure_failed",
  // 缺条件跳过：题目没有教材上下文（教材/章节/知识点暂缺），Agent 无法工作。
  // 与上面几种「跑了但失败」不同，这一类是「没条件跑」，必须显式记录而不是无限重试。
  // 见 docs/modules/03-knowledge-fingerprint-agent-classification.md。
  "missing_textbook_context",
]);
const navigationDiagnosticStatuses = new Set(["valid", "format_invalid", "contract_invalid", "transport_failed"]);
const primaryNodeRoles = new Set(["core", "scope_anchor"]);
// AI 巡检记录的四态（产品手册 §4.6.12【已确认 2026-09-26，DEC-100】）：
// 巡检只诊断不改库，所以记录状态只表达"人有没有看过、看过后怎么处置"，不再是原来的五张卡片。
// 「归为通过」是 AI／规则的结论，不是记录状态——通过 ≠ 已复核。
const AUDIT_REVIEW_STATES = new Set(["pending_review", "reviewed", "repaired", "ignored"]);
const DEFAULT_AUDIT_REVIEW_STATE = "pending_review";
const { normalizeFeatureProfile } = require("./question-classification-features");
const { filterRelatedFamilySuggestions } = require("./classification-verification-policy");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanText(value, limit = 1000) {
  return String(value || "").trim().slice(0, limit);
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function normalizeKnowledgeRevisionFormat(value) {
  return value === "topology-v1" ? "topology-v1" : "legacy-updated-at";
}

function normalizePrimaryNodeRole(value) {
  const role = String(value || "").trim();
  return primaryNodeRoles.has(role) ? role : "core";
}

// 巡检记录的复核状态（白名单之外的输入一律归一为 pending_review）。
function normalizeAuditReviewState(value) {
  const state = String(value || "").trim();
  return AUDIT_REVIEW_STATES.has(state) ? state : DEFAULT_AUDIT_REVIEW_STATE;
}

/**
 * 复核留痕：{ state, note(≤1000), actor(≤100), actorLabel(≤100), at }。
 * `actor` 是**登录账号名**（审计要能唯一定位账号，展示名会重名、也会改）；
 * `actorLabel` 是同时记下的展示名，界面想显示中文名就用它。
 * 缺省是待复核（历史记录没有这个字段时读出来也是待复核，不改历史文件）。
 * `at` 表示**这四态上一次被人工改动**的时刻，没动过就是 null。
 */
function normalizeAuditReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { state: DEFAULT_AUDIT_REVIEW_STATE, note: "", actor: "", actorLabel: "", at: null };
  }
  const at = Number(value.at);
  return {
    state: normalizeAuditReviewState(value.state),
    note: cleanText(value.note, 1000),
    actor: cleanText(value.actor, 100),
    actorLabel: cleanText(value.actorLabel, 100),
    at: Number.isFinite(at) && at > 0 ? at : null,
  };
}

function normalizeQuestionVersions(value, questionIds = []) {
  const allowed = new Set(questionIds.map(String));
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([questionId, version]) => {
    const id = String(questionId || "");
    const normalized = Number(version);
    if (!id || (allowed.size && !allowed.has(id)) || !Number.isFinite(normalized) || normalized < 0) return [];
    return [[id, normalized]];
  }));
}

function normalizeClassificationBaseline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const knowledgeFingerprintSignature = cleanText(value.knowledgeFingerprintSignature, 128);
  const familyMembershipSignature = cleanText(value.familyMembershipSignature, 128);
  if (!knowledgeFingerprintSignature || !familyMembershipSignature) return null;
  return { knowledgeFingerprintSignature, familyMembershipSignature };
}

function normalizeClassificationBaselines(value, questionIds = []) {
  const allowed = new Set(questionIds.map(String));
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([questionId, baseline]) => {
    const id = String(questionId || "");
    const normalized = normalizeClassificationBaseline(baseline);
    if (!id || (allowed.size && !allowed.has(id)) || !normalized) return [];
    return [[id, normalized]];
  }));
}

function normalizeAgent1FeatureHandoff(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.features || typeof value.features !== "object" || Array.isArray(value.features)) return null;
  const features = normalizeFeatureProfile(value.features);
  const source = value.source === "model" ? "model" : "heuristic";
  return {
    status: featureHandoffStatuses.has(value.status) ? value.status : (source === "model" ? "completed" : "fallback"),
    source,
    sceneId: cleanText(value.sceneId || "knowledge_feature_extraction", 100),
    configuredSceneId: cleanText(value.configuredSceneId, 100),
    model: cleanText(value.model, 200),
    warning: cleanText(value.warning, 500),
    diagnostics: normalizeAgent1FeatureDiagnostics(value.diagnostics),
    rawFeatures: value.rawFeatures && typeof value.rawFeatures === "object" && !Array.isArray(value.rawFeatures)
      ? clone(value.rawFeatures) : null,
    savedAt: Number(value.savedAt) || Date.now(),
    features,
  };
}

function normalizeAgent1FeatureDiagnostics(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    contractAttempt: Math.min(2, Math.max(1, Number(item?.contractAttempt) || 1)),
    taskId: String(item?.taskId || ""),
    retryOfTaskId: String(item?.retryOfTaskId || ""),
    status: ["valid", "contract_invalid", "transport_failed"].includes(item?.status)
      ? item.status : "contract_invalid",
    errorCode: cleanText(item?.errorCode, 200),
    violations: (Array.isArray(item?.violations) ? item.violations : []).map((violation) => ({
      code: cleanText(violation?.code, 120),
      detail: cleanText(violation?.detail, 500),
    })).filter((violation) => violation.code).slice(0, 30),
    createdAt: Number(item?.createdAt) || Date.now(),
  })).slice(0, 2);
}

function normalizeAgent1Step(step = {}) {
  const auxiliaryGap = step.auxiliaryGap && typeof step.auxiliaryGap === "object" && !Array.isArray(step.auxiliaryGap)
    ? {
      type: "auxiliary_gap",
      dependencyStepRefs: [...new Set((Array.isArray(step.auxiliaryGap.dependencyStepRefs)
        ? step.auxiliaryGap.dependencyStepRefs : []).map(String).filter(Boolean))].slice(0, 12),
      dependencies: (Array.isArray(step.auxiliaryGap.dependencies) ? step.auxiliaryGap.dependencies : []).map((item) => ({
        ref: cleanText(item?.ref, 40),
        label: cleanText(item?.label, 240),
        nodeIds: [...new Set((Array.isArray(item?.nodeIds) ? item.nodeIds : []).map(String).filter(Boolean))].slice(0, 20),
        necessity: cleanText(item?.necessity, 40),
      })).filter((item) => item.ref).slice(0, 12),
      reason: cleanText(step.auxiliaryGap.reason, 1000),
    } : null;
  return {
    parentNodeId: String(step.parentNodeId || ""),
    candidateNodeIds: [...new Set((Array.isArray(step.candidateNodeIds) ? step.candidateNodeIds : []).map(String).filter(Boolean))].slice(0, 5),
    decision: cleanText(step.decision, 40),
    selectedNodeIds: [...new Set((Array.isArray(step.selectedNodeIds) ? step.selectedNodeIds : []).map(String).filter(Boolean))].slice(0, 2),
    confidence: Math.min(1, Math.max(0, Number(step.confidence) || 0)),
    reason: cleanText(step.reason, 1000),
    terminal: step.terminal === true,
    terminalNodeIds: [...new Set((Array.isArray(step.terminalNodeIds) ? step.terminalNodeIds : []).map(String).filter(Boolean))].slice(0, 2),
    stopReason: cleanText(step.stopReason, 40),
    corePathStatus: cleanText(step.corePathStatus, 40),
    auxiliaryGap,
    candidateRejections: (Array.isArray(step.candidateRejections) ? step.candidateRejections : []).map((item) => ({
      nodeId: String(item?.nodeId || ""),
      reason: cleanText(item?.reason, 500),
    })).filter((item) => item.nodeId && item.reason).slice(0, 5),
  };
}

function normalizeAgent2NavigationDiagnostic(value = {}) {
  const parsedOutput = value.parsedOutput && typeof value.parsedOutput === "object"
    ? clone(value.parsedOutput) : null;
  return {
    depth: Math.max(1, Number(value.depth) || 1),
    parentNodeId: String(value.parentNodeId || ""),
    candidateNodeIds: [...new Set((Array.isArray(value.candidateNodeIds) ? value.candidateNodeIds : [])
      .map(String).filter(Boolean))].slice(0, 5),
    contractAttempt: Math.min(2, Math.max(1, Number(value.contractAttempt) || 1)),
    taskId: String(value.taskId || ""),
    retryOfTaskId: String(value.retryOfTaskId || ""),
    status: navigationDiagnosticStatuses.has(value.status) ? value.status : "contract_invalid",
    errorCode: cleanText(value.errorCode, 200),
    rawOutput: cleanText(value.rawOutput, 12000),
    parsedOutput,
    createdAt: Number(value.createdAt) || Date.now(),
  };
}

function normalizeAgent1Trajectory(trajectory = {}) {
  const terminalNodeIds = [...new Set([
    ...(Array.isArray(trajectory.terminalNodeIds) ? trajectory.terminalNodeIds : []),
    trajectory.terminalNodeId,
  ].map(String).filter(Boolean))].slice(0, 2);
  return {
    terminalNodeId: terminalNodeIds[0] || "",
    terminalNodeIds,
    stopReason: cleanText(trajectory.stopReason, 40),
    confidence: Math.min(1, Math.max(0, Number(trajectory.confidence) || 0)),
    steps: (Array.isArray(trajectory.steps) ? trajectory.steps : []).map(normalizeAgent1Step).slice(0, 20),
  };
}

function normalizeCandidateFamilyDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const coreKnowledgeNodeId = String(value.coreKnowledgeNodeId || "");
  const requiredKnowledgeNodeIds = [...new Set((Array.isArray(value.requiredKnowledgeNodeIds)
    ? value.requiredKnowledgeNodeIds : []).map(String).filter(Boolean))].slice(0, 20);
  const textbookAnchorNodeIds = [...new Set([
    ...(Array.isArray(value.textbookAnchorNodeIds) ? value.textbookAnchorNodeIds : []),
    value.knowledgeNodeId,
  ].map(String).filter(Boolean))].slice(0, 20);
  const name = cleanText(value.name, 200);
  const assessmentAction = cleanText(value.assessmentAction, 240);
  const inclusionBoundary = cleanText(value.inclusionBoundary, 2000);
  const exclusionBoundary = cleanText(value.exclusionBoundary, 2000);
  if (!name || !coreKnowledgeNodeId || !requiredKnowledgeNodeIds.length
    || !textbookAnchorNodeIds.length || !assessmentAction) return null;
  const rawMembership = value.membership && typeof value.membership === "object" ? value.membership : {};
  const contributionKnowledgeNodeIds = [...new Set((Array.isArray(rawMembership.contributionKnowledgeNodeIds)
    ? rawMembership.contributionKnowledgeNodeIds
    : (Array.isArray(value.contributionKnowledgeNodeIds) ? value.contributionKnowledgeNodeIds : []))
    .map(String).filter(Boolean))].slice(0, 20);
  return {
    name,
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
      chunkIds: [...new Set((Array.isArray(value.textbookEvidence?.chunkIds) ? value.textbookEvidence.chunkIds : []).map(String).filter(Boolean))].slice(0, 20),
      summary: cleanText(value.textbookEvidence?.summary, 1600),
    },
    reason: cleanText(value.reason, 1600),
  };
}

function normalizeClassificationRiskHints(value) {
  const hints = Array.isArray(value) ? value : [];
  const seen = new Set();
  return hints.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const type = cleanText(item.type, 80);
    const source = cleanText(item.source, 80);
    const nodeId = String(item.nodeId || "");
    const title = cleanText(item.title, 200);
    const message = cleanText(item.message, 1200);
    const key = [type, source, nodeId, message].join("\u0000");
    if (!type || !message || seen.has(key)) return [];
    seen.add(key);
    return [{ type, source, nodeId, title, message, requiresHumanReview: item.requiresHumanReview !== false }];
  }).slice(0, 20);
}

function normalizeRequiredNodeAssessments(value) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const nodeId = String(item?.nodeId || "");
    const dependencyStepRefs = [...new Set((Array.isArray(item?.dependencyStepRefs) ? item.dependencyStepRefs : [])
      .map(String).filter(Boolean))].slice(0, 12);
    if (!nodeId || !dependencyStepRefs.length) return [];
    return [{
      nodeId,
      dependencyStepRefs,
      necessaryAfterDeletionTest: item.necessaryAfterDeletionTest === true,
      deletionTest: cleanText(item.deletionTest, 1200),
      entailedByPrimaryRule: item.entailedByPrimaryRule === true,
      reason: cleanText(item.reason, 1200),
    }];
  }).slice(0, 8);
}

function normalizeOptionRelationAssessments(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    key: cleanText(item?.key, 40).toUpperCase(),
    agent1KnowledgeRelation: cleanText(item?.agent1KnowledgeRelation, 40),
    decision: ["confirm", "dispute", "correction"].includes(item?.decision) ? item.decision : "dispute",
    verifiedKnowledgeNodeIds: [...new Set((Array.isArray(item?.verifiedKnowledgeNodeIds)
      ? item.verifiedKnowledgeNodeIds : []).map(String).filter(Boolean))].slice(0, 12),
    proposedKnowledgeRelation: cleanText(item?.proposedKnowledgeRelation, 40),
    proposedKnowledgeNodeIds: [...new Set((Array.isArray(item?.proposedKnowledgeNodeIds)
      ? item.proposedKnowledgeNodeIds : []).map(String).filter(Boolean))].slice(0, 12),
    evidenceChunkIds: [...new Set((Array.isArray(item?.evidenceChunkIds)
      ? item.evidenceChunkIds : []).map(String).filter(Boolean))].slice(0, 12),
    reason: cleanText(item?.reason, 1200),
  })).filter((item) => item.key).slice(0, 24);
}

function normalizeAgent3Diagnostics(value) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    return [{
      contractAttempt: Math.min(2, Math.max(1, Number(item.contractAttempt) || 1)),
      taskId: String(item.taskId || ""),
      retryOfTaskId: String(item.retryOfTaskId || ""),
      status: ["contract_invalid", "transport_failed", "valid", "degraded"].includes(item.status) ? item.status : "contract_invalid",
      errorCode: cleanText(item.errorCode, 500),
      // 与 Agent 2 导航诊断口径一致：保留模型原始输出与解析结果，便于事后逐层核对
      // （模型原始输出 / 合同校验后结果 / 最终采用结果）。
      rawOutput: cleanText(item.rawOutput, 12000),
      parsedOutput: item.parsedOutput && typeof item.parsedOutput === "object" ? clone(item.parsedOutput) : null,
      createdAt: Number(item.createdAt) || Date.now(),
    }];
  }).slice(0, 6);
}

function normalizeFamilyActionRisk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const side = (input) => ({
    type: cleanText(input?.type, 60),
    label: cleanText(input?.label, 120),
    normalizedText: cleanText(input?.normalizedText, 600),
  });
  return {
    code: cleanText(value.code, 60) || "family_action_mismatch",
    familyId: String(value.familyId || ""),
    familyAction: cleanText(value.familyAction, 600),
    predicted: side(value.predicted),
    expected: side(value.expected),
    method: cleanText(value.method, 60),
    similarity: Math.min(1, Math.max(0, Number(value.similarity) || 0)),
  };
}

function normalizeFamilyMemberships(value) {
  const seenFamilyIds = new Set();
  return (Array.isArray(value) ? value : []).flatMap((membership) => {
    const familyId = String(membership?.familyId || "");
    if (!familyId || seenFamilyIds.has(familyId)) return [];
    seenFamilyIds.add(familyId);
    const isPrimary = membership?.isPrimary === true;
    const coverageRole = isPrimary
      ? "required"
      : (["required", "reference"].includes(String(membership?.coverageRole || ""))
        ? String(membership.coverageRole) : "");
    return [{
      familyId,
      isPrimary,
      coverageRole,
      contributionKnowledgeNodeIds: [...new Set((Array.isArray(membership?.contributionKnowledgeNodeIds)
        ? membership.contributionKnowledgeNodeIds : []).map(String).filter(Boolean))].slice(0, 20),
    }];
  });
}

function normalizeVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const primaryNodeId = String(value.primaryNodeId || "");
  const primaryNodeRole = normalizePrimaryNodeRole(value.primaryNodeRole || value.coreKnowledgeRole);
  const requiredNodeIds = [...new Set((Array.isArray(value.requiredNodeIds) ? value.requiredNodeIds : [])
    .map(String).filter(Boolean))].slice(0, 8);
  const problemKnowledgeRangeNodeIds = [...new Set([
    ...(Array.isArray(value.problemKnowledgeRangeNodeIds) ? value.problemKnowledgeRangeNodeIds : []),
    ...requiredNodeIds,
  ].map(String).filter(Boolean))].slice(0, 20);
  const knowledgeThemeRangeAnchorNodeId = String(value.knowledgeThemeRangeAnchorNodeId
    || value.themeRangeAnchorNodeId
    || value.scopeAnchorNodeId
    || (primaryNodeRole === "scope_anchor" ? primaryNodeId : ""));
  if (primaryNodeRole === "scope_anchor"
    && (!primaryNodeId || !requiredNodeIds.length || requiredNodeIds.includes(primaryNodeId))) return null;
  const primaryFamilyId = String(value.primaryFamilyId || "");
  const rawRelatedFamilyIds = [...new Set((Array.isArray(value.relatedFamilyIds) ? value.relatedFamilyIds : [])
    .map(String).filter(Boolean))].slice(0, 20);
  const assessedFamilyIds = (Array.isArray(value.relatedFamilyAssessments) ? value.relatedFamilyAssessments : [])
    .map((assessment) => String(assessment?.familyId || "")).filter(Boolean);
  const deletionTestCandidateIds = [...new Set([...rawRelatedFamilyIds, ...assessedFamilyIds])].slice(0, 20);
  const relatedFamilyPolicy = filterRelatedFamilySuggestions({
    validFamilyIds: new Set(deletionTestCandidateIds),
    primaryFamilyId,
    rawRelatedFamilyIds: deletionTestCandidateIds,
    rawRelations: value.relatedFamilyRelations,
    rawAssessments: value.relatedFamilyAssessments,
  });
  const matchedFamilyIds = [...new Set([
    ...(Array.isArray(value.matchedFamilyIds) ? value.matchedFamilyIds : []),
    ...relatedFamilyPolicy.rejectedFamilyIds,
  ].map(String).filter(Boolean))].slice(0, 20);
  return {
    questionId: String(value.questionId || ""),
    decision: cleanText(value.decision, 40),
    primaryNodeId,
    primaryNodeRole,
    requiredNodeIds,
    problemKnowledgeRangeNodeIds,
    knowledgeThemeRangeAnchorNodeId,
    scopeAnchorNodeId: knowledgeThemeRangeAnchorNodeId,
    requiredNodeAssessments: normalizeRequiredNodeAssessments(value.requiredNodeAssessments),
    optionRelationAssessments: normalizeOptionRelationAssessments(value.optionRelationAssessments),
    focusKey: cleanText(value.focusKey, 240),
    focusLabel: cleanText(value.focusLabel, 200),
    action: cleanText(value.action, 80),
    confidence: Math.min(1, Math.max(0, Number(value.confidence) || 0)),
    reason: cleanText(value.reason, 2000),
    uncertainty: cleanText(value.uncertainty, 1000),
    riskHints: normalizeClassificationRiskHints(value.riskHints),
    recoveredFrom: cleanText(value.recoveredFrom, 40),
    evidenceChunkIds: [...new Set((Array.isArray(value.evidenceChunkIds) ? value.evidenceChunkIds : []).map(String).filter(Boolean))].slice(0, 20),
    familyDecision: cleanText(value.familyDecision, 40),
    primaryFamilyId,
    relatedFamilyIds: relatedFamilyPolicy.relatedFamilyIds,
    relatedFamilyRelations: relatedFamilyPolicy.relatedFamilyRelations,
    relatedFamilyAssessments: relatedFamilyPolicy.assessments,
    familyMemberships: normalizeFamilyMemberships(value.familyMemberships),
    matchedFamilyIds,
    duplicateFamilyIds: [...new Set((Array.isArray(value.duplicateFamilyIds) ? value.duplicateFamilyIds : []).map(String).filter(Boolean))].slice(0, 20),
    familySimilarityReason: cleanText(value.familySimilarityReason, 1600),
    // 加入现有题族时"考查动作不一致"只作风险提示，不再阻断；必须落库才可见。
    familyActionRisk: normalizeFamilyActionRisk(value.familyActionRisk),
    candidateFamilyDraft: normalizeCandidateFamilyDraft(value.candidateFamilyDraft),
    agent3ContractStatus: ["valid", "corrected", "failed"].includes(value.agent3ContractStatus)
      ? value.agent3ContractStatus : "",
    agent3Diagnostics: normalizeAgent3Diagnostics(value.agent3Diagnostics),
  };
}

function normalizeReviewSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const primaryNodeId = String(value.primaryNodeId || "");
  const primaryNodeRole = normalizePrimaryNodeRole(value.primaryNodeRole || value.coreKnowledgeRole);
  const requiredNodeIds = [...new Set((Array.isArray(value.requiredNodeIds) ? value.requiredNodeIds : []).map(String).filter(Boolean))].slice(0, 8);
  const problemKnowledgeRangeNodeIds = [...new Set([
    ...(Array.isArray(value.problemKnowledgeRangeNodeIds) ? value.problemKnowledgeRangeNodeIds : []),
    ...requiredNodeIds,
  ].map(String).filter(Boolean))].slice(0, 20);
  const knowledgeThemeRangeAnchorNodeId = String(value.knowledgeThemeRangeAnchorNodeId
    || value.themeRangeAnchorNodeId
    || value.scopeAnchorNodeId
    || (primaryNodeRole === "scope_anchor" ? primaryNodeId : ""));
  if (!primaryNodeId || !requiredNodeIds.length) return null;
  if (primaryNodeRole === "core" && !requiredNodeIds.includes(primaryNodeId)) return null;
  if (primaryNodeRole === "scope_anchor" && requiredNodeIds.includes(primaryNodeId)) return null;
  const hasFamilyMemberships = Object.prototype.hasOwnProperty.call(value, "familyMemberships");
  const familyMemberships = normalizeFamilyMemberships(value.familyMemberships);
  const createCandidateFamily = value.createCandidateFamily === true;
  const candidateFamilyDraft = normalizeCandidateFamilyDraft(value.candidateFamilyDraft);
  if (createCandidateFamily && !candidateFamilyDraft) return null;
  return {
    primaryNodeId,
    primaryNodeRole,
    requiredNodeIds,
    problemKnowledgeRangeNodeIds,
    knowledgeThemeRangeAnchorNodeId,
    scopeAnchorNodeId: knowledgeThemeRangeAnchorNodeId,
    ...(hasFamilyMemberships ? { familyMemberships } : {}),
    ...(createCandidateFamily ? { createCandidateFamily: true, candidateFamilyDraft } : {}),
    ...(value.familyWasAdjusted === true ? { familyWasAdjusted: true } : {}),
    ...(value.wasAdjusted === true || value.adjustmentReason ? {
      wasAdjusted: value.wasAdjusted === true,
      adjustmentReason: cleanText(value.adjustmentReason, 2000),
    } : {}),
  };
}

function normalizeJob(input = {}) {
  const now = Date.now();
  const questionIds = [...new Set((Array.isArray(input.questionIds) ? input.questionIds : []).map(String).filter(Boolean))];
  const status = jobStatuses.has(input.status) ? input.status : "queued";
  const defaultStage = status === "queued" ? "queued"
    : (["completed", "partial"].includes(status) ? "completed" : (status === "interrupted" ? "interrupted" : "agent1"));
  const baseClassificationBaselines = normalizeClassificationBaselines(input.baseClassificationBaselines, questionIds);
  return {
    id: String(input.id || `knowledge-classification-job-${crypto.randomUUID()}`),
    bookId: String(input.bookId || ""),
    questionIds,
    status,
    stage: jobStages.has(input.stage) ? input.stage : defaultStage,
    total: questionIds.length,
    completed: Math.min(questionIds.length, Math.max(0, Number(input.completed) || 0)),
    succeeded: Math.min(questionIds.length, Math.max(0, Number(input.succeeded) || 0)),
    failed: Math.min(questionIds.length, Math.max(0, Number(input.failed) || 0)),
    agent1Completed: Math.min(questionIds.length, Math.max(0, Number(input.agent1Completed) || 0)),
    agent2Completed: Math.min(questionIds.length, Math.max(0, Number(input.agent2Completed) || 0)),
    agent1Processed: Math.min(questionIds.length, Math.max(0, Number(input.agent1Processed) || 0)),
    agent2Processed: Math.min(questionIds.length, Math.max(0, Number(input.agent2Processed) || 0)),
    agent2Queued: Math.min(questionIds.length, Math.max(0, Number(input.agent2Queued) || 0)),
    reviewReady: Math.min(questionIds.length, Math.max(0, Number(input.reviewReady) || 0)),
    agent1CurrentQuestionId: String(input.agent1CurrentQuestionId || ""),
    agent1CurrentQuestionIndex: Math.min(questionIds.length, Math.max(0, Number(input.agent1CurrentQuestionIndex) || 0)),
    agent1CurrentDepth: Math.max(0, Number(input.agent1CurrentDepth) || 0),
    agent2CurrentQuestionId: String(input.agent2CurrentQuestionId || ""),
    agent2CurrentQuestionIndex: Math.min(questionIds.length, Math.max(0, Number(input.agent2CurrentQuestionIndex) || 0)),
    currentQuestionId: String(input.currentQuestionId || ""),
    currentQuestionIndex: Math.min(questionIds.length, Math.max(0, Number(input.currentQuestionIndex) || 0)),
    currentDepth: Math.max(0, Number(input.currentDepth) || 0),
    currentBatchStart: Math.min(questionIds.length, Math.max(0, Number(input.currentBatchStart) || 0)),
    currentBatchEnd: Math.min(questionIds.length, Math.max(0, Number(input.currentBatchEnd) || 0)),
    progressMessage: cleanText(input.progressMessage, 300),
    baseQuestionVersions: normalizeQuestionVersions(input.baseQuestionVersions, questionIds),
    baseClassificationBaselines,
    baseKnowledgeRevision: normalizeRevision(input.baseKnowledgeRevision),
    knowledgeRevisionFormat: normalizeKnowledgeRevisionFormat(input.knowledgeRevisionFormat),
    baseFamilyRevision: normalizeRevision(input.baseFamilyRevision),
    textbookKnowledgeVersion: normalizeRevision(input.textbookKnowledgeVersion),
    error: cleanText(input.error, 500),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    startedAt: input.startedAt ? Number(input.startedAt) : null,
    finishedAt: input.finishedAt ? Number(input.finishedAt) : null,
  };
}

function normalizeResult(input = {}) {
  const now = Date.now();
  // 人工裁决生命周期与题目完善对齐（recommended → applied / rejected）；
  // 历史上的 "pending" 由共享词汇层归一为 "recommended"，不改历史文件。
  const reviewStatus = normalizeSuggestionReviewStatus(input.reviewStatus);
  let status = resultStatuses.has(input.status) ? input.status : "queued";
  if (reviewStatus === "applied") status = "applied";
  if (reviewStatus === "rejected") status = "rejected";
  const agent1FeatureHandoff = normalizeAgent1FeatureHandoff(input.agent1FeatureHandoff);
  const agent1Features = agent1FeatureHandoff?.features || (input.agent1Features && typeof input.agent1Features === "object"
    ? normalizeFeatureProfile(input.agent1Features)
    : null);
  return {
    id: String(input.id || `knowledge-classification-result-${crypto.randomUUID()}`),
    jobId: String(input.jobId || ""),
    questionId: String(input.questionId || ""),
    bookId: String(input.bookId || ""),
    // 建议来源标识（与题目完善共用一套词汇），供统一入口分流与筛选
    source: normalizeSuggestionSource(input.source, SUGGESTION_SOURCES.KNOWLEDGE_INSPECTION),
    status,
    agent1Status: agent1Statuses.has(input.agent1Status) ? input.agent1Status : "pending",
    agent1Features,
    agent1FeatureHandoff,
    agent1FeatureDiagnostics: normalizeAgent1FeatureDiagnostics(
      input.agent1FeatureDiagnostics || agent1FeatureHandoff?.diagnostics,
    ),
    agent1Trajectories: (Array.isArray(input.agent1Trajectories) ? input.agent1Trajectories : []).map(normalizeAgent1Trajectory).slice(0, 2),
    agent1RuleIds: [...new Set((Array.isArray(input.agent1RuleIds) ? input.agent1RuleIds : []).map(String).filter(Boolean))].slice(0, 30),
    agent1CaseIds: [...new Set((Array.isArray(input.agent1CaseIds) ? input.agent1CaseIds : []).map(String).filter(Boolean))].slice(0, 20),
    agent2NavigationDiagnostics: (Array.isArray(input.agent2NavigationDiagnostics) ? input.agent2NavigationDiagnostics : [])
      .map(normalizeAgent2NavigationDiagnostic).slice(0, 40),
    classificationOutcome: classificationOutcomes.has(input.classificationOutcome) ? input.classificationOutcome : "",
    agent2Status: agent2Statuses.has(input.agent2Status) ? input.agent2Status : "pending",
    agent2Verification: normalizeVerification(input.agent2Verification),
    agent2RuleIds: [...new Set((Array.isArray(input.agent2RuleIds) ? input.agent2RuleIds : []).map(String).filter(Boolean))].slice(0, 30),
    agent2CaseIds: [...new Set((Array.isArray(input.agent2CaseIds) ? input.agent2CaseIds : []).map(String).filter(Boolean))].slice(0, 20),
    reviewSelection: normalizeReviewSelection(input.reviewSelection),
    reviewStatus,
    // 与题目完善同一套留痕：采纳了哪些字段、采纳到哪个版本。
    // 题目完善用的 appliedVersion 是"应用后的题目版本"；巡检写的是正式知识指纹，
    // 所以这里用"应用后的指纹 revision"——语义同构，都能追溯到具体那一次采纳。
    appliedFields: [...new Set((Array.isArray(input.appliedFields) ? input.appliedFields : []).map(String).filter(Boolean))].slice(0, 30),
    appliedVersion: Math.max(0, Number(input.appliedVersion) || 0),
    baseQuestionVersion: normalizeRevision(input.baseQuestionVersion),
    classificationBaseline: normalizeClassificationBaseline(input.classificationBaseline),
    baseKnowledgeRevision: normalizeRevision(input.baseKnowledgeRevision),
    knowledgeRevisionFormat: normalizeKnowledgeRevisionFormat(input.knowledgeRevisionFormat),
    baseFamilyRevision: normalizeRevision(input.baseFamilyRevision),
    textbookKnowledgeVersion: normalizeRevision(input.textbookKnowledgeVersion),
    error: cleanText(input.error, 500),
    reviewedBy: cleanText(input.reviewedBy, 100),
    reviewNote: cleanText(input.reviewNote, 1000),
    // AI 巡检的四态复核留痕（产品手册 §4.6.12 / DEC-100）：只读诊断产物的"人看没看过"。
    // 与上面的 reviewStatus（建议层状态机）并存，不改后者的既有语义。
    auditReview: normalizeAuditReview(input.auditReview),
    // 「送去完善题目」：只记"什么时候送过"，不改库、不采纳。
    sentToEnrichmentAt: Number(input.sentToEnrichmentAt) > 0 ? Number(input.sentToEnrichmentAt) : null,
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    reviewedAt: input.reviewedAt ? Number(input.reviewedAt) : null,
    appliedAt: input.appliedAt ? Number(input.appliedAt) : null,
    rejectedAt: input.rejectedAt ? Number(input.rejectedAt) : null,
  };
}

function normalizeState(value) {
  return {
    jobs: (Array.isArray(value && value.jobs) ? value.jobs : []).map(normalizeJob),
    results: (Array.isArray(value && value.results) ? value.results : []).map(normalizeResult),
  };
}

function createKnowledgeClassificationStore(adapter) {
  const read = () => normalizeState(adapter.read());
  const write = (state) => adapter.write({
    jobs: state.jobs.slice(0, MAX_JOBS).map(normalizeJob),
    results: state.results.slice(0, MAX_RESULTS).map(normalizeResult),
  });
  return {
    exportState: () => clone(read()),
    replaceState: (state) => { write(state); return clone(read()); },
    createJob(input = {}) {
      const state = read();
      const job = normalizeJob(input);
      if (!job.bookId) throw new Error("knowledge_classification_book_required");
      if (!job.questionIds.length) throw new Error("knowledge_classification_questions_required");
      state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
      const existingKeys = new Set(state.results.map((result) => `${result.jobId}\u0000${result.questionId}`));
      const createdResults = job.questionIds.flatMap((questionId) => {
        const key = `${job.id}\u0000${questionId}`;
        if (existingKeys.has(key)) return [];
        return [normalizeResult({
          jobId: job.id,
          questionId,
          bookId: job.bookId,
          baseQuestionVersion: job.baseQuestionVersions[questionId],
          classificationBaseline: job.baseClassificationBaselines[questionId],
          baseKnowledgeRevision: job.baseKnowledgeRevision,
          knowledgeRevisionFormat: job.knowledgeRevisionFormat,
          baseFamilyRevision: job.baseFamilyRevision,
          textbookKnowledgeVersion: job.textbookKnowledgeVersion,
        })];
      });
      state.results = [...createdResults, ...state.results];
      write(state);
      return { job: clone(job), results: clone(createdResults) };
    },
    getJob(id) {
      const job = read().jobs.find((item) => item.id === id);
      return job ? clone(job) : null;
    },
    jobs(filters = {}) {
      const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));
      return read().jobs.filter((job) => {
        if (filters.bookId && filters.bookId !== "all" && job.bookId !== filters.bookId) return false;
        if (filters.status && filters.status !== "all" && job.status !== filters.status) return false;
        return true;
      }).slice(0, limit).map(clone);
    },
    updateJob(id, patch = {}) {
      const state = read();
      const index = state.jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("knowledge_classification_job_not_found");
      state.jobs[index] = normalizeJob({ ...state.jobs[index], ...patch, id, updatedAt: Date.now() });
      write(state);
      return clone(state.jobs[index]);
    },
    getResult(id) {
      const result = read().results.find((item) => item.id === id);
      return result ? clone(result) : null;
    },
    resultForQuestion(jobId, questionId) {
      const result = read().results.find((item) => item.jobId === jobId && item.questionId === questionId);
      return result ? clone(result) : null;
    },
    results(filters = {}) {
      const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 200));
      return read().results.filter((result) => {
        if (filters.jobId && result.jobId !== filters.jobId) return false;
        if (filters.bookId && filters.bookId !== "all" && result.bookId !== filters.bookId) return false;
        if (filters.questionId && result.questionId !== filters.questionId) return false;
        if (filters.status && filters.status !== "all" && result.status !== filters.status) return false;
        if (filters.reviewStatus && filters.reviewStatus !== "all" && result.reviewStatus !== filters.reviewStatus) return false;
        return true;
      }).slice(0, limit).map(clone);
    },
    // 裁决台需要**全量**结果（results() 有 1000 条上限，且没有 offset）。
    // read() 每次都把状态归一化成新对象，所以直接返回是安全的、也不会被外部改到内部状态。
    allResults() {
      return read().results;
    },
    updateResult(id, patch = {}) {
      const state = read();
      const index = state.results.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("knowledge_classification_result_not_found");
      state.results[index] = normalizeResult({ ...state.results[index], ...patch, id, updatedAt: Date.now() });
      write(state);
      return clone(state.results[index]);
    },
    /**
     * 人工确认巡检记录的复核状态（四态，产品手册 §4.6.12 / DEC-100）。
     * 只写 auditReview 这一条留痕，**不动** status／reviewStatus（那是建议层状态机，语义不同）。
     * 若只改 note、不改 state，则保留原来的 state 与 actor；state 变了才换 actor 并记新的 at。
     * actor＝登录账号名（唯一可定位），actorLabel＝展示名（界面用）。
     */
    updateAuditReview(id, { state, note, actor, actorLabel } = {}) {
      const current = this.getResult(id);
      if (!current) throw new Error("knowledge_classification_result_not_found");
      const previous = current.auditReview || normalizeAuditReview(null);
      const hasState = state !== undefined && state !== null;
      const nextState = hasState ? normalizeAuditReviewState(state) : previous.state;
      const stateChanged = hasState && nextState !== previous.state;
      const patch = {
        auditReview: {
          state: nextState,
          note: note === undefined ? previous.note : cleanText(note, 1000),
          actor: stateChanged ? cleanText(actor, 100) : previous.actor,
          actorLabel: stateChanged ? cleanText(actorLabel, 100) : previous.actorLabel,
          at: stateChanged ? Date.now() : previous.at,
        },
      };
      return this.updateResult(id, patch);
    },
    // 「送去完善题目」只留痕：有没有送过、什么时候送的。生成建议本身走题目完善的产线，不在这里发生。
    markSentToEnrichment(id, at = Date.now()) {
      const sentAt = Number(at) > 0 ? Number(at) : Date.now();
      return this.updateResult(id, { sentToEnrichmentAt: sentAt });
    },
    saveAgent1Features(id, features, metadata = {}) {
      const current = this.getResult(id);
      if (!current) throw new Error("knowledge_classification_result_not_found");
      if (!features || typeof features !== "object" || Array.isArray(features)) {
        throw new Error("knowledge_classification_agent1_features_invalid");
      }
      const normalizedFeatures = normalizeFeatureProfile(features);
      const source = metadata.source === "model" || normalizedFeatures.extractionSource === "model" ? "model" : "heuristic";
      const handoff = normalizeAgent1FeatureHandoff({
        status: source === "model" ? "completed" : "fallback",
        source,
        sceneId: "knowledge_feature_extraction",
        configuredSceneId: metadata.configuredSceneId,
        model: metadata.model,
        warning: metadata.warning,
        diagnostics: metadata.diagnostics,
        rawFeatures: metadata.rawFeatures,
        savedAt: Date.now(),
        features: normalizedFeatures,
      });
      return this.updateResult(id, {
        status: "processing",
        agent1Features: handoff.features,
        agent1FeatureHandoff: handoff,
        agent1FeatureDiagnostics: handoff.diagnostics,
      });
    },
    saveAgent1(id, trajectories, status = "completed", experience = {}) {
      if (!agent1Statuses.has(status) || ["pending", "running"].includes(status)) {
        throw new Error("knowledge_classification_agent1_status_invalid");
      }
      const current = this.getResult(id);
      if (!current) throw new Error("knowledge_classification_result_not_found");
      return this.updateResult(id, {
        status: status === "failed" ? "failed" : "processing",
        agent1Status: status,
        ...(!current.agent1Features && experience.features ? { agent1Features: experience.features } : {}),
        agent1Trajectories: trajectories,
        agent1RuleIds: experience.ruleIds,
        agent1CaseIds: experience.caseIds,
        agent2NavigationDiagnostics: experience.navigationDiagnostics,
        classificationOutcome: experience.classificationOutcome || "",
        error: status === "failed" ? "agent1_failed" : "",
      });
    },
    saveAgent2(id, verification, status = "completed", experience = {}) {
      if (!agent2Statuses.has(status) || ["pending", "running"].includes(status)) {
        throw new Error("knowledge_classification_agent2_status_invalid");
      }
      const failed = ["failed", "interrupted"].includes(status);
      const normalizedVerification = failed ? null : normalizeVerification(verification);
      if (!failed && !normalizedVerification) throw new Error("knowledge_classification_agent2_verification_invalid");
      return this.updateResult(id, {
        status: failed ? (status === "interrupted" ? "interrupted" : "failed") : "pending_review",
        agent2Status: status,
        agent2Verification: failed ? verification : normalizedVerification,
        agent2RuleIds: experience.ruleIds,
        agent2CaseIds: experience.caseIds,
        error: failed ? `agent2_${status}` : "",
      });
    },
    applyResult(id, actor = "", note = "", reviewSelection = null, appliedFields = [], appliedVersion = 0) {
      const current = this.getResult(id);
      if (!current) throw new Error("knowledge_classification_result_not_found");
      if (current.status !== "pending_review" || !["completed", "uncertain"].includes(current.agent2Status)) {
        throw new Error("knowledge_classification_result_not_reviewable");
      }
      const normalizedSelection = normalizeReviewSelection(reviewSelection);
      if (!normalizedSelection) throw new Error("knowledge_classification_review_selection_invalid");
      const now = Date.now();
      return this.updateResult(id, {
        status: "applied",
        reviewStatus: "applied",
        reviewedBy: actor,
        reviewNote: note,
        reviewedAt: now,
        appliedAt: now,
        rejectedAt: null,
        reviewSelection: normalizedSelection,
        // 与题目完善同一套留痕：采纳了哪些字段、采纳到哪个版本
        appliedFields: (Array.isArray(appliedFields) ? appliedFields : []).map(String),
        appliedVersion: Math.max(0, Number(appliedVersion) || 0),
      });
    },
    rejectResult(id, actor = "", note = "") {
      const current = this.getResult(id);
      if (!current) throw new Error("knowledge_classification_result_not_found");
      if (["applied", "rejected"].includes(current.status)) throw new Error("knowledge_classification_result_already_reviewed");
      const now = Date.now();
      return this.updateResult(id, {
        status: "rejected",
        reviewStatus: "rejected",
        reviewedBy: actor,
        reviewNote: note,
        reviewedAt: now,
        rejectedAt: now,
        appliedAt: null,
        // 驳回没有采纳任何字段；清空留痕，避免残留上一次的误读
        appliedFields: [],
        appliedVersion: 0,
      });
    },
    recoverInterrupted() {
      const state = read();
      const now = Date.now();
      let changed = false;
      const interruptedJobIds = new Set();
      state.jobs = state.jobs.map((job) => {
        if (!["queued", "running"].includes(job.status)) return job;
        changed = true;
        interruptedJobIds.add(job.id);
        return normalizeJob({ ...job, status: "interrupted", stage: "interrupted", error: "server_interrupted", finishedAt: now, updatedAt: now });
      });
      state.results = state.results.map((result) => {
        const active = interruptedJobIds.has(result.jobId)
          && ["queued", "processing"].includes(result.status)
          && result.reviewStatus === "recommended";
        if (!active) return result;
        changed = true;
        return normalizeResult({
          ...result,
          status: "interrupted",
          agent1Status: result.agent1Status === "running" ? "interrupted" : result.agent1Status,
          agent2Status: result.agent2Status === "running" ? "interrupted" : result.agent2Status,
          error: "server_interrupted",
          updatedAt: now,
        });
      });
      if (changed) write(state);
      return { recoveredJobCount: interruptedJobIds.size };
    },
  };
}

function createFileKnowledgeClassificationStore(filePath = path.resolve(__dirname, "../../../.runtime/knowledge-classification.json"), options = {}) {
  const store = createKnowledgeClassificationStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { jobs: [], results: [] }; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
  if (options.recoverInterrupted !== false) store.recoverInterrupted();
  return store;
}

function createMemoryKnowledgeClassificationStore(initialState = { jobs: [], results: [] }, options = {}) {
  let state = clone(initialState);
  const store = createKnowledgeClassificationStore({
    read: () => clone(state),
    write: (next) => { state = clone(next); },
  });
  if (options.recoverInterrupted === true) store.recoverInterrupted();
  return store;
}

module.exports = {
  createFileKnowledgeClassificationStore,
  createMemoryKnowledgeClassificationStore,
  normalizeJob,
  normalizeResult,
  // 四态白名单（产品手册 §4.6.12 / DEC-100）：路由与测试都从这里取，不再各自发明一份。
  AUDIT_REVIEW_STATES,
  DEFAULT_AUDIT_REVIEW_STATE,
};
