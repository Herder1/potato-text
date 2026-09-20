const test = require("node:test");
const assert = require("node:assert/strict");

test("confirmed topic-family anchors place questions under their chapter and section", () => {
  global.Page = () => {};
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  const { createCatalogChapters } = require(practicePath);
  const outline = [{
    id: "phonetics",
    title: "第一章 语音",
    sections: [
      { id: "phonetics-tone", parentId: "phonetics", level: 2, title: "第四节 声调" },
      { id: "phonetics-syllable", parentId: "phonetics", level: 2, title: "第五节 音节" },
    ],
  }, {
    id: "introduction",
    title: "绪论",
    sections: [
      { id: "introduction-overview", parentId: "introduction", level: 2, title: "第一节 现代汉语概说" },
    ],
  }];
  const chapters = createCatalogChapters([{
    id: "imported-phonetics",
    chapter: "第一章 语音·第五节 音节",
    chapterId: "第一章 语音·第五节 音节",
    sectionId: "音节的结构",
    knowledgePoint: "音节的结构",
    knowledgePoints: ["音节的结构"],
    catalogProjection: { anchorNodeIds: ["phonetics-syllable"] },
  }, {
    id: "imported-introduction",
    chapter: "绪论·第一节 现代汉语概说",
    chapterId: "绪论·第一节 现代汉语概说",
    sectionId: "现代汉语概说",
    knowledgePoint: "现代汉语概说",
    knowledgePoints: ["现代汉语概说"],
    catalogProjection: { anchorNodeIds: ["introduction-overview"] },
  }], "", outline);

  const phonetics = chapters.find((chapter) => chapter.id === "phonetics");
  assert.equal(phonetics.questionCount, 1);
  assert.equal(phonetics.sections.find((section) => section.id === "phonetics-syllable").questionCount, 1);
  const introduction = chapters.find((chapter) => chapter.id === "introduction");
  assert.equal(introduction.questionCount, 1);
  assert.equal(introduction.sections.find((section) => section.id === "introduction-overview").questionCount, 1);
  delete global.Page;
});

test("a chapter-section-heading path is counted and addressable at level three", () => {
  global.Page = () => {};
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  const { createCatalogChapters, findCatalogLocation } = require(practicePath);
  const question = {
    id: "imported-level-three",
    chapter: "绪论·第一节 现代汉语概说·二、现代汉民族共同语",
    chapterId: "绪论·第一节 现代汉语概说·二、现代汉民族共同语",
    sectionId: "共同语",
    knowledgePoint: "共同语",
    knowledgePoints: ["共同语"],
    catalogProjection: { anchorNodeIds: ["common-language"] },
  };
  const [chapter] = createCatalogChapters([question], question.chapter, [{
    id: "introduction",
    title: "绪论",
    sections: [{ id: "overview", title: "第一节现代汉语概说", level: 2 }, {
      id: "common-language",
      title: "二、现代汉民族共同语",
      level: 3,
      parentId: "overview",
    }],
  }]);
  assert.equal(chapter.questionCount, 1);
  assert.deepEqual(chapter.questionIds, [question.id]);
  assert.equal(chapter.sections[0].questionCount, 1);
  assert.equal(chapter.sections[1].questionCount, 1);
  assert.deepEqual(chapter.sections[1].questionIds, [question.id]);
  assert.deepEqual(findCatalogLocation([chapter], question.id), {
    chapterId: "introduction",
    sectionId: "common-language",
  });
  delete global.Page;
});

test("a volume-chapter catalog groups contemporary literature questions under the correct volume", () => {
  global.Page = () => {};
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  const { createCatalogChapters } = require(practicePath);
  const questions = [{
    id: "contemporary-chapter-3",
    chapter: "第3章 矛盾和冲突",
    chapterId: "第3章 矛盾和冲突",
    sectionId: "对规范的质疑",
    knowledgePoint: "对规范的质疑",
    knowledgePoints: ["对规范的质疑"],
    catalogProjection: { anchorNodeIds: ["heading-three"] },
  }];
  const [volume] = createCatalogChapters(questions, questions[0].chapter, [{
    id: "volume-one",
    title: "上编 50—70年代的文学",
    sections: [{ id: "chapter-three", title: "第三章 矛盾和冲突", level: 2 }, {
      id: "heading-three",
      title: "三 对规范的质疑",
      level: 3,
      parentId: "chapter-three",
    }],
  }]);
  assert.equal(volume.questionCount, 1);
  assert.equal(volume.sections[0].questionCount, 1);
  assert.equal(volume.sections[1].questionCount, 1);
  delete global.Page;
});

