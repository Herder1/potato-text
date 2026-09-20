const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const {
  createFileClassificationCommitStore,
  createMemoryClassificationCommitStore,
  requestHash,
} = require("../apps/api/src/classification-commit-store");
const { createClassificationCommitCoordinator } = require("../apps/api/src/classification-commit-coordinator");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");
const { createMemoryKnowledgeDossierStore } = require("../apps/api/src/knowledge-dossier-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");

function buildCommitStores() {
  return {
    knowledgeStructureStore: createMemoryKnowledgeStructureStore(),
    questionFamilyStore: createMemoryQuestionFamilyStore(),
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
    knowledgeClassificationStore: createMemoryKnowledgeClassificationStore(),
    operationLogStore: createMemoryAdminOperationStore(),
  };
}

function capture(stores) {
  return Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, store.exportState()]));
}

function coordinatorFor(stores, commitStore) {
  return createClassificationCommitCoordinator({ commitStore, ...stores });
}

test("classification commit hashes are stable across object key order", () => {
  assert.equal(
    requestHash({ resultIds: ["r1"], selection: { primary: "n1", required: ["n1", "n2"] } }),
    requestHash({ selection: { required: ["n1", "n2"], primary: "n1" }, resultIds: ["r1"] }),
  );
});

test("file classification commits survive store recreation with their original response", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-classification-commit-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "commits.json");
  const hash = requestHash({ resultIds: ["result-1"] });
  createFileClassificationCommitStore(filePath).prepare({
    commitId: "file-persistence",
    requestHash: hash,
    beforeState: { marker: "before" },
  });
  const restartedPrepared = createFileClassificationCommitStore(filePath);
  assert.equal(restartedPrepared.get("file-persistence").status, "prepared");
  restartedPrepared.markCommitted("file-persistence", { success: true, commitId: "file-persistence" });
  const restartedCommitted = createFileClassificationCommitStore(filePath).get("file-persistence");
  assert.equal(restartedCommitted.status, "committed");
  assert.deepEqual(restartedCommitted.response, { success: true, commitId: "file-persistence" });
});

test("classification commit store keeps prepared entries and rejects a second prepared commit", () => {
  const committed = Array.from({ length: 305 }, (_, index) => ({
    commitId: `committed-${index}`,
    requestHash: `hash-${index}`,
    status: "committed",
  }));
  const commitStore = createMemoryClassificationCommitStore({
    commits: [...committed, { commitId: "prepared-kept", requestHash: "prepared-hash", status: "prepared", beforeState: {} }],
  });
  assert.equal(commitStore.get("prepared-kept").status, "prepared");
  assert.throws(() => commitStore.prepare({
    commitId: "another-commit",
    requestHash: "another-hash",
    beforeState: {},
  }), /classification_commit_recovery_required/);
});

test("a failed rollback blocks new commits until recovery succeeds", () => {
  const stores = buildCommitStores();
  const baseOperationStore = stores.operationLogStore;
  let failRestore = true;
  stores.operationLogStore = {
    ...baseOperationStore,
    replaceState(value) {
      if (failRestore) {
        failRestore = false;
        throw new Error("rollback_write_failed");
      }
      return baseOperationStore.replaceState(value);
    },
  };
  const commitStore = createMemoryClassificationCommitStore();
  const coordinator = coordinatorFor(stores, commitStore);
  const hash = requestHash({ resultIds: ["result-1"] });
  coordinator.prepare({ commitId: "rollback-failure", requestHash: hash });
  stores.operationLogStore.append({ action: "mutated", summary: "Mutated operation" });

  assert.throws(() => coordinator.rollback("rollback-failure", new Error("business_write_failed")), /rollback_write_failed/);
  assert.equal(coordinator.isRecoveryRequired(), true);
  assert.throws(() => coordinator.inspect("new-commit", requestHash({ resultIds: ["result-2"] })), /classification_commit_recovery_required/);

  coordinator.recoverPrepared();
  assert.equal(coordinator.isRecoveryRequired(), false);
  assert.equal(commitStore.get("rollback-failure").recovery, "startup_rollback");
  assert.deepEqual(baseOperationStore.exportState(), []);
});

test("createServer rolls back a prepared classification commit before ordinary recovery", () => {
  const stores = buildCommitStores();
  const commitStore = createMemoryClassificationCommitStore();
  const coordinator = coordinatorFor(stores, commitStore);
  const before = capture(stores);
  coordinator.prepare({
    commitId: "startup-recovery",
    requestHash: requestHash({ resultIds: ["result-1"] }),
    bookId: "book-1",
    resultIds: ["result-1"],
  });

  stores.knowledgeStructureStore.replaceState({ records: [{ bookId: "mutated-book" }], editsByBook: {} });
  stores.questionFamilyStore.replaceState({
    families: [{
      id: "family-mutated",
      bookId: "mutated-book",
      name: "Mutated family",
      knowledgeNodeId: "node-1",
      focusKey: "mutated",
      members: [],
      status: "confirmed",
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  stores.knowledgeClassificationExperienceStore.replaceState({
    messages: [{ id: "message-mutated", bookId: "mutated-book", role: "user", content: "mutated", createdAt: 1 }],
    rules: [],
    cases: [],
    corrections: [],
    ruleExceptions: [],
  });
  stores.knowledgeDossierStore.replaceState({
    deltas: [{ id: "delta-mutated", bookId: "mutated-book", type: "exception", title: "Mutated", createdAt: 1, updatedAt: 1 }],
  });
  stores.knowledgeClassificationStore.replaceState({
    jobs: [],
    results: [{ id: "result-mutated", jobId: "job-1", bookId: "mutated-book", questionId: "question-1", status: "rejected" }],
  });
  stores.operationLogStore.replaceState([{ id: "operation-mutated", action: "mutated" }]);

  createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    classificationCommitStore: commitStore,
    ...stores,
  });

  assert.deepEqual(capture(stores), before);
  const recovered = commitStore.get("startup-recovery");
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.recovery, "startup_rollback");
  assert.equal(recovered.error, "server_interrupted");
});

test("PostgreSQL mode refuses classification commits until a native transaction is available", async (context) => {
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    persistence: { flush: async () => {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "ClassificationCommitV1",
      commitId: "postgres-transaction-required",
      resultIds: ["result-1"],
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.error, "classification_commit_postgres_transaction_required");
});
