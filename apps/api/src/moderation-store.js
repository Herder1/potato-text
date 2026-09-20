const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const actionDefinitions = {
  take: { status: "processing", resolution: "已领取处理" },
  resolve: { status: "resolved", resolution: "核实后保留内容" },
  reject: { status: "rejected", resolution: "举报不成立" },
  offline: { status: "resolved", resolution: "内容已下架" },
  mute_user: { status: "resolved", resolution: "相关用户已禁言" },
  no_submit_user: { status: "resolved", resolution: "相关用户已禁止投稿" },
  no_public_user: { status: "resolved", resolution: "相关用户已限制公开分享" },
  ban_user: { status: "resolved", resolution: "相关用户已封禁" },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeAttachments(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 3).map((value) => String(value || "").trim()).filter((value) => {
    const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return false;
    return Buffer.byteLength(match[2], "base64") <= 200 * 1024;
  });
}

function seedReports() {
  const now = Date.now();
  return [
    {
      id: "report-demo-001", source: "user_report", type: "question_error", risk: "medium", status: "pending",
      targetType: "question", targetId: "demo-modern-chinese-004", targetTitle: "现代汉语语音章节单选题",
      reporter: { id: "user-demo-017", nickname: "粤升本同学" }, reportedUser: null,
      reason: "参考答案疑似与教材表述不一致", detail: "用户标注《现代汉语》上册相关页码，等待编辑复核。",
      createdAt: now - 18 * 60 * 1000, updatedAt: now - 18 * 60 * 1000, history: [],
    },
    {
      id: "report-demo-002", source: "system_review", type: "unsafe_content", risk: "high", status: "pending",
      targetType: "pack", targetId: "pack-community-009", targetTitle: "古代文学冲刺资料包",
      reporter: { id: "system", nickname: "内容安全初筛" }, reportedUser: { id: "user-demo-081", nickname: "文学上岸" },
      reason: "公开题包包含外部联系方式", detail: "命中广告导流规则，公开前需人工确认。",
      createdAt: now - 42 * 60 * 1000, updatedAt: now - 42 * 60 * 1000, history: [],
    },
    {
      id: "report-demo-003", source: "user_report", type: "spam", risk: "low", status: "processing",
      targetType: "comment", targetId: "comment-demo-103", targetTitle: "题目评论：求资料私聊",
      reporter: { id: "user-demo-023", nickname: "木棉" }, reportedUser: { id: "user-demo-094", nickname: "资料分享员" },
      reason: "疑似重复广告", detail: "同一内容在多个题目评论区出现。",
      createdAt: now - 3 * 60 * 60 * 1000, updatedAt: now - 2 * 60 * 60 * 1000,
      handler: "超级管理员", history: [{ action: "take", actor: "超级管理员", note: "开始核查账号历史评论", createdAt: now - 2 * 60 * 60 * 1000 }],
    },
  ];
}

function normalizeReport(payload, now = Date.now()) {
  const type = String(payload.type || "other").trim();
  const targetType = String(payload.targetType || "").trim();
  const targetId = String(payload.targetId || "").trim();
  const reason = String(payload.reason || "").trim();
  if (!targetType || !targetId || !reason) throw new Error("moderation_required_fields_missing");
  return {
    id: String(payload.id || `report-${crypto.randomUUID()}`),
    source: payload.source === "system_review" ? "system_review" : "user_report",
    type: type.slice(0, 60),
    risk: ["low", "medium", "high"].includes(payload.risk) ? payload.risk : "medium",
    status: "pending",
    targetType: targetType.slice(0, 60),
    targetId: targetId.slice(0, 160),
    targetTitle: String(payload.targetTitle || targetId).trim().slice(0, 240),
    reporter: {
      id: String(payload.reporter && payload.reporter.id || "system").slice(0, 100),
      nickname: String(payload.reporter && payload.reporter.nickname || "系统").slice(0, 60),
    },
    reportedUser: payload.reportedUser ? {
      id: String(payload.reportedUser.id || "").slice(0, 100),
      nickname: String(payload.reportedUser.nickname || "").slice(0, 60),
    } : null,
    reason: reason.slice(0, 500),
    detail: String(payload.detail || "").trim().slice(0, 2000),
    feedbackCategory: String(payload.feedbackCategory || "").trim().slice(0, 60),
    contact: String(payload.contact || "").trim().slice(0, 120),
    attachments: normalizeAttachments(payload.attachments),
    clientContext: {
      pagePath: String(payload.clientContext && payload.clientContext.pagePath || "").slice(0, 240),
      system: String(payload.clientContext && payload.clientContext.system || "").slice(0, 120),
      model: String(payload.clientContext && payload.clientContext.model || "").slice(0, 120),
      version: String(payload.clientContext && payload.clientContext.version || "").slice(0, 60),
    },
    createdAt: now,
    updatedAt: now,
    handler: "",
    resolution: "",
    history: [],
  };
}

