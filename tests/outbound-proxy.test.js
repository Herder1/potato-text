const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOCAL_BYPASS,
  normalizeBypassList,
  outboundProxyStatus,
  parseProxyServer,
  redactProxyUrl,
  resolveOutboundProxy,
} = require("../apps/api/src/outbound-proxy");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createServer, ADMIN_USERNAME, ADMIN_PASSWORD } = require("./helpers/admin-auth");
const http = require("node:http");

// 2026-10-09 实例：api.typesafe.ai 直连被 Cloudflare 判「地区不可用」返回 451，
// 而 Codex++/Chrome 走本机代理（127.0.0.1:7897）正常 —— 根因是 Node 的内置 fetch 默认不读系统代理。
// 这里锁住三件事：代理解析、启动脚本环境变量、451 的可读报错与失败归类。

test("出站代理：环境变量优先于系统代理，系统代理支持 host:port / http=..;https=.. 两种写法", () => {
  assert.equal(parseProxyServer("127.0.0.1:7897"), "http://127.0.0.1:7897");
  assert.equal(parseProxyServer("http=10.0.0.1:8080;https=10.0.0.2:8443"), "http://10.0.0.2:8443");
  assert.equal(parseProxyServer("socks=127.0.0.1:1080"), "http://127.0.0.1:1080");
  assert.equal(parseProxyServer(""), "");

  const fromEnv = resolveOutboundProxy({ env: { HTTPS_PROXY: "http://127.0.0.1:7897" }, registry: { ProxyEnable: "0x1", ProxyServer: "10.9.9.9:1" } });
  assert.equal(fromEnv.url, "http://127.0.0.1:7897");
  assert.equal(fromEnv.source, "env:HTTPS_PROXY");

  const fromRegistry = resolveOutboundProxy({ env: {}, registry: { ProxyEnable: "0x1", ProxyServer: "127.0.0.1:7897", ProxyOverride: "localhost;127.*;<local>" } });
  assert.equal(fromRegistry.url, "http://127.0.0.1:7897");
  assert.equal(fromRegistry.source, "windows-registry");
  // ProxyEnable=0 时不得使用系统代理
  assert.equal(resolveOutboundProxy({ env: {}, registry: { ProxyEnable: "0x0", ProxyServer: "127.0.0.1:7897" } }).url, "");
  // PAC 自动配置无法求值：如实报告，不猜地址
  const pac = resolveOutboundProxy({ env: {}, registry: { AutoConfigURL: "http://x/proxy.pac" } });
  assert.equal(pac.url, "");
  assert.equal(pac.source, "windows-pac-unsupported");
});

test("出站代理：只有「启动时带 NODE_USE_ENV_PROXY=1」才算真的生效，否则必须给出可执行的重启提示", () => {
  // 只有系统代理 → Node 不会用（就是 451 的现场）
  const systemOnly = outboundProxyStatus({ env: {}, registry: { ProxyEnable: "0x1", ProxyServer: "127.0.0.1:7897" } });
  assert.equal(systemOnly.active, false);
  assert.equal(systemOnly.mode, "system_only");
  assert.match(systemOnly.hint, /NODE_USE_ENV_PROXY=1/);

  // 设了代理地址但没设开关 → 同样没生效，如实说清
  const inactive = outboundProxyStatus({ env: { HTTPS_PROXY: "http://127.0.0.1:7897" }, registry: {} });
  assert.equal(inactive.active, false);
  assert.equal(inactive.mode, "env_present_but_inactive");

  // 开关 + 地址 → 生效
  const active = outboundProxyStatus({ env: { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:7897" }, registry: {} });
  assert.equal(active.active, true);
  assert.equal(active.mode, "env_active");
  assert.equal(active.hint, "");

  // 什么都没配 → 不提示、不制造噪音
  const none = outboundProxyStatus({ env: {}, registry: {} });
  assert.equal(none.active, false);
  assert.equal(none.mode, "none");
  assert.equal(none.url, "");
});

test("出站代理：本机地址必须排除在代理之外，代理地址对外抹掉凭据", () => {
  const bypass = normalizeBypassList("localhost;127.*;<local>");
  assert.equal(bypass.includes("<local>"), false);
  [":", "localhost", "127.0.0.1"].forEach(() => {});
  LOCAL_BYPASS.split(",").forEach((item) => assert.equal(bypass.includes(item), true));
  assert.match(bypass, /localhost/);
  assert.equal(normalizeBypassList("").includes("127.0.0.1"), true);
  assert.equal(redactProxyUrl("http://user:secret@127.0.0.1:7897"), "http://127.0.0.1:7897");
  assert.equal(redactProxyUrl("http://127.0.0.1:7897"), "http://127.0.0.1:7897");
});

test("出站代理：/health 只报事实（是否在走代理、走的哪个、没走时怎么重启）", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await fetch(`http://127.0.0.1:${server.address().port}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(typeof health.outboundProxy, "object");
  assert.equal(typeof health.outboundProxy.active, "boolean");
  assert.equal(typeof health.outboundProxy.mode, "string");
  // 凭据不得出现在公开端点上
  if (health.outboundProxy.url) assert.doesNotMatch(health.outboundProxy.url, /:\/\/[^@/]*@/);
});

test("上游 451（地区限制）报成可读原因，并归到可重跑的网络类；其余 HTTP 错误口径不变", async (context) => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    const url = new URL(request.url, "http://127.0.0.1");
    const key = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    // 同一个上游：k-451 命中地区限制，其它 key 按普通鉴权失败处理。
    const regionBlocked = key === "k-451";
    if (url.pathname.endsWith("/models")) {
      if (regionBlocked) {
        response.writeHead(451, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ title: "Typesafe is not available in your region.", status: 451 }));
        return;
      }
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid api key" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamPort = upstream.address().port;

  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, data: await response.json() }));

  // 451 走 /models：错误码独立、附上游原话，不再只是「HTTP 451」
  const blocked = await post("/api/admin/ai/models", {
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: "k-451",
    protocol: "openai_chat_completions",
  });
  assert.equal(blocked.status, 502);
  assert.match(blocked.data.error, /^provider_region_blocked:/);
  assert.match(blocked.data.error, /Typesafe is not available in your region/);

  // 普通 401 仍是 provider_http_error（口径不变）
  const unauthorized = await post("/api/admin/ai/models", {
    baseUrl: `http://127.0.0.1:${upstreamPort}/completions`,
    apiKey: "k-401",
    protocol: "openai_chat_completions",
  });
  assert.equal(unauthorized.status, 502);
  assert.match(unauthorized.data.error, /^provider_http_error:/);
  assert.match(unauthorized.data.error, /invalid api key/);

  // 失败归类：451 记为 network（可自动重跑），不是 unknown
  const { classifyError } = require("../apps/api/src/ai-task-store");
  assert.equal(classifyError(blocked.data.error), "network");
  assert.equal(classifyError(unauthorized.data.error), "upstream_http");

  void ADMIN_USERNAME;
  void ADMIN_PASSWORD;
});
