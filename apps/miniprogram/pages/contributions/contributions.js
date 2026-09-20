const { loadManagedAssets } = require("../../utils/asset-store");
const { buildContributionItems, summarizeContributions } = require("../../utils/community-profile");

Page({
  data: {
    filters: [
      { id: "all", label: "全部" },
      { id: "published", label: "已公开" },
      { id: "reviewing", label: "审核中" },
      { id: "attention", label: "需处理" },
    ],
    activeFilter: "all",
    items: [],
    visibleItems: [],
    stats: { total: 0, published: 0, reviewing: 0, attention: 0, favorites: 0, copies: 0 },
    syncing: false,
  },

  onShow() {
    this.localAssets = loadManagedAssets();
    this.remoteAssets = [];
    this.refresh();
    this.loadRemoteContributions();
  },

  refresh() {
    const items = buildContributionItems(this.localAssets || [], this.remoteAssets || []);
    this.setData({ items, stats: summarizeContributions(items) }, () => this.applyFilter());
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

  selectFilter(event) {
    this.setData({ activeFilter: event.currentTarget.dataset.id }, () => this.applyFilter());
  },

  applyFilter() {
    const activeFilter = this.data.activeFilter;
    this.setData({
      visibleItems: this.data.items.filter((item) => activeFilter === "all" || item.statusGroup === activeFilter),
    });
  },

  openContribution(event) {
    const item = this.data.items.find((record) => record.id === event.currentTarget.dataset.id);
    if (!item) return;
    if (item.localId) {
      wx.navigateTo({ url: `/pages/assets/assets?assetId=${encodeURIComponent(item.localId)}` });
      return;
    }
    wx.showModal({
      title: item.title,
      content: `${item.typeLabel} · ${item.statusLabel}\n${item.dateText || ""}${item.riskReason ? `\n\n${item.riskReason}` : ""}`,
      showCancel: false,
      confirmText: "知道了",
    });
  },

  openAssets() {
    wx.navigateTo({ url: "/pages/assets/assets" });
  },

  openIdentity() {
    wx.navigateTo({ url: "/pages/community-identity/community-identity" });
  },
});
