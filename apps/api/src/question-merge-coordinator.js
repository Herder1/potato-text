function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const STORE_SPECS = [
  ["questions", "questionStore"],
  ["questionFamilies", "questionFamilyStore"],
  ["knowledgeStructures", "knowledgeStructureStore"],
  ["exams", "examStore"],
  ["packs", "packStore"],
  ["learningState", "learningStateStore"],
  ["knowledgeClassification", "knowledgeClassificationStore"],
  ["questionEnrichment", "questionEnrichmentStore"],
  ["operations", "operationLogStore"],
];

function createQuestionMergeCoordinator(options = {}) {
  const commitStore = options.commitStore;
  if (!commitStore) throw new Error("question_merge_commit_store_required");
  let recoveryRequired = false;
  const stores = STORE_SPECS.map(([stateKey, optionKey]) => [stateKey, options[optionKey]]);
  stores.forEach(([name, store]) => {
    if (!store || typeof store.exportState !== "function" || typeof store.replaceState !== "function") {
      throw new Error(`question_merge_commit_store_incompatible:${name}`);
    }
  });

  const capture = () => Object.fromEntries(stores.map(([name, store]) => [name, store.exportState()]));
  const applyStates = (states) => {
    const source = states && typeof states === "object" ? states : {};
    stores.forEach(([name]) => {
      if (!Object.prototype.hasOwnProperty.call(source, name) || source[name] === undefined) {
        throw new Error(`question_merge_commit_snapshot_missing:${name}`);
      }
    });
    stores.forEach(([name, store]) => {
      store.replaceState(clone(source[name]));
    });
    return capture();
  };
  const restore = (beforeState) => {
    const source = beforeState && typeof beforeState === "object" ? beforeState : {};
    [...stores].reverse().forEach(([name, store]) => {
      if (!Object.prototype.hasOwnProperty.call(source, name)) throw new Error(`question_merge_commit_snapshot_missing:${name}`);
      store.replaceState(clone(source[name]));
    });
  };

  const coordinator = {
    capture,
    applyStates,
    inspect(commitId, hash) {
      if (recoveryRequired) {
        const error = new Error("question_merge_commit_recovery_required");
        error.statusCode = 503;
        throw error;
      }
      const existing = commitStore.get(commitId);
      if (!existing) return { action: "new", commit: null };
      if (existing.requestHash !== hash) {
        const error = new Error("question_merge_commit_request_mismatch");
        error.statusCode = 409;
        throw error;
      }
      if (existing.status === "committed") return { action: "replay", commit: existing };
      if (existing.status === "prepared") {
        const error = new Error("question_merge_commit_recovery_required");
        error.statusCode = 503;
        throw error;
      }
      return { action: "retry", commit: existing };
    },
    prepare(input) {
      if (recoveryRequired) {
        const error = new Error("question_merge_commit_recovery_required");
        error.statusCode = 503;
        throw error;
      }
      return commitStore.prepare({ ...input, beforeState: capture() });
    },
    commit(commitId, response) {
      if (recoveryRequired) {
        const error = new Error("question_merge_commit_recovery_required");
        error.statusCode = 503;
        throw error;
      }
      return commitStore.markCommitted(commitId, response);
    },
    rollback(commitId, error, recovery = "rolled_back") {
      const prepared = commitStore.get(commitId);
      if (!prepared || prepared.status !== "prepared") return prepared;
      try {
        restore(prepared.beforeState);
        return commitStore.markFailed(commitId, error, recovery);
      } catch (rollbackError) {
        recoveryRequired = true;
        throw rollbackError;
      }
    },
    recoverPrepared() {
      const recovered = [];
      try {
        commitStore.list({ status: "prepared" }).forEach((commit) => {
          restore(commit.beforeState);
          recovered.push(commitStore.markFailed(commit.commitId, "server_interrupted", "startup_rollback"));
        });
        recoveryRequired = false;
      } catch (error) {
        recoveryRequired = true;
        throw error;
      }
      return recovered;
    },
    async execute(input = {}, transform) {
      if (typeof transform !== "function") throw new Error("question_merge_commit_transform_required");
      const commitId = String(input.commitId || "").trim();
      const hash = String(input.requestHash || "").trim();
      const inspection = this.inspect(commitId, hash);
      if (inspection.action === "replay") {
        return { replayed: true, response: clone(inspection.commit.response), commit: inspection.commit };
      }
      const prepared = this.prepare(input);
      try {
        const outcome = await transform({
          beforeState: clone(prepared.beforeState),
          currentState: capture(),
          stores: Object.fromEntries(STORE_SPECS.flatMap(([stateKey, optionKey], index) => [
            [stateKey, stores[index][1]],
            [optionKey, stores[index][1]],
          ])),
          commit: clone(prepared),
        });
        if (outcome && Object.prototype.hasOwnProperty.call(outcome, "states")) this.applyStates(outcome.states);
        const response = outcome && Object.prototype.hasOwnProperty.call(outcome, "response")
          ? outcome.response
          : (outcome || { success: true, commitId });
        const committed = this.commit(commitId, response);
        return { replayed: false, response: clone(response), commit: committed };
      } catch (error) {
        this.rollback(commitId, error);
        throw error;
      }
    },
    isRecoveryRequired() {
      return recoveryRequired;
    },
  };
  return coordinator;
}

module.exports = { STORE_SPECS, createQuestionMergeCoordinator };
