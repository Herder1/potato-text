const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { applyDataPatch } = require("./helpers/set-data");

const MINIPROGRAM = path.join(__dirname, "..", "apps", "miniprogram");
const PACK_COLLECTION = "pages/pack-collection/pack-collection.js";

// 2026-09-28 缺陷：进了私有题包却加不了卡片，必须退出再点这个题包进来才行。
// 根因有两层，这里两层都锁住：
//   1) 入口跳题包合集页时漏传 source=private（library / library-search / knowledge / assets）；
//   2) 页面只认 URL 参数、不认本地题包，于是 this.source 停在 public，
//      requirePrivatePack() 把「添加卡片 / 更多」全部拦掉，而「更多」抽屉里的私有专属入口
//      又是按 pack.isPrivate 显示出来的 —— 显示得出来、一点却提示「请先收藏到我的题包」。

function listPageScripts(dir, collected = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listPageScripts(full, collected);
    else if (entry.name.endsWith(".js")) collected.push(full);
  });
  return collected;
}

function packCollectionUrls(file) {
  const text = fs.readFileSync(file, "utf8");
  const marker = "pack-collection/pack-collection?";
  const urls = [];
  let index = text.indexOf(marker);
  while (index >= 0) {
    const rest = text.slice(index);
    const stops = ["`", '"', "'"].map((char) => rest.indexOf(char)).filter((value) => value >= 0);
    const end = stops.length ? Math.min(...stops) : rest.length;
    urls.push(rest.slice(0, end));
    index = text.indexOf(marker, index + marker.length);
  }
  return urls;
}

test("every navigation into the pack collection page declares its source", () => {
  const offenders = [];
  listPageScripts(MINIPROGRAM).forEach((file) => {
    packCollectionUrls(file).forEach((url) => {
      if (!/source=/.test(url)) offenders.push(`${path.relative(MINIPROGRAM, file)} → ${url}`);
    });
  });
  assert.deepEqual(offenders, [], "私有题包入口必须带 source=private，公开题包入口必须带 source=public");
});

function createHarness() {
  const store = new Map();
  const calls = { navigations: [], toasts: [], modalAnswers: [] };
  const wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    navigateTo: ({ url }) => { calls.navigations.push(url); },
    navigateBack: () => {},
    showToast: ({ title }) => { calls.toasts.push(title); },
    showModal: ({ success }) => {
      const answer = calls.modalAnswers.shift();
      if (answer !== undefined && success) success({ confirm: true, content: answer });
    },
    getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 375, windowHeight: 812 }),
    getSystemInfoSync: () => ({ statusBarHeight: 24, windowWidth: 375, windowHeight: 812 }),
    getMenuButtonBoundingClientRect: () => ({ top: 28, left: 278, width: 87, height: 32 }),
    createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }), selectViewport: () => ({ scrollOffset: () => ({ exec: () => {} }) }), exec: () => {} }),
  };
  global.wx = wx;
  return { store, calls, wx };
}

function loadPage(relativePath) {
  let definition;
  global.Page = (value) => { definition = value; };
  const resolved = require.resolve(path.join(MINIPROGRAM, relativePath));
  delete require.cache[resolved];
  require(resolved);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  return page;
}

function withHarness(callback) {
  const harness = createHarness();
  const previousPage = global.Page;
  try {
    callback(harness);
  } finally {
    delete global.Page;
    if (previousPage !== undefined) global.Page = previousPage;
    delete global.wx;
  }
}

test("a freshly created pack can add a card on the spot, even from an entry that forgets source=private", () => {
  withHarness(({ store, calls }) => {
    const { createPrivatePack, getPrivatePack } = require("../apps/miniprogram/utils/private-pack-store");
    const pack = createPrivatePack({ name: "111" }, global.wx);

    const page = loadPage(PACK_COLLECTION);
    // 旧 library 入口就是这样进来的：只有 id，没有 source。
    page.onLoad({ id: encodeURIComponent(pack.id) });
    page.onShow();

    assert.equal(page.data.pack.isPrivate, true, "本地题包必须按私有题包渲染");
    assert.equal(page.data.pack.name, "111");
    assert.equal(page.source, "private", "页面来源要跟着数据自愈");
    assert.equal(page.data.source, "private");

    page.toggleAddMenu();
    assert.equal(page.data.addMenuOpen, true, "刚建好的题包应当能直接打开添加菜单");
    assert.deepEqual(calls.toasts, [], "不应再提示「请先收藏到我的题包」");

    page.createCard();
    const nodes = getPrivatePack(pack.id, global.wx).nodes;
    assert.equal(nodes.filter((node) => node.type === "card").length, 1, "空白卡片要真的落进题包");
    assert.deepEqual(store.get("shukao_private_packs").map((item) => item.id), [pack.id]);
  });
});

test("a public pack page still asks the reader to collect the pack first", () => {
  withHarness(({ calls }) => {
    const { cachePublicPack } = require("../apps/miniprogram/utils/pack-collection");
    const publicPack = {
      id: "community-pack-1",
      name: "社区题包",
      creatorType: "user",
      questions: [],
      questionIds: [],
    };
    cachePublicPack(publicPack);

    const page = loadPage(PACK_COLLECTION);
    page.onLoad({ id: "community-pack-1", source: "public" });
    page.onShow();

    assert.equal(page.data.pack.isPrivate, false);
    assert.equal(page.source, "public");
    page.toggleAddMenu();
    assert.equal(page.data.addMenuOpen, false, "公开题包页不能直接改");
    assert.deepEqual(calls.toasts, ["请先收藏到我的题包"]);
  });
});

test("private pack entries carry source=private end to end", () => {
  withHarness(({ calls, store }) => {
    calls.modalAnswers.push("刚建的题包");
    const library = loadPage("pages/library/library.js");
    library.onLoad();
    library.createLibraryPack();
    const created = calls.navigations.at(-1);
    assert.match(created, /^\/pages\/pack-collection\/pack-collection\?id=/);
    assert.match(created, /[?&]source=private(&|$)/, `新建题包入口漏了 source：${created}`);
    const createdId = decodeURIComponent(created.match(/id=([^&]+)/)[1]);
    assert.equal(store.get("shukao_private_packs").some((pack) => pack.id === createdId), true);

    const search = loadPage("pages/library-search/library-search.js");
    search.setData({ records: [{ scope: "pack", sourceKind: "private", id: "private-pack-search" }] });
    search.openResult({ currentTarget: { dataset: { scope: "pack", id: "private-pack-search" } } });
    assert.match(calls.navigations.at(-1), /id=private-pack-search&source=private$/);

    const knowledge = loadPage("pages/knowledge/knowledge.js");
    knowledge.setData({ selectedLibraryAsset: { importedPackId: "private-pack-imported" } });
    knowledge.openSelectedPack();
    assert.match(calls.navigations.at(-1), /id=private-pack-imported&source=private$/);

    const assets = loadPage("pages/assets/assets.js");
    assets.setData({ selectedAsset: { type: "question_pack", id: "private-pack-asset" } });
    assets.openSelectedPack();
    assert.match(calls.navigations.at(-1), /id=private-pack-asset&source=private$/);
  });
});
