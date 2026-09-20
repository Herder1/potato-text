const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildCalendarCompletedItems, buildCalendarReviewItems, buildWrongBookView, calendarWeekDateKeys, calendarWeekPageDate, dateKey, normalizeDirectoryLabel } = require("../apps/miniprogram/utils/review-library");

test("review home keeps nine tools in a swipeable two-row pager", () => {
  const root = path.join(__dirname, "../apps/miniprogram");
  const markup = fs.readFileSync(path.join(root, "pages/review/review.wxml"), "utf8");
  const script = fs.readFileSync(path.join(root, "pages/review/review.js"), "utf8");
  const config = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  ["综合训练", "智能刷题", "错题本", "收藏", "知识卡", "学情分析", "自习室", "番茄时钟", "复习日历"].forEach((label) => assert.match(script, new RegExp(label)));
  assert.match(script, /key: "comprehensive"[\s\S]*key: "smart"[\s\S]*key: "wrong"[\s\S]*key: "calendar"[\s\S]*key: "analysis"[\s\S]*key: "knowledge"[\s\S]*key: "favorite"[\s\S]*key: "pomodoro"[\s\S]*key: "study-room"/);
  assert.match(markup, /bindtap="openReviewTool"/);
  assert.match(markup, /class="review-tools-swiper"[\s\S]*wx:for="\{\{reviewToolPages\}\}"[\s\S]*class="review-tools-grid"/);
  assert.doesNotMatch(markup, /indicator-dots=/);
  assert.match(markup, /class="review-tools-pagination"[\s\S]*class="review-tools-page-dot/);
  assert.doesNotMatch(markup, /class="analysis-heading"|class="review-insight"|canvas-id="reviewRadar"/);
  assert.match(markup, /class="review-list-heading review-today-heading"[\s\S]*class="review-tools-heading"[\s\S]*class="review-tools-panel"/);
  assert.doesNotMatch(markup, /class="review-tools-panel">\s*<view class="review-tools-head"/);
  const styles = fs.readFileSync(path.join(root, "pages/review/review.wxss"), "utf8");
  assert.match(styles, /\.review-tools-panel \{[^}]*height:\s*382rpx[^}]*padding:\s*32rpx 24rpx/);
  assert.match(styles, /\.review-tools-swiper \{[^}]*height:\s*296rpx[^}]*margin-top:\s*0/);
  assert.match(styles, /\.review-tools-grid \{[^}]*height:\s*296rpx[^}]*row-gap:\s*28rpx/);
  assert.match(styles, /\.review-tools-pagination \{[^}]*height:\s*10rpx[^}]*margin-top:\s*10rpx/);
  assert.match(styles, /\.review-tools-page-dot \{[^}]*width:\s*10rpx[^}]*height:\s*10rpx/);
  assert.match(markup, /catchtap="startDueReview"/);
  assert.doesNotMatch(markup, /wx:for="\{\{visibleReviewItems\}\}"[\s\S]*activeFilter === 'due'/);
  assert.ok(config.pages.includes("pages/wrong-book/wrong-book"));
  assert.ok(config.pages.includes("pages/review-calendar/review-calendar"));
});

