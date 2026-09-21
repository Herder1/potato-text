const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildQuestionFamilyCatalogProjection,
} = require("../../apps/api/src/question-family-catalog-projection");
const {
  CORE_KNOWLEDGE_ROLES,
} = require("../../apps/api/src/classification-gold-review-store");

const DEFAULT_LIMIT_PER_MODE = 12;
const MODES = ["mature", "singleton", "unmatched"];
const SOURCE_FILES = [
  "questions.json",
  "question-families.json",
  "knowledge-structures.json",
  "textbook-catalogs.json",
  "knowledge-classification-experience.json",
  "knowledge-dossiers.json",
];
const SOURCE_VERIFIED_ANSWER_TYPES = new Set(["pdf_answer", "team_verified", "community_consensus"]);
const CHOICE_TYPES = new Set(["single_choice", "multiple_choice", "judgment"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || "")).filter(Boolean))];
}

function normalizePrimaryNodeRole(value) {
  const role = String(value || "").trim();
  return CORE_KNOWLEDGE_ROLES.has(role) ? role : "core";
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

function questionStemCore(question) {
  return normalizeText(String(question?.stem || "")
    .replace(/^[（(【\[][^）)】\]]{0,100}[）)】\]]\s*/u, "")
    .replace(/[（(]\s*[）)]\s*$/u, ""));
}

function questionContentSignature(question) {
  const optionText = asArray(question?.options)
    .map((option) => `${String(option?.key || "")}:${String(option?.text || "")}`)
    .join("\u0001");
  return crypto.createHash("sha256").update([
    String(question?.type || ""),
    normalizeText(question?.material),
    questionStemCore(question),
    normalizeText(optionText),
  ].join("\u0000")).digest("hex");
}

function isActiveOfficialQuestion(question) {
  return Boolean(question
    && question.id
    && question.library === "official"
    && question.status !== "offline"
    && !question.mergedIntoQuestionId
    && !question.merge?.targetQuestionId);
}

function questionHasCompletePrompt(question) {
  if (!String(question?.stem || question?.material || "").trim()) return false;
  const options = asArray(question?.options).filter((option) => String(option?.text || "").trim());
  if (CHOICE_TYPES.has(String(question?.type || "")) || asArray(question?.options).length) {
    return options.length >= 2;
  }
  return true;
}

function answerReviewSummary(question) {
  const verified = question?.answerReviewStatus === "verified" && question?.answerVerified === true;
  const source = String(question?.answerSource || "missing");
  const sourceVerified = verified && SOURCE_VERIFIED_ANSWER_TYPES.has(source);
  return {
    status: verified ? "verified" : String(question?.answerReviewStatus || "unreviewed"),
    verified,
    source,
    authority: sourceVerified
      ? "verified_source"
      : (verified ? "verified_platform" : "unverified"),
    usableForBlindReplay: verified,
    aiOriginNeedsAttention: verified && source === "ai_supplement",
  };
}

function optionJudgmentQuestion(question) {
  if (asArray(question?.options).filter((option) => String(option?.text || "").trim()).length < 2) return false;
  const stem = normalizeText(question?.stem);
  return /(?:下列|以下|下面).*(?:正确|错误|不正确|有误|无误|属于|不属于|包括|不包括)|哪(?:一)?(?:个|项).*(?:正确|错误)|说法.*(?:正确|错误)/u.test(stem);
}

function knowledgeCoverage(question, fingerprint) {
  const primaryNodeRole = normalizePrimaryNodeRole(fingerprint?.primaryNodeRole);
  const primaryNodeId = String(fingerprint?.primaryNodeId || "");
  const requiredNodeIds = uniqueStrings([
    ...(primaryNodeRole === "core" ? [primaryNodeId] : []),
    ...asArray(fingerprint?.requiredNodeIds),
  ]).filter((nodeId) => primaryNodeRole !== "scope_anchor" || nodeId !== primaryNodeId);
  const scope = !fingerprint || !requiredNodeIds.length
    ? "unknown"
    : ((fingerprint.crossKnowledge === true
      || String(fingerprint.span || "").startsWith("cross")
      || requiredNodeIds.length > 1)
      ? "cross_knowledge"
      : "single_knowledge");
  return {
    primaryNodeRole,
    requiredNodeIds,
    knowledgeScope: scope,
    optionDriven: asArray(question?.options).filter((option) => String(option?.text || "").trim()).length >= 2,
    optionJudgment: optionJudgmentQuestion(question),
    tags: [scope, ...(optionJudgmentQuestion(question) ? ["option_judgment"] : [])].filter((item) => item !== "unknown"),
  };
}

