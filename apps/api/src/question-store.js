const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { examProject, subjects, books } = require("../../../packages/domain/catalog");
const { demoQuestions } = require("../../miniprogram/data/catalog");
const { scoringPointStructure } = require("./scoring-point-structure");
const { normalizeClassicalWordStem } = require("./classical-word-marker");
const { normalizeMaterialMarks } = require("./material-mark");
const { countQuestionUnits, decorateQuestionGroups, questionGroupId } = require("./question-group");
const { estimateDifficulty, inferExamTrack, knowledgeDifficultyProfiles, primaryKnowledgePoint, subKnowledgePoints, frequencyProfiles, questionFrequency } = require("./question-assessment");

const questionTypes = [
  ["single_choice", "单选题"],
  ["multiple_choice", "多选题"],
  ["true_false", "判断题"],
  ["fill_blank", "填空题"],
  ["punctuation", "断句题"],
  ["classical_word_explanation", "加点字词解释"],
  ["translation", "古文翻译"],
  ["short_answer", "简答题"],
  ["term_definition", "名词解释"],
  ["material_analysis", "材料分析题"],
  ["appreciation", "作品赏析题"],
  ["essay", "论述题"],
];
const typeLabels = Object.fromEntries(questionTypes);
const choiceTypes = new Set(["single_choice", "multiple_choice"]);
const answerSources = new Set(["pdf_answer", "team_verified", "ai_supplement", "community_consensus", "missing"]);
const answerVariantKeys = new Set(["official", "ai", "community"]);
const allowedStatuses = new Set(["official", "pending_review", "public", "featured", "offline"]);
const answerReviewStatuses = new Set(["unreviewed", "doubtful", "verified"]);
const examTagValues = new Set(["insert", "graduate"]);

function normalizeExamTagValue(value) {
  const tag = String(value || "").trim();
  return tag === "upgrade" ? "insert" : tag;
}

function normalizeExamTags(value, fallbackQuestion = {}) {
  if (value !== undefined && value !== null) {
    return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[，,、\s]+/))
      .map(normalizeExamTagValue)
      .filter((item) => examTagValues.has(item)))];
  }
  const legacyTrack = normalizeExamTagValue(fallbackQuestion.examTrack || inferExamTrack(fallbackQuestion));
  return examTagValues.has(legacyTrack) ? [legacyTrack] : [];
}

function normalizeDifficultyScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.min(100, Math.max(1, Math.round(score))) : 50;
}

function difficultyStars(value) {
  return Math.min(5, Math.max(1, Math.ceil(normalizeDifficultyScore(value) / 20)));
}

function normalizeKnowledgeSignal(value) {
  const score = Number(value);
  return Number.isFinite(score) && score > 0 ? Math.min(100, Math.max(1, Math.round(score))) : 0;
}

function normalizeDifficultyAssessment(value, score) {
  const assessment = value && typeof value === "object" ? value : {};
  const status = ["unassessed", "suggested", "confirmed"].includes(assessment.status) ? assessment.status : "unassessed";
  return {
    status,
    source: ["manual", "rule", "knowledge_rule", "ai", "performance"].includes(assessment.source) ? assessment.source : "",
    confidence: Math.min(1, Math.max(0, Number(assessment.confidence) || 0)),
    reason: String(assessment.reason || "").trim().slice(0, 1000),
    assessedAt: Number(assessment.assessedAt) || 0,
    score: normalizeDifficultyScore(score),
    groupSize: Math.max(0, Number(assessment.groupSize) || 0),
    knowledgeDepthScore: normalizeKnowledgeSignal(assessment.knowledgeDepthScore),
    knowledgeObscurityScore: normalizeKnowledgeSignal(assessment.contentObscurityScore ?? assessment.knowledgeObscurityScore),
    contentObscurityScore: normalizeKnowledgeSignal(assessment.contentObscurityScore ?? assessment.knowledgeObscurityScore),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergedQuestionTargetId(question) {
  return String(question?.mergedIntoQuestionId || question?.merge?.targetQuestionId || "").trim();
}

function assertQuestionNotMergedSource(question) {
  if (mergedQuestionTargetId(question)) throw new Error("question_merged_source_read_only");
}

function normalizeSubNumber(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^[\s(\[【]+/, "")
    .replace(/[\s)\]】]+$/, "")
    .slice(0, 40);
}

function normalizeAnswerReviewStatus(value, answerSource) {
  if (["team_verified", "community_consensus"].includes(answerSource)) return "verified";
  if (answerReviewStatuses.has(value && value.answerReviewStatus)) return value.answerReviewStatus;
  if (value && value.answerVerified === true) return "verified";
  return ["pdf_answer", "ai_supplement"].includes(answerSource) ? "unreviewed" : "verified";
}

function questionSnapshot(question) {
  const { versions, ...snapshot } = question;
  return clone(snapshot);
}

function seedQuestions() {
  const now = Date.now();
  return demoQuestions.map((question, index) => {
    const bookId = question.breadcrumb.includes("下册") ? "modern-chinese-7-2" : "modern-chinese-7-1";
    return {
      id: question.id,
      projectId: examProject.id,
      library: "official",
      status: "official",
      subjectId: "modern-chinese",
      bookId,
      chapter: question.breadcrumb.split(" · ").pop() || "未归类章节",
      knowledgePoints: [question.knowledgePoint],
      type: question.type,
      typeLabel: question.typeLabel || typeLabels[question.type] || question.type,
      stem: question.stem,
      options: clone(question.options || []),
      correctAnswer: clone(question.correctAnswer || []),
      referenceAnswer: question.referenceAnswer,
      scoringPoints: (question.scoringPoints || []).map((point) => ({
        id: point.id,
        description: point.description,
        score: Number(point.score),
        evidenceGroups: clone(point.evidenceGroups || []),
        textbookPage: String(point.textbookPage || ""),
        pageBasis: String(point.pageBasis || ""),
        sourceNote: String(point.sourceNote || ""),
      })),
      contradictionRules: clone(question.contradictionRules || []),
      maxScore: Number(question.score) || 1,
      sourceLabel: question.source,
      sourcePage: "",
      freePreview: { question: index < 2, answer: index === 0, analysis: false },
      contributor: null,
      metrics: { helpful: 0, unhelpful: 0, favorites: 0, comments: 0, reports: 0 },
      version: 1,
      versions: [{ version: 1, updatedAt: now, updatedBy: "系统种子数据", changeNote: "导入首批演示题目" }],
      createdAt: now,
      updatedAt: now,
      createdBy: "系统种子数据",
      updatedBy: "系统种子数据",
    };
  });
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option, index) => ({
    key: String(option && option.key || String.fromCharCode(65 + index)).trim().toUpperCase(),
    text: String(option && option.text || "").trim(),
  })).filter((option) => option.key && option.text).slice(0, 12);
}

