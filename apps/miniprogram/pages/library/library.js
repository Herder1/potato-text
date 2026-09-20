const { subjects } = require("../../data/catalog");
const { closeTransientLayers } = require("../../utils/page-layers");
const { loadAssets, releaseAssetsFromPack, saveAsset } = require("../../utils/asset-store");
const { catalogWithQuestionCounts } = require("../../utils/question-sync");
const { isMasteredReviewState, normalizeReviewStates } = require("../../utils/review-schedule");
const {
  CONTENT_TABS,
  EXAM_CATEGORIES,
  filterLibraryExams,
  normalizeLibraryExam,
  normalizeMaterial,
  normalizePublicPack,
} = require("../../utils/library-content");
const {
  copyCommunityPack,
  createPrivatePack,
  createPrivatePackCategory,
  deletePrivatePack,
  deletePrivatePackCategory,
  loadPrivatePackCategories,
  loadPrivatePacks,
  renamePrivatePackCategory,
  savePrivatePack,
} = require("../../utils/private-pack-store");
const { cachePublicPack } = require("../../utils/pack-collection");

function createAllBooks(catalogSubjects, questions = [], reviewStates = {}) {
  const learningByBook = (Array.isArray(questions) ? questions : []).reduce((counts, question) => {
    const state = reviewStates[question.id];
    if (!state) return counts;
    const bookState = counts[question.bookId] || { studied: 0, mastered: 0, review: 0 };
    bookState.studied += 1;
    if (isMasteredReviewState(state)) bookState.mastered += 1;
    else if (!state.removedManually) bookState.review += 1;
    counts[question.bookId] = bookState;
    return counts;
  }, {});
  return catalogSubjects.flatMap((subject) =>
    subject.books.map((book) => {
      const learning = learningByBook[book.id] || { studied: 0, mastered: 0, review: 0 };
      const titleMatch = String(book.title || "").match(/^(.*?)（(.+)）$/);
      const displayTitle = titleMatch ? titleMatch[1] : book.title;
      const editionInfo = [titleMatch ? titleMatch[2] : "", book.volume].filter(Boolean).join(" · ");
      const isCompleted = book.questionCount > 0 && learning.mastered >= book.questionCount;
      return {
        ...book,
        displayTitle,
        editionInfo,
        isCompleted,
        stateLabel: isCompleted ? "已完成" : learning.studied > 0 ? "学习中" : "待学习",
        progressLabel: book.questionCount === 0
          ? "题目整理中"
          : isCompleted
            ? "已完成"
            : learning.studied > 0
              ? `已掌握 ${learning.mastered} / ${book.questionCount}`
              : `共${book.questionCount}题 · 尚未开始`,
        subjectId: subject.id,
        subjectName: subject.name,
        subjectColor: subject.color,
        progress: book.questionCount ? Math.round((learning.mastered / book.questionCount) * 100) : 0,
        studiedCount: learning.studied,
        masteredCount: learning.mastered,
        reviewCount: learning.review,
      };
    }));
}

function createCatalogDirectory(catalogSubjects) {
  return catalogSubjects.map((subject) => ({
    id: subject.id,
    name: subject.name,
    books: subject.books.map((book) => ({
      id: book.id,
      name: `${book.title}${book.volume ? ` ${book.volume}` : ""}`,
      questionCount: book.questionCount,
    })),
  }));
}

const initialCatalogSubjects = catalogWithQuestionCounts(subjects, []);
const allBooks = createAllBooks(initialCatalogSubjects);
const catalogDirectory = createCatalogDirectory(initialCatalogSubjects);

function createNavigationMetrics(windowInfo = {}, capsule = {}) {
  const windowWidth = Number(windowInfo.windowWidth) || 375;
  const hasCapsuleMetrics = capsule
    && Number(capsule.width) > 0
    && Number(capsule.height) > 0
    && Number.isFinite(Number(capsule.left))
    && Number(capsule.left) > 0;
  const statusBarHeight = Number(windowInfo.statusBarHeight)
    || (hasCapsuleMetrics ? Number(capsule.top) : 24);
  const capsuleTop = hasCapsuleMetrics ? Number(capsule.top) : statusBarHeight + 4;
  const capsuleHeight = hasCapsuleMetrics ? Number(capsule.height) : 32;
  const topGap = Math.max(4, capsuleTop - statusBarHeight);
  const navContentHeight = capsuleHeight + topGap * 2;
  const defaultDrawerInset = 28 * windowWidth / 750;
  const drawerRight = Math.min(windowWidth * 0.82, 650 * windowWidth / 750);
  const drawerHeadSafeRight = hasCapsuleMetrics
    ? Math.max(defaultDrawerInset, drawerRight - Number(capsule.left) + 8)
    : defaultDrawerInset;

  return {
    statusBarHeight,
    navContentHeight,
    navTotalHeight: statusBarHeight + navContentHeight,
    capsuleSafeRight: hasCapsuleMetrics ? Math.max(96, windowWidth - Number(capsule.left) + 10) : 96,
    drawerHeadSafeRight: Math.ceil(drawerHeadSafeRight),
    windowHeight: Number(windowInfo.windowHeight) || 667,
  };
}

