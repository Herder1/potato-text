const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryAdminAccountStore } = require("../apps/api/src/admin-account-store");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryModerationStore } = require("../apps/api/src/moderation-store");
const { createMemoryBillingStore } = require("../apps/api/src/billing-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryLearningStateStore } = require("../apps/api/src/learning-state-store");
const {
  createMemoryUserRestrictionStore,
} = require("../apps/api/src/user-restriction-store");
const { createServer } = require("../apps/api/src/server");

// 用户侧登录走开发态 code 换 openid，测试必须显式处于非 production。
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
after(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

const ADMIN_USERNAME = "auditor";
const ADMIN_PASSWORD = "auditor-secret-1";

async function startServer(context, options = {}) {
  const adminAccountStore = options.adminAccountStore || createMemoryAdminAccountStore();
  if (!adminAccountStore.hasAccounts()) {
    adminAccountStore.ensureBootstrapAdmin({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      displayName: "治理审核员",
      mustChangePassword: false,
    });
  }
  const userAuthStore = options.userAuthStore || createMemoryUserAuthStore();
  const userRestrictionStore = options.userRestrictionStore || createMemoryUserRestrictionStore();
  const moderationStore = options.moderationStore || createMemoryModerationStore([]);
  const operationLogStore = options.operationLogStore || createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    adminAccountStore,
    userAuthStore,
    userRestrictionStore,
    moderationStore,
    operationLogStore,
    billingStore: createMemoryBillingStore(),
    learningStateStore: createMemoryLearningStateStore(),
    bootstrapAdmin: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    adminAccountStore,
    userAuthStore,
    userRestrictionStore,
    moderationStore,
    operationLogStore,
  };
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

async function adminLogin(baseUrl) {
  const response = await call(baseUrl, "/api/admin/auth/login", {
    method: "POST",
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  assert.equal(response.status, 200, `管理员登录失败：${JSON.stringify(response.payload)}`);
  return response.payload.token;
}

async function wechatLogin(baseUrl, deviceId) {
  const response = await call(baseUrl, "/api/auth/wechat/login", {
    method: "POST",
    body: { code: `code-${deviceId}`, deviceId, profile: { nickname: `同学-${deviceId}` } },
  });
  assert.equal(response.status, 200, `用户登录失败：${JSON.stringify(response.payload)}`);
  return { token: response.payload.token, userId: response.payload.user.id };
}

const PUBLIC_ASSET = {
  type: "note",
  title: "公开笔记",
  content: "整理词类、短语与句法成分的判断依据，并给出复习顺序与常见易错点说明。",
  subjectId: "modern-chinese",
  chapterId: "grammar",
  originality: "original",
  visibility: "public",
};

async function restrict(baseUrl, token, userId, type, durationDays = 7, reason = "测试限制") {
  const response = await call(baseUrl, "/api/admin/user-restrictions", {
    method: "POST",
    token,
    body: { userId, type, durationDays, reason },
  });
  assert.equal(response.status, 201, `下发限制失败：${JSON.stringify(response.payload)}`);
  return response.payload;
}

test("限制必须带到期时间：缺期限、超 365 天、过去时间、无理由全部拒绝", async (context) => {
  const runtime = await startServer(context);
  const adminToken = await adminLogin(runtime.baseUrl);
  const user = await wechatLogin(runtime.baseUrl, "policy-device");

  const noDuration = await call(runtime.baseUrl, "/api/admin/user-restrictions", {
    method: "POST",
    token: adminToken,
    body: { userId: user.userId, type: "mute", reason: "测试" },
  });
  assert.equal(noDuration.status, 422);
  assert.equal(noDuration.payload.error, "user_restriction_duration_required");

  const tooLong = await call(runtime.baseUrl, "/api/admin/user-restrictions", {
    method: "POST",
    token: adminToken,
    body: { userId: user.userId, type: "mute", reason: "测试", durationDays: 400 },
  });
  assert.equal(tooLong.payload.error, "user_restriction_duration_too_long");

  const inPast = await call(runtime.baseUrl, "/api/admin/user-restrictions", {
    method: "POST",
    token: adminToken,
    body: { userId: user.userId, type: "mute", reason: "测试", expiresAt: Date.now() - 1000 },
  });
  assert.equal(inPast.payload.error, "user_restriction_expiry_in_past");

  const noReason = await call(runtime.baseUrl, "/api/admin/user-restrictions", {
    method: "POST",
    token: adminToken,
    body: { userId: user.userId, type: "mute", durationDays: 7 },
  });
  assert.equal(noReason.payload.error, "user_restriction_reason_required");

  assert.equal(runtime.userRestrictionStore.list({}).summary.total, 0, "被拒绝的请求不该留下记录");
});

test("禁言：不能投稿也不能反馈，但可以继续刷题同步", async (context) => {
  const runtime = await startServer(context);
  const adminToken = await adminLogin(runtime.baseUrl);
  const user = await wechatLogin(runtime.baseUrl, "mute-device");
  await restrict(runtime.baseUrl, adminToken, user.userId, "mute");

  const submit = await call(runtime.baseUrl, "/api/community/assets", { method: "POST", token: user.token, body: { ...PUBLIC_ASSET, id: "mute-1", visibility: "private" } });
  assert.equal(submit.status, 403);
  assert.equal(submit.payload.error, "user_restricted");
  assert.match(submit.payload.restriction.message, /禁言/);
  assert.ok(submit.payload.restriction.expiresAt > Date.now(), "受限说明里必须带到期时间");

  const feedback = await call(runtime.baseUrl, "/api/feedback", {
    method: "POST",
    token: user.token,
    body: { category: "other", content: "这是一条测试反馈内容" },
  });
  assert.equal(feedback.status, 403);
  assert.equal(feedback.payload.error, "user_restricted");

  const sync = await call(runtime.baseUrl, "/api/learning/state/sync", {
    method: "POST",
    token: user.token,
    body: { attempts: [], bookmarks: {}, savedKnowledgeIds: [], scoreHistory: [] },
  });
  assert.equal(sync.status, 200, "禁言不该影响学习同步");
});

test("禁止投稿：拦投稿但放行反馈，与禁言是两个档位", async (context) => {
  const runtime = await startServer(context);
  const adminToken = await adminLogin(runtime.baseUrl);
  const user = await wechatLogin(runtime.baseUrl, "nosubmit-device");
  await restrict(runtime.baseUrl, adminToken, user.userId, "no_submit");

  const submit = await call(runtime.baseUrl, "/api/community/assets", { method: "POST", token: user.token, body: { ...PUBLIC_ASSET, id: "ns-1" } });
  assert.equal(submit.status, 403);
  assert.equal(submit.payload.restriction.types.includes("no_submit"), true);

  const feedback = await call(runtime.baseUrl, "/api/feedback", {
    method: "POST",
    token: user.token,
    body: { category: "other", content: "禁止投稿仍然可以反馈问题" },
  });
  assert.equal(feedback.status, 201, "禁止投稿不该拦住反馈");
});

test("公开功能限制：私有照常，公开与成套导出被拦", async (context) => {
  const runtime = await startServer(context);
  const adminToken = await adminLogin(runtime.baseUrl);
  const user = await wechatLogin(runtime.baseUrl, "nopublic-device");
  await restrict(runtime.baseUrl, adminToken, user.userId, "no_public");

  const privateAsset = await call(runtime.baseUrl, "/api/community/assets", {
    method: "POST",
    token: user.token,
    body: { ...PUBLIC_ASSET, id: "np-private", visibility: "private" },
  });
  assert.equal(privateAsset.status, 201, "只能限制公开，私有内容应放行");

  const publicAsset = await call(runtime.baseUrl, "/api/community/assets", {
    method: "POST",
    token: user.token,
    body: { ...PUBLIC_ASSET, id: "np-public", visibility: "public" },
  });
  assert.equal(publicAsset.status, 403);
  assert.equal(publicAsset.payload.restriction.types.includes("no_public"), true);

  const exported = await call(runtime.baseUrl, "/api/exam-exports", { method: "POST", token: user.token, body: { examId: "exam-official-001" } });
  assert.equal(exported.status, 403);
  assert.equal(exported.payload.error, "user_restricted");
});

test("账号封禁：登录被拒、既有会话被撤销、写入与计费全断", async (context) => {
  const runtime = await startServer(context);
  const adminToken = await adminLogin(runtime.baseUrl);
  const user = await wechatLogin(runtime.baseUrl, "ban-device");
  // 先确认会话可用
  assert.equal((await call(runtime.baseUrl, "/api/learning/state", { token: user.token })).status, 200);

  await restrict(runtime.baseUrl, adminToken, user.userId, "ban", 30, "多次发布导流广告");

  assert.equal((await call(runtime.baseUrl, "/api/learning/state", { token: user.token })).status, 401, "封禁必须立即撤销既有会话");

  const relogin = await call(runtime.baseUrl, "/api/auth/wechat/login", {
    method: "POST",
    body: { code: "code-ban-device", deviceId: "ban-device" },
  });
  assert.equal(relogin.status, 403);
  assert.equal(relogin.payload.error, "user_account_banned");
  assert.match(relogin.payload.restriction.message, /封禁/);

  const adminToken2 = await adminLogin(runtime.baseUrl);
  const sync = await call(runtime.baseUrl, "/api/learning/state/sync", {
    method: "POST",
    token: user.token,
    body: { attempts: [], bookmarks: {}, savedKnowledgeIds: [], scoreHistory: [] },
  });
  assert.equal(sync.status, 401, "旧 token 已被撤销");

  const consume = await call(runtime.baseUrl, "/api/billing/credits/consume", {
    method: "POST",
    token: user.token,
    // 显式声明本人身份：开发态下匿名请求会退化成 test-user 通道（正式环境本就是 401），
    // 这里要验证的是“被封禁的人不能以自己身份花钱”。
    body: { amount: 1, reason: "test", userId: user.userId },
  });
  assert.equal(consume.status, 401);
  assert.ok(adminToken2);
});

test("到期自动失效，不需要人工解除", async (context) => {
  const runtime = await startServer(context);
  const adminToken = await adminLogin(runtime.baseUrl);
  const user = await wechatLogin(runtime.baseUrl, "expire-device");
  await restrict(runtime.baseUrl, adminToken, user.userId, "no_submit", 7);

  const blocked = await call(runtime.baseUrl, "/api/community/assets", { method: "POST", token: user.token, body: { ...PUBLIC_ASSET, id: "expire-1" } });
  assert.equal(blocked.status, 403);

  // 把到期时间挪到过去，模拟自然到期（服务端不额外写字段，状态由 expiresAt 派生）
  const state = runtime.userRestrictionStore.exportState();
  state.restrictions.forEach((item) => { item.expiresAt = Date.now() - 60 * 1000; });
  runtime.userRestrictionStore.replaceState(state);

  const allowed = await call(runtime.baseUrl, "/api/community/assets", { method: "POST", token: user.token, body: { ...PUBLIC_ASSET, id: "expire-2" } });
  assert.equal(allowed.status, 201, "到期后应自动恢复");
  assert.equal(runtime.userRestrictionStore.list({ status: "active" }).summary.active, 0);
  assert.equal(runtime.userRestrictionStore.list({ status: "expired" }).items.length, 1);
});

test("解除限制仅限超级管理员，解除后立即恢复", async (context) => {
  const runtime = await startServer(context);
  const superToken = await adminLogin(runtime.baseUrl);
  const created = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: superToken,
    body: { username: "opsr", password: "ops-restrict-1", displayName: "运营小周", role: "operator" },
  });
  assert.equal(created.status, 201);
  const operatorSession = await call(runtime.baseUrl, "/api/admin/auth/login", {
    method: "POST",
    body: { username: "opsr", password: "ops-restrict-1" },
  });
  const operatorToken = operatorSession.payload.token;

  const user = await wechatLogin(runtime.baseUrl, "lift-device");
  // 运营可以下发限制
  const applied = await restrict(runtime.baseUrl, operatorToken, user.userId, "mute", 3, "运营下发");
  const restrictionId = applied.items[0].id;

  const operatorLift = await call(runtime.baseUrl, `/api/admin/user-restrictions/${restrictionId}/lift`, { method: "POST", token: operatorToken, body: { note: "试着解除" } });
  assert.equal(operatorLift.status, 403, "解除权限只给超级管理员");
  assert.equal(operatorLift.payload.error, "admin_permission_denied");

  const stillBlocked = await call(runtime.baseUrl, "/api/community/assets", { method: "POST", token: user.token, body: { ...PUBLIC_ASSET, id: "lift-1", visibility: "private" } });
  assert.equal(stillBlocked.status, 403);

  const superLift = await call(runtime.baseUrl, `/api/admin/user-restrictions/${restrictionId}/lift`, { method: "POST", token: superToken, body: { note: "申诉通过" } });
  assert.equal(superLift.status, 200);
  assert.equal(superLift.payload.restriction.status, "lifted");
  assert.equal(superLift.payload.restriction.liftedBy, "治理审核员");

  const restored = await call(runtime.baseUrl, "/api/community/assets", { method: "POST", token: user.token, body: { ...PUBLIC_ASSET, id: "lift-2", visibility: "private" } });
  assert.equal(restored.status, 201, "解除后应立即恢复");

  const logs = runtime.operationLogStore.list({ category: "moderation" }).items;
  assert.ok(logs.some((item) => item.action === "user_restriction.apply" && item.actor === "运营小周"), "下发限制要记录真实操作人");
  assert.ok(logs.some((item) => item.action === "user_restriction.lift" && item.actor === "治理审核员"), "解除限制要记录真实操作人");
});

test("举报处置的四类动作真的落到用户状态，且必须填期限", async (context) => {
  const runtime = await startServer(context);
  const adminToken = await adminLogin(runtime.baseUrl);
  const user = await wechatLogin(runtime.baseUrl, "report-device");
  const report = runtime.moderationStore.create({
    type: "spam",
    risk: "high",
    targetType: "comment",
    targetId: "comment-1",
    targetTitle: "题目评论：求资料私聊",
    reporter: { id: "u-reporter", nickname: "木子" },
    reportedUser: { id: user.userId, nickname: "资料分享员" },
    reason: "评论区重复导流",
  });

  // 缺期限：处置被拒，不能留下“假处置”
  const noDuration = await call(runtime.baseUrl, `/api/admin/moderation/${report.id}/action`, {
    method: "POST",
    token: adminToken,
    body: { action: "mute_user", note: "先禁言" },
  });
  assert.equal(noDuration.status, 422);
  assert.equal(noDuration.payload.error, "user_restriction_duration_required");
  assert.equal(runtime.userRestrictionStore.list({}).summary.total, 0);

  for (const [action, type] of [["mute_user", "mute"], ["no_submit_user", "no_submit"], ["no_public_user", "no_public"], ["ban_user", "ban"]]) {
    const reportForAction = runtime.moderationStore.create({
      type: "spam",
      risk: "high",
      targetType: "comment",
      targetId: `comment-${type}`,
      targetTitle: `评论 ${type}`,
      reporter: { id: "u-reporter", nickname: "木子" },
      reportedUser: { id: user.userId, nickname: "资料分享员" },
      reason: "评论区重复导流",
    });
    const acted = await call(runtime.baseUrl, `/api/admin/moderation/${reportForAction.id}/action`, {
      method: "POST",
      token: adminToken,
      body: { action, note: "人工确认违规", reason: "评论区重复导流", durationDays: 7 },
    });
    assert.equal(acted.status, 200, `${action} 处置失败：${JSON.stringify(acted.payload)}`);
    assert.equal(acted.payload.restriction.items.some((item) => item.type === type), true, `${action} 应写入 ${type} 限制`);
    assert.match(acted.payload.report.resolution, /./);
  }

  const status = runtime.userRestrictionStore.statusFor(user.userId);
  assert.deepEqual(status.activeTypes.sort(), ["ban", "mute", "no_public", "no_submit"]);
  assert.equal(status.capabilities.write, true, "封禁后 write 能力被拦");
});

test("同类型重复下发是延长而不是叠加，且记录能力映射正确", () => {
  const store = createMemoryUserRestrictionStore();
  const now = Date.now();
  const first = store.apply({ userId: "u-1", type: "mute", reason: "第一次", durationDays: 3, createdBy: "ops" }, now);
  const second = store.apply({ userId: "u-1", type: "mute", reason: "再次违规", durationDays: 10, createdBy: "ops" }, now + 1000);
  assert.equal(store.list({ userId: "u-1" }).items.length, 1, "同类型应延长而不是新建");
  assert.equal(second.items[0].id, first.items[0].id);
  assert.ok(second.items[0].expiresAt > first.items[0].expiresAt);
  assert.equal(second.items[0].history.length, 2);

  const status = store.statusFor("u-1", now + 2000);
  assert.deepEqual(status.capabilities, { speak: true, submit: true, publish: false, write: false });

  assert.throws(() => store.lift("not-exist", { liftedBy: "super" }, now), /user_restriction_not_found/);
  store.lift(second.items[0].id, { liftedBy: "super", liftedById: "admin-1" }, now + 2000);
  assert.throws(() => store.lift(second.items[0].id, { liftedBy: "super" }, now + 3000), /user_restriction_already_lifted/);
  assert.equal(store.statusFor("u-1", now + 3000).restricted, false);
});