function normalizeChoiceCorrectAnswer(answer) {
  const values = Array.isArray(answer) ? answer : String(answer || "").split(/[，,、\s]/);
  return values.flatMap((value) => {
    const matches = String(value || "").normalize("NFKC").toUpperCase().match(/[A-L]/g);
    return matches || [];
  }).filter(Boolean);
}

function choiceValidationDetails(payload) {
  return {
    optionKeys: normalizeOptions(payload && payload.options).map((option) => option.key),
    correctAnswer: [...new Set(normalizeChoiceCorrectAnswer(payload && payload.correctAnswer))],
  };
}

function requiredFieldDetails(payload) {
  const knowledgePoints = Array.isArray(payload && payload.knowledgePoints)
    ? payload.knowledgePoints
    : String(payload && payload.knowledgePoints || "").split(/[，,\n]/);
  return {
    missingFields: [
      !String(payload && payload.chapter || "").trim() && "章节",
      !knowledgePoints.some((item) => String(item || "").trim()) && "知识点",
      !String(payload && payload.stem || "").trim() && "题干",
      !String(payload && payload.referenceAnswer || "").trim() && "参考答案",
    ].filter(Boolean),
  };
}

function normalizeScoringPoints(points) {
  if (!Array.isArray(points)) return [];
  return points.map((point) => ({
    id: String(point && point.id || crypto.randomUUID()),
    description: String(point && point.description || "").trim(),
    score: Number(point && point.score),
    evidenceGroups: Array.isArray(point && point.evidenceGroups) ? clone(point.evidenceGroups).slice(0, 20) : [],
    textbookPage: String(point && (point.textbookPage || point.textbookPages) || "").trim().slice(0, 100),
    pageBasis: ["confirmed_catalog", "textbook_text", "manual"].includes(point && point.pageBasis) ? point.pageBasis : "",
    sourceNote: String(point && point.sourceNote || "").trim().slice(0, 500),
  })).filter((point) => point.description && Number.isFinite(point.score) && point.score > 0).slice(0, 30);
}

function normalizeScoringPolicy(value, type, maxScore) {
  const modes = ["double_choice_partial", "double_choice_no_partial"];
  if (!value || !modes.includes(value.mode) || type !== "multiple_choice") return null;
  return {
    mode: value.mode,
    oneCorrectScore: value.mode === "double_choice_partial" ? Math.max(0, Number(value.oneCorrectScore) || 0) : 0,
    allCorrectScore: Math.max(0, Number(value.allCorrectScore) || maxScore),
    extraOptionScore: Math.max(0, Number(value.extraOptionScore) || 0),
    emptyScore: Math.max(0, Number(value.emptyScore) || 0),
  };
}

function normalizeAnswerVariants(value, referenceAnswer, answerSource) {
  const variants = value && typeof value === "object" ? value : {};
  return {
    official: String(variants.official || (["pdf_answer", "team_verified"].includes(answerSource) ? referenceAnswer : "")).trim().slice(0, 20000),
    ai: String(variants.ai || (answerSource === "ai_supplement" ? referenceAnswer : "")).trim().slice(0, 20000),
    community: String(variants.community || (answerSource === "community_consensus" ? referenceAnswer : "")).trim().slice(0, 20000),
  };
}

function normalizeHiddenAnswerVariants(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter((item) => answerVariantKeys.has(item)))];
}

function normalizeFingerprintText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？；：、“”‘’（）()【】\[\]《》<>·…—-]/g, "");
}

