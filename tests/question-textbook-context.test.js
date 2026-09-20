const test = require("node:test");
const assert = require("node:assert/strict");
const {
  catalogNodeForChapter,
  evidencePageRange,
  extractQuotedTerms,
  extractWorkTitles,
  resolveQuestionTextbookContext,
} = require("../apps/api/src/question-textbook-context");

const books = [
  { id: "modern-book", subjectId: "modern-literature", title: "现代文学教材" },
  { id: "contemporary-book", subjectId: "contemporary-literature", title: "当代文学教材" },
];

const catalogs = {
  "modern-book": {
    confirmed: { nodes: [
      { id: "modern-part", level: 1, title: "第三编 第三个十年", startPage: 400, endPage: 450 },
      { id: "modern-zhao", level: 2, title: "第二十二章 赵树理", startPage: 419, endPage: 429 },
      { id: "modern-characters", level: 3, title: "二 塑造历史变革中的农民形象", startPage: 421, endPage: 426 },
      { id: "modern-form", level: 3, title: "三 评书体现代小说形式", startPage: 427, endPage: 429 },
    ] },
  },
  "contemporary-book": {
    confirmed: { nodes: [
      { id: "contemporary-part", level: 1, title: "上编 50—70年代的文学", startPage: 1, endPage: 180 },
      { id: "contemporary-rural", level: 2, title: "第七章 农村题材小说", startPage: 80, endPage: 92 },
      { id: "contemporary-zhao", level: 3, title: "二 赵树理和山西作家", startPage: 85, endPage: 88 },
    ] },
  },
};

const modernPath = "第三编 第三个十年 > 第二十二章 赵树理 > 二 塑造历史变革中的农民形象";
const contemporaryPath = "上编 50—70年代的文学 > 第七章 农村题材小说 > 二 赵树理和山西作家";
const evidence = {
  "modern-book": [
    { id: "m1", catalogPath: modernPath, printedPageStart: 421, printedPageEnd: 422, text: "《李有才板话》塑造了解放区农民形象。", score: 0.8 },
    { id: "m2", catalogPath: modernPath, printedPageStart: 424, printedPageEnd: 425, text: "《李有才板话》中的李有才机智幽默。", score: 0.78 },
    { id: "m3", catalogPath: modernPath, printedPageStart: 426, printedPageEnd: 426, text: "《李有才板话》反映农村社会变革。", score: 0.76 },
    { id: "m4", catalogPath: "第三编 第三个十年 > 第二十二章 赵树理 > 三 评书体现代小说形式", printedPageStart: 428, printedPageEnd: 429, text: "《李有才板话》采用评书体和群众口语。", score: 0.74 },
  ],
  "contemporary-book": [
    { id: "c1", catalogPath: contemporaryPath, printedPageStart: 86, printedPageEnd: 86, text: "赵树理40年代以《李有才板话》获得声誉。", score: 0.79 },
    { id: "c2", catalogPath: "下编 > 第二十一章", printedPageStart: 286, printedPageEnd: 286, text: "赵树理40年代以《李有才板话》获得声誉。", score: 0.78 },
  ],
};

test("specific work evidence corrects a cross-period author classification", () => {
  const question = {
    subjectId: "contemporary-literature",
    bookId: "contemporary-book",
    chapter: "第二十二章赵树理",
    stem: "结合《李有才板话》分析李有才的人物特点。",
    material: "《李有才板话》\n赵树理\n李有才外号叫气不死。",
    knowledgePoints: [],
  };
  const result = resolveQuestionTextbookContext({
    question,
    books,
    getCatalog: (bookId) => catalogs[bookId],
    getKnowledge: () => ({ status: "ready", chunkCount: 10 }),
    search: (bookId) => evidence[bookId],
  });

  assert.deepEqual(extractWorkTitles(question), ["李有才板话"]);
  assert.equal(result.changed, true);
  assert.equal(result.highConfidence, true);
  assert.equal(result.invalidCurrentChapter, true);
  assert.equal(result.book.id, "modern-book");
  assert.equal(result.chapterNode.id, "modern-zhao");
  assert.equal(result.directEvidenceChunks.length, 4);
  assert.equal(evidencePageRange(result.evidenceChunks), "421-429");
});

