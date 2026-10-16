const { closeTransientLayers } = require("../../utils/page-layers");
const fallbackDiscovery = {
  channels: [{ id: "featured", label: "精选" }, { id: "course", label: "工具" }, { id: "material", label: "资料" }],
  products: [
    { id: "course-2026-foundation", kind: "course", kindLabel: "练习工具", title: "汉语言文学练习规划与题目包", subtitle: "五科九本 · 练习范围与题目建议", priceLabel: "¥ 299", badge: "筹备中", description: "围绕广东专升本考纲梳理练习范围与题目使用建议。", accent: "cyan" },
    { id: "material-literature-map", kind: "material", kindLabel: "复习资料", title: "中国古代文学史朝代脉络图", subtitle: "作家、作品、流派与文体一图串联", priceLabel: "¥ 19.9", badge: "即将上线", description: "将先秦至明清的重要作家、作品、流派和文学现象整理为可检索的复习资料。", accent: "green" },
    { id: "material-nine-books", kind: "material", kindLabel: "题库资料", title: "九本教材核心考点与作品速览", subtitle: "适合碎片时间查看", priceLabel: "¥ 39.9", badge: "内测预览", description: "按教材目录整理核心概念、作品梗概、经典名句、艺术特色与常见得分点。", accent: "amber" },
  ],
  entrances: [
    { id: "video", title: "视频讲解", subtitle: "章节要点与题目示范", status: "筹备中", icon: "play" },
    { id: "games", title: "学习营地", subtitle: "作家作品配对、朝代排序与限时挑战", status: "规划中", icon: "game" },
  ],
};

Page({
  data: {
    channels: fallbackDiscovery.channels,
    activeChannel: "featured",
    products: [],
    visibleProducts: [],
    entrances: fallbackDiscovery.entrances,
    selectedProduct: null,
    selectedProductReserved: false,
    detailOpen: false,
    reservedProductIds: [],
    loading: true,
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的长按工具栏 / 抽屉 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["detailOpen"]);
  },

  onShow() {
    closeTransientLayers(this, ["detailOpen"]);
    this.setData({ reservedProductIds: wx.getStorageSync("shukao_discovery_reservations") || [] });
    this.loadDiscovery();
    const tabBar = typeof this.getTabBar === "function" ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 3 });
  },

  loadDiscovery() {
    const app = getApp();
    if (!app.globalData.apiBaseUrl || typeof wx.request !== "function") {
      this.applyDiscovery(fallbackDiscovery);
      return;
    }
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/discovery`,
      method: "GET",
      success: (response) => {
        const payload = response.statusCode === 200 && response.data && response.data.success ? response.data : fallbackDiscovery;
        this.applyDiscovery(payload);
      },
      fail: () => this.applyDiscovery(fallbackDiscovery),
    });
  },

  applyDiscovery(payload) {
    const products = Array.isArray(payload.products) ? payload.products : [];
    this.setData({
      channels: Array.isArray(payload.channels) && payload.channels.length ? payload.channels : fallbackDiscovery.channels,
      products,
      entrances: Array.isArray(payload.entrances) ? payload.entrances : fallbackDiscovery.entrances,
      loading: false,
    }, () => this.filterProducts());
  },

  selectChannel(event) {
    this.setData({ activeChannel: event.currentTarget.dataset.id }, () => this.filterProducts());
  },

  filterProducts() {
    const visibleProducts = this.data.activeChannel === "featured"
      ? this.data.products
      : this.data.products.filter((item) => item.kind === this.data.activeChannel);
    this.setData({ visibleProducts });
  },

  openProduct(event) {
    const selectedProduct = this.data.products.find((item) => item.id === event.currentTarget.dataset.id);
    if (selectedProduct) this.setData({
      selectedProduct,
      selectedProductReserved: this.data.reservedProductIds.includes(selectedProduct.id),
      detailOpen: true,
    });
  },

  closeProduct() {
    this.setData({ detailOpen: false, selectedProduct: null });
  },

  reserveProduct() {
    const product = this.data.selectedProduct;
    if (!product) return;
    const reserved = new Set(this.data.reservedProductIds);
    if (reserved.has(product.id)) reserved.delete(product.id); else reserved.add(product.id);
    const reservedProductIds = [...reserved];
    wx.setStorageSync("shukao_discovery_reservations", reservedProductIds);
    this.setData({ reservedProductIds, selectedProductReserved: reserved.has(product.id) });
    wx.showToast({ title: reserved.has(product.id) ? "已加入开售提醒" : "已取消提醒", icon: "none" });
  },

  openEntrance(event) {
    const entrance = this.data.entrances.find((item) => item.id === event.currentTarget.dataset.id);
    if (!entrance) return;
    wx.showToast({ title: `${entrance.title}正在${entrance.status}`, icon: "none" });
  },

  stopPropagation() {},
});
