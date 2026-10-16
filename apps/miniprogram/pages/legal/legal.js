const { findDoc, docList, loadDocument, loadingViewState } = require("../../utils/platform-content");

// 2026-10-05（DEC-110）：本页由「占位页」改为**只读已发布版本**的平台文本页。
// 正文来自服务端（后台「平台设置」维护），本页不写死任何法务文字：
//   · 已发布 → 原样展示正文 + 「版本 x · 生效 y」；
//   · 未发布 → 明确显示「尚未发布」（不留占位、不假装是正式协议）；
//   · 读不到 → 如实说明并给「点这里重试」。
// 用法：/pages/legal/legal?doc=terms|privacy|ai-service|refund|account-deletion|operator|personal-info
Page({
  data: {
    doc: loadingViewState("terms"),
  },

  onLoad(options) {
    const doc = findDoc(options && options.doc) || docList()[0];
    if (typeof wx.setNavigationBarTitle === "function") wx.setNavigationBarTitle({ title: doc.title });
    this.setData({ doc: loadingViewState(doc.key) });
    return this.loadDoc();
  },

  /** 拉这一份的已发布版本；loadDocument 永不 reject，失败也会回可渲染状态。 */
  loadDoc(options = {}) {
    return loadDocument(this.data.doc.key, options).then((state) => {
      this.setData({ doc: state });
      return state;
    });
  },

  /** 失败重试：强制跳过本机缓存（可能缓存的是上一版或空态）。 */
  retryLoadDoc() {
    this.setData({ doc: loadingViewState(this.data.doc.key) });
    return this.loadDoc({ force: true });
  },

  openPersonalInfo() {
    wx.navigateTo({ url: "/pages/personal-info/personal-info" });
  },
});
