const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pageDir = path.join(__dirname, "..", "apps", "miniprogram", "pages", "assets");
const read = (name) => fs.readFileSync(path.join(pageDir, name), "utf8");

function loadPage() {
  let definition;
  global.Page = (value) => { definition = value; };
  const resolved = require.resolve("../apps/miniprogram/pages/assets/assets.js");
  delete require.cache[resolved];
  require(resolved);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

function createStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getStorageSync: (key) => (map.has(key) ? map.get(key) : ""),
    setStorageSync: (key, value) => map.set(key, value),
    removeStorageSync: (key) => map.delete(key),
  };
}

test("asset page removes redundant floating creation controls and their state", () => {
  const markup = read("assets.wxml");
  const logic = read("assets.js");
  const styles = read("assets.wxss");

  assert.doesNotMatch(markup, /\bfab\b|toggleActionMenu|createQuestion|createNote/);
  assert.doesNotMatch(logic, /actionMenuOpen|toggleActionMenu|createQuestion|createNote/);
  assert.doesNotMatch(styles, /\.fab(?:-|\b)/);
  assert.doesNotMatch(markup, /点击右下角|新建资产/);
  assert.match(markup, /class="asset-list" wx:if="\{\{visibleAssets.length\}\}"/);
  assert.match(markup, /class="asset-empty" wx:else/);
  assert.match(markup, /还没有这类资产/);
  assert.match(markup, /可前往题包或笔记页面创建/);
});

