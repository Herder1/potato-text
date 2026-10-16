const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");

/**
 * 「AI 补充答案 / 得分点」（题库正式题，2026-10-10 产品负责人确认三条）：
 *   ① 只返回建议、**不写库** —— 人工核对后由「保存新版本」入库（手册 §3.4「AI 建议、人工裁决」）；
 *   ② 前端只填空缺，已有内容不动；
 *   ③ 客观题只补答案与解析，不写结构化得分点（该字段只对主观题显示）。
 * 规则正文：产品手册 §4.6.13 之外由 2026-10-10 的确认口径约定；实现口径见变更日志同日条目。
 */
async function startSupplementFixture(context, { question, aiReplies, routes = true }) {
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft("modern-chinese-7-1", [{ id: "node-1", level: 1, title: "第一章 绪论", startPage: 1, endPage: 30, knowledgePoints: ["现代汉语方言"] }], { source: "test" }, "测试编辑");
  textbookCatalogStore.confirm("modern-chinese-7-1", "测试编辑");
  const questionStore = createMemoryQuestionStore([]);
  const created = questionStore.create(question, "测试编辑");
  const prompts = [];
  const replies = [...aiReplies];
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      prompts.push(JSON.parse(body));
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "supplement-model",
        choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = {
    id: "supplement-provider",
    name: "答案补充模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test",
    models: ["supplement-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const operationLogStore = createMemoryAdminOperationStore();
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: routes
      ? { exam_answer_supplement: { mode: "provider", providerId: provider.id, model: "supplement-model", temperature: 0.2, maxTokens: 1200 } }
      : {},
  });
  const server = createServer({ aiConfigStore, questionStore, textbookCatalogStore, operationLogStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    question: created,
    questionStore,
    operationLogStore,
    prompts,
  };
}

const subjectiveQuestion = {
  id: "supplement-subjective",
  subjectId: "modern-chinese",
  bookId: "modern-chinese-7-1",
  chapter: "第一章 绪论",
  knowledgePoints: ["现代汉语方言"],
  type: "short_answer",
  stem: "简述现代汉语方言差异的主要表现。",
  maxScore: 4,
  referenceAnswer: "",
  scoringPoints: [],
};

test("AI 补充答案只为题库正式题生成建议，不写库", async (context) => {
  const { baseUrl, question, questionStore, operationLogStore, prompts } = await startSupplementFixture(context, {
    question: subjectiveQuestion,
    aiReplies: [{
      correctAnswer: [],
      referenceAnswer: "**语音差异**最突出，其次是**词汇**与**语法**。",
      scoringPoints: [
        { description: "指出语音差异最突出", score: 2, textbookPage: "3-5", pageBasis: "confirmed_catalog", sourceNote: "《现代汉语》· 绪论" },
        { description: "补充词汇或语法差异", score: 2, textbookPage: "3-5", pageBasis: "confirmed_catalog", sourceNote: "《现代汉语》· 绪论" },
      ],
      uncertainty: "",
    }],
  });
  const before = questionStore.get(question.id);
  const response = await fetch(`${baseUrl}/api/admin/questions/${question.id}/ai-supplement-answer`, { method: "POST" });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.match(payload.supplement.referenceAnswer, /语音差异/);
  assert.equal(payload.supplement.correctAnswer.length, 0);
  assert.equal(payload.supplement.scoringPoints.length, 2);
  assert.equal(payload.supplement.scoringPoints.reduce((total, point) => total + point.score, 0), 4);
  assert.equal(payload.supplement.scoringPointStatus, "complete");
  assert.equal(payload.supplement.questionId, question.id);
  // 不写库：版本、参考答案、得分点一个字都没变（入库只能靠人工点「保存新版本」）
  const after = questionStore.get(question.id);
  assert.equal(after.version, before.version);
  assert.equal(after.referenceAnswer, before.referenceAnswer);
  assert.deepEqual(after.scoringPoints, before.scoringPoints);
  const logged = operationLogStore.list({ category: "all", limit: 50 }).items.find((entry) => entry.action === "question.ai_answer_supplement");
  assert.ok(logged, "必须留下操作日志");
  assert.equal(logged.targetId, question.id);
  assert.equal(logged.metadata.wroteQuestion, false);
  // 提示词用的是同一份契约（answerSupplementPromptSpec）：要求答案 + 得分点 + 不确定项，并带上题目与目录上下文
  assert.equal(prompts.length, 1);
  const renderedPrompt = JSON.stringify(prompts[0]);
  assert.match(renderedPrompt, /简述现代汉语方言差异的主要表现/);
  assert.match(renderedPrompt, /\\"scoringPoints\\"/);
  assert.match(renderedPrompt, /\\"uncertainty\\"/);
  assert.match(renderedPrompt, /第一章 绪论/);
});

test("客观题只返回答案与解析，不写得分点", async (context) => {
  const { baseUrl, questionStore } = await startSupplementFixture(context, {
    question: {
      id: "supplement-choice",
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      type: "single_choice",
      stem: "现代汉语方言差异最大体现在哪一方面？",
      options: [{ key: "A", text: "词汇" }, { key: "B", text: "语音" }],
      correctAnswer: ["A"],
      maxScore: 2,
    },
    aiReplies: [{
      correctAnswer: ["B"],
      referenceAnswer: "方言差异以**语音**最突出。",
      scoringPoints: [{ description: "判断依据", score: 2, textbookPage: "3-5", pageBasis: "confirmed_catalog", sourceNote: "《现代汉语》· 绪论" }],
      uncertainty: "",
    }],
  });
  const before = questionStore.get("supplement-choice");
  const response = await fetch(`${baseUrl}/api/admin/questions/supplement-choice/ai-supplement-answer`, { method: "POST" });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.supplement.correctAnswer, ["B"]);
  assert.match(payload.supplement.referenceAnswer, /语音/);
  assert.deepEqual(payload.supplement.scoringPoints, [], "客观题不产出得分点");
  assert.equal(payload.supplement.scoringPointStatus, "not_required");
  const after = questionStore.get("supplement-choice");
  assert.equal(after.version, before.version);
  assert.deepEqual(after.correctAnswer, before.correctAnswer);
});

