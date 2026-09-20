const crypto = require("node:crypto");
const knexFactory = require("knex");
const knexfile = require("../../../knexfile");
const { createMemoryAdminOperationStore } = require("./admin-operation-store");
const { createMemoryAdminAccountStore } = require("./admin-account-store");
const { createMemoryAiScoreCacheStore } = require("./ai-score-cache-store");
const { createMemoryAiTaskStore } = require("./ai-task-store");
const { createMemoryAnnouncementStore } = require("./announcement-store");
const { createMemoryBillingStore } = require("./billing-store");
const { createMemoryCommunityAssetStore } = require("./community-asset-store");
const { createMemoryExamImportStore } = require("./exam-import-store");
const { createMemoryExamStore } = require("./exam-store");
const { createMemoryLearningStateStore } = require("./learning-state-store");
const { createMemoryModerationStore } = require("./moderation-store");
const { createMemoryPackStore } = require("./pack-store");
const { createMemoryQuestionStore } = require("./question-store");
const { createMemoryQuestionFamilyStore } = require("./question-family-store");
const { createMemoryKnowledgeStructureStore } = require("./knowledge-structure-store");
const { createMemoryQuestionEnrichmentStore } = require("./question-enrichment-store");
const { createMemoryKnowledgeClassificationStore } = require("./knowledge-classification-store");
const { createMemoryKnowledgeDossierStore } = require("./knowledge-dossier-store");
const { createMemoryTextbookCatalogStore } = require("./textbook-catalog-store");
const { createMemoryTextbookKnowledgeStore } = require("./textbook-knowledge-store");
const { createMemoryUserAuthStore } = require("./user-auth-store");
const { createMemoryUserRestrictionStore } = require("./user-restriction-store");
const { createMemoryCommunityInteractionStore } = require("./community-interaction-store");
const { createMemoryAiConfigStore } = require("./ai-config");
const { recordCount, sanitizeForPostgres } = require("../../../scripts/runtime-migration-lib");

const STORE_SPECS = [
  { option: "aiConfigStore", key: "ai-config", factory: createMemoryAiConfigStore, mutations: ["save"], snapshot: (store) => store.load() },
  { option: "aiTaskStore", key: "ai-tasks", factory: createMemoryAiTaskStore, mutations: ["start", "update", "markFirstToken", "finish", "restart"] },
  { option: "aiScoreCacheStore", key: "ai-score-cache", factory: createMemoryAiScoreCacheStore, mutations: ["set"] },
  { option: "questionStore", key: "questions", factory: createMemoryQuestionStore, mutations: ["replaceState", "create", "update", "transition", "importMany", "deleteMany", "updateImportBatch"] },
  { option: "questionFamilyStore", key: "question-families", factory: createMemoryQuestionFamilyStore, mutations: ["replaceState", "create", "addMembers", "moveMembers", "removeMember", "detachQuestions", "reviewMember", "remove", "relocate", "markPendingForQuestions", "setMemberships", "generate", "review", "createSet", "updateSet", "addSetMembers", "removeSetMember", "removeSet"] },
  { option: "knowledgeStructureStore", key: "knowledge-structures", factory: createMemoryKnowledgeStructureStore, mutations: ["generate", "fillGaps", "restoreBackup", "createNode", "updateNode", "deleteNode", "assignQuestions"] },
  { option: "questionEnrichmentStore", key: "question-enrichment", factory: createMemoryQuestionEnrichmentStore, mutations: ["addSuggestion", "updateSuggestion", "createJob", "updateJob", "recoverInterrupted"] },
  { option: "knowledgeClassificationStore", key: "knowledge-classification", factory: createMemoryKnowledgeClassificationStore, mutations: ["createJob", "updateJob", "updateResult", "saveAgent1Features", "saveAgent1", "saveAgent2", "applyResult", "rejectResult", "recoverInterrupted"] },
  { option: "knowledgeDossierStore", key: "knowledge-dossiers", factory: createMemoryKnowledgeDossierStore, mutations: ["save", "createRun", "updateRun", "createDelta", "reviewDelta"] },
  { option: "operationLogStore", key: "admin-actions", factory: createMemoryAdminOperationStore, mutations: ["append"] },
  { option: "adminAccountStore", key: "admin-accounts", factory: createMemoryAdminAccountStore, mutations: ["ensureBootstrapAdmin", "create", "resetPassword", "changePassword", "setStatus", "delete", "login", "logout", "revokeSessions"] },
  { option: "moderationStore", key: "moderation-reports", factory: createMemoryModerationStore, mutations: ["create", "action"] },
  { option: "textbookCatalogStore", key: "textbook-catalogs", factory: createMemoryTextbookCatalogStore, mutations: ["savePdf", "setDraft", "updateDraft", "confirm", "rejectDraft"] },
  { option: "textbookKnowledgeStore", key: "textbook-knowledge", factory: createMemoryTextbookKnowledgeStore, mutations: ["begin", "appendPages", "importStructuredPages", "reindex", "updateChunk", "fail"] },
  { option: "examStore", key: "exams", factory: createMemoryExamStore, mutations: ["create", "update", "action", "remove"] },
  { option: "examImportStore", key: "exam-imports", factory: createMemoryExamImportStore, mutations: ["create", "update", "confirm", "remove"] },
  { option: "packStore", key: "packs", factory: createMemoryPackStore, mutations: ["create", "update", "action"] },
  { option: "billingStore", key: "billing", factory: createMemoryBillingStore, mutations: ["upsertProduct", "setProductActive", "grantProduct", "grantCredits", "consumeCredits"] },
  { option: "communityAssetStore", key: "community-assets", factory: createMemoryCommunityAssetStore, mutations: ["submit", "collect", "action", "withdraw"] },
  { option: "userAuthStore", key: "users", factory: createMemoryUserAuthStore, mutations: ["loginWechat", "logout", "logoutUser", "deleteUser"] },
  { option: "userRestrictionStore", key: "user-restrictions", factory: createMemoryUserRestrictionStore, mutations: ["apply", "lift", "sweep", "replaceState"] },
  { option: "communityInteractionStore", key: "community-interactions", factory: createMemoryCommunityInteractionStore, mutations: ["add", "remove", "deleteUser", "replaceState"] },
  { option: "learningStateStore", key: "learning-state", factory: createMemoryLearningStateStore, mutations: ["merge", "deleteUser"] },
  { option: "announcementStore", key: "announcements", factory: createMemoryAnnouncementStore, mutations: ["create", "update", "action", "remove"] },
];

