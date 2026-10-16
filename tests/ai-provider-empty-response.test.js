const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { callChatCompletion } = require("../apps/api/src/ai-provider");

test("empty upstream output reports actionable cause without leaking response details", async (t) => {
  let responseBody = {};
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = {
    protocol: "openai_chat_completions", baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-only", timeoutMs: 1000,
  };
  const request = { model: "test-model", messages: [{ role: "user", content: "test" }], maxTokens: 256 };
  for (const [body, code] of [
    [{ choices: [{ finish_reason: "length", message: { content: null, reasoning_content: "private reasoning" } }] }, "provider_output_budget_exhausted"],
    [{ choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "private reasoning" } }] }, "provider_reasoning_only_response"],
    [{ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }, "provider_output_filtered"],
    [{ choices: [{ finish_reason: "stop", message: { content: "" } }], usage: { completion_tokens: 10 } }, "provider_empty_response_with_usage"],
    [{ choices: [{ finish_reason: "stop", message: { content: "  " } }] }, "provider_empty_response"],
  ]) {
    responseBody = body;
    await assert.rejects(callChatCompletion(provider, request), { message: code });
  }
});
