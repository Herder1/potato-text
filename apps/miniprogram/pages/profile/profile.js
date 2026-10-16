const { assetStats, loadManagedAssets } = require("../../utils/asset-store");
const { usableAvatarUrl } = require("../../utils/avatar");
const { buildCommunityIdentity, buildContributionItems } = require("../../utils/community-profile");
const { loadCardSets } = require("../../utils/card-box-store");
// 铃铛显示公告与当前账号反馈通知的未读数。
const { syncUnreadBadge, messageSession } = require("../../utils/message-center");

const REVIEW_HISTORY_KEY = "shukao_review_history";

// 资产卡片三列的口径由产品负责人 2026-09-22 定：学习天数 / 卡集 / 题包
// （他给的理由：笔记下属于卡集，所以笔记不再单独占一列）。
// 「学习天数」＝复习记录里**去重后的日期数**——记录本身带 dateKey（由刷题页写入），这里只做去重，不另造日期键。
function studyDayCount(history) {
  const keys = (Array.isArray(history) ? history : [])
    .map((entry) => String((entry && entry.dateKey) || "").trim())
    .filter(Boolean);
  return new Set(keys).size;
}

function readCount(read) {
  try { return Number(read()) || 0; } catch (error) { return 0; }
}

// 「头像 + 昵称 + 一行小字 + 个性签名」这几项都来自账号投影（见 apps/api/src/user-auth-store.js 的 publicUser）。
// 头像没有可用图片时，色块里显示昵称首字（参考图给的是"林"= 昵称首字），没有昵称就回落成「薯」。
// 小字＝「身份标签 · 已加入 N 天」：档位用与社区身份页同一套口径（buildCommunityIdentity）算，
// 拿不到远端贡献时不猜档位、只显示「已加入 N 天」；N 由账号真实的 createdAt 现算，不写死。
function joinedText(user, label) {
  const startedAt = Number(user && user.createdAt);
  if (!(startedAt > 0)) return "";
  const days = Math.floor((Date.now() - startedAt) / 86400000) + 1;
  return `${label ? `${label} · ` : ""}已加入 ${days} 天`;
}

function identityView(user) {
  const nickname = String((user && user.nickname) || "").trim();
  return {
    avatarChar: nickname.slice(0, 1) || "薯",
    joinedLabel: joinedText(user, ""),
    signature: String((user && user.signature) || "").trim(),
  };
}

