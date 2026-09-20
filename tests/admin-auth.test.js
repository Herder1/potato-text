const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createMemoryAdminAccountStore } = require("../apps/api/src/admin-account-store");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryModerationStore } = require("../apps/api/src/moderation-store");
const { createServer, adminPermissionForPath, isInternalServiceRequest } = require("../apps/api/src/server");

const SUPER_USERNAME = "admin";
const SUPER_PASSWORD = "super-secret-1";

/**
 * 从 server.js 源码里解析出所有 /api/admin/* 路由（字面量与正则两种写法），
 * 用来做“全域覆盖”测试——不再靠人工挑几个接口抽查，新增后台路由会自动进入检查范围。
 */
function adminRoutePathsFromSource() {
  const lines = fs.readFileSync(path.resolve(__dirname, "../apps/api/src/server.js"), "utf8").split("\n");
  const paths = new Set();
  for (const line of lines) {
    if (!line.includes("url.pathname")) continue;
    for (const match of line.matchAll(/"(\/api\/admin\/[^"]*)"/g)) paths.add(match[1]);
    const regexGuard = line.match(/url\.pathname\.match\(\/\^(.+?)\$\/\)/) || line.match(/url\.pathname\.match\(\/\^(.+?)\/\)/);
    if (!regexGuard) continue;
    const concrete = regexGuard[1]
      .replace(/\\\//g, "/")
      .replace(/\(\[\^\/\]\+\)/g, "probe")
      .replace(/\$$/, "");
    if (concrete.startsWith("/api/admin/")) paths.add(concrete);
  }
  return [...paths].sort();
}

/** 闸门（鉴权块）在源码中的行号；任何后台路由守卫都不允许排在它前面。 */
function adminGateLine() {
  const lines = fs.readFileSync(path.resolve(__dirname, "../apps/api/src/server.js"), "utf8").split("\n");
  return lines.findIndex((line) => line.includes("管理后台身份与权限")) + 1;
}

async function startServer(context, options = {}) {
  const adminAccountStore = options.adminAccountStore || createMemoryAdminAccountStore();
  if (options.bootstrap !== false && !adminAccountStore.hasAccounts()) {
    adminAccountStore.ensureBootstrapAdmin({
      username: options.username || SUPER_USERNAME,
      password: options.password || SUPER_PASSWORD,
      displayName: options.displayName || "测试超管",
      // 夹具默认模拟“初始密码已轮换”的常态账号；强制改密由专门用例覆盖。
      mustChangePassword: options.mustChangePassword === true,
    });
  }
  const operationLogStore = options.operationLogStore || createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    adminAccountStore,
    operationLogStore,
    bootstrapAdmin: false,
    ...(options.serverOptions || {}),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    adminAccountStore,
    operationLogStore,
  };
}

