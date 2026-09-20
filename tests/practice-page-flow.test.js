const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// 本地演示题库自带的章节 id（data/catalog.js）。生产环境的目录来自
// /api/catalog/textbooks/:bookId，这里用同一套 id 造一份已确认目录当夹具，
// 让测试走"缓存目录 → 目录构建 → 锚点投影"的真实路径。
const demoCatalogFixture = [
  { id: "introduction", title: "绪论", sections: [["introduction-common-language", "现代汉民族共同语"]] },
  { id: "phonetics", title: "第一章 语音", sections: [["phonetics-tone", "第四节 声调"], ["phonetics-consonants", "第二节 辅音和声母"], ["phonetics-syllable", "第五节 音节"]] },
  { id: "characters", title: "第二章 文字", sections: [["characters-form", "第一节 汉字的形体"], ["characters-structure", "第二节 汉字的结构"]] },
  { id: "vocabulary", title: "第三章 词汇", sections: [["vocabulary-word", "第一节 词汇和词的结构"], ["vocabulary-compound", "第二节 词义和词的构成"]] },
  { id: "grammar", title: "第四章 语法", sections: [["grammar-units", "第一节 语法单位和句法成分"], ["grammar-sentence", "第四节 句法成分和句型"]] },
];
const confirmedCatalogFixture = (() => {
  const nodes = [];
  demoCatalogFixture.forEach((chapter, chapterIndex) => {
    const startPage = chapterIndex * 10 + 1;
    const endPage = startPage + 9;
    nodes.push({ id: chapter.id, order: nodes.length + 1, level: 1, title: chapter.title, startPage, endPage, knowledgePoints: [] });
    chapter.sections.forEach(([id, title]) => {
      nodes.push({ id, order: nodes.length + 1, level: 2, title, startPage, endPage, knowledgePoints: [] });
    });
  });
  return { bookId: "", version: 1, nodes };
})();

