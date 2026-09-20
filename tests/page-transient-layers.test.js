// 防止“隐形拦截层”回归：任何页面只要渲染带遮罩的瞬态浮层（wx:if="{{xxxOpen}}" / Visible），
// 就必须在 onHide（Tab 页再加 onShow）里收掉它们。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pagesRoot = path.resolve(__dirname, "../apps/miniprogram/pages");
const appConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/app.json"), "utf8"));
const registered = new Set(appConfig.pages.map((pagePath) => pagePath.split("/")[1]));
const LAYER_PATTERN = /wx:if="\{\{[a-zA-Z]+(Open|Visible)\}\}"/;

test("every registered page with transient overlay layers closes them when the page is left", () => {
  const offenders = [];
  const hooked = [];
  fs.readdirSync(pagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .forEach((entry) => {
      const page = entry.name;
      // 已从 app.json 下线的页面（如 pack-detail）不参与：不注册就不打包、也进不去
      if (!registered.has(page)) return;
      const markupPath = path.join(pagesRoot, page, `${page}.wxml`);
      const scriptPath = path.join(pagesRoot, page, `${page}.js`);
      if (!fs.existsSync(markupPath) || !fs.existsSync(scriptPath)) return;
      const markup = fs.readFileSync(markupPath, "utf8");
      if (!LAYER_PATTERN.test(markup)) return;
      const script = fs.readFileSync(scriptPath, "utf8");
      const hasOnHide = /\n  onHide\(\) \{/.test(script);
      const usesHelper = script.includes("closeTransientLayers(this");
      if (hasOnHide && usesHelper) hooked.push(page);
      else offenders.push(`${page}（onHide=${hasOnHide} closeTransientLayers=${usesHelper}）`);
    });

  assert.ok(hooked.length >= 10, `接入浮层收拢的页面太少：${hooked.join(", ")}`);
  assert.deepEqual(offenders, [], `这些页面有瞬态浮层却没有随页面离开收掉：${offenders.join("；")}`);
});

test("the shared layer helper only clears flags that are actually open", () => {
  const { transientLayerPatch, closeTransientLayers } = require("../apps/miniprogram/utils/page-layers");
  assert.deepEqual(transientLayerPatch({ aOpen: true, bOpen: false }, ["aOpen", "bOpen", "cOpen"]), { aOpen: false });

  const patches = [];
  const page = { data: { aOpen: false }, setData: (patch) => patches.push(patch) };
  closeTransientLayers(page, ["aOpen"]);
  assert.deepEqual(patches, [], "没有打开的浮层就不该 setData");

  closeTransientLayers({ data: { aOpen: true }, setData: (patch) => patches.push(patch) }, ["aOpen"], { actionMode: "" });
  assert.deepEqual(patches, [{ aOpen: false, actionMode: "" }]);
});
