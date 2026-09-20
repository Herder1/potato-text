const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const {
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  createMemoryClassificationGoldReviewStore,
} = require("../apps/api/src/classification-gold-review-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createServer } = require("./helpers/admin-auth");

function answerKnowledge(correctAnswer = "A") {
  return {
    correctAnswer: [correctAnswer],
    referenceAnswer: `${correctAnswer} 正确。`,
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    textbookEvidence: [{
      chunkId: "chunk-1",
      bookId: "modern-chinese-7-1",
      catalogPath: "第二章 语音 > 辅音与声母",
      printedPageStart: 30,
      excerpt: "教材原文证据。",
    }],
    coreKnowledge: { id: "node-core", title: "清浊音", path: "语音 > 清浊音" },
    requiredKnowledge: [{ id: "node-core", title: "清浊音", path: "语音 > 清浊音" }],
    optionKnowledge: [
      { key: "A", text: "甲", knowledgeLabels: ["清浊音"], role: "answer" },
      { key: "B", text: "乙", knowledgeLabels: ["送气强弱"], role: "distractor" },
    ],
  };
}

function reviewedAnswerKnowledge(correctAnswer = "A") {
  const answer = answerKnowledge(correctAnswer);
  return {
    ...answer,
    optionKnowledge: answer.optionKnowledge.map((option, index) => ({
      ...option,
      knowledgeRelation: "option_specific",
      knowledgeNodeIds: [index ? "node-option-b" : "node-core"],
    })),
  };
}

function familyGold() {
  return {
    replayMode: "mature",
    decision: "join_existing",
    primaryFamilyId: "family-1",
    families: [{
      id: "family-1",
      name: "声母发音方法·声带振动",
      focusKey: "consonant-voicing-judgment",
      bookId: "modern-chinese-7-1",
      coreKnowledgeNodeId: "node-core",
      requiredKnowledgeNodeIds: ["node-core"],
      textbookAnchorNodeIds: ["node-core"],
      assessmentAction: "判断声带是否振动",
      inclusionBoundary: "直接判断清浊音",
      exclusionBoundary: "不含送气强弱",
      independentMemberCount: 2,
      memberQuestionIds: ["q-1", "q-other"],
      independentMemberQuestionIds: ["q-1", "q-other"],
      retainedIndependentMemberQuestionIds: ["q-other"],
    }],
  };
}

function v2FamilyGold(value = {}) {
  return {
    ...value,
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  };
}

function unmatchedFamilyGold(questionId = "q-mode") {
  return {
    replayMode: "unmatched",
    decision: "create_new",
    primaryFamilyId: "",
    relatedFamilyIds: [],
    families: [],
    candidateFamily: {
      name: "清浊音综合判断",
      focusKey: "consonant-voicing-composite-judgment",
      bookId: "modern-chinese-7-1",
      coreKnowledge: { id: "node-core", title: "清浊音", path: "语音 > 清浊音" },
      coreKnowledgeNodeId: "node-core",
      requiredKnowledge: [{ id: "node-core", title: "清浊音", path: "语音 > 清浊音" }],
      requiredKnowledgeNodeIds: ["node-core"],
      textbookAnchors: [{ id: "node-core", title: "清浊音", path: "语音 > 清浊音" }],
      textbookAnchorNodeIds: ["node-core"],
      assessmentAction: "判断声带是否振动",
      inclusionBoundary: "直接判断清浊音",
      exclusionBoundary: "不含送气强弱",
      membership: {
        questionId,
        contributionKnowledgeNodeIds: ["node-core"],
      },
    },
    reason: "当前没有语义兼容的已确认题族。",
  };
}

function reviewItem(questionId) {
  return {
    questionId,
    mode: "mature",
    question: {
      id: questionId,
      version: 3,
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      chapter: "第二章 语音 > 辅音与声母",
      primaryKnowledgePoint: "清浊音",
      knowledgePoints: ["清浊音"],
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
    },
    answerKnowledge: answerKnowledge(),
    familyGold: familyGold(),
    aiCandidates: {
      basedOnQuestionVersion: 3,
      content: {
        optionKnowledge: [{ key: "A", text: "甲", knowledgeLabels: ["AI候选知识"], role: "answer" }],
        reason: "Agent 3 内容候选",
      },
      family: {
        replayMode: "mature",
        decision: "join_existing",
        primaryFamilyId: "family-1",
        families: familyGold().families,
        reason: "Agent 3 题族候选",
      },
    },
  };
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { response, body: await response.json() };
}

test("gold review API enforces staged review and freezes without starting blind replay", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classification-gold-api-"));
  const snapshotDir = path.join(root, "snapshots");
  const classificationGoldReviewStore = createMemoryClassificationGoldReviewStore({}, { snapshotDir });
  classificationGoldReviewStore.importBatch({
    id: "review-batch-v1",
    title: "20题盲测金标集V1",
    version: "V1",
    source: { batchId: "blind-batch-source" },
    items: [reviewItem("q-1"), reviewItem("q-2")],
  });
  const formalQuestions = [reviewItem("q-1").question, reviewItem("q-2").question];
  const questionStore = createMemoryQuestionStore(formalQuestions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "consonants", level: 2, title: "第三节 辅音与声母", startPage: 35, endPage: 50 },
      { id: "method", level: 3, title: "一、辅音的发音方法", startPage: 36, endPage: 42 },
      { id: "node-core", level: 4, title: "（二）看声带是否振动", startPage: 39, endPage: 40 },
    ],
    chunks: [],
    questions: formalQuestions,
  });
  knowledgeStructureStore.assignQuestions("modern-chinese-7-1", formalQuestions.map((question) => ({
    questionId: question.id,
    primaryNodeId: "node-core",
    requiredNodeIds: ["node-core"],
  })));
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    classificationGoldReviewStore,
    questionStore,
    knowledgeStructureStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.readdirSync(snapshotDir).forEach((name) => {
        try { fs.chmodSync(path.join(snapshotDir, name), 0o600); } catch (_error) { /* already gone */ }
      });
    } catch (_error) { /* no snapshot */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const listing = await request(baseUrl, "/api/admin/knowledge-classification/gold-review/sets");
  assert.equal(listing.response.status, 200);
  assert.equal(listing.body.sets.length, 1);
  assert.equal(listing.body.sets[0].summary.pending, 2);
  assert.equal(Object.hasOwn(listing.body.sets[0], "items"), false);

  const detail = await request(baseUrl, "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1");
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.batch.items.length, 2);
  assert.equal(detail.body.batch.items[0].businessSync.status, "synced");
  assert.equal(detail.body.batch.items[0].businessSync.formalQuestionVersion, 3);
  assert.equal(detail.body.batch.items[0].aiComparison.content.revealed, false);
  assert.equal(detail.body.batch.items[0].aiComparison.content.candidate, null);
  assert.equal(detail.body.batch.items[0].aiComparison.family.revealed, false);
  assert.equal(Object.hasOwn(detail.body.batch.items[0], "aiCandidates"), false);
  assert.deepEqual(
    detail.body.batch.items[0].answerKnowledge.optionKnowledge.map((option) => option.knowledgeRelation),
    ["unreviewed", "unreviewed"],
  );

  const prematureFamily = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-1/family",
    { method: "PUT", body: { expectedRevision: 1, result: "confirmed_current", familyGold: familyGold() } },
  );
  assert.equal(prematureFamily.response.status, 409);
  assert.equal(prematureFamily.body.error, "classification_gold_review_content_first");

  const bypassCorrection = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-1/content",
    {
      method: "PUT",
      body: {
        expectedRevision: 1,
        result: "corrected",
        note: "试图绕过正式题目同步。",
        answerKnowledge: answerKnowledge("B"),
      },
    },
  );
  assert.equal(bypassCorrection.response.status, 409);
  assert.equal(bypassCorrection.body.error, "classification_gold_review_business_sync_required");

  const missingHumanEvidenceSelection = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-1/content",
    { method: "PUT", body: {
      expectedRevision: 1,
      result: "confirmed_current",
      answerKnowledge: reviewedAnswerKnowledge(),
    } },
  );
  assert.equal(missingHumanEvidenceSelection.response.status, 422);
  assert.equal(missingHumanEvidenceSelection.body.error, "classification_gold_review_human_evidence_required");

  const q1Content = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-1/content",
    { method: "PUT", body: {
      expectedRevision: 1,
      result: "confirmed_current",
      answerKnowledge: reviewedAnswerKnowledge(),
      selectedEvidenceChunkIds: ["chunk-1"],
    } },
  );
  assert.equal(q1Content.response.status, 200);
  assert.equal(q1Content.body.item.contentReview.result, "confirmed");
  assert.equal(q1Content.body.item.familyReview.result, "pending_review");
  assert.equal(q1Content.body.item.aiComparison.content.revealed, true);
  assert.equal(q1Content.body.item.aiComparison.content.candidate.reason, undefined);
  assert.equal(q1Content.body.item.aiComparison.family.revealed, false);
  assert.equal(JSON.stringify(q1Content.body.item).includes("Agent 3 内容候选"), false);
  assert.equal(JSON.stringify(q1Content.body.item).includes("Agent 3 题族候选"), false);
  assert.equal(q1Content.body.item.answerKnowledge.textbookEvidence[0].candidateOnly, false);
  assert.equal(q1Content.body.item.answerKnowledge.textbookEvidence[0].humanSelection.status, "selected");

  const q1Family = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-1/family",
    { method: "PUT", body: { expectedRevision: 2, result: "confirmed_current", familyGold: familyGold() } },
  );
  assert.equal(q1Family.response.status, 200);
  assert.equal(q1Family.body.item.familyReview.result, "confirmed");
  assert.equal(q1Family.body.item.aiComparison.family.revealed, true);
  assert.equal(q1Family.body.item.aiComparison.family.candidate.reason, "Agent 3 题族候选");

  const q1Correction = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-1/content",
    {
      method: "PUT",
      body: {
        expectedRevision: 3,
        result: "confirmed_current",
        answerKnowledge: reviewedAnswerKnowledge(),
        selectedEvidenceChunkIds: ["chunk-1"],
      },
    },
  );
  assert.equal(q1Correction.response.status, 200);
  assert.equal(q1Correction.body.item.answerKnowledge.correctAnswer[0], "A");
  assert.equal(q1Correction.body.item.familyReview.result, "pending_review");

  const incompleteFreeze = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/freeze/prepare",
    { method: "POST", body: {} },
  );
  assert.equal(incompleteFreeze.response.status, 409);
  assert.equal(incompleteFreeze.body.error, "classification_gold_review_incomplete");

  const q1FamilyAfterCorrection = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-1/family",
    { method: "PUT", body: { expectedRevision: 4, result: "confirmed_current", familyGold: familyGold() } },
  );
  assert.equal(q1FamilyAfterCorrection.response.status, 200);

  const q2Content = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-2/content",
    { method: "PUT", body: {
      expectedRevision: 1,
      result: "confirmed_current",
      answerKnowledge: reviewedAnswerKnowledge(),
      selectedEvidenceChunkIds: ["chunk-1"],
    } },
  );
  assert.equal(q2Content.response.status, 200);
  const q2Family = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/items/q-2/family",
    { method: "PUT", body: { expectedRevision: 2, result: "confirmed_current", familyGold: familyGold() } },
  );
  assert.equal(q2Family.response.status, 200);

  const prepared = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/freeze/prepare",
    { method: "POST", body: {} },
  );
  assert.equal(prepared.response.status, 200);
  assert.equal(prepared.body.snapshotWritten, false);
  assert.equal(prepared.body.blindReplayStarted, false);
  assert.match(prepared.body.preparation.token, /^[a-f0-9]{64}$/);
  assert.match(prepared.body.preparation.fileSha256, /^[a-f0-9]{64}$/);
  assert.match(prepared.body.preparation.contentSha256, /^[a-f0-9]{64}$/);

  const wrongToken = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/freeze/commit",
    { method: "POST", body: { token: "wrong-token" } },
  );
  assert.equal(wrongToken.response.status, 409);
  assert.equal(wrongToken.body.error, "classification_gold_review_prepare_token_invalid");

  const frozen = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/freeze/commit",
    { method: "POST", body: { token: prepared.body.preparation.token } },
  );
  assert.equal(frozen.response.status, 200);
  assert.equal(frozen.body.blindReplayStarted, false);
  assert.equal(frozen.body.snapshotWritten, true);
  assert.equal(frozen.body.summary.readyToFreeze, true);
  assert.equal(frozen.body.snapshot.fileSha256, prepared.body.preparation.fileSha256);
  assert.equal(frozen.body.snapshot.contentSha256, prepared.body.preparation.contentSha256);
});

