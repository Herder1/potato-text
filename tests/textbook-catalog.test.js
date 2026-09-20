const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { auditCatalogNodes, createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");
const { catalogPagesForModel, localCatalogDraft, requiresPdfOcr, tocCatalogDraft, validatePdfBuffer } = require("../apps/api/src/textbook-pdf");
const { catalogTitleIsCorrupted, normalizeCatalogHierarchy, normalizeCatalogPageRanges, refreshCatalogBackedQuestionPages } = require("../apps/api/src/server");

test("textbook catalogs require manual confirmation before publication", () => {
  const store = createMemoryTextbookCatalogStore();
  const bookId = "modern-chinese-7-1";
  store.savePdf(bookId, { fileName: "现代汉语上册.pdf", size: 1024, pageCount: 300, textChars: 120000 });
  let textbook = store.setDraft(bookId, [
    { level: 1, title: "第一章 绪论", startPage: 1, endPage: 18, evidence: "第一章 绪论", knowledgePoints: ["现代汉语"] },
    { level: 2, title: "第一节 现代汉语概述", startPage: 2, endPage: 8, knowledgePoints: ["共同语", "方言"] },
  ], { source: "ai_model", model: "test-model" });
  assert.equal(textbook.status, "draft_pending");
  assert.equal(textbook.confirmed, null);

  textbook = store.updateDraft(bookId, textbook.draft.nodes.map((node) => ({ ...node, evidence: `${node.evidence}（已核对）` })), "题库编辑");
  assert.equal(textbook.draft.nodes[0].evidence.includes("已核对"), true);
  textbook = store.confirm(bookId, "内容审核员");
  assert.equal(textbook.status, "confirmed");
  assert.equal(textbook.draft, null);
  assert.equal(textbook.confirmed.nodes.length, 2);
  assert.equal(textbook.confirmed.confirmedBy, "内容审核员");
});

test("local PDF heading rules create reviewable candidates", () => {
  const nodes = localCatalogDraft([
    "目录\n第一章 绪论\n第一节 现代汉语概述\n第二节 现代汉民族共同语",
    "第二章 语音\n一、语音的性质\n1.1 语音的社会属性",
  ]);
  assert.equal(nodes.length, 6);
  assert.equal(nodes[0].title, "第一章 绪论");
  assert.deepEqual(nodes[1].knowledgePoints, ["现代汉语概述"]);
  assert.equal(nodes[3].startPage, 2);
  assert.throws(() => validatePdfBuffer(Buffer.from("not-a-pdf")), /textbook_pdf_invalid/);
});

test("fragmented PDF table of contents is reconstructed into catalog levels", () => {
  const nodes = tocCatalogDraft([
    "封面",
    "目\n录\n绪论\n1\n第一节\n现代汉\n语概说\n1\n一、\n什么是\n现代汉语\n1\n第二节\n汉语规范化\n9\n第一章\n语音\n15",
  ]);

  assert.deepEqual(nodes.map(({ level, title, startPage }) => ({ level, title, startPage })), [
    { level: 1, title: "绪论", startPage: 1 },
    { level: 2, title: "第一节现代汉语概说", startPage: 1 },
    { level: 3, title: "一、什么是现代汉语", startPage: 1 },
    { level: 2, title: "第二节汉语规范化", startPage: 9 },
    { level: 1, title: "第一章语音", startPage: 15 },
  ]);
  assert.match(nodes[1].evidence, /PDF 第 2 页目录/);
});

test("table of contents can begin around PDF page 20", () => {
  const pages = Array.from({ length: 19 }, (_, index) => `前置页 ${index + 1}`);
  pages.push("目 录\n第一单元\n文选：左传 7\n常用词（一） 41");
  const nodes = tocCatalogDraft(pages);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].title, "第一单元文选：左传");
  assert.equal(nodes[0].startPage, 7);
  assert.match(nodes[0].evidence, /PDF 第 20 页目录/);
});

