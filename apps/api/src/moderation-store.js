const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canContactReporter, conversationState } = require("./feedback-conversation");

const DAY_MS = 24 * 60 * 60 * 1000;
const FEEDBACK_RETENTION_DAYS = 30;
const MODERATION_RETENTION_DAYS = 180;

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

function retentionDaysForReport(report) {
  return report && (report.targetType === "app_feedback" || report.type === "product_feedback")
    ? FEEDBACK_RETENTION_DAYS
    : MODERATION_RETENTION_DAYS;
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
    questionStemPreview: String(payload.questionStemPreview || "").trim().slice(0, 120),
    clientStemPreview: String(payload.clientStemPreview || "").trim().slice(0, 120),
    questionId: String(payload.questionId || "").trim().slice(0, 100),
    questionType: String(payload.questionType || "").trim().slice(0, 40),
    feedbackType: ["correction", "issue"].includes(String(payload.feedbackType || "")) ? String(payload.feedbackType) : "",
    scoreRequestId: String(payload.scoreRequestId || "").trim().slice(0, 100),
    clientFeedbackId: String(payload.clientFeedbackId || "").trim().slice(0, 100),
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
    retentionUntil: 0,
    anonymizedAt: 0,
    handler: "",
    resolution: "",
    history: [],
    messages: [],
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
        if (status === "awaiting_reply") {
          if (!conversationState(item).waitingForUser) return false;
        } else if (status === "user_replied") {
          if (!conversationState(item).userReplied) return false;
        } else if (status !== "all" && item.status !== status) return false;
        if (risk !== "all" && item.risk !== risk) return false;
        // 题目反馈＝虚拟筛选（2026-10-01 产品负责人定的口径）：不新增 type，避免影响既有
        // product_feedback 的统计；判据是"type 是产品反馈 且 带了 questionId"。
        if (type === "question_feedback") {
          if (!(item.type === "product_feedback" && String(item.questionId || "").trim())) return false;
        } else if (type !== "all" && item.type !== type) return false;
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
        reports: reports.map((report) => ({ ...report, ...conversationState(report) })),
        counts: {
          total: all.length,
          pending: all.filter((item) => item.status === "pending").length,
          processing: all.filter((item) => item.status === "processing").length,
          highRisk: all.filter((item) => item.risk === "high" && ["pending", "processing"].includes(item.status)).length,
          resolved: all.filter((item) => ["resolved", "rejected"].includes(item.status)).length,
        },
      };
    },
    addMessage(id, { role, userId, actor = "", content, clientMessageId }) {
      const reports = read();
      const index = reports.findIndex((item) => item.id === id);
      const item = reports[index];
      if (!item || (role === "user" && item.reporter?.id !== userId)) throw new Error("moderation_not_found");
      if (!["staff", "user"].includes(role)) throw new Error("feedback_message_role_invalid");
      if (!canContactReporter(item)) throw new Error("feedback_recipient_unavailable");
      const text = String(content || "").trim();
      const requestId = String(clientMessageId || "").trim();
      if (!text || text.length > 1000) throw new Error("feedback_message_content_invalid");
      if (!requestId || requestId.length > 100) throw new Error("feedback_message_id_required");
      const messages = item.messages || [];
      const existing = messages.find((message) => message.role === role && message.clientMessageId === requestId);
      if (existing) {
        if (existing.content !== text) throw new Error("feedback_message_conflict");
        return { report: clone(item), duplicate: true };
      }
      if (["resolved", "rejected"].includes(item.status)) throw new Error("moderation_already_closed");
      if (role === "user" && !messages.some((message) => message.role === "staff")) throw new Error("feedback_reply_not_requested");
      if (messages.length >= 100) throw new Error("feedback_message_limit");
      const now = Date.now();
      const message = {
        id: `message-${crypto.randomUUID()}`, role, content: text, clientMessageId: requestId, createdAt: now,
        ...(role === "staff" ? { actor: String(actor).slice(0, 100) } : {}),
      };
      reports[index] = {
        ...item, messages: [...messages, message], status: "processing", updatedAt: now,
        ...(role === "staff" ? { handler: actor } : {}),
      };
      write(reports);
      return { report: clone(reports[index]), duplicate: false };
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
        retentionUntil: ["resolved", "rejected"].includes(definition.status)
          ? now + retentionDaysForReport(item) * DAY_MS
          : item.retentionUntil || 0,
        history: [{ action, actor, note: (String(note || "").trim() || feedbackResolution || definition.resolution).slice(0, 500), createdAt: now }, ...(item.history || [])].slice(0, 50),
      };
      write(reports);
      return clone(reports[index]);
    },
    /** 注销时解除用户身份，但保留必要的反馈/治理证据直到其保留期结束。 */
    anonymizeUser(userId, now = Date.now()) {
      const target = String(userId || "").trim();
      if (!target) return 0;
      const reports = read();
      let changed = 0;
      reports.forEach((item) => {
        const reporterMatches = item.reporter && item.reporter.id === target;
        const reportedMatches = item.reportedUser && item.reportedUser.id === target;
        if (!reporterMatches && !reportedMatches) return;
        if (reporterMatches) item.reporter = { id: "anonymous", nickname: "匿名用户" };
        if (reportedMatches) item.reportedUser = { id: "anonymous", nickname: "匿名用户" };
        item.contact = "";
        item.anonymizedAt = now;
        item.retentionUntil = Math.max(
          Number(item.retentionUntil) || 0,
          now + retentionDaysForReport(item) * DAY_MS,
        );
        item.updatedAt = now;
        changed += 1;
      });
      if (changed) write(reports);
      return changed;
    },
    /** 仅清理已结案且已到期的记录；未结案或法务保全记录不得误删。 */
    sweepExpired(now = Date.now()) {
      const reports = read();
      const remaining = reports.filter((item) => !(
        ["resolved", "rejected"].includes(item.status)
        && Number(item.retentionUntil) > 0
        && Number(item.retentionUntil) <= now
        && item.legalHold !== true
      ));
      const removed = reports.length - remaining.length;
      if (removed) write(remaining);
      return removed;
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
