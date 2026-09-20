const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const {
  createMemoryClassificationGoldReviewStore,
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
} = require("../apps/api/src/classification-gold-review-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createServer } = require("./helpers/admin-auth");

function question() {
  return {
    id: "q-missing-membership",
    version: 3,
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第二章 语音 > 辅音与声母",
    type: "single_choice",
    typeLabel: "单选题",
    stem: "下列说法正确的是（ ）。",
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
    correctAnswer: ["A"],
    referenceAnswer: "A 正确。",
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    answerVerified: true,
    maxScore: 1,
  };
}

function answerKnowledge(bookId) {
  const node = { id: "node-core", title: "清浊音", path: "语音 > 清浊音" };
  return {
    correctAnswer: ["A"],
    referenceAnswer: "A 正确。",
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    textbookEvidence: [{
      chunkId: "chunk-1",
      bookId,
      catalogPath: "第二章 语音 > 辅音与声母",
      printedPageStart: 30,
      excerpt: "教材原文证据。",
    }],
    coreKnowledge: node,
    requiredKnowledge: [node],
    optionKnowledge: [
      { key: "A", text: "甲", role: "answer", knowledgeRelation: "question_only" },
      { key: "B", text: "乙", role: "distractor", knowledgeRelation: "question_only" },
    ],
  };
}

function family() {
  return {
    id: "family-missing-membership",
    version: 1,
    status: "confirmed",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    name: "清浊音题族",
    focusKey: "voicing",
    coreKnowledgeNodeId: "node-core",
    requiredKnowledgeNodeIds: ["node-core"],
    textbookAnchorNodeIds: ["node-core"],
    assessmentAction: "判断声带是否振动",
    members: [],
    memberQuestionIds: [],
    independentMemberQuestionIds: [],
    independentMemberCount: 0,
  };
}

function request(baseUrl, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body
      ? { "content-type": "application/json", ...(options.headers || {}) }
      : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (response) => ({ response, body: await response.json() }));
}

function stableFamily(value) {
  return {
    id: value.id,
    version: value.version,
    subjectId: value.subjectId,
    bookId: value.bookId,
    name: value.name,
    focusKey: value.focusKey,
    status: value.status,
    coreKnowledgeNodeId: value.coreKnowledgeNodeId,
    requiredKnowledgeNodeIds: value.requiredKnowledgeNodeIds,
    textbookAnchorNodeIds: value.textbookAnchorNodeIds,
    assessmentAction: value.assessmentAction,
    inclusionBoundary: value.inclusionBoundary,
    exclusionBoundary: value.exclusionBoundary,
    memberQuestionIds: value.memberQuestionIds,
    independentMemberQuestionIds: value.independentMemberQuestionIds,
    independentMemberCount: value.independentMemberCount,
    members: value.members,
  };
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gold-family-contribution-regression-"));
  const snapshotDir = path.join(root, "snapshots");
  const q = question();
  const formalFamily = family();
  const answer = answerKnowledge(q.bookId);
  const familyGold = {
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
    replayMode: "mature",
    decision: "join_existing",
    primaryFamilyId: formalFamily.id,
    relatedFamilyIds: [],
    relatedFamilyRelations: [],
    families: [formalFamily],
    reason: "regression fixture",
  };
  const classificationGoldReviewStore = createMemoryClassificationGoldReviewStore({}, { snapshotDir });
  classificationGoldReviewStore.importBatch({
    id: "gold-family-contribution-v2",
    title: "贡献回归",
    version: "V2",
    source: { parentSnapshotId: "frozen-parent-v1" },
    items: [{
      questionId: q.id,
      order: 1,
      question: q,
      sourceMode: "mature",
      answerKnowledge: answer,
      familyGold,
      contentReview: { result: "confirmed", reviewer: "fixture" },
      familyReview: { result: "pending_review" },
    }],
  });
  const questionStore = createMemoryQuestionStore([q]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: q.bookId,
    catalogNodes: [
      { id: "chapter", level: 1, title: "第二章 语音" },
      { id: "section", level: 2, title: "辅音与声母" },
      { id: "node-core", level: 3, title: "清浊音" },
    ],
    chunks: [],
    questions: [q],
  });
  knowledgeStructureStore.assignQuestions(q.bookId, [{
    questionId: q.id,
    primaryNodeId: "node-core",
    requiredNodeIds: ["node-core"],
  }]);
  const questionFamilyStore = createMemoryQuestionFamilyStore({
    version: 4,
    families: [formalFamily],
    familySets: [],
    familySetLinks: [],
  });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    classificationGoldReviewStore,
    questionStore,
    questionFamilyStore,
    knowledgeStructureStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    root,
    snapshotDir,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    q,
    formalFamily,
    answer,
    classificationGoldReviewStore,
    questionFamilyStore,
  };
}