function questionFingerprint(question) {
  const optionText = choiceTypes.has(question.type)
    ? normalizeOptions(question.options).map((option) => `${option.key}:${normalizeFingerprintText(option.text)}`).join("|")
    : "";
  return crypto.createHash("sha256").update([
    String(question.type || ""),
    normalizeFingerprintText(question.material),
    normalizeFingerprintText(question.stem),
    optionText,
  ].join("\n")).digest("hex");
}

function questionStemFingerprint(question) {
  return `${String(question.type || "")}\n${normalizeFingerprintText(question.material)}\n${normalizeFingerprintText(question.stem)}`;
}

function validateQuestionPayload(payload, existing = null) {
  const subjectId = String(payload.subjectId || existing?.subjectId || "");
  const bookId = String(payload.bookId || existing?.bookId || "");
  const type = String(payload.type || existing?.type || "");
  const subject = subjects.find((item) => item.id === subjectId);
  const book = books.find((item) => item.id === bookId && item.subjectId === subjectId);
  if (!subject || !book) throw new Error("question_catalog_required");
  if (!typeLabels[type]) throw new Error("question_type_invalid");
  const chapter = String(payload.chapter ?? existing?.chapter ?? "").trim();
  const knowledgePointSource = payload.knowledgePoints ?? existing?.knowledgePoints ?? [];
  const knowledgePoints = (Array.isArray(knowledgePointSource) ? knowledgePointSource : String(knowledgePointSource || "").split(/[，,\n]/))
    .map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
  const explicitPrimaryKnowledgePoint = String(payload.primaryKnowledgePoint ?? existing?.primaryKnowledgePoint ?? "").trim().slice(0, 200);
  const resolvedPrimaryKnowledgePoint = explicitPrimaryKnowledgePoint || primaryKnowledgePoint({ chapter, knowledgePoints });
  const subKnowledgePointSource = payload.subKnowledgePoints ?? existing?.subKnowledgePoints;
  const resolvedSubKnowledgePoints = subKnowledgePointSource == null
    ? subKnowledgePoints({ chapter, knowledgePoints, primaryKnowledgePoint: resolvedPrimaryKnowledgePoint }, resolvedPrimaryKnowledgePoint)
    : subKnowledgePoints({ subKnowledgePoints: subKnowledgePointSource }, resolvedPrimaryKnowledgePoint);
  const knowledgeDepthScore = normalizeKnowledgeSignal(payload.knowledgeDepthScore ?? existing?.knowledgeDepthScore);
  const contentObscurityScore = normalizeKnowledgeSignal(payload.contentObscurityScore ?? existing?.contentObscurityScore);
  const rawStem = String(payload.stem ?? existing?.stem ?? "").trim();
  const referenceAnswer = String(payload.referenceAnswer ?? existing?.referenceAnswer ?? "").trim();
  const classicalWord = type === "classical_word_explanation"
    ? normalizeClassicalWordStem({
      stem: rawStem,
      annotationText: payload.annotationText ?? existing?.annotationText,
      referenceAnswer,
    })
    : null;
  const stem = classicalWord?.stem ?? rawStem;
  const maxScore = Number(payload.maxScore ?? existing?.maxScore);
  if (!chapter || !knowledgePoints.length || !stem || !referenceAnswer) throw new Error("question_required_fields_missing");
  if (type === "fill_blank" && !/(?:_{2,}|＿{2,}|□{2,}|\(\s*\)|（\s*）)/u.test(stem)) {
    throw new Error("question_fill_blank_position_missing");
  }
  if (stem.length > 12000 || referenceAnswer.length > 20000) throw new Error("question_content_too_large");
  if (!Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 100) throw new Error("question_score_invalid");
  const options = normalizeOptions(payload.options ?? existing?.options);
  const rawCorrectAnswer = payload.correctAnswer ?? existing?.correctAnswer;
  const correctAnswer = choiceTypes.has(type)
    ? normalizeChoiceCorrectAnswer(rawCorrectAnswer)
    : (Array.isArray(rawCorrectAnswer) ? rawCorrectAnswer : String(rawCorrectAnswer || "").split(/[，,、\n]/))
      .map((item) => String(item).trim()).filter(Boolean);
  if (choiceTypes.has(type)) {
    if (options.length < 2 || !correctAnswer.length || correctAnswer.some((answer) => !options.some((option) => option.key === answer))) {
      throw new Error("question_choice_answer_invalid");
    }
    if (type === "single_choice" && correctAnswer.length !== 1) throw new Error("question_choice_answer_invalid");
  }
  const scoringPoints = normalizeScoringPoints(payload.scoringPoints ?? existing?.scoringPoints);
  const scoringStructure = scoringPointStructure(type, referenceAnswer, scoringPoints, maxScore);
  const answerSource = answerSources.has(payload.answerSource ?? existing?.answerSource)
    ? (payload.answerSource ?? existing.answerSource)
    : "team_verified";
  const answerReviewStatus = classicalWord?.needsReview
    ? "doubtful"
    : normalizeAnswerReviewStatus(payload.answerReviewStatus != null || payload.answerVerified != null ? payload : existing, answerSource);
  const answerVerified = answerReviewStatus === "verified";
  if (answerSource === "missing" && (referenceAnswer || correctAnswer.length)) throw new Error("question_answer_source_required");
  const answerVariants = normalizeAnswerVariants(payload.answerVariants ?? existing?.answerVariants, referenceAnswer, answerSource);
  const hiddenAnswerVariants = normalizeHiddenAnswerVariants(payload.hiddenAnswerVariants ?? existing?.hiddenAnswerVariants);
  return {
    subjectId,
    bookId,
    chapter,
    knowledgePoints,
    primaryKnowledgePoint: resolvedPrimaryKnowledgePoint,
    subKnowledgePoints: resolvedSubKnowledgePoints,
    knowledgeDepthScore,
    contentObscurityScore,
    type,
    typeLabel: typeLabels[type],
    stem,
    options: choiceTypes.has(type) ? options : [],
    correctAnswer: choiceTypes.has(type) ? [...new Set(correctAnswer)] : correctAnswer,
    referenceAnswer,
    answerVariants,
    hiddenAnswerVariants,
    scoringPoints,
    scoringPointStatus: scoringStructure.status,
    scoringPointCandidates: scoringStructure.candidates,
    scoringPolicy: normalizeScoringPolicy(payload.scoringPolicy ?? existing?.scoringPolicy, type, maxScore),
    maxScore,
    material: String(payload.material ?? existing?.material ?? "").trim().slice(0, 20000),
    materialMarks: normalizeMaterialMarks(payload.materialMarks ?? existing?.materialMarks),
    materialGroupId: String(payload.materialGroupId ?? existing?.materialGroupId ?? "").trim().slice(0, 120),
    questionGroupId: String(payload.questionGroupId ?? existing?.questionGroupId ?? "").trim().slice(0, 360),
    questionGroupTitle: String(payload.questionGroupTitle ?? existing?.questionGroupTitle ?? "").trim().slice(0, 200),
    groupOrder: Math.max(0, Math.min(1000, Number(payload.groupOrder ?? existing?.groupOrder) || 0)),
    usesSharedMaterial: payload.usesSharedMaterial ?? existing?.usesSharedMaterial ?? true,
    groupNumber: String(payload.groupNumber ?? existing?.groupNumber ?? "").trim().slice(0, 40),
    subNumber: normalizeSubNumber(payload.subNumber ?? existing?.subNumber),
    responseMode: (payload.responseMode ?? existing?.responseMode) === "annotation" ? "annotation" : "text",
    annotationText: String(payload.annotationText ?? existing?.annotationText ?? "").trim().slice(0, 12000),
    answerSource,
    answerReviewStatus,
    answerVerified,
    sourceLabel: String(payload.sourceLabel ?? existing?.sourceLabel ?? "").trim().slice(0, 1000),
    sourcePage: String(payload.sourcePage ?? existing?.sourcePage ?? "").trim().slice(0, 100),
    freePreview: {
      question: (payload.freePreview ?? existing?.freePreview)?.question === true,
      answer: (payload.freePreview ?? existing?.freePreview)?.answer === true,
      analysis: (payload.freePreview ?? existing?.freePreview)?.analysis === true,
    },
    difficultyScore: normalizeDifficultyScore(payload.difficultyScore ?? existing?.difficultyScore),
    difficultyStars: difficultyStars(payload.difficultyScore ?? existing?.difficultyScore),
    difficultyAssessment: normalizeDifficultyAssessment(
      payload.difficultyAssessment ?? (payload.difficultyScore != null && existing
        && normalizeDifficultyScore(payload.difficultyScore) !== normalizeDifficultyScore(existing.difficultyScore)
        ? { status: "confirmed", source: "manual", confidence: 1, reason: "管理员调整知识点难度", assessedAt: Date.now() }
        : existing?.difficultyAssessment),
      payload.difficultyScore ?? existing?.difficultyScore,
    ),
    examTags: normalizeExamTags(
      Object.prototype.hasOwnProperty.call(payload, "examTags") ? payload.examTags : existing?.examTags,
      existing || payload,
    ),
  };
}

