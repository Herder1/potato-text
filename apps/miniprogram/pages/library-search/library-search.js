const { subjects } = require("../../data/catalog");
const { loadPrivatePacks } = require("../../utils/private-pack-store");
const {
  SEARCH_SCOPES,
  createSearchRecords,
  filterSearchRecords,
} = require("../../utils/library-content");
const { cachePublicPack } = require("../../utils/pack-collection");

const HISTORY_KEY = "shukao_library_search_history";

Page({
  data: {
    scopes: SEARCH_SCOPES,
    activeScope: "all",
    query: "",
    inputFocus: true,
    history: [],
    records: [],
    results: [],
    searched: false,
    loading: true,
    subjectOptions: [{ id: "all", label: "全部科目" }],
    subjectIndex: 0,
    subjectFilter: "all",
  },

  onLoad(options = {}) {
    const requestedScope = SEARCH_SCOPES.some((item) => item.id === options.scope) ? options.scope : "all";
    this.setData({
      activeScope: requestedScope,
      history: (wx.getStorageSync(HISTORY_KEY) || []).slice(0, 10),
    });
    this.loadSearchData();
  },

  loadSearchData() {
    const app = getApp();
    const withSubjectNames = (app.globalData.officialQuestions || []).map((question) => {
      const subject = subjects.find((item) => item.id === question.subjectId);
      return { ...question, subjectName: question.subjectName || subject && subject.name || "" };
    });
    const state = {
      questions: withSubjectNames,
      privatePacks: loadPrivatePacks(),
      publicPacks: [],
      exams: [],
      materials: [],
    };
    this.applySearchData(state);
    if (typeof app.syncOfficialQuestions === "function") {
      app.syncOfficialQuestions((questions) => {
        state.questions = (questions || []).map((question) => {
          const subject = subjects.find((item) => item.id === question.subjectId);
          return { ...question, subjectName: question.subjectName || subject && subject.name || "" };
        });
        this.applySearchData(state);
      });
    }
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || typeof wx.request !== "function") {
      this.setData({ loading: false });
      return;
    }
    let pending = 3;
    const finish = () => {
      pending -= 1;
      if (pending <= 0) this.setData({ loading: false });
    };
    const requestList = (path, key, pick) => wx.request({
      url: `${baseUrl}${path}`,
      timeout: 8000,
      success: (response) => {
        const records = pick(response);
        if (Array.isArray(records)) {
          state[key] = records;
          this.applySearchData(state);
        }
        finish();
      },
      fail: finish,
    });
    requestList("/api/packs", "publicPacks", (response) => response.statusCode === 200 && response.data && response.data.packs);
    requestList("/api/exams", "exams", (response) => response.statusCode === 200 && response.data && response.data.exams);
    requestList("/api/discovery", "materials", (response) => {
      const products = response.statusCode === 200 && response.data && response.data.products;
      return Array.isArray(products) ? products.filter((item) => item.kind === "material") : null;
    });
  },

  applySearchData(state) {
    const records = createSearchRecords(state);
    const subjectsInData = [...new Set(records.map((record) => record.subject).filter((subject) => subject && subject !== "综合"))];
    const subjectOptions = [{ id: "all", label: "全部科目" }, ...subjectsInData.map((subject) => ({ id: subject, label: subject }))];
    this.setData({ records, subjectOptions }, () => this.applyFilter());
  },

  updateQuery(event) {
    this.setData({ query: event.detail.value, searched: false }, () => this.applyFilter());
  },

  clearQuery() {
    this.setData({ query: "", searched: false, inputFocus: true }, () => this.applyFilter());
  },

  selectScope(event) {
    this.setData({ activeScope: event.currentTarget.dataset.id }, () => this.applyFilter());
  },

  changeSubject(event) {
    const subjectIndex = Number(event.detail.value) || 0;
    const selected = this.data.subjectOptions[subjectIndex] || this.data.subjectOptions[0];
    this.setData({ subjectIndex, subjectFilter: selected.id }, () => this.applyFilter());
  },

  applyFilter() {
    const results = filterSearchRecords(this.data.records, {
      query: this.data.query,
      scope: this.data.activeScope,
      subject: this.data.subjectFilter,
    });
    this.setData({ results });
  },

  submitSearch() {
    const query = this.data.query.trim();
    if (!query) return;
    const history = [query, ...this.data.history.filter((item) => item !== query)].slice(0, 10);
    wx.setStorageSync(HISTORY_KEY, history);
    this.setData({ query, history, searched: true, inputFocus: false }, () => this.applyFilter());
  },

  useHistory(event) {
    this.setData({ query: event.currentTarget.dataset.value, searched: true }, () => this.applyFilter());
  },

  clearHistory() {
    wx.removeStorageSync(HISTORY_KEY);
    this.setData({ history: [] });
  },

  openResult(event) {
    const result = this.data.records.find((item) => item.scope === event.currentTarget.dataset.scope && item.id === event.currentTarget.dataset.id);
    if (!result) return;
    if (result.scope === "question") {
      const bookQuery = result.bookId ? `&bookId=${encodeURIComponent(result.bookId)}` : "";
      wx.navigateTo({ url: `/pages/practice/practice?questionId=${encodeURIComponent(result.id)}${bookQuery}` });
      return;
    }
    if (result.scope === "pack" && result.sourceKind === "private") {
      wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(result.id)}` });
      return;
    }
    if (result.scope === "pack") {
      cachePublicPack(result.source);
      wx.navigateTo({ url: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(result.id)}&source=public` });
      return;
    }
    if (result.scope === "material") {
      wx.setStorageSync("shukao_library_requested_content", { tab: "materials", id: result.id });
      wx.navigateBack();
      return;
    }
    const exam = result.source;
    wx.showModal({
      title: exam.title,
      content: `本次 ${exam.questionCount} 题，限时 ${exam.durationMinutes} 分钟。交卷后统一查看答案与解析。`,
      confirmText: "开始考试",
      success: ({ confirm }) => {
        if (!confirm) return;
        wx.navigateTo({ url: `/pages/practice/practice?mode=exam&count=${exam.questionCount}&duration=${exam.durationMinutes}&examId=${encodeURIComponent(exam.id)}` });
      },
    });
  },
});
