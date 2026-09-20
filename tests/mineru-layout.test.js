const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");
const { buildKnowledgeChunks, createMemoryTextbookKnowledgeStore } = require("../apps/api/src/textbook-knowledge-store");
const {
  parseMineruLayout,
  tableHtmlToRows,
  tableHtmlToStructure,
} = require("../apps/api/src/mineru-layout");

function span(content, extra = {}) {
  return { content, ...extra };
}

function block(type, content, bbox = [10, 20, 300, 80], extra = {}) {
  return {
    type,
    bbox,
    lines: [{ spans: [span(content)] }],
    ...extra,
  };
}

function page(pageIndex, blocks, printedPage = pageIndex + 1) {
  return {
    page_idx: pageIndex,
    page_size: [600, 800],
    para_blocks: blocks,
    discarded_blocks: [block("page_number", String(printedPage))],
  };
}

function layout(pages) {
  return {
    pdf_info: pages,
    _backend: "hybrid",
    _effort: "medium",
    _ocr_enable: true,
    _version_name: "3.4.4",
  };
}

test("MinerU layout keeps structure while cleaning model commentary and page furniture", () => {
  const document = layout([
    page(0, [
      block("title", "第一节 语音概说", [20, 30, 420, 72], { level: 2 }),
      block("text", "语音是语言的物质外壳。", [20, 90, 520, 140]),
      block("text", "The OCR result should be empty according to Rule 3.", [20, 150, 520, 180]),
      {
        type: "table",
        bbox: [20, 200, 560, 320],
        lines: [{ spans: [{ html: "<table><tr><th>类别</th><th>示例</th></tr><tr><td>声母</td><td>b</td></tr></table>" }] }],
      },
      { type: "image", bbox: [40, 350, 500, 650], lines: [{ spans: [{ image_path: "images/figure-1.jpg" }] }] },
    ], 12),
  ]);

  const parsed = parseMineruLayout(Buffer.from(JSON.stringify(document)));
  assert.equal(parsed.metadata.pageCount, 1);
  assert.equal(parsed.metadata.blockCount, 5);
  assert.equal(parsed.pages[0].printedPage, 12);
  assert.deepEqual(parsed.pages[0].pageSize, [600, 800]);
  assert.doesNotMatch(parsed.pages[0].text, /OCR result should be empty/i);
  assert.match(parsed.pages[0].text, /\| 类别 \| 示例 \|\n\| 声母 \| b \|/);
  assert.deepEqual(parsed.pages[0].sourceBlocks[0].bbox, [20, 30, 420, 72]);
  assert.equal(parsed.pages[0].sourceBlocks[0].sourceLevel, 2);
  assert.equal(parsed.quality.removedMetaBlocks, 1);
  assert.equal(parsed.quality.reviewBlocks, 2);
  assert.equal(parsed.quality.discardedBlocks, 1);
  assert.equal(parsed.pages[0].sourceBlocks[4].text, "【插图，待人工核对】");
  assert.deepEqual(parsed.pages[0].sourceBlocks[4].imagePaths, ["images/figure-1.jpg"]);
  assert.equal(parsed.pages[0].sourceBlocks[3].warnings.includes("table_structure_review"), true);
  assert.deepEqual(parsed.pages[0].sourceBlocks[3].tableRows, [["类别", "示例"], ["声母", "b"]]);
});

test("MinerU partial layout maps its local pages onto an explicit PDF range", () => {
  const parsed = parseMineruLayout(layout([
    page(0, [block("text", "分片第一页正文")]),
    page(98, [block("text", "分片最后一页正文")]),
  ]), { startPdfPage: 201 });
  assert.equal(parsed.pages[0].pdfPage, 201);
  assert.equal(parsed.pages[1].pdfPage, 299);
  assert.equal(parsed.pages[0].sourceBlocks[0].id, "mineru-201-1");
  assert.equal(parsed.pages[1].sourceBlocks[0].id, "mineru-299-1");
  assert.equal(parsed.metadata.rawPageStart, 1);
  assert.equal(parsed.metadata.rawPageEnd, 99);
  assert.equal(parsed.metadata.mappedPageStart, 201);
  assert.equal(parsed.metadata.mappedPageEnd, 299);
  assert.equal(parsed.metadata.pageOffset, 200);
});

