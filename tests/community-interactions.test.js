const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryCommunityInteractionStore } = require("../apps/api/src/community-interaction-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createServer } = require("../apps/api/src/server");

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
after(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

async function startServer(context) {
  const communityInteractionStore = createMemoryCommunityInteractionStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    userAuthStore: createMemoryUserAuthStore(),
    communityInteractionStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, communityInteractionStore };
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

async function firstPublishedAsset(baseUrl) {
  const listing = await call(baseUrl, "/api/community/assets");
  const asset = listing.payload.assets.find((item) => item.moderationStatus === "published");
  assert.ok(asset, "种子数据里应当有已发布的社区内容");
  return asset;
}

test("收藏与复制都必须登录：匿名一律 401", async (context) => {
  const runtime = await startServer(context);
  const asset = await firstPublishedAsset(runtime.baseUrl);
  assert.equal((await call(runtime.baseUrl, `/api/community/assets/${asset.id}/favorite`, { method: "POST" })).status, 401);
  assert.equal((await call(runtime.baseUrl, `/api/community/assets/${asset.id}/unfavorite`, { method: "POST" })).status, 401);
  assert.equal((await call(runtime.baseUrl, `/api/community/assets/${asset.id}/collect`, { method: "POST" })).status, 401);
  assert.equal((await call(runtime.baseUrl, "/api/community/assets/favorites")).status, 401);
});

test("收藏是引用关系：重复收藏不刷数，取消收藏回落且不减成负数", async (context) => {
  const runtime = await startServer(context);
  const user = await login(runtime.baseUrl, "fav-device");
  const asset = await firstPublishedAsset(runtime.baseUrl);
  const base = Number(asset.favoriteCount) || 0;

  const first = await call(runtime.baseUrl, `/api/community/assets/${asset.id}/favorite`, { method: "POST", token: user.token });
  assert.equal(first.status, 200);
  assert.equal(first.payload.changed, true);
  assert.equal(first.payload.asset.favoriteCount, base + 1);

  const again = await call(runtime.baseUrl, `/api/community/assets/${asset.id}/favorite`, { method: "POST", token: user.token });
  assert.equal(again.payload.changed, false, "同一个人重复收藏不能重复计数");
  assert.equal(again.payload.asset.favoriteCount, base + 1);

  const removed = await call(runtime.baseUrl, `/api/community/assets/${asset.id}/unfavorite`, { method: "POST", token: user.token });
  assert.equal(removed.payload.changed, true);
  assert.equal(removed.payload.asset.favoriteCount, base);

  const removedAgain = await call(runtime.baseUrl, `/api/community/assets/${asset.id}/unfavorite`, { method: "POST", token: user.token });
  assert.equal(removedAgain.payload.changed, false);
  assert.equal(removedAgain.payload.asset.favoriteCount, base, "重复取消不能把计数减成负数或漂移");
});

test("复制计数按“人 × 内容”去重，不同人分别计一次", async (context) => {
  const runtime = await startServer(context);
  const userA = await login(runtime.baseUrl, "copy-a");
  const userB = await login(runtime.baseUrl, "copy-b");
  const asset = await firstPublishedAsset(runtime.baseUrl);
  const base = Number(asset.copyCount) || 0;

  const first = await call(runtime.baseUrl, `/api/community/assets/${asset.id}/collect`, { method: "POST", token: userA.token });
  assert.equal(first.status, 200);
  assert.equal(first.payload.copied, true);
  assert.equal(first.payload.asset.copyCount, base + 1);

  const repeat = await call(runtime.baseUrl, `/api/community/assets/${asset.id}/collect`, { method: "POST", token: userA.token });
  assert.equal(repeat.payload.copied, false, "同一个人重复复制不能重复计数");
  assert.equal(repeat.payload.asset.copyCount, base + 1);

  const other = await call(runtime.baseUrl, `/api/community/assets/${asset.id}/collect`, { method: "POST", token: userB.token });
  assert.equal(other.payload.copied, true);
  assert.equal(other.payload.asset.copyCount, base + 2, "换一个人复制应当再计一次");
});

test("我的收藏只看引用：按人隔离，并回显已收藏状态", async (context) => {
  const runtime = await startServer(context);
  const userA = await login(runtime.baseUrl, "fav-list-a");
  const userB = await login(runtime.baseUrl, "fav-list-b");
  const listing = await call(runtime.baseUrl, "/api/community/assets");
  const [asset1, asset2] = listing.payload.assets.filter((item) => item.moderationStatus === "published");
  await call(runtime.baseUrl, `/api/community/assets/${asset1.id}/favorite`, { method: "POST", token: userA.token });
  await call(runtime.baseUrl, `/api/community/assets/${asset2.id}/favorite`, { method: "POST", token: userA.token });
  await call(runtime.baseUrl, `/api/community/assets/${asset2.id}/favorite`, { method: "POST", token: userB.token });

  const mineA = await call(runtime.baseUrl, "/api/community/assets/favorites", { token: userA.token });
  assert.equal(mineA.status, 200);
  assert.deepEqual(mineA.payload.assets.map((item) => item.id).sort(), [asset1.id, asset2.id].sort());

  const mineB = await call(runtime.baseUrl, "/api/community/assets/favorites", { token: userB.token });
  assert.deepEqual(mineB.payload.assets.map((item) => item.id), [asset2.id]);

  // 公开列表按登录用户回显“已收藏/已复制”，未登录时不回显
  const asUserA = await call(runtime.baseUrl, "/api/community/assets", { token: userA.token });
  assert.equal(asUserA.payload.assets.find((item) => item.id === asset1.id).viewerFavorited, true);
  assert.equal(asUserA.payload.assets.find((item) => item.id === asset2.id).viewerFavorited, true);
  const anonymous = await call(runtime.baseUrl, "/api/community/assets");
  assert.equal(anonymous.payload.assets.find((item) => item.id === asset1.id).viewerFavorited, false);
});

test("注销账号会一并清掉收藏与复制记录", async (context) => {
  const runtime = await startServer(context);
  const user = await login(runtime.baseUrl, "purge-device");
  const asset = await firstPublishedAsset(runtime.baseUrl);
  await call(runtime.baseUrl, `/api/community/assets/${asset.id}/favorite`, { method: "POST", token: user.token });
  await call(runtime.baseUrl, `/api/community/assets/${asset.id}/collect`, { method: "POST", token: user.token });
  assert.deepEqual(runtime.communityInteractionStore.counts(), { favorites: 1, copies: 1 });

  const deleted = await call(runtime.baseUrl, "/api/account", { method: "DELETE", token: user.token });
  assert.equal(deleted.status, 200);
  assert.deepEqual(runtime.communityInteractionStore.counts(), { favorites: 0, copies: 0 }, "注销必须清掉个人关系数据");
});
