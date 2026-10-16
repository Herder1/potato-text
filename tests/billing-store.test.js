const test = require("node:test");
const assert = require("node:assert/strict");
const { DAY_MS, createMemoryBillingStore, initialState } = require("../apps/api/src/billing-store");

test("subscription grants beans and stays separate from the bean pack recharge", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  // DEC-107：账户只有豆币；套餐按现价赠送豆币（现代汉语单科订阅原赠 30 点额度 → 3 豆币）
  const subscribed = store.purchaseProduct("test-user", "product-modern-chinese-2026", { channel: "admin_simulation" }, now + 1000);
  assert.equal(subscribed.account.subscriptions.length, 1);
  assert.equal(subscribed.account.subscriptions[0].expiresAt, now + 1000 + 365 * DAY_MS);
  assert.equal(subscribed.account.beanBalance, 5);
  assert.equal(subscribed.entitlement.orderId, subscribed.order.id);
  assert.equal(subscribed.beanGrant.lot.orderId, subscribed.order.id);
  assert.equal(subscribed.beanGrant.lot.source, "subscription_bonus");
  assert.equal(subscribed.order.priceCents, 6900);

  const recharged = store.purchaseProduct("test-user", "product-beans-5", { channel: "admin_simulation" }, now + 2000);
  assert.equal(recharged.account.beanBalance, 10);
  assert.equal(recharged.account.permanentBeans, 5);
  assert.equal(recharged.account.expiringBeans, 5);
  assert.equal(recharged.order.productType, "bean_pack");
  assert.equal(recharged.order.beanLotId, recharged.beanGrant.lot.id);
});

test("permanent subscriptions stay active without an expiry and can renew permanently", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  store.upsertProduct({
    id: "product-permanent-modern-chinese",
    name: "现代汉语永久权益",
    productType: "subject_subscription",
    scopeLabel: "现代汉语 · 上下册",
    subjectIds: ["modern-chinese"],
    bookIds: ["modern-chinese-7-1", "modern-chinese-7-2"],
    durationDays: 0,
    priceCents: 9900,
    bonusBeans: 1,
    bonusValidityDays: 0,
    active: true,
  });

  const purchase = store.purchaseProduct("test-user", "product-permanent-modern-chinese", { channel: "admin_simulation" }, now + 1000);
  assert.equal(purchase.entitlement.expiresAt, null);
  assert.equal(purchase.beanGrant.lot.expiresAt, null);
  assert.equal(purchase.account.subscriptions.length, 1);

  const farFuture = store.dashboard("test-user", now + 100 * 365 * DAY_MS).account;
  assert.equal(farFuture.subscriptions.length, 1);
  assert.equal(farFuture.subscriptions[0].expiresAt, null);

  const renewal = store.purchaseProduct("test-user", "product-permanent-modern-chinese", { channel: "admin_simulation" }, now + 2000);
  assert.equal(renewal.entitlement.expiresAt, null);
  assert.equal(renewal.account.subscriptions.length, 2);
});

test("same package supports multiple duration and price variants and renews across variants", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  store.upsertProduct({
    id: "product-modern-chinese-30",
    name: "现代汉语题库 30 天权益",
    packageKey: "subject-modern-chinese",
    packageName: "现代汉语题库",
    projectId: "gd-zsb-2026-hywxxkjc",
    productType: "subject_subscription",
    scopeLabel: "现代汉语 · 上下册",
    subjectIds: ["modern-chinese"],
    bookIds: ["modern-chinese-7-1", "modern-chinese-7-2"],
    durationDays: 30,
    priceCents: 990,
    bonusBeans: 0,
    bonusValidityDays: 0,
    active: true,
  });
  const first = store.purchaseProduct("test-user", "product-modern-chinese-30", { channel: "admin_simulation" }, now + 1000);
  const second = store.purchaseProduct("test-user", "product-modern-chinese-2026", { channel: "admin_simulation" }, now + 2000);
  assert.equal(first.product.packageKey, second.product.packageKey);
  assert.equal(first.product.durationDays, 30);
  assert.equal(second.product.durationDays, 365);
  assert.equal(second.entitlement.expiresAt, now + 1000 + 30 * DAY_MS + 365 * DAY_MS);
  assert.equal(second.order.packageName, "现代汉语题库");
  assert.equal(store.dashboard("test-user", now + 3000).account.subscriptions.length, 2);
  assert.throws(() => store.upsertProduct({
    id: "wrong-project",
    name: "无效项目",
    packageKey: "subject-modern-chinese",
    packageName: "现代汉语题库",
    projectId: "not-registered",
    productType: "subject_subscription",
    priceCents: 100,
    durationDays: 30,
  }), /billing_project_invalid/);
  assert.throws(() => store.upsertProduct({
    id: "wrong-scope",
    name: "错误范围",
    packageKey: "subject-modern-chinese",
    packageName: "现代汉语题库",
    productType: "subject_subscription",
    subjectIds: ["classical-chinese"],
    priceCents: 100,
    durationDays: 30,
  }), /billing_package_scope_conflict/);
});

