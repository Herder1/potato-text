const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("mini program always enters on the review home page", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram");
  const config = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  const tabBarScript = fs.readFileSync(path.join(root, "custom-tab-bar/index.js"), "utf8");

  assert.equal(config.entryPagePath, "pages/review/review");
  assert.equal(config.restartStrategy, "homePage");
  assert.equal(config.pages[0], "pages/review/review");
  assert.equal(config.window.navigationBarTitleText, "薯考");
  assert.deepEqual(config.tabBar.list.map((item) => item.text), ["题库", "知识库", "复习", "发现", "我的"]);
  assert.match(tabBarScript, /selected:\s*2/);
});
