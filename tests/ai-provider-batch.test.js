const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const {
  createProviderBatchRegistry,
  mergePassedProviderBatch,
  parseProviderBatchDocument,
  runProviderBatchJob,
} = require("../apps/api/src/ai-provider-batch");

// 供应商批量接入（2026-10-09）：文档导入 → 批量连通性测试 → 只保留测试通过的。
// ① 解析规则与"只保留通过项"的合并规则用纯函数直接测；
// ② 端到端走真实后台登录链路 + 本机假上游（真实 provider 协议、真实任务表），断言失败项不落库。

function candidateAt(index, overrides = {}) {
  return {
    index,
    lineNumber: index + 1,
    name: `供应商${index}`,
    protocol: "openai_chat_completions",
    baseUrl: `https://gw${index}.example.com/v1`,
    apiKey: `sk-key-${index}`,
    model: "",
    errors: [],
    warnings: [],
    duplicateOf: 0,
    ...overrides,
  };
}

test("批量接入：清单文档解析出候选接口，跳过说明文字与注释、识别重复行", () => {
  const parsed = parseProviderBatchDocument([
    "给大家分享一波 typesafe.jev 的官 key：需要的老板自提",
    "# 这一行是注释",
    "// 也是注释",
    "",
    "https://api.typesafe.ai/v1,sk-aabbccddeeff00112233,jev-latest",
    "   ",
  ].join("\n"));
  assert.equal(parsed.summary.skipped, 1);
  assert.equal(parsed.summary.total, 1);
  const [entry] = parsed.candidates;
  assert.equal(entry.baseUrl, "https://api.typesafe.ai/v1");
  assert.equal(entry.apiKey, "sk-aabbccddeeff00112233");
  assert.equal(entry.model, "jev-latest");
  assert.equal(entry.name, "api.typesafe.ai · 2233");
  assert.deepEqual(entry.errors, []);
  assert.equal(parsed.warnings.some((warning) => warning.message.includes("已跳过")), true);
});

test("批量接入：支持「名称,BaseURL,密钥」、Bearer 前缀、协议列与重复行归并", () => {
  const parsed = parseProviderBatchDocument([
    "网关A,https://gw.example.com/v1,Bearer sk-0000111122223333",
    "sk-0000111122223333",
    "https://other.example.com/v1,sk-9999888877776666,gpt-x,anthropic_messages",
  ].join("\n"), { baseUrl: "https://gw.example.com/v1" });
  assert.equal(parsed.summary.total, 3);
  assert.equal(parsed.summary.duplicates, 1);
  assert.equal(parsed.candidates[0].name, "网关A");
  assert.equal(parsed.candidates[0].apiKey, "sk-0000111122223333");
  // 只有密钥的行沿用统一 Base URL，与第 1 行完全同源，因此标为重复、只测一次。
  assert.equal(parsed.candidates[1].baseUrl, "https://gw.example.com/v1");
  assert.equal(parsed.candidates[1].duplicateOf, 1);
  assert.equal(parsed.candidates[2].model, "gpt-x");
  assert.equal(parsed.candidates[2].protocol, "anthropic_messages");
});

