const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryUserAuthStore, DEFAULT_DAILY_GOAL_MINUTES } = require("../apps/api/src/user-auth-store");
const { subjects } = require("../packages/domain/catalog");
const { createMemoryLearningStateStore } = require("../apps/api/src/learning-state-store");
const { createMemoryBillingStore } = require("../apps/api/src/billing-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");

async function startServer(context) {
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    userAuthStore: createMemoryUserAuthStore(),
    learningStateStore: createMemoryLearningStateStore(),
    billingStore: createMemoryBillingStore(),
    questionStore: createMemoryQuestionStore([]),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = async (deviceId, extra = {}) => {
    const response = await fetch(`${baseUrl}/api/auth/wechat/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: `code-${deviceId}`, deviceId, ...extra }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const updateProfile = async (token, body) => {
    const response = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };
  const me = async (token) => {
    const response = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
  };
  return { baseUrl, login, updateProfile, me };
}

test("auth profile requires a valid user session", async (context) => {
  const { login, updateProfile } = await startServer(context);

  const anonymous = await updateProfile("", { nickname: "匿名改名" });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.payload.error, "auth_session_invalid");

  const forged = await updateProfile("forged-token", { nickname: "伪造会话" });
  assert.equal(forged.status, 401);
  assert.equal(forged.payload.error, "auth_session_invalid");

  const { token } = await login("profile-device-1");
  const empty = await updateProfile(token, {});
  assert.equal(empty.status, 400);
  assert.equal(empty.payload.error, "profile_patch_required");
});

test("auth profile stores a user-chosen nickname and avatar, and login never overwrites them", async (context) => {
  const { login, updateProfile, me } = await startServer(context);

  // 登录请求里即使夹带 profile，也不再作为头像昵称来源：可信来源只有用户自己在“我的”页填的。
  const forgedProfile = { nickname: "客户端自报昵称", avatarUrl: "https://example.com/forged.png" };
  const first = await login("profile-device-2", { profile: forgedProfile });
  assert.equal(first.user.nickname, "薯考同学");
  assert.equal(first.user.avatarUrl, "");

  const avatarUrl = `data:image/png;base64,${Buffer.from("avatar-bytes").toString("base64")}`;
  const saved = await updateProfile(first.token, { nickname: "薯考同学本名", avatarUrl });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.success, true);
  assert.equal(saved.payload.user.nickname, "薯考同学本名");
  // 社区身份与账号昵称同源，避免同一人在社区里显示旧名。
  assert.equal(saved.payload.user.communityNickname, "薯考同学本名");
  assert.equal(saved.payload.user.avatarUrl, avatarUrl);

  const readBack = await me(first.token);
  assert.equal(readBack.user.nickname, "薯考同学本名");
  assert.equal(readBack.user.avatarUrl, avatarUrl);

  // 再次登录（同一设备 → 同一 openid）不得用默认昵称/空头像覆盖用户自设值。
  const relogin = await login("profile-device-2", { profile: forgedProfile });
  assert.equal(relogin.user.id, first.user.id);
  assert.equal(relogin.user.nickname, "薯考同学本名");
  assert.equal(relogin.user.avatarUrl, avatarUrl);
});

test("auth profile rejects invalid nicknames and avatars without touching stored data", async (context) => {
  const { login, updateProfile, me } = await startServer(context);
  const { token } = await login("profile-device-3");

  const invalidNicknames = ["", "   ", "\u0000\u0001", "字".repeat(33)];
  for (const nickname of invalidNicknames) {
    const rejected = await updateProfile(token, { nickname });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.payload.error, "nickname_invalid");
  }

  const invalidAvatars = [
    "https://example.com/forged-avatar.png",
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    "data:image/png;base64,not*base64*",
  ];
  for (const avatarUrl of invalidAvatars) {
    const rejected = await updateProfile(token, { avatarUrl });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.payload.error, "avatar_invalid_format");
  }

  const oversized = `data:image/png;base64,${Buffer.alloc(201 * 1024, 7).toString("base64")}`;
  const tooLarge = await updateProfile(token, { avatarUrl: oversized });
  assert.equal(tooLarge.status, 400);
  assert.equal(tooLarge.payload.error, "avatar_too_large");

  // 全部被拒之后资料必须原样不动（默认昵称 + 空头像），不留半截状态。
  const unchanged = await me(token);
  assert.equal(unchanged.user.nickname, "薯考同学");
  assert.equal(unchanged.user.avatarUrl, "");

  const avatarUrl = `data:image/png;base64,${Buffer.from("avatar-bytes").toString("base64")}`;
  const saved = await updateProfile(token, { nickname: "学习者", avatarUrl });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.user.avatarUrl, avatarUrl);

  // 空串是"清除头像"的显式语义，不是非法值。
  const cleared = await updateProfile(token, { avatarUrl: "" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.user.avatarUrl, "");
  assert.equal(cleared.payload.user.nickname, "学习者");
});

// 参考图（产品负责人 2026-09-22 提供）里的"基础资料 / 学习偏好"六行：昵称、个人签名、所在地区、
// 学习方向、每日目标、公开学习数据开关。这里锁的是服务端真持久化 + 真校验，不是界面壳。
test("auth profile stores signature, region, study field, daily goal and the public-stats switch", async (context) => {
  const { login, updateProfile, me } = await startServer(context);
  const { token } = await login("profile-device-4");
  const studyFieldName = subjects[0].name;

  // 新账号默认值：文本字段为空、每日目标取默认档位、学习数据默认"不公开"（隐私默认值，见模块文档 §6）。
  const defaults = await me(token);
  assert.equal(defaults.user.signature, "");
  assert.equal(defaults.user.region, "");
  assert.equal(defaults.user.studyField, "");
  assert.equal(defaults.user.dailyGoalMinutes, DEFAULT_DAILY_GOAL_MINUTES);
  assert.equal(defaults.user.publicLearningStats, false);

  const saved = await updateProfile(token, {
    signature: "  把复杂的知识变简单  ",
    region: "中国香港",
    studyField: studyFieldName,
    dailyGoalMinutes: 30,
    publicLearningStats: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.user.signature, "把复杂的知识变简单");
  assert.equal(saved.payload.user.region, "中国香港");
  assert.equal(saved.payload.user.studyField, studyFieldName);
  assert.equal(saved.payload.user.dailyGoalMinutes, 30);
  assert.equal(saved.payload.user.publicLearningStats, true);
  // 请求里没带的字段保持原值：只改签名不会把昵称/头像清掉。
  assert.equal(saved.payload.user.nickname, "薯考同学");
  assert.equal(saved.payload.user.avatarUrl, "");

  const readBack = await me(token);
  assert.equal(readBack.user.signature, "把复杂的知识变简单");
  assert.equal(readBack.user.dailyGoalMinutes, 30);
  assert.equal(readBack.user.studyField, studyFieldName);

  // 非法值一律 400，且不得留下半截状态。
  const rejected = [
    [{ signature: "字".repeat(41) }, "signature_invalid"],
    [{ region: "区".repeat(61) }, "region_invalid"],
    [{ studyField: "不存在的科目" }, "study_field_invalid"],
    [{ dailyGoalMinutes: 7 }, "daily_goal_invalid"],
    [{ publicLearningStats: "true" }, "public_learning_stats_invalid"],
    [{ signature: { toString: () => "x" } }, "signature_invalid"],
  ];
  for (const [body, error] of rejected) {
    const response = await updateProfile(token, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.payload.error, error);
  }
  const untouched = await me(token);
  assert.equal(untouched.user.signature, "把复杂的知识变简单");
  assert.equal(untouched.user.dailyGoalMinutes, 30);
  assert.equal(untouched.user.publicLearningStats, true);
  assert.equal(untouched.user.studyField, studyFieldName);

  // 空串是"清空"的显式语义：签名/地区/学习方向可清空，开关可关回默认。
  const cleared = await updateProfile(token, { signature: "", region: "", studyField: "", dailyGoalMinutes: 20, publicLearningStats: false });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.user.signature, "");
  assert.equal(cleared.payload.user.region, "");
  assert.equal(cleared.payload.user.studyField, "");
  assert.equal(cleared.payload.user.publicLearningStats, false);
  // 昵称仍然完好：清空资料字段不会动到账号身份。
  assert.equal(cleared.payload.user.nickname, "薯考同学");
});
