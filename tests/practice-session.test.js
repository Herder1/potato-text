const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAnswerCard,
  buildQuestionQueue,
  calculateExamResult,
  countQuestionUnits,
  evaluateAnswer,
  evaluateQuestionAnswer,
} = require("../apps/miniprogram/utils/practice-session");

const questions = [
  { id: "q1", score: 2, correctAnswer: ["A"] },
  { id: "q2", score: 3, correctAnswer: ["B", "C"] },
  { id: "q3", score: 5, correctAnswer: ["D"] },
];

test("practice queue adds stable numbering and supports random order", () => {
  const sequential = buildQuestionQueue(questions, "sequential");
  assert.deepEqual(sequential.map((question) => question.id), ["q1", "q2", "q3"]);
  assert.deepEqual(sequential.map((question) => question.number), [1, 2, 3]);
  assert.equal(sequential[2].progressPercent, 100);

  const random = buildQuestionQueue(questions, "random", () => 0);
  assert.notDeepEqual(random.map((question) => question.id), ["q1", "q2", "q3"]);
  assert.deepEqual(random.map((question) => question.number), [1, 2, 3]);
});

test("random practice shuffles material groups but keeps subquestions together", () => {
  const grouped = [
    { id: "single", correctAnswer: ["A"] },
    { id: "group-1", questionGroupId: "group-a", groupOrder: 1, correctAnswer: ["A"] },
    { id: "group-2", questionGroupId: "group-a", groupOrder: 2, correctAnswer: ["A"] },
    { id: "other", correctAnswer: ["A"] },
  ];
  const queue = buildQuestionQueue(grouped, "random", () => 0);
  const firstGroupIndex = queue.findIndex((question) => question.id === "group-1");
  assert.equal(queue[firstGroupIndex + 1].id, "group-2");
  assert.equal(queue[firstGroupIndex].questionUnitNumber, queue[firstGroupIndex + 1].questionUnitNumber);
  assert.deepEqual(queue.slice(firstGroupIndex, firstGroupIndex + 2).map((question) => question.groupItemNumber), [1, 2]);
  assert.equal(countQuestionUnits(grouped), 3);
});

test("answer evaluation handles single and multiple selections", () => {
  assert.equal(evaluateAnswer(questions[0], "A"), true);
  assert.equal(evaluateAnswer(questions[0], "B"), false);
  assert.equal(evaluateAnswer(questions[1], ["C", "B"]), true);
  assert.equal(evaluateAnswer(questions[1], ["B"]), false);
  assert.equal(evaluateAnswer({ id: "subjective", answerMode: "text" }, "一段主观题答案"), false);
});

test("answer card and exam result reflect saved responses", () => {
  const queue = buildQuestionQueue(questions);
  const responses = {
    q1: { selected: "A", submitted: true, isCorrect: true },
    q2: { selected: ["B", "C"] },
  };
  const card = buildAnswerCard(queue, responses, 1);
  assert.deepEqual(card.map((item) => item.status), ["correct", "answered", "empty"]);
  assert.equal(card[1].current, true);

  const result = calculateExamResult(queue, responses);
  assert.equal(result.answeredCount, 2);
  assert.equal(result.correctCount, 2);
  assert.equal(result.score, 5);
  assert.equal(result.totalScore, 10);
  assert.equal(result.responses.q3.isCorrect, false);
});

test("submitted subjective answers stay neutral until AI scoring finishes", () => {
  const queue = buildQuestionQueue([{ id: "subjective", answerMode: "text", score: 10, correctAnswer: [] }]);
  const pending = buildAnswerCard(queue, {
    subjective: { subjectiveAnswer: "这是已经提交但尚未评分的答案。", submitted: true },
  }, 0);
  assert.equal(pending[0].status, "answered");
  const scored = buildAnswerCard(queue, {
    subjective: { subjectiveAnswer: "这是已经评分的答案。", submitted: true, isCorrect: false, subjectiveScoreResult: { totalScore: 3 } },
  }, 0);
  assert.equal(scored[0].status, "wrong");
});

test("double-choice partial scoring awards one correct option only", () => {
  const question = {
    id: "double-choice",
    type: "multiple_choice",
    score: 3,
    correctAnswer: ["A", "C"],
    scoringPolicy: {
      mode: "double_choice_partial",
      oneCorrectScore: 1,
      allCorrectScore: 3,
      extraOptionScore: 0,
      emptyScore: 0,
    },
  };
  assert.deepEqual(evaluateQuestionAnswer(question, ["A"]), { isCorrect: false, awardedScore: 1, maxScore: 3, status: "partial" });
  assert.deepEqual(evaluateQuestionAnswer(question, ["A", "C"]), { isCorrect: true, awardedScore: 3, maxScore: 3, status: "correct" });
  assert.deepEqual(evaluateQuestionAnswer(question, ["A", "B"]), { isCorrect: false, awardedScore: 0, maxScore: 3, status: "wrong" });
  assert.deepEqual(evaluateQuestionAnswer(question, []), { isCorrect: false, awardedScore: 0, maxScore: 3, status: "empty" });
  const result = calculateExamResult([question], { "double-choice": { selected: ["A"] } });
  assert.equal(result.score, 1);
  assert.equal(result.partialCount, 1);
});

test("double-choice no-partial scoring gives zero for one correct option", () => {
  const question = {
    id: "double-choice-no-partial",
    type: "multiple_choice",
    score: 3,
    correctAnswer: ["A", "C"],
    scoringPolicy: {
      mode: "double_choice_no_partial",
      oneCorrectScore: 0,
      allCorrectScore: 3,
      extraOptionScore: 0,
      emptyScore: 0,
    },
  };
  assert.deepEqual(evaluateQuestionAnswer(question, ["A"]), { isCorrect: false, awardedScore: 0, maxScore: 3, status: "wrong" });
  assert.deepEqual(evaluateQuestionAnswer(question, ["A", "C"]), { isCorrect: true, awardedScore: 3, maxScore: 3, status: "correct" });
  assert.deepEqual(evaluateQuestionAnswer(question, ["A", "B"]), { isCorrect: false, awardedScore: 0, maxScore: 3, status: "wrong" });
});

test("exam selection rules count only the first answered required questions", () => {
  const queue = buildQuestionQueue([
    { id: "fill-1", score: 2, correctAnswer: ["A"] },
    { id: "fill-2", score: 2, correctAnswer: ["A"] },
    { id: "fill-3", score: 2, correctAnswer: ["A"] },
    { id: "fill-4", score: 2, correctAnswer: ["A"] },
  ]);
  const responses = {
    "fill-1": { selected: "A", answeredAt: 300 },
    "fill-2": { selected: "A", answeredAt: 100 },
    "fill-3": { selected: "A", answeredAt: 200 },
    "fill-4": { selected: "A", answeredAt: 400 },
  };
  const result = calculateExamResult(queue, responses, [{
    id: "choose-two",
    requiredCount: 2,
    questionIds: queue.map((question) => question.id),
  }]);
  assert.equal(result.answeredCount, 4);
  assert.equal(result.score, 4);
  assert.equal(result.totalScore, 4);
  assert.equal(result.responses["fill-2"].counted, true);
  assert.equal(result.responses["fill-3"].counted, true);
  assert.equal(result.responses["fill-1"].counted, false);
});

test("declared exam total replaces display total while preserving calculated total", () => {
  const queue = buildQuestionQueue(questions);
  const result = calculateExamResult(queue, {}, [], 200);
  assert.equal(result.calculatedTotalScore, 10);
  assert.equal(result.totalScore, 200);
});
