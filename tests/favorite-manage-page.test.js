const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 「分类管理」页契约（DEC-096 ⑤，2026-09-23）。
 * 抽屉底部那颗「分类管理」不是装饰：它必须能新建/重命名/删除文件夹、能进子文件夹、能拖拽排序，
 * 而"文件夹里的收藏不会跟着被删掉"这句承诺要能在确认文案里读到（服务端口径见 tests/favorite-folders.test.js）。
 */

const root = path.join(__dirname, "../apps/miniprogram");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

test("分类管理页已注册，页面四件套齐全、JSON 可解析", () => {
  const config = JSON.parse(read("app.json"));
  assert.ok(config.pages.includes("pages/favorite-manage/favorite-manage"), "需要在 app.json 注册分类管理页");
  ["js", "json", "wxml", "wxss"].forEach((extension) => {
    assert.ok(fs.existsSync(path.join(root, "pages", "favorite-manage", `favorite-manage.${extension}`)), `缺少 favorite-manage.${extension}`);
  });
  const pageConfig = JSON.parse(read("pages", "favorite-manage", "favorite-manage.json"));
  assert.equal(pageConfig.navigationBarTitleText, "分类管理");
});

test("分类管理页对着服务端的四个动作：建、改、删、排序", () => {
  const script = read("pages", "favorite-manage", "favorite-manage.js");
  assert.match(script, /\/api\/favorites\/folders`/, "要用带查询的建/查地址");
  assert.match(script, /\/api\/favorites\/folders\/\$\{encodeURIComponent\(folder\.id\)\}/, "重命名/删除按 id 走");
  assert.match(script, /"PATCH"/);
  assert.match(script, /"DELETE"/);
  assert.match(script, /\/api\/favorites\/folders\/reorder/);
  // 拖拽：把手事件 + 松手才写服务端（一次给全该层级的顺序）。
  assert.match(script, /startDrag/);
  assert.match(script, /dragMove/);
  assert.match(script, /endDrag/);
  assert.match(script, /folders\/reorder", \{ parentId: [\s\S]{0,80}order \}/, "reorder 要带完整 order 列表");
  assert.match(script, /parentId: this\.data\.parentId \|\| null/);
});

test("分类管理页把服务端的拒绝翻译成人话（重名 / 越级 / 已删除）", () => {
  const script = read("pages", "favorite-manage", "favorite-manage.js");
  assert.match(script, /favorite_folder_name_duplicate/);
  assert.match(script, /同级已经有同名文件夹/);
  assert.match(script, /favorite_folder_depth_exceeded/);
  assert.match(script, /子文件夹里不能再建子文件夹/);
  assert.match(script, /favorite_folder_missing/);
  assert.match(script, /这个文件夹已经不在了/);
  // 删除确认必须说清"收藏退回未分类、收藏本身不删"。
  assert.match(script, /里面的收藏会回到「未分类」，收藏本身不会被删除/);
});

test("分类管理页的标记：横幅、行、···菜单、⠿把手、新建按钮，显隐走 wx:if", () => {
  const markup = read("pages", "favorite-manage", "favorite-manage.wxml");
  assert.match(markup, /class="manage-banner"/);
  assert.match(markup, /整理你的收藏目录/);
  assert.match(markup, /bindtap="enterFolder"/);
  assert.match(markup, /catchtap="folderMenu"/);
  assert.match(markup, /⠿/);
  assert.match(markup, /catchtouchstart="startDrag"/);
  assert.match(markup, /catchtouchmove="dragMove"/);
  assert.match(markup, /catchtouchend="endDrag"/);
  assert.match(markup, /bindtap="createFolder"/);
  assert.match(markup, /新建子文件夹|新建文件夹/);
  assert.match(markup, /bindtap="backToTop"/);
  const markupWithoutComments = markup.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(markupWithoutComments, /\shidden[=\s>]/, "显隐走 wx:if，不用 hidden + 作者 display");
  assert.match(markup, /wx:if="\{\{parentName\}\}"/);
  assert.match(markup, /wx:if="\{\{error\}\}"/);
});

test("拖拽排序的行高在标记与样式里一致（112rpx = 56px，脚本按它换算落点）", () => {
  const style = read("pages", "favorite-manage", "favorite-manage.wxss");
  assert.match(style, /\.folder-row\s*\{[^}]*height:\s*112rpx/, "行高必须与脚本里的 ROW_HEIGHT=56 对应");
  const script = read("pages", "favorite-manage", "favorite-manage.js");
  assert.match(script, /const ROW_HEIGHT = 56;/);
});

test("服务端没这个接口（404）时要说明是「服务未就绪」，且不知道条数时不许显示 0", () => {
  const script = read("pages", "favorite-manage", "favorite-manage.js");
  const markup = read("pages", "favorite-manage", "favorite-manage.wxml");
  // 拉取与写入两条路径都要认 404（API 只在进程启动时加载，AGENTS §8——真机上就是这么撞上的）
  assert.match(script, /response\.statusCode === 404\s*\n?\s*\? "收藏目录服务未就绪（后台服务需重启后生效）"/);
  assert.match(script, /response\.statusCode === 404 \? "收藏目录服务未就绪（后台服务需重启后生效）" : "操作失败，请稍后重试"/);
  // 「N 个」在加载失败时是未知量，不能显示 0（真机截图上显示的就是「0 个」）
  assert.match(markup, /\{\{error \? '—' : folders\.length \+ ' 个'\}\}/);
});

test("顶部横幅是「浅绿轻量」版：浅绿底（不是青色渐变）、无投影、标题不粗、白底片上是青标", () => {
  // 产品负责人 2026-09-23 04:3x 真机指正：「绿框用颜色用浅绿，文字别这么粗，整体轻盈点」。
  const style = read("pages", "favorite-manage", "favorite-manage.wxss");
  const markup = read("pages", "favorite-manage", "favorite-manage.wxml");
  const banner = style.match(/\.manage-banner\s*\{([^}]*)\}/)[1];
  assert.match(banner, /background:\s*#e7f6f1/, "横幅底色要是浅绿 #e7f6f1");
  assert.doesNotMatch(banner, /gradient/, "不能再是青色渐变");
  assert.doesNotMatch(banner, /box-shadow/, "轻盈＝不要投影");
  const title = style.match(/\.manage-banner-title\s*\{([^}]*)\}/)[1];
  assert.match(title, /color:\s*#191f1d/, "浅底上标题要深色");
  const weight = Number((title.match(/font-weight:\s*(\d+)/) || [])[1]);
  assert.ok(weight > 0 && weight <= 600, `标题字重要 ≤600（别这么粗），现在是 ${weight}`);
  assert.match(style.match(/\.manage-banner-sub\s*\{([^}]*)\}/)[1], /color:\s*#5f6d66/, "副标题用灰字");
  assert.match(style.match(/\.manage-banner-icon\s*\{([^}]*)\}/)[1], /background:\s*#ffffff/, "图标底片是白方块（轻盈）");
  // 底片变白之后，白图标（pack-folder.svg）就又会隐形——必须是青色标
  assert.match(markup, /class="manage-banner-icon"><image src="\/assets\/icons\/folder-brand\.svg"/);
});