test("V2 family review keeps a manually submitted contribution when the historical membership is empty", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classification-gold-manual-contribution-api-"));
  const snapshotDir = path.join(root, "snapshots");
  const classificationGoldReviewStore = createMemoryClassificationGoldReviewStore({}, { snapshotDir });
  const primaryQuestion = reviewItem("q-manual-contribution").question;
  const peerQuestion = reviewItem("q-manual-contribution-peer").question;
  const formalQuestions = [primaryQuestion, peerQuestion];
  const questionStore = createMemoryQuestionStore(formalQuestions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "consonants", level: 2, title: "第三节 辅音与声母", startPage: 35, endPage: 50 },
      { id: "method", level: 3, title: "一、辅音的发音方法", startPage: 36, endPage: 42 },
      { id: "node-core", level: 4, title: "（二）看声带是否振动", startPage: 39, endPage: 40 },
    ],
    chunks: [],
    questions: formalQuestions,
  });
  knowledgeStructureStore.assignQuestions("modern-chinese-7-1", formalQuestions.map((question) => ({
    questionId: question.id,
    primaryNodeId: "node-core",
    requiredNodeIds: ["node-core"],
  })));

  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const family = questionFamilyStore.create({
    id: "family-manual-contribution",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    name: "声母发音方法·声带振动",
    focusKey: "consonant-voicing-judgment",
    primaryKnowledgePoint: "清浊音",
    knowledgeNodeId: "node-core",
    coreKnowledgeNodeId: "node-core",
    requiredKnowledgeNodeIds: ["node-core"],
    textbookAnchorNodeIds: ["node-core"],
    assessmentAction: "判断声带是否振动",
  });
  const added = questionFamilyStore.addMembers(family.id, formalQuestions, "教研员", {
    contributionKnowledgeNodeIdsByQuestion: Object.fromEntries(
      formalQuestions.map((question) => [question.id, ["node-core"]]),
    ),
  }).family;
  const confirmedMembers = added.members.map((member) => ({
    ...member,
    reviewStatus: "confirmed",
  }));
  questionFamilyStore.review(family.id, { status: "confirmed", members: confirmedMembers }, "教研员");
  const currentFamily = questionFamilyStore.get(family.id);
  const currentMembership = currentFamily.members.find((member) => member.questionId === primaryQuestion.id);

  // The V2 item deliberately mirrors a legacy frozen snapshot: its family
  // fact has no inline membership. The family PUT below supplies the
  // reviewer-selected contribution explicitly.
  const historicalFamily = {
    ...currentFamily,
    membership: null,
  };
  classificationGoldReviewStore.importBatch({
    id: "manual-contribution-v2",
    title: "人工贡献回归批次",
    version: "V2",
    source: { parentSnapshotId: "parent-snapshot-v1" },
    items: [{
      ...reviewItem(primaryQuestion.id),
      order: 1,
      question: primaryQuestion,
      answerKnowledge: reviewedAnswerKnowledge(),
      familyGold: v2FamilyGold({
        replayMode: "mature",
        decision: "join_existing",
        primaryFamilyId: family.id,
        relatedFamilyIds: [],
        relatedFamilyRelations: [],
        families: [historicalFamily],
      }),
      aiCandidates: undefined,
    }],
  });
  const imported = classificationGoldReviewStore.get("manual-contribution-v2");
  const importedItem = imported.items[0];
  const content = classificationGoldReviewStore.reviewContent("manual-contribution-v2", primaryQuestion.id, {
    expectedRevision: importedItem.revision,
    result: "confirmed",
    answerKnowledge: importedItem.answerKnowledge,
    reviewer: "V2审核员",
  });

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    classificationGoldReviewStore,
    questionStore,
    questionFamilyStore,
    knowledgeStructureStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.readdirSync(snapshotDir).forEach((name) => {
        try { fs.chmodSync(path.join(snapshotDir, name), 0o600); } catch (_error) { /* already gone */ }
      });
    } catch (_error) { /* no snapshot */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const familyPayload = {
    ...content.item.familyGold,
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
    families: [{
      ...content.item.familyGold.families[0],
      ...currentFamily,
      membership: {
        ...currentMembership,
        questionId: primaryQuestion.id,
        revision: questionFamilyStore.membershipRevisions([primaryQuestion.id])[primaryQuestion.id],
        contributionKnowledgeNodeIds: ["node-core"],
      },
    }],
  };
  const response = await request(
    baseUrl,
    `/api/admin/knowledge-classification/gold-review/sets/manual-contribution-v2/items/${primaryQuestion.id}/family`,
    {
      method: "PUT",
      body: {
        expectedRevision: content.item.revision,
        result: "confirmed",
        familyGold: familyPayload,
      },
    },
  );
  assert.equal(response.response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(
    response.body.item.familyGold.families[0].membership.contributionKnowledgeNodeIds,
    ["node-core"],
  );
});

