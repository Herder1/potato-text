const test = require("node:test");
const assert = require("node:assert/strict");
const { feedbackMessages } = require("../apps/api/src/feedback-messages");
const { createMemoryModerationStore } = require("../apps/api/src/moderation-store");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");

test("feedback messages derive stable transitions, not duplicate takes, and omit private moderation fields", () => {
  const report = {
    id: "r1", targetType: "app_feedback", reporter: { id: "alice" }, detail: "按钮没有反应",
    contact: "secret-contact", attachments: ["private-image"], handler: "private-admin",
    history: [
      { action: "resolve", createdAt: 30, note: "已经修复", actor: "private-admin" },
      { action: "take", createdAt: 20, note: "internal-note" },
      { action: "take", createdAt: 10, note: "internal-note" },
    ],
  };
  const messages = feedbackMessages([report], "alice");
  assert.deepEqual(messages.map((m) => m.id), ["feedback:r1:resolve:30", "feedback:r1:take:10"]);
  assert.equal(messages[0].summary, "已经修复");
  assert.equal(messages[1].title, "反馈已领取");
  assert.equal(messages[0].feedbackId, "r1");
  assert.doesNotMatch(JSON.stringify(messages), /private-|secret-|internal-note/);
  assert.deepEqual(feedbackMessages([report], "bob"), []);
  assert.deepEqual(feedbackMessages([{ ...report, targetType: "comment" }], "alice"), []);
  assert.deepEqual(feedbackMessages([{ ...report, reporter: { id: "anonymous" } }], "anonymous"), []);
  assert.deepEqual(feedbackMessages([report], ""), []);
  assert.deepEqual(feedbackMessages([JSON.parse(JSON.stringify(report))], "alice"), messages);
});

test("feedback messages handle legacy notes, direct completion and rejection", () => {
  const store = createMemoryModerationStore([]);
  const report = store.create({ targetType: "app_feedback", targetId: "f", reason: "question", reporter: { id: "alice" } });
  store.action(report.id, "resolve");
  assert.equal(store.get(report.id).history[0].note, "反馈已处理");
  assert.equal(feedbackMessages(store.list().reports, "alice")[0].summary, "反馈已处理");
  store.action(report.id, "reject", "admin", "   ");
  assert.equal(store.get(report.id).history[0].note, "当前暂不处理");
  const legacy = { ...store.get(report.id), history: [{ action: "resolve", createdAt: 1, note: "核实后保留内容" }] };
  assert.equal(feedbackMessages([legacy], "alice")[0].summary, "反馈已处理");
});

test("feedback notifications disappear with account anonymization or report expiry", () => {
  const store = createMemoryModerationStore([]);
  for (const user of ["alice", "bob"]) {
    const report = store.create({ targetType: "app_feedback", targetId: user, reason: "question", reporter: { id: user } });
    store.action(report.id, "resolve");
  }
  store.anonymizeUser("alice");
  assert.deepEqual(feedbackMessages(store.list().reports, "alice"), []);
  assert.equal(feedbackMessages(store.list().reports, "bob").length, 1);
  store.sweepExpired(Date.now() + 31 * 86400000);
  assert.deepEqual(feedbackMessages(store.list().reports, "bob"), []);
});

test("authenticated message API follows real feedback take/resolve actions and never accepts another owner", async (t) => {
  const moderationStore = createMemoryModerationStore([]);
  const server = createServer({ moderationStore, userAuthStore: createMemoryUserAuthStore(), aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, token = "") => fetch(base + url, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const login = async (code) => (await post("/api/auth/wechat/login", { code, deviceId: code })).json();
  const alice = await login("message-alice");
  const bob = await login("message-bob");
  const get = (token, query = "") => fetch(base + "/api/messages" + query, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await get("invalid")).status, 401);
  const created = await (await post("/api/feedback", { category: "content_issue", content: "请核实这个题目的答案" }, alice.token)).json();
  assert.deepEqual((await (await get(alice.token)).json()).messages, []);
  const action = async (action, note) => {
    assert.equal((await post(`/api/admin/moderation/${created.item.id}/action`, { action, note })).status, 200);
  };
  await action("take");
  const taken = (await (await get(alice.token)).json()).messages;
  assert.equal(taken.length, 1);
  await action("take");
  assert.deepEqual((await (await get(alice.token)).json()).messages, taken);
  await action("resolve", "已核对教材并修正");
  const response = await get(alice.token);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const messages = (await response.json()).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].title, "反馈已处理");
  assert.equal(messages[0].summary, "已核对教材并修正");
  assert.deepEqual((await (await get(bob.token, `?userId=${alice.user.id}`)).json()).messages, []);
});

