const fs = require("node:fs");
const path = require("node:path");

const MAX_ENTRIES = 2000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeEntry(entry) {
  if (!entry || !entry.key || !entry.result) return null;
  return {
    key: String(entry.key),
    questionId: String(entry.questionId || ""),
    model: String(entry.model || ""),
    result: clone(entry.result),
    createdAt: Number(entry.createdAt) || Date.now(),
  };
}

function createCacheStore(adapter) {
  const read = () => adapter.read().map(normalizeEntry).filter(Boolean);
  const write = (entries) => adapter.write(entries.slice(0, MAX_ENTRIES));
  return {
    exportState: () => clone(adapter.read()),
    get(key) {
      const entry = read().find((item) => item.key === key);
      return entry ? clone(entry) : null;
    },
    set(entry) {
      const normalized = normalizeEntry({ ...entry, createdAt: Date.now() });
      if (!normalized) throw new Error("invalid_score_cache_entry");
      write([normalized, ...read().filter((item) => item.key !== normalized.key)]);
      return clone(normalized);
    },
  };
}

function createFileAiScoreCacheStore(filePath = path.resolve(__dirname, "../../../.runtime/ai-score-cache.json")) {
  return createCacheStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(value) ? value : [];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return [];
      }
    },
    write(entries) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryAiScoreCacheStore(initialEntries = []) {
  let entries = clone(initialEntries);
  return createCacheStore({
    read: () => clone(entries),
    write: (nextEntries) => { entries = clone(nextEntries); },
  });
}

module.exports = {
  createFileAiScoreCacheStore,
  createMemoryAiScoreCacheStore,
};
