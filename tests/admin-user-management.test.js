const test = require("node:test");
const assert = require("node:assert/strict");

const { createServer, adminPermissionForPath } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminAccountStore } = require("../apps/api/src/admin-account-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryUserRestrictionStore } = require("../apps/api/src/user-restriction-store");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
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

test("账号注销只留下不含身份的计数事件，累计注册包含已注销账号", () => {
  const now = Date.now();
  const currentYear = new Date(now).getFullYear();
  const store = createMemoryUserAuthStore({
    users: [{
      id: "user-old",
      publicId: "123456789",
      nickname: "旧同学",
      createdAt: now - 1000,
      lastLoginAt: now - 1000,
    }],
    sessions: [],
  });
  const created = store.loginWechat({ openid: "new-user" }, now - 500);
  store.updateProfile(created.user.id, {
    gender: "undisclosed",
    birthday: "2004-05-06",
    examProjectId: "gd-zsb-2026-hywxxkjc",
    examYear: currentYear,
  });

  const before = store.accountSummary(now + 1000);
  assert.equal(before.currentUsers, 2);
  assert.equal(before.registeredTotal, 2);
  assert.equal(before.onboardedUsers, 1);
  assert.equal(before.deletedTotal, 0);

  assert.equal(store.deleteUser(created.user.id, now + 2000), true);
  const after = store.accountSummary(now + 3000);
  assert.equal(after.currentUsers, 1);
  assert.equal(after.registeredTotal, 2);
  assert.equal(after.deletedTotal, 1);
  assert.equal(after.deletedToday >= 0, true);
  assert.equal(after.deletionTrackingSince, now + 2000);

  const deletion = store.exportState().accountDeletions[0];
  assert.deepEqual(Object.keys(deletion).sort(), ["deletedAt", "id"]);
  assert.equal(JSON.stringify(deletion).includes(created.user.id), false);
  assert.equal(JSON.stringify(deletion).includes(created.user.publicId), false);
  assert.equal(JSON.stringify(deletion).includes(created.user.nickname), false);
});

test("用户管理接口向超管返回注册/注销总览，运营账号无权读取", async (context) => {
  const now = Date.now();
  const admins = createMemoryAdminAccountStore();
  admins.ensureBootstrapAdmin({
    username: "user-admin",
    password: "user-admin-password-1",
    mustChangePassword: false,
  });
  const users = createMemoryUserAuthStore();
  const first = users.loginWechat({ openid: "management-first" }, now - 1000);
  const second = users.loginWechat({ openid: "management-second" }, now - 500);
  const restrictions = createMemoryUserRestrictionStore();
  restrictions.apply({ userId: second.user.id, type: "mute", reason: "测试限制", durationDays: 7 }, now);

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    adminAccountStore: admins,
    userAuthStore: users,
    userRestrictionStore: restrictions,
    bootstrapAdmin: false,
  });
  const baseUrl = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal(adminPermissionForPath("/api/admin/users"), "super_admin");
  assert.equal((await call(baseUrl, "/api/admin/users")).status, 401);

  const login = await call(baseUrl, "/api/admin/auth/login", {
    method: "POST",
    body: { username: "user-admin", password: "user-admin-password-1" },
  });
  assert.equal(login.status, 200);
  const token = login.payload.token;

  const overview = await call(baseUrl, "/api/admin/users", { token });
  assert.equal(overview.status, 200);
  assert.equal(overview.payload.summary.currentUsers, 2);
  assert.equal(overview.payload.summary.registeredTotal, 2);
  assert.equal(overview.payload.summary.deletedTotal, 0);
  assert.equal(overview.payload.total, 2);
  assert.equal(overview.payload.users.length, 2);
  const restricted = overview.payload.users.find((item) => item.userId === second.user.id);
  assert.equal(restricted.restriction.restricted, true);
  assert.deepEqual(restricted.restriction.typeLabels, ["禁言"]);
  assert.ok(restricted.restriction.expiresAt > now);

  const searched = await call(baseUrl, `/api/admin/users?query=${encodeURIComponent(first.user.publicId)}`, { token });
  assert.equal(searched.status, 200);
  assert.equal(searched.payload.total, 1);
  assert.equal(searched.payload.users[0].userId, first.user.id);

  const createdOperator = await call(baseUrl, "/api/admin/accounts", {
    method: "POST",
    token,
    body: {
      username: "user-ops",
      password: "user-ops-password-1",
      displayName: "用户运营",
      role: "operator",
    },
  });
  assert.equal(createdOperator.status, 201);
  const operatorLogin = await call(baseUrl, "/api/admin/auth/login", {
    method: "POST",
    body: { username: "user-ops", password: "user-ops-password-1" },
  });
  assert.equal(operatorLogin.status, 200);
  const denied = await call(baseUrl, "/api/admin/users", { token: operatorLogin.payload.token });
  assert.equal(denied.status, 403);
  assert.equal(denied.payload.error, "admin_permission_denied");

  const deletion = await call(baseUrl, "/api/account", { method: "DELETE", token: first.token });
  assert.equal(deletion.status, 200);
  const afterDeletion = await call(baseUrl, "/api/admin/users", { token });
  assert.equal(afterDeletion.status, 200);
  assert.equal(afterDeletion.payload.summary.currentUsers, 1);
  assert.equal(afterDeletion.payload.summary.deletedTotal, 1);
  assert.equal(afterDeletion.payload.summary.registeredTotal, 2);
  assert.equal(afterDeletion.payload.users.some((item) => item.userId === first.user.id), false);
  assert.equal(users.exportState().accountDeletions.length, 1);
});
