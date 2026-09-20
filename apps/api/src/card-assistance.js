const crypto = require("node:crypto");

const {
  normalizeEditorText,
  splitAnswerPointRanges,
} = require("../../miniprogram/utils/card-rich-content");

const CARD_ASSISTANCE_SCHEMA_VERSION = 2;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_ANSWER_LENGTH = 12_000;
const MAX_POINT_COUNT = 64;
const MAX_MODEL_OUTPUT_LENGTH = 64_000;
const MAX_CONCEPT_COUNT = 64;
const MAX_CONCEPT_ID_LENGTH = 64;
const MAX_HIGHLIGHT_RAW_LENGTH = 32;
const MAX_CLOZE_RAW_LENGTH = 16;
const MAX_QUOTE_LENGTH = MAX_HIGHLIGHT_RAW_LENGTH;
const MAX_MNEMONIC_LENGTH = 200;
const MAX_OCCURRENCE = 100;
const MAX_HIGHLIGHT_CONTENT_LENGTH = 18;
const MAX_CLOZE_CONTENT_LENGTH = 10;
const CONCEPT_ROLES = new Set([
  "direct_answer",
  "definition",
  "condition",
  "contrast",
  "relation",
  "conclusion",
  "number",
]);
const LOW_INFORMATION_CLOZE_TEXTS = new Set([
  "一种", "这种", "其中", "所有", "相互", "介于", "作为", "成为",
  "形成", "具有", "进行", "通过", "根据", "由于", "因此", "可以",
  "能够", "需要", "主要", "分别", "共同", "各级", "各类", "之间",
  "以后", "之前", "方面",
]);
const CONTENT_CHAR_PATTERN = /[\p{Script=Han}\p{L}\p{N}]/u;
const LEADING_POINT_MARKER_PATTERN = /^(?:\d{1,2}[.、．]|[（(]\d{1,2}[）)])\s*(?=[\p{Script=Han}\p{L}])/u;
const NUMBERING_PATTERN = /(?:\d{1,2}[.、．]|[（(]\d{1,2}[）)])(?=[\p{Script=Han}\p{L}])/u;
const TERMINAL_PUNCTUATION_PATTERN = /[\r\n。！？!?；;…]/u;

function sourceError(code) {
  throw new Error(code);
}

function providerOutputError() {
  throw new Error("provider_output_format_error");
}

function normalizedSourceText(value, maxLength, allowEmpty) {
  if (typeof value !== "string") sourceError("card_assistance_source_invalid");
  const text = normalizeEditorText(value);
  if (!allowEmpty && !text.trim()) sourceError("card_assistance_source_invalid");
  if (text.length > maxLength) sourceError("card_assistance_source_too_long");
  return text;
}

function sourceDigest(question, answer) {
  const normalizedQuestion = normalizeEditorText(typeof question === "string" ? question : "");
  const normalizedAnswer = normalizeEditorText(typeof answer === "string" ? answer : "");
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      version: CARD_ASSISTANCE_SCHEMA_VERSION,
      question: normalizedQuestion,
      answer: normalizedAnswer,
    }))
    .digest("hex");
}

function isContentChar(char) {
  return Boolean(char) && CONTENT_CHAR_PATTERN.test(char);
}

function contentText(value) {
  return Array.from(String(value || "")).filter(isContentChar).join("");
}

function isLowInformationCloze(value) {
  return LOW_INFORMATION_CLOZE_TEXTS.has(contentText(value));
}

function contentCharacterOffsets(text, ignoredPrefixLength = 0) {
  const offsets = [];
  let offset = 0;
  for (const char of text) {
    if (offset >= ignoredPrefixLength && isContentChar(char)) offsets.push(offset);
    offset += char.length;
  }
  return offsets;
}

function effectivePointDetails(text) {
  const marker = text.match(LEADING_POINT_MARKER_PATTERN);
  const ignoredPrefixLength = marker ? marker[0].length : 0;
  const contentOffsets = contentCharacterOffsets(text, ignoredPrefixLength);
  return {
    ignoredPrefixLength,
    contentOffsets,
    effectiveLength: contentOffsets.length,
  };
}

