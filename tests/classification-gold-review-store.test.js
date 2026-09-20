const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  OPTION_KNOWLEDGE_PROTOCOL_VERSION,
  contentHash,
  createMemoryClassificationGoldReviewStore,
  normalizeAnswerKnowledge,
  normalizeFamilyGold,
  readFrozenGoldSnapshot,
  sha256,
  validateGoldReviewBatchFamilySemantics,
} = require("../apps/api/src/classification-gold-review-store");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classification-gold-"));
  const snapshotDir = path.join(root, "snapshots");
  const store = createMemoryClassificationGoldReviewStore({}, { snapshotDir });
  return {
    root,
    store,
    cleanup() {
      try {
        fs.readdirSync(snapshotDir).forEach((name) => {
          try { fs.chmodSync(path.join(snapshotDir, name), 0o600); } catch (_error) { /* already gone */ }
        });
      } catch (_error) { /* no snapshots */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function family(id = "family-1") {
  return {
    id,
    name: "声母发音方法·声带振动",
    focusKey: "consonant-voicing-judgment",
    bookId: "modern-chinese-7-1",
    coreKnowledgeNodeId: "node-core",
    requiredKnowledgeNodeIds: ["node-core"],
    textbookAnchorNodeIds: ["node-core"],
    assessmentAction: "判断声带是否振动",
    inclusionBoundary: "直接判断清浊音",
    exclusionBoundary: "不含送气强弱",
    independentMemberCount: 2,
    memberQuestionIds: ["q-1", "q-other"],
    independentMemberQuestionIds: ["q-1", "q-other"],
    retainedIndependentMemberQuestionIds: ["q-other"],
  };
}

function item(questionId, overrides = {}) {
  return {
    questionId,
    mode: "mature",
    question: {
      id: questionId,
      version: 3,
      bookId: "modern-chinese-7-1",
      type: "single_choice",
      stem: "下列说法正确的是（ ）。",
      options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
      correctAnswer: ["A"],
      referenceAnswer: "A正确。",
      answerSource: "team_verified",
      answerReviewStatus: "verified",
      answerVerified: true,
    },
    answerKnowledge: {
      correctAnswer: ["A"],
      referenceAnswer: "A正确。",
      answerSource: "team_verified",
      textbookEvidence: [{ chunkId: "chunk-1", excerpt: "教材原文", printedPageStart: 30 }],
      coreKnowledge: { id: "node-core", title: "清浊音", path: "语音 > 清浊音" },
      requiredKnowledge: [{ id: "node-core", title: "清浊音", path: "语音 > 清浊音" }],
      optionKnowledge: [{ key: "A", text: "甲", knowledgeLabels: ["清浊音"], role: "answer" }],
    },
    familyGold: {
      replayMode: "mature",
      decision: "join_existing",
      primaryFamilyId: "family-1",
      families: [family()],
    },
    ...overrides,
  };
}

function composedItem(questionId = "q-composed") {
  const base = item(questionId);
  const question = {
    ...base.question,
    choiceStructure: "composed_options",
    atomicStatements: [
      { key: "1", text: "陈述一" },
      { key: "2", text: "陈述二" },
    ],
    optionComposition: [
      { optionKey: "A", atomicKeys: ["1"] },
      { optionKey: "B", atomicKeys: ["1", "2"] },
    ],
  };
  const answerKnowledge = {
    ...base.answerKnowledge,
    optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
    choiceStructure: "composed_options",
    textbookEvidence: base.answerKnowledge.textbookEvidence
      .map((evidence) => ({ ...evidence, candidateOnly: true })),
    optionKnowledge: [],
    atomicStatements: [
      { key: "1", text: "陈述一", knowledgeRelation: "question_only", basis: "题目层规则足以判断。" },
      { key: "2", text: "陈述二", knowledgeRelation: "option_specific", basis: "删除该规则后无法判断。", knowledgeNodeIds: ["node-atomic-2"] },
    ],
    optionComposition: question.optionComposition,
  };
  return {
    ...base,
    question,
    reviewMethod: "human_independent_gold_v1",
    humanGold: { answerKnowledge, familyGold: base.familyGold },
    sourceMaterials: { sourceAnswer: question, textbookEvidence: base.answerKnowledge.textbookEvidence },
  };
}

function writeRehashedSnapshot(filePath, snapshot) {
  const { integrity: _integrity, ...payload } = snapshot;
  const document = { ...payload, integrity: { algorithm: "sha256", contentSha256: contentHash(payload) } };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.writeFileSync(filePath, bytes);
  fs.writeFileSync(`${filePath}.sha256`, `${sha256(bytes)}  ${path.basename(filePath)}\n`);
}

function importBatch(store, items = [item("q-1")]) {
  return store.importBatch({
    id: "review-batch-v1",
    title: "20题盲测金标集V1",
    version: "V1",
    source: { batchId: "blind-batch-source", manifestSha256: "abc" },
    items,
  });
}

function prepareAndCommit(store, batchId = "review-batch-v1", reviewer = "教研员乙") {
  const prepared = store.prepareFreeze(batchId, { reviewer });
  const frozen = store.commitFreeze(batchId, { token: prepared.preparation.token, reviewer });
  assert.equal(frozen.snapshot.fileSha256, prepared.preparation.fileSha256);
  assert.equal(frozen.snapshot.contentSha256, prepared.preparation.contentSha256);
  return { prepared, frozen };
}

test("answer knowledge defaults to a core focus and excludes a scope anchor from required knowledge", () => {
  const coreKnowledge = { id: "node-scope", title: "音节", path: "语音 > 音节" };
  const childKnowledge = { id: "node-child", title: "音节结构", path: "语音 > 音节 > 音节结构" };
  const defaultRole = normalizeAnswerKnowledge({ coreKnowledge, requiredKnowledge: [childKnowledge] });
  assert.equal(defaultRole.coreKnowledgeRole, "core");
  assert.deepEqual(defaultRole.requiredKnowledge.map((node) => node.id), ["node-scope", "node-child"]);

  const scopeAnchor = normalizeAnswerKnowledge({
    coreKnowledge,
    coreKnowledgeRole: "scope_anchor",
    requiredKnowledge: [coreKnowledge, childKnowledge],
  });
  assert.equal(scopeAnchor.coreKnowledgeRole, "scope_anchor");
  assert.deepEqual(scopeAnchor.requiredKnowledge.map((node) => node.id), ["node-child"]);
});

test("scope anchors require family knowledge v3 so legacy snapshots cannot silently lose the role", () => {
  const base = item("q-scope-protocol");
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V1",
    items: [{
      ...base,
      order: 1,
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "confirmed" },
      humanGold: {
        answerKnowledge: {
          ...base.answerKnowledge,
          coreKnowledgeRole: "scope_anchor",
          coreKnowledge: { id: "node-scope", title: "音节", path: "语音 > 音节" },
          requiredKnowledge: [{ id: "node-child", title: "音节结构", path: "语音 > 音节 > 音节结构" }],
        },
        familyGold: base.familyGold,
      },
    }],
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "family_knowledge_protocol_missing"));
});

test("inherited V2 items keep legacy family facts while explicitly reopened items enter the V3 gate", () => {
  const current = fixture();
  try {
    const base = item("q-inherited-legacy", {
      sourceMode: "unmatched",
      qualificationAudit: {
        status: "inherited",
        parentSnapshotId: "parent-snapshot-v1",
        requiredStages: [],
      },
      contentReview: { result: "confirmed" },
      familyReview: { result: "confirmed" },
      familyGold: {
        replayMode: "unmatched",
        decision: "create_new",
        primaryFamilyId: "",
        relatedFamilyIds: [],
        families: [],
        // This deliberately uses the old candidate semantics: the candidate
        // core differs from the answer core and no V3 protocol is present.
        candidateFamily: {
          name: "旧协议候选题族",
          bookId: "modern-chinese-7-1",
          coreKnowledge: { id: "node-legacy-candidate", title: "旧候选核心", path: "旧目录 > 旧候选核心" },
          coreKnowledgeNodeId: "node-legacy-candidate",
          requiredKnowledge: [{ id: "node-legacy-candidate", title: "旧候选核心", path: "旧目录 > 旧候选核心" }],
          requiredKnowledgeNodeIds: ["node-legacy-candidate"],
          textbookAnchors: [{ id: "node-legacy-candidate", title: "旧候选核心", path: "旧目录 > 旧候选核心" }],
          textbookAnchorNodeIds: ["node-legacy-candidate"],
          assessmentAction: "旧协议判断",
        },
      },
    });
    current.store.importBatch({
      id: "review-batch-v2-inherited-legacy",
      title: "V2 继承旧协议测试",
      version: "V2",
      source: { parentSnapshotId: "parent-snapshot-v1" },
      items: [base],
    });
    const state = current.store.exportState();
    const storedItem = state.batches[0].items[0];
    storedItem.contentReview = {
      result: "confirmed",
      basedOnKnowledgeDigest: storedItem.knowledgeDigest,
    };
    storedItem.familyReview = {
      result: "confirmed",
      basedOnKnowledgeDigest: storedItem.knowledgeDigest,
    };
    current.store.replaceState(state);

    const inheritedBatch = current.store.get("review-batch-v2-inherited-legacy");
    const inheritedValidation = validateGoldReviewBatchFamilySemantics(inheritedBatch);
    assert.equal(inheritedValidation.valid, true, JSON.stringify(inheritedValidation.issues));
    assert.doesNotThrow(() => current.store.prepareFreeze("review-batch-v2-inherited-legacy", {
      reviewer: "V2审核员",
    }));

    const reopenedState = current.store.exportState();
    const reopenedItem = reopenedState.batches[0].items[0];
    reopenedItem.qualificationAudit = {
      ...reopenedItem.qualificationAudit,
      status: "requires_family_review",
      requiredStages: ["family"],
    };
    reopenedState.batches[0].freezePreparation = null;
    current.store.replaceState(reopenedState);
    const reopenedValidation = validateGoldReviewBatchFamilySemantics(
      current.store.get("review-batch-v2-inherited-legacy"),
    );
    assert.equal(reopenedValidation.valid, false);
    assert.ok(reopenedValidation.issues.some((issue) => issue.code === "family_knowledge_protocol_missing"));
    assert.ok(reopenedValidation.issues.some((issue) => issue.code === "candidate_core_knowledge_mismatch"));
    assert.throws(
      () => current.store.prepareFreeze("review-batch-v2-inherited-legacy", { reviewer: "V2审核员" }),
      (error) => error.message === "classification_gold_review_family_semantic_invalid"
        && error.details.issues.some((issue) => issue.code === "family_knowledge_protocol_missing"),
    );
  } finally {
    current.cleanup();
  }
});