test("批量接入：带表头的 CSV 按列名读取，缺 Base URL 的行如实报错", () => {
  const parsed = parseProviderBatchDocument([
    "供应商名称,Base URL,API Key,模型",
    "硅基流动,https://api.siliconflow.cn/v1,sk-hhhh11112222,Qwen/Qwen3-8B",
    "缺地址,,sk-jjjj33334444,",
  ].join("\n"));
  assert.equal(parsed.summary.total, 2);
  assert.equal(parsed.summary.invalid, 1);
  assert.equal(parsed.candidates[0].name, "硅基流动");
  assert.equal(parsed.candidates[0].baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(parsed.candidates[0].model, "Qwen/Qwen3-8B");
  assert.deepEqual(parsed.candidates[1].errors, ["missing_provider_base_url"]);
});

test("批量接入：空文档、超量、超大文本都在解析阶段就拒绝", () => {
  assert.throws(() => parseProviderBatchDocument(""), /provider_batch_document_empty/);
  assert.throws(() => parseProviderBatchDocument("说明文字\n另外一行说明\n"), /provider_batch_document_empty/);
  const many = Array.from({ length: 61 }, (unused, index) => `https://gw${index}.example.com/v1,sk-key-${index}0000`).join("\n");
  assert.throws(() => parseProviderBatchDocument(many), /provider_batch_too_many_entries/);
  assert.throws(() => parseProviderBatchDocument("x".repeat(256 * 1024 + 1)), /provider_batch_text_too_large/);
});

test("批量接入：只保留测试通过的——已存在的供应商补模型不重复建，失败项完全不写", () => {
  const job = {
    timeoutMs: 20000,
    candidates: [
      candidateAt(0, { baseUrl: "https://a.example.com/v1", apiKey: "sk-aaa", name: "A" }),
      candidateAt(1, { baseUrl: "https://b.example.com/v1", apiKey: "sk-bbb", name: "B" }),
      candidateAt(2, { baseUrl: "https://c.example.com/v1", apiKey: "sk-ccc", name: "C" }),
    ],
    results: [
      { index: 0, status: "passed", models: ["m1", "m2"], model: "m1" },
      { index: 1, status: "failed", errorCode: "provider_http_error:401 invalid api key" },
      { index: 2, status: "passed", models: ["m3"], model: "m3" },
    ],
  };
  const config = {
    providers: [{
      id: "provider-a",
      name: "已有A",
      protocol: "openai_chat_completions",
      baseUrl: "https://a.example.com/v1",
      models: ["m1"],
      apiKey: "sk-aaa",
      enabled: false,
      timeoutMs: 5000,
    }],
    routes: {},
  };
  const merged = mergePassedProviderBatch(config, job, { now: "2026-10-09T00:00:00.000Z", timeoutMs: 20000 });
  assert.equal(merged.created.length, 1);
  assert.equal(merged.updated.length, 1);
  assert.equal(merged.config.providers.length, 2);
  // 已存在的同源供应商：补上这次发现的模型，但名称、协议与启用状态都不动。
  assert.deepEqual(merged.config.providers[0].models, ["m1", "m2"]);
  assert.equal(merged.config.providers[0].name, "已有A");
  assert.equal(merged.config.providers[0].enabled, false);
  assert.equal(merged.updated[0].addedModels, 1);
  // 新通过的建成一条启用的供应商；失败的 B 一个字都没写。
  assert.equal(merged.config.providers[1].apiKey, "sk-ccc");
  assert.equal(merged.config.providers[1].enabled, true);
  assert.deepEqual(merged.config.providers[1].models, ["m3"]);
  assert.equal(merged.config.providers.some((provider) => provider.apiKey === "sk-bbb"), false);
});

test("批量接入：并发受控、取消后未测条目如实记为未测试、结果里没有明文密钥", async () => {
  const registry = createProviderBatchRegistry({ maxActive: 1, ttlMs: 60 * 1000 });
  const candidates = [0, 1, 2, 3].map((index) => candidateAt(index));
  const job = registry.start({ candidates, concurrency: 2, timeoutMs: 5000, savePassed: false });
  assert.throws(() => registry.start({ candidates, concurrency: 1 }), /provider_batch_too_many_jobs/);

  let inFlight = 0;
  let peak = 0;
  await runProviderBatchJob(job, {
    runEntry: async (candidate) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (candidate.index === 0) job.cancelled = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { model: "m", models: ["m"], latencyMs: 10, preview: "连接成功" };
    },
  });

  assert.equal(peak <= 2, true);
  assert.equal(job.status, "cancelled");
  assert.equal(job.results.some((result) => result.status === "passed"), true);
  assert.equal(job.results.some((result) => result.status === "skipped"), true);
  // 跑完立刻清掉明文候选项，结果行只有掩码。
  assert.equal(job.candidates.length, 0);
  assert.equal(JSON.stringify(job.results).includes("sk-key-"), false);
  assert.equal(job.results.every((result) => !("apiKey" in result)), true);
});

