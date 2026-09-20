function clean(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function questionGroupId(question = {}) {
  const explicit = clean(question.questionGroupId);
  if (explicit) return explicit;
  const materialGroupId = clean(question.materialGroupId, 120);
  if (!materialGroupId) return "";
  const namespace = clean(question.importBatchId || question.sourceLabel || "legacy-material", 180);
  const groupNumber = clean(question.groupNumber, 40);
  return `material:${namespace}:${groupNumber}:${materialGroupId}`.slice(0, 360);
}

function questionUnitKey(question = {}) {
  return questionGroupId(question) || `question:${clean(question.id, 240)}`;
}

function subQuestionOrder(question = {}, fallback = 0) {
  const explicit = Number(question.groupOrder);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const normalized = clean(question.subNumber, 40).normalize("NFKC").replace(/[^0-9]/g, "");
  return Number(normalized) || fallback + 1;
}

function groupQuestionUnits(questions = []) {
  const units = [];
  const grouped = new Map();
  (Array.isArray(questions) ? questions : []).forEach((question, index) => {
    const key = questionUnitKey(question);
    if (!grouped.has(key)) {
      const unit = { key, questionGroupId: questionGroupId(question), questions: [], firstIndex: index };
      grouped.set(key, unit);
      units.push(unit);
    }
    grouped.get(key).questions.push({ ...question, __groupSourceIndex: index });
  });
  units.forEach((unit) => {
    if (!unit.questionGroupId) return;
    unit.questions.sort((left, right) => subQuestionOrder(left, left.__groupSourceIndex) - subQuestionOrder(right, right.__groupSourceIndex)
      || left.__groupSourceIndex - right.__groupSourceIndex);
  });
  return units.map((unit) => ({
    ...unit,
    questions: unit.questions.map(({ __groupSourceIndex, ...question }) => question),
  }));
}

function countQuestionUnits(questions = []) {
  return groupQuestionUnits(questions).length;
}

function decorateQuestionGroups(questions = []) {
  const units = groupQuestionUnits(questions);
  const decorations = new Map();
  units.forEach((unit) => {
    if (!unit.questionGroupId) return;
    const first = unit.questions[0] || {};
    const groupTitle = clean(first.questionGroupTitle || first.groupTitle, 200)
      || `第${clean(first.groupNumber || first.number || "", 40) || "—"}题 · 材料题组`;
    const questionIds = unit.questions.map((question) => clean(question.id)).filter(Boolean);
    const totalScore = unit.questions.reduce((total, question) => total + (Number(question.maxScore) || 0), 0);
    unit.questions.forEach((question, index) => decorations.set(clean(question.id), {
      questionGroupId: unit.questionGroupId,
      questionGroupTitle: groupTitle,
      groupOrder: subQuestionOrder(question, index),
      groupQuestionCount: unit.questions.length,
      groupTotalScore: totalScore,
      groupQuestionIds: questionIds,
      isQuestionGroup: unit.questions.length > 1,
    }));
  });
  return questions.map((question) => ({ ...question, ...(decorations.get(clean(question.id)) || {
    questionGroupId: "",
    questionGroupTitle: "",
    groupOrder: 0,
    groupQuestionCount: 1,
    groupTotalScore: Number(question.maxScore) || 0,
    groupQuestionIds: [clean(question.id)].filter(Boolean),
    isQuestionGroup: false,
  }) }));
}

module.exports = {
  countQuestionUnits,
  decorateQuestionGroups,
  groupQuestionUnits,
  questionGroupId,
  questionUnitKey,
  subQuestionOrder,
};
