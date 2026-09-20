const test = require("node:test");
const assert = require("node:assert/strict");

global.Page = () => {};

const {
  createExamCatalogChapters,
  findCatalogLocation,
  normalizeQuestionSubNumber,
} = require("../apps/miniprogram/pages/practice/practice.js");

function questions(type, count, stem = "测试题干", idPrefix = type) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${idPrefix}-${index + 1}`,
    type,
    stem: typeof stem === "function" ? stem(index) : stem,
  }));
}

test("exam catalog follows the current paper structure and keeps all questions", () => {
  const queue = [
    ...questions("single_choice", 18),
    ...questions("multiple_choice", 10),
    ...questions("fill_blank", 7),
    ...questions("term_definition", 5, (index) => `晋军函陵。（《左传》） 字${index + 1}：`),
    ...questions("short_answer", 2, "用“/”给下列文段断句：测试文段", "punctuation"),
    ...questions("short_answer", 4, "简述作品的艺术特色。"),
    ...questions("material_analysis", 11),
  ];

  const chapters = createExamCatalogChapters(queue, "punctuation-1");

  assert.deepEqual(chapters.map((chapter) => chapter.title), [
    "一、单选题",
    "二、多选题",
    "三、名句默写题",
    "四、古文解释与断句",
    "五、简答题",
    "六、材料分析题",
  ]);
  assert.deepEqual(chapters.map((chapter) => chapter.questionCount), [18, 10, 7, 7, 4, 11]);
  assert.equal(chapters.reduce((total, chapter) => total + chapter.questionCount, 0), 57);

  const classical = chapters.find((chapter) => chapter.id === "exam-classical-language");
  assert.deepEqual(classical.sections.map((section) => [section.title, section.questionCount]), [
    ["（一）字词解释", 5],
    ["（二）断句", 2],
  ]);
  assert.equal(classical.expanded, true);
  assert.deepEqual(findCatalogLocation(chapters, "punctuation-1"), {
    chapterId: "exam-classical-language",
    sectionId: "exam-punctuation",
  });
  assert.deepEqual(findCatalogLocation(chapters, "material_analysis-3"), {
    chapterId: "exam-material-analysis",
    sectionId: "",
  });
});

test("exam catalog keeps an accessible fallback for an uncommon paper type", () => {
  const chapters = createExamCatalogChapters([
    { id: "essay-1", type: "essay", stem: "论述题" },
  ]);

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, "其他题型");
  assert.deepEqual(chapters[0].questionIds, ["essay-1"]);
});

test("practice subquestion numbers never render nested brackets", () => {
  assert.equal(normalizeQuestionSubNumber("3"), "3");
  assert.equal(normalizeQuestionSubNumber("（3）"), "3");
  assert.equal(normalizeQuestionSubNumber("((3))"), "3");
});
