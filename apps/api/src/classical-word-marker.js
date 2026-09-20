function normalizeTarget(value) {
  const target = String(value || "").trim().replace(/[“”‘’"'【】]/g, "");
  return /^[\u3400-\u9fffA-Za-z]{1,12}$/.test(target) ? target : "";
}

function targetFromAnswer(answer) {
  const text = String(answer || "").trim();
  const leading = text.match(/^\s*[“”‘’"']?([\u3400-\u9fffA-Za-z]{1,12})[”’"']?\s*[：:]/);
  if (leading) return normalizeTarget(leading[1]);
  const quoted = text.match(/[“‘"']([^”’"']{1,12})[”’"']\s*(?:用作|通(?:“|假借)|解释为|意为|意思是|指|为)/);
  return quoted ? normalizeTarget(quoted[1]) : "";
}

function splitStemMarker(stem) {
  const text = String(stem || "").trim();
  const match = text.match(/^(.*?)(?:\n|\r\n)\s*(?:加点字词\s*)?([\u3400-\u9fffA-Za-z]{1,12})\s*[：:]\s*$/s);
  return match ? { stem: match[1].trim(), target: normalizeTarget(match[2]) } : { stem: text, target: "" };
}

function normalizeClassicalWordStem({ stem, annotationText, referenceAnswer }) {
  const existing = splitStemMarker(stem);
  const target = existing.target || normalizeTarget(annotationText) || targetFromAnswer(referenceAnswer);
  if (!target) return { stem: existing.stem, target: "", needsReview: true };
  return { stem: `${existing.stem}\n${target}：`, target, needsReview: false };
}

module.exports = { normalizeClassicalWordStem, targetFromAnswer };
