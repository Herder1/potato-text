const CONTENT_TABS = [
  { id: "books", label: "题库", searchScope: "question" },
  { id: "packs", label: "题包", searchScope: "pack" },
  { id: "exams", label: "试卷", searchScope: "exam" },
  { id: "materials", label: "资料", searchScope: "material" },
];

const SEARCH_SCOPES = [
  { id: "all", label: "全部" },
  { id: "question", label: "题目" },
  { id: "pack", label: "题包" },
  { id: "exam", label: "试卷" },
  { id: "material", label: "资料" },
];

const EXAM_CATEGORIES = [
  { id: "past", name: "历年真题" },
  { id: "mock", name: "模拟试卷" },
  { id: "imported", name: "导入试卷" },
];

function normalizePublicPack(pack = {}) {
  const questionCount = Array.isArray(pack.questionIds)
    ? pack.questionIds.length
    : (Array.isArray(pack.questions) ? pack.questions.length : Math.max(0, Number(pack.questionCount) || 0));
  return {
    ...pack,
    id: String(pack.id || ""),
    name: String(pack.name || pack.title || "未命名题包"),
    description: String(pack.description || pack.excerpt || ""),
    tags: Array.isArray(pack.tags) ? pack.tags : [],
    questionCount,
    creatorName: pack.creator && pack.creator.nickname || pack.contributor || "社区贡献者",
    sourceType: pack.creatorType === "team" ? "official" : "public",
    sourceLabel: pack.creatorType === "team" ? "平台题包" : "社区题包",
    featured: pack.status === "featured",
    favoriteCount: Math.max(0, Number(pack.metrics && pack.metrics.favorites) || Number(pack.favoriteCount) || 0),
  };
}

function normalizeLibraryExam(exam = {}) {
  const kind = exam.kind === "past_paper" ? "past_paper" : "official_mock";
  const origin = exam.origin === "imported" ? "imported" : "manual";
  return {
    ...exam,
    id: String(exam.id || ""),
    title: String(exam.title || "未命名试卷"),
    description: String(exam.description || ""),
    sourceLabel: String(exam.sourceLabel || (origin === "imported" ? "用户导入" : kind === "past_paper" ? "广东省教育考试院" : "薯考平台题库")),
    summary: String(exam.summary || (origin === "imported"
      ? "由用户上传或从公共题库导入，请在使用前核对题目与答案。"
      : kind === "past_paper"
        ? `${Number(exam.year) || "历年"} 年广东普通专升本汉语言文学学科基础考试真题。`
        : "按照广东普通专升本汉语言文学学科基础考试结构编排。")),
    kind,
    origin,
    kindLabel: kind === "past_paper" ? "历年真题" : "平台模拟",
    year: Number(exam.year) || new Date().getFullYear(),
    questionCount: Math.max(0, Number(exam.questionCount) || 0),
    durationMinutes: Math.max(1, Number(exam.durationMinutes) || 120),
    totalScore: Math.max(0, Number(exam.totalScore) || 0),
    freePreviewQuestionCount: Math.max(0, Number(exam.freePreviewQuestionCount) || 0),
    attempts: Math.max(0, Number(exam.attempts) || 0),
  };
}

function filterLibraryExams(exams = [], categoryId = "all") {
  const normalized = exams.map(normalizeLibraryExam);
  if (categoryId === "imported") return normalized.filter((exam) => exam.origin === "imported");
  if (categoryId === "past") return normalized.filter((exam) => exam.origin !== "imported" && exam.kind === "past_paper");
  if (categoryId === "mock") return normalized.filter((exam) => exam.origin !== "imported" && exam.kind === "official_mock");
  return normalized;
}

function normalizeMaterial(product = {}) {
  return {
    ...product,
    id: String(product.id || ""),
    title: String(product.title || "未命名资料"),
    subtitle: String(product.subtitle || ""),
    description: String(product.description || ""),
    kindLabel: String(product.kindLabel || "学习资料"),
    badge: String(product.badge || ""),
    priceLabel: String(product.priceLabel || ""),
  };
}

function normalizeSearchQuestion(question = {}) {
  return {
    id: String(question.id || ""),
    scope: "question",
    title: String(question.stem || question.title || "未命名题目"),
    description: String(question.knowledgePoint || question.typeLabel || ""),
    meta: [question.typeLabel, question.breadcrumb || question.chapter, question.sourceLabel].filter(Boolean).join(" · "),
    subject: String(question.subjectName || question.subject || ""),
    bookId: String(question.bookId || ""),
    source: question,
  };
}

function createSearchRecords({ questions = [], privatePacks = [], publicPacks = [], exams = [], materials = [] } = {}) {
  return [
    ...questions.map(normalizeSearchQuestion),
    ...privatePacks.map((pack) => ({
      id: String(pack.id || ""), scope: "pack", title: String(pack.name || "未命名题包"),
      description: String(pack.description || ""), meta: `私人题包 · ${(pack.questionIds || []).length} 题`,
      subject: (pack.tags || [])[0] || "", sourceKind: "private", source: pack,
    })),
    ...publicPacks.map(normalizePublicPack).map((pack) => ({
      id: pack.id, scope: "pack", title: pack.name, description: pack.description,
      meta: `${pack.sourceLabel} · ${pack.questionCount} 题`, subject: pack.tags[0] || "",
      sourceKind: "remote", source: pack,
    })),
    ...exams.map(normalizeLibraryExam).map((exam) => ({
      id: exam.id, scope: "exam", title: exam.title, description: exam.description,
      meta: `${exam.kindLabel} · ${exam.questionCount} 题 · ${exam.totalScore} 分`, subject: "综合",
      source: exam,
    })),
    ...materials.map(normalizeMaterial).map((material) => ({
      id: material.id, scope: "material", title: material.title, description: material.subtitle || material.description,
      meta: [material.kindLabel, material.badge].filter(Boolean).join(" · "), subject: "综合", source: material,
    })),
  ].filter((record) => record.id);
}

function splitHighlight(text, query) {
  const source = String(text || "");
  const keyword = String(query || "").trim();
  if (!keyword) return [{ text: source, match: false }];
  const lowerSource = source.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const parts = [];
  let cursor = 0;
  let index = lowerSource.indexOf(lowerKeyword);
  while (index >= 0) {
    if (index > cursor) parts.push({ text: source.slice(cursor, index), match: false });
    parts.push({ text: source.slice(index, index + keyword.length), match: true });
    cursor = index + keyword.length;
    index = lowerSource.indexOf(lowerKeyword, cursor);
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), match: false });
  return parts.length ? parts : [{ text: source, match: false }];
}

function filterSearchRecords(records = [], { query = "", scope = "all", subject = "all" } = {}) {
  const keyword = String(query || "").trim().toLowerCase();
  return records.filter((record) => {
    if (scope !== "all" && record.scope !== scope) return false;
    if (subject !== "all" && record.subject !== subject) return false;
    if (!keyword) return true;
    return [record.title, record.description, record.meta, record.subject].join(" ").toLowerCase().includes(keyword);
  }).map((record) => ({ ...record, titleParts: splitHighlight(record.title, query) }));
}

module.exports = {
  CONTENT_TABS,
  EXAM_CATEGORIES,
  SEARCH_SCOPES,
  createSearchRecords,
  filterSearchRecords,
  filterLibraryExams,
  normalizeLibraryExam,
  normalizeMaterial,
  normalizePublicPack,
  splitHighlight,
};
