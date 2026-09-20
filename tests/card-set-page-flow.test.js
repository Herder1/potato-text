const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STORAGE_KEY = "shukao_card_box_sets";

function makeSet() {
  return {
    id: "set-1",
    title: "测试卡集",
    author: "我的整理",
    subject: "专业课",
    progress: 0,
    cards: [
      { id: "a-1", section: "第一章", question: "问题一", answer: "答案一", state: "new" },
      { id: "a-2", section: "第一章", question: "问题二", answer: "答案二", state: "new" },
      { id: "b-1", section: "第二章", question: "问题三", answer: "答案三", state: "new" },
    ],
  };
}

function createPage(initialSet = makeSet()) {
  let definition;
  let actionSheet;
  let modal;
  let navigation;
  let toast;
  const store = new Map([[STORAGE_KEY, [structuredClone(initialSet)]]]);
  global.Page = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    showToast: (options) => { toast = options; },
    showActionSheet: (options) => { actionSheet = options; },
    showModal: (options) => { modal = options; },
    navigateTo: (options) => { navigation = options; },
    showShareMenu() {},
  };
  const modulePath = require.resolve("../apps/miniprogram/pages/card-set/card-set.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({ id: initialSet.id });
  page.onShow();
  return {
    page,
    storedSet: () => store.get(STORAGE_KEY)[0],
    actionSheet: () => actionSheet,
    modal: () => modal,
    navigation: () => navigation,
    toast: () => toast,
  };
}

test("card and directory actions share one exclusive toolbar state", () => {
  const { page } = createPage();
  page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(page.data.actionMode, "cards");
  assert.deepEqual(page.data.selectedIds, ["a-1"]);

  page.openDirectoryActions({ currentTarget: { dataset: { title: "第一章" } } });
  assert.equal(page.data.actionMode, "directory");
  assert.equal(page.data.activeDirectory, "第一章");
  assert.deepEqual(page.data.selectedIds, []);

  page.startSelect({ currentTarget: { dataset: { id: "b-1" } } });
  assert.equal(page.data.actionMode, "cards");
  assert.equal(page.data.activeDirectory, "");
});

test("card toolbar moves and pins selected cards", () => {
  const flow = createPage();
  flow.page.startSelect({ currentTarget: { dataset: { id: "a-2" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "move" } } });
  assert.deepEqual(flow.page.data.menuOptions.map((option) => option.label), ["第一章", "第二章"]);
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "第二章" } } });
  assert.equal(flow.storedSet().cards.find((card) => card.id === "a-2").section, "第二章");

  flow.page.startSelect({ currentTarget: { dataset: { id: "a-2" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "pin" } } });
  const secondChapterIds = flow.storedSet().cards.filter((card) => card.section === "第二章").map((card) => card.id);
  assert.deepEqual(secondChapterIds, ["a-2", "b-1"]);
});

test("card toolbar edits only one selected card", () => {
  const flow = createPage();
  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(flow.page.data.canEditSelected, true);
  flow.page.selectionAction({ currentTarget: { dataset: { action: "edit" } } });
  assert.equal(flow.navigation().url, "/pages/card-editor/card-editor?setId=set-1&cardId=a-1");
  assert.equal(flow.page.data.actionMode, "");
  assert.deepEqual(flow.page.data.selectedIds, []);

  const multi = createPage();
  multi.page.applyCardSelection(["a-1", "a-2"]);
  assert.equal(multi.page.data.canEditSelected, false);
  multi.page.selectionAction({ currentTarget: { dataset: { action: "edit" } } });
  assert.equal(multi.navigation(), undefined);
  assert.equal(multi.page.data.actionMode, "cards");
});

test("card toolbar inserts a blank card before or after a single selected card", () => {
  const beforeFlow = createPage();
  beforeFlow.page.startSelect({ currentTarget: { dataset: { id: "a-2" } } });
  beforeFlow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });
  assert.deepEqual(beforeFlow.page.data.menuOptions.map((option) => option.label), [
    "在前方添加卡片",
    "在后方添加卡片",
    "在前方添加目录",
    "在后方添加目录",
  ]);
  beforeFlow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "card-before" } } });

  const beforeCards = beforeFlow.storedSet().cards;
  const beforeBlank = beforeCards.find((card) => !card.question && !card.answer);
  assert.deepEqual(beforeCards.map((card) => card.id), ["a-1", beforeBlank.id, "a-2", "b-1"]);
  assert.equal(beforeBlank.section, "第一章");
  assert.equal(beforeBlank.type, "qa");
  assert.equal(beforeFlow.page.data.actionMode, "");
  assert.deepEqual(beforeFlow.page.data.selectedIds, []);
  assert.equal(beforeFlow.page.data.set.count, 4);
  assert.equal(beforeFlow.navigation(), undefined, "insertion remains visible in the card set until the blank card is opened");

  beforeFlow.page._longPressAt = 0;
  beforeFlow.page.openCard({ currentTarget: { dataset: { id: beforeBlank.id } } });
  assert.equal(
    beforeFlow.navigation().url,
    `/pages/card-editor/card-editor?setId=set-1&cardId=${beforeBlank.id}`,
  );

  const afterFlow = createPage();
  afterFlow.page.startSelect({ currentTarget: { dataset: { id: "b-1" } } });
  afterFlow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });
  afterFlow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "card-after" } } });
  const afterCards = afterFlow.storedSet().cards;
  const afterBlank = afterCards.find((card) => !card.question && !card.answer);
  assert.deepEqual(afterCards.map((card) => card.id), ["a-1", "a-2", "b-1", afterBlank.id]);
  assert.equal(afterBlank.section, "第二章");
  assert.deepEqual(
    afterFlow.page.data.sections.find((section) => section.title === "第二章").cards.map((card) => card.id),
    ["b-1", afterBlank.id],
  );
});

test("card toolbar inserts empty same-level directories before or after the current directory subtree", () => {
  const hierarchicalSet = {
    ...makeSet(),
    cards: [
      { id: "level-1", section: "一级甲", question: "一级问题", answer: "一级答案", state: "new" },
      { id: "level-2", section: "二级甲", question: "二级问题", answer: "二级答案", state: "new" },
      { id: "level-3", section: "三级甲", question: "三级问题", answer: "三级答案", state: "new" },
      { id: "level-2-next", section: "二级乙", question: "另一问题", answer: "另一答案", state: "new" },
      { id: "level-1-next", section: "一级乙", question: "末尾问题", answer: "末尾答案", state: "new" },
    ],
    sectionOrder: ["一级甲", "二级甲", "三级甲", "二级乙", "一级乙"],
    sectionLevels: { 一级甲: 1, 二级甲: 2, 三级甲: 3, 二级乙: 2, 一级乙: 1 },
  };

  const beforeFlow = createPage(hierarchicalSet);
  beforeFlow.page.startSelect({ currentTarget: { dataset: { id: "level-1" } } });
  beforeFlow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });
  beforeFlow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "directory-before" } } });
  // DEC-060：不再弹窗，目录先以占位名落到目标位置，再在目录行里改名。
  const beforePlaceholder = beforeFlow.page.data.directoryInlineEdit;
  assert.equal(Boolean(beforePlaceholder), true);
  assert.equal(beforeFlow.page.data.actionMode, "");
  assert.deepEqual(beforeFlow.storedSet().sectionOrder,
    [beforePlaceholder, "一级甲", "二级甲", "三级甲", "二级乙", "一级乙"]);
  assert.equal(beforeFlow.storedSet().sectionLevels[beforePlaceholder], 1);
  beforeFlow.page.commitDirectoryInline({ detail: { value: "一级前置" } });
  assert.deepEqual(beforeFlow.storedSet().sectionOrder, ["一级前置", "一级甲", "二级甲", "三级甲", "二级乙", "一级乙"]);
  assert.equal(beforeFlow.storedSet().sectionLevels["一级前置"], 1);
  assert.equal(beforeFlow.storedSet().cards.length, 5);
  assert.equal(beforeFlow.page.data.sections.find((section) => section.title === "一级前置").cards.length, 0);
  assert.equal(beforeFlow.page.data.directoryInlineEdit, "");

  const afterFlow = createPage(hierarchicalSet);
  afterFlow.page.startSelect({ currentTarget: { dataset: { id: "level-2" } } });
  afterFlow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });
  afterFlow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "directory-after" } } });
  const afterPlaceholder = afterFlow.page.data.directoryInlineEdit;
  assert.equal(Boolean(afterPlaceholder), true);
  assert.deepEqual(afterFlow.storedSet().sectionOrder,
    ["一级甲", "二级甲", "三级甲", afterPlaceholder, "二级乙", "一级乙"]);
  afterFlow.page.commitDirectoryInline({ detail: { value: "二级后置" } });
  assert.deepEqual(afterFlow.storedSet().sectionOrder, ["一级甲", "二级甲", "三级甲", "二级后置", "二级乙", "一级乙"]);
  assert.equal(afterFlow.storedSet().sectionLevels["二级后置"], 2);
  assert.equal(afterFlow.storedSet().cards.length, 5);
  assert.equal(afterFlow.page.data.set.count, 5);
});

test("inline directory creation keeps the placeholder when the name is left empty or duplicated", () => {
  const flow = createPage();
  const originalOrder = [...flow.storedSet().sectionOrder];
  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "directory-before" } } });
  const placeholder = flow.page.data.directoryInlineEdit;
  assert.equal(Boolean(placeholder), true);
  assert.deepEqual(flow.storedSet().sectionOrder, [placeholder, ...originalOrder]);

  // 留空提交：保留空白目录，等用户之后再改名。
  flow.page.commitDirectoryInline({ detail: { value: "   " } });
  assert.equal(flow.page.data.directoryInlineEdit, "");
  assert.deepEqual(flow.storedSet().sectionOrder, [placeholder, ...originalOrder]);

  // 重名：提示并保留原来的占位目录，不会写出第二个同名目录。
  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "directory-before" } } });
  const secondPlaceholder = flow.page.data.directoryInlineEdit;
  assert.notEqual(secondPlaceholder, placeholder);
  flow.page.commitDirectoryInline({ detail: { value: "第一章" } });
  const titles = flow.storedSet().sectionOrder;
  assert.equal(titles.filter((title) => title === "第一章").length, 1);
  assert.equal(titles.includes(secondPlaceholder), true);
});

test("relative add is unavailable for multiple selected cards", () => {
  const flow = createPage();
  flow.page.applyCardSelection(["a-1", "a-2"]);

  flow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });

  assert.equal(flow.page.data.menuOpen, false);
  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), ["a-1", "a-2", "b-1"]);
  assert.equal(flow.page.data.actionMode, "cards");
});