test("wrong book supports four states, directory hierarchy and knowledge grouping", () => {
  const now = Date.now();
  const questions = [
    { id: "q1", subjectId: "modern-chinese", bookId: "modern-chinese-7-1", chapterId: "voice", chapter: "第一章 语音", breadcrumb: "现代汉语 · 上册 · 第一章 语音", knowledgePoint: "声母" },
    { id: "q2", subjectId: "modern-chinese", bookId: "modern-chinese-7-1", chapterId: "vocabulary", chapter: "第三章 词汇", breadcrumb: "现代汉语 · 上册 · 第三章 词汇", knowledgePoint: "词义" },
  ];
  const attempts = [
    { questionId: "q1", isCorrect: false, createdAt: now - 2 },
    { questionId: "q2", isCorrect: false, createdAt: now - 3 },
    { questionId: "q2", isCorrect: true, mastery: "fuzzy", createdAt: now - 1 },
  ];
  const states = {
    q1: { questionId: "q1", lastIsCorrect: false, masteryStatus: "unknown" },
    q2: { questionId: "q2", lastIsCorrect: true, masteryStatus: "fuzzy" },
  };
  const pending = buildWrongBookView({ officialQuestions: questions, attempts, reviewStates: states, statusKey: "pending", groupMode: "directory" });
  assert.deepEqual(pending.statusOptions.map((item) => item.label), ["待纠正", "待巩固", "已掌握", "历史错题"]);
  assert.deepEqual(pending.activeIds, ["q1"]);
  assert.equal(pending.groupList[0].label, "现代汉语");
  assert.equal(pending.groupList[0].secondary, "1 个章节");
  assert.equal(pending.groupList[0].children[0].label, "第一章 语音");
  assert.deepEqual(pending.groupList[0].children[0].questionIds, ["q1"]);
  assert.equal(normalizeDirectoryLabel("第一章 语音·第一节 概说 > 一、性质"), "第一章 语音 ＞ 第一节 概说 ＞ 一、性质");
  const reinforcing = buildWrongBookView({ officialQuestions: questions, attempts, reviewStates: states, statusKey: "reinforcing", groupMode: "knowledge" });
  assert.deepEqual(reinforcing.activeIds, ["q2"]);
  assert.equal(reinforcing.groupList[0].label, "词义");
});

test("wrong book chapter mode separates the directory from the flat question list", () => {
  const root = path.join(__dirname, "../apps/miniprogram/pages/wrong-book");
  const markup = fs.readFileSync(path.join(root, "wrong-book.wxml"), "utf8");
  assert.match(markup, /bindtap="openChapter"/);
  assert.match(markup, /class="wrong-chapter-path">\{\{selectedChapterPath\}\}/);
  assert.match(markup, /class="wrong-focus-stem">\{\{item\.stem\}\}/);
  assert.match(markup, /class="wrong-focus-status">\{\{item\.wrongStatusLabel\}\}/);
  assert.match(markup, /class="wrong-focus-question"[\s\S]*bindtap="startQuestionReview"/);
  assert.doesNotMatch(markup, /练习本章节/);
  assert.doesNotMatch(markup, /\{\{question\.bookName\}\}\s*·\s*\{\{question\.knowledgePoint\}\}/);
});

test("wrong book filters cascade across subject, textbook, chapter and knowledge point", () => {
  const now = Date.now();
  const questions = [
    { id: "q1", subjectId: "modern-chinese", bookId: "modern-chinese-7-1", chapterId: "voice", chapter: "第一章 语音", knowledgePoint: "声母" },
    { id: "q2", subjectId: "modern-chinese", bookId: "modern-chinese-7-2", chapterId: "grammar", chapter: "第四章 语法", knowledgePoint: "句法" },
    { id: "q3", subjectId: "classical-chinese", bookId: "classical-chinese-1", chapterId: "common", chapter: "古汉语通论", knowledgePoint: "词类活用" },
    { id: "q4", breadcrumb: "", knowledgePoint: "" },
  ];
  const attempts = questions.map((question, index) => ({ questionId: question.id, question, isCorrect: false, createdAt: now - index }));
  const all = buildWrongBookView({ officialQuestions: questions, attempts, statusKey: "history", groupMode: "directory" });
  assert.deepEqual(all.filterSections.map((section) => section.label), ["科目", "教材", "章节", "知识点"]);
  assert.equal(all.filterSections[0].options.some((option) => option.label === "未归类科目"), true);
  const modernSubject = all.filterSections[0].options.find((option) => option.label === "现代汉语");
  const scoped = buildWrongBookView({ officialQuestions: questions, attempts, statusKey: "history", groupMode: "directory", filters: { subjects: [modernSubject.value] } });
  assert.equal(scoped.activeIds.length, 2);
  assert.equal(scoped.filterSections[1].options.length, 2);
  assert.equal(scoped.filterCount, 1);
  const firstBook = scoped.filterSections[1].options[0];
  const narrowed = buildWrongBookView({ officialQuestions: questions, attempts, statusKey: "history", groupMode: "directory", filters: { subjects: [modernSubject.value], books: [firstBook.value] } });
  assert.equal(narrowed.activeIds.length, 1);
  assert.equal(narrowed.filterSections[2].options.length, 1);
});

