const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { applyDataPatch } = require("./helpers/set-data");
const { demoQuestions } = require("../apps/miniprogram/data/catalog");

const WXML = path.join(__dirname, "../apps/miniprogram/pages/practice/practice.wxml");
// 被移出视图模型、但视图层其实从不读的字段：wxml 里出现任何一处都说明瘦身会弄坏绑定。
const DROPPED_VIEW_FIELDS = ["questionIds", "catalogNodeId", "parentId", "startPage", "endPage"];

// C17（性能修复 F1–F4）的页面级契约测试：把"视图层拿到多少字节"钉住。
// 2026-09-23 实测（真实题库 1249 题 / 9 册目录，暖缓存）：一次翻页 setData 9954.8KB，
// 其中题目队列 9683.4KB、目录树 131.5KB；打开一次目录抽屉 131.5KB；点一次科目行到题目列表 1125.5KB。
// 这里的合成题库把每道题的参考答案撑到真实量级，用负载字节做回归门禁（< 真机渲染成本不可在本机测）。
const BOOK_ID = "modern-chinese-7-1";

const catalogFixture = {
  bookId: BOOK_ID,
  version: 3,
  nodes: [
    { id: "introduction", order: 1, level: 1, title: "绪论", startPage: 1, endPage: 10, parentId: "" },
    { id: "introduction-common-language", order: 2, level: 2, title: "现代汉民族共同语", startPage: 1, endPage: 10, parentId: "introduction" },
    { id: "phonetics", order: 3, level: 1, title: "第一章 语音", startPage: 11, endPage: 40, parentId: "" },
    { id: "phonetics-tone", order: 4, level: 2, title: "第四节 声调", startPage: 11, endPage: 20, parentId: "phonetics" },
    { id: "phonetics-consonants", order: 5, level: 2, title: "第二节 辅音和声母", startPage: 21, endPage: 30, parentId: "phonetics" },
    { id: "phonetics-syllable", order: 6, level: 2, title: "第五节 音节", startPage: 31, endPage: 40, parentId: "phonetics" },
    { id: "characters", order: 7, level: 1, title: "第二章 文字", startPage: 41, endPage: 60, parentId: "" },
    { id: "characters-form", order: 8, level: 2, title: "第一节 汉字的形体", startPage: 41, endPage: 50, parentId: "characters" },
    { id: "characters-structure", order: 9, level: 2, title: "第二节 汉字的结构", startPage: 51, endPage: 60, parentId: "characters" },
  ],
};

function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

// 合成题库：每道题的参考答案约 700 个汉字（≈2.1KB）、6 个得分点，贴近真实接口"一道题≈3.9KB"。
function buildFatBank(count) {
  return Array.from({ length: count }, (_, index) => {
    const source = demoQuestions[index % demoQuestions.length];
    return {
      ...structuredClone(source),
      id: `fat-${String(index + 1).padStart(3, "0")}`,
      bookId: BOOK_ID,
      referenceAnswer: "参考答案要点。".repeat(100),
      scoringPoints: Array.from({ length: 6 }, (_, pointIndex) => ({
        description: `得分点${pointIndex + 1}：${"要点说明".repeat(6)}`,
        score: 2,
      })),
    };
  });
}

// 每个用例自带 wx/App 桩：页面在 onLoad 时注册题库同步回调，回调到达后才建会话（复刻真实时序）。

