const { catalogNodesWithPaths, normalizeSearchText } = require("./textbook-knowledge-store");

const LITERATURE_SUBJECTS = new Set([
  "ancient-literature",
  "modern-literature",
  "contemporary-literature",
]);

function compactText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\u3400-\u9fffa-z0-9]/gi, "");
}

function extractWorkTitles(question) {
  const collect = (value) => {
    const titles = [];
    for (const match of value.matchAll(/[《〈]([^》〉\n]{2,40})[》〉]/g)) {
      const title = String(match[1] || "").trim()
        .replace(/[（(]\s*其?[一二三四五六七八九十百零〇0-9]+\s*[）)]$/u, "")
        .trim();
      if (title && !titles.some((item) => compactText(item) === compactText(title))) titles.push(title);
    }
    return titles;
  };
  const stemTitles = collect(String(question && question.stem || ""));
  if (stemTitles.length) return stemTitles.slice(0, 4);
  // When the stem omits the work name, imported reading materials conventionally
  // put their title first. Later quoted works are often comparisons or citations.
  const leadingMaterialTitles = collect(String(question && question.material || "").slice(0, 500));
  return leadingMaterialTitles[0] ? [leadingMaterialTitles[0]] : [];
}

function extractQuotedTerms(question) {
  const stem = String(question && question.stem || "");
  const terms = [];
  for (const match of stem.matchAll(/[“‘\"]([^”’\"\n]{2,30})[”’\"]/g)) {
    const term = String(match[1] || "").trim();
    if (term && !terms.some((item) => compactText(item) === compactText(term))) terms.push(term);
  }
  return terms.slice(0, 6);
}

function questionRetrievalText(question) {
  return [
    question && question.stem,
    ...(Array.isArray(question && question.options)
      ? question.options.map((option) => `${option && option.key || ""} ${option && option.text || ""}`)
      : []),
    ...(Array.isArray(question && question.knowledgePoints) ? question.knowledgePoints : []),
  ].map((item) => String(item || "").trim()).filter(Boolean).join("\n").slice(0, 6000);
}

function likelyCreator(question) {
  const chapter = String(question && question.chapter || "")
    .replace(/^.*?第[一二三四五六七八九十百零〇0-9]+章\s*/u, "")
    .trim();
  if (/^[\u3400-\u9fff]{2,8}$/.test(chapter)) return chapter;
  const lines = String(question && question.material || "").split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean).slice(0, 8);
  const titleIndex = lines.findIndex((line) => /[《〈][^》〉]+[》〉]/.test(line));
  const candidate = lines[titleIndex >= 0 ? titleIndex + 1 : 0] || "";
  return /^[\u3400-\u9fff]{2,8}(?:\s+(?:著|作))?$/.test(candidate)
    ? candidate.replace(/\s+(?:著|作)$/, "") : "";
}

function catalogNodeForChapter(chapter, nodes) {
  const source = String(chapter || "").trim();
  if (!source) return null;
  const compact = compactText(source);
  const lastSegment = compactText(source.split(/\s*(?:>|›|·|\/|\\)\s*/).filter(Boolean).pop() || source);
  if (!compact) return null;
  return (Array.isArray(nodes) ? nodes : []).find((node) => (
    compactText(node.path) === compact
    || compactText(node.title) === compact
    || (lastSegment && compactText(node.title) === lastSegment)
  )) || null;
}

function uniqueChunks(chunks) {
  const seen = new Set();
  return (Array.isArray(chunks) ? chunks : []).filter((chunk) => {
    const text = normalizeSearchText(typeof chunk.retrievalText === "string" ? chunk.retrievalText : chunk.text);
    const key = text.slice(0, 500);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function containsAnchor(chunk, anchors) {
  const text = compactText(typeof chunk.retrievalText === "string" ? chunk.retrievalText : chunk.text);
  return anchors.some((anchor) => {
    const compactAnchor = compactText(anchor);
    if (!compactAnchor) return false;
    if (text.includes(compactAnchor)) return true;
    if (!/^[\u3400-\u9fff]{3,12}$/.test(compactAnchor)) return false;
    const flexibleClassicalPhrase = new RegExp([...compactAnchor].join("[而以之其于]?"), "u");
    return flexibleClassicalPhrase.test(text);
  });
}

function bestCatalogNode(nodes, directChunks, creator) {
  const candidates = (Array.isArray(nodes) ? nodes : []).map((node) => {
    const matchingChunks = directChunks.filter((chunk) => (
      String(chunk.catalogPath || "") === node.path
      || String(chunk.catalogPath || "").startsWith(`${node.path} > `)
    ));
    const creatorMatch = creator && compactText(node.title).includes(compactText(creator));
    const chapterLike = /^第[一二三四五六七八九十百零〇0-9]+章/u.test(String(node.title || "").trim());
    return {
      node,
      matchingCount: matchingChunks.length,
      creatorMatch,
      score: (matchingChunks.length * 10) + (creatorMatch ? 50 : 0) + (chapterLike ? 5 : 0)
        - Math.max(0, Number(node.level || 1) - 2),
    };
  }).filter((item) => item.matchingCount > 0);
  const creatorCandidates = candidates.filter((item) => item.creatorMatch);
  const ranked = (creatorCandidates.length ? creatorCandidates : candidates)
    .sort((left, right) => right.score - left.score || Number(left.node.level) - Number(right.node.level));
  return ranked[0] && ranked[0].node || null;
}

function bestSemanticCatalogNode(nodes, chunks) {
  const groups = new Map();
  (Array.isArray(chunks) ? chunks : []).forEach((chunk) => {
    const catalogPath = String(chunk.catalogPath || "");
    if (!catalogPath || /(?:^| > )(?:附录|.*年表|索引|后记)(?:$| > )/u.test(catalogPath)) return;
    if (!groups.has(catalogPath)) groups.set(catalogPath, []);
    groups.get(catalogPath).push(chunk);
  });
  const rankedGroups = [...groups.entries()].map(([catalogPath, matchingChunks]) => ({
    catalogPath,
    matchingChunks,
    matchingCount: matchingChunks.length,
    maxScore: Math.max(0, ...matchingChunks.map((chunk) => Number(chunk.score) || 0)),
    totalScore: matchingChunks.reduce((total, chunk) => total + (Number(chunk.score) || 0), 0),
  })).sort((left, right) => (
    right.maxScore - left.maxScore
    || right.matchingCount - left.matchingCount
    || right.totalScore - left.totalScore
  ));
  const strongest = rankedGroups[0];
  if (!strongest) return null;
  const node = (Array.isArray(nodes) ? nodes : [])
    .filter((item) => strongest.catalogPath === item.path || strongest.catalogPath.startsWith(`${item.path} > `))
    .sort((left, right) => Number(right.level || 1) - Number(left.level || 1))[0];
  return node ? { ...strongest, node } : null;
}

function semanticNodeShouldReplaceCurrent(semantic, currentNode, anchors) {
  if (!semantic || !semantic.node || !currentNode || anchors.length) return false;
  if (semantic.node.path === currentNode.path) return false;
  const currentChunks = semantic.allChunks.filter((chunk) => (
    String(chunk.catalogPath || "") === currentNode.path
    || String(chunk.catalogPath || "").startsWith(`${currentNode.path} > `)
  ));
  const currentBestScore = Math.max(0, ...currentChunks.map((chunk) => Number(chunk.score) || 0));
  return semantic.matchingCount >= 2
    && semantic.maxScore >= 0.15
    && semantic.maxScore >= currentBestScore + 0.06;
}

function candidateBooks(question, books) {
  const current = (Array.isArray(books) ? books : []).find((book) => book.id === question.bookId);
  if (!current && !question.bookId) {
    return (Array.isArray(books) ? books : []).filter((book) => LITERATURE_SUBJECTS.has(book.subjectId));
  }
  if (!current || !LITERATURE_SUBJECTS.has(current.subjectId)) {
    return (Array.isArray(books) ? books : []).filter((book) => book.id === question.bookId);
  }
  return books.filter((book) => LITERATURE_SUBJECTS.has(book.subjectId));
}

function resolveQuestionTextbookContext({ question, books, getCatalog, getKnowledge, search }) {
  const workTitles = extractWorkTitles(question);
  const anchors = [...workTitles];
  extractQuotedTerms(question).forEach((term) => {
    if (!anchors.some((item) => compactText(item) === compactText(term))) anchors.push(term);
  });
  const creator = likelyCreator(question);
  const semanticQuery = questionRetrievalText(question);
  const candidates = candidateBooks(question, books).map((book) => {
    const catalog = getCatalog(book.id);
    const nodes = catalogNodesWithPaths(catalog && catalog.confirmed && catalog.confirmed.nodes)
      .filter((node) => node.id && node.path);
    const knowledge = getKnowledge(book.id);
    const searchable = knowledge && ["ready", "partial", "building"].includes(knowledge.status)
      && Number(knowledge.chunkCount) > 0;
    const anchorQuery = anchors.join(" ");
    const rawAnchorChunks = searchable && anchorQuery ? search(book.id, anchorQuery, { limit: 20 }) : [];
    const directChunks = uniqueChunks(rawAnchorChunks.filter((chunk) => containsAnchor(chunk, anchors)));
    const node = bestCatalogNode(nodes, directChunks, creator);
    const declaredChapterNode = catalogNodeForChapter(question.chapter, nodes);
    const currentChapterNode = book.id === question.bookId ? declaredChapterNode : null;
    const semanticChunks = searchable && !anchors.length && semanticQuery
      ? uniqueChunks(search(book.id, semanticQuery, { limit: 12 }))
      : [];
    const semanticNode = bestSemanticCatalogNode(nodes, semanticChunks);
    if (semanticNode) semanticNode.allChunks = semanticChunks;
    const exactPages = new Set(directChunks.map((chunk) => Number(chunk.printedPageStart)).filter((page) => page > 0));
    const score = (directChunks.length * 12) + (exactPages.size * 2)
      + (node && creator && compactText(node.title).includes(compactText(creator)) ? 8 : 0)
      + (declaredChapterNode ? 18 : 0);
    return { book, nodes, searchable, directChunks, node, declaredChapterNode, currentChapterNode, semanticChunks, semanticNode, score };
  }).sort((left, right) => right.score - left.score);

  const current = candidates.find((candidate) => candidate.book.id === question.bookId) || null;
  const best = candidates[0] || current;
  const currentDirectCount = current ? current.directChunks.length : 0;
  const bestDirectCount = best ? best.directChunks.length : 0;
  const invalidCurrentChapter = Boolean(question.chapter && current && !current.currentChapterNode);
  const unresolvedBookEvidence = Boolean(!current && best
    && best.declaredChapterNode
    && bestDirectCount >= 1);
  const decisiveWorkEvidence = Boolean(workTitles.length && best && best.book.id !== question.bookId
    && (unresolvedBookEvidence
      || (bestDirectCount >= 2
        && (bestDirectCount >= Math.max(2, currentDirectCount * 2)
          || (invalidCurrentChapter && bestDirectCount >= currentDirectCount + 2)))));
  const selected = decisiveWorkEvidence || unresolvedBookEvidence ? best : (current || best);
  const selectedNode = selected && selected.book.id === question.bookId
    ? (semanticNodeShouldReplaceCurrent(selected.semanticNode, selected.currentChapterNode, anchors)
      ? selected.semanticNode.node
      : (selected.currentChapterNode || selected.node || selected.semanticNode && selected.semanticNode.node))
    : selected && (selected.declaredChapterNode || selected.node) || null;
  const focusedQuery = [anchors.join(" "), semanticQuery]
    .filter(Boolean).join("\n").slice(0, 4000);
  const focusedChunks = selected && selected.searchable && focusedQuery
    ? search(selected.book.id, focusedQuery, {
      limit: 12,
      ...(selectedNode ? { catalogPathPrefix: selectedNode.path } : {}),
    })
    : [];
  const directInNode = selectedNode
    ? selected.directChunks.filter((chunk) => String(chunk.catalogPath || "") === selectedNode.path
      || String(chunk.catalogPath || "").startsWith(`${selectedNode.path} > `))
    : selected && selected.directChunks || [];
  const evidenceChunks = uniqueChunks([...directInNode, ...focusedChunks]).slice(0, 12);

  return {
    anchors,
    workTitles,
    creator,
    changed: Boolean(selected && selected.book.id !== question.bookId),
    highConfidence: decisiveWorkEvidence || unresolvedBookEvidence,
    invalidCurrentChapter,
    book: selected && selected.book || null,
    nodes: selected && selected.nodes || [],
    chapterNode: selectedNode,
    directEvidenceChunks: directInNode,
    evidenceChunks,
    candidates: candidates.map((candidate) => ({
      bookId: candidate.book.id,
      subjectId: candidate.book.subjectId,
      score: candidate.score,
      directHitCount: candidate.directChunks.length,
      chapter: candidate.node && candidate.node.path || "",
    })),
  };
}

function evidencePageRange(chunks) {
  const pages = (Array.isArray(chunks) ? chunks : []).flatMap((chunk) => {
    const start = Number(chunk.printedPageStart);
    const end = Number(chunk.printedPageEnd) || start;
    return start > 0 ? [start, Math.max(start, end)] : [];
  });
  if (!pages.length) return "";
  const start = Math.min(...pages);
  const end = Math.max(...pages);
  return start === end ? String(start) : `${start}-${end}`;
}

module.exports = {
  catalogNodeForChapter,
  evidencePageRange,
  extractQuotedTerms,
  extractWorkTitles,
  resolveQuestionTextbookContext,
};
