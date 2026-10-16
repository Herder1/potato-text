const { loadDocument, loadingViewState } = require("../../utils/platform-content");

// 2026-10-05（DEC-110）：「个人信息收集清单」改为**独立的一份平台文本**，正文由后台「平台设置」维护。
// 原页面里写死的清单与三段说明已删除——写死的内容会随实现变化而与真实处理方式脱节。
// 未发布同样显示「尚未发布」，不用旧文案顶替（旧文案就在 git 历史与变更日志里，需要时可查）。
Page({
  data: {
    doc: loadingViewState("personal-info"),
  },

  onLoad() {
    if (typeof wx.setNavigationBarTitle === "function") wx.setNavigationBarTitle({ title: this.data.doc.title });
    return this.loadDoc();
  },

  loadDoc(options = {}) {
    return loadDocument(this.data.doc.key, options).then((state) => {
      this.setData({ doc: state });
      return state;
    });
  },

  retryLoadDoc() {
    this.setData({ doc: loadingViewState(this.data.doc.key) });
    return this.loadDoc({ force: true });
  },

  openService() {
    wx.navigateTo({ url: "/pages/help-feedback/help-feedback?tab=submit" });
  },
});