function buildNewQuestion(payload, actor, now = Date.now()) {
  const normalized = validateQuestionPayload(payload);
  const library = payload.library === "public" ? "public" : "official";
  const status = library === "official"
    ? (normalized.answerReviewStatus === "verified" ? "official" : "pending_review")
    : (allowedStatuses.has(payload.status) ? payload.status : "pending_review");
  return {
    id: String(payload.id || `question-${crypto.randomUUID()}`),
    projectId: examProject.id,
    importBatchId: String(payload.importBatchId || "").trim().slice(0, 120),
    importBatchLabel: String(payload.importBatchLabel || "").trim().slice(0, 200),
    library,
    status,
    ...normalized,
    contributor: library === "public" && payload.contributor ? {
      id: String(payload.contributor.id || ""),
      nickname: String(payload.contributor.nickname || "用户贡献者").slice(0, 40),
    } : null,
    metrics: { helpful: 0, unhelpful: 0, favorites: 0, comments: 0, reports: 0, ...(payload.metrics || {}) },
    version: 1,
    versions: [{ version: 1, updatedAt: now, updatedBy: actor, changeNote: String(payload.changeNote || "首次录入") }],
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
  };
}

function assignLegacyImportBatches(items) {
  const assignments = new Map();
  const legacy = items.filter((question) => !question.importBatchId && (question.versions || []).some((version) => version.changeNote === "批量文本导入"))
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const firstCreatedAt = Math.min(...group.map((question) => Number(question.createdAt || 0)));
    const batchId = `legacy-question-import-${firstCreatedAt}`;
    group.forEach((question) => assignments.set(question.id, batchId));
    group = [];
  };
  legacy.forEach((question) => {
    const previous = group[group.length - 1];
    if (previous && Number(question.createdAt || 0) - Number(previous.createdAt || 0) > 5000) flush();
    group.push(question);
  });
  flush();
  return assignments;
}