test("card edit action is only rendered for a single selection", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  assert.match(markup, /wx:if="\{\{canEditSelected\}\}" data-action="edit" bindtap="selectionAction"/);
  assert.match(markup, /data-action="edit"[\s\S]*pack-edit\.svg[\s\S]*<label>编辑<\/label>/);
  assert.match(markup, /wx:if="\{\{canEditSelected\}\}" data-action="add" bindtap="selectionAction"/);
  assert.match(markup, /data-action="add"[\s\S]*pack-plus\.svg[\s\S]*<label>添加<\/label>/);
});

test("practice skips blank and partial cards and opens the first complete card", () => {
  const flow = createPage({
    ...makeSet(),
    cards: [
      { id: "blank", section: "第一章", type: "qa", question: "", answer: "", state: "new" },
      { id: "question-only", section: "第一章", type: "qa", question: "只有问题", answer: "", state: "new" },
      { id: "answer-only", section: "第一章", type: "qa", question: "", answer: "只有答案", state: "new" },
      { id: "ready", section: "第一章", type: "qa", question: "有内容", answer: "可练习", state: "new" },
    ],
  });

  flow.page.practice();

  assert.equal(flow.navigation().url, "/pages/knowledge-card/knowledge-card?setId=set-1&cardId=ready");
});

test("partial cards reopen in the editor and an all-blank set asks the user to edit", () => {
  const partialFlow = createPage({
    ...makeSet(),
    cards: [{ id: "partial", section: "第一章", question: "只有问题", answer: "", state: "new" }],
  });
  partialFlow.page._longPressAt = 0;
  partialFlow.page.openCard({ currentTarget: { dataset: { id: "partial" } } });
  assert.equal(partialFlow.navigation().url, "/pages/card-editor/card-editor?setId=set-1&cardId=partial");

  const blankFlow = createPage({
    ...makeSet(),
    cards: [{ id: "blank", section: "第一章", question: "", answer: "", state: "new" }],
  });
  blankFlow.page.practice();
  assert.equal(blankFlow.navigation(), undefined);
  assert.equal(blankFlow.toast().title, "先编辑一张卡片");
});

test("directory title counts include only the following deeper-level subtree", () => {
  const sectionOrder = ["一级甲", "二级甲", "三级甲", "三级乙", "二级乙", "三级丙", "一级乙", "二级丙"];
  const sectionLevels = {
    一级甲: 1,
    二级甲: 2,
    三级甲: 3,
    三级乙: 3,
    二级乙: 2,
    三级丙: 3,
    一级乙: 1,
    二级丙: 2,
  };
  const cardCounts = {
    一级甲: 1,
    二级甲: 0,
    三级甲: 1,
    三级乙: 2,
    二级乙: 1,
    三级丙: 1,
    一级乙: 1,
    二级丙: 1,
  };
  const cards = sectionOrder.flatMap((title) => Array.from({ length: cardCounts[title] }, (_, index) => ({
    id: `${title}-${index}`,
    section: title,
    question: `${title}问题${index}`,
    answer: `${title}答案${index}`,
    state: "new",
  })));
  const flow = createPage({ ...makeSet(), cards, sectionOrder, sectionLevels });

  assert.deepEqual(flow.page.data.sections.map((section) => ({
    title: section.title,
    direct: section.cards.length,
    displayed: section.displayCount,
  })), [
    { title: "一级甲", direct: 1, displayed: 6 },
    { title: "二级甲", direct: 0, displayed: 3 },
    { title: "三级甲", direct: 1, displayed: 1 },
    { title: "三级乙", direct: 2, displayed: 2 },
    { title: "二级乙", direct: 1, displayed: 2 },
    { title: "三级丙", direct: 1, displayed: 1 },
    { title: "一级乙", direct: 1, displayed: 2 },
    { title: "二级丙", direct: 1, displayed: 1 },
  ]);
  assert.equal(flow.page.data.set.count, 8, "the set total counts every real card exactly once");
  assert.equal(flow.page.data.sections.reduce((total, section) => total + section.cards.length, 0), 8);
});

test("directory title markup renders the subtree count without duplicating card grids", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  assert.match(markup, /\{\{item\.displayCount\}\} 张/);
  assert.match(markup, /wx:for="\{\{item\.section\.cards\}\}"/);
  assert.doesNotMatch(markup, /\{\{item\.cards\.length\}\} 张/);
});

test("directory toolbar renames, levels, moves and deletes directories", () => {
  const flow = createPage();
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第二章" } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "edit" } } });
  assert.equal(flow.page.data.directoryInlineEdit, "第二章", "rename happens inline in the directory row");
  assert.equal(flow.page.data.directoryInlineValue, "第二章", "the inline input is prefilled with the current name");
  assert.equal(flow.page.data.actionMode, "");
  flow.page.commitDirectoryInline({ currentTarget: { dataset: { title: "第二章" } }, detail: { value: "重点章节" } });
  assert.equal(flow.storedSet().cards.find((card) => card.id === "b-1").section, "重点章节");

  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "重点章节" } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "level" } } });
  assert.deepEqual(flow.page.data.menuOptions.map((option) => option.label), ["一级标题", "二级标题", "三级标题"]);
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "2" } } });
  assert.equal(flow.storedSet().sectionLevels["重点章节"], 2);

  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "重点章节" } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "move" } } });
  assert.deepEqual(flow.page.data.menuOptions.map((option) => option.label), ["移到顶部", "上移一位", "下移一位", "移到底部"]);
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "top" } } });
  assert.equal(flow.storedSet().sectionOrder[0], "重点章节");

  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "重点章节" } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "delete" } } });
  flow.modal().success({ confirm: true });
  assert.equal(flow.storedSet().cards.some((card) => card.section === "重点章节"), false);
});

test("creating a directory persists metadata without creating a placeholder card", () => {
  const flow = createPage();
  const originalCardIds = flow.storedSet().cards.map((card) => card.id);

  flow.page.createDirectoryInline();
  const placeholder = flow.page.data.directoryInlineEdit;
  assert.equal(flow.page.data.directoryInlineValue, "", "a brand new directory starts with an empty inline input");
  flow.page.commitDirectoryInline({ currentTarget: { dataset: { title: placeholder } }, detail: { value: "空目录" } });

  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), originalCardIds);
  assert.equal(flow.storedSet().cards.some((card) => card.isDirectoryPlaceholder), false);
  assert.deepEqual(flow.storedSet().sectionOrder, ["第一章", "第二章", "空目录"]);
  assert.deepEqual(
    flow.page.data.sections.map((section) => ({ title: section.title, count: section.cards.length })),
    [
      { title: "第一章", count: 2 },
      { title: "第二章", count: 1 },
      { title: "空目录", count: 0 },
    ],
  );
  assert.equal(flow.page.data.set.count, 3, "a directory is never included in the card count");
});

test("an empty directory in persisted sectionOrder remains visible after reload", () => {
  const initial = {
    ...makeSet(),
    sectionOrder: ["第一章", "空目录", "第二章"],
    sectionLevels: { 第一章: 1, 空目录: 2, 第二章: 1 },
  };
  const flow = createPage(initial);

  assert.deepEqual(flow.page.data.sections.map((section) => section.title), ["第一章", "空目录", "第二章"]);
  const empty = flow.page.data.sections.find((section) => section.title === "空目录");
  assert.ok(empty);
  assert.equal(empty.cards.length, 0);
  assert.equal(empty.level, 2);

  flow.page.refresh();
  assert.deepEqual(flow.page.data.sections.map((section) => section.title), ["第一章", "空目录", "第二章"]);
  assert.deepEqual(flow.storedSet().sectionOrder, ["第一章", "空目录", "第二章"]);
});

test("deleting the final card in a directory does not delete the directory", () => {
  const initial = {
    ...makeSet(),
    cards: [{ id: "only-card", section: "待补充", question: "唯一问题", answer: "唯一答案", state: "new" }],
    sectionOrder: ["待补充"],
    sectionLevels: { 待补充: 2 },
  };
  const flow = createPage(initial);

  flow.page.startSelect({ currentTarget: { dataset: { id: "only-card" } } });
  flow.page.deleteSelected();
  flow.modal().success({ confirm: true });

  assert.deepEqual(flow.storedSet().cards, []);
  assert.deepEqual(flow.storedSet().sectionOrder, ["待补充"]);
  assert.equal(flow.storedSet().sectionLevels["待补充"], 2);
  assert.deepEqual(
    flow.page.data.sections.map((section) => ({ title: section.title, count: section.cards.length })),
    [{ title: "待补充", count: 0 }],
  );
});

test("legacy sets migrate directory metadata from existing card sections", () => {
  const legacy = makeSet();
  delete legacy.sectionOrder;
  delete legacy.sectionLevels;
  const flow = createPage(legacy);

  assert.deepEqual(flow.page.data.sections.map((section) => section.title), ["第一章", "第二章"]);
  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), ["a-1", "a-2", "b-1"]);
  assert.equal(flow.storedSet().cards.some((card) => card.isDirectoryPlaceholder), false);
  assert.deepEqual(flow.storedSet().sectionOrder, ["第一章", "第二章"]);
  assert.deepEqual(flow.storedSet().sectionLevels, { 第一章: 1, 第二章: 1 });
});

test("legacy directory placeholder cards migrate into persistent empty directories", () => {
  const legacy = {
    ...makeSet(),
    cards: [
      { id: "real-card", section: "第一章", question: "真实问题", answer: "真实答案", state: "new" },
      {
        id: "directory-old-placeholder",
        type: "topic",
        section: "旧空目录",
        question: "新目录",
        answer: "在这里添加第一张卡片",
        state: "new",
        isDirectoryPlaceholder: true,
      },
    ],
  };
  delete legacy.sectionOrder;
  delete legacy.sectionLevels;
  const flow = createPage(legacy);

  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), ["real-card"]);
  assert.equal(flow.storedSet().cards.some((card) => card.isDirectoryPlaceholder), false);
  assert.deepEqual(flow.storedSet().sectionOrder, ["第一章", "旧空目录"]);
  assert.deepEqual(flow.storedSet().sectionLevels, { 第一章: 1, 旧空目录: 1 });
  assert.deepEqual(
    flow.page.data.sections.map((section) => ({ title: section.title, count: section.cards.length })),
    [
      { title: "第一章", count: 1 },
      { title: "旧空目录", count: 0 },
    ],
  );
  assert.equal(flow.page.data.set.count, 1);
});

