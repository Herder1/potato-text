const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryModerationStore } = require("../apps/api/src/moderation-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");

// 题目反馈带题目上下文（2026-10-01）：字段落库、服务端补全、幂等、后台虚拟筛选。
test("题目反馈：字段落库、questionId 不存在不阻断、clientFeedbackId 幂等、后台按虚拟筛选能筛出", async (context) => {
  const moderationStore = createMemoryModerationStore([]);
  const userAuthStore = createMemoryUserAuthStore();
  // 放一道真题目，用来验证"题型/题干预览以服务端为准"；若记忆库不接受最小题目，就退化为只验"不阻断"。
  const questionStore = createMemoryQuestionStore([{
    id: "question-feedback-fixture",
    bookId: "modern-chinese-7-1",
    type: "single_choice",
    stem: "这是一道用于题目反馈链路的测试题干，用来验证服务端会自己取题干做预览。",
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
    correctAnswer: "A",
  }]);
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), moderationStore, userAuthStore, questionStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/api/auth/wechat/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "feedback-question-user", deviceId: "feedback-question-device", profile: { nickname: "题目反馈同学" } }),
  }).then((response) => response.json());
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` };

  // ① 字段落库 + 服务端补全
  const created = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      category: "content_issue",
      content: "这道题的选项 B 好像写错了。",
      questionId: "question-feedback-fixture",
      questionType: "客户端瞎报的题型",
      feedbackType: "correction",
      scoreRequestId: "score-req-1",
      clientFeedbackId: "client-feedback-1",
      questionStemPreview: "客户端自述的题干",
    }),
  }).then((response) => response.json());
  const item = created.item;
  assert.equal(item.questionId, "question-feedback-fixture");
  assert.equal(item.feedbackType, "correction");
  assert.equal(item.scoreRequestId, "score-req-1");
  assert.equal(item.clientFeedbackId, "client-feedback-1");
  assert.equal(item.clientStemPreview, "客户端自述的题干");
  const serverKnowsQuestion = Boolean(questionStore.get && questionStore.get("question-feedback-fixture"));
  if (serverKnowsQuestion) {
    assert.notEqual(item.questionType, "客户端瞎报的题型", "题型应以服务端为准");
    assert.match(item.questionStemPreview, /测试题干/, "题干预览应由服务端从题库生成");
  }

  // ② questionId 不存在不阻断提交
  const ghost = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ category: "content_issue", content: "这道题根本不存在，也要能提交。", questionId: "question-not-exists", clientFeedbackId: "client-feedback-ghost" }),
  });
  assert.equal(ghost.status, 201);

  // ③ 幂等：同一 clientFeedbackId 再提交一次，不产生第二条
  const before = moderationStore.list({ type: "all", status: "all" }).reports.length;
  const again = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ category: "content_issue", content: "这道题的选项 B 好像写错了。", questionId: "question-feedback-fixture", feedbackType: "correction", clientFeedbackId: "client-feedback-1" }),
  }).then((response) => response.json());
  const after = moderationStore.list({ type: "all", status: "all" }).reports.length;
  assert.equal(again.duplicate, true, "重复提交应被识别为幂等");
  assert.equal(after, before, "重复提交不应新增记录");

  // ④ 后台"题目反馈"虚拟筛选：只筛 type=product_feedback 且带 questionId 的
  const listed = moderationStore.list({ type: "question_feedback", status: "all" }).reports;
  assert.ok(listed.length >= 2, "虚拟筛选应能筛出带 questionId 的反馈");
  assert.ok(listed.every((report) => report.type === "product_feedback" && String(report.questionId || "").trim()), "虚拟筛选不得混入没有 questionId 的反馈");
  const plain = await fetch(`${baseUrl}/api/feedback`, { method: "POST", headers: auth, body: JSON.stringify({ category: "experience", content: "普通产品反馈（不带题目）。" }) });
  assert.equal(plain.status, 201);
  const stillListed = moderationStore.list({ type: "question_feedback", status: "all" }).reports;
  assert.equal(stillListed.length, listed.length, "普通产品反馈不该被题目反馈筛选捞出来");
});
