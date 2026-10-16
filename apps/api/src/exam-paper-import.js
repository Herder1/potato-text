const fs = require("node:fs");
const path = require("node:path");
const { detectScoringPointCandidates } = require("./scoring-point-structure");
const { inferMaterialMarks } = require("./material-mark");
const { normalizeQuestionType } = require("../../miniprogram/utils/question-type");

const typeAliases = {
  single_choice: "single_choice", 单选: "single_choice", 单选题: "single_choice",
  multiple_choice: "multiple_choice", 多选: "multiple_choice", 多选题: "multiple_choice",
  true_false: "true_false", 判断: "true_false", 判断题: "true_false",
  fill_blank: "fill_blank", 填空: "fill_blank", 填空题: "fill_blank",
  punctuation: "punctuation", 断句: "punctuation", 断句题: "punctuation",
  classical_word_explanation: "classical_word_explanation", 加点字翻译: "classical_word_explanation", 加点字解释: "classical_word_explanation", 加点字词解释: "classical_word_explanation",
  translation: "translation", 古文翻译: "translation", 翻译题: "translation",
  short_answer: "short_answer", 简答: "short_answer", 简答题: "short_answer",
  term_definition: "term_definition", 名词解释: "term_definition",
  material_analysis: "material_analysis", 材料分析: "material_analysis", 材料分析题: "material_analysis",
  essay: "essay", 论述: "essay", 论述题: "essay",
};

function examPagesForModel(pages, maxChars = 120000, startPage = 1) {
  let used = 0;
  const result = [];
  for (const [index, page] of (pages || []).entries()) {
    const text = String(typeof page === "string" ? page : (page && page.text || "")).trim();
    if (!text) continue;
    const block = `\n--- 第 ${typeof page === "object" && page.pageNumber || startPage + index} 页 ---\n${text}`;
    if (used + block.length > maxChars) {
      const remaining = maxChars - used;
      if (remaining > 200) result.push(block.slice(0, remaining));
      break;
    }
    result.push(block);
    used += block.length;
  }
  return result.join("").trim();
}

function reflowVerbatimAnswerText(value) {
  const lines = String(value || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "";
  const result = [];
  let current = lines[0];
  const isNumberedHeading = (line) => /^[（(]\s*\d+\s*[）)]/.test(line);
  const endsSentence = (line) => /[。！？；：.!?;]$/.test(line);
  for (const next of lines.slice(1)) {
    if (isNumberedHeading(current) || isNumberedHeading(next) || endsSentence(current)) {
      result.push(current);
      current = next;
    } else {
      current += next;
    }
  }
  result.push(current);
  return result.join("\n\n");
}

function cleanVerbatimAnswerText(value) {
  const cleaned = String(value || "")
    .replace(/\r/g, "")
    .replace(/^[ \t]*第\s*\d+\s*页\s*[，,]\s*共\s*\d+\s*页\s*$/gmu, "")
    .replace(/^[^\n]{0,80}(?:请关注公众号|公众号\s*[：:]\s*汉化土豆)[^\n]*$/gmu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return reflowVerbatimAnswerText(cleaned);
}

function extractVerbatimAnswerBlocks(pages) {
  const text = (Array.isArray(pages) ? pages : [])
    .map((page) => String(typeof page === "string" ? page : (page && page.text || "")))
    .filter(Boolean)
    .join("\n\n");
  const markers = [...text.matchAll(/(?:^|\n)\s*(\d{1,3})\s*[.．、]\s*/gu)];
  const blocks = new Map();
  const addBlock = (number, subNumber, value) => {
    const body = cleanVerbatimAnswerText(value);
    if (!body || body.length > 20000) return;
    const normalizedNumber = String(Number(number));
    if (!normalizedNumber || normalizedNumber === "0") return;
    const normalizedSubNumber = subNumber ? String(Number(subNumber)) : "";
    const key = `${normalizedNumber}:${normalizedSubNumber}`;
    const current = blocks.get(key);
    if (!current || body.length > current.text.length) {
      blocks.set(key, { number: normalizedNumber, subNumber: normalizedSubNumber, text: body });
    }
  };
  markers.forEach((marker, index) => {
    const number = String(Number(marker[1]));
    if (!number || number === "0") return;
    const rawBody = text.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? text.length);
    addBlock(number, "", rawBody);

    const subMarkers = [...rawBody.matchAll(/(?:^|\n)\s*[（(]\s*(\d{1,3})\s*[）)]\s*/gu)];
    if (!subMarkers.length) return;
    const prefix = rawBody.slice(0, subMarkers[0].index).trim();
    const firstSubNumber = Number(subMarkers[0][1]);
    if (prefix && firstSubNumber > 1) addBlock(number, "1", prefix);
    subMarkers.forEach((subMarker, subIndex) => {
      addBlock(
        number,
        subMarker[1],
        rawBody.slice(subMarker.index + subMarker[0].length, subMarkers[subIndex + 1]?.index ?? rawBody.length),
      );
    });
  });
  return [...blocks.values()];
}

function objectiveAnswerType(title) {
  const value = String(title || "");
  if (/单项选择|单选/u.test(value)) return "single_choice";
  if (/双项选择|多项选择|多选/u.test(value)) return "multiple_choice";
  if (/判断|正误/u.test(value)) return "true_false";
  return "";
}

function extractSequentialObjectiveAnswerSections(pages) {
  const text = (Array.isArray(pages) ? pages : [])
    .map((page) => String(typeof page === "string" ? page : (page && page.text || "")))
    .filter(Boolean)
    .join("\n\n");
  const headings = [...text.matchAll(/(?:^|\n)\s*([一二三四五六七八九十百]+)\s*[、.．]\s*([^\n]+)/gu)];
  const sections = [];
  headings.forEach((heading, index) => {
    const title = String(heading[2] || "").trim();
    const type = objectiveAnswerType(title);
    if (!type) return;
    const expectedCount = Number(title.match(/共\s*(\d{1,3})\s*(?:小题|题)/u)?.[1]) || 0;
    const body = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length);
    const entries = body.split(/\n\s*\n+/u).map((paragraph) => {
      const value = cleanVerbatimAnswerText(paragraph);
      const marker = value.match(/^\s*(?:(\d{1,3})\s*[.．、]\s*)?([A-L]{1,8}|正确|错误|对|错|√|×)(?=\s*【|\s*[.．、:：]|\s+)/iu);
      if (!marker) return null;
      const rawAnswer = marker[2].toUpperCase();
      const correctAnswer = /^[A-L]+$/u.test(rawAnswer) ? [...new Set(rawAnswer.split(""))] : [rawAnswer];
      return { printedNumber: marker[1] || "", correctAnswer, text: value };
    }).filter(Boolean);
    if (!entries.length) return;
    sections.push({
      title,
      type,
      expectedCount: expectedCount || entries.length,
      countMatches: !expectedCount || entries.length === expectedCount,
      entries,
    });
  });
  return sections;
}

