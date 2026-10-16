const { messageSession } = require("../../utils/message-center");

const FAQS = [
  { id: "ai-unavailable", category: "AI 功能", question: "上传后为什么无法使用 AI？", answer: "正式版小程序不能访问电脑上的本地地址。需要把后台部署到具备 HTTPS 域名的服务器，并在微信公众平台配置 request 合法域名。" },
  { id: "bean-cost", category: "AI 功能", question: "哪些操作会消耗豆币？", answer: "主观题评分、重新评分、生成补充解析和连续追问会在成功返回有效结果后扣除豆币（每次 0.1 豆币，即原 1 点 AI 额度）。超时、接口错误和格式错误不扣豆币。" },
  { id: "question-sync", category: "题库", question: "后台导入题目后，小程序没有显示怎么办？", answer: "请先确认题目已经发布到对应题库，再重新进入题库页面触发同步。若仍未显示，请提交反馈并注明教材、章节和题目名称。" },
  { id: "question-error", category: "题库", question: "发现答案或章节归类错误怎么办？", answer: "可在刷题页顶部进入题目反馈，也可以在这里选择“内容问题”，说明正确内容和教材依据。已登录反馈可以查看处理进度。" },
  { id: "review-state", category: "复习", question: "错题做对后为什么仍保留记录？", answer: "重做正确后会从待复习错题中移出，但仍保留在历史记录中，方便查看最近一次作答和掌握状态。" },
  { id: "data-sync", category: "账号与数据", question: "学习记录可以跨设备同步吗？", answer: "微信登录后，作答、错题、收藏、复习状态和已购买内容可同步。未登录时的记录仅保存在当前设备。" },
];

const CATEGORY_LABELS = {
  feature_issue: "功能异常",
  content_issue: "内容问题",
  experience: "体验建议",
  account: "账号与订阅",
  other: "其他反馈",
};

const STATUS_LABELS = {
  pending: "待处理",
  processing: "处理中",
  resolved: "已处理",
  rejected: "暂不处理",
};

