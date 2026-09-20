// 盲测金标「覆盖门禁」契约测试
//
// 目的：审核页门禁（classification-gold-review-store）与 C1 零模型预检
// （scripts/classification-blind-replay-context）必须对同一份金标给出同一个结论。
// 2026-09-05 的事故正是两处各写一份判断：页面按“祖先节点容忍”放行，预检按
// “规范节点集合”阻断，导致第 5、10 题在页面上永远显示可冻结。
//
// 依据：DEC-039、产品手册 4.11 与 5.8.12 —— 成员贡献知识必须同时属于题目最小
// 充分知识集与题族覆盖知识；父子、祖先、同章或共同范围锚点关系均不得替代该校验。
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  validateGoldReviewBatchFamilySemantics,
} = require("../apps/api/src/classification-gold-review-store");
const {
  buildGoldSemanticPreflight,
} = require("../scripts/classification-blind-replay-context");

const BOOK_ID = "modern-chinese-7-1";
const node = (id, title, path) => ({
  id, canonicalNodeId: "", aliasNodeIds: [], title, path,
});
const CORE = node("node-core", "核心知识", "知识 > 核心知识");
const SECONDARY = node("node-secondary", "辅助知识", "知识 > 辅助知识");
const PARENT = node("node-parent", "父级范围", "知识 > 父级范围");
const CHILD = node("node-child", "叶节点知识", "知识 > 父级范围 > 叶节点知识");
const CORE_ALIAS = {
  id: "node-core-alias", canonicalNodeId: "node-core", aliasNodeIds: [], title: "核心知识", path: "知识 > 核心知识",
};

// 题族的“独立成员”= members 中 isPrimary === true 的成员；成员关系里的
// membership.isPrimary 必须与该题族是否是本题主题族一致。
function familyFact(options = {}) {
  const {
    id = "family-mature",
    questionId = "q-mature",
    coverage = [CORE],
    contribution = [CORE],
    memberQuestionIds = [questionId, `${questionId}-other`],
    independentMemberIds = memberQuestionIds,
    questionIsPrimary = true,
  } = options;
  const questionRole = questionIsPrimary ? "prototype" : "similar";
  return {
    id,
    name: `测试题族 ${id}`,
    version: 2,
    status: "confirmed",
    bookId: BOOK_ID,
    coreKnowledge: coverage[0],
    coreKnowledgeNodeId: coverage[0].id,
    requiredKnowledge: coverage,
    requiredKnowledgeNodeIds: coverage.map((entry) => entry.id),
    textbookAnchors: [coverage[0]],
    textbookAnchorNodeIds: [coverage[0].id],
    focusKey: "fixture-focus",
    assessmentAction: "概念识别",
    inclusionBoundary: "",
    exclusionBoundary: "",
    independentMemberCount: independentMemberIds.length,
    memberQuestionIds,
    independentMemberQuestionIds: independentMemberIds,
    retainedIndependentMemberQuestionIds: independentMemberIds.filter((value) => value !== questionId),
    members: memberQuestionIds.map((value) => ({
      questionId: value,
      isPrimary: independentMemberIds.includes(value),
      role: value === questionId ? questionRole : "prototype",
      trainingLevel: "foundation",
      reviewStatus: "confirmed",
      action: "概念识别",
      variationDimensions: [],
      confidence: 1,
      reason: "contract fixture",
      contributionKnowledgeNodeIds: value === questionId ? contribution.map((entry) => entry.id) : [],
      contributionKnowledge: value === questionId ? contribution : [],
    })),
    membership: {
      questionId,
      isPrimary: questionIsPrimary,
      role: questionRole,
      reviewStatus: "confirmed",
      contributionKnowledgeNodeIds: contribution.map((entry) => entry.id),
      contributionKnowledge: contribution,
      revision: 3,
    },
  };
}

function answerKnowledgeFor(requiredNodes, coreNode = CORE) {
  return {
    correctAnswer: ["A"],
    referenceAnswer: "A 正确。",
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    textbookEvidence: [{ chunkId: "chunk-1", excerpt: "教材原文", printedPageStart: 30 }],
    coreKnowledge: coreNode,
    coreKnowledgeRole: "core",
    requiredKnowledge: requiredNodes,
    optionKnowledge: [
      { key: "A", text: "甲", role: "answer", knowledgeRelation: "question_only" },
      { key: "B", text: "乙", role: "distractor", knowledgeRelation: "question_only" },
    ],
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
  };
}

