const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCatalogOutline, createProjectedCatalogChapters } = require("../apps/miniprogram/utils/catalog-outline");

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
