const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildKnowledgeStructure,
  createMemoryKnowledgeStructureStore,
} = require("../apps/api/src/knowledge-structure-store");

const bookId = "modern-chinese-7-2";
const catalogNodes = [
  { id: "grammar", level: 1, title: "第一章 语法", startPage: 1, endPage: 80, order: 1 },
  { id: "word-class", level: 2, title: "第一节 词类", startPage: 2, endPage: 35, order: 1 },
  { id: "content-word", level: 3, title: "一、实词", startPage: 3, endPage: 25, order: 1 },
];
const outlineNodes = [
  { id: "noun", parentId: "content-word", title: "（一）名词", startPage: 4, endPage: 8, pdfPageStart: 10, pdfPageEnd: 14 },
  { id: "noun-kind", parentId: "content-word", title: "1. 名词的意义和种类", startPage: 4, endPage: 5, pdfPageStart: 10, pdfPageEnd: 11 },
  { id: "noun-grammar", parentId: "content-word", title: "2. 名词的语法特征", startPage: 6, endPage: 8, pdfPageStart: 12, pdfPageEnd: 14 },
  { id: "verb", parentId: "content-word", title: "（二）动词", startPage: 9, endPage: 13, pdfPageStart: 15, pdfPageEnd: 19 },
  { id: "verb-grammar", parentId: "content-word", title: "1. 动词的语法特征", startPage: 10, endPage: 13, pdfPageStart: 16, pdfPageEnd: 19 },
  { id: "teaching-tip", parentId: "content-word", title: "教学提示", startPage: 14, endPage: 14, pdfPageStart: 20, pdfPageEnd: 20 },
  { id: "exercises", parentId: "content-word", title: "思考和练习", startPage: 15, endPage: 15, pdfPageStart: 21, pdfPageEnd: 21 },
];

function question(id, stem, createdAt = 0) {
  return {
    id,
    bookId,
    chapter: "第一章 语法 > 第一节 词类 > 一、实词",
    primaryKnowledgePoint: "实词",
    knowledgePoints: ["实词"],
    subKnowledgePoints: [],
    type: "single_choice",
    stem,
    options: [],
    referenceAnswer: "",
    createdAt,
  };
}

function build(questions) {
  return buildKnowledgeStructure({ bookId, catalogNodes, outlineNodes, chunks: [], questions });
}

test("body headings extend the catalog into ordered multi-level knowledge points", () => {
  const structure = build([]);
  const byId = new Map(structure.nodes.map((node) => [node.id, node]));

  assert.equal(byId.get("noun").parentId, "content-word");
  assert.equal(byId.get("noun").knowledgeLevel, 2);
  assert.equal(byId.get("noun-kind").parentId, "noun");
  assert.equal(byId.get("noun-kind").knowledgeLevel, 3);
  assert.equal(byId.get("noun-kind").path, "语法 > 词类 > 实词 > 名词 > 名词的意义和种类");
  assert.equal(byId.has("teaching-tip"), false);
  assert.equal(byId.has("exercises"), false);
  assert.deepEqual(
    structure.nodes.filter((node) => ["noun", "noun-kind", "noun-grammar", "verb", "verb-grammar"].includes(node.id)).map((node) => node.id),
    ["noun", "noun-kind", "noun-grammar", "verb", "verb-grammar"],
  );
});

test("fingerprints keep parent knowledge as context and identify real cross-branch questions", () => {
  const structure = build([
    question("single", "下列关于名词的意义和种类的说法，正确的是（ ）。"),
    question("cross", "比较名词的意义和种类与动词的语法特征，正确的是（ ）。"),
  ]);
  const fingerprints = new Map(structure.fingerprints.map((item) => [item.questionId, item]));
  const single = fingerprints.get("single");
  const cross = fingerprints.get("cross");

  assert.equal(single.primaryNodeId, "noun-kind");
  assert.equal(single.knowledgeLevel, 3);
  assert.deepEqual(single.auxiliaryNodeIds, ["content-word", "noun"]);
  assert.equal(single.span, "single_point");
  assert.equal(single.crossKnowledge, false);
  assert.deepEqual(single.relations, ["包含"]);

  assert.equal(cross.requiredNodeIds.includes("noun-kind"), true);
  assert.equal(cross.requiredNodeIds.includes("verb-grammar"), true);
  assert.equal(cross.span, "cross_branch");
  assert.equal(cross.crossKnowledge, true);
  assert.deepEqual(cross.relations, ["共同作答"]);
});

