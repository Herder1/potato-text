// DEC-056：刷题页记录的笔记直接落进知识卡的卡集。
// 按教材自动创建或复用卡集（如《现代汉语（增订七版）·上册》）；目录取**用户端目录**的
// 章 / 节 / 小点**最末三级**，同一卡集内按标题复用，不重复建档；更深的路径不建目录，
// 只把完整路径写进卡片的来源备注。同一道题重复保存时更新同一张卡。
const { subjects } = require("../data/catalog");
const {
  addCardToSet,
  cardId,
  createCardSet,
  ensureDirectoryPath,
  loadCardSets,
  updateCardInSet,
} = require("./card-box-store");
const { projectionAnchorNodeIds } = require("./catalog-outline");

const AUTO_ARCHIVE_KEY = "shukao_note_auto_archive";
const NOTE_DIRECTORY_DEPTH = 3;
const UNLOCATED_DIRECTORY = "未归类";
const NOTE_SOURCE = "practice_note";

// 用户可能不想要自动结构，给一个开关；默认开启（DEC-056）。
function noteAutoArchiveEnabled(storage = wx) {
  const stored = storage.getStorageSync(AUTO_ARCHIVE_KEY);
  return typeof stored === "boolean" ? stored : true;
}

function setNoteAutoArchiveEnabled(enabled, storage = wx) {
  const value = enabled !== false;
  storage.setStorageSync(AUTO_ARCHIVE_KEY, value);
  return value;
}

function bookOf(question = {}) {
  const subject = subjects.find((item) => item.id === question.subjectId);
  const book = subject && (subject.books || []).find((item) => item.id === question.bookId);
  return { subject, book };
}

function noteCardSetTitle(question = {}) {
  const { book } = bookOf(question);
  if (book && book.title) return `《${book.title}${book.volume ? `·${book.volume}` : ""}》`;
  const title = String(question.bookTitle || "").trim();
  return title ? `《${title}》` : "我的题目笔记";
}

function findNoteCardSet(question = {}) {
  const title = noteCardSetTitle(question);
  return loadCardSets().find((set) => String(set.title || "").trim() === title) || null;
}

function findOrCreateNoteCardSet(question = {}) {
  const existing = findNoteCardSet(question);
  if (existing) return existing;
  return createCardSet(noteCardSetTitle(question), "刷题时记下的笔记会自动归档到这里", "我的卡集");
}

// 自动建档关闭时的落点：内容照旧保存，只是不按教材建卡集、不建目录，等用户自己整理。
function findOrCreateLooseNoteCardSet() {
  const title = "我的题目笔记";
  const existing = loadCardSets().find((set) => String(set.title || "").trim() === title);
  if (existing) return existing;
  return createCardSet(title, "自动建档关闭时，刷题笔记先收在这里，可自行整理", "我的卡集");
}

// 题目锚点所在节点沿 parentId 上溯到章，取**前三级**（章 / 节 / 小点）作为目录。
// 这里必须是"前三级"而不是"最末三级"：目录比三级更深时（章 > 节 > 小点 > 更细），
// 取末三级会把目录树的根落到"节"上，同一节里的题会因为锚点深浅不同而长出不同的根，
// "同一节复用同一目录"就失效了。更深的那几级只写进卡片来源备注，不建目录。
function questionDirectoryTitles(chapters = [], question = {}) {
  const anchors = projectionAnchorNodeIds(question);
  if (!anchors.length) return [];
  const byId = new Map();
  (Array.isArray(chapters) ? chapters : []).forEach((chapter) => {
    byId.set(String(chapter.id), chapter);
    (chapter.sections || []).forEach((section) => byId.set(String(section.id), section));
  });
  const start = anchors.map((anchorId) => byId.get(String(anchorId))).find(Boolean);
  if (!start) return [];
  const titles = [];
  const visited = new Set();
  let current = start;
  while (current && !visited.has(String(current.id))) {
    visited.add(String(current.id));
    const title = String(current.title || "").trim();
    if (title) titles.unshift(title);
    current = current.parentId ? byId.get(String(current.parentId)) : null;
  }
  return titles.slice(0, NOTE_DIRECTORY_DEPTH);
}

// 卡片来源备注：完整目录路径（含被截掉的更深层级），供卡片内容页追溯。
function questionCatalogPathText(chapters = [], question = {}) {
  const anchors = projectionAnchorNodeIds(question);
  if (!anchors.length) return "";
  const byId = new Map();
  (Array.isArray(chapters) ? chapters : []).forEach((chapter) => {
    byId.set(String(chapter.id), chapter);
    (chapter.sections || []).forEach((section) => byId.set(String(section.id), section));
  });
  const start = anchors.map((anchorId) => byId.get(String(anchorId))).find(Boolean);
  if (!start) return "";
  const titles = [];
  const visited = new Set();
  let current = start;
  while (current && !visited.has(String(current.id))) {
    visited.add(String(current.id));
    const title = String(current.title || "").trim();
    if (title) titles.unshift(title);
    current = current.parentId ? byId.get(String(current.parentId)) : null;
  }
  return titles.join(" > ");
}

