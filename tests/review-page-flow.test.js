const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("review project switcher lives in the custom navigation bar", () => {
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/review");
  const markup = fs.readFileSync(path.join(pageDir, "review.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "review.wxss"), "utf8");
  const config = JSON.parse(fs.readFileSync(path.join(pageDir, "review.json"), "utf8"));
  assert.equal(config.navigationStyle, "custom");
  assert.match(markup, /class="review-custom-nav"[\s\S]*class="review-project-selector"/);
  assert.match(markup, /class="review-project-trigger[^\"]*"[\s\S]*class="review-project-icon"[\s\S]*\{\{activeProjectName\}\}/);
  assert.doesNotMatch(markup, /class="review-nav-title"/);
  assert.doesNotMatch(markup, /class="page-title">复习</);
  assert.match(styles, /\.review-project-selector \{[^}]*left:\s*34rpx/);
  assert.match(styles, /\.review-project-trigger \{[^}]*color:\s*#171717/);
  assert.match(styles, /\.review-project-icon \{[^}]*width:\s*34rpx;[^}]*height:\s*34rpx;[^}]*color:\s*#777777;[^}]*border:\s*3rpx solid currentColor/);
  assert.match(styles, /\.review-project-icon view \{[^}]*width:\s*3rpx/);
  assert.match(styles, /\.review-project-trigger text \{[^}]*font-size:\s*28rpx;[^}]*font-weight:\s*800/);
});

test("review page builds real queues and opens the selected questions", () => {
  let definition;
  let navigatedUrl = "";
  let toastTitle = "";
  const now = Date.now();
  const store = new Map([
    ["shukao_review_states", {
      "demo-modern-chinese-001": {
        questionId: "demo-modern-chinese-001",
        stage: 0,
        masteryStatus: "unknown",
        nextReviewAt: now,
        lastReviewAt: now,
        lastIsCorrect: false,
        removedManually: false,
      },
    }],
    ["shukao_attempts", [{
      questionId: "demo-modern-chinese-001",
      isCorrect: false,
      createdAt: now,
    }]],
    ["shukao_bookmark_demo-modern-chinese-002", true],
  ]);
  global.Page = (value) => { definition = value; };
  const { demoQuestions } = require("../apps/miniprogram/data/catalog");
  global.getApp = () => ({
    globalData: { officialQuestions: demoQuestions, loggedIn: false },
    syncOfficialQuestions(callback) { callback(demoQuestions); },
  });
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    navigateTo: ({ url }) => { navigatedUrl = url; },
    showToast: ({ title }) => { toastTitle = title; },
  };

  const reviewPath = require.resolve("../apps/miniprogram/pages/review/review.js");
  delete require.cache[reviewPath];
  require(reviewPath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };

  page.onShow();
  assert.equal(page.data.dueCount, 1);
  assert.deepEqual(page.data.activeQuestionIds, ["demo-modern-chinese-001"]);
  assert.deepEqual(page.data.filters.map((item) => item.count), [1, 1, 0]);
  assert.equal(page.data.reviewStats.length, 3);
  assert.equal(page.data.reviewStats.some((item) => item.label === "待复习"), false);
  assert.deepEqual(page.data.reviewToolPages.map((toolPage) => toolPage.tools.length), [8, 1]);
  assert.deepEqual(page.data.reviewToolPages.flatMap((toolPage) => toolPage.tools).slice(0, 3).map((tool) => tool.key), ["comprehensive", "smart", "wrong"]);
  page.changeReviewToolPage({ detail: { current: 1 } });
  assert.equal(page.data.reviewToolPageIndex, 1);

  const examDay = new Date(now);
  examDay.setDate(examDay.getDate() + 10);
  const examDate = [examDay.getFullYear(), String(examDay.getMonth() + 1).padStart(2, "0"), String(examDay.getDate()).padStart(2, "0")].join("-");
  page.changeExamDate({ detail: { value: examDate } });
  assert.equal(page.data.examCountdownText, "10");
  assert.equal(store.get("shukao_exam_date_chinese-upgrade"), examDate);

  const today = new Date(now);
  const todayKey = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
  store.set("shukao_attempts", [
    {
      questionId: "demo-modern-chinese-001",
      isCorrect: true,
      mastery: "familiar",
      practiceMode: "review",
      createdAt: now + 1,
      question: demoQuestions[0],
    },
    {
      questionId: "demo-modern-chinese-001",
      isCorrect: false,
      createdAt: now,
      question: demoQuestions[0],
    },
  ]);
  store.set("shukao_review_states", {
    "demo-modern-chinese-001": {
      questionId: "demo-modern-chinese-001",
      stage: 2,
      masteryStatus: "familiar",
      nextReviewAt: now + 3 * 24 * 60 * 60 * 1000,
      lastReviewAt: now + 1,
      lastIsCorrect: true,
      removedManually: false,
    },
  });
  store.set("shukao_review_history", [{
    id: `review-${todayKey}-demo-modern-chinese-001`,
    dateKey: todayKey,
    questionId: "demo-modern-chinese-001",
    question: demoQuestions[0],
    isCorrect: true,
    mastery: "familiar",
    status: "mastered",
    updatedAt: now + 1,
  }]);
  page.refreshReviewData();
  assert.equal(page.data.dueCount, 0);
  assert.equal(page.data.completedToday, 1);
  assert.equal(page.data.completedReviewItems[0].stateLabel, "已掌握");
  assert.deepEqual(page.data.filters.map((item) => item.count), [1, 0, 0]);
  // 页内「收藏」筛选已删除：收藏只从工具宫格进入独立页面
  assert.deepEqual(page.data.filters.map((item) => item.key), ["due", "wrong", "knowledge"]);
  assert.deepEqual(page.data.dueSubfilters.map((item) => item.count), [0, 1]);
  assert.equal(page.data.reviewStats.find((item) => item.label === "今日完成").value, 1);
  assert.equal(page.data.reviewStats.find((item) => item.label === "连续天数").value, 1);
  page.selectDueSubfilter({ currentTarget: { dataset: { value: "completed" } } });
  assert.deepEqual(page.data.activeQuestionIds, ["demo-modern-chinese-001"]);
  assert.equal(page.data.visibleReviewItems[0].stateLabel, "已掌握");
  page.selectDueSubfilter({ currentTarget: { dataset: { value: "pending" } } });

  page.selectFilter({ currentTarget: { dataset: { value: "wrong" } } });
  assert.deepEqual(page.data.activeQuestionIds, []);
  page.selectWrongSubfilter({ currentTarget: { dataset: { value: "mastered" } } });
  assert.deepEqual(page.data.activeQuestionIds, ["demo-modern-chinese-001"]);

  // 收藏改走独立页面：工具宫格里的「收藏」直接跳转，不再切页内筛选
  page.openReviewTool({ currentTarget: { dataset: { key: "favorite" } } });
  assert.equal(navigatedUrl, "/pages/favorites/favorites");
  // 页内已无「收藏」筛选：传旧值会退回默认筛选，而不是显示一个收藏列表
  page.selectFilter({ currentTarget: { dataset: { value: "favorite" } } });
  assert.ok(["due", "wrong", "knowledge"].includes(page.data.activeFilter));

  page.selectFilter({ currentTarget: { dataset: { value: "wrong" } } });
  page.startReview();
  assert.deepEqual(store.get("shukao_active_review_ids"), ["demo-modern-chinese-001"]);
  assert.equal(navigatedUrl, "/pages/practice/practice?mode=review");

  page.openAnalysis();
  assert.equal(navigatedUrl, "/pages/analysis/analysis?subjectId=chinese-comprehensive");

  const manyDueStates = Object.fromEntries(demoQuestions.slice(0, 7).map((question, index) => [question.id, {
    questionId: question.id,
    stage: 0,
    masteryStatus: "unknown",
    nextReviewAt: now + index,
    lastReviewAt: now,
    lastIsCorrect: false,
    removedManually: false,
  }]));
  store.set("shukao_review_states", manyDueStates);
  store.set("shukao_review_history", []);
  store.set("shukao_active_review_ids", []);
  page.setData({ activeFilter: "due", dueSubfilter: "pending" });
  page.refreshReviewData();
  assert.equal(page.data.activeQuestionIds.length, 7);
  assert.equal(page.data.visibleReviewItems.length, 7);
  assert.equal(page.data.dueQuestionIds.length, 7);
  page.startDueReview();
  assert.deepEqual(store.get("shukao_active_review_ids"), page.data.dueQuestionIds);
  assert.equal(navigatedUrl, "/pages/practice/practice?mode=review");
  page.openTodayCalendar();
  assert.equal(navigatedUrl, "/pages/review-calendar/review-calendar");
  page.openReviewTool({ currentTarget: { dataset: { key: "comprehensive" } } });
  assert.equal(navigatedUrl, "/pages/practice/practice?mode=comprehensive");
  page.openReviewTool({ currentTarget: { dataset: { key: "smart" } } });
  assert.deepEqual(store.get("shukao_active_review_ids"), ["demo-modern-chinese-001"]);
  assert.equal(navigatedUrl, "/pages/practice/practice?mode=review");
  page.setData({ smartQuestionIds: [] });
  navigatedUrl = "";
  page.openReviewTool({ currentTarget: { dataset: { key: "smart" } } });
  assert.equal(toastTitle, "先完成一些练习，系统才能生成智能题组");
  assert.equal(navigatedUrl, "");

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
