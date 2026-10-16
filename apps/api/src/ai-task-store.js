const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_TASKS = 2000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function redactError(value) {
  return String(value || "unknown_error")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 500);
}

function classifyError(value) {
  const error = String(value || "").toLowerCase();
  if (error.includes("timeout")) return "timeout";
  if (error.includes("aborted") || error.includes("disconnect") || error.includes("interrupted")) return "interrupted";
  // 451 = 上游按地区/法务原因拒绝当前出口（2026-10-09 实例：服务端没走本机代理）。这是出口/网络问题，
  // 不是模型或密钥问题，归到 network 才能被失败分析正确分组、并进入可自动重跑的类别。
  if (error.includes("region_blocked")) return "network";
  if (error.includes("http_error") || /http\s+[45]\d\d/.test(error)) return "upstream_http";
  if (error.includes("invalid_json")
    || error.includes("json_invalid")
    || error.includes("output_format")
    || error.includes("stream_output_format")
    || error.includes("knowledge_classification_agent2_")
    || error.includes("knowledge_classification_agent3_")
    || error.includes("knowledge_classification_family_draft_")) return "output_format";
  if (error.includes("empty_response")) return "empty_response";
  if (error.includes("route_unavailable") || error.includes("provider_unavailable") || error.includes("not_found_or_disabled")) return "configuration";
  if (error.includes("invalid_") || error.includes("required")) return "validation";
  if (error.includes("network") || error.includes("fetch failed") || error.includes("econn")) return "network";
  return "unknown";
}

