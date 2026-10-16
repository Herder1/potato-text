/**
 * AI 巡检「复核状态」四态与「送去完善题目」（后端契约 v1）。
 *
 * 口径正文：产品手册 §4.6.12【已确认 2026-09-26，DEC-100】——
 *   ① AI 巡检只诊断、不改库：本文件覆盖的两条路由都**不产生任何写库动作**
 *      （送去的只是"生成建议稿"的请求，采纳与否仍由人在完善题目里逐项决定）；
 *   ② 记录状态机由原五张卡片改为四态：pending_review / reviewed / repaired / ignored；
 *   ③ 「归为通过」是 AI／规则的结论，不改记录状态（通过 ≠ 已复核）；
 *   ④ 题目被改过（题目版本或巡检基线修订与记录不一致）时，reviewed / ignored 的旧结论**派生作废**
 *      并显示为待复核；repaired / pending_review 不变。
 *
 * 这里同时钉住"派生只在响应里算、绝不回写"：作废之后 Store 里的 auditReview 必须还是原样。
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { createServer, ADMIN_USERNAME, ADMIN_DISPLAY_NAME } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");
const { createMemoryTextbookKnowledgeStore } = require("../apps/api/src/textbook-knowledge-store");

const bookId = "modern-chinese-7-1";

// 八种题目：前四道各带一条巡检记录（四态），第五、第六道给「送去完善题目」用
// （一道按完善口径不齐全、一道已齐全），最后两道专门触发确定性体检规则（分值异常／近似重复）。
const QUESTION_IDS = {
  plain: "audit-q-plain",
  reviewed: "audit-q-reviewed",
  repaired: "audit-q-repaired",
  ignored: "audit-q-ignored",
  enrichment: "audit-q-enrichment",
  complete: "audit-q-complete",
  score: "audit-q-score",
  duplicate: "audit-q-duplicate",
};

// 与教材目录节点对得上的章节路径：建议稿落到这个节点才不会被判 catalog_node_invalid。
const chapterPath = "第二章 语音";

function questionFixture(id, stem, knowledgePoint, bookIdOverride, options = {}) {
  return {
    id,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId: bookIdOverride === undefined ? bookId : bookIdOverride,
    chapter: options.chapter === undefined ? chapterPath : options.chapter,
    primaryKnowledgePoint: knowledgePoint,
    knowledgePoints: [knowledgePoint],
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

/**
 * 巡检基线里的"知识树拓扑修订"。
 *
 * 这里**故意复刻** src/server.js 的 `knowledgeTopologyRevision`（同一份 JSON + sha256 前 13 位十六进制），
 * 而不是从 server.js 导出它：派生作废的判据是"记录里的 baseKnowledgeRevision 与现状一致不一致"，
 * 测试需要站在"外部观察者"的位置自己算出基准值；把内部实现导出成公开 API 反而是更大的耦合。
 * 若哪天 server.js 改了算法，本文件的静态契约用例不会拦住它——这是已知的、接受的测试耦合点。
 */
