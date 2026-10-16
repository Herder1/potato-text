"use strict";

const crypto = require("node:crypto");

/**
 * 供应商批量接入：把一份「接口清单文档」解析成候选供应商，逐条做连通性测试，
 * 只把测试通过的保留下来（写进模型供应商配置）。路由见 server.js 的
 * `/api/admin/ai/provider-batch*`（前缀落在 `/api/admin/ai/`，因此只放行超级管理员）。
 *
 * 两条硬边界：
 * 1. 本模块不发网络请求、不读写存储：解析是纯函数，测试与落库由调用方注入（便于单测）。
 * 2. 候选对象里的 apiKey 只留在服务端内存：对外一律经 publicProviderBatchCandidate() 掩码输出；
 *    任务跑完（含落库）立刻把原始候选项从内存清掉，任务里只保留掩码后的结果。
 */

const MAX_BATCH_TEXT_LENGTH = 256 * 1024;
const MAX_BATCH_ENTRIES = 60;
const DEFAULT_BATCH_CONCURRENCY = 3;
const MAX_BATCH_CONCURRENCY = 5;
const MAX_ACTIVE_JOBS = 3;
const JOB_TTL_MS = 30 * 60 * 1000;
const MIN_BATCH_TIMEOUT_MS = 3000;
const MAX_BATCH_TIMEOUT_MS = 120000;

const HEADER_ALIASES = {
  name: ["name", "providername", "title", "供应商", "供应商名称", "名称", "别名"],
  baseUrl: ["baseurl", "url", "endpoint", "apiurl", "api地址", "地址", "接口", "接口地址", "域名", "上游地址", "上游", "base"],
  apiKey: ["apikey", "key", "token", "secret", "密钥", "接口密钥", "调用密钥", "key密钥", "令牌"],
  model: ["model", "models", "modelid", "模型", "模型id", "模型列表"],
  protocol: ["protocol", "协议", "上游协议"],
};

const PROTOCOL_ALIASES = {
  openai_chat_completions: ["openai", "openai_chat", "openai_chat_completions", "chat", "chatcompletions", "openai兼容", "openai格式"],
  openai_responses: ["openai_responses", "responses", "response"],
  anthropic_messages: ["anthropic", "anthropic_messages", "claude", "claude_messages"],
  google_gemini: ["google_gemini", "gemini", "google", "googleai"],
};

const URL_PATTERN = /^https?:\/\//i;
// 中文字符、中文标点与全角符号：出现这些基本可以断定是说明文字，不是接口地址或密钥。
const CJK_PATTERN = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

