(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuestionEnrichmentDiff = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  const text = value => String(value || "").trim();
  const present = value => Boolean(text(value)) && !/^(待归类|未归类|待补充|未知|暂无|无)$/.test(text(value));
  const set = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(present))].sort();
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const scoringContent = points => (Array.isArray(points) ? points : []).map(point => ({
    description: text(point.description), score: Number(point.score), textbookPage: text(point.textbookPage),
  }));
  function suggestionChanges(item) {
    const q = item?.question || {};
    const s = item?.suggestion;
    if (s?.status !== "recommended" || Number(s.questionVersion) !== Number(q.version)) return [];
    const changes = [
      ["subject", q.subjectId, s.subjectId], ["book", q.bookId, s.bookId], ["chapter", q.chapter, s.catalogPath],
    ].filter(([, current, proposed]) => present(proposed) && text(current) !== text(proposed)).map(([key]) => key);
    if (set(s.knowledgePoints).length && !same(set(q.knowledgePoints), set(s.knowledgePoints))) changes.push("knowledge");
    if (s.scoringPoints?.length && !same(scoringContent(q.scoringPoints), scoringContent(s.scoringPoints))) changes.push("scoring");
    return changes;
  }
  return { suggestionChanges };
});
