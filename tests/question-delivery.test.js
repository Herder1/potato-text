const assert = require("node:assert/strict");
const test = require("node:test");

const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createServer } = require("../apps/api/src/server");
const { normalizeOfficialQuestion } = require("../apps/miniprogram/utils/question-sync");

test("official question delivery supports conditional refresh and client-side derived fields", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/questions?library=official&bookId=modern-chinese-7-1`;

  const firstResponse = await fetch(url);
  const payload = await firstResponse.json();
  const etag = firstResponse.headers.get("etag");
  assert.equal(firstResponse.status, 200);
  assert.ok(etag);
  assert.equal(payload.etag, etag);
  assert.ok(Number(payload.version) > 0);
  assert.ok(payload.questions.length > 0);

  const delivered = payload.questions[0];
  assert.equal(delivered.answerMode, undefined);
  assert.equal(delivered.answerPlaceholder, undefined);
  const normalized = normalizeOfficialQuestion(delivered);
  assert.equal(normalized.answerMode, delivered.type === "single_choice" || delivered.type === "multiple_choice" ? "choice" : "text");
  assert.ok(normalized.chapterId);
  assert.ok(normalized.knowledgePoint);

  const unchangedResponse = await fetch(url, { headers: { "If-None-Match": etag } });
  assert.equal(unchangedResponse.status, 304);
  assert.equal(await unchangedResponse.text(), "");
});
