/**
 * AI 巡检的「题族筛选」：筛出还没有题族的题（产品负责人 2026-09-25 要求）。
 *
 * 口径（界面 title 与实现一处对齐）：按**当前**题族成员关系实时判断，不落库、不看巡检结果里的历史快照；
 * 「未成族」＝当前没有任何题族把它算作成员——待审核题族也算"已进题族"，所以它严格等于"完全没有题族关系"。
 * 产品手册另有更宽的「待归组」口径（有题族关系但未形成有效、已确认目录投影），本筛选不采用它。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createServer, knowledgeClassificationQuestionBaseline } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryTextbookKnowledgeStore } = require("../apps/api/src/textbook-knowledge-store");

const bookId = "modern-chinese-7-1";
const root = path.join(__dirname, "..");

function question(id, stem, knowledgePoint, subKnowledgePoint) {
  return {
    id,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId,
    chapter: "第二章 语音 > 辅音与声母",
    primaryKnowledgePoint: knowledgePoint,
    knowledgePoints: [knowledgePoint],
    // 题族候选按「知识身份＋判别焦点＋作答动作」分组，焦点取自子知识点：同组必须同子知识点，不同组必须不同。
    subKnowledgePoints: subKnowledgePoint ? [subKnowledgePoint] : [],
    type: "single_choice",
    typeLabel: "单选题",
    stem,
    options: [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }],
    correctAnswer: ["A"],
    referenceAnswer: "塞音",
    maxScore: 1,
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    version: 1,
  };
}

function buildStores() {
  // q1/q2 同子知识点 → 生成一个题族（下面确认它）；q3/q4 同另一个子知识点 → 另一个题族（**故意保持待审核**）；
  // q5 自成一组（不足 2 题不成族）→ 就是"还没有题族"的那一道。
  const questions = [
    question("filter-q1", "从阻碍方式看，声母 b 属于哪类辅音？", "辅音的发音方法", "阻碍方式"),
    question("filter-q2", "从阻碍方式看，声母 d 属于哪类辅音？", "辅音的发音方法", "阻碍方式"),
    question("filter-q3", "普通话「笑」的韵腹是哪个元音？", "韵母的结构", "韵腹"),
    question("filter-q4", "普通话「桥」的韵腹是哪个元音？", "韵母的结构", "韵腹"),
    question("filter-q5", "「一」的变调规则是什么？", "变调", "一不变调"),
  ];
  const questionStore = createMemoryQuestionStore(questions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const structure = knowledgeStructureStore.generate({
    bookId,
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "consonants", level: 2, title: "第三节 辅音与声母", startPage: 35, endPage: 50 },
      { id: "method", level: 3, title: "一、辅音的发音方法", startPage: 36, endPage: 42 },
      { id: "vowels", level: 3, title: "二、元音与韵母", startPage: 43, endPage: 50 },
      { id: "tone", level: 3, title: "三、声调与变调", startPage: 51, endPage: 60 },
    ],
    outlineNodes: [],
    chunks: [],
    questions,
  });
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([{
    bookId,
    status: "ready",
    version: 3,
    source: { mode: "test" },
    progress: { processedPages: 1, totalPages: 1, failedPages: 0, percent: 100 },
    pages: [{ pdfPage: 40, printedPage: 36, text: "辅音按照形成阻碍和克服阻碍的方式分类。" }],
    chunks: [],
    updatedAt: 300,
  }]);
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  // 显式给知识指纹：题族候选的分组键＝知识身份＋覆盖知识＋判别焦点＋作答动作；
  // 不能吃 structure.generate() 的指纹（它可能把 5 道题都归到同一个节点/同一个焦点，q5 就会被并进别人的题族）。
  const fingerprintMap = new Map([
    ["filter-q1", { questionId: "filter-q1", primaryKnowledgePoint: "辅音的发音方法", primaryNodeId: "method", requiredNodeIds: ["method"] }],
    ["filter-q2", { questionId: "filter-q2", primaryKnowledgePoint: "辅音的发音方法", primaryNodeId: "method", requiredNodeIds: ["method"] }],
    ["filter-q3", { questionId: "filter-q3", primaryKnowledgePoint: "韵母的结构", primaryNodeId: "vowels", requiredNodeIds: ["vowels"] }],
    ["filter-q4", { questionId: "filter-q4", primaryKnowledgePoint: "韵母的结构", primaryNodeId: "vowels", requiredNodeIds: ["vowels"] }],
    ["filter-q5", { questionId: "filter-q5", primaryKnowledgePoint: "变调", primaryNodeId: "tone", requiredNodeIds: ["tone"] }],
  ]);
  const batch = questionFamilyStore.generate(questions, bookId, {
    fingerprintMap,
    nodeOrder: new Map(structure.nodes.map((node, index) => [node.id, index + 1])),
  });
  assert.equal(batch.families.length, 2, "夹具应生成两个题族（q1/q2 与 q3/q4）");
  const [familyA, familyB] = batch.families;
  questionFamilyStore.review(familyA.id, { status: "confirmed", members: familyA.members }, "原审核员");
  // familyB 故意不确认：它仍是"待审核题族"，按口径也算"已进题族"。
  assert.equal(questionFamilyStore.list({ bookId, status: "pending_review" }).families.length, 1);
  // 夹具自检：q1–q4 各挂 1 个题族，q5 完全没有题族关系——否则后面筛出来的东西没法解释。
  const memberships = questionFamilyStore.memberships(questions.map((item) => item.id), { bookId, status: "all" });
  assert.deepEqual(Object.fromEntries(Object.entries(memberships).map(([id, list]) => [id, list.length])), {
    "filter-q1": 1, "filter-q2": 1, "filter-q3": 1, "filter-q4": 1, "filter-q5": 0,
  });
  return { questions, questionStore, knowledgeStructureStore, textbookKnowledgeStore, questionFamilyStore, structure, fingerprintMap };
}

function seedResults(stores) {
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const fingerprintMap = stores.fingerprintMap;
  const familyMembershipRevisions = stores.questionFamilyStore.membershipRevisions(stores.questions.map((item) => item.id));
  const created = knowledgeClassificationStore.createJob({
    id: "family-filter-job",
    bookId,
    questionIds: stores.questions.map((item) => item.id),
    baseQuestionVersions: Object.fromEntries(stores.questions.map((item) => [item.id, stores.questionStore.get(item.id).version])),
    baseClassificationBaselines: Object.fromEntries(stores.questions.map((item) => [
      item.id,
      knowledgeClassificationQuestionBaseline(fingerprintMap.get(item.id), familyMembershipRevisions[item.id]),
    ])),
    baseKnowledgeRevision: stores.knowledgeStructureStore.get(bookId).updatedAt,
    baseFamilyRevision: Number(stores.questionFamilyStore.exportState().generatedAtByBook[bookId]),
    textbookKnowledgeVersion: 3,
  });
  assert.equal(created.results.length, stores.questions.length);
  return knowledgeClassificationStore;
}

test("AI 巡检筛选：family=none 只给还没有题族的题，family=has 给已有题族关系的题（含待审核题族）", async (context) => {
  const stores = buildStores();
  const knowledgeClassificationStore = seedResults(stores);
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const list = (query) => fetch(`${baseUrl}/api/admin/knowledge-classification/results?bookId=${bookId}${query}`).then((response) => response.json());

  const all = await list("");
  assert.equal(all.total, 5, "不筛题族时应看到全部 5 条");

  const none = await list("&family=none");
  assert.deepEqual(none.items.map((item) => item.questionId).sort(), ["filter-q5"]);
  assert.equal(none.total, 1);
  // 未成族的那道题在响应里必须真的没有题族关系（筛选依据与数据一处一致）。
  assert.deepEqual(none.items[0].question.familyMemberships, []);

  const has = await list("&family=has");
  assert.deepEqual(has.items.map((item) => item.questionId).sort(), ["filter-q1", "filter-q2", "filter-q3", "filter-q4"]);
  assert.equal(has.total, 4);
  // q3/q4 只挂着一个**待审核**题族，按口径仍算"已进题族"（不是未成族）。
  const pendingFamilyQuestion = has.items.find((item) => item.questionId === "filter-q3");
  assert.equal(pendingFamilyQuestion.question.familyMemberships.length, 1);
  assert.equal(pendingFamilyQuestion.question.familyMemberships[0].familyStatus, "pending_review");

  // 与其它筛选可叠加：搜索词与题族筛同时生效，互不吞掉。
  const noneSearched = await list("&family=none&query=filter-q5");
  assert.deepEqual(noneSearched.items.map((item) => item.questionId), ["filter-q5"]);
  const hasSearched = await list("&family=has&query=filter-q5");
  assert.equal(hasSearched.total, 0, "同一道未成族的题不该出现在已进题族里");
  const noneApplied = await list("&family=none&status=applied");
  assert.equal(noneApplied.total, 0, "未成族里没有已采纳的题 → 组合筛选后应为空");

  // 未知取值不得把结果吞成空（保持 all 的行为，避免前端手滑就看不到东西）。
  const unknown = await list("&family=whatever");
  assert.equal(unknown.total, 5);
});

test("静态契约：筛选控件、查询参数、监听器与后端参数名一处不差", () => {
  const appJs = fs.readFileSync(path.join(root, "apps/admin/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "apps/admin/index.html"), "utf8");
  const serverJs = fs.readFileSync(path.join(root, "apps/api/src/server.js"), "utf8");
  assert.match(html, /<select id="knowledge-inspection-family"[^>]*><option value="all">全部题族状态<\/option><option value="none">未成族（没有题族）<\/option><option value="has">已进题族<\/option><\/select>/);
  assert.match(appJs, /family: document\.querySelector\("#knowledge-inspection-family"\)\.value,/);
  assert.match(appJs, /document\.querySelector\("#knowledge-inspection-family"\)\.addEventListener\("change", \(\) => \{ state\.knowledgeInspectionPage = 1; loadKnowledgeInspections\(\); \}\);/);
  assert.match(serverJs, /const familyFilter = url\.searchParams\.get\("family"\) \|\| "all";/);
  assert.match(serverJs, /if \(familyFilter === "none" && hasFamily\) return false;/);
  assert.match(serverJs, /if \(familyFilter === "has" && !hasFamily\) return false;/);
  // 判据只能来自实时成员关系（currentMembershipMap），不得改读巡检结果里的历史快照字段。
  assert.match(serverJs, /const hasFamily = \(result\.question\?\.familyMemberships \|\| \[\]\)\.length > 0;/);
});