async function call(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

/** 走真实小程序登录链路拿用户会话（开发态 code 换 openid）。 */
async function wechatLogin(baseUrl, deviceId) {
  const response = await call(baseUrl, "/api/auth/wechat/login", {
    method: "POST",
    body: { code: `code-${deviceId}`, deviceId, profile: { nickname: `同学-${deviceId}` } },
  });
  assert.equal(response.status, 200, `微信登录失败：${JSON.stringify(response.payload)}`);
  return { token: response.payload.token, userId: response.payload.user.id };
}

async function login(baseUrl, username, password) {
  return call(baseUrl, "/api/admin/auth/login", { method: "POST", body: { username, password } });
}

test("未登录时所有后台管理接口一律 401，不泄露任何后台数据", async (context) => {
  const runtime = await startServer(context);
  const probes = [
    ["/api/admin/overview", {}],
    ["/api/admin/ai-config", {}],
    ["/api/admin/accounts", {}],
    ["/api/admin/operation-logs", {}],
    ["/api/admin/questions?library=official", {}],
    ["/api/admin/questions/batch-delete", { method: "POST", body: { ids: ["q1"] } }],
    ["/api/admin/ai/providers", { method: "POST", body: { name: "x" } }],
  ];
  for (const [path, options] of probes) {
    const response = await call(runtime.baseUrl, path, options);
    assert.equal(response.status, 401, `${options.method || "GET"} ${path} 必须要求登录`);
    assert.equal(response.payload.error, "admin_session_invalid");
    assert.equal("items" in response.payload, false);
    assert.equal("config" in response.payload, false);
  }
  // 伪造的 token 同样无效
  const forged = await call(runtime.baseUrl, "/api/admin/overview", { token: "not-a-real-token" });
  assert.equal(forged.status, 401);
});

test("登录后可以访问管理接口，操作日志记录真实操作人", async (context) => {
  const runtime = await startServer(context);
  const session = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  assert.equal(session.status, 200);
  assert.equal(session.payload.account.username, SUPER_USERNAME);
  assert.equal(session.payload.account.role, "super_admin");
  assert.ok(session.payload.token);
  assert.ok(session.payload.expiresAt > Date.now());

  const overview = await call(runtime.baseUrl, "/api/admin/overview", { token: session.payload.token });
  assert.equal(overview.status, 200);

  const me = await call(runtime.baseUrl, "/api/admin/auth/me", { token: session.payload.token });
  assert.equal(me.status, 200);
  assert.equal(me.payload.account.username, SUPER_USERNAME);

  const logs = runtime.operationLogStore.list({ category: "admin_account" });
  assert.equal(logs.items.some((item) => item.action === "admin_account.login"), false, "登录不写业务操作日志");

  // 真实操作人：登录后做一次业务动作，日志必须记在登录账号名下，而不是写死的“超级管理员”
  const created = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: session.payload.token,
    body: { username: "logprobe", password: "log-probe-password", displayName: "日志探针", role: "operator" },
  });
  assert.equal(created.status, 201);
  const businessLogs = runtime.operationLogStore.list({ category: "admin_account" });
  assert.ok(businessLogs.items.some((item) => item.action === "admin_account.create"
    && item.actor === "测试超管"
    && item.actorRole === "超级管理员"), "后台动作必须记录真实操作人");

  const logout = await call(runtime.baseUrl, "/api/admin/auth/logout", { method: "POST", token: session.payload.token, body: {} });
  assert.equal(logout.status, 200);
  const afterLogout = await call(runtime.baseUrl, "/api/admin/overview", { token: session.payload.token });
  assert.equal(afterLogout.status, 401, "退出登录后旧 token 必须立即失效");
});

test("密码错误、账号停用、弱凭据都会被拒绝", async (context) => {
  const runtime = await startServer(context);
  const wrong = await login(runtime.baseUrl, SUPER_USERNAME, "wrong-password");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.payload.error, "admin_credentials_invalid");

  const unknown = await login(runtime.baseUrl, "nobody", "whatever-123");
  assert.equal(unknown.status, 401);

  const loggedIn = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  const created = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: loggedIn.payload.token,
    body: { username: "ops1", password: "ops-password-1", displayName: "运营一号", role: "operator" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.account.role, "operator");

  await call(runtime.baseUrl, `/api/admin/accounts/${created.payload.account.id}/status`, {
    method: "POST",
    token: loggedIn.payload.token,
    body: { status: "disabled" },
  });
  const disabled = await login(runtime.baseUrl, "ops1", "ops-password-1");
  assert.equal(disabled.status, 403);
  assert.equal(disabled.payload.error, "admin_account_disabled");
});

test("运营操作员可以处理业务，但不能管理后台账号（403）", async (context) => {
  const runtime = await startServer(context);
  const superSession = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: superSession.payload.token,
    body: { username: "ops2", password: "ops-password-2", displayName: "运营二号", role: "operator" },
  });

  const operator = await login(runtime.baseUrl, "ops2", "ops-password-2");
  assert.equal(operator.status, 200);
  const token = operator.payload.token;

  const overview = await call(runtime.baseUrl, "/api/admin/overview", { token });
  assert.equal(overview.status, 200, "运营操作员仍可处理日常业务");

  const listing = await call(runtime.baseUrl, "/api/admin/accounts", { token });
  assert.equal(listing.status, 403);
  assert.equal(listing.payload.error, "admin_permission_denied");

  const create = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token,
    body: { username: "ops3", password: "ops-password-3", role: "operator" },
  });
  assert.equal(create.status, 403);

  const accounts = await call(runtime.baseUrl, "/api/admin/accounts", { token: superSession.payload.token });
  assert.equal(accounts.status, 200);
  assert.equal(accounts.payload.items.length, 2);
});

