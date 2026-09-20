const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryExamStore } = require("../apps/api/src/exam-store");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryLearningStateStore } = require("../apps/api/src/learning-state-store");
const { createMemoryPackStore } = require("../apps/api/src/pack-store");
const { createQuestionMergeCoordinator } = require("../apps/api/src/question-merge-coordinator");
const {
  SCHEMA_VERSION,
  createFileQuestionMergeCommitStore,
  createMemoryQuestionMergeCommitStore,
  requestHash,
} = require("../apps/api/src/question-merge-commit-store");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");

function buildStores() {
  return {
    questionStore: createMemoryQuestionStore([]),
    questionFamilyStore: createMemoryQuestionFamilyStore(),
    knowledgeStructureStore: createMemoryKnowledgeStructureStore(),
    examStore: createMemoryExamStore([]),
    packStore: createMemoryPackStore([]),
    learningStateStore: createMemoryLearningStateStore(),
    knowledgeClassificationStore: createMemoryKnowledgeClassificationStore(),
    questionEnrichmentStore: createMemoryQuestionEnrichmentStore(),
    operationLogStore: createMemoryAdminOperationStore(),
  };
}

function coordinatorFor(stores, commitStore = createMemoryQuestionMergeCommitStore()) {
  return createQuestionMergeCoordinator({ commitStore, ...stores });
}

function stateWithMarkers(base, marker) {
  return {
    ...base,
    questions: [{ id: `question-${marker}`, marker }],
    questionFamilies: {
      ...base.questionFamilies,
      unresolvedByBook: {},
      membershipRevisionByQuestion: {
        ...(base.questionFamilies.membershipRevisionByQuestion || {}),
        [`question-${marker}`]: 1,
      },
    },
    knowledgeStructures: { version: 1, records: [], editsByBook: { [`book-${marker}`]: {} } },
    exams: [{ id: `exam-${marker}`, marker }],
    packs: [{ id: `pack-${marker}`, marker }],
    learningState: { accounts: [{ userId: `user-${marker}`, marker }] },
    knowledgeClassification: { jobs: [], results: [{ id: `result-${marker}`, questionId: `question-${marker}`, marker }] },
    questionEnrichment: { suggestions: [], jobs: [{ id: `job-${marker}`, questionIds: [], marker }] },
    operations: [{ id: `operation-${marker}`, marker }],
  };
}

test("question merge hashes are stable across object key order", () => {
  assert.equal(SCHEMA_VERSION, "QuestionMergeCommitV1");
  assert.equal(
    requestHash({ sourceQuestionId: "q-old", targetQuestionId: "q-new", versions: { source: 1, target: 2 } }),
    requestHash({ versions: { target: 2, source: 1 }, targetQuestionId: "q-new", sourceQuestionId: "q-old" }),
  );
});

test("file question merge commits preserve prepared and committed records across recreation", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-question-merge-commit-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "commits.json");
  const hash = requestHash({ sourceQuestionId: "q-old", targetQuestionId: "q-new" });
  createFileQuestionMergeCommitStore(filePath).prepare({
    commitId: "file-question-merge",
    requestHash: hash,
    sourceQuestionId: "q-old",
    targetQuestionId: "q-new",
    beforeState: { questions: [] },
  });

  const restarted = createFileQuestionMergeCommitStore(filePath);
  assert.equal(restarted.get("file-question-merge").status, "prepared");
  restarted.markCommitted("file-question-merge", { success: true, targetQuestionId: "q-new" });
  const committed = createFileQuestionMergeCommitStore(filePath).get("file-question-merge");
  assert.equal(committed.status, "committed");
  assert.equal(committed.beforeState, null);
  assert.deepEqual(committed.response, { success: true, targetQuestionId: "q-new" });
});

test("merge coordinator snapshots and applies every live question reference store", () => {
  const stores = buildStores();
  const coordinator = coordinatorFor(stores);
  const before = coordinator.capture();
  const next = stateWithMarkers(before, "next");

  const applied = coordinator.applyStates(next);
  assert.deepEqual(applied, coordinator.capture());
  assert.equal(stores.questionStore.exportState()[0].id, "question-next");
  assert.equal(stores.examStore.exportState()[0].id, "exam-next");
  assert.equal(stores.packStore.exportState()[0].id, "pack-next");
  assert.equal(stores.learningStateStore.exportState().accounts[0].userId, "user-next");
  assert.equal(stores.questionEnrichmentStore.exportState().jobs[0].id, "job-next");
  assert.equal(stores.questionFamilyStore.exportState().membershipRevisionByQuestion["question-next"], 1);
  assert.deepEqual(stores.questionFamilyStore.exportState().unresolvedByBook, {});
  assert.throws(() => coordinator.applyStates({ ...next, exams: undefined }), /question_merge_commit_snapshot_missing:exams/);
  const { operations, ...missingOperations } = next;
  assert.ok(operations);
  assert.throws(() => coordinator.applyStates(missingOperations), /question_merge_commit_snapshot_missing:operations/);
});

