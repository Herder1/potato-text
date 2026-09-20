const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildKnowledgeChunks,
  catalogNodesWithPaths,
  createFileTextbookKnowledgeStore,
  createMemoryTextbookKnowledgeStore,
  embeddedVisualLayoutKind,
  outlineNodesFromChunks,
  reflowOcrText,
  splitPageText,
} = require("../apps/api/src/textbook-knowledge-store");

test("file knowledge backups persist the complete version before an import", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-knowledge-backup-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFileTextbookKnowledgeStore(path.join(directory, "textbook-knowledge.json"));
  store.importStructuredPages("book-a", [
    { pdfPage: 201, printedPage: 201, text: "导入前正文", sourceProvider: "ocr" },
  ], {
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "chapter", level: 1, title: "第三章", startPage: 201, endPage: 299 }],
    totalPages: 299,
  });
  const backup = store.backup("book-a", { reason: "mineru_import", mappedPageStart: 201, mappedPageEnd: 299 });
  const backupPath = path.join(directory, "textbook-knowledge-backups", "book-a", backup.fileName);
  const saved = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  assert.equal(backup.created, true);
  assert.equal(saved.metadata.mappedPageStart, 201);
  assert.equal(saved.record.pages[0].text, "导入前正文");
  assert.equal(store.listBackups("book-a").length, 1);
});

test("textbook question candidates are reviewed and added to drafts one at a time", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "apps/admin/index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "apps/admin/app.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "apps/api/src/server.js"), "utf8");
  assert.doesNotMatch(html, /knowledge-generate-save|保存为平台题目草稿/);
  assert.match(app, /data-save-knowledge-candidate/);
  assert.match(app, /加入题库草稿/);
  assert.match(app, /已进入平台题库 · 未复核/);
  assert.doesNotMatch(server, /payload\.save === true/);
});

test("catalog parent ranges include all descendant pages", () => {
  const nodes = catalogNodesWithPaths([
    { id: "chapter", level: 1, title: "第三章词汇", startPage: 201, endPage: 201 },
    { id: "section-1", level: 2, title: "第一节词汇概说", startPage: 201, endPage: 204 },
    { id: "section-9", level: 2, title: "第九节词汇规范化", startPage: 254, endPage: 272 },
  ]);
  assert.equal(nodes[0].endPage, 272);
  assert.equal(nodes[1].path, "第三章词汇 > 第一节词汇概说");
});
const {
  formatTextbookEvidence,
  isBibliographicQuestion,
  normalizeBodyOcrPages,
  normalizeGeneratedQuestions,
} = require("../apps/api/src/textbook-rag");

const catalogNodes = [
  { id: "part-2", order: 1, level: 1, title: "第二编 第二个十年", startPage: 169, endPage: 359 },
  { id: "chapter-14", order: 2, level: 2, title: "第十四章 小说（二）", startPage: 261, endPage: 291 },
  { id: "left-wing", order: 3, level: 3, title: "一 “左联”与左翼小说", startPage: 261, endPage: 276 },
  { id: "beijing-school", order: 4, level: 3, title: "二 京派小说", startPage: 276, endPage: 284 },
];

test("scanned textbook pages become catalog-backed searchable chunks", () => {
  const built = buildKnowledgeChunks({
    bookId: "modern-literature-30-years-3",
    bookTitle: "中国现代文学三十年（第三版）",
    catalogNodes,
    pages: [
      { pdfPage: 276, printedPage: 261, text: "萧红小说具有东北地域色彩，并呈现散文化与诗化的叙事特征。", confidence: 0.98 },
      { pdfPage: 277, printedPage: 0, text: "《生死场》表现北方人民对于生的坚强和对于死的挣扎。", confidence: 0.96 },
    ],
  });
  assert.equal(built.pageOffset, 15);
  assert.equal(built.pages[1].printedPage, 262);
  assert.match(built.chunks[0].catalogPath, /第二编 第二个十年 > 第十四章 小说（二） > 一 “左联”与左翼小说/);
  assert.equal(built.chunks[0].printedPageStart, 261);

  const store = createMemoryTextbookKnowledgeStore();
  store.begin("modern-literature-30-years-3", { totalPages: 592, source: { mode: "vision_ocr" } });
  store.appendPages("modern-literature-30-years-3", built.pages, {
    bookTitle: "中国现代文学三十年（第三版）",
    catalogNodes,
    totalPages: 592,
  });
  const results = store.search("modern-literature-30-years-3", "萧红小说的艺术特色", { limit: 3 });
  assert.equal(results.length > 0, true);
  assert.match(results[0].text, /东北地域色彩/);
  assert.equal(results[0].printedPageStart, 261);
});

