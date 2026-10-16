const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SETS_KEY = "shukao_card_box_sets";
const FOLDERS_KEY = "shukao_card_box_folders";
const ACTIVE_FOLDER_KEY = "shukao_card_box_active_folder";

function createFlow(existingStorage) {
  const storage = existingStorage || new Map([
    [FOLDERS_KEY, ["我的卡集", "期末复习"]],
    [SETS_KEY, [
      { id: "set-1", title: "现代汉语", author: "甲", folder: "我的卡集", cards: [] },
      { id: "set-2", title: "古代文学", author: "乙", folder: "期末复习", cards: [] },
    ]],
  ]);
  let definition;
  let modal;
  let toast = "";
  global.Page = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => storage.has(key) ? storage.get(key) : "",
    setStorageSync: (key, value) => storage.set(key, value),
    showToast: ({ title }) => { toast = title; },
    showModal: (options) => { modal = options; },
    showActionSheet() {},
    navigateTo() {},
    navigateBack() {},
  };
  const modulePath = require.resolve("../apps/miniprogram/pages/card-box/card-box.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  page.onShow();
  return {
    page,
    storage,
    modal: () => modal,
    toast: () => toast,
  };
}

test("empty card folders persist and reserved or duplicate names are rejected", () => {
  const flow = createFlow();
  flow.page.startCreateFolder();
  assert.equal(flow.page.data.directoryOpen, true);
  assert.equal(flow.page.data.folderInlineCreateOpen, true);
  assert.equal(flow.page.data.folderEditorOpen, false);
  flow.page.setData({ folderEditorValue: "空文件夹" });
  flow.page.saveFolderEditor();
  assert.deepEqual(flow.storage.get(FOLDERS_KEY), ["我的卡集", "期末复习", "空文件夹"]);
  assert.equal(flow.page.data.activeFolder, "空文件夹");
  assert.equal(flow.storage.get(ACTIVE_FOLDER_KEY), "空文件夹");
  assert.deepEqual(flow.page.data.visibleSets, []);

  flow.page.startCreateFolder();
  flow.page.setData({ folderEditorValue: "全部卡集" });
  flow.page.saveFolderEditor();
  assert.equal(flow.toast(), "不能使用这个名称");
  assert.equal(flow.storage.get(FOLDERS_KEY).includes("全部卡集"), false);

  flow.page.setData({ folderEditorValue: "期末复习" });
  flow.page.saveFolderEditor();
  assert.equal(flow.toast(), "该文件夹已存在");
});

test("the last opened folder survives page recreation, including all card sets", () => {
  let flow = createFlow();
  flow.page.selectFolder({ currentTarget: { dataset: { folder: "期末复习" } } });
  assert.equal(flow.storage.get(ACTIVE_FOLDER_KEY), "期末复习");

  flow = createFlow(flow.storage);
  assert.equal(flow.page.data.activeFolder, "期末复习");
  assert.deepEqual(flow.page.data.visibleSets.map((set) => set.id), ["set-2"]);

  flow.page.selectFolder({ currentTarget: { dataset: { folder: "全部卡集" } } });
  flow = createFlow(flow.storage);
  assert.equal(flow.page.data.activeFolder, "全部卡集");
  assert.deepEqual(flow.page.data.visibleSets.map((set) => set.id), ["set-1", "set-2"]);
});

test("a missing remembered folder falls back to an available folder and repairs the memory", () => {
  let flow = createFlow();
  flow.storage.set(ACTIVE_FOLDER_KEY, "已被移除的文件夹");

  flow = createFlow(flow.storage);

  assert.equal(flow.page.data.activeFolder, "我的卡集");
  assert.equal(flow.storage.get(ACTIVE_FOLDER_KEY), "我的卡集");
  assert.deepEqual(flow.page.data.visibleSets.map((set) => set.id), ["set-1"]);
});

test("renaming and deleting the current folder keep the remembered folder in sync", () => {
  const flow = createFlow();
  const event = { currentTarget: { dataset: { folder: "期末复习" } } };
  flow.page.selectFolder(event);
  flow.page.startRenameFolder(event);
  flow.page.setData({ folderEditorValue: "考前冲刺" });
  flow.page.saveFolderEditor();
  assert.equal(flow.page.data.activeFolder, "考前冲刺");
  assert.equal(flow.storage.get(ACTIVE_FOLDER_KEY), "考前冲刺");

  flow.page.deleteFolder({ currentTarget: { dataset: { folder: "考前冲刺" } } });
  flow.modal().success({ confirm: true });
  assert.equal(flow.page.data.activeFolder, "我的卡集");
  assert.equal(flow.storage.get(ACTIVE_FOLDER_KEY), "我的卡集");
});

