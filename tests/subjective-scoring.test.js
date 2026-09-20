const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isValidScoreResult,
  scoreFastSubjectiveAnswer,
  scoreSubjectiveAnswer,
} = require("../apps/miniprogram/utils/subjective-scoring");

const question = {
  id: "subjective-1",
  answerMode: "text",
  score: 6,
  referenceAnswer: "普通话以北京语音为标准音，以北方话为基础方言。",
  scoringPoints: [
    { id: "p1", description: "标准音", score: 3, evidenceGroups: [["北京语音"], ["标准音"]] },
    { id: "p2", description: "基础方言", score: 3, evidenceGroups: [["北方话"], ["基础方言"]] },
  ],
  contradictionRules: [{ terms: ["南方话"], message: "基础方言判断错误" }],
};

test("subjective scorer returns all required structured fields", () => {
  const result = scoreSubjectiveAnswer(question, "普通话以北京语音为标准音，以北方话为基础方言。");
  assert.equal(result.totalScore, 6);
  assert.equal(result.hitPoints.length, 2);
  assert.equal(result.missedPoints.length, 0);
  assert.equal(isValidScoreResult(result), true);
});

test("subjective scorer reports partial points, omissions and errors", () => {
  const result = scoreSubjectiveAnswer(question, "普通话以北京语音为标准音，以南方话为基础。");
  assert.equal(result.totalScore, 3);
  assert.equal(result.missedPoints.length, 1);
  assert.deepEqual(result.errors, ["基础方言判断错误"]);
});

test("invalid scoring input fails before credit settlement", () => {
  assert.throws(() => scoreSubjectiveAnswer(question, ""), /invalid_subjective_scoring_input/);
  assert.equal(isValidScoreResult({ totalScore: 4 }), false);
});

test("fast subjective scoring only accepts exact or complete full-score matches", () => {
  const exact = scoreFastSubjectiveAnswer(question, "普通话以北京语音为标准音，以北方话为基础方言。");
  assert.equal(exact.totalScore, 6);
  assert.equal(exact.graderMode, "local_fast_exact_match");

  const completeRules = scoreFastSubjectiveAnswer(question, "北京语音是普通话的标准音，北方话是基础方言。不同标点不影响作答。");
  assert.equal(completeRules.totalScore, 6);
  assert.equal(completeRules.graderMode, "local_fast_full_match");

  assert.equal(scoreFastSubjectiveAnswer(question, "北京语音是标准音。"), null);
});
