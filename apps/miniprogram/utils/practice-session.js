function normalizeSelection(selected) {
  if (Array.isArray(selected)) return selected.slice().sort();
  return selected ? [selected] : [];
}

function questionGroupId(question = {}) {
  const explicit = String(question.questionGroupId || "").trim();
  if (explicit) return explicit;
  const materialGroupId = String(question.materialGroupId || "").trim();
  if (!materialGroupId) return "";
  const namespace = String(question.importBatchId || question.sourceLabel || "legacy-material").trim();
  const groupNumber = String(question.groupNumber || "").trim();
  return `material:${namespace}:${groupNumber}:${materialGroupId}`;
}

function groupQuestionUnits(questions = []) {
  const units = [];
  const grouped = new Map();
  (Array.isArray(questions) ? questions : []).forEach((question, sourceIndex) => {
    const groupId = questionGroupId(question);
    const key = groupId || `question:${question.id}`;
    if (!grouped.has(key)) {
      const unit = { key, questionGroupId: groupId, questions: [] };
      grouped.set(key, unit);
      units.push(unit);
    }
    grouped.get(key).questions.push({ ...question, __sourceIndex: sourceIndex });
  });
  units.forEach((unit) => {
    if (!unit.questionGroupId) return;
    unit.questions.sort((left, right) => {
      const leftOrder = Number(left.groupOrder) || Number(String(left.subNumber || "").replace(/\D/g, "")) || left.__sourceIndex + 1;
      const rightOrder = Number(right.groupOrder) || Number(String(right.subNumber || "").replace(/\D/g, "")) || right.__sourceIndex + 1;
      return leftOrder - rightOrder || left.__sourceIndex - right.__sourceIndex;
    });
  });
  return units.map((unit) => ({
    ...unit,
    questions: unit.questions.map(({ __sourceIndex, ...question }) => question),
  }));
}

function countQuestionUnits(questions = []) {
  return groupQuestionUnits(questions).length;
}

function evaluateAnswer(question, selected) {
  return evaluateQuestionAnswer(question, selected).isCorrect;
}

function evaluateQuestionAnswer(question, selected) {
  const maxScore = Number(question && (question.score ?? question.maxScore)) || 0;
  if (!question || !Array.isArray(question.correctAnswer) || !question.correctAnswer.length) {
    return { isCorrect: false, awardedScore: 0, maxScore, status: "wrong" };
  }
  const actual = normalizeSelection(selected);
  const expected = normalizeSelection(question.correctAnswer);
  const exact = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  if (exact) {
    const awardedScore = ["double_choice_partial", "double_choice_no_partial"].includes(question.scoringPolicy?.mode)
      ? Number(question.scoringPolicy.allCorrectScore ?? maxScore)
      : maxScore;
    return { isCorrect: true, awardedScore, maxScore, status: "correct" };
  }
  if (!actual.length) {
    return {
      isCorrect: false,
      awardedScore: Number(question.scoringPolicy?.emptyScore) || 0,
      maxScore,
      status: "empty",
    };
  }
  if (question.type === "multiple_choice" && question.scoringPolicy?.mode === "double_choice_partial") {
    const containsWrongOption = actual.some((value) => !expected.includes(value));
    if (!containsWrongOption && actual.length === 1 && expected.includes(actual[0])) {
      return {
        isCorrect: false,
        awardedScore: Number(question.scoringPolicy.oneCorrectScore) || 0,
        maxScore,
        status: "partial",
      };
    }
    return {
      isCorrect: false,
      awardedScore: Number(question.scoringPolicy.extraOptionScore) || 0,
      maxScore,
      status: "wrong",
    };
  }
  return { isCorrect: false, awardedScore: 0, maxScore, status: "wrong" };
}

function buildQuestionQueue(questions, order = "sequential", random = Math.random) {
  const units = groupQuestionUnits(questions).map((unit) => ({
    ...unit,
    questions: unit.questions.map((question) => ({ ...question })),
  }));
  if (order === "random") {
    for (let index = units.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [units[index], units[target]] = [units[target], units[index]];
    }
  }
  const queue = units.flatMap((unit, unitIndex) => unit.questions.map((question, groupItemIndex) => ({
    ...question,
    questionUnitNumber: unitIndex + 1,
    questionUnitTotal: units.length,
    groupItemNumber: groupItemIndex + 1,
    groupItemTotal: unit.questions.length,
    isQuestionGroup: Boolean(unit.questionGroupId && unit.questions.length > 1),
  })));
  return queue.map((question, index) => ({
    ...question,
    number: index + 1,
    total: queue.length,
    progressPercent: queue.length ? Math.round(((index + 1) / queue.length) * 100) : 0,
    correctAnswerText: normalizeSelection(question.correctAnswer).join("、"),
  }));
}

