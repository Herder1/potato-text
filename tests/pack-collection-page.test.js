const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function createPage({ pack, assets = [], source = "private", app = {} } = {}) {
  let definition;
  let navigation = null;
  let modal = null;
  const storage = new Map([
    ["shukao_private_packs_migrated_v1", true],
    ["shukao_assets_migrated_v1", true],
    ["shukao_private_packs", source === "private" ? [pack] : []],
    ["shukao_user_assets", assets],
  ]);
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({
    globalData: { apiBaseUrl: "", officialQuestions: [], ...(app.globalData || {}) },
    ...(app || {}),
  });
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    navigateTo: (options) => { navigation = options; },
    navigateBack: () => { navigation = { back: true }; },
    showToast: (options) => { modal = { toast: options }; },
    showModal: (options) => { modal = options; if (options && options.success) options.success({ confirm: true }); },
    pageScrollTo() {},
    getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 375 }),
    getSystemInfoSync: () => ({ statusBarHeight: 44, windowWidth: 375 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, left: 278, width: 87, height: 32 }),
  };
  const modulePath = require.resolve("../apps/miniprogram/pages/pack-collection/pack-collection.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({ id: pack.id, source });
  page.onShow();
  return { page, storage, navigation: () => navigation, modal: () => modal };
}

test("collection detail lists every question and enters the whole pack at the selected question", () => {
  const pack = {
    id: "pack-local",
    name: "目录题包",
    description: "按章节整理",
    nodes: [
      { id: "dir-1", type: "directory", title: "第一章", level: 1, parentId: "" },
      { id: "card-1", type: "card", directoryId: "dir-1", questionId: "q-1" },
      { id: "card-2", type: "card", directoryId: "dir-1", questionId: "q-2" },
    ],
    questionIds: ["q-1", "q-2"],
  };
  const flow = createPage({
    pack,
    assets: [
      { id: "q-1", type: "question", stem: "第一道题", questionType: "单选题", typeCode: "single_choice", optionsText: "A. 甲\nB. 乙", correctAnswer: ["A"] },
      { id: "q-2", type: "question", stem: "第二道题", questionType: "简答题", referenceAnswer: "答案" },
    ],
  });

  assert.equal(flow.page.data.rows.length, 2);
  assert.equal(flow.page.data.sections[0].title, "第一章");
  assert.deepEqual(flow.page.data.sections[0].items.map((item) => item.stem), ["第一道题", "第二道题"]);

  flow.page.openQuestion({ currentTarget: { dataset: { id: "q-2" } } });
  assert.match(flow.navigation().url, /pages\/practice\/practice\?mode=pack/);
  assert.match(flow.navigation().url, /questionId=q-2/);
  assert.equal(flow.storage.get("shukao_active_pack_questions").length, 2);
});

test("deleted questions are marked and redirect to the next available question", () => {
  const pack = {
    id: "pack-deleted",
    name: "有删除题目的题包",
    nodes: [
      { id: "dir-1", type: "directory", title: "第一章", level: 1 },
      { id: "card-1", type: "card", directoryId: "dir-1", questionId: "q-1" },
      { id: "card-2", type: "card", directoryId: "dir-1", questionId: "q-deleted" },
      { id: "card-3", type: "card", directoryId: "dir-1", questionId: "q-3" },
    ],
    questionIds: ["q-1", "q-deleted", "q-3"],
  };
  const flow = createPage({
    pack,
    assets: [
      { id: "q-1", type: "question", stem: "可用题一", questionType: "简答题" },
      { id: "q-3", type: "question", stem: "可用题三", questionType: "简答题" },
    ],
  });

  const deleted = flow.page.data.rows.find((item) => item.id === "q-deleted");
  assert.equal(deleted.available, false);
  assert.equal(deleted.stem, "题目已被作者删除");

  flow.page.openQuestion({ currentTarget: { dataset: { id: "q-deleted" } } });
  assert.equal(flow.modal().title, "题目已被作者删除");
  assert.match(flow.navigation().url, /questionId=q-3/);
});

test("collection markup keeps the card grid, deleted state, and bottom navigation", () => {
  const markup = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/pack-collection/pack-collection.wxml"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/pack-collection/pack-collection.wxss"), "utf8");
  assert.match(markup, /class="card-grid"/);
  assert.match(markup, /wx:for="\{\{item\.section\.cards\}\}"/);
  assert.match(markup, /catchtap="openQuestion"/);
  assert.match(markup, /\{\{card\.title\}\}/);
  assert.match(markup, /study-card-deleted/);
  assert.match(markup, /class="collection-footer"/);
  assert.match(markup, /class="nav-leading"/);
  assert.match(markup, /class="nav-directory" bindtap="openCatalog"[^>]*><image/);
  assert.doesNotMatch(markup, /class="nav-directory"[^>]*>.*目录/);
  assert.match(markup, /bindtap="toggleAddMenu"/);
  assert.match(markup, /bindtap="createDirectory"/);
  assert.match(markup, /bindtap="createCard"/);
  assert.match(markup, /bindtap="startPractice"/);
  assert.match(markup, /class="more-mark">···<\/text>/);
  assert.match(markup, /class="hero-mark">题<\/view>/);
  // 2026-10-05 产品负责人指定：本页原先的蓝色（题包标记与「待录入」文字）统一改成品牌绿 #0b9588。
  assert.match(styles, /\.hero-mark \{[^}]*background: #0b9588/);
  assert.match(styles, /\.card-tag \{[^}]*color: #0b9588/);
  assert.match(styles, /\.study-foot text:first-child \{ color: #0b9588; \}/);
  assert.doesNotMatch(styles, /#237bff/, "蓝色不应再有残留");
  assert.doesNotMatch(markup, /collection-meta|meta-value|meta-label/, "统计行已按产品负责人要求去掉");
  assert.doesNotMatch(styles, /\.collection-meta|\.meta-value|\.meta-label/);
  assert.match(styles, /\.collection-footer \{[^}]*right: 48rpx;[^}]*left: 48rpx;[^}]*height: 106rpx;[^}]*border-radius: 56rpx/);
  assert.match(styles, /\.footer-primary \{[^}]*width: 116rpx;[^}]*height: 86rpx;[^}]*border-radius: 44rpx/);
  assert.match(styles, /\.nav-leading \{[^}]*position: absolute;[^}]*left: 18rpx;[^}]*width: 136rpx/);
  assert.match(styles, /\.collection-nav \{[^}]*align-items: flex-end/);
  assert.doesNotMatch(markup, /class="nav-title"/);
  // DEC-075：顶部「···」去掉（分享进底部更多），「题目目录」头部去掉。
  assert.doesNotMatch(markup, /nav-more/);
  assert.doesNotMatch(markup, /题目目录|class="outline-head"/);
  assert.match(markup, /class="section-lead"/);
  assert.match(markup, /class="more-drawer"/);
  assert.match(markup, /class="drawer-item" bindtap="sharePack"/);
  assert.match(markup, /bindtap="openQuestionImporter"/);
  assert.match(markup, /class="import-sheet"/);
  assert.match(styles, /\.more-drawer \{[^}]*border-radius: 28rpx 28rpx 0 0/);
  assert.match(styles, /@keyframes drawer-up/);
  assert.match(styles, /\.drag-ghost-count \{[^}]*background: #2f9fff/);
  assert.match(styles, /\.add-menu \{[^}]*left: 64rpx;[^}]*bottom: calc\(158rpx \+ env\(safe-area-inset-bottom\)\);[^}]*background: #2d322f/);
});

