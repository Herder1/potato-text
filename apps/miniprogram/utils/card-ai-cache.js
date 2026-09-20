const { normalizeEditorText } = require("./card-rich-content");

const CARD_AI_SCHEMA_VERSION = 2;
const CARD_AI_CACHE_REVISION = 5;
const CARD_AI_CACHE_KEY = `shukao_card_ai_assistance_v${CARD_AI_CACHE_REVISION}`;
const CARD_AI_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const CARD_AI_CACHE_LIMIT = 24;
const CARD_AI_MAX_HIGHLIGHTS = 64;
const CARD_AI_MAX_CLOZES = 128;

function normalizeQuestion(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function sourceSnapshot(question, answer, userScope = "guest") {
  return {
    schemaVersion: CARD_AI_SCHEMA_VERSION,
    cacheRevision: CARD_AI_CACHE_REVISION,
    userScope: String(userScope || "guest"),
    question: normalizeQuestion(question),
    answer: normalizeEditorText(answer),
  };
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cardAiFingerprint(question, answer, userScope = "guest") {
  return `card-ai-v${CARD_AI_SCHEMA_VERSION}-r${CARD_AI_CACHE_REVISION}-${hashText(JSON.stringify(sourceSnapshot(question, answer, userScope)))}`;
}

function normalizedRanges(items, answer, limit) {
  if (!Array.isArray(items) || items.length > limit) return [];
  const seen = new Set();
  return items.reduce((ranges, item) => {
    const start = Number(item && item.start);
    const end = Number(item && item.end);
    const text = String(item && item.text || "");
    const conceptId = String(item && item.conceptId || "");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > answer.length) return ranges;
    if (!conceptId || !text || answer.slice(start, end) !== text) return ranges;
    const key = `${conceptId}:${start}:${end}`;
    if (seen.has(key)) return ranges;
    seen.add(key);
    ranges.push({
      conceptId,
      pointId: String(item.pointId || ""),
      start,
      end,
      text,
    });
    return ranges;
  }, []).sort((left, right) => left.start - right.start || left.end - right.end);
}

function normalizeCardAiResult(value, answerValue) {
  const answer = normalizeEditorText(answerValue);
  const result = value && typeof value === "object" ? value : {};
  const highlights = normalizedRanges(result.highlights, answer, CARD_AI_MAX_HIGHLIGHTS);
  const clozes = normalizedRanges(result.clozes, answer, CARD_AI_MAX_CLOZES);
  const mnemonicValue = result.mnemonic;
  const mnemonic = typeof mnemonicValue === "string"
    ? { text: mnemonicValue.trim(), conceptIds: [] }
    : {
      text: String(mnemonicValue && mnemonicValue.text || "").trim(),
      conceptIds: Array.isArray(mnemonicValue && mnemonicValue.conceptIds)
        ? [...new Set(mnemonicValue.conceptIds.map(String).filter(Boolean))]
        : [],
    };
  if (!answer || !highlights.length || !clozes.length || !mnemonic.text || mnemonic.text.length > 200) return null;
  const highlightByConcept = new Map();
  highlights.forEach((range) => {
    const existing = highlightByConcept.get(range.conceptId) || [];
    existing.push(range);
    highlightByConcept.set(range.conceptId, existing);
  });
  if (clozes.some((cloze) => !(highlightByConcept.get(cloze.conceptId) || [])
    .some((highlight) => cloze.start >= highlight.start && cloze.end <= highlight.end))) return null;
  return {
    schemaVersion: CARD_AI_SCHEMA_VERSION,
    sourceDigest: String(result.sourceDigest || ""),
    highlights,
    clozes,
    mnemonic,
  };
}

function storageEntries() {
  if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") return [];
  try {
    const value = wx.getStorageSync(CARD_AI_CACHE_KEY);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    return [];
  }
}

function readCardAiCache(question, answer, userScope = "guest", now = Date.now()) {
  const snapshot = sourceSnapshot(question, answer, userScope);
  const fingerprint = cardAiFingerprint(question, answer, userScope);
  const record = storageEntries().find((item) => item && item.fingerprint === fingerprint);
  if (!record || now - Number(record.savedAt || 0) > CARD_AI_CACHE_TTL) return null;
  if (record.question !== snapshot.question || record.answer !== snapshot.answer || record.userScope !== snapshot.userScope) return null;
  const result = normalizeCardAiResult(record.result, snapshot.answer);
  return result ? { fingerprint, result } : null;
}

function writeCardAiCache(question, answer, userScope, result, now = Date.now()) {
  if (typeof wx === "undefined" || typeof wx.setStorageSync !== "function") return null;
  const snapshot = sourceSnapshot(question, answer, userScope);
  const normalized = normalizeCardAiResult(result, snapshot.answer);
  if (!normalized) return null;
  const fingerprint = cardAiFingerprint(snapshot.question, snapshot.answer, snapshot.userScope);
  const fresh = storageEntries().filter((item) => item
    && item.fingerprint !== fingerprint
    && now - Number(item.savedAt || 0) <= CARD_AI_CACHE_TTL);
  try {
    wx.setStorageSync(CARD_AI_CACHE_KEY, [{
      fingerprint,
      question: snapshot.question,
      answer: snapshot.answer,
      userScope: snapshot.userScope,
      result: normalized,
      savedAt: now,
    }, ...fresh].slice(0, CARD_AI_CACHE_LIMIT));
  } catch (error) {
    return null;
  }
  return { fingerprint, result: normalized };
}

module.exports = {
  CARD_AI_CACHE_KEY,
  CARD_AI_CACHE_REVISION,
  CARD_AI_SCHEMA_VERSION,
  cardAiFingerprint,
  normalizeCardAiResult,
  readCardAiCache,
  sourceSnapshot,
  writeCardAiCache,
};
