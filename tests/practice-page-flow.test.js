const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { applyDataPatch } = require("./helpers/set-data");

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
    globalData: { beans: 2 },
    spendBeans(amount) {
      if (this.globalData.beans < amount) return false;
      this.globalData.beans = Math.round((this.globalData.beans - amount) * 10) / 10;
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
    applyDataPatch(this.data, patch);
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
  // C17（F1）：题目队列的完整数据在页面实例上（视图层只拿 id 序列），
  // 这里走真实的「切到顺序刷题」路径把整库设为当前队列，而不是直接改 data。
  page._practiceScopeQuestionIds = page._questionBank.map((question) => question.id);
  page.selectTrainingMode({ currentTarget: { dataset: { mode: "sequential" } } });
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
    type: "appreciation",
    typeLabel: "作品赏析题",
    answerMode: "text",
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
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  reviewPage.onLoad({ mode: "review" });
  assert.equal(reviewPage.data.questionQueue.length, 3);
  assert.equal(reviewPage.data.questionQueue.some((question) => question.id === privateReviewQuestion.id), true);
  const legacyReview = reviewPage._questionBank.find((question) => question.id === privateReviewQuestion.id);
  assert.equal(legacyReview.type, "material_analysis");
  assert.equal(legacyReview.typeLabel, "材料分析题");
  assert.equal(reviewPage.data.questionTypeOptions.some((option) => option.type === "appreciation"), false);
  assert.equal(reviewPage.data.questionTypeOptions.find((option) => option.type === "material_analysis").count, 1);
  assert.equal(store.get("shukao_attempts").find((attempt) => attempt.questionId === privateReviewQuestion.id).question.type, "appreciation");
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
    applyDataPatch(this.data, patch);
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

  page.setData({ practiceMode: "normal" });
  page._practiceScopeQuestionIds = page._questionBank.map((question) => question.id);
  page.selectTrainingMode({ currentTarget: { dataset: { mode: "sequential" } } });
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
  assert.equal(app.globalData.beans, 2);
  page.requestInitialSubjectiveScore();
  assert.equal(page.data.subjectiveScoring, true);
  assert.equal(page.data.subjectiveScoringStage, "正在核对得分点");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(page.data.subjectiveScoreResult.totalScore, 10);
  assert.equal(page.data.subjectiveScoreResult.hitPoints.length, 4);
  assert.equal(page.data.subjectiveScoringStage, "");
  assert.equal(app.globalData.beans, 2);
  page.setMastery({ currentTarget: { dataset: { value: "familiar" } } });
  clearTimeout(page.masteryAdvanceTimer);
  page.setData({ advancing: false });

  store.set("shukao_book_practice_progress", {
    [page.data.activeBookId]: { questionId: page.data.question.id, updatedAt: Date.now() },
  });
  const scoredBankPage = { ...definition, data: structuredClone(definition.data) };
  scoredBankPage.setData = function setData(patch, callback) {
    applyDataPatch(this.data, patch);
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
  assert.equal(app.globalData.beans, 2);
  assert.equal(store.get("shukao_subjective_score_history").length, 2);

  page.requestAiExplanation();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.match(page.data.aiContent, /现代汉民族共同语/);
  assert.equal(page.data.aiMessages.length, 1);
  assert.equal(app.globalData.beans, 1.9);
  page.setData({ aiInput: "三项规范分别是什么？" });
  page.sendAiFollowUp();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(page.data.aiMessages.length, 3);
  assert.equal(page.data.aiMessages[1].role, "user");
  assert.equal(page.data.aiMessages[2].role, "assistant");
  assert.equal(app.globalData.beans, 1.8);

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
  assert.equal(page.data.examResultOpen, true);
  assert.equal(page.data.examWrongItems.length, page._questionQueue.length - 1);
  assert.equal(page.data.examUnscoredItems.length, 0);
  assert.equal(page.data.examWrongItems[0].status, "未作答");
  page.reviewExamQuestion({ currentTarget: { dataset: { id: page.data.examWrongItems[0].id } } });
  assert.equal(page.data.examResultOpen, false);
  assert.equal(page.data.question.id, page._questionQueue[1].id);
  page.openExamResult();
  assert.equal(page.data.examResultOpen, true);
  page.closeExamResult();
  page.loadQuestion(page._questionQueue.length - 1);
  page.nextQuestion();
  assert.equal(page.data.examResultOpen, true);
  page.closeExamResult();
  const historyCount = store.get("shukao_exam_results").length;
  page.finishExam(false);
  assert.equal(store.get("shukao_exam_results").length, historyCount);
  page.setData({ examFinished: false, examResultOpen: false, responses: {} });
  page.submitExam({ auto: true });
  assert.equal(page.data.examResultOpen, true);
  assert.equal(page.data.examWrongItems.length, page._questionQueue.length);
  assert.equal(store.get("shukao_exam_results")[0].autoSubmitted, true);
  assert.equal(toastTitles.at(-1), "考试时间到，已自动交卷");

  // 作答方式已统一「文字作答」（2026-10-10 下线「原文标记」作答方式）：
  // 主观题只走文字作答框，不再有「点句标记」分支，且仍要求至少 10 个字才能提交。
  const textAnswerQuestion = {
    ...page.data.question,
    id: "text-answer-test",
    answerMode: "text",
  };
  page.setData({
    question: textAnswerQuestion,
    questionQueue: [textAnswerQuestion],
    responses: {},
    currentQuestionIndex: 0,
    submitted: false,
    subjectiveScoring: false,
    subjectiveAnswer: "太短",
  });
  page.submitSubjectiveAnswer();
  assert.equal(page.data.submitted, false);
  assert.equal(toastTitles.at(-1), "请至少填写 10 个字后提交");
  page.setData({ subjectiveAnswer: "现代汉民族共同语以北京语音为标准音。" });
  page.submitSubjectiveAnswer();
  assert.equal(page.data.submitted, true);
  assert.equal(page.data.responses[textAnswerQuestion.id].subjectiveAnswer, "现代汉民族共同语以北京语音为标准音。");

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("exam review distinguishes wrong, partial, unanswered and unscored subjective answers", () => {
  const { buildExamReviewItems } = require("../apps/miniprogram/pages/practice/practice");
  const questions = [
    { id: "correct", stem: "正确题", score: 2, correctAnswer: ["A"] },
    { id: "wrong", stem: "错误题", score: 2, correctAnswer: ["A"] },
    { id: "partial", stem: "部分得分题", score: 3, correctAnswer: ["A", "B"] },
    { id: "empty", stem: "未答题", score: 2, correctAnswer: ["C"] },
    { id: "subjective", stem: "主观题", answerMode: "text", score: 10 },
    { id: "optional", stem: "未计分题", score: 2, correctAnswer: ["A"] },
  ];
  const items = buildExamReviewItems(questions, {
    correct: { selected: "A", isCorrect: true, counted: true },
    wrong: { selected: "B", isCorrect: false, answerStatus: "wrong", counted: true },
    partial: { selected: ["A"], isCorrect: false, answerStatus: "partial", awardedScore: 1, counted: true },
    empty: { isCorrect: false, answerStatus: "empty", counted: true },
    subjective: { subjectiveAnswer: "作答内容", isCorrect: false, counted: true },
    optional: { selected: "B", isCorrect: false, counted: false },
  });
  assert.deepEqual(items.map((item) => [item.number, item.status, item.score]), [
    [2, "答错", 0],
    [3, "部分得分", 1],
    [4, "未作答", 0],
    [5, "未评分", 0],
  ]);
  assert.equal(items[0].answer, "你的答案：B");
  assert.equal(items[0].correctAnswer, "正确答案：A");
  assert.equal(items[3].correctAnswer, "");

  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/practice/practice.wxml"), "utf8");
  assert.match(markup, /wx:if="\{\{practiceMode === 'exam' && examResultOpen\}\}"/);
  assert.match(markup, /class="exam-score-value">\{\{examResult.score\}\}/);
  assert.match(markup, /wx:for="\{\{examWrongItems\}\}"[\s\S]*?bindtap="reviewExamQuestion"/);
  assert.match(markup, /wx:for="\{\{examUnscoredItems\}\}"[\s\S]*?bindtap="reviewExamQuestion"/);
  assert.match(markup, /<view\s+wx:for="\{\{examWrongItems\}\}"[\s\S]*?role="button"/);
  assert.match(markup, /<view\s+wx:for="\{\{examUnscoredItems\}\}"[\s\S]*?role="button"/);
  assert.match(markup, /class="exam-result-nav" style="height: \{\{navTotalHeight\}\}px; padding-top: \{\{statusBarHeight\}\}px;"/);
  assert.match(markup, /class="exam-result-back" bindtap="closeExamResult"[\s\S]*?role="button"/);
  assert.match(markup, /class="exam-result-nav-title" style="height: \{\{navContentHeight\}\}px; line-height: \{\{navContentHeight\}\}px;">考试成绩/);
  assert.match(markup, /<view class="primary-button exam-result-action" bindtap="closeExamResult"[\s\S]*?role="button"[\s\S]*?查看全部题目<\/view>/);
  assert.match(markup, /<view\s+wx:if="\{\{practiceMode === 'exam' && !examFinished\}\}"\s+class="primary-button exam-submit-action"\s+bindtap="submitExam"[\s\S]*?role="button"[\s\S]*?提前交卷<\/view>/);
  assert.equal((markup.match(/class="exam-review-list"/g) || []).length, 2);
  assert.match(markup, /bindtap="openExamResult">查看成绩/);
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/practice/practice.wxss"), "utf8");
  assert.match(styles, /\.exam-result-scroll \{[^}]*width: 100%;/);
  assert.match(styles, /\.exam-review-list \{[^}]*width: 100%;[^}]*padding: 0 20rpx;/);
  assert.match(styles, /\.exam-review-item \{[^}]*width: 100%;[^}]*border-radius: 16rpx;/);
  assert.match(styles, /\.exam-result-back \{[^}]*width: 88rpx;[^}]*height: 88rpx;/);
  assert.match(styles, /\.exam-result-nav-title \{[^}]*left: 50%;[^}]*transform: translateX\(-50%\);/);
  assert.match(styles, /\.exam-result-actions \{[^}]*align-items: center;[^}]*justify-content: center;/);
  assert.match(styles, /\.exam-result-action \{[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: center;[^}]*line-height: 1\.2;/);
  assert.match(styles, /\.exam-submit-action \{[^}]*display: flex;[^}]*height: 88rpx;[^}]*align-items: center;[^}]*justify-content: center;[^}]*line-height: 1\.2;/);
});

