const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "styles.css"), "utf8");

// 2026-09-28 产品手册 8.2 修订：提供真实的全部教材交集筛选，写入仍须明确教材。
// 以下是已被本次修订替代的历史背景：
//
// 背景（2026-09-19 实测，脚本 tmp/probe-filter-effect.js）：
//   · 教材=全部教材    → 题族卡 86 / 成员行 369 / 知识树 0 个节点
//   · 教材=现代汉语·上册 → 题族卡 86 / 成员行 369 / 知识树 356 个节点
//   · 教材=古代汉语·第1册 → 题族卡  4 / 成员行  36 / 知识树 112 个节点
// 也就是说"全部教材"既不参与筛选（与《现代汉语·上册》完全相同），又会把知识树整个清空；
// 而工作区依赖"当前教材"的功能有二十余处。取消这个态，顺带消灭了知识树被清空的路径。
//
// 说明：本文件只做源码契约断言；真实行为由无头浏览器脚本 tmp/verify-book-filter.js 验证。

function functionSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start > 0, `未找到函数 ${name}`);
  const end = appSource.indexOf("\n}", start);
  assert.ok(end > start, `未找到函数 ${name} 的结尾`);
  return appSource.slice(start, end);
}

test("admin workspace book filter: all books is a real unrestricted browsing option", () => {
  const syncSource = functionSource("syncQuestionFilterBooks");
  assert.match(syncSource, /<option value="all">全部教材<\/option>/);
  assert.doesNotMatch(syncSource, /未指定教材/);
  assert.match(htmlSource, /<select id="question-book-filter" aria-label="教材"><\/select>/);
});

test("admin workspace book filter: preserve compatible book or use unrestricted scope", () => {
  const syncSource = functionSource("syncQuestionFilterBooks");
  assert.match(syncSource, /books\.some\(\(book\) => book\.id === previous\)/);
  assert.match(syncSource, /\? previous : "all"/);
  assert.doesNotMatch(syncSource, /modern-chinese-7-1/);
});

test("admin workspace book filter: route init and family generation stop special-casing 全部教材", () => {
  // 路由初始化不再按题库类型传 "all"
  assert.doesNotMatch(appSource, /syncQuestionFilterBooks\(state\.questionLibrary === "official"/);
  // 生成候选题族不再在"全部教材"时**静默改用《现代汉语·上册》**（改成复用既有的工作区教材解析）
  assert.doesNotMatch(appSource, /bookId: document\.querySelector\("#question-book-filter"\)\.value === "all"/);
  assert.match(appSource, /libraryWorkspace\.openCompletion\(null, questionFamilyWorkspaceBookId\(\)\)/);
  assert.match(appSource, /return selectedBookId && selectedBookId !== "all" \? selectedBookId : "";/);
});

test("workspace filters and actions have one shared ordered location", () => {
  const filter = htmlSource.slice(htmlSource.indexOf('id="question-workspace-filters"'), htmlSource.indexOf('<section class="question-list-section"'));
  assert.deepEqual([...filter.matchAll(/<select id="([^"]+)"/g)].map(m => m[1]), [
    "question-subject-filter", "question-book-filter", "question-status-filter", "question-type-filter", "question-import-batch-filter",
  ]);
  const toolbar = htmlSource.slice(htmlSource.indexOf('id="question-workspace-toolbar"'), htmlSource.indexOf('id="question-workspace-filters"'));
  for (const summaryId of ["question-library-summary", "question-family-summary"]) {
    assert.ok(htmlSource.indexOf(`id="${summaryId}"`) > htmlSource.indexOf('class="question-browser-main"'));
    assert.ok(htmlSource.indexOf(`id="${summaryId}"`) < htmlSource.indexOf('id="question-workspace-toolbar"'));
  }
  assert.ok(htmlSource.indexOf('id="question-workspace-toolbar"') < htmlSource.indexOf('id="question-workspace-filters"'));
  assert.deepEqual([...toolbar.matchAll(/(?:input|button)[^>]+id="([^"]+)"/g)].map(m => m[1]).filter(id => !["question-search", "question-family-search", "question-workspace-mode-families", "question-workspace-mode-questions"].includes(id)), [
    "question-workspace-search", "create-question-family-set", "create-empty-question-family", "refresh-question-workspace", "toggle-question-family-management",
  ]);
  assert.doesNotMatch(htmlSource, /题库工作区|id="question-workspace-copy"|id="question-family-status"|id="question-family-member-status"/);
  assert.match(functionSource("loadQuestions"), /questionWorkspaceFilters\(\)/);
  assert.match(functionSource("loadQuestionFamilies"), /questionWorkspaceFilters\(\)/);
  assert.match(functionSource("questionFamilyRowHtml"), /workspaceMemberIds/);
  assert.match(functionSource("questionFamilyVisibleQuestions"), /workspaceMemberIds/);
});

test("workspace statistics use compact separate cards in both views", () => {
  for (const selector of [".question-family-metric", ".question-browser-main > .question-library-summary .question-summary-item"]) {
    const start = stylesSource.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    const rule = stylesSource.slice(start, stylesSource.indexOf("}", start));
    for (const declaration of ["min-height: 64px;", "flex-direction: column;", "border: 1px solid #dde5e1;", "border-radius: 6px;", "background: #fff;"]) {
      assert.ok(rule.includes(declaration), `${selector}: ${declaration}`);
    }
  }
  assert.match(stylesSource, /\.question-family-summary\s*\{[^}]*gap:\s*8px;[^}]*overflow-x:\s*auto;/);
  assert.match(stylesSource, /\.question-browser-main > \.question-library-summary\s*\{[^}]*overflow-x:\s*auto;[^}]*gap:\s*8px;/);
});

test("admin workspace book filter: the 题目完善 page keeps its own independent 全部教材 option", () => {
  // 本次只收口"题库工作区"这一个筛选；「题目完善」页的教材筛选是另一套，保持原样。
  // 2026-10-12：完善题目的教材筛选改成勾选式下拉（不再是 <select>），但仍是**独立控件**，
  // 默认标签「全部教材」不与题库工作区共用；同时不再提供「未指定教材（待归类）」哨兵项
  // （改由「缺什么 → 归属 → 待定教材」表达）。
  const enrichmentSource = functionSource("syncQuestionEnrichmentBooks");
  assert.match(enrichmentSource, /label: "全部教材"/);
  // 这个控件不再构造哨兵选项（注释里提到接口层兼容不算）。
  assert.doesNotMatch(enrichmentSource, /option value=|__unassigned__">/);
  assert.match(htmlSource, /<div class="filter-select" id="question-enrichment-book" data-label="全部教材"><\/div>/);
});
