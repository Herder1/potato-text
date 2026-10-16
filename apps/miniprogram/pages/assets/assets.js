const {
  assetStats,
  deleteAsset,
  loadManagedAssets,
  releaseAssetsFromPack,
  updateAsset,
  syncPublicAsset,
} = require("../../utils/asset-store");
const {
  addQuestionToPack,
  deletePrivatePack,
  loadPrivatePacks,
} = require("../../utils/private-pack-store");
const { removeNoteDraft } = require("../../utils/note-draft-store");

Page({
  data: {
    filters: [
      { id: "all", label: "全部" },
      { id: "question", label: "题目" },
      { id: "question_pack", label: "题包" },
      { id: "note", label: "笔记" },
      { id: "card_pack", label: "卡片集" },
    ],
    activeFilter: "all",
    assets: [],
    visibleAssets: [],
    stats: {},
    selectedAsset: null,
    packOptions: [],
  },

  onLoad(options = {}) {
    this.pendingAssetId = options.assetId ? decodeURIComponent(options.assetId) : "";
  },

  onShow() { this.refresh(); this.syncRemoteStatuses(); },
  onPersonalAssetsSynced() { this.refresh(); },

  syncRemoteStatuses() {
    if (typeof wx.request !== "function" || typeof getApp !== "function") return;
    const app = getApp();
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    wx.request({
      url: `${baseUrl}/api/community/assets/mine`,
      header: typeof app.authHeader === "function" ? app.authHeader() : {},
      timeout: 7000,
      success: (response) => {
        const remoteAssets = response.statusCode === 200 && response.data && response.data.assets;
        if (!Array.isArray(remoteAssets)) return;
        remoteAssets.forEach((remote) => {
          if (remote.clientAssetId) updateAsset(remote.clientAssetId, { remoteId: remote.id, moderationStatus: remote.moderationStatus, visibility: remote.visibility });
        });
        this.refresh();
      },
    });
  },

  refresh() {
    const packs = loadPrivatePacks();
    const assets = loadManagedAssets().map((asset) => {
      const membershipNames = asset.type === "question"
        ? packs.filter((pack) => pack.questionIds.includes(asset.id)).map((pack) => pack.name)
        : [];
      return {
        ...asset,
        timeLabel: this.formatDate(asset.updatedAt),
        catalogPath: asset.type === "question_pack"
          ? `${asset.sourceLabel} · ${asset.questionCount} 道题`
          : [asset.subjectName, asset.chapterTitle, asset.sectionTitle].filter(Boolean).join(" / "),
        summary: asset.excerpt || asset.content || asset.stem || (asset.type === "question_pack" ? "暂无题包说明" : ""),
        membershipNames,
        membershipLabel: asset.type === "question" ? (membershipNames.join("、") || "暂未归入题包") : "",
        metaPrimary: this.primaryMeta(asset, membershipNames),
      };
    });
    const selectedAsset = this.pendingAssetId ? assets.find((asset) => asset.id === this.pendingAssetId) : null;
    this.pendingAssetId = "";
    this.setData({ assets, packOptions: packs, stats: assetStats(assets), ...(selectedAsset ? { selectedAsset } : {}) }, () => this.applyFilter());
  },

  formatDate(timestamp) {
    const date = new Date(Number(timestamp));
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  },

  // 卡片副信息行（2026-10-03 卡片化改版）：题包/卡片集给题量、题目给所属题包、笔记给「笔记」，
  // 后面统一跟「更新于 M月D日」。归属（我的创作 / 复制资产）与目录路径不再上卡片，仍可在底部管理面板里看到。
  primaryMeta(asset, membershipNames) {
    if (asset.type === "question_pack" || asset.type === "card_pack") {
      const count = Number(asset.questionCount);
      return Number.isFinite(count) ? `${count} 道题` : "";
    }
    if (asset.type === "question") return membershipNames.length ? membershipNames.join("、") : "未归入题包";
    if (asset.type === "note") return "笔记";
    return "";
  },

  selectFilter(event) { this.setData({ activeFilter: event.currentTarget.dataset.id }, () => this.applyFilter()); },
  applyFilter() {
    this.setData({ visibleAssets: this.data.assets.filter((asset) => this.data.activeFilter === "all" || asset.type === this.data.activeFilter) });
  },
  // 整卡点击：直接进资产本身；没有独立页面的类型（卡片集等）回落到管理面板。
  openAsset(event) {
    const asset = this.data.assets.find((item) => item.id === event.currentTarget.dataset.id);
    if (!asset) return;
    if (asset.type === "question_pack") { this.openPackCollection(asset); return; }
    if (asset.type === "question") { this.openQuestionEditor(asset); return; }
    if (asset.type === "note") { this.openNoteEditor(asset); return; }
    this.setData({ selectedAsset: asset });
  },
  // 卡片右下「⋯」：打开底部管理面板（编辑 / 加入题包 / 公开 / 删除）。
  // catchtap 已经阻断冒泡，点它不会同时触发整卡跳转。
  openAssetMenu(event) {
    const asset = this.data.assets.find((item) => item.id === event.currentTarget.dataset.id);
    if (asset) this.setData({ selectedAsset: asset });
  },
  closeAsset() { this.setData({ selectedAsset: null }); },

  openQuestionEditor(asset) {
    wx.navigateTo({ url: `/pages/contribute/contribute?questionId=${encodeURIComponent(asset.id)}` });
  },

  openNoteEditor(asset) {
    wx.navigateTo({ url: `/pages/note-editor/note-editor?noteId=${encodeURIComponent(asset.id)}` });
  },

  openPackCollection(asset) {
    // 「我的资产」里的题包都是本人私有题包，必须显式声明来源（见 2026-09-28 题包入口修复）。
    wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(asset.packId || asset.id)}&source=private` });
  },

  editSelectedQuestion() {
    const asset = this.data.selectedAsset;
    if (!asset || asset.type !== "question") return;
    this.openQuestionEditor(asset);
  },

  editSelectedNote() {
    const asset = this.data.selectedAsset;
    if (!asset || asset.type !== "note") return;
    this.setData({ selectedAsset: null });
    this.openNoteEditor(asset);
  },

  openSelectedPack() {
    const asset = this.data.selectedAsset;
    if (!asset || asset.type !== "question_pack") return;
    this.openPackCollection(asset);
  },

  createPackForSelectedQuestion() {
    const asset = this.data.selectedAsset;
    if (!asset || asset.type !== "question") return;
    wx.navigateTo({ url: `/pages/packs/packs?intent=attachQuestion&questionId=${encodeURIComponent(asset.id)}` });
  },

  addSelectedQuestionToPack(event) {
    const asset = this.data.selectedAsset;
    const pack = this.data.packOptions[Number(event.detail.value)];
    if (!asset || asset.type !== "question" || !pack) return;
    addQuestionToPack(pack.id, asset.id);
    wx.showToast({ title: `已加入“${pack.name}”`, icon: "none" });
    this.setData({ selectedAsset: null });
    this.refresh();
  },

  toggleVisibility(event) {
    const id = event.currentTarget.dataset.id;
    const asset = this.data.assets.find((item) => item.id === id);
    if (!asset) return;
    const toPublic = asset.visibility !== "public";
    wx.showModal({
      title: toPublic ? "申请公开" : "设为私密",
      content: toPublic ? "提交后将进入系统初筛，通过后出现在社区。" : "设为私密后，社区中的公开版本将停止展示。",
      success: (result) => {
        if (!result.confirm) return;
        const updated = updateAsset(id, {
          visibility: toPublic ? "public" : "private",
          moderationStatus: toPublic ? "pending_review" : "private",
        });
        if (toPublic) {
          syncPublicAsset(updated, () => this.refresh());
        } else if (asset.remoteId && typeof wx.request === "function" && typeof getApp === "function") {
          const app = getApp();
          const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
          if (baseUrl) wx.request({
            url: `${baseUrl}/api/community/assets/${encodeURIComponent(asset.remoteId)}/withdraw`,
            method: "POST",
            header: typeof app.authHeader === "function" ? app.authHeader() : {},
          });
        }
        this.setData({ selectedAsset: null });
        this.refresh();
      },
    });
  },

  removeAsset(event) {
    const id = event.currentTarget.dataset.id;
    const selectedAsset = this.data.selectedAsset;
    const deletingPack = selectedAsset && selectedAsset.type === "question_pack";
    wx.showModal({
      title: deletingPack ? "删除题包" : "删除资产",
      content: deletingPack ? "题目资产会继续保留，题包目录与卡片关系将被删除。" : "删除后无法恢复，是否继续？",
      confirmColor: "#a3473f",
      success: (result) => {
        if (!result.confirm) return;
        if (deletingPack) {
          deletePrivatePack(selectedAsset.packId || id);
          releaseAssetsFromPack(selectedAsset.packId || id);
        } else {
          if (selectedAsset && selectedAsset.draftId) removeNoteDraft(selectedAsset.draftId);
          deleteAsset(id);
        }
        this.setData({ selectedAsset: null });
        this.refresh();
      },
    });
  },

});
