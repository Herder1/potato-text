const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("knowledge page switches public card channels without creation controls", () => {
  let definition;
  let navigatedUrl = "";
  const store = new Map();
  global.Page = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    navigateTo: ({ url }) => { navigatedUrl = url; },
    showToast() {},
    showModal() {},
  };

  const pagePath = require.resolve("../apps/miniprogram/pages/knowledge/knowledge.js");
  delete require.cache[pagePath];
  require(pagePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };

  // DEC-056：题目笔记就是知识卡里的笔记卡，知识页直接读卡片（不再有 shukao_notes）。
  store.set("shukao_card_box_sets", [{
    id: "set-note",
    title: "《现代汉语（增订七版）·上册》",
    subtitle: "刷题笔记",
    author: "我的整理",
    subject: "专业课",
    folder: "我的卡集",
    cards: [{
      id: "note-card-1",
      type: "note",
      section: "第一章语音",
      question: "音节的拼写规则",
      answer: "y、w 的使用规则要记牢。",
      questionId: "question-aaa",
      reviewable: false,
    }],
    sectionOrder: ["第一章语音"],
    sectionLevels: { "第一章语音": 1 },
  }]);
  page.onShow();
  assert.equal(page.data.visibleCards.length, 6);
  assert.equal(page.data.visibleCards.some((card) => card.id === "note-card-1"), false);
  const listedNote = page.data.cards.find((card) => card.id === "note-card-1");
  assert.equal(listedNote.type, "personal");
  assert.equal(listedNote.subtitle, "《现代汉语（增订七版）·上册》 · 第一章语音");
  assert.deepEqual(page.data.tabs.map((tab) => tab.label), ["推荐", "作品速览", "背诵卡", "社区", "笔记"]);
  assert.equal(page.data.visibleCards.find((card) => card.type === "overview").featurePreview.length, 2);
  assert.equal(page.data.visibleCards.find((card) => card.type === "community").contributorName, "薯考同学小林");
  page.selectTab({ currentTarget: { dataset: { id: "recitation" } } });
  assert.equal(page.data.activeTabLabel, "背诵卡");
  assert.equal(page.data.visibleCards.every((card) => card.type === "recitation"), true);
  assert.equal(page.data.visibleCards[0].recitationLines.length, 4);

  page.selectDirectoryItem({ currentTarget: { dataset: { id: "question_pack" } } });
  assert.equal(page.data.libraryMode, true);
  assert.equal(page.data.activeLibraryType, "question_pack");
  assert.equal(page.data.directoryOpen, false);

  page.selectDirectoryItem({ currentTarget: { dataset: { id: "notes" } } });
  assert.equal(page.data.visibleLibraryCards.some((card) => card.id === "note-card-1"), true);

  page.openLibraryAsset({ currentTarget: { dataset: { id: "community-note-chronology" } } });
  assert.equal(page.data.selectedLibraryAsset.type, "note");
  assert.match(page.data.selectedLibraryAsset.detailContent, /先秦/);
  page.closeLibraryAsset();

  page.setData({
    communityAssets: [...page.data.communityAssets, {
      id: "pack-preview",
      type: "question_pack",
      typeLabel: "社区题包",
      title: "可预览题包",
      excerpt: "题包说明",
      questions: [{ id: "q1", stem: "测试题目", typeLabel: "简答题" }],
    }],
  });
  page.openLibraryAsset({ currentTarget: { dataset: { id: "pack-preview" } } });
  assert.equal(page.data.selectedLibraryAsset.questions.length, 1);
  page.setData({ selectedLibraryAsset: { ...page.data.selectedLibraryAsset, importedPackId: "local-pack" } });
  page.openSelectedPack();
  assert.equal(navigatedUrl, "/pages/pack-collection/pack-collection?id=local-pack&source=private");
  page.closeLibraryAsset();

  page.showRecommendation();
  assert.equal(page.data.libraryMode, false);
  assert.equal(page.data.activeTabLabel, "为你推荐");
  assert.equal(page.data.visibleCards.length, 6);

  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge/knowledge.wxml"), "utf8");
  assert.doesNotMatch(markup, /class="fab(?:\s|"|-)/);
  assert.match(markup, /knowledge-card-\{\{item\.type\}\}/);
  assert.match(markup, /class="cover-wrap"/);
  assert.match(markup, /class="recitation-lines"/);
  assert.match(markup, /class="card-summary"/);
  assert.doesNotMatch(markup, /class="overview-emblem|class="overview-summary|class="community-summary|class="note-avatar|class="note-paper"/);
  // 顶部导航栏不再承载"知识库"标题：系统标题置空，页面自绘标题只在资源库模式显示当前栏目名。
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge/knowledge.json"), "utf8"));
  assert.equal(config.navigationStyle, "custom");
  assert.equal(config.navigationBarTitleText, "");
  assert.equal((markup.match(/knowledge-nav-title/g) || []).length, 1);
  assert.match(markup, /wx:if="\{\{libraryMode\}\}"\s*class="knowledge-nav-title"/);
  assert.doesNotMatch(markup, />\s*知识库\s*</);
  assert.match(markup, /class="detail-action-bar"><button class="review-add"/);
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge/knowledge.wxss"), "utf8");
  assert.match(styles, /\.detail-action-bar\s*\{[^}]*bottom:\s*calc\(118rpx \+ env\(safe-area-inset-bottom\)\)/s);
  assert.match(markup, /class="directory-close"[\s\S]*class="directory-close-line directory-close-line-a"/);
  assert.doesNotMatch(markup, /<button[^>]*bindtap="closeDirectory"/);
  assert.equal(typeof page.contributeQuestion, "undefined");
  assert.equal(typeof page.createNote, "undefined");

  const card = page.data.visibleCards[0];
  page.addToReview({ currentTarget: { dataset: { id: card.id } } });
  assert.deepEqual(store.get("shukao_saved_knowledge_cards"), [card.id]);

  delete global.Page;
  delete global.wx;
});