// 本机假上游：只有白名单里的密钥能读模型列表与调用对话，其余一律 401（真实 provider 协议）。
function createFakeUpstream(validKeys, delayMs = 0) {
  const models = ["fast-model", "smart-model"];
  const calls = [];
  const server = http.createServer((request, response) => {
    request.resume();
    const url = new URL(request.url, "http://127.0.0.1");
    const authorization = String(request.headers.authorization || "");
    const key = authorization.replace(/^Bearer\s+/i, "");
    calls.push({ pathname: url.pathname, key });
    const allowed = validKeys.has(key);
    const respond = (status, payload) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const finish = () => {
      if (!allowed) {
        respond(401, { error: { message: "invalid api key" } });
        return;
      }
      if (url.pathname.endsWith("/models")) {
        respond(200, { data: models.map((id) => ({ id })) });
        return;
      }
      respond(200, { model: "smart-model", choices: [{ message: { content: "连接成功" } }] });
    };
    if (delayMs) setTimeout(finish, delayMs);
    else finish();
  });
  return { server, calls, models };
}

test("批量接入：文档导入 → 批量测试 → 只把测试通过的写进供应商列表", async (context) => {
  const validKeys = new Set(["good-key-new", "good-key-existing"]);
  const fake = createFakeUpstream(validKeys);
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => fake.server.close(resolve)));
  const upstreamBase = `http://127.0.0.1:${fake.server.address().port}`;

  const aiConfigStore = createMemoryAiConfigStore({
    providers: [{
      id: "provider-old",
      name: "老供应商",
      protocol: "openai_chat_completions",
      baseUrl: `${upstreamBase}/v1`,
      models: ["smart-model"],
      apiKey: "good-key-existing",
      enabled: false,
      timeoutMs: 5000,
    }],
  });
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({ aiConfigStore, operationLogStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (route, options) => {
    const response = await fetch(`${base}${route}`, options);
    return { status: response.status, data: await response.json() };
  };
  const post = (route, body) => json(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const text = [
    `${upstreamBase}/v1,good-key-new,smart-model`,
    `${upstreamBase}/v1,good-key-existing,gpt-x`,
    `${upstreamBase}/other,good-key-broken`,
    "bad-key-only",
    `${upstreamBase}/v1,good-key-new,smart-model`,
    "给大家分享一波：需要的老板自提",
  ].join("\n");
  const defaults = { baseUrl: `${upstreamBase}/v1`, protocol: "openai_chat_completions" };

  const parsed = await post("/api/admin/ai/provider-batch/parse", { text, ...defaults });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.data.summary.total, 5);
  assert.equal(parsed.data.summary.invalid, 0);
  assert.equal(parsed.data.summary.duplicates, 1);
  assert.equal(parsed.data.summary.skipped, 1);
  // 解析预览必须带掩码，但绝不能回明文密钥。
  assert.equal(JSON.stringify(parsed.data).includes("good-key-new"), false);
  assert.equal(parsed.data.candidates[0].apiKeyMasked.startsWith("good"), true);
  assert.equal(parsed.data.candidates[1].duplicateOf, 0);
  assert.equal(parsed.data.candidates[4].duplicateOf, 1);

  const started = await post("/api/admin/ai/provider-batch", { text, ...defaults, concurrency: 2, timeoutMs: 5000, savePassed: true });
  assert.equal(started.status, 200);
  assert.equal(started.data.job.status, "running");
  assert.equal(started.data.job.savePassed, true);
  const jobId = started.data.job.id;

  let job = started.data.job;
  const deadline = Date.now() + 20000;
  while (job.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const polled = await json(`/api/admin/ai/provider-batch/${jobId}`);
    assert.equal(polled.status, 200);
    job = polled.data.job;
  }
  assert.equal(job.status, "finished");
  assert.equal(job.summary.total, 5);
  assert.equal(job.summary.tested, 4);
  assert.equal(job.summary.passed, 2);
  assert.equal(job.summary.failed, 2);
  assert.equal(job.summary.duplicates, 1);
  assert.equal(job.summary.created, 1);
  assert.equal(job.summary.updated, 1);
  assert.equal(job.done, 5);
  // 逐条结果带掩码与真实失败原因（401 如实回报为上游鉴权失败，不伪装成"模型列表不可用"）。
  const failed = job.results.filter((result) => result.status === "failed");
  assert.equal(failed.length, 2);
  assert.equal(failed.every((result) => result.errorCode.startsWith("provider_http_error:")), true);
  assert.match(failed[0].errorCode, /invalid api key/i);
  assert.equal(job.results.find((result) => result.status === "passed").models.length, 2);
  assert.equal(JSON.stringify(job).includes("good-key-new"), false);
  assert.equal(JSON.stringify(job).includes("bad-key-only"), false);

  // 只保留测试通过的：老的同源供应商补模型且不改启用状态，新通过的建一条启用的，失败的完全不写。
  const config = aiConfigStore.load();
  assert.equal(config.providers.length, 2);
  const existing = config.providers.find((provider) => provider.id === "provider-old");
  assert.deepEqual(existing.models, ["smart-model", "fast-model"]);
  assert.equal(existing.name, "老供应商");
  assert.equal(existing.enabled, false);
  const created = config.providers.find((provider) => provider.apiKey === "good-key-new");
  assert.ok(created);
  assert.equal(created.enabled, true);
  assert.deepEqual(created.models, ["fast-model", "smart-model"]);
  assert.equal(config.providers.some((provider) => provider.apiKey === "good-key-broken"), false);
  assert.equal(config.providers.some((provider) => provider.apiKey === "bad-key-only"), false);
  // 供应商列表接口只回掩码。
  const listed = await json("/api/admin/ai-config");
  assert.equal(JSON.stringify(listed.data).includes("good-key-new"), false);
  assert.equal(listed.data.providers.find((provider) => provider.id === created.id).apiKeyMasked.endsWith("new"), true);

  // 操作日志：记录批量接入动作与数量，不得出现任何密钥。
  const logs = operationLogStore.list({ category: "ai_config" }).items;
  assert.equal(logs.some((item) => item.action === "ai_provider.batch_test"), true);
  const importLog = logs.find((item) => item.action === "ai_provider.batch_import");
  assert.ok(importLog);
  assert.equal(importLog.actor, "测试超管");
  assert.equal(importLog.metadata.passed, 2);
  assert.equal(importLog.metadata.createdProviders.length, 1);
  assert.match(importLog.summary, /新增 1 个、更新 1 个/);
  assert.equal(JSON.stringify(logs).includes("good-key"), false);

  // 未知任务号如实 404，不冒充成功。
  assert.equal((await json("/api/admin/ai/provider-batch/provider-batch-not-exist")).status, 404);
});