function confirmedCatalogNodeIds(catalog) {
  if (!catalog || catalog.status !== "confirmed") return [];
  return uniqueStrings(asArray(catalog.confirmed?.nodes).map((node) => node?.id));
}

function preferredFingerprint(record, questionId) {
  const fingerprints = asArray(record?.fingerprints).filter((item) => item?.questionId === questionId);
  return fingerprints.sort((left, right) => {
    const rank = { confirmed: 0, suggested: 1, pending_review: 2, rejected: 3 };
    return (rank[left?.status] ?? 9) - (rank[right?.status] ?? 9)
      || Number(right?.updatedAt || right?.questionVersion || 0) - Number(left?.updatedAt || left?.questionVersion || 0);
  })[0] || null;
}

function normalizeLegacyFamilyFacts(families) {
  return asArray(families).map((family) => {
    const sourceMembers = asArray(family?.members);
    const fallbackPrototypeIndex = sourceMembers.some((member) => member?.role === "prototype")
      ? -1
      : sourceMembers.findIndex((member) => member?.isPrimary === true);
    const prototypeIndex = fallbackPrototypeIndex >= 0
      ? fallbackPrototypeIndex
      : (sourceMembers.length ? 0 : -1);
    return {
      ...family,
      members: sourceMembers.map((member, index) => ({
        ...member,
        role: member?.role || (index === prototypeIndex ? "prototype" : "similar"),
        reviewStatus: member?.reviewStatus
          || (family?.status === "confirmed" ? "confirmed" : "pending_fit"),
      })),
    };
  });
}

function createFamilyStatistics(families, activeQuestionMap) {
  const result = new Map();
  asArray(families).forEach((family) => {
    const members = asArray(family?.members);
    const storedIds = uniqueStrings(members.map((member) => member?.questionId));
    const confirmedMembers = family?.status === "confirmed"
      ? members.filter((member) => member?.reviewStatus === "confirmed")
      : [];
    const activeIds = uniqueStrings(confirmedMembers.map((member) => member?.questionId))
      .filter((questionId) => activeQuestionMap.has(questionId));
    const signatures = new Map();
    activeIds.forEach((questionId) => {
      const signature = questionContentSignature(activeQuestionMap.get(questionId));
      const current = signatures.get(signature) || [];
      current.push(questionId);
      signatures.set(signature, current);
    });
    result.set(String(family?.id || ""), {
      storedMemberCount: storedIds.length,
      storedTopicMemberCount: uniqueStrings(confirmedMembers
        .filter((member) => member?.isPrimary === true)
        .map((member) => member?.questionId)).length,
      activeMemberCount: activeIds.length,
      independentMemberCount: signatures.size,
      duplicateContentGroups: [...signatures.values()].filter((ids) => ids.length > 1),
      activeIds,
      signatures,
    });
  });
  return result;
}

function familyMemberSummary(family, statistics, question) {
  const targetSignature = questionContentSignature(question);
  const remainingIds = statistics.activeIds.filter((questionId) => questionId !== question.id);
  const remainingSignatures = new Set(remainingIds.map((questionId) => {
    for (const [signature, ids] of statistics.signatures.entries()) {
      if (ids.includes(questionId)) return signature;
    }
    return "";
  }).filter(Boolean));
  const remainingNovelSignatures = new Set([...remainingSignatures].filter((signature) => signature !== targetSignature));
  return {
    id: family.id,
    name: family.name || "",
    status: family.status || "",
    source: family.source || "",
    knowledgePath: family.knowledgePath || family.chapter || "",
    coreKnowledgeNodeId: family.coreKnowledgeNodeId || family.knowledgeNodeId || "",
    requiredKnowledgeNodeIds: uniqueStrings(family.requiredKnowledgeNodeIds),
    textbookAnchorNodeIds: uniqueStrings(family.textbookAnchorNodeIds || [family.knowledgeNodeId]),
    assessmentAction: family.assessmentAction || "",
    reviewInvalidationReason: family.reviewInvalidationReason || "",
    reviewedBy: family.reviewedBy || "",
    reviewedAt: Number(family.reviewedAt) || 0,
    storedMemberCount: statistics.storedMemberCount,
    storedTopicMemberCount: statistics.storedTopicMemberCount,
    activeMemberCount: statistics.activeMemberCount,
    independentMemberCount: statistics.independentMemberCount,
    remainingMemberCountAfterLeaveOne: remainingIds.length,
    remainingIndependentMemberCountAfterLeaveOne: remainingSignatures.size,
    remainingNovelIndependentMemberCountAfterLeaveOne: remainingNovelSignatures.size,
  };
}