test("catalog page ranges follow the next same-or-higher level start page", () => {
  const normalized = normalizeCatalogPageRanges([
    { level: 2, title: "文选：左传", startPage: 7, endPage: 7 },
    { level: 3, title: "郑伯克段于鄢", startPage: 8, endPage: 8 },
    { level: 3, title: "齐桓公伐楚", startPage: 13, endPage: 13 },
    { level: 3, title: "宫之奇谏假道", startPage: 16, endPage: 16 },
    { level: 3, title: "烛之武退秦师", startPage: 20, endPage: 20 },
    { level: 3, title: "蹇叔哭师", startPage: 22, endPage: 22 },
    { level: 3, title: "晋灵公不君", startPage: 25, endPage: 25 },
    { level: 3, title: "齐晋鞌之战", startPage: 30, endPage: 30 },
    { level: 3, title: "楚归晋知罃", startPage: 35, endPage: 35 },
    { level: 3, title: "祁奚荐贤", startPage: 38, endPage: 38 },
    { level: 3, title: "子产不毁乡校", startPage: 40, endPage: 40 },
    { level: 2, title: "常用词（一）", startPage: 41, endPage: 41 },
  ]);
  assert.deepEqual(normalized.slice(0, 4).map((node) => node.endPage), [40, 13, 16, 20]);
  assert.equal(normalized[10].endPage, 41);
});

test("a final parent range expands through its last descendant", () => {
  const normalized = normalizeCatalogPageRanges([
    { level: 1, title: "下编 80—90年代的文学", startPage: 185, endPage: 198 },
    { level: 2, title: "第十六章 文学新时期", startPage: 185, endPage: 198 },
    { level: 2, title: "第二十七章 90年代小说", startPage: 346, endPage: 358 },
  ]);
  assert.equal(normalized[0].endPage, 358);
});

test("catalog audit blocks broken hierarchy and reports chapter sequence gaps", () => {
  const audit = auditCatalogNodes([
    { id: "upper", level: 1, title: "上编 50—70年代的文学", startPage: 1, endPage: 100 },
    { id: "chapter-1", level: 2, title: "第一章 文学概况", startPage: 1, endPage: 20 },
    { id: "broken", level: 4, title: "（一）错误跳级", startPage: 2, endPage: 3 },
    { id: "chapter-3", level: 1, title: "第三章 小说", startPage: 21, endPage: 30 },
  ]);
  assert.equal(audit.valid, false);
  assert.equal(audit.issues.some((issue) => issue.code === "level_jump"), true);
  assert.equal(audit.issues.some((issue) => issue.code === "chapter_outside_part"), true);
  assert.equal(audit.issues.some((issue) => issue.code === "chapter_sequence_gap"), true);
});

// 标题里的编号本身写着层级：同一本书里同一种编号被放到"比它惯例更深"的位置时，
// 它会挂到上一条目录下面，并把子节点的题数汇总上去（空目录看着有题）。只报警告、不阻断。
test("catalog audit warns when a heading's numbering disagrees with its level", () => {
  const audit = auditCatalogNodes([
    { id: "chapter", level: 1, title: "第一章语音", startPage: 1, endPage: 60 },
    { id: "section-1", level: 2, title: "第一节语音概说", startPage: 2, endPage: 10 },
    { id: "section-2", level: 2, title: "第二节辅音与声母", startPage: 11, endPage: 20 },
    { id: "section-3", level: 2, title: "第三节元音与韵母", startPage: 21, endPage: 30 },
    { id: "section-4", level: 2, title: "第四节声调", startPage: 31, endPage: 40 },
    { id: "topic", level: 3, title: "一、变调", startPage: 32, endPage: 34 },
    { id: "practice", level: 2, title: "思考和练习六", startPage: 41, endPage: 60 },
    { id: "section-7", level: 3, title: "☆第七节音位", startPage: 42, endPage: 50 },
    { id: "section-8", level: 3, title: "第八节朗读和语调", startPage: 51, endPage: 58 },
  ]);
  const conflicts = audit.issues.filter((issue) => issue.code === "level_numbering_conflict");
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts.every((issue) => issue.severity === "warning"), true);
  assert.equal(conflicts.some((issue) => issue.message.includes("第七节音位")), true);
  // 只报警告，不阻断确认。
  assert.equal(audit.valid, true);
});