test("frozen snapshots keep scope-anchor roles only under family knowledge v3", () => {
  const legacy = fixture();
  const scoped = fixture();
  try {
    const legacyItem = item("q-legacy-role");
    importBatch(legacy.store, [legacyItem]);
    const legacyContent = legacy.store.reviewContent("review-batch-v1", "q-legacy-role", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: legacyItem.answerKnowledge,
    });
    legacy.store.reviewFamily("review-batch-v1", "q-legacy-role", {
      expectedRevision: legacyContent.item.revision,
      result: "confirmed",
      familyGold: legacyItem.familyGold,
    });
    const legacySnapshot = readFrozenGoldSnapshot(prepareAndCommit(legacy.store).frozen.snapshot.filePath).snapshot;
    assert.equal(Object.hasOwn(legacySnapshot.items[0].answerAndEvidence, "coreKnowledgeRole"), false);
    assert.equal(Object.hasOwn(legacySnapshot.items[0].knowledgeGold, "coreKnowledgeRole"), false);

    const questionId = "q-scope-role";
    const scopeKnowledge = { id: "node-scope", title: "音节", path: "语音 > 音节" };
    const childKnowledge = { id: "node-child", title: "音节结构", path: "语音 > 音节 > 音节结构" };
    const scopeFamily = {
      ...family("family-scope"),
      coreKnowledge: scopeKnowledge,
      coreKnowledgeNodeId: scopeKnowledge.id,
      requiredKnowledge: [childKnowledge],
      requiredKnowledgeNodeIds: [childKnowledge.id],
      textbookAnchors: [scopeKnowledge],
      textbookAnchorNodeIds: [scopeKnowledge.id],
      memberQuestionIds: [questionId, "q-scope-other"],
      independentMemberQuestionIds: [questionId, "q-scope-other"],
      retainedIndependentMemberQuestionIds: ["q-scope-other"],
      membership: {
        questionId,
        isPrimary: true,
        role: "prototype",
        reviewStatus: "confirmed",
        contributionKnowledge: [childKnowledge],
        contributionKnowledgeNodeIds: [childKnowledge.id],
        revision: 1,
      },
    };
    const scopedItem = item(questionId, {
      answerKnowledge: {
        ...item(questionId).answerKnowledge,
        coreKnowledge: scopeKnowledge,
        coreKnowledgeRole: "scope_anchor",
        requiredKnowledge: [childKnowledge],
      },
      familyGold: {
        familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
        replayMode: "mature",
        decision: "join_existing",
        primaryFamilyId: scopeFamily.id,
        relatedFamilyIds: [],
        families: [scopeFamily],
      },
    });
    importBatch(scoped.store, [scopedItem]);
    const scopedContent = scoped.store.reviewContent("review-batch-v1", questionId, {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: scopedItem.answerKnowledge,
    });
    scoped.store.reviewFamily("review-batch-v1", questionId, {
      expectedRevision: scopedContent.item.revision,
      result: "confirmed",
      familyGold: scopedItem.familyGold,
    });
    const scopedSnapshot = readFrozenGoldSnapshot(prepareAndCommit(scoped.store).frozen.snapshot.filePath).snapshot;
    assert.equal(scopedSnapshot.items[0].answerAndEvidence.coreKnowledgeRole, "scope_anchor");
    assert.equal(scopedSnapshot.items[0].knowledgeGold.coreKnowledgeRole, "scope_anchor");
  } finally {
    legacy.cleanup();
    scoped.cleanup();
  }
});

function revisionFamilyFact(questionId, familyId = `family-${questionId}`) {
  const otherQuestionId = `${questionId}-other`;
  return {
    ...family(familyId),
    id: familyId,
    version: 2,
    status: "confirmed",
    memberQuestionIds: [questionId, otherQuestionId],
    independentMemberQuestionIds: [questionId, otherQuestionId],
    independentMemberCount: 2,
    retainedIndependentMemberQuestionIds: [otherQuestionId],
    members: [
      {
        questionId,
        isPrimary: true,
        role: "prototype",
        trainingLevel: "foundation",
        reviewStatus: "confirmed",
        contributionKnowledgeNodeIds: ["node-core"],
      },
      {
        questionId: otherQuestionId,
        isPrimary: true,
        role: "similar",
        trainingLevel: "foundation",
        reviewStatus: "confirmed",
        contributionKnowledgeNodeIds: ["node-core"],
      },
    ],
    membership: {
      questionId,
      isPrimary: true,
      role: "prototype",
      reviewStatus: "confirmed",
      contributionKnowledgeNodeIds: ["node-core"],
      revision: 7,
    },
  };
}

function v2FamilyGold(value = {}) {
  return {
    ...value,
    familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  };
}

function familyGoldForQuestion(questionId, familyId = `family-${questionId}`) {
  const fact = revisionFamilyFact(questionId, familyId);
  return {
    replayMode: "mature",
    decision: "join_existing",
    primaryFamilyId: familyId,
    relatedFamilyIds: [],
    families: [{
      ...fact,
      version: undefined,
      status: undefined,
      members: undefined,
      membership: undefined,
    }],
  };
}

function unmatchedFamilyGold(overrides = {}) {
  return {
    replayMode: "unmatched",
    decision: "create_new",
    primaryFamilyId: "",
    relatedFamilyIds: [],
    families: [],
    candidateFamily: {
      name: "清浊音综合判断",
      focusKey: "consonant-voicing-composite-judgment",
      bookId: "modern-chinese-7-1",
      coreKnowledge: { id: "node-core", title: "清浊音", path: "语音 > 清浊音" },
      coreKnowledgeNodeId: "node-core",
      requiredKnowledge: [{ id: "node-core", title: "清浊音", path: "语音 > 清浊音" }],
      requiredKnowledgeNodeIds: ["node-core"],
      textbookAnchors: [{ id: "node-core", title: "清浊音", path: "语音 > 清浊音" }],
      textbookAnchorNodeIds: ["node-core"],
      assessmentAction: "判断声带是否振动",
      inclusionBoundary: "直接判断清浊音",
      exclusionBoundary: "不含送气强弱",
      membership: {
        questionId: "q-1",
        contributionKnowledgeNodeIds: ["node-core"],
      },
    },
    reason: "当前没有语义兼容的已确认题族。",
    ...overrides,
  };
}

function relatedFamilyFact(questionId, familyId, knowledgeNodeId) {
  const prototypeId = `${familyId}-prototype`;
  return {
    ...revisionFamilyFact(questionId, familyId),
    name: `关联题族 ${familyId}`,
    coreKnowledge: { id: knowledgeNodeId, title: knowledgeNodeId, path: `知识 > ${knowledgeNodeId}` },
    coreKnowledgeNodeId: knowledgeNodeId,
    requiredKnowledge: [{ id: knowledgeNodeId, title: knowledgeNodeId, path: `知识 > ${knowledgeNodeId}` }],
    requiredKnowledgeNodeIds: [knowledgeNodeId],
    textbookAnchors: [{ id: knowledgeNodeId, title: knowledgeNodeId, path: `知识 > ${knowledgeNodeId}` }],
    textbookAnchorNodeIds: [knowledgeNodeId],
    memberQuestionIds: [prototypeId, questionId],
    independentMemberQuestionIds: [prototypeId],
    independentMemberCount: 1,
    retainedIndependentMemberQuestionIds: [prototypeId],
    members: [
      {
        questionId: prototypeId,
        isPrimary: true,
        role: "prototype",
        trainingLevel: "foundation",
        reviewStatus: "confirmed",
        contributionKnowledgeNodeIds: [knowledgeNodeId],
      },
      {
        questionId,
        isPrimary: false,
        role: "similar",
        trainingLevel: "advanced",
        reviewStatus: "confirmed",
        contributionKnowledgeNodeIds: [knowledgeNodeId],
      },
    ],
    membership: {
      questionId,
      isPrimary: false,
      role: "similar",
      reviewStatus: "confirmed",
      contributionKnowledgeNodeIds: [knowledgeNodeId],
      revision: 8,
    },
  };
}

function referenceFamilyFact(questionId, familyId, knowledgeNodeId) {
  const fact = relatedFamilyFact(questionId, familyId, knowledgeNodeId);
  return {
    ...fact,
    members: fact.members.map((member) => (member.questionId === questionId
      ? { ...member, contributionKnowledgeNodeIds: [], contributionKnowledge: [] }
      : member)),
    membership: {
      ...fact.membership,
      contributionKnowledgeNodeIds: [],
      contributionKnowledge: [],
    },
  };
}

function crossKnowledgeAnswer() {
  return {
    ...item("q-1").answerKnowledge,
    requiredKnowledge: [
      { id: "node-core", title: "核心知识", path: "知识 > 核心知识" },
      { id: "node-secondary", title: "辅助知识", path: "知识 > 辅助知识" },
    ],
  };
}

test("family gold normalizes legacy related families as required and derives the compatibility flag", () => {
  const normalized = normalizeFamilyGold({
    replayMode: "mature",
    decision: "join_existing",
    primaryFamilyId: "family-primary",
    relatedFamilyIds: ["family-required", "family-reference"],
    relatedFamilyRelations: [{ familyId: "family-reference", coverageRole: "reference" }],
  });
  assert.deepEqual(normalized.relatedFamilyRelations, [
    { familyId: "family-required", coverageRole: "required", requiredForAnswer: true },
    { familyId: "family-reference", coverageRole: "reference", requiredForAnswer: false },
  ]);
});

test("review mutations return a monotonic batch metadata clock", () => {
  const current = fixture();
  try {
    const base = item("q-1");
    importBatch(current.store, [base]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: base.answerKnowledge,
    });
    assert.equal(content.batchMeta.id, "review-batch-v1");
    assert.equal(content.batchMeta.revision, 2);
    assert.equal(content.batchMeta.updatedAt, content.item.updatedAt);
    const family = current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: base.familyGold,
    });
    assert.equal(family.batchMeta.id, "review-batch-v1");
    assert.equal(family.batchMeta.revision, 3);
    assert.ok(family.batchMeta.updatedAt >= content.batchMeta.updatedAt);
  } finally {
    current.cleanup();
  }
});

test("new family reviews require an explicit role for every related family", () => {
  const current = fixture();
  try {
    const base = item("q-1");
    base.familyGold = {
      ...base.familyGold,
      relatedFamilyIds: ["family-related"],
      families: [...base.familyGold.families, relatedFamilyFact("q-1", "family-related", "node-core")],
    };
    importBatch(current.store, [base]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: base.answerKnowledge,
    });
    assert.throws(() => current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: base.familyGold,
    }), (error) => {
      assert.equal(error.message, "classification_gold_review_family_semantic_invalid");
      assert.equal(error.details.issues[0].code, "related_family_relation_missing");
      return true;
    });
  } finally {
    current.cleanup();
  }
});

test("V2 required related families can jointly cover the minimum sufficient knowledge", () => {
  const primary = revisionFamilyFact("q-1", "family-primary");
  const required = relatedFamilyFact("q-1", "family-required", "node-secondary");
  const reference = referenceFamilyFact("q-1", "family-reference", "node-unrelated");
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "corrected" },
      humanGold: {
        answerKnowledge: crossKnowledgeAnswer(),
        familyGold: v2FamilyGold({
          replayMode: "mature",
          decision: "join_existing",
          primaryFamilyId: primary.id,
          relatedFamilyIds: [required.id, reference.id],
          relatedFamilyRelations: [
            { familyId: required.id, coverageRole: "required" },
            { familyId: reference.id, coverageRole: "reference" },
          ],
          families: [primary, required, reference],
        }),
      },
    }],
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(validation.warningCount, 0);
});

test("V2 semantic gate rejects pending memberships and families without a confirmed prototype", () => {
  const pendingFamily = revisionFamilyFact("q-1", "family-pending-member");
  pendingFamily.members = pendingFamily.members.map((member) => (member.questionId === "q-1"
    ? { ...member, reviewStatus: "pending_fit" }
    : member));
  pendingFamily.members[0].role = "prototype";
  pendingFamily.members[1].role = "similar";
  pendingFamily.membership = {
    ...pendingFamily.membership,
    reviewStatus: "pending_fit",
  };
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "corrected" },
      humanGold: {
        answerKnowledge: item("q-1").answerKnowledge,
        familyGold: v2FamilyGold({
          replayMode: "mature",
          decision: "join_existing",
          primaryFamilyId: pendingFamily.id,
          relatedFamilyIds: [],
          families: [pendingFamily],
        }),
      },
    }],
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "family_membership_not_confirmed"));
  assert.ok(validation.issues.some((issue) => issue.code === "family_confirmed_prototype_missing"));
});

test("ordinary related families do not participate in required knowledge coverage", () => {
  const primary = revisionFamilyFact("q-1", "family-primary");
  const reference = referenceFamilyFact("q-1", "family-reference", "node-secondary");
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "corrected" },
      humanGold: {
        answerKnowledge: crossKnowledgeAnswer(),
        familyGold: v2FamilyGold({
          replayMode: "mature",
          decision: "join_existing",
          primaryFamilyId: primary.id,
          relatedFamilyIds: [reference.id],
          relatedFamilyRelations: [{ familyId: reference.id, coverageRole: "reference" }],
          families: [primary, reference],
        }),
      },
    }],
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "required_knowledge_mismatch"));
});

test("required related families must contribute only knowledge inside the answer set", () => {
  const primary = revisionFamilyFact("q-1", "family-primary");
  const unrelated = relatedFamilyFact("q-1", "family-unrelated", "node-unrelated");
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "corrected" },
      humanGold: {
        answerKnowledge: crossKnowledgeAnswer(),
        familyGold: v2FamilyGold({
          replayMode: "mature",
          decision: "join_existing",
          primaryFamilyId: primary.id,
          relatedFamilyIds: [unrelated.id],
          relatedFamilyRelations: [{ familyId: unrelated.id, coverageRole: "required" }],
          families: [primary, unrelated],
        }),
      },
    }],
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "required_family_no_knowledge_contribution"));
  assert.ok(validation.issues.some((issue) => issue.code === "required_knowledge_mismatch"));
});