test("a previously edited placeholder is preserved as a real card", () => {
  const legacy = {
    ...makeSet(),
    cards: [{
      id: "directory-edited-placeholder",
      type: "topic",
      section: "  用户目录  ",
      question: "用户改过的问题",
      answer: "在这里添加第一张卡片",
      state: "new",
      isDirectoryPlaceholder: true,
    }],
  };
  delete legacy.sectionOrder;
  delete legacy.sectionLevels;

  const flow = createPage(legacy);
  const saved = flow.storedSet();

  assert.equal(saved.cards.length, 1);
  assert.equal(saved.cards[0].id, "directory-edited-placeholder");
  assert.equal(saved.cards[0].question, "用户改过的问题");
  assert.equal(saved.cards[0].section, "用户目录");
  assert.equal(Object.prototype.hasOwnProperty.call(saved.cards[0], "isDirectoryPlaceholder"), false);
  assert.deepEqual(saved.sectionOrder, ["用户目录"]);
  assert.deepEqual(flow.page.data.sections.map((section) => ({ title: section.title, count: section.cards.length })), [
    { title: "用户目录", count: 1 },
  ]);
});

test("moving the final card out keeps its source directory", () => {
  const initial = {
    ...makeSet(),
    cards: [
      { id: "source-only", section: "来源目录", question: "唯一问题", answer: "唯一答案", state: "new" },
      { id: "target-card", section: "目标目录", question: "目标问题", answer: "目标答案", state: "new" },
    ],
    sectionOrder: ["来源目录", "目标目录"],
    sectionLevels: { 来源目录: 2, 目标目录: 1 },
  };
  const flow = createPage(initial);

  flow.page.startSelect({ currentTarget: { dataset: { id: "source-only" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "move" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "目标目录" } } });

  assert.deepEqual(flow.storedSet().sectionOrder, ["来源目录", "目标目录"]);
  assert.equal(flow.storedSet().sectionLevels["来源目录"], 2);
  assert.equal(flow.storedSet().cards.find((card) => card.id === "source-only").section, "目标目录");
  assert.deepEqual(flow.page.data.sections.map((section) => ({ title: section.title, count: section.cards.length })), [
    { title: "来源目录", count: 0 },
    { title: "目标目录", count: 2 },
  ]);
});

test("card set editor uses a back icon and places save below the form", () => {
  const editorDir = path.join(__dirname, "../apps/miniprogram/pages/card-set-editor");
  const markup = fs.readFileSync(path.join(editorDir, "card-set-editor.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(editorDir, "card-set-editor.wxss"), "utf8");

  assert.match(markup, /class="nav-back"[\s\S]*arrow-left\.svg/);
  assert.doesNotMatch(markup, /class="nav-cancel"|class="nav-save/);
  assert.match(markup, /class="field field-description"[\s\S]*class="editor-actions"[\s\S]*class="footer-save/);
  assert.doesNotMatch(styles, /\.editor-actions\s*\{[^}]*position:\s*fixed/s);
  assert.match(styles, /\.editor-body\s*\{[^}]*safe-area-inset-bottom/s);
  assert.match(
    markup,
    /class="field field-author"[\s\S]{0,240}data-field="author"[\s\S]{0,240}placeholder="\{\{authorPlaceholder\}\}"/,
    "the editor exposes an optional author field with a placeholder",
  );
  assert.match(markup, /<label>作者<text class="label-optional">选填<\/text><\/label>/);
  assert.match(styles, /\.label-optional\s*\{/);
});

test("the card set editor edits the author and falls back to the default", () => {
  const editorModule = require.resolve("../apps/miniprogram/pages/card-set-editor/card-set-editor.js");
  const storeKey = "shukao_card_box_sets";
  const stored = new Map([[storeKey, [{
    id: "set-1",
    title: "旧标题",
    description: "旧简介",
    author: "黄伯荣、廖序东",
    cards: [],
  }]]]);
  let definition;
  let navigatedBack = 0;
  global.Page = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => (stored.has(key) ? stored.get(key) : ""),
    setStorageSync: (key, value) => stored.set(key, value),
    showToast() {},
    navigateBack() { navigatedBack += 1; },
  };
  delete require.cache[editorModule];
  require(editorModule);
  const editor = { ...definition, data: structuredClone(definition.data) };
  editor.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };

  editor.onLoad({ id: "set-1" });
  assert.equal(editor.data.author, "黄伯荣、廖序东", "editing prefills the stored author");
  assert.equal(editor.data.authorPlaceholder, "我的整理");

  editor.setData({ title: "新标题", description: "新简介", author: "  王一  " });
  editor.save();
  assert.equal(stored.get(storeKey)[0].author, "王一");
  assert.equal(navigatedBack, 1);

  const createEditor = { ...definition, data: structuredClone(definition.data) };
  createEditor.setData = editor.setData;
  createEditor.onLoad({ folder: "我的卡集" });
  assert.equal(createEditor.data.author, "我的整理", "a new set starts from the default author");
  createEditor.setData({ title: "新卡集", author: "   " });
  createEditor.save();
  const created = stored.get(storeKey).find((set) => set.title === "新卡集");
  assert.ok(created);
  assert.equal(created.author, "我的整理", "a blank author falls back to the default");

  delete require.cache[editorModule];
  delete global.Page;
  delete global.wx;
});

test("directory heading levels form a compact outline group while card sections keep breathing room", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(markup, /section-level-block-\{\{item\.section\.level\}\}/);
  assert.match(markup, /item\.section\.cards\.length \? 'section-with-cards' : 'section-empty'/);
  assert.match(styles, /\.section-level-block-1\{margin-top:24rpx\}/);
  assert.match(styles, /\.section-level-block-2\{margin-top:14rpx\}/);
  assert.match(styles, /\.section-level-block-3\{margin-top:12rpx\}/);
  assert.match(styles, /\.section-empty\+\.section-level-block-2\{margin-top:8rpx\}/);
  assert.match(styles, /\.section-empty\+\.section-level-block-3\{margin-top:6rpx\}/);
  assert.match(styles, /\.section-title\{padding-bottom:0;line-height:1\.35\}/);
  assert.match(styles, /\.section-with-cards \.section-title\{padding-bottom:12rpx\}/);
  assert.match(styles, /\.section-level-2,\.section-level-3\{margin-left:0\}/);
  assert.match(styles, /\.section-level-2\{[^}]*font-size:23rpx[^}]*font-weight:700/);
  assert.match(styles, /\.section-level-3\{[^}]*font-size:21rpx[^}]*font-weight:650/);
  assert.match(styles, /\.section-title\.section-title-active\{padding:14rpx 16rpx\}/);
  // DEC-060：新建目录就地输入，行内输入框沿用目录标题的字号与层级缩进。
  assert.match(styles, /\.section-title-input\{[^}]*font-size:25rpx[^}]*\}/);
  assert.match(markup, /class="section-title-input section-level-\{\{item\.section\.level\}\}"/);
});

const catalogSet = {
  ...makeSet(),
  cards: [
    { id: "first-1", section: "一级甲", question: "一级问题", answer: "一级答案", state: "new" },
    { id: "third-1", section: "三级甲", question: "三级问题甲", answer: "三级答案甲", state: "new" },
    { id: "third-2", section: "三级乙", question: "三级问题乙", answer: "三级答案乙", state: "new" },
    { id: "third-3", section: "三级乙", question: "", answer: "", state: "new" },
    { id: "second-2", section: "二级乙", question: "另一问题", answer: "另一答案", state: "new" },
    { id: "last-1", section: "一级乙", question: "末尾问题", answer: "末尾答案", state: "new" },
  ],
  sectionOrder: ["一级甲", "二级甲", "三级甲", "三级乙", "二级乙", "一级乙"],
  sectionLevels: { 一级甲: 1, 二级甲: 2, 三级甲: 3, 三级乙: 3, 二级乙: 2, 一级乙: 1 },
};

test("the card set catalog opens as a left drawer with the full outline expanded", () => {
  const flow = createPage(catalogSet);

  flow.page.openCatalog();

  assert.equal(flow.page.data.catalogOpen, true);
  assert.equal(flow.page.data.catalogView, "directory");
  assert.equal(flow.page.data.catalogDirectoryCount, 6);
  assert.equal(flow.page.data.catalogExpandedAll, true);
  assert.deepEqual(flow.page.data.catalogRows.map((row) => ({
    title: row.title,
    depth: row.depth,
    hasChildren: row.hasChildren,
    expanded: row.expanded,
    totalCount: row.totalCount,
  })), [
    { title: "一级甲", depth: 0, hasChildren: true, expanded: true, totalCount: 5 },
    { title: "二级甲", depth: 1, hasChildren: true, expanded: true, totalCount: 3 },
    { title: "三级甲", depth: 2, hasChildren: false, expanded: false, totalCount: 1 },
    { title: "三级乙", depth: 2, hasChildren: false, expanded: false, totalCount: 2 },
    { title: "二级乙", depth: 1, hasChildren: false, expanded: false, totalCount: 1 },
    { title: "一级乙", depth: 0, hasChildren: false, expanded: false, totalCount: 1 },
  ]);

  flow.page.closeCatalog();
  assert.equal(flow.page.data.catalogOpen, false);
});

test("catalog level one collapses level two and level two collapses level three", () => {
  const flow = createPage(catalogSet);
  flow.page.openCatalog();

  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "一级甲" } } });
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), ["一级甲", "一级乙"]);
  assert.equal(flow.page.data.catalogRows[0].expanded, false);
  assert.equal(flow.page.data.catalogExpandedAll, false);

  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "一级甲" } } });
  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "二级甲" } } });
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), ["一级甲", "二级甲", "二级乙", "一级乙"]);

  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "二级甲" } } });
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), [
    "一级甲",
    "二级甲",
    "三级甲",
    "三级乙",
    "二级乙",
    "一级乙",
  ]);

  flow.page.closeCatalog();
  flow.page.openCatalog();
  assert.deepEqual(
    flow.page.data.catalogRows.map((row) => row.title),
    ["一级甲", "二级甲", "三级甲", "三级乙", "二级乙", "一级乙"],
    "reopening the drawer keeps the remembered expansion state",
  );
});

test("the catalog header toggle collapses and expands the whole outline in one tap", () => {
  const flow = createPage(catalogSet);
  flow.page.openCatalog();
  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "二级甲" } } });
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), ["一级甲", "二级甲", "二级乙", "一级乙"]);
  assert.equal(flow.page.data.catalogExpandedAll, false);

  flow.page.toggleCatalogExpansionAll();
  assert.equal(flow.page.data.catalogExpandedAll, true);
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), [
    "一级甲",
    "二级甲",
    "三级甲",
    "三级乙",
    "二级乙",
    "一级乙",
  ]);

  flow.page.toggleCatalogExpansionAll();
  assert.equal(flow.page.data.catalogExpandedAll, false);
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), ["一级甲", "一级乙"]);
});

