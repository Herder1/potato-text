const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  contentHash,
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  readFrozenGoldSnapshot,
} = require("../apps/api/src/classification-gold-review-store");
const {
  buildGoldSemanticPreflight,
  buildReplayContextPreflight,
  createReplayContextDocument,
  findGoldLeakPaths,
  findSecretConfigPaths,
  knowledgeGoldFor,
  readReplayContext,
  sanitizeAiConfig,
  sanitizeContextQuestion,
  writeReplayContext,
} = require("../scripts/classification/classification-blind-replay-context");

function family(questionId, mode) {
  const nodeId = `node-${questionId}`;
  const retainedId = `${questionId}-retained`;
  const memberIds = mode === "mature" ? [questionId, retainedId] : [questionId];
  return {
    id: `family-${questionId}`,
    name: `题族 ${questionId}`,
    focusKey: `focus-${questionId}`,
    bookId: "book-1",
    status: "confirmed",
    coreKnowledgeNodeId: nodeId,
    requiredKnowledgeNodeIds: [nodeId],
    textbookAnchorNodeIds: [nodeId],
    assessmentAction: "概念识别",
    inclusionBoundary: "纳入同一概念识别题",
    exclusionBoundary: "排除其他概念",
    independentMemberCount: memberIds.length,
    memberQuestionIds: memberIds,
    independentMemberQuestionIds: memberIds,
    retainedIndependentMemberQuestionIds: memberIds.filter((id) => id !== questionId),
    // 独立成员清单 = isPrimary=true 的主归属成员（与 classification-gold-review-store 口径一致）。
    // 另挂一个普通副归属成员：它存在于正式题族，但不是独立成员，不得进入回放上下文。
    members: [
      ...memberIds.map((id, index) => ({
        questionId: id,
        isPrimary: true,
        role: index === 0 ? "prototype" : "similar",
        contributionKnowledgeNodeIds: id === questionId ? [nodeId] : [],
      })),
      {
        questionId: `${questionId}-ordinary`,
        isPrimary: false,
        role: "similar",
        contributionKnowledgeNodeIds: [],
      },
    ],
  };
}

function goldItem(questionId, mode, order) {
  const nodeId = `node-${questionId}`;
  const existingFamily = mode === "unmatched" ? null : family(questionId, mode);
  return {
    order,
    questionId,
    replayMode: mode,
    goldStatus: "confirmed",
    includedInAccuracy: true,
    questionSnapshot: {
      id: questionId,
      bookId: "book-1",
      version: 1,
      type: "single",
      stem: `题干 ${questionId}`,
      options: [{ key: "A", text: "选项" }],
    },
    answerAndEvidence: { correctAnswer: ["A"], referenceAnswer: "来源答案" },
    knowledgeGold: {
      coreKnowledge: { id: nodeId, title: nodeId, path: nodeId },
      requiredKnowledge: [{ id: nodeId, title: nodeId, path: nodeId }],
    },
    familyGold: {
      familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
      replayMode: mode,
      decision: mode === "unmatched" ? "create_new" : "join_existing",
      primaryFamilyId: existingFamily?.id || "",
      relatedFamilyIds: [],
      families: existingFamily ? [existingFamily] : [],
      candidateFamily: mode === "unmatched" ? {
        name: `候选题族 ${questionId}`,
        focusKey: `focus-${questionId}`,
        bookId: "book-1",
        coreKnowledgeNodeId: nodeId,
        requiredKnowledgeNodeIds: [nodeId],
        textbookAnchorNodeIds: [nodeId],
        assessmentAction: "概念识别",
        inclusionBoundary: "纳入同一概念识别题",
        exclusionBoundary: "排除其他概念",
        membership: {
          questionId,
          contributionKnowledgeNodeIds: [nodeId],
        },
      } : null,
    },
  };
}

function writeGold(root, items, version = "V2") {
  const payload = {
    schemaVersion: "ClassificationGoldSnapshotV1",
    snapshotId: `snapshot-${version}`,
    title: "测试金标",
    version,
    status: "frozen",
    source: {},
    reviewBatchId: "review-test",
    reviewer: "测试员",
    reviewedAt: new Date(0).toISOString(),
    frozenAt: new Date(0).toISOString(),
    summary: { total: items.length },
    items,
  };
  const document = { ...payload, integrity: { algorithm: "sha256", contentSha256: contentHash(payload) } };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  const filePath = path.join(root, "gold.json");
  const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(filePath, bytes);
  fs.writeFileSync(`${filePath}.sha256`, `${fileHash}  gold.json\n`, "utf8");
  return filePath;
}