test("停用账号会立即撤销其全部会话", async (context) => {
  const runtime = await startServer(context);
  const superSession = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  const created = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: superSession.payload.token,
    body: { username: "ops4", password: "ops-password-4", role: "operator" },
  });
  const operator = await login(runtime.baseUrl, "ops4", "ops-password-4");
  assert.equal((await call(runtime.baseUrl, "/api/admin/overview", { token: operator.payload.token })).status, 200);

  const disabled = await call(runtime.baseUrl, `/api/admin/accounts/${created.payload.account.id}/status`, {
    method: "POST",
    token: superSession.payload.token,
    body: { status: "disabled" },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.payload.account.activeSessionCount, 0);

  const revoked = await call(runtime.baseUrl, "/api/admin/overview", { token: operator.payload.token });
  assert.equal(revoked.status, 401, "停用后旧会话必须立刻失效");

  const reEnabled = await call(runtime.baseUrl, `/api/admin/accounts/${created.payload.account.id}/status`, {
    method: "POST",
    token: superSession.payload.token,
    body: { status: "active" },
  });
  assert.equal(reEnabled.status, 200);
  assert.equal((await call(runtime.baseUrl, "/api/admin/overview", { token: operator.payload.token })).status, 401, "重新启用不会复活被撤销的会话");
  assert.equal((await login(runtime.baseUrl, "ops4", "ops-password-4")).status, 200);
});

test("重置密码会撤销会话，且只认新密码", async (context) => {
  const runtime = await startServer(context);
  const superSession = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  const created = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: superSession.payload.token,
    body: { username: "ops5", password: "ops-password-5", role: "operator" },
  });
  const operator = await login(runtime.baseUrl, "ops5", "ops-password-5");

  const reset = await call(runtime.baseUrl, `/api/admin/accounts/${created.payload.account.id}/password`, {
    method: "POST",
    token: superSession.payload.token,
    body: {},
  });
  assert.equal(reset.status, 200);
  assert.match(reset.payload.generatedPassword, /^[A-Za-z0-9_-]{16,}$/);
  assert.equal((await call(runtime.baseUrl, "/api/admin/overview", { token: operator.payload.token })).status, 401);
  assert.equal((await login(runtime.baseUrl, "ops5", "ops-password-5")).status, 401);
  assert.equal((await login(runtime.baseUrl, "ops5", reset.payload.generatedPassword)).status, 200);
});

test("修改自己的密码会撤销会话，并要求新密码重新登录", async (context) => {
  const runtime = await startServer(context);
  const session = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  const wrongCurrent = await call(runtime.baseUrl, "/api/admin/auth/password", {
    method: "POST",
    token: session.payload.token,
    body: { currentPassword: "nope", newPassword: "brand-new-secret" },
  });
  assert.equal(wrongCurrent.status, 422);
  assert.equal(wrongCurrent.payload.error, "admin_current_password_invalid");

  const changed = await call(runtime.baseUrl, "/api/admin/auth/password", {
    method: "POST",
    token: session.payload.token,
    body: { currentPassword: SUPER_PASSWORD, newPassword: "brand-new-secret" },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.payload.reloginRequired, true);
  assert.equal((await call(runtime.baseUrl, "/api/admin/overview", { token: session.payload.token })).status, 401);
  assert.equal((await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD)).status, 401);
  const relogin = await login(runtime.baseUrl, SUPER_USERNAME, "brand-new-secret");
  assert.equal(relogin.status, 200);
  assert.equal(relogin.payload.account.mustChangePassword, false);
});