test("the pack catalog opens as a left drawer with expand/collapse, drill-down and locate-only jump", () => {
  const pack = {
    id: "pack-catalog",
    name: "目录抽屉题包",
    questionIds: ["q-1"],
    nodes: [
      { id: "dir-1", type: "directory", title: "第一章", level: 1, parentId: "" },
      { id: "dir-2", type: "directory", title: "第一节", level: 2, parentId: "dir-1" },
      { id: "card-1", type: "card", directoryId: "dir-2", questionId: "q-1" },
    ],
  };
  const flow = createPage({
    pack,
    assets: [{ id: "q-1", type: "question", stem: "第一道题", questionType: "简答题" }],
  });

  // 首次打开：抽屉展开整棵目录树（固定高度，不随目录条数变化）
  flow.page.openCatalog();
  assert.equal(flow.page.data.catalogOpen, true);
  assert.equal(flow.page.data.catalogView, "directory");
  assert.equal(flow.page.data.catalogDirectoryCount, 2);
  assert.equal(flow.page.data.catalogExpandedAll, true);
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), ["第一章", "第一节"]);
  assert.equal(flow.page.data.catalogRows[0].hasChildren, true);
  assert.equal(flow.page.data.catalogRows[0].totalCount, 1);
  assert.equal(flow.page.data.catalogRows[1].ownCount, 1);
  assert.equal(Number.isFinite(flow.page.data.floatingTop), true);

  // 点一级目录只折叠，不跳走；一键折叠/展开按钮切换全部
  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "dir-1" } } });
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), ["第一章"]);
  assert.equal(flow.page.data.catalogExpandedAll, false);
  flow.page.toggleCatalogExpansionAll();
  assert.equal(flow.page.data.catalogExpandedAll, true);
  assert.deepEqual(flow.page.data.catalogRows.map((row) => row.title), ["第一章", "第一节"]);

  // 点末级目录进入该目录自己的题目列表
  flow.page.selectCatalogRow({ currentTarget: { dataset: { key: "dir-2" } } });
  assert.equal(flow.page.data.catalogView, "summary");
  assert.equal(flow.page.data.catalogSummaryTitle, "第一节");
  assert.deepEqual(flow.page.data.catalogSummaryQuestions.map((item) => item.id), ["q-1"]);

  // 点题目只关闭抽屉并定位高亮，不跳转页面
  flow.page.selectCatalogQuestion({ currentTarget: { dataset: { id: "q-1" } } });
  assert.equal(flow.page.data.catalogOpen, false);
  assert.equal(flow.page.data.selectedQuestionId, "q-1");
  assert.equal(flow.navigation(), null);

  // 返回目录视图 + 遮罩关闭
  flow.page.openCatalog();
  flow.page.backToCatalogDirectory();
  assert.equal(flow.page.data.catalogView, "directory");
  flow.page.closeCatalog();
  assert.equal(flow.page.data.catalogOpen, false);
  flow.page.onUnload();
});

