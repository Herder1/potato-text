/**
 * 材料题组分值分配（产品手册 §4.6.7 / DEC-099）——纯函数口径回归。
 *
 * 覆盖产品负责人 2026-09-25 确认的十项里的可计算部分：
 *   1) 步长：1 分；总分 0.5 结尾退回 0.5；
 *   2) 守恒：各小问之和严格等于题组总分；
 *   3) 原卷写明的小问分值最优先，不被均分覆盖；
 *   4) 依据得分点数分配（多点多分），无得分点时均分占位 + 待核对；
 *   5) 人工已改过的小问跳过，AI 只在剩余小问之间分配剩余分值；
 *   6) 没有总分时不编造（各问保持现值/0 并标待核对）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  declaredScoreOf,
  hasDeclaredScore,
  endsWithHalf,
  stepForTotal,
  distributeUnits,
  planMaterialGroupScores,
} = require("../apps/api/src/material-score-allocation");
const { splitMaterialQuestion } = require("../apps/api/src/material-question-split");
const { expandLegacyMaterialQuestions } = require("../apps/api/src/exam-import-store");

test("步长口径：题组总分 0.5 结尾退回 0.5，其余一律 1 分", () => {
  assert.equal(endsWithHalf(13.5), true);
  assert.equal(endsWithHalf(14), false);
  assert.equal(stepForTotal(13.5), 0.5);
  assert.equal(stepForTotal(14), 1);
  assert.equal(stepForTotal(0), 1, "没有总分时步长取 1（不产生 0.5 的假精度）");
});

test("原卷写明的小问分值优先，不再被均分覆盖（14 分 4 问：3/4/3/4 不再被抹成 3.5×4）", () => {
  const plan = planMaterialGroupScores({
    groupTotal: 14,
    items: [
      { id: "1", declaredScore: 3 },
      { id: "2", declaredScore: 4 },
      { id: "3", declaredScore: 3 },
      { id: "4", declaredScore: 4 },
    ],
  });
  assert.deepEqual(plan.allocations.map((item) => item.score), [3, 4, 3, 4]);
  assert.equal(plan.allocatedTotal, 14);
  assert.equal(plan.conserved, true);
  assert.equal(plan.placeholder, false, "原卷写明了分值就不该标成占位");
  assert.equal(plan.needsReview, false);
  assert.deepEqual(plan.allocations.map((item) => item.basis), ["declared", "declared", "declared", "declared"]);
});

test("原卷分值识别：认得（3分）／3分／（本小题 3 分），读不到就是 null（绝不猜）", () => {
  assert.equal(declaredScoreOf("分析文中加点词“伟大”的词性。（3分）"), 3);
  assert.equal(declaredScoreOf("指出材料中“理性的光辉”的结构类型。 4 分"), 4);
  assert.equal(declaredScoreOf("分析划线句子的层次。本小题 4 分"), 4);
  assert.equal(declaredScoreOf("从构词法看词语“国家”是什么类型？"), null);
  assert.equal(hasDeclaredScore("分析划线句子的层次。（3 分）"), true);
  assert.equal(hasDeclaredScore("分析划线句子的层次。"), false);
});

test("没有得分点时均分占位 + 标待核对（14 分 4 问 → 4/4/3/3，和严格等于 14）", () => {
  const plan = planMaterialGroupScores({
    groupTotal: 14,
    items: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
  });
  assert.equal(plan.allocatedTotal, 14, "占位也必须守恒");
  assert.equal(plan.conserved, true);
  assert.equal(plan.placeholder, true);
  assert.equal(plan.needsReview, true);
  assert.deepEqual(plan.allocations.map((item) => item.score).sort((a, b) => b - a), [4, 4, 3, 3]);
  assert.match(plan.warnings.join("；"), /还没有得分点/);
});

test("按得分点数分配：要点多的小问分得多（13.5 分 3 问、1/2/6 个要点）", () => {
  const plan = planMaterialGroupScores({
    groupTotal: 13.5,
    items: [
      { id: "1", scoringPointCount: 1 },
      { id: "2", scoringPointCount: 2 },
      { id: "3", scoringPointCount: 6 },
    ],
  });
  assert.equal(plan.step, 0.5, "0.5 结尾的题组退回 0.5 步长");
  assert.equal(plan.allocatedTotal, 13.5);
  assert.equal(plan.conserved, true);
  assert.equal(plan.placeholder, false);
  const scores = plan.allocations.map((item) => item.score);
  assert.ok(scores[2] > scores[1] && scores[1] > scores[0], `要点多的应分得多，实际 ${scores.join("/")}`);
});

test("分配是整数步长、加起来严格等于总分（不出现 0.5 的碎分）", () => {
  const plan = planMaterialGroupScores({
    groupTotal: 14,
    items: [{ id: "1", scoringPointCount: 3 }, { id: "2", scoringPointCount: 5 }, { id: "3", scoringPointCount: 2 }],
  });
  assert.deepEqual(plan.allocations.map((item) => item.score), [4, 7, 3], "权重 3/5/2 按最大余额法分 14 分：精确值 4.2/7.0/2.8 → 余数 0.8 的那问进位");
  assert.equal(plan.allocatedTotal, 14);
  plan.allocations.forEach((item) => assert.equal(Number.isInteger(item.score), true, `${item.score} 应是整数分`));
});

test("人工已改过的小问跳过重算，AI 只在剩余小问之间分配剩余分值", () => {
  const plan = planMaterialGroupScores({
    groupTotal: 14,
    items: [
      { id: "1", locked: true, currentScore: 5 },
      { id: "2", scoringPointCount: 1 },
      { id: "3", scoringPointCount: 3 },
      { id: "4", scoringPointCount: 0 },
    ],
  });
  assert.equal(plan.allocations[0].score, 5, "人工改过的分值原样保留");
  assert.equal(plan.allocations[0].basis, "locked");
  assert.equal(plan.allocatedTotal, 14);
  assert.equal(plan.conserved, true);
  assert.ok(plan.allocations[1].score + plan.allocations[2].score + plan.allocations[3].score === 9, "剩余 9 分在其余三问之间分配");
});

test("没有题组总分时不编造：各问保持 0 并标待核对", () => {
  const plan = planMaterialGroupScores({ groupTotal: 0, items: [{ id: "1" }, { id: "2" }] });
  assert.equal(plan.ok, false);
  assert.equal(plan.needsReview, true);
  assert.equal(plan.placeholder, true);
  assert.deepEqual(plan.allocations.map((item) => item.score), [0, 0]);
  assert.match(plan.warnings.join("；"), /没有题组总分/);
});

test("原卷分值之和超出题组总分时不静默：如实报冲突", () => {
  const plan = planMaterialGroupScores({
    groupTotal: 10,
    items: [{ id: "1", declaredScore: 6 }, { id: "2", declaredScore: 6 }],
  });
  assert.equal(plan.conserved, false);
  assert.equal(plan.needsReview, true);
  assert.match(plan.warnings.join("；"), /请人工核对原卷分值|不一致/);
});

test("最大余额法：单位之和永远等于应分配的单位数", () => {
  for (const units of [1, 2, 3, 7, 13, 26]) {
    for (const weights of [[1, 1, 1], [1, 2, 6], [5, 1], [1, 1, 1, 1, 1, 1, 1]]) {
      const result = distributeUnits(units, weights);
      assert.equal(result.reduce((sum, value) => sum + value, 0), units, `units=${units} weights=${weights.join(",")}`);
      if (units >= weights.length) {
        assert.ok(result.every((value) => value >= 1), `每问至少 1 个单位：${result.join(",")}`);
      }
    }
  }
});

test("拆分链路：原卷写明小问分值时照抄，均分不再覆盖", () => {
  const result = splitMaterialQuestion({
    stem: "阅读下面的材料，回答问题。\n（1）分析划线句的层次。（3分）\n（2）说明“国家”的构词类型。（4分）\n（3）指出加点词的词性并说明依据。（4分）",
    maxScore: 11,
    referenceAnswer: "（1）略。\n（2）略。\n（3）略。",
  });
  assert.equal(result.split, true);
  assert.deepEqual(result.subQuestions.map((item) => item.maxScore), [3, 4, 4]);
  assert.deepEqual(result.subQuestions.map((item) => item.scoreBasis), ["declared", "declared", "declared"]);
  assert.equal(result.scoreAllocation.conserved, true);
  assert.equal(result.scoreAllocation.placeholder, false);
  assert.match(result.warning, /原卷写明的小问分值/);
});

test("拆分链路：原卷没写小问分值且尚无得分点 → 均分占位并明确标「分值待核对」（14 分 4 问）", () => {
  const result = splitMaterialQuestion({
    stem: "阅读下面的材料，回答问题。\n（1）用“竖线标记法”对画横线的句子进行层次分析，并指出各层次之间的关系。\n（2）从构词法看，画波浪线的词语“国家”是什么类型的合成词？\n（3）分析短语“撸起袖子”“实践表明”的结构类型。\n（4）分析文中加点词“伟大”的词性，并说明判断的依据是什么。",
    maxScore: 14,
    referenceAnswer: "（1）略。\n（2）略。\n（3）略。\n（4）略。",
  });
  assert.equal(result.split, true);
  const scores = result.subQuestions.map((item) => item.maxScore);
  assert.equal(scores.reduce((sum, value) => sum + value, 0), 14, "占位也必须严格守恒");
  assert.deepEqual([...scores].sort((a, b) => b - a), [4, 4, 3, 3]);
  assert.ok(result.subQuestions.every((item) => item.scoreBasis === "placeholder"));
  assert.equal(result.scoreAllocation.placeholder, true);
  assert.equal(result.scoreAllocation.needsReview, true);
  assert.match(result.warning, /分值待核对/);
});

test("拆分链路：原稿没有总分时不编造分值（沿用 emptyScoreFallback）", () => {
  const result = splitMaterialQuestion({
    stem: "阅读下面的材料，回答问题。\n（1）第一问。\n（2）第二问。",
    maxScore: 0,
    emptyScoreFallback: 0,
    referenceAnswer: "（1）略。\n（2）略。",
  });
  assert.equal(result.split, true);
  assert.deepEqual(result.subQuestions.map((item) => item.maxScore), [0, 0]);
  assert.deepEqual(result.subQuestions.map((item) => item.scoreBasis), ["missing", "missing"]);
  assert.match(result.warning, /原稿没有分值/);
});

test("科目默认题组满分兜底（DEC-099 修订）：不传默认值 → 不兜底；传了 → 按它分配并标待核对", () => {
  const base = {
    stem: "阅读下面的材料，回答问题。\n（1）第一问。\n（2）第二问。\n（3）第三问。\n（4）第四问。",
    maxScore: 0,
    referenceAnswer: "（1）略。\n（2）略。\n（3）略。\n（4）略。",
  };
  const withoutDefault = splitMaterialQuestion({ ...base, emptyScoreFallback: 0 });
  assert.deepEqual(withoutDefault.subQuestions.map((item) => item.maxScore), [0, 0, 0, 0]);
  assert.equal(withoutDefault.scoreAllocation.totalBasis, "missing");

  const withDefault = splitMaterialQuestion({ ...base, defaultGroupTotal: 20, emptyScoreFallback: 0 });
  assert.deepEqual(withDefault.subQuestions.map((item) => item.maxScore), [5, 5, 5, 5]);
  assert.equal(withDefault.scoreAllocation.totalBasis, "default");
  assert.equal(withDefault.scoreAllocation.groupTotal, 20);
  assert.equal(withDefault.scoreAllocation.conserved, true);
  assert.equal(withDefault.scoreAllocation.needsReview, true);
  assert.deepEqual(withDefault.subQuestions.map((item) => item.scoreBasis), ["placeholder", "placeholder", "placeholder", "placeholder"]);
  assert.match(withDefault.warning, /科目默认材料题组满分 20 分/);

  // 卷面写了题组总分 → 以卷面为准，默认值不参与
  const declaredBeatsDefault = splitMaterialQuestion({ ...base, maxScore: 15, defaultGroupTotal: 20, emptyScoreFallback: 0 });
  assert.equal(declaredBeatsDefault.scoreAllocation.totalBasis, "source");
  assert.equal(declaredBeatsDefault.subQuestions.reduce((sum, item) => sum + item.maxScore, 0), 15);
});

test("试卷导入链路：归一化补的 1 分不算卷面总分，按科目默认满分兜底（回归 2026-09-25 实测缺陷）", () => {
  const rows = expandLegacyMaterialQuestions([
    {
      localId: "legacy-no-score",
      number: "378",
      type: "material_analysis",
      subjectId: "classical-chinese",
      stem: "阅读下面的材料，回答问题。\n（1）第一问。\n（2）第二问。\n（3）第三问。\n（4）第四问。",
      referenceAnswer: "（1）略。\n（2）略。\n（3）略。\n（4）略。",
      warnings: [],
    },
  ]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((item) => item.maxScore), [5, 5, 5, 5], "古汉默认 20 分 4 问");
  assert.equal(rows.reduce((sum, item) => sum + item.maxScore, 0), 20);
  assert.ok(rows.every((item) => item.scoreNeedsReview === true));

  // 卷面真写了总分（14）→ 照卷面走，不被默认值改写
  const declared = expandLegacyMaterialQuestions([
    {
      localId: "legacy-declared",
      number: "379",
      type: "material_analysis",
      subjectId: "modern-chinese",
      stem: "阅读下面的材料，回答问题。\n（1）第一问。\n（2）第二问。\n（3）第三问。\n（4）第四问。",
      referenceAnswer: "（1）略。\n（2）略。\n（3）略。\n（4）略。",
      maxScore: 14,
      warnings: [],
    },
  ]);
  assert.equal(declared.reduce((sum, item) => sum + item.maxScore, 0), 14);
});