test("review calendar exposes scheduled questions on their exact local date", () => {
  const next = new Date(2026, 7, 16, 10, 0, 0).getTime();
  const items = buildCalendarReviewItems({
    officialQuestions: [{ id: "q1", subjectId: "modern-chinese", knowledgePoint: "方言区代表" }],
    reviewStates: { q1: { questionId: "q1", stage: 3, nextReviewAt: next, removedManually: false } },
    selectedDate: dateKey(next),
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].stage, 3);
  assert.equal(items[0].subjectName, "现代汉语");
});

test("review calendar paging advances one continuous seven-day page", () => {
  const firstSelectedDate = "2026-08-30";
  const secondSelectedDate = calendarWeekPageDate(firstSelectedDate, 1);
  const thirdSelectedDate = calendarWeekPageDate(secondSelectedDate, 1);
  assert.deepEqual(calendarWeekDateKeys(firstSelectedDate), [
    "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30",
    "2026-08-31", "2026-09-01", "2026-09-02",
  ]);
  assert.deepEqual(calendarWeekDateKeys(secondSelectedDate), [
    "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
    "2026-09-07", "2026-09-08", "2026-09-09",
  ]);
  assert.deepEqual(calendarWeekDateKeys(thirdSelectedDate), [
    "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13",
    "2026-09-14", "2026-09-15", "2026-09-16",
  ]);
  assert.equal(calendarWeekPageDate(secondSelectedDate, -1), firstSelectedDate);
  assert.deepEqual(calendarWeekDateKeys(calendarWeekPageDate("2026-12-31", 1)), [
    "2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07",
    "2027-01-08", "2027-01-09", "2027-01-10",
  ]);
});

test("review calendar page renders the selected date in the middle of its seven-day window", () => {
  const pagePath = require.resolve("../apps/miniprogram/pages/review-calendar/review-calendar");
  const previousPage = global.Page;
  try {
    global.Page = () => {};
    delete require.cache[pagePath];
    const { buildWeek } = require(pagePath);
    const firstPage = buildWeek("2026-08-30", {});
    const secondPage = buildWeek(calendarWeekPageDate("2026-08-30", 1), {});
    assert.deepEqual(firstPage.map((item) => item.key), calendarWeekDateKeys("2026-08-30"));
    assert.deepEqual(secondPage.map((item) => item.key), calendarWeekDateKeys("2026-09-06"));
    assert.deepEqual(firstPage.map((item) => item.selected), [false, false, false, true, false, false, false]);
  } finally {
    delete require.cache[pagePath];
    if (previousPage === undefined) delete global.Page;
    else global.Page = previousPage;
  }
});

test("review calendar rolls overdue questions into today and keeps completed history", () => {
  const today = new Date();
  today.setHours(10, 0, 0, 0);
  const yesterday = today.getTime() - 24 * 60 * 60 * 1000;
  const todayKey = dateKey(today.getTime());
  const questions = [
    { id: "q-overdue", subjectId: "modern-chinese", stem: "逾期题" },
    { id: "q-completed", subjectId: "classical-chinese", stem: "已完成题" },
  ];
  const history = [{ questionId: "q-completed", dateKey: todayKey, question: questions[1], status: "mastered", updatedAt: today.getTime() }];
  const pending = buildCalendarReviewItems({
    officialQuestions: questions,
    reviewStates: {
      "q-overdue": { questionId: "q-overdue", stage: 1, nextReviewAt: yesterday, removedManually: false },
      "q-completed": { questionId: "q-completed", stage: 2, nextReviewAt: today.getTime(), removedManually: false },
    },
    reviewHistory: history,
    selectedDate: todayKey,
  });
  assert.deepEqual(pending.map((item) => item.id), ["q-overdue"]);
  assert.equal(pending[0].overdue, true);
  const completed = buildCalendarCompletedItems({ officialQuestions: questions, reviewHistory: history, selectedDate: todayKey });
  assert.deepEqual(completed.map((item) => item.id), ["q-completed"]);
  assert.equal(completed[0].status, "mastered");
});
