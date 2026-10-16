/**
 * 消息中心（产品负责人 2026-09-23 04:9x：「做一个消息中心页面，效果图是图2，入口在绿框图3」）
 * 覆盖：① 纯函数（分组/日期标签/未读口径/已读持久化/接口回落）② 静态契约（页面注册、入口接线、
 * 显隐一律 wx:if、色值对比度）③ 入口页（我的页铃铛）接线没被改坏。
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const utilPath = require.resolve("../apps/miniprogram/utils/message-center.js");

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, "..", ...parts), "utf8");

/** 起一个假的 wx/getApp 环境后加载 util（每次都要清缓存，因为模块级常量/已读缓存） */
function loadUtil({ storage = new Map(), request } = {}) {
  delete require.cache[utilPath];
  global.wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
    setStorageSync: (key, value) => storage.set(key, value),
  };
  if (request) global.wx.request = request;
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://127.0.0.1:3212" } });
  const util = require(utilPath);
  return { util, storage };
}

const cleanup = () => {
  delete global.wx;
  delete global.getApp;
};

const AT = new Date("2026-09-23T11:00:00+08:00").getTime();
const at = (iso) => Date.parse(iso);

test("消息中心：公告 → 消息（标题/摘要/正文/类型标签/可展开），字段缺失有兜底", () => {
  const { util } = loadUtil();
  const message = util.normalizeMessage({
    id: "ai-grading-update", type: "功能更新", title: "主观题评分体验优化",
    summary: "摘要一句", content: "正文第一段\n\n正文第二段",
    publishedAt: at("2026-09-23T04:02:00+08:00"),
  });
  assert.deepEqual(message, {
    id: "ai-grading-update",
    type: "功能更新",
    tag: "#功能更新",
    title: "主观题评分体验优化",
    summary: "摘要一句",
    content: "正文第一段\n\n正文第二段",
    expandable: true,
    publishedAt: at("2026-09-23T04:02:00+08:00"),
    time: "04:02",
  });

  // 摘要与正文一致（或没有正文）就不给"点击查看"这个动作
  const flat = util.normalizeMessage({ id: "x", title: "只有摘要", summary: "同一句", content: "同一句" });
  assert.equal(flat.expandable, false);
  assert.equal(flat.tag, "");
  const bare = util.normalizeMessage({});
  assert.equal(bare.title, "未命名公告");
  assert.equal(bare.id, "message-0");
  assert.equal(bare.publishedAt, 0);
  assert.equal(bare.expandable, false);
  cleanup();
});

test("消息中心：按天分组——今天/昨天/M月D日/跨年，天与消息都是新的在前", () => {
  const { util } = loadUtil();
  const list = [
    { id: "a", publishedAt: at("2026-09-23T04:08:00+08:00") },
    { id: "b", publishedAt: at("2026-09-23T04:02:00+08:00") },
    { id: "c", publishedAt: at("2026-09-22T21:30:00+08:00") },
    { id: "d", publishedAt: at("2026-09-20T09:00:00+08:00") },
    { id: "e", publishedAt: at("2025-12-31T23:00:00+08:00") },
  ];
  const groups = util.groupMessagesByDay(list, AT);
  assert.deepEqual(groups.map((group) => group.label), ["今天", "昨天", "9月20日", "2025年12月31日"]);
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.id)), [["a", "b"], ["c"], ["d"], ["e"]]);

  // 边界：跨天按本地 00:00 切；空数组给空分组（页面据此走空态）
  assert.equal(util.dayLabel(at("2026-09-22T00:00:00+08:00"), AT), "昨天");
  assert.equal(util.dayLabel(at("2026-09-21T23:59:00+08:00"), AT), "9月21日");
  assert.deepEqual(util.groupMessagesByDay([], AT), []);
  assert.deepEqual(util.groupMessagesByDay(null, AT), []);
  cleanup();
});

