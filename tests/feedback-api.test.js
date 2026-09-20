const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryModerationStore } = require("../apps/api/src/moderation-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");

test("signed-in users submit feedback and can follow its resolution", async (context) => {
  const moderationStore = createMemoryModerationStore([]);
  const userAuthStore = createMemoryUserAuthStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    moderationStore,
    userAuthStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const anonymous = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "feature_issue", content: "按钮没有反应" }),
  });
  assert.equal(anonymous.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/wechat/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "feedback-user", deviceId: "feedback-device", profile: { nickname: "反馈同学" } }),
  }).then((response) => response.json());

  const createdResponse = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({
      category: "feature_issue",
      content: "进入帮助页面后，提交按钮偶尔没有反应。",
      contact: "feedback-contact",
      attachments: ["data:image/png;base64,aGVsbG8="],
      clientContext: { pagePath: "pages/help-feedback/help-feedback", model: "test-phone" },
    }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.item.targetType, "app_feedback");
  assert.equal(created.item.attachments.length, 1);
  assert.equal(created.item.reporter.id, login.user.id);

  const mineBefore = await fetch(`${baseUrl}/api/feedback/mine`, {
    headers: { Authorization: `Bearer ${login.token}` },
  }).then((response) => response.json());
  assert.equal(mineBefore.items.length, 1);
  assert.equal(mineBefore.items[0].status, "pending");

  await fetch(`${baseUrl}/api/admin/moderation/${encodeURIComponent(created.item.id)}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resolve", note: "已修复按钮重复点击时的状态问题" }),
  });
  const mineAfter = await fetch(`${baseUrl}/api/feedback/mine`, {
    headers: { Authorization: `Bearer ${login.token}` },
  }).then((response) => response.json());
  assert.equal(mineAfter.items[0].status, "resolved");
  assert.equal(mineAfter.items[0].resolution, "反馈已处理");
  assert.equal(mineAfter.items[0].response, "已修复按钮重复点击时的状态问题");
});

test("feedback rejects invalid categories and short descriptions", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), userAuthStore: createMemoryUserAuthStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/wechat/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "invalid-feedback", deviceId: "invalid-feedback-device" }),
  }).then((response) => response.json());
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` };

  const invalidCategory = await fetch(`${baseUrl}/api/feedback`, { method: "POST", headers, body: JSON.stringify({ category: "unknown", content: "足够长的反馈内容" }) });
  assert.equal(invalidCategory.status, 422);
  const shortContent = await fetch(`${baseUrl}/api/feedback`, { method: "POST", headers, body: JSON.stringify({ category: "other", content: "短" }) });
  assert.equal(shortContent.status, 422);
});