test("folder row long press exposes actions without accidentally switching folders", () => {
  const flow = createFlow();
  flow.page.setData({ directoryOpen: true, activeFolder: "我的卡集" });
  const event = { currentTarget: { dataset: { folder: "期末复习" } } };
  flow.page.openFolderRowActions(event);
  flow.page.selectFolder(event);
  assert.equal(flow.page.data.folderActionTarget, "期末复习");
  assert.equal(flow.page.data.activeFolder, "我的卡集");
  assert.equal(flow.page.data.directoryOpen, true);

  flow.page.startRenameFolder(event);
  flow.page.setData({ folderEditorValue: "考前冲刺" });
  flow.page.saveFolderEditor();
  assert.deepEqual(flow.storage.get(FOLDERS_KEY), ["我的卡集", "考前冲刺"]);
  assert.equal(flow.storage.get(SETS_KEY).find((set) => set.id === "set-2").folder, "考前冲刺");
  assert.equal(flow.page.data.activeFolder, "我的卡集");

  flow.page.openActiveFolderActions();
  flow.page.toggleDirectory();
  assert.equal(flow.page.data.directoryOpen, true);
});

test("deleting a folder confirms and moves its card sets to a remaining folder", () => {
  const flow = createFlow();
  flow.page.setData({ activeFolder: "期末复习", directoryOpen: true });
  const event = { currentTarget: { dataset: { folder: "期末复习" } } };
  flow.page.deleteFolder(event);
  assert.match(flow.modal().content, /1 个卡集/);
  flow.modal().success({ confirm: false });
  assert.equal(flow.storage.get(FOLDERS_KEY).includes("期末复习"), true);

  flow.page.deleteFolder(event);
  flow.modal().success({ confirm: true });
  assert.deepEqual(flow.storage.get(FOLDERS_KEY), ["我的卡集"]);
  assert.equal(flow.storage.get(SETS_KEY).find((set) => set.id === "set-2").folder, "我的卡集");
  assert.equal(flow.page.data.activeFolder, "我的卡集");
});

test("folder drawer wires create and row-level long-press actions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-box/card-box.wxml"), "utf8");
  assert.match(source, /bindtap="startCreateFolder"/);
  assert.match(source, /class="folder-inline-editor"/);
  assert.match(source, /wx:if="\{\{folderInlineCreateOpen\}\}"/);
  assert.match(source, /wx:for="\{\{folders\}\}"/);
  assert.match(source, /bindlongpress="openFolderRowActions"/);
  assert.match(source, /catchtap="startRenameFolder"/);
  assert.match(source, /catchtap="deleteFolder"/);
});