test("practice page keeps answers, scores subjective work and submits an exam", async () => {
  let definition;
  const store = new Map();
  const toastTitles = [];
  const app = {
    globalData: { aiCredits: 20 },
    spendAiCredit(amount) {
      if (this.globalData.aiCredits < amount) return false;
      this.globalData.aiCredits -= amount;
      return true;
    },
  };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    getWindowInfo: () => ({
      windowWidth: 390,
      windowHeight: 844,
      statusBarHeight: 44,
      safeArea: { bottom: 810 },
    }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    setKeepScreenOn() {},
    vibrateShort() {},
    showToast({ title }) { toastTitles.push(title); },
    showModal({ success }) { if (success) success({ confirm: true }); },
    navigateTo() {},
    navigateBack() {},
    redirectTo() {},
    switchTab() {},
  };

  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };

  page.onLoad({});
  assert.equal(page.data.questionQueue.length, 11);
  // 没有任何已确认目录时（纯本地演示），目录只呈现"待归组"，不再有硬编码的旧目录。
  assert.deepEqual(page.data.catalogChapters.map((chapter) => chapter.id), ["catalog-unassigned"]);
  // 注入一份已确认目录（真实环境由 /api/catalog/textbooks/:bookId 提供），后续按它组织目录。
  page.applyConfirmedCatalog(confirmedCatalogFixture, page._questionBank);
  assert.equal(page.data.catalogChapters.length, 5);
  assert.equal(page.data.catalogChapters.every((chapter) => chapter.questionCount > 0), true);
  page.updateSearchQuery({ detail: { value: "声母 b 和 p" } });
  page.runQuestionSearch();
  assert.deepEqual(page.data.searchResults.map((item) => item.id), ["demo-modern-chinese-003"]);
  page.selectSearchResult({ currentTarget: { dataset: { questionId: "demo-modern-chinese-003" } } });
  assert.equal(page.data.question.id, "demo-modern-chinese-003");
  assert.equal(page.data.searchOpen, false);
  page.clearQuestionSearch();
  assert.equal(page.data.searchQuery, "");
  assert.deepEqual(page.data.searchResults, []);
  page.loadQuestion(0);
  assert.equal(page.data.question.frequencyLabel, "");
  assert.equal(page.data.question.difficultyLabel, "★★★");
  assert.equal(page.data.catalogChapters.find((chapter) => chapter.id === "introduction").questionCount, 2);
  assert.equal(
    page.data.catalogChapters
      .find((chapter) => chapter.id === "introduction")
      .sections.find((section) => section.id === "introduction-common-language").questionCount,
    2,
  );
  page.collapseAllCatalog();
  assert.equal(page.data.catalogChapters.every((chapter) => chapter.expanded === false), true);
  page.selectCatalogChapter({ currentTarget: { dataset: { id: "phonetics" } } });
  assert.equal(page.data.catalogView, "summary");
  assert.equal(page.data.catalogSummaryQuestions.length, 3);
  assert.equal(page.data.question.chapterId, "introduction");
  page.selectCatalogQuestion({
    currentTarget: { dataset: { questionId: "demo-modern-chinese-003" } },
  });
  assert.equal(page.data.question.id, "demo-modern-chinese-003");
  assert.equal(page.data.questionQueue.length, 3);

  page.openCatalog();
  page.selectCatalogItem({
    currentTarget: {
      dataset: { id: "grammar-sentence", title: "第四节 句法成分和句型" },
    },
  });
  assert.equal(page.data.catalogSummaryQuestions.length, 1);
  page.selectCatalogQuestion({
    currentTarget: { dataset: { questionId: "demo-modern-chinese-010" } },
  });
  assert.equal(page.data.question.id, "demo-modern-chinese-010");
  page.setData({
    questionQueue: page._questionBank,
  });
  page._practiceScopeQuestionIds = page._questionBank.map((question) => question.id);
  page.loadQuestion(0);
  page.chooseOption({ currentTarget: { dataset: { key: "A" } } });
  page.submitAnswer();
  assert.equal(page.data.isCorrect, true);
  const correctQuestionId = page.data.question.id;
  assert.equal(store.get("shukao_review_states")[page.data.question.id].lastIsCorrect, true);
  assert.equal(store.get("shukao_attempts")[0].question.stem, page.data.question.stem);

  page.setMastery({ currentTarget: { dataset: { value: "fuzzy" } } });
  clearTimeout(page.masteryAdvanceTimer);
  assert.equal(store.get("shukao_review_states")[page.data.question.id].masteryStatus, "fuzzy");
  page.setData({ advancing: false });

  page.loadQuestion(1);
  const wrongKey = page.data.question.options.find((option) => !page.data.question.correctAnswer.includes(option.key)).key;
  page.chooseOption({ currentTarget: { dataset: { key: wrongKey } } });
  page.submitAnswer();
  assert.equal(page.data.isCorrect, false);
  const wrongQuestionId = page.data.question.id;
  assert.equal(page.data.mastery, "unknown");
  assert.equal(store.get("shukao_review_states")[page.data.question.id].masteryStatus, "unknown");
  assert.equal(store.get("shukao_review_states")[page.data.question.id].stage, 0);
  page.setMastery({ currentTarget: { dataset: { value: "familiar" } } });
  assert.equal(store.get("shukao_review_states")[page.data.question.id].masteryStatus, "unknown");

  const privateReviewQuestion = {
    ...structuredClone(page.data.question),
    id: "private-review-question",
    stem: "私人题包中的复习题",
  };
  const attemptsWithPrivateQuestion = store.get("shukao_attempts").concat({
    questionId: privateReviewQuestion.id,
    isCorrect: false,
    question: privateReviewQuestion,
  });
  store.set("shukao_attempts", attemptsWithPrivateQuestion);
  store.set("shukao_active_review_ids", [correctQuestionId, wrongQuestionId, privateReviewQuestion.id]);
  store.set(`shukao_mastery_${correctQuestionId}`, "familiar");

  const reviewPage = { ...definition, data: structuredClone(definition.data) };
  reviewPage.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  reviewPage.onLoad({ mode: "review" });
  assert.equal(reviewPage.data.questionQueue.length, 3);
  assert.equal(reviewPage.data.questionQueue.some((question) => question.id === privateReviewQuestion.id), true);
  assert.deepEqual(reviewPage.data.responses, {});
  assert.equal(reviewPage.data.selected, "");
  assert.equal(reviewPage.data.submitted, false);
  assert.equal(reviewPage.data.mastery, "");
  assert.equal(reviewPage.data.answerStatus, "");
  assert.equal(reviewPage.data.subjectiveScoreResult, null);

  reviewPage.handleQuestionSwipeStart({
    touches: [{ clientX: 320, clientY: 300 }],
    target: { dataset: {} },
  });
  reviewPage.handleQuestionSwipeMove({ touches: [{ clientX: 250, clientY: 304 }] });
  assert.equal(reviewPage.data.questionSwipeHint, "next");
  assert.equal(reviewPage.data.questionSwipeOffset < 0, true);
  reviewPage.handleQuestionSwipeEnd({ changedTouches: [{ clientX: 220, clientY: 305 }] });
  await new Promise((resolve) => setTimeout(resolve, 430));
  assert.equal(reviewPage.data.currentQuestionIndex, 1);
  assert.equal(reviewPage.data.questionSwipeOffset, 0);
  assert.equal(reviewPage.data.questionSwipeOpacity, 1);
  assert.equal(reviewPage.data.questionSwipeAnimating, false);

  reviewPage.handleQuestionSwipeStart({
    touches: [{ clientX: 90, clientY: 300 }],
    target: { dataset: {} },
  });
  reviewPage.handleQuestionSwipeEnd({ changedTouches: [{ clientX: 190, clientY: 295 }] });
  await new Promise((resolve) => setTimeout(resolve, 430));
  assert.equal(reviewPage.data.currentQuestionIndex, 0);

  reviewPage.handleQuestionSwipeStart({
    touches: [{ clientX: 300, clientY: 200 }],
    target: { dataset: {} },
  });
  reviewPage.handleQuestionSwipeEnd({ changedTouches: [{ clientX: 270, clientY: 330 }] });
  assert.equal(reviewPage.data.currentQuestionIndex, 0);

  reviewPage.handleQuestionSwipeStart({
    touches: [{ clientX: 300, clientY: 200 }],
    target: { dataset: { swipeBlock: true } },
  });
  reviewPage.handleQuestionSwipeEnd({ changedTouches: [{ clientX: 200, clientY: 205 }] });
  assert.equal(reviewPage.data.currentQuestionIndex, 0);

  reviewPage.chooseOption({
    currentTarget: { dataset: { key: reviewPage.data.question.correctAnswer[0] } },
  });
  reviewPage.submitAnswer();
  assert.equal(reviewPage.data.isCorrect, true);
  assert.equal(reviewPage.data.mastery, "");
  reviewPage.handleQuestionSwipeStart({
    touches: [{ clientX: 320, clientY: 300 }],
    target: { dataset: {} },
  });
  reviewPage.handleQuestionSwipeEnd({ changedTouches: [{ clientX: 220, clientY: 305 }] });
  assert.equal(reviewPage.data.currentQuestionIndex, 0);
  assert.equal(toastTitles.at(-1), "请先选择掌握程度");

  reviewPage.setMastery({ currentTarget: { dataset: { value: "familiar" } } });
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(reviewPage.data.currentQuestionIndex, 1);
  assert.equal(reviewPage.data.selected, "");
  assert.equal(reviewPage.data.submitted, false);
  assert.equal(reviewPage.data.mastery, "");

  const latestCorrectKey = reviewPage.data.question.correctAnswer[0];
  reviewPage.chooseOption({ currentTarget: { dataset: { key: latestCorrectKey } } });
  reviewPage.submitAnswer();
  assert.equal(reviewPage.data.isCorrect, true);
  reviewPage.setMastery({ currentTarget: { dataset: { value: "familiar" } } });
  clearTimeout(reviewPage.masteryAdvanceTimer);
  assert.equal(reviewPage.data.mastery, "familiar");
  assert.equal(store.get("shukao_review_history").length, 2);
  assert.equal(store.get("shukao_review_history")[0].status, "mastered");

  store.set("shukao_book_practice_progress", {
    [reviewPage.data.activeBookId]: { questionId: wrongQuestionId, updatedAt: Date.now() },
  });

  const bankPage = { ...definition, data: structuredClone(definition.data) };
  bankPage.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  bankPage.onLoad({ resume: "1" });
  assert.equal(bankPage.data.question.id, wrongQuestionId);
  assert.equal(bankPage.data.selected, latestCorrectKey);
  assert.equal(bankPage.data.submitted, true);
  assert.equal(bankPage.data.isCorrect, true);
  assert.equal(bankPage.data.mastery, "familiar");
  assert.equal(bankPage.data.answerStatus, "correct");
  assert.equal(bankPage.data.subjectiveScoreResult, null);

  page.loadQuestion(1);
  assert.equal(page.data.question.number, 2);
  page.loadQuestion(0);
  assert.equal(page.data.selected, "A");
  assert.equal(page.data.submitted, true);

  page.openUtilityPanel({ currentTarget: { dataset: { panel: "mode" } } });
  page.selectTrainingMode({ currentTarget: { dataset: { mode: "chapter" } } });
  assert.equal(page.data.modePanelView, "chapters");
  assert.equal(page.data.chapterPickerIndex, 0);
  const phoneticsIndex = page.data.chapterPickerOptions.findIndex((item) => item.id === "phonetics");
  page.changeChapterPicker({ detail: { value: phoneticsIndex } });
  assert.equal(page.data.sectionPickerIndex, 0);
  const consonantIndex = page.data.sectionPickerOptions.findIndex((item) => item.id === "phonetics-consonants");
  page.changeSectionPicker({ detail: { value: consonantIndex } });
  assert.equal(page.data.headingPickerIndex, 0);
  page.confirmChapterPicker();
  assert.equal(page.data.trainingScope, "chapter");
  assert.equal(page.data.selectedChapterScopeId, "phonetics-consonants");
  assert.equal(page.data.questionQueue.length, 1);
  assert.equal(page.data.practiceScopeTitle, "第二节 辅音和声母");

  page.openUtilityPanel({ currentTarget: { dataset: { panel: "mode" } } });
  page.selectTrainingMode({ currentTarget: { dataset: { mode: "type" } } });
  assert.equal(page.data.modePanelView, "types");
  assert.equal(
    page.data.questionTypeOptions.find((item) => item.type === "single_choice").count,
    10,
  );
  assert.equal(
    page.data.questionTypeOptions.find((item) => item.type === "short_answer").count,
    1,
  );
  page.selectQuestionType({ currentTarget: { dataset: { type: "single_choice" } } });
  assert.equal(page.data.trainingScope, "type");
  assert.equal(page.data.selectedQuestionType, "single_choice");
  assert.equal(page.data.questionQueue.length, 10);

  page.selectTrainingMode({ currentTarget: { dataset: { mode: "memorize" } } });
  assert.equal(page.data.practiceMode, "memorize");
  assert.equal(page.data.submitted, true);

  page.setData({
    practiceMode: "normal",
    questionQueue: page._questionBank,
  });
  page._practiceScopeQuestionIds = page._questionBank.map((question) => question.id);
  page.loadQuestion(10);
  assert.equal(page.data.question.answerMode, "text");
  page.updateSubjectiveAnswer({
    detail: {
      value: "现代汉民族共同语即普通话，以北京语音为标准音，以北方话为基础方言，以典范的现代白话文著作为语法规范。",
    },
  });
  page.submitAnswer();
  assert.equal(page.data.submitted, true);
  assert.equal(page.data.subjectiveScoring, false);
  assert.equal(page.data.subjectiveScoreResult, null);
  assert.equal(app.globalData.aiCredits, 20);
  page.requestInitialSubjectiveScore();
  assert.equal(page.data.subjectiveScoring, true);
  assert.equal(page.data.subjectiveScoringStage, "正在核对得分点");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(page.data.subjectiveScoreResult.totalScore, 10);
  assert.equal(page.data.subjectiveScoreResult.hitPoints.length, 4);
  assert.equal(page.data.subjectiveScoringStage, "");
  assert.equal(app.globalData.aiCredits, 20);
  page.setMastery({ currentTarget: { dataset: { value: "familiar" } } });
  clearTimeout(page.masteryAdvanceTimer);
  page.setData({ advancing: false });

  store.set("shukao_book_practice_progress", {
    [page.data.activeBookId]: { questionId: page.data.question.id, updatedAt: Date.now() },
  });
  const scoredBankPage = { ...definition, data: structuredClone(definition.data) };
  scoredBankPage.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  scoredBankPage.onLoad({ resume: "1" });
  assert.equal(scoredBankPage.data.question.id, page.data.question.id);
  assert.equal(scoredBankPage.data.subjectiveAnswer, page.data.subjectiveAnswer);
  assert.equal(scoredBankPage.data.submitted, true);
  assert.equal(scoredBankPage.data.isCorrect, true);
  assert.equal(scoredBankPage.data.mastery, "familiar");
  assert.equal(scoredBankPage.data.subjectiveScoreResult.totalScore, 10);

  page.rateSubjectiveScore({ currentTarget: { dataset: { value: "helpful" } } });
  assert.equal(page.data.subjectiveScoreFeedback, "helpful");
  page.requestSubjectiveRescore();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(app.globalData.aiCredits, 20);
  assert.equal(store.get("shukao_subjective_score_history").length, 2);

  page.requestAiExplanation();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.match(page.data.aiContent, /现代汉民族共同语/);
  assert.equal(page.data.aiMessages.length, 1);
  assert.equal(app.globalData.aiCredits, 19);
  page.setData({ aiInput: "三项规范分别是什么？" });
  page.sendAiFollowUp();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(page.data.aiMessages.length, 3);
  assert.equal(page.data.aiMessages[1].role, "user");
  assert.equal(page.data.aiMessages[2].role, "assistant");
  assert.equal(app.globalData.aiCredits, 18);

  const legacySubjectiveQuestionId = page.data.question.id;
  page.setData({
    responses: {
      ...page.data.responses,
      [legacySubjectiveQuestionId]: {
        subjectiveAnswer: page.data.subjectiveAnswer,
        submitted: true,
        isCorrect: true,
        mastery: "familiar",
      },
    },
  });
  page.loadQuestion(page.data.currentQuestionIndex);
  assert.equal(page.data.subjectiveScoreResult, null);
  assert.equal(page.data.isCorrect, false);
  assert.equal(page.data.mastery, "familiar");
  page.setData({ advancing: false });
  page.setMastery({ currentTarget: { dataset: { value: "familiar" } } });
  clearTimeout(page.masteryAdvanceTimer);
  assert.equal(store.get("shukao_review_states")[legacySubjectiveQuestionId].lastIsCorrect, true);
  assert.equal(store.get("shukao_review_states")[legacySubjectiveQuestionId].masteryStatus, "familiar");

  page.setData({ practiceMode: "exam", examFinished: false, responses: {} });
  page.loadQuestion(0);
  page.chooseOption({ currentTarget: { dataset: { key: "A" } } });
  page.submitExam();
  assert.equal(page.data.examFinished, true);
  assert.equal(page.data.examResult.correctCount, 1);

  const annotationQuestion = {
    ...page.data.question,
    id: "annotation-test",
    answerMode: "text",
    responseMode: "annotation",
    annotationText: "小王认真学习。",
  };
  page.setData({
    question: annotationQuestion,
    questionQueue: [annotationQuestion],
    responses: {},
    currentQuestionIndex: 0,
    submitted: false,
    subjectiveScoring: false,
    annotationTool: "underline",
    annotationNote: "",
    annotationTokens: Array.from(annotationQuestion.annotationText).map((character, index) => ({ id: `mark-${index}`, character, mark: "", symbol: "" })),
  });
  page.markAnnotationCharacter({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.annotationTokens[0].mark, "underline");
  assert.match(page.data.subjectiveAnswer, /下划线：小/);
  page.selectAnnotationTool({ currentTarget: { dataset: { tool: "dot" } } });
  page.markAnnotationCharacter({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.annotationTokens[1].symbol, "•");
  assert.match(page.data.subjectiveAnswer, /着重号：王/);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("practice page renders Markdown nodes while receiving real UTF-8 stream chunks", async () => {
  let definition;
  const store = new Map();
  const app = {
    globalData: { aiCredits: 3, apiBaseUrl: "http://stream.test" },
    spendAiCredit(amount) {
      if (this.globalData.aiCredits < amount) return false;
      this.globalData.aiCredits -= amount;
      return true;
    },
  };
  const encoder = new TextEncoder();
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    getWindowInfo: () => ({
      windowWidth: 390,
      windowHeight: 844,
      statusBarHeight: 44,
      safeArea: { bottom: 810 },
    }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    setKeepScreenOn() {},
    showToast() {},
    canIUse: () => false,
    request(options) {
      let chunkHandler = null;
      let aborted = false;
      const task = {
        abort() { aborted = true; },
        onChunkReceived(handler) { chunkHandler = handler; },
      };
      const emit = (event) => {
        if (aborted || !chunkHandler) return;
        const bytes = encoder.encode(`${JSON.stringify(event)}\n`);
        for (let index = 0; index < bytes.length; index += 7) {
          const part = bytes.slice(index, index + 7);
          chunkHandler({ data: part.buffer });
        }
      };
      setTimeout(() => {
        emit({ type: "meta", requestId: "stream-client-test", model: "test-model" });
        emit({ type: "delta", text: "## 核心判断\n\n- 第一项" });
      }, 5);
      setTimeout(() => emit({ type: "delta", text: "\n- **第二项**。" }), 35);
      setTimeout(() => {
        emit({ type: "done", chargeable: true, model: "test-model", usage: { total_tokens: 12 } });
        options.success({ statusCode: 200, data: "" });
      }, 65);
      return task;
    },
  };

  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({});
  page.requestAiExplanation();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.data.aiGenerating, true);
  assert.equal(page.data.aiMessages[0].text, "## 核心判断\n\n- 第一项");
  assert.equal(app.globalData.aiCredits, 3);

  await new Promise((resolve) => setTimeout(resolve, 80));
  const reply = page.data.aiMessages[0];
  assert.equal(page.data.aiGenerating, false);
  assert.equal(reply.text, "## 核心判断\n\n- 第一项\n- **第二项**。");
  assert.deepEqual(reply.nodes.map((node) => node.name), ["h3", "ul"]);
  assert.equal(reply.nodes[1].children[1].children[0].name, "strong");
  assert.equal(app.globalData.aiCredits, 2);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("practice waits for its first question session and does not replace a cached session after refresh", () => {
  let definition;
  let questionSync;
  const store = new Map();
  const { demoQuestions } = require("../apps/miniprogram/data/catalog");
  const app = {
    globalData: { aiCredits: 0, officialQuestions: [] },
    syncOfficialQuestions(callback) { questionSync = callback; },
  };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    showToast() {},
    navigateBack() {},
  };

  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };

  page.onLoad({});
  assert.equal(page.data.practiceReady, false);
  questionSync(demoQuestions, { source: "cache", refreshing: true });
  assert.equal(page.data.practiceReady, true);
  assert.deepEqual(page.data.questionBank, []);
  assert.deepEqual(page.data.trainingPoolQuestions, []);
  assert.deepEqual(page.data.practiceScopeQuestionIds, []);
  assert.equal(page._questionBank.length, demoQuestions.length);
  assert.equal(page._trainingPoolQuestions.length, demoQuestions.length);
  const cachedQuestionIds = page.data.questionQueue.map((question) => question.id);
  const cachedCurrentQuestionId = page.data.question.id;

  questionSync([{ ...demoQuestions[0], id: "server-replacement" }], { source: "server" });
  assert.deepEqual(page.data.questionQueue.map((question) => question.id), cachedQuestionIds);
  assert.equal(page.data.question.id, cachedCurrentQuestionId);

  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/practice/practice.wxml"), "utf8");
  assert.match(markup, /class="practice-page" wx:if="\{\{practiceReady\}\}"/);
  assert.match(markup, /wx:else class="practice-loading"/);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
