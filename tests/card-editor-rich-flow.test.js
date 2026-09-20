const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STORAGE_KEY = "shukao_card_box_sets";
const CLOZE_COLOR = "#168fd8";
const MOCK_WINDOW_WIDTH = 390;

function makeSet(cards = []) {
  return {
    id: "set-1",
    title: "测试卡集",
    customSetField: "keep-set",
    cards: structuredClone(cards),
  };
}

function createEditorFlow(cards = []) {
  let definition;
  let keyboardHeightHandler;
  let removedKeyboardHeightHandler;
  let backCount = 0;
  const toastTitles = [];
  const storage = new Map([[STORAGE_KEY, [makeSet(cards)]]]);

  global.Page = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: MOCK_WINDOW_WIDTH }),
    getSystemInfoSync: () => ({ statusBarHeight: 44, windowWidth: MOCK_WINDOW_WIDTH }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, left: 290, width: 87, height: 32 }),
    onKeyboardHeightChange: (handler) => { keyboardHeightHandler = handler; },
    offKeyboardHeightChange: (handler) => { removedKeyboardHeightHandler = handler; },
    navigateBack: () => { backCount += 1; },
    showToast: ({ title }) => { toastTitles.push(title); },
  };

  const modulePath = require.resolve("../apps/miniprogram/pages/card-editor/card-editor.js");
  delete require.cache[modulePath];
  require(modulePath);

  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };

  return {
    page,
    storage,
    savedSet: () => storage.get(STORAGE_KEY)[0],
    keyboardHandler: () => keyboardHeightHandler,
    removedKeyboardHandler: () => removedKeyboardHeightHandler,
    backCount: () => backCount,
    toastTitles,
  };
}

function editorWithContents(contents) {
  return {
    getContents({ success }) { success(structuredClone(contents)); },
  };
}

test("new cards save rich and plain answer tracks without legacy hints", () => {
  const flow = createEditorFlow();
  flow.page.onLoad({ setId: "set-1", type: "qa" });
  flow.page.setData({ question: "  什么是共同语？  ", section: "第一章", mnemonic: "共同规范" });
  flow.page.editorCtx = editorWithContents({
    html: "<p><strong>以北京语音</strong>为标准音。</p>",
    text: "以北京语音为标准音。\n",
    delta: {
      ops: [
        { insert: "以北京语音", attributes: { bold: true } },
        { insert: "为标准音。\n" },
      ],
    },
  });

  flow.page.save();
  flow.page.save();

  assert.equal(flow.savedSet().cards.length, 1);
  const saved = flow.savedSet().cards[0];
  assert.equal(saved.question, "什么是共同语？");
  assert.equal(saved.answer, "以北京语音为标准音。");
  assert.equal(saved.answerHtml, "<p><strong>以北京语音</strong>为标准音。</p>");
  assert.deepEqual(saved.answerDelta.ops, [
    { insert: "以北京语音", attributes: { bold: true } },
    { insert: "为标准音。\n", attributes: undefined },
  ]);
  assert.deepEqual(saved.answerSegments, [{ text: "以北京语音为标准音。", cloze: false }]);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "hints"), false);
  assert.deepEqual(saved.associations, []);
  assert.equal(saved.state, "new");
  assert.equal(flow.backCount(), 1);
  assert.deepEqual(flow.toastTitles, []);
});

test("editing replaces one card by id and preserves learning and unknown fields", () => {
  const original = {
    id: "card-1",
    type: "qa",
    section: "旧目录",
    question: "旧问题",
    answer: "旧答案",
    answerHtml: "<p>旧答案</p>",
    answerDelta: { ops: [{ insert: "旧答案\n" }] },
    associations: ["相关知识"],
    state: "learning",
    mastery: "hard",
    futureField: { keep: true },
  };
  const untouched = { id: "card-2", question: "不应变化", answer: "第二张" };
  const flow = createEditorFlow([original, untouched]);
  flow.page.onLoad({ setId: "set-1", cardId: "card-1" });
  assert.equal(flow.page.data.isEditing, true);
  assert.equal(flow.page.data.question, "旧问题");

  flow.page.setData({ question: "新问题", section: "新目录", mnemonic: "新口诀" });
  flow.page.editorCtx = editorWithContents({
    html: "<p><em>新答案</em></p>",
    text: "新答案\n",
    delta: { ops: [{ insert: "新答案", attributes: { italic: true } }, { insert: "\n" }] },
  });
  flow.page.save();

  const cards = flow.savedSet().cards;
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.id), ["card-1", "card-2"]);
  assert.equal(cards[0].question, "新问题");
  assert.equal(cards[0].answer, "新答案");
  assert.equal(cards[0].answerHtml, "<p><em>新答案</em></p>");
  assert.equal(cards[0].state, "learning");
  assert.equal(cards[0].mastery, "hard");
  assert.deepEqual(cards[0].associations, ["相关知识"]);
  assert.deepEqual(cards[0].futureField, { keep: true });
  assert.deepEqual(cards[1], untouched);
  assert.equal(flow.savedSet().customSetField, "keep-set");
  assert.equal(flow.backCount(), 1);
});

