const { closeTransientLayers } = require("../../utils/page-layers");
const {
  classifyWrongQuestions,
  getDueReviewStates,
  normalizeReviewStates,
} = require("../../utils/review-schedule");
const { COMPREHENSIVE_SUBJECT_ID, buildLearningAnalysis } = require("../../utils/learning-analysis");
const { officialCards } = require("../../data/knowledge-cards");

const reviewProjects = [
  { id: "chinese-upgrade", name: "汉语言文学题库", enabled: true },
  { id: "teacher", name: "教资", enabled: false },
  { id: "civil-service", name: "考公", enabled: false },
];

const masteryLabels = {
  familiar: "熟悉",
  fuzzy: "模糊",
  unknown: "不会",
};

const reviewResultLabels = {
  pending: { label: "仍需复习", tone: "unknown" },
  corrected: { label: "已纠正", tone: "corrected" },
  reinforcing: { label: "待巩固", tone: "fuzzy" },
  mastered: { label: "已掌握", tone: "familiar" },
};

const defaultAnnouncements = [
  {
    id: "internal-benefit",
    type: "权益通知",
    title: "平台题库已开通",
    summary: "内部测试期间，平台题库已为测试用户开放",
    content: "内部测试期间，测试用户可使用已上线的平台题库。正式订阅与支付功能将在后续阶段接入，现阶段不会产生订阅费用。\n\nAI 解析与评分使用独立额度，当前余额可在“AI 额度明细”中查看。",
    date: "2026年8月4日",
  },
  {
    id: "ai-grading-update",
    type: "功能更新",
    title: "主观题评分体验优化",
    summary: "主观题评分速度与结果稳定性已完成优化",
    content: "主观题提交与 AI 评分现已分开。提交答案后可以先记录掌握状态，需要查看结构化评分时再主动发起评分。\n\n评分结果将继续展示命中得分点、遗漏得分点、错误内容和表达建议。",
    date: "2026年8月4日",
  },
  {
    id: "feedback",
    type: "测试公告",
    title: "欢迎提交使用反馈",
    summary: "发现题目或功能问题，可通过帮助与反馈告诉我们",
    content: "如果发现题目答案、章节归类或页面功能存在问题，请通过“帮助与反馈”提交。清晰描述问题并附上截图，有助于更快定位和修正。",
    date: "2026年8月4日",
  },
];

function dateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function startOfDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function examCountdown(dateValue, now = Date.now()) {
  const target = new Date(`${String(dateValue || "")}T00:00:00`);
  if (!dateValue || !Number.isFinite(target.getTime())) return "--";
  return String(Math.max(0, Math.ceil((target.getTime() - startOfDay(now)) / (24 * 60 * 60 * 1000))));
}

function calculateStudyStreak(attempts, reviewHistory, now = Date.now()) {
  const studiedDays = new Set();
  (Array.isArray(attempts) ? attempts : []).forEach((attempt) => {
    if (Number(attempt && attempt.createdAt)) studiedDays.add(dateKey(attempt.createdAt));
  });
  (Array.isArray(reviewHistory) ? reviewHistory : []).forEach((entry) => {
    if (Number(entry && entry.updatedAt)) studiedDays.add(dateKey(entry.updatedAt));
  });
  let cursor = startOfDay(now);
  if (!studiedDays.has(dateKey(cursor))) cursor -= 24 * 60 * 60 * 1000;
  let streak = 0;
  while (studiedDays.has(dateKey(cursor))) {
    streak += 1;
    cursor -= 24 * 60 * 60 * 1000;
  }
  return streak;
}

function paginateReviewTools(tools = [], pageSize = 8) {
  const size = Math.max(1, Math.floor(Number(pageSize) || 8));
  return Array.from({ length: Math.ceil(tools.length / size) }, (_, index) => ({
    key: `review-tools-${index}`,
    tools: tools.slice(index * size, (index + 1) * size),
  }));
}

function buildReviewItem(question, state, sourceLabel) {
  return {
    ...question,
    stateLabel: state ? (masteryLabels[state.masteryStatus] || "待复习") : sourceLabel,
    stateTone: state ? state.masteryStatus : "neutral",
    sourceLabel,
  };
}

