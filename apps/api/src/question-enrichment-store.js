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

// 多选筛选的归一化（**唯一出处**，2026-10-12 起「完善题目」筛选行改成勾选式多选）：
// GET 用重复参数（?need=chapter&need=knowledge_points）、POST 直接给数组，两种形态都归到数组；
// 单值（旧链接、旧调用方）与 "all" 一律视为"不筛"，空串丢弃、重复值去重保序。
// 语义约定：同一字段内多值是 **OR**（命中任一即算），跨字段之间仍是 AND。
const enrichmentFilterSources = {
  subjectIds: ["subjectIds", "subjectId"],
  bookIds: ["bookIds", "bookId"],
  importBatchIds: ["importBatchIds", "importBatchId"],
  types: ["types", "type"],
  needs: ["needs", "need"],
  suggestionStatuses: ["suggestionStatuses", "suggestionStatus"],
};

function normalizeQuestionEnrichmentFilters(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const result = {};
  Object.entries(enrichmentFilterSources).forEach(([key, aliases]) => {
    const raw = aliases.flatMap((alias) => {
      const value = source[alias];
      if (value === undefined || value === null) return [];
      return Array.isArray(value) ? value : [value];
    });
    result[key] = [...new Set(raw.map((value) => String(value).trim()).filter((value) => value && value !== "all"))];
  });
  return result;
}

// 题目的待完善项是否命中所勾选项（多选＝OR）。
function questionEnrichmentMatchesNeeds(needs = [], selected = []) {
  if (!selected.length) return true;
  return selected.some((need) => needs.includes(need));
}

function isPlaceholder(value) {
  return !String(value || "").trim() || placeholderPattern.test(String(value || "").trim());
}

function questionEnrichmentNeeds(question = {}, derived = {}) {
  const knowledgePoints = Array.isArray(question.knowledgePoints) ? question.knowledgePoints : [];
  // 教材缺失也是一项待完善：章节与知识点都挂在教材下面，没有教材的题连"去哪本目录里找节点"都定不下来。
  // 2026-09-24 产品负责人确认（跨册批次）：AI 可以在**整个科目**的已确认目录里挑，并把教材一起建议出来。
  const needsTextbook = !String(question.bookId || "").trim();
  const needsChapter = isPlaceholder(question.chapter);
  const needsKnowledgePoints = !knowledgePoints.length || knowledgePoints.every(isPlaceholder);
  const needsScoringPoints = subjectiveQuestionTypes.has(question.type)
    && question.scoringPointStatus !== "complete";
  // 2026-09-26 产品负责人确认：知识指纹与题族归属同样属于「待完善」，批量完善要一起补。
  // 这两项**不是题目字段**能判断的（指纹在知识树里、题族在题族库里），所以由调用方按册算好传进来；
  // 不传时行为与以前完全一致（只有教材/章节/知识点/得分点四项）。
  // 传 null 时不能抛（默认参数只对 undefined 生效）——历史调用方可能显式传 null。
  const derivedNeeds = derived && typeof derived === "object" ? derived : {};
  const needsFingerprint = derivedNeeds.needsFingerprint === true;
  const needsFamily = derivedNeeds.needsFamily === true;
  const needs = [
    needsTextbook && "textbook",
    needsChapter && "chapter",
    needsKnowledgePoints && "knowledge_points",
    needsScoringPoints && "scoring_points",
    needsFingerprint && "knowledge_fingerprint",
    needsFamily && "family",
  ].filter(Boolean);
  return {
    needs,
    needsTextbook,
    needsChapter,
    needsKnowledgePoints,
    needsScoringPoints,
    needsFingerprint,
    needsFamily,
    complete: needs.length === 0,
  };
}

function normalizeEvidence(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    chunkId: String(item && item.chunkId || ""),
    // 跨册候选时证据要标出自哪一册，否则"这段正文属于上册还是下册"在弹窗里无从判断。
    bookLabel: String(item && item.bookLabel || "").slice(0, 200),
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
    // 建议稿里可以带考试项目与科目（DEC-098）：归属判断是四级链，教材只是第三级。
    // 项目一级今天只有一个（接口按多项目预留），科目一级则可能是"这道题其实属于另一个科目"。
    projectId: String(input.projectId || ""),
    subjectId: String(input.subjectId || ""),
    subjectLabel: String(input.subjectLabel || "").slice(0, 100),
    // 建议是"相对什么提的"要一起存：题目后来被采纳过之后，`question.subjectId/bookId` 已经变了，
    // 只有基线才知道这条建议当时建议的是"换科目"还是"复述当前科目"（准确率统计也据此算）。
    subjectIdFrom: String(input.subjectIdFrom || ""),
    bookIdFrom: String(input.bookIdFrom || ""),
    // 建议稿里可以带教材：题目没有教材时（跨册批次）由 AI 在整个科目的已确认目录里挑定册次，
    // 采纳时才会写进题目；已经有教材的题给出同一册或同科目另一册时，同样要人工勾选才生效。
    bookId: String(input.bookId || ""),
    bookLabel: String(input.bookLabel || "").slice(0, 200),
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
    // 来源留痕（DEC-100：AI 巡检发起的完善与人工发起的完善要能区分）。
    // 这里**不复用** source（`SUGGESTION_SOURCES` 是建议层统一状态机的既有枚举，不改它的语义），
    // 只加两个标记字段：origin 是机器可读标识，originLabel 是给人看的说明。
    origin: String(input.origin || "").slice(0, 60),
    originLabel: String(input.originLabel || "").slice(0, 500),
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
    // 这个 job 是谁发起的（manual＝人在「完善题目」里点的；knowledge_inspection＝AI 巡检的「送去完善题目」）。
    origin: ["manual", "knowledge_inspection"].includes(input.origin) ? input.origin : "manual",
    originLabel: String(input.originLabel || "").slice(0, 500),
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
    // 兼容两种调用：createJob(ids)（既有调用不变）与 createJob(ids, { origin, originLabel })。
    createJob(questionIds, options = {}) {
      const state = read();
      const job = normalizeJob({
        questionIds,
        status: "queued",
        origin: options.origin,
        originLabel: options.originLabel,
      });
      state.jobs = [job, ...state.jobs];
      write(state);
      return clone(job);
    },
    // 这道题是不是已经有一个排队/运行中的完善 job（AI 巡检「送去完善题目」据此复用，不重复排队）。
    activeJobForQuestion(questionId) {
      const id = String(questionId || "");
      if (!id) return null;
      const job = read().jobs.find((item) => ["queued", "running"].includes(item.status) && item.questionIds.includes(id));
      return job ? clone(job) : null;
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
  normalizeQuestionEnrichmentFilters,
  questionEnrichmentMatchesNeeds,
  questionEnrichmentNeeds,
};
