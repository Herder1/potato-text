const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryLearningStateStore } = require("../apps/api/src/learning-state-store");
const { createMemoryBillingStore } = require("../apps/api/src/billing-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");

test("wechat login creates a restorable session and synchronizes learning state", async (context) => {
  const userAuthStore = createMemoryUserAuthStore();
  const learningStateStore = createMemoryLearningStateStore();
  const billingStore = createMemoryBillingStore();
  const questionStore = createMemoryQuestionStore([{
    id: "archived-source",
    library: "official",
    status: "offline",
    mergedIntoQuestionId: "canonical-target",
    merge: { type: "duplicate", targetQuestionId: "canonical-target" },
    version: 2,
    updatedAt: 20,
  }, {
    id: "canonical-target",
    library: "official",
    status: "official",
    version: 1,
    updatedAt: 10,
  }]);
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), userAuthStore, learningStateStore, billingStore, questionStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const loginResponse = await fetch(`${baseUrl}/api/auth/wechat/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "test-code", deviceId: "stable-test-device" }),
  });
  const login = await loginResponse.json();
  assert.equal(loginResponse.status, 200);
  assert.equal(login.authMode, "development");
  // 登录不再接受客户端上送的头像昵称（getUserProfile 已回收），新用户一律用默认昵称。
  assert.equal(login.user.nickname, "薯考同学");
  assert.equal(login.user.avatarUrl, "");
  // 注册奖励原 5 点 AI 额度 → 0.5 豆币（DEC-107）
  assert.equal(login.account.beanBalance, 0.5);

  const meResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${login.token}` } });
  const me = await meResponse.json();
  assert.equal(me.user.id, login.user.id);

  const profileResponse = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ nickname: "测试同学", avatarUrl: `data:image/png;base64,${Buffer.from("avatar-bytes").toString("base64")}` }),
  });
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.equal(profile.user.nickname, "测试同学");
  assert.equal(profile.user.communityNickname, "测试同学");
  assert.match(profile.user.avatarUrl, /^data:image\/png;base64,/);

  const now = Date.now();
  const syncResponse = await fetch(`${baseUrl}/api/learning/state/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({
      attempts: [{ questionId: "official-question-1", isCorrect: false, createdAt: now }],
      reviewStates: { "official-question-1": { questionId: "official-question-1", masteryStatus: "unknown", lastReviewAt: now, nextReviewAt: now } },
      bookmarks: { "official-question-1": { value: true, updatedAt: now } },
      reminder: { enabled: true, time: "19:30", subscriptionAccepted: true, updatedAt: now },
    }),
  });
  const synchronized = await syncResponse.json();
  assert.equal(syncResponse.status, 200);
  assert.equal(synchronized.state.attempts.length, 1);
  assert.deepEqual(synchronized.state.favoriteIds, ["official-question-1"]);
  assert.equal(synchronized.state.reminder.time, "19:30");

  learningStateStore.merge(login.user.id, {
    attempts: [{ id: "historic-source-attempt", questionId: "archived-source", createdAt: now + 1 }],
    reviewStates: { "archived-source": { questionId: "archived-source", masteryStatus: "unknown", lastReviewAt: now + 1 } },
    bookmarks: { "archived-source": { value: true, updatedAt: now + 1 } },
  }, now + 1);
  const remappedResponse = await fetch(`${baseUrl}/api/learning/state/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({
      reviewStates: { "archived-source": { questionId: "archived-source", masteryStatus: "familiar", lastReviewAt: now + 2 } },
      bookmarks: { "archived-source": { value: true, updatedAt: now + 2 } },
    }),
  });
  const remapped = await remappedResponse.json();
  assert.equal(remappedResponse.status, 200);
  assert.equal(remapped.state.reviewStates["archived-source"], undefined);
  assert.equal(remapped.state.reviewStates["canonical-target"].questionId, "canonical-target");
  assert.equal(remapped.state.reviewStates["canonical-target"].masteryStatus, "familiar");
  assert.equal(remapped.state.bookmarks["archived-source"], undefined);
  assert.deepEqual(remapped.state.favoriteIds, ["official-question-1", "canonical-target"]);
  assert.equal(remapped.state.attempts.some((attempt) => attempt.questionId === "archived-source"), true);

  const protectedAccount = await fetch(`${baseUrl}/api/billing/account?userId=${encodeURIComponent(login.user.id)}`);
  assert.equal(protectedAccount.status, 401);
  const ownAccount = await fetch(`${baseUrl}/api/billing/account?userId=someone-else`, {
    headers: { Authorization: `Bearer ${login.token}` },
  }).then((response) => response.json());
  assert.equal(ownAccount.account.userId, login.user.id);

  const secondLogin = await fetch(`${baseUrl}/api/auth/wechat/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "new-code", deviceId: "stable-test-device" }),
  }).then((response) => response.json());
  assert.equal(secondLogin.user.id, login.user.id);
  // 再次登录不得用默认昵称覆盖用户自设的昵称与头像。
  assert.equal(secondLogin.user.nickname, "测试同学");
  assert.match(secondLogin.user.avatarUrl, /^data:image\/png;base64,/);
  assert.equal(secondLogin.account.beanBalance, 0.5);
});

test("learning state resolves newer bookmark and review changes", () => {
  const store = createMemoryLearningStateStore();
  store.merge("user-1", {
    attempts: [{
      id: "attempt-q1-10",
      questionId: "q1",
      createdAt: 10,
      updatedAt: 10,
      response: { submitted: true, isCorrect: false, mastery: "unknown" },
    }],
    bookmarks: { q1: { value: true, updatedAt: 10 } },
    reviewStates: { q1: { questionId: "q1", masteryStatus: "unknown", lastReviewAt: 10 } },
    reviewHistory: [{ id: "review-2026-08-04-q1", questionId: "q1", status: "pending", updatedAt: 10 }],
  }, 10);
  const result = store.merge("user-1", {
    attempts: [{
      id: "attempt-q1-10",
      questionId: "q1",
      createdAt: 10,
      updatedAt: 20,
      response: { submitted: true, isCorrect: true, mastery: "familiar" },
    }],
    bookmarks: { q1: { value: false, updatedAt: 20 } },
    reviewStates: { q1: { questionId: "q1", masteryStatus: "familiar", lastReviewAt: 20 } },
    reviewHistory: [{ id: "review-2026-08-04-q1", questionId: "q1", status: "mastered", updatedAt: 20 }],
  }, 20);
  assert.deepEqual(result.favoriteIds, []);
  assert.equal(result.reviewStates.q1.masteryStatus, "familiar");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].response.isCorrect, true);
  assert.equal(result.attempts[0].response.mastery, "familiar");
  assert.equal(result.reviewHistory.length, 1);
  assert.equal(result.reviewHistory[0].status, "mastered");
});
