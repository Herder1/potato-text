const { buildCommunityFavoriteItems, buildFavoriteQuestionItems } = require("../../utils/favorites-view");

Page({
  data: {
    loggedIn: false,
    loadingCommunity: false,
    communityError: "",
    communityItems: [],
    questionItems: [],
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  refresh() {
    const application = getApp();
    const bookmarkStates = wx.getStorageSync("shukao_bookmarks") || {};
    const legacyLookup = (id) => wx.getStorageSync(`shukao_bookmark_${id}`) === true;
    const questionItems = buildFavoriteQuestionItems({
      officialQuestions: application.globalData.officialQuestions,
      bookmarkStates,
      legacyLookup,
    });
    const loggedIn = Boolean(application.globalData.authToken);
    this.setData({ loggedIn, questionItems });
    if (loggedIn) this.loadCommunityFavorites();
    else this.setData({ communityItems: [], communityError: "", loadingCommunity: false });
  },

  // 收藏的公开内容来自服务端引用关系（“我的收藏”只看引用，不复制内容），必须登录。
  loadCommunityFavorites() {
    const application = getApp();
    const baseUrl = String(application.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    this.setData({ loadingCommunity: true, communityError: "" });
    wx.request({
      url: `${baseUrl}/api/community/assets/favorites`,
      timeout: 8000,
      header: typeof application.authHeader === "function" ? application.authHeader() : {},
      success: (response) => {
        if (response.statusCode === 401) {
          this.setData({ loggedIn: false, loadingCommunity: false, communityItems: [], communityError: "登录后才能查看收藏的公开内容" });
          return;
        }
        if (response.statusCode !== 200) {
          this.setData({ loadingCommunity: false, communityError: "收藏加载失败，请稍后重试" });
          return;
        }
        const assets = (response.data && response.data.assets) || [];
        this.setData({ loadingCommunity: false, communityItems: buildCommunityFavoriteItems(assets) });
      },
      fail: () => this.setData({ loadingCommunity: false, communityError: "无法连接服务器，请检查网络" }),
    });
  },

  retryCommunity() {
    this.loadCommunityFavorites();
  },

  goLogin() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },

  removeCommunityFavorite(event) {
    const id = event.currentTarget.dataset.id;
    const application = getApp();
    const baseUrl = String(application.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || !id) return;
    wx.request({
      url: `${baseUrl}/api/community/assets/${encodeURIComponent(id)}/unfavorite`,
      method: "POST",
      timeout: 8000,
      header: typeof application.authHeader === "function" ? application.authHeader() : {},
      success: (response) => {
        if (response.statusCode === 200) {
          this.setData({ communityItems: this.data.communityItems.filter((item) => item.id !== id) });
          wx.showToast({ title: "已取消收藏", icon: "none" });
          return;
        }
        wx.showToast({ title: "取消失败，请稍后重试", icon: "none" });
      },
      fail: () => wx.showToast({ title: "取消失败，请稍后重试", icon: "none" }),
    });
  },

  openQuestion(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.setStorageSync("shukao_active_review_ids", [id]);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },

  removeQuestionFavorite(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    const bookmarkStates = wx.getStorageSync("shukao_bookmarks") || {};
    bookmarkStates[id] = { ...(bookmarkStates[id] || {}), value: false };
    wx.setStorageSync("shukao_bookmarks", bookmarkStates);
    wx.setStorageSync(`shukao_bookmark_${id}`, false);
    this.setData({ questionItems: this.data.questionItems.filter((item) => item.id !== id) });
    wx.showToast({ title: "已取消收藏", icon: "none" });
  },

  browseCommunity() {
    wx.navigateTo({ url: "/pages/knowledge/knowledge" });
  },
});
