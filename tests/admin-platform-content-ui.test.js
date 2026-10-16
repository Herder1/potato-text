// 平台设置面板（切片 2，2026-10-05）契约：
// ① 后台有「平台设置」入口，且用户端当前可见状态与 7 份文档一一对应；
// ② 编辑器只能"新增版本 → 发布/下架"，界面上不存在"改写已发布版本"的入口；
// ③ 未发布时页面文案必须是「尚未发布」（不得显示成正式协议）；
// ④ 后端 store 的每个错误码在后台都有中文提示（否则运营看到裸错误码）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const adminRoot = path.join(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(adminRoot, "index.html"), "utf8");
const app = fs.readFileSync(path.join(adminRoot, "app.js"), "utf8");
const css = fs.readFileSync(path.join(adminRoot, "styles.css"), "utf8");
const store = fs.readFileSync(path.join(__dirname, "../apps/api/src/platform-content-store.js"), "utf8");

test("后台有「平台设置」入口，面板默认隐藏并随菜单切换显隐", () => {
  assert.match(html, /<button class="nav-item" data-view="平台设置">平台设置<\/button>/);
  assert.match(html, /<section class="content platform-content-admin-view" id="platform-content-admin" hidden>/);
  assert.match(html, /<h2>平台设置<\/h2>/);
  assert.match(app, /const isPlatformContent = name === "平台设置"/);
  assert.match(app, /document\.querySelector\("#platform-content-admin"\)\.hidden = !isPlatformContent;/);
  assert.match(app, /if \(isPlatformContent\) await loadPlatformContent\(\);/);
  // 占位页必须让位（否则「平台设置」会同时显示占位文案）
  const placeholderLine = app.match(/document\.querySelector\("#placeholder"\)\.hidden = [^;]+;/);
  assert.ok(placeholderLine, "找不到占位页显隐那一行");
  assert.match(placeholderLine[0], /\|\| isPlatformContent;/);
  assert.match(html, /id="refresh-platform-content"/);
  assert.match(html, /id="platform-content-table-body"/);
  assert.match(html, /id="platform-content-summary"/);
});

