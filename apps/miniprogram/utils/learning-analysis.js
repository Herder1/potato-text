const SUBJECT_DIMENSIONS = {
  "modern-chinese": {
    name: "现代汉语",
    dimensions: [
      { id: "phonetics", label: "语音", aliases: ["phonetics", "语音", "声母", "韵母", "声调", "音节"] },
      { id: "characters", label: "文字", aliases: ["characters", "文字", "汉字"] },
      { id: "vocabulary", label: "词汇", aliases: ["vocabulary", "词汇", "词义", "合成词"] },
      { id: "grammar", label: "语法", aliases: ["grammar", "语法", "句法", "词类", "短语"] },
      { id: "rhetoric", label: "修辞", aliases: ["rhetoric", "修辞", "辞格"] },
    ],
  },
  "classical-chinese": {
    name: "古代汉语",
    dimensions: [
      { id: "characters", label: "文字", aliases: ["文字", "古文字", "通假"] },
      { id: "vocabulary", label: "词汇", aliases: ["词汇", "词义", "古今字"] },
      { id: "grammar", label: "语法", aliases: ["语法", "句法", "虚词"] },
      { id: "phonology", label: "音韵", aliases: ["音韵", "韵书", "反切"] },
      { id: "annotation", label: "古注", aliases: ["古注", "训诂", "注疏"] },
    ],
  },
  "ancient-literature": {
    name: "中国古代文学",
    dimensions: [
      { id: "pre-qin", label: "先秦", aliases: ["先秦", "诗经", "楚辞", "诸子"] },
      { id: "qin-han", label: "秦汉", aliases: ["秦汉", "汉代", "史记", "汉赋"] },
      { id: "wei-jin", label: "魏晋", aliases: ["魏晋", "南北朝", "建安", "陶渊明"] },
      { id: "sui-tang", label: "隋唐", aliases: ["隋唐", "唐代", "唐诗", "李白", "杜甫"] },
      { id: "song-yuan", label: "宋元", aliases: ["宋元", "宋代", "元代", "宋词", "元曲"] },
      { id: "ming-qing", label: "明清", aliases: ["明清", "明代", "清代", "红楼梦"] },
    ],
  },
  "modern-literature": {
    name: "中国现代文学",
    dimensions: [
      { id: "1917-1927", label: "1917-1927", aliases: ["1917", "1927", "五四", "文学革命"] },
      { id: "1928-1937", label: "1928-1937", aliases: ["1928", "1937", "左翼"] },
      { id: "1937-1949", label: "1937-1949", aliases: ["抗战", "解放区", "国统区", "1949"] },
    ],
  },
  "contemporary-literature": {
    name: "中国当代文学",
    dimensions: [
      { id: "1949-1976", label: "1949-1976", aliases: ["十七年", "文革", "1949", "1976"] },
      { id: "1977-1989", label: "1977-1989", aliases: ["新时期", "伤痕", "反思", "寻根"] },
      { id: "1990-2000", label: "1990年代", aliases: ["1990", "九十年代"] },
      { id: "new-century", label: "新世纪", aliases: ["新世纪", "2000"] },
    ],
  },
};

const COMPREHENSIVE_SUBJECT_ID = "chinese-comprehensive";
const TREND_PERIOD_DAYS = 7;
const COMPREHENSIVE_DIMENSIONS = [
  { id: "modern-chinese", label: "现代汉语" },
  { id: "classical-chinese", label: "古代汉语" },
  { id: "ancient-literature", label: "古代文学史" },
  { id: "contemporary-literature", label: "当代文学史" },
  { id: "modern-literature", label: "现代文学史" },
];

function questionText(question = {}) {
  return [
    question.id,
    question.chapterId,
    question.sectionId,
    question.breadcrumb,
    question.knowledgePoint,
    question.stem,
  ].filter(Boolean).join(" ").toLowerCase();
}