test("blue underlined Delta runs are persisted as cloze segments", () => {
  const flow = createEditorFlow();
  flow.page.onLoad({ setId: "set-1" });
  flow.page.setData({ question: "语言的本质是什么？" });
  flow.page.editorCtx = editorWithContents({
    html: '<p>语言是<span style="color: rgb(22, 143, 216); text-decoration: underline;">共同交际工具</span>。</p>',
    text: "语言是共同交际工具。\n",
    delta: {
      ops: [
        { insert: "语言是" },
        { insert: "共同交际工具", attributes: { color: "rgb(22, 143, 216)", underline: true } },
        { insert: "。\n" },
      ],
    },
  });

  flow.page.save();

  assert.deepEqual(flow.savedSet().cards[0].answerSegments, [
    { text: "语言是", cloze: false },
    { text: "共同交际工具", cloze: true },
    { text: "。", cloze: false },
  ]);
  flow.page.editorCtx = {
    formatCalls: [],
    getSelectionText({ success }) { success({ text: "共同交际工具" }); },
    format(name, value) { this.formatCalls.push([name, value]); },
  };
  flow.page.markCloze();
  assert.deepEqual(flow.page.editorCtx.formatCalls, [
    ["color", CLOZE_COLOR],
    ["underline", true],
  ]);

  flow.page.editorCtx = {
    formatCalls: [],
    getSelectionText({ success }) { success({ text: "" }); },
    format(name, value) { this.formatCalls.push([name, value]); },
  };
  flow.page.markCloze();
  assert.deepEqual(flow.page.editorCtx.formatCalls, []);
  assert.equal(flow.toastTitles.at(-1), "请先选择文字");
});

test("answer toolbar stays inline without a keyboard and docks only above an active keyboard", () => {
  const flow = createEditorFlow();
  flow.page.onLoad({ setId: "set-1" });
  const keyboardHandler = flow.keyboardHandler();
  assert.equal(typeof keyboardHandler, "function");

  // Desktop developer tools may focus the editor without ever reporting a
  // software-keyboard height. The toolbar must remain available inline.
  flow.page.onAnswerFocus();
  assert.equal(flow.page.data.keyboardHeight, 0);
  assert.equal(flow.page.data.toolbarDocked, false);
  assert.equal(flow.page.data.keyboardToolbarVisible, false);
  flow.page.toggleAssistant();
  assert.equal(flow.page.data.assistantOpen, true);
  flow.page.toggleAssistant();
  assert.equal(flow.page.data.assistantOpen, false);

  keyboardHandler({ height: 312 });
  assert.equal(flow.page.data.keyboardHeight, 312);
  assert.equal(flow.page.data.toolbarDocked, true);
  assert.equal(flow.page.data.keyboardToolbarVisible, true);
  assert.equal(flow.page.data.keyboardSpacerHeight, 312 + 96 * MOCK_WINDOW_WIDTH / 750 + 16);

  // Focusing a plain field while the keyboard is still open returns the same
  // toolbar element to its inline home rather than leaving it above the keyboard.
  flow.page.onPlainFieldFocus();
  assert.equal(flow.page.data.toolbarDocked, false);
  assert.equal(flow.page.data.keyboardToolbarVisible, false);
  assert.equal(flow.page.data.keyboardSpacerHeight, 0);

  flow.page.onAnswerFocus();
  assert.equal(flow.page.data.toolbarDocked, true);
  flow.page.setData({ assistantOpen: true, toolbarLevel: "secondary" });
  keyboardHandler({ height: 0 });
  assert.equal(flow.page.data.keyboardHeight, 0);
  assert.equal(flow.page.data.toolbarDocked, false);
  assert.equal(flow.page.data.keyboardToolbarVisible, false);
  assert.equal(flow.page.data.keyboardSpacerHeight, 0);
  assert.equal(flow.page.data.assistantOpen, false);
  assert.equal(flow.page.data.toolbarLevel, "primary");

  flow.page.onUnload();
  assert.equal(flow.removedKeyboardHandler(), keyboardHandler);
});

