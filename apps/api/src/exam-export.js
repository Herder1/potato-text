const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { normalizeQuestionType, normalizeQuestionTypeLabel } = require("../../miniprogram/utils/question-type");

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 90;
const CONTENT_TOP = 92;
const CONTENT_BOTTOM = 780;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const choiceTypes = new Set(["single_choice", "multiple_choice", "true_false"]);
const typeLabels = {
  single_choice: "单项选择题",
  multiple_choice: "多项选择题",
  true_false: "判断题",
  fill_blank: "填空题",
  punctuation: "断句题",
  classical_word_explanation: "加点字词解释",
  translation: "古文翻译",
  short_answer: "简答题",
  term_definition: "名词解释",
  material_analysis: "材料分析题",
  essay: "论述题",
};
const chineseSectionNumbers = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const circledNumbers = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function cleanText(value) {
  return String(value || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .trim();
}

function cleanSubNumber(value) {
  return cleanText(value)
    .normalize("NFKC")
    .replace(/^[\s(\[【]+/, "")
    .replace(/[\s)\]】]+$/, "");
}

function safeFilename(value) {
  return cleanText(value).replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 80) || "薯考试卷";
}

function approximateTextWidth(text, fontSize) {
  let width = 0;
  for (const character of String(text || "")) {
    if (/\s/.test(character)) width += fontSize * 0.32;
    else if (/^[\x00-\xff]$/.test(character)) width += fontSize * 0.55;
    else width += fontSize;
  }
  return width;
}

function wrapText(text, maxWidth, fontSize, firstLineWidth = maxWidth) {
  const sourceLines = String(text || "").split("\n");
  const result = [];
  sourceLines.forEach((sourceLine, sourceIndex) => {
    if (!sourceLine) {
      result.push("");
      return;
    }
    let current = "";
    let currentWidth = 0;
    let lineLimit = result.length === 0 ? firstLineWidth : maxWidth;
    for (const character of sourceLine) {
      const characterWidth = approximateTextWidth(character, fontSize);
      if (current && currentWidth + characterWidth > lineLimit) {
        result.push(current);
        current = character;
        currentWidth = characterWidth;
        lineLimit = maxWidth;
      } else {
        current += character;
        currentWidth += characterWidth;
      }
    }
    if (current || sourceIndex < sourceLines.length - 1) result.push(current);
  });
  return result.length ? result : [""];
}

class PdfLayout {
  constructor({ headerText = "更多汉语言插本文学资讯，请关注公众号：汉化土豆", watermarkText = "薯考" } = {}) {
    this.headerText = headerText;
    this.watermarkText = watermarkText;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.pages.push([]);
    this.y = CONTENT_TOP;
  }

  currentPage() {
    return this.pages[this.pages.length - 1];
  }

  ensureSpace(height) {
    if (this.y + height > CONTENT_BOTTOM) this.newPage();
  }

  drawText(text, x, y, options = {}) {
    if (!text) return;
    this.currentPage().push({ type: "text", text, x, y, fontSize: options.fontSize || 12, bold: options.bold === true, gray: options.gray });
  }

  addParagraph(text, options = {}) {
    const fontSize = options.fontSize || 12;
    const lineHeight = options.lineHeight || Math.max(18, fontSize * 1.65);
    const leftIndent = options.leftIndent || 0;
    const firstLineIndent = options.firstLineIndent || 0;
    const width = options.width || CONTENT_WIDTH - leftIndent;
    const lines = wrapText(cleanText(text), width, fontSize, width - firstLineIndent);
    lines.forEach((line, index) => {
      this.ensureSpace(lineHeight);
      const indent = index === 0 ? firstLineIndent : 0;
      let x = MARGIN_X + leftIndent + indent;
      if (options.align === "center") x = (PAGE_WIDTH - approximateTextWidth(line, fontSize)) / 2;
      if (options.align === "right") x = PAGE_WIDTH - MARGIN_X - approximateTextWidth(line, fontSize);
      this.drawText(line, x, this.y, options);
      this.y += lineHeight;
    });
    this.y += options.after || 0;
  }

  addSpacer(height) {
    this.ensureSpace(height);
    this.y += height;
  }

  addRule() {
    this.ensureSpace(12);
    this.currentPage().push({ type: "line", x1: MARGIN_X, y1: this.y, x2: PAGE_WIDTH - MARGIN_X, y2: this.y, gray: 0.82, width: 0.5 });
    this.y += 12;
  }

