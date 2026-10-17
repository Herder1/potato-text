const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const {
  apiSourceChangedSince,
  createApiFreshnessProbe,
  listSourceFiles,
  formatDateKey,
  formatStamp,
} = require("../apps/api/src/api-freshness");

const adminRoot = path.join(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(adminRoot, "index.html"), "utf8");
const css = fs.readFileSync(path.join(adminRoot, "styles.css"), "utf8");
const appJs = fs.readFileSync(path.join(adminRoot, "app.js"), "utf8");

/**
 * 「后端没重启，改动未生效」自检（2026-09-25 产品负责人确认要做）。
 * 背景：`/admin/` 静态资源每次请求读盘，而 API 代码只在进程启动时加载，于是会出现
 * 「界面已是新口径、后端还是旧校验」的假故障——2026-09-25 14:09 的实例是「AI 批量完善」
 * 10/10 全失败并提示"请先确认教材目录"，而 9 册教材的目录其实早都确认过了。
 * 判据在这里锁成三条：纯函数语义、`/health` 契约（含向后兼容）、后台横幅的静态契约。
 */

test("后端陈旧判据：源码比进程启动新就是「改了没重启」，否则不是", () => {
  const files = [
    { file: "server.js", mtimeMs: 1000 },
    { file: "question-enrichment-store.js", mtimeMs: 2000 },
  ];
  // 进程启动于 3000（最新代码 2000）→ 不陈旧
  const fresh = apiSourceChangedSince({ dir: "/tmp/api", bootedAtMs: 3000, files });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.newestFile, "question-enrichment-store.js");
  assert.equal(fresh.filesScanned, 2);
  assert.equal(fresh.bootDate, formatDateKey(3000));
  // 进程启动于 1500（server.js 1000、store 2000 都比它新 → 取最新那个）→ 陈旧
  const stale = apiSourceChangedSince({ dir: "/tmp/api", bootedAtMs: 1500, files });
  assert.equal(stale.stale, true);
  assert.equal(stale.newestFile, "question-enrichment-store.js");
  assert.equal(stale.newestMtimeMs, 2000);
  // 边界：一个源文件都没有时不能误报（宁可漏报，也不要让后台天天喊重启）
  assert.equal(apiSourceChangedSince({ dir: "/tmp/api", bootedAtMs: 1, files: [] }).stale, false);
  // 边界：没有启动时间基准时不判陈旧
  assert.equal(apiSourceChangedSince({ dir: "/tmp/api", bootedAtMs: 0, files }).stale, false);
});

test("后端陈旧判据：真实目录扫描能在临时目录里认出改动，且 TTL 缓存不吃掉新结果", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-freshness-"));
  fs.writeFileSync(path.join(dir, "server.js"), "// 旧代码\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "非 js 不算源码\n");
  const before = fs.statSync(path.join(dir, "server.js")).mtimeMs;
  assert.deepEqual(listSourceFiles(dir).map((item) => item.file), ["server.js"]);
  assert.equal(apiSourceChangedSince({ dir, bootedAtMs: before + 5000 }).stale, false);
  assert.equal(apiSourceChangedSince({ dir, bootedAtMs: before - 5000 }).stale, true);

  const probe = createApiFreshnessProbe({ dir, bootedAtMs: before - 5000, ttlMs: 60000 });
  assert.equal(probe.read().stale, true);
  // 目录扫描有 TTL 缓存，但 invalidate() 后必须立刻看到新出现的源文件（否则"改完不提示"）
  fs.writeFileSync(path.join(dir, "extra.js"), "// 新加的源文件\n");
  probe.invalidate();
  const afterNewFile = probe.read();
  assert.equal(afterNewFile.stale, true);
  assert.equal(afterNewFile.filesScanned, 2);
});

