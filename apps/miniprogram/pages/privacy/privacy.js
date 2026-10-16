// ⚠️ 已下线（2026-10-02，产品负责人确认）：本页已从 app.json 移除，不再打包、不再有入口。
// 内容去向：重试同步 / 导出 / 云冲突处理 / 注销账号 → pages/settings；
//           隐私说明与个人信息收集清单 → pages/personal-info；
//           客服与反馈 → pages/help-feedback（「我的」列表里的「帮助与反馈」）。
// 保留文件仅供追溯（与 pack-detail 的下线方式一致），不要新增改动。
const { personalCloudSync } = require("../../utils/personal-cloud-sync");

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
    sections: [
      {
        title: "我们处理的信息",
        items: [
          "微信登录标识：用于创建和识别账号；登录成功后保存。",
          "昵称和头像：仅在你授权微信资料后，用于账号页面展示。",
          "学习记录：包括作答、收藏、复习状态、学习进度和 AI 评分记录；登录后用于跨设备同步。",
          "私人题包、独立笔记和 AI 会话：登录后按账号隔离同步；纳入云端不等于公开或授权训练。",
          "AI 输入：你主动提交的题目、答案或追问内容，仅用于生成对应的解析、评分或辅助结果。",
          "反馈信息：你提交的描述、可选联系方式、截图及设备信息，仅用于定位和回复问题。",
        ],
      },
      {
        title: "处理规则与权限",
        items: [
          "不获取通讯录、精确位置、相册或麦克风权限。截图仅在你主动选择并提交反馈时上传。",
          "AI 功能使用第三方模型服务处理你主动提交的内容；请勿输入身份证号、银行卡号等敏感个人信息。",
          "不向其他用户公开你的微信登录标识、学习记录或反馈内容；不将个人信息用于与题库工具无关的营销。",
          "本机缓存用于保持登录状态和保存未同步的练习数据；你可在微信设置中清除小程序缓存。",
        ],
      },
      {
        title: "保存、访问与更正",
        items: [
          "账号资料和学习记录在你使用服务期间保存；你可在“我的”页查看账号信息、学习记录和豆币。",
          "反馈联系方式仅在处理该反馈期间使用。",
          "需要查询、更正、复制或导出个人信息时，请通过“客服与反馈”提交申请。",
        ],
      },
    ],
  },

  onShow() {
    this._cloudHidden = false;
    this.setData({ cloudBusy: false });
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
    this.setData({ loggedIn, personalSyncLabel,
      blockedCount: loggedIn && status ? status.blocked : 0,
      draftCount: loggedIn && status ? status.drafts || 0 : 0,
      unownedCount: loggedIn && status ? status.unowned : 0,
      cloudConflicts: loggedIn && status ? (status.conflictItems || []).map((item) => ({
        id: item.id, title: (item.incoming && (item.incoming.title || item.incoming.name)) || (item.current && (item.current.title || item.current.name)) || item.assetId,
        currentText: item.current ? JSON.stringify(item.current, null, 2) : "云端已删除",
        incomingText: item.incomingDeleted ? "此版本要求删除" : JSON.stringify(item.incoming, null, 2),
      })) : [],
    });
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
    wx.showModal({ title: "导出已同步的个人资产", content: "包含私人题包、题目、独立笔记、AI 会话及冲突历史。不包含待同步内容、未归属的本机内容、编辑中草稿或卡集笔记。导出文件含私密内容，请妥善保管。",
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

  openService() {
    wx.navigateTo({ url: "/pages/help-feedback/help-feedback?tab=submit" });
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
