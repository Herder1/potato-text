const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildFavoriteOrganization, formatFavoriteDate } = require("../apps/miniprogram/utils/favorites-organization");

/**
 * 「我的收藏」新版视图模型（DEC-096，2026-09-23）——盯口径，不盯实现。
 * 产品负责人选定的口径：两类收藏合并进同一列表、文件夹/子文件夹由用户自建、置顶全局、日期＝收藏时间。
 */

const NOW = new Date("2026-09-23T10:00:00+08:00").getTime();
const DAY = 86400000;

function folder(id, name, parentId = null) {
  return { id, name, parentId, icon: "", order: 1 };
}

const ORGANIZATION = {
  folders: [
    folder("f-education", "教育学"),
    folder("f-reading", "阅读清单"),
    folder("f-theory", "教育理论", "f-education"),
    folder("f-psych", "教育心理", "f-education"),
  ],
  counts: {
    direct: { "f-education": 1, "f-reading": 1, "f-theory": 1, "f-psych": 1 },
    withChildren: { "f-education": 3, "f-reading": 1, "f-theory": 1, "f-psych": 1 },
  },
  membership: {
    "community:a1": "f-theory",
    "community:a2": "f-psych",
    "community:a3": "f-education",
    "question:q1": "f-reading",
  },
  pins: [{ kind: "question", refId: "q2" }],
  favoritedAt: {
    "community:a1": NOW - DAY,          // 昨天
    "community:a2": NOW - 5 * DAY,      // 9 月 18 日
    "community:a3": NOW,                // 今天
    "question:q1": NOW - 3 * DAY,
    "question:q2": NOW - 10 * DAY,      // 置顶，但时间最老
  },
  totals: { community: 4, question: 2, all: 6, unfiled: 1 },
};

const communityItems = [
  { id: "a1", title: "教育的基本功能", excerpt: "教育不仅传递知识…", typeLabel: "知识卡", subjectName: "教育学", chapterTitle: "教育学基础", statusLabel: "", available: true },
  { id: "a2", title: "认知负荷与学习效率", excerpt: "工作记忆容量有限…", typeLabel: "共享笔记", subjectName: "教育学", chapterTitle: "认知科学", statusLabel: "", available: true },
  { id: "a3", title: "形成性评价与反馈", excerpt: "评价应服务于学习过程…", typeLabel: "收藏文章", subjectName: "教育学", chapterTitle: "教学评价", statusLabel: "已下架", available: false },
  { id: "a4", title: "未归类的社区内容", excerpt: "", typeLabel: "卡片集", subjectName: "", chapterTitle: "", statusLabel: "", available: true },
];
const questionItems = [
  { id: "q1", stem: "如何设计有效的检索练习", breadcrumb: "教育学 · 学习方法" },
  { id: "q2", stem: "形成性评价的核心是什么", breadcrumb: "教育学 · 教学评价" },
];
const build = (overrides = {}) => buildFavoriteOrganization({
  communityItems, questionItems, organization: ORGANIZATION, now: NOW, ...overrides,
});

test("「全部收藏」把社区收藏与题目收藏合并进同一列表，并带上各自出处", () => {
  const view = build();
  assert.equal(view.totalCount, 6);
  assert.equal(view.items.length, 6);
  assert.equal(view.folderTitle, "全部收藏");
  assert.equal(view.folderCountLabel, "6 条收藏");
  const community = view.items.find((item) => item.refId === "a1");
  const question = view.items.find((item) => item.refId === "q1");
  assert.equal(community.kind, "community");
  assert.equal(community.sourceLine, "知识卡 · 教育学 · 教育学基础");
  assert.equal(question.kind, "question");
  assert.equal(question.sourceLine, "题目 · 教育学 · 学习方法");
  // 已下架的收藏要带出状态，页面才能把「已下架」显示出来（但仍在列表里，不能悄悄消失）。
  assert.equal(view.items.find((item) => item.refId === "a3").statusLabel, "已下架");
});

