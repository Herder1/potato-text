const assert = require("node:assert/strict");
const test = require("node:test");

test("help search finds questions by title, category and answer", () => {
  global.Page = () => {};
  const modulePath = require.resolve("../apps/miniprogram/pages/help-feedback/help-feedback.js");
  delete require.cache[modulePath];
  const { FAQS, filterFaqs } = require(modulePath);
  delete global.Page;

  assert.equal(filterFaqs(FAQS, "AI 额度").length >= 1, true);
  assert.equal(filterFaqs(FAQS, "跨设备").some((item) => item.id === "data-sync"), true);
  assert.equal(filterFaqs(FAQS, "完全不存在的帮助内容").length, 0);
});

test("profile help menu opens the completed feedback page", () => {
  let definition;
  global.Page = (value) => { definition = value; };
  const modulePath = require.resolve("../apps/miniprogram/pages/profile/profile.js");
  delete require.cache[modulePath];
  require(modulePath);
  const calls = [];
  global.wx = { navigateTo: (value) => calls.push(value), showToast: () => {} };
  definition.openMenu({ currentTarget: { dataset: { name: "帮助与反馈" } } });
  assert.deepEqual(calls, [{ url: "/pages/help-feedback/help-feedback" }]);
  delete global.Page;
  delete global.wx;
});

test("profile moves notifications from the service list to a top-left bell", () => {
  let definition;
  const storage = new Map([["shukao_unread_notification_count", 2]]);
  global.Page = (value) => { definition = value; };
  const modulePath = require.resolve("../apps/miniprogram/pages/profile/profile.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch) { Object.assign(this.data, patch); };
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    showToast() {},
  };

  assert.equal(page.data.menu.includes("消息通知"), false);
  page.setData({ unreadNotificationCount: 2 });
  page.openNotifications();
  assert.equal(page.data.unreadNotificationCount, 0);
  assert.equal(storage.get("shukao_unread_notification_count"), 0);

  const fs = require("node:fs");
  const path = require("node:path");
  const markup = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/profile/profile.wxml"), "utf8");
  assert.match(markup, /class="profile-topbar">[\s\S]*class="profile-notification-button"[^>]*bindtap="openNotifications"[\s\S]*data-name="设置"/);
  assert.match(markup, /assets\/icons\/bell\.svg/);

  delete global.Page;
  delete global.wx;
});
