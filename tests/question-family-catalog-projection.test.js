const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildQuestionFamilyCatalogProjection,
  buildQuestionFamilyCatalogTreeSummary,
  decorateQuestionsWithFamilyCatalogProjection,
  projectionRevision,
} = require("../apps/api/src/question-family-catalog-projection");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");

test("public catalog projection only consumes confirmed topic-family memberships", () => {
  const families = [{
    id: "family-explicit",
    status: "confirmed",
    version: 2,
    updatedAt: 200,
    knowledgeNodeId: "catalog-old",
    textbookAnchorNodeIds: ["deep-new", "catalog-b"],
    members: [
      { questionId: "q1", isPrimary: true, role: "prototype", reviewStatus: "confirmed" },
      { questionId: "q2", isPrimary: false, role: "similar", reviewStatus: "confirmed" },
      { questionId: "q-awaiting-fit", isPrimary: true, role: "similar", reviewStatus: "pending_fit" },
      { questionId: "q-inactive", isPrimary: true, role: "similar", reviewStatus: "inactive" },
    ],
  }, {
    id: "family-legacy",
    status: "confirmed",
    updatedAt: 100,
    knowledgeNodeId: "deep-legacy",
    members: [{ questionId: "q3", isPrimary: true, role: "prototype" }],
  }, {
    id: "family-pending",
    status: "pending_review",
    updatedAt: 999,
    knowledgeNodeId: "catalog-old",
    members: [{ questionId: "q4", isPrimary: true, reviewStatus: "confirmed" }],
  }, {
    id: "family-pending-prototype",
    status: "confirmed",
    updatedAt: 300,
    knowledgeNodeId: "catalog-old",
    members: [
      { questionId: "q-confirmed-without-prototype", isPrimary: true, role: "similar", reviewStatus: "confirmed" },
      { questionId: "q-pending-prototype", isPrimary: false, role: "prototype", reviewStatus: "pending_fit" },
    ],
  }];
  const projection = buildQuestionFamilyCatalogProjection({
    families,
    catalogNodeIds: ["catalog-a", "catalog-b", "catalog-old"],
    knowledgeNodes: [
      { id: "catalog-a", parentId: "" },
      { id: "deep-new", parentId: "catalog-a" },
      { id: "catalog-b", parentId: "" },
      { id: "deep-legacy", parentId: "catalog-b" },
    ],
  });

  assert.deepEqual(projection.byQuestionId.q1, {
    source: "confirmed_topic_family",
    topicFamilyIds: ["family-explicit"],
    anchorNodeIds: ["catalog-a", "catalog-b"],
    sourceAnchorNodeIds: ["catalog-b", "deep-new"],
  });
  assert.deepEqual(projection.byQuestionId.q3.anchorNodeIds, ["catalog-b"]);
  assert.deepEqual(projection.byQuestionId.q3.sourceAnchorNodeIds, ["deep-legacy"]);
  assert.equal(projection.byQuestionId.q2, undefined);
  assert.equal(projection.byQuestionId.q4, undefined);
  assert.equal(projection.byQuestionId["q-awaiting-fit"], undefined);
  assert.equal(projection.byQuestionId["q-inactive"], undefined);
  assert.equal(projection.byQuestionId["q-confirmed-without-prototype"], undefined);
  assert.equal(projection.byQuestionId.q1.anchorNodeIds.includes("catalog-old"), false);

  const decorated = decorateQuestionsWithFamilyCatalogProjection([{ id: "q1" }, { id: "q4" }], projection);
  assert.equal(decorated[0].catalogProjection.source, "confirmed_topic_family");
  assert.deepEqual(decorated[1].catalogProjection.anchorNodeIds, []);
  assert.equal(decorated[1].catalogProjection.source, "unassigned");
});

test("an explicitly empty confirmed catalog produces no formal projection", () => {
  const family = {
    id: "family-orphan",
    status: "confirmed",
    textbookAnchorNodeIds: ["orphan"],
    members: [{ questionId: "q1", isPrimary: true, role: "prototype" }],
  };
  const knowledgeNodes = [{ id: "orphan", parentId: "" }];

  const validated = buildQuestionFamilyCatalogProjection({
    families: [family],
    knowledgeNodes,
    catalogNodeIds: [],
  });
  assert.deepEqual(validated.byQuestionId, {});

  const unvalidatedInternalProjection = buildQuestionFamilyCatalogProjection({
    families: [family],
    knowledgeNodes,
  });
  assert.deepEqual(unvalidatedInternalProjection.byQuestionId.q1.anchorNodeIds, ["orphan"]);
});

