const test = require("node:test");
const assert = require("node:assert/strict");
const { applyDataPatch } = require("./helpers/set-data");
const { resolveApiBaseUrl } = require("../apps/miniprogram/utils/api-environment");

const QUEUE_KEY = "shukao_content_feedback_queue";

function setup(t, globalData = {}) {
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  const previousModule = require.cache[practicePath];
  const previousGlobals = ["Page", "getApp", "wx"].map((name) => [name, Object.getOwnPropertyDescriptor(global, name)]);
  t.after(() => {
    delete require.cache[practicePath];
    if (previousModule) require.cache[practicePath] = previousModule;
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete global[name];
    }
  });
  const app = { globalData: { apiBaseUrl: resolveApiBaseUrl({ envVersion: "develop" }), authToken: "test-feedback-token", ...globalData } };
  const store = new Map();
  const requests = [];
  const toasts = [];
  let definition;
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key),
    setStorageSync: (key, value) => store.set(key, value),
    showToast: (toast) => toasts.push(toast),
    request: (request) => requests.push(request),
  };
  delete require.cache[practicePath];
  require(practicePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function (patch) { applyDataPatch(this.data, patch); };
  page.setData({
    utilityPanel: "feedback",
    feedbackType: "correction",
    feedbackText: "反馈有问题",
    question: { id: "feedback-question", type: "single", stem: "测试题干" },
    subjectiveScoreResult: { requestId: "feedback-score-request" },
  });
  return { app, page, store, requests, toasts };
}

test("practice feedback retains empty and short drafts without sending or queueing", (t) => {
  const { page, store, requests, toasts } = setup(t);
  for (const content of ["", "   ", "错", "有错", "题有错", "题目有错", "  题目有错  "]) {
    page.setData({ feedbackText: content });
    page.submitContentFeedback();
    assert.equal(page.data.feedbackText, content);
    assert.equal(page.data.utilityPanel, "feedback");
    assert.equal(requests.length, 0);
    assert.equal(store.has(QUEUE_KEY), false);
    assert.equal(toasts.at(-1).title, content.trim() ? "不少于五个字才能提交" : "请填写反馈内容");
  }
});

test("practice feedback requires a type without discarding the draft", (t) => {
  const { page, requests, toasts } = setup(t);
  page.setData({ feedbackType: "" });
  page.submitContentFeedback();
  assert.equal(requests.length, 0);
  assert.equal(page.data.feedbackText, "反馈有问题");
  assert.equal(page.data.utilityPanel, "feedback");
  assert.equal(toasts.at(-1).title, "请选择反馈类型");
});

test("practice feedback accepts five characters and uses the unchanged local development URL", (t) => {
  const { page, requests, store, toasts } = setup(t);
  store.set(QUEUE_KEY, [{ clientFeedbackId: "other-feedback", content: "其他待提交反馈" }]);
  page.setData({ feedbackText: "  反馈有问题  " });
  page.submitContentFeedback();
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "http://127.0.0.1:3212/api/feedback");
  assert.equal(request.method, "POST");
  assert.equal(request.header.Authorization, "Bearer test-feedback-token");
  assert.equal(request.data.content, "反馈有问题");
  assert.equal(request.data.category, "content_issue");
  assert.equal(request.data.questionId, "feedback-question");
  assert.equal(request.data.questionType, "single");
  assert.equal(request.data.questionStemPreview, "测试题干");
  assert.equal(request.data.scoreRequestId, "feedback-score-request");
  assert.equal(request.data.feedbackType, "correction");
  assert.match(request.data.clientFeedbackId, /^fb-/);
  request.success({ statusCode: 201, data: { item: { id: "server-feedback" } } });
  assert.equal(toasts.at(-1).title, "反馈已提交");
  assert.deepEqual(store.get(QUEUE_KEY).map((item) => item.clientFeedbackId), ["other-feedback"]);
});

test("practice feedback queues a signed-out draft without making an anonymous request", (t) => {
  const { page, store, requests, toasts } = setup(t, { authToken: "" });
  page.submitContentFeedback();
  assert.equal(requests.length, 0);
  const [record] = store.get(QUEUE_KEY);
  assert.equal(record.content, "反馈有问题");
  assert.equal(record.questionId, "feedback-question");
  assert.equal(record.lastError, "not_signed_in");
  assert.equal(record.attempts, 0);
  assert.equal(toasts.at(-1).title, "登录后才能提交反馈，已为你暂存");
});