test("消息中心：未读＝没进过本地已读表；点开一条即已读且写回我的页铃铛用的键", () => {
  const { util, storage } = loadUtil();
  const messages = [
    util.normalizeMessage({ id: "a", title: "A", summary: "s", publishedAt: at("2026-09-23T04:00:00+08:00") }),
    util.normalizeMessage({ id: "b", title: "B", summary: "s", publishedAt: at("2026-09-22T04:00:00+08:00") }),
  ];
  assert.equal(util.unreadCount(messages), 2);
  assert.equal(storage.get(util.MESSAGE_READ_KEY), undefined);

  const groups = util.buildMessageGroups(messages, AT);
  assert.deepEqual(groups.map((g) => g.items.map((i) => [i.id, i.unread, i.expanded])), [[["a", true, false]], [["b", true, false]]]);

  // 幂等：重复标记同一条不会写两遍
  util.markMessageRead("a");
  util.markMessageRead("a");
  assert.deepEqual(storage.get(util.MESSAGE_READ_KEY), ["a"]);
  assert.equal(util.unreadCount(messages), 1);
  assert.equal(storage.get(util.MESSAGE_UNREAD_COUNT_KEY), undefined);

  // syncUnreadBadge 把未读数写回 profile 页读的那个键
  assert.equal(util.syncUnreadBadge(messages) instanceof Promise, true);
  cleanup();
});

test("消息中心：接口可用时取接口、不可用/非 2xx/空列表一律回落内置公告（永不 reject）", async () => {
  // 没有 wx.request / 没有 apiBaseUrl
  const noRequest = loadUtil();
  const fallback = await noRequest.util.loadMessages();
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(fallback.messages.map((m) => m.id), ["internal-benefit", "ai-grading-update", "feedback"]);
  fallback.messages.forEach((m) => assert.ok(m.title && m.summary));
  cleanup();

  // 200 + announcements → 用接口数据
  const ok = loadUtil({
    request: (options) => options.success({ statusCode: 200, data: { announcements: [{ id: "x", type: "功能更新", title: "接口来的", summary: "s", content: "c" }] } }),
  });
  const fromApi = await ok.util.loadMessages();
  assert.equal(fromApi.source, "api");
  assert.deepEqual(fromApi.messages.map((m) => m.id), ["x"]);
  cleanup();

  // 500 / 空列表 → 回落
  for (const response of [{ statusCode: 500, data: {} }, { statusCode: 200, data: { announcements: [] } }]) {
    const bad = loadUtil({ request: (options) => options.success(response) });
    const result = await bad.util.loadMessages();
    assert.equal(result.source, "fallback");
    assert.equal(result.messages.length, 3);
    cleanup();
  }

  // 请求失败（离线）→ 回落
  const offline = loadUtil({ request: (options) => options.fail({ errMsg: "request:fail" }) });
  const result = await offline.util.loadMessages();
  assert.equal(result.source, "fallback");
  cleanup();

  // 存储不可用（getStorageSync 抛）也不能把页面带崩
  const broken = loadUtil();
  global.wx.getStorageSync = () => { throw new Error("boom"); };
  assert.equal(broken.util.readMessageIds().size, 0);
  assert.equal(broken.util.unreadCount(broken.util.DEFAULT_MESSAGES), 3);
  cleanup();
});

