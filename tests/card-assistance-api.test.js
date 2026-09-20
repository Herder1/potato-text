const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");

function completionForPrompt(promptText, repairAttempt = 0) {
  if (promptText.includes("首轮需修正") && repairAttempt === 1) {
    return {
      schemaVersion: 2,
      concepts: [{
        id: "missing-direct-answer",
        pointId: "p1",
        role: "definition",
        highlight: { quote: "北京语音", occurrence: 0 },
        clozes: [{ quote: "北京语音", occurrence: 0 }],
      }],
      mnemonic: { text: "首轮无效", conceptIds: ["missing-direct-answer"] },
    };
  }
  if (promptText.includes("畸形结果")) {
    return {
      schemaVersion: 2,
      concepts: [{
        id: "invalid",
        pointId: "p1",
        role: "definition",
        highlight: { quote: "共同交际", occurrence: 0 },
        clozes: [{ quote: "共同", occurrence: 0 }],
      }],
      mnemonic: { text: "无效口诀", conceptIds: ["invalid"] },
    };
  }
  if (promptText.includes("并发重点")) {
    return {
      schemaVersion: 2,
      concepts: [{
        id: "concurrent-key",
        pointId: "p1",
        role: "direct_answer",
        highlight: { quote: "并发重点", occurrence: 0 },
        clozes: [{ quote: "并发重点", occurrence: 0 }],
      }],
      mnemonic: { text: "并发共记", conceptIds: ["concurrent-key"] },
    };
  }
  return {
    schemaVersion: 2,
    concepts: [{
      id: "standard-sound",
      pointId: "p1",
      role: "direct_answer",
      highlight: { quote: "北京语音", occurrence: 0 },
      clozes: [{ quote: "北京语音", occurrence: 0 }],
    }],
    mnemonic: { text: "京音为标", conceptIds: ["standard-sound"] },
  };
}

