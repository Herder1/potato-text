const test = require("node:test");
const assert = require("node:assert/strict");
const { detectScoringPointCandidates } = require("../apps/api/src/scoring-point-structure");

test("detects common natural scoring point markers", () => {
  const samples = [
    "（1）第一点。（2）第二点。（3）第三点。",
    "①第一点。②第二点。③第三点。",
    "一、第一点。\n二、第二点。\n三、第三点。",
    "1. 第一点。\n2. 第二点。\n3. 第三点。",
  ];
  samples.forEach((sample) => {
    const points = detectScoringPointCandidates(sample);
    assert.equal(points.length, 3);
    assert.match(points[0].description, /第一点/);
    assert.match(points[2].description, /第三点/);
  });
});

test("does not invent scoring points for a continuous answer", () => {
  assert.deepEqual(detectScoringPointCandidates("答案是一个连续段落，其中包含完整的教材表述。"), []);
});