function sourceDocument(payload) {
  const sourceBlob = Buffer.from(JSON.stringify(payload), "utf8");
  const payloadContainsNull = sourceBlob.includes(Buffer.from("\\u0000", "utf8"));
  return {
    sourceBlob,
    payloadContainsNull,
    databasePayload: payloadContainsNull ? sanitizeForPostgres(payload) : payload,
    sourceSha256: crypto.createHash("sha256").update(sourceBlob).digest("hex"),
  };
}

function createPersistenceController(persist) {
  let queue = Promise.resolve();
  return {
    schedule(payload) {
      const operation = queue.catch(() => undefined).then(() => persist(payload));
      operation.catch(() => undefined);
      queue = operation;
    },
    flush() {
      return queue;
    },
  };
}

function wrapStore(store, mutations, snapshot, controller) {
  const mutable = new Set(mutations);
  return Object.fromEntries(Object.entries(store).map(([name, value]) => {
    if (typeof value !== "function" || !mutable.has(name)) return [name, value];
    return [name, (...args) => {
      const result = value.apply(store, args);
      controller.schedule(snapshot(store));
      return result;
    }];
  }));
}

async function persistStoreDocument(knex, runId, storeKey, payload) {
  const document = sourceDocument(payload);
  const now = new Date();
  const row = {
    store_key: storeKey,
    source_path: `postgres-live/${storeKey}.json`,
    payload: JSON.stringify(document.databasePayload),
    source_blob: document.sourceBlob,
    payload_contains_null: document.payloadContainsNull,
    source_sha256: document.sourceSha256,
    source_bytes: document.sourceBlob.length,
    record_count: recordCount(payload),
    migration_run_id: runId,
    source_modified_at: now,
    imported_at: now,
    updated_at: now,
  };
  await knex.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`runtime-store:${storeKey}`]);
    await trx("runtime_store_documents").insert(row).onConflict("store_key").merge(row);
  });
}

async function createPostgresPersistence(options = {}) {
  const environment = process.env.NODE_ENV || "development";
  const knex = options.knex || knexFactory(knexfile[environment] || knexfile.development);
  const ownsConnection = !options.knex;
  const runId = crypto.randomUUID();
  await knex.raw("select 1");
  await knex("runtime_migration_runs").insert({
    id: runId,
    status: "live",
    source_root: "postgres-runtime",
    manifest: JSON.stringify([]),
  });

  const rows = await knex("runtime_store_documents").select("store_key", "payload");
  const payloads = new Map(rows.map((row) => [row.store_key, row.payload]));
  const controllers = [];
  const stores = {};

  for (const spec of STORE_SPECS) {
    const initialPayload = payloads.get(spec.key);
    const store = initialPayload === undefined ? spec.factory() : spec.factory(initialPayload);
    const snapshot = spec.snapshot || ((target) => target.exportState());
    const controller = createPersistenceController((payload) => persistStoreDocument(knex, runId, spec.key, payload));
    controllers.push(controller);
    stores[spec.option] = wrapStore(store, spec.mutations, snapshot, controller);
  }

  let closed = false;
  return {
    stores,
    runId,
    knex,
    async flush() {
      await Promise.all(controllers.map((controller) => controller.flush()));
    },
    async close() {
      if (closed) return;
      closed = true;
      await this.flush();
      await knex("runtime_migration_runs").where({ id: runId }).update({ status: "completed", completed_at: knex.fn.now() });
      if (ownsConnection) await knex.destroy();
    },
  };
}

module.exports = {
  STORE_SPECS,
  createPersistenceController,
  createPostgresPersistence,
  sourceDocument,
  wrapStore,
};