test("MinerU body titles correct a stale locked page offset and keep the first outline item", () => {
  const nodes = [
    { id: "part", level: 1, title: "第四编 隋唐五代文学", startPage: 3, endPage: 18 },
    { id: "intro", level: 2, title: "绪论", startPage: 3, endPage: 17 },
    { id: "section", level: 3, title: "第一节 隋唐的政权更替与政治分合", startPage: 3, endPage: 5 },
    { id: "section-2", level: 3, title: "第二节 社会流动与地域超越", startPage: 5, endPage: 8 },
  ];
  const built = buildKnowledgeChunks({
    bookId: "ancient-literature-2-2",
    bookTitle: "中国古代文学史（第二版）",
    catalogNodes: nodes,
    pageOffset: 10,
    pageOffsetLocked: true,
    pages: [
      {
        pdfPage: 12,
        printedPage: 2,
        text: "绪论\n\n第一节 隋唐的政权更替与政治分合\n\n一、南北分裂的结束\n\n隋朝完成统一。",
        confidence: 0.99,
        sourceBlocks: [
          { id: "title-1", type: "title", text: "绪论" },
          { id: "title-2", type: "title", text: "第一节 隋唐的政权更替与政治分合" },
          { id: "title-3", type: "title", text: "一、南北分裂的结束" },
          { id: "text-1", type: "paragraph", text: "隋朝完成统一。" },
        ],
      },
      {
        pdfPage: 14,
        printedPage: 4,
        text: "第二节 社会流动与地域超越\n\n一、阶层流动与地域流动\n\n社会流动更加频繁。",
        confidence: 0.99,
        sourceBlocks: [
          { id: "title-4", type: "title", text: "第二节 社会流动与地域超越" },
          { id: "title-5", type: "title", text: "一、阶层流动与地域流动" },
          { id: "text-2", type: "paragraph", text: "社会流动更加频繁。" },
        ],
      },
    ],
  });

  assert.equal(built.pageOffset, 9);
  assert.equal(built.pages[0].printedPage, 3);
  assert.equal(built.chunks[0].bodyHeading, "一、南北分裂的结束");
  assert.match(built.chunks[0].catalogPath, /第一节 隋唐的政权更替与政治分合 > 一、南北分裂的结束/);
});

test("body subheadings become level-four outline nodes and focused chunks", () => {
  const nodes = [
    { id: "part-1", order: 1, level: 1, title: "第一编 第一个十年", startPage: 1, endPage: 100 },
    { id: "chapter-1", order: 2, level: 2, title: "第一章 文学思潮与运动（一）", startPage: 1, endPage: 20 },
    { id: "section-1", order: 3, level: 3, title: "一 文学革命的发生与发展", startPage: 1, endPage: 13 },
    { id: "section-2", order: 4, level: 3, title: "二 外国文艺思潮涌入", startPage: 13, endPage: 20 },
  ];
  const store = createMemoryTextbookKnowledgeStore();
  store.begin("book-a", { totalPages: 30, source: { fingerprint: "a", catalogVersion: 1, mode: "vision_ocr" } });
  store.appendPages("book-a", [
    { pdfPage: 27, printedPage: 12, text: "（二）文学革命的收获与意义\n\n文学革命取得四方面收获。", confidence: 0.99 },
    { pdfPage: 28, printedPage: 13, text: "第四，是创作取得实绩。\n\n二 外国文艺思潮涌入\n\n外国文学运动提供了启示。", confidence: 0.99 },
  ], { bookTitle: "中国现代文学三十年", catalogNodes: nodes, totalPages: 30 });
  store.reindex("book-a", { bookTitle: "中国现代文学三十年", catalogNodes: nodes });

  const outline = store.outline("book-a");
  assert.equal(outline.length, 1);
  assert.equal(outline[0].title, "（二）文学革命的收获与意义");
  assert.equal(outline[0].level, 4);
  assert.equal(outline[0].startPage, 12);
  assert.equal(outline[0].endPage, 13);
  assert.match(outline[0].path, /一 文学革命的发生与发展 > （二）文学革命的收获与意义/);

  const secondSection = store.search("book-a", "外国文学运动", { catalogPathPrefix: "第一编 第一个十年 > 第一章 文学思潮与运动（一） > 二 外国文艺思潮涌入" });
  assert.equal(secondSection.length, 1);
  assert.doesNotMatch(secondSection[0].catalogPath, /文学革命的收获与意义/);

  const appendix = buildKnowledgeChunks({
    bookId: "book-b",
    bookTitle: "测试教材",
    catalogNodes: [{ id: "appendix", level: 2, title: "附录 本章年表", startPage: 1, endPage: 2 }],
    pages: [{ pdfPage: 1, printedPage: 1, text: "（一）国统区和沦陷区\n\n1937年发生若干文学事件。", confidence: 1 }],
  });
  assert.equal(appendix.chunks[0].bodyHeading, "");
});