test("gold review API creates a V2 revision from frozen facts and idempotently appends preflight reviews", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classification-gold-revision-api-"));
  const snapshotDir = path.join(root, "snapshots");
  const classificationGoldReviewStore = createMemoryClassificationGoldReviewStore({}, { snapshotDir });
  const formalQuestions = [reviewItem("q-1").question, reviewItem("q-2").question];
  const questionStore = createMemoryQuestionStore(formalQuestions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "consonants", level: 2, title: "第三节 辅音与声母", startPage: 35, endPage: 50 },
      { id: "method", level: 3, title: "一、辅音的发音方法", startPage: 36, endPage: 42 },
      { id: "node-core", level: 4, title: "（二）看声带是否振动", startPage: 39, endPage: 40 },
    ],
    chunks: [],
    questions: formalQuestions,
  });
  knowledgeStructureStore.assignQuestions("modern-chinese-7-1", formalQuestions.map((question) => ({
    questionId: question.id,
    primaryNodeId: "node-core",
    requiredNodeIds: ["node-core"],
  })));
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const family = questionFamilyStore.create({
    id: "family-1",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    name: "声母发音方法·声带振动",
    focusKey: "声母发音方法·声带振动",
    primaryKnowledgePoint: "清浊音",
    knowledgeNodeId: "node-core",
    coreKnowledgeNodeId: "node-core",
    requiredKnowledgeNodeIds: ["node-core"],
    textbookAnchorNodeIds: ["node-core"],
    assessmentAction: "判断声带是否振动",
  });
  const added = questionFamilyStore.addMembers(family.id, formalQuestions, "教研员", {
    contributionKnowledgeNodeIdsByQuestion: Object.fromEntries(
      formalQuestions.map((question) => [question.id, ["node-core"]]),
    ),
  }).family;
  questionFamilyStore.review(family.id, { status: "confirmed", members: added.members }, "教研员");
  const goldFamilyFor = (questionId) => ({
    ...familyGold(),
    primaryFamilyId: family.id,
    families: [{
      ...familyGold().families[0],
      id: family.id,
      memberQuestionIds: formalQuestions.map((question) => question.id),
      independentMemberQuestionIds: formalQuestions.map((question) => question.id),
      independentMemberCount: 2,
      retainedIndependentMemberQuestionIds: formalQuestions
        .map((question) => question.id).filter((id) => id !== questionId),
    }],
  });
  const reviewItems = formalQuestions.map((question) => ({
    ...reviewItem(question.id),
    familyGold: goldFamilyFor(question.id),
    aiCandidates: undefined,
  }));
  classificationGoldReviewStore.importBatch({
    id: "review-batch-v1",
    title: "20题盲测金标集V1",
    version: "V1",
    source: { batchId: "blind-batch-source" },
    items: reviewItems,
  });
  reviewItems.forEach((item) => {
    const content = classificationGoldReviewStore.reviewContent("review-batch-v1", item.questionId, {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item.answerKnowledge,
      reviewer: "V1审核员",
    });
    classificationGoldReviewStore.reviewFamily("review-batch-v1", item.questionId, {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: item.familyGold,
      reviewer: "V1审核员",
    });
  });
  const prepared = classificationGoldReviewStore.prepareFreeze("review-batch-v1", { reviewer: "V1审核员" });
  const parent = classificationGoldReviewStore.commitFreeze("review-batch-v1", {
    token: prepared.preparation.token,
    reviewer: "V1审核员",
  });
  questionStore.update("q-2", {
    ...questionStore.get("q-2"),
    referenceAnswer: "A 正确。正式题目在 V1 冻结后产生了新版本。",
    changeNote: "模拟 V2 形成前的正式题目漂移",
  }, "正式题库审核员");

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    classificationGoldReviewStore,
    questionStore,
    questionFamilyStore,
    knowledgeStructureStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.readdirSync(snapshotDir).forEach((name) => {
        try { fs.chmodSync(path.join(snapshotDir, name), 0o600); } catch (_error) { /* already gone */ }
      });
    } catch (_error) { /* no snapshot */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const created = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1/revisions",
    {
      method: "POST",
      body: {
        title: "20题盲测金标集V2",
        version: "V2",
        riskQuestionIds: ["q-2"],
        qualificationIssues: [{ questionId: "q-2", code: "manual_family_risk", message: "需要复核题族事实。" }],
        reason: "V1 校准资格检查失败。",
      },
    },
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.batch.id, "review-batch-v1-v2");
  assert.equal(created.body.automatedAiAcceptance, false);
  assert.equal(created.body.agent4Triggered, false);
  assert.equal(created.body.formalBusinessDataMutated, false);
  assert.equal(created.body.batch.source.parentSnapshotId, parent.snapshot.snapshotId);
  assert.equal(created.body.batch.source.parentFileSha256, parent.snapshot.fileSha256);
  assert.equal(created.body.batch.source.parentContentSha256, parent.snapshot.contentSha256);
  assert.deepEqual(created.body.revisionReview.requestedRiskQuestionIds, ["q-2"]);
  assert.deepEqual(
    created.body.revisionReview.automaticallyReopenedQuestionIds,
    ["q-1"],
    JSON.stringify(created.body.semanticValidation),
  );
  assert.equal(created.body.batch.items.find((item) => item.questionId === "q-1").familyReview.result, "pending_review");
  const q2RevisionItem = created.body.batch.items.find((item) => item.questionId === "q-2");
  assert.equal(q2RevisionItem.contentReview.result, "pending_review");
  assert.equal(q2RevisionItem.familyReview.result, "pending_review");
  assert.deepEqual(q2RevisionItem.revisionReview.requiredStages, ["content", "family"]);
  assert.ok(q2RevisionItem.revisionReview.issues.some((issue) => issue.code === "formal_question_drift"));
  assert.equal(created.body.batch.items[0].familyGold.families[0].status, "confirmed");
  assert.equal(created.body.batch.items[0].familyGold.families[0].membership.revision > 0, true);

  const inheritedQ1 = created.body.batch.items.find((item) => item.questionId === "q-1");
  const legacyProtocol = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/items/q-1/family",
    {
      method: "PUT",
      body: {
        expectedRevision: inheritedQ1.revision,
        result: "confirmed",
        familyGold: {
          ...inheritedQ1.familyGold,
          familyKnowledgeProtocolVersion: LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
        },
      },
    },
  );
  assert.equal(legacyProtocol.response.status, 422, JSON.stringify(legacyProtocol.body));
  assert.equal(legacyProtocol.body.error, "classification_gold_review_family_semantic_invalid");
  assert.deepEqual(legacyProtocol.body.details.issues.map((issue) => issue.code), ["family_knowledge_protocol_missing"]);

  const migratedQ1 = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/items/q-1/family",
    {
      method: "PUT",
      body: {
        expectedRevision: inheritedQ1.revision,
        result: "confirmed",
        familyGold: inheritedQ1.familyGold,
      },
    },
  );
  assert.equal(migratedQ1.response.status, 200, JSON.stringify(migratedQ1.body));
  assert.equal(
    migratedQ1.body.item.familyGold.familyKnowledgeProtocolVersion,
    FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  );
  assert.deepEqual(
    migratedQ1.body.item.familyGold.families[0].membership.contributionKnowledgeNodeIds,
    ["node-core"],
  );

  const confirmedFamily = questionFamilyStore.get(family.id);
  questionFamilyStore.review(family.id, {
    status: "pending_review",
    members: confirmedFamily.members,
  }, "题族维护员");
  const staleFreeze = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/freeze/prepare",
    { method: "POST", body: {} },
  );
  assert.equal(staleFreeze.response.status, 409, JSON.stringify(staleFreeze.body));
  assert.equal(staleFreeze.body.error, "classification_gold_review_formal_family_drift");
  assert.ok(staleFreeze.body.details.issues.some((issue) => issue.code === "formal_family_status_drift"));
  const pendingFamily = questionFamilyStore.get(family.id);
  questionFamilyStore.review(family.id, {
    status: "confirmed",
    members: pendingFamily.members,
  }, "题族维护员");

  // A newly proposed member remains pending_fit and is not yet a formal
  // family fact. The catalog hash must exclude it, and the same hash must be
  // accepted by the V2 submission guard after the reviewer reloads catalog.
  const pendingOnlyQuestion = questionStore.create({
    ...reviewItem("q-pending-fit").question,
    stem: "这是一道尚未确认题族归属的候选题。",
  }, "题族维护员");
  const familyWithPendingMember = questionFamilyStore.addMembers(
    family.id,
    [pendingOnlyQuestion],
    "题族维护员",
    { contributionKnowledgeNodeIdsByQuestion: { [pendingOnlyQuestion.id]: ["node-core"] } },
  ).family;
  assert.equal(
    familyWithPendingMember.members.find((member) => member.questionId === pendingOnlyQuestion.id)?.reviewStatus,
    "pending_fit",
  );

  const reopenBody = {
    questionIds: ["q-1"],
    reason: "统一一致性预检发现新增风险。",
    preflightReportHash: "b".repeat(64),
    qualificationIssues: [{ questionId: "q-1", code: "preflight_risk", message: "需要追加人工审核。" }],
  };
  const reopened = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/family-reviews/reopen",
    { method: "POST", body: reopenBody },
  );
  assert.equal(reopened.response.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.idempotentReplay, false);
  assert.equal(reopened.body.batch.summary.pending, 2);
  const repeated = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/family-reviews/reopen",
    { method: "POST", body: reopenBody },
  );
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.idempotentReplay, true);
  assert.equal(repeated.body.batch.revision, reopened.body.batch.revision);

  const reopenedQ1 = repeated.body.batch.items.find((item) => item.questionId === "q-1");
  const familyOptions = await request(
    baseUrl,
    "/api/admin/question-family-options?bookId=modern-chinese-7-1",
  );
  assert.equal(familyOptions.response.status, 200, JSON.stringify(familyOptions.body));
  const selectedCatalogFamily = familyOptions.body.families.find((entry) => entry.id === family.id);
  assert.match(selectedCatalogFamily.formalFactSha256, /^[a-f0-9]{64}$/);
  const catalogFamilySubmission = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/items/q-1/family",
    {
      method: "PUT",
      body: {
        expectedRevision: reopenedQ1.revision,
        result: "confirmed",
        familyGold: {
          ...reopenedQ1.familyGold,
          familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
          families: [selectedCatalogFamily],
        },
      },
    },
  );
  assert.equal(catalogFamilySubmission.response.status, 200, JSON.stringify(catalogFamilySubmission.body));
  assert.equal(catalogFamilySubmission.body.item.familyGold.families[0].id, family.id);
  assert.equal(catalogFamilySubmission.body.item.familyGold.families[0].membership.questionId, "q-1");

  const reopenedAfterCatalogSubmission = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/family-reviews/reopen",
    {
      method: "POST",
      body: {
        questionIds: ["q-1"],
        reason: "继续验证题族事实漂移。",
        preflightReportHash: "c".repeat(64),
        qualificationIssues: [{ questionId: "q-1", code: "formal_family_recheck", message: "继续复核正式题族。" }],
      },
    },
  );
  assert.equal(reopenedAfterCatalogSubmission.response.status, 200, JSON.stringify(reopenedAfterCatalogSubmission.body));
  const reopenedForDrift = reopenedAfterCatalogSubmission.body.batch.items.find((item) => item.questionId === "q-1");
  const currentFamily = questionFamilyStore.get(family.id);
  questionFamilyStore.review(family.id, {
    status: "confirmed",
    members: currentFamily.members,
    assessmentAction: "已经变更的正式考查动作",
  }, "题族维护员");
  const staleFamilySubmission = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/items/q-1/family",
    {
      method: "PUT",
      body: {
        expectedRevision: reopenedForDrift.revision,
        result: "confirmed",
        familyGold: reopenedForDrift.familyGold,
      },
    },
  );
  assert.equal(staleFamilySubmission.response.status, 409, JSON.stringify(staleFamilySubmission.body));
  assert.equal(staleFamilySubmission.body.error, "classification_gold_review_formal_family_drift");
  assert.ok(staleFamilySubmission.body.details.issues.some((issue) => issue.code === "formal_family_definition_drift"));

  questionFamilyStore.remove(family.id, "题族维护员");
  const deletedFamilySubmission = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/review-batch-v1-v2/items/q-1/family",
    {
      method: "PUT",
      body: {
        expectedRevision: reopenedForDrift.revision,
        result: "confirmed",
        familyGold: reopenedForDrift.familyGold,
      },
    },
  );
  assert.equal(deletedFamilySubmission.response.status, 409, JSON.stringify(deletedFamilySubmission.body));
  assert.equal(deletedFamilySubmission.body.error, "classification_gold_review_formal_family_drift");
  assert.ok(deletedFamilySubmission.body.details.issues.some((issue) => issue.code === "formal_family_missing"));
});