Page({
  data: {
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    drawerHeadSafeRight: 14,
    windowHeight: 667,
    drawerOpen: false,
    activeProjectId: "chinese-literature-foundation",
    activeProjectName: "汉语言文学题库",
    activeProjectSubjects: ["现代汉语", "古代汉语", "中国古代文学", "中国现代文学", "中国当代文学"],
    projects: [
      {
        id: "chinese-literature-foundation",
        name: "汉语言文学题库",
        detail: "广东专升本",
        enabled: true,
        subjects: ["现代汉语", "古代汉语", "中国古代文学", "中国现代文学", "中国当代文学"],
      },
      {
        id: "teacher-qualification",
        name: "教师资格证",
        shortName: "教",
        detail: "题库筹备中",
        enabled: false,
        subjects: [],
      },
      {
        id: "civil-service",
        name: "公务员考试",
        shortName: "公",
        detail: "题库筹备中",
        enabled: false,
        subjects: [],
      },
    ],
    activeSource: "official",
    activeSourceIndex: 0,
    activeSourceName: "平台题库",
    activeSourceLabel: "平台",
    sourceOptions: [
      { id: "official", name: "平台题库", label: "平台" },
      { id: "private", name: "我的题库", label: "我的" },
      { id: "public", name: "共创题库", label: "共创" },
    ],
    sourceMenuOpen: false,
    sourceByTab: {
      books: "official",
      packs: "official",
      materials: "official",
    },
    contentTabs: CONTENT_TABS,
    activeContentTab: "books",
    publicPacks: [],
    visiblePublicPacks: [],
    exams: [],
    visibleExams: [],
    examCategoryOptions: EXAM_CATEGORIES.map((item) => ({ ...item, count: 0 })),
    activeExamCategoryId: "all",
    activeExamCategoryName: "全部试卷",
    materials: [],
    ownedMaterials: [],
    contentLoading: false,
    contentLoadFailed: false,
    examLoading: false,
    examLoadFailed: false,
    selectedPublicPack: null,
    selectedMaterial: null,
    query: "",
    allBooks,
    visibleBooks: allBooks,
    catalogDirectory: catalogDirectory.map((subject, index) => ({ ...subject, expanded: index === 0 })),
    activeCatalogSubjectId: "",
    activeCatalogBookId: "",
    expandedCatalogSubjectIds: subjects.length ? [subjects[0].id] : [],
    privatePacks: [],
    visiblePrivatePacks: [],
    privateCategories: [],
    privateSystemRows: [
      { id: "uncategorized", name: "未分类", count: 0 },
      { id: "imported", name: "导入题包", count: 0 },
      { id: "created", name: "原创题包", count: 0 },
    ],
    privateFolderRows: [],
    privateCategoryTree: [],
    privateCategoryOptions: [],
    expandedPrivateCategoryIds: [],
    activePrivateCategoryId: "all",
    activePrivateCategoryName: "全部题包",
    selectedPack: null,
    packActionsOpen: false,
    categoryActionsOpen: false,
    packActionTop: 220,
    selectedCategory: null,
    categoryManageOpen: false,
    categoryManageTop: 220,
    actionMenuOpen: false,
  },

  onLoad() {
    this.measureNavigation();
    this.restoreSourcePreferences();
  },

  onShow() {
    // 回到本页先收掉所有瞬态浮层：长按题包/分类弹出的工具栏带全屏遮罩，
    // 若跨页残留会变成“页面能滚、按钮全点不动”的隐形拦截层。
    this.resetTransientOverlays();
    this.refreshPrivateLibrary();
    this.refreshOwnedMaterials();
    this.syncOfficialLibrary();
    this.loadLibraryContent();
    const requested = wx.getStorageSync("shukao_library_requested_content");
    if (requested && requested.tab) {
      wx.removeStorageSync("shukao_library_requested_content");
      this._pendingRequestedContent = requested;
      this.setData(this.contentTabPatch(requested.tab), () => {
        this.revealRequestedContent();
      });
    }
    const tabBar = typeof this.getTabBar === "function" ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 0 });
  },

  onHide() {
    this.resetTransientOverlays();
  },

  resetTransientOverlays() {
    closeTransientLayers(this, ["packActionsOpen", "categoryActionsOpen", "categoryManageOpen", "sourceMenuOpen", "actionMenuOpen", "drawerOpen"], {
      selectedPack: null,
      selectedCategory: null,
    });
  },

  loadLibraryContent() {
    const app = getApp();
    const apiBaseUrls = typeof app.apiBaseUrlCandidates === "function"
      ? app.apiBaseUrlCandidates()
      : [String(app.globalData.apiBaseUrl || "").replace(/\/$/, "")].filter(Boolean);
    if (!apiBaseUrls.length || typeof wx.request !== "function") {
      this.setData({ contentLoadFailed: true, examLoading: false, examLoadFailed: true });
      return;
    }
    this.setData({ contentLoading: true, contentLoadFailed: false, examLoading: true, examLoadFailed: false });
    let pending = 3;
    let failed = 0;
    const finish = (success) => {
      if (!success) failed += 1;
      pending -= 1;
      if (pending > 0) return;
      this.setData({ contentLoading: false, contentLoadFailed: failed > 0 }, () => {
        this.applyFilters();
        this.revealRequestedContent();
      });
    };
    const requestResource = (path, accept, onFailed = () => {}) => {
      const requestAt = (index) => {
        const baseUrl = apiBaseUrls[index];
        if (!baseUrl) {
          onFailed();
          finish(false);
          return;
        }
        wx.request({
          url: `${baseUrl}${path}`,
          timeout: 6000,
          success: (response) => {
            if (!accept(response)) { requestAt(index + 1); return; }
            app.globalData.apiBaseUrl = baseUrl;
            finish(true);
          },
          fail: () => requestAt(index + 1),
        });
      };
      requestAt(0);
    };
    requestResource("/api/packs", (response) => {
      const records = response.statusCode === 200 && response.data && response.data.packs;
      if (!Array.isArray(records)) return false;
      this.setData({ publicPacks: records.map(normalizePublicPack).filter((item) => item.id) }, () => {
        this.applyFilters();
        this.revealRequestedContent();
      });
      return true;
    });
    requestResource("/api/exams", (response) => {
      const records = response.statusCode === 200 && response.data && response.data.exams;
      if (!Array.isArray(records)) return false;
      this.setData({
        exams: records.map(normalizeLibraryExam).filter((item) => item.id && item.questionCount),
        examLoading: false,
        examLoadFailed: false,
      }, () => {
        this.applyFilters();
        this.revealRequestedContent();
      });
      return true;
    }, () => this.setData({ examLoading: false, examLoadFailed: true }, () => this.applyFilters()));
    requestResource("/api/discovery", (response) => {
      const records = response.statusCode === 200 && response.data && response.data.products;
      if (!Array.isArray(records)) return false;
      this.setData({ materials: records.filter((item) => item.kind === "material").map(normalizeMaterial) }, () => {
        this.applyFilters();
        this.revealRequestedContent();
      });
      return true;
    });
  },

  retryLibraryContent() {
    if (this.data.contentLoading || this.data.examLoading) return;
    this.loadLibraryContent();
  },

  revealRequestedContent() {
    const requested = this._pendingRequestedContent;
    if (!requested || !requested.id) return;
    if (requested.tab === "packs") {
      const pack = this.data.publicPacks.find((item) => item.id === requested.id);
      if (!pack) return;
      this._pendingRequestedContent = null;
      this.openPackCollection(pack, "public");
    }
    if (requested.tab === "materials") {
      const material = this.data.materials.find((item) => item.id === requested.id);
      if (!material) return;
      this._pendingRequestedContent = null;
      this.setData({ selectedMaterial: material });
    }
  },

  syncOfficialLibrary() {
    const app = getApp();
    const refreshBooks = (questions, metadata = {}) => {
      const countedSubjects = catalogWithQuestionCounts(subjects, questions, this._officialBookCounts || null);
      const reviewStates = normalizeReviewStates(wx.getStorageSync("shukao_review_states"));
      const nextBooks = createAllBooks(countedSubjects, questions, reviewStates);
      const expanded = new Set(this.data.expandedCatalogSubjectIds);
      this.setData({
        allBooks: nextBooks,
        catalogDirectory: createCatalogDirectory(countedSubjects).map((subject) => ({
          ...subject,
          expanded: expanded.has(subject.id),
        })),
      }, () => this.applyFilters());
      if (metadata.source === "unavailable" && !this._officialBookCounts) {
        wx.showToast({ title: "题库同步失败，请检查本地服务", icon: "none" });
      }
    };
    refreshBooks(app.globalData.officialQuestions || [], { source: "memory" });
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || typeof wx.request !== "function") return;
    wx.request({
      url: `${baseUrl}/api/questions?library=official&summary=1`,
      method: "GET",
      timeout: 6000,
      success: (response) => {
        const counts = response && response.statusCode === 200 && response.data && response.data.counts;
        if (!counts || !counts.byBook) return;
        this._officialBookCounts = counts.byBook;
        refreshBooks(app.globalData.officialQuestions || []);
      },
    });
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
      ? wx.getMenuButtonBoundingClientRect()
      : {};
    this.setData(createNavigationMetrics(windowInfo, capsule));
  },

  refreshPrivateLibrary() {
    const privateCategories = loadPrivatePackCategories();
    const categoryMap = new Map(privateCategories.map((category) => [category.id, category.name]));
    const privatePacks = loadPrivatePacks().map((pack) => ({
      ...pack,
      categoryName: pack.categoryId && categoryMap.get(pack.categoryId) || "未分类",
    }));
    const rootCategories = privateCategories.filter((category) => !category.parentId);
    const privateCategoryTree = rootCategories.map((category) => {
      const children = privateCategories
        .filter((child) => child.parentId === category.id)
        .map((child) => {
          const books = privateCategories
            .filter((book) => book.parentId === child.id)
            .map((book) => ({
              ...book,
              level: 3,
              count: privatePacks.filter((pack) => pack.categoryId === book.id).length,
            }));
          return {
            ...child,
            level: 2,
            children: books,
            expanded: this.data.expandedPrivateCategoryIds.includes(child.id),
            count: privatePacks.filter((pack) => pack.categoryId === child.id || books.some((book) => book.id === pack.categoryId)).length,
          };
        });
      const descendantIds = new Set(children.flatMap((child) => [child.id, ...child.children.map((book) => book.id)]));
      return {
        ...category,
        level: 1,
        children,
        expanded: this.data.expandedPrivateCategoryIds.includes(category.id),
        count: privatePacks.filter((pack) => pack.categoryId === category.id || descendantIds.has(pack.categoryId)).length,
      };
    });
    const privateCategoryOptions = privateCategoryTree.flatMap((category) => [
      category,
      ...category.children.flatMap((child) => [child, ...child.children]),
    ]);
    const privateSystemRows = [
      { id: "uncategorized", name: "未分类", count: privatePacks.filter((pack) => !pack.categoryId).length },
      { id: "imported", name: "导入题包", count: privatePacks.filter((pack) => pack.source === "community_import").length },
      { id: "created", name: "原创题包", count: privatePacks.filter((pack) => pack.source !== "community_import").length },
    ];
    const privateFolderRows = [...privateSystemRows, ...privateCategoryOptions];
    const activeFolder = this.data.activePrivateCategoryId === "all"
      ? { id: "all", name: "全部题包" }
      : privateFolderRows.find((folder) => folder.id === this.data.activePrivateCategoryId) || { id: "all", name: "全部题包" };
    this.setData({
      privatePacks,
      privateCategories,
      privateSystemRows,
      privateFolderRows,
      privateCategoryTree,
      privateCategoryOptions,
      activePrivateCategoryId: activeFolder.id,
      activePrivateCategoryName: activeFolder.name,
    }, () => this.applyFilters());
  },

  refreshOwnedMaterials() {
    const ownedMaterials = loadAssets()
      .filter((asset) => asset.type !== "question" && asset.type !== "question_pack")
      .map((asset) => ({
        ...asset,
        kindLabel: asset.typeLabel || (asset.type === "note" ? "笔记" : "资料"),
        badge: asset.statusLabel || (asset.ownership === "collected" ? "已导入" : "我的创作"),
        subtitle: asset.excerpt || asset.content || "暂未填写内容",
      }));
    this.setData({ ownedMaterials });
  },

  openProjectDrawer() {
    this.setData({ drawerOpen: true, actionMenuOpen: false, sourceMenuOpen: false });
  },

  closeProjectDrawer() {
    this.setData({ drawerOpen: false });
  },

  stopTouchMove() {},

  selectProject(event) {
    const project = this.data.projects.find((item) => item.id === event.currentTarget.dataset.id);
    if (!project) return;
    if (!project.enabled) {
      wx.showToast({ title: "该项目正在筹备", icon: "none" });
      return;
    }
    this.setData({
      activeProjectId: project.id,
      activeProjectName: project.name,
      activeProjectSubjects: project.subjects,
      activeCatalogSubjectId: "",
      activeCatalogBookId: "",
      activeExamCategoryId: "all",
      activeExamCategoryName: "全部试卷",
      drawerOpen: false,
      sourceMenuOpen: false,
    }, () => this.applyFilters());
  },

  restoreSourcePreferences() {
    const sourceByTab = { ...this.data.sourceByTab };
    Object.keys(sourceByTab).forEach((tab) => {
      const stored = wx.getStorageSync(`shukao_library_source_${tab}`);
      if (this.data.sourceOptions.some((source) => source.id === stored)) sourceByTab[tab] = stored;
    });
    const source = this.data.sourceOptions.find((item) => item.id === sourceByTab[this.data.activeContentTab])
      || this.data.sourceOptions[0];
    this.setData({
      sourceByTab,
      activeSource: source.id,
      activeSourceIndex: this.data.sourceOptions.findIndex((item) => item.id === source.id),
      activeSourceName: source.name,
      activeSourceLabel: source.label,
    }, () => this.applyFilters());
  },

  contentTabPatch(activeContentTab) {
    const patch = { activeContentTab, actionMenuOpen: false, sourceMenuOpen: false };
    const sourceId = this.data.sourceByTab[activeContentTab];
    if (!sourceId) return patch;
    const source = this.data.sourceOptions.find((item) => item.id === sourceId) || this.data.sourceOptions[0];
    return {
      ...patch,
      activeSource: source.id,
      activeSourceIndex: this.data.sourceOptions.findIndex((item) => item.id === source.id),
      activeSourceName: source.name,
      activeSourceLabel: source.label,
    };
  },

  applySource(sourceId) {
    const activeSourceIndex = this.data.sourceOptions.findIndex((source) => source.id === sourceId);
    const source = this.data.sourceOptions[activeSourceIndex];
    if (!source) return;
    const activeContentTab = this.data.activeContentTab;
    const sourceByTab = this.data.sourceByTab[activeContentTab]
      ? { ...this.data.sourceByTab, [activeContentTab]: source.id }
      : this.data.sourceByTab;
    if (this.data.sourceByTab[activeContentTab]) {
      wx.setStorageSync(`shukao_library_source_${activeContentTab}`, source.id);
    }
    this.setData({
      activeSource: source.id,
      activeSourceIndex,
      activeSourceName: source.name,
      activeSourceLabel: source.label,
      sourceByTab,
      sourceMenuOpen: false,
      drawerOpen: false,
    }, () => this.applyFilters());
  },

  toggleSourceMenu() {
    this.setData({
      sourceMenuOpen: !this.data.sourceMenuOpen,
      drawerOpen: false,
      actionMenuOpen: false,
    });
  },

  closeSourceMenu() {
    this.setData({ sourceMenuOpen: false });
  },

  selectQuickSource(event) {
    this.applySource(event.currentTarget.dataset.id);
  },

  changeSource(event) {
    const activeSourceIndex = Number(event.detail.value);
    const source = this.data.sourceOptions[activeSourceIndex];
    if (source) this.applySource(source.id);
  },

  selectContentTab(event) {
    const activeContentTab = event.currentTarget.dataset.id;
    if (!CONTENT_TABS.some((tab) => tab.id === activeContentTab)) return;
    this.setData(this.contentTabPatch(activeContentTab), () => this.applyFilters());
  },

  toggleActionMenu() {
    this.setData({ actionMenuOpen: !this.data.actionMenuOpen });
  },

  createLibraryPack() {
    this.setData({ actionMenuOpen: false });
    wx.showModal({
      title: "新建题包",
      editable: true,
      placeholderText: "例如：现代汉语语法易错题",
      success: (result) => {
        const name = String(result.content || "").trim();
        if (!result.confirm || !name) return;
        const pack = createPrivatePack({ name });
        this.refreshPrivateLibrary();
        wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(pack.id)}` });
      },
    });
  },

  contributeQuestionFromLibrary() {
    this.setData({ actionMenuOpen: false });
    wx.navigateTo({ url: "/pages/packs/packs?intent=addQuestion" });
  },

  createNoteFromLibrary() {
    this.setData({ actionMenuOpen: false });
    wx.navigateTo({ url: "/pages/note-editor/note-editor" });
  },

  openLibrarySearch() {
    const tab = CONTENT_TABS.find((item) => item.id === this.data.activeContentTab) || CONTENT_TABS[0];
    wx.navigateTo({ url: `/pages/library-search/library-search?scope=${tab.searchScope}` });
  },

  search(event) {
    this.setData({ query: event.detail.value.trim() }, () => this.applyFilters());
  },

  applyFilters() {
    const { query, allBooks, privatePacks, activePrivateCategoryId, activeCatalogSubjectId, activeCatalogBookId, privateCategories } = this.data;
    const visibleBooks = allBooks.filter((book) => {
      const queryMatch = !query || `${book.title}${book.volume}${book.author}${book.subjectName}`.includes(query);
      const catalogMatches = activeCatalogBookId
        ? book.id === activeCatalogBookId
        : (!activeCatalogSubjectId || book.subjectId === activeCatalogSubjectId);
      return queryMatch && catalogMatches;
    });
    const childCategoryIds = new Set();
    if (privateCategories.some((category) => category.id === activePrivateCategoryId)) {
      childCategoryIds.add(activePrivateCategoryId);
      let discovered = true;
      while (discovered) {
        discovered = false;
        privateCategories.forEach((category) => {
          if (childCategoryIds.has(category.parentId) && !childCategoryIds.has(category.id)) {
            childCategoryIds.add(category.id);
            discovered = true;
          }
        });
      }
      childCategoryIds.delete(activePrivateCategoryId);
    }
    const visiblePrivatePacks = privatePacks.filter((pack) => {
      const searchText = [pack.name, pack.description, ...(pack.tags || [])].join(" ").toLowerCase();
      const categoryMatches = activePrivateCategoryId === "all"
        || (activePrivateCategoryId === "uncategorized" && !pack.categoryId)
        || (activePrivateCategoryId === "imported" && pack.source === "community_import")
        || (activePrivateCategoryId === "created" && pack.source !== "community_import")
        || pack.categoryId === activePrivateCategoryId
        || childCategoryIds.has(pack.categoryId);
      return categoryMatches && (!query || searchText.includes(query.toLowerCase()));
    });
    const visiblePublicPacks = this.data.publicPacks.filter((pack) => {
      if (this.data.activeSource === "official") return pack.sourceType === "official";
      if (this.data.activeSource === "public") return pack.sourceType === "public";
      return false;
    });
    const visibleExams = filterLibraryExams(this.data.exams, this.data.activeExamCategoryId);
    const examCategoryOptions = EXAM_CATEGORIES.map((category) => ({
      ...category,
      count: filterLibraryExams(this.data.exams, category.id).length,
    }));
    this.setData({ visibleBooks, visiblePrivatePacks, visiblePublicPacks, visibleExams, examCategoryOptions });
  },

  selectExamCategory(event) {
    const id = event.currentTarget.dataset.id;
    const category = EXAM_CATEGORIES.find((item) => item.id === id);
    if (!category) return;
    this.setData({
      activeExamCategoryId: category.id,
      activeExamCategoryName: category.name,
      drawerOpen: false,
    }, () => this.applyFilters());
  },

  startBook(event) {
    wx.navigateTo({ url: `/pages/practice/practice?bookId=${event.currentTarget.dataset.id}&resume=1` });
  },

  openPrivatePack(event) {
    if (this._longPressAt && Date.now() - this._longPressAt < 500) return;
    const pack = this.data.privatePacks.find((item) => item.id === event.currentTarget.dataset.id);
    if (pack) this.openPackCollection(pack, "private");
  },

  openPackCollection(pack, source = "public") {
    if (!pack || !pack.id) return;
    if (source !== "private") cachePublicPack(pack);
    wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(pack.id)}&source=${encodeURIComponent(source)}` });
  },

  openPublicPack(event) {
    const selectedPublicPack = this.data.publicPacks.find((pack) => pack.id === event.currentTarget.dataset.id);
    if (selectedPublicPack) this.openPackCollection(selectedPublicPack, "public");
  },

  closePublicPack() {
    this.setData({ selectedPublicPack: null });
  },

  importPublicPack() {
    const pack = this.data.selectedPublicPack;
    if (!pack) return;
    const existing = loadPrivatePacks().find((item) => item.sourcePackId === pack.id);
    if (existing) {
      wx.showToast({ title: "该题包已导入", icon: "none" });
      return;
    }
    const questionIds = (pack.questions || []).map((question) => saveAsset({
      type: "question",
      title: String(question.stem || "题目").slice(0, 42),
      stem: question.stem,
      questionType: question.typeLabel,
      typeCode: question.type,
      optionsText: (question.options || []).map((option) => `${option.key}. ${option.text}`).join("\n"),
      correctAnswer: question.correctAnswer,
      referenceAnswer: question.referenceAnswer,
      scoringPoints: question.scoringPoints,
      subjectId: question.subjectId,
      chapterTitle: question.chapter,
      knowledgePoints: question.knowledgePoints,
      tags: pack.tags,
      sourceReference: question.sourceLabel || pack.sourceLabel,
      sourceAssetId: `${pack.id}:${question.id}`,
      ownership: "collected",
      originality: "collected",
      visibility: "private",
      moderationStatus: "private",
    }).id);
    const imported = copyCommunityPack({ ...pack, questionIds });
    if (imported) {
      this.setData({ selectedPublicPack: null });
      this.refreshPrivateLibrary();
    }
    wx.showToast({ title: imported ? "已导入我的题库" : "导入失败", icon: imported ? "success" : "none" });
  },

  startPublishedExam(event) {
    const exam = this.data.visibleExams.find((item) => item.id === event.currentTarget.dataset.id)
      || this.data.exams.find((item) => item.id === event.currentTarget.dataset.id);
    if (!exam) return;
    wx.showModal({
      title: exam.title,
      content: `本次 ${exam.questionCount} 题，限时 ${exam.durationMinutes} 分钟。交卷后统一查看答案与解析。`,
      confirmText: "开始考试",
      success: (result) => {
        if (!result.confirm) return;
        wx.navigateTo({ url: `/pages/practice/practice?mode=exam&count=${exam.questionCount}&duration=${exam.durationMinutes}&examId=${encodeURIComponent(exam.id)}` });
      },
    });
  },

  openMaterial(event) {
    const selectedMaterial = this.data.materials.find((item) => item.id === event.currentTarget.dataset.id);
    if (selectedMaterial) this.setData({ selectedMaterial });
  },

  openOwnedMaterial(event) {
    const asset = this.data.ownedMaterials.find((item) => item.id === event.currentTarget.dataset.id);
    if (!asset) return;
    if (asset.type === "note") {
      const page = asset.draftId && asset.draftStage === "metadata" ? "note-meta/note-meta" : "note-editor/note-editor";
      const key = asset.draftId ? `draftId=${encodeURIComponent(asset.draftId)}` : `noteId=${encodeURIComponent(asset.id)}`;
      wx.navigateTo({ url: `/pages/${page}?${key}` });
      return;
    }
    this.setData({
      selectedMaterial: {
        ...asset,
        description: asset.content || asset.excerpt || "暂未填写内容",
        priceLabel: asset.ownership === "collected" ? "从知识库导入" : "我的创作",
      },
    });
  },

  closeMaterial() {
    this.setData({ selectedMaterial: null });
  },

  openPrivatePackActions(event) {
    const id = event.currentTarget.dataset.id;
    const selectedPack = this.data.privatePacks.find((pack) => pack.id === id);
    if (!selectedPack) return;
    this._longPressAt = Date.now();
    const touch = event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0];
    const fallbackTop = Math.max(this.data.navTotalHeight + 8, (touch ? Number(touch.clientY) : 260) - 52);
    this.setData({ selectedPack, packActionsOpen: true, categoryActionsOpen: false, packActionTop: fallbackTop }, () => {
      this.positionPrivatePackActions(id, fallbackTop);
    });
  },

  positionPrivatePackActions(packId, fallbackTop) {
    if (typeof wx.createSelectorQuery !== "function") return;
    const query = wx.createSelectorQuery();
    query.select(`#private-pack-${packId}`).boundingClientRect();
    query.select(".pack-action-panel").boundingClientRect();
    query.exec((results = []) => {
      const cardRect = results[0];
      const panelRect = results[1];
      if (!cardRect) return;
      const panelHeight = panelRect && panelRect.height || 42;
      const preferredTop = cardRect.top - panelHeight - 8;
      const belowTop = cardRect.bottom + 8;
      const top = preferredTop > this.data.navTotalHeight + 6
        ? preferredTop
        : Math.min(belowTop, this.data.windowHeight - panelHeight - 16);
      this.setData({ packActionTop: Number.isFinite(top) ? top : fallbackTop });
    });
  },

  closePrivatePackActions() {
    this.setData({ selectedPack: null, packActionsOpen: false, categoryActionsOpen: false });
  },

  editPrivatePack() {
    const pack = this.data.selectedPack;
    if (!pack) return;
    wx.showModal({
      title: "编辑题包名",
      editable: true,
      content: pack.name,
      placeholderText: "输入题包名称",
      success: (result) => {
        const name = String(result.content || "").trim();
        if (!result.confirm || !name) return;
        savePrivatePack({ ...pack, name });
        this.closePrivatePackActions();
        this.refreshPrivateLibrary();
      },
    });
  },

  togglePrivatePackPin() {
    const pack = this.data.selectedPack;
    if (!pack) return;
    const pinned = !pack.pinned;
    savePrivatePack({ ...pack, pinned, pinnedAt: pinned ? Date.now() : 0 });
    this.closePrivatePackActions();
    this.refreshPrivateLibrary();
    wx.showToast({ title: pinned ? "已置顶" : "已取消置顶", icon: "none" });
  },

  toggleCategoryActions() {
    this.setData({ categoryActionsOpen: !this.data.categoryActionsOpen });
  },

  moveSelectedPackToCategory(event) {
    const pack = this.data.selectedPack;
    if (!pack) return;
    savePrivatePack({ ...pack, categoryId: event.currentTarget.dataset.id || "" });
    this.closePrivatePackActions();
    this.refreshPrivateLibrary();
    wx.showToast({ title: "已移动到分类", icon: "none" });
  },

  deleteSelectedPack() {
    const pack = this.data.selectedPack;
    if (!pack) return;
    wx.showModal({
      title: "删除题包",
      content: "题目资产仍会保留在“我的资产”中，题包目录与卡片关系将被删除。",
      confirmColor: "#b64a45",
      success: (result) => {
        if (!result.confirm) return;
        deletePrivatePack(pack.id);
        releaseAssetsFromPack(pack.id);
        this.closePrivatePackActions();
        this.refreshPrivateLibrary();
      },
    });
  },

  createCategoryFromActions() {
    this.promptForPrivateCategory(true, "");
  },

  createPrivateCategory() {
    this.promptForPrivateCategory(false, "");
  },

  createPrivateSubcategory(event) {
    this.promptForPrivateCategory(false, event.currentTarget.dataset.id || "");
  },

  promptForPrivateCategory(assignSelectedPack, parentId = "") {
    const parent = this.data.privateCategories.find((category) => category.id === parentId);
    const nextLevel = parent ? Math.min(3, Number(parent.level) + 1) : 1;
    const titles = { 1: "新建考试项目", 2: "新建科目", 3: "新建教材" };
    const placeholders = { 1: "例如：广东普通专升本", 2: "例如：现代汉语", 3: "例如：现代汉语（增订七版）上册" };
    wx.showModal({
      title: titles[nextLevel],
      editable: true,
      placeholderText: placeholders[nextLevel],
      success: (result) => {
        const category = result.confirm && createPrivatePackCategory(result.content, parentId);
        if (!category) return;
        if (assignSelectedPack && this.data.selectedPack) {
          savePrivatePack({ ...this.data.selectedPack, categoryId: category.id });
          this.closePrivatePackActions();
        }
        if (parentId && !this.data.expandedPrivateCategoryIds.includes(parentId)) {
          this.setData({ expandedPrivateCategoryIds: [...this.data.expandedPrivateCategoryIds, parentId] });
        }
        this.refreshPrivateLibrary();
      },
    });
  },

  selectPrivateCategory(event) {
    if (this._categoryLongPressAt && Date.now() - this._categoryLongPressAt < 500) return;
    const id = event.currentTarget.dataset.id || "all";
    const folder = id === "all"
      ? { id: "all", name: "全部题包" }
      : this.data.privateFolderRows.find((item) => item.id === id);
    if (!folder) return;
    this.setData({
      activePrivateCategoryId: folder.id,
      activePrivateCategoryName: folder.name,
      drawerOpen: false,
    }, () => this.applyFilters());
  },

  togglePrivateCategory(event) {
    const id = event.currentTarget.dataset.id;
    const expanded = new Set(this.data.expandedPrivateCategoryIds);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    this.setData({
      expandedPrivateCategoryIds: [...expanded],
      privateCategoryTree: this.data.privateCategoryTree.map((category) => ({
        ...category,
        expanded: expanded.has(category.id),
        children: category.children.map((child) => ({
          ...child,
          expanded: expanded.has(child.id),
        })),
      })),
    });
  },

  openPrivateCategoryActions(event) {
    const id = event.currentTarget.dataset.id;
    const selectedCategory = this.data.privateCategories.find((category) => category.id === id);
    if (!selectedCategory) return;
    this._categoryLongPressAt = Date.now();
    const touch = event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0];
    const fallbackTop = Math.max(this.data.navTotalHeight + 8, (touch ? Number(touch.clientY) : 260) - 52);
    this.setData({ selectedCategory, categoryManageOpen: true, categoryManageTop: fallbackTop }, () => {
      this.positionPrivateCategoryActions(id, fallbackTop);
    });
  },

  positionPrivateCategoryActions(categoryId, fallbackTop) {
    if (typeof wx.createSelectorQuery !== "function") return;
    const query = wx.createSelectorQuery();
    query.select(`#private-category-${categoryId}`).boundingClientRect();
    query.select(".category-manage-panel").boundingClientRect();
    query.exec((results = []) => {
      const rowRect = results[0];
      const panelRect = results[1];
      if (!rowRect) return;
      const panelHeight = panelRect && panelRect.height || 42;
      const preferredTop = rowRect.top - panelHeight - 8;
      const belowTop = rowRect.bottom + 8;
      const top = preferredTop > this.data.navTotalHeight + 6
        ? preferredTop
        : Math.min(belowTop, this.data.windowHeight - panelHeight - 16);
      this.setData({ categoryManageTop: Number.isFinite(top) ? top : fallbackTop });
    });
  },

  closePrivateCategoryActions() {
    this.setData({ selectedCategory: null, categoryManageOpen: false });
  },

  editPrivateCategory() {
    const category = this.data.selectedCategory;
    if (!category) return;
    wx.showModal({
      title: "修改分类名称",
      editable: true,
      content: category.name,
      placeholderText: "输入分类名称",
      success: (result) => {
        const name = String(result.content || "").trim();
        if (!result.confirm || !name) return;
        renamePrivatePackCategory(category.id, name);
        this.closePrivateCategoryActions();
        this.refreshPrivateLibrary();
      },
    });
  },

  deleteSelectedCategory() {
    const category = this.data.selectedCategory;
    if (!category) return;
    const levelNames = { 1: "考试项目", 2: "科目", 3: "教材" };
    wx.showModal({
      title: `删除${levelNames[category.level] || "分类"}`,
      content: "分类下的题包和题目不会删除，将自动移动到上一级分类。",
      confirmColor: "#b64a45",
      success: (result) => {
        if (!result.confirm) return;
        deletePrivatePackCategory(category.id);
        this.closePrivateCategoryActions();
        this.refreshPrivateLibrary();
      },
    });
  },

  toggleCatalogSubject(event) {
    const id = event.currentTarget.dataset.id;
    const expanded = new Set(this.data.expandedCatalogSubjectIds);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    this.setData({
      expandedCatalogSubjectIds: [...expanded],
      catalogDirectory: this.data.catalogDirectory.map((subject) => ({
        ...subject,
        expanded: expanded.has(subject.id),
      })),
    });
  },

  selectCatalogBook(event) {
    const id = event.currentTarget.dataset.id || "";
    const subject = this.data.catalogDirectory.find((item) => item.books.some((book) => book.id === id));
    this.setData({
      activeCatalogSubjectId: subject ? subject.id : "",
      activeCatalogBookId: id,
      drawerOpen: false,
    }, () => this.applyFilters());
  },

  selectCatalogSubject(event) {
    const id = event.currentTarget.dataset.id;
    const expanded = new Set(this.data.expandedCatalogSubjectIds);
    expanded.add(id);
    this.setData({
      activeCatalogSubjectId: id,
      activeCatalogBookId: "",
      expandedCatalogSubjectIds: [...expanded],
      catalogDirectory: this.data.catalogDirectory.map((subject) => ({
        ...subject,
        expanded: expanded.has(subject.id),
      })),
      drawerOpen: false,
    }, () => this.applyFilters());
  },

  openPrivatePacks() {
    wx.navigateTo({ url: "/pages/packs/packs" });
  },
});

module.exports = { createAllBooks, createNavigationMetrics };