test("catalog validation requires an actual node instead of an author substring", () => {
  const contemporaryNodes = catalogs["contemporary-book"].confirmed.nodes;
  const modernNodes = catalogs["modern-book"].confirmed.nodes;
  assert.equal(catalogNodeForChapter("第二十二章赵树理", contemporaryNodes), null);
  assert.equal(catalogNodeForChapter("第二十二章赵树理", modernNodes).id, "modern-zhao");
});

test("questions without work evidence remain in their selected non-literature book", () => {
  const result = resolveQuestionTextbookContext({
    question: { subjectId: "modern-chinese", bookId: "language-book", chapter: "第一章 绪论", stem: "普通话的定义是什么？" },
    books: [{ id: "language-book", subjectId: "modern-chinese", title: "现代汉语" }],
    getCatalog: () => ({ confirmed: { nodes: [{ id: "intro", level: 1, title: "第一章 绪论", startPage: 1, endPage: 10 }] } }),
    getKnowledge: () => ({ status: "ready", chunkCount: 2 }),
    search: () => [],
  });
  assert.equal(result.changed, false);
  assert.equal(result.book.id, "language-book");
  assert.equal(result.chapterNode.id, "intro");
});

test("quoted concepts search inside the declared chapter before repeated mentions elsewhere", () => {
  const question = {
    subjectId: "ancient-literature",
    bookId: "ancient-book",
    chapter: "第二编秦汉文学·第二章西汉辞赋",
    stem: "“劝百讽一”说的是（）。",
    knowledgePoints: ["汉大赋"],
  };
  const result = resolveQuestionTextbookContext({
    question,
    books: [{ id: "ancient-book", subjectId: "ancient-literature", title: "中国古代文学史" }],
    getCatalog: () => ({ confirmed: { nodes: [
      { id: "part-2", level: 1, title: "第二编 秦汉文学", startPage: 100, endPage: 200 },
      { id: "han-fu", level: 2, title: "第二章 西汉辞赋", startPage: 154, endPage: 167 },
      { id: "part-3", level: 1, title: "第三编 魏晋南北朝文学", startPage: 220, endPage: 320 },
      { id: "intro-3", level: 2, title: "绪论", startPage: 230, endPage: 240 },
    ] } }),
    getKnowledge: () => ({ status: "ready", chunkCount: 4 }),
    search: (bookId, query, options = {}) => {
      const chunks = [
        { id: "wrong-1", catalogPath: "第三编 魏晋南北朝文学 > 绪论", printedPageStart: 235, text: "汉赋存在劝百讽一的缺憾。", score: 0.8 },
        { id: "wrong-2", catalogPath: "第三编 魏晋南北朝文学 > 绪论", printedPageStart: 236, text: "汉大赋的劝百讽一影响文学自觉。", score: 0.79 },
        { id: "right", catalogPath: "第二编 秦汉文学 > 第二章 西汉辞赋", printedPageStart: 163, text: "扬雄批评司马相如赋劝百而讽一。", score: 0.4 },
      ];
      return options.catalogPathPrefix
        ? chunks.filter((chunk) => chunk.catalogPath === options.catalogPathPrefix || chunk.catalogPath.startsWith(`${options.catalogPathPrefix} > `))
        : chunks;
    },
  });

  assert.deepEqual(extractQuotedTerms(question), ["劝百讽一"]);
  assert.equal(result.chapterNode.id, "han-fu");
  assert.equal(result.directEvidenceChunks.length, 1);
  assert.equal(evidencePageRange(result.directEvidenceChunks), "163");
});

