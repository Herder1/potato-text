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

// 2026-09-23 04:Bx 产品负责人真机反馈「去掉新建这两个字」：题库页（题包/资料 tab）的悬浮创建入口
// 回到纯「＋」的圆钮。此前 DEC-078 曾给它补过文字（那条编号只出现在旧测试注释里，见 docs/OPEN_DECISIONS.md C2），
// 本轮按这条直接指令取代——所以这里反过来守：**两种状态下都不许再有可见文字**。
test("the library floating create button is an icon-only circle", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.resolve(__dirname, "../apps/miniprogram/pages/library");
  const markup = fs.readFileSync(path.join(dir, "library.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(dir, "library.wxss"), "utf8");

  const fab = markup.match(/<view class="library-fab"[\s\S]*?<\/view>\s*<\/view>/);
  assert.ok(fab, "题库页应当还有那颗悬浮创建入口");
  const fabMarkup = fab[0];

  // ① 不再有任何可见文字（含原来的「新建」/ 展开态的「收起」）；aria-label 是给读屏的名字，不算可见文字
  assert.doesNotMatch(fabMarkup, /<text/, "悬浮入口里不应再有 text 节点");
  assert.doesNotMatch(markup, /library-fab-label/, "library-fab-label 这条规则与节点都应删干净");
  assert.doesNotMatch(styles, /\.library-fab-label/, "wxss 里不应再留 .library-fab-label");
  assert.equal(fabMarkup.replace(/<[^>]*>/g, "").trim(), "", "按钮上不应有任何可见文字");

  // ② 去掉文字后必须是正圆（88rpx 见方），不能留成靠 padding 撑出来的椭圆
  assert.match(styles, /\.library-fab \{[^}]*width: 88rpx/);
  assert.match(styles, /\.library-fab \{[^}]*height: 88rpx/);
  assert.match(styles, /\.library-fab \{[^}]*padding: 0;/);
  assert.match(styles, /\.library-fab \{[^}]*border-radius: 50%/);
  assert.doesNotMatch(styles, /\.library-fab \{[^}]*min-width/, "不该再靠 min-width 撑宽");
  assert.doesNotMatch(styles, /\.library-fab \{[^}]*gap:/, "没有第二个子元素了，gap 该删");

  // ③ 无障碍不能一起丢：aria-label 按 tab 说清这一颗现在会做什么（题包＝新建题包、资料＝新建笔记）
  assert.match(fabMarkup, /role="button" aria-label="\{\{activeContentTab === 'packs' \? '新建题包' : '新建笔记'\}\}"/);
  assert.match(fabMarkup, /bindtap="createFromLibraryFab"/);
  assert.match(fabMarkup, /library-fab-stroke-horizontal/);
  assert.match(fabMarkup, /library-fab-stroke-vertical/);

  // ④ 2026-09-23 04:Cx：绿框里那两行菜单（录入题目 / 新建题包）整块撤掉——节点、样式、展开态都不许留
  assert.doesNotMatch(markup, /library-fab-menu/, "展开菜单的节点应已删除");
  assert.doesNotMatch(markup, /library-fab-action|library-fab-small/, "菜单里那两行（含「题」「包」圆标）应已删除");
  assert.doesNotMatch(markup, /toggleActionMenu|library-fab-glyph-close/, "不再有「＋→×」的展开/收起状态");
  // 注释里可以提到这些规则名（说明"删了什么"），所以比对前先去掉 CSS 注释
  const styleRules = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(styleRules, /\.library-fab-menu|\.library-fab-action|\.library-fab-small|\.library-fab-glyph-close/,
    "菜单与旋转态的样式规则应一并删除");
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
    drawerOpen: true,
  });
  page.onHide();
  assert.equal(page.data.packActionsOpen, false);
  assert.equal(page.data.categoryActionsOpen, false);
  assert.equal(page.data.selectedPack, null);
  assert.equal(page.data.categoryManageOpen, false);
  assert.equal(page.data.selectedCategory, null);
  assert.equal(page.data.sourceMenuOpen, false);
  assert.equal(page.data.drawerOpen, false, "抽屉也要收掉，否则遮罩会挡住底部导航");
  assert.equal(page.data.actionMenuOpen, undefined, "悬浮「＋」的展开态已随菜单撤掉，这份状态不该再存在");

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
