const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const ui = fs.readFileSync(path.join(root, "assessment-modes.js"), "utf8");
const css = fs.readFileSync(path.join(root, "assessment-modes.css"), "utf8");

test("考法选项读取标准接口，不在前端复制分类定义，旧动作只隐藏不迁移", () => {
  assert.match(html, /id="question-fingerprint-action" type="hidden"/);
  assert.match(html, /id="question-assessment-modes"[^>]*data-assessment-modes/);
  assert.match(ui, /knowledge-classification\/assessment-modes/);
  assert.doesNotMatch(ui, /作者作品对应|ancient-literature-c01/);
  assert.ok(html.indexOf('src="assessment-modes.js') < html.indexOf('src="app.js'));
  assert.match(app, /assessmentModeUi\(\)\.loadQuestion\(question\)/);
});

test("考法独立保存使用版本校验；候选只填入，输入事件不污染旧题目表单", () => {
  assert.match(ui, /expectedQuestionVersion: current\.questionVersion/);
  assert.match(ui, /expectedRevision: current\.assignment\?\.revision/);
  assert.match(ui, /modeVersions:/);
  assert.match(ui, /AI 建议 · 未确认/);
  assert.match(ui, /dirty = true;\s+renderOptions\(\);\s+note\("AI 建议已填入，尚未确认"\)/);
  assert.match(ui, /picker\.addEventListener\("input", \(event\) => \{\s+event\.stopPropagation\(\)/);
  assert.match(ui, /picker\.addEventListener\("change", \(event\) => \{[\s\S]{0,150}event\.stopPropagation\(\)/);
  assert.match(app, /event\.target\.closest\("\[data-assessment-modes\]"\)/);
});

test("标准管理有版本历史、引用题目和状态，显隐与窄屏样式有兜底", () => {
  assert.match(html, /data-teaching-section="modes"/);
  assert.match(ui, /修订历史/);
  assert.match(ui, /\/impact/);
  assert.match(ui, /await openQuestion\(button\.dataset\.modeQuestion\)/);
  assert.match(css, /#assessment-mode-standards\[hidden\]/);
  assert.match(css, /#question-assessment-modes \[hidden\]/);
  assert.match(css, /display:\s*none !important/);
  assert.match(css, /@media \(max-width: 700px\)/);
});

test("定义与例题在名称同行独立展开，勾选重绘保留展开态和焦点", () => {
  assert.match(ui, /class="assessment-mode-option-heading"[\s\S]*?<\/label>\s*<button type="button" class="assessment-mode-help"/);
  assert.match(ui, /aria-expanded="\$\{expandedModes\.has\(mode\.id\)\}" aria-controls="assessment-mode-definition-/);
  assert.match(ui, /class="assessment-mode-definition"[^>]*\$\{expandedModes\.has\(mode\.id\) \? "" : "hidden"\}/);
  assert.match(ui, /help\.setAttribute\("aria-expanded", String\(expanded\)\)/);
  assert.match(ui, /getElementById\(help\.getAttribute\("aria-controls"\)\)\.hidden = !expanded;\s+return;/);
  assert.match(ui, /expandedModes\.clear\(\)/);
  assert.match(ui, /focusedHelpId[\s\S]*?focus\(\{ preventScroll: true \}\)/);
  assert.match(css, /\.assessment-mode-option-heading \{ display: flex;/);
  assert.match(css, /\.assessment-mode-help:focus-visible/);
});

test("考法操作跟在选择框后，宽屏同行靠右，窄屏换行", () => {
  assert.match(ui, /class="assessment-mode-control-row">\s*<details class="assessment-mode-picker">[\s\S]*?<\/details>\s*<div class="assessment-mode-actions">/);
  assert.match(css, /\.assessment-mode-control-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.assessment-mode-actions \{[^}]*justify-content: flex-end/);
  assert.match(css, /@media \(max-width: 700px\) \{\s*\.assessment-mode-control-row \{ grid-template-columns: minmax\(0, 1fr\)/);
});

test("AI 建议请求期间按钮显示生成状态，完成后恢复", () => {
  assert.match(ui, /aiButton\.textContent = busy && operation === "suggest" \? "生成中…" : "AI 建议"/);
  assert.match(ui, /aiButton\.disabled = busy/);
  assert.match(ui, /operation = kind;[\s\S]*?renderOptions\(\)/);
  assert.match(ui, /finally \{\s+busy = false;\s+operation = "";\s+setBusy\(false\);\s+renderOptions\(\)/);
  assert.match(css, /\[data-mode-ai\] \{ min-width: 76px; \}/);
});