test("批量接入：可以中途取消，已测通过的照常保留、没轮到的不冒充失败", async (context) => {
  const validKeys = new Set(["slow-key"]);
  const fake = createFakeUpstream(validKeys, 300);
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => fake.server.close(resolve)));
  const upstreamBase = `http://127.0.0.1:${fake.server.address().port}`;

  const aiConfigStore = createMemoryAiConfigStore();
  const server = createServer({ aiConfigStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const text = [
    `${upstreamBase}/a,slow-key`,
    `${upstreamBase}/b,slow-key`,
    `${upstreamBase}/c,slow-key`,
  ].join("\n");
  const post = (route, body) => fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, data: await response.json() }));

  const started = await post("/api/admin/ai/provider-batch", { text, concurrency: 1, timeoutMs: 5000, savePassed: true });
  assert.equal(started.status, 200);
  const jobId = started.data.job.id;

  const cancelResponse = await fetch(`${base}/api/admin/ai/provider-batch/${jobId}`, { method: "DELETE" });
  assert.equal(cancelResponse.status, 200);
  assert.equal((await cancelResponse.json()).job.cancelled, true);

  let job = started.data.job;
  const deadline = Date.now() + 15000;
  while (job.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    job = await fetch(`${base}/api/admin/ai/provider-batch/${jobId}`).then((response) => response.json()).then((payload) => payload.job);
  }
  assert.equal(job.status, "cancelled");
  assert.equal(job.results.filter((result) => result.status === "skipped").length >= 1, true);
  assert.equal(job.results.every((result) => ["passed", "failed", "skipped"].includes(result.status)), true);
  // 取消不是失败：已测通过的那条仍然按"只保留通过项"落库。
  const passed = job.results.filter((result) => result.status === "passed").length;
  assert.equal(aiConfigStore.load().providers.length, passed);
  assert.equal(job.summary.untouched >= 1, true);
});
