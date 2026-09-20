const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { discoveryPayload } = require("../apps/api/src/server");

function createPage() {
  let definition;
  const storage = new Map();
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://discovery.test" } });
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    showToast() {},
    request(options) { options.success({ statusCode: 200, data: { success: true, ...discoveryPayload() } }); },
  };
  const modulePath = require.resolve("../apps/miniprogram/pages/home/home.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return { page, storage };
}

test("discovery filters storefront products and stores sale reminders", () => {
  const { page, storage } = createPage();
  page.onShow();
  assert.equal(page.data.visibleProducts.length, 3);
  page.selectChannel({ currentTarget: { dataset: { id: "material" } } });
  assert.equal(page.data.visibleProducts.length, 2);
  page.openProduct({ currentTarget: { dataset: { id: "material-literature-map" } } });
  assert.equal(page.data.detailOpen, true);
  page.reserveProduct();
  assert.deepEqual(storage.get("shukao_discovery_reservations"), ["material-literature-map"]);
  assert.equal(page.data.selectedProductReserved, true);
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("discovery page carries no top navigation title", () => {
  // 产品负责人 2026-09-19：发现页顶部的“发现”标题（原生导航栏承载）不再显示。
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/home");
  const config = JSON.parse(fs.readFileSync(path.join(pageDir, "home.json"), "utf8"));
  const markup = fs.readFileSync(path.join(pageDir, "home.wxml"), "utf8");

  assert.equal(config.navigationBarTitleText, "");
  assert.equal(config.navigationStyle, undefined);
  assert.doesNotMatch(markup, /nav-title/);
  assert.doesNotMatch(markup, />\s*发现\s*</);
});

test("product dialog close control keeps a compact fixed icon size", () => {
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/home");
  const markup = fs.readFileSync(path.join(pageDir, "home.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "home.wxss"), "utf8");

  assert.match(markup, /<view class="dialog-close"[^>]*role="button"/);
  assert.doesNotMatch(markup, /<button class="dialog-close"/);
  assert.match(styles, /\.dialog-close\s*\{[^}]*display:\s*flex;[^}]*width:\s*58rpx;[^}]*height:\s*58rpx;/s);
});
