/**
 * 消息中心（产品负责人 2026-09-23 04:9x：「做一个消息中心页面，效果图是图2，入口在绿框图3」）
 *
 * 公告来自 GET /api/announcements；登录后合并 GET /api/messages 的个人反馈通知。
 * 只有公告允许离线种子回落；个人通知失败要提示，不伪造通知。
 *
 * 已读状态＝本地，随 personal-cloud-sync 的账号工作区隔离，不跨设备同步。
 * 我的页铃铛上的小圆点沿用既有键 `shukao_unread_notification_count`（profile.js 读它，这里负责写）。
 */
const MESSAGE_READ_KEY = "shukao_message_read_ids";
const MESSAGE_UNREAD_COUNT_KEY = "shukao_unread_notification_count";

function messageSession() {
  try {
    const data = getApp().globalData || {};
    return JSON.stringify([data.apiBaseUrl || "", data.authToken || "", data.user?.id || data.userId || "", data.accountLifecycleGeneration || 0]);
  } catch (error) {
    return "";
  }
}

// 回落用种子：与 apps/api/src/announcement-store.js 的种子数据同源（文案一致，避免离线看到不一样的内容）
const DEFAULT_MESSAGES = [
  {
    id: "internal-benefit",
    type: "权益通知",
    title: "平台题库已开放",
    summary: "内部测试期间，平台题库已为测试用户开放",
    content: "内部测试期间，测试用户可使用已上线的平台题库。正式订阅与支付功能将在后续阶段接入，现阶段不会产生订阅费用。\n\nAI 解析与评分消耗豆币，当前豆币余额可在「豆币账户」中查看。",
    publishedAt: Date.parse("2026-08-01T09:00:00+08:00"),
  },
  {
    id: "ai-grading-update",
    type: "功能更新",
    title: "主观题评分体验优化",
    summary: "主观题评分速度与结果稳定性已完成优化",
    content: "主观题提交与 AI 评分现已分开。提交答案后可以先记录掌握状态，需要查看结构化评分时再主动发起评分。\n\n评分结果将继续展示命中得分点、遗漏得分点、错误内容和表达建议。",
    publishedAt: Date.parse("2026-08-01T09:00:00+08:00") - 1000,
  },
  {
    id: "feedback",
    type: "测试公告",
    title: "欢迎提交使用反馈",
    summary: "发现题目或功能问题，可通过帮助与反馈告诉我们",
    content: "如果发现题目答案、章节归类或页面功能存在问题，请通过“帮助与反馈”提交。清晰描述问题并附上截图，有助于更快定位和修正。",
    publishedAt: Date.parse("2026-08-01T09:00:00+08:00") - 2000,
  },
];

const pad2 = (value) => String(value).padStart(2, "0");

const toTimestamp = (value) => {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** 一条公告 → 消息中心一条消息（缺字段一律兜底，不让 WXML 拿到 undefined） */
function normalizeMessage(item, index = 0) {
  const source = item && typeof item === "object" ? item : {};
  const content = String(source.content || "").trim();
  const summary = String(source.summary || "").trim() || content;
  const type = String(source.type || "").trim();
  const publishedAt = toTimestamp(source.publishedAt || source.updatedAt || source.createdAt);
  const date = publishedAt ? new Date(publishedAt) : null;
  return {
    id: String(source.id || `message-${index}`),
    ...(source.feedbackId ? { feedbackId: String(source.feedbackId) } : {}),
    type,
    // 效果图里卡片右下角的「#新功能」＝公告的类型标签
    tag: type ? `#${type}` : "",
    title: String(source.title || "").trim() || "未命名公告",
    summary,
    content,
    // 摘要之外还有正文才值得点开（效果图第三张卡的「点击查看>>」就是这个动作）
    expandable: Boolean(content) && content !== summary,
    publishedAt,
    time: date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : "",
  };
}

const startOfDay = (timestamp) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** 分组标题：今天 / 昨天 / 9月20日 / 2025年9月20日（效果图里是居中的灰色小字） */
function dayLabel(timestamp, now) {
  const today = startOfDay(now);
  const day = startOfDay(timestamp);
  const diffDays = Math.round((today - day) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const base = `${date.getMonth() + 1}月${date.getDate()}日`;
  return sameYear ? base : `${date.getFullYear()}年${base}`;
}

/** 按天分组，天与消息都是新的在前（分组内保持接口给的优先级顺序） */
function groupMessagesByDay(messages, now = Date.now()) {
  const list = (Array.isArray(messages) ? messages : []).filter(Boolean);
  const buckets = new Map();
  for (const message of list) {
    const key = message.publishedAt ? startOfDay(message.publishedAt) : 0;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(message);
  }
  return [...buckets.keys()]
    .sort((left, right) => right - left)
    .map((key) => ({
      key: String(key),
      label: key ? dayLabel(key, now) : "更早",
      items: buckets.get(key),
    }));
}

/** 已读 id 集合（本地存储；写成数组，方便测试与排查） */
function readMessageIds() {
  try {
    const stored = wx.getStorageSync(MESSAGE_READ_KEY);
    const list = Array.isArray(stored) ? stored : [];
    return new Set(list.map((id) => String(id)));
  } catch (error) {
    return new Set();
  }
}

function writeReadMessageIds(ids) {
  const list = [...ids].map((id) => String(id));
  try {
    wx.setStorageSync(MESSAGE_READ_KEY, list);
  } catch (error) {
    // 存储不可用时只影响"已读"记忆，不影响页面本身
  }
  return list;
}

/** 标记一条已读，返回更新后的 id 数组（幂等） */
function markMessageRead(id) {
  const key = String(id || "");
  const ids = readMessageIds();
  if (key) ids.add(key);
  return writeReadMessageIds(ids);
}

/** 带上"未读"标记 + 分组，直接给页面 setData 用 */
function buildMessageGroups(messages, now = Date.now()) {
  const readIds = readMessageIds();
  const list = (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    unread: !readIds.has(String(message.id)),
    expanded: false,
  }));
  return groupMessagesByDay(list, now);
}

