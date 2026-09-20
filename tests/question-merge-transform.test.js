const assert = require("node:assert/strict");
const test = require("node:test");

const { transformQuestionMerge } = require("../apps/api/src/question-merge-transform");

const sourceId = "question-source";
const targetId = "question-target";
const bookId = "book-a";

function question(id, version, patch = {}) {
  return {
    id,
    bookId,
    subjectId: "subject-a",
    status: "official",
    version,
    createdAt: version * 100,
    updatedAt: version * 100,
    versions: [{ version, updatedAt: version * 100, updatedBy: "seed", changeNote: "seed" }],
    ...patch,
  };
}

function baseStates() {
  return {
    questions: [question(sourceId, 2), question(targetId, 4), question("question-other", 1)],
    questionFamilies: {
      version: 4,
      families: [],
      historyByBook: {},
      unresolvedByBook: { [bookId]: [sourceId, "question-other"] },
      membershipRevisionByQuestion: { [sourceId]: 3, [targetId]: 7 },
    },
    knowledgeStructures: {
      version: 4,
      records: [{
        bookId,
        nodes: [
          { id: "node-source", bookId, kind: "knowledge", displayTitle: "源节点", path: "章 > 源节点", knowledgeLevel: 1, startPage: 201 },
          { id: "node-target", bookId, kind: "knowledge", displayTitle: "目标节点", path: "章 > 目标节点", knowledgeLevel: 1, startPage: 220 },
          { id: "node-preferred", bookId, kind: "knowledge", displayTitle: "词义的演变", path: "词汇 > 词义的演变", knowledgeLevel: 2, startPage: 258 },
        ],
        fingerprints: [],
      }],
      editsByBook: {},
    },
    exams: [],
    packs: [],
    learningState: { accounts: [] },
    knowledgeClassification: { jobs: [], results: [] },
    questionEnrichment: { jobs: [], suggestions: [] },
  };
}

function merge(states, patch = {}) {
  return transformQuestionMerge(states, {
    sourceQuestionId: sourceId,
    targetQuestionId: targetId,
    sourceVersion: 2,
    targetVersion: 4,
    reason: "内容实质重复",
    actor: "审核员",
    ...patch,
  });
}