test("V2 family review reports semantic conflicts and can adjudicate a mature item as unmatched", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classification-gold-mode-api-"));
  const snapshotDir = path.join(root, "snapshots");
  const classificationGoldReviewStore = createMemoryClassificationGoldReviewStore({}, { snapshotDir });
  const testedQuestion = reviewItem("q-mode").question;
  const peerQuestion = reviewItem("q-mode-peer").question;
  const formalQuestions = [testedQuestion, peerQuestion];
  const questionStore = createMemoryQuestionStore(formalQuestions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "consonants", level: 2, title: "第三节 辅音与声母", startPage: 35, endPage: 50 },
      { id: "node-core", level: 3, title: "看声带是否振动", startPage: 39, endPage: 40 },
    ],
    chunks: [],
    questions: formalQuestions,
  });
  knowledgeStructureStore.assignQuestions("modern-chinese-7-1", formalQuestions.map((question) => ({
    questionId: question.id,
    primaryNodeId: "node-core",
    requiredNodeIds: ["node-core"],
  })));
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const createdFamily = questionFamilyStore.create({
    id: "family-mode",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    name: "声母发音方法·声带振动",
    focusKey: "声母发音方法·声带振动",
    primaryKnowledgePoint: "清浊音",
    knowledgeNodeId: "node-core",
    coreKnowledgeNodeId: "node-core",
    requiredKnowledgeNodeIds: ["node-core"],
    textbookAnchorNodeIds: ["node-core"],
    assessmentAction: "判断声带是否振动",
  });
  const withMembers = questionFamilyStore.addMembers(createdFamily.id, formalQuestions, "教研员", {
    contributionKnowledgeNodeIdsByQuestion: Object.fromEntries(
      formalQuestions.map((question) => [question.id, ["node-core"]]),
    ),
  }).family;
  questionFamilyStore.review(createdFamily.id, { status: "confirmed", members: withMembers.members }, "教研员");

  const sourceFamilyGold = {
    ...familyGold(),
    primaryFamilyId: createdFamily.id,
    relatedFamilyIds: [],
    families: [{
      ...familyGold().families[0],
      id: createdFamily.id,
      memberQuestionIds: formalQuestions.map((question) => question.id),
      independentMemberQuestionIds: formalQuestions.map((question) => question.id),
      independentMemberCount: 2,
      retainedIndependentMemberQuestionIds: [peerQuestion.id],
    }],
  };
  const sourceItem = {
    ...reviewItem(testedQuestion.id),
    familyGold: sourceFamilyGold,
    aiCandidates: undefined,
  };
  classificationGoldReviewStore.importBatch({
    id: "mode-review-v1",
    title: "层级改判金标集V1",
    version: "V1",
    source: { batchId: "blind-batch-source" },
    items: [sourceItem],
  });
  const content = classificationGoldReviewStore.reviewContent("mode-review-v1", testedQuestion.id, {
    expectedRevision: 1,
    result: "confirmed",
    answerKnowledge: sourceItem.answerKnowledge,
    reviewer: "V1审核员",
  });
  classificationGoldReviewStore.reviewFamily("mode-review-v1", testedQuestion.id, {
    expectedRevision: content.item.revision,
    result: "confirmed",
    familyGold: sourceFamilyGold,
    reviewer: "V1审核员",
  });
  const preparedV1 = classificationGoldReviewStore.prepareFreeze("mode-review-v1", { reviewer: "V1审核员" });
  const frozenV1 = classificationGoldReviewStore.commitFreeze("mode-review-v1", {
    token: preparedV1.preparation.token,
    reviewer: "V1审核员",
  });
  const frozenV1Bytes = fs.readFileSync(frozenV1.snapshot.filePath);

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    classificationGoldReviewStore,
    questionStore,
    questionFamilyStore,
    knowledgeStructureStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.readdirSync(snapshotDir).forEach((name) => {
        try { fs.chmodSync(path.join(snapshotDir, name), 0o600); } catch (_error) { /* already gone */ }
      });
    } catch (_error) { /* no snapshot */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const createdV2 = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/mode-review-v1/revisions",
    {
      method: "POST",
      body: {
        id: "mode-review-v2",
        title: "层级改判金标集V2",
        version: "V2",
        riskQuestionIds: [testedQuestion.id],
        qualificationIssues: [{
          questionId: testedQuestion.id,
          code: "family_mode_risk",
          message: "原成熟题族层级需要人工复核。",
          requiredStages: ["family"],
        }],
        reason: "复核盲测层级。",
      },
    },
  );
  assert.equal(createdV2.response.status, 201, JSON.stringify(createdV2.body));
  const revisionItem = createdV2.body.batch.items[0];
  assert.equal(revisionItem.sourceMode, "mature");
  assert.equal(revisionItem.finalReplayMode, "mature");
  assert.equal(revisionItem.contentReview.result, "confirmed");
  assert.equal(revisionItem.familyReview.result, "pending_review");
  assert.deepEqual(revisionItem.revisionReview.requiredStages, ["family"]);

  const familyOptions = await request(baseUrl, "/api/admin/question-family-options?bookId=modern-chinese-7-1");
  assert.equal(familyOptions.response.status, 200, JSON.stringify(familyOptions.body));
  const selectedFamily = familyOptions.body.families.find((entry) => entry.id === createdFamily.id);
  assert.ok(selectedFamily);
  const singletonConflict = await request(
    baseUrl,
    `/api/admin/knowledge-classification/gold-review/sets/mode-review-v2/items/${testedQuestion.id}/family`,
    {
      method: "PUT",
      body: {
        expectedRevision: revisionItem.revision,
        result: "corrected",
        note: "该题不是成熟题族留一，先复核为单题题族。",
        finalReplayMode: "singleton",
        replayModeChangeReason: "原成熟题族分层不成立。",
        familyGold: v2FamilyGold({
          ...revisionItem.familyGold,
          replayMode: "singleton",
          primaryFamilyId: createdFamily.id,
          relatedFamilyIds: [],
          families: [selectedFamily],
        }),
      },
    },
  );
  assert.equal(singletonConflict.response.status, 422, JSON.stringify(singletonConflict.body));
  assert.equal(singletonConflict.body.error, "classification_gold_review_family_semantic_invalid");
  const singletonIssue = singletonConflict.body.details.issues
    .find((issue) => issue.code === "singleton_family_member_count_invalid");
  assert.equal(singletonIssue.label, "单题题族成员数量不正确");
  assert.equal(singletonIssue.familyName, selectedFamily.name);

  const coreMismatchGold = v2FamilyGold(unmatchedFamilyGold(testedQuestion.id));
  coreMismatchGold.candidateFamily = {
    ...coreMismatchGold.candidateFamily,
    membership: {
      questionId: testedQuestion.id,
      contributionKnowledgeNodeIds: ["node-other"],
    },
  };
  const candidateCoreConflict = await request(
    baseUrl,
    `/api/admin/knowledge-classification/gold-review/sets/mode-review-v2/items/${testedQuestion.id}/family`,
    {
      method: "PUT",
      body: {
        expectedRevision: revisionItem.revision,
        result: "corrected",
        note: "候选题族核心知识仍需核对。",
        finalReplayMode: "unmatched",
        replayModeChangeReason: "没有可加入的正式题族。",
        familyGold: coreMismatchGold,
      },
    },
  );
  assert.equal(candidateCoreConflict.response.status, 422, JSON.stringify(candidateCoreConflict.body));
  assert.ok(candidateCoreConflict.body.details.issues
    .some((issue) => issue.code === "candidate_core_knowledge_mismatch"));

  const requiredMismatchGold = v2FamilyGold(unmatchedFamilyGold(testedQuestion.id));
  requiredMismatchGold.candidateFamily = {
    ...requiredMismatchGold.candidateFamily,
    requiredKnowledge: [
      ...requiredMismatchGold.candidateFamily.requiredKnowledge,
      { id: "node-extra", title: "送气强弱", path: "语音 > 送气强弱" },
    ],
    requiredKnowledgeNodeIds: ["node-core", "node-extra"],
    membership: {
      questionId: testedQuestion.id,
      contributionKnowledgeNodeIds: ["node-core", "node-extra"],
    },
  };
  const candidateRequiredConflict = await request(
    baseUrl,
    `/api/admin/knowledge-classification/gold-review/sets/mode-review-v2/items/${testedQuestion.id}/family`,
    {
      method: "PUT",
      body: {
        expectedRevision: revisionItem.revision,
        result: "corrected",
        note: "候选题族必需知识仍需核对。",
        finalReplayMode: "unmatched",
        replayModeChangeReason: "没有可加入的正式题族。",
        familyGold: requiredMismatchGold,
      },
    },
  );
  assert.equal(candidateRequiredConflict.response.status, 422, JSON.stringify(candidateRequiredConflict.body));
  assert.ok(candidateRequiredConflict.body.details.issues
    .some((issue) => issue.code === "candidate_required_knowledge_mismatch"));

  const adjudicated = await request(
    baseUrl,
    `/api/admin/knowledge-classification/gold-review/sets/mode-review-v2/items/${testedQuestion.id}/family`,
    {
      method: "PUT",
      body: {
        expectedRevision: revisionItem.revision,
        result: "corrected",
        note: "现有题族都不能覆盖完整的作答知识，改为新建候选题族。",
        finalReplayMode: "unmatched",
        replayModeChangeReason: "现有题族都不能覆盖完整的作答知识。",
        familyGold: v2FamilyGold(unmatchedFamilyGold(testedQuestion.id)),
      },
    },
  );
  assert.equal(adjudicated.response.status, 200, JSON.stringify(adjudicated.body));
  assert.equal(adjudicated.body.item.sourceMode, "mature");
  assert.equal(adjudicated.body.item.finalReplayMode, "unmatched");
  assert.equal(adjudicated.body.item.familyGold.replayMode, "unmatched");
  assert.equal(adjudicated.body.item.familyReview.previousReplayMode, "mature");
  assert.equal(adjudicated.body.item.familyReview.nextReplayMode, "unmatched");
  const familyEvent = adjudicated.body.item.reviewHistory.at(-1);
  assert.equal(familyEvent.previousReplayMode, "mature");
  assert.equal(familyEvent.nextReplayMode, "unmatched");
  assert.equal(familyEvent.replayModeChanged, true);

  const preparedV2 = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/mode-review-v2/freeze/prepare",
    { method: "POST", body: {} },
  );
  assert.equal(preparedV2.response.status, 200, JSON.stringify(preparedV2.body));
  assert.equal(preparedV2.body.preparation.summary.modes.mature, 0);
  assert.equal(preparedV2.body.preparation.summary.modes.unmatched, 1);
  const frozenV2 = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/mode-review-v2/freeze/commit",
    { method: "POST", body: { token: preparedV2.body.preparation.token } },
  );
  assert.equal(frozenV2.response.status, 200, JSON.stringify(frozenV2.body));
  assert.equal(frozenV2.body.summary.modes.unmatched, 1);
  assert.deepEqual(fs.readFileSync(frozenV1.snapshot.filePath), frozenV1Bytes);
});

