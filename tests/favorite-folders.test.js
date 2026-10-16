const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryCommunityInteractionStore } = require("../apps/api/src/community-interaction-store");
const { createMemoryFavoriteFolderStore } = require("../apps/api/src/favorite-folder-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createServer } = require("../apps/api/src/server");

/**
 * 「我的收藏」的文件夹 / 子文件夹 / 成员归属 / 全局置顶（DEC-096，2026-09-23）。
 *
 * 这份测试盯的是**口径**而不是实现细节：
 * - 收藏本身不落在这个 store 里（社区走引用关系、题目走学习状态里的书签），本 store 只存"怎么组织"；
 * - 两级封顶（文件夹 → 子文件夹），越级必须拒绝而不是默默压平；
 * - 父文件夹的条数＝直属 + 子文件夹（12 = 5 + 4 + 3 那组数字要对得上）；
 * - 「全部收藏」＝社区收藏 + 题目收藏（产品负责人选定"两类合并进同一列表"）；
 * - 取消收藏后残留的归属与置顶要清掉（prune），否则会出现"文件夹里有数字、点进去空的"。
 */

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
after(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

async function startServer(context) {
  const communityInteractionStore = createMemoryCommunityInteractionStore();
  const favoriteFolderStore = createMemoryFavoriteFolderStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    userAuthStore: createMemoryUserAuthStore(),
    communityInteractionStore,
    favoriteFolderStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, communityInteractionStore, favoriteFolderStore };
}

async function call(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
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

/** 服务端的题目收藏真源在「学习状态」里：这里走真实同步接口写两条书签，模拟用户在刷题页收藏了两道题。 */
async function bookmarkQuestions(baseUrl, token, ids) {
  const bookmarks = {};
  ids.forEach((id) => { bookmarks[id] = { value: true, updatedAt: Date.now() }; });
  const response = await call(baseUrl, "/api/learning/state/sync", { method: "POST", token, body: { bookmarks } });
  assert.equal(response.status, 200, `书签同步失败：${JSON.stringify(response.payload)}`);
}

test("收藏文件夹接口需要登录", async (t) => {
  const { baseUrl } = await startServer(t);
  assert.equal((await call(baseUrl, "/api/favorites/folders")).status, 401);
  assert.equal((await call(baseUrl, "/api/favorites/folders", { method: "POST", body: { name: "教育学" } })).status, 401);
  assert.equal((await call(baseUrl, "/api/favorites/membership", { method: "POST", body: { kind: "question", refId: "q1" } })).status, 401);
  assert.equal((await call(baseUrl, "/api/favorites/pins", { method: "POST", body: { kind: "question", refId: "q1" } })).status, 401);
});

test("文件夹与子文件夹：两级封顶、同级重名拒绝、改名与重排", async (t) => {
  const { baseUrl } = await startServer(t);
  const { token } = await login(baseUrl, "folder-crud");

  const first = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育学" } });
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  const educationId = first.payload.folders[0].id;
  assert.equal(first.payload.folders[0].name, "教育学");
  assert.equal(first.payload.folders[0].parentId, null);

  const duplicated = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育学" } });
  assert.equal(duplicated.status, 400);
  assert.equal(duplicated.payload.error, "favorite_folder_name_duplicate");

  const blank = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "   " } });
  assert.equal(blank.payload.error, "favorite_folder_name_required");

  const second = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "阅读清单" } });
  assert.equal(second.payload.folders.length, 2);
  const readingId = second.payload.folders.find((folder) => folder.name === "阅读清单").id;

  const sub = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育理论", parentId: educationId } });
  assert.equal(sub.status, 200, JSON.stringify(sub.payload));
  const theoryId = sub.payload.folders.find((folder) => folder.name === "教育理论").id;
  assert.equal(sub.payload.folders.find((folder) => folder.id === theoryId).parentId, educationId);
  // 同一父级下可以重名吗？不能：子文件夹之间也要唯一（否则抽屉里分不清）。
  assert.equal((await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育理论", parentId: educationId } })).payload.error,
    "favorite_folder_name_duplicate");

  // 子文件夹不能再挂子文件夹（DEC-096 ② 固定两级）。
  const deep = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "三级", parentId: theoryId } });
  assert.equal(deep.status, 400);
  assert.equal(deep.payload.error, "favorite_folder_depth_exceeded");

  const renamed = await call(baseUrl, `/api/favorites/folders/${theoryId}`, { method: "PATCH", token, body: { name: "教育原理" } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.payload.folders.find((folder) => folder.id === theoryId).name, "教育原理");

  const reordered = await call(baseUrl, "/api/favorites/folders/reorder", {
    method: "POST", token, body: { parentId: null, order: [readingId, educationId] },
  });
  assert.equal(reordered.status, 200);
  const topLevel = reordered.payload.folders.filter((folder) => !folder.parentId).map((folder) => folder.name);
  assert.deepEqual(topLevel, ["阅读清单", "教育学"]);

  // 重排必须给全该层级，缺项拒绝（半个列表保持沉默的旧顺序比报错更难查）。
  const partial = await call(baseUrl, "/api/favorites/folders/reorder", { method: "POST", token, body: { parentId: null, order: [readingId] } });
  assert.equal(partial.payload.error, "favorite_folder_reorder_incomplete");

  const missing = await call(baseUrl, "/api/favorites/folders/not-exist", { method: "PATCH", token, body: { name: "谁" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.error, "favorite_folder_missing");
});

test("条数口径：父文件夹＝直属＋子文件夹，「全部收藏」＝社区收藏＋题目收藏", async (t) => {
  const { baseUrl, communityInteractionStore } = await startServer(t);
  const { token, userId } = await login(baseUrl, "folder-counts");

  // 真源：3 条社区收藏（直接写关系记录，等价于用户在社区点了三次收藏）+ 2 条题目收藏（走真实同步接口）。
  ["asset-1", "asset-2", "asset-3"].forEach((assetId) => communityInteractionStore.add({ kind: "favorite", assetId, userId }));
  await bookmarkQuestions(baseUrl, token, ["q-1", "q-2"]);

  const created = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育学" } });
  const educationId = created.payload.folders[0].id;
  const withSub = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育理论", parentId: educationId } });
  const theoryId = withSub.payload.folders.find((folder) => folder.name === "教育理论").id;

  // 1 条放子文件夹、1 条放父文件夹、1 条社区收藏不进任何文件夹（未分类）。
  await call(baseUrl, "/api/favorites/membership", { method: "POST", token, body: { kind: "community", refId: "asset-1", folderId: theoryId } });
  await call(baseUrl, "/api/favorites/membership", { method: "POST", token, body: { kind: "community", refId: "asset-2", folderId: educationId } });
  const snapshot = await call(baseUrl, "/api/favorites/membership", { method: "POST", token, body: { kind: "question", refId: "q-1", folderId: theoryId } });

  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.payload.counts.direct[theoryId], 2);
  assert.equal(snapshot.payload.counts.direct[educationId], 1);
  // 父文件夹的数字要把子文件夹并进来（12 = 5 + 4 + 3 的那组数字要对得上）。
  assert.equal(snapshot.payload.counts.withChildren[educationId], 3);
  assert.deepEqual(snapshot.payload.totals, { community: 3, question: 2, all: 5, unfiled: 2 });

  // 归属可改可撤：folderId 传空＝移出，回到"未分类"。
  const moved = await call(baseUrl, "/api/favorites/membership", { method: "POST", token, body: { kind: "community", refId: "asset-1", folderId: null } });
  assert.equal(moved.payload.membership["community:asset-1"], undefined);
  assert.equal(moved.payload.counts.withChildren[educationId], 2);

  // 归属关系是"引用"：跨用户不可见、也不互相污染。
  const other = await login(baseUrl, "folder-counts-other");
  const otherView = await call(baseUrl, "/api/favorites/folders", { token: other.token });
  assert.equal(otherView.payload.folders.length, 0);
  assert.equal(otherView.payload.totals.all, 0);
});