test("环境变量只用于首次建号，不能作为免登录后门", async (context) => {
  const previous = process.env.ADMIN_INIT_PASSWORD;
  process.env.ADMIN_INIT_PASSWORD = "env-side-password";
  process.env.ADMIN_INIT_USERNAME = "envadmin";
  context.after(() => {
    if (previous === undefined) delete process.env.ADMIN_INIT_PASSWORD;
    else process.env.ADMIN_INIT_PASSWORD = previous;
    delete process.env.ADMIN_INIT_USERNAME;
  });

  const store = createMemoryAdminAccountStore();
  store.ensureBootstrapAdmin({ username: SUPER_USERNAME, password: SUPER_PASSWORD, displayName: "测试超管" });
  const runtime = await startServer(context, { adminAccountStore: store, bootstrap: false });

  // 设置了环境变量也不能免 token 访问后台
  const anonymous = await call(runtime.baseUrl, "/api/admin/overview");
  assert.equal(anonymous.status, 401);
  // 环境变量里的账号/密码不会变成可登录账号
  assert.equal((await login(runtime.baseUrl, "envadmin", "env-side-password")).status, 401);
  assert.equal(store.list({}).summary.total, 1, "已有账号时不会再用环境变量建号");
});

test("部署初始化只建一次首个超级管理员，生成的初始密码不落明文", () => {
  const store = createMemoryAdminAccountStore();
  const first = store.ensureBootstrapAdmin({ username: "root" });
  assert.equal(first.created, true);
  assert.equal(first.account.role, "super_admin");
  assert.equal(first.account.mustChangePassword, true);
  assert.ok(first.generatedPassword.length >= 16);

  const second = store.ensureBootstrapAdmin({ username: "another" });
  assert.equal(second.created, false);
  assert.equal(store.list({}).summary.total, 1);

  const dumped = JSON.stringify(store.exportState());
  assert.equal(dumped.includes(first.generatedPassword), false, "密码不能以明文出现在存储状态里");
  assert.equal(dumped.includes("passwordHash"), true);
  assert.equal(store.list({}).items[0].passwordHash, undefined, "对外投影不能带出密码哈希");

  assert.equal(store.login({ username: "root", password: first.generatedPassword }).account.username, "root");
});

test("账号校验：用户名规则、重复账号、至少保留一个超级管理员、不能停用自己", () => {
  const store = createMemoryAdminAccountStore();
  store.ensureBootstrapAdmin({ username: SUPER_USERNAME, password: SUPER_PASSWORD, displayName: "测试超管" });

  assert.throws(() => store.create({ username: "A!", password: "long-enough-1" }), /admin_username_invalid/);
  assert.throws(() => store.create({ username: "ops6", password: "short" }), /admin_password_too_short/);
  assert.throws(() => store.create({ username: SUPER_USERNAME, password: "long-enough-1" }), /admin_username_taken/);
  assert.throws(() => store.create({ username: "ops6", password: "long-enough-1", role: "god" }), /admin_role_invalid/);

  const operator = store.create({ username: "ops6", password: "long-enough-1", role: "operator" }, SUPER_USERNAME);
  assert.equal(operator.account.createdBy, SUPER_USERNAME);
  assert.equal(operator.generatedPassword, "", "显式传密码时不返回自动生成密码");

  const superAdmin = store.list({ role: "super_admin" }).items[0];
  assert.throws(() => store.setStatus(superAdmin.id, "disabled", "someone"), /admin_last_super_admin/);
  assert.throws(() => store.setStatus(superAdmin.id, "disabled", SUPER_USERNAME), /admin_cannot_disable_self/);

  const second = store.create({ username: "ops7", password: "long-enough-1", role: "super_admin" }, SUPER_USERNAME);
  assert.equal(store.setStatus(superAdmin.id, "disabled", "ops7").status, "disabled", "有两个超管时可以停用其中一个");
  assert.throws(() => store.setStatus(second.account.id, "disabled", "other-admin"), /admin_last_super_admin/, "最后一个启用中的超管不能被停用");
  assert.equal(store.list({}).summary.superAdmins, 1);
});

