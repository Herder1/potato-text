// 「我的收藏」新版（DEC-096，2026-09-23）。
//
// 结构：导航栏左上角「目录」图标（← 返回 之后那颗，替代原来整行的目录卡片）→ 左侧抽屉（文件夹 + 底部分类管理）
//       → 当前文件夹头 → 子文件夹标签 → 合并列表。
// 数据来源有三个，刻意分开取、合并显示（不复制内容）：
//   1) 社区收藏 = 服务端引用关系（GET /api/community/assets/favorites，必须登录）；
//   2) 题目收藏 = 设备本地书签（shukao_bookmarks / 旧键 shukao_bookmark_<id>，与复习页同一套存储；
//      服务端真源是 learning-state-store 的 account.bookmarks，由 app.js 双向同步）；
//   3) 组织方式 = 服务端收藏文件夹（GET /api/favorites/folders：文件夹 / 子文件夹 / 归属 / 全局置顶）。
const { buildCommunityFavoriteItems, buildFavoriteQuestionItems } = require("../../utils/favorites-view");
const { buildFavoriteOrganization } = require("../../utils/favorites-organization");
const { closeTransientLayers } = require("../../utils/page-layers");

const EMPTY_VIEW = {
  totalCount: 0,
  unfiledCount: 0,
  directorySubtitle: "0 个文件夹 · 0 条收藏",
  folders: [],
  allFolder: { active: true, count: 0 },
  activeFolderId: "",
  folderTitle: "全部收藏",
  folderCountLabel: "0 条收藏",
  chips: [],
  activeSubFolderId: "",
  items: [],
  emptyLabel: "还没有收藏",
  keyword: "",
  typeFilter: "",
  typeOptions: [],
  hasFilter: false,
  scopedCount: 0,
};

