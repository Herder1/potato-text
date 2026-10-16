const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryLearningStateStore } = require("../apps/api/src/learning-state-store");
const { createMemoryBillingStore } = require("../apps/api/src/billing-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { listExamProjects } = require("../apps/api/src/exam-project-registry");

// 注册引导四项（2026-10-03 产品负责人确认）：性别、年龄段、目标考试项目、报考年份。
// 必填只在引导层把关（客户端引导层不填完不发奖励、不放行首页），
// 服务端负责"只认固定档位与登记表 + 空值可清空 + 派生字段 onboardingCompleted"。
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
  return { login, updateProfile, me };
}

const examProjectId = listExamProjects()[0].id;
const currentYear = new Date().getFullYear();

test("a brand-new account starts with the four onboarding answers empty", async (context) => {
  const { login, me } = await startServer(context);
  const first = await login("onboarding-device-1");

  assert.equal(first.isNewUser, true, "登录响应要能区分新账号：引导层据此决定弹注册引导还是直接放行");
  assert.equal(first.user.gender, "");
  assert.equal(first.user.ageBand, "");
  assert.equal(first.user.examProjectId, "");
  assert.equal(first.user.examYear, 0);
  assert.equal(first.user.onboardingCompleted, false);

  const readBack = await me(first.token);
  assert.equal(readBack.user.onboardingCompleted, false);
  // 老账号再登录不会重算引导状态：已填的仍旧算填全。
  const again = await login("onboarding-device-1");
  assert.equal(again.isNewUser, false);
  assert.equal(again.user.onboardingCompleted, false);
});

test("the four onboarding answers round-trip and drive the derived completed flag", async (context) => {
  const { login, updateProfile, me } = await startServer(context);
  const { token } = await login("onboarding-device-2");

  const saved = await updateProfile(token, {
    gender: "female",
    ageBand: "19_22",
    examProjectId,
    examYear: currentYear + 1,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.user.gender, "female");
  assert.equal(saved.payload.user.ageBand, "19_22");
  assert.equal(saved.payload.user.examProjectId, examProjectId);
  assert.equal(saved.payload.user.examYear, currentYear + 1);
  assert.equal(saved.payload.user.onboardingCompleted, true);
  // 引导提交不得顺手动到账号身份字段。
  assert.equal(saved.payload.user.nickname, "薯考同学");

  const readBack = await me(token);
  assert.equal(readBack.user.onboardingCompleted, true);
  assert.equal(readBack.user.gender, "female");

  // 只改一项：其余三项保持，派生字段仍为 true。
  const partial = await updateProfile(token, { examYear: currentYear });
  assert.equal(partial.payload.user.examYear, currentYear);
  assert.equal(partial.payload.user.ageBand, "19_22");
  assert.equal(partial.payload.user.onboardingCompleted, true);
});

test("onboarding answers reject anything outside the fixed choices, and reject atomically", async (context) => {
  const { login, updateProfile, me } = await startServer(context);
  const { token } = await login("onboarding-device-3");
  await updateProfile(token, { gender: "male", ageBand: "23_26", examProjectId, examYear: currentYear + 2 });

  const rejected = [
    [{ gender: "其他" }, "gender_invalid"],
    [{ gender: "MALE" }, "gender_invalid"],
    [{ ageBand: "18-22" }, "age_band_invalid"],
    [{ examProjectId: "not-a-project" }, "exam_project_invalid"],
    [{ examYear: currentYear + 6 }, "exam_year_invalid"],
    [{ examYear: currentYear - 1 }, "exam_year_invalid"],
    [{ examYear: "今年" }, "exam_year_invalid"],
    [{ examYear: 2026.5 }, "exam_year_invalid"],
  ];
  for (const [body, error] of rejected) {
    const response = await updateProfile(token, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.payload.error, error);
  }

  // 任一字段非法 → 整次请求不落库，不留半截状态（与既有资料字段同一套原子语义）。
  const mixed = await updateProfile(token, { gender: "undisclosed", examYear: currentYear + 99 });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.payload.error, "exam_year_invalid");
  const untouched = await me(token);
  assert.equal(untouched.user.gender, "male");
  assert.equal(untouched.user.examYear, currentYear + 2);
  assert.equal(untouched.user.onboardingCompleted, true);
});

test("empty strings clear the onboarding answers and flip the completed flag back", async (context) => {
  const { login, updateProfile } = await startServer(context);
  const { token } = await login("onboarding-device-4");
  await updateProfile(token, { gender: "undisclosed", ageBand: "31_plus", examProjectId, examYear: currentYear + 3 });

  const cleared = await updateProfile(token, { gender: "", ageBand: "", examProjectId: "", examYear: "" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.user.gender, "");
  assert.equal(cleared.payload.user.ageBand, "");
  assert.equal(cleared.payload.user.examProjectId, "");
  assert.equal(cleared.payload.user.examYear, 0);
  assert.equal(cleared.payload.user.onboardingCompleted, false);
});

test("the onboarding boundary years are accepted on the last allowed year", async (context) => {
  const { login, updateProfile } = await startServer(context);
  const { token } = await login("onboarding-device-5");

  const lastAllowed = await updateProfile(token, { examYear: currentYear + 5 });
  assert.equal(lastAllowed.status, 200);
  assert.equal(lastAllowed.payload.user.examYear, currentYear + 5);
  // 只填年龄项时其他三项仍为空：不因为一项合法就伪装成填全。
  assert.equal(lastAllowed.payload.user.onboardingCompleted, false);
});
