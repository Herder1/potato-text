"use strict";

const { splitChapterSegments } = require("./chapter-path-normalizer");

// Only normalize presentation differences. Parenthetical qualifiers and every
// path segment remain significant; fuzzy matches must not imply an assignment.
function sourcePathKey(value) {
  return splitChapterSegments(String(value || "").normalize("NFKC")).map(segment => segment
    .trim().replace(/^☆+\s*/, "")
    .replace(/^第[一二三四五六七八九十百零〇两0-9]+(?:单元|部分|章|节|篇|编|讲)\s*/, "")
    .replace(/^[（(][一二三四五六七八九十百零〇两0-9]+[）)]\s*/, "")
    .replace(/^[一二三四五六七八九十百零〇两]+[、.]\s*/, "")
    .replace(/^\d+[.、]\s*/, "")
    .replace(/[.。]+$/, "").replace(/\s+/g, "").toLowerCase()).join(">");
}

function questionSourceDirectory(questions, directory, selectedNodeId = "") {
  const nodes = directory.dossierNodes || [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const byPath = new Map();
  for (const node of nodes) {
    const key = sourcePathKey(node.path);
    if (!key) continue;
    const ids = byPath.get(key) || new Set();
    ids.add(node.id);
    byPath.set(key, ids);
  }
  const nodeQuestions = new Map(nodes.map(node => [node.id, new Set()]));
  const allIds = new Set(), locatedIds = new Set(), unlocatedIds = new Set();
  for (const question of questions) {
    allIds.add(question.id);
    const matches = question.bookId === directory.bookId && byPath.get(sourcePathKey(question.chapter));
    if (!matches || matches.size !== 1) { unlocatedIds.add(question.id); continue; }
    locatedIds.add(question.id);
    let node = byId.get([...matches][0]);
    const visited = new Set();
    while (node && !visited.has(node.id)) {
      visited.add(node.id);
      nodeQuestions.get(node.id).add(question.id);
      node = byId.get(node.parentId);
    }
  }
  const selected = selectedNodeId === "__unlocated__" ? unlocatedIds : nodeQuestions.get(selectedNodeId);
  return {
    questions: selectedNodeId ? questions.filter(question => selected?.has(question.id)) : questions,
    treeSummary: {
      bookId: directory.bookId, directory: "source", questionCount: allIds.size,
      locatedQuestionCount: locatedIds.size, unlocatedQuestionCount: unlocatedIds.size,
      nodeQuestionCounts: Object.fromEntries([...nodeQuestions].map(([id, ids]) => [id, ids.size])),
    },
  };
}

module.exports = { questionSourceDirectory, sourcePathKey };
