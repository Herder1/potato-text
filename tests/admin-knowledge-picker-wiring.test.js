const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "app.js"), "utf8");

function functionSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start > 0, `未找到函数 ${name}`);
  const end = appSource.indexOf("\n}", start);
  assert.ok(end > start, `未找到函数 ${name} 的结尾`);
  return appSource.slice(start, end);
}

function between(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  assert.ok(start > 0, `未找到起点 ${startMarker}`);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(end > start, `未找到终点 ${endMarker}`);
  return appSource.slice(start, end);
}

// 节点选择器（金标 / 逐选项知识 / 巡检对话框共用同一个渲染函数）的交互接线。
//
// 背景（2026-09-20 实测）：这三件事原先分别写在金标表单、巡检对话框、编辑页行绑定里各一份，
// 而且"打开面板"和"处理选项点击"都绑在 #blind-gold-review-form 上 —— 于是**编辑页的选择器
// 打不开面板、点了也没反应**。前驱的冒烟是"直接改 select 再派发 change"，绕过了真实点击，所以没抓到。
// 现在统一为：组件在 document 级代理交互 + 广播 knowledge-picker-change，页面各自监听并写自己的状态。

test("knowledge picker: 交互在 document 级代理，三条宿主共用一份实现", () => {
  assert.match(appSource, /function applyKnowledgePickerOptionClick\(root, pickerOption\)/);
  assert.match(
    appSource,
    /document\.addEventListener\("click", \(event\) => \{\s*\n\s*const trigger = event\.target\.closest\("\[data-blind-gold-knowledge-trigger\]"\);/,
  );
  assert.match(
    appSource,
    /document\.addEventListener\("change", \(event\) => \{\s*\n\s*const pickerOption = event\.target\.closest\("\[data-blind-gold-knowledge-option\]"\);/,
  );
  // 打开前先渲染，避免出现空面板（编辑页原先就是空面板 + 无人处理点击）
  assert.match(appSource, /if \(open\) renderBlindGoldKnowledgePicker\(root\);\s*\/\/ 打开前先渲染/);
});

test("knowledge picker: 组件只广播统一事件，不再写任何页面状态", () => {
  const applySource = functionSource("applyKnowledgePickerOptionClick");
  assert.match(applySource, /root\.dispatchEvent\(new CustomEvent\("knowledge-picker-change", \{/);
  // 组件里不得出现任何产线状态写回
  assert.doesNotMatch(applySource, /rememberBlindGoldFamilyContribution/);
  assert.doesNotMatch(applySource, /knowledgeInspectionRememberFamilyContribution/);
  assert.doesNotMatch(applySource, /blindGoldFamilyContributionDirtyKeys/);
  assert.doesNotMatch(applySource, /clearKnowledgeInspectionCommit/);
});

test("knowledge picker: 两条产线各自监听统一事件做回写", () => {
  // 金标审核条目
  assert.match(
    appSource,
    /document\.querySelector\("#blind-gold-review-form"\)\.addEventListener\("knowledge-picker-change"/,
  );
  const goldListener = between(
    'document.querySelector("#blind-gold-review-form").addEventListener("knowledge-picker-change"',
    "document.querySelector(\"#blind-gold-answer-knowledge\")",
  );
  assert.match(goldListener, /rememberBlindGoldFamilyContribution\(root\)/);
  assert.match(goldListener, /blindGoldFamilyContributionDirtyKeys\.add/);
  assert.match(goldListener, /renderBlindGoldFamilyContributions\(\)/);
  // 巡检草稿
  assert.match(
    appSource,
    /document\.querySelector\("#knowledge-inspection-dialog"\)\.addEventListener\("knowledge-picker-change"/,
  );
  assert.match(appSource, /handleKnowledgeInspectionContributionOptionChange\(root\)/);
  assert.match(functionSource("handleKnowledgeInspectionContributionOptionChange"), /knowledgeInspectionRememberFamilyContribution/);
});

test("knowledge picker: 金标表单不再自己处理选择器的开合与选项点击（否则会双重处理）", () => {
  const goldChangeHandler = between(
    'document.querySelector("#blind-gold-review-form").addEventListener("change"',
    'document.querySelector("#blind-gold-review-form").addEventListener("input"',
  );
  assert.doesNotMatch(goldChangeHandler, /data-blind-gold-knowledge-option/);
  const goldClickHandler = between(
    'document.querySelector("#blind-gold-review-form").addEventListener("click"',
    'document.querySelector("#blind-gold-answer-knowledge").addEventListener("click"',
  );
  assert.doesNotMatch(goldClickHandler, /data-blind-gold-knowledge-trigger/);
  // 巡检侧旧的 change 分发器已经删掉，不要再从那里走一遍
  assert.doesNotMatch(appSource, /handleKnowledgeInspectionDialogChange/);
});