test("catalog validation rejects orphan anchors while preserving valid deep source anchors", () => {
  const projection = buildQuestionFamilyCatalogProjection({
    catalogNodeIds: ["catalog-root"],
    knowledgeNodes: [
      { id: "catalog-root", parentId: "" },
      { id: "deep-valid", parentId: "catalog-root" },
      { id: "orphan", parentId: "" },
    ],
    families: [{
      id: "family-valid",
      status: "confirmed",
      textbookAnchorNodeIds: ["deep-valid"],
      members: [{ questionId: "q-valid", isPrimary: true, role: "prototype" }],
    }, {
      id: "family-orphan",
      status: "confirmed",
      textbookAnchorNodeIds: ["orphan"],
      members: [{ questionId: "q-orphan", isPrimary: true, role: "prototype" }],
    }],
  });

  assert.deepEqual(projection.byQuestionId["q-valid"], {
    source: "confirmed_topic_family",
    topicFamilyIds: ["family-valid"],
    anchorNodeIds: ["catalog-root"],
    sourceAnchorNodeIds: ["deep-valid"],
  });
  assert.equal(projection.byQuestionId["q-orphan"], undefined);
});

test("catalog projection revision changes with confirmed facts and ignores pending drafts", () => {
  const confirmed = [{
    id: "family-1",
    status: "confirmed",
    updatedAt: 10,
    knowledgeNodeId: "node-1",
    members: [
      { questionId: "q1", isPrimary: true, role: "prototype", reviewStatus: "confirmed" },
      { questionId: "q-pending-a", isPrimary: true, role: "similar", reviewStatus: "pending_fit" },
    ],
  }];
  const baseline = projectionRevision(confirmed);
  assert.equal(projectionRevision([{ ...confirmed[0], updatedAt: 999, version: 99 }]), baseline);
  assert.equal(projectionRevision([...confirmed, {
    id: "draft",
    status: "pending_review",
    updatedAt: 999,
    knowledgeNodeId: "node-2",
    members: [{ questionId: "q2", isPrimary: true }],
  }]), baseline);
  assert.notEqual(projectionRevision([{ ...confirmed[0], textbookAnchorNodeIds: ["node-3"] }]), baseline);
  assert.equal(projectionRevision([{
    ...confirmed[0],
    members: [
      confirmed[0].members[0],
      { questionId: "q-pending-b", isPrimary: true, role: "similar", reviewStatus: "pending_fit" },
    ],
  }]), baseline);
  assert.equal(projectionRevision([{
    ...confirmed[0],
    members: [
      { questionId: "q1", isPrimary: true, role: "similar", reviewStatus: "confirmed" },
      { questionId: "q-pending-prototype", isPrimary: false, role: "prototype", reviewStatus: "pending_fit" },
    ],
  }]), projectionRevision([]));
  assert.notEqual(projectionRevision([{
    ...confirmed[0],
    members: [{ questionId: "q2", isPrimary: true, role: "prototype", reviewStatus: "confirmed" }],
  }]), baseline);
});

test("catalog tree summary recursively deduplicates active projected questions", () => {
  const knowledgeNodes = [
    { id: "root", parentId: "" },
    { id: "branch-a", parentId: "root" },
    { id: "leaf-a", parentId: "branch-a" },
    { id: "branch-b", parentId: "root" },
    { id: "leaf-b", parentId: "branch-b" },
  ];
  const projection = buildQuestionFamilyCatalogProjection({
    knowledgeNodes,
    catalogNodeIds: knowledgeNodes.map((node) => node.id),
    families: [{
      id: "family-a",
      status: "confirmed",
      textbookAnchorNodeIds: ["leaf-a"],
      members: [{ questionId: "q1", isPrimary: true, role: "prototype" }, { questionId: "q2", isPrimary: true, role: "similar" }],
    }, {
      id: "family-b",
      status: "confirmed",
      textbookAnchorNodeIds: ["leaf-a", "leaf-b"],
      members: [{ questionId: "q2", isPrimary: true, role: "prototype" }, { questionId: "q-related", isPrimary: false, role: "similar" }],
    }, {
      id: "family-offline",
      status: "confirmed",
      textbookAnchorNodeIds: ["leaf-b"],
      members: [{ questionId: "q-offline", isPrimary: true, role: "prototype" }],
    }, {
      id: "family-merged",
      status: "confirmed",
      textbookAnchorNodeIds: ["leaf-b"],
      members: [{ questionId: "q-merged", isPrimary: true, role: "prototype" }],
    }],
  });
  const summary = buildQuestionFamilyCatalogTreeSummary({
    projection,
    knowledgeNodes,
    activeQuestionIds: new Set(["q1", "q2"]),
  });

  assert.equal(summary.questionCount, 2);
  assert.deepEqual(summary.nodeQuestionCounts, {
    "leaf-a": 2,
    "branch-a": 2,
    root: 2,
    "leaf-b": 1,
    "branch-b": 1,
  });
  assert.deepEqual(buildQuestionFamilyCatalogTreeSummary({
    projection,
    knowledgeNodes,
    activeQuestionIds: new Set(),
  }), { questionCount: 0, nodeQuestionCounts: {} });
});