  addOptions(options = []) {
    const normalized = options.map((option, index) => ({
      key: cleanText(option && option.key || String.fromCharCode(65 + index)),
      text: cleanText(option && option.text),
    })).filter((option) => option.text);
    if (!normalized.length) return;
    const fontSize = 11.5;
    const gap = 12;
    const widest = Math.max(...normalized.map((option) => approximateTextWidth(`${option.key}. ${option.text}`, fontSize)));
    const columns = widest <= (CONTENT_WIDTH - gap * 3) / 4 ? 4 : (widest <= (CONTENT_WIDTH - gap) / 2 ? 2 : 1);
    const columnWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
    const rows = [];
    for (let index = 0; index < normalized.length; index += columns) rows.push(normalized.slice(index, index + columns));
    rows.forEach((row) => {
      const wrapped = row.map((option) => wrapText(`${option.key}. ${option.text}`, columnWidth, fontSize));
      const rowHeight = Math.max(...wrapped.map((lines) => lines.length)) * 18 + 4;
      this.ensureSpace(rowHeight);
      wrapped.forEach((lines, columnIndex) => {
        lines.forEach((line, lineIndex) => this.drawText(line, MARGIN_X + columnIndex * (columnWidth + gap), this.y + lineIndex * 18, { fontSize }));
      });
      this.y += rowHeight;
    });
  }
}

function groupQuestions(questions) {
  const groups = [];
  questions.forEach((question, index) => {
    const type = normalizeQuestionType(question.type || "short_answer");
    const last = groups[groups.length - 1];
    if (!last || last.type !== type) groups.push({ type, questions: [{ question, index }] });
    else last.questions.push({ question, index });
  });
  return groups;
}

function groupScore(group, selectionRules = []) {
  const scoreById = new Map(group.questions.map(({ question }) => [String(question.id), Number(question.maxScore || question.score) || 0]));
  let total = [...scoreById.values()].reduce((sum, score) => sum + score, 0);
  const notes = [];
  selectionRules.forEach((rule) => {
    const ids = (Array.isArray(rule.questionIds) ? rule.questionIds : []).map(String).filter((id) => scoreById.has(id));
    if (ids.length < 2) return;
    const required = Math.min(ids.length, Math.max(1, Number(rule.requiredCount) || ids.length));
    ids.slice(required).forEach((id) => { total -= scoreById.get(id) || 0; });
    notes.push(`任答 ${required} 题，多答只按前 ${required} 题计分`);
  });
  return { total, notes };
}

function sectionTitle(group, groupIndex, selectionRules) {
  const scores = group.questions.map(({ question }) => Number(question.maxScore || question.score) || 0);
  const uniform = scores.length && scores.every((score) => score === scores[0]);
  const summary = groupScore(group, selectionRules);
  const parts = [`本大题共 ${group.questions.length} 小题`];
  if (summary.notes.length) parts.push(...summary.notes);
  else if (uniform) parts.push(`每小题 ${scores[0]} 分`);
  parts.push(`共 ${summary.total} 分`);
  return `${chineseSectionNumbers[groupIndex] || groupIndex + 1}、${typeLabels[group.type] || group.questions[0].question.typeLabel || "综合题"}（${parts.join("，")}）`;
}

function materialLabel(index) {
  return `材料${chineseSectionNumbers[index] || index + 1}`;
}

function addExamQuestion(layout, item, materialState) {
  const { question, index } = item;
  const material = cleanText(question.material);
  const materialGroupId = cleanText(question.materialGroupId);
  if (material && materialGroupId && question.usesSharedMaterial !== false && !materialState.rendered.has(materialGroupId)) {
    if (!materialState.labels.has(materialGroupId)) materialState.labels.set(materialGroupId, materialLabel(materialState.labels.size));
    layout.ensureSpace(64);
    layout.addParagraph(materialState.labels.get(materialGroupId), { fontSize: 12, bold: true, lineHeight: 20, after: 4 });
    layout.addParagraph(material, { fontSize: 11.5, lineHeight: 20, firstLineIndent: 23, after: 8 });
    materialState.rendered.add(materialGroupId);
  } else if (material && (!materialGroupId || question.usesSharedMaterial === false)) {
    layout.ensureSpace(60);
    layout.addParagraph("材料", { fontSize: 12, bold: true, lineHeight: 20, after: 4 });
    layout.addParagraph(material, { fontSize: 11.5, lineHeight: 20, firstLineIndent: 23, after: 8 });
  }
  const subNumber = cleanSubNumber(question.subNumber);
  const number = subNumber ? `${index + 1}.（${subNumber}）` : `${index + 1}.`;
  layout.ensureSpace(choiceTypes.has(question.type) ? 64 : 42);
  layout.addParagraph(`${number} ${cleanText(question.stem)}`, { fontSize: 12, lineHeight: 20, after: 6 });
  if (choiceTypes.has(question.type)) layout.addOptions(question.options);
  layout.addSpacer(5);
}