function inferSubjectId(question = {}, attempt = {}) {
  if (attempt.subjectId && SUBJECT_DIMENSIONS[attempt.subjectId]) return attempt.subjectId;
  if (question.subjectId && SUBJECT_DIMENSIONS[question.subjectId]) return question.subjectId;
  const text = questionText(question);
  if (text.includes("modern-chinese") || text.includes("现代汉语")) return "modern-chinese";
  if (text.includes("classical-chinese") || text.includes("古代汉语")) return "classical-chinese";
  if (text.includes("ancient-literature") || text.includes("古代文学")) return "ancient-literature";
  if (text.includes("contemporary-literature") || text.includes("当代文学")) return "contemporary-literature";
  if (text.includes("modern-literature") || text.includes("现代文学")) return "modern-literature";
  return "modern-chinese";
}

function inferDimension(question = {}, attempt = {}, subjectId = "modern-chinese") {
  const definition = SUBJECT_DIMENSIONS[subjectId] || SUBJECT_DIMENSIONS["modern-chinese"];
  const explicitId = attempt.unitId || attempt.chapterId || question.chapterId || "";
  const explicit = definition.dimensions.find((dimension) => dimension.id === explicitId);
  if (explicit) return explicit;
  const text = questionText({ ...question, chapterId: explicitId });
  return definition.dimensions.find((dimension) => (
    dimension.aliases.some((alias) => text.includes(String(alias).toLowerCase()))
  )) || null;
}

function classifyError(question = {}, result = null) {
  const resultText = result ? JSON.stringify({
    missedPoints: result.missedPoints,
    errors: result.errors,
    referenceComparison: result.referenceComparison,
  }) : "";
  const text = `${questionText(question)} ${resultText}`;
  if (/(朝代|年代|时期|先后|时序|世纪|年间|先秦|秦汉|魏晋|隋唐|宋元|明清)/.test(text)) {
    return { id: "chronology", label: "时序记混", advice: "先建立时间轴，再做同一时期作家作品的对照题。" };
  }
  if (/(作品.{0,12}作者|作者.{0,12}作品|篇目.{0,12}作家|归属|张冠李戴|代表作)/.test(text)) {
    return { id: "work", label: "作品张冠李戴", advice: "用“作者—作品—文体”三列卡片进行辨析。" };
  }
  if (/(字[、，]|号[、，]|本名|姓名|人名|作者是谁|作家是谁)/.test(text)) {
    return { id: "person", label: "人名记错", advice: "把姓名、字、号与代表作绑定成一组记忆卡。" };
  }
  return { id: "concept", label: "概念边界不清", advice: "回到定义关键词，并用相近概念对比巩固。" };
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function attemptCorrectness(attempt = {}) {
  if (Object.prototype.hasOwnProperty.call(attempt, "isCorrect")) {
    return typeof attempt.isCorrect === "boolean" ? attempt.isCorrect : null;
  }
  if (attempt.answerStatus === "unscored" || (attempt.response && attempt.response.answerStatus === "unscored")) return null;
  if (attempt.response && typeof attempt.response.isCorrect === "boolean") return attempt.response.isCorrect;
  return null;
}

function summarizeTrendPeriod(days) {
  const totals = days.reduce((summary, day) => ({
    attemptCount: summary.attemptCount + day.attemptCount,
    evaluatedCount: summary.evaluatedCount + day.evaluatedCount,
    correctCount: summary.correctCount + day.correctCount,
  }), { attemptCount: 0, evaluatedCount: 0, correctCount: 0 });
  return {
    ...totals,
    accuracy: totals.evaluatedCount
      ? Math.round((totals.correctCount / totals.evaluatedCount) * 100)
      : null,
  };
}

function buildLearningTrend({ attempts = [], questions = [], subjectId = "modern-chinese", now = Date.now(), periodDays = TREND_PERIOD_DAYS } = {}) {
  const currentDate = new Date(Number(now));
  const safeDate = Number.isFinite(currentDate.getTime()) ? currentDate : new Date();
  const today = new Date(safeDate.getFullYear(), safeDate.getMonth(), safeDate.getDate());
  const questionMap = new Map((Array.isArray(questions) ? questions : []).map((question) => [question.id, question]));
  const period = Math.max(1, Math.min(90, Math.floor(Number(periodDays) || TREND_PERIOD_DAYS)));
  const totalDays = period * 2;
  const days = Array.from({ length: totalDays }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + index - totalDays + 1);
    return {
      dateKey: localDateKey(date.getTime()),
      dateLabel: `${date.getMonth() + 1}/${date.getDate()}`,
      attemptCount: 0,
      evaluatedCount: 0,
      correctCount: 0,
      accuracy: null,
      hasAccuracy: false,
    };
  });
  const dayMap = new Map(days.map((day) => [day.dateKey, day]));

  (Array.isArray(attempts) ? attempts : []).forEach((attempt) => {
    if (!attempt || !attempt.questionId) return;
    const timestamp = Number(attempt.createdAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    const day = dayMap.get(localDateKey(timestamp));
    if (!day) return;
    const question = questionMap.get(attempt.questionId) || attempt.question || {};
    if (subjectId !== COMPREHENSIVE_SUBJECT_ID && inferSubjectId(question, attempt) !== subjectId) return;
    day.attemptCount += 1;
    const correctness = attemptCorrectness(attempt);
    if (correctness === null) return;
    day.evaluatedCount += 1;
    if (correctness) day.correctCount += 1;
  });

  days.forEach((day) => {
    day.hasAccuracy = day.evaluatedCount > 0;
    day.accuracy = day.hasAccuracy ? Math.round((day.correctCount / day.evaluatedCount) * 100) : null;
  });
  const previous = summarizeTrendPeriod(days.slice(0, period));
  const current = summarizeTrendPeriod(days.slice(period));

  return {
    days: days.slice(period),
    periodDays: period,
    currentAccuracy: current.accuracy,
    currentAttemptCount: current.attemptCount,
    previousAccuracy: previous.accuracy,
    previousAttemptCount: previous.attemptCount,
    accuracyDelta: current.accuracy === null || previous.accuracy === null
      ? null
      : current.accuracy - previous.accuracy,
    attemptDelta: current.attemptCount - previous.attemptCount,
    hasData: current.attemptCount + previous.attemptCount > 0,
  };
}

