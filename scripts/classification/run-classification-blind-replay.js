const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createServer } = require("../../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../../apps/api/src/ai-config");
const { createMemoryAiTaskStore } = require("../../apps/api/src/ai-task-store");
const { createMemoryQuestionStore } = require("../../apps/api/src/question-store");
const { createMemoryQuestionFamilyStore } = require("../../apps/api/src/question-family-store");
const { createMemoryKnowledgeStructureStore } = require("../../apps/api/src/knowledge-structure-store");
const { createMemoryTextbookKnowledgeStore } = require("../../apps/api/src/textbook-knowledge-store");
const { createMemoryTextbookCatalogStore } = require("../../apps/api/src/textbook-catalog-store");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../../apps/api/src/knowledge-classification-experience-store");
const { createMemoryKnowledgeDossierStore } = require("../../apps/api/src/knowledge-dossier-store");
const { createMemoryKnowledgeClassificationStore } = require("../../apps/api/src/knowledge-classification-store");
const { createMemoryAdminOperationStore } = require("../../apps/api/src/admin-operation-store");
const { createMemoryClassificationCommitStore } = require("../../apps/api/src/classification-commit-store");
const {
  CORE_KNOWLEDGE_ROLES,
  OPTION_KNOWLEDGE_PROTOCOL_VERSION,
  normalizeAtomicStatement,
  normalizeOptionKnowledge,
  readFrozenGoldSnapshot,
} = require("../../apps/api/src/classification-gold-review-store");
const {
  compareAssessmentActions: compareSharedAssessmentActions,
  normalizeAssessmentActionSemantics: normalizeSharedAssessmentActionSemantics,
} = require("../../packages/domain/assessment-action-semantics");
const {
  FORMAL_STATE_FILES,
  hashFormalState,
} = require("./classification-blind-replay-state");
const {
  buildReplayContextPreflight,
  readReplayContext,
} = require("./classification-blind-replay-context");

