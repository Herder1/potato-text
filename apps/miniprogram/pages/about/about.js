const { APP_NAME, APP_VERSION, BRAND_SLOGAN, COPYRIGHT } = require("../../utils/app-meta");
const { docList } = require("../../utils/platform-content");

// 2026-10-05（DEC-110）：法务入口改为从平台文本登记表取（不再有 LEGAL_DOCS 的写死副本），
// 营业执照并入「运营主体与客服信息」一篇；正文由后台「平台设置」维护，本页只做入口与身份展示。
// 七份文本全部在这里可达（含退款政策与账号注销说明）——原先只有四项是因为当时只登记了四项。
const ABOUT_DOCS = docList();

Page({
  data: {
    appName: APP_NAME,
    version: APP_VERSION,
    copyright: COPYRIGHT,
    slogan: BRAND_SLOGAN,
    docs: ABOUT_DOCS.map((doc) => ({ key: doc.key, title: doc.title, icon: doc.icon, desc: doc.desc })),
  },

  openDoc(event) {
    const doc = String(event.currentTarget.dataset.doc || "");
    wx.navigateTo({ url: `/pages/legal/legal?doc=${encodeURIComponent(doc)}` });
  },
});
