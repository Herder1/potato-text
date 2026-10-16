const { subjects } = require("../../data/catalog");
const { usableAvatarUrl } = require("../../utils/avatar");

// 每日目标档位：与 user-auth-store 的 DAILY_GOAL_CHOICES 对齐（服务端复核同一组值）。
const DAILY_GOAL_CHOICES = [10, 15, 20, 30, 45, 60];
const DEFAULT_DAILY_GOAL_MINUTES = 20;

// 编辑资料（二级页）：头像、昵称、个人签名、所在地区、学习方向、每日目标、公开学习数据开关的唯一编辑入口，
// 从“我的”页点头像 / 点“编辑头像与昵称”进来。
// 采集方式遵循微信现行口径：open-type=chooseAvatar + input type=nickname，不再调用已被回收的 wx.getUserProfile。
Page({
  data: {
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    avatarUrl: "",
    draftAvatarUrl: "",
    draftAvatarDataUrl: "",
    draftNickname: "",
    userId: "",
    draftSignature: "",
    draftRegion: "",
    draftRegionParts: [],
    draftStudyField: "",
    draftDailyGoalMinutes: DEFAULT_DAILY_GOAL_MINUTES,
    draftDailyGoalLabel: `${DEFAULT_DAILY_GOAL_MINUTES} 分钟`,
    draftPublicLearningStats: false,
    studyFieldOptions: [{ id: "", name: "未设置" }, ...subjects.map((subject) => ({ id: subject.id, name: subject.name }))],
    studyFieldIndex: 0,
    dailyGoalOptions: DAILY_GOAL_CHOICES.map((minutes) => ({ minutes, label: `${minutes} 分钟` })),
    dailyGoalIndex: DAILY_GOAL_CHOICES.indexOf(DEFAULT_DAILY_GOAL_MINUTES),
    savingProfile: false,
  },

  onLoad() {
    this.measureNavigation();
    this.resetDraft();
  },

  onShow() {
    // 只在没有未保存改动时同步最新账号数据，避免把用户正在填的内容冲掉。
    if (!this.dirty) this.resetDraft();
    const app = getApp();
    if (app.globalData.loggedIn === true && !app.globalData.user?.publicId
      && typeof app.refreshAuthSession === "function") {
      app.refreshAuthSession((updated) => {
        if (updated && !this.dirty && getApp().globalData.loggedIn === true) this.resetDraft();
      });
    }
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

  goBack() {
    if (typeof wx.navigateBack === "function") wx.navigateBack();
  },

  resetDraft() {
    const app = getApp();
    const user = app.globalData.user || {};
    const dailyGoalMinutes = DAILY_GOAL_CHOICES.includes(Number(user.dailyGoalMinutes)) ? Number(user.dailyGoalMinutes) : DEFAULT_DAILY_GOAL_MINUTES;
    const region = String(user.region || "");
    const studyField = String(user.studyField || "");
    // 老账号存的是已失效的微信外链头像（thirdwx.qlogo.cn），直接渲染是灰色人像占位；
    // 统一走 utils/avatar，非 data URL 一律回落到品牌绿「薯」（产品负责人 2026-09-22 真机反馈）。
    const storedAvatar = usableAvatarUrl(user.avatarUrl);
    this.dirty = false;
    this.setData({
      avatarUrl: storedAvatar,
      draftAvatarUrl: storedAvatar,
      draftAvatarDataUrl: "",
      draftNickname: user.nickname || "",
      userId: app.globalData.loggedIn === true ? String(user.publicId || "") : "",
      draftSignature: String(user.signature || ""),
      draftRegion: region,
      draftRegionParts: region ? region.split(" ") : [],
      draftStudyField: studyField,
      studyFieldIndex: Math.max(0, this.data.studyFieldOptions.findIndex((option) => option.name === studyField)),
      draftDailyGoalMinutes: dailyGoalMinutes,
      draftDailyGoalLabel: `${dailyGoalMinutes} 分钟`,
      dailyGoalIndex: Math.max(0, DAILY_GOAL_CHOICES.indexOf(dailyGoalMinutes)),
      draftPublicLearningStats: user.publicLearningStats === true,
      savingProfile: false,
    });
  },
  copyUserId() {
    if (this.data.userId) wx.setClipboardData({ data: this.data.userId });
  },

  // chooseAvatar 回调给的是本地临时文件路径，必须转成 data URL 交给服务端保存
  // （临时路径重启即失效，也不能把微信路径写进用户资料）。
  chooseAvatar(event) {
    const tempPath = String(event && event.detail && event.detail.avatarUrl || "");
    if (!tempPath) return;
    const app = getApp();
    this.dirty = true;
    this.setData({ draftAvatarUrl: tempPath, avatarCleared: false });
    wx.showLoading({ title: "处理头像" });
    app.avatarDataUrl(tempPath).then((result) => {
      wx.hideLoading();
      if (result.error) {
        this.setData({ draftAvatarUrl: this.data.avatarUrl || "", draftAvatarDataUrl: "" });
        const tooLarge = result.error === "avatar_too_large";
        wx.showToast({ title: tooLarge ? "头像图片过大，请换一张" : "头像读取失败，请重试", icon: "none" });
        return;
      }
      this.setData({ draftAvatarDataUrl: result.dataUrl });
    });
  },

  /** 头像图加载失败（少见：data URL 损坏）时回落到绿色「薯」，不留破图。 */
  handleAvatarError() {
    this.setData({ draftAvatarUrl: "", draftAvatarDataUrl: "" });
  },

  inputNickname(event) {
    this.dirty = true;
    this.setData({ draftNickname: String(event && event.detail && event.detail.value || "") });
  },

  inputSignature(event) {
    this.dirty = true;
    this.setData({ draftSignature: String(event && event.detail && event.detail.value || "") });
  },

  /** 地区用微信原生三级选择器（picker mode="region"）：只存拼好的名字，不存行政区划代码。 */
  chooseRegion(event) {
    const parts = (event && event.detail && event.detail.value || []).map((part) => String(part || "").trim()).filter(Boolean);
    this.dirty = true;
    this.setData({ draftRegionParts: parts, draftRegion: parts.join(" ") });
  },

  chooseStudyField(event) {
    const index = Number(event && event.detail && event.detail.value) || 0;
    const option = this.data.studyFieldOptions[index] || this.data.studyFieldOptions[0];
    this.dirty = true;
    this.setData({ studyFieldIndex: index, draftStudyField: option.id ? option.name : "" });
  },

  chooseDailyGoal(event) {
    const index = Number(event && event.detail && event.detail.value) || 0;
    const option = this.data.dailyGoalOptions[index] || this.data.dailyGoalOptions[0];
    this.dirty = true;
    this.setData({ dailyGoalIndex: index, draftDailyGoalMinutes: option.minutes, draftDailyGoalLabel: option.label });
  },

  togglePublicLearningStats(event) {
    this.dirty = true;
    this.setData({ draftPublicLearningStats: Boolean(event && event.detail && event.detail.value) });
  },

  saveProfile() {
    const app = getApp();
    const user = app.globalData.user || {};
    if (app.globalData.loggedIn !== true) { wx.showToast({ title: "请先登录", icon: "none" }); return; }
    if (this.data.savingProfile) return;
    const nickname = String(this.data.draftNickname || "").trim();
    if (!nickname) { wx.showToast({ title: "请填写昵称", icon: "none" }); return; }
    if (nickname.length > 32) { wx.showToast({ title: "昵称最多 32 个字", icon: "none" }); return; }
    const signature = String(this.data.draftSignature || "").trim();
    if (signature.length > 40) { wx.showToast({ title: "签名最多 40 个字", icon: "none" }); return; }
    const patch = {};
    if (nickname !== user.nickname) patch.nickname = nickname;
    if (this.data.draftAvatarDataUrl && this.data.draftAvatarDataUrl !== this.data.avatarUrl) patch.avatarUrl = this.data.draftAvatarDataUrl;
    if (signature !== String(user.signature || "")) patch.signature = signature;
    if (this.data.draftRegion !== String(user.region || "")) patch.region = this.data.draftRegion;
    if (this.data.draftStudyField !== String(user.studyField || "")) patch.studyField = this.data.draftStudyField;
    if (Number(this.data.draftDailyGoalMinutes) !== Number(user.dailyGoalMinutes)) patch.dailyGoalMinutes = Number(this.data.draftDailyGoalMinutes);
    if (this.data.draftPublicLearningStats !== (user.publicLearningStats === true)) patch.publicLearningStats = this.data.draftPublicLearningStats;
    if (!Object.keys(patch).length) { wx.showToast({ title: "资料没有变化", icon: "none" }); return; }
    this.setData({ savingProfile: true });
    app.saveProfile(patch, (saved, error) => {
      if (!saved) {
        this.setData({ savingProfile: false });
        const message = error === "avatar_too_large" ? "头像图片过大，请换一张"
          : error === "avatar_invalid_format" ? "头像格式不支持，请换一张"
            : error === "nickname_invalid" ? "昵称不合规，请修改"
              : error === "signature_invalid" ? "签名最多 40 个字"
                : error === "region_invalid" ? "地区名过长，请重新选择"
                  : error === "study_field_invalid" ? "学习方向不在可选范围内"
                    : error === "daily_goal_invalid" ? "每日目标档位不支持"
                      : error === "public_learning_stats_invalid" ? "公开设置取值不合法"
                        : "保存失败，请重试";
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      this.resetDraft();
      wx.showToast({ title: "资料已保存", icon: "success" });
      if (typeof wx.navigateBack === "function") setTimeout(() => wx.navigateBack(), 600);
    });
  },
});
