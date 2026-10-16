/**
 * 体检服务层（DEC-100 / 手册 §4.6.12）：把「题目 Store＋教材知识结构＋教材正文」接到规则层，
 * 产出一本书的**只读体检报告**。巡检面板与「送去完善题目」都从这里取结果，不再各自拼上下文。
 *
 * 只读：不写任何 Store、不改题目字段、不落库。通过（没查到问题的题）也留档，作复查基线。
 */
const { auditQuestions, buildFingerprintIndex } = require("./question-audit-rules");
const { buildAuditContext } = require("./question-audit-context");

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/**
 * @param {object} deps
 * @param {object} deps.questionStore          必须（`list({ bookId })` → `{ questions }`）
 * @param {object} [deps.knowledgeStructureStore] `get(bookId)` → 教材知识树记录
 * @param {object} [deps.textbookKnowledgeStore]  `get(bookId)` → 教材正文摘要
 */
function createQuestionAuditService({ questionStore, knowledgeStructureStore = null, textbookKnowledgeStore = null } = {}) {
  if (!questionStore || typeof questionStore.list !== "function") {
    throw new Error("question_audit_question_store_required");
  }

  function bookQuestions(bookId) {
    const listed = questionStore.list({ bookId });
    const questions = Array.isArray(listed?.questions) ? listed.questions : (Array.isArray(listed) ? listed : []);
    return questions.filter((question) => question && question.id);
  }

  /**
   * 一本书的体检。`questionIds` 给了就只体检这几道，**但重复题索引始终建在整本书上**
   * （否则"这道题跟别的题重复"在按批体检时会漏报）。
   */
  function auditBook({ bookId, questionIds = null, similarMatcher = null, fingerprintIndex = null } = {}) {
    const id = clean(bookId);
    if (!id) throw new Error("question_audit_book_required");
    const all = bookQuestions(id);
    const wanted = Array.isArray(questionIds) && questionIds.length
      ? new Set(questionIds.map((value) => String(value)))
      : null;
    const scoped = wanted ? all.filter((question) => wanted.has(String(question.id))) : all;
    const structure = typeof knowledgeStructureStore?.get === "function" ? knowledgeStructureStore.get(id) : null;
    const textbookSummary = typeof textbookKnowledgeStore?.get === "function" ? textbookKnowledgeStore.get(id) : null;
    const index = fingerprintIndex || buildFingerprintIndex(all);
    const context = buildAuditContext({
      questions: scoped,
      knowledgeStructure: structure,
      textbookKnowledgeSummary: textbookSummary,
      fingerprintIndex: index,
      similarMatcher,
    });
    const report = auditQuestions(scoped, context);
    return {
      bookId: id,
      scope: {
        bookQuestionCount: all.length,
        auditedCount: scoped.length,
        requestedQuestionIds: wanted ? [...wanted] : null,
      },
      textbookReadiness: context.textbookReadiness,
      knowledgeNodeCount: Array.isArray(structure?.nodes) ? structure.nodes.length : 0,
      generatedAt: new Date().toISOString(),
      ...report,
    };
  }

  /** 单题体检（巡检清单每行/「送去完善题目」用）：仍用整本书的索引判重复。 */
  function auditOne(questionId, { bookId } = {}) {
    const report = auditBook({ bookId, questionIds: [questionId] });
    const id = String(questionId);
    return {
      questionId: id,
      findings: report.byQuestion[id] || [],
      passed: report.passed.includes(id),
      textbookReadiness: report.textbookReadiness,
      generatedAt: report.generatedAt,
    };
  }

  return { auditBook, auditOne };
}

module.exports = { createQuestionAuditService };
