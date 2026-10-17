const {
  GENDER_OPTIONS,
  examYearOptions,
  projectOptionsFromCatalog,
  ONBOARDING_SKIP_KEY,
  PRIVACY_AGREED_KEY,
  firstMissingField,
  isFilled,
  onboardingPatch,
} = require("../../utils/onboarding-options");

// 登录完成后的落点与 app.json 的 entryPagePath 一致；tabBar 页必须用 switchTab。
const ENTRY_URL = "/pages/review/review";

/**
 * 三步各自负责的必填项（2026-10-17 产品负责人：表单拆成三步，每屏只问一件事）。
 * 第 1 步另有"头像/昵称"两项，但都是选填，不进校验表。
 */
const STEP_FIELDS = {
  1: [{ key: "gender", label: "性别" }],
  // 2026-10-17 第九次调整：第 2 步问生日、也提交生日（服务端新增 birthday 字段，不再换算年龄段）。
  2: [{ key: "birthday", label: "生日" }],
  3: [{ key: "examProjectId", label: "目标考试项目" }, { key: "examYear", label: "报考年份" }],
};

/** 生日滚轮的年份范围：1940 年到今年（考研/专升本人群足够覆盖，也避免出现荒唐的年份）。 */
const BIRTH_YEAR_START = 1940;
/** 默认停在哪一天（只是滚轮的初始位置，用户不动滚轮就不算填过）。 */
const DEFAULT_BIRTH_YEAR = 2000;
/** 月/日两列的循环缓冲份数：数据重复这么多份、初始停在中段，上下各能连滚 2 份。
 *  微信 picker-view 没有 circular 属性，这是"能一直滚下去"最稳的近似做法（详见 initBirthdayWheels 注释）。 */
const WHEEL_LOOP_COPIES = 5;
const WHEEL_LOOP_MIDDLE = 2;
const MONTHS_PER_YEAR = 12;

