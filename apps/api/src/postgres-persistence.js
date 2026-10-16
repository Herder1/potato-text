const crypto = require("node:crypto");
const knexFactory = require("knex");
const knexfile = require("../../../knexfile");
const { createMemoryAdminOperationStore } = require("./admin-operation-store");
const { createMemoryAdminAccountStore } = require("./admin-account-store");
const { createMemoryAiScoreCacheStore } = require("./ai-score-cache-store");
const { createMemoryAiTaskStore } = require("./ai-task-store");
const { createMemoryAnnouncementStore } = require("./announcement-store");
const { createMemoryBillingStore } = require("./billing-store");
const { createMemoryClassificationGoldReviewStore } = require("./classification-gold-review-store");
const { createMemoryCommunityAssetStore } = require("./community-asset-store");
const { createMemoryKnowledgeClassificationExperienceStore } = require("./knowledge-classification-experience-store");
const { createMemoryQuestionMergeCommitStore } = require("./question-merge-commit-store");
const { createMemoryExamImportStore } = require("./exam-import-store");
const { createMemoryExamStore } = require("./exam-store");
const { createMemoryLearningStateStore } = require("./learning-state-store");
const { createMemoryPersonalCloudAssetStore } = require("./personal-cloud-asset-store");
const { createMemoryPlatformContentStore } = require("./platform-content-store");
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
const { recordCount, sanitizeForPostgres } = require("../../../scripts/db/runtime-migration-lib");

