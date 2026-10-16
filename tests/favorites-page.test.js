const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildCommunityFavoriteItems,
  buildFavoriteQuestionItems,
  isBookmarked,
} = require("../apps/miniprogram/utils/favorites-view");

const root = path.join(__dirname, "../apps/miniprogram");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

test("自绘导航栏：让开状态栏与右上角胶囊，目录图标跟在返回键之后（左上角）", () => {
  const json = read("pages", "favorites", "favorites.json");
  const script = read("pages", "favorites", "favorites.js");
  const style = read("pages", "favorites", "favorites.wxss");
  const markup = read("pages", "favorites", "favorites.wxml");
  assert.match(json, /"navigationStyle":\s*"custom"/);
  // 胶囊安全区与状态栏高度必须真量（写死会让右上角胶囊压住标题）
  assert.match(script, /getMenuButtonBoundingClientRect/);
  assert.match(script, /capsuleSafeRight: hasCapsule/);
  assert.match(script, /navTotalHeight: statusBarHeight \+ navContentHeight/);
  assert.match(markup, /style="height: \{\{navTotalHeight\}\}px; padding-top: \{\{statusBarHeight\}\}px; padding-right: \{\{capsuleSafeRight\}\}px;"/);
  // 固定导航栏：在内容之上、但在抽屉(20/21)与长按面板(10/11)的遮罩之下
  assert.match(style, /\.fav-nav \{[\s\S]{0,120}position: fixed;[\s\S]{0,80}z-index: 5;/);
  assert.match(script, /closeTransientLayers\(this, \["directoryOpen", "sheet", "pickerOpen", "filterOpen"\]\)/);
  // 固定导航栏下面的内容要留出等高占位块，否则第一行会被压住
  assert.match(markup, /<view style="height: \{\{navTotalHeight\}\}px;"><\/view>/);
  // 抽屉从屏幕顶端起，标题要让开状态栏
  assert.match(markup, /class="directory-drawer" style="padding-top: \{\{drawerPaddingTop\}\}px;"/);
  assert.match(script, /drawerPaddingTop: statusBarHeight \+ 11/);
  // 返回键有兜底：没有上一页时回「我的」，不能点了没反应
  assert.match(script, /goBack\(\) \{[\s\S]{0,200}getCurrentPages\(\)\.length > 1/);
});

test("导航栏那颗图标必须是深色标的（浅色栏上不能用白色图标——真机上就是「看不见」）", () => {
  const markup = read("pages", "favorites", "favorites.wxml");
  // 产品负责人 2026-09-23 04:1x 真机截图：导航栏那颗用 pack-folder.svg（stroke=#ffffff）在浅色栏上几乎不可见，
  // 指定改用图 2 那个「列表」标 → list.svg。
  const button = markup.match(/class="fav-nav-button" bindtap="openDirectory"[\s\S]{0,200}?src="([^"]+)"/);
  assert.ok(button, "导航栏目录按钮必须有一个图标 src");
  const src = button[1];
  const svg = read("assets", "icons", src.split("/").pop());
  // 不写死某个文件名，而是**读这个图标自己**：只要它整体是近白色，在浅色导航栏上就是"看不见"
  const paints = [...svg.matchAll(/(?:stroke|fill)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
  const visible = paints.filter((c) => c !== "none" && Number.parseInt(c.slice(1), 16) < 0xa0a0a0);
  assert.ok(visible.length > 0, `${src} 的描边/填充全是浅色（${paints.join(", ")}），画在浅色导航栏上等于看不见`);
  assert.match(src, /list\.svg$/, "按 04:1x 的指定用「列表」标");
});

test("「我的收藏」是独立页面，并从复习工具的收藏入口进入", () => {
  const config = JSON.parse(read("app.json"));
  assert.ok(config.pages.includes("pages/favorites/favorites"), "需要在 app.json 注册收藏页");
  ["js", "json", "wxml", "wxss"].forEach((extension) => {
    assert.ok(fs.existsSync(path.join(root, "pages", "favorites", `favorites.${extension}`)), `缺少 favorites.${extension}`);
  });

  const review = read("pages", "review", "review.js");
  assert.match(review, /key === "favorite"[\s\S]{0,200}navigateTo\(\{ url: "\/pages\/favorites\/favorites" \}\)/);
  assert.doesNotMatch(review, /key === "favorite"[\s\S]{0,80}activeFilter: key/, "收藏不应再走页内筛选切换");
  const profile = read("pages", "profile", "profile.js");
  assert.match(profile, /menu: \["我的账户", "我的收藏", "我的资产", "社区与贡献", "帮助与反馈"\]/);
  assert.match(profile, /name === "我的收藏"[^\n]+\/pages\/favorites\/favorites/);
  assert.match(profile, /name === "我的资产"[^\n]+\/pages\/assets\/assets/);
  const pageConfig = JSON.parse(read("pages", "favorites", "favorites.json"));
  assert.equal(pageConfig.navigationBarTitleText, "我的收藏");
});

test("「我的」页账户与服务列表可进入收藏和资产", () => {
  const markup = read("pages", "profile", "profile.wxml");
  assert.match(markup, /class="menu-row" wx:for="\{\{menu\}\}" wx:key="\*this" data-name="\{\{item\}\}" bindtap="openMenu"/);
  let definition;
  global.Page = (value) => { definition = value; };
  const modulePath = require.resolve("../apps/miniprogram/pages/profile/profile.js");
  delete require.cache[modulePath];
  try {
    require(modulePath);
    assert.deepEqual(definition.data.menu, ["我的账户", "我的收藏", "我的资产", "社区与贡献", "帮助与反馈"]);
    const destinations = [];
    global.wx = { navigateTo: ({ url }) => destinations.push(url) };
    for (const name of ["我的收藏", "我的资产"]) {
      definition.openMenu({ currentTarget: { dataset: { name } } });
    }
    assert.deepEqual(destinations, ["/pages/favorites/favorites", "/pages/assets/assets"]);
  } finally {
    delete global.Page;
    delete global.wx;
  }
});

test("收藏页只读引用：登录才拉取、401 明确提示、取消收藏走 unfavorite", () => {
  const script = read("pages", "favorites", "favorites.js");
  assert.match(script, /\/api\/community\/assets\/favorites/);
  assert.match(script, /authHeader\(\)/);
  assert.match(script, /statusCode === 401/);
  assert.match(script, /登录后才能查看收藏的公开内容/);
  assert.match(script, /\/api\/community\/assets\/\$\{encodeURIComponent\(id\)\}\/unfavorite/);
  assert.match(script, /loggedIn = Boolean\(application\.globalData\.authToken\)/, "未登录不应请求服务端");
});

test("题目收藏沿用复习页同一套本地书签存储，不会因为换页而丢", () => {
  const script = read("pages", "favorites", "favorites.js");
  assert.match(script, /shukao_bookmarks/);
  assert.match(script, /shukao_bookmark_\$\{id\}/);
  const review = read("pages", "review", "review.js");
  assert.match(review, /shukao_bookmarks/);
  assert.match(review, /shukao_bookmark_\$\{question\.id\}/);
  assert.match(script, /officialQuestions/, "题目收藏要从同一份题目数据里解析标题");
});

test("收藏页新结构：导航栏左上角目录图标 + 抽屉 + 子文件夹标签 + 合并列表 + 长按面板（DEC-096）", () => {
  const markup = read("pages", "favorites", "favorites.wxml");
  // 目录入口＝自绘导航栏左上角的图标（← 返回 之后那颗），不再是整行卡片（产品负责人 2026-09-23 04:0x 改判）。
  assert.match(markup, /class="fav-nav"[\s\S]{0,700}bindtap="openDirectory"/);
  assert.match(markup, /class="fav-nav-button" bindtap="goBack"/);
  assert.match(markup, /pack-folder\.svg/);
  assert.doesNotMatch(markup, /class="directory-entry"/, "整行目录卡片已按 04:0x 改判移除");
  assert.match(markup, /收藏目录/);
  assert.match(markup, /bindtap="closeDirectory"/);
  assert.match(markup, /bindtap="openManage"/);
  assert.match(markup, /管理与新建文件夹/);
  // 点左边文件夹＝展开该文件夹的收藏；上方子文件夹标签可筛。
  assert.match(markup, /bindtap="selectFolder"/);
  assert.match(markup, /bindtap="selectChip"/);
  assert.match(markup, /class="chip \{\{item\.active \? 'chip-active' : ''\}\}"/);
  // 点收藏跳转、长按出操作面板（置顶 / 删除 / 取消）。
  assert.match(markup, /bindtap="openItem"/);
  assert.match(markup, /bindlongpress="openSheet"/);
  assert.match(markup, /bindtap="togglePin"/);
  assert.match(markup, /bindtap="deleteFavorite"/);
  assert.match(markup, /置顶收藏|取消置顶/);
  assert.match(markup, /删除收藏/);
  assert.match(markup, />取消</);
  // 显隐走 wx:if（AGENTS §6：不使用 hidden + 作者 display 的组合）。
  // 注释里会出现「hidden」这个词，先在注释剥掉之后再查真正的属性用法。
  const markupWithoutComments = markup.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(markupWithoutComments, /\shidden[=\s>]/);
  assert.match(markup, /wx:if="\{\{directoryOpen\}\}"/);
  assert.match(markup, /wx:if="\{\{sheet\}\}"/);
  // 空态与未登录提示都在。
  assert.match(markup, /\{\{view\.emptyLabel\}\}/);
  assert.match(markup, /bindtap="goLogin"/);
});

test("收藏页脚本：拉组织数据、按文件夹筛选、置顶与删除走服务端接口", () => {
  const script = read("pages", "favorites", "favorites.js");
  assert.match(script, /\/api\/favorites\/folders/, "组织数据（文件夹/归属/置顶）来自服务端");
  assert.match(script, /\/api\/favorites\/membership/, "「移到文件夹」要写回服务端");
  assert.match(script, /\/api\/favorites\/pins/, "置顶要写回服务端");
  assert.match(script, /buildFavoriteOrganization/);
  assert.match(script, /pages\/favorite-manage\/favorite-manage/, "抽屉底部的分类管理是独立页面");
  assert.match(script, /sortMode/);
});

test("收藏页的浮层随页面离开收拢（带遮罩的抽屉/面板不能跨页残留成隐形拦截层）", () => {
  const script = read("pages", "favorites", "favorites.js");
  assert.match(script, /closeTransientLayers\(this, \["directoryOpen", "sheet", "pickerOpen", "filterOpen"\]\)/);
  assert.match(script, /\n  onHide\(\) \{/);
  assert.match(script, /require\("\.\.\/\.\.\/utils\/page-layers"\)/);
});

test("加载失败不许说成「没有收藏」，两个失败各自成条、404 要说清是服务未就绪", () => {
  const script = read("pages", "favorites", "favorites.js");
  const markup = read("pages", "favorites", "favorites.wxml");
  // 两件事两个字段：收藏列表加载失败 ≠ 收藏目录（文件夹）加载失败，塞一个字段会互相覆盖。
  assert.match(script, /communityError: ""/);
  assert.match(script, /organizationError: ""/);
  assert.match(script, /organizationErrorText\(statusCode\)/);
  assert.match(script, /statusCode === 404\) return "收藏目录服务未就绪（后台服务需重启后生效）"/);
  // 两条提示各自重试
  assert.match(markup, /wx:if="\{\{loggedIn && communityError\}\}"/);
  assert.match(markup, /wx:if="\{\{loggedIn && organizationError\}\}"/);
  assert.match(markup, /bindtap="retryOrganization"/);
  // "空"只在真的加载成功时才等于"没有收藏"；失败时不引导去逛知识库
  assert.match(script, /view\.listLoaded = !listFailed/);
  assert.match(script, /if \(listFailed && !view\.items\.length\) view\.emptyLabel = "收藏没加载出来"/);
  // "空"只在真的加载成功时才等于"没有收藏"；失败时不引导去逛知识库。
  // 另外两种空要分开：搜索/筛选筛出来没有 → 给「清空筛选条件」；本来就没有收藏 → 才引导去逛知识库。
  assert.match(markup, /wx:if="\{\{view\.listLoaded && view\.hasFilter\}\}" class="empty-action" bindtap="clearFilters"/);
  assert.match(markup, /wx:elif="\{\{view\.listLoaded\}\}" class="empty-action" bindtap="browseCommunity"/);
  // 目录失败时不说"还没有文件夹"
  assert.match(script, /view\.directoryLoaded = !organizationFailed/);
  assert.match(script, /view\.directorySubtitle = "目录暂不可用"/);
  assert.match(markup, /view\.directoryLoaded \? '还没有文件夹/);
});

test("搜索 + 筛选 + 排序排成一行（搜索框在「全部收藏」上面，右边依次是筛选、排序），排序按钮不带圆框、用箭头标", () => {
  // 产品负责人 2026-09-23 04:4x：「可在图2全部收藏上面加个搜索框，搜索框右边是筛选，筛选右边是排序」
  //                      「排序图标用图5，但我感觉可以不要那个圆框」「筛选图标用图4」
  //                     04:6x：「排序用图1这种，图2图3这两处」（图 1＝两根竖杆 + 斜头的箭头标）
  const markup = read("pages", "favorites", "favorites.wxml");
  const style = read("pages", "favorites", "favorites.wxss");
  const row = markup.match(/<view class="search-row">([\s\S]*?)<\/view>\s*\n\s*<!-- 当前文件夹 -->/);
  assert.ok(row, "search-row 必须排在「当前文件夹」之前（＝在「全部收藏」上面）");
  const order = [...row[1].matchAll(/class="((?:search-box|search-tool)[^"{]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(order, ["search-box", "search-tool", "search-tool"], `搜索 → 筛选 → 排序 的顺序不对：${order.join(" / ")}`);
  assert.match(row[1], /<input[\s\S]{0,220}placeholder="搜索收藏"[\s\S]{0,220}bindinput="onKeyword"/, "搜索框要真的能输入");
  assert.match(row[1], /bindtap="openFilter"[\s\S]{0,120}filter\.svg/);
  // 04:6x：「排序用图1这种」——两根竖杆 + 左右斜头的箭头标（不是原来画三条竖杆的滑块标）
  assert.match(row[1], /bindtap="toggleSort"[\s\S]{0,120}sort\.svg/);
  assert.doesNotMatch(row[1], /sliders\.svg/, "排序入口不该再用「滑块」标（04:6x 换成箭头标了）");
  // 「不要那个圆框」：排序那颗不能有底色/投影（原来 .sort-button 是白色圆形 + 投影）
  const tool = style.match(/\.search-tool\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(tool, /background/, "排序/筛选那颗不要底框");
  assert.doesNotMatch(tool, /box-shadow/);
  assert.doesNotMatch(style, /\.sort-button\s*\{/, "旧的白色圆按钮规则应已撤掉");
  // 收藏图标用图 1（书签）：页面文件夹头 + 抽屉「全部收藏」行两处
  assert.match(markup, /class="folder-head-icon"><image src="\/assets\/icons\/bookmark\.svg"/);
  assert.match(markup, /class="drawer-row-icon"><image src="\/assets\/icons\/bookmark\.svg"[\s\S]{0,200}全部收藏/);
});

test("筛选面板列出「当前范围里真实存在的类型」，选项由数据长出来、不写死词表", () => {
  const script = read("pages", "favorites", "favorites.js");
  const markup = read("pages", "favorites", "favorites.wxml");
  assert.match(markup, /wx:if="\{\{filterOpen\}\}" class="sheet-mask"/);
  assert.match(markup, /wx:for="\{\{view\.typeOptions\}\}"[\s\S]{0,260}bindtap="selectFilterType"/);
  assert.match(script, /onKeyword\(event\)/);
  assert.match(script, /clearFilters\(\)/);
  const model = read("utils", "favorites-organization.js");
  assert.match(model, /typeCounts/, "类型选项要从数据里统计出来");
  // 选项＝当前范围里统计出来的，不是写死的类型词表；类型标签只由 favorites-view.js 一处维护（AGENTS §5 一处维护）
  assert.match(model, /typeCounts\.set\(label, \(typeCounts\.get\(label\) \|\| 0\) \+ 1\)/);
  assert.match(model, /\[\.\.\.typeCounts\.entries\(\)\]/);
  assert.doesNotMatch(model, /(knowledge|note|card_pack):\s*"/, "标签词表不要在视图模型里复制一份");
  // 筛出 0 条要能一眼看出是"筛"而不是"没有收藏"
  assert.match(model, /筛出 \$\{visible\.length\} 条/);
  assert.match(model, /没有匹配/);
});

test("「全部收藏」标题：字号回原来的 34rpx，字重＝个人页昵称同一号（跨文件契约）——产品负责人 04:5x/04:7x/04:8x 三次真机反馈", () => {
  const style = read("pages", "favorites", "favorites.wxss");
  const block = style.match(/\.folder-head-title\s*\{([^}]*)\}/)[1];
  // 04:8x：「大小用回原来的17px」——04:7x 我误解成"字号跟昵称一样"放大到了 38rpx，已改回
  assert.match(block, /font-size:\s*34rpx/, "字号要回到原来的 34rpx（＝17px）");
  const weight = Number((block.match(/font-weight:\s*(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(weight), "标题必须有明确的字重");
  assert.ok(weight <= 600, `「全部收藏」不许回到加粗，当前字重 ${weight}（04:5x 起 700 已撤）`);
  // 04:8x：「用和昵称一样的细字体」——不写死 500，而是拿个人页 `.nickname` 的**当前值**比，
  // 这样两处要么一起改、要么这条挂掉，不会悄悄漂开（一处维护，另一处只引用）。
  const profileStyle = read("pages", "profile", "profile.wxss");
  const nicknameBlock = profileStyle.match(/\.nickname\s*\{([^}]*)\}/)[1];
  const nicknameWeight = (nicknameBlock.match(/font-weight:\s*(\d+)/) || [])[1];
  assert.ok(nicknameWeight, "个人页昵称必须有明确的字重（这条契约的基准）");
  assert.equal(String(weight), nicknameWeight, `「全部收藏」要与昵称同一号细字体：昵称 ${nicknameWeight}，标题 ${weight}`);
  // 副标题本来就是细的（灰字 + 常规字重），不要在"把标题改细"时顺手加粗它
  const sub = style.match(/\.folder-head-sub\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(sub, /font-weight:\s*(5|6|7|8|9)00/);
});

test("自绘导航栏中间不再画标题（产品负责人 04:7x「去掉绿框中的文字」），页面注册名仍保留", () => {
  const markup = read("pages", "favorites", "favorites.wxml");
  const style = read("pages", "favorites", "favorites.wxss");
  assert.doesNotMatch(markup, /fav-nav-title/, "导航栏中间那颗标题节点要真的移除（不是只藏起来）");
  assert.doesNotMatch(markup, /<view class="fav-nav"[\s\S]{0,600}?我的收藏/, "导航栏里不该再出现「我的收藏」这行字");
  assert.doesNotMatch(style, /\.fav-nav-title\s*\{/, "配套的样式规则也是死代码，一并撤掉");
  // 左上角两颗图标不受影响（返回 + 目录），且导航栏高度仍由页面自己撑开
  assert.match(markup, /fav-nav-button"[^>]*bindtap="goBack"/);
  assert.match(markup, /fav-nav-button"[^>]*bindtap="openDirectory"/);
  const pageConfig = JSON.parse(read("app.json")).pages.includes("pages/favorites/favorites");
  assert.ok(pageConfig, "页面注册名留在 app.json（navigationBarTitleText 是注册信息，自绘导航栏下不渲染）");
});

test("社区收藏项按类型/作者/收藏数归一，未发布内容标为已下架", () => {
  const items = buildCommunityFavoriteItems([
    { id: "community-1", type: "note", title: "笔记", excerpt: "摘要", contributor: "小林", favoriteCount: "3", moderationStatus: "published" },
    { id: "community-2", type: "card_pack", title: "卡片集", moderationStatus: "offline" },
    { id: "community-3", type: "question", title: "题目分享", moderationStatus: "published" },
  ]);
  assert.equal(items.length, 3);
  assert.equal(items[0].typeLabel, "共享笔记");
  assert.equal(items[0].favoriteCount, 3);
  assert.equal(items[0].available, true);
  assert.equal(items[0].statusLabel, "");
  assert.equal(items[1].typeLabel, "卡片集");
  assert.equal(items[1].available, false);
  assert.equal(items[1].statusLabel, "已下架");
  assert.equal(items[2].typeLabel, "题目分享");
  assert.deepEqual(buildCommunityFavoriteItems(null), []);
});

test("题目收藏项兼容新旧两种书签存储并过滤未收藏题目", () => {
  const officialQuestions = [
    { id: "q1", stem: "第一题", breadcrumb: "现代汉语 · 语音" },
    { id: "q2", stem: "第二题", knowledgePoint: "声母" },
    { id: "q3", stem: "第三题" },
  ];
  assert.equal(isBookmarked({ q1: { value: true } }, "q1"), true);
  assert.equal(isBookmarked({ q1: { value: false } }, "q1"), false);
  const items = buildFavoriteQuestionItems({
    officialQuestions,
    bookmarkStates: { q1: { value: true }, q3: { value: false } },
    legacyLookup: (id) => id === "q2",
  });
  assert.deepEqual(items.map((item) => item.id), ["q1", "q2"]);
  assert.equal(items[0].breadcrumb, "现代汉语 · 语音");
  assert.equal(items[1].breadcrumb, "声母");
  assert.deepEqual(buildFavoriteQuestionItems({ officialQuestions: [] }), []);
});
