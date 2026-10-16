/**
 * 材料题组「整组取数 + 整组分值规划」回归（DEC-099 / 产品手册 §4.6.7）。
 *
 * 本文件只测 material-group-score.js 这一层（纯函数，不碰 Store、不碰 HTTP）：
 *   ① 成员小问怎么挑、怎么排、各带哪些事实（得分点数/当前分值/原卷分值/是否人工已改）；
 *   ② 题组总分从哪来：请求显式给定 → 本组现有合计 → 该科目默认满分（DEC-099 ⑪）→ 没有（标待核对）；
 *   ③ 人工已改过的小问被跳过、只在其余小问之间分配剩余分值（DEC-099 ⑥/⑧）；
 *   ④ 组内一致性（强制同科目 + 同教材，DEC-099 ⑨）与 0.5 结尾题组的步长回落（DEC-099 ⑤/⑥）。
 *
 * 分配算法本身（守恒、最大余额法、步长）已在 material-score-allocation.test.js 覆盖，这里不重复。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMaterialGroupScorePlan,
  earliestKnownScore,
  isLockedMember,
  materialGroupConsistencyIssues,
  materialGroupMembers,
  resolveGroupTotal,
  scoreNeedsReviewForBasis,
} = require("../apps/api/src/material-group-score");

const GROUP_ID = "material:batch-a:392:mg-392";

function memberQuestion(overrides = {}) {
  return {
    id: "q-1",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    type: "material_analysis",
    questionGroupId: GROUP_ID,
    questionGroupTitle: "第392题 · 材料题组",
    groupNumber: "392",
    subNumber: "1",
    groupOrder: 1,
    stem: "分析材料中加点词的词性。",
    maxScore: 4,
    scoreBasis: "placeholder",
    scoreNeedsReview: true,
    scoringPoints: [],
    ...overrides,
  };
}

const FOUR_SUB_QUESTIONS = [
  memberQuestion({ id: "q-1", subNumber: "1", groupOrder: 1, stem: "分析加点词“伟大”的词性。（3分）", scoringPoints: [{ description: "词性", score: 3 }] }),
  memberQuestion({ id: "q-2", subNumber: "2", groupOrder: 2, stem: "说明理由。" }),
  memberQuestion({ id: "q-3", subNumber: "3", groupOrder: 3, stem: "改病句。" }),
  memberQuestion({ id: "q-4", subNumber: "4", groupOrder: 4, stem: "概括主旨。" }),
];

test("成员小问按小问顺序取出，并带上得分点数、当前分值、原卷分值、是否人工已改", () => {
  const members = materialGroupMembers([
    memberQuestion({ id: "q-3", subNumber: "3", groupOrder: 3 }),
    { ...memberQuestion({ id: "outsider" }), questionGroupId: "material:batch-a:392:other" },
    memberQuestion({ id: "q-1", subNumber: "1", groupOrder: 1, stem: "分析加点词“伟大”的词性。（3分）", scoringPoints: [{ description: "词性", score: 3 }, { description: "理由", score: 1 }], scoreBasis: "locked", scoreNeedsReview: false }),
    memberQuestion({ id: "q-2", subNumber: "2", groupOrder: 2 }),
  ], GROUP_ID);
  assert.deepEqual(members.map((member) => member.id), ["q-1", "q-2", "q-3"], "只取本题组的，且按小问号排序");
  assert.equal(members[0].scoringPointCount, 2);
  assert.equal(members[0].declaredScore, 3, "题干写明（3分）⇒ 读得出原卷分值");
  assert.equal(members[1].declaredScore, null, "题干没写分值 ⇒ null，绝不猜");
  assert.equal(members[0].locked, true, "落库 scoreBasis=locked ⇒ 人工已改过");
  assert.equal(members[1].locked, false);
  assert.equal(members[1].currentScore, 4);
  assert.equal(members[1].subjectId, "modern-chinese");
  assert.equal(materialGroupMembers(FOUR_SUB_QUESTIONS, "").length, 0, "没有题组号就没有成员");
});

test("人工已改过的小问可用 lockedIds 显式点名（落库 basis 之外的补充通道）", () => {
  assert.equal(isLockedMember({ id: "q-2", scoreBasis: "points" }, new Set(["q-2"])), true);
  assert.equal(isLockedMember({ id: "q-2", scoreBasis: "points" }, new Set()), false);
});

test("题组总分来源：显式给定 > 导入当时本组合计 > 科目默认满分 > 没有", () => {
  const members = [{ maxScore: 4 }, { maxScore: 4 }, { maxScore: 3 }, { maxScore: 3 }];
  assert.deepEqual(resolveGroupTotal(members, 14, 20), { total: 14, basis: "manual" }, "操作者核对后给定，最优先");
  assert.deepEqual(resolveGroupTotal(members, undefined, 20), { total: 14, basis: "recorded" }, "导入当时的合计（守恒 ⇒ 即原卷总分或默认满分）");
  assert.deepEqual(resolveGroupTotal([{ maxScore: 0 }, { maxScore: 0 }], undefined, 20), { total: 20, basis: "default" }, "合计为 0 ⇒ 该科目默认满分兜底（DEC-099 ⑪）");
  assert.deepEqual(resolveGroupTotal([{ maxScore: 0 }], undefined, 0), { total: 0, basis: "missing" }, "连默认值都没有 ⇒ 如实报 missing，不编造");
});

test("整组规划：总分取本组合计、按得分点数分配、每条建议给出依据与是否仍需核对", () => {
  const result = buildMaterialGroupScorePlan({ groupId: GROUP_ID, questions: FOUR_SUB_QUESTIONS, defaultTotal: 14 });
  assert.equal(result.groupTotal, 16, "四问现值 4/4/4/4 合计 16 ⇒ 该组自己的总分");
  assert.equal(result.groupTotalBasis, "recorded");
  assert.equal(result.memberCount, 4);
  assert.equal(result.conserved, true, "各小问之和严格等于题组总分");
  assert.equal(result.allocations.reduce((sum, item) => sum + item.score, 0), 16);
  // 第 1 问原卷写明（3分）⇒ 直接采用，其余按得分点数（都还没有得分点 ⇒ 均分占位）
  assert.equal(result.allocations[0].score, 3);
  assert.equal(result.allocations[0].basis, "declared");
  assert.equal(result.allocations[0].scoreNeedsReview, false, "原卷写明的分值不需要人工核对");
  assert.ok(result.allocations.slice(1).every((item) => item.basis === "placeholder" && item.scoreNeedsReview === true));
  assert.equal(result.placeholder, true);
  assert.equal(result.needsReview, true);
  assert.match(result.warnings.join("；"), /还没有得分点/);
});

test("按得分点数分配：要点多的小问分得多（13.5 分题组退回 0.5 步长，DEC-099 ⑤/⑥）", () => {
  const result = buildMaterialGroupScorePlan({
    groupId: GROUP_ID,
    questions: [
      memberQuestion({ id: "q-1", maxScore: 4.5, scoreBasis: "points", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 4.5 }] }),
      memberQuestion({ id: "q-2", maxScore: 4.5, scoreBasis: "points", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 2 }, { description: "b", score: 2.5 }] }),
      memberQuestion({ id: "q-3", maxScore: 4.5, scoreBasis: "points", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 1 }, { description: "b", score: 1 }, { description: "c", score: 1 }, { description: "d", score: 1 }, { description: "e", score: 0.5 }] }),
    ],
    defaultTotal: 14,
  });
  assert.equal(result.groupTotal, 13.5);
  assert.equal(result.step, 0.5);
  assert.equal(result.allocatedTotal, 13.5);
  assert.equal(result.placeholder, false);
  const scores = result.allocations.map((item) => item.score);
  assert.ok(scores[2] > scores[1] && scores[1] > scores[0], `要点多的应分得多，实际 ${scores.join("/")}`);
  assert.deepEqual(result.allocations.map((item) => item.basis), ["points", "points", "points"]);
  assert.deepEqual(result.allocations.map((item) => item.scoreNeedsReview), [false, false, false]);
});

test("人工已改过的小问被跳过：保留现值，剩余分值只在其余小问之间分配（DEC-099 ⑥/⑧）", () => {
  const result = buildMaterialGroupScorePlan({
    groupId: GROUP_ID,
    questions: [
      memberQuestion({ id: "q-1", maxScore: 5, scoreBasis: "locked", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 5 }] }),
      memberQuestion({ id: "q-2", maxScore: 3, scoreBasis: "points", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 1 }] }),
      memberQuestion({ id: "q-3", maxScore: 3, scoreBasis: "points", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 1 }, { description: "b", score: 1 }, { description: "c", score: 1 }] }),
    ],
    defaultTotal: 14,
  });
  assert.equal(result.groupTotal, 11, "本组合计 5+3+3");
  assert.equal(result.allocations[0].score, 5, "人工已改过的第 1 问保持现值");
  assert.equal(result.allocations[0].basis, "locked");
  assert.equal(result.allocations[0].keepCurrent, true);
  assert.equal(result.allocations[0].scoreNeedsReview, false);
  assert.equal(result.allocations[1].score + result.allocations[2].score, 6, "剩余 6 分只在第 2、3 问之间分");
  assert.ok(result.allocations[2].score > result.allocations[1].score);
  assert.equal(result.conserved, true);
  assert.match(result.warnings.join("；"), /已跳过 1 个人工改过分值的小问/);
});

test("题组总分按导入当时的分配算：人工改分不会把题组总分一起改掉（DEC-099 ⑤/⑥/⑧）", () => {
  assert.equal(earliestKnownScore(memberQuestion({ id: "fresh", maxScore: 4 })), 4, "从未改过（没有快照）⇒ 现值就是导入当时的值");
  const edited = {
    ...memberQuestion({ id: "q-1", maxScore: 5, scoreBasis: "locked", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 5 }] }),
    version: 2,
    versions: [{ version: 2, previousSnapshot: { maxScore: 3 } }, { version: 1 }],
  };
  assert.equal(earliestKnownScore(edited), 3, "回看最早一版快照＝导入当时的分值");

  const result = buildMaterialGroupScorePlan({
    groupId: GROUP_ID,
    questions: [
      edited,
      memberQuestion({ id: "q-2", maxScore: 3, scoreBasis: "points", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 1 }] }),
      memberQuestion({ id: "q-3", maxScore: 3, scoreBasis: "points", scoreNeedsReview: false, scoringPoints: [{ description: "a", score: 1 }] }),
    ],
    defaultTotal: 14,
  });
  assert.equal(result.groupTotal, 9, "导入当时 3+3+3＝9；人工把第 1 问改成 5 之后，题组总分仍是 9");
  assert.equal(result.allocations[0].score, 5, "人工改过的第 1 问保留现值");
  assert.equal(result.allocations[1].score + result.allocations[2].score, 4, "剩余 9−5＝4 分只在其余小问之间分配");
  assert.equal(result.conserved, true, "跳过人工改动之后，各问之和仍严格等于题组总分");
  assert.match(result.warnings.join("；"), /按导入当时的 9 分计/);
});

test("题组总分缺失（合计 0）⇒ 用该科目默认满分兜底并如实标注来源，不静默当成卷面总分", () => {
  const result = buildMaterialGroupScorePlan({
    groupId: GROUP_ID,
    questions: FOUR_SUB_QUESTIONS.map((question) => ({ ...question, maxScore: 0, scoreBasis: "missing", scoreNeedsReview: true })),
    defaultTotal: 14,
  });
  assert.equal(result.groupTotal, 14);
  assert.equal(result.groupTotalBasis, "default");
  assert.equal(result.conserved, true);
  assert.equal(result.needsReview, true, "默认值兜底出来的分配仍要人工核对");
  assert.match(result.warnings.join("；"), /按该科目默认材料题组满分 14 分兜底/);
});

test("连默认满分都没有 ⇒ 待核对、不编造：各小问不写分值并给出可读原因", () => {
  const result = buildMaterialGroupScorePlan({
    groupId: GROUP_ID,
    questions: FOUR_SUB_QUESTIONS.map((question) => ({ ...question, maxScore: 0 })),
    defaultTotal: 0,
  });
  assert.equal(result.groupTotal, 0);
  assert.equal(result.groupTotalBasis, "missing");
  assert.equal(result.plan.ok, false);
  assert.equal(result.needsReview, true);
  assert.ok(result.allocations.every((item) => item.score === 0));
  assert.match(result.warnings.join("；"), /也没有登记默认满分/);
});

test("组内一致性：强制同科目 + 同教材；章节/知识点不同不出错（DEC-099 ⑨）", () => {
  const same = materialGroupMembers(FOUR_SUB_QUESTIONS, GROUP_ID);
  assert.deepEqual(materialGroupConsistencyIssues(same), []);
  const crossSubject = materialGroupMembers([
    memberQuestion({ id: "q-1" }),
    memberQuestion({ id: "q-2", subjectId: "ancient-chinese" }),
  ], GROUP_ID);
  const subjectIssues = materialGroupConsistencyIssues(crossSubject);
  assert.equal(subjectIssues.length, 1);
  assert.equal(subjectIssues[0].code, "material_group_subject_mismatch");
  assert.deepEqual(subjectIssues[0].subjectIds.sort(), ["ancient-chinese", "modern-chinese"]);
  const crossBook = materialGroupMembers([
    memberQuestion({ id: "q-1" }),
    memberQuestion({ id: "q-2", bookId: "modern-chinese-7-2" }),
  ], GROUP_ID);
  assert.equal(materialGroupConsistencyIssues(crossBook)[0].code, "material_group_book_mismatch");
  const chapterDiffers = materialGroupMembers([
    memberQuestion({ id: "q-1", chapter: "第一章" }),
    memberQuestion({ id: "q-2", chapter: "第二章" }),
  ], GROUP_ID);
  assert.deepEqual(materialGroupConsistencyIssues(chapterDiffers), [], "章节与知识点允许各问不同");
  assert.equal(materialGroupConsistencyIssues([])[0].code, "material_group_not_found");
});

test("采纳后是否仍需人工核对：占位/缺分值要核对，其余不用（DEC-099 ⑦/⑧）", () => {
  assert.equal(scoreNeedsReviewForBasis("placeholder"), true);
  assert.equal(scoreNeedsReviewForBasis("missing"), true);
  assert.equal(scoreNeedsReviewForBasis("points"), false);
  assert.equal(scoreNeedsReviewForBasis("declared"), false);
  assert.equal(scoreNeedsReviewForBasis("locked"), false);
});
