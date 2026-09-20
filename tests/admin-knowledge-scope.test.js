const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "styles.css"), "utf8");

// 取某个顶层函数的源码片段（源码契约断言用；函数边界按行首的 "\n}" 判断）
function functionSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start > 0, `未找到函数 ${name}`);
  const end = appSource.indexOf("\n}", start);
  assert.ok(end > start, `未找到函数 ${name} 的结尾`);
  return appSource.slice(start, end);
}

// 说明：本文件只做源码契约断言（与仓库既有管理端测试一致）。这些纯函数的**真实行为**
// 由无头浏览器冒烟脚本 tmp/smoke-admin-scope.js 在页面上下文中直接调用活函数验证，
// 比在测试里抽取源码求值更可靠（抽取会被模板字符串/正则字面量里的括号干扰）。

test("admin knowledge scope: anchor helpers exist and share one judgment with the backend", () => {
  assert.match(appSource, /function isNodeWithinAnchor\(nodeMap, nodeId, anchorNodeId\)/);
  assert.match(appSource, /function partitionKnowledgeNodesByThemeAnchor\(nodeMap, nodeIds = \[\], anchorNodeId = ""\)/);
  // 判据：沿 parentId 上溯命中锚点即视为在范围内
  assert.match(appSource, /current = current\.parentId \? nodeMap\.get\(String\(current\.parentId\)\) : null;/);
  // 环保护：避免父子关系成环时死循环
  assert.match(appSource, /const guard = new Set\(\);/);
});