test("redundant required related knowledge is a warning rather than a hard failure", () => {
  const primary = revisionFamilyFact("q-1", "family-primary");
  const redundant = relatedFamilyFact("q-1", "family-redundant", "node-core");
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "corrected" },
      humanGold: {
        answerKnowledge: item("q-1").answerKnowledge,
        familyGold: v2FamilyGold({
          replayMode: "mature",
          decision: "join_existing",
          primaryFamilyId: primary.id,
          relatedFamilyIds: [redundant.id],
          relatedFamilyRelations: [{ familyId: redundant.id, coverageRole: "required" }],
          families: [primary, redundant],
        }),
      },
    }],
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(validation.warningCount, 1);
  assert.equal(validation.warnings[0].code, "required_family_redundant_knowledge_contribution");
});

test("unmatched candidates can combine with an existing required related family", () => {
  const required = relatedFamilyFact("q-1", "family-required", "node-secondary");
  const candidate = unmatchedFamilyGold().candidateFamily;
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "corrected" },
      humanGold: {
        answerKnowledge: crossKnowledgeAnswer(),
        familyGold: v2FamilyGold({
          ...unmatchedFamilyGold(),
          relatedFamilyIds: [required.id],
          relatedFamilyRelations: [{ familyId: required.id, coverageRole: "required" }],
          families: [required],
          candidateFamily: candidate,
        }),
      },
    }],
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test("V2 semantic gate does not treat parent and child knowledge paths as equivalent", () => {
  const familyFact = revisionFamilyFact("q-1");
  familyFact.coreKnowledge = { id: "node-child", title: "清浊音子项", path: "语音 > 清浊音 > 子项" };
  familyFact.coreKnowledgeNodeId = "node-child";
  familyFact.requiredKnowledge = [familyFact.coreKnowledge];
  familyFact.requiredKnowledgeNodeIds = ["node-child"];
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "confirmed" },
      humanGold: {
        answerKnowledge: item("q-1").answerKnowledge,
        familyGold: {
          replayMode: "mature",
          decision: "join_existing",
          primaryFamilyId: familyFact.id,
          relatedFamilyIds: [],
          families: [familyFact],
        },
      },
    }],
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "core_knowledge_mismatch"));
  assert.ok(validation.issues.some((issue) => issue.code === "required_knowledge_mismatch"));
});

test("V2 singleton adjudication still enforces singleton family membership semantics", () => {
  const familyFact = revisionFamilyFact("q-1");
  const validation = validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result: "corrected" },
      humanGold: {
        answerKnowledge: item("q-1").answerKnowledge,
        familyGold: {
          replayMode: "singleton",
          decision: "join_existing",
          primaryFamilyId: familyFact.id,
          relatedFamilyIds: [],
          families: [familyFact],
        },
      },
    }],
  });
  assert.equal(validation.valid, false);
  const countIssue = validation.issues.find((issue) => issue.code === "singleton_family_member_count_invalid");
  assert.equal(countIssue.label, "单题题族成员数量不正确");
  assert.equal(countIssue.familyName, familyFact.name);
});

test("V2 unmatched candidate must preserve the question core and minimum sufficient knowledge", () => {
  const source = item("q-1");
  const coreMismatch = unmatchedFamilyGold({
    candidateFamily: {
      ...unmatchedFamilyGold().candidateFamily,
      coreKnowledge: { id: "node-other", title: "送气强弱", path: "语音 > 送气强弱" },
      coreKnowledgeNodeId: "node-other",
    },
  });
  const requiredMismatch = unmatchedFamilyGold({
    candidateFamily: {
      ...unmatchedFamilyGold().candidateFamily,
      requiredKnowledge: [
        { id: "node-core", title: "清浊音", path: "语音 > 清浊音" },
        { id: "node-extra", title: "送气强弱", path: "语音 > 送气强弱" },
      ],
      requiredKnowledgeNodeIds: ["node-core", "node-extra"],
    },
  });
  const validate = (familyGold, result = "corrected") => validateGoldReviewBatchFamilySemantics({
    version: "V2",
    source: { parentSnapshotId: "snapshot-v1" },
    items: [{
      order: 1,
      questionId: "q-1",
      sourceMode: "mature",
      contentReview: { result: "confirmed" },
      familyReview: { result },
      humanGold: { answerKnowledge: source.answerKnowledge, familyGold },
    }],
  });

  const coreValidation = validate(coreMismatch);
  assert.equal(coreValidation.valid, false);
  const coreIssue = coreValidation.issues.find((issue) => issue.code === "candidate_core_knowledge_mismatch");
  assert.equal(coreIssue.label, "候选题族核心知识与题目不一致");
  assert.equal(coreIssue.familyName, coreMismatch.candidateFamily.name);

  const requiredValidation = validate(requiredMismatch);
  assert.equal(requiredValidation.valid, false);
  assert.ok(requiredValidation.issues.some((issue) => issue.code === "candidate_required_knowledge_mismatch"));

  const disputedValidation = validate(coreMismatch, "disputed");
  assert.equal(disputedValidation.valid, true);
  assert.equal(disputedValidation.issueCount, 0);
});

test("option knowledge relation never infers from legacy rows and removes contradictory nodes", () => {
  const normalized = normalizeAnswerKnowledge({
    optionKnowledge: [
      { key: "A", knowledgeNodeIds: ["node-a"], role: "answer" },
      { key: "B", role: "distractor" },
      { key: "C", knowledgeRelation: "question_only", knowledgeNodeIds: ["stale-node"], role: "distractor" },
      { key: "D", knowledgeRelation: "undetermined", knowledgeLabels: ["陈旧标签"], role: "neutral" },
    ],
  });

  assert.equal(normalized.optionKnowledge[0].knowledgeRelation, "unreviewed");
  assert.deepEqual(normalized.optionKnowledge[0].knowledgeNodeIds, []);
  assert.deepEqual(normalized.optionKnowledge[0].legacyKnowledgeNodeIds, ["node-a"]);
  assert.equal(normalized.optionKnowledge[1].knowledgeRelation, "unreviewed");
  assert.equal(normalized.optionKnowledge[2].knowledgeRelation, "question_only");
  assert.deepEqual(normalized.optionKnowledge[2].knowledgeNodeIds, []);
  assert.equal(normalized.optionKnowledge[3].knowledgeRelation, "undetermined");
  assert.deepEqual(normalized.optionKnowledge[3].knowledgeLabels, []);
});

test("independent gold accepts completed option relations without forcing knowledge nodes", () => {
  const current = fixture();
  try {
    const base = item("q-1");
    importBatch(current.store, [item("q-1", {
      reviewMethod: "human_independent_gold_v1",
      humanGold: {
        answerKnowledge: {
          ...base.answerKnowledge,
          textbookEvidence: base.answerKnowledge.textbookEvidence
            .map((evidence) => ({ ...evidence, candidateOnly: true })),
          optionKnowledge: [
            { key: "A", text: "甲", knowledgeRelation: "question_only", role: "answer" },
            { key: "B", text: "乙", knowledgeRelation: "undetermined", uncertaintyNote: "教材证据不足。", role: "distractor" },
          ],
        },
        familyGold: base.familyGold,
      },
      sourceMaterials: {
        sourceAnswer: base.question,
        textbookEvidence: base.answerKnowledge.textbookEvidence,
      },
    })]);

    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: current.store.get("review-batch-v1").items[0].answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "独立审核员",
    });
    assert.equal(content.item.contentReview.result, "confirmed");
    assert.equal(content.item.answerKnowledge.optionKnowledge[0].knowledgeRelation, "question_only");
    assert.equal(content.item.answerKnowledge.optionKnowledge[1].knowledgeRelation, "undetermined");

    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: base.familyGold,
      reviewer: "独立审核员",
    });
    const { frozen } = prepareAndCommit(current.store, "review-batch-v1", "独立审核员");
    const snapshot = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
    const frozenRelations = snapshot.items[0].knowledgeGold.optionKnowledge
      .map((option) => option.knowledgeRelation);
    assert.deepEqual(frozenRelations, ["question_only", "undetermined"]);
    assert.equal(snapshot.items[0].includedInAccuracy, true);
    assert.deepEqual(snapshot.items[0].answerAndEvidence.optionKnowledge[0].knowledgeNodeIds, []);
    assert.deepEqual(snapshot.items[0].answerAndEvidence.optionKnowledge[1].knowledgeLabels, []);
  } finally {
    current.cleanup();
  }
});

test("independent gold requires nodes only for option-specific knowledge", () => {
  const current = fixture();
  try {
    const base = item("q-1");
    importBatch(current.store, [item("q-1", {
      reviewMethod: "human_independent_gold_v1",
      humanGold: {
        answerKnowledge: {
          ...base.answerKnowledge,
          textbookEvidence: base.answerKnowledge.textbookEvidence
            .map((evidence) => ({ ...evidence, candidateOnly: true })),
          optionKnowledge: [
            { key: "A", text: "甲", knowledgeRelation: "option_specific", role: "answer" },
            { key: "B", text: "乙", knowledgeRelation: "question_only", role: "distractor" },
          ],
        },
        familyGold: base.familyGold,
      },
      sourceMaterials: {
        sourceAnswer: base.question,
        textbookEvidence: base.answerKnowledge.textbookEvidence,
      },
    })]);

    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: current.store.get("review-batch-v1").items[0].answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "独立审核员",
    }), /classification_gold_review_human_option_knowledge_required/);
  } finally {
    current.cleanup();
  }
});

test("independent gold requires an explanation for every undetermined option", () => {
  const current = fixture();
  try {
    const base = item("q-1");
    importBatch(current.store, [item("q-1", {
      reviewMethod: "human_independent_gold_v1",
      humanGold: {
        answerKnowledge: {
          ...base.answerKnowledge,
          textbookEvidence: base.answerKnowledge.textbookEvidence
            .map((evidence) => ({ ...evidence, candidateOnly: true })),
          optionKnowledge: [
            { key: "A", text: "甲", knowledgeRelation: "question_only", role: "answer" },
            { key: "B", text: "乙", knowledgeRelation: "undetermined", role: "distractor" },
          ],
        },
        familyGold: base.familyGold,
      },
      sourceMaterials: {
        sourceAnswer: base.question,
        textbookEvidence: base.answerKnowledge.textbookEvidence,
      },
    })]);

    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: current.store.get("review-batch-v1").items[0].answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "独立审核员",
    }), /classification_gold_review_human_option_knowledge_required/);
  } finally {
    current.cleanup();
  }
});

test("gold review enforces answer and knowledge review before family review", () => {
  const current = fixture();
  try {
    const batch = importBatch(current.store);
    assert.equal(batch.summary.pending, 1);
    assert.throws(() => current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
    }), /classification_gold_review_content_first/);

    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
      reviewer: "教研员甲",
    });
    assert.equal(content.item.revision, 2);
    assert.equal(content.item.familyReview.result, "pending_review");
    const reviewed = current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: 2,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
      reviewer: "教研员甲",
    });
    assert.equal(reviewed.summary.readyToFreeze, true);
  } finally {
    current.cleanup();
  }
});