function normalizeCell(value) {
  return String(value == null ? "" : value).trim().replace(/^["']|["']$/g, "").trim();
}

function normalizeHeaderField(cell) {
  return normalizeCell(cell).toLowerCase().replace(/[\s_\-.]/g, "").replace(/[（）()：:]/g, "");
}

// 表头/协议别名与单元格走同一个规范化函数，这样 "Base URL"、"base_url"、"baseurl" 都能对上。
function buildAliasLookup(aliasesByField) {
  const lookup = new Map();
  Object.entries(aliasesByField).forEach(([field, aliases]) => {
    aliases.forEach((alias) => {
      const key = normalizeHeaderField(alias);
      if (key && !lookup.has(key)) lookup.set(key, field);
    });
  });
  return lookup;
}

const HEADER_FIELD_LOOKUP = buildAliasLookup(HEADER_ALIASES);
const PROTOCOL_LOOKUP = buildAliasLookup(PROTOCOL_ALIASES);

function headerFieldOf(cell) {
  return HEADER_FIELD_LOOKUP.get(normalizeHeaderField(cell)) || "";
}

// 一行切成单元格：制表符 > 竖线 > 中英文逗号 > 两个以上空格。支持 CSV 的引号包裹。
function splitDocumentLine(line) {
  const text = String(line || "").replace(/\r$/, "");
  const delimiters = ["\t", "|", ",", "，"];
  const delimiter = delimiters.find((candidate) => text.includes(candidate));
  if (!delimiter) {
    if (/\s{2,}/.test(text)) return text.split(/\s{2,}/).map(normalizeCell);
    return [text.trim()];
  }
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        current += char;
        continue;
      }
      if (text[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (char === '"' && current.trim() === "") {
      quoted = true;
      current = "";
      continue;
    }
    if (char === delimiter) {
      cells.push(normalizeCell(current));
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(normalizeCell(current));
  while (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function looksLikeUrl(value) {
  return URL_PATTERN.test(String(value || ""));
}

// 密钥的「像」判据故意宽松：真实密钥形态千差万别（可能只有 7 位、又没有数字），
// 只有"含中文/带空格/太短"才排除，避免把真密钥当说明文字丢掉。
function looksLikeKey(value) {
  const text = String(value || "");
  return text.length >= 6 && !/\s/.test(text) && !CJK_PATTERN.test(text);
}

function protocolOfCell(cell) {
  return PROTOCOL_LOOKUP.get(normalizeHeaderField(cell)) || "";
}

function hostLabelOf(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host || "未命名供应商";
  } catch (error) {
    return "未命名供应商";
  }
}

function normalizeBatchBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch (error) {
    return false;
  }
}

// 掩码看得见"前 4 位 + 后 4 位"，够区分同一主机下的多把密钥，又不构成可用的泄漏面。
function maskBatchApiKey(apiKey) {
  const value = String(apiKey || "");
  if (!value) return "";
  if (value.length >= 12) return `${value.slice(0, 4)}••••${value.slice(-4)}`;
  if (value.length > 4) return `${"•".repeat(Math.max(2, value.length - 2))}${value.slice(-2)}`;
  return "•".repeat(value.length);
}

// 文档里写的是"统一 Base URL + 每行一把密钥"时，用主机名 + 密钥尾号区分同名供应商。
function defaultCandidateName(baseUrl, apiKey) {
  const host = hostLabelOf(baseUrl);
  const tail = String(apiKey || "").slice(-4);
  return tail ? `${host} · ${tail}` : host;
}

/**
 * 解析接口清单文档。行格式（兼容式，按分隔符切列后自动判位）：
 *   BaseURL,APIKey[,模型ID][,协议]      ← 有 URL 时，URL 之后第一列是密钥
 *   名称,BaseURL,APIKey[,模型ID]        ← URL 之前的列当供应商名称
 *   APIKey[,模型ID]                     ← 没有 URL 时必须给默认 Base URL
 * 也支持带表头的 CSV/TSV（baseUrl/apiKey/model/name/protocol 及常见中文表头）。
 * 以 # 或 // 开头的整行、空行、以及识别不出 URL/密钥的说明文字行会被跳过。
 */
function parseProviderBatchDocument(text, defaults = {}) {
  const raw = String(text == null ? "" : text);
  if (raw.length > MAX_BATCH_TEXT_LENGTH) throw new Error("provider_batch_text_too_large");
  const defaultBaseUrl = normalizeBatchBaseUrl(defaults.baseUrl);
  const defaultModel = String(defaults.model || "").trim();
  const defaultProtocol = String(defaults.protocol || "").trim();
  const defaultNamePrefix = String(defaults.name || "").trim();
  const lines = raw.split("\n");
  const candidates = [];
  const warnings = [];
  let skipped = 0;
  let headerMap = null;
  let headerLine = 0;

  for (let position = 0; position < lines.length; position += 1) {
    const lineNumber = position + 1;
    const line = String(lines[position] || "").replace(/\r$/, "").trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith("//")) continue;
    const cells = splitDocumentLine(line);
    if (!cells.length) continue;

    if (cells.length > 1) {
      const recognized = cells.map(headerFieldOf);
      if (recognized.filter(Boolean).length >= 2) {
        headerMap = {};
        recognized.forEach((field, index) => {
          if (field && headerMap[field] === undefined) headerMap[field] = index;
        });
        headerLine = lineNumber;
        warnings.push({ lineNumber, message: `第 ${lineNumber} 行当表头处理，按列名读取之后的每一行` });
        continue;
      }
    }

    const entry = {
      index: candidates.length,
      lineNumber,
      source: line,
      name: "",
      protocol: "",
      baseUrl: "",
      apiKey: "",
      model: "",
      errors: [],
      warnings: [],
      duplicateOf: 0,
      prose: false,
    };

    if (headerMap) {
      const pick = (field) => (headerMap[field] === undefined ? "" : normalizeCell(cells[headerMap[field]]));
      entry.name = pick("name");
      entry.baseUrl = normalizeBatchBaseUrl(pick("baseUrl"));
      entry.apiKey = pick("apiKey");
      entry.model = pick("model");
      entry.protocol = protocolOfCell(pick("protocol")) || "";
      if (entry.protocol) entry.warnings.push(`协议取自表头列：${entry.protocol}`);
    } else {
      const urlIndex = cells.findIndex(looksLikeUrl);
      const values = cells.filter((cell) => cell !== "");
      if (urlIndex >= 0) {
        entry.baseUrl = normalizeBatchBaseUrl(cells[urlIndex]);
        const before = cells.slice(0, urlIndex).filter((cell) => cell !== "");
        const after = cells.slice(urlIndex + 1).filter((cell) => cell !== "");
        if (before.length) entry.name = before[0];
        entry.apiKey = after[0] || "";
        entry.model = after[1] || "";
        after.slice(2).forEach((cell) => {
          const protocol = protocolOfCell(cell);
          if (protocol && !entry.protocol) {
            entry.protocol = protocol;
            entry.warnings.push(`协议取自第 ${urlIndex + 3} 列：${protocol}`);
          }
        });
      } else if (values.length) {
        const [first, second, third] = values;
        if (CJK_PATTERN.test(first) && looksLikeKey(second || "")) {
          // 「供应商名称,密钥」这种两列写法：中文那一列是名称。
          entry.name = first;
          entry.apiKey = second || "";
          entry.model = third || "";
        } else if (looksLikeKey(first)) {
          entry.apiKey = first;
          entry.model = second || "";
        } else {
          // 既不像 URL、也不像密钥（例如文档标题「给大家分享一波…」）：按说明文字跳过，
          // 不因为界面上填了统一 Base URL 就把它变成一条"缺密钥"的待测记录。
          entry.prose = true;
        }
      }
    }

    if (!entry.baseUrl) entry.baseUrl = defaultBaseUrl;
    if (!entry.model) entry.model = defaultModel;
    if (!entry.protocol) entry.protocol = defaultProtocol;

    if (entry.prose || (!entry.baseUrl && !entry.apiKey)) {
      skipped += 1;
      warnings.push({ lineNumber, message: `第 ${lineNumber} 行没识别到 Base URL 或 API Key，已跳过：${line.slice(0, 40)}` });
      continue;
    }
    if (!entry.baseUrl) entry.errors.push("missing_provider_base_url");
    else if (!isHttpUrl(entry.baseUrl)) entry.errors.push("invalid_provider_base_url");
    if (!entry.apiKey) entry.errors.push("provider_api_key_required");
    else entry.apiKey = entry.apiKey.replace(/^Bearer\s+/i, "").trim();
    if (!entry.name) entry.name = defaultNamePrefix ? `${defaultNamePrefix}` : defaultCandidateName(entry.baseUrl, entry.apiKey);

    // 同一份文档里 Base URL + 密钥都一样的行只测一次、也只落一条供应商。
    const identity = `${entry.baseUrl.toLowerCase()}\n${entry.apiKey}`;
    const duplicate = candidates.find((candidate) => `${candidate.baseUrl.toLowerCase()}\n${candidate.apiKey}` === identity);
    if (duplicate && !entry.errors.length) {
      entry.duplicateOf = duplicate.lineNumber;
      entry.warnings.push(`与第 ${duplicate.lineNumber} 行是同一个 Base URL + 同一个密钥，只测一次`);
    }
    candidates.push(entry);
    if (candidates.length > MAX_BATCH_ENTRIES) throw new Error("provider_batch_too_many_entries");
  }

  if (!candidates.length) throw new Error("provider_batch_document_empty");
  const duplicates = candidates.filter((candidate) => candidate.duplicateOf).length;
  const invalid = candidates.filter((candidate) => candidate.errors.length).length;
  return {
    candidates,
    warnings,
    summary: {
      total: candidates.length,
      valid: candidates.length - invalid,
      invalid,
      duplicates,
      skipped,
      headerLine,
      truncated: false,
    },
  };
}

function publicProviderBatchCandidate(entry) {
  return {
    index: entry.index,
    lineNumber: entry.lineNumber,
    name: entry.name,
    protocol: entry.protocol,
    baseUrl: entry.baseUrl,
    apiKeyMasked: maskBatchApiKey(entry.apiKey),
    model: entry.model,
    errors: [...(entry.errors || [])],
    warnings: [...(entry.warnings || [])],
    duplicateOf: entry.duplicateOf || 0,
  };
}

function clampBatchConcurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_BATCH_CONCURRENCY;
  return Math.min(MAX_BATCH_CONCURRENCY, Math.max(1, Math.round(number)));
}

function clampBatchTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 20000;
  return Math.min(MAX_BATCH_TIMEOUT_MS, Math.max(MIN_BATCH_TIMEOUT_MS, Math.round(number)));
}

function summarizeProviderBatchJob(job) {
  const results = Array.isArray(job.results) ? job.results : [];
  const countOf = (status) => results.filter((result) => result.status === status).length;
  return {
    total: job.total || 0,
    tested: results.filter((result) => result.status === "passed" || result.status === "failed").length,
    passed: countOf("passed"),
    failed: countOf("failed"),
    invalid: countOf("invalid"),
    duplicates: countOf("duplicate"),
    // 未测试＝被取消而没轮到的条目（它们也有结果行，状态是 skipped）。
    untouched: countOf("skipped"),
    created: job.save && job.save.created ? job.save.created.length : 0,
    updated: job.save && job.save.updated ? job.save.updated.length : 0,
  };
}

function publicProviderBatchJob(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    done: job.results.length,
    concurrency: job.concurrency,
    timeoutMs: job.timeoutMs,
    savePassed: job.savePassed,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    cancelled: job.cancelled,
    error: job.error,
    warnings: job.warnings,
    summary: summarizeProviderBatchJob(job),
    save: job.save,
    results: job.results,
  };
}