function noteCardTitle(question = {}) {
  const point = String(question.knowledgePoint || question.primaryKnowledgePoint || "").trim();
  if (point) return point;
  const stem = String(question.stem || "").trim();
  return stem.length > 24 ? `${stem.slice(0, 24)}…` : stem;
}

function noteCardsOfQuestion(questionId, sets = loadCardSets()) {
  const id = String(questionId || "");
  if (!id) return [];
  const found = [];
  (Array.isArray(sets) ? sets : []).forEach((set) => {
    (set.cards || []).forEach((card) => {
      if (String(card.questionId || "") === id) found.push({ set, card });
    });
  });
  return found;
}

function latestQuestionNote(questionId) {
  return noteCardsOfQuestion(questionId)
    .sort((left, right) => Number(right.card.updatedAt || 0) - Number(left.card.updatedAt || 0))[0] || null;
}

function questionNoteContent(questionId) {
  const latest = latestQuestionNote(questionId);
  return latest ? String(latest.card.answer || "") : "";
}

// 界面提示用：说明这条笔记落到了哪个卡集、哪个目录。
function questionNoteLocation(questionId) {
  const latest = latestQuestionNote(questionId);
  if (!latest) return null;
  return {
    setId: latest.set.id,
    setTitle: String(latest.set.title || ""),
    directory: String(latest.card.section || ""),
    cardId: latest.card.id,
    questionId: String(latest.card.questionId || ""),
    questionStem: String(latest.card.questionStem || ""),
  };
}

function saveQuestionNote({ question = {}, content = "", chapters = [], enabled = true } = {}) {
  const text = String(content || "").trim();
  if (!text) return { ok: false, reason: "empty" };
  const questionId = String(question.id || "");
  if (!questionId) return { ok: false, reason: "question_required" };
  const autoArchived = enabled !== false;
  const existing = latestQuestionNote(questionId);
  const set = existing
    ? existing.set
    : (autoArchived ? findOrCreateNoteCardSet(question) : findOrCreateLooseNoteCardSet());
  const titles = autoArchived ? questionDirectoryTitles(chapters, question) : [];
  const directory = ensureDirectoryPath(set.id, titles.length ? titles : [UNLOCATED_DIRECTORY]) || UNLOCATED_DIRECTORY;
  const now = Date.now();
  const patch = {
    type: "note",
    question: noteCardTitle(question),
    answer: text,
    questionId,
    questionStem: String(question.stem || "").trim(),
    questionCatalogPath: questionCatalogPathText(chapters, question),
    // 卡片内容页的「来源题目」用它按题目 id 回查整道题、并跳到对应教材刷题。
    bookId: String(question.bookId || ""),
    subjectId: String(question.subjectId || ""),
    source: NOTE_SOURCE,
    updatedAt: now,
  };
  // 只有新建时才写目录；已存在的卡不动它的目录，尊重用户手工整理过的位置。
  const card = existing
    ? updateCardInSet(set.id, existing.card.id, patch)
    : addCardToSet(set.id, {
      id: cardId(),
      section: directory,
      answerHtml: "",
      answerDelta: { ops: [] },
      answerSegments: [],
      answerImages: [],
      mnemonic: "",
      associations: [],
      state: "new",
      // DEC-058：先只归档，不自动进入复习队列；将来复习接线时读这个标记。
      reviewable: false,
      createdAt: now,
      ...patch,
    });
  if (!card) return { ok: false, reason: "write_failed" };
  return {
    ok: true,
    autoArchived,
    cardId: card.id,
    setId: set.id,
    setTitle: String(set.title || ""),
    directory: String(card.section || directory),
    created: !existing,
  };
}

// 知识页/笔记库用的只读视图：所有笔记卡（跨卡集），按更新时间倒序。
function listNoteCards() {
  const rows = [];
  loadCardSets().forEach((set) => {
    (set.cards || []).forEach((card) => {
      if (String(card.type || "") !== "note") return;
      rows.push({
        setId: set.id,
        setTitle: String(set.title || ""),
        folder: String(set.folder || ""),
        id: card.id,
        title: String(card.question || ""),
        content: String(card.answer || ""),
        directory: String(card.section || ""),
        questionId: String(card.questionId || ""),
        questionStem: String(card.questionStem || ""),
        questionCatalogPath: String(card.questionCatalogPath || ""),
        reviewable: card.reviewable === true,
        updatedAt: Number(card.updatedAt || card.createdAt || 0),
      });
    });
  });
  return rows.sort((left, right) => right.updatedAt - left.updatedAt);
}

module.exports = {
  AUTO_ARCHIVE_KEY,
  UNLOCATED_DIRECTORY,
  findNoteCardSet,
  findOrCreateNoteCardSet,
  listNoteCards,
  noteAutoArchiveEnabled,
  noteCardSetTitle,
  noteCardsOfQuestion,
  questionCatalogPathText,
  questionDirectoryTitles,
  questionNoteContent,
  questionNoteLocation,
  saveQuestionNote,
  setNoteAutoArchiveEnabled,
};