test("execute commits once and replays the first response for the same request", async () => {
  const stores = buildStores();
  const commitStore = createMemoryQuestionMergeCommitStore();
  const coordinator = coordinatorFor(stores, commitStore);
  const request = { sourceQuestionId: "q-old", targetQuestionId: "q-new", reason: "OCR duplicate" };
  const hash = requestHash(request);
  let runs = 0;

  const first = await coordinator.execute({
    commitId: "merge-idempotent",
    requestHash: hash,
    request,
    sourceQuestionId: "q-old",
    targetQuestionId: "q-new",
  }, ({ beforeState }) => {
    runs += 1;
    return {
      states: stateWithMarkers(beforeState, "committed"),
      response: { success: true, sourceQuestionId: "q-old", targetQuestionId: "q-new" },
    };
  });
  assert.equal(first.replayed, false);
  assert.equal(commitStore.get("merge-idempotent").status, "committed");
  assert.equal(stores.questionStore.exportState()[0].id, "question-committed");

  const replay = await coordinator.execute({ commitId: "merge-idempotent", requestHash: hash }, () => {
    runs += 1;
    throw new Error("replay_must_not_run_transform");
  });
  assert.equal(replay.replayed, true);
  assert.equal(runs, 1);
  assert.deepEqual(replay.response, first.response);

  await assert.rejects(
    coordinator.execute({ commitId: "merge-idempotent", requestHash: requestHash({ different: true }) }, () => ({})),
    /question_merge_commit_request_mismatch/,
  );
});

test("execute rolls every store back when a merge transform fails", async () => {
  const stores = buildStores();
  const commitStore = createMemoryQuestionMergeCommitStore();
  const coordinator = coordinatorFor(stores, commitStore);
  const before = coordinator.capture();

  await assert.rejects(coordinator.execute({
    commitId: "merge-rolls-back",
    requestHash: requestHash({ sourceQuestionId: "q-old", targetQuestionId: "q-new" }),
    sourceQuestionId: "q-old",
    targetQuestionId: "q-new",
  }, ({ stores: mutable }) => {
    mutable.questionStore.replaceState([{ id: "mutated-question" }]);
    mutable.examStore.replaceState([{ id: "mutated-exam" }]);
    mutable.operationLogStore.replaceState([{ id: "mutated-operation" }]);
    throw new Error("merge_reference_write_failed");
  }), /merge_reference_write_failed/);

  assert.deepEqual(coordinator.capture(), before);
  const failed = commitStore.get("merge-rolls-back");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "merge_reference_write_failed");
  assert.equal(failed.recovery, "rolled_back");
});

test("startup recovery restores every store from a prepared merge", () => {
  const stores = buildStores();
  const commitStore = createMemoryQuestionMergeCommitStore();
  const coordinator = coordinatorFor(stores, commitStore);
  const before = coordinator.capture();
  coordinator.prepare({
    commitId: "merge-startup-recovery",
    requestHash: requestHash({ sourceQuestionId: "q-old", targetQuestionId: "q-new" }),
    sourceQuestionId: "q-old",
    targetQuestionId: "q-new",
  });
  coordinator.applyStates(stateWithMarkers(before, "interrupted"));

  const recovered = coordinator.recoverPrepared();
  assert.equal(recovered.length, 1);
  assert.deepEqual(coordinator.capture(), before);
  assert.equal(commitStore.get("merge-startup-recovery").status, "failed");
  assert.equal(commitStore.get("merge-startup-recovery").recovery, "startup_rollback");
});

test("a failed merge rollback blocks new commits until startup recovery succeeds", () => {
  const stores = buildStores();
  const baseOperations = stores.operationLogStore;
  let failRestore = true;
  stores.operationLogStore = {
    ...baseOperations,
    replaceState(state) {
      if (failRestore) {
        failRestore = false;
        throw new Error("merge_rollback_write_failed");
      }
      return baseOperations.replaceState(state);
    },
  };
  const commitStore = createMemoryQuestionMergeCommitStore();
  const coordinator = coordinatorFor(stores, commitStore);
  coordinator.prepare({
    commitId: "merge-rollback-failure",
    requestHash: requestHash({ sourceQuestionId: "q-old", targetQuestionId: "q-new" }),
  });
  baseOperations.replaceState([{ id: "mutated-operation" }]);

  assert.throws(() => coordinator.rollback("merge-rollback-failure", new Error("merge_failed")), /merge_rollback_write_failed/);
  assert.equal(coordinator.isRecoveryRequired(), true);
  assert.throws(() => coordinator.inspect("new-merge", requestHash({ another: true })), /question_merge_commit_recovery_required/);

  coordinator.recoverPrepared();
  assert.equal(coordinator.isRecoveryRequired(), false);
  assert.equal(commitStore.get("merge-rollback-failure").recovery, "startup_rollback");
  assert.deepEqual(baseOperations.exportState(), []);
});
