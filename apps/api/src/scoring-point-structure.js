const subjectiveQuestionTypes = new Set([
  "punctuation",
  "classical_word_explanation",
  "translation",
  "short_answer",
  "term_definition",
  "material_analysis",
  "appreciation",
  "essay",
]);

function markerMatches(text) {
  const matches = [];
  const addMatches = (pattern) => {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      const markerOffset = raw.search(/[^\s\n]/);
      matches.push({
        start: match.index + Math.max(0, markerOffset),
        contentStart: match.index + raw.length,
        marker: raw.trim(),
      });
    }
  };

  // Parenthesized and circled numbers commonly appear inline in answer keys.
  addMatches(/[（(]\s*\d{1,2}\s*[）)]\s*/g);
  addMatches(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*/g);
  // Plain Arabic and Chinese list numbers are only accepted at a line boundary.
  addMatches(/(?:^|\n)\s*\d{1,2}[.、．]\s*/g);
  addMatches(/(?:^|\n)\s*[一二三四五六七八九十]+、\s*/g);

  return matches
    .sort((left, right) => left.start - right.start || left.contentStart - right.contentStart)
    .filter((item, index, items) => index === 0 || item.start !== items[index - 1].start);
}

function detectScoringPointCandidates(referenceAnswer) {
  const text = String(referenceAnswer || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const markers = markerMatches(text);
  if (markers.length < 2) return [];
  return markers.map((marker, index) => ({
    marker: marker.marker,
    description: text.slice(marker.contentStart, markers[index + 1]?.start ?? text.length).trim(),
  })).filter((item) => item.description).slice(0, 30);
}

function scoringPointStructure(type, referenceAnswer, scoringPoints, maxScore) {
  if (!subjectiveQuestionTypes.has(type)) {
    return { status: "not_required", candidates: [], candidateCount: 0 };
  }
  const points = Array.isArray(scoringPoints) ? scoringPoints : [];
  const total = points.reduce((sum, point) => sum + (Number(point && point.score) || 0), 0);
  if (points.length && Math.abs(total - Number(maxScore)) <= 0.001) {
    return { status: "complete", candidates: [], candidateCount: 0 };
  }
  if (points.length) {
    return {
      status: "score_mismatch",
      candidates: points.map((point) => ({ marker: "", description: String(point.description || "").trim() })).filter((item) => item.description),
      candidateCount: points.length,
    };
  }
  const candidates = detectScoringPointCandidates(referenceAnswer);
  if (candidates.length) return { status: "needs_score_allocation", candidates, candidateCount: candidates.length };
  return { status: "needs_split", candidates: [], candidateCount: 0 };
}

module.exports = {
  detectScoringPointCandidates,
  scoringPointStructure,
  subjectiveQuestionTypes,
};