function createProviderBatchRegistry(options = {}) {
  const jobs = new Map();
  const maxActive = Number(options.maxActive) || MAX_ACTIVE_JOBS;
  const ttlMs = Number(options.ttlMs) || JOB_TTL_MS;

  function purge(now = Date.now()) {
    for (const [id, job] of jobs) {
      const finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : 0;
      if (finishedAt && now - finishedAt > ttlMs) jobs.delete(id);
    }
  }

  function activeJobs() {
    return [...jobs.values()].filter((job) => job.status === "running");
  }

  function start(input = {}) {
    purge();
    if (activeJobs().length >= maxActive) throw new Error("provider_batch_too_many_jobs");
    const candidates = Array.isArray(input.candidates) ? input.candidates : [];
    const now = new Date().toISOString();
    const job = {
      id: `provider-batch-${crypto.randomUUID()}`,
      status: "running",
      createdAt: now,
      finishedAt: "",
      cancelled: false,
      savePassed: input.savePassed === true,
      concurrency: clampBatchConcurrency(input.concurrency),
      timeoutMs: clampBatchTimeout(input.timeoutMs),
      total: candidates.length,
      candidates,
      warnings: Array.isArray(input.warnings) ? input.warnings : [],
      results: [],
      save: null,
      error: "",
      operator: input.operator || "",
    };
    jobs.set(job.id, job);
    return job;
  }

  return {
    start,
    get: (id) => jobs.get(String(id || "")) || null,
    purge,
    size: () => jobs.size,
    activeCount: () => activeJobs().length,
  };
}

