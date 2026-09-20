const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DAY_MS,
  classifyWrongQuestions,
  collectWrongQuestionIds,
  createInitialReviewState,
  getDueReviewStates,
  saveReviewState,
  scheduleReview,
} = require("../apps/miniprogram/utils/review-schedule");

test("wrong answers enter today's review queue", () => {
  const now = new Date(2026, 6, 28, 10).getTime();
  const state = createInitialReviewState("q1", false, now);
  const states = saveReviewState({}, state);
  assert.equal(state.stage, 0);
  assert.deepEqual(getDueReviewStates(states, now).map((item) => item.questionId), ["q1"]);
});

test("mastery feedback updates review intervals without duplicate records", () => {
  const now = new Date(2026, 6, 28, 10).getTime();
  const initial = createInitialReviewState("q1", true, now);
  const familiar = scheduleReview(initial, { questionId: "q1", mastery: "familiar", isCorrect: true }, now);
  const states = saveReviewState({ q1: initial }, familiar);
  assert.equal(familiar.stage, 2);
  assert.equal(familiar.nextReviewAt, now + 3 * DAY_MS);
  assert.equal(Object.keys(states).length, 1);

  const fuzzy = scheduleReview(familiar, { questionId: "q1", mastery: "fuzzy", isCorrect: false }, now);
  assert.equal(fuzzy.stage, 0);
  assert.equal(fuzzy.masteryStatus, "unknown");
  assert.equal(fuzzy.nextReviewAt, now);
});

test("wrong question ids are unique and keep recent order", () => {
  const ids = collectWrongQuestionIds([
    { questionId: "q2", isCorrect: false },
    { questionId: "q1", isCorrect: false },
    { questionId: "q2", isCorrect: false },
    { questionId: "q3", isCorrect: true },
  ]);
  assert.deepEqual(ids, ["q2", "q1"]);
});

test("a corrected wrong question leaves the pending bucket but stays in history", () => {
  const attempts = [
    { questionId: "q1", isCorrect: true, createdAt: 20, mastery: "familiar" },
    { questionId: "q1", isCorrect: false, createdAt: 10 },
    { questionId: "q2", isCorrect: false, createdAt: 15 },
  ];
  const groups = classifyWrongQuestions(attempts, {
    q1: { questionId: "q1", lastIsCorrect: true, masteryStatus: "familiar" },
    q2: { questionId: "q2", lastIsCorrect: false, masteryStatus: "unknown" },
  });
  assert.deepEqual(groups.pending, ["q2"]);
  assert.deepEqual(groups.mastered, ["q1"]);
  assert.deepEqual(groups.history.sort(), ["q1", "q2"]);
  assert.deepEqual(collectWrongQuestionIds(attempts, {
    q1: { lastIsCorrect: true, masteryStatus: "familiar" },
    q2: { lastIsCorrect: false, masteryStatus: "unknown" },
  }), ["q2"]);
});
