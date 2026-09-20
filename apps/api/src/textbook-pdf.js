const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const pdfParse = require("pdf-parse");

const uploadRoot = path.resolve(__dirname, "../../../.runtime/textbooks");
const previewRoot = path.resolve(__dirname, "../../../.runtime/textbook-page-previews");
const maxPdfBytes = 150 * 1024 * 1024;
const minimumUsefulTextChars = 80;
// Some scanned textbooks put the contents after front matter. Keep enough
// opening pages for a table of contents that starts around PDF page 20.
const defaultOcrPageLimit = 24;

function validatePdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("textbook_pdf_invalid");
  }
  if (buffer.length > maxPdfBytes) throw new Error("textbook_pdf_too_large");
}

async function extractPdf(buffer) {
  validatePdfBuffer(buffer);
  const pages = [];
  const result = await pdfParse(buffer, {
    pagerender(pageData) {
      return pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false }).then((content) => {
        let lastY = null;
        let text = "";
        content.items.forEach((item) => {
          const y = item.transform && item.transform[5];
          text += lastY === y ? String(item.str || "") : `\n${String(item.str || "")}`;
          lastY = y;
        });
        const normalized = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        pages.push(normalized);
        return normalized;
      });
    },
  });
  return { pages, pageCount: Number(result.numpages) || pages.length, textChars: pages.reduce((total, page) => total + page.length, 0) };
}

function requiresPdfOcr(extracted) {
  return !extracted || Number(extracted.textChars) < minimumUsefulTextChars;
}

function pdfToPpmCommand() {
  if (process.env.PDFTOPPM_PATH) return process.env.PDFTOPPM_PATH;
  if (process.platform === "win32") {
    const bundled = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "poppler", "Library", "bin", "pdftoppm.exe");
    if (fs.existsSync(bundled)) return bundled;
    return "pdftoppm.exe";
  }
  return "pdftoppm";
}

function runPdfToPpm(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const command = pdfToPpmCommand();
    const child = spawn(command, args, {
      shell: process.platform === "win32" && /\.cmd$/i.test(command),
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("pdf_ocr_render_timeout"));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr += String(chunk || "").slice(0, 2000); });
    child.on("error", () => finish(new Error("pdf_ocr_renderer_unavailable")));
    child.on("close", (code) => finish(code === 0 ? null : new Error(stderr.trim() ? `pdf_ocr_render_failed:${stderr.trim()}` : "pdf_ocr_render_failed")));
  });
}

