const { subjects } = require("../../data/catalog");
const { buildRuleExam, createExamBlueprint } = require("../../utils/exam-rule-builder");

const RULE_EXAM_STORAGE_KEY = "shukao_rule_exam_session";

function normalizeExam(exam = {}) {
  const kind = exam.kind === "past_paper" ? "past_paper" : "official_mock";
  return {
    id: String(exam.id || ""),
    title: String(exam.title || "未命名试卷"),
    description: String(exam.description || ""),
    kind,
    kindLabel: kind === "past_paper" ? "历年真题" : "平台模拟",
    year: Number(exam.year) || new Date().getFullYear(),
    questionCount: Math.max(0, Number(exam.questionCount) || 0),
    durationMinutes: Math.max(1, Number(exam.durationMinutes) || 120),
    totalScore: Math.max(0, Number(exam.totalScore) || 0),
    freePreviewQuestionCount: Math.max(0, Number(exam.freePreviewQuestionCount) || 0),
    attempts: Math.max(0, Number(exam.attempts) || 0),
    selectionRules: Array.isArray(exam.selectionRules) ? exam.selectionRules : [],
  };
}

function buildCustomScopeOptions(questions = []) {
  const records = Array.isArray(questions) ? questions : [];
  const subjectCounts = records.reduce((counts, question) => {
    const subjectId = String(question.subjectId || "");
    if (subjectId) counts[subjectId] = (counts[subjectId] || 0) + 1;
    return counts;
  }, {});
  const bookCounts = records.reduce((counts, question) => {
    const bookId = String(question.bookId || "");
    if (bookId) counts[bookId] = (counts[bookId] || 0) + 1;
    return counts;
  }, {});
  const subjectOptions = subjects.map((subject) => ({
    id: subject.id,
    name: subject.name,
    count: subjectCounts[subject.id] || 0,
    displayName: `${subject.name}（${subjectCounts[subject.id] || 0}题）`,
  }));
  const bookOptions = subjects.flatMap((subject) => subject.books.map((book) => ({
    id: book.id,
    subjectId: subject.id,
    subjectName: subject.name,
    name: `${book.title}${book.volume ? ` · ${book.volume}` : ""}`,
    count: bookCounts[book.id] || 0,
    displayName: `${book.title}${book.volume ? ` · ${book.volume}` : ""}（${bookCounts[book.id] || 0}题）`,
  })));
  return { subjectOptions, bookOptions, total: records.length };
}