test("strong option-level evidence corrects a stale chapter inside the same textbook", () => {
  const oldPath = "第一编 第一个十年 > 第一章 文学思潮与运动 > 四 文学创作潮流与趋向";
  const correctPath = "第二编 第二个十年 > 第十四章 小说（二） > 一 左联与左翼小说";
  const chunks = [
    { id: "old", catalogPath: oldPath, printedPageStart: 29, text: "蒋光慈提倡革命和现实主义诗歌。", score: 0.08 },
    { id: "right-1", catalogPath: correctPath, printedPageStart: 261, text: "左联准备期间的小说主要以蒋光慈为代表。", score: 0.2 },
    { id: "right-2", catalogPath: correctPath, printedPageStart: 262, text: "革命加恋爱反映青年知识分子个人与革命的冲突，也暴露对生活的片面理解与表达。", score: 0.42 },
    { id: "right-3", catalogPath: correctPath, printedPageStart: 263, text: "蒋光慈的小说创作及其艺术发展。", score: 0.24 },
  ];
  const result = resolveQuestionTextbookContext({
    question: {
      subjectId: "modern-literature",
      bookId: "modern-book",
      chapter: oldPath,
      stem: "下列关于蒋光慈，描述正确的有（）。",
      options: [
        { key: "A", text: "开创革命加恋爱的革命小说模式" },
        { key: "B", text: "表现青年知识分子个人与革命的冲突，并有片面理解与表达" },
      ],
      knowledgePoints: ["文学创作潮流与趋向"],
    },
    books: [{ id: "modern-book", subjectId: "modern-literature", title: "中国现代文学三十年" }],
    getCatalog: () => ({ confirmed: { nodes: [
      { id: "part-1", level: 1, title: "第一编 第一个十年", startPage: 1, endPage: 150 },
      { id: "chapter-1", level: 2, title: "第一章 文学思潮与运动", startPage: 1, endPage: 40 },
      { id: "old-section", level: 3, title: "四 文学创作潮流与趋向", startPage: 25, endPage: 29 },
      { id: "part-2", level: 1, title: "第二编 第二个十年", startPage: 160, endPage: 330 },
      { id: "chapter-14", level: 2, title: "第十四章 小说（二）", startPage: 260, endPage: 294 },
      { id: "left-fiction", level: 3, title: "一 左联与左翼小说", startPage: 261, endPage: 270 },
    ] } }),
    getKnowledge: () => ({ status: "ready", chunkCount: chunks.length }),
    search: (bookId, query, options = {}) => options.catalogPathPrefix
      ? chunks.filter((chunk) => chunk.catalogPath === options.catalogPathPrefix || chunk.catalogPath.startsWith(`${options.catalogPathPrefix} > `))
      : chunks,
  });

  assert.equal(result.changed, false);
  assert.equal(result.chapterNode.id, "left-fiction");
  assert.equal(evidencePageRange(result.evidenceChunks), "261-263");
});

test("one exact verse resolves a missing textbook through its confirmed chapter", () => {
  const chapterPath = "第三编 魏晋南北朝文学 > 第二章 两晋文学 > 第三节 左思与寒士文学";
  const question = {
    subjectId: "",
    bookId: "",
    chapter: "第三编 魏晋南北朝文学·第二章 两晋文学·第三节 左思与寒士文学",
    stem: "非必丝与竹，__________。（左思《招隐（其一）》）",
    options: [],
    knowledgePoints: ["左思与寒士文学"],
  };
  const result = resolveQuestionTextbookContext({
    question,
    books: [
      { id: "ancient-volume-1", subjectId: "ancient-literature", title: "中国古代文学史·上册" },
      { id: "modern-book", subjectId: "modern-literature", title: "中国现代文学史" },
    ],
    getCatalog: (bookId) => bookId === "ancient-volume-1" ? ({ confirmed: { nodes: [
      { id: "part", level: 1, title: "第三编 魏晋南北朝文学", startPage: 235, endPage: 330 },
      { id: "chapter", level: 2, title: "第二章 两晋文学", startPage: 268, endPage: 282 },
      { id: "zuosi", level: 3, title: "第三节 左思与寒士文学", startPage: 276, endPage: 278 },
    ] } }) : ({ confirmed: { nodes: [] } }),
    getKnowledge: (bookId) => ({ status: "ready", chunkCount: bookId === "ancient-volume-1" ? 1 : 0 }),
    search: (bookId) => bookId === "ancient-volume-1" ? [{
      id: "verse",
      catalogPath: chapterPath,
      printedPageStart: 278,
      printedPageEnd: 278,
      text: "左思《招隐诗》：非必丝与竹，山水有清音。",
      score: 0.95,
    }] : [],
  });

  assert.deepEqual(extractWorkTitles(question), ["招隐"]);
  assert.equal(result.book.id, "ancient-volume-1");
  assert.equal(result.changed, true);
  assert.equal(result.highConfidence, true);
  assert.equal(result.chapterNode.id, "zuosi");
  assert.equal(evidencePageRange(result.evidenceChunks), "278");
});
