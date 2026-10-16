const test = require("node:test");
const assert = require("node:assert/strict");

const CARD_SETS_KEY = "shukao_card_box_sets";
const CLOZE_COLOR = "#168fd8";

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function effectiveIndexes(value) {
  return Array.from(value)
    .map((char, index) => /[\u3400-\u9fffA-Za-z0-9]/u.test(char) ? index : -1)
    .filter((index) => index >= 0);
}

function visibleEffectiveIndexes(line) {
  const visible = [];
  let cursor = 0;
  (line.parts || []).forEach((part) => {
    const chars = Array.from(part.text || "");
    if (part.type === "text") {
      chars.forEach((char, offset) => {
        if (/[\u3400-\u9fffA-Za-z0-9]/u.test(char)) visible.push(cursor + offset);
      });
    }
    cursor += chars.length;
  });
  return visible;
}

function clozeContextIndexes(body, phrase) {
  const chars = Array.from(body);
  const wanted = Array.from(phrase);
  const start = chars.findIndex((_, index) => chars.slice(index, index + wanted.length).join("") === phrase);
  assert.notEqual(start, -1, `fixture phrase ${phrase} must exist in its answer point`);
  const content = effectiveIndexes(body);
  const marked = content.filter((index) => index >= start && index < start + wanted.length);
  const first = content.indexOf(marked[0]);
  const last = content.indexOf(marked.at(-1));
  return content.slice(Math.max(0, first - 1), Math.min(content.length, last + 2));
}

function attributesAt(delta, wantedIndex) {
  let offset = 0;
  for (const op of delta.ops || []) {
    if (typeof op.insert !== "string") continue;
    const end = offset + op.insert.length;
    if (wantedIndex >= offset && wantedIndex < end) return op.attributes || {};
    offset = end;
  }
  return {};
}

