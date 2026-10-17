const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { ONBOARDING_SKIP_KEY } = require("../apps/miniprogram/utils/onboarding-options");

// 启动闸门（2026-10-03 口径）：未登录冷启动拦一次进注册引导页；「先随便看看」之后不再拦。
// 这里锁的是闸门本身的四个边界：已登录放行、有跳过标记放行、已经在引导页不重复跳（防循环）、跳转只发一次。
function loadApp(wxMock) {
  let definition;
  global.App = (value) => { definition = value; };
  global.wx = wxMock;
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);
  return definition;
}

function storageMock(initial = []) {
  const storage = new Map(initial);
  return {
    storage,
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
  };
}

function createApp(options = {}) {
  const { storage, ...storageApi } = storageMock(options.storage || []);
  const launches = [];
  const syncs = [];
  const definition = loadApp({
    ...storageApi,
    reLaunch: ({ url }) => launches.push(url),
    switchTab: ({ url }) => launches.push(url),
    showToast: () => {},
    onNeedPrivacyAuthorization: () => {
      throw new Error("must not intercept the native privacy dialog");
    },
  });
  const app = {
    ...definition,
    globalData: structuredClone(definition.globalData),
    syncPersonalAssets: () => syncs.push(Date.now()),
  };
  return { app, storage, launches, syncs };
}

function unload() {
  delete global.App;
  delete global.wx;
  delete global.getCurrentPages;
}

test("an unlogged launch is gated into the onboarding page exactly once", () => {
  global.getCurrentPages = () => [{ route: "pages/review/review" }];
  const { app, launches } = createApp({});
  try {
    app.onShow();
    assert.deepEqual(launches, ["/pages/onboarding/onboarding"]);
    assert.equal(app.maybeGateOnboarding(), true, "第二次调用仍会发跳转（是否再拦由页面栈判断）");
  } finally {
    unload();
  }
});

test("a logged-in launch never sees the onboarding gate", () => {
  global.getCurrentPages = () => [{ route: "pages/review/review" }];
  const { app, launches, syncs } = createApp({});
  try {
    app.globalData.loggedIn = true;
    app.onShow();
    assert.deepEqual(launches, [], "已登录不该被拦");
    assert.equal(syncs.length, 1, "已登录仍要拉个人资产同步");
    assert.equal(app.maybeGateOnboarding(), false);
  } finally {
    unload();
  }
});

test("skipping on the onboarding page stops the launch gate from firing again", () => {
  global.getCurrentPages = () => [{ route: "pages/review/review" }];
  const { app, storage, launches } = createApp({});
  try {
    storage.set(ONBOARDING_SKIP_KEY, true);
    app.onShow();
    assert.deepEqual(launches, [], "点了「先随便看看」之后不该再弹");
    assert.equal(app.maybeGateOnboarding(), false);
  } finally {
    unload();
  }
});

test("the gate never re-launches onto itself, which would loop forever", () => {
  global.getCurrentPages = () => [{ route: "pages/onboarding/onboarding" }];
  const { app, launches } = createApp({});
  try {
    app.onShow();
    assert.deepEqual(launches, [], "已经在引导页就不能再跳引导页");
    assert.equal(app.maybeGateOnboarding(), false);
  } finally {
    unload();
  }
});

test("the gate stays inert where reLaunch is unavailable instead of throwing", () => {
  global.getCurrentPages = () => [{ route: "pages/review/review" }];
  const { app } = createApp({});
  try {
    delete global.wx.reLaunch;
    assert.equal(app.maybeGateOnboarding(), false);
  } finally {
    unload();
  }
});

test("the app leaves the native privacy dialog to WeChat instead of auto-answering it", () => {
  createApp({});
  try {
    const source = fs.readFileSync(require.resolve("../apps/miniprogram/app.js"), "utf8");
    assert.doesNotMatch(source, /onNeedPrivacyAuthorization/);
    assert.doesNotMatch(source, /setupPrivacyAuthorization/);
  } finally {
    unload();
  }
});

test("the entry page also calls the gate, so a reLaunch lost during app start self-corrects", () => {
  const review = fs.readFileSync(require.resolve("../apps/miniprogram/pages/review/review.js"), "utf8");
  // App.onShow 早于首页创建，reLaunch 可能被忽略；入口页 onShow 必须自己再拦一次
  assert.match(review, /onShow\(\) \{[\s\S]{0,400}maybeGateOnboarding\(\)/);
});
