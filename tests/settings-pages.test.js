const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../apps/miniprogram");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

// 2026-10-02 产品负责人确认：新建设置页（图2）与关于我们（图3），
// 并把原「隐私与数据」页（图4 那一行）拆分进设置；隐私与数据页下线。
test("app.json registers the new settings pages and drops the retired privacy page", () => {
  const config = JSON.parse(read("app.json"));
  for (const page of [
    "pages/settings/settings",
    "pages/about/about",
    "pages/legal/legal",
    "pages/practice-settings/practice-settings",
    "pages/personal-info/personal-info",
    "pages/device-info/device-info",
  ]) {
    assert.ok(config.pages.includes(page), `${page} 应注册进 app.json`);
  }
  assert.ok(!config.pages.includes("pages/privacy/privacy"), "已下线的隐私与数据页不应再打包");
  const retirement = read("pages", "privacy", "privacy.js");
  assert.match(retirement, /已下线（2026-10-02/, "下线页要留追溯标记");
});

test("settings page keeps the cloud controls and wires every row to a real target", () => {
  const markup = read("pages", "settings", "settings.wxml");
  const script = read("pages", "settings", "settings.js");
  const styles = read("pages", "settings", "settings.wxss");

  // 顶部两个动作 + 退出登录 + 版本号
  // 2026-10-17：两个动作由原生 <button> 改为 view 自绘按钮（真机上 button 内置盒模型会把按钮撑出屏幕，
  // 压住下一行状态文字），禁用态与 loading 改用 class 与文案表达。
  assert.match(markup, /bindtap="retryPersonalAssets"[\s\S]{0,260}<text class="sync-icon">⟳<\/text><text class="sync-label">\{\{cloudBusy \? '同步中…' : '重试同步'\}\}<\/text>/);
  assert.match(markup, /bindtap="exportPersonalAssets"[\s\S]{0,260}<text class="sync-icon">⤓<\/text><text class="sync-label">导出我的数据<\/text>/);
  assert.doesNotMatch(markup, /<button class="sync-button/, "同步/导出不再用原生 button，尺寸由本页 wxss 决定");
  assert.match(markup, /aria-label="重试同步"[\s\S]{0,40}aria-disabled="\{\{cloudBusy \|\| !loggedIn\}\}"/);
  assert.match(markup, /bindtap="logoutAccount"/);
  assert.match(markup, /当前版本 \{\{version\}\}/);
  assert.match(styles, /\.sync-actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  // 2026-10-17 修「有的机型按钮重叠」（窄屏 + 系统大字体时文字压到边框与下一行）：
  // 按钮必须可收缩、内容可换行且裁在框内。
  assert.match(styles, /\.sync-button \{[^}]*min-width: 0/);
  assert.match(styles, /\.sync-button \{[^}]*overflow: hidden/);
  assert.match(styles, /\.sync-button \{[^}]*flex-wrap: wrap/);
  assert.match(styles, /\.sync-label \{[^}]*min-width: 0/);
  // 2026-10-17 同日追加（产品负责人看真机后否掉竖排）：「两个按钮始终同一行」，
  // 窄屏只许压缩内边距/字号/图标，不许把列数改成 1。
  assert.match(styles, /@media \(max-width: 360px\) \{[\s\S]{0,200}\.sync-button \{ padding: 10rpx 10rpx; font-size: 24rpx; gap: 6rpx; \}/);
  assert.doesNotMatch(styles, /grid-template-columns: 1fr/, "窄屏不得把两个按钮改成上下单列");
  // 2026-10-03 产品负责人逐处指定：两个按钮文字与五行标题都降到 500 档；
  // 「退出登录」与行说明未在框内，保持原样（退出登录仍 600）。
  assert.match(styles, /\.sync-button \{[^}]*font-weight: 500/);
  assert.match(styles, /\.settings-title \{[^}]*font-weight: 500/);
  assert.match(styles, /\.logout-button \{[^}]*font-weight: 600/);
  assert.match(styles, /\.logout-button \{[^}]*min-height: 76rpx[^}]*line-height: 76rpx/);
  assert.doesNotMatch(styles, /\.settings-title \{[^}]*font-weight: 600/);

  // 五行入口与落点
  for (const title of ["练习设置", "关于我们", "个人信息收集清单", "设备信息", "注销账号"]) {
    assert.ok(markup.includes(`{{item.title}}`), "行文案来自 rows");
    assert.ok(script.includes(title), `rows 应含「${title}」`);
  }
  assert.match(script, /key === "practice"[\s\S]{0,80}?\/pages\/practice-settings\/practice-settings/);
  assert.match(script, /key === "about"[\s\S]{0,80}?\/pages\/about\/about/);
  assert.match(script, /key === "personal"[\s\S]{0,80}?\/pages\/personal-info\/personal-info/);
  assert.match(script, /key === "device"[\s\S]{0,80}?\/pages\/device-info\/device-info/);
  assert.match(script, /key === "delete"[\s\S]{0,40}?this\.deleteAccount\(\)/);

  // 每个 bindtap 都要有真handler；显隐走 wx:if，不用 hidden（AGENTS §6）
  assert.doesNotMatch(markup, /\shidden=/);
  for (const name of [...markup.matchAll(/bindtap="(\w+)"/g)].map((match) => match[1])) {
    assert.match(script, new RegExp(`\\b${name}\\(`), `${name} 必须有实现`);
  }
});

test("about page shows the app identity and opens every platform document", () => {
  const markup = read("pages", "about", "about.wxml");
  const script = read("pages", "about", "about.js");
  const meta = require("../apps/miniprogram/utils/app-meta");
  const platformContent = require("../apps/miniprogram/utils/platform-content");

  assert.equal(meta.APP_VERSION, "2.4.0");
  assert.equal(meta.APP_NAME, "薯考", "应用名用产品自己的品牌名，不再用「教育学习助手」这种占位名");
  // DEC-110：假运营主体与写死法务目录一并删除——不留任何冒充正式主体的占位文本
  assert.doesNotMatch(JSON.stringify(meta), /教育科技|教育学习助手/);
  assert.equal(meta.LEGAL_DOCS, undefined, "法务目录唯一维护点已移到 utils/platform-content.js");
  assert.doesNotMatch(script.replace(/\/\/[^\n]*/g, ""), /LEGAL_DOCS|教育科技/, "注释里可以提旧名字，代码里不许再引用");
  assert.match(markup, /\{\{appName\}\}/);
  assert.match(markup, /版本 \{\{version\}\}/);
  assert.match(markup, /\{\{copyright\}\}/);
  assert.match(markup, /\{\{slogan\}\}/);
  assert.match(markup, /data-doc="\{\{item\.key\}\}"/);
  assert.match(script, /wx\.navigateTo\(\{ url: `\/pages\/legal\/legal\?doc=\$\{encodeURIComponent\(doc\)\}` \}\)/);
  // 七份平台文本都能从关于页进入（含退款政策与账号注销说明，DEC-110 ⑥）
  assert.deepEqual(platformContent.docList().map((doc) => doc.title), [
    "用户协议", "隐私政策", "AI 服务说明", "退款政策", "账号注销说明", "运营主体与客服信息", "个人信息收集清单",
  ]);

  // 图标必须真实存在（icon-surface-convention 只校验页面里的引用，这里把动态引用也钉住）
  for (const doc of platformContent.docList()) {
    const file = path.join(ROOT, doc.icon.replace("/assets/icons/", "assets/icons/"));
    assert.ok(fs.existsSync(file), `${doc.icon} 应存在`);
  }
  // 2026-10-17 产品负责人指出「图标风格太乱、颜色不统一」：七份文档改用专用图标组，
  // 不再借用未登录头像 / 编辑器工具栏等其它入口的图标。
  for (const doc of platformContent.docList()) {
    assert.match(doc.icon, /^\/assets\/icons\/doc-[a-z-]+\.svg$/, `${doc.key} 应使用统一的 doc-* 图标`);
  }
  assert.equal(new Set(platformContent.docList().map((doc) => doc.icon)).size, 7, "七份文档不能用重复图标");
});

test("legal page renders the published version and never fakes content", async () => {
  const platformContent = require("../apps/miniprogram/utils/platform-content");
  const loadPage = (options = {}) => {
    let definition;
    global.Page = (value) => { definition = value; };
    const requests = [];
    global.getApp = () => ({ globalData: { apiBaseUrl: "http://api.test" } });
    global.wx = {
      setNavigationBarTitle: ({ title }) => { options.onTitle && options.onTitle(title); },
      request: (config) => {
        requests.push(config);
        if (options.fail) { config.fail({ errMsg: "request:fail" }); return; }
        config.success(options.response);
      },
    };
    const file = require.resolve("../apps/miniprogram/pages/legal/legal.js");
    delete require.cache[file];
    require(file);
    const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
    return { page, requests };
  };
  const published = { statusCode: 200, data: { success: true, published: true, document: { key: "privacy", title: "隐私政策", version: "1.2", effectiveDate: "2026-10-01", body: "第一段\n\n第二段" } } };

  platformContent.resetCache();
  let navTitle = "";
  const ok = loadPage({ response: published, onTitle: (title) => { navTitle = title; } });
  await ok.page.onLoad({ doc: "privacy" });
  assert.equal(navTitle, "隐私政策");
  assert.equal(ok.page.data.doc.state, "published");
  assert.deepEqual(ok.page.data.doc.paragraphs, ["第一段", "第二段"], "正文按换行分段，空行忽略");
  assert.equal(ok.page.data.doc.statusLine, "版本 1.2 · 生效 2026-10-01");
  assert.match(ok.requests[0].url, /\/api\/platform-content\/privacy$/, "只读服务端已发布版本");

  // 未发布 → 明确「尚未发布」，且不携带任何正文
  platformContent.resetCache();
  const empty = loadPage({ response: { statusCode: 200, data: { success: true, published: false, status: "draft", document: { key: "privacy", title: "隐私政策" } } } });
  await empty.page.onLoad({ doc: "privacy" });
  assert.equal(empty.page.data.doc.state, "unpublished");
  assert.equal(empty.page.data.doc.statusLine, "尚未发布");
  assert.deepEqual(empty.page.data.doc.paragraphs, []);
  assert.equal(empty.page.data.doc.body, "");

  // 读不到 → 如实说明 + 可重试（重试跳缓存）
  platformContent.resetCache();
  const broken = loadPage({ fail: true });
  await broken.page.onLoad({ doc: "terms" });
  assert.equal(broken.page.data.doc.state, "failed");
  assert.equal(broken.page.data.doc.statusLine, "暂时读不到");
  assert.equal(broken.page.data.doc.canRetry, true);
  const before = broken.requests.length;
  await broken.page.retryLoadDoc();
  assert.equal(broken.requests.length, before + 1, "重试要真的再发一次请求");

  // 未知 doc 回落到登记表第一份，而不是空白页
  platformContent.resetCache();
  const unknown = loadPage({ response: published });
  await unknown.page.onLoad({ doc: "unknown-doc" });
  assert.equal(unknown.page.data.doc.key, "terms");

  // 页面与模板里都不许出现写死的法务正文
  const markup = read("pages", "legal", "legal.wxml");
  const template = read("templates", "platform-doc.wxml");
  assert.doesNotMatch(markup, /内容待补充|尚未提供/);
  assert.match(markup, /<import src="\.\.\/\.\.\/templates\/platform-doc\.wxml" \/>/);
  assert.match(markup, /<template is="platformDocBody" data="\{\{doc: doc\}\}" \/>/);
  assert.match(template, /尚未发布/);
  assert.doesNotMatch(markup + template, /\shidden=/);
  for (const name of [...markup.matchAll(/bindtap="(\w+)"/g)].map((match) => match[1])) {
    assert.match(read("pages", "legal", "legal.js"), new RegExp(`\\b${name}\\(`), `${name} 必须有实现`);
  }
  for (const name of [...template.matchAll(/bindtap="(\w+)"/g)].map((match) => match[1])) {
    assert.match(read("pages", "legal", "legal.js"), new RegExp(`\\b${name}\\(`), `模板里的 ${name} 也要在使用页有实现`);
  }

  delete global.wx;
  delete global.Page;
  delete global.getApp;
});

test("personal info page reads the personal-info document instead of hardcoded prose", async () => {
  const platformContent = require("../apps/miniprogram/utils/platform-content");
  let definition;
  const requests = [];
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://api.test" } });
  global.wx = {
    setNavigationBarTitle: () => {},
    request: (config) => {
      requests.push(config);
      config.success({ statusCode: 200, data: { success: true, published: true, document: { key: "personal-info", title: "个人信息收集清单", version: "1.0", effectiveDate: "2026-10-20", body: "微信登录标识：登录时收集，用于账号识别，保存至账号注销。" } } });
    },
  };
  platformContent.resetCache();
  const file = require.resolve("../apps/miniprogram/pages/personal-info/personal-info.js");
  delete require.cache[file];
  require(file);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  await page.onLoad();

  assert.match(requests[0].url, /\/api\/platform-content\/personal-info$/, "读的是后台维护的那一份平台文本");
  assert.equal(page.data.doc.state, "published");
  assert.equal(page.data.doc.statusLine, "版本 1.0 · 生效 2026-10-20");
  assert.deepEqual(page.data.doc.paragraphs, ["微信登录标识：登录时收集，用于账号识别，保存至账号注销。"]);

  // 写死的清单与三段说明已删除（内容随实现变化就会与真实处理方式脱节）
  const script = read("pages", "personal-info", "personal-info.js");
  const markup = read("pages", "personal-info", "personal-info.wxml");
  assert.doesNotMatch(script, /2026 年 8 月 5 日|微信登录标识|AI 输入与结果|我们处理的信息|保存、访问与更正/);
  assert.match(markup, /<import src="\.\.\/\.\.\/templates\/platform-doc\.wxml" \/>/);
  assert.doesNotMatch(markup, /\shidden=/);
  assert.match(script, /openService\(\)[\s\S]{0,140}?\/pages\/help-feedback\/help-feedback\?tab=submit/);
  assert.match(script, /retryLoadDoc\(\)/, "模板里的重试按钮在本页也要有实现");

  delete global.wx;
  delete global.Page;
  delete global.getApp;
});


test("device info page reports real local fields and admits what is not wired yet", () => {
  let definition;
  global.Page = (value) => { definition = value; };
  global.wx = {
    getDeviceInfo: () => ({ brand: "Apple", model: "iPhone 15", system: "iOS 17.4", platform: "ios" }),
    getAppBaseInfo: () => ({ version: "8.0.49", SDKVersion: "3.4.0", envVersion: "trial" }),
  };
  const file = require.resolve("../apps/miniprogram/pages/device-info/device-info.js");
  delete require.cache[file];
  require(file);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onShow();
  const rows = Object.fromEntries(page.data.rows.map((row) => [row.label, row.value]));
  assert.equal(rows["设备品牌"], "Apple");
  assert.equal(rows["设备型号"], "iPhone 15");
  assert.equal(rows["微信版本"], "8.0.49");
  assert.equal(rows["小程序版本"], "体验版");
  const markup = read("pages", "device-info", "device-info.wxml");
  assert.match(markup, /「登录设备列表」由服务端记录，尚未接入/);
  delete global.wx;
  delete global.Page;
});

test("profile drops the privacy row and the gear opens the new settings page", () => {
  const script = read("pages", "profile", "profile.js");
  const markup = read("pages", "profile", "profile.wxml");
  assert.match(script, /menu: \["我的账户", "我的收藏", "我的资产", "社区与贡献", "帮助与反馈"\]/);
  assert.match(markup, /class="profile-settings-button" bindtap="openSettings"/);
  assert.match(script, /openSettings\(\) \{\s*wx\.navigateTo\(\{ url: "\/pages\/settings\/settings" \}\);?\s*\}/);
  assert.doesNotMatch(script, /\/pages\/privacy\/privacy/, "profile 不再直接跳旧页");
  assert.doesNotMatch(script, /logoutAccount/, "退出登录已搬进设置页");
});
