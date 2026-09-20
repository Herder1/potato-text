const fs = require("node:fs");
const path = require("node:path");
const Busboy = require("busboy");
const mammoth = require("mammoth");
const { extractPdf } = require("./textbook-pdf");

const MAX_EXAM_FILE_BYTES = 150 * 1024 * 1024;
const supportedFormats = new Set(["pdf", "docx"]);
const defaultJobRoot = path.resolve(__dirname, "../../../.runtime/exams/jobs");

function safeUploadName(value, fallback = "document") {
  return path.basename(String(value || fallback)).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || fallback;
}

function safeJobId(value) {
  const id = String(value || "");
  if (!/^[a-f0-9-]{20,80}$/i.test(id)) throw new Error("exam_import_job_id_invalid");
  return id;
}

function examJobFilePath(jobId, role, fileName, root = defaultJobRoot) {
  const id = safeJobId(jobId);
  const safeRole = role === "answer" ? "answer" : "paper";
  const extension = examDocumentFormat(fileName) === "docx" ? ".docx" : ".pdf";
  return path.join(root, `${id}-${safeRole}${extension}`);
}

function saveExamJobFile(jobId, role, file, root = defaultJobRoot) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw new Error("exam_file_empty");
  const target = examJobFilePath(jobId, role, file.fileName, root);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(target, file.buffer, { mode: 0o600 });
  return target;
}

function loadExamJobFile(jobId, role, fileName, mimeType = "", root = defaultJobRoot) {
  const target = examJobFilePath(jobId, role, fileName, root);
  const buffer = fs.readFileSync(target);
  return { fileName: safeUploadName(fileName), mimeType: String(mimeType || ""), size: buffer.length, buffer };
}

function deleteExamJobFiles(jobId, root = defaultJobRoot) {
  const id = safeJobId(jobId);
  let deleted = false;
  ["paper.pdf", "paper.docx", "answer.pdf", "answer.docx"].forEach((suffix) => {
    try { fs.unlinkSync(path.join(root, `${id}-${suffix}`)); deleted = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  });
  return deleted;
}

function examDocumentFormat(fileName, mimeType = "") {
  const extension = path.extname(String(fileName || "")).toLowerCase().replace(/^\./, "");
  if (supportedFormats.has(extension)) return extension;
  if (String(mimeType).includes("pdf")) return "pdf";
  if (String(mimeType).includes("wordprocessingml")) return "docx";
  return "";
}

function splitWordText(text, maxChars = 10000) {
  const normalized = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return [];
  const explicitPages = normalized.split(/\f+/).map((item) => item.trim()).filter(Boolean);
  const blocks = explicitPages.length > 1 ? explicitPages : normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const pages = [];
  let current = "";
  const commit = () => {
    if (current.trim()) pages.push(current.trim());
    current = "";
  };
  blocks.forEach((block) => {
    if (block.length > maxChars) {
      commit();
      for (let start = 0; start < block.length; start += maxChars) pages.push(block.slice(start, start + maxChars).trim());
      return;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > maxChars) commit();
    current = current ? `${current}\n\n${block}` : block;
  });
  commit();
  return pages.filter(Boolean);
}

async function extractExamDocument(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("exam_file_empty");
  if (buffer.length > MAX_EXAM_FILE_BYTES) throw new Error("exam_file_too_large");
  const fileName = safeUploadName(options.fileName, "document");
  const format = examDocumentFormat(fileName, options.mimeType);
  if (!format) throw new Error("exam_file_type_unsupported");
  if (format === "pdf") {
    try {
      const extracted = await extractPdf(buffer);
      return { ...extracted, format, fileName };
    } catch (error) {
      if (error.message === "textbook_pdf_invalid") throw new Error("exam_pdf_invalid");
      if (error.message === "textbook_pdf_too_large") throw new Error("exam_file_too_large");
      throw error;
    }
  }
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = String(result.value || "").trim();
    if (text.length < 20) throw new Error("exam_docx_empty");
    const pageTexts = splitWordText(text);
    return {
      format,
      fileName,
      pageCount: pageTexts.length,
      textChars: text.length,
      pages: pageTexts.map((pageText, index) => ({ pageNumber: index + 1, text: pageText })),
      warnings: (result.messages || []).map((message) => String(message.message || message)).filter(Boolean),
    };
  } catch (error) {
    if (error.message === "exam_docx_empty") throw error;
    throw new Error("exam_docx_invalid");
  }
}

function readExamMultipart(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        defParamCharset: "utf8",
        limits: { files: 2, fields: 12, fileSize: MAX_EXAM_FILE_BYTES, fieldSize: 4096 },
      });
    } catch (error) {
      reject(new Error("exam_multipart_invalid"));
      return;
    }
    const fields = {};
    const files = {};
    let failure = null;
    parser.on("field", (name, value) => { fields[String(name)] = String(value); });
    parser.on("file", (name, stream, info = {}) => {
      const role = name === "answer" ? "answer" : (name === "paper" ? "paper" : "");
      if (!role) { stream.resume(); return; }
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => { size += chunk.length; chunks.push(chunk); });
      stream.on("limit", () => { failure = new Error("exam_file_too_large"); });
      stream.on("error", (error) => { failure = error; });
      stream.on("end", () => {
        if (failure) return;
        files[role] = {
          fileName: safeUploadName(info.filename, `${role}.pdf`),
          mimeType: String(info.mimeType || ""),
          size,
          buffer: Buffer.concat(chunks, size),
        };
      });
    });
    parser.on("filesLimit", () => { failure = new Error("exam_file_count_invalid"); });
    parser.on("error", () => reject(new Error("exam_multipart_invalid")));
    parser.on("finish", () => {
      if (failure) reject(failure);
      else if (!files.paper) reject(new Error("exam_paper_file_required"));
      else resolve({ fields, files });
    });
    request.pipe(parser);
  });
}

module.exports = {
  MAX_EXAM_FILE_BYTES,
  deleteExamJobFiles,
  examDocumentFormat,
  loadExamJobFile,
  extractExamDocument,
  readExamMultipart,
  saveExamJobFile,
  splitWordText,
};
