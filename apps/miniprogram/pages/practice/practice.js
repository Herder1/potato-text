const { closeTransientLayers } = require("../../utils/page-layers");
const { demoQuestion, demoQuestions } = require("../../data/catalog");
const {
  buildAnswerCard,
  buildQuestionQueue,
  calculateExamResult,
  countQuestionUnits,
  evaluateAnswer,
  evaluateQuestionAnswer,
  groupQuestionUnits,
} = require("../../utils/practice-session");
const {
  createInitialReviewState,
  normalizeReviewStates,
  saveReviewState,
  scheduleReview,
} = require("../../utils/review-schedule");
const {
  isValidScoreResult,
  scoreSubjectiveAnswer,
} = require("../../utils/subjective-scoring");
const { formatAnswerMarkdownNodes } = require("../../utils/answer-markdown");
const { buildCatalogOutline, createProjectedCatalogChapters } = require("../../utils/catalog-outline");
const { noteAutoArchiveEnabled, questionNoteContent, saveQuestionNote, setNoteAutoArchiveEnabled } = require("../../utils/question-note-store");

const RULE_EXAM_STORAGE_KEY = "shukao_rule_exam_session";

const questionTypeDefinitions = [
  { type: "single_choice", label: "单选题" },
  { type: "multiple_choice", label: "多选题" },
  { type: "true_false", label: "判断题" },
  { type: "fill_blank", label: "填空题" },
  { type: "punctuation", label: "断句题" },
  { type: "classical_word_explanation", label: "加点字词解释" },
  { type: "translation", label: "古文翻译" },
  { type: "short_answer", label: "简答题" },
  { type: "term_definition", label: "名词解释" },
  { type: "material_analysis", label: "材料分析题" },
  { type: "appreciation", label: "作品赏析题" },
  { type: "essay", label: "论述题" },
];

function createCatalogChapters(queue, activeQuestionId = "", outline = []) {
  return createProjectedCatalogChapters(outline, queue, activeQuestionId);
}

function isExamPunctuationQuestion(question) {
  const stem = String(question && question.stem || "").replace(/\s+/g, "");
  if (!question || !["punctuation", "short_answer"].includes(question.type)) return false;
  return question.type === "punctuation"
    || /(?:断句|用[“\"']?\/[”\"']?给下列|加上标点)/.test(stem);
}

function isExamWordExplanationQuestion(question) {
  if (!question) return false;
  if (question.type === "classical_word_explanation") return true;
  const stem = String(question.stem || "").trim();
  return question.type === "term_definition"
    && /[：:]\s*$/.test(stem)
    && /[（(].*[）)]/.test(stem);
}

function createExamCatalogChapters(queue, activeQuestionId = "") {
  const definitions = [
    { id: "exam-single-choice", title: "一、单选题", match: (question) => question.type === "single_choice" },
    { id: "exam-multiple-choice", title: "二、多选题", match: (question) => question.type === "multiple_choice" },
    { id: "exam-recitation", title: "三、名句默写题", match: (question) => question.type === "fill_blank" },
    {
      id: "exam-classical-language",
      title: "四、古文解释与断句",
      sections: [
        { id: "exam-word-explanation", title: "（一）字词解释", match: isExamWordExplanationQuestion },
        { id: "exam-punctuation", title: "（二）断句", match: isExamPunctuationQuestion },
      ],
    },
    {
      id: "exam-short-answer",
      title: "五、简答题",
      match: (question) => question.type === "short_answer" && !isExamPunctuationQuestion(question),
    },
    { id: "exam-material-analysis", title: "六、材料分析题", match: (question) => question.type === "material_analysis" },
  ];
  const assignedIds = new Set();
  const chapters = definitions.map((definition) => {
    const sections = (definition.sections || []).map((section) => {
      const questions = queue.filter((question) => !assignedIds.has(question.id) && section.match(question));
      questions.forEach((question) => assignedIds.add(question.id));
      return {
        id: section.id,
        title: section.title,
        level: 2,
        parentId: definition.id,
        questionId: questions[0] && questions[0].id || "",
        questionIds: questions.map((question) => question.id),
        questionCount: countQuestionUnits(questions),
      };
    }).filter((section) => section.questionCount > 0);
    const directQuestions = definition.match
      ? queue.filter((question) => !assignedIds.has(question.id) && definition.match(question))
      : [];
    directQuestions.forEach((question) => assignedIds.add(question.id));
    const questionIds = sections.length
      ? sections.flatMap((section) => section.questionIds)
      : directQuestions.map((question) => question.id);
    return {
      id: definition.id,
      title: definition.title,
      expanded: questionIds.includes(activeQuestionId),
      questionId: questionIds[0] || "",
      questionIds,
      questionCount: countQuestionUnits(queue.filter((question) => questionIds.includes(question.id))),
      sections,
    };
  }).filter((chapter) => chapter.questionCount > 0);
  const unclassifiedQuestions = queue.filter((question) => !assignedIds.has(question.id));
  if (unclassifiedQuestions.length) {
    chapters.push({
      id: "exam-other",
      title: "其他题型",
      expanded: unclassifiedQuestions.some((question) => question.id === activeQuestionId),
      questionId: unclassifiedQuestions[0].id,
      questionIds: unclassifiedQuestions.map((question) => question.id),
      questionCount: countQuestionUnits(unclassifiedQuestions),
      sections: [],
    });
  }
  return chapters;
}

function findCatalogLocation(chapters, questionId) {
  for (const chapter of chapters || []) {
    const section = (chapter.sections || [])
      .filter((item) => (item.questionIds || []).includes(questionId))
      .sort((left, right) => Number(right.level || 0) - Number(left.level || 0))[0];
    if (section) return { chapterId: chapter.id, sectionId: section.id };
    if ((chapter.questionIds || []).includes(questionId)) return { chapterId: chapter.id, sectionId: "" };
  }
  return { chapterId: "", sectionId: "" };
}

function createQuestionTypeOptions(questionBank) {
  const units = groupQuestionUnits(questionBank);
  return questionTypeDefinitions.map((definition) => ({
    ...definition,
    count: units.filter((unit) => unit.questions.some((question) => question.type === definition.type)).length,
  }));
}

function normalizeDifficultyScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.min(100, Math.max(1, Math.round(score))) : 50;
}

function difficultyStars(value) {
  return Math.min(5, Math.max(1, Math.ceil(normalizeDifficultyScore(value) / 20)));
}

function decorateQuestionMeta(question) {
  if (!question) return question;
  const stars = Number(question.difficultyStars) || difficultyStars(question.difficultyScore);
  const frequency = question.frequency?.label;
  return {
    ...question,
    difficultyScore: normalizeDifficultyScore(question.difficultyScore),
    difficultyStars: stars,
    difficultyLabel: "★".repeat(stars),
    examTrackLabel: ({ insert: "插本", upgrade: "专升本", graduate: "考研" })[question.examTrack] || "",
    frequencyLabel: frequency && frequency !== "样本不足" ? `考频 ${frequency}` : "",
  };
}

function createDifficultyOptions(selectedStars = []) {
  const selected = new Set(selectedStars.map(Number));
  return [1, 2, 3, 4, 5].map((value) => ({
    value,
    label: "★".repeat(value),
    selected: selected.has(value),
  }));
}

function filterTrainingPool(questions, subjectIds = [], bookIds = [], stars = []) {
  const subjects = new Set(subjectIds || []);
  const books = new Set(bookIds || []);
  const difficulties = new Set((stars || []).map(Number));
  return (questions || []).filter((question) => (!subjects.size || subjects.has(question.subjectId))
    && (!books.size || books.has(question.bookId))
    && (!difficulties.size || difficulties.has(Number(question.difficultyStars) || 0)));
}

function createScopeOptions(questions, selectedSubjectIds = [], selectedBookIds = []) {
  const subjectSet = new Set(selectedSubjectIds);
  const bookSet = new Set(selectedBookIds);
  const subjects = new Map();
  const books = new Map();
  (questions || []).forEach((question) => {
    if (!subjects.has(question.subjectId)) subjects.set(question.subjectId, question.subjectName || question.subjectId);
    if (!books.has(question.bookId)) books.set(question.bookId, { title: question.bookTitle || question.bookId, subjectId: question.subjectId });
  });
  return {
    subjects: [...subjects.entries()].map(([id, label]) => ({ id, label, selected: subjectSet.has(id) })),
    books: [...books.entries()].map(([id, value]) => ({ id, label: value.title, subjectId: value.subjectId, selected: bookSet.has(id) })),
  };
}

function isSubjectiveQuestion(question) {
  return !!question && question.answerMode === "text";
}

function normalizePracticeSelection(selected) {
  if (Array.isArray(selected)) return selected.filter(Boolean);
  return selected ? [selected] : [];
}

function shuffleOptionOrder(options, random = Math.random) {
  const keys = (Array.isArray(options) ? options : []).map((option) => option.key).filter(Boolean);
  const shuffled = [...keys];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  if (shuffled.length > 1 && shuffled.every((key, index) => key === keys[index])) {
    shuffled.push(shuffled.shift());
  }
  return shuffled;
}

function restoreOriginalOptions(question) {
  const decorated = decorateQuestionMeta(question);
  if (!decorated || !Array.isArray(decorated.originalOptions)) return decorated;
  return {
    ...decorated,
    options: decorated.originalOptions.map((option) => ({ ...option })),
    correctAnswer: [...(decorated.originalCorrectAnswer || [])],
    correctAnswerText: decorated.originalCorrectAnswerText || (decorated.originalCorrectAnswer || []).join("、"),
    optionOrder: [],
  };
}

function applyOptionOrder(question, optionOrder) {
  if (!question || !Array.isArray(question.options) || question.options.length < 2) return question;
  const originalOptions = (question.originalOptions || question.options).map((option) => ({ ...option }));
  const originalCorrectAnswer = [...(question.originalCorrectAnswer || question.correctAnswer || [])];
  const displayKeys = originalOptions.map((option) => option.key);
  const sourceByKey = new Map(originalOptions.map((option) => [option.key, option]));
  const order = Array.isArray(optionOrder) ? optionOrder.filter((key) => sourceByKey.has(key)) : [];
  if (order.length !== originalOptions.length || new Set(order).size !== originalOptions.length) {
    return restoreOriginalOptions({
      ...question,
      originalOptions,
      originalCorrectAnswer,
      originalCorrectAnswerText: question.originalCorrectAnswerText || question.correctAnswerText || originalCorrectAnswer.join("、"),
    });
  }
  const sourceToDisplay = {};
  const options = displayKeys.map((displayKey, index) => {
    const source = sourceByKey.get(order[index]);
    sourceToDisplay[source.key] = displayKey;
    return { ...source, key: displayKey, sourceKey: source.key };
  });
  const correctAnswer = originalCorrectAnswer.map((key) => sourceToDisplay[key]).filter(Boolean);
  return {
    ...question,
    originalOptions,
    originalCorrectAnswer,
    originalCorrectAnswerText: question.originalCorrectAnswerText || question.correctAnswerText || originalCorrectAnswer.join("、"),
    options,
    correctAnswer,
    correctAnswerText: correctAnswer.join("、"),
    optionOrder: [...order],
  };
}

function normalizeQuestionSubNumber(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^[\s(\[【]+/, "")
    .replace(/[\s)\]】]+$/, "");
}

const materialMarkLabels = {
  underline: "下划线",
  double_underline: "双下划线",
  wave: "波浪线",
  dot: "加点",
};

function materialMarkIndex(material, target, occurrence = 1) {
  let fromIndex = 0;
  let found = -1;
  for (let index = 0; index < occurrence; index += 1) {
    found = material.indexOf(target, fromIndex);
    if (found < 0) return -1;
    fromIndex = found + target.length;
  }
  return found;
}

function buildMaterialSegments(question) {
  const material = String(question && question.material || "");
  const ranges = (Array.isArray(question && question.materialMarks) ? question.materialMarks : []).map((mark) => {
    const type = String(mark && mark.type || "");
    const text = String(mark && mark.text || "").trim();
    const start = materialMarkLabels[type] && text ? materialMarkIndex(material, text, Math.max(1, Number(mark.occurrence) || 1)) : -1;
    return start >= 0 ? { start, end: start + text.length, type, label: materialMarkLabels[type] } : null;
  }).filter(Boolean).sort((left, right) => left.start - right.start || right.end - left.end);
  const accepted = [];
  ranges.forEach((range) => {
    if (!accepted.some((item) => range.start < item.end && range.end > item.start)) accepted.push(range);
  });
  const segments = [];
  let cursor = 0;
  accepted.forEach((range, index) => {
    if (range.start > cursor) segments.push({ id: `material-plain-${index}`, text: material.slice(cursor, range.start), type: "plain" });
    segments.push({ id: `material-mark-${index}`, text: material.slice(range.start, range.end), type: range.type, label: range.label });
    cursor = range.end;
  });
  if (cursor < material.length || !segments.length) segments.push({ id: "material-plain-last", text: material.slice(cursor), type: "plain" });
  return {
    segments,
    legend: [...new Map(accepted.map((range) => [range.type, { type: range.type, label: range.label }])).values()],
  };
}

function normalizePracticeQuestion(question) {
  const answerSource = question.answerSource || "team_verified";
  const verifiedAnswerLabel = answerSource === "pdf_answer" ? "来源答案" : "平台核验答案";
  const answerVariants = question.answerVariants || {
    official: ["pdf_answer", "team_verified"].includes(answerSource) ? question.referenceAnswer : "",
    ai: answerSource === "ai_supplement" ? question.referenceAnswer : "",
    community: answerSource === "community_consensus" ? question.referenceAnswer : "",
  };
  const hiddenAnswerVariants = new Set(Array.isArray(question.hiddenAnswerVariants) ? question.hiddenAnswerVariants : []);
  const visibleAnswerVariants = {
    official: hiddenAnswerVariants.has("official") ? "" : answerVariants.official,
    ai: hiddenAnswerVariants.has("ai") ? "" : answerVariants.ai,
    community: hiddenAnswerVariants.has("community") ? "" : answerVariants.community,
  };
  const pageBasisLabels = {
    confirmed_catalog: "已确认目录范围",
    textbook_text: "教材正文依据",
    manual: "人工标注",
  };
  const materialDisplay = buildMaterialSegments(question);
  return decorateQuestionMeta({
    ...question,
    materialSegments: materialDisplay.segments,
    materialMarkLegend: materialDisplay.legend,
    displaySubNumber: normalizeQuestionSubNumber(question.subNumber),
    scoringPoints: (question.scoringPoints || []).map((point) => ({
      ...point,
      textbookPage: String(point.textbookPage || ""),
      pageBasisText: pageBasisLabels[point.pageBasis] || "",
    })),
    answerVariants: visibleAnswerVariants,
    verifiedAnswerLabel,
    hiddenAnswerVariants: [...hiddenAnswerVariants],
    answerVariantNodes: {
      official: formatAnswerMarkdownNodes(visibleAnswerVariants.official),
      ai: formatAnswerMarkdownNodes(visibleAnswerVariants.ai),
      community: formatAnswerMarkdownNodes(visibleAnswerVariants.community),
    },
    referenceAnswerNodes: formatAnswerMarkdownNodes(question.referenceAnswer),
    responseMode: question.responseMode === "annotation" ? "annotation" : "text",
  });
}

function withDemoCatalogProjection(question) {
  if (question.catalogProjection && Array.isArray(question.catalogProjection.anchorNodeIds)) return question;
  const anchorNodeId = String(question.sectionId || question.chapterId || "");
  return {
    ...question,
    catalogProjection: {
      source: "demo_fallback",
      topicFamilyIds: [],
      anchorNodeIds: anchorNodeId ? [anchorNodeId] : [],
    },
  };
}

function createAnnotationTokens(question, response = {}) {
  if (Array.isArray(response.annotationTokens) && response.annotationTokens.length) return response.annotationTokens;
  const text = String(question.annotationText || question.stem || "").slice(0, 600);
  return Array.from(text).map((character, index) => ({
    id: `${question.id}-mark-${index}`,
    character: character === " " ? "\u00a0" : character,
    mark: "",
    symbol: "",
  }));
}

function annotationAnswerText(tokens, note = "") {
  const labels = { underline: "下划线", wave: "波浪线", dot: "着重号", subscript: "下标点" };
  const groups = Object.keys(labels).map((mark) => {
    const text = (tokens || []).filter((token) => token.mark === mark).map((token) => token.character).join("").replace(/\u00a0/g, " ");
    return text ? `${labels[mark]}：${text}` : "";
  }).filter(Boolean);
  return [...groups, String(note || "").trim()].filter(Boolean).join("\n");
}

function reviewDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveResumeIndex(queue, progress, reviewStates = {}) {
  const savedQuestionId = String(progress && progress.questionId || "");
  const savedIndex = savedQuestionId ? queue.findIndex((question) => question.id === savedQuestionId) : -1;
  if (savedIndex >= 0) return savedIndex;
  const firstUnstudiedIndex = queue.findIndex((question) => !reviewStates[question.id]);
  return firstUnstudiedIndex >= 0 ? firstUnstudiedIndex : 0;
}

