const { fixture, question, bookId } = require("./library-completion-fixture");
const { buildKnowledgeStructure } = require("../../apps/api/src/knowledge-structure-store");

function workspaceFixture() {
  const otherBookId = "classical-chinese-1";
  const checked = { answerReviewStatus: "verified" };
  const questions = [
    question("checked", checked), question("pending-member", checked),
    question("pending-answer", { status: "pending_review", answerSource: "pdf_answer", answerReviewStatus: "unreviewed" }),
    question("other-type", { ...checked, type: "short_answer", typeLabel: "简答题" }),
    question("other-batch", { ...checked, importBatchId: "batch-2" }),
    question("pending-definition", checked), question("unarchived", checked),
    question("unassigned", { bookId: "", chapter: "", knowledgePoints: [], answerSource: "pdf_answer", answerReviewStatus: "unreviewed" }),
    question("other-book", { ...checked, bookId: otherBookId, subjectId: "classical-chinese" }),
  ];
  const family = (id, status, ids, overrides = {}) => ({ id, name: id, bookId, status, knowledgeNodeId: "merged-meaning",
    members: ids.map(questionId => ({ questionId, isPrimary: true, reviewStatus: questionId === "pending-member" ? "pending_fit" : "confirmed" })), ...overrides });
  const f = fixture({ questions, families: [
    family("mixed", "confirmed", ["checked", "pending-member", "pending-answer", "other-type", "other-batch"]),
    family("pending-definition-family", "pending_review", ["pending-definition"]),
    family("empty-pending", "pending_review", []), family("empty-checked", "confirmed", []),
    family("other-book-family", "confirmed", ["other-book"], { bookId: otherBookId, knowledgeNodeId: "other-knowledge" }),
  ] });
  const structureState = f.knowledgeStructureStore.exportState();
  structureState.records.push(buildKnowledgeStructure({ bookId: otherBookId, questions: [], catalogNodes: [
    { id: "other-chapter", level: 1, title: "第一章 古代汉语", startPage: 1, endPage: 10, order: 1 },
    { id: "other-knowledge", level: 2, title: "第一节 古今词义", startPage: 1, endPage: 10, order: 2 },
  ] }));
  f.knowledgeStructureStore.replaceState(structureState);
  const familyState = f.questionFamilyStore.exportState();
  familyState.familySets = [{ id: "empty-set", bookId, knowledgeNodeId: "merged-meaning", name: "目录测试题组集", revision: 1 }];
  f.questionFamilyStore.replaceState(familyState);
  return { ...f, otherBookId };
}

module.exports = { workspaceFixture };