function buildAnswerCard(queue, responses, currentIndex, examFinished = false) {
  return queue.map((question, index) => {
    const response = responses[question.id] || {};
    let status = normalizeSelection(response.selected).length || response.subjectiveAnswer ? "answered" : "empty";
    const awaitingSubjectiveScore = question.answerMode === "text"
      && response.submitted
      && typeof response.isCorrect !== "boolean";
    if ((response.submitted || examFinished) && !awaitingSubjectiveScore) status = response.isCorrect ? "correct" : "wrong";
    return {
      number: index + 1,
      questionId: question.id,
      current: index === currentIndex,
      status,
    };
  });
}

function hasResponse(response = {}) {
  return normalizeSelection(response.selected).length > 0 || Boolean(String(response.subjectiveAnswer || "").trim());
}

function selectionRuleState(queue, responses, selectionRules = []) {
  const queueIndex = new Map(queue.map((question, index) => [question.id, index]));
  const countedAnswerIds = new Set();
  const totalQuestionIds = new Set(queue.map((question) => question.id));
  const groupedQuestionIds = new Set();

  (Array.isArray(selectionRules) ? selectionRules : []).forEach((rule) => {
    const questionIds = (Array.isArray(rule.questionIds) ? rule.questionIds : [])
      .filter((id) => queueIndex.has(id))
      .sort((left, right) => queueIndex.get(left) - queueIndex.get(right));
    const requiredCount = Math.max(0, Math.min(questionIds.length, Number(rule.requiredCount) || 0));
    if (!questionIds.length || !requiredCount) return;
    questionIds.forEach((id) => {
      groupedQuestionIds.add(id);
      totalQuestionIds.delete(id);
    });
    questionIds.slice(0, requiredCount).forEach((id) => totalQuestionIds.add(id));
    questionIds
      .filter((id) => hasResponse(responses[id]))
      .sort((left, right) => {
        const leftTime = Number(responses[left]?.answeredAt) || Number.MAX_SAFE_INTEGER;
        const rightTime = Number(responses[right]?.answeredAt) || Number.MAX_SAFE_INTEGER;
        return leftTime - rightTime || queueIndex.get(left) - queueIndex.get(right);
      })
      .slice(0, requiredCount)
      .forEach((id) => countedAnswerIds.add(id));
  });

  queue.forEach((question) => {
    if (!groupedQuestionIds.has(question.id)) countedAnswerIds.add(question.id);
  });
  return { countedAnswerIds, totalQuestionIds };
}

function calculateExamResult(queue, responses, selectionRules = [], declaredTotalScore = 0) {
  const { countedAnswerIds, totalQuestionIds } = selectionRuleState(queue, responses, selectionRules);
  const result = queue.reduce(
    (result, question) => {
      const response = responses[question.id] || {};
      const evaluation = evaluateQuestionAnswer(question, response.selected);
      const counted = countedAnswerIds.has(question.id);
      const awardedScore = counted ? evaluation.awardedScore : 0;
      result.responses[question.id] = { ...response, submitted: true, isCorrect: evaluation.isCorrect, answerStatus: evaluation.status, awardedScore, counted };
      result.answeredCount += hasResponse(response) ? 1 : 0;
      if (evaluation.isCorrect) {
        result.correctCount += 1;
      }
      if (evaluation.status === "partial") result.partialCount += 1;
      result.score += awardedScore;
      if (totalQuestionIds.has(question.id)) result.totalScore += evaluation.maxScore;
      return result;
    },
    { responses: {}, answeredCount: 0, correctCount: 0, partialCount: 0, score: 0, totalScore: 0 },
  );
  const declared = Math.max(0, Number(declaredTotalScore) || 0);
  result.calculatedTotalScore = result.totalScore;
  if (declared) result.totalScore = declared;
  return result;
}

module.exports = {
  buildAnswerCard,
  buildQuestionQueue,
  calculateExamResult,
  countQuestionUnits,
  evaluateAnswer,
  evaluateQuestionAnswer,
  groupQuestionUnits,
  questionGroupId,
  selectionRuleState,
};
