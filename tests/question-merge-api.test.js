const assert = require("node:assert/strict");
const test = require("node:test");

const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const {
  SCHEMA_VERSION,
  createMemoryQuestionMergeCommitStore,
} = require("../apps/api/src/question-merge-commit-store");
const { createServer } = require("./helpers/admin-auth");

const sourceQuestionId = "question-duplicate-source";
const targetQuestionId = "question-canonical-target";
const bookId = "modern-chinese-7-1";
const familyId = "family-word-meaning-change";
const preferredKnowledgeNodeId = "node-word-meaning-change";

function question(id, stem) {
  return {
    id,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId,
    chapter: "第三章 词汇",
    knowledgePoints: ["词义的演变"],
    primaryKnowledgePoint: "词义的演变",
    subKnowledgePoints: [],
    type: "single_choice",
    typeLabel: "单选题",
    stem,
    options: [
      { key: "A", text: "词义扩大" },
      { key: "B", text: "词义转移" },
    ],
    correctAnswer: ["A"],
    referenceAnswer: "词义扩大",
    maxScore: 2,
    difficultyScore: 40,
    difficultyStars: 2,
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    version: 2,
    versions: [],
    createdAt: 100,
    updatedAt: 200,
  };
}

function stores() {
  const questionStore = createMemoryQuestionStore([
    question(sourceQuestionId, "江河泛指一切江河，它于（ ）。"),
    question(targetQuestionId, "江河泛指一切江河，它属于（ ）。"),
  ]);
  const questionFamilyStore = createMemoryQuestionFamilyStore({
    version: 4,
    families: [{
      id: familyId,
      bookId,
      subjectId: "modern-chinese",
      name: "词义演变考察",
      knowledgeNodeId: preferredKnowledgeNodeId,
      knowledgePath: "词汇 > 词义的演变",
      status: "confirmed",
      members: [
        { questionId: sourceQuestionId, isPrimary: true, role: "prototype", trainingLevel: "foundation", action: "概念识别", confidence: 0.9 },
        { questionId: targetQuestionId, isPrimary: true, role: "variant", trainingLevel: "advanced", action: "分类判断", confidence: 0.8 },
      ],
      createdAt: 100,
      updatedAt: 200,
    }],
    historyByBook: { [bookId]: [] },
    unresolvedByBook: { [bookId]: [] },
    membershipRevisionByQuestion: { [sourceQuestionId]: 1, [targetQuestionId]: 1 },
  });
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore({
    records: [{
      bookId,
      nodes: [{
        id: preferredKnowledgeNodeId,
        bookId,
        kind: "knowledge",
        displayTitle: "词义的演变",
        title: "词义的演变",
        path: "词汇 > 词义的演变",
        knowledgeLevel: 2,
        questionCount: 0,
      }],
      fingerprints: [sourceQuestionId, targetQuestionId].map((questionId) => ({
        questionId,
        bookId,
        primaryNodeId: "old-generic-node",
        primaryKnowledgePoint: "词汇",
        knowledgePath: "词汇 > 词汇概说",
        requiredNodeIds: ["old-generic-node"],
      })),
    }],
    editsByBook: {},
  });
  return {
    questionStore,
    questionFamilyStore,
    knowledgeStructureStore,
    operationLogStore: createMemoryAdminOperationStore(),
    questionMergeCommitStore: createMemoryQuestionMergeCommitStore(),
  };
}

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("admin question merge atomically folds live relationships, offlines the source and replays idempotently", async (context) => {
  const dependencies = stores();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), ...dependencies });
  const baseUrl = await listen(server, context);
  const body = {
    schemaVersion: SCHEMA_VERSION,
    commitId: "merge-api-idempotent",
    targetQuestionId,
    sourceVersion: 2,
    targetVersion: 2,
    reason: "旧导入题干漏字，与规范题内容重复",
    preferredKnowledgeNodeId,
  };
  const firstResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestionId}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.success, true);
  assert.equal(first.replayed, false);
  assert.equal(first.sourceQuestion.status, "offline");
  assert.equal(first.sourceQuestion.mergedIntoQuestionId, targetQuestionId);

  const family = dependencies.questionFamilyStore.get(familyId);
  assert.equal(family.members.filter((member) => member.questionId === targetQuestionId).length, 1);
  assert.equal(family.members.some((member) => member.questionId === sourceQuestionId), false);
  assert.equal(family.members[0].role, "prototype");
  const structure = dependencies.knowledgeStructureStore.get(bookId);
  assert.equal(structure.fingerprints.some((fingerprint) => fingerprint.questionId === sourceQuestionId), false);
  assert.equal(structure.fingerprints.find((fingerprint) => fingerprint.questionId === targetQuestionId).primaryNodeId, preferredKnowledgeNodeId);
  assert.equal(dependencies.operationLogStore.list({ category: "question" }).items.filter((item) => item.action === "question.merge").length, 1);

  const workspace = await fetch(`${baseUrl}/api/admin/question-families?bookId=${bookId}`).then((response) => response.json());
  assert.deepEqual(workspace.ungroupedQuestions, []);
  assert.equal(workspace.summary.unresolvedQuestionCount, 0);
  assert.equal(workspace.families[0].members.filter((member) => member.questionId === targetQuestionId).length, 1);
  assert.equal(workspace.families[0].members.some((member) => member.questionId === sourceQuestionId), false);
  const sourceSearch = await fetch(`${baseUrl}/api/admin/question-families?bookId=${bookId}&query=${encodeURIComponent(sourceQuestionId)}`).then((response) => response.json());
  assert.deepEqual(sourceSearch.ungroupedQuestions, []);

  const archivedBefore = dependencies.questionStore.get(sourceQuestionId);
  const editResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stem: "合并归档后不应再编辑" }),
  });
  assert.equal(editResponse.status, 409);
  assert.equal((await editResponse.json()).error, "question_merged_source_read_only");
  const restoreResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestionId}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "restore" }),
  });
  assert.equal(restoreResponse.status, 409);
  assert.equal((await restoreResponse.json()).error, "question_merged_source_read_only");
  const deleteSourceResponse = await fetch(`${baseUrl}/api/admin/questions/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [sourceQuestionId] }),
  });
  assert.equal(deleteSourceResponse.status, 409);
  assert.equal((await deleteSourceResponse.json()).error, "question_merged_source_read_only");
  const deleteTargetResponse = await fetch(`${baseUrl}/api/admin/questions/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [targetQuestionId] }),
  });
  assert.equal(deleteTargetResponse.status, 409);
  assert.equal((await deleteTargetResponse.json()).error, "question_merge_target_delete_forbidden");
  const structureBeforeRejectedAssignments = dependencies.knowledgeStructureStore.exportState();
  const batchAssignmentResponse = await fetch(`${baseUrl}/api/admin/questions/batch-knowledge-assignment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, questionIds: [sourceQuestionId], primaryNodeId: preferredKnowledgeNodeId }),
  });
  assert.equal(batchAssignmentResponse.status, 409);
  assert.equal((await batchAssignmentResponse.json()).error, "question_merged_source_read_only");
  const directAssignmentResponse = await fetch(`${baseUrl}/api/admin/knowledge-structure/question-assignments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, assignments: [{ questionId: sourceQuestionId, primaryNodeId: preferredKnowledgeNodeId }] }),
  });
  assert.equal(directAssignmentResponse.status, 409);
  assert.equal((await directAssignmentResponse.json()).error, "question_merged_source_read_only");
  const familyAssignmentResponse = await fetch(`${baseUrl}/api/admin/question-families/${familyId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIds: [sourceQuestionId] }),
  });
  assert.equal(familyAssignmentResponse.status, 409);
  assert.equal((await familyAssignmentResponse.json()).error, "question_merged_source_read_only");
  assert.deepEqual(dependencies.knowledgeStructureStore.exportState(), structureBeforeRejectedAssignments);
  assert.equal(dependencies.questionStore.get(sourceQuestionId).version, archivedBefore.version);
  assert.equal(dependencies.questionStore.get(targetQuestionId).id, targetQuestionId);

  const replayResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestionId}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const replay = await replayResponse.json();
  assert.equal(replayResponse.status, 200);
  assert.equal(replay.replayed, true);
  assert.equal(dependencies.operationLogStore.list({ category: "question" }).items.filter((item) => item.action === "question.merge").length, 1);
});

test("question merge refuses the compatibility persistence mode until a native transaction exists", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), persistence: { flush: async () => {} } });
  const baseUrl = await listen(server, context);
  const response = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestionId}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.error, "question_merge_commit_postgres_transaction_required");
});