function summarizeImportBatches(questions) {
  const grouped = new Map();
  questions.filter((question) => question.importBatchId).forEach((question) => {
    if (!grouped.has(question.importBatchId)) grouped.set(question.importBatchId, []);
    grouped.get(question.importBatchId).push(question);
  });
  return [...grouped.entries()].map(([id, items]) => {
    const subjectIds = [...new Set(items.map((item) => item.subjectId).filter(Boolean))];
    const bookIds = [...new Set(items.map((item) => item.bookId).filter(Boolean))];
    const sources = items.map((item) => String(item.sourceLabel || "").trim()).filter(Boolean);
    const sourceLabel = sources.sort((left, right) => sources.filter((item) => item === right).length - sources.filter((item) => item === left).length)[0] || "";
    return {
      id,
      label: items.find((item) => item.importBatchLabel)?.importBatchLabel || sourceLabel || "批量文本导入",
      count: items.length,
      createdAt: Math.min(...items.map((item) => Number(item.createdAt || 0))),
      updatedAt: Math.max(...items.map((item) => Number(item.updatedAt || 0))),
      subjectId: subjectIds.length === 1 ? subjectIds[0] : "mixed",
      bookId: bookIds.length === 1 ? bookIds[0] : "mixed",
      subjectIds,
      bookIds,
    };
  }).sort((left, right) => right.createdAt - left.createdAt);
}

