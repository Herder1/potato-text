/**
 * AI 巡检确定性体检规则的单测（DEC-100，手册 §4.6.12）。
 * 核的是：规则只报确定性事实、判据与既有口径同源（分值走 DEC-099 内核、重复走 Store 指纹）、
 * 规则项与 AI 项可区分来源，以及**通过也要留档**。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AUDIT_ISSUE_LABELS,
  AUDIT_PASS_CODE,
  auditQuestion,
  auditQuestions,
  contentDefectFindings,
  duplicateFindings,
  evidenceDefectFindings,
  scoreDefectFindings,
} = require("../apps/api/src/question-audit-rules");

function question(overrides = {}) {
  return {
    id: "audit-q1",
    bookId: "modern-chinese-7-1",
    subjectId: "modern-chinese",
    type: "single_choice",
    stem: "从阻碍方式看，声母 b 属于哪类辅音？",
    options: [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }],
    correctAnswer: ["A"],
    maxScore: 2,
    ...overrides,
  };
}

test("题干／选项残缺：只报确定性残缺，需要语义判断的不猜", () => {
  assert.deepEqual(contentDefectFindings(question()), []);
  const codes = (item) => contentDefectFindings(item).map((row) => row.detail);

  assert.deepEqual(codes(question({ stem: "" })), ["题干为空"]);
  assert.match(codes(question({ stem: "选" }))[0], /题干过短/);
  assert.match(codes(question({ options: [{ key: "A", text: "塞音" }] }))[0], /只有 1 个选项/);
  assert.match(codes(question({ options: [{ key: "A", text: "塞音" }, { key: "B", text: "塞音" }] }))[0], /选项文本重复/);
  assert.deepEqual(codes(question({ correctAnswer: [] })), ["客观题没有正确答案"]);
  assert.match(codes(question({ correctAnswer: ["C"] }))[0], /指向不存在的选项/);
  assert.match(codes(question({ type: "single_choice", correctAnswer: ["A", "B"] }))[0], /单选题给了 2 个正确答案/);
  assert.match(codes(question({ usesSharedMaterial: true, material: "" }))[0], /材料正文为空/);
  // 错别字这类语义判断不在这里报（留给 AI 项），否则规则会自造结论。
  assert.deepEqual(contentDefectFindings(question({ stem: "从组碍方式看，声母 b 属于哪类辅音？" })), []);
});

test("分值缺失或异常：单题 0 分／空分与题组总分取不到都要报，判据走 DEC-099 内核", () => {
  assert.deepEqual(scoreDefectFindings(question()), []);
  assert.match(scoreDefectFindings(question({ maxScore: 0 }))[0].detail, /当前分值为 0/);
  assert.match(scoreDefectFindings(question({ maxScore: "" }))[0].detail, /当前分值为 空/);
  assert.match(scoreDefectFindings(question({ maxScore: -1 }))[0].detail, /未给出有效分值/);

  const sub1 = question({ id: "sub-1", materialGroupId: "text-material-9", maxScore: 0, usesSharedMaterial: true, material: "阅读材料。" });
  const sub2 = question({ id: "sub-2", materialGroupId: "text-material-9", maxScore: 0, usesSharedMaterial: true, material: "阅读材料。" });
  const group = scoreDefectFindings(sub1, { members: [sub1, sub2] });
  assert.equal(group.some((row) => row.detail.includes("总分取不到")), true, "组内无人有分值且没有科目默认满分时，题组总分取不到");

  const orphan = question({ id: "sub-3", materialGroupId: "text-material-404", maxScore: 0 });
  assert.match(scoreDefectFindings(orphan, { members: [orphan] }).map((row) => row.detail).join(" | "), /找不到其他小问/);

  const crossSubject = [
    question({ id: "sub-a", materialGroupId: "text-material-9", maxScore: 5 }),
    question({ id: "sub-b", materialGroupId: "text-material-9", maxScore: 5, subjectId: "ancient-chinese" }),
  ];
  assert.match(scoreDefectFindings(crossSubject[0], { members: crossSubject }).map((row) => row.detail).join(" | "), /分属不同科目/);
  // 组内分值正常时不报："通过"必须真的能不报。
  assert.deepEqual(scoreDefectFindings(question({ materialGroupId: "", maxScore: 2 })), []);
});

test("教材依据缺失：只查「拿不到依据」的客观条件，不判断与教材不一致", () => {
  assert.deepEqual(evidenceDefectFindings(question(), { textbookReady: true, anchorResolved: true }), []);
  const details = (context, item = question()) => evidenceDefectFindings(item, context).map((row) => row.detail).join(" | ");
  assert.match(details({ textbookReady: false }), /还没有可检索的正文/);
  assert.match(details({ textbookReady: true, anchorResolved: false }), /解析不到教材目录节点/);
  assert.match(details({ textbookReady: true }, question({ bookId: "" })), /没有教材归属/);
  // 该场景不要求教材依据时（例如纯材料题不需要教材支撑），不报。
  assert.deepEqual(evidenceDefectFindings(question(), { textbookReady: false, evidenceExpected: false }), []);
});

test("近似重复：事实相同用 Store 同源指纹，疑似重复走注入的口径", () => {
  const target = question({ id: "audit-q1" });
  // 事实相同＝题型＋材料＋题干＋选项归一化后一致（与 Store 的 questionFingerprint 同源），只有 id 不同。
  const same = question({ id: "audit-q2" });
  const different = question({ id: "audit-q3", stem: "普通话「笑」的韵腹是哪个元音？", options: [{ key: "A", text: "a" }, { key: "B", text: "o" }] });

  assert.deepEqual(duplicateFindings(target, { others: [] }), []);
  assert.deepEqual(duplicateFindings(target, { others: [different] }), []);

  const sameFacts = duplicateFindings(target, { others: [same] });
  assert.equal(sameFacts.length, 1);
  assert.equal(sameFacts[0].evidence.sameFacts, true);
  assert.deepEqual(sameFacts[0].evidence.questionIds, ["audit-q2"]);

  // 疑似重复（改数字之类）由调用方注入，复用导入查重口径——本模块不自己发明相似度算法。
  const fuzzy = duplicateFindings(target, { others: [different], similarMatcher: () => true });
  assert.equal(fuzzy.length, 1);
  assert.equal(fuzzy[0].evidence.sameFacts, false);
  assert.deepEqual(fuzzy[0].evidence.questionIds, ["audit-q3"]);
});

test("auditQuestions：通过也要留档、来源可区分、严重度排序稳定", () => {
  const questions = [
    question({ id: "ok-1" }),
    question({ id: "bad-score", stem: "这道题的分值没有给出来。", maxScore: 0 }),
    question({ id: "bad-content", stem: "这道题的选项自己重复了。", options: [{ key: "A", text: "塞音" }, { key: "B", text: "塞音" }] }),
  ];
  const report = auditQuestions(questions, { textbookReady: true, anchorResolved: true });
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 2);
  assert.deepEqual(report.passed, ["ok-1"], "通过的那道题也要留在结论里，不能只报异常");
  assert.equal(report.summary.bySource.rule > 0, true);
  assert.equal(report.summary.bySource.ai, 0, "规则模块不产 AI 项");
  assert.deepEqual(Object.keys(report.byQuestion).sort(), ["bad-content", "bad-score", "ok-1"]);
  assert.deepEqual(report.byQuestion["ok-1"], []);
  assert.deepEqual(report.findings.map((row) => row.questionId).sort(), ["bad-content", "bad-score"]);
  // 严重度排序：high 在前
  const mixed = auditQuestion(question({ id: "mix", maxScore: 0, stem: "短" }));
  assert.equal(mixed[0].severity, "high");
});

test("体检项词汇一处维护：10 项都在，且规则项／AI 项／通过项分得开", () => {
  const expected = [
    "answer_conflict", "previous_level_wrong", "cross_knowledge", "missing_node", "uncertain",
    "near_duplicate", "score_abnormal", "content_defect", "evidence_missing", AUDIT_PASS_CODE,
  ];
  expected.forEach((code) => assert.equal(Boolean(AUDIT_ISSUE_LABELS[code]), true, `缺少体检项 ${code}`));
  assert.equal(AUDIT_ISSUE_LABELS.score_abnormal.source, "rule");
  assert.equal(AUDIT_ISSUE_LABELS.near_duplicate.source, "rule");
  assert.equal(AUDIT_ISSUE_LABELS.content_defect.source, "rule");
  assert.equal(AUDIT_ISSUE_LABELS.evidence_missing.source, "rule");
  assert.equal(AUDIT_ISSUE_LABELS.answer_conflict.source, "ai");
  assert.equal(AUDIT_ISSUE_LABELS.confirmed.severity, "none");
});
