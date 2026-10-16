const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { position, attach } = require("../apps/admin/question-editor-help");
const read = (file) => fs.readFileSync(path.join(__dirname, "../apps/admin", file), "utf8");
const html = read("index.html");
const app = read("app.js");
const css = read("styles.css");

test("detail field instructions have stable help sources and corresponding label anchors", () => {
  const section = html.slice(html.indexOf('<dialog class="question-editor-dialog"'), html.indexOf('<dialog class="config-dialog directory-mapping-dialog"'));
  const sources = [...section.matchAll(/data-question-help-for="(#[^"]+)"/g)];
  assert.equal(sources.length, 11);
  for (const [, selector] of sources) assert.ok(section.includes(`id="${selector.slice(1)}"`), selector);
  for (const id of ["question-fingerprint-core-help", "question-fingerprint-required-help", "question-fingerprint-range-help", "question-catalog-anchor-hint"]) {
    assert.match(section, new RegExp(`id="${id}"[^>]*data-question-help-for=`));
  }
  assert.doesNotMatch(section, /class="question-classification-hint-row"/);
});

test("written input explanations use placeholder content, not additional visible paragraphs", () => {
  assert.match(html, /id="question-scoring-points-editor"[^>]*data-answer-placeholder="每行：分值 \| 内容 \| 教材页码[^"\n]+完成配分后才能使用结构化 AI 评分/);
  assert.doesNotMatch(html, /<p class="field-hint">得分点不影响题目保存或发布/);
  assert.match(html, /<label for="question-scoring-points-editor">结构化得分点<\/label>/);
  for (const id of ["question-material", "question-material-group", "question-annotation-text", "question-correct-answer", "question-source-label", "question-source-page", "question-change-note"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*placeholder="[^"\\n]+"`));
  }
});

test("actionable alerts remain inline and source text updates stay authoritative", () => {
  assert.match(app, /hint\.dataset\.questionHelpInline = String\(Boolean\(bookId/);
  assert.match(app, /help\.dataset\.questionHelpInline = "false"/);
  assert.match(app, /editorStatus\.dataset\.questionHelpInline = String\(Boolean\(!question \|\| message \|\| state\.questionEditorContentDirty\)\)/);
  assert.match(css, /\[data-question-help-for\]:not\(\[data-question-help-inline="true"\]\)/);
  assert.match(css, /\.question-detail-help-trigger\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.question-detail-help-tooltip:not\(:popover-open\)\s*\{\s*display:\s*none/);
});

test("help supports keyboard focus, touch activation and Escape without changing form values", () => {
  const source = read("question-editor-help.js");
  for (const event of ["pointerover", "focusin", "click", "keydown", "close", "scroll"]) assert.ok(source.includes(`addEventListener("${event}"`));
  assert.match(source, /aria-describedby/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.doesNotMatch(source, /requestJson|fetch\(|\.value\s*=/);
  assert.equal(attach(null), null);
  assert.match(source, /questionPlaceholderEmpty/);
  assert.match(css, /data-question-placeholder-empty="true"/);
});

test("tooltip placement flips and clamps at viewport edges", () => {
  assert.deepStrictEqual(position({ left: 100, top: 40, bottom: 60 }, { width: 220, height: 80 }, { width: 800, height: 600 }), { left: 100, top: 68 });
  assert.deepStrictEqual(position({ left: 760, top: 560, bottom: 580 }, { width: 220, height: 80 }, { width: 800, height: 600 }), { left: 572, top: 472 });
  assert.deepStrictEqual(position({ left: -20, top: 10, bottom: 30 }, { width: 344, height: 584 }, { width: 360, height: 600 }), { left: 8, top: 8 });
});

test("help script loads before app initialization and shares the current cache version", () => {
  assert.ok(html.indexOf('src="question-editor-help.js') < html.indexOf('src="app.js'));
  const versions = [...html.matchAll(/(?:src|href)="(?:styles\.css|app\.js|question-editor-help\.js)\?v=([^"]+)/g)].map((match) => match[1]);
  assert.equal(versions.length, 3);
  assert.equal(new Set(versions).size, 1);
});

test("empty scoring notices consume no space while real scoring warnings and actions stay visible", () => {
  const notice = {};
  const context = vm.createContext({ document: { querySelector: () => notice }, escapeHtml: (value) => value });
  vm.runInContext(app.slice(app.indexOf("function scoringStructureLabel("), app.indexOf("function scoringCandidateDraftText(")), context);
  context.renderQuestionScoringStructure({ scoringPointStatus: "not_required" });
  assert.equal(notice.hidden, true);
  assert.equal(notice.innerHTML, "");
  context.renderQuestionScoringStructure({ scoringPointStatus: "score_mismatch" });
  assert.equal(notice.hidden, false);
  assert.match(notice.innerHTML, /得分点分值合计与题目总分不一致/);
  context.renderQuestionScoringStructure({ scoringPointStatus: "needs_score_allocation", scoringPointCandidates: [{}, {}] });
  assert.equal(notice.hidden, false);
  assert.match(notice.innerHTML, /已识别 2 个自然分点/);
  assert.match(notice.innerHTML, /id="apply-question-scoring-candidates"/);
});