Page({
  data: {
    loggedIn: false,
    loading: true,
    communityError: "",
    organizationError: "",
    directoryOpen: false,
    pickerOpen: false,
    filterOpen: false,
    sortMode: "recent",
    // 搜索 / 筛选（产品负责人 2026-09-23 04:4x）：搜索框在「全部收藏」上面，右边依次是筛选、排序。
    keyword: "",
    view: EMPTY_VIEW,
    sheet: null,
    pickerOptions: [],
    // 自绘导航栏指标（产品负责人 2026-09-23 04:0x：目录入口搬到左上角、用图标替代整行卡片）。
    // 与 card-set / knowledge / profile-edit 等页同一套算法：状态栏高度 + 胶囊高度与上下留白 = 导航内容高。
    statusBarHeight: 44,
    navContentHeight: 44,
    navTotalHeight: 88,
    capsuleSafeRight: 96,
    drawerPaddingTop: 55,
  },

  onLoad() {
    this.measureNavigation();
  },

  // 自绘导航栏必须自己让开状态栏与右上角胶囊（不量就会被胶囊压住）。
  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function"
      ? wx.getWindowInfo()
      : (typeof wx.getSystemInfoSync === "function" ? wx.getSystemInfoSync() : {});
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
      ? wx.getMenuButtonBoundingClientRect()
      : {};
    const hasCapsule = Boolean(capsule) && Number(capsule.width) > 0 && Number(capsule.height) > 0;
    const statusBarHeight = Number(windowInfo.statusBarHeight) || (hasCapsule ? Number(capsule.top) : 24);
    const capsuleTop = hasCapsule ? Number(capsule.top) : statusBarHeight + 4;
    const capsuleHeight = hasCapsule ? Number(capsule.height) : 32;
    const topGap = Math.max(4, capsuleTop - statusBarHeight);
    const navContentHeight = capsuleHeight + topGap * 2;
    this.setData({
      statusBarHeight,
      navContentHeight,
      navTotalHeight: statusBarHeight + navContentHeight,
      capsuleSafeRight: hasCapsule
        ? Math.max(96, Number(windowInfo.windowWidth || 375) - Number(capsule.left) + 10)
        : 96,
      // 抽屉顶到屏幕顶部，标题必须让开状态栏（22rpx＝11px，与原来的 padding-top: 44rpx 视觉一致）。
      drawerPaddingTop: statusBarHeight + 11,
    });
  },

  // 这一页是从复习页等处二级进来的，用 navigateBack；没有上一页时兜回「我的」。
  goBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    wx.switchTab({ url: "/pages/profile/profile" });
  },

  onShow() {
    // 本页的抽屉 / 长按面板 / 文件夹选择器都带全屏遮罩：跨页残留会变成"页面能滚、按钮点不动"的隐形拦截层。
    closeTransientLayers(this, ["directoryOpen", "sheet", "pickerOpen", "filterOpen"]);
    this.refresh();
  },

  onHide() {
    closeTransientLayers(this, ["directoryOpen", "sheet", "pickerOpen", "filterOpen"]);
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  refresh() {
    const application = getApp();
    const bookmarkStates = wx.getStorageSync("shukao_bookmarks") || {};
    const legacyLookup = (id) => wx.getStorageSync(`shukao_bookmark_${id}`) === true;
    this.questionItems = buildFavoriteQuestionItems({
      officialQuestions: application.globalData.officialQuestions,
      bookmarkStates,
      legacyLookup,
    });
    const loggedIn = Boolean(application.globalData.authToken);
    this.setData({ loggedIn });
    if (loggedIn) {
      this.loadCommunityFavorites();
      this.loadOrganization();
      return;
    }
    this.communityItems = [];
    this.organization = {};
    this.setData({ communityError: "", organizationError: "", loading: false });
    this.renderView();
  },

  // 收藏的公开内容来自服务端引用关系（“我的收藏”只看引用，不复制内容），必须登录。
  loadCommunityFavorites() {
    const application = getApp();
    const baseUrl = String(application.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    this.setData({ loading: true, communityError: "" });
    wx.request({
      url: `${baseUrl}/api/community/assets/favorites`,
      timeout: 8000,
      header: typeof application.authHeader === "function" ? application.authHeader() : {},
      success: (response) => {
        if (response.statusCode === 401) {
          this.setData({ loggedIn: false, loading: false, communityError: "登录后才能查看收藏的公开内容" });
          this.communityItems = [];
          this.organization = {};
          this.renderView();
          return;
        }
        if (response.statusCode !== 200) {
          this.setData({ loading: false, communityError: "收藏加载失败，请稍后重试" });
          return;
        }
        const assets = (response.data && response.data.assets) || [];
        this.communityItems = buildCommunityFavoriteItems(assets);
        this.setData({ loading: false });
        this.renderView();
      },
      fail: () => {
        this.setData({ loading: false, communityError: "无法连接服务器，请检查网络" });
        this.renderView();
      },
    });
  },

  // 收藏的文件夹 / 子文件夹 / 置顶标记（DEC-096 ① ② ③ ④）。
  loadOrganization() {
    const application = getApp();
    const baseUrl = String(application.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    wx.request({
      url: `${baseUrl}/api/favorites/folders`,
      timeout: 8000,
      header: typeof application.authHeader === "function" ? application.authHeader() : {},
      success: (response) => {
        if (response.statusCode === 401) {
          this.organization = {};
          this.renderView();
          return;
        }
        if (response.statusCode !== 200 || !response.data) {
          // 目录拿不到时页面不能空着：收藏照样列出来，只是都在「全部收藏」里，并给一句可自愈的提示。
          // ⚠️ 用独立字段：这一条与「收藏加载失败」是两件事，塞进同一个字段会互相覆盖、把先失败的丢掉。
          this.organization = {};
          this.setData({ organizationError: this.organizationErrorText(response.statusCode) });
          this.renderView();
          return;
        }
        this.organization = response.data;
        this.setData({ organizationError: "" });
        // 当前文件夹可能已被别的设备删掉：回到「全部收藏」，不要停在一个不存在的文件夹上。
        const folders = Array.isArray(response.data.folders) ? response.data.folders : [];
        if (this.activeFolderId && !folders.some((folder) => folder.id === this.activeFolderId)) {
          this.activeFolderId = "";
          this.activeSubFolderId = "";
        }
        if (this.activeSubFolderId && !folders.some((folder) => folder.id === this.activeSubFolderId)) {
          this.activeSubFolderId = "";
        }
        this.renderView();
      },
      fail: () => {
        this.organization = {};
        this.setData({ organizationError: "无法连接服务器，请检查网络" });
        this.renderView();
      },
    });
  },

  // 404 是"这台后台还没加载收藏目录接口"（API 代码只在进程启动时读一次，AGENTS §8）——
  // 真机上看到"加载失败"却不知道要去重启服务，就变成我猜你、你猜我，所以这里说清是什么事。
  organizationErrorText(statusCode) {
    if (statusCode === 404) return "收藏目录服务未就绪（后台服务需重启后生效）";
    return "收藏目录加载失败，下拉可重试";
  },

  renderView() {
    const view = buildFavoriteOrganization({
      communityItems: this.communityItems || [],
      questionItems: this.questionItems || [],
      organization: this.organization || {},
      activeFolderId: this.activeFolderId || "",
      activeSubFolderId: this.activeSubFolderId || "",
      order: this.data.sortMode === "oldest" ? "oldest" : "recent",
      keyword: this.data.keyword || "",
      typeFilter: this.data.filterType || "",
    });
    // 有请求失败时"空"不等于"没有收藏"：不能拿一次失败的加载去宣称用户没有收藏（真机截图踩到过）。
    const organizationFailed = Boolean(this.data.organizationError);
    const listFailed = Boolean(this.data.communityError || this.data.organizationError);
    view.listLoaded = !listFailed;
    view.directoryLoaded = !organizationFailed;
    if (organizationFailed) view.directorySubtitle = "目录暂不可用";
    if (listFailed && !view.items.length) view.emptyLabel = "收藏没加载出来";
    this.setData({ view, loading: false });
  },

  retryOrganization() {
    this.loadOrganization();
  },

  retryCommunity() {
    this.refresh();
  },

  goLogin() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },

  openDirectory() {
    this.setData({ directoryOpen: true });
  },

  closeDirectory() {
    this.setData({ directoryOpen: false });
  },

  // 点左边文件夹＝展开该文件夹的所有收藏（含子文件夹），上方标签换成它的子文件夹。
  selectFolder(event) {
    this.activeFolderId = event.currentTarget.dataset.id || "";
    this.activeSubFolderId = "";
    this.setData({ directoryOpen: false });
    this.renderView();
  },

  // 点子文件夹标签＝筛出该子文件夹的收藏（data-id 为空＝该文件夹全部）。
  selectChip(event) {
    this.activeSubFolderId = event.currentTarget.dataset.id || "";
    this.renderView();
  },

  toggleSort() {
    const sortMode = this.data.sortMode === "recent" ? "oldest" : "recent";
    this.setData({ sortMode });
    this.renderView();
    wx.showToast({ title: sortMode === "recent" ? "按收藏时间（新 → 旧）" : "按收藏时间（旧 → 新）", icon: "none" });
  },

  // ── 搜索 / 筛选（产品负责人 2026-09-23 04:4x）──────────────────────────────
  // 搜索框在「全部收藏」上面，右边依次是筛选、排序。筛选＝按内容类型（选项从当前文件夹的数据里长出来）。
  onKeyword(event) {
    this.setData({ keyword: (event.detail && event.detail.value) || "" });
    this.renderView();
  },

  clearKeyword() {
    this.setData({ keyword: "" });
    this.renderView();
  },

  openFilter() {
    // 当前范围内一条收藏都没有时，打开一个只有「全部 0」的面板毫无意义，直接说清楚。
    if (!(this.data.view.scopedCount > 0)) {
      wx.showToast({ title: "还没有可筛选的收藏", icon: "none" });
      return;
    }
    this.setData({ filterOpen: true });
  },

  closeFilter() {
    this.setData({ filterOpen: false });
  },

  selectFilterType(event) {
    const { value } = event.currentTarget.dataset;
    this.setData({ filterType: value || "", filterOpen: false });
    this.renderView();
  },

  // 空态里的一键清空：把搜索词与类型筛选都撤掉，回到该文件夹的全部收藏。
  clearFilters() {
    this.setData({ keyword: "", filterType: "" });
    this.renderView();
  },

  // 点收藏跳转：题目回复习模式打开该题；卡片集/题包进卡片集页；其余社区内容进知识库并直接展开那条。
  openItem(event) {
    const { kind, id, type } = event.currentTarget.dataset;
    if (!id) return;
    if (kind === "question") {
      wx.setStorageSync("shukao_active_review_ids", [id]);
      wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
      return;
    }
    if (type === "card_pack" || type === "question_pack") {
      wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(id)}&source=public` });
      return;
    }
    wx.navigateTo({ url: `/pages/knowledge/knowledge?assetId=${encodeURIComponent(id)}` });
  },

  openSheet(event) {
    const { key, kind, id } = event.currentTarget.dataset;
    const item = (this.data.view.items || []).find((entry) => entry.key === key);
    if (!item) return;
    this.setData({
      sheet: {
        key,
        kind: kind || item.kind,
        refId: id || item.refId,
        title: item.title,
        sourceLine: item.sourceLine,
        pinned: Boolean(item.pinned),
        folderId: item.folderId || "",
      },
      pickerOpen: false,
    });
  },

  closeSheet() {
    this.setData({ sheet: null, pickerOpen: false });
  },

  // 长按面板 →「置顶 / 取消置顶」：全局置顶（DEC-096 ④）。
  togglePin() {
    const sheet = this.data.sheet;
    if (!sheet) return;
    const pinned = !sheet.pinned;
    this.postFavoriteAction("/api/favorites/pins", { kind: sheet.kind, refId: sheet.refId, pinned }, () => {
      wx.showToast({ title: pinned ? "已置顶" : "已取消置顶", icon: "none" });
      this.setData({ sheet: null, pickerOpen: false });
      this.loadOrganization();
    });
  },

  // 长按面板 →「移到文件夹…」：没有这一步，文件夹建了也没有东西能放进去。
  openFolderPicker() {
    const organization = this.organization || {};
    const folders = Array.isArray(organization.folders) ? organization.folders : [];
    const topLevel = folders.filter((folder) => !folder.parentId);
    const pickerOptions = [{ id: "", name: "移出文件夹（不分类）" }];
    topLevel.forEach((folder) => {
      pickerOptions.push({ id: folder.id, name: folder.name, indent: false });
      folders.filter((child) => child.parentId === folder.id).forEach((child) => {
        pickerOptions.push({ id: child.id, name: child.name, indent: true });
      });
    });
    this.setData({ pickerOpen: true, pickerOptions });
  },

  selectFolderOption(event) {
    const sheet = this.data.sheet;
    if (!sheet) return;
    const folderId = event.currentTarget.dataset.id || "";
    this.postFavoriteAction("/api/favorites/membership", { kind: sheet.kind, refId: sheet.refId, folderId }, () => {
      wx.showToast({ title: folderId ? "已移入文件夹" : "已移出文件夹", icon: "none" });
      this.setData({ sheet: null, pickerOpen: false });
      this.loadOrganization();
    });
  },

  // 长按面板 →「删除收藏」＝取消收藏（DEC-096 ④：不做回收站）。
  deleteFavorite() {
    const sheet = this.data.sheet;
    if (!sheet) return;
    const id = sheet.refId;
    this.setData({ sheet: null, pickerOpen: false });
    if (sheet.kind === "question") {
      const bookmarkStates = wx.getStorageSync("shukao_bookmarks") || {};
      bookmarkStates[id] = { ...(bookmarkStates[id] || {}), value: false };
      wx.setStorageSync("shukao_bookmarks", bookmarkStates);
      wx.setStorageSync(`shukao_bookmark_${id}`, false);
      // 本机缓存改完立刻回传服务端（书签真源在 learning-state-store），归属与置顶由服务端 prune 清掉。
      const application = getApp();
      if (typeof application.syncLearningState === "function") application.syncLearningState();
      wx.showToast({ title: "已取消收藏", icon: "none" });
      this.questionItems = (this.questionItems || []).filter((item) => item.id !== id);
      this.renderView();
      if (this.data.loggedIn) this.loadOrganization();
      return;
    }
    const application = getApp();
    const baseUrl = String(application.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    wx.request({
      url: `${baseUrl}/api/community/assets/${encodeURIComponent(id)}/unfavorite`,
      method: "POST",
      timeout: 8000,
      header: typeof application.authHeader === "function" ? application.authHeader() : {},
      success: (response) => {
        if (response.statusCode === 200) {
          this.communityItems = (this.communityItems || []).filter((item) => item.id !== id);
          wx.showToast({ title: "已取消收藏", icon: "none" });
          this.renderView();
          this.loadOrganization();
          return;
        }
        wx.showToast({ title: "取消失败，请稍后重试", icon: "none" });
      },
      fail: () => wx.showToast({ title: "取消失败，请稍后重试", icon: "none" }),
    });
  },

  postFavoriteAction(path, payload, onSuccess) {
    const application = getApp();
    const baseUrl = String(application.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    wx.request({
      url: `${baseUrl}${path}`,
      method: "POST",
      timeout: 8000,
      header: typeof application.authHeader === "function" ? application.authHeader() : {},
      data: payload,
      success: (response) => {
        if (response.statusCode === 200 && typeof onSuccess === "function") onSuccess(response.data);
        else wx.showToast({ title: "操作失败，请稍后重试", icon: "none" });
      },
      fail: () => wx.showToast({ title: "操作失败，请检查网络", icon: "none" }),
    });
  },

  openManage() {
    this.setData({ directoryOpen: false });
    wx.navigateTo({ url: "/pages/favorite-manage/favorite-manage" });
  },

  browseCommunity() {
    wx.navigateTo({ url: "/pages/knowledge/knowledge" });
  },

  noop() {},
});