test("全局置顶：同一条收藏在任何文件夹里都排最前；取消收藏后残留的归属与置顶被清掉", async (t) => {
  const { baseUrl, communityInteractionStore } = await startServer(t);
  const { token, userId } = await login(baseUrl, "folder-pins");
  communityInteractionStore.add({ kind: "favorite", assetId: "asset-pin", userId });
  await bookmarkQuestions(baseUrl, token, ["q-pin"]);

  const pinned = await call(baseUrl, "/api/favorites/pins", { method: "POST", token, body: { kind: "community", refId: "asset-pin", pinned: true } });
  assert.equal(pinned.status, 200);
  assert.deepEqual(pinned.payload.pins.map((pin) => `${pin.kind}:${pin.refId}`), ["community:asset-pin"]);

  const unpinned = await call(baseUrl, "/api/favorites/pins", { method: "POST", token, body: { kind: "community", refId: "asset-pin", pinned: false } });
  assert.equal(unpinned.payload.pins.length, 0);

  // 赋值一条归属再取消收藏（社区 unfavorite / 题目书签置 false 两条路径都要落到"清干净"）。
  await call(baseUrl, "/api/favorites/pins", { method: "POST", token, body: { kind: "question", refId: "q-pin", pinned: true } });
  const created = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "待整理" } });
  const folderId = created.payload.folders[0].id;
  await call(baseUrl, "/api/favorites/membership", { method: "POST", token, body: { kind: "question", refId: "q-pin", folderId } });

  const resync = await call(baseUrl, "/api/learning/state/sync", { method: "POST", token, body: { bookmarks: { "q-pin": { value: false, updatedAt: Date.now() } } } });
  assert.equal(resync.status, 200);

  const after = await call(baseUrl, "/api/favorites/folders", { token });
  assert.equal(after.payload.totals.question, 0);
  assert.equal(after.payload.membership["question:q-pin"], undefined);
  assert.equal(after.payload.pins.length, 0);
  assert.equal(after.payload.counts.withChildren[folderId], 0);

  // 空文件夹留着（是用户自己建的），但数字必须是 0 —— 不允许"文件夹里有数字、点进去空的"。
  assert.equal(after.payload.folders.some((folder) => folder.id === folderId), true);
});