Page({
  data: {
    nickname: "薯考同学",
    avatarUrl: "",
    avatarChar: "薯",
    joinedLabel: "",
    signature: "",
    userId: "",
    loggedIn: false,
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    unreadNotificationCount: 0,
    // 2026-09-23 04:Dx「把贡献和社区合并」：原来这里是五行，「社区身份」单独一行跳独立页；
    // 现在社区身份已并入「我的贡献」那一页，这一行去掉（旧页文件与 app.json 注册都先留着，退役待产品负责人点头）。
    // 2026-10-02：「隐私与数据」这一行按产品负责人口径删除——内容已拆分进「设置」页
    // （同步/导出/冲突处理/注销在设置页，隐私正文在设置 → 个人信息收集清单）。
    menu: ["我的账户", "我的收藏", "我的资产", "社区与贡献", "帮助与反馈"],
    assetStats: { total: 0, questions: 0, packs: 0, notes: 0, pendingCount: 0 },
    assetCard: { studyDays: 0, cardSets: 0, packs: 0 },
  },

  onLoad() {
    this.measureNavigation();
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function" ? wx.getMenuButtonBoundingClientRect() : {};
    const hasCapsuleMetrics = capsule && Number(capsule.width) > 0 && Number(capsule.height) > 0;
    const statusBarHeight = Number(windowInfo.statusBarHeight) || (hasCapsuleMetrics ? Number(capsule.top) : 24);
    const capsuleTop = hasCapsuleMetrics ? Number(capsule.top) : statusBarHeight + 4;
    const capsuleHeight = hasCapsuleMetrics ? Number(capsule.height) : 32;
    const topGap = Math.max(4, capsuleTop - statusBarHeight);
    this.setData({
      statusBarHeight,
      navContentHeight: capsuleHeight + topGap * 2,
      navTotalHeight: statusBarHeight + capsuleHeight + topGap * 2,
      capsuleSafeRight: hasCapsuleMetrics ? Math.max(96, Number(windowInfo.windowWidth) - Number(capsule.left) + 10) : 96,
    });
  },

  onShow() {
    const app = getApp();
    const user = app.globalData.user || {};
    const profileView = identityView(user);
    const stats = assetStats(loadManagedAssets());
    this.setData({
      assetStats: stats,
      // 卡集数取知识库本地库（与「知识库」页同一份数据）；学习天数取复习记录的去重日期数。
      assetCard: {
        studyDays: readCount(() => studyDayCount(wx.getStorageSync(REVIEW_HISTORY_KEY))),
        cardSets: readCount(() => loadCardSets().length),
        packs: stats.packs,
      },
      unreadNotificationCount: Math.max(0, Number(wx.getStorageSync("shukao_unread_notification_count")) || 0),
      nickname: user.nickname || "薯考同学",
      avatarUrl: usableAvatarUrl(user.avatarUrl),
      loggedIn: app.globalData.loggedIn === true,
      userId: app.globalData.loggedIn === true ? String(user.publicId || "") : "",
      ...profileView,
    });
    if (app.globalData.loggedIn === true && !user.publicId && typeof app.refreshAuthSession === "function") {
      app.refreshAuthSession((updated) => {
        if (updated && getApp().globalData.loggedIn === true) {
          this.setData({ userId: String(updated.publicId || "") });
        }
      });
    }
    const tabBar = typeof this.getTabBar === "function" ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 4 });
    this.loadIdentityLabel();
    const session = messageSession();
    const badgeRequest = this.badgeRequest = (this.badgeRequest || 0) + 1;
    syncUnreadBadge().then((count) => {
      if (session === messageSession() && badgeRequest === this.badgeRequest
        && typeof count === "number" && count !== this.data.unreadNotificationCount) {
        this.setData({ unreadNotificationCount: count });
      }
    });
  },

  // 身份标签用「我的公开贡献」算：与社区身份页同一套口径（buildCommunityIdentity），
  // 只是「我的」页不需要进度条，只取当前档位的名字。远端失败/未登录就不加前缀（不猜档位）。
  loadIdentityLabel() {
    const app = getApp();
    if (app.globalData.loggedIn !== true || typeof wx.request !== "function") return;
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    wx.request({
      url: `${baseUrl}/api/community/assets/mine`,
      header: typeof app.authHeader === "function" ? app.authHeader() : {},
      timeout: 7000,
      success: (response) => {
        const records = response.statusCode === 200 && response.data && response.data.assets;
        if (!Array.isArray(records)) return;
        const items = buildContributionItems(loadManagedAssets(), records);
        const label = buildCommunityIdentity(items).current.label;
        this.setData({ joinedLabel: joinedText(app.globalData.user || {}, label) });
      },
    });
  },

  // 头像即入口（产品负责人 2026-09-22）：未登录时点头像直接走微信登录（右下角绿色角标是引导标志），
  // 已登录时进二级页「编辑资料」改头像昵称。
  tapAvatar() {
    const app = getApp();
    if (app.globalData.loggedIn !== true) {
      this.login();
      return;
    }
    this.openProfileEditor();
  },

  // 已登录时头像的去处：二级页「编辑资料」。
  openProfileEditor() {
    const app = getApp();
    if (app.globalData.loggedIn !== true) {
      wx.showToast({ title: "请先登录", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/profile-edit/profile-edit" });
  },

  // 2026-10-02：真正的「设置」页已立项（pages/settings）：齿轮直接进设置页。
  // 退出登录原来挂在这颗齿轮上（当时设置页未立项），现在搬进设置页，这里只负责跳转。
  openSettings() {
    wx.navigateTo({ url: "/pages/settings/settings" });
  },

  login() {
    const app = getApp();
    // 登录只需一次点击：不再调用已被微信回收的 wx.getUserProfile，
    // 头像昵称登录后在二级页「编辑资料」里由用户自己选择（chooseAvatar + 昵称输入）。
    const startLogin = () => {
      wx.showLoading({ title: "登录中" });
      app.loginWithWechat((user, error) => {
        wx.hideLoading();
        if (!user) {
          const message = error === "wechat_credentials_not_configured"
            ? "请先配置微信登录密钥"
            : error === "api_base_url_not_configured"
              ? "当前版本未配置服务地址"
              : "登录失败，请重试";
          wx.showToast({ title: message, icon: "none" });
          return;
        }
        this.setData({ nickname: user.nickname, avatarUrl: usableAvatarUrl(user.avatarUrl), loggedIn: true, userId: String(user.publicId || ""), ...identityView(user) });
        wx.showToast({ title: "登录成功", icon: "success" });
      });
    };
    startLogin();
  },
  copyUserId() {
    if (this.data.userId) wx.setClipboardData({ data: this.data.userId });
  },

  openMenu(event) {
    const name = event.currentTarget.dataset.name;
    if (name === "我的账户") { wx.navigateTo({ url: "/pages/store/store" }); return; }
    if (name === "社区与贡献") { wx.navigateTo({ url: "/pages/contributions/contributions" }); return; }
    if (name === "我的收藏") { wx.navigateTo({ url: "/pages/favorites/favorites" }); return; }
    if (name === "我的资产") { wx.navigateTo({ url: "/pages/assets/assets" }); return; }
    // 旧文案兼容：历史版本「隐私与数据」这一行的落点，现在统一进设置页
    if (name === "隐私与数据") { wx.navigateTo({ url: "/pages/settings/settings" }); return; }
    if (name === "帮助与反馈") { wx.navigateTo({ url: "/pages/help-feedback/help-feedback" }); return; }
    // 旧文案兼容：历史版本这一行叫「客服与反馈」，仍按原来的落点（提交反馈标签）处理
    if (name === "客服与反馈") { wx.navigateTo({ url: "/pages/help-feedback/help-feedback?tab=submit" }); return; }
    wx.showToast({ title: `${name}正在开发`, icon: "none" });
  },

  /** 铃铛＝消息中心入口（产品负责人 2026-09-23 04:9x：「入口在绿框图3」） */
  openNotifications() {
    wx.navigateTo({ url: "/pages/messages/messages" });
  },

});
