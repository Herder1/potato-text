// 「题目录入改造」回归网：支持只确定科目的题目先录入，解除教材/章节/知识点对保存的强制依赖。
// 口径来源：产品手册 §3.5 / §4.6 / §4.10（唯一权威正文）。
//   1) 科目必填；教材、章节、知识点允许暂缺；
//   2) 分类缺失不是结构错误，可以进平台题目管理，但不自动审核通过、不自动发布给用户端；
//   3) 已提供的分类关联必须有效，不得用假教材 / 默认章节 / 空字符串绕过；
//   4) 原始来源描述与已确认教材关联分开保存，来源文本不得被强制映射成教材；
//   5) 复用现有题目实体、审核机制与列表，待归类状态由缺失字段现场派生，不新增存储状态位。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMemoryQuestionStore, createFileQuestionStore } = require("../apps/api/src/question-store");
const {
  placeholderPattern,
  isPlaceholder,
  questionClassificationState,
  questionNeedsClassification,
  questionClassificationComplete,
} = require("../apps/api/src/question-classification-state");

const fullQuestion = {
  subjectId: "modern-chinese",
  bookId: "modern-chinese-7-1",
  chapter: "绪论",
  knowledgePoints: ["现代汉语共同语"],
  type: "single_choice",
  stem: "普通话以什么语音为标准音？",
  options: [
    { key: "A", text: "北京语音" },
    { key: "B", text: "北方语音" },
  ],
  correctAnswer: ["A"],
  referenceAnswer: "普通话以北京语音为标准音。",
  maxScore: 2,
  sourceLabel: "《现代汉语》绪论",
  sourcePage: "第 5 页",
  freePreview: { question: true, answer: false, analysis: false },
};

// ---------- 派生状态（不新增存储字段） ----------

test("classification state is derived from missing fields and never stored", () => {
  assert.equal(questionClassificationComplete(fullQuestion), true);
  assert.equal(questionNeedsClassification(fullQuestion), false);

  const subjectOnly = { subjectId: "modern-chinese", chapter: "", knowledgePoints: [] };
  assert.deepEqual(questionClassificationState(subjectOnly).missing, ["book", "chapter", "knowledge_points"]);
  assert.equal(questionNeedsClassification(subjectOnly), true);

  const bookOnly = { subjectId: "modern-chinese", bookId: "modern-chinese-7-1" };
  assert.deepEqual(questionClassificationState(bookOnly).missing, ["chapter", "knowledge_points"]);

  // 题目对象上没有、也不应该有 classification / needsClassification 这类可独立增删的状态位。
  const store = createMemoryQuestionStore([]);
  const created = store.create({ ...fullQuestion, id: "derived-state-question" });
  assert.equal(Object.prototype.hasOwnProperty.call(created, "classification"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(created, "needsClassification"), false);
});

test("placeholder strings count as missing so legacy '待归类' rows are flagged", () => {
  assert.equal(placeholderPattern.test("待归类"), true);
  assert.equal(isPlaceholder(" 未归类 "), true);
  assert.equal(isPlaceholder("暂无"), true);
  assert.equal(isPlaceholder("无"), true);
  assert.equal(isPlaceholder("绪论"), false);

  // 线上历史数据用的是占位串（chapter="待归类"），必须被识别成"缺章节"而不是有效章节。
  const legacy = { subjectId: "modern-literature", bookId: "modern-literature-30-years-3", chapter: "待归类", knowledgePoints: ["待归类"] };
  assert.deepEqual(questionClassificationState(legacy).missing, ["chapter", "knowledge_points"]);
});

// ---------- 验收①：只有科目、题干和完整选项的题能保存 ----------

test("a subject-only question saves and survives a store reopen", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-classification-"));
  const filePath = path.join(directory, "questions.json");
  try {
    const store = createFileQuestionStore(filePath);
    const created = store.create({
      subjectId: "modern-chinese",
      type: "single_choice",
      stem: "只有科目和题干的题目能否保存？",
      options: [
        { key: "A", text: "能" },
        { key: "B", text: "不能" },
      ],
      correctAnswer: ["A"],
      referenceAnswer: "能，教材与章节可以后补。",
      maxScore: 2,
    });
    assert.equal(created.subjectId, "modern-chinese");
    assert.equal(created.bookId, "");
    assert.equal(created.chapter, "");
    assert.deepEqual(created.knowledgePoints, []);
    assert.equal(created.evidenceChunkIds, undefined);

    // 重启后仍可查到（重新读盘，不是内存缓存）。
    const reopened = createFileQuestionStore(filePath);
    const loaded = reopened.get(created.id);
    assert.ok(loaded);
    assert.equal(loaded.stem, "只有科目和题干的题目能否保存？");
    assert.equal(loaded.bookId, "");
    assert.deepEqual(loaded.knowledgePoints, []);
    assert.equal(reopened.list({ classification: "pending" }).questions.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing answer cannot be auto-approved even with a verified review status", () => {
  const store = createMemoryQuestionStore([]);
  const created = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "绪论",
    knowledgePoints: ["现代汉语共同语"],
    type: "short_answer",
    stem: "没有作答内容的题目？",
    referenceAnswer: "",
    maxScore: 6,
    answerReviewStatus: "verified",
  });
  // 明文声明"已核对"、且归类完整，但没有任何作答内容时不能冒充已审核、也不能自动发布。
  assert.equal(created.referenceAnswer, "");
  assert.equal(created.answerReviewStatus, "unreviewed");
  assert.equal(created.answerVerified, false);
  assert.equal(created.status, "pending_review");
  // 选择题缺正确答案仍按既有规则直接拒绝（不放宽）。
  assert.throws(() => store.create({
    subjectId: "modern-chinese",
    type: "single_choice",
    stem: "没有正确答案的选择题？",
    options: [
      { key: "A", text: "甲" },
      { key: "B", text: "乙" },
    ],
    maxScore: 2,
  }), /question_choice_answer_invalid/);
});