test("V2 family review API enforces related-family coverage roles and preserves them in snapshots", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classification-gold-related-role-api-"));
  const snapshotDir = path.join(root, "snapshots");
  const classificationGoldReviewStore = createMemoryClassificationGoldReviewStore({}, { snapshotDir });
  const testedQuestions = [reviewItem("q-role-join").question, reviewItem("q-role-new").question];
  const peerQuestion = reviewItem("q-role-peer").question;
  const formalQuestions = [...testedQuestions, peerQuestion];
  const questionStore = createMemoryQuestionStore(formalQuestions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "method", level: 2, title: "第一节 发音方法", startPage: 30, endPage: 40 },
      { id: "node-core", level: 3, title: "核心知识", startPage: 30, endPage: 32 },
      { id: "node-secondary", level: 3, title: "辅助知识", startPage: 33, endPage: 35 },
      { id: "node-unrelated", level: 3, title: "无关知识", startPage: 36, endPage: 38 },
    ],
    chunks: [],
    questions: formalQuestions,
  });
  knowledgeStructureStore.assignQuestions("modern-chinese-7-1", testedQuestions.map((question) => ({
    questionId: question.id,
    primaryNodeId: "node-core",
    requiredNodeIds: ["node-core", "node-secondary"],
  })));

  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const createConfirmedFamily = ({ name, coreKnowledgeNodeId, questions }) => {
    const created = questionFamilyStore.create({
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      name,
      focusKey: name,
      primaryKnowledgePoint: name,
      knowledgeNodeId: coreKnowledgeNodeId,
      coreKnowledgeNodeId,
      requiredKnowledgeNodeIds: [coreKnowledgeNodeId],
      textbookAnchorNodeIds: [coreKnowledgeNodeId],
      assessmentAction: `判断${name}`,
      inclusionBoundary: `纳入${name}`,
      exclusionBoundary: `排除非${name}`,
    });
    const withMembers = questionFamilyStore.addMembers(created.id, questions, "教研员", {
      contributionKnowledgeNodeIdsByQuestion: Object.fromEntries(
        questions.map((question) => [question.id, [coreKnowledgeNodeId]]),
      ),
    }).family;
    return questionFamilyStore.review(created.id, {
      status: "confirmed",
      members: withMembers.members,
    }, "教研员");
  };
  const primaryFamily = createConfirmedFamily({
    name: "主题题族·核心知识",
    coreKnowledgeNodeId: "node-core",
    questions: formalQuestions,
  });
  const requiredFamily = createConfirmedFamily({
    name: "关联题族·辅助知识",
    coreKnowledgeNodeId: "node-secondary",
    questions: testedQuestions,
  });
  const referenceFamily = createConfirmedFamily({
    name: "普通关联题族·辅助知识",
    coreKnowledgeNodeId: "node-secondary",
    questions: [testedQuestions[0]],
  });
  const unrelatedFamily = createConfirmedFamily({
    name: "关联题族·无关知识",
    coreKnowledgeNodeId: "node-unrelated",
    questions: [testedQuestions[0]],
  });

  const crossKnowledgeAnswer = () => ({
    ...reviewedAnswerKnowledge(),
    requiredKnowledge: [
      { id: "node-core", title: "核心知识", path: "第二章 语音 > 核心知识" },
      { id: "node-secondary", title: "辅助知识", path: "第二章 语音 > 辅助知识" },
    ],
    optionKnowledge: [
      {
        key: "A",
        text: "甲",
        knowledgeLabels: ["核心知识"],
        knowledgeRelation: "option_specific",
        knowledgeNodeIds: ["node-core"],
        role: "answer",
      },
      {
        key: "B",
        text: "乙",
        knowledgeLabels: ["辅助知识"],
        knowledgeRelation: "option_specific",
        knowledgeNodeIds: ["node-secondary"],
        role: "distractor",
      },
    ],
  });
  const parentFamilyGold = {
    replayMode: "mature",
    decision: "join_existing",
    primaryFamilyId: primaryFamily.id,
    relatedFamilyIds: [],
    families: [{ id: primaryFamily.id, name: primaryFamily.name }],
  };
  const parentItems = testedQuestions.map((question) => ({
    ...reviewItem(question.id),
    question,
    answerKnowledge: crossKnowledgeAnswer(),
    familyGold: parentFamilyGold,
    aiCandidates: undefined,
  }));
  classificationGoldReviewStore.importBatch({
    id: "related-role-v1",
    title: "关联题族角色金标集V1",
    version: "V1",
    source: { batchId: "blind-batch-source" },
    items: parentItems,
  });
  parentItems.forEach((item) => {
    const content = classificationGoldReviewStore.reviewContent("related-role-v1", item.questionId, {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item.answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "V1审核员",
    });
    classificationGoldReviewStore.reviewFamily("related-role-v1", item.questionId, {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: parentFamilyGold,
      reviewer: "V1审核员",
    });
  });
  const preparedV1 = classificationGoldReviewStore.prepareFreeze("related-role-v1", { reviewer: "V1审核员" });
  classificationGoldReviewStore.commitFreeze("related-role-v1", {
    token: preparedV1.preparation.token,
    reviewer: "V1审核员",
  });

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    classificationGoldReviewStore,
    questionStore,
    questionFamilyStore,
    knowledgeStructureStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.readdirSync(snapshotDir).forEach((name) => {
        try { fs.chmodSync(path.join(snapshotDir, name), 0o600); } catch (_error) { /* already gone */ }
      });
    } catch (_error) { /* no snapshot */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const createdV2 = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/related-role-v1/revisions",
    {
      method: "POST",
      body: {
        id: "related-role-v2",
        title: "关联题族角色金标集V2",
        version: "V2",
        riskQuestionIds: testedQuestions.map((question) => question.id),
        qualificationIssues: testedQuestions.map((question) => ({
          questionId: question.id,
          code: "related_family_role_review",
          message: "复核关联题族在作答中的覆盖角色。",
          requiredStages: ["family"],
        })),
        reason: "验证关联题族覆盖角色协议。",
      },
    },
  );
  assert.equal(createdV2.response.status, 201, JSON.stringify(createdV2.body));
  const revisionByQuestionId = new Map(createdV2.body.batch.items
    .map((item) => [item.questionId, item.revision]));

  const familyOptions = await request(baseUrl, "/api/admin/question-family-options?bookId=modern-chinese-7-1");
  assert.equal(familyOptions.response.status, 200, JSON.stringify(familyOptions.body));
  const familyOption = (familyId) => {
    const option = familyOptions.body.families.find((family) => family.id === familyId);
    assert.ok(option, `missing family option ${familyId}`);
    return option;
  };
  const primaryOption = familyOption(primaryFamily.id);
  const requiredOption = familyOption(requiredFamily.id);
  const referenceOption = familyOption(referenceFamily.id);
  const unrelatedOption = familyOption(unrelatedFamily.id);
  const joinFamilyGold = (relatedOption, coverageRole) => v2FamilyGold({
    replayMode: "mature",
    decision: "join_existing",
    primaryFamilyId: primaryFamily.id,
    relatedFamilyIds: [relatedOption.id],
    ...(coverageRole ? {
      relatedFamilyRelations: [{ familyId: relatedOption.id, coverageRole }],
    } : {}),
    families: [primaryOption, relatedOption],
  });
  const joinPath = "/api/admin/knowledge-classification/gold-review/sets/related-role-v2/items/q-role-join/family";
  const joinRevision = revisionByQuestionId.get("q-role-join");

  const missingRole = await request(baseUrl, joinPath, {
    method: "PUT",
    body: {
      expectedRevision: joinRevision,
      result: "corrected",
      note: "关联题族尚未明确覆盖角色。",
      familyGold: joinFamilyGold(requiredOption),
    },
  });
  assert.equal(missingRole.response.status, 422, JSON.stringify(missingRole.body));
  assert.equal(missingRole.body.error, "classification_gold_review_family_semantic_invalid");
  const missingRoleIssue = missingRole.body.details.issues
    .find((issue) => issue.code === "related_family_relation_missing");
  assert.equal(missingRoleIssue.label, "关联题族缺少覆盖角色");
  assert.match(missingRoleIssue.message, /必须明确标记为作答必需或普通关联/);

  const referenceDoesNotCover = await request(baseUrl, joinPath, {
    method: "PUT",
    body: {
      expectedRevision: joinRevision,
      result: "corrected",
      note: "普通关联不能参与最小充分知识覆盖。",
      familyGold: joinFamilyGold(referenceOption, "reference"),
    },
  });
  assert.equal(referenceDoesNotCover.response.status, 422, JSON.stringify(referenceDoesNotCover.body));
  assert.ok(referenceDoesNotCover.body.details.issues
    .some((issue) => issue.code === "required_knowledge_mismatch"));
  assert.ok(referenceDoesNotCover.body.details.issues
    .some((issue) => issue.code === "reference_family_knowledge_contribution_forbidden"));

  const unrelatedRequired = await request(baseUrl, joinPath, {
    method: "PUT",
    body: {
      expectedRevision: joinRevision,
      result: "corrected",
      note: "无关题族不能冒充作答必需覆盖。",
      familyGold: joinFamilyGold(unrelatedOption, "required"),
    },
  });
  assert.equal(unrelatedRequired.response.status, 422, JSON.stringify(unrelatedRequired.body));
  assert.ok(unrelatedRequired.body.details.issues.some((issue) => (
    issue.code === "required_family_no_knowledge_contribution" && issue.familyId === unrelatedFamily.id
  )));

  const joined = await request(baseUrl, joinPath, {
    method: "PUT",
    body: {
      expectedRevision: joinRevision,
      result: "corrected",
      note: "主题题族和作答必需关联题族共同覆盖最小充分知识集。",
      familyGold: joinFamilyGold(requiredOption, "required"),
    },
  });
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body));
  assert.deepEqual(joined.body.semanticWarnings, []);
  assert.deepEqual(joined.body.item.familyGold.relatedFamilyRelations, [{
    familyId: requiredFamily.id,
    coverageRole: "required",
    requiredForAnswer: true,
  }]);

  const createNewPath = "/api/admin/knowledge-classification/gold-review/sets/related-role-v2/items/q-role-new/family";
  const createdNew = await request(baseUrl, createNewPath, {
    method: "PUT",
    body: {
      expectedRevision: revisionByQuestionId.get("q-role-new"),
      result: "corrected",
      note: "现有主题题族不合适，新候选题族与作答必需关联题族共同覆盖。",
      finalReplayMode: "unmatched",
      replayModeChangeReason: "现有主题题族不符合新的考查动作。",
      familyGold: v2FamilyGold({
        replayMode: "unmatched",
        decision: "create_new",
        primaryFamilyId: "",
        relatedFamilyIds: [requiredFamily.id],
        relatedFamilyRelations: [{ familyId: requiredFamily.id, coverageRole: "required" }],
        families: [requiredOption],
        candidateFamily: {
          name: "候选主题题族·核心知识",
          focusKey: "candidate-core-knowledge-judgment",
          bookId: "modern-chinese-7-1",
          coreKnowledge: { id: "node-core", title: "核心知识", path: "第二章 语音 > 核心知识" },
          coreKnowledgeNodeId: "node-core",
          requiredKnowledge: [{ id: "node-core", title: "核心知识", path: "第二章 语音 > 核心知识" }],
          requiredKnowledgeNodeIds: ["node-core"],
          textbookAnchors: [{ id: "node-core", title: "核心知识", path: "第二章 语音 > 核心知识" }],
          textbookAnchorNodeIds: ["node-core"],
          assessmentAction: "判断核心知识的新考查动作",
          inclusionBoundary: "纳入需要同时调用核心知识与辅助知识的题目",
          exclusionBoundary: "排除只需辅助知识即可作答的题目",
          membership: {
            questionId: "q-role-new",
            contributionKnowledgeNodeIds: ["node-core"],
          },
        },
        reason: "候选主题题族负责核心知识，现有作答必需关联题族负责辅助知识。",
      }),
    },
  });
  assert.equal(createdNew.response.status, 200, JSON.stringify(createdNew.body));
  assert.deepEqual(createdNew.body.item.familyGold.relatedFamilyRelations, [{
    familyId: requiredFamily.id,
    coverageRole: "required",
    requiredForAnswer: true,
  }]);

  const preparedV2 = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/related-role-v2/freeze/prepare",
    { method: "POST", body: {} },
  );
  assert.equal(preparedV2.response.status, 200, JSON.stringify(preparedV2.body));
  const frozenV2 = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/related-role-v2/freeze/commit",
    { method: "POST", body: { token: preparedV2.body.preparation.token } },
  );
  assert.equal(frozenV2.response.status, 200, JSON.stringify(frozenV2.body));
  const snapshot = JSON.parse(fs.readFileSync(frozenV2.body.snapshot.filePath, "utf8"));
  const frozenByQuestionId = new Map(snapshot.items.map((item) => [item.questionId, item]));
  ["q-role-join", "q-role-new"].forEach((questionId) => {
    assert.deepEqual(frozenByQuestionId.get(questionId).familyGold.relatedFamilyRelations, [{
      familyId: requiredFamily.id,
      coverageRole: "required",
      requiredForAnswer: true,
    }]);
  });
});

