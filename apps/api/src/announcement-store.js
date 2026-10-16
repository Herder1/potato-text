const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeTime(value) {
  if (value === "" || value === null || value === undefined) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error("announcement_time_invalid");
  return parsed;
}

function seedAnnouncements() {
  const createdAt = Date.parse("2026-08-01T09:00:00+08:00");
  return [
    {
      id: "internal-benefit",
      type: "权益通知",
      title: "平台题库已开放",
      summary: "内部测试期间，平台题库已为测试用户开放",
      content: "内部测试期间，测试用户可使用已上线的平台题库。正式订阅与支付功能将在后续阶段接入，现阶段不会产生订阅费用。\n\nAI 解析与评分消耗豆币，当前豆币余额可在「豆币账户」中查看。",
      status: "published",
      priority: 100,
      startsAt: null,
      endsAt: null,
      publishedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
      updatedBy: "系统种子数据",
    },
    {
      id: "ai-grading-update",
      type: "功能更新",
      title: "主观题评分体验优化",
      summary: "主观题评分速度与结果稳定性已完成优化",
      content: "主观题提交与 AI 评分现已分开。提交答案后可以先记录掌握状态，需要查看结构化评分时再主动发起评分。\n\n评分结果将继续展示命中得分点、遗漏得分点、错误内容和表达建议。",
      status: "published",
      priority: 80,
      startsAt: null,
      endsAt: null,
      publishedAt: createdAt - 1000,
      createdAt: createdAt - 1000,
      updatedAt: createdAt - 1000,
      updatedBy: "系统种子数据",
    },
    {
      id: "feedback",
      type: "测试公告",
      title: "欢迎提交使用反馈",
      summary: "发现题目或功能问题，可通过帮助与反馈告诉我们",
      content: "如果发现题目答案、章节归类或页面功能存在问题，请通过“帮助与反馈”提交。清晰描述问题并附上截图，有助于更快定位和修正。",
      status: "published",
      priority: 60,
      startsAt: null,
      endsAt: null,
      publishedAt: createdAt - 2000,
      createdAt: createdAt - 2000,
      updatedAt: createdAt - 2000,
      updatedBy: "系统种子数据",
    },
  ];
}

function normalizeAnnouncement(payload, existing = null) {
  const title = cleanText(payload.title ?? existing?.title, 100);
  const summary = cleanText(payload.summary ?? existing?.summary, 160);
  const content = cleanText(payload.content ?? existing?.content, 10000);
  const type = cleanText(payload.type ?? existing?.type ?? "平台公告", 30) || "平台公告";
  const priorityValue = Number(payload.priority ?? existing?.priority ?? 0);
  const priority = Math.min(999, Math.max(0, Number.isFinite(priorityValue) ? Math.round(priorityValue) : 0));
  const startsAt = normalizeTime(Object.prototype.hasOwnProperty.call(payload, "startsAt") ? payload.startsAt : existing?.startsAt);
  const endsAt = normalizeTime(Object.prototype.hasOwnProperty.call(payload, "endsAt") ? payload.endsAt : existing?.endsAt);
  if (!title) throw new Error("announcement_title_required");
  if (!summary) throw new Error("announcement_summary_required");
  if (!content) throw new Error("announcement_content_required");
  if (startsAt && endsAt && endsAt <= startsAt) throw new Error("announcement_time_range_invalid");
  return { type, title, summary, content, priority, startsAt, endsAt };
}

function createAnnouncementStore(adapter) {
  const read = () => adapter.read().map(clone);
  const write = (items) => adapter.write(items.map(clone));
  return {
    exportState: () => clone(adapter.read()),
    list(filters = {}) {
      const query = cleanText(filters.query, 200).toLowerCase();
      const status = cleanText(filters.status || "all", 30);
      const all = read();
      const announcements = all.filter((item) => {
        if (status !== "all" && item.status !== status) return false;
        return !query || [item.title, item.summary, item.type, item.content, item.id].join(" ").toLowerCase().includes(query);
      }).sort((left, right) => right.priority - left.priority || right.updatedAt - left.updatedAt);
      const now = Number(filters.now) || Date.now();
      return {
        announcements,
        counts: {
          total: all.length,
          draft: all.filter((item) => item.status === "draft").length,
          published: all.filter((item) => item.status === "published").length,
          offline: all.filter((item) => item.status === "offline").length,
          scheduled: all.filter((item) => item.status === "published" && item.startsAt && item.startsAt > now).length,
          active: all.filter((item) => item.status === "published" && (!item.startsAt || item.startsAt <= now) && (!item.endsAt || item.endsAt > now)).length,
        },
      };
    },
    publicList(now = Date.now()) {
      return read().filter((item) => item.status === "published"
        && (!item.startsAt || item.startsAt <= now)
        && (!item.endsAt || item.endsAt > now))
        .sort((left, right) => right.priority - left.priority || right.publishedAt - left.publishedAt)
        .map(({ updatedBy, ...item }) => item);
    },
    get(id) {
      const item = read().find((announcement) => announcement.id === id);
      return item ? clone(item) : null;
    },
    create(payload, actor = "超级管理员") {
      const announcements = read();
      const now = Date.now();
      const item = {
        id: cleanText(payload.id, 120) || `announcement-${crypto.randomUUID()}`,
        ...normalizeAnnouncement(payload),
        status: "draft",
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
        updatedBy: actor,
      };
      if (announcements.some((announcement) => announcement.id === item.id)) throw new Error("announcement_id_exists");
      write([item, ...announcements]);
      return clone(item);
    },
    update(id, payload, actor = "超级管理员") {
      const announcements = read();
      const index = announcements.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("announcement_not_found");
      announcements[index] = {
        ...announcements[index],
        ...normalizeAnnouncement(payload, announcements[index]),
        updatedAt: Date.now(),
        updatedBy: actor,
      };
      write(announcements);
      return clone(announcements[index]);
    },
    action(id, action, actor = "超级管理员") {
      const announcements = read();
      const index = announcements.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("announcement_not_found");
      if (!['publish', 'offline', 'draft'].includes(action)) throw new Error("announcement_action_invalid");
      const current = announcements[index];
      const now = Date.now();
      const status = action === "publish" ? "published" : action;
      announcements[index] = {
        ...current,
        status,
        publishedAt: action === "publish" ? now : current.publishedAt,
        updatedAt: now,
        updatedBy: actor,
      };
      write(announcements);
      return clone(announcements[index]);
    },
    remove(id) {
      const announcements = read();
      const item = announcements.find((announcement) => announcement.id === id);
      if (!item) throw new Error("announcement_not_found");
      if (item.status === "published") throw new Error("announcement_offline_before_delete");
      write(announcements.filter((announcement) => announcement.id !== id));
      return clone(item);
    },
  };
}

function createFileAnnouncementStore(filePath = path.resolve(__dirname, "../../../.runtime/announcements.json")) {
  return createAnnouncementStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(value) ? value : seedAnnouncements();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return seedAnnouncements();
      }
    },
    write(items) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryAnnouncementStore(initialItems = seedAnnouncements()) {
  let items = clone(initialItems);
  return createAnnouncementStore({ read: () => clone(items), write: (next) => { items = clone(next); } });
}

module.exports = { createFileAnnouncementStore, createMemoryAnnouncementStore, seedAnnouncements };