test("unmatched questions remain auditable instead of breaking fingerprint generation", () => {
  const structure = buildKnowledgeStructure({
    bookId,
    catalogNodes: catalogNodes.slice(0, 2),
    outlineNodes: [],
    chunks: [],
    questions: [question("unmatched", "这是一道无法归类的占位题。")],
  });
  assert.equal(structure.fingerprints[0].primaryNodeId, "");
  assert.equal(structure.summary.unmappedQuestionCount, 1);
});

test("questions are returned in knowledge-tree order", () => {
  const questions = [
    question("verb-question", "动词的语法特征包括（ ）。", 1),
    question("noun-question", "名词的意义和种类包括（ ）。", 2),
  ];
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions });
  assert.deepEqual(store.decorateQuestions(questions, bookId).map((item) => item.id), ["noun-question", "verb-question"]);
});

test("manual node edits survive regeneration and refresh descendant paths", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  store.updateNode(bookId, "noun-kind", { title: "名词分类", parentId: "verb" });

  let structure = store.get(bookId);
  assert.equal(structure.nodes.find((node) => node.id === "noun-kind").path, "语法 > 词类 > 实词 > 动词 > 名词分类");
  assert.equal(structure.nodes.find((node) => node.id === "noun-kind").knowledgeLevel, 3);

  structure = store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  assert.equal(structure.nodes.find((node) => node.id === "noun-kind").parentId, "verb");
  assert.equal(structure.nodes.find((node) => node.id === "noun-kind").displayTitle, "名词分类");
});

test("drag-style node moves persist sibling order and cross-parent placement", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });

  store.updateNode(bookId, "noun-grammar", { beforeNodeId: "noun-kind" });
  let structure = store.get(bookId);
  assert.deepEqual(
    structure.nodes.filter((node) => node.parentId === "noun").map((node) => node.id),
    ["noun-grammar", "noun-kind"],
  );

  store.updateNode(bookId, "noun-kind", { parentId: "verb" });
  structure = store.get(bookId);
  assert.deepEqual(
    structure.nodes.filter((node) => node.parentId === "verb").map((node) => node.id),
    ["verb-grammar", "noun-kind"],
  );
  assert.equal(structure.nodes.find((node) => node.id === "noun-kind").path, "语法 > 词类 > 实词 > 动词 > 名词的意义和种类");

  structure = store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  assert.deepEqual(
    structure.nodes.filter((node) => node.parentId === "noun").map((node) => node.id),
    ["noun-grammar"],
  );
  assert.deepEqual(
    structure.nodes.filter((node) => node.parentId === "verb").map((node) => node.id),
    ["verb-grammar", "noun-kind"],
  );
});

test("manual nodes survive regeneration and deletion keeps mapped nodes safe", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  const created = store.createNode(bookId, { title: "名词辨析", parentId: "noun" });
  const nodeId = created.node.id;
  assert.match(nodeId, /^manual-knowledge-node-/);
  assert.equal(created.node.path, "语法 > 词类 > 实词 > 名词 > 名词辨析");

  let structure = store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  assert.equal(structure.nodes.some((node) => node.id === nodeId), true);
  store.deleteNode(bookId, nodeId);
  structure = store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  assert.equal(structure.nodes.some((node) => node.id === nodeId), false);

  const mappedStore = createMemoryKnowledgeStructureStore();
  mappedStore.generate({
    bookId,
    catalogNodes,
    outlineNodes,
    chunks: [],
    questions: [question("noun-question", "名词的意义和种类包括（ ）。")],
  });
  assert.throws(() => mappedStore.deleteNode(bookId, "noun-kind"), /knowledge_node_has_questions/);
});