function resolvePackResumeIndex(queue, progress = {}) {
  const savedQuestionId = String(progress.questionId || "");
  if (!savedQuestionId) return { index: 0, removed: false, fallbackDirection: "" };
  const savedIndex = queue.findIndex((question) => question.id === savedQuestionId);
  if (savedIndex >= 0) return { index: savedIndex, removed: false, fallbackDirection: "" };

  const previousOrder = Array.isArray(progress.questionOrder) ? progress.questionOrder.map(String) : [];
  const previousIndex = previousOrder.indexOf(savedQuestionId);
  if (previousIndex >= 0) {
    for (let index = previousIndex + 1; index < previousOrder.length; index += 1) {
      const currentIndex = queue.findIndex((question) => question.id === previousOrder[index]);
      if (currentIndex >= 0) return { index: currentIndex, removed: true, fallbackDirection: "next" };
    }
    for (let index = previousIndex - 1; index >= 0; index -= 1) {
      const currentIndex = queue.findIndex((question) => question.id === previousOrder[index]);
      if (currentIndex >= 0) return { index: currentIndex, removed: true, fallbackDirection: "previous" };
    }
  }

  const storedIndex = Number(progress.questionIndex);
  return {
    index: Number.isFinite(storedIndex) ? Math.max(0, Math.min(queue.length - 1, storedIndex)) : 0,
    removed: true,
    fallbackDirection: "next",
  };
}

function restorePracticeResponses(queue, attempts, reviewStates = {}) {
  const questionIds = new Set(queue.map((question) => question.id));
  const orderedAttempts = [...(Array.isArray(attempts) ? attempts : [])]
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
  return orderedAttempts.reduce((responses, attempt) => {
    if (!questionIds.has(attempt.questionId) || responses[attempt.questionId]) return responses;
    const state = reviewStates[attempt.questionId];
    const snapshot = attempt.response && typeof attempt.response === "object"
      ? attempt.response
      : null;
    responses[attempt.questionId] = snapshot
      ? {
        ...snapshot,
        submitted: true,
        mastery: snapshot.mastery || attempt.mastery || (state && state.masteryStatus) || "",
      }
      : {
        selected: attempt.selected || "",
        subjectiveAnswer: attempt.selected ? "" : String(attempt.submittedAnswer || ""),
        submitted: true,
        isCorrect: attempt.isCorrect === true,
        mastery: attempt.mastery || (state && state.masteryStatus) || "",
      };
    return responses;
  }, {});
}

function createInitialAiReply(question, context = {}) {
  if (isSubjectiveQuestion(question)) {
    const result = context.subjectiveScoreResult;
    const missedText = result && result.missedPoints.length
      ? `目前主要遗漏：${result.missedPoints.map((point) => point.description).join("；")}。`
      : "当前答案已覆盖结构化得分点。";
    return `这道题考查“${question.knowledgePoint}”。本次评分 ${result ? `${result.totalScore}/${result.maxScore} 分` : "尚未生成"}。${missedText}教材参考答案是：${question.referenceAnswer}。你可以继续追问任一得分点。`;
  }
  return `这道题考查“${question.knowledgePoint}”。正确答案是 ${(question.correctAnswer || []).join("、")}。教材依据：${question.referenceAnswer}判断时先定位题干要求，再逐项核对选项是否完整、准确地符合这一知识点。`;
}

function formatAiHistoryTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return `今天 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function createTextNode(text) {
  return { type: "text", text: String(text || "") };
}

function formatAiInlineNodes(text) {
  const source = String(text || "");
  const nodes = [];
  const tokenPattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let cursor = 0;
  let match = tokenPattern.exec(source);
  while (match) {
    if (match.index > cursor) nodes.push(createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push({ name: "strong", children: [createTextNode(token.slice(2, -2))] });
    } else {
      nodes.push({ name: "code", attrs: { class: "ai-md-inline-code" }, children: [createTextNode(token.slice(1, -1))] });
    }
    cursor = match.index + token.length;
    match = tokenPattern.exec(source);
  }
  if (cursor < source.length) nodes.push(createTextNode(source.slice(cursor)));
  return nodes.length ? nodes : [createTextNode(source)];
}

function formatAiMessageNodes(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const nodes = [];
  let paragraph = [];
  let list = null;
  let codeLines = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const children = [];
    paragraph.forEach((line, index) => {
      if (index) children.push({ name: "br" });
      children.push(...formatAiInlineNodes(line));
    });
    nodes.push({ name: "p", attrs: { class: "ai-md-paragraph" }, children });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    nodes.push({
      name: list.ordered ? "ol" : "ul",
      attrs: { class: "ai-md-list" },
      children: list.items.map((item) => ({ name: "li", children: formatAiInlineNodes(item) })),
    });
    list = null;
  };
  const flushCode = () => {
    if (!codeLines) return;
    nodes.push({
      name: "pre",
      attrs: { class: "ai-md-code-block" },
      children: [{ name: "code", children: [createTextNode(codeLines.join("\n"))] }],
    });
    codeLines = null;
  };

  lines.forEach((line) => {
    if (/^\s*```/.test(line)) {
      if (codeLines) flushCode();
      else {
        flushParagraph();
        flushList();
        codeLines = [];
      }
      return;
    }
    if (codeLines) {
      codeLines.push(line);
      return;
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      nodes.push({
        name: `h${Math.min(4, heading[1].length + 1)}`,
        attrs: { class: "ai-md-heading" },
        children: formatAiInlineNodes(heading[2]),
      });
    } else if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      nodes.push({ name: "hr", attrs: { class: "ai-md-divider" } });
    } else if (unordered || ordered) {
      flushParagraph();
      const isOrdered = !!ordered;
      if (list && list.ordered !== isOrdered) flushList();
      if (!list) list = { ordered: isOrdered, items: [] };
      list.items.push((ordered || unordered)[1]);
    } else if (quote) {
      flushParagraph();
      flushList();
      nodes.push({
        name: "blockquote",
        attrs: { class: "ai-md-quote" },
        children: formatAiInlineNodes(quote[1]),
      });
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  });
  flushParagraph();
  flushList();
  flushCode();
  return nodes;
}

function normalizeAiMessage(message) {
  const text = String((message && message.text) || "");
  return {
    ...message,
    text,
    nodes: message && message.role === "assistant" ? formatAiMessageNodes(text) : [],
  };
}

function normalizeAiHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map((session) => ({
    ...session,
    timeLabel: formatAiHistoryTime(session.updatedAt || Date.now()),
    messages: Array.isArray(session.messages) ? session.messages.map(normalizeAiMessage) : [],
  }));
}

function createUtf8StreamDecoder() {
  if (typeof TextDecoder === "function") {
    const decoder = new TextDecoder("utf-8");
    return {
      decode(chunk) { return decoder.decode(chunk, { stream: true }); },
      flush() { return decoder.decode(); },
    };
  }
  let carry = [];
  const decodeBytes = (chunk, final) => {
    const incoming = chunk ? Array.from(new Uint8Array(chunk)) : [];
    const bytes = carry.concat(incoming);
    let safeLength = bytes.length;
    if (!final && safeLength) {
      let leadIndex = safeLength - 1;
      while (leadIndex >= 0 && (bytes[leadIndex] & 0xc0) === 0x80) leadIndex -= 1;
      const lead = bytes[leadIndex];
      const expected = lead >= 0xf0 ? 4 : (lead >= 0xe0 ? 3 : (lead >= 0xc0 ? 2 : 1));
      if (leadIndex >= 0 && safeLength - leadIndex < expected) safeLength = leadIndex;
    }
    carry = bytes.slice(safeLength);
    if (!safeLength) return "";
    const encoded = bytes.slice(0, safeLength).map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
    try { return decodeURIComponent(encoded); } catch (error) { return "\ufffd"; }
  };
  return {
    decode(chunk) { return decodeBytes(chunk, false); },
    flush() { return decodeBytes(null, true); },
  };
}

function formatExamTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