test("feedback conversation supports admin follow-up, owner reply, filters, idempotency and closed read-only state", async (t) => {
  const moderationStore = createMemoryModerationStore([]);
  const server = createServer({ moderationStore, userAuthStore: createMemoryUserAuthStore(), aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (code) => (await fetch(`${base}/api/auth/wechat/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceId: code }),
  })).json();
  const alice = await login("conversation-alice");
  const bob = await login("conversation-bob");
  const post = (url, body, token) => fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const mine = (token) => fetch(`${base}/api/feedback/mine`, { headers: { Authorization: `Bearer ${token}` } });
  const created = await (await post("/api/feedback", {
    category: "content_issue", content: "题目答案和教材依据不一致",
  }, alice.token)).json();
  const reportId = created.item.id;

  const ask = await post(`/api/admin/moderation/${reportId}/messages`, {
    content: "请补充教材版本、页码和你认为正确的答案。",
    clientMessageId: "ask-1",
  });
  assert.equal(ask.status, 200);
  const personalMessages = await (await fetch(`${base}/api/messages`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  })).json();
  assert.equal(personalMessages.messages[0].title, "请补充反馈信息");
  assert.equal(personalMessages.messages[0].feedbackId, reportId);
  const asked = (await (await mine(alice.token)).json()).items[0];
  assert.equal(asked.status, "processing");
  assert.equal(asked.waitingForUser, true);
  assert.equal(asked.canReply, true);
  assert.equal(asked.messages[0].role, "staff");

  const wrongOwner = await post(`/api/feedback/${reportId}/replies`, {
    content: "不应该写入别人的反馈", clientMessageId: "bob-1",
  }, bob.token);
  assert.equal(wrongOwner.status, 404);

  const reply = await post(`/api/feedback/${reportId}/replies`, {
    content: "我用的是上册第 32 页，正确答案应为 A。", clientMessageId: "reply-1",
  }, alice.token);
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).item.userReplied, true);
  const duplicate = await post(`/api/feedback/${reportId}/replies`, {
    content: "我用的是上册第 32 页，正确答案应为 A。", clientMessageId: "reply-1",
  }, alice.token);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const awaiting = await fetch(`${base}/api/admin/moderation?status=awaiting_reply`);
  assert.equal((await awaiting.json()).reports.length, 0);
  const replied = await fetch(`${base}/api/admin/moderation?status=user_replied`);
  assert.equal((await replied.json()).reports.some((item) => item.id === reportId), true);

  const closed = await (await post(`/api/admin/moderation/${reportId}/action`, {
    action: "resolve", note: "已根据补充材料核对",
  })).json();
  assert.equal(closed.report.status, "resolved");
  const afterClose = await post(`/api/admin/moderation/${reportId}/messages`, {
    content: "结案后不应继续追问", clientMessageId: "ask-2",
  });
  assert.equal(afterClose.status, 422);
  const detail = await fetch(`${base}/api/admin/moderation/${reportId}/messages`);
  assert.equal(detail.headers.get("cache-control"), "no-store");
  const full = (await detail.json()).report;
  assert.equal(full.messages.length, 2);
  assert.equal(full.status, "resolved");
  assert.equal(full.messages[0].role, "staff");
  assert.equal(full.messages[1].role, "user");
  assert.equal((await fetch(`${base}/api/admin/moderation/missing/messages`)).status, 404);
  const unauthenticatedStatus = await new Promise((resolve, reject) => {
    require("node:http").get(`${base}/api/admin/moderation/${reportId}/messages`, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(unauthenticatedStatus, 401);
});

test("conversation state does not expose a follow-up path for system or anonymized reporters", () => {
  const store = createMemoryModerationStore([]);
  const system = store.create({
    source: "system_review", targetType: "app_feedback", targetId: "system-f", reason: "系统初筛",
    reporter: { id: "system" },
  });
  assert.equal(store.list().reports.find((item) => item.id === system.id).canAsk, false);
  const user = store.create({
    targetType: "app_feedback", targetId: "user-f", reason: "用户反馈",
    reporter: { id: "alice" },
  });
  store.anonymizeUser("alice");
  assert.equal(store.list().reports.find((item) => item.id === user.id).canAsk, false);
});
