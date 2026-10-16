const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCatalogOutline, buildSubjectCatalogOutline, createProjectedCatalogChapters, subjectGroupsFromCatalogs } = require("../apps/miniprogram/utils/catalog-outline");

test("confirmed flat catalog becomes a stable chapter and section outline", () => {
  const outline = buildCatalogOutline([
    { id: "node-3", order: 3, level: 3, title: "一、什么是声调", startPage: 64 },
    { id: "node-1", order: 1, level: 1, title: "第一章语音", startPage: 15, endPage: 136 },
    { id: "node-2", order: 2, level: 2, title: "第四节声调", startPage: 64, endPage: 68 },
  ]);

  // 目录节点 id 直接作为目录 id，不再借旧章节 id；层级按父子关系重算。
  assert.equal(outline.length, 1);
  assert.equal(outline[0].id, "node-1");
  assert.equal(outline[0].catalogNodeId, "node-1");
  assert.equal(outline[0].level, 1);
  assert.deepEqual(outline[0].sections.map((section) => section.id), ["node-2", "node-3"]);
  assert.equal(outline[0].sections[0].level, 2);
  assert.equal(outline[0].sections[1].level, 3);
  assert.equal(outline[0].sections[1].parentId, "node-2");
});

test("explicit parentId from the knowledge tree wins over a wrong catalog level", () => {
  // 目录里这两个"节"被标成第 3 级（真实的《现代汉语》上册就错过一次），
  // 但知识树给出的 parentId 说明它们应该直接挂在第一章下面。
  const outline = buildCatalogOutline([
    { id: "chapter", order: 1, level: 1, title: "第一章语音", startPage: 1, endPage: 60, parentId: "" },
    { id: "practice-6", order: 2, level: 2, title: "思考和练习六", startPage: 41, endPage: 41, parentId: "chapter" },
    { id: "section-7", order: 3, level: 3, title: "☆第七节音位", startPage: 42, endPage: 50, parentId: "chapter" },
    { id: "topic", order: 4, level: 3, title: "一、音位简说", startPage: 42, endPage: 45, parentId: "section-7" },
  ]);

  assert.equal(outline.length, 1);
  const sections = new Map(outline[0].sections.map((section) => [section.id, section]));
  assert.equal(sections.get("section-7").parentId, "chapter");
  assert.equal(sections.get("section-7").level, 2);
  assert.equal(sections.get("topic").parentId, "section-7");
  assert.equal(sections.get("topic").level, 3);
  assert.equal(sections.get("practice-6").parentId, "chapter");
});

test("a catalog node missing from the knowledge tree falls back to level nesting", () => {
  // 不在知识树里的节点拿不到 parentId，退回按 level 推导，不能丢节点。
  const outline = buildCatalogOutline([
    { id: "chapter", order: 1, level: 1, title: "第一章", startPage: 1, endPage: 40, parentId: "" },
    { id: "kept", order: 2, level: 2, title: "第一节", startPage: 2, endPage: 10, parentId: "chapter" },
    { id: "orphan", order: 3, level: 3, title: "一、被删过的节点", startPage: 3, endPage: 5 },
  ]);
  const sections = new Map(outline[0].sections.map((section) => [section.id, section]));
  assert.equal(sections.has("orphan"), true);
  assert.equal(sections.get("orphan").parentId, "kept");
});

