const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  collectRuntimeDocuments,
  readRuntimeDocument,
  recordCount,
  sanitizeForPostgres,
  storeKey,
  verifyPayload,
} = require("../scripts/db/runtime-migration-lib");
const { parseArguments } = require("../scripts/db/import-runtime-to-postgres");

test("runtime migration reads primary JSON data with a stable checksum", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-migration-"));
  try {
    fs.writeFileSync(path.join(root, "questions.json"), JSON.stringify([{ id: "q1", stem: "题目" }]));
    fs.writeFileSync(path.join(root, "questions.before-backup.json"), JSON.stringify([{ id: "old" }]));
    const first = readRuntimeDocument(root, "questions.json");
    const second = collectRuntimeDocuments(root);
    assert.equal(first.storeKey, "questions");
    assert.equal(first.recordCount, 1);
    assert.equal(first.sourceSha256.length, 64);
    assert.deepEqual(second.map((item) => item.storeKey), ["questions"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime migration counts arrays and object stores", () => {
  assert.equal(recordCount([1, 2, 3]), 3);
  assert.equal(recordCount({ users: [], sessions: [] }), 2);
  assert.equal(storeKey("learning-state.json"), "learning-state");
});

test("runtime migration verification catches altered PostgreSQL content", () => {
  const document = {
    payload: [{ id: "q1" }],
    databasePayload: [{ id: "q1" }],
    sourceBlob: Buffer.from('[{"id":"q1"}]'),
    payloadContainsNull: false,
    sourceSha256: "a".repeat(64),
    sourceBytes: 12,
    recordCount: 1,
  };
  assert.deepEqual(verifyPayload(document, {
    payload: [{ id: "q1" }],
    source_blob: Buffer.from('[{"id":"q1"}]'),
    payload_contains_null: false,
    source_sha256: "a".repeat(64),
    source_bytes: "12",
    record_count: 1,
  }), []);
  assert.deepEqual(verifyPayload(document, {
    payload: [{ id: "q2" }],
    source_blob: Buffer.from('[{"id":"q2"}]'),
    payload_contains_null: true,
    source_sha256: "b".repeat(64),
    source_bytes: "13",
    record_count: 2,
  }), ["sha256_mismatch", "byte_count_mismatch", "record_count_mismatch", "source_blob_mismatch", "null_marker_mismatch", "payload_mismatch"]);
});

test("runtime migration preserves source bytes while sanitizing PostgreSQL JSONB null characters", () => {
  const value = { text: "a\u0000b", nested: ["c\u0000d"] };
  assert.deepEqual(sanitizeForPostgres(value), { text: "a\ufffdb", nested: ["c\ufffdd"] });
  assert.equal(value.text, "a\u0000b");
});

test("runtime migration CLI supports dry-run, verification and source overrides", () => {
  const options = parseArguments(["--dry-run", "--runtime-root", ".runtime-copy"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.verifyOnly, false);
  assert.equal(options.runtimeRoot, path.resolve(".runtime-copy"));
  assert.equal(parseArguments(["--verify-only"]).verifyOnly, true);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
});
