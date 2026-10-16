"use strict";

// 启动脚本用的代理环境变量生成器：把 Windows 系统代理翻译成 `set XXX=YYY` 行，
// 由 start-server.cmd 用 for /f 直接执行（保证与 apps/api/src/outbound-proxy.js 同一套解析逻辑）。
// 用法：node scripts/tools/print-proxy-env.js
const { resolveOutboundProxy } = require("../../apps/api/src/outbound-proxy");

const resolved = resolveOutboundProxy();
if (!resolved.url) {
  process.stdout.write("echo [proxy] no system proxy detected; Node will connect directly\r\n");
  process.exit(0);
}
process.stdout.write(`set NODE_USE_ENV_PROXY=1\r\n`);
process.stdout.write(`set HTTPS_PROXY=${resolved.url}\r\n`);
process.stdout.write(`set HTTP_PROXY=${resolved.url}\r\n`);
process.stdout.write(`set NO_PROXY=${resolved.noProxy}\r\n`);
process.stdout.write(`echo [proxy] outbound requests go through ${resolved.url} (${resolved.source})\r\n`);
