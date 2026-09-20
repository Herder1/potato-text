const { closeTransientLayers } = require("../../utils/page-layers");
const { officialCards, communityNotes } = require("../../data/knowledge-cards");
const { communityAssets: seededCommunityAssets } = require("../../data/community-assets");
const { collectAsset, loadAssets, saveAsset } = require("../../utils/asset-store");
const { copyCommunityPack, loadPrivatePacks } = require("../../utils/private-pack-store");
const { cachePublicPack } = require("../../utils/pack-collection");
const { listNoteCards } = require("../../utils/question-note-store");

const tabs = [
  { id: "all", label: "推荐" },
  { id: "overview", label: "作品速览" },
  { id: "recitation", label: "背诵卡" },
  { id: "community", label: "社区" },
  { id: "notes", label: "笔记" },
];

const directoryItems = [
  { id: "overview", label: "作品速览", mark: "览", description: "梗概、名句与艺术特色" },
  { id: "notes", label: "笔记", mark: "记", description: "个人笔记与优秀共享笔记" },
  { id: "question_pack", label: "题包", mark: "题", description: "平台精选与社区题包" },
  { id: "recitation", label: "背诵卡", mark: "背", description: "古诗文与高频名篇" },
];

const coverMarks = {
  "overview-shijing": "诗",
  "overview-lisao": "骚",
  "overview-dream-red-mansions": "梦",
  "overview-li-bai": "白",
  "recite-jinse": "锦",
};

function decorateCard(card, index, activity, reviewIds) {
  const record = activity[card.id] || {};
  const title = String(card.title || "知").replace(/[《》“”]/g, "");
  const subtitleParts = String(card.subtitle || "").split("·").map((part) => part.trim()).filter(Boolean);
  const recitationLines = String(card.summary || "").match(/[^。！？]+[。！？]?/g) || [];
  return {
    ...card,
    coverMark: coverMarks[card.id] || title.slice(0, 1) || "知",
    coverTone: ["cyan", "ink", "rose", "green", "violet"][index % 5],
    featurePreview: (Array.isArray(card.features) ? card.features : []).slice(0, card.type === "overview" ? 2 : 3),
    quoteCount: Array.isArray(card.quotes) ? card.quotes.length : 0,
    featureCount: Array.isArray(card.features) ? card.features.length : 0,
    recitationLines: recitationLines.slice(0, 4),
    recitationLineCount: recitationLines.length,
    contributorName: subtitleParts[0] || "社区贡献者",
    contributorMeta: subtitleParts.slice(1).join(" · ") || card.subject || "共享笔记",
    favoriteCount: Number(record.favoriteCount) || (card.type === "community" ? 36 : 12 + index * 7),
    commentCount: Array.isArray(record.comments) ? record.comments.length : (card.type === "community" ? 5 : 0),
    helpfulCount: Number(record.helpfulCount) || (card.type === "community" ? 48 : 24 + index * 11),
    favorited: record.favorited === true,
    helpful: record.helpful === true,
    inReview: reviewIds.includes(card.id),
  };
}