test("pack catalog markup renders a left drawer with a dynamic expand toggle", () => {
  const pageDir = path.resolve(__dirname, "../apps/miniprogram/pages/pack-collection");
  const markup = fs.readFileSync(path.join(pageDir, "pack-collection.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "pack-collection.wxss"), "utf8");

  assert.match(markup, /class="catalog-layer" wx:if="\{\{catalogOpen\}\}"/);
  assert.match(markup, /class="catalog-mask" bindtap="closeCatalog"/);
  assert.match(markup, /class="catalog-panel" style="top: \{\{floatingTop\}\}px;"/);
  assert.match(markup, /src="\/assets\/icons\/\{\{catalogExpandedAll \? 'list-collapse' : 'list-expand'\}\}\.svg"/);
  assert.match(markup, /wx:for="\{\{catalogRows\}\}"[\s\S]{0,280}bindtap="selectCatalogRow"/);
  assert.match(markup, /wx:for="\{\{catalogSummaryQuestions\}\}"[\s\S]{0,260}bindtap="selectCatalogQuestion"/);
  assert.match(markup, /id="question-anchor-\{\{card\.id\}\}"/);
  assert.doesNotMatch(markup, /scrollToOutline/);
  assert.match(styles, /\.catalog-layer \{ position: fixed; z-index: 1500;/);
  assert.match(styles, /\.catalog-panel \{[^}]*bottom: 32rpx;[^}]*left: 28rpx;[^}]*max-height: 72vh/);
  assert.match(styles, /\.catalog-summary-item \{[^}]*grid-template-columns: 52rpx minmax\(0,1fr\)/);

  // DEC-070：题包页借用卡集页的「目录 + 双列卡片 + 深色操作栏」。
  assert.match(markup, /class="card-grid"/);
  assert.match(markup, /class="section section-level-block-\{\{item\.section\.level\}\}/);
  // DEC-087：渲染序列拆成「标题块 / 卡片块」，卡片块跟在子目录之后
  assert.match(markup, /<block wx:for="\{\{sectionBlocks\}\}" wx:for-item="item" wx:key="key">/);
  assert.match(markup, /class="section-cards" wx:else>/);
  assert.match(markup, /class="section-title-input/);
  assert.match(markup, /class="context-toolbar /);
  assert.match(markup, /bindlongpress="startSelect"/);
  assert.match(markup, /bindlongpress="openDirectoryActions"/);
  assert.match(markup, /class="context-menu context-menu-\{\{contextMenuAlign\}\}"/);
  // DEC-085：底部「添加卡片」菜单只保留 新建目录 / 新建卡片（新建子目录已按产品负责人要求去掉，
  // 建子目录仍可从目录长按工具栏的「添加」里进）
  assert.match(markup, /class="add-menu-item" bindtap="createDirectory"/);
  assert.match(markup, /class="add-menu-item" bindtap="createCard"/);
  assert.doesNotMatch(markup, /class="add-menu-item" bindtap="createChildDirectory"/);
  assert.doesNotMatch(markup, /<label>新建子目录<\/label>/);
  assert.doesNotMatch(markup, /class="question-row|class="question-list"/);
  assert.match(styles, /\.card-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0,1fr\)\)/);
  assert.match(styles, /\.context-toolbar \{[^}]*background: #2d322f/);
  assert.match(styles, /\.add-menu \{[^}]*background: #2d322f/);
});

test("the pack page only scrolls to a new directory when it is off screen", () => {
  const pack = {
    id: "pack-scroll-guard",
    name: "滚动题包",
    nodes: [{ id: "dir-scroll", type: "directory", title: "第一章", level: 1, parentId: "" }],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });
  const scrolls = [];
  let rect = { top: 300, bottom: 360 };
  global.wx.pageScrollTo = (options) => scrolls.push(options);
  global.wx.createSelectorQuery = () => ({
    select() { return this; },
    boundingClientRect(callback) { this._callback = callback; return this; },
    exec() { if (this._callback) this._callback(rect); },
  });
  flow.page.setData({ viewportHeight: 667, navTotalHeight: 88 });

  flow.page.scrollDirectoryIntoView("dir-scroll");
  assert.deepEqual(scrolls, [], "已经看得见就不滚动");

  rect = { top: 620, bottom: 690 };
  flow.page.scrollDirectoryIntoView("dir-scroll");
  assert.equal(scrolls.length, 1, "超出下沿要带出来");
  assert.equal(scrolls[0].scrollTop, 690 - (667 - 160));

  flow.page.scrollDirectoryIntoView("");
  assert.equal(scrolls.length, 1, "没有目录 id 时什么都不做");
});

test("pack collection directory editing is inline and caps at three levels", () => {
  const pack = { id: "pack-dir-edit", name: "目录编辑题包", nodes: [], questionIds: [] };
  const flow = createPage({ pack, source: "private" });

  // 新建：直接进入行内输入，提交后才落名字
  flow.page.toggleAddMenu();
  flow.page.createDirectory();
  const chapterId = flow.page.data.directoryInlineEdit;
  assert.equal(Boolean(chapterId), true);
  assert.equal(flow.page.data.addMenuOpen, false);
  flow.page.commitDirectoryInline({ detail: { value: "第一章 语音" } });
  let nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.deepEqual(nodes.map((node) => [node.title, node.level, node.parentId]), [["第一章 语音", 1, ""]]);
  assert.equal(flow.page.data.directoryInlineEdit, "");
  assert.deepEqual(flow.page.data.sections.map((section) => section.title), ["第一章 语音"]);
  assert.equal(flow.page.data.sections[0].displayCount, 0);

  // 子目录：自动二级，最多三级
  flow.page.setData({ activeDirectory: chapterId });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "add" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "child", kind: "addInDirectory" } } });
  const sectionId = flow.page.data.directoryInlineEdit;
  flow.page.commitDirectoryInline({ detail: { value: "第一节 声母" } });
  flow.page.setData({ activeDirectory: sectionId });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "add" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "child", kind: "addInDirectory" } } });
  const topicId = flow.page.data.directoryInlineEdit;
  flow.page.commitDirectoryInline({ detail: { value: "一、发音方法" } });
  nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.deepEqual(nodes.map((node) => [node.title, node.level, node.parentId]), [
    ["第一章 语音", 1, ""],
    ["第一节 声母", 2, chapterId],
    ["一、发音方法", 3, sectionId],
  ]);
  flow.page.setData({ activeDirectory: topicId });
  flow.page.createChildDirectory();
  assert.equal(flow.modal().toast.title, "最多三级目录");

  // 改名：就地输入框预填当前名，提交后写回
  flow.page.editDirectory({ currentTarget: { dataset: { id: chapterId } } });
  assert.equal(flow.page.data.directoryInlineEdit, chapterId);
  assert.equal(flow.page.data.directoryInlineValue, "第一章 语音");
  flow.page.commitDirectoryInline({ detail: { value: "第一章 语音（改）" } });
  nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.find((node) => node.id === chapterId).title, "第一章 语音（改）");

  // 标题级别：三级 → 一级后，子目录层级同步重算
  flow.page.setData({ activeDirectory: topicId, actionMode: "directory" });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "level" } } });
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "1", kind: "setLevel" } } });
  nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.find((node) => node.id === topicId).level, 1);
  assert.equal(flow.page.data.actionMode, "");

  delete global.Page;
  delete global.wx;
});

test("pack collection card long-press actions add, move and delete cards", () => {
  const pack = {
    id: "pack-card-actions",
    name: "卡片操作题包",
    nodes: [
      { id: "dir-a", type: "directory", title: "甲目录", level: 1, parentId: "" },
      { id: "dir-b", type: "directory", title: "乙目录", level: 1, parentId: "" },
      { id: "card-a1", type: "card", directoryId: "dir-a", questionId: "" },
    ],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });

  // 长按选中一张卡片 → 深色操作栏
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "card-a1" } } });
  assert.equal(flow.page.data.actionMode, "cards");
  assert.deepEqual(flow.page.data.selectedCardIds, ["card-a1"]);
  assert.equal(flow.page.data.contextToolbarTop > 0, true);

  // 添加：同目录、紧跟在这张卡片后面
  flow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });
  let nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  const addedIndex = nodes.findIndex((node) => node.type === "card" && node.id !== "card-a1");
  assert.equal(addedIndex, nodes.findIndex((node) => node.id === "card-a1") + 1);
  assert.equal(nodes[addedIndex].directoryId, "dir-a");
  assert.equal(flow.page.data.actionMode, "");

  // 移动：深色菜单列出全部目录 → 移到乙目录
  const addedId = nodes[addedIndex].id;
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: addedId } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "move" } } });
  assert.equal(flow.page.data.contextMenuOpen, true);
  assert.deepEqual(flow.page.data.contextMenuItems.map((item) => item.key), ["", "dir-a", "dir-b"]);
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "dir-b", kind: "moveCard" } } });
  nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.find((node) => node.id === addedId).directoryId, "dir-b");

  // 删除：确认后从题包移除
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: addedId } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "delete" } } });
  nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.some((node) => node.id === addedId), false);

  // 取消：清掉选中态
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "card-a1" } } });
  flow.page.cancelSelect();
  assert.equal(flow.page.data.actionMode, "");
  assert.deepEqual(flow.page.data.selectedCardIds, []);

  delete global.Page;
  delete global.wx;
});