test("subjective questions still follow the existing scoring-point rules and answer source rules", () => {
  const store = createMemoryQuestionStore([]);
  const created = store.create({
    subjectId: "modern-chinese",
    type: "short_answer",
    stem: "简述现代汉语共同语的形成。",
    referenceAnswer: "以北京语音为标准音，以北方话为基础方言。",
    maxScore: 6,
  });
  assert.equal(created.type, "short_answer");
  assert.equal(created.status, "pending_review");

  // answerSource=missing 却带着答案仍然被拒（既有约束不放宽）。
  assert.throws(() => store.create({
    subjectId: "modern-chinese",
    type: "short_answer",
    stem: "答案来源自相矛盾的题目。",
    referenceAnswer: "有答案。",
    maxScore: 6,
    answerSource: "missing",
  }), /question_answer_source_required/);
});

// ---------- 验收②：有教材但无章节、知识点也能保存 ----------

test("a question with a textbook but no chapter or knowledge points saves as 待归类", () => {
  const store = createMemoryQuestionStore([]);
  const created = store.create({ ...fullQuestion, id: "book-only-question", chapter: "", knowledgePoints: [], primaryKnowledgePoint: "" });
  assert.equal(created.bookId, "modern-chinese-7-1");
  assert.equal(created.chapter, "");
  assert.deepEqual(created.knowledgePoints, []);
  // 没有知识点时不再造「未归类知识点」占位串。
  assert.equal(created.primaryKnowledgePoint, "");
  assert.deepEqual(questionClassificationState(created).missing, ["chapter", "knowledge_points"]);
  assert.equal(created.status, "pending_review");
});

// ---------- 口径：分类缺失不自动发布；已完好题目不受影响 ----------

test("only a verified, fully classified question is eligible for automatic publication", () => {
  const store = createMemoryQuestionStore([]);
  const complete = store.create({ ...fullQuestion, id: "complete-question" });
  assert.equal(complete.status, "official");

  const bookOnly = store.create({ ...fullQuestion, id: "book-only", chapter: "", knowledgePoints: [] });
  assert.equal(bookOnly.status, "pending_review");
});

// ---------- 口径：不得用假教材 / 默认章节 / 空字符串绕过约束 ----------

test("a missing subject is rejected while a missing textbook is accepted", () => {
  const store = createMemoryQuestionStore([]);
  assert.throws(() => store.create({ ...fullQuestion, subjectId: "", bookId: "", chapter: "", knowledgePoints: [] }), /question_subject_required/);
  assert.throws(() => store.create({ ...fullQuestion, subjectId: "   ", bookId: "", chapter: "", knowledgePoints: [] }), /question_subject_required/);
  const accepted = store.create({ ...fullQuestion, bookId: "", chapter: "", knowledgePoints: [], id: "no-textbook-question" });
  assert.equal(accepted.bookId, "");
});