test("card editor keeps one hybrid toolbar at the top of the answer card", () => {
  const markup = fs.readFileSync(
    path.join(__dirname, "../apps/miniprogram/pages/card-editor/card-editor.wxml"),
    "utf8",
  );
  const styles = fs.readFileSync(
    path.join(__dirname, "../apps/miniprogram/pages/card-editor/card-editor.wxss"),
    "utf8",
  );

  assert.doesNotMatch(markup, /提示分点|data-field="hint"|\{\{hint\}\}/);
  assert.match(markup, /<editor[\s\S]*id="card-answer-editor"[\s\S]*bindinput="onAnswerInput"/);

  const answerStart = markup.indexOf('<view class="field answer-field">');
  // 口诀字段现在带 wx:if（笔记卡不显示），所以按前缀找下一个字段块，不要求标签完全一致。
  const nextFieldMatch = /<view class="field compact/.exec(markup.slice(answerStart + 1));
  const nextField = nextFieldMatch ? answerStart + 1 + nextFieldMatch.index : markup.length;
  const answerMarkup = markup.slice(answerStart, nextField);
  const anchorStart = answerMarkup.indexOf('class="answer-tools-anchor');
  const editorStart = answerMarkup.indexOf('<editor');
  assert.ok(answerStart >= 0 && nextField > answerStart, "answer card markup should be present");
  assert.ok(anchorStart >= 0 && anchorStart < editorStart, "toolbar anchor should sit below the answer label and above the editor");
  assert.match(answerMarkup, /class="answer-tools-anchor \{\{toolbarDocked \? 'answer-tools-anchor-docked' : 'answer-tools-anchor-inline'\}\}"/);
  assert.match(answerMarkup, /class="keyboard-toolbar"/);
  assert.match(answerMarkup, /class="memory-assistant"[\s\S]*wx:if="\{\{assistantOpen\}\}"/);

  assert.equal((markup.match(/class="keyboard-toolbar"/g) || []).length, 1, "toolbar must not be duplicated for inline and docked layouts");
  assert.equal((markup.match(/class="memory-assistant"/g) || []).length, 1, "assistant panel must not be duplicated for the two layouts");
  assert.doesNotMatch(markup, /class="keyboard-toolbar"[^>]*wx:if="\{\{keyboardToolbarVisible\}\}"/);
  assert.doesNotMatch(markup, /class="memory-assistant"[^>]*keyboardToolbarVisible/);
  assert.match(answerMarkup, /class="answer-tools-anchor[\s\S]*keyboardHeight/);

  assert.match(markup, /class="toolbar-track" wx:if="\{\{toolbarLevel === 'primary'\}\}"/);
  assert.match(markup, /class="toolbar-track toolbar-secondary" wx:else/);
  assert.equal((markup.match(/class="assistant-action"/g) || []).length, 3);
  ["autoCloze", "autoHighlight", "createMnemonic"].forEach((handler) => {
    assert.match(markup, new RegExp(`class="assistant-action" catchtouchend="${handler}"`));
  });

  const dockedAnchorRule = styles.match(/\.answer-tools-anchor-docked\s*\{([^}]*)\}/);
  const inlineAssistantRule = styles.match(/\.answer-tools-anchor-inline\s+\.memory-assistant\s*\{([^}]*)\}/);
  const dockedAssistantRule = styles.match(/\.answer-tools-anchor-docked\s+\.memory-assistant\s*\{([^}]*)\}/);
  const answerFieldRule = styles.match(/\.answer-field\s*\{([^}]*)\}/);
  const toolbarRule = styles.match(/\.keyboard-toolbar\s*\{([^}]*)\}/);
  assert.ok(answerFieldRule, "answer card styles should exist");
  assert.doesNotMatch(answerFieldRule[1], /overflow:\s*hidden/, "the inline assistant must not be clipped by the answer card");
  assert.ok(toolbarRule, "toolbar styles should exist");
  assert.doesNotMatch(toolbarRule[1], /position:\s*fixed/, "the shared anchor, not a second toolbar layout, owns fixed positioning");
  assert.ok(dockedAnchorRule, "docked toolbar anchor styles should exist");
  assert.match(dockedAnchorRule[1], /position:\s*fixed/);
  assert.ok(inlineAssistantRule, "inline assistant direction should be explicit");
  assert.match(inlineAssistantRule[1], /top:\s*calc\(100%\s*\+/);
  assert.ok(dockedAssistantRule, "docked assistant direction should be explicit");
  assert.match(dockedAssistantRule[1], /bottom:\s*calc\(100%\s*\+/);
});

test("note cards edit like a note and no longer ask for a directory", () => {
  const markup = fs.readFileSync(
    path.join(__dirname, "../apps/miniprogram/pages/card-editor/card-editor.wxml"),
    "utf8",
  );

  // 笔记卡用"标题 / 内容"的写法，问答卡和主题卡保持"卡片正面 / 卡片背面"。
  assert.match(markup, /\{\{type === 'note' \? '标题' : '卡片正面'\}\}/);
  assert.match(markup, /\{\{type === 'note' \? '内容' : '卡片背面'\}\}/);
  assert.match(markup, /placeholder="\{\{type === 'note' \? '输入标题' : '输入问题或标题'\}\}"/);
  assert.match(markup, /placeholder="\{\{type === 'note' \? '输入内容' : '输入答案或内容'\}\}"/);
  // 口诀只对问答卡与主题卡有意义。
  assert.match(markup, /<view class="field compact" wx:if="\{\{type !== 'note'\}\}">\s*<label>口诀（选填）<\/label>/);
  // 卡片归属由所处目录决定（在哪个目录新建、被拖到哪个目录），编辑页不再有"所属目录"输入。
  assert.doesNotMatch(markup, /所属目录/);
  assert.doesNotMatch(markup, /data-field="section"/);
});

test.afterEach(() => {
  delete global.Page;
  delete global.wx;
});
