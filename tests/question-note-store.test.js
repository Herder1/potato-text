const test = require("node:test");
const assert = require("node:assert/strict");

// DEC-056：刷题页笔记直接落进知识卡卡集——按教材建/复用卡集，目录取用户端目录的
// 章/节/小点，同一道题更新同一张卡，同一节复用同一目录，关闭自动建档则落到"未归类"。
function createHarness() {
  const store = new Map();
  global.wx = {
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ""),
    setStorageSync: (key, value) => store.set(key, value),
  };
  const notesPath = require.resolve("../apps/miniprogram/utils/question-note-store");
  const storePath = require.resolve("../apps/miniprogram/utils/card-box-store");
  delete require.cache[notesPath];
  delete require.cache[storePath];
  return {
    store,
    notes: require(notesPath),
    cards: require(storePath),
  };
}

const chapters = [{
  id: "chapter-1",
  title: "第一章语音",
  parentId: "",
  level: 1,
  sections: [
    { id: "sec-1", title: "第五节音节", parentId: "chapter-1", level: 2 },
    { id: "point-1", title: "三、音节的拼写规则", parentId: "sec-1", level: 3 },
    { id: "deep-1", title: "（一）更细的一层", parentId: "point-1", level: 4 },
  ],
}, {
  id: "chapter-2",
  title: "第二章文字",
  parentId: "",
  level: 1,
  sections: [{ id: "sec-2", title: "第一节汉字的形体", parentId: "chapter-2", level: 2 }],
}];

function question(id, anchorNodeId, extra = {}) {
  return {
    id,
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    stem: "下面哪个音节的拼写是正确的？",
    knowledgePoint: "音节的拼写规则",
    catalogProjection: { anchorNodeIds: [anchorNodeId] },
    ...extra,
  };
}

test("a practice note becomes a note card in the textbook card set", () => {
  const { notes, cards } = createHarness();
  const result = notes.saveQuestionNote({ question: question("q1", "point-1"), content: "y、w 的使用规则。", chapters });

  assert.equal(result.ok, true);
  assert.equal(result.autoArchived, true);
  assert.equal(result.setTitle, "《现代汉语（增订七版）·上册》");
  assert.equal(result.directory, "三、音节的拼写规则");
  assert.equal(result.created, true);

  const set = cards.findSet(result.setId);
  assert.deepEqual(set.sectionOrder, ["第一章语音", "第五节音节", "三、音节的拼写规则"]);
  assert.deepEqual(set.sectionLevels, { "第一章语音": 1, "第五节音节": 2, "三、音节的拼写规则": 3 });
  const [card] = set.cards;
  assert.equal(card.type, "note");
  assert.equal(card.section, "三、音节的拼写规则");
  assert.equal(card.answer, "y、w 的使用规则。");
  assert.equal(card.questionId, "q1");
  assert.equal(card.questionStem, "下面哪个音节的拼写是正确的？");
  // DEC-058：先只归档，不自动进复习。
  assert.equal(card.reviewable, false);
  delete global.wx;
});

test("re-saving the same question updates that card instead of creating another", () => {
  const { notes, cards } = createHarness();
  const first = notes.saveQuestionNote({ question: question("q1", "point-1"), content: "第一版。", chapters });
  const second = notes.saveQuestionNote({ question: question("q1", "point-1"), content: "第二版。", chapters });

  assert.equal(second.created, false);
  assert.equal(second.cardId, first.cardId);
  const set = cards.findSet(first.setId);
  assert.equal(set.cards.length, 1);
  assert.equal(set.cards[0].answer, "第二版。");
  assert.equal(notes.questionNoteContent("q1"), "第二版。");
  delete global.wx;
});

test("questions in the same section reuse one directory chain", () => {
  const { notes, cards } = createHarness();
  const first = notes.saveQuestionNote({ question: question("q1", "point-1"), content: "第一节的题。", chapters });
  notes.saveQuestionNote({ question: question("q2", "sec-1", { knowledgePoint: "音节" }), content: "同一节另一道题。", chapters });

  const set = cards.findSet(first.setId);
  assert.deepEqual(set.sectionOrder, ["第一章语音", "第五节音节", "三、音节的拼写规则"]);
  assert.equal(set.cards.length, 2);
  assert.equal(cards.loadCardSets().length, 5); // 4 个种子卡集 + 新建的教材卡集
  delete global.wx;
});