test("public collections refuse inline editing and long-press actions", () => {
  const pack = { id: "pack-public-readonly", name: "公共题包", questionIds: ["q-1"], questions: [] };
  const flow = createPage({ pack, source: "public" });
  flow.page.toggleAddMenu();
  flow.page.createDirectory();
  assert.equal(flow.modal().toast.title, "请先收藏到我的题包");
  assert.equal(flow.storage.get("shukao_private_packs").length, 0);
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "" } } });
  assert.equal(flow.page.data.actionMode, "");
  delete global.Page;
  delete global.wx;
});

test("orphan cards stay visible in the 未归档 group and cannot be renamed as a directory", () => {
  const pack = {
    id: "pack-loose",
    name: "未归档题包",
    nodes: [
      { id: "card-loose", type: "card", directoryId: "missing-dir", questionId: "" },
    ],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });
  assert.deepEqual(flow.page.data.sections.map((section) => section.title), ["未归档"]);
  assert.equal(flow.page.data.sections[0].cards.length, 1);
  flow.page.setData({ actionMode: "directory", activeDirectory: "__loose__" });
  flow.page.directoryAction({ currentTarget: { dataset: { action: "edit" } } });
  assert.equal(flow.modal().toast.title, "“未归档”是系统分组，不能改名或删除");
  delete global.Page;
  delete global.wx;
});

// ── 拖拽排序（DEC-052 / DEC-054 的题包版）──

const dragPack = {
  id: "pack-drag",
  name: "拖拽题包",
  questionIds: [],
  nodes: [
    { id: "dir-1", type: "directory", title: "第一章", level: 1, parentId: "" },
    { id: "dir-2", type: "directory", title: "第二章", level: 1, parentId: "" },
    { id: "c-1", type: "card", directoryId: "dir-1", questionId: "" },
    { id: "c-2", type: "card", directoryId: "dir-1", questionId: "" },
    { id: "c-3", type: "card", directoryId: "dir-1", questionId: "" },
    { id: "c-5", type: "card", directoryId: "dir-2", questionId: "" },
  ],
};

const dragCards = [
  { dataset: { nodeId: "c-1", section: "dir-1" }, left: 14, top: 100, right: 184, bottom: 260 },
  { dataset: { nodeId: "c-2", section: "dir-1" }, left: 190, top: 100, right: 361, bottom: 260 },
  { dataset: { nodeId: "c-3", section: "dir-1" }, left: 14, top: 276, right: 184, bottom: 436 },
  { dataset: { nodeId: "c-5", section: "dir-2" }, left: 14, top: 700, right: 184, bottom: 860 },
];

const dragTitles = [
  { dataset: { id: "dir-1" }, left: 14, top: 60, right: 361, bottom: 92 },
  { dataset: { id: "dir-2" }, left: 14, top: 660, right: 361, bottom: 692 },
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

function cardsOf(flow, directoryId) {
  return flow.storage.get("shukao_private_packs")[0].nodes
    .filter((node) => node.type === "card" && node.directoryId === directoryId)
    .map((node) => node.id);
}

test("dragging a card inside its directory reorders it and shows the column indicator", async () => {
  const flow = createPage({ pack: structuredClone(dragPack), source: "private" });
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });
  flow.page.setData({ contentLeft: 14, contentWidth: 347 });

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { nodeId: "c-3", section: "dir-1" } },
    touches: [{ clientX: 60, clientY: 400 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "c-3", id: "blank-c-3" } } });
  flow.page.handleCardTouchMove(touchEvent(60, 430));
  assert.equal(flow.page.data.dragActive, true);
  assert.equal(flow.page.data.dragKind, "card");
  assert.equal(flow.page.data.contextToolbarReady, false, "操作栏在拖拽中隐藏");

  flow.page.handleCardTouchMove(touchEvent(150, 200));
  await wait(30);
  assert.deepEqual(flow.page.data.dragIndicator, { kind: "column", left: 185, top: 100, width: 4, height: 160 });

  flow.page.handleDragTouchEnd();
  assert.equal(flow.page.data.dragActive, false);
  assert.equal(flow.page.data.dragIndicator, null);
  assert.deepEqual(cardsOf(flow, "dir-1"), ["c-1", "c-3", "c-2"]);
  assert.equal(flow.modal().toast.title, "已移动卡片");
  assert.equal(flow.page.data.actionMode, "", "结束拖拽后操作栏关闭");
  delete global.Page;
  delete global.wx;
});

test("dragging a card across directories moves it to the target directory", async () => {
  const flow = createPage({ pack: structuredClone(dragPack), source: "private" });
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { nodeId: "c-1", section: "dir-1" } },
    touches: [{ clientX: 60, clientY: 200 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "c-1", id: "blank-c-1" } } });
  flow.page.handleCardTouchMove(touchEvent(60, 230));
  flow.page.handleCardTouchMove(touchEvent(60, 800));
  await wait(30);
  assert.deepEqual(flow.page.data.dragIndicator, { kind: "row", left: 14, top: 694, width: 347, height: 4 });

  flow.page.handleDragTouchEnd();
  assert.deepEqual(cardsOf(flow, "dir-1"), ["c-2", "c-3"]);
  assert.deepEqual(cardsOf(flow, "dir-2"), ["c-1", "c-5"]);
  delete global.Page;
  delete global.wx;
});

test("dragging a directory title reorders it among siblings", async () => {
  const flow = createPage({ pack: structuredClone(dragPack), source: "private" });
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });

  flow.page.handleTitleTouchStart({
    currentTarget: { dataset: { id: "dir-2" } },
    touches: [{ clientX: 100, clientY: 676 }],
  });
  flow.page.openDirectoryActions({ currentTarget: { dataset: { id: "dir-2" } } });
  flow.page.handleTitleTouchMove(touchEvent(100, 650));
  assert.equal(flow.page.data.dragActive, true);
  assert.equal(flow.page.data.dragKind, "directory");

  flow.page.handleTitleTouchMove(touchEvent(100, 70));
  await wait(30);
  const nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  flow.page.handleDragTouchEnd();
  const ordered = flow.storage.get("shukao_private_packs")[0].nodes
    .filter((node) => node.type === "directory")
    .map((node) => node.id);
  assert.deepEqual(ordered, ["dir-2", "dir-1"]);
  assert.equal(flow.modal().toast.title, "目录顺序已更新");
  assert.equal(nodes.length, 6, "只调顺序，不增删节点");
  delete global.Page;
  delete global.wx;
});

