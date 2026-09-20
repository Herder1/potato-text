function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createClassificationCommitCoordinator(options = {}) {
  const commitStore = options.commitStore;
  if (!commitStore) throw new Error("classification_commit_store_required");
  let recoveryRequired = false;
  const stores = [
    ["knowledgeStructure", options.knowledgeStructureStore],
    ["questionFamilies", options.questionFamilyStore],
    ["experience", options.knowledgeClassificationExperienceStore],
    ["dossiers", options.knowledgeDossierStore],
    ["classification", options.knowledgeClassificationStore],
    ["operations", options.operationLogStore],
  ];
  stores.forEach(([name, store]) => {
    if (!store || typeof store.exportState !== "function" || typeof store.replaceState !== "function") {
      throw new Error(`classification_commit_store_incompatible:${name}`);
    }
  });
  const capture = () => Object.fromEntries(stores.map(([name, store]) => [name, store.exportState()]));
  const restore = (beforeState) => {
    const source = beforeState && typeof beforeState === "object" ? beforeState : {};
    [...stores].reverse().forEach(([name, store]) => {
      if (!Object.prototype.hasOwnProperty.call(source, name)) throw new Error(`classification_commit_snapshot_missing:${name}`);
      store.replaceState(clone(source[name]));
    });
  };
  return {
    inspect(commitId, requestHash) {
      if (recoveryRequired) {
        const error = new Error("classification_commit_recovery_required");
        error.statusCode = 503;
        throw error;
      }
      const existing = commitStore.get(commitId);
      if (!existing) return { action: "new", commit: null };
      if (existing.requestHash !== requestHash) {
        const error = new Error("classification_commit_request_mismatch");
        error.statusCode = 409;
        throw error;
      }
      if (existing.status === "committed") return { action: "replay", commit: existing };
      if (existing.status === "prepared") {
        const error = new Error("classification_commit_recovery_required");
        error.statusCode = 503;
        throw error;
      }
      return { action: "retry", commit: existing };
    },
    prepare(input) {
      if (recoveryRequired) {
        const error = new Error("classification_commit_recovery_required");
        error.statusCode = 503;
        throw error;
      }
      return commitStore.prepare({ ...input, beforeState: capture() });
    },
    commit(commitId, response) {
      if (recoveryRequired) {
        const error = new Error("classification_commit_recovery_required");
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
    isRecoveryRequired() {
      return recoveryRequired;
    },
  };
}

module.exports = { createClassificationCommitCoordinator };
