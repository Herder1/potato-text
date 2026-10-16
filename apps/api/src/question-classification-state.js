// 题目归类状态的**唯一派生处**（不新增存储字段）。
//
// 产品口径（产品手册 §4.6「题目与题目版本」）：
//   科目必填；教材、章节、知识点允许暂缺。分类缺失不属于题目结构错误，
//   题目仍可进入平台题目管理，但不得因此自动审核通过或发布。
//
// 因此「待归类」不是一个可独立增删的状态字段，而是**现场派生**的筛选视图：
// 缺失哪一级就报哪一级，补全后自动消失（与 §4.10「待归组/无题族关系必须现场派生」同一原则）。
//
// 为什么把占位串也算「缺失」：历史上后台录入页会写入「未归类章节 / 未归类知识点」
// 这类占位值来应付必填校验（见 apps/admin/app.js）。占位串表达的是「还没归类」，
// 不是真实归类，必须与空值同等对待，否则假值会冒充已归类。

const placeholderPattern = /^(?:待归类|未归类|待补充|未知|暂无|无)$/;

// 「缺哪一层」的中文说法（2026-09-24）：界面此前读 `classification.missingLabels`，而这个派生状态只给了
// `missing` 键——于是「完善题目」列表行渲染出一句断掉的「待归类 · 缺」（键在、标签不在）。
// 标签与这里的 need 词汇一处维护：本模块是「待归类」派生状态的唯一定义处，标签跟着它走；
// question-store 的导入预览也曾自己维护一份同名映射，现统一复用这里。
const classificationNeedLabels = { book: "教材", chapter: "章节", knowledge_points: "知识点" };

function classificationNeedLabel(need) {
  return classificationNeedLabels[need] || need;
}

function isPlaceholder(value) {
  return !String(value || "").trim() || placeholderPattern.test(String(value || "").trim());
}

// 返回 { missing, missingLabels, missingBook, missingChapter, missingKnowledgePoints, needsClassification, complete }
// missing 的取值与既有 questionEnrichmentNeeds 的 need 词汇一致：chapter / knowledge_points，
// 另加 book（教材）。
function questionClassificationState(question = {}) {
  const knowledgePoints = (Array.isArray(question.knowledgePoints) ? question.knowledgePoints : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && !isPlaceholder(value));
  const missing = [
    !String(question.bookId || "").trim() && "book",
    isPlaceholder(question.chapter) && "chapter",
    !knowledgePoints.length && "knowledge_points",
  ].filter(Boolean);
  return {
    missing,
    missingLabels: missing.map(classificationNeedLabel),
    missingBook: missing.includes("book"),
    missingChapter: missing.includes("chapter"),
    missingKnowledgePoints: missing.includes("knowledge_points"),
    needsClassification: missing.length > 0,
    complete: missing.length === 0,
  };
}

// 是否「待归类」：任一归类层级缺失即为待归类。
function questionNeedsClassification(question = {}) {
  return questionClassificationState(question).needsClassification;
}

// 归类是否完整（教材 + 章节 + 知识点俱全）。自动发布的门槛之一。
function questionClassificationComplete(question = {}) {
  return questionClassificationState(question).complete;
}

module.exports = {
  placeholderPattern,
  isPlaceholder,
  classificationNeedLabels,
  classificationNeedLabel,
  questionClassificationState,
  questionNeedsClassification,
  questionClassificationComplete,
};