test("初始化凭据不合法时后台保持锁定，绝不降级成免鉴权", async (context) => {
  const previousUser = process.env.ADMIN_INIT_USERNAME;
  const previousPassword = process.env.ADMIN_INIT_PASSWORD;
  process.env.ADMIN_INIT_USERNAME = "root";
  process.env.ADMIN_INIT_PASSWORD = "short";
  context.after(() => {
    if (previousUser === undefined) delete process.env.ADMIN_INIT_USERNAME;
    else process.env.ADMIN_INIT_USERNAME = previousUser;
    if (previousPassword === undefined) delete process.env.ADMIN_INIT_PASSWORD;
    else process.env.ADMIN_INIT_PASSWORD = previousPassword;
  });

  const adminAccountStore = createMemoryAdminAccountStore();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), adminAccountStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  assert.equal(adminAccountStore.list({}).summary.total, 0, "凭据不合法时不建号");
  assert.equal((await call(baseUrl, "/api/admin/overview")).status, 401, "没有账号时必须保持锁定，而不是放开");
  assert.equal((await login(baseUrl, "root", "short")).status, 401);
});

test("全域覆盖：源码里每一条 /api/admin/* 路由都必须先鉴权（不再抽样）", async (context) => {
  const routes = adminRoutePathsFromSource();
  assert.ok(routes.length >= 25, `解析到的后台路由过少（${routes.length}），解析逻辑可能失效`);
  assert.ok(
    routes.includes("/api/admin/community/assets/probe/action"),
    `正则写法注册的后台路由必须被解析到，当前解析结果：${routes.join(", ")}`,
  );
  const runtime = await startServer(context);
  const failures = [];
  for (const route of routes) {
    // /api/admin/auth/login 是唯一公开入口（登录本身），它没有会话也必须可调用。
    if (route === "/api/admin/auth/login") continue;
    for (const method of ["GET", "POST"]) {
      const response = await call(runtime.baseUrl, route, { method, body: method === "POST" ? {} : undefined });
      if (response.status !== 401) failures.push(`${method} ${route} → ${response.status}`);
    }
  }
  assert.deepEqual(failures, [], `以下后台路由没有先过鉴权：\n${failures.join("\n")}`);
});