test("a supplied textbook must be a real textbook of the chosen subject", () => {
  const store = createMemoryQuestionStore([]);
  // 别的科目的教材：拒绝，而不是硬塞进去。
  assert.throws(() => store.create({ ...fullQuestion, subjectId: "modern-chinese", bookId: "contemporary-literature-history-3" }), /question_book_invalid/);
  // 编造的教材 ID：同样拒绝。
  assert.throws(() => store.create({ ...fullQuestion, subjectId: "modern-chinese", bookId: "编造的教材" }), /question_book_invalid/);
  // 该科目自己的教材：通过。
  assert.equal(store.create({ ...fullQuestion, id: "valid-book-question" }).bookId, "modern-chinese-7-1");
});

test("chapter and knowledge points may not hang under a missing textbook", () => {
  const store = createMemoryQuestionStore([]);
  assert.throws(() => store.create({ ...fullQuestion, bookId: "", id: "chapter-without-book" }), /question_classification_requires_book/);
  assert.throws(() => store.create({ ...fullQuestion, bookId: "", chapter: "", id: "knowledge-without-book" }), /question_classification_requires_book/);
});

test("questions without a textbook are reachable through the 待归类 filters", () => {
  const store = createMemoryQuestionStore([]);
  const withBook = store.create({ ...fullQuestion, id: "filter-with-book" });
  const withoutBook = store.create({ ...fullQuestion, id: "filter-without-book", bookId: "", chapter: "", knowledgePoints: [] });
  const bookOnly = store.create({ ...fullQuestion, id: "filter-book-only", chapter: "", knowledgePoints: [] });

  assert.deepEqual(store.list({ bookId: "__unassigned__" }).questions.map((question) => question.id), [withoutBook.id]);
  assert.deepEqual(store.list({ classification: "pending" }).questions.map((question) => question.id).sort(), [withoutBook.id, bookOnly.id].sort());
  assert.deepEqual(store.list({ classification: "assigned" }).questions.map((question) => question.id), [withBook.id]);
  // 普通教材筛选不受影响，"__unassigned__" 不会被当成一本教材。
  assert.deepEqual(store.list({ bookId: "modern-chinese-7-1" }).questions.map((question) => question.id).sort(), [withBook.id, bookOnly.id].sort());
});

// ---------- 验收③：混合批次里待归类题可导入，结构错误题被明确指出 ----------

test("a mixed batch imports 待归类 rows and isolates structurally broken rows", () => {
  const store = createMemoryQuestionStore([]);
  const candidates = [
    { ...fullQuestion, chapter: "", knowledgePoints: [], stem: "待归类的有效题目" },
    { ...fullQuestion, stem: "结构错误的题目", correctAnswer: [] },
    { ...fullQuestion, stem: "归类完整的有效题目" },
  ];
  const preview = store.previewImport(candidates);
  assert.deepEqual(preview.map((item) => item.valid), [true, false, true]);
  // 待归类是提示，不是结构错误：它必须带着 missing 清单出现在"可导入"一侧。
  assert.equal(preview[0].needsClassification, true);
  assert.deepEqual(preview[0].classification.missing, ["chapter", "knowledge_points"]);
  assert.deepEqual(preview[0].classification.missingLabels, ["章节", "知识点"]);
  assert.equal(preview[2].needsClassification, false);
  // 结构错误的行必须指出具体错因，而不是笼统失败。
  assert.equal(preview[1].error, "question_choice_answer_invalid");
  assert.deepEqual(preview[1].details.correctAnswer, []);

  const result = store.importMany(candidates);
  assert.equal(result.created.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.pendingClassification.length, 1);
  assert.deepEqual(result.pendingClassification[0].missing, ["chapter", "knowledge_points"]);
  // 待归类清单指向的必须是真正落库的那道题（importMany 返回的 created 是库内顺序，不按入参顺序）。
  assert.equal(result.created.some((question) => question.id === result.pendingClassification[0].questionId), true);
  assert.equal(store.get(result.pendingClassification[0].questionId).chapter, "");
});

// ---------- 验收④：后补归属更新原题，不生成重复题、不丢来源与审核记录 ----------

