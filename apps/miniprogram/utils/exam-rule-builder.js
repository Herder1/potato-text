function questionScore(question = {}) {
  return Math.max(0, Number(question.maxScore ?? question.score) || 0);
}

function createExamBlueprint(questions = []) {
  const groups = [];
  const groupMap = new Map();
  (Array.isArray(questions) ? questions : []).forEach((question) => {
    const type = String(question.type || "unknown");
    const score = questionScore(question);
    const key = `${type}:${score}`;
    if (!groupMap.has(key)) {
      const group = {
        key,
        type,
        typeLabel: String(question.typeLabel || type || "其他题型"),
        score,
        count: 0,
      };
      groupMap.set(key, group);
      groups.push(group);
    }
    groupMap.get(key).count += 1;
  });
  return groups.map((group) => ({
    ...group,
    summary: `${group.count} 题 × ${group.score} 分`,
  }));
}

function shuffled(items, random = Math.random) {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

function buildRuleExam(templateQuestions = [], questionPool = [], selectionRules = [], random = Math.random) {
  const template = Array.isArray(templateQuestions) ? templateQuestions : [];
  const templateIds = new Set(template.map((question) => String(question.id || "")));
  const available = shuffled((Array.isArray(questionPool) ? questionPool : [])
    .filter((question) => question && question.id && !templateIds.has(String(question.id))), random);
  const usedIds = new Set();
  const mapping = new Map();
  const questions = [];
  const shortageMap = new Map();

  template.forEach((slot) => {
    const type = String(slot.type || "");
    const score = questionScore(slot);
    const candidate = available.find((question) => !usedIds.has(String(question.id))
      && String(question.type || "") === type
      && Math.abs(questionScore(question) - score) < 0.001);
    if (!candidate) {
      const key = `${type}:${score}`;
      const shortage = shortageMap.get(key) || {
        key,
        type,
        typeLabel: String(slot.typeLabel || type || "其他题型"),
        score,
        missing: 0,
      };
      shortage.missing += 1;
      shortageMap.set(key, shortage);
      return;
    }
    usedIds.add(String(candidate.id));
    mapping.set(String(slot.id), String(candidate.id));
    questions.push(candidate);
  });

  const mappedRules = (Array.isArray(selectionRules) ? selectionRules : []).map((rule) => ({
    ...rule,
    questionIds: (rule.questionIds || []).map((id) => mapping.get(String(id))).filter(Boolean),
  })).filter((rule) => rule.questionIds.length > Number(rule.requiredCount || 0));
  const shortages = [...shortageMap.values()].map((item) => ({
    ...item,
    summary: `${item.typeLabel}（${item.score} 分）缺 ${item.missing} 题`,
  }));

  return {
    success: template.length > 0 && shortages.length === 0 && questions.length === template.length,
    questions,
    selectionRules: mappedRules,
    shortages,
    blueprint: createExamBlueprint(template),
  };
}

module.exports = { buildRuleExam, createExamBlueprint, questionScore };
