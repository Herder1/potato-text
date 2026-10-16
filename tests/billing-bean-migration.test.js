const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DAY_MS,
  BEAN_UNIT,
  createFileBillingStore,
  createMemoryBillingStore,
  migrateLegacyState,
} = require("../apps/api/src/billing-store");

// 旧口径样本（DEC-107 之前）：账户只有 AI 额度，套餐赠送按「点」记。
function legacyState(now = Date.UTC(2026, 7, 3)) {
  return {
    products: [
      {
        id: "product-chinese-literature-2026",
        name: "汉语言文学题库 365 天权益",
        productType: "project_subscription",
        scopeLabel: "广东普通专升本 · 五科九本",
        subjectIds: [],
        bookIds: [],
        durationDays: 365,
        priceCents: 19900,
        bonusAiCredits: 100,
        bonusValidityDays: 365,
        creditAmount: 0,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "product-ai-credits-50",
        name: "AI 额度 50 点",
        productType: "ai_credit_pack",
        scopeLabel: "充值额度长期有效",
        subjectIds: [],
        bookIds: [],
        durationDays: 0,
        priceCents: 990,
        bonusAiCredits: 0,
        bonusValidityDays: 0,
        creditAmount: 50,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    accounts: [{
      userId: "test-user",
      nickname: "薯考同学",
      entitlements: [],
      creditLots: [
        {
          id: "credit-lot-a",
          source: "registration_reward",
          sourceLabel: "注册测试奖励",
          grantedAmount: 20,
          remainingAmount: 6,
          expiresAt: now + 30 * DAY_MS,
          createdAt: now,
        },
        {
          id: "credit-lot-b",
          source: "subscription_bonus",
          sourceLabel: "年度套餐开通赠送",
          grantedAmount: 100,
          remainingAmount: 100,
          expiresAt: now + 300 * DAY_MS,
          createdAt: now,
        },
      ],
      transactions: [{
        id: "credit-tx-1",
        creditLotId: "credit-lot-a",
        transactionType: "grant",
        amount: 20,
        balanceAfter: 20,
        source: "registration_reward",
        description: "注册测试奖励",
        referenceId: "seed-registration-reward",
        createdAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    }],
  };
}

test("legacy AI credits convert to beans at 1 credit = 0.1 bean", () => {
  const now = Date.UTC(2026, 7, 3);
  const { state, changed } = migrateLegacyState(legacyState(now));
  assert.equal(changed, true);
  assert.equal(state.unit, BEAN_UNIT);
  const subscription = state.products.find((product) => product.id === "product-chinese-literature-2026");
  assert.equal(subscription.bonusBeans, 10);
  assert.equal("bonusAiCredits" in subscription, false);
  const pack = state.products.find((product) => product.productType === "bean_pack");
  assert.equal(pack.id, "product-beans-5");
  assert.equal(pack.beanAmount, 5);
  assert.equal(pack.name, "豆币 5 枚");
  assert.equal(pack.scopeLabel, "充值豆币长期有效");
  const [account] = state.accounts;
  assert.equal("creditLots" in account, false);
  assert.equal(account.beanLots.length, 2);
  assert.equal(account.beanLots[0].id, "bean-lot-a");
  assert.equal(account.beanLots[0].remainingAmount, 0.6);
  assert.equal(account.beanLots[1].remainingAmount, 10);
  assert.equal(account.beanLots.every((lot) => lot.unit === BEAN_UNIT), true);
  assert.deepEqual(account.orders, []);
  assert.equal(account.transactions[0].beanLotId, "bean-lot-a");
  assert.equal(account.transactions[0].amount, 2);
  assert.equal(account.transactions[0].balanceAfter, 2);
  assert.equal(account.transactions[0].unit, BEAN_UNIT);
});

test("migration is idempotent: a second pass changes nothing", () => {
  const now = Date.UTC(2026, 7, 3);
  const first = migrateLegacyState(legacyState(now)).state;
  const snapshot = JSON.parse(JSON.stringify(first));
  const second = migrateLegacyState(first);
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, snapshot);
});

test("memory store hydrates a legacy snapshot straight into beans", () => {
  const now = Date.UTC(2026, 7, 3);
  const store = createMemoryBillingStore(legacyState(now));
  const account = store.dashboard("test-user", now).account;
  assert.equal(account.beanBalance, 10.6);
  // 保价：0.1 豆币 = 原来 1 点额度，折算后的额度仍然买得到同样多次调用
  const consumed = store.consumeBeans("test-user", { amount: 0.1, referenceId: "ai-call-1" }, now + 1000);
  assert.equal(consumed.account.beanBalance, 10.5);
  const products = store.listProducts();
  assert.equal(products.find((product) => product.productType === "bean_pack").beanAmount, 5);
});

test("the file store migrates .runtime-style json in memory and only writes on an explicit persist", () => {
  const now = Date.UTC(2026, 7, 3);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "billing-beans-"));
  const filePath = path.join(directory, "billing.json");
  fs.writeFileSync(filePath, `${JSON.stringify(legacyState(now), null, 2)}\n`);

  const first = createFileBillingStore(filePath);
  // 读取即折算（内存），但**不写盘**：否则任何创建了默认文件 store 的进程（含测试）都会改正式数据
  assert.equal(first.dashboard("test-user", now).account.beanBalance, 10.6);
  const untouched = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal("creditLots" in untouched.accounts[0], true);
  assert.equal("beanLots" in untouched.accounts[0], false);
  assert.notEqual(untouched.unit, BEAN_UNIT);

  // 显式落盘（运维脚本 / 下一次真实写操作）之后，磁盘才是豆币口径
  assert.equal(first.normalizeUnits(now).unit, BEAN_UNIT);
  const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(onDisk.unit, BEAN_UNIT);
  assert.equal("creditLots" in onDisk.accounts[0], false);
  assert.equal(onDisk.accounts[0].beanLots[1].remainingAmount, 10);

  // 第二个进程再读同一个文件：不能再折一次（幂等靠「旧字段已消失」判定，不靠版本号）
  const second = createFileBillingStore(filePath);
  assert.equal(second.dashboard("test-user", now).account.beanBalance, 10.6);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).accounts[0].beanLots[1].remainingAmount, 10);

  fs.rmSync(directory, { recursive: true, force: true });
});