async function createParentCoverageFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gold-family-parent-coverage-"));
  const snapshotDir = path.join(root, "snapshots");
  const q = {
    ...question(),
    id: "q-parent-coverage",
    chapter: "第二章 语音 > 辅音与声母",
  };
  const parentId = "node-family-parent";
  const childId = "node-answer-child";
  const answer = answerKnowledge(q.bookId);
  answer.coreKnowledge = { id: childId, title: "清浊音", path: "语音 > 发音特征 > 清浊音" };
  answer.requiredKnowledge = [answer.coreKnowledge];
  const formalFamily = {
    id: "family-parent-coverage",
    version: 1,
    status: "confirmed",
    subjectId: q.subjectId,
    bookId: q.bookId,
    name: "发音特征题族",
    focusKey: "voicing",
    coreKnowledgeNodeId: parentId,
    requiredKnowledgeNodeIds: [parentId],
    textbookAnchorNodeIds: [parentId],
    assessmentAction: "判断声带是否振动",
    members: [{
      questionId: q.id,
      isPrimary: true,
      role: "prototype",
      trainingLevel: "foundation",
      action: "判断声带是否振动",
      variationDimensions: [],
      confidence: 1,
      reason: "fixture",
      reviewStatus: "confirmed",
    }],
    memberQuestionIds: [q.id],
    independentMemberQuestionIds: [q.id],
    independentMemberCount: 1,
  };
  const familyGold = {
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
    replayMode: "singleton",
    decision: "join_existing",
    primaryFamilyId: formalFamily.id,
    relatedFamilyIds: [],
    relatedFamilyRelations: [],
    families: [formalFamily],
    reason: "regression fixture",
  };
  const classificationGoldReviewStore = createMemoryClassificationGoldReviewStore({}, { snapshotDir });
  classificationGoldReviewStore.importBatch({
    id: "gold-family-parent-coverage-v2",
    title: "父节点覆盖回归",
    version: "V2",
    source: { parentSnapshotId: "frozen-parent-v1" },
    items: [{
      questionId: q.id,
      order: 1,
      question: q,
      sourceMode: "singleton",
      answerKnowledge: answer,
      familyGold,
      contentReview: { result: "confirmed", reviewer: "fixture" },
      familyReview: { result: "pending_review" },
    }],
  });
  const questionStore = createMemoryQuestionStore([q]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: q.bookId,
    catalogNodes: [
      { id: "chapter-parent", level: 1, title: "第二章 语音" },
      { id: "section-parent", level: 2, title: "辅音与声母" },
      { id: parentId, level: 3, title: "发音特征" },
      { id: childId, level: 4, title: "清浊音" },
    ],
    chunks: [],
    questions: [q],
  });
  knowledgeStructureStore.assignQuestions(q.bookId, [{
    questionId: q.id,
    primaryNodeId: childId,
    requiredNodeIds: [childId],
  }]);
  const questionFamilyStore = createMemoryQuestionFamilyStore({
    version: 4,
    families: [formalFamily],
    familySets: [],
    familySetLinks: [],
  });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    classificationGoldReviewStore,
    questionStore,
    questionFamilyStore,
    knowledgeStructureStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    root,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    q,
    parentId,
    childId,
    formalFamily,
    questionFamilyStore,
    classificationGoldReviewStore,
  };
}