const DEFAULT_QUESTION_ID = "question-f9aa8216-2bbb-49df-975b-049e36e432d9";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const REPLAY_MODES = new Set(["auto", "mature", "singleton", "unmatched"]);
const GOLD_STATUSES = new Set(["auto", "confirmed", "gold_needs_review"]);
const UNMATCHED_GOLD_STATUSES = new Set(["unreviewed", "confirmed"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "partial", "failed", "interrupted"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizePrimaryNodeRole(value) {
  const role = String(value || "").trim();
  return CORE_KNOWLEDGE_ROLES.has(role) ? role : "core";
}

function relatedFamilyRelationsFor(familyGold = {}) {
  const relations = [];
  const seen = new Set();
  const append = (value, fallbackRole = "required") => {
    const familyId = String(value?.familyId || value?.id || value || "").trim();
    if (!familyId || seen.has(familyId)) return;
    const explicitRole = String(value?.coverageRole || "").trim();
    const coverageRole = ["required", "reference"].includes(explicitRole)
      ? explicitRole
      : (value?.requiredForAnswer === false ? "reference"
        : (value?.requiredForAnswer === true ? "required" : fallbackRole));
    relations.push({
      familyId,
      coverageRole,
      requiredForAnswer: coverageRole === "required",
    });
    seen.add(familyId);
  };
  (Array.isArray(familyGold.relatedFamilyRelations) ? familyGold.relatedFamilyRelations : [])
    .forEach((relation) => append(relation));
  (Array.isArray(familyGold.relatedFamilyIds) ? familyGold.relatedFamilyIds : [])
    .forEach((familyId) => append(familyId, "required"));
  return relations;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

function questionStemCore(question) {
  return normalizeText(String(question?.stem || "")
    .replace(/^[（(【\[][^）)】\]]{0,100}[）)】\]]\s*/u, "")
    .replace(/[（(]\s*[）)]\s*$/u, ""));
}

function sanitizeQuestionForBlindReplay(question) {
  const masked = clone(question);
  masked.chapter = "";
  masked.knowledgePoints = [];
  masked.primaryKnowledgePoint = "";
  masked.subKnowledgePoints = [];
  masked.knowledgeDepthScore = 0;
  masked.contentObscurityScore = 0;
  delete masked.knowledgeFingerprint;
  delete masked.familyMemberships;
  delete masked.questionFamilyIds;
  delete masked.primaryFamilyId;
  if (masked.answerVariants && typeof masked.answerVariants === "object") {
    masked.answerVariants = {
      ...masked.answerVariants,
      ai: "",
      community: "",
    };
  }
  masked.versions = (Array.isArray(masked.versions) ? masked.versions : []).map((version) => ({
    ...version,
    ...(version?.previousSnapshot
      ? { previousSnapshot: sanitizeQuestionForBlindReplay({ ...version.previousSnapshot, versions: [] }) }
      : {}),
  }));
  return masked;
}

function sanitizeKnowledgeStructureState(state, questionIds) {
  const targetIds = new Set(questionIds.map(String));
  const masked = clone(state);
  masked.records = (Array.isArray(masked.records) ? masked.records : []).map((record) => ({
    ...record,
    fingerprints: (Array.isArray(record.fingerprints) ? record.fingerprints : [])
      .filter((fingerprint) => !targetIds.has(String(fingerprint?.questionId || ""))),
  }));
  Object.values(masked.editsByBook || {}).forEach((edits) => {
    if (!edits || typeof edits !== "object" || Array.isArray(edits)) return;
    if (edits.fingerprintOverrides && typeof edits.fingerprintOverrides === "object") {
      targetIds.forEach((questionId) => { delete edits.fingerprintOverrides[questionId]; });
    }
  });
  return masked;
}

function sanitizeQuestionFamilyState(state, questionIds, options = {}) {
  const targetIds = new Set(questionIds.map(String));
  const hiddenFamilyIds = new Set((options.hiddenFamilyIds || []).map(String).filter(Boolean));
  const masked = clone(state);
  const hiddenFamilyReferenceIds = new Set([
    ...hiddenFamilyIds,
    ...familyAliasIdsResolvingTo(masked, [...hiddenFamilyIds]),
  ]);
  masked.families = (Array.isArray(masked.families) ? masked.families : [])
    .filter((family) => !hiddenFamilyReferenceIds.has(String(family?.id || "")))
    .map((family) => ({
      ...family,
      members: (Array.isArray(family.members) ? family.members : [])
        .filter((member) => !targetIds.has(String(member?.questionId || ""))),
    }));
  if (masked.familyAliases && typeof masked.familyAliases === "object" && !Array.isArray(masked.familyAliases)) {
    masked.familyAliases = Object.fromEntries(Object.entries(masked.familyAliases)
      .filter(([aliasId, familyId]) => !hiddenFamilyReferenceIds.has(String(aliasId)) && !hiddenFamilyReferenceIds.has(String(familyId))));
  }
  masked.familySetLinks = (Array.isArray(masked.familySetLinks) ? masked.familySetLinks : [])
    .filter((link) => link?.memberType !== "family" || !hiddenFamilyReferenceIds.has(String(link?.memberId || "")));
  Object.entries(masked.historyByBook || {}).forEach(([bookId, history]) => {
    if (!Array.isArray(history)) return;
    masked.historyByBook[bookId] = history.map((entry) => ({
      ...entry,
      families: (Array.isArray(entry?.families) ? entry.families : [])
        .filter((family) => !hiddenFamilyReferenceIds.has(String(family?.id || ""))),
      ...(entry?.familyAliases && typeof entry.familyAliases === "object" && !Array.isArray(entry.familyAliases)
        ? {
          familyAliases: Object.fromEntries(Object.entries(entry.familyAliases)
            .filter(([aliasId, familyId]) => !hiddenFamilyReferenceIds.has(String(aliasId)) && !hiddenFamilyReferenceIds.has(String(familyId)))),
        }
        : {}),
    }));
  });
  if (masked.membershipRevisionByQuestion && typeof masked.membershipRevisionByQuestion === "object") {
    targetIds.forEach((questionId) => { delete masked.membershipRevisionByQuestion[questionId]; });
  }
  Object.entries(masked.unresolvedByBook || {}).forEach(([bookId, unresolved]) => {
    if (!Array.isArray(unresolved)) return;
    masked.unresolvedByBook[bookId] = unresolved.filter((questionId) => !targetIds.has(String(questionId)));
  });
  return masked;
}

function uniqueFamilyMemberQuestionIds(family) {
  return [...new Set((Array.isArray(family?.members) ? family.members : [])
    .map((member) => String(member?.questionId || "")).filter(Boolean))];
}

function questionContentSignature(question) {
  const optionTexts = (Array.isArray(question?.options) ? question.options : [])
    .map((option) => normalizeText(option?.text || "")).filter(Boolean).sort();
  const content = JSON.stringify([
    normalizeText(question?.stem || ""),
    normalizeText(question?.material || ""),
    optionTexts,
  ]);
  return crypto.createHash("sha256").update(content).digest("hex");
}

// 独立成员 = 冻结金标确认的主归属成员（isPrimary === true），再按题目内容签名去重。
// 普通副归属成员不是独立成员，不能进入留一案例或上下文；判据是 isPrimary，
// 不能按 role 名判断（正式数据里存在 role=prototype 但 isPrimary=false 的成员）。
function independentFamilyMembers(family, questionState, excludedQuestionIds = []) {
  const excluded = new Set((excludedQuestionIds || []).map(String));
  const hasQuestionState = Array.isArray(questionState);
  const questionById = new Map((hasQuestionState ? questionState : [])
    .map((question) => [String(question?.id || ""), question]));
  const bySignature = new Map();
  (Array.isArray(family?.members) ? family.members : [])
    .filter((member) => member?.isPrimary === true)
    .map((member) => String(member?.questionId || "")).filter(Boolean)
    .forEach((questionId) => {
      if (excluded.has(questionId)) return;
      const question = questionById.get(questionId);
      if (hasQuestionState && !question) return;
      const signature = question ? questionContentSignature(question) : `question-id:${questionId}`;
      if (!bySignature.has(signature)) bySignature.set(signature, questionId);
    });
  return [...bySignature.entries()].map(([signature, questionId]) => ({ signature, questionId }));
}

function familyAliasIdsResolvingTo(state, familyIds) {
  const aliases = state?.familyAliases && typeof state.familyAliases === "object" && !Array.isArray(state.familyAliases)
    ? state.familyAliases
    : {};
  const hidden = new Set((familyIds || []).map(String).filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    Object.entries(aliases).forEach(([aliasId, targetId]) => {
      if (!hidden.has(String(targetId)) || hidden.has(String(aliasId))) return;
      hidden.add(String(aliasId));
      changed = true;
    });
  }
  return [...hidden].filter((id) => !(familyIds || []).map(String).includes(id));
}

function familySemanticSignature(family) {
  const coreKnowledgeNodeId = String(family?.coreKnowledgeNodeId || family?.knowledgeNodeId || "");
  const requiredKnowledgeNodeIds = [...new Set([
    coreKnowledgeNodeId,
    ...(Array.isArray(family?.requiredKnowledgeNodeIds) ? family.requiredKnowledgeNodeIds : []),
  ].map(String).filter(Boolean))].sort();
  const actionSemantics = normalizeAssessmentActionSemantics(family?.assessmentAction || "");
  const action = ["missing", "unclassified"].includes(actionSemantics.type)
    ? actionSemantics.normalizedText
    : `type:${actionSemantics.type}`;
  return [coreKnowledgeNodeId, requiredKnowledgeNodeIds.join(","), action].join("|");
}

function familyAliasesFor(state, familyId) {
  const aliases = state?.familyAliases && typeof state.familyAliases === "object" && !Array.isArray(state.familyAliases)
    ? state.familyAliases
    : {};
  return Object.entries(aliases).flatMap(([aliasId, targetId]) => (
    String(aliasId) === String(familyId) || String(targetId) === String(familyId)
      ? [{ aliasId: String(aliasId), targetId: String(targetId) }]
      : []
  ));
}

function familySetLinksFor(state, familyId) {
  return (Array.isArray(state?.familySetLinks) ? state.familySetLinks : [])
    .filter((link) => link?.memberType === "family" && String(link?.memberId || "") === String(familyId))
    .map(clone);
}

function resolveReplayMode(requestedMode, gold) {
  const requested = String(requestedMode || "auto");
  if (!REPLAY_MODES.has(requested)) throw new Error("blind_replay_mode_invalid");
  const memberCount = Number(gold?.primaryFamilyIndependentMemberCount) || 0;
  const retainedMemberCount = Object.prototype.hasOwnProperty.call(gold || {}, "primaryFamilyRetainedIndependentMemberCount")
    ? Number(gold.primaryFamilyRetainedIndependentMemberCount) || 0
    : Math.max(0, memberCount - 1);
  const hasPrimaryFamily = Boolean(gold?.primaryFamilyId);
  const resolved = requested === "auto"
    ? (hasPrimaryFamily ? (memberCount >= 2 ? "mature" : "singleton") : "unmatched")
    : requested;
  if (resolved === "mature" && (!hasPrimaryFamily || memberCount < 2 || retainedMemberCount < 1)) {
    throw new Error("blind_replay_mature_family_requires_two_independent_members");
  }
  if (resolved === "singleton" && (!hasPrimaryFamily || memberCount !== 1)) {
    throw new Error("blind_replay_singleton_family_requires_one_independent_member");
  }
  return resolved;
}

function buildReplayModePlan(requestedMode, gold, familyState, options = {}) {
  const mode = resolveReplayMode(requestedMode, gold);
  const primaryFamily = (familyState.families || []).find((family) => family.id === gold.primaryFamilyId) || null;
  const fallbackRetainedMemberQuestionIds = uniqueFamilyMemberQuestionIds(primaryFamily)
    .filter((questionId) => questionId !== String(gold.questionId || ""));
  const frozenRetainedMemberQuestionIds = Array.isArray(gold.primaryFamilyRetainedIndependentMemberQuestionIds)
    ? gold.primaryFamilyRetainedIndependentMemberQuestionIds.map(String).filter(Boolean)
    : [];
  const retainedIndependentMemberQuestionIds = frozenRetainedMemberQuestionIds.length
    ? frozenRetainedMemberQuestionIds
    : fallbackRetainedMemberQuestionIds;
  const retainedIndependentMemberCount = Object.prototype.hasOwnProperty.call(gold || {}, "primaryFamilyRetainedIndependentMemberCount")
    ? Number(gold.primaryFamilyRetainedIndependentMemberCount) || 0
    : Math.max(0, (Number(gold.primaryFamilyIndependentMemberCount) || 0) - 1);
  const hiddenFamilyIds = new Set();
  const equivalentFamilyIds = new Set();
  if (mode === "singleton" && primaryFamily) hiddenFamilyIds.add(primaryFamily.id);
  if (mode === "unmatched") {
    const signatures = new Set([gold.primaryFamily]
      .filter(Boolean).map(familySemanticSignature).filter((signature) => signature !== "||"));
    (familyState.families || []).forEach((family) => {
      if (signatures.has(familySemanticSignature(family))) {
        hiddenFamilyIds.add(family.id);
        equivalentFamilyIds.add(family.id);
      }
    });
  }
  return {
    requestedMode: String(requestedMode || "auto"),
    mode,
    primaryFamilyId: gold.primaryFamilyId || "",
    primaryFamilyIndependentMemberCount: Number(gold.primaryFamilyIndependentMemberCount) || 0,
    retainedIndependentMemberCount: mode === "mature" ? retainedIndependentMemberCount : 0,
    retainedIndependentMemberQuestionIds: mode === "mature" ? retainedIndependentMemberQuestionIds : [],
    hiddenFamilyIds: [...hiddenFamilyIds],
    equivalentFamilyIds: [...equivalentFamilyIds],
    expectsExistingFamily: mode === "mature",
    expectsCandidateFamilyDraft: mode !== "mature",
    goldFamilySemanticsAvailable: Boolean(primaryFamily),
    unmatchedGoldStatus: UNMATCHED_GOLD_STATUSES.has(options.unmatchedGoldStatus)
      ? options.unmatchedGoldStatus
      : "unreviewed",
  };
}

function countHistoricalFamilyDefinitions(state, familyIds) {
  const hidden = new Set((familyIds || []).map(String));
  return Object.values(state?.historyByBook || {}).flatMap((history) => Array.isArray(history) ? history : [])
    .flatMap((entry) => Array.isArray(entry?.families) ? entry.families : [])
    .filter((family) => hidden.has(String(family?.id || ""))).length;
}

function buildFamilyLeakageAudit(originalState, maskedState, questionId, modePlan) {
  const hiddenFamilyIds = new Set((modePlan?.hiddenFamilyIds || []).map(String));
  const hiddenFamilyReferenceIds = new Set([
    ...hiddenFamilyIds,
    ...familyAliasIdsResolvingTo(originalState, [...hiddenFamilyIds]),
  ]);
  const remainingAliases = Object.entries(maskedState?.familyAliases || {})
    .filter(([aliasId, familyId]) => hiddenFamilyReferenceIds.has(String(aliasId)) || hiddenFamilyReferenceIds.has(String(familyId))).length;
  const remainingSetLinks = (maskedState?.familySetLinks || [])
    .filter((link) => link?.memberType === "family" && hiddenFamilyReferenceIds.has(String(link?.memberId || ""))).length;
  const remainingHiddenDefinitions = (maskedState?.families || [])
    .filter((family) => hiddenFamilyReferenceIds.has(String(family?.id || ""))).length;
  const remainingTargetMemberships = (maskedState?.families || []).flatMap((family) => family.members || [])
    .filter((member) => String(member?.questionId || "") === String(questionId)).length;
  const retainedPrimaryFamily = (maskedState?.families || []).find((family) => family.id === modePlan?.primaryFamilyId);
  const retainedMemberIds = new Set(uniqueFamilyMemberQuestionIds(retainedPrimaryFamily));
  const retainedOtherPrimaryMembers = modePlan?.mode === "mature"
    ? (modePlan.retainedIndependentMemberQuestionIds || []).filter((id) => retainedMemberIds.has(String(id))).length
    : 0;
  const remainingHistoricalDefinitions = countHistoricalFamilyDefinitions(maskedState, [...hiddenFamilyReferenceIds]);
  const matureLeaveOneSatisfied = modePlan?.mode !== "mature" || retainedOtherPrimaryMembers >= 1;
  const candidateContextClean = remainingTargetMemberships === 0
    && remainingHiddenDefinitions === 0
    && remainingAliases === 0
    && remainingSetLinks === 0
    && remainingHistoricalDefinitions === 0
    && matureLeaveOneSatisfied;
  return {
    mode: modePlan?.mode || "",
    hiddenFamilyIds: [...hiddenFamilyIds],
    removedFamilyDefinitions: (originalState?.families || [])
      .filter((family) => hiddenFamilyReferenceIds.has(String(family?.id || ""))).length,
    removedFamilyAliases: Object.entries(originalState?.familyAliases || {})
      .filter(([aliasId, familyId]) => hiddenFamilyReferenceIds.has(String(aliasId)) || hiddenFamilyReferenceIds.has(String(familyId))).length,
    removedFamilySetLinks: (originalState?.familySetLinks || [])
      .filter((link) => link?.memberType === "family" && hiddenFamilyReferenceIds.has(String(link?.memberId || ""))).length,
    removedHistoricalFamilyDefinitions: countHistoricalFamilyDefinitions(originalState, [...hiddenFamilyReferenceIds])
      - remainingHistoricalDefinitions,
    remainingTargetMemberships,
    remainingHiddenDefinitions,
    remainingAliases,
    remainingFamilySetLinks: remainingSetLinks,
    remainingHistoricalDefinitions,
    retainedOtherPrimaryMembers,
    matureLeaveOneSatisfied,
    candidateContextClean,
  };
}

function sanitizeExperienceState(state, questions) {
  const targetQuestions = Array.isArray(questions) ? questions : [];
  const targetIds = new Set(targetQuestions.map((question) => String(question.id || "")).filter(Boolean));
  const targetStemCores = targetQuestions.map(questionStemCore).filter((stem) => stem.length >= 8);
  const masked = clone(state);
  const collections = ["messages", "cases", "corrections", "ruleExceptions", "reviewEvents", "dossierSuggestions"];
  const targetResultIds = new Set();
  const targetFeedbackIds = new Set();
  collections.forEach((key) => {
    (Array.isArray(masked[key]) ? masked[key] : []).forEach((item) => {
      if (!targetIds.has(String(item?.questionId || item?.sourceQuestionId || ""))) return;
      if (item?.resultId) targetResultIds.add(String(item.resultId));
      if (key === "messages" && item?.id) targetFeedbackIds.add(String(item.id));
    });
  });
  collections.forEach((key) => {
    masked[key] = (Array.isArray(masked[key]) ? masked[key] : []).filter((item) => {
      if (targetIds.has(String(item?.questionId || item?.sourceQuestionId || ""))) return false;
      if (targetResultIds.has(String(item?.resultId || item?.sourceResultId || ""))) return false;
      return true;
    });
  });
  masked.rules = (Array.isArray(masked.rules) ? masked.rules : []).filter((rule) => {
    if (targetIds.has(String(rule?.sourceQuestionId || ""))) return false;
    if (targetResultIds.has(String(rule?.sourceResultId || ""))) return false;
    const sourceFeedbackIds = [rule?.sourceFeedbackId, ...(Array.isArray(rule?.sourceFeedbackIds) ? rule.sourceFeedbackIds : [])]
      .map(String).filter(Boolean);
    if (sourceFeedbackIds.some((id) => targetFeedbackIds.has(id))) return false;
    const currentRuleText = normalizeText([
      rule?.title,
      rule?.statement,
      ...(Array.isArray(rule?.triggerTerms) ? rule.triggerTerms : []),
      ...(Array.isArray(rule?.positiveExamples) ? rule.positiveExamples : []),
      ...(Array.isArray(rule?.negativeExamples) ? rule.negativeExamples : []),
    ].filter(Boolean).join("\n"));
    return !targetStemCores.some((stem) => currentRuleText.includes(stem));
  });
  return masked;
}

function setMetrics(predictedValues, expectedValues) {
  const predicted = new Set((Array.isArray(predictedValues) ? predictedValues : []).map(String).filter(Boolean));
  const expected = new Set((Array.isArray(expectedValues) ? expectedValues : []).map(String).filter(Boolean));
  const intersection = [...predicted].filter((value) => expected.has(value)).length;
  const precision = predicted.size ? intersection / predicted.size : (expected.size ? 0 : 1);
  const recall = expected.size ? intersection / expected.size : (predicted.size ? 0 : 1);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const union = new Set([...predicted, ...expected]).size;
  return {
    predicted: [...predicted],
    expected: [...expected],
    exact: predicted.size === expected.size && intersection === expected.size,
    precision,
    recall,
    f1,
    jaccard: union ? intersection / union : 1,
  };
}

const RELATION_GOLD_CLASSES = ["question_only", "option_specific"];
const RELATION_PREDICTION_CLASSES = [
  "question_only",
  "option_specific",
  "undetermined",
  "unreviewed",
  "missing",
  "invalid",
];

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function relationPredictionLabel(value, present = true) {
  if (!present) return "missing";
  const relation = String(value || "").trim();
  return RELATION_PREDICTION_CLASSES.includes(relation) && relation !== "missing" ? relation : "invalid";
}

function relationClassMetrics(confusionMatrix, className) {
  const truePositive = confusionMatrix[className][className] || 0;
  const support = Object.values(confusionMatrix[className]).reduce((sum, count) => sum + count, 0);
  const predicted = RELATION_GOLD_CLASSES.reduce(
    (sum, goldClass) => sum + (confusionMatrix[goldClass][className] || 0),
    0,
  );
  const precision = ratio(truePositive, predicted);
  const recall = ratio(truePositive, support);
  return {
    support,
    predicted,
    truePositive,
    precision,
    recall,
    f1: precision === null || recall === null || precision + recall === 0
      ? (precision === 0 || recall === 0 ? 0 : null)
      : (2 * precision * recall) / (precision + recall),
  };
}

function nodeCounts(predictedValues, expectedValues) {
  const predicted = new Set((predictedValues || []).map(String).filter(Boolean));
  const expected = new Set((expectedValues || []).map(String).filter(Boolean));
  const truePositive = [...predicted].filter((value) => expected.has(value)).length;
  return {
    truePositive,
    falsePositive: predicted.size - truePositive,
    falseNegative: expected.size - truePositive,
  };
}

function nodeMetricsFromCounts(counts, unitCount) {
  const precision = ratio(counts.truePositive, counts.truePositive + counts.falsePositive);
  const recall = ratio(counts.truePositive, counts.truePositive + counts.falseNegative);
  return {
    ...counts,
    unitCount,
    precision,
    recall,
    f1: precision === null || recall === null || precision + recall === 0
      ? (precision === 0 || recall === 0 ? 0 : null)
      : (2 * precision * recall) / (precision + recall),
  };
}

function relationUnitsForGold(gold = {}) {
  return gold.choiceStructure === "composed_options"
    ? (gold.atomicStatements || [])
    : (gold.optionKnowledge || []);
}

function agent1RelationUnits(result = {}, choiceStructure = "direct_options") {
  const features = result.agent1Features || result.agent1FeatureSnapshot || {};
  return choiceStructure === "composed_options"
    ? (features.atomicStatements || [])
    : (features.optionFeatures || []);
}

function verifiedNodeUnits(result = {}) {
  const verification = result.agent2Verification || {};
  return (Array.isArray(verification.optionRelationAssessments)
    ? verification.optionRelationAssessments : []).map((assessment) => {
    const decision = String(assessment?.decision || "");
    const agent1Relation = String(assessment?.agent1KnowledgeRelation || "");
    const proposedRelation = String(assessment?.proposedKnowledgeRelation || "");
    let knowledgeNodeIds = [];
    let nodeDecision = "unverified";
    if (decision === "confirm" && agent1Relation === "option_specific") {
      knowledgeNodeIds = assessment.verifiedKnowledgeNodeIds || [];
      nodeDecision = "agent3_confirmed";
    } else if (decision === "correction" && proposedRelation === "option_specific") {
      knowledgeNodeIds = assessment.proposedKnowledgeNodeIds || [];
      nodeDecision = "agent3_correction";
    }
    return {
      key: assessment?.key,
      knowledgeNodeIds,
      nodeDecision,
    };
  });
}

function knowledgeNodeIdsFor(unit = {}) {
  return [...new Set([
    ...(unit.knowledgeNodeIds || []),
    ...(unit.nodeIds || []),
    ...(unit.matchedNodeIds || []),
  ].map(String).filter(Boolean))];
}

function buildOptionKnowledgeEvaluation(result, gold) {
  const protocolVersion = String(gold?.optionKnowledgeProtocolVersion || "");
  if (protocolVersion !== OPTION_KNOWLEDGE_PROTOCOL_VERSION) {
    return { applicable: false, protocolVersion, exclusionReason: "legacy_option_knowledge_protocol" };
  }
  const choiceStructure = gold.choiceStructure === "composed_options" ? "composed_options" : "direct_options";
  const goldUnits = relationUnitsForGold(gold);
  const predictionUnits = agent1RelationUnits(result, choiceStructure);
  const nodeUnits = verifiedNodeUnits(result);
  const predictionByKey = new Map(predictionUnits.map((unit) => [String(unit?.key || unit?.atomicKey || "").trim().toUpperCase(), unit]));
  const nodeByKey = new Map(nodeUnits.map((unit) => [String(unit?.key || unit?.atomicKey || "").trim().toUpperCase(), unit]));
  const confusionMatrix = Object.fromEntries(RELATION_GOLD_CLASSES.map((goldClass) => [
    goldClass,
    Object.fromEntries(RELATION_PREDICTION_CLASSES.map((predictionClass) => [predictionClass, 0])),
  ]));
  const endToEndCounts = { truePositive: 0, falsePositive: 0, falseNegative: 0 };
  const conditionalCounts = { truePositive: 0, falsePositive: 0, falseNegative: 0 };
  let eligibleCount = 0;
  let correctCount = 0;
  let falseAbstentionCount = 0;
  let nodeEndToEndUnitCount = 0;
  let nodeConditionalUnitCount = 0;
  let goldUndeterminedCount = 0;
  let goldUndeterminedPredictedCount = 0;

  goldUnits.forEach((goldUnit) => {
    const key = String(goldUnit?.key || "").trim().toUpperCase();
    const prediction = predictionByKey.get(key);
    const predictedRelation = relationPredictionLabel(prediction?.knowledgeRelation, Boolean(prediction));
    const goldRelation = String(goldUnit?.knowledgeRelation || "").trim();
    if (goldRelation === "undetermined") {
      goldUndeterminedCount += 1;
      if (predictedRelation === "undetermined") goldUndeterminedPredictedCount += 1;
      return;
    }
    if (!RELATION_GOLD_CLASSES.includes(goldRelation)) return;
    eligibleCount += 1;
    confusionMatrix[goldRelation][predictedRelation] += 1;
    if (predictedRelation === goldRelation) correctCount += 1;
    if (predictedRelation === "undetermined") falseAbstentionCount += 1;
    nodeEndToEndUnitCount += 1;
    const expectedNodes = goldRelation === "option_specific" ? knowledgeNodeIdsFor(goldUnit) : [];
    const mappedNodes = predictedRelation === "option_specific"
      ? knowledgeNodeIdsFor(nodeByKey.get(key) || {}) : [];
    const endCounts = nodeCounts(mappedNodes, expectedNodes);
    Object.keys(endToEndCounts).forEach((name) => { endToEndCounts[name] += endCounts[name]; });
    if (goldRelation === "option_specific" && predictedRelation === "option_specific") {
      nodeConditionalUnitCount += 1;
      const conditional = nodeCounts(mappedNodes, expectedNodes);
      Object.keys(conditionalCounts).forEach((name) => { conditionalCounts[name] += conditional[name]; });
    }
  });

  const perClass = Object.fromEntries(RELATION_GOLD_CLASSES.map((className) => [
    className,
    relationClassMetrics(confusionMatrix, className),
  ]));
  const classF1Values = RELATION_GOLD_CLASSES.map((className) => perClass[className].f1).filter((value) => value !== null);
  return {
    applicable: true,
    protocolVersion,
    choiceStructure,
    eligibleCount,
    correctCount,
    accuracy: ratio(correctCount, eligibleCount),
    confusionMatrix,
    perClass,
    macroF1: classF1Values.length ? classF1Values.reduce((sum, value) => sum + value, 0) / classF1Values.length : null,
    questionExact: eligibleCount ? correctCount === eligibleCount : null,
    falseAbstentionCount,
    falseAbstentionRate: ratio(falseAbstentionCount, eligibleCount),
    goldUndetermined: {
      count: goldUndeterminedCount,
      predictedUndeterminedCount: goldUndeterminedPredictedCount,
      recall: ratio(goldUndeterminedPredictedCount, goldUndeterminedCount),
    },
    nodeEndToEnd: nodeMetricsFromCounts(endToEndCounts, nodeEndToEndUnitCount),
    nodeConditional: nodeMetricsFromCounts(conditionalCounts, nodeConditionalUnitCount),
  };
}

function resolveGoldStatus(question, fingerprint, requestedStatus = "auto") {
  const requested = String(requestedStatus || "auto");
  if (!GOLD_STATUSES.has(requested)) throw new Error("blind_replay_gold_status_invalid");
  if (requested !== "auto") return requested;
  const stored = String(question?.goldStatus || fingerprint?.goldStatus || "");
  if (["confirmed", "gold_needs_review"].includes(stored)) return stored;
  return fingerprint?.status === "confirmed" ? "confirmed" : "gold_needs_review";
}

function buildGoldStandard(question, structureState, familyState, options = {}) {
  const bookRecord = (structureState.records || []).find((record) => record.bookId === question.bookId);
  const fingerprint = (bookRecord?.fingerprints || []).find((item) => item.questionId === question.id);
  if (!fingerprint) throw new Error("blind_replay_knowledge_gold_required");
  const goldStatus = resolveGoldStatus(question, fingerprint, options.goldStatus);
  if (goldStatus === "confirmed" && fingerprint.status !== "confirmed") throw new Error("blind_replay_confirmed_knowledge_gold_required");
  const memberships = (familyState.families || []).flatMap((family) => {
    if (family.bookId !== question.bookId || family.status !== "confirmed") return [];
    const member = (family.members || []).find((item) => item.questionId === question.id);
    return member ? [{ family, member }] : [];
  });
  const primaryMembership = memberships.find(({ member }) => member.isPrimary) || memberships[0] || null;
  const nodeMap = new Map((bookRecord.nodes || []).map((node) => [node.id, node]));
  const primaryNodeRole = normalizePrimaryNodeRole(fingerprint.primaryNodeRole);
  const requiredNodeIds = [...new Set([
    ...(primaryNodeRole === "core" ? [fingerprint.primaryNodeId] : []),
    ...(Array.isArray(fingerprint.requiredNodeIds) ? fingerprint.requiredNodeIds : []),
  ].map(String).filter((nodeId) => nodeId && (primaryNodeRole !== "scope_anchor" || nodeId !== String(fingerprint.primaryNodeId || ""))))];
  if (!requiredNodeIds.length) throw new Error("blind_replay_knowledge_gold_required");
  const familySnapshot = ({ family, member }) => {
    const independentMembers = independentFamilyMembers(family, options.questionState);
    const retainedIndependentMembers = independentFamilyMembers(family, options.questionState, [question.id]);
    return {
      id: family.id,
      name: family.name,
      isPrimary: member.isPrimary === true,
      chapter: family.chapter || "",
      primaryKnowledgePoint: family.primaryKnowledgePoint || "",
      knowledgeNodeId: family.knowledgeNodeId || "",
      knowledgePath: family.knowledgePath || "",
      coreKnowledgeNodeId: family.coreKnowledgeNodeId || family.knowledgeNodeId,
      requiredKnowledgeNodeIds: family.requiredKnowledgeNodeIds || [],
      textbookAnchorNodeIds: family.textbookAnchorNodeIds || [family.knowledgeNodeId].filter(Boolean),
      assessmentAction: family.assessmentAction || "",
      inclusionBoundary: family.inclusionBoundary || "",
      exclusionBoundary: family.exclusionBoundary || "",
      focusKey: family.focusKey || "",
      reason: family.reason || "",
      memberQuestionIds: uniqueFamilyMemberQuestionIds(family),
      independentMemberQuestionIds: independentMembers.map((item) => item.questionId),
      independentMemberSignatures: independentMembers.map((item) => item.signature),
      retainedIndependentMemberQuestionIds: retainedIndependentMembers.map((item) => item.questionId),
      retainedIndependentMemberSignatures: retainedIndependentMembers.map((item) => item.signature),
      aliases: familyAliasesFor(familyState, family.id),
      familySetLinks: familySetLinksFor(familyState, family.id),
    };
  };
  const families = memberships.map(familySnapshot);
  const primaryFamily = families.find((family) => family.isPrimary) || families[0] || null;
  const requiredRelatedFamilyIds = families
    .filter((family) => family.id && family.id !== primaryFamily?.id)
    .map((family) => family.id);
  return {
    questionId: question.id,
    bookId: question.bookId,
    goldStatus,
    includedInAccuracy: goldStatus === "confirmed",
    knowledgeFingerprintStatus: fingerprint.status || "",
    primaryNodeId: fingerprint.primaryNodeId,
    primaryNodeRole,
    primaryNodePath: nodeMap.get(fingerprint.primaryNodeId)?.path || fingerprint.knowledgePath || "",
    requiredNodeIds,
    requiredNodes: requiredNodeIds.map((id) => ({
      id,
      title: nodeMap.get(id)?.displayTitle || nodeMap.get(id)?.title || id,
      path: nodeMap.get(id)?.path || "",
    })),
    primaryFamilyId: primaryMembership?.family?.id || "",
    primaryFamilyIndependentMemberCount: primaryFamily?.independentMemberQuestionIds?.length || 0,
    primaryFamilyIndependentMemberQuestionIds: primaryFamily?.independentMemberQuestionIds || [],
    primaryFamilyRetainedIndependentMemberCount: primaryFamily?.retainedIndependentMemberQuestionIds?.length || 0,
    primaryFamilyRetainedIndependentMemberQuestionIds: primaryFamily?.retainedIndependentMemberQuestionIds || [],
    requiredRelatedFamilyIds,
    referenceRelatedFamilyIds: [],
    relatedFamilyRelations: requiredRelatedFamilyIds.map((familyId) => ({
      familyId,
      coverageRole: "required",
      requiredForAnswer: true,
    })),
    familyIds: [primaryFamily?.id, ...requiredRelatedFamilyIds].filter(Boolean),
    allFamilyIds: memberships.map(({ family }) => family.id),
    hiddenGoldFamilyIds: [],
    families,
    primaryFamily,
  };
}

function buildGoldStandardFromFrozenItem(item) {
  if (!item || typeof item !== "object") throw new Error("blind_replay_gold_snapshot_item_invalid");
  const answerKnowledge = item.answerAndEvidence || {};
  const knowledgeGold = item.knowledgeGold || {};
  const familyGold = item.familyGold || {};
  const coreKnowledge = knowledgeGold.coreKnowledge || answerKnowledge.coreKnowledge || {};
  const requiredKnowledge = Array.isArray(knowledgeGold.requiredKnowledge)
    ? knowledgeGold.requiredKnowledge
    : (Array.isArray(answerKnowledge.requiredKnowledge) ? answerKnowledge.requiredKnowledge : []);
  const optionKnowledgeSource = Array.isArray(knowledgeGold.optionKnowledge)
    ? knowledgeGold.optionKnowledge
    : (Array.isArray(answerKnowledge.optionKnowledge) ? answerKnowledge.optionKnowledge : []);
  const optionKnowledge = optionKnowledgeSource
    .map((option, index) => normalizeOptionKnowledge(option, index))
    .filter((option) => option.key);
  const optionKnowledgeProtocolVersion = String(
    knowledgeGold.optionKnowledgeProtocolVersion
      || answerKnowledge.optionKnowledgeProtocolVersion
      || "",
  );
  const choiceStructure = ["direct_options", "composed_options"].includes(
    knowledgeGold.choiceStructure || answerKnowledge.choiceStructure,
  ) ? (knowledgeGold.choiceStructure || answerKnowledge.choiceStructure) : "direct_options";
  const atomicStatements = (choiceStructure === "composed_options"
    ? (knowledgeGold.atomicStatements || answerKnowledge.atomicStatements || []) : [])
    .map((statement, index) => normalizeAtomicStatement(statement, index))
    .filter((statement) => statement.key);
  const optionComposition = (choiceStructure === "composed_options"
    ? (knowledgeGold.optionComposition || answerKnowledge.optionComposition || []) : [])
    .map((composition) => ({
      optionKey: String(composition?.optionKey || "").trim().toUpperCase(),
      atomicKeys: [...new Set((composition?.atomicKeys || []).map((key) => String(key).trim().toUpperCase()).filter(Boolean))],
    })).filter((composition) => composition.optionKey && composition.atomicKeys.length);
  const rawFamilies = (Array.isArray(familyGold.families) ? familyGold.families : []).map(clone);
  const primaryFamilyId = String(familyGold.primaryFamilyId || "");
  const relatedFamilyRelations = relatedFamilyRelationsFor(familyGold);
  const requiredRelatedFamilyIds = relatedFamilyRelations
    .filter((relation) => relation.coverageRole === "required")
    .map((relation) => relation.familyId);
  const referenceRelatedFamilyIds = relatedFamilyRelations
    .filter((relation) => relation.coverageRole === "reference")
    .map((relation) => relation.familyId);
  const relationByFamilyId = new Map(relatedFamilyRelations.map((relation) => [relation.familyId, relation]));
  const families = rawFamilies.map((family) => ({
    ...family,
    isPrimary: family.id === primaryFamilyId,
    ...(family.id !== primaryFamilyId && relationByFamilyId.has(family.id)
      ? {
        coverageRole: relationByFamilyId.get(family.id).coverageRole,
        requiredForAnswer: relationByFamilyId.get(family.id).requiredForAnswer,
      }
      : {}),
  }));
  const existingPrimaryFamily = families.find((family) => family.id === primaryFamilyId) || null;
  const candidateFamily = familyGold.candidateFamily && typeof familyGold.candidateFamily === "object"
    ? clone(familyGold.candidateFamily)
    : null;
  const primaryFamily = existingPrimaryFamily || candidateFamily;
  const primaryNodeId = String(coreKnowledge.id || coreKnowledge.nodeId || "");
  const primaryNodeRole = normalizePrimaryNodeRole(
    knowledgeGold.coreKnowledgeRole || answerKnowledge.coreKnowledgeRole,
  );
  const requiredNodes = requiredKnowledge.map((node) => ({
    id: String(node?.id || node?.nodeId || ""),
    title: String(node?.title || node?.label || ""),
    path: String(node?.path || node?.knowledgePath || ""),
  })).filter((node) => node.id && (primaryNodeRole !== "scope_anchor" || node.id !== primaryNodeId));
  const requiredNodeIds = [...new Set([
    ...(primaryNodeRole === "core" ? [primaryNodeId] : []),
    ...requiredNodes.map((node) => node.id),
  ].filter(Boolean))];
  if (!item.questionId || !primaryNodeId || !requiredNodeIds.length) {
    throw new Error("blind_replay_gold_snapshot_knowledge_required");
  }
  const independentMemberQuestionIds = primaryFamily?.independentMemberQuestionIds || primaryFamily?.memberQuestionIds || [];
  const retainedIndependentMemberQuestionIds = primaryFamily?.retainedIndependentMemberQuestionIds
    || independentMemberQuestionIds.filter((questionId) => questionId !== item.questionId);
  const independentMemberCount = Number(primaryFamily?.independentMemberCount)
    || independentMemberQuestionIds.length;
  const replayMode = String(item.replayMode || familyGold.replayMode || "");
  const includedInAccuracy = typeof item.includedInAccuracy === "boolean"
    ? item.includedInAccuracy : item.goldStatus !== "gold_needs_review";
  return {
    questionId: String(item.questionId),
    bookId: String(item.questionSnapshot?.bookId || ""),
    goldStatus: item.goldStatus === "gold_needs_review" ? "gold_needs_review" : "confirmed",
    includedInAccuracy,
    knowledgeFingerprintStatus: "frozen_gold",
    primaryNodeId,
    primaryNodeRole,
    primaryNodePath: String(coreKnowledge.path || coreKnowledge.title || primaryNodeId),
    requiredNodeIds,
    requiredNodes,
    optionKnowledge,
    optionKnowledgeProtocolVersion,
    choiceStructure,
    atomicStatements,
    optionComposition,
    primaryFamilyId,
    primaryFamilyIndependentMemberCount: independentMemberCount,
    primaryFamilyIndependentMemberQuestionIds: independentMemberQuestionIds,
    primaryFamilyRetainedIndependentMemberCount: retainedIndependentMemberQuestionIds.length
      || Math.max(0, independentMemberCount - 1),
    primaryFamilyRetainedIndependentMemberQuestionIds: retainedIndependentMemberQuestionIds,
    requiredRelatedFamilyIds,
    referenceRelatedFamilyIds,
    relatedFamilyRelations,
    familyIds: [primaryFamilyId, ...requiredRelatedFamilyIds].filter(Boolean),
    allFamilyIds: families.map((family) => family.id).filter(Boolean),
    hiddenGoldFamilyIds: replayMode === "singleton" ? [primaryFamilyId].filter(Boolean) : [],
    families,
    primaryFamily,
    mode: replayMode,
    source: "frozen_snapshot",
  };
}

function frozenQuestionFromItem(item) {
  const question = clone(item.questionSnapshot || {});
  const answerKnowledge = item.answerAndEvidence || {};
  return {
    ...question,
    id: String(item.questionId || question.id || ""),
    // A frozen snapshot intentionally omits live-library metadata. Restore the
    // minimum shell expected by the isolated admin classification route only.
    library: "official",
    status: "official",
    correctAnswer: clone(answerKnowledge.correctAnswer || []),
    referenceAnswer: String(answerKnowledge.referenceAnswer || ""),
    scoringPoints: clone(answerKnowledge.scoringPoints || item.knowledgeGold?.scoringPoints || []),
    answerSource: String(answerKnowledge.answerSource || question.answerSource || "frozen_gold"),
    answerReviewStatus: "verified",
    answerVerified: true,
  };
}

function loadFrozenReplayGold(snapshotPath, questionId) {
  if (!snapshotPath) throw new Error("blind_replay_gold_snapshot_required");
  const loaded = readFrozenGoldSnapshot(snapshotPath, { requireSidecar: true });
  const item = loaded.snapshot.items.find((entry) => String(entry.questionId || "") === String(questionId || ""));
  if (!item) throw new Error("blind_replay_question_not_in_gold_snapshot");
  return {
    ...loaded,
    item: clone(item),
    question: frozenQuestionFromItem(item),
    gold: buildGoldStandardFromFrozenItem(item),
  };
}

function textSimilarity(leftValue, rightValue) {
  const left = normalizeText(leftValue);
  const right = normalizeText(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const grams = (value) => {
    if (value.length < 2) return new Set([...value]);
    return new Set([...Array(value.length - 1)].map((_, index) => value.slice(index, index + 2)));
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  const intersection = [...leftGrams].filter((item) => rightGrams.has(item)).length;
  const union = new Set([...leftGrams, ...rightGrams]).size;
  return union ? intersection / union : 0;
}

const ASSESSMENT_ACTION_RULES = [
  {
    type: "validity_judgement",
    label: "合法性/成立性判断",
    patterns: [
      /合法性|合规性|成立性/u,
      /(?:能否|是否|可否).{0,12}(?:成立|合法|合规|符合|拼合|组合)/u,
      /(?:成立|合法|合规|拼合).{0,8}(?:判断|判定|检验)/u,
    ],
  },
  {
    type: "concept_recognition",
    label: "概念/术语识别",
    patterns: [
      /概念.{0,6}(?:识别|辨认|判定|判断)/u,
      /(?:识别|辨认|判定).{0,6}概念/u,
      /术语.{0,6}(?:识别|辨认|辨析)/u,
      /(?:识别|辨认|辨析).{0,6}术语/u,
      /定义.{0,6}(?:识别|辨认|匹配)/u,
    ],
  },
  {
    type: "correctness_judgement",
    label: "正误判断",
    patterns: [
      /正误/u,
      /(?:说法|表述|选项).{0,8}(?:正确|错误)/u,
      /(?:判断|判定).{0,8}(?:正确|错误)/u,
    ],
  },
  {
    type: "classification",
    label: "分类/归类",
    patterns: [/(?:分类|归类|类别判定|类型判定)/u],
  },
  {
    type: "comparison",
    label: "比较/辨异",
    patterns: [/(?:比较|异同|区别|辨别差异|对比)/u],
  },
  {
    type: "example_generation",
    label: "举例/例证",
    patterns: [/(?:举例|例证|列举)/u],
  },
  {
    type: "causal_explanation",
    label: "解释/说明原因",
    patterns: [/(?:解释|说明|分析).{0,10}(?:原因|依据|为什么)|原因分析/u],
  },
  {
    type: "calculation",
    label: "计算/推算",
    patterns: [/(?:计算|推算|求出|求得)/u],
  },
  {
    type: "notation",
    label: "标注/转写",
    patterns: [/(?:国际音标|注音|音标转写|标注|拼写)/u],
  },
  {
    type: "feature_identification",
    label: "特征/性质识别",
    patterns: [/(?:特征|性质).{0,8}(?:识别|判断|判定|分析)|(?:识别|判断|判定).{0,8}(?:特征|性质)/u],
  },
  {
    type: "application",
    label: "规则/知识应用",
    patterns: [/(?:运用|应用|利用).{0,10}(?:规律|规则|知识|原理)/u],
  },
  {
    type: "generic_judgement",
    label: "一般判断",
    patterns: [/(?:判断|判定|检验)/u],
  },
];

function normalizeAssessmentActionSemantics(value) {
  return normalizeSharedAssessmentActionSemantics(value);
}

function compareAssessmentActions(predictedValue, expectedValue) {
  return compareSharedAssessmentActions(predictedValue, expectedValue, { allowMissingExpected: true });
}

function candidateFamilyFieldDifferences(draft, expectedFamily, comparison) {
  if (!expectedFamily) return [];
  const expectedCoreId = String(expectedFamily.coreKnowledgeNodeId || expectedFamily.knowledgeNodeId || "");
  const expectedRequiredIds = [...new Set([
    expectedCoreId,
    ...(expectedFamily.requiredKnowledgeNodeIds || []),
  ].map(String).filter(Boolean))];
  const expectedAnchorIds = [...new Set((expectedFamily.textbookAnchorNodeIds || [expectedFamily.knowledgeNodeId])
    .map(String).filter(Boolean))];
  const actionComparison = comparison.actionSemantics;
  const boundaryStatus = (predicted, expected, similarity) => {
    if (!String(expected || "").trim()) return "not_frozen";
    if (!String(predicted || "").trim()) return "candidate_missing";
    return similarity >= 0.6 ? "similar" : "different";
  };
  return [
    {
      key: "name",
      label: "题族名称",
      predicted: String(draft.name || ""),
      expected: String(expectedFamily.name || expectedFamily.focusKey || ""),
      status: comparison.nameSimilarity >= 0.6 ? "similar" : "different",
      detail: `文字相似度 ${(comparison.nameSimilarity * 100).toFixed(1)}%`,
    },
    {
      key: "coreKnowledgeNodeId",
      label: "核心知识",
      predicted: String(draft.coreKnowledgeNodeId || ""),
      expected: expectedCoreId,
      status: comparison.coreKnowledgeExact ? "same" : "different",
      detail: "按知识节点比较",
    },
    {
      key: "requiredKnowledgeNodeIds",
      label: "作答必需知识",
      predicted: [...new Set((draft.requiredKnowledgeNodeIds || []).map(String).filter(Boolean))],
      expected: expectedRequiredIds,
      status: comparison.requiredKnowledge.exact ? "same" : "different",
      detail: `F1 ${(comparison.requiredKnowledge.f1 * 100).toFixed(1)}%`,
    },
    {
      key: "textbookAnchorNodeIds",
      label: "教材锚点",
      predicted: [...new Set((draft.textbookAnchorNodeIds || []).map(String).filter(Boolean))],
      expected: expectedAnchorIds,
      status: expectedAnchorIds.length && comparison.textbookAnchors.recall > 0 ? "compatible" : "different",
      detail: `召回率 ${(comparison.textbookAnchors.recall * 100).toFixed(1)}%`,
    },
    {
      key: "assessmentAction",
      label: "考查动作",
      predicted: String(draft.assessmentAction || ""),
      expected: String(expectedFamily.assessmentAction || ""),
      status: actionComparison.match ? "same" : "different",
      detail: `${actionComparison.predicted.label} / ${actionComparison.expected.label}（${actionComparison.method}）`,
    },
    {
      key: "inclusionBoundary",
      label: "纳入边界",
      predicted: String(draft.inclusionBoundary || ""),
      expected: String(expectedFamily.inclusionBoundary || ""),
      status: boundaryStatus(draft.inclusionBoundary, expectedFamily.inclusionBoundary, comparison.inclusionBoundarySimilarity),
      detail: comparison.inclusionBoundarySimilarity === null ? "金标准未冻结" : `文字相似度 ${(comparison.inclusionBoundarySimilarity * 100).toFixed(1)}%`,
    },
    {
      key: "exclusionBoundary",
      label: "排除边界",
      predicted: String(draft.exclusionBoundary || ""),
      expected: String(expectedFamily.exclusionBoundary || ""),
      status: boundaryStatus(draft.exclusionBoundary, expectedFamily.exclusionBoundary, comparison.exclusionBoundarySimilarity),
      detail: comparison.exclusionBoundarySimilarity === null ? "金标准未冻结" : `文字相似度 ${(comparison.exclusionBoundarySimilarity * 100).toFixed(1)}%`,
    },
  ];
}

function evaluateCandidateFamilyDraft(draftValue, expectedFamily = null) {
  const draft = draftValue && typeof draftValue === "object" && !Array.isArray(draftValue) ? draftValue : {};
  const coreKnowledgeNodeId = String(draft.coreKnowledgeNodeId || "");
  const requiredKnowledgeNodeIds = [...new Set((Array.isArray(draft.requiredKnowledgeNodeIds)
    ? draft.requiredKnowledgeNodeIds : []).map(String).filter(Boolean))];
  const textbookAnchorNodeIds = [...new Set((Array.isArray(draft.textbookAnchorNodeIds)
    ? draft.textbookAnchorNodeIds : []).map(String).filter(Boolean))];
  const evidenceChunkIds = [...new Set((Array.isArray(draft.textbookEvidence?.chunkIds)
    ? draft.textbookEvidence.chunkIds : []).map(String).filter(Boolean))];
  const fields = {
    name: Boolean(String(draft.name || "").trim()),
    coreKnowledgeNodeId: Boolean(coreKnowledgeNodeId),
    requiredKnowledgeNodeIds: requiredKnowledgeNodeIds.length > 0 && requiredKnowledgeNodeIds.includes(coreKnowledgeNodeId),
    textbookAnchorNodeIds: textbookAnchorNodeIds.length > 0,
    assessmentAction: Boolean(String(draft.assessmentAction || "").trim()),
    inclusionBoundary: Boolean(String(draft.inclusionBoundary || "").trim()),
    exclusionBoundary: Boolean(String(draft.exclusionBoundary || "").trim()),
    textbookEvidence: evidenceChunkIds.length > 0 && Boolean(String(draft.textbookEvidence?.summary || "").trim()),
  };
  const requiredComplete = [
    fields.name,
    fields.coreKnowledgeNodeId,
    fields.requiredKnowledgeNodeIds,
    fields.textbookAnchorNodeIds,
    fields.assessmentAction,
    fields.textbookEvidence,
  ].every(Boolean);
  const boundaryComplete = fields.inclusionBoundary && fields.exclusionBoundary;
  const complete = Object.values(fields).every(Boolean);
  if (!expectedFamily) {
    return {
      proposed: Boolean(draftValue),
      fields,
      complete,
      requiredComplete,
      boundaryComplete,
      semanticComparable: false,
      semanticMatch: null,
      coreKnowledgeExact: null,
      requiredKnowledge: null,
      textbookAnchors: null,
      nameSimilarity: null,
      actionSimilarity: null,
      actionSemanticMatch: null,
      actionSemantics: null,
      inclusionBoundarySimilarity: null,
      exclusionBoundarySimilarity: null,
      fieldDifferences: [],
    };
  }
  const expectedCoreId = String(expectedFamily.coreKnowledgeNodeId || expectedFamily.knowledgeNodeId || "");
  const expectedRequiredIds = [...new Set([
    expectedCoreId,
    ...(expectedFamily.requiredKnowledgeNodeIds || []),
  ].map(String).filter(Boolean))];
  const expectedAnchorIds = [...new Set((expectedFamily.textbookAnchorNodeIds || [expectedFamily.knowledgeNodeId])
    .map(String).filter(Boolean))];
  const requiredKnowledge = setMetrics(requiredKnowledgeNodeIds, expectedRequiredIds);
  const textbookAnchors = setMetrics(textbookAnchorNodeIds, expectedAnchorIds);
  const nameSimilarity = textSimilarity(draft.name, expectedFamily.name || expectedFamily.focusKey);
  const actionSemantics = compareAssessmentActions(draft.assessmentAction, expectedFamily.assessmentAction);
  const actionSimilarity = actionSemantics.similarity;
  const inclusionBoundarySimilarity = expectedFamily.inclusionBoundary
    ? textSimilarity(draft.inclusionBoundary, expectedFamily.inclusionBoundary)
    : null;
  const exclusionBoundarySimilarity = expectedFamily.exclusionBoundary
    ? textSimilarity(draft.exclusionBoundary, expectedFamily.exclusionBoundary)
    : null;
  const coreKnowledgeExact = coreKnowledgeNodeId === expectedCoreId;
  const anchorsCompatible = expectedAnchorIds.length ? textbookAnchors.recall > 0 : textbookAnchorNodeIds.length > 0;
  const semanticMatch = requiredComplete
    && coreKnowledgeExact
    && requiredKnowledge.exact
    && anchorsCompatible
    && actionSemantics.match;
  const evaluation = {
    proposed: Boolean(draftValue),
    fields,
    complete,
    requiredComplete,
    boundaryComplete,
    semanticComparable: true,
    semanticMatch,
    coreKnowledgeExact,
    requiredKnowledge,
    textbookAnchors,
    nameSimilarity,
    actionSimilarity,
    actionSemanticMatch: actionSemantics.match,
    actionSemantics,
    inclusionBoundarySimilarity,
    exclusionBoundarySimilarity,
  };
  evaluation.fieldDifferences = candidateFamilyFieldDifferences(draft, expectedFamily, evaluation);
  return evaluation;
}

function buildEvaluation(result, gold, options = {}) {
  const verification = result?.agent2Verification || {};
  const mode = String(options.mode || gold?.mode || "mature");
  const unmatchedGoldStatus = UNMATCHED_GOLD_STATUSES.has(options.unmatchedGoldStatus)
    ? options.unmatchedGoldStatus
    : "unreviewed";
  const resultStatus = String(result?.status || "");
  const jobStatus = String(options.job?.status || "");
  const providerFailureTask = (Array.isArray(options.modelTasks) ? options.modelTasks : []).find((task) => {
    if (String(task?.status || "") !== "failed") return false;
    const category = String(task?.errorCategory || "");
    const code = String(task?.errorCode || "");
    if (["output_format", "validation"].includes(category)) return false;
    return ["timeout", "network", "provider", "upstream", "rate_limit", "authentication"].includes(category)
      || /^(?:provider|upstream|network)_/u.test(code);
  });
  const terminalAgent3ContractFailure = verification.agent3ContractStatus === "failed";
  const executionFailed = Boolean(providerFailureTask || terminalAgent3ContractFailure
    || [resultStatus, jobStatus].some((status) => ["failed", "interrupted"].includes(status)));
  const executionFailureCode = String(providerFailureTask?.errorCode
    || (terminalAgent3ContractFailure ? "agent3_contract_failed" : "")
    || result?.errorCode || result?.error
    || options.job?.errorCode || options.job?.error || resultStatus || jobStatus || "unknown").trim();
  const predictedRelatedFamilyIds = [...new Set((verification.relatedFamilyIds || []).filter(Boolean))];
  // 归属集合比对必须与 expected 侧对称：expected 侧为 primaryFamilyId + requiredRelatedFamilyIds
  // （只含参与知识覆盖的必需关联族），因此 predicted 侧也只能取 coverageRole=required 的关联族。
  // reference（参考关联）按合同"不参与覆盖、贡献必须为空"，且对人工审核有信息价值；
  // 把它计入会把合同允许的行为误判为"多带"（实测 V4 有 4/20 题因此被记为不通过）。
  const relatedRoleByFamilyId = new Map((verification.relatedFamilyRelations || [])
    .map((relation) => [String(relation.familyId || ""), String(relation.coverageRole || "")]));
  const predictedCoveringRelatedFamilyIds = predictedRelatedFamilyIds
    .filter((familyId) => relatedRoleByFamilyId.get(String(familyId)) !== "reference");
  const predictedFamilyIds = mode === "mature"
    ? [verification.primaryFamilyId, ...predictedCoveringRelatedFamilyIds].filter(Boolean)
    : predictedCoveringRelatedFamilyIds;
  const expectedFamilyIds = mode === "mature"
    ? [gold.primaryFamilyId, ...(gold.requiredRelatedFamilyIds || [])].filter(Boolean)
    : (gold.requiredRelatedFamilyIds || []);
  const requiredKnowledge = setMetrics(verification.requiredNodeIds, gold.requiredNodeIds);
  const predictedPrimaryNodeRole = normalizePrimaryNodeRole(verification.primaryNodeRole);
  const expectedPrimaryNodeRole = normalizePrimaryNodeRole(gold.primaryNodeRole);
  const primaryNodeRoleExact = predictedPrimaryNodeRole === expectedPrimaryNodeRole;
  const coreKnowledgeExact = String(verification.primaryNodeId || "") === String(gold.primaryNodeId || "")
    && primaryNodeRoleExact;
  const familyMemberships = setMetrics(predictedFamilyIds, expectedFamilyIds);
  const candidateFamilyDraft = evaluateCandidateFamilyDraft(verification.candidateFamilyDraft, gold.primaryFamily || null);
  const optionKnowledge = buildOptionKnowledgeEvaluation(result, gold);
  const includedInAccuracy = !executionFailed
    && gold.includedInAccuracy !== false
    && gold.goldStatus !== "gold_needs_review"
    && (mode !== "unmatched" || unmatchedGoldStatus === "confirmed");
  const hiddenGoldFamilyIds = gold.hiddenGoldFamilyIds?.length
    ? gold.hiddenGoldFamilyIds
    : (mode === "singleton" ? [gold.primaryFamilyId].filter(Boolean) : []);
  const hiddenGoldFamilyIdReturned = mode !== "mature"
    && [verification.primaryFamilyId, ...predictedRelatedFamilyIds]
      .filter(Boolean).some((familyId) => hiddenGoldFamilyIds.includes(familyId));
  const primaryFamilyExact = mode === "mature"
    ? String(verification.primaryFamilyId || "") === String(gold.primaryFamilyId || "")
    : null;
  const expectedCandidateSuccess = mode === "mature"
    ? null
    : candidateFamilyDraft.requiredComplete && candidateFamilyDraft.semanticMatch !== false;
  const modelGeneralizationSuccess = mode === "mature"
    ? Boolean(coreKnowledgeExact
      && requiredKnowledge.exact && primaryFamilyExact && familyMemberships.exact)
    : Boolean(coreKnowledgeExact
      && requiredKnowledge.exact && expectedCandidateSuccess && familyMemberships.exact
      && !hiddenGoldFamilyIdReturned);
  return {
    mode,
    goldStatus: gold.goldStatus || "confirmed",
    unmatchedGoldStatus,
    executionFailed,
    executionFailureCode: executionFailed ? executionFailureCode : "",
    assessmentStatus: executionFailed
      ? "unassessed"
      : (gold.goldStatus === "gold_needs_review" ? "diagnostic_only" : "assessed"),
    includedInAccuracy,
    accuracyExclusionReason: includedInAccuracy
      ? ""
      : (executionFailed
        ? `execution_failed/${executionFailureCode}`
        : (gold.goldStatus === "gold_needs_review"
          ? "gold_needs_review"
          : (mode === "unmatched" && unmatchedGoldStatus !== "confirmed"
            ? "unmatched_gold_unreviewed"
            : (gold.includedInAccuracy === false ? "gold_excluded_from_accuracy" : "unmatched_gold_unreviewed")))),
    coreKnowledgeExact,
    primaryNodeRoleExact,
    predictedPrimaryNodeRole,
    expectedPrimaryNodeRole,
    requiredKnowledge,
    optionKnowledge,
    primaryFamilyExact,
    primaryFamilyMetricApplicable: mode === "mature",
    familyMemberships: { ...familyMemberships, applicable: true },
    familyDecision: verification.familyDecision || "",
    unresolved: ["unable", "missing_node"].includes(verification.decision)
      || ["unresolved"].includes(verification.familyDecision),
    candidateFamilyDraftProposed: Boolean(verification.candidateFamilyDraft),
    candidateFamilyDraft,
    hiddenGoldFamilyIdReturned,
    modelGeneralizationSuccess,
    countedResult: includedInAccuracy ? modelGeneralizationSuccess : null,
  };
}

function parseArgs(argv) {
  const options = {
    questionId: DEFAULT_QUESTION_ID,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputRoot: "",
    goldSnapshotPath: "",
    replayContextPath: "",
    mode: "auto",
    goldStatus: "auto",
    unmatchedGoldStatus: "unreviewed",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--question-id") options.questionId = String(argv[++index] || "");
    else if (argument === "--gold-snapshot") options.goldSnapshotPath = String(argv[++index] || "");
    else if (argument === "--replay-context") options.replayContextPath = String(argv[++index] || "");
    else if (argument === "--timeout-ms") options.timeoutMs = Math.max(1000, Number(argv[++index]) || DEFAULT_TIMEOUT_MS);
    else if (argument === "--output-root") options.outputRoot = String(argv[++index] || "");
    else if (argument === "--mode") options.mode = String(argv[++index] || "");
    else if (argument === "--gold-status") options.goldStatus = String(argv[++index] || "");
    else if (argument === "--unmatched-gold") options.unmatchedGoldStatus = String(argv[++index] || "");
    else if (argument === "--help") options.help = true;
    else throw new Error(`blind_replay_argument_unknown:${argument}`);
  }
  if (!options.questionId && !options.help) throw new Error("blind_replay_question_id_required");
  if (!options.help && !options.goldSnapshotPath) throw new Error("blind_replay_gold_snapshot_required");
  if (!options.help && !options.replayContextPath) throw new Error("blind_replay_context_required");
  if (!REPLAY_MODES.has(options.mode)) throw new Error("blind_replay_mode_invalid");
  if (!GOLD_STATUSES.has(options.goldStatus)) throw new Error("blind_replay_gold_status_invalid");
  if (!UNMATCHED_GOLD_STATUSES.has(options.unmatchedGoldStatus)) throw new Error("blind_replay_unmatched_gold_status_invalid");
  return options;
}

function parseProviderCredentials(value) {
  if (!value) return {};
  if (typeof value === "object") return clone(value);
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new Error("blind_replay_provider_credentials_invalid");
  }
}

function injectProviderCredentials(aiConfig, explicitCredentials, environment = process.env) {
  const next = clone(aiConfig || {});
  const credentials = parseProviderCredentials(
    explicitCredentials === undefined ? environment.BLIND_REPLAY_PROVIDER_CREDENTIALS_JSON : explicitCredentials,
  );
  next.providers = (next.providers || []).map((provider) => {
    const configured = credentials[provider.id];
    const credential = typeof configured === "string" ? { apiKey: configured } : (configured || {});
    const apiKey = String(credential.apiKey || environment[provider.credentialRef] || "").trim();
    return {
      ...provider,
      ...(credential.baseUrl ? { baseUrl: String(credential.baseUrl) } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  });
  const requiredProviderIds = new Set([
    "knowledge_feature_extraction",
    "knowledge_hierarchy_navigation",
    "knowledge_global_recovery",
    "knowledge_batch_verification",
    "knowledge_batch_verification_fallback",
  ].flatMap((sceneId) => {
    const route = next.routes?.[sceneId];
    return route?.mode === "provider" && route.providerId ? [String(route.providerId)] : [];
  }));
  requiredProviderIds.forEach((providerId) => {
    const provider = next.providers.find((entry) => String(entry?.id || "") === providerId);
    if (!provider) throw new Error(`blind_replay_provider_missing:${providerId}`);
    if (!String(provider.apiKey || "").trim()) throw new Error(`blind_replay_provider_credentials_missing:${providerId}`);
  });
  return next;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `http_${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(server.address());
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForJob(baseUrl, jobId, timeoutMs, onProgress = () => {}) {
  const startedAt = Date.now();
  let lastProgressKey = "";
  while (Date.now() - startedAt <= timeoutMs) {
    const payload = await fetchJson(`${baseUrl}/api/admin/knowledge-classification/jobs/${encodeURIComponent(jobId)}`);
    // 诊断用：BLIND_REPLAY_VERBOSE=1 时逐轮打印作业状态，便于区分“慢”与“卡住”。
    if (process.env.BLIND_REPLAY_VERBOSE === "1") {
      process.stdout.write(`[盲测][轮询 ${Math.round((Date.now() - startedAt) / 1000)}s] status=${payload.job.status}`
        + ` stage=${payload.job.stage || "-"} a1=${payload.job.agent1Processed ?? "-"} a2=${payload.job.agent2Processed ?? "-"}`
        + ` depth=${payload.job.currentDepth ?? "-"} msg=${payload.job.progressMessage || ""}\n`);
    }
    const progressKey = [
      payload.job.status,
      payload.job.agent1Processed,
      payload.job.agent2Processed,
      payload.job.currentDepth,
      payload.job.progressMessage,
    ].join("|");
    if (progressKey !== lastProgressKey) {
      lastProgressKey = progressKey;
      onProgress(payload.job);
    }
    if (TERMINAL_JOB_STATUSES.has(payload.job.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("blind_replay_timeout");
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function mark(value) {
  return value ? "通过" : "未通过";
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function firstTaskFailureReason(task) {
  const summary = task?.inputSummary && typeof task.inputSummary === "object" ? task.inputSummary : {};
  return String(summary.firstFailure || summary.firstFailureReason || summary.priorContractError
    || summary.contractFailureReason || summary.fallbackReason || task?.errorCode || "").trim();
}

function summarizeReplayRetries(modelTasks = [], result = {}) {
  const tasks = (Array.isArray(modelTasks) ? modelTasks : []).map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const leftTime = Number(left.task?.startedAt);
      const rightTime = Number(right.task?.startedAt);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
      return left.index - right.index;
    }).map(({ task }) => task);
  const providerRetryCount = tasks.reduce((total, task) => (
    total + Math.max(0, Number(task?.inputSummary?.providerRetryCount ?? task?.inputSummary?.retryCount) || 0)
  ), 0);

  const contractAttemptsByStep = new Map();
  tasks.forEach((task, index) => {
    if (String(task?.sceneId || "") !== "knowledge_hierarchy_navigation") return;
    const summary = task?.inputSummary || {};
    const attempt = Number(summary.contractAttempt ?? summary.attempt);
    if (!Number.isFinite(attempt) || attempt < 1) return;
    const key = [summary.questionId || "question", summary.depth || summary.currentDepth || `task-${index}`].join("|");
    contractAttemptsByStep.set(key, Math.max(contractAttemptsByStep.get(key) || 1, attempt));
  });
  const taskContractRetries = [...contractAttemptsByStep.values()]
    .reduce((total, attempts) => total + Math.max(0, attempts - 1), 0);

  const navigationDiagnostics = Array.isArray(result?.agent2NavigationDiagnostics)
    ? result.agent2NavigationDiagnostics
    : (Array.isArray(result?.navigationDiagnostics) ? result.navigationDiagnostics : []);
  const diagnosticAttemptsByStep = new Map();
  navigationDiagnostics.forEach((diagnostic, index) => {
    const attempt = Math.max(1, Number(diagnostic?.contractAttempt ?? diagnostic?.attempt) || 1);
    const key = [diagnostic?.questionId || result?.questionId || "question", diagnostic?.depth || `diagnostic-${index}`].join("|");
    diagnosticAttemptsByStep.set(key, Math.max(diagnosticAttemptsByStep.get(key) || 1, attempt));
  });
  const diagnosticContractRetries = [...diagnosticAttemptsByStep.values()]
    .reduce((total, attempts) => total + Math.max(0, attempts - 1), 0);
  const trajectoryContractRetries = (result?.agent1Trajectories || []).flatMap((trajectory) => trajectory?.steps || [])
    .reduce((total, step) => total + Math.max(0, Number(step?.contractValidation?.attempts || 1) - 1), 0);
  const navigationConstraintRetries = Math.max(taskContractRetries, diagnosticContractRetries, trajectoryContractRetries);
  const agent3ConstraintRetries = tasks.filter((task) => (
    String(task?.sceneId || "") === "knowledge_batch_verification"
    && (String(task?.inputSummary?.attemptKind || "") === "contract_repair"
      || Number(task?.inputSummary?.contractAttempt) > 1)
  )).length;
  const constraintRetryCount = navigationConstraintRetries + agent3ConstraintRetries;

  const fallbackAttemptCount = tasks.filter((task) => {
    const summary = task?.inputSummary || {};
    const attemptKind = String(summary.attemptKind || "");
    const attemptIndex = Number(summary.attemptIndex);
    return ["fallback", "fallback_scoped"].includes(attemptKind)
      || (String(task?.sceneId || "") === "knowledge_global_recovery" && Number.isFinite(attemptIndex) && attemptIndex > 1)
      || summary.isFallback === true;
  }).length;

  const taskFailure = tasks.map(firstTaskFailureReason).find(Boolean) || "";
  const diagnosticFailure = navigationDiagnostics
    .map((diagnostic) => String(diagnostic?.errorCode || diagnostic?.firstFailureCode || "").trim()).find(Boolean) || "";
  const trajectoryFailure = (result?.agent1Trajectories || []).flatMap((trajectory) => trajectory?.steps || [])
    .map((step) => String(step?.contractValidation?.firstFailureCode || "").trim()).find(Boolean) || "";
  const firstFailureReason = taskFailure || diagnosticFailure || trajectoryFailure
    || String(result?.errorCode || result?.error || "").trim();
  return {
    providerRetryCount,
    constraintRetryCount,
    fallbackAttemptCount,
    totalRetryCount: providerRetryCount + constraintRetryCount + fallbackAttemptCount,
    firstFailureReason,
  };
}

function buildMarkdownReport(report) {
  const { question, gold, result, evaluation, maskAudit, leakageAudit, isolation, modelTasks, modePlan } = report;
  const verification = result?.agent2Verification || {};
  const nodeById = new Map(report.knowledgeNodes.map((node) => [node.id, node]));
  const familyById = new Map(report.questionFamilies.map((family) => [family.id, family]));
  const nodeLabel = (id) => nodeById.get(id)?.path || nodeById.get(id)?.displayTitle || nodeById.get(id)?.title || id || "未给出";
  const familyLabel = (id) => familyById.get(id)?.name || id || "未给出";
  const trajectories = (result?.agent1Trajectories || []).flatMap((trajectory, trajectoryIndex) => (
    (trajectory.steps || []).map((step, stepIndex) => `| ${trajectoryIndex + 1}.${stepIndex + 1} | ${markdownCell(nodeLabel(step.parentNodeId) || "根节点")} | ${markdownCell((step.candidateNodeIds || []).map(nodeLabel).join(" / "))} | ${markdownCell(step.decision)} | ${markdownCell((step.selectedNodeIds || []).map(nodeLabel).join(" / ") || step.stopReason)} | ${markdownCell(step.reason)} |`)
  ));
  const options = (question.options || []).map((option) => `- ${option.key}. ${option.text}`).join("\n");
  const taskRows = modelTasks.map((task) => {
    const usage = task.usage && Number.isFinite(Number(task.usage.totalTokens))
      ? String(task.usage.totalTokens)
      : "供应商未返回/成本不可计算";
    const duration = Number.isFinite(Number(task.durationMs)) ? `${task.durationMs} ms` : "未返回";
    const inputSummary = task.inputSummary || {};
    const attemptParts = [];
    const providerRetries = Math.max(0, Number(inputSummary.providerRetryCount ?? inputSummary.retryCount) || 0);
    if (providerRetries) attemptParts.push(`供应商重试 ${providerRetries}`);
    const contractAttempt = Number(inputSummary.contractAttempt ?? inputSummary.attempt);
    if (String(task.sceneId || "") === "knowledge_hierarchy_navigation" && Number.isFinite(contractAttempt)) {
      attemptParts.push(`约束尝试 ${contractAttempt}`);
    }
    if (inputSummary.attemptKind || Number.isFinite(Number(inputSummary.attemptIndex))) {
      attemptParts.push(`恢复尝试 ${inputSummary.attemptIndex || "-"}/${inputSummary.attemptKind || "未标明"}`);
    }
    return `| ${markdownCell(task.sceneId)} | ${markdownCell(task.model)} | ${markdownCell(task.status)} | ${markdownCell(attemptParts.join("；") || "无重试")} | ${markdownCell(firstTaskFailureReason(task) || "-")} | ${usage} | ${duration} |`;
  }).join("\n");
  const evidenceRows = (report.evidence || []).map((item) => `| ${markdownCell(item.id)} | ${item.printedPageStart || "-"} | ${markdownCell(item.catalogPath || item.bodyHeading || "")} | ${markdownCell(String(item.excerpt || "").slice(0, 240))} |`).join("\n");
  const modeLabels = {
    mature: "成熟题族留一",
    singleton: "单题题族整族隐藏",
    unmatched: "无匹配建族",
  };
  const accuracyLabel = evaluation.includedInAccuracy
    ? "计入准确率"
    : (String(evaluation.accuracyExclusionReason || "").startsWith("execution_failed/")
      ? `未评估：执行失败（${evaluation.executionFailureCode || "unknown"}），未产生完整分类结果`
      : (evaluation.accuracyExclusionReason === "gold_needs_review"
        ? "gold_needs_review，仅保留诊断结果，不计准确率"
        : "尚未人工确认当前无等价题族，仅保留诊断结果，不计准确率"));
  const executionUnassessed = evaluation.executionFailed === true || evaluation.assessmentStatus === "unassessed";
  const goldDiagnosticOnly = evaluation.goldStatus === "gold_needs_review"
    || evaluation.accuracyExclusionReason === "gold_needs_review";
  const metricResult = (value) => {
    if (executionUnassessed) return "未评估";
    if (goldDiagnosticOnly) return value ? "字段一致" : "字段有差异";
    return mark(value);
  };
  const primaryFamilyMetric = executionUnassessed
    ? "执行未完成，未评估"
    : (evaluation.primaryFamilyMetricApplicable
    ? `${mark(evaluation.primaryFamilyExact)}；预测：${markdownCell(familyLabel(verification.primaryFamilyId))}；金标准：${markdownCell(familyLabel(gold.primaryFamilyId))}`
    : `不适用。本模式隐藏原题族，预测原题族 ID 不算泛化；模型返回：${markdownCell(familyLabel(verification.primaryFamilyId))}`);
  const familySetMetric = executionUnassessed
    ? "执行未完成，未评估"
    : (evaluation.familyMemberships.applicable
    ? `${mark(evaluation.familyMemberships.exact)}；F1 ${pct(evaluation.familyMemberships.f1)}，Jaccard ${pct(evaluation.familyMemberships.jaccard)}`
    : "不适用，改评候选新题族草稿");
  const optionMetric = evaluation.optionKnowledge || { applicable: false };
  const optionRelationResult = executionUnassessed
    ? "未评估"
    : (optionMetric.applicable ? `${pct(optionMetric.accuracy)}；macro-F1 ${pct(optionMetric.macroF1)}` : "不适用（旧协议）");
  const optionNodeResult = executionUnassessed
    ? "未评估"
    : (optionMetric.applicable
      ? `端到端 F1 ${pct(optionMetric.nodeEndToEnd?.f1)}；关系命中后 F1 ${pct(optionMetric.nodeConditional?.f1)}`
      : "不适用（旧协议）");
  const draft = verification.candidateFamilyDraft || {};
  const draftEvaluation = evaluation.candidateFamilyDraft || {};
  const retrySummary = report.retrySummary || summarizeReplayRetries(modelTasks, result);
  const draftFieldRows = Object.entries(draftEvaluation.fields || {})
    .map(([key, value]) => `| ${markdownCell(key)} | ${value ? "完整" : "缺失"} |`).join("\n");
  const comparisonStatusLabels = {
    same: "一致",
    compatible: "兼容",
    similar: "表述相近",
    different: "有差异",
    candidate_missing: "候选缺失",
    not_frozen: "金标准未冻结",
  };
  const comparisonValue = (item, value) => {
    const values = Array.isArray(value) ? value : [value];
    const nodeFields = new Set(["coreKnowledgeNodeId", "requiredKnowledgeNodeIds", "textbookAnchorNodeIds"]);
    const displayed = nodeFields.has(item.key) ? values.map(nodeLabel) : values.map((entry) => String(entry || ""));
    return displayed.filter(Boolean).join("；") || "未给出";
  };
  const goldReviewDifferenceRows = (draftEvaluation.fieldDifferences || []).map((item) => (
    `| ${markdownCell(item.label)} | ${markdownCell(comparisonValue(item, item.predicted))} | ${markdownCell(comparisonValue(item, item.expected))} | ${comparisonStatusLabels[item.status] || markdownCell(item.status)} | ${markdownCell(item.detail || "-")} |`
  )).join("\n");
  const candidateSemanticResult = executionUnassessed
    ? "未评估"
    : (goldDiagnosticOnly
      ? "待教研复核"
      : (draftEvaluation.semanticComparable ? mark(draftEvaluation.semanticMatch) : "无冻结题族语义可比较"));
  const candidateSemanticDetail = executionUnassessed
    ? "执行未完成，没有形成可评估的候选题族草稿"
    : (goldDiagnosticOnly
      ? "金标准尚未冻结，只展示候选值与当前记录的字段差异"
      : `核心知识 ${draftEvaluation.coreKnowledgeExact === null ? "-" : mark(draftEvaluation.coreKnowledgeExact)}；动作语义 ${draftEvaluation.actionSemanticMatch === null || draftEvaluation.actionSemanticMatch === undefined ? "-" : mark(draftEvaluation.actionSemanticMatch)}；动作文字相似度 ${draftEvaluation.actionSimilarity === null || draftEvaluation.actionSimilarity === undefined ? "-" : pct(draftEvaluation.actionSimilarity)}`);
  return `# AI 盲测回放报告

- 回放编号：${report.replayId}
- 被测题：${question.id}
- 教材：${question.bookId}
- 请求模式：${modePlan.requestedMode}
- 实际模式：${modeLabels[modePlan.mode] || modePlan.mode}
- 金标准状态：${gold.goldStatus}（${accuracyLabel}）
${modePlan.mode === "unmatched" ? `- 无匹配金标准：${modePlan.unmatchedGoldStatus || "unreviewed"}` : ""}
- 运行结果：${result?.status || report.error || "未知"}
- 评估状态：${executionUnassessed ? "未评估（技术或执行失败）" : (goldDiagnosticOnly ? "仅诊断，等待教研复核" : "已评估")}
- 重试与备用尝试：共 ${retrySummary.totalRetryCount} 次（供应商瞬时重试 ${retrySummary.providerRetryCount}；非法候选约束重试 ${retrySummary.constraintRetryCount}；恢复备用尝试 ${retrySummary.fallbackAttemptCount}）
- 首次失败原因：${retrySummary.firstFailureReason || "无"}
- 正式数据隔离：${isolation.formalStateUnchanged ? "通过，运行前后 11 个正式文件 SHA-256 均未变化" : "未通过，检测到正式文件内容变化"}
- Agent 4：未运行。盲测停在人工审核前，不用隐藏金标准冒充人工确认。

## 1. 被测题

${question.stem}

${options}

- 来源答案/平台核验答案：${(question.correctAnswer || []).join("、") || "无"}
- 答案依据状态：${question.answerReviewStatus || "未标明"} / ${question.answerSource || "未标明"}

## 2. 人工金标准

- 知识焦点：${gold.primaryNodePath}（${normalizePrimaryNodeRole(gold.primaryNodeRole) === "scope_anchor" ? "范围锚点" : "作答核心"}）
- 最小充分知识集：${gold.requiredNodes.map((node) => node.path || node.title).join("；")}
- 主题族：${gold.families.find((family) => family.isPrimary)?.name || gold.primaryFamilyId || "人工确认当前无匹配题族"}
- 作答必需关联题族：${gold.families.filter((family) => family.coverageRole === "required").map((family) => family.name || family.id).join("；") || "无"}
- 普通关联题族：${gold.families.filter((family) => family.coverageRole === "reference").map((family) => family.name || family.id).join("；") || "无"}
- 独立成员数：${gold.primaryFamilyIndependentMemberCount || 0}

## 3. 遮蔽审计

| 遮蔽项 | 数量 |
| --- | ---: |
| 现有知识指纹 | ${maskAudit.removedFingerprints} |
| 现有题族成员关系 | ${maskAudit.removedFamilyMemberships} |
| 自身确认案例 | ${maskAudit.removedCases} |
| 自身纠错记录 | ${maskAudit.removedCorrections} |
| 自身反馈消息 | ${maskAudit.removedMessages} |
| 自身审核事件 | ${maskAudit.removedReviewEvents} |
| 由本题或本题反馈直接产生的规则 | ${maskAudit.removedRules} |
| 整体隐藏的题族定义 | ${maskAudit.removedFamilyDefinitions} |
| 隐藏题族别名 | ${maskAudit.removedFamilyAliases} |
| 隐藏题族集链接 | ${maskAudit.removedFamilySetLinks} |
| 隐藏历史题族定义 | ${maskAudit.removedHistoricalFamilyDefinitions} |

保留了题干、材料、全部选项、来源答案或平台核验答案、教材正文、知识树、其他题目的已确认经验。${modePlan.mode === "mature" ? "成熟题族保留定义及至少一道其他独立成员。" : "本模式已隐藏金标准题族定义及其别名、题族集链接，模型只能提出候选新题族。"}

### 泄漏审计

| 检查项 | 结果 |
| --- | --- |
| 目标题成员关系残留 | ${leakageAudit.remainingTargetMemberships} |
| 隐藏题族定义残留 | ${leakageAudit.remainingHiddenDefinitions} |
| 隐藏题族别名残留 | ${leakageAudit.remainingAliases} |
| 隐藏题族集链接残留 | ${leakageAudit.remainingFamilySetLinks} |
| 历史题族定义残留 | ${leakageAudit.remainingHistoricalDefinitions} |
| 题目人工分类标签残留 | ${leakageAudit.remainingQuestionClassificationLabels || 0} |
| 目标题知识指纹残留 | ${leakageAudit.remainingFingerprints || 0} |
| 自身经验记录残留 | ${leakageAudit.remainingSelfExperience || 0} |
| 成熟题族留存的其他成员 | ${leakageAudit.retainedOtherPrimaryMembers} |
| 候选上下文审计 | ${leakageAudit.candidateContextClean ? "通过" : "未通过"} |

## 4. Agent 1 特征提取

- 来源：${result?.agent1FeatureHandoff?.source || "未知"}
- 模型：${result?.agent1FeatureHandoff?.model || "未记录"}
- 题目模式：${result?.agent1Features?.questionMode || "未给出"}
- 核心关键词：${(result?.agent1Features?.coreKeywords || []).join("、") || "未给出"}
- 主知识提示：${(result?.agent1Features?.primaryKnowledgeHints || []).join("、") || "未给出"}
- 副知识提示：${(result?.agent1Features?.secondaryKnowledgeHints || []).join("、") || "未给出"}
- 最小充分知识判断依据：${result?.agent1Features?.primaryBasis || "未给出"}
- 跨题族概率：${pct(result?.agent1Features?.crossFamilyProbability)}
- 调用深度：${result?.agent1Features?.callDepth || 0}

## 5. Agent 2 分层归类轨迹

| 步骤 | 当前层 | 五候选 | 决策 | 选择/停止原因 | 理由 |
| --- | --- | --- | --- | --- | --- |
${trajectories.join("\n") || "| - | - | - | - | - | 无轨迹 |"}

## 6. Agent 3 教材与题族核验

- 决策：${verification.decision || "未给出"}
- 知识焦点：${nodeLabel(verification.primaryNodeId)}（${normalizePrimaryNodeRole(verification.primaryNodeRole) === "scope_anchor" ? "范围锚点" : "作答核心"}）
- 最小充分知识集：${(verification.requiredNodeIds || []).map(nodeLabel).join("；") || "未给出"}
- 题族决策：${verification.familyDecision || "未给出"}
- 建议主题族：${familyLabel(verification.primaryFamilyId)}
- 建议作答必需关联题族：${(verification.relatedFamilyIds || []).map(familyLabel).join("；") || "无"}
- 置信度：${pct(verification.confidence)}
- 题族相似性依据：${verification.familySimilarityReason || "未给出"}
- 教材核验理由：${verification.reason || "未给出"}
- 不确定性：${verification.uncertainty || "无"}

### 候选新题族草稿

- 名称：${draft.name || "未提出"}
- 核心知识：${nodeLabel(draft.coreKnowledgeNodeId)}
- 作答必需知识：${(draft.requiredKnowledgeNodeIds || []).map(nodeLabel).join("；") || "未给出"}
- 教材锚点：${(draft.textbookAnchorNodeIds || []).map(nodeLabel).join("；") || "未给出"}
- 考查动作：${draft.assessmentAction || "未给出"}
- 纳入边界：${draft.inclusionBoundary || "未给出"}
- 排除边界：${draft.exclusionBoundary || "未给出"}
- 教材证据说明：${draft.textbookEvidence?.summary || "未给出"}

| 草稿字段 | 状态 |
| --- | --- |
${draftFieldRows || "| 全部字段 | 未提出草稿 |"}

| 教材片段 | 印刷页 | 目录 | 摘录 |
| --- | ---: | --- | --- |
${evidenceRows || "| - | - | - | 未引用有效教材片段 |"}

## 7. 与金标准对比

| 指标 | 结果 | 细节 |
| --- | --- | --- |
| 核心知识 exact | ${metricResult(evaluation.coreKnowledgeExact)} | 预测：${markdownCell(nodeLabel(verification.primaryNodeId))}（${evaluation.predictedPrimaryNodeRole === "scope_anchor" ? "范围锚点" : "作答核心"}）；金标准：${markdownCell(gold.primaryNodePath)}（${evaluation.expectedPrimaryNodeRole === "scope_anchor" ? "范围锚点" : "作答核心"}） |
| 最小充分知识集 exact | ${metricResult(evaluation.requiredKnowledge.exact)} | F1 ${pct(evaluation.requiredKnowledge.f1)}，Jaccard ${pct(evaluation.requiredKnowledge.jaccard)} |
| 选项知识关系 | ${optionRelationResult} | 整题完全命中：${optionMetric.questionExact === null || optionMetric.questionExact === undefined ? "不适用" : mark(optionMetric.questionExact)}；确定样本错误弃权率 ${pct(optionMetric.falseAbstentionRate)} |
| 选项知识节点 | ${optionNodeResult} | Gold 暂无法判断 ${optionMetric.goldUndetermined?.count || 0} 项，单独诊断不进入主分母 |
| 主题族 exact | ${executionUnassessed ? "未评估" : (evaluation.primaryFamilyMetricApplicable ? metricResult(evaluation.primaryFamilyExact) : "不适用")} | ${primaryFamilyMetric} |
| 作答必需题族集合 exact | ${executionUnassessed ? "未评估" : (evaluation.familyMemberships.applicable ? metricResult(evaluation.familyMemberships.exact) : "不适用")} | ${familySetMetric} |
| 无法确定/待归组 | ${executionUnassessed ? "未评估" : (evaluation.unresolved ? "是" : "否")} | ${verification.uncertainty || "-"} |
| 候选新题族必需字段 | ${executionUnassessed ? "未评估" : (draftEvaluation.requiredComplete ? "完整" : "不完整")} | ${verification.candidateFamilyDraft?.name || "-"} |
| 候选新题族边界（诊断） | ${executionUnassessed ? "未评估" : (draftEvaluation.boundaryComplete ? "完整" : "待补充")} | 不影响本轮题族裁决 |
| ${goldDiagnosticOnly ? "候选新题族字段差异" : "候选新题族语义"} | ${candidateSemanticResult} | ${candidateSemanticDetail} |
| 是否计入准确率 | ${evaluation.includedInAccuracy ? "是" : "否"} | ${evaluation.accuracyExclusionReason || "-"} |

${goldDiagnosticOnly && !executionUnassessed ? `### 待复核字段差异

当前人工记录尚未冻结。下表只呈现候选输出与当前记录的逐字段差异，不给出候选题族合格与否的结论。

| 字段 | 候选输出 | 当前人工记录 | 差异状态 | 比较依据 |
| --- | --- | --- | --- | --- |
${goldReviewDifferenceRows || "| - | - | - | 无可比较的冻结题族 | 当前没有题族字段金标准 |"}
` : ""}

## 8. 模型调用

| 场景 | 模型 | 状态 | 重试/尝试 | 首次失败原因 | Token | 耗时 |
| --- | --- | --- | --- | --- | ---: | ---: |
${taskRows || "| - | - | - | 无重试 | - | 0 | 0 ms |"}

## 9. 结论

${!evaluation.includedInAccuracy
    ? (String(evaluation.accuracyExclusionReason || "").startsWith("execution_failed/")
      ? `本次因基础设施或供应商执行失败（${evaluation.executionFailureCode || "unknown"}），评估状态为“未评估”；不得记作模型分类错误。`
      : (evaluation.accuracyExclusionReason === "gold_needs_review"
        ? "本题金标准标记为 gold_needs_review，本次只展示逐字段差异并等待教研复核，不作候选题族合格性结论，也不进入模型准确率。"
        : "本题尚未获得人工“当前无等价题族”确认，本次无匹配建族输出只保留给教研复核，不进入模型准确率。"))
    : (evaluation.modelGeneralizationSuccess
      ? `${modeLabels[modePlan.mode] || modePlan.mode}通过：模型在对应遮蔽条件下完成了可计分的独立判断。`
      : `${modeLabels[modePlan.mode] || modePlan.mode}未通过。应把偏差视为真实盲测结果，优先检查最小充分知识、候选路径和题族语义；不得恢复隐藏题族或金标准来制造命中。`)}
`;
}

function scopedExperienceState(state, bookId) {
  const masked = clone(state);
  ["messages", "rules", "cases", "corrections", "ruleExceptions", "reviewEvents", "dossierSuggestions"].forEach((key) => {
    masked[key] = (Array.isArray(masked[key]) ? masked[key] : []).filter((item) => !item.bookId || item.bookId === bookId);
  });
  return masked;
}

async function runBlindReplay(options = {}) {
  const projectRoot = path.resolve(__dirname, "../..");
  const runtimeDir = path.join(projectRoot, ".runtime");
  const startedAt = new Date();
  const replayId = `blind-replay-${timestampForPath(startedAt)}`;
  const outputRoot = options.outputRoot
    ? path.resolve(options.outputRoot)
    : path.resolve(projectRoot, "..", "outputs", "AI盲测回放");
  const beforeHashes = await hashFormalState(runtimeDir);

  process.stdout.write("[盲测] 正在校验冻结金标快照和教材上下文...\n");
  const frozen = loadFrozenReplayGold(options.goldSnapshotPath, options.questionId);
  const replayContext = readReplayContext(options.replayContextPath, frozen);
  const contextPreflight = buildReplayContextPreflight(frozen, replayContext, {
    expectedCount: frozen.snapshot.items.length,
  });
  if (!contextPreflight.eligibleForReplay) {
    const error = new Error("blind_replay_context_preflight_failed");
    error.preflightReport = contextPreflight;
    throw error;
  }
  const frozenMode = frozen.gold.mode;
  if (options.mode && options.mode !== "auto" && options.mode !== frozenMode) {
    throw new Error("blind_replay_mode_differs_from_gold_snapshot");
  }
  if (options.goldStatus && options.goldStatus !== "auto" && options.goldStatus !== frozen.gold.goldStatus) {
    throw new Error("blind_replay_gold_status_differs_from_snapshot");
  }
  const itemContext = replayContext.data.itemContexts?.[options.questionId];
  if (!itemContext) throw new Error("blind_replay_item_context_missing");
  const sharedContext = replayContext.data.sharedByBook?.[itemContext.sharedBookId];
  if (!sharedContext) throw new Error("blind_replay_shared_book_context_missing");
  const scopedQuestions = clone(itemContext.input?.questions || []);
  const rawQuestion = scopedQuestions.find((question) => String(question?.id || "") === String(options.questionId || ""));
  if (!rawQuestion) throw new Error("blind_replay_context_question_missing");
  const maskedFamilyState = clone(itemContext.input?.questionFamilies || {});
  const maskedStructureState = clone(itemContext.input?.knowledgeStructures || {});
  const maskedExperienceState = clone(itemContext.input?.knowledgeClassificationExperience || {});
  const gold = frozen.gold;
  const modePlan = clone(itemContext.modePlan || {});
  if (modePlan.mode !== frozenMode) throw new Error("blind_replay_context_mode_differs_from_gold_snapshot");
  const outputDir = path.join(outputRoot, `${timestampForPath(startedAt)}-${modePlan.mode}-${options.questionId}`);
  const scopedTextbookKnowledge = clone(sharedContext.textbookKnowledge || []);
  const scopedTextbookCatalogs = clone(sharedContext.textbookCatalogs || []);
  const scopedDossierState = clone(sharedContext.knowledgeDossiers || {});
  const aiConfig = injectProviderCredentials(
    replayContext.data.executionConfig,
    options.providerCredentials,
    options.environment || process.env,
  );
  const leakageAudit = clone(itemContext.maskAudit || {});
  const maskAudit = clone(itemContext.maskAudit || {});

  process.stdout.write(`[盲测] 模式：${modePlan.requestedMode} -> ${modePlan.mode}；金标准：${gold.goldStatus}${gold.includedInAccuracy ? "（计分）" : "（不计分）"}。\n`);
  process.stdout.write(`[盲测] 遮蔽完成：知识指纹 ${maskAudit.removedFingerprints} 条、题族关系 ${maskAudit.removedFamilyMemberships} 条、题族定义 ${maskAudit.removedFamilyDefinitions} 条、自身案例 ${maskAudit.removedCases} 条、来源规则 ${maskAudit.removedRules} 条。\n`);
  if (!leakageAudit.candidateContextClean) throw new Error("blind_replay_leakage_audit_failed");

  const aiTaskStore = createMemoryAiTaskStore([]);
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore({ jobs: [], results: [] });
  const operationLogStore = createMemoryAdminOperationStore([]);
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(aiConfig),
    aiTaskStore,
    questionStore: createMemoryQuestionStore(scopedQuestions),
    questionFamilyStore: createMemoryQuestionFamilyStore(maskedFamilyState),
    knowledgeStructureStore: createMemoryKnowledgeStructureStore(maskedStructureState),
    textbookKnowledgeStore: createMemoryTextbookKnowledgeStore(scopedTextbookKnowledge),
    textbookCatalogStore: createMemoryTextbookCatalogStore(scopedTextbookCatalogs),
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(maskedExperienceState),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(scopedDossierState),
    knowledgeClassificationStore,
    operationLogStore,
    classificationCommitStore: createMemoryClassificationCommitStore(),
  });

  let finalPayload;
  try {
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    process.stdout.write(`[盲测] 隔离服务已启动（随机临时端口 ${address.port}），开始 Agent 1-3 回放。\n`);
    const created = await fetchJson(`${baseUrl}/api/admin/knowledge-classification/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookId: rawQuestion.bookId,
        questionIds: [rawQuestion.id],
        limit: 1,
        reclassifyConfirmed: true,
      }),
    });
    finalPayload = await waitForJob(baseUrl, created.job.id, options.timeoutMs, (job) => {
      process.stdout.write(`[盲测] ${job.progressMessage || job.status}\n`);
    });
  } finally {
    await close(server);
  }

  const result = finalPayload.results.find((item) => item.questionId === rawQuestion.id)
    || knowledgeClassificationStore.resultForQuestion(finalPayload.job.id, rawQuestion.id);
  if (!result) throw new Error("blind_replay_result_missing");
  const modelTasks = aiTaskStore.list({ limit: 100 }).map((task) => ({
    id: task.id,
    sceneId: task.sceneId,
    providerId: task.providerId,
    providerName: task.providerName,
    model: task.model,
    status: task.status,
    startedAt: task.startedAt,
    usage: task.usage,
    durationMs: task.durationMs,
    inputSummary: task.inputSummary,
    errorCode: task.errorCode,
    errorCategory: task.errorCategory,
    failureStage: task.failureStage,
  }));
  const evaluation = buildEvaluation(result, gold, {
    mode: modePlan.mode,
    unmatchedGoldStatus: modePlan.unmatchedGoldStatus,
    job: finalPayload.job,
    modelTasks,
  });
  const afterHashes = await hashFormalState(runtimeDir);
  const changedFormalFiles = FORMAL_STATE_FILES.filter((fileName) => beforeHashes[fileName] !== afterHashes[fileName]);
  const record = maskedStructureState.records.find((item) => item.bookId === rawQuestion.bookId);
  const familyRecords = (maskedFamilyState.families || []).filter((family) => family.bookId === rawQuestion.bookId);
  const textbookRecord = scopedTextbookKnowledge[0] || {};
  const chunkMap = new Map((textbookRecord.chunks || []).map((chunk) => [chunk.id, chunk]));
  const evidence = (result.agent2Verification?.evidenceChunkIds || []).map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
    id: chunk.id,
    printedPageStart: chunk.printedPageStart,
    printedPageEnd: chunk.printedPageEnd,
    pdfPageStart: chunk.pdfPageStart,
    pdfPageEnd: chunk.pdfPageEnd,
    catalogPath: chunk.catalogPath,
    bodyHeading: chunk.bodyHeading,
    excerpt: String(chunk.retrievalText || chunk.text || "").slice(0, 1200),
  }));
  const retrySummary = summarizeReplayRetries(modelTasks, result);
  const report = {
    schemaVersion: 2,
    replayId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    question: {
      id: rawQuestion.id,
      bookId: rawQuestion.bookId,
      type: rawQuestion.type,
      stem: rawQuestion.stem,
      material: rawQuestion.material || "",
      options: rawQuestion.options || [],
      correctAnswer: rawQuestion.correctAnswer || [],
      referenceAnswer: rawQuestion.referenceAnswer || "",
      answerSource: rawQuestion.answerSource || "",
      answerReviewStatus: rawQuestion.answerReviewStatus || "",
    },
    mode: modePlan.mode,
    requestedMode: modePlan.requestedMode,
    modePlan,
    goldStatus: gold.goldStatus,
    goldSnapshot: {
      snapshotId: frozen.snapshot.snapshotId,
      version: frozen.snapshot.version,
      filePath: frozen.filePath,
      fileSha256: frozen.fileSha256,
      contentSha256: frozen.contentSha256,
      questionVersion: rawQuestion.version,
    },
    replayContext: {
      contextId: replayContext.document.contextId,
      version: replayContext.document.version,
      filePath: replayContext.filePath,
      fileSha256: replayContext.fileSha256,
      contentSha256: replayContext.contentSha256,
      contextDataSha256: replayContext.contextDataSha256,
      bindingId: replayContext.document.bindingId,
      bindingFileSha256: replayContext.bindingFileSha256,
      preflightStatus: contextPreflight.status,
      modelCallsDuringPreflight: contextPreflight.modelCallsPerformed,
    },
    unmatchedGoldStatus: modePlan.unmatchedGoldStatus,
    gold,
    maskAudit,
    leakageAudit,
    job: finalPayload.job,
    result,
    evaluation,
    evidence,
    knowledgeNodes: record?.nodes || [],
    questionFamilies: familyRecords.map((family) => ({ id: family.id, name: family.name })),
    modelTasks,
    retrySummary,
    agent4: {
      status: "not_run",
      reason: "Agent 4 requires a real human confirmation or correction; blind replay does not auto-apply hidden gold.",
    },
    isolation: {
      mode: "memory_stores_random_port",
      formalStateUnchanged: changedFormalFiles.length === 0,
      changedFormalFiles,
      beforeHashes,
      afterHashes,
      operationLogCount: operationLogStore.list({ limit: 100 }).items.length,
    },
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const rawPath = path.join(outputDir, "回放原始结果.json");
  const reportPath = path.join(outputDir, "回放报告.md");
  fs.writeFileSync(rawPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(reportPath, buildMarkdownReport(report), "utf8");

  if (evaluation.executionFailed) {
    process.stdout.write(`[盲测] 执行未完成（${evaluation.executionFailureCode || "unknown"}），本轮分类结果未评估且不计准确率。\n`);
  } else {
    process.stdout.write(`[盲测] 完成。核心知识：${mark(evaluation.coreKnowledgeExact)}；最小充分知识集：${mark(evaluation.requiredKnowledge.exact)}；主题族：${evaluation.primaryFamilyMetricApplicable ? mark(evaluation.primaryFamilyExact) : "不适用（评估候选建族）"}。\n`);
  }
  if (modePlan.expectsCandidateFamilyDraft) {
    const draftSummary = evaluation.executionFailed
      ? "未评估"
      : (evaluation.goldStatus === "gold_needs_review"
        ? "只展示与当前人工记录的字段差异，等待教研复核"
        : `必需字段 ${mark(evaluation.candidateFamilyDraft.requiredComplete)}；边界 ${evaluation.candidateFamilyDraft.boundaryComplete ? "完整" : "待补充（不影响裁决）"}；语义 ${evaluation.candidateFamilyDraft.semanticComparable ? mark(evaluation.candidateFamilyDraft.semanticMatch) : "仅校验完整性"}`);
    process.stdout.write(`[盲测] 候选新题族：${draftSummary}。\n`);
  }
  process.stdout.write(`[盲测] 重试与备用尝试：${retrySummary.totalRetryCount} 次；首次失败原因：${retrySummary.firstFailureReason || "无"}。\n`);
  process.stdout.write(`[盲测] 正式数据隔离：${report.isolation.formalStateUnchanged ? "通过" : `未通过（${changedFormalFiles.join("、")}）`}。\n`);
  process.stdout.write(`[盲测] 报告：${reportPath}\n`);
  return { report, reportPath, rawPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("用法：node scripts/classification/run-classification-blind-replay.js --gold-snapshot 冻结快照.json --replay-context 回放上下文C1.json --question-id ID [--timeout-ms 毫秒] [--output-root 目录]\n");
    return;
  }
  await runBlindReplay(options);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[盲测] 失败：${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_QUESTION_ID,
  FORMAL_STATE_FILES,
  buildFamilyLeakageAudit,
  buildEvaluation,
  buildGoldStandard,
  buildGoldStandardFromFrozenItem,
  buildOptionKnowledgeEvaluation,
  buildMarkdownReport,
  buildReplayModePlan,
  compareAssessmentActions,
  evaluateCandidateFamilyDraft,
  familySemanticSignature,
  frozenQuestionFromItem,
  independentFamilyMembers,
  injectProviderCredentials,
  loadFrozenReplayGold,
  hashFormalState,
  normalizeAssessmentActionSemantics,
  parseArgs,
  parseProviderCredentials,
  questionContentSignature,
  questionStemCore,
  resolveReplayMode,
  runBlindReplay,
  sanitizeExperienceState,
  sanitizeKnowledgeStructureState,
  sanitizeQuestionFamilyState,
  sanitizeQuestionForBlindReplay,
  setMetrics,
  summarizeReplayRetries,
};