function runtimeState(items) {
  const families = items.flatMap((item) => item.familyGold.families || []);
  const questionIds = [...new Set([
    ...items.map((item) => item.questionId),
    ...families.flatMap((entry) => entry.members.map((member) => member.questionId)),
  ])];
  return {
    sourceFileHashes: { "questions.json": "source-hash" },
    data: {
      questions: questionIds.map((questionId) => ({
        id: questionId,
        bookId: "book-1",
        version: 1,
        library: "official",
        status: "official",
        type: "single",
        stem: `题干 ${questionId}`,
        options: [{ key: "A", text: "选项" }],
        correctAnswer: ["A"],
        referenceAnswer: "正式来源答案",
        answerSource: "team_verified",
        answerReviewStatus: "verified",
        answerVerified: true,
        knowledgeGold: { mustNotLeak: true },
      })),
      questionFamilies: { families, familySets: [], familySetLinks: [], familyAliases: {}, historyByBook: {} },
      knowledgeStructures: { records: [{ bookId: "book-1", nodes: [], fingerprints: items.map((item) => ({ questionId: item.questionId })) }], editsByBook: {} },
      textbookKnowledge: [{ bookId: "book-1", chunks: [] }],
      textbookCatalogs: [{ bookId: "book-1", nodes: [] }],
      knowledgeDossiers: { dossiers: [], deltas: [], runs: [] },
      knowledgeClassificationExperience: { messages: [], rules: [], cases: [], corrections: [], ruleExceptions: [], reviewEvents: [], dossierSuggestions: [] },
      aiConfig: {
        providers: [{
          id: "provider-1",
          baseUrl: "https://user:pass@example.test/v1?token=secret",
          apiKey: "secret-key",
          accessToken: "secret-token",
          enabled: true,
        }],
        routes: { knowledge_feature_extraction: { mode: "provider", providerId: "provider-1", model: "model-1" } },
        prompts: { knowledge_feature_extraction: { systemPrompt: "prompt" } },
      },
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blind-context-"));
  const items = [
    goldItem("q-mature", "mature", 1),
    goldItem("q-singleton", "singleton", 2),
    goldItem("q-unmatched", "unmatched", 3),
  ];
  const goldPath = writeGold(root, items);
  const loadedGold = readFrozenGoldSnapshot(goldPath, { requireSidecar: true });
  return { root, items, goldPath, loadedGold, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("gold semantic preflight returns stage-specific reopen candidates without model calls", () => {
  const sample = fixture();
  try {
    const broken = JSON.parse(JSON.stringify(sample.loadedGold));
    const item = broken.snapshot.items[0];
    item.familyGold.families[0].status = "pending_review";
    item.familyGold.families[0].independentMemberCount = 0;
    item.familyGold.families[0].coreKnowledgeNodeId = "wrong-node";
    item.familyGold.families[0].members[0].contributionKnowledgeNodeIds = ["wrong-node"];
    const report = buildGoldSemanticPreflight(broken, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "blocked");
    assert.equal(report.modelCallsPerformed, 0);
    assert.deepEqual(report.reopenCandidates[0].stages, ["family"]);
    assert.ok(report.reopenCandidates[0].issueCodes.includes("family_status_not_confirmed"));
    assert.ok(report.reopenCandidates[0].issueCodes.includes("independent_member_count_mismatch"));
    assert.ok(report.reopenCandidates[0].issueCodes.includes("question_family_core_mismatch"));
  } finally {
    sample.cleanup();
  }
});

test("gold semantic preflight accepts explicit canonical knowledge aliases", () => {
  const sample = fixture();
  try {
    const items = JSON.parse(JSON.stringify(sample.items));
    const target = items[0];
    const questionNode = {
      id: "question-node-alias",
      canonicalNodeId: "canonical-q-mature",
      aliasNodeIds: [],
      title: "规范知识",
      path: "教材 > 规范知识",
    };
    const familyNode = {
      id: "family-node-alias",
      canonicalNodeId: "canonical-q-mature",
      aliasNodeIds: [],
      title: "规范知识别名",
      path: "教材 > 规范知识别名",
    };
    target.knowledgeGold.coreKnowledge = questionNode;
    target.knowledgeGold.requiredKnowledge = [questionNode];
    target.familyGold.families[0].coreKnowledge = familyNode;
    target.familyGold.families[0].coreKnowledgeNodeId = familyNode.id;
    target.familyGold.families[0].requiredKnowledge = [familyNode];
    target.familyGold.families[0].requiredKnowledgeNodeIds = [familyNode.id];
    target.familyGold.families[0].members[0].contributionKnowledge = [familyNode];
    target.familyGold.families[0].members[0].contributionKnowledgeNodeIds = [familyNode.id];
    const loadedGold = readFrozenGoldSnapshot(writeGold(sample.root, items, "V2-alias"), { requireSidecar: true });
    const report = buildGoldSemanticPreflight(loadedGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "passed");
    assert.equal(report.blockers.some((entry) => entry.code === "question_family_core_mismatch"), false);
    assert.equal(report.blockers.some((entry) => entry.code === "question_family_required_mismatch"), false);
  } finally {
    sample.cleanup();
  }
});

test("legacy V2 keeps core-equality semantics while V3 uses member contribution knowledge", () => {
  const sample = fixture();
  try {
    const baseItems = JSON.parse(JSON.stringify(sample.items));
    const target = baseItems[0];
    const questionNode = target.knowledgeGold.coreKnowledge;
    const broaderFamilyNode = {
      id: "node-family-range",
      title: "后台目录锚点",
      path: "教材 > 后台目录锚点",
    };
    target.familyGold.families[0].coreKnowledge = broaderFamilyNode;
    target.familyGold.families[0].coreKnowledgeNodeId = broaderFamilyNode.id;
    target.familyGold.families[0].requiredKnowledge = [broaderFamilyNode, questionNode];
    target.familyGold.families[0].requiredKnowledgeNodeIds = [broaderFamilyNode.id, questionNode.id];
    target.familyGold.families[0].textbookAnchorNodeIds = [broaderFamilyNode.id];
    target.familyGold.families[0].members[0].contributionKnowledge = [questionNode];
    target.familyGold.families[0].members[0].contributionKnowledgeNodeIds = [questionNode.id];

    const legacyItems = JSON.parse(JSON.stringify(baseItems));
    legacyItems[0].familyGold.familyKnowledgeProtocolVersion = LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION;
    const legacyGold = readFrozenGoldSnapshot(
      writeGold(sample.root, legacyItems, "V2-legacy-core"),
      { requireSidecar: true },
    );
    const legacyReport = buildGoldSemanticPreflight(legacyGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(legacyReport.status, "blocked");
    assert.ok(legacyReport.blockers.some((entry) => entry.code === "question_family_core_mismatch"));

    const currentItems = JSON.parse(JSON.stringify(baseItems));
    currentItems[0].familyGold.familyKnowledgeProtocolVersion = FAMILY_KNOWLEDGE_PROTOCOL_VERSION;
    const currentGold = readFrozenGoldSnapshot(
      writeGold(sample.root, currentItems, "V3-member-contribution"),
      { requireSidecar: true },
    );
    const currentReport = buildGoldSemanticPreflight(currentGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(currentReport.status, "passed");
    assert.equal(currentReport.blockers.some((entry) => entry.code === "question_family_core_mismatch"), false);
    assert.equal(currentReport.blockers.some((entry) => entry.code === "question_family_required_mismatch"), false);
  } finally {
    sample.cleanup();
  }
});

test("scope-anchor gold excludes the focus from joint coverage and does not require theme contribution", () => {
  const sample = fixture();
  try {
    const items = JSON.parse(JSON.stringify(sample.items));
    const target = items[0];
    const scopeAnchor = {
      id: "node-vocabulary-scope",
      title: "词汇单位",
      path: "词汇 > 词汇概说 > 词汇单位",
    };
    const answerNode = {
      id: "node-morpheme-identification",
      title: "语素识别",
      path: "词汇 > 语素 > 语素识别",
    };
    target.knowledgeGold.coreKnowledge = scopeAnchor;
    target.knowledgeGold.coreKnowledgeRole = "scope_anchor";
    target.knowledgeGold.requiredKnowledge = [answerNode];
    const primaryFamily = target.familyGold.families[0];
    primaryFamily.requiredKnowledge = [answerNode];
    primaryFamily.requiredKnowledgeNodeIds = [answerNode.id];
    primaryFamily.members[0].contributionKnowledge = [answerNode];
    primaryFamily.members[0].contributionKnowledgeNodeIds = [answerNode.id];

    const normalized = knowledgeGoldFor(target);
    assert.equal(normalized.coreRole, "scope_anchor");
    assert.deepEqual(normalized.requiredIds, [answerNode.id]);

    const loadedGold = readFrozenGoldSnapshot(
      writeGold(sample.root, items, "V3-scope-anchor"),
      { requireSidecar: true },
    );
    const report = buildGoldSemanticPreflight(loadedGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "passed");
    assert.equal(report.blockers.some((entry) => entry.code === "question_family_core_mismatch"), false);
    assert.equal(report.blockers.some((entry) => entry.code === "question_family_required_coverage_incomplete"), false);

    const invalidItems = JSON.parse(JSON.stringify(items));
    invalidItems[0].knowledgeGold.requiredKnowledge.push(scopeAnchor);
    const invalidGold = readFrozenGoldSnapshot(
      writeGold(sample.root, invalidItems, "V3-invalid-scope-anchor"),
      { requireSidecar: true },
    );
    const invalidReport = buildGoldSemanticPreflight(invalidGold, { expectedCount: 3, now: new Date(0) });
    assert.ok(invalidReport.blockers.some((entry) => entry.code === "scope_anchor_in_required_knowledge"));
  } finally {
    sample.cleanup();
  }
});

test("V3 blocks a family without an independent focus key", () => {
  const sample = fixture();
  try {
    const items = JSON.parse(JSON.stringify(sample.items));
    delete items[0].familyGold.families[0].focusKey;
    const loadedGold = readFrozenGoldSnapshot(writeGold(sample.root, items, "V3-focus-required"), {
      requireSidecar: true,
    });
    const report = buildGoldSemanticPreflight(loadedGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.some((entry) => (
      entry.code === "family_definition_field_missing" && entry.field === "focusKey"
    )));
  } finally {
    sample.cleanup();
  }
});

test("gold semantic preflight accepts joint coverage from primary and answer-essential related families", () => {
  const sample = fixture();
  try {
    const items = JSON.parse(JSON.stringify(sample.items));
    const target = items[0];
    const extraNode = { id: "node-cross-extra", title: "跨知识补充", path: "教材 > 跨知识补充" };
    target.knowledgeGold.requiredKnowledge.push(extraNode);
    const relatedFamily = {
      id: "family-cross-required",
      name: "跨知识必需题族",
      focusKey: "cross-knowledge-required",
      bookId: "book-1",
      status: "confirmed",
      coreKnowledge: extraNode,
      coreKnowledgeNodeId: extraNode.id,
      requiredKnowledge: [extraNode],
      requiredKnowledgeNodeIds: [extraNode.id],
      textbookAnchorNodeIds: [extraNode.id],
      assessmentAction: "联合判断",
      inclusionBoundary: "纳入必须调用补充知识的题",
      exclusionBoundary: "排除只靠主题知识可答的题",
      members: [{
        questionId: target.questionId,
        isPrimary: false,
        role: "similar",
        contributionKnowledge: [extraNode],
        contributionKnowledgeNodeIds: [extraNode.id],
      }],
    };
    target.familyGold.families.push(relatedFamily);
    target.familyGold.relatedFamilyIds = [relatedFamily.id];
    target.familyGold.relatedFamilyRelations = [{ familyId: relatedFamily.id, coverageRole: "required" }];
    const loadedGold = readFrozenGoldSnapshot(writeGold(sample.root, items, "V2-joint"), { requireSidecar: true });
    const report = buildGoldSemanticPreflight(loadedGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "passed");
    assert.equal(report.blockers.some((entry) => entry.code === "question_family_required_coverage_incomplete"), false);
  } finally {
    sample.cleanup();
  }
});

test("reference related families do not satisfy answer-essential knowledge coverage", () => {
  const sample = fixture();
  try {
    const items = JSON.parse(JSON.stringify(sample.items));
    const target = items[0];
    const extraNode = { id: "node-reference-only", title: "普通关联知识", path: "教材 > 普通关联知识" };
    target.knowledgeGold.requiredKnowledge.push(extraNode);
    const referenceFamily = {
      id: "family-reference-only",
      name: "普通关联题族",
      focusKey: "reference-only",
      bookId: "book-1",
      status: "confirmed",
      coreKnowledge: extraNode,
      coreKnowledgeNodeId: extraNode.id,
      requiredKnowledge: [extraNode],
      requiredKnowledgeNodeIds: [extraNode.id],
      textbookAnchorNodeIds: [extraNode.id],
      assessmentAction: "相似参考",
      members: [{
        questionId: target.questionId,
        isPrimary: false,
        role: "similar",
        contributionKnowledgeNodeIds: [],
      }],
    };
    target.familyGold.families.push(referenceFamily);
    target.familyGold.relatedFamilyIds = [referenceFamily.id];
    target.familyGold.relatedFamilyRelations = [{ familyId: referenceFamily.id, coverageRole: "reference" }];
    const loadedGold = readFrozenGoldSnapshot(writeGold(sample.root, items, "V2-reference"), { requireSidecar: true });
    const report = buildGoldSemanticPreflight(loadedGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.some((entry) => entry.code === "question_family_required_coverage_incomplete"));
  } finally {
    sample.cleanup();
  }
});

test("unmatched gold can keep existing related families without hiding them from replay", () => {
  const sample = fixture();
  try {
    const items = JSON.parse(JSON.stringify(sample.items));
    const target = items[2];
    const extraNode = { id: "node-unmatched-related", title: "已有补充能力", path: "教材 > 已有补充能力" };
    target.knowledgeGold.requiredKnowledge.push(extraNode);
    const relatedFamily = {
      id: "family-unmatched-related",
      name: "已有作答必需题族",
      focusKey: "unmatched-required-related",
      bookId: "book-1",
      status: "confirmed",
      coreKnowledge: extraNode,
      coreKnowledgeNodeId: extraNode.id,
      requiredKnowledge: [extraNode],
      requiredKnowledgeNodeIds: [extraNode.id],
      textbookAnchorNodeIds: [extraNode.id],
      assessmentAction: "补充判断",
      inclusionBoundary: "纳入联合调用",
      exclusionBoundary: "排除普通相似",
      members: [{
        questionId: target.questionId,
        isPrimary: false,
        role: "similar",
        contributionKnowledge: [extraNode],
        contributionKnowledgeNodeIds: [extraNode.id],
      }],
    };
    target.familyGold.families = [relatedFamily];
    target.familyGold.relatedFamilyIds = [relatedFamily.id];
    target.familyGold.relatedFamilyRelations = [{ familyId: relatedFamily.id, coverageRole: "required" }];
    const loadedGold = readFrozenGoldSnapshot(writeGold(sample.root, items, "V2-unmatched-related"), { requireSidecar: true });
    const state = runtimeState(items);
    const report = buildGoldSemanticPreflight(loadedGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "passed");
    const prepared = createReplayContextDocument({ loadedGold, runtimeState: state, expectedCount: 3, now: new Date(0) });
    const context = prepared.document.data.itemContexts[target.questionId];
    assert.ok(context.input.questionFamilies.families.some((family) => family.id === relatedFamily.id));
  } finally {
    sample.cleanup();
  }
});

test("disputed gold keeps complete masking facts but downgrades semantic disagreement to diagnostics", () => {
  const sample = fixture();
  try {
    const items = JSON.parse(JSON.stringify(sample.items));
    const target = items[0];
    target.goldStatus = "gold_needs_review";
    target.includedInAccuracy = false;
    target.familyGold.families[0].coreKnowledgeNodeId = "node-disputed-family";
    target.familyGold.families[0].requiredKnowledgeNodeIds = ["node-disputed-family"];
    target.familyGold.families[0].members[0].contributionKnowledgeNodeIds = ["node-disputed-family"];
    const loadedGold = readFrozenGoldSnapshot(writeGold(sample.root, items, "V2-disputed"), { requireSidecar: true });
    const report = buildGoldSemanticPreflight(loadedGold, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "passed");
    assert.ok(report.warnings.some((entry) => entry.code === "question_family_core_mismatch"));
    assert.deepEqual(report.summary.modeDistributions, {
      total: { mature: 1, singleton: 1, unmatched: 1 },
      scoreable: { mature: 0, singleton: 1, unmatched: 1 },
      disputed: { mature: 1, singleton: 0, unmatched: 0 },
    });
    const prepared = createReplayContextDocument({
      loadedGold,
      runtimeState: runtimeState(items),
      expectedCount: 3,
      now: new Date(0),
    });
    assert.equal(prepared.goldPreflight.status, "passed");
  } finally {
    sample.cleanup();
  }
});

test("disputed gold still blocks C1 when the family needed for safe masking is incomplete", () => {
  const sample = fixture();
  try {
    const broken = JSON.parse(JSON.stringify(sample.loadedGold));
    const target = broken.snapshot.items[2];
    target.goldStatus = "gold_needs_review";
    target.includedInAccuracy = false;
    target.familyGold.candidateFamily = { name: "待讨论题族" };
    const report = buildGoldSemanticPreflight(broken, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.some((entry) => entry.code === "family_definition_field_missing"));
  } finally {
    sample.cleanup();
  }
});

test("V1 metadata omissions are separated from semantic human-review candidates", () => {
  const sample = fixture();
  try {
    const legacyItems = JSON.parse(JSON.stringify(sample.items));
    legacyItems.forEach((item) => {
      delete item.familyGold.familyKnowledgeProtocolVersion;
    });
    const legacy = readFrozenGoldSnapshot(writeGold(sample.root, legacyItems, "V1"), { requireSidecar: true });
    const legacyFamily = legacy.snapshot.items[0].familyGold.families[0];
    delete legacyFamily.status;
    delete legacyFamily.bookId;
    delete legacyFamily.members;
    const report = buildGoldSemanticPreflight(legacy, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "blocked");
    assert.equal(report.summary.preparationFixCount, 3);
    assert.equal(report.reopenCandidates.some((entry) => entry.questionId === "q-mature"), false);
    assert.deepEqual(report.preparationFixes.map((entry) => entry.code).sort(), [
      "family_book_missing",
      "family_status_missing",
      "member_roles_missing",
    ]);
  } finally {
    sample.cleanup();
  }
});

test("C1 freezes per-question masked inputs, source answers, hashes and no scoring gold or secrets", () => {
  const sample = fixture();
  try {
    const prepared = createReplayContextDocument({
      loadedGold: sample.loadedGold,
      runtimeState: runtimeState(sample.items),
      expectedCount: 3,
      now: new Date(0),
    });
    const contextPath = path.join(sample.root, "context-C1.json");
    writeReplayContext(prepared, contextPath);
    const loadedContext = readReplayContext(contextPath, sample.loadedGold);
    const report = buildReplayContextPreflight(sample.loadedGold, loadedContext, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "passed");
    assert.equal(report.modelCallsPerformed, 0);
    const mature = loadedContext.data.itemContexts["q-mature"];
    const singleton = loadedContext.data.itemContexts["q-singleton"];
    assert.equal(mature.input.questionFamilies.families[0].members.length, 1);
    assert.equal(mature.input.questionFamilies.families[0].members[0].questionId, "q-mature-retained");
    assert.equal(singleton.input.questionFamilies.families.some((entry) => entry.id === "family-q-singleton"), false);
    assert.deepEqual(mature.input.questions.find((entry) => entry.id === "q-mature").correctAnswer, ["A"]);
    assert.equal(findGoldLeakPaths(mature.input).length, 0);
    assert.equal(findSecretConfigPaths(loadedContext.data.executionConfig).length, 0);
    assert.equal(loadedContext.data.executionConfig.providers[0].apiKey, undefined);
    assert.equal(loadedContext.data.executionConfig.providers[0].baseUrl, "https://example.test/v1");
    assert.match(loadedContext.data.executionConfig.providers[0].credentialRef, /^BLIND_REPLAY_PROVIDER_/);
  } finally {
    sample.cleanup();
  }
});

test("C1 excludes unverified answers and records the actual freeze decision", () => {
  const sample = fixture();
  try {
    const state = runtimeState(sample.items);
    const sourceQuestion = state.data.questions.find((question) => question.id === "q-mature");
    sourceQuestion.correctAnswer = ["D"];
    sourceQuestion.referenceAnswer = "这段未核验答案不得进入模型输入";
    sourceQuestion.answerSource = "ai_supplement";
    sourceQuestion.answerReviewStatus = "doubtful";
    sourceQuestion.answerVerified = false;
    const prepared = createReplayContextDocument({
      loadedGold: sample.loadedGold,
      runtimeState: state,
      expectedCount: 3,
      now: new Date(0),
    });
    const context = prepared.document.data.itemContexts["q-mature"];
    const frozenQuestion = context.input.questions.find((question) => question.id === "q-mature");
    assert.deepEqual(frozenQuestion.correctAnswer, []);
    assert.equal(frozenQuestion.referenceAnswer, "");
    assert.equal(frozenQuestion.answerVerified, false);
    assert.equal(frozenQuestion.answerProvenance.status, "not_frozen_unverified");
    assert.equal(frozenQuestion.answerProvenance.source, "formal_runtime_answer_excluded");
    assert.equal(context.sourceAudit.verifiedAnswerFrozen, false);
    assert.equal(context.sourceAudit.answerFreezeStatus, "not_frozen_unverified");
    assert.doesNotMatch(JSON.stringify(context.input), /这段未核验答案不得进入模型输入/);
  } finally {
    sample.cleanup();
  }
});

test("answer review status alone can authorize a verified C1 answer freeze", () => {
  const sanitized = sanitizeContextQuestion({
    id: "q-status-verified",
    correctAnswer: ["B"],
    referenceAnswer: "官方核验答案",
    answerSource: "pdf_answer",
    answerReviewStatus: "official_verified",
    answerVerified: false,
  });
  assert.deepEqual(sanitized.correctAnswer, ["B"]);
  assert.equal(sanitized.referenceAnswer, "官方核验答案");
  assert.equal(sanitized.answerVerified, true);
  assert.equal(sanitized.answerProvenance.status, "frozen_verified");
  assert.equal(sanitized.answerProvenance.source, "formal_runtime_at_c1_freeze");
});

test("C1 reader rejects tampering and a snapshot/context binding mismatch", () => {
  const sample = fixture();
  try {
    const prepared = createReplayContextDocument({
      loadedGold: sample.loadedGold,
      runtimeState: runtimeState(sample.items),
      expectedCount: 3,
      now: new Date(0),
    });
    const contextPath = path.join(sample.root, "context-C1.json");
    writeReplayContext(prepared, contextPath);
    const otherGoldPath = writeGold(sample.root, sample.items, "V3");
    const otherGold = readFrozenGoldSnapshot(otherGoldPath, { requireSidecar: true });
    assert.throws(() => readReplayContext(contextPath, otherGold), /blind_replay_context_gold_binding_mismatch/);
    fs.appendFileSync(contextPath, " ", "utf8");
    assert.throws(() => readReplayContext(contextPath, sample.loadedGold), /blind_replay_context_file_hash_mismatch/);
  } finally {
    sample.cleanup();
  }
});

test("C1 context preflight blocks a missing mature retained member before any model call", () => {
  const sample = fixture();
  try {
    const prepared = createReplayContextDocument({
      loadedGold: sample.loadedGold,
      runtimeState: runtimeState(sample.items),
      expectedCount: 3,
      now: new Date(0),
    });
    const document = JSON.parse(JSON.stringify(prepared.document));
    document.data.itemContexts["q-mature"].input.questions = document.data.itemContexts["q-mature"].input.questions
      .filter((question) => question.id !== "q-mature-retained");
    const report = buildReplayContextPreflight(sample.loadedGold, {
      document,
      data: document.data,
      filePath: "context.json",
      fileSha256: prepared.fileSha256,
      contentSha256: prepared.contentSha256,
      contextDataSha256: prepared.contextDataSha256,
      bindingFileSha256: prepared.bindingFileSha256,
    }, { expectedCount: 3, now: new Date(0) });
    assert.equal(report.status, "blocked");
    assert.equal(report.modelCallsPerformed, 0);
    assert.ok(report.blockers.some((entry) => entry.code === "context_retained_question_missing"));
  } finally {
    sample.cleanup();
  }
});

test("AI config sanitizer retains route semantics while removing credentials", () => {
  const sanitized = sanitizeAiConfig({
    providers: [{ id: "p-1", apiKey: "secret", password: "secret", baseUrl: "https://u:p@example.test/v1?key=x" }],
    routes: { scene: { mode: "provider", providerId: "p-1", model: "m-1", temperature: 0 } },
    prompts: { scene: { systemPrompt: "fixed" } },
  });
  assert.equal(findSecretConfigPaths(sanitized).length, 0);
  assert.equal(sanitized.providers[0].baseUrl, "https://example.test/v1");
  assert.equal(sanitized.routes.scene.model, "m-1");
  assert.equal(sanitized.prompts.scene.systemPrompt, "fixed");
});

test("C1 permanently hides singleton references and unmatched semantic equivalents", () => {
  const sample = fixture();
  try {
    const state = runtimeState(sample.items);
    const singletonId = "family-q-singleton";
    state.data.questionFamilies.familyAliases = { "family-q-singleton-alias": singletonId };
    state.data.questionFamilies.familySetLinks = [{ memberType: "family", memberId: singletonId, familySetId: "set-1" }];
    state.data.questionFamilies.historyByBook = {
      "book-1": [{ families: [JSON.parse(JSON.stringify(state.data.questionFamilies.families.find((entry) => entry.id === singletonId)))] }],
    };
    const candidate = sample.items.find((entry) => entry.replayMode === "unmatched").familyGold.candidateFamily;
    const equivalentFamily = {
      ...JSON.parse(JSON.stringify(candidate)),
      id: "family-equivalent-unmatched",
      status: "confirmed",
      members: [{ questionId: "q-equivalent", isPrimary: true, role: "prototype" }],
    };
    state.data.questionFamilies.families.push(equivalentFamily);
    state.data.questions.push({
      id: "q-equivalent",
      bookId: "book-1",
      version: 1,
      library: "official",
      status: "official",
      type: "single",
      stem: "等价题",
      options: [],
      correctAnswer: ["A"],
      answerReviewStatus: "verified",
    });
    const prepared = createReplayContextDocument({ loadedGold: sample.loadedGold, runtimeState: state, expectedCount: 3, now: new Date(0) });
    const singleton = prepared.document.data.itemContexts["q-singleton"];
    const unmatched = prepared.document.data.itemContexts["q-unmatched"];
    assert.equal(singleton.input.questionFamilies.families.some((entry) => entry.id === singletonId), false);
    assert.equal(Object.hasOwn(singleton.input.questionFamilies.familyAliases, "family-q-singleton-alias"), false);
    assert.equal(singleton.input.questionFamilies.familySetLinks.some((entry) => entry.memberId === singletonId), false);
    assert.equal(singleton.maskAudit.remainingHistoricalDefinitions, 0);
    assert.deepEqual(unmatched.modePlan.equivalentFamilyIds, ["family-equivalent-unmatched"]);
    assert.equal(unmatched.input.questionFamilies.families.some((entry) => entry.id === "family-equivalent-unmatched"), false);
  } finally {
    sample.cleanup();
  }
});

test("C1 hides an unmatched formal family that is equivalent through explicit knowledge aliases", () => {
  const sample = fixture();
  try {
    const items = JSON.parse(JSON.stringify(sample.items));
    const target = items.find((entry) => entry.replayMode === "unmatched");
    const goldNode = {
      id: "gold-unmatched-alias",
      canonicalNodeId: "canonical-unmatched",
      aliasNodeIds: [],
      title: "无匹配知识",
      path: "教材 > 无匹配知识",
    };
    target.knowledgeGold.coreKnowledge = goldNode;
    target.knowledgeGold.requiredKnowledge = [goldNode];
    target.familyGold.candidateFamily.coreKnowledge = goldNode;
    target.familyGold.candidateFamily.coreKnowledgeNodeId = goldNode.id;
    target.familyGold.candidateFamily.requiredKnowledge = [goldNode];
    target.familyGold.candidateFamily.requiredKnowledgeNodeIds = [goldNode.id];
    target.familyGold.candidateFamily.membership.contributionKnowledge = [goldNode];
    target.familyGold.candidateFamily.membership.contributionKnowledgeNodeIds = [goldNode.id];
    const loadedGold = readFrozenGoldSnapshot(writeGold(sample.root, items, "V2-unmatched-alias"), { requireSidecar: true });
    const state = runtimeState(items);
    const runtimeNode = {
      id: "runtime-unmatched-alias",
      canonicalNodeId: "canonical-unmatched",
      aliasNodeIds: [],
      title: "无匹配知识别名",
      path: "教材 > 无匹配知识别名",
    };
    state.data.questionFamilies.families.push({
      ...target.familyGold.candidateFamily,
      id: "family-equivalent-through-alias",
      status: "confirmed",
      coreKnowledge: runtimeNode,
      coreKnowledgeNodeId: runtimeNode.id,
      requiredKnowledge: [runtimeNode],
      requiredKnowledgeNodeIds: [runtimeNode.id],
      members: [{ questionId: "q-equivalent-alias", isPrimary: true, role: "prototype" }],
    });
    state.data.questions.push({
      id: "q-equivalent-alias",
      bookId: "book-1",
      version: 1,
      library: "official",
      status: "official",
      type: "single",
      stem: "等价别名题",
      options: [],
      correctAnswer: ["A"],
      answerReviewStatus: "verified",
    });
    const prepared = createReplayContextDocument({ loadedGold, runtimeState: state, expectedCount: 3, now: new Date(0) });
    const context = prepared.document.data.itemContexts["q-unmatched"];
    assert.deepEqual(context.modePlan.equivalentFamilyIds, ["family-equivalent-through-alias"]);
    assert.equal(context.input.questionFamilies.families.some((family) => family.id === "family-equivalent-through-alias"), false);
  } finally {
    sample.cleanup();
  }
});

test("C1 keeps only the independent primary members of a mature family", () => {
  // 覆盖真实第 5、7 题的形状：主题族同时存在 isPrimary=true 的独立主归属成员与
  // isPrimary=false 的普通副归属成员。普通成员即使存在于正式题族，也不得进入回放上下文，
  // 否则会被当成留一案例参与核对（这正是第 5、7 题被误拦的原因）。
  // 第 7 题还含一个 role=prototype 但 isPrimary=false 的成员——判据必须是 isPrimary，不能按角色名。
  const shapes = [
    {
      label: "第 5 题形状：3 个独立成员 + 3 个普通副归属成员",
      independent: ["q-mature", "q-mature-peer-a", "q-mature-peer-b"],
      ordinary: [
        { id: "q-mature-ordinary-a", role: "similar" },
        { id: "q-mature-ordinary-b", role: "similar" },
        { id: "q-mature-ordinary-c", role: "similar" },
      ],
    },
    {
      label: "第 7 题形状：2 个独立成员 + 1 个 role=prototype 的普通副归属成员",
      independent: ["q-mature", "q-mature-peer-a"],
      ordinary: [
        { id: "q-mature-ordinary-prototype", role: "prototype" },
        { id: "q-mature-ordinary-similar", role: "similar" },
      ],
    },
  ];
  for (const shape of shapes) {
    const sample = fixture();
    try {
      const items = JSON.parse(JSON.stringify(sample.items));
      const target = items[0];
      const family = target.familyGold.families[0];
      family.members = [
        ...shape.independent.map((questionId, index) => ({
          questionId,
          isPrimary: true,
          role: index === 0 ? "prototype" : "similar",
          contributionKnowledgeNodeIds: questionId === target.questionId ? [family.coreKnowledgeNodeId] : [],
        })),
        ...shape.ordinary.map((entry) => ({
          questionId: entry.id,
          isPrimary: false,
          role: entry.role,
          contributionKnowledgeNodeIds: [],
        })),
      ];
      family.memberQuestionIds = family.members.map((member) => member.questionId);
      family.independentMemberQuestionIds = [...shape.independent];
      family.independentMemberCount = shape.independent.length;
      const retainedIndependentIds = shape.independent.filter((id) => id !== target.questionId);
      family.retainedIndependentMemberQuestionIds = retainedIndependentIds;

      const loadedGold = readFrozenGoldSnapshot(writeGold(sample.root, items, `V2-trim-${shape.independent.length}`), { requireSidecar: true });
      const report = buildGoldSemanticPreflight(loadedGold, { expectedCount: 3, now: new Date(0) });
      assert.equal(report.status, "passed", `${shape.label} 金标语义预检应通过`);

      const prepared = createReplayContextDocument({
        loadedGold,
        runtimeState: runtimeState(items),
        expectedCount: 3,
        now: new Date(0),
      });
      const context = prepared.document.data.itemContexts[target.questionId];
      const contextFamily = context.input.questionFamilies.families.find((entry) => entry.id === family.id);
      assert.ok(contextFamily, `${shape.label}: C1 必须保留主题族定义`);
      // 只保留隐藏目标题之后的独立主归属成员
      assert.deepEqual(
        contextFamily.members.map((member) => member.questionId).sort(),
        [...retainedIndependentIds].sort(),
        shape.label,
      );
      // 普通副归属成员一个都不能进上下文（含 role=prototype 的那个）
      for (const entry of shape.ordinary) {
        assert.equal(contextFamily.members.some((member) => member.questionId === entry.id), false,
          `${shape.label}: 普通副归属成员 ${entry.id} 不应进入上下文`);
      }
      assert.equal(contextFamily.members.some((member) => member.questionId === target.questionId), false,
        `${shape.label}: 目标题成员关系必须隐藏`);
      assert.equal(context.maskAudit.remainingTargetMemberships, 0, shape.label);
      assert.equal(context.maskAudit.matureLeaveOneSatisfied, true, shape.label);
      assert.equal(context.maskAudit.candidateContextClean, true, shape.label);

      const contextReport = buildReplayContextPreflight(loadedGold, {
        document: prepared.document,
        data: prepared.document.data,
        filePath: "context.json",
        fileSha256: prepared.fileSha256,
        contentSha256: prepared.contentSha256,
        contextDataSha256: prepared.contextDataSha256,
        bindingFileSha256: prepared.bindingFileSha256,
      }, { expectedCount: 3, now: new Date(0) });
      assert.equal(contextReport.status, "passed",
        `${shape.label}: 阻断项 ${JSON.stringify((contextReport.blockers || []).map((entry) => entry.code))}`);
      assert.equal(contextReport.modelCallsPerformed, 0);
    } finally {
      sample.cleanup();
    }
  }
});
