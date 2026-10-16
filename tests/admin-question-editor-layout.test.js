const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const editor = html.slice(
  html.indexOf('<dialog class="question-editor-dialog"'),
  html.indexOf('<dialog class="config-dialog directory-mapping-dialog"'),
);

test("题目编辑页按题目、答案、归属、难度、版本和底栏分层", () => {
  const order = [
    "question-basics-heading",
    "question-content-heading",
    "question-answer-heading",
    "question-editor-subtabs",
    "question-difficulty-details",
    "question-change-note",
    "question-editor-footer",
  ].map((id) => editor.indexOf(id));
  assert.ok(order.every((index) => index >= 0), "编辑器缺少必需结构");
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index - 1] < order[index], `${order[index - 1]} 应位于 ${order[index]} 之前`);
  }
  assert.match(editor, /训练归属/);
  assert.match(editor, /知识与教材/);
  assert.match(editor, /用户端展示设置/);
  assert.match(editor, /保存新版本/);
});

test("题型内容顺序保留材料题、选择题和其他题型所需字段", () => {
  const material = editor.indexOf('id="question-material"');
  const stem = editor.indexOf('id="question-stem"');
  const options = editor.indexOf('id="question-options"');
  const correct = editor.indexOf('id="question-correct-answer"');
  const answer = editor.indexOf('id="question-reference-answer"');
  assert.ok(material < stem && stem < options && options < correct && correct < answer);
  assert.match(editor, /class="question-material-editor"/);
  assert.match(css, /\.question-material-editor\s*\{[^}]*max-height:\s*330px[^}]*overflow:\s*auto/);
  assert.match(editor, /id="question-scoring-points-editor"/);
});

test("选项表格是唯一可见编辑器，旧输入只作为隐藏数据源", () => {
  assert.match(app, /choiceFields\.classList\.add\("has-option-table"\)/);
  assert.match(css, /\.question-choice-fields\.has-option-table\s*>\s*\.field\s*\{\s*display:\s*none/);
  assert.match(editor, /id="question-options"/);
  assert.match(editor, /id="question-correct-answer"/);
  assert.doesNotMatch(app, /问题知识范围分组/);
  assert.doesNotMatch(app, /question-option-knowledge-block/);
});

test("题型对应的题干或题干加选项会在指纹区域滚动时吸顶保留", () => {
  assert.match(editor, /id="question-editor-fixed-context"/);
  assert.match(editor, /id="question-editor-fixed-context-body"/);
  assert.match(app, /function syncQuestionEditorFixedContext\(/);
  assert.match(app, /choiceQuestionTypes\.has\(type\)\s*\?\s*questionOptionTableRows\(\)\.filter\(\(row\)\s*=>\s*row\.text\)\s*:\s*\[\]/);
  assert.match(app, /syncQuestionEditorFixedContext\(\)/);
  assert.match(css, /\.question-editor-fixed-context\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
  assert.match(css, /\.question-editor-subtabs\s*\{[^}]*top:\s*var\(--question-editor-fixed-context-height/);
});

test("答案依据与教材目录保持两个结构化字段，并提供快捷引用", () => {
  assert.match(editor, /依据来源/);
  assert.match(editor, /id="question-source-label"/);
  assert.match(editor, /id="question-source-page"/);
  assert.match(editor, /id="use-question-catalog-anchor-source"/);
  assert.match(app, /function useQuestionCatalogAnchorAsSource\(/);
  assert.match(app, /question-source-label/);
  assert.match(app, /question-source-page/);
});

test("题族集是题目到题族再到题族集的只读派生展示", () => {
  assert.match(editor, /所属题族集/);
  assert.match(editor, /id="question-family-set-attribution-list"/);
  assert.match(editor, /id="view-question-family-sets"/);
  assert.match(editor, /id="question-family-membership-list"/);
  assert.match(app, /set\.sources\.map/);
  assert.match(app, /未关联题族集/);
  assert.doesNotMatch(editor, /name="question-family-set|id="question-family-set-select/);
});

test("难度评估默认折叠，展示设置位于考试标签右侧展开", () => {
  assert.match(editor, /<details class="question-editor-section question-difficulty-section" id="question-difficulty-details">/);
  assert.doesNotMatch(editor, /<details[^>]*id="question-difficulty-details"[^>]*open/);
  assert.match(editor, /<div class="question-editor-footer">/);
  assert.match(editor, /id="question-exam-tags"[\s\S]*id="question-preview-settings-panel"/);
  assert.match(editor.slice(0, editor.indexOf("question-editor-footer")), /id="preview-(question|answer|analysis)"/);
  assert.doesNotMatch(editor, /id="toggle-question-preview-settings"/);
  assert.match(css, /\.question-inline-preview-settings\s*\{/);
  assert.match(css, /\.question-editor-section\[hidden\]\s*,\s*\.question-preview-settings\[hidden\]/);
});

test("切题时重置页签、搜索和展开状态，审核关闭不重复确认", () => {
  assert.match(app, /state\.questionMembershipSearchQuery = ""/);
  assert.match(app, /setQuestionEditorSectionTab\("training"\)/);
  assert.match(app, /questionReviewDiscardChanges/);
  assert.match(app, /const hasReviewSession = Boolean\(questionReview\)/);
  assert.match(app, /if \(!hasReviewSession && !questionEditorDiscardChanges\(\)\) return false/);
});
