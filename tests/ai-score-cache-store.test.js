const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAiScoreCacheStore } = require("../apps/api/src/ai-score-cache-store");

test("AI score cache replaces matching keys without storing answer text", () => {
  const store = createMemoryAiScoreCacheStore();
  store.set({ key: "hash-only", questionId: "question-1", model: "model-a", result: { totalScore: 2 } });
  store.set({ key: "hash-only", questionId: "question-1", model: "model-b", result: { totalScore: 3 } });
  const cached = store.get("hash-only");
  assert.equal(cached.model, "model-b");
  assert.equal(cached.result.totalScore, 3);
  assert.equal("answer" in cached, false);
  assert.equal(store.get("missing"), null);
});