test("question merge atomically transforms active references while preserving histories", () => {
  const states = baseStates();
  states.questionFamilies.families = [{
    id: "family-both",
    source: "manual_family",
    reason: "人工维护的题族，共有 3 道题；确认前不会用于智能复习。",
    status: "confirmed",
    members: [
      { questionId: sourceId, isPrimary: true, role: "similar", action: "判断", confidence: 0.9 },
      { questionId: targetId, isPrimary: false, role: "variant", action: "辨析", confidence: 0.7 },
      { questionId: "question-other", isPrimary: false, role: "prototype" },
    ],
    reviewedAt: 20,
    reviewedBy: "old",
  }, {
    id: "family-target-only",
    status: "confirmed",
    members: [{ questionId: targetId, isPrimary: true, role: "prototype" }],
  }];
  states.questionFamilies.historyByBook[bookId] = [{
    generatedAt: 12,
    families: [{ id: "family-both", members: [{ questionId: sourceId }, { questionId: targetId }] }],
  }];
  states.knowledgeStructures.records[0].fingerprints = [
    { questionId: sourceId, bookId, primaryNodeId: "node-source", requiredNodeIds: ["node-source"], evidencePages: [201], source: "manual_review" },
    { questionId: targetId, bookId, primaryNodeId: "node-target", requiredNodeIds: ["node-target"], evidencePages: [201], source: "catalog_rule" },
  ];
  states.knowledgeStructures.editsByBook[bookId] = {
    updates: {},
    fingerprintOverrides: {
      [sourceId]: { questionId: sourceId, primaryNodeId: "node-source", requiredNodeIds: ["node-source"], questionVersion: 2 },
      [targetId]: { questionId: targetId, primaryNodeId: "node-target", requiredNodeIds: ["node-target"], questionVersion: 4 },
    },
  };
  states.exams = [{
    id: "exam-active",
    status: "published",
    version: 3,
    questionIds: [sourceId, targetId, "question-other"],
    selectionRules: [{ id: "rule-1", requiredCount: 2, questionIds: [sourceId, targetId, "question-other"] }],
    freePreviewQuestionCount: 3,
    versions: [],
  }, {
    id: "exam-offline",
    status: "offline",
    version: 1,
    questionIds: [sourceId],
    selectionRules: [],
    versions: [],
  }];
  states.packs = [{ id: "pack-active", status: "public", version: 2, questionIds: [sourceId, targetId], versions: [] }];
  states.learningState.accounts = [{
    userId: "user-a",
    attempts: [{ id: "attempt-source", questionId: sourceId }],
    reviewHistory: [{ id: "history-source", questionId: sourceId }],
    scoreHistory: [{ requestId: "score-source", questionId: sourceId }],
    reviewStates: {
      [sourceId]: { questionId: sourceId, lastReviewAt: 20, mastery: "familiar" },
      [targetId]: { questionId: targetId, lastReviewAt: 10, mastery: "new" },
    },
    bookmarks: {
      [sourceId]: { questionId: sourceId, value: true, updatedAt: 5 },
      [targetId]: { questionId: targetId, value: false, updatedAt: 8 },
    },
  }];
  states.knowledgeClassification.results = [
    { id: "classification-pending", questionId: sourceId, status: "pending_review", reviewStatus: "pending" },
    { id: "classification-applied", questionId: sourceId, status: "applied", reviewStatus: "applied" },
  ];
  states.questionEnrichment.suggestions = [
    { id: "enrichment-pending", questionId: sourceId, status: "recommended" },
    { id: "enrichment-applied", questionId: sourceId, status: "applied" },
  ];
  const original = structuredClone(states);

  const result = merge(states, {
    preferredKnowledgeNodeId: "node-preferred",
    primaryFamilyId: "family-both",
    mergedAt: 5000,
  });
  const next = result.nextStates;
  assert.deepEqual(states, original, "the transform must not mutate exported store states");

  const source = next.questions.find((item) => item.id === sourceId);
  assert.equal(source.status, "offline");
  assert.equal(source.mergedIntoQuestionId, targetId);
  assert.equal(source.version, 3);
  assert.equal(source.merge.reason, "内容实质重复");
  assert.equal(source.merge.mergedAt, 5000);
  assert.equal(source.versions[0].previousSnapshot.status, "official");
  assert.equal(next.questions.find((item) => item.id === targetId).version, 4);

  const both = next.questionFamilies.families.find((family) => family.id === "family-both");
  assert.equal(both.members.filter((member) => member.questionId === targetId).length, 1);
  assert.equal(both.members.find((member) => member.questionId === targetId).resolution, "prefer_source");
  assert.equal(both.members.find((member) => member.questionId === targetId).isPrimary, true);
  assert.equal(both.reason, "人工维护的题族，共有 2 道题；确认前不会用于智能复习。");
  assert.equal(next.questionFamilies.families[1].members[0].isPrimary, false);
  assert.equal(next.questionFamilies.families[1].members[0].resolution, "prefer_source");
  assert.equal(both.status, "confirmed");
  assert.equal(both.members.find((member) => member.questionId === targetId).reviewStatus, "pending_fit");
  assert.equal(next.questionFamilies.families[1].status, "confirmed");
  assert.equal(next.questionFamilies.families[1].members[0].reviewStatus, "pending_fit");
  assert.deepEqual(next.questionFamilies.historyByBook, original.questionFamilies.historyByBook);
  assert.deepEqual(next.questionFamilies.unresolvedByBook, {});
  assert.equal(next.questionFamilies.membershipRevisionByQuestion[sourceId], 4);
  assert.equal(next.questionFamilies.membershipRevisionByQuestion[targetId], 8);

  const fingerprints = next.knowledgeStructures.records[0].fingerprints;
  assert.equal(fingerprints.some((item) => item.questionId === sourceId), false);
  assert.equal(fingerprints.filter((item) => item.questionId === targetId).length, 1);
  assert.deepEqual(fingerprints[0].requiredNodeIds, ["node-preferred"]);
  assert.deepEqual(fingerprints[0].evidencePages, [258], "the final node decision must replace stale evidence pages");
  assert.equal(fingerprints[0].knowledgePath, "词汇 > 词义的演变");
  assert.equal(fingerprints[0].primaryKnowledgePoint, "词义的演变");
  assert.equal(next.knowledgeStructures.records[0].nodes.find((node) => node.id === "node-preferred").questionCount, 1);
  assert.equal(next.knowledgeStructures.records[0].nodes.find((node) => node.id === "node-source").questionCount, 0);
  assert.deepEqual(next.knowledgeStructures.records[0].summary, {
    questionCount: 1,
    nodeCount: 3,
    knowledgeNodeCount: 3,
    deepKnowledgeNodeCount: 1,
    mappedQuestionCount: 1,
    unmappedQuestionCount: 0,
    crossKnowledgeQuestionCount: 0,
  });
  const overrides = next.knowledgeStructures.editsByBook[bookId].fingerprintOverrides;
  assert.equal(Object.hasOwn(overrides, sourceId), false);
  assert.equal(overrides[targetId].primaryNodeId, "node-preferred");
  assert.equal(overrides[targetId].questionVersion, 4);

  assert.deepEqual(next.exams[0].questionIds, [targetId, "question-other"]);
  assert.deepEqual(next.exams[0].selectionRules[0].questionIds, [targetId, "question-other"]);
  assert.equal(next.exams[0].selectionRules[0].requiredCount, 1);
  assert.equal(next.exams[0].version, 4);
  assert.deepEqual(next.exams[1], original.exams[1], "offline exams remain historical snapshots");
  assert.deepEqual(next.packs[0].questionIds, [targetId]);
  assert.equal(next.packs[0].version, 3);

  const account = next.learningState.accounts[0];
  assert.deepEqual(account.attempts, original.learningState.accounts[0].attempts);
  assert.deepEqual(account.reviewHistory, original.learningState.accounts[0].reviewHistory);
  assert.deepEqual(account.scoreHistory, original.learningState.accounts[0].scoreHistory);
  assert.equal(Object.hasOwn(account.reviewStates, sourceId), false);
  assert.equal(account.reviewStates[targetId].mastery, "familiar");
  assert.equal(account.reviewStates[targetId].questionId, targetId);
  assert.equal(Object.hasOwn(account.bookmarks, sourceId), false);
  assert.equal(account.bookmarks[targetId].value, false, "newer target bookmark wins");

  assert.equal(next.knowledgeClassification.results[0].status, "stale");
  assert.equal(next.knowledgeClassification.results[1].status, "applied");
  assert.equal(next.questionEnrichment.suggestions[0].status, "stale");
  assert.equal(next.questionEnrichment.suggestions[1].status, "applied");
  assert.deepEqual(result.summary.updatedExamIds, ["exam-active"]);
  assert.deepEqual(result.summary.updatedPackIds, ["pack-active"]);
  assert.deepEqual(result.summary.staleClassificationResultIds, ["classification-pending"]);
  assert.equal(result.summary.family.primaryFamilyId, "family-both");
  assert.equal(result.summary.family.resolution, "explicit_primary_family");
});