test("admin knowledge scope: saving a fingerprint blocks cross-theme range nodes before the API call", () => {
  assert.match(appSource, /partitionKnowledgeNodesByThemeAnchor\(\s*nodeMap,\s*problemKnowledgeRangeNodeIds,\s*knowledgeThemeRangeAnchorNodeId,/);
  assert.match(appSource, /不能加入问题知识范围/);
  assert.match(appSource, /跨主题的选项知识请只标注在该选项行/);
  // 文案不得再声称"题干和选项实际涉及的相关知识"（与主题锚点硬校验矛盾）
  assert.doesNotMatch(appSource, /题干和选项实际涉及的相关知识/);
  assert.match(appSource, /本题主题范围内的相关知识（受下方主题范围锚点约束）/);
});

test("admin knowledge scope: option badge is driven by the anchor and degrades safely", () => {
  assert.match(appSource, /function blindGoldOptionThemeScopeBadgeHtml\(nodes, selectedNodes = \[\], anchorNodeId = ""\)/);
  // 缺锚点或缺节点数据时不渲染徽标，避免用错误前提做判断
  assert.match(appSource, /if \(!anchor\) return "";/);
  assert.match(appSource, /if \(!nodeMap\.has\(anchor\)\) return "";/);
  assert.match(appSource, /if \(!nodeIds\.length\) return "";/);
  // 两种状态：入范围 / 跨主题仅记在选项
  assert.match(appSource, /data-blind-gold-option-scope="within"/);
  assert.match(appSource, /data-blind-gold-option-scope="cross_theme"/);
  assert.match(appSource, /跨主题 · 仅记在选项/);
  // 徽标必须接进选项表格渲染，且用同一锚点来源
  assert.match(appSource, /blindGoldOptionThemeScopeBadgeHtml\(nodes, displayedNodes, themeAnchorNodeId\)/);
  assert.match(appSource, /function blindGoldReviewThemeAnchorNodeId\(item = \{\}\)/);
});

test("admin knowledge scope: anchor provenance is recorded by the server for both write paths", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "apps", "api", "src", "server.js"), "utf8");
  // 重载路径与业务修正路径都要把主题锚点与问题知识范围写进指纹留痕
  assert.match(serverSource, /knowledgeThemeRangeAnchorNodeId: String\(fingerprint\.knowledgeThemeRangeAnchorNodeId/);
  assert.match(serverSource, /knowledgeThemeRangeAnchorNodeId: String\(formalFingerprint\?\.knowledgeThemeRangeAnchorNodeId/);
  assert.match(serverSource, /problemKnowledgeRangeNodeIds: \[\.\.\.new Set\(\[/);
});

test("admin knowledge scope: badge styles exist", () => {
  assert.match(stylesSource, /\.blind-gold-option-scope-badge\.is-in-scope/);
  assert.match(stylesSource, /\.blind-gold-option-scope-badge\.is-cross-theme/);
});

test("admin knowledge scope: range field shows anchor coverage and warns before save", () => {
  assert.match(appSource, /function syncQuestionFingerprintRangeCoverageHint\(\)/);
  assert.match(appSource, /syncQuestionFingerprintRangeCoverageHint\(\);/);
  // 覆盖良好时给出确认；越界时提前点名并说明会被拦下
  assert.match(appSource, /已覆盖全部 \$\{rangeNodeIds\.length\} 项/);
  assert.match(appSource, /未覆盖 \$\{outside\.length\} 项/);
  assert.match(appSource, /保存会被拦下，请移除这些节点或改锚点/);
  // 与保存前拦截共用同一个判据函数
  assert.match(appSource, /partitionKnowledgeNodesByThemeAnchor\(nodeMap, rangeNodeIds, anchorNodeId\)/);
});

test("admin knowledge scope: cross-theme range node is rejected at the moment of the attempt, with a modal", () => {
  // 单点受控判据复用同一个 isNodeWithinAnchor，避免"界面说能纳入、保存却被拒"
  assert.match(appSource, /function isQuestionRangeNodeWithinThemeAnchor\(nodeId\)/);
  assert.match(appSource, /return isNodeWithinAnchor\(nodeMap, nodeId, anchorNodeId\);/);
  // 勾选跨主题节点的当场撤销 + 弹窗，而不是只留一行小字、也不是拖到保存时才拦
  assert.match(appSource, /if \(optionInput\.checked && !isQuestionRangeNodeWithinThemeAnchor\(rangeNodeId\)\)/);
  assert.match(appSource, /optionInput\.checked = false;/);
  assert.match(appSource, /showQuestionRangeAnchorBlockedDialog\(rangeNodeId\);/);
  assert.match(appSource, /function showQuestionRangeAnchorBlockedDialog\(nodeId\)/);
  // 纯告知：隐藏"取消"，不制造一个没有意义的二选一
  assert.match(appSource, /confirmOnly: true/);
  assert.match(appSource, /cancelButton\.hidden = options\.confirmOnly === true;/);
  // 锚点未设置或知识树未加载时不得误判为跨主题（与后端"只有设了锚点才硬校验"一致）
  assert.match(appSource, /if \(!anchorNodeId\) return true;/);
  assert.match(appSource, /if \(!nodeMap\.has\(anchorNodeId\)\) return true;/);
});

test("admin knowledge scope: option-table controls share one height rule that can actually win", () => {
  // 四个同类"框"（文本输入框 / 角色下拉 / 知识关系下拉 / 涉及知识选择器）统一 24px
  assert.match(
    stylesSource,
    /\.question-option-table-editor-row input:not\(\[type="checkbox"\]\),\s*\n\.question-option-table-editor-row select \{[^}]*height: 24px;/,
  );
  // 涉及知识选择器必须用三个类的选择器。用两个类时，文件后面那条
  // ".blind-gold-knowledge-picker .question-family-multiselect-trigger { min-height: 36px }"
  // 同为两个类且后出现，会把它整条盖掉 —— 上一版就是这样"改了等于没改"的。
  assert.match(stylesSource, /\.question-option-table-editor-row \.question-family-multiselect \.question-family-multiselect-trigger \{[^}]*height: 24px;/);
  assert.doesNotMatch(stylesSource, /\.question-option-table-editor-row \.question-family-multiselect-trigger \{ min-height: 26px/);
  // 复选框是另一类控件，不参与高度统一，也不该被拉成整列宽
  assert.doesNotMatch(stylesSource, /\.question-option-table-editor-row input,\n\.question-option-table-editor-row select/);
});

test("admin knowledge scope: controlled hint is readable and the generic admin dialog is reachable", () => {
  // "问题知识范围"下方的受控说明此前是 8px，实测太小、容易被忽略
  assert.match(stylesSource, /\.question-fingerprint-editor-grid \.field > small \{[^}]*font-size: 11px;/);
  // 管理端通用弹窗入口（此前定义后无人调用），受控提示改由它承载
  assert.match(appSource, /function openDialog\(title, copy, options = \{\}\)/);
  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "index.html"), "utf8");
  assert.match(htmlSource, /id="action-dialog-cancel"/);
  assert.match(htmlSource, /id="action-dialog-confirm"/);
  assert.match(appSource, /document\.querySelector\("#action-dialog-cancel"\)/);
});

test("admin knowledge scope: every anchor judgement reads one shared tree, preferring the question's own tree", () => {
  // 统一取树入口：优先"这道题自己的树"，拿不到才退回"页面级的工作区教材树"
  assert.match(appSource, /function questionFingerprintNodes\(\)/);
  assert.match(appSource, /const own = \(state\.questionFingerprintStructure && state\.questionFingerprintStructure\.nodes\) \|\| \[\];/);
  assert.match(appSource, /return own\.length \? own : \(\(state\.knowledgeStructure && state\.knowledgeStructure\.nodes\) \|\| \[\]\);/);
  assert.match(appSource, /function questionFingerprintNodeMap\(\)/);
  assert.match(appSource, /return new Map\(questionFingerprintNodes\(\)\.map\(\(node\) => \[String\(node\.id\), node\]\)\);/);
  // 判据与两个显示位都必须走它，不得再各自从 state.knowledgeStructure 现搭 nodeMap
  // （两棵树不一致时——为空或另一本书——旧写法会让判据静默放行）
  assert.match(appSource, /function isQuestionRangeNodeWithinThemeAnchor\(nodeId\) \{[\s\S]{0,200}const nodeMap = questionFingerprintNodeMap\(\);/);
  assert.doesNotMatch(appSource, /new Map\(\(\(state\.knowledgeStructure && state\.knowledgeStructure\.nodes\) \|\| \[\]\)/);
  assert.doesNotMatch(appSource, /const nodes = \(\(state\.knowledgeStructure && state\.knowledgeStructure\.nodes\) \|\| \[\]\);\n  const nodeMap = new Map\(nodes\.map/);
});

test("admin knowledge scope: an unverifiable tree is reported instead of silently passing", () => {
  // 旧写法在"锚点不在树里"时直接退回通用文案，等于假装通过；现在必须明说这次没校验
  assert.doesNotMatch(appSource, /if \(!anchorNodeId \|\| !nodeMap\.has\(anchorNodeId\)\) \{\n    help\.textContent = base;/);
  assert.match(appSource, /if \(!nodeMap\.size \|\| !nodeMap\.has\(anchorNodeId\)\) \{/);
  assert.match(appSource, /知识树未加载/);
  assert.match(appSource, /当前知识树里找不到所选主题锚点/);
  assert.match(appSource, /本次无法校验问题知识范围是否在锚点内；保存时仍会被服务端拦下。/);
  // 仍然"不拦"：拿不到树时不误伤，交给服务端的锚点硬校验兜底
  assert.match(appSource, /if \(!nodeMap\.has\(anchorNodeId\)\) return true;/);
});

test("admin knowledge scope: the range help text has exactly one owner", () => {
  // 「问题知识范围」的说明文案只能由 syncQuestionFingerprintRangeCoverageHint() 写。
  // syncQuestionFingerprintPrimaryRoleUi() 会在它**之后**被调用（renderQuestionFingerprintEditor），
  // 如果那里又写死一句基础文案，就会把刚算好的"已覆盖 / 未覆盖 / 本次无法校验"清掉 ——
  // 实测表现：打开编辑器后覆盖提示永远只剩基础文案（要等下一次交互才出现），告警也会被吞掉。
  const roleUiSource = functionSource("syncQuestionFingerprintPrimaryRoleUi");
  assert.doesNotMatch(roleUiSource, /本题主题范围内的相关知识/);
  assert.doesNotMatch(roleUiSource, /rangeHelp/);
  assert.match(roleUiSource, /syncQuestionFingerprintRangeCoverageHint\(\);/);
});