Page({
  data: {
    activeTab: "past",
    tabs: [
      { key: "past", label: "历年真题" },
      { key: "official", label: "平台模拟" },
      { key: "custom", label: "自定义组卷" },
    ],
    exams: [],
    currentExams: [],
    loading: true,
    loadFailed: false,
    questionCount: 20,
    duration: 30,
    customScope: "all",
    customScopeId: "",
    customScopeLabel: "五科综合",
    customAvailableCount: 0,
    subjectOptions: [],
    bookOptions: [],
    builderMode: "custom",
    ruleTemplates: [],
    ruleTemplateIndex: 0,
    selectedRuleTemplate: null,
    ruleTemplateQuestions: [],
    ruleBlueprint: [],
    ruleShortages: [],
    ruleShortageMoreCount: 0,
    ruleCanGenerate: false,
    ruleLoading: false,
    ruleLoadFailed: false,
  },

  onLoad() {
    this.loadCustomScopeOptions();
    this.loadExams();
  },

  loadCustomScopeOptions() {
    const app = getApp();
    const apply = (questions) => {
      this._officialQuestions = Array.isArray(questions) ? questions : [];
      const options = buildCustomScopeOptions(questions);
      const patch = { subjectOptions: options.subjectOptions, bookOptions: options.bookOptions };
      if (this.data.customScope === "all") patch.customAvailableCount = options.total;
      if (this.data.customScope === "subject") {
        const selected = options.subjectOptions.find((item) => item.id === this.data.customScopeId);
        patch.customAvailableCount = selected ? selected.count : 0;
      }
      if (this.data.customScope === "book") {
        const selected = options.bookOptions.find((item) => item.id === this.data.customScopeId);
        patch.customAvailableCount = selected ? selected.count : 0;
      }
      this.setData(patch);
      if (this.data.ruleTemplateQuestions.length) this.evaluateRuleTemplate();
    };
    apply(app.globalData.officialQuestions || []);
    if (typeof app.syncOfficialQuestions === "function") app.syncOfficialQuestions((questions) => apply(questions));
  },

  selectTab(event) {
    const activeTab = event.currentTarget.dataset.key;
    this.setData({ activeTab }, () => this.applyExamFilter());
  },

  applyExamFilter() {
    const kind = this.data.activeTab === "past" ? "past_paper" : "official_mock";
    const currentExams = this.data.activeTab === "custom"
      ? []
      : this.data.exams.filter((exam) => exam.kind === kind);
    this.setData({ currentExams });
  },

  loadExams() {
    const app = getApp();
    const apiBaseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!apiBaseUrl || typeof wx.request !== "function") {
      this.setData({ loading: false, loadFailed: true, exams: [], currentExams: [] });
      return;
    }
    this.setData({ loading: true, loadFailed: false });
    wx.request({
      url: `${apiBaseUrl}/api/exams`,
      method: "GET",
      timeout: 8000,
      success: (response) => {
        const records = response && response.statusCode === 200 && response.data && response.data.exams;
        if (!Array.isArray(records)) {
          this.setData({ loading: false, loadFailed: true, exams: [], currentExams: [] });
          return;
        }
        const exams = records.map(normalizeExam).filter((exam) => exam.id && exam.questionCount > 0);
        const ruleTemplates = exams.filter((exam) => exam.kind === "past_paper");
        this.setData({ loading: false, loadFailed: false, exams, ruleTemplates }, () => {
          this.applyExamFilter();
          if (this.data.builderMode === "rule" && ruleTemplates.length) this.loadRuleTemplate(ruleTemplates[this.data.ruleTemplateIndex].id);
        });
      },
      fail: () => this.setData({ loading: false, loadFailed: true, exams: [], currentExams: [] }),
    });
  },

  retryLoad() {
    this.loadExams();
  },

  startCustomExam() {
    this.setData({ activeTab: "custom" }, () => this.startExam({ currentTarget: { dataset: {} } }));
  },

  selectBuilderMode(event) {
    const builderMode = event.currentTarget.dataset.mode;
    if (!['custom', 'rule'].includes(builderMode)) return;
    this.setData({ builderMode });
    if (builderMode === "rule" && this.data.ruleTemplates.length && !this.data.selectedRuleTemplate) {
      this.loadRuleTemplate(this.data.ruleTemplates[this.data.ruleTemplateIndex].id);
    }
  },

  changeRuleTemplate(event) {
    const ruleTemplateIndex = Number(event.detail.value) || 0;
    const template = this.data.ruleTemplates[ruleTemplateIndex];
    if (!template) return;
    this.setData({ ruleTemplateIndex });
    this.loadRuleTemplate(template.id);
  },

  retryRuleTemplate() {
    const template = this.data.ruleTemplates[this.data.ruleTemplateIndex];
    if (template) this.loadRuleTemplate(template.id);
  },

  loadRuleTemplate(examId) {
    const baseUrl = String(getApp().globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || !examId || typeof wx.request !== "function") return;
    this.setData({ ruleLoading: true, ruleLoadFailed: false, selectedRuleTemplate: null, ruleTemplateQuestions: [], ruleBlueprint: [], ruleShortages: [], ruleShortageMoreCount: 0, ruleCanGenerate: false });
    wx.request({
      url: `${baseUrl}/api/exams/${encodeURIComponent(examId)}`,
      timeout: 8000,
      success: (response) => {
        const payload = response.statusCode === 200 && response.data;
        if (!payload || !payload.exam || !Array.isArray(payload.questions)) {
          this.setData({ ruleLoading: false, ruleLoadFailed: true });
          return;
        }
        this.setData({
          ruleLoading: false,
          ruleLoadFailed: false,
          selectedRuleTemplate: normalizeExam(payload.exam),
          ruleTemplateQuestions: payload.questions,
          ruleBlueprint: createExamBlueprint(payload.questions),
        }, () => this.evaluateRuleTemplate());
      },
      fail: () => this.setData({ ruleLoading: false, ruleLoadFailed: true }),
    });
  },

  evaluateRuleTemplate() {
    const template = this.data.selectedRuleTemplate;
    if (!template) return;
    const result = buildRuleExam(
      this.data.ruleTemplateQuestions,
      this._officialQuestions || getApp().globalData.officialQuestions || [],
      template.selectionRules,
      () => 0.5,
    );
    this.setData({
      ruleShortages: result.shortages.slice(0, 4),
      ruleShortageMoreCount: Math.max(0, result.shortages.length - 4),
      ruleCanGenerate: result.success,
    });
  },

  startRuleExam() {
    const template = this.data.selectedRuleTemplate;
    if (!template) {
      wx.showToast({ title: "请先选择真题母版", icon: "none" });
      return;
    }
    const result = buildRuleExam(
      this.data.ruleTemplateQuestions,
      this._officialQuestions || getApp().globalData.officialQuestions || [],
      template.selectionRules,
    );
    if (!result.success) {
      wx.showModal({
        title: "题池暂时不足",
        content: result.shortages.map((item) => item.summary).join("；") || "当前无法完整复刻这份真题。",
        showCancel: false,
      });
      return;
    }
    wx.setStorageSync(RULE_EXAM_STORAGE_KEY, {
      templateId: template.id,
      title: `${template.year} 真题同结构练习`,
      questions: result.questions,
      selectionRules: result.selectionRules,
      durationMinutes: template.durationMinutes,
      totalScore: template.totalScore,
      createdAt: Date.now(),
    });
    wx.navigateTo({ url: "/pages/practice/practice?mode=exam&ruleExam=1" });
  },

  changeCount(event) {
    this.setData({ questionCount: Number(event.detail.value) });
  },

  changeDuration(event) {
    this.setData({ duration: Number(event.detail.value) });
  },

  selectAllSubjects() {
    const total = this.data.subjectOptions.reduce((sum, item) => sum + item.count, 0);
    this.setData({ customScope: "all", customScopeId: "", customScopeLabel: "五科综合", customAvailableCount: total });
  },

  selectCustomSubject(event) {
    const selected = this.data.subjectOptions[Number(event.detail.value)];
    if (!selected) return;
    this.setData({ customScope: "subject", customScopeId: selected.id, customScopeLabel: selected.name, customAvailableCount: selected.count });
  },

  selectCustomBook(event) {
    const selected = this.data.bookOptions[Number(event.detail.value)];
    if (!selected) return;
    this.setData({ customScope: "book", customScopeId: selected.id, customScopeLabel: selected.name, customAvailableCount: selected.count });
  },

  startExam(event) {
    const isCustom = this.data.activeTab === "custom";
    const examId = String(event && event.currentTarget && event.currentTarget.dataset.id || "");
    const exam = isCustom ? null : this.data.currentExams.find((item) => item.id === examId);
    if (!isCustom && !exam) {
      wx.showToast({ title: "试卷暂时无法读取", icon: "none" });
      return;
    }
    if (isCustom && this.data.customAvailableCount <= 0) {
      wx.showToast({ title: "当前范围暂无可用题目", icon: "none" });
      return;
    }
    const questionCount = isCustom ? Math.min(this.data.questionCount, this.data.customAvailableCount) : exam.questionCount;
    const duration = isCustom ? this.data.duration : exam.durationMinutes;
    wx.showModal({
      title: isCustom ? "开始作答" : exam.title,
      content: `本次 ${questionCount} 题，限时 ${duration} 分钟。考试中隐藏解析，交卷或到时后统一显示成绩与答案。`,
      confirmText: "开始考试",
      success: (result) => {
        if (!result.confirm) return;
        const examQuery = exam ? `&examId=${encodeURIComponent(exam.id)}` : "";
        const scopeQuery = !isCustom || this.data.customScope === "all"
          ? ""
          : this.data.customScope === "subject"
            ? `&subjectId=${encodeURIComponent(this.data.customScopeId)}`
            : `&bookId=${encodeURIComponent(this.data.customScopeId)}`;
        const scopeTitleQuery = isCustom ? `&scopeTitle=${encodeURIComponent(`${this.data.customScopeLabel} · 自定义试卷`)}` : "";
        wx.navigateTo({ url: `/pages/practice/practice?mode=exam&count=${questionCount}&duration=${duration}${examQuery}${scopeQuery}${scopeTitleQuery}` });
      },
    });
  },
});

module.exports = { RULE_EXAM_STORAGE_KEY, buildCustomScopeOptions, normalizeExam };