function topologyRevisionOf(structure) {
  const topology = (structure?.nodes || []).map((node) => ({
    id: String(node.id || ""),
    parentId: String(node.parentId || ""),
    kind: String(node.kind || ""),
    title: String(node.title || ""),
    displayTitle: String(node.displayTitle || ""),
    order: Number(node.order) || 0,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return Number.parseInt(crypto.createHash("sha256").update(JSON.stringify(topology)).digest("hex").slice(0, 13), 16);
}

function buildFixture() {
  const questions = [
    // 章节「第一章 绪论」在教材目录里没有同名节点（目录只有第二章／第三节／一、辅音的发音方法），
    // 知识点「汉语拼音方案」也没有同名节点 → 锚点解析不到目录节点 → evidence_missing。
    // 两个坑都要避开：①别用知识点"辅音的发音方法"（目录节点 displayTitle 就是它）；
    // ②别用默认章节"第二章 语音"（它是目录节点 title，单凭章节就把锚点判成解析成功）。
    questionFixture(QUESTION_IDS.plain, "从阻碍方式看，声母 b 属于哪类辅音？", "汉语拼音方案", undefined, { chapter: "第一章 绪论" }),
    questionFixture(QUESTION_IDS.reviewed, "从阻碍方式看，声母 d 属于哪类辅音？", "辅音的发音方法"),
    questionFixture(QUESTION_IDS.repaired, "从阻碍方式看，声母 g 属于哪类辅音？", "辅音的发音方法"),
    questionFixture(QUESTION_IDS.ignored, "从阻碍方式看，声母 p 属于哪类辅音？", "辅音的发音方法"),
    // 未定教材＋未定章节：questionEnrichmentNeeds 判为"不完整"，才走得进生成建议的产线。
    // （注意：巡检记录里的 bookId 继承自 job，不是逐题 bookId；这里传空只影响"完善清单"的判据。）
    questionFixture(QUESTION_IDS.enrichment, "普通话的定义是什么？", "待归类", "", { chapter: "" }),
    // 按完善口径**已经齐全**（教材／章节／知识点／得分点都不缺）：客观题不参与得分点检查。
    // 巡检照样可能报它有问题（如「分值缺失或异常」「近似重复」），所以它也必须送得出去。
    questionFixture(QUESTION_IDS.complete, "从阻碍方式看，声母 m 属于哪类辅音？", "辅音的发音方法"),
    // 分值异常：maxScore = 0（规则项 score_abnormal 的确定性判据）。
    { ...questionFixture(QUESTION_IDS.score, "从阻碍方式看，声母 f 属于哪类辅音？", "辅音的发音方法"), maxScore: 0 },
    // 近似重复：与第六道题**事实完全相同**（题型＋材料＋题干＋选项归一化一致）。
    questionFixture(QUESTION_IDS.duplicate, "从阻碍方式看，声母 m 属于哪类辅音？", "辅音的发音方法"),
  ];
  const questionStore = createMemoryQuestionStore(questions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const structure = knowledgeStructureStore.generate({
    bookId,
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "consonants", level: 2, title: "第三节 辅音与声母", startPage: 35, endPage: 50 },
      { id: "method", level: 3, title: "一、辅音的发音方法", startPage: 36, endPage: 42 },
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
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft(bookId, [
    { id: "node-method", level: 1, title: "第二章 语音", startPage: 20, endPage: 80, knowledgePoints: ["辅音的发音方法"] },
  ], { source: "test" }, "测试编辑");
  textbookCatalogStore.confirm(bookId, "测试编辑");
  return {
    questions,
    questionStore,
    knowledgeStructureStore,
    textbookKnowledgeStore,
    questionFamilyStore,
    textbookCatalogStore,
    structure,
    // 建记录那一刻的巡检基线（现状），四条记录因此都"没被改过"。
    knowledgeRevision: topologyRevisionOf(structure),
    familyRevision: 0,
  };
}

function seedResults(stores, jobId = "audit-review-job") {
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const created = knowledgeClassificationStore.createJob({
    id: jobId,
    // status=completed：这是一批**已经跑完**的巡检留下的记录（recoverInterrupted 只碰 queued/running，
    // 保持缺省恢复开关不动，夹具就和线上"巡检跑完、人来看结论"的状态一致）。
    status: "completed",
    bookId,
    questionIds: stores.questions.map((item) => item.id),
    // 基线＝建记录那一刻的现状，所以缺省状态下四条记录都"没被改过"。
    baseQuestionVersions: Object.fromEntries(stores.questions.map((item) => [item.id, item.version])),
    baseKnowledgeRevision: stores.knowledgeRevision,
    knowledgeRevisionFormat: "topology-v1",
    baseFamilyRevision: Number(stores.questionFamilyStore.exportState().generatedAtByBook[bookId] || 0),
    textbookKnowledgeVersion: 3,
  });
  assert.equal(created.results.length, stores.questions.length, "夹具应为每道题建一条巡检记录");
  const resultIdByQuestion = new Map(created.results.map((result) => [result.questionId, result.id]));
  return { knowledgeClassificationStore, resultIdByQuestion };
}

/**
 * 起一个真实 HTTP 服务：内存 Store + 一个假上游（OpenAI 兼容），供「送去完善题目」的产线调用。
 * 非 ASCII 路径规避：测试文件自身在 ASCII 路径下运行，所有请求都走 127.0.0.1。
 */
async function startServer(context, options = {}) {
  const stores = options.stores || buildFixture();
  const { knowledgeClassificationStore, resultIdByQuestion } = options.seeded
    || seedResults(stores);
  const prompts = [];
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (body) prompts.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "enrichment-model",
        choices: [{
          message: {
            content: JSON.stringify({
              bookId,
              catalogNodeId: "node-method",
              knowledgePoints: ["辅音的发音方法"],
              scoringPoints: [],
              confidence: 0.8,
              reason: "题干考辅音的发音方法，属语音章。",
              uncertainty: "",
            }),
          },
        }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = {
    id: "audit-review-enrichment-provider",
    name: "完善模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test",
    models: ["enrichment-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const questionEnrichmentStore = stores.questionEnrichmentStore || createMemoryQuestionEnrichmentStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore({
      providers: [provider],
      routes: {
        question_enrichment: {
          mode: "provider",
          providerId: provider.id,
          model: "enrichment-model",
          temperature: 0.1,
          maxTokens: 2000,
        },
      },
    }),
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    // stores 在前、显式键在后：调用方传给 stores 的 store（如复用用例预置的 questionEnrichmentStore）
    // 必须真的生效，不能被这里的缺省值覆盖掉。
    ...stores,
    questionEnrichmentStore,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, stores, knowledgeClassificationStore, resultIdByQuestion, questionEnrichmentStore, prompts };
}

const auditReviewUrl = (baseUrl, resultId) => `${baseUrl}/api/admin/knowledge-classification/results/${encodeURIComponent(resultId)}/audit-review`;
const listUrl = (baseUrl, book = bookId) => `${baseUrl}/api/admin/knowledge-classification/results?bookId=${encodeURIComponent(book)}`;

async function reviewAudit(baseUrl, resultId, body) {
  const response = await fetch(auditReviewUrl(baseUrl, resultId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function listItems(baseUrl) {
  const response = await fetch(listUrl(baseUrl));
  assert.equal(response.status, 200);
  return response.json();
}

const itemByQuestion = (listing, questionId) => listing.items.find((item) => item.questionId === questionId);

/**
 * 线程级回归（不是只调 store／只调 service）：**直接打 HTTP 路由**。
 * 起因：server.js 改名后留了一处悬空引用（`ruleFindingsByBook`），进程在 `handleRequest` 里被
 * ReferenceError 打挂——那种崩溃在 `node --test` 里可能只表现为"某条断言失败"，看着像判据不对，
 * 实际是进程死了。所以这条用例只做一件事：**真实路由能返回 200**，把这条路钉住。
 */
test("HTTP 级回归：GET /api/admin/knowledge-classification/results 走真实路由返回 200，行里 ruleFindings 是数组", async (context) => {
  const { baseUrl } = await startServer(context);
  const response = await fetch(listUrl(baseUrl));
  assert.equal(response.status, 200, "真实路由必须返回 200（不是 500／不是进程崩）");
  const listing = await response.json();
  assert.equal(listing.success, true);
  assert.ok(listing.items.length > 0);
  // 每行都带 ruleFindings 且是数组：字段缺失＝未体检，空数组＝跑过且通过。
  listing.items.forEach((item) => {
    assert.ok(Array.isArray(item.ruleFindings), `${item.questionId} 少了 ruleFindings`);
  });
  assert.ok(Array.isArray(itemByQuestion(listing, QUESTION_IDS.score).ruleFindings));
  assert.ok(Object.keys(listing.summary.auditReviewCounts).length === 4);
});

test("HTTP 级回归：教材正文不就绪时整行不带 ruleFindings，summary 给 ruleFindingsUnavailable（不把“没体检”算成“通过”）", async (context) => {
  const stores = buildFixture();
  // 该册教材没有可检索的正文（没有页、status 也不是 ready）→ 体检跑不出结论。
  stores.textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([]);
  const { baseUrl } = await startServer(context, { stores });

  const response = await fetch(listUrl(baseUrl));
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.ok(listing.items.length > 0);
  // ① 每行**没有** ruleFindings 这个键（不是空数组）。
  listing.items.forEach((item) => {
    assert.equal(Object.prototype.hasOwnProperty.call(item, "ruleFindings"), false, `${item.questionId} 未体检却带了 ruleFindings`);
  });
  // ② 未体检不算"通过"：这两项整体不出现。
  assert.equal(Object.prototype.hasOwnProperty.call(listing.summary, "ruleFindingsPassed"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(listing.summary, "ruleFindingsByCode"), false);
  // ③ 未体检有明确原因与书名单。
  assert.equal(typeof listing.summary.ruleFindingsUnavailable?.reason, "string");
  assert.ok(listing.summary.ruleFindingsUnavailable.reason);
  assert.deepEqual(listing.summary.ruleFindingsUnavailable.books, [bookId]);
  // 四态计数不受影响（两条通道互不覆盖）。
  assert.deepEqual(Object.keys(listing.summary.auditReviewCounts).sort(), ["ignored", "pending_review", "repaired", "reviewed"]);
});

test("巡检复核四态：写入与回读、非法 state 400、result 不存在 404、actor 记为登录账号", async (context) => {
  const { baseUrl, resultIdByQuestion, knowledgeClassificationStore } = await startServer(context);
  const reviewedId = resultIdByQuestion.get(QUESTION_IDS.reviewed);
  const repairedId = resultIdByQuestion.get(QUESTION_IDS.repaired);
  const ignoredId = resultIdByQuestion.get(QUESTION_IDS.ignored);

  // 缺省＝待复核，且缺省记录里就已经有完整的五字段（前端不必判空）。
  let listing = await listItems(baseUrl);
  const plain = itemByQuestion(listing, QUESTION_IDS.plain);
  assert.deepEqual(plain.auditReview, { state: "pending_review", note: "", actor: "", actorLabel: "", at: null });

  // ① 已复核：带上备注。actor 必须是**登录账号名**（审计要能唯一定位账号），actorLabel 才是展示名。
  const reviewed = await reviewAudit(baseUrl, reviewedId, { state: "reviewed", note: "人工确认结论成立" });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.result.id, reviewedId);
  assert.equal(reviewed.body.result.auditReview.state, "reviewed");
  assert.equal(reviewed.body.result.auditReview.note, "人工确认结论成立");
  assert.equal(reviewed.body.result.auditReview.actor, ADMIN_USERNAME);
  assert.equal(reviewed.body.result.auditReview.actorLabel, ADMIN_DISPLAY_NAME);
  assert.notEqual(ADMIN_USERNAME, ADMIN_DISPLAY_NAME, "夹具自检：账号名与展示名必须是两个不同的值，否则这条断言没意义");
  assert.equal(typeof reviewed.body.result.auditReview.at, "number");
  assert.ok(reviewed.body.result.auditReview.at > 0);

  // ② 已修复 / ④ 已忽略：另外两态都能落库。
  const repaired = await reviewAudit(baseUrl, repairedId, { state: "repaired", note: "已改库处理" });
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
  assert.equal(repaired.body.result.auditReview.state, "repaired");
  const ignored = await reviewAudit(baseUrl, ignoredId, { state: "ignored", note: "看过，无需处理" });
  assert.equal(ignored.status, 200, JSON.stringify(ignored.body));
  assert.equal(ignored.body.result.auditReview.state, "ignored");

  // 回读：列表响应里逐条对得上（同一份状态，不是两套）。
  listing = await listItems(baseUrl);
  assert.equal(itemByQuestion(listing, QUESTION_IDS.reviewed).auditReview.state, "reviewed");
  assert.equal(itemByQuestion(listing, QUESTION_IDS.repaired).auditReview.state, "repaired");
  assert.equal(itemByQuestion(listing, QUESTION_IDS.ignored).auditReview.state, "ignored");
  assert.equal(itemByQuestion(listing, QUESTION_IDS.reviewed).auditReview.actor, ADMIN_USERNAME);
  assert.equal(itemByQuestion(listing, QUESTION_IDS.reviewed).auditReview.actorLabel, ADMIN_DISPLAY_NAME);

  // 非法 state：400 + 稳定错误码，且**不得**改到记录。
  const before = knowledgeClassificationStore.getResult(reviewedId).auditReview;
  const invalid = await reviewAudit(baseUrl, reviewedId, { state: "approved" });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(invalid.body.error, "audit_review_state_invalid");
  assert.deepEqual(knowledgeClassificationStore.getResult(reviewedId).auditReview, before);
  // 带 state 却给了空串同属非法输入（不是"默认待复核"，更不是"没带 state"）。
  const emptyState = await reviewAudit(baseUrl, reviewedId, { state: "" });
  assert.equal(emptyState.status, 400, JSON.stringify(emptyState.body));
  assert.equal(emptyState.body.error, "audit_review_state_invalid");

  // result 不存在：404 + 契约错误码（先判 state，再判存在性，与契约条目顺序一致）。
  const notFound = await reviewAudit(baseUrl, "audit-result-missing", { state: "reviewed" });
  assert.equal(notFound.status, 404, JSON.stringify(notFound.body));
  assert.equal(notFound.body.error, "knowledge_classification_result_not_found");

  // 只改备注不改状态：state / actor 保持不变。
  const noted = await reviewAudit(baseUrl, reviewedId, { note: "补一句备注" });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  assert.equal(noted.body.result.auditReview.state, "reviewed");
  assert.equal(noted.body.result.auditReview.note, "补一句备注");
  assert.equal(noted.body.result.auditReview.actor, ADMIN_USERNAME);
});

test("题目版本变化后 reviewed／ignored 派生为待复核，repaired 不受影响，且派生不回写库", async (context) => {
  const { baseUrl, stores, resultIdByQuestion, knowledgeClassificationStore } = await startServer(context);
  const reviewedId = resultIdByQuestion.get(QUESTION_IDS.reviewed);
  const ignoredId = resultIdByQuestion.get(QUESTION_IDS.ignored);
  const repairedId = resultIdByQuestion.get(QUESTION_IDS.repaired);

  await reviewAudit(baseUrl, reviewedId, { state: "reviewed", note: "旧结论" });
  await reviewAudit(baseUrl, ignoredId, { state: "ignored", note: "旧结论：不用管" });
  await reviewAudit(baseUrl, repairedId, { state: "repaired", note: "已改库处理" });

  // 改库（这里直接走题目 Store：巡检不改库，改库的是别的产线）→ 题目版本从 1 变 2。
  const bumped = stores.questionStore.update(QUESTION_IDS.reviewed, { stem: "从阻碍方式看，声母 d 属于哪类辅音？（改过）" }, "另一位编辑");
  assert.equal(bumped.version, 2, "夹具自检：改库必须真的让题目版本 +1");

  const listing = await listItems(baseUrl);
  const reviewed = itemByQuestion(listing, QUESTION_IDS.reviewed);
  assert.equal(reviewed.auditReview.state, "pending_review");
  assert.equal(reviewed.auditReview.invalidated, true);
  assert.equal(reviewed.auditReview.invalidatedReason, "question_changed");
  assert.equal(reviewed.auditReview.recordedState, "reviewed");
  assert.equal(reviewed.auditReview.note, "旧结论", "派生不得抹掉原备注");
  assert.equal(reviewed.auditReview.actor, ADMIN_USERNAME);

  // 没被改过的 ignore 记录不受影响。
  assert.deepEqual(itemByQuestion(listing, QUESTION_IDS.ignored).auditReview, {
    state: "ignored",
    note: "旧结论：不用管",
    actor: ADMIN_USERNAME,
    actorLabel: ADMIN_DISPLAY_NAME,
    at: itemByQuestion(listing, QUESTION_IDS.ignored).auditReview.at,
  });
  // 已修复不受派生影响（它就是"这一版的问题已被处理"）。
  const repaired = itemByQuestion(listing, QUESTION_IDS.repaired);
  assert.equal(repaired.auditReview.state, "repaired");
  assert.equal(repaired.auditReview.invalidated, undefined);

  // 派生只在响应里算：库里的记录必须还是 agent 写入时的原样。
  const stored = knowledgeClassificationStore.getResult(reviewedId);
  assert.equal(stored.auditReview.state, "reviewed");
  assert.equal(stored.auditReview.invalidated, undefined);
  assert.equal(stored.auditReview.recordedState, undefined);

  // 巡检基线（知识树拓扑）变更同样作废旧结论：再加一个节点 → 拓扑修订变化。
  await reviewAudit(baseUrl, ignoredId, { state: "reviewed", note: "先复核" });
  const structure = stores.knowledgeStructureStore.get(bookId);
  stores.knowledgeStructureStore.replaceState({
    version: structure.version,
    records: [{
      ...structure,
      nodes: [...structure.nodes, {
        id: "added-node", parentId: "method", kind: "knowledge", title: "四、新增节点", displayTitle: "新增节点", order: 99,
      }],
    }],
    editsByBook: {},
  });
  const afterTopology = await listItems(baseUrl);
  const topologyInvalidated = itemByQuestion(afterTopology, QUESTION_IDS.ignored);
  assert.equal(topologyInvalidated.auditReview.state, "pending_review");
  assert.equal(topologyInvalidated.auditReview.invalidatedReason, "question_changed");
  assert.equal(topologyInvalidated.auditReview.recordedState, "reviewed");
});

test("送去完善题目：复用同一产线生成建议稿、记 sentToEnrichmentAt，题目不存在回 404", async (context) => {
  const { baseUrl, resultIdByQuestion, knowledgeClassificationStore, questionEnrichmentStore, prompts } = await startServer(context);
  const resultId = resultIdByQuestion.get(QUESTION_IDS.enrichment);
  assert.equal(knowledgeClassificationStore.getResult(resultId).sentToEnrichmentAt, null);

  const sentResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/results/${encodeURIComponent(resultId)}/send-to-enrichment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const sent = await sentResponse.json();
  assert.equal(sentResponse.status, 200, JSON.stringify(sent));
  assert.equal(sent.ok, true);
  assert.equal(sent.questionId, QUESTION_IDS.enrichment);
  assert.ok(sent.jobId, "必须回传真实 jobId（同一条产线创建的 job）");

  // 「送去」自己不写库：题目版本不变、巡检记录状态不变，只多一条 sentToEnrichmentAt 留痕。
  const stored = knowledgeClassificationStore.getResult(resultId);
  assert.equal(typeof stored.sentToEnrichmentAt, "number");
  assert.ok(stored.sentToEnrichmentAt > 0);
  assert.equal(stored.auditReview.state, "pending_review");
  const listing = await listItems(baseUrl);
  assert.equal(itemByQuestion(listing, QUESTION_IDS.enrichment).sentToEnrichmentAt, stored.sentToEnrichmentAt);

  // 产线真的跑了：job 落到终态，并且为这道题存下了建议稿（未采纳，仍是 recommended）。
  let job = questionEnrichmentStore.getJob(sent.jobId);
  for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = questionEnrichmentStore.getJob(sent.jobId);
  }
  assert.deepEqual(job.questionIds, [QUESTION_IDS.enrichment]);
  assert.equal(job.status, "completed", JSON.stringify(job));
  const suggestion = questionEnrichmentStore.latest(QUESTION_IDS.enrichment);
  assert.equal(suggestion.status, "recommended", "送去只生成建议稿，不得自动采纳");
  assert.equal(suggestion.jobId, sent.jobId);
  assert.equal(prompts.length, 1, "应当**只**为这一道题调一次模型（不是整批）");
  // 来源留痕：job 与建议稿上都能看出"这次是 AI 巡检送来的"（DEC-100 要求区分来源）。
  assert.equal(job.origin, "knowledge_inspection");
  assert.equal(suggestion.origin, "knowledge_inspection");
  assert.match(suggestion.originLabel, /^来自 AI 巡检/);
  assert.equal(job.originLabel, suggestion.originLabel, "job 与建议稿的来源说明必须一致");

  // 题目不存在 → 404 + question_not_found（记录本身存在，但题已被删）。
  const { knowledgeClassificationStore: orphanStore, resultIdByQuestion: orphanIds } = seedResults(buildFixture());
  const orphanServer = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    questionStore: createMemoryQuestionStore([]),
    knowledgeClassificationStore: orphanStore,
  });
  await new Promise((resolve) => orphanServer.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => orphanServer.close(resolve)));
  const orphanBaseUrl = `http://127.0.0.1:${orphanServer.address().port}`;
  const orphanResponse = await fetch(`${orphanBaseUrl}/api/admin/knowledge-classification/results/${encodeURIComponent(orphanIds.get(QUESTION_IDS.plain))}/send-to-enrichment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const orphan = await orphanResponse.json();
  assert.equal(orphanResponse.status, 404, JSON.stringify(orphan));
  assert.equal(orphan.error, "question_not_found");
  assert.equal(orphanStore.getResult(orphanIds.get(QUESTION_IDS.plain)).sentToEnrichmentAt, null, "失败不得留痕");

  // result 不存在 → 404 + 巡检记录错误码。
  const missingResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/results/audit-result-missing/send-to-enrichment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const missing = await missingResponse.json();
  assert.equal(missingResponse.status, 404, JSON.stringify(missing));
  assert.equal(missing.error, "knowledge_classification_result_not_found");
});

test("按完善口径已经齐全的题也能送去完善（allowComplete），但原「生成完善任务」接口的默认过滤不变", async (context) => {
  const { baseUrl, resultIdByQuestion, questionEnrichmentStore, prompts } = await startServer(context);

  // 原接口的默认行为：只处理"待完善"的题 —— 这道齐全题不在其列，所以什么也没创建。
  const defaultResponse = await fetch(`${baseUrl}/api/admin/question-enrichment/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIds: [QUESTION_IDS.complete] }),
  });
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultResponse.status, 422, JSON.stringify(defaultBody));
  assert.equal(defaultBody.error, "question_enrichment_questions_required");
  assert.equal(questionEnrichmentStore.jobs(10).length, 0, "默认口径不得为齐全题排队");

  // 巡检「送去完善题目」：同一道题必须送得出去（巡检结论与完善口径不是一回事）。
  const sentResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/results/${encodeURIComponent(resultIdByQuestion.get(QUESTION_IDS.complete))}/send-to-enrichment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const sent = await sentResponse.json();
  assert.equal(sentResponse.status, 200, JSON.stringify(sent));
  assert.ok(sent.jobId);
  assert.equal(sent.questionId, QUESTION_IDS.complete);

  // 产线照样能跑完：齐全题不会被 runner 的"无需完善"二次拦掉。
  let job = questionEnrichmentStore.getJob(sent.jobId);
  for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = questionEnrichmentStore.getJob(sent.jobId);
  }
  assert.equal(job.status, "completed", JSON.stringify(job));
  const suggestion = questionEnrichmentStore.latest(QUESTION_IDS.complete);
  assert.equal(suggestion.status, "recommended", JSON.stringify(suggestion));
  assert.equal(suggestion.origin, "knowledge_inspection");
  assert.equal(prompts.length, 1);

  // 同一道题再送一次：复用排队/运行中的 job，不重复排队（跑完了就另说，这里断言的是排队期间的行为）。
  // 同一道题再送一次：该题已有排队中的 job 就复用它的 id，不重复排队。
  // 注意 job 必须在**服务起来之后**才创建：`createServer` 启动时会 recoverInterrupted，
  // 把那一刻所有 queued/running 的 job 判成服务器中断（这是既有的重启语义，不是本次改动的行为）。
  const runningStore = createMemoryQuestionEnrichmentStore();
  const reuseStores = { ...buildFixture(), questionEnrichmentStore: runningStore };
  const seeded = seedResults(reuseStores, "audit-reuse-job");
  const reuse = await startServer(context, { stores: reuseStores, seeded });
  const active = runningStore.createJob([QUESTION_IDS.complete], { origin: "knowledge_inspection", originLabel: "来自 AI 巡检" });
  assert.equal(active.status, "queued");
  const reuseResponse = await fetch(`${reuse.baseUrl}/api/admin/knowledge-classification/results/${encodeURIComponent(seeded.resultIdByQuestion.get(QUESTION_IDS.complete))}/send-to-enrichment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const reuseBody = await reuseResponse.json();
  assert.equal(reuseResponse.status, 200, JSON.stringify(reuseBody));
  assert.equal(reuseBody.jobId, active.id, "已有排队中的 job 必须复用，不得新排一个");
  assert.equal(runningStore.jobs(10).length, 1, "不得新排第二个 job");
  assert.equal(reuseStores.questionStore.get(QUESTION_IDS.complete).version, 1, "复用路径同样不改库");
  // 复用之后仍然记了一笔"送过"的留痕（人点过就是点过了）。
  assert.ok(seeded.knowledgeClassificationStore.getResult(seeded.resultIdByQuestion.get(QUESTION_IDS.complete)).sentToEnrichmentAt > 0);
});

test("确定性体检：每行带 ruleFindings（分值异常／近似重复／教材依据缺失各自出对 code），只取规则项、只读、每本书只体检一次", async (context) => {
  const stores = buildFixture();
  // 计数器桩：体检服务是通过 `questionStore.list({ bookId })` 拿整本书的，所以这里数它。
  // 一次请求应当**只**体检一次（否则每行都建一次整本书指纹索引，50 行就退化 50 倍）。
  let listCalls = 0;
  // 计数器桩：用 Proxy 转发，不重建 Store 对象——Store 的方法闭包着内部状态，抄出来会破坏协议方法
  // （`createServer` 会校验 `exportState`/`replaceState`，抄一份就报 question_merge_commit_store_incompatible）。
  const realStore = stores.questionStore;
  stores.questionStore = new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === "list") return (filters) => { listCalls += 1; return target.list(filters); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { baseUrl, resultIdByQuestion, knowledgeClassificationStore } = await startServer(context, { stores });

  const beforeVersions = Object.fromEntries(stores.questions.map((item) => [item.id, item.version]));
  const beforeResults = JSON.parse(JSON.stringify(knowledgeClassificationStore.results({ bookId })));
  listCalls = 0;
  const listing = await listItems(baseUrl);
  assert.equal(listCalls, 1, "一次请求只允许建一次整本书的体检索引");

  // ① 分值异常：maxScore = 0。
  const scoreFindings = itemByQuestion(listing, QUESTION_IDS.score).ruleFindings;
  assert.deepEqual(scoreFindings.map((item) => item.code), ["score_abnormal"]);
  // ② 近似重复：与 QUESTION_IDS.complete 事实完全相同（两侧都要报，且指向对方）。
  const duplicateFindings = itemByQuestion(listing, QUESTION_IDS.duplicate).ruleFindings;
  assert.deepEqual(duplicateFindings.map((item) => item.code), ["near_duplicate"]);
  assert.ok(duplicateFindings[0].evidence.questionIds.includes(QUESTION_IDS.complete));
  assert.ok(itemByQuestion(listing, QUESTION_IDS.complete).ruleFindings.some((item) => item.code === "near_duplicate"));
  // ③ 教材依据缺失：章节「第一章 绪论」与知识点「汉语拼音方案」都落不到目录节点（锚点解析失败）。
  assert.deepEqual(itemByQuestion(listing, QUESTION_IDS.plain).ruleFindings.map((item) => item.code), ["evidence_missing"]);

  // 规则项的字段形状：五个字段齐全 + 中文 title/suggestion 来自唯一那份词表（不是行内硬编码）。
  const sample = scoreFindings[0];
  assert.equal(sample.title, "分值缺失或异常");
  assert.equal(sample.severity, "high");
  assert.ok(sample.suggestion, "规则项必须带处置建议");
  assert.ok(sample.detail, "规则项必须带判据说明");
  assert.equal(typeof sample.evidence, "object");
  // ② 每行的规则项来源只能是 rule（AI 项不在 ruleFindings 里造）。
  listing.items.forEach((item) => {
    item.ruleFindings.forEach((finding) => {
      assert.equal(finding.source, "rule", `${item.questionId} 的 ruleFindings 混进了非规则项`);
    });
  });
  // 通过项也留档：summary 里与四态计数并列，互不覆盖。
  assert.equal(typeof listing.summary.ruleFindingsPassed, "number");
  assert.equal(listing.summary.ruleFindingsByCode.score_abnormal, 1);
  assert.equal(listing.summary.ruleFindingsByCode.near_duplicate, 2);
  // 锚点解析不到目录节点的一例（plain）。
  assert.equal(listing.summary.ruleFindingsByCode.evidence_missing, 1);
  // 「通过」＝**真通过**：体检跑过（有 ruleFindings 数组）且没命中任何规则：reviewed／repaired／ignored／enrichment 四道。
  assert.equal(listing.summary.ruleFindingsPassed, 4);
  // 这一册体检跑成了 → 每行都带 ruleFindings 数组（可能是空数组＝跑过且通过）。
  listing.items.forEach((item) => {
    assert.ok(Array.isArray(item.ruleFindings), `${item.questionId} 体检跑成了却没带 ruleFindings 数组`);
  });
  // 跑成了就不出现"未体检"那一档（三态互斥）。
  assert.equal(listing.summary.ruleFindingsUnavailable, undefined);
  assert.deepEqual(
    Object.keys(listing.summary.auditReviewCounts).sort(),
    ["ignored", "pending_review", "repaired", "reviewed"],
    "规则项计数不得覆盖四态计数",
  );

  // ③ 这条路径一个字都不许写：题目版本不变、巡检记录不变（规则项只出现在响应里）。
  assert.deepEqual(Object.fromEntries(stores.questions.map((item) => [item.id, item.version])), beforeVersions);
  // 记录整体逐字节不变（含 auditReview / sentToEnrichmentAt：清单是只读诊断，不落任何新字段）。
  assert.deepEqual(JSON.parse(JSON.stringify(knowledgeClassificationStore.results({ bookId }))), beforeResults);
  const storedResult = knowledgeClassificationStore.getResult(resultIdByQuestion.get(QUESTION_IDS.score));
  assert.equal(storedResult.ruleFindings, undefined, "规则项不得落进巡检记录");
  assert.equal(storedResult.auditReview.state, "pending_review");
  // ① 结论标签也取自同一张表（前端直接显示后端给的 title，不再自建第二份 map）。
  // plain 的知识归属落到目录节点内、与教材一致，巡检结论是 confirmed → 标签「归为通过」。
  assert.equal(itemByQuestion(listing, QUESTION_IDS.plain).issueLabel, "归为通过");
});

test("体检项词表只有一份：server.js 不再有第二张中文标签表，且每个 code 都有非空 title", async () => {
  const serverJs = fs.readFileSync(path.join(__dirname, "..", "apps/api/src/server.js"), "utf8");
  assert.equal(serverJs.includes("knowledgeInspectionIssueLabels"), false, "server.js 里又冒出第二份体检项词表了");
  const { AUDIT_ISSUE_LABELS, auditIssueTitle, formatAuditFindings } = require("../apps/api/src/question-audit-rules");
  const codes = Object.keys(AUDIT_ISSUE_LABELS);
  assert.ok(codes.length >= 13);
  codes.forEach((code) => {
    assert.ok(String(AUDIT_ISSUE_LABELS[code].title || "").trim(), `${code} 缺 title`);
    assert.ok(["rule", "ai"].includes(AUDIT_ISSUE_LABELS[code].source), `${code} 的 source 非法`);
    assert.ok(String(AUDIT_ISSUE_LABELS[code].suggestion || "").trim(), `${code} 缺 suggestion`);
  });
  // 规则项四个 code 必须在表里（清单的分类筛选与计数都按这四个走）。
  ["score_abnormal", "content_defect", "near_duplicate", "evidence_missing"].forEach((code) => {
    assert.equal(AUDIT_ISSUE_LABELS[code].source, "rule");
  });
  assert.equal(auditIssueTitle("near_duplicate"), "近似重复题");
  assert.equal(auditIssueTitle(""), "");
  assert.equal(auditIssueTitle("unknown_code"), "unknown_code", "查不到就原样回 code，界面不至于显示空");
  // 展示行按严重度排序，且带上 title/suggestion（前端不必自己拼）。
  const rows = formatAuditFindings([
    { code: "near_duplicate", detail: "低", evidence: {} },
    { code: "score_abnormal", detail: "高", evidence: {} },
  ]);
  assert.deepEqual(rows.map((row) => row.code), ["score_abnormal", "near_duplicate"]);
  assert.equal(rows[0].title, "分值缺失或异常");
  assert.ok(rows[1].suggestion);
});

test("summary.auditReviewCounts 按派生后的状态计数，且原有 summary 字段一个不少", async (context) => {
  const { baseUrl, resultIdByQuestion } = await startServer(context);
  const listing = await listItems(baseUrl);
  // 六条记录（四态 + 送去完善用那两道）缺省全是待复核。
  assert.deepEqual(listing.summary.auditReviewCounts, { pending_review: 8, reviewed: 0, repaired: 0, ignored: 0 });
  assert.equal(listing.summary.total, 8);

  await reviewAudit(baseUrl, resultIdByQuestion.get(QUESTION_IDS.reviewed), { state: "reviewed" });
  await reviewAudit(baseUrl, resultIdByQuestion.get(QUESTION_IDS.ignored), { state: "ignored" });
  await reviewAudit(baseUrl, resultIdByQuestion.get(QUESTION_IDS.repaired), { state: "repaired" });

  const counted = await listItems(baseUrl);
  assert.deepEqual(counted.summary.auditReviewCounts, { pending_review: 5, reviewed: 1, repaired: 1, ignored: 1 });
  // 逐条与计数对齐（同一处派生，不可能出现"行是复核、计数是待复核"）。
  const derivedStates = counted.items.map((item) => item.auditReview.state).sort();
  assert.deepEqual(derivedStates, ["ignored", "pending_review", "pending_review", "pending_review", "pending_review", "pending_review", "repaired", "reviewed"]);
  // 原有字段一律保留（前端还按这些字段渲染）。
  ["total", "history", "agent1", "agent2", "pending", "applied", "rejected", "highRisk"].forEach((key) => {
    assert.equal(typeof counted.summary[key], "number", `summary.${key} 不得被删掉`);
  });
});

test("静态契约：两条路由与状态白名单一处不差，且生成逻辑只有一份", async () => {
  const serverJs = fs.readFileSync(path.join(__dirname, "..", "apps/api/src/server.js"), "utf8");
  const storeJs = fs.readFileSync(path.join(__dirname, "..", "apps/api/src/knowledge-classification-store.js"), "utf8");
  assert.match(serverJs, /const knowledgeClassificationAuditReviewMatch = url\.pathname\.match\(\/\^\\\/api\\\/admin\\\/knowledge-classification\\\/results\\\/\(\[\^\/\]\+\)\\\/audit-review\$\/\);/);
  assert.match(serverJs, /const knowledgeClassificationSendToEnrichmentMatch = url\.pathname\.match\(\/\^\\\/api\\\/admin\\\/knowledge-classification\\\/results\\\/\(\[\^\/\]\+\)\\\/send-to-enrichment\$\/\);/);
  assert.match(serverJs, /AUDIT_REVIEW_STATES\.has\(state\)/);
  assert.match(serverJs, /error\.message === "audit_review_state_invalid" \? 400/);
  assert.match(serverJs, /\["knowledge_classification_result_not_found", "question_not_found"\]\.includes\(error\.message\) \? 404/);
  // 巡检「送去完善题目」必须带 allowComplete + reuseActiveJob + 来源标记，缺一个就退化成旧语义。
  assert.match(serverJs, /const job = createQuestionEnrichmentJob\(\{ questionIds: \[result\.questionId\] \}, \{\s*allowComplete: true,\s*reuseActiveJob: true,\s*origin: "knowledge_inspection",/);
  // 生成逻辑只有一份：原路由也必须调同一个内部函数，不得留第二份实现，且不得传 options（默认口径不变）。
  assert.match(serverJs, /const job = createQuestionEnrichmentJob\(payload\);/);
  assert.equal((serverJs.match(/questionEnrichmentStore\.createJob\(/g) || []).length, 1, "创建完善任务只能有一处");
  assert.equal((serverJs.match(/questionEnrichmentStore\.activeJobForQuestion\(/g) || []).length, 1, "复用排队中 job 只能有一处判断");
  assert.match(serverJs, /const skipEnrichmentNeedsCheck = initialJob\.origin === "knowledge_inspection";/);
  assert.match(storeJs, /const AUDIT_REVIEW_STATES = new Set\(\["pending_review", "reviewed", "repaired", "ignored"\]\);/);
  assert.match(storeJs, /auditReview: normalizeAuditReview\(input\.auditReview\)/);
  assert.match(storeJs, /sentToEnrichmentAt: Number\(input\.sentToEnrichmentAt\) > 0 \? Number\(input\.sentToEnrichmentAt\) : null/);
  // 来源标记只加字段，不动建议层既有枚举（SUGGESTION_SOURCES 的语义不许被改）。
  const enrichmentStoreJs = fs.readFileSync(path.join(__dirname, "..", "apps/api/src/question-enrichment-store.js"), "utf8");
  assert.match(enrichmentStoreJs, /origin: \["manual", "knowledge_inspection"\]\.includes\(input\.origin\) \? input\.origin : "manual",/);
  assert.match(enrichmentStoreJs, /origin: String\(input\.origin \|\| ""\)\.slice\(0, 60\),/);
});