test("card grid moves the description and author to the flip side", () => {
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/card-box");
  const markup = fs.readFileSync(path.join(pageDir, "card-box.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "card-box.wxss"), "utf8");

  assert.match(markup, /class="set-back-text">\{\{item\.displayDescription \|\| '暂无简介'\}\}<\/view>/);
  assert.match(markup, /class="set-back-author">作者 · \{\{item\.author \|\| '我的整理'\}\}<\/view>/);
  assert.doesNotMatch(markup, /class="set-subtitle"|class="set-author"/, "the front no longer shows description or author");
  assert.doesNotMatch(markup, /\{\{item\.subject\}\}/, "the subject tag is replaced by the flip control");
  assert.match(markup, /class="set-flip" catchtap="flipSet" data-id="\{\{item\.id\}\}"/);
  assert.match(markup, /class="set-flip set-flip-back" catchtap="flipSet"/);
  assert.match(styles, /\.set::before\{display:none\}/, "the decorative hollow ring is gone");
  assert.match(styles, /\.set-flip\{display:flex;width:44rpx;height:44rpx;flex:0 0 44rpx/, "the flip control sits in the flow head row");
  assert.doesNotMatch(styles, /\.set-flip\{position:absolute/, "the flip control is no longer absolutely positioned");
  assert.match(styles, /\.set-in-selection \.set-flip\{display:none\}/, "selection mode hides the flip control");
  assert.match(
    markup,
    /<view class="set-face set-face-back">\s*<view class="set-head">\s*<view class="set-back-label">简介<\/view>\s*<view class="set-flip set-flip-back"/,
    "the back head row carries the 简介 label where the front shows the count",
  );
  assert.doesNotMatch(
    markup,
    /set-face-back[\s\S]{0,260}set-count/,
    "the back face never repeats the card count",
  );
  assert.match(styles, /\.set-back-author\{margin-top:auto;padding-top:18rpx/);
  assert.match(
    markup,
    /<view class="set-head">\s*<view class="set-count">\{\{item\.count\}\} 张<\/view>\s*<view class="set-flip"/,
    "the count sits top left, the flip control top right, in one flow row",
  );
  assert.match(markup, /<view class="set-title">\{\{item\.title\}\}<\/view>/);
  assert.doesNotMatch(markup, /set-top/, "the legacy top row stays removed");
  assert.match(styles, /\.set-head\{display:flex;min-height:44rpx/);
  assert.match(styles, /\.set-count\{margin-top:0;color:#a79d8e/);
  assert.match(styles, /\.set-title\{display:-webkit-box;margin-top:12rpx;[^}]*-webkit-line-clamp:2\}/, "long titles clamp to two lines and use the full card width");
  const titleRules = styles.match(/\.set-title\{[^}]*\}/g) || [];
  assert.ok(titleRules.length, "the title keeps an explicit rule");
  titleRules.forEach((rule) => {
    assert.doesNotMatch(rule, /padding-right:\s*[1-9]/, `no title rule may shrink the wrapping width: ${rule}`);
  });
  assert.match(styles, /\.set-title\{display:-webkit-box;[^}]*padding:0;/, "the title resets any inherited padding");
  assert.match(styles, /\.set\{display:flex;[^}]*min-height:260rpx/);
  assert.match(styles, /\.page\{[^}]*background:#fdfcfa/);
  assert.match(styles, /\.set-tinted\{border-color:var\(--card-edge\)\}/, "the tinted edge colour comes from the inline custom property");
  assert.match(styles, /\.grid\{[^}]*gap:24rpx\}/);
  assert.match(styles, /\.page\{min-height:100vh;padding:0 32rpx/, "narrower page gutters widen the cards");
  assert.match(styles, /\.page\{[^}]*background:#fdfcfa/);
  const selectedRules = styles.match(/\.set-selected[^{}]*\{[^}]*\}/g) || [];
  const baseRules = selectedRules.filter((rule) => /^\.set-selected\{/.test(rule));
  const baseSelected = baseRules[baseRules.length - 1];
  assert.ok(baseSelected, "the selected card keeps a base rule of its own");
  assert.match(
    baseSelected,
    /border:3rpx solid #2f9fff/,
    "the selected card shows a visible blue frame instead of a 1rpx hairline",
  );
  assert.match(baseSelected, /box-shadow:none/, "selection itself never adds a shadow");
  assert.match(
    styles,
    /\.set-tinted\.set-selected\{border:3rpx solid #2f9fff\}/,
    "a painted card still shows the selection frame (its tinted border is transparent)",
  );
  assert.match(
    styles,
    /\.set\{box-shadow:inset 0 2rpx 0 rgba\(255,255,255,\.9\)/,
    "cards use inset edge light for the glass look, never a drop shadow",
  );
  assert.match(
    styles,
    /inset -10rpx -14rpx 26rpx -18rpx var\(--card-edge,rgba\(0,0,0,0\)\)/,
    "the shaded corner is a same-hue refraction that white cards simply skip",
  );
  assert.match(
    styles,
    /\.set\{display:flex;[^}]*\}\s*\.set-selected\{background:#f2fbf8;border:3rpx solid #2f9fff/,
    "the blue frame is declared after the base card border so nothing overrides it",
  );
  assert.match(styles, /\.set-face\{display:flex;flex:1;flex-direction:column/);
  assert.match(styles, /\.set-foot\{display:flex;margin-top:auto;padding-top:24rpx/, "the progress row is pinned to the card bottom");
  assert.match(styles, /\.progress\{margin-top:12rpx/, "the bar sits just above the card bottom padding");
  assert.match(styles, /\.set-back-text\s*\{[^}]*min-height:\s*32rpx/s);
});

test("flipping a card set only turns that card over", () => {
  const flow = createFlow();
  assert.equal(flow.page.data.visibleSets.length, 1, "only the active folder is visible");

  flow.page.flipSet({ currentTarget: { dataset: { id: "set-1" } } });
  assert.equal(flow.page.data.visibleSets[0].flipped, true);
  assert.equal(flow.page.data.sets.find((item) => item.id === "set-2").flipped, undefined);

  flow.page.flipSet({ currentTarget: { dataset: { id: "set-1" } } });
  assert.equal(flow.page.data.visibleSets[0].flipped, false);

  flow.page.flipSet({ currentTarget: { dataset: {} } });
  assert.equal(flow.page.data.visibleSets.filter((item) => item.flipped).length, 0);
});

test("the bottom navigation follows the pack-page layout: 智能练习 / 新建卡集 / 更多", () => {
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/card-box");
  const markup = fs.readFileSync(path.join(pageDir, "card-box.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "card-box.wxss"), "utf8");

  assert.match(markup, /class="float-bar" wx:if="\{\{!selecting\}\}" role="navigation" aria-label="卡集底部导航"/);
  // 左：智能练习（占位入口）／中：新建卡集（主操作胶囊）／右：更多
  assert.match(markup, /class="float-action" bindtap="smartPractice"[\s\S]{0,200}<label>智能练习<\/label>/);
  assert.match(markup, /class="float-primary" bindtap="createSet"[\s\S]{0,200}<label>新建卡集<\/label>/);
  assert.match(markup, /class="float-action" bindtap="openMoreDrawer"[\s\S]{0,200}<label>更多<\/label>/);
  const bar = markup.slice(markup.indexOf('class="float-bar"'), markup.indexOf('class="drawer-layer"'));
  assert.ok(bar.indexOf("智能练习") < bar.indexOf("新建卡集"), "智能练习在最左");
  assert.ok(bar.indexOf("新建卡集") < bar.indexOf("更多"), "新建卡集在中间");
  assert.doesNotMatch(bar, /open-type="share"|<label>分享<\/label>/, "分享已从底栏移入更多抽屉");
  assert.doesNotMatch(markup, /organizeSets|>整理<\/label>/);
  assert.doesNotMatch(markup, /class="create-set"/, "the black floating plus button is gone");
  assert.doesNotMatch(styles, /\.create-set\{/, "the floating plus styles are gone");
  assert.match(styles, /\.float-bar\{[^}]*box-shadow:\s*0 10rpx 30rpx/s, "the bottom bar keeps the only shadow");
  assert.match(styles, /\.set\{[^}]*box-shadow:\s*none/);
  assert.match(styles, /\.float-bar \.float-primary\{[^}]*background:#19211d/);
  assert.match(styles, /\.float-bar \.float-action\{[^}]*flex:1/);
  assert.match(styles, /\.drawer-share-trigger::after\{[^}]*border:none\}/, "the WeChat button chrome is neutralised");

  assert.equal(typeof flow0().page.drawerAction, "function");
  assert.equal(typeof flow0().page.smartPractice, "function");
  assert.match(fs.readFileSync(path.join(pageDir, "card-box.js"), "utf8"), /onShareAppMessage\(\) \{/);
});

test("the folder drawer stops above the floating bottom navigation", () => {
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/card-box");
  const styles = fs.readFileSync(path.join(pageDir, "card-box.wxss"), "utf8");
  const markup = fs.readFileSync(path.join(pageDir, "card-box.wxml"), "utf8");
  const rpx = (value) => Number(String(value).replace("rpx", ""));

  // 产品负责人 2026-09-23 01:2x 真机截图：「这抽屉太长了，缩短到底部导航上面」。
  // 抽屉（.directory）与浮层底栏（.float-bar）是两处独立数值，容易改一个忘一个——
  // 所以这条**把账算出来**：底栏上沿 = 它的 bottom 偏移 + 它的 height；
  // 抽屉下沿（bottom）= 偏移 + 高度 + 间隙，必须 ≥ 底栏上沿（留出可见的间隙，不能压上去）。
  const barRule = styles.match(/\.float-bar\{([^}]*)\}/);
  assert.ok(barRule, ".float-bar 规则要在");
  const barBottom = barRule[1].match(/bottom:\s*calc\((\d+)rpx \+ env\(safe-area-inset-bottom\)\)/);
  const barHeight = barRule[1].match(/height:\s*(\d+)rpx/);
  assert.ok(barBottom && barHeight, "底栏必须仍是 calc(<n>rpx + env(safe-area-inset-bottom)) 定位 + rpx 高度");
  const barTop = rpx(barBottom[1]) + rpx(barHeight[1]);

  const drawerRule = styles.match(/\.directory\{([^}]*)\}/g).pop();
  const drawerBottom = drawerRule.match(/bottom:\s*calc\((\d+)rpx \+ env\(safe-area-inset-bottom\)\)/);
  assert.ok(drawerBottom, "抽屉下沿也要跟着安全区走（calc(<n>rpx + env(safe-area-inset-bottom))），不能写死 px/百分比");
  assert.doesNotMatch(drawerRule, /bottom:\s*118rpx/, "旧值 118rpx 就是「太长」的原因：它比底栏上沿低，压在底栏上");
  const gap = rpx(drawerBottom[1]) - barTop;
  assert.ok(gap >= 8, `抽屉下沿要比底栏上沿高出可见的间隙，现在只高 ${gap}rpx（底栏上沿 ${barTop}rpx，抽屉 ${rpx(drawerBottom[1])}rpx）`);
  assert.ok(gap <= 60, `间隙别留太大（现在 ${gap}rpx），否则抽屉看着又短又浮`);

  // 抽屉顶边与内容都不动：仍是左上角浮层（top:154rpx / left:22rpx / 430rpx 宽），条目照旧。
  assert.match(drawerRule, /top:\s*154rpx/);
  assert.match(drawerRule, /left:\s*22rpx/);
  assert.match(drawerRule, /width:\s*430rpx/);
  assert.match(markup, /class="directory" wx:if="\{\{directoryOpen\}\}"/);
  assert.match(markup, /class="directory-title">切换文件夹</);
});

test("智能练习 is a placeholder entry that reports the feature is still being built", () => {
  const flow = createFlow();
  flow.page.smartPractice();
  assert.equal(flow.toast(), "功能开发中");
});

test("导入卡集 imports a community card set into my card sets", () => {
  const flow = createFlow();
  flow.page.importCardSet();
  assert.equal(flow.page.data.importSheetOpen, true);
  const options = flow.page.data.importOptions;
  assert.ok(options.length >= 1, "列出社区卡片集");
  const seed = options.find((item) => item.id === "community-pack-phonetics");
  assert.equal(Boolean(seed), true, "社区精选里的卡片集会出现在可导入列表里");
  assert.equal(seed.title, "现代汉语语音易错点 24 张");
  assert.equal(seed.contributor, "语音专项共创组");
  assert.equal(seed.imported, false);

  flow.page.selectImportCardSet({ currentTarget: { dataset: { id: "community-pack-phonetics" } } });
  const created = flow.storage.get(SETS_KEY).find((set) => set.title === "现代汉语语音易错点 24 张");
  assert.equal(Boolean(created), true, "导入后卡集落进我的卡集");
  assert.equal(created.author, "语音专项共创组");
  assert.equal(created.folder, "我的卡集");
  assert.equal(created.subject, "现代汉语");
  assert.equal(flow.page.data.importSheetOpen, false);
  assert.match(flow.toast(), /已导入/);

  // 再打开时该卡集标记为「已导入」，避免重复导入同一份
  flow.page.importCardSet();
  const again = flow.page.data.importOptions.find((item) => item.id === "community-pack-phonetics");
  assert.equal(again.imported, true);

  // 关闭抽屉 / 离开页面都会收掉导入面板
  flow.page.closeImportSheet();
  assert.equal(flow.page.data.importSheetOpen, false);
  flow.page.setData({ importSheetOpen: true });
  flow.page.onHide();
  assert.equal(flow.page.data.importSheetOpen, false);
});

test("community card set drafts map cards and keep the source metadata", () => {
  const { cardSetDraftFromAsset, communityCardSetOptions, isCommunityCardSet } = require("../apps/miniprogram/utils/community-card-sets");
  assert.equal(isCommunityCardSet({ type: "card_pack" }), true);
  assert.equal(isCommunityCardSet({ type: "question_pack" }), false);

  const draft = cardSetDraftFromAsset({
    id: "community-x",
    type: "card_pack",
    title: "语音卡片集",
    contributor: "小李",
    catalogPath: "现代汉语 / 第一章 语音",
    tags: ["语音"],
    cards: [{ section: "第一章 语音", question: "声母有哪些？", answer: "21 个辅音声母。" }],
  });
  assert.equal(draft.title, "语音卡片集");
  assert.equal(draft.author, "小李");
  assert.equal(draft.subject, "现代汉语");
  assert.deepEqual(draft.tags, ["语音"]);
  assert.equal(draft.cards.length, 1);
  assert.equal(draft.cards[0].question, "声母有哪些？");
  assert.equal(draft.cards[0].section, "第一章 语音");

  // 只有题目/答案形态的资产也能转成卡片
  const questionDraft = cardSetDraftFromAsset({
    id: "community-y",
    type: "card_pack",
    title: "题目形态",
    questions: [{ stem: "什么是语素？", referenceAnswer: "最小的音义结合体。" }],
  });
  assert.equal(questionDraft.cards[0].question, "什么是语素？");
  assert.equal(questionDraft.cards[0].answer, "最小的音义结合体。");

  // 远端优先 + 种子兜底 + 按 id 去重；非卡片集类型被过滤
  const options = communityCardSetOptions([
    { id: "community-pack-phonetics", type: "card_pack", title: "远端版" },
    { id: "community-question-001", type: "question", title: "共享题目" },
  ]);
  assert.equal(options[0].title, "远端版");
  assert.equal(options.filter((item) => item.id === "community-pack-phonetics").length, 1);
  assert.equal(options.some((item) => item.id === "community-question-001"), false);
});

function flow0() {
  return createFlow();
}

test("the more drawer opens from the bottom and wires the folder tools", () => {
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/card-box");
  const markup = fs.readFileSync(path.join(pageDir, "card-box.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "card-box.wxss"), "utf8");

  assert.match(markup, /class="drawer-layer" wx:if="\{\{moreDrawerOpen\}\}" catchtouchmove="stopTouchMove"/);
  assert.match(markup, /class="drawer-mask" bindtap="closeMoreDrawer"/);
  ["分享与导入", "样式设置", "卡盒管理"].forEach((title) => {
    assert.ok(markup.includes(`>${title}</view>`), `the drawer keeps the ${title} section`);
  });
  ["分享卡集", "导入卡集", "更换颜色", "管理文件夹", "新建文件夹", "重命名文件夹"].forEach((label) => {
    assert.ok(markup.includes(`<label>${label}</label>`), `the drawer lists ${label}`);
  });
  // DEC-077：原来那一行（新建卡盒 / 整理卡集 / 全部卡集）整行撤掉，换成分享卡集 + 导入卡集
  ["新建卡盒", "整理卡集", "全部卡集"].forEach((label) => {
    assert.ok(!markup.includes(`<label>${label}</label>`), `the old row item ${label} is gone`);
  });
  assert.match(
    markup,
    /class="drawer-item drawer-item-share-host"[\s\S]{0,200}<label>分享卡集<\/label>[\s\S]{0,200}<button class="drawer-share-trigger" open-type="share" aria-label="分享卡集">/,
    "分享卡集是普通条目 + 覆盖其上的透明原生分享按钮",
  );
  assert.match(markup, /class="drawer-item" bindtap="importCardSet"[\s\S]{0,160}<label>导入卡集<\/label>/, "导入卡集与分享同排");
  assert.match(styles, /\.more-drawer\{[^}]*bottom:0[^}]*border-radius:28rpx 28rpx 0 0[^}]*animation:drawer-up/);
  const drawerMarkup = markup.slice(markup.indexOf('class="drawer-layer"'));
  assert.doesNotMatch(
    drawerMarkup,
    /pack-(?:plus|edit|folder|trash)\.svg/,
    "the white toolbar icons would be invisible on the light drawer",
  );
  assert.match(drawerMarkup, /card-rename\.svg/);
  assert.match(drawerMarkup, /card-import\.svg/, "导入卡集用导入图标");
  assert.match(drawerMarkup, /share\.svg/, "分享卡集用分享图标");
  assert.match(drawerMarkup, /plus\.svg/);
  // 分享条目用「普通条目 + 透明原生按钮」：按钮的盒子不再参与网格排布，列对齐与同排一致
  assert.match(styles, /\.drawer-item-share-host\{position:relative\}/);
  assert.match(styles, /\.drawer-share-trigger\{[^}]*left:0[^}]*width:100%[^}]*opacity:0/);
  assert.match(styles, /@keyframes drawer-up\{from\{transform:translateY\(100%\)\}/);

  const flow = createFlow();
  assert.equal(flow.page.data.moreDrawerOpen, false);
  flow.page.openMoreDrawer();
  assert.equal(flow.page.data.moreDrawerOpen, true);

  flow.page.setData({ directoryOpen: false, folderInlineCreateOpen: false });
  flow.page.drawerAction({ currentTarget: { dataset: { key: "folders" } } });
  assert.equal(flow.page.data.moreDrawerOpen, false, "picking an item closes the drawer");
  assert.equal(flow.page.data.directoryOpen, true, "管理文件夹 opens the folder list");

  flow.page.setData({ directoryOpen: false, folderInlineCreateOpen: false });
  flow.page.drawerAction({ currentTarget: { dataset: { key: "newFolder" } } });
  assert.equal(flow.page.data.folderInlineCreateOpen, true, "新建文件夹 opens the inline folder editor");

  flow.page.setData({ folderEditorOpen: false });
  flow.page.drawerAction({ currentTarget: { dataset: { key: "renameFolder" } } });
  assert.equal(flow.page.data.folderEditorOpen, true, "重命名文件夹 opens the rename editor");

  // 整理卡集 / 全部卡集 不再占抽屉位置：能力仍在（长按卡集进多选；顶部文件夹栏切「全部卡集」）
  flow.page.setData({ selecting: false, selectedIds: [] });
  flow.page.organizeSets();
  assert.deepEqual(flow.page.data.selectedIds, ["set-1"], "整理能力仍可通过长按卡集进入多选");

  flow.page.cancelSelect();
  flow.page.showAllFolders();
  assert.equal(flow.page.data.activeFolder, "全部卡集", "文件夹栏仍能切到全部卡集");

  flow.page.drawerAction({ currentTarget: { dataset: { key: "color" } } });
  assert.equal(flow.page.data.colorPanelOpen, true, "更换颜色 opens the colour panel");
});

test("the colour panel unifies the folder and asks before the rainbow", () => {
  const flow = createFlow();
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/card-box");
  const markup = fs.readFileSync(path.join(pageDir, "card-box.wxml"), "utf8");

  assert.match(markup, /class="drawer-layer" wx:if="\{\{colorPanelOpen\}\}"/);
  assert.match(markup, /<text>选择卡盒颜色<\/text>/);
  assert.match(markup, /data-mode="uniform" bindtap="selectColorMode"/);
  assert.match(markup, /data-mode="rainbow" bindtap="selectColorMode"/);
  assert.match(markup, /class="color-swatch \{\{selectedSetColor === item\.key \? 'color-swatch-active' : ''\}\}"/);
  assert.match(markup, /bindtap="applyRainbow"[\s\S]{0,40}>应用渐变色<\/view>/);
  assert.doesNotMatch(markup, /暖色系/, "the per-item 暖色系 palette stays in the toolbar");

  flow.page.setData({ activeFolder: "我的卡集" });
  flow.page.openColorPanel();
  assert.equal(flow.page.data.colorPanelOpen, true);
  assert.equal(flow.page.data.colorMode, "uniform");
  assert.equal(flow.page.data.colorScopeLabel, "「我的卡集」文件夹下的所有卡盒");
  assert.equal(flow.page.data.selectedSetColor, "", "sets without a colour start on 无颜色");

  flow.page.applyUniformColor({ currentTarget: { dataset: { key: "sky" } } });
  assert.equal(flow.page.data.selectedSetColor, "sky");
  assert.equal(flow.storage.get(SETS_KEY).find((set) => set.id === "set-1").color, "sky");
  assert.equal(
    flow.storage.get(SETS_KEY).find((set) => set.id === "set-2").color,
    "",
    "sets in another folder are out of scope",
  );

  flow.page.selectColorMode({ currentTarget: { dataset: { mode: "rainbow" } } });
  assert.equal(flow.page.data.colorMode, "rainbow");
  let asked = null;
  flow.page.setData({ colorPanelOpen: true });
  global.wx.showModal = (options) => { asked = options; options.success({ confirm: false }); };
  flow.page.applyRainbow();
  assert.equal(asked.title, "设置彩虹色");
  assert.equal(asked.content, "是否将当前文件夹下的所有卡盒按顺序应用渐变色？");
  assert.equal(flow.storage.get(SETS_KEY).find((set) => set.id === "set-1").color, "sky", "cancelling changes nothing");

  global.wx.showModal = (options) => options.success({ confirm: true });
  flow.page.applyRainbow();
  assert.equal(flow.page.data.colorPanelOpen, false, "applying closes the panel");
  assert.equal(flow.storage.get(SETS_KEY).find((set) => set.id === "set-1").color, "rose", "the gradient starts at the first palette colour");
  assert.equal(flow.storage.get(SETS_KEY).find((set) => set.id === "set-2").color, "", "out-of-scope sets stay untouched");
});

test("the selection toolbar paints the selected card sets", () => {
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/card-box");
  const markup = fs.readFileSync(path.join(pageDir, "card-box.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "card-box.wxss"), "utf8");

  assert.match(
    markup,
    /data-action="color" bindtap="selectionAction"[\s\S]{0,120}pack-palette\.svg[\s\S]{0,40}<label>颜色<\/label>/,
    "the toolbar carries a 颜色 entry with the white icon",
  );
  assert.match(markup, /class="color-picker color-picker-\{\{selectionAlign\}\}"/);
  assert.match(markup, /wx:for="\{\{cardColors\}\}"[\s\S]{0,220}bindtap="selectSetColor"/);
  assert.match(styles, /\.selection-toolbar\{width:556rpx\}/, "the toolbar widens for the sixth entry");
  assert.match(styles, /\.color-dot\{width:64rpx;height:64rpx/);
  assert.match(styles, /\.color-dot-active\{border-color:#fff\}/);

  const flow = createFlow();
  flow.page.setData({ activeFolder: "我的卡集" });
  flow.page.applySelection(["set-1", "set-2"]);
  assert.equal(flow.page.data.selecting, true);

  flow.page.selectionAction({ currentTarget: { dataset: { action: "color" } } });
  assert.equal(flow.page.data.setColorPickerOpen, true);
  assert.equal(flow.page.data.setColorPickerTop, 258);
  assert.equal(flow.page.data.selectedSetColor, "", "sets without a colour start on 无颜色");

  flow.page.selectSetColor({ currentTarget: { dataset: { key: "lilac" } } });
  const stored = flow.storage.get(SETS_KEY);
  assert.equal(stored.find((set) => set.id === "set-1").color, "lilac");
  assert.equal(stored.find((set) => set.id === "set-2").color, "lilac", "every selected set is painted");
  assert.equal(flow.page.data.selectedSetColor, "lilac");
  assert.deepEqual(flow.page.data.selectedIds, ["set-1", "set-2"], "painting keeps the selection");

  flow.page.cancelSelect();
  assert.equal(flow.page.data.setColorPickerOpen, false, "leaving selection closes the palette");
});

test("sharing the card set list reports the active folder", () => {
  const flow = createFlow();
  flow.page.setData({ activeFolder: "全部卡集" });
  assert.deepEqual(flow.page.onShareAppMessage(), { title: "我的知识卡集", path: "/pages/card-box/card-box" });

  flow.page.setData({ activeFolder: "期末复习" });
  assert.deepEqual(flow.page.onShareAppMessage(), { title: "我的卡集 · 期末复习", path: "/pages/card-box/card-box" });
});

test("card box counts legacy directory placeholders as directories rather than cards", () => {
  const flow = createFlow();
  flow.storage.set(SETS_KEY, [{
    id: "legacy-set",
    title: "旧卡集",
    author: "甲",
    folder: "我的卡集",
    cards: [
      { id: "real-card", section: "第一章", question: "真实问题", answer: "真实答案", state: "learning" },
      {
        id: "directory-placeholder",
        section: "空目录",
        question: "新目录",
        answer: "在这里添加第一张卡片",
        isDirectoryPlaceholder: true,
        state: "new",
      },
    ],
  }]);

  flow.page.onShow();

  assert.equal(flow.page.data.sets[0].count, 1);
  assert.equal(flow.page.data.sets[0].learned, 1);
  assert.deepEqual(flow.page.data.sets[0].sectionOrder, ["第一章", "空目录"]);
  assert.deepEqual(flow.page.data.sets[0].cards.map((card) => card.id), ["real-card"]);
});

function mockSelectorQuery({ sets = [], scrollTop = 0 } = {}) {
  global.wx.createSelectorQuery = () => {
    const requests = [];
    return {
      select: (selector) => {
        requests.push({ type: "select", selector });
        return { boundingClientRect: () => {} };
      },
      selectAll: (selector) => {
        requests.push({ type: "selectAll", selector });
        return { boundingClientRect: () => {} };
      },
      selectViewport: () => {
        requests.push({ type: "viewport" });
        return { scrollOffset: () => {} };
      },
      exec: (callback) => {
        const results = requests.map((request) => {
          if (request.type === "selectAll") return sets;
          if (request.type === "select") return { top: 0, bottom: 0, left: 0, right: 0 };
          return { scrollTop };
        });
        requests.length = 0;
        callback(results);
      },
    };
  };
}

function touchEvent(x, y) {
  return { touches: [{ clientX: x, clientY: y }] };
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

const dragSetRects = [
  { dataset: { id: "set-1" }, left: 14, top: 200, right: 184, bottom: 480 },
  { dataset: { id: "set-2" }, left: 190, top: 200, right: 361, bottom: 480 },
  { dataset: { id: "set-3" }, left: 14, top: 496, right: 184, bottom: 776 },
];

test("card sets can be reordered by long pressing and dragging them", async () => {
  const flow = createFlow(new Map([
    [FOLDERS_KEY, ["我的卡集"]],
    [SETS_KEY, [
      { id: "set-1", title: "甲", author: "甲", folder: "我的卡集", cards: [] },
      { id: "set-2", title: "乙", author: "乙", folder: "我的卡集", cards: [] },
      { id: "set-3", title: "丙", author: "丙", folder: "我的卡集", cards: [] },
    ]],
  ]));
  mockSelectorQuery({ sets: dragSetRects });
  flow.page.setData({ viewportHeight: 800, navBottom: 96, contentLeft: 14, contentWidth: 347 });
  global.wx.pageScrollTo = () => {};

  flow.page.handleSetTouchStart({
    currentTarget: { dataset: { id: "set-3" } },
    touches: [{ clientX: 60, clientY: 600 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "set-3" } } });
  assert.equal(flow.page.data.pageScrollLocked, true, "the long press locks the page scroll");
  assert.deepEqual(flow.page.data.selectedIds, ["set-3"]);

  flow.page.handleSetTouchMove(touchEvent(60, 630));
  assert.equal(flow.page.data.dragActive, true);

  flow.page.handleSetTouchMove(touchEvent(150, 250));
  await wait(30);
  assert.deepEqual(
    flow.page.data.dragIndicator,
    { kind: "column", left: 185, top: 200, width: 4, height: 280 },
    "dropping between the first two sets shows the column indicator",
  );

  flow.page.handleDragTouchEnd();

  assert.equal(flow.page.data.dragActive, false);
  assert.equal(flow.page.data.pageScrollLocked, false);
  assert.equal(flow.page.data.selecting, false, "finishing a drag closes the selection toolbar");
  assert.deepEqual(flow.storage.get(SETS_KEY).map((set) => set.id), ["set-1", "set-3", "set-2"]);
  assert.equal(flow.toast(), "已移动卡集");
});

test("a long press without movement still only selects the card set", async () => {
  const flow = createFlow();
  mockSelectorQuery({ sets: dragSetRects });

  flow.page.handleSetTouchStart({
    currentTarget: { dataset: { id: "set-1" } },
    touches: [{ clientX: 60, clientY: 300 }],
  });
  flow.page.startSelect({ currentTarget: { dataset: { id: "set-1" } } });
  flow.page.handleSetTouchMove(touchEvent(62, 304));
  await wait(30);

  assert.equal(flow.page.data.dragActive, false);

  flow.page.handleDragTouchEnd();
  assert.equal(flow.page.data.pageScrollLocked, false);
  assert.deepEqual(flow.page.data.selectedIds, ["set-1"]);
  assert.deepEqual(flow.storage.get(SETS_KEY).map((set) => set.id), ["set-1", "set-2"]);
});

test("tapping blank space cancels the card set selection", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-box/card-box.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/card-box/card-box.wxss"), "utf8");
  const flow = createFlow();

  assert.match(markup, /^<page-meta page-style="\{\{pageScrollLocked \? 'overflow: hidden;' : ''\}\}" \/>/);
  assert.match(markup, /class="page" bindtap="handleBlankTap"/);
  assert.match(markup, /catchtap="openOrToggle"/);
  assert.match(markup, /class="selection-toolbar selection-\{\{selectionAlign\}\} \{\{dragActive \? 'selection-toolbar-hidden' : ''\}\}" wx:if="\{\{selecting\}\}" catchtap="noop"/);
  assert.match(styles, /\.selection-toolbar-hidden\{visibility:hidden\}/);
  assert.match(markup, /class="drag-indicator drag-indicator-\{\{dragIndicator\.kind\}\}"/);
  assert.match(markup, /class="drag-ghost"/);
  assert.match(markup, /<template is="setCardBody" data="\{\{item: item\}\}"\/>/);
  assert.match(styles, /\.drag-indicator\{position:fixed;z-index:1;background:#2f9fff/);
  assert.match(styles, /\.set\{z-index:2\}/, "card sets paint above the drop indicator");
  assert.match(styles, /\.drag-ghost\{position:fixed;z-index:60;/);
  assert.match(styles, /\.set-drag-origin\{[^}]*opacity:\.4\}/);

  flow.page.startSelect({ currentTarget: { dataset: { id: "set-1" } } });
  assert.equal(flow.page.data.selecting, true);
  flow.page.handleBlankTap();
  assert.equal(flow.page.data.selecting, false, "tapping blank space cancels the selection");
  assert.deepEqual(flow.page.data.selectedIds, []);

  flow.page.toggleDirectory();
  assert.equal(flow.page.data.directoryOpen, true);
  flow.page.handleBlankTap();
  assert.equal(flow.page.data.directoryOpen, false, "blank space closes an open folder list first");
});

test.afterEach(() => {
  delete global.Page;
  delete global.wx;
});
