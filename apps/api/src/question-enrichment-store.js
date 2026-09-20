const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { subjectiveQuestionTypes } = require("./scoring-point-structure");
const { SUGGESTION_SOURCES, normalizeSuggestionSource } = require("./suggestion-lifecycle");

const MAX_SUGGESTIONS = 5000;
const MAX_JOBS = 200;
const placeholderPattern = /^(?:待归类|未归类|待补充|未知|暂无|无)$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlaceholder(value) {
  return !String(value || "").trim() || placeholderPattern.test(String(value || "").trim());
}

function questionEnrichmentNeeds(question = {}) {
  const knowledgePoints = Array.isArray(question.knowledgePoints) ? question.knowledgePoints : [];
  const needsChapter = isPlaceholder(question.chapter);
  const needsKnowledgePoints = !knowledgePoints.length || knowledgePoints.every(isPlaceholder);
  const needsScoringPoints = subjectiveQuestionTypes.has(question.type)
    && question.scoringPointStatus !== "complete";
  const needs = [
    needsChapter && "chapter",
    needsKnowledgePoints && "knowledge_points",
    needsScoringPoints && "scoring_points",
  ].filter(Boolean);
  return {
    needs,
    needsChapter,
    needsKnowledgePoints,
    needsScoringPoints,
    complete: needs.length === 0,
  };
}

function normalizeEvidence(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    chunkId: String(item && item.chunkId || ""),
    printedPage: String(item && item.printedPage || ""),
    catalogPath: String(item && item.catalogPath || ""),
    excerpt: String(item && item.excerpt || "").trim().slice(0, 1200),
  })).filter((item) => item.chunkId || item.excerpt).slice(0, 12);
}

function normalizeSuggestion(input = {}) {
  const now = Date.now();
  return {
    id: String(input.id || `enrichment-${crypto.randomUUID()}`),
    questionId: String(input.questionId || ""),
    questionVersion: Math.max(1, Number(input.questionVersion) || 1),
    // 建议来源标识（与 AI 巡检共用一套词汇），供统一入口分流与筛选
    source: normalizeSuggestionSource(input.source, SUGGESTION_SOURCES.QUESTION_ENRICHMENT),
    status: ["recommended", "applied", "reverted", "rejected", "failed", "stale"].includes(input.status)
      ? input.status : "recommended",
    chapterNodeId: String(input.chapterNodeId || ""),
    catalogPath: String(input.catalogPath || ""),
    knowledgePoints: (Array.isArray(input.knowledgePoints) ? input.knowledgePoints : [])
      .map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20),
    scoringPoints: (Array.isArray(input.scoringPoints) ? input.scoringPoints : []).map((point) => ({
      description: String(point && point.description || "").trim(),
      score: Number(point && point.score),
      textbookPage: String(point && point.textbookPage || "").trim().slice(0, 100),
      pageBasis: ["confirmed_catalog", "textbook_text", "manual"].includes(point && point.pageBasis)
        ? point.pageBasis : "",
      sourceNote: String(point && point.sourceNote || "").trim().slice(0, 500),
    })).filter((point) => point.description && Number.isFinite(point.score) && point.score > 0).slice(0, 30),
    confidence: Math.min(1, Math.max(0, Number(input.confidence) || 0)),
    reason: String(input.reason || "").trim().slice(0, 2000),
    uncertainty: String(input.uncertainty || "").trim().slice(0, 1000),
    evidence: normalizeEvidence(input.evidence),
    model: String(input.model || ""),
    promptVersion: Math.max(1, Number(input.promptVersion) || 1),
    jobId: String(input.jobId || ""),
    error: String(input.error || "").slice(0, 500),
    appliedFields: (Array.isArray(input.appliedFields) ? input.appliedFields : []).map(String),
    appliedVersion: Math.max(0, Number(input.appliedVersion) || 0),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    appliedAt: input.appliedAt ? Number(input.appliedAt) : null,
  };
}