test("tapping a catalog card jumps to that card in the set instead of opening it", () => {
  const flow = createPage(catalogSet);
  flow.page.openCatalog();

  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "三级乙" } } });

  assert.equal(flow.page.data.catalogView, "summary");
  assert.equal(flow.page.data.catalogSummaryTitle, "三级乙");
  assert.deepEqual(flow.page.data.catalogSummaryCards, [
    { id: "third-2", summaryNumber: "01", title: "三级问题乙" },
    { id: "third-3", summaryNumber: "02", title: "空白卡片" },
  ]);

  flow.page.selectCatalogCard({ currentTarget: { dataset: { id: "third-2" } } });
  assert.equal(flow.page.data.catalogOpen, false);
  assert.equal(flow.page.data.highlightCardId, "third-2");
  assert.equal(flow.navigation(), undefined, "the catalog locates the card on the page instead of navigating away");
  flow.page.onUnload();

  flow.page.openCatalog();
  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "三级乙" } } });
  flow.page.backToCatalogDirectory();
  assert.equal(flow.page.data.catalogView, "directory");
  assert.equal(flow.page.data.catalogSummaryTitle, "三级乙", "the last summary title stays available for the next drill-down");
});

test("jumping to a card scrolls the page to its anchor below the fixed navigation", () => {
  const flow = createPage(catalogSet);
  let scrollOptions;
  global.wx.createSelectorQuery = () => ({
    select: () => ({ boundingClientRect: () => {} }),
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([{ top: 420 }, { scrollTop: 300 }]),
  });
  global.wx.pageScrollTo = (options) => { scrollOptions = options; };
  flow.page.setData({ navTotalHeight: 96 });

  flow.page.scrollToCard("third-2");

  assert.deepEqual(scrollOptions, { scrollTop: 300 + 420 - 96 - 12, duration: 260 });
});

test("a blank card in the deepest heading also jumps to its position instead of opening the editor", () => {
  const flow = createPage(catalogSet);
  flow.page.openCatalog();
  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "三级乙" } } });

  flow.page.selectCatalogCard({ currentTarget: { dataset: { id: "third-3" } } });

  assert.equal(flow.page.data.highlightCardId, "third-3");
  assert.equal(flow.page.data.catalogOpen, false);
  assert.equal(flow.navigation(), undefined);
  flow.page.onUnload();
});

test("an empty directory tells the user it has no cards instead of opening an empty list", () => {
  const flow = createPage({
    ...makeSet(),
    cards: [],
    sectionOrder: ["空目录"],
    sectionLevels: { 空目录: 1 },
  });
  flow.page.openCatalog();

  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "空目录" } } });

  assert.equal(flow.toast().title, "空目录暂无卡片");
  assert.equal(flow.page.data.catalogView, "directory");
  assert.equal(flow.page.data.catalogSummaryCards.length, 0);
});

