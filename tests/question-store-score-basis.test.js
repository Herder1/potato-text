/**
 * 题目 Store 的「分值来源 + 分值待核对」字段回归（DEC-099 / 产品手册 §4.6.7）。
 *
 * 落库口径（本文件是它的回归）：
 *   · `scoreBasis` ∈ declared|locked|points|placeholder|missing，别的值一律归一化成空串；
 *   · `scoreNeedsReview` 一律是真布尔；
 *   · **旧题（历史数据没有这两个字段）读出来是 scoreBasis="" / scoreNeedsReview=false**——向后兼容；
 *   · 人工改过分值 ⇒ scoreBasis=locked、scoreNeedsReview=false（重新分配时跳过它，DEC-099 ⑥/⑧）；
 *   · 只是把同一个分值跟着表单重提交 ⇒ 不算人工改过（否则一次无关编辑会让整组再也不会被重新分配）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { SCORE_BASES, normalizeScoreBasis } = require("../apps/api/src/material-score-allocation");

const baseQuestion = {
  subjectId: "modern-chinese",
  bookId: "modern-chinese-7-1",
  chapter: "第一章 绪论",
  knowledgePoints: ["现代汉语共同语"],
  type: "short_answer",
  stem: "普通话的定义是什么？",
  referenceAnswer: "普通话是现代汉民族共同语。",
  maxScore: 4,
};

test("分值来源词汇只在分配内核定义一处（值域固定五种）", () => {
  assert.deepEqual(SCORE_BASES, ["declared", "locked", "points", "placeholder", "missing"]);
  assert.equal(normalizeScoreBasis("points"), "points");
  assert.equal(normalizeScoreBasis("  声明 "), "", "不认识的值不猜，一律空串");
  assert.equal(normalizeScoreBasis(undefined), "");
});

test("新建题目带上分值来源与待核对标记，读回来是同一份", () => {
  const store = createMemoryQuestionStore([]);
  const created = store.create({
    ...baseQuestion,
    id: "grouped-1",
    questionGroupId: "material:batch-a:392:mg-392",
    subNumber: "1",
    groupOrder: 1,
    scoreBasis: "placeholder",
    scoreNeedsReview: true,
  });
  assert.equal(created.scoreBasis, "placeholder");
  assert.equal(created.scoreNeedsReview, true);
  const reloaded = store.get("grouped-1");
  assert.equal(reloaded.scoreBasis, "placeholder");
  assert.equal(reloaded.scoreNeedsReview, true);
  assert.equal(reloaded.maxScore, 4);
});

test("历史题目（没有这两个字段）读出来是空串与 false，不改变任何既有字段语义", () => {
  const store = createMemoryQuestionStore([{ ...baseQuestion, id: "legacy-question" }]);
  const legacy = store.get("legacy-question");
  assert.equal(legacy.scoreBasis, "", "旧题的分值来源留空，不冒充任何一种来源");
  assert.equal(legacy.scoreNeedsReview, false, "旧题不因为新增字段被标成待核对");
  assert.equal(legacy.maxScore, 4);
  assert.deepEqual(legacy.knowledgePoints, ["现代汉语共同语"]);
  // 存量数据里的脏值（不是五种之一 / 不是布尔）也要读成合法类型，管理端不必自己判 undefined。
  const dirty = createMemoryQuestionStore([
    { ...baseQuestion, id: "dirty-basis", scoreBasis: "ai-guess", scoreNeedsReview: "yes" },
  ]).get("dirty-basis");
  assert.equal(dirty.scoreBasis, "");
  assert.equal(dirty.scoreNeedsReview, false);
});

test("人工改过分值 ⇒ 记为 locked 并清掉「分值待核对」；重提交同一个分值不算改过", () => {
  const store = createMemoryQuestionStore([{
    ...baseQuestion,
    id: "manual-score",
    scoreBasis: "placeholder",
    scoreNeedsReview: true,
  }]);
  const edited = store.update("manual-score", { maxScore: 6, changeNote: "人工核对分值" });
  assert.equal(edited.maxScore, 6);
  assert.equal(edited.scoreBasis, "locked");
  assert.equal(edited.scoreNeedsReview, false);

  // 编辑题干时表单会把同一个分值一起提交回来：这不代表"人工定了分值"，否则整组会在一次无关编辑后集体锁死。
  const resubmitted = store.update("manual-score", { maxScore: 6, stem: "普通话的定义是什么？（改写）", changeNote: "编辑题干" });
  assert.equal(resubmitted.scoreBasis, "locked", "上一次的人工改动仍然记着");
  assert.equal(resubmitted.scoreNeedsReview, false);

  const fromPoints = createMemoryQuestionStore([{
    ...baseQuestion,
    id: "points-score",
    scoreBasis: "points",
    scoreNeedsReview: false,
  }]);
  const untouched = fromPoints.update("points-score", { maxScore: 4, stem: "换个说法？", changeNote: "编辑题干" });
  assert.equal(untouched.scoreBasis, "points", "分值没变 ⇒ 依据照旧是「按得分点分配」");
});

test("整组采纳可以显式写分值来源与待核对标记（显式优先于推导）", () => {
  const store = createMemoryQuestionStore([{
    ...baseQuestion,
    id: "adopted-1",
    scoreBasis: "placeholder",
    scoreNeedsReview: true,
  }]);
  const adopted = store.update("adopted-1", {
    maxScore: 5,
    scoreBasis: "declared",
    scoreNeedsReview: false,
    changeNote: "材料题组分值分配（整组采纳）",
  });
  assert.equal(adopted.scoreBasis, "declared", "原卷写明的分值不该被当成「人工改过」");
  assert.equal(adopted.scoreNeedsReview, false);
  const illegal = store.update("adopted-1", { scoreBasis: "whatever", changeNote: "非法值" });
  assert.equal(illegal.scoreBasis, "", "显式传了非法值 ⇒ 归一化成空串，不写脏数据");
});

test("材料题组的小问各自独立持有分值来源，题组合计由小问现值派生", () => {
  const store = createMemoryQuestionStore([]);
  const groupId = "material:batch-a:392:mg-392";
  [1, 2, 3].forEach((index) => store.create({
    ...baseQuestion,
    id: `sub-${index}`,
    stem: `第 ${index} 问：概述要点。`,
    questionGroupId: groupId,
    questionGroupTitle: "第392题 · 材料题组",
    groupNumber: "392",
    subNumber: String(index),
    groupOrder: index,
    maxScore: index === 3 ? 2 : 4,
    scoreBasis: "placeholder",
    scoreNeedsReview: true,
  }));
  const listed = store.list({ library: "official", status: "all" }).questions;
  assert.equal(listed.length, 3);
  assert.ok(listed.every((question) => question.scoreBasis === "placeholder" && question.scoreNeedsReview === true));
  assert.ok(listed.every((question) => question.questionGroupId === groupId));
  assert.equal(listed[0].groupTotalScore, 10, "题组合计＝各小问现值之和（4+4+2）");
  assert.equal(listed[0].groupQuestionCount, 3);
});
