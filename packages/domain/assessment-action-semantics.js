function normalizeActionText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[^\u3400-\u9fffa-z0-9]+/giu, "");
}

function actionTextSimilarity(leftValue, rightValue) {
  const left = normalizeActionText(leftValue);
  const right = normalizeActionText(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const grams = (value) => value.length < 2
    ? new Set([...value])
    : new Set([...Array(value.length - 1)].map((_, index) => value.slice(index, index + 2)));
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  const intersection = [...leftGrams].filter((item) => rightGrams.has(item)).length;
  const union = new Set([...leftGrams, ...rightGrams]).size;
  return union ? intersection / union : 0;
}

const ASSESSMENT_ACTION_RULES = [
  {
    type: "validity_judgement",
    label: "合法性/成立性判断",
    patterns: [
      /合法性|合规性|成立性/u,
      /(?:能否|是否|可否|能不能|可不可以|有无).{0,24}(?:构成|形成|成为|成立|合法|合规|符合|可行|可能|允许|存在|拼合|组合)/u,
      /(?:构成|形成|成为).{0,20}(?:可能|合法|合规|允许|成立)/u,
      /(?:成立|合法|合规|可行|可能|拼合).{0,8}(?:判断|判定|检验)/u,
    ],
  },
  {
    type: "concept_recognition",
    label: "概念/术语识别",
    patterns: [
      /概念.{0,6}(?:识别|辨认|判定|判断)/u,
      /(?:识别|辨认|判定).{0,6}概念/u,
      /术语.{0,6}(?:识别|辨认|辨析)/u,
      /(?:识别|辨认|辨析).{0,6}术语/u,
      /定义.{0,6}(?:识别|辨认|匹配)/u,
    ],
  },
  {
    type: "correctness_judgement",
    label: "正误判断",
    patterns: [
      /正误/u,
      /(?:说法|表述|选项).{0,8}(?:正确|错误)/u,
      /(?:判断|判定).{0,8}(?:正确|错误)/u,
    ],
  },
  { type: "classification", label: "分类/归类", patterns: [/(?:分类|归类|类别判定|类型判定)/u] },
  { type: "comparison", label: "比较/辨异", patterns: [/(?:比较|异同|区别|辨别差异|对比)/u] },
  { type: "example_generation", label: "举例/例证", patterns: [/(?:举例|例证|列举)/u] },
  { type: "causal_explanation", label: "解释/说明原因", patterns: [/(?:解释|说明|分析).{0,10}(?:原因|依据|为什么)|原因分析/u] },
  { type: "calculation", label: "计算/推算", patterns: [/(?:计算|推算|求出|求得)/u] },
  { type: "notation", label: "标注/转写", patterns: [/(?:国际音标|注音|音标转写|标注|拼写)/u] },
  { type: "feature_identification", label: "特征/性质识别", patterns: [/(?:特征|性质).{0,8}(?:识别|判断|判定|分析)|(?:识别|判断|判定).{0,8}(?:特征|性质)/u] },
  { type: "application", label: "规则/知识应用", patterns: [/(?:运用|应用|利用).{0,10}(?:规律|规则|知识|原理)/u] },
  { type: "generic_judgement", label: "一般判断", patterns: [/(?:判断|判定|检验)/u] },
];

function normalizeAssessmentActionSemantics(value) {
  const source = String(value || "").normalize("NFKC").trim();
  const normalizedText = normalizeActionText(source);
  if (!normalizedText) return { source, normalizedText, type: "missing", label: "未给出" };
  const matched = ASSESSMENT_ACTION_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(normalizedText)));
  return matched
    ? { source, normalizedText, type: matched.type, label: matched.label }
    : { source, normalizedText, type: "unclassified", label: "未归一动作" };
}

function compareAssessmentActions(predictedValue, expectedValue, options = {}) {
  const predicted = normalizeAssessmentActionSemantics(predictedValue);
  const expected = normalizeAssessmentActionSemantics(expectedValue);
  const similarity = actionTextSimilarity(predictedValue, expectedValue);
  if (expected.type === "missing") return {
    predicted,
    expected,
    match: options.allowMissingExpected === true,
    method: options.allowMissingExpected === true ? "expected_not_frozen" : "expected_missing",
    similarity,
  };
  if (predicted.type === "missing") return { predicted, expected, match: false, method: "candidate_missing", similarity };
  if (predicted.type !== "unclassified" && expected.type !== "unclassified") {
    return { predicted, expected, match: predicted.type === expected.type, method: "action_taxonomy", similarity };
  }
  return { predicted, expected, match: similarity >= 0.6, method: "lexical_fallback", similarity };
}

module.exports = {
  actionTextSimilarity,
  compareAssessmentActions,
  normalizeActionText,
  normalizeAssessmentActionSemantics,
};
