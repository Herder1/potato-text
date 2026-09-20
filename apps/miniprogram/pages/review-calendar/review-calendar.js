const {
  buildCalendarCompletedItems,
  buildCalendarReviewItems,
  calendarWeekDateKeys,
  calendarWeekPageDate,
  dateKey,
} = require("../../utils/review-library");
const { normalizeReviewStates } = require("../../utils/review-schedule");

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];
const stageMeta = [
  { label: "初次纠正", interval: "当天", color: "#df5f67" },
  { label: "首次巩固", interval: "+1 天", color: "#de8200" },
  { label: "再次巩固", interval: "+3 天", color: "#119587" },
  { label: "掌握检查", interval: "+7 天", color: "#3977e8" },
  { label: "长期巩固", interval: "+14 天", color: "#8b63dc" },
  { label: "稳定检查", interval: "+30 天", color: "#58645d" },
];

const completionMeta = {
  pending: { label: "仍需复习", color: "#df5f67" },
  corrected: { label: "已纠正", color: "#176d87" },
  reinforcing: { label: "待巩固", color: "#de8200" },
  mastered: { label: "已掌握", color: "#42a66a" },
};

function parseDate(value) {
  const parts = String(value || "").split("-").map(Number);
  return new Date(parts[0], Math.max(0, parts[1] - 1), parts[2] || 1);
}

function monthLabel(value) {
  const date = parseDate(value);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

function buildWeek(selectedDate, reviewStates) {
  const selected = parseDate(selectedDate);
  const counts = Object.values(normalizeReviewStates(reviewStates)).reduce((map, state) => {
    if (state.removedManually) return map;
    const key = dateKey(Number(state.nextReviewAt));
    map[key] = (map[key] || 0) + 1;
    return map;
  }, {});
  return calendarWeekDateKeys(selectedDate).map((key) => {
    const date = parseDate(key);
    return {
      key,
      weekday: weekdayLabels[date.getDay()],
      day: date.getDate(),
      count: counts[key] || 0,
      selected: key === selectedDate,
      today: key === dateKey(),
      outsideMonth: date.getMonth() !== selected.getMonth(),
    };
  });
}

Page({
  data: {
    selectedDate: dateKey(),
    todayDate: dateKey(),
    monthTitle: monthLabel(dateKey()),
    weekDays: [],
    reviewItems: [],
    completedItems: [],
    stageMeta,
    selectedDateLabel: "",
  },

  onShow() {
    this.refreshCalendar();
    const app = getApp();
    if (typeof app.syncOfficialQuestions === "function") {
      app.syncOfficialQuestions(() => this.refreshCalendar(), { force: true });
    }
    if (typeof app.syncLearningState === "function" && app.globalData.loggedIn) {
      app.syncLearningState(() => this.refreshCalendar());
    }
  },

  refreshCalendar() {
    const app = getApp();
    const reviewStates = wx.getStorageSync("shukao_review_states") || {};
    const reviewSource = {
      officialQuestions: app.globalData.officialQuestions || [],
      attempts: wx.getStorageSync("shukao_attempts") || [],
      reviewStates,
      reviewHistory: wx.getStorageSync("shukao_review_history") || [],
      selectedDate: this.data.selectedDate,
    };
    const reviewItems = buildCalendarReviewItems(reviewSource)
      .map((item) => ({ ...item, stageMeta: stageMeta[item.stage] || stageMeta[0] }));
    const completedItems = buildCalendarCompletedItems(reviewSource)
      .map((item) => ({
        ...item,
        completionMeta: completionMeta[item.status] || completionMeta.corrected,
        completedTime: item.updatedAt
          ? new Date(item.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "",
      }))
      .map((item) => ({
        ...item,
        completionLine: [item.subjectName, item.completionMeta.label, item.completedTime].filter(Boolean).join(" · "),
      }));
    const selected = parseDate(this.data.selectedDate);
    this.setData({
      monthTitle: monthLabel(this.data.selectedDate),
      weekDays: buildWeek(this.data.selectedDate, reviewStates),
      reviewItems,
      completedItems,
      selectedDateLabel: `${selected.getMonth() + 1} 月 ${selected.getDate()} 日`,
    });
  },

  selectDate(event) {
    this.setData({ selectedDate: event.currentTarget.dataset.date }, () => this.refreshCalendar());
  },

  changeWeek(event) {
    const offset = Number(event.currentTarget.dataset.offset) || 0;
    this.setData({ selectedDate: calendarWeekPageDate(this.data.selectedDate, offset) }, () => this.refreshCalendar());
  },

  selectToday() {
    this.setData({ selectedDate: dateKey() }, () => this.refreshCalendar());
  },

  startDayReview() {
    const ids = this.data.reviewItems.map((item) => item.id);
    if (!ids.length) {
      wx.showToast({ title: "当天没有安排复习题目", icon: "none" });
      return;
    }
    wx.setStorageSync("shukao_active_review_ids", ids);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },

  startQuestionReview(event) {
    const questionId = event.currentTarget.dataset.questionId;
    const ids = this.data.reviewItems.map((item) => item.id);
    const index = ids.indexOf(questionId);
    wx.setStorageSync("shukao_active_review_ids", index < 0 ? [questionId] : [...ids.slice(index), ...ids.slice(0, index)]);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },

  startCompletedReview(event) {
    const questionId = event.currentTarget.dataset.questionId;
    if (!questionId) return;
    wx.setStorageSync("shukao_active_review_ids", [questionId]);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },
});

module.exports = { buildWeek, monthLabel, parseDate, stageMeta };