test("independent gold hides AI candidates until the corresponding human stage is submitted", () => {
  const current = fixture();
  try {
    const familyLeakSentinel = "FAMILY_REASON_SENTINEL";
    const manualAnswer = {
      ...item("q-1").answerKnowledge,
      optionKnowledge: [
        { key: "A", text: "甲", knowledgeRelation: "option_specific", knowledgeNodeIds: ["node-human-a"], knowledgeLabels: ["人工知识甲"], role: "answer", provenance: "human_review" },
        { key: "B", text: "乙", knowledgeRelation: "option_specific", knowledgeNodeIds: ["node-human-b"], knowledgeLabels: ["人工知识乙"], role: "distractor", provenance: "human_review" },
      ],
    };
    importBatch(current.store, [item("q-1", {
      reviewMethod: "human_independent_gold_v1",
      humanGold: {
        answerKnowledge: {
          ...item("q-1").answerKnowledge,
          textbookEvidence: item("q-1").answerKnowledge.textbookEvidence
            .map((evidence) => ({ ...evidence, candidateOnly: true })),
          optionKnowledge: [
            { key: "A", text: "甲", role: "unreviewed", provenance: "human_review_required" },
            { key: "B", text: "乙", role: "unreviewed", provenance: "human_review_required" },
          ],
        },
        familyGold: item("q-1").familyGold,
      },
      sourceMaterials: {
        sourceAnswer: item("q-1").question,
        textbookEvidence: item("q-1").answerKnowledge.textbookEvidence,
      },
      aiCandidates: {
        basedOnQuestionVersion: 3,
        content: {
          textbookEvidence: item("q-1").answerKnowledge.textbookEvidence,
          optionKnowledge: [{ key: "A", text: "甲", knowledgeLabels: ["AI知识"], role: "answer", provenance: "ai_agent1" }],
          reason: familyLeakSentinel,
          agent1: { questionMode: "option_judgement", familyDecision: familyLeakSentinel },
          agent3: { decision: familyLeakSentinel },
        },
        family: {
          replayMode: "mature",
          decision: "join_existing",
          primaryFamilyId: "family-1",
          families: [family()],
          reason: familyLeakSentinel,
        },
        audit: { familyDecision: familyLeakSentinel },
      },
    })]);

    const before = current.store.get("review-batch-v1").items[0];
    assert.equal(before.aiComparison.content.available, true);
    assert.equal(before.aiComparison.content.revealed, false);
    assert.equal(before.aiComparison.content.candidate, null);
    assert.equal(before.aiComparison.family.revealed, false);
    assert.equal(Object.hasOwn(before, "aiCandidates"), false);
    assert.equal(before.answerKnowledge.optionKnowledge[0].role, "unreviewed");

    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: manualAnswer,
      reviewer: "独立审核员",
    }), /classification_gold_review_human_evidence_required/);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: manualAnswer,
      selectedEvidenceChunkIds: ["unknown-chunk"],
      reviewer: "独立审核员",
    }), /classification_gold_review_human_evidence_selection_invalid/);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: {
        ...manualAnswer,
        textbookEvidence: [
          ...manualAnswer.textbookEvidence,
          { chunkId: "forged-client-chunk", excerpt: "客户端伪造教材证据" },
        ],
      },
      selectedEvidenceChunkIds: ["forged-client-chunk"],
      reviewer: "独立审核员",
    }), /classification_gold_review_human_evidence_selection_invalid/);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: before.answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "独立审核员",
    }), /classification_gold_review_human_option_knowledge_required/);

    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: {
        ...manualAnswer,
        textbookEvidence: [{
          ...manualAnswer.textbookEvidence[0],
          excerpt: "客户端尝试覆盖教材原文",
          printedPageStart: 999,
        }],
      },
      selectedEvidenceChunkIds: ["chunk-1"],
      answerKnowledgeProvenance: {
        reviewEvidenceNote: "已人工核对教材原文。",
        goldOrigin: "forged_client_value",
        aiCandidateAcceptedImplicitly: true,
      },
      reviewer: "独立审核员",
    });
    assert.equal(content.item.contentReview.result, "confirmed");
    assert.equal(content.item.aiComparison.content.revealed, true);
    assert.equal(content.item.aiComparison.content.candidate.optionKnowledge[0].knowledgeRelation, "unreviewed");
    assert.equal(content.item.aiComparison.content.candidate.optionKnowledge[0].legacyKnowledgeHints[0], "AI知识");
    assert.equal(content.item.aiComparison.family.revealed, false);
    assert.equal(content.item.answerKnowledge.optionKnowledge[0].knowledgeLabels[0], "人工知识甲");
    assert.equal(content.item.answerKnowledgeProvenance.goldOrigin, "human_submission_only");
    assert.equal(content.item.answerKnowledgeProvenance.aiCandidateAcceptedImplicitly, false);
    assert.equal(content.item.answerKnowledgeProvenance.reviewEvidenceNote, "已人工核对教材原文。");
    assert.equal(content.item.answerKnowledge.textbookEvidence[0].excerpt, "教材原文");
    assert.equal(content.item.answerKnowledge.textbookEvidence[0].printedPageStart, 30);
    assert.equal(content.item.reviewHistory[0].firstSubmission, true);
    assert.equal(content.item.reviewHistory[0].aiCandidateVisibleBeforeSubmission, false);
    assert.equal(content.item.reviewHistory[0].submittedAnswerKnowledge.optionKnowledge[0].knowledgeLabels[0], "人工知识甲");
    assert.equal(content.item.reviewHistory[0].submittedAnswerKnowledge.textbookEvidence[0].excerpt, "教材原文");
    assert.equal(JSON.stringify(content.item).includes(familyLeakSentinel), false);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      answerKnowledge: {
        ...manualAnswer,
        optionKnowledge: manualAnswer.optionKnowledge.map((option, index) => (
          index ? option : { ...option, knowledgeLabels: ["再次修改"] }
        )),
      },
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "独立审核员",
    }), /classification_gold_review_confirmed_value_changed/);

    const familyReviewed = current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
      reviewer: "独立审核员",
    });
    assert.equal(familyReviewed.item.aiComparison.family.revealed, true);
    assert.equal(familyReviewed.item.aiComparison.family.candidate.reason, familyLeakSentinel);
    assert.equal(familyReviewed.item.reviewHistory[1].submittedFamilyGold.primaryFamilyId, "family-1");

    const { frozen } = prepareAndCommit(current.store, "review-batch-v1", "独立审核员");
    const snapshot = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
    assert.equal(snapshot.items[0].knowledgeGold.optionKnowledge[0].knowledgeLabels[0], "人工知识甲");
    assert.equal(snapshot.items[0].answerAndEvidence.textbookEvidence[0].candidateOnly, false);
    assert.equal(snapshot.items[0].answerAndEvidence.textbookEvidence[0].humanSelection.status, "selected");
    assert.equal(snapshot.items[0].answerAndEvidence.textbookEvidence.some((evidence) => evidence.candidateOnly), false);
    assert.equal(snapshot.items[0].audit.reviewHistory.length, 2);
    assert.equal(snapshot.items[0].audit.reviewHistory[0].submittedAnswerKnowledge.optionKnowledge[0].knowledgeLabels[0], "人工知识甲");
    assert.equal(snapshot.items[0].audit.reviewHistory[1].submittedFamilyGold.primaryFamilyId, "family-1");
    assert.equal(snapshot.items[0].audit.answerKnowledgeProvenance.goldOrigin, "human_submission_only");
    assert.equal(snapshot.items[0].audit.familyGoldProvenance.goldOrigin, "human_submission_only");
    assert.equal(JSON.stringify(snapshot).includes("AI知识"), false);
    assert.equal(JSON.stringify(snapshot).includes("aiCandidates"), false);
  } finally {
    current.cleanup();
  }
});

test("pending batch replacement preserves import identity and refuses reviewed data", () => {
  const current = fixture();
  try {
    const first = importBatch(current.store);
    const importedAt = first.importedAt;
    const replacement = current.store.replacePendingBatch({
      id: "review-batch-v1",
      title: "20题盲测金标集V1",
      version: "V1",
      source: { batchId: "blind-batch-source", manifestSha256: "abc" },
      items: [item("q-1", { reviewMethod: "human_independent_gold_v1" })],
    });
    assert.equal(replacement.importedAt, importedAt);
    assert.equal(replacement.items[0].reviewMethod, "human_independent_gold_v1");
    current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "disputed",
      note: "用于验证已审核批次不可重导入。",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    assert.throws(() => current.store.replacePendingBatch({
      id: "review-batch-v1",
      source: { batchId: "blind-batch-source", manifestSha256: "abc" },
      items: [item("q-1")],
    }), /classification_gold_review_pending_replace_forbidden/);
  } finally {
    current.cleanup();
  }
});

test("fill-blank gold review does not require subjective scoring points", () => {
  const current = fixture();
  try {
    const base = item("q-fill");
    const question = {
      ...base.question,
      type: "fill_blank",
      stem: "汉语是联合国的六种工作语言之一，另外五种是（ ）、（ ）、（ ）、（ ）和（ ）。",
      options: [],
      correctAnswer: ["英语;法语;俄语;西班牙语;阿拉伯语"],
      referenceAnswer: "英语；法语；俄语；西班牙语；阿拉伯语",
    };
    const answerKnowledge = {
      ...base.answerKnowledge,
      correctAnswer: ["英语", "法语", "俄语", "西班牙语", "阿拉伯语"],
      referenceAnswer: question.referenceAnswer,
      optionKnowledge: [],
      scoringPoints: [],
    };
    importBatch(current.store, [item("q-fill", {
      reviewMethod: "human_independent_gold_v1",
      question,
      answerKnowledge,
      humanGold: { answerKnowledge, familyGold: base.familyGold },
    })]);
    const reviewed = current.store.reviewContent("review-batch-v1", "q-fill", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "填空题审核员",
    });
    assert.equal(reviewed.item.contentReview.result, "confirmed");
    assert.deepEqual(reviewed.item.answerKnowledge.scoringPoints, []);
  } finally {
    current.cleanup();
  }
});

test("subjective gold scoring points are human-only fields and do not advance the formal question version", () => {
  const current = fixture();
  try {
    const question = {
      ...item("q-1").question,
      type: "short_answer",
      options: [],
      correctAnswer: [],
      referenceAnswer: "声带振动为浊音，不振动为清音。",
      scoringPoints: [],
    };
    const draft = {
      ...item("q-1").answerKnowledge,
      correctAnswer: [],
      referenceAnswer: question.referenceAnswer,
      textbookEvidence: item("q-1").answerKnowledge.textbookEvidence
        .map((evidence) => ({ ...evidence, candidateOnly: true })),
      optionKnowledge: [],
      scoringPoints: [],
    };
    importBatch(current.store, [item("q-1", {
      reviewMethod: "human_independent_gold_v1",
      question,
      humanGold: { answerKnowledge: draft, familyGold: item("q-1").familyGold },
    })]);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: draft,
      selectedEvidenceChunkIds: ["chunk-1"],
    }), /classification_gold_review_human_scoring_points_required/);
    const firstGold = {
      ...draft,
      scoringPoints: [{
        id: "point-1",
        description: "指出声带是否振动",
        score: 2,
        knowledgeNodeIds: ["node-core"],
        knowledgeLabels: ["清浊音"],
        provenance: "human_review",
      }],
    };
    const confirmed = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: firstGold,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "主观题审核员",
    });
    assert.equal(confirmed.item.question.version, 3);
    assert.equal(confirmed.item.answerKnowledge.scoringPoints[0].score, 2);

    const changedGold = {
      ...confirmed.item.answerKnowledge,
      scoringPoints: [{ ...confirmed.item.answerKnowledge.scoringPoints[0], score: 3 }],
    };
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: confirmed.item.revision,
      result: "confirmed",
      answerKnowledge: changedGold,
      selectedEvidenceChunkIds: ["chunk-1"],
    }), /classification_gold_review_confirmed_value_changed/);
    const corrected = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: confirmed.item.revision,
      result: "corrected",
      note: "人工复核后调整得分点分值。",
      answerKnowledge: changedGold,
      selectedEvidenceChunkIds: ["chunk-1"],
    });
    assert.equal(corrected.item.question.version, 3);
    assert.equal(corrected.item.answerKnowledge.scoringPoints[0].score, 3);
  } finally {
    current.cleanup();
  }
});

test("disputed content drops every unselected candidate-only evidence before freezing", () => {
  const current = fixture();
  try {
    const candidateEvidence = item("q-1").answerKnowledge.textbookEvidence
      .map((evidence) => ({ ...evidence, candidateOnly: true }));
    importBatch(current.store, [item("q-1", {
      reviewMethod: "human_independent_gold_v1",
      humanGold: {
        answerKnowledge: {
          ...item("q-1").answerKnowledge,
          textbookEvidence: candidateEvidence,
          optionKnowledge: [
            { key: "A", text: "甲", knowledgeRelation: "question_only", role: "answer" },
            { key: "B", text: "乙", knowledgeRelation: "undetermined", uncertaintyNote: "证据不足。", role: "distractor" },
          ],
        },
        familyGold: item("q-1").familyGold,
      },
    })]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "disputed",
      note: "教材证据暂无法确认。",
      answerKnowledge: {
        ...item("q-1").answerKnowledge,
        textbookEvidence: candidateEvidence,
        optionKnowledge: [
          { key: "A", text: "甲", knowledgeRelation: "question_only", role: "answer" },
          { key: "B", text: "乙", knowledgeRelation: "undetermined", uncertaintyNote: "证据不足。", role: "distractor" },
        ],
      },
    });
    assert.deepEqual(content.item.answerKnowledge.textbookEvidence, []);
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "disputed",
      note: "题族裁决随内容证据保持争议。",
      familyGold: item("q-1").familyGold,
    });
    const { frozen } = prepareAndCommit(current.store, "review-batch-v1", "争议审核员");
    const snapshot = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
    assert.deepEqual(snapshot.items[0].answerAndEvidence.textbookEvidence, []);
    assert.equal(snapshot.items[0].goldStatus, "gold_needs_review");
  } finally {
    current.cleanup();
  }
});