test("package group updates shared scope atomically without rewriting variant prices or orders", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  const base = store.listProducts().find((item) => item.id === "product-modern-chinese-2026");
  store.upsertProduct({
    ...base, id: "product-modern-chinese-30", name: "现代汉语 30 天权益",
    durationDays: 30, priceCents: 1900, bonusBeans: 1, bonusValidityDays: 30,
  });
  assert.throws(() => store.upsertProduct({
    ...base, id: "product-modern-chinese-duplicate", name: "重复期限",
  }), /billing_package_duration_duplicate/);
  assert.throws(() => store.upsertProduct({
    ...base, id: "product-modern-chinese-wrong-scope", durationDays: 180,
    scopeLabel: "不同范围",
  }), /billing_package_scope_conflict/);
  const order = store.purchaseProduct("test-user", base.id, {}, now + 1000).order;
  const before = store.exportState();
  assert.throws(() => store.updatePackageGroup(base.packageKey, {
    productType: "bean_pack",
  }), /billing_product_type_invalid/);
  assert.throws(() => store.upsertProduct({
    ...base, productType: "bean_pack", beanAmount: 5,
  }), /billing_product_type_invalid/);
  assert.deepEqual(store.exportState(), before);
  assert.throws(() => store.updatePackageGroup(base.packageKey, {
    packageName: "无效套餐组", projectId: "unknown-project",
  }), /billing_project_invalid/);
  assert.deepEqual(store.exportState(), before);
  const updated = store.updatePackageGroup(base.packageKey, {
    packageName: "现代汉语精选题库",
    scopeLabel: "现代汉语 · 全两册",
    projectId: base.projectId,
    productType: base.productType,
    subjectIds: base.subjectIds,
    bookIds: base.bookIds,
  });
  assert.equal(updated.length, 2);
  assert.ok(updated.every((item) => item.packageName === "现代汉语精选题库" && item.scopeLabel === "现代汉语 · 全两册"));
  assert.deepEqual(updated.map((item) => item.priceCents), [6900, 1900]);
  assert.equal(store.dashboard("test-user", now + 2000).account.orders[0].productName, order.productName);
});

test("legacy products keep their original ID as a standalone package without rewriting the source state", () => {
  const legacy = initialState();
  delete legacy.products[0].packageKey;
  delete legacy.products[0].packageName;
  delete legacy.products[0].projectId;
  const store = createMemoryBillingStore(legacy);
  const product = store.listProducts().find((item) => item.id === legacy.products[0].id);
  assert.equal(product.packageKey, product.id);
  assert.equal(product.packageName, product.name);
  assert.ok(product.projectId);
  assert.equal(legacy.products[0].projectId, undefined);
});

