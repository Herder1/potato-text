const chineseTypeMap = {
  单选: "single_choice",
  单选题: "single_choice",
  多选: "multiple_choice",
  多选题: "multiple_choice",
  判断: "true_false",
  判断题: "true_false",
  填空: "fill_blank",
  填空题: "fill_blank",
  断句题: "punctuation",
  加点字翻译: "classical_word_explanation",
  加点字解释: "classical_word_explanation",
  加点字词解释: "classical_word_explanation",
  古文翻译: "translation",
  古文翻译题: "translation",
  简答: "short_answer",
  简答题: "short_answer",
  名词解释: "term_definition",
  名词解释题: "term_definition",
  材料分析: "material_analysis",
  材料分析题: "material_analysis",
  作品赏析: "appreciation",
  作品赏析题: "appreciation",
  论述: "essay",
  论述题: "essay",
};

function normalizeLabel(label) {
  return String(label || "").replace(/\s/g, "");
}

function normalizeChapterPath(value) {
  return String(value || "")
    .split(/[·•＞>]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("·");
}

function splitPlainTextBlocks(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const lines = normalized.split("\n");
  const blocks = [];
  let current = [];
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };
  const isQuestionHeading = (line) => {
    const match = String(line || "").match(/^\s*(?:\d+[.、]\s*)?(?:\[([^\]]+)\]|【([^】]+)】)\s*\S/);
    return Boolean(match && chineseTypeMap[normalizeLabel(match[1] || match[2])]);
  };
  lines.forEach((line) => {
    if (/^\s*---+\s*$/.test(line)) {
      flush();
      return;
    }
    if (isQuestionHeading(line) && current.some((item) => item.trim())) flush();
    current.push(line);
  });
  flush();
  return blocks.length ? blocks : [normalized];
}

function normalizeNewlinesWithOffsets(value) {
  const source = String(value || "");
  let text = "";
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\r") {
      if (source[index + 1] === "\n") index += 1;
      text += "\n";
    } else {
      text += source[index];
    }
    offsets.push(index + 1);
  }
  return { text, offsets };
}

function locatePlainTextBlocks(text) {
  const { text: normalized, offsets } = normalizeNewlinesWithOffsets(text);
  const blocks = splitPlainTextBlocks(normalized);
  let cursor = 0;
  return blocks.map((block) => {
    const locatedAt = normalized.indexOf(block, cursor);
    const start = locatedAt >= 0 ? locatedAt : cursor;
    const end = start + block.length;
    cursor = end;
    return { text: block, sourceRange: { start: offsets[start], end: offsets[end] } };
  });
}

function parseScoringPointLine(value) {
  const match = String(value || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*[|｜]\s*(.+)$/);
  return match ? { score: Number(match[1]), description: match[2].trim() } : null;
}

function parseOptionLine(value) {
  const line = String(value || "").trim();
  const markerPattern = /(^|[^A-Za-z0-9])([A-LＡ-Ｌ])\s*[.、．:：]\s*/g;
  const markers = [...line.matchAll(markerPattern)].map((marker) => ({
    key: marker[2].normalize("NFKC").toUpperCase(),
    markerStart: marker.index + marker[1].length,
    contentStart: marker.index + marker[0].length,
  }));
  if (!markers.length || markers[0].markerStart !== 0) return [];
  return markers.map((marker, index) => ({
    key: marker.key,
    text: line.slice(marker.contentStart, markers[index + 1]?.markerStart ?? line.length).trim(),
  })).filter((option) => option.text);
}

function parseChoiceCorrectAnswer(value) {
  const matches = String(value || "").normalize("NFKC").toUpperCase().match(/[A-L]/g);
  return matches ? [...new Set(matches)] : [];
}

function parseCorrectAnswer(value, type) {
  if (type === "single_choice" || type === "multiple_choice") return parseChoiceCorrectAnswer(value);
  const separator = type === "fill_blank" ? /[，,、；;|｜]/ : /[，,、]/;
  return String(value || "").split(separator).map((item) => item.trim()).filter(Boolean);
}

const standardFillBlank = "________";
const fillBlankPattern = /_{2,}|＿{2,}|□{2,}|(?:\(\s*\)|（\s*）|\[\s*\]|【\s*】)/gu;