test("MinerU table rowspans and colspans expand into an explicit grid", () => {
  const html = '<table><tr><td rowspan="2">方言</td><td colspan="2">声母</td></tr><tr><td>浊音</td><td>清音</td></tr><tr><td>吴方言</td><td>有</td><td>有</td></tr></table>';
  const structure = tableHtmlToStructure(html);
  const rows = tableHtmlToRows(html);
  assert.deepEqual(structure, [
    [{ text: "方言", rowspan: 2, colspan: 1 }, { text: "声母", rowspan: 1, colspan: 2 }],
    [{ text: "浊音", rowspan: 1, colspan: 1 }, { text: "清音", rowspan: 1, colspan: 1 }],
    [{ text: "吴方言", rowspan: 1, colspan: 1 }, { text: "有", rowspan: 1, colspan: 1 }, { text: "有", rowspan: 1, colspan: 1 }],
  ]);
  assert.deepEqual(rows, [
    ["方言", "声母", "声母"],
    ["方言", "浊音", "清音"],
    ["吴方言", "有", "有"],
  ]);
});

test("MinerU tables keep row boundaries and stay outside retrieval until reviewed", () => {
  const parsed = parseMineruLayout(layout([
    page(0, [{
      type: "table",
      bbox: [20, 30, 560, 500],
      blocks: [
        block("table_caption", "方言特点表"),
        {
          type: "table_body",
          lines: [{ spans: [{ html: "<table><tr><td>方言</td><td>声调</td></tr><tr><td>粤方言</td><td>九个</td></tr></table>" }] }],
        },
        block("table_footnote", "说明：音标已省略方括号。"),
      ],
    }]),
  ]));
  const store = createMemoryTextbookKnowledgeStore();
  store.importStructuredPages("book-table", parsed.pages, {
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "table", level: 1, title: "方言特点表", startPage: 1, endPage: 1 }],
    totalPages: 1,
  });
  const chunk = store.get("book-table", { includeContent: true }).chunks[0];
  assert.match(chunk.text, /\| 方言 \| 声调 \|\n\| 粤方言 \| 九个 \|/);
  assert.equal(chunk.layoutKind, "table");
  assert.equal(chunk.retrievalEnabled, false);
  assert.equal(chunk.ocrReviewRequired, true);
  assert.equal(chunk.sourceTableCaption, "方言特点表");
  assert.equal(chunk.sourceTableFootnote, "说明：音标已省略方括号。");
  assert.deepEqual(chunk.sourceTableStructure, [
    [{ text: "方言", rowspan: 1, colspan: 1 }, { text: "声调", rowspan: 1, colspan: 1 }],
    [{ text: "粤方言", rowspan: 1, colspan: 1 }, { text: "九个", rowspan: 1, colspan: 1 }],
  ]);
  assert.deepEqual(chunk.sourceTableRows, [["方言", "声调"], ["粤方言", "九个"]]);

  const updated = store.updateChunk("book-table", chunk.id, {
    text: "修订后方言表\n| 方言 | 声调 |\n| 粤方言 | 9 |\n修订后注释",
    tableCaption: "修订后方言表",
    tableFootnote: "修订后注释",
    tableStructure: [
      [{ text: "方言", rowspan: 2, colspan: 1 }, { text: "声调", rowspan: 1, colspan: 1 }],
      [{ text: "9", rowspan: 1, colspan: 1 }],
    ],
    tableRows: [["方言", "声调"], ["方言", "9"]],
  });
  assert.equal(updated.sourceTableCaption, "修订后方言表");
  assert.equal(updated.sourceTableFootnote, "修订后注释");
  assert.equal(updated.sourceTableStructure[0][0].rowspan, 2);
  assert.equal(updated.retrievalEnabled, true);
  assert.equal(updated.ocrReviewRequired, false);
  assert.deepEqual(updated.ocrWarnings, []);
  assert.equal(store.search("book-table", "修订后注释").length, 1);
});

