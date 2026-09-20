const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildScoringMessages,
  normalizeModelScore,
} = require("../apps/api/src/ai-provider");

const question = {
  id: "compact-score-question",
  stem: "简述普通话的语音和方言标准。",
  answerMode: "text",
  score: 6,
  referenceAnswer: "以北京语音为标准音，以北方话为基础方言。",
  scoringPoints: [
    { id: "pronunciation", description: "指出标准音", score: 3, textbookPage: "12", pageBasis: "教材印刷页", sourceNote: "《现代汉语》" },
    { id: "dialect", description: "指出基础方言", score: 3, textbookPage: "13", pageBasis: "教材印刷页", sourceNote: "《现代汉语》" },
  ],
};

const metadata = { requestId: "score-request", providerId: "provider", model: "model" };

test("compact model scoring restores canonical scoring-point details", () => {
  const result = normalizeModelScore({
    points: [
      { id: "pronunciation", awardedScore: 3, evidence: ["北京语音"], missingHints: [] },
      { id: "dialect", awardedScore: 1.5, evidence: ["北方话"], missingHints: ["基础方言"] },
    ],
    errors: [],
    confidence: 0.9,
  }, question, metadata);

  assert.equal(result.totalScore, 4.5);
  assert.equal(result.hitPoints[0].description, "指出标准音");
  assert.equal(result.hitPoints[0].textbookPage, "12");
  assert.equal(result.hitPoints[1].status, "partial");
  assert.equal(result.missedPoints[0].lostScore, 1.5);
  assert.equal(result.referenceAnswer, question.referenceAnswer);
  assert.match(result.referenceComparison, /仍需补充/);
  assert.equal(result.expressionSuggestions.length, 1);
});

test("legacy scoring remains compatible but canonical details win", () => {
  const result = normalizeModelScore({
    totalScore: 3,
    hitPoints: [{ id: "pronunciation", description: "模型改写", awardedScore: 3, maxScore: 3, evidence: ["北京语音"], status: "hit" }],
    missedPoints: [{ id: "dialect", description: "模型改写", lostScore: 3, maxScore: 3, missingHints: ["北方话"] }],
    errors: [],
    expressionSuggestions: [],
    referenceComparison: "遗漏基础方言。",
    confidence: 0.8,
  }, question, metadata);

  assert.equal(result.totalScore, 3);
  assert.equal(result.hitPoints[0].description, "指出标准音");
  assert.equal(result.missedPoints[0].description, "指出基础方言");
});

test("unknown model scoring-point ids are rejected", () => {
  assert.throws(() => normalizeModelScore({
    points: [{ id: "invented", awardedScore: 6, evidence: [], missingHints: [] }],
    errors: [],
    suggestions: [],
    comparison: "",
    confidence: 0.9,
  }, question, metadata), /provider_output_format_error/);
});

test("scoring prompt requests only compact point decisions", () => {
  const messages = buildScoringMessages(question, "北京语音、北方话");
  assert.match(messages[0].content, /只输出有得分的得分点/);
  assert.match(messages[1].content, /"points"/);
  assert.doesNotMatch(messages[1].content, /"hitPoints"/);
  assert.doesNotMatch(messages[1].content, /"suggestions"/);
  assert.doesNotMatch(messages[1].content, /"comparison"/);
});