function finalReferenceAnswer(question) {
  const variants = question.answerVariants && typeof question.answerVariants === "object" ? question.answerVariants : {};
  return cleanText(variants.official || question.referenceAnswer || variants.community || variants.ai);
}

function answerCompleteness(questions) {
  const missingQuestionNumbers = [];
  const reviewQuestionNumbers = [];
  questions.forEach((question, index) => {
    const hasChoiceAnswer = Array.isArray(question.correctAnswer) && question.correctAnswer.length > 0;
    const hasSubjectiveAnswer = Boolean(finalReferenceAnswer(question)) || (Array.isArray(question.scoringPoints) && question.scoringPoints.length > 0);
    if (choiceTypes.has(question.type) ? !hasChoiceAnswer : !hasSubjectiveAnswer) missingQuestionNumbers.push(index + 1);
    if (["unreviewed", "doubtful"].includes(question.answerReviewStatus)) reviewQuestionNumbers.push(index + 1);
  });
  return { missingQuestionNumbers, reviewQuestionNumbers };
}

function normalizeExamSnapshot(exam = {}, questions = []) {
  const normalizedQuestions = (Array.isArray(questions) ? questions : []).slice(0, 300).map((question, index) => ({
    ...question,
    id: String(question && question.id || `export-question-${index + 1}`),
    type: normalizeQuestionType(question && question.type || "short_answer"),
    typeLabel: normalizeQuestionTypeLabel(question && question.typeLabel, question && question.type),
    stem: cleanText(question && question.stem),
    material: cleanText(question && question.material),
    options: Array.isArray(question && question.options) ? question.options : [],
    correctAnswer: Array.isArray(question && question.correctAnswer) ? question.correctAnswer.map((item) => cleanText(item)).filter(Boolean) : [],
    referenceAnswer: cleanText(question && question.referenceAnswer),
    scoringPoints: Array.isArray(question && question.scoringPoints) ? question.scoringPoints : [],
    maxScore: Math.max(0, Number(question && (question.maxScore || question.score)) || 0),
  })).filter((question) => question.stem);
  if (!normalizedQuestions.length) throw new Error("exam_export_questions_required");
  return {
    exam: {
      id: String(exam.id || ""),
      title: cleanText(exam.title || "汉语言文学学科基础试卷").slice(0, 120),
      description: cleanText(exam.description).slice(0, 1000),
      year: Number(exam.year) || new Date().getFullYear(),
      durationMinutes: Math.max(1, Number(exam.durationMinutes) || 120),
      totalScore: Math.max(0, Number(exam.totalScore || exam.declaredTotalScore) || normalizedQuestions.reduce((sum, question) => sum + question.maxScore, 0)),
      selectionRules: Array.isArray(exam.selectionRules) ? exam.selectionRules : [],
    },
    questions: normalizedQuestions,
  };
}