test("置顶是全局的：在「全部收藏」与任何文件夹里都排最前，其次按收藏时间倒序", () => {
  const all = build();
  assert.equal(all.items[0].refId, "q2", "置顶项必须排第一，哪怕它收藏时间最老");
  assert.equal(all.items[0].pinned, true);
  // 其余按收藏时间倒序：今天 → 昨天 → 9 月 18 日 …
  assert.deepEqual(all.items.slice(1).map((item) => item.refId), ["a3", "a1", "q1", "a2", "a4"]);

  // 置顶是"全局"的：把「教育心理」里的 a2（5 天前收藏）置顶后，
  // 它在「教育学」这个文件夹里也压过今天刚收藏的 a3 —— 这正是"全局置顶"与"文件夹内置顶"的区别。
  const pinnedInFolder = build({
    activeFolderId: "f-education",
    organization: { ...ORGANIZATION, pins: [{ kind: "community", refId: "a2" }] },
  });
  assert.equal(pinnedInFolder.items[0].refId, "a2");
  assert.equal(pinnedInFolder.items[0].pinned, true);
  // 而它跑到别的文件夹（阅读清单）那边就不该出现——置顶只影响排序，不影响归属。
  const otherFolder = build({
    activeFolderId: "f-reading",
    organization: { ...ORGANIZATION, pins: [{ kind: "community", refId: "a2" }] },
  });
  assert.deepEqual(otherFolder.items.map((item) => item.refId), ["q1"]);
});

test("点文件夹＝看它自己和子文件夹的收藏，上方给出子文件夹标签", () => {
  const view = build({ activeFolderId: "f-education" });
  assert.equal(view.folderTitle, "教育学");
  assert.equal(view.folderCountLabel, "3 条收藏");
  assert.deepEqual(view.items.map((item) => item.refId).sort(), ["a1", "a2", "a3"]);
  assert.deepEqual(view.chips.map((chip) => [chip.label, chip.count, chip.active]), [
    ["全部", 3, true], ["教育理论", 1, false], ["教育心理", 1, false],
  ]);
  // 一个文件夹都还没建子文件夹时，不显示只有「全部」一颗的标签栏（等于没筛选项）。
  const noSub = build({ activeFolderId: "f-reading" });
  assert.deepEqual(noSub.chips.map((chip) => chip.label), ["全部"]);
});

test("点子文件夹标签＝筛出该子文件夹的收藏，标签进入选中态", () => {
  const view = build({ activeFolderId: "f-education", activeSubFolderId: "f-theory" });
  assert.deepEqual(view.items.map((item) => item.refId), ["a1"]);
  assert.equal(view.items[0].tag, "教育理论");
  assert.deepEqual(view.chips.map((chip) => chip.active), [false, true, false]);
  // 空子文件夹：列表空，但标签还在（用户能找到自己建的文件夹）。
  const empty = build({ activeFolderId: "f-education", activeSubFolderId: "f-psych", organization: { ...ORGANIZATION, membership: { "community:a1": "f-theory" }, favoritedAt: ORGANIZATION.favoritedAt } });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.chips.length, 3);
});

test("卡片上的小标签＝所在子文件夹名；没进文件夹的显示「未分类」", () => {
  const view = build();
  assert.equal(view.items.find((item) => item.refId === "a1").tag, "教育理论");
  assert.equal(view.items.find((item) => item.refId === "a3").tag, "教育学", "进的是顶层文件夹，标签就是该文件夹名");
  assert.equal(view.items.find((item) => item.refId === "a4").tag, "未分类");
  assert.equal(view.unfiledCount, 1);
});

test("日期＝收藏时间（今天 / 昨天 / M 月 D 日），没有时间就不显示", () => {
  assert.equal(formatFavoriteDate(NOW, NOW), "今天");
  assert.equal(formatFavoriteDate(NOW - DAY, NOW), "昨天");
  assert.equal(formatFavoriteDate(NOW - 5 * DAY, NOW), "9 月 18 日");
  assert.equal(formatFavoriteDate(0, NOW), "");
  const view = build();
  assert.equal(view.items.find((item) => item.refId === "a1").dateLabel, "昨天");
  assert.equal(view.items.find((item) => item.refId === "a2").dateLabel, "9 月 18 日");
  assert.equal(view.items.find((item) => item.refId === "a4").dateLabel, "");
});

test("抽屉：文件夹按 order 列出并带条数（父文件夹＝直属＋子文件夹），「全部收藏」恒在最前", () => {
  const view = build();
  assert.deepEqual(view.folders.map((item) => [item.name, item.count]), [["教育学", 3], ["阅读清单", 1]]);
  assert.equal(view.allFolder.count, 6);
  assert.equal(view.allFolder.active, true);
  assert.equal(view.directorySubtitle, "4 个文件夹 · 6 条收藏");
  const inReading = build({ activeFolderId: "f-reading" });
  assert.equal(inReading.allFolder.active, false);
  assert.equal(inReading.folders.find((item) => item.id === "f-reading").active, true);
});

