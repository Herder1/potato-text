const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryExamStore } = require("../apps/api/src/exam-store");
const { createMemoryPackStore } = require("../apps/api/src/pack-store");

test("exam lifecycle preserves question references and versions", () => {
  const store = createMemoryExamStore([]);
  const exam = store.create({ title: "五科综合模拟卷", kind: "official_mock", questionIds: ["q1", "q2"], durationMinutes: 120, totalScore: 100, freePreviewQuestionCount: 1 });
  assert.equal(exam.status, "draft");
  assert.equal(exam.questionIds.length, 2);
  const published = store.action(exam.id, "publish");
  assert.equal(published.status, "published");
  assert.equal(published.version, 2);
  const offline = store.action(exam.id, "offline");
  assert.equal(offline.status, "offline");
  assert.equal(store.list({ status: "offline" }).exams.length, 1);
});

test("public packs require review and can become featured", () => {
  const store = createMemoryPackStore([]);
  const pack = store.create({ name: "现代汉语易错题", visibility: "public", questionIds: ["q1"], tags: ["现代汉语"] });
  assert.equal(pack.status, "pending_review");
  const published = store.action(pack.id, "publish");
  assert.equal(published.status, "public");
  const featured = store.action(pack.id, "feature");
  assert.equal(featured.status, "featured");
  assert.equal(featured.version, 3);
  assert.throws(() => store.action(store.create({ name: "空题包", visibility: "private", questionIds: [] }).id, "publish"), /pack_questions_required/);
});
