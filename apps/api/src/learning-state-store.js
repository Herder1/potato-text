const fs = require("node:fs");
const path = require("node:path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialState() {
  return { accounts: [] };
}

function mergeReviewHistory(left = [], right = []) {
  const map = new Map();
  [...left, ...right].forEach((entry) => {
    if (!entry || !entry.id || !entry.questionId) return;
    const existing = map.get(entry.id);
    if (!existing || Number(entry.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
      map.set(entry.id, clone(entry));
    }
  });
  return [...map.values()].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)).slice(0, 1000);
}

function mergeAttempts(left = [], right = []) {
  const map = new Map();
  [...left, ...right].forEach((attempt) => {
    if (!attempt || !attempt.questionId || !Number(attempt.createdAt)) return;
    const key = String(attempt.id || `${attempt.questionId}:${attempt.createdAt}`);
    const existing = map.get(key);
    const attemptUpdatedAt = Number(attempt.updatedAt || attempt.createdAt || 0);
    const existingUpdatedAt = Number(existing && (existing.updatedAt || existing.createdAt) || 0);
    if (!existing || attemptUpdatedAt >= existingUpdatedAt) map.set(key, clone(attempt));
  });
  return [...map.values()].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 1000);
}

function mergeReviewStates(left = {}, right = {}) {
  const result = {};
  const ids = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  ids.forEach((id) => {
    const first = left[id];
    const second = right[id];
    result[id] = !first || Number(second && second.lastReviewAt) >= Number(first.lastReviewAt) ? clone(second || first) : clone(first);
  });
  return result;
}

function mergeBookmarks(left = {}, right = {}) {
  const result = {};
  const ids = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  ids.forEach((id) => {
    const first = left[id];
    const second = right[id];
    result[id] = !first || Number(second && second.updatedAt) >= Number(first.updatedAt) ? clone(second || first) : clone(first);
  });
  return result;
}

function remapActiveQuestion(map = {}, sourceQuestionId, targetQuestionId, timestampField) {
  const result = clone(map || {});
  if (!Object.prototype.hasOwnProperty.call(result, sourceQuestionId)) return { value: result, changed: false };
  const sourceState = result[sourceQuestionId];
  const targetState = result[targetQuestionId];
  const selected = !targetState || Number(sourceState && sourceState[timestampField]) > Number(targetState[timestampField])
    ? clone(sourceState)
    : clone(targetState);
  if (selected && typeof selected === "object" && selected.questionId === sourceQuestionId) selected.questionId = targetQuestionId;
  delete result[sourceQuestionId];
  result[targetQuestionId] = selected;
  return { value: result, changed: true };
}

function mergeScoreHistory(left = [], right = []) {
  const map = new Map();
  [...left, ...right].forEach((entry) => {
    if (!entry || !entry.questionId) return;
    const key = String(entry.requestId || `${entry.questionId}:${entry.createdAt || entry.scoredAt || 0}`);
    if (!map.has(key)) map.set(key, clone(entry));
  });
  return [...map.values()].sort((a, b) => Number(b.createdAt || b.scoredAt) - Number(a.createdAt || a.scoredAt)).slice(0, 200);
}

function normalizeIncoming(payload = {}) {
  return {
    attempts: Array.isArray(payload.attempts) ? payload.attempts : [],
    reviewStates: payload.reviewStates && typeof payload.reviewStates === "object" && !Array.isArray(payload.reviewStates) ? payload.reviewStates : {},
    reviewHistory: Array.isArray(payload.reviewHistory) ? payload.reviewHistory : [],
    bookmarks: payload.bookmarks && typeof payload.bookmarks === "object" && !Array.isArray(payload.bookmarks) ? payload.bookmarks : {},
    savedKnowledgeIds: Array.isArray(payload.savedKnowledgeIds) ? [...new Set(payload.savedKnowledgeIds.map(String).filter(Boolean))].slice(0, 1000) : [],
    scoreHistory: Array.isArray(payload.scoreHistory) ? payload.scoreHistory : [],
    reminder: payload.reminder && typeof payload.reminder === "object" ? payload.reminder : null,
  };
}

