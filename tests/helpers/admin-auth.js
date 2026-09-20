// 测试用后台身份助手：
// 1) 为每个测试服务器注入一个内存版管理员账号存储，并用固定凭据建好首个超级管理员；
// 2) 包装 globalThis.fetch，在访问 /api/admin/* 时先真实登录一次再带上 Authorization。
// 这里没有任何服务端旁路——走的就是后台真实登录链路，所以测试同时也在验证鉴权本身。
const realServer = require("../../apps/api/src/server");
const { createMemoryAdminAccountStore } = require("../../apps/api/src/admin-account-store");

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin-test-password";
const ADMIN_DISPLAY_NAME = "测试超管";

const nativeFetch = globalThis.fetch;
const tokens = new Map();

async function loginToken(origin) {
  const response = await nativeFetch(`${origin}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) throw new Error(`admin_test_login_failed:${payload.error || response.status}`);
  return payload.token;
}

function ensureToken(origin) {
  if (!tokens.has(origin)) {
    const pending = loginToken(origin).catch((error) => {
      tokens.delete(origin);
      throw error;
    });
    tokens.set(origin, pending);
  }
  return tokens.get(origin);
}

globalThis.fetch = async function adminAwareFetch(input, init = {}) {
  const target = typeof input === "string" ? input : (input && input.url) || String(input);
  let parsed;
  try {
    parsed = new URL(target);
  } catch (error) {
    return nativeFetch(input, init);
  }
  if (!parsed.pathname.startsWith("/api/admin/") || parsed.pathname === "/api/admin/auth/login") {
    return nativeFetch(input, init);
  }
  const token = await ensureToken(parsed.origin);
  const headers = new Headers((init && init.headers) || (input && input.headers) || {});
  headers.set("Authorization", `Bearer ${token}`);
  return nativeFetch(input, { ...init, headers });
};

function createServer(options = {}) {
  const adminAccountStore = options.adminAccountStore || createMemoryAdminAccountStore();
  adminAccountStore.ensureBootstrapAdmin({
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    displayName: ADMIN_DISPLAY_NAME,
    // 测试夹具模拟“初始密码已轮换过”的常态账号，否则会被强制改密拦住业务接口；
    // 强制改密本身由 tests/admin-auth.test.js 单独覆盖。
    mustChangePassword: false,
  });
  return realServer.createServer({ ...options, adminAccountStore, bootstrapAdmin: false });
}

module.exports = {
  ...realServer,
  ADMIN_DISPLAY_NAME,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  createServer,
  ensureToken,
};
