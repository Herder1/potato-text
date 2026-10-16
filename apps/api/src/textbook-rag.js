const crypto = require("node:crypto");
const { normalizeQuestionType } = require("../../miniprogram/utils/question-type");

const VISUAL_BLOCK_TYPES = new Set(["figure", "image", "diagram", "chart", "illustration"]);

function cleanOcrText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeOcrBlocks(item) {
  const source = Array.isArray(item && item.blocks) ? item.blocks : [];
  if (!source.length) return null;
  const text = [];
  const visuals = [];
  source.forEach((block) => {
    const type = String(block && block.type || "paragraph").trim().toLowerCase();
    const content = cleanOcrText(block && (block.text ?? block.content));
    if (VISUAL_BLOCK_TYPES.has(type)) {
      visuals.push({
        type,
        caption: cleanOcrText(block && (block.caption ?? block.title)),
      });
      return;
    }
    if (content) text.push(content);
  });
  return { text: text.join("\n\n"), visuals };
}

function normalizeBodyOcrPages(raw, expectedPages = []) {
  const source = raw && Array.isArray(raw.pages) ? raw.pages : [];
  return expectedPages.map((expected, index) => {
    const pdfPage = Math.max(1, Number(expected.pageNumber) || index + 1);
    const item = source.find((page) => Number(page && page.pdfPage) === pdfPage) || source[index] || {};
    const blocks = normalizeOcrBlocks(item);
    return {
      pdfPage,
      printedPage: Math.max(0, Number(item.printedPage) || 0),
      text: cleanOcrText(blocks ? blocks.text : item.text),
      visuals: blocks ? blocks.visuals : [],
      confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)),
    };
  });
}

function printedPageFromText(text) {
  const lines = String(text || "").split(/\n/).map((line) => line.trim()).filter(Boolean).slice(-6);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^(?:第\s*)?(\d{1,4})(?:\s*页)?$/);
    if (match) return Number(match[1]);
  }
  return 0;
}

function evidenceReference(chunk, index) {
  const printedPage = Number(chunk.printedPageStart) > 0
    ? `教材第${chunk.printedPageStart}${chunk.printedPageEnd > chunk.printedPageStart ? `-${chunk.printedPageEnd}` : ""}页`
    : `PDF第${chunk.pdfPageStart}页`;
  const evidenceText = typeof chunk.retrievalText === "string" ? chunk.retrievalText : chunk.text;
  // 跨册候选（同一科目多本教材一起当候选）时，证据必须自带"出自哪一册"，
  // 否则模型无法把"这段正文说的事"归到上册还是下册。只有显式带了标签的检索路径才会打印。
  const textbook = String(chunk.bookLabel || "").trim() ? `｜教材:${String(chunk.bookLabel).trim()}` : "";
  return `[证据${index + 1}｜片段ID:${chunk.id}${textbook}｜${chunk.catalogPath}｜${printedPage}]\n${evidenceText}`;
}

function formatTextbookEvidence(chunks, maxCharacters = 12000) {
  let length = 0;
  const selected = [];
  (Array.isArray(chunks) ? chunks : []).forEach((chunk, index) => {
    const block = evidenceReference(chunk, index);
    if (length + block.length > maxCharacters) return;
    selected.push(block);
    length += block.length;
  });
  return selected.length ? selected.join("\n\n") : "未从教材正文知识库检索到充分证据。";
}

function generatedQuestionSchema() {
  return {
    questions: [{
      type: "single_choice | multiple_choice | true_false | fill_blank | short_answer | term_definition | material_analysis | essay",
      stem: "题干",
      material: "可选材料",
      options: [{ key: "A", text: "选项" }],
      correctAnswer: ["A"],
      referenceAnswer: "严格依据教材的参考答案；用 **短语** 标记核心概念、关键判断、得分点关键词和结论",
      maxScore: 2,
      scoringPoints: [{ description: "得分点", score: 2, textbookPage: "261-262" }],
      knowledgePoints: ["知识点"],
      catalogPath: "完整目录路径",
      evidenceChunkIds: ["knowledge-chunk-id"],
      explanation: "为什么答案可由教材证据推出",
      uncertainty: "证据不足时说明",
    }],
  };
}

function normalizeChoiceAnswer(answer) {
  const values = Array.isArray(answer) ? answer : String(answer || "").split(/[，,、\s]/);
  return [...new Set(values.flatMap((value) => String(value).toUpperCase().match(/[A-L]/g) || []))];
}

function isBibliographicQuestion(item) {
  const stem = String(item && item.stem || "");
  const options = (Array.isArray(item && item.options) ? item.options : [])
    .map((option) => String(option && option.text || ""));
  const directPattern = /(?:教材|本书|注释|脚注|文献)(?:中|第|所引|列出|记载|著录|收录|提到).{0,18}(?:页码|第\s*\d+\s*页|第\s*\d+\s*卷|出处)|页码是|所引页码|文献著录|收录于《[^》]+》第\s*\d+\s*卷/i;
  const optionBibliographyCount = options.filter((text) => /第\s*\d+\s*卷|第\s*\d+(?:[、，,]\s*\d+)*\s*页/.test(text)).length;
  return directPattern.test(stem) || (options.length >= 2 && optionBibliographyCount >= Math.ceil(options.length / 2));
}