test("practice page renders Markdown nodes while receiving real UTF-8 stream chunks", async () => {
  let definition;
  const store = new Map();
  const app = {
    globalData: { beans: 0.3, apiBaseUrl: "http://stream.test" },
    spendBeans(amount) {
      if (this.globalData.beans < amount) return false;
      this.globalData.beans = Math.round((this.globalData.beans - amount) * 10) / 10;
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
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  page.onLoad({});
  page.requestAiExplanation();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.data.aiGenerating, true);
  assert.equal(page.data.aiMessages[0].text, "## 核心判断\n\n- 第一项");
  assert.equal(app.globalData.beans, 0.3);

  await new Promise((resolve) => setTimeout(resolve, 80));
  const reply = page.data.aiMessages[0];
  assert.equal(page.data.aiGenerating, false);
  assert.equal(reply.text, "## 核心判断\n\n- 第一项\n- **第二项**。");
  assert.deepEqual(reply.nodes.map((node) => node.name), ["h3", "ul"]);
  assert.equal(reply.nodes[1].children[1].children[0].name, "strong");
  assert.equal(app.globalData.beans, 0.2);

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
    globalData: { beans: 0, officialQuestions: [] },
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
    applyDataPatch(this.data, patch);
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

test("comprehensive practice roots the catalog at subjects, merges volumes and rebuilds on scope change", () => {
  // 综合训练是跨册题池：目录一级＝科目，二级＝同一科目各册顶层目录按册顺序拼接。
  // 这里用两科四册的已确认目录缓存 + 合成题目池，走 applyComprehensiveScope 的真实路径。
  let definition;
  const store = new Map();
  const toasts = [];
  const { demoQuestions: demo } = require("../apps/miniprogram/data/catalog");
  const app = {
    globalData: { beans: 2 },
    apiBaseUrlCandidates: () => [],
  };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    setKeepScreenOn() {},
    vibrateShort() {},
    showToast({ title }) { toasts.push(title); },
    showModal({ success }) { if (success) success({ confirm: true }); },
    navigateTo() {},
    navigateBack() {},
    redirectTo() {},
    switchTab() {},
  };

  const modernOne = {
    bookId: "modern-chinese-7-1",
    subjectId: "modern-chinese",
    version: 3,
    nodes: [
      { id: "m1-ch1", order: 1, level: 1, title: "第一章 语音", startPage: 1, endPage: 40, parentId: "" },
      { id: "m1-ch1-s1", order: 2, level: 2, title: "第一节 语音概说", startPage: 1, endPage: 10, parentId: "m1-ch1" },
    ],
  };
  const modernTwo = {
    bookId: "modern-chinese-7-2",
    subjectId: "modern-chinese",
    version: 2,
    nodes: [
      { id: "m2-ch4", order: 1, level: 1, title: "第四章 语法", startPage: 1, endPage: 40, parentId: "" },
      { id: "m2-ch4-s1", order: 2, level: 2, title: "第一节 语法概说", startPage: 1, endPage: 10, parentId: "m2-ch4" },
    ],
  };
  const classicalOne = {
    bookId: "classical-chinese-1",
    subjectId: "classical-chinese",
    version: 2,
    nodes: [
      { id: "a1-u1", order: 1, level: 1, title: "第一单元", startPage: 1, endPage: 40, parentId: "" },
      { id: "a1-u1-s1", order: 2, level: 2, title: "一、左传", startPage: 1, endPage: 10, parentId: "a1-u1" },
    ],
  };
  const classicalTwo = {
    bookId: "classical-chinese-2",
    subjectId: "classical-chinese",
    version: 2,
    nodes: [
      { id: "a2-u4", order: 1, level: 1, title: "第四单元", startPage: 1, endPage: 40, parentId: "" },
      { id: "a2-u4-s1", order: 2, level: 2, title: "一、战国策", startPage: 1, endPage: 10, parentId: "a2-u4" },
    ],
  };
  const modernLit = {
    bookId: "modern-literature-30-years-3",
    subjectId: "modern-literature",
    version: 1,
    nodes: [
      { id: "l1-b1", order: 1, level: 1, title: "第一编 第一个十年", startPage: 1, endPage: 40, parentId: "" },
      { id: "l1-b1-s1", order: 2, level: 2, title: "第一章 文学思潮与运动（一）", startPage: 1, endPage: 10, parentId: "l1-b1" },
    ],
  };
  store.set("shukao_confirmed_catalog_modern-chinese-7-1", modernOne);
  store.set("shukao_confirmed_catalog_modern-chinese-7-2", modernTwo);
  store.set("shukao_confirmed_catalog_classical-chinese-1", classicalOne);
  store.set("shukao_confirmed_catalog_classical-chinese-2", classicalTwo);
  store.set("shukao_confirmed_catalog_modern-literature-30-years-3", modernLit);

  const pool = [
    { ...demo[0], id: "q-m1-1", bookId: "modern-chinese-7-1", subjectId: "modern-chinese", difficultyStars: 3, catalogProjection: { anchorNodeIds: ["m1-ch1-s1"] } },
    { ...demo[0], id: "q-m2-1", bookId: "modern-chinese-7-2", subjectId: "modern-chinese", difficultyStars: 3, catalogProjection: { anchorNodeIds: ["m2-ch4-s1"] } },
    { ...demo[0], id: "q-a1-1", bookId: "classical-chinese-1", subjectId: "classical-chinese", difficultyStars: 4, catalogProjection: { anchorNodeIds: ["a1-u1-s1"] } },
    { ...demo[0], id: "q-a2-1", bookId: "classical-chinese-2", subjectId: "classical-chinese", difficultyStars: 4, catalogProjection: { anchorNodeIds: ["a2-u4-s1"] } },
    // 这一科还没有任何题目形成目录投影（真实数据里中国现代文学/当代文学的现状）：科目行必须留住，
    // 题数如实显示 0，并把这一科的未投影题数单独算在「待归组」计数里。
    { ...demo[0], id: "q-l1-1", bookId: "modern-literature-30-years-3", subjectId: "modern-literature", difficultyStars: 3, catalogProjection: { anchorNodeIds: [] } },
  ];

  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };

  page.onLoad({});
  assert.equal(page._catalogScopeMode, "book");
  page._trainingPoolQuestions = pool;
  page.data.selectedScopeSubjectIds = [];
  page.data.selectedScopeBookIds = [];
  page.data.selectedDifficultyStars = [];
  page.applyComprehensiveScope();

  assert.equal(page.data.trainingScope, "comprehensive");
  assert.equal(page._catalogScopeMode, "subjects");
  assert.deepEqual(page._questionBank.map((question) => question.id), ["q-m1-1", "q-m2-1", "q-a1-1", "q-a2-1", "q-l1-1"]);
  // 一级＝科目（本地科目常数顺序），且**三科都留住**——中国现代文学这一科还没有题目形成目录投影，
  // 科目行不能消失（产品负责人 2026-09-23 选定的 C 方案），只把它的题数如实显示为 0、
  // 未投影题数单独记为「待归组」。二级往下仍只保留有题的分支。
  assert.deepEqual(
    page.data.catalogChapters.map((chapter) => chapter.id),
    ["subject:modern-chinese", "subject:classical-chinese", "subject:modern-literature", "catalog-unassigned"],
  );
  const modern = page.data.catalogChapters[0];
  assert.equal(modern.title, "现代汉语");
  assert.equal(modern.isSubject, true);
  assert.equal(modern.level, 1);
  // C17（F2）：视图层目录只拿展示字段（问题 id 序列不再跨桥）；投影锚点在实例里的完整目录树上。
  assert.equal(Object.prototype.hasOwnProperty.call(modern, "questionIds"), false);
  assert.deepEqual(page._catalogChapters[0].questionIds, ["q-m1-1", "q-m2-1"]);
  assert.equal(modern.pendingCount, 0);
  // 二级＝同一科目两册的顶层目录按册顺序拼接（不标册名）。
  assert.deepEqual(
    modern.sections.filter((section) => section.level === 2).map((section) => section.title),
    ["第一章 语音", "第四章 语法"],
  );
  const classical = page.data.catalogChapters[1];
  assert.equal(classical.title, "古代汉语");
  assert.deepEqual(
    classical.sections.filter((section) => section.level === 2).map((section) => section.title),
    ["第一单元", "第四单元"],
  );
  assert.deepEqual(page._catalogChapters[1].questionIds, ["q-a1-1", "q-a2-1"]);
  // 空科目：行在、题数 0、待归组计数单独给，且不展开（没有任何可导航的下级）。
  const emptySubject = page.data.catalogChapters[2];
  assert.equal(emptySubject.title, "中国现代文学");
  assert.equal(emptySubject.isSubject, true);
  assert.equal(emptySubject.questionCount, 0);
  assert.equal(emptySubject.pendingCount, 1);
  assert.deepEqual(emptySubject.sections, []);
  assert.equal(emptySubject.expanded, false);
  assert.equal(page.data.catalogChapters[3].id, "catalog-unassigned");
  assert.deepEqual(page._catalogChapters[3].questionIds, ["q-l1-1"]);
  assert.equal(page.data.catalogSyncState, "cached");
  assert.equal(page.data.catalogSyncDetail, "缓存 3 科 5 册");
  assert.equal(page.data.catalogVersion, 3);
  // 点空科目不能说"暂无题目"就完事：要说明题在待归组里（否则看起来像题库缺内容）。
  toasts.length = 0;
  page.selectCatalogChapter({ currentTarget: { dataset: { id: "subject:modern-literature", title: "中国现代文学", pending: 1 } } });
  assert.deepEqual(toasts, ["中国现代文学暂无已归组题目，1 题待归组"]);

  // 综合训练下「章节刷题」仍按当前题所在册（现代汉语上册），不能被科目行污染。
  page.selectTrainingMode({ currentTarget: { dataset: { mode: "chapter" } } });
  assert.deepEqual(page.data.chapterPickerOptions.map((option) => option.title), ["全部", "第一章 语音"]);
  assert.equal(page.data.modePanelView, "chapters");

  // 改范围只剩古代汉语第 1 册：题池、当前册和科目目录都要跟着重建。
  page.data.selectedScopeSubjectIds = ["classical-chinese"];
  page.data.selectedScopeBookIds = ["classical-chinese-1"];
  page.applyComprehensiveScope();
  assert.deepEqual(page._questionBank.map((question) => question.id), ["q-a1-1"]);
  assert.equal(page.data.activeBookId, "classical-chinese-1");
  assert.deepEqual(page.data.catalogChapters.map((chapter) => chapter.id), ["subject:classical-chinese"]);
  assert.deepEqual(page._catalogChapters[0].questionIds, ["q-a1-1"]);
  assert.equal(page.data.catalogSyncDetail, "缓存 1 科 1 册");

  // 小程序显隐/层级契约：科目行走 wx:for 的 chapter 列表并带 catalog-subject 标记；
  // 三级往下有独立缩进（本机无微信环境，真机可见性由产品负责人验收）。
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/practice/practice.wxml"), "utf8");
  assert.match(markup, /chapter\.isSubject \? 'catalog-subject' : ''/);
  assert.match(markup, /catalog-level-\{\{section\.level \|\| 2\}\}/);
  assert.match(markup, /catalogSyncDetail \|\| \('已同步 v' \+ catalogVersion\)/);
  // 空科目行：题数照实显示 0（科目行始终显示题数），未投影题数走单独的「待归组」文案与字段。
  assert.match(markup, /wx:if="\{\{chapter\.questionCount \|\| chapter\.isSubject\}\}"/);
  assert.match(markup, /class="catalog-pending" wx:if="\{\{chapter\.pendingCount\}\}">待归组 \{\{chapter\.pendingCount\}\} 题/);
  assert.match(markup, /data-pending="\{\{chapter\.pendingCount \|\| 0\}\}"/);
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/practice/practice.wxss"), "utf8");
  assert.match(styles, /\.catalog-level-4 \{[\s\S]*?padding-left: 58rpx/);
  assert.match(styles, /\.catalog-level-5 \{[\s\S]*?padding-left: 82rpx/);
  assert.match(styles, /\.catalog-subject \{/);
  assert.match(styles, /\.catalog-pending \{[\s\S]*?color: #b3925f/);

  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
