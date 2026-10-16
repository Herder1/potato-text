/**
 * 「AI 巡检」只读化 —— 静态契约测试（DEC-100／产品手册 §4.6.12）。
 *
 * 依据：产品手册 §0.4 的 DEC-100 与 §4.6.12 的分工表。巡检被重新定义为**只诊断、绝不写库**：
 * ① 巡检只诊断，不写库；② 题族归属移到「完善题目」；③ 知识归属只在「完善题目」里改；
 * ⑥ 巡检列表只读 ＋ 一键「送去完善题目」；⑦ 记录状态机换成四态（待复核／已复核／已修复／已忽略），
 * 题目被改动时旧结论自动作废；⑧ 本次一次性搬走写入口。
 *
 * 本文件把"巡检弹窗不能再改库"这件事钉死：
 * - 弹窗里不再有「采纳所选」「拒绝建议」，也没有任何勾选／下拉／输入控件可以提交；
 * - 知识依据与题族归属区带只读标记；
 * - 只有四个记录状态按钮 ＋「送去完善题目」两类动作，各自打对应接口，且都不写题库内容；
 * - 统计卡按「记录状态（四态）」「过程与风险」两组分开，旧的「已人工采纳／已拒绝」不再是记录状态；
 * - 题目变更时界面必须显示"旧结论作废"；
 * - 静态资源版本号两处一致（改了脚本必须同时抬版本号）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "apps/admin/index.html"), "utf8");
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

function sliceBetween(startMarker, endMarker) {
  const start = appJs.indexOf(startMarker);
  assert.ok(start >= 0, `app.js 里找不到 ${startMarker}`);
  const end = appJs.indexOf(endMarker, start);
  assert.ok(end > start, `app.js 里找不到 ${endMarker}`);
  return appJs.slice(start, end);
}

function htmlBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start >= 0, `index.html 里找不到 ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end > start, `index.html 里找不到 ${endMarker}`);
  return html.slice(start, end);
}

function beforeSource(name, length = 400) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js 里找不到 ${name}`);
  return appJs.slice(Math.max(0, start - length), start);
}

const inspectionDialogHtml = htmlBetween('id="knowledge-inspection-dialog"', "</dialog>");
const readonlySectionHtml = htmlBetween('id="knowledge-inspection-readonly-section"', "</section>");
const statusSelectHtml = htmlBetween('id="knowledge-inspection-status"', "</select>");

test("巡检弹窗只有只读结论：没有采纳/拒绝按钮，也没有任何可直接提交的写库控件", () => {
  // 原来的「采纳所选」「拒绝建议」两个写入口整体移除（不是隐藏）——隐藏会留下可被脚本点到的入口。
  assert.doesNotMatch(inspectionDialogHtml, /id="apply-knowledge-inspection"/, "采纳按钮必须从弹窗里移除");
  assert.doesNotMatch(inspectionDialogHtml, /id="reject-knowledge-inspection"/, "拒绝按钮必须从弹窗里移除");
  assert.doesNotMatch(inspectionDialogHtml, /采纳所选|拒绝建议/);
  // 知识/题族勾选区（含候选题族草案表单、调整依据）里的写控件必须消失，只留展示。
  assert.doesNotMatch(readonlySectionHtml, /<input/);
  assert.doesNotMatch(readonlySectionHtml, /<select/);
  assert.doesNotMatch(readonlySectionHtml, /<textarea/);
  assert.doesNotMatch(readonlySectionHtml, /type="checkbox"|type="radio"/);
  // 角色区原来是 radiogroup（作答核心／范围锚点），只读后不应再声称是单选组。
  assert.doesNotMatch(readonlySectionHtml, /role="radiogroup"/);
  // 表单型控件元素本身也不该再留在标记里。
  ["knowledge-inspection-create-candidate-family", "knowledge-inspection-family-draft-form", "knowledge-inspection-family-draft-name", "knowledge-inspection-candidate-contribution", "knowledge-inspection-adjustment-reason"].forEach((id) => {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} 是写库控件，必须移除`);
  });
  // 绑定也要一起摘掉：元素没了还留着监听器会在启动时直接抛错。
  assert.doesNotMatch(appJs, /#apply-knowledge-inspection"\)\.addEventListener/);
  assert.doesNotMatch(appJs, /#reject-knowledge-inspection"\)\.addEventListener/);
  assert.doesNotMatch(appJs, /#knowledge-inspection-family-draft-form"\)\.addEventListener/);
  assert.doesNotMatch(appJs, /#knowledge-inspection-create-candidate-family"\)\.addEventListener/);
  assert.doesNotMatch(appJs, /#knowledge-inspection-adjustment-reason-input"\)\.addEventListener/);
  assert.doesNotMatch(appJs, /#knowledge-inspection-choices"\)\.addEventListener\("change"/);
  assert.doesNotMatch(appJs, /#knowledge-inspection-family-choices"\)\.addEventListener\("change"/);
});

test("知识依据与题族归属区带只读标记，且渲染函数不再产出任何表单控件", () => {
  assert.match(readonlySectionHtml, /data-inspection-readonly="true"/);
  assert.match(readonlySectionHtml, /aria-readonly="true"/);
  assert.match(readonlySectionHtml, /只读展示/);
  assert.match(readonlySectionHtml, /id="knowledge-inspection-choices"[^>]*data-inspection-readonly="true"/);
  assert.match(readonlySectionHtml, /id="knowledge-inspection-family-choices"[^>]*data-inspection-readonly="true"/);
  assert.match(readonlySectionHtml, /id="knowledge-inspection-family-deferred"[^>]*data-inspection-readonly="true"/);
  assert.match(readonlySectionHtml, /id="knowledge-inspection-primary-node-role"/);
  assert.match(readonlySectionHtml, /id="knowledge-inspection-family-coverage-summary"[^>]*aria-live="polite"/);

  const knowledge = functionSource("renderKnowledgeInspectionReadonlyKnowledge");
  const families = functionSource("renderKnowledgeInspectionReadonlyFamilies");
  const draft = functionSource("renderKnowledgeInspectionCandidateFamilyDraft");
  [["知识依据", knowledge], ["题族归属", families], ["候选题族草案", draft]].forEach(([label, source]) => {
    assert.doesNotMatch(source, /<input|<select|<textarea|<button/, `${label}只读区不能渲染表单控件`);
    assert.doesNotMatch(source, /data-knowledge-node-choice|data-knowledge-primary-choice|data-knowledge-family-choice|data-knowledge-primary-family|data-knowledge-family-role=/, `${label}不能带写库用的勾选/单选钩子`);
  });
  assert.match(knowledge, /只读展示/);
  assert.match(families, /只读展示/);
  // 只读分支必须复用同一份建议来源，不能退化成另一套判断。
  assert.match(families, /knowledgeInspectionSuggestedFamilyMemberships\(result\)/);
  assert.match(draft, /knowledgeInspectionCandidateFamilyDraft\(result\)/);
  assert.match(draft, /用于组织和检索，不会自动写入题目知识/);
});

test("弹窗只提供四个记录状态动作与「送去完善题目」，各自打对应接口且成功后就地刷新", () => {
  // 四态按钮：三个状态动作 ＋ 送去完善题目。
  assert.match(inspectionDialogHtml, /id="mark-knowledge-inspection-reviewed"[^>]*data-knowledge-inspection-audit-state="reviewed"[^>]*>标为已复核</);
  assert.match(inspectionDialogHtml, /id="mark-knowledge-inspection-repaired"[^>]*data-knowledge-inspection-audit-state="repaired"[^>]*>标为已修复</);
  assert.match(inspectionDialogHtml, /id="mark-knowledge-inspection-ignored"[^>]*data-knowledge-inspection-audit-state="ignored"[^>]*>标为已忽略</);
  assert.match(inspectionDialogHtml, /id="send-knowledge-inspection-to-enrichment"[^>]*>送去完善题目</);
  assert.match(inspectionDialogHtml, /记录状态（不改库）/);

  const auditReviewSource = functionSource("setKnowledgeInspectionAuditState");
  assert.match(auditReviewSource, /\/api\/admin\/knowledge-classification\/results\/\$\{encodeURIComponent\(resultId\)\}\/audit-review/);
  assert.match(auditReviewSource, /method: "POST"/);
  assert.match(auditReviewSource, /body: JSON\.stringify\(\{ state: nextState \}\)/);
  assert.match(auditReviewSource, /await loadKnowledgeInspections\(\)/, "改记录状态后要刷新列表");
  assert.match(auditReviewSource, /setSmallDialogStatus\("#knowledge-inspection-dialog-status"/);

  const sendSource = functionSource("sendKnowledgeInspectionToEnrichment");
  assert.match(sendSource, /\/api\/admin\/knowledge-classification\/results\/\$\{encodeURIComponent\(resultId\)\}\/send-to-enrichment/);
  assert.match(sendSource, /method: "POST"/);
  assert.match(sendSource, /await loadKnowledgeInspections\(\)/, "送去完善题目后要刷新列表");
  assert.match(sendSource, /巡检不改库|没有改库/, "必须写清「送去」不等于采纳");

  // 绑定：三个状态按钮走同一个 data 属性，送去完善题目单独绑定。
  assert.match(appJs, /document\.querySelectorAll\("\[data-knowledge-inspection-audit-state\]"\)\.forEach/);
  assert.match(appJs, /setKnowledgeInspectionAuditState\(button\.dataset\.knowledgeInspectionAuditState\)/);
  assert.match(appJs, /#send-knowledge-inspection-to-enrichment"\)\.addEventListener\("click", sendKnowledgeInspectionToEnrichment\)/);
  // 「重新巡检」「编辑题目」「关闭」这些非写库动作保留。
  assert.match(inspectionDialogHtml, /id="rerun-knowledge-inspection"/);
  assert.match(inspectionDialogHtml, /id="edit-knowledge-inspection-question"/);
  assert.match(inspectionDialogHtml, /id="cancel-knowledge-inspection"/);
});

test("旧的写库函数保留但已从巡检路径摘除（DEC-100 注释 ＋ 空值兜底，页面无入口）", () => {
  assert.match(beforeSource("applyKnowledgeInspection", 400), /DEC-100/, "必须在函数上方写明 DEC-100 已摘除");
  assert.doesNotMatch(appJs, /addEventListener\("click", applyKnowledgeInspection\)/);
  assert.doesNotMatch(appJs, /addEventListener\("click", rejectKnowledgeInspection\)/);
  assert.match(beforeSource("rejectKnowledgeInspection", 400), /DEC-100/);

  // 元素被移除后，旧的辅助函数必须能安全空跑（否则任何残留调用都会抛错）。
  assert.match(functionSource("updateKnowledgeInspectionApplyButton"), /const button = document\.querySelector\("#apply-knowledge-inspection"\);\s*if \(!button\) return;/);
  assert.match(functionSource("syncKnowledgeInspectionAdjustmentReason"), /const element = document\.querySelector\("#knowledge-inspection-adjustment-reason"\);\s*if \(!element\) return;/);
  assert.match(functionSource("rejectKnowledgeInspection"), /if \(button\) button\.disabled = true/);
  // 弹窗打开路径不再调用这两个写库相关刷新。
  const openSource = sliceBetween("function openKnowledgeInspection(", "function closeKnowledgeInspectionDialog(");
  assert.doesNotMatch(openSource, /updateKnowledgeInspectionApplyButton\(\)/);
  assert.doesNotMatch(openSource, /syncKnowledgeInspectionAdjustmentReason\(\)/);
  assert.match(openSource, /renderKnowledgeInspectionAuditState\(result\)/);
});

test("统计卡分两组：记录状态四态来自 auditReviewCounts，正在巡检/高风险明确标注为过程与风险", () => {
  const summary = functionSource("renderKnowledgeInspectionSummary");
  // 后端字段缺失时降级显示 0，而不是抛错，也不是回落到被废止的旧计数。
  assert.match(summary, /summary\.auditReviewCounts && typeof summary\.auditReviewCounts === "object"/);
  assert.match(summary, /Number\.isFinite\(Number\(auditCounts\[auditState\]\)\) \? Number\(auditCounts\[auditState\]\) : 0/);
  assert.match(summary, /\["pending_review", "reviewed", "repaired", "ignored"\]/);
  assert.match(summary, /knowledgeInspectionAuditStateLabels\[auditState\]/);
  assert.match(summary, /记录状态/);
  assert.match(summary, /过程与风险/);
  assert.match(summary, /不是记录状态/);
  assert.match(summary, /正在巡检/);
  assert.match(summary, /高风险/);
  assert.doesNotMatch(summary, /已人工采纳|已拒绝/, "旧记录状态不能留在统计卡里");
  assert.doesNotMatch(summary, /"applied"|"rejected"/);

  // 状态机词表只保留四态；过程状态另有一套文案。
  const labels = sliceBetween("const knowledgeInspectionAuditStateLabels = {", "};");
  ["pending_review", "reviewed", "repaired", "ignored"].forEach((auditState) => {
    assert.match(labels, new RegExp(`${auditState}:`));
  });
  const statusLabels = sliceBetween("const knowledgeInspectionStatusLabels = {", "};");
  assert.doesNotMatch(statusLabels, /applied:/);
  assert.doesNotMatch(statusLabels, /rejected:/);
  assert.doesNotMatch(statusLabels, /已人工采纳|已拒绝/);
  // 列表筛选也不能再按废止状态筛（后端对未知状态会直接筛空）。
  assert.doesNotMatch(statusSelectHtml, /value="applied"/);
  assert.doesNotMatch(statusSelectHtml, /value="rejected"/);
  assert.doesNotMatch(statusSelectHtml, /已人工采纳|已拒绝/);
  assert.match(statusSelectHtml, /value="pending_review">待复核（记录状态）/);
  assert.match(statusSelectHtml, /value="running">正在巡检（过程）/);
});

test("题目变更后旧结论作废：列表与弹窗都要看得见地提示，需重新巡检", () => {
  const auditReview = functionSource("knowledgeInspectionAuditReview");
  assert.match(auditReview, /invalidated === true/);
  assert.match(auditReview, /invalidatedReason/);
  assert.match(auditReview, /recordedState/);
  assert.match(auditReview, /pending_review/, "缺失 auditReview 时默认落到待复核");
  assert.match(appJs, /question_changed: "题目被改过（知识／题族／答案／分值任一变更）"/);

  const dialogState = functionSource("renderKnowledgeInspectionAuditState");
  assert.match(dialogState, /题目已变更，旧结论作废，需重新巡检/);
  assert.match(dialogState, /invalidatedElement\.hidden = !audit\.invalidated/);
  assert.match(dialogState, /旧结论当时的记录状态/);
  assert.match(functionSource("renderKnowledgeInspectionTable"), /题目已变更，旧结论作废/);
  // 列表状态列显示记录状态四态徽标；过程状态另起一个徽标，不混为一谈。
  assert.match(functionSource("renderKnowledgeInspectionTable"), /knowledgeInspectionAuditStateLabels\[audit\.state\]/);
  assert.match(functionSource("renderKnowledgeInspectionTable"), /isProcessStatus/);
  // 弹窗里的记录状态块与提示位必须在标记里存在。
  assert.match(inspectionDialogHtml, /id="knowledge-inspection-review-state"/);
  assert.match(inspectionDialogHtml, /id="knowledge-inspection-review-record-note"/);
  assert.match(inspectionDialogHtml, /id="knowledge-inspection-review-audit"[^>]*hidden/);
  assert.match(inspectionDialogHtml, /id="knowledge-inspection-review-invalidated"[^>]*hidden/);
});

test("新增的 hidden 元素都有 [hidden] 兜底（作者 display 会压过浏览器默认隐藏）", () => {
  assert.match(css, /\.knowledge-inspection-review-audit\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.knowledge-inspection-review-invalidated\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.knowledge-inspection-family-deferred\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.knowledge-inspection-family-draft\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.knowledge-inspection-review-state\s*\{/);
  assert.match(css, /\.knowledge-inspection-metric-group\s*\{/);
  assert.match(css, /\.knowledge-inspection-node-readonly\s*\{/);
});

test("静态资源版本号：app.js 与 styles.css 必须同值且已抬过（改了脚本不抬版本号＝页面还跑旧脚本）", () => {
  const scriptVersion = html.match(/app\.js\?v=(\d{8}\.\d+)/);
  const styleVersion = html.match(/styles\.css\?v=(\d{8}\.\d+)/);
  assert.ok(scriptVersion, "app.js 必须带 ?v= 版本号");
  assert.ok(styleVersion, "styles.css 必须带 ?v= 版本号");
  assert.equal(scriptVersion[1], styleVersion[1], "两个静态资源版本号必须一致");
  assert.notEqual(scriptVersion[1], "20260925.24", "本次改了 app.js/styles.css，版本号必须抬过");
});