Page({
  data: {
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    panelTop: 96,
    practiceReady: false,
    question: demoQuestion,
    questionBank: [],
    trainingPoolQuestions: [],
    questionQueue: [],
    practiceScopeQuestionIds: [],
    practiceScopeTitle: "全部题目",
    selectedScopeSubjectIds: [],
    selectedScopeBookIds: [],
    selectedDifficultyStars: [],
    scopeSubjectOptions: [],
    scopeBookOptions: [],
    difficultyOptions: createDifficultyOptions(),
    currentQuestionIndex: 0,
    responses: {},
    answerCardItems: [],
    answeredCount: 0,
    correctAnswerMap: { A: true },
    isFirstQuestion: true,
    isLastQuestion: false,
    examFinished: false,
    examResult: null,
    examSelectionRules: [],
    examDeclaredTotalScore: 0,
    examRemainingSeconds: 0,
    examTimeText: "",
    selected: "",
    selectedMap: {},
    answerStatus: "",
    awardedScore: 0,
    subjectiveAnswer: "",
    annotationTool: "underline",
    annotationTokens: [],
    annotationNote: "",
    subjectiveScoring: false,
    subjectiveScoringStage: "",
    subjectiveScoreResult: null,
    subjectiveScoreFeedback: "",
    submitted: false,
    isCorrect: false,
    bookmarked: false,
    questionVote: "",
    helpfulCount: 0,
    unhelpfulCount: 0,
    mastery: "",
    practiceMode: "normal",
    questionOrder: "sequential",
    trainingScope: "chapter",
    modePanelView: "main",
    questionTypeOptions: createQuestionTypeOptions(demoQuestions),
    selectedQuestionType: "",
    selectedQuestionTypeLabel: "",
    selectedChapterScopeId: "",
    selectedChapterScopeLabel: "",
    modeChapterId: "",
    modeChapterTitle: "",
    modeSectionId: "",
    modeSectionTitle: "",
    chapterPickerOptions: [],
    chapterPickerIndex: 0,
    sectionPickerOptions: [{ id: "all", title: "全部", questionIds: [] }],
    sectionPickerIndex: 0,
    headingPickerOptions: [{ id: "all", title: "全部", questionIds: [] }],
    headingPickerIndex: 0,
    modeSectionOptions: [],
    modeHeadingOptions: [],
    advancing: false,
    questionSwipeOffset: 0,
    questionSwipeOpacity: 1,
    questionSwipeAnimating: false,
    questionSwipeHint: "",
    utilityPanel: "",
    utilityTitle: "",
    noteDraft: "",
    feedbackType: "",
    feedbackText: "",
    settings: {
      vibration: false,
      showProgress: true,
      shuffleOptions: false,
      keepScreenOn: false,
      fontSize: 34,
    },
    catalogOpen: false,
    catalogView: "directory",
    catalogSummaryTitle: "",
    catalogSummaryQuestions: [],
    activeBookId: "",
    catalogVersion: 0,
    catalogSyncState: "loading",
    catalogSyncError: "",
    searchOpen: false,
    shareOpen: false,
    catalogChapters: [],
    activeCatalogId: demoQuestion.sectionId,
    searchFocus: false,
    searchQuery: "",
    searchHasRun: false,
    searchResults: [],
    sharePublic: true,
    sharePanelView: "menu",
    examExportAvailable: false,
    examExportExamId: "",
    examExporting: false,
    examExportResult: null,
    examExportFiles: [],
    examExportError: "",
    examDurationMinutes: 0,
    aiDialogOpen: false,
    aiGenerating: false,
    aiContent: "",
    aiMessages: [],
    aiInput: "",
    aiScrollTarget: "",
    aiCredits: 0,
    aiDialogHeight: 560,
    aiDialogDragging: false,
    aiHistoryOpen: false,
    aiHistory: [],
    activeAiSessionId: "",
    aiSessionKnowledge: demoQuestion.knowledgePoint,
    aiSessionResult: "",
    potatoAiX: 0,
    potatoAiY: 260,
    potatoAiSide: "right",
    potatoAiDragging: false,
  },

  onLoad(options = {}) {
    this.measureNavigation();
    const requestedBookId = String(options.bookId || "");
    if (requestedBookId) {
      this.setData({ activeBookId: requestedBookId, catalogChapters: [], catalogSyncState: "loading" }, () => {
        this.loadConfirmedCatalog(requestedBookId, []);
      });
    }
    const allowedModes = ["normal", "exam", "memorize", "review", "pack", "comprehensive"];
    const requestedMode = allowedModes.includes(options.mode) ? options.mode : "normal";
    const practiceMode = requestedMode === "comprehensive" ? "normal" : requestedMode;
    if (practiceMode === "pack") {
      this.initializePractice(options, []);
      return;
    }
    if (practiceMode === "exam" && String(options.ruleExam || "") === "1") {
      this.loadRuleExam(options);
      return;
    }
    if (practiceMode === "exam" && options.examId) {
      this.loadPublishedExam(options);
      return;
    }
    const app = getApp();
    if (typeof app.syncOfficialQuestions === "function") {
      app.syncOfficialQuestions((questions, metadata = {}) => {
        // A refreshed bank should be used by the next practice session, not replace one already on screen.
        if (this._practiceInitialized) return;
        this.initializePractice(options, questions, true);
      }, {
        force: true,
        bookId: requestedBookId,
      });
    } else {
      this.initializePractice(options, demoQuestions);
    }
  },

  loadRuleExam(options = {}) {
    const session = wx.getStorageSync(RULE_EXAM_STORAGE_KEY);
    if (!session || !Array.isArray(session.questions) || !session.questions.length) {
      wx.showToast({ title: "规则试卷已失效，请重新生成", icon: "none" });
      wx.navigateBack();
      return;
    }
    this.initializePractice({
      ...options,
      count: session.questions.length,
      duration: session.durationMinutes,
      examTitle: session.title || "真题同结构练习",
      examSelectionRules: session.selectionRules || [],
      examDeclaredTotalScore: session.totalScore,
      examExportExamId: "",
    }, session.questions, true);
  },

  loadPublishedExam(options = {}) {
    const apiBaseUrl = String(getApp().globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!apiBaseUrl || typeof wx.request !== "function") {
      wx.showToast({ title: "试卷读取失败", icon: "none" });
      wx.navigateBack();
      return;
    }
    wx.request({
      url: `${apiBaseUrl}/api/exams/${encodeURIComponent(options.examId)}`,
      method: "GET",
      timeout: 8000,
      success: (response) => {
        const payload = response && response.statusCode === 200 && response.data;
        const exam = payload && payload.exam;
        const questions = payload && payload.questions;
        if (!exam || !Array.isArray(questions) || !questions.length) {
          wx.showToast({ title: "试卷暂无可用题目", icon: "none" });
          wx.navigateBack();
          return;
        }
        this.initializePractice({
          ...options,
          count: questions.length,
          duration: exam.durationMinutes,
          examTitle: exam.title,
          examSelectionRules: exam.selectionRules || [],
          examDeclaredTotalScore: exam.totalScore,
          examExportExamId: exam.id,
        }, questions, true);
      },
      fail: () => {
        wx.showToast({ title: "试卷读取失败", icon: "none" });
        wx.navigateBack();
      },
    });
  },

  initializePractice(options = {}, officialQuestions = [], serverSynced = false) {
    if (this._practiceInitialized) return;
    this._practiceInitialized = true;
    const allowedModes = ["normal", "exam", "memorize", "review", "pack", "comprehensive"];
    const requestedMode = allowedModes.includes(options.mode) ? options.mode : "normal";
    const practiceMode = requestedMode === "comprehensive" ? "normal" : requestedMode;
    const usingDemoFallback = officialQuestions === demoQuestions
      || !(Array.isArray(officialQuestions) && (officialQuestions.length || serverSynced));
    const questionSource = usingDemoFallback ? demoQuestions : officialQuestions;
    const availableQuestions = questionSource
      .map((questionItem) => usingDemoFallback ? withDemoCatalogProjection(questionItem) : questionItem)
      .map(normalizePracticeQuestion);
    const requestedSubjectId = String(options.subjectId || "");
    const requestedBookId = String(options.bookId || "");
    const scopedQuestions = availableQuestions.filter((questionItem) => {
      if (requestedSubjectId && questionItem.subjectId !== requestedSubjectId) return false;
      if (requestedBookId && questionItem.bookId !== requestedBookId) return false;
      return true;
    });
    const requestedCount = Math.max(1, Number(options.count) || scopedQuestions.length || availableQuestions.length);
    const examDurationMinutes = Math.max(1, Number(options.duration) || 120);
    const storedSettings = wx.getStorageSync("shukao_practice_settings") || {};
    const storedTraining = wx.getStorageSync("shukao_training_preferences") || {};
    const selectedScopeSubjectIds = Array.isArray(storedTraining.selectedScopeSubjectIds) ? storedTraining.selectedScopeSubjectIds.map(String) : [];
    const selectedScopeBookIds = Array.isArray(storedTraining.selectedScopeBookIds) ? storedTraining.selectedScopeBookIds.map(String) : [];
    const selectedDifficultyStars = Array.isArray(storedTraining.selectedDifficultyStars) ? storedTraining.selectedDifficultyStars.map(Number).filter((value) => value >= 1 && value <= 5) : [];
    const aiHistory = normalizeAiHistory(wx.getStorageSync("shukao_ai_history"));
    const questionOrder = practiceMode === "exam" || practiceMode === "review"
      ? "sequential"
      : (storedTraining.questionOrder || "sequential");
    const activeReviewIds = wx.getStorageSync("shukao_active_review_ids") || [];
    const activePackQuestions = wx.getStorageSync("shukao_active_pack_questions") || [];
    const activePackName = wx.getStorageSync("shukao_active_pack_name") || "私人题包";
    const activePackId = String(options.packId || wx.getStorageSync("shukao_active_pack_id") || "");
    const attempts = wx.getStorageSync("shukao_attempts") || [];
    const reviewQuestionMap = new Map(availableQuestions.map((questionItem) => [questionItem.id, questionItem]));
    attempts.forEach((attempt) => {
      if (attempt && attempt.question && attempt.question.id && !reviewQuestionMap.has(attempt.question.id)) {
        reviewQuestionMap.set(attempt.question.id, normalizePracticeQuestion(attempt.question));
      }
    });
    const comprehensiveQuestions = requestedMode === "comprehensive"
      ? filterTrainingPool(scopedQuestions, selectedScopeSubjectIds, selectedScopeBookIds, selectedDifficultyStars)
      : scopedQuestions;
    const sessionQuestions = (practiceMode === "pack"
      ? (Array.isArray(activePackQuestions) ? activePackQuestions : [])
      : practiceMode === "exam"
      ? scopedQuestions.slice(0, requestedCount)
      : (practiceMode === "review"
        ? activeReviewIds.map((questionId) => reviewQuestionMap.get(questionId)).filter(Boolean)
        : comprehensiveQuestions)).map(normalizePracticeQuestion);
    if (!sessionQuestions.length) {
      const emptyTitle = practiceMode === "pack"
        ? "当前题包没有可用题目"
        : (practiceMode === "review" ? "当前没有可复习的题目" : "当前范围暂时没有题目");
      wx.showToast({ title: emptyTitle, icon: "none" });
      wx.navigateBack();
      return;
    }
    const questionBank = buildQuestionQueue(sessionQuestions, "sequential");
    const questionQueue = buildQuestionQueue(sessionQuestions, questionOrder);
    this._questionBank = questionBank;
    this._trainingPoolQuestions = availableQuestions;
    this._practiceScopeQuestionIds = questionBank.map((item) => item.id);
    this._activePackId = activePackId;
    const activeBookId = String(options.bookId || questionQueue[0].bookId || "");
    // 目录一律来自已确认教材目录（下方 applyConfirmedCatalog 会在同步成功后重算）；
    // 同步完成前先留空，不再使用任何硬编码的旧章节目录。
    const initialCatalogOutline = [];
    const reviewStates = normalizeReviewStates(wx.getStorageSync("shukao_review_states"));
    const progressByBook = wx.getStorageSync("shukao_book_practice_progress") || {};
    const progressByPack = wx.getStorageSync("shukao_pack_practice_progress") || {};
    const shouldResume = String(options.resume || "") === "1" && practiceMode === "normal";
    const requestedQuestionId = String(options.questionId || "");
    const requestedQuestionIndex = questionQueue.findIndex((item) => item.id === requestedQuestionId);
    const packResume = practiceMode === "pack"
      ? resolvePackResumeIndex(questionQueue, progressByPack[activePackId] || {})
      : { index: 0, removed: false, fallbackDirection: "" };
    const resumeIndex = requestedQuestionIndex >= 0
      ? requestedQuestionIndex
      : (practiceMode === "pack"
        ? packResume.index
        : (shouldResume ? resolveResumeIndex(questionQueue, progressByBook[activeBookId], reviewStates) : 0));
    const question = questionQueue[resumeIndex];
    const storedVote = wx.getStorageSync(`shukao_question_vote_${question.id}`) || {};
    const bookmarked = wx.getStorageSync(`shukao_bookmark_${question.id}`) === true;
    const responses = ["normal", "pack"].includes(practiceMode)
      ? restorePracticeResponses(questionQueue, attempts, reviewStates)
      : {};
    const catalogChapters = practiceMode === "exam"
      ? createExamCatalogChapters(questionBank, question.id)
      : createCatalogChapters(questionBank, question.id, initialCatalogOutline);
    const catalogLocation = findCatalogLocation(catalogChapters, question.id);
    this.setData(
      {
        aiCredits: getApp().globalData.aiCredits,
        practiceMode,
        submitted: practiceMode === "memorize",
        bookmarked,
        settings: { ...this.data.settings, ...storedSettings },
        // DEC-056：刷题笔记自动建档开关（单独存一份，便于知识卡那边也读同一个值）。
        noteAutoArchive: noteAutoArchiveEnabled(),
        question,
        questionQueue,
        practiceScopeTitle: practiceMode === "pack"
          ? activePackName
          : (practiceMode === "review" ? "本次复习" : (practiceMode === "exam" && (options.examTitle || options.scopeTitle) ? (options.examTitle || options.scopeTitle) : "全部题目")),
        responses,
        catalogChapters,
        activeBookId,
        activeCatalogId: catalogLocation.sectionId || catalogLocation.chapterId || "",
        catalogSyncState: practiceMode === "exam" ? "exam" : this.data.catalogSyncState,
        answerCardItems: buildAnswerCard(questionQueue, responses, resumeIndex),
        correctAnswerMap: (question.correctAnswer || []).reduce((map, key) => ({ ...map, [key]: true }), {}),
        isFirstQuestion: resumeIndex === 0,
        isLastQuestion: resumeIndex === questionQueue.length - 1,
        examRemainingSeconds: practiceMode === "exam" ? examDurationMinutes * 60 : 0,
        examTimeText: practiceMode === "exam" ? formatExamTime(examDurationMinutes * 60) : "",
        examDurationMinutes: practiceMode === "exam" ? examDurationMinutes : 0,
        examExportAvailable: practiceMode === "exam",
        examExportExamId: practiceMode === "exam" ? String(options.examExportExamId || "") : "",
        examSelectionRules: practiceMode === "exam" && Array.isArray(options.examSelectionRules) ? options.examSelectionRules : [],
        examDeclaredTotalScore: practiceMode === "exam" ? Math.max(0, Number(options.examDeclaredTotalScore) || 0) : 0,
        questionVote: storedVote.vote || "",
        helpfulCount: Number(storedVote.helpfulCount) || 0,
        unhelpfulCount: Number(storedVote.unhelpfulCount) || 0,
        questionOrder,
        trainingScope: practiceMode === "review" ? "review" : (practiceMode === "pack" ? "pack" : (requestedMode === "comprehensive" ? "comprehensive" : (storedTraining.trainingScope || "chapter"))),
        selectedScopeSubjectIds,
        selectedScopeBookIds,
        selectedDifficultyStars,
        difficultyOptions: createDifficultyOptions(selectedDifficultyStars),
        scopeSubjectOptions: createScopeOptions(availableQuestions, selectedScopeSubjectIds, selectedScopeBookIds).subjects,
        scopeBookOptions: createScopeOptions(availableQuestions, selectedScopeSubjectIds, selectedScopeBookIds).books,
        questionTypeOptions: createQuestionTypeOptions(questionBank),
        aiHistory,
        practiceReady: true,
      },
      () => {
        this.loadQuestion(resumeIndex);
        if (practiceMode === "pack" && !requestedQuestionId && packResume.removed) {
          const content = packResume.fallbackDirection === "previous"
            ? "后续题目也已不可用，已定位到上一道可用题。"
            : "已自动定位到下一道可用题。";
          if (typeof wx.showModal === "function") {
            wx.showModal({ title: "题目已被作者删除", content, showCancel: false, confirmText: "知道了" });
          } else {
            wx.showToast({ title: "题目已删除，已定位可用题", icon: "none" });
          }
        }
        if (!["pack", "exam"].includes(practiceMode)) this.loadConfirmedCatalog(activeBookId, this._questionBank);
        if (this.data.settings.keepScreenOn && typeof wx.setKeepScreenOn === "function") {
          wx.setKeepScreenOn({ keepScreenOn: true });
        }
        if (practiceMode === "exam") this.startExamTimer(examDurationMinutes * 60);
      },
    );
  },

  loadConfirmedCatalog(bookId, questionBank) {
    const cacheKey = `shukao_confirmed_catalog_${bookId}`;
    const cached = wx.getStorageSync(cacheKey);
    this._pendingCatalogQuestionBank = Array.isArray(questionBank) ? questionBank : [];
    if (cached && Array.isArray(cached.nodes)) {
      this.applyConfirmedCatalog(cached, questionBank);
      this.setData({ catalogSyncState: "cached", catalogSyncError: "" });
    }
    if (typeof wx.request !== "function") {
      this.setData({ catalogSyncState: "offline", catalogSyncError: "当前环境无法请求目录" });
      return;
    }
    if (this._catalogRequestBookId === bookId) return;
    this._catalogRequestBookId = bookId;
    if (!cached || !Array.isArray(cached.nodes)) this.setData({ catalogSyncState: "loading", catalogSyncError: "" });
    const app = getApp();
    const apiBaseUrls = typeof app.apiBaseUrlCandidates === "function"
      ? app.apiBaseUrlCandidates()
      : [String(app.globalData.apiBaseUrl || "http://192.168.2.178:3212").replace(/\/$/, "")];
    const requestAt = (index, previousError = "") => {
      const apiBaseUrl = apiBaseUrls[index];
      if (!apiBaseUrl) {
        this._catalogRequestBookId = "";
        this.setData({
          catalogSyncState: cached && Array.isArray(cached.nodes) ? "cached" : "offline",
          catalogSyncError: cached && Array.isArray(cached.nodes) ? "" : (previousError || "目录服务器连接失败"),
        });
        return;
      }
      wx.request({
        url: `${apiBaseUrl}/api/catalog/textbooks/${encodeURIComponent(bookId)}`,
        method: "GET",
        timeout: 6000,
        success: (response) => {
          const textbook = response && response.statusCode === 200 && response.data && response.data.textbook;
          if (!textbook || !Array.isArray(textbook.nodes)) {
            requestAt(index + 1, "目录数据不可用");
            return;
          }
          app.globalData.apiBaseUrl = apiBaseUrl;
          this._catalogRequestBookId = "";
          if (!cached || Number(cached.version) !== Number(textbook.version)) {
            wx.setStorageSync(cacheKey, textbook);
          }
          this.applyConfirmedCatalog(textbook, this._pendingCatalogQuestionBank || questionBank);
          this.setData({ catalogSyncState: "synced", catalogSyncError: "" });
        },
        fail: (error) => requestAt(index + 1, error && error.errMsg || "目录服务器连接失败"),
      });
    };
    requestAt(0);
  },

  retryCatalogSync() {
    if (!this.data.activeBookId) return;
    this.loadConfirmedCatalog(this.data.activeBookId, this._questionBank || []);
  },

  applyConfirmedCatalog(textbook, questionBank) {
    if (!textbook || String(textbook.bookId || textbook.id || "") !== String(this.data.activeBookId || "")) return;
    const outline = buildCatalogOutline(textbook.nodes);
    if (!outline.length) return;
    const activeQuestionId = this.data.question && this.data.question.id;
    this.setData({
      catalogChapters: createCatalogChapters(questionBank, activeQuestionId, outline),
      catalogVersion: Number(textbook.version) || 0,
    });
  },

  onShow() {
    this._pageHidden = false;
    if (this.data.practiceMode === "exam" && !this.data.examFinished && this.examEndsAt) {
      this.resumeExamTimer();
    }
  },

  onHide() {
    closeTransientLayers(this, ["catalogOpen","searchOpen","shareOpen","aiDialogOpen","aiHistoryOpen"]);
    this._pageHidden = true;
    if (this.examTimer) clearInterval(this.examTimer);
    if (this._potatoMoveTimer) clearTimeout(this._potatoMoveTimer);
    if (this._aiResizeMoveTimer) clearTimeout(this._aiResizeMoveTimer);
    this.cancelAiStreamRender();
    this._potatoMoveTimer = null;
    this._aiResizeMoveTimer = null;
    this._pendingPotatoPosition = null;
    this._pendingAiDialogHeight = null;
    this.potatoDragState = null;
    this.aiResizeState = null;
    this.questionSwipeGesture = null;
    if (this.questionSwipeTimer) clearTimeout(this.questionSwipeTimer);
    if (this.questionSwipeSettleTimer) clearTimeout(this.questionSwipeSettleTimer);
    this.questionSwipeTimer = null;
    this.questionSwipeSettleTimer = null;
    this.questionSwipeChanging = false;
    this.setData({
      catalogOpen: false,
      searchOpen: false,
      searchFocus: false,
      utilityPanel: "",
      shareOpen: false,
      aiDialogOpen: false,
      aiHistoryOpen: false,
      potatoAiDragging: false,
      aiDialogDragging: false,
      questionSwipeOffset: 0,
      questionSwipeOpacity: 1,
      questionSwipeAnimating: false,
      questionSwipeHint: "",
    });
  },

  onUnload() {
    if (this.masteryAdvanceTimer) clearTimeout(this.masteryAdvanceTimer);
    if (this.examTimer) clearInterval(this.examTimer);
    if (this._potatoMoveTimer) clearTimeout(this._potatoMoveTimer);
    if (this._aiResizeMoveTimer) clearTimeout(this._aiResizeMoveTimer);
    if (this.questionSwipeTimer) clearTimeout(this.questionSwipeTimer);
    if (this.questionSwipeSettleTimer) clearTimeout(this.questionSwipeSettleTimer);
    this.stopSubjectiveScoringProgress();
    this.cancelAiStreamRender();
    if (this.data.settings.keepScreenOn && typeof wx.setKeepScreenOn === "function") {
      wx.setKeepScreenOn({ keepScreenOn: false });
    }
  },

  startExamTimer(durationSeconds) {
    this.examEndsAt = Date.now() + durationSeconds * 1000;
    this.resumeExamTimer();
  },

  resumeExamTimer() {
    if (this.examTimer) clearInterval(this.examTimer);
    this.updateExamTimer();
    this.examTimer = setInterval(() => this.updateExamTimer(), 1000);
  },

  updateExamTimer() {
    if (this.data.practiceMode !== "exam" || this.data.examFinished || !this.examEndsAt) {
      if (this.examTimer) clearInterval(this.examTimer);
      return;
    }
    const examRemainingSeconds = Math.max(0, Math.ceil((this.examEndsAt - Date.now()) / 1000));
    this.setData({ examRemainingSeconds, examTimeText: formatExamTime(examRemainingSeconds) });
    if (examRemainingSeconds === 0) {
      if (this.examTimer) clearInterval(this.examTimer);
      this.submitExam({ auto: true });
    }
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.practiceWindowWidth = windowInfo.windowWidth;
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function" ? wx.getMenuButtonBoundingClientRect() : null;
    const hasCapsuleMetrics = capsule && capsule.width > 0 && capsule.height > 0;
    const statusBarHeight = windowInfo.statusBarHeight || (hasCapsuleMetrics ? capsule.top : 24);
    const capsuleTop = hasCapsuleMetrics ? capsule.top : statusBarHeight + 4;
    const capsuleHeight = hasCapsuleMetrics ? capsule.height : 32;
    const topGap = Math.max(4, capsuleTop - statusBarHeight);
    const navContentHeight = capsuleHeight + topGap * 2;
    const navTotalHeight = statusBarHeight + navContentHeight;
    const rpx = windowInfo.windowWidth / 750;
    const entryWidth = 112 * rpx;
    const entryHeight = 124 * rpx;
    const visibleWidth = 61 * rpx;
    const bottomInset = windowInfo.safeArea ? Math.max(0, windowInfo.windowHeight - windowInfo.safeArea.bottom) : 0;
    const footerHeight = 196 * rpx + bottomInset;
    const minY = navTotalHeight + 108 * rpx;
    const maxY = Math.max(minY, windowInfo.windowHeight - footerHeight - entryHeight - 12 * rpx);
    const storedPosition = wx.getStorageSync("shukao_potato_ai_position") || {};
    const storedRatio = Number(storedPosition.yRatio);
    const yRatio = Number.isFinite(storedRatio) ? Math.min(1, Math.max(0, storedRatio)) : 0.48;
    const potatoAiSide = storedPosition.side === "left" ? "left" : "right";
    const potatoAiX = potatoAiSide === "left" ? visibleWidth - entryWidth : windowInfo.windowWidth - visibleWidth;
    const potatoAiY = minY + (maxY - minY) * yRatio;
    const minAiDialogHeight = Math.max(360 * rpx, windowInfo.windowHeight * 0.46);
    const maxAiDialogHeight = Math.max(minAiDialogHeight, windowInfo.windowHeight - statusBarHeight - 20 * rpx);
    const storedAiDialogRatio = Number(wx.getStorageSync("shukao_ai_dialog_height_ratio"));
    const aiDialogRatio = Number.isFinite(storedAiDialogRatio)
      ? Math.min(1, Math.max(0, storedAiDialogRatio))
      : 0.48;
    const aiDialogHeight = minAiDialogHeight + (maxAiDialogHeight - minAiDialogHeight) * aiDialogRatio;
    this.potatoAiBounds = {
      windowWidth: windowInfo.windowWidth,
      entryWidth,
      entryHeight,
      visibleWidth,
      minX: -entryWidth + 30 * rpx,
      maxX: windowInfo.windowWidth - 30 * rpx,
      minY,
      maxY,
    };
    this.aiDialogBounds = {
      minHeight: minAiDialogHeight,
      maxHeight: maxAiDialogHeight,
    };
    this.setData({
      statusBarHeight,
      navContentHeight,
      navTotalHeight,
      panelTop: navTotalHeight + 8,
      capsuleSafeRight: hasCapsuleMetrics ? Math.max(96, windowInfo.windowWidth - capsule.left + 8) : 96,
      potatoAiX,
      potatoAiY,
      potatoAiSide,
      aiDialogHeight,
    });
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: "/pages/library/library" }),
    });
  },

  stopTouchMove() {},

  handleQuestionSwipeStart(event) {
    const touch = event.touches && event.touches[0];
    const swipeBlocked = event.target
      && event.target.dataset
      && event.target.dataset.swipeBlock;
    if (!touch || swipeBlocked || this.data.subjectiveScoring || this.data.advancing || this.questionSwipeChanging) {
      this.questionSwipeGesture = null;
      return;
    }
    this.questionSwipeGesture = {
      x: touch.clientX,
      y: touch.clientY,
      startedAt: Date.now(),
      questionId: this.data.question.id,
      horizontal: false,
      vertical: false,
    };
  },

  handleQuestionSwipeMove(event) {
    const gesture = this.questionSwipeGesture;
    const touch = event.touches && event.touches[0];
    if (!gesture || !touch || gesture.vertical) return;
    const deltaX = touch.clientX - gesture.x;
    const deltaY = touch.clientY - gesture.y;
    if (!gesture.horizontal) {
      if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
      if (Math.abs(deltaY) > Math.abs(deltaX) * 1.1) {
        gesture.vertical = true;
        return;
      }
      if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.15) return;
      gesture.horizontal = true;
    }
    const edgeResistance = (deltaX > 0 && this.data.isFirstQuestion)
      || (deltaX < 0 && this.data.isLastQuestion);
    const limitedOffset = Math.max(-104, Math.min(104, deltaX * (edgeResistance ? 0.28 : 0.72)));
    const now = Date.now();
    if (now - Number(this._lastQuestionSwipeRender || 0) < 16) return;
    this._lastQuestionSwipeRender = now;
    this.setData({
      questionSwipeAnimating: false,
      questionSwipeOffset: limitedOffset,
      questionSwipeOpacity: Math.max(0.82, 1 - Math.abs(limitedOffset) / 480),
      questionSwipeHint: limitedOffset > 12 ? "previous" : (limitedOffset < -12 ? "next" : ""),
    });
  },

  resetQuestionSwipe() {
    this.setData({
      questionSwipeAnimating: true,
      questionSwipeOffset: 0,
      questionSwipeOpacity: 1,
      questionSwipeHint: "",
    });
    if (this.questionSwipeSettleTimer) clearTimeout(this.questionSwipeSettleTimer);
    this.questionSwipeSettleTimer = setTimeout(() => {
      this.setData({ questionSwipeAnimating: false });
      this.questionSwipeSettleTimer = null;
    }, 190);
  },

  animateQuestionSwipe(direction) {
    const targetIndex = this.data.currentQuestionIndex + (direction === "next" ? 1 : -1);
    const windowWidth = Math.max(320, Number(this.practiceWindowWidth) || 390);
    this.questionSwipeChanging = true;
    this.setData({
      questionSwipeAnimating: true,
      questionSwipeOffset: direction === "next" ? -windowWidth : windowWidth,
      questionSwipeOpacity: 0.16,
      questionSwipeHint: direction,
    });
    if (this.questionSwipeTimer) clearTimeout(this.questionSwipeTimer);
    this.questionSwipeTimer = setTimeout(() => {
      this.loadQuestion(targetIndex);
      this.setData({
        questionSwipeAnimating: false,
        questionSwipeOffset: direction === "next" ? 58 : -58,
        questionSwipeOpacity: 0.18,
      });
      this.questionSwipeTimer = setTimeout(() => {
        this.setData({
          questionSwipeAnimating: true,
          questionSwipeOffset: 0,
          questionSwipeOpacity: 1,
          questionSwipeHint: "",
        });
        this.questionSwipeSettleTimer = setTimeout(() => {
          this.setData({ questionSwipeAnimating: false });
          this.questionSwipeChanging = false;
          this.questionSwipeSettleTimer = null;
        }, 190);
      }, 16);
    }, 150);
  },

  handleQuestionSwipeEnd(event) {
    const start = this.questionSwipeGesture;
    this.questionSwipeGesture = null;
    const touch = event.changedTouches && event.changedTouches[0];
    if (!start || !touch || start.questionId !== this.data.question.id) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const isHorizontalSwipe = Math.abs(deltaX) >= 56
      && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
    if (!isHorizontalSwipe || Date.now() - start.startedAt > 900) {
      this.resetQuestionSwipe();
      return;
    }

    if (deltaX > 0) {
      if (this.data.isFirstQuestion) {
        this.resetQuestionSwipe();
        this.goPreviousQuestion();
        return;
      }
      this.animateQuestionSwipe("previous");
      return;
    }
    if (this.requiresMasteryFeedback() || this.data.isLastQuestion) {
      this.resetQuestionSwipe();
      this.nextQuestion();
      return;
    }
    this.animateQuestionSwipe("next");
  },

  handleQuestionSwipeCancel() {
    this.questionSwipeGesture = null;
    this.resetQuestionSwipe();
  },

  handlePotatoTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch || !this.potatoAiBounds) return;
    this.potatoDragState = {
      startX: touch.clientX,
      startY: touch.clientY,
      originX: this.data.potatoAiX,
      originY: this.data.potatoAiY,
      currentX: this.data.potatoAiX,
      currentY: this.data.potatoAiY,
      moved: false,
    };
    this.setData({ potatoAiDragging: true });
  },

  handlePotatoTouchMove(event) {
    const touch = event.touches && event.touches[0];
    const drag = this.potatoDragState;
    const bounds = this.potatoAiBounds;
    if (!touch || !drag || !bounds) return;
    const deltaX = touch.clientX - drag.startX;
    const deltaY = touch.clientY - drag.startY;
    const potatoAiX = Math.min(bounds.maxX, Math.max(bounds.minX, drag.originX + deltaX));
    const potatoAiY = Math.min(bounds.maxY, Math.max(bounds.minY, drag.originY + deltaY));
    drag.currentX = potatoAiX;
    drag.currentY = potatoAiY;
    if (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6) drag.moved = true;
    this._pendingPotatoPosition = { potatoAiX, potatoAiY };
    if (this._potatoMoveTimer) return;
    this._potatoMoveTimer = setTimeout(() => {
      this._potatoMoveTimer = null;
      const pending = this._pendingPotatoPosition;
      this._pendingPotatoPosition = null;
      if (pending && !this._pageHidden) this.setData(pending);
    }, 16);
  },

  handlePotatoTouchEnd() {
    this.finishPotatoDrag(true);
  },

  handlePotatoTouchCancel() {
    this.finishPotatoDrag(false);
  },

  finishPotatoDrag(openOnTap) {
    const drag = this.potatoDragState;
    const bounds = this.potatoAiBounds;
    if (this._potatoMoveTimer) clearTimeout(this._potatoMoveTimer);
    this._potatoMoveTimer = null;
    this._pendingPotatoPosition = null;
    this.potatoDragState = null;
    if (!drag || !bounds) {
      this.setData({ potatoAiDragging: false });
      return;
    }
    if (!drag.moved && openOnTap) {
      this.setData({ potatoAiDragging: false });
      this.openAiDialog();
      return;
    }
    const centerX = drag.currentX + bounds.entryWidth / 2;
    const potatoAiSide = centerX < bounds.windowWidth / 2 ? "left" : "right";
    const potatoAiX = potatoAiSide === "left"
      ? bounds.visibleWidth - bounds.entryWidth
      : bounds.windowWidth - bounds.visibleWidth;
    const potatoAiY = Math.min(bounds.maxY, Math.max(bounds.minY, drag.currentY));
    const yRange = bounds.maxY - bounds.minY;
    const yRatio = yRange > 0 ? (potatoAiY - bounds.minY) / yRange : 0;
    this.setData({ potatoAiX, potatoAiY, potatoAiSide, potatoAiDragging: false });
    wx.setStorageSync("shukao_potato_ai_position", { side: potatoAiSide, yRatio });
  },

  closeToolPanels() {
    this.setData({ catalogOpen: false, searchOpen: false, searchFocus: false });
  },

  openCatalog() {
    const catalogLocation = findCatalogLocation(this.data.catalogChapters, this.data.question.id);
    const catalogChapters = this.data.catalogChapters.map((chapter) => ({
      ...chapter,
      expanded: chapter.id === catalogLocation.chapterId ? true : chapter.expanded,
    }));
    this.setData({
      catalogOpen: true,
      catalogView: "directory",
      searchOpen: false,
      searchFocus: false,
      catalogChapters,
    });
  },

  openSearch() {
    this.setData({ searchOpen: true, searchFocus: true, catalogOpen: false });
  },

  selectCatalogItem(event) {
    const sectionId = event.currentTarget.dataset.id;
    const title = event.currentTarget.dataset.title;
    const section = this.data.catalogChapters
      .flatMap((chapter) => chapter.sections || [])
      .find((item) => item.id === sectionId);
    const source = this.data.practiceMode === "exam" ? this.data.questionQueue : (this._questionBank || []);
    const questionIds = new Set(section && section.questionIds || []);
    const questions = source.filter((question) => questionIds.has(question.id));
    if (!questions.length) {
      wx.showToast({ title: `${title}暂无题目`, icon: "none" });
      return;
    }
    this.openCatalogSummary(title, questions);
  },

  selectCatalogChapter(event) {
    const chapterId = event.currentTarget.dataset.id;
    const chapter = this.data.catalogChapters.find((item) => item.id === chapterId);
    if (!chapter) return;
    const source = this.data.practiceMode === "exam" ? this.data.questionQueue : (this._questionBank || []);
    const questionIds = new Set(chapter.questionIds || []);
    const questions = source.filter((question) => questionIds.has(question.id));
    if (!questions.length) {
      wx.showToast({ title: `${chapter.title}暂无题目`, icon: "none" });
      return;
    }
    this.openCatalogSummary(chapter.title, questions);
  },

  openCatalogSummary(title, questions) {
    const catalogSummaryQuestions = questions.map((question, index) => ({
      ...question,
      summaryNumber: String(index + 1).padStart(2, "0"),
    }));
    this.setData({
      catalogView: "summary",
      catalogSummaryTitle: title,
      catalogSummaryQuestions,
    });
  },

  backToCatalogDirectory() {
    this.setData({ catalogView: "directory" });
  },

  selectCatalogQuestion(event) {
    const questionId = event.currentTarget.dataset.questionId;
    if (this.data.practiceMode === "exam") {
      const examIndex = this.data.questionQueue.findIndex((question) => question.id === questionId);
      if (examIndex >= 0) this.setData({ catalogOpen: false }, () => this.loadQuestion(examIndex));
      return;
    }

    const sourceQuestions = this.data.catalogSummaryQuestions.map((question) => {
      const { summaryNumber, ...sourceQuestion } = question;
      return sourceQuestion;
    });
    let questionQueue = buildQuestionQueue(sourceQuestions, this.data.questionOrder);
    let selectedIndex = questionQueue.findIndex((question) => question.id === questionId);
    if (this.data.questionOrder === "random" && selectedIndex > 0) {
      const selectedQuestion = questionQueue[selectedIndex];
      const remaining = questionQueue.filter((question) => question.id !== questionId);
      questionQueue = buildQuestionQueue([selectedQuestion].concat(remaining), "sequential");
      selectedIndex = 0;
    }
    if (selectedIndex < 0) return;
    this._practiceScopeQuestionIds = sourceQuestions.map((question) => question.id);
    this.setData(
      {
        catalogOpen: false,
        questionQueue,
        practiceScopeTitle: this.data.catalogSummaryTitle,
      },
      () => this.loadQuestion(selectedIndex),
    );
  },

  toggleCatalogChapter(event) {
    const chapterId = event.currentTarget.dataset.id;
    const catalogChapters = this.data.catalogChapters.map((chapter) =>
      chapter.id === chapterId ? { ...chapter, expanded: !chapter.expanded } : chapter,
    );
    this.setData({ catalogChapters });
  },

  collapseAllCatalog() {
    const catalogChapters = this.data.catalogChapters.map((chapter) => ({
      ...chapter,
      expanded: false,
    }));
    this.setData({ catalogChapters });
  },

  updateSearchQuery(event) {
    this.setData({
      searchQuery: event.detail.value,
      searchHasRun: false,
      searchResults: [],
    });
  },

  runQuestionSearch() {
    const searchQuery = this.data.searchQuery.trim();
    if (!searchQuery) {
      wx.showToast({ title: "请输入搜索内容", icon: "none" });
      return;
    }
    const source = this.data.practiceMode === "exam" ? this.data.questionQueue : (this._questionBank || []);
    const normalizedQuery = searchQuery.toLowerCase();
    const stringifySearchValue = (value) => {
      if (Array.isArray(value)) return value.map(stringifySearchValue).join(" ");
      if (value && typeof value === "object") return Object.values(value).map(stringifySearchValue).join(" ");
      return value == null ? "" : String(value);
    };
    const searchResults = source
      .filter((question) => stringifySearchValue([
        question.stem,
        question.material,
        question.options,
        question.knowledgePoint,
        question.breadcrumb,
        question.referenceAnswer,
        question.officialAnswer,
        question.aiAnswer,
        question.communityAnswer,
        question.scorePoints,
      ]).toLowerCase().includes(normalizedQuery))
      .map((question) => ({
        id: question.id,
        title: question.stem,
        breadcrumb: question.breadcrumb || question.knowledgePoint || "题库题目",
      }));
    this.setData({ searchQuery, searchHasRun: true, searchResults });
  },

  clearQuestionSearch() {
    this.setData({ searchQuery: "", searchHasRun: false, searchResults: [], searchFocus: true });
  },

  selectSearchResult(event) {
    const questionId = event.currentTarget.dataset.questionId;
    const currentIndex = this.data.questionQueue.findIndex((question) => question.id === questionId);
    if (currentIndex >= 0) {
      this.setData({ searchOpen: false, searchFocus: false }, () => this.loadQuestion(currentIndex));
      return;
    }
    if (this.data.practiceMode === "exam") return;

    let questionQueue = buildQuestionQueue(this._questionBank || [], this.data.questionOrder);
    let selectedIndex = questionQueue.findIndex((question) => question.id === questionId);
    if (this.data.questionOrder === "random" && selectedIndex > 0) {
      const selectedQuestion = questionQueue[selectedIndex];
      questionQueue = [selectedQuestion].concat(questionQueue.filter((question) => question.id !== questionId));
      selectedIndex = 0;
    }
    if (selectedIndex < 0) return;
    this._practiceScopeQuestionIds = (this._questionBank || []).map((question) => question.id);
    this.setData({
      searchOpen: false,
      searchFocus: false,
      questionQueue,
      practiceScopeTitle: "全部题目",
    }, () => this.loadQuestion(selectedIndex));
  },

  openSharePanel() {
    this.setData({
      shareOpen: true,
      sharePanelView: "menu",
      examExportError: "",
      catalogOpen: false,
      searchOpen: false,
      searchFocus: false,
    });
  },

  closeSharePanel() {
    this.setData({ shareOpen: false });
  },

  toggleSharePublic(event) {
    this.setData({ sharePublic: event.detail.value });
  },

  selectSharePanelView(event) {
    const view = String(event.currentTarget.dataset.view || "menu");
    if (view === "export" && !this.data.examExportAvailable) return;
    if (!["menu", "question", "export"].includes(view)) return;
    this.setData({ sharePanelView: view, examExportError: "" });
  },

  backSharePanel() {
    this.setData({ sharePanelView: "menu", examExportError: "" });
  },

  examExportPayload() {
    if (this.data.examExportExamId) return { examId: this.data.examExportExamId };
    return {
      exam: {
        title: this.data.practiceScopeTitle || "汉语言文学学科基础试卷",
        durationMinutes: this.data.examDurationMinutes || 120,
        totalScore: this.data.examDeclaredTotalScore || this.data.questionQueue.reduce((sum, question) => sum + (Number(question.maxScore || question.score) || 0), 0),
        declaredTotalScore: this.data.examDeclaredTotalScore || 0,
        selectionRules: this.data.examSelectionRules || [],
      },
      questions: this.data.questionQueue,
    };
  },

  generateExamExport() {
    if (this.data.examExporting || !this.data.examExportAvailable) return;
    const app = getApp();
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || typeof wx.request !== "function") {
      this.setData({ examExportError: "暂时无法连接导出服务器" });
      return;
    }
    this.setData({ examExporting: true, examExportError: "", examExportResult: null, examExportFiles: [] });
    wx.request({
      url: `${baseUrl}/api/exam-exports`,
      method: "POST",
      timeout: 30000,
      header: app.globalData.authToken ? { Authorization: `Bearer ${app.globalData.authToken}` } : {},
      data: { ...this.examExportPayload(), userId: app.globalData.userId || "test-user" },
      success: (response) => {
        const payload = response && response.data || {};
        if (response.statusCode !== 201 || !payload.export || !Array.isArray(payload.export.files)) {
          const missing = Array.isArray(payload.missingQuestionNumbers) ? payload.missingQuestionNumbers : [];
          this.setData({
            examExporting: false,
            examExportError: missing.length ? `第 ${missing.join("、")} 题缺少答案，补齐后才能导出` : "试卷生成失败，请稍后重试",
          });
          return;
        }
        this.downloadExamExportFiles(payload.export);
      },
      fail: () => this.setData({ examExporting: false, examExportError: "试卷生成超时，请稍后重试" }),
    });
  },

  downloadExamExportFiles(exportRecord) {
    const baseUrl = String(getApp().globalData.apiBaseUrl || "").replace(/\/$/, "");
    const files = exportRecord.files.slice(0, 2);
    const downloaded = [];
    const next = (index) => {
      if (index >= files.length) {
        const normalizedRecord = {
          ...exportRecord,
          reviewQuestionText: (exportRecord.reviewQuestionNumbers || []).join("、"),
        };
        this.setData({ examExporting: false, examExportResult: normalizedRecord, examExportFiles: downloaded, examExportError: "" });
        wx.showToast({ title: "试卷和答案已生成", icon: "success" });
        return;
      }
      const file = files[index];
      const remoteUrl = /^https?:\/\//i.test(file.url) ? file.url : `${baseUrl}${file.url}`;
      if (typeof wx.downloadFile !== "function") {
        this.setData({ examExporting: false, examExportResult: { ...exportRecord, reviewQuestionText: (exportRecord.reviewQuestionNumbers || []).join("、") }, examExportFiles: files.map((item) => ({ ...item, remoteUrl: /^https?:\/\//i.test(item.url) ? item.url : `${baseUrl}${item.url}` })), examExportError: "文件已生成，当前环境不支持自动下载" });
        return;
      }
      wx.downloadFile({
        url: remoteUrl,
        timeout: 30000,
        success: (result) => {
          if (result.statusCode !== 200 || !result.tempFilePath) {
            this.setData({ examExporting: false, examExportResult: exportRecord, examExportFiles: downloaded, examExportError: `${file.label}下载失败，可重新下载整套` });
            return;
          }
          const complete = (localPath) => {
            downloaded.push({ ...file, remoteUrl, localPath });
            next(index + 1);
          };
          if (typeof wx.saveFile === "function") {
            wx.saveFile({ tempFilePath: result.tempFilePath, success: (saved) => complete(saved.savedFilePath || result.tempFilePath), fail: () => complete(result.tempFilePath) });
          } else complete(result.tempFilePath);
        },
        fail: () => this.setData({ examExporting: false, examExportResult: exportRecord, examExportFiles: downloaded, examExportError: `${file.label}下载失败，可重新下载整套` }),
      });
    };
    next(0);
  },

  openExamExportFile(event) {
    const kind = String(event.currentTarget.dataset.kind || "");
    const file = this.data.examExportFiles.find((item) => item.kind === kind);
    if (!file || !file.localPath || typeof wx.openDocument !== "function") {
      wx.showToast({ title: "文件尚未下载完成", icon: "none" });
      return;
    }
    wx.openDocument({ filePath: file.localPath, fileType: "pdf", showMenu: true, fail: () => wx.showToast({ title: "文件打开失败", icon: "none" }) });
  },

  onShareAppMessage() {
    const { question, sharePublic } = this.data;
    this.setData({ shareOpen: false });
    return {
      title: `一道来自薯考的题：${question.knowledgePoint}`,
      path: `/pages/practice/practice?questionId=${question.id}&share=1&public=${sharePublic ? 1 : 0}`,
    };
  },

  openUtilityPanel(event) {
    const utilityPanel = event.currentTarget.dataset.panel;
    const titles = {
      answerCard: "答题卡",
      note: "当前题笔记",
      feedback: "内容反馈",
      settings: "练习设置",
      mode: "刷题模式",
    };
    const nextData = {
      utilityPanel,
      utilityTitle: titles[utilityPanel] || "",
      catalogOpen: false,
      searchOpen: false,
      searchFocus: false,
    };
    if (utilityPanel === "mode") {
      nextData.modePanelView = "main";
    }
    if (utilityPanel === "note") {
      // DEC-056：题目笔记与知识卡共用同一份数据，从卡片里按 questionId 回填。
      const savedNote = questionNoteContent(this.data.question.id);
      nextData.noteDraft = savedNote || this.data.noteDraft;
    }
    this.setData(nextData);
  },

  closeUtilityPanel() {
    this.setData({ utilityPanel: "" });
  },

  selectTrainingMode(event) {
    const mode = event.currentTarget.dataset.mode;
    const labels = {
      sequential: "顺序刷题",
      random: "随机刷题",
      chapter: "章节刷题",
      type: "题型训练",
      memorize: "背题模式",
      exam: "组卷",
    };
    if (mode === "type") {
      this.setData({ modePanelView: "types" });
      return;
    }
    if (mode === "chapter") {
      const chapterPickerOptions = [{
        id: "all",
        title: "全部",
        questionIds: (this._questionBank || []).map((question) => question.id),
      }].concat(this.data.catalogChapters.filter((chapter) => chapter.questionCount > 0));
      this.setData({
        modePanelView: "chapters",
        chapterPickerOptions,
        chapterPickerIndex: 0,
        sectionPickerOptions: [{ id: "all", title: "全部", questionIds: [] }],
        sectionPickerIndex: 0,
        headingPickerOptions: [{ id: "all", title: "全部", questionIds: [] }],
        headingPickerIndex: 0,
        modeChapterId: "",
        modeChapterTitle: "",
        modeSectionId: "",
        modeSectionTitle: "",
        modeSectionOptions: [],
        modeHeadingOptions: [],
      });
      return;
    }
    if (mode === "scope") {
      const options = createScopeOptions(this._trainingPoolQuestions || [], this.data.selectedScopeSubjectIds, this.data.selectedScopeBookIds);
      this.setData({ modePanelView: "scope", scopeSubjectOptions: options.subjects, scopeBookOptions: options.books });
      return;
    }
    if (mode === "difficulty") {
      this.setData({ modePanelView: "difficulty" });
      return;
    }

    const nextData = { utilityPanel: "" };
    let targetIndex = this.data.currentQuestionIndex;

    if (mode === "exam") {
      this.setData(nextData);
      if (this.data.practiceMode === "exam") {
        wx.navigateBack({
          fail: () => wx.redirectTo({ url: "/pages/exams/exams" }),
        });
      } else {
        wx.navigateTo({ url: "/pages/exams/exams" });
      }
      return;
    }

    if (mode === "sequential" || mode === "random") {
      const scopeIds = new Set(this._practiceScopeQuestionIds || []);
      const scopeQuestions = (this._questionBank || []).filter((question) => scopeIds.has(question.id));
      nextData.questionOrder = mode;
      nextData.questionQueue = buildQuestionQueue(scopeQuestions, mode);
      targetIndex = 0;
    } else if (mode === "memorize") {
      nextData.practiceMode = "memorize";
    } else {
      return;
    }

    const preferences = {
      questionOrder: nextData.questionOrder || this.data.questionOrder,
      trainingScope: nextData.trainingScope || this.data.trainingScope,
    };
    wx.setStorageSync("shukao_training_preferences", preferences);
    this.setData(nextData, () => {
      this.loadQuestion(targetIndex);
      wx.showToast({ title: `已切换：${labels[mode]}`, icon: "none" });
    });
  },

  backToModePanel() {
    this.setData({ modePanelView: "main" });
  },

  toggleScopeSubject(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const selected = new Set(this.data.selectedScopeSubjectIds);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    const selectedScopeSubjectIds = [...selected];
    const options = createScopeOptions(this._trainingPoolQuestions || [], selectedScopeSubjectIds, this.data.selectedScopeBookIds);
    this.setData({ selectedScopeSubjectIds, scopeSubjectOptions: options.subjects, scopeBookOptions: options.books });
  },

  toggleScopeBook(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const selected = new Set(this.data.selectedScopeBookIds);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    const selectedScopeBookIds = [...selected];
    const options = createScopeOptions(this._trainingPoolQuestions || [], this.data.selectedScopeSubjectIds, selectedScopeBookIds);
    this.setData({ selectedScopeBookIds, scopeSubjectOptions: options.subjects, scopeBookOptions: options.books });
  },

  toggleDifficultyStar(event) {
    const star = Number(event.currentTarget.dataset.star);
    const selected = new Set(this.data.selectedDifficultyStars);
    if (selected.has(star)) selected.delete(star); else selected.add(star);
    const selectedDifficultyStars = [...selected].sort((left, right) => left - right);
    this.setData({
      selectedDifficultyStars,
      difficultyOptions: createDifficultyOptions(selectedDifficultyStars),
    });
  },

  applyComprehensiveScope() {
    const questions = filterTrainingPool(
      this._trainingPoolQuestions || [],
      this.data.selectedScopeSubjectIds,
      this.data.selectedScopeBookIds,
      this.data.selectedDifficultyStars,
    );
    if (!questions.length) {
      wx.showToast({ title: "当前组合暂无题目", icon: "none" });
      return;
    }
    const questionQueue = buildQuestionQueue(questions, this.data.questionOrder);
    this._practiceScopeQuestionIds = questions.map((question) => question.id);
    wx.setStorageSync("shukao_training_preferences", {
      questionOrder: this.data.questionOrder,
      trainingScope: "comprehensive",
      selectedScopeSubjectIds: this.data.selectedScopeSubjectIds,
      selectedScopeBookIds: this.data.selectedScopeBookIds,
      selectedDifficultyStars: this.data.selectedDifficultyStars,
    });
    this.setData({
      trainingScope: "comprehensive",
      questionQueue,
      practiceScopeTitle: "综合题池",
      practiceMode: "normal",
      utilityPanel: "",
      modePanelView: "main",
      questionTypeOptions: createQuestionTypeOptions(questions),
    }, () => this.loadQuestion(0));
    wx.showToast({ title: `综合训练：${questions.length} 题`, icon: "none" });
  },

  changeChapterPicker(event) {
    const chapterPickerIndex = Number(event.detail.value) || 0;
    const chapter = this.data.chapterPickerOptions[chapterPickerIndex];
    const sectionPickerOptions = chapterPickerIndex > 0 && chapter
      ? [{ id: "all", title: "全部", questionIds: chapter.questionIds || [] }].concat(
        (chapter.sections || []).filter((section) => Number(section.level || 2) === 2 && section.questionCount > 0),
      )
      : [{ id: "all", title: "全部", questionIds: [] }];
    this.setData({
      chapterPickerIndex,
      sectionPickerOptions,
      sectionPickerIndex: 0,
      headingPickerOptions: [{ id: "all", title: "全部", questionIds: [] }],
      headingPickerIndex: 0,
    });
  },

  changeSectionPicker(event) {
    const sectionPickerIndex = Number(event.detail.value) || 0;
    const section = this.data.sectionPickerOptions[sectionPickerIndex];
    const chapter = this.data.chapterPickerOptions[this.data.chapterPickerIndex];
    const headingPickerOptions = sectionPickerIndex > 0 && section && chapter
      ? [{ id: "all", title: "全部", questionIds: section.questionIds || [] }].concat(
        (chapter.sections || []).filter((item) => Number(item.level) === 3 && item.parentId === section.id && item.questionCount > 0),
      )
      : [{ id: "all", title: "全部", questionIds: [] }];
    this.setData({
      sectionPickerIndex,
      headingPickerOptions,
      headingPickerIndex: 0,
    });
  },

  changeHeadingPicker(event) {
    this.setData({ headingPickerIndex: Number(event.detail.value) || 0 });
  },

  confirmChapterPicker() {
    const chapter = this.data.chapterPickerOptions[this.data.chapterPickerIndex];
    const section = this.data.sectionPickerOptions[this.data.sectionPickerIndex];
    const heading = this.data.headingPickerOptions[this.data.headingPickerIndex];
    const scope = this.data.headingPickerIndex > 0
      ? heading
      : (this.data.sectionPickerIndex > 0 ? section : chapter);
    if (!scope) return;
    const questionIds = new Set(scope.questionIds || []);
    const questions = (this._questionBank || []).filter((question) => questionIds.has(question.id));
    this.activateChapterScope(scope, questions);
  },

  selectChapterScope(event) {
    const scopeId = event.currentTarget.dataset.id;
    const scopeKind = event.currentTarget.dataset.kind;
    let scope = null;
    if (scopeKind === "chapter") {
      scope = this.data.catalogChapters.find((chapter) => chapter.id === scopeId);
    } else {
      scope = this.data.catalogChapters
        .flatMap((chapter) => chapter.sections || [])
        .find((section) => section.id === scopeId);
    }
    const questionIds = new Set(scope && scope.questionIds || []);
    const questions = (this._questionBank || []).filter((question) => questionIds.has(question.id));
    if (!scope || !questions.length) {
      wx.showToast({ title: "该目录暂无题目", icon: "none" });
      return;
    }
    this.activateChapterScope(scope, questions);
  },

  activateChapterScope(scope, questions) {
    if (!scope || !questions.length) {
      wx.showToast({ title: "该范围暂无题目", icon: "none" });
      return;
    }
    const questionQueue = buildQuestionQueue(questions, this.data.questionOrder);
    this._practiceScopeQuestionIds = questions.map((question) => question.id);
    const preferences = {
      questionOrder: this.data.questionOrder,
      trainingScope: "chapter",
      selectedChapterScopeId: scope.id,
    };
    wx.setStorageSync("shukao_training_preferences", preferences);
    this.setData({
      trainingScope: "chapter",
      selectedChapterScopeId: scope.id,
      selectedChapterScopeLabel: scope.title,
      selectedQuestionType: "",
      selectedQuestionTypeLabel: "",
      practiceMode: "normal",
      questionQueue,
      practiceScopeTitle: scope.title,
      utilityPanel: "",
      modePanelView: "main",
    }, () => {
      this.loadQuestion(0);
      wx.showToast({ title: `已选择：${scope.title}`, icon: "none" });
    });
  },

  selectQuestionType(event) {
    const selectedQuestionType = event.currentTarget.dataset.type;
    const option = this.data.questionTypeOptions.find((item) => item.type === selectedQuestionType);
    const questions = (this._questionBank || []).filter((question) => question.type === selectedQuestionType);
    if (!option || !questions.length) {
      wx.showToast({ title: "该题型暂无题目", icon: "none" });
      return;
    }

    const questionQueue = buildQuestionQueue(questions, this.data.questionOrder);
    this._practiceScopeQuestionIds = questions.map((question) => question.id);
    const preferences = {
      questionOrder: this.data.questionOrder,
      trainingScope: "type",
      selectedQuestionType,
    };
    wx.setStorageSync("shukao_training_preferences", preferences);
    this.setData({
      trainingScope: "type",
      selectedQuestionType,
      selectedQuestionTypeLabel: option.label,
      selectedChapterScopeId: "",
      selectedChapterScopeLabel: "",
      questionQueue,
      practiceScopeTitle: `${option.label}训练`,
      practiceMode: "normal",
      utilityPanel: "",
      modePanelView: "main",
    }, () => {
      this.loadQuestion(0);
      wx.showToast({ title: `已切换：${option.label}`, icon: "none" });
    });
  },

  loadQuestion(index) {
    const queue = this.data.questionQueue;
    if (index < 0 || index >= queue.length) return;
    const queueQuestion = queue[index];
    const response = this.data.responses[queueQuestion.id] || {};
    const hasExistingAnswer = normalizePracticeSelection(response.selected).length > 0 || response.submitted === true;
    this._optionOrders = this._optionOrders || {};
    let optionOrder = Array.isArray(response.optionOrder) && response.optionOrder.length
      ? response.optionOrder
      : [];
    if (!optionOrder.length && !hasExistingAnswer && this.data.settings.shuffleOptions && Array.isArray(queueQuestion.options) && queueQuestion.options.length > 1) {
      optionOrder = this._optionOrders[queueQuestion.id]
        || shuffleOptionOrder(queueQuestion.originalOptions || queueQuestion.options);
      this._optionOrders[queueQuestion.id] = optionOrder;
    }
    const question = optionOrder.length
      ? applyOptionOrder(queueQuestion, optionOrder)
      : restoreOriginalOptions(queueQuestion);
    const questionQueue = queue.map((item, itemIndex) => itemIndex === index ? question : item);
    const storedVote = wx.getStorageSync(`shukao_question_vote_${question.id}`) || {};
    const bookmarked = wx.getStorageSync(`shukao_bookmark_${question.id}`) === true;
    const submitted = this.data.practiceMode === "memorize" || this.data.examFinished || response.submitted === true;
    const selected = response.selected || "";
    const selectedMap = normalizePracticeSelection(selected).reduce((map, key) => ({ ...map, [key]: true }), {});
    const subjectiveAnswer = response.subjectiveAnswer || "";
    const annotationTokens = createAnnotationTokens(question, response);
    const annotationNote = response.annotationNote || "";
    const subjectiveScoreResult = response.subjectiveScoreResult || null;
    const isCorrect = isSubjectiveQuestion(question)
      ? (!!subjectiveScoreResult && response.isCorrect === true)
      : (submitted && selected ? evaluateAnswer(question, selected) : false);
    const scoreFeedbacks = wx.getStorageSync("shukao_subjective_score_feedback") || [];
    const scoreFeedback = subjectiveScoreResult
      ? scoreFeedbacks.find((item) => item.requestId === subjectiveScoreResult.requestId)
      : null;
    const aiSession = this.data.aiHistory.find((session) => session.questionId === question.id);
    const aiMessages = aiSession && Array.isArray(aiSession.messages) ? aiSession.messages : [];
    const aiScrollTarget = aiMessages.length ? aiMessages[aiMessages.length - 1].id : "";
    const answerCardItems = buildAnswerCard(questionQueue, this.data.responses, index, this.data.examFinished);
    const answeredCount = answerCardItems.filter((item) => item.status !== "empty").length;
    const catalogLocation = findCatalogLocation(this.data.catalogChapters, question.id);
    const catalogChapters = this.data.catalogChapters.map((chapter) => ({
      ...chapter,
      expanded: chapter.id === catalogLocation.chapterId ? true : chapter.expanded,
    }));
    this.stopSubjectiveScoringProgress();
    this.setData({
      question,
      questionQueue,
      currentQuestionIndex: index,
      selected,
      selectedMap,
      answerStatus: submitted
        ? (response.answerStatus || (isCorrect ? "correct" : "wrong"))
        : "",
      awardedScore: Number(response.awardedScore) || 0,
      subjectiveAnswer,
      annotationTokens,
      annotationNote,
      annotationTool: "underline",
      subjectiveScoring: false,
      subjectiveScoringStage: "",
      subjectiveScoreResult,
      subjectiveScoreFeedback: scoreFeedback ? scoreFeedback.value : "",
      submitted,
      isCorrect,
      mastery: response.mastery || "",
      bookmarked,
      questionVote: storedVote.vote || "",
      helpfulCount: Number(storedVote.helpfulCount) || 0,
      unhelpfulCount: Number(storedVote.unhelpfulCount) || 0,
      correctAnswerMap: (question.correctAnswer || []).reduce((map, key) => ({ ...map, [key]: true }), {}),
      isFirstQuestion: index === 0,
      isLastQuestion: index === queue.length - 1,
      answerCardItems,
      answeredCount,
      catalogChapters,
      activeCatalogId: catalogLocation.sectionId || catalogLocation.chapterId || "",
      activeAiSessionId: aiSession ? aiSession.id : "",
      aiContent: aiSession ? aiSession.aiContent : "",
      aiMessages,
      aiInput: "",
      aiScrollTarget,
      aiSessionKnowledge: question.knowledgePoint,
      aiSessionResult: submitted && this.data.practiceMode !== "memorize"
        ? (subjectiveScoreResult
          ? `AI 评分 ${subjectiveScoreResult.totalScore}/${subjectiveScoreResult.maxScore}`
          : (isSubjectiveQuestion(question) ? "答案已提交" : (isCorrect ? "回答正确" : "回答错误")))
        : "",
    }, () => this.saveBookPracticeProgress(question));
  },

  saveBookPracticeProgress(question) {
    if (!question) return;
    if (this.data.practiceMode === "pack" && this._activePackId) {
      const progressByPack = wx.getStorageSync("shukao_pack_practice_progress") || {};
      progressByPack[this._activePackId] = {
        questionId: question.id,
        questionIndex: this.data.currentQuestionIndex,
        questionOrder: this.data.questionQueue.map((item) => item.id),
        updatedAt: Date.now(),
      };
      wx.setStorageSync("shukao_pack_practice_progress", progressByPack);
      return;
    }
    if (!this.data.activeBookId || !["normal", "memorize"].includes(this.data.practiceMode)) return;
    const progressByBook = wx.getStorageSync("shukao_book_practice_progress") || {};
    progressByBook[this.data.activeBookId] = {
      questionId: question.id,
      updatedAt: Date.now(),
    };
    wx.setStorageSync("shukao_book_practice_progress", progressByBook);
  },

  selectAnswerCardNumber(event) {
    const number = Number(event.currentTarget.dataset.number);
    this.setData({ utilityPanel: "" }, () => this.loadQuestion(number - 1));
  },

  updateNoteDraft(event) {
    this.setData({ noteDraft: event.detail.value });
  },

  insertNoteReference(event) {
    const type = event.currentTarget.dataset.type;
    const references = {
      stem: `题目：${this.data.question.stem}`,
      answer: `参考答案：${this.data.question.referenceAnswer}`,
      ai: this.data.aiContent ? `AI 补充：${this.data.aiContent}` : "",
    };
    const content = references[type];
    if (!content) {
      wx.showToast({ title: "请先生成 AI 解析", icon: "none" });
      return;
    }
    const noteDraft = [this.data.noteDraft.trim(), content].filter(Boolean).join("\n\n");
    this.setData({ noteDraft });
  },

  saveCurrentNote() {
    const content = this.data.noteDraft.trim();
    if (!content) {
      wx.showToast({ title: "请输入笔记内容", icon: "none" });
      return;
    }
    // DEC-056：不再单独维护题目笔记存储，直接作为笔记卡落进知识卡卡集；
    // 目录按用户端目录的章/节/小点自动建立（同一节复用），同一道题更新同一张卡。
    const result = saveQuestionNote({
      question: this.data.question,
      content,
      chapters: this.data.catalogChapters || [],
      enabled: noteAutoArchiveEnabled(),
    });
    this.setData({ utilityPanel: "" });
    if (!result.ok) {
      wx.showToast({ title: result.reason === "empty" ? "请输入笔记内容" : "笔记保存失败，请重试", icon: "none" });
      return;
    }
    const where = [result.setTitle, result.directory].filter(Boolean).join(" · ");
    wx.showToast({
      title: `${result.autoArchived ? "已存入知识卡" : "已存为笔记卡"}${where ? `：${where}` : ""}`,
      icon: "none",
      duration: 2200,
    });
  },

  selectFeedbackType(event) {
    this.setData({ feedbackType: event.currentTarget.dataset.value });
  },

  updateFeedbackText(event) {
    this.setData({ feedbackText: event.detail.value });
  },

  submitContentFeedback() {
    if (!this.data.feedbackType) {
      wx.showToast({ title: "请选择反馈类型", icon: "none" });
      return;
    }
    const content = String(this.data.feedbackText || "").trim();
    if (!content) {
      wx.showToast({ title: "请填写反馈内容", icon: "none" });
      return;
    }
    const feedbackRecords = wx.getStorageSync("shukao_content_feedback") || [];
    feedbackRecords.unshift({
      id: `feedback-${Date.now()}`,
      questionId: this.data.question.id,
      type: this.data.feedbackType,
      content,
      scoreRequestId: this.data.subjectiveScoreResult ? this.data.subjectiveScoreResult.requestId : "",
      createdAt: Date.now(),
    });
    wx.setStorageSync("shukao_content_feedback", feedbackRecords.slice(0, 100));
    this.setData({ utilityPanel: "", feedbackText: "" });
    wx.showToast({ title: "反馈已提交", icon: "success" });
  },

  // DEC-056：刷题笔记自动建档开关。关闭后笔记照旧保存，只是不按教材建卡集和目录。
  toggleNoteAutoArchive(event) {
    const value = setNoteAutoArchiveEnabled(event.detail.value !== false);
    this.setData({ noteAutoArchive: value });
    wx.showToast({
      title: value ? "已开启：笔记自动归入知识卡" : "已关闭：笔记只存到「我的题目笔记」",
      icon: "none",
      duration: 2200,
    });
  },

  togglePracticeSetting(event) {    const key = event.currentTarget.dataset.key;
    const value = event.detail.value;
    const settings = { ...this.data.settings, [key]: value };
    if (key === "shuffleOptions") {
      const response = this.data.responses[this.data.question.id] || {};
      const hasExistingAnswer = normalizePracticeSelection(response.selected).length > 0 || response.submitted === true;
      if (!hasExistingAnswer) {
        this._optionOrders = this._optionOrders || {};
        delete this._optionOrders[this.data.question.id];
      }
    }
    this.setData({ settings }, () => {
      if (key === "shuffleOptions") this.loadQuestion(this.data.currentQuestionIndex);
    });
    wx.setStorageSync("shukao_practice_settings", settings);
    if (key === "keepScreenOn" && typeof wx.setKeepScreenOn === "function") {
      wx.setKeepScreenOn({ keepScreenOn: value });
    }
  },

  changeFontSize(event) {
    const settings = { ...this.data.settings, fontSize: event.detail.value };
    this.setData({ settings });
    wx.setStorageSync("shukao_practice_settings", settings);
  },

  clearAttemptRecords() {
    wx.showModal({
      title: "清空本章答题记录",
      content: "清空后无法恢复，是否继续？",
      confirmColor: "#b4473f",
      success: ({ confirm }) => {
        if (!confirm) return;
        const chapterId = this.data.question && this.data.question.chapterId;
        const chapterQuestionIds = new Set((this._questionBank || [])
          .filter((question) => !chapterId || question.chapterId === chapterId)
          .map((question) => question.id));
        const attempts = wx.getStorageSync("shukao_attempts") || [];
        wx.setStorageSync("shukao_attempts", attempts.filter((attempt) => !chapterQuestionIds.has(attempt.questionId)));
        wx.showToast({ title: "已清空", icon: "none" });
      },
    });
  },

  clearWrongRecords() {
    wx.showModal({
      title: "清空本章错题记录",
      content: "只清除当前章节的错题记录，其他章节不受影响。",
      confirmColor: "#b4473f",
      success: ({ confirm }) => {
        if (!confirm) return;
        const chapterId = this.data.question && this.data.question.chapterId;
        const chapterQuestionIds = new Set((this._questionBank || [])
          .filter((question) => !chapterId || question.chapterId === chapterId)
          .map((question) => question.id));
        const attempts = wx.getStorageSync("shukao_attempts") || [];
        wx.setStorageSync("shukao_attempts", attempts.filter((attempt) => attempt.isCorrect || !chapterQuestionIds.has(attempt.questionId)));
        wx.showToast({ title: "本章错题记录已清空", icon: "none" });
      },
    });
  },

  chooseOption(event) {
    if (this.data.submitted) return;
    const key = event.currentTarget.dataset.key;
    const current = normalizePracticeSelection(this.data.selected);
    const selected = this.data.question.type === "multiple_choice"
      ? (current.includes(key) ? current.filter((value) => value !== key) : [...current, key])
      : key;
    const selectedMap = normalizePracticeSelection(selected).reduce((map, value) => ({ ...map, [value]: true }), {});
    const responses = {
      ...this.data.responses,
      [this.data.question.id]: {
        ...(this.data.responses[this.data.question.id] || {}),
        selected,
        optionOrder: Array.isArray(this.data.question.optionOrder) ? [...this.data.question.optionOrder] : [],
        answeredAt: normalizePracticeSelection(selected).length
          ? (this.data.responses[this.data.question.id]?.answeredAt || Date.now())
          : 0,
      },
    };
    const answerCardItems = buildAnswerCard(
      this.data.questionQueue,
      responses,
      this.data.currentQuestionIndex,
      this.data.examFinished,
    );
    this.setData({
      selected,
      selectedMap,
      responses,
      answerCardItems,
      answeredCount: answerCardItems.filter((item) => item.status !== "empty").length,
    });
    if (this.data.settings.vibration && typeof wx.vibrateShort === "function") {
      wx.vibrateShort({ type: "light" });
    }
  },

  updateSubjectiveAnswer(event) {
    if (this.data.submitted || this.data.subjectiveScoring) return;
    const subjectiveAnswer = event.detail.value;
    const responses = {
      ...this.data.responses,
      [this.data.question.id]: {
        ...(this.data.responses[this.data.question.id] || {}),
        subjectiveAnswer,
        answeredAt: String(subjectiveAnswer || "").trim()
          ? (this.data.responses[this.data.question.id]?.answeredAt || Date.now())
          : 0,
      },
    };
    const answerCardItems = buildAnswerCard(
      this.data.questionQueue,
      responses,
      this.data.currentQuestionIndex,
      this.data.examFinished,
    );
    this.setData({
      subjectiveAnswer,
      responses,
      answerCardItems,
      answeredCount: answerCardItems.filter((item) => item.status !== "empty").length,
    });
  },

  selectAnnotationTool(event) {
    if (this.data.submitted || this.data.subjectiveScoring) return;
    this.setData({ annotationTool: event.currentTarget.dataset.tool });
  },

  markAnnotationCharacter(event) {
    if (this.data.submitted || this.data.subjectiveScoring) return;
    const index = Number(event.currentTarget.dataset.index);
    const tokens = this.data.annotationTokens.map((token, tokenIndex) => {
      if (tokenIndex !== index) return token;
      const mark = token.mark === this.data.annotationTool ? "" : this.data.annotationTool;
      return { ...token, mark, symbol: mark === "dot" ? "•" : (mark === "subscript" ? "·" : "") };
    });
    this.updateAnnotationResponse(tokens, this.data.annotationNote);
  },

  clearAnnotationMarks() {
    if (this.data.submitted || this.data.subjectiveScoring) return;
    this.updateAnnotationResponse(this.data.annotationTokens.map((token) => ({ ...token, mark: "", symbol: "" })), this.data.annotationNote);
  },

  updateAnnotationNote(event) {
    this.updateAnnotationResponse(this.data.annotationTokens, event.detail.value);
  },

  updateAnnotationResponse(annotationTokens, annotationNote) {
    const subjectiveAnswer = annotationAnswerText(annotationTokens, annotationNote);
    const responses = {
      ...this.data.responses,
      [this.data.question.id]: {
        ...(this.data.responses[this.data.question.id] || {}),
        annotationTokens,
        annotationNote,
        subjectiveAnswer,
        answeredAt: String(subjectiveAnswer || "").trim()
          ? (this.data.responses[this.data.question.id]?.answeredAt || Date.now())
          : 0,
      },
    };
    const answerCardItems = buildAnswerCard(this.data.questionQueue, responses, this.data.currentQuestionIndex, this.data.examFinished);
    this.setData({
      annotationTokens,
      annotationNote,
      subjectiveAnswer,
      responses,
      answerCardItems,
      answeredCount: answerCardItems.filter((item) => item.status !== "empty").length,
    });
  },

  submitAnswer() {
    if (!["normal", "review", "pack"].includes(this.data.practiceMode)) return;
    if (isSubjectiveQuestion(this.data.question)) {
      this.submitSubjectiveAnswer();
      return;
    }
    if (!normalizePracticeSelection(this.data.selected).length) {
      wx.showToast({ title: "请先选择答案", icon: "none" });
      return;
    }

    const evaluation = evaluateQuestionAnswer(this.data.question, this.data.selected);
    const isCorrect = evaluation.isCorrect;
    const mastery = isCorrect ? "" : "unknown";
    const responses = {
      ...this.data.responses,
      [this.data.question.id]: {
        ...(this.data.responses[this.data.question.id] || {}),
        selected: this.data.selected,
        submitted: true,
        isCorrect,
        answerStatus: evaluation.status,
        awardedScore: evaluation.awardedScore,
        mastery,
      },
    };
    const answerCardItems = buildAnswerCard(
      this.data.questionQueue,
      responses,
      this.data.currentQuestionIndex,
    );
    if (!isCorrect) wx.setStorageSync(`shukao_mastery_${this.data.question.id}`, "unknown");
    this.setData({ submitted: true, isCorrect, answerStatus: evaluation.status, awardedScore: evaluation.awardedScore, mastery, responses, answerCardItems });
    if (!isCorrect) this.recordReviewCompletion(false, "unknown", evaluation.status, evaluation.awardedScore);
    this.recordAttemptAndReview(this.data.selected, isCorrect, evaluation.awardedScore, {
      answerStatus: evaluation.status,
      awardedScore: evaluation.awardedScore,
      mastery,
    });
  },

  submitSubjectiveAnswer() {
    const answer = String(this.data.subjectiveAnswer || "").trim();
    const minimumLength = this.data.question.responseMode === "annotation" ? 4 : 10;
    if (answer.length < minimumLength) {
      wx.showToast({ title: this.data.question.responseMode === "annotation" ? "请先完成句子标记" : "请至少填写 10 个字后提交", icon: "none" });
      return;
    }
    const previousResponse = this.data.responses[this.data.question.id] || {};
    const responses = {
      ...this.data.responses,
      [this.data.question.id]: {
        ...previousResponse,
        subjectiveAnswer: answer,
        submitted: true,
        answeredAt: previousResponse.answeredAt || Date.now(),
      },
    };
    delete responses[this.data.question.id].isCorrect;
    delete responses[this.data.question.id].subjectiveScoreResult;
    const answerCardItems = buildAnswerCard(this.data.questionQueue, responses, this.data.currentQuestionIndex);
    this.setData({
      submitted: true,
      isCorrect: false,
      answerStatus: "unscored",
      subjectiveScoreResult: null,
      subjectiveScoreFeedback: "",
      responses,
      answerCardItems,
      answeredCount: answerCardItems.filter((item) => item.status !== "empty").length,
      aiSessionResult: "答案已提交",
    });
    this.recordAttemptAndReview(answer, null, null, {
      answerStatus: "unscored",
      mastery: "",
    });
  },

  recordAttemptAndReview(submittedAnswer, isCorrect, score = null, details = {}) {
    const attempts = wx.getStorageSync("shukao_attempts") || [];
    const now = Date.now();
    const evaluated = typeof isCorrect === "boolean";
    const subjective = isSubjectiveQuestion(this.data.question);
    const answerStatus = details.answerStatus || (evaluated ? (isCorrect ? "correct" : "wrong") : "unscored");
    const mastery = details.mastery !== undefined ? details.mastery : (isCorrect === false ? "unknown" : "");
    const response = {
      selected: subjective ? "" : submittedAnswer,
      subjectiveAnswer: subjective ? String(submittedAnswer || "") : "",
      submitted: true,
      isCorrect: isCorrect === true,
      answerStatus,
      awardedScore: Number(details.awardedScore ?? score) || 0,
      mastery,
    };
    if (!subjective && Array.isArray(this.data.question.optionOrder) && this.data.question.optionOrder.length) {
      response.optionOrder = [...this.data.question.optionOrder];
    }
    if (details.subjectiveScoreResult) response.subjectiveScoreResult = details.subjectiveScoreResult;
    if (subjective && this.data.question.responseMode === "annotation") {
      response.annotationTokens = this.data.annotationTokens;
      response.annotationNote = this.data.annotationNote;
    }
    if (details.replaceLatest) {
      const previousIndex = attempts.findIndex((attempt) => attempt.questionId === this.data.question.id);
      if (previousIndex >= 0) attempts.splice(previousIndex, 1);
    }
    attempts.unshift({
      id: `attempt-${this.data.question.id}-${now}`,
      questionId: this.data.question.id,
      versionId: `${this.data.question.id}-v1`,
      subjectId: this.data.question.subjectId || "modern-chinese",
      chapterId: this.data.question.chapterId || "",
      sectionId: this.data.question.sectionId || "",
      knowledgePoint: this.data.question.knowledgePoint || "",
      selected: isSubjectiveQuestion(this.data.question) ? "" : submittedAnswer,
      submittedAnswer,
      isCorrect: evaluated ? isCorrect : null,
      score,
      answerStatus,
      mastery,
      response,
      practiceMode: this.data.practiceMode,
      createdAt: now,
      updatedAt: now,
      question: {
        id: this.data.question.id,
        subjectId: this.data.question.subjectId || "modern-chinese",
        bookId: this.data.question.bookId || "",
        chapterId: this.data.question.chapterId || "",
        sectionId: this.data.question.sectionId || "",
        headingId: this.data.question.headingId || "",
        breadcrumb: this.data.question.breadcrumb || "",
        knowledgePoint: this.data.question.knowledgePoint || "",
        stem: this.data.question.stem || "",
        type: this.data.question.type || "",
        typeLabel: this.data.question.typeLabel || "",
        answerMode: this.data.question.answerMode || "choice",
        options: this.data.question.options || [],
        correctAnswer: this.data.question.correctAnswer || [],
        referenceAnswer: this.data.question.referenceAnswer || "",
        answerVariants: this.data.question.answerVariants || {},
        answerSource: this.data.question.answerSource || "",
        source: this.data.question.source || "",
        scoringPoints: this.data.question.scoringPoints || [],
        maxScore: Number(this.data.question.maxScore || this.data.question.score) || 0,
      },
    });
    wx.setStorageSync("shukao_attempts", attempts.slice(0, 100));
    if (!evaluated || details.skipReview) {
      this.syncLearningProgress();
      return;
    }

    const reviewStates = normalizeReviewStates(wx.getStorageSync("shukao_review_states"));
    const existingState = reviewStates[this.data.question.id];
    const reviewState = isCorrect
      ? (existingState
        ? {
          ...existingState,
          lastReviewAt: now,
          lastIsCorrect: true,
          removedManually: false,
        }
        : createInitialReviewState(this.data.question.id, true, now))
      : scheduleReview(existingState, {
        questionId: this.data.question.id,
        mastery: "unknown",
        isCorrect: false,
      }, now);
    wx.setStorageSync("shukao_review_states", saveReviewState(reviewStates, reviewState));
    this.syncLearningProgress();
  },

  syncLearningProgress() {
    const app = getApp();
    if (typeof app.syncLearningState === "function" && app.globalData.loggedIn) app.syncLearningState();
  },

  invokeSubjectiveScorer(answer, requestId, isRescore, callback) {
    const apiBaseUrl = String(getApp().globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (apiBaseUrl && typeof wx.request === "function") {
      wx.request({
        url: `${apiBaseUrl}/api/ai/score`,
        method: "POST",
        timeout: 60000,
        data: {
          questionId: this.data.question.id,
          answer,
          requestId,
          rescore: isRescore,
        },
        success: (response) => {
          const payload = response.data || {};
          callback(
            response.statusCode === 200 && payload.success ? payload.result : null,
            response.statusCode === 200 && payload.success ? "" : String(payload.error || "scoring_failed"),
            response.statusCode === 200 && payload.success ? payload.chargeable === true : false,
          );
        },
        fail: (error) => callback(null, String(error && error.errMsg || "request_failed")),
      });
      return;
    }
    setTimeout(() => {
      try {
        callback(scoreSubjectiveAnswer(this.data.question, answer, { requestId }), "", false);
      } catch (error) {
        callback(null);
      }
    }, 450);
  },

  startSubjectiveScoringProgress() {
    this.stopSubjectiveScoringProgress();
    this.setData({ subjectiveScoring: true, subjectiveScoringStage: "正在核对得分点" });
    this.subjectiveScoringStageTimers = [
      setTimeout(() => {
        if (this.data.subjectiveScoring) this.setData({ subjectiveScoringStage: "正在比对参考答案" });
      }, 4000),
      setTimeout(() => {
        if (this.data.subjectiveScoring) this.setData({ subjectiveScoringStage: "正在生成评分报告" });
      }, 10000),
    ];
  },

  stopSubjectiveScoringProgress() {
    (this.subjectiveScoringStageTimers || []).forEach(clearTimeout);
    this.subjectiveScoringStageTimers = [];
  },

  requestSubjectiveScore(isRescore = false) {
    if (this.data.subjectiveScoring || !isSubjectiveQuestion(this.data.question)) return;
    if (!isRescore && !this.data.submitted) return;
    if (this.data.question.scoringPointStatus && this.data.question.scoringPointStatus !== "complete") {
      wx.showToast({ title: "得分点待完善，暂不能评分", icon: "none" });
      return;
    }
    const answer = String(this.data.subjectiveAnswer || "").trim();
    const minimumLength = this.data.question.responseMode === "annotation" ? 4 : 10;
    if (answer.length < minimumLength) {
      wx.showToast({ title: this.data.question.responseMode === "annotation" ? "请先完成句子标记" : "请至少填写 10 个字后再评分", icon: "none" });
      return;
    }
    const app = getApp();
    if (app.globalData.aiCredits < 1) {
      wx.showToast({ title: "AI 额度不足", icon: "none" });
      return;
    }

    this.startSubjectiveScoringProgress();
    const requestId = `subjective-score-${Date.now()}`;
    this.invokeSubjectiveScorer(answer, requestId, isRescore, (scoreResult, failureReason = "", chargeable = true) => {
      const validResult = isValidScoreResult(scoreResult);
      const creditSettled = validResult && (chargeable !== true || app.spendAiCredit(1, {
        referenceId: scoreResult.requestId || requestId,
        source: "subjective_scoring",
        description: isRescore ? "主观题重新评分" : "主观题评分",
      }));
      if (!validResult || !creditSettled) {
        this.stopSubjectiveScoringProgress();
        this.setData({ subjectiveScoring: false, subjectiveScoringStage: "", aiCredits: app.globalData.aiCredits });
        const failureTitle = failureReason === "question_scoring_not_ready"
          ? "得分点待完善，暂不能评分"
          : /timeout/i.test(failureReason)
          ? "评分超时，未扣额度"
          : (/fetch failed|network|request:fail/i.test(failureReason) ? "网络异常，未扣额度" : "评分失败，未扣额度");
        wx.showToast({ title: failureTitle, icon: "none" });
        return;
      }

      const isCorrect = scoreResult.totalScore >= scoreResult.maxScore * 0.6;
      const mastery = isCorrect ? "" : "unknown";
      const previousResponse = this.data.responses[this.data.question.id] || {};
      const responses = {
        ...this.data.responses,
        [this.data.question.id]: {
          ...previousResponse,
          subjectiveAnswer: answer,
          subjectiveScoreResult: scoreResult,
          submitted: true,
          isCorrect,
          mastery,
        },
      };
      const answerCardItems = buildAnswerCard(
        this.data.questionQueue,
        responses,
        this.data.currentQuestionIndex,
      );
      const scoreHistory = wx.getStorageSync("shukao_subjective_score_history") || [];
      scoreHistory.unshift({
        questionId: this.data.question.id,
        subjectId: this.data.question.subjectId || "modern-chinese",
        chapterId: this.data.question.chapterId || "",
        answer,
        result: scoreResult,
        isRescore,
        createdAt: Date.now(),
      });
      wx.setStorageSync("shukao_subjective_score_history", scoreHistory.slice(0, 50));
      this.syncLearningProgress();
      if (!isCorrect) this.recordReviewCompletion(false, "unknown", "wrong", scoreResult.totalScore, true);
      this.recordAttemptAndReview(answer, isCorrect, scoreResult.totalScore, {
        answerStatus: isCorrect ? "correct" : "wrong",
        awardedScore: scoreResult.totalScore,
        mastery,
        subjectiveScoreResult: scoreResult,
        replaceLatest: true,
        skipReview: isRescore,
      });
      if (!isCorrect) wx.setStorageSync(`shukao_mastery_${this.data.question.id}`, "unknown");
      this.stopSubjectiveScoringProgress();
      this.setData({
        subjectiveScoring: false,
        subjectiveScoringStage: "",
        subjectiveScoreResult: scoreResult,
        subjectiveScoreFeedback: "",
        submitted: true,
        isCorrect,
        mastery,
        responses,
        answerCardItems,
        answeredCount: answerCardItems.filter((item) => item.status !== "empty").length,
        aiCredits: app.globalData.aiCredits,
        aiSessionResult: `AI 评分 ${scoreResult.totalScore}/${scoreResult.maxScore}`,
      });
    });
  },

  requestSubjectiveRescore() {
    this.requestSubjectiveScore(true);
  },

  requestInitialSubjectiveScore() {
    this.requestSubjectiveScore(false);
  },

  rateSubjectiveScore(event) {
    const scoreResult = this.data.subjectiveScoreResult;
    if (!scoreResult) return;
    const value = event.currentTarget.dataset.value;
    const storedFeedback = wx.getStorageSync("shukao_subjective_score_feedback") || [];
    const feedback = [{
      requestId: scoreResult.requestId,
      questionId: this.data.question.id,
      value,
      createdAt: Date.now(),
    }].concat(storedFeedback.filter((item) => item.requestId !== scoreResult.requestId));
    wx.setStorageSync("shukao_subjective_score_feedback", feedback.slice(0, 100));
    this.setData({ subjectiveScoreFeedback: value });
  },

  openSubjectiveScoreFeedback() {
    const scoreResult = this.data.subjectiveScoreResult;
    if (!scoreResult) return;
    this.setData({
      utilityPanel: "feedback",
      utilityTitle: "评分问题反馈",
      feedbackType: "issue",
      feedbackText: `评分编号：${scoreResult.requestId}\n`,
    });
  },

  toggleBookmark() {
    const bookmarked = !this.data.bookmarked;
    this.setData({ bookmarked });
    wx.setStorageSync(`shukao_bookmark_${this.data.question.id}`, bookmarked);
    const bookmarks = wx.getStorageSync("shukao_bookmarks") || {};
    wx.setStorageSync("shukao_bookmarks", {
      ...bookmarks,
      [this.data.question.id]: { value: bookmarked, updatedAt: Date.now() },
    });
    this.syncLearningProgress();
    wx.showToast({ title: this.data.bookmarked ? "已收藏" : "已取消收藏", icon: "none" });
  },

  voteQuestion(event) {
    const nextVote = event.currentTarget.dataset.vote;
    const currentVote = this.data.questionVote;
    let helpfulCount = this.data.helpfulCount;
    let unhelpfulCount = this.data.unhelpfulCount;
    let questionVote = nextVote;

    if (currentVote === nextVote) {
      questionVote = "";
      if (nextVote === "helpful") helpfulCount = Math.max(0, helpfulCount - 1);
      if (nextVote === "unhelpful") unhelpfulCount = Math.max(0, unhelpfulCount - 1);
    } else {
      if (currentVote === "helpful") helpfulCount = Math.max(0, helpfulCount - 1);
      if (currentVote === "unhelpful") unhelpfulCount = Math.max(0, unhelpfulCount - 1);
      if (nextVote === "helpful") helpfulCount += 1;
      if (nextVote === "unhelpful") unhelpfulCount += 1;
    }

    this.setData({ questionVote, helpfulCount, unhelpfulCount });
    wx.setStorageSync(`shukao_question_vote_${this.data.question.id}`, {
      vote: questionVote,
      helpfulCount,
      unhelpfulCount,
    });
  },

  showKnowledgePoint() {
    wx.showModal({
      title: "知识点",
      content: this.data.question.knowledgePoint || "暂无知识点",
      showCancel: false,
      confirmText: "知道了",
    });
  },

  setMastery(event) {
    if (
      this.data.advancing
      || !this.data.submitted
      || !["normal", "review", "pack"].includes(this.data.practiceMode)
    ) return;
    const mastery = event.currentTarget.dataset.value;
    const unscoredSubjective = this.data.question.answerMode === "text" && !this.data.subjectiveScoreResult;
    if (mastery === "familiar" && !this.data.isCorrect && !unscoredSubjective) return;
    const responses = {
      ...this.data.responses,
      [this.data.question.id]: {
        ...(this.data.responses[this.data.question.id] || {}),
        mastery,
      },
    };
    this.setData({ mastery, advancing: true, responses });
    wx.setStorageSync(`shukao_mastery_${this.data.question.id}`, mastery);
    const attempts = wx.getStorageSync("shukao_attempts") || [];
    const latestAttemptIndex = attempts.reduce((latestIndex, attempt, index) => {
      if (attempt.questionId !== this.data.question.id) return latestIndex;
      if (latestIndex < 0) return index;
      return Number(attempt.createdAt || 0) > Number(attempts[latestIndex].createdAt || 0)
        ? index
        : latestIndex;
    }, -1);
    if (latestAttemptIndex >= 0) {
      const latestAttempt = attempts[latestAttemptIndex];
      attempts[latestAttemptIndex] = {
        ...latestAttempt,
        mastery,
        updatedAt: Date.now(),
        response: {
          ...(latestAttempt.response || {}),
          mastery,
        },
      };
      wx.setStorageSync("shukao_attempts", attempts);
    }
    const reviewStates = normalizeReviewStates(wx.getStorageSync("shukao_review_states"));
    const masteryIsCorrect = unscoredSubjective ? mastery !== "unknown" : this.data.isCorrect;
    const reviewState = scheduleReview(
      reviewStates[this.data.question.id],
      {
        questionId: this.data.question.id,
        mastery,
        isCorrect: masteryIsCorrect,
      },
    );
    wx.setStorageSync("shukao_review_states", saveReviewState(reviewStates, reviewState));
    this.recordReviewCompletion(
      masteryIsCorrect,
      mastery,
      unscoredSubjective ? "unscored" : (masteryIsCorrect ? "correct" : "wrong"),
      this.data.awardedScore,
      !!this.data.subjectiveScoreResult,
    );
    this.syncLearningProgress();
    this.masteryAdvanceTimer = setTimeout(() => this.nextQuestion(), 220);
  },

  recordReviewCompletion(isCorrect, mastery, answerStatus, score = 0, aiScored = false) {
    if (this.data.practiceMode !== "review" || !this.data.question || !this.data.question.id) return;
    const now = Date.now();
    const dateKey = reviewDateKey(now);
    const history = wx.getStorageSync("shukao_review_history") || [];
    const id = `review-${dateKey}-${this.data.question.id}`;
    const existingIndex = history.findIndex((entry) => entry && entry.id === id);
    const status = !isCorrect || mastery === "unknown"
      ? "pending"
      : (mastery === "familiar" ? "mastered" : (mastery === "fuzzy" ? "reinforcing" : "corrected"));
    const existing = existingIndex >= 0 ? history[existingIndex] : null;
    const entry = {
      id,
      dateKey,
      questionId: this.data.question.id,
      question: {
        id: this.data.question.id,
        stem: this.data.question.stem || "",
        breadcrumb: this.data.question.breadcrumb || "",
        knowledgePoint: this.data.question.knowledgePoint || "",
        subjectId: this.data.question.subjectId || "",
        bookId: this.data.question.bookId || "",
      },
      isCorrect: isCorrect === true,
      mastery,
      status,
      answerStatus,
      score: Number(score) || 0,
      aiScored: aiScored === true,
      attemptCount: Number(existing && existing.attemptCount || 0) + 1,
      firstReviewedAt: Number(existing && existing.firstReviewedAt) || now,
      updatedAt: now,
    };
    if (existingIndex >= 0) history.splice(existingIndex, 1);
    history.unshift(entry);
    wx.setStorageSync("shukao_review_history", history.slice(0, 500));
  },

  openAiDialog() {
    this.setData({ aiDialogOpen: true, catalogOpen: false, searchOpen: false, searchFocus: false });
  },

  closeAiDialog() {
    this.setData({ aiDialogOpen: false, aiHistoryOpen: false, aiInput: "" });
  },

  handleAiResizeStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch || !this.aiDialogBounds) return;
    this.aiResizeState = {
      startY: touch.clientY,
      startHeight: this.data.aiDialogHeight,
      currentHeight: this.data.aiDialogHeight,
    };
    this.setData({ aiDialogDragging: true });
  },

  handleAiResizeMove(event) {
    const touch = event.touches && event.touches[0];
    const resize = this.aiResizeState;
    const bounds = this.aiDialogBounds;
    if (!touch || !resize || !bounds) return;
    const nextHeight = resize.startHeight + resize.startY - touch.clientY;
    const aiDialogHeight = Math.min(bounds.maxHeight, Math.max(bounds.minHeight, nextHeight));
    resize.currentHeight = aiDialogHeight;
    this._pendingAiDialogHeight = aiDialogHeight;
    if (this._aiResizeMoveTimer) return;
    this._aiResizeMoveTimer = setTimeout(() => {
      this._aiResizeMoveTimer = null;
      const pendingHeight = this._pendingAiDialogHeight;
      this._pendingAiDialogHeight = null;
      if (Number.isFinite(pendingHeight) && !this._pageHidden) this.setData({ aiDialogHeight: pendingHeight });
    }, 16);
  },

  handleAiResizeEnd() {
    const bounds = this.aiDialogBounds;
    const finalHeight = this.aiResizeState && Number.isFinite(this.aiResizeState.currentHeight)
      ? this.aiResizeState.currentHeight
      : this.data.aiDialogHeight;
    if (this._aiResizeMoveTimer) clearTimeout(this._aiResizeMoveTimer);
    this._aiResizeMoveTimer = null;
    this._pendingAiDialogHeight = null;
    this.aiResizeState = null;
    this.setData({ aiDialogDragging: false, aiDialogHeight: finalHeight });
    if (!bounds) return;
    const range = bounds.maxHeight - bounds.minHeight;
    const ratio = range > 0 ? (finalHeight - bounds.minHeight) / range : 0;
    wx.setStorageSync("shukao_ai_dialog_height_ratio", ratio);
  },

  openAiHistory() {
    this.setData({ aiHistoryOpen: true });
  },

  closeAiHistory() {
    this.setData({ aiHistoryOpen: false });
  },

  startNewAiSession() {
    this.setData({
      aiHistoryOpen: false,
      activeAiSessionId: "",
      aiContent: "",
      aiMessages: [],
      aiInput: "",
      aiScrollTarget: "",
      aiSessionKnowledge: this.data.question.knowledgePoint,
      aiSessionResult: this.data.subjectiveScoreResult
        ? `AI 评分 ${this.data.subjectiveScoreResult.totalScore}/${this.data.subjectiveScoreResult.maxScore}`
        : (this.data.isCorrect ? "回答正确" : "回答错误"),
    });
  },

  selectAiSession(event) {
    const sessionId = event.currentTarget.dataset.sessionId;
    const session = this.data.aiHistory.find((item) => item.id === sessionId);
    if (!session) return;
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const aiScrollTarget = messages.length ? messages[messages.length - 1].id : "";
    this.setData(
      {
        aiHistoryOpen: false,
        activeAiSessionId: session.id,
        aiContent: session.aiContent || "",
        aiMessages: messages,
        aiInput: "",
        aiSessionKnowledge: session.knowledgePoint || this.data.question.knowledgePoint,
        aiSessionResult: session.resultLabel || "",
      },
      () => this.setData({ aiScrollTarget }),
    );
  },

  persistAiSession(messages, aiContent) {
    const now = Date.now();
    const sessionId = this.data.activeAiSessionId || `ai-session-${now}`;
    const existingSession = this.data.aiHistory.find((item) => item.id === sessionId);
    const session = {
      id: sessionId,
      questionId: existingSession ? existingSession.questionId : this.data.question.id,
      title: existingSession ? existingSession.title : this.data.question.stem,
      knowledgePoint: existingSession ? existingSession.knowledgePoint : this.data.question.knowledgePoint,
      resultLabel: existingSession
        ? existingSession.resultLabel
        : (this.data.subjectiveScoreResult
          ? `AI 评分 ${this.data.subjectiveScoreResult.totalScore}/${this.data.subjectiveScoreResult.maxScore}`
          : (this.data.isCorrect ? "回答正确" : "回答错误")),
      updatedAt: now,
      timeLabel: formatAiHistoryTime(now),
      aiContent,
      messages,
    };
    const aiHistory = [session]
      .concat(this.data.aiHistory.filter((item) => item.id !== sessionId))
      .slice(0, 30);
    this.setData({
      activeAiSessionId: sessionId,
      aiHistory,
      aiSessionKnowledge: session.knowledgePoint,
      aiSessionResult: session.resultLabel,
    });
    wx.setStorageSync("shukao_ai_history", aiHistory);
  },

  invokeAiExplanation(userMessage, conversationHistory, handlers) {
    const apiBaseUrl = String(getApp().globalData.apiBaseUrl || "").replace(/\/$/, "");
    const question = this.data.question;
    const requestId = `explain-${Date.now()}`;
    const userAnswer = isSubjectiveQuestion(question)
      ? String(this.data.subjectiveAnswer || "").trim()
      : String(this.data.selected || "").trim();
    const resultLabel = this.data.subjectiveScoreResult
      ? `AI 评分 ${this.data.subjectiveScoreResult.totalScore}/${this.data.subjectiveScoreResult.maxScore}`
      : (this.data.submitted ? (this.data.isCorrect ? "回答正确" : "回答错误") : "尚未提交答案");
    const data = {
      questionId: question.id,
      userMessage,
      conversationHistory: conversationHistory.map((message) => ({ role: message.role, text: message.text })),
      userAnswer,
      resultLabel,
      requestId,
    };

    const requestLegacy = () => {
      wx.request({
        url: `${apiBaseUrl}/api/ai/explain`,
        method: "POST",
        timeout: 30000,
        data,
        success: (response) => {
          const payload = response.data || {};
          const result = response.statusCode === 200 && payload.success && payload.result
            ? { ...payload.result, chargeable: payload.chargeable === true }
            : null;
          if (!result) {
            handlers.onError(String(payload.error || "explanation_request_failed"));
            return;
          }
          handlers.onDelta(String(result.text || ""), String(result.text || ""));
          handlers.onDone(result);
        },
        fail: () => handlers.onError("network_error"),
      });
    };

    if (apiBaseUrl && typeof wx.request === "function") {
      const decoder = createUtf8StreamDecoder();
      let buffer = "";
      let fullText = "";
      let streamRequestId = requestId;
      let receivedChunks = false;
      let settled = false;
      let switchedToLegacy = false;
      const fail = (error) => {
        if (settled || switchedToLegacy) return;
        settled = true;
        handlers.onError(String(error || "explanation_request_failed"));
      };
      const consumeEvent = (event) => {
        if (!event || settled) return;
        if (event.type === "meta") {
          streamRequestId = event.requestId || streamRequestId;
          return;
        }
        if (event.type === "delta") {
          const delta = String(event.text || "");
          if (!delta) return;
          fullText += delta;
          handlers.onDelta(fullText, delta);
          return;
        }
        if (event.type === "error") {
          fail(event.error);
          return;
        }
        if (event.type === "done") {
          if (!fullText.trim() || event.chargeable !== true) {
            fail("provider_empty_response");
            return;
          }
          settled = true;
          handlers.onDone({
            requestId: streamRequestId,
            text: fullText,
            chargeable: true,
            model: event.model || "",
            usage: event.usage || null,
          });
        }
      };
      const consumeText = (text, flush = false) => {
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        if (flush && buffer.trim()) {
          lines.push(buffer);
          buffer = "";
        }
        lines.forEach((line) => {
          if (!line.trim()) return;
          try { consumeEvent(JSON.parse(line)); } catch (error) { fail("stream_output_format_error"); }
        });
      };
      const task = wx.request({
        url: `${apiBaseUrl}/api/ai/explain/stream`,
        method: "POST",
        enableChunked: true,
        timeout: 30000,
        data,
        success: (response) => {
          if (settled || switchedToLegacy) return;
          if (!receivedChunks && typeof response.data === "string") consumeText(response.data);
          consumeText(decoder.flush(), true);
          if (settled) return;
          const payload = response.data && typeof response.data === "object" ? response.data : {};
          fail(payload.error || (response.statusCode === 200 ? "stream_incomplete" : "explanation_request_failed"));
        },
        fail: () => fail("network_error"),
      });
      if (!task || typeof task.onChunkReceived !== "function") {
        switchedToLegacy = true;
        if (task && typeof task.abort === "function") task.abort();
        requestLegacy();
        return;
      }
      task.onChunkReceived((event) => {
        if (settled || switchedToLegacy) return;
        receivedChunks = true;
        const chunk = event && event.data;
        consumeText(typeof chunk === "string" ? chunk : decoder.decode(chunk));
      });
      return;
    }
    setTimeout(() => {
      const fallbackText = conversationHistory.length
        ? `这道题对应的知识点是“${question.knowledgePoint}”。可以先回到教材依据核对：${question.referenceAnswer}再结合你的追问“${userMessage}”逐项判断。`
        : createInitialAiReply(question, {
          subjectiveScoreResult: this.data.subjectiveScoreResult,
          subjectiveAnswer: this.data.subjectiveAnswer,
        });
      handlers.onDelta(fallbackText, fallbackText);
      handlers.onDone({ requestId: `local-explain-${Date.now()}`, text: fallbackText, chargeable: true });
    }, 450);
  },

  showAiExplanationError(error) {
    const title = error === "explanation_route_unavailable"
      ? "请先在后台启用解析模型"
      : (error === "network_error" ? "无法连接解析服务，未扣额度" : "解析生成失败，未扣额度");
    wx.showToast({ title, icon: "none" });
  },

  scheduleAiStreamRender(createPatch) {
    this._pendingAiStreamPatch = createPatch;
    if (this._pageHidden) return;
    const now = Date.now();
    const elapsed = now - (this._lastAiStreamRenderAt || 0);
    if (!this._lastAiStreamRenderAt || elapsed >= 50) {
      const pending = this._pendingAiStreamPatch;
      this._pendingAiStreamPatch = null;
      this._lastAiStreamRenderAt = now;
      if (pending) this.setData(pending());
      return;
    }
    if (this._aiStreamRenderTimer) return;
    this._aiStreamRenderTimer = setTimeout(() => {
      this._aiStreamRenderTimer = null;
      const pending = this._pendingAiStreamPatch;
      this._pendingAiStreamPatch = null;
      if (pending && !this._pageHidden) {
        this._lastAiStreamRenderAt = Date.now();
        this.setData(pending());
      }
    }, Math.max(0, 50 - elapsed));
  },

  cancelAiStreamRender() {
    if (this._aiStreamRenderTimer) clearTimeout(this._aiStreamRenderTimer);
    this._aiStreamRenderTimer = null;
    this._pendingAiStreamPatch = null;
    this._lastAiStreamRenderAt = 0;
  },

  requestAiExplanation() {
    if (this.data.aiGenerating || this.data.aiContent) return;
    const app = getApp();
    if (app.globalData.aiCredits < 1) {
      wx.showToast({ title: "AI 额度不足", icon: "none" });
      return;
    }

    const messageId = `ai-stream-${Date.now()}`;
    const pendingMessage = normalizeAiMessage({ id: messageId, role: "assistant", text: "", streaming: true });
    this.setData({ aiGenerating: true, aiMessages: [pendingMessage], aiScrollTarget: messageId });
    this.invokeAiExplanation("请结合当前题目、参考答案和我的作答生成补充解析。", [], {
      onDelta: (text) => {
        this.scheduleAiStreamRender(() => {
          const message = normalizeAiMessage({ id: messageId, role: "assistant", text, streaming: true });
          return { aiContent: text, aiMessages: [message], aiScrollTarget: messageId };
        });
      },
      onDone: (result) => {
        this.cancelAiStreamRender();
        const initialAiReply = String(result.text || "").trim();
        if (!initialAiReply || !result.chargeable || !app.spendAiCredit(1, {
          referenceId: result.requestId,
          source: "explanation_chat",
          description: "生成题目解析",
        })) {
          this.setData({ aiGenerating: false, aiContent: "", aiMessages: [], aiCredits: app.globalData.aiCredits });
          this.showAiExplanationError("explanation_request_failed");
          return;
        }
        const message = normalizeAiMessage({ id: messageId, role: "assistant", text: initialAiReply, streaming: false });
        this.setData({
          aiGenerating: false,
          aiContent: initialAiReply,
          aiMessages: [message],
          aiCredits: app.globalData.aiCredits,
          aiScrollTarget: messageId,
        }, () => this.persistAiSession([message], initialAiReply));
      },
      onError: (error) => {
        this.cancelAiStreamRender();
        this.setData({ aiGenerating: false, aiContent: "", aiMessages: [], aiCredits: app.globalData.aiCredits });
        this.showAiExplanationError(error);
      },
    });
  },

  updateAiInput(event) {
    this.setData({ aiInput: event.detail.value });
  },

  sendAiFollowUp() {
    const question = this.data.aiInput.trim();
    if (!question || !this.data.aiContent || this.data.aiGenerating) return;
    const app = getApp();
    if (app.globalData.aiCredits < 1) {
      wx.showToast({ title: "AI 额度不足", icon: "none" });
      return;
    }

    const now = Date.now();
    const previousMessages = this.data.aiMessages.slice();
    const userMessage = normalizeAiMessage({ id: `user-${now}`, role: "user", text: question });
    const assistantId = `ai-stream-${now}`;
    const assistantPending = normalizeAiMessage({ id: assistantId, role: "assistant", text: "", streaming: true });
    const pendingMessages = previousMessages.concat(userMessage, assistantPending);
    this.setData(
      { aiInput: "", aiMessages: pendingMessages, aiGenerating: true, aiScrollTarget: assistantId },
    );
    this.invokeAiExplanation(question, previousMessages, {
      onDelta: (text) => {
        this.scheduleAiStreamRender(() => {
          const assistantMessage = normalizeAiMessage({ id: assistantId, role: "assistant", text, streaming: true });
          return { aiMessages: previousMessages.concat(userMessage, assistantMessage), aiScrollTarget: assistantId };
        });
      },
      onDone: (result) => {
        this.cancelAiStreamRender();
        const reply = String(result.text || "").trim();
        if (!reply || !result.chargeable || !app.spendAiCredit(1, {
          referenceId: result.requestId,
          source: "explanation_chat",
          description: "AI 解析追问",
        })) {
          this.setData({ aiGenerating: false, aiMessages: previousMessages, aiCredits: app.globalData.aiCredits });
          this.showAiExplanationError("explanation_request_failed");
          return;
        }
        const assistantMessage = normalizeAiMessage({ id: assistantId, role: "assistant", text: reply, streaming: false });
        const messages = previousMessages.concat(userMessage, assistantMessage);
        this.setData({
          aiGenerating: false,
          aiMessages: messages,
          aiCredits: app.globalData.aiCredits,
          aiScrollTarget: assistantId,
        }, () => this.persistAiSession(messages, this.data.aiContent));
      },
      onError: (error) => {
        this.cancelAiStreamRender();
        this.setData({ aiGenerating: false, aiMessages: previousMessages, aiCredits: app.globalData.aiCredits });
        this.showAiExplanationError(error);
      },
    });
  },

  goPreviousQuestion() {
    if (this.data.isFirstQuestion) {
      wx.showToast({ title: "当前已是第一题", icon: "none" });
      return;
    }
    this.loadQuestion(this.data.currentQuestionIndex - 1);
  },

  requiresMasteryFeedback() {
    if (
      !["normal", "review", "pack"].includes(this.data.practiceMode)
      || !this.data.submitted
      || this.data.mastery
    ) return false;
    const unscoredSubjective = this.data.question.answerMode === "text"
      && !this.data.subjectiveScoreResult;
    return this.data.isCorrect || unscoredSubjective;
  },

  nextQuestion() {
    if (this.requiresMasteryFeedback()) {
      wx.showToast({ title: "请先选择掌握程度", icon: "none" });
      return;
    }
    if (this.data.practiceMode === "exam" && !this.data.examFinished && this.data.isLastQuestion) {
      this.submitExam();
      return;
    }
    if (this.data.isLastQuestion) {
      this.setData({ advancing: false });
      wx.showToast({ title: "本组题目已完成", icon: "none" });
      return;
    }
    this.setData({ advancing: false }, () => this.loadQuestion(this.data.currentQuestionIndex + 1));
  },

  submitExam(options = {}) {
    if (this.data.practiceMode !== "exam" || this.data.examFinished) return;
    if (options.auto === true) {
      this.finishExam(true);
      return;
    }
    const answeredCount = Object.values(this.data.responses).filter((response) => normalizePracticeSelection(response.selected).length || response.subjectiveAnswer).length;
    const unansweredCount = this.data.questionQueue.length - answeredCount;
    wx.showModal({
      title: "确认交卷",
      content: unansweredCount
        ? `还有 ${unansweredCount} 题未作答，确认现在交卷吗？`
        : "已完成全部题目，确认交卷并查看成绩吗？",
      confirmText: "确认交卷",
      success: ({ confirm }) => {
        if (!confirm) return;
        this.finishExam(false);
      },
    });
  },

  finishExam(autoSubmitted) {
    if (this.data.examFinished) return;
    if (this.examTimer) clearInterval(this.examTimer);
    this.examEndsAt = null;
    const examResult = calculateExamResult(
      this.data.questionQueue,
      this.data.responses,
      this.data.examSelectionRules,
      this.data.examDeclaredTotalScore,
    );
    const examHistory = wx.getStorageSync("shukao_exam_results") || [];
    examHistory.unshift({
      id: `exam-${Date.now()}`,
      score: examResult.score,
      totalScore: examResult.totalScore,
      correctCount: examResult.correctCount,
      totalCount: this.data.questionQueue.length,
      autoSubmitted,
      createdAt: Date.now(),
    });
    wx.setStorageSync("shukao_exam_results", examHistory.slice(0, 30));
    this.setData(
      {
        responses: examResult.responses,
        examFinished: true,
        examResult,
        answeredCount: examResult.answeredCount,
        examTimeText: "已交卷",
        utilityPanel: "",
      },
      () => {
        this.loadQuestion(this.data.currentQuestionIndex);
        if (autoSubmitted) wx.showToast({ title: "考试时间到，已自动交卷", icon: "none" });
      },
    );
  },
});

module.exports = {
  applyOptionOrder,
  buildMaterialSegments,
  createCatalogChapters,
  createExamCatalogChapters,
  findCatalogLocation,
  normalizeQuestionSubNumber,
  resolveResumeIndex,
  resolvePackResumeIndex,
  restoreOriginalOptions,
  restorePracticeResponses,
  shuffleOptionOrder,
};
