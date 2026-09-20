const test = require("node:test");
const assert = require("node:assert/strict");

function createPage(modulePath, store, navigation) {
  let definition;
  global.Page = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    navigateTo: ({ url }) => { navigation.url = url; },
    navigateBack: () => { navigation.back = true; },
    showToast() {},
    showModal: ({ success }) => success && success({ confirm: true }),
    getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 375 }),
    getSystemInfoSync: () => ({ statusBarHeight: 24, windowWidth: 375 }),
    getMenuButtonBoundingClientRect: () => ({ top: 28, left: 278, width: 87, height: 32 }),
  };
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

test("question creation enters through a pack and saves membership", () => {
  const store = new Map();
  const navigation = {};
  let page = createPage("../apps/miniprogram/pages/packs/packs.js", store, navigation);
  page.onLoad({ intent: "addQuestion" });
  page.onShow();
  assert.equal(page.data.stats.total, 0);

  const { createPrivatePack, loadPrivatePacks } = require("../apps/miniprogram/utils/private-pack-store");
  const pack = createPrivatePack({ name: "我的语法题" }, global.wx);
  page.refresh();
  page.openPack({ currentTarget: { dataset: { id: pack.id } } });
  assert.match(navigation.url, /pack-collection\/pack-collection/);
  assert.match(navigation.url, /intent=addQuestion/);

  page = createPage("../apps/miniprogram/pages/contribute/contribute.js", store, navigation);
  page.onLoad({ packId: encodeURIComponent(pack.id) });
  page.setData({ stem: "什么是语素？", originalConfirmed: true });
  page.saveQuestion();
  const updated = loadPrivatePacks(global.wx).find((item) => item.id === pack.id);
  assert.equal(updated.questionIds.length, 1);
  assert.equal(store.get("shukao_user_assets")[0].packId, pack.id);

  delete global.Page;
  delete global.wx;
});

test("a blank card opens question entry and receives the saved question", () => {
  const store = new Map();
  const navigation = {};
  const { createPrivatePack, getPrivatePack } = require("../apps/miniprogram/utils/private-pack-store");
  const storage = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
  };
  const pack = createPrivatePack({ name: "目录化题包" }, storage);
  // DEC-075：管理题包页已下线，这条链路改由题包合集页承担。
  let page = createPage("../apps/miniprogram/pages/pack-collection/pack-collection.js", store, navigation);
  page.onLoad({ id: encodeURIComponent(pack.id), source: "private" });
  page.onShow();
  page.createDirectory();
  page.commitDirectoryInline({ detail: { value: "第一章 语音" } });
  page.createCard();
  const card = getPrivatePack(pack.id, global.wx).nodes.find((node) => node.type === "card");
  const row = page.data.rows.find((item) => item.nodeId === card.id);
  page.openQuestion({ currentTarget: { dataset: { id: row.id } } });
  assert.match(navigation.url, new RegExp(`cardId=${encodeURIComponent(card.id)}`));

  page = createPage("../apps/miniprogram/pages/contribute/contribute.js", store, navigation);
  page.onLoad({ packId: encodeURIComponent(pack.id), cardId: encodeURIComponent(card.id) });
  page.setData({ stem: "普通话声调有几类？", originalConfirmed: true });
  page.saveQuestion();
  const updatedCard = getPrivatePack(pack.id, global.wx).nodes.find((node) => node.id === card.id);
  assert.equal(Boolean(updatedCard.questionId), true);

  delete global.Page;
  delete global.wx;
});

test("pack collection honors the addQuestion intent that used to live on the retired page", () => {
  const store = new Map();
  const navigation = {};
  const { createPrivatePack } = require("../apps/miniprogram/utils/private-pack-store");
  const storage = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
  };
  const pack = createPrivatePack({ name: "带意图进入的题包" }, storage);
  const page = createPage("../apps/miniprogram/pages/pack-collection/pack-collection.js", store, navigation);
  page.onLoad({ id: encodeURIComponent(pack.id), source: "private", intent: "addQuestion" });
  page.onShow();

  const nodes = store.get("shukao_private_packs")[0].nodes;
  assert.equal(nodes.filter((node) => node.type === "card").length, 1, "先建一张空白卡片");
  assert.match(navigation.url, /pages\/contribute\/contribute\?packId=/);
  assert.match(navigation.url, new RegExp(`cardId=${encodeURIComponent(nodes[0].id)}`));

  delete global.Page;
  delete global.wx;
});

test("an existing personal question can be imported into a new or existing pack", () => {
  const store = new Map();
  const navigation = {};
  const storage = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
  };
  const { saveAsset } = require("../apps/miniprogram/utils/asset-store");
  const { createPrivatePack, getPrivatePack } = require("../apps/miniprogram/utils/private-pack-store");
  const firstQuestion = saveAsset({ id: "existing-question-1", type: "question", title: "第一题", stem: "第一题题干" }, storage);
  const secondQuestion = saveAsset({ id: "existing-question-2", type: "question", title: "第二题", stem: "第二题题干" }, storage);
  const pack = createPrivatePack({ name: "重新整理的题包" }, storage);

  // DEC-075：attachQuestion 意图与「导入已有题目」都搬到题包合集页。
  const page = createPage("../apps/miniprogram/pages/pack-collection/pack-collection.js", store, navigation);
  page.onLoad({
    id: encodeURIComponent(pack.id),
    source: "private",
    intent: "attachQuestion",
    questionId: encodeURIComponent(firstQuestion.id),
  });
  page.onShow();
  assert.equal(getPrivatePack(pack.id, global.wx).questionIds.includes(firstQuestion.id), true);

  page.openQuestionImporter();
  assert.deepEqual(page.data.availableQuestions.map((question) => question.id), [secondQuestion.id]);
  page.importExistingQuestion({ currentTarget: { dataset: { id: secondQuestion.id } } });
  assert.deepEqual(new Set(getPrivatePack(pack.id, global.wx).questionIds), new Set([firstQuestion.id, secondQuestion.id]));

  delete global.Page;
  delete global.wx;
});