function createQuestionStore(adapter) {
  let frequencyPaperProvider = () => [];
  const read = () => {
    const rawItems = adapter.read();
    const legacyAssignments = assignLegacyImportBatches(rawItems);
    const normalized = rawItems.map((question) => {
    const item = clone(question);
    const answerSource = answerSources.has(item.answerSource) ? item.answerSource : "team_verified";
    const answerReviewStatus = normalizeAnswerReviewStatus(item, answerSource);
    const structure = scoringPointStructure(item.type, item.referenceAnswer, item.scoringPoints, item.maxScore);
    const storedAssessment = normalizeDifficultyAssessment(item.difficultyAssessment, item.difficultyScore);
    const resolvedPrimaryKnowledgePoint = String(item.primaryKnowledgePoint || "").trim() || primaryKnowledgePoint(item);
    return {
      ...item,
      primaryKnowledgePoint: resolvedPrimaryKnowledgePoint,
      subKnowledgePoints: Object.prototype.hasOwnProperty.call(item, "subKnowledgePoints")
        ? subKnowledgePoints(item, resolvedPrimaryKnowledgePoint)
        : subKnowledgePoints({ ...item, primaryKnowledgePoint: resolvedPrimaryKnowledgePoint }, resolvedPrimaryKnowledgePoint),
      knowledgeDepthScore: normalizeKnowledgeSignal(item.knowledgeDepthScore),
      contentObscurityScore: normalizeKnowledgeSignal(item.contentObscurityScore),
      answerSource,
      hiddenAnswerVariants: normalizeHiddenAnswerVariants(item.hiddenAnswerVariants),
      answerReviewStatus,
      answerVerified: answerReviewStatus === "verified",
      scoringPointStatus: structure.status,
      scoringPointCandidates: structure.candidates,
      importBatchId: item.importBatchId || legacyAssignments.get(item.id) || "",
      difficultyScore: normalizeDifficultyScore(item.difficultyScore),
      difficultyStars: difficultyStars(item.difficultyScore),
      difficultyAssessment: storedAssessment,
      examTags: normalizeExamTags(item.examTags, item),
    };
    });
    const difficultyProfiles = knowledgeDifficultyProfiles(normalized);
    const assessed = normalized.map((question) => {
      const assessment = estimateDifficulty(question, difficultyProfiles);
      const usesManualDifficulty = question.difficultyAssessment.source === "manual" && question.difficultyAssessment.status === "confirmed";
      const hasKnowledgeAssessment = assessment.knowledgeDepthScore > 0 || assessment.contentObscurityScore > 0;
      const resolvedDifficultyScore = usesManualDifficulty ? normalizeDifficultyScore(question.difficultyScore) : assessment.score;
      return {
        ...question,
        primaryKnowledgePoint: assessment.knowledgePoint,
        difficultyScore: resolvedDifficultyScore,
        difficultyStars: difficultyStars(resolvedDifficultyScore),
        difficultyAssessment: usesManualDifficulty ? question.difficultyAssessment : {
          status: hasKnowledgeAssessment ? "suggested" : "unassessed",
          source: hasKnowledgeAssessment ? "knowledge_rule" : "",
          confidence: assessment.confidence,
          reason: assessment.reason,
          assessedAt: question.difficultyAssessment.assessedAt,
          score: resolvedDifficultyScore,
          groupSize: assessment.groupSize,
          knowledgeDepthScore: assessment.knowledgeDepthScore,
          knowledgeObscurityScore: assessment.knowledgeObscurityScore,
          contentObscurityScore: assessment.contentObscurityScore,
        },
      };
    });
    let frequencyPapers = [];
    try {
      frequencyPapers = frequencyPaperProvider();
    } catch (_error) {
      frequencyPapers = [];
    }
    const profiles = frequencyProfiles(assessed, frequencyPapers);
    const withFrequency = assessed.map((question) => ({
      ...question,
      examTrack: inferExamTrack(question),
      frequency: questionFrequency(question, profiles),
    }));
    return decorateQuestionGroups(withFrequency);
  };
  const write = (questions) => adapter.write(questions.map(clone));
  return {
    setFrequencyPaperProvider(provider) {
      frequencyPaperProvider = typeof provider === "function" ? provider : (() => []);
    },
    exportState: () => clone(adapter.read()),
    replaceState(state) {
      if (!Array.isArray(state)) throw new Error("question_state_invalid");
      write(state);
      return clone(adapter.read());
    },
    backfillDifficultyScores() {
      const raw = adapter.read();
      const missing = raw.filter((question) => !Number.isFinite(Number(question.difficultyScore)));
      if (!missing.length) return 0;
      write(raw.map((question) => ({
        ...question,
        difficultyScore: normalizeDifficultyScore(question.difficultyScore),
        difficultyStars: difficultyStars(question.difficultyScore),
      })));
      return missing.length;
    },
    catalog() {
      return { project: examProject, subjects: clone(subjects), books: clone(books), questionTypes: questionTypes.map(([id, label]) => ({ id, label })) };
    },
    list(filters = {}) {
      const query = String(filters.query || "").trim().toLowerCase();
      const all = read();
      const listed = filters.includeMergedSources === true
        ? all
        : all.filter((question) => !mergedQuestionTargetId(question));
      const questions = listed.filter((question) => {
        if (filters.library && question.library !== filters.library) return false;
        if (filters.status && filters.status !== "all" && question.status !== filters.status) return false;
        if (filters.subjectId && filters.subjectId !== "all" && question.subjectId !== filters.subjectId) return false;
        if (Array.isArray(filters.subjectIds) && filters.subjectIds.length && !filters.subjectIds.includes(question.subjectId)) return false;
        if (filters.bookId && filters.bookId !== "all" && question.bookId !== filters.bookId) return false;
        if (Array.isArray(filters.bookIds) && filters.bookIds.length && !filters.bookIds.includes(question.bookId)) return false;
        if (filters.chapter && filters.chapter !== "all" && question.chapter !== filters.chapter) return false;
        if (filters.type && filters.type !== "all" && question.type !== filters.type) return false;
        if (filters.importBatchId && filters.importBatchId !== "all" && question.importBatchId !== filters.importBatchId) return false;
        if (Array.isArray(filters.difficultyStars) && filters.difficultyStars.length && !filters.difficultyStars.includes(question.difficultyStars)) return false;
        if (query && ![
          question.stem,
          question.chapter,
          ...(question.knowledgePoints || []),
          ...(question.subKnowledgePoints || []),
          ...(question.options || []).flatMap((option) => [option.key, option.text]),
          question.referenceAnswer,
          question.sourceLabel,
          question.id,
        ]
          .join(" ").toLowerCase().includes(query)) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt);
      return {
        questions,
        counts: {
          official: countQuestionUnits(listed.filter((item) => item.library === "official")),
          pendingOfficial: countQuestionUnits(listed.filter((item) => item.library === "official" && item.status === "pending_review")),
          unreviewed: countQuestionUnits(listed.filter((item) => item.library === "official" && item.answerReviewStatus === "unreviewed")),
          doubtful: countQuestionUnits(listed.filter((item) => item.library === "official" && item.answerReviewStatus === "doubtful")),
          public: countQuestionUnits(listed.filter((item) => item.library === "public" && item.status === "public")),
          featured: countQuestionUnits(listed.filter((item) => item.library === "public" && item.status === "featured")),
          pending: countQuestionUnits(listed.filter((item) => item.library === "public" && item.status === "pending_review")),
          offline: countQuestionUnits(listed.filter((item) => item.status === "offline")),
        },
      };
    },
    get(id) {
      const question = read().find((item) => item.id === id);
      return question ? clone(question) : null;
    },
    getMany(ids) {
      const requestedIds = (Array.isArray(ids) ? ids : []).map((id) => String(id));
      if (!requestedIds.length) return [];
      const requested = new Set(requestedIds);
      const byId = new Map(read()
        .filter((question) => requested.has(String(question.id)))
        .map((question) => [String(question.id), question]));
      return requestedIds.map((id) => byId.has(id) ? clone(byId.get(id)) : null);
    },
    importBatches() {
      return summarizeImportBatches(read());
    },
    deleteMany(ids) {
      const requestedIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 500);
      if (!requestedIds.length) throw new Error("question_delete_empty");
      const requested = new Set(requestedIds);
      const questions = read();
      const requestedGroups = new Set(questions
        .filter((question) => requested.has(question.id))
        .map((question) => questionGroupId(question))
        .filter(Boolean));
      const deleted = questions.filter((question) => requested.has(question.id) || requestedGroups.has(questionGroupId(question)));
      const deletedIds = new Set(deleted.map((question) => question.id));
      if (deleted.some((question) => mergedQuestionTargetId(question))) {
        throw new Error("question_merged_source_read_only");
      }
      if (questions.some((question) => mergedQuestionTargetId(question) && deletedIds.has(mergedQuestionTargetId(question)))) {
        throw new Error("question_merge_target_delete_forbidden");
      }
      if (deleted.length) write(questions.filter((question) => !deletedIds.has(question.id)));
      return {
        deleted: deleted.map(clone),
        notFoundIds: requestedIds.filter((id) => !deletedIds.has(id)),
      };
    },
    create(payload, actor = "超级管理员") {
      const questions = read();
      const question = buildNewQuestion(payload, actor);
      if (questions.some((item) => item.id === question.id)) throw new Error("question_id_exists");
      write([question, ...questions]);
      return clone(question);
    },
    previewImport(payloads, actor = "超级管理员") {
      if (!Array.isArray(payloads) || !payloads.length) throw new Error("question_import_empty");
      const existingQuestions = read();
      const persistedIds = new Set(existingQuestions.map((question) => question.id));
      const persistedById = new Map(existingQuestions.map((question) => [question.id, question]));
      const canonicalQuestion = (question) => persistedById.get(mergedQuestionTargetId(question)) || question;
      const existingIds = new Set(persistedIds);
      const questionOwners = new Map();
      const questionOwnerIndexes = new Map();
      const fingerprintOwners = new Map();
      const stemOwners = new Map();
      existingQuestions.forEach((question) => {
        const owner = canonicalQuestion(question);
        questionOwners.set(question.id, owner);
        questionOwners.set(owner.id, owner);
        fingerprintOwners.set(questionFingerprint(question), owner.id);
        stemOwners.set(questionStemFingerprint(question), owner.id);
      });
      return payloads.map((payload, index) => {
        const sourceRange = payload && payload.sourceRange
          && Number.isInteger(payload.sourceRange.start)
          && Number.isInteger(payload.sourceRange.end)
          ? { start: payload.sourceRange.start, end: payload.sourceRange.end }
          : null;
        try {
          const question = buildNewQuestion({ ...payload, library: "official", changeNote: "批量文本导入" }, actor, Date.now() + index);
          if (existingIds.has(question.id)) throw new Error("question_id_exists");
          const fingerprint = questionFingerprint(question);
          const stemFingerprint = questionStemFingerprint(question);
          const duplicateOf = fingerprintOwners.get(fingerprint) || stemOwners.get(stemFingerprint);
          if (duplicateOf) {
            const existingQuestion = questionOwners.has(duplicateOf) ? clone(questionOwners.get(duplicateOf)) : null;
            const duplicateScope = persistedIds.has(duplicateOf) ? "stored" : "batch";
            return {
              index,
              valid: false,
              duplicate: true,
              duplicateOf,
              duplicateScope,
              duplicateIndex: duplicateScope === "batch" ? questionOwnerIndexes.get(duplicateOf) : null,
              error: "question_duplicate",
              sourceRange,
              source: { stem: question.stem.slice(0, 200) },
              question,
              existingQuestion,
            };
          }
          existingIds.add(question.id);
          questionOwners.set(question.id, question);
          questionOwnerIndexes.set(question.id, index);
          fingerprintOwners.set(fingerprint, question.id);
          stemOwners.set(stemFingerprint, question.id);
          return { index, valid: true, question, sourceRange };
        } catch (error) {
          return {
            index,
            valid: false,
            error: error.message,
            details: error.message === "question_choice_answer_invalid"
              ? choiceValidationDetails(payload)
              : (error.message === "question_required_fields_missing" ? requiredFieldDetails(payload) : undefined),
            sourceRange,
            source: { stem: String(payload && payload.stem || "").slice(0, 200) },
          };
        }
      });
    },
    importMany(payloads, actor = "超级管理员") {
      const batchId = `question-import-${crypto.randomUUID()}`;
      const batchLabel = String(payloads.find((payload) => payload && payload.sourceLabel)?.sourceLabel || "批量文本导入").trim().slice(0, 200);
      const batchedPayloads = payloads.map((payload) => ({ ...payload, importBatchId: batchId, importBatchLabel: batchLabel }));
      const preview = this.previewImport(batchedPayloads, actor);
      const questions = read();
      const created = preview.filter((item) => item.valid).map((item) => item.question);
      if (created.length) write([...created.reverse(), ...questions]);
      return {
        created: created.map(clone),
        duplicates: preview.filter((item) => item.duplicate).map(({ question, existingQuestion, ...item }) => item),
        errors: preview.filter((item) => !item.valid && !item.duplicate).map(({ question, ...item }) => item),
        total: preview.length,
        batchId,
      };
    },
    updateImportBatch(batchId, payload, actor = "超级管理员") {
      const subjectId = String(payload && payload.subjectId || "");
      const bookId = String(payload && payload.bookId || "");
      const subject = subjects.find((item) => item.id === subjectId);
      const book = books.find((item) => item.id === bookId && item.subjectId === subjectId);
      if (!subject || !book) throw new Error("question_catalog_required");
      const questions = read();
      const indexes = questions.map((question, index) => question.importBatchId === batchId ? index : -1).filter((index) => index >= 0);
      if (!indexes.length) throw new Error("question_import_batch_not_found");
      indexes.forEach((index) => assertQuestionNotMergedSource(questions[index]));
      const now = Date.now();
      indexes.forEach((index, offset) => {
        const current = questions[index];
        const normalized = validateQuestionPayload({ subjectId, bookId }, current);
        const nextVersion = Number(current.version || 1) + 1;
        questions[index] = {
          ...current,
          ...normalized,
          importBatchId: batchId,
          version: nextVersion,
          updatedAt: now + offset,
          updatedBy: actor,
          versions: [{
            version: nextVersion,
            updatedAt: now + offset,
            updatedBy: actor,
            changeNote: "批次统一修改科目与教材",
            previousSnapshot: questionSnapshot(current),
          }, ...(current.versions || [])].slice(0, 50),
        };
      });
      write(questions);
      return {
        batch: summarizeImportBatches(questions).find((batch) => batch.id === batchId),
        updated: indexes.map((index) => clone(questions[index])),
      };
    },
    update(id, payload, actor = "超级管理员") {
      const questions = read();
      const index = questions.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("question_not_found");
      const current = questions[index];
      assertQuestionNotMergedSource(current);
      const normalized = validateQuestionPayload(payload, current);
      const nextVersion = Number(current.version || 1) + 1;
      const now = Date.now();
      questions[index] = {
        ...current,
        ...normalized,
        status: current.library === "official" && current.status !== "offline"
          ? (normalized.answerReviewStatus === "verified" ? "official" : "pending_review")
          : current.status,
        version: nextVersion,
        updatedAt: now,
        updatedBy: actor,
        versions: [{
          version: nextVersion,
          updatedAt: now,
          updatedBy: actor,
          changeNote: String(payload.changeNote || "编辑题目"),
          previousSnapshot: questionSnapshot(current),
        }, ...(current.versions || [])].slice(0, 50),
      };
      write(questions);
      return clone(questions[index]);
    },
    transition(id, action, actor = "超级管理员") {
      const questions = read();
      const index = questions.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("question_not_found");
      const current = questions[index];
      assertQuestionNotMergedSource(current);
      if (action === "promote_official" && current.answerReviewStatus !== "verified") throw new Error("question_answer_review_required");
      const transitions = {
        publish: { library: "public", status: "public", note: "通过审核，进入公共题库" },
        feature: { library: "public", status: "featured", note: "进入公共精选题库" },
        offline: { status: "offline", note: "内容下架" },
        restore: { status: current.library === "official" ? (current.answerReviewStatus === "verified" ? "official" : "pending_review") : "public", note: "恢复题目" },
        promote_official: { library: "official", status: "official", note: "从公共题库转入平台题库" },
      };
      const transition = transitions[action];
      if (!transition) throw new Error("question_transition_invalid");
      const now = Date.now();
      const nextVersion = Number(current.version || 1) + 1;
      questions[index] = {
        ...current,
        ...transition,
        version: nextVersion,
        updatedAt: now,
        updatedBy: actor,
        versions: [{ version: nextVersion, updatedAt: now, updatedBy: actor, changeNote: transition.note }, ...(current.versions || [])].slice(0, 50),
      };
      delete questions[index].note;
      write(questions);
      return clone(questions[index]);
    },
    transitionMany(ids, action, actor = "超级管理员") {
      if (!["offline", "restore"].includes(action)) throw new Error("question_transition_invalid");
      const requested = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
      if (!requested.size) throw new Error("question_transition_empty");
      const questions = read();
      const requestedGroups = new Set(questions
        .filter((question) => requested.has(question.id))
        .map((question) => questionGroupId(question))
        .filter(Boolean));
      const targets = questions.filter((question) => requested.has(question.id) || requestedGroups.has(questionGroupId(question)));
      if (!targets.length) throw new Error("question_not_found");
      targets.forEach(assertQuestionNotMergedSource);
      targets.forEach((question) => this.transition(question.id, action, actor));
      return targets.map((question) => this.get(question.id));
    },
  };
}

function createFileQuestionStore(filePath = path.resolve(__dirname, "../../../.runtime/questions.json")) {
  let cachedQuestions = null;
  let cachedSignature = "";
  return createQuestionStore({
    read() {
      try {
        const stats = fs.statSync(filePath);
        const signature = `${stats.size}:${stats.mtimeMs}`;
        if (cachedQuestions && cachedSignature === signature) return cachedQuestions;
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        cachedQuestions = Array.isArray(value) ? value : seedQuestions();
        cachedSignature = signature;
        return cachedQuestions;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!cachedQuestions) cachedQuestions = seedQuestions();
        return cachedQuestions;
      }
    },
    write(questions) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(questions, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
      const stats = fs.statSync(filePath);
      cachedQuestions = questions;
      cachedSignature = `${stats.size}:${stats.mtimeMs}`;
    },
  });
}

function createMemoryQuestionStore(initialQuestions = seedQuestions()) {
  let questions = clone(initialQuestions);
  return createQuestionStore({ read: () => clone(questions), write: (next) => { questions = clone(next); } });
}

module.exports = {
  createFileQuestionStore,
  createMemoryQuestionStore,
  questionTypes,
  normalizeDifficultyScore,
  difficultyStars,
  normalizeExamTags,
};