test("confirmed catalog titles repeated as running heads do not pollute body outlines", () => {
  const nodes = [
    { id: "upper", level: 1, title: "上编 50—70年代的文学", startPage: 5, endPage: 184 },
    { id: "old-topic", level: 3, title: "二 左翼文学界的“选择”", startPage: 10, endPage: 16 },
    { id: "lower", level: 1, title: "下编 80—90年代的文学", startPage: 185, endPage: 358 },
    { id: "chapter-17", level: 2, title: "第十七章 80年代文学概况", startPage: 199, endPage: 213 },
    { id: "topic-17", level: 3, title: "二 “新时期文学”的话语资源", startPage: 204, endPage: 210 },
  ];
  const built = buildKnowledgeChunks({
    bookId: "contemporary-literature-history-3",
    bookTitle: "中国当代文学史（第三版）",
    pageOffset: 13,
    pageOffsetLocked: true,
    catalogNodes: nodes,
    pages: [{
      pdfPage: 218,
      printedPage: 205,
      text: "上编 50—70 年代的文学\n二 左翼文学界的“选择”\n新时期文学吸收了多方面的话语资源。",
      confidence: 1,
      sourceBlocks: [
        { id: "head-1", type: "title", text: "上编 50—70 年代的文学" },
        { id: "head-2", type: "title", text: "二 左翼文学界的“选择”" },
        { id: "body", type: "text", text: "新时期文学吸收了多方面的话语资源。" },
      ],
    }],
  });
  assert.equal(built.chunks.length, 1);
  assert.equal(built.chunks[0].catalogPath, "下编 80—90年代的文学 > 第十七章 80年代文学概况 > 二 “新时期文学”的话语资源");
  assert.equal(built.chunks[0].bodyHeading, "");
  assert.doesNotMatch(built.chunks[0].text, /上编|左翼文学界/);
});

test("enumeration fragments are not promoted to body outline headings", () => {
  const built = buildKnowledgeChunks({
    bookId: "book-c",
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "standardization", level: 3, title: "三、汉字的标准化", startPage: 168, endPage: 168 }],
    pages: [{
      pdfPage: 192,
      printedPage: 168,
      text: "四角号码法按字角确定数码。\n（1）、“2”竖（丨）、“3”点捺。",
      confidence: 1,
    }],
  });
  assert.equal(outlineNodesFromChunks(built.chunks).length, 0);
  assert.match(built.chunks[0].text, /“2”竖/);
});

test("numbered tables embedded in ordinary body text use the original PDF page", () => {
  const built = buildKnowledgeChunks({
    bookId: "book-d",
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "consonants", level: 3, title: "一、辅音的发音", startPage: 29, endPage: 29 }],
    pages: [{
      pdfPage: 53,
      printedPage: 29,
      text: "辅音发音由发音部位和发音方法决定。\n表1-1 普通话辅音总表\n发音方法\n发音部位\nb[p] d[t] g[k]",
      confidence: 1,
    }],
  });
  assert.equal(built.chunks[0].layoutKind, "mixed_table");
  assert.equal(embeddedVisualLayoutKind("正文中只出现普通文字。"), "text");
  assert.equal(embeddedVisualLayoutKind("图1-8 zh、ch、sh发音示意图"), "figure");
  assert.equal(embeddedVisualLayoutKind("字母 名称 声母 韵母 A a ㄅ"), "mixed_table");
});

test("figure OCR pollution is kept for review but excluded from RAG retrieval", () => {
  const built = buildKnowledgeChunks({
    bookId: "figure-book",
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "phonetics", level: 2, title: "第一节语音概说", startPage: 16, endPage: 16 }],
    pages: [{
      pdfPage: 40,
      printedPage: 16,
      text: "1. 音高\n音高取决于发音体振动的快慢。hJWvyA\n图1-2 音高波形示意图",
      confidence: 0.8,
    }],
  });
  assert.equal(built.chunks[0].layoutKind, "figure");
  assert.equal(built.chunks[0].retrievalEnabled, false);
  assert.equal(built.chunks[0].ocrReviewRequired, true);
  assert.match(built.chunks[0].text, /hJWvyA/);

  const store = createMemoryTextbookKnowledgeStore();
  store.begin("figure-book", { totalPages: 1, source: { mode: "vision_ocr" } });
  store.appendPages("figure-book", built.pages, {
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "phonetics", level: 2, title: "第一节语音概说", startPage: 16, endPage: 16 }],
    totalPages: 1,
  });
  assert.equal(store.search("figure-book", "音高振动", { limit: 3 }).length, 0);
});

