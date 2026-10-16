const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "app.js"), "utf8");

/**
 * 后台另一类静默 UI 故障：同一个 id 给了两个元素，`document.querySelector` 永远只返回
 * 文档里**第一个**——"界面看着对、读写的却是另一个元素"。
 *
 * 2026-09-24 实例（DEC-098）：列表筛选的科目下拉与复核弹窗的科目下拉都叫
 * `#question-enrichment-subject`。弹窗渲染把候选科目写进了**列表筛选**那个 select，
 * 于是弹窗自己的下拉是空的、列表筛选被覆盖；采纳请求读到的 `overrides.subjectId` 也是筛选值，
 * 真实点「采纳并创建新版本」直接 422（`question_enrichment_knowledge_points_required`），
 * 版本号不动、列表还被筛成空。修法与命名约定：弹窗里的字段统一用 `<弹窗 id>-<字段>`
 * （本弹窗已有 `question-enrichment-dialog-title/-status/-stem`）→ 改名 `-dialog-subject`。
 *
 * 已知例外（**不是本测试放行的"允许重复"，而是已登记待产品负责人裁定的既有缺陷**）：
 * `admin-account-role` 同时给了顶栏账号角色的 `<span>`（`index.html:84`）与**「新建后台账号」弹窗**
 * `#admin-account-dialog` 里的「角色」`<select>`（`index.html:2159`）。`querySelector` 命中的是 span，
 * 于是弹窗里选的角色被丢掉——`adminAccountStore.create({ role = "operator" })` 的默认值生效，
 * **选「超级管理员」也只会建出运营操作员账号，且界面不报错**（`/api/admin/accounts` 是超管专属，
 * 后果＝界面建不出第二个超管）。修它属账号/权限行为（AGENTS §4 必须先确认），故此处显式登记、
 * 不放宽其余规则。见 docs/OPEN_DECISIONS.md C19 / §1.18。
 */
const KNOWN_DUPLICATES = new Map([
  ["admin-account-role", "顶栏账号角色 span 与「新建后台账号」弹窗的角色 select 同名，导致弹窗选的角色被丢弃（静默降权成 operator）；已登记 docs/OPEN_DECISIONS.md C19，待产品负责人裁定"],
]);

test("后台：index.html 不得出现重复 id（重复 id 会让 querySelector 命中另一个元素）", () => {
  const counts = new Map();
  const lines = new Map();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
    const id = match[1];
    counts.set(id, (counts.get(id) || 0) + 1);
    if (!lines.has(id)) lines.set(id, textLineOf(html, match.index));
  }
  const duplicated = [...counts.entries()].filter(([, count]) => count > 1);
  assert.ok(counts.size > 300, `解析到的 id 过少（${counts.size}），解析逻辑可能失效`);
  const offenders = duplicated
    .filter(([id]) => !KNOWN_DUPLICATES.has(id))
    .map(([id, count]) => `#${id} × ${count}（首次出现在第 ${lines.get(id)} 行）`);
  assert.deepEqual(offenders, [], `这些 id 在同一页面里重复：\n${offenders.join("\n")}`);
});

test("后台：复核弹窗的科目下拉与列表筛选的科目下拉是两个不同元素", () => {
  // 命名约定：弹窗内字段用 `<弹窗 id>-<字段>`；列表筛选保留 `#question-enrichment-subject`
  // （2026-10-12 起列表筛选是勾选式下拉 div.filter-select，不再是 <select>）。
  assert.match(html, /<div class="filter-select" id="question-enrichment-subject" data-label="全部科目"><\/div>/);
  assert.match(html, /<select id="question-enrichment-dialog-subject"><\/select>/);
  const dialogSelect = 'querySelector("#question-enrichment-dialog-subject")';
  // 弹窗只认自己的下拉：渲染科目候选、三级联动、写入 overrides.subjectId 全部走 -dialog-subject
  assert.ok(script.split(dialogSelect).length - 1 >= 4, "弹窗科目下拉的引用点少于 4 处，可能改漏了");
  const start = script.indexOf("async function openQuestionEnrichmentReview");
  assert.ok(start > 0, "找不到 openQuestionEnrichmentReview（弹窗渲染入口）");
  const dialogRenderer = script.slice(start, start + 6000);
  assert.ok(dialogRenderer.includes(dialogSelect), "弹窗渲染函数没有使用 -dialog-subject");
  // 列表筛选的引用点只应出现在列表筛选自己的渲染/查询/联动里（勾选控件用 filterSelectValues 取值）
  assert.ok(script.split('"question-enrichment-subject"').length - 1 >= 2, "列表筛选科目控件的引用点少于 2 处");
});

function textLineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}
