const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const products = [
  { id: "project", name: "年度套餐", productType: "project_subscription", scopeLabel: "五科九本", durationDays: 365, priceCents: 19900, bonusAiCredits: 100 },
  { id: "subject", name: "单科订阅", productType: "subject_subscription", scopeLabel: "现代汉语", durationDays: 365, priceCents: 6900, bonusAiCredits: 30 },
  { id: "credits", name: "AI 额度 50 点", productType: "ai_credit_pack", scopeLabel: "长期有效", priceCents: 990, creditAmount: 50 },
];

function createStorePage() {
  let definition;
  let modal = null;
  let switchedUrl = "";
  const storage = new Map();
  const app = {
    globalData: {
      apiBaseUrl: "http://billing.test",
      loggedIn: false,
      billingAccount: {
        creditBalance: 20,
        expiringCredits: 5,
        permanentCredits: 15,
        subscriptions: [{
          id: "subscription-1",
          productId: "project",
          expiresAt: 1893456000000,
          product: { name: "年度套餐", scopeLabel: "五科九本" },
        }],
        transactions: [{
          id: "transaction-1",
          amount: -3,
          description: "AI 主观题评分",
          createdAt: 1893456000000,
        }],
      },
    },
    syncBillingAccount(callback) { callback(this.globalData.billingAccount); },
  };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    request(options) { options.success({ statusCode: 200, data: { products } }); },
    showModal(options) { modal = options; },
    switchTab({ url }) { switchedUrl = url; },
    setStorageSync(key, value) { storage.set(key, value); },
  };
  const modulePath = require.resolve("../apps/miniprogram/pages/store/store.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return { page, app, storage, getModal: () => modal, getSwitchedUrl: () => switchedUrl };
}

test("billing storefront separates subscriptions and AI credit products", () => {
  const context = createStorePage();
  const { page, app, storage } = context;
  page.onLoad({ tab: "credits" });
  page.onShow();

  assert.equal(page.data.visibleProducts.length, 1);
  assert.equal(page.data.aiCredits, 20);
  assert.equal(page.data.expiringCredits, 5);
  assert.equal(page.data.permanentCredits, 15);
  assert.equal(page.data.subscriptions[0].expiresText, "2030.01.01");
  assert.equal(page.data.creditTransactions[0].amountText, "-3");
  assert.match(page.data.creditTransactions[0].timeText, /^2030\.01\.01 /);
  assert.equal(page.data.visibleProducts[0].priceLabel, "¥9.9");
  assert.match(page.data.visibleProducts[0].benefits.join(" "), /50 点 AI 额度/);
  page.selectTab({ currentTarget: { dataset: { id: "subscriptions" } } });
  assert.equal(page.data.visibleProducts.length, 2);
  assert.equal(page.data.visibleProducts[0].featured, true);

  page.startPurchase({ currentTarget: { dataset: { id: "project" } } });
  assert.equal(context.getModal().title, "登录后购买");
  context.getModal().success({ confirm: true });
  assert.equal(context.getSwitchedUrl(), "/pages/profile/profile");

  app.globalData.loggedIn = true;
  page.startPurchase({ currentTarget: { dataset: { id: "credits" } } });
  assert.match(context.getModal().content, /不会扣款/);
  context.getModal().success({ confirm: true });
  assert.equal(storage.get("shukao_pending_billing_product"), "credits");

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("profile uses one account entry and account page contains balances, history, and storefront", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram");
  const profile = fs.readFileSync(path.join(root, "pages/profile/profile.wxml"), "utf8");
  const profileScript = fs.readFileSync(path.join(root, "pages/profile/profile.js"), "utf8");
  const store = fs.readFileSync(path.join(root, "pages/store/store.wxml"), "utf8");
  const storeConfig = JSON.parse(fs.readFileSync(path.join(root, "pages/store/store.json"), "utf8"));
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  assert.doesNotMatch(profile, /account-sheet-layer/);
  assert.match(profileScript, /menu:\s*\["我的账户"/);
  assert.match(profileScript, /name === "我的账户"[^\n]+\/pages\/store\/store/);
  assert.doesNotMatch(profileScript, /billingPanel|openBillingStore|closeBillingPanel/);
  assert.match(store, /当前订阅/);
  assert.match(store, /限时额度/);
  assert.match(store, /长期额度/);
  assert.match(store, /额度流水/);
  assert.match(store, /订阅套餐/);
  assert.match(store, /补充 AI 额度/);
  assert.equal(storeConfig.navigationBarTitleText, "我的账户");
  assert.ok(appConfig.pages.includes("pages/store/store"));
});
