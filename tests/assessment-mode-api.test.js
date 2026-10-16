const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");
const http = require("node:http");
const BASE = "/api/admin/knowledge-classification/assessment-modes";

async function start(t, options = {}) {
  const questionStore = createMemoryQuestionStore([{ id: "q-modes", subjectId: "ancient-literature", type: "single_choice",
    bookId: "", stem: "王实甫的代表作是？", options: [{ key: "A", text: "西厢记" }], version: 1 }]);
  const experience = createMemoryKnowledgeClassificationExperienceStore();
  const server = createServer({ aiConfigStore: options.aiConfigStore || createMemoryAiConfigStore(), questionStore, knowledgeClassificationExperienceStore: experience });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, method = "GET", body) => fetch(`${base}${url}`, {
    method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { base, call, questionStore, experience };
}

test("real API: standards and independent annotations survive edits without touching questions", async (t) => {
  const { call, questionStore } = await start(t);
  const before = questionStore.exportState();
  const list = await (await call(`${BASE}?subjectId=ancient-literature&type=single_choice`)).json();
  assert.equal(list.items.length, 14);
  const id = list.items[0].id;
  const path = "/api/admin/questions/q-modes/assessment-modes";
  const save = await call(path, "PUT", { expectedQuestionVersion: 1, expectedRevision: 0, modeIds: [id], modeVersions: { [id]: 1 } });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).status, "confirmed");
  assert.deepEqual(questionStore.exportState(), before);
  const edit = await call(`${BASE}/${id}`, "PATCH", { expectedVersion: 1, definition: "更新后的定义" });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).affected.length, 1);
  assert.equal((await (await call(path)).json()).status, "needs_review");
  assert.equal((await call(`${BASE}/${id}`, "PATCH", { expectedVersion: 1, name: "并发修改" })).status, 409);
  assert.equal((await (await call(`${BASE}/${id}/impact`)).json()).items[0].questionId, "q-modes");
});

test("unconfigured AI and invalid labels fail visibly without writing assignments", async (t) => {
  const { call, experience } = await start(t);
  const path = "/api/admin/questions/q-modes/assessment-modes";
  const before = experience.exportState();
  assert.equal((await call(`${path}/suggest`, "POST", {})).status, 503);
  assert.equal((await call(path, "PUT", { expectedQuestionVersion: 1, expectedRevision: 0, modeIds: ["forged"] })).status, 422);
  assert.deepEqual(experience.exportState(), before);
});

test("empty model output fails the suggestion without saving an assignment", async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: null } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [{ id: "mode-provider", name: "模拟供应商", protocol: "openai_chat_completions", enabled: true,
      baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "test", models: ["test-model"], timeoutMs: 5000 }],
    routes: { question_enrichment: { mode: "provider", providerId: "mode-provider", model: "test-model", maxTokens: 256 } },
  });
  const { call, experience } = await start(t, { aiConfigStore });
  const before = experience.exportState();
  const response = await call("/api/admin/questions/q-modes/assessment-modes/suggest", "POST", {});
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "provider_output_budget_exhausted");
  assert.deepEqual(experience.exportState(), before);
});

test("new routes are authenticated, including read and mutation", async (t) => {
  const { base } = await start(t);
  for (const [url, method] of [[BASE, "GET"], [BASE, "POST"], ["/api/admin/questions/q-modes/assessment-modes", "PUT"]]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(`${base}${url}`, { method, headers: { "Content-Type": "application/json" } },
        (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
      request.end(method === "GET" ? undefined : "{}");
    });
    assert.equal(status, 401);
  }
});

test("AI uses configured provider and current standards, emits suggestions but never saves them", async (t) => {
  const prompts = [];
  let modelResult = { selections: [{ id: "ancient-literature-c01", reason: "题干询问作者与代表作的对应。" }], uncertainty: "" };
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      prompts.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "test-model", choices: [{ message: { content: JSON.stringify(modelResult) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [{ id: "mode-provider", name: "模拟供应商", protocol: "openai_chat_completions", enabled: true,
      baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "test", models: ["test-model"], supportsJsonMode: true, timeoutMs: 5000 }],
    routes: { question_enrichment: { mode: "provider", providerId: "mode-provider", model: "test-model", maxTokens: 1800 } },
  });
  const { call, experience } = await start(t, { aiConfigStore });
  await call(`${BASE}/ancient-literature-c01`, "PATCH", { expectedVersion: 1, definition: "唯一动态标准定义" });
  const before = experience.exportState();
  const response = await call("/api/admin/questions/q-modes/assessment-modes/suggest", "POST", {});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "suggested");
  assert.equal(result.selections[0].version, 2);
  assert.match(prompts[0].messages[1].content, /唯一动态标准定义/);
  assert.match(prompts[0].messages[1].content, /西厢记/);
  assert.match(prompts[0].messages[0].content, /唯一考法定义来源/);
  assert.deepEqual(experience.exportState(), before);
  modelResult = { selections: [{ id: "forged-mode", reason: "模型自创" }] };
  const invalid = await call("/api/admin/questions/q-modes/assessment-modes/suggest", "POST", {});
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error, "assessment_mode_ai_output_invalid");
  assert.deepEqual(experience.exportState(), before);
});