test("a directory chain never goes deeper than chapter, section and point", () => {
  const { notes, cards } = createHarness();
  const result = notes.saveQuestionNote({ question: question("q1", "deep-1"), content: "锚点在最深一层。", chapters });

  const set = cards.findSet(result.setId);
  assert.deepEqual(set.sectionOrder, ["第一章语音", "第五节音节", "三、音节的拼写规则"]);
  assert.equal(result.directory, "三、音节的拼写规则");
  // 更深的路径只写进来源备注，不建目录。
  assert.equal(set.cards[0].questionCatalogPath, "第一章语音 > 第五节音节 > 三、音节的拼写规则 > （一）更细的一层");
  assert.equal(notes.questionDirectoryTitles(chapters, question("q1", "deep-1")).length, 3);
  delete global.wx;
});

test("a card the user moved by hand keeps its directory when the note is saved again", () => {
  const { notes, cards } = createHarness();
  const first = notes.saveQuestionNote({ question: question("q1", "point-1"), content: "初版。", chapters });
  cards.updateCardInSet(first.setId, first.cardId, { section: "第二章文字" });
  notes.saveQuestionNote({ question: question("q1", "point-1"), content: "再版。", chapters });

  const set = cards.findSet(first.setId);
  assert.equal(set.cards.find((card) => card.id === first.cardId).section, "第二章文字");
  delete global.wx;
});

test("turning auto-archiving off still saves the note, just without a directory tree", () => {
  const { notes, cards } = createHarness();
  assert.equal(notes.noteAutoArchiveEnabled(), true);
  notes.setNoteAutoArchiveEnabled(false);
  assert.equal(notes.noteAutoArchiveEnabled(), false);

  const result = notes.saveQuestionNote({
    question: question("q1", "point-1"),
    content: "关了开关记的。",
    chapters,
    enabled: notes.noteAutoArchiveEnabled(),
  });
  assert.equal(result.autoArchived, false);
  assert.equal(result.setTitle, "我的题目笔记");
  assert.equal(result.directory, "未归类");
  const set = cards.findSet(result.setId);
  assert.deepEqual(set.sectionOrder, ["未归类"]);
  assert.equal(set.cards[0].answer, "关了开关记的。");
  delete global.wx;
});

test("notes without a catalog location land in the unlocated directory", () => {
  const { notes, cards } = createHarness();
  const result = notes.saveQuestionNote({ question: question("q1", "missing-anchor"), content: "不知道属于哪一节。", chapters });
  assert.equal(result.directory, "未归类");
  const set = cards.findSet(result.setId);
  assert.deepEqual(set.sectionOrder, ["未归类"]);
  delete global.wx;
});

test("the note list spans card sets and exposes the source question", () => {
  const { notes, cards } = createHarness();
  notes.saveQuestionNote({ question: question("q1", "point-1"), content: "第一条。", chapters });
  const other = cards.createCardSet("《古代汉语（校订重排本）·第1册》");
  cards.ensureDirectoryPath(other.id, ["第二单元"]);
  cards.addCardToSet(other.id, { id: "manual-note", type: "note", section: "第二单元", question: "手动记的", answer: "手动内容", updatedAt: Date.now() });
  cards.addCardToSet(other.id, { id: "qa-card", type: "qa", section: "第二单元", question: "问答卡", answer: "不计入笔记" });

  const rows = notes.listNoteCards();
  const ids = rows.map((row) => row.id);
  assert.equal(ids.includes("manual-note"), true);
  assert.equal(ids.includes("qa-card"), false);
  // 种子卡集里的笔记卡同样会被列出来。
  assert.equal(ids.includes("al-2"), true);
  const sourceNote = rows.find((row) => row.questionId === "q1");
  assert.equal(sourceNote.questionStem, "下面哪个音节的拼写是正确的？");
  assert.equal(sourceNote.setTitle, "《现代汉语（增订七版）·上册》");
  assert.equal(sourceNote.directory, "三、音节的拼写规则");
  delete global.wx;
});
