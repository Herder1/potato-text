const { personalCloudSync } = require("../../utils/personal-cloud-sync");
const { APP_VERSION } = require("../../utils/app-meta");

// 2026-10-02：新建设置页（产品负责人指定）。功能来源＝原「隐私与数据」页拆分：
// 重试同步 / 导出 / 云状态与冲突处理 / 注销账号 搬到这里；隐私正文搬到「个人信息收集清单」；
// 客服与反馈沿用「我的 → 帮助与反馈」入口；退出登录从「我的」右上角齿轮搬到这里。
Page({
  data: {
    loggedIn: false,
    deleting: false,
    personalSyncLabel: "未登录",
    cloudBusy: false,
    cloudConflicts: [],
    blockedCount: 0,
    draftCount: 0,
    unownedCount: 0,
    version: APP_VERSION,
    rows: [
      { key: "practice", title: "练习设置", note: "题目顺序、答题反馈与每日目标" },
      { key: "about", title: "关于我们", note: "协议、隐私、AI 服务与经营资质" },
      { key: "personal", title: "个人信息收集清单", note: "查看已收集的数据类型和使用目的" },
      { key: "device", title: "设备信息", note: "查看登录设备和本机标识" },
      { key: "delete", title: "注销账号", note: "删除账号个人数据（法定留存除外）", danger: true },
    ],
  },

  onShow() {
    this._cloudHidden = false;
    this.setData({ cloudBusy: false, deleting: false });
    this.refreshPersonalAssets();
  },

  onPersonalAssetsSynced() {
    if (!this._cloudHidden) this.refreshPersonalAssets();
  },

  onHide() { this._cloudHidden = true; },
  onUnload() { this._cloudHidden = true; },

  refreshPersonalAssets() {
    const app = getApp();
    const loggedIn = app.globalData.loggedIn === true;
    const status = typeof app.personalAssetSyncStatus === "function" ? app.personalAssetSyncStatus() : null;
    const personalSyncLabel = !loggedIn
      ? "登录后同步私人题包、独立笔记和 AI 会话"
      : status && status.syncing
        ? "正在同步个人资产"
        : status && status.lastError
          ? "同步未完成，本机内容已保留，请重试"
          : status && status.conflicts
            ? `有 ${status.conflicts} 条内容存在不同版本，请确认`
            : status && status.queued
              ? `${status.queued} 条内容尚未同步`
              : status && status.lastSyncedAt
                ? "个人资产已同步"
                : "尚未完成首次同步";
    this.setData({
      loggedIn,
      personalSyncLabel,
      blockedCount: loggedIn && status ? status.blocked : 0,
      draftCount: loggedIn && status ? status.drafts || 0 : 0,
      unownedCount: loggedIn && status ? status.unowned : 0,
      cloudConflicts: loggedIn && status ? (status.conflictItems || []).map((item) => ({
        id: item.id,
        title: (item.incoming && (item.incoming.title || item.incoming.name)) || (item.current && (item.current.title || item.current.name)) || item.assetId,
        currentText: item.current ? JSON.stringify(item.current, null, 2) : "云端已删除",
        incomingText: item.incomingDeleted ? "此版本要求删除" : JSON.stringify(item.incoming, null, 2),
      })) : [],
    });
  },

  noop() {},

  openRow(event) {
    const key = String(event.currentTarget.dataset.key || "");
    if (key === "practice") { wx.navigateTo({ url: "/pages/practice-settings/practice-settings" }); return; }
    if (key === "about") { wx.navigateTo({ url: "/pages/about/about" }); return; }
    if (key === "personal") { wx.navigateTo({ url: "/pages/personal-info/personal-info" }); return; }
    if (key === "device") { wx.navigateTo({ url: "/pages/device-info/device-info" }); return; }
    if (key === "delete") { this.deleteAccount(); return; }
  },

  async retryPersonalAssets() {
    if (!this.data.loggedIn || this.data.cloudBusy) return;
    this.setData({ cloudBusy: true });
    try { await getApp().syncPersonalAssets(); }
    catch (error) { wx.showToast({ title: "同步未完成，请保留本机内容", icon: "none" }); }
    finally {
      if (!this._cloudHidden) { this.setData({ cloudBusy: false }); this.refreshPersonalAssets(); }
    }
  },

  resolvePersonalConflict(event) {
    if (this.data.cloudBusy || !this.data.loggedIn) return;
    const { id, choice } = event.currentTarget.dataset;
    const sync = personalCloudSync();
    const owner = sync.owner();
    wx.showModal({ title: "确认采用这个版本", content: "确认后会以所选版本继续同步；未选版本保留在冲突历史中。若选择删除，将同时清理该资产的冲突历史。",
      success: async ({ confirm }) => {
        if (!confirm || this._cloudHidden || owner !== sync.owner()) return;
        this.setData({ cloudBusy: true });
        const result = await sync.resolveConflict(id, choice);
        if (this._cloudHidden || owner !== sync.owner()) return;
        this.setData({ cloudBusy: false });
        this.refreshPersonalAssets();
        wx.showToast({ title: result ? "版本已确认" : "请先重试同步再确认", icon: result ? "success" : "none" });
      },
    });
  },

  exportPersonalAssets() {
    if (!this.data.loggedIn || this.data.cloudBusy) return;
    const owner = personalCloudSync().owner();
    wx.showModal({ title: "导出我的数据", content: "包含私人题包、题目、独立笔记、AI 会话及冲突历史。不包含待同步内容、未归属的本机内容、编辑中草稿或卡集笔记。导出文件含私密内容，请妥善保管。",
      success: async ({ confirm }) => {
        if (!confirm || this._cloudHidden || owner !== personalCloudSync().owner()) return;
        if (typeof wx.getFileSystemManager !== "function" || typeof wx.shareFileMessage !== "function" || !wx.env || !wx.env.USER_DATA_PATH) {
          wx.showToast({ title: "当前微信版本不支持文件导出", icon: "none" }); return;
        }
        this.setData({ cloudBusy: true });
        const payload = await getApp().exportPersonalAssets();
        if (this._cloudHidden || owner !== personalCloudSync().owner()) return;
        this.setData({ cloudBusy: false });
        if (!payload) { wx.showToast({ title: "导出失败，请重试", icon: "none" }); return; }
        const fs = wx.getFileSystemManager();
        const fileName = `personal-assets-${Date.now()}.json`;
        const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;
        const cleanup = () => fs.unlink({ filePath, fail: () => {} });
        fs.writeFile({ filePath, data: JSON.stringify(payload, null, 2), encoding: "utf8",
          success: () => {
            if (this._cloudHidden || owner !== personalCloudSync().owner()) { cleanup(); return; }
            wx.shareFileMessage({ filePath, fileName,
              fail: () => wx.showToast({ title: "文件未导出，可再次重试", icon: "none" }), complete: cleanup });
          },
          fail: () => wx.showToast({ title: "导出文件写入失败", icon: "none" }),
        });
      },
    });
  },

  // 退出登录：原来挂在「我的」右上角齿轮（当时设置页未立项），现在搬进设置页。
  logoutAccount() {
    const app = getApp();
    wx.showModal({
      title: "退出登录",
      // 2026-10-03 口径（A 档）：本机不再显示该账号的学习数据（已按账号存档），重登同一账号恢复；
      // 原文案"退出后本机保留的学习数据不会删除，重新登录可继续同步"在新口径下已不准确。
      content: "退出后本机不再显示你的学习数据、知识卡与收藏（已按账号存档），重新登录同一账号即可恢复。",
      confirmText: "退出登录",
      success: ({ confirm }) => {
        if (!confirm) return;
        app.logout(() => {
          // 主动退出＝会话结束：直接回注册引导页（不看"先随便看看"标记）。
          // 冷启动/回前台的闸门在 App.onShow 里，站内退出不会触发它，所以这里必须显式跳。
          if (typeof wx.reLaunch === "function") { wx.reLaunch({ url: "/pages/onboarding/onboarding" }); return; }
          wx.showToast({ title: "已退出登录", icon: "none" });
        });
      },
    });
  },

  deleteAccount() {
    if (!this.data.loggedIn) {
      wx.showToast({ title: "请先登录后操作", icon: "none" });
      return;
    }
    wx.showModal({
      title: "确认注销账号",
      content: "注销后会删除账号身份、学习记录、私人内容、AI 内容和本机缓存；已公开投稿会保留但改为匿名，反馈/举报和依法需要留存的交易记录会按期限保存，且无法恢复。",
      confirmText: "确认注销",
      confirmColor: "#b63636",
      success: ({ confirm }) => {
        if (!confirm || this.data.deleting) return;
        this.setData({ deleting: true });
        getApp().deleteAccount((success) => {
          this.setData({ deleting: false });
          if (!success) {
            wx.showToast({ title: "注销未完成，请联系客服", icon: "none" });
            return;
          }
          wx.showToast({ title: "账号已注销", icon: "success" });
          setTimeout(() => wx.reLaunch({ url: "/pages/review/review" }), 600);
        });
      },
    });
  },
});
