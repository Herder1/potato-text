const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

test("feedback notification link puts the matching record first and ignores responses after account changes", (t) => {
  let page;
  let request;
  const toasts = [];
  const data = { loggedIn: true, apiBaseUrl: "http://test", authToken: "alice" };
  global.getApp = () => ({ globalData: data });
  global.Page = (definition) => { page = definition; };
  global.wx = { getStorageSync: () => "", request: (options) => { request = options; }, showToast: (options) => toasts.push(options) };
  t.after(() => { delete global.getApp; delete global.Page; delete global.wx; });
  const modulePath = require.resolve("../apps/miniprogram/pages/help-feedback/help-feedback.js");
  delete require.cache[modulePath];
  require(modulePath);
  page.setData = (values) => Object.assign(page.data, values);
  page.onLoad({ tab: "history", feedbackId: "target" });
  page.onShow();
  request.success({ statusCode: 200, data: { items: [
    { id: "other", status: "pending", createdAt: 1 },
    { id: "target", status: "resolved", createdAt: 2 },
  ] } });
  request.complete();
  assert.equal(page.data.feedbackItems[0].id, "target");
  page.loadHistory();
  const old = request;
  data.authToken = "bob";
  page.onShow();
  old.success({ statusCode: 200, data: { items: [{ id: "alice-secret" }] } });
  assert.deepEqual(page.data.feedbackItems, []);
  request.success({ statusCode: 500, data: {} });
  request.complete();
  assert.match(page.data.historyError, /加载失败/);
  page.loadHistory();
  request.success({ statusCode: 200, data: { items: [] } });
  request.complete();
  assert.equal(toasts[0].title, "该反馈记录已不可用");
});