test("a MinerU table warning stays on the table and does not leak into following text", () => {
  const parsed = parseMineruLayout(layout([
    page(0, [
      {
        type: "table",
        bbox: [20, 30, 560, 280],
        lines: [{ spans: [{ html: "<table><tr><td>类别</td><td>示例</td></tr></table>" }] }],
      },
      block("title", "一、正文特点", [20, 300, 300, 330], { level: 3 }),
      block("text", "普通正文只应定位到自己的文字区域。", [20, 350, 520, 390]),
    ]),
  ]));
  const store = createMemoryTextbookKnowledgeStore();
  store.importStructuredPages("book-local-warning", parsed.pages, {
    bookTitle: "测试教材",
    catalogNodes: [{ id: "chapter", level: 2, title: "第一节测试", startPage: 1, endPage: 1 }],
    totalPages: 1,
  });
  const chunks = store.get("book-local-warning", { includeContent: true }).chunks;
  const tableChunk = chunks.find((chunk) => chunk.sourceBlockTypes.includes("table"));
  const textChunk = chunks.find((chunk) => /普通正文/.test(chunk.text));
  assert.ok(tableChunk);
  assert.ok(textChunk);
  assert.equal(tableChunk.layoutKind, "table");
  assert.equal(tableChunk.ocrWarnings.includes("table_structure_review"), true);
  assert.equal(textChunk.layoutKind, "text");
  assert.equal(textChunk.ocrWarnings.includes("table_structure_review"), false);
  assert.deepEqual(textChunk.sourceBbox, [20, 350, 520, 390]);
  assert.equal(textChunk.retrievalEnabled, true);
});

test("structured re-import replaces matching pages, retains later pages, and stays idempotent", () => {
  const store = createMemoryTextbookKnowledgeStore();
  const nodes = [{ id: "chapter-1", level: 1, title: "第一章 绪论", startPage: 1, endPage: 299 }];
  store.importStructuredPages("book-a", [
    { pdfPage: 1, printedPage: 1, text: "旧第一页", sourceProvider: "ocr" },
    { pdfPage: 201, printedPage: 201, text: "保留的第二百零一页", sourceProvider: "ocr" },
  ], { bookTitle: "现代汉语", catalogNodes: nodes, totalPages: 299 });

  const incoming = [
    { pdfPage: 1, printedPage: 1, text: "新的第一页", sourceProvider: "mineru", sourceBlocks: [] },
    { pdfPage: 2, printedPage: 2, text: "", sourceProvider: "mineru", sourceBlocks: [] },
  ];
  const first = store.importStructuredPages("book-a", incoming, {
    bookTitle: "现代汉语", catalogNodes: nodes, totalPages: 299, preserveMissingPages: true,
  });
  const firstContent = store.get("book-a", { includeContent: true });
  assert.equal(firstContent.pages.find((item) => item.pdfPage === 1).text, "新的第一页");
  assert.equal(firstContent.pages.find((item) => item.pdfPage === 2).text, "");
  assert.equal(firstContent.pages.find((item) => item.pdfPage === 201).text, "保留的第二百零一页");
  assert.doesNotMatch(firstContent.chunks.map((item) => item.text).join("\n"), /旧第一页/);

  const second = store.importStructuredPages("book-a", incoming, {
    bookTitle: "现代汉语", catalogNodes: nodes, totalPages: 299, preserveMissingPages: true,
  });
  assert.equal(second.chunkCount, first.chunkCount);
  assert.equal(store.get("book-a", { includeContent: true }).pages.length, firstContent.pages.length);
});