function coverageBudget(effectiveLength) {
  if (effectiveLength <= 8) {
    return {
      minHighlightCoverage: 0,
      maxHighlightCoverage: 1,
      minClozeCoverage: 0,
      maxClozeCoverage: 1,
    };
  }
  if (effectiveLength <= 24) {
    return {
      minHighlightCoverage: .12,
      maxHighlightCoverage: .55,
      minClozeCoverage: .1,
      maxClozeCoverage: .45,
    };
  }
  if (effectiveLength <= 59) {
    return {
      minHighlightCoverage: .1,
      maxHighlightCoverage: .4,
      minClozeCoverage: .08,
      maxClozeCoverage: .3,
    };
  }
  if (effectiveLength <= 119) {
    return {
      minHighlightCoverage: .1,
      maxHighlightCoverage: .32,
      minClozeCoverage: .08,
      maxClozeCoverage: .25,
    };
  }
  return {
    minHighlightCoverage: .1,
    maxHighlightCoverage: .28,
    minClozeCoverage: .08,
    maxClozeCoverage: .22,
  };
}

function conceptCountBudget(effectiveLength, pointCount) {
  let min = 1;
  if (pointCount <= 16) {
    if (effectiveLength >= 120) min = 4;
    else if (effectiveLength >= 60) min = 3;
    else if (effectiveLength >= 25) min = 2;
  }

  let max = 1;
  if (effectiveLength >= 120) max = 8;
  else if (effectiveLength >= 60) max = 6;
  else if (effectiveLength >= 25) max = 4;
  else if (effectiveLength >= 9) max = 2;
  return { min, max: Math.max(min, max) };
}

function promptBudget(effectiveLength, pointCount) {
  const counts = conceptCountBudget(effectiveLength, pointCount);
  const coverage = coverageBudget(effectiveLength);
  const minimumPhraseLength = effectiveLength <= 8 ? 1 : 2;
  return {
    targetHighlights: {
      min: counts.min,
      max: counts.max,
      minCoverage: coverage.minHighlightCoverage,
      maxCoverage: coverage.maxHighlightCoverage,
      singleContentChars: {
        min: minimumPhraseLength,
        max: Math.min(MAX_HIGHLIGHT_CONTENT_LENGTH, effectiveLength),
      },
      singleRawCharsMax: MAX_HIGHLIGHT_RAW_LENGTH,
    },
    targetClozes: {
      min: counts.min,
      max: counts.max * 2,
      minCoverage: coverage.minClozeCoverage,
      maxCoverage: coverage.maxClozeCoverage,
      singleContentChars: {
        min: minimumPhraseLength,
        max: Math.min(MAX_CLOZE_CONTENT_LENGTH, effectiveLength),
      },
      singleRawCharsMax: MAX_CLOZE_RAW_LENGTH,
    },
  };
}

function promptPointRanges(answer) {
  const ranges = splitAnswerPointRanges(answer);
  if (!ranges.length) sourceError("card_assistance_source_invalid");
  if (ranges.length > MAX_POINT_COUNT) sourceError("card_assistance_source_too_long");
  return ranges.map((range, index) => {
    const details = effectivePointDetails(range.text);
    if (!details.effectiveLength) sourceError("card_assistance_source_invalid");
    const budget = promptBudget(details.effectiveLength, ranges.length);
    return {
      id: `p${index + 1}`,
      start: range.start,
      end: range.end,
      text: range.text,
      ignoredPrefixLength: details.ignoredPrefixLength,
      contentOffsets: details.contentOffsets,
      effectiveLength: details.effectiveLength,
      ...budget,
    };
  });
}

function publicPromptPoint(point) {
  return {
    id: point.id,
    text: point.text,
    effectiveLength: point.effectiveLength,
    targetHighlights: point.targetHighlights,
    targetClozes: point.targetClozes,
  };
}