function normalizedComparableText(value) {
  return String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function objectiveEntryMatchScore(question, entry) {
  const source = normalizedComparableText(entry.text);
  const printedNumber = normalizedQuestionMarker(entry.printedNumber);
  const questionNumber = normalizedQuestionMarker(question.number);
  let score = printedNumber && printedNumber === questionNumber ? 3 : 0;
  const answerKeys = entry.correctAnswer || [];
  if (answerKeys.join("") === (question.correctAnswer || []).join("")) score += 1;
  answerKeys.forEach((key) => {
    const option = (question.options || []).find((item) => String(item.key || "").toUpperCase() === key);
    const optionText = normalizedComparableText(option && option.text);
    if (optionText && source.includes(optionText)) score += optionText.length >= 3 ? 9 : 5;
  });
  const stem = normalizedComparableText(question.stem);
  if (stem.length >= 4) {
    const grams = new Set();
    for (let index = 0; index < stem.length - 1; index += 1) grams.add(stem.slice(index, index + 2));
    const overlap = [...grams].filter((gram) => source.includes(gram)).length;
    score += Math.min(6, Math.floor((overlap / Math.max(1, grams.size)) * 12));
  }
  return score;
}

function applySequentialObjectiveAnswerSections(paperRecognition, pages) {
  const paper = paperRecognition && Array.isArray(paperRecognition.questions) ? paperRecognition : null;
  if (!paper) throw new Error("provider_output_format_error");
  const sections = extractSequentialObjectiveAnswerSections(pages);
  const questions = paper.questions.map((question) => ({ ...question }));
  const usedIndexes = new Set();
  let recoveredCount = 0;
  const applyEntry = (questionIndex, entry) => {
    const question = questions[questionIndex];
    usedIndexes.add(questionIndex);
    const currentOfficial = String(question.answerVariants && question.answerVariants.official || question.referenceAnswer || "").trim();
    if (currentOfficial) return;
    recoveredCount += 1;
    questions[questionIndex] = {
      ...question,
      correctAnswer: entry.correctAnswer,
      referenceAnswer: entry.text,
      answerVariants: { ...(question.answerVariants || {}), official: entry.text },
      answerSource: "pdf_answer",
      answerReviewStatus: "unreviewed",
      answerVerified: false,
      warnings: [...new Set([
        ...(question.warnings || []),
        "来源答案已按独立答案文件的题型分区与原始顺序恢复，需人工核对题序",
      ])],
    };
  };
  sections.forEach((section) => {
    const candidates = questions.map((question, index) => ({ question, index })).filter(({ question, index }) => {
      return !usedIndexes.has(index) && question.type === section.type;
    });
    if (section.countMatches && candidates.length >= section.entries.length) {
      section.entries.forEach((entry, entryIndex) => applyEntry(candidates[entryIndex].index, entry));
      return;
    }
    const pairs = candidates.flatMap(({ question, index }) => section.entries.map((entry, entryIndex) => ({
      index,
      entryIndex,
      score: objectiveEntryMatchScore(question, entry),
    }))).filter((pair) => pair.score >= 3).sort((left, right) => right.score - left.score);
    const assignedEntries = new Set();
    pairs.forEach((pair) => {
      if (usedIndexes.has(pair.index) || assignedEntries.has(pair.entryIndex)) return;
      assignedEntries.add(pair.entryIndex);
      applyEntry(pair.index, section.entries[pair.entryIndex]);
    });
  });
  return { recognition: { ...paper, questions }, recoveredCount, sectionCount: sections.length };
}

function answerBlockMatches(currentAnswer, sourceBlock) {
  const current = String(currentAnswer || "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  const source = String(sourceBlock || "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  if (!current || !source) return false;
  if (current.length <= 8) return source.length <= 80 && (source.includes(current) || current.includes(source));
  const grams = new Set();
  for (let index = 0; index < current.length - 1; index += 1) grams.add(current.slice(index, index + 2));
  if (!grams.size) return false;
  const matched = [...grams].filter((gram) => source.includes(gram)).length;
  return matched >= 3 && matched / grams.size >= 0.2;
}

function answerStemStartsBlock(stem, sourceBlock) {
  const normalizedStem = String(stem || "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  const normalizedSource = String(sourceBlock || "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  return normalizedStem.length >= 4 && normalizedSource.startsWith(normalizedStem);
}

function normalizedTextWithOffsets(value) {
  let text = "";
  const offsets = [];
  let sourceOffset = 0;
  for (const character of String(value || "")) {
    const normalized = character.normalize("NFKC").toLowerCase();
    for (const normalizedCharacter of normalized) {
      if (!/[\p{L}\p{N}]/u.test(normalizedCharacter)) continue;
      text += normalizedCharacter;
      offsets.push({ start: sourceOffset, end: sourceOffset + character.length });
    }
    sourceOffset += character.length;
  }
  return { text, offsets };
}

function findNormalizedTextRange(source, target) {
  const haystack = normalizedTextWithOffsets(source);
  const needle = normalizedTextWithOffsets(target).text;
  if (needle.length < 12) return null;
  const index = haystack.text.indexOf(needle);
  if (index < 0) return null;
  return {
    start: haystack.offsets[index].start,
    end: haystack.offsets[index + needle.length - 1].end,
  };
}

function addStemDelimitedAnswerBlocks(blockMap, questions) {
  const sourceBlocks = [...blockMap.values()];
  questions.forEach((question) => {
    const number = normalizedQuestionMarker(question.number);
    const subNumber = normalizedQuestionMarker(question.subNumber);
    const key = `${number}:${subNumber}`;
    if (!number || !subNumber || blockMap.has(key)) return;
    const matches = sourceBlocks.map((block) => ({ block, range: findNormalizedTextRange(block.text, question.stem) }))
      .filter((item) => item.range);
    if (matches.length !== 1) return;
    const match = matches[0];
    const text = cleanVerbatimAnswerText(match.block.text.slice(match.range.end).replace(/^[\s。！？；：，,.!?;:]+/u, ""));
    if (!text) return;
    blockMap.set(key, { number, subNumber, text, matchedByStem: true });
  });
  const groups = new Map();
  questions.forEach((question) => {
    const number = normalizedQuestionMarker(question.number);
    const subNumber = normalizedQuestionMarker(question.subNumber);
    if (!number || !subNumber) return;
    if (!groups.has(number)) groups.set(number, []);
    groups.get(number).push({ question, subNumber });
  });
  groups.forEach((items, number) => {
    if (items.length < 2) return;
    const mainBlock = blockMap.get(`${number}:`);
    if (!mainBlock) return;
    const positions = items.map((item) => ({
      ...item,
      range: findNormalizedTextRange(mainBlock.text, item.question.stem),
    })).filter((item) => item.range).sort((left, right) => left.range.start - right.range.start);
    if (!positions.length) return;
    positions.forEach((item, index) => {
      const text = cleanVerbatimAnswerText(
        mainBlock.text.slice(item.range.end, positions[index + 1]?.range.start ?? mainBlock.text.length)
          .replace(/^[\s。！？；：，,.!?;:]+/u, ""),
      );
      if (!text) return;
      blockMap.set(`${number}:${item.subNumber}`, {
        number: String(item.question.number || number),
        subNumber: item.subNumber,
        text,
        matchedByStem: true,
      });
    });
  });
}

function mergeQuestion(left, right) {
  if (!left) return right;
  const preferLonger = (a, b) => String(b || "").length > String(a || "").length ? b : a;
  return {
    ...left,
    sectionTitle: preferLonger(left.sectionTitle, right.sectionTitle),
    type: left.type || right.type,
    subjectId: left.subjectId || right.subjectId,
    bookId: left.bookId || right.bookId,
    stem: preferLonger(left.stem, right.stem),
    options: (right.options || []).length > (left.options || []).length ? right.options : left.options,
    correctAnswer: (right.correctAnswer || []).length > (left.correctAnswer || []).length ? right.correctAnswer : left.correctAnswer,
    referenceAnswer: preferLonger(left.referenceAnswer, right.referenceAnswer),
    answerVariants: {
      official: preferLonger(left.answerVariants && left.answerVariants.official, right.answerVariants && right.answerVariants.official),
      ai: preferLonger(left.answerVariants && left.answerVariants.ai, right.answerVariants && right.answerVariants.ai),
      community: preferLonger(left.answerVariants && left.answerVariants.community, right.answerVariants && right.answerVariants.community),
    },
    answerSource: left.answerSource === "pdf_answer" || right.answerSource === "pdf_answer" ? "pdf_answer" : (left.answerSource || right.answerSource),
    answerReviewStatus: left.answerReviewStatus === "verified" || right.answerReviewStatus === "verified"
      ? "verified" : (left.answerReviewStatus === "doubtful" || right.answerReviewStatus === "doubtful" ? "doubtful" : "unreviewed"),
    answerVerified: left.answerVerified === true || right.answerVerified === true,
    scoringPoints: (right.scoringPoints || []).length > (left.scoringPoints || []).length ? right.scoringPoints : left.scoringPoints,
    scoringPolicy: left.scoringPolicy || right.scoringPolicy || null,
    material: preferLonger(left.material, right.material),
    materialGroupId: left.materialGroupId || right.materialGroupId,
    usesSharedMaterial: left.usesSharedMaterial !== false && right.usesSharedMaterial !== false,
    groupNumber: left.groupNumber || right.groupNumber,
    subNumber: left.subNumber || right.subNumber,
    responseMode: "text",
    annotationText: preferLonger(left.annotationText, right.annotationText),
    maxScore: Math.max(Number(left.maxScore) || 0, Number(right.maxScore) || 0) || 1,
    chapter: preferLonger(left.chapter, right.chapter),
    knowledgePoints: [...new Set([...(left.knowledgePoints || []), ...(right.knowledgePoints || [])])].slice(0, 20),
    sourcePage: left.sourcePage || right.sourcePage,
    confidence: Math.max(Number(left.confidence) || 0, Number(right.confidence) || 0),
    warnings: [...new Set([...(left.warnings || []), ...(right.warnings || [])])],
  };
}

function materialGroupKey(question) {
  if (question.materialGroupId) return String(question.materialGroupId);
  const title = String(question.sectionTitle || "");
  const marker = title.match(/[（(]([一二三四五六七八九十]+)[）)]/);
  return marker ? marker[1] : `single:${question.number}`;
}

function questionInstruction(stem) {
  const text = String(stem || "").trim();
  const verbs = ["根据以上材料", "结合材料", "找出", "指出", "判断", "分析", "说明", "概括", "翻译", "解释"];
  const withoutEnding = text.replace(/[。！？!?]+$/, "");
  const boundary = Math.max(withoutEnding.lastIndexOf("。"), withoutEnding.lastIndexOf("！"), withoutEnding.lastIndexOf("？"), withoutEnding.lastIndexOf("\n"));
  const lastSentence = withoutEnding.slice(boundary + 1).trim();
  if (verbs.some((verb) => lastSentence.includes(verb)) && lastSentence.length <= 500) {
    return { body: text.slice(0, boundary + 1).trim(), instruction: `${lastSentence}。` };
  }
  const candidateIndexes = verbs.map((verb) => text.lastIndexOf(verb)).filter((index) => index >= 0 && text.length - index <= 500);
  const index = candidateIndexes.length ? Math.min(...candidateIndexes) : -1;
  if (index >= 0) return { body: text.slice(0, index).trim(), instruction: text.slice(index).trim() };
  const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
  if (paragraphs.length > 1) return { body: paragraphs.slice(0, -1).join("\n\n"), instruction: paragraphs.at(-1).trim() };
  return { body: text, instruction: "" };
}

function structureMaterialGroup(items, number) {
  const parts = items.map((item) => questionInstruction(item.stem));
  const material = items.map((item, index) => item.material || parts[index].body).filter(Boolean).sort((left, right) => right.length - left.length)[0] || "";
  const groupNumber = String(items[0].groupNumber || number);
  const materialGroupId = String(items[0].materialGroupId || `material-${groupNumber}`);
  return items.map((item, index) => ({
    ...item,
    number: groupNumber,
    groupNumber,
    subNumber: String(item.subNumber || index + 1),
    material,
    materialGroupId,
    stem: item.material ? item.stem : (parts[index].instruction || item.stem),
  }));
}

function structureMaterialQuestions(questions, expectedCount) {
  const firstMaterialIndex = questions.findIndex((question) => question.type === "material_analysis" || question.material || question.materialGroupId);
  if (firstMaterialIndex < 0) return questions;
  const leading = questions.slice(0, firstMaterialIndex);
  const material = questions.slice(firstMaterialIndex);
  const groups = [];
  const groupMap = new Map();
  material.forEach((question) => {
    const key = materialGroupKey(question);
    if (!groupMap.has(key)) {
      const group = [];
      groups.push(group);
      groupMap.set(key, group);
    }
    groupMap.get(key).push(question);
  });
  const reliableLargeQuestionCount = expectedCount && leading.length + groups.length === expectedCount;
  return [
    ...leading,
    ...groups.flatMap((items, index) => structureMaterialGroup(items, reliableLargeQuestionCount ? leading.length + index + 1 : (items[0].groupNumber || items[0].number))),
  ];
}

function mergeExamRecognitions(results) {
  const valid = (Array.isArray(results) ? results : []).filter((item) => item && Array.isArray(item.questions));
  if (!valid.length) throw new Error("provider_output_format_error");
  const questions = new Map();
  valid.forEach((result) => result.questions.forEach((question) => {
    const number = String(question.number || "").trim();
    const subNumber = String(question.subNumber || "").trim();
    const normalizedStem = String(question.stem || "").normalize("NFKC").replace(/[\s，。！？；：、“”‘’（）()【】\[\]《》<>·…—-]/g, "").slice(0, 120);
    const materialKey = (question.type === "material_analysis" || question.material || question.materialGroupId) && normalizedStem ? `:${normalizedStem}` : "";
    const key = number ? `number:${number}${subNumber ? `:sub:${subNumber}` : materialKey}` : `stem:${normalizedStem}`;
    if (key === "stem:") return;
    questions.set(key, mergeQuestion(questions.get(key), question));
  }));
  let mergedQuestions = [...questions.values()].sort((left, right) => {
    const leftNumber = Number(String(left.number || "").match(/\d+/)?.[0]);
    const rightNumber = Number(String(right.number || "").match(/\d+/)?.[0]);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return 0;
  });
  if (!mergedQuestions.length) throw new Error("provider_output_format_error");
  const metadata = valid.map((item) => item.metadata).find((item) => item && item.title && item.title !== "待校对试卷") || valid[0].metadata;
  mergedQuestions = structureMaterialQuestions(mergedQuestions, Number(metadata && metadata.totalQuestionCount));
  metadata.totalResponseItemCount = mergedQuestions.length;
  return {
    metadata,
    questions: mergedQuestions,
    warnings: [...new Set(valid.flatMap((item) => item.warnings || []))],
  };
}

function normalizedQuestionMarker(value) {
  return String(value || "").normalize("NFKC").replace(/[\s.、，:：；;（）()【】\[\]]/g, "").toLowerCase();
}

function answerHasContent(question) {
  return Boolean(
    (Array.isArray(question && question.correctAnswer) && question.correctAnswer.length)
    || String(question && question.referenceAnswer || "").trim()
    || (Array.isArray(question && question.scoringPoints) && question.scoringPoints.length),
  );
}

function mergeAnswerRecognitions(paperRecognition, answerRecognitions, options = {}) {
  const paper = paperRecognition && Array.isArray(paperRecognition.questions) ? paperRecognition : null;
  if (!paper) throw new Error("provider_output_format_error");
  const rawAnswers = (Array.isArray(answerRecognitions) ? answerRecognitions : [])
    .filter((result) => result && Array.isArray(result.questions))
    .flatMap((result) => result.questions);
  const answerMap = new Map();
  rawAnswers.forEach((answer) => {
    if (!answerHasContent(answer)) return;
    const number = normalizedQuestionMarker(answer.number);
    if (!number) return;
    const subNumber = normalizedQuestionMarker(answer.subNumber);
    const key = `${number}:${subNumber}`;
    answerMap.set(key, mergeQuestion(answerMap.get(key), answer));
  });
  const answers = [...answerMap.values()];
  const questions = paper.questions.map((question) => ({ ...question }));
  const byNumber = new Map();
  questions.forEach((question, index) => {
    const number = normalizedQuestionMarker(question.number);
    if (!number) return;
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push({ index, subNumber: normalizedQuestionMarker(question.subNumber) });
  });
  let matchedCount = 0;
  let ambiguousCount = 0;
  let unmatchedCount = 0;
  answers.forEach((answer) => {
    if (!answerHasContent(answer)) return;
    const number = normalizedQuestionMarker(answer.number);
    const subNumber = normalizedQuestionMarker(answer.subNumber);
    let candidates = byNumber.get(number) || [];
    if (subNumber) candidates = candidates.filter((candidate) => candidate.subNumber === subNumber);
    if (!subNumber && candidates.length > 1) {
      const unused = candidates.filter((candidate) => !answerHasContent(questions[candidate.index]));
      if (unused.length === 1) candidates = unused;
    }
    if (candidates.length !== 1) {
      if (candidates.length > 1) ambiguousCount += 1;
      else unmatchedCount += 1;
      return;
    }
    const target = questions[candidates[0].index];
    const officialAnswer = String(answer.answerVariants && answer.answerVariants.official || answer.referenceAnswer || "").trim();
    const keepVerbatimOfficial = options.verbatimOfficialOnly === true;
    questions[candidates[0].index] = {
      ...target,
      sourceAnswerCandidate: keepVerbatimOfficial ? officialAnswer : target.sourceAnswerCandidate,
      correctAnswer: (answer.correctAnswer || []).length ? answer.correctAnswer : target.correctAnswer,
      referenceAnswer: keepVerbatimOfficial ? target.referenceAnswer : (officialAnswer || target.referenceAnswer),
      answerVariants: {
        ...(target.answerVariants || {}),
        official: keepVerbatimOfficial
          ? String(target.answerVariants && target.answerVariants.official || "")
          : (officialAnswer || String(target.answerVariants && target.answerVariants.official || "")),
      },
      answerSource: keepVerbatimOfficial ? target.answerSource : "pdf_answer",
      answerReviewStatus: "unreviewed",
      answerVerified: false,
      scoringPoints: (answer.scoringPoints || []).length ? answer.scoringPoints : target.scoringPoints,
      warnings: [...new Set([
        ...(target.warnings || []),
        keepVerbatimOfficial
          ? "AI 仅用于匹配答案题号，来源答案以原文件文本块为准"
          : "答案来自独立答案文件，请人工核对题号与内容",
      ])],
    };
    matchedCount += 1;
  });
  const missingAnswerCount = questions.filter((question) => !answerHasContent(question)).length;
  const warnings = [...new Set([
    ...(paper.warnings || []),
    ...((answerRecognitions || []).flatMap((result) => result && result.warnings || [])),
    ...(unmatchedCount ? [`答案文件中有 ${unmatchedCount} 项未匹配到试卷题号`] : []),
    ...(ambiguousCount ? [`答案文件中有 ${ambiguousCount} 项题号存在多个小问，需人工选择`] : []),
    ...(missingAnswerCount ? [`仍有 ${missingAnswerCount} 道题未识别到答案`] : []),
  ])];
  return {
    recognition: { ...paper, questions, warnings },
    matchedCount,
    ambiguousCount,
    unmatchedCount,
    missingAnswerCount,
  };
}

function applyVerbatimAnswerBlocks(paperRecognition, blocks) {
  const paper = paperRecognition && Array.isArray(paperRecognition.questions) ? paperRecognition : null;
  if (!paper) throw new Error("provider_output_format_error");
  const blockMap = new Map((Array.isArray(blocks) ? blocks : []).map((block) => [
    `${normalizedQuestionMarker(block.number)}:${normalizedQuestionMarker(block.subNumber)}`,
    block,
  ]));
  addStemDelimitedAnswerBlocks(blockMap, paper.questions);
  const questionCountsByNumber = new Map();
  paper.questions.forEach((question) => {
    const number = normalizedQuestionMarker(question.number);
    questionCountsByNumber.set(number, (questionCountsByNumber.get(number) || 0) + 1);
  });
  let recoveredCount = 0;
  let matchedCount = 0;
  const questions = paper.questions.map((question) => {
    const number = normalizedQuestionMarker(question.number);
    const subNumber = normalizedQuestionMarker(question.subNumber);
    const block = blockMap.get(`${number}:${subNumber}`)
      || (questionCountsByNumber.get(number) === 1 ? blockMap.get(`${number}:`) : null);
    if (!block) return question;
    matchedCount += 1;
    const official = cleanVerbatimAnswerText(block.text).slice(0, 20000);
    const currentOfficial = String(question.answerVariants && question.answerVariants.official || question.referenceAnswer || "").trim();
    const matchCandidate = currentOfficial || String(question.sourceAnswerCandidate || "").trim() || String(question.stem || "").trim();
    const trustedUniqueSubjectiveBlock = !["single_choice", "multiple_choice", "true_false"].includes(question.type)
      && questionCountsByNumber.get(number) === 1;
    if (!official || (!block.matchedByStem && !trustedUniqueSubjectiveBlock
      && (!matchCandidate || (!answerBlockMatches(matchCandidate, official) && !answerStemStartsBlock(question.stem, official))))) return question;
    if (official.replace(/\s/g, "") === currentOfficial.replace(/\s/g, "")) return question;
    recoveredCount += 1;
    const { sourceAnswerCandidate: _discardedCandidate, ...baseQuestion } = question;
    return {
      ...baseQuestion,
      referenceAnswer: official,
      answerVariants: { ...(question.answerVariants || {}), official },
      answerSource: "pdf_answer",
      answerReviewStatus: "unreviewed",
      answerVerified: false,
      warnings: [...new Set([...(question.warnings || []), "来源答案已按独立答案文件原文恢复，未由 AI 概括"])],
    };
  });
  return { recognition: { ...paper, questions }, recoveredCount, matchedCount, blockCount: blockMap.size };
}

function collectQuestions(raw) {
  if (Array.isArray(raw)) return raw;
  const direct = raw && (raw.questions || raw.items);
  if (Array.isArray(direct)) return direct;
  const sections = raw && raw.sections;
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((section) => (Array.isArray(section.questions) ? section.questions.map((question) => ({
    ...question,
    sectionTitle: question.sectionTitle || section.title || section.name,
    type: question.type || section.type,
  })) : []));
}

function normalizeOptions(options) {
  if (Array.isArray(options)) return options.map((option, index) => typeof option === "string"
    ? { key: String.fromCharCode(65 + index), text: option.replace(/^\s*[A-L][.、．]\s*/i, "").trim() }
    : { key: String(option && (option.key || option.label) || String.fromCharCode(65 + index)).toUpperCase(), text: String(option && (option.text || option.content) || "").trim() });
  if (options && typeof options === "object") return Object.entries(options).map(([key, text]) => ({ key: String(key).toUpperCase(), text: String(text).trim() }));
  return [];
}

function normalizeExamModelOutput(raw, defaults = {}) {
  if (!raw || typeof raw !== "object") throw new Error("provider_output_format_error");
  const metadata = raw.exam || raw.metadata || raw.paper || {};
  const questions = collectQuestions(raw).map((question, index) => {
    const typeValue = String(question.type || question.questionType || "").trim();
    const type = normalizeQuestionType(typeAliases[typeValue] || typeAliases[typeValue.replace(/\s/g, "")] || typeValue);
    const maxScore = Number(question.maxScore ?? question.score ?? question.points) || 1;
    const correctAnswer = question.correctAnswer ?? question.answer ?? [];
    const referenceAnswer = String(question.referenceAnswer || question.standardAnswer || question.answerAnalysis || (Array.isArray(correctAnswer) ? correctAnswer.join("、") : correctAnswer) || "").trim();
    const declaredAnswerSource = String(question.answerSource || question.answerProvenance || "").trim();
    const answerSource = ["pdf_answer", "team_verified", "ai_supplement", "community_consensus", "missing"].includes(declaredAnswerSource)
      ? declaredAnswerSource
      : (referenceAnswer || (Array.isArray(correctAnswer) && correctAnswer.length) ? "ai_supplement" : "missing");
    const stem = String(question.stem || question.question || question.content || "");
    const scoringPoints = Array.isArray(question.scoringPoints) ? question.scoringPoints : (Array.isArray(question.scorePoints) ? question.scorePoints : []);
    const scoringPointCandidates = !scoringPoints.length ? detectScoringPointCandidates(referenceAnswer) : [];
    return {
      number: question.number || question.no || index + 1,
      sectionTitle: question.sectionTitle || "",
      type,
      subjectId: question.subjectId || question.subject || question.subjectName || "",
      bookId: question.bookId || question.book || question.bookTitle || "",
      stem,
      options: normalizeOptions(question.options),
      correctAnswer,
      referenceAnswer,
      answerVariants: {
        official: ["pdf_answer", "team_verified"].includes(answerSource) ? referenceAnswer : "",
        ai: answerSource === "ai_supplement" ? referenceAnswer : "",
        community: "",
      },
      answerSource,
      answerReviewStatus: ["pdf_answer", "ai_supplement"].includes(answerSource) ? "unreviewed" : "verified",
      answerVerified: answerSource === "team_verified" || answerSource === "community_consensus",
      scoringPoints,
      scoringPointCandidates,
      scoringPolicy: question.scoringPolicy && typeof question.scoringPolicy === "object" ? question.scoringPolicy : null,
      maxScore,
      material: question.material || question.sharedMaterial || "",
      materialMarks: inferMaterialMarks({
        material: question.material || question.sharedMaterial || "",
        stem,
        annotationText: question.annotationText || question.markingText || "",
        materialMarks: question.materialMarks || question.sourceMarks || question.originalMarks,
      }),
      materialGroupId: question.materialGroupId || "",
      usesSharedMaterial: question.usesSharedMaterial !== false,
      groupNumber: question.groupNumber || "",
      subNumber: normalizedQuestionMarker(question.subNumber),
      responseMode: "text",
      annotationText: question.annotationText || question.markingText || "",
      chapter: question.chapter || defaults.chapter || "",
      knowledgePoints: question.knowledgePoints || question.knowledgePoint || [],
      sourcePage: question.sourcePage || question.page || "",
      confidence: question.confidence,
      warnings: question.warnings || [],
    };
  });
  if (!questions.length) throw new Error("provider_output_format_error");
  return {
    metadata: {
      title: metadata.title || metadata.name || defaults.title || "待校对试卷",
      description: metadata.description || defaults.description || "由试卷文件识别生成，确认前请逐题校对。",
      kind: defaults.kind || metadata.kind,
      year: defaults.year || metadata.year,
      durationMinutes: metadata.durationMinutes || metadata.duration || defaults.durationMinutes,
      totalQuestionCount: metadata.totalQuestionCount || metadata.questionCount || defaults.totalQuestionCount,
      freePreviewQuestionCount: defaults.freePreviewQuestionCount || 0,
      projectId: defaults.projectId || "gd-zsb-2026-hywxxkjc",
    },
    questions,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}

function saveExamPdf(importId, buffer, root = path.resolve(__dirname, "../../../.runtime/exams/uploads")) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${importId}.pdf`), buffer, { mode: 0o600 });
}

function saveExamSourceFile(importId, role, fileName, buffer, root = path.resolve(__dirname, "../../../.runtime/exams/uploads")) {
  if (!/^exam-import-[a-zA-Z0-9-]+$/.test(String(importId || ""))) throw new Error("exam_import_id_invalid");
  const safeRole = role === "answer" ? "answer" : "paper";
  const extension = path.extname(String(fileName || "")).toLowerCase() === ".docx" ? ".docx" : ".pdf";
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${importId}-${safeRole}${extension}`), buffer, { mode: 0o600 });
}

function loadExamSourceFile(importId, role, fileName, root = path.resolve(__dirname, "../../../.runtime/exams/uploads")) {
  if (!/^exam-import-[a-zA-Z0-9-]+$/.test(String(importId || ""))) throw new Error("exam_import_id_invalid");
  const safeRole = role === "answer" ? "answer" : "paper";
  const extension = path.extname(String(fileName || "")).toLowerCase() === ".docx" ? ".docx" : ".pdf";
  return fs.readFileSync(path.join(root, `${importId}-${safeRole}${extension}`));
}

function deleteExamSourceFiles(importId, root = path.resolve(__dirname, "../../../.runtime/exams/uploads")) {
  if (!/^exam-import-[a-zA-Z0-9-]+$/.test(String(importId || ""))) return false;
  let deleted = false;
  [
    `${importId}.pdf`,
    `${importId}-paper.pdf`, `${importId}-paper.docx`,
    `${importId}-answer.pdf`, `${importId}-answer.docx`,
  ].forEach((name) => {
    try { fs.unlinkSync(path.join(root, name)); deleted = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  });
  return deleted;
}

function deleteExamPdf(importId, root = path.resolve(__dirname, "../../../.runtime/exams/uploads")) {
  if (!/^exam-import-[a-zA-Z0-9-]+$/.test(String(importId || ""))) return false;
  const filePath = path.join(root, `${importId}.pdf`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

module.exports = {
  applySequentialObjectiveAnswerSections,
  applyVerbatimAnswerBlocks,
  cleanVerbatimAnswerText,
  deleteExamPdf,
  deleteExamSourceFiles,
  examPagesForModel,
  extractVerbatimAnswerBlocks,
  extractSequentialObjectiveAnswerSections,
  loadExamSourceFile,
  mergeAnswerRecognitions,
  mergeExamRecognitions,
  normalizeExamModelOutput,
  reflowVerbatimAnswerText,
  saveExamPdf,
  saveExamSourceFile,
};
