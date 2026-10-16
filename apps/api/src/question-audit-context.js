/**
 * 体检上下文解析层（DEC-100 / 手册 §4.6.12）：把 Store 里的现状翻译成体检规则需要的判据。
 *
 * 分工：`question-audit-rules.js` 只管"给定事实怎么判"，本模块只管"事实从哪来"——
 * 教材正文是否可检索、题目的知识归属能不能落到教材目录节点、全库指纹索引。
 * **只读**：不改任何 Store，不补任何字段。
 */
const { auditQuestions, buildFingerprintIndex } = require("./question-audit-rules");

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/** 教材正文／知识结构是否真的可检索：读 summary（`textbookKnowledgeStore.get(bookId)` 的返回值）。 */
function resolveTextbookReadiness(summary) {
  if (!summary || typeof summary !== "object") {
    return { ready: false, reason: "该教材没有正文记录", pageCount: 0, chunkCount: 0, version: 0 };
  }
  const pageCount = Number(summary.pageCount ?? summary.pages ?? summary.pageTotal) || 0;
  const chunkCount = Number(summary.chunkCount ?? summary.chunks ?? summary.chunkTotal) || 0;
  const version = Number(summary.version ?? summary.revision) || 0;
  const status = clean(summary.status || summary.textbookStatus);
  if (status && !["ready", "generated", "ok", "complete"].includes(status)) {
    return { ready: false, reason: `教材正文状态为 ${status}`, pageCount, chunkCount, version };
  }
  if (pageCount <= 0 && chunkCount <= 0) {
    return { ready: false, reason: "教材正文里没有可检索的页／段落", pageCount, chunkCount, version };
  }
  return { ready: true, reason: "", pageCount, chunkCount, version };
}

/** 教材目录节点索引：id 可查、标题（去空白、去编号前缀）可查。 */
function buildNodeTitleIndex(nodes = []) {
  const byId = new Set();
  const byTitle = new Set();
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    const id = clean(node?.id);
    if (id) byId.add(id);
    const title = clean(node?.title || node?.label);
    if (!title) return;
    byTitle.add(title);
    byTitle.add(title.replace(/^[（(]?[一二三四五六七八九十百零\d]+[）)、.．]\s*/, "").trim());
  });
  return { byId, byTitle };
}

/** 题目的知识归属能否落到教材目录节点：显式节点 id 命中，或知识点标签命中节点标题。 */
function questionAnchorResolved(question, nodeIndex) {
  if (!nodeIndex) return undefined;
  const explicit = [
    question?.knowledgeNodeId,
    question?.primaryNodeId,
    question?.chapterNodeId,
    ...(Array.isArray(question?.knowledgeNodeIds) ? question.knowledgeNodeIds : []),
    ...(Array.isArray(question?.requiredNodeIds) ? question.requiredNodeIds : []),
  ].map(clean).filter(Boolean);
  if (explicit.length) return explicit.some((id) => nodeIndex.byId.has(id));
  const labels = [
    question?.primaryKnowledgePoint,
    question?.chapter,
    ...(Array.isArray(question?.knowledgePoints) ? question.knowledgePoints : []),
    ...(Array.isArray(question?.subKnowledgePoints) ? question.subKnowledgePoints : []),
  ].map(clean).filter(Boolean);
  if (!labels.length) return false;
  return labels.some((label) => nodeIndex.byTitle.has(label));
}

/**
 * 组装一批题目的体检上下文。
 * @param {object} input
 * @param {Array<object>} input.questions         本批要体检的题目（已归一化）
 * @param {object} [input.knowledgeStructure]     `knowledgeStructureStore.get(bookId)` 的返回值
 * @param {object} [input.textbookKnowledgeSummary] `textbookKnowledgeStore.get(bookId)` 的返回值
 * @param {object} [input.fingerprintIndex]       复用既有索引（全库多批体检时只建一次）
 * @param {function} [input.similarMatcher]       疑似重复判据（复用导入查重口径）
 */
function buildAuditContext(input = {}) {
  const questions = (Array.isArray(input.questions) ? input.questions : []).filter(Boolean);
  const readiness = resolveTextbookReadiness(input.textbookKnowledgeSummary);
  const nodes = Array.isArray(input.knowledgeStructure?.nodes) ? input.knowledgeStructure.nodes : [];
  const nodeIndex = nodes.length ? buildNodeTitleIndex(nodes) : null;
  const anchorResolvedByQuestion = {};
  questions.forEach((question) => {
    const id = String(question?.id || "");
    if (!id) return;
    anchorResolvedByQuestion[id] = questionAnchorResolved(question, nodeIndex);
  });
  return {
    questions,
    textbookReady: readiness.ready,
    textbookReadiness: readiness,
    nodeIndex,
    anchorResolvedByQuestion,
    fingerprintIndex: input.fingerprintIndex || buildFingerprintIndex(questions),
    similarMatcher: input.similarMatcher,
  };
}

/**
 * 一批题目的完整体检（规则项）：通过也留档，summary 带来源区分与四类计数。
 * 需要在服务端用真实 Store 调用时：把 store 的 get(bookId) 结果传进来即可。
 */
function auditQuestionBatch(input = {}) {
  const context = buildAuditContext(input);
  return auditQuestions(context.questions, context);
}

module.exports = {
  auditQuestionBatch,
  buildAuditContext,
  buildNodeTitleIndex,
  questionAnchorResolved,
  resolveTextbookReadiness,
};