function createDuplicateIndex(questions) {
  const bySignature = new Map();
  asArray(questions).forEach((question) => {
    const signature = questionContentSignature(question);
    const current = bySignature.get(signature) || [];
    current.push(question.id);
    bySignature.set(signature, current);
  });
  return bySignature;
}

function createDossierNodeIndex(dossierState) {
  const index = new Map();
  asArray(dossierState?.dossiers).forEach((dossier) => {
    asArray(dossier?.occurrences).forEach((occurrence) => {
      if (!occurrence?.nodeId) return;
      const current = index.get(String(occurrence.nodeId)) || [];
      current.push({ dossier, occurrence });
      index.set(String(occurrence.nodeId), current);
    });
  });
  return index;
}

function dossierEvidenceSummary(nodeIds, dossierNodeIndex) {
  const matches = new Map();
  uniqueStrings(nodeIds).forEach((nodeId) => {
    asArray(dossierNodeIndex.get(nodeId)).forEach(({ dossier, occurrence }) => {
      const current = matches.get(dossier.id) || { dossier, occurrences: [] };
      current.occurrences.push(occurrence);
      matches.set(dossier.id, current);
    });
  });
  return [...matches.values()].map(({ dossier, occurrences }) => ({
    id: dossier.id,
    name: dossier.canonicalName || "",
    status: dossier.status || "",
    claimCount: asArray(dossier.claims).length,
    evidencedClaimCount: asArray(dossier.claims).filter((claim) => asArray(claim?.evidence).length).length,
    occurrencePaths: uniqueStrings(occurrences.map((occurrence) => occurrence.path)),
    printedPages: uniqueStrings(occurrences.flatMap((occurrence) => [
      occurrence.printedPageStart,
      occurrence.printedPageEnd,
    ].filter((page) => page !== undefined && page !== null)).map(String)),
  })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function experienceLeakSummary(experienceState, question) {
  const collections = ["messages", "cases", "corrections", "ruleExceptions", "reviewEvents", "dossierSuggestions"];
  const directItems = [];
  const feedbackIds = new Set();
  const resultIds = new Set();
  collections.forEach((key) => {
    asArray(experienceState?.[key]).forEach((item) => {
      if (String(item?.questionId || item?.sourceQuestionId || "") !== String(question.id)) return;
      directItems.push({ collection: key, id: item.id || "" });
      if (key === "messages" && item?.id) feedbackIds.add(String(item.id));
      if (item?.resultId) resultIds.add(String(item.resultId));
    });
  });
  const stem = questionStemCore(question);
  const sourceRuleIds = asArray(experienceState?.rules).filter((rule) => {
    if (String(rule?.sourceQuestionId || "") === String(question.id)) return true;
    if (resultIds.has(String(rule?.sourceResultId || ""))) return true;
    const ruleFeedbackIds = uniqueStrings([rule?.sourceFeedbackId, ...asArray(rule?.sourceFeedbackIds)]);
    if (ruleFeedbackIds.some((id) => feedbackIds.has(id))) return true;
    if (stem.length < 8) return false;
    const ruleText = normalizeText([
      rule?.title,
      rule?.statement,
      ...asArray(rule?.triggerTerms),
      ...asArray(rule?.positiveExamples),
      ...asArray(rule?.negativeExamples),
    ].filter(Boolean).join("\n"));
    return ruleText.includes(stem);
  }).map((rule) => rule.id || "");
  return {
    directItemCount: directItems.length,
    directItems,
    sourceRuleCount: sourceRuleIds.length,
    sourceRuleIds,
  };
}

function answerReferenceMentionsExistingLabels(question, familyReferences, fingerprint) {
  const answerText = normalizeText(question?.referenceAnswer);
  if (!answerText) return [];
  const labels = uniqueStrings([
    ...asArray(familyReferences).flatMap((family) => [family.name, family.assessmentAction]),
    fingerprint?.primaryKnowledgePoint,
    fingerprint?.knowledgePath?.split(">").pop(),
  ]).filter((label) => normalizeText(label).length >= 3);
  return labels.filter((label) => answerText.includes(normalizeText(label)));
}

function leakageRiskSummary({
  question,
  mode,
  familyReferences,
  fingerprint,
  duplicateQuestionIds,
  experienceLeaks,
  answerReview,
}) {
  const items = [];
  const add = (code, severity, detail, mitigation, blocksRecommendation = false) => {
    items.push({ code, severity, detail, mitigation, blocksRecommendation });
  };
  if (String(question.chapter || "").trim()
    || asArray(question.knowledgePoints).length
    || String(question.primaryKnowledgePoint || "").trim()
    || asArray(question.subKnowledgePoints).length) {
    add("current_question_labels", "medium", "题目仍带当前章节或知识标签。", "回放前清空题目章节、主副知识点与知识标签。");
  }
  if (fingerprint) {
    add("knowledge_fingerprint", fingerprint.status === "confirmed" ? "high" : "medium", `存在 ${fingerprint.status || "unknown"} 知识指纹。`, "回放前移除被测题知识指纹及人工覆盖。");
  }
  if (familyReferences.length) {
    add("target_family_membership", "high", `题目当前关联 ${familyReferences.length} 个有效确认主题族。`, "回放前移除被测题的全部题族成员关系和成员修订号。");
  }
  if (mode === "singleton") {
    add("singleton_family_context", "high", "唯一主题族没有第二个独立成员，保留题族定义会直接泄漏人工建族结论。", "整族隐藏名称、定义、锚点、别名和题族集关系，再评估候选新题族草稿。");
  }
  if (duplicateQuestionIds.length) {
    add("duplicate_question_content", "high", `另有 ${duplicateQuestionIds.length} 道活动题与本题题干、材料和选项完全等价。`, "正式回放前合并重复题或同时遮蔽等价题及其经验。", true);
  }
  if (experienceLeaks.directItemCount || experienceLeaks.sourceRuleCount) {
    add("self_experience", "high", `自身经验 ${experienceLeaks.directItemCount} 条，直接来源规则 ${experienceLeaks.sourceRuleCount} 条。`, "回放前移除自身案例、反馈、纠错、审核事件和直接派生规则。");
  }
  const invalidatedFamilies = familyReferences.filter((family) => family.reviewInvalidationReason);
  if (invalidatedFamilies.length) {
    add("family_review_invalidated", "high", `有 ${invalidatedFamilies.length} 个参考题族在变更后尚未重新确认。`, "先独立复核人工参考关系；复核前只可观察，不计分。", true);
  }
  if (answerReview.aiOriginNeedsAttention) {
    add("ai_origin_answer", "medium", "当前平台已核验答案最初来自 AI 补充。", "冻结人工核验依据并在报告中单独标明答案来源。", false);
  }
  const answerLabelMatches = answerReferenceMentionsExistingLabels(question, familyReferences, fingerprint);
  if (answerLabelMatches.length) {
    add("answer_label_overlap", "low", `合法保留的已核验解析直接出现现有标签：${answerLabelMatches.join("、")}。`, "答案仍可按 DEC-026 保留，但结果解释需注明其提示强度。");
  }
  const rank = { low: 1, medium: 2, high: 3 };
  const level = items.reduce((current, item) => (rank[item.severity] > rank[current] ? item.severity : current), "low");
  return {
    level,
    items,
    blocksRecommendation: items.some((item) => item.blocksRecommendation),
  };
}

function referenceGate(mode, familyReferences, fingerprint) {
  const base = {
    automatedGoldDeclared: false,
    scoringEligible: false,
  };
  if (mode === "unmatched") {
    return {
      ...base,
      status: "explicit_human_no_match_gold_required",
      requirement: "必须由人工在运行前确认没有等价既有题族、冻结教材证据和候选新题族预期；否则只观察，不计分。",
    };
  }
  return {
    ...base,
    status: "independent_human_freeze_required",
    requirement: fingerprint?.status === "confirmed" && familyReferences.every((family) => !family.reviewInvalidationReason)
      ? "现有关系可作为独立复核材料，但仍须在运行前由人工冻结，选择器不会自动宣称金标成立。"
      : "现有知识或题族参考尚不稳定，须先人工复核；复核前只观察，不计分。",
  };
}

function modeForQuestion(topicFamilyReferences) {
  if (!topicFamilyReferences.length) return "unmatched";
  if (topicFamilyReferences.length !== 1) return "ambiguous";
  return topicFamilyReferences[0].independentMemberCount >= 2 ? "mature" : "singleton";
}

function recommendationSummary({ question, mode, answerReview, fingerprint, familyReferences, leakageRisk }) {
  const reasons = [];
  let score = 0;
  const completePrompt = questionHasCompletePrompt(question);
  if (completePrompt) {
    score += 20;
    reasons.push("题干与作答内容完整");
  }
  if (answerReview.authority === "verified_source") {
    score += 20;
    reasons.push("答案为已核验来源答案");
  } else if (answerReview.authority === "verified_platform") {
    score += 12;
    reasons.push("答案已由平台核验");
  }
  if (fingerprint?.status === "confirmed") {
    score += 15;
    reasons.push("存在已确认知识指纹供人工复核");
  } else if (fingerprint) {
    score += 3;
    reasons.push("存在未确认知识候选");
  }
  if (mode !== "unmatched" && familyReferences.every((family) => !family.reviewInvalidationReason)) {
    score += 10;
    reasons.push("题族参考没有失效标记");
  }
  if (mode === "mature") {
    score += Math.min(6, familyReferences[0]?.remainingNovelIndependentMemberCountAfterLeaveOne || 0) * 2;
    reasons.push("留一后仍有独立题族成员");
  }
  if (!leakageRisk.blocksRecommendation) score += 10;
  const stableExistingReference = mode === "unmatched"
    || (familyReferences.length === 1
      && !familyReferences[0].reviewInvalidationReason
      && fingerprint?.status === "confirmed");
  const eligibleForRecommendation = completePrompt
    && answerReview.usableForBlindReplay
    && stableExistingReference
    && !leakageRisk.blocksRecommendation;
  return {
    score,
    reasons,
    eligibleForRecommendation,
    eligibleForScoring: false,
  };
}

function createCandidateInventory({
  questions = [],
  familyState = {},
  structureState = {},
  catalogs = [],
  experienceState = {},
  dossierState = {},
  bookId = "",
} = {}) {
  const activeQuestions = asArray(questions).filter((question) => isActiveOfficialQuestion(question)
    && (!bookId || question.bookId === bookId));
  const activeQuestionMap = new Map(activeQuestions.map((question) => [question.id, question]));
  const allActiveQuestions = asArray(questions).filter(isActiveOfficialQuestion);
  const duplicateIndex = createDuplicateIndex(allActiveQuestions);
  const families = normalizeLegacyFamilyFacts(familyState?.families);
  const familyById = new Map(families.map((family) => [String(family.id || ""), family]));
  const familyStatistics = createFamilyStatistics(families, new Map(allActiveQuestions.map((question) => [question.id, question])));
  const recordByBook = new Map(asArray(structureState?.records).map((record) => [record.bookId, record]));
  const catalogByBook = new Map(asArray(catalogs).map((catalog) => [catalog.bookId, catalog]));
  const dossierNodeIndex = createDossierNodeIndex(dossierState);
  const projections = new Map();

  uniqueStrings(activeQuestions.map((question) => question.bookId)).forEach((currentBookId) => {
    const record = recordByBook.get(currentBookId);
    const catalogNodeIds = confirmedCatalogNodeIds(catalogByBook.get(currentBookId));
    if (!record || !catalogNodeIds.length) {
      projections.set(currentBookId, { byQuestionId: {} });
      return;
    }
    projections.set(currentBookId, buildQuestionFamilyCatalogProjection({
      families: families.filter((family) => family.bookId === currentBookId),
      knowledgeNodes: record.nodes || [],
      catalogNodeIds,
    }));
  });

  const candidates = activeQuestions.map((question) => {
    const record = recordByBook.get(question.bookId);
    const fingerprint = preferredFingerprint(record, question.id);
    const projectedFamilyIds = uniqueStrings(projections.get(question.bookId)?.byQuestionId?.[question.id]?.topicFamilyIds);
    const familyReferences = projectedFamilyIds.map((familyId) => {
      const family = familyById.get(familyId);
      const statistics = familyStatistics.get(familyId);
      return family && statistics ? familyMemberSummary(family, statistics, question) : null;
    }).filter(Boolean);
    const mode = modeForQuestion(familyReferences);
    const duplicates = asArray(duplicateIndex.get(questionContentSignature(question)))
      .filter((questionId) => questionId !== question.id);
    const answerReview = answerReviewSummary(question);
    const coverage = knowledgeCoverage(question, fingerprint);
    const experienceLeaks = experienceLeakSummary(experienceState, question);
    const leakageRisk = leakageRiskSummary({
      question,
      mode,
      familyReferences,
      fingerprint,
      duplicateQuestionIds: duplicates,
      experienceLeaks,
      answerReview,
    });
    const referencedNodeIds = uniqueStrings([
      fingerprint?.primaryNodeId,
      ...asArray(fingerprint?.requiredNodeIds),
      ...familyReferences.flatMap((family) => [
        family.coreKnowledgeNodeId,
        ...family.requiredKnowledgeNodeIds,
        ...family.textbookAnchorNodeIds,
      ]),
    ]);
    const recommendation = recommendationSummary({
      question,
      mode,
      answerReview,
      fingerprint,
      familyReferences,
      leakageRisk,
    });
    return {
      mode,
      question: {
        id: question.id,
        bookId: question.bookId,
        subjectId: question.subjectId || "",
        type: question.type || "",
        stem: question.stem || "",
        optionCount: asArray(question.options).filter((option) => String(option?.text || "").trim()).length,
        sourceLabel: question.sourceLabel || "",
        sourcePage: question.sourcePage || "",
      },
      coverage,
      answerReview,
      existingReference: {
        topicFamilyCount: familyReferences.length,
        topicFamilies: familyReferences,
        knowledgeFingerprint: fingerprint ? {
          status: fingerprint.status || "",
          primaryNodeId: fingerprint.primaryNodeId || "",
          primaryNodeRole: normalizePrimaryNodeRole(fingerprint.primaryNodeRole),
          primaryKnowledgePoint: fingerprint.primaryKnowledgePoint || "",
          knowledgePath: fingerprint.knowledgePath || "",
          requiredNodeIds: coverage.requiredNodeIds,
          span: fingerprint.span || "",
          crossKnowledge: fingerprint.crossKnowledge === true,
          source: fingerprint.source || "",
          evidencePages: asArray(fingerprint.evidencePages),
          evidenceChunkIds: uniqueStrings(fingerprint.evidenceChunkIds),
        } : null,
        dossierEvidence: dossierEvidenceSummary(referencedNodeIds, dossierNodeIndex),
      },
      duplicateQuestionIds: duplicates,
      experienceLeaks,
      leakageRisk,
      referenceGate: referenceGate(mode, familyReferences, fingerprint),
      recommendation,
    };
  });

  return {
    activeQuestionCount: activeQuestions.length,
    candidates,
    excludedAmbiguous: candidates.filter((candidate) => candidate.mode === "ambiguous"),
  };
}

function candidateSort(left, right) {
  return Number(right.recommendation.eligibleForRecommendation) - Number(left.recommendation.eligibleForRecommendation)
    || right.recommendation.score - left.recommendation.score
    || left.question.id.localeCompare(right.question.id);
}

function selectBalancedCandidates(candidates, limit = DEFAULT_LIMIT_PER_MODE) {
  const sorted = [...asArray(candidates)].sort(candidateSort);
  const eligible = sorted.filter((candidate) => candidate.recommendation.eligibleForRecommendation);
  const pool = eligible.length ? eligible : sorted;
  const selected = [];
  const objectives = [
    (candidate) => candidate.coverage.knowledgeScope === "single_knowledge",
    (candidate) => candidate.coverage.knowledgeScope === "cross_knowledge",
    (candidate) => candidate.coverage.optionJudgment === true,
  ];
  objectives.forEach((matches) => {
    if (selected.length >= limit) return;
    const candidate = pool.find((item) => !selected.includes(item) && matches(item));
    if (candidate) selected.push(candidate);
  });
  pool.forEach((candidate) => {
    if (selected.length >= limit || selected.includes(candidate)) return;
    selected.push(candidate);
  });
  return selected;
}

function coverageSummary(candidates) {
  const all = asArray(candidates);
  return {
    singleKnowledge: all.filter((candidate) => candidate.coverage.knowledgeScope === "single_knowledge").length,
    crossKnowledge: all.filter((candidate) => candidate.coverage.knowledgeScope === "cross_knowledge").length,
    optionJudgment: all.filter((candidate) => candidate.coverage.optionJudgment).length,
    unknownKnowledgeScope: all.filter((candidate) => candidate.coverage.knowledgeScope === "unknown").length,
  };
}

function buildSelectionManifest(inventory, { limitPerMode = DEFAULT_LIMIT_PER_MODE, bookId = "" } = {}) {
  const selectedByMode = Object.fromEntries(MODES.map((mode) => [
    mode,
    selectBalancedCandidates(inventory.candidates.filter((candidate) => candidate.mode === mode), limitPerMode),
  ]));
  const selected = MODES.flatMap((mode) => selectedByMode[mode]);
  const selectedCoverage = coverageSummary(selected);
  return {
    schemaVersion: 1,
    decision: "DEC-026",
    purpose: "classification_blind_sample_recommendations",
    automatedGoldDeclaration: false,
    disclaimer: "本清单只提供盲测候选和现有关系参考。任何样本在人工独立冻结前都不得视为已确认金标准或进入准确率。",
    filters: {
      bookId: bookId || "all",
      activeOfficialQuestionsOnly: true,
      limitPerMode,
    },
    summary: {
      activeQuestionCount: inventory.activeQuestionCount,
      populationByMode: Object.fromEntries(MODES.map((mode) => [mode, inventory.candidates.filter((candidate) => candidate.mode === mode).length])),
      recommendationReadyByMode: Object.fromEntries(MODES.map((mode) => [mode, inventory.candidates.filter((candidate) => candidate.mode === mode && candidate.recommendation.eligibleForRecommendation).length])),
      selectedByMode: Object.fromEntries(MODES.map((mode) => [mode, selectedByMode[mode].length])),
      excludedAmbiguousCount: inventory.excludedAmbiguous.length,
      selectedCoverage,
      coverageGaps: [
        ...(selectedCoverage.singleKnowledge ? [] : ["single_knowledge"]),
        ...(selectedCoverage.crossKnowledge ? [] : ["cross_knowledge"]),
        ...(selectedCoverage.optionJudgment ? [] : ["option_judgment"]),
      ],
    },
    modePolicy: {
      mature: "有效确认主题族至少有 2 个内容独立的活动成员；正式回放留一并保留其他成员。",
      singleton: "题目只有 1 个有效确认主题族，且该族只有 1 个内容独立成员；正式回放必须整族隐藏。",
      unmatched: "没有有效确认主题族；必须先由人工显式确认无等价题族并冻结预期，方可正式计分。",
    },
    recommendations: selectedByMode,
  };
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderCandidateMarkdown(candidate) {
  const family = candidate.existingReference.topicFamilies[0];
  const familyText = family
    ? `${family.name}（独立成员 ${family.independentMemberCount}，留一后新样本 ${family.remainingNovelIndependentMemberCountAfterLeaveOne}）`
    : "无有效确认主题族";
  const fingerprint = candidate.existingReference.knowledgeFingerprint;
  const knowledgeText = fingerprint
    ? `${fingerprint.knowledgePath || fingerprint.primaryKnowledgePoint || fingerprint.primaryNodeId}（${fingerprint.status || "未标明"}）`
    : "无知识指纹";
  const risks = candidate.leakageRisk.items.length
    ? candidate.leakageRisk.items.map((item) => `${item.code}:${item.severity}`).join("、")
    : "无已知风险";
  return `| \`${markdownEscape(candidate.question.id)}\` | ${markdownEscape(candidate.question.stem.slice(0, 72))} | ${markdownEscape(candidate.coverage.tags.join("、") || "范围未知")} | ${markdownEscape(candidate.answerReview.authority)} / ${markdownEscape(candidate.answerReview.source)} | ${markdownEscape(familyText)} | ${markdownEscape(knowledgeText)} | ${markdownEscape(risks)} | ${candidate.recommendation.eligibleForRecommendation ? "可进入人工冻结" : "先处理风险"} |`;
}

function renderMarkdownReport(manifest) {
  const sections = MODES.map((mode) => {
    const rows = manifest.recommendations[mode].map(renderCandidateMarkdown);
    return `## ${mode}\n\n${manifest.modePolicy[mode]}\n\n| 题目 ID | 题干摘要 | 覆盖 | 答案状态 | 现有题族参考与成员数 | 现有知识参考 | 泄漏风险 | 建议 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.length ? rows.join("\n") : "| - | 当前没有候选 | - | - | - | - | - | - |"}`;
  }).join("\n\n");
  return `# AI 知识归类盲测样本建议\n\n- 决议：${manifest.decision}\n- 范围：${manifest.filters.bookId}\n- 活动平台题：${manifest.summary.activeQuestionCount}\n- 自动确认金标准：否\n\n> ${manifest.disclaimer}\n\n## 模式汇总\n\n| 模式 | 总候选 | 可进入人工冻结 | 本次建议 |\n| --- | ---: | ---: | ---: |\n${MODES.map((mode) => `| ${mode} | ${manifest.summary.populationByMode[mode]} | ${manifest.summary.recommendationReadyByMode[mode]} | ${manifest.summary.selectedByMode[mode]} |`).join("\n")}\n\n## 覆盖检查\n\n- 单知识：${manifest.summary.selectedCoverage.singleKnowledge}\n- 跨知识：${manifest.summary.selectedCoverage.crossKnowledge}\n- 选项判断：${manifest.summary.selectedCoverage.optionJudgment}\n- 覆盖缺口：${manifest.summary.coverageGaps.join("、") || "无"}\n\n${sections}\n\n## 计分前置条件\n\n1. mature 必须独立冻结知识与题族参考，再执行留一遮蔽。\n2. singleton 必须整族隐藏，评价候选新题族语义，不按旧题族 ID 命中计分。\n3. unmatched 必须由人工显式确认“当前无等价题族”并冻结教材证据；未确认样本只观察、不计准确率。\n4. 所有样本都必须按泄漏清单完成遮蔽；重复题未合并或未同步遮蔽时不得正式回放。\n`;
}

function parseArgs(argv) {
  const options = { bookId: "", limitPerMode: DEFAULT_LIMIT_PER_MODE, outputRoot: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = String(argument).split(/=(.*)/s, 2);
    const takeValue = () => inlineValue !== undefined ? inlineValue : argv[++index];
    if (name === "--book-id") options.bookId = String(takeValue() || "");
    else if (name === "--limit-per-mode") options.limitPerMode = Number(takeValue());
    else if (name === "--output-root") options.outputRoot = String(takeValue() || "");
    else if (name === "--help" || name === "-h") options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (!Number.isInteger(options.limitPerMode) || options.limitPerMode < 1 || options.limitPerMode > 100) {
    throw new Error("limit_per_mode_must_be_1_to_100");
  }
  return options;
}

function defaultOutputRoot(projectRoot) {
  return path.resolve(projectRoot, "..", "outputs", "AI盲测样本");
}

function pathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertOutputOutsideRuntime(outputPath, runtimeDir) {
  if (pathInside(outputPath, runtimeDir)) throw new Error("blind_sample_output_runtime_forbidden");
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadRuntimeState(runtimeDir) {
  return {
    questions: readJson(path.join(runtimeDir, "questions.json")),
    familyState: readJson(path.join(runtimeDir, "question-families.json")),
    structureState: readJson(path.join(runtimeDir, "knowledge-structures.json")),
    catalogs: readJson(path.join(runtimeDir, "textbook-catalogs.json")),
    experienceState: readJson(path.join(runtimeDir, "knowledge-classification-experience.json")),
    dossierState: readJson(path.join(runtimeDir, "knowledge-dossiers.json")),
  };
}

function writeSelectionReports(manifest, { outputRoot, runtimeDir, now = new Date() }) {
  const outputDir = path.join(path.resolve(outputRoot), timestampForPath(now));
  assertOutputOutsideRuntime(outputDir, runtimeDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "盲测样本建议.json");
  const markdownPath = path.join(outputDir, "盲测样本建议.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, renderMarkdownReport(manifest), "utf8");
  return { outputDir, jsonPath, markdownPath };
}

function runSampleSelection(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, "../.."));
  const runtimeDir = path.resolve(options.runtimeDir || path.join(projectRoot, ".runtime"));
  const outputRoot = path.resolve(options.outputRoot || defaultOutputRoot(projectRoot));
  assertOutputOutsideRuntime(outputRoot, runtimeDir);
  const beforeHashes = Object.fromEntries(SOURCE_FILES.map((fileName) => [fileName, sha256File(path.join(runtimeDir, fileName))]));
  const inventory = createCandidateInventory({
    ...loadRuntimeState(runtimeDir),
    bookId: options.bookId || "",
  });
  const manifest = buildSelectionManifest(inventory, {
    limitPerMode: options.limitPerMode || DEFAULT_LIMIT_PER_MODE,
    bookId: options.bookId || "",
  });
  manifest.generatedAt = new Date().toISOString();
  manifest.sourceAudit = {
    runtimeReadOnly: true,
    files: beforeHashes,
  };
  const paths = writeSelectionReports(manifest, { outputRoot, runtimeDir });
  const afterHashes = Object.fromEntries(SOURCE_FILES.map((fileName) => [fileName, sha256File(path.join(runtimeDir, fileName))]));
  manifest.sourceAudit.unchanged = SOURCE_FILES.every((fileName) => beforeHashes[fileName] === afterHashes[fileName]);
  if (!manifest.sourceAudit.unchanged) throw new Error("blind_sample_runtime_changed_during_selection");
  fs.writeFileSync(paths.jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, ...paths };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("用法：node scripts/classification/select-classification-blind-samples.js [--book-id ID] [--limit-per-mode 数量] [--output-root 目录]\n");
    return;
  }
  const result = runSampleSelection(options);
  process.stdout.write(`[样本选择] mature ${result.manifest.summary.selectedByMode.mature}，singleton ${result.manifest.summary.selectedByMode.singleton}，unmatched ${result.manifest.summary.selectedByMode.unmatched}。\n`);
  process.stdout.write(`[样本选择] 自动确认金标准：否；正式数据只读：${result.manifest.sourceAudit.unchanged ? "通过" : "未通过"}。\n`);
  process.stdout.write(`[样本选择] 报告：${result.markdownPath}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[样本选择] 失败：${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_LIMIT_PER_MODE,
  MODES,
  answerReviewSummary,
  assertOutputOutsideRuntime,
  buildSelectionManifest,
  createCandidateInventory,
  defaultOutputRoot,
  isActiveOfficialQuestion,
  knowledgeCoverage,
  modeForQuestion,
  optionJudgmentQuestion,
  parseArgs,
  questionContentSignature,
  renderMarkdownReport,
  runSampleSelection,
  selectBalancedCandidates,
  writeSelectionReports,
};
