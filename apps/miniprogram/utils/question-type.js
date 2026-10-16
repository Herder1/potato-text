const materialAliases = new Set([
  "appreciation", "作品赏析", "作品赏析题", "赏析题",
  "material_analysis", "材料分析", "材料分析题",
]);

function normalizeQuestionType(value) {
  const type = String(value || "").trim();
  return materialAliases.has(type) ? "material_analysis" : type;
}

function normalizeQuestionTypeLabel(label, type) {
  return normalizeQuestionType(type || label) === "material_analysis" ? "材料分析题" : label;
}

function normalizeQuestionTypeFields(question) {
  const type = normalizeQuestionType(question.type);
  return type === "material_analysis"
    ? { ...question, type, typeLabel: "材料分析题" }
    : question;
}

module.exports = { normalizeQuestionType, normalizeQuestionTypeLabel, normalizeQuestionTypeFields };