test("dragging a directory into another directory's card area takes over those cards", async () => {
  const flow = createPage({ pack: structuredClone(dragPack), source: "private" });
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });

  flow.page.handleTitleTouchStart({
    currentTarget: { dataset: { id: "dir-2" } },
    touches: [{ clientX: 100, clientY: 676 }],
  });
  flow.page.openDirectoryActions({ currentTarget: { dataset: { id: "dir-2" } } });
  flow.page.handleTitleTouchMove(touchEvent(100, 650));
  flow.page.handleTitleTouchMove(touchEvent(60, 320));
  await wait(30);
  assert.equal(flow.page.data.dragIndicator.kind, "row");

  flow.page.handleDragTouchEnd();
  const nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.find((node) => node.id === "c-3").directoryId, "dir-2", "第三张起的卡片被接管");
  assert.deepEqual(cardsOf(flow, "dir-1"), ["c-1", "c-2"]);
  assert.deepEqual(cardsOf(flow, "dir-2"), ["c-3", "c-5"]);
  assert.deepEqual(nodes.filter((node) => node.type === "directory").map((node) => node.id), ["dir-1", "dir-2"]);
  assert.equal(flow.modal().toast.title, "已把 1 张卡片划到「第二章」");
  delete global.Page;
  delete global.wx;
});

test("dragging one of several selected cards shows the group badge and moves the whole group", async () => {
  const flow = createPage({ pack: structuredClone(dragPack), source: "private" });
  mockSelectorQuery({ cards: dragCards, titles: dragTitles });

  flow.page.handleCardTouchStart({
    currentTarget: { dataset: { nodeId: "c-1", section: "dir-1" } },
    touches: [{ clientX: 60, clientY: 300 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "c-1" } } });
  flow.page._longPressAt = 0;
  flow.page.openQuestion({ currentTarget: { dataset: { id: "blank-c-2", nodeId: "c-2" } } });
  assert.deepEqual(flow.page.data.selectedCardIds, ["c-1", "c-2"]);

  flow.page.handleCardTouchMove(touchEvent(60, 330));
  assert.equal(flow.page.data.dragActive, true);
  assert.equal(flow.page.data.dragGroupCount, 2, "多选拖拽时幽灵卡带 ×2 角标");

  flow.page.handleCardTouchMove(touchEvent(60, 800));
  await wait(30);
  flow.page.handleDragTouchEnd();
  assert.equal(flow.page.data.dragGroupCount, 0);
  assert.deepEqual(cardsOf(flow, "dir-1"), ["c-3"]);
  assert.deepEqual(cardsOf(flow, "dir-2"), ["c-1", "c-2", "c-5"]);
  assert.equal(flow.modal().toast.title, "已移动 2 张卡片");
  delete global.Page;
  delete global.wx;
});

test("selecting a card marks it for the blue frame and the footer no longer swallows the more drawer", () => {
  const pack = {
    id: "pack-select-frame",
    name: "选中框题包",
    nodes: [
      { id: "dir-1", type: "directory", title: "甲目录", level: 1, parentId: "" },
      { id: "card-a1", type: "card", directoryId: "dir-1", questionId: "" },
    ],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });

  const readCard = () => flow.page.data.sections[0].cards.find((item) => item.nodeId === "card-a1");
  assert.equal(readCard().selected, false);

  // 选中：卡片必须带 selected 标记，否则页面不会出现蓝色选中框
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "card-a1" } } });
  assert.equal(readCard().selected, true);
  assert.equal(flow.page.data.canEditSelected, true);

  // 取消：标记要跟着清掉，不能留下残影
  flow.page.cancelSelect();
  assert.equal(readCard().selected, false);
  assert.equal(flow.page.data.actionMode, "");

  // 底部「更多」：点开之后不能被页面的空白点击处理器立刻关掉
  flow.page.toggleMore();
  assert.equal(flow.page.data.moreOpen, true);
  flow.page.handleBlankTap();
  assert.equal(flow.page.data.moreOpen, true, "空白点击不再管更多抽屉");
  flow.page.closeMore();
  assert.equal(flow.page.data.moreOpen, false);

  const markup = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/pack-collection/pack-collection.wxml"), "utf8");
  assert.match(markup, /class="collection-footer" catchtap="noop"/);
  assert.match(markup, /class="more-drawer" catchtouchmove="stopTouchMove" catchtap="noop"/);
  assert.match(markup, /class="add-menu" catchtap="noop"/);

  delete global.Page;
  delete global.wx;
});

test("pack drawer carries style settings and pack management", () => {
  const pack = {
    id: "pack-drawer",
    name: "抽屉题包",
    nodes: [
      { id: "dir-1", type: "directory", title: "甲目录", level: 1, parentId: "" },
      { id: "card-a1", type: "card", directoryId: "dir-1", questionId: "" },
      { id: "card-a2", type: "card", directoryId: "dir-1", questionId: "" },
      { id: "card-a3", type: "card", directoryId: "dir-1", questionId: "" },
    ],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });

  // 样式设置 → 更换颜色：统一颜色写进本題包全部卡片
  flow.page.setData({ moreOpen: true });
  flow.page.openPackColorPanel();
  assert.equal(flow.page.data.colorPanelOpen, true);
  assert.equal(flow.page.data.moreOpen, false);
  assert.equal(flow.page.data.colorMode, "uniform");
  assert.equal(flow.page.data.packColorScopeLabel, "本題包的全部 3 张卡片");
  flow.page.applyUniformPackColor({ currentTarget: { dataset: { key: "mint" } } });
  let cards = flow.storage.get("shukao_private_packs")[0].nodes.filter((node) => node.type === "card");
  assert.deepEqual(cards.map((node) => node.color), ["mint", "mint", "mint"]);
  assert.equal(flow.modal().toast.title, "已更换颜色");

  // 彩虹色：按当前显示顺序依次套色板
  flow.page.selectColorMode({ currentTarget: { dataset: { mode: "rainbow" } } });
  assert.equal(flow.page.data.colorMode, "rainbow");
  flow.page.applyRainbowPackColor();
  cards = flow.storage.get("shukao_private_packs")[0].nodes.filter((node) => node.type === "card");
  assert.deepEqual(cards.map((node) => node.color), ["rose", "peach", "cream"]);
  assert.equal(flow.modal().toast.title, "已应用渐变色");

  // 无颜色：清空
  flow.page.applyUniformPackColor({ currentTarget: { dataset: { key: "" } } });
  cards = flow.storage.get("shukao_private_packs")[0].nodes.filter((node) => node.type === "card");
  assert.deepEqual(cards.map((node) => node.color), ["", "", ""]);

  // 题包管理：重命名
  global.wx.showModal = (options) => {
    if (options && options.success) options.success({ confirm: true, content: "改过名的题包" });
  };
  flow.page.renamePack();
  assert.equal(flow.storage.get("shukao_private_packs")[0].name, "改过名的题包");
  assert.equal(flow.modal === undefined, false);

  // 题包管理：移动到分类（走深色菜单，不再用系统 ActionSheet）
  flow.page.openPackCategoryMenu();
  assert.equal(flow.page.data.contextMenuOpen, true);
  assert.equal(flow.page.data.contextMenuTitle, "移动到分类");
  assert.deepEqual(flow.page.data.contextMenuItems.map((item) => item.key), [""]);
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "", kind: "movePackCategory" } } });
  assert.equal(flow.storage.get("shukao_private_packs")[0].categoryId, "");

  // 题包管理：删除（确认后移除并返回上一页）
  flow.page.deletePack();
  assert.equal(flow.storage.get("shukao_private_packs").length, 0);
  assert.equal(flow.navigation().back, true);

  delete global.Page;
  delete global.wx;
});

