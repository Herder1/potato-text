const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeFeatureProfile } = require("./question-classification-features");
const { subjectiveQuestionTypes } = require("./scoring-point-structure");

const STORE_SCHEMA_VERSION = "ClassificationGoldReviewStoreV2";
const SNAPSHOT_SCHEMA_VERSION = "ClassificationGoldSnapshotV1";
const OPTION_KNOWLEDGE_PROTOCOL_VERSION = "option-knowledge-v2";
const LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION = "family_knowledge_v2";
const FAMILY_KNOWLEDGE_PROTOCOL_VERSION = "family_knowledge_v3";
const FAMILY_KNOWLEDGE_PROTOCOL_VERSIONS = new Set([
  LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
]);
const REVIEW_RESULTS = new Set(["confirmed", "corrected", "disputed"]);
const REPLAY_MODES = new Set(["mature", "singleton", "unmatched"]);
const FAMILY_DECISIONS = new Set(["join_existing", "create_new"]);
const CHOICE_STRUCTURES = new Set(["direct_options", "composed_options"]);
const FAMILY_STATUSES = new Set(["pending_review", "confirmed", "rejected"]);
const FAMILY_MEMBER_ROLES = new Set(["prototype", "similar", "variant"]);
const FAMILY_MEMBER_REVIEW_STATUSES = new Set(["confirmed", "pending_fit", "inactive"]);
const RELATED_FAMILY_COVERAGE_ROLES = new Set(["required", "reference"]);
const CORE_KNOWLEDGE_ROLES = new Set(["core", "scope_anchor"]);
const REPLAY_MODE_LABELS = Object.freeze({
  mature: "成熟题族留一",
  singleton: "单题题族整族隐藏",
  unmatched: "无匹配建族",
});
const FAMILY_SEMANTIC_ISSUE_LABELS = Object.freeze({
  new_family_mode_invalid: "新建题族与盲测层级不一致",
  unmatched_carries_existing_family: "无匹配题携带了现有主题题族",
  family_decision_invalid: "题族裁决无效",
  existing_family_mode_invalid: "无匹配题错误加入现有题族",
  primary_family_missing: "缺少主题题族",
  family_ids_duplicate: "题族事实重复",
  primary_family_fact_missing: "缺少主题题族冻结事实",
  family_status_not_confirmed: "题族尚未确认",
  family_status_missing: "题族状态缺失",
  family_version_missing: "题族版本缺失",
  family_definition_incomplete: "题族六维定义不完整",
  family_confirmed_prototype_missing: "题族缺少有效的已确认原型题",
  family_members_missing: "题族成员事实缺失",
  family_membership_not_confirmed: "题目与题族的归属关系尚未确认",
  family_member_ids_inconsistent: "题族成员清单不一致",
  family_independent_member_ids_inconsistent: "独立成员清单不一致",
  family_independent_member_count_inconsistent: "独立成员数量不一致",
  family_membership_missing: "题目成员关系缺失",
  family_membership_role_inconsistent: "题目成员角色不一致",
  primary_family_role_inconsistent: "主题题族与主归属不一致",
  related_family_role_missing: "关联题族声明缺失",
  related_family_relation_missing: "关联题族缺少覆盖角色",
  related_family_relation_invalid: "关联题族覆盖角色无效",
  related_family_relation_orphan: "关联题族覆盖角色没有对应关联题族",
  family_knowledge_protocol_missing: "题族知识分层协议缺失",
  required_related_family_fact_missing: "作答必需关联题族事实缺失",
  required_family_no_knowledge_contribution: "作答必需题族没有独立知识贡献",
  required_family_redundant_knowledge_contribution: "作答必需关联题族知识贡献可被其他题族替代",
  reference_family_knowledge_contribution_forbidden: "普通关联题族不得参与知识覆盖",
  core_knowledge_mismatch: "核心知识与主题题族不一致",
  required_knowledge_mismatch: "最小充分知识集与作答必需题族联合覆盖不一致",
  mature_family_member_count_invalid: "成熟题族独立成员不足",
  mature_hidden_question_not_independent: "成熟题族被测题不是独立成员",
  mature_retained_members_invalid: "成熟题族留存成员不正确",
  singleton_family_member_count_invalid: "单题题族成员数量不正确",
  singleton_retained_members_invalid: "单题题族仍保留可见同族成员",
  candidate_core_knowledge_mismatch: "候选题族核心知识与题目不一致",
  candidate_required_knowledge_mismatch: "候选题族与作答必需关联题族未完整覆盖题目最小充分知识集",
});
const OPTION_KNOWLEDGE_RELATIONS = new Set([
  "unreviewed",
  "question_only",
  "option_specific",
  "undetermined",
]);
const INDEPENDENT_REVIEW_METHOD = "human_independent_gold_v1";
const AI_COMPARISON_POLICY = "reveal_after_corresponding_human_stage_v1";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanText(value, limit = 4000) {
  return String(value || "").normalize("NFKC").trim().slice(0, limit);
}