function formalQuestion() {
  return {
    id: "business-q-1",
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第二章 语音 > 第三节 辅音与声母",
    primaryKnowledgePoint: "辅音的发音方法",
    knowledgePoints: ["辅音的发音方法"],
    subKnowledgePoints: ["阻碍方式"],
    type: "single_choice",
    typeLabel: "单选题",
    stem: "从发音方法看，声母 m 的正确描述是（ ）。",
    options: [{ key: "A", text: "清音" }, { key: "B", text: "浊音" }],
    correctAnswer: ["A"],
    referenceAnswer: "A。",
    answerVariants: { official: "A。", ai: "", community: "" },
    scoringPoints: [],
    maxScore: 1,
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    answerVerified: true,
    version: 3,
    versions: [{ version: 3, updatedAt: 300, updatedBy: "原审核员", changeNote: "原始版本" }],
    createdAt: 100,
    updatedAt: 300,
    createdBy: "原审核员",
    updatedBy: "原审核员",
  };
}

function correctedBusinessKnowledge() {
  return {
    correctAnswer: ["B"],
    referenceAnswer: "B。m 发音时声带振动，属于浊音。",
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    textbookEvidence: [{
      chunkId: "chunk-voicing",
      bookId: "modern-chinese-7-1",
      catalogPath: "第二章 语音 > 辅音与声母 > 辅音的发音方法 > 看声带是否振动",
      printedPageStart: 39,
      excerpt: "普通话辅音中 m 发音时声带振动，是浊音。",
    }],
    coreKnowledge: { id: "voicing", title: "看声带是否振动", path: "第二章 语音 > 看声带是否振动" },
    requiredKnowledge: [{ id: "voicing", title: "看声带是否振动", path: "第二章 语音 > 看声带是否振动" }],
    optionKnowledge: [
      { key: "A", text: "清音", knowledgeNodeIds: ["voicing"], role: "distractor" },
      { key: "B", text: "浊音", knowledgeNodeIds: ["voicing"], role: "answer" },
    ],
  };
}