test("topic-family anchors project recursively and deduplicate question ids per node", () => {
  const outline = [{
    id: "chapter",
    catalogNodeId: "catalog-chapter",
    title: "第一章",
    sections: [
      { id: "section-a", catalogNodeId: "catalog-section-a", parentId: "chapter", level: 2, title: "第一节" },
      { id: "topic-a", catalogNodeId: "catalog-topic-a", parentId: "section-a", level: 3, title: "知识小点" },
      { id: "section-b", catalogNodeId: "catalog-section-b", parentId: "chapter", level: 2, title: "第二节" },
    ],
  }];
  const projected = createProjectedCatalogChapters(outline, [{
    id: "q1",
    catalogProjection: { anchorNodeIds: ["catalog-topic-a", "catalog-section-b"] },
  }, {
    id: "q1",
    catalogProjection: { anchorNodeIds: ["catalog-topic-a"] },
  }, {
    id: "q2",
    catalogProjection: { anchorNodeIds: ["catalog-topic-a"] },
  }, {
    id: "q3",
    knowledgePoints: ["知识小点"],
  }, {
    id: "q4",
    catalogProjection: { anchorNodeIds: ["missing-anchor"] },
  }, {
    id: "q5",
    catalogProjection: { anchorNodeIds: ["catalog-section-a", "catalog-topic-a"] },
  }], "q2");

  const chapter = projected.find((item) => item.id === "chapter");
  const sectionA = chapter.sections.find((item) => item.id === "section-a");
  const topicA = chapter.sections.find((item) => item.id === "topic-a");
  const sectionB = chapter.sections.find((item) => item.id === "section-b");
  const unassigned = projected.find((item) => item.id === "catalog-unassigned");
  assert.deepEqual(chapter.questionIds, ["q1", "q2", "q5"]);
  assert.equal(chapter.questionCount, 3);
  assert.equal(chapter.expanded, true);
  assert.deepEqual(sectionA.questionIds, ["q1", "q2", "q5"]);
  assert.deepEqual(topicA.questionIds, ["q1", "q2", "q5"]);
  assert.deepEqual(sectionB.questionIds, ["q1"]);
  assert.deepEqual(unassigned.questionIds, ["q3", "q4"]);
  assert.equal(unassigned.title, "待归组");
});

test("the user-side catalog hides nodes with no questions", () => {
  const outline = [{
    id: "chapter",
    catalogNodeId: "catalog-chapter",
    title: "第一章",
    sections: [
      { id: "section-a", catalogNodeId: "catalog-section-a", parentId: "chapter", level: 2, title: "第一节 有题" },
      { id: "topic-a", catalogNodeId: "catalog-topic-a", parentId: "section-a", level: 3, title: "有题的知识小点" },
      { id: "topic-empty", catalogNodeId: "catalog-topic-empty", parentId: "section-a", level: 3, title: "没题的知识小点" },
      { id: "section-b", catalogNodeId: "catalog-section-b", parentId: "chapter", level: 2, title: "第二节 没题" },
    ],
  }, {
    id: "chapter-empty",
    catalogNodeId: "catalog-chapter-empty",
    title: "第二章",
    sections: [
      { id: "section-c", catalogNodeId: "catalog-section-c", parentId: "chapter-empty", level: 2, title: "第一节 没题" },
    ],
  }];
  const projected = createProjectedCatalogChapters(outline, [{
    id: "q1",
    catalogProjection: { anchorNodeIds: ["catalog-topic-a"] },
  }]);

  // 整支为 0 的章和小节都隐藏；有题的小节保留，其父链因为有题也会保留。
  assert.deepEqual(projected.map((item) => item.id), ["chapter"]);
  assert.equal(projected[0].questionCount, 1);
  assert.deepEqual(projected[0].sections.map((item) => item.id), ["section-a", "topic-a"]);
});

test("the user-side catalog falls back to the full outline when no catalog node has questions yet", () => {
  const outline = [{
    id: "chapter",
    catalogNodeId: "catalog-chapter",
    title: "第一章",
    sections: [
      { id: "section-a", catalogNodeId: "catalog-section-a", parentId: "chapter", level: 2, title: "第一节" },
    ],
  }];
  // 题目都在、但一条都没归入题族：只留一个"待归组"会让用户失去课本结构导航，所以退回完整目录。
  const onlyUngrouped = createProjectedCatalogChapters(outline, [{ id: "q1", knowledgePoints: ["未归组"] }]);
  assert.deepEqual(onlyUngrouped.map((item) => item.id), ["chapter", "catalog-unassigned"]);
  assert.equal(onlyUngrouped[0].questionCount, 0);
  assert.equal(onlyUngrouped[1].questionCount, 1);

  // 一道题都没有时（例如刚同步完、题库为空），同样退回完整目录，不能显示成"同步失败"。
  const empty = createProjectedCatalogChapters(outline, []);
  assert.deepEqual(empty.map((item) => item.id), ["chapter"]);
  assert.deepEqual(empty[0].sections.map((item) => item.id), ["section-a"]);
  assert.equal(empty[0].questionCount, 0);
});

