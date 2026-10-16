/**
 * 体检服务层单测（DEC-100，手册 §4.6.12）：用真实内存 Store 跑，核"Store → 规则"的接线。
 * 重点：按批体检时重复题索引仍建在整本书上（否则跨批重复会漏报）、通过也留档、只读不改库。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createQuestionAuditService } = require("../apps/api/src/question-audit-service");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryTextbookKnowledgeStore } = require("../apps/api/src/textbook-knowledge-store");

const BOOK_ID = "modern-chinese-7-1";

function question(overrides = {}) {
  return {
    id: "audit-q1",
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId: BOOK_ID,
    chapter: "第二章 语音 > 辅音的发音方法",
    primaryKnowledgePoint: "辅音的发音方法",
    knowledgePoints: ["辅音的发音方法"],
    type: "single_choice",
    typeLabel: "单选题",
    stem: "从阻碍方式看，声母 b 属于哪类辅音？",
    options: [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }],
    correctAnswer: ["A"],
    referenceAnswer: "塞音",
    maxScore: 2,
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    version: 1,
    ...overrides,
  };
}

function build() {
  const questions = [
    question({ id: "audit-q1" }),
    question({ id: "audit-q2", stem: "这道题的分值没有给出来。", maxScore: 0 }),
    question({ id: "audit-q3", stem: "普通话「笑」的韵腹是哪个元音？", primaryKnowledgePoint: "韵母与韵腹", chapter: "第二章 语音 > 韵母与韵腹" }),
    question({ id: "audit-q4" }), // 与 audit-q1 事实相同（同题型＋同材料＋同题干＋同选项）
  ];
  // 注意：`create()` 会按 DEC-099 校验分值（0 分会被拒），所以这里用构造期种入，
  // 模拟"库里真的存在一道 0 分的题"——体检要能把它查出来。
  const store = createMemoryQuestionStore(questions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: BOOK_ID,
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "method", level: 3, title: "辅音的发音方法", startPage: 36, endPage: 42 },
      { id: "vowels", level: 3, title: "韵母与韵腹", startPage: 44, endPage: 52 },
    ],
    outlineNodes: [],
    chunks: [],
    questions,
  });
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([
    { bookId: BOOK_ID, status: "ready", version: 3, pageCount: 420, chunkCount: 3100, chunks: [], pages: [] },
  ]);
  // 教材正文摘要用桩：本层只消费 `get(bookId)` 的摘要（正文就绪判据本身在 question-audit-context.test.js 单独核过），
  // 真实 Store 的"空记录＝取不到依据"分支由第 4 个用例覆盖。
  const textbookSummaryStore = {
    get: () => ({ status: "ready", version: 3, pageCount: 420, chunkCount: 3100 }),
  };
  return { questions, store, knowledgeStructureStore, textbookKnowledgeStore, textbookSummaryStore };
}

test("auditBook：真实 Store 接线、通过留档、四类规则项都出得来", () => {
  const { store, knowledgeStructureStore, textbookSummaryStore } = build();
  const service = createQuestionAuditService({
    questionStore: store,
    knowledgeStructureStore,
    textbookKnowledgeStore: textbookSummaryStore,
  });
  const report = service.auditBook({ bookId: BOOK_ID });
  assert.equal(report.bookId, BOOK_ID);
  assert.equal(report.scope.bookQuestionCount, 4);
  assert.equal(report.scope.auditedCount, 4);
  assert.equal(report.textbookReadiness.ready, true, `教材正文应判为可检索：${JSON.stringify(report.textbookReadiness)}`);
  assert.equal(report.knowledgeNodeCount >= 3, true);
  assert.equal(Number.isNaN(Date.parse(report.generatedAt)), false);

  const byId = report.byQuestion;
  assert.equal(byId["audit-q2"].some((row) => row.code === "score_abnormal"), true, "0 分题要报分值异常");
  assert.equal(byId["audit-q1"].some((row) => row.code === "near_duplicate"), true, "事实相同的两道题都要报近似重复");
  assert.deepEqual(byId["audit-q4"].map((row) => row.code), ["near_duplicate"], "通过以外的唯一问题就是重复");
  assert.equal(report.passed.length, 1, `只有 audit-q3 完全没问题（实际通过：${JSON.stringify(report.passed)}）`);
  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.passed + report.summary.failed, 4);
  assert.equal(report.summary.bySource.ai, 0, "服务层只跑规则项");
});

test("按批体检：重复题索引仍建在整本书上（跨批重复不漏报）", () => {
  const { store, knowledgeStructureStore, textbookSummaryStore } = build();
  const service = createQuestionAuditService({ questionStore: store, knowledgeStructureStore, textbookKnowledgeStore: textbookSummaryStore });
  // 只体检 audit-q4，但它的"事实相同"伙伴 audit-q1 不在这一批里
  const scoped = service.auditBook({ bookId: BOOK_ID, questionIds: ["audit-q4"] });
  assert.equal(scoped.scope.auditedCount, 1);
  assert.equal(scoped.scope.bookQuestionCount, 4);
  const findings = scoped.byQuestion["audit-q4"] || [];
  const duplicate = findings.find((row) => row.code === "near_duplicate");
  assert.equal(Boolean(duplicate), true, "按批体检也必须能发现整本书范围内的重复题");
  assert.deepEqual(duplicate.evidence.questionIds, ["audit-q1"]);

  // 单题入口同样用整本书索引
  const one = service.auditOne("audit-q4", { bookId: BOOK_ID });
  assert.equal(one.questionId, "audit-q4");
  assert.equal(one.passed, false);
  assert.equal(one.findings.some((row) => row.code === "near_duplicate"), true);
});

test("只读：跑完体检不改任何题目字段与版本", () => {
  const { store, knowledgeStructureStore, textbookSummaryStore } = build();
  const before = store.list({ bookId: BOOK_ID }).questions.map((item) => JSON.stringify(item)).sort();
  const service = createQuestionAuditService({ questionStore: store, knowledgeStructureStore, textbookKnowledgeStore: textbookSummaryStore });
  service.auditBook({ bookId: BOOK_ID });
  const after = store.list({ bookId: BOOK_ID }).questions.map((item) => JSON.stringify(item)).sort();
  assert.deepEqual(after, before, "巡检只诊断：体检前后题目必须逐字节一致");
});

test("边界：缺 bookId 报错、没有教材正文时如实报「教材依据取不到」而不是假装通过", () => {
  const { store, knowledgeStructureStore } = build();
  const service = createQuestionAuditService({ questionStore: store, knowledgeStructureStore });
  assert.throws(() => service.auditBook({ bookId: "" }), /question_audit_book_required/);
  const report = service.auditBook({ bookId: BOOK_ID });
  assert.equal(report.textbookReadiness.ready, false);
  assert.match(report.textbookReadiness.reason, /没有正文记录/);
  assert.equal(report.byQuestion["audit-q3"].some((row) => row.code === "evidence_missing"), true);
  assert.throws(() => createQuestionAuditService({}), /question_audit_question_store_required/);
});
