const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_EXAM_PROJECT_ID,
  CLASSIFICATION_ACCURACY_TARGETS,
  listExamProjects,
  findExamProject,
  normalizeExamProjectId,
  examProjectIdForSubject,
  subjectsOfProject,
  booksOfProject,
} = require("../apps/api/src/exam-project-registry");

// 考试项目（专业）是归属判断的第一级（DEC-098）。今天只有一个项目，但**接口按多项目预留**：
// 扩展其他专业时的唯一改动点是 packages/domain/catalog.js 导出 `examProjects`，
// 本模块与调用方（server.js 的完善链路）一行都不用改。这里把这条契约钉住。
test("exam project registry exposes the single current project with its subjects and books", () => {
  const projects = listExamProjects();
  assert.equal(projects.length, 1);
  const [project] = projects;
  assert.equal(project.id, DEFAULT_EXAM_PROJECT_ID);
  assert.equal(project.examType, "普通专升本");
  assert.equal(project.region, "广东");
  assert.equal(project.year, 2026);

  // 项目 → 科目：项目没有显式声明 subjectIds 时（今天的单项目形态）视为包含全部科目。
  const subjectIds = project.subjects.map((subject) => subject.id);
  assert.deepEqual(subjectIds, ["modern-chinese", "classical-chinese", "ancient-literature", "modern-literature", "contemporary-literature"]);
  assert.deepEqual(subjectsOfProject(project.id).map((subject) => subject.id), subjectIds);

  // 科目 → 教材：项目里 9 本教材都要能按项目查出来（跨科目），这是"科目判错时还能挑到书"的前提。
  const books = booksOfProject(project.id);
  assert.equal(books.length, 9);
  assert.deepEqual([...new Set(books.map((book) => book.subjectId))].sort(), [...subjectIds].sort());
});

test("exam project registry normalizes unknown or missing ids to the default project", () => {
  assert.equal(normalizeExamProjectId(""), DEFAULT_EXAM_PROJECT_ID);
  assert.equal(normalizeExamProjectId("not-a-project"), DEFAULT_EXAM_PROJECT_ID);
  assert.equal(normalizeExamProjectId(DEFAULT_EXAM_PROJECT_ID), DEFAULT_EXAM_PROJECT_ID);
  assert.equal(findExamProject("not-a-project").id, DEFAULT_EXAM_PROJECT_ID);
  assert.equal(findExamProject("").id, DEFAULT_EXAM_PROJECT_ID);

  // 科目 → 项目：登记过的科目归本项目；没登记的科目兜底到默认项目（不抛错——
  // 归属缺失是"待归类"，不是结构错误，口径与 question-classification-state.js 一致）。
  assert.equal(examProjectIdForSubject("modern-chinese"), DEFAULT_EXAM_PROJECT_ID);
  assert.equal(examProjectIdForSubject("classical-chinese"), DEFAULT_EXAM_PROJECT_ID);
  assert.equal(examProjectIdForSubject(""), DEFAULT_EXAM_PROJECT_ID);
  assert.equal(examProjectIdForSubject("unknown-subject"), DEFAULT_EXAM_PROJECT_ID);
});

// 准确率目标（产品负责人 2026-09-24 同意"可以设置目标"）：目标值只在这一个模块里维护，
// `GET /api/admin/question-enrichment/accuracy` 把它连同实测计数一起下发；
// 本用例防的是"目标被悄悄改成 0"或"删掉目标却没人发现"。
test("classification accuracy targets stay in one place and are measurable ratios", () => {
  assert.deepEqual(Object.keys(CLASSIFICATION_ACCURACY_TARGETS).sort(), ["subject", "textbook"]);
  Object.entries(CLASSIFICATION_ACCURACY_TARGETS).forEach(([level, target]) => {
    assert.equal(typeof target, "number", `${level} 目标必须是数字`);
    assert.ok(target > 0 && target <= 1, `${level} 目标必须在 (0,1] 区间，当前 ${target}`);
  });
});