function likelyFillGapCandidates(value) {
  const text = String(value || "");
  const citation = text.match(/(?:\[[^\]]*(?:大学|年研)[^\]]*\]|［[^］]*(?:大学|年研)[^］]*］|[（(][^）)]*(?:大学|年研)[^）)]*[）)])\s*$/u);
  const mainEnd = citation ? citation.index : text.length;
  return [...text.matchAll(/\s+/gu)].map((match) => {
    if (match.index >= mainEnd) return null;
    const previous = text.slice(Math.max(0, match.index - 16), match.index);
    const next = text.slice(match.index + match[0].length, match.index + match[0].length + 16);
    let score = 0;
    if (/^[，。；！？]/u.test(next)) score += 7;
    if (/[，；：]$/u.test(previous) && /^[\u3400-\u9fff《“]/u.test(next)) score += 7;
    if (/^(?:的|是|为|被|属于|称为|称作)/u.test(next)) score += 5;
    if (/(?:是|为|属于|称为|称作|小说集|长篇小说|短篇小说|报告文学|小说|作品|长诗|散文|诗歌|专栏|杂志|口号|作者|流派|话剧)$/u.test(previous)) score += 5;
    return score >= 5 ? { index: match.index, length: match[0].length, score } : null;
  }).filter(Boolean);
}

function insertFillBlanksAtGaps(value, candidates, count) {
  const selected = candidates
    .slice()
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, count)
    .sort((left, right) => right.index - left.index);
  return selected.reduce((text, candidate) => (
    `${text.slice(0, candidate.index)}${standardFillBlank}${text.slice(candidate.index + candidate.length)}`
  ), value);
}

function normalizeFillBlankStem(value, correctAnswer = []) {
  let stem = String(value || "").replace(fillBlankPattern, standardFillBlank);
  const answerCount = Math.max(1, Array.isArray(correctAnswer) ? correctAnswer.length : 1);
  let blanks = [...stem.matchAll(/________/g)];
  let candidates = likelyFillGapCandidates(stem);

  if (blanks.length === 1 && answerCount === 1 && candidates.length) {
    const suffix = stem.slice(blanks[0].index + standardFillBlank.length);
    if (/^\s*(?:[。！？；，]\s*)?(?:\[[^\]]+\]|［[^］]+］|[（(][^）)]+[）)])?\s*$/u.test(suffix)) {
      stem = `${stem.slice(0, blanks[0].index)}${stem.slice(blanks[0].index + standardFillBlank.length)}`;
      blanks = [];
      candidates = likelyFillGapCandidates(stem);
    }
  }

  if (blanks.length < answerCount && candidates.length) {
    stem = insertFillBlanksAtGaps(stem, candidates, answerCount - blanks.length);
  }
  if (/________/.test(stem)) return stem;

  const terminalCue = /(是|为|属于|称为|称作|名为)(?=[。！？；，])/u;
  if (terminalCue.test(stem)) return stem.replace(terminalCue, `$1${standardFillBlank}`);
  if (/^(?:提出|倡导|主张|对|曾创作|曾提出|创作|发表|被称|被誉|荣获|获得|的《|的小说)/u.test(stem)) {
    return `${standardFillBlank}${stem}`;
  }
  return stem;
}

function normalizeImportedCandidate(candidate) {
  if (candidate.type !== "fill_blank") return candidate;
  return { ...candidate, stem: normalizeFillBlankStem(candidate.stem, candidate.correctAnswer) };
}