test("模型输出不合规时按 422 拒绝，并且不写库", async (context) => {
  const { baseUrl, questionStore } = await startSupplementFixture(context, {
    question: { ...subjectiveQuestion, id: "supplement-invalid" },
    aiReplies: [
      { correctAnswer: [], referenceAnswer: "答案在", scoringPoints: [{ description: "只给 1 分", score: 1 }], uncertainty: "" },
      { correctAnswer: [], referenceAnswer: "", scoringPoints: [{ description: "没有答案", score: 4 }], uncertainty: "" },
    ],
  });
  const before = questionStore.get("supplement-invalid");
  // ① 得分点合计与总分不符
  const mismatch = await fetch(`${baseUrl}/api/admin/questions/supplement-invalid/ai-supplement-answer`, { method: "POST" });
  assert.equal(mismatch.status, 422);
  assert.equal((await mismatch.json()).error, "provider_output_format_error");
  // ② 参考答案为空
  const empty = await fetch(`${baseUrl}/api/admin/questions/supplement-invalid/ai-supplement-answer`, { method: "POST" });
  assert.equal(empty.status, 422);
  assert.equal((await empty.json()).error, "provider_output_format_error");
  const after = questionStore.get("supplement-invalid");
  assert.equal(after.version, before.version);
  assert.equal(after.referenceAnswer, before.referenceAnswer);
});

test("未配置模型路由给 503、题目不存在给 404，都不写库", async (context) => {
  const { baseUrl } = await startSupplementFixture(context, {
    question: { ...subjectiveQuestion, id: "supplement-no-route" },
    aiReplies: [{ correctAnswer: [], referenceAnswer: "x", scoringPoints: [], uncertainty: "" }],
    routes: false,
  });
  const noRoute = await fetch(`${baseUrl}/api/admin/questions/supplement-no-route/ai-supplement-answer`, { method: "POST" });
  assert.equal(noRoute.status, 503);
  assert.equal((await noRoute.json()).error, "answer_supplement_route_unavailable");
  const missing = await fetch(`${baseUrl}/api/admin/questions/question-does-not-exist/ai-supplement-answer`, { method: "POST" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "question_not_found");
});

test("后台只有这一处发起补充、且前端不做任何写库调用", () => {
  const root = path.join(__dirname, "../apps/admin");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const head = html.slice(html.indexOf('id="question-answer-heading"'), html.indexOf('id="question-ai-answer-panel"'));
  assert.doesNotMatch(head, /id="question-ai-supplement"/, "按钮不再留在「答案与解析」标题行（2026-10-16 负责人要求下移到 AI 答案行）");
  const aiPanel = html.slice(html.indexOf('id="question-ai-answer-panel"'), html.indexOf('id="question-community-answer-panel"'));
  assert.match(aiPanel, /<summary>[\s\S]*id="question-ai-supplement"[^>]*>AI 补充答案 \/ 得分点<\/button><\/summary>/,
    "按钮长在「AI 答案」面板的标题行里——面板折叠时也必须可见可点");
  assert.match(app, /#question-ai-supplement"\)\.addEventListener\("click", \(event\) => \{\s*event\.preventDefault\(\);/,
    "点在 summary 里的按钮不得顺带展开/收起 AI 答案面板");
  assert.match(html, /id="question-ai-supplement-status"[^>]*hidden/, "行内回执默认收起");
  const body = app.slice(app.indexOf("async function requestQuestionAiAnswerSupplement("), app.indexOf("async function openQuestionVersions("));
  assert.match(body, /\/api\/admin\/questions\/\$\{encodeURIComponent\(questionId\)\}\/ai-supplement-answer/, "只能打这一条接口");
  assert.match(body, /method: "POST"/);
  assert.doesNotMatch(body, /method: "PUT"|method: "PATCH"|method: "DELETE"/, "补充动作不得直接改题");
  // 只填空缺：三处都先读现有内容再决定要不要写
  assert.match(body, /skipped\.push\("正确答案"\)/);
  assert.match(body, /skipped\.push\("AI 答案"\)/);
  assert.match(body, /skipped\.push\("结构化得分点"\)/);
  assert.match(app, /answer_supplement_route_unavailable:/);
});
