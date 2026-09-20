const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");

const baseQuestion = {
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

test("question store loads a requested exam question batch in one ordered call", () => {
  const store = createMemoryQuestionStore([]);
  const first = store.create({ ...baseQuestion, id: "batch-question-1" });
  const second = store.create({ ...baseQuestion, id: "batch-question-2", stem: "普通话的基础方言是什么？" });
  const loaded = store.getMany([second.id, "missing-question", first.id]);
  assert.equal(loaded.length, 3);
  assert.equal(loaded[0].id, second.id);
  assert.equal(loaded[1], null);
  assert.equal(loaded[2].id, first.id);
});

test("questions without explicit knowledge signals remain visibly unassessed", () => {
  const store = createMemoryQuestionStore([]);
  const created = store.create(baseQuestion);
  const question = store.get(created.id);
  assert.equal(question.difficultyScore, 50);
  assert.equal(question.difficultyAssessment.status, "unassessed");
  assert.equal(question.difficultyAssessment.confidence < 0.25, true);
});

test("question exam tags support multiple explicit audiences and preserve legacy inference", () => {
  const store = createMemoryQuestionStore([]);
  const multiTagged = store.create({ ...baseQuestion, examTags: ["insert", "graduate", "insert"] });
  assert.deepEqual(multiTagged.examTags, ["insert", "graduate"]);

  const updated = store.update(multiTagged.id, { examTags: ["graduate"] });
  assert.deepEqual(updated.examTags, ["graduate"]);
  assert.equal(store.get(updated.id).examTrack, "graduate");

  const legacy = createMemoryQuestionStore([{ ...baseQuestion, id: "legacy-insert", projectId: "gd-zsb-2026-hywxxkjc" }]);
  assert.deepEqual(legacy.get("legacy-insert").examTags, ["insert"]);

  const legacyUpgrade = createMemoryQuestionStore([{ ...baseQuestion, id: "legacy-upgrade", examTrack: "upgrade" }]);
  assert.deepEqual(legacyUpgrade.get("legacy-upgrade").examTags, ["insert"]);
  const normalizedPayload = store.create({ ...baseQuestion, examTags: ["upgrade", "graduate"] });
  assert.deepEqual(normalizedPayload.examTags, ["insert", "graduate"]);
});

test("official and public question workflows preserve versions", () => {
  const store = createMemoryQuestionStore([]);
  const official = store.create(baseQuestion, "题库编辑");
  assert.equal(official.library, "official");
  assert.equal(official.status, "official");
  assert.equal(official.version, 1);

  const edited = store.update(official.id, { ...baseQuestion, stem: "普通话的标准音是什么？", changeNote: "优化题干" }, "题库编辑");
  assert.equal(edited.version, 2);
  assert.equal(edited.versions[0].changeNote, "优化题干");
  assert.equal(edited.versions[0].previousSnapshot.stem, baseQuestion.stem);

  const community = store.create({
    ...baseQuestion,
    library: "public",
    status: "pending_review",
    contributor: { id: "user-001", nickname: "学习者甲" },
  }, "内容审核员");
  assert.equal(store.transition(community.id, "publish").status, "public");
  assert.equal(store.transition(community.id, "feature").status, "featured");
  const promoted = store.transition(community.id, "promote_official");
  assert.equal(promoted.library, "official");
  assert.equal(promoted.status, "official");
  assert.equal(promoted.contributor.nickname, "学习者甲");
  assert.equal(promoted.version, 4);
  assert.equal(store.list({ library: "official" }).counts.official, 2);
});

test("question groups count once and transition every answer item together", () => {
  const store = createMemoryQuestionStore([]);
  const groupId = "exam-import:draft-1:mg48";
  const created = [1, 2, 3, 4].map((groupOrder) => store.create({
    ...baseQuestion,
    id: `material-group-${groupOrder}`,
    stem: `材料题第 ${groupOrder} 小题`,
    questionGroupId: groupId,
    questionGroupTitle: "第48题 · 材料题组",
    groupOrder,
  }));
  const listed = store.list({ library: "official" });
  assert.equal(listed.counts.official, 1);
  assert.equal(listed.questions[0].groupQuestionCount, 4);

  const offline = store.transitionMany([created[0].id], "offline", "题库编辑");
  assert.equal(offline.length, 4);
  assert.equal(offline.every((question) => question.status === "offline"), true);
  const restored = store.transitionMany([created[2].id], "restore", "题库编辑");
  assert.equal(restored.every((question) => question.status === "official"), true);
  const deleted = store.deleteMany([created[1].id]);
  assert.equal(deleted.deleted.length, 4);
  assert.equal(store.list({ library: "official" }).questions.length, 0);
});

test("merged source questions leave active lists and remain immutable audit records", () => {
  const source = {
    ...baseQuestion,
    id: "question-merged-source",
    stem: "归档源题的旧表述（ ）。",
    library: "official",
    status: "offline",
    version: 4,
    updatedAt: 400,
    mergedIntoQuestionId: "question-canonical-target",
    merge: { type: "duplicate", targetQuestionId: "question-canonical-target" },
  };
  const target = {
    ...baseQuestion,
    id: "question-canonical-target",
    stem: "规范题的正确表述（ ）。",
    library: "official",
    status: "official",
    version: 2,
    updatedAt: 300,
  };
  const other = {
    ...baseQuestion,
    id: "question-unrelated",
    stem: "与合并无关的题目（ ）。",
    library: "official",
    status: "official",
    version: 1,
    updatedAt: 200,
  };
  const store = createMemoryQuestionStore([source, target, other]);

  assert.deepEqual(store.list({ library: "official", status: "all" }).questions.map((question) => question.id), [target.id, other.id]);
  assert.equal(store.list({ library: "official", status: "all" }).counts.offline, 0);
  assert.equal(store.list({ library: "official", status: "all", includeMergedSources: true }).questions.some((question) => question.id === source.id), true);
  assert.throws(() => store.update(source.id, { stem: "不应写入的编辑" }), /question_merged_source_read_only/);
  assert.throws(() => store.transition(source.id, "restore"), /question_merged_source_read_only/);
  assert.throws(() => store.transitionMany([other.id, source.id], "offline"), /question_merged_source_read_only/);
  assert.equal(store.get(other.id).status, "official");
  assert.throws(() => store.transitionMany([other.id], "publish"), /question_transition_invalid/);
  assert.throws(() => store.deleteMany([source.id]), /question_merged_source_read_only/);
  assert.throws(() => store.deleteMany([target.id]), /question_merge_target_delete_forbidden/);
  const [duplicate] = store.previewImport([{ ...baseQuestion, stem: source.stem }]);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.duplicateOf, target.id);
  assert.equal(duplicate.existingQuestion.id, target.id);
  assert.equal(store.get(source.id).version, 4);
  assert.equal(store.get(target.id).version, 2);
});

