const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { listProviderModels, testProvider, isConversationalProtocol, systemOnePreview } = require("../apps/api/src/ai-provider");

// 2026-10-09 实例：api.typesafe.ai（Typesafe / Jev）不是 OpenAI 兼容上游 ——
// GET /v1/models 与 POST /v1/systemone 存在，/v1/chat/completions 与 /v1/responses 都是 404。
// 因此给供应商加一条 typesafe_systemone 协议：能测连通性（结构化判定），但不能当对话模型用。

function fakeSystemOneUpstream() {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const authorization = String(request.headers.authorization || "");
      if (authorization !== "Bearer sys-key") {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ detail: { error_type: "authentication_error", message: "Cannot authenticate with the server." } }));
        return;
      }
      if (url.pathname.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "jev-latest" }, { id: "jev-preview" }] }));
        return;
      }
      if (url.pathname.endsWith("/systemone")) {
        const payload = JSON.parse(body || "{}");
        calls.push(payload);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          model: payload.model,
          answers: Object.fromEntries(Object.keys(payload.questions || {}).map((id) => [id, { noul: 0.97, confidence: 0.93 }])),
        }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "Not Found" }));
    });
  });
  return { server, calls };
}

test("Typesafe/Jev：models 与 systemone 都能走通，请求体符合官方文档形状（state/model/questions）", async (context) => {
  const upstream = fakeSystemOneUpstream();
  await new Promise((resolve) => upstream.server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.server.close(resolve)));
  const provider = {
    id: "provider-sys",
    name: "jev",
    protocol: "typesafe_systemone",
    baseUrl: `http://127.0.0.1:${upstream.server.address().port}`,
    apiKey: "sys-key",
    models: ["jev-latest"],
    timeoutMs: 5000,
    enabled: true,
  };

  const models = await listProviderModels(provider);
  assert.deepEqual(models, ["jev-latest", "jev-preview"]);

  const result = await testProvider(provider, "jev-latest", { systemPrompt: "连通性测试", userPrompt: "只回复连接成功" });
  assert.equal(result.model, "jev-latest");
  assert.match(result.preview, /noul=0\.97/);

  // 发出去的确实是 System One 形状：state + model + questions.<id>.{type,instructions}
  assert.equal(upstream.calls.length, 1);
  const payload = upstream.calls[0];
  assert.equal(payload.model, "jev-latest");
  assert.equal(typeof payload.state, "string");
  assert.match(payload.state, /连通性测试/);
  const question = Object.values(payload.questions)[0];
  assert.equal(question.type, "noul");
  assert.equal(typeof question.instructions, "string");
  assert.equal("messages" in payload, false, "System One 不接受 messages 字段");
  assert.equal("max_tokens" in payload, false);
});

test("Typesafe/Jev：批量接入清单（只有密钥 + 统一 Base URL/协议）能测出通过项，并标注结构化上游", async (context) => {
  const upstream = fakeSystemOneUpstream();
  await new Promise((resolve) => upstream.server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.server.close(resolve)));
  const upstreamBase = `http://127.0.0.1:${upstream.server.address().port}`;

  const aiConfigStore = createMemoryAiConfigStore();
  const server = createServer({ aiConfigStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, data: await response.json() }));

  // 产品负责人手上那种清单：每行一把密钥，统一填 Base URL 与协议。
  const defaults = { baseUrl: upstreamBase, protocol: "typesafe_systemone" };
  const parsed = await post("/api/admin/ai/provider-batch/parse", { text: "sys-key\nanother-key", ...defaults });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.data.summary.total, 2);
  assert.equal(parsed.data.candidates[0].protocol, "typesafe_systemone");
  assert.equal(parsed.data.candidates[0].apiKeyMasked.includes("sys-key"), false);

  const started = await post("/api/admin/ai/provider-batch", { text: "sys-key", ...defaults, savePassed: true });
  assert.equal(started.status, 200);
  let job = started.data.job;
  const deadline = Date.now() + 15000;
  while (job.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = await fetch(`${base}/api/admin/ai/provider-batch/${started.data.job.id}`).then((response) => response.json()).then((payload) => payload.job);
  }
  assert.equal(job.status, "finished");
  assert.equal(job.summary.passed, 1);
  const passed = job.results.find((result) => result.status === "passed");
  assert.match(passed.note, /结构化判定上游/);
  assert.match(passed.preview, /noul=/);
  const saved = aiConfigStore.load().providers;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].protocol, "typesafe_systemone");
});

test("Typesafe/Jev：结构化判定上游不能当对话模型用（调用与配置两条路都拦住）", async (context) => {
  const upstream = fakeSystemOneUpstream();
  await new Promise((resolve) => upstream.server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.server.close(resolve)));
  const upstreamPort = upstream.server.address().port;

  assert.equal(isConversationalProtocol("typesafe_systemone"), false);
  assert.equal(isConversationalProtocol("openai_chat_completions"), true);
  assert.match(systemOnePreview({ answers: { q: { choice: "yes", confidence: 0.5 } } }, ["q"]), /choice=yes/);

  const aiConfigStore = createMemoryAiConfigStore({
    providers: [{
      id: "provider-sys",
      name: "jev",
      protocol: "typesafe_systemone",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "sys-key",
      models: ["jev-latest"],
      timeoutMs: 5000,
      enabled: true,
    }],
  });
  const server = createServer({ aiConfigStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, body, method = "POST") => fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (response) => ({ status: response.status, data: await response.json() }));

  // ① 配置期就拒绝绑定场景
  const route = await call("/api/admin/ai/routes/subjective_scoring", {
    mode: "provider",
    providerId: "provider-sys",
    model: "jev-latest",
  }, "PUT");
  assert.equal(route.status, 400);
  assert.equal(route.data.error, "route_provider_not_conversational");

  // ② 连通性测试通过，并明确回报「不是对话上游」
  const probe = await call("/api/admin/ai/test", { providerId: "provider-sys", model: "jev-latest" });
  assert.equal(probe.status, 200);
  assert.equal(probe.data.result.protocol, "typesafe_systemone");
  assert.equal(probe.data.result.notConversational, true);
  assert.match(probe.data.result.preview, /noul=/);

  // ③ 运行期即使有人绕过配置，场景调用也给出明确错误码
  const { completePromptWithProvider } = require("../apps/api/src/ai-provider");
  await assert.rejects(
    () => completePromptWithProvider(
      { protocol: "typesafe_systemone", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "sys-key", timeoutMs: 3000 },
      { model: "jev-latest", temperature: 0, maxTokens: 64 },
      { systemPrompt: "s", userPromptTemplate: "u" },
      {},
    ),
    /provider_protocol_not_conversational/,
  );
});