test("adding a textbook to a 待归类 batch updates the original questions in place", () => {
  const store = createMemoryQuestionStore([]);
  const result = store.importMany([
    { ...fullQuestion, bookId: "", chapter: "", knowledgePoints: [], sourceLabel: "2024 真题汇编", sourcePage: "第 12 页" },
    { ...fullQuestion, bookId: "", chapter: "", knowledgePoints: [], sourceLabel: "2024 真题汇编", sourcePage: "第 13 页", stem: "第二道待归类题目" },
  ]);
  const batchId = result.batchId;
  const before = result.created.map((question) => store.get(question.id));
  assert.equal(store.list({}).questions.length, 2);
  assert.deepEqual(before.map((question) => question.status), ["pending_review", "pending_review"]);

  const updated = store.updateImportBatch(batchId, {
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "绪论",
    knowledgePoints: ["现代汉语共同语"],
  }, "超级管理员");

  assert.equal(updated.updated.length, 2);
  assert.equal(store.list({}).questions.length, 2, "补充归属不得生成重复题");
  assert.deepEqual(updated.updated.map((question) => question.id).sort(), before.map((question) => question.id).sort());
  assert.equal(updated.pendingClassificationCount, 0);
  updated.updated.forEach((question) => {
    assert.equal(question.bookId, "modern-chinese-7-1");
    assert.equal(question.chapter, "绪论");
    assert.deepEqual(question.knowledgePoints, ["现代汉语共同语"]);
    // 原始来源描述与已确认教材关联分开保存：来源不得被教材覆盖。
    assert.equal(question.sourceLabel, "2024 真题汇编");
    assert.match(question.sourcePage, /^第 1[23] 页$/);
    // 版本链与审核留痕保留。
    assert.equal(question.version, 2);
    assert.equal(question.versions.length, 2);
    assert.equal(question.versions[0].previousSnapshot.bookId, "");
    assert.equal(question.answerReviewStatus, "verified");
    assert.equal(question.status, "official");
  });
});

test("moving a batch to another textbook clears the old textbook's lower-level links", () => {
  const store = createMemoryQuestionStore([]);
  const seeded = store.create({ ...fullQuestion, id: "move-me" });
  const result = store.updateImportBatch(seeded.importBatchId, {
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-2",
  }, "超级管理员");
  assert.equal(result.updated.length, 1);
  const moved = result.updated[0];
  // 新教材下没写章节/知识点 → 清空并退回待归类，不把旧教材的章节挂在书上。
  assert.equal(moved.bookId, "modern-chinese-7-2");
  assert.equal(moved.chapter, "");
  assert.deepEqual(moved.knowledgePoints, []);
  assert.equal(moved.status, "pending_review");
  assert.equal(result.pendingClassificationCount, 1);
});

// ---------- 验收⑥：已有教材题的录入 / 编辑 / 查重回归 ----------

test("an existing fully classified question keeps its approval and duplicate detection", () => {
  const store = createMemoryQuestionStore([]);
  const created = store.create({ ...fullQuestion, id: "regression-question" });
  assert.equal(created.status, "official");

  // 编辑既有完整题目：状态保持 official，版本累加。
  const edited = store.update(created.id, { stem: "普通话以什么语音为标准音？（修订）" }, "超级管理员");
  assert.equal(edited.status, "official");
  assert.equal(edited.version, 2);
  assert.equal(edited.chapter, "绪论");
  assert.deepEqual(edited.knowledgePoints, ["现代汉语共同语"]);

  // 查重仍然命中同一道题（查重在导入预览里做，不新增独立入口）。
  const duplicate = store.previewImport([{ ...fullQuestion, stem: "普通话以什么语音为标准音？（修订）" }]);
  assert.equal(duplicate[0].duplicate, true);
  assert.equal(duplicate[0].duplicateOf, created.id);
  assert.equal(duplicate[0].duplicateScope, "stored");

  // 下架 / 恢复往返不改变"已归类的既有题"的可发布性。
  store.transition(created.id, "offline", "超级管理员");
  assert.equal(store.get(created.id).status, "offline");
  store.transition(created.id, "restore", "超级管理员");
  assert.equal(store.get(created.id).status, "official");
});

test("a 待归类 question is never restored into a published state", () => {
  const store = createMemoryQuestionStore([]);
  const created = store.create({ ...fullQuestion, id: "pending-restore", bookId: "", chapter: "", knowledgePoints: [] });
  assert.equal(created.status, "pending_review");
  store.transition(created.id, "offline", "超级管理员");
  store.transition(created.id, "restore", "超级管理员");
  // 从未被批准发布的题，下架后恢复也还是待处理——不能凭空变成 official。
  assert.equal(store.get(created.id).status, "pending_review");
});
