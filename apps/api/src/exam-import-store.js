const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { scoringPointStructure } = require("./scoring-point-structure");
const { normalizeClassicalWordStem } = require("./classical-word-marker");
const { normalizeMaterialMarks } = require("./material-mark");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeAnswerReviewStatus(value, answerSource) {
  if (["team_verified", "community_consensus"].includes(answerSource)) return "verified";
  if (["unreviewed", "doubtful", "verified"].includes(value.answerReviewStatus)) return value.answerReviewStatus;
  if (value.answerVerified === true) return "verified";
  return ["pdf_answer", "ai_supplement"].includes(answerSource) ? "unreviewed" : "verified";
}

function normalizeAnswerVariants(value = {}, referenceAnswer = "", answerSource = "missing") {
  const variants = value && typeof value === "object" ? value : {};
  return {
    official: String(variants.official || (["pdf_answer", "team_verified"].includes(answerSource) ? referenceAnswer : "")).trim().slice(0, 20000),
    ai: String(variants.ai || (answerSource === "ai_supplement" ? referenceAnswer : "")).trim().slice(0, 20000),
    community: String(variants.community || (answerSource === "community_consensus" ? referenceAnswer : "")).trim().slice(0, 20000),
  };
}

function normalizeHiddenAnswerVariants(value) {
  const allowed = new Set(["official", "ai", "community"]);
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter((item) => allowed.has(item)))];
}

function normalizeMetadata(value = {}) {
  return {
    title: String(value.title || "").trim().slice(0, 120),
    description: String(value.description || "").trim().slice(0, 1000),
    kind: value.kind === "past_paper" ? "past_paper" : "official_mock",
    year: Math.max(2000, Math.min(2100, Number(value.year) || new Date().getFullYear())),
    durationMinutes: Math.max(10, Math.min(300, Number(value.durationMinutes) || 120)),
    totalQuestionCount: Math.max(0, Math.min(500, Number(value.totalQuestionCount) || 0)),
    totalResponseItemCount: Math.max(0, Math.min(1000, Number(value.totalResponseItemCount) || 0)),
    freePreviewQuestionCount: Math.max(0, Number(value.freePreviewQuestionCount) || 0),
    projectId: String(value.projectId || "gd-zsb-2026-hywxxkjc"),
  };
}

function normalizeQuestion(value = {}, index = 0) {
  const referenceAnswer = String(value.referenceAnswer || "").trim().slice(0, 20000);
  const answerSource = ["pdf_answer", "team_verified", "ai_supplement", "community_consensus", "missing"].includes(value.answerSource) ? value.answerSource : "missing";
  const classicalWord = String(value.type || "").trim() === "classical_word_explanation"
    ? normalizeClassicalWordStem({ stem: value.stem, annotationText: value.annotationText || value.markingText, referenceAnswer })
    : null;
  const answerReviewStatus = classicalWord?.needsReview ? "doubtful" : normalizeAnswerReviewStatus(value, answerSource);
  const answerVariants = normalizeAnswerVariants(value.answerVariants, referenceAnswer, answerSource);
  const scoringPoints = Array.isArray(value.scoringPoints) ? value.scoringPoints.slice(0, 30).map((point) => ({
    description: String(point && (point.description || point.point) || "").trim(),
    score: Number(point && (point.score ?? point.points)),
    textbookPage: String(point && (point.textbookPage || point.textbookPages) || "").trim().slice(0, 100),
    pageBasis: ["confirmed_catalog", "textbook_text", "manual"].includes(point && point.pageBasis) ? point.pageBasis : "",
    sourceNote: String(point && point.sourceNote || "").trim().slice(0, 500),
  })).filter((point) => point.description && Number.isFinite(point.score) && point.score > 0) : [];
  const maxScore = Number(value.maxScore) || 1;
  const scoringStructure = scoringPointStructure(String(value.type || "").trim(), referenceAnswer, scoringPoints, maxScore);
  return {
    localId: String(value.localId || `recognized-${index + 1}`),
    included: value.included !== false,
    sectionTitle: String(value.sectionTitle || "").trim().slice(0, 200),
    number: String(value.number || index + 1).trim().slice(0, 40),
    type: String(value.type || "").trim(),
    subjectId: String(value.subjectId || "").trim(),
    bookId: String(value.bookId || "").trim(),
    stem: String(classicalWord?.stem ?? value.stem ?? "").trim().slice(0, 12000),
    options: Array.isArray(value.options) ? value.options.slice(0, 12).map((option, optionIndex) => ({
      key: String(option && option.key || String.fromCharCode(65 + optionIndex)).trim().toUpperCase(),
      text: String(option && option.text || "").trim(),
    })).filter((option) => option.key && option.text) : [],
    correctAnswer: Array.isArray(value.correctAnswer)
      ? value.correctAnswer.map(String)
      : String(value.correctAnswer || "").split(/[，,、\s]/).filter(Boolean),
    referenceAnswer,
    answerVariants,
    hiddenAnswerVariants: normalizeHiddenAnswerVariants(value.hiddenAnswerVariants),
    answerSource,
    answerReviewStatus,
    answerVerified: answerReviewStatus === "verified",
    scoringPoints,
    scoringPointStatus: scoringStructure.status,
    scoringPointCandidates: scoringStructure.candidates,
    scoringPolicy: value.scoringPolicy && ["double_choice_partial", "double_choice_no_partial"].includes(value.scoringPolicy.mode) ? {
      mode: value.scoringPolicy.mode,
      oneCorrectScore: value.scoringPolicy.mode === "double_choice_partial" ? Math.max(0, Number(value.scoringPolicy.oneCorrectScore) || 0) : 0,
      allCorrectScore: Math.max(0, Number(value.scoringPolicy.allCorrectScore) || Number(value.maxScore) || 0),
      extraOptionScore: Math.max(0, Number(value.scoringPolicy.extraOptionScore) || 0),
      emptyScore: Math.max(0, Number(value.scoringPolicy.emptyScore) || 0),
    } : null,
    maxScore,
    material: String(value.material || "").trim().slice(0, 20000),
    materialMarks: normalizeMaterialMarks(value.materialMarks),
    materialGroupId: String(value.materialGroupId || "").trim().slice(0, 120),
    usesSharedMaterial: value.usesSharedMaterial !== false,
    groupNumber: String(value.groupNumber || "").trim().slice(0, 40),
    subNumber: String(value.subNumber || "").trim().slice(0, 40),
    responseMode: value.responseMode === "annotation" ? "annotation" : "text",
    annotationText: String(classicalWord?.target || value.annotationText || "").trim().slice(0, 12000),
    chapter: String(value.chapter || "").trim().slice(0, 500),
    knowledgePoints: (Array.isArray(value.knowledgePoints) ? value.knowledgePoints : String(value.knowledgePoints || "").split(/[，,；;\n]/))
      .map((item) => String(item).trim()).filter(Boolean).slice(0, 20),
    sourcePage: String(value.sourcePage || "").trim().slice(0, 100),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    warnings: [...(Array.isArray(value.warnings) ? value.warnings : []).map(String), ...(classicalWord?.needsReview ? ["加点字词标注缺失，请依据原卷补充“字词：”"] : [])].slice(0, 20),
  };
}