test("structured import drops pages beyond the current replacement PDF", () => {
  const store = createMemoryTextbookKnowledgeStore();
  const nodes = [{ id: "chapter", level: 1, title: "第一章", startPage: 1, endPage: 460 }];
  store.importStructuredPages("edition-book", [
    { pdfPage: 1, printedPage: 1, text: "新版正文", sourceProvider: "mineru" },
    { pdfPage: 588, printedPage: 570, text: "第一版残留正文", sourceProvider: "mineru" },
  ], { bookTitle: "教材第一版", catalogNodes: nodes, totalPages: 588 });

  const result = store.importStructuredPages("edition-book", [
    { pdfPage: 460, printedPage: 440, text: "第二版末页", sourceProvider: "mineru" },
  ], { bookTitle: "教材第二版", catalogNodes: nodes, totalPages: 460, preserveMissingPages: true });
  const content = store.get("edition-book", { includeContent: true });
  assert.equal(result.progress.totalPages, 460);
  assert.equal(content.pages.some((page) => page.pdfPage === 588), false);
  assert.equal(content.pages.some((page) => /第一版残留/.test(page.text)), false);
});

test("reindex reconciles PDF length and current catalog version", () => {
  const store = createMemoryTextbookKnowledgeStore();
  store.importStructuredPages("reindex-book", [
    { pdfPage: 1, printedPage: 1, text: "新版正文", sourceProvider: "mineru" },
    { pdfPage: 588, printedPage: 570, text: "旧版尾页", sourceProvider: "mineru" },
  ], { bookTitle: "教材", catalogNodes: [], totalPages: 588, source: { mode: "mineru_layout", catalogVersion: 1 } });

  const result = store.reindex("reindex-book", {
    bookTitle: "教材第二版",
    catalogNodes: [{ id: "new-chapter", level: 1, title: "新版目录", startPage: 1, endPage: 460 }],
    catalogVersion: 4,
    maxPdfPage: 460,
  });
  const content = store.get("reindex-book", { includeContent: true });
  assert.equal(result.progress.totalPages, 460);
  assert.equal(result.source.catalogVersion, 4);
  assert.equal(content.pages.some((page) => page.pdfPage === 588), false);
  assert.equal(content.chunks.every((chunk) => chunk.catalogPath.includes("新版目录")), true);
});

test("visual placeholders stay outside retrieval but cleaned pages remain searchable", () => {
  const parsed = parseMineruLayout(layout([
    page(0, [
      block("text", "现代汉语以北京语音为标准音。"),
      block("text", "The Ground Truth image displays no readable text."),
    ]),
    page(1, [{ type: "image", bbox: [20, 30, 500, 700], lines: [{ spans: [{ image_path: "figure.jpg" }] }] }]),
  ]));
  const store = createMemoryTextbookKnowledgeStore();
  store.importStructuredPages("book-a", parsed.pages, {
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "chapter", level: 1, title: "绪论", startPage: 1, endPage: 2 }],
    totalPages: 2,
  });
  assert.equal(store.search("book-a", "北京语音").length, 1);
  assert.equal(store.search("book-a", "插图").length, 0);
});

test("cross-page chunks retain their range while bbox preview uses the source block page", () => {
  const built = buildKnowledgeChunks({
    bookId: "book-a",
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "dialect", level: 1, title: "现代汉语方言", startPage: 4, endPage: 5 }],
    pages: [
      {
        pdfPage: 28,
        printedPage: 4,
        text: "湘方言分布在湖南省大部分地区，以长沙话为代表。老湘语受北方方言影响较小。湘",
        sourceProvider: "mineru",
        pageSize: [481, 643],
        sourceBlocks: [{ id: "mineru-28-1", type: "paragraph", text: "湘方言分布在湖南省大部分地区，以长沙话为代表。老湘语受北方方言影响较小。湘", bbox: [57, 553, 418, 597] }],
      },
      {
        pdfPage: 29,
        printedPage: 5,
        text: "方言使用人口约占汉族总人口的3.2%。",
        sourceProvider: "mineru",
        pageSize: [481, 643],
        sourceBlocks: [{ id: "mineru-29-1", type: "paragraph", text: "方言使用人口约占汉族总人口的3.2%。", bbox: [65, 52, 247, 64] }],
      },
    ],
  });
  const continuation = built.chunks.find((chunk) => /湘方言使用人口/.test(chunk.text));
  assert.ok(continuation);
  assert.equal(continuation.pdfPageStart, 28);
  assert.equal(continuation.pdfPageEnd, 29);
  assert.equal(continuation.sourcePdfPage, 29);
  assert.equal(continuation.sourcePrintedPage, 5);
  assert.deepEqual(continuation.sourceBbox, [65, 52, 247, 64]);
});

