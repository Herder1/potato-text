const TITLES = {
  take: "反馈已领取",
  resolve: "反馈已处理",
  reject: "反馈暂不处理",
};

// 从同一份处理历史派生通知，避免处置成功但另一份通知存储写入失败。
function feedbackMessages(reports, userId) {
  if (!userId || userId === "anonymous") return [];
  const messages = [];
  for (const report of reports) {
    if (report.reporter?.id !== userId || report.source === "system_review") continue;
    for (const message of report.messages || []) {
      if (message.role !== "staff") continue;
      messages.push({
        id: `feedback:${report.id}:${message.id}`,
        feedbackId: report.id, type: "反馈追问", title: "请补充反馈信息",
        summary: message.content,
        content: `反馈内容：${report.detail || report.reason || ""}\n\n追问：${message.content}`,
        publishedAt: message.createdAt,
      });
    }
    if (report.targetType !== "app_feedback") continue;
    let previousAction = "";
    for (const event of [...(report.history || [])].reverse()) {
      const repeated = previousAction === event.action;
      previousAction = event.action;
      if (!TITLES[event.action] || repeated) continue;
      const title = TITLES[event.action];
      const legacyDefault = ["核实后保留内容", "举报不成立"].includes(event.note);
      const reply = event.action === "take" ? "你的反馈已领取，正在处理中。"
        : (!legacyDefault && String(event.note || "").trim()) || title;
      messages.push({
        id: `feedback:${report.id}:${event.action}:${event.createdAt}`,
        feedbackId: report.id,
        type: "反馈进度",
        title,
        summary: reply,
        content: `反馈内容：${report.detail || report.reason || ""}\n\n处理进度：${reply}`,
        publishedAt: event.createdAt,
      });
    }
  }
  return messages.sort((a, b) => Number(b.publishedAt) - Number(a.publishedAt));
}

module.exports = { feedbackMessages };