function numberedItems(value) {
  const text = String(value || "").trim();
  const markers = [...text.matchAll(/(?:^|\n)\s*[（(](\d+)[）)]\s*/g)];
  return markers.map((marker, index) => ({
    number: marker[1],
    text: text.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? text.length).trim(),
  })).filter((item) => item.text);
}

function expandLegacyMaterialQuestion(value, index = 0) {
  const question = normalizeQuestion(value, index);
  if (question.material || question.materialGroupId || question.type !== "material_analysis") return [question];
  const promptMarker = question.stem.match(/(?:^|\n)\s*(?:请回答|问题)\s*[：:]?\s*/);
  const questionPart = promptMarker && promptMarker.index != null
    ? question.stem.slice(promptMarker.index + promptMarker[0].length)
    : question.stem;
  const subQuestions = numberedItems(questionPart);
  if (subQuestions.length < 2) return [question];
  const firstSubQuestion = question.stem.search(/(?:^|\n)\s*[（(]\d+[）)]\s*/);
  const materialEnd = promptMarker?.index ?? firstSubQuestion;
  const material = materialEnd >= 0 ? question.stem.slice(0, materialEnd).trim() : "";
  if (!material || !subQuestions.length) return [question];
  const answerItems = numberedItems(question.referenceAnswer);
  const officialAnswerItems = numberedItems(question.answerVariants.official);
  const aiAnswerItems = numberedItems(question.answerVariants.ai);
  const communityAnswerItems = numberedItems(question.answerVariants.community);
  const groupId = `legacy-material-${question.localId}`;
  const dividedScore = Math.max(0.5, Math.round((question.maxScore / subQuestions.length) * 2) / 2);
  return subQuestions.map((subQuestion, subIndex) => ({
    ...question,
    localId: `${question.localId}-sub-${subQuestion.number || subIndex + 1}`,
    material,
    materialGroupId: groupId,
    groupNumber: question.number,
    subNumber: subQuestion.number || String(subIndex + 1),
    stem: subQuestion.text,
    correctAnswer: [],
    referenceAnswer: answerItems.find((item) => item.number === subQuestion.number)?.text || "",
    answerVariants: {
      official: officialAnswerItems.find((item) => item.number === subQuestion.number)?.text || "",
      ai: aiAnswerItems.find((item) => item.number === subQuestion.number)?.text || "",
      community: communityAnswerItems.find((item) => item.number === subQuestion.number)?.text || "",
    },
    answerSource: "missing",
    answerReviewStatus: "unreviewed",
    answerVerified: false,
    scoringPoints: [],
    maxScore: dividedScore,
    warnings: [...new Set([...(question.warnings || []), "已自动拆分共享材料与小问，请核对每问分值、答案和得分点"])],
  }));
}

function expandLegacyMaterialQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).flatMap(expandLegacyMaterialQuestion);
}

function createExamImportStore(adapter) {
  const read = () => adapter.read().map(clone);
  const write = (items) => adapter.write(items.map(clone));
  return {
    exportState: () => clone(adapter.read()),
    list() {
      return read().sort((left, right) => right.updatedAt - left.updatedAt).map((draft) => {
        const questions = expandLegacyMaterialQuestions(draft.questions);
        return ({
        id: draft.id,
        status: draft.status,
        metadata: clone(draft.metadata),
        source: clone(draft.source),
        questionCount: questions.length,
        includedQuestionCount: questions.filter((question) => question.included !== false).length,
        warningCount: draft.warnings.length,
        examId: draft.examId,
        updatedAt: draft.updatedAt,
        updatedBy: draft.updatedBy,
        });
      });
    },
    create(payload, actor = "超级管理员") {
      const items = read();
      const now = Date.now();
      const draft = {
        id: String(payload.id || `exam-import-${crypto.randomUUID()}`),
        status: payload.status === "failed" ? "failed" : "needs_review",
        metadata: normalizeMetadata(payload.metadata),
        questions: expandLegacyMaterialQuestions(payload.questions),
        warnings: (Array.isArray(payload.warnings) ? payload.warnings : []).map(String).slice(0, 100),
        source: {
          fileName: String(payload.source && payload.source.fileName || "").slice(0, 255),
          format: String(payload.source && payload.source.format || "pdf").slice(0, 16),
          size: Number(payload.source && payload.source.size) || 0,
          pageCount: Number(payload.source && payload.source.pageCount) || 0,
          textChars: Number(payload.source && payload.source.textChars) || 0,
          answerFileName: String(payload.source && payload.source.answerFileName || "").slice(0, 255),
          answerFormat: String(payload.source && payload.source.answerFormat || "").slice(0, 16),
          answerSize: Number(payload.source && payload.source.answerSize) || 0,
          answerPageCount: Number(payload.source && payload.source.answerPageCount) || 0,
          answerTextChars: Number(payload.source && payload.source.answerTextChars) || 0,
          answerMatchedCount: Number(payload.source && payload.source.answerMatchedCount) || 0,
          model: String(payload.source && payload.source.model || ""),
        },
        error: String(payload.error || ""),
        examId: "",
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
        updatedBy: actor,
      };
      write([draft, ...items]);
      return clone(draft);
    },
    get(id) {
      const item = read().find((draft) => draft.id === id);
      return item ? clone({ ...item, questions: expandLegacyMaterialQuestions(item.questions) }) : null;
    },
    update(id, payload, actor = "超级管理员") {
      const items = read();
      const index = items.findIndex((draft) => draft.id === id);
      if (index < 0) throw new Error("exam_import_not_found");
      if (items[index].status === "confirmed") throw new Error("exam_import_already_confirmed");
      const current = items[index];
      items[index] = {
        ...current,
        metadata: normalizeMetadata({ ...current.metadata, ...(payload.metadata || {}) }),
        questions: Array.isArray(payload.questions) ? expandLegacyMaterialQuestions(payload.questions) : expandLegacyMaterialQuestions(current.questions),
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String).slice(0, 100) : current.warnings,
        source: payload.source ? {
          ...current.source,
          answerMatchedCount: Math.max(0, Number(payload.source.answerMatchedCount) || 0),
        } : current.source,
        status: "needs_review",
        updatedAt: Date.now(),
        updatedBy: actor,
      };
      write(items);
      return clone(items[index]);
    },
    confirm(id, examId, actor = "超级管理员") {
      const items = read();
      const index = items.findIndex((draft) => draft.id === id);
      if (index < 0) throw new Error("exam_import_not_found");
      if (items[index].status === "confirmed") throw new Error("exam_import_already_confirmed");
      items[index] = { ...items[index], status: "confirmed", examId: String(examId), updatedAt: Date.now(), updatedBy: actor };
      write(items);
      return clone(items[index]);
    },
    remove(id) {
      const items = read();
      const index = items.findIndex((draft) => draft.id === id);
      if (index < 0) throw new Error("exam_import_not_found");
      if (items[index].status === "confirmed") throw new Error("exam_import_already_confirmed");
      const [removed] = items.splice(index, 1);
      write(items);
      return clone(removed);
    },
  };
}

function createFileExamImportStore(filePath = path.resolve(__dirname, "../../../.runtime/exam-imports.json")) {
  return createExamImportStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(value) ? value : [];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return [];
      }
    },
    write(items) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryExamImportStore(initialItems = []) {
  let items = clone(initialItems);
  return createExamImportStore({ read: () => clone(items), write: (next) => { items = clone(next); } });
}

module.exports = { createFileExamImportStore, createMemoryExamImportStore, expandLegacyMaterialQuestions };