test("the card set catalog markup renders a left drawer with a dynamic expand toggle", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(markup, /bindtap="openCatalog"[\s\S]{0,120}list\.svg/);
  assert.match(markup, /class="catalog-layer" wx:if="\{\{catalogOpen\}\}"/);
  assert.match(markup, /class="catalog-mask" bindtap="closeCatalog"/);
  assert.match(markup, /class="catalog-panel" style="top: \{\{floatingTop\}\}px;"/);
  assert.match(markup, /id="card-anchor-\{\{card\.id\}\}"/);
  assert.match(markup, /card\.id === highlightCardId \? 'card-flash' : ''/);
  assert.match(
    markup,
    /src="\/assets\/icons\/\{\{catalogExpandedAll \? 'list-collapse' : 'list-expand'\}\}\.svg"/,
  );
  assert.match(markup, /bindtap="toggleCatalogExpansionAll"/);
  assert.match(markup, /wx:for="\{\{catalogRows\}\}"[\s\S]{0,240}bindtap="selectCatalogRow"/);
  assert.match(markup, /wx:for="\{\{catalogSummaryCards\}\}"[\s\S]{0,240}bindtap="selectCatalogCard"/);
  assert.match(markup, /bindtap="backToCatalogDirectory"[\s\S]{0,120}arrow-left\.svg/);
  assert.doesNotMatch(markup, /scrollToOutline|card-set-outline/);

  assert.match(styles, /\.catalog-layer\{position:fixed;z-index:1500;/);
  assert.match(styles, /\.catalog-panel\{position:absolute;bottom:32rpx;left:28rpx;/);
  assert.match(styles, /\.catalog-panel\{[^}]*max-height:72vh/);
  assert.match(styles, /\.catalog-row-count\{[^}]*font-size:19rpx/);
  assert.match(styles, /\.catalog-summary-item\{[^}]*grid-template-columns:52rpx minmax\(0,1fr\)/);
  assert.match(styles, /\.card-flash\{[^}]*border:3rpx solid #2f9fff/);
});

test("the card set action bar follows the page and pins below the navigation bar", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(
    markup,
    /class="context-toolbar [^"]*" wx:if="\{\{actionMode && contextToolbarReady\}\}" style="top: \{\{contextToolbarTop\}\}px;"/,
  );
  assert.match(markup, /id="directory-anchor-\{\{item\.index\}\}"/);
  assert.doesNotMatch(markup, /context-toolbar-slot/);
  assert.match(styles, /\.context-toolbar\{position:fixed;z-index:35;/);
  assert.doesNotMatch(styles, /\.context-toolbar\{[^}]*transition:top/);
  assert.doesNotMatch(styles, /\.context-toolbar\{position:sticky/);
  assert.match(styles, /\.context-left\{left:28rpx;right:auto/);
  assert.match(styles, /\.context-center\{left:50%;right:auto;[^}]*transform:translateX\(-50%\)\}/);
  assert.match(styles, /\.context-right\{right:28rpx;left:auto/);

  const flow = createPage();
  const { statusBarHeight, navContentHeight, floatingTop } = flow.page.data;
  assert.equal(
    floatingTop,
    statusBarHeight + navContentHeight + 8,
    "the floating offset keeps pinned layers just below the measured navigation bar",
  );
  assert.equal(flow.page.data.contextToolbarTop, floatingTop, "the action bar starts in its docked position");
  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(flow.page.data.actionMode, "cards");
  flow.page.cancelSelect();
  assert.equal(flow.page.data.actionMode, "");
});

test("the card set colour panel unifies this set and rains over its folder", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(markup, /class="drawer-layer" wx:if="\{\{colorPanelOpen\}\}"/);
  assert.match(markup, /<text>选择卡盒颜色<\/text>/);
  assert.match(markup, /data-mode="uniform" bindtap="selectColorMode"/);
  assert.match(markup, /data-mode="rainbow" bindtap="selectColorMode"/);
  assert.match(markup, /bindtap="applyRainbow"[\s\S]{0,40}>应用渐变色<\/view>/);
  assert.doesNotMatch(markup, /暖色系/);
  assert.match(styles, /\.color-modes\{display:grid;grid-template-columns:repeat\(2,/);
  assert.match(styles, /\.color-swatch\{height:132rpx/);
  assert.match(styles, /\.color-swatch-active\{position:relative;border-color:#4a74a6\}/);
  assert.match(styles, /\.color-apply\{display:flex;height:92rpx/);

  const flow = createPage();
  flow.page.openMoreDrawer();
  flow.page.drawerAction({ currentTarget: { dataset: { key: "color" } } });
  assert.equal(flow.page.data.moreDrawerOpen, false, "opening the colour panel closes the drawer");
  assert.equal(flow.page.data.colorPanelOpen, true);
  assert.equal(flow.page.data.colorMode, "uniform");
  assert.match(flow.page.data.colorScopeLabel, /《/);

  flow.page.applyUniformColor({ currentTarget: { dataset: { key: "lemon" } } });
  assert.equal(flow.page.data.selectedSetColor, "lemon");
  assert.equal(flow.storedSet().color, "lemon", "the colour lands on the stored card set");

  flow.page.selectColorMode({ currentTarget: { dataset: { mode: "rainbow" } } });
  assert.equal(flow.page.data.colorMode, "rainbow");
  let asked = null;
  global.wx.showModal = (options) => { asked = options; options.success({ confirm: true }); };
  flow.page.applyRainbow();
  assert.equal(asked.title, "设置彩虹色");
  assert.equal(asked.content, "是否将当前文件夹下的所有卡盒按顺序应用渐变色？");
  assert.equal(flow.page.data.colorPanelOpen, false);
  assert.equal(flow.storedSet().color, "rose", "the rained colour comes from the palette order");
});

test("the card toolbar paints selected cards from the shared palette", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(
    markup,
    /data-action="color" bindtap="selectionAction"[\s\S]{0,110}palette\.svg[\s\S]{0,40}<label>颜色<\/label>/,
    "the card toolbar carries a 颜色 entry",
  );
  assert.match(markup, /class="color-picker color-picker-\{\{selectionAlign\}\}"/);
  assert.match(markup, /style="background: \{\{item\.soft\}\};"/);
  assert.match(markup, /style="\{\{card\.colorSoft \? '--card-edge: ' \+ card\.colorEdge \+ '; background: ' \+ card\.colorSoft \+ ';' : ''\}\}"/, "a painted card tints its surface and exposes its edge colour to CSS");
  assert.match(styles, /\.context-toolbar-color\{width:466rpx\}/);
  assert.match(styles, /\.context-toolbar-color\.context-toolbar-with-edit\{width:558rpx\}/);
  assert.match(styles, /\.color-dot\{width:64rpx;height:64rpx/);
  assert.match(styles, /\.color-dot-active\{border-color:#fff\}/);

  const flow = createPage();
  global.wx.createSelectorQuery = () => ({
    select: () => ({ boundingClientRect: () => {} }),
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([{ top: 600, bottom: 760 }, { scrollTop: 200 }]),
  });
  flow.page.setData({ floatingTop: 96, contextToolbarHeight: 48, viewportHeight: 800, contextToolbarTop: 300 });
  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(flow.page.data.selectedCardColor, "", "an unpainted card starts on 无颜色");

  flow.page.selectionAction({ currentTarget: { dataset: { action: "color" } } });
  assert.equal(flow.page.data.cardColorPickerOpen, true);
  assert.equal(
    flow.page.data.cardColorPickerTop,
    Math.min(flow.page.data.contextToolbarTop + 48 + 10, 800 - 220),
    "the palette hangs under the toolbar but never leaves the viewport",
  );

  flow.page.selectCardColor({ currentTarget: { dataset: { key: "aqua" } } });
  const painted = flow.page.data.sections
    .flatMap((section) => section.cards)
    .find((card) => card.id === "a-1");
  assert.equal(painted.color, "aqua");
  assert.match(painted.colorSoft, /^linear-gradient\(150deg, rgba\(255,255,255,\.42\)/, "the painted card carries a restrained highlight");
  assert.match(painted.colorSoft, /#D2F1EC$/, "the highlight sits on top of the palette colour");
  assert.equal(painted.colorEdge, "rgba(42, 138, 128, 0.26)", "the painted card gets a same-hue glass edge");
  assert.equal(painted.colorAccent, "#2A8A80");
  assert.equal(flow.page.data.selectedCardColor, "aqua", "the picker marks the applied colour");

  flow.page.selectCardColor({ currentTarget: { dataset: { key: "" } } });
  const cleared = flow.page.data.sections
    .flatMap((section) => section.cards)
    .find((card) => card.id === "a-1");
  assert.equal(cleared.color, "");
  assert.equal(cleared.colorSoft, "");

  flow.page.cancelSelect();
  assert.equal(flow.page.data.cardColorPickerOpen, false, "leaving selection closes the palette");
});

test("the more drawer replaces the action sheet with the reference layout", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(markup, /bindtap="openMoreDrawer"[\s\S]{0,40}<label>更多<\/label>/);
  assert.match(markup, /class="drawer-layer" wx:if="\{\{moreDrawerOpen\}\}" catchtouchmove="stopTouchMove"/);
  assert.match(markup, /class="drawer-mask" bindtap="closeMoreDrawer"/);
  ["卡片操作", "样式设置", "卡盒管理"].forEach((title) => {
    assert.ok(markup.includes(`>${title}</view>`), `the drawer keeps the ${title} section`);
  });
  ["导出卡片", "导入新卡片", "正反面交换", "更换颜色", "卡盒排序", "重命名卡盒", "移动目录", "删除卡盒"].forEach((label) => {
    assert.ok(markup.includes(`<label>${label}</label>`), `the drawer lists ${label}`);
  });
  assert.match(styles, /\.more-drawer\{[^}]*bottom:0[^}]*border-radius:28rpx 28rpx 0 0[^}]*animation:drawer-up/);
  const drawerMarkup = markup.slice(markup.indexOf('class="drawer-layer"'));
  assert.doesNotMatch(
    drawerMarkup,
    /pack-(?:plus|edit|folder|trash)\.svg/,
    "the white toolbar icons would be invisible on the light drawer",
  );
  assert.match(drawerMarkup, /card-import\.svg/);
  assert.match(drawerMarkup, /card-rename\.svg/);
  assert.match(drawerMarkup, /card-move\.svg/);
  assert.match(drawerMarkup, /card-delete\.svg/);
  assert.match(styles, /@keyframes drawer-up\{from\{transform:translateY\(100%\)\}/);
  assert.match(styles, /\.drawer-grid\{display:grid;grid-template-columns:repeat\(4,/);

  const flow = createPage();
  assert.equal(flow.page.data.moreDrawerOpen, false);
  flow.page.openMoreDrawer();
  assert.equal(flow.page.data.moreDrawerOpen, true);
  flow.page.drawerAction({ currentTarget: { dataset: { key: "export" } } });
  assert.equal(flow.toast().title, "该功能开发中", "the skeleton drawer only explains itself for now");
  flow.page.closeMoreDrawer();
  assert.equal(flow.page.data.moreDrawerOpen, false);
});

test("long pressing a card floats the action bar above that card", () => {
  const flow = createPage();
  global.wx.createSelectorQuery = () => ({
    select: (selector) => {
      assert.equal(selector, "#card-anchor-a-1");
      return { boundingClientRect: () => {} };
    },
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([{ top: 600, bottom: 760 }, { scrollTop: 200 }]),
  });
  flow.page.setData({ floatingTop: 96, contextToolbarHeight: 48, viewportHeight: 800 });

  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });

  assert.equal(flow.page.data.contextToolbarTop, 600 - 48 - 12);
});

test("scrolling moves the action bar with the content until it pins below the navigation bar", () => {
  const flow = createPage();
  global.wx.createSelectorQuery = () => ({
    select: () => ({ boundingClientRect: () => {} }),
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([{ top: 600, bottom: 760 }, { scrollTop: 200 }]),
  });
  flow.page.setData({ floatingTop: 96, contextToolbarHeight: 48, viewportHeight: 800 });
  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(flow.page.data.contextToolbarTop, 540);

  flow.page.onPageScroll({ scrollTop: 210 });
  assert.equal(flow.page.data.contextToolbarTop, 530, "the bar moves up together with the content");

  flow.page.onPageScroll({ scrollTop: 300 });
  assert.equal(flow.page.data.contextToolbarTop, 440, "it keeps following the content instead of jumping");

  flow.page.onPageScroll({ scrollTop: 644 });
  assert.equal(flow.page.data.contextToolbarTop, 96, "it pins once it reaches the navigation bar");

  flow.page.onPageScroll({ scrollTop: 700 });
  assert.equal(flow.page.data.contextToolbarTop, 96, "it stays pinned while scrolling further down");

  flow.page.onPageScroll({ scrollTop: 240 });
  assert.equal(flow.page.data.contextToolbarTop, 500, "scrolling back up releases it with the content");

  flow.page.cancelSelect();
  flow.page.onPageScroll({ scrollTop: 500 });
  assert.equal(flow.page.data.contextToolbarTop, 500, "scrolling without an active selection leaves the bar alone");
});

test("the floating action bar falls back below the pressed item and stays inside the viewport", () => {
  const flow = createPage();
  let rect = { top: 40, bottom: 200 };
  global.wx.createSelectorQuery = () => ({
    select: () => ({ boundingClientRect: () => {} }),
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([rect, { scrollTop: 0 }]),
  });
  flow.page.setData({ floatingTop: 96, contextToolbarHeight: 48, viewportHeight: 800 });

  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(flow.page.data.contextToolbarTop, 212, "a card under the navigation bar puts the bar below itself");

  rect = { top: 40, bottom: 780 };
  flow.page.startSelect({ currentTarget: { dataset: { id: "a-2" } } });
  assert.equal(flow.page.data.contextToolbarTop, 800 - 48 - 20, "the bar never leaves the bottom of the viewport");
});

test("long pressing a directory title floats the action bar at that directory", () => {
  const flow = createPage();
  const anchors = [];
  global.wx.createSelectorQuery = () => ({
    select: (selector) => {
      anchors.push(selector);
      return { boundingClientRect: () => {} };
    },
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([{ top: 500, bottom: 540 }, { scrollTop: 120 }]),
  });
  flow.page.setData({ floatingTop: 96, contextToolbarHeight: 48, viewportHeight: 800 });

  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第二章", index: 1 } } });

  assert.equal(flow.page.data.actionMode, "directory");
  assert.equal(flow.page.data.contextToolbarTop, 500 - 48 - 12);
  assert.deepEqual(anchors, ["#directory-anchor-1"]);

  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第一章" } } });
  assert.equal(flow.page.data.contextToolbarTop, 96, "a directory without an anchor docks the bar under the nav");
  assert.deepEqual(anchors, ["#directory-anchor-1"], "docking needs no extra measurement");
});

test("a first long press never shows the action bar at a stale position", () => {
  const flow = createPage();
  global.wx.createSelectorQuery = () => ({
    select: () => ({ boundingClientRect: () => {} }),
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([{ top: 400, bottom: 560 }, { scrollTop: 0 }]),
  });
  flow.page.setData({ floatingTop: 96, contextToolbarHeight: 48, viewportHeight: 800, contextToolbarTop: 700, contextToolbarReady: true });

  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(flow.page.data.contextToolbarReady, true);
  assert.equal(flow.page.data.contextToolbarTop, 400 - 48 - 12, "the bar only renders once its position is measured");
});

test("selecting another card moves the action bar to that card", () => {
  const flow = createPage();
  const rects = {
    "#card-anchor-a-1": { top: 600, bottom: 760 },
    "#card-anchor-a-2": { top: 300, bottom: 460 },
  };
  let selector = "";
  global.wx.createSelectorQuery = () => ({
    select: (value) => { selector = value; return { boundingClientRect: () => {} }; },
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([rects[selector], { scrollTop: 0 }]),
  });
  flow.page.setData({ floatingTop: 96, contextToolbarHeight: 48, viewportHeight: 800 });

  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(flow.page.data.contextToolbarTop, 600 - 48 - 12);

  flow.page._longPressAt = 0;
  flow.page.openCard({ currentTarget: { dataset: { id: "a-2" } } });

  assert.deepEqual(flow.page.data.selectedIds, ["a-1", "a-2"]);
  assert.equal(flow.page.data.contextToolbarTop, 300 - 48 - 12, "the bar follows the newly selected card");
  assert.equal(flow.page.data.contextToolbarReady, true, "the bar moves without blinking out");

  flow.page._longPressAt = 0;
  flow.page.openCard({ currentTarget: { dataset: { id: "a-2" } } });

  assert.deepEqual(flow.page.data.selectedIds, ["a-1"]);
  assert.equal(flow.page.data.contextToolbarTop, 300 - 48 - 12, "deselecting keeps the bar where it is");
});

test("the moved action bar keeps following the page from its new card", () => {
  const flow = createPage();
  const rects = {
    "#card-anchor-a-1": { top: 600, bottom: 760 },
    "#card-anchor-a-2": { top: 300, bottom: 460 },
  };
  let selector = "";
  global.wx.createSelectorQuery = () => ({
    select: (value) => { selector = value; return { boundingClientRect: () => {} }; },
    selectViewport: () => ({ scrollOffset: () => {} }),
    exec: (callback) => callback([rects[selector], { scrollTop: 100 }]),
  });
  flow.page.setData({ floatingTop: 96, contextToolbarHeight: 48, viewportHeight: 800 });

  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  flow.page._longPressAt = 0;
  flow.page.openCard({ currentTarget: { dataset: { id: "a-2" } } });

  assert.equal(flow.page.data.contextToolbarTop, 240);
  flow.page.onPageScroll({ scrollTop: 344 });
  assert.equal(flow.page.data.contextToolbarTop, 96, "the new anchor pins below the navigation bar as well");
});

test("the directory toolbar offers adding a card or a child directory", () => {
  const flow = createPage();
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第二章" } } });

  flow.page.directoryAction({ currentTarget: { dataset: { action: "add" } } });

  // DEC-085：文案改为「插入卡片 / 插入子目录」（都插在所选目录下方）
  assert.deepEqual(flow.page.data.menuOptions.map((option) => option.label), ["插入卡片", "插入子目录"]);
  assert.equal(flow.page.data.menuOpen, true);
  flow.page.closeContextMenu();
  assert.equal(flow.page.data.menuOpen, false);
});

test("adding a card from a directory puts a blank card in that directory and opens its editor", () => {
  const flow = createPage();
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第二章" } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "add" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "card" } } });

  const cards = flow.storedSet().cards.filter((card) => card.section === "第二章");
  assert.equal(cards.length, 2);
  const blank = cards[1];
  assert.equal(blank.question, "");
  assert.equal(blank.answer, "");
  assert.equal(blank.state, "new");
  assert.equal(flow.navigation().url, `/pages/card-editor/card-editor?setId=set-1&cardId=${blank.id}`);
  assert.equal(flow.page.data.actionMode, "");
  assert.equal(
    flow.page.data.sections.find((section) => section.title === "第二章").cards.length,
    2,
    "the directory renders the blank card immediately",
  );
  assert.deepEqual(flow.storedSet().sectionOrder, ["第一章", "第二章"], "the directory list is unchanged");
});

test("adding a child directory lands right below the parent directory", () => {
  const flow = createPage(catalogSet);
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "一级甲" } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "add" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "child" } } });

  // DEC-060：子目录也是就地新建 + 行内改名。
  const placeholder = flow.page.data.directoryInlineEdit;
  assert.equal(Boolean(placeholder), true);
  assert.equal(flow.page.data.actionMode, "");
  // DEC-085：紧贴所选目录下方插入（成为它的第一个子目录），不再跳过已有下级跑到子树末尾。
  assert.deepEqual(flow.storedSet().sectionOrder,
    ["一级甲", placeholder, "二级甲", "三级甲", "三级乙", "二级乙", "一级乙"]);
  assert.equal(flow.storedSet().sectionLevels[placeholder], 2);

  flow.page.commitDirectoryInline({ detail: { value: "子目录甲" } });

  assert.deepEqual(flow.storedSet().sectionOrder, ["一级甲", "子目录甲", "二级甲", "三级甲", "三级乙", "二级乙", "一级乙"]);
  assert.equal(flow.storedSet().sectionLevels["子目录甲"], 2);
  assert.equal(flow.page.data.directoryInlineEdit, "");
  assert.equal(flow.page.data.sections.find((section) => section.title === "子目录甲").level, 2);
  assert.equal(flow.page.data.set.count, 6, "a new directory never creates a card");
});

test("renaming a directory keeps its level and moves its cards", () => {
  const flow = createPage(catalogSet);
  flow.page.startDirectoryEdit("二级乙");
  assert.equal(flow.page.data.directoryInlineEdit, "二级乙");
  assert.equal(flow.page.data.directoryInlineValue, "二级乙");
  flow.page.commitDirectoryInline({ currentTarget: { dataset: { title: "二级乙" } }, detail: { value: "二级乙改名" } });

  const set = flow.storedSet();
  assert.equal(set.sectionOrder.includes("二级乙改名"), true);
  assert.equal(set.sectionOrder.includes("二级乙"), false);
  assert.equal(set.sectionLevels["二级乙改名"], 2);
  assert.equal(set.cards.find((card) => card.id === "second-2").section, "二级乙改名");
});

test("inline directory editing keeps the original name on empty or duplicate input", () => {
  const flow = createPage(catalogSet);
  flow.page.startDirectoryEdit("二级乙");

  flow.page.commitDirectoryInline({ currentTarget: { dataset: { title: "二级乙" } }, detail: { value: "   " } });
  assert.equal(flow.storedSet().sectionOrder.includes("二级乙"), true, "an empty commit keeps the old name");
  assert.equal(flow.page.data.directoryInlineEdit, "");

  flow.page.startDirectoryEdit("二级乙");
  flow.page.commitDirectoryInline({ currentTarget: { dataset: { title: "二级乙" } }, detail: { value: "一级甲" } });
  assert.equal(flow.toast().title, "该目录已存在");
  assert.equal(flow.storedSet().sectionOrder.includes("二级乙"), true);

  flow.page.startDirectoryEdit("二级乙");
  flow.page.commitDirectoryInline({ currentTarget: { dataset: { title: "三级甲" } }, detail: { value: "改错行了" } });
  assert.equal(flow.storedSet().sectionOrder.includes("二级乙"), true, "the dataset title decides which row is renamed");
  assert.equal(flow.page.data.directoryInlineEdit, "");
});

test("a third level directory cannot take a child directory", () => {
  const flow = createPage(catalogSet);
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "三级甲" } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "add" } } });

  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "child" } } });

  assert.equal(flow.toast().title, "三级标题下不能再加子目录");
  assert.equal(flow.page.data.directoryInlineEdit, "");
  assert.equal(flow.storedSet().sectionOrder.includes("子目录"), false);
});