test("comprehensive catalog merges volumes under one subject in volume order", () => {
  // 综合训练跨册题池：同一科目的各册顶层目录（章/编/单元）按册顺序拼成同一条二级列表，
  // 不标册名、不因同名去重；往下逐级 +1，最深封顶 5 级。
  const textbooks = [
    {
      bookId: "modern-chinese-7-2",
      subjectId: "modern-chinese",
      version: 2,
      nodes: [
        { id: "ch4", order: 1, level: 1, title: "第四章语法", parentId: "" },
        { id: "ch4-s1", order: 2, level: 2, title: "第一节语法概说", parentId: "ch4" },
        { id: "ch4-s1-t1", order: 3, level: 3, title: "一、语法单位", parentId: "ch4-s1" },
      ],
    },
    {
      bookId: "modern-chinese-7-1",
      subjectId: "modern-chinese",
      version: 3,
      nodes: [
        { id: "intro", order: 1, level: 1, title: "绪论", parentId: "" },
        { id: "ch1", order: 2, level: 1, title: "第一章语音", parentId: "" },
        { id: "ch1-s1", order: 3, level: 2, title: "第一节语音概说", parentId: "ch1" },
        { id: "ch1-s1-t1", order: 4, level: 3, title: "一、语音的性质", parentId: "ch1-s1" },
        { id: "ch1-s1-t1-x", order: 5, level: 4, title: "（一）物理属性", parentId: "ch1-s1-t1" },
        { id: "ch1-s1-t1-x-y", order: 6, level: 5, title: "更深的一层", parentId: "ch1-s1-t1-x" },
      ],
    },
  ];
  const subjectCatalog = [{
    id: "modern-chinese",
    name: "现代汉语",
    books: [{ id: "modern-chinese-7-1" }, { id: "modern-chinese-7-2" }],
  }];

  const groups = subjectGroupsFromCatalogs(textbooks, subjectCatalog);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].subjectName, "现代汉语");
  assert.deepEqual(groups[0].books.map((book) => book.bookId), ["modern-chinese-7-1", "modern-chinese-7-2"]);

  const outline = buildSubjectCatalogOutline(groups);
  assert.equal(outline.length, 1);
  const subject = outline[0];
  assert.equal(subject.id, "subject:modern-chinese");
  assert.equal(subject.catalogNodeId, "subject:modern-chinese");
  assert.equal(subject.title, "现代汉语");
  assert.equal(subject.level, 1);
  assert.equal(subject.isSubject, true);
  // 二级＝各册顶层目录按册顺序拼接：上册的绪论/第一章在前，下册的第四章在后。
  assert.deepEqual(
    subject.sections.filter((section) => section.level === 2).map((section) => section.title),
    ["绪论", "第一章语音", "第四章语法"],
  );
  const byId = new Map(subject.sections.map((section) => [section.id, section]));
  assert.equal(byId.get("ch1").parentId, "subject:modern-chinese");
  assert.equal(byId.get("ch4").parentId, "subject:modern-chinese");
  assert.equal(byId.get("ch1-s1").parentId, "ch1");
  assert.equal(byId.get("ch1-s1").level, 3);
  assert.equal(byId.get("ch1-s1-t1").level, 4);
  assert.equal(byId.get("ch1-s1-t1-x").level, 5);
  assert.equal(byId.get("ch1-s1-t1-x-y").level, 5); // 超过 5 级不再下钻，避免越缩越小
});