test("common OCR substitutions in Chinese outline ordinals become real headings", () => {
  const built = buildKnowledgeChunks({
    bookId: "outline-repair",
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "section", level: 2, title: "第一节语音概说", startPage: 15, endPage: 19 }],
    pages: [
      { pdfPage: 39, printedPage: 15, text: "（-）\n语\n音的物理属性\n声波由物体振动产生。", confidence: 0.8 },
      { pdfPage: 41, printedPage: 17, text: "（\n~）\n语音的生理属性\n语音由发音器官发出。", confidence: 0.8 },
      { pdfPage: 43, printedPage: 19, text: "（H）\n语音的社会属性\n社会属性是本质属性。", confidence: 0.8 },
    ],
  });
  assert.deepEqual(outlineNodesFromChunks(built.chunks).map((node) => node.title), [
    "（一）语音的物理属性",
    "（二）语音的生理属性",
    "（三）语音的社会属性",
  ]);
});

test("body outline titles do not swallow a duplicated definition sentence", () => {
  const built = buildKnowledgeChunks({
    bookId: "joined-heading",
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "section", level: 2, title: "第一节语音概说", startPage: 20, endPage: 20 }],
    pages: [{
      pdfPage: 44,
      printedPage: 20,
      text: "（四）音位音位是按语音的社会属性（辨义功能）划分出来的",
      confidence: 0.8,
    }],
  });
  assert.equal(outlineNodesFromChunks(built.chunks)[0].title, "（四）音位");
  assert.match(built.chunks[0].text, /音位是按语音的社会属性/);
});

test("legitimate mixed-case software names do not disable a figure page", () => {
  const built = buildKnowledgeChunks({
    bookId: "software-name",
    bookTitle: "现代汉语",
    catalogNodes: [{ id: "phonetics", level: 2, title: "第一节语音概说", startPage: 17, endPage: 17 }],
    pages: [{
      pdfPage: 41,
      printedPage: 17,
      text: "可用语音分析软件Praat进行观察。\n图1-4 8个标准元音波形图",
      confidence: 0.9,
    }],
  });
  assert.equal(built.chunks[0].layoutKind, "figure");
  assert.equal(built.chunks[0].retrievalEnabled, true);
  assert.match(built.chunks[0].retrievalText, /Praat/);
});

test("OCR layout wraps are reflowed while real paragraphs and sentence boundaries remain", () => {
  const reflowed = reflowOcrText("教育、文\n学乃至风俗等等，从而在社会上形成广泛的文化批评和讨论空气，使思想启蒙的课题具体化，思想自由的原则也在一定程度上得以实现。\n新文化运动是激进的。\n\n第二段保持独立。");
  assert.match(reflowed, /教育、文学乃至风俗等等/);
  assert.doesNotMatch(reflowed, /文\n学/);
  assert.match(reflowed, /得以实现。新文化运动/);
  assert.match(reflowed, /新文化运动是激进的。\n\n第二段/);

  const verticalOcr = reflowOcrText("II\n绪\n论\n第一节\n现代汉\n语概说\n［目的\n要求］\n理解现\n代汉语的含义");
  assert.match(verticalOcr, /II绪论第一节现代汉语概说\n\n［目的要求］ 理解现代汉语的含义/);

  const chunks = splitPageText(`${"第一句说明知识背景。".repeat(50)}第二句给出完整结论。`, 180, 30);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every((chunk) => /[。！？；]$/.test(chunk)), true);
});

test("persisted reading chunks do not repeat overlap text", () => {
  const result = buildKnowledgeChunks({
    bookId: "reading-book",
    bookTitle: "阅读测试",
    pageOffset: 0,
    pageOffsetLocked: true,
    catalogNodes: [{ id: "chapter", level: 1, title: "第一章 测试", startPage: 1, endPage: 1 }],
    pages: [{
      pdfPage: 1,
      printedPage: 1,
      confidence: 1,
      text: Array.from({ length: 90 }, (_, index) => `第${index + 1}句说明一个不同的知识点。`).join(""),
    }],
  });
  assert.equal(result.chunks.length > 1, true);
  for (let index = 1; index < result.chunks.length; index += 1) {
    const lastSentence = result.chunks[index - 1].text.match(/[^。！？；!?]+[。！？；!?]$/)?.[0] || "";
    assert.equal(Boolean(lastSentence) && result.chunks[index].text.startsWith(lastSentence), false);
  }
});