test("bean consumption uses the earliest expiry, keeps 0.1 precision and is idempotent", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  store.grantBeans("test-user", { amount: 0.5, source: "activity_reward", expiresAt: now + DAY_MS, description: "官方活动赠送" }, now + 1000);
  store.grantBeans("test-user", { amount: 0.5, source: "paid_recharge", description: "充值豆币" }, now + 2000);

  const result = store.consumeBeans("test-user", { amount: 0.6, referenceId: "ai-call-1", description: "主观题评分" }, now + 3000);
  assert.equal(result.account.beanBalance, 2.4);
  const rewardLot = result.account.beanLots.find((lot) => lot.source === "activity_reward");
  const registrationLot = result.account.beanLots.find((lot) => lot.source === "registration_reward");
  const paidLot = result.account.beanLots.find((lot) => lot.source === "paid_recharge");
  assert.equal(rewardLot.remainingAmount, 0);
  assert.equal(registrationLot.remainingAmount, 1.9);
  assert.equal(paidLot.remainingAmount, 0.5);
  assert.equal(result.transactions.reduce((total, item) => total + item.amount, 0), -0.6);

  const duplicate = store.consumeBeans("test-user", { amount: 0.6, referenceId: "ai-call-1" }, now + 4000);
  assert.equal(duplicate.duplicated, true);
  assert.equal(duplicate.account.beanBalance, 2.4);
});

test("a single AI call costs 0.1 bean and 20 migrated credits still buy 20 calls", () => {
  const now = Date.UTC(2026, 6, 29);
  const state = initialState(now);
  state.accounts[0].beanLots[0].grantedAmount = 2;
  state.accounts[0].beanLots[0].remainingAmount = 2;
  const store = createMemoryBillingStore(state);
  for (let index = 0; index < 20; index += 1) {
    store.consumeBeans("test-user", { amount: 0.1, referenceId: `ai-call-${index}`, description: "主观题评分" }, now + index);
  }
  const account = store.dashboard("test-user", now + 100).account;
  assert.equal(account.beanBalance, 0);
  // 只接受 0.1 的整数倍且不少于 0.1：0.05 / 0 都不是合法豆币金额
  assert.throws(() => store.consumeBeans("test-user", { amount: 0.05, referenceId: "bad-1" }, now), /billing_bean_amount_invalid/);
  assert.throws(() => store.consumeBeans("test-user", { amount: 0, referenceId: "bad-2" }, now), /billing_bean_amount_invalid/);
});

test("failed bean consumption never changes lots or ledger", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  const before = store.dashboard("test-user", now).account;
  assert.throws(() => store.consumeBeans("test-user", { amount: 999, referenceId: "failed-call" }, now), /billing_bean_insufficient/);
  const after = store.dashboard("test-user", now).account;
  assert.equal(after.beanBalance, before.beanBalance);
  assert.equal(after.transactions.length, before.transactions.length);
});

test("refunding an order revokes the subscription and claws back only the unspent granted beans", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  const purchase = store.purchaseProduct("test-user", "product-chinese-literature-2026", { channel: "admin_simulation" }, now + 1000);
  assert.equal(purchase.account.beanBalance, 12);
  assert.equal(purchase.account.subscriptions.length, 1);
  // 先花掉赠币批次里的 0.5 豆币（按到期时间优先，注册奖励批次先被花完）
  store.consumeBeans("test-user", { amount: 11.5, referenceId: "ai-call-refund" }, now + 2000);
  const beforeRefund = store.dashboard("test-user", now + 3000).account;
  assert.equal(beforeRefund.beanBalance, 0.5);

  // 默认模式 = 退款（收回订阅权 + 扣回未消费赠币）
  const refund = store.refundOrder(purchase.order.id, { reason: "用户申请退款" }, now + 4000);
  assert.equal(refund.mode, "revoke");
  assert.equal(refund.clawedBackBeans, 0.5);
  assert.equal(refund.revokedEntitlement.id, purchase.entitlement.id);
  assert.equal(refund.order.status, "refunded");
  assert.equal(refund.order.refundMode, "revoke");
  assert.equal(refund.account.beanBalance, 0);
  assert.equal(refund.account.subscriptions.length, 0, "订阅权已收回，不再算有效订阅");
  assert.equal(refund.account.transactions[0].transactionType, "revoke");

  const duplicated = store.refundOrder(purchase.order.id, { reason: "重复请求" }, now + 5000);
  assert.equal(duplicated.duplicated, true);
  assert.equal(duplicated.mode, "revoke");
  assert.equal(duplicated.account.beanBalance, 0);
  assert.equal(duplicated.account.transactions.filter((item) => item.transactionType === "revoke").length, 1);
  assert.throws(() => store.refundOrder("order-not-exist", {}, now), /billing_order_not_found/);
  assert.throws(() => store.refundOrder(purchase.order.id, { mode: "乱写的模式" }, now), /billing_refund_mode_invalid/);
});