test("missing formal membership keeps submitted contribution visible without changing formal data", async () => {
  const fixture = await createFixture();
  try {
    const options = await request(
      fixture.baseUrl,
      "/api/admin/question-family-options?bookId=modern-chinese-7-1",
    );
    assert.equal(options.response.status, 200, JSON.stringify(options.body));
    const option = options.body.families.find((entry) => entry.id === fixture.formalFamily.id);
    assert.ok(option);

    const submittedFamily = {
      ...option,
      membership: {
        questionId: fixture.q.id,
        isPrimary: true,
        role: "prototype",
        reviewStatus: "confirmed",
        contributionKnowledgeNodeIds: ["node-core"],
        contributionKnowledgeLabels: ["清浊音"],
      },
    };
    const familyGold = {
      familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
      replayMode: "mature",
      decision: "join_existing",
      primaryFamilyId: fixture.formalFamily.id,
      relatedFamilyIds: [],
      relatedFamilyRelations: [],
      families: [submittedFamily],
      reason: "manual contribution",
    };
    const beforeFormalFamily = stableFamily(fixture.questionFamilyStore.get(fixture.formalFamily.id));
    const result = await request(
      fixture.baseUrl,
      `/api/admin/knowledge-classification/gold-review/sets/gold-family-contribution-v2/items/${fixture.q.id}/family`,
      {
        method: "PUT",
        body: {
          expectedRevision: 1,
          result: "corrected",
          note: "manual contribution",
          familyGold,
        },
      },
    );

    assert.equal(result.response.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.error, "classification_gold_review_family_semantic_invalid");
    const issues = result.body.details.issues || [];
    assert.ok(issues.some((issue) => issue.code === "family_membership_missing"));
    assert.equal(
      issues.some((issue) => issue.code === "required_family_no_knowledge_contribution"),
      false,
      JSON.stringify(issues),
    );
    assert.deepEqual(stableFamily(fixture.questionFamilyStore.get(fixture.formalFamily.id)), beforeFormalFamily);
    assert.equal(
      fixture.classificationGoldReviewStore.get("gold-family-contribution-v2").items[0].familyReview.result,
      "pending_review",
    );
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// DEC-039 / 产品手册 4.11、5.8.12：成员贡献知识必须“同时属于题目最小充分知识集与
// 各自题族覆盖知识”，父子、祖先、同章或共同范围锚点关系均不能替代这一交集校验。
// 因此题族只声明父节点覆盖知识时，叶节点贡献必须被拒绝，而不是被祖先关系放行。
test("V3 rejects a child contribution that is outside the declared family coverage", async () => {
  const fixture = await createParentCoverageFixture();
  try {
    const options = await request(
      fixture.baseUrl,
      "/api/admin/question-family-options?bookId=modern-chinese-7-1",
    );
    assert.equal(options.response.status, 200, JSON.stringify(options.body));
    const option = options.body.families.find((entry) => entry.id === fixture.formalFamily.id);
    assert.ok(option);
    assert.equal(option.requiredKnowledge[0].id, fixture.parentId);
    assert.match(option.requiredKnowledge[0].path, /发音特征/);

    const submittedFamily = {
      ...option,
      membership: {
        questionId: fixture.q.id,
        isPrimary: true,
        role: "prototype",
        reviewStatus: "confirmed",
        contributionKnowledgeNodeIds: [fixture.childId],
        contributionKnowledgeLabels: ["清浊音"],
      },
    };
    const familyGold = {
      familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
      replayMode: "singleton",
      decision: "join_existing",
      primaryFamilyId: fixture.formalFamily.id,
      relatedFamilyIds: [],
      relatedFamilyRelations: [],
      families: [submittedFamily],
      reason: "parent-only family coverage",
    };
    const beforeFormalFamily = stableFamily(fixture.questionFamilyStore.get(fixture.formalFamily.id));
    const result = await request(
      fixture.baseUrl,
      `/api/admin/knowledge-classification/gold-review/sets/gold-family-parent-coverage-v2/items/${fixture.q.id}/family`,
      {
        method: "PUT",
        body: {
          expectedRevision: 1,
          result: "corrected",
          note: "叶节点贡献不在题族覆盖知识内。",
          familyGold,
        },
      },
    );

    assert.equal(result.response.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.error, "classification_gold_review_family_semantic_invalid");
    const issue = (result.body.details.issues || [])
      .find((entry) => entry.code === "required_family_no_knowledge_contribution");
    assert.ok(issue, JSON.stringify(result.body.details.issues));
    assert.deepEqual(
      (issue.actual.outsideFamilyCoverage || []).map((node) => node.id),
      [fixture.childId],
    );
    assert.deepEqual(
      (issue.expected.familyCoverageKnowledge || []).map((node) => node.id),
      [fixture.parentId],
    );
    assert.deepEqual(
      stableFamily(fixture.questionFamilyStore.get(fixture.formalFamily.id)),
      beforeFormalFamily,
    );
    assert.equal(
      fixture.classificationGoldReviewStore.get("gold-family-parent-coverage-v2").items[0].familyReview.result,
      "pending_review",
    );
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
