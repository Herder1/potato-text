const test = require("node:test");
const assert = require("node:assert/strict");
const { subjects } = require("../apps/miniprogram/data/catalog");
const {
  catalogWithQuestionCounts,
  normalizeOfficialQuestion,
} = require("../apps/miniprogram/utils/question-sync");

test("server questions normalize for mini program practice and catalog counts", () => {
  const question = normalizeOfficialQuestion({
    id: "imported-question-1",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第一章 语音",
    knowledgePoints: ["语音概说"],
    type: "single_choice",
    typeLabel: "单选题",
    stem: "导入题目是否进入小程序？",
    options: [{ key: "A", text: "是" }, { key: "B", text: "否" }],
    correctAnswer: ["A"],
    referenceAnswer: "是。",
    maxScore: 2,
    sourceLabel: "接口测试",
  });
  assert.equal(question.chapterId, "第一章 语音");
  assert.equal(question.sectionId, "语音概说");
  assert.equal(question.score, 2);
  assert.equal(question.answerMode, "choice");
  assert.equal(question.verifiedAnswerLabel, "平台核验答案");

  const counted = catalogWithQuestionCounts(subjects, [question]);
  const modernChinese = counted.find((subject) => subject.id === "modern-chinese");
  assert.equal(modernChinese.questionCount, 1);
  assert.equal(modernChinese.books.find((book) => book.id === "modern-chinese-7-1").questionCount, 1);
  assert.equal(modernChinese.books.find((book) => book.id === "modern-chinese-7-2").questionCount, 0);
});

test("verified answers use source-aware user labels without changing legacy fields", () => {
  const sourceAnswer = normalizeOfficialQuestion({ answerSource: "pdf_answer", answerVariants: { official: "A", ai: "", community: "" } });
  const platformAnswer = normalizeOfficialQuestion({ answerSource: "team_verified", answerVariants: { official: "B", ai: "", community: "" } });
  assert.equal(sourceAnswer.verifiedAnswerLabel, "来源答案");
  assert.equal(platformAnswer.verifiedAnswerLabel, "平台核验答案");
  assert.equal(sourceAnswer.answerVariants.official, "A");
});

test("server book counts override an incomplete local question cache", () => {
  const counted = catalogWithQuestionCounts(subjects, [{
    id: "cached-modern-literature",
    subjectId: "modern-literature",
    bookId: "modern-literature-30-years-3",
  }], { "modern-literature-30-years-3": 85, "ancient-literature-2-3": 2 });
  const modernLiterature = counted.find((subject) => subject.id === "modern-literature");
  const ancientLiterature = counted.find((subject) => subject.id === "ancient-literature");
  assert.equal(modernLiterature.books[0].questionCount, 85);
  assert.equal(ancientLiterature.books.find((book) => book.id === "ancient-literature-2-3").questionCount, 2);
});

test("material subquestions count as one textbook question", () => {
  const questions = [1, 2, 3, 4].map((groupOrder) => ({
    id: `material-${groupOrder}`,
    questionGroupId: "exam-import:draft-1:mg48",
    groupOrder,
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第四章 语法",
    type: "material_analysis",
    stem: `第 ${groupOrder} 小题`,
  }));
  const counted = catalogWithQuestionCounts(subjects, questions);
  const modernChinese = counted.find((subject) => subject.id === "modern-chinese");
  assert.equal(modernChinese.questionCount, 1);
  assert.equal(modernChinese.books.find((book) => book.id === "modern-chinese-7-1").questionCount, 1);
});