test("asset cards replace the old single-panel list rows", () => {
  const markup = read("assets.wxml");
  const styles = read("assets.wxss");

  // 2026-10-03 卡片化改版：每项资产一张白卡，旧的"一整块白底列表 + 圆形图标行"必须彻底消失。
  assert.match(markup, /class="asset-card" wx:for="\{\{visibleAssets\}\}"/);
  for (const dead of ["asset-row", "asset-icon", "row-more", "asset-path"]) {
    assert.doesNotMatch(markup, new RegExp(dead), `${dead} 不应再出现在页面结构里`);
    assert.doesNotMatch(styles, new RegExp(`\\.${dead}(?![\\w-])`), `${dead} 的旧样式应清掉`);
  }
  assert.doesNotMatch(styles, /\.asset-list \{[^}]*background: #fff/, "列表不再是一整块白底卡片");

  // 卡片三段：标题 + 右上状态胶囊 / 描述行 / 元信息行（含「更新于」）
  assert.match(markup, /class="asset-card-head"><view class="asset-title">\{\{item\.title\}\}<\/view><text class="status status-\{\{item\.moderationStatus\}\}">\{\{item\.statusLabel\}\}<\/text><\/view>/);
  assert.match(markup, /class="asset-desc" wx:if="\{\{item\.summary\}\}">\{\{item\.summary\}\}<\/view>/);
  assert.match(markup, /class="asset-meta"><text wx:if="\{\{item\.metaPrimary\}\}">\{\{item\.metaPrimary\}\}<\/text><text>更新于 \{\{item\.timeLabel\}\}<\/text><\/view>/);

  // 抬头文案按效果图；状态胶囊改成药丸，并给草稿补一个色（旧样式里没有 draft 这一档）
  assert.match(markup, /统一管理创建、收藏和公开内容/);
  assert.match(markup, /<text>\{\{stats\.total\}\}<\/text>项资产/);
  assert.match(styles, /\.status \{[^}]*border-radius: 999rpx/);
  assert.match(styles, /\.status-draft \{/);

  // 2026-10-03 真机反馈两处：「卡片都方了」+「选择提示改为绿色」——
  // 整页白卡（状态条 / 资产卡 / 空态）圆角统一 32rpx，筛选选中态由深灰 #343834 改品牌青绿 #0b9588。
  assert.match(styles, /\.asset-card \{[^}]*border-radius: 32rpx/);
  assert.match(styles, /\.status-strip \{[^}]*border-radius: 32rpx/);
  assert.match(styles, /\.asset-empty \{[^}]*border-radius: 32rpx/);
  assert.match(styles, /\.filter-active \{[^}]*background: #0b9588/);
  assert.match(styles, /\.filter-active \{[^}]*color: #fff/);
  assert.doesNotMatch(styles, /#343834/, "旧的深灰选中态必须彻底清掉");
  assert.doesNotMatch(styles, /border-radius: 8rpx; grid-template-columns: repeat\(5,1fr\)/, "状态条不再用 8rpx 方角");
  assert.doesNotMatch(markup, /catalogPath \|\| '暂未归入目录'\}<\/view><view class="asset-meta"/, "目录路径不再上卡片");
});

test("card body and the ⋯ affordance are two different targets", () => {
  const markup = read("assets.wxml");
  const styles = read("assets.wxss");

  // 整卡可点 → 进资产本身；「⋯」用 catchtap 阻断冒泡 → 只开管理面板。
  assert.match(markup, /class="asset-card" wx:for="\{\{visibleAssets\}\}"[^>]*data-id="\{\{item\.id\}\}" bindtap="openAsset" role="button" aria-label="\{\{item\.title\}\}"/);
  assert.match(markup, /class="asset-more" data-id="\{\{item\.id\}\}" catchtap="openAssetMenu" role="button" aria-label="更多操作"/);
  assert.match(markup, /class="asset-more-dot"/);
  assert.match(styles, /\.asset-more \{[^}]*width: 88rpx[^}]*height: 56rpx/);
});

test("asset detail management bindings still resolve to callable handlers", (t) => {
  const previousPage = global.Page;
  const resolved = require.resolve("../apps/miniprogram/pages/assets/assets.js");
  let definition;
  t.after(() => {
    delete require.cache[resolved];
    if (previousPage === undefined) delete global.Page;
    else global.Page = previousPage;
  });
  global.Page = (value) => { definition = value; };
  delete require.cache[resolved];
  require(resolved);

  const markup = read("assets.wxml");
  for (const [, handler] of markup.matchAll(/bind(?:tap|change)="([^"]+)"/g)) {
    assert.equal(typeof definition[handler], "function", handler);
  }
  for (const [, handler] of markup.matchAll(/catch(?:tap|change)="([^"]+)"/g)) {
    assert.equal(typeof definition[handler], "function", `${handler}（catch 也要能解析到）`);
  }
  for (const action of ["editSelectedQuestion", "editSelectedNote", "createPackForSelectedQuestion", "openSelectedPack", "toggleVisibility", "removeAsset"]) {
    assert.ok(markup.includes(`bindtap="${action}"`), action);
  }
  assert.match(markup, /bindchange="addSelectedQuestionToPack"/);
  assert.equal(typeof definition.onPersonalAssetsSynced, "function");
  // 归属从卡片上撤掉后，管理面板必须还看得到（2026-10-03 卡片化改版的口径）。
  assert.match(markup, /资产归属/);
});

test("tapping a card opens the asset itself, tapping ⋯ opens the management sheet", () => {
  const urls = [];
  const previousWx = global.wx;
  global.wx = { navigateTo: ({ url }) => urls.push(url) };
  try {
    const page = loadPage();
    page.data.assets = [
      { id: "pack-1", type: "question_pack" },
      { id: "pack-2", type: "question_pack", packId: "real-pack" },
      { id: "question-1", type: "question" },
      { id: "note-1", type: "note" },
      { id: "cards-1", type: "card_pack" },
    ];
    const tap = (id) => ({ currentTarget: { dataset: { id } } });

    page.openAsset(tap("pack-1"));
    assert.equal(urls.at(-1), "/pages/pack-collection/pack-collection?id=pack-1&source=private");
    assert.equal(page.data.selectedAsset, null, "整卡点击不该再弹管理面板");

    page.openAsset(tap("pack-2"));
    assert.equal(urls.at(-1), "/pages/pack-collection/pack-collection?id=real-pack&source=private", "题包要按 packId 进页");

    page.openAsset(tap("question-1"));
    assert.equal(urls.at(-1), "/pages/contribute/contribute?questionId=question-1");

    page.openAsset(tap("note-1"));
    assert.equal(urls.at(-1), "/pages/note-editor/note-editor?noteId=note-1");

    // 没有独立页面的类型（卡片集）回落到管理面板，而不是点了没反应。
    const before = urls.length;
    page.openAsset(tap("cards-1"));
    assert.equal(urls.length, before);
    assert.equal(page.data.selectedAsset.id, "cards-1");

    // 「⋯」只开面板、不跳转。
    page.setData({ selectedAsset: null });
    page.openAssetMenu(tap("note-1"));
    assert.equal(urls.length, before, "⋯ 不该触发跳转");
    assert.equal(page.data.selectedAsset.id, "note-1");
    page.closeAsset();
    assert.equal(page.data.selectedAsset, null);
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});

test("card meta line is computed per asset type and lands on the rendered list", (t) => {
  const previousWx = global.wx;
  const previousPage = global.Page;
  t.after(() => {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
    if (previousPage === undefined) delete global.Page;
    else global.Page = previousPage;
  });
  const store = createStore({
    shukao_user_assets: [
      { id: "question-1", type: "question", title: "三角函数的值域", stem: "求函数的值域", updatedAt: Date.UTC(2026, 9, 2) },
      { id: "note-1", type: "note", title: "错题复盘", excerpt: "把上周的错题按考点归档", updatedAt: Date.UTC(2026, 8, 28) },
    ],
    shukao_private_packs: [{
      id: "pack-1", name: "高考函数核心题型", description: "定义域、值域、单调性与最值",
      questionIds: ["question-1"], createdAt: Date.UTC(2026, 8, 1), updatedAt: Date.UTC(2026, 9, 2),
    }],
  });
  global.wx = store;

  const page = loadPage();
  page.refresh();

  const byId = Object.fromEntries(page.data.visibleAssets.map((asset) => [asset.id, asset]));
  assert.equal(byId["pack-1"].metaPrimary, "1 道题", "题包给题量");
  assert.equal(byId["question-1"].metaPrimary, "高考函数核心题型", "题目给所属题包");
  assert.equal(byId["note-1"].metaPrimary, "笔记");
  assert.equal(byId["pack-1"].timeLabel, "10月2日");
  assert.equal(byId["question-1"].timeLabel, "10月2日");

  // 题包没有说明时回落到「共 N 道题」，描述行不会空着（效果图里描述行始终在）。
  const emptyStore = createStore({ shukao_private_packs: [{ id: "pack-empty", name: "空包", questionIds: [], createdAt: 1, updatedAt: 1 }] });
  global.wx = emptyStore;
  const emptyPage = loadPage();
  emptyPage.refresh();
  assert.equal(emptyPage.data.visibleAssets[0].summary, "共 0 道题");
  assert.equal(emptyPage.data.visibleAssets[0].metaPrimary, "0 道题");

  // 没有归入任何题包的题目，副信息行给「未归入题包」而不是空白。
  assert.equal(page.primaryMeta({ type: "question" }, []), "未归入题包");
});
