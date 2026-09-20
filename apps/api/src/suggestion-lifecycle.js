// 建议层的统一词汇（《链路职责矩阵》第 1 批 · 第 1/2 项）。
//
// 背景：题目完善与 AI 巡检各自产"建议"，但两边对不齐 ——
//   · 题目完善：status = recommended / applied / rejected（+ reverted / failed / stale），
//     并记录 appliedFields（采纳了哪些字段）与 appliedVersion（采纳到哪个题目版本）；
//   · AI 巡检：reviewStatus = pending / applied / rejected，且**不记录** appliedFields / appliedVersion。
// 于是没有统一入口能把两条产线的建议放进一张列表里分流、筛选与追溯。
//
// 本文件是这套词汇的**唯一定义处**：两条产线都从这里取，不再各自发明。
//
// 边界（同上文档 B3）：**算法不合并、流程统一** —— 只统一"建议 → 逐字段采纳 → 落正式数据"
// 这套骨架的词汇；不碰两条产线各自的提示词、模型与调度。

const SUGGESTION_SOURCES = Object.freeze({
  QUESTION_ENRICHMENT: "question_enrichment",
  KNOWLEDGE_INSPECTION: "knowledge_inspection",
});

const SUGGESTION_SOURCE_VALUES = Object.freeze(Object.values(SUGGESTION_SOURCES));

// 人工裁决生命周期：recommended（待人工处理）→ applied / rejected
const SUGGESTION_REVIEW_STATUSES = Object.freeze(["recommended", "applied", "rejected"]);

// 旧值兼容：AI 巡检历史上把"待人工处理"写成 pending，读取时归一到 recommended。
// 只做读时归一，不改历史文件；下一次写入即自然迁移。
const LEGACY_REVIEW_STATUS_ALIASES = Object.freeze({ pending: "recommended" });

function normalizeSuggestionSource(value, fallback) {
  const text = String(value || "").trim();
  if (SUGGESTION_SOURCE_VALUES.includes(text)) return text;
  const fallbackText = String(fallback || "").trim();
  return SUGGESTION_SOURCE_VALUES.includes(fallbackText) ? fallbackText : "";
}

function normalizeSuggestionReviewStatus(value) {
  const text = String(value || "").trim();
  const resolved = LEGACY_REVIEW_STATUS_ALIASES[text] || text;
  return SUGGESTION_REVIEW_STATUSES.includes(resolved) ? resolved : "recommended";
}

module.exports = {
  SUGGESTION_SOURCES,
  SUGGESTION_SOURCE_VALUES,
  SUGGESTION_REVIEW_STATUSES,
  LEGACY_REVIEW_STATUS_ALIASES,
  normalizeSuggestionSource,
  normalizeSuggestionReviewStatus,
};