function publicState(account) {
  const bookmarks = clone(account.bookmarks || {});
  return {
    attempts: clone(account.attempts || []),
    reviewStates: clone(account.reviewStates || {}),
    reviewHistory: clone(account.reviewHistory || []),
    bookmarks,
    favoriteIds: Object.entries(bookmarks).filter(([, state]) => state && state.value === true).map(([id]) => id),
    savedKnowledgeIds: clone(account.savedKnowledgeIds || []),
    scoreHistory: clone(account.scoreHistory || []),
    reminder: clone(account.reminder || { enabled: false, time: "20:00", updatedAt: 0 }),
    updatedAt: account.updatedAt,
  };
}

function createLearningStateStore(adapter) {
  const read = () => clone(adapter.read());
  const write = (state) => adapter.write(clone(state));
  return {
    exportState: () => clone(adapter.read()),
    replaceState(state) {
      if (!state || typeof state !== "object" || !Array.isArray(state.accounts)) throw new Error("learning_state_invalid");
      write(state);
      return clone(adapter.read());
    },
    get(userId) {
      const account = read().accounts.find((item) => item.userId === userId);
      return account ? publicState(account) : publicState({});
    },

    merge(userId, payload, now = Date.now()) {
      const state = read();
      let account = state.accounts.find((item) => item.userId === userId);
      if (!account) {
        account = { userId, attempts: [], reviewStates: {}, reviewHistory: [], bookmarks: {}, savedKnowledgeIds: [], scoreHistory: [], reminder: null, createdAt: now, updatedAt: now };
        state.accounts.push(account);
      }
      const incoming = normalizeIncoming(payload);
      account.attempts = mergeAttempts(account.attempts, incoming.attempts);
      account.reviewStates = mergeReviewStates(account.reviewStates, incoming.reviewStates);
      account.reviewHistory = mergeReviewHistory(account.reviewHistory, incoming.reviewHistory);
      account.bookmarks = mergeBookmarks(account.bookmarks, incoming.bookmarks);
      account.savedKnowledgeIds = [...new Set([...account.savedKnowledgeIds, ...incoming.savedKnowledgeIds])].slice(0, 1000);
      account.scoreHistory = mergeScoreHistory(account.scoreHistory, incoming.scoreHistory);
      if (incoming.reminder && Number(incoming.reminder.updatedAt) >= Number(account.reminder && account.reminder.updatedAt)) {
        account.reminder = {
          enabled: incoming.reminder.enabled === true,
          time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(incoming.reminder.time || "")) ? incoming.reminder.time : "20:00",
          subscriptionAccepted: incoming.reminder.subscriptionAccepted === true,
          updatedAt: Number(incoming.reminder.updatedAt) || now,
        };
      }
      account.updatedAt = now;
      write(state);
      return publicState(account);
    },

    remapActiveQuestions(userId, mappings = [], now = Date.now()) {
      const state = read();
      const account = state.accounts.find((item) => item.userId === userId);
      if (!account) return publicState({});
      let changed = false;
      (Array.isArray(mappings) ? mappings : []).forEach((mapping) => {
        const sourceQuestionId = String(mapping && mapping.sourceQuestionId || "");
        const targetQuestionId = String(mapping && mapping.targetQuestionId || "");
        if (!sourceQuestionId || !targetQuestionId || sourceQuestionId === targetQuestionId) return;
        const reviewStates = remapActiveQuestion(account.reviewStates, sourceQuestionId, targetQuestionId, "lastReviewAt");
        const bookmarks = remapActiveQuestion(account.bookmarks, sourceQuestionId, targetQuestionId, "updatedAt");
        if (!reviewStates.changed && !bookmarks.changed) return;
        account.reviewStates = reviewStates.value;
        account.bookmarks = bookmarks.value;
        changed = true;
      });
      if (changed) {
        account.updatedAt = now;
        write(state);
      }
      return publicState(account);
    },

    deleteUser(userId) {
      const state = read();
      const before = state.accounts.length;
      state.accounts = state.accounts.filter((item) => item.userId !== userId);
      if (state.accounts.length !== before) write(state);
      return state.accounts.length !== before;
    },
  };
}

function createFileLearningStateStore(filePath = path.resolve(__dirname, "../../../.runtime/learning-state.json")) {
  return createLearningStateStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return initialState(); throw error; }
    },
    write(state) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryLearningStateStore(state = initialState()) {
  let value = clone(state);
  return createLearningStateStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = { createFileLearningStateStore, createMemoryLearningStateStore, initialState };
