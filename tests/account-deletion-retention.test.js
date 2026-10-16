const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMemoryCommunityAssetStore,
} = require("../apps/api/src/community-asset-store");
const {
  createMemoryModerationStore,
} = require("../apps/api/src/moderation-store");
const {
  createMemoryUserRestrictionStore,
} = require("../apps/api/src/user-restriction-store");
const {
  createMemoryBillingStore,
} = require("../apps/api/src/billing-store");
const {
  createMemoryAiTaskStore,
} = require("../apps/api/src/ai-task-store");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("account deletion keeps only published community assets and anonymizes their author", () => {
  const store = createMemoryCommunityAssetStore([
    {
      id: "published",
      userId: "user-1",
      visibility: "public",
      moderationStatus: "published",
      contributor: "原作者",
      title: "公开题目",
    },
    {
      id: "pending",
      userId: "user-1",
      visibility: "public",
      moderationStatus: "pending_review",
      contributor: "原作者",
      title: "待审题目",
    },
  ]);

  assert.deepEqual(store.anonymizeUser("user-1", 1000), { anonymized: 1, removed: 1 });
  assert.deepEqual(store.get("published"), {
    id: "published",
    visibility: "public",
    moderationStatus: "published",
    contributor: "匿名用户",
    title: "公开题目",
    anonymizedAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(store.get("pending"), null);
});

test("account deletion anonymizes feedback identity and applies retention deadlines", () => {
  const store = createMemoryModerationStore([]);
  const feedback = store.create({
    type: "product_feedback",
    targetType: "app_feedback",
    targetId: "feedback-1",
    reason: "反馈",
    detail: "普通反馈",
    reporter: { id: "user-1", nickname: "用户一" },
    contact: "13800000000",
  });
  const report = store.create({
    type: "spam",
    targetType: "community_asset",
    targetId: "asset-1",
    reason: "举报",
    detail: "举报详情",
    reporter: { id: "user-1", nickname: "用户一" },
  });
  store.anonymizeUser("user-1", 1000);

  assert.equal(store.get(feedback.id).reporter.id, "anonymous");
  assert.equal(store.get(feedback.id).contact, "");
  assert.equal(store.get(feedback.id).retentionUntil, 1000 + 30 * 24 * 60 * 60 * 1000);
  assert.equal(store.get(report.id).retentionUntil, 1000 + 180 * 24 * 60 * 60 * 1000);

  store.action(feedback.id, "resolve", "管理员", "已处理");
  const closed = store.get(feedback.id);
  assert.equal(closed.retentionUntil > 1000, true);
  assert.equal(store.sweepExpired(closed.retentionUntil + 1), 1);
  assert.equal(store.get(feedback.id), null);
});

test("account deletion anonymizes restrictions and preserves only the retention window", () => {
  const store = createMemoryUserRestrictionStore({ restrictions: [{
    id: "restriction-1",
    userId: "user-1",
    type: "mute",
    reason: "违规",
    startsAt: 1,
    expiresAt: 2,
    createdAt: 1,
    updatedAt: 1,
    liftedAt: 0,
    history: [],
  }] });

  assert.equal(store.anonymizeUser("user-1", 1000), 1);
  assert.equal(store.exportState().restrictions[0].userId, "anonymous");
  assert.equal(store.sweep(1000 + 180 * 24 * 60 * 60 * 1000 + 1), 1);
  assert.deepEqual(store.exportState().restrictions, []);
});

test("account deletion detaches billing identity without deleting financial records", () => {
  const store = createMemoryBillingStore();
  const purchase = store.purchaseProduct("user-1", "product-beans-5", { channel: "test" }, 1000);

  assert.equal(store.anonymizeUser("user-1", 2000), true);
  const state = store.exportState();
  assert.equal(state.accounts.length, 2, "seed account plus anonymized account remain");
  const account = state.accounts.find((item) => item.orders.some((order) => order.id === purchase.order.id));
  assert.ok(account);
  assert.match(account.userId, /^billing-anonymous-/);
  assert.equal(account.nickname, "匿名用户");
  assert.equal(account.orders.length, 1);
  assert.equal(account.transactions.length > 0, true);
});

test("AI task records can be removed by account owner", () => {
  const store = createMemoryAiTaskStore([
    { id: "task-1", userId: "user-1", sceneId: "explanation_chat" },
    { id: "task-2", userId: "user-2", sceneId: "explanation_chat" },
  ]);

  assert.equal(store.deleteUser("user-1"), 1);
  assert.equal(store.get("task-1"), null);
  assert.ok(store.get("task-2"));
});

test("DELETE /api/account executes the cross-store privacy policy", async () => {
  const userAuthStore = createMemoryUserAuthStore();
  const communityAssetStore = createMemoryCommunityAssetStore();
  const moderationStore = createMemoryModerationStore([]);
  const billingStore = createMemoryBillingStore();
  const aiTaskStore = createMemoryAiTaskStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    userAuthStore,
    communityAssetStore,
    moderationStore,
    billingStore,
    aiTaskStore,
    bootstrapAdmin: false,
  });
  const baseUrl = await listen(server);
  try {
    const loginResponse = await fetch(`${baseUrl}/api/auth/wechat/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "account-delete-test" }),
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    const userId = login.user.id;
    const token = login.token;

    const asset = communityAssetStore.submit({
      id: "public-1",
      type: "note",
      title: "公开内容",
      content: "这是一段足够长的公开内容，用于注销闭环测试。",
      subjectId: "modern-chinese",
      chapterId: "chapter-1",
      originality: "original",
      contributor: "真实作者",
    }, userId);
    moderationStore.create({
      type: "product_feedback",
      targetType: "app_feedback",
      targetId: "feedback-1",
      reason: "反馈",
      detail: "反馈正文",
      reporter: { id: userId, nickname: "真实作者" },
      contact: "13800000000",
    });
    billingStore.purchaseProduct(userId, "product-beans-5", { channel: "test" }, 1000);
    aiTaskStore.start({ userId, sceneId: "explanation_chat" });

    const deletion = await fetch(`${baseUrl}/api/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(deletion.status, 200);
    assert.equal(userAuthStore.authenticate(token), null);
    assert.equal(communityAssetStore.get(asset.id).contributor, "匿名用户");
    assert.equal(communityAssetStore.get(asset.id).userId, undefined);
    assert.equal(moderationStore.list({}).reports[0].reporter.id, "anonymous");
    assert.equal(aiTaskStore.list({}).some((task) => task.userId === userId), false);
    assert.equal(billingStore.exportState().accounts.some((account) => account.userId === userId), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