function buildCardAssistancePromptPoints(answer) {
  const normalizedAnswer = normalizedSourceText(
    answer,
    MAX_ANSWER_LENGTH,
    false,
  );
  return promptPointRanges(normalizedAnswer).map(publicPromptPoint);
}

function buildCardAssistanceSource(question, answer) {
  const normalizedQuestion = normalizedSourceText(
    question,
    MAX_QUESTION_LENGTH,
    true,
  );
  const normalizedAnswer = normalizedSourceText(
    answer,
    MAX_ANSWER_LENGTH,
    false,
  );
  return {
    version: CARD_ASSISTANCE_SCHEMA_VERSION,
    question: normalizedQuestion,
    answer: normalizedAnswer,
    sourceDigest: sourceDigest(normalizedQuestion, normalizedAnswer),
    points: promptPointRanges(normalizedAnswer).map(publicPromptPoint),
  };
}

function normalizedIdentifier(value) {
  if (typeof value !== "string") providerOutputError();
  const id = value.trim();
  if (!id || id.length > MAX_CONCEPT_ID_LENGTH) providerOutputError();
  return id;
}

function normalizedRole(value) {
  if (typeof value !== "string") providerOutputError();
  const role = value.trim();
  if (!CONCEPT_ROLES.has(role)) providerOutputError();
  return role;
}

function normalizedOccurrence(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_OCCURRENCE) providerOutputError();
  return value;
}

function validQuoteShape(quote, maxRawLength, maxContentLength, allowSingleContentChar) {
  const characters = Array.from(quote);
  if (!characters.length || characters.length > maxRawLength) return false;
  if (!isContentChar(characters[0]) || !isContentChar(characters[characters.length - 1])) return false;
  if (TERMINAL_PUNCTUATION_PATTERN.test(quote) || NUMBERING_PATTERN.test(quote)) return false;
  const contentLength = characters.filter(isContentChar).length;
  const minimumContentLength = allowSingleContentChar ? 1 : 2;
  return contentLength >= minimumContentLength && contentLength <= maxContentLength;
}

function normalizedQuoteReference(value, options) {
  if (!value || typeof value !== "object" || Array.isArray(value)) providerOutputError();
  if (typeof value.quote !== "string"
    || !validQuoteShape(
      value.quote,
      options.maxRawLength,
      options.maxContentLength,
      options.allowSingleContentChar,
    )) {
    providerOutputError();
  }
  return {
    quote: value.quote,
    occurrence: normalizedOccurrence(value.occurrence),
  };
}

function occurrenceIndex(text, quote, occurrence) {
  // The model contract uses a zero-based, non-overlapping occurrence scoped to the supplied text.
  let cursor = 0;
  let index = -1;
  for (let ordinal = 0; ordinal <= occurrence; ordinal += 1) {
    index = text.indexOf(quote, cursor);
    if (index < 0) return -1;
    cursor = index + quote.length;
  }
  return index;
}

function serializedLengthWithinLimit(value) {
  try {
    return JSON.stringify(value).length <= MAX_MODEL_OUTPUT_LENGTH;
  } catch (error) {
    return false;
  }
}

function sourceFromContext(context, answer) {
  if (context && typeof context === "object" && !Array.isArray(context)) {
    return buildCardAssistanceSource(context.question, context.answer);
  }
  return buildCardAssistanceSource(context, answer);
}