function uniqueStrings(values, limit = 200) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => cleanText(value, 1000)).filter(Boolean))].slice(0, limit);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function contentHash(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function normalizeReview(value = {}) {
  const result = REVIEW_RESULTS.has(value.result) ? value.result : "pending_review";
  const previousReplayMode = REPLAY_MODES.has(value.previousReplayMode) ? value.previousReplayMode : "";
  const nextReplayMode = REPLAY_MODES.has(value.nextReplayMode) ? value.nextReplayMode : "";
  const changeReason = cleanText(value.changeReason || value.replayModeChangeReason, 4000);
  return {
    result,
    note: cleanText(value.note, 4000),
    reviewer: cleanText(value.reviewer, 120),
    reviewedAt: Number(value.reviewedAt) || 0,
    basedOnKnowledgeDigest: cleanText(value.basedOnKnowledgeDigest, 128),
    ...(previousReplayMode ? { previousReplayMode } : {}),
    ...(nextReplayMode ? { nextReplayMode } : {}),
    ...(changeReason ? { changeReason } : {}),
  };
}

function normalizeEvidence(value = {}) {
  const humanSelection = value.humanSelection?.status === "selected" ? {
    status: "selected",
    reviewer: cleanText(value.humanSelection.reviewer, 120),
    selectedAt: Number(value.humanSelection.selectedAt) || 0,
  } : null;
  return {
    chunkId: cleanText(value.chunkId || value.id, 240),
    bookId: cleanText(value.bookId, 160),
    catalogPath: cleanText(value.catalogPath || value.path || value.bodyHeading, 1200),
    printedPageStart: Math.max(0, Number(value.printedPageStart ?? value.printedPage) || 0),
    printedPageEnd: Math.max(0, Number(value.printedPageEnd ?? value.printedPageStart ?? value.printedPage) || 0),
    pdfPageStart: Math.max(0, Number(value.pdfPageStart ?? value.pdfPage) || 0),
    pdfPageEnd: Math.max(0, Number(value.pdfPageEnd ?? value.pdfPageStart ?? value.pdfPage) || 0),
    excerpt: cleanText(value.excerpt || value.text, 6000),
    provenance: cleanText(value.provenance || "review_prefill", 80),
    candidateOnly: value.candidateOnly === true,
    humanSelection,
  };
}

function normalizeOptionKnowledge(value = {}, index = 0) {
  const knowledgeNodeIds = uniqueStrings(value.knowledgeNodeIds, 20);
  const knowledgeLabels = uniqueStrings(value.knowledgeLabels || value.knowledgeHints, 20);
  const legacyKnowledgeNodeIds = uniqueStrings(value.legacyKnowledgeNodeIds, 20);
  const legacyKnowledgeHints = uniqueStrings(value.legacyKnowledgeHints, 20);
  const hasExplicitRelation = Object.prototype.hasOwnProperty.call(value, "knowledgeRelation");
  const explicitRelation = cleanText(value.knowledgeRelation, 40);
  const knowledgeRelation = hasExplicitRelation
    ? (OPTION_KNOWLEDGE_RELATIONS.has(explicitRelation) ? explicitRelation : "unreviewed")
    : "unreviewed";
  const keepsOptionKnowledge = knowledgeRelation === "option_specific";
  const protocolVersion = cleanText(value.protocolVersion || value.optionKnowledgeProtocolVersion, 80);
  return {
    key: cleanText(value.key || String.fromCharCode(65 + index), 20).toUpperCase(),
    text: cleanText(value.text, 3000),
    protocolVersion: protocolVersion === OPTION_KNOWLEDGE_PROTOCOL_VERSION
      ? OPTION_KNOWLEDGE_PROTOCOL_VERSION : "",
    knowledgeRelation,
    knowledgeNodeIds: keepsOptionKnowledge ? knowledgeNodeIds : [],
    knowledgeLabels: keepsOptionKnowledge ? knowledgeLabels : [],
    legacyKnowledgeNodeIds: hasExplicitRelation
      ? legacyKnowledgeNodeIds
      : uniqueStrings([...legacyKnowledgeNodeIds, ...knowledgeNodeIds], 20),
    legacyKnowledgeHints: hasExplicitRelation
      ? legacyKnowledgeHints
      : uniqueStrings([...legacyKnowledgeHints, ...knowledgeLabels], 20),
    basis: cleanText(value.basis, 4000),
    uncertaintyNote: knowledgeRelation === "undetermined" ? cleanText(value.uncertaintyNote, 4000) : "",
    role: ["answer", "distractor", "neutral", "unreviewed"].includes(value.role) ? value.role : "neutral",
    provenance: cleanText(value.provenance || "review_prefill", 80),
  };
}

function normalizeAtomicStatement(value = {}, index = 0) {
  const normalized = normalizeOptionKnowledge(value, index);
  return {
    key: normalized.key,
    text: normalized.text,
    protocolVersion: normalized.protocolVersion,
    knowledgeRelation: normalized.knowledgeRelation,
    basis: normalized.basis,
    knowledgeNodeIds: normalized.knowledgeNodeIds,
    knowledgeLabels: normalized.knowledgeLabels,
    legacyKnowledgeNodeIds: normalized.legacyKnowledgeNodeIds,
    legacyKnowledgeHints: normalized.legacyKnowledgeHints,
    uncertaintyNote: normalized.uncertaintyNote,
    verdict: cleanText(value.verdict, 400),
    provenance: normalized.provenance,
  };
}

function normalizeOptionComposition(value = {}, index = 0) {
  return {
    optionKey: cleanText(value.optionKey || value.key || String.fromCharCode(65 + index), 20).toUpperCase(),
    atomicKeys: uniqueStrings(value.atomicKeys, 40).map((key) => key.toUpperCase()),
  };
}

function normalizedAtomicQuestionStructure(values = []) {
  return (Array.isArray(values) ? values : []).map((item) => ({
    key: cleanText(item?.key, 20).toUpperCase(),
    text: cleanText(item?.text, 5000),
  })).sort((left, right) => left.key.localeCompare(right.key));
}

function normalizedOptionCompositionStructure(values = []) {
  return (Array.isArray(values) ? values : []).map((item) => ({
    optionKey: cleanText(item?.optionKey || item?.key, 20).toUpperCase(),
    atomicKeys: uniqueStrings(item?.atomicKeys, 40).map((key) => key.toUpperCase()).sort(),
  })).sort((left, right) => left.optionKey.localeCompare(right.optionKey));
}

function composedStructureMatchesQuestion(question = {}, answerKnowledge = {}) {
  if (cleanText(question.choiceStructure, 80) !== "composed_options"
    || cleanText(answerKnowledge.choiceStructure, 80) !== "composed_options") return false;
  const expectedAtomic = normalizedAtomicQuestionStructure(question.atomicStatements);
  const reviewedAtomic = normalizedAtomicQuestionStructure(answerKnowledge.atomicStatements);
  const expectedComposition = normalizedOptionCompositionStructure(question.optionComposition);
  const reviewedComposition = normalizedOptionCompositionStructure(answerKnowledge.optionComposition);
  return expectedAtomic.length > 0
    && expectedComposition.length > 0
    && contentHash(expectedAtomic) === contentHash(reviewedAtomic)
    && contentHash(expectedComposition) === contentHash(reviewedComposition);
}

function normalizeSourceMaterials(value = {}, fallbackQuestion = {}) {
  const question = fallbackQuestion && typeof fallbackQuestion === "object" ? fallbackQuestion : {};
  return {
    sourceAnswer: {
      correctAnswer: uniqueStrings(value.sourceAnswer?.correctAnswer ?? question.correctAnswer, 20),
      referenceAnswer: cleanText(value.sourceAnswer?.referenceAnswer ?? question.referenceAnswer, 12000),
      answerSource: cleanText(value.sourceAnswer?.answerSource ?? question.answerSource, 120),
      answerReviewStatus: cleanText(value.sourceAnswer?.answerReviewStatus ?? question.answerReviewStatus, 80),
      provenance: cleanText(value.sourceAnswer?.provenance || "formal_question_snapshot", 120),
    },
    textbookEvidence: (Array.isArray(value.textbookEvidence) ? value.textbookEvidence : [])
      .map(normalizeEvidence).filter((item) => item.chunkId || item.excerpt).slice(0, 100),
    provenance: cleanText(value.provenance || "review_source_material", 120),
  };
}

function normalizeScoringPoint(value = {}, index = 0) {
  return {
    id: cleanText(value.id || `point-${index + 1}`, 120),
    description: cleanText(value.description || value.text, 4000),
    score: Math.max(0, Number(value.score) || 0),
    knowledgeNodeIds: uniqueStrings(value.knowledgeNodeIds, 20),
    knowledgeLabels: uniqueStrings(value.knowledgeLabels, 20),
    provenance: cleanText(value.provenance || "business_question", 80),
  };
}

function normalizeKnowledgeNode(value = {}) {
  if (typeof value === "string") {
    return { id: "", canonicalNodeId: "", aliasNodeIds: [], title: "", path: cleanText(value, 1200) };
  }
  return {
    id: cleanText(value.id || value.nodeId, 240),
    canonicalNodeId: cleanText(value.canonicalNodeId, 240),
    aliasNodeIds: uniqueStrings(value.aliasNodeIds || value.aliases, 40),
    title: cleanText(value.title || value.label || value.displayTitle, 400),
    path: cleanText(value.path || value.knowledgePath, 1200),
  };
}

function normalizeContributionKnowledge(value = {}) {
  const explicit = (Array.isArray(value.contributionKnowledge) ? value.contributionKnowledge : [])
    .map(normalizeKnowledgeNode).filter((item) => item.id || item.path || item.title).slice(0, 40);
  const nodeIds = uniqueStrings([
    ...(value.contributionKnowledgeNodeIds || []),
    ...explicit.map((item) => item.id),
  ], 40);
  const representedIds = new Set(explicit.map((item) => item.id).filter(Boolean));
  return {
    contributionKnowledgeNodeIds: nodeIds,
    contributionKnowledge: [
      ...explicit,
      ...nodeIds.filter((nodeId) => !representedIds.has(nodeId)).map((nodeId) => normalizeKnowledgeNode({ id: nodeId })),
    ],
  };
}

function normalizeFamilyMember(value = {}) {
  const hasPrimaryRole = typeof value.isPrimary === "boolean";
  const role = cleanText(value.role, 80);
  const contribution = normalizeContributionKnowledge(value);
  return {
    questionId: cleanText(value.questionId, 240),
    isPrimary: hasPrimaryRole ? value.isPrimary : null,
    role: FAMILY_MEMBER_ROLES.has(role) ? role : "",
    trainingLevel: cleanText(value.trainingLevel, 80),
    action: cleanText(value.action, 600),
    variationDimensions: uniqueStrings(value.variationDimensions, 20),
    ...contribution,
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    reason: cleanText(value.reason, 4000),
    reviewStatus: FAMILY_MEMBER_REVIEW_STATUSES.has(value.reviewStatus) ? value.reviewStatus : "",
  };
}

function normalizeFamilyMembership(value = {}) {
  if (!value || typeof value !== "object") return null;
  const questionId = cleanText(value.questionId, 240);
  const hasPrimaryRole = typeof value.isPrimary === "boolean";
  const role = cleanText(value.role, 80);
  const revision = Math.max(0, Number(value.revision ?? value.membershipRevision) || 0);
  const contribution = normalizeContributionKnowledge(value);
  if (!questionId && !hasPrimaryRole && !role && !revision && !contribution.contributionKnowledge.length) return null;
  return {
    questionId,
    isPrimary: hasPrimaryRole ? value.isPrimary : null,
    role: FAMILY_MEMBER_ROLES.has(role) ? role : "",
    reviewStatus: FAMILY_MEMBER_REVIEW_STATUSES.has(value.reviewStatus) ? value.reviewStatus : "",
    ...contribution,
    revision,
  };
}

function normalizeAnswerKnowledge(value = {}, fallbackQuestion = {}) {
  const question = fallbackQuestion && typeof fallbackQuestion === "object" ? fallbackQuestion : {};
  const optionKnowledgeProtocolVersion = cleanText(value.optionKnowledgeProtocolVersion, 80) === OPTION_KNOWLEDGE_PROTOCOL_VERSION
    ? OPTION_KNOWLEDGE_PROTOCOL_VERSION : "";
  const requestedChoiceStructure = cleanText(value.choiceStructure || question.choiceStructure, 80);
  const choiceStructure = CHOICE_STRUCTURES.has(requestedChoiceStructure)
    ? requestedChoiceStructure
    : ((value.atomicStatements || question.atomicStatements || []).length ? "composed_options" : "direct_options");
  let requiredKnowledge = (Array.isArray(value.requiredKnowledge) ? value.requiredKnowledge : [])
    .map(normalizeKnowledgeNode).filter((item) => item.id || item.path || item.title).slice(0, 40);
  const coreKnowledge = normalizeKnowledgeNode(value.coreKnowledge || {});
  const coreKnowledgeRole = CORE_KNOWLEDGE_ROLES.has(cleanText(value.coreKnowledgeRole, 40))
    ? cleanText(value.coreKnowledgeRole, 40) : "core";
  if (coreKnowledgeRole === "scope_anchor") {
    requiredKnowledge = requiredKnowledge.filter((item) => !knowledgeNodesCompatible(item, coreKnowledge));
  } else if ((coreKnowledge.id || coreKnowledge.path) && !requiredKnowledge.some((item) => item.id
    ? item.id === coreKnowledge.id
    : item.path === coreKnowledge.path)) requiredKnowledge.unshift(coreKnowledge);
  return {
    correctAnswer: uniqueStrings(value.correctAnswer ?? question.correctAnswer, 20),
    referenceAnswer: cleanText(value.referenceAnswer ?? question.referenceAnswer, 12000),
    answerSource: cleanText(value.answerSource ?? question.answerSource, 120),
    answerReviewStatus: cleanText(value.answerReviewStatus ?? question.answerReviewStatus, 80),
    textbookEvidence: (Array.isArray(value.textbookEvidence) ? value.textbookEvidence : []).map(normalizeEvidence)
      .filter((item) => item.chunkId || item.excerpt).slice(0, 40),
    coreKnowledge,
    coreKnowledgeRole,
    requiredKnowledge,
    optionKnowledge: (Array.isArray(value.optionKnowledge) ? value.optionKnowledge : [])
      .map((item, index) => normalizeOptionKnowledge({
        ...item,
        optionKnowledgeProtocolVersion: item?.optionKnowledgeProtocolVersion || optionKnowledgeProtocolVersion,
      }, index)).filter((item) => item.key).slice(0, 12),
    optionKnowledgeProtocolVersion,
    choiceStructure,
    atomicStatements: choiceStructure === "composed_options"
      ? (Array.isArray(value.atomicStatements) ? value.atomicStatements : question.atomicStatements || [])
        .map((item, index) => normalizeAtomicStatement({
          ...item,
          optionKnowledgeProtocolVersion: item?.optionKnowledgeProtocolVersion || optionKnowledgeProtocolVersion,
        }, index)).filter((item) => item.key && item.text).slice(0, 40)
      : [],
    optionComposition: choiceStructure === "composed_options"
      ? (Array.isArray(value.optionComposition) ? value.optionComposition : question.optionComposition || [])
        .map(normalizeOptionComposition).filter((item) => item.optionKey && item.atomicKeys.length).slice(0, 20)
      : [],
    scoringPoints: (Array.isArray(value.scoringPoints) ? value.scoringPoints : question.scoringPoints || [])
      .map(normalizeScoringPoint).filter((item) => item.description).slice(0, 100),
  };
}

function relatedFamilyCoverageRole(value = {}) {
  const requested = cleanText(value.coverageRole, 40);
  if (RELATED_FAMILY_COVERAGE_ROLES.has(requested)) return requested;
  if (typeof value.requiredForAnswer === "boolean") return value.requiredForAnswer ? "required" : "reference";
  return "";
}

function normalizeRelatedFamilyRelation(value = {}, fallbackFamilyId = "") {
  const familyId = cleanText(value.familyId || value.id || fallbackFamilyId, 240);
  const coverageRole = relatedFamilyCoverageRole(value) || "required";
  return {
    familyId,
    coverageRole,
    requiredForAnswer: coverageRole === "required",
  };
}

function explicitRelatedFamilyRelationIssues(value = {}, item = {}) {
  const relatedFamilyIds = uniqueStrings(value.relatedFamilyIds, 30);
  const relations = Array.isArray(value.relatedFamilyRelations) ? value.relatedFamilyRelations : [];
  const families = Array.isArray(value.families) ? value.families : [];
  return relatedFamilyIds.flatMap((familyId) => {
    const source = relations.find((relation) => cleanText(relation?.familyId || relation?.id, 240) === familyId)
      || families.find((family) => cleanText(family?.id || family?.familyId, 240) === familyId);
    if (!source) {
      return [normalizeQualificationIssue({
        questionId: item.questionId,
        order: item.order,
        code: "related_family_relation_missing",
        label: FAMILY_SEMANTIC_ISSUE_LABELS.related_family_relation_missing,
        message: "重新审核时，每个关联题族都必须明确标记为作答必需或普通关联。",
        source: "family_semantic_gate_v1",
        familyId,
      }, item.questionId)];
    }
    const hasCoverageRole = Object.prototype.hasOwnProperty.call(source, "coverageRole");
    const requestedCoverageRole = cleanText(source.coverageRole, 40);
    const hasCompatibilityFlag = typeof source.requiredForAnswer === "boolean";
    const derivedCoverageRole = hasCompatibilityFlag ? (source.requiredForAnswer ? "required" : "reference") : "";
    if (!hasCoverageRole && !hasCompatibilityFlag) {
      return [normalizeQualificationIssue({
        questionId: item.questionId,
        order: item.order,
        code: "related_family_relation_missing",
        label: FAMILY_SEMANTIC_ISSUE_LABELS.related_family_relation_missing,
        message: "重新审核时，每个关联题族都必须明确标记为作答必需或普通关联。",
        source: "family_semantic_gate_v1",
        familyId,
      }, item.questionId)];
    }
    if ((hasCoverageRole && !RELATED_FAMILY_COVERAGE_ROLES.has(requestedCoverageRole))
      || (hasCoverageRole && hasCompatibilityFlag && requestedCoverageRole !== derivedCoverageRole)
    ) {
      return [normalizeQualificationIssue({
        questionId: item.questionId,
        order: item.order,
        code: "related_family_relation_invalid",
        label: FAMILY_SEMANTIC_ISSUE_LABELS.related_family_relation_invalid,
        message: "关联题族 coverageRole 必须是 required 或 reference，且不得与 requiredForAnswer 冲突。",
        source: "family_semantic_gate_v1",
        familyId,
        expected: { coverageRole: ["required", "reference"] },
        actual: clone(source),
      }, item.questionId)];
    }
    return [];
  });
}

function normalizeFamily(value = {}) {
  const coreKnowledge = normalizeKnowledgeNode(value.coreKnowledge || {
    id: value.coreKnowledgeNodeId || value.knowledgeNodeId,
    path: value.knowledgePath,
    title: value.primaryKnowledgePoint,
  });
  const explicitRequiredKnowledge = (Array.isArray(value.requiredKnowledge) ? value.requiredKnowledge : [])
    .map(normalizeKnowledgeNode).filter((item) => item.id || item.path || item.title).slice(0, 40);
  const hasExplicitRequiredKnowledge = Array.isArray(value.requiredKnowledgeNodeIds)
    || Array.isArray(value.requiredKnowledge);
  const requiredKnowledgeNodeIds = uniqueStrings([
    ...(value.requiredKnowledgeNodeIds || []),
    ...explicitRequiredKnowledge.map((item) => item.id),
    ...(!hasExplicitRequiredKnowledge && coreKnowledge.id ? [coreKnowledge.id] : []),
  ], 40);
  const representedRequiredIds = new Set(explicitRequiredKnowledge.map((item) => item.id).filter(Boolean));
  const requiredKnowledge = [
    ...explicitRequiredKnowledge,
    ...requiredKnowledgeNodeIds.filter((nodeId) => !representedRequiredIds.has(nodeId))
      .map((nodeId) => normalizeKnowledgeNode({ id: nodeId })),
  ];
  const explicitTextbookAnchors = (Array.isArray(value.textbookAnchors) ? value.textbookAnchors : [])
    .map(normalizeKnowledgeNode).filter((item) => item.id || item.path || item.title).slice(0, 40);
  const textbookAnchorNodeIds = uniqueStrings([
    ...(value.textbookAnchorNodeIds || []),
    ...explicitTextbookAnchors.map((item) => item.id),
  ], 40);
  const textbookAnchors = textbookAnchorNodeIds.map((nodeId) => explicitTextbookAnchors
    .find((item) => item.id === nodeId) || normalizeKnowledgeNode({ id: nodeId }));
  const members = (Array.isArray(value.members) ? value.members : [])
    .map(normalizeFamilyMember).filter((member) => member.questionId).slice(0, 1000);
  const memberQuestionIds = uniqueStrings([
    ...(value.memberQuestionIds || []),
    ...members.map((member) => member.questionId),
  ], 1000);
  const independentMemberQuestionIds = uniqueStrings([
    ...(value.independentMemberQuestionIds || []),
    ...members.filter((member) => member.isPrimary === true).map((member) => member.questionId),
  ], 1000);
  const coverageRole = relatedFamilyCoverageRole(value);
  return {
    id: cleanText(value.id || value.familyId, 240),
    name: cleanText(value.name, 400),
    version: Math.max(0, Number(value.version) || 0),
    status: FAMILY_STATUSES.has(value.status) ? value.status : "",
    bookId: cleanText(value.bookId, 160),
    coreKnowledge,
    coreKnowledgeNodeId: coreKnowledge.id,
    requiredKnowledge,
    requiredKnowledgeNodeIds,
    textbookAnchors,
    textbookAnchorNodeIds,
    focusKey: cleanText(value.focusKey, 600),
    assessmentAction: cleanText(value.assessmentAction || value.action, 600),
    inclusionBoundary: cleanText(value.inclusionBoundary, 6000),
    exclusionBoundary: cleanText(value.exclusionBoundary, 6000),
    independentMemberCount: Math.max(0, Number(value.independentMemberCount ?? independentMemberQuestionIds.length) || 0),
    memberQuestionIds,
    independentMemberQuestionIds,
    retainedIndependentMemberQuestionIds: uniqueStrings(value.retainedIndependentMemberQuestionIds, 200),
    members,
    membership: normalizeFamilyMembership(value.membership || {
      questionId: value.membershipQuestionId,
      isPrimary: value.isPrimary,
      role: value.membershipRole,
      contributionKnowledge: value.contributionKnowledge,
      contributionKnowledgeNodeIds: value.contributionKnowledgeNodeIds,
      revision: value.membershipRevision,
    }),
    provenance: cleanText(value.provenance || "existing_family", 80),
    ...(coverageRole ? { coverageRole, requiredForAnswer: coverageRole === "required" } : {}),
  };
}

function normalizeFamilyGold(value = {}, fallbackMode = "mature") {
  const replayMode = REPLAY_MODES.has(value.replayMode) ? value.replayMode
    : (REPLAY_MODES.has(fallbackMode) ? fallbackMode : "mature");
  const decision = FAMILY_DECISIONS.has(value.decision) ? value.decision
    : (replayMode === "unmatched" ? "create_new" : "join_existing");
  const families = (Array.isArray(value.families) ? value.families : []).map(normalizeFamily)
    .filter((family) => family.id || family.name).slice(0, 30);
  const relatedFamilyIds = uniqueStrings(value.relatedFamilyIds, 30);
  const submittedRelations = (Array.isArray(value.relatedFamilyRelations) ? value.relatedFamilyRelations : [])
    .map((relation) => normalizeRelatedFamilyRelation(relation))
    .filter((relation) => relation.familyId);
  const submittedRelationById = new Map(submittedRelations.map((relation) => [relation.familyId, relation]));
  const familyById = new Map(families.filter((family) => family.id).map((family) => [family.id, family]));
  const relatedFamilyRelations = relatedFamilyIds.map((familyId) => {
    const submitted = submittedRelationById.get(familyId);
    if (submitted) return submitted;
    const family = familyById.get(familyId);
    const familyCoverageRole = relatedFamilyCoverageRole(family || {});
    return normalizeRelatedFamilyRelation({
      familyId,
      ...(familyCoverageRole ? { coverageRole: familyCoverageRole } : {}),
    });
  });
  submittedRelations.forEach((relation) => {
    if (!relatedFamilyIds.includes(relation.familyId)) relatedFamilyRelations.push(relation);
  });
  const candidateFamily = value.candidateFamily && typeof value.candidateFamily === "object"
    ? normalizeFamily({ ...value.candidateFamily, provenance: value.candidateFamily.provenance || "candidate_new_family" })
    : null;
  const requestedFamilyKnowledgeProtocolVersion = cleanText(value.familyKnowledgeProtocolVersion, 80);
  return {
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSIONS.has(requestedFamilyKnowledgeProtocolVersion)
      ? requestedFamilyKnowledgeProtocolVersion : "",
    replayMode,
    decision,
    primaryFamilyId: cleanText(value.primaryFamilyId, 240),
    relatedFamilyIds,
    relatedFamilyRelations,
    families,
    candidateFamily,
    reason: cleanText(value.reason, 4000),
    ...(cleanText(value.replayModeChangeReason || value.changeReason, 4000)
      ? { replayModeChangeReason: cleanText(value.replayModeChangeReason || value.changeReason, 4000) }
      : {}),
  };
}

function finalReplayMode(item = {}) {
  const candidates = [
    item.humanGold?.familyGold?.replayMode,
    item.familyGold?.replayMode,
    item.finalReplayMode,
    item.sourceMode,
  ];
  return candidates.find((mode) => REPLAY_MODES.has(mode)) || "mature";
}

function replayModeCorrectionError(code, item = {}, details = {}) {
  const labels = {
    classification_gold_review_replay_mode_invalid: "盲测层级无效",
    classification_gold_review_replay_mode_conflict: "盲测层级字段互相冲突",
    classification_gold_review_replay_mode_locked: "当前题目不允许修改盲测层级",
    classification_gold_review_replay_mode_correction_required: "修改盲测层级必须选择人工修正",
    classification_gold_review_replay_mode_change_reason_required: "修改盲测层级必须填写原因",
  };
  const error = new Error(code);
  error.details = {
    code,
    label: labels[code] || "盲测层级修改失败",
    questionId: cleanText(item.questionId, 240),
    sourceMode: REPLAY_MODES.has(item.sourceMode) ? item.sourceMode : "",
    sourceModeLabel: REPLAY_MODE_LABELS[item.sourceMode] || "",
    ...clone(details),
  };
  return error;
}

function normalizeQuestion(value = {}, questionId = "") {
  const requestedChoiceStructure = cleanText(value.choiceStructure, 80);
  const choiceStructure = CHOICE_STRUCTURES.has(requestedChoiceStructure)
    ? requestedChoiceStructure
    : ((value.atomicStatements || []).length ? "composed_options" : "direct_options");
  return {
    id: cleanText(value.id || questionId, 240),
    version: Math.max(0, Number(value.version) || 0),
    bookId: cleanText(value.bookId, 160),
    type: cleanText(value.type, 80),
    typeLabel: cleanText(value.typeLabel, 120),
    stem: cleanText(value.stem, 20000),
    material: cleanText(value.material, 20000),
    options: (Array.isArray(value.options) ? value.options : []).map((option, index) => ({
      key: cleanText(option?.key || String.fromCharCode(65 + index), 20).toUpperCase(),
      text: cleanText(option?.text, 5000),
    })).filter((option) => option.key && option.text).slice(0, 12),
    choiceStructure,
    atomicStatements: choiceStructure === "composed_options"
      ? (Array.isArray(value.atomicStatements) ? value.atomicStatements : []).map((statement, index) => ({
        key: cleanText(statement?.key || String(index + 1), 20).toUpperCase(),
        text: cleanText(statement?.text, 5000),
        verdict: cleanText(statement?.verdict, 400),
      })).filter((statement) => statement.key && statement.text).slice(0, 40)
      : [],
    optionComposition: choiceStructure === "composed_options"
      ? (Array.isArray(value.optionComposition) ? value.optionComposition : [])
        .map(normalizeOptionComposition).filter((item) => item.optionKey && item.atomicKeys.length).slice(0, 20)
      : [],
    correctAnswer: uniqueStrings(value.correctAnswer, 20),
    referenceAnswer: cleanText(value.referenceAnswer, 12000),
    scoringPoints: (Array.isArray(value.scoringPoints) ? value.scoringPoints : []).map(normalizeScoringPoint),
    answerSource: cleanText(value.answerSource, 120),
    answerReviewStatus: cleanText(value.answerReviewStatus, 80),
    answerVerified: value.answerVerified === true,
    sourceLabel: cleanText(value.sourceLabel, 1000),
    sourcePage: cleanText(value.sourcePage, 400),
    updatedAt: Number(value.updatedAt) || 0,
  };
}

function normalizeOfficialBaseline(value = {}, fallback = {}) {
  const question = normalizeQuestion(value.question || fallback.question || {}, fallback.questionId || "");
  const answerKnowledge = normalizeAnswerKnowledge(
    value.answerKnowledge || fallback.answerKnowledge || {},
    question,
  );
  return {
    question,
    answerKnowledge,
    familyGold: normalizeFamilyGold(value.familyGold || fallback.familyGold || {}, fallback.sourceMode),
    capturedQuestionVersion: Math.max(0, Number(value.capturedQuestionVersion ?? question.version) || 0),
    provenance: clone(value.provenance || fallback.provenance || {}),
  };
}

function normalizeAiCandidateContent(value = {}) {
  const optionKnowledgeProtocolVersion = cleanText(value.optionKnowledgeProtocolVersion, 80) === OPTION_KNOWLEDGE_PROTOCOL_VERSION
    ? OPTION_KNOWLEDGE_PROTOCOL_VERSION : "";
  const choiceStructure = CHOICE_STRUCTURES.has(value.choiceStructure)
    ? value.choiceStructure
    : ((value.atomicStatements || []).length ? "composed_options" : "direct_options");
  return {
    textbookEvidence: (Array.isArray(value.textbookEvidence) ? value.textbookEvidence : [])
      .map(normalizeEvidence).filter((item) => item.chunkId || item.excerpt).slice(0, 40),
    coreKnowledge: normalizeKnowledgeNode(value.coreKnowledge || {}),
    coreKnowledgeRole: CORE_KNOWLEDGE_ROLES.has(cleanText(value.coreKnowledgeRole, 40))
      ? cleanText(value.coreKnowledgeRole, 40) : "core",
    requiredKnowledge: (Array.isArray(value.requiredKnowledge) ? value.requiredKnowledge : [])
      .map(normalizeKnowledgeNode).filter((item) => item.id || item.path || item.title).slice(0, 40),
    optionKnowledge: (Array.isArray(value.optionKnowledge) ? value.optionKnowledge : [])
      .map((item, index) => normalizeOptionKnowledge({
        ...item,
        optionKnowledgeProtocolVersion: item?.optionKnowledgeProtocolVersion || optionKnowledgeProtocolVersion,
      }, index)).filter((item) => item.key).slice(0, 12),
    optionKnowledgeProtocolVersion,
    choiceStructure,
    atomicStatements: choiceStructure === "composed_options"
      ? (Array.isArray(value.atomicStatements) ? value.atomicStatements : [])
        .map((item, index) => normalizeAtomicStatement({
          ...item,
          optionKnowledgeProtocolVersion: item?.optionKnowledgeProtocolVersion || optionKnowledgeProtocolVersion,
        }, index)).filter((item) => item.key && item.text).slice(0, 40)
      : [],
    optionComposition: choiceStructure === "composed_options"
      ? (Array.isArray(value.optionComposition) ? value.optionComposition : [])
        .map(normalizeOptionComposition).filter((item) => item.optionKey && item.atomicKeys.length).slice(0, 20)
      : [],
    scoringPoints: (Array.isArray(value.scoringPoints) ? value.scoringPoints : [])
      .map(normalizeScoringPoint).filter((item) => item.description).slice(0, 100),
    questionMode: cleanText(value.questionMode, 120),
    reason: cleanText(value.reason, 6000),
    agent1: clone(value.agent1 || {}),
    agent3: clone(value.agent3 || {}),
  };
}

function normalizeAiCandidateFamily(value = {}, fallbackMode = "mature") {
  const candidate = normalizeFamilyGold(value, fallbackMode);
  return {
    ...candidate,
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    similarityReason: cleanText(value.similarityReason || value.familySimilarityReason, 6000),
    matchedFamilyIds: uniqueStrings(value.matchedFamilyIds, 40),
    duplicateFamilyIds: uniqueStrings(value.duplicateFamilyIds, 40),
    agent3: clone(value.agent3 || {}),
  };
}

function normalizeAiCandidates(value = {}, fallbackMode = "mature", questionVersion = 0) {
  const validity = value.validity === "stale" ? "stale" : "current";
  return {
    policy: AI_COMPARISON_POLICY,
    validity,
    invalidatedAt: Number(value.invalidatedAt) || 0,
    invalidationReason: cleanText(value.invalidationReason, 1000),
    basedOnQuestionVersion: Math.max(0, Number(value.basedOnQuestionVersion ?? questionVersion) || 0),
    content: normalizeAiCandidateContent(value.content || {}),
    family: normalizeAiCandidateFamily(value.family || {}, fallbackMode),
    audit: clone(value.audit || {}),
  };
}

function normalizeHumanGold(value = {}, fallback = {}) {
  return {
    answerKnowledge: normalizeAnswerKnowledge(value.answerKnowledge || fallback.answerKnowledge || {}, fallback.question),
    answerKnowledgeProvenance: clone(value.answerKnowledgeProvenance || fallback.answerKnowledgeProvenance || {}),
    familyGold: normalizeFamilyGold(value.familyGold || fallback.familyGold || {}, fallback.sourceMode),
    familyGoldProvenance: clone(value.familyGoldProvenance || fallback.familyGoldProvenance || {}),
  };
}

function aiContentHasCandidate(content = {}) {
  return Boolean((content.textbookEvidence || []).length
    || content.coreKnowledge?.id || content.coreKnowledge?.path
    || (content.requiredKnowledge || []).length
    || (content.optionKnowledge || []).length || (content.atomicStatements || []).length
    || (content.scoringPoints || []).length
    || content.questionMode || Object.keys(content.agent1 || {}).length);
}

function presentAiCandidateContent(content = {}) {
  const normalized = normalizeAiCandidateContent(content);
  return {
    textbookEvidence: clone(normalized.textbookEvidence),
    coreKnowledge: clone(normalized.coreKnowledge),
    coreKnowledgeRole: normalized.coreKnowledgeRole,
    requiredKnowledge: clone(normalized.requiredKnowledge),
    optionKnowledge: clone(normalized.optionKnowledge),
    optionKnowledgeProtocolVersion: normalized.optionKnowledgeProtocolVersion,
    choiceStructure: normalized.choiceStructure,
    atomicStatements: clone(normalized.atomicStatements),
    optionComposition: clone(normalized.optionComposition),
    scoringPoints: clone(normalized.scoringPoints),
    questionMode: normalized.questionMode,
    agent1: Object.keys(normalized.agent1 || {}).length
      ? normalizeFeatureProfile(normalized.agent1)
      : {},
  };
}

function aiFamilyHasCandidate(family = {}) {
  return Boolean(family.primaryFamilyId || family.candidateFamily?.name || family.reason
    || (family.relatedFamilyIds || []).length || (family.matchedFamilyIds || []).length
    || Object.keys(family.agent3 || {}).length);
}

function presentItem(item) {
  const { aiCandidates, humanGold, ...visible } = clone(item);
  const contentRevealed = REVIEW_RESULTS.has(item.contentReview.result);
  const familyRevealed = REVIEW_RESULTS.has(item.familyReview.result)
    && item.familyReview.basedOnKnowledgeDigest === item.knowledgeDigest;
  const contentAvailable = aiContentHasCandidate(aiCandidates?.content);
  const familyAvailable = aiFamilyHasCandidate(aiCandidates?.family);
  return {
    ...visible,
    finalReplayMode: finalReplayMode(item),
    revisionReview: {
      status: item.qualificationAudit?.status || "inherited",
      inherited: item.qualificationAudit?.status === "inherited",
      requiredStages: clone(item.qualificationAudit?.requiredStages || []),
      issues: clone(item.qualificationAudit?.issues || []),
      parentSnapshotId: item.qualificationAudit?.parentSnapshotId || "",
      updatedAt: item.qualificationAudit?.updatedAt || 0,
    },
    humanGold: clone(humanGold),
    answerKnowledge: clone(humanGold.answerKnowledge),
    answerKnowledgeProvenance: clone(humanGold.answerKnowledgeProvenance),
    familyGold: clone(humanGold.familyGold),
    familyGoldProvenance: clone(humanGold.familyGoldProvenance),
    aiComparison: {
      policy: AI_COMPARISON_POLICY,
      goldSource: "human_submission_only",
      validity: aiCandidates?.validity || "current",
      invalidatedAt: aiCandidates?.invalidatedAt || 0,
      invalidationReason: aiCandidates?.invalidationReason || "",
      basedOnQuestionVersion: aiCandidates?.basedOnQuestionVersion || 0,
      content: {
        available: contentAvailable,
        revealed: contentAvailable && contentRevealed,
        candidate: contentAvailable && contentRevealed ? presentAiCandidateContent(aiCandidates.content) : null,
      },
      family: {
        available: familyAvailable,
        revealed: familyAvailable && familyRevealed,
        candidate: familyAvailable && familyRevealed ? clone(aiCandidates.family) : null,
      },
    },
  };
}

function formalKnowledgeKey(value) {
  const node = normalizeKnowledgeNode(value);
  if (node.id) return `id:${node.id}`;
  if (node.path) return `path:${node.path}`;
  return node.title ? `title:${node.title}` : "";
}

function formalBoundDigest(answerKnowledge, fallbackQuestion = {}) {
  const normalized = normalizeAnswerKnowledge(answerKnowledge, fallbackQuestion);
  const correctAnswer = String(fallbackQuestion?.type || "").trim() === "fill_blank"
    ? normalized.correctAnswer.flatMap((value) => String(value || "")
      .normalize("NFKC")
      .split(/[,，、;；|｜\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean))
    : normalized.correctAnswer;
  const requiredKnowledge = [...new Set(normalized.requiredKnowledge
    .map(formalKnowledgeKey).filter(Boolean))].sort();
  return contentHash({
    correctAnswer,
    referenceAnswer: normalized.referenceAnswer,
    answerSource: normalized.answerSource,
    answerReviewStatus: normalized.answerReviewStatus,
    coreKnowledge: formalKnowledgeKey(normalized.coreKnowledge),
    coreKnowledgeRole: normalized.coreKnowledgeRole,
    requiredKnowledge,
  });
}

function normalizeSubmittedAnswerKnowledge(value, item, question = item.question) {
  if (item.reviewMethod !== INDEPENDENT_REVIEW_METHOD) return normalizeAnswerKnowledge(value || {}, question);
  const previous = item.humanGold?.answerKnowledge || {};
  return normalizeAnswerKnowledge({
    ...value,
    optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
    choiceStructure: value?.choiceStructure || previous.choiceStructure || question.choiceStructure || "direct_options",
    atomicStatements: Object.prototype.hasOwnProperty.call(value || {}, "atomicStatements")
      ? value.atomicStatements : previous.atomicStatements,
    optionComposition: Object.prototype.hasOwnProperty.call(value || {}, "optionComposition")
      ? value.optionComposition : previous.optionComposition,
  }, question);
}

function humanSelectedEvidenceChunkIds(payload = {}) {
  return uniqueStrings(
    payload.selectedEvidenceChunkIds
      || payload.humanSelectedEvidenceChunkIds
      || payload.humanEvidenceSelection?.chunkIds,
    100,
  );
}

function serverEvidencePool(item, submittedAnswerKnowledge, allowSubmittedEvidence) {
  const candidates = [
    ...(item.sourceMaterials?.textbookEvidence || []),
    ...(item.officialBaseline?.answerKnowledge?.textbookEvidence || []),
    ...(item.humanGold?.answerKnowledge?.textbookEvidence || [])
      .filter((evidence) => evidence.humanSelection?.status === "selected"),
    ...(allowSubmittedEvidence ? submittedAnswerKnowledge.textbookEvidence || [] : []),
  ].map(normalizeEvidence).filter((evidence) => evidence.chunkId);
  return new Map(candidates.map((evidence) => [evidence.chunkId, evidence]));
}

function applyHumanEvidenceSelection(
  item,
  answerKnowledge,
  payload,
  reviewer,
  reviewedAt,
  { allowSubmittedEvidence = false } = {},
) {
  const independentReview = item.reviewMethod === INDEPENDENT_REVIEW_METHOD;
  const explicitSelectedIds = humanSelectedEvidenceChunkIds(payload);
  const selectedIds = independentReview || explicitSelectedIds.length
    ? explicitSelectedIds
    : uniqueStrings((answerKnowledge.textbookEvidence || []).map((evidence) => evidence.chunkId), 100);
  const evidenceById = serverEvidencePool(item, answerKnowledge, allowSubmittedEvidence);
  const unknownIds = selectedIds.filter((chunkId) => !evidenceById.has(chunkId));
  if (unknownIds.length) throw new Error("classification_gold_review_human_evidence_selection_invalid");
  if (!independentReview) {
    return normalizeAnswerKnowledge({
      ...answerKnowledge,
      textbookEvidence: selectedIds.map((chunkId) => evidenceById.get(chunkId)),
    }, item.question);
  }
  const previousSelectionById = new Map((item.humanGold.answerKnowledge.textbookEvidence || [])
    .filter((evidence) => evidence.chunkId && evidence.humanSelection?.status === "selected")
    .map((evidence) => [evidence.chunkId, evidence.humanSelection]));
  const selectedEvidence = selectedIds
    .map((chunkId) => evidenceById.get(chunkId))
    .map((evidence) => ({
      ...evidence,
      candidateOnly: false,
      humanSelection: previousSelectionById.get(evidence.chunkId) || {
        status: "selected",
        reviewer,
        selectedAt: reviewedAt,
      },
    }));
  return normalizeAnswerKnowledge({ ...answerKnowledge, textbookEvidence: selectedEvidence }, item.question);
}

function assertIndependentContentComplete(item, answerKnowledge, result) {
  if (item.reviewMethod !== INDEPENDENT_REVIEW_METHOD) return;
  if ((item.question.options || []).length
    && answerKnowledge.choiceStructure !== item.question.choiceStructure) {
    throw new Error("classification_gold_review_business_sync_required");
  }
  if (item.question.choiceStructure === "composed_options") {
    if (!composedStructureMatchesQuestion(item.question, answerKnowledge)) {
      throw new Error("classification_gold_review_composed_structure_changed");
    }
    if ((answerKnowledge.optionKnowledge || []).length) {
      throw new Error("classification_gold_review_composed_option_knowledge_forbidden");
    }
  }
  if (result === "disputed") return;
  if (!(answerKnowledge.textbookEvidence || []).some((evidence) => evidence.chunkId
    && evidence.candidateOnly !== true && evidence.humanSelection?.status === "selected")) {
    throw new Error("classification_gold_review_human_evidence_required");
  }
  if (!answerKnowledge.coreKnowledge?.id || !(answerKnowledge.requiredKnowledge || []).length) {
    throw new Error("classification_gold_review_human_knowledge_required");
  }
  if (answerKnowledge.coreKnowledgeRole === "scope_anchor"
    && !scopeAnchorMatchesRequiredKnowledge(answerKnowledge.coreKnowledge, answerKnowledge.requiredKnowledge)) {
    throw new Error("classification_gold_review_scope_anchor_invalid");
  }
  if ((item.question.options || []).length) {
    const composed = item.question.choiceStructure === "composed_options";
    const relationUnits = composed ? answerKnowledge.atomicStatements || [] : answerKnowledge.optionKnowledge || [];
    const expectedRelationKeys = composed
      ? item.question.atomicStatements.map((statement) => statement.key)
      : item.question.options.map((option) => option.key);
    const normalizedRelationKeys = expectedRelationKeys.map((key) => cleanText(key, 20).toUpperCase());
    const relationByKey = new Map(relationUnits.map((unit) => [unit.key, unit]));
    const relationIncomplete = !expectedRelationKeys.length
      || normalizedRelationKeys.some((key) => !key)
      || new Set(normalizedRelationKeys).size !== normalizedRelationKeys.length
      || expectedRelationKeys.some((key) => {
      const reviewed = relationByKey.get(key);
      const relation = reviewed?.knowledgeRelation;
      return !reviewed || !["question_only", "option_specific", "undetermined"].includes(relation)
        || (relation === "option_specific" && !(reviewed.knowledgeNodeIds || []).length)
        || (relation === "undetermined" && !cleanText(reviewed.uncertaintyNote, 4000))
        || (composed && (!cleanText(reviewed.text, 3000) || !cleanText(reviewed.basis, 4000)));
      });
    if (relationIncomplete) {
      throw new Error(composed
        ? "classification_gold_review_human_atomic_statements_required"
        : "classification_gold_review_human_option_knowledge_required");
    }
    if (composed) {
      const optionKeys = item.question.options.map((option) => cleanText(option.key, 20).toUpperCase());
      const atomicKeys = new Set(expectedRelationKeys.map((key) => cleanText(key, 20).toUpperCase()));
      const composition = answerKnowledge.optionComposition || [];
      const compositionByKey = new Map(composition.map((entry) => [
        cleanText(entry.optionKey, 20).toUpperCase(),
        entry,
      ]));
      const invalidComposition = optionKeys.some((key) => {
        const refs = uniqueStrings(compositionByKey.get(key)?.atomicKeys, 40).map((ref) => ref.toUpperCase());
        return !refs.length || refs.some((ref) => !atomicKeys.has(ref));
      });
      if (invalidComposition || composition.length !== optionKeys.length
        || compositionByKey.size !== new Set(optionKeys).size) {
        throw new Error("classification_gold_review_human_option_composition_required");
      }
    } else {
      const byKey = new Map((answerKnowledge.optionKnowledge || []).map((option) => [option.key, option]));
      const roleIncomplete = item.question.options.some((option) => {
        const reviewed = byKey.get(option.key);
        return !reviewed || reviewed.role === "unreviewed";
      });
      if (roleIncomplete) throw new Error("classification_gold_review_human_option_knowledge_required");
    }
  } else if (subjectiveQuestionTypes.has(item.question.type)
    && !(answerKnowledge.scoringPoints || []).some((point) => point.description && Number(point.score) > 0)) {
    throw new Error("classification_gold_review_human_scoring_points_required");
  }
}

function humanSubmissionProvenance(previous, stage, reviewer, reviewedAt) {
  return {
    ...(previous && typeof previous === "object" ? clone(previous) : {}),
    goldOrigin: "human_submission_only",
    aiCandidateAcceptedImplicitly: false,
    lastHumanSubmission: { stage, reviewer, reviewedAt },
  };
}

function appendReviewHistory(item, event) {
  const previousStageEvent = [...(item.reviewHistory || [])].reverse().find((entry) => entry.stage === event.stage);
  const firstSubmission = !previousStageEvent;
  const reviewEvent = {
    id: crypto.randomUUID(),
    firstSubmission,
    eventType: firstSubmission ? "first_human_judgment" : "final_adjudication",
    supersedesEventId: previousStageEvent?.id || "",
    ...clone(event),
  };
  item.reviewHistory = [...(item.reviewHistory || []), reviewEvent].slice(-200);
  return reviewEvent;
}

function normalizeFirstHumanJudgment(value = {}) {
  const normalizeEntry = (entry) => (entry && typeof entry === "object" ? clone(entry) : null);
  return {
    content: normalizeEntry(value.content),
    family: normalizeEntry(value.family),
  };
}

function preserveFirstHumanJudgment(item, stage, event, submittedGold) {
  item.firstHumanJudgment = normalizeFirstHumanJudgment(item.firstHumanJudgment);
  if (item.firstHumanJudgment[stage]) return;
  item.firstHumanJudgment[stage] = {
    eventId: event.id,
    result: event.result,
    note: event.note,
    reviewer: event.reviewer,
    reviewedAt: event.reviewedAt,
    questionVersion: item.question.version,
    knowledgeDigest: event.submittedKnowledgeDigest || event.basedOnKnowledgeDigest || item.knowledgeDigest,
    submittedGold: clone(submittedGold),
  };
}

function invalidateAiCandidates(item, reason, now = Date.now()) {
  item.aiCandidates = normalizeAiCandidates({
    ...item.aiCandidates,
    validity: "stale",
    invalidatedAt: now,
    invalidationReason: reason,
  }, item.sourceMode, item.aiCandidates?.basedOnQuestionVersion || item.question.version);
}

function knowledgeDigest(answerKnowledge) {
  return contentHash(normalizeAnswerKnowledge(answerKnowledge));
}

function legacyAiCandidates(value = {}, answerKnowledge = {}, familyGold = {}, sourceMode = "mature", questionVersion = 0) {
  const aiEvidence = (answerKnowledge.textbookEvidence || []).filter((item) => String(item.provenance || "").startsWith("ai_"));
  const aiOptions = (answerKnowledge.optionKnowledge || []).filter((item) => String(item.provenance || "").startsWith("ai_"));
  const aiPoints = (answerKnowledge.scoringPoints || []).filter((item) => String(item.provenance || "").startsWith("ai_"));
  const aiFamily = familyGold.candidateFamily && String(familyGold.candidateFamily.provenance || "").startsWith("ai_")
    ? familyGold.candidateFamily : null;
  const reference = value.aiReference || {};
  return normalizeAiCandidates({
    basedOnQuestionVersion: questionVersion,
    content: {
      textbookEvidence: aiEvidence,
      optionKnowledge: aiOptions,
      scoringPoints: aiPoints,
      questionMode: reference.agent1QuestionMode,
      coreKnowledge: reference.agent3PrimaryNodeId ? { id: reference.agent3PrimaryNodeId } : {},
      requiredKnowledge: (reference.agent3RequiredNodeIds || []).map((id) => ({ id })),
      reason: reference.agent3ContentReason,
      agent1: { questionMode: reference.agent1QuestionMode || "" },
      agent3: {
        contractStatus: reference.agent3ContractStatus || "",
        decision: reference.agent3Decision || "",
      },
    },
    family: {
      replayMode: sourceMode,
      decision: reference.agent3FamilyDecision,
      primaryFamilyId: reference.agent3PrimaryFamilyId,
      candidateFamily: reference.candidateFamilyDraft || aiFamily,
      reason: reference.agent3Reason,
      agent3: clone(reference),
    },
    audit: clone(reference),
  }, sourceMode, questionVersion);
}

function normalizeQualificationIssue(value = {}, fallbackQuestionId = "") {
  const requiredStages = uniqueStrings(value.requiredStages, 4)
    .filter((stage) => ["content", "family"].includes(stage));
  return {
    questionId: cleanText(value.questionId || fallbackQuestionId, 240),
    order: Math.max(0, Number(value.order) || 0),
    code: cleanText(value.code || "qualification_review_required", 160),
    label: cleanText(value.label || value.message || value.reason, 400),
    message: cleanText(value.message || value.reason, 4000),
    source: cleanText(value.source || "revision_request", 120),
    ...(value.severity === "warning" ? { severity: "warning" } : {}),
    familyId: cleanText(value.familyId, 240),
    familyName: cleanText(value.familyName, 400),
    path: cleanText(value.path, 1000),
    requiredStages,
    expected: clone(value.expected),
    actual: clone(value.actual),
  };
}

// A preflight may be run repeatedly (for example when the review page is
// refreshed).  Keep the persisted issue list deterministic so the same
// semantic conflict does not grow the audit forever.
function qualificationIssueKey(issue = {}) {
  return contentHash({
    questionId: cleanText(issue.questionId, 240),
    code: cleanText(issue.code, 160),
    familyId: cleanText(issue.familyId, 240),
    path: cleanText(issue.path, 1000),
    requiredStages: uniqueStrings(issue.requiredStages, 4),
    severity: issue.severity === "warning" ? "warning" : "error",
    message: cleanText(issue.message, 4000),
    expected: clone(issue.expected),
    actual: clone(issue.actual),
  });
}

function mergeQualificationIssues(...groups) {
  const result = [];
  const seen = new Set();
  groups.flatMap((group) => (Array.isArray(group) ? group : [])).forEach((issue) => {
    const normalized = normalizeQualificationIssue(issue, issue?.questionId);
    if (!normalized.questionId) return;
    const key = qualificationIssueKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  });
  return result.slice(0, 100);
}

function normalizeQualificationAudit(value = {}, questionId = "") {
  const issues = (Array.isArray(value.issues) ? value.issues : [])
    .map((issue) => normalizeQualificationIssue(issue, questionId))
    .filter((issue) => issue.questionId).slice(0, 100);
  return {
    status: ["inherited", "requires_content_review", "requires_family_review", "resolved"].includes(value.status)
      ? value.status : "inherited",
    parentSnapshotId: cleanText(value.parentSnapshotId, 240),
    requiredStages: uniqueStrings(value.requiredStages, 4)
      .filter((stage) => ["content", "family"].includes(stage)),
    issues,
    updatedAt: Number(value.updatedAt) || 0,
  };
}

function advanceQualificationAfterContentReview(item, reviewedAt) {
  if (item.qualificationAudit?.status !== "requires_content_review") return;
  const requiredStages = uniqueStrings(item.qualificationAudit.requiredStages, 4)
    .filter((stage) => stage !== "content");
  item.qualificationAudit = normalizeQualificationAudit({
    ...item.qualificationAudit,
    status: requiredStages.includes("family") ? "requires_family_review" : "resolved",
    requiredStages,
    updatedAt: reviewedAt,
  }, item.questionId);
}

function assertRevisionStageWritable(item, stage, options = {}) {
  if (!item.qualificationAudit?.parentSnapshotId) return;
  const requiredStages = uniqueStrings(item.qualificationAudit.requiredStages, 4)
    .filter((value) => ["content", "family"].includes(value));
  if (requiredStages.includes(stage)) return;
  if (stage === "content" && options.allowFormalDriftReopen === true) return;
  const error = new Error("classification_gold_review_revision_stage_locked");
  error.details = {
    questionId: item.questionId,
    requestedStage: stage,
    requiredStages,
    qualificationStatus: item.qualificationAudit.status,
  };
  throw error;
}

function normalizeItem(value = {}, index = 0) {
  const questionId = cleanText(value.questionId || value.question?.id, 240);
  const question = normalizeQuestion(value.question, questionId);
  const sourceMode = REPLAY_MODES.has(value.sourceMode || value.mode) ? (value.sourceMode || value.mode) : "mature";
  const rawAnswerKnowledge = normalizeAnswerKnowledge(value.humanGold?.answerKnowledge || value.answerKnowledge, question);
  const submittedFamilyGold = value.humanGold?.familyGold || value.familyGold || {};
  const rawFamilyGold = normalizeFamilyGold(REPLAY_MODES.has(value.finalReplayMode)
    ? { ...submittedFamilyGold, replayMode: value.finalReplayMode }
    : submittedFamilyGold, sourceMode);
  const reviewMethod = cleanText(value.reviewMethod
    || (value.aiCandidates || value.aiReference ? INDEPENDENT_REVIEW_METHOD : "legacy_prefilled_gold"), 120);
  const legacyAi = value.aiCandidates ? null
    : legacyAiCandidates(value, rawAnswerKnowledge, rawFamilyGold, sourceMode, question.version);
  const stripLegacyAi = reviewMethod === INDEPENDENT_REVIEW_METHOD && !value.humanGold;
  const answerKnowledge = stripLegacyAi ? normalizeAnswerKnowledge({
    ...rawAnswerKnowledge,
    textbookEvidence: (rawAnswerKnowledge.textbookEvidence || [])
      .filter((item) => !String(item.provenance || "").startsWith("ai_")),
    optionKnowledge: (rawAnswerKnowledge.optionKnowledge || [])
      .filter((item) => !String(item.provenance || "").startsWith("ai_")),
    scoringPoints: (rawAnswerKnowledge.scoringPoints || [])
      .filter((item) => !String(item.provenance || "").startsWith("ai_")),
  }, question) : rawAnswerKnowledge;
  const familyGold = stripLegacyAi && rawFamilyGold.candidateFamily
      && String(rawFamilyGold.candidateFamily.provenance || "").startsWith("ai_")
    ? normalizeFamilyGold({ ...rawFamilyGold, candidateFamily: null }, sourceMode)
    : rawFamilyGold;
  const humanGold = normalizeHumanGold(value.humanGold || {}, {
    question,
    sourceMode,
    answerKnowledge,
    answerKnowledgeProvenance: value.answerKnowledgeProvenance,
    familyGold,
    familyGoldProvenance: value.familyGoldProvenance,
  });
  const sourceMaterials = normalizeSourceMaterials(value.sourceMaterials || {
    sourceAnswer: question,
    textbookEvidence: rawAnswerKnowledge.textbookEvidence,
    provenance: value.aiReference ? "legacy_replay_source_material" : "review_source_material",
  }, question);
  const officialBaseline = normalizeOfficialBaseline(value.officialBaseline || {}, {
    questionId,
    question,
    answerKnowledge: humanGold.answerKnowledge,
    familyGold: humanGold.familyGold,
    sourceMode,
    provenance: { source: value.aiReference ? "legacy_formal_snapshot" : "import_payload" },
  });
  const aiCandidates = normalizeAiCandidates(value.aiCandidates || legacyAi || {}, sourceMode, question.version);
  return {
    order: Math.max(1, Number(value.order) || index + 1),
    questionId,
    sourceMode,
    sourceGoldStatus: cleanText(value.sourceGoldStatus || value.goldStatus, 80),
    reviewMethod,
    question,
    officialBaseline,
    sourceMaterials,
    humanGold,
    aiCandidates,
    contentReview: normalizeReview(value.contentReview),
    familyReview: normalizeReview(value.familyReview),
    reviewHistory: (Array.isArray(value.reviewHistory) ? value.reviewHistory : []).map((entry) => clone(entry)).slice(-200),
    firstHumanJudgment: normalizeFirstHumanJudgment(value.firstHumanJudgment),
    qualificationAudit: normalizeQualificationAudit(value.qualificationAudit, questionId),
    knowledgeDigest: cleanText(value.knowledgeDigest, 128) || knowledgeDigest(humanGold.answerKnowledge),
    revision: Math.max(1, Number(value.revision) || 1),
    importedAt: Number(value.importedAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

function batchSummary(batch) {
  const items = batch.items || [];
  const completed = items.filter((item) => REVIEW_RESULTS.has(item.contentReview.result)
    && REVIEW_RESULTS.has(item.familyReview.result)
    && item.familyReview.basedOnKnowledgeDigest === item.knowledgeDigest);
  const disputed = completed.filter((item) => item.contentReview.result === "disputed" || item.familyReview.result === "disputed");
  const disputedIds = new Set(disputed.map((item) => item.questionId));
  const corrected = completed.filter((item) => !disputedIds.has(item.questionId)
    && (item.contentReview.result === "corrected" || item.familyReview.result === "corrected"));
  const correctedIds = new Set(corrected.map((item) => item.questionId));
  const confirmed = completed.filter((item) => !disputedIds.has(item.questionId) && !correctedIds.has(item.questionId)
    && item.contentReview.result === "confirmed" && item.familyReview.result === "confirmed");
  return {
    total: items.length,
    completed: completed.length,
    pending: items.length - completed.length,
    confirmed: confirmed.length,
    corrected: corrected.length,
    disputed: disputed.length,
    accuracyEligible: completed.length - disputed.length,
    readyToFreeze: items.length > 0 && completed.length === items.length,
    frozen: batch.status === "frozen",
    modes: Object.fromEntries([...REPLAY_MODES]
      .map((mode) => [mode, items.filter((item) => finalReplayMode(item) === mode).length])),
  };
}

// Mutation responses only need the monotonic batch clock.  Returning the
// complete batch here would make every save unnecessarily large and could
// let a stale snapshot overwrite the item that was just reviewed.
function batchMeta(batch) {
  if (!batch) return null;
  return {
    id: cleanText(batch.id, 240),
    revision: Math.max(1, Number(batch.revision) || 1),
    updatedAt: Number(batch.updatedAt) || 0,
  };
}

function normalizeBatch(value = {}) {
  const items = (Array.isArray(value.items) ? value.items : []).map(normalizeItem)
    .filter((item) => item.questionId).sort((left, right) => left.order - right.order);
  return {
    id: cleanText(value.id, 240),
    title: cleanText(value.title || "20题盲测金标集V1", 400),
    version: cleanText(value.version || "V1", 80),
    status: value.status === "frozen" ? "frozen" : "reviewing",
    source: clone(value.source || {}),
    revisionReview: value.revisionReview ? clone(value.revisionReview) : null,
    familyReopenOperations: (Array.isArray(value.familyReopenOperations) ? value.familyReopenOperations : [])
      .map((operation) => clone(operation)).slice(-200),
    items,
    revision: Math.max(1, Number(value.revision) || 1),
    importedAt: Number(value.importedAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
    frozenAt: Number(value.frozenAt) || 0,
    frozenBy: cleanText(value.frozenBy, 120),
    snapshot: value.snapshot ? clone(value.snapshot) : null,
    freezePreparation: value.freezePreparation ? clone(value.freezePreparation) : null,
  };
}

function normalizeState(value = {}) {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    batches: (Array.isArray(value.batches) ? value.batches : []).map(normalizeBatch).filter((batch) => batch.id),
  };
}

function snapshotPayload(batch, reviewer, now) {
  const items = batch.items.map((item) => {
    const disputed = item.contentReview.result === "disputed" || item.familyReview.result === "disputed";
    const answerKnowledge = item.humanGold.answerKnowledge;
    const replayMode = finalReplayMode(item);
    const familyGold = normalizeFamilyGold({
      ...item.humanGold.familyGold,
      replayMode,
    }, replayMode);
    const usesFamilyKnowledgeV3 = familyGold.familyKnowledgeProtocolVersion === FAMILY_KNOWLEDGE_PROTOCOL_VERSION;
    const answerAndEvidence = clone(answerKnowledge);
    if (!usesFamilyKnowledgeV3) delete answerAndEvidence.coreKnowledgeRole;
    return {
      order: item.order,
      questionId: item.questionId,
      replayMode,
      goldStatus: disputed ? "gold_needs_review" : "confirmed",
      includedInAccuracy: !disputed,
      questionSnapshot: clone(item.question),
      answerAndEvidence,
      knowledgeGold: {
        coreKnowledge: clone(answerKnowledge.coreKnowledge),
        ...(usesFamilyKnowledgeV3 ? { coreKnowledgeRole: answerKnowledge.coreKnowledgeRole } : {}),
        requiredKnowledge: clone(answerKnowledge.requiredKnowledge),
        optionKnowledge: clone(answerKnowledge.optionKnowledge),
        optionKnowledgeProtocolVersion: answerKnowledge.optionKnowledgeProtocolVersion,
        choiceStructure: answerKnowledge.choiceStructure,
        atomicStatements: clone(answerKnowledge.atomicStatements),
        optionComposition: clone(answerKnowledge.optionComposition),
        scoringPoints: clone(answerKnowledge.scoringPoints),
      },
      familyGold: clone(familyGold),
      audit: {
        contentReview: clone(item.contentReview),
        familyReview: clone(item.familyReview),
        reviewHistory: clone(item.reviewHistory),
        firstHumanJudgment: clone(item.firstHumanJudgment),
        answerKnowledgeProvenance: clone(item.humanGold.answerKnowledgeProvenance),
        familyGoldProvenance: clone(item.humanGold.familyGoldProvenance),
        qualificationAudit: clone(item.qualificationAudit),
        itemRevision: item.revision,
        knowledgeDigest: item.knowledgeDigest,
        reviewMethod: item.reviewMethod,
        sourceReplayMode: item.sourceMode,
        finalReplayMode: replayMode,
      },
    };
  });
  const summary = {
    total: items.length,
    accuracyEligible: items.filter((item) => item.includedInAccuracy).length,
    goldNeedsReview: items.filter((item) => !item.includedInAccuracy).length,
    modes: Object.fromEntries([...REPLAY_MODES].map((mode) => [mode, items.filter((item) => item.replayMode === mode).length])),
    books: items.reduce((counts, item) => {
      const bookId = item.questionSnapshot.bookId || "unknown";
      counts[bookId] = (counts[bookId] || 0) + 1;
      return counts;
    }, {}),
  };
  const choiceItems = items.filter((item) => (item.questionSnapshot?.options || []).length);
  const usesOptionKnowledgeV2 = choiceItems.length > 0 && choiceItems
    .every((item) => item.knowledgeGold?.optionKnowledgeProtocolVersion === OPTION_KNOWLEDGE_PROTOCOL_VERSION);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    ...(usesOptionKnowledgeV2 ? { optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION } : {}),
    snapshotId: `classification-gold-${batch.version.toLowerCase()}-${crypto.randomUUID()}`,
    title: batch.title,
    version: batch.version,
    status: "frozen",
    source: clone(batch.source),
    ...(batch.revisionReview ? { revisionReview: clone(batch.revisionReview) } : {}),
    ...(batch.familyReopenOperations?.length
      ? { familyReopenOperations: clone(batch.familyReopenOperations) }
      : {}),
    reviewBatchId: batch.id,
    reviewer: cleanText(reviewer || "超级管理员", 120),
    reviewedAt: new Date(now).toISOString(),
    frozenAt: new Date(now).toISOString(),
    summary,
    items,
  };
}

function safeSnapshotFileName(batch) {
  const title = cleanText(batch.title, 160);
  const stem = (title.toLocaleLowerCase("zh-CN").endsWith(cleanText(batch.version, 80).toLocaleLowerCase("zh-CN"))
    ? title
    : `${title}-${batch.version}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  return `${stem || "classification-gold-snapshot"}.json`;
}

function preparedSnapshotBytes(payload) {
  const contentSha256 = contentHash(payload);
  const document = { ...payload, integrity: { algorithm: "sha256", contentSha256 } };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { document, bytes, contentSha256, fileSha256: sha256(bytes) };
}

function writeImmutableSnapshotBytes(snapshotDir, batch, bytes, expectedFileSha256) {
  fs.mkdirSync(snapshotDir, { recursive: true });
  const filePath = path.resolve(snapshotDir, safeSnapshotFileName(batch));
  const relative = path.relative(path.resolve(snapshotDir), filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("classification_gold_snapshot_path_invalid");
  if (fs.existsSync(filePath)) throw new Error("classification_gold_snapshot_version_exists");
  const fileSha256 = sha256(bytes);
  if (fileSha256 !== expectedFileSha256) throw new Error("classification_gold_snapshot_preparation_corrupt");
  fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o444 });
  const sidecarPath = `${filePath}.sha256`;
  fs.writeFileSync(sidecarPath, `${fileSha256}  ${path.basename(filePath)}\n`, { flag: "wx", mode: 0o444 });
  return { filePath, sidecarPath, fileSha256 };
}

function optionKnowledgeHasValues(option = {}) {
  return uniqueStrings(option.knowledgeNodeIds, 20).length > 0
    || uniqueStrings(option.knowledgeLabels || option.knowledgeHints, 20).length > 0;
}

function assertV2KnowledgeUnit(unit, expectedKey, { atomic = false } = {}) {
  if (!unit || cleanText(unit.key, 20).toUpperCase() !== expectedKey) {
    throw new Error(`classification_gold_snapshot_option_missing:${expectedKey}`);
  }
  if (cleanText(unit.protocolVersion || unit.optionKnowledgeProtocolVersion, 80) !== OPTION_KNOWLEDGE_PROTOCOL_VERSION) {
    throw new Error(`classification_gold_snapshot_option_protocol_invalid:${expectedKey}`);
  }
  const relation = cleanText(unit.knowledgeRelation, 40);
  if (!["question_only", "option_specific", "undetermined"].includes(relation)) {
    throw new Error(`classification_gold_snapshot_option_relation_invalid:${expectedKey}`);
  }
  const hasKnowledge = optionKnowledgeHasValues(unit);
  if ((relation === "option_specific" && !uniqueStrings(unit.knowledgeNodeIds, 20).length)
    || (relation !== "option_specific" && hasKnowledge)) {
    throw new Error(`classification_gold_snapshot_option_knowledge_invalid:${expectedKey}`);
  }
  if (relation === "undetermined" && !cleanText(unit.uncertaintyNote, 4000)) {
    throw new Error(`classification_gold_snapshot_option_uncertainty_required:${expectedKey}`);
  }
  if (atomic && (!cleanText(unit.text, 3000) || !cleanText(unit.basis, 4000))) {
    throw new Error(`classification_gold_snapshot_atomic_statement_incomplete:${expectedKey}`);
  }
}

function assertUniqueKeyedItems(items, keyName, errorCode) {
  const keys = items.map((item) => cleanText(item?.[keyName], 20).toUpperCase());
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error(errorCode);
  return keys;
}

function assertFrozenV2OptionKnowledge(item) {
  const knowledgeGold = item.knowledgeGold || item.answerAndEvidence || {};
  const answerAndEvidence = item.answerAndEvidence || {};
  const protocolVersion = cleanText(
    knowledgeGold.optionKnowledgeProtocolVersion || answerAndEvidence.optionKnowledgeProtocolVersion,
    80,
  );
  if (protocolVersion !== OPTION_KNOWLEDGE_PROTOCOL_VERSION) {
    throw new Error(`classification_gold_snapshot_option_protocol_invalid:${item.questionId}`);
  }
  const options = Array.isArray(item.questionSnapshot?.options) ? item.questionSnapshot.options : [];
  if (!options.length) return;
  const choiceStructure = cleanText(knowledgeGold.choiceStructure || answerAndEvidence.choiceStructure, 80);
  if (!CHOICE_STRUCTURES.has(choiceStructure)) {
    throw new Error(`classification_gold_snapshot_choice_structure_invalid:${item.questionId}`);
  }
  if (choiceStructure !== cleanText(item.questionSnapshot?.choiceStructure, 80)) {
    throw new Error(`classification_gold_snapshot_choice_structure_changed:${item.questionId}`);
  }
  const optionKnowledge = Array.isArray(knowledgeGold.optionKnowledge)
    ? knowledgeGold.optionKnowledge : (answerAndEvidence.optionKnowledge || []);
  const optionKeys = assertUniqueKeyedItems(options, "key", "classification_gold_snapshot_question_option_keys_invalid");
  if (choiceStructure === "direct_options") {
    assertUniqueKeyedItems(optionKnowledge, "key", "classification_gold_snapshot_option_keys_invalid");
    const byKey = new Map(optionKnowledge.map((option) => [cleanText(option.key, 20).toUpperCase(), option]));
    if (optionKnowledge.length !== optionKeys.length) throw new Error("classification_gold_snapshot_option_count_invalid");
    optionKeys.forEach((key) => assertV2KnowledgeUnit(byKey.get(key), key));
    return;
  }

  const atomicStatements = Array.isArray(knowledgeGold.atomicStatements)
    ? knowledgeGold.atomicStatements : (answerAndEvidence.atomicStatements || []);
  if (!composedStructureMatchesQuestion(item.questionSnapshot, {
    choiceStructure,
    atomicStatements,
    optionComposition: Array.isArray(knowledgeGold.optionComposition)
      ? knowledgeGold.optionComposition : (answerAndEvidence.optionComposition || []),
  })) {
    throw new Error(`classification_gold_snapshot_composed_structure_changed:${item.questionId}`);
  }
  const atomicKeys = assertUniqueKeyedItems(
    atomicStatements,
    "key",
    "classification_gold_snapshot_atomic_statement_keys_invalid",
  );
  if (!atomicKeys.length) throw new Error("classification_gold_snapshot_atomic_statements_required");
  const atomicByKey = new Map(atomicStatements.map((statement) => [cleanText(statement.key, 20).toUpperCase(), statement]));
  atomicKeys.forEach((key) => assertV2KnowledgeUnit(atomicByKey.get(key), key, { atomic: true }));

  const optionComposition = Array.isArray(knowledgeGold.optionComposition)
    ? knowledgeGold.optionComposition : (answerAndEvidence.optionComposition || []);
  const compositionKeys = assertUniqueKeyedItems(
    optionComposition,
    "optionKey",
    "classification_gold_snapshot_option_composition_keys_invalid",
  );
  if (compositionKeys.length !== optionKeys.length || optionKeys.some((key) => !compositionKeys.includes(key))) {
    throw new Error("classification_gold_snapshot_option_composition_incomplete");
  }
  const knownAtomicKeys = new Set(atomicKeys);
  optionComposition.forEach((composition) => {
    const refs = uniqueStrings(composition.atomicKeys, 40).map((key) => key.toUpperCase());
    if (!refs.length || refs.some((key) => !knownAtomicKeys.has(key))) {
      throw new Error(`classification_gold_snapshot_option_composition_invalid:${composition.optionKey}`);
    }
  });
  const composedOptionKnowledge = [knowledgeGold.optionKnowledge, answerAndEvidence.optionKnowledge]
    .filter(Array.isArray).flat();
  if (composedOptionKnowledge.length) {
    throw new Error(`classification_gold_snapshot_composed_option_knowledge_forbidden:${item.questionId}`);
  }
}

function assertReviewOnlyV2OptionKnowledge(item) {
  const knowledgeGold = item.knowledgeGold || item.answerAndEvidence || {};
  const answerAndEvidence = item.answerAndEvidence || {};
  const protocolVersion = cleanText(
    knowledgeGold.optionKnowledgeProtocolVersion || answerAndEvidence.optionKnowledgeProtocolVersion,
    80,
  );
  if (protocolVersion !== OPTION_KNOWLEDGE_PROTOCOL_VERSION) {
    throw new Error(`classification_gold_snapshot_option_protocol_invalid:${item.questionId}`);
  }
  const choiceStructure = cleanText(knowledgeGold.choiceStructure || answerAndEvidence.choiceStructure, 80);
  if (choiceStructure === "composed_options") {
    if (choiceStructure !== cleanText(item.questionSnapshot?.choiceStructure, 80)
      || !composedStructureMatchesQuestion(item.questionSnapshot, {
        choiceStructure,
        atomicStatements: Array.isArray(knowledgeGold.atomicStatements)
          ? knowledgeGold.atomicStatements : (answerAndEvidence.atomicStatements || []),
        optionComposition: Array.isArray(knowledgeGold.optionComposition)
          ? knowledgeGold.optionComposition : (answerAndEvidence.optionComposition || []),
      })) {
      throw new Error(`classification_gold_snapshot_composed_structure_changed:${item.questionId}`);
    }
    const composedOptionKnowledge = [knowledgeGold.optionKnowledge, answerAndEvidence.optionKnowledge]
      .filter(Array.isArray).flat();
    if (composedOptionKnowledge.length) {
      throw new Error(`classification_gold_snapshot_composed_option_knowledge_forbidden:${item.questionId}`);
    }
  }
  const units = [
    ...(Array.isArray(knowledgeGold.optionKnowledge)
      ? knowledgeGold.optionKnowledge : (answerAndEvidence.optionKnowledge || [])),
    ...(Array.isArray(knowledgeGold.atomicStatements)
      ? knowledgeGold.atomicStatements : (answerAndEvidence.atomicStatements || [])),
  ];
  units.forEach((unit) => {
    const relation = cleanText(unit?.knowledgeRelation, 40);
    if (!["unreviewed", "question_only", "option_specific", "undetermined"].includes(relation)) {
      throw new Error(`classification_gold_snapshot_option_relation_invalid:${cleanText(unit?.key, 20)}`);
    }
    if (relation !== "option_specific" && optionKnowledgeHasValues(unit)) {
      throw new Error(`classification_gold_snapshot_option_knowledge_invalid:${cleanText(unit?.key, 20)}`);
    }
  });
}

function assertFrozenAccuracyEligibility(snapshot) {
  snapshot.items.forEach((item) => {
    if (!["confirmed", "gold_needs_review"].includes(item.goldStatus)
      || typeof item.includedInAccuracy !== "boolean"
      || item.includedInAccuracy !== (item.goldStatus === "confirmed")) {
      throw new Error(`classification_gold_snapshot_accuracy_eligibility_invalid:${item.questionId}`);
    }
  });
}

function assertFrozenOptionKnowledge(snapshot) {
  const v2 = cleanText(snapshot.optionKnowledgeProtocolVersion, 80) === OPTION_KNOWLEDGE_PROTOCOL_VERSION;
  snapshot.items.forEach((item) => {
    if (v2) {
      if (item.includedInAccuracy === false || item.goldStatus === "gold_needs_review") {
        assertReviewOnlyV2OptionKnowledge(item);
      } else {
        assertFrozenV2OptionKnowledge(item);
      }
      return;
    }
    const optionKnowledge = Array.isArray(item.knowledgeGold?.optionKnowledge)
      ? item.knowledgeGold.optionKnowledge
      : (Array.isArray(item.answerAndEvidence?.optionKnowledge) ? item.answerAndEvidence.optionKnowledge : []);
    optionKnowledge.forEach((option) => {
      if (!Object.prototype.hasOwnProperty.call(option, "knowledgeRelation")) return;
      const relation = cleanText(option.knowledgeRelation, 40);
      const hasKnowledge = optionKnowledgeHasValues(option);
      if (!OPTION_KNOWLEDGE_RELATIONS.has(relation)
        || (relation === "option_specific" && !hasKnowledge)
        || (relation !== "option_specific" && hasKnowledge)) {
        throw new Error("classification_gold_snapshot_option_knowledge_invalid");
      }
    });
  });
}

function readFrozenGoldSnapshot(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const bytes = fs.readFileSync(absolutePath);
  const fileSha256 = sha256(bytes);
  const snapshot = JSON.parse(bytes.toString("utf8"));
  if (snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || snapshot?.status !== "frozen") {
    throw new Error("classification_gold_snapshot_invalid");
  }
  const { integrity, ...payload } = snapshot;
  if (!integrity?.contentSha256 || contentHash(payload) !== integrity.contentSha256) {
    throw new Error("classification_gold_snapshot_content_hash_mismatch");
  }
  const sidecarPath = `${absolutePath}.sha256`;
  if (options.requireSidecar !== false) {
    const sidecar = fs.readFileSync(sidecarPath, "utf8").trim().split(/\s+/)[0];
    if (sidecar !== fileSha256) throw new Error("classification_gold_snapshot_file_hash_mismatch");
  }
  if (!Array.isArray(snapshot.items) || !snapshot.items.length) throw new Error("classification_gold_snapshot_items_required");
  const questionIds = snapshot.items.map((item) => String(item.questionId || ""));
  if (questionIds.some((id) => !id) || new Set(questionIds).size !== questionIds.length) {
    throw new Error("classification_gold_snapshot_question_ids_invalid");
  }
  assertFrozenAccuracyEligibility(snapshot);
  assertFrozenOptionKnowledge(snapshot);
  return { snapshot, filePath: absolutePath, sidecarPath, fileSha256, contentSha256: integrity.contentSha256, bytes };
}

function presentBatch(batch) {
  const { freezePreparation, ...visible } = clone(batch);
  return {
    ...visible,
    items: (batch.items || []).map(presentItem),
    summary: batchSummary(batch),
    batchMeta: batchMeta(batch),
    freezePreparation: freezePreparation ? {
      preparedAt: freezePreparation.preparedAt,
      expiresAt: freezePreparation.expiresAt,
      batchRevision: freezePreparation.batchRevision,
      fileSha256: freezePreparation.fileSha256,
      contentSha256: freezePreparation.contentSha256,
      byteLength: freezePreparation.byteLength,
      summary: clone(freezePreparation.summary),
    } : null,
  };
}

function sameImportIdentity(left = {}, right = {}) {
  return cleanText(left.sourceBatchId, 240) === cleanText(right.sourceBatchId, 240)
    && cleanText(left.manifestSha256, 128) === cleanText(right.manifestSha256, 128);
}

function normalizedKnowledgeText(value) {
  return cleanText(value, 1200).toLocaleLowerCase("zh-CN")
    .replace(/[（(]?[一二三四五六七八九十百]+[、.．)）\s]*/g, "")
    .replace(/[\s，。！？；：、“”‘’（）()【】\[\]《》<>·…—-]/g, "");
}

function knowledgeNodesCompatible(leftValue, rightValue) {
  const left = normalizeKnowledgeNode(leftValue || {});
  const right = normalizeKnowledgeNode(rightValue || {});
  const leftIds = new Set(uniqueStrings([left.id, left.canonicalNodeId, ...left.aliasNodeIds], 50));
  const rightIds = new Set(uniqueStrings([right.id, right.canonicalNodeId, ...right.aliasNodeIds], 50));
  const leftPath = normalizedKnowledgeText(left.path);
  const rightPath = normalizedKnowledgeText(right.path);
  // A frozen review may contain legacy outline IDs while the live catalog
  // uses catalog-node IDs.  The complete textbook path is the stable bridge;
  // use it after an ID miss, and only use a title when no ID/path exists.
  if (leftIds.size && rightIds.size && [...leftIds].some((nodeId) => rightIds.has(nodeId))) return true;
  if (leftPath && rightPath) return leftPath === rightPath;
  if (leftIds.size || rightIds.size) return false;
  const leftTitle = normalizedKnowledgeText(left.title);
  const rightTitle = normalizedKnowledgeText(right.title);
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

function knowledgePathSegments(value) {
  return cleanText(value, 1200).split(/[>＞]/)
    .map((segment) => normalizedKnowledgeText(segment)).filter(Boolean);
}

// A family may declare a broader textbook node while a question stores the
// more specific leaf node.  Coverage is directional: the broader node covers
// its descendant, but the descendant does not cover its parent.
function knowledgeNodeCovers(coveredValue, expectedValue) {
  if (knowledgeNodesCompatible(coveredValue, expectedValue)) return true;
  const covered = normalizeKnowledgeNode(coveredValue || {});
  const expected = normalizeKnowledgeNode(expectedValue || {});
  const coveredPath = knowledgePathSegments(covered.path);
  const expectedPath = knowledgePathSegments(expected.path);
  if (!coveredPath.length || !expectedPath.length || coveredPath.length >= expectedPath.length) return false;
  return coveredPath.every((segment, index) => segment === expectedPath[index]);
}

function knowledgeNodeIsWithin(scopeValue, actualValue) {
  return knowledgeNodeCovers(scopeValue, actualValue);
}

function scopeAnchorMatchesRequiredKnowledge(scopeAnchor, requiredKnowledge = []) {
  const anchor = normalizeKnowledgeNode(scopeAnchor || {});
  const anchorPath = knowledgePathSegments(anchor.path);
  if (!anchorPath.length) return false;
  return normalizedKnowledgeNodes(requiredKnowledge).some((required) => {
    const requiredPath = knowledgePathSegments(required.path);
    return requiredPath.length > anchorPath.length
      && anchorPath.every((segment, index) => segment === requiredPath[index]);
  });
}

function knowledgeSetsCompatible(left = [], right = []) {
  const normalizedLeft = (Array.isArray(left) ? left : []).map(normalizeKnowledgeNode)
    .filter((node) => node.id || node.path || node.title);
  const normalizedRight = (Array.isArray(right) ? right : []).map(normalizeKnowledgeNode)
    .filter((node) => node.id || node.path || node.title);
  if (!normalizedLeft.length || !normalizedRight.length) return false;
  return normalizedLeft.every((leftNode) => normalizedRight.some((rightNode) => knowledgeNodesCompatible(leftNode, rightNode)))
    && normalizedRight.every((rightNode) => normalizedLeft.some((leftNode) => knowledgeNodesCompatible(leftNode, rightNode)));
}

function normalizedKnowledgeNodes(values = []) {
  return (Array.isArray(values) ? values : []).map(normalizeKnowledgeNode)
    .filter((node) => node.id || node.path || node.title);
}

function knowledgeNodesNotCovered(expected = [], actual = []) {
  const normalizedExpected = normalizedKnowledgeNodes(expected);
  const normalizedActual = normalizedKnowledgeNodes(actual);
  return normalizedExpected.filter((expectedNode) => !normalizedActual
    .some((actualNode) => knowledgeNodesCompatible(expectedNode, actualNode)));
}

function knowledgeNodesMissingFromCoverage(expected = [], actual = []) {
  const normalizedExpected = normalizedKnowledgeNodes(expected);
  const normalizedActual = normalizedKnowledgeNodes(actual);
  return normalizedExpected.filter((expectedNode) => !normalizedActual
    .some((actualNode) => knowledgeNodeCovers(actualNode, expectedNode)));
}

function knowledgeNodesOutsideScope(actual = [], scope = []) {
  const normalizedActual = normalizedKnowledgeNodes(actual);
  const normalizedScope = normalizedKnowledgeNodes(scope);
  return normalizedActual.filter((actualNode) => !normalizedScope
    .some((scopeNode) => knowledgeNodeIsWithin(scopeNode, actualNode)));
}

function familyGoldRelatedRelationMap(familyGold = {}) {
  const normalized = normalizeFamilyGold(familyGold, familyGold.replayMode);
  return new Map(normalized.relatedFamilyRelations.map((relation) => [relation.familyId, relation]));
}

function familyMemberContribution(family = {}, questionId = "") {
  const membership = family.membership
    && (!questionId || !family.membership.questionId || family.membership.questionId === questionId)
    ? family.membership
    : (family.members || []).find((member) => member.questionId === questionId);
  return normalizedKnowledgeNodes(membership?.contributionKnowledge || []);
}

function familyKnowledgeCoverage(families = [], options = {}) {
  const useMemberContributions = options.protocolVersion === FAMILY_KNOWLEDGE_PROTOCOL_VERSION;
  return normalizedKnowledgeNodes((Array.isArray(families) ? families : [])
    .flatMap((family) => (useMemberContributions
      ? familyMemberContribution(family, options.questionId)
      : family?.requiredKnowledge || [])));
}

// DEC-039、产品手册 4.11 与 5.8.12：成员贡献知识、题目最小充分知识集与题族覆盖知识
// 之间一律按“规范节点集合”比较（同一 ID、显式别名或完整教材路径）。父子、祖先、
// 同章或共同范围锚点关系都不得替代这一交集校验，因此这里刻意不使用 knowledgeNodeCovers。
//
// 审核页门禁与 C1 零模型预检必须共用本函数。两处各写一份判断会让同一份冻结金标
// 同时得出“页面可冻结”和“预检阻断”两个互相矛盾的结论。
function auditJointContributionCoverage(options = {}) {
  const required = normalizedKnowledgeNodes(options.questionRequiredNodes || []);
  const contributors = (Array.isArray(options.contributors) ? options.contributors : []).map((entry) => {
    const contribution = normalizedKnowledgeNodes(entry.contributionNodes || []);
    const coverage = normalizedKnowledgeNodes(entry.familyCoverageNodes || []);
    return {
      familyId: cleanText(entry.familyId, 240),
      familyName: cleanText(entry.familyName, 400),
      role: cleanText(entry.role, 60),
      contribution,
      coverage,
      outsideQuestion: knowledgeNodesNotCovered(contribution, required),
      outsideFamilyCoverage: knowledgeNodesNotCovered(contribution, coverage),
    };
  });
  const covered = contributors.flatMap((entry) => entry.contribution);
  contributors.forEach((entry, index) => {
    const coveredWithoutSelf = contributors
      .filter((_candidate, candidateIndex) => candidateIndex !== index)
      .flatMap((candidate) => candidate.contribution);
    entry.missingWithoutSelf = knowledgeNodesNotCovered(required, coveredWithoutSelf);
  });
  return {
    required,
    contributors,
    covered,
    missing: knowledgeNodesNotCovered(required, covered),
  };
}

function requiredFamilyCoverageAudit(answerKnowledge = {}, gateFamilies = [], requiredRelatedFamilies = [], options = {}) {
  const expected = normalizedKnowledgeNodes(answerKnowledge.requiredKnowledge);
  const actual = familyKnowledgeCoverage(gateFamilies, options);
  // V3 走 DEC-039 的严格集合口径；V1/V2 旧协议冻结事实继续按原字节和原宽容口径解释。
  const strict = options.protocolVersion === FAMILY_KNOWLEDGE_PROTOCOL_VERSION;
  const joint = auditJointContributionCoverage({
    questionRequiredNodes: expected,
    contributors: gateFamilies.map((family) => ({
      familyId: family.id,
      familyName: family.name,
      contributionNodes: strict
        ? familyMemberContribution(family, options.questionId)
        : normalizedKnowledgeNodes(family.requiredKnowledge),
      familyCoverageNodes: normalizedKnowledgeNodes(family.requiredKnowledge),
    })),
  });
  const requiredFamilyIds = new Set(requiredRelatedFamilies.map((family) => family.id));
  const allContributions = joint.contributors.map((entry, index) => {
    const family = gateFamilies[index];
    // inScope 只服务旧协议分支的兼容提示，保持原有祖先容忍口径。
    const inScope = entry.contribution.filter((node) => expected
      .some((expectedNode) => knowledgeNodeIsWithin(expectedNode, node)));
    const legacyWithoutFamily = familyKnowledgeCoverage(
      gateFamilies.filter((candidate, candidateIndex) => (
        family.id ? candidate.id !== family.id : candidateIndex !== index
      )),
      options,
    );
    return {
      family,
      knowledge: entry.contribution,
      inScope,
      outsideQuestion: entry.outsideQuestion,
      outsideFamilyCoverage: entry.outsideFamilyCoverage,
      requiredRelated: requiredFamilyIds.has(family.id),
      redundant: inScope.length > 0 && (strict
        ? entry.missingWithoutSelf.length === 0
        : knowledgeNodesMissingFromCoverage(expected, legacyWithoutFamily).length === 0),
    };
  });
  return {
    expected,
    actual,
    strict,
    missing: strict ? joint.missing : knowledgeNodesMissingFromCoverage(expected, actual),
    extra: strict ? knowledgeNodesNotCovered(actual, expected) : knowledgeNodesOutsideScope(actual, expected),
    joint,
    contributions: allContributions.filter((entry) => entry.requiredRelated),
    allContributions,
  };
}

function validateFamilyKnowledgeContributions(options = {}) {
  const {
    item,
    answerKnowledge,
    coverage,
    primaryFamily,
    referenceFamilies = [],
    addIssue,
    addWarning,
    coreIssueCode = "core_knowledge_mismatch",
    coverageIssueCode = "required_knowledge_mismatch",
    coverageIssueMessage = "题目最小充分知识集与主题题族及作答必需关联题族的成员贡献联合覆盖不完全等价。",
  } = options;
  const coreKnowledgeRole = CORE_KNOWLEDGE_ROLES.has(answerKnowledge.coreKnowledgeRole)
    ? answerKnowledge.coreKnowledgeRole : "core";
  const primaryContribution = coverage.allContributions.find(({ family }) => family === primaryFamily)
    || coverage.allContributions.find(({ family }) => family.id && family.id === primaryFamily?.id);
  if (coreKnowledgeRole === "core" && (!primaryContribution?.knowledge.length || !primaryContribution.knowledge
    .some((node) => knowledgeNodeCovers(node, answerKnowledge.coreKnowledge)))) {
    addIssue(item, coreIssueCode, "题目知识焦点必须由主题题族对本题的成员贡献知识承载；题族范围锚点不参与此项判定。", {
      familyId: primaryFamily?.id,
      familyName: primaryFamily?.name,
      expected: answerKnowledge.coreKnowledge,
      actual: primaryContribution?.knowledge || [],
    });
  }
  coverage.allContributions.forEach(({ family, knowledge, outsideQuestion, outsideFamilyCoverage, requiredRelated, redundant }) => {
    if (!knowledge.length || outsideQuestion.length || outsideFamilyCoverage.length) {
      addIssue(item, "required_family_no_knowledge_contribution", "主题题族与作答必需关联题族都必须声明本题成员贡献，且贡献只能取题目最小充分知识集与该题族覆盖知识的交集。", {
        familyId: family.id,
        familyName: family.name,
        expected: {
          questionRequiredKnowledge: coverage.expected,
          familyCoverageKnowledge: family.requiredKnowledge,
        },
        actual: {
          contributionKnowledge: knowledge,
          outsideQuestion,
          outsideFamilyCoverage,
        },
      });
    } else if (requiredRelated && redundant) {
      addWarning(item, "required_family_redundant_knowledge_contribution", "移除该作答必需关联题族后仍能覆盖最小充分知识集，请人工确认其考查动作是否不可替代。", {
        familyId: family.id,
        familyName: family.name,
        actual: knowledge,
      });
    }
  });
  referenceFamilies.forEach((family) => {
    const contribution = familyMemberContribution(family, item.questionId);
    if (!contribution.length) return;
    addIssue(item, "reference_family_knowledge_contribution_forbidden", "普通关联题族不参与本题最小充分知识集覆盖，成员贡献知识必须为空。", {
      familyId: family.id,
      familyName: family.name,
      expected: [],
      actual: contribution,
    });
  });
  if (coverage.missing.length || coverage.extra.length) {
    addIssue(item, coverageIssueCode, coverageIssueMessage, {
      familyId: primaryFamily?.id,
      familyName: primaryFamily?.name,
      expected: coverage.expected,
      actual: coverage.actual,
      missing: coverage.missing,
      extra: coverage.extra,
    });
  }
}

function sameStringSet(left = [], right = []) {
  const normalizedLeft = uniqueStrings(left, 2000).sort();
  const normalizedRight = uniqueStrings(right, 2000).sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function requiresFamilySemanticGate(batch = {}) {
  if (cleanText(batch.source?.parentSnapshotId, 240)) return true;
  const versionNumber = Number(cleanText(batch.version, 80).match(/\d+/)?.[0] || 0);
  return versionNumber >= 2;
}

// A revision can carry completed items forward from an immutable parent
// snapshot.  Those items are intentionally read-only and may still use the
// parent's legacy family protocol; only items explicitly reopened for a
// family/content review are eligible for the current V3 semantic gate.
function isInheritedRevisionItem(batch = {}, item = {}) {
  const parentSnapshotId = cleanText(batch.source?.parentSnapshotId, 240);
  const itemParentSnapshotId = cleanText(item.qualificationAudit?.parentSnapshotId, 240);
  const requiredStages = uniqueStrings(item.qualificationAudit?.requiredStages, 4)
    .filter((stage) => ["content", "family"].includes(stage));
  return Boolean(parentSnapshotId
    && itemParentSnapshotId === parentSnapshotId
    && item.qualificationAudit?.status === "inherited"
    && requiredStages.length === 0);
}

function validateSelectedFamilyFacts(item, families, primaryFamilyId, relatedFamilyIds, addIssue, options = {}) {
  families.forEach((family) => {
    const isPrimaryFamily = Boolean(primaryFamilyId && family.id === primaryFamilyId);
    if (family.status !== "confirmed") {
      addIssue(item, family.status ? "family_status_not_confirmed" : "family_status_missing", "所选题族必须冻结为已确认状态。", {
        familyId: family.id,
        familyName: family.name,
        expected: "confirmed",
        actual: family.status || "missing",
      });
    }
    if (!family.version) {
      addIssue(item, "family_version_missing", "所选题族缺少形成 V2 时的题族版本。", {
        familyId: family.id,
        familyName: family.name,
      });
    }
    if (!family.coreKnowledgeNodeId || !(family.requiredKnowledgeNodeIds || []).length
      || !(family.textbookAnchorNodeIds || []).length || !family.assessmentAction
      || (options.requireFocusKey === true && !family.focusKey)) {
      addIssue(item, "family_definition_incomplete", "题族范围锚点、覆盖知识、判别焦点、教材锚点和考查动作必须完整。", {
        familyId: family.id,
        familyName: family.name,
      });
    }
    if (options.enforceFormalMembership === true) {
      const confirmedPrototype = (family.members || [])
        .some((member) => member.role === "prototype" && member.reviewStatus === "confirmed");
      if (!confirmedPrototype) {
        addIssue(item, "family_confirmed_prototype_missing", "所选题族必须至少保留一条有效且已确认的原型题关系。", {
          familyId: family.id,
          familyName: family.name,
        });
      }
      const unconfirmedMemberQuestionIds = (family.members || [])
        .filter((member) => member.reviewStatus !== "confirmed")
        .map((member) => member.questionId);
      if (unconfirmedMemberQuestionIds.length) {
        addIssue(item, "family_membership_not_confirmed", "冻结事实只能包含已确认的题族成员关系。", {
          familyId: family.id,
          familyName: family.name,
          actual: unconfirmedMemberQuestionIds,
        });
      }
    }
    if (!(family.members || []).length) {
      addIssue(item, "family_members_missing", "题族缺少带角色的成员事实。", {
        familyId: family.id,
        familyName: family.name,
      });
    }
    const memberIdsFromRoles = (family.members || []).map((member) => member.questionId);
    const independentIdsFromRoles = (family.members || [])
      .filter((member) => member.isPrimary === true).map((member) => member.questionId);
    if (!sameStringSet(family.memberQuestionIds, memberIdsFromRoles)) {
      addIssue(item, "family_member_ids_inconsistent", "题族成员 ID 与成员角色清单不一致。", {
        familyId: family.id,
        familyName: family.name,
        expected: memberIdsFromRoles,
        actual: family.memberQuestionIds,
      });
    }
    if (!sameStringSet(family.independentMemberQuestionIds, independentIdsFromRoles)) {
      addIssue(item, "family_independent_member_ids_inconsistent", "独立成员 ID 与主归属成员角色不一致。", {
        familyId: family.id,
        familyName: family.name,
        expected: independentIdsFromRoles,
        actual: family.independentMemberQuestionIds,
      });
    }
    if (family.independentMemberCount !== uniqueStrings(family.independentMemberQuestionIds, 1000).length) {
      addIssue(item, "family_independent_member_count_inconsistent", "独立成员数量与去重后的成员 ID 数量不一致。", {
        familyId: family.id,
        familyName: family.name,
        expected: uniqueStrings(family.independentMemberQuestionIds, 1000).length,
        actual: family.independentMemberCount,
      });
    }
    const membership = family.membership;
    const member = (family.members || []).find((entry) => entry.questionId === item.questionId);
    if (options.enforceFormalMembership === true && membership && membership.reviewStatus !== "confirmed") {
      addIssue(item, "family_membership_not_confirmed", "当前题目与所选题族的归属关系尚未确认，不能冻结为正式金标成员。", {
        familyId: family.id,
        familyName: family.name,
        expected: "confirmed",
        actual: membership.reviewStatus || "missing",
      });
    }
    if (!membership || membership.questionId !== item.questionId || !member) {
      addIssue(item, "family_membership_missing", "题目在所选题族中缺少冻结的成员关系。", {
        familyId: family.id,
        familyName: family.name,
        expected: item.questionId,
      });
    } else {
      if (!FAMILY_MEMBER_ROLES.has(membership.role) || membership.role !== member.role
        || membership.isPrimary !== member.isPrimary) {
        addIssue(item, "family_membership_role_inconsistent", "题目成员关系与题族成员角色不一致。", {
          familyId: family.id,
          familyName: family.name,
          expected: member,
          actual: membership,
        });
      }
      if (membership.isPrimary !== isPrimaryFamily) {
        addIssue(item, "primary_family_role_inconsistent", "主题题族必须与题目的主归属角色一致。", {
          familyId: family.id,
          familyName: family.name,
          expected: isPrimaryFamily,
          actual: membership.isPrimary,
        });
      }
    }
    if (!isPrimaryFamily && !relatedFamilyIds.includes(family.id)) {
      addIssue(item, "related_family_role_missing", "非主题题族必须在关联题族中声明。", {
        familyId: family.id,
        familyName: family.name,
      });
    }
  });
}

function validateGoldReviewBatchFamilySemantics(batch = {}, options = {}) {
  const wanted = new Set(uniqueStrings(options.questionIds, 1000));
  const issues = [];
  const warnings = [];
  const enforceFormalMembership = requiresFamilySemanticGate(batch);
  const addIssue = (item, code, message, details = {}) => {
    issues.push(normalizeQualificationIssue({
      questionId: item.questionId,
      order: item.order,
      code,
      label: FAMILY_SEMANTIC_ISSUE_LABELS[code] || message,
      message,
      source: "family_semantic_gate_v1",
      ...details,
    }, item.questionId));
  };
  const addWarning = (item, code, message, details = {}) => {
    warnings.push(normalizeQualificationIssue({
      questionId: item.questionId,
      order: item.order,
      code,
      label: FAMILY_SEMANTIC_ISSUE_LABELS[code] || message,
      message,
      source: "family_semantic_gate_v1",
      severity: "warning",
      ...details,
    }, item.questionId));
  };
  (Array.isArray(batch.items) ? batch.items : []).forEach((item) => {
    if (wanted.size && !wanted.has(item.questionId)) return;
    if (item.familyReview?.result === "disputed") return;
    // Do not reinterpret inherited parent-snapshot facts under the current
    // family_knowledge_v3 contract.  A revision item is promoted into this
    // gate only after an explicit family/content reopen, which changes its
    // qualification status and required stages.
    if (isInheritedRevisionItem(batch, item)) return;
    const answerKnowledge = item.humanGold?.answerKnowledge || item.answerKnowledge || {};
    const rawFamilyGold = item.humanGold?.familyGold || item.familyGold || {};
    const familyGold = normalizeFamilyGold(rawFamilyGold, item.sourceMode);
    const mode = REPLAY_MODES.has(familyGold.replayMode) ? familyGold.replayMode : item.sourceMode;
    const decision = familyGold.decision;
    const families = familyGold.families;
    const primaryFamilyId = cleanText(familyGold.primaryFamilyId, 240);
    const relatedFamilyIds = familyGold.relatedFamilyIds;
    const relatedRelationMap = familyGoldRelatedRelationMap(familyGold);
    const requiredRelatedFamilyIds = relatedFamilyIds
      .filter((familyId) => relatedRelationMap.get(familyId)?.coverageRole === "required");
    const referenceRelatedFamilyIds = relatedFamilyIds
      .filter((familyId) => relatedRelationMap.get(familyId)?.coverageRole === "reference");
    const usesFamilyKnowledgeV3 = familyGold.familyKnowledgeProtocolVersion === FAMILY_KNOWLEDGE_PROTOCOL_VERSION;
    if ((enforceFormalMembership || answerKnowledge.coreKnowledgeRole === "scope_anchor") && !usesFamilyKnowledgeV3) {
      addIssue(item, "family_knowledge_protocol_missing", `重新审核时必须提交 ${FAMILY_KNOWLEDGE_PROTOCOL_VERSION}，以区分题族范围锚点、覆盖知识和成员贡献知识。`, {
        expected: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
        actual: familyGold.familyKnowledgeProtocolVersion || "missing",
      });
    }

    familyGold.relatedFamilyRelations.forEach((relation) => {
      if (!relatedFamilyIds.includes(relation.familyId)) {
        addIssue(item, "related_family_relation_orphan", "关联题族覆盖角色必须对应 relatedFamilyIds 中的题族。", {
          familyId: relation.familyId,
          actual: relation,
        });
      }
    });

    const familyIds = families.map((family) => family.id).filter(Boolean);
    if (new Set(familyIds).size !== familyIds.length) {
      addIssue(item, "family_ids_duplicate", "题族事实中存在重复题族。", { actual: familyIds });
    }

    if (decision === "create_new") {
      if (mode !== "unmatched") addIssue(item, "new_family_mode_invalid", "新建题族裁决只能用于无匹配题模式。", { actual: mode });
      if (primaryFamilyId) {
        addIssue(item, "unmatched_carries_existing_family", "无匹配题的新建裁决不得携带现有主题题族。", {
          actual: { primaryFamilyId },
        });
      }
      validateSelectedFamilyFacts(item, families, "", relatedFamilyIds, addIssue, {
        enforceFormalMembership,
        requireFocusKey: usesFamilyKnowledgeV3,
      });
      const candidateFamily = familyGold.candidateFamily ? normalizeFamily(familyGold.candidateFamily) : null;
      if (usesFamilyKnowledgeV3 && candidateFamily && !candidateFamily.focusKey) {
        addIssue(item, "family_definition_incomplete", "候选题族必须单独填写稳定判别焦点，不能用题族名称或考查动作代替。", {
          familyName: candidateFamily.name,
          expected: "focusKey",
          actual: candidateFamily.focusKey,
        });
      }
      if (!usesFamilyKnowledgeV3 && candidateFamily?.coreKnowledgeNodeId
        && !knowledgeNodeCovers(candidateFamily.coreKnowledge, answerKnowledge.coreKnowledge)) {
        addIssue(item, "candidate_core_knowledge_mismatch", "候选题族核心知识与题目核心知识不是同一节点或显式别名。", {
          familyName: candidateFamily.name,
          expected: answerKnowledge.coreKnowledge,
          actual: candidateFamily.coreKnowledge,
        });
      }
      const requiredRelatedFamilies = requiredRelatedFamilyIds.map((familyId) => {
        const family = families.find((candidate) => candidate.id === familyId);
        if (!family) {
          addIssue(item, "required_related_family_fact_missing", "作答必需关联题族缺少冻结事实。", {
            familyId,
            expected: familyId,
            actual: familyIds,
          });
        }
        return family;
      }).filter(Boolean);
      const referenceRelatedFamilies = referenceRelatedFamilyIds
        .map((familyId) => families.find((candidate) => candidate.id === familyId)).filter(Boolean);
      if (candidateFamily?.requiredKnowledge?.length) {
        const coverage = requiredFamilyCoverageAudit(
          answerKnowledge,
          [candidateFamily, ...requiredRelatedFamilies],
          requiredRelatedFamilies,
          {
            protocolVersion: familyGold.familyKnowledgeProtocolVersion,
            questionId: item.questionId,
          },
        );
        if (usesFamilyKnowledgeV3) {
          validateFamilyKnowledgeContributions({
            item,
            answerKnowledge,
            coverage,
            primaryFamily: candidateFamily,
            referenceFamilies: referenceRelatedFamilies,
            addIssue,
            addWarning,
            coreIssueCode: "candidate_core_knowledge_mismatch",
            coverageIssueCode: "candidate_required_knowledge_mismatch",
            coverageIssueMessage: "候选主题题族与作答必需关联题族的成员贡献未完整、等价地覆盖题目最小充分知识集。",
          });
        } else {
          coverage.contributions.forEach(({ family, knowledge, inScope, redundant }) => {
            if (!knowledge.length || !inScope.length || knowledgeNodesOutsideScope(knowledge, coverage.expected).length) {
              addIssue(item, "required_family_no_knowledge_contribution", "作答必需关联题族必须提供非空且完全属于题目最小充分知识集的知识。", {
                familyId: family.id,
                familyName: family.name,
                expected: coverage.expected,
                actual: knowledge,
              });
            } else if (redundant) {
              addWarning(item, "required_family_redundant_knowledge_contribution", "移除该作答必需关联题族后仍能覆盖最小充分知识集，请人工确认其考查动作是否不可替代。", {
                familyId: family.id,
                familyName: family.name,
                actual: knowledge,
              });
            }
          });
          if (coverage.missing.length || coverage.extra.length) {
            addIssue(item, "candidate_required_knowledge_mismatch", "候选主题题族与作答必需关联题族未完整、等价地覆盖题目最小充分知识集。", {
              familyName: candidateFamily.name,
              expected: coverage.expected,
              actual: coverage.actual,
            });
          }
        }
      }
      return;
    }

    if (decision !== "join_existing") {
      addIssue(item, "family_decision_invalid", "题族裁决必须明确加入旧题族或新建题族。", { actual: decision });
      return;
    }
    if (mode === "unmatched") addIssue(item, "existing_family_mode_invalid", "无匹配题模式不能裁决为加入旧题族。", { actual: decision });
    if (!primaryFamilyId) {
      addIssue(item, "primary_family_missing", "加入旧题族时必须指定主题题族。", { path: "familyGold.primaryFamilyId" });
      return;
    }
    const primaryFamily = families.find((family) => family.id === primaryFamilyId);
    if (!primaryFamily) {
      addIssue(item, "primary_family_fact_missing", "主题题族没有对应的冻结事实。", {
        familyId: primaryFamilyId,
        expected: primaryFamilyId,
        actual: familyIds,
      });
      return;
    }

    validateSelectedFamilyFacts(item, families, primaryFamilyId, relatedFamilyIds, addIssue, {
      enforceFormalMembership,
      requireFocusKey: usesFamilyKnowledgeV3,
    });

    if (!usesFamilyKnowledgeV3 && !knowledgeNodeCovers(primaryFamily.coreKnowledge, answerKnowledge.coreKnowledge)) {
      addIssue(item, "core_knowledge_mismatch", "题目核心知识与主题题族核心知识不是同一节点或显式别名。", {
        familyId: primaryFamily.id,
        familyName: primaryFamily.name,
        expected: answerKnowledge.coreKnowledge,
        actual: primaryFamily.coreKnowledge,
      });
    }
    const requiredRelatedFamilies = requiredRelatedFamilyIds.map((familyId) => {
      const family = families.find((candidate) => candidate.id === familyId);
      if (!family) {
        addIssue(item, "required_related_family_fact_missing", "作答必需关联题族缺少冻结事实。", {
          familyId,
          expected: familyId,
          actual: familyIds,
        });
      }
      return family;
    }).filter(Boolean);
    const referenceRelatedFamilies = referenceRelatedFamilyIds
      .map((familyId) => families.find((candidate) => candidate.id === familyId)).filter(Boolean);
    const coverage = requiredFamilyCoverageAudit(
      answerKnowledge,
      [primaryFamily, ...requiredRelatedFamilies],
      requiredRelatedFamilies,
      {
        protocolVersion: familyGold.familyKnowledgeProtocolVersion,
        questionId: item.questionId,
      },
    );
    if (usesFamilyKnowledgeV3) {
      validateFamilyKnowledgeContributions({
        item,
        answerKnowledge,
        coverage,
        primaryFamily,
        referenceFamilies: referenceRelatedFamilies,
        addIssue,
        addWarning,
      });
    } else {
      coverage.contributions.forEach(({ family, knowledge, inScope, redundant }) => {
        if (!knowledge.length || !inScope.length || knowledgeNodesOutsideScope(knowledge, coverage.expected).length) {
          addIssue(item, "required_family_no_knowledge_contribution", "作答必需关联题族必须提供非空且完全属于题目最小充分知识集的知识。", {
            familyId: family.id,
            familyName: family.name,
            expected: coverage.expected,
            actual: knowledge,
          });
        } else if (redundant) {
          addWarning(item, "required_family_redundant_knowledge_contribution", "移除该作答必需关联题族后仍能覆盖最小充分知识集，请人工确认其考查动作是否不可替代。", {
            familyId: family.id,
            familyName: family.name,
            actual: knowledge,
          });
        }
      });
      if (coverage.missing.length || coverage.extra.length) {
        addIssue(item, "required_knowledge_mismatch", "题目最小充分知识集与主题题族及作答必需关联题族的联合知识覆盖不完全等价。", {
          familyId: primaryFamily.id,
          familyName: primaryFamily.name,
          expected: coverage.expected,
          actual: coverage.actual,
        });
      }
    }

    const independentIds = uniqueStrings(primaryFamily.independentMemberQuestionIds, 1000);
    const retainedIds = uniqueStrings(primaryFamily.retainedIndependentMemberQuestionIds, 1000);
    const expectedRetainedIds = independentIds.filter((questionId) => questionId !== item.questionId);
    if (mode === "mature") {
      if (independentIds.length < 2) {
        addIssue(item, "mature_family_member_count_invalid", "成熟题族至少需要 2 个独立成员。", {
          familyId: primaryFamily.id,
          familyName: primaryFamily.name,
          expected: ">=2",
          actual: independentIds.length,
        });
      }
      if (!independentIds.includes(item.questionId)) {
        addIssue(item, "mature_hidden_question_not_independent", "被隐藏题必须是主题题族的独立成员。", {
          familyId: primaryFamily.id,
          familyName: primaryFamily.name,
        });
      }
      if (!expectedRetainedIds.length || !sameStringSet(retainedIds, expectedRetainedIds)) {
        addIssue(item, "mature_retained_members_invalid", "成熟题族隐藏本题后必须至少保留 1 个独立成员，且留存清单必须准确。", {
          familyId: primaryFamily.id,
          familyName: primaryFamily.name,
          expected: expectedRetainedIds,
          actual: retainedIds,
        });
      }
    }
    if (mode === "singleton") {
      if (independentIds.length !== 1 || independentIds[0] !== item.questionId) {
        addIssue(item, "singleton_family_member_count_invalid", "单题题族必须恰有本题 1 个独立成员。", {
          familyId: primaryFamily.id,
          familyName: primaryFamily.name,
          expected: [item.questionId],
          actual: independentIds,
        });
      }
      if (retainedIds.length) {
        addIssue(item, "singleton_retained_members_invalid", "单题题族隐藏本题后不得保留可见同族成员。", {
          familyId: primaryFamily.id,
          familyName: primaryFamily.name,
          expected: [],
          actual: retainedIds,
        });
      }
    }
  });
  const byQuestionId = issues.reduce((result, issue) => {
    (result[issue.questionId] ||= []).push(issue);
    return result;
  }, {});
  const warningsByQuestionId = warnings.reduce((result, warning) => {
    (result[warning.questionId] ||= []).push(warning);
    return result;
  }, {});
  return {
    valid: issues.length === 0,
    issueCount: issues.length,
    questionCount: Object.keys(byQuestionId).length,
    issues,
    byQuestionId,
    warningCount: warnings.length,
    warnings,
    warningsByQuestionId,
  };
}

function familySemanticGateError(validation) {
  const error = new Error("classification_gold_review_family_semantic_invalid");
  error.details = {
    issueCount: validation.issueCount,
    questionCount: validation.questionCount,
    issues: clone(validation.issues),
  };
  return error;
}

// 正式题族事实用于刷新题族定义与状态；但“本题在该题族中的逐成员贡献知识”是人工在
// 父版本金标里确认过的事实，正式题族库并不保存它。派生修订草稿时必须从父快照继承，
// 否则人工已经填过的贡献会在新草稿里变成空值，把 2 道真问题放大成十几道假问题。
function inheritFrozenMembership(formalFact = {}, frozenFamily = {}, questionId = "") {
  const frozenMembership = (frozenFamily || {}).membership;
  if (!frozenMembership || typeof frozenMembership !== "object") return formalFact;
  const frozenQuestionId = cleanText(frozenMembership.questionId, 240);
  if (frozenQuestionId && frozenQuestionId !== String(questionId)) return formalFact;
  const contributionIds = uniqueStrings([
    ...(Array.isArray(frozenMembership.contributionKnowledgeNodeIds)
      ? frozenMembership.contributionKnowledgeNodeIds : []),
    ...(Array.isArray(frozenMembership.contributionKnowledge)
      ? frozenMembership.contributionKnowledge.map((node) => node?.id || node?.nodeId) : []),
  ], 40);
  if (!contributionIds.length) return formalFact;
  const membership = normalizeFamilyMembership({
    ...frozenMembership,
    questionId: frozenQuestionId || String(questionId),
  });
  if (!membership) return formalFact;
  return {
    ...formalFact,
    membership,
    // 同一事实在 members 行里也同步一份，避免草稿内部出现两个互相矛盾的贡献值。
    members: (formalFact.members || []).map((member) => (String(member.questionId || "") === String(questionId)
      ? {
        ...member,
        contributionKnowledgeNodeIds: membership.contributionKnowledgeNodeIds,
        contributionKnowledge: membership.contributionKnowledge,
      }
      : member)),
  };
}

function revisionItemFromFrozenSnapshot(snapshotItem = {}, formalFacts = [], parentSnapshot = {}, now = Date.now()) {
  const question = clone(snapshotItem.questionSnapshot || {});
  const answerKnowledge = clone(snapshotItem.answerAndEvidence || snapshotItem.knowledgeGold || {});
  const frozenFamilyGold = clone(snapshotItem.familyGold || {});
  const formalFactById = new Map((Array.isArray(formalFacts) ? formalFacts : [])
    .map(normalizeFamily).filter((family) => family.id).map((family) => [family.id, family]));
  const familyGold = {
    ...frozenFamilyGold,
    families: (Array.isArray(frozenFamilyGold.families) ? frozenFamilyGold.families : [])
      .map((family) => {
        const formalFact = formalFactById.get(cleanText(family?.id, 240));
        if (!formalFact) return family;
        return inheritFrozenMembership(formalFact, family, snapshotItem.questionId);
      }),
  };
  const audit = snapshotItem.audit || {};
  return normalizeItem({
    order: snapshotItem.order,
    questionId: snapshotItem.questionId,
    sourceMode: snapshotItem.replayMode,
    sourceGoldStatus: snapshotItem.goldStatus,
    reviewMethod: audit.reviewMethod || INDEPENDENT_REVIEW_METHOD,
    question,
    officialBaseline: {
      question,
      answerKnowledge,
      familyGold,
      capturedQuestionVersion: question.version,
      provenance: {
        source: "frozen_parent_snapshot",
        parentSnapshotId: parentSnapshot.snapshotId,
        parentContentSha256: parentSnapshot.integrity?.contentSha256 || "",
      },
    },
    sourceMaterials: {
      sourceAnswer: { ...question, provenance: "frozen_parent_snapshot" },
      textbookEvidence: answerKnowledge.textbookEvidence,
      provenance: "frozen_parent_snapshot_revision",
    },
    humanGold: {
      answerKnowledge,
      answerKnowledgeProvenance: audit.answerKnowledgeProvenance,
      familyGold,
      familyGoldProvenance: {
        ...(audit.familyGoldProvenance || {}),
        formalFamilyFactsSource: "revision_creation_snapshot",
      },
    },
    aiCandidates: {
      validity: "stale",
      invalidatedAt: now,
      invalidationReason: "ai_candidates_not_carried_from_frozen_parent",
      basedOnQuestionVersion: question.version,
    },
    contentReview: audit.contentReview,
    familyReview: audit.familyReview,
    reviewHistory: audit.reviewHistory,
    firstHumanJudgment: audit.firstHumanJudgment,
    qualificationAudit: audit.qualificationAudit,
    knowledgeDigest: audit.knowledgeDigest,
    revision: audit.itemRevision,
    importedAt: now,
    updatedAt: now,
  }, Math.max(0, Number(snapshotItem.order) - 1));
}

function createClassificationGoldReviewStore(adapter, options = {}) {
  const snapshotDir = path.resolve(options.snapshotDir || path.resolve(__dirname, "../../../.runtime/blind-gold-snapshots"));
  const freezePreparationTtlMs = Math.max(60_000, Number(options.freezePreparationTtlMs) || 30 * 60_000);
  const read = () => normalizeState(adapter.read());
  const write = (state) => adapter.write(normalizeState(state));
  const getBatch = (state, batchId) => state.batches.find((batch) => batch.id === String(batchId || ""));
  return {
    exportState: () => clone(read()),
    replaceState(state) {
      write(state);
      return clone(read());
    },
    list() {
      return read().batches.map((batch) => {
        const presented = presentBatch(batch);
        delete presented.items;
        return presented;
      });
    },
    get(batchId) {
      const batch = getBatch(read(), batchId);
      return batch ? presentBatch(batch) : null;
    },
    importBatch(payload = {}) {
      const batch = normalizeBatch(payload);
      if (!batch.id || !batch.items.length) throw new Error("classification_gold_review_batch_invalid");
      if (new Set(batch.items.map((item) => item.questionId)).size !== batch.items.length) {
        throw new Error("classification_gold_review_duplicate_question");
      }
      const state = read();
      const existing = getBatch(state, batch.id);
      if (existing) {
        if (contentHash(existing.source) !== contentHash(batch.source)) throw new Error("classification_gold_review_batch_conflict");
        return presentBatch(existing);
      }
      state.batches.unshift(batch);
      write(state);
      return presentBatch(batch);
    },
    replacePendingBatch(payload = {}) {
      const replacement = normalizeBatch(payload);
      if (!replacement.id || !replacement.items.length) throw new Error("classification_gold_review_batch_invalid");
      if (new Set(replacement.items.map((item) => item.questionId)).size !== replacement.items.length) {
        throw new Error("classification_gold_review_duplicate_question");
      }
      const state = read();
      const index = state.batches.findIndex((batch) => batch.id === replacement.id);
      if (index < 0) {
        state.batches.unshift(replacement);
        write(state);
        return presentBatch(replacement);
      }
      const existing = state.batches[index];
      const hasReview = existing.items.some((item) => item.contentReview.result !== "pending_review"
        || item.familyReview.result !== "pending_review");
      if (existing.status === "frozen" || existing.snapshot || hasReview) {
        throw new Error("classification_gold_review_pending_replace_forbidden");
      }
      if (!sameImportIdentity(existing.source, replacement.source)) {
        throw new Error("classification_gold_review_batch_conflict");
      }
      replacement.importedAt = existing.importedAt;
      replacement.updatedAt = Date.now();
      state.batches[index] = replacement;
      write(state);
      return presentBatch(replacement);
    },
    createRevisionDraft(parentBatchId, payload = {}) {
      const state = read();
      const parent = getBatch(state, parentBatchId);
      if (!parent) throw new Error("classification_gold_review_batch_not_found");
      if (parent.status !== "frozen" || !parent.snapshot?.filePath) {
        throw new Error("classification_gold_review_parent_not_frozen");
      }
      const loaded = readFrozenGoldSnapshot(parent.snapshot.filePath);
      if (loaded.snapshot.snapshotId !== parent.snapshot.snapshotId
        || loaded.fileSha256 !== parent.snapshot.fileSha256
        || loaded.contentSha256 !== parent.snapshot.contentSha256) {
        throw new Error("classification_gold_review_parent_snapshot_hash_mismatch");
      }

      const id = cleanText(payload.id || payload.batchId, 240);
      const title = cleanText(payload.title, 400);
      const version = cleanText(payload.version, 80);
      if (!id || !title || !version || id === parent.id || title === parent.title || version === parent.version) {
        throw new Error("classification_gold_review_revision_identity_invalid");
      }
      const existing = getBatch(state, id);
      if (existing) {
        const snapshotItemByOrder = new Map((loaded.snapshot.items || [])
          .map((item) => [Number(item.order), item]));
        const incomingRiskQuestionIds = uniqueStrings([
          ...(Array.isArray(payload.riskQuestionIds) ? payload.riskQuestionIds : []),
          ...(Array.isArray(payload.riskOrders) ? payload.riskOrders : [])
            .map((order) => snapshotItemByOrder.get(Number(order))?.questionId),
          ...(Array.isArray(payload.qualificationIssues) ? payload.qualificationIssues : [])
            .map((issue) => issue?.questionId || snapshotItemByOrder.get(Number(issue?.order))?.questionId),
        ], 1000);
        if (existing.source?.parentSnapshotId === loaded.snapshot.snapshotId
          && existing.title === title && existing.version === version
          && sameStringSet(existing.source?.riskQuestionIds, incomingRiskQuestionIds)) {
          return {
            created: false,
            batch: presentBatch(existing),
            revisionReview: clone(existing.revisionReview),
          };
        }
        throw new Error("classification_gold_review_batch_conflict");
      }

      const formalFamilyFactsByQuestionId = payload.formalFamilyFactsByQuestionId
        && typeof payload.formalFamilyFactsByQuestionId === "object"
        ? clone(payload.formalFamilyFactsByQuestionId) : {};
      const formalFamilyFactsSha256 = contentHash(formalFamilyFactsByQuestionId);
      const claimedFactsHash = cleanText(payload.formalFamilyFactsProvenance?.contentSha256, 128);
      if (claimedFactsHash && claimedFactsHash !== formalFamilyFactsSha256) {
        throw new Error("classification_gold_review_formal_family_facts_hash_mismatch");
      }
      const snapshotItems = loaded.snapshot.items || [];
      const itemByOrder = new Map(snapshotItems.map((item) => [Number(item.order), item]));
      const itemIds = new Set(snapshotItems.map((item) => String(item.questionId || "")));
      const qualificationIssues = (Array.isArray(payload.qualificationIssues) ? payload.qualificationIssues : [])
        .map((issue) => {
          const questionId = cleanText(issue?.questionId, 240)
            || cleanText(itemByOrder.get(Number(issue?.order))?.questionId, 240);
          return normalizeQualificationIssue({ ...issue, questionId }, questionId);
        }).filter((issue) => issue.questionId);
      const requestedRiskQuestionIds = new Set(uniqueStrings([
        ...(payload.riskQuestionIds || []),
        ...(payload.riskOrders || []).map((order) => itemByOrder.get(Number(order))?.questionId),
        ...qualificationIssues.map((issue) => issue.questionId),
      ], 1000));
      const unknownQuestionIds = [...requestedRiskQuestionIds].filter((questionId) => !itemIds.has(questionId));
      const invalidOrders = (Array.isArray(payload.riskOrders) ? payload.riskOrders : [])
        .filter((order) => !itemByOrder.has(Number(order)));
      if (unknownQuestionIds.length || invalidOrders.length) {
        const error = new Error("classification_gold_review_revision_risk_items_invalid");
        error.details = { unknownQuestionIds, invalidOrders };
        throw error;
      }

      const now = Date.now();
      const reviewer = cleanText(payload.reviewer || "超级管理员", 120);
      const items = snapshotItems.map((snapshotItem) => revisionItemFromFrozenSnapshot(
        snapshotItem,
        formalFamilyFactsByQuestionId[snapshotItem.questionId],
        loaded.snapshot,
        now,
      ));
      const draft = normalizeBatch({
        id,
        title,
        version,
        status: "reviewing",
        source: {
          parentSnapshotId: loaded.snapshot.snapshotId,
          parentReviewBatchId: parent.id,
          parentVersion: loaded.snapshot.version,
          parentFileSha256: loaded.fileSha256,
          parentContentSha256: loaded.contentSha256,
          parentHashes: { fileSha256: loaded.fileSha256, contentSha256: loaded.contentSha256 },
          formalFamilyFactsSha256,
          formalBaselineSha256: cleanText(payload.formalBaselineProvenance?.contentSha256, 128),
          riskQuestionIds: [...requestedRiskQuestionIds],
          provenance: {
            kind: "frozen_gold_revision",
            createdAt: new Date(now).toISOString(),
            createdBy: reviewer,
            reason: cleanText(payload.reason, 4000),
            parentSource: clone(loaded.snapshot.source || {}),
            formalFamilyFacts: clone(payload.formalFamilyFactsProvenance || {}),
            formalBaseline: clone(payload.formalBaselineProvenance || {}),
            automatedAiAcceptance: false,
            agent4Triggered: false,
            formalBusinessDataMutated: false,
          },
        },
        items,
        revision: 1,
        importedAt: now,
        updatedAt: now,
      });

      const semanticValidation = validateGoldReviewBatchFamilySemantics(draft);
      const semanticQuestionIds = new Set(semanticValidation.issues.map((issue) => issue.questionId));
      const automaticallyReopenedQuestionIds = [...semanticQuestionIds]
        .filter((questionId) => !requestedRiskQuestionIds.has(questionId));
      const reopenedQuestionIds = new Set([...requestedRiskQuestionIds, ...semanticQuestionIds]);
      const contentReopenedQuestionIds = new Set(qualificationIssues
        .filter((issue) => issue.requiredStages.includes("content"))
        .map((issue) => issue.questionId));
      const qualificationByQuestionId = [...qualificationIssues, ...semanticValidation.issues]
        .reduce((result, issue) => {
          (result[issue.questionId] ||= []).push(issue);
          return result;
        }, {});
      draft.items.forEach((item) => {
        const shouldReopen = reopenedQuestionIds.has(item.questionId);
        const issues = qualificationByQuestionId[item.questionId] || [];
        const requiresContentReview = contentReopenedQuestionIds.has(item.questionId);
        const requiredStages = requiresContentReview ? ["content", "family"] : (shouldReopen ? ["family"] : []);
        item.qualificationAudit = normalizeQualificationAudit({
          status: requiresContentReview
            ? "requires_content_review"
            : (shouldReopen ? "requires_family_review" : "inherited"),
          parentSnapshotId: loaded.snapshot.snapshotId,
          requiredStages,
          issues,
          updatedAt: now,
        }, item.questionId);
        if (!shouldReopen) return;
        appendReviewHistory(item, {
          stage: requiresContentReview ? "revision_content_family_reopen" : "revision_family_reopen",
          eventType: requiresContentReview ? "content_and_family_review_reopened" : "family_review_reopened",
          result: "pending_review",
          note: issues.map((issue) => issue.message).filter(Boolean).join("\n")
            || cleanText(payload.reason || "V2 风险题题族阶段重新审核。", 4000),
          reviewer,
          reviewedAt: now,
          parentSnapshotId: loaded.snapshot.snapshotId,
          requestedRisk: requestedRiskQuestionIds.has(item.questionId),
          qualificationIssues: clone(issues),
        });
        if (requiresContentReview) item.contentReview = normalizeReview();
        item.familyReview = normalizeReview();
        item.revision += 1;
        item.updatedAt = now;
      });
      const inheritedQuestionIds = draft.items
        .filter((item) => !reopenedQuestionIds.has(item.questionId)).map((item) => item.questionId);
      draft.source.reopenedQuestionIds = [...reopenedQuestionIds];
      draft.source.automaticallyReopenedQuestionIds = automaticallyReopenedQuestionIds;
      draft.source.inheritedQuestionIds = inheritedQuestionIds;
      draft.revisionReview = {
        schemaVersion: "ClassificationGoldRevisionReviewV1",
        parentSnapshotId: loaded.snapshot.snapshotId,
        createdAt: now,
        createdBy: reviewer,
        requestedRiskQuestionIds: [...requestedRiskQuestionIds],
        automaticallyReopenedQuestionIds,
        reopenedQuestionIds: [...reopenedQuestionIds],
        contentReopenedQuestionIds: [...contentReopenedQuestionIds],
        familyOnlyReopenedQuestionIds: [...reopenedQuestionIds]
          .filter((questionId) => !contentReopenedQuestionIds.has(questionId)),
        inheritedQuestionIds,
        qualificationIssues: clone([...qualificationIssues, ...semanticValidation.issues]),
        formalFamilyFactsSha256,
      };
      state.batches.unshift(draft);
      write(state);
      const saved = getBatch(read(), id);
      return {
        created: true,
        batch: presentBatch(saved),
        revisionReview: clone(saved.revisionReview),
        semanticValidation,
      };
    },
    reopenFamilyReviews(batchId, payload = {}) {
      const state = read();
      const batch = getBatch(state, batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
      const questionIds = uniqueStrings(payload.questionIds, 1000).sort();
      const reason = cleanText(payload.reason, 4000);
      const preflightReportHash = cleanText(payload.preflightReportHash, 128).toLowerCase();
      if (!questionIds.length || !reason || !/^[a-f0-9]{64}$/.test(preflightReportHash)) {
        throw new Error("classification_gold_review_reopen_request_invalid");
      }
      const unknownQuestionIds = questionIds.filter((questionId) => !batch.items.some((item) => item.questionId === questionId));
      if (unknownQuestionIds.length) {
        const error = new Error("classification_gold_review_revision_risk_items_invalid");
        error.details = { unknownQuestionIds, invalidOrders: [] };
        throw error;
      }
      const operationKey = contentHash({ batchId: batch.id, questionIds, reason, preflightReportHash });
      const previousOperation = (batch.familyReopenOperations || []).find((operation) => operation.operationKey === operationKey);
      if (previousOperation) {
        return {
          idempotentReplay: true,
          operation: clone(previousOperation),
          batch: presentBatch(batch),
          batchMeta: batchMeta(batch),
          summary: batchSummary(batch),
        };
      }
      const now = Date.now();
      const reviewer = cleanText(payload.reviewer || "超级管理员", 120);
      const submittedIssues = (Array.isArray(payload.qualificationIssues) ? payload.qualificationIssues : [])
        .map((issue) => normalizeQualificationIssue(issue, issue?.questionId))
        .filter((issue) => questionIds.includes(issue.questionId));
      batch.items.filter((item) => questionIds.includes(item.questionId)).forEach((item) => {
        const itemIssues = submittedIssues.filter((issue) => issue.questionId === item.questionId);
        appendReviewHistory(item, {
          stage: "preflight_family_reopen",
          eventType: "family_review_reopened",
          result: "pending_review",
          note: reason,
          reviewer,
          reviewedAt: now,
          preflightReportHash,
          qualificationIssues: clone(itemIssues),
        });
        item.qualificationAudit = normalizeQualificationAudit({
          status: "requires_family_review",
          parentSnapshotId: batch.source?.parentSnapshotId,
          requiredStages: ["family"],
          issues: [...(item.qualificationAudit?.issues || []), ...itemIssues],
          updatedAt: now,
        }, item.questionId);
        item.familyReview = normalizeReview();
        item.revision += 1;
        item.updatedAt = now;
      });
      const operation = {
        operationKey,
        questionIds,
        reason,
        preflightReportHash,
        qualificationIssues: clone(submittedIssues),
        reviewer,
        reopenedAt: now,
      };
      batch.familyReopenOperations = [...(batch.familyReopenOperations || []), operation].slice(-200);
      batch.revision += 1;
      batch.freezePreparation = null;
      batch.updatedAt = now;
      write(state);
      return {
        idempotentReplay: false,
        operation: clone(operation),
        batch: presentBatch(batch),
        batchMeta: batchMeta(batch),
        summary: batchSummary(batch),
      };
    },
    syncPreflightIssues(batchId, payload = {}) {
      const state = read();
      const batch = getBatch(state, batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");

      const requestedQuestionIds = uniqueStrings(payload.questionIds, 1000).sort();
      const unknownRequestedQuestionIds = requestedQuestionIds
        .filter((questionId) => !batch.items.some((item) => item.questionId === questionId));
      if (unknownRequestedQuestionIds.length) {
        const error = new Error("classification_gold_review_revision_risk_items_invalid");
        error.details = { unknownQuestionIds: unknownRequestedQuestionIds, invalidOrders: [] };
        throw error;
      }

      const itemByOrder = new Map(batch.items.map((item) => [Number(item.order), item]));
      const submittedIssues = (Array.isArray(payload.qualificationIssues) ? payload.qualificationIssues : [])
        .map((issue) => {
          const questionId = cleanText(issue?.questionId, 240)
            || cleanText(itemByOrder.get(Number(issue?.order))?.questionId, 240);
          return normalizeQualificationIssue({ ...issue, questionId }, questionId);
        });
      const unknownIssueQuestionIds = submittedIssues
        .map((issue) => issue.questionId)
        .filter((questionId) => questionId && !batch.items.some((item) => item.questionId === questionId));
      const invalidIssueEntries = submittedIssues.filter((issue) => !issue.questionId);
      if (unknownIssueQuestionIds.length || invalidIssueEntries.length) {
        const error = new Error("classification_gold_review_revision_risk_items_invalid");
        error.details = {
          unknownQuestionIds: [...new Set(unknownIssueQuestionIds)],
          invalidOrders: invalidIssueEntries.map((issue) => issue.order).filter(Boolean),
        };
        throw error;
      }

      const validation = validateGoldReviewBatchFamilySemantics(batch, {
        questionIds: requestedQuestionIds,
      });
      const selectedQuestionIdSet = requestedQuestionIds.length ? new Set(requestedQuestionIds) : null;
      const scopedSubmittedIssues = submittedIssues.filter((issue) => (
        !selectedQuestionIdSet || selectedQuestionIdSet.has(issue.questionId)
      ));
      const allIssues = mergeQualificationIssues(validation.issues, scopedSubmittedIssues);
      const blockingIssues = allIssues.filter((issue) => issue.severity !== "warning");
      const affectedQuestionIds = [...new Set(blockingIssues.map((issue) => issue.questionId))].sort();
      const suppliedReportHash = cleanText(payload.preflightReportHash, 128).toLowerCase();
      if (suppliedReportHash && !/^[a-f0-9]{64}$/.test(suppliedReportHash)) {
        throw new Error("classification_gold_review_reopen_request_invalid");
      }
      const preflightReportHash = suppliedReportHash || contentHash({
        batchId: batch.id,
        questionIds: requestedQuestionIds,
        issues: allIssues,
      });
      const reason = cleanText(payload.reason, 4000)
        || "语义一致性预检发现题族事实需要重新审核。";
      const operationKey = contentHash({
        batchId: batch.id,
        questionIds: affectedQuestionIds,
        preflightReportHash,
      });
      const previousOperation = (batch.familyReopenOperations || [])
        .find((operation) => operation.operationKey === operationKey);
      if (previousOperation) {
        return {
          idempotentReplay: true,
          changed: false,
          operation: clone(previousOperation),
          validation: clone(validation),
          batch: presentBatch(batch),
          batchMeta: batchMeta(batch),
          summary: batchSummary(batch),
        };
      }

      // A clean preflight is deliberately read-only.  It still returns the
      // validation payload so the UI can clear a stale problem list.
      if (!affectedQuestionIds.length) {
        return {
          idempotentReplay: false,
          changed: false,
          operation: null,
          validation: clone(validation),
          batch: presentBatch(batch),
          batchMeta: batchMeta(batch),
          summary: batchSummary(batch),
          preflightReportHash,
        };
      }

      const now = Date.now();
      const reviewer = cleanText(payload.reviewer || "超级管理员", 120);
      batch.items.filter((item) => affectedQuestionIds.includes(item.questionId)).forEach((item) => {
        const itemIssues = allIssues.filter((issue) => issue.questionId === item.questionId);
        const contentRequired = itemIssues.some((issue) => issue.requiredStages.includes("content"))
          || (item.qualificationAudit?.status === "requires_content_review"
            && item.qualificationAudit.requiredStages.includes("content"));
        const retainedIssues = (item.qualificationAudit?.issues || [])
          .filter((issue) => !["family_semantic_gate_v1", "preflight_sync"].includes(issue.source));
        const auditIssues = mergeQualificationIssues(retainedIssues, itemIssues);
        appendReviewHistory(item, {
          stage: "preflight_sync",
          eventType: "preflight_review_reopened",
          result: "pending_review",
          note: itemIssues.map((issue) => issue.message).filter(Boolean).join("\n") || reason,
          reviewer,
          reviewedAt: now,
          preflightReportHash,
          qualificationIssues: clone(itemIssues),
        });
        item.qualificationAudit = normalizeQualificationAudit({
          ...item.qualificationAudit,
          status: contentRequired ? "requires_content_review" : "requires_family_review",
          parentSnapshotId: batch.source?.parentSnapshotId || item.qualificationAudit?.parentSnapshotId,
          requiredStages: contentRequired ? ["content", "family"] : ["family"],
          issues: auditIssues,
          updatedAt: now,
        }, item.questionId);
        if (contentRequired) item.contentReview = normalizeReview();
        item.familyReview = normalizeReview();
        item.revision += 1;
        item.updatedAt = now;
      });

      const operation = {
        operationKey,
        operationType: "preflight_sync",
        questionIds: affectedQuestionIds,
        reason,
        preflightReportHash,
        qualificationIssues: clone(allIssues),
        semanticIssueCount: validation.issueCount,
        warningCount: validation.warningCount,
        reviewer,
        reopenedAt: now,
      };
      batch.familyReopenOperations = [...(batch.familyReopenOperations || []), operation].slice(-200);
      batch.revision += 1;
      batch.freezePreparation = null;
      batch.updatedAt = now;
      write(state);
      return {
        idempotentReplay: false,
        changed: true,
        operation: clone(operation),
        validation: clone(validation),
        batch: presentBatch(batch),
        batchMeta: batchMeta(batch),
        summary: batchSummary(batch),
      };
    },
    reviewContent(batchId, questionId, payload = {}) {
      const state = read();
      const batch = getBatch(state, batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
      const item = batch.items.find((entry) => entry.questionId === String(questionId || ""));
      if (!item) throw new Error("classification_gold_review_item_not_found");
      assertRevisionStageWritable(item, "content");
      if (Number(payload.expectedRevision) !== item.revision) throw new Error("classification_gold_review_revision_conflict");
      if (!REVIEW_RESULTS.has(payload.result)) throw new Error("classification_gold_review_result_invalid");
      const note = cleanText(payload.note, 4000);
      if (["corrected", "disputed"].includes(payload.result) && !note) throw new Error("classification_gold_review_note_required");
      const submittedAnswerKnowledge = normalizeSubmittedAnswerKnowledge(payload.answerKnowledge || {}, item);
      const formalBaseline = normalizeAnswerKnowledge(item.humanGold.answerKnowledge);
      if (formalBoundDigest(submittedAnswerKnowledge, item.question) !== formalBoundDigest(formalBaseline, item.question)) {
        throw new Error("classification_gold_review_business_sync_required");
      }
      const reviewAnswerKnowledge = normalizeAnswerKnowledge({
        ...submittedAnswerKnowledge,
        correctAnswer: formalBaseline.correctAnswer,
        referenceAnswer: formalBaseline.referenceAnswer,
        answerSource: formalBaseline.answerSource,
        answerReviewStatus: formalBaseline.answerReviewStatus,
        coreKnowledge: formalBaseline.coreKnowledge,
        requiredKnowledge: formalBaseline.requiredKnowledge,
      });
      const reviewedAt = Date.now();
      const reviewer = cleanText(payload.reviewer || "超级管理员", 120);
      const contentAlreadyReviewed = REVIEW_RESULTS.has(item.contentReview.result);
      const nextAnswerKnowledge = applyHumanEvidenceSelection(
        item,
        reviewAnswerKnowledge,
        payload,
        reviewer,
        reviewedAt,
      );
      const nextDigest = knowledgeDigest(nextAnswerKnowledge);
      if (contentAlreadyReviewed && payload.result === "confirmed" && nextDigest !== item.knowledgeDigest) {
        throw new Error("classification_gold_review_confirmed_value_changed");
      }
      assertIndependentContentComplete(item, nextAnswerKnowledge, payload.result);
      const aiCandidateVisibleBeforeSubmission = contentAlreadyReviewed;
      const selectedEvidenceChunkIds = nextAnswerKnowledge.textbookEvidence
        .filter((evidence) => evidence.humanSelection?.status === "selected")
        .map((evidence) => evidence.chunkId);
      const contentEvent = appendReviewHistory(item, {
        stage: "content",
        result: payload.result,
        note,
        reviewer,
        reviewedAt,
        previousKnowledgeDigest: item.knowledgeDigest,
        submittedKnowledgeDigest: nextDigest,
        selectedEvidenceChunkIds,
        submittedAnswerKnowledge: clone(nextAnswerKnowledge),
        aiCandidateVisibleBeforeSubmission,
      });
      preserveFirstHumanJudgment(item, "content", contentEvent, nextAnswerKnowledge);
      item.humanGold.answerKnowledge = nextAnswerKnowledge;
      const reviewEvidenceNote = cleanText(
        payload.answerKnowledgeProvenance?.reviewEvidenceNote || payload.reviewEvidenceNote,
        4000,
      );
      item.humanGold.answerKnowledgeProvenance = humanSubmissionProvenance(
        {
          ...item.humanGold.answerKnowledgeProvenance,
          ...(reviewEvidenceNote ? { reviewEvidenceNote } : {}),
        },
        "content",
        reviewer,
        reviewedAt,
      );
      item.humanGold.answerKnowledgeProvenance.humanSelectedEvidenceChunkIds = selectedEvidenceChunkIds;
      item.knowledgeDigest = nextDigest;
      item.contentReview = {
        result: payload.result,
        note,
        reviewer,
        reviewedAt,
        basedOnKnowledgeDigest: nextDigest,
      };
      item.familyReview = normalizeReview();
      advanceQualificationAfterContentReview(item, reviewedAt);
      item.revision += 1;
      item.updatedAt = reviewedAt;
      batch.revision += 1;
      batch.freezePreparation = null;
      batch.updatedAt = item.updatedAt;
      write(state);
      return { item: presentItem(item), summary: batchSummary(batch), batchMeta: batchMeta(batch) };
    },
    reviewBusinessContent(batchId, questionId, payload = {}) {
      const state = read();
      const batch = getBatch(state, batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
      const item = batch.items.find((entry) => entry.questionId === String(questionId || ""));
      if (!item) throw new Error("classification_gold_review_item_not_found");
      assertRevisionStageWritable(item, "content");
      if (Number(payload.expectedRevision) !== item.revision) throw new Error("classification_gold_review_revision_conflict");
      if (payload.result !== "corrected") throw new Error("classification_gold_review_business_correction_required");
      const note = cleanText(payload.note, 4000);
      if (!note) throw new Error("classification_gold_review_note_required");
      const question = normalizeQuestion(payload.question, item.questionId);
      if (question.id !== item.questionId) throw new Error("classification_gold_review_question_mismatch");
      if (question.version <= Number(item.question.version || 0)) {
        throw new Error("classification_gold_review_question_version_not_advanced");
      }
      const reviewedAt = Date.now();
      const reviewer = cleanText(payload.reviewer || "超级管理员", 120);
      const submittedAnswerKnowledge = normalizeSubmittedAnswerKnowledge(payload.answerKnowledge || {}, item, question);
      const nextAnswerKnowledge = applyHumanEvidenceSelection(
        item,
        submittedAnswerKnowledge,
        payload,
        reviewer,
        reviewedAt,
        { allowSubmittedEvidence: true },
      );
      const nextDigest = knowledgeDigest(nextAnswerKnowledge);
      assertIndependentContentComplete(item, nextAnswerKnowledge, "corrected");
      const selectedEvidenceChunkIds = nextAnswerKnowledge.textbookEvidence
        .filter((evidence) => evidence.humanSelection?.status === "selected")
        .map((evidence) => evidence.chunkId);
      const aiCandidateVisibleBeforeSubmission = REVIEW_RESULTS.has(item.contentReview.result);
      const contentEvent = appendReviewHistory(item, {
        stage: "content",
        result: "corrected",
        note,
        reviewer,
        reviewedAt,
        previousQuestionVersion: item.question.version,
        questionVersion: question.version,
        previousKnowledgeDigest: item.knowledgeDigest,
        submittedKnowledgeDigest: nextDigest,
        selectedEvidenceChunkIds,
        submittedAnswerKnowledge: clone(nextAnswerKnowledge),
        formalBusinessCorrection: true,
        aiCandidateVisibleBeforeSubmission,
      });
      preserveFirstHumanJudgment(item, "content", contentEvent, nextAnswerKnowledge);
      item.question = question;
      item.humanGold.answerKnowledge = nextAnswerKnowledge;
      item.humanGold.answerKnowledgeProvenance = humanSubmissionProvenance({
        source: "formal_question_business_correction",
        questionVersion: question.version,
        ...(cleanText(payload.answerKnowledgeProvenance?.reviewEvidenceNote, 4000)
          ? { reviewEvidenceNote: cleanText(payload.answerKnowledgeProvenance.reviewEvidenceNote, 4000) }
          : {}),
      }, "content", reviewer, reviewedAt);
      item.humanGold.answerKnowledgeProvenance.humanSelectedEvidenceChunkIds = selectedEvidenceChunkIds;
      item.officialBaseline = normalizeOfficialBaseline({
        question,
        answerKnowledge: nextAnswerKnowledge,
        familyGold: item.humanGold.familyGold,
        capturedQuestionVersion: question.version,
        provenance: { source: "formal_question_business_correction" },
      }, { questionId: item.questionId, sourceMode: item.sourceMode });
      item.sourceMaterials = normalizeSourceMaterials({
        ...item.sourceMaterials,
        sourceAnswer: { ...question, provenance: "formal_question_business_correction" },
      }, question);
      invalidateAiCandidates(item, "formal_question_or_knowledge_corrected", reviewedAt);
      item.knowledgeDigest = nextDigest;
      item.contentReview = {
        result: "corrected",
        note,
        reviewer,
        reviewedAt,
        basedOnKnowledgeDigest: nextDigest,
      };
      item.familyReview = normalizeReview();
      advanceQualificationAfterContentReview(item, reviewedAt);
      item.revision += 1;
      item.updatedAt = reviewedAt;
      batch.revision += 1;
      batch.freezePreparation = null;
      batch.updatedAt = item.updatedAt;
      write(state);
      return { item: presentItem(item), summary: batchSummary(batch), batchMeta: batchMeta(batch) };
    },
    reloadItem(batchId, questionId, payload = {}) {
      const state = read();
      const batch = getBatch(state, batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
      const item = batch.items.find((entry) => entry.questionId === String(questionId || ""));
      if (!item) throw new Error("classification_gold_review_item_not_found");
      assertRevisionStageWritable(item, "content", {
        allowFormalDriftReopen: payload.formalDriftConfirmed === true,
      });
      if (Number(payload.expectedRevision) !== item.revision) throw new Error("classification_gold_review_revision_conflict");
      const question = normalizeQuestion(payload.question, item.questionId);
      if (question.id !== item.questionId || !question.version) throw new Error("classification_gold_review_question_mismatch");
      const reloadedAnswerKnowledge = normalizeSubmittedAnswerKnowledge(payload.answerKnowledge || {}, item, question);
      const answerKnowledge = item.reviewMethod === INDEPENDENT_REVIEW_METHOD
        ? normalizeAnswerKnowledge({
          ...reloadedAnswerKnowledge,
          textbookEvidence: reloadedAnswerKnowledge.textbookEvidence.map((evidence) => ({
            ...evidence,
            candidateOnly: true,
            humanSelection: null,
          })),
        }, question)
        : reloadedAnswerKnowledge;
      const familyGold = normalizeFamilyGold(payload.familyGold, item.sourceMode);
      const reloadedAt = Date.now();
      appendReviewHistory(item, {
        stage: "reload",
        result: "reset",
        note: cleanText(payload.note || "从正式业务数据重载，清空两阶段审核。", 4000),
        reviewer: cleanText(payload.reviewer || "超级管理员", 120),
        reviewedAt: reloadedAt,
        previousQuestionVersion: item.question.version,
        questionVersion: question.version,
      });
      item.question = question;
      item.humanGold.answerKnowledge = answerKnowledge;
      item.humanGold.answerKnowledgeProvenance = clone(payload.answerKnowledgeProvenance || {
        source: "formal_question_reload",
        questionVersion: question.version,
      });
      item.humanGold.familyGold = familyGold;
      item.humanGold.familyGoldProvenance = clone(payload.familyGoldProvenance || {
        source: "formal_family_reload",
        questionVersion: question.version,
      });
      item.officialBaseline = normalizeOfficialBaseline({
        question,
        answerKnowledge,
        familyGold,
        capturedQuestionVersion: question.version,
        provenance: { source: "formal_business_reload" },
      }, { questionId: item.questionId, sourceMode: item.sourceMode });
      item.sourceMaterials = normalizeSourceMaterials({
        ...item.sourceMaterials,
        sourceAnswer: { ...question, provenance: "formal_question_reload" },
      }, question);
      invalidateAiCandidates(item, "formal_question_or_knowledge_reloaded", reloadedAt);
      item.knowledgeDigest = knowledgeDigest(answerKnowledge);
      item.contentReview = normalizeReview();
      item.familyReview = normalizeReview();
      if (item.qualificationAudit?.parentSnapshotId) {
        item.qualificationAudit = normalizeQualificationAudit({
          ...item.qualificationAudit,
          status: "requires_content_review",
          requiredStages: ["content", "family"],
          issues: [
            ...(item.qualificationAudit.issues || []),
            normalizeQualificationIssue({
              questionId: item.questionId,
              code: cleanText(payload.formalDriftStatus, 80) === "knowledge_drift"
                ? "formal_knowledge_drift" : "formal_question_drift",
              message: "正式题目或知识已更新，已通过显式重载重新开放答案与知识、题族两个阶段。",
              source: "formal_baseline_explicit_reload",
              requiredStages: ["content", "family"],
            }, item.questionId),
          ],
          updatedAt: reloadedAt,
        }, item.questionId);
      }
      item.revision += 1;
      item.updatedAt = reloadedAt;
      batch.revision += 1;
      batch.freezePreparation = null;
      batch.updatedAt = item.updatedAt;
      write(state);
      return { item: presentItem(item), summary: batchSummary(batch), batchMeta: batchMeta(batch) };
    },
    reviewFamily(batchId, questionId, payload = {}) {
      const state = read();
      const batch = getBatch(state, batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
      const item = batch.items.find((entry) => entry.questionId === String(questionId || ""));
      if (!item) throw new Error("classification_gold_review_item_not_found");
      assertRevisionStageWritable(item, "family");
      if (Number(payload.expectedRevision) !== item.revision) throw new Error("classification_gold_review_revision_conflict");
      if (!REVIEW_RESULTS.has(item.contentReview.result)) throw new Error("classification_gold_review_content_first");
      if (!REVIEW_RESULTS.has(payload.result)) throw new Error("classification_gold_review_result_invalid");
      const note = cleanText(payload.note, 4000);
      if (["corrected", "disputed"].includes(payload.result) && !note) throw new Error("classification_gold_review_note_required");
      const rawFamilyGold = payload.familyGold && typeof payload.familyGold === "object" ? payload.familyGold : {};
      const explicitFinalReplayMode = cleanText(payload.finalReplayMode, 80);
      const submittedFamilyReplayMode = Object.prototype.hasOwnProperty.call(rawFamilyGold, "replayMode")
        ? cleanText(rawFamilyGold.replayMode, 80) : "";
      if ((explicitFinalReplayMode && !REPLAY_MODES.has(explicitFinalReplayMode))
        || (submittedFamilyReplayMode && !REPLAY_MODES.has(submittedFamilyReplayMode))) {
        throw replayModeCorrectionError("classification_gold_review_replay_mode_invalid", item, {
          requestedReplayMode: explicitFinalReplayMode || submittedFamilyReplayMode,
        });
      }
      if (explicitFinalReplayMode && submittedFamilyReplayMode
        && explicitFinalReplayMode !== submittedFamilyReplayMode) {
        throw replayModeCorrectionError("classification_gold_review_replay_mode_conflict", item, {
          finalReplayMode: explicitFinalReplayMode,
          familyReplayMode: submittedFamilyReplayMode,
        });
      }
      const previousReplayMode = finalReplayMode(item);
      const nextReplayMode = explicitFinalReplayMode || submittedFamilyReplayMode || previousReplayMode;
      const replayModeChanged = nextReplayMode !== previousReplayMode;
      const replayModeChangeReason = cleanText(
        payload.replayModeChangeReason || rawFamilyGold.replayModeChangeReason || (replayModeChanged ? note : ""),
        4000,
      );
      if (replayModeChanged) {
        const requiredStages = uniqueStrings(item.qualificationAudit?.requiredStages, 4);
        if (!item.qualificationAudit?.parentSnapshotId || !requiredStages.includes("family")) {
          throw replayModeCorrectionError("classification_gold_review_replay_mode_locked", item, {
            previousReplayMode,
            requestedReplayMode: nextReplayMode,
          });
        }
        if (payload.result !== "corrected") {
          throw replayModeCorrectionError("classification_gold_review_replay_mode_correction_required", item, {
            previousReplayMode,
            requestedReplayMode: nextReplayMode,
          });
        }
        if (!replayModeChangeReason) {
          throw replayModeCorrectionError("classification_gold_review_replay_mode_change_reason_required", item, {
            previousReplayMode,
            requestedReplayMode: nextReplayMode,
          });
        }
      }
      if (payload.result !== "disputed") {
        const relationIssues = explicitRelatedFamilyRelationIssues(rawFamilyGold, item);
        if (requiresFamilySemanticGate(batch)
          && cleanText(rawFamilyGold.familyKnowledgeProtocolVersion, 80) !== FAMILY_KNOWLEDGE_PROTOCOL_VERSION) {
          relationIssues.push(normalizeQualificationIssue({
            questionId: item.questionId,
            order: item.order,
            code: "family_knowledge_protocol_missing",
            label: FAMILY_SEMANTIC_ISSUE_LABELS.family_knowledge_protocol_missing,
            message: `重新审核时必须提交 ${FAMILY_KNOWLEDGE_PROTOCOL_VERSION}。`,
            source: "family_semantic_gate_v2",
            expected: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
            actual: cleanText(rawFamilyGold.familyKnowledgeProtocolVersion, 80) || "missing",
          }, item.questionId));
        }
        if (relationIssues.length) {
          throw familySemanticGateError({
            issueCount: relationIssues.length,
            questionCount: 1,
            issues: relationIssues,
          });
        }
      }
      const familyGold = normalizeFamilyGold({
        ...rawFamilyGold,
        replayMode: nextReplayMode,
        ...(replayModeChangeReason ? { replayModeChangeReason } : {}),
      }, previousReplayMode);
      if (familyGold.decision === "join_existing" && !familyGold.primaryFamilyId) {
        throw new Error("classification_gold_review_primary_family_required");
      }
      if (familyGold.decision === "create_new" && payload.result !== "disputed") {
        const candidate = familyGold.candidateFamily;
        const candidateAnchorNodeIds = uniqueStrings([
          ...(candidate?.textbookAnchorNodeIds || []),
          ...(candidate?.textbookAnchors || []).map((anchor) => anchor.id),
        ], 40);
        if (!candidate?.name
          || !candidate.coreKnowledgeNodeId
          || !(candidate.requiredKnowledgeNodeIds || []).length
          || !candidateAnchorNodeIds.length
          || !candidate.assessmentAction) {
          throw new Error("classification_gold_review_candidate_family_incomplete");
        }
      }
      const reviewedAt = Date.now();
      const reviewer = cleanText(payload.reviewer || "超级管理员", 120);
      const aiCandidateVisibleBeforeSubmission = REVIEW_RESULTS.has(item.familyReview.result)
        && item.familyReview.basedOnKnowledgeDigest === item.knowledgeDigest;
      const familyEvent = appendReviewHistory(item, {
        stage: "family",
        result: payload.result,
        note,
        reviewer,
        reviewedAt,
        decision: familyGold.decision,
        primaryFamilyId: familyGold.primaryFamilyId,
        candidateFamilyName: familyGold.candidateFamily?.name || "",
        submittedFamilyGold: clone(familyGold),
        basedOnKnowledgeDigest: item.knowledgeDigest,
        aiCandidateVisibleBeforeSubmission,
        previousReplayMode,
        nextReplayMode,
        replayModeChanged,
        changeReason: replayModeChangeReason,
      });
      preserveFirstHumanJudgment(item, "family", familyEvent, familyGold);
      item.humanGold.familyGold = familyGold;
      item.humanGold.familyGoldProvenance = humanSubmissionProvenance(
        {
          ...item.humanGold.familyGoldProvenance,
          ...(payload.familyGoldProvenance && typeof payload.familyGoldProvenance === "object"
            ? clone(payload.familyGoldProvenance)
            : {}),
        },
        "family",
        reviewer,
        reviewedAt,
      );
      item.familyReview = {
        result: payload.result,
        note,
        reviewer,
        reviewedAt,
        basedOnKnowledgeDigest: item.knowledgeDigest,
        previousReplayMode,
        nextReplayMode,
        ...(replayModeChangeReason ? { changeReason: replayModeChangeReason } : {}),
      };
      if (item.qualificationAudit?.status === "requires_family_review") {
        item.qualificationAudit = normalizeQualificationAudit({
          ...item.qualificationAudit,
          status: "resolved",
          updatedAt: reviewedAt,
        }, item.questionId);
      }
      item.revision += 1;
      item.updatedAt = reviewedAt;
      batch.revision += 1;
      batch.freezePreparation = null;
      batch.updatedAt = item.updatedAt;
      write(state);
      return { item: presentItem(item), summary: batchSummary(batch), batchMeta: batchMeta(batch) };
    },
    validateFamilySemantics(batchId, options = {}) {
      const batch = getBatch(read(), batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      return validateGoldReviewBatchFamilySemantics(batch, options);
    },
    prepareFreeze(batchId, payload = {}) {
      const state = read();
      const batch = getBatch(state, batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
      const summary = batchSummary(batch);
      // 语义门禁先跑。原顺序是“整批两阶段是否完成”优先，导致覆盖门禁的阻断要到
      // 20 题全部形成终态、点冻结时才第一次暴露，中途审核页没有任何提示。
      if (requiresFamilySemanticGate(batch)) {
        const semanticValidation = validateGoldReviewBatchFamilySemantics(batch);
        if (!semanticValidation.valid) throw familySemanticGateError(semanticValidation);
      }
      if (!summary.readyToFreeze) throw new Error("classification_gold_review_incomplete");
      const now = Date.now();
      const document = snapshotPayload(batch, payload.reviewer, now);
      assertFrozenOptionKnowledge(document);
      const prepared = preparedSnapshotBytes(document);
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = now + freezePreparationTtlMs;
      batch.freezePreparation = {
        tokenSha256: sha256(token),
        preparedAt: now,
        expiresAt,
        batchRevision: batch.revision,
        reviewer: cleanText(payload.reviewer || "超级管理员", 120),
        snapshotId: document.snapshotId,
        version: document.version,
        fileName: safeSnapshotFileName(batch),
        fileSha256: prepared.fileSha256,
        contentSha256: prepared.contentSha256,
        byteLength: prepared.bytes.length,
        bytesBase64: prepared.bytes.toString("base64"),
        summary: clone(document.summary),
      };
      batch.updatedAt = now;
      write(state);
      return {
        batch: presentBatch(batch),
        summary,
        preparation: {
          token,
          preparedAt: now,
          expiresAt,
          batchRevision: batch.revision,
          snapshotId: document.snapshotId,
          version: document.version,
          fileName: safeSnapshotFileName(batch),
          fileSha256: prepared.fileSha256,
          contentSha256: prepared.contentSha256,
          byteLength: prepared.bytes.length,
          summary: clone(document.summary),
        },
      };
    },
    commitFreeze(batchId, payload = {}) {
      const state = read();
      const batch = getBatch(state, batchId);
      if (!batch) throw new Error("classification_gold_review_batch_not_found");
      if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
      const preparation = batch.freezePreparation;
      if (!preparation) throw new Error("classification_gold_review_prepare_required");
      const token = cleanText(payload.token, 256);
      if (!token || sha256(token) !== preparation.tokenSha256) {
        throw new Error("classification_gold_review_prepare_token_invalid");
      }
      const now = Date.now();
      if (now > Number(preparation.expiresAt || 0)) throw new Error("classification_gold_review_prepare_expired");
      if (Number(preparation.batchRevision) !== Number(batch.revision)) {
        throw new Error("classification_gold_review_prepare_stale");
      }
      const summary = batchSummary(batch);
      if (!summary.readyToFreeze) throw new Error("classification_gold_review_incomplete");
      const bytes = Buffer.from(String(preparation.bytesBase64 || ""), "base64");
      if (!bytes.length || bytes.length !== Number(preparation.byteLength)
        || sha256(bytes) !== preparation.fileSha256) {
        throw new Error("classification_gold_snapshot_preparation_corrupt");
      }
      const parsed = JSON.parse(bytes.toString("utf8"));
      const { integrity, ...snapshotDocument } = parsed;
      if (!integrity?.contentSha256 || integrity.contentSha256 !== preparation.contentSha256
        || contentHash(snapshotDocument) !== preparation.contentSha256
        || snapshotDocument.snapshotId !== preparation.snapshotId) {
        throw new Error("classification_gold_snapshot_preparation_corrupt");
      }
      const persisted = writeImmutableSnapshotBytes(snapshotDir, batch, bytes, preparation.fileSha256);
      batch.status = "frozen";
      batch.frozenAt = now;
      batch.frozenBy = preparation.reviewer;
      batch.updatedAt = now;
      batch.snapshot = {
        snapshotId: snapshotDocument.snapshotId,
        version: snapshotDocument.version,
        filePath: persisted.filePath,
        sidecarPath: persisted.sidecarPath,
        fileSha256: persisted.fileSha256,
        contentSha256: preparation.contentSha256,
        summary: clone(snapshotDocument.summary),
        frozenAt: snapshotDocument.frozenAt,
        frozenBy: batch.frozenBy,
      };
      batch.freezePreparation = null;
      batch.revision += 1;
      write(state);
      return { batch: presentBatch(batch), summary: batchSummary(batch), snapshot: clone(batch.snapshot) };
    },
    freeze() {
      throw new Error("classification_gold_review_prepare_required");
    },
  };
}

function createFileClassificationGoldReviewStore(
  filePath = path.resolve(__dirname, "../../../.runtime/classification-gold-reviews.json"),
  options = {},
) {
  return createClassificationGoldReviewStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { schemaVersion: STORE_SCHEMA_VERSION, batches: [] }; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  }, options);
}

function createMemoryClassificationGoldReviewStore(initialState = {}, options = {}) {
  let state = normalizeState(initialState);
  return createClassificationGoldReviewStore({
    read: () => clone(state),
    write: (next) => { state = normalizeState(next); },
  }, options);
}

module.exports = {
  CHOICE_STRUCTURES,
  CORE_KNOWLEDGE_ROLES,
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  OPTION_KNOWLEDGE_PROTOCOL_VERSION,
  OPTION_KNOWLEDGE_RELATIONS,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_SCHEMA_VERSION,
  auditJointContributionCoverage,
  batchMeta,
  batchSummary,
  canonicalize,
  contentHash,
  createFileClassificationGoldReviewStore,
  createMemoryClassificationGoldReviewStore,
  knowledgeNodesCompatible,
  knowledgeSetsCompatible,
  inheritFrozenMembership,
  scopeAnchorMatchesRequiredKnowledge,
  normalizeAnswerKnowledge,
  normalizeAtomicStatement,
  normalizeOptionKnowledge,
  normalizeFamilyGold,
  readFrozenGoldSnapshot,
  sha256,
  validateGoldReviewBatchFamilySemantics,
};
