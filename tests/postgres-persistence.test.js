const assert = require("node:assert/strict");
const test = require("node:test");
const {
  STORE_SPECS,
  createPersistenceController,
  createPostgresPersistence,
  sourceDocument,
  wrapStore,
} = require("../apps/api/src/postgres-persistence");
const { PRIMARY_RUNTIME_FILES } = require("../scripts/db/runtime-migration-lib");
const { BEAN_UNIT } = require("../apps/api/src/billing-store");

function createFakeKnex(rows = []) {
  const state = { rows: rows.map((row) => ({ ...row })), runs: [], writes: [], updates: [] };
  const builderFor = (table) => {
    const builder = { table };
    builder.insert = (row) => { builder.insertRow = row; return builder; };
    builder.onConflict = () => builder;
    builder.merge = (row) => { builder.insertRow = row; return builder; };
    builder.select = () => { builder.selectRows = true; return builder; };
    builder.where = (clause) => { builder.whereClause = clause; return builder; };
    builder.update = (row) => { builder.updateRow = row; return builder; };
    builder.then = (resolve, reject) => Promise.resolve().then(() => {
      if (builder.selectRows) return state.rows.map((row) => ({ ...row }));
      if (builder.updateRow) {
        state.updates.push({ table, where: builder.whereClause, row: builder.updateRow });
        return 1;
      }
      if (builder.insertRow) {
        if (table === "runtime_migration_runs") {
          state.runs.push(builder.insertRow);
          state.writes.push(table);
          return 1;
        }
        const index = state.rows.findIndex((row) => row.store_key === builder.insertRow.store_key);
        if (index >= 0) state.rows[index] = { ...builder.insertRow };
        else state.rows.push({ ...builder.insertRow });
        state.writes.push(builder.insertRow.store_key);
        return 1;
      }
      return undefined;
    }).then(resolve, reject);
    return builder;
  };
  const knex = (table) => builderFor(table);
  knex.raw = async () => [];
  knex.fn = { now: () => new Date() };
  knex.destroy = async () => {};
  knex.transaction = async (handler) => handler(knex);
  return { knex, state };
}

test("postgres question-family document persists family and member review mutations", () => {
  const spec = STORE_SPECS.find((item) => item.option === "questionFamilyStore");
  assert.ok(spec);
  assert.equal(["replaceState", "detachQuestions", "reviewMember", "createSet", "updateSet", "addSetMembers", "removeSetMember", "removeSet"]
    .every((name) => spec.mutations.includes(name)), true);
  const questionSpec = STORE_SPECS.find((item) => item.option === "questionStore");
  assert.equal(questionSpec.mutations.includes("replaceState"), true);
});

test("postgres moderation document persists feedback conversation mutations", () => {
  const spec = STORE_SPECS.find((item) => item.option === "moderationStore");
  assert.ok(spec);
  assert.equal(spec.mutations.includes("addMessage"), true);
});

test("postgres knowledge structure registers directory mapping and fill-missing mutations", () => {
  const spec = STORE_SPECS.find((item) => item.option === "knowledgeStructureStore");
  assert.ok(spec.mutations.includes("setDirectoryMapping"));
  assert.ok(spec.mutations.includes("fillMissingFingerprints"));
});

test("postgres persistence serializes writes and flushes the latest snapshot", async () => {
  const persisted = [];
  const controller = createPersistenceController(async (payload) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delay));
    persisted.push(payload.value);
  });
  controller.schedule({ value: 1, delay: 15 });
  controller.schedule({ value: 2, delay: 0 });
  await controller.flush();
  assert.deepEqual(persisted, [1, 2]);
});

test("postgres store wrapper preserves synchronous behavior and schedules mutations", async () => {
  let state = [];
  const writes = [];
  const store = {
    list: () => state.slice(),
    append(value) { state.push(value); return value; },
    exportState: () => state.slice(),
  };
  const controller = createPersistenceController(async (payload) => writes.push(payload));
  const wrapped = wrapStore(store, ["append"], (target) => target.exportState(), controller);
  assert.equal(wrapped.append("a"), "a");
  assert.deepEqual(wrapped.list(), ["a"]);
  await controller.flush();
  assert.deepEqual(writes, [["a"]]);
});