function parsePlainBlock(block, defaults) {
  const candidate = {
    ...defaults,
    knowledgePoints: [],
    options: [],
    correctAnswer: [],
    scoringPoints: [],
    freePreview: { question: false, answer: false, analysis: false },
  };
  let activeField = "";
  const append = (field, value) => {
    if (!value) return;
    candidate[field] = candidate[field] ? `${candidate[field]}\n${value}` : value;
  };
  String(block).split("\n").forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (!line) return;
    const heading = line.match(/^\s*(?:\d+[.、]\s*)?(?:\[([^\]]+)\]|【([^】]+)】)\s*(.*)$/);
    if (lineIndex === 0 && heading) {
      candidate.type = chineseTypeMap[normalizeLabel(heading[1] || heading[2])] || String(heading[1] || heading[2]).trim();
      candidate.stem = heading[3].trim();
      activeField = "stem";
      return;
    }
    const options = parseOptionLine(line);
    if (options.length) {
      candidate.options.push(...options);
      activeField = "";
      return;
    }
    const field = line.match(/^(题型|题目|题干|章节|知识点|答案|正确答案|参考答案|解析|得分点|分值|总分|来源|答案依据|页码|教材页码|试看)\s*[：:]\s*(.*)$/);
    if (field) {
      const label = normalizeLabel(field[1]);
      const value = field[2].trim();
      if (label === "题型") candidate.type = chineseTypeMap[normalizeLabel(value)] || value;
      else if (label === "题目" || label === "题干") { candidate.stem = value; activeField = "stem"; }
      else if (label === "章节") candidate.chapter = normalizeChapterPath(value);
      else if (label === "知识点") candidate.knowledgePoints = value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
      else if (label === "答案") {
        if (["single_choice", "multiple_choice", "true_false", "fill_blank"].includes(candidate.type)) {
          candidate.correctAnswer = parseCorrectAnswer(value, candidate.type);
        } else {
          candidate.referenceAnswer = value;
          activeField = "referenceAnswer";
        }
      }
      else if (label === "正确答案") candidate.correctAnswer = parseCorrectAnswer(value, candidate.type);
      else if (label === "参考答案") { candidate.referenceAnswer = value; activeField = "referenceAnswer"; }
      else if (label === "解析") { candidate.analysis = value; activeField = "analysis"; }
      else if (label === "得分点") {
        const point = parseScoringPointLine(value);
        if (point) candidate.scoringPoints.push(point);
        activeField = "scoringPoints";
      } else if (label === "分值" || label === "总分") candidate.maxScore = Number(value);
      else if (label === "来源" || label === "答案依据") candidate.sourceLabel = value;
      else if (label === "页码" || label === "教材页码") candidate.sourcePage = value;
      else if (label === "试看") {
        candidate.freePreview = {
          question: /题目|全部/.test(value),
          answer: /答案|全部/.test(value),
          analysis: /解析|全部/.test(value),
        };
      }
      return;
    }
    if (activeField === "scoringPoints") {
      const point = parseScoringPointLine(line.replace(/^[-*]\s*/, ""));
      if (point) candidate.scoringPoints.push(point);
      return;
    }
    if (["stem", "referenceAnswer", "analysis"].includes(activeField)) append(activeField, line);
    else if (!candidate.stem) candidate.stem = line.replace(/^\s*\d+[.、]\s*/, "");
  });
  if (!candidate.referenceAnswer && candidate.analysis) candidate.referenceAnswer = candidate.analysis;
  return candidate;
}

function parseQuestionImportText(text, defaults = {}) {
  const normalizedSource = String(text || "").replace(/\r\n?/g, "\n");
  const source = normalizedSource.trim();
  if (!source) throw new Error("question_import_text_required");
  if (source.length > 2 * 1024 * 1024) throw new Error("question_import_text_too_large");
  if (/^\[\s*\{/.test(source) || source.startsWith("{")) {
    try {
      const parsed = JSON.parse(source);
      const questions = Array.isArray(parsed) ? parsed : parsed.questions;
      if (!Array.isArray(questions)) throw new Error("question_import_json_invalid");
      return questions.map((question) => normalizeImportedCandidate({ ...defaults, ...question }));
    } catch (error) {
      if (error.message === "question_import_json_invalid") throw error;
      throw new Error("question_import_json_invalid");
    }
  }
  const blocks = locatePlainTextBlocks(text);
  if (!blocks.length) throw new Error("question_import_text_required");
  return blocks.map((block) => normalizeImportedCandidate({
    ...parsePlainBlock(block.text, defaults),
    sourceRange: block.sourceRange,
  }));
}

module.exports = { normalizeChapterPath, normalizeFillBlankStem, parseQuestionImportText, splitPlainTextBlocks };
