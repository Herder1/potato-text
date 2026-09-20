const CLOZE_COLOR = "#168fd8";
const HIGHLIGHT_COLOR = "#fff0a8";

function normalizeEditorText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextToHtml(value) {
  const lines = normalizeEditorText(value).split("\n");
  return lines.map((line) => `<p>${line ? escapeHtml(line) : "<br>"}</p>`).join("");
}

function plainTextToDelta(value) {
  const text = normalizeEditorText(value);
  return { ops: [{ insert: `${text}\n` }] };
}

function normalizeDelta(delta, fallbackText = "") {
  if (!delta || !Array.isArray(delta.ops) || !delta.ops.length) return plainTextToDelta(fallbackText);
  return {
    ops: delta.ops.map((op) => ({
      ...op,
      attributes: op.attributes ? { ...op.attributes } : undefined,
    })),
  };
}

function deltaText(delta, fallbackText = "") {
  const normalized = normalizeDelta(delta, fallbackText);
  return normalizeEditorText(normalized.ops.map((op) => typeof op.insert === "string" ? op.insert : "").join(""));
}

function normalizedColor(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function isClozeAttributes(attributes = {}) {
  const color = normalizedColor(attributes.color);
  return Boolean(attributes.underline) && (color === CLOZE_COLOR || color === "rgb(22,143,216)");
}

function isHighlightAttributes(attributes = {}) {
  const color = normalizedColor(attributes.backgroundColor || attributes.background);
  return color === HIGHLIGHT_COLOR || color === "rgb(255,240,168)";
}

function answerSegmentsFromDelta(delta, fallbackText = "") {
  const normalized = normalizeDelta(delta, fallbackText);
  const segments = [];
  normalized.ops.forEach((op) => {
    if (typeof op.insert !== "string" || !op.insert) return;
    const cloze = isClozeAttributes(op.attributes);
    const previous = segments[segments.length - 1];
    if (previous && previous.cloze === cloze) previous.text += op.insert;
    else segments.push({ text: op.insert, cloze });
  });
  if (segments.length) segments[segments.length - 1].text = segments[segments.length - 1].text.replace(/\n+$/, "");
  return segments.filter((segment) => segment.text);
}

function sameAttributes(left = {}, right = {}) {
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined).sort();
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function pushDeltaOp(ops, insert, attributes) {
  if (!insert) return;
  const cleaned = attributes && Object.keys(attributes).length ? attributes : undefined;
  const previous = ops[ops.length - 1];
  if (previous && typeof previous.insert === "string" && sameAttributes(previous.attributes, cleaned)) {
    previous.insert += insert;
    return;
  }
  ops.push(cleaned ? { insert, attributes: cleaned } : { insert });
}

function applyAttributesToRanges(delta, ranges, attributes, fallbackText = "") {
  const normalized = normalizeDelta(delta, fallbackText);
  const safeRanges = (ranges || [])
    .map((range) => ({ start: Math.max(0, Number(range.start) || 0), end: Math.max(0, Number(range.end) || 0) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  if (!safeRanges.length) return normalized;

  const ops = [];
  let offset = 0;
  normalized.ops.forEach((op) => {
    if (typeof op.insert !== "string") {
      ops.push({ ...op, attributes: op.attributes ? { ...op.attributes } : undefined });
      return;
    }
    const length = op.insert.length;
    const boundaries = new Set([0, length]);
    safeRanges.forEach((range) => {
      if (range.end <= offset || range.start >= offset + length) return;
      boundaries.add(Math.max(0, range.start - offset));
      boundaries.add(Math.min(length, range.end - offset));
    });
    const points = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const absoluteStart = offset + start;
      const marked = safeRanges.some((range) => absoluteStart >= range.start && absoluteStart < range.end);
      const nextAttributes = marked ? { ...(op.attributes || {}), ...attributes } : { ...(op.attributes || {}) };
      pushDeltaOp(ops, op.insert.slice(start, end), nextAttributes);
    }
    offset += length;
  });
  return { ops };
}

function removeHighlightAttributes(delta, fallbackText = "") {
  const normalized = normalizeDelta(delta, fallbackText);
  const ops = [];
  normalized.ops.forEach((op) => {
    if (typeof op.insert !== "string") {
      ops.push({ ...op, attributes: op.attributes ? { ...op.attributes } : undefined });
      return;
    }
    const attributes = { ...(op.attributes || {}) };
    ["backgroundColor", "background"].forEach((name) => {
      const color = normalizedColor(attributes[name]);
      if (color === HIGHLIGHT_COLOR || color === "rgb(255,240,168)") delete attributes[name];
    });
    pushDeltaOp(ops, op.insert, attributes);
  });
  return { ops };
}

function trimRange(text, start, end) {
  let left = start;
  let right = end;
  while (left < right && /\s/u.test(text[left])) left += 1;
  while (right > left && /\s/u.test(text[right - 1])) right -= 1;
  return { start: left, end: right, text: text.slice(left, right) };
}

function splitAnswerPointRanges(value) {
  const text = normalizeEditorText(value);
  if (!text) return [];

  const markers = [];
  const markerPattern = /(?:\d{1,2}[.、．]|[（(]\d{1,2}[）)])(?=[\u3400-\u9fffA-Za-z])/gu;
  let match = markerPattern.exec(text);
  while (match) {
    if (match.index === 0 || !/\d/.test(text[match.index - 1])) markers.push(match.index);
    match = markerPattern.exec(text);
  }
  if (markers.length >= 2) {
    const ranges = [];
    if (markers[0] > 0) ranges.push(trimRange(text, 0, markers[0]));
    markers.forEach((start, index) => ranges.push(trimRange(text, start, markers[index + 1] === undefined ? text.length : markers[index + 1])));
    return ranges.filter((range) => range.text);
  }

  const lineRanges = [];
  const linePattern = /[^\n]+/gu;
  match = linePattern.exec(text);
  while (match) {
    lineRanges.push(trimRange(text, match.index, match.index + match[0].length));
    match = linePattern.exec(text);
  }
  if (lineRanges.length >= 2) return lineRanges.filter((range) => range.text);

  const sentenceRanges = [];
  let start = 0;
  const separatorPattern = /[；;。]+/gu;
  match = separatorPattern.exec(text);
  while (match) {
    sentenceRanges.push(trimRange(text, start, match.index + match[0].length));
    start = match.index + match[0].length;
    match = separatorPattern.exec(text);
  }
  if (start < text.length) sentenceRanges.push(trimRange(text, start, text.length));
  if (sentenceRanges.filter((range) => range.text).length >= 2) return sentenceRanges.filter((range) => range.text);

  const listParts = text.split("、").map((item) => item.trim()).filter(Boolean);
  if (listParts.length >= 3) {
    let cursor = 0;
    return listParts.map((part) => {
      const partStart = text.indexOf(part, cursor);
      cursor = partStart + part.length;
      return { start: partStart, end: cursor, text: part };
    });
  }
  return [{ start: 0, end: text.length, text }];
}

function splitAnswerPoints(value) {
  return splitAnswerPointRanges(value).map((range) => range.text);
}

function isKeywordChar(char) {
  return Boolean(char) && /[\u3400-\u9fffA-Za-z0-9]/u.test(char);
}

function suggestedRangeForPoint(fullText, pointRange) {
  const point = pointRange.text;
  const marker = point.match(/^(?:\d{1,2}[.、．]|[（(]\d{1,2}[）)])\s*/u);
  const markerLength = marker ? marker[0].length : 0;
  let bodyStart = markerLength;
  const clauseMatches = [...point.matchAll(/[，,：:；;、]/gu)];
  if (clauseMatches.length) bodyStart = clauseMatches[clauseMatches.length - 1].index + 1;
  while (bodyStart < point.length && !isKeywordChar(point[bodyStart])) bodyStart += 1;
  let bodyEnd = point.length;
  while (bodyEnd > bodyStart && !isKeywordChar(point[bodyEnd - 1])) bodyEnd -= 1;
  const keywordIndexes = [];
  for (let index = bodyStart; index < bodyEnd; index += 1) if (isKeywordChar(point[index])) keywordIndexes.push(index);
  if (!keywordIndexes.length) return null;
  const wanted = Math.min(8, Math.max(2, Math.ceil(keywordIndexes.length * .38)));
  const selected = keywordIndexes.slice(-wanted);
  return {
    start: pointRange.start + selected[0],
    end: pointRange.start + selected[selected.length - 1] + 1,
  };
}

function suggestKeyRanges(value) {
  const text = normalizeEditorText(value);
  return splitAnswerPointRanges(text)
    .map((range) => suggestedRangeForPoint(text, range))
    .filter(Boolean);
}

function suggestClozePhrases(value) {
  const text = normalizeEditorText(value);
  return suggestKeyRanges(text).map((range) => text.slice(range.start, range.end)).filter(Boolean);
}

function clozeTextsFromSegments(segments = []) {
  return segments
    .filter((segment) => segment && segment.cloze)
    .flatMap((segment) => String(segment.text || "").split(/\n+/))
    .map((text) => text.trim())
    .filter(Boolean);
}

function mergeRanges(ranges = []) {
  return ranges
    .map((range) => ({ start: Math.max(0, Number(range.start) || 0), end: Math.max(0, Number(range.end) || 0) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
      return merged;
    }, []);
}

function markedRangesFromDelta(delta, fallbackText = "") {
  if (!delta || !Array.isArray(delta.ops)) return { cloze: [], highlight: [] };
  const normalized = normalizeDelta(delta, fallbackText);
  const ranges = { cloze: [], highlight: [] };
  let offset = 0;
  normalized.ops.forEach((op) => {
    if (typeof op.insert !== "string") return;
    const start = offset;
    offset += op.insert.length;
    if (isClozeAttributes(op.attributes)) ranges.cloze.push({ start, end: offset });
    if (isHighlightAttributes(op.attributes)) ranges.highlight.push({ start, end: offset });
  });
  return { cloze: mergeRanges(ranges.cloze), highlight: mergeRanges(ranges.highlight) };
}

function clozeRangesFromSegments(answer, segments = []) {
  const ranges = [];
  let cursor = 0;
  (segments || []).forEach((segment) => {
    const text = String(segment && segment.text || "");
    if (!text) return;
    const start = answer.indexOf(text, cursor);
    if (start < 0) return;
    const end = start + text.length;
    if (segment.cloze) ranges.push({ start, end });
    cursor = end;
  });
  return mergeRanges(ranges);
}

function rangeContains(ranges, index) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function pointDetails(answer) {
  return splitAnswerPointRanges(answer).map((range, index) => {
    const markerMatch = range.text.match(/^(?:\d{1,2}[.、．]|[（(]\d{1,2}[）)])/u);
    const marker = markerMatch ? markerMatch[0] : `${index + 1}.`;
    const bodyStart = range.start + (markerMatch ? markerMatch[0].length : 0);
    return {
      key: `hint-line-${index}-${range.start}`,
      marker,
      bodyStart,
      bodyEnd: range.end,
      body: answer.slice(bodyStart, range.end),
    };
  });
}

function keywordPositions(answer, start, end) {
  const positions = [];
  for (let index = start; index < end; index += 1) {
    if (isKeywordChar(answer[index])) positions.push(index);
  }
  return positions;
}

function revealWindow(answer, point, center, radius = 1) {
  const positions = keywordPositions(answer, point.bodyStart, point.bodyEnd);
  const centerIndex = positions.indexOf(center);
  if (centerIndex < 0) return [];
  const windowStart = Math.max(0, centerIndex - radius);
  const windowEnd = Math.min(positions.length - 1, centerIndex + radius);
  const first = positions[windowStart];
  const last = positions[windowEnd];
  const visible = [];
  for (let index = first; index <= last; index += 1) visible.push(index);
  return visible;
}

function rangesForPoint(answer, ranges, point) {
  return (ranges || [])
    .map((range) => ({
      start: Math.max(range.start, point.bodyStart),
      end: Math.min(range.end, point.bodyEnd),
    }))
    .filter((range) => range.end > range.start && keywordPositions(answer, range.start, range.end).length);
}

function terminalPunctuationPositions(answer, point) {
  const punctuation = /[。！？；.!?]/u;
  const closing = /[”’」』）》】]/u;
  const positions = [];
  let index = point.bodyEnd - 1;
  while (index >= point.bodyStart && /\s/u.test(answer[index])) index -= 1;
  while (index >= point.bodyStart && closing.test(answer[index])) {
    positions.unshift(index);
    index -= 1;
  }
  if (index >= point.bodyStart && punctuation.test(answer[index])) positions.unshift(index);
  else return [];
  return positions;
}

function revealWindowsForPoint(answer, point, primaryRanges, seed, primaryOnly = false) {
  const effective = keywordPositions(answer, point.bodyStart, point.bodyEnd);
  const primary = new Set(effective.filter((position) => rangeContains(primaryRanges, position)));
  const candidates = effective.filter((position) => !primaryOnly || primary.has(position)).map((position, index) => ({
    position,
    priority: primary.has(position) ? 0 : 1,
    interior: index > 0 && index < effective.length - 1,
    rank: seedNumber(`${seed}:${point.key}:${position}`),
  })).sort((left, right) => left.priority - right.priority
    || Number(right.interior) - Number(left.interior)
    || left.rank - right.rank);

  const signatures = new Set();
  return candidates.reduce((windows, candidate) => {
    const positions = revealWindow(answer, point, candidate.position);
    const effectivePositions = positions.filter((position) => isKeywordChar(answer[position]));
    const signature = effectivePositions.join(":");
    if (!signature || signatures.has(signature)) return windows;
    signatures.add(signature);
    windows.push({
      key: `${point.key}-window-${candidate.position}`,
      priority: candidate.priority,
      rank: candidate.rank,
      positions,
      effectivePositions,
    });
    return windows;
  }, []);
}

function effectiveVisibleCount(answer, point, visible) {
  return keywordPositions(answer, point.bodyStart, point.bodyEnd)
    .filter((position) => visible.has(position)).length;
}

function addWindow(visible, selected, window) {
  window.positions.forEach((position) => visible.add(position));
  selected.add(window.key);
}

function chooseWindow(answer, point, windows, visible, selected, target, upper, mandatory = false) {
  const total = keywordPositions(answer, point.bodyStart, point.bodyEnd).length;
  const candidates = windows.map((window) => {
    if (selected.has(window.key)) return null;
    const gain = window.effectivePositions.filter((position) => !visible.has(position)).length;
    if (!gain) return null;
    const result = effectiveVisibleCount(answer, point, visible) + gain;
    return {
      ...window,
      gain,
      result,
      completeWindow: gain >= Math.min(3, total),
      fits: result <= upper,
      distance: Math.abs(target - result),
    };
  }).filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    if (mandatory && left.completeWindow !== right.completeWindow) return Number(right.completeWindow) - Number(left.completeWindow);
    if (left.fits !== right.fits) return Number(right.fits) - Number(left.fits);
    return left.priority - right.priority || left.distance - right.distance || left.rank - right.rank;
  });
  return candidates[0];
}

function visiblePositionsForLevel(answer, point, baseVisible, windows, level) {
  const total = keywordPositions(answer, point.bodyStart, point.bodyEnd).length;
  const eligibleTotal = new Set(windows.flatMap((window) => window.effectivePositions)).size;
  const visible = new Set(baseVisible);
  const selected = new Set();
  if (level < 2 || !total || !eligibleTotal || !windows.length) return visible;

  const minimumWindow = Math.min(3, eligibleTotal);
  const secondTarget = Math.min(
    eligibleTotal,
    Math.max(minimumWindow, Math.min(Math.round(total * .2), Math.ceil(eligibleTotal * .55))),
  );
  const secondUpper = Math.min(eligibleTotal, Math.max(secondTarget, Math.floor(total * .25)));
  const firstWindow = chooseWindow(answer, point, windows, visible, selected, secondTarget, secondUpper, true);
  if (firstWindow) addWindow(visible, selected, firstWindow);
  while (effectiveVisibleCount(answer, point, visible) < secondTarget) {
    const next = chooseWindow(answer, point, windows, visible, selected, secondTarget, secondUpper);
    if (!next || (!next.fits && effectiveVisibleCount(answer, point, visible) >= Math.ceil(total * .15))) break;
    addWindow(visible, selected, next);
  }
  if (level < 3) return visible;

  const secondCount = effectiveVisibleCount(answer, point, visible);
  const thirdTarget = Math.min(
    eligibleTotal,
    Math.max(
      secondCount + (eligibleTotal > secondCount ? 1 : 0),
      Math.min(Math.round(total * .42), Math.ceil(eligibleTotal * .85)),
    ),
  );
  const thirdUpper = eligibleTotal;
  const growthWindow = chooseWindow(answer, point, windows, visible, selected, thirdTarget, thirdUpper);
  if (growthWindow) addWindow(visible, selected, growthWindow);
  while (effectiveVisibleCount(answer, point, visible) < thirdTarget) {
    const next = chooseWindow(answer, point, windows, visible, selected, thirdTarget, thirdUpper);
    if (!next || (!next.fits && effectiveVisibleCount(answer, point, visible) >= Math.ceil(total * .35))) break;
    addWindow(visible, selected, next);
  }
  return visible;
}

function hintParts(body, bodyStart, visiblePositions) {
  const parts = [];
  let index = 0;
  while (index < body.length) {
    const visible = visiblePositions.has(bodyStart + index);
    let end = index + 1;
    while (end < body.length && visiblePositions.has(bodyStart + end) === visible) end += 1;
    const length = end - index;
    if (visible) {
      parts.push({ key: `text-${index}`, type: "text", text: body.slice(index, end) });
    } else {
      const hiddenText = body.slice(index, end);
      parts.push({
        key: `gap-${index}`,
        type: "gap",
        text: hiddenText,
        hiddenLength: Array.from(hiddenText).length,
      });
    }
    index = end;
  }
  return parts;
}

function buildHintLines(card, level) {
  const answer = normalizeEditorText(card && card.answer || deltaText(card && card.answerDelta));
  if (!answer) return [];
  const safeLevel = Math.max(1, Math.min(3, Number(level) || 1));
  const points = pointDetails(answer);
  const deltaRanges = markedRangesFromDelta(card && card.answerDelta, answer);
  const segmentRanges = clozeRangesFromSegments(answer, card && card.answerSegments);
  const clozeRanges = mergeRanges([...deltaRanges.cloze, ...segmentRanges]);
  const visiblePositions = new Set();
  const seed = seedNumber(card && card.id);

  points.forEach((point) => {
    const pointCloze = rangesForPoint(answer, clozeRanges, point);
    const pointVisible = new Set(terminalPunctuationPositions(answer, point));
    const windows = pointCloze.length
      ? revealWindowsForPoint(answer, point, pointCloze, seed, true)
      : [];
    visiblePositionsForLevel(answer, point, pointVisible, windows, safeLevel)
      .forEach((position) => visiblePositions.add(position));
  });

  return points.map((point) => ({
    key: point.key,
    marker: point.marker,
    parts: hintParts(point.body, point.bodyStart, visiblePositions),
  }));
}

function seedNumber(value) {
  return String(value || "hint").split("").reduce((seed, char) => ((seed * 31) + char.charCodeAt(0)) >>> 0, 2166136261);
}

function maskPhrase(phrase, level, seed) {
  const chars = Array.from(String(phrase || ""));
  const content = chars.map((char, index) => ({ char, index })).filter((item) => isKeywordChar(item.char));
  const ratio = level >= 3 ? .66 : (level >= 2 ? .34 : 0);
  const visibleCount = Math.min(Math.max(0, content.length - 1), Math.ceil(content.length * ratio));
  const visible = new Set(content
    .map((item) => ({ ...item, rank: ((seed ^ ((item.index + 1) * 2654435761)) >>> 0) }))
    .sort((left, right) => left.rank - right.rank)
    .slice(0, visibleCount)
    .map((item) => item.index));
  return chars.map((char, index) => !isKeywordChar(char) || visible.has(index) ? char : "＿").join("");
}

function replacePhrase(text, phrase, replacement) {
  if (!phrase || !text.includes(phrase)) return text;
  return text.split(phrase).join(replacement);
}

function buildHintText(card, level) {
  const answer = normalizeEditorText(card && card.answer);
  if (!answer) return "";
  const manualPhrases = clozeTextsFromSegments(card && card.answerSegments);
  const phrases = manualPhrases.length ? manualPhrases : suggestClozePhrases(answer);
  const baseSeed = seedNumber(card && card.id);
  return splitAnswerPoints(answer).map((point, pointIndex) => {
    let masked = point;
    phrases.forEach((phrase, phraseIndex) => {
      if (!masked.includes(phrase)) return;
      masked = replacePhrase(masked, phrase, maskPhrase(phrase, level, baseSeed + pointIndex * 97 + phraseIndex * 31));
    });
    return masked;
  }).join("\n");
}

function generateMnemonic(value) {
  const phrases = suggestClozePhrases(value);
  const parts = phrases.map((phrase) => Array.from(phrase).filter(isKeywordChar).slice(0, 4).join("")).filter(Boolean);
  return [...new Set(parts)].slice(0, 8).join(" · ");
}

module.exports = {
  CLOZE_COLOR,
  HIGHLIGHT_COLOR,
  normalizeEditorText,
  plainTextToHtml,
  plainTextToDelta,
  normalizeDelta,
  deltaText,
  isClozeAttributes,
  answerSegmentsFromDelta,
  applyAttributesToRanges,
  removeHighlightAttributes,
  splitAnswerPointRanges,
  splitAnswerPoints,
  suggestKeyRanges,
  suggestClozePhrases,
  clozeTextsFromSegments,
  buildHintLines,
  buildHintText,
  generateMnemonic,
};