function filterFaqs(items, query) {
  const keyword = String(query || "").trim().toLowerCase();
  if (!keyword) return items;
  return items.filter((item) => [item.category, item.question, item.answer].join(" ").toLowerCase().includes(keyword));
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

Page({
  data: {
    activeTab: "help",
    tabs: [
      { id: "help", label: "帮助中心" },
      { id: "submit", label: "提交反馈" },
      { id: "history", label: "处理进度" },
    ],
    query: "",
    visibleFaqs: FAQS,
    expandedFaqId: "",
    categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
    feedbackCategory: "feature_issue",
    feedbackContent: "",
    feedbackContact: "",
    feedbackImages: [],
    feedbackItems: [],
    loggedIn: false,
    submitting: false,
    historyLoading: false,
    historyError: "",
  },

  onLoad(options = {}) {
    this.targetFeedbackId = String(options.feedbackId || "");
    const app = getApp();
    const draft = wx.getStorageSync("shukao_feedback_draft") || {};
    this.setData({
      activeTab: ["help", "submit", "history"].includes(options.tab) ? options.tab : "help",
      loggedIn: app.globalData.loggedIn === true,
      feedbackCategory: CATEGORY_LABELS[draft.category] ? draft.category : "feature_issue",
      feedbackContent: String(draft.content || ""),
      feedbackContact: String(draft.contact || ""),
    });
  },

  onShow() {
    const app = getApp();
    const loggedIn = app.globalData.loggedIn === true;
    if (this.historySession !== messageSession()) {
      this.historySession = messageSession();
      this.historyRequest = (this.historyRequest || 0) + 1;
      this.setData({ feedbackItems: [], historyLoading: false, historyError: "" });
    }
    this.setData({ loggedIn });
    if (loggedIn && this.data.activeTab === "history") this.loadHistory();
  },

  switchTab(event) {
    const activeTab = event.currentTarget.dataset.id;
    this.setData({ activeTab });
    if (activeTab === "history" && this.data.loggedIn) this.loadHistory();
  },

  openSubmit() {
    this.setData({ activeTab: "submit" });
  },

  searchFaq(event) {
    const query = event.detail.value;
    this.setData({ query, visibleFaqs: filterFaqs(FAQS, query), expandedFaqId: "" });
  },

  toggleFaq(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ expandedFaqId: this.data.expandedFaqId === id ? "" : id });
  },

  selectCategory(event) {
    this.setData({ feedbackCategory: event.currentTarget.dataset.id }, () => this.saveDraft());
  },

  updateContent(event) {
    this.setData({ feedbackContent: event.detail.value }, () => this.saveDraft());
  },

  updateContact(event) {
    this.setData({ feedbackContact: event.detail.value }, () => this.saveDraft());
  },

  saveDraft() {
    wx.setStorageSync("shukao_feedback_draft", {
      category: this.data.feedbackCategory,
      content: this.data.feedbackContent,
      contact: this.data.feedbackContact,
      updatedAt: Date.now(),
    });
  },

  login() {
    const app = getApp();
    // 登录只做 wx.login：wx.getUserProfile 已被微信回收（返回匿名数据），头像昵称也不再是登录前置条件。
    wx.showLoading({ title: "登录中" });
    app.loginWithWechat((user, error) => {
      wx.hideLoading();
      if (!user) {
        const message = error === "wechat_credentials_not_configured"
          ? "登录服务尚未配置"
          : error === "api_base_url_not_configured"
            ? "当前版本未配置服务地址"
            : "登录失败，请重试";
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      this.setData({ loggedIn: true });
      if (this.data.activeTab === "history") this.loadHistory();
    });
  },

  chooseImages() {
    const remaining = 3 - this.data.feedbackImages.length;
    if (remaining <= 0) return;
    wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      sizeType: ["compressed"],
      success: async ({ tempFiles }) => {
        wx.showLoading({ title: "处理图片" });
        try {
          const added = [];
          for (const file of tempFiles || []) {
            const image = await this.prepareImage(file.tempFilePath, Number(file.size) || 0);
            if (image) added.push(image);
          }
          this.setData({ feedbackImages: [...this.data.feedbackImages, ...added].slice(0, 3) });
          if (added.length < (tempFiles || []).length) wx.showToast({ title: "部分图片压缩后仍超过 200KB", icon: "none" });
        } finally {
          wx.hideLoading();
        }
      },
    });
  },

  prepareImage(path, initialSize) {
    const fileSystem = wx.getFileSystemManager();
    const getSize = (filePath) => new Promise((resolve) => fileSystem.getFileInfo({ filePath, success: ({ size }) => resolve(size), fail: () => resolve(0) }));
    const compress = (src, quality) => new Promise((resolve) => wx.compressImage({ src, quality, success: ({ tempFilePath }) => resolve(tempFilePath), fail: () => resolve(src) }));
    return (async () => {
      let filePath = path;
      let size = initialSize || await getSize(filePath);
      for (const quality of [60, 35, 20]) {
        if (size <= 200 * 1024) break;
        filePath = await compress(filePath, quality);
        size = await getSize(filePath);
      }
      return size > 0 && size <= 200 * 1024 ? { path: filePath, size } : null;
    })();
  },

  removeImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ feedbackImages: this.data.feedbackImages.filter((item, itemIndex) => itemIndex !== index) });
  },

  previewImage(event) {
    const current = event.currentTarget.dataset.path;
    wx.previewImage({ current, urls: this.data.feedbackImages.map((item) => item.path) });
  },

  imageDataUrls() {
    const fileSystem = wx.getFileSystemManager();
    return this.data.feedbackImages.map((item) => {
      const extension = String(item.path).split(".").pop().toLowerCase();
      const mime = extension === "png" ? "png" : extension === "webp" ? "webp" : "jpeg";
      return `data:image/${mime};base64,${fileSystem.readFileSync(item.path, "base64")}`;
    });
  },

  submitFeedback() {
    if (!this.data.loggedIn) { wx.showToast({ title: "请先登录后提交", icon: "none" }); return; }
    const content = this.data.feedbackContent.trim();
    // 产品负责人 2026-10-02：短内容提示直接说清门槛，与输入框占位文案同一句口径
    if (content.length < 5) { wx.showToast({ title: "不少于五个字才能提交", icon: "none" }); return; }
    if (this.data.submitting) return;
    const app = getApp();
    const info = typeof wx.getSystemInfoSync === "function" ? wx.getSystemInfoSync() : {};
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    let attachments = [];
    try {
      attachments = this.imageDataUrls();
    } catch (error) {
      wx.showToast({ title: "截图已失效，请重新添加", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/feedback`,
      method: "POST",
      timeout: 12000,
      header: { Authorization: `Bearer ${app.globalData.authToken}` },
      data: {
        category: this.data.feedbackCategory,
        content,
        contact: this.data.feedbackContact.trim(),
        attachments,
        clientContext: {
          pagePath: pages.length ? pages[pages.length - 1].route : "pages/help-feedback/help-feedback",
          system: info.system || "",
          model: info.model || "",
          version: info.version || "",
        },
      },
      success: (response) => {
        if (response.statusCode !== 201) {
          const notice = typeof app.restrictionNotice === "function" ? app.restrictionNotice(response.data || {}) : "";
          if (notice) {
            wx.showModal({ title: "暂时不能提交", content: notice, showCancel: false });
            return;
          }
          wx.showToast({ title: response.statusCode === 401 ? "登录已失效，请重新登录" : "提交失败，请稍后重试", icon: "none" });
          return;
        }
        wx.removeStorageSync("shukao_feedback_draft");
        this.setData({ feedbackContent: "", feedbackImages: [], activeTab: "history" });
        wx.showToast({ title: "反馈已提交", icon: "success" });
        this.loadHistory();
      },
      fail: () => wx.showToast({ title: "无法连接反馈服务器，草稿已保留", icon: "none" }),
      complete: () => this.setData({ submitting: false }),
    });
  },

  loadHistory() {
    if (this.data.historyLoading) return;
    const app = getApp();
    const session = messageSession();
    const requestId = this.historyRequest = (this.historyRequest || 0) + 1;
    const current = () => session === messageSession() && requestId === this.historyRequest;
    this.setData({ historyLoading: true, historyError: "" });
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/feedback/mine`,
      method: "GET",
      header: { Authorization: `Bearer ${app.globalData.authToken}` },
      success: (response) => {
        if (!current()) return;
        if (response.statusCode !== 200 || !Array.isArray(response.data?.items)) {
          this.setData({ historyError: "反馈记录加载失败，请重试" });
          return;
        }
        const items = (response.data.items || []).map((item) => ({
          ...item,
          messages: Array.isArray(item.messages) ? item.messages : [],
          replyContent: "",
          categoryLabel: CATEGORY_LABELS[item.category] || "其他反馈",
          statusLabel: STATUS_LABELS[item.status] || item.status,
          dateText: formatDate(item.createdAt),
        }));
        const target = items.find((item) => item.id === this.targetFeedbackId);
        this.setData({ feedbackItems: target ? [target, ...items.filter((item) => item !== target)] : items });
        if (this.targetFeedbackId && !target) wx.showToast({ title: "该反馈记录已不可用", icon: "none" });
      },
      fail: () => { if (current()) this.setData({ historyError: "反馈记录加载失败，请重试" }); },
      complete: () => { if (current()) this.setData({ historyLoading: false }); },
    });
  },

  updateReply(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.feedbackItems[index]) return;
    this.setData({ [`feedbackItems[${index}].replyContent`]: event.detail.value });
  },

  submitReply(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.feedbackItems[index];
    const content = String(item && item.replyContent || "").trim();
    if (!item || !item.canReply) return;
    if (content.length < 2) {
      wx.showToast({ title: "请补充具体信息", icon: "none" });
      return;
    }
    const app = getApp();
    const clientMessageId = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.setData({ [`feedbackItems[${index}].replying`]: true });
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/feedback/${encodeURIComponent(item.id)}/replies`,
      method: "POST",
      header: { Authorization: `Bearer ${app.globalData.authToken}` },
      data: { content, clientMessageId },
      success: (response) => {
        if (response.statusCode !== 200 || !response.data?.item) {
          wx.showToast({ title: "补充失败，请稍后重试", icon: "none" });
          return;
        }
        const next = response.data.item;
        next.categoryLabel = CATEGORY_LABELS[next.category] || item.categoryLabel;
        next.statusLabel = STATUS_LABELS[next.status] || next.status;
        next.dateText = formatDate(next.createdAt);
        next.replyContent = "";
        this.setData({ [`feedbackItems[${index}]`]: next });
        wx.showToast({ title: "已补充", icon: "success" });
      },
      fail: () => wx.showToast({ title: "无法连接服务器，请稍后重试", icon: "none" }),
      complete: () => this.setData({ [`feedbackItems[${index}].replying`]: false }),
    });
  },
});

module.exports = { CATEGORY_LABELS, FAQS, filterFaqs, formatDate };
