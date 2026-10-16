/**
 * 完善中心的「按题组呈现」静态契约（DEC-099 ④：完善环节按题组）。
 *
 * 背景：服务端读出时就用 `decorateQuestionGroups` 派生了 `questionGroupId`／`questionGroupTitle`／
 * `groupQuestionCount`，但 #question-enrichment-table-body 一直逐行渲染，同一题组的 4 个小问散成 4 行，
 * 看起来"题组没有以题组呈现"。本文件把这件事钉住：分组函数存在、按 `questionGroupId` 分组、
 * 组头行带"1 个题组 · N 个作答项"、组内逐问仍是原来的模板（逐问建议/置信度/审核操作一样都不能少）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "apps/admin/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "apps/admin/styles.css"), "utf8");

function functionSource(name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js 里找不到 ${name}`);
  // 必须从签名右括号之后的第一个 `{` 开始数花括号：默认参数 `= {}` 里也有花括号，从头数会把函数体截断。
  let paren = 0;
  let bodyStart = -1;
  for (let index = appJs.indexOf("(", start); index < appJs.length; index += 1) {
    if (appJs[index] === "(") paren += 1;
    if (appJs[index] === ")") {
      paren -= 1;
      if (paren === 0) { bodyStart = appJs.indexOf("{", index); break; }
    }
  }
  assert.ok(bodyStart > 0, `${name} 找不到函数体`);
  let depth = 0;
  for (let index = bodyStart; index < appJs.length; index += 1) {
    if (appJs[index] === "{") depth += 1;
    if (appJs[index] === "}") {
      depth -= 1;
      if (depth === 0) return appJs.slice(start, index + 1);
    }
  }
  throw new Error(`${name} 的函数体没有闭合`);
}

function sliceFrom(marker, length) {
  const index = appJs.indexOf(marker);
  assert.ok(index >= 0, `app.js 里找不到 ${marker}`);
  return appJs.slice(index, index + length);
}

test("完善中心按题目单元分组：材料题组按 questionGroupId 归一组，散题各自一组", () => {
  const source = functionSource("questionEnrichmentUnits");
  assert.match(source, /String\(question\.questionGroupId \|\| ""\)\.trim\(\)/);
  assert.match(source, /const key = questionGroupId \|\| `question:\$\{question\.id\}`/);
  assert.match(source, /questionGroupTitle \|\| \(questionGroupId \? `第\$\{question\.groupNumber \|\| "—"\}题 · 材料题组`/);
  assert.match(source, /groupQuestionCount: Number\(question\.groupQuestionCount\) \|\| 0/);
  assert.match(source, /pendingCount: unit\.items\.filter/);
  // 组内顺序必须按小问号排：接口给的是"最近更新倒序"，直接铺会变成 (2)(1)。
  assert.match(source, /sort\(\(left, right\) => questionEnrichmentSubOrder\(left\.question\) - questionEnrichmentSubOrder\(right\.question\)\)/);
  const subOrder = functionSource("questionEnrichmentSubOrder");
  assert.match(subOrder, /Number\(question\.groupOrder\)/);
  assert.match(subOrder, /String\(question\.subNumber \|\| ""\)\.normalize\("NFKC"\)\.replace\(\/\[\^0-9\]\/g, ""\)/);
});

test("组头行：只在有题组时出现，写明整组作答项数与待完善问数，筛选只显部分时如实标注", () => {
  const source = functionSource("questionEnrichmentGroupHeadHtml");
  assert.match(source, /if \(!unit\.questionGroupId\) return ""/, "散题不能凭空出现组头");
  assert.match(source, /1 个题组 · \$\{escapeHtml\(declared\)\} 个作答项/);
  assert.match(source, /本组 \$\{escapeHtml\(unit\.totalScore\)\} 分 · 待完善 \$\{escapeHtml\(unit\.pendingCount\)\} 问/);
  assert.match(source, /unit\.items\.length < declared \? `（当前筛选 \$\{unit\.items\.length\} 问）`/);
  assert.match(source, /colspan="5"/);
});

test("组内逐问保留原模板：仍是同一份行模板（逐问建议/证据/审核操作/勾选框都在）", () => {
  const row = functionSource("questionEnrichmentRowHtml");
  assert.match(row, /questionEnrichmentActions\(item\)/, "逐问的操作按钮不能因为分组而丢");
  assert.match(row, /question-enrichment-row-checkbox/);
  assert.match(row, /enrichment-fields/);
  assert.match(row, /QuestionReviewModel\.fields\(item, questionBookName\)/);
  assert.match(row, /有新建议/);
  assert.match(row, /enrichment-evidence-cell/);
  assert.match(row, /enrichment-group-sub/, "组内行要带类名，才能缩进呈现层次");
  assert.match(row, /enrichment-sub-number/, "组内小问要显示自己的小问编号");
});

test("表格渲染走分组：不再直接 map state.questionEnrichmentItems", () => {
  const source = functionSource("renderQuestionEnrichmentTable");
  assert.match(source, /questionEnrichmentUnits\(state\.questionEnrichmentItems\)/);
  assert.match(source, /questionEnrichmentGroupHeadHtml\(unit\) \+ unit\.items\.map/);
  assert.doesNotMatch(source, /state\.questionEnrichmentItems\.map\(/, "旧的一行一题渲染必须换掉");
  assert.match(source, /renderQuestionEnrichmentSelection\(\)/);
});

test("小问编号只在题干内容前同行显示，不再独占信息区首行", () => {
  const row = functionSource("questionEnrichmentRowHtml");
  assert.equal((row.match(/class="enrichment-sub-number"/g) || []).length, 1);
  assert.match(row, /field\.key === "stem" && inGroup/);
  assert.match(row, /class="enrichment-field-value"[^>]*>\$\{field\.key === "stem"/);
  assert.match(row, /<td colspan="2"><div class="enrichment-fields">/);
});

test("样式：组头行与组内缩进都落在真实类名上（否则分组看不出来）", () => {
  assert.match(css, /\.question-enrichment-table tr\.question-enrichment-group-row > td\s*\{[^}]*background:/);
  assert.match(css, /\.question-enrichment-table tr\.enrichment-group-sub > td:nth-child\(2\)\s*\{[^}]*padding-left:\s*22px/);
  assert.match(css, /\.enrichment-sub-number\s*\{/);
});

test("整组勾选＝主操作：组头有整组勾选框（带整组 id 清单），可勾满/取消/半选", () => {
  const head = functionSource("questionEnrichmentGroupHeadHtml");
  assert.match(head, /class="question-enrichment-group-checkbox" type="checkbox" data-question-ids="\$\{escapeHtml\(ids\.join\(","\)\)\}"/);
  assert.match(head, /整组勾选/);
  assert.match(head, /已选 \$\{escapeHtml\(selected\)\}\/\$\{escapeHtml\(ids\.length\)\} 问/);
  assert.match(head, /分值的计算与分配按整组进行，请优先整组勾选；单独勾选只完善该问的归属/, "必须把主次理由写在界面上");
  const render = functionSource("renderQuestionEnrichmentTable");
  assert.match(render, /checkbox\.indeterminate = selected > 0 && selected < ids\.length/, "组内只选了一部分要显示半选");
  const handler = sliceFrom('document.querySelector("#question-enrichment-table-body").addEventListener("change"', 1200);
  assert.match(handler, /event\.target\.closest\("\.question-enrichment-group-checkbox"\)/);
  assert.match(handler, /String\(groupCheckbox\.dataset\.questionIds \|\| ""\)\.split\(","\)\.filter\(Boolean\)/);
  assert.match(handler, /ids\.forEach\(\(id\) => \(groupCheckbox\.checked \? selected\.add\(id\) : selected\.delete\(id\)\)\)/);
  assert.match(handler, /renderQuestionEnrichmentTable\(\)/, "整组勾选后要重渲染，组头的已选计数才跟得上");
});

test("逐问勾选降为次要：组内勾选框带弱化类名与说明，样式真的降透明度", () => {
  const row = functionSource("questionEnrichmentRowHtml");
  assert.match(row, /question-enrichment-row-checkbox\$\{inGroup \? " enrichment-sub-checkbox" : ""\}/);
  assert.match(row, /次要操作：单独勾选只完善这一问的归属；分值的计算与分配请用上方的整组勾选/);
  assert.match(row, /aria-label="\$\{inGroup \? "单独选择这个小问" : "选择题目"\}"/);
  assert.match(css, /input\.enrichment-sub-checkbox\s*\{[^}]*opacity:\s*0\.5/);
  assert.match(css, /input\.enrichment-sub-checkbox:checked\s*\{\s*opacity:\s*1/, "选中时不能还是灰的（否则看不出选了）");
  assert.match(css, /\.enrichment-group-select\s*\{[^}]*border: 1px solid/, "整组勾选要做成显眼的按钮样式");
});