test("服务端还没建任何文件夹时，页面照样能显示（全在「全部收藏」里）", () => {
  const view = build({ organization: { folders: [], counts: {}, membership: {}, pins: [], favoritedAt: ORGANIZATION.favoritedAt, totals: { community: 4, question: 2, all: 6, unfiled: 6 } } });
  assert.equal(view.folders.length, 0);
  assert.equal(view.items.length, 6);
  assert.equal(view.chips.length, 0);
  assert.equal(view.directorySubtitle, "0 个文件夹 · 6 条收藏");
  assert.equal(view.items.every((item) => item.tag === "未分类"), true);
});

test("搜索框按标题/摘要/标签/出处匹配，忽略大小写与首尾空格；计数与空态跟着变", () => {
  // 产品负责人 2026-09-23 04:4x：搜索框加在「全部收藏」上面。
  const hit = build({ keyword: "形成性" });
  // a3「形成性评价与反馈」在列表里，q2「形成性评价的核心是什么」也在
  assert.deepEqual(hit.items.map((item) => item.title).sort(), ["形成性评价与反馈", "形成性评价的核心是什么"].sort());
  assert.equal(hit.hasFilter, true);
  assert.equal(hit.folderCountLabel, "6 条收藏 · 筛出 2 条");
  // 空格与大小写都不该影响结果
  assert.equal(build({ keyword: "  形成性  " }).items.length, 2);
  // 也能按标签（所在文件夹名）与出处（学科·章节）搜
  assert.equal(build({ keyword: "教育学基础" }).items.length, 1);
  // 搜不到：给出"没有匹配"的空态文案，而不是"还没有收藏"
  const none = build({ keyword: "不存在的词" });
  assert.equal(none.items.length, 0);
  assert.equal(none.emptyLabel, "没有匹配「不存在的词」的收藏");
  assert.equal(none.hasFilter, true);
  // 不搜索时一切照旧
  const plain = build();
  assert.equal(plain.hasFilter, false);
  assert.equal(plain.folderCountLabel, "6 条收藏");
  assert.equal(plain.emptyLabel, "还没有收藏");
});

test("筛选＝按内容类型（选项从当前范围的数据里长出来，带条数），可与搜索叠加", () => {
  const plain = build();
  // 顺序由条数决定（多的在前），"全部"恒在第一行；具体中文排序交给 ICU，所以只钉条数不钉次序
  assert.deepEqual(Object.fromEntries(plain.typeOptions.map((item) => [item.label, item.count])), {
    全部: 6, 知识卡: 1, 共享笔记: 1, 收藏文章: 1, 卡片集: 1, 题目: 2,
  });
  assert.equal(plain.typeOptions[0].label, "全部");
  assert.equal(plain.typeOptions[0].active, true);

  const onlyQuestions = build({ typeFilter: "题目" });
  assert.deepEqual(onlyQuestions.items.map((item) => item.title), ["形成性评价的核心是什么", "如何设计有效的检索练习"]);
  assert.equal(onlyQuestions.typeOptions.find((item) => item.label === "题目").active, true);
  assert.equal(onlyQuestions.typeFilter, "题目");
  assert.equal(onlyQuestions.folderCountLabel, "6 条收藏 · 筛出 2 条");
  assert.equal(onlyQuestions.emptyLabel, "这个类型下还没有收藏");

  // 搜索 + 筛选是叠加关系（AND），不是互相覆盖
  assert.equal(build({ typeFilter: "知识卡", keyword: "教育" }).items.length, 1);
  // 换了文件夹后该文件夹里没有这个类型 → 筛选自动作废（不能让用户对着空列表找不到原因）
  const inFolder = build({ typeFilter: "卡片集", activeFolderId: "f-reading" });
  assert.equal(inFolder.typeFilter, "");
  assert.equal(inFolder.items.length, 1);
  // 范围里一条都没有时不给选项（面板据此不空开）
  const emptyScope = build({ communityItems: [], questionItems: [], organization: { ...ORGANIZATION, membership: {}, favoritedAt: {}, totals: { all: 0, unfiled: 0 } } });
  assert.deepEqual(emptyScope.typeOptions, []);
  assert.equal(emptyScope.scopedCount, 0);
});