test("node question listing exposes which questions block deletion and why", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({
    bookId,
    catalogNodes,
    outlineNodes,
    chunks: [],
    questions: [question("noun-question", "名词的意义和种类包括（ ）。")],
  });

  const listed = store.questionsForNode(bookId, "noun-kind");
  assert.equal(listed.node.id, "noun-kind");
  assert.ok(listed.subtreeNodeIds.includes("noun-kind"));
  assert.equal(listed.questions.length, 1);
  const [row] = listed.questions;
  assert.equal(row.questionId, "noun-question");
  assert.equal(row.blocksDelete, true);
  assert.ok(row.references.includes("题目知识焦点"));
  assert.ok(row.requiredNodeIds.includes("noun-kind"));

  // 删除仍然被拒绝，但错误里必须带上具体题目，避免审核员只看到一个数量。
  assert.throws(() => store.deleteNode(bookId, "noun-kind"), (error) => {
    assert.equal(error.message, "knowledge_node_has_questions");
    assert.deepEqual(error.details.questionIds, ["noun-question"]);
    return true;
  });

  // 没有题目的节点：列表为空，且仍可正常删除。
  const unused = store.questionsForNode(bookId, "noun-grammar");
  assert.equal(unused.questions.length, 0);
});

test("node edits reject cycles and base deletions survive regeneration", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  assert.throws(() => store.updateNode(bookId, "noun", { parentId: "noun-kind" }), /knowledge_node_cycle/);
  store.deleteNode(bookId, "verb");
  let structure = store.get(bookId);
  assert.equal(structure.nodes.some((node) => ["verb", "verb-grammar"].includes(node.id)), false);
  structure = store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  assert.equal(structure.nodes.some((node) => ["verb", "verb-grammar"].includes(node.id)), false);
});

test("manual question assignments override automatic fingerprints and survive regeneration", () => {
  const questions = [question("feature-question", "现代汉语有什么语言特点？")];
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions });
  store.assignQuestions(bookId, [{ questionId: "feature-question", nodeId: "verb" }]);

  let fingerprint = store.get(bookId).fingerprints.find((item) => item.questionId === "feature-question");
  assert.equal(fingerprint.primaryNodeId, "verb");
  assert.equal(fingerprint.knowledgePath, "语法 > 词类 > 实词 > 动词");
  assert.equal(fingerprint.source, "manual_review");
  assert.equal(fingerprint.status, "confirmed");
  assert.equal(fingerprint.confidence, 1);

  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions });
  fingerprint = store.get(bookId).fingerprints.find((item) => item.questionId === "feature-question");
  assert.equal(fingerprint.primaryNodeId, "verb");
  assert.equal(fingerprint.source, "manual_review");
});

test("fill-gaps only adds missing nodes and never rewrites the existing tree", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  store.updateNode(bookId, "noun-kind", { title: "名词分类" });
  store.deleteNode(bookId, "verb-grammar");
  store.createNode(bookId, { title: "人工补充点", parentId: "noun" });
  const before = store.get(bookId);

  const extendedCatalog = [...catalogNodes, { id: "syntax", level: 2, title: "第二节 句法", startPage: 40, endPage: 60, order: 2 }];
  const result = store.fillGaps({ bookId, catalogNodes: extendedCatalog, outlineNodes, chunks: [], questions: [] });
  const after = store.get(bookId);

  // 只补了目录里新的那一节；人工改名、删除、新增都原样保留。
  assert.equal(result.addedNodeCount, 1);
  assert.equal(result.created, false);
  assert.equal(after.nodes.length, before.nodes.length + 1);
  assert.equal(after.nodes.find((node) => node.id === "syntax").title, "第二节 句法");
  assert.equal(after.nodes.find((node) => node.id === "noun-kind").displayTitle, "名词分类");
  assert.equal(after.nodes.some((node) => node.id === "verb-grammar"), false);
  assert.equal(after.nodes.filter((node) => node.parentId === "noun" && node.source === "manual").length, 1);

  // 再来一次：没有新节点可补，树完全不变。
  const again = store.fillGaps({ bookId, catalogNodes: extendedCatalog, outlineNodes, chunks: [], questions: [] });
  assert.equal(again.addedNodeCount, 0);
  assert.equal(store.get(bookId).nodes.length, after.nodes.length);
});