function createModerationStore(adapter) {
  const read = () => adapter.read().map(clone);
  const write = (items) => adapter.write(items.map(clone));
  return {
    exportState: () => clone(adapter.read()),
    create(payload) {
      const reports = read();
      const report = normalizeReport(payload);
      write([report, ...reports]);
      return clone(report);
    },
    get(id) {
      const report = read().find((item) => item.id === id);
      return report ? clone(report) : null;
    },
    list(filters = {}) {
      const status = String(filters.status || "all");
      const risk = String(filters.risk || "all");
      const type = String(filters.type || "all");
      const query = String(filters.query || "").trim().toLowerCase();
      const all = read();
      const reports = all.filter((item) => {
        if (status !== "all" && item.status !== status) return false;
        if (risk !== "all" && item.risk !== risk) return false;
        if (type !== "all" && item.type !== type) return false;
        if (query && ![item.targetTitle, item.targetId, item.reason, item.reporter && item.reporter.nickname, item.reportedUser && item.reportedUser.nickname]
          .join(" ").toLowerCase().includes(query)) return false;
        return true;
      }).sort((left, right) => {
        const riskOrder = { high: 3, medium: 2, low: 1 };
        if (left.status === "pending" && right.status !== "pending") return -1;
        if (right.status === "pending" && left.status !== "pending") return 1;
        return (riskOrder[right.risk] - riskOrder[left.risk]) || (right.updatedAt - left.updatedAt);
      });
      return {
        reports,
        counts: {
          total: all.length,
          pending: all.filter((item) => item.status === "pending").length,
          processing: all.filter((item) => item.status === "processing").length,
          highRisk: all.filter((item) => item.risk === "high" && ["pending", "processing"].includes(item.status)).length,
          resolved: all.filter((item) => ["resolved", "rejected"].includes(item.status)).length,
        },
      };
    },
    action(id, action, actor = "超级管理员", note = "") {
      const reports = read();
      const index = reports.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("moderation_not_found");
      const definition = actionDefinitions[action];
      if (!definition) throw new Error("moderation_action_invalid");
      const now = Date.now();
      const item = reports[index];
      if (["resolved", "rejected"].includes(item.status) && action === "take") throw new Error("moderation_already_closed");
      const feedbackResolution = item.targetType === "app_feedback"
        ? { resolve: "反馈已处理", reject: "当前暂不处理" }[action]
        : "";
      reports[index] = {
        ...item,
        status: definition.status,
        handler: actor,
        resolution: definition.status === "processing" ? item.resolution : (feedbackResolution || definition.resolution),
        updatedAt: now,
        history: [{ action, actor, note: String(note || definition.resolution).trim().slice(0, 500), createdAt: now }, ...(item.history || [])].slice(0, 50),
      };
      write(reports);
      return clone(reports[index]);
    },
  };
}

function createFileModerationStore(filePath = path.resolve(__dirname, "../../../.runtime/moderation-reports.json")) {
  return createModerationStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(value) ? value : seedReports();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return seedReports();
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

function createMemoryModerationStore(initialReports = seedReports()) {
  let reports = clone(initialReports);
  return createModerationStore({ read: () => clone(reports), write: (next) => { reports = clone(next); } });
}

module.exports = { createFileModerationStore, createMemoryModerationStore, seedReports };