test("the floating bar shares the set instead of offering 整理", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  // DEC-080：分享从底栏移进「更多」抽屉；底栏只剩 添加卡片 / 练一练（主操作）/ 更多
  const bar = markup.slice(markup.indexOf('class="float-bar"'), markup.indexOf('class="drawer-layer"'));
  assert.match(bar, /bindtap="openAddMenu"[\s\S]{0,60}<label>添加卡片<\/label>/);
  assert.match(bar, /class="practice-main" bindtap="practice"[\s\S]{0,60}<label>练一练<\/label>/);
  assert.match(bar, /bindtap="openMoreDrawer"[\s\S]{0,60}<label>更多<\/label>/);
  assert.doesNotMatch(bar, /float-share|open-type="share"/, "分享不再占底栏位置");
  assert.doesNotMatch(markup, /bindtap="organize"|>整理<\/label>/);

  // 抽屉里用「普通条目 + 透明原生分享按钮」承载分享
  assert.match(
    markup,
    /class="drawer-item drawer-item-share-host"[\s\S]{0,200}<label>分享卡集<\/label>[\s\S]{0,200}<button class="drawer-share-trigger" open-type="share" aria-label="分享卡集">/,
    "分享卡集在抽屉里，仍是原生分享按钮",
  );
  assert.match(styles, /\.drawer-share-trigger\{[^}]*left:0[^}]*opacity:0/);
  assert.match(styles, /\.drawer-share-trigger::after\{[^}]*border:none\}/, "the WeChat button chrome is neutralised");
  assert.match(styles, /\.float-bar \.practice-main\{[^}]*flex:0 0 116rpx/);

  const flow = createPage();
  assert.equal(flow.page.organize, undefined, "the retired 整理 handler is gone");
  const share = flow.page.onShareAppMessage();
  assert.equal(typeof share.title, "string");
  assert.match(share.path, /^\/pages\/card-set\/card-set\?id=/);
});

// DEC-083：「标题级别」按钮上的角标要显示当前目录的级别（一级 H1、二级 H2），而不是写死的 H1。
test("the 标题级别 badge follows the selected directory level", () => {
  const flow = createPage({
    ...makeSet(),
    cards: [
      { id: "lv-1", section: "第一章", question: "一", answer: "a", state: "new" },
      { id: "lv-2", section: "第一节", question: "二", answer: "b", state: "new" },
    ],
    sectionOrder: ["第一章", "第一节"],
    sectionLevels: { 第一章: 1, 第一节: 2 },
  });
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第一节", index: 1 } } });
  assert.equal(flow.page.data.activeDirectoryLevel, 2, "二级目录显示 H2");
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第一章", index: 0 } } });
  assert.equal(flow.page.data.activeDirectoryLevel, 1, "一级目录显示 H1");

  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");
  assert.match(markup, /data-action="level" bindtap="directoryAction"><text class="toolbar-level-mark">H\{\{activeDirectoryLevel\}\}<\/text>/);
  assert.doesNotMatch(markup, /pack-heading\.svg/, "不再用写死 H1 的图标");
  assert.match(styles, /\.context-toolbar \.toolbar-level-mark\{[^}]*font-size:22rpx/);
});

// DEC-086：新建目录行只有在看不见时才滚动过去；子目录紧贴父目录下方、本来就看得见，
// 所以插入子目录不该再"滑一下"。
test("the inline directory editor only scrolls when the row is off screen", () => {
  const flow = createPage();
  const scrolls = [];
  let rect = { top: 300, bottom: 360 };
  global.wx.pageScrollTo = (options) => scrolls.push(options);
  global.wx.createSelectorQuery = () => ({
    select() { return this; },
    boundingClientRect(callback) { this._callback = callback; return this; },
    exec() { if (this._callback) this._callback(rect); },
  });
  flow.page.setData({ viewportHeight: 667, navTotalHeight: 88 });

  flow.page.scrollDirectoryIntoView("第一章");
  assert.deepEqual(scrolls, [], "已经看得见就不滚动");

  rect = { top: 620, bottom: 690 };
  flow.page.scrollDirectoryIntoView("第一章");
  assert.equal(scrolls.length, 1, "超出下沿要带出来");
  assert.equal(scrolls[0].scrollTop, 690 - (667 - 140));

  rect = { top: 30, bottom: 100 };
  flow.page.scrollDirectoryIntoView("第一章");
  assert.equal(scrolls.length, 2, "被顶部导航挡住要带回去");

  // 找不到这一行时什么都不做
  flow.page.scrollDirectoryIntoView("不存在的目录");
  assert.equal(scrolls.length, 2);
});

// DEC-087：卡集页同样「先子目录、后自己的卡片」，插入子目录后新目录紧跟在父目录标题下方。
test("a card-set directory renders its subdirectories before its own cards", () => {
  const flow = createPage({
    ...makeSet(),
    cards: [
      { id: "ord-1", section: "第一章", question: "一", answer: "a", state: "new" },
      { id: "ord-2", section: "第一节", question: "二", answer: "b", state: "new" },
    ],
    sectionOrder: ["第一章", "第一节", "第二章"],
    sectionLevels: { 第一章: 1, 第一节: 2, 第二章: 1 },
  });
  const kinds = () => flow.page.data.sectionBlocks.map((block) => `${block.kind}:${block.section.title}`);
  assert.deepEqual(kinds(), [
    // 没有卡片的目录不产出卡片块（DEC-089），所以「第二章」只有标题块
    "title:第一章", "title:第一节", "cards:第一节", "cards:第一章", "title:第二章",
  ]);

  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第一章", index: 0 } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "add" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "child" } } });
  const placeholder = flow.page.data.directoryInlineEdit;
  // 新目录没有卡片 → 只有标题块；它紧跟父目录标题之后、排在父目录卡片之前
  assert.deepEqual(kinds().slice(0, 3), ["title:第一章", `title:${placeholder}`, "title:第一节"]);
});

test("the directory toolbar renders the add entry with its own width", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(markup, /data-action="add" bindtap="directoryAction"[\s\S]{0,80}pack-plus\.svg[\s\S]{0,40}<label>添加<\/label>/);
  assert.match(markup, /actionMode === 'directory' \? 'context-toolbar-directory' : ''/);
  assert.doesNotMatch(markup, /directory-editor|directoryEditorMode|saveDirectory/, "renaming and creating directories no longer use a popup");
  assert.match(styles, /\.context-toolbar-directory\{width:556rpx\}/);
  assert.doesNotMatch(styles, /\.directory-editor\s*\{/, "the retired directory dialog styles are gone");
});

