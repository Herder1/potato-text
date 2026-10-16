const { createMemoryKnowledgeStructureStore, buildKnowledgeStructure } = require("../../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionStore } = require("../../apps/api/src/question-store");
const { createMemoryQuestionFamilyStore } = require("../../apps/api/src/question-family-store");
const { createMemoryTextbookCatalogStore } = require("../../apps/api/src/textbook-catalog-store");
const { createMemoryTextbookKnowledgeStore } = require("../../apps/api/src/textbook-knowledge-store");
const { createMemoryKnowledgeDossierStore } = require("../../apps/api/src/knowledge-dossier-store");
const { createLibraryDirectories } = require("../../apps/api/src/library-directories");
const { createQuestionCompletion } = require("../../apps/api/src/question-completion");

const bookId = "modern-chinese-7-1";
const catalogNodes = [
  { id: "chapter", level: 1, title: "第一章 绪论", startPage: 1, endPage: 30, order: 1 },
  { id: "section", level: 2, title: "第一节 现代汉语", startPage: 1, endPage: 20, order: 2 },
  { id: "meaning", level: 3, title: "一、现代汉语的含义", startPage: 2, endPage: 5, order: 3 },
  { id: "standard", level: 3, title: "二、普通话的标准", startPage: 6, endPage: 10, order: 4 },
];
function question(id, overrides = {}) {
  return { id, bookId, library: "official", status: "official", subjectId: "modern-chinese", chapter: "绪论 > 现代汉语",
    primaryKnowledgePoint: "现代汉语的含义", knowledgePoints: ["现代汉语的含义"], subKnowledgePoints: ["现代汉语的含义"],
    type: "single_choice", typeLabel: "单选题", stem: "关于现代汉语的含义，下列说法正确的是（ ）。",
    options: [{ key: "A", text: "包括方言和普通话" }, { key: "B", text: "仅普通话" }], correctAnswer: ["A"],
    referenceAnswer: "包括方言和普通话", maxScore: 2, importBatchId: "completion-test", version: 1, ...overrides };
}
function fixture(options = {}) {
  const questions = options.questions || [question("missing-1"), question("missing-2")];
  const source = buildKnowledgeStructure({ bookId, catalogNodes, questions: [] });
  const structure = structuredClone(source);
  structure.nodes = structure.nodes.map((node) => node.id === "meaning" ? { ...node, id: "merged-meaning", title: "现代汉语概说", displayTitle: "现代汉语概说" } : node);
  structure.fingerprints = options.fingerprints || [];
  structure.summary.questionCount = questions.length;
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore({ records: [structure] });
  const questionStore = createMemoryQuestionStore(questions);
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: options.families || [] });
  questionFamilyStore.replaceState(questionFamilyStore.exportState());
  const textbookCatalogStore = createMemoryTextbookCatalogStore([{ bookId, status: "confirmed", confirmed: { nodes: catalogNodes } }]);
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([]);
  const knowledgeDossierStore = createMemoryKnowledgeDossierStore({ dossiers: options.dossiers || [], deltas: [], runs: [] });
  const stores = { knowledgeStructureStore, questionStore, questionFamilyStore, textbookCatalogStore, textbookKnowledgeStore, knowledgeDossierStore };
  const directories = createLibraryDirectories(stores);
  if (options.mapped !== false) directories.save(bookId, "merged-meaning", ["meaning"], directories.read(bookId).revision);
  const completion = createQuestionCompletion({ ...stores, directories });
  return { ...stores, stores, directories, completion, questions, source, bookId };
}
module.exports = { fixture, question, bookId, catalogNodes };