test("pack drawer markup renders the three sections and the colour panel", () => {
  const pageDir = path.resolve(__dirname, "../apps/miniprogram/pages/pack-collection");
  const markup = fs.readFileSync(path.join(pageDir, "pack-collection.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "pack-collection.wxss"), "utf8");

  assert.match(markup, /class="drawer-section-title">题包操作</);
  assert.match(markup, /class="drawer-section-title">样式设置</);
  assert.match(markup, /class="drawer-section-title">题包管理</);
  assert.match(markup, /class="drawer-item" bindtap="openPackColorPanel"/);
  assert.match(markup, /data-key="rename" bindtap="packManageAction"/);
  assert.match(markup, /data-key="category" bindtap="packManageAction"/);
  assert.match(markup, /data-key="delete" bindtap="packManageAction"/);
  assert.match(markup, /class="color-layer" wx:if="\{\{colorPanelOpen\}\}"/);
  assert.match(markup, /data-mode="rainbow" bindtap="selectColorMode"/);
  assert.match(markup, /bindtap="applyRainbowPackColor"/);
  assert.match(styles, /\.drawer-section-title \{[^}]*color: #a79d8e/);
  assert.match(styles, /\.color-panel \{[^}]*border-radius: 28rpx 28rpx 0 0/);
  assert.match(styles, /\.color-mode-active \{[^}]*border-color: #e8cfa4/);
});

test("the 标题级别 badge follows the selected directory level on the pack page too", () => {
  const pack = {
    id: "pack-level",
    name: "级别题包",
    nodes: [
      { id: "dir-1", type: "directory", title: "第一章", level: 1, parentId: "" },
      { id: "dir-2", type: "directory", title: "第一节", level: 2, parentId: "dir-1" },
      { id: "card-1", type: "card", directoryId: "dir-2", questionId: "" },
    ],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });
  flow.page.openDirectoryActions({ currentTarget: { dataset: { id: "dir-2" } } });
  assert.equal(flow.page.data.actionMode, "directory");
  assert.equal(flow.page.data.activeDirectoryLevel, 2, "二级目录显示 H2");
  flow.page.openDirectoryActions({ currentTarget: { dataset: { id: "dir-1" } } });
  assert.equal(flow.page.data.activeDirectoryLevel, 1, "一级目录显示 H1");

  const markup = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/pack-collection/pack-collection.wxml"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/pack-collection/pack-collection.wxss"), "utf8");
  assert.match(markup, /data-action="level" bindtap="directoryAction"><text class="toolbar-level-mark">H\{\{activeDirectoryLevel\}\}<\/text>/);
  assert.doesNotMatch(markup, /pack-heading\.svg/);
  assert.match(styles, /\.context-toolbar \.toolbar-level-mark \{[^}]*font-size: 22rpx/);
});

// DEC-087：一个目录先渲染它的子目录，再渲染它自己的卡片（文件夹在前、文件在后）。
// 这样"插入子目录"后，新目录就紧跟在父目录标题下方，而不是排在父目录卡片之后。
test("a directory renders its subdirectories before its own cards", () => {
  const pack = {
    id: "pack-order",
    name: "顺序题包",
    nodes: [
      { id: "d-1", type: "directory", title: "甲", level: 1, parentId: "" },
      { id: "c-1", type: "card", directoryId: "d-1", questionId: "" },
      { id: "d-2", type: "directory", title: "甲一", level: 2, parentId: "d-1" },
      { id: "c-2", type: "card", directoryId: "d-2", questionId: "" },
      { id: "d-3", type: "directory", title: "乙", level: 1, parentId: "" },
    ],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });
  assert.deepEqual(
    flow.page.data.sectionBlocks.map((block) => `${block.kind}:${block.section.title}`),
    // 没有卡片的目录不产出卡片块（DEC-089），所以「乙」只有标题块
    ["title:甲", "title:甲一", "cards:甲一", "cards:甲", "title:乙"],
  );

  // 新插入的子目录紧跟在父目录标题下方（排在父目录自己的卡片之前）
  flow.page.setData({ activeDirectory: "d-1" });
  flow.page.createChildDirectory();
  const created = flow.page.data.sectionBlocks.map((block) => `${block.kind}:${block.section.title}`);
  // 新目录没有卡片 → 只有标题块；它紧跟父目录标题之后、排在父目录卡片之前
  assert.deepEqual(created.slice(0, 4), ["title:甲", "title:未命名目录", "title:甲一", "cards:甲一"]);
});

