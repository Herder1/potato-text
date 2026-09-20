const { assetStats, loadManagedAssets } = require("../../utils/asset-store");

Page({
  data: {
    nickname: "薯考同学",
    avatarUrl: "",
    loggedIn: false,
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    unreadNotificationCount: 0,
    menu: ["我的账户", "我的贡献", "社区身份", "隐私与数据", "客服与反馈"],
    assetStats: { total: 0, questions: 0, packs: 0, notes: 0, pendingCount: 0 },
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
    this.setData({
      assetStats: assetStats(loadManagedAssets()),
      unreadNotificationCount: Math.max(0, Number(wx.getStorageSync("shukao_unread_notification_count")) || 0),
      nickname: app.globalData.user.nickname,
      avatarUrl: app.globalData.user.avatarUrl || "",
      loggedIn: app.globalData.loggedIn === true,
    });
    const tabBar = typeof this.getTabBar === "function" ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 4 });
  },

  login() {
    const app = getApp();
    if (app.globalData.loggedIn) {
      wx.showActionSheet({
        itemList: ["退出当前账号"],
        success: ({ tapIndex }) => {
          if (tapIndex !== 0) return;
          app.logout(() => {
            this.setData({ nickname: "薯考同学", avatarUrl: "", loggedIn: false });
            wx.showToast({ title: "已退出登录", icon: "none" });
          });
        },
      });
      return;
    }
    const startLogin = (profile = {}) => {
      wx.showLoading({ title: "登录中" });
      app.loginWithWechat(profile, (user, error) => {
        wx.hideLoading();
        if (!user) {
          wx.showToast({ title: error === "wechat_credentials_not_configured" ? "请先配置微信登录密钥" : "登录失败，请重试", icon: "none" });
          return;
        }
        this.setData({ nickname: user.nickname, avatarUrl: user.avatarUrl || "", loggedIn: true });
        wx.showToast({ title: "登录成功", icon: "success" });
      });
    };
    if (typeof wx.getUserProfile !== "function") { startLogin(); return; }
    wx.getUserProfile({
      desc: "用于显示学习账号头像和昵称",
      success: ({ userInfo }) => startLogin(userInfo || {}),
      fail: () => startLogin(),
    });
  },

  openMenu(event) {
    const name = event.currentTarget.dataset.name;
    if (name === "我的账户") { wx.navigateTo({ url: "/pages/store/store" }); return; }
    if (name === "我的贡献") { wx.navigateTo({ url: "/pages/contributions/contributions" }); return; }
    if (name === "社区身份") { wx.navigateTo({ url: "/pages/community-identity/community-identity" }); return; }
    if (name === "我的资产") { wx.navigateTo({ url: "/pages/assets/assets" }); return; }
    if (name === "隐私与数据") { wx.navigateTo({ url: "/pages/privacy/privacy" }); return; }
    if (name === "帮助与反馈") { wx.navigateTo({ url: "/pages/help-feedback/help-feedback" }); return; }
    if (name === "客服与反馈") { wx.navigateTo({ url: "/pages/help-feedback/help-feedback?tab=submit" }); return; }
    wx.showToast({ title: `${name}正在开发`, icon: "none" });
  },

  openNotifications() {
    this.setData({ unreadNotificationCount: 0 });
    wx.setStorageSync("shukao_unread_notification_count", 0);
    wx.showToast({ title: "暂无新消息", icon: "none" });
  },

});
