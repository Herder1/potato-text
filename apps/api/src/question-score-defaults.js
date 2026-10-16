/**
 * 题型默认分值兜底（产品手册 §4.6.8 / DEC-099 修订，产品负责人 2026-09-25 确认）。
 *
 * 口径：录入稿（或 JSON 导入）**没写分值**时，当前只补 **单选 2 分、多选 3 分**；
 * 判断题、填空题、主观题等**不补**——保持 0 分，交给「缺分值」校验提示人工补
 * （宁可不给分，也不替产品负责人扩大口径）。
 * **卷面写了分值就以卷面为准**（含与默认值不一致的情况），默认值只兜底；
 * 兜底填入的分数**不是卷面事实**，因此同样标「分值待核对」（`scoreNeedsReview: true`）。
 *
 * 数值只维护在本文件；读取入口就是本模块的函数，调用点不得写死 2/3。
 * 需要按科目区分、或放开判断题／填空题的默认分值时，先回产品手册确认口径再改本文件。
 */
const TYPE_DEFAULT_SCORES = {
  single_choice: 2,
  multiple_choice: 3,
};

function defaultScoreForQuestionType(type) {
  const score = TYPE_DEFAULT_SCORES[String(type || "").trim()];
  return Number.isFinite(score) && score > 0 ? score : 0;
}

module.exports = { TYPE_DEFAULT_SCORES, defaultScoreForQuestionType };
