"use strict";

const { execFileSync } = require("node:child_process");

/**
 * 出站代理（2026-10-09 实例：api.typesafe.ai 直连被判「地区不可用」返回 451，Codex++/Chrome 走本机代理正常）。
 *
 * 关键事实：Node 的内置 fetch **默认不读系统代理**，而且 `NODE_USE_ENV_PROXY` / `--use-env-proxy`
 * 只在进程启动时生效（进程内改 process.env 无效）。所以本模块只做两件事：
 *   ① 统一解析「该走哪个代理」（环境变量优先 → Windows 系统代理）；
 *   ② 把它作为可读的状态报告出来（启动日志、/health、后台报错提示），启动脚本据此设环境变量。
 *
 * 不解析代理的请求（本机自调用、内网上游）靠 NO_PROXY 排除；未配置 NO_PROXY 时补一份安全默认值，
 * 否则 3212 的内部自调用会被塞进代理。
 */

const LOCAL_BYPASS = "localhost,127.0.0.1,::1,0.0.0.0";
const REGISTRY_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `http://${text}`;
}

/** 对外展示用：抹掉代理地址里的用户名/密码（/health 会带上这个字段）。 */
function redactProxyUrl(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (!parsed.username && !parsed.password) return text;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch (error) {
    return text.replace(/\/\/[^@/]*@/, "//");
  }
}

/**
 * 解析系统代理字符串，支持 `host:port`、`http=host:port;https=host:port`、`socks=host:port` 三种写法。
 * 优先取 https 段；只有 http 段时也用它（多数本机代理两者同端口）。
 */
function parseProxyServer(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!text.includes("=")) return normalizeProxyUrl(text);
  const segments = new Map();
  text.split(";").forEach((part) => {
    const [key, rawValue] = part.split("=");
    if (!key || !rawValue) return;
    segments.set(key.trim().toLowerCase(), rawValue.trim());
  });
  const picked = segments.get("https") || segments.get("http") || segments.get("socks") || segments.get("socks5") || "";
  if (!picked) return "";
  if (picked.startsWith("socks")) return normalizeProxyUrl(picked);
  return normalizeProxyUrl(picked);
}

/** 读 Windows 系统代理设置；非 Windows 或读不到时返回空对象（不抛错）。 */
function readWindowsProxySettings(runner = defaultRunner) {
  if (process.platform !== "win32") return {};
  try {
    const output = runner("reg", ["query", REGISTRY_PATH]);
    const settings = {};
    String(output || "").split(/\r?\n/).forEach((line) => {
      const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL)\s+REG_\w+\s+(.*)$/i);
      if (!match) return;
      settings[match[1]] = match[2].trim();
    });
    return settings;
  } catch (error) {
    return {};
  }
}

function defaultRunner(file, args) {
  return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 4000 });
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return { value, name };
  }
  return { value: "", name: "" };
}

/**
 * Windows 的 ProxyOverride 用 `;` 分隔、还带 `<local>` 这类占位，不能直接当 NO_PROXY 用。
 * 这里统一成逗号分隔，并保证本机地址一定被排除——否则 3212 的内部自调用会被塞进代理。
 */
function normalizeBypassList(value) {
  const parts = String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item && !/^<.*>$/.test(item));
  [LOCAL_BYPASS.split(",")].flat().forEach((item) => {
    if (!parts.includes(item)) parts.push(item);
  });
  return parts.join(",");
}

/**
 * 解析该用哪个出站代理。
 * 返回 { url, source }；source 说明来源，便于日志与后台提示（env:HTTPS_PROXY / windows-registry / none）。
 */
function resolveOutboundProxy(options = {}) {
  const env = options.env || process.env;
  const settings = options.registry !== undefined ? options.registry : readWindowsProxySettings(options.runner);
  const fromEnv = firstEnv(env, ["AI_PROXY", "AI_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]);
  const bypass = normalizeBypassList(settings.ProxyOverride);
  if (fromEnv.value) return { url: normalizeProxyUrl(fromEnv.value), source: `env:${fromEnv.name}`, noProxy: String(env.NO_PROXY || env.no_proxy || "") || LOCAL_BYPASS };
  const enabled = String(settings.ProxyEnable || "").trim();
  const proxyServer = parseProxyServer(settings.ProxyServer);
  if ((enabled === "0x1" || enabled === "1") && proxyServer) {
    return { url: proxyServer, source: "windows-registry", noProxy: bypass || LOCAL_BYPASS };
  }
  if (settings.AutoConfigURL) {
    // PAC 脚本无法在这里求值：如实报告，不猜代理地址。
    return { url: "", source: "windows-pac-unsupported", noProxy: bypass || LOCAL_BYPASS, autoConfigUrl: String(settings.AutoConfigURL) };
  }
  return { url: "", source: "none", noProxy: bypass || LOCAL_BYPASS };
}

const START_HINT = 'cmd /c cd /d "D:\\龙虾工作站\\题库" && set NODE_USE_ENV_PROXY=1 && set HTTPS_PROXY=<代理地址> && set HTTP_PROXY=<代理地址> && node apps\\api\\src\\server.js';

/**
 * 汇总「当前进程到底有没有在走代理」：
 * - env_active：进程启动时就带了 NODE_USE_ENV_PROXY=1 与代理地址，内置 fetch 会走代理；
 * - env_present_but_inactive：设了代理地址但没设 NODE_USE_ENV_PROXY（内置 fetch 不会走，等于没生效）；
 * - system_only：只有系统代理开着，Node 完全不会用 → 就是 451 这类「浏览器能连、后台连不上」的根因；
 * - none：没有任何代理配置。
 */
function outboundProxyStatus(options = {}) {
  const env = options.env || process.env;
  const resolved = resolveOutboundProxy(options);
  const envProxySet = Boolean(firstEnv(env, ["AI_PROXY", "AI_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]).value);
  const flagOn = String(env.NODE_USE_ENV_PROXY || "").trim() === "1";
  let mode = "none";
  if (resolved.url && flagOn) mode = "env_active";
  else if (envProxySet) mode = "env_present_but_inactive";
  else if (resolved.url) mode = "system_only";
  const hint = mode === "env_active"
    ? ""
    : (mode === "windows-pac_unsupported" || resolved.source === "windows-pac-unsupported"
      ? `检测到系统用 PAC 自动配置代理；Node 不支持 PAC，请显式给代理地址后重启：${START_HINT}`
      : `服务端未走代理${resolved.url ? `（系统代理 ${resolved.url}，Node 默认不用）` : ""}；上游若按地区限制返回 451，请这样重启：${START_HINT}`);
  return {
    active: mode === "env_active",
    mode,
    // 只对外给抹掉凭据的地址：/health 是公开端点。
    url: mode === "none" ? "" : redactProxyUrl(resolved.url),
    source: resolved.source,
    noProxy: resolved.noProxy,
    hint,
  };
}

module.exports = {
  LOCAL_BYPASS,
  START_HINT,
  normalizeBypassList,
  normalizeProxyUrl,
  outboundProxyStatus,
  parseProxyServer,
  readWindowsProxySettings,
  redactProxyUrl,
  resolveOutboundProxy,
};
