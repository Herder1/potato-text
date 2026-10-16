const test = require("node:test");
const assert = require("node:assert/strict");

const SETS_KEY = "shukao_card_box_sets";
const FOLDERS_KEY = "shukao_card_box_folders";
const REMOVED_SETS_KEY = "shukao_card_box_removed_sets";
const REMOVED_FOLDERS_KEY = "shukao_card_box_removed_folders";
const LIBRARY_UPDATED_KEY = "shukao_card_box_library_updated";

/**
 * 卡集/知识卡的服务端同步（产品负责人 2026-09-23 定，docs/OPEN_DECISIONS.md C15）。
 *
 * 这层盯的是"本地改动能不能如实传到服务端、服务端结果能不能如实落回本地"：
 * - 改一次就打 `updatedAt`（服务端要靠它做 LWW）；
 * - 删除必须留墓碑：只把条目从数组里拿掉，在同步语义里等于"没这回事"，另一台设备的旧副本会把它带回来；
 * - 置顶＝数组顺序，纯排序也要打时间戳，否则排到服务端就丢了；
 * - 未登录/无网络时本地照常可用（同步静默跳过），不因为同步失败阻塞用户。
 */

function createWxMock(initial = {}) {
  const storage = new Map(Object.entries(initial));
  const requests = [];
  return {
    storage,
    requests,
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => { storage.set(key, value); },
      removeStorageSync: (key) => { storage.delete(key); },
      request: (options) => {
        requests.push(options);
        const handler = global.__dshRequestHandler;
        if (typeof handler === "function") handler(options);
      },
      showToast: () => {},
    },
  };
}

function loadStore(initial = {}) {
  const mock = createWxMock(initial);
  global.wx = mock.wx;
  const modulePath = require.resolve("../apps/miniprogram/utils/card-box-store");
  delete require.cache[modulePath];
  return { store: require(modulePath), ...mock };
}

function seedSets(count = 1) {
  return Array.from({ length: count }, (unused, index) => ({
    id: `set-${index + 1}`,
    title: `卡集${index + 1}`,
    folder: "我的卡集",
    cards: [{ id: `card-${index + 1}`, question: `题目${index + 1}`, answer: "答案" }],
    sectionOrder: [],
    sectionLevels: {},
  }));
}

test("改一次就打 updatedAt：卡集与改动的卡片各自有时间戳", () => {
  const { store, storage } = loadStore({ [SETS_KEY]: seedSets(1) });
  store.updateSet("set-1", (set) => ({ ...set, title: "改过的标题", cards: [...set.cards, { id: "card-new", question: "新加的卡" }] }));
  const saved = storage.get(SETS_KEY)[0];
  assert.equal(saved.title, "改过的标题");
  assert.equal(Number(saved.updatedAt) > 0, true, "卡集要打 updatedAt，服务端要靠它做 LWW");
  assert.equal(Number(saved.cards.find((card) => card.id === "card-new").updatedAt) > 0, true, "新增/改动的卡片同样要时间戳");
});

test("没改的卡集不重新打时间戳（避免「打开即算改动」）", () => {
  const { store, storage } = loadStore({ [SETS_KEY]: seedSets(1) });
  store.updateSet("set-1", (set) => ({ ...set, title: "第一次改" }));
  const firstStamp = storage.get(SETS_KEY)[0].updatedAt;
  store.updateSet("set-1", (set) => ({ ...set }));
  assert.equal(storage.get(SETS_KEY)[0].updatedAt, firstStamp, "内容没变就不该推进时间戳");
});

test("删卡片留墓碑：另一台设备上的旧副本不会把它带回来", () => {
  const { store, storage } = loadStore({ [SETS_KEY]: seedSets(1) });
  store.updateSet("set-1", (set) => ({ ...set, cards: [...set.cards, { id: "card-extra", question: "要被删的卡" }] }));
  store.updateSet("set-1", (set) => ({ ...set, cards: set.cards.filter((card) => card.id !== "card-extra") }));
  const saved = storage.get(SETS_KEY)[0];
  assert.deepEqual(saved.cards.map((card) => card.id), ["card-1"]);
  assert.deepEqual(saved.deletedCards.map((card) => card.id), ["card-extra"], "删掉的卡片必须以墓碑形式留在卡集里");
  assert.equal(saved.deletedCards[0].deletedAt > 0, true);
});

