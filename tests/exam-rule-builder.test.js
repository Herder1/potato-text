const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRuleExam, createExamBlueprint } = require("../apps/miniprogram/utils/exam-rule-builder");

test("rule exam reproduces template type order, scores and optional-question rules", () => {
  const template = [
    { id: "old-a", type: "single_choice", typeLabel: "单选题", maxScore: 2 },
    { id: "old-b", type: "fill_blank", typeLabel: "填空题", maxScore: 2 },
    { id: "old-c", type: "fill_blank", typeLabel: "填空题", maxScore: 2 },
  ];
  const pool = [
    ...template,
    { id: "new-a", type: "single_choice", typeLabel: "单选题", maxScore: 2 },
    { id: "new-b", type: "fill_blank", typeLabel: "填空题", maxScore: 2 },
    { id: "new-c", type: "fill_blank", typeLabel: "填空题", maxScore: 2 },
  ];
  const result = buildRuleExam(template, pool, [{ id: "choose-one", title: "填空 2 选 1", requiredCount: 1, questionIds: ["old-b", "old-c"] }], () => 0.5);

  assert.equal(result.success, true);
  assert.deepEqual(result.questions.map((item) => item.type), template.map((item) => item.type));
  assert.deepEqual(result.questions.map((item) => item.maxScore), [2, 2, 2]);
  assert.deepEqual(result.selectionRules[0].questionIds, result.questions.slice(1).map((item) => item.id));
  assert.equal(result.selectionRules[0].requiredCount, 1);
  assert.deepEqual(createExamBlueprint(template).map((item) => item.summary), ["1 题 × 2 分", "2 题 × 2 分"]);
});

test("rule exam reports exact type and score shortages instead of filling mismatched questions", () => {
  const result = buildRuleExam(
    [{ id: "old", type: "essay", typeLabel: "论述题", maxScore: 20 }],
    [{ id: "wrong-score", type: "essay", typeLabel: "论述题", maxScore: 10 }, { id: "wrong-type", type: "short_answer", maxScore: 20 }],
  );
  assert.equal(result.success, false);
  assert.equal(result.questions.length, 0);
  assert.deepEqual(result.shortages.map((item) => item.summary), ["论述题（20 分）缺 1 题"]);
});