test("pack markup carries the drag surfaces and touch handlers", () => {
  const pageDir = path.resolve(__dirname, "../apps/miniprogram/pages/pack-collection");
  const markup = fs.readFileSync(path.join(pageDir, "pack-collection.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "pack-collection.wxss"), "utf8");
  assert.match(markup, /<page-meta page-style="\{\{pageScrollLocked \? 'overflow: hidden;' : ''\}\}" \/>/);
  assert.match(markup, /bindtouchstart="handleCardTouchStart"[\s\S]{0,120}bindtouchmove="handleCardTouchMove"/);
  assert.match(markup, /bindtouchstart="handleTitleTouchStart"[\s\S]{0,120}bindtouchmove="handleTitleTouchMove"/);
  assert.match(markup, /class="drag-ghost drag-ghost-card"/);
  assert.match(markup, /class="drag-ghost drag-ghost-title"/);
  assert.match(markup, /class="drag-indicator" style="left: \{\{dragIndicator\.left\}\}px;/);
  assert.match(styles, /\.study-card-drag-origin \{[^}]*opacity: \.4/);
  assert.match(styles, /\.drag-indicator \{ position: fixed; z-index: 1;/);
  assert.match(styles, /\.study-card \{ position: relative; z-index: 2;/);
});

test("pack cards support multi-select and group move/delete", () => {
  const pack = {
    id: "pack-multi",
    name: "多选题包",
    nodes: [
      { id: "dir-1", type: "directory", title: "甲目录", level: 1, parentId: "" },
      { id: "dir-2", type: "directory", title: "乙目录", level: 1, parentId: "" },
      { id: "card-a1", type: "card", directoryId: "dir-1", questionId: "" },
      { id: "card-a2", type: "card", directoryId: "dir-1", questionId: "" },
      { id: "card-a3", type: "card", directoryId: "dir-1", questionId: "" },
    ],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });

  // 长按选中第一张 → 再点第二张加选（编辑/添加在多选时不可用）
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "card-a1" } } });
  assert.equal(flow.page.data.canEditSelected, true);
  flow.page._longPressAt = 0;
  flow.page.openQuestion({ currentTarget: { dataset: { id: "blank-card-a2", nodeId: "card-a2" } } });
  assert.deepEqual(flow.page.data.selectedCardIds, ["card-a1", "card-a2"]);
  assert.equal(flow.page.data.canEditSelected, false);  flow.page.selectionAction({ currentTarget: { dataset: { action: "edit" } } });
  assert.equal(flow.modal().toast.title, "一次只能编辑或添加一张");
  flow.page.selectionAction({ currentTarget: { dataset: { action: "add" } } });
  assert.equal(flow.modal().toast.title, "一次只能编辑或添加一张");

  // 再点一次取消该张；取消到空则退出选中模式
  flow.page._longPressAt = 0;
  flow.page.openQuestion({ currentTarget: { dataset: { id: "blank-card-a2", nodeId: "card-a2" } } });
  assert.deepEqual(flow.page.data.selectedCardIds, ["card-a1"]);
  flow.page._longPressAt = 0;
  flow.page.openQuestion({ currentTarget: { dataset: { id: "blank-card-a1", nodeId: "card-a1" } } });
  assert.equal(flow.page.data.actionMode, "");

  // 整组移动：两张一起进乙目录
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "card-a1" } } });
  flow.page._longPressAt = 0;
  flow.page.openQuestion({ currentTarget: { dataset: { id: "blank-card-a2", nodeId: "card-a2" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "move" } } });
  assert.equal(flow.page.data.contextMenuTitle, "移动 2 张卡片");
  flow.page.selectContextMenuOption({ currentTarget: { dataset: { key: "dir-2", kind: "moveCard" } } });
  assert.deepEqual(cardsOf(flow, "dir-1"), ["card-a3"]);
  assert.deepEqual(cardsOf(flow, "dir-2"), ["card-a1", "card-a2"]);
  assert.equal(flow.modal().toast.title, "已移动 2 张卡片");

  // 整组删除：一次确认删掉两张
  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "card-a1" } } });
  flow.page._longPressAt = 0;
  flow.page.openQuestion({ currentTarget: { dataset: { id: "blank-card-a2", nodeId: "card-a2" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "delete" } } });
  assert.equal(flow.storage.get("shukao_private_packs")[0].nodes.some((node) => node.id === "card-a1"), false);
  assert.equal(flow.storage.get("shukao_private_packs")[0].nodes.some((node) => node.id === "card-a2"), false);
  assert.deepEqual(cardsOf(flow, "dir-1"), ["card-a3"]);

  delete global.Page;
  delete global.wx;
});

test("pack cards can be tinted from the dark palette and cleared back to no color", () => {
  const pack = {
    id: "pack-color",
    name: "上色题包",
    nodes: [
      { id: "dir-1", type: "directory", title: "甲目录", level: 1, parentId: "" },
      { id: "card-a1", type: "card", directoryId: "dir-1", questionId: "" },
      { id: "card-a2", type: "card", directoryId: "dir-1", questionId: "" },
    ],
    questionIds: [],
  };
  const flow = createPage({ pack, source: "private" });
  assert.equal(flow.page.data.cardColors.length, 9, "复用知识卡色板");

  flow.page.startSelect({ currentTarget: { dataset: { nodeId: "card-a1" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "color" } } });
  assert.equal(flow.page.data.cardColorPickerOpen, true);
  assert.equal(flow.page.data.cardColorPickerTop > 0, true);

  flow.page.selectCardColor({ currentTarget: { dataset: { key: "mint" } } });
  let nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.find((node) => node.id === "card-a1").color, "mint");
  let card = flow.page.data.sections[0].cards.find((item) => item.nodeId === "card-a1");
  assert.equal(card.color, "mint");
  assert.match(card.colorSoft, /linear-gradient/);
  assert.match(card.colorEdge, /rgba\(/);
  assert.equal(flow.page.data.cardColorPickerOpen, true, "选完颜色先不关面板，方便连着试");

  // 多选后一次给两张上色
  flow.page._longPressAt = 0;
  flow.page.openQuestion({ currentTarget: { dataset: { id: "blank-card-a2", nodeId: "card-a2" } } });
  flow.page.selectionAction({ currentTarget: { dataset: { action: "color" } } });
  flow.page.selectCardColor({ currentTarget: { dataset: { key: "sky" } } });
  nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.find((node) => node.id === "card-a1").color, "sky");
  assert.equal(nodes.find((node) => node.id === "card-a2").color, "sky");

  // 无颜色：清空
  flow.page.selectCardColor({ currentTarget: { dataset: { key: "" } } });
  nodes = flow.storage.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.find((node) => node.id === "card-a1").color, "");
  card = flow.page.data.sections[0].cards.find((item) => item.nodeId === "card-a1");
  assert.equal(card.colorSoft, "");

  flow.page.handleBlankTap();
  assert.equal(flow.page.data.cardColorPickerOpen, false);
  assert.equal(flow.page.data.actionMode, "");

  delete global.Page;
  delete global.wx;
});

