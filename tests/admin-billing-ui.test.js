const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const adminRoot = path.join(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(adminRoot, "index.html"), "utf8");
const app = fs.readFileSync(path.join(adminRoot, "app.js"), "utf8");

test("billing navigation opens the bean view and keeps order columns intact", () => {
  assert.match(html, /data-view="订阅与豆币">订阅与豆币<\/button>/);
  assert.match(app, /const isBilling = name === "订阅与豆币"/);
  assert.match(html, /<section class="content billing-view" id="billing-admin" hidden>/);
  assert.match(html, /<h2>订阅与豆币<\/h2>/);
  assert.match(html, /<nav class="billing-tabs" id="billing-tabs"/);
  assert.match(app, /function setBillingTab\(tab, options = \{\}\)/);
  assert.match(app, /state\.billingTab = nextTab/);
  assert.deepEqual([...html.matchAll(/data-billing-tab="([^"]+)"/g)].map((match) => match[1]), [
    "products", "account", "ledger", "orders",
  ]);
  assert.deepEqual([...html.matchAll(/data-billing-panel="([^"]+)"/g)].map((match) => match[1]), [
    "products", "account", "ledger", "orders",
  ]);
  assert.match(html, /<h2>商品管理<\/h2>/);
  assert.match(html, /<h2>用户权益<\/h2>/);
  const usersPanel = html.slice(html.indexOf('id="billing-panel-account"'), html.indexOf('id="billing-panel-ledger"'));
  assert.doesNotMatch(usersPanel, /id="billing-account-copy"|id="billing-entitlements"|id="billing-lot-table-body"/);
  assert.match(html, /<dialog class="config-dialog billing-account-dialog" id="billing-account-dialog" aria-labelledby="billing-account-title">/);
  assert.match(html, /id="close-billing-account"/);
  assert.match(html, /id="cancel-billing-account"/);
  assert.match(html, /id="billing-open-user"/);
  assert.match(app, /function openBillingAccountDialog\(userId = state\.billingUserId\)/);
  assert.match(app, /if \(!dialog\.open\) dialog\.showModal\(\)/);
  assert.match(app, /if \(button\) openBillingAccountDialog\(button\.dataset\.billingViewUser\)/);
  assert.match(html, /id="billing-user-id"[^>]*value="test-user"/);
  assert.match(html, /id="billing-load-user"/);
  assert.match(app, /state\.billingUserId/);
  assert.match(app, /\/api\/admin\/billing\?userId=\$\{encodeURIComponent\(nextUserId\)\}/);
  assert.doesNotMatch(app, /billing\/users\/test-user\/grant-product/);
  assert.doesNotMatch(app, /billing\/users\/test-user\/grant-beans/);
  assert.match(html, /id="billing-product-package-name"/);
  assert.match(html, /id="billing-product-package-key"/);
  assert.match(html, /id="billing-product-project"/);
  assert.match(html, /<select id="billing-product-project"/);
  assert.match(html, /<fieldset class="field billing-scope-field" id="billing-product-subjects"/);
  assert.match(html, /<fieldset class="field billing-scope-field" id="billing-product-books"/);
  assert.doesNotMatch(html, /科目 ID|教材 ID|考试项目 ID/);
  assert.match(app, /loadQuestionCatalog\(\)\.then\(\(catalog\) =>/);
  assert.match(app, /renderBillingSubjects\(product\?\.subjectIds \|\| \[\], product\?\.bookIds \|\| \[\]\)/);
  assert.match(app, /subjectIds: billingScopeSelection\("#billing-product-subjects"\)/);
  assert.match(app, /bookIds: billingScopeSelection\("#billing-product-books"\)/);
  assert.match(app, /renderBillingBooks\(books\)/);
  assert.match(app, /packageName: document\.querySelector\("#billing-product-package-name"\)\.value/);
  assert.match(app, /packageKey: mode\.startsWith\("variant"\) \? state\.billingEditorPackageKey/);
  assert.match(app, /projectId: document\.querySelector\("#billing-product-project"\)\.value/);
  assert.match(app, /data-billing-product-action="copy"/);
  assert.match(app, /openBillingProductEditor\(button\.dataset\.id, true\)/);
  assert.match(app, /data-billing-product-action="group"/);
  assert.match(app, /billingCollapsedPackages/);
  assert.match(app, /\/api\/admin\/billing\/packages\/\$\{encodeURIComponent\(state\.billingEditorPackageKey\)\}/);
  assert.match(html, /id="billing-product-group-fields"/);
  assert.match(html, /id="billing-product-variant-fields"/);
  assert.match(html, /id="billing-new-bean-product"/);
  assert.match(app, /#billing-refresh-account"\)\.addEventListener\("click", \(\) => loadBilling\(\)\)/);
  assert.match(html, /<h2>豆币流水<\/h2>/);
  assert.match(html, /<h2>订单管理<\/h2>/);
  assert.match(html, /id="billing-panel-products"[^>]*data-billing-panel="products"/);
  assert.match(html, /id="billing-panel-account"[^>]*data-billing-panel="account" hidden/);
  assert.match(html, /id="billing-panel-ledger"[^>]*data-billing-panel="ledger" hidden/);
  assert.match(html, /id="billing-panel-orders"[^>]*data-billing-panel="orders" hidden/);
  const orderHeader = html.match(/<table class="billing-order-table"><thead><tr>(.*?)<\/tr><\/thead>/s);
  assert.ok(orderHeader);
  assert.deepEqual([...orderHeader[1].matchAll(/<th>(.*?)<\/th>/g)].map((match) => match[1]), [
    "时间", "用户 ID", "订单 / 商品", "金额", "赠币（剩余 / 发放）", "订阅权益", "状态 / 操作",
  ]);
  for (const id of ["billing-users-search-button", "billing-users-refresh", "billing-users-prev", "billing-users-next",
    "billing-orders-search-button", "billing-refresh-orders", "billing-orders-prev", "billing-orders-next"]) {
    assert.match(app, new RegExp(`#${id}"\\)\\.addEventListener`));
  }
  assert.match(html, /<span>订阅赠送豆币<\/span>/);
  assert.match(html, /<option value="activity_reward">官方活动赠送<\/option>/);
  assert.match(html, /id="billing-product-duration"[^>]*min="0"[^>]*max="1095"/);
  assert.match(html, /填写 0 表示永久/);
  assert.match(app, /function formatBillingDuration\(days\)/);
  assert.match(app, /Number\(days\) === 0 \? "永久"/);
  const orderRenderer = app.slice(app.indexOf("function billingOrderEntitlementText"), app.indexOf("function billingOrderStatusCell"));
  assert.match(orderRenderer, /account\.subscriptions/);
  assert.match(orderRenderer, /order\.refundMode === "revoke"/);
});