function normalizeGeneratedQuestions(raw, context = {}) {
  if (!raw || !Array.isArray(raw.questions)) throw new Error("provider_output_format_error");
  const allowedTypes = new Set([
    "single_choice", "multiple_choice", "true_false", "fill_blank", "short_answer",
    "term_definition", "material_analysis", "essay",
  ]);
  const availableChunks = new Map((context.evidenceChunks || []).map((chunk) => [chunk.id, chunk]));
  return raw.questions.slice(0, Math.max(1, Number(context.count) || 5)).map((item) => {
    const candidateType = normalizeQuestionType(item.type);
    const type = allowedTypes.has(candidateType) ? candidateType : normalizeQuestionType(context.questionType || "single_choice");
    const options = Array.isArray(item.options) ? item.options.map((option, index) => ({
      key: String(option && option.key || String.fromCharCode(65 + index)).trim().toUpperCase(),
      text: String(option && option.text || "").trim(),
    })).filter((option) => option.key && option.text).slice(0, 12) : [];
    const correctAnswer = normalizeChoiceAnswer(item.correctAnswer);
    const evidenceChunkIds = (Array.isArray(item.evidenceChunkIds) ? item.evidenceChunkIds : [])
      .map(String).filter((id) => availableChunks.has(id));
    const evidence = evidenceChunkIds.map((id) => availableChunks.get(id));
    const fallbackEvidence = context.evidenceChunks && context.evidenceChunks[0];
    const sourceEvidence = evidence.length ? evidence : (fallbackEvidence ? [fallbackEvidence] : []);
    const page = sourceEvidence.map((chunk) => chunk.printedPageStart).filter(Boolean);
    const textbookPage = page.length ? String(page[0]) : "";
    const maxScore = Math.min(100, Math.max(1, Number(item.maxScore) || (type.includes("choice") ? 2 : 5)));
    let scoringPoints = Array.isArray(item.scoringPoints) ? item.scoringPoints.map((point) => ({
      id: crypto.randomUUID(),
      description: String(point && point.description || "").trim(),
      score: Math.max(0, Number(point && point.score) || 0),
      textbookPage: String(point && point.textbookPage || textbookPage),
      pageBasis: "textbook_text",
      sourceNote: `${context.bookTitle || "教材"} · ${item.catalogPath || context.catalogPath || sourceEvidence[0]?.catalogPath || ""}`,
    })).filter((point) => point.description && point.score > 0) : [];
    const scoreTotal = scoringPoints.reduce((total, point) => total + point.score, 0);
    if (!scoringPoints.length || Math.abs(scoreTotal - maxScore) > 0.001) {
      scoringPoints = [{
        id: crypto.randomUUID(),
        description: type.includes("choice") ? "选择教材表述相符的正确答案" : "完整回答教材中的核心表述",
        score: maxScore,
        textbookPage,
        pageBasis: "textbook_text",
        sourceNote: `${context.bookTitle || "教材"} · ${item.catalogPath || context.catalogPath || sourceEvidence[0]?.catalogPath || ""}`,
      }];
    }
    const question = {
      subjectId: context.subjectId,
      bookId: context.bookId,
      chapter: String(item.catalogPath || context.catalogPath || sourceEvidence[0]?.catalogPath || "未归类章节"),
      knowledgePoints: (Array.isArray(item.knowledgePoints) ? item.knowledgePoints : []).map(String).filter(Boolean).slice(0, 20),
      type,
      stem: String(item.stem || "").trim(),
      material: String(item.material || "").trim(),
      options,
      correctAnswer: type === "single_choice" || type === "multiple_choice" ? correctAnswer : (Array.isArray(item.correctAnswer) ? item.correctAnswer.map(String) : []),
      referenceAnswer: String(item.referenceAnswer || "").trim(),
      maxScore,
      scoringPoints,
      answerSource: "ai_supplement",
      answerReviewStatus: "unreviewed",
      sourceLabel: `${context.bookTitle || "教材"} · RAG 教材正文生成`,
      sourcePage: textbookPage ? `教材第${textbookPage}页` : "",
      evidenceChunkIds: sourceEvidence.map((chunk) => chunk.id),
      explanation: String(item.explanation || "").trim(),
      uncertainty: String(item.uncertainty || "").trim(),
    };
    if (!question.stem || !question.referenceAnswer || !question.knowledgePoints.length) throw new Error("provider_output_format_error");
    if (isBibliographicQuestion(item)) throw new Error("textbook_question_low_quality");
    if ((type === "single_choice" || type === "multiple_choice") && (options.length < 2 || !correctAnswer.length)) {
      throw new Error("provider_output_format_error");
    }
    return question;
  });
}

module.exports = {
  formatTextbookEvidence,
  generatedQuestionSchema,
  normalizeBodyOcrPages,
  normalizeGeneratedQuestions,
  isBibliographicQuestion,
  printedPageFromText,
};
