const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EXAM_CATEGORIES,
  createSearchRecords,
  filterLibraryExams,
  filterSearchRecords,
} = require("../apps/miniprogram/utils/library-content");

function createPage(definition) {
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

test("library content search filters every asset type and highlights keywords", () => {
  const records = createSearchRecords({
    questions: [{ id: "q1", stem: "辨析现代汉语共同语", knowledgePoint: "共同语", subjectName: "现代汉语" }],
    privatePacks: [{ id: "private-1", name: "语音错题", questionIds: ["q1"], tags: ["现代汉语"] }],
    publicPacks: [{ id: "public-1", name: "语法精选", questionIds: ["q1"], creatorType: "team" }],
    exams: [{ id: "exam-1", title: "2025 真题", kind: "past_paper", questionCount: 1, totalScore: 2 }],
    materials: [{ id: "material-1", title: "考试大纲", kindLabel: "考纲" }],
  });

  assert.deepEqual(new Set(records.map((item) => item.scope)), new Set(["question", "pack", "exam", "material"]));
  const results = filterSearchRecords(records, { query: "现代汉语", scope: "question" });
  assert.equal(results.length, 1);
  assert.equal(results[0].titleParts.some((part) => part.match && part.text === "现代汉语"), true);
});

test("library exams are separated into past, mock and imported categories", () => {
  const exams = [
    { id: "past-1", title: "2025 真题", kind: "past_paper", origin: "manual" },
    { id: "mock-1", title: "模拟卷一", kind: "official_mock", origin: "manual" },
    { id: "import-1", title: "PDF 导入真题", kind: "past_paper", origin: "imported" },
  ];
  assert.deepEqual(EXAM_CATEGORIES.map((item) => item.name), ["历年真题", "模拟试卷", "导入试卷"]);
  assert.deepEqual(filterLibraryExams(exams, "past").map((item) => item.id), ["past-1"]);
  assert.deepEqual(filterLibraryExams(exams, "mock").map((item) => item.id), ["mock-1"]);
  assert.deepEqual(filterLibraryExams(exams, "imported").map((item) => item.id), ["import-1"]);
});

test("library tabs load public packs, published exams and materials from real endpoints", () => {
  let definition;
  let navigatedUrl = "";
  let modalTitle = "";
  const storage = new Map([
    ["shukao_assets_migrated_v1", true],
    ["shukao_user_assets", [{ id: "note-1", type: "note", title: "我的语法笔记", content: "语法整理", updatedAt: Date.now() }]],
  ]);
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://library.test" } });
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    request(options) {
      if (options.url.endsWith("/api/packs")) options.success({ statusCode: 200, data: { packs: [{ id: "pack-1", name: "平台题包", creatorType: "team", questionIds: ["q1"] }] } });
      if (options.url.endsWith("/api/exams")) options.success({ statusCode: 200, data: { exams: [
        { id: "exam-1", title: "真题", kind: "past_paper", questionCount: 1 },
        { id: "exam-2", title: "模拟卷", kind: "official_mock", questionCount: 2 },
        { id: "exam-3", title: "导入卷", kind: "past_paper", origin: "imported", questionCount: 3 },
      ] } });
      if (options.url.endsWith("/api/discovery")) options.success({ statusCode: 200, data: { products: [{ id: "material-1", kind: "material", title: "考试大纲" }] } });
    },
    navigateTo({ url }) { navigatedUrl = url; },
    showModal(options) { modalTitle = (options && options.title) || ""; if (options && options.success) options.success({ confirm: false, content: "" }); },
    showToast() {},
  };
  const file = require.resolve("../apps/miniprogram/pages/library/library.js");
  delete require.cache[file];
  require(file);
  const page = createPage(definition);
  page.loadLibraryContent();

  assert.deepEqual(page.data.visiblePublicPacks.map((item) => item.id), ["pack-1"]);
  assert.deepEqual(page.data.exams.map((item) => item.id), ["exam-1", "exam-2", "exam-3"]);
  assert.deepEqual(page.data.visibleExams.map((item) => item.id), ["exam-1", "exam-2", "exam-3"]);
  page.selectExamCategory({ currentTarget: { dataset: { id: "imported" } } });
  assert.equal(page.data.activeExamCategoryName, "导入试卷");
  assert.deepEqual(page.data.visibleExams.map((item) => item.id), ["exam-3"]);
  assert.equal(page.data.drawerOpen, false);
  assert.deepEqual(page.data.materials.map((item) => item.id), ["material-1"]);
  page.selectContentTab({ currentTarget: { dataset: { id: "exams" } } });
  page.openLibrarySearch();
  assert.equal(navigatedUrl, "/pages/library-search/library-search?scope=exam");

  page.selectContentTab({ currentTarget: { dataset: { id: "packs" } } });
  assert.equal(page.data.activeSource, "official");
  // 2026-09-23 04:Cx：悬浮「＋」不再展开菜单（原来菜单里有「录入题目 / 新建题包」两项），
  // 现在直接执行本 tab 的唯一动作——题包 tab＝新建题包。
  assert.equal(page.toggleActionMenu, undefined, "展开菜单的 handler 应已删除");
  assert.equal(page.contributeQuestionFromLibrary, undefined, "「录入题目」入口已随菜单撤掉");
  assert.equal(page.data.actionMenuOpen, undefined, "actionMenuOpen 这份状态应已删除");
  page.createFromLibraryFab();
  assert.equal(modalTitle, "新建题包");

  page.selectQuickSource({ currentTarget: { dataset: { id: "private" } } });
  assert.equal(page.data.activeSourceLabel, "我的");
  assert.equal(storage.get("shukao_library_source_packs"), "private");

  page.selectContentTab({ currentTarget: { dataset: { id: "materials" } } });
  assert.equal(page.data.activeSource, "official");
  assert.deepEqual(page.data.materials.map((item) => item.id), ["material-1"]);
  page.selectQuickSource({ currentTarget: { dataset: { id: "private" } } });
  page.refreshOwnedMaterials();
  assert.deepEqual(page.data.ownedMaterials.map((item) => item.id), ["note-1"]);
  page.openOwnedMaterial({ currentTarget: { dataset: { id: "note-1" } } });
  assert.equal(navigatedUrl, "/pages/note-editor/note-editor?noteId=note-1");
  page.createFromLibraryFab();
  assert.equal(navigatedUrl, "/pages/note-editor/note-editor");

  page.selectContentTab({ currentTarget: { dataset: { id: "books" } } });
  assert.equal(page.data.activeSource, "official");
  page.selectContentTab({ currentTarget: { dataset: { id: "packs" } } });
  assert.equal(page.data.activeSource, "private");

  storage.set("shukao_library_source_books", "public");
  const restoredPage = createPage(definition);
  restoredPage.restoreSourcePreferences();
  assert.equal(restoredPage.data.activeSource, "public");
  assert.equal(restoredPage.data.sourceByTab.packs, "private");
  assert.equal(restoredPage.data.sourceByTab.materials, "private");

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("library exam loading falls back to another API address and exposes a real failure state", () => {
  let definition;
  const attempts = [];
  const app = {
    globalData: { apiBaseUrl: "http://primary.test" },
    apiBaseUrlCandidates: () => ["http://primary.test", "http://backup.test"],
  };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: () => "",
    setStorageSync() {},
    request(options) {
      attempts.push(options.url);
      if (options.url.startsWith("http://primary.test")) { options.fail({ errMsg: "network error" }); return; }
      if (options.url.endsWith("/api/exams")) {
        options.success({ statusCode: 200, data: { exams: [{ id: "exam-backup", title: "2025 真题", kind: "past_paper", questionCount: 57 }] } });
        return;
      }
      if (options.url.endsWith("/api/packs")) options.success({ statusCode: 200, data: { packs: [] } });
      if (options.url.endsWith("/api/discovery")) options.success({ statusCode: 200, data: { products: [] } });
    },
  };
  const file = require.resolve("../apps/miniprogram/pages/library/library.js");
  delete require.cache[file];
  require(file);
  const page = createPage(definition);
  page.loadLibraryContent();
  assert.ok(attempts.includes("http://backup.test/api/exams"));
  assert.equal(app.globalData.apiBaseUrl, "http://backup.test");
  assert.deepEqual(page.data.visibleExams.map((exam) => exam.id), ["exam-backup"]);
  assert.equal(page.data.examLoading, false);
  assert.equal(page.data.examLoadFailed, false);

  global.wx.request = (options) => options.fail({ errMsg: "network error" });
  const failedPage = createPage(definition);
  failedPage.loadLibraryContent();
  assert.equal(failedPage.data.examLoading, false);
  assert.equal(failedPage.data.examLoadFailed, true);

  const markup = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/library/library.wxml"), "utf8");
  assert.match(markup, /试卷加载失败，点击重试/);
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("published papers live in the library while the group page only exposes builders", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram/pages");
  const library = fs.readFileSync(path.join(root, "library/library.wxml"), "utf8");
  const libraryLogic = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/utils/library-content.js"), "utf8");
  const builder = fs.readFileSync(path.join(root, "exams/exams.wxml"), "utf8");
  assert.match(library, /content-tabs/);
  assert.match(library, /来源：\{\{item\.sourceLabel\}\}/);
  assert.match(library, /\{\{item\.summary\}\}/);
  assert.match(libraryLogic, /label: "题库"/);
  assert.match(libraryLogic, /label: "题包"/);
  assert.match(libraryLogic, /label: "试卷"/);
  assert.match(libraryLogic, /label: "资料"/);
  assert.match(builder, /自定义组卷/);
  assert.match(builder, /规则组卷/);
  assert.doesNotMatch(builder, /class="exam-list"|class="exam-band"/);
});

test("library exposes a separate compact source switcher and source-aware materials", () => {
  const library = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/library/library.wxml"), "utf8");
  const logic = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/library/library.js"), "utf8");

  assert.match(library, /class="nav-source-trigger/);
  assert.match(library, /class="source-menu"/);
  assert.doesNotMatch(library, /class="project-chevron"/);
  assert.match(library, /<text>平台资料<\/text>/);
  assert.match(library, /<text>我的资料<\/text>/);
  assert.match(library, /<text>共创资料<\/text>/);
  assert.doesNotMatch(library, /drawer-source-picker/);
  assert.match(logic, /label: "平台"/);
  assert.match(logic, /label: "我的"/);
  assert.match(logic, /label: "共创"/);
  assert.doesNotMatch(logic, /activeContentTab === "packs" && privateSource/);
});