/** 某年某月有多少天（含闰年）。 */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

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
  // 2026-10-17 第九次调整：第 2 项改为具体生日，服务端会做日期合法性校验。
  birthday_invalid: "生日不在可选范围内，请重新选择",
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
    yearOptions: examYearOptions(),
    projectOptions: [],
    projectError: "",
    gender: "",
    // 2026-10-17 第九次调整：第 2 步就是选生日（三列滚轮），birthday 为空串表示还没选过，
    // 直接提交 `YYYY-MM-DD` 给服务端保存——不再换算年龄段（产品负责人明确要求）。
    birthday: "",
    birthdayLabel: "",
    birthYears: [],
    birthMonths: [],
    birthDays: [],
    birthDaySpan: 0,
    birthdayIndexes: [0, 0, 0],
    examProjectId: "",
    examYear: 0,
    nickname: "",
    avatarUrl: "",
    avatarDataUrl: "",
    // 2026-10-17 产品负责人：表单从"一屏四问 + 折叠头像昵称"改成三步（每屏只问一件事）——
    // 第 1 步头像/昵称/性别，第 2 步年龄段，第 3 步考试信息（项目 + 报考年份）。
    // 四项仍然全部必填、仍然在同一个 page 内采集：不改 DEC-109 的"就地必填四项"，只改采集节奏。
    step: 1,
    stepTotal: 3,
    // 隐私授权：勾选后才允许登录（登录即收集 openid，后面还要收四项属性与头像昵称）。
    agreed: false,
    hint: "",
    statusBarHeight: 44,
    // 2026-10-17 第十八次调整：顶部那行的高度与右侧让位，按微信胶囊的实测矩形算（见 measureNavigation）。
    navBarHeight: 44,
    menuRightGap: 100,
  },

  onLoad() {
    this.measureNavigation();
    this.initBirthdayWheels();
    this.loadProjects();
  },

  /**
   * 生日滚轮的三列数据（2026-10-17 第八次调整；第十七次给月/日加循环缓冲）。
   * 年：1940 → 今年（不循环，范围本身就够长）；月：1–12 循环；日：按当前年月算天数（闰年 2 月正确）。
   *
   * 为什么是"数据重复 5 份"而不是真无限循环：微信 `picker-view` 没有 `circular` 属性，
   * 原生不支持首尾相接。这里让月/日两列数据各自重复 `WHEEL_LOOP_COPIES` 份并初始停在中段，
   * 于是上下各能连续滚 2 份（月 = 24 个月、日 = 2 个整月），实际使用中不会触到端点。
   * 代价：滚到最外一份到底就停住，不是数学意义上的无限循环。
   *
   * 初始位置停在 2000-01-01 的中段，但 `birthday` 仍是空串——用户不动滚轮就当作"还没选"，
   * 避免把默认值当真实生日写进账号。
   */
  initBirthdayWheels() {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let year = BIRTH_YEAR_START; year <= currentYear; year += 1) years.push(year);
    const months = [];
    for (let copy = 0; copy < WHEEL_LOOP_COPIES; copy += 1) {
      for (let month = 1; month <= 12; month += 1) months.push(month);
    }
    const baseDays = daysInMonth(DEFAULT_BIRTH_YEAR, 1);
    const days = [];
    for (let copy = 0; copy < WHEEL_LOOP_COPIES; copy += 1) {
      for (let day = 1; day <= baseDays; day += 1) days.push(day);
    }
    this.setData({
      birthYears: years,
      birthMonths: months,
      birthDays: days,
      birthDaySpan: baseDays,
      birthdayIndexes: [
        Math.max(0, years.indexOf(DEFAULT_BIRTH_YEAR)),
        MONTHS_PER_YEAR * WHEEL_LOOP_MIDDLE,
        baseDays * WHEEL_LOOP_MIDDLE,
      ],
    });
  },

  /**
   * 滚轮停止后收值：月/日取模还原成真实值；只有"当月天数变了"才重建日列并重新定位到中段，
   * 否则保留用户当前所在的索引（避免把用户滚到第 4 份又硬拉回第 3 份造成跳动）。
   */
  onBirthdayChange(event) {
    const values = (event && event.detail && event.detail.value) || [];
    const years = this.data.birthYears;
    const months = this.data.birthMonths;
    const yearIndex = Math.min(Math.max(Number(values[0]) || 0, 0), years.length - 1);
    const monthIndex = Math.min(Math.max(Number(values[1]) || 0, 0), months.length - 1);
    const dayIndex = Math.min(Math.max(Number(values[2]) || 0, 0), this.data.birthDays.length - 1);
    const year = years[yearIndex];
    const month = (monthIndex % MONTHS_PER_YEAR) + 1;
    const total = daysInMonth(year, month);
    // 日号按"变化前那一列的天数"还原（重复数组里同一日号出现多次），换月后若超出当月天数就夹住——
    // 这样 1 月 20 日切到 2 月仍是 20 日，而不是被取模算成别的日子。
    const oldSpan = this.data.birthDaySpan || total;
    let day = (dayIndex % oldSpan) + 1;
    if (day > total) day = total;
    let nextDayIndex = dayIndex;
    let birthDays = this.data.birthDays;
    if (total !== this.data.birthDaySpan) {
      // 换月/换年导致天数变化：重建日列（同样重复 WHEEL_LOOP_COPIES 份），把选中的日停到中段。
      birthDays = [];
      for (let copy = 0; copy < WHEEL_LOOP_COPIES; copy += 1) {
        for (let d = 1; d <= total; d += 1) birthDays.push(d);
      }
      nextDayIndex = total * WHEEL_LOOP_MIDDLE + day - 1;
    }
    const padded = (value) => String(value).padStart(2, "0");
    const birthday = `${year}-${padded(month)}-${padded(day)}`;
    this.setData({
      birthDays,
      birthDaySpan: total,
      birthdayIndexes: [yearIndex, monthIndex, nextDayIndex],
      birthday,
      birthdayLabel: `${year}年${padded(month)}月${padded(day)}日`,
      hint: "",
    });
  },

  // 引导层的瞬时层只有「步骤切换」这一种，且 step 不跨页保留；这里显式回到第一步，
  // 避免二次进入时停在上次的第 3 步（仓库既有约定：瞬态层必须随页面离开收拢）。
  onHide() {
    if (this.data.stage === "form") this.setData({ step: 1 });
  },

  measureNavigation() {
    if (typeof wx.getWindowInfo !== "function" && typeof wx.getSystemInfoSync !== "function") return;
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const statusBarHeight = Number(windowInfo && windowInfo.statusBarHeight) || 24;
    // 2026-10-17 第十八次调整（产品负责人：「实际效果没有对齐」）：顶部那一行要跟微信胶囊对齐，
    // 不能写死 88rpx——不同机型的状态栏高度、胶囊高度与上下留白都不一样。
    // 拿胶囊的实测矩形，把 header 高度算成"胶囊上下留白对称、等高"，于是 header 的垂直中线 = 胶囊中线；
    // 进度条右端再按胶囊左边缘让开，避免伸到胶囊底下。
    let navBarHeight = 44;
    let menuRightGap = 100;
    if (typeof wx.getMenuButtonBoundingClientRect === "function") {
      const menu = wx.getMenuButtonBoundingClientRect();
      const windowWidth = Number(windowInfo && windowInfo.windowWidth) || 375;
      if (menu && Number(menu.height) > 0 && Number(menu.top) >= statusBarHeight) {
        navBarHeight = Number(menu.height) + (Number(menu.top) - statusBarHeight) * 2;
        menuRightGap = Math.max(0, windowWidth - Number(menu.left) + 8);
      }
    }
    this.setData({ statusBarHeight, navBarHeight, menuRightGap });
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
      this.setData({ stage: "form", step: 1 });
      // 第 1 步就有头像选择（微信隐私接口），进表单时先把微信侧授权跑一遍。
      this.ensurePrivacyAuthorization();
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
   * 进入表单第 1 步时补一次微信侧隐私授权（2026-10-17 三步化后头像选择就在第 1 步，不再靠"展开"触发）。
   * 引导页的勾选只是**我们自己的**入口；`open-type=chooseAvatar` 与 `type="nickname"`
   * 是微信隐私接口，微信侧授权没跑完时点头像会静默无反应、昵称也拿不到填充。
   *
   * 2026-10-17 二次修：不再在 `app.js` 注册 `onNeedPrivacyAuthorization` 替用户点同意。
   * 那样会吞掉微信原生隐私弹窗，部分真机上反而让头像选择与昵称填充静默失败。
   * 现在只探测 `getPrivacySetting`，需要时调用 `requirePrivacyAuthorize`，
   * 让微信展示原生授权框；不需要授权或低版本没有接口时安静跳过。
   */
  ensurePrivacyAuthorization() {
    if (typeof wx.getPrivacySetting !== "function") return;
    wx.getPrivacySetting({
      success: (setting) => {
        if (!setting || setting.needAuthorization !== true) return;
        if (typeof wx.requirePrivacyAuthorize !== "function") return;
        wx.requirePrivacyAuthorize({
          success: () => this.setData({ hint: "" }),
          // 只有"确实需要授权、而申请又被拒"才提示；文案不再引导用户回登录页重勾（那一步管不到微信侧）。
          fail: () => this.setData({ hint: "微信没有允许本次隐私授权，头像和昵称可能设置不了" }),
        });
      },
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

  /**
   * 三步向导的"下一步"：只校验**当前这一步**的必填项，缺了就停在本步提示、不发请求。
   * 第 3 步的按钮就是「开始使用」，直接走 submit（submit 里仍用 firstMissingField 做一次全量兜底，
   * 防止用返回手势跳步后带着空值提交）。
   */
  nextStep() {
    if (this.data.submitting) return;
    const fields = STEP_FIELDS[this.data.step] || [];
    const missing = fields.find((field) => !isFilled(field.key, this.data[field.key]));
    if (missing) {
      this.setData({ hint: `请先选择${missing.label}` });
      wx.showToast({ title: `请先选择${missing.label}`, icon: "none" });
      return;
    }
    if (this.data.step >= this.data.stepTotal) {
      this.submit();
      return;
    }
    this.setData({ step: this.data.step + 1, hint: "" });
  },

  /** 上一步：只回退步骤，已选的值全部保留（不重问已回答的问题）。 */
  prevStep() {
    if (this.data.submitting || this.data.step <= 1) return;
    this.setData({ step: this.data.step - 1, hint: "" });
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