test("catalog audit accepts sections used one level shallower than the book's convention", () => {
  // “总绪论”下的节标成二级是合理的（比全书惯例浅），不该报警。
  const audit = auditCatalogNodes([
    { id: "intro", level: 1, title: "总绪论", startPage: 1, endPage: 10 },
    { id: "intro-1", level: 2, title: "第一节 文学史的性质", startPage: 2, endPage: 4 },
    { id: "part", level: 1, title: "第一编 先秦文学", startPage: 11, endPage: 60 },
    { id: "chapter", level: 2, title: "第一章 上古神话", startPage: 12, endPage: 30 },
    { id: "section", level: 3, title: "第一节 神话的产生", startPage: 13, endPage: 20 },
    { id: "section-2", level: 3, title: "第二节 神话形象和故事", startPage: 21, endPage: 28 },
  ]);
  assert.equal(audit.issues.some((issue) => issue.code === "level_numbering_conflict"), false);
});

test("catalog confirmation refuses drafts with blocking audit issues", () => {  const store = createMemoryTextbookCatalogStore();
  store.setDraft("contemporary-literature-history-3", [
    { level: 1, title: "上编 50—70年代的文学", startPage: 1, endPage: 100 },
    { level: 3, title: "第一章 文学概况", startPage: 1, endPage: 20 },
  ]);
  assert.throws(() => store.confirm("contemporary-literature-history-3"), /catalog_audit_failed/);
  assert.equal(store.get("contemporary-literature-history-3").status, "draft_pending");
});

test("same-page appendix tables do not swallow following numbered topics", () => {
  const store = createMemoryTextbookCatalogStore();
  const textbook = store.setDraft("modern-chinese-7-1", [
    { level: 1, title: "绪论", startPage: 1, endPage: 14 },
    { level: 2, title: "第一节现代汉语概说", startPage: 1, endPage: 9 },
    { level: 3, title: "三、现代汉语方言", startPage: 3, endPage: 6 },
    { level: 2, title: "附录现代汉语七大方言语音主要特点表", startPage: 6, endPage: 8 },
    { level: 3, title: "四、现代汉语的特点", startPage: 6, endPage: 8 },
    { level: 3, title: "五、现代汉语的地位", startPage: 8, endPage: 9 },
  ]);
  const nodes = textbook.draft.nodes;
  assert.equal(nodes[3].level, 3);
  assert.equal(nodes[3].endPage, 6);
  assert.equal(nodes[4].level, 3);
});

test("null-byte OCR prefixes are removed from confirmed catalog titles", () => {
  const store = createMemoryTextbookCatalogStore();
  const textbook = store.setDraft("modern-chinese-7-1", [
    { level: 3, title: "里录\0出\0二、纠正错别字", startPage: 176, endPage: 181 },
    { level: 2, title: "第三节汉字的结构.", startPage: 147, endPage: 158 },
  ]);
  assert.equal(textbook.draft.nodes[0].title, "二、纠正错别字");
  assert.equal(textbook.draft.nodes[1].title, "第三节汉字的结构");
});

test("modern literature numbered chapter entries stay at one level and receive page ranges", () => {
  const store = createMemoryTextbookCatalogStore();
  const textbook = store.setDraft("modern-literature-30-years-3", [
    { level: 2, title: "第十四章 小说(二)", startPage: 261, endPage: 261 },
    { level: 3, title: "一 “左联”与左翼小说", startPage: 261, endPage: 261 },
    { level: 4, title: "二 京派小说与其他独立作家的小说", startPage: 276, endPage: 276 },
    { level: 4, title: "三 海派小说", startPage: 284, endPage: 284 },
    { level: 2, title: "附录 本章年表", startPage: 292, endPage: 292 },
  ]);
  assert.deepEqual(textbook.draft.nodes.map((node) => node.level), [2, 3, 3, 3, 2]);
  assert.deepEqual(textbook.draft.nodes.map((node) => node.endPage), [291, 276, 284, 292, 292]);
});