test("删卡集留墓碑；置顶＝数组顺序也要打时间戳", () => {
  const { store, storage } = loadStore({ [SETS_KEY]: seedSets(3) });
  store.pinCardSets(["set-3"]);
  assert.deepEqual(storage.get(SETS_KEY).map((set) => set.id), ["set-3", "set-1", "set-2"], "置顶＝移到最前");
  assert.equal(Number(storage.get(SETS_KEY)[0].updatedAt) > 0, true, "纯排序也必须能被服务端看见");

  store.deleteCardSets(["set-1"]);
  assert.deepEqual(storage.get(SETS_KEY).map((set) => set.id), ["set-3", "set-2"]);
  assert.deepEqual(storage.get(REMOVED_SETS_KEY), [{ id: "set-1", at: storage.get(REMOVED_SETS_KEY)[0].at }]);
});

test("上行负载：卡集 + 文件夹 + 两侧墓碑 + libraryUpdatedAt", () => {
  const { store, storage } = loadStore({ [SETS_KEY]: seedSets(2), [FOLDERS_KEY]: ["我的卡集", "期末复习"] });
  store.createCardFolder("教资");
  store.deleteCardFolder("期末复习");
  const payload = store.cardLibraryPayload();
  assert.deepEqual(payload.sets.map((set) => set.id), ["set-1", "set-2"]);
  assert.equal(payload.folders.includes("教资"), true);
  assert.equal(payload.folders.includes("期末复习"), false, "删掉的文件夹不再上行");
  assert.deepEqual(payload.removedFolders.map((entry) => entry.name), ["期末复习"]);
  assert.equal(payload.libraryUpdatedAt > 0, true);
  assert.equal(storage.get(LIBRARY_UPDATED_KEY) > 0, true);
});

test("重新创建同名文件夹会撤销旧墓碑（新文件夹不被自己的旧墓碑压掉）", () => {
  const { store, storage } = loadStore({ [SETS_KEY]: seedSets(1), [FOLDERS_KEY]: ["我的卡集", "期末复习"] });
  store.deleteCardFolder("期末复习");
  assert.equal(storage.get(REMOVED_FOLDERS_KEY).length, 1);
  store.createCardFolder("期末复习");
  assert.deepEqual(storage.get(REMOVED_FOLDERS_KEY), []);
});

test("导入分享快照：复制成自己的卡集（换新 id、落当前文件夹、不带对方的墓碑）", () => {
  const { store, storage } = loadStore({ [SETS_KEY]: seedSets(1), [FOLDERS_KEY]: ["我的卡集"] });
  const snapshot = {
    id: "set-of-friend",
    title: "好友的卡集",
    folder: "好友的文件夹",
    cards: [{ id: "card-a", question: "好友的题" }],
    deletedCards: [{ id: "card-gone", deletedAt: 1 }],
  };
  const imported = store.importCardSet(snapshot, "我的卡集");
  const saved = storage.get(SETS_KEY);
  assert.equal(saved.length, 2);
  assert.notEqual(imported.id, "set-of-friend", "导入要换新 id，避免和对方的 id 撞车");
  assert.equal(saved[0].id, imported.id, "导入的卡集排在最前");
  assert.equal(saved[0].folder, "我的卡集");
  assert.equal(saved[0].author, "来自分享");
  assert.equal(saved[0].deletedCards, undefined, "对方的删除墓碑不进我的库");
  assert.deepEqual(saved[0].cards.map((card) => card.question), ["好友的题"]);
});

