const assert = require("node:assert/strict");
const test = require("node:test");

global.Page = () => {};
const { createNavigationMetrics } = require("../apps/miniprogram/pages/library/library.js");
delete global.Page;

test("library drawer close button reserves space when the capsule overlaps the drawer", () => {
  const metrics = createNavigationMetrics(
    { windowWidth: 412, windowHeight: 915, statusBarHeight: 44 },
    { left: 291, top: 51, width: 87, height: 32 },
  );

  const drawerRight = 412 * 0.82;
  assert.ok(drawerRight - metrics.drawerHeadSafeRight <= 291 - 8);
  assert.equal(metrics.statusBarHeight, 44);
  assert.equal(metrics.navTotalHeight, 90);
});

test("library drawer keeps its regular inset when the capsule is outside the drawer", () => {
  const metrics = createNavigationMetrics(
    { windowWidth: 375, windowHeight: 812, statusBarHeight: 44 },
    { left: 310, top: 50, width: 55, height: 32 },
  );

  assert.equal(metrics.drawerHeadSafeRight, 14);
});

test("library navigation uses stable fallbacks without capsule metrics", () => {
  const metrics = createNavigationMetrics(
    { windowWidth: 375, windowHeight: 667, statusBarHeight: 20 },
    {},
  );

  assert.equal(metrics.drawerHeadSafeRight, 14);
  assert.equal(metrics.capsuleSafeRight, 96);
  assert.equal(metrics.navTotalHeight, 60);
});

// DEC-078：题库页（题包/资料 tab）的悬浮创建入口原来只有一个「＋」，补上文字。
test("the library floating create button carries a text label", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.resolve(__dirname, "../apps/miniprogram/pages/library");
  const markup = fs.readFileSync(path.join(dir, "library.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(dir, "library.wxss"), "utf8");

  assert.match(markup, /class="library-fab"[\s\S]{0,420}class="library-fab-label">\{\{actionMenuOpen \? '收起' : '新建'\}\}<\/text>/);
  assert.match(styles, /\.library-fab \{[^}]*border-radius: 44rpx/);
  assert.match(styles, /\.library-fab \{[^}]*padding: 0 28rpx/);
  assert.match(styles, /\.library-fab \{[^}]*gap: 12rpx/);
  assert.match(styles, /\.library-fab-label \{[^}]*color: #fff;[^}]*font-size: 22rpx/);
});

// DEC-081：长按题包 / 分类弹出的深色工具栏原来只有图标，补上文字（与卡片工具栏同一套“图标在上、文字在下”）。
test("the pack long-press toolbars spell out their actions", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.resolve(__dirname, "../apps/miniprogram/pages/library");
  const markup = fs.readFileSync(path.join(dir, "library.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(dir, "library.wxss"), "utf8");

  ["编辑", "分类", "删除"].forEach((label) => {
    assert.ok(markup.includes(`<label>${label}</label>`), `题包工具栏应显示「${label}」`);
  });
  // 置顶项的文案随状态变化（已置顶时显示「取消置顶」）
  assert.match(markup, /pack-pin\.svg"[^>]*\/><label>\{\{selectedPack\.pinned \? '取消置顶' : '置顶'\}\}<\/label>/);
  ["重命名", "删除"].forEach((label) => {
    assert.ok(markup.includes(`<label>${label}</label>`), `分类工具栏应显示「${label}」`);
  });
  assert.match(markup, /class="pack-action-item[^"]*" bindtap="editPrivatePack"[^>]*><image[^>]*\/><label>编辑<\/label>/);
  assert.match(markup, /class="category-manage-item" bindtap="editPrivateCategory"[^>]*><image[^>]*\/><label>重命名<\/label>/);

  assert.match(styles, /\.pack-action-item \{[^}]*flex-direction: column/);
  assert.match(styles, /\.pack-action-item \{[^}]*height: 82rpx/, "尺寸对齐卡集列表页的选中工具栏");
  assert.match(styles, /\.pack-action-item \{[^}]*gap: 4rpx/);
  assert.match(styles, /\.pack-action-item label \{[^}]*color: #fff;[^}]*font-size: 15rpx/);
  assert.match(styles, /\.pack-action-panel \{[^}]*padding: 7rpx;[^}]*border-radius: 16rpx/);
  assert.match(styles, /\.category-manage-item \{[^}]*height: 82rpx/);
  assert.match(styles, /\.category-manage-item label \{[^}]*font-size: 15rpx/);
});

// 「页面能滚、按钮点不动」的根因：长按题包/分类弹出的工具栏带一张全屏遮罩，
// 透明时看不见、又不拦截滚动，盖在所有按钮（含底部导航）之上。
test("library long-press toolbars cannot leave an invisible full-screen mask behind", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  let definition;
  global.Page = (value) => { definition = value; };
  global.wx = { getStorageSync: () => "", setStorageSync() {}, removeStorageSync() {} };
  const modulePath = require.resolve("../apps/miniprogram/pages/library/library.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };

  page.setData({
    packActionsOpen: true,
    categoryActionsOpen: true,
    selectedPack: { id: "pack-1" },
    categoryManageOpen: true,
    selectedCategory: { id: "category-1" },
    sourceMenuOpen: true,
    actionMenuOpen: true,
    drawerOpen: true,
  });
  page.onHide();
  assert.equal(page.data.packActionsOpen, false);
  assert.equal(page.data.categoryActionsOpen, false);
  assert.equal(page.data.selectedPack, null);
  assert.equal(page.data.categoryManageOpen, false);
  assert.equal(page.data.selectedCategory, null);
  assert.equal(page.data.sourceMenuOpen, false);
  assert.equal(page.data.actionMenuOpen, false);
  assert.equal(page.data.drawerOpen, false, "抽屉也要收掉，否则遮罩会挡住底部导航");

  // onShow 也必须先收浮层：跨页残留不能让回到本页的用户一进来就点不动
  const source = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/library/library.js"), "utf8");
  assert.match(source, /onShow\(\) \{\s*\/\/[\s\S]{0,220}this\.resetTransientOverlays\(\);/);
  assert.match(source, /onHide\(\) \{\s*this\.resetTransientOverlays\(\);\s*\}/);
  assert.match(source, /closeTransientLayers\(this, \[[\s\S]{0,220}\]/);

  // 遮罩不能再是透明的：透明遮罩出问题时完全看不出来
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/library/library.wxss"), "utf8");
  assert.doesNotMatch(styles, /\.pack-action-mask \{[^}]*background: transparent/);
  assert.doesNotMatch(styles, /\.category-manage-mask \{[^}]*background: transparent/);
  assert.match(styles, /\.pack-action-mask \{[^}]*background: rgba\(21,30,25,\.08\)/);
  assert.match(styles, /\.category-manage-mask \{[^}]*background: rgba\(21,30,25,\.08\)/);

  delete global.Page;
  delete global.wx;
});
