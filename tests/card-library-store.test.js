const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryCardLibraryStore, createFileCardLibraryStore } = require("../apps/api/src/card-library-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createServer } = require("../apps/api/src/server");

/**
 * 卡集与知识卡搬到服务端（产品负责人 2026-09-23 定，docs/OPEN_DECISIONS.md C15）。
 *
 * 这份测试盯的是**口径**，不是实现细节：
 * - 并集：任何一台设备新增的卡集/卡片，不因为另一台"没有"而消失；
 * - 每项按 `updatedAt` 取较新，同刻以请求方（本地）为准；
 * - 删除写墓碑：A 机删掉的，B 机同步后也删掉，且不会因为 B 机还留着旧副本而复活；
 * - 本地为空只拉不推：新设备/清过缓存的设备不会用空库把服务端抹掉；
 * - 分享＝服务端冻结快照：源卡集之后怎么改都不影响已分享出去的链接，匿名可读。
 */

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
after(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

function setRecord(id, overrides = {}) {
  return {
    id,
    title: `卡集-${id}`,
    description: "",
    subtitle: "未命名版本",
    author: "我的整理",
    subject: "未分类",
    progress: 0,
    due: 0,
    color: "",
    folder: "我的卡集",
    cards: [],
    sectionOrder: [],
    sectionLevels: {},
    updatedAt: 1000,
    ...overrides,
  };
}

function cardRecord(id, overrides = {}) {
  return { id, question: `卡片-${id}`, answer: "", updatedAt: 1000, ...overrides };
}

function sync(store, userId, payload) {
  return store.sync(userId, payload, Number(payload.now) || 5000);
}

test("首登上传：服务端没有记录时，本地整库上行", () => {
  const store = createMemoryCardLibraryStore();
  const result = sync(store, "user-a", {
    folders: ["我的卡集", "期末复习"],
    libraryUpdatedAt: 4000,
    sets: [setRecord("set-1", { cards: [cardRecord("card-1")] })],
  });
  assert.equal(result.uploaded, true);
  assert.equal(result.library.sets.length, 1);
  assert.equal(result.library.sets[0].cards.length, 1);
  assert.deepEqual(result.library.folders, ["我的卡集", "期末复习"]);
  assert.equal(store.get("user-a").sets[0].title, "卡集-set-1");
});

test("本地为空只拉不推：空请求不动服务端已有数据", () => {
  const store = createMemoryCardLibraryStore();
  sync(store, "user-a", { libraryUpdatedAt: 100, sets: [setRecord("set-1")], folders: ["我的卡集"] });
  const pulled = sync(store, "user-a", { libraryUpdatedAt: 0, sets: [], folders: [], removedSets: [], removedFolders: [] });
  assert.equal(pulled.uploaded, false);
  assert.equal(pulled.library.sets.length, 1, "空库上行不得把服务端数据抹掉");
  assert.equal(store.counts().sets, 1);
});

test("并集：两台设备各自的卡集都保留，顺序以较新的库为基准", () => {
  const store = createMemoryCardLibraryStore();
  sync(store, "user-a", { libraryUpdatedAt: 1000, sets: [setRecord("set-a")], folders: ["我的卡集"] });
  const merged = sync(store, "user-a", { libraryUpdatedAt: 2000, sets: [setRecord("set-b")], folders: ["我的卡集"] });
  assert.deepEqual(merged.library.sets.map((set) => set.id), ["set-b", "set-a"], "较新的库在前（置顶＝数组顺序）");
});

test("每项按 updatedAt 取较新；同刻以本地为准", () => {
  const store = createMemoryCardLibraryStore();
  sync(store, "user-a", { libraryUpdatedAt: 1000, sets: [setRecord("set-1", { title: "服务端旧版", updatedAt: 1000 })] });
  const newerLocal = sync(store, "user-a", { libraryUpdatedAt: 1000, sets: [setRecord("set-1", { title: "本地新版", updatedAt: 2000 })] });
  assert.equal(newerLocal.library.sets[0].title, "本地新版");

  const newerServer = sync(store, "user-a", { libraryUpdatedAt: 1000, sets: [setRecord("set-1", { title: "本地旧版", updatedAt: 500 })] });
  assert.equal(newerServer.library.sets[0].title, "本地新版", "本地更旧时不得覆盖服务端较新的一版");

  const tie = sync(store, "user-a", { libraryUpdatedAt: 1000, sets: [setRecord("set-1", { title: "同刻本地", updatedAt: 2000 })] });
  assert.equal(tie.library.sets[0].title, "同刻本地", "时间戳相同以请求方（本地）为准");
});

test("卡集删除写墓碑：B 机留着旧副本也不会复活", () => {
  const store = createMemoryCardLibraryStore();
  sync(store, "user-a", { libraryUpdatedAt: 1000, sets: [setRecord("set-1", { updatedAt: 1000 })] });
  const deleted = sync(store, "user-a", { libraryUpdatedAt: 3000, sets: [], removedSets: [{ id: "set-1", at: 3000 }] });
  assert.equal(deleted.library.sets.length, 0);
  assert.deepEqual(deleted.library.deletedSetIds, ["set-1"]);

  const staleDevice = sync(store, "user-a", { libraryUpdatedAt: 1500, sets: [setRecord("set-1", { title: "旧设备上的旧副本", updatedAt: 900 })] });
  assert.equal(staleDevice.library.sets.length, 0, "删得比旧副本的 updatedAt 晚 → 不复活");

  const editedAfterDelete = sync(store, "user-a", { libraryUpdatedAt: 9000, sets: [setRecord("set-1", { title: "删除后的新改动", updatedAt: 9000 })] });
  assert.equal(editedAfterDelete.library.sets.length, 1, "删除之后确有更新的改动 → 仍按 LWW 接受");
});

test("卡片级：并集 + 单卡删除墓碑", () => {
  const store = createMemoryCardLibraryStore();
  sync(store, "user-a", {
    libraryUpdatedAt: 1000,
    sets: [setRecord("set-1", { updatedAt: 1000, cards: [cardRecord("card-1", { updatedAt: 1000 })] })],
  });
  const added = sync(store, "user-a", {
    libraryUpdatedAt: 2000,
    sets: [setRecord("set-1", { updatedAt: 2000, cards: [cardRecord("card-1", { updatedAt: 1000 }), cardRecord("card-2", { updatedAt: 2000 })] })],
  });
  assert.deepEqual(added.library.sets[0].cards.map((card) => card.id), ["card-1", "card-2"], "另一台新加的卡片要保留");

  const deletedCard = sync(store, "user-a", {
    libraryUpdatedAt: 3000,
    sets: [setRecord("set-1", { updatedAt: 3000, cards: [cardRecord("card-1", { updatedAt: 1000 })], deletedCards: [{ id: "card-2", deletedAt: 3000 }] })],
  });
  assert.deepEqual(deletedCard.library.sets[0].cards.map((card) => card.id), ["card-1"]);
});

test("文件夹：删除墓碑生效，存活卡集的 folder 一定在列表里", () => {
  const store = createMemoryCardLibraryStore();
  sync(store, "user-a", { libraryUpdatedAt: 1000, sets: [setRecord("set-1", { folder: "期末复习" })], folders: ["我的卡集", "期末复习"] });
  const pruned = sync(store, "user-a", {
    libraryUpdatedAt: 3000,
    sets: [],
    folders: ["我的卡集"],
    removedFolders: [{ name: "期末复习", at: 3000 }],
  });
  assert.deepEqual(pruned.library.folders, ["我的卡集"]);
});

test("分享快照：冻结副本、匿名按 id 读、源卡集改动不影响、注销即回收", () => {
  const store = createMemoryCardLibraryStore();
  sync(store, "user-a", {
    libraryUpdatedAt: 1000,
    sets: [setRecord("set-1", { title: "分享时的标题", cards: [cardRecord("card-1", { question: "分享时的卡片" })] })],
  });
  const share = store.shareSet("user-a", "set-1", 7000);
  assert.match(share.shareId, /^cs-/);
  const read = store.getShare(share.shareId);
  assert.equal(read.set.title, "分享时的标题");
  assert.equal(read.set.cards[0].question, "分享时的卡片");

  sync(store, "user-a", {
    libraryUpdatedAt: 8000,
    sets: [setRecord("set-1", { title: "改过的标题", updatedAt: 8000, cards: [] })],
  });
  assert.equal(store.getShare(share.shareId).set.title, "分享时的标题", "快照与源卡集解耦");
  assert.equal(store.getShare("cs-不存在"), null);
  assert.throws(() => store.shareSet("user-a", "set-不存在"), /card_set_not_found/);

  assert.equal(store.deleteUser("user-a"), true);
  assert.equal(store.getShare(share.shareId), null, "注销用户时其分享快照一并回收");
});

test("入参校验：缺 userId / 卡集缺 id / 分享不存在的卡集", () => {
  const store = createMemoryCardLibraryStore();
  assert.throws(() => store.sync("", { sets: [] }), /card_library_user_required/);
  assert.throws(() => store.sync("user-a", { sets: [{ title: "没有 id" }] }), /card_set_id_required/);
  assert.throws(() => store.shareSet("user-a", "set-1"), /card_set_not_found/);
});

test("文件适配器：写盘后可读回（.runtime 之外的路径）", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-card-library-"));
  const filePath = path.join(directory, "card-library.json");
  const store = createFileCardLibraryStore(filePath);
  store.sync("user-a", { libraryUpdatedAt: 1000, folders: ["我的卡集"], sets: [setRecord("set-1")] }, 5000);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false, "不得留下 .tmp 残留文件");
  const reopened = createFileCardLibraryStore(filePath);
  assert.equal(reopened.get("user-a").sets[0].id, "set-1");
});