test("synchronizing a new formal question version invalidates an already reviewed family decision", () => {
  const current = fixture();
  try {
    importBatch(current.store);
    const first = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    const second = current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: first.item.revision,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
    });
    const changed = current.store.reviewBusinessContent("review-batch-v1", "q-1", {
      expectedRevision: second.item.revision,
      result: "corrected",
      note: "官方答案应为B，已核对教材。",
      question: {
        ...item("q-1").question,
        version: 4,
        correctAnswer: ["B"],
        referenceAnswer: "B正确。",
      },
      answerKnowledge: { ...item("q-1").answerKnowledge, correctAnswer: ["B"] },
    });
    assert.equal(changed.item.answerKnowledge.correctAnswer[0], "B");
    assert.equal(changed.item.familyReview.result, "pending_review");
    assert.equal(changed.summary.readyToFreeze, false);
  } finally {
    current.cleanup();
  }
});

test("review summary uses mutually exclusive disputed, corrected, and confirmed buckets", () => {
  const current = fixture();
  try {
    importBatch(current.store, [item("q-1"), item("q-2"), item("q-3")]);
    const q1Content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "corrected",
      note: "补充人工选项知识。",
      answerKnowledge: {
        ...item("q-1").answerKnowledge,
        optionKnowledge: [{ key: "A", text: "甲", knowledgeLabels: ["人工修正"], role: "answer" }],
      },
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: q1Content.item.revision,
      result: "disputed",
      note: "题族边界仍有争议。",
      familyGold: item("q-1").familyGold,
    });
    const q2Content = current.store.reviewContent("review-batch-v1", "q-2", {
      expectedRevision: 1,
      result: "corrected",
      note: "补充人工选项知识。",
      answerKnowledge: {
        ...item("q-2").answerKnowledge,
        optionKnowledge: [{ key: "A", text: "甲", knowledgeLabels: ["人工修正"], role: "answer" }],
      },
    });
    current.store.reviewFamily("review-batch-v1", "q-2", {
      expectedRevision: q2Content.item.revision,
      result: "confirmed",
      familyGold: item("q-2").familyGold,
    });
    const q3Content = current.store.reviewContent("review-batch-v1", "q-3", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-3").answerKnowledge,
    });
    const q3 = current.store.reviewFamily("review-batch-v1", "q-3", {
      expectedRevision: q3Content.item.revision,
      result: "confirmed",
      familyGold: item("q-3").familyGold,
    });
    assert.deepEqual({
      disputed: q3.summary.disputed,
      corrected: q3.summary.corrected,
      confirmed: q3.summary.confirmed,
    }, { disputed: 1, corrected: 1, confirmed: 1 });
  } finally {
    current.cleanup();
  }
});

test("a later review invalidates an earlier freeze preparation token", () => {
  const current = fixture();
  try {
    importBatch(current.store, [item("q-1", {
      reviewMethod: "legacy_prefilled_gold",
      aiCandidates: { content: { reason: "AI候选" } },
    })]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    const familyReviewed = current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
    });
    const prepared = current.store.prepareFreeze("review-batch-v1");
    const reviewedAgain = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: familyReviewed.item.revision,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    assert.equal(reviewedAgain.item.reviewHistory.at(-1).aiCandidateVisibleBeforeSubmission, true);
    assert.throws(() => current.store.commitFreeze("review-batch-v1", {
      token: prepared.preparation.token,
    }), /classification_gold_review_prepare_required/);
  } finally {
    current.cleanup();
  }
});

test("freeze writes an immutable, hash-verified snapshot and excludes disputes from accuracy", () => {
  const current = fixture();
  try {
    importBatch(current.store, [item("q-1"), item("q-2")]);
    for (const [questionId, result, note] of [
      ["q-1", "confirmed", ""],
      ["q-2", "disputed", "来源答案仍有争议"],
    ]) {
      const content = current.store.reviewContent("review-batch-v1", questionId, {
        expectedRevision: 1,
        result,
        note,
        answerKnowledge: item(questionId).answerKnowledge,
        reviewer: "教研员乙",
      });
      current.store.reviewFamily("review-batch-v1", questionId, {
        expectedRevision: content.item.revision,
        result,
        note,
        familyGold: item(questionId).familyGold,
        reviewer: "教研员乙",
      });
    }
    const { prepared, frozen } = prepareAndCommit(current.store, "review-batch-v1", "教研员乙");
    assert.equal(frozen.snapshot.summary.accuracyEligible, 1);
    assert.equal(frozen.snapshot.summary.goldNeedsReview, 1);
    assert.match(frozen.snapshot.fileSha256, /^[a-f0-9]{64}$/);
    assert.match(frozen.snapshot.contentSha256, /^[a-f0-9]{64}$/);

    const loaded = readFrozenGoldSnapshot(frozen.snapshot.filePath);
    assert.equal(loaded.snapshot.title, "20题盲测金标集V1");
    assert.equal(loaded.snapshot.items[0].questionSnapshot.version, 3);
    assert.equal(loaded.snapshot.items[1].goldStatus, "gold_needs_review");
    assert.equal(loaded.fileSha256, frozen.snapshot.fileSha256);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 3,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    }), /classification_gold_review_frozen/);
    assert.throws(() => current.store.commitFreeze("review-batch-v1", {
      token: prepared.preparation.token,
    }), /classification_gold_review_frozen/);
  } finally {
    current.cleanup();
  }
});

test("a frozen V1 creates an independent V2 draft and reopens requested or protocol-stale family reviews", () => {
  const current = fixture();
  try {
    const sourceItems = ["q-1", "q-2"].map((questionId) => item(questionId, {
      familyGold: familyGoldForQuestion(questionId),
    }));
    importBatch(current.store, sourceItems);
    sourceItems.forEach((sourceItem) => {
      const content = current.store.reviewContent("review-batch-v1", sourceItem.questionId, {
        expectedRevision: 1,
        result: "confirmed",
        answerKnowledge: sourceItem.answerKnowledge,
        reviewer: "V1审核员",
      });
      current.store.reviewFamily("review-batch-v1", sourceItem.questionId, {
        expectedRevision: content.item.revision,
        result: "confirmed",
        familyGold: sourceItem.familyGold,
        reviewer: "V1审核员",
      });
    });
    const { frozen } = prepareAndCommit(current.store, "review-batch-v1", "V1审核员");
    const parentBytes = fs.readFileSync(frozen.snapshot.filePath);
    const parentBefore = current.store.get("review-batch-v1");
    const formalFamilyFactsByQuestionId = {
      "q-1": [{
        ...revisionFamilyFact("q-1"),
        membership: {
          questionId: "q-1",
          isPrimary: true,
          role: "prototype",
          reviewStatus: "confirmed",
          contributionKnowledgeNodeIds: ["node-core"],
          revision: 0,
        },
      }],
      "q-2": [revisionFamilyFact("q-2")],
    };
    const factsHash = contentHash(formalFamilyFactsByQuestionId);

    const created = current.store.createRevisionDraft("review-batch-v1", {
      id: "review-batch-v2",
      title: "20题盲测金标集V2",
      version: "V2",
      riskOrders: [2],
      qualificationIssues: [{ order: 2, code: "manual_family_risk", message: "题族事实需要复核。" }],
      reason: "校准发现 V1 题族事实不完整。",
      reviewer: "V2审核员",
      formalFamilyFactsByQuestionId,
      formalFamilyFactsProvenance: {
        source: "question_family_store_revision_snapshot",
        contentSha256: factsHash,
      },
    });

    assert.equal(created.created, true);
    assert.equal(created.batch.id, "review-batch-v2");
    assert.equal(created.batch.version, "V2");
    assert.equal(created.batch.status, "reviewing");
    assert.equal(created.batch.source.parentSnapshotId, frozen.snapshot.snapshotId);
    assert.equal(created.batch.source.parentFileSha256, frozen.snapshot.fileSha256);
    assert.equal(created.batch.source.parentContentSha256, frozen.snapshot.contentSha256);
    assert.equal(created.batch.source.formalFamilyFactsSha256, factsHash);
    assert.deepEqual(created.revisionReview.requestedRiskQuestionIds, ["q-2"]);
    assert.deepEqual(created.revisionReview.automaticallyReopenedQuestionIds, ["q-1"]);
    assert.deepEqual(created.revisionReview.inheritedQuestionIds, []);
    assert.equal(created.batch.items[0].contentReview.result, "confirmed");
    assert.equal(created.batch.items[0].familyReview.result, "pending_review");
    assert.equal(created.batch.items[0].familyGold.families[0].status, "confirmed");
    assert.equal(created.batch.items[0].familyGold.families[0].membership.isPrimary, true);
    assert.equal(created.batch.items[0].aiComparison.content.available, false);
    assert.equal(created.batch.items[1].contentReview.result, "confirmed");
    assert.equal(created.batch.items[1].familyReview.result, "pending_review");
    assert.equal(created.batch.items[1].qualificationAudit.status, "requires_family_review");
    assert.equal(created.batch.summary.completed, 0);
    assert.equal(created.batch.summary.pending, 2);

    const protocolStale = created.batch.items.find((entry) => entry.questionId === "q-1");
    assert.throws(() => current.store.reviewContent("review-batch-v2", "q-1", {
      expectedRevision: protocolStale.revision,
      result: "confirmed",
      answerKnowledge: protocolStale.answerKnowledge,
    }), /classification_gold_review_revision_stage_locked/);
    assert.throws(() => current.store.reviewBusinessContent("review-batch-v2", "q-1", {
      expectedRevision: protocolStale.revision,
      result: "corrected",
      note: "不应允许改写继承题。",
      question: { ...protocolStale.question, version: protocolStale.question.version + 1 },
      answerKnowledge: protocolStale.answerKnowledge,
    }), /classification_gold_review_revision_stage_locked/);
    assert.throws(() => current.store.reloadItem("review-batch-v2", "q-1", {
      expectedRevision: protocolStale.revision,
      question: protocolStale.question,
      answerKnowledge: protocolStale.answerKnowledge,
      familyGold: protocolStale.familyGold,
    }), /classification_gold_review_revision_stage_locked/);

    const reviewedQ1 = current.store.reviewFamily("review-batch-v2", "q-1", {
      expectedRevision: protocolStale.revision,
      result: "confirmed",
      familyGold: v2FamilyGold(protocolStale.familyGold),
      reviewer: "V2审核员",
    });
    assert.equal(reviewedQ1.item.familyGold.familyKnowledgeProtocolVersion, FAMILY_KNOWLEDGE_PROTOCOL_VERSION);

    const parentAfter = current.store.get("review-batch-v1");
    assert.equal(parentAfter.status, "frozen");
    assert.equal(parentAfter.revision, parentBefore.revision);
    assert.equal(parentAfter.snapshot.fileSha256, parentBefore.snapshot.fileSha256);
    assert.deepEqual(fs.readFileSync(frozen.snapshot.filePath), parentBytes);
    assert.throws(() => current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: parentAfter.items[0].revision,
      result: "confirmed",
      familyGold: parentAfter.items[0].familyGold,
    }), /classification_gold_review_frozen/);

    const q2 = created.batch.items.find((entry) => entry.questionId === "q-2");
    const reviewed = current.store.reviewFamily("review-batch-v2", "q-2", {
      expectedRevision: q2.revision,
      result: "confirmed",
      familyGold: v2FamilyGold(q2.familyGold),
      reviewer: "V2审核员",
    });
    assert.equal(reviewed.item.qualificationAudit.status, "resolved");
    const preparedV2 = current.store.prepareFreeze("review-batch-v2", { reviewer: "V2审核员" });
    assert.equal(preparedV2.preparation.version, "V2");
  } finally {
    current.cleanup();
  }
});

