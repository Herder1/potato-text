const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "index.html"), "utf8");

// 口径：题库工作区的「教材」筛选**强制必选一本真实教材**，不再提供"全部教材"。
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

test("admin workspace book filter: the workspace book select no longer offers 全部教材", () => {
  const syncSource = functionSource("syncQuestionFilterBooks");
  // 生成选项时不带"全部教材"这一项
  assert.doesNotMatch(syncSource, /全部教材/);
  assert.doesNotMatch(syncSource, /value="all"/);
  // 静态 HTML 里也不能留一个默认的"全部教材"选项
  assert.doesNotMatch(htmlSource, /id="question-book-filter"[^>]*>\s*<option value="all">/);
  assert.match(htmlSource, /<select id="question-book-filter" aria-label="教材"><\/select>/);
});

test("admin workspace book filter: a concrete textbook is always selected", () => {
  const syncSource = functionSource("syncQuestionFilterBooks");
  // 选中顺序：沿用原选择 → 官方题库优先《现代汉语·上册》 → 该科目下的第一本
  assert.match(syncSource, /books\.some\(\(book\) => book\.id === previous\)/);
  assert.match(syncSource, /book\.id === "modern-chinese-7-1"/);
  assert.match(syncSource, /books\[0\]\?\.id/);
  // 绝不能落回 "all" 或空值：那等于又造出"没有当前教材"的状态
  assert.doesNotMatch(syncSource, /select\.value = "all"/);
});

test("admin workspace book filter: route init and family generation stop special-casing 全部教材", () => {
  // 路由初始化不再按题库类型传 "all"
  assert.doesNotMatch(appSource, /syncQuestionFilterBooks\(state\.questionLibrary === "official"/);
  // 生成候选题族不再在"全部教材"时**静默改用《现代汉语·上册》**（改成复用既有的工作区教材解析）
  assert.doesNotMatch(appSource, /bookId: document\.querySelector\("#question-book-filter"\)\.value === "all"/);
  assert.match(appSource, /body: JSON\.stringify\(\{ bookId: questionFamilyWorkspaceBookId\(\) \}\)/);
  // 既有的工作区教材解析仍保留兜底
  assert.match(appSource, /return selectedBookId && selectedBookId !== "all" \? selectedBookId : "modern-chinese-7-1";/);
});

test("admin workspace book filter: the 题目完善 page keeps its own independent 全部教材 option", () => {
  // 本次只收口"题库工作区"这一个筛选；「题目完善」页的教材筛选是另一套，保持原样
  const enrichmentSource = functionSource("syncQuestionEnrichmentBooks");
  assert.match(enrichmentSource, /<option value="all">全部教材<\/option>/);
  assert.match(htmlSource, /<select id="question-enrichment-book"><option value="all">全部教材<\/option><\/select>/);
});