test("同步：请求地址/鉴权/负载正确，成功时把合并结果写回本地并清掉已上交的墓碑", async () => {
  const { store, storage, requests } = loadStore({ [SETS_KEY]: seedSets(1), [FOLDERS_KEY]: ["我的卡集"] });
  global.__dshRequestHandler = (options) => {
    options.success({
      statusCode: 200,
      data: {
        success: true,
        uploaded: true,
        library: {
          libraryUpdatedAt: 9000,
          folders: ["我的卡集", "服务端加的文件夹"],
          deletedSetIds: [],
          sets: [{ ...seedSets(1)[0], title: "服务端合并后的标题", updatedAt: 9000 }],
        },
      },
    });
  };
  const library = await store.syncCardLibrary({ baseUrl: "http://127.0.0.1:3212", token: "token-1" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:3212/api/card-library/sync");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].header.Authorization, "Bearer token-1");
  assert.equal(requests[0].data.sets.length, 1);
  assert.equal(library.libraryUpdatedAt, 9000);
  assert.equal(storage.get(SETS_KEY)[0].title, "服务端合并后的标题");
  assert.equal(storage.get(FOLDERS_KEY).includes("服务端加的文件夹"), true);
  assert.equal(storage.get(LIBRARY_UPDATED_KEY), 9000);
  delete global.__dshRequestHandler;
});

test("服务端墓碑压制本地复活：deletedSetIds 里的卡集不再留在本地", async () => {
  const { store, storage } = loadStore({ [SETS_KEY]: seedSets(2), [FOLDERS_KEY]: ["我的卡集"] });
  global.__dshRequestHandler = (options) => {
    options.success({
      statusCode: 200,
      data: {
        success: true,
        uploaded: true,
        library: { libraryUpdatedAt: 5000, folders: ["我的卡集"], deletedSetIds: ["set-1"], sets: [seedSets(2)[1]] },
      },
    });
  };
  await store.syncCardLibrary({ baseUrl: "http://x", token: "t" });
  assert.deepEqual(storage.get(SETS_KEY).map((set) => set.id), ["set-2"]);
  delete global.__dshRequestHandler;
});

test("未登录/无网络：同步静默跳过，本地照常可用", async () => {
  const { store, storage, requests } = loadStore({ [SETS_KEY]: seedSets(1) });
  assert.equal(await store.syncCardLibrary(), null);
  assert.equal(requests.length, 0);
  store.updateSet("set-1", (set) => ({ ...set, title: "离线也能改" }));
  assert.equal(storage.get(SETS_KEY)[0].title, "离线也能改");

  global.__dshRequestHandler = (options) => options.fail({ errMsg: "network error" });
  assert.equal(await store.syncCardLibrary({ baseUrl: "http://x", token: "t" }), null);
  assert.equal(storage.get(SETS_KEY)[0].title, "离线也能改", "同步失败不得动本地数据");
  delete global.__dshRequestHandler;
});

test("分享快照：创建取回 shareId，匿名读取返回冻结副本，失败一律 null", async () => {
  const { store } = loadStore({ [SETS_KEY]: seedSets(1) });
  global.__dshRequestHandler = (options) => {
    if (options.url.endsWith("/share")) options.success({ statusCode: 200, data: { success: true, shareId: "cs-abc" } });
    else options.success({ statusCode: 200, data: { success: true, share: { shareId: "cs-abc", set: { id: "set-1", title: "分享的标题" } } } });
  };
  assert.equal(await store.createCardSetShare("set-1", { baseUrl: "http://x", token: "t" }), "cs-abc");
  const share = await store.loadCardSetShare("cs-abc", { baseUrl: "http://x" });
  assert.equal(share.set.title, "分享的标题");

  global.__dshRequestHandler = (options) => options.success({ statusCode: 404, data: { success: false, error: "card_share_not_found" } });
  assert.equal(await store.loadCardSetShare("cs-missing", { baseUrl: "http://x" }), null);
  assert.equal(await store.createCardSetShare("set-1", { baseUrl: "http://x", token: "t" }), null);
  delete global.__dshRequestHandler;
});
