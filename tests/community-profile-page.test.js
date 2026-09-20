const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildCommunityIdentity,
  buildContributionItems,
  summarizeContributions,
} = require("../apps/miniprogram/utils/community-profile");

test("community contributions merge remote status without counting drafts or collected assets", () => {
  const localAssets = [
    { id: "local-1", type: "note", title: "现代文学笔记", ownership: "created", moderationStatus: "pending_review", updatedAt: 10 },
    { id: "local-draft", type: "note", title: "草稿", ownership: "created", moderationStatus: "draft", updatedAt: 20 },
    { id: "local-collected", type: "question", title: "导入题目", ownership: "collected", moderationStatus: "published", updatedAt: 30 },
  ];
  const remoteAssets = [
    { id: "remote-1", clientAssetId: "local-1", type: "note", title: "现代文学笔记", moderationStatus: "published", favoriteCount: 8, copyCount: 3, updatedAt: 40 },
    { id: "remote-2", clientAssetId: "remote-only", type: "question", title: "跨设备投稿", moderationStatus: "pending_review", updatedAt: 50 },
  ];
  const items = buildContributionItems(localAssets, remoteAssets);
  assert.equal(items.length, 2);
  assert.equal(items.filter((item) => item.title === "现代文学笔记").length, 1);
  assert.equal(items.find((item) => item.title === "现代文学笔记").moderationStatus, "published");
  assert.equal(items.find((item) => item.title === "现代文学笔记").localId, "local-1");
  assert.deepEqual(summarizeContributions(items), {
    total: 2,
    published: 1,
    reviewing: 1,
    attention: 0,
    favorites: 8,
    copies: 3,
  });
});

test("community identity advances only from published content and real copy counts", () => {
  const builderItems = Array.from({ length: 5 }, (_, index) => ({
    moderationStatus: "published",
    favoriteCount: index,
    copyCount: 4,
  }));
  const builder = buildCommunityIdentity(builderItems);
  assert.equal(builder.current.id, "builder");
  assert.equal(builder.next.id, "featured");
  assert.equal(builder.published, 5);
  assert.equal(builder.copies, 20);
  assert.ok(builder.progress < 100);

  const featured = buildCommunityIdentity(Array.from({ length: 10 }, () => ({
    moderationStatus: "published",
    favoriteCount: 2,
    copyCount: 5,
  })));
  assert.equal(featured.current.id, "featured");
  assert.equal(featured.progress, 100);
});

test("profile community entries open registered functional pages", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram");
  const profileScript = fs.readFileSync(path.join(root, "pages/profile/profile.js"), "utf8");
  const contributions = fs.readFileSync(path.join(root, "pages/contributions/contributions.wxml"), "utf8");
  const identity = fs.readFileSync(path.join(root, "pages/community-identity/community-identity.wxml"), "utf8");
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  assert.match(profileScript, /name === "我的贡献"[^\n]+\/pages\/contributions\/contributions/);
  assert.match(profileScript, /name === "社区身份"[^\n]+\/pages\/community-identity\/community-identity/);
  assert.ok(appConfig.pages.includes("pages/contributions/contributions"));
  assert.ok(appConfig.pages.includes("pages/community-identity/community-identity"));
  assert.match(contributions, /已公开/);
  assert.match(contributions, /审核中/);
  assert.match(contributions, /获收藏/);
  assert.match(contributions, /被导入/);
  assert.match(identity, /身份阶梯/);
  assert.match(identity, /查看我的贡献/);
});
