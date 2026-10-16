const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const PRIMARY_RUNTIME_FILES = Object.freeze([
  "admin-actions.json",
  "ai-config.json",
  "ai-score-cache.json",
  "ai-tasks.json",
  "announcements.json",
  "billing.json",
  "classification-gold-reviews.json",
  "community-assets.json",
  "exam-imports.json",
  "exams.json",
  "learning-state.json",
  "moderation-reports.json",
  "packs.json",
  "personal-cloud-assets.json",
  "platform-content.json",
  "questions.json",
  "question-families.json",
  "knowledge-classification-experience.json",
  "knowledge-structures.json",
  "question-enrichment.json",
  "textbook-catalogs.json",
  "textbook-knowledge.json",
  "users.json",
]);

function recordCount(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === "object") return Object.keys(payload).length;
  return 1;
}

function storeKey(fileName) {
  return fileName.replace(/\.json$/i, "");
}

function sanitizeForPostgres(value) {
  if (typeof value === "string") return value.replaceAll("\u0000", "\ufffd");
  if (Array.isArray(value)) return value.map(sanitizeForPostgres);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.replaceAll("\u0000", "\ufffd"),
    sanitizeForPostgres(item),
  ]));
}

function readRuntimeDocument(runtimeRoot, fileName) {
  const absolutePath = path.resolve(runtimeRoot, fileName);
  const buffer = fs.readFileSync(absolutePath);
  const payload = JSON.parse(buffer.toString("utf8"));
  const payloadContainsNull = buffer.includes(0) || buffer.includes(Buffer.from("\\u0000", "utf8"));
  const stats = fs.statSync(absolutePath);
  return {
    storeKey: storeKey(fileName),
    sourcePath: fileName,
    payload,
    databasePayload: payloadContainsNull ? sanitizeForPostgres(payload) : payload,
    sourceBlob: buffer,
    payloadContainsNull,
    sourceSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    sourceBytes: buffer.length,
    recordCount: recordCount(payload),
    sourceModifiedAt: stats.mtime.toISOString(),
  };
}

function collectRuntimeDocuments(runtimeRoot) {
  const existing = new Set(fs.readdirSync(runtimeRoot));
  return PRIMARY_RUNTIME_FILES
    .filter((fileName) => existing.has(fileName))
    .map((fileName) => readRuntimeDocument(runtimeRoot, fileName));
}

function documentManifest(document) {
  return {
    storeKey: document.storeKey,
    sourcePath: document.sourcePath,
    sourceSha256: document.sourceSha256,
    sourceBytes: document.sourceBytes,
    recordCount: document.recordCount,
    payloadContainsNull: document.payloadContainsNull,
    sourceModifiedAt: document.sourceModifiedAt,
  };
}

function verifyPayload(document, stored) {
  const errors = [];
  if (!stored) return ["missing_in_postgres"];
  if (stored.source_sha256 !== document.sourceSha256) errors.push("sha256_mismatch");
  if (Number(stored.source_bytes) !== document.sourceBytes) errors.push("byte_count_mismatch");
  if (Number(stored.record_count) !== document.recordCount) errors.push("record_count_mismatch");
  if (!Buffer.isBuffer(stored.source_blob) || !stored.source_blob.equals(document.sourceBlob)) errors.push("source_blob_mismatch");
  if (Boolean(stored.payload_contains_null) !== document.payloadContainsNull) errors.push("null_marker_mismatch");
  if (!isDeepStrictEqual(stored.payload, document.databasePayload)) errors.push("payload_mismatch");
  return errors;
}

module.exports = {
  PRIMARY_RUNTIME_FILES,
  collectRuntimeDocuments,
  documentManifest,
  readRuntimeDocument,
  recordCount,
  sanitizeForPostgres,
  storeKey,
  verifyPayload,
};