function buildComprehensiveLearningAnalysis({ attempts = [], questions = [], scoreHistory = [], now = Date.now(), trendPeriodDays = TREND_PERIOD_DAYS } = {}) {
  const questionMap = new Map((Array.isArray(questions) ? questions : []).map((question) => [question.id, question]));
  const resultMap = new Map();
  (Array.isArray(scoreHistory) ? scoreHistory : []).forEach((entry) => {
    if (entry && entry.questionId && !resultMap.has(entry.questionId)) resultMap.set(entry.questionId, entry.result || null);
  });
  const buckets = new Map(COMPREHENSIVE_DIMENSIONS.map((dimension) => [dimension.id, {
    ...dimension,
    attemptCount: 0,
    correctCount: 0,
    wrongCount: 0,
    wrongQuestionIds: [],
  }]));
  const attributions = new Map();

  (Array.isArray(attempts) ? attempts : []).forEach((attempt) => {
    const question = questionMap.get(attempt.questionId) || attempt.question || {};
    const bucket = buckets.get(inferSubjectId(question, attempt));
    if (!bucket) return;
    bucket.attemptCount += 1;
    if (attempt.isCorrect) bucket.correctCount += 1;
    else {
      bucket.wrongCount += 1;
      if (attempt.questionId && !bucket.wrongQuestionIds.includes(attempt.questionId)) {
        bucket.wrongQuestionIds.push(attempt.questionId);
      }
      const attribution = classifyError(question, resultMap.get(attempt.questionId));
      const current = attributions.get(attribution.id) || { ...attribution, count: 0 };
      current.count += 1;
      attributions.set(attribution.id, current);
    }
  });

  const dimensions = Array.from(buckets.values()).map((bucket) => ({
    ...bucket,
    accuracy: bucket.attemptCount ? Math.round((bucket.correctCount / bucket.attemptCount) * 100) : 0,
    errorRate: bucket.attemptCount ? Math.round((bucket.wrongCount / bucket.attemptCount) * 100) : 0,
    hasData: bucket.attemptCount > 0,
  }));
  const weakUnits = dimensions
    .filter((item) => item.hasData && item.wrongCount > 0)
    .sort((left, right) => right.errorRate - left.errorRate || right.wrongCount - left.wrongCount);
  const missedPointMap = new Map();
  (Array.isArray(scoreHistory) ? scoreHistory : []).forEach((entry) => {
    const missedPoints = entry && entry.result && Array.isArray(entry.result.missedPoints)
      ? entry.result.missedPoints : [];
    missedPoints.forEach((point) => {
      const label = String(point.description || point.id || "未命名得分点");
      const current = missedPointMap.get(label) || { label, count: 0, questionId: entry.questionId };
      current.count += 1;
      missedPointMap.set(label, current);
    });
  });
  const missingPoints = Array.from(missedPointMap.values()).sort((a, b) => b.count - a.count).slice(0, 5);
  const errorAttributions = Array.from(attributions.values()).sort((a, b) => b.count - a.count);
  const totalAttempts = dimensions.reduce((sum, item) => sum + item.attemptCount, 0);
  const totalWrong = dimensions.reduce((sum, item) => sum + item.wrongCount, 0);
  const weakest = weakUnits[0] || null;
  const primaryAttribution = errorAttributions[0] || null;
  const summary = totalAttempts
    ? (weakest
      ? `近期薄弱学科集中在${weakest.label}，${weakest.attemptCount}次作答中错${weakest.wrongCount}次。`
      : "五个学科近期表现稳定，可继续扩大训练范围。")
    : "完成汉语言学科综合练习后，这里会生成五科能力诊断。";
  const recommendation = primaryAttribution
    ? `${primaryAttribution.label}出现最多。${primaryAttribution.advice}`
    : (weakest ? `建议先复习${weakest.label}中的高频错题，再做一组同知识点变式题。` : "先完成五个学科中的一组练习，建立综合能力基线。");

  return {
    subjectId: COMPREHENSIVE_SUBJECT_ID,
    subjectName: "汉语言学科综合",
    dimensionType: "subject",
    dimensionLabel: "学科",
    dimensions,
    weakUnits,
    missingPoints,
    errorAttributions,
    totalAttempts,
    totalWrong,
    summary,
    recommendation,
    targetedQuestionIds: weakest ? weakest.wrongQuestionIds : [],
    trend: buildLearningTrend({ attempts, questions, subjectId: COMPREHENSIVE_SUBJECT_ID, now, periodDays: trendPeriodDays }),
  };
}