test("subjective questions can be imported before scoring points are completed", () => {
  const store = createMemoryQuestionStore([]);
  const mismatched = store.create({
    ...baseQuestion,
    type: "short_answer",
    options: [],
    correctAnswer: [],
    maxScore: 10,
    scoringPoints: [{ description: "定义准确", score: 4 }],
  });
  assert.equal(mismatched.scoringPointStatus, "score_mismatch");

  const naturallyNumbered = store.create({
    ...baseQuestion,
    id: "subjective-numbered-answer",
    type: "short_answer",
    options: [],
    correctAnswer: [],
    referenceAnswer: "（1）说明标准音。（2）说明基础方言。（3）说明语法规范。",
    maxScore: 10,
    scoringPoints: [],
  });
  assert.equal(naturallyNumbered.scoringPointStatus, "needs_score_allocation");
  assert.equal(naturallyNumbered.scoringPointCandidates.length, 3);

  const continuousAnswer = store.create({
    ...baseQuestion,
    id: "subjective-continuous-answer",
    type: "short_answer",
    options: [],
    correctAnswer: [],
    referenceAnswer: "普通话以北京语音为标准音，以北方话为基础方言。",
    maxScore: 10,
    scoringPoints: [],
  });
  assert.equal(continuousAnswer.scoringPointStatus, "needs_split");
  assert.deepEqual(continuousAnswer.scoringPointCandidates, []);

  const question = store.create({
    ...baseQuestion,
    type: "short_answer",
    options: [],
    correctAnswer: [],
    maxScore: 10,
    scoringPoints: [
      { description: "定义准确", score: 4, textbookPage: "3-5", pageBasis: "confirmed_catalog", sourceNote: "《现代汉语》 · 绪论" },
      { description: "三项规范完整", score: 6, textbookPage: "5", pageBasis: "textbook_text", sourceNote: "《现代汉语》第 5 页正文" },
    ],
  });
  assert.equal(question.scoringPoints.length, 2);
  assert.equal(question.scoringPoints[0].textbookPage, "3-5");
  assert.equal(question.scoringPoints[0].pageBasis, "confirmed_catalog");
  assert.equal(question.scoringPoints[1].sourceNote, "《现代汉语》第 5 页正文");
  assert.equal(question.scoringPointStatus, "complete");
});