test("admin MinerU endpoint imports JSON through the confirmed textbook catalog", async (context) => {
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const bookId = "modern-chinese-7-1";
  textbookCatalogStore.savePdf(bookId, { fileName: "现代汉语上册.pdf", size: 1024, pageCount: 299, textChars: 0 });
  textbookCatalogStore.setDraft(bookId, [
    { level: 1, title: "第一章 绪论", startPage: 1, endPage: 299 },
  ], { source: "test" });
  textbookCatalogStore.confirm(bookId);
  textbookKnowledgeStore.importStructuredPages(bookId, [
    { pdfPage: 1, printedPage: 1, text: "应当保留的第一页", sourceProvider: "ocr" },
    { pdfPage: 201, printedPage: 201, text: "即将被替换的旧正文", sourceProvider: "ocr" },
  ], {
    bookTitle: "现代汉语",
    catalogNodes: textbookCatalogStore.get(bookId).confirmed.nodes,
    totalPages: 299,
  });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    textbookCatalogStore,
    textbookKnowledgeStore,
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/admin/textbooks/${bookId}/knowledge/import-mineru?fileName=layout.json&startPdfPage=201&confirmMappedRange=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(layout([page(0, [block("text", "现代汉语是现代汉民族共同语。")])])),
  });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.success, true);
  assert.equal(payload.import.metadata.provider, "mineru");
  assert.equal(payload.import.metadata.mappedPageStart, 201);
  assert.equal(payload.import.metadata.mappedPageEnd, 201);
  assert.equal(payload.import.replacedPageCount, 1);
  assert.equal(payload.import.backup.created, true);
  assert.equal(payload.knowledge.source.mode, "mineru_layout");
  assert.equal(textbookKnowledgeStore.search(bookId, "共同语").length, 1);
  assert.equal(textbookKnowledgeStore.search(bookId, "应当保留").length, 1);
  assert.equal(textbookKnowledgeStore.search(bookId, "即将被替换").length, 0);
  const backups = textbookKnowledgeStore.listBackups(bookId);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].record.pages.some((item) => item.pdfPage === 201 && /旧正文/.test(item.text)), true);
  assert.equal(operationLogStore.list({ category: "catalog" }).items[0].action, "textbook_knowledge.import_mineru");

  const replacement = await fetch(`http://127.0.0.1:${port}/api/admin/textbooks/${bookId}/knowledge/import-mineru?fileName=new-edition.json&startPdfPage=1&confirmMappedRange=1&importMode=replace_book`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(layout([page(0, [block("text", "新版教材第一页。")])])),
  });
  const replacementPayload = await replacement.json();
  assert.equal(replacement.status, 201);
  assert.equal(replacementPayload.import.importMode, "replace_book");
  assert.equal(replacementPayload.import.preserveMissingPages, false);
  assert.equal(textbookKnowledgeStore.search(bookId, "应当保留").length, 0);
  assert.equal(textbookKnowledgeStore.get(bookId, { includeContent: true }).pages.length, 1);

  const outOfRange = await fetch(`http://127.0.0.1:${port}/api/admin/textbooks/${bookId}/knowledge/import-mineru?fileName=layout.json&startPdfPage=300&confirmMappedRange=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(layout([page(0, [block("text", "不能导入的正文")])])),
  });
  assert.equal(outOfRange.status, 422);
  assert.equal((await outOfRange.json()).error, "mineru_mapped_range_exceeds_pdf");
  assert.equal(textbookKnowledgeStore.listBackups(bookId).length, 2);
});