async function renderPdfPageRangeForOcr(buffer, options = {}) {
  validatePdfBuffer(buffer);
  const totalPages = Math.max(1, Number(options.pageCount) || Number(options.endPage) || defaultOcrPageLimit);
  const firstPage = Math.max(1, Math.min(totalPages, Number(options.startPage) || 1));
  const requestedLastPage = Math.max(firstPage, Number(options.endPage) || firstPage + defaultOcrPageLimit - 1);
  const lastPage = Math.min(totalPages, requestedLastPage, firstPage + 7);
  const dpi = Math.min(180, Math.max(96, Number(options.dpi) || 120));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-textbook-ocr-"));
  const pdfPath = path.join(temporaryRoot, "source.pdf");
  const outputPrefix = path.join(temporaryRoot, "page");
  try {
    fs.writeFileSync(pdfPath, buffer, { mode: 0o600 });
    await runPdfToPpm([
      "-f", String(firstPage),
      "-l", String(lastPage),
      "-r", String(dpi),
      "-jpeg",
      "-jpegopt", "quality=76",
      pdfPath,
      outputPrefix,
    ]);
    const files = fs.readdirSync(temporaryRoot)
      .filter((name) => /^page-\d+\.jpg$/i.test(name))
      .sort((left, right) => Number(left.match(/(\d+)/)[1]) - Number(right.match(/(\d+)/)[1]));
    if (!files.length) throw new Error("pdf_ocr_render_empty");
    return files.map((name) => ({
      pageNumber: Number(name.match(/(\d+)/)[1]),
      mediaType: "image/jpeg",
      dataBase64: fs.readFileSync(path.join(temporaryRoot, name)).toString("base64"),
    }));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function renderPdfPagesForOcr(buffer, options = {}) {
  const pageLimit = Math.max(1, Math.min(48, Number(options.pageLimit) || defaultOcrPageLimit));
  return renderPdfPageRangeForOcr(buffer, {
    ...options,
    startPage: 1,
    endPage: pageLimit,
  });
}

function savePdfFile(bookId, buffer) {
  validatePdfBuffer(buffer);
  fs.mkdirSync(uploadRoot, { recursive: true });
  const filePath = path.join(uploadRoot, `${bookId}.pdf`);
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, buffer, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  return filePath;
}

function loadPdfFile(bookId) {
  const filePath = path.join(uploadRoot, `${bookId}.pdf`);
  try { return fs.readFileSync(filePath); }
  catch (error) { if (error.code === "ENOENT") throw new Error("textbook_pdf_not_found"); throw error; }
}

async function loadPdfPagePreviewFromPath(pdfPath, cacheKey, pageNumber, options = {}) {
  const page = Math.max(1, Math.floor(Number(pageNumber) || 1));
  const dpi = Math.min(150, Math.max(96, Number(options.dpi) || 120));
  const stat = fs.statSync(pdfPath);
  const safeBookId = String(cacheKey || "book").replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "book";
  const cacheDirectory = path.join(previewRoot, `${safeBookId}-${stat.size}-${Math.floor(stat.mtimeMs)}`);
  const outputPrefix = path.join(cacheDirectory, `${page}-${dpi}`);
  const outputPath = `${outputPrefix}.jpg`;
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    await runPdfToPpm([
      "-f", String(page),
      "-l", String(page),
      "-r", String(dpi),
      "-jpeg",
      "-jpegopt", "quality=78",
      "-singlefile",
      pdfPath,
      outputPrefix,
    ], 60000);
  }
  try { return fs.readFileSync(outputPath); }
  catch (error) { if (error.code === "ENOENT") throw new Error("pdf_ocr_render_empty"); throw error; }
}

async function loadPdfPagePreview(bookId, pageNumber, options = {}) {
  const pdfPath = path.join(uploadRoot, `${bookId}.pdf`);
  try { return await loadPdfPagePreviewFromPath(pdfPath, bookId, pageNumber, options); }
  catch (error) { if (error.code === "ENOENT") throw new Error("textbook_pdf_not_found"); throw error; }
}

function pagesForModel(pages, maxCharacters = 70000) {
  let total = 0;
  const selected = [];
  for (let index = 0; index < pages.length && index < 80; index += 1) {
    const block = `[PDF 第 ${index + 1} 页]\n${pages[index]}\n`;
    if (total + block.length > maxCharacters) break;
    selected.push(block);
    total += block.length;
  }
  return selected.join("\n");
}

function findTocStart(pages) {
  return pages.slice(0, 80).findIndex((page) => {
    const compact = String(page || "").replace(/\s/g, "");
    return compact.startsWith("目录") || compact.slice(0, 80).includes("目录绪论") || compact.slice(0, 80).includes("目录第一");
  });
}

function catalogPagesForModel(pages, maxCharacters = 30000) {
  const tocStart = findTocStart(pages);
  if (tocStart < 0) return pagesForModel(pages, maxCharacters);
  let total = 0;
  const selected = [];
  for (let index = tocStart; index < Math.min(pages.length, tocStart + 18); index += 1) {
    const page = String(pages[index] || "").trim();
    if (!page) {
      if (selected.length) break;
      continue;
    }
    const block = `[PDF 第 ${index + 1} 页]\n${page}\n`;
    if (total + block.length > maxCharacters) break;
    selected.push(block);
    total += block.length;
  }
  return selected.join("\n");
}

function localCatalogDraft(pages) {
  const tocNodes = tocCatalogDraft(pages);
  if (tocNodes.length >= 3) return tocNodes;
  const nodes = [];
  const seen = new Set();
  const patterns = [
    { regex: /^第[一二三四五六七八九十百零〇0-9]+[编篇章]\s*\S+/, level: 1 },
    { regex: /^第[一二三四五六七八九十百零〇0-9]+节\s*\S+/, level: 2 },
    { regex: /^\d+(?:\.\d+){0,3}\s+\S+/, level: 2 },
    { regex: /^[一二三四五六七八九十]+、\s*\S+/, level: 2 },
  ];
  pages.slice(0, 120).forEach((page, pageIndex) => {
    String(page || "").split("\n").map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean).forEach((line) => {
      if (line.length < 3 || line.length > 90) return;
      const pattern = patterns.find((item) => item.regex.test(line));
      if (!pattern) return;
      const title = line.replace(/\s+\d+$/, "").trim();
      const key = title.replace(/\s/g, "");
      if (seen.has(key)) return;
      seen.add(key);
      nodes.push({
        level: pattern.level,
        title,
        startPage: pageIndex + 1,
        endPage: pageIndex + 1,
        evidence: line,
        knowledgePoints: pattern.level > 1 ? [title.replace(/^第.+?节\s*|^\d+(?:\.\d+)*\s+|^[一二三四五六七八九十]+、\s*/, "")] : [],
      });
    });
  });
  return nodes.slice(0, 400);
}

