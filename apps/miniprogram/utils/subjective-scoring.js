const { stripAnswerMarkdown } = require("./answer-markdown");

function roundScore(value) {
  return Math.round(Number(value) * 10) / 10;
}

function normalizeText(value) {
  return stripAnswerMarkdown(value).replace(/\s+/g, "").toLowerCase();
}

function normalizeReferenceText(value) {
  return normalizeText(value).replace(/[，。；：、“”‘’（）()《》〈〉！？!?·,.;:'"\-—_]/g, "");
}

function findEvidence(answerText, alternatives) {
  return (Array.isArray(alternatives) ? alternatives : [])
    .map((term) => String(term))
    .find((term) => answerText.includes(normalizeText(term))) || "";
}

function scoreSubjectiveAnswer(question, answer, options = {}) {
  const answerText = normalizeText(answer);
  const scoringPoints = Array.isArray(question && question.scoringPoints) ? question.scoringPoints : [];
  if (!question || question.answerMode !== "text" || !answerText || !scoringPoints.length) {
    throw new Error("invalid_subjective_scoring_input");
  }

  const hitPoints = [];
  const missedPoints = [];
  scoringPoints.forEach((point) => {
    const groups = Array.isArray(point.evidenceGroups) ? point.evidenceGroups : [];
    const evidence = groups.map((group) => findEvidence(answerText, group));
    const hitGroupCount = evidence.filter(Boolean).length;
    const ratio = groups.length ? hitGroupCount / groups.length : 0;
    const awardedScore = roundScore(Number(point.score) * ratio);
    if (awardedScore > 0) {
      hitPoints.push({
        id: point.id,
        description: point.description,
        textbookPage: String(point.textbookPage || ""),
        pageBasis: String(point.pageBasis || ""),
        sourceNote: String(point.sourceNote || ""),
        awardedScore,
        maxScore: Number(point.score),
        evidence: evidence.filter(Boolean),
        evidenceText: evidence.filter(Boolean).join("、"),
        status: ratio === 1 ? "hit" : "partial",
      });
    }
    if (ratio < 1) {
      missedPoints.push({
        id: point.id,
        description: point.description,
        textbookPage: String(point.textbookPage || ""),
        pageBasis: String(point.pageBasis || ""),
        sourceNote: String(point.sourceNote || ""),
        lostScore: roundScore(Number(point.score) - awardedScore),
        maxScore: Number(point.score),
        missingHints: groups.filter((group, index) => !evidence[index]).map((group) => group[0]),
        missingHintsText: groups.filter((group, index) => !evidence[index]).map((group) => group[0]).join("、"),
      });
    }
  });

  const contradictionRules = Array.isArray(question.contradictionRules) ? question.contradictionRules : [];
  const errors = contradictionRules
    .filter((rule) => (rule.terms || []).some((term) => answerText.includes(normalizeText(term))))
    .map((rule) => rule.message);
  const expressionSuggestions = [];
  if (String(answer).trim().length < 45) {
    expressionSuggestions.push("答案较简略，建议按照“概念界定—三项规范标准”的顺序完整作答。");
  }
  if (!/[，。；：]/.test(String(answer))) {
    expressionSuggestions.push("建议使用分句或分点表达，使各得分点更清晰。");
  }
  if (!expressionSuggestions.length) {
    expressionSuggestions.push("结构较清楚，可进一步压缩重复表述并突出教材关键词。");
  }

  const totalScore = roundScore(hitPoints.reduce((total, point) => total + point.awardedScore, 0));
  const maxScore = Number(question.score) || scoringPoints.reduce((total, point) => total + Number(point.score), 0);
  const result = {
    requestId: options.requestId || `local-score-${Date.now()}`,
    questionId: question.id,
    totalScore: Math.min(maxScore, totalScore),
    maxScore,
    hitPoints,
    missedPoints,
    errors,
    expressionSuggestions,
    referenceComparison: missedPoints.length
      ? `已覆盖 ${hitPoints.length} 项内容，仍需补充：${missedPoints.map((point) => point.description).join("；")}。`
      : "作答已覆盖参考答案的全部结构化得分点。",
    referenceAnswer: question.referenceAnswer,
    basis: "教材答案 + 结构化得分点",
    confidence: errors.length ? 0.72 : 0.86,
    confidencePercent: errors.length ? 72 : 86,
    uncertainty: "当前为规则评分演示，正式 AI 接入后可能根据语义等价表达调整得分。",
    graderMode: "local_rule_demo",
    graderVersion: "subjective-score-v1",
    createdAt: Date.now(),
  };
  if (!isValidScoreResult(result)) throw new Error("invalid_subjective_scoring_output");
  return result;
}

function scoreFastSubjectiveAnswer(question, answer, options = {}) {
  const scoringPoints = Array.isArray(question && question.scoringPoints) ? question.scoringPoints : [];
  const maxScore = Number(question && question.score) || scoringPoints.reduce((total, point) => total + Number(point.score || 0), 0);
  if (!question || question.answerMode !== "text" || !String(answer || "").trim() || !scoringPoints.length || !maxScore) return null;

  const exactReferenceMatch = normalizeReferenceText(answer)
    && normalizeReferenceText(answer) === normalizeReferenceText(question.referenceAnswer);
  let ruleResult = null;
  const hasCompleteEvidenceRules = scoringPoints.every((point) => Array.isArray(point.evidenceGroups) && point.evidenceGroups.length);
  if (!exactReferenceMatch && hasCompleteEvidenceRules) {
    ruleResult = scoreSubjectiveAnswer(question, answer, options);
    if (ruleResult.totalScore !== ruleResult.maxScore || ruleResult.errors.length) return null;
  }
  if (!exactReferenceMatch && !ruleResult) return null;
  if (ruleResult) {
    return {
      ...ruleResult,
      graderMode: "local_fast_full_match",
      graderVersion: "subjective-fast-v1",
      confidence: 1,
      confidencePercent: 100,
      uncertainty: "答案完整命中已确认的结构化得分点。",
    };
  }

  const hitPoints = scoringPoints.map((point) => ({
    id: point.id,
    description: point.description,
    textbookPage: String(point.textbookPage || ""),
    pageBasis: String(point.pageBasis || ""),
    sourceNote: String(point.sourceNote || ""),
    awardedScore: Number(point.score),
    maxScore: Number(point.score),
    evidence: [],
    evidenceText: "",
    status: "hit",
  }));
  return {
    requestId: options.requestId || `fast-score-${Date.now()}`,
    questionId: question.id,
    totalScore: maxScore,
    maxScore,
    hitPoints,
    missedPoints: [],
    errors: [],
    expressionSuggestions: ["答案与已确认参考答案一致。"],
    referenceComparison: "作答与参考答案一致，并覆盖全部结构化得分点。",
    referenceAnswer: question.referenceAnswer,
    basis: "教材答案 + 结构化得分点",
    confidence: 1,
    confidencePercent: 100,
    uncertainty: "答案与已确认参考答案一致。",
    graderMode: "local_fast_exact_match",
    graderVersion: "subjective-fast-v1",
    createdAt: Date.now(),
  };
}

function isValidScoreResult(result) {
  return !!result
    && Number.isFinite(result.totalScore)
    && Number.isFinite(result.maxScore)
    && result.totalScore >= 0
    && result.totalScore <= result.maxScore
    && Array.isArray(result.hitPoints)
    && Array.isArray(result.missedPoints)
    && Array.isArray(result.errors)
    && Array.isArray(result.expressionSuggestions)
    && typeof result.referenceComparison === "string"
    && typeof result.referenceAnswer === "string"
    && typeof result.basis === "string"
    && Number.isFinite(result.confidence)
    && typeof result.graderVersion === "string";
}

module.exports = {
  isValidScoreResult,
  normalizeText,
  scoreFastSubjectiveAnswer,
  scoreSubjectiveAnswer,
};
