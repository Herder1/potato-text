const {
  API_BASE_URLS,
  API_OVERRIDE_STORAGE_KEY,
  DEVELOPMENT_API_BASE_URLS,
  apiBaseUrlCandidates,
  detectEnvVersion,
  normalizeApiBaseUrl,
  resolveApiBaseUrl,
} = require("./utils/api-environment");
const { normalizeOfficialQuestions } = require("./utils/question-sync");
const cardBoxStore = require("./utils/card-box-store");
const { personalCloudSync } = require("./utils/personal-cloud-sync");
const { syncStatus } = require("./utils/sync-status");
const {
  BEAN_STORAGE_KEY,
  LEGACY_CREDIT_STORAGE_KEY,
  formatBeans,
  isBeanAmount,
  migrateLegacyStoredBeans,
  roundBeans,
} = require("./utils/bean-pricing");
const { ONBOARDING_SKIP_KEY, PRIVACY_AGREED_KEY } = require("./utils/onboarding-options");

const OFFICIAL_QUESTIONS_CACHE_KEY = "shukao_official_questions";
const OFFICIAL_QUESTIONS_CACHE_TTL = 15 * 1000;
const AUTH_SESSION_KEY = "shukao_auth_session";
const DEVICE_ID_KEY = "shukao_device_id";
/** DEC-107：默认 2 豆币 = 原 20 点 AI 额度；退出登录后回到这个值（不保留上一个账号的余额）。 */
const DEFAULT_BEANS = 2;