test("the add menu keeps its own geometry above the floating bar", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(markup, /class="add-menu" wx:if="\{\{addMenuOpen\}\}" catchtap="noop"/);
  assert.match(markup, /bindtap="openAddMenu"[\s\S]{0,60}<label>添加卡片<\/label>/);
  assert.doesNotMatch(
    styles,
    /\.add-menu,\s*\.context-toolbar\s*\{/,
    "the add menu must not share the toolbar's fixed height",
  );
  const addMenuRules = styles.match(/\.add-menu\s*\{[^}]*\}/g) || [];
  assert.ok(addMenuRules.length, "the add menu keeps an explicit rule");
  const effective = addMenuRules[addMenuRules.length - 1];
  assert.match(effective, /height:auto/, "the two-item menu sizes itself instead of clipping at 96rpx");
  assert.match(effective, /bottom:158rpx/, "the menu sits above the 106rpx floating bar (bottom 40rpx)");
  assert.match(effective, /flex-direction:column/, "the items stack instead of spreading in a row");
  assert.match(effective, /background:#2d322f/, "the add menu keeps the dark contextual look");
});

test("tapping a directory title edits it inline instead of opening a popup", () => {
  const flow = createPage(catalogSet);
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "二级乙" } } });
  assert.equal(flow.page.data.actionMode, "directory");

  flow.page._directoryLongPressAt = 0;
  flow.page.editDirectory({ currentTarget: { dataset: { title: "二级乙" } } });

  assert.equal(flow.page.data.actionMode, "", "inline editing closes the toolbar");
  assert.equal(flow.page.data.directoryInlineEdit, "二级乙");
  assert.equal(flow.page.data.directoryInlineValue, "二级乙");
  assert.equal(flow.page.data.directoryEditorOpen, undefined, "no dialog state exists any more");

  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  assert.match(
    markup,
    /wx:if="\{\{item\.section\.title === directoryInlineEdit\}\}"[\s\S]{0,320}value="\{\{directoryInlineValue\}\}"[\s\S]{0,200}data-title="\{\{item\.section\.title\}\}"/,
    "the row itself becomes the input, prefilled with the current name",
  );
});

const dragSet = {
  ...makeSet(),
  cards: [
    { id: "c-1", section: "第一章", question: "一", answer: "a", state: "new" },
    { id: "c-2", section: "第一章", question: "二", answer: "a", state: "new" },
    { id: "c-3", section: "第一章", question: "三", answer: "a", state: "new" },
    { id: "c-4", section: "第一章", question: "四", answer: "a", state: "new" },
    { id: "c-5", section: "第二章", question: "五", answer: "a", state: "new" },
  ],
  sectionOrder: ["第一章", "第二章"],
  sectionLevels: { 第一章: 1, 第二章: 1 },
};

const dragTitles = [
  { dataset: { title: "第一章", index: 0 }, left: 14, top: 200, right: 361, bottom: 240 },
  { dataset: { title: "第二章", index: 1 }, left: 14, top: 700, right: 361, bottom: 740 },
];

const dragCards = [
  { dataset: { id: "c-1", section: "第一章" }, left: 14, top: 260, right: 184, bottom: 420 },
  { dataset: { id: "c-2", section: "第一章" }, left: 190, top: 260, right: 361, bottom: 420 },
  { dataset: { id: "c-3", section: "第一章" }, left: 14, top: 436, right: 184, bottom: 596 },
  { dataset: { id: "c-4", section: "第一章" }, left: 190, top: 436, right: 361, bottom: 596 },
  { dataset: { id: "c-5", section: "第二章" }, left: 14, top: 760, right: 184, bottom: 920 },
];

function mockSelectorQuery({ cards = [], titles = [], anchor = null, scrollTop = 0 } = {}) {
  global.wx.createSelectorQuery = () => {
    const requests = [];
    return {
      select: (selector) => {
        requests.push({ type: "select", selector });
        return { boundingClientRect: () => {} };
      },
      selectAll: (selector) => {
        requests.push({ type: "selectAll", selector });
        return { boundingClientRect: () => {} };
      },
      selectViewport: () => {
        requests.push({ type: "viewport" });
        return { scrollOffset: () => {} };
      },
      exec: (callback) => {
        const results = requests.map((request) => {
          if (request.type === "selectAll" && request.selector === ".study-card") return cards;
          if (request.type === "selectAll") return titles;
          if (request.type === "select") return anchor || { top: 600, bottom: 760, left: 14, right: 184 };
          return { scrollTop };
        });
        requests.length = 0;
        callback(results);
      },
    };
  };
}

function touchEvent(x, y) {
  return { touches: [{ clientX: x, clientY: y }] };
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test("long pressing a card and dragging it shows the blue insertion indicator", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({ contentLeft: 14, contentWidth: 347 });

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { id: "c-3", section: "第一章" } },
    touches: [{ clientX: 60, clientY: 500 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "c-3" } } });
  flow.page.handleCardTouchMove(touchEvent(60, 520));
  assert.equal(flow.page.data.dragActive, true);
  assert.equal(flow.page.data.dragKey, "c-3");
  assert.equal(flow.page.data.contextToolbarReady, false, "the toolbar hides while dragging");

  flow.page.handleCardTouchMove(touchEvent(150, 340));
  await wait(30);
  assert.deepEqual(flow.page.data.dragIndicator, { kind: "column", left: 185, top: 260, width: 4, height: 160 });

  flow.page.handleDragTouchEnd();

  assert.equal(flow.page.data.dragActive, false);
  assert.equal(flow.page.data.dragIndicator, null);
  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), ["c-1", "c-3", "c-2", "c-4", "c-5"]);
  assert.equal(flow.toast().title, "已移动卡片");
  assert.equal(flow.page.data.actionMode, "", "finishing a drag closes the toolbar");
});

test("dragging a card in front of the first card shows the full width row indicator", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({ contentLeft: 14, contentWidth: 347 });

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { id: "c-3", section: "第一章" } },
    touches: [{ clientX: 60, clientY: 500 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "c-3" } } });
  flow.page.handleCardTouchMove(touchEvent(60, 540));
  flow.page.handleCardTouchMove(touchEvent(50, 340));
  await wait(30);

  assert.deepEqual(flow.page.data.dragIndicator, { kind: "row", left: 14, top: 254, width: 347, height: 4 });

  flow.page.handleDragTouchEnd();
  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), ["c-3", "c-1", "c-2", "c-4", "c-5"]);
});

test("dragging one of several selected cards moves the whole selection", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({ contentLeft: 14, contentWidth: 347 });

  // 多选 c-1、c-2，然后拖 c-1 进第二章（真实顺序：touchstart → 长按选中 → 加选第二张）
  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { id: "c-1", section: "第一章" } },
    touches: [{ clientX: 60, clientY: 300 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "c-1" } } });
  flow.page.toggleCard({ currentTarget: { dataset: { id: "c-2" } } });
  assert.deepEqual(flow.page.data.selectedIds, ["c-1", "c-2"]);

  flow.page.handleCardTouchMove(touchEvent(60, 330));
  assert.equal(flow.page.data.dragGroupCount, 2, "整组拖拽时幽灵卡带 ×2 角标");
  flow.page.handleCardTouchMove(touchEvent(60, 820));
  await wait(30);
  flow.page.handleDragTouchEnd();

  assert.equal(flow.page.data.dragGroupCount, 0);
  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), ["c-3", "c-4", "c-1", "c-2", "c-5"]);
  assert.equal(flow.storedSet().cards.find((card) => card.id === "c-1").section, "第二章");
  assert.equal(flow.storedSet().cards.find((card) => card.id === "c-2").section, "第二章");
  assert.equal(flow.toast().title, "已移动 2 张卡片");
  assert.equal(flow.page.data.actionMode, "");
});

test("dragging a card into another directory moves it there", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({ contentLeft: 14, contentWidth: 347 });

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { id: "c-3", section: "第一章" } },
    touches: [{ clientX: 60, clientY: 500 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "c-3" } } });
  flow.page.handleCardTouchMove(touchEvent(60, 540));
  flow.page.handleCardTouchMove(touchEvent(150, 800));
  await wait(30);

  assert.deepEqual(flow.page.data.dragIndicator, { kind: "row", left: 14, top: 926, width: 347, height: 4 });

  flow.page.handleDragTouchEnd();
  const saved = flow.storedSet().cards;
  assert.equal(saved.find((card) => card.id === "c-3").section, "第二章");
  assert.deepEqual(saved.map((card) => card.id), ["c-1", "c-2", "c-4", "c-5", "c-3"]);
});

test("dragging a directory title reorders the directories with a row indicator", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({ contentLeft: 14, contentWidth: 347 });

  flow.page.handleTitleTouchStart({
    currentTarget: { dataset: { title: "第二章", index: 1 } },
    touches: [{ clientX: 60, clientY: 715 }],
  });
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第二章", index: 1 } } });
  flow.page.handleTitleTouchMove(touchEvent(60, 690));
  assert.equal(flow.page.data.dragKind, "directory");

  flow.page.handleTitleTouchMove(touchEvent(60, 120));
  await wait(30);

  assert.deepEqual(flow.page.data.dragIndicator, { kind: "row", left: 14, top: 194, width: 347, height: 4 });

  flow.page.handleDragTouchEnd();
  assert.deepEqual(flow.storedSet().sectionOrder, ["第二章", "第一章"]);
  assert.equal(flow.toast().title, "目录顺序已更新");
});

test("a long press without movement still only selects the card", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { id: "c-1", section: "第一章" } },
    touches: [{ clientX: 60, clientY: 300 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "c-1" } } });
  flow.page.handleCardTouchMove(touchEvent(62, 304));
  await wait(30);

  assert.equal(flow.page.data.dragActive, false, "a small wobble never starts a drag");
  assert.deepEqual(flow.page.data.selectedIds, ["c-1"]);
  flow.page.handleDragTouchEnd();
  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), ["c-1", "c-2", "c-3", "c-4", "c-5"]);
});

test("a drag without a measured layout leaves the card set untouched", async () => {
  const flow = createPage(dragSet);
  global.wx.createSelectorQuery = undefined;

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { id: "c-3", section: "第一章" } },
    touches: [{ clientX: 60, clientY: 500 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "c-3" } } });
  flow.page.handleCardTouchMove(touchEvent(60, 600));
  await wait(30);

  assert.equal(flow.page.data.dragActive, false);
  flow.page.handleDragTouchEnd();
  assert.deepEqual(flow.storedSet().cards.map((card) => card.id), ["c-1", "c-2", "c-3", "c-4", "c-5"]);
});

