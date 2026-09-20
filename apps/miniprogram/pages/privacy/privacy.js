Page({
  data: {
    loggedIn: false,
    deleting: false,
    sections: [
      {
        title: "我们处理的信息",
        items: [
          "微信登录标识：用于创建和识别账号；登录成功后保存。",
          "昵称和头像：仅在你授权微信资料后，用于账号页面展示。",
          "学习记录：包括作答、收藏、复习状态、学习进度和 AI 评分记录；登录后用于跨设备同步。",
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
          "账号资料和学习记录在你使用服务期间保存；你可在“我的”页查看账号信息、学习记录和 AI 额度。",
          "反馈联系方式仅在处理该反馈期间使用。",
          "需要查询、更正、复制或导出个人信息时，请通过“客服与反馈”提交申请。",
        ],
      },
    ],
  },

  onShow() {
    this.setData({ loggedIn: getApp().globalData.loggedIn === true });
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
      content: "注销后将删除账号身份映射、云端学习记录和本机缓存，且无法恢复。依法需要留存的交易记录将按规定保存。",
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