test("private collection add menu creates empty directories and cards while public collections stay read-only", () => {
  const pack = {
    id: "pack-add-actions",
    name: "可编辑题包",
    nodes: [],
    questionIds: [],
  };
  const privateFlow = createPage({ pack, source: "private" });

  privateFlow.page.toggleAddMenu();
  assert.equal(privateFlow.page.data.addMenuOpen, true);
  privateFlow.page.createDirectory();
  let savedPack = privateFlow.storage.get("shukao_private_packs")[0];
  assert.equal(savedPack.nodes.length, 1);
  assert.equal(savedPack.nodes[0].type, "directory");
  assert.equal(privateFlow.page.data.addMenuOpen, false);

  privateFlow.page.toggleAddMenu();
  privateFlow.page.createCard();
  savedPack = privateFlow.storage.get("shukao_private_packs")[0];
  assert.equal(savedPack.nodes.length, 2);
  assert.equal(savedPack.nodes[1].type, "card");
  assert.equal(savedPack.nodes[1].directoryId, savedPack.nodes[0].id);
  assert.equal(privateFlow.page.data.rows.length, 1);
  assert.equal(privateFlow.page.data.rows[0].isBlank, true);
  privateFlow.page.openQuestion({ currentTarget: { dataset: { id: privateFlow.page.data.rows[0].id } } });
  assert.match(privateFlow.navigation().url, /pages\/contribute\/contribute\?packId=pack-add-actions/);
  assert.match(privateFlow.navigation().url, /cardId=/);

  const publicFlow = createPage({ pack: { ...pack, id: "public-add-actions" }, source: "public" });
  publicFlow.page.toggleAddMenu();
  publicFlow.page.createDirectory();
  assert.equal(publicFlow.storage.get("shukao_private_packs").length, 0);
  assert.equal(publicFlow.modal().toast.title, "请先收藏到我的题包");
});

test("public collections keep nested directory paths, source numbers and short previews", () => {
  const modulePath = require.resolve("../apps/miniprogram/pages/pack-collection/pack-collection.js");
  const { buildCollection } = require(modulePath);
  const pack = {
    id: "public-nested-pack",
    name: "嵌套目录题包",
    questionIds: ["demo-modern-chinese-001", "missing-question"],
    nodes: [
      { id: "chapter-1", type: "directory", title: "第一章", level: 1, parentId: "" },
      { id: "section-1", type: "directory", title: "第一节", level: 2, parentId: "chapter-1" },
      { id: "card-1", type: "card", directoryId: "section-1", questionId: "demo-modern-chinese-001" },
      { id: "card-2", type: "card", directoryId: "section-1", questionId: "missing-question" },
    ],
    // An API response with this field is authoritative, so the missing ID must
    // remain a deleted placeholder even when a local question cache exists.
    questions: [],
  };
  const collection = buildCollection(pack, "public");
  assert.equal(collection.rows.length, 2);
  assert.equal(collection.rows[0].available, false);
  assert.equal(collection.rows[1].available, false);
  assert.deepEqual(collection.rows[0].path, ["第一章", "第一节"]);
  assert.equal(collection.sections[0].title, "第一章");
  assert.equal(collection.sections[0].count, 2);
  assert.equal(collection.sections[1].count, 2);
  assert.equal(collection.sections[0].hasItems, false);
  assert.equal(collection.sections[1].hasItems, true);

  const legacyPack = {
    id: "legacy-public-pack",
    questionIds: ["demo-modern-chinese-001"],
  };
  const legacyCollection = buildCollection(legacyPack, "public");
  assert.equal(legacyCollection.rows[0].available, true);
  assert.equal(legacyCollection.rows[0].stemPreview.endsWith("…"), true);
  assert.equal(legacyCollection.rows[0].displayNumber, "1");

  const splitPathCollection = buildCollection({
    id: "split-path-pack",
    questionIds: ["split-path-question"],
    questions: [{
      id: "split-path-question",
      stem: "分开的章节字段也应合并",
      chapterTitle: "第二章",
      sectionTitle: "第二节",
      type: "short_answer",
    }],
  }, "public");
  assert.deepEqual(splitPathCollection.rows[0].path, ["第二章", "第二节"]);

  const featuredSeedCollection = buildCollection({
    id: "pack-featured-001",
    status: "featured",
    creatorType: "team",
    questionIds: ["demo-modern-chinese-001"],
    questions: [],
  }, "public");
  assert.equal(featuredSeedCollection.rows[0].available, true);
});

test("a missing pending question resolves from the first available item", () => {
  const pack = {
    id: "pack-missing-pending",
    name: "缓存过期题包",
    questionIds: ["q-1", "q-2"],
  };
  const flow = createPage({
    pack,
    assets: [
      { id: "q-1", type: "question", stem: "第一道可用题", questionType: "简答题" },
      { id: "q-2", type: "question", stem: "第二道可用题", questionType: "简答题" },
    ],
  });
  flow.page.pendingQuestionId = "question-no-longer-in-pack";
  flow.page.resolvePendingQuestion();
  assert.match(flow.navigation().url, /questionId=q-1/);
});

test("a public pack does not resurrect a locally cached question that the server omitted", () => {
  const pack = {
    id: "public-authoritative-pack",
    name: "服务端权威题包",
    questionIds: ["q-local"],
    questions: [],
  };
  const flow = createPage({
    pack,
    source: "public",
    assets: [{ id: "q-local", type: "question", stem: "本地旧题", questionType: "简答题" }],
  });
  flow.page.applyCollection(pack, "public");
  assert.equal(flow.page.data.rows[0].available, false);
  assert.equal(flow.page.data.rows[0].stem, "题目已被作者删除");
});

test("a public pack can be collected into a private pack without starting practice", () => {
  const pack = {
    id: "public-collectable-pack",
    name: "可收藏题包",
    description: "收藏后再从我的题包使用",
    tags: ["现代汉语"],
    questionIds: ["q-collect"],
    questions: [{
      id: "q-collect",
      stem: "收藏题包中的题目",
      type: "short_answer",
      typeLabel: "简答题",
      referenceAnswer: "参考答案",
      sourceLabel: "教材",
    }],
  };
  const flow = createPage({ pack, source: "public" });
  flow.page.applyCollection(pack, "public");
  flow.page.collectPack();
  const savedPacks = flow.storage.get("shukao_private_packs");
  assert.equal(savedPacks.length, 1);
  assert.equal(savedPacks[0].sourcePackId, pack.id);
  assert.equal(flow.page.data.pack.collected, true);
  assert.equal(flow.navigation(), null);
});