test("消息中心：页面注册、导航标题、显隐一律 wx:if、入口接线（我的页铃铛）", () => {
  const appJson = JSON.parse(read("apps/miniprogram/app.json"));
  assert.ok(appJson.pages.includes("pages/messages/messages"), "app.json 必须注册消息中心页");
  const pageJson = JSON.parse(read("apps/miniprogram/pages/messages/messages.json"));
  assert.equal(pageJson.navigationBarTitleText, "消息中心");

  const markup = read("apps/miniprogram/pages/messages/messages.wxml");
  // 未读圆点：该显示时显示、已读时不进渲染树（小程序显隐一律 wx:if）
  assert.match(markup, /<view class="message-dot" wx:if="\{\{message\.unread\}\}"><\/view>/);
  assert.doesNotMatch(markup, /hidden=/);
  assert.match(markup, /<view class="message-group-label">\{\{item\.label\}\}<\/view>/);
  assert.match(markup, /data-message-id="\{\{message\.id\}\}" bindtap="toggleMessage"/);
  assert.match(markup, /class="message-content" wx:if="\{\{message\.expanded && message\.expandable\}\}"/);
  assert.match(markup, /class="message-tag" wx:if="\{\{message\.tag\}\}">\{\{message\.tag\}\}/);
  assert.match(markup, /class="message-action" wx:if="\{\{message\.expandable\}\}">\{\{message\.expanded \? '收起' : '点击查看 ››'\}\}/);
  // 空态与列表互斥（wx:else），空态有标题与说明
  assert.match(markup, /<view class="message-empty" wx:else>[\s\S]*?<view>暂无消息<\/view>[\s\S]*?<\/view>/);
  assert.match(markup, /wx:for="\{\{groups\}\}" wx:key="key"/);
  assert.match(markup, /wx:for="\{\{item\.items\}\}" wx:for-item="message" wx:key="id"/);

  const script = read("apps/miniprogram/pages/messages/messages.js");
  // 展开才算已读：收起时不许顺手标已读
  assert.match(script, /if \(expandedId\) markMessageRead\(id\);/);
  assert.match(script, /syncUnreadBadge\(this\.messages\)/);
  assert.match(script, /onPullDownRefresh\(\) \{[\s\S]{0,120}stopPullDownRefresh/);

  const profileWxml = read("apps/miniprogram/pages/profile/profile.wxml");
  assert.match(profileWxml, /class="profile-notification-button" bindtap="openNotifications" role="button" aria-label="消息通知"/);
  assert.match(profileWxml, /notification-dot" wx:if="\{\{unreadNotificationCount > 0\}\}"/);
  assert.match(profileWxml, /assets\/icons\/bell\.svg/);
  const profileScript = read("apps/miniprogram/pages/profile/profile.js");
  assert.match(profileScript, /openNotifications\(\) \{\s*wx\.navigateTo\(\{ url: "\/pages\/messages\/messages" \}\);/);
  assert.match(profileScript, /unreadNotificationCount: Math\.max\(0, Number\(wx\.getStorageSync\("shukao_unread_notification_count"\)\) \|\| 0\)/);
});

test("消息中心：样式——未读橙点（效果图 #fe6900）、分组标题居中、白卡、标签与「点击查看」的颜色对比度", () => {
  const style = read("apps/miniprogram/pages/messages/messages.wxss");
  const dot = style.match(/\.message-dot \{[^}]*\}/)[0];
  // 效果图是 #fe6900，压页面底色只有 2.68:1 → 取深一档 #f25c00（3.07:1，非文本 ≥3）
  assert.match(dot, /background: #f25c00;/);
  assert.match(dot, /border-radius: 50%;/);
  assert.match(dot, /width: 12rpx;/);
  assert.match(style, /\.message-group-label \{[^}]*text-align: center;/);
  assert.match(style, /\.message-card \{[^}]*background: #fff;/);
  assert.match(style, /\.message-card \{[^}]*border-radius: 20rpx;/);
  assert.match(style, /\.message-content \{[^}]*white-space: pre-wrap;/);

  const hex = (value) => [1, 3, 5].map((i) => parseInt(value.substr(i, 2), 16));
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const x = lum(hex(a));
    const y = lum(hex(b));
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const colorOf = (selector) => style.match(new RegExp(`${selector} \\{([^}]*)\\}`))[1].match(/color: (#[0-9a-f]{6})/)[1];
  // 卡片底是纯白
  assert.ok(contrast("#202522", "#ffffff") >= 4.5, "标题要 ≥4.5");
  assert.ok(contrast(colorOf(".message-body"), "#ffffff") >= 4.5, "正文要 ≥4.5");
  assert.ok(contrast(colorOf(".message-tag"), "#ffffff") >= 4.5, "「#类型」标签要 ≥4.5");
  assert.ok(contrast(colorOf(".message-action"), "#ffffff") >= 4.5, "「点击查看」要 ≥4.5");
  // 未读橙点是非文本元素，压在页面底色上要 ≥3
  assert.ok(contrast("#f25c00", "#f5f6f5") >= 3, `未读点对比度不足：${contrast("#f25c00", "#f5f6f5")}`);
});

test("personal feedback notifications merge with announcements, carry auth and become read on opening", async (t) => {
  t.after(cleanup);
  const calls = [];
  const { util, storage } = loadUtil({ request: (options) => {
    calls.push(options);
    options.success({ statusCode: 200, data: options.url.endsWith("/api/messages")
      ? { messages: [{ id: "feedback:r:take:2", feedbackId: "r", title: "反馈已领取", summary: "正在处理", content: "反馈内容", publishedAt: 2 }] }
      : { announcements: [{ id: "announcement", publishedAt: 1 }] } });
  } });
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://test", authToken: "alice", userId: "alice" } });
  const result = await util.loadMessages();
  assert.deepEqual(result.messages.map((item) => item.id), ["feedback:r:take:2", "announcement"]);
  assert.equal(calls.find((call) => call.url.endsWith("/api/messages")).header.Authorization, "Bearer alice");
  assert.equal(calls.find((call) => call.url.endsWith("/api/announcements")).header, undefined);
  assert.equal(result.messages[0].feedbackId, "r");
  util.markMessageRead(result.messages[0].id);
  await util.syncUnreadBadge(result.messages);
  assert.equal(storage.get(util.MESSAGE_UNREAD_COUNT_KEY), 1);
});

test("personal request failures remain visible and do not clear a known unread badge", async (t) => {
  t.after(cleanup);
  for (const statusCode of [401, 500, 200]) {
    const { util, storage } = loadUtil({ request: (options) => options.success({ statusCode, data: {} }) });
    global.getApp = () => ({ globalData: { apiBaseUrl: "http://test", authToken: "alice" } });
    storage.set(util.MESSAGE_UNREAD_COUNT_KEY, 9);
    assert.match((await util.loadMessages()).error, /反馈通知加载失败/);
    assert.equal(await util.syncUnreadBadge(), null);
    assert.equal(storage.get(util.MESSAGE_UNREAD_COUNT_KEY), 9);
  }
});

test("logout or switching accounts discards in-flight private notifications and badge updates", async (t) => {
  t.after(cleanup);
  const requests = [];
  const { util, storage } = loadUtil({ request: (options) => requests.push(options) });
  const data = { apiBaseUrl: "http://test", authToken: "alice", accountLifecycleGeneration: 1 };
  global.getApp = () => ({ globalData: data });
  const pending = util.syncUnreadBadge();
  data.authToken = "bob";
  data.accountLifecycleGeneration++;
  for (const request of requests) request.success({ statusCode: 200, data: {
    messages: [{ id: "alice-private", content: "secret" }], announcements: [{ id: "a" }],
  } });
  assert.equal(await pending, null);
  assert.equal(storage.get(util.MESSAGE_UNREAD_COUNT_KEY), undefined);
});

test("message page refreshes on return, marks feedback read and opens its exact history record", async (t) => {
  t.after(() => { cleanup(); delete global.Page; });
  const { util } = loadUtil({ request: (options) => options.success({ statusCode: 200, data:
    options.url.endsWith("/api/messages") ? { messages: [{ id: "f1", feedbackId: "report/one", title: "反馈已领取", publishedAt: 20 }] }
      : { announcements: [{ id: "a", publishedAt: 1 }] },
  }) });
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://test", authToken: "alice" } });
  let page;
  global.Page = (definition) => { page = definition; };
  const pagePath = require.resolve("../apps/miniprogram/pages/messages/messages");
  delete require.cache[pagePath];
  require(pagePath);
  page.setData = (values, callback) => { Object.assign(page.data, values); if (callback) callback(); };
  page.onLoad();
  await page.onShow();
  assert.equal(page.data.unread, 2);
  page.toggleMessage({ currentTarget: { dataset: { messageId: "f1" } } });
  assert.equal(page.data.unread, 1);
  let url;
  global.wx.navigateTo = (options) => { url = options.url; };
  page.openFeedback({ currentTarget: { dataset: { messageId: "f1" } } });
  assert.equal(url, "/pages/help-feedback/help-feedback?tab=history&feedbackId=report%2Fone");
  await page.onShow();
  assert.equal(page.data.unread, 1);
  assert.ok(util.readMessageIds().has("f1"));
});

test("message page error and feedback link use explicit conditions, profile refresh is not once per process", () => {
  const markup = read("apps/miniprogram/pages/messages/messages.wxml");
  assert.match(markup, /wx:if="\{\{loadError\}\}"/);
  assert.match(markup, /wx:if="\{\{message.feedbackId\}\}"[^>]+catchtap="openFeedback"/);
  const profile = read("apps/miniprogram/pages/profile/profile.js");
  assert.doesNotMatch(profile, /unreadBadgeSynced/);
  assert.match(profile, /session === messageSession\(\)/);
});
