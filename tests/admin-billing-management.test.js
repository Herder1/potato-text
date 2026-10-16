const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminAccountStore } = require("../apps/api/src/admin-account-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryBillingStore } = require("../apps/api/src/billing-store");

test("super admin finds numeric users, lists orders and settles simulated refunds", async (context) => {
  const admins = createMemoryAdminAccountStore();
  admins.ensureBootstrapAdmin({
    username: "billing-admin", password: "secret-password-1", mustChangePassword: false,
  });
  const users = createMemoryUserAuthStore();
  const billing = createMemoryBillingStore();
  const first = users.loginWechat({ openid: "billing-first" }).user;
  const second = users.loginWechat({ openid: "billing-second" }).user;
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(), adminAccountStore: admins,
    userAuthStore: users, billingStore: billing, bootstrapAdmin: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, token, body) {
    const response = await fetch(`${base}${route}`, {
      method: body ? "POST" : "GET",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await call("/api/admin/billing/users")).status, 401);
  const login = await call("/api/admin/auth/login", "", { username: "billing-admin", password: "secret-password-1" });
  assert.equal(login.status, 200);
  const token = login.data.token;
  const initial = await call("/api/admin/billing/users?pageSize=1", token);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.total, 2);
  assert.equal(initial.data.users.length, 1);
  assert.equal((await call("/api/admin/billing/users?page=2&pageSize=1", token)).data.users[0].publicId, second.publicId);
  const found = await call(`/api/admin/billing/users?query=${first.publicId}`, token);
  assert.equal(found.data.users[0].userId, first.id);
  const absent = await call("/api/admin/billing?userId=999999999", token);
  assert.equal(absent.status, 404);
  assert.equal((await call("/api/admin/billing/users/999999999/grant-product", token,
    { productId: "product-modern-chinese-2026" })).status, 404);
  assert.equal((await call("/api/admin/billing/users/999999999/grant-beans", token,
    { amount: 1, validityDays: 30 })).status, 404);
  const granted = await call(`/api/admin/billing/users/${first.publicId}/grant-product`, token,
    { productId: "product-modern-chinese-2026" });
  assert.equal(granted.status, 200);
  assert.equal(granted.data.account.userId, first.id);
  const rights = await call(`/api/admin/billing/users?query=${first.publicId}`, token);
  assert.equal(rights.data.users[0].subscriptions.length, 1);
  assert.equal(rights.data.users[0].beanBalance, 3);
  const account = await call(`/api/admin/billing?userId=${first.publicId}`, token);
  assert.equal(account.data.account.publicId, first.publicId);
  const orders = await call(`/api/admin/billing/orders?query=${first.publicId}&status=paid`, token);
  assert.equal(orders.data.total, 1);
  assert.equal(orders.data.orders[0].id, granted.data.order.id);
  assert.equal(orders.data.orders[0].nickname, first.nickname);
  const refund = await call(`/api/admin/billing/orders/${granted.data.order.id}/refund`, token,
    { mode: "revoke", reason: "test" });
  assert.equal(refund.status, 200);
  assert.equal(refund.data.clawedBackBeans, 3);
  const refunded = await call(`/api/admin/billing/orders?query=${first.publicId}&status=refunded`, token);
  assert.equal(refunded.data.total, 1);
  assert.equal(refunded.data.orders[0].entitlementRevoked, true);
  assert.equal(refunded.data.orders[0].beanRemaining, 0);
  const after = await call(`/api/admin/billing/users?query=${first.publicId}`, token);
  assert.equal(after.data.users[0].subscriptions.length, 0);
  assert.equal(after.data.users[0].beanBalance, 0);
  assert.equal((await call(`/api/admin/billing/users/${second.publicId}/grant-beans`, token,
    { amount: 1, validityDays: 30 })).status, 200);
  assert.equal((await call(`/api/admin/billing/users?query=${second.publicId}`, token)).data.users[0].beanBalance, 1);
  assert.equal((await call("/api/admin/billing/orders?query=nonexistent", token)).data.total, 0);
});