test("refund_only keeps the subscription and the granted beans (仅退款)", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  const purchase = store.purchaseProduct("test-user", "product-modern-chinese-2026", { channel: "admin_simulation" }, now + 1000);
  store.consumeBeans("test-user", { amount: 0.1, referenceId: "ai-call-1" }, now + 2000);
  const before = store.dashboard("test-user", now + 3000).account;
  assert.equal(before.beanBalance, 4.9);

  const refund = store.refundOrder(purchase.order.id, { mode: "refund_only", reason: "客服补偿：仅退款" }, now + 4000);
  assert.equal(refund.mode, "refund_only");
  assert.equal(refund.clawedBackBeans, 0);
  assert.equal(refund.revokedEntitlement, null);
  assert.equal(refund.order.status, "refunded");
  assert.equal(refund.order.refundMode, "refund_only");
  assert.equal(refund.account.beanBalance, 4.9, "仅退款不扣回赠币");
  assert.equal(refund.account.subscriptions.length, 1, "仅退款不收回订阅权");
  assert.equal(refund.account.transactions.some((item) => item.transactionType === "revoke"), false, "不产生 revoke 流水");
});

test("entitlement revocation and bean clawback are independent operations", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  const purchase = store.purchaseProduct("test-user", "product-chinese-literature-2026", { channel: "admin_simulation" }, now + 1000);

  // 只收回订阅权：豆币一分不动
  const revoked = store.revokeOrderEntitlement(purchase.order.id, "违规内容：收回权益", now + 2000);
  assert.equal(revoked.revokedEntitlement.revokedAt, now + 2000);
  assert.equal(revoked.account.beanBalance, 12, "收回订阅权不动豆币");
  assert.equal(revoked.account.subscriptions.length, 0);
  assert.equal(store.revokeOrderEntitlement(purchase.order.id, "", now + 3000).duplicated, true, "重复收回是幂等的");

  // 只扣回赠币：订阅权状态不变（这件事本身不改订单状态）
  const clawed = store.clawBackOrderBeans(purchase.order.id, "补扣赠币", now + 4000);
  assert.equal(clawed.clawedBackBeans, 10);
  assert.equal(clawed.account.beanBalance, 2);
  assert.equal(clawed.account.transactions[0].transactionType, "revoke");
  assert.equal(store.clawBackOrderBeans(purchase.order.id, "", now + 5000).clawedBackBeans, 0, "批次已扣空，重复调用不再扣");
  assert.equal(store.dashboard("test-user", now + 6000).account.orders[0].status, "paid", "独立操作不改订单状态，退款才改");

  // 续订叠加不得把已收回的权益算进去
  const renewal = store.purchaseProduct("test-user", "product-chinese-literature-2026", { channel: "admin_simulation" }, now + 7000);
  assert.equal(renewal.entitlement.expiresAt, now + 7000 + 365 * DAY_MS);
  assert.equal(renewal.account.subscriptions.length, 1);
});

test("refunding a bean pack order claws back the unspent recharge (no entitlement involved)", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  const purchase = store.purchaseProduct("test-user", "product-beans-5", { channel: "admin_simulation" }, now + 1000);
  assert.equal(purchase.account.beanBalance, 7);
  assert.equal(purchase.order.entitlementId, "");
  const refund = store.refundOrder(purchase.order.id, { reason: "充值退款" }, now + 2000);
  assert.equal(refund.clawedBackBeans, 5);
  assert.equal(refund.revokedEntitlement, null);
  assert.equal(refund.account.beanBalance, 2);
});
