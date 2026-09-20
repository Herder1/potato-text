const {
  createPrivatePack,
  loadPrivatePacks,
  packStats,
} = require("../../utils/private-pack-store");

Page({
  data: {
    intent: "",
    questionId: "",
    activeFilter: "all",
    filters: [
      { id: "all", label: "全部" },
      { id: "created", label: "我创建的" },
      { id: "imported", label: "社区导入" },
    ],
    query: "",
    packs: [],
    visiblePacks: [],
    stats: { total: 0, questions: 0, created: 0, imported: 0 },
    actionMenuOpen: false,
  },

  onLoad(options = {}) {
    this.setData({
      intent: options.intent || "",
      questionId: decodeURIComponent(options.questionId || ""),
    });
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const packs = loadPrivatePacks();
    this.setData({ packs, stats: packStats(packs) }, () => this.applyFilter());
  },

  selectFilter(event) {
    this.setData({ activeFilter: event.currentTarget.dataset.id }, () => this.applyFilter());
  },

  updateSearch(event) {
    this.setData({ query: event.detail.value }, () => this.applyFilter());
  },

  applyFilter() {
    const query = String(this.data.query || "").trim().toLowerCase();
    const visiblePacks = this.data.packs.filter((pack) => {
      const sourceMatches = this.data.activeFilter === "all"
        || (this.data.activeFilter === "created" && pack.source !== "community_import")
        || (this.data.activeFilter === "imported" && pack.source === "community_import");
      const text = [pack.name, pack.description, ...(pack.tags || [])].join(" ").toLowerCase();
      return sourceMatches && (!query || text.includes(query));
    });
    this.setData({ visiblePacks });
  },

  toggleActionMenu() {
    this.setData({ actionMenuOpen: !this.data.actionMenuOpen });
  },

  createPack() {
    this.setData({ actionMenuOpen: false });
    wx.showModal({
      title: "新建题包",
      editable: true,
      placeholderText: "例如：现代汉语语法易错题",
      success: (result) => {
        const name = String(result.content || "").trim();
        if (!result.confirm || !name) return;
        const pack = createPrivatePack({ name });
        const intentQuery = this.data.intent ? `&intent=${encodeURIComponent(this.data.intent)}` : "";
        const questionQuery = this.data.questionId ? `&questionId=${encodeURIComponent(this.data.questionId)}` : "";
        wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(pack.id)}&source=private${intentQuery}${questionQuery}` });
      },
    });
  },

  openCommunity() {
    this.setData({ actionMenuOpen: false });
    wx.setStorageSync("shukao_knowledge_requested_tab", "community");
    wx.switchTab({ url: "/pages/knowledge/knowledge" });
  },

  openPack(event) {
    const id = event.currentTarget.dataset.id;
    const intentQuery = this.data.intent ? `&intent=${encodeURIComponent(this.data.intent)}` : "";
    const questionQuery = this.data.questionId ? `&questionId=${encodeURIComponent(this.data.questionId)}` : "";
    wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(id)}&source=private${intentQuery}${questionQuery}` });
  },
});