function buildLearningAnalysis({ attempts = [], questions = [], scoreHistory = [], subjectId = "modern-chinese", now = Date.now(), trendPeriodDays = TREND_PERIOD_DAYS } = {}) {
  if (subjectId === COMPREHENSIVE_SUBJECT_ID) {
    return buildComprehensiveLearningAnalysis({ attempts, questions, scoreHistory, now, trendPeriodDays });
  }
  const definition = SUBJECT_DIMENSIONS[subjectId] || SUBJECT_DIMENSIONS["modern-chinese"];
  const questionMap = new Map((Array.isArray(questions) ? questions : []).map((question) => [question.id, question]));
  const resultMap = new Map();
  (Array.isArray(scoreHistory) ? scoreHistory : []).forEach((entry) => {
    if (entry && entry.questionId && !resultMap.has(entry.questionId)) resultMap.set(entry.questionId, entry.result || null);
  });
  const buckets = new Map(definition.dimensions.map((dimension) => [dimension.id, {
    ...dimension,
    attemptCount: 0,
    correctCount: 0,
    wrongCount: 0,
    wrongQuestionIds: [],
  }]));
  const attributions = new Map();

  (Array.isArray(attempts) ? attempts : []).forEach((attempt) => {
    const question = questionMap.get(attempt.questionId) || attempt.question || {};
    if (inferSubjectId(question, attempt) !== subjectId) return;
    const dimension = inferDimension(question, attempt, subjectId);
    if (!dimension || !buckets.has(dimension.id)) return;
    const bucket = buckets.get(dimension.id);
    bucket.attemptCount += 1;
    if (attempt.isCorrect) bucket.correctCount += 1;
    else {
      bucket.wrongCount += 1;
      if (attempt.questionId && !bucket.wrongQuestionIds.includes(attempt.questionId)) {
        bucket.wrongQuestionIds.push(attempt.questionId);
      }
      const attribution = classifyError(question, resultMap.get(attempt.questionId));
      const current = attributions.get(attribution.id) || { ...attribution, count: 0 };
      current.count += 1;
      attributions.set(attribution.id, current);
    }
  });

  const dimensions = Array.from(buckets.values()).map((bucket) => ({
    ...bucket,
    accuracy: bucket.attemptCount ? Math.round((bucket.correctCount / bucket.attemptCount) * 100) : 0,
    errorRate: bucket.attemptCount ? Math.round((bucket.wrongCount / bucket.attemptCount) * 100) : 0,
    hasData: bucket.attemptCount > 0,
  }));
  const attemptedDimensions = dimensions.filter((item) => item.hasData);
  const weakUnits = attemptedDimensions
    .filter((item) => item.wrongCount > 0)
    .sort((left, right) => right.errorRate - left.errorRate || right.wrongCount - left.wrongCount);
  const missedPointMap = new Map();
  (Array.isArray(scoreHistory) ? scoreHistory : []).forEach((entry) => {
    const question = questionMap.get(entry.questionId) || {};
    if (inferSubjectId(question, {}) !== subjectId) return;
    const missedPoints = entry && entry.result && Array.isArray(entry.result.missedPoints)
      ? entry.result.missedPoints : [];
    missedPoints.forEach((point) => {
      const label = String(point.description || point.id || "未命名得分点");
      const current = missedPointMap.get(label) || { label, count: 0, questionId: entry.questionId };
      current.count += 1;
      missedPointMap.set(label, current);
    });
  });
  const missingPoints = Array.from(missedPointMap.values()).sort((a, b) => b.count - a.count).slice(0, 5);
  const errorAttributions = Array.from(attributions.values()).sort((a, b) => b.count - a.count);
  const totalAttempts = dimensions.reduce((sum, item) => sum + item.attemptCount, 0);
  const totalWrong = dimensions.reduce((sum, item) => sum + item.wrongCount, 0);
  const weakest = weakUnits[0] || null;
  const primaryAttribution = errorAttributions[0] || null;
  const summary = totalAttempts
    ? (weakest
      ? `近期薄弱项集中在${weakest.label}，${weakest.attemptCount}次作答中错${weakest.wrongCount}次。`
      : "近期已练单元表现稳定，可继续扩大训练范围。")
    : `完成${definition.name}练习后，这里会生成单元能力诊断。`;
  const recommendation = primaryAttribution
    ? `${primaryAttribution.label}出现最多。${primaryAttribution.advice}`
    : (weakest ? `建议先复习${weakest.label}中的高频错题，再做一组同知识点变式题。` : "先完成一组章节练习，建立首份能力基线。");

  return {
    subjectId,
    subjectName: definition.name,
    dimensionType: "unit",
    dimensionLabel: "单元",
    dimensions,
    weakUnits,
    missingPoints,
    errorAttributions,
    totalAttempts,
    totalWrong,
    summary,
    recommendation,
    targetedQuestionIds: weakest ? weakest.wrongQuestionIds : [],
    trend: buildLearningTrend({ attempts, questions, subjectId, now, periodDays: trendPeriodDays }),
  };
}

module.exports = {
  COMPREHENSIVE_DIMENSIONS,
  COMPREHENSIVE_SUBJECT_ID,
  SUBJECT_DIMENSIONS,
  buildComprehensiveLearningAnalysis,
  buildLearningAnalysis,
  buildLearningTrend,
  classifyError,
  inferDimension,
  inferSubjectId,
};