function businessStores({ failGoldWrite = false } = {}) {
  const question = formalQuestion();
  const questionStore = createMemoryQuestionStore([question]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const structure = knowledgeStructureStore.generate({
    bookId: question.bookId,
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "consonants", level: 2, title: "第三节 辅音与声母", startPage: 35, endPage: 50 },
      { id: "method", level: 3, title: "一、辅音的发音方法", startPage: 36, endPage: 42 },
      { id: "obstruction", level: 4, title: "（一）看阻碍的方式", startPage: 36, endPage: 38 },
      { id: "voicing", level: 4, title: "（二）看声带是否振动", startPage: 39, endPage: 40 },
    ],
    chunks: [{
      id: "chunk-voicing",
      catalogNodeId: "voicing",
      catalogPath: "第二章 语音 > 辅音与声母 > 辅音的发音方法 > 看声带是否振动",
      text: "普通话辅音中 m 发音时声带振动，是浊音。",
    }],
    questions: [question],
  });
  knowledgeStructureStore.assignQuestions(question.bookId, [{
    questionId: question.id,
    primaryNodeId: "obstruction",
    requiredNodeIds: ["obstruction"],
  }]);
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const formalFamily = questionFamilyStore.create({
    subjectId: question.subjectId,
    bookId: question.bookId,
    name: "辅音发音方法判断",
    focusKey: "辅音发音方法判断",
    primaryKnowledgePoint: "看阻碍的方式",
    knowledgeNodeId: "obstruction",
    coreKnowledgeNodeId: "obstruction",
    requiredKnowledgeNodeIds: ["obstruction"],
    textbookAnchorNodeIds: ["obstruction"],
    knowledgePath: structure.nodes.find((node) => node.id === "obstruction").path,
    assessmentAction: "判断辅音发音方法",
  });
  const addedFamily = questionFamilyStore.addMembers(formalFamily.id, [question], "原审核员").family;
  questionFamilyStore.review(formalFamily.id, { status: "confirmed", members: addedFamily.members }, "原审核员");

  const realGoldStore = createMemoryClassificationGoldReviewStore();
  realGoldStore.importBatch({
    id: "business-review-v1",
    title: "20题盲测金标集V1",
    version: "V1",
    source: { batchId: "blind-batch-source" },
    items: [{
      questionId: question.id,
      mode: "mature",
      question,
      answerKnowledge: {
        ...correctedBusinessKnowledge(),
        correctAnswer: ["A"],
        referenceAnswer: "A。",
        coreKnowledge: { id: "obstruction", title: "看阻碍的方式", path: "第二章 语音 > 看阻碍的方式" },
        requiredKnowledge: [{ id: "obstruction", title: "看阻碍的方式", path: "第二章 语音 > 看阻碍的方式" }],
      },
      familyGold: {
        replayMode: "mature",
        decision: "join_existing",
        primaryFamilyId: formalFamily.id,
        families: [{ ...formalFamily, independentMemberCount: 2 }],
      },
    }],
  });
  const classificationGoldReviewStore = failGoldWrite
    ? { ...realGoldStore, reviewBusinessContent() { throw new Error("injected_gold_write_failure"); } }
    : realGoldStore;
  return {
    questionStore,
    knowledgeStructureStore,
    questionFamilyStore,
    classificationGoldReviewStore,
    realGoldStore,
    formalFamily,
  };
}

async function startBusinessServer(context, stores) {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), ...stores });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function businessCorrectionBody() {
  return {
    expectedRevision: 1,
    expectedQuestionVersion: 3,
    result: "corrected",
    note: "核对教材后，m 应为浊音，并调整到声带振动知识点。",
    answerKnowledge: correctedBusinessKnowledge(),
    answerKnowledgeProvenance: { originalPrefillSource: "blind_replay_report" },
    reviewEvidenceNote: "已逐页核对教材第39页。",
    knowledgeAssignment: {
      primaryNodeId: "voicing",
      requiredNodeIds: ["voicing"],
      evidenceChunkIds: ["chunk-voicing"],
    },
  };
}

test("business correction creates a formal question version before synchronizing gold", async (context) => {
  const stores = businessStores();
  let forwardedBusinessReviewPayload = null;
  const reviewBusinessContent = stores.classificationGoldReviewStore.reviewBusinessContent;
  stores.classificationGoldReviewStore = {
    ...stores.classificationGoldReviewStore,
    reviewBusinessContent(batchId, questionId, payload) {
      forwardedBusinessReviewPayload = payload;
      return reviewBusinessContent(batchId, questionId, payload);
    },
  };
  const baseUrl = await startBusinessServer(context, stores);
  const correctionBody = {
    ...businessCorrectionBody(),
    selectedEvidenceChunkIds: ["chunk-voicing"],
  };
  const corrected = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/business-content",
    { method: "PUT", body: correctionBody },
  );
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.body.blindReplayStarted, false);
  assert.equal(corrected.body.question.version, 4);
  assert.deepEqual(corrected.body.question.correctAnswer, ["B"]);
  assert.equal(corrected.body.knowledgeAssignment.primaryNodeId, "voicing");
  assert.equal(corrected.body.item.question.version, 4);
  assert.equal(corrected.body.item.contentReview.result, "corrected");
  assert.equal(corrected.body.item.familyReview.result, "pending_review");
  assert.equal(corrected.body.item.answerKnowledge.answerSource, "team_verified");
  assert.equal(corrected.body.item.answerKnowledge.answerReviewStatus, "verified");
  assert.equal(corrected.body.item.answerKnowledgeProvenance.originalPrefillSource, undefined);
  assert.equal(corrected.body.item.answerKnowledgeProvenance.reviewEvidenceNote, "已逐页核对教材第39页。");
  assert.equal(stores.questionStore.get("business-q-1").versions[0].previousSnapshot.version, 3);
  assert.equal(stores.knowledgeStructureStore.fingerprintMap("modern-chinese-7-1").get("business-q-1").primaryNodeId, "voicing");
  const correctedFamily = stores.questionFamilyStore.get(stores.formalFamily.id);
  assert.equal(correctedFamily.status, "confirmed");
  assert.equal(
    correctedFamily.members.find((member) => member.questionId === "business-q-1").reviewStatus,
    "pending_fit",
  );
  assert.deepEqual(stores.questionFamilyStore.confirmedForQuestion("business-q-1"), []);
  assert.deepEqual(forwardedBusinessReviewPayload.selectedEvidenceChunkIds, ["chunk-voicing"]);

  const staleRetry = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/business-content",
    { method: "PUT", body: { ...businessCorrectionBody(), expectedRevision: 2 } },
  );
  assert.equal(staleRetry.response.status, 409);
  assert.equal(staleRetry.body.error, "classification_gold_review_question_version_conflict");
  assert.equal(stores.questionStore.get("business-q-1").version, 4);
  assert.equal(stores.realGoldStore.get("business-review-v1").items[0].revision, 2);
});

test("business correction synchronizes a scope-anchor role to formal and gold fingerprints", async (context) => {
  const stores = businessStores();
  const baseUrl = await startBusinessServer(context, stores);
  const answerKnowledge = {
    ...correctedBusinessKnowledge(),
    coreKnowledgeRole: "scope_anchor",
    coreKnowledge: {
      id: "method",
      title: "辅音的发音方法",
      path: "第二章 语音 > 辅音与声母 > 辅音的发音方法",
    },
    requiredKnowledge: [{
      id: "voicing",
      title: "看声带是否振动",
      path: "第二章 语音 > 辅音与声母 > 辅音的发音方法 > 看声带是否振动",
    }],
  };
  const corrected = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/business-content",
    {
      method: "PUT",
      body: {
        ...businessCorrectionBody(),
        answerKnowledge,
        selectedEvidenceChunkIds: ["chunk-voicing"],
        knowledgeAssignment: {
          primaryNodeId: "method",
          primaryNodeRole: "scope_anchor",
          requiredNodeIds: ["voicing"],
          evidenceChunkIds: ["chunk-voicing"],
        },
      },
    },
  );
  assert.equal(corrected.response.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.knowledgeAssignment.primaryNodeRole, "scope_anchor");
  assert.equal(corrected.body.item.answerKnowledge.coreKnowledgeRole, "scope_anchor");
  assert.equal(
    stores.knowledgeStructureStore.fingerprintMap("modern-chinese-7-1").get("business-q-1").primaryNodeRole,
    "scope_anchor",
  );
  assert.deepEqual(
    stores.knowledgeStructureStore.fingerprintMap("modern-chinese-7-1").get("business-q-1").requiredNodeIds,
    ["voicing"],
  );
});

