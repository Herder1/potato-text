/**
 * 「确定性体检项」在巡检侧的显示契约（DEC-100／产品手册 §4.6.12）。
 *
 * 后端冻结的字段名（不要改名）：
 * - 列表每行带 `ruleFindings: [{ code, title, source, severity, evidence, suggestion }]`（只含规则项）；
 * - 列表 `summary` 带 `ruleFindingsByCode`（按 code 计数）与 `ruleFindingsPassed`（通过留档数）。
 *
 * 产品负责人确认的两条口径：
 * ① 「通过也要记录」——`code === "confirmed"` 的通过项必须显示成「已留档 · 无问题」，不是"有问题才显示"；
 * ② 「来源可区分」——规则项标「规则」，AI 结论标「AI」，两套结论在同一个清单里不许混在一起。
 * 另外：标题一律用后端给的 `title`（词汇表单点在 apps/api/src/question-audit-rules.js 的 AUDIT_ISSUE_LABELS），
 * 前端不得再写一份中文标题表；字段缺失（后端这一版还没上线）时不渲染空壳区块、页面也不许报错。
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
  // 从签名右括号之后的第一个 `{` 开始数花括号：默认参数 `= {}` 里也有花括号，从头数会截断函数体。
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

const ruleInlineSource = functionSource("knowledgeInspectionRuleFindingsHtml");
const ruleDialogSource = functionSource("renderKnowledgeInspectionRuleFindings");
const ruleListSource = functionSource("knowledgeInspectionRuleFindings");

test("体检项字段名按后端冻结形状读取：行内 ruleFindings，摘要 ruleFindingsByCode／ruleFindingsPassed", () => {
  assert.match(ruleListSource, /knowledgeInspectionArray\(result\.ruleFindings\)/);
  assert.match(ruleListSource, /finding\.code \|\| finding\.title/, "只收下能识别出 code／title 的对象，脏数据不入渲染");
  const summary = functionSource("renderKnowledgeInspectionSummary");
  assert.match(summary, /summary\.ruleFindingsByCode && typeof summary\.ruleFindingsByCode === "object"/);
  assert.match(summary, /Number\(summary\.ruleFindingsPassed\)/);
  assert.match(summary, /确定性体检项/);
  assert.match(summary, /通过留档/);
  // 通过留档数为 0 也是有效值（"0 项通过"要显示出来），只有字段整个缺失才不渲染这一组。
  assert.match(summary, /const hasRuleFindings = hasRuleMetricCards \|\| Boolean\(ruleUnavailable\)/);
  assert.match(summary, /const ruleGroup = !hasRuleFindings \? "" :/);

  // 弹窗里也要有这一节，且挂在只读渲染路径上。
  const openSource = sliceBetween("function openKnowledgeInspection(", "function closeKnowledgeInspectionDialog(");
  assert.match(openSource, /renderKnowledgeInspectionRuleFindings\(result\)/);
  assert.match(html, /id="knowledge-inspection-rule-findings-section"/);
  assert.match(html, /id="knowledge-inspection-rule-findings"/);
  assert.match(html, /体检项（确定性规则）/);
});

test("标题只用后端给的 title，前端不再写第二份中文标题表（避免与 AUDIT_ISSUE_LABELS 双写）", () => {
  const titleSource = functionSource("knowledgeInspectionRuleFindingTitle");
  assert.match(titleSource, /String\(finding\.title \|\| finding\.code \|\| ""\)\.trim\(\)/);
  // 规则项的 code 是后端词汇表的键：前端一旦给它们配中文，就是又一处双写点。
  // 只判"独立的键名"——`active_dossier_evidence_missing` 之类别的模块的诊断码不属于这套词汇。
  ["near_duplicate", "score_abnormal", "content_defect", "evidence_missing"].forEach((code) => {
    assert.doesNotMatch(appJs, new RegExp(`(^|[^A-Za-z0-9_$])${code}:\\s*"`, "m"), `${code} 的中文标题只能在后端词汇表里`);
  });
  const vocabularySource = sliceBetween("const knowledgeInspectionRuleSourceLabels", "function knowledgeInspectionRuleFindings(");
  assert.doesNotMatch(vocabularySource, /near_duplicate|score_abnormal|content_defect|evidence_missing/);
  // 前端只保留"来源"和"严重度"两种枚举文案（不是标题表）。
  assert.match(vocabularySource, /knowledgeInspectionRuleSourceLabels = \{ rule: "规则", ai: "AI" \}/);
  assert.match(vocabularySource, /knowledgeInspectionRuleSeverityLabels = \{ high: "高", medium: "中", low: "低", none: "无" \}/);
});

test("来源可区分：每条标「规则」或「AI」，两套结论不混写", () => {
  const sourceSource = functionSource("knowledgeInspectionRuleFindingSource");
  assert.match(sourceSource, /String\(finding\.source \|\| "rule"\)\.toLowerCase\(\)/);
  assert.match(sourceSource, /knowledgeInspectionRuleSourceLabels\[source\] \? source : "rule"/, "未知来源按规则项兜底，但不冒充 AI");
  assert.match(ruleDialogSource, /knowledge-inspection-rule-source is-\$\{escapeHtml\(source\)\}/);
  assert.match(ruleDialogSource, /knowledgeInspectionRuleSourceLabels\[source\]/);
  assert.match(ruleInlineSource, /data-rule-source="\$\{escapeHtml\(knowledgeInspectionRuleFindingSource\(finding\)\)\}"/);
  assert.match(ruleInlineSource, /is-\$\{escapeHtml\(knowledgeInspectionRuleFindingSource\(finding\)\)\}/, "列表胶囊也要带来源类名");
  // 列表行里 Agent 的 AI 结论也要显式标 AI，用户才知道哪条是规则、哪条是 AI。
  const tableSource = functionSource("renderKnowledgeInspectionTable");
  assert.match(tableSource, /knowledge-inspection-source-tag is-ai">AI</);
  // 弹窗文案要写明"规则／AI"两套来源是分开列的。
  assert.match(html, /「规则」＝确定性规则，「AI」＝归类产线结论/);
  assert.match(html, /与上方 Agent 的 AI 结论<b>分开列出<\/b>/);
});

test("通过（体检跑过但没命中规则项）也要留档显示，不是「有问题才显示」", () => {
  assert.match(appJs, /const KNOWLEDGE_INSPECTION_PASS_CODE = "confirmed"/);
  // 文案只写一份：常量 + 落款文案本身都要在（测试断言真实存在的东西，不去迁就实现）。
  assert.match(appJs, /const KNOWLEDGE_INSPECTION_RULE_PASS_TITLE = "已留档 · 无问题"/);
  // 文案必须是逐题口径：同一份汇总里可能有别的题命中规则项（产品负责人 2026-09-26 指出
  // 「整本书没命中」会把逐题结论说成整册结论），"通过也是结论"这条意思必须保留。
  assert.match(appJs, /const KNOWLEDGE_INSPECTION_RULE_PASS_DETAIL = "这道题没有命中任何规则项/);
  assert.match(appJs, /const KNOWLEDGE_INSPECTION_RULE_PASS_DETAIL = "[^"]*本次结论已留档（通过也是结论）[^"]*"/);
  assert.doesNotMatch(appJs, /整本书的确定性体检没有命中任何规则项/);
  const passSource = functionSource("knowledgeInspectionRuleFindingIsPass");
  assert.match(passSource, /String\(finding\.code \|\| ""\) === KNOWLEDGE_INSPECTION_PASS_CODE/);
  const labelSource = functionSource("knowledgeInspectionRuleFindingLabel");
  assert.match(labelSource, /knowledgeInspectionRuleFindingIsPass\(finding\)/);
  assert.match(labelSource, /KNOWLEDGE_INSPECTION_RULE_PASS_TITLE/, "通过文案抽成常量，两边共用同一份");
  // 后端只给"规则项数组 + 通过行数"：数组存在但为空 = 本次体检通过，必须显式渲染"已留档通过"。
  assert.match(ruleInlineSource, /if \(!Array\.isArray\(result\.ruleFindings\)\)/);
  assert.match(ruleInlineSource, /体检项 0 项 · 已留档通过/);
  assert.match(ruleInlineSource, /data-rule-pass="true"/);
  assert.match(ruleDialogSource, /const hasField = Array\.isArray\(result\.ruleFindings\)/);
  assert.match(ruleDialogSource, /section\.hidden = !hasField && !capability/, "只有「整份响应都没有体检能力」才隐藏；空数组＝通过，照样渲染");
  assert.match(ruleDialogSource, /if \(!rows\.length\) \{[\s\S]*?knowledgeInspectionRuleNoticeRow\("pass"\)/, "弹窗空数组也要渲染通过留档行");
  assert.match(ruleDialogSource, /knowledge-inspection-rule-pass/);
  const noticeSource = functionSource("knowledgeInspectionRuleNoticeRow");
  assert.match(noticeSource, /is-pass/);
  assert.match(noticeSource, /KNOWLEDGE_INSPECTION_RULE_PASS_TITLE/);
  assert.match(ruleInlineSource, /通过留档 \$\{escapeHtml\(passCount\)\} 项/);
  // 后端摘要里的通过留档行数=0 也是有效值（"0 行通过"要显示），不能当成"没数据"。
  assert.match(functionSource("renderKnowledgeInspectionSummary"), /rulePassed != null/);
});

test("「未体检」（字段缺失＝没体检成）与「通过」分开显示，绝不显示成通过", () => {
  assert.match(appJs, /const KNOWLEDGE_INSPECTION_RULE_NOT_AUDITED_CODE = "not_audited"/);
  assert.match(appJs, /const KNOWLEDGE_INSPECTION_RULE_NOT_AUDITED_TEXT = "未体检"/);
  // 判据：整份响应有没有体检能力（摘要里有没有 ruleFindingsByCode／ruleFindingsPassed）。
  const capabilitySource = functionSource("knowledgeInspectionRuleAuditCapability");
  assert.match(capabilitySource, /summary\.ruleFindingsByCode && typeof summary\.ruleFindingsByCode === "object"/);
  assert.match(capabilitySource, /summary\.ruleFindingsPassed != null/);
  // 整本书都没体检成时后端**只**给 ruleFindingsUnavailable：它同样证明"这一版有体检能力"，
  // 不能因为摘要里没有计数就当成"后端没上这版"而把「未体检」整节隐藏。
  assert.match(capabilitySource, /summary\.ruleFindingsUnavailable && typeof summary\.ruleFindingsUnavailable === "object"/);
  // 字段缺失：有能力 → 「未体检」；没能力（后端还没上这一版）→ 空串／隐藏，不留空壳。
  assert.match(ruleInlineSource, /if \(!knowledgeInspectionRuleAuditCapability\(\)\) return ""/);
  assert.match(ruleInlineSource, /data-rule-not-audited="true"/);
  assert.match(ruleInlineSource, /KNOWLEDGE_INSPECTION_RULE_NOT_AUDITED_TEXT/);
  assert.match(ruleDialogSource, /list\.innerHTML = capability \? knowledgeInspectionRuleNoticeRow\("not_audited"\) : ""/);
  const noticeSource = functionSource("knowledgeInspectionRuleNoticeRow");
  assert.match(noticeSource, /is-unaudited/);
  assert.match(noticeSource, /未跑确定性体检/);
  // 「未体检」的说明必须写清"不等于通过"，并带上后端在 summary.ruleFindingsUnavailable 里给的原因与教材。
  const detailSource = functionSource("knowledgeInspectionRuleNotAuditedDetail");
  assert.match(detailSource, /「\$\{KNOWLEDGE_INSPECTION_RULE_NOT_AUDITED_TEXT\}」不等于通过/);
  assert.match(functionSource("knowledgeInspectionRuleNotAuditedReason"), /knowledgeInspectionSummary \|\| \{\}\)\.ruleFindingsUnavailable/);
  assert.match(functionSource("knowledgeInspectionRuleNotAuditedReason"), /unavailable\.reason/);
  assert.match(functionSource("knowledgeInspectionRuleNotAuditedBooks"), /unavailable\.books/);
  assert.match(detailSource, /knowledgeInspectionRuleNotAuditedBooks\(\)/);
  // 摘要里也要能直接说出"有书没体检成"，不能让未体检看起来像没有数据。
  const summarySource = functionSource("renderKnowledgeInspectionSummary");
  assert.match(summarySource, /summary\.ruleFindingsUnavailable/);
  assert.match(summarySource, /未体检 ≠ 通过/);
  assert.match(summarySource, /const hasRuleFindings = hasRuleMetricCards \|\| Boolean\(ruleUnavailable\)/);
  assert.match(css, /\.knowledge-inspection-rule-findings-unavailable\s*\{/);
  // 样式上必须与"通过"可分（灰底虚线，不是绿底）。
  assert.match(css, /\.knowledge-inspection-rule-chip\.is-unaudited\s*\{[^}]*dashed/);
  assert.match(css, /\.knowledge-inspection-rule-finding\.is-unaudited\s*\{[^}]*dashed/);
  assert.match(css, /\.knowledge-inspection-rule-severity\.is-none\s*\{/);
});

test("字段缺失时优雅降级：不渲染空壳区块，也不留下会抛错的解引用", () => {
  // 行内区块与弹窗区块都必须在"字段整个缺失"时分流：有能力＝未体检，没能力＝什么都不渲染。
  assert.match(ruleInlineSource, /if \(!Array\.isArray\(result\.ruleFindings\)\) \{/);
  assert.match(ruleInlineSource, /if \(!knowledgeInspectionRuleAuditCapability\(\)\) return ""/);
  assert.match(ruleDialogSource, /const section = document\.querySelector\("#knowledge-inspection-rule-findings-section"\);\s*const list = document\.querySelector\("#knowledge-inspection-rule-findings"\);\s*if \(!section \|\| !list\) return;/);
  assert.match(ruleDialogSource, /section\.hidden = !hasField/);
  assert.match(ruleDialogSource, /if \(!hasField\) \{\s*list\.innerHTML = capability \? knowledgeInspectionRuleNoticeRow\("not_audited"\) : "";\s*return;/);
  // evidence／suggestion／detail 形态不定（字符串或对象），读不出就不显示，不能抛错。
  const detailSource = functionSource("knowledgeInspectionRuleFindingDetail");
  assert.match(detailSource, /if \(value == null\) return ""/);
  assert.match(detailSource, /typeof value === "string"/);
  assert.match(detailSource, /Array\.isArray\(value\)/);
  assert.match(detailSource, /typeof value === "object"/);
  assert.doesNotMatch(detailSource, /JSON\.stringify/);
  assert.match(functionSource("knowledgeInspectionRuleFindingSuggestion"), /String\(finding\.suggestion \|\| ""\)\.trim\(\)/);
  // 初始标记就是 hidden：字段没来之前页面上不该出现空壳。
  assert.match(html, /id="knowledge-inspection-rule-findings-section"[^>]*hidden/);
  assert.match(css, /\.knowledge-inspection-rule-findings\[hidden\]\s*\{\s*display:\s*none/);
});

test("体检项清单仍是只读展示：没有提交控件、没有事件绑定、证据与建议都能看到", () => {
  [["列表行", ruleInlineSource], ["弹窗", ruleDialogSource]].forEach(([label, source]) => {
    assert.doesNotMatch(source, /<input|<select|<textarea|<button/, `${label}的体检项区不能出现表单控件`);
  });
  assert.doesNotMatch(appJs, /knowledge-inspection-rule-findings"\)\.addEventListener/);
  assert.doesNotMatch(appJs, /#knowledge-inspection-rule-findings-section"\)\.addEventListener/);
  // 详情：说明／证据／建议都要能读到（弹窗直接铺开，列表胶囊用 title 承载 hover 内容）。
  assert.match(ruleDialogSource, /说明：\$\{escapeHtml\(detail\)\}/);
  assert.match(ruleDialogSource, /证据：\$\{escapeHtml\(evidence\)\}/);
  assert.match(ruleDialogSource, /建议：\$\{escapeHtml\(suggestion\)\}/);
  assert.match(ruleInlineSource, /title="\$\{escapeHtml\(knowledgeInspectionRuleFindingTooltip\(finding\)\)\}"/);
  const tooltipSource = functionSource("knowledgeInspectionRuleFindingTooltip");
  assert.match(tooltipSource, /说明：\$\{knowledgeInspectionRuleFindingDetailText\(finding\)\}/);
  assert.match(tooltipSource, /证据：\$\{knowledgeInspectionRuleFindingEvidence\(finding\)\}/);
  assert.match(tooltipSource, /建议：\$\{knowledgeInspectionRuleFindingSuggestion\(finding\)\}/);
  assert.match(ruleDialogSource, /knowledge-inspection-readonly-mark">只读展示</);
  assert.match(css, /\.knowledge-inspection-rule-finding-detail/);
});

test("摘要卡的中文标题取自后端下发的词表（不是前端写死的第二份 map）", () => {
  const titleByCode = functionSource("knowledgeInspectionRuleFindingTitleByCode");
  assert.match(titleByCode, /state\.knowledgeInspectionIssueLabels \|\| \{\}/);
  assert.match(titleByCode, /entry && entry\.title \? String\(entry\.title\) : String\(code \|\| ""\)/, "取不到就回落 code，绝不猜中文");
  // 词表由列表接口原样下发，前端只是收下（payload.issueLabels）。
  assert.match(appJs, /if \(payload\.issueLabels && typeof payload\.issueLabels === "object"\) state\.knowledgeInspectionIssueLabels = payload\.issueLabels;/);
  assert.match(functionSource("renderKnowledgeInspectionSummary"), /knowledgeInspectionRuleFindingTitleByCode\(item\.code\)/);
});

test("样式与响应式落在真实类名上（否则体检项看不出来源与严重度）", () => {
  assert.match(css, /\.knowledge-inspection-rule-findings\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.knowledge-inspection-rule-source\.is-rule\s*\{/);
  assert.match(css, /\.knowledge-inspection-rule-source\.is-ai\s*\{/);
  assert.match(css, /\.knowledge-inspection-rule-chip\.is-pass\s*\{/);
  assert.match(css, /\.knowledge-inspection-rule-chip\.is-medium\s*\{/);
  assert.match(css, /\.knowledge-inspection-rule-finding\.is-pass\s*\{/);
  assert.match(css, /\.knowledge-inspection-rule-findings-inline\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.knowledge-inspection-metric-group\.is-rule-findings\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /\.knowledge-inspection-metric-row\.is-rule-findings\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit/);
});

test("巡检记录状态里的处理人优先显示显示名（actorLabel），缺失才回落账号名", () => {
  const auditSource = functionSource("knowledgeInspectionAuditReview");
  assert.match(auditSource, /actorLabel: String\(review\.actorLabel \|\| ""\)/);
  const actorSource = functionSource("knowledgeInspectionAuditActorLabel");
  assert.match(actorSource, /audit\.actorLabel \|\| audit\.actor/);
  assert.match(functionSource("renderKnowledgeInspectionAuditState"), /knowledgeInspectionAuditActorLabel\(audit\)/);
  assert.match(functionSource("renderKnowledgeInspectionTable"), /knowledgeInspectionAuditActorLabel\(audit\)/);
});