function tocCatalogDraft(pages) {
  const tocStart = findTocStart(pages);
  if (tocStart < 0) return [];
  const entries = [];
  let fragments = [];
  let blankPages = 0;
  for (let pageIndex = tocStart; pageIndex < Math.min(pages.length, tocStart + 18); pageIndex += 1) {
    const lines = String(pages[pageIndex] || "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
      blankPages += 1;
      if (blankPages >= 2 && entries.length >= 3) break;
      continue;
    }
    blankPages = 0;
    const compactPage = lines.join("").replace(/\s/g, "");
    if (pageIndex > tocStart && /\[目的要求\]|［目的要求］|理解现代汉语/.test(compactPage) && entries.length >= 3) break;
    lines.forEach((rawLine) => {
      const line = rawLine.replace(/[.．…·]{2,}/g, "").trim();
      if (!line || /^(目|录|目录|I{1,4}|[—-]+)$/.test(line)) return;
      const trailingPage = line.match(/^(.*?)(\d{1,3})$/);
      if (trailingPage && trailingPage[1] && /[\u4e00-\u9fffA-Za-z]/.test(trailingPage[1])) {
        fragments.push(trailingPage[1]);
        commit(Number(trailingPage[2]), pageIndex);
        return;
      }
      if (/^\d{1,3}$/.test(line)) {
        commit(Number(line), pageIndex);
        return;
      }
      fragments.push(line);
    });
  }
  function commit(printedPage, pdfPageIndex) {
    if (!fragments.length) return;
    let title = fragments.join("").replace(/\s+/g, "").replace(/^[*#]+|[*#]+$/g, "").trim();
    fragments = [];
    title = title.replace(/^目录/, "");
    if (title.length < 2 || title.length > 100 || !/[\u4e00-\u9fff]/.test(title)) return;
    const level = /^第[一二三四五六七八九十百零〇0-9]+[编篇章]/.test(title) || title === "绪论" ? 1
      : (/^第[一二三四五六七八九十百零〇0-9]+节/.test(title) || /^附录/.test(title) || /^思考和练习/.test(title) ? 2 : 3);
    const knowledgeTitle = title.replace(/^第[一二三四五六七八九十百零〇0-9]+[编篇章节]\s*/, "").replace(/^[一二三四五六七八九十百零〇]+、/, "");
    entries.push({ level, title, startPage: Math.max(1, printedPage), endPage: Math.max(1, printedPage), evidence: `PDF 第 ${pdfPageIndex + 1} 页目录：${title} ${printedPage}`, knowledgePoints: level >= 2 && knowledgeTitle ? [knowledgeTitle] : [] });
  }
  const deduplicated = [];
  const seen = new Set();
  entries.forEach((entry) => {
    const key = `${entry.title}:${entry.startPage}`;
    if (!seen.has(key)) { seen.add(key); deduplicated.push(entry); }
  });
  return deduplicated.slice(0, 500).map((entry, index, all) => {
    const next = all.slice(index + 1).find((candidate) => candidate.level <= entry.level && candidate.startPage >= entry.startPage);
    const boundaryOffset = entry.level <= 2 ? 1 : 0;
    return { ...entry, endPage: next ? Math.max(entry.startPage, next.startPage - boundaryOffset) : entry.startPage };
  });
}

module.exports = {
  catalogPagesForModel,
  extractPdf,
  loadPdfPagePreview,
  loadPdfPagePreviewFromPath,
  loadPdfFile,
  localCatalogDraft,
  pagesForModel,
  renderPdfPageRangeForOcr,
  renderPdfPagesForOcr,
  requiresPdfOcr,
  savePdfFile,
  tocCatalogDraft,
  validatePdfBuffer,
};