test("/health 下发本进程启动时间与陈旧判据（附加字段，不改变原有字段）", async (context) => {
  const bootedAtMs = Date.parse("2026-09-23T03:30:54+08:00");
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), bootedAtMs });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  // 原有字段（tests/api.test.js 依赖）一个都不能少
  assert.equal(health.status, "ok");
  assert.equal(health.service, "shukao-api");
  assert.equal(health.version, "0.1.0");
  assert.ok("fileStorage" in health);
  // 附加字段
  assert.equal(health.startedAt, bootedAtMs);
  assert.equal(health.bootDate, "20260923");
  assert.equal(health.startedAtLabel, formatStamp(bootedAtMs));
  assert.equal(health.apiSourceStale, true, "仓库里的 apps/api/src 一定比 2026-09-23 03:30 新");
  // 不写死文件名：最新的那个源文件会随每次改动变化（2026-09-25 实测：新增 material-score-allocation.js 后
  // 它就成了最新文件）。这里只断言"报出的是一个 .js 源文件名，且它的时间确实比进程启动新"。
  assert.match(health.apiSourceNewestFile, /^[^/\\]+\.js$/, `最新源文件名应形如 xxx.js，实际 ${health.apiSourceNewestFile}`);
  assert.ok(Number(health.apiSourceFiles) > 10);
  assert.ok(Number(health.apiSourceNewestAt) > bootedAtMs);
  assert.match(health.apiSourceNewestLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // 反过来：进程启动时间比所有源文件都新 → 不报陈旧（避免误报把横幅变成噪音）
  const freshServer = createServer({ aiConfigStore: createMemoryAiConfigStore(), bootedAtMs: Date.now() + 3600000 });
  await new Promise((resolve) => freshServer.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => freshServer.close(resolve)));
  const freshHealth = await fetch(`http://127.0.0.1:${freshServer.address().port}/health`).then((response) => response.json());
  assert.equal(freshHealth.apiSourceStale, false);
  assert.match(freshHealth.apiSourceNewestFile, /^[^/\\]+\.js$/);
  assert.equal(freshHealth.uptimeMs, 0);
});

test("后台横幅静态契约：默认隐藏、有 [hidden] 兜底、会拿 /health 的两条判据", () => {
  // ① 元素：默认 hidden + 一个能显示原因的明细位 + 关闭按钮
  const banner = html.match(/<div class="stale-backend-banner" id="admin-backend-stale" hidden>/);
  assert.ok(banner, "index.html 缺少默认隐藏的 stale-backend-banner");
  assert.match(html, /id="admin-backend-stale-detail"/);
  assert.match(html, /id="admin-backend-stale-dismiss"/);
  assert.match(html, /<strong>后端未重启，改动未生效<\/strong>/);

  // ② CSS：作者 display:flex 会压过 [hidden]，必须显式兜底（AGENTS §6 的经典坑）
  assert.match(css, /\.stale-backend-banner\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.stale-backend-banner\[hidden\]\s*\{\s*display:\s*none/);

  // ③ 脚本：版本号取自已加载的 script 标签（不是写死常量），判据取自 /health
  assert.match(appJs, /script\[src\*="app\.js"\]/, "版本号必须从实际加载的 script 标签解析");
  assert.match(appJs, /\[\?&\]v=\(\\d\{8\}\)/);
  assert.match(appJs, /fetch\("\/health"/);
  assert.match(appJs, /apiSourceStale === true/);
  assert.match(appJs, /apiSourceNewestFile/);
  assert.match(appJs, /assetDate > bootDate/);
  // 老后端兜底：连启动时间都不上报 ⇒ 它跑的是加入本自检之前的代码，也必须被判为陈旧
  assert.match(appJs, /missingBootFacts/);
  assert.match(appJs, /!bootDate && !Number\(health\.startedAt\)/);
  assert.match(appJs, /stale: codeStale \|\| missingBootFacts \|\| assetNewer/);
  assert.match(appJs, /banner\.hidden = false/);
  assert.match(appJs, /banner\.hidden = true/);
  assert.match(appJs, /#admin-backend-stale-dismiss"\)\.addEventListener/);
  assert.match(appJs, /visibilitychange/);
  assert.match(appJs, /checkAdminBackendFreshness\(\);\nbootstrapAdminSession\(\);/);

  // ④ 脚本版本号与 index.html 里的 `?v=` 一致（版本号是绕过缓存的唯一手段，必须同源）
  const version = html.match(/app\.js\?v=(\d{8}\.\d+)/);
  assert.ok(version, "index.html 缺少 app.js 版本号");
  assert.match(html, new RegExp(`styles\\.css\\?v=${version[1].replace(".", "\\.")}`));
});

test("后台环境标识按实际域名显示，不再把线上后台写死成本地开发环境", () => {
  assert.match(html, /id="admin-env-label">正在识别环境</);
  assert.doesNotMatch(html, />\s*本地开发环境\s*</);
  assert.match(html, /<strong>教材目录发布提示<\/strong>/);
  assert.match(appJs, /function renderAdminEnvironment\(\)/);
  assert.match(appJs, /window\.location\.hostname/);
  assert.match(appJs, /host === "localhost"/);
  assert.match(appJs, /"本地开发环境" : "生产环境"/);
  assert.match(appJs, /renderAdminEnvironment\(\);\nresetProviderForm\(\);/);
});