function buildExamPaperLayout(snapshot, pageCount = 0, options = {}) {
  const { exam, questions } = snapshot;
  const layout = new PdfLayout(options);
  layout.addParagraph(exam.title, { align: "center", fontSize: 17, bold: true, lineHeight: 26, after: 4 });
  if (!exam.title.includes("汉语言文学学科基础")) layout.addParagraph("汉语言文学学科基础", { align: "center", fontSize: 16, bold: true, lineHeight: 25, after: 8 });
  layout.addParagraph(`本试卷共 ${pageCount || "--"} 页，${questions.length} 小题，满分 ${exam.totalScore} 分。考试时间 ${exam.durationMinutes} 分钟`, { align: "center", fontSize: 11.5, lineHeight: 21, after: 10 });
  layout.addParagraph("注意事项：", { fontSize: 12, lineHeight: 20 });
  [
    "1. 答题前，请认真核对试卷名称、题号与页码。",
    "2. 选择题选出答案后，请清楚标记对应选项；如需改动，请先擦除原答案。",
    "3. 非选择题请按题号顺序作答，字迹清楚，超出规定范围的答案无效。",
    "4. 选答题按题目说明计分，多答只按规定数量和顺序计分。",
  ].forEach((line) => layout.addParagraph(line, { fontSize: 11.5, lineHeight: 20 }));
  layout.addSpacer(10);
  const materialState = { rendered: new Set(), labels: new Map() };
  groupQuestions(questions).forEach((group, groupIndex) => {
    layout.ensureSpace(50);
    layout.addParagraph(sectionTitle(group, groupIndex, exam.selectionRules), { fontSize: 12.5, bold: true, lineHeight: 22, after: 8 });
    group.questions.forEach((item) => addExamQuestion(layout, item, materialState));
  });
  return layout;
}

function addAnswerQuestion(layout, item) {
  const { question, index } = item;
  const number = `${index + 1}.`;
  if (choiceTypes.has(question.type)) {
    const correctAnswer = (question.correctAnswer || []).join("");
    const explanation = finalReferenceAnswer(question);
    layout.ensureSpace(40);
    layout.addParagraph(`${number} ${correctAnswer}${explanation ? `【精析】${explanation}` : ""}`, { fontSize: 11.5, lineHeight: 20, after: 5 });
    return;
  }
  layout.ensureSpace(54);
  layout.addParagraph(`${number} ${cleanText(question.stem)}`, { fontSize: 12, bold: true, lineHeight: 21, after: 4 });
  const referenceAnswer = finalReferenceAnswer(question);
  if (referenceAnswer) layout.addParagraph(referenceAnswer, { fontSize: 11.5, lineHeight: 20, firstLineIndent: 23, after: 5 });
  (Array.isArray(question.scoringPoints) ? question.scoringPoints : []).forEach((point, pointIndex) => {
    const score = Number(point && point.score);
    const page = cleanText(point && (point.textbookPage || point.textbookPages));
    const suffix = [Number.isFinite(score) && score > 0 ? `${score}分` : "", page ? `教材第${page}页` : ""].filter(Boolean).join("，");
    layout.addParagraph(`${circledNumbers[pointIndex] || `${pointIndex + 1}.`} ${cleanText(point && point.description)}${suffix ? `（${suffix}）` : ""}`, { fontSize: 11.5, lineHeight: 20, leftIndent: 12, after: 2 });
  });
  layout.addSpacer(5);
}

function buildAnswerLayout(snapshot, options = {}) {
  const { exam, questions } = snapshot;
  const layout = new PdfLayout(options);
  layout.addParagraph(`${exam.title} 答案`, { align: "center", fontSize: 16, bold: true, lineHeight: 26, after: 14 });
  groupQuestions(questions).forEach((group, groupIndex) => {
    layout.ensureSpace(48);
    layout.addParagraph(sectionTitle(group, groupIndex, exam.selectionRules), { fontSize: 12.5, bold: true, lineHeight: 22, after: 7 });
    group.questions.forEach((item) => addAnswerQuestion(layout, item));
  });
  return layout;
}

function pythonRendererCandidates() {
  const configured = String(process.env.SHUKAO_PDF_PYTHON || "").trim();
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe")
    : "";
  return [...new Set([configured, bundled, "python3", "python"].filter(Boolean))];
}

