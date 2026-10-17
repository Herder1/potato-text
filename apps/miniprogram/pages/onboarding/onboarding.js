const {
  GENDER_OPTIONS,
  AGE_BAND_OPTIONS,
  examYearOptions,
  projectOptionsFromCatalog,
  ONBOARDING_SKIP_KEY,
  PRIVACY_AGREED_KEY,
  firstMissingField,
  onboardingPatch,
} = require("../../utils/onboarding-options");
const { closeTransientLayers } = require("../../utils/page-layers");

// 登录完成后的落点与 app.json 的 entryPagePath 一致；tabBar 页必须用 switchTab。
const ENTRY_URL = "/pages/review/review";

/** 服务端/网络错误的用户可见文案：只覆盖引导层真会遇到的几种，其余给通用兜底。 */
const ERROR_TEXT = {
  api_base_url_not_configured: "网络未就绪，请稍后重试",
  wx_login_unavailable: "当前环境不支持微信登录",
  wechat_code_missing: "没拿到登录凭证，请重试",
  wechat_login_failed: "登录失败，请重试",
  wechat_openid_required: "登录失败，请重试",
  user_account_banned: "账号已被限制，请联系客服",
  login_required: "登录状态已失效，请重新登录",
  profile_patch_required: "请至少填写一项",
  gender_invalid: "性别取值不支持",
  age_band_invalid: "年龄段取值不支持",
  exam_project_invalid: "考试项目不在可选范围内",
  exam_year_invalid: "报考年份不在可选范围内",
  nickname_invalid: "昵称不合规，请修改",
  avatar_invalid_format: "头像格式不支持，请换一张",
  avatar_too_large: "头像图片过大，请换一张",
};