test("fill-gaps never resurrects a deleted position, even after its node id changes", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  store.deleteNode(bookId, "verb-grammar");
  assert.equal(store.get(bookId).nodes.some((node) => node.id === "verb-grammar"), false);

  // 模拟目录/正文重建后同一个小标题换了 id：位置没变，不应该被补回来。
  const renamedOutline = outlineNodes.map((node) => (node.id === "verb-grammar"
    ? { ...node, id: "verb-grammar-rebuilt" }
    : node));
  const result = store.fillGaps({ bookId, catalogNodes, outlineNodes: renamedOutline, chunks: [], questions: [] });
  assert.equal(result.addedNodeCount, 0);
  assert.equal(store.get(bookId).nodes.some((node) => node.id === "verb-grammar-rebuilt"), false);
});

test("fill-gaps skips nodes whose parent branch was deleted instead of creating orphans", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  store.deleteNode(bookId, "verb");
  assert.equal(store.get(bookId).nodes.some((node) => node.id === "verb"), false);

  const result = store.fillGaps({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  const structure = store.get(bookId);
  assert.equal(structure.nodes.some((node) => node.id === "verb"), false);
  assert.equal(structure.nodes.some((node) => String(node.parentId) === "verb"), false);
  assert.equal(result.addedNodeCount, 0);
});

test("every mutation snapshots the tree and a snapshot can be rolled back", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  store.updateNode(bookId, "noun-kind", { title: "名词分类" });
  assert.equal(store.get(bookId).nodes.find((node) => node.id === "noun-kind").displayTitle, "名词分类");

  const backups = store.listBackups(bookId);
  assert.equal(backups[0].reason, "update-node");
  assert.equal(backups[0].nodeCount, store.get(bookId).nodes.length);
  // 首次生成时还没有树可存，所以这里只有改名那一份。
  assert.equal(backups.length, 1);

  // 已有树时再完整重建，会先给旧树留一档。
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  assert.equal(store.listBackups(bookId)[0].reason, "generate");

  // 回滚到改名之前：记录和人工编辑日志一起还原。
  const restored = store.restoreBackup(bookId, backups[0].fileName);
  assert.equal(restored.restored, true);
  assert.equal(store.get(bookId).nodes.find((node) => node.id === "noun-kind").displayTitle, "名词的意义和种类");

  // 回滚本身也留了一档，可以再退回去。
  const afterRestore = store.listBackups(bookId);
  assert.equal(afterRestore[0].reason, "before-restore");
  assert.equal(afterRestore[0].nodeCount, store.get(bookId).nodes.length);
});

test("fill-gaps builds the tree when the book has none yet", () => {
  const store = createMemoryKnowledgeStructureStore();
  const result = store.fillGaps({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  assert.equal(result.created, true);
  assert.equal(result.existingNodeCount, 0);
  assert.equal(result.addedNodeCount, result.structure.nodes.length);
  assert.equal(store.get(bookId).nodes.length, result.structure.nodes.length);
});

test("manual backup can be created on demand and lists newest first", () => {
  const store = createMemoryKnowledgeStructureStore();
  store.generate({ bookId, catalogNodes, outlineNodes, chunks: [], questions: [] });
  const created = store.backup(bookId, { reason: "manual" });
  assert.equal(created.created, true);
  assert.equal(created.reason, "manual");
  const backups = store.listBackups(bookId);
  assert.equal(backups[0].fileName, created.fileName);
  // 首次生成没有可存内容，因此这里只有人工存档那一份。
  assert.equal(backups.length, 1);
  assert.equal(store.listBackups("another-book").length, 0);
});
