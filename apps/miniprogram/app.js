const DEFAULT_API_BASE_URL = "http://192.168.2.178:3212";
const DEVELOPMENT_API_BASE_URLS = [DEFAULT_API_BASE_URL, "http://192.168.2.179:3212"];
const { normalizeOfficialQuestions } = require("./utils/question-sync");

const OFFICIAL_QUESTIONS_CACHE_KEY = "shukao_official_questions";
const OFFICIAL_QUESTIONS_CACHE_TTL = 15 * 1000;
const AUTH_SESSION_KEY = "shukao_auth_session";
const DEVICE_ID_KEY = "shukao_device_id";

App({
  globalData: {
    user: {
      nickname: "薯考同学",
      avatarUrl: "",
    },
    aiCredits: 20,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    billingAccount: null,
    userId: "test-user",
    authToken: "",
    loggedIn: false,
    authMode: "guest",
    reviewReminderTemplateId: "",
    officialQuestions: [],
    officialQuestionsUpdatedAt: 0,
  },

  onLaunch() {
    const savedCredits = wx.getStorageSync("shukao_ai_credits");
    if (Number.isFinite(savedCredits)) {
      this.globalData.aiCredits = savedCredits;
    }
    const savedApiBaseUrl = String(wx.getStorageSync("shukao_api_base_url") || "");
    this.globalData.apiBaseUrl = !savedApiBaseUrl || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(savedApiBaseUrl)
      ? DEFAULT_API_BASE_URL
      : savedApiBaseUrl;
    this.restoreAuthSession();
    this.syncBillingAccount();
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
    return true;
  },

  restoreAuthSession() {
    const saved = wx.getStorageSync(AUTH_SESSION_KEY);
    if (!this.applyAuthSession(saved)) return;
    this.refreshAuthSession();
  },

  refreshAuthSession(callback) {
    if (!this.globalData.authToken || typeof wx.request !== "function") return;
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/auth/me`,
      method: "GET",
      header: { Authorization: `Bearer ${this.globalData.authToken}` },
      success: (response) => {
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
          this.globalData.aiCredits = Number(payload.account.creditBalance) || 0;
        }
        this.syncLearningState();
        if (callback) callback(payload.user, "");
      },
    });
  },

  loginWithWechat(profile = {}, callback) {
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
            profile: {
              nickname: profile.nickName || profile.nickname || "薯考同学",
              avatarUrl: profile.avatarUrl || "",
            },
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
              this.globalData.aiCredits = Number(payload.account.creditBalance) || 0;
            }
            this.syncLearningState();
            if (callback) callback(payload.user, "");
          },
          fail: (error) => callback && callback(null, error && error.errMsg || "wechat_login_failed"),
        });
      },
      fail: (error) => callback && callback(null, error && error.errMsg || "wx_login_failed"),
    });
  },

  clearAuthSession() {
    this.globalData.authToken = "";
    this.globalData.loggedIn = false;
    this.globalData.authMode = "guest";
    this.globalData.userId = "test-user";
    this.globalData.user = { nickname: "薯考同学", avatarUrl: "" };
    wx.removeStorageSync(AUTH_SESSION_KEY);
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
    if (!token || typeof wx.request !== "function") {
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
    if (!this.globalData.authToken || typeof wx.request !== "function") {
      if (callback) callback(false, "login_required");
      return;
    }
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/account`,
      method: "DELETE",
      header: { Authorization: `Bearer ${this.globalData.authToken}` },
      success: (response) => {
        if (response.statusCode !== 200) {
          if (callback) callback(false, String(response.data && response.data.error || "account_delete_failed"));
          return;
        }
        wx.clearStorageSync();
        this.globalData.authToken = "";
        this.globalData.loggedIn = false;
        this.globalData.authMode = "guest";
        this.globalData.userId = "test-user";
        this.globalData.user = { nickname: "薯考同学", avatarUrl: "" };
        this.globalData.billingAccount = null;
        this.globalData.aiCredits = 20;
        this.globalData.officialQuestions = [];
        this.globalData.officialQuestionsUpdatedAt = 0;
        if (callback) callback(true, "");
      },
      fail: () => callback && callback(false, "request_failed"),
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
    if (!this.globalData.authToken || typeof wx.request !== "function") {
      if (callback) callback(null, "login_required");
      return;
    }
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/learning/state/sync`,
      method: "POST",
      header: { Authorization: `Bearer ${this.globalData.authToken}` },
      data: this.collectLearningState(),
      success: (response) => {
        const state = response.statusCode === 200 && response.data && response.data.state;
        if (state) this.applyLearningState(state);
        if (callback) callback(state || null, state ? "" : String(response.data && response.data.error || "learning_sync_failed"));
      },
      fail: (error) => callback && callback(null, error && error.errMsg || "learning_sync_failed"),
    });
  },

  syncBillingAccount(callback) {
    if (typeof wx.request !== "function") return;
    wx.request({
      url: `${this.globalData.apiBaseUrl}/api/billing/account?userId=${encodeURIComponent(this.globalData.userId)}`,
      method: "GET",
      header: this.globalData.authToken ? { Authorization: `Bearer ${this.globalData.authToken}` } : {},
      success: (response) => {
        const account = response && response.statusCode === 200 && response.data && response.data.account;
        if (!account) return;
        this.globalData.billingAccount = account;
        this.globalData.aiCredits = Number(account.creditBalance) || 0;
        wx.setStorageSync("shukao_ai_credits", this.globalData.aiCredits);
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
    const configured = String(this.globalData.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, "");
    return [...new Set([configured, ...DEVELOPMENT_API_BASE_URLS])];
  },

  spendAiCredit(amount, context = {}) {
    if (this.globalData.aiCredits < amount) return false;
    this.globalData.aiCredits -= amount;
    wx.setStorageSync("shukao_ai_credits", this.globalData.aiCredits);
    if (typeof wx.request === "function") {
      const referenceId = String(context.referenceId || `mini-ai-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      wx.request({
        url: `${this.globalData.apiBaseUrl}/api/billing/credits/consume`,
        method: "POST",
        header: this.globalData.authToken ? { Authorization: `Bearer ${this.globalData.authToken}` } : {},
        data: {
          userId: this.globalData.userId,
          amount,
          referenceId,
          source: String(context.source || "ai_call"),
          description: String(context.description || "AI 有效调用"),
        },
        success: (response) => {
          const account = response && response.statusCode === 200 && response.data && response.data.account;
          if (!account) { this.syncBillingAccount(); return; }
          this.globalData.billingAccount = account;
          this.globalData.aiCredits = Number(account.creditBalance) || 0;
          wx.setStorageSync("shukao_ai_credits", this.globalData.aiCredits);
        },
      });
    }
    return true;
  },
});
