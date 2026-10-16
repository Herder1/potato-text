const fs = require("node:fs");
const path = require("node:path");

// 「后端没重启，改动没生效」自检（2026-09-25 产品负责人确认要做）。
//
// 为什么会需要它：`/admin/` 下的静态资源（`index.html` / `app.js` / `styles.css`）是每次请求从磁盘读的，
// 而 **API 代码只在进程启动时加载**——于是很容易出现「界面已经是新口径、后端还是旧校验」的假故障，
// 表现为界面上改好的东西仍被旧规则拦下（AGENTS §8 的两处历史实例：2026-09-21 22:45 导入 372 道全判需修正、
// 2026-09-25 14:09「AI 批量完善」10/10 全失败并提示"请先确认教材目录"，而目录其实早都确认过了）。
// 判据放在这里、做成**可测的纯函数**，服务端只出事实（是否陈旧 + 时间戳 + 日期键），比较与展示由后台页面做。
//
// 两条判据各管一段，互为兜底：
//   ① 代码视角（精确，精确到毫秒、与前端无关）：`apps/api/src` 下 `*.js` 的最新修改时间 > 本进程启动时间。
//   ② 版本视角（粗一天，但跨机/跨进程也成立）：前端资源版本号里的日期（`?v=YYYYMMDD.NN`）> 后端启动日期。
// 只报事实、不自动重启、不阻断请求——重启必须由人在自己的终端执行（AGENTS §8：Agent 沙箱里进程写不了 `.runtime`）。

const DEFAULT_SOURCE_DIR = __dirname;
const DEFAULT_TTL_MS = 5000;

function toTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// 本机本地时间的人读串（同机比较，不走 UTC，避免跨时区把日期键算错一天）。
function formatStamp(ms) {
  const at = toTimestamp(ms);
  if (!at) return "";
  const date = new Date(at);
  return [
    date.getFullYear(),
    "-",
    pad2(date.getMonth() + 1),
    "-",
    pad2(date.getDate()),
    " ",
    pad2(date.getHours()),
    ":",
    pad2(date.getMinutes()),
    ":",
    pad2(date.getSeconds()),
  ].join("");
}

// 版本号里那种 `YYYYMMDD` 日期键，用于「前端资源版本日期 > 后端启动日期」的比较。
function formatDateKey(ms) {
  const at = toTimestamp(ms);
  if (!at) return "";
  const date = new Date(at);
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function listSourceFiles(dir, options = {}) {
  const root = String(dir || DEFAULT_SOURCE_DIR);
  const extensions = Array.isArray(options.extensions) && options.extensions.length ? options.extensions.map(String) : [".js"];
  const found = [];
  const walk = (current, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      found.push({ file: path.relative(root, full) || entry.name, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root, 0);
  return found;
}

// 返回事实：源文件里有没有比进程启动时间更新的（`stale=true` 就是"改了代码没重启"）。
function apiSourceChangedSince(input = {}) {
  const bootedAtMs = toTimestamp(input.bootedAtMs);
  const files = Array.isArray(input.files) ? input.files : listSourceFiles(input.dir, input);
  const newest = files.reduce((best, item) => {
    const mtimeMs = toTimestamp(item && item.mtimeMs);
    if (!mtimeMs) return best;
    return !best || mtimeMs > best.mtimeMs ? { file: String((item && item.file) || ""), mtimeMs } : best;
  }, null);
  const stale = Boolean(newest && bootedAtMs && newest.mtimeMs > bootedAtMs);
  return {
    checked: true,
    sourceDir: String(input.dir || DEFAULT_SOURCE_DIR),
    filesScanned: files.length,
    bootedAtMs,
    bootedAtLabel: formatStamp(bootedAtMs),
    bootDate: formatDateKey(bootedAtMs),
    stale,
    newestFile: newest ? newest.file : "",
    newestMtimeMs: newest ? newest.mtimeMs : 0,
    newestMtimeLabel: newest ? formatStamp(newest.mtimeMs) : "",
  };
}

// 服务端用这个：目录扫描做 TTL 缓存，避免每次健康检查都遍历一遍源码目录。
function createApiFreshnessProbe(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const readFiles = typeof options.readFiles === "function" ? options.readFiles : null;
  const dir = options.dir || DEFAULT_SOURCE_DIR;
  const bootedAtMs = toTimestamp(options.bootedAtMs);
  let cachedFiles = null;
  let cachedAt = 0;
  // 缓存只缓存"目录扫描"这一半（文件列表），比较与时间戳每次现算，避免把结果算旧。
  const scan = (nowMs) => {
    if (readFiles) return readFiles({ dir, bootedAtMs, extensions: options.extensions });
    if (!cachedFiles || nowMs - cachedAt > ttlMs) {
      cachedFiles = listSourceFiles(dir, { extensions: options.extensions });
      cachedAt = nowMs;
    }
    return cachedFiles;
  };
  return {
    read(nowMs = Date.now()) {
      return apiSourceChangedSince({ dir, bootedAtMs, files: scan(nowMs) });
    },
    invalidate() {
      cachedFiles = null;
      cachedAt = 0;
    },
  };
}

module.exports = {
  DEFAULT_SOURCE_DIR,
  DEFAULT_TTL_MS,
  listSourceFiles,
  apiSourceChangedSince,
  createApiFreshnessProbe,
  formatStamp,
  formatDateKey,
};
