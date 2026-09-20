const { createCardSet, findSet, updateSet } = require("../../utils/card-box-store");

const DEFAULT_AUTHOR = "我的整理";

Page({
  data: {
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    mode: "create",
    pageTitle: "新建卡集",
    title: "",
    description: "",
    author: DEFAULT_AUTHOR,
    authorPlaceholder: DEFAULT_AUTHOR,
    folder: "我的卡集",
    saving: false,
  },

  onLoad(options = {}) {
    this.measureNavigation();
    const folder = decodeURIComponent(options.folder || "") || "我的卡集";
    this.setData({ folder });
    if (!options.id) return;

    const set = findSet(options.id);
    if (!set) {
      wx.showToast({ title: "未找到该卡集", icon: "none" });
      setTimeout(() => wx.navigateBack(), 500);
      return;
    }

    this.setId = set.id;
    this.setData({
      mode: "edit",
      pageTitle: "编辑卡集",
      title: set.title || "",
      description: Object.prototype.hasOwnProperty.call(set, "description") ? set.description : set.subtitle || "",
      author: String(set.author || "").trim() || DEFAULT_AUTHOR,
    });
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function"
      ? wx.getWindowInfo()
      : (typeof wx.getSystemInfoSync === "function" ? wx.getSystemInfoSync() : {});
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
      ? wx.getMenuButtonBoundingClientRect()
      : {};
    const hasCapsule = capsule && Number(capsule.width) > 0 && Number(capsule.height) > 0;
    const statusBarHeight = Number(windowInfo.statusBarHeight) || (hasCapsule ? Number(capsule.top) : 24);
    const capsuleTop = hasCapsule ? Number(capsule.top) : statusBarHeight + 4;
    const capsuleHeight = hasCapsule ? Number(capsule.height) : 32;
    const topGap = Math.max(4, capsuleTop - statusBarHeight);
    const navContentHeight = capsuleHeight + topGap * 2;
    this.setData({
      statusBarHeight,
      navContentHeight,
      navTotalHeight: statusBarHeight + navContentHeight,
      capsuleSafeRight: hasCapsule ? Math.max(96, Number(windowInfo.windowWidth) - Number(capsule.left) + 10) : 96,
    });
  },

  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  goBack() {
    wx.navigateBack();
  },

  save() {
    if (this.data.saving) return;
    const title = this.data.title.trim();
    const description = this.data.description.trim();
    const author = this.data.author.trim() || DEFAULT_AUTHOR;
    if (!title) {
      wx.showToast({ title: "请填写卡集标题", icon: "none" });
      return;
    }

    this.setData({ saving: true });
    if (this.data.mode === "edit") {
      updateSet(this.setId, (set) => ({ ...set, title, description, author }));
    } else {
      createCardSet(title, description, this.data.folder, author);
    }

    wx.navigateBack();
  },
});
