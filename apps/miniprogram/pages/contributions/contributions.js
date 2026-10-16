const { loadManagedAssets } = require("../../utils/asset-store");
const { buildContributionItems, buildCommunityIdentity, summarizeContributions } = require("../../utils/community-profile");
const { closeTransientLayers } = require("../../utils/page-layers");

const TIER_LAYERS = ["tierSheetVisible"];

Page({
  data: {
    filters: [
      { id: "all", label: "全部" },
      { id: "published", label: "已公开" },
      { id: "reviewing", label: "审核中" },
      { id: "attention", label: "需处理" },
    ],
    activeFilter: "all",
    // 2026-10-02：卡片 2 的「公开 / 帖子」两类切换。「帖子」是社区交流型内容，类型尚未上线，先走空态。
    activeMode: "published",
    // 卡片 1 点击后打开的升级门槛弹层。
    tierSheetVisible: false,
    items: [],
    visibleItems: [],
    stats: { total: 0, published: 0, reviewing: 0, attention: 0, favorites: 0, copies: 0 },
    // 2026-09-23 04:Dx 身份并入本页；2026-10-02 口径改为经验值（内容分 + 认可分），
    // 仍走与旧 community-identity 页同一套算法（buildCommunityIdentity）。
    identity: buildCommunityIdentity([]),
    syncing: false,
  },

  onShow() {
    // 回到本页先收掉升级门槛弹层：带全屏遮罩的浮层跨页残留会变成"页面能滚、按钮点不动"的隐形拦截层
    //（仓库既有约定，tests/page-transient-layers.test.js 静态兜底）。
    closeTransientLayers(this, TIER_LAYERS);
    this.localAssets = loadManagedAssets();
    this.remoteAssets = [];
    this.refresh();
    this.loadRemoteContributions();
  },

  onHide() {
    closeTransientLayers(this, TIER_LAYERS);
  },

  refresh() {
    const items = buildContributionItems(this.localAssets || [], this.remoteAssets || []);
    // 只增不减由**服务端**保证：算分取 max(当前计数, 服务端历史峰值 peakFavoriteCount)，列表照旧显示当前真实计数。
    this.setData({
      items,
      stats: summarizeContributions(items),
      identity: buildCommunityIdentity(items),
    }, () => this.applyFilter());
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

  selectMode(event) {
    this.setData({ activeMode: event.currentTarget.dataset.id });
  },

  openTierSheet() {
    this.setData({ tierSheetVisible: true });
  },

  closeTierSheet() {
    this.setData({ tierSheetVisible: false });
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
});