test("postgres store wrapper persists the restored snapshot after a rolled back mutation", async () => {
  let state = ["original"];
  const writes = [];
  const store = {
    append(value) { state.push(value); return value; },
    replaceState(value) { state = value.slice(); return state.slice(); },
    exportState: () => state.slice(),
  };
  const controller = createPersistenceController(async (payload) => writes.push(payload));
  const wrapped = wrapStore(store, ["append", "replaceState"], (target) => target.exportState(), controller);

  wrapped.append("partial");
  wrapped.replaceState(["original"]);
  await controller.flush();

  assert.deepEqual(writes, [["original", "partial"], ["original"]]);
});

test("postgres live documents retain exact bytes and sanitize JSONB nulls", () => {
  const document = sourceDocument({ text: "A\u0000B" });
  assert.equal(document.payloadContainsNull, true);
  assert.equal(document.databasePayload.text, "A\ufffdB");
  assert.equal(JSON.parse(document.sourceBlob.toString("utf8")).text, "A\u0000B");
  assert.equal(document.sourceSha256.length, 64);
});

test("postgres persistence wires the gold review, agent experience and merge commit stores", () => {
  const expected = [
    {
      option: "classificationGoldReviewStore",
      key: "classification-gold-reviews",
      mutations: ["replaceState", "importBatch", "replacePendingBatch", "createRevisionDraft",
        "reopenFamilyReviews", "syncPreflightIssues", "reviewContent", "reviewBusinessContent",
        "reloadItem", "reviewFamily", "prepareFreeze", "commitFreeze"],
    },
    {
      option: "knowledgeClassificationExperienceStore",
      key: "knowledge-classification-experience",
      mutations: ["replaceState", "addMessage", "createRule", "upsertDraftRule", "updateRule",
        "deleteRule", "addCase", "addCorrection", "addRuleException", "recordReviewEvent"],
    },
    {
      option: "questionMergeCommitStore",
      key: "question-merge-commits",
      mutations: ["prepare", "markCommitted", "markFailed"],
    },
  ];
  const keys = STORE_SPECS.map((spec) => spec.key);
  assert.equal(new Set(keys).size, keys.length);
  expected.forEach(({ option, key, mutations }) => {
    const spec = STORE_SPECS.find((item) => item.option === option);
    assert.ok(spec, `${option} 应登记在 STORE_SPECS`);
    assert.equal(spec.key, key);
    assert.equal(typeof spec.factory, "function");
    assert.equal(mutations.every((name) => spec.mutations.includes(name)), true, `${option} 缺少写方法登记`);
    const store = spec.factory();
    assert.equal(spec.mutations.every((name) => typeof store[name] === "function"), true, `${option} 登记了不存在的方法`);
    assert.equal(typeof store.exportState, "function");
  });
});

test("runtime import manifest covers the gold review and agent experience documents", () => {
  assert.equal(PRIMARY_RUNTIME_FILES.includes("classification-gold-reviews.json"), true);
  assert.equal(PRIMARY_RUNTIME_FILES.includes("knowledge-classification-experience.json"), true);
});

