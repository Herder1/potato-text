const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeClassicalWordStem } = require("../apps/api/src/classical-word-marker");

test("classical word explanations put the target on its own final line", () => {
  const result = normalizeClassicalWordStem({
    stem: "于是乘其车，揖其剑，过其友曰：\"孟尝君客我！\"",
    referenceAnswer: "“客”用作动词，意为“以客礼相待”。",
  });
  assert.deepEqual(result, {
    stem: "于是乘其车，揖其剑，过其友曰：\"孟尝君客我！\"\n客：",
    target: "客",
    needsReview: false,
  });
});

test("classical word explanations keep an unresolved marker for manual review", () => {
  const result = normalizeClassicalWordStem({
    stem: "于是乘其车，揖其剑，过其友曰：\"孟尝君客我！\"",
    referenceAnswer: "以礼相待。",
  });
  assert.equal(result.stem, "于是乘其车，揖其剑，过其友曰：\"孟尝君客我！\"");
  assert.equal(result.needsReview, true);
});