function normalizeJob(input = {}) {
  const now = Date.now();
  const questionIds = [...new Set((Array.isArray(input.questionIds) ? input.questionIds : []).map(String).filter(Boolean))];
  return {
    id: String(input.id || `enrichment-job-${crypto.randomUUID()}`),
    status: ["queued", "running", "completed", "partial", "failed", "interrupted"].includes(input.status)
      ? input.status : "queued",
    questionIds,
    total: questionIds.length,
    completed: Math.min(questionIds.length, Math.max(0, Number(input.completed) || 0)),
    succeeded: Math.max(0, Number(input.succeeded) || 0),
    failed: Math.max(0, Number(input.failed) || 0),
    currentQuestionId: String(input.currentQuestionId || ""),
    error: String(input.error || "").slice(0, 500),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    startedAt: input.startedAt ? Number(input.startedAt) : null,
    finishedAt: input.finishedAt ? Number(input.finishedAt) : null,
  };
}

function normalizeState(value) {
  return {
    suggestions: (Array.isArray(value && value.suggestions) ? value.suggestions : []).map(normalizeSuggestion),
    jobs: (Array.isArray(value && value.jobs) ? value.jobs : []).map(normalizeJob),
  };
}

function createQuestionEnrichmentStore(adapter) {
  const read = () => normalizeState(adapter.read());
  const write = (state) => adapter.write({
    suggestions: state.suggestions.slice(0, MAX_SUGGESTIONS),
    jobs: state.jobs.slice(0, MAX_JOBS),
  });
  return {
    exportState: () => clone(read()),
    replaceState(state) {
      write(normalizeState(state));
      return clone(read());
    },
    latest(questionId) {
      const suggestion = read().suggestions.find((item) => item.questionId === questionId);
      return suggestion ? clone(suggestion) : null;
    },
    getSuggestion(id) {
      const suggestion = read().suggestions.find((item) => item.id === id);
      return suggestion ? clone(suggestion) : null;
    },
    suggestions(filters = {}) {
      return read().suggestions.filter((item) => {
        if (filters.questionId && item.questionId !== filters.questionId) return false;
        if (filters.status && filters.status !== "all" && item.status !== filters.status) return false;
        if (filters.jobId && item.jobId !== filters.jobId) return false;
        return true;
      }).map(clone);
    },
    addSuggestion(input) {
      const state = read();
      const suggestion = normalizeSuggestion(input);
      state.suggestions = [suggestion, ...state.suggestions.filter((item) => item.id !== suggestion.id)];
      write(state);
      return clone(suggestion);
    },
    updateSuggestion(id, patch = {}) {
      const state = read();
      const index = state.suggestions.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("question_enrichment_suggestion_not_found");
      state.suggestions[index] = normalizeSuggestion({
        ...state.suggestions[index],
        ...patch,
        id,
        updatedAt: Date.now(),
      });
      write(state);
      return clone(state.suggestions[index]);
    },
    createJob(questionIds) {
      const state = read();
      const job = normalizeJob({ questionIds, status: "queued" });
      state.jobs = [job, ...state.jobs];
      write(state);
      return clone(job);
    },
    getJob(id) {
      const job = read().jobs.find((item) => item.id === id);
      return job ? clone(job) : null;
    },
    jobs(limit = 20) {
      return read().jobs.slice(0, Math.min(100, Math.max(1, Number(limit) || 20))).map(clone);
    },
    updateJob(id, patch = {}) {
      const state = read();
      const index = state.jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("question_enrichment_job_not_found");
      state.jobs[index] = normalizeJob({ ...state.jobs[index], ...patch, id, updatedAt: Date.now() });
      write(state);
      return clone(state.jobs[index]);
    },
    recoverInterrupted() {
      const state = read();
      let changed = false;
      const now = Date.now();
      state.jobs = state.jobs.map((job) => {
        if (!['queued', 'running'].includes(job.status)) return job;
        changed = true;
        return normalizeJob({ ...job, status: "interrupted", error: "server_interrupted", finishedAt: now, updatedAt: now });
      });
      if (changed) write(state);
    },
  };
}

function createFileQuestionEnrichmentStore(filePath = path.resolve(__dirname, "../../../.runtime/question-enrichment.json")) {
  const store = createQuestionEnrichmentStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { suggestions: [], jobs: [] }; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
  store.recoverInterrupted();
  return store;
}

function createMemoryQuestionEnrichmentStore(initialState = { suggestions: [], jobs: [] }) {
  let state = clone(initialState);
  return createQuestionEnrichmentStore({ read: () => clone(state), write: (next) => { state = clone(next); } });
}

module.exports = {
  createFileQuestionEnrichmentStore,
  createMemoryQuestionEnrichmentStore,
  isPlaceholder,
  questionEnrichmentNeeds,
};