/**
 * 归一化 token 用量。**必须幂等**：本函数既处理上游原始形状（snake_case：
 * `prompt_tokens` / `input_tokens`），也必须能再处理自己产出的形状（camelCase：
 * `inputTokens` / `outputTokens` / `totalTokens`）。
 *
 * 2026-10-10 实例（静默丢账，已修）：原实现只读 snake_case，而 `createTaskStore.write()`
 * 每次落盘都会把整份任务数组再过一遍 `normalizeTask` —— 于是 `finish()` 刚写进去的
 * `{inputTokens, outputTokens, totalTokens}` 在下一次归一化时被读成 0 并判定为 null。
 * 结果是 `.runtime/ai-tasks.json` 里 2000/2000 条任务用量全为 null，跨所有场景，
 * 且不报错：成本核算因此长期没有任何基线（根因与验证见变更日志 2026-10-10 条目）。
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.promptTokenCount ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.candidatesTokenCount ?? 0);
  const reportedTotal = Number(usage.total_tokens ?? usage.totalTokenCount ?? usage.totalTokens ?? 0);
  const totalTokens = reportedTotal || inputTokens + outputTokens;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function normalizeTimings(timings) {
  if (!timings || typeof timings !== "object") return null;
  const normalized = {};
  ["retrievalMs", "contextMs", "connectMs", "upstreamFirstTokenMs", "generationMs", "upstreamMs", "parseMs", "normalizeMs"].forEach((key) => {
    const value = Number(timings[key]);
    if (Number.isFinite(value) && value >= 0) normalized[key] = value;
  });
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeTask(input) {
  const startedAt = Number(input.startedAt) || Date.now();
  return {
    id: String(input.id || crypto.randomUUID()),
    userId: String(input.userId || ""),
    requestId: String(input.requestId || ""),
    sceneId: String(input.sceneId || "unknown"),
    sceneLabel: String(input.sceneLabel || input.sceneId || "未知场景"),
    status: input.status === "succeeded" || input.status === "failed" ? input.status : "running",
    providerId: String(input.providerId || ""),
    providerName: String(input.providerName || ""),
    protocol: String(input.protocol || ""),
    model: String(input.model || ""),
    mode: String(input.mode || "provider"),
    streaming: input.streaming === true,
    startedAt,
    updatedAt: Number(input.updatedAt) || startedAt,
    firstTokenMs: input.firstTokenMs !== null && input.firstTokenMs !== undefined
      && Number.isFinite(Number(input.firstTokenMs)) && Number(input.firstTokenMs) > 0
      ? Number(input.firstTokenMs) : null,
    finishedAt: input.finishedAt !== null && input.finishedAt !== undefined && Number.isFinite(Number(input.finishedAt))
      ? Number(input.finishedAt) : null,
    durationMs: input.durationMs !== null && input.durationMs !== undefined && Number.isFinite(Number(input.durationMs))
      ? Number(input.durationMs) : null,
    timings: normalizeTimings(input.timings),
    chargeable: input.chargeable === true,
    usage: normalizeUsage(input.usage),
    outputChars: Math.max(0, Number(input.outputChars) || 0),
    inputSummary: input.inputSummary && typeof input.inputSummary === "object" ? clone(input.inputSummary) : {},
    errorCode: input.errorCode ? redactError(input.errorCode) : "",
    errorCategory: String(input.errorCategory || ""),
    failureStage: String(input.failureStage || ""),
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function beginningOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function summarize(tasks) {
  const completed = tasks.filter((task) => task.status !== "running");
  const succeeded = completed.filter((task) => task.status === "succeeded");
  const failed = completed.filter((task) => task.status === "failed");
  const durations = completed.map((task) => task.durationMs).filter(Number.isFinite);
  const errorCounts = new Map();
  failed.forEach((task) => errorCounts.set(task.errorCategory || "unknown", (errorCounts.get(task.errorCategory || "unknown") || 0) + 1));
  return {
    total: tasks.length,
    running: tasks.length - completed.length,
    succeeded: succeeded.length,
    failed: failed.length,
    successRate: completed.length ? Math.round((succeeded.length / completed.length) * 1000) / 10 : 0,
    averageDurationMs: durations.length ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length) : 0,
    p95DurationMs: percentile(durations, 0.95),
    totalTokens: succeeded.reduce((total, task) => total + Number(task.usage && task.usage.totalTokens || 0), 0),
    errorBreakdown: [...errorCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) => right.count - left.count),
  };
}

function createTaskStore(adapter) {
  const read = () => adapter.read().map(normalizeTask);
  const write = (tasks) => adapter.write(tasks.slice(0, MAX_TASKS).map(normalizeTask));
  return {
    exportState: () => clone(adapter.read()),
    start(input) {
      const task = normalizeTask({ ...input, id: input.id || crypto.randomUUID(), startedAt: Date.now(), status: "running" });
      write([task, ...read().filter((item) => item.id !== task.id)]);
      return clone(task);
    },
    markFirstToken(id) {
      const tasks = read();
      const task = tasks.find((item) => item.id === id);
      if (!task || task.status !== "running" || task.firstTokenMs !== null) return task ? clone(task) : null;
      task.firstTokenMs = Math.max(1, Date.now() - task.startedAt);
      write(tasks);
      return clone(task);
    },
    get(id) {
      const task = read().find((item) => item.id === id);
      return task ? clone(task) : null;
    },
    deleteUser(userId) {
      const target = String(userId || "").trim();
      if (!target) return 0;
      const tasks = read();
      const remaining = tasks.filter((task) => task.userId !== target);
      const removed = tasks.length - remaining.length;
      if (removed) write(remaining);
      return removed;
    },
    update(id, patch = {}) {
      const tasks = read();
      const task = tasks.find((item) => item.id === id);
      if (!task || task.status !== "running") return task ? clone(task) : null;
      const inputSummary = patch.inputSummary && typeof patch.inputSummary === "object"
        ? { ...task.inputSummary, ...clone(patch.inputSummary) }
        : task.inputSummary;
      Object.assign(task, { ...patch, status: "running", inputSummary, updatedAt: Date.now() });
      write(tasks);
      return clone(task);
    },
    restart(id, patch = {}) {
      const tasks = read();
      const task = tasks.find((item) => item.id === id);
      if (!task || task.status === "running") return task ? clone(task) : null;
      const startedAt = Date.now();
      Object.assign(task, {
        ...patch,
        status: "running",
        startedAt,
        updatedAt: startedAt,
        firstTokenMs: null,
        finishedAt: null,
        durationMs: null,
        chargeable: false,
        usage: null,
        outputChars: 0,
        errorCode: "",
        errorCategory: "",
        failureStage: "",
        inputSummary: {
          ...task.inputSummary,
          ...(patch.inputSummary && typeof patch.inputSummary === "object" ? clone(patch.inputSummary) : {}),
        },
      });
      write(tasks);
      return clone(task);
    },
    finish(id, patch = {}) {
      const tasks = read();
      const task = tasks.find((item) => item.id === id);
      if (!task || task.status !== "running") return task ? clone(task) : null;
      const finishedAt = Date.now();
      Object.assign(task, {
        ...patch,
        status: patch.status === "succeeded" ? "succeeded" : "failed",
        updatedAt: finishedAt,
        finishedAt,
        durationMs: finishedAt - task.startedAt,
        chargeable: patch.status === "succeeded" && patch.chargeable === true,
        usage: normalizeUsage(patch.usage),
        timings: normalizeTimings(patch.timings),
        errorCode: patch.errorCode ? redactError(patch.errorCode) : "",
        errorCategory: patch.status === "failed" ? classifyError(patch.errorCode) : "",
      });
      write(tasks);
      return clone(task);
    },
    list(filters = {}) {
      const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
      return read().filter((task) => {
        if (filters.status && filters.status !== "all" && task.status !== filters.status) return false;
        if (filters.sceneId && filters.sceneId !== "all" && task.sceneId !== filters.sceneId) return false;
        return true;
      }).slice(0, limit).map(clone);
    },
    dashboard(filters = {}) {
      const tasks = read();
      const recentSince = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const filtered = tasks.filter((task) => {
        if (filters.status && filters.status !== "all" && task.status !== filters.status) return false;
        if (filters.sceneId && filters.sceneId !== "all" && task.sceneId !== filters.sceneId) return false;
        return true;
      });
      return {
        today: summarize(tasks.filter((task) => task.startedAt >= beginningOfToday())),
        recent: summarize(tasks.filter((task) => task.startedAt >= recentSince)),
        tasks: filtered.slice(0, Math.min(500, Math.max(1, Number(filters.limit) || 100))).map(clone),
      };
    },
    recoverInterrupted() {
      const tasks = read();
      let changed = false;
      const now = Date.now();
      tasks.forEach((task) => {
        if (task.status !== "running") return;
        changed = true;
        task.status = "failed";
        task.finishedAt = now;
        task.durationMs = now - task.startedAt;
        task.chargeable = false;
        task.errorCode = "server_interrupted";
        task.errorCategory = "interrupted";
        task.failureStage = "server_lifecycle";
      });
      if (changed) write(tasks);
    },
  };
}

function createFileAiTaskStore(filePath = path.resolve(__dirname, "../../../.runtime/ai-tasks.json"), options = {}) {
  const store = createTaskStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(value) ? value : [];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return [];
      }
    },
    write(tasks) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
  if (options.recoverInterrupted !== false) store.recoverInterrupted();
  return store;
}

function createMemoryAiTaskStore(initialTasks = []) {
  let tasks = clone(initialTasks);
  return createTaskStore({
    read: () => clone(tasks),
    write: (nextTasks) => { tasks = clone(nextTasks); },
  });
}

module.exports = {
  classifyError,
  createFileAiTaskStore,
  createMemoryAiTaskStore,
  normalizeUsage,
};
