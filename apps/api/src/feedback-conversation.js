function canContactReporter(report) {
  return report.source !== "system_review"
    && Boolean(report.reporter?.id)
    && !["system", "anonymous"].includes(report.reporter.id);
}

function conversationState(report) {
  const messages = Array.isArray(report.messages) ? report.messages : [];
  const closed = ["resolved", "rejected"].includes(report.status);
  const lastMessage = messages[messages.length - 1];
  return {
    canAsk: canContactReporter(report) && !closed && (!lastMessage || lastMessage.role === "user"),
    canReply: canContactReporter(report) && !closed && lastMessage?.role === "staff",
    waitingForUser: !closed && lastMessage?.role === "staff",
    userReplied: !closed && lastMessage?.role === "user",
  };
}

function isOwnFeedback(report, userId) {
  return canContactReporter(report) && report.reporter.id === userId
    && (report.targetType === "app_feedback" || (report.messages || []).length > 0);
}

function publicFeedback(report) {
  const isFeedback = report.targetType === "app_feedback";
  return {
    id: report.id,
    category: report.feedbackCategory || (report.targetType === "question" ? "content_issue" : "other"),
    content: report.detail || report.reason,
    status: report.status,
    resolution: isFeedback ? report.resolution : ({ resolved: "已处理", rejected: "已结束" }[report.status] || ""),
    response: isFeedback ? report.history?.[0]?.note || "" : "",
    attachmentCount: Array.isArray(report.attachments) ? report.attachments.length : 0,
    messages: (report.messages || []).map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt })),
    ...conversationState(report),
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

module.exports = { canContactReporter, conversationState, isOwnFeedback, publicFeedback };