// 构建一份公开事实完全相同的金标：同一组题目事实分别喂给两个门禁。
function buildCase(options = {}) {
  const {
    matureCoverage = [CORE],
    matureContribution = [CORE],
    matureRequired = [CORE, SECONDARY],
    matureCore = CORE,
    withRequiredRelatedFamily = true,
  } = options;
  const matureFamily = familyFact({
    id: "family-mature", questionId: "q-mature", coverage: matureCoverage, contribution: matureContribution,
  });
  const requiredRelatedFamily = familyFact({
    id: "family-required",
    questionId: "q-mature",
    coverage: [SECONDARY],
    contribution: [SECONDARY],
    memberQuestionIds: ["family-required-prototype", "q-mature"],
    independentMemberIds: ["family-required-prototype"],
    questionIsPrimary: false,
  });
  const singletonFamily = familyFact({
    id: "family-singleton", questionId: "q-singleton",
    memberQuestionIds: ["q-singleton"],
  });
  const candidateFamily = familyFact({ id: "family-candidate", questionId: "q-unmatched" });

  const matureFamilyGold = {
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
    replayMode: "mature",
    decision: "join_existing",
    primaryFamilyId: matureFamily.id,
    relatedFamilyIds: withRequiredRelatedFamily ? [requiredRelatedFamily.id] : [],
    relatedFamilyRelations: withRequiredRelatedFamily
      ? [{ familyId: requiredRelatedFamily.id, coverageRole: "required" }]
      : [],
    families: withRequiredRelatedFamily ? [matureFamily, requiredRelatedFamily] : [matureFamily],
    reason: "contract fixture",
  };
  const singletonFamilyGold = {
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
    replayMode: "singleton",
    decision: "join_existing",
    primaryFamilyId: singletonFamily.id,
    relatedFamilyIds: [],
    relatedFamilyRelations: [],
    families: [singletonFamily],
    reason: "contract fixture",
  };
  const unmatchedFamilyGold = {
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
    replayMode: "unmatched",
    decision: "create_new",
    primaryFamilyId: "",
    relatedFamilyIds: [],
    relatedFamilyRelations: [],
    families: [],
    candidateFamily,
    reason: "contract fixture",
  };

  const questionSnapshot = (questionId) => ({
    id: questionId,
    version: 1,
    bookId: BOOK_ID,
    type: "single_choice",
    typeLabel: "单选题",
    stem: "下列说法正确的是（ ）。",
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
    choiceStructure: "direct_options",
    atomicStatements: [],
    optionComposition: [],
    correctAnswer: ["A"],
    referenceAnswer: "A 正确。",
    scoringPoints: [],
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    answerVerified: true,
  });
  const items = [
    { questionId: "q-mature", replayMode: "mature", answerKnowledge: answerKnowledgeFor(matureRequired, matureCore), familyGold: matureFamilyGold },
    { questionId: "q-singleton", replayMode: "singleton", answerKnowledge: answerKnowledgeFor([CORE]), familyGold: singletonFamilyGold },
    { questionId: "q-unmatched", replayMode: "unmatched", answerKnowledge: answerKnowledgeFor([CORE]), familyGold: unmatchedFamilyGold },
  ];

  const snapshot = {
    schemaVersion: "ClassificationGoldSnapshotV1",
    optionKnowledgeProtocolVersion: "option-knowledge-v2",
    snapshotId: "classification-gold-contract",
    version: "V2",
    status: "frozen",
    source: {},
    items: items.map((entry, index) => ({
      order: index + 1,
      questionId: entry.questionId,
      replayMode: entry.replayMode,
      goldStatus: "confirmed",
      includedInAccuracy: true,
      questionSnapshot: questionSnapshot(entry.questionId),
      answerAndEvidence: entry.answerKnowledge,
      knowledgeGold: entry.answerKnowledge,
      familyGold: entry.familyGold,
      audit: {},
    })),
  };
  const batch = {
    id: "gold-gate-contract",
    title: "覆盖门禁契约",
    version: "V2",
    status: "reviewing",
    source: { parentSnapshotId: "classification-gold-contract-parent", parentVersion: "V1" },
    revision: 1,
    items: items.map((entry, index) => ({
      order: index + 1,
      questionId: entry.questionId,
      sourceMode: entry.replayMode,
      contentReview: { result: "confirmed", reviewer: "fixture" },
      familyReview: { result: "corrected", reviewer: "fixture" },
      humanGold: { answerKnowledge: entry.answerKnowledge, familyGold: entry.familyGold },
    })),
  };
  return { snapshot, batch };
}