test("the drag markup renders indicators, ghost styling and touch handlers", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.match(markup, /class="drag-indicator drag-indicator-\{\{dragIndicator\.kind\}\}"/);
  assert.match(markup, /data-section="\{\{item\.section\.title\}\}"/);
  assert.match(markup, /bindtouchstart="handleCardTouchStart"[\s\S]{0,160}bindtouchmove="handleCardTouchMove"/);
  assert.match(markup, /bindtouchstart="handleTitleTouchStart"[\s\S]{0,160}bindtouchmove="handleTitleTouchMove"/);
  assert.match(markup, /class="context-menu-layer" wx:if="\{\{menuOpen\}\}"/);
  assert.match(markup, /class="context-menu-backdrop" catchtap="closeContextMenu"/);
  assert.match(markup, /class="context-menu context-menu-\{\{menuAlign\}\}" style="top: \{\{menuTop\}\}px;"/);
  assert.match(markup, /wx:for="\{\{menuOptions\}\}"[\s\S]{0,240}bindtap="selectContextMenuOption"/);
  assert.match(styles, /\.drag-indicator\{position:fixed;z-index:1;background:#2f9fff/);
  assert.match(styles, /\.study-card\{z-index:2\}/, "cards paint above the drop indicator");
  assert.match(styles, /\.drag-ghost\{position:fixed;z-index:60;/);
  assert.match(styles, /\.study-card-drag-origin\{[^}]*opacity:\.4\}/);
  assert.match(markup, /class="drag-ghost drag-ghost-card"/);
  assert.match(markup, /class="drag-ghost drag-ghost-title"/);
  assert.match(markup, /<template is="studyCardBody" data="\{\{card: card\}\}"\/>/);
  assert.match(styles, /\.context-menu\{position:absolute;[^}]*background:#2d322f/);
  assert.match(styles, /\.context-menu-left\{left:28rpx\}/);
  assert.match(styles, /\.context-menu-center\{left:50%;transform:translateX\(-50%\)\}/);
  assert.match(styles, /\.context-menu-right\{right:28rpx\}/);
});

test("dragging freezes the page scroll so the page cannot follow the dragged item", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const cardBoxStyles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-box/card-box.wxss"), "utf8");
  const cardBoxMarkup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-box/card-box.wxml"), "utf8");

  assert.match(markup, /^<page-meta page-style="\{\{pageScrollLocked \? 'overflow: hidden;' : ''\}\}" \/>/);
  assert.match(cardBoxMarkup, /class="selection-toolbar selection-\{\{selectionAlign\}\}/);
  assert.match(cardBoxStyles, /\.selection-toolbar\{position:sticky;z-index:11;top:150rpx;/);

  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  assert.equal(flow.page.data.pageScrollLocked, false, "the page scrolls freely before the long press");

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { id: "c-3", section: "第一章" } },
    touches: [{ clientX: 60, clientY: 500 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "c-3" } } });
  assert.equal(
    flow.page.data.pageScrollLocked,
    true,
    "the page locks on the long press, before the finger can start scrolling",
  );

  flow.page.handleDragTouchEnd();
  assert.equal(flow.page.data.pageScrollLocked, false, "lifting the finger restores page scrolling");
});

test("the retired card set toolbars no longer ship styles", () => {
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");

  assert.doesNotMatch(styles, /selection-toolbar|selection-left|selection-center|selection-right/);
  assert.doesNotMatch(styles, /directory-actions/);
  assert.doesNotMatch(markup, /selection-toolbar|directory-actions/);
  assert.match(styles, /\.context-toolbar\{position:fixed;z-index:35;/);
  assert.match(styles, /\.section-title\.section-title-active\{padding:14rpx 16rpx\}/);
});

test("the card toolbar drops pin while the directory toolbar keeps a cancel action", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxss"), "utf8");

  assert.doesNotMatch(markup, /data-action="pin"|pack-pin\.svg|<label>置顶<\/label>/);
  assert.match(markup, /data-action="delete" bindtap="directoryAction"[\s\S]{0,220}bindtap="cancelSelect"><image src="\/assets\/icons\/pack-close\.svg"[\s\S]{0,30}<label>取消<\/label>/);
  assert.match(styles, /\.context-toolbar-with-edit\{width:474rpx\}/);
  assert.match(styles, /\.context-toolbar-directory\{width:556rpx\}/);

  const flow = createPage();
  flow.page.applyCardSelection(["a-1"]);
  flow.page.selectionAction({ currentTarget: { dataset: { action: "pin" } } });
  assert.deepEqual(
    flow.storedSet().cards.map((card) => card.id),
    ["a-1", "a-2", "b-1"],
    "the retired pin action no longer exists",
  );
});

test("tapping blank space cancels the floating toolbars", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-set/card-set.wxml"), "utf8");
  const flow = createPage();

  assert.match(markup, /class="page" wx:if="\{\{set\}\}" bindtap="handleBlankTap"/);
  assert.match(markup, /catchtap="openCard"/);
  assert.match(markup, /catchtap="editDirectory"/);
  assert.match(markup, /class="context-toolbar [^"]*"[\s\S]{0,220}catchtap="noop"/);

  flow.page.startSelect({ currentTarget: { dataset: { id: "a-1" } } });
  assert.equal(flow.page.data.actionMode, "cards");
  flow.page.handleBlankTap();
  assert.equal(flow.page.data.actionMode, "", "tapping blank space closes the card toolbar");
  assert.deepEqual(flow.page.data.selectedIds, []);

  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第一章" } } });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "add" } } });
  assert.equal(flow.page.data.menuOpen, true);
  flow.page.handleBlankTap();
  assert.equal(flow.page.data.menuOpen, false, "tapping blank space closes an open menu first");
  assert.equal(flow.page.data.actionMode, "directory", "the toolbar survives the first blank tap");

  flow.page.handleBlankTap();
  assert.equal(flow.page.data.actionMode, "", "a second blank tap closes the toolbar");

  flow.page.handleBlankTap();
  assert.equal(flow.page.data.actionMode, "", "tapping blank space without a toolbar is a no-op");
});

test("dragging to the top or bottom edge keeps scrolling the page", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({
    contentLeft: 14,
    contentWidth: 347,
    navTotalHeight: 96,
    viewportHeight: 800,
    floatingTop: 96,
    contextToolbarHeight: 48,
  });
  const scrolls = [];
  global.wx.pageScrollTo = (options) => scrolls.push(options.scrollTop);

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { id: "c-3", section: "第一章" } },
    touches: [{ clientX: 60, clientY: 500 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "c-3" } } });
  flow.page.handleCardTouchMove(touchEvent(60, 540));
  assert.equal(flow.page.data.dragActive, true);

  flow.page.handleCardTouchMove(touchEvent(60, 760));
  await wait(60);
  assert.ok(scrolls.length >= 2, "holding near the bottom edge keeps scrolling down");
  const before = scrolls[scrolls.length - 1];
  assert.ok(before > 0);

  flow.page.handleCardTouchMove(touchEvent(60, 120));
  await wait(60);
  assert.ok(scrolls.length >= 4, "holding near the top edge scrolls back up");
  assert.ok(scrolls[scrolls.length - 1] < before);

  flow.page.handleDragTouchEnd();
  const settled = scrolls.length;
  await wait(40);
  assert.equal(scrolls.length, settled, "releasing the finger stops the edge scrolling");

  const moves = flow.storedSet().cards.map((card) => card.id);
  assert.deepEqual(moves, ["c-3", "c-1", "c-2", "c-4", "c-5"], "the card lands where the finger ended up");
  assert.equal(flow.page.data.pageScrollLocked, false);
});

test("dragging a directory in front of a card hands those cards to that directory", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({
    contentLeft: 14,
    contentWidth: 347,
    navTotalHeight: 96,
    viewportHeight: 800,
    floatingTop: 96,
    contextToolbarHeight: 48,
  });

  flow.page.handleTitleTouchStart({
    currentTarget: { dataset: { title: "第二章", index: 1 } },
    touches: [{ clientX: 60, clientY: 715 }],
  });
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第二章", index: 1 } } });
  flow.page.handleTitleTouchMove(touchEvent(60, 690));
  assert.equal(flow.page.data.dragKind, "directory");

  flow.page.handleTitleTouchMove(touchEvent(150, 340));
  await wait(30);

  assert.deepEqual(
    flow.page.data.dragIndicator,
    { kind: "column", left: 185, top: 260, width: 4, height: 160 },
    "the drop point is shown between the two cards it will split",
  );

  flow.page.handleDragTouchEnd();

  assert.deepEqual(flow.storedSet().cards.map((card) => `${card.section}:${card.id}`), [
    "第一章:c-1",
    "第二章:c-5",
    "第二章:c-2",
    "第二章:c-3",
    "第二章:c-4",
  ]);
  assert.deepEqual(flow.storedSet().sectionOrder, ["第一章", "第二章"]);
  assert.equal(flow.toast().title, "已把 3 张卡片划到「第二章」");
  assert.equal(flow.page.data.actionMode, "");
});

test("dropping a directory on a title still only reorders directories", async () => {
  const flow = createPage(dragSet);
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({
    contentLeft: 14,
    contentWidth: 347,
    navTotalHeight: 96,
    viewportHeight: 800,
    floatingTop: 96,
    contextToolbarHeight: 48,
  });

  flow.page.handleTitleTouchStart({
    currentTarget: { dataset: { title: "第二章", index: 1 } },
    touches: [{ clientX: 60, clientY: 715 }],
  });
  flow.page.openDirectoryActions({ currentTarget: { dataset: { title: "第二章", index: 1 } } });
  flow.page.handleTitleTouchMove(touchEvent(60, 690));
  flow.page.handleTitleTouchMove(touchEvent(60, 120));
  await wait(30);

  assert.deepEqual(flow.page.data.dragIndicator, { kind: "row", left: 14, top: 194, width: 347, height: 4 });

  flow.page.handleDragTouchEnd();

  assert.deepEqual(flow.storedSet().sectionOrder, ["第二章", "第一章"]);
  assert.deepEqual(
    flow.storedSet().cards.map((card) => `${card.id}:${card.section}`),
    ["c-5:第二章", "c-1:第一章", "c-2:第一章", "c-3:第一章", "c-4:第一章"],
    "reordering a directory regroups the cards but never changes their ownership",
  );
  assert.equal(flow.toast().title, "目录顺序已更新");
});

test.afterEach(() => {
  delete global.Page;
  delete global.wx;
});