test("a targeted V2 family review can adjudicate the final replay mode without changing the V1 source mode", () => {
  const current = fixture();
  try {
    const sourceItem = item("q-1", { familyGold: familyGoldForQuestion("q-1") });
    importBatch(current.store, [sourceItem]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: sourceItem.answerKnowledge,
      reviewer: "V1审核员",
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: sourceItem.familyGold,
      reviewer: "V1审核员",
    });
    const { frozen: parent } = prepareAndCommit(current.store, "review-batch-v1", "V1审核员");
    const parentBytes = fs.readFileSync(parent.snapshot.filePath);
    const formalFacts = { "q-1": [revisionFamilyFact("q-1")] };
    const created = current.store.createRevisionDraft("review-batch-v1", {
      id: "review-batch-v2",
      title: "20题盲测金标集V2",
      version: "V2",
      riskQuestionIds: ["q-1"],
      qualificationIssues: [{ questionId: "q-1", code: "family_mode_risk", message: "原盲测层级需要复核。" }],
      reason: "V1 题族分层事实不一致。",
      formalFamilyFactsByQuestionId: formalFacts,
      formalFamilyFactsProvenance: { contentSha256: contentHash(formalFacts) },
    });
    const revisionItem = created.batch.items[0];
    assert.equal(revisionItem.sourceMode, "mature");
    assert.equal(revisionItem.finalReplayMode, "mature");

    assert.throws(() => current.store.reviewFamily("review-batch-v2", "q-1", {
      expectedRevision: revisionItem.revision,
      result: "confirmed",
      finalReplayMode: "unmatched",
      note: "改为无匹配建族。",
      familyGold: v2FamilyGold(unmatchedFamilyGold()),
    }), (error) => {
      assert.equal(error.message, "classification_gold_review_replay_mode_correction_required");
      assert.equal(error.details.requestedReplayMode, "unmatched");
      return true;
    });

    const reviewed = current.store.reviewFamily("review-batch-v2", "q-1", {
      expectedRevision: revisionItem.revision,
      result: "corrected",
      finalReplayMode: "unmatched",
      replayModeChangeReason: "现有题族均只覆盖局部知识,原成熟题族分层不成立。",
      note: "现有题族均只覆盖局部知识,原成熟题族分层不成立。",
      familyGold: v2FamilyGold(unmatchedFamilyGold()),
      reviewer: "V2审核员",
    });
    assert.equal(reviewed.item.sourceMode, "mature");
    assert.equal(reviewed.item.finalReplayMode, "unmatched");
    assert.equal(reviewed.item.familyGold.replayMode, "unmatched");
    assert.equal(reviewed.item.familyReview.previousReplayMode, "mature");
    assert.equal(reviewed.item.familyReview.nextReplayMode, "unmatched");
    assert.equal(reviewed.item.familyReview.changeReason, "现有题族均只覆盖局部知识,原成熟题族分层不成立。");
    assert.equal(reviewed.summary.modes.mature, 0);
    assert.equal(reviewed.summary.modes.unmatched, 1);
    const familyEvent = reviewed.item.reviewHistory.at(-1);
    assert.equal(familyEvent.previousReplayMode, "mature");
    assert.equal(familyEvent.nextReplayMode, "unmatched");
    assert.equal(familyEvent.replayModeChanged, true);
    assert.equal(familyEvent.changeReason, "现有题族均只覆盖局部知识,原成熟题族分层不成立。");

    const reopened = current.store.reopenFamilyReviews("review-batch-v2", {
      questionIds: ["q-1"],
      reason: "复核已改判的最终层级。",
      preflightReportHash: "d".repeat(64),
      qualificationIssues: [{ questionId: "q-1", code: "follow_up_review", message: "复核最终层级。" }],
      reviewer: "V2审核员",
    });
    const reopenedItem = reopened.batch.items[0];
    assert.equal(reopenedItem.finalReplayMode, "unmatched");
    const reconfirmed = current.store.reviewFamily("review-batch-v2", "q-1", {
      expectedRevision: reopenedItem.revision,
      result: "confirmed",
      familyGold: reopenedItem.familyGold,
      reviewer: "V2审核员",
    });
    assert.equal(reconfirmed.item.finalReplayMode, "unmatched");
    assert.equal(reconfirmed.item.familyReview.result, "confirmed");

    const prepared = current.store.prepareFreeze("review-batch-v2", { reviewer: "V2审核员" });
    assert.equal(prepared.preparation.summary.modes.unmatched, 1);
    const frozen = current.store.commitFreeze("review-batch-v2", {
      token: prepared.preparation.token,
      reviewer: "V2审核员",
    });
    const snapshot = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
    assert.equal(snapshot.items[0].replayMode, "unmatched");
    assert.equal(snapshot.items[0].familyGold.replayMode, "unmatched");
    assert.equal(snapshot.items[0].audit.sourceReplayMode, "mature");
    assert.equal(snapshot.items[0].audit.finalReplayMode, "unmatched");
    assert.deepEqual(fs.readFileSync(parent.snapshot.filePath), parentBytes);
  } finally {
    current.cleanup();
  }
});

test("a non-revision V1 review cannot change its replay mode", () => {
  const current = fixture();
  try {
    const sourceItem = item("q-1");
    importBatch(current.store, [sourceItem]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: sourceItem.answerKnowledge,
    });
    assert.throws(() => current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "corrected",
      finalReplayMode: "unmatched",
      note: "尝试修改 V1 层级。",
      familyGold: unmatchedFamilyGold(),
    }), (error) => {
      assert.equal(error.message, "classification_gold_review_replay_mode_locked");
      assert.equal(error.details.label, "当前题目不允许修改盲测层级");
      return true;
    });
    const unchanged = current.store.get("review-batch-v1").items[0];
    assert.equal(unchanged.sourceMode, "mature");
    assert.equal(unchanged.finalReplayMode, "mature");
    assert.equal(unchanged.familyReview.result, "pending_review");
  } finally {
    current.cleanup();
  }
});

test("a disputed V2 family review remains freezable without becoming accuracy gold", () => {
  const current = fixture();
  try {
    const sourceItem = item("q-1", { familyGold: familyGoldForQuestion("q-1") });
    importBatch(current.store, [sourceItem]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: sourceItem.answerKnowledge,
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: sourceItem.familyGold,
    });
    prepareAndCommit(current.store, "review-batch-v1", "V1审核员");
    const formalFacts = { "q-1": [revisionFamilyFact("q-1")] };
    const created = current.store.createRevisionDraft("review-batch-v1", {
      id: "review-batch-v2",
      title: "20题盲测金标集V2",
      version: "V2",
      riskQuestionIds: ["q-1"],
      qualificationIssues: [{ questionId: "q-1", code: "family_risk", message: "题族裁决存在争议。" }],
      formalFamilyFactsByQuestionId: formalFacts,
      formalFamilyFactsProvenance: { contentSha256: contentHash(formalFacts) },
    });
    const revisionItem = created.batch.items[0];
    const disputed = current.store.reviewFamily("review-batch-v2", "q-1", {
      expectedRevision: revisionItem.revision,
      result: "disputed",
      note: "候选题族定义尚未形成一致意见。",
      familyGold: {
        replayMode: "mature",
        decision: "create_new",
        primaryFamilyId: "",
        relatedFamilyIds: [],
        families: [],
        candidateFamily: { name: "待讨论候选题族" },
      },
    });
    assert.equal(disputed.item.familyReview.result, "disputed");
    assert.equal(disputed.summary.readyToFreeze, true);
    assert.equal(disputed.summary.accuracyEligible, 0);

    const prepared = current.store.prepareFreeze("review-batch-v2", { reviewer: "V2审核员" });
    const frozen = current.store.commitFreeze("review-batch-v2", {
      token: prepared.preparation.token,
      reviewer: "V2审核员",
    });
    const snapshot = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
    assert.equal(snapshot.summary.accuracyEligible, 0);
    assert.equal(snapshot.summary.goldNeedsReview, 1);
    assert.equal(snapshot.items[0].goldStatus, "gold_needs_review");
    assert.equal(snapshot.items[0].includedInAccuracy, false);
    assert.equal(snapshot.items[0].familyGold.candidateFamily.name, "待讨论候选题族");
  } finally {
    current.cleanup();
  }
});

test("legacy frozen review digests remain complete after the answer schema evolves", () => {
  const sourceItem = item("q-legacy");
  const legacyDigest = "legacy-v1-knowledge-digest";
  const store = createMemoryClassificationGoldReviewStore({
    batches: [{
      id: "review-batch-legacy-v1",
      title: "20题盲测金标集V1",
      version: "V1",
      status: "frozen",
      source: { sourceBatchId: "legacy-source", manifestSha256: "legacy-manifest" },
      items: [{
        ...sourceItem,
        humanGold: {
          answerKnowledge: sourceItem.answerKnowledge,
          familyGold: sourceItem.familyGold,
        },
        knowledgeDigest: legacyDigest,
        contentReview: { result: "confirmed", basedOnKnowledgeDigest: legacyDigest },
        familyReview: { result: "confirmed", basedOnKnowledgeDigest: legacyDigest },
      }],
    }],
  });

  const batch = store.get("review-batch-legacy-v1");
  assert.equal(batch.items[0].knowledgeDigest, legacyDigest);
  assert.equal(batch.summary.completed, 1);
  assert.equal(batch.summary.pending, 0);
  assert.equal(batch.summary.readyToFreeze, true);
});

test("V2 preflight reopen is idempotent and prepare returns structured semantic issues", () => {
  const current = fixture();
  try {
    const sourceItem = item("q-1", { familyGold: familyGoldForQuestion("q-1") });
    importBatch(current.store, [sourceItem]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: sourceItem.answerKnowledge,
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: sourceItem.familyGold,
    });
    prepareAndCommit(current.store);
    const invalidFact = { ...revisionFamilyFact("q-1"), status: "pending_review" };
    const facts = { "q-1": [invalidFact] };
    const created = current.store.createRevisionDraft("review-batch-v1", {
      id: "review-batch-v2",
      title: "20题盲测金标集V2",
      version: "V2",
      formalFamilyFactsByQuestionId: facts,
      formalFamilyFactsProvenance: { contentSha256: contentHash(facts) },
    });
    assert.deepEqual(created.revisionReview.requestedRiskQuestionIds, []);
    assert.deepEqual(created.revisionReview.automaticallyReopenedQuestionIds, ["q-1"]);
    assert.equal(created.batch.items[0].familyReview.result, "pending_review");

    const firstReopen = current.store.reopenFamilyReviews("review-batch-v2", {
      questionIds: ["q-1"],
      reason: "统一一致性预检仍未通过。",
      preflightReportHash: "a".repeat(64),
      qualificationIssues: [{ questionId: "q-1", code: "family_status_not_confirmed", message: "题族尚未确认。" }],
    });
    assert.equal(firstReopen.idempotentReplay, false);
    const revisionAfterFirst = firstReopen.batch.revision;
    const itemRevisionAfterFirst = firstReopen.batch.items[0].revision;
    const repeated = current.store.reopenFamilyReviews("review-batch-v2", {
      questionIds: ["q-1"],
      reason: "统一一致性预检仍未通过。",
      preflightReportHash: "a".repeat(64),
    });
    assert.equal(repeated.idempotentReplay, true);
    assert.equal(repeated.batch.revision, revisionAfterFirst);
    assert.equal(repeated.batch.items[0].revision, itemRevisionAfterFirst);

    const reviewed = current.store.reviewFamily("review-batch-v2", "q-1", {
      expectedRevision: repeated.batch.items[0].revision,
      result: "confirmed",
      familyGold: v2FamilyGold(repeated.batch.items[0].familyGold),
    });
    assert.equal(reviewed.item.familyReview.result, "confirmed");
    assert.throws(() => current.store.prepareFreeze("review-batch-v2"), (error) => {
      assert.equal(error.message, "classification_gold_review_family_semantic_invalid");
      assert.ok(error.details.issues.some((issue) => issue.code === "family_status_not_confirmed"));
      return true;
    });
  } finally {
    current.cleanup();
  }
});

test("frozen gold snapshot rejects a missing SHA-256 sidecar", () => {
  const current = fixture();
  try {
    importBatch(current.store);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
    });
    const { frozen } = prepareAndCommit(current.store);
    fs.chmodSync(frozen.snapshot.sidecarPath, 0o600);
    fs.rmSync(frozen.snapshot.sidecarPath);

    assert.throws(
      () => readFrozenGoldSnapshot(frozen.snapshot.filePath),
      (error) => error && error.code === "ENOENT",
    );
  } finally {
    current.cleanup();
  }
});

