const test = require("node:test");
const assert = require("node:assert/strict");
const {
  countQuestionUnits,
  decorateQuestionGroups,
  groupQuestionUnits,
} = require("../apps/api/src/question-group");

function materialQuestion(id, batchId, order) {
  return {
    id,
    importBatchId: batchId,
    sourceLabel: "模拟试卷",
    groupNumber: "48",
    materialGroupId: "mg48",
    subNumber: String(order),
    groupOrder: order,
    maxScore: 5,
  };
}

test("material subquestions count as one question unit", () => {
  const questions = [1, 2, 3, 4].map((order) => materialQuestion(`q${order}`, "batch-a", order));
  assert.equal(countQuestionUnits(questions), 1);
  const decorated = decorateQuestionGroups(questions);
  assert.equal(decorated[0].groupQuestionCount, 4);
  assert.equal(decorated[0].groupTotalScore, 20);
  assert.deepEqual(decorated[0].groupQuestionIds, ["q1", "q2", "q3", "q4"]);
});

test("same material id from different import batches never merges", () => {
  const questions = [
    materialQuestion("a-1", "batch-a", 1),
    materialQuestion("a-2", "batch-a", 2),
    materialQuestion("b-1", "batch-b", 1),
    materialQuestion("b-2", "batch-b", 2),
  ];
  const units = groupQuestionUnits(questions);
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((unit) => unit.questions.map((question) => question.id)), [
    ["a-1", "a-2"],
    ["b-1", "b-2"],
  ]);
});

test("standalone questions remain standalone units", () => {
  assert.equal(countQuestionUnits([{ id: "single-1" }, { id: "single-2" }]), 2);
});
