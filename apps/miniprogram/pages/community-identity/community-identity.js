const { loadManagedAssets } = require("../../utils/asset-store");
const { buildCommunityIdentity, buildContributionItems } = require("../../utils/community-profile");

Page({
  data: {
    nickname: "薯考同学",
    avatarUrl: "",
    identity: buildCommunityIdentity([]),
    syncing: false,
  },

  onShow() {
    const app = getApp();
    this.localAssets = loadManagedAssets();
    this.remoteAssets = [];
    this.setData({
      nickname: app.globalData.user && app.globalData.user.nickname || "薯考同学",
      avatarUrl: app.globalData.user && app.globalData.user.avatarUrl || "",
    });
    this.refresh();
    this.loadRemoteContributions();
  },

  refresh() {
    const items = buildContributionItems(this.localAssets || [], this.remoteAssets || []);
    this.setData({ identity: buildCommunityIdentity(items) });
  },

  loadRemoteContributions() {
    if (typeof wx.request !== "function") return;
    const app = getApp();
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    this.setData({ syncing: true });
    wx.request({
      url: `${baseUrl}/api/community/assets/mine`,
      header: typeof app.authHeader === "function" ? app.authHeader() : {},
      timeout: 7000,
      success: (response) => {
        const records = response.statusCode === 200 && response.data && response.data.assets;
        if (!Array.isArray(records)) return;
        this.remoteAssets = records;
        this.refresh();
      },
      complete: () => this.setData({ syncing: false }),
    });
  },

  openContributions() {
    wx.navigateTo({ url: "/pages/contributions/contributions" });
  },

  openAssets() {
    wx.navigateTo({ url: "/pages/assets/assets" });
  },
});