test("comprehensive catalog projects cross-volume questions and still hides empty nodes", () => {
  const outline = buildSubjectCatalogOutline([{
    subjectId: "modern-chinese",
    subjectName: "现代汉语",
    books: [{
      bookId: "b1",
      nodes: [
        { id: "ch1", order: 1, level: 1, title: "第一章语音", parentId: "" },
        { id: "ch1-s1", order: 2, level: 2, title: "第一节有题", parentId: "ch1" },
        { id: "ch1-s2", order: 3, level: 2, title: "第二节没题", parentId: "ch1" },
      ],
    }, {
      bookId: "b2",
      nodes: [
        { id: "ch4", order: 1, level: 1, title: "第四章语法", parentId: "" },
        { id: "ch4-s1", order: 2, level: 2, title: "第一节语法概说", parentId: "ch4" },
      ],
    }],
  }]);
  const projected = createProjectedCatalogChapters(outline, [
    { id: "q1", catalogProjection: { anchorNodeIds: ["ch1-s1"] } },
    { id: "q2", catalogProjection: { anchorNodeIds: ["ch4-s1"] } },
    { id: "q3", catalogProjection: { anchorNodeIds: ["missing-node"] } },
  ], "q2");

  assert.deepEqual(projected.map((item) => item.id), ["subject:modern-chinese", "catalog-unassigned"]);
  const subject = projected[0];
  assert.deepEqual(subject.questionIds, ["q1", "q2"]);
  assert.equal(subject.questionCount, 2);
  assert.equal(subject.expanded, true);
  assert.equal(subject.isSubject, true);
  // 没题的第二节整支隐藏；两册的有题小节都保留在同一科目下。
  assert.deepEqual(subject.sections.map((section) => section.id), ["ch1", "ch1-s1", "ch4", "ch4-s1"]);
  const byId = new Map(subject.sections.map((section) => [section.id, section]));
  assert.deepEqual(byId.get("ch1").questionIds, ["q1"]);
  assert.deepEqual(byId.get("ch4").questionIds, ["q2"]);
  assert.deepEqual(projected[1].questionIds, ["q3"]);
});

test("comprehensive catalog keeps every subject row and counts its unassigned questions separately", () => {
  const outline = buildSubjectCatalogOutline([{
    subjectId: "modern-chinese",
    subjectName: "现代汉语",
    books: [{
      bookId: "b1",
      nodes: [
        { id: "ch1", order: 1, level: 1, title: "第一章语音", parentId: "" },
        { id: "ch1-s1", order: 2, level: 2, title: "第一节有题", parentId: "ch1" },
      ],
    }],
  }, {
    subjectId: "modern-literature",
    subjectName: "中国现代文学",
    books: [{
      bookId: "b2",
      nodes: [
        { id: "l1", order: 1, level: 1, title: "第一编", parentId: "" },
        { id: "l1-s1", order: 2, level: 2, title: "第一章", parentId: "l1" },
      ],
    }],
  }]);
  const questions = [
    { id: "q1", subjectId: "modern-chinese", catalogProjection: { anchorNodeIds: ["ch1-s1"] } },
    { id: "q2", subjectId: "modern-chinese", catalogProjection: { anchorNodeIds: [] } },
    { id: "q3", subjectId: "modern-literature", catalogProjection: { anchorNodeIds: [] } },
    { id: "q4", subjectId: "modern-literature", catalogProjection: { anchorNodeIds: ["not-in-this-catalog"] } },
    { id: "q5", catalogProjection: { anchorNodeIds: [] } },
  ];

  // 默认（单册「章节刷题」）：没题的科目整支隐藏，且不产出 pendingCount。
  const bookScoped = createProjectedCatalogChapters(outline, questions, "q1");
  assert.deepEqual(bookScoped.map((row) => row.id), ["subject:modern-chinese", "catalog-unassigned"]);
  assert.equal("pendingCount" in bookScoped[0], false);

  // 综合训练：两个科目行都留住；空科目题数如实为 0，「待归组」单独计数（不是正式题数的一部分）。
  const rows = createProjectedCatalogChapters(outline, questions, "q1", { keepEmptyChapters: true });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["subject:modern-chinese", "subject:modern-literature", "catalog-unassigned"],
  );
  const [modern, literature, unassigned] = rows;
  assert.equal(modern.questionCount, 1);
  assert.equal(modern.pendingCount, 1);
  assert.equal(modern.expanded, true);
  assert.deepEqual(modern.sections.map((section) => section.id), ["ch1", "ch1-s1"]);
  assert.equal(literature.questionCount, 0);
  assert.equal(literature.pendingCount, 2);
  assert.equal(literature.expanded, false);
  assert.deepEqual(literature.sections, []);
  // 全局「待归组」行照旧单独统计全部未投影题（含没有 subjectId 的那道），与科目行计数不重复。
  assert.deepEqual(unassigned.questionIds, ["q2", "q3", "q4", "q5"]);
});