const unreadCount = (messages, readIds = readMessageIds()) =>
  (Array.isArray(messages) ? messages : []).filter((message) => !readIds.has(String(message.id))).length;

const flattenGroups = (groups) => (Array.isArray(groups) ? groups : []).reduce((all, group) => all.concat(group.items || []), []);

/** 公告读取保留原来的离线回落。 */
function loadAnnouncements() {
  const fallback = () => DEFAULT_MESSAGES.map((item, index) => normalizeMessage(item, index));
  return new Promise((resolve) => {
    let app = null;
    try {
      app = getApp();
    } catch (error) {
      app = null;
    }
    const baseUrl = app && app.globalData ? app.globalData.apiBaseUrl : "";
    if (typeof wx.request !== "function" || !baseUrl) {
      resolve({ messages: fallback(), source: "fallback" });
      return;
    }
    wx.request({
      url: `${baseUrl}/api/announcements`,
      method: "GET",
      success: (response) => {
        const items = response && response.statusCode >= 200 && response.statusCode < 300 && response.data
          ? response.data.announcements
          : null;
        if (!Array.isArray(items) || !items.length) {
          resolve({ messages: fallback(), source: "fallback" });
          return;
        }
        resolve({ messages: items.map((item, index) => normalizeMessage(item, index)), source: "api" });
      },
      fail: () => resolve({ messages: fallback(), source: "fallback" }),
    });
  });
}

async function loadMessages() {
  const session = messageSession();
  let data = {};
  try { data = getApp().globalData || {}; } catch (error) { /* 未初始化 */ }
  const personal = !data.authToken ? Promise.resolve({ messages: [] }) : new Promise((resolve) => {
    const failed = () => resolve({ messages: [], error: "反馈通知加载失败，请下拉重试" });
    if (!data.apiBaseUrl || typeof wx.request !== "function") { failed(); return; }
    wx.request({
      url: `${data.apiBaseUrl}/api/messages`,
      method: "GET",
      header: { Authorization: `Bearer ${data.authToken}` },
      success: (response) => {
        const items = response.statusCode === 200 && response.data && response.data.messages;
        if (!Array.isArray(items)) { failed(); return; }
        resolve({ messages: items.map(normalizeMessage) });
      },
      fail: failed,
    });
  });
  const [announcements, feedback] = await Promise.all([loadAnnouncements(), personal]);
  if (session !== messageSession()) return { messages: [], source: "stale", stale: true };
  return {
    ...announcements,
    error: feedback.error || "",
    messages: [...feedback.messages, ...announcements.messages].sort((a, b) => b.publishedAt - a.publishedAt),
  };
}

/** 把未读数写回我的页铃铛用的键，返回未读数 */
function syncUnreadBadge(messages) {
  const apply = (list) => {
    const count = unreadCount(list);
    try {
      wx.setStorageSync(MESSAGE_UNREAD_COUNT_KEY, count);
    } catch (error) {
      // 同上：存储失败不影响返回
    }
    return count;
  };
  if (Array.isArray(messages)) return Promise.resolve(apply(messages));
  return loadMessages().then((result) => result.stale || result.error ? null : apply(result.messages));
}

module.exports = {
  MESSAGE_READ_KEY,
  MESSAGE_UNREAD_COUNT_KEY,
  DEFAULT_MESSAGES,
  normalizeMessage,
  dayLabel,
  groupMessagesByDay,
  readMessageIds,
  markMessageRead,
  buildMessageGroups,
  unreadCount,
  flattenGroups,
  loadMessages,
  syncUnreadBadge,
  messageSession,
};