test("a bottom-page footnote does not interrupt a sentence continued on the next page", () => {
  const result = buildKnowledgeChunks({
    bookId: "modern-chinese-footnote",
    bookTitle: "现代汉语",
    pageOffset: 24,
    pageOffsetLocked: true,
    catalogNodes: [{ id: "dialect", level: 1, title: "三、现代汉语方言", startPage: 3, endPage: 6 }],
    pages: [
      {
        pdfPage: 27,
        printedPage: 3,
        confidence: 1,
        text: `${Array.from({ length: 40 }, () => "这是完整正文。\n").join("")}导致汉语多方言的因素很多，既\n有社\n1153\n年\n，金迁\n都燕京\n（今北京）。\n第\n•\n3\n•`,
      },
      { pdfPage: 28, printedPage: 4, confidence: 1, text: "会\n、历史\n、地理方面的因素，如长期的小农经济。" },
    ],
  });
  const body = result.chunks.map((chunk) => chunk.text).join("\n");
  assert.match(body, /既有社会、历史、地理方面的因素/);
  assert.doesNotMatch(body, /1153年|金迁都燕京/);
});

test("fragmented OCR headings use the confirmed catalog and stay out of body text", () => {
  const result = buildKnowledgeChunks({
    bookId: "modern-chinese",
    bookTitle: "现代汉语",
    pageOffset: 24,
    pageOffsetLocked: true,
    catalogNodes: [
      { id: "intro", level: 1, title: "绪论", startPage: 1, endPage: 10 },
      { id: "section", level: 2, title: "第一节现代汉语概说", startPage: 1, endPage: 5 },
      { id: "topic", level: 3, title: "一、什么是现代汉语", startPage: 1, endPage: 2 },
    ],
    pages: [{
      pdfPage: 25,
      printedPage: 1,
      confidence: 0.9,
      text: "II\n绪\n论\n第一节\n现代汉\n语概说\n［目的\n要求］\n理解现\n代汉语的含义。\n一\n、什\n么是现\n代汉语\n汉语是\n汉民族的语言。\n第一节\n现代汉\n语犍说\n-\n1\n•",
    }],
  });
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[0].catalogNodeId, "section");
  assert.match(result.chunks[0].text, /^［目的要求］ 理解现代汉语的含义。$/);
  assert.equal(result.chunks[1].catalogNodeId, "topic");
  assert.equal(result.chunks[1].text, "汉语是汉民族的语言。");
  assert.doesNotMatch(result.chunks.map((chunk) => chunk.text).join(""), /II|第一节|语犍说/);
});

test("cross-page OCR rejoins an unfinished sentence and removes reversed page footers", () => {
  const result = buildKnowledgeChunks({
    bookId: "modern-chinese",
    bookTitle: "现代汉语",
    pageOffset: 24,
    pageOffsetLocked: true,
    catalogNodes: [
      { id: "intro", level: 1, title: "绪论", startPage: 1, endPage: 10 },
      { id: "section", level: 2, title: "第一节现代汉语概说", startPage: 1, endPage: 5 },
      { id: "topic", level: 3, title: "一、什么是现代汉语", startPage: 1, endPage: 2 },
    ],
    pages: [
      { pdfPage: 25, printedPage: 1, confidence: 0.9, text: "一、什么是现代汉语\n这是完整的一句。\n为了克服口语受到\n第一节\n现代汉\n语犍说\n-\n1\n•" },
      { pdfPage: 26, printedPage: 2, confidence: 0.9, text: "时间和空间限制的缺点，古人创造了文字。\n-\n2\n•\n绪论" },
    ],
  });
  const body = result.chunks.map((chunk) => chunk.text).join("\n");
  assert.match(body, /为了克服口语受到时间和空间限制的缺点/);
  assert.doesNotMatch(body, /语犍说|•|\n绪论/);
  assert.equal(result.chunks.some((chunk) => chunk.text.startsWith("时间和空间")), false);
});