test("confirmed catalog range changes refresh only catalog-backed scoring point pages", () => {
  const catalogs = createMemoryTextbookCatalogStore();
  catalogs.setDraft("modern-literature-30-years-3", [
    { level: 2, title: "第十四章 小说(二)", startPage: 261, endPage: 261 },
    { level: 3, title: "一 “左联”与左翼小说", startPage: 261, endPage: 261 },
    { level: 3, title: "二 京派小说", startPage: 276, endPage: 276 },
  ]);
  catalogs.confirm("modern-literature-30-years-3");
  const questions = createMemoryQuestionStore([]);
  const question = questions.create({
    subjectId: "modern-literature",
    bookId: "modern-literature-30-years-3",
    chapter: "第十四章 小说(二) > 一 “左联”与左翼小说",
    knowledgePoints: ["萧红小说"],
    type: "short_answer",
    stem: "简述萧红小说的艺术特色。",
    referenceAnswer: "具有东北地域色彩和散文化特点。",
    maxScore: 4,
    scoringPoints: [
      { description: "东北地域色彩", score: 2, textbookPage: "261", pageBasis: "confirmed_catalog", sourceNote: "中国现代文学三十年 · 一 “左联”与左翼小说" },
      { description: "散文化特点", score: 2, textbookPage: "265", pageBasis: "textbook_text", sourceNote: "教材正文" },
    ],
  });
  const result = refreshCatalogBackedQuestionPages(questions, catalogs, "modern-literature-30-years-3");
  const updated = questions.get(question.id);
  assert.deepEqual(result, { questionsUpdated: 1, pointsUpdated: 1 });
  assert.equal(updated.scoringPoints[0].textbookPage, "261-276");
  assert.equal(updated.scoringPoints[1].textbookPage, "265");
});

test("catalog extraction rejects placeholder-only titles before saving a draft", () => {
  assert.equal(catalogTitleIsCorrupted("??????"), true);
  assert.equal(catalogTitleIsCorrupted("??:??"), true);
  assert.equal(catalogTitleIsCorrupted("文选：左传"), false);
  assert.equal(catalogTitleIsCorrupted("（二）古今词义的异同"), false);
});

test("AI textbook extraction receives the table of contents instead of unrelated body pages", () => {
  const selected = catalogPagesForModel([
    "封面正文",
    "目录\n第一章\n语音\n15",
    "第一节\n语音概说\n15",
    "",
    "第一章正文不应进入模型输入",
  ]);

  assert.match(selected, /PDF 第 2 页/);
  assert.match(selected, /PDF 第 3 页/);
  assert.doesNotMatch(selected, /第一章正文不应进入模型输入/);
});

test("scanned textbooks are routed to OCR when their text layer is empty", () => {
  assert.equal(requiresPdfOcr({ textChars: 0 }), true);
  assert.equal(requiresPdfOcr({ textChars: 79 }), true);
  assert.equal(requiresPdfOcr({ textChars: 80 }), false);
});

test("part-based literature catalogs keep part, chapter, section and heading levels", () => {
  const nodes = normalizeCatalogHierarchy([
    { level: 2, title: "总绪论" },
    { level: 3, title: "第一节 文学史的性质" },
    { level: 1, title: "第一编 先秦文学" },
    { level: 1, title: "第一章 上古神话" },
    { level: 2, title: "第一节 神话的产生" },
    { level: 3, title: "一、神话的概念" },
  ]);
  assert.deepEqual(nodes.map((node) => node.level), [1, 2, 1, 2, 3, 4]);
});

test("upper and lower part headings keep chapters from later catalog pages nested", () => {
  const nodes = normalizeCatalogHierarchy([
    { level: 1, title: "上编 50—70年代的文学" },
    { level: 1, title: "第五章 诗歌创作" },
    { level: 2, title: "一、诗歌道路" },
    { level: 1, title: "第六章 散文创作" },
    { level: 2, title: "一、散文概况" },
    { level: 1, title: "下编 80—90年代的文学" },
    { level: 1, title: "第十六章 文学思潮" },
    { level: 2, title: "一、新时期文学" },
    { level: 1, title: "第十七章 小说创作" },
    { level: 2, title: "一、小说潮流" },
  ]);
  assert.deepEqual(nodes.map((node) => node.level), [1, 2, 3, 2, 3, 1, 2, 3, 2, 3]);
});

test("numbered headings remain siblings instead of becoming progressively deeper", () => {
  const nodes = normalizeCatalogHierarchy([
    { level: 1, title: "上编 50—70年代的文学" },
    { level: 1, title: "第一章 文学概况" },
    { level: 2, title: "一、文学环境" },
    { level: 3, title: "二、文学思潮" },
    { level: 3, title: "三、文学创作" },
  ]);
  assert.deepEqual(nodes.map((node) => node.level), [1, 2, 3, 3, 3]);
});