test("source knowledge is copied to the target when the target has no fingerprint or override", () => {
  const states = baseStates();
  states.knowledgeStructures.records[0].fingerprints = [{
    questionId: sourceId,
    bookId,
    primaryNodeId: "node-source",
    primaryKnowledgePoint: "源节点",
    knowledgePath: "章 > 源节点",
    requiredNodeIds: ["node-source"],
    questionVersion: 2,
  }];
  states.knowledgeStructures.editsByBook[bookId] = {
    fingerprintOverrides: {
      [sourceId]: { questionId: sourceId, primaryNodeId: "node-source", requiredNodeIds: ["node-source"], questionVersion: 2 },
    },
  };
  const result = merge(states);
  const fingerprint = result.nextStates.knowledgeStructures.records[0].fingerprints[0];
  assert.equal(fingerprint.questionId, targetId);
  assert.equal(fingerprint.primaryNodeId, "node-source");
  assert.equal(fingerprint.questionVersion, 4);
  const overrides = result.nextStates.knowledgeStructures.editsByBook[bookId].fingerprintOverrides;
  assert.equal(Object.hasOwn(overrides, sourceId), false);
  assert.equal(overrides[targetId].questionId, targetId);
  assert.equal(result.summary.knowledge.action, "copy_source");
});

test("preferred-node merges preserve scope-anchor roles without adding the anchor to required knowledge", () => {
  const states = baseStates();
  const targetNode = states.knowledgeStructures.records[0].nodes.find((node) => node.id === "node-target");
  targetNode.parentId = "node-preferred";
  states.knowledgeStructures.records[0].fingerprints = [{
    questionId: sourceId,
    bookId,
    primaryNodeId: "node-source",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["node-target"],
    questionVersion: 2,
  }];
  states.knowledgeStructures.editsByBook[bookId] = {
    fingerprintOverrides: {
      [sourceId]: {
        questionId: sourceId,
        primaryNodeId: "node-source",
        primaryNodeRole: "scope_anchor",
        requiredNodeIds: ["node-target"],
        questionVersion: 2,
      },
    },
  };
  const result = merge(states, { preferredKnowledgeNodeId: "node-preferred" });
  const fingerprint = result.nextStates.knowledgeStructures.records[0].fingerprints[0];
  assert.equal(fingerprint.primaryNodeId, "node-preferred");
  assert.equal(fingerprint.primaryNodeRole, "scope_anchor");
  assert.deepEqual(fingerprint.requiredNodeIds, ["node-target"]);
  const override = result.nextStates.knowledgeStructures.editsByBook[bookId].fingerprintOverrides[targetId];
  assert.equal(override.primaryNodeRole, "scope_anchor");
  assert.deepEqual(override.requiredNodeIds, ["node-target"]);
});