test("cross-page repair does not move a complete standalone block to the next page", () => {
  const built = buildKnowledgeChunks({
    bookId: "standalone-block-book",
    bookTitle: "测试教材",
    catalogNodes: [{ id: "section", level: 2, title: "第一节测试", startPage: 1, endPage: 2 }],
    pages: [
      { pdfPage: 10, printedPage: 1, text: "正文已经结束。\n\n独立图注", confidence: 1 },
      { pdfPage: 11, printedPage: 2, text: "下一页正文完整。", confidence: 1 },
    ],
  });
  const firstPageText = built.chunks.filter((chunk) => chunk.pdfPageStart === 10)
    .map((chunk) => chunk.text).join("\n");
  const secondPageText = built.chunks.filter((chunk) => chunk.pdfPageStart === 11)
    .map((chunk) => chunk.text).join("\n");
  assert.match(firstPageText, /独立图注/);
  assert.doesNotMatch(secondPageText, /独立图注/);
});

test("page numbers between a split word and a corrupted running head are removed", () => {
  const result = buildKnowledgeChunks({
    bookId: "modern-chinese",
    bookTitle: "现代汉语",
    pageOffset: 24,
    pageOffsetLocked: true,
    catalogNodes: [
      { id: "intro", level: 1, title: "绪论", startPage: 1, endPage: 10 },
      { id: "dialect", level: 3, title: "三、现代汉语方言", startPage: 3, endPage: 6 },
    ],
    pages: [
      { pdfPage: 28, printedPage: 4, confidence: 0.9, text: "老湘语受北方方言影响较小。\n湘\n•\n4\n•\n绪途" },
      { pdfPage: 29, printedPage: 5, confidence: 0.9, text: "方言使用人口约占汉族总人口的3.2%。" },
    ],
  });
  const body = result.chunks.map((chunk) => chunk.text).join("\n");
  assert.match(body, /湘方言使用人口/);
  assert.doesNotMatch(body, /•4•|绪途/);
});

test("inline printed-page markers and nearby corrupted running heads are removed", () => {
  const result = buildKnowledgeChunks({
    bookId: "modern-chinese-inline-header",
    bookTitle: "现代汉语",
    pageOffset: 24,
    pageOffsetLocked: true,
    catalogNodes: [
      { id: "chapter", level: 1, title: "第三章词汇", startPage: 202, endPage: 260 },
      { id: "section", level: 2, title: "第一节词汇概说", startPage: 202, endPage: 205 },
    ],
    pages: [
      { pdfPage: 226, printedPage: 202, confidence: 1, text: "词缀都是定位语素，•202•第三章词汇如‘老’居词首。" },
      { pdfPage: 227, printedPage: 203, confidence: 1, text: "第一节词海獗说\n—\n203\n-\n不成词语素由两个字记录。" },
    ],
  });
  const body = result.chunks.map((chunk) => chunk.text).join("\n");
  assert.match(body, /词缀都是定位语素，如‘老’居词首/);
  assert.match(body, /不成词语素由两个字记录/);
  assert.doesNotMatch(body, /202|203|第三章词汇|词海獗说/);
});

test("corrupted page numbers are removed only when attached to a running head", () => {
  const result = buildKnowledgeChunks({
    bookId: "modern-chinese-corrupt-page-number",
    bookTitle: "现代汉语",
    pageOffset: 24,
    pageOffsetLocked: true,
    catalogNodes: [{ id: "chapter", level: 1, title: "第一章语音", startPage: 15, endPage: 136 }],
    pages: [
      { pdfPage: 130, printedPage: 106, confidence: 1, text: "句调依附在•\nW\n6\n•第建\n章\n语音\n短语上，A-1-B应当保留。" },
      { pdfPage: 134, printedPage: 110, confidence: 1, text: "至于不起区别意-\nno\n-\n第三章\n语音\n义作用的，就不要吸收了。" },
    ],
  });
  const body = result.chunks.map((chunk) => chunk.text).join("\n");
  assert.match(body, /句调依附在短语上/);
  assert.match(body, /A-1-B应当保留/);
  assert.match(body, /不起区别意义作用/);
  assert.doesNotMatch(body, /W6|no|第建章语音|第三章语音/);
});

test("catalog tables remain searchable but are marked for original-page rendering", () => {
  const result = buildKnowledgeChunks({
    bookId: "modern-chinese",
    bookTitle: "现代汉语",
    pageOffset: 24,
    pageOffsetLocked: true,
    catalogNodes: [{ id: "dialect-table", level: 2, title: "附录现代汉语七大方言语音主要特点表", startPage: 6, endPage: 6 }],
    pages: [{ pdfPage: 30, printedPage: 6, confidence: 0.7, text: "附录现代汉语七大方言语音主要特点表\n方言名称\n方音特点" }],
  });
  assert.equal(result.chunks[0].contentKind, "body");
  assert.equal(result.chunks[0].layoutKind, "table");
  assert.match(result.chunks[0].text, /方言名称方音特点/);
});

