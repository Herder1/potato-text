const test = require("node:test");
const assert = require("node:assert/strict");
const {
  COMPREHENSIVE_SUBJECT_ID,
  buildLearningAnalysis,
  buildLearningTrend,
  classifyError,
} = require("../apps/miniprogram/utils/learning-analysis");

const questions = [
  { id: "q-phonetics", subjectId: "modern-chinese", chapterId: "phonetics", stem: "普通话声调" },
  { id: "q-grammar", subjectId: "modern-chinese", chapterId: "grammar", stem: "分析句法结构" },
  { id: "q-tang", subjectId: "ancient-literature", chapterId: "sui-tang", stem: "李白诗歌艺术特色" },
];

test("learning analysis aggregates unit accuracy and keeps empty dimensions explicit", () => {
  const analysis = buildLearningAnalysis({
    questions,
    attempts: [
      { questionId: "q-phonetics", isCorrect: false },
      { questionId: "q-phonetics", isCorrect: true },
      { questionId: "q-grammar", isCorrect: false },
    ],
    scoreHistory: [{
      questionId: "q-grammar",
      result: { missedPoints: [{ description: "说明主谓关系" }], errors: [] },
    }],
    subjectId: "modern-chinese",
  });

  assert.equal(analysis.totalAttempts, 3);
  assert.equal(analysis.totalWrong, 2);
  assert.equal(analysis.dimensions.find((item) => item.id === "phonetics").accuracy, 50);
  assert.equal(analysis.dimensions.find((item) => item.id === "rhetoric").hasData, false);
  assert.equal(analysis.weakUnits[0].id, "grammar");
  assert.equal(analysis.missingPoints[0].label, "说明主谓关系");
  assert.deepEqual(analysis.targetedQuestionIds, ["q-grammar"]);
});

test("literature diagnostics separate subject dimensions and attribute chronology errors", () => {
  const analysis = buildLearningAnalysis({
    questions,
    attempts: [{ questionId: "q-tang", isCorrect: false }],
    subjectId: "ancient-literature",
  });
  assert.equal(analysis.dimensions.find((item) => item.id === "sui-tang").wrongCount, 1);
  assert.equal(classifyError({ stem: "下列作家朝代先后顺序正确的是" }).id, "chronology");
});

test("comprehensive diagnostics aggregate the five Chinese subject abilities", () => {
  const analysis = buildLearningAnalysis({
    questions: [
      ...questions,
      { id: "q-classical", subjectId: "classical-chinese", stem: "解释古今字" },
      { id: "q-modern-literature", subjectId: "modern-literature", stem: "文学革命" },
      { id: "q-contemporary", subjectId: "contemporary-literature", stem: "新时期文学" },
    ],
    attempts: [
      { questionId: "q-phonetics", isCorrect: true },
      { questionId: "q-classical", isCorrect: false },
      { questionId: "q-tang", isCorrect: true },
      { questionId: "q-modern-literature", isCorrect: false },
      { questionId: "q-contemporary", isCorrect: true },
    ],
    subjectId: COMPREHENSIVE_SUBJECT_ID,
  });

  assert.equal(analysis.subjectName, "汉语言学科综合");
  assert.equal(analysis.dimensionType, "subject");
  assert.deepEqual(analysis.dimensions.map((item) => item.label), [
    "现代汉语", "古代汉语", "古代文学史", "当代文学史", "现代文学史",
  ]);
  assert.equal(analysis.dimensions.length, 5);
  assert.equal(analysis.totalAttempts, 5);
  assert.equal(analysis.dimensions.find((item) => item.id === "classical-chinese").accuracy, 0);
  assert.equal(analysis.dimensions.find((item) => item.id === "modern-chinese").accuracy, 100);
});

test("learning trend compares two seven-day periods and keeps unscored work out of accuracy", () => {
  const now = new Date(2026, 8, 2, 12, 0, 0).getTime();
  const at = (year, month, day) => new Date(year, month - 1, day, 12, 0, 0).getTime();
  const trend = buildLearningTrend({
    now,
    questions: [
      { id: "q-modern", subjectId: "modern-chinese", chapterId: "grammar" },
      { id: "q-classical", subjectId: "classical-chinese", chapterId: "grammar" },
    ],
    attempts: [
      { questionId: "q-modern", isCorrect: true, createdAt: at(2026, 8, 20) },
      { questionId: "q-modern", isCorrect: false, createdAt: at(2026, 8, 26) },
      { questionId: "q-modern", isCorrect: true, createdAt: at(2026, 8, 27) },
      { questionId: "q-modern", isCorrect: null, answerStatus: "unscored", response: { isCorrect: false, answerStatus: "unscored" }, createdAt: at(2026, 9, 1) },
      { questionId: "q-modern", isCorrect: false, createdAt: at(2026, 9, 2) },
      { questionId: "q-modern", response: { isCorrect: true }, createdAt: at(2026, 9, 2) },
      { questionId: "q-classical", isCorrect: true, createdAt: at(2026, 8, 26) },
      { questionId: "q-classical", isCorrect: false, createdAt: at(2026, 9, 2) },
      { questionId: "q-modern", isCorrect: true, createdAt: at(2026, 8, 19) },
      { questionId: "q-modern", isCorrect: true, createdAt: at(2026, 9, 3) },
      { questionId: "q-modern", isCorrect: true },
    ],
    subjectId: "modern-chinese",
  });

  assert.equal(trend.periodDays, 7);
  assert.equal(trend.days.length, 7);
  assert.equal(trend.days[0].dateKey, "2026-08-27");
  assert.equal(trend.days.at(-1).dateKey, "2026-09-02");
  assert.equal(trend.previousAttemptCount, 2);
  assert.equal(trend.previousAccuracy, 50);
  assert.equal(trend.currentAttemptCount, 4);
  assert.equal(trend.currentAccuracy, 67);
  assert.equal(trend.attemptDelta, 2);
  assert.equal(trend.accuracyDelta, 17);
  assert.equal(trend.hasData, true);
  assert.deepEqual(trend.days.find((day) => day.dateKey === "2026-09-01"), {
    dateKey: "2026-09-01",
    dateLabel: "9/1",
    attemptCount: 1,
    evaluatedCount: 0,
    correctCount: 0,
    accuracy: null,
    hasAccuracy: false,
  });
  assert.equal(trend.days.find((day) => day.dateKey === "2026-09-02").attemptCount, 2);
});