test("questions preserve three answer variants and annotation response settings", () => {
  const store = createMemoryQuestionStore([]);
  const question = store.create({
    ...baseQuestion,
    type: "material_analysis",
    options: [],
    correctAnswer: [],
    referenceAnswer: "划出主语“小王”。",
    answerVariants: {
      official: "划出主语“小王”。",
      ai: "在“小王”下方添加下划线。",
      community: "主语是“小王”。",
    },
    hiddenAnswerVariants: ["community", "invalid", "community"],
    responseMode: "annotation",
    annotationText: "小王认真完成了练习。",
    material: "材料中小王认真完成了练习。",
    materialMarks: [{ type: "underline", text: "小王认真完成了练习。" }],
    scoringPoints: [{ description: "正确标出主语", score: 2 }],
  });
  assert.equal(question.answerVariants.official, "划出主语“小王”。");
  assert.equal(question.answerVariants.ai, "在“小王”下方添加下划线。");
  assert.equal(question.answerVariants.community, "主语是“小王”。");
  assert.deepEqual(question.hiddenAnswerVariants, ["community"]);
  assert.equal(question.responseMode, "annotation");
  assert.equal(question.annotationText, "小王认真完成了练习。");
  assert.deepEqual(question.materialMarks, [{ type: "underline", text: "小王认真完成了练习。", occurrence: 1 }]);
});

test("partial question updates preserve material, response and preview settings", () => {
  const store = createMemoryQuestionStore([]);
  const question = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-2",
    chapter: "第四章 语法",
    knowledgePoints: ["复句"],
    type: "material_analysis",
    stem: "按要求标记句子。",
    referenceAnswer: "应在指定位置添加波浪线。",
    scoringPoints: [{ description: "标记正确", score: 4 }],
    maxScore: 4,
    material: "共享材料",
    materialGroupId: "material-1",
    subNumber: "（4）",
    usesSharedMaterial: true,
    responseMode: "annotation",
    annotationText: "哪怕出于好意，批评也要适度。",
    freePreview: { question: true, answer: true, analysis: false },
  });
  const updated = store.update(question.id, {
    maxScore: 5,
    scoringPoints: [{ description: "标记正确", score: 5 }],
  });
  assert.equal(updated.material, "共享材料");
  assert.equal(updated.subNumber, "4");
  assert.equal(updated.usesSharedMaterial, true);
  assert.equal(updated.responseMode, "annotation");
  assert.equal(updated.annotationText, "哪怕出于好意，批评也要适度。");
  assert.deepEqual(updated.freePreview, { question: true, answer: true, analysis: false });
});

test("question store persists explicit knowledge signals and resolves their group-relative difficulty", () => {
  const store = createMemoryQuestionStore([]);
  store.create({
    ...baseQuestion,
    id: "knowledge-basic",
    primaryKnowledgePoint: "现代汉语共同语",
    subKnowledgePoints: ["标准音"],
    knowledgeDepthScore: 20,
    contentObscurityScore: 15,
  });
  store.create({
    ...baseQuestion,
    id: "knowledge-deep",
    stem: "现代汉民族共同语的形成经历了哪些关键阶段？",
    primaryKnowledgePoint: "现代汉语共同语",
    subKnowledgePoints: ["共同语形成过程"],
    knowledgeDepthScore: 80,
    contentObscurityScore: 70,
  });
  const questions = store.list({ library: "official" }).questions;
  const basic = questions.find((question) => question.id === "knowledge-basic");
  const deep = questions.find((question) => question.id === "knowledge-deep");
  assert.equal(deep.primaryKnowledgePoint, "现代汉语共同语");
  assert.deepEqual(deep.subKnowledgePoints, ["共同语形成过程"]);
  assert.equal(deep.knowledgeDepthScore, 80);
  assert.equal(deep.contentObscurityScore, 70);
  assert.ok(deep.difficultyScore > basic.difficultyScore);
});

test("multiple-choice questions preserve explicit zero-score partial rules", () => {
  const store = createMemoryQuestionStore([]);
  const question = store.create({
    ...baseQuestion,
    type: "multiple_choice",
    correctAnswer: ["A", "B"],
    maxScore: 3,
    scoringPolicy: {
      mode: "double_choice_no_partial",
      oneCorrectScore: 1,
      allCorrectScore: 3,
      extraOptionScore: 0,
      emptyScore: 0,
    },
  });
  assert.equal(question.scoringPolicy.mode, "double_choice_no_partial");
  assert.equal(question.scoringPolicy.oneCorrectScore, 0);
  assert.equal(question.scoringPolicy.allCorrectScore, 3);
});

