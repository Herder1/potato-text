const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];

function normalizeReviewStates(states) {
  if (!states || Array.isArray(states) || typeof states !== "object") return {};
  return { ...states };
}

function endOfDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function createInitialReviewState(questionId, isCorrect, now = Date.now()) {
  const stage = isCorrect ? 1 : 0;
  return {
    questionId,
    stage,
    masteryStatus: isCorrect ? "fuzzy" : "unknown",
    nextReviewAt: isCorrect ? now + DAY_MS : now,
    lastReviewAt: now,
    lastIsCorrect: isCorrect === true,
    removedManually: false,
  };
}

function scheduleReview(existingState, result, now = Date.now()) {
  const isCorrect = result.isCorrect === true;
  const mastery = isCorrect ? result.mastery : "unknown";
  const currentStage = Math.max(0, Number(existingState && existingState.stage) || 0);
  let stage;
  if (!isCorrect) {
    stage = 0;
  } else if (mastery === "familiar") {
    stage = Math.min(REVIEW_INTERVAL_DAYS.length - 1, Math.max(1, currentStage + 1));
  } else {
    stage = 1;
  }
  return {
    ...(existingState || {}),
    questionId: result.questionId,
    stage,
    masteryStatus: mastery,
    nextReviewAt: now + REVIEW_INTERVAL_DAYS[stage] * DAY_MS,
    lastReviewAt: now,
    lastIsCorrect: isCorrect,
    removedManually: false,
  };
}

function isMasteredReviewState(state) {
  return !!state && state.lastIsCorrect === true && state.masteryStatus === "familiar";
}

function saveReviewState(states, state) {
  return {
    ...normalizeReviewStates(states),
    [state.questionId]: state,
  };
}

function getDueReviewStates(states, now = Date.now()) {
  const deadline = endOfDay(now);
  return Object.values(normalizeReviewStates(states))
    .filter((state) => !state.removedManually && Number(state.nextReviewAt) <= deadline)
    .sort((left, right) => Number(left.nextReviewAt) - Number(right.nextReviewAt));
}

function classifyWrongQuestions(attempts, states = {}) {
  const orderedAttempts = [...(Array.isArray(attempts) ? attempts : [])]
    .filter((attempt) => attempt && attempt.questionId)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
  const latestAttempts = new Map();
  const history = [];
  const seenWrong = new Set();
  orderedAttempts.forEach((attempt) => {
    if (!latestAttempts.has(attempt.questionId)) latestAttempts.set(attempt.questionId, attempt);
    if (attempt.isCorrect === false && !seenWrong.has(attempt.questionId)) {
      seenWrong.add(attempt.questionId);
      history.push(attempt.questionId);
    }
  });

  const result = { pending: [], corrected: [], reinforcing: [], mastered: [], history };
  history.forEach((questionId) => {
    const state = states[questionId];
    const latest = latestAttempts.get(questionId);
    const latestIsCorrect = latest && latest.isCorrect === true;
    const resolved = (state && state.lastIsCorrect === true) || latestIsCorrect;
    const mastery = (state && state.masteryStatus)
      || (latest && latest.response && latest.response.mastery)
      || (latest && latest.mastery)
      || "";
    if (!resolved || mastery === "unknown") result.pending.push(questionId);
    else if (mastery === "familiar") result.mastered.push(questionId);
    else if (mastery === "fuzzy") result.reinforcing.push(questionId);
    else result.corrected.push(questionId);
  });
  return result;
}

function collectWrongQuestionIds(attempts, states = {}) {
  return classifyWrongQuestions(attempts, states).pending;
}

module.exports = {
  DAY_MS,
  REVIEW_INTERVAL_DAYS,
  classifyWrongQuestions,
  collectWrongQuestionIds,
  createInitialReviewState,
  endOfDay,
  getDueReviewStates,
  isMasteredReviewState,
  normalizeReviewStates,
  saveReviewState,
  scheduleReview,
};