test("card memory assistance generates one shared bundle and reuses validated cache", async (context) => {
  let upstreamCalls = 0;
  let repairCalls = 0;
  const upstreamPayloads = [];
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      upstreamCalls += 1;
      const payload = JSON.parse(body);
      upstreamPayloads.push(payload);
      const promptText = JSON.stringify(payload.messages || []);
      const repairAttempt = promptText.includes("首轮需修正") ? ++repairCalls : 0;
      const send = () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          model: payload.model,
          choices: [{ message: { content: JSON.stringify(completionForPrompt(promptText, repairAttempt)) } }],
          usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
        }));
      };
      if (promptText.includes("并发重点")) setTimeout(send, 35);
      else send();
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const provider = {
    id: "card-ai-provider",
    name: "卡片模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-secret",
    models: ["card-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_note_extraction: {
        mode: "provider",
        providerId: provider.id,
        model: "card-model",
        temperature: 0.1,
        maxTokens: 1800,
      },
    },
  });
  const server = createServer({ aiConfigStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/ai/card-memory-assistance`;
  const answer = "1.普通话以北京语音为标准音。";

  const missingQuestionResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestedFeature: "cloze", question: "", answer }),
  });
  const missingQuestion = await missingQuestionResponse.json();
  assert.equal(missingQuestionResponse.status, 400);
  assert.equal(missingQuestion.chargeable, false);
  assert.equal(missingQuestion.error, "card_assistance_question_required");
  assert.equal(upstreamCalls, 0);

  const firstResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "card-request-1",
      userId: "user-a",
      requestedFeature: "cloze",
      question: "普通话的语音标准是什么？",
      answer,
    }),
  });
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.chargeable, true);
  assert.equal(first.generation.source, "model");
  assert.equal(first.result.requestId, "card-request-1");
  assert.equal(first.schemaVersion, 2);
  assert.equal(answer.slice(first.result.highlights[0].start, first.result.highlights[0].end), "北京语音");
  assert.equal(answer.slice(first.result.clozes[0].start, first.result.clozes[0].end), "北京语音");
  assert.ok(first.result.clozes[0].start >= first.result.highlights[0].start);
  assert.ok(first.result.clozes[0].end <= first.result.highlights[0].end);
  assert.deepEqual(first.result.mnemonic, { text: "京音为标", conceptIds: ["standard-sound"] });
  assert.equal(upstreamCalls, 1);
  assert.equal(upstreamPayloads[0].response_format.type, "json_object");
  assert.equal(upstreamPayloads[0].reasoning_effort, "low");
  assert.equal(upstreamPayloads[0].temperature, 0);
  assert.equal(upstreamPayloads[0].max_tokens, 1700);
  assert.match(upstreamPayloads[0].messages[0].content, /schemaVersion=2/u);
  assert.match(upstreamPayloads[0].messages[0].content, /类型名或成员名/u);
  assert.match(upstreamPayloads[0].messages[0].content, /禁止把所有 concept 都写成 direct_answer/u);
  assert.match(upstreamPayloads[0].messages[0].content, /不得把“双轨制”截成“双轨”/u);
  assert.match(upstreamPayloads[0].messages[0].content, /资产阶级子女/u);
  assert.match(upstreamPayloads[0].messages[0].content, /targetHighlights/u);
  assert.match(upstreamPayloads[0].messages[1].content, /"role": "direct_answer"/u);
  assert.match(upstreamPayloads[0].messages[1].content, /"role": "contrast"/u);
  assert.match(upstreamPayloads[0].messages[1].content, /"clozes": \[/u);
  assert.match(upstreamPayloads[0].messages[1].content, /"occurrence": 0/u);

  const cached = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "card-request-2",
      userId: "user-a",
      requestedFeature: "mnemonic",
      question: "普通话的语音标准是什么？",
      answer,
    }),
  }).then((response) => response.json());
  assert.equal(cached.chargeable, false);
  assert.equal(cached.generation.source, "cache");
  assert.equal(cached.result.requestId, "card-request-2");
  assert.equal(upstreamCalls, 1);

  const otherUser = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "card-request-user-b",
      userId: "user-b",
      requestedFeature: "highlight",
      question: "普通话的语音标准是什么？",
      answer,
    }),
  }).then((response) => response.json());
  assert.equal(otherUser.chargeable, true);
  assert.equal(upstreamCalls, 2);

  const concurrentBody = {
    userId: "user-a",
    question: "并发测试",
    answer: "1.并发重点需要共同记忆。",
  };
  const concurrent = await Promise.all([
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...concurrentBody, requestId: "concurrent-1", requestedFeature: "cloze" }),
    }).then((response) => response.json()),
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...concurrentBody, requestId: "concurrent-2", requestedFeature: "highlight" }),
    }).then((response) => response.json()),
  ]);
  assert.deepEqual(concurrent.map((item) => item.chargeable).sort(), [false, true]);
  assert.equal(concurrent.some((item) => item.generation.source === "inflight_cache"), true);
  assert.equal(upstreamCalls, 3);

  const repairedResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "repair-1",
      userId: "user-repair",
      requestedFeature: "cloze",
      question: "首轮需修正：普通话的语音标准是什么？",
      answer,
    }),
  });
  const repaired = await repairedResponse.json();
  assert.equal(repairedResponse.status, 200);
  assert.equal(repaired.chargeable, true);
  assert.equal(repaired.result.highlights[0].text, "北京语音");
  assert.equal(repaired.usage.total_tokens, 240, "both provider attempts remain auditable while the user is charged once");
  assert.equal(repairCalls, 2);
  assert.equal(upstreamCalls, 5);
  assert.match(upstreamPayloads[4].messages[0].content, /上一次输出未通过范围、数量或覆盖校验/u);

  const invalidResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "invalid-1",
      userId: "user-a",
      question: "畸形结果",
      answer: "1.语言是共同交际工具。",
    }),
  });
  const invalid = await invalidResponse.json();
  assert.equal(invalidResponse.status, 422);
  assert.equal(invalid.chargeable, false);
  assert.equal(invalid.error, "provider_output_format_error");
  assert.equal(upstreamCalls, 7, "a permanently invalid result is retried only once");
});

test("card memory assistance reports a disabled route without charging", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/card-memory-assistance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "问题", answer: "1.答案。" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.chargeable, false);
  assert.equal(payload.error, "card_memory_assistance_route_unavailable");
});

test("persisted legacy card prompts are forcibly migrated to the v2 contract", () => {
  const legacyPrompt = {
    systemPrompt: "旧知识卡提示词只要求一个 cloze.quote。",
    userPromptTemplate: "{{question}}\n{{answerPoints}}\n{{requiredOutput}}",
    version: 9,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const config = createMemoryAiConfigStore({
    prompts: { card_memory_assistance: legacyPrompt },
  }).load();
  const migrated = config.prompts.card_memory_assistance;

  assert.equal(migrated.version, 5);
  assert.notEqual(migrated.systemPrompt, legacyPrompt.systemPrompt);
  assert.match(migrated.systemPrompt, /schemaVersion=2/u);
  assert.match(migrated.systemPrompt, /direct_answer/u);
  assert.match(migrated.systemPrompt, /类型名或成员名/u);
  assert.match(migrated.systemPrompt, /禁止把所有 concept 都写成 direct_answer/u);
  assert.match(migrated.systemPrompt, /禁止只挖“所有、相互、介于/u);
  assert.match(migrated.systemPrompt, /targetHighlights/u);
  assert.match(migrated.systemPrompt, /含 1 至 2 项的 clozes 数组/u);
});