test("learning analysis exposes a subject-filtered trend with empty accuracy as null", () => {
  const now = new Date(2026, 8, 2, 12, 0, 0).getTime();
  const analysis = buildLearningAnalysis({
    now,
    questions: [
      { id: "q-modern", subjectId: "modern-chinese", chapterId: "grammar" },
      { id: "q-classical", subjectId: "classical-chinese", chapterId: "grammar" },
    ],
    attempts: [
      { questionId: "q-modern", isCorrect: true, createdAt: now },
      { questionId: "q-classical", isCorrect: null, createdAt: now },
    ],
    subjectId: "classical-chinese",
  });

  assert.equal(analysis.trend.currentAttemptCount, 1);
  assert.equal(analysis.trend.currentAccuracy, null);
  assert.equal(analysis.trend.previousAccuracy, null);
  assert.equal(analysis.trend.accuracyDelta, null);
  assert.equal(analysis.trend.days.at(-1).evaluatedCount, 0);
});

test("learning trend can cover a longer period without changing the comparison rule", () => {
  const now = new Date(2026, 8, 30, 12, 0, 0).getTime();
  const at = (month, day) => new Date(2026, month - 1, day, 12, 0, 0).getTime();
  const attempts = [
    { questionId: "q-modern", isCorrect: true, createdAt: at(8, 5) },
    { questionId: "q-modern", isCorrect: false, createdAt: at(8, 10) },
    { questionId: "q-modern", isCorrect: true, createdAt: at(9, 1) },
    { questionId: "q-modern", isCorrect: true, createdAt: at(9, 20) },
    { questionId: "q-modern", isCorrect: false, createdAt: at(9, 29) },
  ];
  const questions = [{ id: "q-modern", subjectId: "modern-chinese", chapterId: "grammar" }];

  const trend = buildLearningTrend({ now, questions, attempts, subjectId: "modern-chinese", periodDays: 30 });

  assert.equal(trend.periodDays, 30);
  assert.equal(trend.days.length, 30);
  assert.equal(trend.days.at(-1).dateKey, "2026-09-30");
  assert.equal(trend.days[0].dateKey, "2026-09-01");
  assert.equal(trend.currentAttemptCount, 3, "only the last 30 days count as the current period");
  assert.equal(trend.previousAttemptCount, 2, "the 30 days before that form the comparison period");
  assert.equal(trend.currentAccuracy, 67);
  assert.equal(trend.previousAccuracy, 50);
  assert.equal(trend.hasData, true);

  const twoWeeks = buildLearningTrend({ now, questions, attempts, subjectId: "modern-chinese", periodDays: 14 });
  assert.equal(twoWeeks.days.length, 14);
  assert.equal(twoWeeks.periodDays, 14);
  assert.equal(twoWeeks.currentAttemptCount, 2, "a 14 day window only reaches back to 9/17");
  assert.equal(twoWeeks.previousAttemptCount, 0, "14 days back reaches before the first attempts");

  const clamped = buildLearningTrend({ now, questions, attempts, subjectId: "modern-chinese", periodDays: 500 });
  assert.equal(clamped.periodDays, 90, "the period is capped at 90 days");
  assert.equal(clamped.days.length, 90);
});

test("learning analysis passes the requested trend period through both subject modes", () => {
  const now = new Date(2026, 8, 30, 12, 0, 0).getTime();
  const attempts = [{ questionId: "q-modern", isCorrect: true, createdAt: now }];
  const questions = [{ id: "q-modern", subjectId: "modern-chinese", chapterId: "grammar" }];

  const subjectAnalysis = buildLearningAnalysis({ now, questions, attempts, subjectId: "modern-chinese", trendPeriodDays: 30 });
  assert.equal(subjectAnalysis.trend.periodDays, 30);
  assert.equal(subjectAnalysis.trend.days.length, 30);

  const comprehensive = buildLearningAnalysis({ now, questions, attempts, trendPeriodDays: 7 });
  assert.equal(comprehensive.trend.periodDays, 7);
  assert.equal(comprehensive.trend.days.length, 7);
});
