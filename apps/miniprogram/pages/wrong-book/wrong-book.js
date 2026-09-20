const { closeTransientLayers } = require("../../utils/page-layers");
const { buildWrongBookView, emptyWrongBookFilters } = require("../../utils/review-library");

Page({
  data: {
    activeStatus: "pending",
    groupMode: "directory",
    statusOptions: [],
    groups: [],
    activeIds: [],
    historyCount: 0,
    subjectCount: 0,
    expandedGroupIds: {},
    expandedChildIds: {},
    selectedChapterId: "",
    selectedChapter: null,
    selectedChapterPath: "",
    filters: emptyWrongBookFilters(),
    draftFilters: emptyWrongBookFilters(),
    filterSections: [],
    draftFilterSections: [],
    filterTags: [],
    filterCount: 0,
    filterPanelOpen: false,
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的长按工具栏 / 抽屉 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["filterPanelOpen"]);
  },

  onShow() {
    this.refreshWrongBook();
    const app = getApp();
    if (typeof app.syncOfficialQuestions === "function") {
      app.syncOfficialQuestions(() => this.refreshWrongBook(), { force: true });
    }
    if (typeof app.syncLearningState === "function" && app.globalData.loggedIn) {
      app.syncLearningState(() => this.refreshWrongBook());
    }
  },

  refreshWrongBook() {
    const app = getApp();
    const result = buildWrongBookView({
      officialQuestions: app.globalData.officialQuestions || [],
      attempts: wx.getStorageSync("shukao_attempts") || [],
      reviewStates: wx.getStorageSync("shukao_review_states") || {},
      reviewHistory: wx.getStorageSync("shukao_review_history") || [],
      statusKey: this.data.activeStatus,
      groupMode: this.data.groupMode,
      filters: this.data.filters,
    });
    const expandedGroupIds = this.data.expandedGroupIds || {};
    const expandedChildIds = this.data.expandedChildIds || {};
    const groups = result.groupList.map((group) => ({
      ...group,
      expanded: expandedGroupIds[group.id] === true,
      children: (group.children || []).map((child) => ({ ...child, expanded: expandedChildIds[child.id] === true })),
    }));
    let selectedChapter = null;
    let selectedChapterPath = "";
    if (this.data.groupMode === "directory" && this.data.selectedChapterId) {
      const selectedSubject = groups.find((group) => (group.children || []).some((child) => child.id === this.data.selectedChapterId));
      selectedChapter = selectedSubject && selectedSubject.children.find((child) => child.id === this.data.selectedChapterId);
      if (selectedChapter) selectedChapterPath = `${selectedSubject.label} ＞ ${selectedChapter.label}`;
    }
    this.setData({
      activeStatus: result.activeStatus,
      statusOptions: result.statusOptions,
      activeIds: result.activeIds,
      historyCount: result.historyCount,
      subjectCount: result.subjectCount,
      filters: result.filters,
      draftFilters: result.filters,
      filterSections: result.filterSections,
      draftFilterSections: result.filterSections,
      filterTags: result.filterTags,
      filterCount: result.filterCount,
      groups,
      selectedChapterId: selectedChapter ? selectedChapter.id : "",
      selectedChapter,
      selectedChapterPath,
    });
  },

  selectStatus(event) {
    this.setData({ activeStatus: event.currentTarget.dataset.status, expandedGroupIds: {}, selectedChapterId: "", selectedChapter: null, selectedChapterPath: "" }, () => this.refreshWrongBook());
  },

  selectGroupMode(event) {
    this.setData({ groupMode: event.currentTarget.dataset.mode, expandedGroupIds: {}, expandedChildIds: {}, selectedChapterId: "", selectedChapter: null, selectedChapterPath: "" }, () => this.refreshWrongBook());
  },

  toggleGroup(event) {
    const groupId = event.currentTarget.dataset.groupId;
    const expandedGroupIds = { ...this.data.expandedGroupIds, [groupId]: !this.data.expandedGroupIds[groupId] };
    this.setData({
      expandedGroupIds,
      groups: this.data.groups.map((group) => group.id === groupId ? { ...group, expanded: expandedGroupIds[groupId] } : group),
    });
  },

  openChapter(event) {
    const childId = event.currentTarget.dataset.childId;
    const selectedSubject = this.data.groups.find((group) => (group.children || []).some((child) => child.id === childId));
    const selectedChapter = selectedSubject && selectedSubject.children.find((child) => child.id === childId);
    if (!selectedChapter) return;
    this.setData({
      selectedChapterId: childId,
      selectedChapter,
      selectedChapterPath: `${selectedSubject.label} ＞ ${selectedChapter.label}`,
    });
  },

  closeChapter() {
    this.setData({ selectedChapterId: "", selectedChapter: null, selectedChapterPath: "" });
  },

  openFilterPanel() {
    this.setData({ filterPanelOpen: true, draftFilters: this.data.filters, draftFilterSections: this.data.filterSections });
  },

  closeFilterPanel() {
    this.setData({ filterPanelOpen: false });
  },

  stopPropagation() {},

  toggleDraftFilter(event) {
    const sectionKey = event.currentTarget.dataset.section;
    const value = event.currentTarget.dataset.value;
    const selected = this.data.draftFilters[sectionKey] || [];
    const nextValues = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    const draftFilters = { ...this.data.draftFilters, [sectionKey]: nextValues };
    const app = getApp();
    const result = buildWrongBookView({
      officialQuestions: app.globalData.officialQuestions || [],
      attempts: wx.getStorageSync("shukao_attempts") || [],
      reviewStates: wx.getStorageSync("shukao_review_states") || {},
      reviewHistory: wx.getStorageSync("shukao_review_history") || [],
      statusKey: this.data.activeStatus,
      groupMode: this.data.groupMode,
      filters: draftFilters,
    });
    this.setData({ draftFilters: result.filters, draftFilterSections: result.filterSections });
  },

  resetDraftFilters() {
    const filters = emptyWrongBookFilters();
    this.setData({ draftFilters: filters });
    const app = getApp();
    const result = buildWrongBookView({
      officialQuestions: app.globalData.officialQuestions || [],
      attempts: wx.getStorageSync("shukao_attempts") || [],
      reviewStates: wx.getStorageSync("shukao_review_states") || {},
      reviewHistory: wx.getStorageSync("shukao_review_history") || [],
      statusKey: this.data.activeStatus,
      groupMode: this.data.groupMode,
      filters,
    });
    this.setData({ draftFilterSections: result.filterSections });
  },

  applyFilters() {
    this.setData({ filters: this.data.draftFilters, filterPanelOpen: false, expandedGroupIds: {}, expandedChildIds: {}, selectedChapterId: "", selectedChapter: null, selectedChapterPath: "" }, () => this.refreshWrongBook());
  },

  removeFilterTag(event) {
    const key = event.currentTarget.dataset.key;
    const value = event.currentTarget.dataset.value;
    const filters = { ...this.data.filters, [key]: (this.data.filters[key] || []).filter((item) => item !== value) };
    this.setData({ filters, expandedGroupIds: {}, expandedChildIds: {}, selectedChapterId: "", selectedChapter: null, selectedChapterPath: "" }, () => this.refreshWrongBook());
  },

  startGroupReview(event) {
    const groupId = event.currentTarget.dataset.groupId;
    const childId = event.currentTarget.dataset.childId;
    const group = this.data.groups.find((item) => item.id === groupId);
    const target = childId && group ? (group.children || []).find((item) => item.id === childId) : group;
    if (!target || !target.questionIds.length) return;
    wx.setStorageSync("shukao_active_review_ids", target.questionIds);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },

  startQuestionReview(event) {
    const questionId = event.currentTarget.dataset.questionId;
    const sourceIds = this.data.selectedChapter ? this.data.selectedChapter.questionIds : this.data.activeIds;
    const index = sourceIds.indexOf(questionId);
    const ids = index < 0 ? [questionId] : [...sourceIds.slice(index), ...sourceIds.slice(0, index)];
    wx.setStorageSync("shukao_active_review_ids", ids);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },
});