test("active selection-rule overlaps caused by replacement are deduplicated deterministically", () => {
  const states = baseStates();
  states.exams = [{
    id: "exam-rules",
    status: "draft",
    version: 1,
    questionIds: [sourceId, "question-other", targetId, "question-fourth"],
    selectionRules: [
      { id: "first", requiredCount: 1, questionIds: [sourceId, "question-other"] },
      { id: "second", requiredCount: 1, questionIds: [targetId, "question-fourth"] },
    ],
    versions: [],
  }];
  const result = merge(states);
  const exam = result.nextStates.exams[0];
  assert.deepEqual(exam.questionIds, [targetId, "question-other", "question-fourth"]);
  assert.deepEqual(exam.selectionRules, [{ id: "first", requiredCount: 1, questionIds: [targetId, "question-other"] }]);
});

test("different primary families require an explicit valid primary-family decision", () => {
  const states = baseStates();
  states.questionFamilies.families = [{
    id: "family-source",
    members: [{ questionId: sourceId, isPrimary: true, role: "prototype" }],
  }, {
    id: "family-target",
    members: [{ questionId: targetId, isPrimary: true, role: "prototype" }],
  }];
  assert.throws(() => merge(states), /question_merge_primary_family_conflict/);
  assert.throws(() => merge(states, { primaryFamilyId: "family-other" }), /question_merge_primary_family_invalid/);

  const result = merge(states, { primaryFamilyId: "family-target" });
  const sourceFamilyMember = result.nextStates.questionFamilies.families[0].members.find((member) => member.questionId === targetId);
  const targetFamilyMember = result.nextStates.questionFamilies.families[1].members.find((member) => member.questionId === targetId);
  assert.equal(sourceFamilyMember.isPrimary, false);
  assert.equal(targetFamilyMember.isPrimary, true);
  assert.equal(sourceFamilyMember.resolution, "prefer_source");
  assert.equal(result.summary.family.primaryFamilyId, "family-target");
  assert.deepEqual(result.summary.family.primaryFamilyCandidates, ["family-source", "family-target"]);
});