Page({
  data: {
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    tabs,
    directoryItems,
    activeTab: "all",
    activeTabLabel: "为你推荐",
    activeDirectoryId: "all",
    libraryMode: false,
    activeLibraryType: "",
    activeLibraryLabel: "",
    directoryOpen: false,
    directorySortOpen: false,
    directoryFilterOpen: false,
    query: "",
    searchOpen: false,
    sortMode: "recommended",
    sortOptions: [
      { id: "recommended", label: "推荐排序" },
      { id: "popular", label: "最多收藏" },
      { id: "quick", label: "快速阅读" },
    ],
    subjectFilter: "all",
    subjectOptions: [
      { id: "all", label: "全部学科" },
      { id: "现代汉语", label: "现代汉语" },
      { id: "古代汉语", label: "古代汉语" },
      { id: "中国古代文学", label: "中国古代文学" },
      { id: "中国现代文学", label: "中国现代文学" },
      { id: "中国当代文学", label: "中国当代文学" },
    ],
    cards: [],
    visibleCards: [],
    visibleLibraryCards: [],
    visibleLibraryAssets: [],
    visibleLibraryCount: 0,
    communityTypes: [
      { id: "all", label: "全部" },
      { id: "question", label: "题目" },
      { id: "question_pack", label: "题包" },
      { id: "note", label: "笔记" },
      { id: "card_pack", label: "卡片集" },
    ],
    activeCommunityType: "all",
    communityAssets: [],
    visibleCommunityAssets: [],
    currentCardIndex: 0,
    expandedCard: null,
    selectedLibraryAsset: null,
  },

  onLoad() {
    this.measureNavigation();
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = wx.getMenuButtonBoundingClientRect();
    const hasCapsuleMetrics = capsule && capsule.width > 0 && capsule.height > 0;
    const statusBarHeight = windowInfo.statusBarHeight || (hasCapsuleMetrics ? capsule.top : 24);
    const capsuleTop = hasCapsuleMetrics ? capsule.top : statusBarHeight + 4;
    const capsuleHeight = hasCapsuleMetrics ? capsule.height : 32;
    const topGap = Math.max(4, capsuleTop - statusBarHeight);
    const navContentHeight = capsuleHeight + topGap * 2;
    this.setData({
      statusBarHeight,
      navContentHeight,
      navTotalHeight: statusBarHeight + navContentHeight,
      capsuleSafeRight: hasCapsuleMetrics ? Math.max(96, windowInfo.windowWidth - capsule.left + 10) : 96,
    });
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的长按工具栏 / 抽屉 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["directoryOpen","directorySortOpen","directoryFilterOpen","searchOpen"]);
  },

  onShow() {
    closeTransientLayers(this, ["directoryOpen","directorySortOpen","directoryFilterOpen","searchOpen"]);
    this.refreshCards();
    this.refreshCommunityFeed();
    const requestedTab = wx.getStorageSync("shukao_knowledge_requested_tab");
    if (requestedTab && tabs.some((tab) => tab.id === requestedTab)) {
      wx.removeStorageSync("shukao_knowledge_requested_tab");
      const selectedTab = tabs.find((tab) => tab.id === requestedTab);
      this.setData({
        activeTab: requestedTab,
        activeDirectoryId: "all",
        libraryMode: false,
        activeTabLabel: requestedTab === "all" ? "为你推荐" : selectedTab.label,
        currentCardIndex: 0,
      }, () => this.applyFilter());
    }
    const tabBar = typeof this.getTabBar === "function" ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 1 });
  },

  refreshCommunityFeed() {
    if (typeof wx.request !== "function" || typeof getApp !== "function") return;
    const baseUrl = String(getApp().globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    wx.request({
      url: `${baseUrl}/api/community/assets`,
      timeout: 7000,
      success: (response) => {
        const assets = response.statusCode === 200 && response.data && response.data.assets;
        if (!Array.isArray(assets)) return;
        const questionPacks = this.data.communityAssets.filter((asset) => asset.type === "question_pack");
        const remoteAssets = assets.map((asset) => ({
          ...asset,
          isRecommended: asset.featured === true || asset.moderationStatus === "featured",
        }));
        this.setData({ communityAssets: [...questionPacks, ...remoteAssets] }, () => this.applyFilter());
      },
    });
    wx.request({
      url: `${baseUrl}/api/packs`,
      timeout: 7000,
      success: (response) => {
        const packs = response.statusCode === 200 && response.data && response.data.packs;
        if (!Array.isArray(packs)) return;
        const communityAssets = this.data.communityAssets.filter((asset) => asset.type !== "question_pack");
        const questionPacks = packs.map((pack) => ({
          ...pack,
          type: "question_pack",
          typeLabel: pack.status === "featured" ? "公共精选题包" : "社区题包",
          title: pack.name,
          excerpt: pack.description,
          contributor: pack.creator && pack.creator.nickname || "社区贡献者",
          catalogPath: `${pack.questionIds.length} 道题`,
          favoriteCount: Number(pack.metrics && pack.metrics.favorites) || 0,
          copyCount: Number(pack.metrics && pack.metrics.copies) || 0,
          isRecommended: pack.status === "featured",
        }));
        this.setData({ communityAssets: [...questionPacks, ...communityAssets] }, () => this.applyFilter());
      },
    });
  },

  refreshCards() {
    // DEC-056：题目笔记与知识卡共用同一份数据，这里直接读卡片，不再有独立的题目笔记存储。
    const personalNotes = listNoteCards().map((note) => {
      const location = [note.setTitle, note.directory].filter(Boolean).join(" · ");
      return {
        id: note.id,
        title: note.title || "题目笔记",
        content: note.content,
        questionId: note.questionId,
        updatedAt: note.updatedAt,
        source: location,
        setId: note.setId,
        questionStem: note.questionStem,
        type: "personal",
        typeLabel: "我的笔记",
        subtitle: location || "题目笔记",
        subject: note.setTitle || "知识卡",
        readMinutes: 1,
        summary: note.content,
        quotes: [],
        features: [],
        isRecommended: false,
      };
    });
    const activity = wx.getStorageSync("shukao_knowledge_activity") || {};
    const reviewIds = wx.getStorageSync("shukao_saved_knowledge_cards") || [];
    const cards = [
      ...officialCards.map((card) => ({ ...card, isRecommended: true })),
      ...personalNotes,
      ...communityNotes.map((card) => ({ ...card, isRecommended: true })),
    ]
      .map((card, index) => decorateCard(card, index, activity, reviewIds));
    const publishedUserAssets = loadAssets()
      .filter((asset) => asset.moderationStatus === "published")
      .map((asset) => ({
        ...asset,
        typeLabel: asset.typeLabel,
        excerpt: asset.excerpt || asset.content || asset.stem || "",
        contributor: "我",
        catalogPath: [asset.subjectName, asset.chapterTitle, asset.sectionTitle].filter(Boolean).join(" / "),
        favoriteCount: Number(asset.favoriteCount) || 0,
        copyCount: Number(asset.copyCount) || 0,
        isRecommended: false,
      }));
    const loadedQuestionPacks = this.data.communityAssets.filter((asset) => asset.type === "question_pack");
    const communityAssets = [
      ...loadedQuestionPacks,
      ...publishedUserAssets,
      ...seededCommunityAssets.map((asset) => ({ ...asset, isRecommended: true })),
    ];
    const requestedCardId = wx.getStorageSync("shukao_knowledge_open_id") || "";
    if (requestedCardId) wx.removeStorageSync("shukao_knowledge_open_id");
    this.setData({ cards, communityAssets }, () => {
      this.applyFilter();
      if (requestedCardId) {
        const requested = cards.find((card) => card.id === requestedCardId);
        if (requested) this.setData({ expandedCard: requested });
      }
    });
  },

  selectTab(event) {
    const activeTab = event.currentTarget.dataset.id;
    const selectedTab = tabs.find((tab) => tab.id === activeTab);
    if (!selectedTab) return;
    this.setData({
      activeTab,
      activeDirectoryId: "all",
      libraryMode: false,
      activeCommunityType: activeTab === "community" ? "all" : this.data.activeCommunityType,
      activeTabLabel: activeTab === "all" ? "为你推荐" : selectedTab.label,
      currentCardIndex: 0,
      directoryOpen: false,
      directorySortOpen: false,
      directoryFilterOpen: false,
    }, () => this.applyFilter());
  },

  selectDirectoryItem(event) {
    const directoryId = event.currentTarget.dataset.id;
    const selectedDirectory = directoryItems.find((item) => item.id === directoryId);
    if (!selectedDirectory) return;
    this.setData({
      activeDirectoryId: directoryId,
      activeLibraryType: directoryId,
      activeLibraryLabel: selectedDirectory.label,
      libraryMode: true,
      query: "",
      searchOpen: false,
      directoryOpen: false,
      directorySortOpen: false,
      directoryFilterOpen: false,
    }, () => this.applyFilter());
  },

  openLibraryAsset(event) {
    const asset = this.data.communityAssets.find((item) => item.id === event.currentTarget.dataset.id);
    if (!asset) return;
    const importedPack = asset.type === "question_pack"
      ? loadPrivatePacks().find((pack) => pack.sourcePackId === asset.id)
      : null;
    const selectedLibraryAsset = {
      ...asset,
      tags: Array.isArray(asset.tags) ? asset.tags : [],
      questions: Array.isArray(asset.questions) ? asset.questions : [],
      detailContent: asset.content || asset.excerpt || asset.description || "暂时没有补充说明。",
      importedPackId: importedPack ? importedPack.id : "",
    };
    this.setData({ selectedLibraryAsset }, () => {
      if (asset.type !== "question_pack") return;
      cachePublicPack(asset);
      wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(asset.id)}&source=public` });
    });
  },

  closeLibraryAsset() {
    this.setData({ selectedLibraryAsset: null });
  },

  openSelectedPack() {
    const asset = this.data.selectedLibraryAsset;
    if (!asset || !asset.importedPackId) return;
    wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(asset.importedPackId)}` });
  },

  collectSelectedLibraryAsset() {
    const asset = this.data.selectedLibraryAsset;
    if (!asset) return;
    this.collectCommunityAsset({ currentTarget: { dataset: { id: asset.id } } });
  },

  showRecommendation() {
    this.setData({
      activeTab: "all",
      activeTabLabel: "为你推荐",
      activeDirectoryId: "all",
      libraryMode: false,
      query: "",
      searchOpen: false,
      currentCardIndex: 0,
      directoryOpen: false,
      directorySortOpen: false,
      directoryFilterOpen: false,
    }, () => this.applyFilter());
  },

  openDirectory() {
    this.setData({ directoryOpen: true, directorySortOpen: false, directoryFilterOpen: false });
  },

  closeDirectory() {
    this.setData({ directoryOpen: false });
  },

  stopTouchMove() {},

  toggleSearch() {
    this.setData({ searchOpen: !this.data.searchOpen, directorySortOpen: false, directoryFilterOpen: false });
  },

  openDirectorySearch() {
    this.setData({ directoryOpen: false, searchOpen: true, directorySortOpen: false, directoryFilterOpen: false });
  },

  toggleDirectorySort() {
    this.setData({ directorySortOpen: !this.data.directorySortOpen, directoryFilterOpen: false, searchOpen: false });
  },

  toggleDirectoryFilter() {
    this.setData({ directoryFilterOpen: !this.data.directoryFilterOpen, directorySortOpen: false, searchOpen: false });
  },

  selectSort(event) {
    this.setData({ sortMode: event.currentTarget.dataset.id, directorySortOpen: false, currentCardIndex: 0 }, () => this.applyFilter());
  },

  selectSubjectFilter(event) {
    this.setData({ subjectFilter: event.currentTarget.dataset.id, directoryFilterOpen: false, currentCardIndex: 0 }, () => this.applyFilter());
  },

  updateSearch(event) {
    this.setData({ query: event.detail.value, currentCardIndex: 0 }, () => this.applyFilter());
  },

  clearSearch() {
    this.setData({ query: "", searchOpen: false, currentCardIndex: 0 }, () => this.applyFilter());
  },

  applyFilter() {
    const query = String(this.data.query || "").trim().toLowerCase();
    const activeTab = this.data.activeTab;
    const subjectFilter = this.data.subjectFilter;
    const sortMode = this.data.sortMode;
    const visibleCards = this.data.cards.filter((card) => {
      const typeMatches = activeTab === "all"
        || card.type === activeTab
        || (activeTab === "notes" && ["personal", "community"].includes(card.type));
      const subjectMatches = subjectFilter === "all" || card.subject === subjectFilter;
      const searchText = [card.title, card.subtitle, card.subject, card.summary, ...(card.features || [])]
        .join(" ").toLowerCase();
      return card.isRecommended === true && typeMatches && subjectMatches && (!query || searchText.includes(query));
    });
    const visibleCommunityAssets = this.data.communityAssets.filter((asset) => {
      const typeMatches = activeTab === "community"
        && (this.data.activeCommunityType === "all" || asset.type === this.data.activeCommunityType);
      const subjectText = [asset.catalogPath, ...(asset.tags || [])].join(" ");
      const subjectMatches = subjectFilter === "all" || subjectText.includes(subjectFilter);
      const searchText = [asset.title, asset.excerpt, asset.contributor, asset.catalogPath, ...(asset.tags || [])].join(" ").toLowerCase();
      return asset.isRecommended === true && typeMatches && subjectMatches && (!query || searchText.includes(query));
    });
    const libraryCardTypes = {
      overview: ["overview"],
      notes: ["personal", "community"],
      question_pack: [],
      recitation: ["recitation"],
    };
    const libraryAssetTypes = {
      overview: ["overview"],
      notes: ["note"],
      question_pack: ["question_pack"],
      recitation: ["card_pack"],
    };
    const visibleLibraryCards = this.data.cards.filter((card) => {
      const typeMatches = (libraryCardTypes[this.data.activeLibraryType] || []).includes(card.type);
      const subjectMatches = subjectFilter === "all" || card.subject === subjectFilter;
      const searchText = [card.title, card.subtitle, card.subject, card.summary, ...(card.features || [])]
        .join(" ").toLowerCase();
      return typeMatches && subjectMatches && (!query || searchText.includes(query));
    });
    const visibleLibraryAssets = this.data.communityAssets.filter((asset) => {
      const typeMatches = (libraryAssetTypes[this.data.activeLibraryType] || []).includes(asset.type);
      const subjectText = [asset.catalogPath, ...(asset.tags || [])].join(" ");
      const subjectMatches = subjectFilter === "all" || subjectText.includes(subjectFilter);
      const searchText = [asset.title, asset.excerpt, asset.contributor, asset.catalogPath, ...(asset.tags || [])].join(" ").toLowerCase();
      return typeMatches && subjectMatches && (!query || searchText.includes(query));
    });
    const sortCards = (items) => [...items].sort((left, right) => {
      if (sortMode === "popular") return (Number(right.favoriteCount) + Number(right.helpfulCount || 0)) - (Number(left.favoriteCount) + Number(left.helpfulCount || 0));
      if (sortMode === "quick") return Number(left.readMinutes || 99) - Number(right.readMinutes || 99);
      return 0;
    });
    const sortAssets = (items) => [...items].sort((left, right) => {
      if (sortMode === "popular") return Number(right.favoriteCount || 0) - Number(left.favoriteCount || 0);
      if (sortMode === "quick") return String(left.excerpt || "").length - String(right.excerpt || "").length;
      return 0;
    });
    const sortedLibraryCards = sortCards(visibleLibraryCards);
    const sortedLibraryAssets = sortAssets(visibleLibraryAssets);
    this.setData({
      visibleCards: sortCards(visibleCards),
      visibleCommunityAssets: sortAssets(visibleCommunityAssets),
      visibleLibraryCards: sortedLibraryCards,
      visibleLibraryAssets: sortedLibraryAssets,
      visibleLibraryCount: sortedLibraryCards.length + sortedLibraryAssets.length,
      currentCardIndex: Math.min(this.data.currentCardIndex, Math.max(0, visibleCards.length - 1)),
    });
  },

  selectCommunityType(event) {
    this.setData({ activeCommunityType: event.currentTarget.dataset.id, activeDirectoryId: "all" }, () => this.applyFilter());
  },

  collectCommunityAsset(event) {
    const asset = this.data.communityAssets.find((item) => item.id === event.currentTarget.dataset.id);
    if (!asset) return;
    if (asset.type === "question_pack") {
      const existingPack = loadPrivatePacks().find((pack) => pack.sourcePackId === asset.id);
      if (existingPack) {
        wx.showToast({ title: "该题包已导入", icon: "none" });
        return;
      }
      const questionIds = (asset.questions || []).map((question) => saveAsset({
        type: "question",
        title: question.stem.slice(0, 42),
        stem: question.stem,
        questionType: question.typeLabel,
        typeCode: question.type,
        optionsText: (question.options || []).map((option) => `${option.key}. ${option.text}`).join("\n"),
        correctAnswer: question.correctAnswer,
        referenceAnswer: question.referenceAnswer,
        scoringPoints: question.scoringPoints,
        scoringPointsText: (question.scoringPoints || []).map((point) => point.description).join("\n"),
        subjectId: question.subjectId,
        chapterTitle: question.chapter,
        knowledgePoints: question.knowledgePoints,
        tags: asset.tags,
        sourceReference: question.sourceLabel,
        sourceAssetId: `${asset.id}:${question.id}`,
        ownership: "collected",
        originality: "collected",
        visibility: "private",
        moderationStatus: "private",
      }).id);
      const pack = copyCommunityPack({ ...asset, name: asset.title, questionIds });
      if (pack && this.data.selectedLibraryAsset && this.data.selectedLibraryAsset.id === asset.id) {
        this.setData({ selectedLibraryAsset: { ...this.data.selectedLibraryAsset, importedPackId: pack.id } });
      }
      wx.showToast({ title: pack ? "已导入私人题库" : "导入失败", icon: pack ? "success" : "none" });
      return;
    }
    const collected = collectAsset(asset);
    if (collected && this.data.selectedLibraryAsset && this.data.selectedLibraryAsset.id === asset.id) {
      this.setData({ selectedLibraryAsset: { ...this.data.selectedLibraryAsset, copied: true } });
    }
    wx.showToast({ title: collected ? "已复制到我的资产" : "复制失败", icon: collected ? "success" : "none" });
    // 复制计数按“人 × 内容”去重，且只有登录才计数；未登录只做本地复制，不产生计数。
    const collectApp = typeof getApp === "function" ? getApp() : null;
    if (collected && collectApp && collectApp.globalData.authToken && typeof wx.request === "function") {
      const baseUrl = String(collectApp.globalData.apiBaseUrl || "").replace(/\/$/, "");
      if (baseUrl && asset.id.startsWith("community-")) {
        wx.request({
          url: `${baseUrl}/api/community/assets/${encodeURIComponent(asset.id)}/collect`,
          method: "POST",
          header: collectApp.authHeader(),
        });
      }
    }
  },

  changeCard(event) {
    this.setData({ currentCardIndex: event.detail.current });
  },

  openCard(event) {
    const card = this.data.cards.find((item) => item.id === event.currentTarget.dataset.id);
    if (card) this.setData({ expandedCard: card });
  },

  closeCard() {
    this.setData({ expandedCard: null });
  },

  updateActivity(cardId, updater) {
    const activity = wx.getStorageSync("shukao_knowledge_activity") || {};
    activity[cardId] = updater(activity[cardId] || {});
    wx.setStorageSync("shukao_knowledge_activity", activity);
    this.refreshCards();
  },

  toggleFavorite(event) {
    const id = event.currentTarget.dataset.id;
    const card = this.data.cards.find((item) => item.id === id);
    const app = typeof getApp === "function" ? getApp() : null;
    // 收藏是引用关系：登录后由服务端按“人 × 内容”记录并计数（重复点不刷数）；未登录仍只在本地记录。
    const serverBacked = Boolean(app && app.globalData.authToken && typeof id === "string" && id.startsWith("community-"));
    this.updateActivity(id, (record) => {
      const favorited = record.favorited !== true;
      if (serverBacked && typeof wx.request === "function") {
        const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
        if (baseUrl) {
          wx.request({
            url: `${baseUrl}/api/community/assets/${encodeURIComponent(id)}/${favorited ? "favorite" : "unfavorite"}`,
            method: "POST",
            header: app.authHeader(),
            success: (response) => {
              const serverAsset = response && response.data && response.data.asset;
              if (!serverAsset) return;
              // 计数以服务端为准，避免本地累加与服务端去重结果不一致。
              this.updateActivity(id, (current) => ({ ...current, favoriteCount: Math.max(0, Number(serverAsset.favoriteCount) || 0) }));
            },
          });
        }
      }
      return { ...record, favorited, favoriteCount: Math.max(0, Number(card.favoriteCount) + (favorited ? 1 : -1)) };
    });
  },

  toggleHelpful(event) {
    const id = event.currentTarget.dataset.id;
    this.updateActivity(id, (record) => {
      const helpful = record.helpful !== true;
      const card = this.data.cards.find((item) => item.id === id);
      return { ...record, helpful, helpfulCount: Math.max(0, Number(card.helpfulCount) + (helpful ? 1 : -1)) };
    });
  },

  addComment(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: "写评论",
      editable: true,
      placeholderText: "说说这张卡片对你是否有帮助",
      success: (result) => {
        const content = String(result.content || "").trim();
        if (!result.confirm || !content) return;
        this.updateActivity(id, (record) => ({
          ...record,
          comments: [{ id: `comment-${Date.now()}`, content, createdAt: Date.now() }, ...(record.comments || [])],
        }));
        wx.showToast({ title: "评论已发布", icon: "success" });
      },
    });
  },

  addToReview(event) {
    const id = event.currentTarget.dataset.id;
    const saved = wx.getStorageSync("shukao_saved_knowledge_cards") || [];
    if (!saved.includes(id)) saved.unshift(id);
    wx.setStorageSync("shukao_saved_knowledge_cards", saved);
    const expandedCard = this.data.expandedCard && this.data.expandedCard.id === id
      ? { ...this.data.expandedCard, inReview: true }
      : this.data.expandedCard;
    this.setData({ expandedCard });
    this.refreshCards();
    wx.showToast({ title: "已加入复习", icon: "success" });
  },
});
