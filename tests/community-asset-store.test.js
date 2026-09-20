const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryCommunityAssetStore } = require("../apps/api/src/community-asset-store");

test("community assets publish complete safe submissions and hold risky content", () => {
  const store = createMemoryCommunityAssetStore([]);
  const safe = store.submit({
    id: "local-safe",
    type: "note",
    title: "李白诗歌艺术特色整理",
    content: "从主观抒情、夸张想象、语言风格和独立人格四个方面进行结构化整理。",
    subjectId: "ancient-literature",
    chapterId: "sui-tang",
    originality: "original",
  }, "user-1");
  assert.equal(safe.moderationStatus, "published");
  assert.equal(store.list({}).length, 1);

  const risky = store.submit({
    id: "local-risk",
    type: "note",
    title: "领取资料",
    content: "加微信领取全部资料和答案，这是一条用于测试初筛规则的内容。",
    subjectId: "modern-chinese",
    chapterId: "grammar",
    originality: "original",
  }, "user-1");
  assert.equal(risky.moderationStatus, "pending_review");
  assert.equal(store.list({}).length, 1);
  assert.equal(store.list({ userId: "user-1", includeUnpublished: true }).length, 2);
});
