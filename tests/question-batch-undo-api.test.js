// 「撤销一个导入批次」的接口层验收（DEC-094 形态 A）：
// ① 按批次盘点影响面（只读、材料题整组连带）② 按选中盘点（确认框用，带确认码）
// ③ 盘点结论必须与真删一致（已合并的题：盘点说拦、删除就拦）④ 试卷/题包/题族/练习痕迹都要数出来。
// 全部走内存夹具，绝不写 .runtime（正式题库数据）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryLearningStateStore } = require("../apps/api/src/learning-state-store");

const DEFAULTS = { subjectId: "modern-chinese", bookId: "", chapter: "" };

async function withServer(options, run) {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (origin, path, body) => fetch(`${origin}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const importText = (origin, text) => post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS, dryRun: false }).then((r) => r.json());
const listBatch = async (origin, batchId) => (await fetch(`${origin}/api/admin/questions?library=official&status=all&importBatchId=${encodeURIComponent(batchId)}`).then((r) => r.json())).questions;
const listAll = async (origin) => (await fetch(`${origin}/api/admin/questions?library=official&status=all`).then((r) => r.json())).questions.length;

const BATCH_TEXT = [
  "[单选题] A 批第 1 题", "A. 甲", "B. 乙", "答案：A", "分值：2", "---",
  "[单选题] A 批第 2 题", "A. 甲", "B. 乙", "答案：A", "分值：2", "---",
  "[材料分析题] 阅读材料，回答问题。", "材料：现代汉语词汇系统。", "（1）简述基本词汇特点。", "（2）简述一般词汇特点。", "分值：4",
].join("\n");

test("import batch impact is read-only and counts material groups as whole units", async () => {
  await withServer({}, async (origin) => {
    const commit = await importText(origin, BATCH_TEXT);
    const batchId = commit.batchId;
    const before = await listAll(origin);

    const response = await fetch(`${origin}/api/admin/questions/import-batches/${encodeURIComponent(batchId)}/impact`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.batch.id, batchId);
    assert.equal(payload.batch.confirmCode, batchId.slice(-6));
    // 4 个作答项（2 单选 + 2 材料小问）＝ 3 个题目单位（材料题组算 1）
    assert.equal(payload.impact.requestedCount, 4);
    assert.equal(payload.impact.deletedCount, 4);
    assert.equal(payload.impact.unitCount, 3);
    assert.equal(payload.impact.materialGroupCount, 1);
    assert.equal(payload.impact.deleteBlocked, false);
    assert.deepEqual(payload.impact.notFoundIds, []);
    assert.equal(payload.impact.referenceSummary.examCount, 0);
    assert.equal(payload.impact.referenceSummary.packCount, 0);
    assert.equal(payload.impact.practiced.questions, 0);
    // 盘点绝不动数据
    assert.equal(await listAll(origin), before);
    assert.equal((await listBatch(origin, batchId)).length, 4);
  });
});

test("import batch impact returns 404 for an unknown batch", async () => {
  await withServer({}, async (origin) => {
    const response = await fetch(`${origin}/api/admin/questions/import-batches/not-a-real-batch/impact`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "question_import_batch_not_found");
  });
});

test("selection impact reports only the submitted ids and carries the batch confirm code", async () => {
  await withServer({}, async (origin) => {
    const commit = await importText(origin, BATCH_TEXT);
    const batchId = commit.batchId;
    const rows = await listBatch(origin, batchId);
    const single = rows.find((question) => !question.materialGroupId);
    const materialSub = rows.find((question) => question.materialGroupId);

    const subset = await post(origin, "/api/admin/questions/deletion-impact", {
      ids: [single.id],
      importBatchId: batchId,
    }).then((r) => r.json());
    assert.equal(subset.impact.requestedCount, 1);
    assert.equal(subset.impact.deletedCount, 1);
    assert.equal(subset.impact.unitCount, 1);
    assert.equal(subset.batch.confirmCode, batchId.slice(-6));

    // 只提交材料题的一个小问 → 盘点必须预告整组连带（否则确认框会少报）
    const group = await post(origin, "/api/admin/questions/deletion-impact", { ids: [materialSub.id] }).then((r) => r.json());
    assert.equal(group.impact.deletedCount, 2);
    assert.equal(group.impact.unitCount, 1);
    assert.equal(group.impact.materialGroupCount, 1);
    assert.equal(group.batch, null);

    const missing = await post(origin, "/api/admin/questions/deletion-impact", { ids: [single.id, "not-exist"] }).then((r) => r.json());
    assert.deepEqual(missing.impact.notFoundIds, ["not-exist"]);
    assert.equal(missing.impact.deletedCount, 1);
  });
});

test("selection impact agrees with the real delete when merged questions block it", async () => {
  // 直接种一份"已合并"的题（source 的 mergedIntoQuestionId 指向 target），
  // 断言：盘点说会被拦，真删就真的拦 —— 两边共用同一处删除投影，不允许漂移。
  const seed = (id, stem, extra) => ({
    id,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId: "",
    chapter: "",
    knowledgePoints: [],
    type: "single_choice",
    stem,
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
    correctAnswer: ["A"],
    referenceAnswer: "甲。",
    maxScore: 2,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  });
  const questionStore = createMemoryQuestionStore([
    seed("merged-source", "已合并的源题", { mergedIntoQuestionId: "merge-target", status: "offline" }),
    seed("merge-target", "合并后的规范题", {}),
  ]);
  await withServer({ questionStore }, async (origin) => {
    const beforeBlockedDeletes = await listAll(origin);
    const sourceImpact = await post(origin, "/api/admin/questions/deletion-impact", { ids: ["merged-source"] }).then((r) => r.json());
    assert.equal(sourceImpact.impact.deleteBlocked, true);
    assert.deepEqual(sourceImpact.impact.mergedSourceIds, ["merged-source"]);
    const deleteSource = await post(origin, "/api/admin/questions/batch-delete", { ids: ["merged-source"] });
    assert.equal(deleteSource.status, 409);
    assert.equal((await deleteSource.json()).error, "question_merged_source_read_only");

    const targetImpact = await post(origin, "/api/admin/questions/deletion-impact", { ids: ["merge-target"] }).then((r) => r.json());
    assert.equal(targetImpact.impact.deleteBlocked, true);
    assert.deepEqual(targetImpact.impact.mergedTargetIds, ["merge-target"]);
    const deleteTarget = await post(origin, "/api/admin/questions/batch-delete", { ids: ["merge-target"] });
    assert.equal(deleteTarget.status, 409);
    assert.equal((await deleteTarget.json()).error, "question_merge_target_delete_forbidden");
    // 两道路都被拦下：题目一道都没少（已合并的源题不会出现在官方列表中，所以比对的是"删前=删后"）
    assert.equal(await listAll(origin), beforeBlockedDeletes);
  });
});

test("import batch impact counts exam, pack, family and practice references", async () => {
  const batchState = { batchId: "", singleId: "", materialGroupId: "", materialId: "" };
  const questionStore = createMemoryQuestionStore([]);
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [] });
  const learningStateStore = createMemoryLearningStateStore();
  await withServer({ questionStore, questionFamilyStore, learningStateStore }, async (origin) => {
    const commit = await importText(origin, BATCH_TEXT);
    batchState.batchId = commit.batchId;
    const rows = await listBatch(origin, batchState.batchId);
    const single = rows.find((question) => !question.materialGroupId);
    const material = rows.find((question) => question.materialGroupId);
    batchState.singleId = single.id;
    batchState.materialId = material.id;
    batchState.materialGroupId = material.materialGroupId;

    // 试卷 + 题包引用
    const exam = await post(origin, "/api/admin/exams", {
      title: "影响面用例试卷", questionIds: [single.id], subjectId: "modern-chinese", durationMinutes: 60, totalScore: 2,
    }).then((r) => r.json());
    assert.equal(exam.success, true);
    const pack = await post(origin, "/api/admin/packs", { name: "影响面用例题包", questionIds: [material.id] }).then((r) => r.json());
    assert.equal(pack.success, true);
    // 题族成员：内存夹具直接种一条"已确认"的成员关系（正式写路径要先建族再加成员，这里只验证盘点口径）
    const familyState = questionFamilyStore.exportState();
    questionFamilyStore.replaceState({
      ...familyState,
      families: [...(familyState.families || []), {
        id: "impact-family",
        bookId: "modern-chinese-7-1",
        name: "影响面用例题族",
        knowledgeNodeId: "node-1",
        coreKnowledgeNodeId: "node-1",
        status: "confirmed",
        members: [
          { questionId: single.id, isPrimary: true, role: "prototype", reviewStatus: "confirmed" },
          { questionId: material.id, role: "member", reviewStatus: "confirmed" },
        ],
      }],
    });
    // 用户练过一次（attempts + reviewStates 两种痕迹都覆盖）
    learningStateStore.merge("user-1", {
      attempts: [{ id: "attempt-1", questionId: single.id, createdAt: Date.now(), correct: true }],
      reviewStates: { [material.id]: { box: 1, dueAt: Date.now() } },
    }, Date.now());

    const payload = await fetch(`${origin}/api/admin/questions/import-batches/${encodeURIComponent(batchState.batchId)}/impact`).then((r) => r.json());
    assert.equal(payload.impact.referenceSummary.examCount, 1);
    assert.equal(payload.impact.referenceSummary.packCount, 1);
    assert.equal(payload.impact.referenceSummary.familyCount, 1);
    assert.equal(payload.impact.referenceSummary.referencedQuestionCount, 2);
    assert.deepEqual(payload.impact.exams.map((exam) => exam.title), ["影响面用例试卷"]);
    assert.deepEqual(payload.impact.packs.map((item) => item.name), ["影响面用例题包"]);
    assert.deepEqual(payload.impact.families.map((family) => family.name), ["影响面用例题族"]);
    assert.equal(payload.impact.practiced.questions, 2);
    assert.equal(payload.impact.practiced.attempts, 1);
    assert.equal(payload.impact.practiced.accounts, 1);
    // 有引用也不阻断删除：引用只提示，不拦（拦只发生在合并关系上）
    assert.equal(payload.impact.deleteBlocked, false);
  });
});