test("删除文件夹：连子文件夹一起删，里面的收藏退回未分类（不删收藏本身）", async (t) => {
  const { baseUrl } = await startServer(t);
  const { token } = await login(baseUrl, "folder-delete");
  await bookmarkQuestions(baseUrl, token, ["q-a", "q-b"]);

  const created = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育学" } });
  const educationId = created.payload.folders[0].id;
  const sub = await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育理论", parentId: educationId } });
  const theoryId = sub.payload.folders.find((folder) => folder.name === "教育理论").id;
  await call(baseUrl, "/api/favorites/membership", { method: "POST", token, body: { kind: "question", refId: "q-a", folderId: theoryId } });
  await call(baseUrl, "/api/favorites/membership", { method: "POST", token, body: { kind: "question", refId: "q-b", folderId: educationId } });

  const deleted = await call(baseUrl, `/api/favorites/folders/${educationId}`, { method: "DELETE", token });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.payload.folders.length, 0);
  assert.equal(deleted.payload.membership["question:q-a"], undefined);
  assert.equal(deleted.payload.membership["question:q-b"], undefined);
  // 收藏本身没被删掉，只是回到"未分类"。
  assert.equal(deleted.payload.totals.question, 2);
  assert.equal(deleted.payload.totals.unfiled, 2);
});

test("注销账号会清掉收藏文件夹（个人组织数据不残留）", async (t) => {
  const { baseUrl, favoriteFolderStore } = await startServer(t);
  const { token, userId } = await login(baseUrl, "folder-account-delete");
  await call(baseUrl, "/api/favorites/folders", { method: "POST", token, body: { name: "教育学" } });
  assert.equal(favoriteFolderStore.counts().folders, 1);

  const deleted = await call(baseUrl, "/api/account", { method: "DELETE", token });
  assert.equal(deleted.status, 200);
  assert.equal(favoriteFolderStore.counts().folders, 0);
  assert.equal(favoriteFolderStore.counts().members, 0);
});