// 注册引导层：未登录时冷启动拦一次（可「先随便看看」）。
// 登录成功后再按服务端回传的 onboardingCompleted 决定：已填全 → 直接进首页；
// 没填全 → 就地展开四项必填（性别 / 年龄段 / 目标考试项目 / 报考年份）+ 头像昵称选填。
// 「未注册」与「已注册未登录」共用这一个入口：微信登录即注册，服务端用 isNewUser 区分，
// 客户端只看 onboardingCompleted（新账号必然为 false），因此不需要额外的探测接口。
Page({
  data: {
    stage: "login",
    loggingIn: false,
    submitting: false,
    genderOptions: GENDER_OPTIONS,
    ageBandOptions: AGE_BAND_OPTIONS,
    yearOptions: examYearOptions(),
    projectOptions: [],
    projectError: "",
    gender: "",
    ageBand: "",
    examProjectId: "",
    examYear: 0,
    nickname: "",
    avatarUrl: "",
    avatarDataUrl: "",
    optionalOpen: false,
    // 隐私授权：勾选后才允许登录（登录即收集 openid，后面还要收四项属性与头像昵称）。
    agreed: false,
    hint: "",
    statusBarHeight: 44,
  },

  onLoad() {
    this.measureNavigation();
    this.loadProjects();
  },

  // 离开本页时收掉展开出来的「头像与昵称（选填）」块：仓库既有约定是所有带 Open 标记的
  // 瞬态层都必须随页面离开收拢，避免跨页残留（tests/page-transient-layers.test.js 静态守住）。
  onHide() {
    closeTransientLayers(this, ["optionalOpen"]);
  },

  measureNavigation() {
    if (typeof wx.getWindowInfo !== "function" && typeof wx.getSystemInfoSync !== "function") return;
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.setData({ statusBarHeight: Number(windowInfo && windowInfo.statusBarHeight) || 24 });
  },

  /**
   * 目标考试项目是必填项，选项必须来自服务端（DEC-098 的登记表）；
   * 拉不到就不让提交，而不是给一个编造的默认值——否则这项数据从第一天起就是脏的。
   */
  loadProjects() {
    const app = getApp();
    const baseUrl = String(app && app.globalData && app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || typeof wx.request !== "function") {
      this.setData({ projectError: "网络未就绪，点这里重试" });
      return;
    }
    this.setData({ projectError: "" });
    wx.request({
      url: `${baseUrl}/api/catalog`,
      method: "GET",
      timeout: 8000,
      success: (response) => {
        const options = response && response.statusCode === 200 ? projectOptionsFromCatalog(response.data) : [];
        if (!options.length) {
          this.setData({ projectError: "考试项目加载失败，点这里重试" });
          return;
        }
        this.setData({ projectOptions: options, projectError: "" });
      },
      fail: () => this.setData({ projectError: "考试项目加载失败，点这里重试" }),
    });
  },

  /** 隐私授权勾选：未勾选不允许登录——登录就要收 openid，后面还要收四项属性与头像昵称。 */
  toggleAgree() {
    this.setData({ agreed: !this.data.agreed, hint: "" });
  },

  /** 打开微信里的《用户隐私保护指引》官方文本（后台配置的那一份）。 */
  openPrivacyContract() {
    if (typeof wx.openPrivacyContract !== "function") {
      this.setData({ hint: "当前版本打不开隐私指引，请升级微信后重试" });
      return;
    }
    wx.openPrivacyContract({
      fail: () => this.setData({ hint: "隐私指引打开失败，请稍后重试" }),
    });
  },

  /**
   * 打开我们自己的《用户协议》《隐私政策》（DEC-110 ③）：
   * 正文由后台「平台设置」维护，没发布就在法律页明确显示「尚未发布」——不阻断本次登录。
   */
  openDoc(event) {
    const doc = String(event.currentTarget.dataset.doc || "");
    wx.navigateTo({ url: `/pages/legal/legal?doc=${encodeURIComponent(doc)}` });
  },

  login() {
    if (this.data.loggingIn) return;
    if (!this.data.agreed) {
      this.setData({ hint: "请先阅读并同意《用户隐私保护指引》" });
      wx.showToast({ title: "请先同意隐私指引", icon: "none" });
      return;
    }
    const app = getApp();
    // 同意标记只写本机：它表达的是"用户在本机同意过"，不参与账号归属，也不上行同步。
    wx.setStorageSync(PRIVACY_AGREED_KEY, true);
    this.setData({ loggingIn: true, hint: "" });
    app.loginWithWechat((user, error) => {
      this.setData({ loggingIn: false });
      if (!user) {
        this.setData({ hint: ERROR_TEXT[error] || "登录失败，请重试" });
        return;
      }
      if (user.onboardingCompleted === true) {
        this.finish();
        return;
      }
      this.setData({ stage: "form" });
    });
  },

  /**
   * 四个档位一律按 dataset 里的**字符串**原样存（2026-10-04 修）：
   * 早前 examYear 被转成 Number，而模板里比较的是 `examYear === item.id`，
   * 而 examYearOptions 的 id 是 String(year)（utils/onboarding-options.js）。
   * `2026 === "2026"` 在 WXML 里恒为 false → 点年份没有任何选中态，真机观感就是"年份点不了"。
   * 类型转换只留在提交口 onboardingPatch（那里本来就会 Number()），选择态一律字符串对字符串。
   */
  selectOption(event) {
    const field = String(event && event.currentTarget && event.currentTarget.dataset.field || "");
    const id = String(event && event.currentTarget && event.currentTarget.dataset.id || "");
    if (!field) return;
    this.setData({ [field]: id, hint: "" });
  },

  /**
   * 展开「头像与昵称（选填）」时补一次微信侧隐私授权（2026-10-04）。
   * 引导页的勾选只是我们自己的入口；`open-type=chooseAvatar` 与 `type="nickname"`
   * 是微信隐私接口，微信侧授权没真正跑完时，点头像会**静默无反应**、昵称也拿不到填充。
   * 这里显式触发一次 requirePrivacyAuthorize；不需要授权或低版本没有该接口时直接跳过。
   */
  toggleOptional() {
    if (!this.data.optionalOpen) this.ensurePrivacyAuthorization();
    this.setData({ optionalOpen: !this.data.optionalOpen });
  },

  ensurePrivacyAuthorization() {
    if (typeof wx.requirePrivacyAuthorize !== "function") return;
    wx.requirePrivacyAuthorize({
      fail: () => this.setData({ hint: "微信侧隐私授权未通过，头像和昵称可能用不了；可回登录页重新同意《用户隐私保护指引》" }),
    });
  },

  chooseAvatar(event) {
    const tempPath = String(event && event.detail && event.detail.avatarUrl || "");
    if (!tempPath) return;
    const app = getApp();
    this.setData({ avatarUrl: tempPath });
    wx.showLoading({ title: "处理头像" });
    app.avatarDataUrl(tempPath).then((result) => {
      if (typeof wx.hideLoading === "function") wx.hideLoading();
      if (result.error) {
        this.setData({ avatarUrl: "", avatarDataUrl: "" });
        wx.showToast({ title: ERROR_TEXT[result.error] || "头像读取失败，请重试", icon: "none" });
        return;
      }
      this.setData({ avatarDataUrl: result.dataUrl });
    });
  },

  /**
   * 昵称收值（2026-10-04 加固）：bindinput / bindblur / 微信昵称填充都走这里。
   * 微信昵称填充是通过 detail.value 回传的；部分基础库的 blur 事件不带 value，
   * 老写法 `|| ""` 会在失焦那一下把刚填好的微信昵称清空（表现为"读不到微信昵称"）。
   * 所以只接受真正的字符串，拿不到就保留原值。
   */
  inputNickname(event) {
    const value = event && event.detail ? event.detail.value : undefined;
    if (typeof value !== "string") return;
    this.setData({ nickname: value });
  },

  /** 四项必填：缺哪一项就提示哪一项，不发请求。 */
  submit() {
    if (this.data.submitting) return;
    const missing = firstMissingField(this.data);
    if (missing) {
      this.setData({ hint: `请先选择${missing.label}` });
      wx.showToast({ title: `请先选择${missing.label}`, icon: "none" });
      return;
    }
    const patch = onboardingPatch(this.data);
    const nickname = String(this.data.nickname || "").trim();
    if (nickname) patch.nickname = nickname;
    if (this.data.avatarDataUrl) patch.avatarUrl = this.data.avatarDataUrl;
    const app = getApp();
    this.setData({ submitting: true, hint: "" });
    app.saveProfile(patch, (user, error) => {
      if (!user) {
        this.setData({ submitting: false, hint: ERROR_TEXT[error] || "保存失败，请重试" });
        return;
      }
      this.setData({ submitting: false });
      this.finish();
    });
  },

  /** 「先随便看看」：不写任何数据，只在本机记一个标记，避免每次冷启动都弹。 */
  skip() {
    wx.setStorageSync(ONBOARDING_SKIP_KEY, true);
    this.finish();
  },

  finish() {
    if (typeof wx.switchTab === "function") {
      wx.switchTab({ url: ENTRY_URL });
      return;
    }
    wx.reLaunch({ url: ENTRY_URL });
  },
});
