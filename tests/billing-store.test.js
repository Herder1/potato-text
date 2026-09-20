const test = require("node:test");
const assert = require("node:assert/strict");
const { DAY_MS, createMemoryBillingStore, initialState } = require("../apps/api/src/billing-store");

test("subscription and permanent AI credits stay independent and produce a ledger", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  const subscribed = store.grantProduct("test-user", "product-modern-chinese-2026", "admin_simulation", now + 1000);
  assert.equal(subscribed.account.subscriptions.length, 1);
  assert.equal(subscribed.account.subscriptions[0].expiresAt, now + 1000 + 365 * DAY_MS);
  assert.equal(subscribed.account.creditBalance, 50);

  const recharged = store.grantProduct("test-user", "product-ai-credits-50", "admin_simulation", now + 2000);
  assert.equal(recharged.account.creditBalance, 100);
  assert.equal(recharged.account.permanentCredits, 50);
  assert.equal(recharged.account.expiringCredits, 50);
});

test("credit consumption uses the earliest expiry and is idempotent", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  store.grantCredits("test-user", { amount: 5, source: "task_reward", expiresAt: now + DAY_MS, description: "任务奖励" }, now + 1000);
  store.grantCredits("test-user", { amount: 5, source: "paid_recharge", description: "充值额度" }, now + 2000);

  const result = store.consumeCredits("test-user", { amount: 6, referenceId: "ai-call-1", description: "主观题评分" }, now + 3000);
  assert.equal(result.account.creditBalance, 24);
  const rewardLot = result.account.creditLots.find((lot) => lot.source === "task_reward");
  const registrationLot = result.account.creditLots.find((lot) => lot.source === "registration_reward");
  const paidLot = result.account.creditLots.find((lot) => lot.source === "paid_recharge");
  assert.equal(rewardLot.remainingAmount, 0);
  assert.equal(registrationLot.remainingAmount, 19);
  assert.equal(paidLot.remainingAmount, 5);

  const duplicate = store.consumeCredits("test-user", { amount: 6, referenceId: "ai-call-1" }, now + 4000);
  assert.equal(duplicate.duplicated, true);
  assert.equal(duplicate.account.creditBalance, 24);
});

test("failed credit consumption never changes lots or ledger", () => {
  const now = Date.UTC(2026, 6, 29);
  const store = createMemoryBillingStore(initialState(now));
  const before = store.dashboard("test-user", now).account;
  assert.throws(() => store.consumeCredits("test-user", { amount: 999, referenceId: "failed-call" }, now), /billing_credit_insufficient/);
  const after = store.dashboard("test-user", now).account;
  assert.equal(after.creditBalance, before.creditBalance);
  assert.equal(after.transactions.length, before.transactions.length);
});