test("business correction rolls back formal data when gold synchronization fails", async (context) => {
  const stores = businessStores({ failGoldWrite: true });
  const baseUrl = await startBusinessServer(context, stores);
  const beforeQuestion = stores.questionStore.exportState();
  const beforeKnowledge = stores.knowledgeStructureStore.exportState();
  const beforeFamilies = stores.questionFamilyStore.exportState();
  const failed = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/business-content",
    { method: "PUT", body: businessCorrectionBody() },
  );
  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.error, "injected_gold_write_failure");
  assert.deepEqual(stores.questionStore.exportState(), beforeQuestion);
  assert.deepEqual(stores.knowledgeStructureStore.exportState(), beforeKnowledge);
  assert.deepEqual(stores.questionFamilyStore.exportState(), beforeFamilies);
  assert.equal(stores.realGoldStore.get("business-review-v1").items[0].revision, 1);
});

test("formal question drift blocks review and reload resets both review stages", async (context) => {
  const stores = businessStores();
  const reviewState = stores.realGoldStore.exportState();
  reviewState.batches[0].items[0].sourceMode = "singleton";
  reviewState.batches[0].items[0].humanGold.familyGold = {
    replayMode: "singleton",
    decision: "create_new",
    primaryFamilyId: "",
    relatedFamilyIds: [],
    families: [],
    candidateFamily: { name: "清浊音判断候选题族" },
    reason: "隐藏整个单题题族后应新建候选。",
  };
  stores.realGoldStore.replaceState(reviewState);
  const baseUrl = await startBusinessServer(context, stores);
  const externallyEdited = stores.questionStore.update("business-q-1", {
    referenceAnswer: "A。外部编辑后的正式答案。",
    changeNote: "另一位管理员编辑答案",
  }, "并发管理员");
  assert.equal(externallyEdited.version, 4);

  const blocked = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/content",
    {
      method: "PUT",
      body: {
        expectedRevision: 1,
        result: "confirmed_current",
        answerKnowledge: stores.realGoldStore.get("business-review-v1").items[0].answerKnowledge,
      },
    },
  );
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error, "classification_gold_review_formal_question_drift");

  const reloaded = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/reload",
    { method: "POST", body: { expectedRevision: 1 } },
  );
  assert.equal(reloaded.response.status, 200);
  assert.equal(reloaded.body.blindReplayStarted, false);
  assert.equal(reloaded.body.item.question.version, 4);
  assert.equal(reloaded.body.item.answerKnowledge.referenceAnswer, "A。外部编辑后的正式答案。");
  assert.equal(reloaded.body.item.contentReview.result, "pending_review");
  assert.equal(reloaded.body.item.familyReview.result, "pending_review");
  assert.equal(reloaded.body.item.revision, 2);
  assert.equal(reloaded.body.item.familyGold.replayMode, "singleton");
  assert.equal(reloaded.body.item.familyGold.decision, "create_new");
  assert.equal(reloaded.body.item.familyGold.candidateFamily.name, "清浊音判断候选题族");
});

test("formal knowledge drift blocks family review and freeze until reload", async (context) => {
  const stores = businessStores();
  const baseUrl = await startBusinessServer(context, stores);
  const itemBefore = stores.realGoldStore.get("business-review-v1").items[0];
  const content = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/content",
    {
      method: "PUT",
      body: {
        expectedRevision: 1,
        result: "confirmed_current",
        answerKnowledge: itemBefore.answerKnowledge,
      },
    },
  );
  assert.equal(content.response.status, 200, JSON.stringify(content.body));
  stores.knowledgeStructureStore.assignQuestions("modern-chinese-7-1", [{
    questionId: "business-q-1",
    primaryNodeId: "voicing",
    requiredNodeIds: ["voicing"],
  }]);

  const family = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/family",
    {
      method: "PUT",
      body: {
        expectedRevision: 2,
        result: "confirmed_current",
        familyGold: content.body.item.familyGold,
      },
    },
  );
  assert.equal(family.response.status, 409);
  assert.equal(family.body.error, "classification_gold_review_formal_knowledge_drift");

  const freeze = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/freeze",
    { method: "POST", body: {} },
  );
  assert.equal(freeze.response.status, 409);
  assert.equal(freeze.body.error, "classification_gold_review_formal_knowledge_drift");

  const reloaded = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/reload",
    { method: "POST", body: { expectedRevision: 2 } },
  );
  assert.equal(reloaded.response.status, 200);
  assert.equal(reloaded.body.item.answerKnowledge.coreKnowledge.id, "voicing");
  assert.equal(reloaded.body.item.contentReview.result, "pending_review");
  assert.equal(reloaded.body.item.familyReview.result, "pending_review");
});

test("business correction rejects an answer source that formal questions cannot persist", async (context) => {
  const stores = businessStores();
  const baseUrl = await startBusinessServer(context, stores);
  const body = businessCorrectionBody();
  body.answerKnowledge = { ...body.answerKnowledge, answerSource: "untrusted_source" };
  const rejected = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/business-review-v1/items/business-q-1/business-content",
    { method: "PUT", body },
  );
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.body.error, "classification_gold_review_business_answer_source_invalid");
  assert.equal(stores.questionStore.get("business-q-1").version, 3);
  assert.equal(stores.realGoldStore.get("business-review-v1").items[0].revision, 1);
});

test("subjective scoring-point knowledge metadata does not create false formal drift", async (context) => {
  const question = {
    id: "subjective-q-1",
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第二章 语音 > 辅音与声母",
    primaryKnowledgePoint: "清浊音",
    knowledgePoints: ["清浊音"],
    type: "short_answer",
    typeLabel: "简答题",
    stem: "简述清音和浊音的区别。",
    options: [],
    correctAnswer: [],
    referenceAnswer: "发音时声带不振动的是清音，声带振动的是浊音。",
    scoringPoints: [{
      id: "point-1",
      description: "指出声带是否振动",
      score: 2,
      evidenceGroups: [{ mode: "all", keywords: ["声带", "振动"] }],
      textbookPage: "39",
      pageBasis: "textbook_text",
      sourceNote: "教材原文",
    }],
    maxScore: 2,
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    answerVerified: true,
    version: 2,
    versions: [{ version: 2, updatedAt: 200, updatedBy: "原审核员", changeNote: "已审核" }],
    createdAt: 100,
    updatedAt: 200,
  };
  const questionStore = createMemoryQuestionStore([question]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: question.bookId,
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音" },
      { id: "consonants", level: 2, title: "第三节 辅音与声母" },
      { id: "method", level: 3, title: "一、辅音的发音方法" },
      { id: "voicing", level: 4, title: "（二）看声带是否振动" },
    ],
    chunks: [],
    questions: [question],
  });
  knowledgeStructureStore.assignQuestions(question.bookId, [{
    questionId: question.id,
    primaryNodeId: "voicing",
    requiredNodeIds: ["voicing"],
  }]);
  const classificationGoldReviewStore = createMemoryClassificationGoldReviewStore();
  classificationGoldReviewStore.importBatch({
    id: "subjective-review-v1",
    title: "主观题金标测试",
    version: "V1",
    items: [{
      questionId: question.id,
      reviewMethod: "human_independent_gold_v1",
      question,
      answerKnowledge: {
        correctAnswer: [],
        referenceAnswer: question.referenceAnswer,
        answerSource: "team_verified",
        answerReviewStatus: "verified",
        textbookEvidence: [{ chunkId: "chunk-voicing", excerpt: "教材证据", candidateOnly: true }],
        coreKnowledge: { id: "voicing", title: "看声带是否振动" },
        requiredKnowledge: [{ id: "voicing", title: "看声带是否振动" }],
        scoringPoints: [],
      },
      familyGold: {
        replayMode: "singleton",
        decision: "create_new",
        candidateFamily: { name: "清浊音简答" },
      },
    }],
  });
  const baseUrl = await startBusinessServer(context, {
    questionStore,
    knowledgeStructureStore,
    classificationGoldReviewStore,
  });
  const item = classificationGoldReviewStore.get("subjective-review-v1").items[0];
  const humanSubjectiveGold = {
    ...item.answerKnowledge,
    scoringPoints: [{
      id: "point-1",
      description: "指出声带是否振动",
      score: 2,
      knowledgeNodeIds: ["voicing"],
      knowledgeLabels: ["清浊音"],
      provenance: "human_review",
    }],
  };
  const reviewed = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/subjective-review-v1/items/subjective-q-1/content",
    {
      method: "PUT",
      body: {
        expectedRevision: 1,
        result: "confirmed_current",
        answerKnowledge: humanSubjectiveGold,
        selectedEvidenceChunkIds: ["chunk-voicing"],
      },
    },
  );
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.item.businessSync.status, "synced");
  assert.equal(reviewed.body.item.answerKnowledge.scoringPoints[0].score, 2);
  assert.equal(questionStore.get(question.id).version, 2);

  const incompleteFamily = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/subjective-review-v1/items/subjective-q-1/family",
    {
      method: "PUT",
      body: {
        expectedRevision: 2,
        result: "confirmed_current",
        familyGold: reviewed.body.item.familyGold,
      },
    },
  );
  assert.equal(incompleteFamily.response.status, 422);
  assert.equal(incompleteFamily.body.error, "classification_gold_review_candidate_family_incomplete");

  const disputedFamily = await request(
    baseUrl,
    "/api/admin/knowledge-classification/gold-review/sets/subjective-review-v1/items/subjective-q-1/family",
    {
      method: "PUT",
      body: {
        expectedRevision: 2,
        result: "disputed",
        note: "候选题族的教材锚点和考查动作仍需确认。",
        familyGold: reviewed.body.item.familyGold,
      },
    },
  );
  assert.equal(disputedFamily.response.status, 200);
  assert.equal(disputedFamily.body.item.familyReview.result, "disputed");
});
