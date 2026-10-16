const { subjects } = require("../data/catalog");
const { classifyWrongQuestions, normalizeReviewStates } = require("./review-schedule");

const wrongStatusLabels = {
  pending: "待纠正",
  reinforcing: "待巩固",
  mastered: "已掌握",
  history: "历史错题",
};

const subjectColors = ["#3977e8", "#8b63dc", "#d67434", "#119587", "#dc5d67", "#53a847"];

// 04:9x：错误本页的学科圆标改成「淡色底 + 同色箭头」（产品负责人的效果图）。箭头是 3rpx 细笔画，压在**它自己的淡底**上
// 必须还看得清（沿用收藏页图标口径：非文本 ≥3:1）。实测六个原色落在 13% 淡底上：蓝 3.59 / 紫 3.66 / 青 3.17 / 粉 3.11
// 达标，但**橙 2.86、绿 2.63 不达标**——所以箭头色取「原色与黑混 18%」的加深档（六个色都 ≥3.5），圆标底色仍用原色淡铺。
const deepenColor = (color, ratio = 0.18) => {
  const value = String(color || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return color;
  const channels = [0, 2, 4].map((offset) => Math.round(parseInt(value.substr(offset, 2), 16) * (1 - ratio)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
};

function dateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function calendarWeekPageDate(selectedDate, offset) {
  const parts = String(selectedDate || "").split("-").map(Number);
  const current = Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && Number.isFinite(parts[2])
    ? new Date(parts[0], Math.max(0, parts[1] - 1), Math.max(1, parts[2]))
    : new Date();
  const target = new Date(current.getFullYear(), current.getMonth(), current.getDate() + ((Number(offset) || 0) * 7));
  return dateKey(target.getTime());
}

function calendarWeekDateKeys(selectedDate) {
  const parts = String(selectedDate || "").split("-").map(Number);
  const selected = Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && Number.isFinite(parts[2])
    ? new Date(parts[0], Math.max(0, parts[1] - 1), Math.max(1, parts[2]))
    : new Date();
  return Array.from({ length: 7 }, (_, index) => dateKey(new Date(
    selected.getFullYear(),
    selected.getMonth(),
    selected.getDate() + index - 3,
  ).getTime()));
}

function normalizeDirectoryLabel(value, fallback = "") {
  const label = String(value || fallback || "").trim();
  return label.replace(/\s*[·>＞]+\s*/g, " ＞ ").replace(/\s+/g, " ");
}

function questionSubjectName(question = {}) {
  const subject = subjects.find((item) => item.id === question.subjectId);
  if (subject) return subject.name;
  return normalizeDirectoryLabel(String(question.subjectName || question.breadcrumb || "未归类科目").split(/[·>＞]/)[0], "未归类科目");
}

function questionKnowledgePoint(question = {}) {
  const points = Array.isArray(question.knowledgePoints) ? question.knowledgePoints : [];
  return normalizeDirectoryLabel(question.primaryKnowledgePoint || question.knowledgePoint || points[0] || "未归类知识点", "未归类知识点");
}

function breadcrumbParts(question = {}) {
  return String(question.breadcrumb || "").split(/[·>＞]/).map((part) => part.trim()).filter(Boolean);
}

function questionBookName(question = {}) {
  const subject = subjects.find((item) => item.id === question.subjectId);
  const book = subject && subject.books.find((item) => item.id === question.bookId);
  if (book) return normalizeDirectoryLabel(`${book.title}${book.volume ? ` ＞ ${book.volume}` : ""}`);
  const explicit = question.bookName || question.textbookName || question.textbookTitle;
  if (explicit) return normalizeDirectoryLabel(explicit);
  const parts = breadcrumbParts(question);
  return normalizeDirectoryLabel(parts.length >= 3 ? parts[1] : "未归类教材", "未归类教材");
}

function questionChapterName(question = {}) {
  const explicit = question.chapterName || question.chapterTitle || question.chapter;
  if (explicit && !["未归类章节", "未归类"].includes(String(explicit))) return normalizeDirectoryLabel(explicit);
  const parts = breadcrumbParts(question);
  if (parts.length >= 2) return normalizeDirectoryLabel(parts[parts.length - 1]);
  return "未归类章节";
}

function catalogKey(prefix, explicitId, parentKey, label) {
  return explicitId ? `${prefix}:${explicitId}` : `${parentKey}|${prefix}:${label}`;
}

function buildReviewQuestionMap(officialQuestions = [], attempts = [], reviewHistory = []) {
  const questionMap = new Map();
  (Array.isArray(officialQuestions) ? officialQuestions : []).forEach((question) => {
    if (question && question.id) questionMap.set(question.id, question);
  });
  [...(Array.isArray(attempts) ? attempts : []), ...(Array.isArray(reviewHistory) ? reviewHistory : [])]
    .forEach((entry) => {
      const question = entry && entry.question;
      if (question && question.id && !questionMap.has(question.id)) questionMap.set(question.id, question);
    });
  return questionMap;
}

function wrongIdsByStatus(attempts, reviewStates) {
  const groups = classifyWrongQuestions(attempts, normalizeReviewStates(reviewStates));
  return {
    pending: groups.pending,
    reinforcing: [...groups.reinforcing, ...groups.corrected],
    mastered: groups.mastered,
    history: groups.history,
  };
}

function decorateWrongQuestion(question, statusKey) {
  const subjectName = questionSubjectName(question);
  const bookName = questionBookName(question);
  const chapterName = questionChapterName(question);
  const knowledgePoint = questionKnowledgePoint(question);
  const subjectKey = catalogKey("subject", question.subjectId, "root", subjectName);
  const bookKey = catalogKey("book", question.bookId, subjectKey, bookName);
  const chapterKey = catalogKey("chapter", question.chapterId, bookKey, chapterName);
  const knowledgeKey = `${chapterKey}|knowledge:${knowledgePoint}`;
  return {
    ...question,
    subjectName,
    bookName,
    chapterName,
    knowledgePoint,
    subjectKey,
    bookKey,
    chapterKey,
    knowledgeKey,
    wrongStatusLabel: wrongStatusLabels[statusKey],
  };
}

function emptyWrongBookFilters() {
  return { subjects: [], books: [], chapters: [], knowledgePoints: [] };
}

function normalizeWrongBookFilters(filters = {}) {
  return Object.fromEntries(Object.keys(emptyWrongBookFilters()).map((key) => [key, [...new Set(Array.isArray(filters[key]) ? filters[key].map(String) : [])]]));
}

function matchesSelected(value, selected) {
  return !selected.length || selected.includes(value);
}

function filterWrongItems(items, filters) {
  const normalized = normalizeWrongBookFilters(filters);
  return items.filter((item) => matchesSelected(item.subjectKey, normalized.subjects)
    && matchesSelected(item.bookKey, normalized.books)
    && matchesSelected(item.chapterKey, normalized.chapters)
    && matchesSelected(item.knowledgeKey, normalized.knowledgePoints));
}

function optionList(items, valueKey, labelKey, selected) {
  const options = new Map();
  items.forEach((item) => {
    const value = item[valueKey];
    if (!options.has(value)) options.set(value, { value, label: item[labelKey], count: 0 });
    options.get(value).count += 1;
  });
  return [...options.values()].map((option) => ({ ...option, selected: selected.includes(option.value) }));
}

function sanitizeWrongBookFilters(items, filters = {}) {
  const normalized = normalizeWrongBookFilters(filters);
  const subjectValues = new Set(items.map((item) => item.subjectKey));
  normalized.subjects = normalized.subjects.filter((value) => subjectValues.has(value));
  const subjectItems = items.filter((item) => matchesSelected(item.subjectKey, normalized.subjects));
  const bookValues = new Set(subjectItems.map((item) => item.bookKey));
  normalized.books = normalized.books.filter((value) => bookValues.has(value));
  const bookItems = subjectItems.filter((item) => matchesSelected(item.bookKey, normalized.books));
  const chapterValues = new Set(bookItems.map((item) => item.chapterKey));
  normalized.chapters = normalized.chapters.filter((value) => chapterValues.has(value));
  const chapterItems = bookItems.filter((item) => matchesSelected(item.chapterKey, normalized.chapters));
  const knowledgeValues = new Set(chapterItems.map((item) => item.knowledgeKey));
  normalized.knowledgePoints = normalized.knowledgePoints.filter((value) => knowledgeValues.has(value));
  return normalized;
}

function buildWrongBookFilterOptions(items, filters = {}) {
  const normalized = sanitizeWrongBookFilters(items, filters);
  const subjectItems = items.filter((item) => matchesSelected(item.subjectKey, normalized.subjects));
  const bookItems = subjectItems.filter((item) => matchesSelected(item.bookKey, normalized.books));
  const chapterItems = bookItems.filter((item) => matchesSelected(item.chapterKey, normalized.chapters));
  return {
    filters: normalized,
    sections: [
      { key: "subjects", label: "科目", options: optionList(items, "subjectKey", "subjectName", normalized.subjects) },
      { key: "books", label: "教材", options: optionList(subjectItems, "bookKey", "bookName", normalized.books) },
      { key: "chapters", label: "章节", options: optionList(bookItems, "chapterKey", "chapterName", normalized.chapters) },
      { key: "knowledgePoints", label: "知识点", options: optionList(chapterItems, "knowledgeKey", "knowledgePoint", normalized.knowledgePoints) },
    ],
  };
}

function buildDirectoryGroups(items) {
  const subjectMap = new Map();
  items.forEach((item) => {
    if (!subjectMap.has(item.subjectKey)) subjectMap.set(item.subjectKey, { id: item.subjectKey, label: item.subjectName, items: [], chapters: new Map() });
    const subject = subjectMap.get(item.subjectKey);
    subject.items.push(item);
    const directoryChapterKey = `${item.subjectKey}|directory-chapter:${item.chapterName}`;
    if (!subject.chapters.has(directoryChapterKey)) subject.chapters.set(directoryChapterKey, { id: directoryChapterKey, label: item.chapterName, items: [] });
    subject.chapters.get(directoryChapterKey).items.push(item);
  });
  return [...subjectMap.values()].map((subject, index) => {
    const chapters = [...subject.chapters.values()].map((chapter) => ({
      id: chapter.id,
      label: chapter.label,
      count: chapter.items.length,
      secondary: `${new Set(chapter.items.map((item) => item.knowledgePoint)).size} 个知识点`,
      questionIds: chapter.items.map((item) => item.id),
      items: chapter.items,
    }));
    return {
      id: subject.id,
      label: subject.label,
      color: subjectColors[index % subjectColors.length],
      colorDeep: deepenColor(subjectColors[index % subjectColors.length]),
      count: subject.items.length,
      secondary: `${chapters.length} 个章节`,
      questionIds: subject.items.map((item) => item.id),
      children: chapters,
    };
  });
}

function buildKnowledgeGroups(items) {
  const grouped = new Map();
  items.forEach((item) => {
    if (!grouped.has(item.knowledgePoint)) grouped.set(item.knowledgePoint, []);
    grouped.get(item.knowledgePoint).push(item);
  });
  return [...grouped.entries()].map(([label, groupItems], index) => ({
    id: `knowledge-${index}-${label}`,
    label,
    color: subjectColors[index % subjectColors.length],
    colorDeep: deepenColor(subjectColors[index % subjectColors.length]),
    count: groupItems.length,
    secondary: [...new Set(groupItems.map((item) => item.subjectName))].join(" / "),
    questionIds: groupItems.map((item) => item.id),
    items: groupItems,
  }));
}

function buildWrongBookView({ officialQuestions = [], attempts = [], reviewStates = {}, reviewHistory = [], statusKey = "pending", groupMode = "directory", filters = {} } = {}) {
  const questionMap = buildReviewQuestionMap(officialQuestions, attempts, reviewHistory);
  const statusIds = wrongIdsByStatus(attempts, reviewStates);
  const activeStatus = statusIds[statusKey] ? statusKey : "pending";
  const historyItems = statusIds.history.filter((id) => questionMap.has(id)).map((id) => decorateWrongQuestion(questionMap.get(id), activeStatus));
  const filterPanel = buildWrongBookFilterOptions(historyItems, filters);
  const activeItems = statusIds[activeStatus].filter((id) => questionMap.has(id)).map((id) => decorateWrongQuestion(questionMap.get(id), activeStatus));
  const visibleItems = filterWrongItems(activeItems, filterPanel.filters);
  const groupList = groupMode === "knowledge" ? buildKnowledgeGroups(visibleItems) : buildDirectoryGroups(visibleItems);
  const statusOptions = ["pending", "reinforcing", "mastered", "history"].map((key) => ({
    key,
    label: wrongStatusLabels[key],
    count: statusIds[key].filter((id) => questionMap.has(id)).length,
  }));
  return {
    activeStatus,
    activeIds: visibleItems.map((item) => item.id),
    groupList,
    statusOptions,
    filters: filterPanel.filters,
    filterSections: filterPanel.sections,
    filterCount: Object.values(filterPanel.filters).reduce((total, values) => total + values.length, 0),
    filterTags: filterPanel.sections.flatMap((section) => section.options.filter((option) => option.selected).map((option) => ({ key: section.key, value: option.value, label: option.label }))),
    historyCount: statusOptions.find((item) => item.key === "history").count,
    subjectCount: new Set(statusIds.history.map((id) => questionMap.get(id)).filter(Boolean).map(questionSubjectName)).size,
  };
}

function buildCalendarReviewItems({
  officialQuestions = [],
  attempts = [],
  reviewStates = {},
  reviewHistory = [],
  selectedDate = dateKey(),
  includeOverdue = selectedDate === dateKey(),
} = {}) {
  const questionMap = buildReviewQuestionMap(officialQuestions, attempts, reviewHistory);
  const completedIds = new Set((Array.isArray(reviewHistory) ? reviewHistory : [])
    .filter((entry) => entry && entry.dateKey === selectedDate)
    .map((entry) => entry.questionId));
  return Object.values(normalizeReviewStates(reviewStates))
    .filter((state) => {
      const scheduledDate = dateKey(Number(state.nextReviewAt));
      const isScheduled = includeOverdue ? scheduledDate <= selectedDate : scheduledDate === selectedDate;
      return !state.removedManually
        && isScheduled
        && !completedIds.has(state.questionId)
        && questionMap.has(state.questionId);
    })
    .sort((left, right) => Number(left.nextReviewAt) - Number(right.nextReviewAt))
    .map((state) => {
      const question = questionMap.get(state.questionId);
      return {
        ...question,
        subjectName: questionSubjectName(question),
        knowledgePoint: questionKnowledgePoint(question),
        stage: Math.max(0, Math.min(5, Number(state.stage) || 0)),
        scheduledDate: dateKey(Number(state.nextReviewAt)),
        overdue: dateKey(Number(state.nextReviewAt)) < selectedDate,
      };
    });
}

function buildCalendarCompletedItems({ officialQuestions = [], attempts = [], reviewHistory = [], selectedDate = dateKey() } = {}) {
  const questionMap = buildReviewQuestionMap(officialQuestions, attempts, reviewHistory);
  const latestEntries = new Map();
  [...(Array.isArray(reviewHistory) ? reviewHistory : [])]
    .filter((entry) => entry && entry.questionId && entry.dateKey === selectedDate)
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .forEach((entry) => {
      if (!latestEntries.has(entry.questionId)) latestEntries.set(entry.questionId, entry);
    });
  return [...latestEntries.values()]
    .map((entry) => {
      const question = questionMap.get(entry.questionId) || entry.question;
      if (!question) return null;
      return {
        ...question,
        subjectName: questionSubjectName(question),
        status: entry.status || "corrected",
        updatedAt: Number(entry.updatedAt || 0),
        aiScored: entry.aiScored === true,
      };
    })
    .filter(Boolean);
}

module.exports = {
  buildCalendarReviewItems,
  buildCalendarCompletedItems,
  buildReviewQuestionMap,
  buildWrongBookFilterOptions,
  buildWrongBookView,
  calendarWeekDateKeys,
  calendarWeekPageDate,
  dateKey,
  decorateWrongQuestion,
  emptyWrongBookFilters,
  filterWrongItems,
  normalizeDirectoryLabel,
  questionBookName,
  questionChapterName,
  questionKnowledgePoint,
  questionSubjectName,
  sanitizeWrongBookFilters,
  wrongIdsByStatus,
};