function compareRange(left, right) {
  return left.start - right.start
    || left.end - right.end
    || (left.conceptId < right.conceptId ? -1 : Number(left.conceptId > right.conceptId));
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function assertNoOverlaps(ranges) {
  const sorted = [...ranges].sort(compareRange);
  for (let index = 1; index < sorted.length; index += 1) {
    if (rangesOverlap(sorted[index - 1], sorted[index])) providerOutputError();
  }
}

function positionalCoverage(point, ranges) {
  const covered = point.contentOffsets.filter((localOffset) => {
    const absoluteOffset = point.start + localOffset;
    return ranges.some((range) => absoluteOffset >= range.start && absoluteOffset < range.end);
  }).length;
  return covered / point.effectiveLength;
}

function assertCoverageWithin(value, minimum, maximum) {
  if (value + Number.EPSILON < minimum || value - Number.EPSILON > maximum) providerOutputError();
}

function normalizeCardAssistanceOutput(raw, context, answer) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !serializedLengthWithinLimit(raw)) {
    providerOutputError();
  }
  if (raw.schemaVersion !== CARD_ASSISTANCE_SCHEMA_VERSION
    || !Array.isArray(raw.concepts)
    || !raw.concepts.length
    || raw.concepts.length > MAX_CONCEPT_COUNT) {
    providerOutputError();
  }

  const source = sourceFromContext(context, answer);
  const ranges = promptPointRanges(source.answer);
  const points = new Map(ranges.map((point) => [point.id, point]));
  const conceptIds = new Set();
  const conceptsByPoint = new Map(ranges.map((point) => [point.id, []]));
  const highlights = [];
  const clozes = [];

  raw.concepts.forEach((concept) => {
    if (!concept || typeof concept !== "object" || Array.isArray(concept)) providerOutputError();
    const conceptId = normalizedIdentifier(concept.id);
    if (conceptIds.has(conceptId)) providerOutputError();
    conceptIds.add(conceptId);

    if (typeof concept.pointId !== "string") providerOutputError();
    const pointId = concept.pointId.trim();
    const point = points.get(pointId);
    if (!point) providerOutputError();
    const role = normalizedRole(concept.role);
    const allowSingleContentChar = point.effectiveLength <= 8;

    const highlightReference = normalizedQuoteReference(concept.highlight, {
      maxRawLength: MAX_HIGHLIGHT_RAW_LENGTH,
      maxContentLength: MAX_HIGHLIGHT_CONTENT_LENGTH,
      allowSingleContentChar,
    });
    const highlightOffset = occurrenceIndex(
      point.text,
      highlightReference.quote,
      highlightReference.occurrence,
    );
    if (highlightOffset < 0) providerOutputError();
    const highlightStart = point.start + highlightOffset;
    const highlightEnd = highlightStart + highlightReference.quote.length;
    if (source.answer.slice(highlightStart, highlightEnd) !== highlightReference.quote) providerOutputError();

    const highlight = {
      conceptId,
      pointId,
      role,
      start: highlightStart,
      end: highlightEnd,
      text: source.answer.slice(highlightStart, highlightEnd),
    };

    if (!Array.isArray(concept.clozes) || concept.clozes.length < 1 || concept.clozes.length > 2) {
      providerOutputError();
    }
    let conceptClozes = concept.clozes.map((value) => {
      const clozeReference = normalizedQuoteReference(value, {
        maxRawLength: MAX_CLOZE_RAW_LENGTH,
        maxContentLength: MAX_CLOZE_CONTENT_LENGTH,
        allowSingleContentChar,
      });
      const clozeOffset = occurrenceIndex(
        highlightReference.quote,
        clozeReference.quote,
        clozeReference.occurrence,
      );
      if (clozeOffset < 0) providerOutputError();
      const clozeStart = highlightStart + clozeOffset;
      const clozeEnd = clozeStart + clozeReference.quote.length;
      if (clozeStart < highlightStart
        || clozeEnd > highlightEnd
        || source.answer.slice(clozeStart, clozeEnd) !== clozeReference.quote) {
        providerOutputError();
      }
      return {
        conceptId,
        pointId,
        role,
        start: clozeStart,
        end: clozeEnd,
        text: source.answer.slice(clozeStart, clozeEnd),
      };
    });
    assertNoOverlaps(conceptClozes);
    const highlightCharacters = Array.from(highlight.text);
    const highlightContentLength = highlightCharacters.filter(isContentChar).length;
    const containsLowInformationCloze = conceptClozes.some((item) => isLowInformationCloze(item.text));
    const shouldUseCompleteShortHighlight = highlightContentLength <= MAX_CLOZE_CONTENT_LENGTH
      && highlightCharacters.length <= MAX_CLOZE_RAW_LENGTH
      && (role === "direct_answer" || containsLowInformationCloze);
    if (shouldUseCompleteShortHighlight) {
      conceptClozes = [{ ...highlight }];
    } else if (containsLowInformationCloze) {
      providerOutputError();
    }

    highlights.push(highlight);
    clozes.push(...conceptClozes);
    conceptsByPoint.get(pointId).push({ conceptId, role, highlight, clozes: conceptClozes });
  });

  ranges.forEach((point) => {
    const pointConcepts = conceptsByPoint.get(point.id);
    const countBudget = conceptCountBudget(point.effectiveLength, ranges.length);
    if (pointConcepts.length < countBudget.min || pointConcepts.length > countBudget.max) {
      providerOutputError();
    }
    if (!pointConcepts.some((concept) => concept.role === "direct_answer")) providerOutputError();
    const pointHighlights = pointConcepts.map((concept) => concept.highlight);
    const pointClozes = pointConcepts.flatMap((concept) => concept.clozes);
    assertNoOverlaps(pointHighlights);
    assertNoOverlaps(pointClozes);

    const coverage = coverageBudget(point.effectiveLength);
    assertCoverageWithin(
      positionalCoverage(point, pointHighlights),
      coverage.minHighlightCoverage,
      coverage.maxHighlightCoverage,
    );
    assertCoverageWithin(
      positionalCoverage(point, pointClozes),
      coverage.minClozeCoverage,
      coverage.maxClozeCoverage,
    );
  });

  if (!raw.mnemonic || typeof raw.mnemonic !== "object" || Array.isArray(raw.mnemonic)) providerOutputError();
  if (typeof raw.mnemonic.text !== "string") providerOutputError();
  const mnemonicText = normalizeEditorText(raw.mnemonic.text).trim();
  if (!mnemonicText || mnemonicText.length > MAX_MNEMONIC_LENGTH) providerOutputError();
  if (!Array.isArray(raw.mnemonic.conceptIds)
    || !raw.mnemonic.conceptIds.length
    || raw.mnemonic.conceptIds.length > MAX_CONCEPT_COUNT) {
    providerOutputError();
  }
  const mnemonicConceptIds = raw.mnemonic.conceptIds.map(normalizedIdentifier);
  if (new Set(mnemonicConceptIds).size !== mnemonicConceptIds.length
    || mnemonicConceptIds.some((conceptId) => !conceptIds.has(conceptId))) {
    providerOutputError();
  }

  highlights.sort(compareRange);
  clozes.sort(compareRange);
  if (!highlights.length || !clozes.length) providerOutputError();

  return {
    sourceDigest: source.sourceDigest,
    highlights,
    clozes,
    mnemonic: {
      text: mnemonicText,
      conceptIds: mnemonicConceptIds,
    },
  };
}

module.exports = {
  CARD_ASSISTANCE_SCHEMA_VERSION,
  MAX_ANSWER_LENGTH,
  MAX_CLOZE_CONTENT_LENGTH,
  MAX_CLOZE_RAW_LENGTH,
  MAX_CONCEPT_COUNT,
  MAX_CONCEPT_ID_LENGTH,
  MAX_HIGHLIGHT_CONTENT_LENGTH,
  MAX_HIGHLIGHT_RAW_LENGTH,
  MAX_MNEMONIC_LENGTH,
  MAX_MODEL_OUTPUT_LENGTH,
  MAX_OCCURRENCE,
  MAX_POINT_COUNT,
  MAX_QUESTION_LENGTH,
  MAX_QUOTE_LENGTH,
  buildCardAssistancePromptPoints,
  buildCardAssistanceSource,
  normalizeCardAssistanceOutput,
  sourceDigest,
};
