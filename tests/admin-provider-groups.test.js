const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("供应商支持逐项勾选、至少两项归组和清空选择", () => {
  assert.match(html, /id="provider-selection-tools" hidden/);
  assert.match(html, /id="group-selected-providers"[^>]*disabled/);
  assert.match(js, /data-select-provider=/);
  assert.match(js, /count < 2/);
  assert.match(js, /selectedProviderIds\.clear\(\)/);
});

test("分组只保存浏览器展示状态，保留独立供应商操作", () => {
  assert.match(js, /localStorage\?\.setItem\(PROVIDER_GROUP_STORAGE_KEY/);
  assert.match(js, /data-group-action="toggle"/);
  assert.match(js, /data-group-action="dissolve"/);
  assert.match(js, /data-action="test"/);
  assert.match(js, /data-action="edit"/);
  assert.match(js, /data-action="delete"/);
  assert.match(css, /\.provider-group-members\[hidden\]\s*\{\s*display: none;/);
});