const STORE_SPECS = [
  { option: "aiConfigStore", key: "ai-config", factory: createMemoryAiConfigStore, mutations: ["save"], snapshot: (store) => store.load() },
  { option: "aiTaskStore", key: "ai-tasks", factory: createMemoryAiTaskStore, mutations: ["start", "update", "markFirstToken", "finish", "restart", "deleteUser"] },
  { option: "aiScoreCacheStore", key: "ai-score-cache", factory: createMemoryAiScoreCacheStore, mutations: ["set"] },
  { option: "questionStore", key: "questions", factory: createMemoryQuestionStore, mutations: ["replaceState", "create", "update", "transition", "importMany", "deleteMany", "updateImportBatch"] },
  { option: "questionFamilyStore", key: "question-families", factory: createMemoryQuestionFamilyStore, mutations: ["replaceState", "create", "addMembers", "moveMembers", "removeMember", "detachQuestions", "reviewMember", "remove", "relocate", "markPendingForQuestions", "setMemberships", "generate", "review", "createSet", "updateSet", "addSetMembers", "removeSetMember", "removeSet"] },
  { option: "knowledgeStructureStore", key: "knowledge-structures", factory: createMemoryKnowledgeStructureStore, mutations: ["generate", "fillGaps", "restoreBackup", "createNode", "updateNode", "deleteNode", "assignQuestions", "setDirectoryMapping", "fillMissingFingerprints"] },
  { option: "questionEnrichmentStore", key: "question-enrichment", factory: createMemoryQuestionEnrichmentStore, mutations: ["addSuggestion", "updateSuggestion", "createJob", "updateJob", "recoverInterrupted"] },
  { option: "knowledgeClassificationStore", key: "knowledge-classification", factory: createMemoryKnowledgeClassificationStore, mutations: ["createJob", "updateJob", "updateResult", "updateAuditReview", "markSentToEnrichment", "saveAgent1Features", "saveAgent1", "saveAgent2", "applyResult", "rejectResult", "recoverInterrupted"] },
  { option: "knowledgeDossierStore", key: "knowledge-dossiers", factory: createMemoryKnowledgeDossierStore, mutations: ["save", "createRun", "updateRun", "createDelta", "reviewDelta"] },
  // 2026-09-22（产品负责人选"组合 1：接可写线"）：以下三类此前只在内存/文件模式存在，
  // postgres 模式下退回内存实现、重启即丢，且服务器上产生的巡检经验无法回流本地。
  // 依据：产品手册 §10.4 L1395「正式上线前……将 Agent 4 经验 Store 纳入统一持久化」（上线 P0 阻断项）。
  // 注意：本次只解决"单类不丢"；跨 Store 原子提交（同一事务／事务发件箱）仍待实现（见 RELEASE_CHECKLIST B4/B5）。
  { option: "classificationGoldReviewStore", key: "classification-gold-reviews", factory: createMemoryClassificationGoldReviewStore, mutations: ["replaceState", "importBatch", "replacePendingBatch", "createRevisionDraft", "reopenFamilyReviews", "syncPreflightIssues", "reviewContent", "reviewBusinessContent", "reloadItem", "reviewFamily", "prepareFreeze", "commitFreeze"] },
  { option: "knowledgeClassificationExperienceStore", key: "knowledge-classification-experience", factory: createMemoryKnowledgeClassificationExperienceStore, mutations: ["replaceState", "addMessage", "createRule", "upsertDraftRule", "updateRule", "deleteRule", "addCase", "addCorrection", "addRuleException", "recordReviewEvent"] },
  { option: "questionMergeCommitStore", key: "question-merge-commits", factory: createMemoryQuestionMergeCommitStore, mutations: ["prepare", "markCommitted", "markFailed"] },
  { option: "operationLogStore", key: "admin-actions", factory: createMemoryAdminOperationStore, mutations: ["append"] },
  { option: "adminAccountStore", key: "admin-accounts", factory: createMemoryAdminAccountStore, mutations: ["ensureBootstrapAdmin", "create", "resetPassword", "changePassword", "setStatus", "delete", "login", "logout", "revokeSessions"] },
  { option: "moderationStore", key: "moderation-reports", factory: createMemoryModerationStore, mutations: ["create", "action", "addMessage", "anonymizeUser", "sweepExpired"] },
  { option: "textbookCatalogStore", key: "textbook-catalogs", factory: createMemoryTextbookCatalogStore, mutations: ["savePdf", "setDraft", "updateDraft", "confirm", "rejectDraft"] },
  { option: "textbookKnowledgeStore", key: "textbook-knowledge", factory: createMemoryTextbookKnowledgeStore, mutations: ["begin", "appendPages", "importStructuredPages", "reindex", "updateChunk", "fail"] },
  { option: "examStore", key: "exams", factory: createMemoryExamStore, mutations: ["create", "update", "action", "remove"] },
  { option: "examImportStore", key: "exam-imports", factory: createMemoryExamImportStore, mutations: ["create", "update", "confirm", "remove"] },
  { option: "packStore", key: "packs", factory: createMemoryPackStore, mutations: ["create", "update", "action"] },
  { option: "billingStore", key: "billing", factory: createMemoryBillingStore, mutations: ["upsertProduct", "updatePackageGroup", "setProductActive", "purchaseProduct", "grantBeans", "consumeBeans", "revokeOrderEntitlement", "clawBackOrderBeans", "refundOrder", "anonymizeUser", "normalizeUnits"] },
  { option: "communityAssetStore", key: "community-assets", factory: createMemoryCommunityAssetStore, mutations: ["submit", "collect", "action", "withdraw", "anonymizeUser"] },
  { option: "userAuthStore", key: "users", factory: createMemoryUserAuthStore, mutations: ["assignPublicIds", "loginWechat", "logout", "logoutUser", "deleteUser", "recordAgreement"] },
  { option: "userRestrictionStore", key: "user-restrictions", factory: createMemoryUserRestrictionStore, mutations: ["apply", "lift", "anonymizeUser", "sweep", "replaceState"] },
  { option: "communityInteractionStore", key: "community-interactions", factory: createMemoryCommunityInteractionStore, mutations: ["add", "remove", "deleteUser", "replaceState"] },
  { option: "learningStateStore", key: "learning-state", factory: createMemoryLearningStateStore, mutations: ["merge", "deleteUser"] },
  { option: "personalCloudAssetStore", key: "personal-cloud-assets", factory: createMemoryPersonalCloudAssetStore, mutations: ["sync", "resolve", "deleteUser"] },
  { option: "announcementStore", key: "announcements", factory: createMemoryAnnouncementStore, mutations: ["create", "update", "action", "remove"] },
  // 2026-10-05（产品负责人：新增「平台设置」模块，第一阶段只做上线必需内容）：7 份平台文本
  // （用户协议 / 隐私政策 / AI 服务说明 / 退款政策 / 账号注销说明 / 运营主体与客服信息 / 个人信息收集清单）。
  // 口径：用户端只读"已发布"版本；已发布版本不可改写（改版＝新增一版 + 发布），历史版本与生效时间永久保留。
  { option: "platformContentStore", key: "platform-content", factory: createMemoryPlatformContentStore, mutations: ["replaceState", "saveVersion", "publish", "unpublish"] },
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

function parseStoredPayload(payload) {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
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
  const payloads = new Map(rows.map((row) => [row.store_key, parseStoredPayload(row.payload)]));
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
  parseStoredPayload,
  sourceDocument,
  wrapStore,
};