test("postgres persistence hydrates the AI stores from stored documents and writes mutations back", async () => {
  const goldSpec = STORE_SPECS.find((spec) => spec.option === "classificationGoldReviewStore");
  const experienceSpec = STORE_SPECS.find((spec) => spec.option === "knowledgeClassificationExperienceStore");
  const mergeSpec = STORE_SPECS.find((spec) => spec.option === "questionMergeCommitStore");

  const gold = goldSpec.factory();
  gold.importBatch({
    id: "boot-batch-v1",
    title: "启动装载验证",
    version: "V1",
    source: { batchId: "boot-source" },
    items: [{ questionId: "q-1", order: 1 }],
  });
  const experience = experienceSpec.factory();
  experience.createRule({ bookId: "modern-chinese-7-1", title: "装载规则", statement: "启动装载验证" });
  const merge = mergeSpec.factory();
  merge.prepare({ commitId: "boot-commit-1", requestHash: "boot-hash" });

  const { knex, state } = createFakeKnex([
    { store_key: "classification-gold-reviews", payload: gold.exportState() },
    { store_key: "knowledge-classification-experience", payload: experience.exportState() },
    { store_key: "question-merge-commits", payload: merge.exportState() },
  ]);

  const persistence = await createPostgresPersistence({ knex });
  assert.equal(persistence.stores.classificationGoldReviewStore.list().length, 1);
  assert.equal(persistence.stores.knowledgeClassificationExperienceStore.rules().length, 1);
  assert.equal(persistence.stores.questionMergeCommitStore.list().length, 1);

  const writesBeforeRead = state.writes.length;
  persistence.stores.classificationGoldReviewStore.list();
  persistence.stores.knowledgeClassificationExperienceStore.rules();
  persistence.stores.questionMergeCommitStore.list();
  await persistence.flush();
  assert.equal(state.writes.length, writesBeforeRead, "只读方法不应写库");

  persistence.stores.classificationGoldReviewStore.importBatch({
    id: "live-batch-v2",
    title: "运行期新增",
    version: "V2",
    source: { batchId: "live-source" },
    items: [{ questionId: "q-9", order: 1 }],
  });
  persistence.stores.knowledgeClassificationExperienceStore.addCase({
    bookId: "modern-chinese-7-1",
    questionId: "q-1",
    primaryNodeId: "node-core",
  });
  persistence.stores.questionMergeCommitStore.markCommitted("boot-commit-1", { merged: true });
  persistence.stores.questionMergeCommitStore.prepare({ commitId: "boot-commit-2", requestHash: "boot-hash-2" });
  await persistence.flush();

  assert.deepEqual(state.writes.slice(writesBeforeRead), [
    "classification-gold-reviews",
    "knowledge-classification-experience",
    "question-merge-commits",
    "question-merge-commits",
  ]);
  const goldRow = state.rows.find((row) => row.store_key === "classification-gold-reviews");
  assert.equal(JSON.parse(goldRow.payload).batches.length, 2);
  const experienceRow = state.rows.find((row) => row.store_key === "knowledge-classification-experience");
  assert.equal(JSON.parse(experienceRow.payload).cases.length, 1);
  assert.equal(experienceRow.record_count > 0, true);
  assert.equal(experienceRow.source_sha256.length, 64);
  const mergeRow = state.rows.find((row) => row.store_key === "question-merge-commits");
  assert.equal(JSON.parse(mergeRow.payload).commits.length, 2);

  await persistence.close();
  assert.equal(state.updates.length, 1);
});