function createNavigationMetrics(windowInfo = {}, capsule = {}) {
  const windowWidth = Number(windowInfo.windowWidth) || 375;
  const hasCapsuleMetrics = capsule
    && Number(capsule.width) > 0
    && Number(capsule.height) > 0
    && Number.isFinite(Number(capsule.left))
    && Number(capsule.left) > 0;
  const statusBarHeight = Number(windowInfo.statusBarHeight)
    || (hasCapsuleMetrics ? Number(capsule.top) : 24);
  const capsuleTop = hasCapsuleMetrics ? Number(capsule.top) : statusBarHeight + 4;
  const capsuleHeight = hasCapsuleMetrics ? Number(capsule.height) : 32;
  const topGap = Math.max(4, capsuleTop - statusBarHeight);
  const navContentHeight = capsuleHeight + topGap * 2;
  return {
    statusBarHeight,
    navTotalHeight: statusBarHeight + navContentHeight,
    capsuleSafeRight: hasCapsuleMetrics ? Math.max(96, windowWidth - Number(capsule.left) + 10) : 96,
  };
}

Page({
  data: {
    navTotalHeight: 88,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    projects: reviewProjects,
    activeProjectId: "chinese-upgrade",
    activeProjectName: "汉语言文学题库",
    projectMenuOpen: false,
    filters: [],
    activeFilter: "due",
    activeFilterLabel: "今日复习",
    reviewItems: [],
    completedReviewItems: [],
    activeQuestionIds: [],
    wrongSubfilter: "pending",
    wrongSubfilters: [],
    dueSubfilter: "pending",
    dueSubfilters: [],
    listTitle: "待复习",
    summaryTitle: "待复习",
    reviewActionLabel: "开始复习",
    dueCount: 0,
    dueQuestionIds: [],
    completedToday: 0,
    todayReviewTotal: 0,
    dueEstimatedMinutes: 0,
    estimatedMinutes: 0,
    reminderEnabled: false,
    reminderTime: "20:00",
    reminderAuthorized: false,
    reminderStatusText: "登录后可跨设备同步提醒设置",
    reviewStats: [],
    studyStreak: 0,
    visibleReviewItems: [],
    announcements: defaultAnnouncements,
    activeAnnouncement: defaultAnnouncements[0],
    announcementOpen: false,
    announcementIndex: 0,
    todayDate: dateKey(),
    examDate: "",
    examCountdownText: "--",
    reviewToolPages: [],
    reviewToolPageIndex: 0,
    smartQuestionIds: [],
  },

  onLoad() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
      ? wx.getMenuButtonBoundingClientRect()
      : {};
    this.setData(createNavigationMetrics(windowInfo, capsule));
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的长按工具栏 / 抽屉 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["projectMenuOpen","announcementOpen"]);
  },

  onShow() {
    closeTransientLayers(this, ["projectMenuOpen","announcementOpen"]);
    const storedProjectId = wx.getStorageSync("shukao_review_project_id") || "chinese-upgrade";
    const activeProject = reviewProjects.find((project) => project.id === storedProjectId && project.enabled) || reviewProjects[0];
    const examDate = wx.getStorageSync(`shukao_exam_date_${activeProject.id}`) || "";
    this.setData({
      activeProjectId: activeProject.id,
      activeProjectName: activeProject.name,
      projectMenuOpen: false,
      announcementOpen: false,
      todayDate: dateKey(),
      examDate,
      examCountdownText: examCountdown(examDate),
    });
    const reminder = wx.getStorageSync("shukao_review_reminder_settings") || {};
    this.setData({
      reminderEnabled: reminder.enabled === true || wx.getStorageSync("shukao_review_reminder") === true,
      reminderTime: reminder.time || "20:00",
      reminderAuthorized: reminder.subscriptionAccepted === true,
      reminderStatusText: reminder.subscriptionAccepted ? "微信订阅消息已授权" : "开启后申请微信订阅消息授权",
    });
    this.refreshReviewData();
    const app = getApp();
    if (typeof app.syncOfficialQuestions === "function") {
      app.syncOfficialQuestions(() => this.refreshReviewData(), { force: true });
    }
    if (typeof app.syncLearningState === "function" && app.globalData.loggedIn) {
      app.syncLearningState(() => this.refreshReviewData());
    }
    this.syncAnnouncements();
    const tabBar = typeof this.getTabBar === "function" ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 2 });
  },

  syncAnnouncements() {
    const app = getApp();
    if (typeof wx.request !== "function" || !app.globalData.apiBaseUrl) return;
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/announcements`,
      method: "GET",
      success: (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) return;
        const items = Array.isArray(response.data && response.data.announcements)
          ? response.data.announcements.map((item) => ({
            ...item,
            date: this.formatAnnouncementDate(item.publishedAt || item.updatedAt || item.createdAt),
          }))
          : null;
        if (!items) return;
        const currentId = this.data.activeAnnouncement && this.data.activeAnnouncement.id;
        const matchedIndex = Math.max(0, items.findIndex((item) => item.id === currentId));
        this.setData({
          announcements: items,
          announcementIndex: items.length ? matchedIndex : 0,
          activeAnnouncement: items.length ? items[matchedIndex] : null,
          announcementOpen: items.length ? this.data.announcementOpen : false,
        });
      },
    });
  },

  openAnnouncement() {
    if (!this.data.announcements.length) return;
    this.setData({ announcementOpen: true });
  },

  closeAnnouncement() {
    this.setData({ announcementOpen: false });
  },

  changeAnnouncement(event) {
    const announcementIndex = Number(event.detail.current) || 0;
    if (!this.data.announcements[announcementIndex]) return;
    this.setData({
      announcementIndex,
      activeAnnouncement: this.data.announcements[announcementIndex],
    });
  },

  formatAnnouncementDate(timestamp) {
    const date = new Date(Number(timestamp));
    if (!Number.isFinite(date.getTime())) return "";
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  },

  stopPropagation() {},

  refreshReviewData() {
    const app = getApp();
    const now = Date.now();
    const reviewStates = normalizeReviewStates(wx.getStorageSync("shukao_review_states"));
    const attempts = wx.getStorageSync("shukao_attempts") || [];
    const reviewHistory = wx.getStorageSync("shukao_review_history") || [];
    const officialQuestions = Array.isArray(app.globalData.officialQuestions) ? app.globalData.officialQuestions : [];
    const questionMap = new Map(officialQuestions.map((question) => [question.id, question]));
    attempts.forEach((attempt) => {
      if (attempt && attempt.question && attempt.question.id && !questionMap.has(attempt.question.id)) {
        questionMap.set(attempt.question.id, attempt.question);
      }
    });
    reviewHistory.forEach((entry) => {
      if (entry && entry.question && entry.question.id && !questionMap.has(entry.question.id)) {
        questionMap.set(entry.question.id, entry.question);
      }
    });
    const questions = [...questionMap.values()];
    const dueStates = getDueReviewStates(reviewStates, now);
    const storedTodayEntries = reviewHistory
      .filter((entry) => entry && entry.dateKey === dateKey(now))
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
    const loggedTodayIds = new Set(storedTodayEntries.map((entry) => entry.questionId));
    const latestAttempts = new Map();
    [...attempts]
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
      .forEach((attempt) => {
        if (attempt && attempt.questionId && !latestAttempts.has(attempt.questionId)) latestAttempts.set(attempt.questionId, attempt);
      });
    const activeReviewIds = wx.getStorageSync("shukao_active_review_ids") || [];
    const inferredTodayEntries = (Array.isArray(activeReviewIds) ? activeReviewIds : [])
      .filter((questionId) => {
        const attempt = latestAttempts.get(questionId);
        const state = reviewStates[questionId];
        return !loggedTodayIds.has(questionId)
          && attempt
          && Number(attempt.createdAt) >= startOfDay(now)
          && state
          && Number(state.lastReviewAt) >= startOfDay(now);
      })
      .map((questionId) => {
        const attempt = latestAttempts.get(questionId);
        const state = reviewStates[questionId];
        const isCorrect = state.lastIsCorrect === true;
        const mastery = state.masteryStatus || (attempt.response && attempt.response.mastery) || attempt.mastery || "unknown";
        const status = !isCorrect || mastery === "unknown"
          ? "pending"
          : (mastery === "familiar" ? "mastered" : (mastery === "fuzzy" ? "reinforcing" : "corrected"));
        return {
          id: `review-${dateKey(now)}-${questionId}`,
          dateKey: dateKey(now),
          questionId,
          question: attempt.question,
          isCorrect,
          mastery,
          status,
          aiScored: !!(attempt.response && attempt.response.subjectiveScoreResult),
          attemptCount: 1,
          updatedAt: Math.max(Number(attempt.updatedAt || attempt.createdAt), Number(state.lastReviewAt)),
        };
      });
    const todayEntries = [...storedTodayEntries, ...inferredTodayEntries]
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
    const completedTodayIds = new Set(todayEntries.map((entry) => entry.questionId));
    const dueIds = dueStates.map((state) => state.questionId).filter((id) => !completedTodayIds.has(id));
    const todayIds = [...new Set([...dueIds, ...todayEntries.map((entry) => entry.questionId)])];
    const wrongGroups = classifyWrongQuestions(attempts, reviewStates);
    const wrongSubfilterOptions = {
      pending: { label: "待纠正", ids: wrongGroups.pending },
      reinforcing: { label: "待巩固", ids: [...wrongGroups.reinforcing, ...wrongGroups.corrected] },
      mastered: { label: "已掌握", ids: wrongGroups.mastered },
      all: { label: "全部", ids: wrongGroups.history },
    };
    const wrongSubfilter = wrongSubfilterOptions[this.data.wrongSubfilter] ? this.data.wrongSubfilter : "pending";
    const wrongIds = wrongSubfilterOptions[wrongSubfilter].ids;
    const dueSubfilterOptions = {
      pending: { label: "待复习", ids: dueIds },
      completed: { label: "已完成", ids: todayEntries.map((entry) => entry.questionId) },
    };
    const dueSubfilter = dueSubfilterOptions[this.data.dueSubfilter] ? this.data.dueSubfilter : "pending";
    const bookmarkStates = wx.getStorageSync("shukao_bookmarks") || {};
    const favoriteIds = questions
      .filter((question) => bookmarkStates[question.id]?.value === true || wx.getStorageSync(`shukao_bookmark_${question.id}`) === true)
      .map((question) => question.id);
    const savedKnowledgeIds = wx.getStorageSync("shukao_saved_knowledge_cards") || [];
    const stateMap = new Map(dueStates.map((state) => [state.questionId, state]));
    const filterOptions = {
      due: { label: "今日复习", ids: dueSubfilterOptions[dueSubfilter].ids, countIds: todayIds, sourceLabel: "今日到期" },
      wrong: { label: "错题本", ids: wrongIds, countIds: wrongGroups.pending, sourceLabel: "待纠正" },
      knowledge: { label: "知识卡", ids: savedKnowledgeIds, sourceLabel: "已加入复习", itemKind: "knowledge" },
    };
    const activeFilter = filterOptions[this.data.activeFilter] ? this.data.activeFilter : "due";
    const activeOption = filterOptions[activeFilter];
    const knowledgeMap = new Map(officialCards.map((card) => [card.id, card]));
    const itemMap = activeOption.itemKind === "knowledge" ? knowledgeMap : questionMap;
    const activeQuestionIds = activeOption.ids.filter((id) => itemMap.has(id));
    const reviewItems = activeQuestionIds.map((id) => {
      if (activeOption.itemKind === "knowledge") {
        const card = knowledgeMap.get(id);
        return {
          id: card.id,
          stem: card.title,
          breadcrumb: card.subject,
          knowledgePoint: card.subtitle,
          stateLabel: "知识卡",
          stateTone: "neutral",
          itemKind: "knowledge",
        };
      }
      if (activeFilter === "due" && dueSubfilter === "completed") {
        const entry = todayEntries.find((item) => item.questionId === id);
        const result = reviewResultLabels[entry && entry.status] || reviewResultLabels.pending;
        const question = questionMap.get(id) || (entry && entry.question);
        return {
          ...question,
          stateLabel: entry && entry.aiScored ? `${result.label} · AI` : result.label,
          stateTone: result.tone,
          reviewedTime: entry ? new Date(entry.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
        };
      }
      if (activeFilter === "wrong") {
        const status = wrongGroups.pending.includes(id)
          ? "pending"
          : (wrongGroups.mastered.includes(id) ? "mastered" : (wrongGroups.reinforcing.includes(id) ? "reinforcing" : "corrected"));
        const result = reviewResultLabels[status];
        return { ...buildReviewItem(questionMap.get(id), reviewStates[id], activeOption.sourceLabel), stateLabel: result.label, stateTone: result.tone };
      }
      return buildReviewItem(questionMap.get(id), reviewStates[id] || stateMap.get(id), activeOption.sourceLabel);
    });
    const completedReviewItems = todayEntries
      .map((entry) => {
        const question = questionMap.get(entry.questionId) || entry.question;
        if (!question) return null;
        const result = reviewResultLabels[entry.status] || reviewResultLabels.pending;
        return {
          ...question,
          stateLabel: entry.aiScored ? `${result.label} · AI` : result.label,
          stateTone: result.tone,
          reviewedTime: new Date(entry.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          attemptCount: entry.attemptCount,
        };
      })
      .filter(Boolean);
    const completedToday = completedReviewItems.length;
    const studyStreak = calculateStudyStreak(attempts, reviewHistory, now);
    const smartQuestionIds = buildLearningAnalysis({
      attempts,
      questions,
      scoreHistory: wx.getStorageSync("shukao_subjective_score_history") || [],
      subjectId: COMPREHENSIVE_SUBJECT_ID,
    }).targetedQuestionIds.filter((id) => questionMap.has(id));
    const reviewTools = [
      { key: "comprehensive", label: "综合训练" },
      { key: "smart", label: "智能刷题", count: smartQuestionIds.length },
      { key: "wrong", label: "错题本", count: wrongGroups.history.filter((id) => questionMap.has(id)).length },
      { key: "calendar", label: "复习日历", count: dueIds.filter((id) => questionMap.has(id)).length },
      { key: "analysis", label: "学情分析" },
      { key: "knowledge", label: "知识卡", filter: "knowledge", count: savedKnowledgeIds.filter((id) => knowledgeMap.has(id)).length },
      { key: "favorite", label: "收藏", count: favoriteIds.length },
      { key: "pomodoro", label: "番茄时钟", disabled: true },
      { key: "study-room", label: "自习室", disabled: true },
    ];
    this.setData({
      filters: Object.entries(filterOptions).map(([key, option]) => ({
        key,
        label: option.label,
        count: (option.countIds || option.ids).filter((id) => (option.itemKind === "knowledge" ? knowledgeMap : questionMap).has(id)).length,
      })),
      activeFilter,
      activeFilterLabel: activeOption.label,
      activeQuestionIds,
      reviewItems,
      completedReviewItems,
      visibleReviewItems: reviewItems,
      wrongSubfilter,
      wrongSubfilters: Object.entries(wrongSubfilterOptions).map(([key, option]) => ({
        key,
        label: option.label,
        count: option.ids.filter((id) => questionMap.has(id)).length,
      })),
      dueSubfilter,
      dueSubfilters: Object.entries(dueSubfilterOptions).map(([key, option]) => ({
        key,
        label: option.label,
        count: option.ids.filter((id) => questionMap.has(id)).length,
      })),
      listTitle: activeFilter === "due" ? dueSubfilterOptions[dueSubfilter].label : "题目列表",
      summaryTitle: activeFilter === "wrong" ? wrongSubfilterOptions[wrongSubfilter].label : (activeFilter === "due" ? dueSubfilterOptions[dueSubfilter].label : activeOption.label),
      reviewActionLabel: activeFilter === "knowledge"
        ? "查看知识卡"
        : ((activeFilter === "wrong" && wrongSubfilter !== "pending") || (activeFilter === "due" && dueSubfilter === "completed") ? "重新复习" : "开始复习"),
      dueCount: dueIds.filter((id) => questionMap.has(id)).length,
      dueQuestionIds: dueIds.filter((id) => questionMap.has(id)),
      completedToday,
      todayReviewTotal: dueIds.filter((id) => questionMap.has(id)).length + completedToday,
      dueEstimatedMinutes: dueIds.length ? Math.ceil(dueIds.length * 1.5) : 0,
      estimatedMinutes: activeQuestionIds.length ? Math.ceil(activeQuestionIds.length * 1.5) : 0,
      studyStreak,
      reviewStats: [
        { value: attempts.length, label: "累计完成" },
        { value: studyStreak, label: "连续天数" },
        { value: completedToday, label: "今日完成" },
      ],
      reviewToolPages: paginateReviewTools(reviewTools),
      smartQuestionIds,
    });
  },

  changeReviewToolPage(event) {
    this.setData({ reviewToolPageIndex: Number(event.detail.current) || 0 });
  },

  selectFilter(event) {
    this.setData({ activeFilter: event.currentTarget.dataset.value, reviewListExpanded: false }, () => this.refreshReviewData());
  },

  selectDueSubfilter(event) {
    this.setData({ dueSubfilter: event.currentTarget.dataset.value, reviewListExpanded: false }, () => this.refreshReviewData());
  },

  selectWrongSubfilter(event) {
    this.setData({ wrongSubfilter: event.currentTarget.dataset.value, reviewListExpanded: false }, () => this.refreshReviewData());
  },

  toggleProjectMenu() {
    this.setData({ projectMenuOpen: !this.data.projectMenuOpen });
  },

  selectProject(event) {
    const project = reviewProjects.find((item) => item.id === event.currentTarget.dataset.id);
    if (!project) return;
    if (!project.enabled) {
      this.setData({ projectMenuOpen: false });
      wx.showToast({ title: `${project.name}正在筹备`, icon: "none" });
      return;
    }
    wx.setStorageSync("shukao_review_project_id", project.id);
    const examDate = wx.getStorageSync(`shukao_exam_date_${project.id}`) || "";
    this.setData({
      activeProjectId: project.id,
      activeProjectName: project.name,
      projectMenuOpen: false,
      examDate,
      examCountdownText: examCountdown(examDate),
    });
  },

  changeExamDate(event) {
    const examDate = String(event.detail.value || "");
    if (!examDate) return;
    wx.setStorageSync(`shukao_exam_date_${this.data.activeProjectId}`, examDate);
    this.setData({ examDate, examCountdownText: examCountdown(examDate) });
  },

  startReview() {
    if (!this.data.activeQuestionIds.length) {
      wx.showToast({ title: `${this.data.activeFilterLabel}暂无题目`, icon: "none" });
      return;
    }
    if (this.data.activeFilter === "knowledge") {
      wx.setStorageSync("shukao_knowledge_open_id", this.data.activeQuestionIds[0]);
      wx.switchTab({ url: "/pages/knowledge/knowledge" });
      return;
    }
    wx.setStorageSync("shukao_active_review_ids", this.data.activeQuestionIds);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },

  startDueReview() {
    if (!this.data.dueQuestionIds.length) {
      wx.showToast({ title: "今天没有待复习题目", icon: "none" });
      return;
    }
    wx.setStorageSync("shukao_active_review_ids", this.data.dueQuestionIds);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },

  openTodayCalendar() {
    wx.navigateTo({ url: "/pages/review-calendar/review-calendar" });
  },

  openReviewTool(event) {
    const key = event.currentTarget.dataset.key;
    if (key === "comprehensive") {
      wx.navigateTo({ url: "/pages/practice/practice?mode=comprehensive" });
      return;
    }
    if (key === "smart") {
      if (!this.data.smartQuestionIds.length) {
        wx.showToast({ title: "先完成一些练习，系统才能生成智能题组", icon: "none" });
        return;
      }
      wx.setStorageSync("shukao_active_review_ids", this.data.smartQuestionIds);
      wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
      return;
    }
    if (key === "knowledge") {
      wx.navigateTo({ url: "/pages/card-box/card-box" });
      return;
    }
    if (key === "wrong") {
      wx.navigateTo({ url: "/pages/wrong-book/wrong-book" });
      return;
    }
    if (key === "calendar") {
      wx.navigateTo({ url: "/pages/review-calendar/review-calendar" });
      return;
    }
    if (key === "analysis") {
      this.openAnalysis();
      return;
    }
    if (["study-room", "pomodoro"].includes(key)) {
      wx.showToast({ title: `${key === "study-room" ? "自习室" : "番茄时钟"}正在规划中`, icon: "none" });
      return;
    }
    if (key === "favorite") {
      // 收藏从「页内切换筛选」改为独立页面：我的收藏（收藏的公开内容 + 收藏的题目）。
      wx.navigateTo({ url: "/pages/favorites/favorites" });
      return;
    }
  },

  resetToDue() {
    this.setData({ activeFilter: "due", dueSubfilter: "pending", reviewListExpanded: false }, () => this.refreshReviewData());
  },

  startReviewFromQuestion(event) {
    const questionId = event.currentTarget.dataset.questionId;
    if (this.data.activeFilter === "knowledge") {
      wx.setStorageSync("shukao_knowledge_open_id", questionId);
      wx.switchTab({ url: "/pages/knowledge/knowledge" });
      return;
    }
    const index = this.data.activeQuestionIds.indexOf(questionId);
    if (index < 0) {
      wx.setStorageSync("shukao_active_review_ids", [questionId]);
      wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
      return;
    }
    const reorderedIds = [
      ...this.data.activeQuestionIds.slice(index),
      ...this.data.activeQuestionIds.slice(0, index),
    ];
    wx.setStorageSync("shukao_active_review_ids", reorderedIds);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },

  toggleReminder(event) {
    const enabled = event.detail.value;
    if (!enabled) {
      this.saveReminderSettings(false, this.data.reminderAuthorized);
      return;
    }
    const app = getApp();
    const templateId = String(app.globalData.reviewReminderTemplateId || "");
    if (!templateId || typeof wx.requestSubscribeMessage !== "function") {
      this.saveReminderSettings(true, false);
      wx.showToast({ title: "提醒时间已保存，消息模板配置后生效", icon: "none" });
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (result) => {
        const accepted = result[templateId] === "accept";
        this.saveReminderSettings(accepted, accepted);
        wx.showToast({ title: accepted ? "提醒已开启" : "未获得消息授权", icon: "none" });
      },
      fail: () => {
        this.saveReminderSettings(false, false);
        wx.showToast({ title: "消息授权失败，请重试", icon: "none" });
      },
    });
  },

  changeReminderTime(event) {
    this.setData({ reminderTime: event.detail.value });
    this.saveReminderSettings(this.data.reminderEnabled, this.data.reminderAuthorized, event.detail.value);
  },

  saveReminderSettings(enabled, subscriptionAccepted, time = this.data.reminderTime) {
    const reminder = { enabled, time, subscriptionAccepted, updatedAt: Date.now() };
    wx.setStorageSync("shukao_review_reminder", enabled);
    wx.setStorageSync("shukao_review_reminder_settings", reminder);
    this.setData({
      reminderEnabled: enabled,
      reminderAuthorized: subscriptionAccepted,
      reminderTime: time,
      reminderStatusText: subscriptionAccepted ? "微信订阅消息已授权" : (enabled ? "提醒偏好已保存，等待消息模板启用" : "开启后申请微信订阅消息授权"),
    });
    const app = getApp();
    if (typeof app.syncLearningState === "function") app.syncLearningState();
  },

  openAnalysis() {
    wx.navigateTo({ url: "/pages/analysis/analysis?subjectId=chinese-comprehensive" });
  },
});

module.exports = { calculateStudyStreak, createNavigationMetrics, examCountdown, paginateReviewTools };