test("knowledge builds resume for the same source and replace retried page chunks", () => {
  const store = createMemoryTextbookKnowledgeStore();
  const source = { fingerprint: "pdf-a", catalogVersion: 3, mode: "vision_ocr" };
  store.begin("book-a", { totalPages: 10, source });
  store.appendPages("book-a", [{ pdfPage: 3, printedPage: 1, text: "旧识别正文", confidence: 0.7 }], {
    bookTitle: "测试教材",
    catalogNodes: [],
    totalPages: 10,
  });

  const resumed = store.begin("book-a", { totalPages: 10, source });
  assert.equal(resumed.progress.processedPages, 1);
  assert.equal(resumed.chunkCount, 1);

  store.appendPages("book-a", [{ pdfPage: 3, printedPage: 1, text: "重新识别后的正文", confidence: 0.99 }], {
    bookTitle: "测试教材",
    catalogNodes: [],
    totalPages: 10,
  });
  const record = store.get("book-a", { includeContent: true });
  assert.equal(record.chunks.length, 1);
  assert.equal(record.chunks[0].text, "重新识别后的正文");

  const reset = store.begin("book-a", {
    totalPages: 10,
    source: { ...source, fingerprint: "pdf-b" },
  });
  assert.equal(reset.progress.processedPages, 0);
  assert.equal(reset.chunkCount, 0);
});

test("a confirmed body heading locks the textbook printed-page offset", () => {
  const store = createMemoryTextbookKnowledgeStore();
  const source = { fingerprint: "pdf-a", catalogVersion: 1, mode: "vision_ocr" };
  store.begin("book-a", { totalPages: 592, source });
  store.appendPages("book-a", [
    { pdfPage: 10, printedPage: 2, text: "目录 第一章 文学思潮与运动 3", confidence: 0.9 },
  ], { bookTitle: "测试教材", catalogNodes, totalPages: 592 });
  assert.equal(store.get("book-a").pageOffsetLocked, false);

  store.appendPages("book-a", [
    { pdfPage: 18, printedPage: 3, text: "第一章 文学思潮与运动（一）\n一 文学革命的发生与发展", confidence: 0.99 },
  ], { bookTitle: "测试教材", catalogNodes: [
    { id: "chapter-1", level: 2, title: "第一章 文学思潮与运动（一）", startPage: 3, endPage: 29 },
  ], totalPages: 592 });
  const knowledge = store.get("book-a");
  assert.equal(knowledge.pageOffset, 15);
  assert.equal(knowledge.pageOffsetLocked, true);
  const stored = store.get("book-a", { includeContent: true });
  assert.equal(stored.chunks.find((chunk) => chunk.pdfPageStart === 10).catalogNodeId, "");
  assert.equal(stored.chunks.find((chunk) => chunk.pdfPageStart === 18).catalogNodeId, "chapter-1");
  assert.equal(store.search("book-a", "文学思潮").every((chunk) => chunk.pdfPageStart === 18), true);
  assert.equal(store.listChunks("book-a", { contentKind: "body" }).items.every((chunk) => chunk.contentKind === "body"), true);
  assert.equal(store.listChunks("book-a", { catalogPathPrefix: "第一章 文学思潮与运动（一）" }).items.length, 1);
});

test("a locked page offset corrects OCR digits misread in printed page numbers", () => {
  const result = buildKnowledgeChunks({
    bookId: "modern-chinese-page-number",
    bookTitle: "现代汉语",
    pageOffset: 24,
    pageOffsetLocked: true,
    catalogNodes: [{ id: "chapter", level: 1, title: "第一章语音", startPage: 15, endPage: 136 }],
    pages: [
      { pdfPage: 133, printedPage: 709, confidence: 0.8, text: "教材第109页正文。" },
      { pdfPage: 137, printedPage: 713, confidence: 0.8, text: "教材第113页正文。" },
    ],
  });
  assert.deepEqual(result.pages.map((page) => page.printedPage), [109, 113]);
  assert.deepEqual(result.chunks.map((chunk) => chunk.printedPageStart), [109, 113]);
});

test("OCR output keeps PDF pages separate from textbook printed pages", () => {
  const pages = normalizeBodyOcrPages({
    pages: [
      { pdfPage: 279, printedPage: 264, text: "左联青年作家的涌现。", confidence: 0.93 },
      { pdfPage: 280, printedPage: 265, text: "文学创作继续发展。", confidence: 0.92 },
    ],
  }, [{ pageNumber: 279 }, { pageNumber: 280 }]);
  assert.deepEqual(pages.map((page) => [page.pdfPage, page.printedPage]), [[279, 264], [280, 265]]);
});