function storeVerdict(batch) {
  const validation = validateGoldReviewBatchFamilySemantics(batch);
  const blocked = new Map();
  for (const issue of validation.issues) {
    if (!issue.questionId) continue;
    const entry = blocked.get(issue.questionId) || { codes: new Set(), outside: new Set() };
    entry.codes.add(issue.code);
    const actual = issue.actual && typeof issue.actual === "object" ? issue.actual : {};
    for (const graph of [actual.outsideFamilyCoverage, actual.outsideQuestion]) {
      for (const item of Array.isArray(graph) ? graph : []) entry.outside.add(item.id);
    }
    blocked.set(issue.questionId, entry);
  }
  return blocked;
}

function preflightVerdict(snapshot) {
  const report = buildGoldSemanticPreflight(
    { snapshot, filePath: "contract.json", fileSha256: "c".repeat(64), contentSha256: "d".repeat(64) },
    { expectedCount: snapshot.items.length },
  );
  const blocked = new Map();
  for (const blocker of report.blockers) {
    if (!blocker.questionId) continue;
    const entry = blocked.get(blocker.questionId) || { codes: new Set(), outside: new Set() };
    entry.codes.add(blocker.code);
    const actual = blocker.actual && typeof blocker.actual === "object" ? blocker.actual : {};
    for (const graph of [actual.outsideFamilyCoverage, actual.outsideQuestion]) {
      for (const item of Array.isArray(graph) ? graph : []) entry.outside.add(item.id);
    }
    blocked.set(blocker.questionId, entry);
  }
  return { blocked, report };
}

function assertGatesAgree(options, expectedBlockedQuestions, expectedOutsideNodes = []) {
  const built = buildCase(options);
  const store = storeVerdict(built.batch);
  const { blocked: preflight, report } = preflightVerdict(built.snapshot);

  assert.deepEqual(
    [...store.keys()].sort(),
    [...preflight.keys()].sort(),
    `两个门禁阻断的题目集合必须一致；`
      + `审核页门禁：${JSON.stringify([...store].map(([id, entry]) => [id, [...entry.codes]]))}；`
      + `预检：${JSON.stringify(report.blockers.map((entry) => [entry.questionId, entry.code, entry.message]))}`,
  );
  assert.deepEqual([...store.keys()].sort(), [...expectedBlockedQuestions].sort());
  for (const [questionId, entry] of store) {
    assert.deepEqual(
      [...entry.outside].sort(),
      [...expectedOutsideNodes].sort(),
      `题目 ${questionId} 的越界知识节点必须在两个门禁中一致`,
    );
    assert.deepEqual([...entry.outside].sort(), [...preflight.get(questionId).outside].sort());
  }
  return { store, preflight };
}

test("契约：显式覆盖知识时两个门禁都放行", () => {
  assertGatesAgree({
    matureCoverage: [CORE],
    matureContribution: [CORE],
    matureRequired: [CORE, SECONDARY],
  }, []);
});

test("契约：题族只声明父节点覆盖知识时两个门禁都阻断叶节点贡献", () => {
  const { store, preflight } = assertGatesAgree({
    matureCoverage: [PARENT],
    matureContribution: [CHILD],
    matureRequired: [CHILD],
    matureCore: CHILD,
    withRequiredRelatedFamily: false,
  }, ["q-mature"], ["node-child"]);
  // 祖先关系不再替代交集校验：核对该题确实带着“越界”证据而不是被放行。
  assert.ok(store.get("q-mature").codes.has("required_family_no_knowledge_contribution"));
  assert.ok(preflight.get("q-mature").codes.has("family_required_knowledge_outside_question"));
});

test("契约：题族显式声明叶节点覆盖知识时两个门禁都放行", () => {
  assertGatesAgree({
    matureCoverage: [PARENT, CHILD],
    matureContribution: [CHILD],
    matureRequired: [CHILD],
    matureCore: CHILD,
    withRequiredRelatedFamily: false,
  }, []);
});

test("契约：成员贡献为空时两个门禁都阻断", () => {
  assertGatesAgree({
    matureCoverage: [CORE],
    matureContribution: [],
    matureRequired: [CORE, SECONDARY],
  }, ["q-mature"]);
});

test("契约：显式别名仍视为同一节点，两个门禁都放行", () => {
  assertGatesAgree({
    matureCoverage: [CORE],
    matureContribution: [CORE_ALIAS],
    matureRequired: [CORE, SECONDARY],
  }, []);
});

test("契约：联合覆盖缺失时两个门禁都阻断", () => {
  assertGatesAgree({
    matureCoverage: [CORE],
    matureContribution: [CORE],
    matureRequired: [CORE, SECONDARY, PARENT],
  }, ["q-mature"]);
});
