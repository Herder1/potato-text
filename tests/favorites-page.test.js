const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildCommunityFavoriteItems,
  buildFavoriteQuestionItems,
  isBookmarked,
} = require("../apps/miniprogram/utils/favorites-view");

const root = path.join(__dirname, "../apps/miniprogram");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

test("「我的收藏」是独立页面，并从复习工具的收藏入口进入", () => {
  const config = JSON.parse(read("app.json"));
  assert.ok(config.pages.includes("pages/favorites/favorites"), "需要在 app.json 注册收藏页");
  ["js", "json", "wxml", "wxss"].forEach((extension) => {
    assert.ok(fs.existsSync(path.join(root, "pages", "favorites", `favorites.${extension}`)), `缺少 favorites.${extension}`);
  });

  const review = read("pages", "review", "review.js");
  assert.match(review, /key === "favorite"[\s\S]{0,200}navigateTo\(\{ url: "\/pages\/favorites\/favorites" \}\)/);
  assert.doesNotMatch(review, /key === "favorite"[\s\S]{0,80}activeFilter: key/, "收藏不应再走页内筛选切换");
  const pageConfig = JSON.parse(read("pages", "favorites", "favorites.json"));
  assert.equal(pageConfig.navigationBarTitleText, "我的收藏");
});

test("收藏页只读引用：登录才拉取、401 明确提示、取消收藏走 unfavorite", () => {
  const script = read("pages", "favorites", "favorites.js");
  assert.match(script, /\/api\/community\/assets\/favorites/);
  assert.match(script, /authHeader\(\)/);
  assert.match(script, /statusCode === 401/);
  assert.match(script, /登录后才能查看收藏的公开内容/);
  assert.match(script, /\/api\/community\/assets\/\$\{encodeURIComponent\(id\)\}\/unfavorite/);
  assert.match(script, /loggedIn = Boolean\(application\.globalData\.authToken\)/, "未登录不应请求服务端");
});

test("题目收藏沿用复习页同一套本地书签存储，不会因为换页而丢", () => {
  const script = read("pages", "favorites", "favorites.js");
  assert.match(script, /shukao_bookmarks/);
  assert.match(script, /shukao_bookmark_\$\{id\}/);
  const review = read("pages", "review", "review.js");
  assert.match(review, /shukao_bookmarks/);
  assert.match(review, /shukao_bookmark_\$\{question\.id\}/);
  assert.match(script, /officialQuestions/, "题目收藏要从同一份题目数据里解析标题");
});

test("收藏页两个区块与空态齐全", () => {
  const markup = read("pages", "favorites", "favorites.wxml");
  assert.match(markup, /收藏的公开内容/);
  assert.match(markup, /收藏的题目/);
  assert.match(markup, /还没有收藏公开内容/);
  assert.match(markup, /还没有收藏题目/);
  assert.match(markup, /bindtap="goLogin"/);
  assert.match(markup, /catchtap="removeCommunityFavorite"/);
  assert.match(markup, /catchtap="removeQuestionFavorite"/);
  assert.match(markup, /bindtap="openQuestion"/);
});

test("社区收藏项按类型/作者/收藏数归一，未发布内容标为已下架", () => {
  const items = buildCommunityFavoriteItems([
    { id: "community-1", type: "note", title: "笔记", excerpt: "摘要", contributor: "小林", favoriteCount: "3", moderationStatus: "published" },
    { id: "community-2", type: "card_pack", title: "卡片集", moderationStatus: "offline" },
    { id: "community-3", type: "question", title: "题目分享", moderationStatus: "published" },
  ]);
  assert.equal(items.length, 3);
  assert.equal(items[0].typeLabel, "共享笔记");
  assert.equal(items[0].favoriteCount, 3);
  assert.equal(items[0].available, true);
  assert.equal(items[0].statusLabel, "");
  assert.equal(items[1].typeLabel, "卡片集");
  assert.equal(items[1].available, false);
  assert.equal(items[1].statusLabel, "已下架");
  assert.equal(items[2].typeLabel, "题目分享");
  assert.deepEqual(buildCommunityFavoriteItems(null), []);
});

test("题目收藏项兼容新旧两种书签存储并过滤未收藏题目", () => {
  const officialQuestions = [
    { id: "q1", stem: "第一题", breadcrumb: "现代汉语 · 语音" },
    { id: "q2", stem: "第二题", knowledgePoint: "声母" },
    { id: "q3", stem: "第三题" },
  ];
  assert.equal(isBookmarked({ q1: { value: true } }, "q1"), true);
  assert.equal(isBookmarked({ q1: { value: false } }, "q1"), false);
  const items = buildFavoriteQuestionItems({
    officialQuestions,
    bookmarkStates: { q1: { value: true }, q3: { value: false } },
    legacyLookup: (id) => id === "q2",
  });
  assert.deepEqual(items.map((item) => item.id), ["q1", "q2"]);
  assert.equal(items[0].breadcrumb, "现代汉语 · 语音");
  assert.equal(items[1].breadcrumb, "声母");
  assert.deepEqual(buildFavoriteQuestionItems({ officialQuestions: [] }), []);
});