test("structured OCR blocks omit figure internals while preserving phonetic symbols", () => {
  const pages = normalizeBodyOcrPages({
    pages: [{
      pdfPage: 17,
      printedPage: 1,
      blocks: [
        { type: "heading", text: "（一）语音的性质\u0000" },
        { type: "paragraph", text: "元音 [i、e、ɛ、a、ɑ、ɔ、o、u] 的音色不同。" },
        { type: "figure", caption: "图1-4 8个标准元音波形图", text: "hJWvyA A B" },
      ],
      confidence: 0.9,
    }],
  }, [{ pageNumber: 17 }]);
  assert.match(pages[0].text, /ɛ/);
  assert.doesNotMatch(pages[0].text, /hJWvyA/);
  assert.doesNotMatch(pages[0].text, /\u0000/);
  assert.equal(pages[0].visuals[0].caption, "图1-4 8个标准元音波形图");
});

test("textbook evidence carries catalog paths, printed pages and chunk ids", () => {
  const evidence = formatTextbookEvidence([{
    id: "chunk-1",
    catalogPath: "第二编 > 第十四章 > 一 左联与左翼小说",
    printedPageStart: 261,
    printedPageEnd: 261,
    pdfPageStart: 276,
    text: "萧红小说具有东北地域色彩。",
  }]);
  assert.match(evidence, /片段ID:chunk-1/);
  assert.match(evidence, /教材第261页/);
  assert.doesNotMatch(evidence, /PDF第276页/);
});

test("RAG generated questions remain unreviewed and cite textbook text", () => {
  const evidenceChunks = [{
    id: "chunk-1",
    catalogPath: "第二编 > 第十四章 > 一 左联与左翼小说",
    printedPageStart: 261,
    pdfPageStart: 276,
    text: "萧红小说具有东北地域色彩。",
  }];
  const [question] = normalizeGeneratedQuestions({
    questions: [{
      type: "single_choice",
      stem: "下列哪一项属于萧红小说的艺术特色？",
      options: [{ key: "A", text: "东北地域色彩" }, { key: "B", text: "宫廷叙事" }],
      correctAnswer: ["A"],
      referenceAnswer: "萧红小说具有东北地域色彩。",
      maxScore: 2,
      scoringPoints: [{ description: "选择教材表述", score: 2, textbookPage: "261" }],
      knowledgePoints: ["萧红小说的艺术特色"],
      catalogPath: "第二编 > 第十四章 > 一 左联与左翼小说",
      evidenceChunkIds: ["chunk-1"],
    }],
  }, {
    bookId: "modern-literature-30-years-3",
    bookTitle: "中国现代文学三十年（第三版）",
    subjectId: "modern-literature",
    count: 1,
    evidenceChunks,
  });
  assert.equal(question.answerSource, "ai_supplement");
  assert.equal(question.answerReviewStatus, "unreviewed");
  assert.equal(question.scoringPoints[0].pageBasis, "textbook_text");
  assert.equal(question.sourcePage, "教材第261页");
});

test("RAG question generation rejects page-number and bibliography trivia", () => {
  assert.equal(isBibliographicQuestion({
    stem: "根据教材注释，鲁迅《杀错了人》异议收入《鲁迅全集》的卷次及所引页码是？",
    options: [
      { text: "第5卷，第100、101页" },
      { text: "第7卷，第105页" },
      { text: "第4卷，第526页" },
      { text: "第6卷，第246页" },
    ],
  }), true);
  assert.equal(isBibliographicQuestion({
    stem: "鲁迅杂文的思想与艺术特质主要表现在哪些方面？",
    options: [],
  }), false);
  assert.throws(() => normalizeGeneratedQuestions({ questions: [{
    type: "single_choice",
    stem: "教材注释所引页码是？",
    options: [{ key: "A", text: "第5卷，第100页" }, { key: "B", text: "第6卷，第101页" }],
    correctAnswer: ["A"],
    referenceAnswer: "第5卷，第100页",
    maxScore: 2,
    scoringPoints: [{ description: "选择著录项", score: 2 }],
    knowledgePoints: ["文献著录"],
    evidenceChunkIds: ["chunk-1"],
  }] }, {
    count: 1,
    evidenceChunks: [{ id: "chunk-1", printedPageStart: 334, catalogPath: "第十七章 鲁迅（二）" }],
  }), /textbook_question_low_quality/);
});
