const test = require("node:test");
const assert = require("node:assert/strict");

function createPage(definition) {
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

test("exam page lists published past papers and starts the selected exam", () => {
  let definition;
  let navigatedUrl = "";
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://exam.test" } });
  global.wx = {
    request(options) {
      options.success({
        statusCode: 200,
        data: {
          exams: [
            { id: "past-2025", title: "2025 年汉语言文学学科基础", kind: "past_paper", year: 2025, questionCount: 57, durationMinutes: 150, totalScore: 200 },
            { id: "mock-1", title: "平台模拟卷", kind: "official_mock", year: 2026, questionCount: 60, durationMinutes: 120, totalScore: 100 },
          ],
        },
      });
    },
    showModal({ success }) { success({ confirm: true }); },
    showToast() {},
    navigateTo({ url }) { navigatedUrl = url; },
  };

  const pagePath = require.resolve("../apps/miniprogram/pages/exams/exams.js");
  delete require.cache[pagePath];
  require(pagePath);
  const page = createPage(definition);
  page.onLoad();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.activeTab, "past");
  assert.deepEqual(page.data.currentExams.map((exam) => exam.id), ["past-2025"]);
  page.startExam({ currentTarget: { dataset: { id: "past-2025" } } });
  assert.equal(navigatedUrl, "/pages/practice/practice?mode=exam&count=57&duration=150&examId=past-2025");

  page.selectTab({ currentTarget: { dataset: { key: "official" } } });
  assert.deepEqual(page.data.currentExams.map((exam) => exam.id), ["mock-1"]);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("custom exam scope buttons select a real subject or textbook and pass the filter", () => {
  let definition;
  let navigatedUrl = "";
  const officialQuestions = [
    { id: "m1", subjectId: "modern-chinese", bookId: "modern-chinese-7-1" },
    { id: "m2", subjectId: "modern-chinese", bookId: "modern-chinese-7-2" },
    { id: "c1", subjectId: "classical-chinese", bookId: "classical-chinese-1" },
  ];
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://exam.test", officialQuestions } });
  global.wx = {
    request(options) { options.success({ statusCode: 200, data: { exams: [] } }); },
    showModal({ success }) { success({ confirm: true }); },
    showToast() {},
    navigateTo({ url }) { navigatedUrl = url; },
  };

  const pagePath = require.resolve("../apps/miniprogram/pages/exams/exams.js");
  delete require.cache[pagePath];
  require(pagePath);
  const page = createPage(definition);
  page.onLoad();
  page.selectTab({ currentTarget: { dataset: { key: "custom" } } });

  page.selectCustomSubject({ detail: { value: 0 } });
  assert.equal(page.data.customScope, "subject");
  assert.equal(page.data.customScopeLabel, "现代汉语");
  assert.equal(page.data.customAvailableCount, 2);
  page.startExam({ currentTarget: { dataset: {} } });
  assert.equal(navigatedUrl, "/pages/practice/practice?mode=exam&count=2&duration=30&subjectId=modern-chinese&scopeTitle=%E7%8E%B0%E4%BB%A3%E6%B1%89%E8%AF%AD%20%C2%B7%20%E8%87%AA%E5%AE%9A%E4%B9%89%E8%AF%95%E5%8D%B7");

  page.selectCustomBook({ detail: { value: 2 } });
  assert.equal(page.data.customScope, "book");
  assert.equal(page.data.customScopeId, "classical-chinese-1");
  assert.equal(page.data.customAvailableCount, 1);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("published exam detail keeps subjective questions in the exam queue", () => {
  let definition;
  const store = new Map();
  const questions = [
    {
      id: "choice-1",
      type: "single_choice",
      typeLabel: "单选题",
      answerMode: "choice",
      stem: "选择正确选项。",
      options: [{ key: "A", text: "正确" }, { key: "B", text: "错误" }],
      correctAnswer: ["A"],
      referenceAnswer: "A",
      score: 2,
      maxScore: 2,
      bookId: "modern-chinese-7-1",
      chapterId: "第一章",
      sectionId: "第一节",
      knowledgePoint: "测试知识点",
    },
    {
      id: "essay-1",
      type: "short_answer",
      typeLabel: "简答题",
      answerMode: "text",
      stem: "简述相关特点。",
      correctAnswer: [],
      referenceAnswer: "参考答案",
      scoringPoints: [{ description: "答出要点", score: 8 }],
      score: 8,
      maxScore: 8,
      bookId: "modern-chinese-7-1",
      chapterId: "第一章",
      sectionId: "第一节",
      knowledgePoint: "测试知识点",
    },
  ];
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://exam.test", beans: 2 } });
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    setKeepScreenOn() {},
    showToast() {},
    navigateBack() {},
    request(options) {
      if (options.url.includes("/api/exams/exam-1")) {
        options.success({ statusCode: 200, data: { exam: { id: "exam-1", title: "综合真题", durationMinutes: 150 }, questions } });
      } else {
        options.success({ statusCode: 404, data: {} });
      }
    },
  };

  const pagePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[pagePath];
  require(pagePath);
  const page = createPage(definition);
  page.onLoad({ mode: "exam", examId: "exam-1" });

  assert.equal(page.data.practiceMode, "exam");
  assert.equal(page.data.practiceScopeTitle, "综合真题");
  // C17（F1）：视图层队列只有 id 序列，完整题目（含 answerMode）在页面实例的 _questionQueue 上。
  assert.deepEqual(page.data.questionQueue.map((question) => question.id), ["choice-1", "essay-1"]);
  assert.equal(page._questionQueue[1].answerMode, "text");
  if (page.examTimer) clearInterval(page.examTimer);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