App({
  globalData: {
    user: {
      nickname: "薯考同学",
      avatarUrl: "",
    },
    // DEC-107：账户只有豆币（原 AI 额度按 1 点 = 0.1 豆币折算），默认 2 豆币 = 原 20 点额度
    beans: DEFAULT_BEANS,
    apiEnvironment: "develop",
    apiBaseUrl: API_BASE_URLS.develop,
    billingAccount: null,
    userId: "test-user",
    authToken: "",
    accountLifecycleGeneration: 0,
    loggedIn: false,
    authMode: "guest",
    reviewReminderTemplateId: "",
    officialQuestions: [],
    officialQuestionsUpdatedAt: 0,
  },

  onLaunch() {
    this.setupPrivacyAuthorization();
    const savedBeans = wx.getStorageSync(BEAN_STORAGE_KEY);
    const hasSavedBeans = savedBeans !== "" && savedBeans !== null && savedBeans !== undefined && Number.isFinite(Number(savedBeans));
    if (hasSavedBeans) {
      this.globalData.beans = roundBeans(savedBeans);
    } else {
      // 已安装的旧版本本地缓存的是「AI 额度」，按 1 点 = 0.1 豆币折算一次后写回新键。
      const migrated = migrateLegacyStoredBeans(wx.getStorageSync(LEGACY_CREDIT_STORAGE_KEY));
      if (migrated !== null) {
        this.globalData.beans = migrated;
        wx.setStorageSync(BEAN_STORAGE_KEY, migrated);
        if (typeof wx.removeStorageSync === "function") wx.removeStorageSync(LEGACY_CREDIT_STORAGE_KEY);
      }
    }
    const apiEnvironment = detectEnvVersion(wx);
    const savedApiBaseUrl = String(wx.getStorageSync(API_OVERRIDE_STORAGE_KEY) || "");
    this.globalData.apiEnvironment = apiEnvironment;
    this.globalData.apiBaseUrl = resolveApiBaseUrl({
      envVersion: apiEnvironment,
      storedOverride: savedApiBaseUrl,
      apiBaseUrls: API_BASE_URLS,
    });
    this.globalData.apiBaseUrlConfigured = Boolean(this.globalData.apiBaseUrl);
    this.restoreAuthSession();
    this.syncBillingAccount();
    if (typeof wx.onNetworkStatusChange === "function") {
      wx.onNetworkStatusChange(({ isConnected }) => { if (isConnected) this.syncPersonalAssets(); });
    }
  },

  onShow() {
    if (this.globalData.loggedIn) {
      this.syncPersonalAssets();
      return;
    }
    this.maybeGateOnboarding();
  },

  /**
   * 注册引导闸门（2026-10-03 产品负责人口径）：未登录时冷启动拦一次，进引导页（底部上滑）。
   * 只拦一次——用户点了「先随便看看」就写本机标记，之后靠写操作（收藏 / 同步 / 投稿）各自要求登录，
   * 不做"点哪弹哪"的重复骚扰。返回是否真的发了跳转，便于页面与用例自测。
   */
  maybeGateOnboarding() {
    if (this.globalData.loggedIn) return false;
    if (wx.getStorageSync(ONBOARDING_SKIP_KEY)) return false;
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const current = pages[pages.length - 1];
    if (String(current && current.route || "") === "pages/onboarding/onboarding") return false;
    if (typeof wx.reLaunch !== "function") return false;
    wx.reLaunch({ url: "/pages/onboarding/onboarding" });
    return true;
  },

  /**
   * 隐私授权协同（2026-10-03）：引导页的勾选是**我们自己**的授权入口（同意标记只写本机）；
   * 这里接管微信侧的原生授权询问——用户已经在本机同意过（或已登录，等于走过引导闸门）就直接放行，
   * 否则明确拒绝并给出可见提示，避免头像等隐私接口静默失败、也避免同一次同意问两遍。
   * 注册前的能力探测是必须的：低版本基础库没有这个接口。
   */
  setupPrivacyAuthorization() {
    if (typeof wx.onNeedPrivacyAuthorization !== "function") return false;
    wx.onNeedPrivacyAuthorization((resolve) => {
      const agreed = Boolean(wx.getStorageSync(PRIVACY_AGREED_KEY)) || this.globalData.loggedIn === true;
      if (typeof resolve !== "function") return;
      if (agreed) {
        resolve({ event: "agree" });
        return;
      }
      resolve({ event: "disagree" });
      if (typeof wx.showToast === "function") wx.showToast({ title: "请先同意《用户隐私保护指引》", icon: "none" });
    });
    return true;
  },

  ensureDeviceId() {
    let deviceId = String(wx.getStorageSync(DEVICE_ID_KEY) || "");
    if (!deviceId) {
      deviceId = `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      wx.setStorageSync(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  },

  applyAuthSession(session) {
    if (!session || !session.token || !session.user || Number(session.expiresAt) <= Date.now()) return false;
    this.globalData.authToken = session.token;
    this.globalData.userId = session.user.id;
    this.globalData.user = session.user;
    this.globalData.loggedIn = true;
    this.globalData.authMode = session.authMode || "wechat";
    wx.setStorageSync(AUTH_SESSION_KEY, session);
    // 登录后立刻让本地卡集接上服务端同步（C15：卡集与知识卡搬到服务端）。
    this.configureCardLibrarySync();
    this.configurePersonalAssetSync();
    return true;
  },

  restoreAuthSession() {
    const saved = wx.getStorageSync(AUTH_SESSION_KEY);
    if (!this.applyAuthSession(saved)) { personalCloudSync().configure(null); return; }
    this.refreshAuthSession();
  },

  refreshAuthSession(callback) {
    if (!this.globalData.authToken || !this.globalData.apiBaseUrl || typeof wx.request !== "function") return;
    const requestedToken = this.globalData.authToken;
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/auth/me`,
      method: "GET",
      header: { Authorization: `Bearer ${this.globalData.authToken}` },
      success: (response) => {
        if (requestedToken !== this.globalData.authToken) return;
        if (response.statusCode === 401) {
          this.clearAuthSession();
          if (callback) callback(null, "auth_session_invalid");
          return;
        }
        const payload = response.data || {};
        if (!payload.user) return;
        const saved = wx.getStorageSync(AUTH_SESSION_KEY) || {};
        this.applyAuthSession({ ...saved, user: payload.user });
        if (payload.account) {
          this.globalData.billingAccount = payload.account;
          this.globalData.beans = roundBeans(payload.account.beanBalance);
        }
        this.syncLearningState();
        this.syncCardLibrary();
        this.syncPersonalAssets();
        if (callback) callback(payload.user, "");
      },
    });
  },

  // 登录只剩 wx.login 一条路径：wx.getUserProfile 已被微信回收（2022-10-25 起只返回匿名数据），
  // 头像昵称改由用户在“我的”页主动选择，经 saveProfile 提交（服务端唯一写入点 POST /api/auth/profile）。
  loginWithWechat(callback) {
    if (!this.globalData.apiBaseUrl) {
      if (callback) callback(null, "api_base_url_not_configured");
      return;
    }
    if (typeof wx.login !== "function") {
      if (callback) callback(null, "wx_login_unavailable");
      return;
    }
    wx.login({
      success: ({ code }) => {
        if (!code) {
          if (callback) callback(null, "wechat_code_missing");
          return;
        }
        wx.request({
          url: `${this.globalData.apiBaseUrl}/api/auth/wechat/login`,
          method: "POST",
          data: {
            code,
            deviceId: this.ensureDeviceId(),
          },
          success: (response) => {
            const payload = response.data || {};
            if (response.statusCode !== 200 || !payload.token || !payload.user) {
              // 被封禁的账号会带受限说明，直接告诉用户原因和到期时间。
              const notice = this.restrictionNotice(payload);
              if (notice) wx.showModal({ title: "账号已被限制", content: notice, showCancel: false });
              if (callback) callback(null, payload.error || "wechat_login_failed");
              return;
            }
            this.applyAuthSession({ token: payload.token, expiresAt: payload.expiresAt, user: payload.user, authMode: payload.authMode });
            if (payload.account) {
              this.globalData.billingAccount = payload.account;
              this.globalData.beans = roundBeans(payload.account.beanBalance);
            }
            // 登录后先问一次"本机未归属内容要不要归入这个账号"，再同步（统一归属，但不静默上传）。
            this.settleGuestWorkspace();
            this.syncLearningState();
            this.syncCardLibrary();
            this.syncPersonalAssets();
            if (callback) callback(payload.user, "");
          },
          fail: (error) => callback && callback(null, error && error.errMsg || "wechat_login_failed"),
        });
      },
      fail: (error) => callback && callback(null, error && error.errMsg || "wx_login_failed"),
    });
  },

  // 头像与昵称是用户自设数据：只写服务端 /api/auth/profile，成功后覆盖本地会话里的用户投影，
  // 让“我的”“社区身份”等页面本地即可读到新值（无需等下一次 /api/auth/me）。
  saveProfile(patch, callback) {
    if (!this.globalData.authToken || !this.globalData.apiBaseUrl || typeof wx.request !== "function") {
      if (callback) callback(null, "login_required");
      return;
    }
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/auth/profile`,
      method: "POST",
      header: this.authHeader({ "content-type": "application/json" }),
      data: patch,
      success: (response) => {
        const user = response.statusCode === 200 && response.data && response.data.user;
        if (!user) {
          if (callback) callback(null, String(response.data && response.data.error || "profile_update_failed"));
          return;
        }
        const saved = wx.getStorageSync(AUTH_SESSION_KEY) || {};
        this.applyAuthSession({ ...saved, user });
        if (callback) callback(user, "");
      },
      fail: (error) => callback && callback(null, error && error.errMsg || "profile_update_failed"),
    });
  },

  /**
   * 把 chooseAvatar 回调里的本地临时图压到 200KB 内，再转成 data URL 交给服务端。
   * 返回 Promise<{ dataUrl } | { error }>：读不到或压不下去时明确报错，让页面给用户可见提示。
   */
  avatarDataUrl(filePath) {
    const maxBytes = 200 * 1024;
    const fileSystem = typeof wx.getFileSystemManager === "function" ? wx.getFileSystemManager() : null;
    if (!fileSystem || typeof fileSystem.readFileSync !== "function") return Promise.resolve({ error: "avatar_unsupported" });
    const sizeOf = (path) => new Promise((resolve) => {
      if (typeof fileSystem.getFileInfo !== "function") { resolve(0); return; }
      fileSystem.getFileInfo({ filePath: path, success: ({ size }) => resolve(Number(size) || 0), fail: () => resolve(0) });
    });
    const compress = (path, quality) => new Promise((resolve) => {
      if (typeof wx.compressImage !== "function") { resolve(path); return; }
      wx.compressImage({ src: path, quality, success: ({ tempFilePath }) => resolve(tempFilePath || path), fail: () => resolve(path) });
    });
    return (async () => {
      let path = String(filePath || "");
      if (!path) return { error: "avatar_missing" };
      let size = await sizeOf(path);
      for (const quality of [70, 50, 30]) {
        if (size > 0 && size <= maxBytes) break;
        path = await compress(path, quality);
        size = await sizeOf(path);
      }
      if (!(size > 0 && size <= maxBytes)) return { error: "avatar_too_large" };
      try {
        const extension = String(path).split(".").pop().toLowerCase();
        const mime = extension === "png" ? "png" : extension === "webp" ? "webp" : "jpeg";
        return { dataUrl: `data:image/${mime};base64,${fileSystem.readFileSync(path, "base64")}` };
      } catch (error) {
        return { error: "avatar_read_failed" };
      }
    })();
  },

  clearAuthSession() {
    this.globalData.accountLifecycleGeneration += 1;
    this.globalData.authToken = "";
    this.globalData.loggedIn = false;
    this.globalData.authMode = "guest";
    this.globalData.userId = "test-user";
    this.globalData.user = { nickname: "薯考同学", avatarUrl: "" };
    wx.removeStorageSync(AUTH_SESSION_KEY);
    // 豆币余额是本机内存里的账号镜像：退出时先复位，免得界面上还显示上一个账号的余额。
    // 存储里的那一份**不清**——它随账号命名空间一起存档，重登同账号原样恢复（口径第 3 条）。
    this.globalData.beans = DEFAULT_BEANS;
    // 2026-10-03 口径「临时 B、最终混合」第 3 条：退出登录/切换账号**不得立即清空本地学习数据**。
    // 卡集与知识卡、题目收藏、学习与复习进度等都按 userId（作用域）存进各自命名空间并切走：
    // 界面看不到（第 5 条），但数据还在本机（第 3 条）；重登同账号恢复，服务端同步成功后按保留期限回收（第 6 条）。
    cardBoxStore.configureCardLibrarySync(null);
    personalCloudSync().configure(null);
  },

  /**
   * 本机未归属内容的归属确认（2026-10-03 产品负责人选定「统一归属 + 登录时一次性确认」）。
   *
   * 背景：DEC-106 原本规定"历史本地内容不自动归属"，初衷是**隐私**——共享设备上，别人未登录时留下的内容
   * 不该被下一个登录者静默上传到云端。现在改成**可见地询问一次**：确认 → 归入当前账号（并立即上行）；
   * 选"留在本机" → 不归入，并记下已问过，之后登录不再重复打扰。
   *
   * 学习与复习数据不在此列：它在登录时随账号直接带走（"登录才能保存进度"，见 personal-cloud-sync 注释）。
   */
  settleGuestWorkspace() {
    const sync = typeof personalCloudSync === "function" ? personalCloudSync() : null;
    if (!sync || typeof sync.pendingGuestAdoption !== "function") return false;
    const pending = sync.pendingGuestAdoption();
    if (!pending || !pending.count || pending.declined) return false;
    if (typeof wx.showModal !== "function") return false;
    wx.showModal({
      title: "本机有内容未归属",
      content: `本机还有 ${pending.count} 项未归属的内容（题包、笔记等）。归入后会同步到当前账号；选择"留在本机"则只保存在这台设备上。`,
      confirmText: "归入当前账号",
      cancelText: "留在本机",
      success: ({ confirm }) => {
        if (!confirm) { sync.keepGuestWorkspace(); return; }
        if (sync.adoptGuestWorkspace()) {
          if (typeof wx.showToast === "function") wx.showToast({ title: "已归入当前账号", icon: "none" });
          // 归入的是"要上传"的那部分，立刻上行，别等下一次触发。
          this.syncPersonalAssets();
        }
      },
    });
    return true;
  },

  configurePersonalAssetSync() {
    return personalCloudSync().configure(this.globalData.authToken ? {
      userId: this.globalData.userId,
      token: this.globalData.authToken,
      baseUrl: this.globalData.apiBaseUrl,
      environment: this.globalData.apiEnvironment,
    } : null);
  },

  schedulePersonalAssetSync() {
    if (this.globalData.loggedIn) personalCloudSync().schedule();
  },

  syncPersonalAssets(callback) {
    if (!this.globalData.loggedIn || !this.globalData.apiBaseUrl || typeof wx.request !== "function") {
      if (callback) callback(null, "login_required");
      return Promise.resolve(null);
    }
    this.configurePersonalAssetSync();
    return personalCloudSync().sync().then((library) => {
      if (callback) callback(library, library ? "" : "personal_asset_sync_failed");
      return library;
    });
  },

  personalAssetSyncStatus() {
    return personalCloudSync().status();
  },

  onPersonalAssetsSynced() {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const page = pages[pages.length - 1];
    if (page && typeof page.onPersonalAssetsSynced === "function") page.onPersonalAssetsSynced();
  },

  exportPersonalAssets(callback) {
    if (!this.globalData.loggedIn) {
      if (callback) callback(null, "login_required");
      return Promise.resolve(null);
    }
    this.configurePersonalAssetSync();
    return personalCloudSync().exportAssets().then((payload) => {
      if (callback) callback(payload, payload ? "" : "personal_asset_export_failed");
      return payload;
    });
  },

  /** 卡集同步上下文：地址与会话令牌由 app 注入，store 自己不依赖 app（便于单测）。 */
  configureCardLibrarySync() {
    if (!this.globalData.authToken) {
      cardBoxStore.configureCardLibrarySync(null);
      return null;
    }
    return cardBoxStore.configureCardLibrarySync({
      baseUrl: this.globalData.apiBaseUrl,
      token: this.globalData.authToken,
    });
  },

  /**
   * 卡集与知识卡同步（C15）：本地库上行 → 服务端按并集 + LWW + 墓碑合并 → 结果回写本地。
   * 失败不影响使用：本地库始终是可直接读写的副本，联网/登录后自动补齐。
   */
  syncCardLibrary(callback) {
    if (!this.globalData.authToken || !this.globalData.apiBaseUrl || typeof wx.request !== "function") {
      if (callback) callback(null, "login_required");
      return;
    }
    this.configureCardLibrarySync();
    // 发起即"待同步"，只有服务端合并成功回执后才算已同步（口径第 4 条）。
    syncStatus().markPending("cards", "");
    cardBoxStore.syncCardLibrary().then((library) => {
      if (library) syncStatus().markSynced("cards");
      else syncStatus().markPending("cards", "card_library_sync_failed");
      if (callback) callback(library || null, library ? "" : "card_library_sync_failed");
    });
  },

  // 社区等“属于某个用户”的接口一律带会话身份，归属由服务端从 token 解析，不再由客户端声明 userId。
  authHeader(extra = {}) {
    const token = this.globalData.authToken;
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
  },

  // 服务端限制（禁言/禁止投稿/公开限制/封禁）会返回 restriction.message，这里统一取出来给用户看。
  restrictionNotice(payload) {
    const message = payload && payload.restriction && payload.restriction.message;
    if (message) return String(message);
    if (payload && payload.error === "user_account_banned") return "该账号已被封禁，如有疑问请联系客服。";
    if (payload && payload.error === "user_restricted") return "当前账号处于限制状态，暂时不能执行这个操作。";
    return "";
  },

  logout(callback) {
    const token = this.globalData.authToken;
    this.clearAuthSession();
    if (!token || !this.globalData.apiBaseUrl || typeof wx.request !== "function") {
      if (callback) callback();
      return;
    }
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/auth/logout`,
      method: "POST",
      header: { Authorization: `Bearer ${token}` },
      complete: () => callback && callback(),
    });
  },

  deleteAccount(callback) {
    if (!this.globalData.authToken || !this.globalData.apiBaseUrl || typeof wx.request !== "function") {
      if (callback) callback(false, "login_required");
      return;
    }
    const deletingToken = this.globalData.authToken;
    const deletingGeneration = ++this.globalData.accountLifecycleGeneration;
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/account`,
      method: "DELETE",
      header: { Authorization: `Bearer ${deletingToken}` },
      success: (response) => {
        if (deletingToken !== this.globalData.authToken
          || deletingGeneration !== this.globalData.accountLifecycleGeneration) return;
        if (response.statusCode !== 200) {
          if (callback) callback(false, String(response.data && response.data.error || "account_delete_failed"));
          return;
        }
        personalCloudSync().forget();
        cardBoxStore.configureCardLibrarySync(null);
        this.clearSavedFiles(() => {
          if (deletingGeneration !== this.globalData.accountLifecycleGeneration) return;
          this.clearAuthSession();
          if (typeof wx.clearStorageSync === "function") wx.clearStorageSync();
          this.globalData.billingAccount = null;
          this.globalData.officialQuestions = [];
          this.globalData.officialQuestionsUpdatedAt = 0;
          if (callback) callback(true, "");
        });
      },
      fail: () => callback && callback(false, "request_failed"),
    });
  },

  clearSavedFiles(callback) {
    const finish = () => {
      if (typeof callback === "function") callback();
    };
    if (typeof wx.getSavedFileList !== "function" || typeof wx.removeSavedFile !== "function") {
      finish();
      return;
    }
    wx.getSavedFileList({
      success: (result) => {
        const files = Array.isArray(result && result.fileList) ? result.fileList : [];
        if (!files.length) {
          finish();
          return;
        }
        let remaining = files.length;
        const done = () => {
          remaining -= 1;
          if (remaining <= 0) finish();
        };
        files.forEach((file) => wx.removeSavedFile({
          filePath: file.filePath,
          complete: done,
        }));
      },
      fail: finish,
    });
  },

  collectLearningState() {
    const bookmarks = { ...(wx.getStorageSync("shukao_bookmarks") || {}) };
    (this.globalData.officialQuestions || []).forEach((question) => {
      const legacy = wx.getStorageSync(`shukao_bookmark_${question.id}`);
      if (typeof legacy === "boolean" && !bookmarks[question.id]) bookmarks[question.id] = { value: legacy, updatedAt: 0 };
    });
    return {
      attempts: wx.getStorageSync("shukao_attempts") || [],
      reviewStates: wx.getStorageSync("shukao_review_states") || {},
      reviewHistory: wx.getStorageSync("shukao_review_history") || [],
      bookmarks,
      savedKnowledgeIds: wx.getStorageSync("shukao_saved_knowledge_cards") || [],
      scoreHistory: wx.getStorageSync("shukao_subjective_score_history") || [],
      reminder: wx.getStorageSync("shukao_review_reminder_settings") || null,
    };
  },

  applyLearningState(state) {
    if (!state) return;
    wx.setStorageSync("shukao_attempts", state.attempts || []);
    wx.setStorageSync("shukao_review_states", state.reviewStates || {});
    wx.setStorageSync("shukao_review_history", state.reviewHistory || []);
    wx.setStorageSync("shukao_bookmarks", state.bookmarks || {});
    Object.entries(state.bookmarks || {}).forEach(([id, item]) => wx.setStorageSync(`shukao_bookmark_${id}`, item && item.value === true));
    wx.setStorageSync("shukao_saved_knowledge_cards", state.savedKnowledgeIds || []);
    wx.setStorageSync("shukao_subjective_score_history", state.scoreHistory || []);
    if (state.reminder) wx.setStorageSync("shukao_review_reminder_settings", state.reminder);
  },

  syncLearningState(callback) {
    if (!this.globalData.authToken || !this.globalData.apiBaseUrl || typeof wx.request !== "function") {
      if (callback) callback(null, "login_required");
      return;
    }
    const requestToken = this.globalData.authToken;
    const requestGeneration = this.globalData.accountLifecycleGeneration;
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/learning/state/sync`,
      method: "POST",
      header: { Authorization: `Bearer ${requestToken}` },
      data: this.collectLearningState(),
      success: (response) => {
        if (requestToken !== this.globalData.authToken
          || requestGeneration !== this.globalData.accountLifecycleGeneration) return;
        const state = response.statusCode === 200 && response.data && response.data.state;
        if (state) {
          this.applyLearningState(state);
          // 只有真的拿到服务端状态才算同步成功（口径第 4 条：不得伪装成已同步）。
          syncStatus().markSynced("learning");
        }
        if (callback) callback(state || null, state ? "" : String(response.data && response.data.error || "learning_sync_failed"));
        if (!state) syncStatus().markPending("learning", String(response.data && response.data.error || "learning_sync_failed"));
      },
      fail: (error) => {
        if (requestToken !== this.globalData.authToken
          || requestGeneration !== this.globalData.accountLifecycleGeneration) return;
        syncStatus().markPending("learning", String(error && error.errMsg || "learning_sync_failed"));
        if (callback) callback(null, error && error.errMsg || "learning_sync_failed");
      },
    });
  },

  syncBillingAccount(callback) {
    if (!this.globalData.apiBaseUrl || typeof wx.request !== "function") return;
    const requestToken = this.globalData.authToken;
    const requestGeneration = this.globalData.accountLifecycleGeneration;
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/billing/account?userId=${encodeURIComponent(this.globalData.userId)}`,
      method: "GET",
      header: requestToken ? { Authorization: `Bearer ${requestToken}` } : {},
      success: (response) => {
        if (requestToken !== this.globalData.authToken
          || requestGeneration !== this.globalData.accountLifecycleGeneration) return;
        const account = response && response.statusCode === 200 && response.data && response.data.account;
        if (!account) return;
        this.globalData.billingAccount = account;
        this.globalData.beans = roundBeans(account.beanBalance);
        wx.setStorageSync(BEAN_STORAGE_KEY, this.globalData.beans);
        if (callback) callback(account);
      },
    });
  },

  syncOfficialQuestions(callback, options = {}) {
    const requestedBookId = String(options.bookId || "");
    const scopedCacheKey = requestedBookId ? `${OFFICIAL_QUESTIONS_CACHE_KEY}_${requestedBookId}` : OFFICIAL_QUESTIONS_CACHE_KEY;
    const metadataKey = `${scopedCacheKey}_metadata`;
    const storedMetadata = wx.getStorageSync(metadataKey) || {};
    const storedScopedQuestions = wx.getStorageSync(scopedCacheKey);
    const cached = requestedBookId
      ? (Array.isArray(storedScopedQuestions) && storedScopedQuestions.length
        ? normalizeOfficialQuestions(storedScopedQuestions)
        : this.globalData.officialQuestions.filter((question) => question.bookId === requestedBookId))
      : (this.globalData.officialQuestions.length
        ? this.globalData.officialQuestions
        : (Array.isArray(storedScopedQuestions) ? normalizeOfficialQuestions(storedScopedQuestions) : []));
    const cacheUpdatedAt = Number(storedMetadata.updatedAt) || this.globalData.officialQuestionsUpdatedAt;
    const cacheFresh = cached.length && Date.now() - cacheUpdatedAt < OFFICIAL_QUESTIONS_CACHE_TTL;
    if (!options.force && cacheFresh) {
      if (requestedBookId) {
        const otherBooks = this.globalData.officialQuestions.filter((question) => question.bookId !== requestedBookId);
        this.globalData.officialQuestions = otherBooks.concat(cached);
      } else {
        this.globalData.officialQuestions = cached;
      }
      this.globalData.officialQuestionsUpdatedAt = cacheUpdatedAt;
      if (callback) callback(cached, { source: "memory" });
      return;
    }
    if (cached.length) {
      if (requestedBookId) {
        const otherBooks = this.globalData.officialQuestions.filter((question) => question.bookId !== requestedBookId);
        this.globalData.officialQuestions = otherBooks.concat(cached);
      } else {
        this.globalData.officialQuestions = cached;
      }
      this.globalData.officialQuestionsUpdatedAt = cacheUpdatedAt;
    }
    if (cached.length && callback) {
      callback(cached, { source: "cache", refreshing: true });
    }
    let notify = (questions, metadata) => {
      if (callback) callback(questions, metadata);
    };
    const finish = (questions, source, error = "", responseMetadata = {}) => {
      const normalized = normalizeOfficialQuestions(questions);
      if (requestedBookId) {
        const otherBooks = this.globalData.officialQuestions.filter((question) => question.bookId !== requestedBookId);
        this.globalData.officialQuestions = otherBooks.concat(normalized);
      } else {
        this.globalData.officialQuestions = normalized;
      }
      this.globalData.officialQuestionsUpdatedAt = Date.now();
      if (source === "server") {
        wx.setStorageSync(scopedCacheKey, normalized);
        wx.setStorageSync(metadataKey, {
          etag: String(responseMetadata.etag || ""),
          version: Number(responseMetadata.version) || 0,
          count: normalized.length,
          updatedAt: Date.now(),
        });
      }
      notify(normalized, { source, error, ...responseMetadata });
    };
    if (typeof wx.request !== "function") {
      finish(cached, cached.length ? "memory" : "unavailable", "request_unavailable");
      return;
    }
    this._officialQuestionRequests = this._officialQuestionRequests || {};
    if (this._officialQuestionRequests[scopedCacheKey]) {
      if (callback) this._officialQuestionRequests[scopedCacheKey].push(callback);
      return;
    }
    const subscribers = callback ? [callback] : [];
    this._officialQuestionRequests[scopedCacheKey] = subscribers;
    notify = (questions, metadata) => {
      delete this._officialQuestionRequests[scopedCacheKey];
      subscribers.forEach((subscriber) => subscriber(questions, metadata));
    };
    const apiBaseUrls = this.apiBaseUrlCandidates();
    const requestAt = (index, previousError = "") => {
      const apiBaseUrl = apiBaseUrls[index];
      if (!apiBaseUrl) {
        finish(cached, cached.length ? "cache" : "unavailable", previousError || "request_failed");
        return;
      }
      wx.request({
        url: `${apiBaseUrl}/api/questions?library=official${requestedBookId ? `&bookId=${encodeURIComponent(requestedBookId)}` : ""}`,
        method: "GET",
        timeout: 15000,
        header: storedMetadata.etag ? { "If-None-Match": String(storedMetadata.etag) } : {},
        success: (response) => {
          if (response && response.statusCode === 304 && cached.length) {
            const nextMetadata = { ...storedMetadata, updatedAt: Date.now() };
            wx.setStorageSync(metadataKey, nextMetadata);
            this.globalData.officialQuestionsUpdatedAt = nextMetadata.updatedAt;
            notify(cached, { source: "validated", notModified: true });
            return;
          }
          const questions = response && response.statusCode === 200 && response.data && response.data.questions;
          if (!Array.isArray(questions)) {
            requestAt(index + 1, "invalid_response");
            return;
          }
          this.globalData.apiBaseUrl = apiBaseUrl;
          finish(questions, "server", "", {
            etag: String(response.data.etag || response.header && (response.header.ETag || response.header.etag) || ""),
            version: Number(response.data.version) || 0,
          });
        },
        fail: (error) => requestAt(index + 1, error && error.errMsg || "request_failed"),
      });
    };
    requestAt(0);
  },

  apiBaseUrlCandidates() {
    return apiBaseUrlCandidates({
      envVersion: this.globalData.apiEnvironment,
      baseUrl: this.globalData.apiBaseUrl,
      developmentApiBaseUrls: DEVELOPMENT_API_BASE_URLS,
    });
  },

  // 扣豆币（DEC-107）：金额单位是**豆币**，一次 AI 调用的价目见 utils/bean-pricing.js。
  spendBeans(amount, context = {}) {
    const cost = roundBeans(amount);
    if (!isBeanAmount(cost)) return false;
    if (this.globalData.beans < cost) return false;
    this.globalData.beans = roundBeans(this.globalData.beans - cost);
    wx.setStorageSync(BEAN_STORAGE_KEY, this.globalData.beans);
    if (this.globalData.apiBaseUrl && typeof wx.request === "function") {
      const referenceId = String(context.referenceId || `mini-ai-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      wx.request({
        url: `${this.globalData.apiBaseUrl}/api/billing/beans/consume`,
        method: "POST",
        header: this.globalData.authToken ? { Authorization: `Bearer ${this.globalData.authToken}` } : {},
        data: {
          userId: this.globalData.userId,
          amount: cost,
          referenceId,
          source: String(context.source || "ai_call"),
          description: String(context.description || "AI 有效调用"),
        },
        success: (response) => {
          const account = response && response.statusCode === 200 && response.data && response.data.account;
          if (!account) { this.syncBillingAccount(); return; }
          this.globalData.billingAccount = account;
          this.globalData.beans = roundBeans(account.beanBalance);
          wx.setStorageSync(BEAN_STORAGE_KEY, this.globalData.beans);
        },
      });
    }
    return true;
  },

  // 豆币展示（最多一位小数），页面文案统一走这里，避免各处自己拼格式。
  beanText(value) {
    return formatBeans(value === undefined ? this.globalData.beans : value);
  },
});