test("frozen gold snapshot rejects file-byte tampering", () => {
  const current = fixture();
  try {
    importBatch(current.store);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
    });
    const { frozen } = prepareAndCommit(current.store);
    fs.chmodSync(frozen.snapshot.filePath, 0o600);
    fs.appendFileSync(frozen.snapshot.filePath, "\n");

    assert.throws(
      () => readFrozenGoldSnapshot(frozen.snapshot.filePath),
      /classification_gold_snapshot_file_hash_mismatch/,
    );
  } finally {
    current.cleanup();
  }
});

test("frozen gold snapshot rejects semantic content tampering", () => {
  const current = fixture();
  try {
    importBatch(current.store);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
    });
    const { frozen } = prepareAndCommit(current.store);
    const snapshot = JSON.parse(fs.readFileSync(frozen.snapshot.filePath, "utf8"));
    snapshot.items[0].questionSnapshot.stem = "被篡改的题干";
    fs.chmodSync(frozen.snapshot.filePath, 0o600);
    fs.writeFileSync(frozen.snapshot.filePath, `${JSON.stringify(snapshot, null, 2)}\n`);

    assert.throws(
      () => readFrozenGoldSnapshot(frozen.snapshot.filePath),
      /classification_gold_snapshot_content_hash_mismatch/,
    );
  } finally {
    current.cleanup();
  }
});

test("frozen gold snapshot rejects contradictory option knowledge relations", () => {
  const current = fixture();
  try {
    importBatch(current.store);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: item("q-1").familyGold,
    });
    const { frozen } = prepareAndCommit(current.store);
    const snapshot = JSON.parse(fs.readFileSync(frozen.snapshot.filePath, "utf8"));
    snapshot.items[0].knowledgeGold.optionKnowledge[0].knowledgeRelation = "question_only";
    snapshot.items[0].knowledgeGold.optionKnowledge[0].knowledgeNodeIds = ["contradictory-node"];
    const { integrity: _oldIntegrity, ...payload } = snapshot;
    snapshot.integrity.contentSha256 = contentHash(payload);
    fs.chmodSync(frozen.snapshot.filePath, 0o600);
    fs.writeFileSync(frozen.snapshot.filePath, `${JSON.stringify(snapshot, null, 2)}\n`);

    assert.throws(
      () => readFrozenGoldSnapshot(frozen.snapshot.filePath, { requireSidecar: false }),
      /classification_gold_snapshot_option_knowledge_invalid/,
    );
  } finally {
    current.cleanup();
  }
});

test("option knowledge v2 freeze keeps disputed unfinished relations outside accuracy", () => {
  for (const relation of ["unreviewed", "undetermined"]) {
    const current = fixture();
    try {
      const base = item("q-1");
      importBatch(current.store, [item("q-1", {
        reviewMethod: "human_independent_gold_v1",
        humanGold: {
          answerKnowledge: {
            ...base.answerKnowledge,
            textbookEvidence: base.answerKnowledge.textbookEvidence.map((evidence) => ({ ...evidence, candidateOnly: true })),
            optionKnowledge: [
              { key: "A", text: "甲", knowledgeRelation: relation, role: "answer" },
              { key: "B", text: "乙", knowledgeRelation: "question_only", role: "distractor" },
            ],
          },
          familyGold: base.familyGold,
        },
        sourceMaterials: { sourceAnswer: base.question, textbookEvidence: base.answerKnowledge.textbookEvidence },
      })]);
      const content = current.store.reviewContent("review-batch-v1", "q-1", {
        expectedRevision: 1,
        result: "disputed",
        note: "保留争议以验证冻结结构门禁。",
        answerKnowledge: current.store.get("review-batch-v1").items[0].answerKnowledge,
      });
      current.store.reviewFamily("review-batch-v1", "q-1", {
        expectedRevision: content.item.revision,
        result: "disputed",
        note: "题族随内容保持争议。",
        familyGold: base.familyGold,
      });
      const { frozen } = prepareAndCommit(current.store);
      const snapshot = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
      assert.equal(snapshot.items[0].goldStatus, "gold_needs_review");
      assert.equal(snapshot.items[0].includedInAccuracy, false);
      assert.equal(snapshot.summary.accuracyEligible, 0);
    } finally {
      current.cleanup();
    }
  }
});

test("composed option gold freezes atomic knowledge without copying it to combination choices", () => {
  const current = fixture();
  try {
    const base = item("q-composed");
    base.question.choiceStructure = "composed_options";
    base.question.atomicStatements = [
      { key: "1", text: "陈述一" },
      { key: "2", text: "陈述二" },
    ];
    base.question.optionComposition = [
      { optionKey: "A", atomicKeys: ["1"] },
      { optionKey: "B", atomicKeys: ["1", "2"] },
    ];
    base.reviewMethod = "human_independent_gold_v1";
    base.humanGold = {
      answerKnowledge: {
        ...base.answerKnowledge,
        optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
        choiceStructure: "composed_options",
        textbookEvidence: base.answerKnowledge.textbookEvidence.map((evidence) => ({ ...evidence, candidateOnly: true })),
        optionKnowledge: [],
        atomicStatements: [
          { key: "1", text: "陈述一", knowledgeRelation: "question_only", basis: "题目层规则足以判断。" },
          { key: "2", text: "陈述二", knowledgeRelation: "option_specific", basis: "删除该规则后无法判断。", knowledgeNodeIds: ["node-atomic-2"] },
        ],
        optionComposition: base.question.optionComposition,
      },
      familyGold: base.familyGold,
    };
    base.sourceMaterials = { sourceAnswer: base.question, textbookEvidence: base.answerKnowledge.textbookEvidence };
    importBatch(current.store, [base]);
    const content = current.store.reviewContent("review-batch-v1", "q-composed", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: current.store.get("review-batch-v1").items[0].answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
    });
    current.store.reviewFamily("review-batch-v1", "q-composed", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: base.familyGold,
    });
    const { frozen } = prepareAndCommit(current.store);
    const frozenItem = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot.items[0];
    assert.equal(frozenItem.knowledgeGold.choiceStructure, "composed_options");
    assert.deepEqual(frozenItem.knowledgeGold.atomicStatements[1].knowledgeNodeIds, ["node-atomic-2"]);
    assert.deepEqual(frozenItem.knowledgeGold.optionKnowledge, []);
    assert.deepEqual(frozenItem.knowledgeGold.optionComposition[1].atomicKeys, ["1", "2"]);
  } finally {
    current.cleanup();
  }
});

test("composed option review cannot remove atomic statements or rewrite the formal composition", () => {
  const current = fixture();
  try {
    importBatch(current.store, [composedItem()]);
    const answerKnowledge = current.store.get("review-batch-v1").items[0].answerKnowledge;
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-composed", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: {
        ...answerKnowledge,
        atomicStatements: answerKnowledge.atomicStatements.slice(0, 1),
        optionComposition: [
          { optionKey: "A", atomicKeys: ["1"] },
          { optionKey: "B", atomicKeys: ["1"] },
        ],
      },
      selectedEvidenceChunkIds: ["chunk-1"],
    }), /classification_gold_review_composed_structure_changed/);

    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-composed", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: {
        ...answerKnowledge,
        optionComposition: [
          { optionKey: "A", atomicKeys: ["1"] },
          { optionKey: "B", atomicKeys: ["2"] },
        ],
      },
      selectedEvidenceChunkIds: ["chunk-1"],
    }), /classification_gold_review_composed_structure_changed/);
  } finally {
    current.cleanup();
  }
});

test("composed option review and frozen snapshots reject wrapper knowledge relations", () => {
  const current = fixture();
  try {
    importBatch(current.store, [composedItem()]);
    const answerKnowledge = current.store.get("review-batch-v1").items[0].answerKnowledge;
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-composed", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: {
        ...answerKnowledge,
        optionKnowledge: [{ key: "A", text: "甲", knowledgeRelation: "question_only", role: "answer" }],
      },
      selectedEvidenceChunkIds: ["chunk-1"],
    }), /classification_gold_review_composed_option_knowledge_forbidden/);

    const content = current.store.reviewContent("review-batch-v1", "q-composed", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
    });
    current.store.reviewFamily("review-batch-v1", "q-composed", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: composedItem().familyGold,
    });
    const { frozen } = prepareAndCommit(current.store);
    const loaded = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
    loaded.items[0].knowledgeGold.optionKnowledge = [{
      key: "A",
      knowledgeRelation: "question_only",
      protocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
    }];
    const tamperedPath = path.join(current.root, "wrapper-relation.json");
    writeRehashedSnapshot(tamperedPath, loaded);
    assert.throws(() => readFrozenGoldSnapshot(tamperedPath), /classification_gold_snapshot_composed_option_knowledge_forbidden/);

    const changedStructure = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
    changedStructure.items[0].knowledgeGold.atomicStatements = changedStructure.items[0]
      .knowledgeGold.atomicStatements.slice(0, 1);
    changedStructure.items[0].answerAndEvidence.atomicStatements = changedStructure.items[0]
      .answerAndEvidence.atomicStatements.slice(0, 1);
    changedStructure.items[0].knowledgeGold.optionComposition = [
      { optionKey: "A", atomicKeys: ["1"] },
      { optionKey: "B", atomicKeys: ["1"] },
    ];
    changedStructure.items[0].answerAndEvidence.optionComposition = changedStructure.items[0]
      .knowledgeGold.optionComposition;
    const changedStructurePath = path.join(current.root, "changed-composed-structure.json");
    writeRehashedSnapshot(changedStructurePath, changedStructure);
    assert.throws(() => readFrozenGoldSnapshot(changedStructurePath), /classification_gold_snapshot_composed_structure_changed/);
  } finally {
    current.cleanup();
  }
});

test("frozen snapshot reader rejects accuracy eligibility that contradicts gold status", () => {
  const current = fixture();
  try {
    importBatch(current.store, [composedItem()]);
    const answerKnowledge = current.store.get("review-batch-v1").items[0].answerKnowledge;
    const content = current.store.reviewContent("review-batch-v1", "q-composed", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
    });
    current.store.reviewFamily("review-batch-v1", "q-composed", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: composedItem().familyGold,
    });
    const { frozen } = prepareAndCommit(current.store);
    const loaded = readFrozenGoldSnapshot(frozen.snapshot.filePath).snapshot;
    loaded.items[0].includedInAccuracy = false;
    const tamperedPath = path.join(current.root, "invalid-eligibility.json");
    writeRehashedSnapshot(tamperedPath, loaded);
    assert.throws(() => readFrozenGoldSnapshot(tamperedPath), /classification_gold_snapshot_accuracy_eligibility_invalid/);
  } finally {
    current.cleanup();
  }
});

test("first human judgment remains immutable and later changes append a final adjudication event", () => {
  const current = fixture();
  try {
    const base = item("q-1");
    importBatch(current.store, [item("q-1", {
      reviewMethod: "human_independent_gold_v1",
      humanGold: {
        answerKnowledge: {
          ...base.answerKnowledge,
          textbookEvidence: base.answerKnowledge.textbookEvidence.map((evidence) => ({ ...evidence, candidateOnly: true })),
          optionKnowledge: [
            { key: "A", text: "甲", knowledgeRelation: "question_only", role: "answer" },
            { key: "B", text: "乙", knowledgeRelation: "question_only", role: "distractor" },
          ],
        },
        familyGold: base.familyGold,
      },
      sourceMaterials: { sourceAnswer: base.question, textbookEvidence: base.answerKnowledge.textbookEvidence },
    })]);
    const first = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: current.store.get("review-batch-v1").items[0].answerKnowledge,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "审核员甲",
    });
    const firstEventId = first.item.reviewHistory[0].id;
    const firstSnapshot = JSON.stringify(first.item.firstHumanJudgment.content);
    const revisedAnswer = {
      ...first.item.answerKnowledge,
      optionKnowledge: [
        { key: "A", text: "甲", knowledgeRelation: "option_specific", knowledgeNodeIds: ["node-a"], role: "answer" },
        { key: "B", text: "乙", knowledgeRelation: "question_only", role: "distractor" },
      ],
    };
    const revised = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: first.item.revision,
      result: "corrected",
      note: "对比证据后修正 A 项关系。",
      answerKnowledge: revisedAnswer,
      selectedEvidenceChunkIds: ["chunk-1"],
      reviewer: "审核员甲",
    });
    assert.equal(JSON.stringify(revised.item.firstHumanJudgment.content), firstSnapshot);
    assert.equal(revised.item.reviewHistory[0].eventType, "first_human_judgment");
    assert.equal(revised.item.reviewHistory[1].eventType, "final_adjudication");
    assert.equal(revised.item.reviewHistory[1].supersedesEventId, firstEventId);
    assert.equal(revised.item.answerKnowledge.optionKnowledge[0].knowledgeRelation, "option_specific");
  } finally {
    current.cleanup();
  }
});

