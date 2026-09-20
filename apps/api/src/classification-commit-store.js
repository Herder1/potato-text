const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = "ClassificationCommitV1";
const MAX_COMMITS = 300;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function requestHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function normalizeState(value) {
  const input = value && typeof value === "object" ? value : {};
  let retainedCount = 0;
  const commits = [];
  (Array.isArray(input.commits) ? input.commits : []).filter((item) => item && item.commitId).forEach((item) => {
    if (item.status === "prepared" || retainedCount < MAX_COMMITS) {
      commits.push(item);
      if (item.status !== "prepared") retainedCount += 1;
    }
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    commits,
  };
}

function createClassificationCommitStore(adapter) {
  const read = () => normalizeState(adapter.read());
  const write = (state) => adapter.write(normalizeState(state));
  const get = (commitId) => read().commits.find((item) => item.commitId === String(commitId || ""));
  return {
    exportState: () => clone(read()),
    get(commitId) {
      const item = get(commitId);
      return item ? clone(item) : null;
    },
    list(filters = {}) {
      const status = String(filters.status || "all");
      return read().commits.filter((item) => status === "all" || item.status === status).map(clone);
    },
    prepare(input = {}) {
      const commitId = String(input.commitId || "").trim();
      const hash = String(input.requestHash || "").trim();
      if (!commitId || !hash) throw new Error("classification_commit_identity_required");
      const state = read();
      const existing = state.commits.find((item) => item.commitId === commitId);
      if (existing && existing.requestHash !== hash) throw new Error("classification_commit_request_mismatch");
      if (existing?.status === "committed" || existing?.status === "prepared") return clone(existing);
      const blocking = state.commits.find((item) => item.status === "prepared" && item.commitId !== commitId);
      if (blocking) {
        const error = new Error("classification_commit_recovery_required");
        error.statusCode = 503;
        throw error;
      }
      const now = Date.now();
      const prepared = {
        schemaVersion: SCHEMA_VERSION,
        commitId,
        requestHash: hash,
        status: "prepared",
        mode: String(input.mode || "file_rollback"),
        bookId: String(input.bookId || ""),
        resultIds: [...new Set((Array.isArray(input.resultIds) ? input.resultIds : []).map(String).filter(Boolean))],
        actor: String(input.actor || ""),
        dependencies: clone(input.dependencies || {}),
        reviewSelections: clone(input.reviewSelections || []),
        request: clone(input.request || {}),
        beforeState: clone(input.beforeState || {}),
        response: null,
        error: "",
        recovery: "",
        attempt: Number(existing?.attempt || 0) + 1,
        createdAt: Number(existing?.createdAt) || now,
        updatedAt: now,
        committedAt: null,
        failedAt: null,
      };
      state.commits = [prepared, ...state.commits.filter((item) => item.commitId !== commitId)];
      write(state);
      return clone(prepared);
    },
    markCommitted(commitId, response) {
      const state = read();
      const index = state.commits.findIndex((item) => item.commitId === String(commitId || ""));
      if (index < 0) throw new Error("classification_commit_not_found");
      const now = Date.now();
      state.commits[index] = {
        ...state.commits[index],
        status: "committed",
        response: clone(response || {}),
        beforeState: null,
        error: "",
        recovery: "",
        updatedAt: now,
        committedAt: now,
        failedAt: null,
      };
      write(state);
      return clone(state.commits[index]);
    },
    markFailed(commitId, error, recovery = "rolled_back") {
      const state = read();
      const index = state.commits.findIndex((item) => item.commitId === String(commitId || ""));
      if (index < 0) throw new Error("classification_commit_not_found");
      const now = Date.now();
      state.commits[index] = {
        ...state.commits[index],
        status: "failed",
        beforeState: null,
        response: null,
        error: String(error?.message || error || "classification_commit_failed").slice(0, 500),
        recovery: String(recovery || "rolled_back").slice(0, 80),
        updatedAt: now,
        failedAt: now,
      };
      write(state);
      return clone(state.commits[index]);
    },
  };
}

function createFileClassificationCommitStore(filePath = path.resolve(__dirname, "../../../.runtime/classification-commits.json")) {
  return createClassificationCommitStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { schemaVersion: SCHEMA_VERSION, commits: [] }; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryClassificationCommitStore(initialState = { schemaVersion: SCHEMA_VERSION, commits: [] }) {
  let state = clone(initialState);
  return createClassificationCommitStore({ read: () => clone(state), write: (next) => { state = clone(next); } });
}

module.exports = {
  SCHEMA_VERSION,
  createFileClassificationCommitStore,
  createMemoryClassificationCommitStore,
  requestHash,
};
