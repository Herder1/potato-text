const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CARD_AI_CACHE_KEY: CACHE_KEY,
  CARD_AI_CACHE_REVISION,
  CARD_AI_SCHEMA_VERSION,
  cardAiFingerprint,
  normalizeCardAiResult,
} = require("../apps/miniprogram/utils/card-ai-cache");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function assistanceResult(answer) {
  const highlightText = "北京语音为标准音";
  const clozeText = "北京语音";
  const highlightStart = answer.indexOf(highlightText);
  const clozeStart = answer.indexOf(clozeText);
  return {
    requestId: "card-memory-request-1",
    sourceDigest: "digest-1",
    highlights: [{
      conceptId: "standard-sound",
      pointId: "p1",
      role: "direct_answer",
      start: highlightStart,
      end: highlightStart + highlightText.length,
      text: highlightText,
    }],
    clozes: [{
      conceptId: "standard-sound",
      pointId: "p1",
      role: "direct_answer",
      start: clozeStart,
      end: clozeStart + clozeText.length,
      text: clozeText,
    }],
    mnemonic: { text: "京音为标", conceptIds: ["standard-sound"] },
  };
}

function createFlow(options = {}) {
  const answer = options.answer || "1.普通话以北京语音为标准音。";
  const storage = new Map();
  const requests = [];
  const toasts = [];
  const spendCalls = [];
  const setContentsCalls = [];
  let definition;
  let currentContents = {
    text: `${answer}\n`,
    html: `<p>${answer}</p>`,
    delta: { ops: [{ insert: `${answer}\n` }] },
  };
  const app = {
    globalData: {
      userId: "user-card-ai",
      aiCredits: 5,
      apiBaseUrl: "http://127.0.0.1:3212",
      authToken: "token-1",
    },
    apiBaseUrlCandidates: () => ["http://127.0.0.1:3212"],
    spendAiCredit(amount, context) {
      spendCalls.push({ amount, context });
      this.globalData.aiCredits -= amount;
      return true;
    },
  };

  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 390 }),
    getSystemInfoSync: () => ({ statusBarHeight: 44, windowWidth: 390 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, left: 290, width: 87, height: 32 }),
    onKeyboardHeightChange: () => {},
    offKeyboardHeightChange: () => {},
    showToast: ({ title }) => toasts.push(title),
    navigateBack: () => {},
    request(requestOptions) {
      requests.push(requestOptions);
      if (!options.deferred) {
        setImmediate(() => requestOptions.success({
          statusCode: options.statusCode || 200,
          data: options.responseData || {
            success: true,
            schemaVersion: CARD_AI_SCHEMA_VERSION,
            chargeable: true,
            result: assistanceResult(answer),
          },
        }));
      }
      return { abort() {} };
    },
  };

  const modulePath = require.resolve("../apps/miniprogram/pages/card-editor/card-editor.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({ setId: "set-1" });
  page.setData({ question: "普通话的语音标准是什么？" });
  page.editorCtx = {
    getContents({ success }) { success(structuredClone(currentContents)); },
    setContents({ delta, success }) {
      setContentsCalls.push(structuredClone(delta));
      currentContents = { ...currentContents, delta: structuredClone(delta) };
      if (success) success();
    },
  };

  return {
    answer,
    app,
    page,
    requests,
    response: (index, response) => requests[index].success(response),
    setAnswer(nextAnswer) {
      currentContents = {
        text: `${nextAnswer}\n`,
        html: `<p>${nextAnswer}</p>`,
        delta: { ops: [{ insert: `${nextAnswer}\n` }] },
      };
    },
    setContents(nextContents) {
      currentContents = structuredClone(nextContents);
    },
    setContentsCalls,
    spendCalls,
    storage,
    toasts,
  };
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

function hasGeneratedHighlight(attributes = {}) {
  const color = String(attributes.backgroundColor || attributes.background || "").toLowerCase().replace(/\s+/g, "");
  return color === "#fff0a8" || color === "rgb(255,240,168)";
}

test("one model response serves cloze, highlight, and mnemonic without another charge", async () => {
  const flow = createFlow();

  flow.page.autoCloze();
  await nextTurn();

  assert.equal(flow.requests.length, 1);
  assert.equal(flow.requests[0].url, "http://127.0.0.1:3212/api/ai/card-memory-assistance");
  assert.equal(flow.requests[0].timeout, 135000, "a combined long-answer generation may outlive the default request timeout");
  assert.equal(flow.requests[0].data.requestedFeature, "cloze");
  assert.equal(flow.spendCalls.length, 1);
  assert.equal(flow.page.data.mnemonic, "");
  assert.equal(flow.setContentsCalls.length, 1);
  assert.equal(flow.setContentsCalls[0].ops.some((op) => op.attributes && op.attributes.backgroundColor), false);
  assert.equal(flow.setContentsCalls[0].ops.some((op) => op.attributes
    && op.attributes.color === "#168fd8"
    && op.attributes.underline === true), true);

  flow.page.autoHighlight();
  assert.equal(flow.requests.length, 1);
  assert.equal(flow.spendCalls.length, 1);
  assert.equal(flow.setContentsCalls.length, 2);
  const combinedDelta = flow.setContentsCalls[1];
  assert.equal(combinedDelta.ops.some((op) => op.attributes && op.attributes.backgroundColor === "#fff0a8"), true);
  assert.equal(combinedDelta.ops.some((op) => op.attributes
    && op.attributes.color === "#168fd8"
    && op.attributes.underline === true), true);

  flow.page.createMnemonic();
  assert.equal(flow.requests.length, 1);
  assert.equal(flow.spendCalls.length, 1);
  assert.equal(flow.page.data.mnemonic, "京音为标");
  assert.equal(CARD_AI_CACHE_REVISION, 5);
  assert.equal(CACHE_KEY, "shukao_card_ai_assistance_v5");
  assert.match(cardAiFingerprint("问题", "答案", "user"), /^card-ai-v2-r5-/u);
  assert.ok(Array.isArray(flow.storage.get(CACHE_KEY)));
});

test("automatic cloze and highlight require a question while mnemonic remains available", () => {
  const flow = createFlow({ deferred: true });
  flow.page.setData({ question: "" });

  flow.page.autoCloze();
  flow.page.autoHighlight();
  assert.equal(flow.requests.length, 0);
  assert.equal(flow.toasts.at(-1), "先填写卡片问题");

  flow.page.createMnemonic();
  assert.equal(flow.requests.length, 1);
  assert.equal(flow.requests[0].data.requestedFeature, "mnemonic");
});

test("client validation preserves the full server range budget without silent truncation", () => {
  const answer = "甲乙".repeat(64);
  const highlights = [];
  const clozes = [];
  for (let index = 0; index < 64; index += 1) {
    const start = index * 2;
    const conceptId = `concept-${index}`;
    highlights.push({ conceptId, pointId: "p1", start, end: start + 2, text: "甲乙" });
    clozes.push(
      { conceptId, pointId: "p1", start, end: start + 1, text: "甲" },
      { conceptId, pointId: "p1", start: start + 1, end: start + 2, text: "乙" },
    );
  }
  const normalized = normalizeCardAiResult({
    highlights,
    clozes,
    mnemonic: { text: "顺序记忆", conceptIds: highlights.map((item) => item.conceptId) },
  }, answer);

  assert.equal(normalized.highlights.length, 64);
  assert.equal(normalized.clozes.length, 128);
  assert.equal(normalizeCardAiResult({
    highlights: [...highlights, highlights[0]],
    clozes,
    mnemonic: { text: "超限", conceptIds: [] },
  }, answer), null);
});

test("automatic highlight replaces stale yellow coverage without removing clozes or rich text", async () => {
  const flow = createFlow();
  const answer = flow.answer;
  const clozeStart = answer.indexOf("北京语音");
  const highlightStart = answer.indexOf("北京语音为标准音");
  flow.setContents({
    text: `${answer}\n`,
    html: `<p>${answer}</p>`,
    delta: {
      ops: [
        { insert: answer.slice(0, clozeStart), attributes: { bold: true, backgroundColor: "#fff0a8" } },
        {
          insert: "北京语音",
          attributes: {
            bold: true,
            color: "#168fd8",
            underline: true,
            background: "rgb(255, 240, 168)",
          },
        },
        { insert: "为标准音。", attributes: { italic: true, backgroundColor: "#fff0a8" } },
        { insert: "\n", attributes: { align: "left" } },
      ],
    },
  });

  flow.page.autoHighlight();
  await nextTurn();

  assert.equal(flow.setContentsCalls.length, 1);
  const applied = flow.setContentsCalls[0];
  assert.equal(hasGeneratedHighlight(attributesAt(applied, highlightStart - 1)), false, "stale yellow before the new model range is removed");
  assert.equal(attributesAt(applied, highlightStart - 1).bold, true, "bold outside the new range is preserved");
  assert.equal(hasGeneratedHighlight(attributesAt(applied, highlightStart)), true, "the new model range receives the yellow highlight");
  assert.equal(attributesAt(applied, clozeStart).color, "#168fd8", "manual blue cloze color is preserved");
  assert.equal(attributesAt(applied, clozeStart).underline, true, "manual cloze underline is preserved");
  assert.equal(attributesAt(applied, answer.indexOf("为标准音")).italic, true, "italic formatting inside the new range is preserved");
  assert.equal(hasGeneratedHighlight(attributesAt(applied, answer.indexOf("。"))), false, "stale yellow after the new model range is removed");
  assert.equal(attributesAt(applied, answer.length).align, "left", "paragraph formatting is preserved");
});

test("rapid assistant taps do not start a second model request", async () => {
  const flow = createFlow({ deferred: true });

  flow.page.autoCloze();
  flow.page.autoHighlight();
  assert.equal(flow.requests.length, 1);
  assert.equal(flow.page.data.assistantBusy, true);
  assert.equal(flow.toasts.at(-1), "正在分析答案");

  flow.response(0, {
    statusCode: 200,
    data: {
      success: true,
      schemaVersion: CARD_AI_SCHEMA_VERSION,
      chargeable: true,
      result: assistanceResult(flow.answer),
    },
  });
  await nextTurn();
  assert.equal(flow.page.data.assistantBusy, false);
  assert.equal(flow.setContentsCalls.length, 1);
  assert.equal(flow.setContentsCalls[0].ops.some((op) => op.attributes && op.attributes.backgroundColor), false);
});

test("a response for edited answer is cached but never applied to the new text", async () => {
  const flow = createFlow({ deferred: true });
  flow.page.autoCloze();
  flow.setAnswer("2.答案已经被用户修改。 ");

  flow.response(0, {
    statusCode: 200,
    data: {
      success: true,
      schemaVersion: CARD_AI_SCHEMA_VERSION,
      chargeable: true,
      result: assistanceResult(flow.answer),
    },
  });
  await nextTurn();

  assert.equal(flow.setContentsCalls.length, 0);
  assert.equal(flow.toasts.at(-1), "答案已变化，请重新生成");
});

test("provider failures leave the editor unchanged and do not spend credits", async () => {
  const flow = createFlow({
    statusCode: 503,
    responseData: { success: false, chargeable: false, error: "card_memory_assistance_route_unavailable" },
  });
  flow.page.createMnemonic();
  await nextTurn();

  assert.equal(flow.setContentsCalls.length, 0);
  assert.equal(flow.spendCalls.length, 0);
  assert.equal(flow.page.data.mnemonic, "");
  assert.equal(flow.toasts.at(-1), "请先配置知识卡 AI 模型");
});

test("a successful response from an old schema is rejected before caching or charging", async () => {
  const answer = "1.普通话以北京语音为标准音。";
  const flow = createFlow({
    answer,
    responseData: {
      success: true,
      schemaVersion: CARD_AI_SCHEMA_VERSION - 1,
      chargeable: true,
      result: assistanceResult(answer),
    },
  });

  flow.page.autoCloze();
  await nextTurn();

  assert.equal(flow.setContentsCalls.length, 0);
  assert.equal(flow.spendCalls.length, 0);
  assert.equal(flow.storage.has(CACHE_KEY), false);
  assert.equal(flow.toasts.at(-1), "生成失败，未扣额度");
});

test.afterEach(() => {
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
