const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const products = [
  { id: "project", name: "年度套餐", packageKey: "project-pack", packageName: "年度套餐", projectId: "project-a", productType: "project_subscription", scopeLabel: "五科九本", durationDays: 365, priceCents: 19900, bonusBeans: 10 },
  { id: "subject", name: "单科订阅", packageKey: "subject-pack", packageName: "单科订阅", projectId: "project-a", productType: "subject_subscription", scopeLabel: "现代汉语", durationDays: 365, priceCents: 6900, bonusBeans: 3 },
  { id: "permanent", name: "现代汉语永久权益", packageKey: "subject-pack", packageName: "单科订阅", projectId: "project-a", productType: "subject_subscription", scopeLabel: "现代汉语", durationDays: 0, priceCents: 9900, bonusBeans: 1 },
  { id: "beans", name: "豆币 5 枚", productType: "bean_pack", scopeLabel: "充值豆币长期有效", priceCents: 990, beanAmount: 5 },
];

function createStorePage() {
  let definition;
  let modal = null;
  let switchedUrl = "";
  let navigatedUrl = "";
  const toasts = [];
  const storage = new Map();
  const app = {
    globalData: {
      apiBaseUrl: "http://billing.test",
      loggedIn: false,
      billingAccount: {
        beanBalance: 2,
        expiringBeans: 0.5,
        permanentBeans: 1.5,
        subscriptions: [{
          id: "subscription-1",
          productId: "project",
          expiresAt: 1893456000000,
          product: { name: "年度套餐", packageKey: "project-pack", scopeLabel: "五科九本" },
        }],
        transactions: [{
          id: "transaction-1",
          amount: -0.3,
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
    showToast(options) { toasts.push(options.title); },
    switchTab({ url }) { switchedUrl = url; },
    navigateTo({ url }) { navigatedUrl = url; },
    setStorageSync(key, value) { storage.set(key, value); },
  };
  const modulePath = require.resolve("../apps/miniprogram/pages/store/store.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return {
    page,
    app,
    storage,
    getModal: () => modal,
    getSwitchedUrl: () => switchedUrl,
    getNavigatedUrl: () => navigatedUrl,
    getToasts: () => toasts,
  };
}

test("billing storefront keeps bean recharge on account page and moves subscriptions to order page", () => {
  const context = createStorePage();
  const { page, app, storage } = context;
  page.onLoad({ tab: "beans" });
  page.onShow();

  assert.equal(page.data.visibleProducts.length, 1);
  assert.equal(page.data.beans, 2);
  assert.equal(page.data.beanBalanceText, "2");
  assert.equal(page.data.expiringBeans, 0.5);
  assert.equal(page.data.permanentBeans, 1.5);
  assert.equal(page.data.subscriptions[0].expiresText, "2030.01.01");
  assert.equal(page.data.beanTransactions[0].amountText, "-0.3");
  assert.equal(page.data.visibleProducts[0].priceLabel, "¥9.9");

  page.selectTab({ currentTarget: { dataset: { id: "subscriptions" } } });
  assert.equal(page.data.visibleProducts.length, 0, "账户页不再展示可购买套餐");
  page.openOrderPage();
  assert.equal(context.getNavigatedUrl(), "/pages/store-order/store-order");

  app.globalData.loggedIn = true;
  page.startPurchase({ currentTarget: { dataset: { id: "beans" } } });
  assert.match(context.getModal().content, /不会扣款/);
  context.getModal().success({ confirm: true });
  assert.equal(storage.get("shukao_pending_billing_product"), "beans");

  page.onLoad({ tab: "credits" });
  assert.equal(page.data.activeTab, "beans");

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("account and order pages follow the membership and package-variant layout", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram");
  const markup = fs.readFileSync(path.join(root, "pages/store/store.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "pages/store/store.wxss"), "utf8");
  const script = fs.readFileSync(path.join(root, "pages/store/store.js"), "utf8");
  const orderMarkup = fs.readFileSync(path.join(root, "pages/store-order/store-order.wxml"), "utf8");
  const orderStyles = fs.readFileSync(path.join(root, "pages/store-order/store-order.wxss"), "utf8");
  const orderScript = fs.readFileSync(path.join(root, "pages/store-order/store-order.js"), "utf8");
  const orderConfig = JSON.parse(fs.readFileSync(path.join(root, "pages/store-order/store-order.json"), "utf8"));
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));

  assert.match(markup, /class="summary-label">会员状态<\/text>/);
  assert.match(markup, /class="store-segment" role="tablist" aria-label="账户类别"/);
  assert.match(markup, /class="segment-item \{\{activeTab === item\.id[\s\S]*role="tab"\s+aria-selected="\{\{activeTab === item\.id\}\}"/);
  assert.match(styles, /\.store-segment \{[^}]*border-bottom: 1rpx solid #dfe4df;/);
  assert.match(styles, /\.segment-item-active::after \{[^}]*background: #1686a7;/);
  assert.doesNotMatch(styles, /\.segment-item-active \{[^}]*background:/);
  assert.doesNotMatch(markup, /订阅状态/);
  assert.match(markup, /class="account-summary member-summary panel"/);
  assert.match(styles, /\.member-summary \{ padding-top: 30rpx; padding-bottom: 44rpx; \}/);
  assert.match(styles, /\.member-status-row \{ display: flex; margin-top: 30rpx; align-items: flex-end;/);
  assert.match(styles, /\.bean-summary \{ margin-top: 24rpx; padding: 30rpx 32rpx 26rpx; \}/);
  assert.match(styles, /\.member-status-copy, \.bean-total-copy \{ min-width: 0; min-height: 98rpx; flex: 1; \}/);
  assert.match(styles, /\.member-status-copy \.summary-value \{ min-height: 56rpx; margin-top: 0; font-size: 48rpx; font-weight: 700; \}/);
  assert.match(styles, /\.member-status-copy \.member-inactive \{ color: #b6534c; font-size: 36rpx; \}/);
  assert.match(styles, /\.member-status-copy \.summary-hint \{ margin-top: 8rpx; color: #c8871b; line-height: 34rpx; \}/);
  assert.match(styles, /\.bean-recharge, \.library-subscribe \{ flex: 0 0 auto; padding: 20rpx 48rpx;[\s\S]*font-size: 30rpx;/);
  assert.match(markup, /memberActive \? '已开通' : '未开通'/);
  assert.match(markup, /memberActive \? memberExpiryText : '会员功能权益尚未开放'/);
  assert.match(markup, /class="member-status-row"[\s\S]*class="library-subscribe"[^>]*>去订阅/);
  assert.match(markup, /transactionFilter === 'all' \? '暂无收支记录'/);
  assert.match(markup, /class="account-summary library-summary panel[\s\S]*<view class="subscription-list" wx:if="\{\{subscriptions\.length\}\}">/);
  assert.match(markup, /bindtap="openSubscriptionDetail"/);
  assert.match(markup, /wx:for="\{\{subscriptions\}\}" wx:key="id"[\s\S]*class="subscription-name">\{\{index \+ 1\}\}\. \{\{item\.product\.packageName/);
  assert.match(markup, /套餐时间/);
  assert.match(markup, /class="subscription-meta">\{\{item\.expiresLabel\}\}<\/text>/);
  assert.match(markup, /class="subscription-copy">\s*<text class="subscription-name">[\s\S]*?<\/text>\s*<text class="subscription-meta">\{\{item\.expiresLabel\}\}<\/text>\s*<\/view>\s*<view class="subscription-renew"[^>]*catchtap="renewSubscription"/);
  assert.doesNotMatch(markup, /class="subscription-meta">\{\{item\.scopeText\}\}/);
  assert.doesNotMatch(markup, /去学习|catchtap="goStudy"/);
  assert.match(markup, /class="sheet-bar sheet-bar-split">\s*<view class="subscription-renew"[^>]*catchtap="renewSubscription"/);
  assert.doesNotMatch(script, /goStudy\(\)/);
  assert.match(script, /openSubscriptionDetail\(event\)/);
  assert.match(script, /closeSubscriptionDetail\(\)/);
  assert.match(markup, /class="library-summary-body" wx:else/);
  assert.match(markup, /class="library-summary-body"/);
  assert.match(markup, /暂未开通订阅/);
  assert.doesNotMatch(markup, /subscriptions\.length \? '已开通'/);
  assert.equal((markup.match(/class="account-summary library-summary panel\b/g) || []).length, 1, "题库订阅应只有一张卡片");
  assert.ok(markup.indexOf('class="subscription-list"') > markup.indexOf('class="account-summary library-summary panel"'), "已购套餐应显示在题库订阅卡片内部");
  assert.match(styles, /\.library-summary \{ min-height: 700rpx;/);
  assert.match(styles, /\.subscription-list \{ margin: 24rpx -32rpx -28rpx; overflow: visible;/);
  assert.match(styles, /\.subscription-row \{ display: flex; padding: 26rpx 28rpx; align-items: flex-start; gap: 12rpx; border-bottom:/);
  assert.match(styles, /\.subscription-copy \{ min-width: 0; flex: 1; line-height: 1\.45; \}/);
  assert.match(styles, /\.subscription-name \{[^}]*font-size: 30rpx;/);
  assert.match(styles, /\.subscription-meta \{ margin-left: 12rpx;[^}]*white-space: nowrap;/);
  assert.doesNotMatch(styles, /\.subscription-info \{/);
  assert.match(styles, /\.subscription-renew \{[^}]*color: #0b9588; border: 1rpx solid #bfe3da;/);
  assert.match(styles, /\.sheet-bar-split \{ justify-content: flex-end; \}/);
  assert.match(markup, /去订阅/);
  assert.doesNotMatch(markup, /class="order-entry panel"/);
  assert.doesNotMatch(markup, /class="plan-card panel"/);
  assert.doesNotMatch(markup, /selectedProduct/);
  assert.match(styles, /\.bean-total-row \{ display: flex; margin-top: 30rpx; min-width: 0; align-items: flex-end;/);
  assert.match(styles, /\.bean-expire \{ margin-top: 8rpx; color: #c8871b; font-size: 24rpx; line-height: 34rpx; \}/);
  assert.match(styles, /\.bean-split \{ display: flex; margin-top: 38rpx;/);
  assert.match(script, /wx\.navigateTo\(\{ url: "\/pages\/store-order\/store-order"/);

  assert.match(orderMarkup, /class="project-chip [\s\S]*aria-label="全部考试项目"/);
  assert.doesNotMatch(orderMarkup, /class="page-intro"|class="page-title"/);
  assert.match(orderStyles, /\.project-chip \{ display: inline-flex; height: 72rpx;[^}]*align-items: center; justify-content: center;/);
  assert.match(orderMarkup, /wx:for="\{\{item\.variants\}\}"/);
  assert.match(orderMarkup, /class="variant-option \{\{item\.selectedVariantId === variant\.id/);
  assert.match(orderMarkup, /bindtap="startPurchase"/);
  assert.match(orderScript, /function groupProducts/);
  assert.match(orderScript, /packageKey/);
  assert.match(orderMarkup, /class="subscription-segment"/);
  assert.match(orderMarkup, /class="subscription-segment" role="tablist" aria-label="订阅类别"/);
  assert.match(orderMarkup, /data-category="membership" bindtap="selectCategory" role="tab" aria-selected="\{\{activeCategory === 'membership'\}\}"/);
  assert.match(orderMarkup, /data-category="library" bindtap="selectCategory" role="tab" aria-selected="\{\{activeCategory === 'library'\}\}"/);
  assert.match(orderStyles, /\.subscription-segment \{[^}]*border-bottom: 1rpx solid #dfe4df;/);
  assert.match(orderStyles, /\.subscription-tab-active::after \{[^}]*background: #1686a7;/);
  assert.doesNotMatch(orderStyles, /\.subscription-tab-active \{[^}]*background:/);
  assert.match(orderMarkup, /data-category="membership"/);
  assert.match(orderScript, /testPurchaseEnabled/);
  assert.match(orderScript, /\/api\/billing\/test-purchase/);
  assert.equal(orderConfig.navigationBarTitleText, "订阅");
  assert.ok(appConfig.pages.includes("pages/store-order/store-order"));
});

test("account page interactions keep recharge, ledger, orders and renewal usable", () => {
  const context = createStorePage();
  const { page } = context;
  context.app.globalData.loggedIn = true;
  page.onShow();
  assert.equal(page.data.accountState, "ready");
  assert.equal(page.data.memberActive, false, "题库订阅不应开通会员");
  assert.deepEqual(page.data.transactionFilters.map((item) => item.label), ["全部", "获取", "消耗", "过期"]);
  assert.equal(page.data.transactionFilter, "all");

  page.selectTab({ currentTarget: { dataset: { id: "beans" } } });
  page.selectBeanPack({ currentTarget: { dataset: { id: "beans" } } });
  assert.equal(page.data.selectedBeanId, "beans");
  page.openRechargeSheet();
  page.paySelectedBeanPack();
  assert.equal(page.data.paymentChannelEnabled, false);
  assert.match(context.getModal().title, /充值暂未开放/);
  assert.match(context.getModal().content, /不会扣款.*不会生成订单/);
  page.setData({ rechargeSheetOpen: true });
  page.onHide();
  assert.equal(page.data.rechargeSheetOpen, false);

  page.setData({
    beanTransactions: [
      { id: "in-1", income: true, amountText: "+10" },
      { id: "out-1", income: false, amountText: "-2" },
      { id: "exp-1", income: false, expired: true, amountText: "-0.5" },
    ],
  }, () => page.applyFilter());
  assert.deepEqual(page.data.visibleTransactions.map((item) => item.id), ["in-1", "out-1", "exp-1"]);
  page.selectTransactionFilter({ currentTarget: { dataset: { id: "in" } } });
  assert.deepEqual(page.data.visibleTransactions.map((item) => item.id), ["in-1"]);
  page.selectTransactionFilter({ currentTarget: { dataset: { id: "out" } } });
  assert.deepEqual(page.data.visibleTransactions.map((item) => item.id), ["out-1"]);
  page.selectTransactionFilter({ currentTarget: { dataset: { id: "expired" } } });
  assert.deepEqual(page.data.visibleTransactions.map((item) => item.id), ["exp-1"]);
  page.selectTransactionFilter({ currentTarget: { dataset: { id: "all" } } });
  assert.deepEqual(page.data.visibleTransactions.map((item) => item.id), ["in-1", "out-1", "exp-1"]);

  page.openOrders();
  assert.equal(page.data.ordersOpen, false);
  assert.equal(context.getToasts().pop(), "暂无订单记录");
  page.setData({ orders: [{ id: "order-1" }] });
  page.openOrders();
  assert.equal(page.data.ordersOpen, true);
  page.closeOrders();
  assert.equal(page.data.ordersOpen, false);

  page.renewSubscription({ currentTarget: { dataset: { id: "project" } } });
  assert.equal(context.getNavigatedUrl(), "/pages/store-order/store-order?packageKey=project-pack");

  page.openSubscriptionDetail({ currentTarget: { dataset: { id: "project" } } });
  assert.equal(page.data.subscriptionDetailOpen, true);
  assert.equal(page.data.selectedSubscription.productId, "project");
  page.closeSubscriptionDetail();
  assert.equal(page.data.subscriptionDetailOpen, false);
});

test("membership expiry is separate from library packages and clears when no longer active", () => {
  const { page } = createStorePage();
  const expiry = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const library = { id: "library", productId: "project", expiresAt: expiry, product: { productType: "project_subscription", name: "题库套餐" } };
  const member = { id: "member", productId: "member", expiresAt: expiry, product: { productType: "membership_subscription", name: "会员权益" } };
  page.applyAccount({ subscriptions: [library, member] });
  assert.equal(page.data.memberActive, true);
  assert.match(page.data.memberExpiryText, /^\d{4}-\d{2}-\d{2} 到期$/);
  assert.deepEqual(page.data.subscriptions.map((item) => item.id), ["library"]);

  page.applyAccount({ subscriptions: [library, { ...member, expiresAt: Date.now() - 1000 }] });
  assert.equal(page.data.memberActive, false);
  assert.equal(page.data.memberExpiryText, "");

  page.applyAccount({ subscriptions: [library, { ...member, revokedAt: Date.now() }] });
  assert.equal(page.data.memberActive, false);
  assert.equal(page.data.memberExpiryText, "");

  page.applyAccount({ subscriptions: [library, { ...member, expiresAt: null }] });
  assert.equal(page.data.memberActive, true);
  assert.equal(page.data.memberExpiryText, "永久有效");

  page.applyAccount({ subscriptions: [{ id: "legacy", productId: "old-package", expiresAt: expiry }] });
  assert.equal(page.data.memberActive, false);
  assert.deepEqual(page.data.subscriptions.map((item) => item.id), ["legacy"]);
});

test("profile keeps one account entry and registers the order page", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram");
  const profile = fs.readFileSync(path.join(root, "pages/profile/profile.wxml"), "utf8");
  const profileScript = fs.readFileSync(path.join(root, "pages/profile/profile.js"), "utf8");
  const store = fs.readFileSync(path.join(root, "pages/store/store.wxml"), "utf8");
  const storeConfig = JSON.parse(fs.readFileSync(path.join(root, "pages/store/store.json"), "utf8"));
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  assert.doesNotMatch(profile, /account-sheet-layer/);
  assert.match(profileScript, /menu:\s*\["我的账户"/);
  assert.match(profileScript, /name === "我的账户"[^\n]+\/pages\/store\/store/);
  assert.match(store, /会员状态/);
  assert.match(store, /题库订阅/);
  assert.match(store, /去订阅/);
  assert.match(store, /总资产（豆币）/);
  assert.match(store, /收支明细/);
  assert.doesNotMatch(store, /AI 额度/);
  assert.match(store, /disabled="\{\{!paymentChannelEnabled\}\}"/);
  assert.match(store, /暂未开放/);
  assert.doesNotMatch(store, />立即支付\{\{/);
  assert.equal(storeConfig.navigationBarTitleText, "我的账户");
  assert.ok(appConfig.pages.includes("pages/store-order/store-order"));
});

test("renewals of one package appear as one active membership with the final expiry", () => {
  const { groupSubscriptions } = require("../apps/miniprogram/pages/store/store.js");
  const subscriptions = groupSubscriptions([
    { id: "one", productId: "annual", expiresAt: Date.UTC(2027, 0, 1), product: { packageKey: "literature", packageName: "汉语言文学题库", scopeLabel: "五科九本" } },
    { id: "two", productId: "monthly", expiresAt: Date.UTC(2027, 1, 1), product: { packageKey: "literature", packageName: "汉语言文学题库", scopeLabel: "五科九本" } },
    { id: "three", productId: "other", expiresAt: null, product: { packageKey: "modern", packageName: "现代汉语" } },
  ]);
  assert.equal(subscriptions.length, 2);
  assert.equal(subscriptions[0].purchaseCount, 2);
  assert.equal(subscriptions[0].productId, "monthly");
  assert.equal(subscriptions[0].expiresText, "2027.02.01");
  assert.equal(subscriptions[1].expiresLabel, "永久有效");
});