function loadPage(modulePath) {
  let definition;
  global.Page = (value) => { definition = value; };
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  require(resolved);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

test("AI clozes survive editor save and exclusively control progressive hint reveals", async () => {
  const answerPoints = [
    "普通话以北京语音为标准音，服务全国交际。",
    "语法规范以典范的现代白话文著作为依据。",
    "未经标记的这一分点必须保持隐藏。",
  ];
  const answer = answerPoints.map((point, index) => `${index + 1}.${point}`).join("\n");
  const clozePhrases = ["北京语音", "现代白话文著作"];
  const ranges = clozePhrases.map((phrase, index) => {
    const start = answer.indexOf(phrase);
    return {
      conceptId: `concept-${index + 1}`,
      pointId: `p${index + 1}`,
      start,
      end: start + phrase.length,
      text: phrase,
    };
  });
  const storage = new Map([[CARD_SETS_KEY, [{
    id: "set-ai-cloze",
    title: "AI 挖空闭环",
    cards: [],
  }]]]);
  const requests = [];
  let currentContents = {
    text: `${answer}\n`,
    html: `<p>${answer.replace(/\n/g, "</p><p>")}</p>`,
    delta: { ops: [{ insert: `${answer}\n` }] },
  };
  const app = {
    globalData: {
      userId: "ai-cloze-flow-user",
      beans: 0.3,
      apiBaseUrl: "http://127.0.0.1:3212",
      authToken: "test-token",
    },
    apiBaseUrlCandidates: () => ["http://127.0.0.1:3212"],
    spendBeans(amount) {
      this.globalData.beans = Math.round((this.globalData.beans - amount) * 10) / 10;
      return true;
    },
  };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 390 }),
    getSystemInfoSync: () => ({ statusBarHeight: 44, windowWidth: 390 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, left: 290, width: 87, height: 32 }),
    onKeyboardHeightChange: () => {},
    offKeyboardHeightChange: () => {},
    showToast: () => {},
    navigateBack: () => {},
    request(options) {
      requests.push(options);
      return { abort() {} };
    },
  };

  const editor = loadPage("../apps/miniprogram/pages/card-editor/card-editor.js");
  editor.onLoad({ setId: "set-ai-cloze", type: "qa" });
  editor.setData({ question: "普通话的语音和语法规范是什么？" });
  editor.editorCtx = {
    getContents({ success }) { success(structuredClone(currentContents)); },
    setContents({ delta, success }) {
      currentContents = { ...currentContents, delta: structuredClone(delta) };
      if (success) success();
    },
  };

  editor.autoCloze();
  assert.equal(requests.length, 1, "automatic cloze makes one assistance request");
  requests[0].success({
    statusCode: 200,
    data: {
      success: true,
      schemaVersion: 2,
      chargeable: true,
      result: {
        sourceDigest: "ai-cloze-flow-digest",
        highlights: ranges.map((range) => ({ ...range, role: "direct_answer" })),
        clozes: ranges.map((range) => ({ ...range, role: "direct_answer" })),
        mnemonic: { text: "京音白话", conceptIds: ranges.map((range) => range.conceptId) },
      },
    },
  });
  await nextTurn();

  ranges.forEach((range) => {
    const attributes = attributesAt(currentContents.delta, range.start);
    assert.equal(attributes.color, CLOZE_COLOR, `${range.text} receives the cloze color from the AI result`);
    assert.equal(attributes.underline, true, `${range.text} receives the cloze underline from the AI result`);
  });

  editor.save();
  const savedCards = storage.get(CARD_SETS_KEY)[0].cards;
  assert.equal(savedCards.length, 1);
  const saved = savedCards[0];
  assert.deepEqual(
    JSON.parse(JSON.stringify(saved.answerDelta)),
    JSON.parse(JSON.stringify(currentContents.delta)),
    "the AI-marked Delta is the one persisted by the editor",
  );
  assert.deepEqual(
    saved.answerSegments.filter((segment) => segment.cloze).map((segment) => segment.text),
    clozePhrases,
    "saved answerSegments retain every AI-selected cloze",
  );

  const knowledgeCard = loadPage("../apps/miniprogram/pages/knowledge-card/knowledge-card.js");
  knowledgeCard.onLoad({ setId: "set-ai-cloze", cardId: saved.id });
  knowledgeCard.onShow();
  knowledgeCard.hint();
  const first = structuredClone(knowledgeCard.data.hintLines);
  knowledgeCard.hint();
  const second = structuredClone(knowledgeCard.data.hintLines);
  knowledgeCard.hint();
  const third = structuredClone(knowledgeCard.data.hintLines);

  answerPoints.forEach((body, index) => {
    const firstVisible = visibleEffectiveIndexes(first[index]);
    const secondVisible = visibleEffectiveIndexes(second[index]);
    const thirdVisible = visibleEffectiveIndexes(third[index]);
    assert.deepEqual(firstVisible, [], `point ${index + 1}: level 1 exposes no answer characters`);

    if (index >= clozePhrases.length) {
      assert.deepEqual(secondVisible, [], "an unmarked point stays hidden at level 2");
      assert.deepEqual(thirdVisible, [], "an unmarked point stays hidden at level 3");
      return;
    }

    const allowed = new Set(clozeContextIndexes(body, clozePhrases[index]));
    assert.ok(secondVisible.length > 0, `point ${index + 1}: level 2 reveals a cloze cue`);
    assert.ok(secondVisible.every((position) => allowed.has(position)), `point ${index + 1}: level 2 stays within the AI cloze and one-character context`);
    assert.ok(thirdVisible.every((position) => allowed.has(position)), `point ${index + 1}: level 3 stays within the AI cloze and one-character context`);
    assert.ok(secondVisible.every((position) => thirdVisible.includes(position)), `point ${index + 1}: level 3 preserves level 2`);
    assert.ok(thirdVisible.length > secondVisible.length, `point ${index + 1}: level 3 reveals more of the same AI cloze context`);
  });
});

test.afterEach(() => {
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
