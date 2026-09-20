const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { formatAnswerMarkdownNodes, stripAnswerMarkdown } = require("../apps/miniprogram/utils/answer-markdown");
const { normalizeText } = require("../apps/miniprogram/utils/subjective-scoring");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");

test("answer Markdown renders short emphasis and preserves line breaks", () => {
  const nodes = formatAnswerMarkdownNodes("普通话是**现代汉民族共同语**。\n以**北京语音**为标准音。");
  const strongTexts = nodes
    .filter((node) => node && node.name === "strong")
    .map((node) => node.children[0].text);
  assert.deepEqual(strongTexts, ["现代汉民族共同语", "北京语音"]);
  assert.equal(nodes.some((node) => node && node.name === "br"), true);
});

test("answer emphasis never changes scoring normalization", () => {
  const emphasized = "普通话以**北京语音**为标准音，以**北方话**为基础方言。";
  const plain = "普通话以北京语音为标准音，以北方话为基础方言。";
  assert.equal(stripAnswerMarkdown(emphasized), plain);
  assert.equal(normalizeText(emphasized), normalizeText(plain));
});

test("admin answer editors expose direct rich editing and bold shortcuts", () => {
  const root = path.resolve(__dirname, "../apps/admin");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(html, /id="question-reference-bold"/);
  assert.match(html, /id="question-reference-answer-editor" class="answer-rich-input" contenteditable="true"/);
  assert.match(html, /id="question-ai-answer-editor" class="answer-rich-input" contenteditable="true"/);
  assert.match(html, /id="question-community-answer-editor" class="answer-rich-input" contenteditable="true"/);
  assert.match(html, /id="hide-official-answer"/);
  assert.match(html, /id="hide-ai-answer"/);
  assert.match(html, /id="hide-community-answer"/);
  assert.doesNotMatch(html, /question-reference-preview/);
  assert.match(script, /answerMarkdownEditor\("officialAnswer"/);
  assert.match(script, /answerMarkdownEditor\("aiAnswer"/);
  assert.match(script, /answerMarkdownEditor\("communityAnswer"/);
  assert.doesNotMatch(script, /<span>当前采用<\/span><select data-exam-field="answerSource"/);
  assert.match(script, /exam-answer-visibility-options/);
  assert.match(script, /hiddenAnswerVariants/);
  assert.match(script, /scoringPointsMarkdownEditor\(scoringPointsText\(question\.scoringPoints\)\)/);
  assert.match(html, /id="question-scoring-bold"/);
  assert.match(html, /id="question-scoring-points-editor" class="answer-rich-input" contenteditable="true"/);
  assert.match(html, /id="question-scoring-points" hidden/);
  assert.match(script, /toggleAnswerBold/);
  assert.match(script, /handleAnswerBoldShortcut/);
  assert.match(script, /document\.execCommand\("bold"/);
  assert.match(script, /answerRichTextToMarkdown/);
});

test("admin material editing is direct, fully expanded, and persists original marks", () => {
  const root = path.resolve(__dirname, "../apps/admin");
  const script = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(script, /class="material-rich-input" contenteditable="true"/);
  assert.match(script, /data-material-mark="underline"/);
  assert.match(script, /data-material-mark="double_underline"/);
  assert.match(script, /data-material-mark="wave"/);
  assert.match(script, /data-material-mark="dot"/);
  assert.match(script, /readMaterialRichEditor/);
  assert.match(script, /materialMarksForExamQuestion\(updatedStem, sharedMaterial\.materialMarks, original\.materialMarks\)/);
  assert.match(script, /materialMarks,/);
  assert.doesNotMatch(script, /value\("materialMarks"\)/);
  assert.match(styles, /\.material-rich-input[\s\S]*height: auto;/);
  assert.match(styles, /\.material-rich-input[\s\S]*overflow: visible;/);
});

test("saved AI answer prompts inherit the emphasis requirement", () => {
  const store = createMemoryAiConfigStore({
    prompts: {
      exam_answer_supplement: { systemPrompt: "自定义试卷答案提示词", userPromptTemplate: "{{question}}" },
      textbook_question_generation: { systemPrompt: "自定义教材出题提示词", userPromptTemplate: "{{bookMetadata}}" },
    },
  });
  const config = store.load();
  assert.match(config.prompts.exam_answer_supplement.systemPrompt, /referenceAnswer 字段中必须用 \*\*短语\*\*/);
  assert.match(config.prompts.exam_answer_supplement.systemPrompt, /客观题的 referenceAnswer 不得只报答案/);
  assert.match(config.prompts.exam_answer_supplement.systemPrompt, /不得把某位作者的整体创作归类套用到其全部作品/);
  assert.match(config.prompts.textbook_question_generation.systemPrompt, /referenceAnswer 字段中必须用 \*\*短语\*\*/);
});
