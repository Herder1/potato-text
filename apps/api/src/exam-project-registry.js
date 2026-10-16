const domain = require("../../../packages/domain/catalog");

// 考试项目（专业）登记的**唯一读取入口**（DEC-098，2026-09-24 产品负责人确认）：
// 归属判断的最上一级是「这套题属于哪个考试项目（专业）」——项目 → 科目 → 教材 → 知识树。
// 今天只服务一个项目（广东 · 普通专升本 · 汉语言文学学科基础），但**接口按多项目预留**：
//   · 扩展新专业时的唯一改动点 = `packages/domain/catalog.js` 导出 `examProjects` 数组
//     （每项可带 `subjectIds` 指定它包含哪些科目）；本模块自动改读数组，调用方一行不用改。
//   · 数组缺省时退回单项目 + 全部科目（＝今天的现状），保证旧数据与旧测试语义不变。
// 别处（server.js / 管理端 / 其它模块）**不许直接读 `examProject`**——一律经本模块，
// 否则"扩展到其他专业"就要满仓库改代码。
function definedProjects() {
  const list = Array.isArray(domain.examProjects) ? domain.examProjects : [];
  const projects = list.filter((project) => project && String(project.id || "").trim());
  if (projects.length) return projects;
  return domain.examProject && domain.examProject.id ? [domain.examProject] : [];
}

const allSubjects = Array.isArray(domain.subjects) ? domain.subjects : [];
const allBooks = Array.isArray(domain.books) ? domain.books : [];

const DEFAULT_EXAM_PROJECT_ID = String(
  (definedProjects()[0] && definedProjects()[0].id) || "",
);

function projectWithSubjects(project) {
  // 项目 → 科目：项目显式声明 `subjectIds` 时按声明过滤；没声明（今天的单项目形态）视为包含全部科目。
  const declared = Array.isArray(project && project.subjectIds) ? project.subjectIds.map(String) : [];
  const subjects = declared.length
    ? allSubjects.filter((subject) => declared.includes(String(subject.id)))
    : allSubjects.slice();
  return {
    id: String(project.id),
    name: String(project.name || ""),
    region: String(project.region || ""),
    examType: String(project.examType || ""),
    year: Number(project.year) || 0,
    subjects: subjects.map((subject) => ({
      id: String(subject.id),
      name: String(subject.name || ""),
      order: Number(subject.order) || 0,
    })),
  };
}

function listExamProjects() {
  return definedProjects().map(projectWithSubjects);
}

function normalizeExamProjectId(value) {
  const id = String(value || "").trim();
  if (!id) return DEFAULT_EXAM_PROJECT_ID;
  return listExamProjects().some((project) => project.id === id) ? id : DEFAULT_EXAM_PROJECT_ID;
}

function findExamProject(projectId) {
  const id = normalizeExamProjectId(projectId);
  return listExamProjects().find((project) => project.id === id) || null;
}

// 科目 → 所属项目。科目不在登记表里时归到默认项目（旧数据兜底，不抛错——归属缺失是"待归类"，
// 不是结构错误，这个口径与 question-classification-state.js 一致）。
function examProjectIdForSubject(subjectId) {
  const id = String(subjectId || "").trim();
  if (id) {
    const owner = listExamProjects().find((project) => project.subjects.some((subject) => subject.id === id));
    if (owner) return owner.id;
  }
  return DEFAULT_EXAM_PROJECT_ID;
}

function subjectsOfProject(projectId) {
  const project = findExamProject(projectId);
  return project ? project.subjects : [];
}

function booksOfProject(projectId) {
  const ids = new Set(subjectsOfProject(projectId).map((subject) => subject.id));
  return allBooks.filter((book) => ids.has(String(book.subjectId)));
}

// 归属判断准确率目标（DEC-098：产品负责人 2026-09-24 同意"可以设置目标"）。
// 目标值只在这里维护一处；`GET /api/admin/question-enrichment/accuracy` 把它连同实测计数一起下发，
// 上线阻断项的措辞在 docs/RELEASE_CHECKLIST.md（那处只写引用与结论，不复制数值口径）。
const CLASSIFICATION_ACCURACY_TARGETS = {
  // 「科目建议」里与题目当前科目不同、且被人工采纳的比例
  subject: 0.95,
  // 「教材（含册次）建议」里与题目当前教材不同、且被人工采纳的比例
  textbook: 0.85,
};

// 科目级默认参数：**每个材料题组各自的满分**（产品负责人 2026-09-25 确认：现代汉语 14 分、其余四科 20 分；
// 口径正文＝产品手册 §4.6.7 / DEC-099 修订）。只在录入稿没写题组总分时兜底——卷面写了就以卷面为准。
// 数值只维护在 `packages/domain/catalog.js` 的 subjects（领域数据），本函数是**唯一读取入口**；
// 科目没有登记该字段时返回 0＝不兜底（宁可不给分，也不编造）。
function materialGroupTotalForSubject(subjectId) {
  const id = String(subjectId || "").trim();
  if (!id) return 0;
  const subject = allSubjects.find((item) => String(item.id) === id);
  const total = Number(subject && subject.materialGroupTotal);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

module.exports = {
  DEFAULT_EXAM_PROJECT_ID,
  CLASSIFICATION_ACCURACY_TARGETS,
  listExamProjects,
  findExamProject,
  normalizeExamProjectId,
  examProjectIdForSubject,
  subjectsOfProject,
  booksOfProject,
  materialGroupTotalForSubject,
};
