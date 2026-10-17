const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../apps/miniprogram");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const platformContent = require("../apps/miniprogram/utils/platform-content");

// 2026-10-17 产品负责人三连要求：
//   ① 商品页「购买须知 · 退款说明」的硬编码弹窗改成打开《退款政策》文档（正文唯一维护处＝后台「平台设置」）；
//   ② 关于页七份文档的图标风格与颜色统一；
//   ③ 修窄屏机型上「重试同步 / 导出我的数据」按钮重叠（样式断言见 tests/settings-pages.test.js）。

test("store pages open the refund document instead of a hardcoded modal", () => {
  for (const page of ["store", "store-order"]) {
    const script = read("pages", page, `${page}.js`);
    const markup = read("pages", page, `${page}.wxml`);
    const start = script.indexOf("openPurchaseNotice()");
    assert.ok(start > -1, `${page} 应保留 openPurchaseNotice 入口方法`);
    const block = script.slice(start, start + 400);
    assert.match(block, /wx\.navigateTo\(\{ url: "\/pages\/legal\/legal\?doc=refund" \}\)/,
      `${page} 的购买须知应打开退款政策文档`);
    assert.doesNotMatch(block, /showModal/, `${page} 不应再用硬编码弹窗讲退款口径`);
    // 退款口径只留在平台文本里：脚本里不得再出现写死的退款文案
    assert.doesNotMatch(script, /微信支付通道尚未启用；启用后如需退款/);
    assert.match(markup, /bindtap="openPurchaseNotice"/, `${page} 页面上要有可点入口`);
  }
  // store 页脚原本写死的「套餐订单与赠送豆币分账…」改成可点入口，避免与文档双写
  assert.doesNotMatch(read("pages", "store", "store.wxml"), /套餐订单与赠送豆币分账/);
  assert.match(read("pages", "store", "store.wxml"), /购买须知与退款政策 ›/);
  assert.match(read("pages", "store", "store.wxss"), /\.store-footnote-link \{ color: #0b9588; \}/);
  assert.match(read("pages", "store-order", "store-order.wxml"), /购买须知 · 退款政策 ›/);
});

test("about page document icons share one stroke width and one colour", () => {
  const docs = platformContent.docList();
  assert.equal(docs.length, 7);
  for (const doc of docs) {
    const file = path.join(ROOT, doc.icon.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), `${doc.icon} 应存在`);
    const svg = fs.readFileSync(file, "utf8");
    assert.match(svg, /viewBox="0 0 24 24"/, `${doc.icon} 需 24 视口，才能与其它图标同一线宽`);
    assert.match(svg, /stroke="#474d49"/, `${doc.icon} 描边颜色应与仓库其它线性图标一致（#474d49）`);
    assert.match(svg, /stroke-width="1\.8"/, `${doc.icon} 描边宽度应统一为 1.8`);
    assert.match(svg, /stroke-linecap="round"/, `${doc.icon} 端点应圆角`);
    assert.match(svg, /stroke-linejoin="round"/, `${doc.icon} 转角应圆角`);
    assert.equal((svg.match(/<(path|circle|rect|line|polyline|polygon)\b/g) || []).length > 0, true, `${doc.icon} 不能是空图`);
    assert.doesNotMatch(svg, /fill="(?!none)[^"]+"/, `${doc.icon} 统一为线性图标，不使用色块填充`);
  }
});
