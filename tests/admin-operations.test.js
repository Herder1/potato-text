const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryModerationStore } = require("../apps/api/src/moderation-store");

test("operation logs are filterable and strip sensitive metadata", () => {
  const store = createMemoryAdminOperationStore();
  store.append({
    actor: "题库编辑",
    action: "question.create",
    category: "question",
    targetType: "question",
    targetId: "question-001",
    summary: "录入一道题目",
    metadata: { bookId: "book-001", apiKey: "never-store-this", answer: "正文不记录" },
  });
  store.append({
    actor: "超级管理员",
    action: "ai_route.update",
    category: "ai_config",
    targetType: "ai_scene",
    targetId: "subjective_scoring",
    summary: "更新评分路由",
  });

  const questions = store.list({ category: "question" });
  assert.equal(questions.items.length, 1);
  assert.equal(questions.items[0].metadata.bookId, "book-001");
  assert.equal("apiKey" in questions.items[0].metadata, false);
  assert.equal("answer" in questions.items[0].metadata, false);
  assert.equal(store.list({}).summary.total, 2);
});

test("moderation reports preserve a traceable resolution history", () => {
  const store = createMemoryModerationStore([]);
  const report = store.create({
    type: "spam",
    risk: "high",
    targetType: "pack",
    targetId: "pack-001",
    targetTitle: "公开题包",
    reporter: { id: "user-1", nickname: "学习者" },
    reportedUser: { id: "user-2", nickname: "发布者" },
    reason: "包含广告",
  });
  assert.equal(report.status, "pending");
  assert.equal(store.list({}).counts.highRisk, 1);

  const processing = store.action(report.id, "take", "内容审核员", "开始核查");
  assert.equal(processing.status, "processing");
  const resolved = store.action(report.id, "offline", "内容审核员", "确认导流广告");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution, "内容已下架");
  assert.equal(resolved.history.length, 2);
  assert.equal(store.list({ status: "resolved" }).reports.length, 1);
});
