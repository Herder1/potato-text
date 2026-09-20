// 底部 tab 栏的选中态必须以「当前路由」为准：
// 之前它默认 selected: 2（复习是启动页）且只靠各页面 onShow 写入，
// 一旦某次没写到，题库页就会出现“页面在题库、高亮在复习”，
// 而且点“复习”还会被 switchTab 的早退吃掉、完全没反应。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const tabBarPath = path.resolve(__dirname, "../apps/miniprogram/custom-tab-bar/index.js");

function loadTabBar() {
  let definition;
  global.Component = (value) => { definition = value; };
  delete require.cache[tabBarPath];
  require(tabBarPath);
  delete global.Component;
  return definition;
}

function createInstance(definition) {
  const instance = {
    data: structuredClone(definition.data),
    patches: [],
    setData(patch) {
      this.patches.push(patch);
      Object.assign(this.data, patch);
    },
  };
  instance.syncSelectedFromRoute = definition.methods.syncSelectedFromRoute.bind(instance);
  instance.switchTab = definition.methods.switchTab.bind(instance);
  return instance;
}

test("the tab bar derives its highlight from the current route", () => {
  const definition = loadTabBar();
  const routes = [
    ["pages/library/library", 0],
    ["pages/knowledge/knowledge", 1],
    ["pages/review/review", 2],
    ["pages/home/home", 3],
    ["pages/profile/profile", 4],
  ];
  for (const [route, expected] of routes) {
    global.getCurrentPages = () => [{ route }];
    const instance = createInstance(definition);
    instance.syncSelectedFromRoute();
    assert.equal(instance.data.selected, expected, `${route} 应高亮第 ${expected} 个标签`);
  }

  // 非 tab 页（例如从题库点进题包页）时不动高亮，保留上一次的选中态
  global.getCurrentPages = () => [{ route: "pages/pack-collection/pack-collection" }];
  const instance = createInstance(definition);
  instance.syncSelectedFromRoute();
  assert.deepEqual(instance.patches, [], "非 tab 页不该改写高亮");
  delete global.getCurrentPages;
});

test("the review tab keeps the same label baseline as the other tabs", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/custom-tab-bar/index.wxss"), "utf8");
  // 光圈用绝对定位画在图标后面，不再把图标盒子撑高（否则「复习」两个字会被压得比同排低）
  assert.match(styles, /\.review-focus \{[^}]*width: 42rpx;[^}]*height: 42rpx/);
  assert.match(styles, /\.review-slot\.tab-selected \.review-focus::before \{[^}]*position: absolute/);
  assert.doesNotMatch(styles, /\.review-slot\.tab-selected \.review-focus \{[^}]*background: #e2f4ef/, "光圈不能再画在选择器本身上");
});

test("the tab bar is rebound on every page show and never早退 in switchTab", () => {
  const definition = loadTabBar();
  assert.equal(typeof definition.pageLifetimes.show, "function", "pageLifetimes.show 必须重算高亮");
  assert.equal(typeof definition.lifetimes.attached, "function", "attached 也要先算一次");

  const source = fs.readFileSync(tabBarPath, "utf8");
  assert.doesNotMatch(source, /Number\(index\) === this\.data\.selected\) return/, "不能再按渲染态早退");


  const calls = [];
  global.wx = { switchTab: (options) => calls.push(options) };
  const instance = createInstance(definition);
  instance.data.selected = 2;
  instance.switchTab({ currentTarget: { dataset: { index: 2, path: "/pages/review/review" } } });
  assert.deepEqual(calls, [{ url: "/pages/review/review" }], "即使高亮显示已是该页，也必须真的切一次");
  delete global.wx;
});