test("AI answers can enter an internal draft while preserving review status", () => {
  const store = createMemoryQuestionStore([]);
  const pending = store.create({
    ...baseQuestion,
    answerSource: "ai_supplement",
    answerReviewStatus: "doubtful",
    answerVerified: false,
  });
  assert.equal(pending.status, "pending_review");
  assert.equal(pending.answerReviewStatus, "doubtful");
  assert.equal(pending.answerVerified, false);

  const verified = store.update(pending.id, { answerReviewStatus: "verified", answerVerified: true });
  assert.equal(verified.status, "official");
  assert.equal(verified.answerReviewStatus, "verified");
  assert.equal(verified.answerVerified, true);
});

test("question imports skip exact duplicates and batch deletion removes selected questions", () => {
  const store = createMemoryQuestionStore([]);
  const firstImport = store.importMany([baseQuestion]);
  assert.equal(firstImport.created.length, 1);

  const duplicatePreview = store.previewImport([{
    ...baseQuestion,
    stem: `  ${baseQuestion.stem}  `,
  }]);
  assert.equal(duplicatePreview[0].duplicate, true);
  assert.equal(duplicatePreview[0].error, "question_duplicate");
  assert.equal(duplicatePreview[0].question.stem, baseQuestion.stem);
  assert.equal(duplicatePreview[0].existingQuestion.id, firstImport.created[0].id);
  assert.equal(duplicatePreview[0].existingQuestion.referenceAnswer, baseQuestion.referenceAnswer);

  const secondImport = store.importMany([baseQuestion]);
  assert.equal(secondImport.created.length, 0);
  assert.equal(secondImport.duplicates.length, 1);
  assert.equal(secondImport.errors.length, 0);
  assert.equal(store.list({ library: "official" }).questions.length, 1);

  const deletion = store.deleteMany([firstImport.created[0].id, "missing-question"]);
  assert.equal(deletion.deleted.length, 1);
  assert.deepEqual(deletion.notFoundIds, ["missing-question"]);
  assert.equal(store.list({ library: "official" }).questions.length, 0);
});

test("question imports reject the same stem even when corrected options differ", () => {
  const store = createMemoryQuestionStore([]);
  const original = {
    ...baseQuestion,
    stem: "e和ê的区别在于（ ）。",
    options: [{ key: "A", text: "舌位高低不同" }, { key: "B", text: "舌位前后不同" }],
    correctAnswer: ["B"],
  };
  store.create(original);
  const corrected = {
    ...original,
    id: "question-corrected-options",
    options: [{ key: "A", text: "舌位高低不同" }, { key: "B", text: "舌位前后不同" }, { key: "C", text: "唇形不同" }],
  };
  const [preview] = store.previewImport([corrected]);
  assert.equal(preview.duplicate, true);
  assert.equal(preview.error, "question_duplicate");
});

test("question import preview distinguishes stored questions from duplicates inside the same batch", () => {
  const store = createMemoryQuestionStore([]);
  const first = { ...baseQuestion, id: "question-batch-first", stem: "同一批次重复题应如何标记？" };
  const second = { ...first, id: "question-batch-second", referenceAnswer: "这是本批的第二份内容。" };
  const preview = store.previewImport([first, second]);

  assert.equal(preview[0].valid, true);
  assert.equal(preview[1].duplicate, true);
  assert.equal(preview[1].duplicateScope, "batch");
  assert.equal(preview[1].duplicateIndex, 0);
  assert.equal(preview[1].existingQuestion.id, first.id);

  store.importMany([first]);
  const [storedDuplicate] = store.previewImport([{ ...second, id: "question-stored-duplicate" }]);
  assert.equal(storedDuplicate.duplicateScope, "stored");
  assert.equal(storedDuplicate.duplicateIndex, null);
});

test("import batches can be filtered and moved to another subject with versions preserved", () => {
  const store = createMemoryQuestionStore([]);
  const imported = store.importMany([
    { ...baseQuestion, id: "batch-question-1", stem: "批次题目一" },
    { ...baseQuestion, id: "batch-question-2", stem: "批次题目二" },
  ]);
  assert.match(imported.batchId, /^question-import-/);
  assert.equal(store.importBatches()[0].count, 2);
  assert.equal(store.list({ importBatchId: imported.batchId }).questions.length, 2);

  const updated = store.updateImportBatch(imported.batchId, {
    subjectId: "contemporary-literature",
    bookId: "contemporary-literature-history-3",
  });
  assert.equal(updated.updated.length, 2);
  assert.equal(updated.batch.subjectId, "contemporary-literature");
  assert.equal(updated.updated[0].version, 2);
  assert.equal(updated.updated[0].versions[0].changeNote, "批次统一修改科目与教材");
  assert.equal(updated.updated[0].stem.startsWith("批次题目"), true);
});