test("catalog keeps questions without a confirmed topic-family anchor in a visible unassigned group", () => {
  global.Page = () => {};
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  const { createCatalogChapters } = require(practicePath);
  const chapters = createCatalogChapters([{
    id: "unclassified-question",
    chapter: "待归类",
    chapterId: "待归类",
    sectionId: "待归类",
    knowledgePoint: "待归类",
    knowledgePoints: ["待归类"],
  }], "待归类", [{ id: "volume-one", title: "上编", sections: [] }]);
  const unclassified = chapters.find((chapter) => chapter.id === "catalog-unassigned");
  assert.equal(unclassified.questionCount, 1);
  assert.deepEqual(unclassified.questionIds, ["unclassified-question"]);
  assert.equal(unclassified.title, "待归组");
  delete global.Page;
});

test("book mastery uses real review state instead of static subject progress", () => {
  global.Page = () => {};
  const libraryPath = require.resolve("../apps/miniprogram/pages/library/library.js");
  delete require.cache[libraryPath];
  const { createAllBooks } = require(libraryPath);
  const catalog = [{
    id: "modern-chinese",
    name: "现代汉语",
    color: "#111111",
    books: [{ id: "book-1", title: "测试教材", questionCount: 3 }],
  }];
  const questions = ["q-familiar", "q-fuzzy", "q-wrong"].map((id) => ({ id, bookId: "book-1" }));
  const states = {
    "q-familiar": { masteryStatus: "familiar", lastIsCorrect: true },
    "q-fuzzy": { masteryStatus: "fuzzy", lastIsCorrect: true },
    "q-wrong": { masteryStatus: "familiar", lastIsCorrect: false },
  };
  const [book] = createAllBooks(catalog, questions, states);
  assert.equal(book.studiedCount, 3);
  assert.equal(book.masteredCount, 1);
  assert.equal(book.reviewCount, 2);
  assert.equal(book.progress, 33);
  delete global.Page;
});

test("book practice resumes the saved question or the first unstudied question", () => {
  global.Page = () => {};
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  const { resolveResumeIndex, restorePracticeResponses } = require(practicePath);
  const queue = [{ id: "q1" }, { id: "q2" }, { id: "q3" }];
  const states = { q1: { masteryStatus: "familiar" }, q2: { masteryStatus: "fuzzy" } };
  assert.equal(resolveResumeIndex(queue, { questionId: "q2" }, states), 1);
  assert.equal(resolveResumeIndex(queue, { questionId: "deleted" }, states), 2);
  const responses = restorePracticeResponses(queue, [{
    questionId: "q2",
    selected: "B",
    submittedAnswer: "B",
    isCorrect: false,
  }], states);
  assert.deepEqual(responses.q2, {
    selected: "B",
    subjectiveAnswer: "",
    submitted: true,
    isCorrect: false,
    mastery: "fuzzy",
  });

  const scoreResult = { requestId: "score-latest", totalScore: 8, maxScore: 10 };
  const latestResponses = restorePracticeResponses(queue, [
    {
      questionId: "q3",
      selected: "A",
      submittedAnswer: "A",
      isCorrect: false,
      createdAt: 100,
    },
    {
      questionId: "q3",
      isCorrect: true,
      createdAt: 200,
      response: {
        selected: "",
        subjectiveAnswer: "最近一次复习时提交的正确答案",
        submitted: true,
        isCorrect: true,
        answerStatus: "correct",
        awardedScore: 8,
        mastery: "familiar",
        subjectiveScoreResult: scoreResult,
      },
    },
  ], {});
  assert.equal(latestResponses.q3.subjectiveAnswer, "最近一次复习时提交的正确答案");
  assert.equal(latestResponses.q3.isCorrect, true);
  assert.equal(latestResponses.q3.mastery, "familiar");
  assert.equal(latestResponses.q3.subjectiveScoreResult, scoreResult);
  delete global.Page;
});
