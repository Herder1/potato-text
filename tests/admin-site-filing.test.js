const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const adminRoot = path.resolve(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(adminRoot, "index.html"), "utf8");
const css = fs.readFileSync(path.join(adminRoot, "styles.css"), "utf8");

test("管理网页底部展示指定 ICP 备案号并链接工信部", () => {
  assert.match(
    html,
    /<\/main>\s*<footer class="site-filing">\s*<a href="https:\/\/beian\.miit\.gov\.cn\/" target="_blank" rel="noopener noreferrer">粤ICP备2026146542号<\/a>\s*<\/footer>/
  );
  assert.equal((html.match(/粤ICP备2026146542号/g) || []).length, 1);
  assert.doesNotMatch(html, /粤ICP备2026146542号-2/);
});

test("未登录的登录页也保留可见的备案链接", () => {
  assert.match(html, /<body class="admin-locked">/);
  assert.match(css, /body\.admin-locked \.main \{ visibility: hidden; \}/);
  assert.match(css, /body\.admin-locked \.site-filing\s*\{[^}]*position: fixed;[^}]*z-index: 4001;/);
  assert.match(css, /\.admin-login-gate\s*\{[^}]*z-index: 4000;/);
});