test("public question API exposes the projection and invalidates its ETag after family review changes", async (context) => {
  const questionStore = createMemoryQuestionStore([]);
  const question = (id) => questionStore.create({
    id,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "知识标签不参与目录",
    knowledgePoints: ["同名旧知识点"],
    type: "single_choice",
    stem: `${id} 的题干`,
    options: [{ key: "A", text: "选项" }, { key: "B", text: "干扰项" }],
    correctAnswer: ["A"],
    referenceAnswer: "参考答案",
    maxScore: 1,
  });
  const q1 = question("catalog-api-q1");
  const q2 = question("catalog-api-q2");
  const q3 = question("catalog-api-singleton-pending-fit");
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: q1.bookId,
    catalogNodes: [
      { id: "catalog-anchor", level: 1, title: "测试目录", startPage: 1, endPage: 10 },
      { id: "other-anchor", level: 1, title: "另一目录", startPage: 11, endPage: 20 },
    ],
    outlineNodes: [],
    chunks: [],
    questions: [q1, q2, q3],
  });
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft(q1.bookId, [
    { id: "catalog-anchor", level: 1, title: "测试目录", startPage: 1, endPage: 10 },
    { id: "other-anchor", level: 1, title: "另一目录", startPage: 11, endPage: 20 },
  ]);
  textbookCatalogStore.confirm(q1.bookId, "目录审核员");
  const questionFamilyStore = createMemoryQuestionFamilyStore({
    version: 2,
    familySets: [],
    familySetLinks: [],
    families: [{
      id: "catalog-api-family",
      bookId: q1.bookId,
      knowledgeNodeId: "legacy-anchor",
      coreKnowledgeNodeId: "core-knowledge",
      textbookAnchorNodeIds: ["catalog-anchor"],
      name: "测试主题族",
      focusKey: "测试主题族",
      status: "confirmed",
      members: [
        { questionId: q1.id, isPrimary: true, role: "prototype", reviewStatus: "confirmed" },
        { questionId: q2.id, isPrimary: true, role: "similar", reviewStatus: "pending_fit" },
      ],
      updatedAt: 100,
    }, {
      id: "catalog-api-other-family",
      bookId: q1.bookId,
      knowledgeNodeId: "other-anchor",
      name: "另一主题族",
      focusKey: "另一主题族",
      status: "confirmed",
      members: [{ questionId: q2.id, isPrimary: true, role: "prototype", reviewStatus: "confirmed" }],
      updatedAt: 90,
    }, {
      id: "catalog-api-singleton-family",
      bookId: q1.bookId,
      knowledgeNodeId: "catalog-anchor",
      textbookAnchorNodeIds: ["catalog-anchor"],
      name: "单题题族",
      focusKey: "单题题族",
      status: "confirmed",
      members: [{ questionId: q3.id, isPrimary: true, role: "prototype", reviewStatus: "pending_fit" }],
      updatedAt: 80,
    }],
  });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore,
    questionFamilyStore,
    textbookCatalogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/questions?library=official&bookId=${q1.bookId}`;

  const firstResponse = await fetch(endpoint);
  const first = await firstResponse.json();
  const byId = new Map(first.questions.map((item) => [item.id, item]));
  assert.deepEqual(byId.get(q1.id).catalogProjection.anchorNodeIds, ["catalog-anchor"]);
  assert.equal(byId.get(q1.id).catalogProjection.source, "confirmed_topic_family");
  assert.deepEqual(byId.get(q2.id).catalogProjection.anchorNodeIds, ["other-anchor"]);
  assert.equal(byId.get(q3.id).catalogProjection.source, "unassigned");
  const firstEtag = firstResponse.headers.get("etag");

  questionFamilyStore.review("catalog-api-family", { status: "pending_review" }, "审核员");
  const secondResponse = await fetch(endpoint, { headers: { "If-None-Match": firstEtag } });
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  assert.notEqual(secondResponse.headers.get("etag"), firstEtag);
  assert.equal(second.questions.find((item) => item.id === q1.id).catalogProjection.source, "unassigned");
});