test("帮助中心底部是微信原生客服入口（按参考图外观），自定义反馈入口保持可用", () => {
  const root = path.join(__dirname, "../apps/miniprogram/pages/help-feedback");
  const markup = fs.readFileSync(path.join(root, "help-feedback.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "help-feedback.wxss"), "utf8");

  // 客服入口：必须是原生 button + open-type="contact"（微信现成客服会话），而且它只做透明点击层
  assert.match(markup, /<button class="contact-hit"[^>]*open-type="contact"/);
  assert.match(styles, /\.contact-hit\s*\{[^}]*position:\s*absolute\s*!important/);
  assert.match(styles, /\.contact-hit\s*\{[^}]*opacity:\s*0/);
  // 两次真机教训的守卫：卡片必须是普通 view、不能让 button 参与布局、行内布局不能靠 flex
  assert.match(markup, /<view class="contact-card">[\s\S]{0,900}?<button class="contact-hit"/);
  assert.doesNotMatch(markup, /<button[^>]*class="contact-card"/);
  assert.doesNotMatch(styles, /\.contact-card\s*\{[^}]*display:\s*flex/);
  assert.match(styles, /\.contact-card\s*\{[^}]*padding:\s*20rpx 68rpx 20rpx 128rpx/);
  assert.match(styles, /\.contact-icon\s*\{[^}]*position:\s*absolute/);
  assert.match(styles, /\.contact-card \.entry-arrow\s*\{[^}]*position:\s*absolute/);
  // 参考图的构成要素：图标资源 + 两枚背景装饰圆 + 箭头 + 标题/副标题
  assert.match(markup, /<view class="contact-icon">[\s\S]*assets\/icons\/customer-service\.svg/);
  assert.match(markup, /class="contact-icon-img"/);
  assert.match(markup, /class="contact-blob contact-blob-top"/);
  assert.match(markup, /class="contact-blob contact-blob-bottom"/);
  assert.match(markup, /<view class="entry-arrow"><\/view>/);
  assert.match(markup, /<view class="contact-title">在线客服<\/view>/);
  assert.match(markup, /<view class="contact-subtitle">有任何问题，请联系我们的在线客服<\/view>/);
  // 旧的深色「仍未解决」块及其类已彻底撤掉
  assert.doesNotMatch(markup, /仍未解决/);
  assert.doesNotMatch(markup, /class="feedback-entry/);
  assert.doesNotMatch(styles, /\.feedback-entry/);
  // 卡片配色＝「我的」页顶部那条渐变（产品负责人 2026-10-01 指定）：跨文件取值必须一致，改了「我的」页这里也要跟着动
  const profileStyles = fs.readFileSync(path.join(root, "../profile/profile.wxss"), "utf8");
  assert.match(profileStyles, /linear-gradient\(150deg, #e6f7f1 0%, #f4f6f2 42%, #fbeedd 72%, #f7f7f5 100%\)/, "「我的」页顶部渐变应存在（客服卡配色的来源）");
  assert.match(styles, /\.contact-card\s*\{[^}]*background-image:\s*linear-gradient\(150deg, #e6f7f1 0%, #f4f6f2 42%, #fbeedd 72%, #f7f7f5 100%\)/);
  assert.match(styles, /\.contact-card\s*\{[^}]*background:\s*#e9f7f2/);
  // 卡片要更矮（原来是 152rpx）
  assert.match(styles, /\.contact-card\s*\{[^}]*min-height:\s*124rpx/);
  assert.doesNotMatch(styles, /\.contact-card\s*\{[^}]*min-height:\s*152rpx/);
  assert.doesNotMatch(styles, /radial-gradient/);
  // 图标块＝浅薄荷（绿），耳机线条＝暖黄（产品负责人 2026-10-02 最终口径：块=绿、线条=黄）
  const iconSvg = fs.readFileSync(path.join(root, "../../assets/icons/customer-service.svg"), "utf8");
  assert.match(styles, /\.contact-icon\s*\{[^}]*background:\s*#cbe8dc/);
  assert.match(styles, /\.contact-icon\s*\{[^}]*background-image:\s*linear-gradient\(160deg, #d8f0e6 0%, #bfe2d3 100%\)/);
  // 图标块＝浅薄荷（绿）不变；耳机线条＝蜜桃粉橘（产品负责人 2026-10-02 从 A/B/C 里选的 B）
  assert.match(iconSvg, /stroke="#f6d2b0"/);
  assert.match(iconSvg, /fill="#fdeee0"/);
  assert.doesNotMatch(iconSvg, /#c99a2a|#e9c85f/, "线条不应回退成偏深的黄或上一版浅黄");
  assert.doesNotMatch(styles, /#ffd3e4|#ffdcec|#ffc4da|#ff5b93|#ffe3ee/, "客服卡片相关样式里不应再出现粉色");
  assert.doesNotMatch(iconSvg, /#ff5b93|#ffe3ee|#2f8f74/, "耳机图标不应再出现玫瑰色或旧薄荷线条色");
  // 反馈输入框的占位文案与短内容提示必须写明字数门槛（口径：不少于五个字）
  assert.match(markup, /placeholder="请说明发生了什么、如何操作可以复现（不少于五个字才能提交）"/);
  const script = fs.readFileSync(path.join(root, "help-feedback.js"), "utf8");
  assert.match(script, /if \(content\.length < 5\) \{ wx\.showToast\(\{ title: "不少于五个字才能提交"/);
  assert.doesNotMatch(script, /title: "请具体描述遇到的问题"/, "旧的短内容提示不应再出现");
  // 其他卡片一并改圆（20rpx 档）
  assert.match(styles, /\.help-tabs\s*\{[^}]*border-radius:\s*20rpx/);
  assert.match(styles, /\.help-search\s*\{[^}]*border-radius:\s*20rpx/);
  assert.match(styles, /\.faq-list,\s*\.feedback-form,\s*\.feedback-history\s*\{[^}]*border-radius:\s*20rpx/);
  assert.match(styles, /\.login-notice\s*\{[^}]*border-radius:\s*20rpx/);
  assert.match(styles, /\.history-empty\s*\{[^}]*border-radius:\s*20rpx/);
  // 自定义反馈流程不动：标签与空态入口都还在
  assert.match(markup, /wx:if="\{\{activeTab === 'submit'\}\}"/);
  assert.match(markup, /class="submit-button"[^>]*bindtap="submitFeedback"/);
  assert.match(markup, /bindtap="openSubmit"/);
  assert.match(markup, /class="feedback-thread" wx:if="\{\{item\.messages\.length\}\}"/);
  assert.match(markup, /class="feedback-reply" wx:if="\{\{item\.canReply\}\}"/);
  assert.match(markup, /bindtap="submitReply"/);
  assert.match(script, /\/api\/feedback\/\$\{encodeURIComponent\(item\.id\)\}\/replies/);
  assert.match(script, /clientMessageId/);
});

test("help search finds questions by title, category and answer", () => {
  global.Page = () => {};
  const modulePath = require.resolve("../apps/miniprogram/pages/help-feedback/help-feedback.js");
  delete require.cache[modulePath];
  const { FAQS, filterFaqs } = require(modulePath);
  delete global.Page;

  assert.equal(filterFaqs(FAQS, "豆币").some((item) => item.id === "bean-cost"), true);
  assert.equal(filterFaqs(FAQS, "豆币")[0].answer.includes("0.1 豆币"), true);
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
    navigateTo: (value) => storage.set("__navigate", value),
  };

  assert.equal(page.data.menu.includes("消息通知"), false);
  page.setData({ unreadNotificationCount: 2 });
  page.openNotifications();
  // 04:9x：铃铛改成"消息中心"页入口——点一下不再把未读清零（清零/已读交给消息中心页自己按条记）
  assert.deepEqual(storage.get("__navigate"), { url: "/pages/messages/messages" });
  assert.equal(page.data.unreadNotificationCount, 2);
  assert.equal(storage.get("shukao_unread_notification_count"), 2);

  const fs = require("node:fs");
  const path = require("node:path");
  const markup = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/profile/profile.wxml"), "utf8");
  assert.match(markup, /class="profile-topbar">[\s\S]*class="profile-notification-button"[^>]*bindtap="openNotifications"[\s\S]*bindtap="openSettings"/);
  assert.match(markup, /assets\/icons\/bell\.svg/);

  delete global.Page;
  delete global.wx;
});
