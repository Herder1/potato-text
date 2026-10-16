const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
global.Page = () => {};
const { groupProducts, projectOptionsFromCatalog } = require("../apps/miniprogram/pages/store-order/store-order.js");
delete global.Page;

const projects = [
  { id: "project-a", label: "项目 A" },
  { id: "project-b", label: "项目 B" },
];
const products = [
  { id: "annual", packageKey: "literature", packageName: "文学题库", projectId: "project-a", productType: "project_subscription", durationDays: 365, priceCents: 19900, bonusBeans: 10 },
  { id: "monthly", packageKey: "literature", packageName: "文学题库", projectId: "project-a", productType: "project_subscription", durationDays: 30, priceCents: 2900, bonusBeans: 1 },
  { id: "semiannual", packageKey: "literature", packageName: "文学题库", projectId: "project-a", productType: "project_subscription", durationDays: 180, priceCents: 5990, bonusBeans: 0 },
  { id: "permanent", packageKey: "literature", packageName: "文学题库", projectId: "project-a", productType: "project_subscription", durationDays: 0, priceCents: 29900, bonusBeans: 0 },
  { id: "other", packageKey: "other", packageName: "项目 B 题库", projectId: "project-b", productType: "project_subscription", durationDays: 30, priceCents: 1900 },
  { id: "beans", productType: "bean_pack", priceCents: 990, beanAmount: 5 },
];

test("order page groups duration/price variants and filters by registered exam project", () => {
  const map = new Map(projects.map((project) => [project.id, project]));
  const all = groupProducts(products, map, "");
  assert.equal(all.length, 2);
  const selected = groupProducts(products, map, "project-a", "permanent");
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].variants.map((item) => item.id), ["monthly", "semiannual", "annual", "permanent"]);
  assert.equal(selected[0].selectedVariantId, "permanent");
  assert.equal(selected[0].selectedVariant.priceLabel, "¥299");
  assert.equal(selected[0].selectedVariant.durationLabel, "永久");
  assert.equal(selected[0].variants[0].bonusLabel, "赠送1豆币");
  assert.equal(selected[0].variants[1].bonusLabel, "仅￥0.34/天");
  assert.equal(selected[0].variants[2].bonusLabel, "赠送10豆币");
  assert.equal(selected[0].variants[3].bonusLabel, "仅￥299永久有效");
  assert.equal(groupProducts(products, map, "project-b")[0].variants[0].bonusLabel, "仅￥0.64/天");
  assert.equal(groupProducts(products, map, "project-b")[0].packageName, "项目 B 题库");
  assert.deepEqual(projectOptionsFromCatalog({ projects: [{ id: "project-a", name: "项目 A" }] }).map((item) => item.id), ["project-a"]);
  assert.deepEqual(projectOptionsFromCatalog({ project: { id: "legacy", name: "旧项目" } }).map((item) => item.id), ["legacy"]);
});

test("variants stay centered in one horizontal strip and reveal a preselected offscreen term", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram/pages/store-order");
  const markup = fs.readFileSync(path.join(root, "store-order.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "store-order.wxss"), "utf8");
  assert.match(markup, /<scroll-view class="variant-scroll" scroll-x="true"[^>]*scroll-into-view="variant-\{\{item\.selectedVariantId\}\}">/);
  assert.match(markup, /<view class="variant-list">[\s\S]*wx:for="\{\{item\.variants\}\}"[\s\S]*id="variant-\{\{variant\.id\}\}"/);
  assert.match(markup, /<view class="package-head">[\s\S]*?class="package-mark"[\s\S]*?<\/view>\s*<text class="package-meta">\{\{item\.projectName\}\} · \{\{item\.scopeText\}\}<\/text>/);
  assert.match(styles, /\.variant-list \{ display: inline-flex; min-width: 100%; gap: 16rpx;/);
  assert.match(styles, /\.variant-option \{[^}]*flex: 0 0 230rpx;[^}]*align-items: center; justify-content: center;[^}]*text-align: center;/);
  assert.doesNotMatch(styles, /\.variant-list \{[^}]*grid-template-columns:/);
});

test("order page selects a variant and submits a development test purchase", () => {
  let definition;
  let modal;
  let switchedUrl = "";
  const pending = new Map();
  const app = { globalData: { apiBaseUrl: "http://billing.test", apiEnvironment: "develop", loggedIn: true, authToken: "token", userId: "user-1" } };
  global.Page = (page) => { definition = page; };
  global.getApp = () => app;
  global.wx = {
    request(options) {
      if (options.url.endsWith("/api/catalog")) options.success({ statusCode: 200, data: { projects: [{ id: "project-a", name: "项目 A" }, { id: "project-b", name: "项目 B" }] } });
      else if (options.url.endsWith("/api/billing/test-purchase")) {
        options.success({ statusCode: 200, data: { order: { id: "test-order-1" }, account: { subscriptions: [] } } });
        if (options.complete) options.complete();
      }
      else options.success({ statusCode: 200, data: { products } });
    },
    showModal(options) { modal = options; },
    switchTab({ url }) { switchedUrl = url; },
    setStorageSync(key, value) { pending.set(key, value); },
  };
  const modulePath = require.resolve("../apps/miniprogram/pages/store-order/store-order.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  page.onLoad({ packageKey: "literature" });
  page.onShow();
  assert.equal(page.data.packageGroups.length, 2);
  page.selectProject({ currentTarget: { dataset: { id: "project-a" } } });
  assert.equal(page.data.packageGroups.length, 1);
  page.selectVariant({ currentTarget: { dataset: { id: "annual" } } });
  assert.equal(page.data.packageGroups[0].selectedVariantId, "annual");
  page.startPurchase({ currentTarget: { dataset: { id: "annual" } } });
  assert.match(modal.content, /365 天.*¥199/);
  modal.success({ confirm: true });
  assert.equal(page.data.purchaseBusy, false);
  assert.equal(pending.has("shukao_pending_billing_product"), false);
  app.globalData.loggedIn = false;
  page.startPurchase({ currentTarget: { dataset: { id: "monthly" } } });
  assert.equal(modal.title, "登录后购买");
  modal.success({ confirm: true });
  assert.equal(switchedUrl, "/pages/profile/profile");
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
