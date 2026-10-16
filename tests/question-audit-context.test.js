/**
 * 体检上下文解析层单测（DEC-100，手册 §4.6.12）。
 * 核的事：教材正文就绪判据、题目锚点能否落到目录节点、指纹索引避免 O(n²)、
 * 以及"整批体检"能把规则项来源与通过留档一起给出来。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  auditQuestionBatch,
  buildAuditContext,
  buildNodeTitleIndex,
  questionAnchorResolved,
  resolveTextbookReadiness,
} = require("../apps/api/src/question-audit-context");
const { buildFingerprintIndex } = require("../apps/api/src/question-audit-rules");

const STRUCTURE = {
  bookId: "modern-chinese-7-1",
  nodes: [
    { id: "phonetics", title: "第二章 语音" },
    { id: "method", title: "一、辅音的发音方法" },
    { id: "vowels", title: "二、韵母与韵腹" },
  ],
};

function question(overrides = {}) {
  return {
    id: "ctx-q1",
    bookId: "modern-chinese-7-1",
    subjectId: "modern-chinese",
    type: "single_choice",
    stem: "从阻碍方式看，声母 b 属于哪类辅音？",
    options: [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }],
    correctAnswer: ["A"],
    maxScore: 2,
    primaryKnowledgePoint: "辅音的发音方法",
    ...overrides,
  };
}

test("教材正文就绪：没有记录／状态不对／没有可检索内容都算「取不到依据」", () => {
  assert.equal(resolveTextbookReadiness(null).ready, false);
  assert.match(resolveTextbookReadiness(null).reason, /没有正文记录/);
  assert.equal(resolveTextbookReadiness({ status: "importing", pageCount: 12 }).ready, false);
  assert.match(resolveTextbookReadiness({ status: "importing", pageCount: 12 }).reason, /状态为 importing/);
  assert.equal(resolveTextbookReadiness({ status: "ready", pageCount: 0, chunkCount: 0 }).ready, false);
  assert.match(resolveTextbookReadiness({ status: "ready", pageCount: 0, chunkCount: 0 }).reason, /没有可检索的页／段落/);
  const ok = resolveTextbookReadiness({ status: "ready", pageCount: 420, chunkCount: 3100, version: 7 });
  assert.equal(ok.ready, true);
  assert.equal(ok.pageCount, 420);
  assert.equal(ok.version, 7);
  // 字段名容忍：pageCount／pages 都认，认到的数值回传作证据
  assert.equal(resolveTextbookReadiness({ pages: 3, chunks: 9 }).ready, true);
});

test("题目锚点：显式节点 id 优先，其次知识点／章节标题，都没有则解析不到", () => {
  const nodeIndex = buildNodeTitleIndex(STRUCTURE.nodes);
  assert.equal(questionAnchorResolved(question({ knowledgeNodeId: "method" }), nodeIndex), true);
  assert.equal(questionAnchorResolved(question({ primaryNodeId: "不存在的节点" }), nodeIndex), false, "给了显式节点但不命中，就是解析不到");
  assert.equal(questionAnchorResolved(question({ primaryKnowledgePoint: "辅音的发音方法" }), nodeIndex), true);
  assert.equal(questionAnchorResolved(question({ primaryKnowledgePoint: "一、辅音的发音方法" }), nodeIndex), true, "标题带编号前缀也能命中");
  assert.equal(questionAnchorResolved(question({ primaryKnowledgePoint: "辅音的发音方法", chapter: "第二章 语音" }), nodeIndex), true, "章节命中即可");
  assert.equal(questionAnchorResolved(question({ primaryKnowledgePoint: "声调", chapter: "不存在的章节", knowledgePoints: [] }), nodeIndex), false);
  assert.equal(questionAnchorResolved(question({ primaryKnowledgePoint: "", chapter: "", knowledgePoints: [] }), nodeIndex), false, "完全没有知识归属＝解析不到");
  assert.equal(questionAnchorResolved(question(), null), undefined, "没有教材目录时不编造结论");
});

test("buildAuditContext：逐题锚点＋教材就绪＋指纹索引一次算好", () => {
  // 注意：事实相同的指纹只含 题型＋材料＋题干＋选项，**不含知识归属**（question-store 的 questionFingerprint）。
  // 所以这里刻意让每道题的题干不同，重复只在 q1／q4 之间制造。
  const questions = [
    question({ id: "ctx-q1", stem: "从阻碍方式看，声母 b 属于哪类辅音？", primaryKnowledgePoint: "辅音的发音方法" }),
    question({ id: "ctx-q2", stem: "从阻碍方式看，声母 p 属于哪类辅音？", primaryKnowledgePoint: "辅音的发音方法", knowledgeNodeId: "method" }),
    question({ id: "ctx-q3", stem: "普通话「笑」的韵腹是哪个元音？", primaryKnowledgePoint: "声调", chapter: "第四章 声调", knowledgePoints: [] }),
    question({ id: "ctx-q4", stem: "从阻碍方式看，声母 b 属于哪类辅音？", primaryKnowledgePoint: "辅音的发音方法" }),
  ];
  const context = buildAuditContext({
    questions,
    knowledgeStructure: STRUCTURE,
    textbookKnowledgeSummary: { status: "ready", pageCount: 420, chunkCount: 3100, version: 7 },
  });
  assert.equal(context.textbookReady, true);
  assert.deepEqual(context.anchorResolvedByQuestion, { "ctx-q1": true, "ctx-q2": true, "ctx-q3": false, "ctx-q4": true });
  assert.equal(context.fingerprintIndex.byQuestion.size, 4);
  // ctx-q1 与 ctx-q4 事实相同 → 同一指纹下有两条
  assert.equal([...context.fingerprintIndex.byFingerprint.values()].some((ids) => ids.length === 2), true);

  const batch = auditQuestionBatch({
    questions,
    knowledgeStructure: STRUCTURE,
    textbookKnowledgeSummary: { status: "ready", pageCount: 420, chunkCount: 3100, version: 7 },
  });
  assert.equal(batch.summary.total, 4);
  const byQuestion = batch.byQuestion;
  assert.deepEqual(byQuestion["ctx-q3"].map((row) => row.code), ["evidence_missing"], "锚点解析不到的题报「教材依据缺失」，而不是硬塞一个节点");
  assert.equal(byQuestion["ctx-q1"].some((row) => row.code === "near_duplicate"), true, "事实相同的两道题都要报近似重复");
  assert.equal(byQuestion["ctx-q1"].every((row) => row.source === "rule"), true, "规则层只产规则项");
  assert.equal(batch.summary.bySource.ai, 0);
});

test("全库体检不退化成 O(n²)：1200 道题的指纹索引只算一遍", () => {
  const questions = Array.from({ length: 1200 }, (unused, index) => question({
    id: `bulk-${index}`,
    stem: `第 ${index} 号题的题干（互不相同，避免被判成事实相同）：从阻碍方式看声母属于哪类？`,
  }));
  const startedAt = Date.now();
  const index = buildFingerprintIndex(questions);
  const context = buildAuditContext({ questions, knowledgeStructure: STRUCTURE, fingerprintIndex: index });
  const batch = auditQuestionBatch({
    questions,
    knowledgeStructure: STRUCTURE,
    textbookKnowledgeSummary: { status: "ready", pageCount: 420, chunkCount: 3100 },
    fingerprintIndex: index,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(index.byQuestion.size, 1200);
  assert.equal(context.fingerprintIndex, index, "传进来的索引被复用，不重建");
  assert.equal(batch.summary.total, 1200);
  assert.equal(batch.summary.byCode.near_duplicate || 0, 0, "1200 道互不相同的题不该有近似重复");
  assert.equal(elapsed < 5000, true, `1200 道题的批量体检应在 5s 内（实测 ${elapsed}ms）`);
});
