/**
 * 材料题组整组取数 / 整组采纳的接口回归（DEC-099 / 产品手册 §4.6.7）。
 *
 * 覆盖口径里"必须走服务端"的那几条：
 *   ③ 粒度＝题组：一次取整组、一次采纳整组；
 *   ④ 整组一次采纳（不是逐题点）；
 *   ⑤ 各小问之和严格等于题组总分（守恒，服务端是唯一判据）；
 *   ⑦ 没有得分点时均分占位并继续标「分值待核对」（占位不阻断，但必须如实标）；
 *   ⑧ 重新分配跳过人工已改过的小问（保留现值，剩余分值再分配）；
 *   ⑨ 组内强制同科目 + 同教材，不一致时**报错**而不是猜；
 *   ⑪ 题组总分缺失时用该科目默认满分兜底，原卷写了就以原卷（导入当时）为准。
 * 另外验证新增的 scoreBasis / scoreNeedsReview 确实能被管理端接口读到。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");

const GROUP_ID = "material:batch-dec099:392:mg-392";
const BOOK_ID = "modern-chinese-7-1";

function subQuestion(index, overrides = {}) {
  return {
    id: `dec099-sub-${index}`,
    subjectId: "modern-chinese",
    bookId: BOOK_ID,
    chapter: "第一章 绪论",
    knowledgePoints: ["现代汉语共同语"],
    type: "material_analysis",
    stem: `第 ${index} 问：结合材料作答。`,
    referenceAnswer: `第 ${index} 问参考答案。`,
    maxScore: 4,
    questionGroupId: GROUP_ID,
    questionGroupTitle: "第392题 · 材料题组",
    groupNumber: "392",
    subNumber: String(index),
    groupOrder: index,
    scoreBasis: "placeholder",
    scoreNeedsReview: true,
    ...overrides,
  };
}

async function startServer(context, questions) {
  const questionStore = createMemoryQuestionStore([]);
  questions.forEach((question) => questionStore.create(question, "测试编辑"));
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    questionEnrichmentStore: createMemoryQuestionEnrichmentStore(),
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, questionStore, operationLogStore };
}

const groupUrl = (baseUrl, groupId = GROUP_ID) => `${baseUrl}/api/admin/question-enrichment/material-groups/${encodeURIComponent(groupId)}`;

test("按题组取数：成员小问、得分点数、当前分值、人工已改标记与分配建议一次给全", async (context) => {
  const { baseUrl } = await startServer(context, [
    // 原卷写明了第 1 问的分值（3分）⇒ 最优先，不被均分覆盖
    subQuestion(1, { stem: "分析材料中加点词“伟大”的词性。（3分）", scoringPoints: [{ description: "词性判断", score: 3 }] }),
    subQuestion(2, { scoringPoints: [{ description: "要点一", score: 2 }, { description: "要点二", score: 2 }] }),
    subQuestion(3, { scoringPoints: [{ description: "要点一", score: 4 }] }),
    subQuestion(4),
  ]);
  const response = await fetch(groupUrl(baseUrl));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.group.id, GROUP_ID);
  assert.equal(payload.group.title, "第392题 · 材料题组");
  assert.equal(payload.group.memberCount, 4, "整组取数：一次给全 4 个小问");
  assert.equal(payload.group.subjectId, "modern-chinese");
  assert.equal(payload.group.bookId, BOOK_ID);
  assert.equal(payload.group.groupTotal, 16, "导入当时这一组分出去的总分（4×4）");
  assert.equal(payload.group.groupTotalBasis, "recorded");
  assert.equal(payload.group.defaultGroupTotal, 14, "现代汉语材料题组默认满分（DEC-099 ⑪ 兜底值，随接口一起下发）");
  assert.equal(payload.group.step, 1);
  assert.equal(payload.group.conserved, true);
  assert.deepEqual(payload.issues, []);
  assert.deepEqual(payload.members.map((member) => member.id), ["dec099-sub-1", "dec099-sub-2", "dec099-sub-3", "dec099-sub-4"]);
  assert.deepEqual(payload.members.map((member) => member.subNumber), ["1", "2", "3", "4"]);
  assert.deepEqual(payload.members.map((member) => member.scoringPointCount), [1, 2, 1, 0]);
  assert.deepEqual(payload.members.map((member) => member.currentScore), [4, 4, 4, 4]);
  assert.deepEqual(payload.members.map((member) => member.declaredScore), [3, null, null, null]);
  assert.ok(payload.members.every((member) => member.locked === false));
  assert.equal(payload.allocations.reduce((sum, item) => sum + item.score, 0), 16, "建议分值之和严格等于题组总分");
  assert.equal(payload.allocations[0].score, 3);
  assert.equal(payload.allocations[0].basis, "declared");
  assert.equal(payload.allocations[0].scoreNeedsReview, false);
  assert.ok(payload.allocations.slice(1).every((item) => item.basis === "points" && item.scoreNeedsReview === false));

  // 未知题组：如实 404，不是空数组让人以为"这组没题"
  const missing = await fetch(groupUrl(baseUrl, "material:batch-dec099:392:不存在"));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "material_group_not_found");
});

test("整组一次采纳：逐题写分值+依据、清掉「分值待核对」、留下审计日志", async (context) => {
  const { baseUrl, operationLogStore } = await startServer(context, [
    subQuestion(1, { stem: "分析材料中加点词“伟大”的词性。（3分）", scoringPoints: [{ description: "词性判断", score: 3 }] }),
    subQuestion(2, { scoringPoints: [{ description: "要点一", score: 2 }, { description: "要点二", score: 2 }] }),
    subQuestion(3, { scoringPoints: [{ description: "要点一", score: 4 }] }),
    subQuestion(4),
  ]);
  const response = await fetch(`${groupUrl(baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.group.allocatedTotal, 16);
  assert.equal(payload.group.conserved, true);
  assert.equal(payload.group.placeholder, false);
  assert.equal(payload.group.needsReview, false);
  assert.equal(payload.updatedCount, 4, "整组一次采纳：四问一起写");
  assert.deepEqual(payload.skippedLockedIds, []);
  const byId = new Map(payload.allocations.map((item) => [item.id, item]));
  assert.equal(byId.get("dec099-sub-1").score, 3);
  assert.equal(byId.get("dec099-sub-1").basis, "declared");
  assert.ok(byId.get("dec099-sub-2").score > byId.get("dec099-sub-3").score, "得分点多的分得多（2 个要点 vs 1 个）");

  // 写回结果：分值、依据、待核对标记三者都要落到题目上，且「待核对」被清掉
  const listing = await fetch(`${baseUrl}/api/admin/questions?bookId=${BOOK_ID}&status=all`).then((item) => item.json());
  const questions = listing.questions.filter((question) => question.questionGroupId === GROUP_ID);
  assert.equal(questions.length, 4);
  const byQuestion = new Map(questions.map((question) => [question.id, question]));
  assert.equal(byQuestion.get("dec099-sub-1").maxScore, 3);
  assert.equal(byQuestion.get("dec099-sub-1").scoreBasis, "declared");
  assert.equal(byQuestion.get("dec099-sub-1").scoreNeedsReview, false);
  assert.equal(byQuestion.get("dec099-sub-2").scoreBasis, "points");
  assert.ok(questions.every((question) => question.scoreNeedsReview === false), "采纳后整组不再标「分值待核对」");
  assert.ok(questions.every((question) => Number(question.maxScore) > 0));
  assert.equal(questions.reduce((sum, question) => sum + Number(question.maxScore), 0), 16);

  const logs = operationLogStore.list({ category: "question" }).items.map((item) => item.action);
  assert.ok(logs.includes("question.material_group_scores_apply"), `审计日志要有整组采纳这一条，实际 ${logs.join(",")}`);
  const applyLog = operationLogStore.list({ category: "question" }).items
    .find((item) => item.action === "question.material_group_scores_apply");
  assert.equal(applyLog.targetId, GROUP_ID);
  assert.equal(applyLog.metadata.groupTotal, 16);
  assert.equal(applyLog.metadata.groupTotalBasis, "recorded");
  assert.equal(applyLog.metadata.allocations.length, 4);

  // 再采纳一次：值没变就不写（不把版本号白白推高），如实报 unchanged
  const again = await fetch(`${groupUrl(baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).then((item) => item.json());
  assert.equal(again.updatedCount, 0);
  assert.equal(again.unchangedIds.length, 4);
});

test("重新分配跳过人工已改过的小问：保留现值，剩余分值再去凑原来那个题组总分（DEC-099 ⑥/⑧）", async (context) => {
  const { baseUrl } = await startServer(context, [
    subQuestion(1, { stem: "分析材料中加点词“伟大”的词性。（3分）", scoringPoints: [{ description: "词性判断", score: 3 }] }),
    subQuestion(2, { scoringPoints: [{ description: "要点一", score: 2 }, { description: "要点二", score: 2 }] }),
    subQuestion(3, { scoringPoints: [{ description: "要点一", score: 4 }] }),
    subQuestion(4),
  ]);
  // 人工把第 3 问从 4 分改成 5 分（编辑题目走的就是这条 PUT）
  const edited = await fetch(`${baseUrl}/api/admin/questions/dec099-sub-3`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxScore: 5, changeNote: "人工核对第 3 问分值" }),
  }).then((item) => item.json());
  assert.equal(edited.question.maxScore, 5);
  assert.equal(edited.question.scoreBasis, "locked", "人工改过分值 ⇒ 记为人工已定");
  assert.equal(edited.question.scoreNeedsReview, false);

  const plan = await fetch(groupUrl(baseUrl)).then((item) => item.json());
  assert.equal(plan.group.groupTotal, 16, "题组总分仍是导入当时的 16 分（不随人工改分变动）");
  assert.equal(plan.group.groupTotalBasis, "recorded");
  assert.equal(plan.members[2].locked, true);
  assert.equal(plan.members[2].currentScore, 5);
  assert.equal(plan.allocations[2].score, 5, "人工已改过 ⇒ 建议里也照现值保留");
  assert.equal(plan.allocations[2].keepCurrent, true);
  assert.equal(plan.allocations.reduce((sum, item) => sum + item.score, 0), 16);
  assert.match(plan.warnings.join("；"), /已跳过 1 个人工改过分值的小问/);
  assert.match(plan.warnings.join("；"), /按导入当时的 16 分计/);

  const applied = await fetch(`${groupUrl(baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).then((item) => item.json());
  assert.equal(applied.group.conserved, true);
  assert.deepEqual(applied.skippedLockedIds, ["dec099-sub-3"]);
  assert.ok(applied.unchangedIds.includes("dec099-sub-3"), "人工改过的那问不被重写");
  const byId = new Map(applied.allocations.map((item) => [item.id, item]));
  assert.equal(byId.get("dec099-sub-3").score, 5);
  assert.equal(byId.get("dec099-sub-3").basis, "locked");
  assert.equal(byId.get("dec099-sub-1").score, 3);
  assert.equal(applied.allocations.reduce((sum, item) => sum + item.score, 0), 16, "跳过之后各问之和仍等于题组总分");
});

test("没有得分点 ⇒ 均分占位并继续标「分值待核对」，不阻断（DEC-099 ⑦）", async (context) => {
  const { baseUrl } = await startServer(context, [
    subQuestion(1, { scoringPoints: [], scoreBasis: "missing" }),
    subQuestion(2, { scoringPoints: [], scoreBasis: "missing" }),
    subQuestion(3, { scoringPoints: [], scoreBasis: "missing" }),
    subQuestion(4, { scoringPoints: [], scoreBasis: "missing" }),
  ]);
  const plan = await fetch(groupUrl(baseUrl)).then((item) => item.json());
  assert.equal(plan.group.groupTotal, 16, "这一组导入当时分出去的总分");
  assert.equal(plan.group.groupTotalBasis, "recorded");
  assert.equal(plan.group.conserved, true);
  assert.equal(plan.group.placeholder, true);
  assert.equal(plan.group.needsReview, true);
  assert.match(plan.warnings.join("；"), /各小问都还没有得分点/);
  assert.ok(plan.allocations.every((item) => item.basis === "placeholder" && item.scoreNeedsReview === true));
  assert.equal(plan.allocations.reduce((sum, item) => sum + item.score, 0), 16, "占位也必须守恒（4 分 ×4）");

  const applied = await fetch(`${groupUrl(baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(applied.status, 200, "均分占位不阻断采纳（⑦：可以先占位，等完善得分点后再重分）");
  const payload = await applied.json();
  assert.equal(payload.group.placeholder, true);
  assert.ok(payload.updated.every((item) => item.scoreBasis === "placeholder" && item.scoreNeedsReview === true),
    "占位采纳后仍然标「分值待核对」，不假装分好了");
  assert.equal(payload.updatedCount, 4, "依据从「缺分值」纠成「均分占位」，四问都要落一次");
  assert.equal(payload.updated.reduce((sum, item) => sum + Number(item.maxScore), 0), 16);
});

test("组内归属不一致时如实报错，绝不猜（DEC-099 ⑨）", async (context) => {
  const { baseUrl } = await startServer(context, [
    subQuestion(1),
    subQuestion(2),
    subQuestion(3, { subjectId: "classical-chinese", bookId: "classical-chinese-1" }),
    subQuestion(4),
  ]);
  const crossSubject = await fetch(`${groupUrl(baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(crossSubject.status, 422);
  assert.equal((await crossSubject.json()).error, "material_group_subject_mismatch");
  const readBack = await fetch(groupUrl(baseUrl)).then((item) => item.json());
  assert.equal(readBack.issues[0].code, "material_group_subject_mismatch");
  assert.match(readBack.issues[0].message, /强制同科目/);

  const bookMismatch = await startServer(context, [
    subQuestion(1),
    subQuestion(2, { bookId: "modern-chinese-7-2" }),
  ]);
  const bookResponse = await fetch(`${groupUrl(bookMismatch.baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bookResponse.status, 422);
  assert.equal((await bookResponse.json()).error, "material_group_book_mismatch");
});

test("整组手改分值：守恒与步长两条硬约束都满足才接受，采纳后按人工口径写回", async (context) => {
  const { baseUrl } = await startServer(context, [
    subQuestion(1, { scoringPoints: [{ description: "要点一", score: 4 }] }),
    subQuestion(2, { scoringPoints: [{ description: "要点一", score: 4 }] }),
    subQuestion(3, { scoringPoints: [{ description: "要点一", score: 4 }] }),
    subQuestion(4, { scoringPoints: [{ description: "要点一", score: 4 }] }),
  ]);
  const stepInvalid = await fetch(`${groupUrl(baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupTotal: 16, allocations: [{ id: "dec099-sub-1", score: 2.5 }, { id: "dec099-sub-2", score: 4.5 }, { id: "dec099-sub-3", score: 4.5 }, { id: "dec099-sub-4", score: 4.5 }] }),
  });
  assert.equal(stepInvalid.status, 422);
  assert.equal((await stepInvalid.json()).error, "material_group_allocation_step_invalid");

  const notConserved = await fetch(`${groupUrl(baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupTotal: 16, allocations: [{ id: "dec099-sub-1", score: 3 }, { id: "dec099-sub-2", score: 3 }, { id: "dec099-sub-3", score: 3 }, { id: "dec099-sub-4", score: 3 }] }),
  });
  assert.equal(notConserved.status, 422);
  assert.equal((await notConserved.json()).error, "material_group_allocation_not_conserved");

  const accepted = await fetch(`${groupUrl(baseUrl)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupTotal: 12, allocations: [{ id: "dec099-sub-1", score: 4 }, { id: "dec099-sub-2", score: 4 }, { id: "dec099-sub-3", score: 3 }, { id: "dec099-sub-4", score: 1 }] }),
  }).then((item) => item.json());
  assert.equal(accepted.group.groupTotal, 12);
  assert.equal(accepted.group.groupTotalBasis, "manual");
  assert.equal(accepted.group.conserved, true);
  assert.deepEqual(accepted.allocations.map((item) => item.score), [4, 4, 3, 1]);
  assert.equal(accepted.updatedCount, 4);
});
