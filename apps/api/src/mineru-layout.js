const path = require("node:path");

const SUPPORTED_BACKENDS = new Set(["pipeline", "vlm", "hybrid", "office"]);
const META_TEXT_PATTERNS = [
  /the ocr result should be empty/i,
  /the ground truth image displays/i,
  /according to rule \d+/i,
  /ocr has hallucinated text/i,
  /no text or placeholder characters should be output/i,
];
const VISUAL_TYPES = new Set(["image", "chart"]);

function cleanText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower[0] !== "#") return named[lower] ?? match;
    const hexadecimal = lower.startsWith("#x");
    const codePoint = Number.parseInt(lower.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function htmlFragmentText(value) {
  return cleanText(decodeHtmlEntities(String(value || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")))
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, " / ")
    .trim();
}

function tableHtmlToStructure(value) {
  const html = String(value || "");
  const rawRows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html))) {
    const cells = [];
    const cellPattern = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      const attributes = cellMatch[2] || "";
      cells.push({
        text: htmlFragmentText(cellMatch[3]),
        rowspan: Math.max(1, Number(attributes.match(/\browspan\s*=\s*["']?(\d+)/i)?.[1]) || 1),
        colspan: Math.max(1, Number(attributes.match(/\bcolspan\s*=\s*["']?(\d+)/i)?.[1]) || 1),
      });
    }
    if (cells.length) rawRows.push(cells);
  }
  return rawRows;
}

function tableStructureToRows(value) {
  const rawRows = Array.isArray(value) ? value : [];
  const activeSpans = [];
  const rows = rawRows.map((cells) => {
    const row = [];
    activeSpans.forEach((span, column) => {
      if (!span || span.remaining <= 0) return;
      row[column] = span.text;
      span.remaining -= 1;
      if (span.remaining <= 0) activeSpans[column] = null;
    });
    let column = 0;
    cells.forEach((cell) => {
      while (row[column] !== undefined) column += 1;
      for (let offset = 0; offset < cell.colspan; offset += 1) {
        const target = column + offset;
        row[target] = cell.text;
        if (cell.rowspan > 1) activeSpans[target] = { text: cell.text, remaining: cell.rowspan - 1 };
      }
      column += cell.colspan;
    });
    return row;
  });
  const width = Math.max(0, ...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, index) => String(row[index] || "")));
}

function tableHtmlToRows(value) {
  return tableStructureToRows(tableHtmlToStructure(value));
}

function tableHtmlToText(value) {
  const rows = tableHtmlToRows(value);
  if (!rows.length) return htmlFragmentText(value);
  return rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
}

function validBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bbox = value.map(Number);
  if (!bbox.every(Number.isFinite) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return null;
  return bbox.map((number) => Math.round(number * 100) / 100);
}

function spanText(span) {
  if (!span || typeof span !== "object") return "";
  if (span.html) return tableHtmlToText(span.html);
  return cleanText(span.content ?? span.text ?? span.latex ?? "");
}

function linesText(lines) {
  return cleanText((Array.isArray(lines) ? lines : []).map((line) => (
    (Array.isArray(line && line.spans) ? line.spans : []).map(spanText).filter(Boolean).join("")
  )).filter(Boolean).join("\n"));
}

function childBlockText(block, parentType) {
  const type = String(block && block.type || "").toLowerCase();
  if (VISUAL_TYPES.has(parentType) && /_(?:body)$/.test(type)) return "";
  return linesText(block && block.lines);
}

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  const type = String(block.type || "text").toLowerCase();
  const direct = linesText(block.lines);
  const nested = (Array.isArray(block.blocks) ? block.blocks : [])
    .map((child) => childBlockText(child, type))
    .filter(Boolean)
    .join("\n");
  return cleanText([direct, nested].filter(Boolean).join("\n"));
}

function imagePaths(block) {
  const values = [];
  const visit = (item) => {
    (Array.isArray(item && item.lines) ? item.lines : []).forEach((line) => {
      (Array.isArray(line && line.spans) ? line.spans : []).forEach((span) => {
        const imagePath = String(span && (span.image_path || span.img_path) || "").trim();
        if (imagePath) values.push(`images/${path.basename(imagePath)}`);
      });
    });
    (Array.isArray(item && item.blocks) ? item.blocks : []).forEach(visit);
  };
  visit(block);
  return [...new Set(values)];
}

function tableHtml(block) {
  let value = "";
  const visit = (item) => {
    if (value) return;
    (Array.isArray(item && item.lines) ? item.lines : []).forEach((line) => {
      (Array.isArray(line && line.spans) ? line.spans : []).forEach((span) => {
        if (!value && /<table\b/i.test(String(span && span.html || ""))) value = String(span.html);
      });
    });
    (Array.isArray(item && item.blocks) ? item.blocks : []).forEach(visit);
  };
  visit(block);
  return value;
}

function tableAuxiliaryText(block, sourceType) {
  const matched = (Array.isArray(block && block.blocks) ? block.blocks : [])
    .find((child) => String(child && child.type || "").toLowerCase() === sourceType);
  return matched ? linesText(matched.lines) : "";
}

function isModelMetaText(value) {
  const text = cleanText(value);
  return Boolean(text) && META_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizedBlockType(value) {
  const type = String(value || "text").toLowerCase();
  if (type === "title") return "title";
  if (type === "table") return "table";
  if (type === "image") return "image";
  if (type === "chart") return "chart";
  if (type.includes("equation")) return "equation";
  return "paragraph";
}

function parsePrintedPage(page) {
  const values = (Array.isArray(page && page.discarded_blocks) ? page.discarded_blocks : [])
    .filter((block) => String(block && block.type || "").toLowerCase() === "page_number")
    .map(blockText)
    .map((text) => text.replace(/[—–-]/g, "").trim())
    .map((text) => text.match(/^(\d{1,4})$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((number) => number > 0);
  return values[0] || 0;
}

function parsePageBlock(block, pdfPage, blockIndex) {
  const sourceType = String(block && block.type || "text").toLowerCase();
  const type = normalizedBlockType(sourceType);
  let text = blockText(block);
  const warnings = [];
  if (isModelMetaText(text)) {
    text = "";
    warnings.push("mineru_model_meta_removed");
  }
  const paths = imagePaths(block);
  const sourceTableHtml = type === "table" ? tableHtml(block) : "";
  const sourceTableStructure = sourceTableHtml ? tableHtmlToStructure(sourceTableHtml) : [];
  const sourceTableRows = sourceTableHtml ? tableHtmlToRows(sourceTableHtml) : [];
  if (type === "table" && sourceTableRows.length) warnings.push("table_structure_review");
  if ((type === "image" || type === "chart") && !text) {
    text = type === "chart" ? "【图表，待人工核对】" : "【插图，待人工核对】";
    warnings.push("visual_without_caption");
  }
  return {
    id: `mineru-${pdfPage}-${blockIndex + 1}`,
    type,
    sourceType,
    sourceLevel: type === "title" ? Math.max(0, Number(block && block.level) || 0) : 0,
    text,
    bbox: validBbox(block && block.bbox),
    imagePaths: paths,
    tableCaption: type === "table" ? tableAuxiliaryText(block, "table_caption") : "",
    tableFootnote: type === "table" ? tableAuxiliaryText(block, "table_footnote") : "",
    tableStructure: sourceTableStructure,
    tableRows: sourceTableRows,
    warnings,
  };
}

function parseMineruLayout(input, options = {}) {
  const raw = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  let document = raw;
  if (typeof raw === "string") {
    try { document = JSON.parse(raw.replace(/^\uFEFF/, "")); }
    catch { throw new Error("mineru_layout_invalid_json"); }
  }
  if (!document || typeof document !== "object" || !Array.isArray(document.pdf_info)) {
    throw new Error("mineru_layout_invalid");
  }
  if (!document.pdf_info.length) throw new Error("mineru_layout_empty");
  const maximumPages = Math.min(5000, Math.max(1, Number(options.maximumPages) || 2000));
  if (document.pdf_info.length > maximumPages) throw new Error("mineru_layout_too_many_pages");

  const rawPdfPages = document.pdf_info.map((page, pageIndex) => {
    const pageIndexValue = Number(page && page.page_idx);
    return Number.isInteger(pageIndexValue) && pageIndexValue >= 0 ? pageIndexValue + 1 : pageIndex + 1;
  });
  const rawPageStart = Math.min(...rawPdfPages);
  const rawPageEnd = Math.max(...rawPdfPages);
  const hasStartPdfPage = options.startPdfPage !== undefined && options.startPdfPage !== null && options.startPdfPage !== "";
  const startPdfPage = hasStartPdfPage ? Number(options.startPdfPage) : rawPageStart;
  if (!Number.isInteger(startPdfPage) || startPdfPage < 1) throw new Error("mineru_start_page_invalid");
  const pageOffset = startPdfPage - rawPageStart;
  const mappedPdfPages = rawPdfPages.map((pdfPage) => pdfPage + pageOffset);
  if (mappedPdfPages.some((pdfPage) => !Number.isInteger(pdfPage) || pdfPage < 1)) {
    throw new Error("mineru_mapped_range_invalid");
  }
  if (new Set(mappedPdfPages).size !== mappedPdfPages.length) throw new Error("mineru_duplicate_pages");

  const quality = {
    removedMetaBlocks: 0,
    reviewBlocks: 0,
    titleBlocks: 0,
    tableBlocks: 0,
    imageBlocks: 0,
    equationBlocks: 0,
    discardedBlocks: 0,
  };
  let totalBlocks = 0;
  const pages = document.pdf_info.map((page, pageIndex) => {
    const pdfPage = mappedPdfPages[pageIndex];
    const sourceBlocks = (Array.isArray(page && page.para_blocks) ? page.para_blocks : [])
      .map((block, blockIndex) => parsePageBlock(block, pdfPage, blockIndex));
    totalBlocks += sourceBlocks.length;
    quality.discardedBlocks += Array.isArray(page && page.discarded_blocks) ? page.discarded_blocks.length : 0;
    sourceBlocks.forEach((block) => {
      if (block.warnings.includes("mineru_model_meta_removed")) quality.removedMetaBlocks += 1;
      if (block.warnings.some((warning) => warning !== "mineru_model_meta_removed")) quality.reviewBlocks += 1;
      if (block.type === "title") quality.titleBlocks += 1;
      if (block.type === "table") quality.tableBlocks += 1;
      if (block.type === "image" || block.type === "chart") quality.imageBlocks += 1;
      if (block.type === "equation") quality.equationBlocks += 1;
    });
    const visibleBlocks = sourceBlocks.filter((block) => block.text);
    const pageWarnings = [...new Set(sourceBlocks.flatMap((block) => block.warnings))];
    return {
      pdfPage,
      printedPage: parsePrintedPage(page),
      text: cleanText(visibleBlocks.map((block) => block.text).join("\n\n")),
      confidence: pageWarnings.length ? 0.86 : 0.99,
      pageSize: Array.isArray(page && page.page_size) ? page.page_size.map(Number).slice(0, 2) : [],
      sourceBlocks,
      sourceProvider: "mineru",
      sourceWarnings: pageWarnings,
    };
  });
  if (totalBlocks > 200000) throw new Error("mineru_layout_too_many_blocks");
  if (!pages.some((page) => page.text)) throw new Error("mineru_layout_empty");

  const backend = String(document._backend || "").toLowerCase();
  return {
    pages,
    metadata: {
      provider: "mineru",
      version: cleanText(document._version_name),
      backend: SUPPORTED_BACKENDS.has(backend) ? backend : backend || "unknown",
      effort: cleanText(document._effort),
      ocrEnabled: document._ocr_enable === true,
      pageCount: pages.length,
      blockCount: totalBlocks,
      rawPageStart,
      rawPageEnd,
      mappedPageStart: Math.min(...mappedPdfPages),
      mappedPageEnd: Math.max(...mappedPdfPages),
      pageOffset,
    },
    quality,
  };
}

module.exports = {
  cleanText,
  isModelMetaText,
  parseMineruLayout,
  tableHtmlToText,
  tableHtmlToRows,
  tableHtmlToStructure,
  tableStructureToRows,
};