test("gold review rejects stale revisions and requires reasons for corrections and disputes", () => {
  const current = fixture();
  try {
    importBatch(current.store);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 0,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    }), /classification_gold_review_revision_conflict/);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "corrected",
      answerKnowledge: item("q-1").answerKnowledge,
    }), /classification_gold_review_note_required/);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "disputed",
      answerKnowledge: item("q-1").answerKnowledge,
    }), /classification_gold_review_note_required/);
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: { ...item("q-1").answerKnowledge, correctAnswer: ["B"] },
    }), /classification_gold_review_business_sync_required/);
  } finally {
    current.cleanup();
  }
});

test("gold review treats required knowledge order as equivalent but still detects membership changes", () => {
  const current = fixture();
  try {
    const sourceItem = item("q-1");
    sourceItem.answerKnowledge.requiredKnowledge = [
      sourceItem.answerKnowledge.coreKnowledge,
      { id: "node-a", title: "知识甲", path: "语音 > 知识甲" },
      { id: "node-b", title: "知识乙", path: "语音 > 知识乙" },
    ];
    importBatch(current.store, [sourceItem]);
    const imported = current.store.get("review-batch-v1").items[0];
    assert.throws(() => current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: imported.revision,
      result: "confirmed",
      answerKnowledge: {
        ...imported.answerKnowledge,
        requiredKnowledge: [
          imported.answerKnowledge.requiredKnowledge[0],
          imported.answerKnowledge.requiredKnowledge[1],
          { id: "node-c", title: "知识丙", path: "语音 > 知识丙" },
        ],
      },
    }), /classification_gold_review_business_sync_required/);
    const reviewed = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: imported.revision,
      result: "confirmed",
      answerKnowledge: {
        ...imported.answerKnowledge,
        requiredKnowledge: [
          {
            ...imported.answerKnowledge.requiredKnowledge[2],
            title: "刷新后的知识乙标签",
            path: "刷新后的目录 > 知识乙",
          },
          imported.answerKnowledge.requiredKnowledge[0],
          imported.answerKnowledge.requiredKnowledge[1],
          imported.answerKnowledge.requiredKnowledge[1],
        ],
      },
    });
    assert.equal(reviewed.item.contentReview.result, "confirmed");
    assert.deepEqual(reviewed.item.answerKnowledge.requiredKnowledge, imported.answerKnowledge.requiredKnowledge);
  } finally {
    current.cleanup();
  }
});

test("new-family decisions require core fields unless the result remains disputed", () => {
  const incomplete = fixture();
  try {
    importBatch(incomplete.store, [item("q-1", {
      mode: "singleton",
      familyGold: {
        replayMode: "singleton",
        decision: "create_new",
        candidateFamily: { name: "清浊音判断候选题族" },
      },
    })]);
    const content = incomplete.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    assert.throws(() => incomplete.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: incomplete.store.get("review-batch-v1").items[0].familyGold,
    }), /classification_gold_review_candidate_family_incomplete/);
    const disputed = incomplete.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "disputed",
      note: "候选题族的教材锚点和考查动作仍需确认。",
      familyGold: incomplete.store.get("review-batch-v1").items[0].familyGold,
    });
    assert.equal(disputed.item.familyReview.result, "disputed");
    assert.equal(disputed.summary.accuracyEligible, 0);
  } finally {
    incomplete.cleanup();
  }

  const complete = fixture();
  try {
    const candidateFamily = {
      name: "清浊音判断候选题族",
      bookId: "modern-chinese-7-1",
      coreKnowledgeNodeId: "node-core",
      requiredKnowledgeNodeIds: ["node-core"],
      textbookAnchorNodeIds: ["node-core"],
      assessmentAction: "判断辅音发音时声带是否振动",
    };
    importBatch(complete.store, [item("q-1", {
      mode: "singleton",
      familyGold: {
        replayMode: "singleton",
        decision: "create_new",
        candidateFamily,
      },
    })]);
    const content = complete.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: item("q-1").answerKnowledge,
    });
    const family = complete.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: complete.store.get("review-batch-v1").items[0].familyGold,
    });
    assert.equal(family.item.familyReview.result, "confirmed");
    assert.equal(family.item.familyGold.candidateFamily.inclusionBoundary, "");
    assert.equal(family.item.familyGold.candidateFamily.exclusionBoundary, "");
  } finally {
    complete.cleanup();
  }
});

test("semantic preflight reports a completed-but-invalid item and sync reopens it idempotently", () => {
  const current = fixture();
  try {
    const questionId = "q-5";
    const invalidFamily = {
      ...revisionFamilyFact(questionId, "family-q5"),
      status: "pending_review",
    };
    const sourceItem = item(questionId, {
      sourceMode: "mature",
      familyGold: v2FamilyGold({
        replayMode: "mature",
        decision: "join_existing",
        primaryFamilyId: invalidFamily.id,
        relatedFamilyIds: [],
        families: [invalidFamily],
      }),
      qualificationAudit: {
        status: "resolved",
        parentSnapshotId: "parent-v2",
        requiredStages: [],
      },
    });
    current.store.importBatch({
      id: "review-batch-v3-q5",
      title: "盲测金标集V3",
      version: "V3",
      source: { parentSnapshotId: "parent-v2" },
      items: [sourceItem],
    });
    const state = current.store.exportState();
    const storedItem = state.batches[0].items[0];
    // Simulate the stale UI state: both review stages look complete even
    // though the current semantic facts are no longer valid.
    storedItem.contentReview = {
      result: "confirmed",
      basedOnKnowledgeDigest: storedItem.knowledgeDigest,
    };
    storedItem.familyReview = {
      result: "confirmed",
      basedOnKnowledgeDigest: storedItem.knowledgeDigest,
    };
    current.store.replaceState(state);

    const preflight = current.store.validateFamilySemantics("review-batch-v3-q5");
    assert.equal(preflight.valid, false);
    assert.equal(preflight.questionCount, 1);
    assert.ok(preflight.issues.some((issue) => issue.code === "family_status_not_confirmed"));
    assert.equal(current.store.get("review-batch-v3-q5").summary.readyToFreeze, true);

    const payload = {
      questionIds: [questionId],
      preflightReportHash: "e".repeat(64),
      reason: "零模型预检发现题族状态已漂移。",
    };
    const synced = current.store.syncPreflightIssues("review-batch-v3-q5", payload);
    assert.equal(synced.changed, true);
    assert.equal(synced.idempotentReplay, false);
    assert.equal(synced.operation.operationType, "preflight_sync");
    assert.deepEqual(synced.operation.questionIds, [questionId]);
    const reopened = synced.batch.items[0];
    assert.equal(reopened.familyReview.result, "pending_review");
    assert.equal(reopened.contentReview.result, "confirmed");
    assert.equal(reopened.revisionReview.status, "requires_family_review");
    assert.deepEqual(reopened.revisionReview.requiredStages, ["family"]);
    assert.ok(reopened.revisionReview.issues.some((issue) => issue.code === "family_status_not_confirmed"));
    assert.equal(synced.batch.summary.readyToFreeze, false);

    const revisionAfterSync = synced.batch.revision;
    const repeated = current.store.syncPreflightIssues("review-batch-v3-q5", payload);
    assert.equal(repeated.idempotentReplay, true);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.batch.revision, revisionAfterSync);
    assert.equal(repeated.batch.items[0].revision, reopened.revision);
  } finally {
    current.cleanup();
  }
});

test("revision drafts inherit the member contribution confirmed in the frozen parent snapshot", () => {
  const current = fixture();
  try {
    const base = item("q-1", { familyGold: familyGoldForQuestion("q-1") });
    // 父版本金标里人工已确认本题在该题族中的贡献知识。
    base.familyGold = {
      ...base.familyGold,
      families: [{
        ...base.familyGold.families[0],
        membership: {
          questionId: "q-1",
          isPrimary: true,
          role: "prototype",
          reviewStatus: "confirmed",
          contributionKnowledgeNodeIds: ["node-core"],
          revision: 7,
        },
      }],
    };
    importBatch(current.store, [base]);
    const content = current.store.reviewContent("review-batch-v1", "q-1", {
      expectedRevision: 1,
      result: "confirmed",
      answerKnowledge: base.answerKnowledge,
    });
    current.store.reviewFamily("review-batch-v1", "q-1", {
      expectedRevision: content.item.revision,
      result: "confirmed",
      familyGold: base.familyGold,
    });
    prepareAndCommit(current.store, "review-batch-v1");

    // 正式题族库不保存逐成员贡献知识：派生时的正式事实贡献为空、membership 缺失。
    const formalFact = revisionFamilyFact("q-1");
    const formalFamilyFactsByQuestionId = {
      "q-1": [{
        ...formalFact,
        membership: null,
        members: formalFact.members.map((member) => ({
          ...member,
          contributionKnowledgeNodeIds: [],
          contributionKnowledge: [],
        })),
      }],
    };
    const created = current.store.createRevisionDraft("review-batch-v1", {
      id: "review-batch-v2",
      title: "派生修订草稿",
      version: "V2",
      riskOrders: [1],
      reason: "核对逐成员贡献知识的继承。",
      reviewer: "V2审核员",
      formalFamilyFactsByQuestionId,
      formalFamilyFactsProvenance: {
        source: "question_family_store_revision_snapshot",
        contentSha256: contentHash(formalFamilyFactsByQuestionId),
      },
    });

    const draftFamily = created.batch.items[0].familyGold.families[0];
    assert.deepEqual(draftFamily.membership.contributionKnowledgeNodeIds, ["node-core"]);
    assert.deepEqual(
      draftFamily.membership.contributionKnowledge.map((node) => node.id),
      ["node-core"],
    );
    // members 行与 membership 必须给出同一个贡献值，避免草稿内部自相矛盾。
    assert.deepEqual(
      draftFamily.members.find((member) => member.questionId === "q-1").contributionKnowledgeNodeIds,
      ["node-core"],
    );
    // 题族定义与状态仍以正式题族事实为准。
    assert.equal(draftFamily.status, "confirmed");
    assert.deepEqual(draftFamily.requiredKnowledgeNodeIds, ["node-core"]);
  } finally {
    current.cleanup();
  }
});

test("freeze prepare reports semantic blockers before the incomplete-batch check", () => {
  const current = fixture();
  try {
    const questionId = "q-5";
    const invalidFamily = {
      ...revisionFamilyFact(questionId, "family-q5"),
      status: "pending_review",
    };
    current.store.importBatch({
      id: "review-batch-v3-q5",
      title: "盲测金标集V3",
      version: "V3",
      source: { parentSnapshotId: "parent-v2" },
      items: [item(questionId, {
        sourceMode: "mature",
        familyGold: v2FamilyGold({
          replayMode: "mature",
          decision: "join_existing",
          primaryFamilyId: invalidFamily.id,
          relatedFamilyIds: [],
          families: [invalidFamily],
        }),
        qualificationAudit: {
          status: "resolved",
          parentSnapshotId: "parent-v2",
          requiredStages: [],
        },
      })],
    });

    // 题族阶段仍为待审：整批尚未形成终态，旧顺序会先抛“未审核完成”。
    assert.equal(current.store.get("review-batch-v3-q5").summary.readyToFreeze, false);
    const validation = current.store.validateFamilySemantics("review-batch-v3-q5");
    assert.equal(validation.valid, false);
    assert.ok(validation.issues.some((issue) => issue.code === "family_status_not_confirmed"));

    assert.throws(() => current.store.prepareFreeze("review-batch-v3-q5", { reviewer: "审核员" }), (error) => {
      assert.equal(error.message, "classification_gold_review_family_semantic_invalid");
      assert.ok(error.details.issues.some((issue) => issue.code === "family_status_not_confirmed"));
      return true;
    });
  } finally {
    current.cleanup();
  }
});