test("the same primary family does not require an explicit primary-family decision", () => {
  const states = baseStates();
  states.questionFamilies.families = [{
    id: "family-shared",
    members: [
      { questionId: sourceId, isPrimary: true, role: "prototype" },
      { questionId: targetId, isPrimary: true, role: "similar" },
    ],
  }];
  const result = merge(states);
  assert.equal(result.summary.family.primaryFamilyId, "family-shared");
  assert.equal(result.nextStates.questionFamilies.families[0].members.length, 1);
});

test("question merge refreshes relocated and generated family member counts", () => {
  const states = baseStates();
  states.questionFamilies.families = [{
    id: "family-relocated",
    source: "manual_family",
    reason: "人工整体移动的题族，共有 2 道题；确认前不会用于智能复习。",
    members: [{ questionId: sourceId }, { questionId: targetId }],
  }, {
    id: "family-generated",
    source: "catalog_action_rule",
    reason: "按“核心知识点 + 具体考查命题”自动成族，共归入 2 道题；确认前不会用于智能复习。",
    members: [{ questionId: sourceId }, { questionId: targetId }],
  }, {
    id: "family-custom",
    source: "external_curated",
    reason: "外部规则说明：共有 2 道题需要对照原始批次，不是实时成员计数。",
    members: [{ questionId: sourceId }, { questionId: targetId }],
  }];

  const result = merge(states);
  const relocated = result.nextStates.questionFamilies.families.find((family) => family.id === "family-relocated");
  const generated = result.nextStates.questionFamilies.families.find((family) => family.id === "family-generated");
  const custom = result.nextStates.questionFamilies.families.find((family) => family.id === "family-custom");
  assert.equal(relocated.reason, "人工整体移动的题族，共有 1 道题；确认前不会用于智能复习。");
  assert.equal(generated.reason, "按“核心知识点 + 具体考查命题”自动成族，共归入 1 道题；确认前不会用于智能复习。");
  assert.equal(generated.source, "catalog_action_rule");
  assert.equal(custom.reason, "外部规则说明：共有 2 道题需要对照原始批次，不是实时成员计数。");
});

test("merge validation rejects stale versions, cross-book targets, offline questions, and merge chains", () => {
  const cases = [
    [{}, "question_merge_same_question", { targetQuestionId: sourceId, targetVersion: 2 }],
    [{ questions: [question(sourceId, 2), question(targetId, 4, { bookId: "book-b" })] }, "question_merge_book_mismatch"],
    [{}, "question_merge_source_version_conflict", { sourceVersion: 99 }],
    [{ questions: [question(sourceId, 2), question(targetId, 4, { status: "offline" })] }, "question_merge_question_offline"],
    [{ questions: [question(sourceId, 2), question(targetId, 4, { mergedIntoQuestionId: "question-final" })] }, "question_merge_target_already_merged"],
    [{ questions: [question(sourceId, 2), question(targetId, 4), question("question-child", 1, { mergedIntoQuestionId: sourceId })] }, "question_merge_chain_not_allowed"],
  ];
  cases.forEach(([statePatch, expected, inputPatch = {}]) => {
    const states = { ...baseStates(), ...statePatch };
    assert.throws(() => merge(states, inputPatch), new RegExp(expected));
  });
});

test("an unknown preferred knowledge node aborts before returning next states", () => {
  assert.throws(() => merge(baseStates(), { preferredKnowledgeNodeId: "missing-node" }), /question_merge_knowledge_node_not_found/);
});
