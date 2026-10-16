// 章节文本归一的契约测试（2026-09-27）。锁三条硬规矩：逐段全中、绝不降级、对不上就不改。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compactChapterSegment,
  normalizeChapterToCatalogPath,
  splitChapterSegments,
} = require("../apps/api/src/chapter-path-normalizer");

// 取自真实知识树（现代汉语 7-1 / 7-2）的路径写法。
const nodes = [
  { path: "文字" },
  { path: "文字 > 汉字的形体" },
  { path: "文字 > 汉字的形体 > 现行汉字的形体" },
  { path: "文字 > 汉字概说" },
  { path: "文字 > 汉字概说 > 文字的性质" },
  { path: "语法" },
  { path: "语法 > 词类(上)" },
  { path: "语法 > 词类(上) > 实词" },
  { path: "语法 > 短语" },
  { path: "语法 > 短语 > 短语的结构类型" },
  { path: "第一单元" },
];

test("章节文本归一：带序号的写法归到目录路径，且不丢层级", () => {
  assert.deepEqual(
    normalizeChapterToCatalogPath("第四章语法 > 第二节词类（上） > 二、实词", nodes),
    { path: "语法 > 词类(上) > 实词", segments: ["第四章语法", "第二节词类（上）", "二、实词"], alreadyNormalized: false },
  );
  // 分隔符 `·` 与 `>` 一视同仁；章标题里的空格不影响
  assert.equal(normalizeChapterToCatalogPath("第二章 文字·第二节 汉字的形体·二、现行汉字的形体", nodes).path,
    "文字 > 汉字的形体 > 现行汉字的形体");
  // 只写到节也能归
  assert.equal(normalizeChapterToCatalogPath("第四章语法·第二节词类（上）", nodes).path, "语法 > 词类(上)");
  // 只写到章也能归（目录路径本来就是章的写法）
  assert.equal(normalizeChapterToCatalogPath("第四章语法", nodes).path, "语法");
});

test("章节文本归一：已经是目录路径时幂等且标注 alreadyNormalized", () => {
  assert.deepEqual(normalizeChapterToCatalogPath("文字 > 汉字的形体", nodes), {
    path: "文字 > 汉字的形体",
    segments: ["文字", "汉字的形体"],
    alreadyNormalized: true,
  });
});

test("章节文本归一：绝不降级——后段对不上就整条不改", () => {
  // 目录里没有「文选：左传」「晋灵公不君」，绝不能改写成更浅的「第一单元」
  assert.equal(normalizeChapterToCatalogPath("第一单元·文选：左传·晋灵公不君", nodes), null);
  // 第一段就断：目录里没有「第五编 宋代文学」
  assert.equal(normalizeChapterToCatalogPath("第五编 宋代文学·第三章 北宋前期词坛", nodes), null);
  // 段数全中才算：中间一段对不上
  assert.equal(normalizeChapterToCatalogPath("语法 > 复句 > 结构类型", nodes), null);
});

test("章节文本归一：多章节引用（；分隔）不机械拆开", () => {
  const chapter = "第五编 宋代文学·第三章 北宋前期词坛·第三节 晏殊和欧阳修；第六章 北宋后期诗词·第二节 晏几道";
  assert.equal(splitChapterSegments(chapter).length, 4);
  assert.equal(normalizeChapterToCatalogPath(chapter, nodes), null);
});

test("章节文本归一：空值/无节点/无路径节点一律返回 null（不许猜）", () => {
  assert.equal(normalizeChapterToCatalogPath("", nodes), null);
  assert.equal(normalizeChapterToCatalogPath("第四章语法", []), null);
  assert.equal(normalizeChapterToCatalogPath("第四章语法", [{ title: "无路径节点" }]), null);
  assert.equal(normalizeChapterToCatalogPath("   ", nodes), null);
});

test("压缩函数：去序号前缀、去括号、去空格，保留可辨识汉字", () => {
  assert.equal(compactChapterSegment("第四章语法"), "语法");
  assert.equal(compactChapterSegment("第二节词类（上）"), "词类");
  assert.equal(compactChapterSegment("二、现行汉字的形体"), "现行汉字的形体");
  assert.equal(compactChapterSegment("第一编 先秦文学"), "先秦文学");
});