test("编辑器只提供新增/发布/下架，不提供改写已发布版本的入口", () => {
  const ids = [
    "platform-content-editor-dialog", "platform-content-editor-title", "platform-content-editor-copy",
    "platform-content-editor-status", "platform-content-editor-form", "platform-content-key",
    "platform-content-version", "platform-content-effective-date", "platform-content-note",
    "platform-content-body", "platform-content-current", "platform-content-history",
    "save-platform-version", "close-platform-content-editor", "cancel-platform-content-editor",
  ];
  ids.forEach((id) => {
    const hits = [...html.matchAll(new RegExp(`id="${id}"`, "g"))].length;
    assert.equal(hits, 1, `#${id} 应恰好出现 1 次，实际 ${hits} 次`);
  });
  // 正文长度上限与 store 的 MAX_BODY_LENGTH 同源
  const maxBody = store.match(/MAX_BODY_LENGTH\s*=\s*(\d+)/)[1];
  assert.match(html, new RegExp(`id="platform-content-body"[^>]*maxlength="${maxBody}"`));
  // 版本号上限与 store 同源
  const maxVersion = store.match(/MAX_VERSION_LENGTH\s*=\s*(\d+)/)[1];
  assert.match(html, new RegExp(`id="platform-content-version"[^>]*maxlength="${maxVersion}"`));
  // 表单只 POST 到 /versions（新增草稿），发布/下架是各自的动作按钮
  assert.match(app, /`\/api\/admin\/platform-content\/\$\{encodeURIComponent\(key\)\}\/versions`/);
  assert.match(app, /`\/api\/admin\/platform-content\/\$\{encodeURIComponent\(key\)\}\/publish`/);
  assert.match(app, /`\/api\/admin\/platform-content\/\$\{encodeURIComponent\(key\)\}\/unpublish`/);
  assert.doesNotMatch(app, /method: "PUT",\s*\n\s*body: JSON\.stringify\(\{\s*\n\s*version: document\.querySelector\("#platform-content-version"\)/);
  // 提交/关闭/遮罩点击都要接上
  assert.match(app, /#platform-content-editor-form"\)\.addEventListener\("submit", savePlatformContentVersion\)/);
  assert.match(app, /#close-platform-content-editor"\)\.addEventListener\("click", closePlatformContentEditor\)/);
  assert.match(app, /#cancel-platform-content-editor"\)\.addEventListener\("click", closePlatformContentEditor\)/);
  assert.match(app, /#platform-content-editor-dialog"\)\.addEventListener\("click"/);
  // 对话框只有在没打开时才 showModal（重复 showModal 会抛异常）
  assert.match(app, /if \(!dialog\.open\) dialog\.showModal\(\);/);
  // 历史表在 <form> 内部：里面的按钮必须显式 type="button"，否则点击会连带提交表单并悄悄存一版草稿
  const formStart = html.indexOf('id="platform-content-editor-form"');
  const formEnd = html.indexOf("</form>", formStart);
  assert.ok(formStart > 0 && formEnd > formStart, "找不到平台设置编辑表单");
  const untyped = [...html.slice(formStart, formEnd).matchAll(/<button(?![^>]*\btype=)[^>]*>/g)];
  assert.deepEqual(untyped.map((match) => match[0]), [], "表单内的按钮都要写 type=\"button\"");
  ["load", "publish", "unpublish", "edit"].forEach((action) => {
    assert.match(app, new RegExp(`<button type="button" class="icon-text-action[^"]*" data-platform-content-action="${action}"`), `渲染出的 ${action} 按钮要带 type="button"`);
  });
  // 历史表里能载入旧版正文、能发布/下架
  assert.match(app, /data-platform-content-action="load"/);
  assert.match(app, /data-platform-content-action="publish"/);
  assert.match(app, /data-platform-content-action="unpublish"/);
});

test("未发布时展示「尚未发布」，版本号建议与状态徽标符合口径", () => {
  const start = app.indexOf("const platformContentStatusLabels");
  const end = app.indexOf("async function loadPlatformContent()");
  assert.ok(start > 0 && end > start, "找不到平台设置纯函数区块");
  const helpers = new Function(`${app.slice(start, end)}
    return { platformContentCurrentText, platformContentStatusBadge, nextPlatformContentVersion, latestPlatformContentVersion };`)();

  assert.equal(helpers.platformContentCurrentText({ currentVersion: "" }), "尚未发布");
  assert.equal(helpers.platformContentCurrentText({}), "尚未发布");
  // 表格里未发布时只显示徽标，不再把「尚未发布」重复印第二行
  assert.match(app, /class="status-pill \$\{escapeHtml\(badge\.className\)\}">\$\{escapeHtml\(badge\.label\)\}<\/span>\$\{item\.currentVersion \? /);
  assert.equal(helpers.platformContentCurrentText({ currentVersion: "1.0", effectiveDate: "2026-10-10" }), "版本 1.0 · 生效 2026-10-10");
  assert.equal(helpers.platformContentCurrentText({ currentVersion: "1.0" }), "版本 1.0 · 未填生效日期");

  assert.deepEqual(helpers.platformContentStatusBadge({ currentVersion: "1.0", versionCount: 1 }), { label: "用户端可见", className: "published" });
  assert.deepEqual(helpers.platformContentStatusBadge({ currentVersion: "", versionCount: 2 }), { label: "有版本但未发布", className: "offline" });
  assert.deepEqual(helpers.platformContentStatusBadge({ currentVersion: "", versionCount: 0 }), { label: "尚未发布", className: "draft" });

  assert.equal(helpers.nextPlatformContentVersion("1.0"), "1.1");
  assert.equal(helpers.nextPlatformContentVersion("1.9"), "1.10");
  assert.equal(helpers.nextPlatformContentVersion("2"), "3");
  assert.equal(helpers.nextPlatformContentVersion("2026.10"), "2026.11");
  assert.equal(helpers.nextPlatformContentVersion(""), "1.0");
  assert.equal(helpers.nextPlatformContentVersion(undefined), "1.0");

  // 已有版本里取最大（历史里存过 1.0 时要推到 1.1，而不是又建议 1.0 撞版本号）
  assert.equal(helpers.latestPlatformContentVersion(["1.0"]), "1.0");
  assert.equal(helpers.latestPlatformContentVersion(["1.10", "1.9", "1.0"]), "1.10");
  assert.equal(helpers.latestPlatformContentVersion(["2.0", "1.3"]), "2.0");
  assert.equal(helpers.latestPlatformContentVersion([]), "");
  assert.equal(helpers.latestPlatformContentVersion(undefined), "");
  assert.equal(helpers.nextPlatformContentVersion(helpers.latestPlatformContentVersion(["1.10", "1.9"])), "1.11");
  // 发布时补填生效日期：后台要把这一栏一起发给接口
  assert.match(app, /JSON\.stringify\(\{ version, effectiveDate \}\)/);
});

test("store 的每个错误码在后台都有中文提示", () => {
  const codes = [...new Set([...store.matchAll(/"(platform_content_[a-z_]+)"/g)].map((match) => match[1]))];
  assert.ok(codes.length >= 10, `解析到的错误码过少（${codes.length}），解析逻辑可能失效`);
  const missing = codes.filter((code) => !new RegExp(`^\\s*${code}:\\s*"`, "m").test(app));
  assert.deepEqual(missing, [], `这些错误码在后台没有中文提示：${missing.join(", ")}`);
});

test("面板样式与静态资源版本号：hidden 兜底齐全且 ?v= 同值已抬版", () => {
  const hiddenElements = [...html.matchAll(/<[^>]*class="([^"]*)"[^>]*\bhidden\b[^>]*>/gi)];
  const platformClasses = new Set();
  hiddenElements.forEach((match) => match[1].split(/\s+/).forEach((name) => { if (name.startsWith("platform-content")) platformClasses.add(name); }));
  assert.ok(platformClasses.size > 0, "没解析到带 hidden 的平台设置元素");
  platformClasses.forEach((className) => {
    assert.match(css, new RegExp(`\\.${className}\\[hidden\\]`), `.${className} 自己有 display 样式，必须补 .${className}[hidden] { display: none; }`);
  });

  const versions = [...html.matchAll(/\?v=([0-9.]+)/g)].map((match) => match[1]);
  assert.ok(versions.length >= 6, `?v= 出现次数异常（${versions.length}）`);
  assert.equal(new Set(versions).size, 1, `?v= 必须同值：${versions.join(", ")}`);
  assert.match(versions[0], /^2026\d{4}\.\d+$/, `版本号必须形如 20261005.82，实际 ${versions[0]}`);
  assert.notEqual(versions[0], "20261004.81", "改了 app.js / styles.css 必须抬版本号");
});