for (const [code, error] of [[401, "auth_session_invalid"], [403, "user_restricted"], [422, "feedback_content_too_short"], [500, "internal_error"]]) {
  test(`practice feedback preserves HTTP ${code} error and the original submission ID`, (t) => {
    const { page, store, requests, toasts } = setup(t);
    page.submitContentFeedback();
    requests[0].success({ statusCode: code, data: { error } });
    const [record] = store.get(QUEUE_KEY);
    assert.equal(record.clientFeedbackId, requests[0].data.clientFeedbackId);
    assert.equal(record.content, "反馈有问题");
    assert.equal(record.attempts, 1);
    assert.equal(record.lastError, `http_${code}:${error}`);
    assert.match(toasts.at(-1).title, new RegExp(String(code)));
    assert.notEqual(toasts.at(-1).title, "反馈已提交");
    assert.equal(requests.length, 1);
  });
}

test("practice feedback preserves transport failures and retries using the same ID", (t) => {
  const { page, store, requests, toasts } = setup(t);
  page.setData({ feedbackType: "issue" });
  page.submitContentFeedback();
  assert.equal(requests[0].data.category, "feature_issue");
  requests[0].fail({ errMsg: "request:fail timeout" });
  const [record] = store.get(QUEUE_KEY);
  assert.equal(record.lastError, "request:fail timeout");
  assert.equal(record.attempts, 1);
  assert.ok(record.nextRetryAt > Date.now());
  assert.equal(toasts.at(-1).title, "网络异常，已暂存待重试");
  page.syncPendingFeedback();
  assert.equal(requests.length, 1);
  store.set(QUEUE_KEY, [{ ...record, nextRetryAt: 0 }]);
  page.syncPendingFeedback();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].data, requests[0].data);
  requests[1].success({ statusCode: 200, data: { report: { id: "existing-feedback" } } });
  assert.deepEqual(store.get(QUEUE_KEY), []);
  assert.equal(toasts.at(-1).title, "反馈已提交");
});

for (const envVersion of ["trial", "release"]) {
  test(`practice feedback in unconfigured ${envVersion} retains the draft without local POST fallback`, (t) => {
    const apiBaseUrl = resolveApiBaseUrl({ envVersion, storedOverride: "http://127.0.0.1:3212", apiBaseUrls: { trial: "", release: "" } });
    const { page, store, requests, toasts } = setup(t, { apiBaseUrl, apiEnvironment: envVersion });
    page.submitContentFeedback();
    assert.equal(requests.length, 0);
    const [record] = store.get(QUEUE_KEY);
    assert.equal(record.content, "反馈有问题");
    assert.equal(record.lastError, "api_base_url_not_configured");
    assert.equal(record.attempts, 0);
    assert.ok(record.nextRetryAt > Date.now());
    assert.equal(toasts.at(-1).title, "当前版本未配置服务地址");
    page.sendContentFeedback(record);
    assert.equal(store.get(QUEUE_KEY).length, 1);
    assert.equal(store.get(QUEUE_KEY)[0].clientFeedbackId, record.clientFeedbackId);
    assert.equal(requests.length, 0);
  });
}

test("practice feedback tolerates missing and whitespace-only service addresses", (t) => {
  const { app, page, store, requests } = setup(t);
  for (const apiBaseUrl of [undefined, "   ", ""]) {
    app.globalData.apiBaseUrl = apiBaseUrl;
    page.setData({ feedbackText: "反馈有问题" });
    page.submitContentFeedback();
    assert.equal(store.get(QUEUE_KEY)[0].lastError, "api_base_url_not_configured");
  }
  assert.equal(requests.length, 0);
});

test("practice feedback normalizes trailing slashes without changing the selected service", (t) => {
  const { page, requests } = setup(t, { apiBaseUrl: "  http://127.0.0.1:3212/  " });
  page.submitContentFeedback();
  assert.equal(requests[0].url, "http://127.0.0.1:3212/api/feedback");
});

// 产品负责人 2026-10-02：占位文案要写明字数门槛，短内容提示也要说门槛（两处措辞必须一致）
test("practice feedback states the five-character gate in both the placeholder and the short-content toast", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const wxml = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/practice/practice.wxml"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/practice/practice.js"), "utf8");
  assert.match(wxml, /placeholder="请说明需要修改或改进的地方（不少于五个字才能提交）"/);
  assert.match(script, /if \(content\.length < 5\) \{[\s\S]{0,200}?title: "不少于五个字才能提交"/);
  assert.doesNotMatch(script, /title: "请具体描述遇到的问题"/, "旧的短内容提示不应再出现");
  assert.doesNotMatch(wxml, /需大于五个字/, "门槛文案口径是「不少于五个字」，不应回退成「需大于五个字」");
});