test("鉴权闸门必须排在所有后台路由之前（防止再出现社区审核绕过）", () => {
  const gateLine = adminGateLine();
  assert.ok(gateLine > 0, "源码里找不到鉴权闸门");
  const lines = fs.readFileSync(path.resolve(__dirname, "../apps/api/src/server.js"), "utf8").split("\n");
  const offenders = [];
  lines.forEach((line, index) => {
    if (index + 1 >= gateLine) return;
    const mentionsAdmin = line.includes("/api/admin/") || line.includes("\\/api\\/admin\\/");
    if (mentionsAdmin && /url\.pathname|request\.method/.test(line)) {
      offenders.push(`L${index + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
  assert.deepEqual(offenders, [], `这些后台路由排在鉴权之前：\n${offenders.join("\n")}`);
});

test("运营操作员：业务可做，密钥 / 收费 / 账号连读都拦", async (context) => {
  const runtime = await startServer(context);
  const superSession = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  const created = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: superSession.payload.token,
    body: { username: "ops9", password: "ops-password-9", displayName: "运营九号", role: "operator" },
  });
  assert.equal(created.status, 201);
  const operator = await login(runtime.baseUrl, "ops9", "ops-password-9");
  const token = operator.payload.token;

  for (const path of ["/api/admin/overview", "/api/admin/questions?library=official", "/api/admin/moderation", "/api/admin/exams", "/api/admin/operation-logs"]) {
    assert.equal((await call(runtime.baseUrl, path, { token })).status, 200, `运营应当能访问 ${path}`);
  }

  const sensitive = [
    ["/api/admin/ai-config", "GET"],
    ["/api/admin/ai/providers", "POST"],
    ["/api/admin/ai/models", "POST"],
    ["/api/admin/ai/test", "POST"],
    ["/api/admin/ai/routes/subjective_scoring", "POST"],
    ["/api/admin/ai/prompts/semantic_dedup", "POST"],
    ["/api/admin/billing", "GET"],
    ["/api/admin/billing/products", "POST"],
    ["/api/admin/accounts", "GET"],
    ["/api/admin/accounts", "POST"],
  ];
  for (const [path, method] of sensitive) {
    const response = await call(runtime.baseUrl, path, { method, token, body: method === "POST" ? {} : undefined });
    assert.equal(response.status, 403, `${method} ${path} 应当只允许超级管理员`);
    assert.equal(response.payload.error, "admin_permission_denied", `${method} ${path} 应当返回权限错误`);
  }
});

test("社区接口身份来自会话：匿名不可用、不能冒用或操作他人内容", async (context) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  context.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const runtime = await startServer(context);
  const assetBody = {
    type: "note",
    title: "A 的笔记",
    content: "整理词类、短语与句法成分的判断依据，并给出复习顺序与常见易错点说明。",
    subjectId: "modern-chinese",
    chapterId: "grammar",
    originality: "original",
  };

  assert.equal((await call(runtime.baseUrl, "/api/community/assets/mine")).status, 401);
  assert.equal((await call(runtime.baseUrl, "/api/community/assets/mine?userId=someone-else")).status, 401);
  assert.equal((await call(runtime.baseUrl, "/api/community/assets", { method: "POST", body: { ...assetBody, id: "anon" } })).status, 401);

  const userA = await wechatLogin(runtime.baseUrl, "device-a");
  const submitted = await call(runtime.baseUrl, "/api/community/assets", {
    method: "POST",
    token: userA.token,
    body: { ...assetBody, id: "asset-a", userId: "spoofed-user-id" },
  });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.payload.asset.userId, userA.userId, "归属必须来自会话，而不是请求里声明的 userId");

  const userB = await wechatLogin(runtime.baseUrl, "device-b");
  const mineB = await call(runtime.baseUrl, "/api/community/assets/mine", { token: userB.token });
  assert.equal(mineB.status, 200);
  assert.equal(mineB.payload.assets.some((item) => item.id === submitted.payload.asset.id), false, "不能看到别人的未发布内容");
  const spoofed = await call(runtime.baseUrl, `/api/community/assets/mine?userId=${encodeURIComponent(userA.userId)}`, { token: userB.token });
  assert.equal(spoofed.payload.assets.some((item) => item.id === submitted.payload.asset.id), false, "URL 上声明他人 userId 不再被采信");

  const crossWithdraw = await call(runtime.baseUrl, `/api/community/assets/${submitted.payload.asset.id}/withdraw`, {
    method: "POST",
    token: userB.token,
    body: { userId: userA.userId },
  });
  assert.equal(crossWithdraw.status, 403);
  assert.equal(crossWithdraw.payload.error, "community_asset_not_owned");

  const ownWithdraw = await call(runtime.baseUrl, `/api/community/assets/${submitted.payload.asset.id}/withdraw`, {
    method: "POST",
    token: userA.token,
    body: {},
  });
  assert.equal(ownWithdraw.status, 200);
});

test("正式环境关闭匿名 test-user 兜底通道", async (context) => {
  const previous = process.env.NODE_ENV;
  context.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const runtime = await startServer(context);

  process.env.NODE_ENV = "development";
  assert.equal((await call(runtime.baseUrl, "/api/billing/account")).status, 200, "开发态保留 test-user 联调便利");
  assert.equal((await call(runtime.baseUrl, "/api/community/assets/mine?userId=someone")).status, 401, "社区接口在任何环境都要求登录");

  process.env.NODE_ENV = "production";
  assert.equal((await call(runtime.baseUrl, "/api/billing/account")).status, 401);
  assert.equal((await call(runtime.baseUrl, "/api/billing/account?userId=test-user")).status, 401, "URL 上声明 test-user 也不能绕过");
  assert.equal((await call(runtime.baseUrl, "/api/billing/credits/consume", { method: "POST", body: { amount: 1, reason: "test" } })).status, 401);
  assert.equal((await call(runtime.baseUrl, "/api/exam-exports", { method: "POST", body: { examId: "x", userId: "test-user" } })).status, 401);
});

test("初始密码未改：服务端只放行改密相关接口", async (context) => {
  const runtime = await startServer(context, { mustChangePassword: true });
  const session = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  assert.equal(session.payload.account.mustChangePassword, true);

  const blocked = await call(runtime.baseUrl, "/api/admin/overview", { token: session.payload.token });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.payload.error, "admin_password_change_required");
  assert.equal((await call(runtime.baseUrl, "/api/admin/accounts", { token: session.payload.token })).status, 403);
  assert.equal((await call(runtime.baseUrl, "/api/admin/auth/me", { token: session.payload.token })).status, 200);

  const changed = await call(runtime.baseUrl, "/api/admin/auth/password", {
    method: "POST",
    token: session.payload.token,
    body: { currentPassword: SUPER_PASSWORD, newPassword: "rotated-secret-9" },
  });
  assert.equal(changed.status, 200);
  const relogin = await login(runtime.baseUrl, SUPER_USERNAME, "rotated-secret-9");
  assert.equal(relogin.payload.account.mustChangePassword, false);
  assert.equal((await call(runtime.baseUrl, "/api/admin/overview", { token: relogin.payload.token })).status, 200, "改密后恢复业务访问");
});

test("操作日志落稳定账号 ID，且不再写死操作人", async (context) => {
  const moderationStore = createMemoryModerationStore([]);
  const runtime = await startServer(context, { serverOptions: { moderationStore } });
  const superSession = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  const created = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: superSession.payload.token,
    body: { username: "ops10", password: "ops-password-10", displayName: "运营十号", role: "operator" },
  });
  assert.equal(created.status, 201);

  const createEntry = runtime.operationLogStore.list({ category: "admin_account" }).items
    .find((item) => item.action === "admin_account.create");
  assert.equal(createEntry.actorId, superSession.payload.account.id, "日志必须落稳定账号 ID");
  assert.equal(createEntry.actor, "测试超管");

  // 运营操作员的真实身份同样要能追溯（这条链路以前会被写死成“超级管理员”）
  const operator = await login(runtime.baseUrl, "ops10", "ops-password-10");
  const report = moderationStore.create({
    type: "spam",
    risk: "low",
    targetType: "pack",
    targetId: "pack-x",
    targetTitle: "测试题包",
    reporter: { id: "u1", nickname: "同学" },
    reportedUser: { id: "u2", nickname: "发布者" },
    reason: "测试",
  });
  const acted = await call(runtime.baseUrl, `/api/admin/moderation/${report.id}/action`, {
    method: "POST",
    token: operator.payload.token,
    body: { action: "take", note: "开始核查" },
  });
  assert.equal(acted.status, 200);
  const moderationEntry = runtime.operationLogStore.list({ category: "moderation" }).items[0];
  assert.equal(moderationEntry.actor, "运营十号");
  assert.equal(moderationEntry.actorRole, "运营操作员");
  assert.equal(moderationEntry.actorId, operator.payload.account.id);

  // 源码层面禁止再出现写死的操作人（键名与位置参数两种写法都要清）
  const source = fs.readFileSync(path.resolve(__dirname, "../apps/api/src/server.js"), "utf8");
  assert.equal(/actor:\s*"超级管理员"/.test(source), false, "不允许再写死 actor");
  assert.equal(/[,(]\s*"超级管理员"/.test(source), false, "不允许再用写死的操作人做位置参数");
});

test("每一条后台路由都必须被显式分类：未知接口默认只给超级管理员", async (context) => {
  // 裸前缀 "/api/admin/" 来自闸门自身的 startsWith 判断，不是路由；其余每条都必须是登记过的分类。
  const routes = adminRoutePathsFromSource().filter((route) => route !== "/api/admin/");
  const unclassified = routes.filter((route) => adminPermissionForPath(route) === "unclassified");
  assert.deepEqual(unclassified, [], `这些后台路由没有登记权限分类（新增接口必须显式加入运营白名单或超管清单）：\n${unclassified.join("\n")}`);
  assert.ok(routes.length >= 25, `解析到的后台路由过少（${routes.length}），解析逻辑可能失效`);

  // 敏感面仍然是超管专属，业务面才是运营可用
  assert.equal(adminPermissionForPath("/api/admin/billing/products"), "super_admin");
  assert.equal(adminPermissionForPath("/api/admin/ai/providers"), "super_admin");
  assert.equal(adminPermissionForPath("/api/admin/accounts"), "super_admin");
  assert.equal(adminPermissionForPath("/api/admin/questions/batch-delete"), "admin");
  assert.equal(adminPermissionForPath("/api/admin/moderation/x/action"), "admin");
  // 关键回归："/api/admin/ai/" 不能把 "/api/admin/ai-tasks" 误判成超管专属以外的行为
  assert.equal(adminPermissionForPath("/api/admin/ai-tasks"), "admin");
  assert.equal(adminPermissionForPath("/api/admin/ai-config"), "super_admin");

  // 未登记的路径：函数判为 unclassified，接口层对运营 403（不是 404，说明先过鉴权）、对超管 404
  assert.equal(adminPermissionForPath("/api/admin/brand-new-feature"), "unclassified");
  const runtime = await startServer(context);
  const superSession = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  const created = await call(runtime.baseUrl, "/api/admin/accounts", {
    method: "POST",
    token: superSession.payload.token,
    body: { username: "ops11", password: "ops-password-11", displayName: "运营十一", role: "operator" },
  });
  assert.equal(created.status, 201);
  const operator = await login(runtime.baseUrl, "ops11", "ops-password-11");
  const operatorOnUnknown = await call(runtime.baseUrl, "/api/admin/brand-new-feature", { token: operator.payload.token });
  assert.equal(operatorOnUnknown.status, 403);
  assert.equal(operatorOnUnknown.payload.error, "admin_permission_denied");
  assert.equal((await call(runtime.baseUrl, "/api/admin/brand-new-feature", { token: superSession.payload.token })).status, 404);
});

test("内部导入是独立授权：凭证、本机来源、路径三者缺一不可", async (context) => {
  const token = "internal-token-for-test";
  assert.equal(isInternalServiceRequest({ headerValue: token, remoteAddress: "127.0.0.1", pathname: "/api/admin/exams/import-files" }, token), true);
  assert.equal(isInternalServiceRequest({ headerValue: token, remoteAddress: "::ffff:127.0.0.1", pathname: "/api/admin/exams/import-jobs" }, token), true);
  assert.equal(isInternalServiceRequest({ headerValue: "wrong", remoteAddress: "127.0.0.1", pathname: "/api/admin/exams/import-files" }, token), false);
  assert.equal(isInternalServiceRequest({ headerValue: token, remoteAddress: "192.168.1.50", pathname: "/api/admin/exams/import-files" }, token), false);
  assert.equal(isInternalServiceRequest({ headerValue: token, remoteAddress: "127.0.0.1", pathname: "/api/admin/accounts" }, token), false);
  assert.equal(isInternalServiceRequest({ headerValue: token, remoteAddress: "127.0.0.1", pathname: "/api/admin/exams" }, token), false, "必须落在 /api/admin/exams/ 下");

  // 伪造内部头不能放行（真实凭证是进程内随机值，外部不可知）
  const runtime = await startServer(context);
  const forged = await call(runtime.baseUrl, "/api/admin/exams/import-files", {
    method: "POST",
    headers: { "x-shukao-internal-service": "forged-value" },
    body: {},
  });
  assert.equal(forged.status, 401);

  // 真实链路：试卷导入后台任务会由服务端自己调用该内部接口（见 tests/exam-paper-import.test.js 的导入作业用例），
  // 那些用例在当前版本全量通过，即为“内部导入独立授权可正常工作”的集成证据。
});

test("连续登录失败会被短时锁定，成功登录后计数清零", async (context) => {
  const runtime = await startServer(context);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal((await login(runtime.baseUrl, SUPER_USERNAME, "bad-password")).status, 401);
  }
  const locked = await login(runtime.baseUrl, SUPER_USERNAME, "bad-password");
  assert.equal(locked.status, 429);
  assert.equal(locked.payload.error, "admin_login_locked");
  assert.equal((await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD)).status, 429, "锁定期间即使密码正确也拒绝");

  const store = runtime.adminAccountStore;
  const account = store.list({}).items[0];
  store.resetPassword(account.id, SUPER_PASSWORD, SUPER_USERNAME);
  const recovered = await login(runtime.baseUrl, SUPER_USERNAME, SUPER_PASSWORD);
  assert.equal(recovered.status, 200);
  assert.equal(store.list({}).items[0].lastLoginAt > 0, true);
});