// ── HTTP 层：鉴权、同步接口、分享快照的匿名读取 ──────────────────────────────

async function startServer(context) {
  const cardLibraryStore = createMemoryCardLibraryStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    userAuthStore: createMemoryUserAuthStore(),
    cardLibraryStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, cardLibraryStore };
}

async function call(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

async function login(baseUrl, deviceId) {
  const response = await call(baseUrl, "/api/auth/wechat/login", {
    method: "POST",
    body: { code: `code-${deviceId}`, deviceId, profile: { nickname: `同学-${deviceId}` } },
  });
  assert.equal(response.status, 200, `用户登录失败：${JSON.stringify(response.payload)}`);
  return { token: response.payload.token, userId: response.payload.user.id };
}

test("卡库接口需要登录；匿名只能读分享快照", async (t) => {
  const { baseUrl } = await startServer(t);
  assert.equal((await call(baseUrl, "/api/card-library")).status, 401);
  assert.equal((await call(baseUrl, "/api/card-library/sync", { method: "POST", body: { sets: [] } })).status, 401);
  assert.equal((await call(baseUrl, "/api/card-library/share", { method: "POST", body: { setId: "set-1" } })).status, 401);

  const { token } = await login(baseUrl, "card-library-auth");
  const empty = await call(baseUrl, "/api/card-library", { token });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.payload.library.sets, []);

  await call(baseUrl, "/api/card-library/sync", {
    method: "POST",
    token,
    body: { libraryUpdatedAt: 4000, folders: ["我的卡集"], sets: [setRecord("set-1", { title: "服务端卡集" })] },
  });
  const shared = await call(baseUrl, "/api/card-library/share", { method: "POST", token, body: { setId: "set-1" } });
  assert.equal(shared.status, 200, JSON.stringify(shared.payload));

  const anonymous = await call(baseUrl, `/api/card-library/share/${shared.payload.shareId}`);
  assert.equal(anonymous.status, 200, "分享快照匿名可读");
  assert.equal(anonymous.payload.share.set.title, "服务端卡集");
  assert.equal((await call(baseUrl, "/api/card-library/share/cs-unknown")).status, 404);

  const missingSet = await call(baseUrl, "/api/card-library/share", { method: "POST", token, body: { setId: "set-404" } });
  assert.equal(missingSet.status, 404);
  assert.equal(missingSet.payload.error, "card_set_not_found");
});

test("注销账号时服务端卡库与分享快照一并清掉", async (t) => {
  const { baseUrl, cardLibraryStore } = await startServer(t);
  const { token } = await login(baseUrl, "card-library-delete");
  await call(baseUrl, "/api/card-library/sync", {
    method: "POST",
    token,
    body: { libraryUpdatedAt: 4000, folders: ["我的卡集"], sets: [setRecord("set-1")] },
  });
  const shared = await call(baseUrl, "/api/card-library/share", { method: "POST", token, body: { setId: "set-1" } });
  assert.equal(cardLibraryStore.counts().sets, 1);

  const removed = await call(baseUrl, "/api/account", { method: "DELETE", token });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(cardLibraryStore.counts().sets, 0);
  assert.equal(cardLibraryStore.counts().shares, 0);
  assert.equal((await call(baseUrl, `/api/card-library/share/${shared.payload.shareId}`)).status, 404, "注销后分享链接失效");
});