test("postgres persistence hydrates the platform content store and writes publish mutations back", async () => {
  const spec = STORE_SPECS.find((item) => item.option === "platformContentStore");
  assert.ok(spec, "platformContentStore 应登记在 STORE_SPECS");
  assert.equal(spec.key, "platform-content");
  assert.equal(PRIMARY_RUNTIME_FILES.includes("platform-content.json"), true, "运维导入清单要带上平台设置文档");
  assert.deepEqual(spec.mutations, ["replaceState", "saveVersion", "publish", "unpublish"]);
  assert.equal(spec.mutations.every((name) => typeof spec.factory()[name] === "function"), true, "登记了不存在的方法");

  const seeded = spec.factory();
  seeded.saveVersion("terms", { version: "1.0", body: "正文一", effectiveDate: "2026-10-10" }, "超管");
  seeded.publish("terms", "1.0", "超管");

  const { knex, state } = createFakeKnex([{ store_key: "platform-content", payload: seeded.exportState() }]);
  const persistence = await createPostgresPersistence({ knex });
  const store = persistence.stores.platformContentStore;

  assert.equal(store.publicDocument("terms").body, "正文一", "启动装载要带回已发布正文");
  assert.deepEqual(store.history("terms").map((item) => item.version), ["1.0"]);

  const writesBeforeRead = state.writes.length;
  store.publicList();
  store.summaries();
  store.documents();
  await persistence.flush();
  assert.equal(state.writes.length, writesBeforeRead, "只读方法不应写库");

  store.saveVersion("terms", { version: "2.0", body: "正文二", effectiveDate: "2026-11-01" }, "超管");
  store.publish("terms", "2.0", "超管");
  await persistence.flush();
  assert.deepEqual(state.writes.slice(writesBeforeRead), ["platform-content", "platform-content"]);

  const row = state.rows.find((item) => item.store_key === "platform-content");
  const payload = JSON.parse(row.payload);
  assert.deepEqual(payload.documents.terms.versions.map((item) => item.version), ["1.0", "2.0"], "历史版本必须落库，不能被改版覆盖");
  assert.equal(payload.documents.terms.currentVersion, "2.0");
  assert.equal(payload.documents.terms.versions[0].body, "正文一");
  assert.equal(row.source_sha256.length, 64);

  await persistence.close();
});

test("postgres billing document converts legacy credits and survives bean mutations across reload", async () => {
  const legacy = {
    products: [{
      id: "legacy-pack",
      name: "AI 额度 50 点",
      productType: "ai_credit_pack",
      priceCents: 990,
      creditAmount: 50,
      active: true,
      createdAt: 1,
    }],
    accounts: [{
      userId: "billing-user",
      nickname: "测试用户",
      entitlements: [],
      creditLots: [{
        id: "credit-lot-old",
        source: "registration_reward",
        grantedAmount: 20,
        remainingAmount: 20,
        expiresAt: Date.now() + 86400000,
        createdAt: 1,
      }],
      transactions: [{
        id: "credit-tx-old",
        creditLotId: "credit-lot-old",
        transactionType: "grant",
        amount: 20,
        balanceAfter: 20,
        createdAt: 1,
      }],
    }],
  };
  const { knex, state } = createFakeKnex([{ store_key: "billing", payload: legacy }]);
  const first = await createPostgresPersistence({ knex });
  const billing = first.stores.billingStore;
  assert.equal(billing.dashboard("billing-user").account.beanBalance, 2);
  assert.equal(billing.listProducts()[0].beanAmount, 5);
  assert.equal(state.writes.includes("billing"), false, "读取旧快照不应擅自写库");

  const purchase = billing.purchaseProduct("billing-user", "legacy-pack");
  assert.equal(purchase.account.beanBalance, 7);
  const consume = billing.consumeBeans("billing-user", { amount: 0.1, referenceId: "call-1" });
  assert.equal(consume.account.beanBalance, 6.9);
  const refund = billing.refundOrder(purchase.order.id);
  assert.equal(refund.clawedBackBeans, 5);
  assert.equal(refund.account.beanBalance, 1.9);
  await first.flush();

  const saved = JSON.parse(state.rows.find((row) => row.store_key === "billing").payload);
  assert.equal(saved.unit, BEAN_UNIT);
  assert.equal(saved.accounts[0].creditLots, undefined);
  assert.equal(saved.accounts[0].beanLots.length, 2);
  assert.equal(saved.accounts[0].orders[0].status, "refunded");
  assert.equal(saved.accounts[0].transactions.at(-1).transactionType, "revoke");
  assert.equal(state.writes.filter((key) => key === "billing").length, 3);
  await first.close();

  const second = await createPostgresPersistence({ knex });
  assert.equal(second.stores.billingStore.dashboard("billing-user").account.beanBalance, 1.9);
  assert.equal(second.stores.billingStore.dashboard("billing-user").account.orders.length, 1);
  assert.equal(second.stores.billingStore.consumeBeans("billing-user", { amount: 0.1, referenceId: "call-1" }).duplicated, true);
  await second.close();
});