function batchResultOf(candidate, outcome, startedAt) {
  return {
    index: candidate.index,
    lineNumber: candidate.lineNumber,
    name: candidate.name,
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl,
    apiKeyMasked: maskBatchApiKey(candidate.apiKey),
    model: outcome.model || candidate.model || "",
    models: Array.isArray(outcome.models) ? outcome.models : [],
    modelCount: Array.isArray(outcome.models) ? outcome.models.length : 0,
    status: outcome.status,
    latencyMs: Number.isFinite(outcome.latencyMs) ? outcome.latencyMs : Date.now() - startedAt,
    preview: String(outcome.preview || ""),
    errorCode: outcome.errorCode || "",
    errorMessage: outcome.errorMessage || "",
    note: outcome.note || "",
  };
}

/**
 * 逐个测候选：并发度受控、任何一条失败都不影响其他条。
 * runEntry(candidate, job) 由调用方注入（真实实现发上游请求），返回
 * { status, model, models, latencyMs, preview, errorCode, errorMessage, note }。
 */
async function runProviderBatchJob(job, options = {}) {
  const runEntry = options.runEntry;
  const queue = Array.isArray(job.candidates) ? job.candidates.slice() : [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(job.concurrency, queue.length));

  async function worker() {
    while (!job.cancelled) {
      const position = cursor;
      cursor += 1;
      if (position >= queue.length) return;
      const candidate = queue[position];
      const startedAt = Date.now();
      if (candidate.duplicateOf) {
        job.results.push(batchResultOf(candidate, {
          status: "duplicate",
          note: `与第 ${candidate.duplicateOf} 行重复，未重复测试`,
        }, startedAt));
        continue;
      }
      if (candidate.errors && candidate.errors.length) {
        job.results.push(batchResultOf(candidate, {
          status: "invalid",
          errorCode: candidate.errors[0],
          note: "文档这一行不完整，未发起测试",
        }, startedAt));
        continue;
      }
      try {
        const outcome = await runEntry(candidate, job);
        job.results.push(batchResultOf(candidate, { status: "passed", ...outcome }, startedAt));
      } catch (error) {
        job.results.push(batchResultOf(candidate, {
          status: "failed",
          errorCode: String((error && error.message) || "provider_batch_entry_failed"),
        }, startedAt));
      }
      job.results.sort((left, right) => left.index - right.index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));

  // 任务被取消时，没轮到测的候选项如实记成 skipped，不冒充失败、也不冒充通过。
  const tested = new Set(job.results.map((result) => result.index));
  queue.forEach((candidate) => {
    if (tested.has(candidate.index)) return;
    job.results.push(batchResultOf(candidate, {
      status: "skipped",
      errorCode: "provider_batch_cancelled",
      note: "任务已取消，未测试",
    }, Date.now()));
  });
  job.results.sort((left, right) => left.index - right.index);
  job.status = job.cancelled ? "cancelled" : "finished";
  job.finishedAt = new Date().toISOString();

  if (typeof options.onFinished === "function") await options.onFinished(job);
  // 落库完成后再清掉原始候选项：内存里不留明文密钥（结果行只有掩码）。
  job.candidates = [];
  return job;
}

function providerBatchIdentity(baseUrl, apiKey) {
  return `${normalizeBatchBaseUrl(baseUrl).toLowerCase()}\n${String(apiKey || "").trim()}`;
}

/**
 * 只保留测试通过的：按「Base URL + 密钥」判断是不是已存在的供应商——
 * 已存在就补上这次发现的模型（不改名称、协议与启用状态），否则新建一条启用的供应商。
 * 返回新配置与本次新增/更新的清单；调用方负责 save()。
 */
function mergePassedProviderBatch(config, job, options = {}) {
  const source = config && typeof config === "object" ? config : {};
  const providers = (Array.isArray(source.providers) ? source.providers : [])
    .map((provider) => ({ ...provider, models: [...(provider.models || [])] }));
  const now = options.now || new Date().toISOString();
  const timeoutMs = clampBatchTimeout(options.timeoutMs || job.timeoutMs);
  const passedIndexes = new Set((job.results || []).filter((result) => result.status === "passed").map((result) => result.index));
  const created = [];
  const updated = [];

  (job.candidates || []).forEach((candidate) => {
    if (!passedIndexes.has(candidate.index)) return;
    const result = (job.results || []).find((item) => item.index === candidate.index) || {};
    const discovered = (Array.isArray(result.models) ? result.models : []).filter(Boolean);
    const identity = providerBatchIdentity(candidate.baseUrl, candidate.apiKey);
    const existing = providers.find((provider) => providerBatchIdentity(provider.baseUrl, provider.apiKey) === identity);
    if (existing) {
      const models = [...new Set([...(existing.models || []), ...discovered])];
      const added = models.length - (existing.models || []).length;
      existing.models = models;
      existing.apiKey = candidate.apiKey;
      existing.updatedAt = now;
      updated.push({ id: existing.id, name: existing.name, modelCount: models.length, addedModels: Math.max(0, added) });
      return;
    }
    const models = discovered.length ? discovered : [result.model].filter(Boolean);
    const provider = {
      id: `provider-${crypto.randomUUID()}`,
      name: candidate.name || defaultCandidateName(candidate.baseUrl, candidate.apiKey),
      protocol: candidate.protocol || "openai_chat_completions",
      baseUrl: candidate.baseUrl,
      models,
      timeoutMs,
      supportsJsonMode: false,
      enabled: true,
      apiKey: candidate.apiKey,
      createdAt: now,
      updatedAt: now,
    };
    providers.push(provider);
    created.push({ id: provider.id, name: provider.name, modelCount: models.length, addedModels: models.length });
  });

  return { config: { ...source, providers }, created, updated };
}

module.exports = {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  MAX_BATCH_ENTRIES,
  MAX_BATCH_TEXT_LENGTH,
  clampBatchConcurrency,
  clampBatchTimeout,
  createProviderBatchRegistry,
  mergePassedProviderBatch,
  parseProviderBatchDocument,
  publicProviderBatchCandidate,
  publicProviderBatchJob,
  runProviderBatchJob,
  summarizeProviderBatchJob,
};
