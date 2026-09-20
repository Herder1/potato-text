const assert = require("node:assert/strict");
const test = require("node:test");

global.Page = () => {};
const {
  applyOptionOrder,
  restoreOriginalOptions,
  shuffleOptionOrder,
} = require("../apps/miniprogram/pages/practice/practice.js");
delete global.Page;

const question = {
  id: "shuffle-question",
  type: "multiple_choice",
  options: [
    { key: "A", text: "甲" },
    { key: "B", text: "乙" },
    { key: "C", text: "丙" },
    { key: "D", text: "丁" },
  ],
  correctAnswer: ["A", "D"],
  correctAnswerText: "A、D",
};

test("option shuffle always changes a multi-option order", () => {
  const order = shuffleOptionOrder(question.options, () => 0.999999);
  assert.deepEqual(order, ["B", "C", "D", "A"]);
});

test("shuffled content keeps sequential labels and remaps correct answers", () => {
  const displayed = applyOptionOrder(question, ["C", "A", "D", "B"]);
  assert.deepEqual(displayed.options.map((option) => option.key), ["A", "B", "C", "D"]);
  assert.deepEqual(displayed.options.map((option) => option.text), ["丙", "甲", "丁", "乙"]);
  assert.deepEqual(displayed.correctAnswer, ["B", "C"]);
  assert.equal(displayed.correctAnswerText, "B、C");
  assert.deepEqual(displayed.optionOrder, ["C", "A", "D", "B"]);
});

test("stored option order is stable and can restore the original question", () => {
  const first = applyOptionOrder(question, ["D", "C", "B", "A"]);
  const second = applyOptionOrder(first, first.optionOrder);
  assert.deepEqual(second.options, first.options);
  assert.deepEqual(second.correctAnswer, first.correctAnswer);

  const restored = restoreOriginalOptions(first);
  assert.deepEqual(restored.options, question.options);
  assert.deepEqual(restored.correctAnswer, question.correctAnswer);
  assert.equal(restored.correctAnswerText, question.correctAnswerText);
});
