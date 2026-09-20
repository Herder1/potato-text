const crypto = require("node:crypto");
const path = require("node:path");
const knexFactory = require("knex");
const knexConfig = require("../knexfile").development;
const {
  collectRuntimeDocuments,
  documentManifest,
  verifyPayload,
} = require("./runtime-migration-lib");

const ADVISORY_LOCK_KEY = 741_202_608;

function parseArguments(argv) {
  const options = { dryRun: false, verifyOnly: false, runtimeRoot: path.resolve(__dirname, "../.runtime") };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") options.dryRun = true;
    else if (value === "--verify-only") options.verifyOnly = true;
    else if (value === "--runtime-root") options.runtimeRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function printManifest(documents) {
  console.table(documents.map((item) => ({
    store: item.storeKey,
    records: item.recordCount,
    bytes: item.sourceBytes,
    nulls: item.payloadContainsNull ? "sanitized" : "none",
    sha256: item.sourceSha256.slice(0, 12),
  })));
}

async function verifyDocuments(knex, documents) {
  const rows = await knex("runtime_store_documents")
    .select("store_key", "payload", "source_blob", "payload_contains_null", "source_sha256", "source_bytes", "record_count")
    .whereIn("store_key", documents.map((item) => item.storeKey));
  const storedByKey = new Map(rows.map((row) => [row.store_key, row]));
  const results = documents.map((document) => ({
    storeKey: document.storeKey,
    errors: verifyPayload(document, storedByKey.get(document.storeKey)),
  }));
  const failures = results.filter((item) => item.errors.length);
  if (failures.length) {
    const detail = failures.map((item) => `${item.storeKey}: ${item.errors.join(", ")}`).join("; ");
    throw new Error(`PostgreSQL verification failed: ${detail}`);
  }
  return results;
}

async function importDocuments(knex, documents, runtimeRoot) {
  const runId = crypto.randomUUID();
  const manifest = documents.map(documentManifest);
  await knex("runtime_migration_runs").insert({
    id: runId,
    status: "running",
    source_root: runtimeRoot,
    manifest: JSON.stringify(manifest),
  });

  try {
    const summary = await knex.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(?)", [ADVISORY_LOCK_KEY]);
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;

      for (const document of documents) {
        const existing = await trx("runtime_store_documents").where({ store_key: document.storeKey }).first();
        if (existing && existing.source_sha256 === document.sourceSha256
          && Buffer.isBuffer(existing.source_blob) && existing.source_blob.equals(document.sourceBlob)) {
          unchanged += 1;
          continue;
        }

        if (existing) {
          await trx("runtime_store_document_history").insert({
            store_key: existing.store_key,
            source_path: existing.source_path,
            payload: JSON.stringify(existing.payload),
            source_blob: existing.source_blob,
            payload_contains_null: existing.payload_contains_null,
            source_sha256: existing.source_sha256,
            source_bytes: existing.source_bytes,
            record_count: existing.record_count,
            migration_run_id: existing.migration_run_id,
            source_modified_at: existing.source_modified_at,
            imported_at: existing.imported_at,
          });
        }

        const row = {
          store_key: document.storeKey,
          source_path: document.sourcePath,
          payload: JSON.stringify(document.databasePayload),
          source_blob: document.sourceBlob,
          payload_contains_null: document.payloadContainsNull,
          source_sha256: document.sourceSha256,
          source_bytes: document.sourceBytes,
          record_count: document.recordCount,
          migration_run_id: runId,
          source_modified_at: document.sourceModifiedAt,
          imported_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        };
        await trx("runtime_store_documents")
          .insert(row)
          .onConflict("store_key")
          .merge(row);
        if (existing) updated += 1;
        else inserted += 1;
      }
      return { inserted, updated, unchanged };
    });

    await verifyDocuments(knex, documents);
    await knex("runtime_migration_runs").where({ id: runId }).update({
      status: "completed",
      completed_at: knex.fn.now(),
    });
    return { runId, ...summary };
  } catch (error) {
    await knex("runtime_migration_runs").where({ id: runId }).update({
      status: "failed",
      error_message: String(error.message || error).slice(0, 4000),
      completed_at: knex.fn.now(),
    });
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const documents = collectRuntimeDocuments(options.runtimeRoot);
  if (!documents.length) throw new Error(`No runtime JSON documents found in ${options.runtimeRoot}`);
  printManifest(documents);
  if (options.dryRun) {
    console.log(`Dry run complete: ${documents.length} documents are valid; PostgreSQL was not changed.`);
    return;
  }

  const knex = knexFactory(knexConfig);
  try {
    if (options.verifyOnly) {
      await verifyDocuments(knex, documents);
      console.log(`Verification complete: ${documents.length} PostgreSQL documents match their JSON sources.`);
      return;
    }
    const summary = await importDocuments(knex, documents, options.runtimeRoot);
    console.log(`Import complete: run=${summary.runId}, inserted=${summary.inserted}, updated=${summary.updated}, unchanged=${summary.unchanged}.`);
  } finally {
    await knex.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { importDocuments, parseArguments, verifyDocuments };