test("C17/F1：题目队列在视图层只保留 id 序列，翻页不再重传整条队列", () => {
  const bank = buildFatBank(60);
  let definition;
  let questionSync = null;
  const store = new Map();
  const app = {
    globalData: { beans: 2 },
    syncOfficialQuestions(callback) { questionSync = callback; },
  };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    showToast() {},
    navigateBack() {},
  };

  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const records = [];
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    records.push({ keys: Object.keys(patch), bytes: bytesOf(patch), patch });
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({});
  questionSync(bank, { source: "cache" });
  assert.equal(page.data.practiceReady, true);
  assert.equal(page._questionQueue.length, bank.length);

  const fullBytes = bytesOf(page._questionQueue);
  const lightBytes = bytesOf(page.data.questionQueue);
  assert.equal(page.data.questionQueue.length, bank.length, "视图层队列长度必须与真实队列一致（wxml 读 .length）");
  assert.deepEqual(Object.keys(page.data.questionQueue[0]), ["id"], "视图层每个元素只应带 id");
  assert.ok(fullBytes > 20 * lightBytes, `完整队列 ${fullBytes} 字节 vs 视图层 ${lightBytes} 字节`);
  assert.equal(JSON.stringify(page.data.questionQueue).includes("referenceAnswer"), false);

  // 翻页：只发当前这一道题（+ 视图状态），不再带整条队列。
  records.length = 0;
  page.loadQuestion(1);
  const turn = records.find((record) => record.keys.includes("question"));
  assert.ok(turn, "翻页必须至少更新 question");
  assert.equal(turn.keys.includes("questionQueue"), false, "翻页不该再发题目队列");
  assert.ok(turn.bytes * 5 < fullBytes, `翻页负载 ${turn.bytes} 字节应远小于整条队列 ${fullBytes} 字节`);
  assert.equal(page.data.question.id, bank[1].id);
  assert.equal(typeof page.data.question.referenceAnswer, "string", "当前题在视图层仍是完整题目");

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("C17/F2：目录树视图不含投影锚点，展开只发改动的那一行", () => {
  global.Page = undefined;
  const bank = buildFatBank(12);
  let definition;
  let questionSync = null;
  const store = new Map();
  store.set(`shukao_confirmed_catalog_${BOOK_ID}`, structuredClone(catalogFixture));
  const app = { globalData: { beans: 2 }, syncOfficialQuestions(callback) { questionSync = callback; } };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    showToast() {},
    navigateBack() {},
  };
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const records = [];
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    records.push({ keys: Object.keys(patch), bytes: bytesOf(patch), patch });
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({});
  questionSync(bank, { source: "cache" });

  assert.ok(page._catalogChapters.length > 0, "缓存目录应构成本册目录树");
  assert.equal(page.data.catalogChapters.length, page._catalogChapters.length);
  assert.equal(Object.prototype.hasOwnProperty.call(page.data.catalogChapters[0], "questionIds"), false);
  assert.equal(Array.isArray(page._catalogChapters[0].questionIds), true);
  const viewTreeBytes = bytesOf(page.data.catalogChapters);

  // 契约：wxml 里真正读到的字段必须都在视图模型里；被删掉的那些一处都不能再读。
  const markup = fs.readFileSync(WXML, "utf8");
  DROPPED_VIEW_FIELDS.forEach((field) => {
    assert.equal(new RegExp(`\\b${field}\\b`).test(markup), false, `视图模型已不携带 ${field}，wxml 不得再读它`);
  });
  assert.deepEqual(
    [...new Set([...markup.matchAll(/questionQueue\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))],
    ["length"],
    "视图层对 questionQueue 只应读 .length",
  );
  const regionStart = markup.indexOf('wx:for="{{catalogChapters}}"');
  const regionEnd = markup.indexOf('wx:for="{{catalogSummaryQuestions}}"');
  assert.ok(regionStart > 0 && regionEnd > regionStart, "wxml 里应能找到目录树区域与题目列表区域");
  const chapterRow = page.data.catalogChapters.find((item) => (item.sections || []).length) || page.data.catalogChapters[0];
  const chapterKeys = new Set(Object.keys(chapterRow));
  const sectionKeys = new Set(Object.keys((chapterRow.sections || [])[0] || {}));
  assert.ok(sectionKeys.size > 0, "视图模型的子节点行不应为空");
  const missing = [];
  let scanned = 0;
  for (const match of markup.slice(regionStart, regionEnd).matchAll(/\b(chapter|section)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    scanned += 1;
    const keys = match[1] === "chapter" ? chapterKeys : sectionKeys;
    if (!keys.has(match[2])) missing.push(`${match[1]}.${match[2]}`);
  }
  assert.ok(scanned >= 8, `目录区域应扫到足够多的字段引用（实扫 ${scanned} 处），否则本断言等于没查`);
  assert.deepEqual([...new Set(missing)], [], "wxml 读到的目录字段必须在视图模型里");

  records.length = 0;
  page.openCatalog();
  const open = records.find((record) => record.keys.includes("catalogOpen"));
  assert.ok(open, "打开抽屉要发 catalogOpen");
  assert.equal(open.keys.includes("catalogChapters"), false, "展开态应走数据路径，不再重发整棵树");
  assert.ok(open.bytes < 2048, `打开抽屉负载 ${open.bytes} 字节（整棵视图树 ${viewTreeBytes} 字节）`);

  const expandedId = page.data.catalogChapters.find((chapter) => chapter.expanded).id;
  records.length = 0;
  page.toggleCatalogChapter({ currentTarget: { dataset: { id: expandedId } } });
  assert.ok(records[0].bytes < 256, `收起一行负载 ${records[0].bytes} 字节`);
  assert.equal(page.data.catalogChapters.find((chapter) => chapter.id === expandedId).expanded, false);
  assert.equal(page._catalogChapters.find((chapter) => chapter.id === expandedId).expanded, false, "实例树与视图树必须同步");

  records.length = 0;
  page.collapseAllCatalog();
  const allBytes = records.reduce((total, record) => total + record.bytes, 0);
  assert.ok(allBytes < 512, `收起全部负载 ${allBytes} 字节`);
  assert.equal(page.data.catalogChapters.every((chapter) => chapter.expanded === false), true);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("C17/F2：题目列表视图只给编号与题干", () => {
  const bank = buildFatBank(12);
  let definition;
  let questionSync = null;
  const store = new Map();
  store.set(`shukao_confirmed_catalog_${BOOK_ID}`, structuredClone(catalogFixture));
  const app = { globalData: { beans: 2 }, syncOfficialQuestions(callback) { questionSync = callback; } };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    showToast() {},
    navigateBack() {},
  };
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const records = [];
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    records.push({ keys: Object.keys(patch), bytes: bytesOf(patch), patch });
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({});
  questionSync(bank, { source: "cache" });

  const chapter = page._catalogChapters.find((item) => (item.questionIds || []).length);
  assert.ok(chapter, "缓存目录里应有带题的章");
  records.length = 0;
  page.selectCatalogChapter({ currentTarget: { dataset: { id: chapter.id, title: chapter.title, pending: 0 } } });
  const record = records.find((item) => item.keys.includes("catalogSummaryQuestions"));
  assert.ok(record, "点章要进题目列表");
  assert.deepEqual(Object.keys(record.patch.catalogSummaryQuestions[0]), ["id", "summaryNumber", "stem"]);
  const richBytes = bytesOf(page._catalogSummaryQuestions);
  assert.ok(record.bytes * 3 < richBytes, `题目列表负载 ${record.bytes} 字节应远小于完整题目 ${richBytes} 字节`);
  assert.equal(page.data.catalogSummaryQuestions.length, page._catalogSummaryQuestions.length);

  // 契约：题目列表区域的 item.* 只能是被保留的那三个字段。
  const summaryMarkup = fs.readFileSync(WXML, "utf8");
  const summaryStart = summaryMarkup.indexOf('wx:for="{{catalogSummaryQuestions}}"');
  const summaryEnd = summaryMarkup.indexOf("</scroll-view>", summaryStart);
  assert.ok(summaryStart > 0 && summaryEnd > summaryStart, "wxml 里应能找到题目列表区域");
  const summaryProps = [...new Set(
    [...summaryMarkup.slice(summaryStart, summaryEnd).matchAll(/\bitem\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
  )].sort();
  assert.deepEqual(summaryProps, ["id", "stem", "summaryNumber"], "题目列表视图只给编号与题干");

  // 从列表点进题目：队列换成这一章的题，视图层依旧是 id 序列，完整题目留在实例上。
  const targetId = page.data.catalogSummaryQuestions[0].id;
  page.selectCatalogQuestion({ currentTarget: { dataset: { questionId: targetId } } });
  assert.equal(page.data.question.id, targetId);
  assert.deepEqual(Object.keys(page.data.questionQueue[0]), ["id"]);
  assert.equal(page._questionQueue.length, page.data.questionQueue.length);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("C17/F3：目录内容不变时不重复重建、不重复 setData", () => {
  let definition;
  let questionSync = null;
  const store = new Map();
  const app = { globalData: { beans: 2 }, syncOfficialQuestions(callback) { questionSync = callback; } };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    showToast() {},
    navigateBack() {},
  };
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const records = [];
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    records.push({ keys: Object.keys(patch), bytes: bytesOf(patch), patch });
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({});

  const textbook = { bookId: BOOK_ID, subjectId: "modern-chinese", version: 3, nodes: structuredClone(catalogFixture.nodes) };
  page._pendingCatalogQuestionBank = buildFatBank(6);
  page._comprehensiveCatalogTextbooks = { [BOOK_ID]: textbook };
  records.length = 0;

  page.rebuildComprehensiveCatalogs();
  const afterFirst = records.filter((record) => record.keys.includes("catalogChapters")).length;
  assert.equal(afterFirst, 1, "第一次重建应产生一次 catalogChapters setData");

  // 同一册的缓存结果 + 网络结果（版本、节点数完全一致）：不该再重建。
  page.rebuildComprehensiveCatalogs();
  assert.equal(
    records.filter((record) => record.keys.includes("catalogChapters")).length,
    afterFirst,
    "内容指纹相同就不该再 setData",
  );

  // 版本变化＝内容变了：必须重建。
  page._comprehensiveCatalogTextbooks = { [BOOK_ID]: { ...textbook, version: 4 } };
  page.rebuildComprehensiveCatalogs();
  assert.equal(records.filter((record) => record.keys.includes("catalogChapters")).length, afterFirst + 1);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("C17/F4：目录全部命中缓存时，版本刷新请求延后发出", async () => {
  let definition;
  const store = new Map();
  store.set(`shukao_confirmed_catalog_${BOOK_ID}`, structuredClone(catalogFixture));
  const requests = [];
  const app = { globalData: { beans: 2 }, apiBaseUrlCandidates: () => ["http://api.test"] };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    showToast() {},
    navigateBack() {},
    request(options) {
      requests.push(options);
      options.success({ statusCode: 200, data: { textbook: structuredClone(catalogFixture) } });
    },
  };
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };

  const sources = [];
  page.requestBookCatalog(BOOK_ID, (textbook, meta) => sources.push(meta.source), { deferMs: 120 });
  assert.deepEqual(sources, ["cache"], "缓存结果必须同步先给，用户先看到缓存目录");
  assert.equal(requests.length, 0, "有缓存时刷新请求要延后，不跟首屏抢并发");

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(requests.length, 1, "延后到点后应恰好发一次版本刷新请求");
  assert.equal(sources.includes("server"), true);

  // 没有缓存时不能延后：这一册目录就是首屏内容。
  const before = requests.length;
  page.requestBookCatalog("no-cache-book", () => {}, { deferMs: 120 });
  assert.equal(requests.length, before + 1, "无缓存时必须立刻请求");

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