function buildPdfs(layouts) {
  const script = path.resolve(__dirname, "render-exam-pdf.py");
  const input = JSON.stringify({
    layouts: layouts.map((layout) => ({
      title: "薯考试卷",
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
      marginX: MARGIN_X,
      headerText: layout.headerText,
      watermarkText: layout.watermarkText,
      pages: layout.pages,
    })),
  });
  const encodedInput = zlib.gzipSync(Buffer.from(input, "utf8")).toString("base64");
  let lastError = null;
  let rendererError = null;
  for (const python of pythonRendererCandidates()) {
    const result = childProcess.spawnSync(python, [script], {
      input: Buffer.from(encodedInput, "ascii"),
      maxBuffer: 100 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error && result.error.code === "ENOENT") {
      lastError = result.error;
      continue;
    }
    if (result.status !== 0) {
      rendererError = new Error((result.stderr || Buffer.alloc(0)).toString("utf8").trim() || "exam_export_renderer_failed");
      continue;
    }
    try {
      const payload = JSON.parse((result.stdout || Buffer.alloc(0)).toString("utf8"));
      const pdfs = (payload.pdfs || []).map((item) => Buffer.from(item, "base64"));
      if (pdfs.length === layouts.length && pdfs.every((buffer) => buffer.subarray(0, 8).toString("ascii") === "%PDF-1.7")) return pdfs;
      rendererError = new Error("exam_export_renderer_output_invalid");
    } catch (error) {
      rendererError = error;
    }
  }
  const error = new Error("exam_export_renderer_unavailable");
  error.cause = rendererError || lastError;
  throw error;
}

function buildPdf(layout) {
  return buildPdfs([layout])[0];
}

function generateExamExportBundle(payload, options = {}) {
  const snapshot = normalizeExamSnapshot(payload.exam, payload.questions);
  const completeness = answerCompleteness(snapshot.questions);
  if (completeness.missingQuestionNumbers.length) {
    const error = new Error("exam_export_answers_incomplete");
    error.missingQuestionNumbers = completeness.missingQuestionNumbers;
    throw error;
  }
  const layoutOptions = { headerText: options.headerText, watermarkText: options.watermarkText };
  const firstPass = buildExamPaperLayout(snapshot, 0, layoutOptions);
  const paperLayout = buildExamPaperLayout(snapshot, firstPass.pages.length, layoutOptions);
  const answerLayout = buildAnswerLayout(snapshot, layoutOptions);
  const baseName = safeFilename(snapshot.exam.title);
  const [paperBuffer, answerBuffer] = buildPdfs([paperLayout, answerLayout]);
  return {
    snapshot,
    reviewQuestionNumbers: completeness.reviewQuestionNumbers,
    paper: { kind: "paper", label: "试卷", name: `${baseName}-试卷.pdf`, buffer: paperBuffer, pageCount: paperLayout.pages.length },
    answer: { kind: "answer", label: "答案", name: `${baseName}-答案.pdf`, buffer: answerBuffer, pageCount: answerLayout.pages.length },
  };
}

function createExamExportManifest(bundle, metadata = {}, id = `export-${crypto.randomUUID()}`) {
  return {
    id,
    status: "ready",
    examId: bundle.snapshot.exam.id,
    title: bundle.snapshot.exam.title,
    questionCount: bundle.snapshot.questions.length,
    reviewQuestionNumbers: bundle.reviewQuestionNumbers,
    files: [bundle.paper, bundle.answer].map((file) => ({
      kind: file.kind,
      label: file.label,
      name: file.name,
      size: file.buffer.length,
      pageCount: file.pageCount,
    })),
    createdAt: Date.now(),
    ...metadata,
  };
}

function persistExamExportBundle(bundle, rootPath, metadata = {}) {
  const manifest = createExamExportManifest(bundle, metadata);
  const id = manifest.id;
  const directory = path.resolve(rootPath, id);
  fs.mkdirSync(directory, { recursive: true });
  [bundle.paper, bundle.answer].forEach((file) => {
    const filePath = path.join(directory, `${file.kind}.pdf`);
    fs.writeFileSync(filePath, file.buffer, { mode: 0o600 });
  });
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function persistExamExportBundleToStorage(bundle, storage, metadata = {}) {
  const manifest = createExamExportManifest(bundle, metadata);
  const uploadedKeys = [];
  try {
    for (const file of [bundle.paper, bundle.answer]) {
      const objectKey = `exam-exports/${manifest.id}/${file.kind}.pdf`;
      await storage.put(objectKey, {
        buffer: file.buffer,
        fileName: file.name,
        mimeType: "application/pdf",
        metadata: {
          category: "exam_export",
          exportId: manifest.id,
          examId: manifest.examId,
          kind: file.kind,
          label: file.label,
          pageCount: file.pageCount,
          userId: metadata.userId || "",
        },
      });
      uploadedKeys.push(objectKey);
    }
    return manifest;
  } catch (error) {
    await Promise.all(uploadedKeys.map((objectKey) => storage.delete(objectKey).catch(() => undefined)));
    throw error;
  }
}

module.exports = {
  answerCompleteness,
  buildPdf,
  createExamExportManifest,
  generateExamExportBundle,
  normalizeExamSnapshot,
  persistExamExportBundle,
  persistExamExportBundleToStorage,
};
