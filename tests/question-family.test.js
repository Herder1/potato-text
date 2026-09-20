const assert = require("node:assert/strict");
const test = require("node:test");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryQuestionFamilyStore, buildFamilyCandidates, inferFocus } = require("../apps/api/src/question-family-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");

function question(id, stem, overrides = {}) {
  return {
    id,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第二章 语音 ＞ 第三节 辅音与声母",
    primaryKnowledgePoint: "辅音与声母",
    knowledgePoints: ["辅音与声母"],
    subKnowledgePoints: ["二、声母的发音"],
    type: "single_choice",
    typeLabel: "单选题",
    stem,
    options: [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }],
    correctAnswer: ["A"],
    referenceAnswer: "塞音",
    maxScore: 1,
    difficultyScore: 40,
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    ...overrides,
  };
}

test("question-family directory filtering matches every textbook anchor without duplication", () => {
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "multi-anchor-family",
    bookId: "modern-chinese-7-1",
    name: "跨位置题族",
    knowledgeNodeId: "anchor-primary",
    coreKnowledgeNodeId: "core-node",
    textbookAnchorNodeIds: ["anchor-primary", "anchor-secondary"],
    status: "confirmed",
    members: [{ questionId: "multi-anchor-q", isPrimary: true, role: "prototype" }],
  }] });

  assert.deepEqual(
    store.list({ bookId: "modern-chinese-7-1", knowledgeNodeIds: new Set(["anchor-secondary"]) }).families.map((family) => family.id),
    ["multi-anchor-family"],
  );
  assert.equal(store.list({
    bookId: "modern-chinese-7-1",
    knowledgeNodeIds: new Set(["anchor-primary", "anchor-secondary"]),
  }).families.length, 1);
  assert.equal(store.list({
    bookId: "modern-chinese-7-1",
    knowledgeNodeIds: new Set(["unrelated-anchor"]),
  }).families.length, 0);
});

test("legacy family members inherit the review status of their family definition", () => {
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "legacy-confirmed-family",
    bookId: "modern-chinese-7-1",
    name: "旧已确认题族",
    knowledgeNodeId: "confirmed-node",
    status: "confirmed",
    members: [{ questionId: "legacy-confirmed-q", isPrimary: true, role: "prototype" }],
  }, {
    id: "legacy-pending-family",
    bookId: "modern-chinese-7-1",
    name: "旧待审核题族",
    knowledgeNodeId: "pending-node",
    status: "pending_review",
    members: [{ questionId: "legacy-pending-q", isPrimary: true, role: "prototype" }],
  }, {
    id: "inactive-member-family",
    bookId: "modern-chinese-7-1",
    name: "成员已停用的确认题族",
    knowledgeNodeId: "inactive-node",
    status: "confirmed",
    members: [{ questionId: "inactive-member-q", isPrimary: true, role: "prototype", reviewStatus: "inactive" }],
  }] });

  assert.equal(store.get("legacy-confirmed-family").members[0].reviewStatus, "confirmed");
  assert.equal(store.get("legacy-pending-family").members[0].reviewStatus, "pending_fit");
  assert.equal(store.memberships(["legacy-confirmed-q"], { status: "all" })["legacy-confirmed-q"][0].reviewStatus, "confirmed");
  assert.equal(store.memberships(["legacy-pending-q"], { status: "all" })["legacy-pending-q"][0].reviewStatus, "pending_fit");
  assert.equal(store.confirmedForQuestion("legacy-confirmed-q").length, 1);
  assert.deepEqual(store.confirmedForQuestion("legacy-pending-q"), []);
  assert.deepEqual(store.confirmedForQuestion("inactive-member-q"), []);
});

test("adding and removing members keeps a confirmed family definition stable", () => {
  const q1 = question("stable-family-q1", "已确认的原型题");
  const q2 = question("stable-family-q2", "新加入、尚待适配审核的题目");
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "stable-family",
    bookId: q1.bookId,
    name: "定义保持稳定的题族",
    knowledgeNodeId: "stable-node",
    status: "confirmed",
    reviewedAt: 100,
    reviewedBy: "教研员",
    members: [{ questionId: q1.id, isPrimary: true, role: "prototype" }],
  }] });

  const added = store.addMembers("stable-family", [q2], "审核员");
  assert.equal(added.family.status, "confirmed");
  assert.deepEqual(added.family.members.map((member) => [member.questionId, member.reviewStatus]), [
    [q1.id, "confirmed"],
    [q2.id, "pending_fit"],
  ]);
  assert.equal(store.confirmedForQuestion(q1.id).length, 1);
  assert.deepEqual(store.confirmedForQuestion(q2.id), []);

  const reconfirmed = store.review("stable-family", {
    status: "confirmed",
    members: added.family.members,
  }, "审核员");
  assert.equal(reconfirmed.status, "confirmed");
  assert.equal(reconfirmed.members.find((member) => member.questionId === q1.id).reviewStatus, "confirmed");
  assert.equal(reconfirmed.members.find((member) => member.questionId === q2.id).reviewStatus, "pending_fit");

  const removed = store.removeMember("stable-family", q2.id, "审核员");
  assert.equal(removed.family.status, "confirmed");
  assert.deepEqual(removed.family.members.map((member) => [member.questionId, member.reviewStatus]), [
    [q1.id, "confirmed"],
  ]);
});

test("removing a prototype only reopens the promoted member relationship", () => {
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "prototype-removal-family",
    bookId: "modern-chinese-7-1",
    name: "原型题调整题族",
    knowledgeNodeId: "prototype-node",
    status: "confirmed",
    members: [
      { questionId: "prototype-removal-q1", isPrimary: true, role: "prototype" },
      { questionId: "prototype-removal-q2", isPrimary: true, role: "similar" },
      { questionId: "prototype-removal-q3", isPrimary: true, role: "variant" },
    ],
  }] });

  const removed = store.removeMember("prototype-removal-family", "prototype-removal-q1", "审核员");

  assert.equal(removed.family.status, "confirmed");
  assert.equal(removed.family.members.find((member) => member.questionId === "prototype-removal-q2").role, "prototype");
  assert.equal(removed.family.members.find((member) => member.questionId === "prototype-removal-q2").reviewStatus, "pending_fit");
  assert.equal(removed.family.members.find((member) => member.questionId === "prototype-removal-q3").reviewStatus, "confirmed");
});

test("modern Chinese questions form auditable families without forcing singletons", () => {
  const questions = [
    question("q1", "从发音方法来说，声母 b 是（ ）。"),
    question("q2", "从发音方法看，普通话声母 x 属于（ ）。"),
    question("q3", "分析材料中声母的发音方法。", { type: "material_analysis", typeLabel: "材料分析题", options: [], correctAnswer: [] }),
    question("q4", "完全无关且没有同伴的题目", { primaryKnowledgePoint: "孤立知识点", knowledgePoints: ["孤立知识点"], subKnowledgePoints: [] }),
  ];
  const result = buildFamilyCandidates(questions);
  assert.equal(result.families.length, 1);
  assert.equal(result.families[0].name, "声母发音方法·阻碍方式");
  assert.equal(result.families[0].status, "pending_review");
  assert.equal(result.families[0].members.filter((member) => member.role === "prototype").length, 1);
  assert.equal(result.families[0].members.every((member) => member.action === "分类判断"), true);
  assert.deepEqual(result.unresolvedQuestionIds, ["q4", "q3"]);
});

test("legacy unresolved indexes migrate to state V6 with confirmed member reviews", () => {
  const bookId = "modern-chinese-7-1";
  const groupedQuestionIds = Array.from({ length: 99 }, (_, index) => `grouped-${index + 1}`);
  const legacyState = {
    version: 3,
    families: [{
      id: "family-confirmed",
      subjectId: "modern-chinese",
      bookId,
      name: "已确认题族",
      knowledgeNodeId: "node-confirmed",
      coreKnowledgeNodeId: "node-confirmed",
      textbookAnchorNodeIds: ["node-confirmed"],
      focusKey: "已确认题族",
      status: "confirmed",
      members: groupedQuestionIds.map((questionId, index) => ({
        questionId,
        isPrimary: true,
        role: index === 0 ? "prototype" : "similar",
        trainingLevel: "foundation",
      })),
      createdAt: 100,
      updatedAt: 200,
    }],
    familySets: [{
      id: "set-confirmed",
      subjectId: "modern-chinese",
      bookId,
      knowledgeNodeId: "node-confirmed",
      name: "已确认题族集",
      createdAt: 100,
      updatedAt: 200,
    }],
    familySetLinks: [{
      id: "link-confirmed",
      setId: "set-confirmed",
      memberType: "family",
      memberId: "family-confirmed",
      createdAt: 100,
    }],
    unresolvedByBook: {
      [bookId]: [...groupedQuestionIds, "offline-merged-source"],
    },
    generatedAtByBook: { [bookId]: 300 },
    historyByBook: { [bookId]: [{ reason: "historic-review" }] },
    membershipRevisionByQuestion: { "grouped-1": 7 },
  };
  const expected = createMemoryQuestionFamilyStore({
    ...legacyState,
    version: 6,
    unresolvedByBook: {},
  }).exportState();
  const store = createMemoryQuestionFamilyStore(legacyState);

  const migrated = store.exportState();
  assert.equal(migrated.version, 6);
  assert.deepEqual(migrated.unresolvedByBook, {});
  assert.equal(migrated.families[0].members.every((member) => member.reviewStatus === "confirmed"), true);
  assert.deepEqual(migrated, expected);

  const once = store.replaceState(migrated);
  const twice = store.replaceState(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(twice.unresolvedByBook, {});
});

test("family generation reports unresolved questions without persisting a second index", () => {
  const store = createMemoryQuestionFamilyStore({
    version: 3,
    families: [],
    unresolvedByBook: { "modern-chinese-7-1": ["stale-question"] },
  });
  const questions = [
    question("generated-q1", "从发音方法来说，声母 b 是（ ）。"),
    question("generated-q2", "从发音方法看，普通话声母 x 属于（ ）。"),
    question("generated-singleton", "完全无关且没有同伴的题目", {
      primaryKnowledgePoint: "孤立知识点",
      knowledgePoints: ["孤立知识点"],
      subKnowledgePoints: [],
    }),
  ];

  const generated = store.generate(questions);

  assert.equal(generated.groupedQuestionCount, 2);
  assert.equal(generated.unresolvedQuestionCount, 1);
  assert.deepEqual(store.exportState().unresolvedByBook, {});
});

test("consonant articulation families distinguish obstruction, voicing, airflow and combined judgments", () => {
  assert.equal(inferFocus(question("method", "从发音方法来说，声母 b 是（ ）。")).key, "声母发音方法·阻碍方式");
  assert.equal(inferFocus(question("voice", "普通话声母中的浊音声母有（ ）。")).key, "声母发音方法·声带振动");
  assert.equal(inferFocus(question("voice-order", "两个音节的声母按前清音后浊音顺序排列的是（ ）。")).key, "声母发音方法·声带振动");
  assert.equal(inferFocus(question("airflow", "普通话中，不送气音和送气音的对立出现在（ ）。")).key, "声母发音方法·气流强弱");
  assert.equal(inferFocus(question("combined", "下列辅音声母中属于不送气清塞音的是（ ）。")).key, "声母发音方法·综合判断");
});

test("family regeneration preserves confirmed reviews", () => {
  const questions = [
    question("q1", "从发音方法来说，声母 b 是（ ）。"),
    question("q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ];
  const store = createMemoryQuestionFamilyStore();
  const generated = store.generate(questions);
  const family = generated.families[0];
  store.review(family.id, { status: "confirmed", members: family.members }, "审核员");
  store.generate([...questions, question("q3", "下列声母中，发音方法相同的一组是（ ）。")]);
  const confirmed = store.get(family.id);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.reviewedBy, "审核员");
  assert.equal(confirmed.members.length, 2);
  const history = store.exportState().historyByBook["modern-chinese-7-1"];
  assert.equal(history.length, 1);
  assert.equal(history[0].families[0].status, "confirmed");
  assert.equal(history[0].reason, "regenerated");
});

test("family regeneration reopens a confirmed definition when its textbook anchor changes", () => {
  const questions = [
    question("anchor-q1", "从发音方法来说，声母 b 是（ ）。"),
    question("anchor-q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ];
  const fingerprints = questions.map((item) => ({
    questionId: item.id,
    primaryNodeId: "consonant",
    primaryKnowledgePoint: "辅音与声母",
    requiredNodeIds: ["consonant"],
    knowledgePath: "语音 > 辅音与声母",
  }));
  const [generatedFamily] = buildFamilyCandidates(questions, "modern-chinese-7-1", { fingerprints }).families;
  const store = createMemoryQuestionFamilyStore({ families: [{
    ...generatedFamily,
    knowledgeNodeId: "old-anchor",
    textbookAnchorNodeIds: ["old-anchor"],
    status: "confirmed",
    reviewedAt: 10,
    reviewedBy: "审核员",
    members: generatedFamily.members.map((member) => ({ ...member, reviewStatus: "confirmed" })),
  }] });

  store.generate(questions, "modern-chinese-7-1", { fingerprints });

  const regenerated = store.get(generatedFamily.id);
  assert.equal(regenerated.status, "pending_review");
  assert.deepEqual(regenerated.textbookAnchorNodeIds, ["consonant"]);
  assert.equal(regenerated.members.every((member) => member.reviewStatus === "pending_fit"), true);
  assert.equal(regenerated.reviewInvalidationReason, "family_definition_regenerated");
});

test("family regeneration preserves an omitted confirmed member as an audited fact", () => {
  const questions = [
    question("retained-q1", "从发音方法来说，声母 b 是（ ）。"),
    question("retained-q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ];
  const fingerprints = questions.map((item) => ({
    questionId: item.id,
    primaryNodeId: "consonant",
    primaryKnowledgePoint: "辅音与声母",
    requiredNodeIds: ["consonant"],
    knowledgePath: "语音 > 辅音与声母",
  }));
  const source = createMemoryQuestionFamilyStore();
  const generated = source.generate(questions, "modern-chinese-7-1", { fingerprints });
  const confirmed = source.review(generated.families[0].id, {
    status: "confirmed",
    members: generated.families[0].members,
  }, "审核员");
  const store = createMemoryQuestionFamilyStore({ families: [confirmed] });

  store.generate([questions[0]], "modern-chinese-7-1", { fingerprints: [fingerprints[0]] });

  const regenerated = store.get(confirmed.id);
  assert.equal(regenerated.status, "confirmed");
  assert.deepEqual(regenerated.members.map((member) => member.questionId).sort(), ["retained-q1", "retained-q2"]);
  assert.equal(regenerated.members.find((member) => member.questionId === "retained-q2").reviewStatus, "confirmed");
});

test("family regeneration can reset only the family being reassigned", () => {
  const questions = [
    question("q1", "从发音方法来说，声母 b 是（ ）。"),
    question("q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ];
  const store = createMemoryQuestionFamilyStore();
  const generated = store.generate(questions);
  const family = generated.families[0];
  store.review(family.id, { status: "rejected", members: family.members }, "审核员");
  store.generate(questions, "modern-chinese-7-1", { resetReviewFamilyIds: [family.id] });
  const reset = store.get(family.id);
  assert.equal(reset.status, "pending_review");
  assert.equal(reset.reviewedBy, "");
  assert.equal(reset.members.length, 2);
});

test("family review can update only the cleaned reason without changing status or members", () => {
  const questions = [
    question("reason-q1", "从发音方法来说，声母 b 是（ ）。"),
    question("reason-q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ];
  const store = createMemoryQuestionFamilyStore();
  const generated = store.generate(questions);
  const family = generated.families[0];
  const confirmed = store.review(family.id, {
    status: "confirmed",
    members: family.members,
  }, "审核员");
  const originalMembers = confirmed.members;

  const updated = store.review(family.id, {
    reason: `  清理   重复题后的旧计数说明  ${"补".repeat(1100)}  `,
  }, "维护员");

  assert.equal(updated.status, "confirmed");
  assert.deepEqual(updated.members, originalMembers);
  assert.equal(updated.reason.startsWith("清理 重复题后的旧计数说明 补"), true);
  assert.equal(updated.reason.length, 1000);

  const unchanged = store.review(family.id, {}, "维护员");
  assert.equal(unchanged.reason, updated.reason);
  assert.equal(unchanged.status, updated.status);
  assert.deepEqual(unchanged.members, updated.members);
});

test("a single-member family can be confirmed when its member is the sole prototype", () => {
  const store = createMemoryQuestionFamilyStore();
  const family = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "singleton-confirmed-node",
    knowledgePath: "语音 > 单题题族",
    primaryKnowledgePoint: "单题题族",
    name: "单题题族可确认",
    focusKey: "单题题族可确认",
  });
  const added = store.addMembers(family.id, [question("singleton-confirmed-q1", "单题题族的唯一原型题")], "审核员");

  const confirmed = store.review(family.id, {
    status: "confirmed",
    members: added.family.members,
  }, "审核员");

  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.members.length, 1);
  assert.equal(confirmed.members.filter((member) => member.role === "prototype").length, 1);
  assert.equal(confirmed.members[0].reviewStatus, "confirmed");
  assert.equal(confirmed.reviewedBy, "审核员");
});

test("an empty family cannot be confirmed", () => {
  const store = createMemoryQuestionFamilyStore();
  const family = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "empty-confirmation-node",
    knowledgePath: "语音 > 空题族",
    primaryKnowledgePoint: "空题族",
    name: "空题族不可确认",
    focusKey: "空题族不可确认",
  });

  assert.throws(() => store.review(family.id, {
    status: "confirmed",
    members: [],
  }, "审核员"), /question_family_members_required/);
  assert.equal(store.get(family.id).status, "pending_review");
});

test("a single-member family cannot be confirmed without a prototype", () => {
  const store = createMemoryQuestionFamilyStore();
  const family = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "singleton-non-prototype-node",
    knowledgePath: "语音 > 非原型单题题族",
    primaryKnowledgePoint: "非原型单题题族",
    name: "非原型单题题族不可确认",
    focusKey: "非原型单题题族不可确认",
  });
  const added = store.addMembers(family.id, [question("singleton-similar-q1", "被错误标为同类题的单题")], "审核员");
  const nonPrototypeMembers = added.family.members.map((member) => ({ ...member, role: "similar" }));

  assert.throws(() => store.review(family.id, {
    status: "confirmed",
    members: nonPrototypeMembers,
  }, "审核员"), /question_family_prototype_required/);
  assert.equal(store.get(family.id).status, "pending_review");
});

test("manual empty families persist across regeneration and reject duplicates", () => {
  const store = createMemoryQuestionFamilyStore();
  const emptyFamily = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "consonant",
    knowledgePath: "语音 > 辅音与声母",
    primaryKnowledgePoint: "辅音与声母",
    name: "声母辨析待补充",
    focusKey: "声母辨析待补充",
    orderIndex: 2,
  });
  assert.equal(emptyFamily.members.length, 0);
  assert.equal(emptyFamily.status, "pending_review");
  assert.equal(emptyFamily.source, "manual_empty_family");
  assert.throws(() => store.create({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "consonant",
    name: "声母辨析待补充",
  }), /question_family_duplicate/);

  const generated = store.generate([
    question("q1", "从发音方法来说，声母 b 是（ ）。"),
    question("q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ]);
  assert.equal(generated.families.some((family) => family.id === emptyFamily.id && family.members.length === 0), true);
  assert.equal(store.get(emptyFamily.id).source, "manual_empty_family");

  const questions = [
    question("q1", "从发音方法来说，声母 b 是（ ）。"),
    question("q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ];
  const added = store.addMembers(emptyFamily.id, questions, "审核员");
  assert.equal(added.addedCount, 2);
  assert.equal(added.family.source, "manual_family");
  assert.deepEqual(added.family.members.map((member) => member.role), ["prototype", "similar"]);
  store.generate(questions);
  assert.deepEqual(store.get(emptyFamily.id).members.map((member) => member.questionId), ["q1", "q2"]);

  let removed = store.removeMember(emptyFamily.id, "q1", "审核员");
  assert.equal(removed.family.members[0].role, "prototype");
  removed = store.removeMember(emptyFamily.id, "q2", "审核员");
  assert.equal(removed.family.members.length, 0);
  assert.equal(removed.family.source, "manual_empty_family");
});

test("question-family search identifies metadata and member matches and ranks family names first", () => {
  const store = createMemoryQuestionFamilyStore();
  const memberOnlyFamily = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "history-node",
    knowledgePath: "文字 > 字体历史",
    primaryKnowledgePoint: "字体历史",
    name: "历史文字阶段",
    focusKey: "历史文字阶段",
    orderIndex: 1,
  });
  store.addMembers(memberOnlyFamily.id, [question("shape-q", "下列关于汉字形体变化的说法正确的是（ ）。")]);
  const nameFamily = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "shape-node",
    knowledgePath: "第二章 文字 > 汉字形体演变",
    primaryKnowledgePoint: "汉字形体演变",
    name: "汉字形体演变",
    focusKey: "汉字形体演变",
    orderIndex: 99,
  });

  const searched = store.list({
    bookId: "modern-chinese-7-1",
    query: "形体",
    matchingQuestionIds: new Set(["shape-q"]),
  });

  assert.deepEqual(searched.families.map((family) => family.id), [nameFamily.id, memberOnlyFamily.id]);
  assert.deepEqual(searched.families[0].searchMatch, {
    kind: "family_name",
    fields: ["name", "primaryKnowledgePoint", "knowledgePath", "focusKey"],
    metadataFields: ["name", "primaryKnowledgePoint", "knowledgePath", "focusKey"],
    questionIds: [],
    questionCount: 0,
    score: 1000,
  });
  assert.equal(searched.families[1].searchMatch.kind, "member_question");
  assert.deepEqual(searched.families[1].searchMatch.questionIds, ["shape-q"]);
  assert.equal(searched.families[1].searchMatch.questionCount, 1);
  assert.equal(searched.families[1].searchMatch.score, 305);
  assert.equal(Object.hasOwn(store.list({ bookId: "modern-chinese-7-1" }).families[0], "searchMatch"), false);
});

test("batch member moves preserve primary relationships and merge existing target memberships", () => {
  const store = createMemoryQuestionFamilyStore();
  const createFamily = (name, knowledgeNodeId) => store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId,
    knowledgePath: `语音 > ${name}`,
    primaryKnowledgePoint: name,
    name,
    focusKey: name,
  });
  const source = createFamily("来源题族", "source-node");
  const target = createFamily("目标题族", "target-node");
  const other = createFamily("另一主题族", "other-node");
  const q1 = question("move-q1", "需要把主题族关系一起移动的题目");
  const q2 = question("move-q2", "只移动关联题族关系的题目");
  const q3 = question("move-q3", "留在来源题族的题目");
  const q4 = question("move-q4", "目标题族原型题");
  const q5 = question("move-q5", "目标题族同类题");

  store.addMembers(other.id, [q2]);
  store.addMembers(source.id, [q1, q2, q3]);
  store.addMembers(target.id, [q4, q5, q1]);
  store.review(source.id, { status: "confirmed", members: store.get(source.id).members }, "审核员");
  store.review(target.id, { status: "confirmed", members: store.get(target.id).members }, "审核员");
  const revisionsBefore = store.membershipRevisions([q1.id, q2.id]);

  const moved = store.moveMembers(source.id, {
    targetFamilyId: target.id,
    questionIds: [q1.id, q2.id],
  }, [q1, q2], "审核员");

  assert.equal(moved.movedCount, 2);
  assert.equal(moved.mergedCount, 1);
  assert.deepEqual(moved.alreadyInTargetQuestionIds, [q1.id]);
  assert.deepEqual(moved.primaryTransferredQuestionIds, [q1.id]);
  assert.equal(moved.sourceFamily.status, "confirmed");
  assert.equal(moved.targetFamily.status, "confirmed");
  assert.deepEqual(moved.sourceFamily.members.map((member) => [member.questionId, member.role]), [[q3.id, "prototype"]]);
  assert.equal(moved.targetFamily.members.filter((member) => member.questionId === q1.id).length, 1);
  assert.equal(moved.targetFamily.members.filter((member) => member.role === "prototype").length, 1);
  assert.equal(moved.sourceFamily.members[0].reviewStatus, "pending_fit");
  assert.equal(moved.targetFamily.members.find((member) => member.questionId === q1.id).reviewStatus, "pending_fit");
  assert.equal(moved.targetFamily.members.find((member) => member.questionId === q2.id).reviewStatus, "pending_fit");
  assert.equal(moved.targetFamily.members.find((member) => member.questionId === q4.id).reviewStatus, "confirmed");
  const q1Memberships = store.memberships([q1.id], { bookId: q1.bookId, status: "all" })[q1.id];
  const q2Memberships = store.memberships([q2.id], { bookId: q2.bookId, status: "all" })[q2.id];
  assert.equal(q1Memberships.find((membership) => membership.familyId === target.id).isPrimary, true);
  assert.equal(q1Memberships.some((membership) => membership.familyId === source.id), false);
  assert.equal(q2Memberships.find((membership) => membership.familyId === target.id).isPrimary, false);
  assert.equal(q2Memberships.find((membership) => membership.familyId === other.id).isPrimary, true);
  assert.equal(q2Memberships.some((membership) => membership.familyId === source.id), false);
  const revisionsAfter = store.membershipRevisions([q1.id, q2.id]);
  assert.equal(revisionsAfter[q1.id], revisionsBefore[q1.id] + 1);
  assert.equal(revisionsAfter[q2.id], revisionsBefore[q2.id] + 1);
});

test("new-family moves are atomic and keep an emptied source family", () => {
  const store = createMemoryQuestionFamilyStore();
  const source = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "source-node",
    knowledgePath: "语音 > 来源",
    primaryKnowledgePoint: "来源",
    name: "待拆分题族",
    focusKey: "待拆分题族",
  });
  const q1 = question("atomic-q1", "准备移动到新题族的第一题");
  const q2 = question("atomic-q2", "准备移动到新题族的第二题");
  store.addMembers(source.id, [q1, q2]);
  const duplicate = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "duplicate-node",
    knowledgePath: "语音 > 已有",
    primaryKnowledgePoint: "已有",
    name: "已有题族",
    focusKey: "已有题族",
  });
  const beforeFailure = store.exportState();
  assert.throws(() => store.moveMembers(source.id, {
    questionIds: [q1.id],
    targetFamily: {
      bookId: q1.bookId,
      knowledgeNodeId: "duplicate-node",
      knowledgePath: "语音 > 已有",
      primaryKnowledgePoint: "已有",
      name: duplicate.name,
      focusKey: duplicate.focusKey,
    },
  }, [q1], "审核员"), /question_family_duplicate/);
  assert.deepEqual(store.exportState(), beforeFailure);
  assert.throws(() => store.moveMembers(source.id, {
    targetFamilyId: duplicate.id,
    questionIds: [q1.id, "not-in-source"],
  }, [q1, question("not-in-source", "不在来源题族中的题目")], "审核员"), /question_family_member_not_found/);
  assert.deepEqual(store.exportState(), beforeFailure);

  const moved = store.moveMembers(source.id, {
    questionIds: [q1.id, q2.id],
    targetFamily: {
      subjectId: "modern-chinese",
      bookId: q1.bookId,
      knowledgeNodeId: "new-target-node",
      knowledgePath: "语音 > 新目标",
      primaryKnowledgePoint: "新目标",
      name: "新建并移动题族",
      focusKey: "新建并移动题族",
      orderIndex: 3,
    },
  }, [q1, q2], "审核员");
  assert.equal(moved.targetCreated, true);
  assert.equal(moved.sourceFamily.members.length, 0);
  assert.equal(moved.sourceFamily.source, "manual_empty_family");
  assert.deepEqual(moved.targetFamily.members.map((member) => member.questionId), [q1.id, q2.id]);
  assert.equal(moved.targetFamily.members.filter((member) => member.role === "prototype").length, 1);
  assert.equal(store.list({ bookId: q1.bookId, status: "all" }).families.length, 3);
});

test("moving the textbook anchor reopens the family definition and every member fit", () => {
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "family-move",
    bookId: "modern-chinese-7-1",
    name: "韵母四呼",
    focusKey: "韵母四呼",
    knowledgeNodeId: "source",
    knowledgePath: "语音 > 元音与韵母 > 韵母的结构",
    requiredKnowledgeNodeIds: ["source", "dependency"],
    status: "confirmed",
    members: [
      { questionId: "q1", role: "prototype", trainingLevel: "foundation", isPrimary: true },
      { questionId: "q2", role: "variant", trainingLevel: "advanced", isPrimary: true },
    ],
  }] });

  const moved = store.relocate("family-move", {
    knowledgeNodeId: "target",
    knowledgePath: "语音 > 元音与韵母 > 韵母四呼",
    chapter: "语音 > 元音与韵母 > 韵母四呼",
    primaryKnowledgePoint: "韵母四呼",
    knowledgeLevel: 4,
    orderIndex: 12,
  }, "审核员");

  assert.equal(moved.family.id, "family-move");
  assert.equal(moved.family.knowledgeNodeId, "target");
  assert.equal(moved.family.status, "pending_review");
  assert.equal(moved.family.source, "manual_family");
  assert.deepEqual(moved.family.requiredKnowledgeNodeIds, ["dependency", "source"]);
  assert.equal(moved.family.coreKnowledgeNodeId, "source");
  assert.deepEqual(moved.family.textbookAnchorNodeIds, ["target"]);
  assert.deepEqual(moved.family.members.map((member) => [member.questionId, member.role, member.trainingLevel]), [
    ["q1", "prototype", "foundation"],
    ["q2", "variant", "advanced"],
  ]);
  assert.equal(moved.family.members.every((member) => member.reviewStatus === "pending_fit"), true);
});

test("substantive definition edits reopen every member fit even when the new definition is confirmed", () => {
  const family = (id) => ({
    id,
    bookId: "modern-chinese-7-1",
    name: `声母发音方法-${id}`,
    focusKey: `声母发音方法-${id}`,
    knowledgeNodeId: "anchor-node",
    coreKnowledgeNodeId: "old-core",
    requiredKnowledgeNodeIds: ["old-core"],
    textbookAnchorNodeIds: ["anchor-node"],
    assessmentAction: "分类判断",
    status: "confirmed",
    members: [
      { questionId: `${id}-q1`, isPrimary: true, role: "prototype" },
      { questionId: `${id}-q2`, isPrimary: true, role: "similar" },
    ],
  });
  const store = createMemoryQuestionFamilyStore({ families: [
    family("definition-reopened"),
    family("definition-confirmed-atomically"),
    family("definition-cosmetic-only"),
    family("definition-anchor-reopened"),
  ] });

  const reopened = store.review("definition-reopened", {
    coreKnowledgeNodeId: "new-core",
    requiredKnowledgeNodeIds: ["new-core", "new-dependency"],
    assessmentAction: "正误辨析",
  }, "审核员");
  assert.equal(reopened.status, "pending_review");
  assert.equal(reopened.members.every((member) => member.reviewStatus === "pending_fit"), true);

  const atomicallyConfirmed = store.review("definition-confirmed-atomically", {
    status: "confirmed",
    coreKnowledgeNodeId: "new-core",
    requiredKnowledgeNodeIds: ["new-core", "new-dependency"],
    assessmentAction: "正误辨析",
  }, "审核员");
  assert.equal(atomicallyConfirmed.status, "confirmed");
  assert.equal(atomicallyConfirmed.members.every((member) => member.reviewStatus === "pending_fit"), true);

  const anchorReopened = store.review("definition-anchor-reopened", {
    status: "confirmed",
    textbookAnchorNodeIds: ["new-anchor-node"],
  }, "审核员");
  assert.equal(anchorReopened.status, "confirmed");
  assert.deepEqual(anchorReopened.textbookAnchorNodeIds, ["new-anchor-node"]);
  assert.equal(anchorReopened.members.every((member) => member.reviewStatus === "pending_fit"), true);
  assert.deepEqual(store.confirmedForQuestion("definition-anchor-reopened-q1"), []);

  const cosmeticOnly = store.review("definition-cosmetic-only", {
    name: "声母发音方法（人工整理）",
    reason: "补充说明文字，不改变题族语义。",
    orderIndex: 12,
  }, "审核员");
  assert.equal(cosmeticOnly.status, "confirmed");
  assert.equal(cosmeticOnly.members.every((member) => member.reviewStatus === "confirmed"), true);
});

test("deleting a family keeps questions and promotes a remaining primary membership", () => {
  const store = createMemoryQuestionFamilyStore({
    families: [
      {
        id: "family-delete",
        bookId: "modern-chinese-7-1",
        name: "待删除题族",
        knowledgeNodeId: "delete-node",
        status: "confirmed",
        members: [
          { questionId: "q-shared", isPrimary: true, role: "prototype" },
          { questionId: "q-only", isPrimary: true, role: "similar" },
        ],
      },
      {
        id: "family-remaining",
        bookId: "modern-chinese-7-1",
        name: "保留题族",
        knowledgeNodeId: "remaining-node",
        status: "confirmed",
        members: [{ questionId: "q-shared", isPrimary: false, role: "prototype" }],
      },
    ],
  });

  const removed = store.remove("family-delete", "审核员");

  assert.equal(store.get("family-delete"), null);
  assert.equal(store.get("family-remaining").members[0].isPrimary, true);
  assert.equal(store.get("family-remaining").status, "confirmed");
  assert.equal(store.get("family-remaining").members[0].reviewStatus, "pending_fit");
  assert.deepEqual(store.confirmedForQuestion("q-shared"), []);
  assert.deepEqual(removed.removedQuestionIds, ["q-shared", "q-only"]);
  assert.deepEqual(removed.ungroupedQuestionIds, ["q-only"]);
  assert.deepEqual(removed.promotedPrimaryQuestionIds, ["q-shared"]);
  assert.deepEqual(store.exportState().unresolvedByBook, {});
  assert.throws(() => store.remove("family-delete"), /question_family_not_found/);
});

test("detaching deleted questions removes ghost members and suspends a promoted prototype", () => {
  const store = createMemoryQuestionFamilyStore({ families: [
    {
      id: "family-with-replacement",
      bookId: "modern-chinese-7-1",
      name: "有替补成员的题族",
      knowledgeNodeId: "node-a",
      status: "confirmed",
      members: [
        { questionId: "q-delete", isPrimary: true, role: "prototype" },
        { questionId: "q-keep", isPrimary: true, role: "similar" },
      ],
    },
    {
      id: "family-becomes-empty",
      bookId: "modern-chinese-7-1",
      name: "删除后为空的题族",
      knowledgeNodeId: "node-b",
      status: "confirmed",
      members: [{ questionId: "q-delete", isPrimary: false, role: "prototype" }],
    },
  ] });
  const revisionsBefore = store.membershipRevisions(["q-delete", "q-keep"]);

  const detached = store.detachQuestions(["q-delete"], "question_deleted", "审核员");

  assert.deepEqual(detached.affectedFamilyIds, ["family-with-replacement", "family-becomes-empty"]);
  assert.deepEqual(detached.emptiedFamilyIds, ["family-becomes-empty"]);
  assert.deepEqual(detached.promotedPrototypeMembers, [{ familyId: "family-with-replacement", questionId: "q-keep" }]);
  const replacement = store.get("family-with-replacement");
  assert.equal(replacement.status, "confirmed");
  assert.equal(replacement.members.length, 1);
  assert.equal(replacement.members[0].questionId, "q-keep");
  assert.equal(replacement.members[0].role, "prototype");
  assert.equal(replacement.members[0].reviewStatus, "pending_fit");
  const empty = store.get("family-becomes-empty");
  assert.equal(empty.status, "confirmed");
  assert.equal(empty.source, "manual_empty_family");
  assert.deepEqual(empty.members, []);
  assert.deepEqual(store.confirmedForQuestion("q-delete"), []);
  assert.deepEqual(store.confirmedForQuestion("q-keep"), []);
  const revisionsAfter = store.membershipRevisions(["q-delete", "q-keep"]);
  assert.equal(revisionsAfter["q-delete"], revisionsBefore["q-delete"] + 1);
  assert.equal(revisionsAfter["q-keep"], revisionsBefore["q-keep"] + 1);
});

test("batch deletion atomically detaches family members and reports prototype suspension", async (context) => {
  const qDelete = question("api-delete-q", "删除后不应残留题族关系（ ）。");
  const qKeep = question("api-keep-q", "保留成员需要重新确认原型适配（ ）。");
  const questionStore = createMemoryQuestionStore([qDelete, qKeep]);
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [{
    id: "api-delete-family",
    bookId: qDelete.bookId,
    name: "批量删除同步题族",
    knowledgeNodeId: "api-delete-node",
    status: "confirmed",
    members: [
      { questionId: qDelete.id, isPrimary: true, role: "prototype" },
      { questionId: qKeep.id, isPrimary: true, role: "similar" },
    ],
  }] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/questions/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [qDelete.id] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.affectedFamilyIds, ["api-delete-family"]);
  assert.deepEqual(payload.promotedPrototypeMembers, [{ familyId: "api-delete-family", questionId: qKeep.id }]);
  assert.equal(questionStore.get(qDelete.id), null);
  const family = questionFamilyStore.get("api-delete-family");
  assert.equal(family.status, "confirmed");
  assert.equal(family.members.length, 1);
  assert.equal(family.members[0].role, "prototype");
  assert.equal(family.members[0].reviewStatus, "pending_fit");
  assert.deepEqual(questionFamilyStore.confirmedForQuestion(qKeep.id), []);
});

test("batch status transitions reopen only the transitioned member fits", async (context) => {
  const q1 = question("api-offline-q1", "整组下架需要失效本题关系（ ）。");
  const q2 = question("api-offline-q2", "同族未下架题保持原关系（ ）。");
  const questionStore = createMemoryQuestionStore([q1, q2]);
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [{
    id: "api-offline-family",
    bookId: q1.bookId,
    name: "批量状态同步题族",
    knowledgeNodeId: "api-offline-node",
    status: "confirmed",
    members: [
      { questionId: q1.id, isPrimary: true, role: "similar" },
      { questionId: q2.id, isPrimary: true, role: "prototype" },
    ],
  }] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/questions/batch-transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [q1.id], action: "offline" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.affectedFamilyIds, ["api-offline-family"]);
  const family = questionFamilyStore.get("api-offline-family");
  assert.equal(family.status, "confirmed");
  assert.equal(family.members.find((member) => member.questionId === q1.id).reviewStatus, "pending_fit");
  assert.equal(family.members.find((member) => member.questionId === q2.id).reviewStatus, "confirmed");
});

test("question edits invalidate scoring changes and detach memberships on textbook moves", async (context) => {
  const scoringQuestion = question("api-scoring-q", "请说明辅音发音方法。", {
    type: "short_answer",
    typeLabel: "简答题",
    options: [],
    correctAnswer: [],
    referenceAnswer: "说明阻碍方式。",
    maxScore: 2,
    scoringPoints: [{ description: "指出阻碍方式", score: 2 }],
  });
  const movedQuestion = question("api-book-move-q", "教材迁移后旧题族关系应移除（ ）。");
  const questionStore = createMemoryQuestionStore([scoringQuestion, movedQuestion]);
  const imported = questionStore.importMany([question("api-batch-move-q", "批次迁移后旧题族关系应移除（ ）。")]);
  const batchQuestion = imported.created[0];
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [
    {
      id: "api-scoring-family",
      bookId: scoringQuestion.bookId,
      name: "得分点敏感题族",
      knowledgeNodeId: "api-scoring-node",
      status: "confirmed",
      members: [{ questionId: scoringQuestion.id, isPrimary: true, role: "prototype" }],
    },
    {
      id: "api-book-move-family",
      bookId: movedQuestion.bookId,
      name: "教材迁移题族",
      knowledgeNodeId: "api-book-move-node",
      status: "confirmed",
      members: [{ questionId: movedQuestion.id, isPrimary: true, role: "prototype" }],
    },
    {
      id: "api-batch-move-family",
      bookId: batchQuestion.bookId,
      name: "批次教材迁移题族",
      knowledgeNodeId: "api-batch-move-node",
      status: "confirmed",
      members: [{ questionId: batchQuestion.id, isPrimary: true, role: "prototype" }],
    },
  ] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const scoringResponse = await fetch(`${baseUrl}/api/admin/questions/${scoringQuestion.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scoringPoints: [{ description: "完整指出阻碍方式", score: 2 }],
      changeNote: "修正得分点",
    }),
  });
  const scoringPayload = await scoringResponse.json();
  assert.equal(scoringResponse.status, 200, JSON.stringify(scoringPayload));
  assert.deepEqual(scoringPayload.affectedFamilyIds, ["api-scoring-family"]);
  assert.equal(questionFamilyStore.get("api-scoring-family").members[0].reviewStatus, "pending_fit");

  const moveResponse = await fetch(`${baseUrl}/api/admin/questions/${movedQuestion.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "modern-chinese-7-2", changeNote: "迁移教材" }),
  });
  const movePayload = await moveResponse.json();
  assert.equal(moveResponse.status, 200, JSON.stringify(movePayload));
  assert.equal(movePayload.question.bookId, "modern-chinese-7-2");
  assert.deepEqual(movePayload.affectedFamilyIds, ["api-book-move-family"]);
  assert.deepEqual(questionFamilyStore.get("api-book-move-family").members, []);

  const batchResponse = await fetch(`${baseUrl}/api/admin/questions/import-batches/${encodeURIComponent(imported.batchId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subjectId: "contemporary-literature",
      bookId: "contemporary-literature-history-3",
    }),
  });
  const batchPayload = await batchResponse.json();
  assert.equal(batchResponse.status, 200, JSON.stringify(batchPayload));
  assert.deepEqual(batchPayload.affectedFamilyIds, ["api-batch-move-family"]);
  assert.deepEqual(batchPayload.detachedQuestionIds, [batchQuestion.id]);
  assert.deepEqual(questionFamilyStore.get("api-batch-move-family").members, []);
});

test("family regeneration only reopens explicitly reset question memberships", () => {
  const questions = [
    question("q1", "声母 b 的发音方法是什么？"),
    question("q2", "声母 p 的发音方法是什么？"),
  ];
  const fingerprints = questions.map((item) => ({
    questionId: item.id,
    primaryNodeId: "consonant",
    primaryKnowledgePoint: "辅音与声母",
    requiredNodeIds: ["consonant"],
    knowledgePath: "语音 > 辅音与声母",
  }));
  const store = createMemoryQuestionFamilyStore();
  const generated = store.generate(questions, "modern-chinese-7-1", { fingerprints });
  const family = generated.families[0];
  store.review(family.id, { status: "confirmed", members: family.members }, "审核员");

  store.generate(questions, "modern-chinese-7-1", {
    fingerprints,
    resetReviewQuestionIds: ["q1"],
  });

  const reset = store.get(family.id);
  assert.equal(reset.status, "confirmed");
  assert.equal(reset.reviewedBy, "审核员");
  assert.equal(reset.members.find((member) => member.questionId === "q1").reviewStatus, "pending_fit");
  assert.equal(reset.members.find((member) => member.questionId === "q2").reviewStatus, "confirmed");
});

test("question-family store returns every family membership for one question", () => {
  const store = createMemoryQuestionFamilyStore({
    families: [
      { id: "family-main", bookId: "modern-chinese-7-1", name: "主问题族", knowledgeNodeId: "node-main", knowledgePath: "语音 > 音节", status: "confirmed", members: [{ questionId: "q1", role: "prototype", trainingLevel: "advanced" }] },
      { id: "family-bridge", bookId: "modern-chinese-7-1", name: "跨知识题族", knowledgeNodeId: "node-bridge", knowledgePath: "词汇 > 词汇单位", status: "pending_review", members: [{ questionId: "q1", role: "variant", trainingLevel: "transfer" }] },
    ],
  });
  const result = store.memberships(["q1"]);
  assert.deepEqual(result.q1.map((item) => item.familyId), ["family-main", "family-bridge"]);
  assert.deepEqual(result.q1.map((item) => item.role), ["prototype", "variant"]);
  assert.deepEqual(result.q1.map((item) => item.isPrimary), [true, false]);
  assert.deepEqual(result.q1.map((item) => item.reviewStatus), ["confirmed", "pending_fit"]);
});

test("question membership editing keeps one primary family and ignores dependency nodes for directory placement", () => {
  const store = createMemoryQuestionFamilyStore({
    families: [
      {
        id: "family-main",
        bookId: "modern-chinese-7-1",
        name: "主问题族",
        knowledgeNodeId: "node-main",
        knowledgePath: "语音 > 音节",
        requiredKnowledgeNodeIds: ["node-main", "node-dependency"],
        status: "confirmed",
        members: [{ questionId: "q1", role: "prototype", trainingLevel: "foundation" }],
      },
      {
        id: "family-bridge",
        bookId: "modern-chinese-7-1",
        name: "跨知识题族",
        knowledgeNodeId: "node-bridge",
        knowledgePath: "词汇 > 词汇单位",
        status: "confirmed",
        members: [],
      },
    ],
  });

  assert.equal(store.list({ knowledgeNodeIds: new Set(["node-dependency"]) }).families.length, 0);
  const changed = store.setMemberships(question("q1", "一道跨知识题目（ ）。"), [
    { familyId: "family-main", isPrimary: false },
    { familyId: "family-bridge", isPrimary: true },
  ]);
  assert.deepEqual(changed.memberships.map((item) => [item.familyId, item.isPrimary]), [
    ["family-bridge", true],
    ["family-main", false],
  ]);
  assert.equal(store.get("family-main").status, "confirmed");
  assert.equal(store.get("family-bridge").status, "confirmed");
  assert.equal(store.get("family-main").members.find((member) => member.questionId === "q1").reviewStatus, "pending_fit");
  assert.equal(store.get("family-bridge").members.find((member) => member.questionId === "q1").reviewStatus, "pending_fit");
  assert.throws(() => store.setMemberships(question("q1", "一道跨知识题目（ ）。"), [
    { familyId: "family-main", isPrimary: false },
    { familyId: "family-bridge", isPrimary: false },
  ]), /question_family_primary_required/);
});

test("question edits invalidate only the affected member fit inside confirmed families", () => {
  const store = createMemoryQuestionFamilyStore({
    families: [
      { id: "family-main", bookId: "modern-chinese-7-1", name: "主问题族", knowledgeNodeId: "node-main", knowledgePath: "语音 > 音节", status: "confirmed", reviewedAt: Date.now(), reviewedBy: "教研员", members: [{ questionId: "q1", role: "prototype", trainingLevel: "advanced" }, { questionId: "q3", role: "similar", trainingLevel: "advanced" }] },
      { id: "family-other", bookId: "modern-chinese-7-1", name: "无关题族", knowledgeNodeId: "node-other", knowledgePath: "词汇", status: "confirmed", members: [{ questionId: "q2", role: "prototype", trainingLevel: "foundation" }] },
    ],
  });
  const result = store.markPendingForQuestions(["q1"], "question_content_updated", "超级管理员");
  assert.deepEqual(result.affectedFamilyIds, ["family-main"]);
  assert.equal(store.get("family-main").status, "confirmed");
  assert.equal(store.get("family-main").members.find((member) => member.questionId === "q1").reviewStatus, "pending_fit");
  assert.equal(store.get("family-main").members.find((member) => member.questionId === "q3").reviewStatus, "confirmed");
  assert.equal(store.get("family-other").status, "confirmed");
  assert.equal(store.get("family-other").members[0].reviewStatus, "confirmed");
  assert.deepEqual(store.confirmedForQuestion("q1"), []);
  assert.deepEqual(store.confirmedForQuestion("q3"), []);

  const revision = store.memberships(["q1"], { status: "all" }).q1[0].membershipRevision;
  store.reviewMember("family-main", "q1", {
    status: "confirmed",
    expectedRevision: revision,
  }, "复核员");
  assert.equal(store.confirmedForQuestion("q1").length, 1);
  assert.equal(store.confirmedForQuestion("q3").length, 1);
});

test("member review API confirms or rejects one relationship with revision guards", async (context) => {
  const q1 = question("member-review-q1", "声母 b 从阻碍方式看属于哪一类？");
  const q2 = question("member-review-q2", "声母 d 从阻碍方式看属于哪一类？");
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [{
    id: "member-review-family",
    bookId: q1.bookId,
    name: "辅音阻碍方式",
    knowledgeNodeId: "member-review-node",
    status: "confirmed",
    members: [
      { questionId: q1.id, isPrimary: true, role: "prototype", reviewStatus: "pending_fit" },
      { questionId: q2.id, isPrimary: true, role: "similar", reviewStatus: "confirmed" },
    ],
  }] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore: createMemoryQuestionStore([q1, q2]),
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const q1Revision = questionFamilyStore.membershipRevisions([q1.id])[q1.id];

  const confirmedResponse = await fetch(`${baseUrl}/api/admin/question-families/member-review-family/members/${q1.id}/review`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "confirmed", expectedRevision: q1Revision }),
  });
  const confirmed = await confirmedResponse.json();
  assert.equal(confirmedResponse.status, 200, JSON.stringify(confirmed));
  assert.equal(confirmed.member.reviewStatus, "confirmed");
  assert.equal(confirmed.membershipRevision, q1Revision + 1);
  assert.match(confirmed.formalFactSha256, /^[a-f0-9]{64}$/);
  assert.equal(questionFamilyStore.confirmedForQuestion(q2.id).length, 1);

  const staleResponse = await fetch(`${baseUrl}/api/admin/question-families/member-review-family/members/${q1.id}/review`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "rejected", expectedRevision: q1Revision }),
  });
  const stale = await staleResponse.json();
  assert.equal(staleResponse.status, 409);
  assert.equal(stale.error, "question_family_membership_revision_conflict");

  const q2Revision = questionFamilyStore.membershipRevisions([q2.id])[q2.id];
  const rejectedResponse = await fetch(`${baseUrl}/api/admin/question-families/member-review-family/members/${q2.id}/review`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "rejected", expectedRevision: q2Revision, note: "不属于本题族" }),
  });
  const rejected = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 200, JSON.stringify(rejected));
  assert.equal(rejected.removed, true);
  assert.equal(questionFamilyStore.memberships([q2.id], { status: "all" })[q2.id].length, 0);
});

test("family range anchors stay separate from coverage knowledge and member contributions", () => {
  const q1 = question("family-contribution-q1", "判断单纯词。");
  const store = createMemoryQuestionFamilyStore();
  const created = store.create({
    bookId: q1.bookId,
    knowledgeNodeId: "node-textbook-anchor",
    coreKnowledgeNodeId: "node-range-anchor",
    requiredKnowledgeNodeIds: ["node-single-word", "node-compound-word"],
    name: "单纯词与合成词辨析",
  });
  assert.equal(created.coreKnowledgeNodeId, "node-range-anchor");
  assert.deepEqual(created.requiredKnowledgeNodeIds, ["node-compound-word", "node-single-word"]);
  assert.equal(created.requiredKnowledgeNodeIds.includes(created.coreKnowledgeNodeId), false);

  const added = store.addMembers(created.id, [q1], "审核员", {
    contributionKnowledgeNodeIdsByQuestion: { [q1.id]: ["node-single-word"] },
  });
  assert.deepEqual(added.family.members[0].contributionKnowledgeNodeIds, ["node-single-word"]);
  const revision = store.membershipRevisions([q1.id])[q1.id];
  const reviewed = store.reviewMember(created.id, q1.id, {
    status: "confirmed",
    expectedRevision: revision,
    contributionKnowledgeNodeIds: ["node-compound-word"],
  }, "复核员");
  assert.deepEqual(reviewed.member.contributionKnowledgeNodeIds, ["node-compound-word"]);
  assert.throws(() => store.reviewMember(created.id, q1.id, {
    status: "confirmed",
    expectedRevision: reviewed.membershipRevision,
    contributionKnowledgeNodeIds: ["node-outside-family-coverage"],
  }), /question_family_member_contribution_invalid/);
});

test("editing a member contribution reopens only that relationship", () => {
  const q1 = question("family-contribution-edit-q1", "判断单纯词。");
  const q2 = question("family-contribution-edit-q2", "判断合成词。");
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "family-contribution-edit",
    bookId: q1.bookId,
    name: "单纯词与合成词辨析",
    knowledgeNodeId: "node-textbook-anchor",
    coreKnowledgeNodeId: "node-range-anchor",
    requiredKnowledgeNodeIds: ["node-single-word", "node-compound-word"],
    textbookAnchorNodeIds: ["node-textbook-anchor"],
    status: "confirmed",
    members: [
      {
        questionId: q1.id,
        isPrimary: true,
        role: "prototype",
        reviewStatus: "confirmed",
        contributionKnowledgeNodeIds: ["node-single-word"],
      },
      {
        questionId: q2.id,
        isPrimary: true,
        role: "similar",
        reviewStatus: "confirmed",
        contributionKnowledgeNodeIds: ["node-compound-word"],
      },
    ],
  }] });

  const changed = store.setMemberships(q1, [{
    familyId: "family-contribution-edit",
    isPrimary: true,
    contributionKnowledgeNodeIds: ["node-compound-word"],
  }], "审核员");
  const family = store.get("family-contribution-edit");
  const changedMember = family.members.find((member) => member.questionId === q1.id);
  const untouchedMember = family.members.find((member) => member.questionId === q2.id);

  assert.deepEqual(changed.affectedFamilyIds, ["family-contribution-edit"]);
  assert.equal(family.status, "confirmed");
  assert.deepEqual(changedMember.contributionKnowledgeNodeIds, ["node-compound-word"]);
  assert.equal(changedMember.reviewStatus, "pending_fit");
  assert.equal(untouchedMember.reviewStatus, "confirmed");
});

test("moving a member only opens the moved relationship for fit review", () => {
  const q1 = question("local-move-q1", "来源题族中保持不动的原型题");
  const q2 = question("local-move-q2", "需要移动的同类题");
  const q3 = question("local-move-q3", "目标题族中保持不动的原型题");
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "local-move-source",
    bookId: q1.bookId,
    name: "来源题族",
    knowledgeNodeId: "source-node",
    status: "confirmed",
    members: [
      { questionId: q1.id, isPrimary: true, role: "prototype" },
      { questionId: q2.id, isPrimary: true, role: "similar" },
    ],
  }, {
    id: "local-move-target",
    bookId: q1.bookId,
    name: "目标题族",
    knowledgeNodeId: "target-node",
    status: "confirmed",
    members: [{ questionId: q3.id, isPrimary: true, role: "prototype" }],
  }] });

  const moved = store.moveMembers("local-move-source", {
    targetFamilyId: "local-move-target",
    questionIds: [q2.id],
  }, [q2], "审核员");

  assert.equal(moved.sourceFamily.status, "confirmed");
  assert.equal(moved.targetFamily.status, "confirmed");
  assert.equal(moved.sourceFamily.members.find((member) => member.questionId === q1.id).reviewStatus, "confirmed");
  assert.equal(moved.targetFamily.members.find((member) => member.questionId === q3.id).reviewStatus, "confirmed");
  assert.equal(moved.targetFamily.members.find((member) => member.questionId === q2.id).reviewStatus, "pending_fit");
  assert.deepEqual(store.confirmedForQuestion(q2.id), []);
});

test("editing memberships keeps family definitions confirmed and reviews only changed relations", () => {
  const q1 = question("membership-edit-q1", "需要增加副题族归属的题目");
  const q2 = question("membership-edit-q2", "副题族中已确认的原型题");
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "membership-main",
    bookId: q1.bookId,
    name: "主问题族",
    knowledgeNodeId: "main-node",
    status: "confirmed",
    members: [{ questionId: q1.id, isPrimary: true, role: "prototype" }],
  }, {
    id: "membership-related",
    bookId: q1.bookId,
    name: "副题族",
    knowledgeNodeId: "related-node",
    status: "confirmed",
    members: [{ questionId: q2.id, isPrimary: true, role: "prototype" }],
  }] });

  const changed = store.setMemberships(q1, [
    { familyId: "membership-main", isPrimary: true },
    { familyId: "membership-related", isPrimary: false },
  ], "审核员");

  assert.deepEqual(changed.affectedFamilyIds, ["membership-related"]);
  assert.equal(store.get("membership-main").status, "confirmed");
  assert.equal(store.get("membership-related").status, "confirmed");
  assert.equal(store.get("membership-main").members[0].reviewStatus, "confirmed");
  assert.equal(store.get("membership-related").members.find((member) => member.questionId === q2.id).reviewStatus, "confirmed");
  assert.equal(store.get("membership-related").members.find((member) => member.questionId === q1.id).reviewStatus, "pending_fit");
  assert.equal(store.confirmedForQuestion(q1.id).length, 1);
});

test("a confirmed singleton stays defined but is unavailable while its only member awaits fit review", () => {
  const store = createMemoryQuestionFamilyStore({ families: [{
    id: "confirmed-singleton",
    bookId: "modern-chinese-7-1",
    name: "已确认的单题题族",
    knowledgeNodeId: "singleton-node",
    status: "confirmed",
    members: [{ questionId: "singleton-q", isPrimary: true, role: "prototype" }],
  }] });

  store.markPendingForQuestions(["singleton-q"], "question_content_updated", "审核员");

  const family = store.get("confirmed-singleton");
  assert.equal(family.status, "confirmed");
  assert.equal(family.members[0].reviewStatus, "pending_fit");
  assert.deepEqual(store.confirmedForQuestion("singleton-q"), []);
  assert.equal(store.list({ bookId: "modern-chinese-7-1", status: "confirmed" }).families.length, 1);
});

test("families follow knowledge-tree order", () => {
  const questions = [
    question("q1", "从发音方法来说，声母 b 是（ ）。"),
    question("q2", "从发音方法看，普通话声母 x 属于（ ）。"),
    question("q3", "粤方言以哪里为代表（ ）。", { primaryKnowledgePoint: "现代汉语方言" }),
    question("q4", "客家方言以哪里为代表（ ）。", { primaryKnowledgePoint: "现代汉语方言" }),
  ];
  const fingerprints = [
    { questionId: "q1", primaryNodeId: "consonant", primaryKnowledgePoint: "辅音与声母", requiredNodeIds: ["consonant"], knowledgePath: "语音 > 辅音与声母" },
    { questionId: "q2", primaryNodeId: "consonant", primaryKnowledgePoint: "辅音与声母", requiredNodeIds: ["consonant"], knowledgePath: "语音 > 辅音与声母" },
    { questionId: "q3", primaryNodeId: "dialect", primaryKnowledgePoint: "现代汉语方言", requiredNodeIds: ["dialect"], knowledgePath: "绪论 > 现代汉语方言" },
    { questionId: "q4", primaryNodeId: "dialect", primaryKnowledgePoint: "现代汉语方言", requiredNodeIds: ["dialect"], knowledgePath: "绪论 > 现代汉语方言" },
  ];
  const result = buildFamilyCandidates(questions, "modern-chinese-7-1", {
    fingerprints,
    nodeOrder: new Map([["dialect", 1], ["consonant", 2]]),
  });
  assert.deepEqual(result.families.map((family) => family.knowledgeNodeId), ["dialect", "consonant"]);
});

test("admin question-family API generates and confirms a family", async (context) => {
  const questions = [
    question("q1", "从发音方法来说，声母 b 是（ ）。"),
    question("q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ];
  const questionStore = createMemoryQuestionStore(questions);
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "chapter-phonetics", level: 1, title: "第二章 语音", startPage: 1, endPage: 20 },
      { id: "section-consonant", level: 2, title: "第三节 辅音与声母", startPage: 2, endPage: 20 },
      { id: "knowledge-consonant-method", level: 3, title: "辅音与声母", startPage: 3, endPage: 20 },
    ],
    outlineNodes: [],
    chunks: [],
    questions,
  });
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore,
    questionFamilyStore,
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const generated = await fetch(`${baseUrl}/api/admin/question-families/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "modern-chinese-7-1" }),
  }).then((response) => response.json());
  assert.equal(generated.success, true);
  assert.equal(generated.familyCount, 1);
  const listing = await fetch(`${baseUrl}/api/admin/question-families?bookId=modern-chinese-7-1`).then((response) => response.json());
  assert.equal(listing.families[0].members[0].question.stem.length > 0, true);
  assert.deepEqual(listing.families[0].members[0].question.options, [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }]);
  const family = listing.families[0];
  const confirmed = await fetch(`${baseUrl}/api/admin/question-families/${family.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "confirmed", name: family.name, members: family.members }),
  }).then((response) => response.json());
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
  assert.equal(confirmed.family.status, "confirmed");
  assert.equal(confirmed.family.inclusionBoundary, "");
  assert.equal(confirmed.family.exclusionBoundary, "");
  const questionDetail = await fetch(`${baseUrl}/api/admin/questions/q1`).then((response) => response.json());
  assert.equal(questionDetail.question.familyMemberships.length, 1);
  assert.equal(questionDetail.question.familyMemberships[0].familyId, family.id);
  const searched = await fetch(`${baseUrl}/api/admin/question-families?bookId=modern-chinese-7-1&query=${encodeURIComponent("擦音")}`).then((response) => response.json());
  assert.equal(searched.families.length, 1);
  assert.equal(searched.families[0].matchedQuestions.length, 2);
  assert.equal(searched.families[0].matchedQuestions[0].options.length, 2);
  assert.equal(searched.families[0].searchMatch.kind, "member_question");
  assert.equal(searched.families[0].searchMatch.questionCount, 2);
  assert.deepEqual(searched.families[0].searchMatch.questionIds, ["q1", "q2"]);
  const familyNameSearch = await fetch(`${baseUrl}/api/admin/question-families?bookId=modern-chinese-7-1&query=${encodeURIComponent(family.name)}`).then((response) => response.json());
  assert.equal(familyNameSearch.families[0].searchMatch.kind, "family_name");
  assert.equal(familyNameSearch.families[0].searchMatch.metadataFields.includes("name"), true);
  assert.equal(familyNameSearch.families[0].matchedQuestions.length, 0);
  const optionSearch = await fetch(`${baseUrl}/api/admin/questions?library=official&bookId=modern-chinese-7-1&query=${encodeURIComponent("擦音")}`).then((response) => response.json());
  assert.equal(optionSearch.questions.length, 2);
});

test("question-family workspace keeps member fingerprints separate from family definitions", async (context) => {
  const q1 = question("member-fingerprint-q1", "这道题保留自己的正式知识指纹。");
  const questionStore = createMemoryQuestionStore([q1]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const catalogNodes = [
    { id: "chapter", level: 1, title: "第一章", startPage: 1, endPage: 20 },
    { id: "section", level: 2, title: "第一节", startPage: 1, endPage: 20 },
    { id: "question-node", level: 3, title: "题目正式知识", startPage: 2, endPage: 10 },
    { id: "family-node", level: 3, title: "题族核心知识", startPage: 11, endPage: 20 },
    { id: "related-node", level: 3, title: "关联题族知识", startPage: 11, endPage: 20 },
  ];
  const structure = knowledgeStructureStore.generate({
    bookId: q1.bookId,
    catalogNodes,
    outlineNodes: [],
    chunks: [],
    questions: [q1],
  });
  knowledgeStructureStore.assignQuestions(q1.bookId, [{
    questionId: q1.id,
    primaryNodeId: "question-node",
    requiredNodeIds: ["question-node", "related-node"],
    source: "manual_review",
  }]);
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft(q1.bookId, catalogNodes);
  textbookCatalogStore.confirm(q1.bookId, "目录审核员");
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [{
    id: "mismatched-family",
    bookId: q1.bookId,
    subjectId: q1.subjectId,
    name: "不同知识的题族",
    knowledgeNodeId: "family-node",
    coreKnowledgeNodeId: "family-node",
    requiredKnowledgeNodeIds: ["family-node"],
    textbookAnchorNodeIds: ["family-node"],
    knowledgePath: structure.nodes.find((node) => node.id === "family-node").path,
    focusKey: "测试",
    status: "confirmed",
    members: [{ questionId: q1.id, isPrimary: true, role: "prototype", trainingLevel: "foundation" }],
  }, {
    id: "compatible-related-family",
    bookId: q1.bookId,
    subjectId: q1.subjectId,
    name: "兼容的关联题族",
    knowledgeNodeId: "related-node",
    coreKnowledgeNodeId: "related-node",
    requiredKnowledgeNodeIds: ["related-node"],
    textbookAnchorNodeIds: ["related-node"],
    knowledgePath: structure.nodes.find((node) => node.id === "related-node").path,
    focusKey: "关联测试",
    status: "confirmed",
    members: [{ questionId: q1.id, isPrimary: false, role: "similar", trainingLevel: "foundation" }],
  }] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore,
    questionFamilyStore,
    textbookCatalogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const listing = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/question-families?bookId=${q1.bookId}`).then((response) => response.json());
  const member = listing.families.find((family) => family.id === "mismatched-family").members[0];
  assert.equal(member.knowledgeNodeId, "question-node");
  assert.deepEqual(member.requiredKnowledgeNodeIds, ["question-node", "related-node"]);
  assert.equal(member.familyKnowledgeMismatch, true);
  assert.equal(member.familyKnowledgeCompatibility.role, "topic");
  assert.equal(member.familyKnowledgeCompatibility.status, "incompatible");
  assert.equal(member.familyKnowledgeCompatibility.overallStatus, "incompatible");
  assert.equal(member.familyKnowledgeCompatibility.fullyIncompatible, true);
  assert.equal(member.familyKnowledgeCompatibility.items.coreKnowledge.status, "mismatch");
  assert.equal(member.familyKnowledgeCompatibility.items.requiredKnowledge.status, "mismatch");
  const relatedMember = listing.families.find((family) => family.id === "compatible-related-family").members[0];
  assert.equal(relatedMember.familyKnowledgeMismatch, false);
  assert.equal(relatedMember.familyKnowledgeCompatibility.role, "related");
  assert.equal(relatedMember.familyKnowledgeCompatibility.status, "compatible");
  assert.equal(relatedMember.familyKnowledgeCompatibility.overallStatus, "compatible");
  assert.equal(listing.catalogTreeSummary.questionCount, 1);
  assert.equal(listing.catalogTreeSummary.nodeQuestionCounts["family-node"], 1);
  assert.equal(listing.catalogTreeSummary.nodeQuestionCounts.section, 1);
  assert.equal(listing.catalogTreeSummary.nodeQuestionCounts.chapter, 1);
});

test("question-family compatibility uses member contributions for scope anchors and core nodes", async (context) => {
  const scopeQuestion = question("scope-anchor-family-q", "需要两个下位知识才能完成的跨知识题。");
  const coreQuestion = question("core-family-q", "直接考查核心知识的题。");
  const questions = [scopeQuestion, coreQuestion];
  const questionStore = createMemoryQuestionStore(questions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const catalogNodes = [
    { id: "scope-chapter", level: 1, title: "第一章", startPage: 1, endPage: 20 },
    { id: "scope-section", level: 2, title: "第一节", startPage: 1, endPage: 20 },
    { id: "scope-anchor", level: 3, title: "范围锚点", startPage: 1, endPage: 20 },
    { id: "required-a", level: 4, title: "必需知识A", startPage: 2, endPage: 8 },
    { id: "required-b", level: 4, title: "必需知识B", startPage: 9, endPage: 15 },
    { id: "other-family-anchor", level: 3, title: "题族教材锚点", startPage: 16, endPage: 20 },
  ];
  knowledgeStructureStore.generate({
    bookId: scopeQuestion.bookId,
    catalogNodes,
    outlineNodes: [],
    chunks: [],
    questions,
  });
  knowledgeStructureStore.assignQuestions(scopeQuestion.bookId, [{
    questionId: scopeQuestion.id,
    primaryNodeId: "scope-anchor",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["required-a", "required-b"],
    source: "manual_review",
  }, {
    questionId: coreQuestion.id,
    primaryNodeId: "required-a",
    primaryNodeRole: "core",
    requiredNodeIds: ["required-a", "required-b"],
    source: "manual_review",
  }]);
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft(scopeQuestion.bookId, catalogNodes);
  textbookCatalogStore.confirm(scopeQuestion.bookId, "目录审核员");
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [{
    id: "scope-contribution-family",
    bookId: scopeQuestion.bookId,
    subjectId: scopeQuestion.subjectId,
    name: "范围锚点题的知识贡献",
    knowledgeNodeId: "other-family-anchor",
    coreKnowledgeNodeId: "other-family-anchor",
    requiredKnowledgeNodeIds: ["required-a"],
    textbookAnchorNodeIds: ["other-family-anchor"],
    status: "confirmed",
    members: [{
      questionId: scopeQuestion.id,
      isPrimary: true,
      coverageRole: "required",
      contributionKnowledgeNodeIds: ["required-a"],
      role: "prototype",
      reviewStatus: "confirmed",
    }],
  }, {
    id: "core-missing-contribution-family",
    bookId: coreQuestion.bookId,
    subjectId: coreQuestion.subjectId,
    name: "未承载核心节点的题族",
    knowledgeNodeId: "other-family-anchor",
    coreKnowledgeNodeId: "other-family-anchor",
    requiredKnowledgeNodeIds: ["required-b"],
    textbookAnchorNodeIds: ["other-family-anchor"],
    status: "confirmed",
    members: [{
      questionId: coreQuestion.id,
      isPrimary: true,
      coverageRole: "required",
      contributionKnowledgeNodeIds: ["required-b"],
      role: "prototype",
      reviewStatus: "confirmed",
    }],
  }] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore,
    questionFamilyStore,
    textbookCatalogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const listing = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/question-families?bookId=${scopeQuestion.bookId}`)
    .then((response) => response.json());
  const scopeMember = listing.families.find((family) => family.id === "scope-contribution-family").members[0];
  assert.equal(scopeMember.primaryNodeRole, "scope_anchor");
  assert.deepEqual(scopeMember.requiredKnowledgeNodeIds, ["required-a", "required-b"]);
  assert.equal(scopeMember.familyKnowledgeMismatch, false);
  assert.equal(scopeMember.familyKnowledgeCompatibility.status, "compatible");
  assert.equal(scopeMember.familyKnowledgeCompatibility.usesMemberContribution, true);
  assert.deepEqual(scopeMember.familyKnowledgeCompatibility.contributionKnowledgeNodeIds, ["required-a"]);
  assert.equal(scopeMember.familyKnowledgeCompatibility.items.coreKnowledge.status, "match");

  const coreMember = listing.families.find((family) => family.id === "core-missing-contribution-family").members[0];
  assert.equal(coreMember.primaryNodeRole, "core");
  assert.equal(coreMember.familyKnowledgeMismatch, true);
  assert.equal(coreMember.familyKnowledgeCompatibility.status, "incompatible");
  assert.equal(coreMember.familyKnowledgeCompatibility.items.coreKnowledge.status, "mismatch");
});

test("question-family members expose confirmed, suggested, and missing fingerprints in separate slots", async (context) => {
  const confirmedQuestion = question("fingerprint-confirmed-q", "已人工确认知识指纹的题目。");
  const suggestedQuestion = question("fingerprint-suggested-q", "只有候选知识指纹的题目。");
  const missingQuestion = question("fingerprint-missing-q", "尚无知识指纹的题目。");
  const questions = [confirmedQuestion, suggestedQuestion, missingQuestion];
  const questionStore = createMemoryQuestionStore(questions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const structure = knowledgeStructureStore.generate({
    bookId: confirmedQuestion.bookId,
    catalogNodes: [
      { id: "tri-state-chapter", level: 1, title: "第一章", startPage: 1, endPage: 20 },
      { id: "tri-state-section", level: 2, title: "第一节", startPage: 1, endPage: 20 },
      { id: "tri-state-question-node", level: 3, title: "题目知识", startPage: 2, endPage: 10 },
      { id: "tri-state-family-node", level: 3, title: "题族知识", startPage: 11, endPage: 20 },
    ],
    outlineNodes: [],
    chunks: [],
    questions,
  });
  knowledgeStructureStore.assignQuestions(confirmedQuestion.bookId, [{
    questionId: confirmedQuestion.id,
    primaryNodeId: "tri-state-question-node",
    requiredNodeIds: ["tri-state-question-node"],
    source: "manual_review",
  }]);
  const structureState = knowledgeStructureStore.exportState();
  const record = structureState.records.find((item) => item.bookId === confirmedQuestion.bookId);
  const questionNode = structure.nodes.find((node) => node.id === "tri-state-question-node");
  record.fingerprints = record.fingerprints
    .filter((fingerprint) => fingerprint.questionId !== missingQuestion.id)
    .map((fingerprint) => fingerprint.questionId === suggestedQuestion.id ? {
      ...fingerprint,
      primaryNodeId: questionNode.id,
      primaryKnowledgePoint: questionNode.displayTitle,
      knowledgePath: questionNode.path,
      requiredNodeIds: [questionNode.id],
      source: "catalog_rule",
      status: "suggested",
    } : fingerprint);
  knowledgeStructureStore.replaceState(structureState);

  const family = (id, questionId) => ({
    id,
    bookId: confirmedQuestion.bookId,
    subjectId: confirmedQuestion.subjectId,
    name: id,
    knowledgeNodeId: "tri-state-family-node",
    coreKnowledgeNodeId: "tri-state-family-node",
    requiredKnowledgeNodeIds: ["tri-state-family-node"],
    textbookAnchorNodeIds: ["tri-state-family-node"],
    focusKey: id,
    status: "confirmed",
    members: [{ questionId, isPrimary: true, role: "prototype", trainingLevel: "foundation" }],
  });
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [
    family("confirmed-fingerprint-family", confirmedQuestion.id),
    family("suggested-fingerprint-family", suggestedQuestion.id),
    family("missing-fingerprint-family", missingQuestion.id),
  ] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore,
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const listing = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/question-families?bookId=${confirmedQuestion.bookId}`)
    .then((response) => response.json());
  const memberByFamilyId = new Map(listing.families.map((item) => [item.id, item.members[0]]));
  const confirmedMember = memberByFamilyId.get("confirmed-fingerprint-family");
  const suggestedMember = memberByFamilyId.get("suggested-fingerprint-family");
  const missingMember = memberByFamilyId.get("missing-fingerprint-family");

  assert.equal(confirmedMember.fingerprintReviewStatus, "confirmed");
  assert.equal(confirmedMember.familyKnowledgeMismatch, true);
  assert.equal(confirmedMember.familyKnowledgeCompatibility.status, "incompatible");
  assert.equal(confirmedMember.familyKnowledgeCompatibility.overallStatus, "incompatible");
  assert.equal(confirmedMember.question.knowledgeFingerprint.status, "confirmed");
  assert.equal(confirmedMember.question.candidateKnowledgeFingerprint, null);
  assert.equal(confirmedMember.question.knowledgeFingerprintStatus, "confirmed");

  assert.equal(suggestedMember.fingerprintReviewStatus, "suggested");
  assert.equal(suggestedMember.familyKnowledgeMismatch, false);
  assert.equal(suggestedMember.familyKnowledgeCompatibility.status, "provisional_conflict");
  assert.equal(suggestedMember.familyKnowledgeCompatibility.overallStatus, "unassessed");
  assert.equal(suggestedMember.question.knowledgeFingerprint, null);
  assert.equal(suggestedMember.question.candidateKnowledgeFingerprint.status, "suggested");
  assert.equal(suggestedMember.question.knowledgeFingerprintStatus, "suggested");

  assert.equal(missingMember.fingerprintReviewStatus, "missing");
  assert.equal(missingMember.familyKnowledgeMismatch, false);
  assert.equal(missingMember.familyKnowledgeCompatibility.status, "unassessed");
  assert.equal(missingMember.familyKnowledgeCompatibility.overallStatus, "unassessed");
  assert.equal(missingMember.question.knowledgeFingerprint, null);
  assert.equal(missingMember.question.candidateKnowledgeFingerprint, null);
  assert.equal(missingMember.question.knowledgeFingerprintStatus, "missing");
});

test("question editor confirms a fingerprint with version guards and returns affected families to review", async (context) => {
  const sourceQuestion = question("fingerprint-editor-q", "下列造字法判断正确的是（ ）。", {
    version: 1,
    versions: [],
  });
  const questionStore = createMemoryQuestionStore([sourceQuestion]);
  const storedQuestion = questionStore.get(sourceQuestion.id);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const structure = knowledgeStructureStore.generate({
    bookId: sourceQuestion.bookId,
    catalogNodes: [
      { id: "fingerprint-editor-chapter", level: 1, title: "第一章", startPage: 1, endPage: 20 },
      { id: "fingerprint-editor-section", level: 2, title: "第一节", startPage: 1, endPage: 20 },
      { id: "fingerprint-editor-candidate", level: 3, title: "象形", startPage: 2, endPage: 8 },
      { id: "fingerprint-editor-confirmed", level: 3, title: "会意", startPage: 9, endPage: 15 },
    ],
    outlineNodes: [],
    chunks: [],
    questions: [storedQuestion],
  });
  const structureState = knowledgeStructureStore.exportState();
  const record = structureState.records.find((item) => item.bookId === sourceQuestion.bookId);
  const candidateNode = structure.nodes.find((node) => node.id === "fingerprint-editor-candidate");
  record.fingerprints = record.fingerprints.map((fingerprint) => ({
    ...fingerprint,
    primaryNodeId: candidateNode.id,
    primaryKnowledgePoint: candidateNode.displayTitle,
    knowledgePath: candidateNode.path,
    requiredNodeIds: [candidateNode.id],
    status: "suggested",
    source: "catalog_rule",
  }));
  knowledgeStructureStore.replaceState(structureState);
  const familyId = "fingerprint-editor-family";
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [{
    id: familyId,
    bookId: sourceQuestion.bookId,
    subjectId: sourceQuestion.subjectId,
    name: "候选题族",
    knowledgeNodeId: candidateNode.id,
    coreKnowledgeNodeId: candidateNode.id,
    requiredKnowledgeNodeIds: [candidateNode.id],
    textbookAnchorNodeIds: [candidateNode.id],
    assessmentAction: "判断造字法",
    focusKey: "判断造字法",
    status: "confirmed",
    members: [{ questionId: sourceQuestion.id, isPrimary: true, role: "prototype", trainingLevel: "foundation" }],
  }] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    knowledgeStructureStore,
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const detail = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}`).then((response) => response.json());
  assert.equal(detail.question.knowledgeFingerprint, null);
  assert.equal(detail.question.candidateKnowledgeFingerprint.status, "suggested");
  assert.equal(detail.question.knowledgeFingerprintStatus, "suggested");
  assert.ok(detail.question.knowledgeFingerprintSignature);

  const signatureConflictResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "accept_candidate",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: "stale-fingerprint-signature",
      primaryNodeId: "fingerprint-editor-confirmed",
      requiredNodeIds: ["fingerprint-editor-confirmed"],
    }),
  });
  assert.equal(signatureConflictResponse.status, 409);
  assert.equal((await signatureConflictResponse.json()).error, "question_fingerprint_revision_conflict");
  assert.equal(questionStore.get(sourceQuestion.id).version, detail.question.version);

  const response = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "accept_candidate",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "fingerprint-editor-confirmed",
      requiredNodeIds: ["fingerprint-editor-confirmed"],
      assessmentAction: "判断造字法",
    }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.question.version, detail.question.version + 1);
  assert.equal(saved.question.knowledgeFingerprint.status, "confirmed");
  assert.equal(saved.question.knowledgeFingerprint.primaryNodeId, "fingerprint-editor-confirmed");
  assert.equal(saved.question.knowledgeFingerprint.questionVersion, saved.question.version);
  assert.equal(saved.question.knowledgeFingerprint.revision, 1);
  assert.equal(saved.question.candidateKnowledgeFingerprint, null);
  assert.deepEqual(saved.affectedFamilyIds, [familyId]);
  assert.equal(questionFamilyStore.get(familyId).status, "confirmed");
  assert.equal(questionFamilyStore.get(familyId).members[0].reviewStatus, "pending_fit");

  const staleResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "fingerprint-editor-candidate",
      requiredNodeIds: ["fingerprint-editor-candidate"],
    }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error, "question_fingerprint_question_version_conflict");
  assert.equal(questionStore.get(sourceQuestion.id).version, saved.question.version);

  const repeatedAcceptanceResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "accept_candidate",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: saved.question.version,
      expectedFingerprintSignature: saved.question.knowledgeFingerprintSignature,
      primaryNodeId: "fingerprint-editor-confirmed",
      requiredNodeIds: ["fingerprint-editor-confirmed"],
    }),
  });
  assert.equal(repeatedAcceptanceResponse.status, 409);
  assert.equal((await repeatedAcceptanceResponse.json()).error, "question_fingerprint_candidate_changed");
  assert.equal(questionStore.get(sourceQuestion.id).version, saved.question.version);
});

test("question editor creates a confirmed fingerprint manually when no AI candidate exists", async (context) => {
  const sourceQuestion = question("fingerprint-manual-create-q", "下列造字法判断正确的是（ ）。", {
    version: 1,
    versions: [],
  });
  const questionStore = createMemoryQuestionStore([sourceQuestion]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: sourceQuestion.bookId,
    catalogNodes: [
      { id: "fingerprint-manual-chapter", level: 1, title: "第一章", startPage: 1, endPage: 20 },
      { id: "fingerprint-manual-section", level: 2, title: "第一节", startPage: 1, endPage: 20 },
      { id: "fingerprint-manual-node", level: 3, title: "会意", startPage: 2, endPage: 8 },
    ],
    outlineNodes: [],
    chunks: [],
    questions: [questionStore.get(sourceQuestion.id)],
  });
  const structureState = knowledgeStructureStore.exportState();
  const record = structureState.records.find((item) => item.bookId === sourceQuestion.bookId);
  record.fingerprints = record.fingerprints.filter((fingerprint) => fingerprint.questionId !== sourceQuestion.id);
  knowledgeStructureStore.replaceState(structureState);

  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    knowledgeStructureStore,
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const detail = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}`).then((response) => response.json());
  assert.equal(detail.question.version, 1);
  assert.equal(detail.question.knowledgeFingerprint, null);
  assert.equal(detail.question.candidateKnowledgeFingerprint, null);
  assert.equal(detail.question.knowledgeFingerprintStatus, "missing");
  assert.equal(detail.question.knowledgeFingerprintSignature, "");

  const missingCandidateResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "accept_candidate",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "fingerprint-manual-node",
      requiredNodeIds: ["fingerprint-manual-node"],
    }),
  });
  assert.equal(missingCandidateResponse.status, 409);
  assert.equal((await missingCandidateResponse.json()).error, "question_fingerprint_candidate_changed");
  assert.equal(questionStore.get(sourceQuestion.id).version, 1);
  assert.equal(knowledgeStructureStore.get(sourceQuestion.bookId).fingerprints.length, 0);

  const createResponse = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "fingerprint-manual-node",
      requiredNodeIds: ["fingerprint-manual-node"],
      assessmentAction: "判断造字法",
    }),
  });
  assert.equal(createResponse.status, 200);
  const saved = await createResponse.json();
  assert.equal(saved.question.version, 2);
  assert.equal(saved.question.knowledgeFingerprintStatus, "confirmed");
  assert.equal(saved.question.knowledgeFingerprint.status, "confirmed");
  assert.equal(saved.question.knowledgeFingerprint.primaryNodeId, "fingerprint-manual-node");
  assert.deepEqual(saved.question.knowledgeFingerprint.requiredNodeIds, ["fingerprint-manual-node"]);
  assert.equal(saved.question.knowledgeFingerprint.questionVersion, 2);
  assert.equal(saved.question.knowledgeFingerprint.revision, 1);
  assert.equal(saved.question.knowledgeFingerprint.source, "manual_question_editor");
  assert.equal(saved.question.candidateKnowledgeFingerprint, null);
});

test("question fingerprint updates preserve an existing scope-anchor role when legacy clients omit it", async (context) => {
  const sourceQuestion = question("fingerprint-scope-preserve-q", "下列发音方法判断正确的是（ ）。", {
    version: 1,
    versions: [],
  });
  const questionStore = createMemoryQuestionStore([sourceQuestion]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: sourceQuestion.bookId,
    catalogNodes: [
      { id: "scope-preserve-chapter", level: 1, title: "第一章", startPage: 1, endPage: 20 },
      { id: "scope-preserve-section", level: 2, title: "第一节", startPage: 1, endPage: 20 },
      { id: "scope-preserve-anchor", level: 3, title: "发音方法", startPage: 2, endPage: 8 },
      { id: "scope-preserve-required", level: 4, title: "声带振动", startPage: 3, endPage: 5 },
    ],
    outlineNodes: [],
    chunks: [],
    questions: [questionStore.get(sourceQuestion.id)],
  });
  knowledgeStructureStore.assignQuestions(sourceQuestion.bookId, [{
    questionId: sourceQuestion.id,
    primaryNodeId: "scope-preserve-anchor",
    primaryNodeRole: "scope_anchor",
    requiredNodeIds: ["scope-preserve-required"],
  }]);
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    knowledgeStructureStore,
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const detail = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}`).then((response) => response.json());
  assert.equal(detail.question.knowledgeFingerprint.primaryNodeRole, "scope_anchor");
  const response = await fetch(`${baseUrl}/api/admin/questions/${sourceQuestion.id}/knowledge-fingerprint`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      bookId: sourceQuestion.bookId,
      expectedQuestionVersion: detail.question.version,
      expectedFingerprintSignature: detail.question.knowledgeFingerprintSignature,
      primaryNodeId: "scope-preserve-anchor",
      requiredNodeIds: ["scope-preserve-required"],
      assessmentAction: "判断声带振动",
    }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.question.knowledgeFingerprint.primaryNodeRole, "scope_anchor");
  assert.deepEqual(saved.question.knowledgeFingerprint.requiredNodeIds, ["scope-preserve-required"]);
});

test("confirming a family atomically moves its primary anchor and rejects moves outside its family-set scope", async (context) => {
  const q1 = question("atomic-anchor-q1", "声母 b 的发音方法是（ ）。");
  const q2 = question("atomic-anchor-q2", "声母 p 的发音方法是（ ）。");
  const questionStore = createMemoryQuestionStore([q1, q2]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const structure = knowledgeStructureStore.generate({
    bookId: q1.bookId,
    catalogNodes: [
      { id: "atomic-chapter", level: 1, title: "第一章 语音", startPage: 1, endPage: 30 },
      { id: "atomic-scope", level: 2, title: "第一节 辅音与声母", startPage: 2, endPage: 20 },
      { id: "atomic-outside-section", level: 2, title: "第二节 元音与韵母", startPage: 21, endPage: 30 },
    ],
    outlineNodes: [
      { id: "atomic-source", parentId: "atomic-scope", title: "辅音发音方法", startPage: 3, endPage: 8 },
      { id: "atomic-target", parentId: "atomic-scope", title: "声母发音方法", startPage: 9, endPage: 15 },
      { id: "atomic-outside", parentId: "atomic-outside-section", title: "韵母结构", startPage: 22, endPage: 28 },
    ],
    chunks: [],
    questions: [q1, q2],
  });
  const nodeById = new Map(structure.nodes.map((node) => [node.id, node]));
  const sourceNode = nodeById.get("atomic-source");
  const targetNode = nodeById.get("atomic-target");
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const family = questionFamilyStore.create({
    subjectId: q1.subjectId,
    bookId: q1.bookId,
    name: "声母发音方法题族",
    knowledgeNodeId: sourceNode.id,
    coreKnowledgeNodeId: sourceNode.id,
    requiredKnowledgeNodeIds: [sourceNode.id],
    textbookAnchorNodeIds: [sourceNode.id],
    chapter: sourceNode.path,
    primaryKnowledgePoint: sourceNode.displayTitle || sourceNode.title,
    knowledgePath: sourceNode.path,
    knowledgeLevel: sourceNode.knowledgeLevel,
    orderIndex: structure.nodes.findIndex((node) => node.id === sourceNode.id) + 1,
  });
  questionFamilyStore.addMembers(family.id, [q1, q2], "审核员");
  questionFamilyStore.createSet({
    bookId: q1.bookId,
    knowledgeNodeId: "atomic-scope",
    name: "辅音与声母题族集",
    familyIds: [family.id],
  }, "审核员");

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore,
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const beforeConfirm = questionFamilyStore.get(family.id);
  const revisionsBefore = questionFamilyStore.membershipRevisions([q1.id, q2.id]);

  const confirmedResponse = await fetch(`${baseUrl}/api/admin/question-families/${family.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "confirmed",
      name: beforeConfirm.name,
      members: beforeConfirm.members,
      knowledgeNodeId: targetNode.id,
      textbookAnchorNodeIds: [targetNode.id],
    }),
  });
  const confirmed = await confirmedResponse.json();
  assert.equal(confirmedResponse.status, 200, JSON.stringify(confirmed));
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.family.status, "confirmed");
  assert.equal(confirmed.family.knowledgeNodeId, targetNode.id);
  assert.deepEqual(confirmed.family.textbookAnchorNodeIds, [targetNode.id]);
  assert.equal(confirmed.family.chapter, targetNode.path);
  assert.equal(confirmed.family.primaryKnowledgePoint, targetNode.displayTitle || targetNode.title);
  assert.equal(confirmed.family.knowledgePath, targetNode.path);
  assert.equal(confirmed.family.knowledgeLevel, targetNode.knowledgeLevel);
  assert.equal(confirmed.family.orderIndex, structure.nodes.findIndex((node) => node.id === targetNode.id) + 1);
  assert.deepEqual(confirmed.family.members.map((member) => [member.questionId, member.reviewStatus]), [
    [q1.id, "confirmed"],
    [q2.id, "confirmed"],
  ]);
  assert.equal(questionFamilyStore.confirmedForQuestion(q1.id).length, 1);
  assert.equal(questionFamilyStore.confirmedForQuestion(q2.id).length, 1);
  const revisionsAfterConfirm = questionFamilyStore.membershipRevisions([q1.id, q2.id]);
  assert.equal(revisionsAfterConfirm[q1.id], revisionsBefore[q1.id] + 1);
  assert.equal(revisionsAfterConfirm[q2.id], revisionsBefore[q2.id] + 1);

  const stateBeforeRejectedMove = questionFamilyStore.exportState();
  const rejectedResponse = await fetch(`${baseUrl}/api/admin/question-families/${family.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "rejected",
      name: "越界时不应保存的名称",
      members: confirmed.family.members.map((member) => ({ ...member, trainingLevel: "transfer" })),
      knowledgeNodeId: "atomic-outside",
      textbookAnchorNodeIds: ["atomic-outside"],
    }),
  });
  const rejected = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 409);
  assert.equal(rejected.error, "question_family_set_scope_mismatch");
  assert.deepEqual(questionFamilyStore.exportState(), stateBeforeRejectedMove);
  const unchanged = questionFamilyStore.get(family.id);
  assert.equal(unchanged.status, "confirmed");
  assert.equal(unchanged.name, beforeConfirm.name);
  assert.equal(unchanged.knowledgeNodeId, targetNode.id);
  assert.equal(unchanged.knowledgePath, targetNode.path);
  assert.deepEqual(unchanged.members, confirmed.family.members);
  assert.deepEqual(questionFamilyStore.membershipRevisions([q1.id, q2.id]), revisionsAfterConfirm);
});

test("unified family workspace returns editable question metadata and ungrouped questions", async (context) => {
  const questions = [question("q1", "声母 b 的发音方法是（ ）。"), question("q2", "尚未归入题族的题目（ ）。")];
  const questionStore = createMemoryQuestionStore(questions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "chapter-main", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
      { id: "node-main", level: 2, title: "辅音的发音方法", startPage: 2, endPage: 20 },
    ],
    outlineNodes: [],
    chunks: [],
    questions,
  });
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [{
    id: "family-main",
    bookId: "modern-chinese-7-1",
    name: "辅音发音方法",
    knowledgeNodeId: "node-main",
    knowledgePath: "第一章 语音 > 辅音的发音方法",
    status: "confirmed",
    members: [{ questionId: "q1", role: "prototype", trainingLevel: "foundation" }],
  }] });
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), knowledgeStructureStore, questionStore, questionFamilyStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/question-families?bookId=modern-chinese-7-1`).then((response) => response.json());
  assert.equal(listing.families[0].members[0].question.status, "official");
  assert.equal(listing.families[0].members[0].question.version, 1);
  assert.equal(listing.families[0].members[0].question.bookId, "modern-chinese-7-1");
  assert.equal(listing.families[0].members[0].question.subjectId, "modern-chinese");
  assert.equal(listing.families[0].members[0].question.primaryKnowledgePoint, "辅音与声母");
  assert.deepEqual(listing.families[0].members[0].question.knowledgePoints, ["辅音与声母"]);
  assert.equal(listing.families[0].members[0].question.knowledgeFingerprint, null);
  assert.equal(listing.families[0].members[0].question.candidateKnowledgeFingerprint.questionId, "q1");
  assert.equal(listing.families[0].members[0].question.knowledgeFingerprintStatus, "suggested");
  assert.equal(listing.families[0].members[0].question.familyMemberships[0].familyId, "family-main");
  assert.equal(listing.ungroupedQuestions[0].bookId, "modern-chinese-7-1");
  assert.equal(listing.ungroupedQuestions[0].knowledgeFingerprint, null);
  assert.equal(listing.ungroupedQuestions[0].candidateKnowledgeFingerprint.questionId, "q2");
  assert.equal(listing.ungroupedQuestions[0].knowledgeFingerprintStatus, "suggested");
  assert.deepEqual(listing.ungroupedQuestions.map((item) => item.id), ["q2"]);

  const updated = await fetch(`${baseUrl}/api/admin/questions/q1`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stem: "声母 b 的正确发音方法是（ ）。", changeNote: "修正题干" }),
  }).then((response) => response.json());
  assert.deepEqual(updated.affectedFamilyIds, ["family-main"]);
  assert.equal(questionFamilyStore.get("family-main").status, "confirmed");
  assert.equal(questionFamilyStore.get("family-main").members[0].reviewStatus, "pending_fit");
});

test("family workspace counts questions awaiting a confirmed topic-family catalog projection", async (context) => {
  const bookId = "modern-chinese-7-1";
  const questions = [
    question("projected-q", "已进入确认主题族的题目"),
    question("pending-q", "只有待审核主题族的题目"),
    question("rejected-q", "只有已驳回主题族的题目"),
    question("related-q", "只作为关联题加入确认题族的题目"),
    question("fit-pending-q", "位于确认题族但成员适配尚未审核的题目"),
    question("invalid-anchor-q", "确认主题族缺少有效教材锚点的题目"),
    question("unassigned-q", "完全没有题族关系的题目", {
      chapter: "第一章 语音",
      primaryKnowledgePoint: "语音",
      knowledgePoints: ["语音"],
      subKnowledgePoints: [],
    }),
    question("offline-q", "已下架但仍残留题族关系的题目", { status: "offline" }),
    question("merged-q", "已合并但仍残留题族关系的源题", { mergedIntoQuestionId: "projected-q" }),
  ];
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId,
    catalogNodes: [
      { id: "catalog-valid", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
      { id: "catalog-knowledge", level: 3, title: "语音", parentId: "catalog-valid", startPage: 1, endPage: 20 },
    ],
    outlineNodes: [],
    chunks: [],
    questions,
  });
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft(bookId, [
    { id: "catalog-valid", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
  ]);
  textbookCatalogStore.confirm(bookId, "目录审核员");
  const family = (id, status, members, anchor = "catalog-valid") => ({
    id,
    bookId,
    name: id,
    knowledgeNodeId: anchor,
    textbookAnchorNodeIds: [anchor],
    status,
    members,
  });
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [
    family("confirmed-primary-a", "confirmed", [{ questionId: "projected-q", isPrimary: true, role: "prototype" }]),
    family("confirmed-primary-b", "confirmed", [{ questionId: "projected-q", isPrimary: true, role: "similar" }]),
    family("pending-primary", "pending_review", [
      { questionId: "pending-q", isPrimary: true, role: "prototype" },
      { questionId: "related-q", isPrimary: true, role: "similar" },
    ]),
    family("rejected-primary", "rejected", [{ questionId: "rejected-q", isPrimary: true, role: "prototype" }]),
    family("confirmed-related", "confirmed", [{ questionId: "related-q", isPrimary: false, role: "similar" }]),
    family("confirmed-fit-pending", "confirmed", [{ questionId: "fit-pending-q", isPrimary: true, role: "prototype", reviewStatus: "pending_fit" }]),
    family("confirmed-invalid-anchor", "confirmed", [{ questionId: "invalid-anchor-q", isPrimary: true, role: "prototype" }], "missing-anchor"),
    family("confirmed-offline", "confirmed", [{ questionId: "offline-q", isPrimary: true, role: "prototype" }]),
    family("confirmed-merged", "confirmed", [{ questionId: "merged-q", isPrimary: true, role: "prototype" }]),
  ] });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore: createMemoryQuestionStore(questions),
    questionFamilyStore,
    textbookCatalogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/question-families?bookId=${bookId}`).then((response) => response.json());
  assert.equal(listing.summary.activeQuestionCount, 7);
  assert.equal(listing.summary.confirmedTopicQuestionCount, 1);
  assert.equal(listing.summary.pendingGroupingQuestionCount, 6);
  assert.equal(listing.summary.unresolvedQuestionCount, 1);
  assert.equal(listing.catalogTreeSummary.questionCount, 1);
  assert.equal(listing.catalogTreeSummary.nodeQuestionCounts["catalog-valid"], 1);
  assert.deepEqual(listing.ungroupedQuestions.map((item) => item.id), ["unassigned-q"]);

  // 选中教材目录时，未成族题目必须按该目录（含下级）过滤后返回，而不是被清空：
  // 审核员要在右侧直接看到“本目录还有几道题没成族”。
  const scopedByNode = await fetch(`${baseUrl}/api/admin/question-families?bookId=${bookId}&knowledgeNodeId=catalog-knowledge`).then((response) => response.json());
  assert.deepEqual(scopedByNode.ungroupedQuestions.map((item) => item.id), ["unassigned-q"]);
  // 目录内没有题目时必须为空，不能退回整本
  const scopedByEmptyNode = await fetch(`${baseUrl}/api/admin/question-families?bookId=${bookId}&knowledgeNodeId=node-without-questions`).then((response) => response.json());
  assert.deepEqual(scopedByEmptyNode.ungroupedQuestions, []);

  const filtered = await fetch(`${baseUrl}/api/admin/question-families?bookId=${bookId}&status=pending_review`).then((response) => response.json());
  assert.equal(filtered.summary.confirmedTopicQuestionCount, 1);
  assert.equal(filtered.summary.pendingGroupingQuestionCount, 6);
  assert.equal(filtered.summary.unresolvedQuestionCount, 1);
  assert.deepEqual(filtered.catalogTreeSummary, listing.catalogTreeSummary);
  assert.deepEqual(filtered.ungroupedQuestions, []);
});

test("lower-volume ungrouped questions are derived live after the legacy index is retired", async (context) => {
  const bookId = "modern-chinese-7-2";
  const questions = Array.from({ length: 18 }, (_, index) => question(
    `lower-volume-q${index + 1}`,
    `下册尚未建立题族的题目 ${index + 1}`,
    {
      bookId,
      chapter: "下册待归组章节",
      primaryKnowledgePoint: "下册待归组知识点",
      knowledgePoints: ["下册待归组知识点"],
    },
  ));
  const questionFamilyStore = createMemoryQuestionFamilyStore({
    version: 3,
    families: [],
    unresolvedByBook: { [bookId]: [questions[0].id] },
  });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore: createMemoryQuestionStore(questions),
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/question-families?bookId=${bookId}`).then((response) => response.json());

  assert.deepEqual(questionFamilyStore.exportState().unresolvedByBook, {});
  assert.equal(listing.summary.activeQuestionCount, 18);
  assert.equal(listing.summary.confirmedTopicQuestionCount, 0);
  assert.equal(listing.summary.pendingGroupingQuestionCount, 18);
  assert.equal(listing.summary.unresolvedQuestionCount, 18);
  assert.equal(listing.ungroupedQuestions.length, 18);
  assert.deepEqual(new Set(listing.ungroupedQuestions.map((item) => item.id)), new Set(questions.map((item) => item.id)));
});

test("question family membership stays independent from the question knowledge annotations", async (context) => {
  const storedQuestion = question("q1", "一道需要重新设置主归属的题目（ ）。");
  const questionStore = createMemoryQuestionStore([storedQuestion]);
  const questionFamilyStore = createMemoryQuestionFamilyStore({ families: [
    {
      id: "family-main",
      bookId: "modern-chinese-7-1",
      name: "音节结构",
      primaryKnowledgePoint: "音节结构",
      knowledgeNodeId: "node-main",
      knowledgePath: "第一章 语音 > 音节 > 音节结构",
      status: "confirmed",
      members: [{ questionId: "q1", role: "prototype", trainingLevel: "foundation" }],
    },
    {
      id: "family-bridge",
      bookId: "modern-chinese-7-1",
      name: "词汇单位",
      primaryKnowledgePoint: "词汇单位",
      knowledgeNodeId: "node-bridge",
      knowledgePath: "第三章 词汇 > 词汇概说 > 词汇单位",
      status: "pending_review",
      members: [],
    },
  ] });
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), questionStore, questionFamilyStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const options = await fetch(`${baseUrl}/api/admin/question-family-options?bookId=modern-chinese-7-1`).then((response) => response.json());
  assert.deepEqual(new Set(options.families.map((family) => family.id)), new Set(["family-main", "family-bridge"]));
  const bridgeOption = options.families.find((family) => family.id === "family-bridge");
  assert.equal(bridgeOption.coreKnowledgeNodeId, "node-bridge");
  assert.deepEqual(bridgeOption.requiredKnowledgeNodeIds, ["node-bridge"]);
  assert.deepEqual(bridgeOption.textbookAnchorNodeIds, ["node-bridge"]);
  assert.equal(bridgeOption.assessmentAction, "");
  assert.equal(bridgeOption.inclusionBoundary, "");
  assert.equal(bridgeOption.exclusionBoundary, "");
  const updated = await fetch(`${baseUrl}/api/admin/questions/q1`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      familyMemberships: [
        { familyId: "family-main", isPrimary: false },
        { familyId: "family-bridge", isPrimary: true },
      ],
      changeNote: "设置主归属",
    }),
  }).then((response) => response.json());
  assert.equal(updated.success, true);
  assert.equal(updated.question.chapter, storedQuestion.chapter);
  assert.equal(updated.question.primaryKnowledgePoint, storedQuestion.primaryKnowledgePoint);
  assert.deepEqual(updated.question.knowledgePoints, storedQuestion.knowledgePoints);
  assert.deepEqual(updated.question.familyMemberships.map((membership) => [membership.familyId, membership.isPrimary]), [
    ["family-bridge", true],
    ["family-main", false],
  ]);
});

test("admin exposes question and family management in the unified question library", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const html = await fetch(`http://127.0.0.1:${server.address().port}/admin/`).then((response) => response.text());
  const app = await fetch(`http://127.0.0.1:${server.address().port}/admin/app.js`).then((response) => response.text());
  const styles = await fetch(`http://127.0.0.1:${server.address().port}/admin/styles.css`).then((response) => response.text());
  assert.match(html, /data-view="题库管理"/);
  assert.match(html, /data-question-library-tab="library"[^>]*>题库</);
  assert.doesNotMatch(html, /data-question-library-tab="(?:questions|families)"/);
  assert.doesNotMatch(html, /data-question-workspace-mode=/);
  assert.match(html, /id="question-workspace-search"/);
  assert.match(html, /id="knowledge-tree"/);
  assert.match(html, /id="toggle-knowledge-tree-edit"/);
  assert.match(html, /id="knowledge-node-dialog"/);
  assert.match(html, /id="assign-selected-question-knowledge"/);
  assert.match(html, /id="question-knowledge-assignment-dialog"/);
  assert.match(html, /保存并重新归组/);
  assert.doesNotMatch(html, /id="reassign-question-family"/);
  assert.match(html, /id="question-knowledge-fingerprint"/);
  assert.match(html, /id="save-question-fingerprint"/);
  assert.match(html, /id="create-empty-question-family"/);
  assert.match(html, /id="toggle-question-family-management"/);
  assert.match(html, /id="question-family-batch-toolbar"/);
  assert.match(html, /id="move-selected-questions"[^>]*>移动<\/button>/);
  assert.match(html, /id="question-grouping-dialog"/);
  assert.match(html, /新建题族并加入/);
  assert.match(html, /id="question-family-location-node"/);
  assert.doesNotMatch(html, /id="question-family-location-search"/);
  assert.doesNotMatch(html, /id="move-question-family"/);
  assert.match(html, /id="delete-question-family"[^>]*>删除题族</);
  assert.doesNotMatch(html, /按题目重新归组/);
  assert.match(html, /id="add-question-family-members"/);
  assert.match(html, /id="question-family-picker-dialog"/);
  assert.match(html, /id="add-question-membership"/);
  assert.match(html, /id="question-family-membership-search"/);
  assert.match(html, /id="question-family-membership-select"/);
  assert.match(html, /id="question-chapter" type="hidden"/);
  assert.doesNotMatch(html, /<span>章节<\/span><input id="question-chapter"/);
  assert.match(app, /function beginKnowledgeTreePointer/);
  assert.match(app, /function expandKnowledgeNodeAncestors/);
  assert.match(app, /collapsedKnowledgeNodeIds: new Set\(\)/);
  assert.match(app, /data-knowledge-tree-toggle=/);
  assert.match(app, /aria-expanded=/);
  assert.match(app, /event\.target\.closest\("\[data-edit-knowledge-node-id\], \[data-knowledge-tree-toggle\]"\)/);
  // 删除节点前必须能看清是哪几道题挡住，并能直接把这些题改挂到正确节点。
  assert.match(html, /id="knowledge-node-questions"/);
  assert.match(html, /id="knowledge-node-questions-list"/);
  assert.match(html, /id="knowledge-node-reassign-target"/);
  assert.match(html, /id="reassign-knowledge-node-questions"/);
  assert.match(app, /function renderKnowledgeNodeQuestions/);
  assert.match(app, /function loadKnowledgeNodeQuestions/);
  assert.match(app, /async function reassignKnowledgeNodeQuestions/);
  assert.match(app, /knowledge-structure\/nodes\/\$\{encodeURIComponent\(node\.id\)\}\/questions/);
  assert.match(app, /knowledge-structure\/question-assignments/);
  assert.match(app, /其中 \$\{blocking\.length\} 道会阻断删除，必须先改挂/);
  assert.match(styles, /\.knowledge-node-questions-list li\.is-blocking/);
  assert.match(app, /function openEmptyQuestionFamilyDialog/);
  const openFamilyReviewSource = app.slice(
    app.indexOf("function openQuestionFamilyReview"),
    app.indexOf("function openEmptyQuestionFamilyDialog"),
  );
  assert.match(openFamilyReviewSource, /deleteButton\.hidden = false;[\s\S]*deleteButton\.disabled = false;/);
  assert.match(app, /function openQuestionFamilyPicker/);
  assert.match(app, /\["已归组题目", summary\.confirmedTopicQuestionCount \?\? summary\.questionCount \?\? 0\]/);
  assert.match(app, /\["待归组题目", summary\.pendingGroupingQuestionCount \|\| 0\]/);
  assert.match(app, /\["无题族关系", summary\.unresolvedQuestionCount \|\| 0\]/);
  assert.match(styles, /\.question-family-summary\s*\{[^}]*grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)/);
  assert.match(app, /function questionOptionListHtml/);
  assert.match(app, /function questionFamilyPreviewHtml/);
  assert.match(app, /function openQuestionGrouping/);
  assert.match(app, /function confirmQuestionGrouping/);
  assert.match(app, /questionFamilySelectionSources:\s*\{\}/);
  assert.match(app, /questionGroupingMode:\s*"add"/);
  assert.match(app, /function movableQuestionFamilySourceId/);
  assert.match(app, /data-question-family-source=/);
  assert.match(app, /#move-selected-questions"\)\.addEventListener\("click", \(\) => openQuestionGrouping\("move"\)\)/);
  assert.match(app, /\/move-members/);
  assert.doesNotMatch(app, /function relocateQuestionFamily/);
  assert.match(app, /确认题族后将同步移动目录，题目成员不变/);
  assert.match(app, /function deleteQuestionFamily/);
  const deleteFamilySource = app.slice(
    app.indexOf("async function deleteQuestionFamily"),
    app.indexOf("async function saveQuestionFamily"),
  );
  assert.match(deleteFamilySource, /finally\s*\{\s*button\.disabled = false;/);
  assert.match(app, /function questionFamilyWorkspaceBookId/);
  assert.match(app, /explicitBookIds\[0\] \|\| workspaceBookId/);
  assert.match(styles, /\.question-browser-section\s*\{[^}]*overflow:\s*clip/s);
  assert.match(styles, /\.question-family-batch-toolbar\s*\{[^}]*position:\s*sticky/s);
  assert.match(app, /data-question-family-select=/);
  assert.match(app, /function renderQuestionMembershipEditor/);
  assert.match(app, /function questionFamilyVisibleKey/);
  assert.match(app, /availableQuestionMembershipFamilies/);
  assert.match(app, /name="question-primary-family"/);
  assert.match(app, /data-question-open=/);
  assert.match(app, /questionActionButtons\(question\)/);
  assert.match(app, /question\.mergedIntoQuestionId \|\| question\.merge\?\.targetQuestionId/);
  assert.match(app, /data-question-action="open-merged-target"/);
  assert.match(app, /expandedQuestionFamilyIds/);
  assert.match(app, /questionFamilyMatchedOptionsHtml\(question\.options\)/);
  assert.equal((app.match(/questionOptionListHtml\(question\.options/g) || []).length, 6);
  assert.match(html, /按知识指纹重新生成/);
  assert.match(html, /人工确认后才进入智能复习/);
});

test("admin knowledge-node API edits the hierarchy and protects mapped nodes", async (context) => {
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const storedQuestion = question("q1", "元音的发音方法是（ ）。", { chapter: "第一章 语音 > 第一节 元音", primaryKnowledgePoint: "元音的发音", knowledgePoints: ["元音的发音"] });
  const storedQuestion2 = question("q2", "复元音可以分为哪些类型？", { chapter: "第一章 语音 > 第一节 元音", primaryKnowledgePoint: "元音的发音", knowledgePoints: ["元音的发音"] });
  knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "chapter", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
      { id: "section", level: 2, title: "第一节 元音", startPage: 2, endPage: 20 },
      { id: "vowel", level: 3, title: "一、元音的发音", startPage: 3, endPage: 20 },
    ],
    outlineNodes: [
      { id: "monophthong", parentId: "vowel", title: "（一）单元音的发音", startPage: 4, endPage: 8 },
      { id: "compound", parentId: "vowel", title: "（二）复元音的发音", startPage: 9, endPage: 12 },
      { id: "front", parentId: "vowel", title: "1. 前响复元音", startPage: 9, endPage: 10 },
      { id: "noise", parentId: "vowel", title: "T1↑YX+Z↓非米", startPage: 13, endPage: 13 },
    ],
    chunks: [],
    questions: [storedQuestion, storedQuestion2],
  });
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), knowledgeStructureStore, questionStore: createMemoryQuestionStore([storedQuestion, storedQuestion2]) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const emptyFamily = await fetch(`${baseUrl}/api/admin/question-families`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bookId: "modern-chinese-7-1",
      knowledgeNodeId: "compound",
      name: "复元音辨析待补充",
    }),
  }).then((response) => response.json());
  assert.equal(emptyFamily.success, true);
  assert.equal(emptyFamily.family.members.length, 0);
  assert.equal(emptyFamily.family.source, "manual_empty_family");

  const groupedFamily = await fetch(`${baseUrl}/api/admin/question-families`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bookId: "modern-chinese-7-1",
      knowledgeNodeId: "compound",
      name: "复元音分类专项",
      questionIds: ["q2", "q1"],
    }),
  }).then((response) => response.json());
  assert.equal(groupedFamily.success, true);
  assert.equal(groupedFamily.addedCount, 2);
  assert.deepEqual(groupedFamily.family.members.map((member) => [member.questionId, member.role]), [
    ["q2", "prototype"],
    ["q1", "similar"],
  ]);
  assert.equal(groupedFamily.family.source, "manual_family");

  const relocatedFamily = await fetch(`${baseUrl}/api/admin/question-families/${groupedFamily.family.id}/relocate`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ knowledgeNodeId: "front" }),
  }).then((response) => response.json());
  assert.equal(relocatedFamily.success, true);
  assert.equal(relocatedFamily.family.id, groupedFamily.family.id);
  assert.equal(relocatedFamily.family.knowledgeNodeId, "front");
  assert.match(relocatedFamily.family.knowledgePath, /前响复元音/);
  assert.equal(relocatedFamily.family.status, "pending_review");
  assert.deepEqual(relocatedFamily.family.members.map((member) => [member.questionId, member.role]), [
    ["q2", "prototype"],
    ["q1", "similar"],
  ]);

  await fetch(`${baseUrl}/api/admin/question-families/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "modern-chinese-7-1" }),
  });
  const familyListing = await fetch(`${baseUrl}/api/admin/question-families?bookId=modern-chinese-7-1`).then((response) => response.json());
  assert.equal(familyListing.families.some((family) => family.id === emptyFamily.family.id), true);

  const addedMember = await fetch(`${baseUrl}/api/admin/question-families/${emptyFamily.family.id}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIds: ["q1"] }),
  }).then((response) => response.json());
  assert.equal(addedMember.success, true);
  assert.equal(addedMember.family.members[0].questionId, "q1");
  assert.equal(addedMember.family.members[0].role, "prototype");
  assert.equal(addedMember.family.status, "pending_review");

  const removedMember = await fetch(`${baseUrl}/api/admin/question-families/${emptyFamily.family.id}/members/q1`, {
    method: "DELETE",
  }).then((response) => response.json());
  assert.equal(removedMember.success, true);
  assert.equal(removedMember.family.members.length, 0);

  const rejectedEmptyFamily = await fetch(`${baseUrl}/api/admin/question-families/${emptyFamily.family.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: emptyFamily.family.name, status: "rejected", members: [] }),
  }).then((response) => response.json());
  assert.equal(rejectedEmptyFamily.success, true);
  assert.equal(rejectedEmptyFamily.family.status, "rejected");

  const deletedEmptyFamily = await fetch(`${baseUrl}/api/admin/question-families/${emptyFamily.family.id}`, {
    method: "DELETE",
  }).then((response) => response.json());
  assert.equal(deletedEmptyFamily.success, true);
  assert.deepEqual(deletedEmptyFamily.removedQuestionIds, []);
  assert.deepEqual(deletedEmptyFamily.ungroupedQuestionIds, []);

  const deletedFamily = await fetch(`${baseUrl}/api/admin/question-families/${groupedFamily.family.id}`, {
    method: "DELETE",
  }).then((response) => response.json());
  assert.equal(deletedFamily.success, true);
  assert.equal(deletedFamily.family.id, groupedFamily.family.id);
  assert.deepEqual(deletedFamily.removedQuestionIds, ["q2", "q1"]);
  const afterDelete = await fetch(`${baseUrl}/api/admin/question-families?bookId=modern-chinese-7-1`).then((response) => response.json());
  assert.equal(afterDelete.families.some((family) => family.id === groupedFamily.family.id), false);
  assert.deepEqual(afterDelete.ungroupedQuestions.map((item) => item.id).sort(), ["q1", "q2"]);

  const moved = await fetch(`${baseUrl}/api/admin/knowledge-structure/nodes/front`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "modern-chinese-7-1", title: "1. 前响复元音", parentId: "compound" }),
  }).then((response) => response.json());
  assert.equal(moved.success, true);
  assert.equal(moved.node.path, "语音 > 元音 > 元音的发音 > 复元音的发音 > 前响复元音");

  const assigned = await fetch(`${baseUrl}/api/admin/knowledge-structure/question-assignments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "modern-chinese-7-1", assignments: [{ questionId: "q1", nodeId: "compound" }] }),
  }).then((response) => response.json());
  assert.equal(assigned.success, true);
  assert.equal(assigned.assignments[0].knowledgePath, "语音 > 元音 > 元音的发音 > 复元音的发音");

  const delivered = await fetch(`${baseUrl}/api/questions/q1`).then((response) => response.json());
  assert.equal(delivered.question.primaryKnowledgePoint, "复元音的发音");
  assert.equal(delivered.question.chapter, "语音 > 元音 > 元音的发音 > 复元音的发音");

  const created = await fetch(`${baseUrl}/api/admin/knowledge-structure/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "modern-chinese-7-1", title: "复元音辨析", parentId: "compound" }),
  }).then((response) => response.json());
  assert.equal(created.success, true);
  assert.match(created.node.id, /^manual-knowledge-node-/);

  const removed = await fetch(`${baseUrl}/api/admin/knowledge-structure/nodes/${created.node.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "modern-chinese-7-1" }),
  }).then((response) => response.json());
  assert.equal(removed.success, true);

  const protectedDelete = await fetch(`${baseUrl}/api/admin/knowledge-structure/nodes/vowel`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "modern-chinese-7-1" }),
  });
  assert.equal(protectedDelete.status, 422);
  assert.equal((await protectedDelete.json()).error, "knowledge_node_has_questions");
});

test("admin API atomically moves selected members to existing and newly created families", async (context) => {
  const q1 = question("api-move-q1", "从来源题族移动到已有题族");
  const q2 = question("api-move-q2", "从来源题族移动到新题族");
  const q3 = question("api-move-q3", "不在来源题族中的题目");
  const questionStore = createMemoryQuestionStore([q1, q2, q3]);
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId: q1.bookId,
    catalogNodes: [
      { id: "move-chapter", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
      { id: "move-section", level: 2, title: "第一节 语音单位", startPage: 2, endPage: 20 },
    ],
    outlineNodes: [
      { id: "move-source", parentId: "move-section", title: "来源知识点", startPage: 3, endPage: 6 },
      { id: "move-target", parentId: "move-section", title: "已有目标题族知识点", startPage: 7, endPage: 10 },
      { id: "move-new-target", parentId: "move-section", title: "新目标题族知识点", startPage: 11, endPage: 14 },
    ],
    chunks: [],
    questions: [q1, q2, q3],
  });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    questionFamilyStore,
    operationLogStore,
    knowledgeStructureStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createFamily = (body) => fetch(`${baseUrl}/api/admin/question-families`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());

  const source = await createFamily({
    bookId: q1.bookId,
    knowledgeNodeId: "move-source",
    name: "批量移动来源题族",
    questionIds: [q1.id, q2.id],
  });
  const target = await createFamily({
    bookId: q1.bookId,
    knowledgeNodeId: "move-target",
    name: "已有目标题族",
  });
  assert.equal(source.success, true);
  assert.equal(target.success, true);
  const q1VersionBefore = questionStore.get(q1.id).version;
  const q2VersionBefore = questionStore.get(q2.id).version;

  const existingResponse = await fetch(`${baseUrl}/api/admin/question-families/${source.family.id}/move-members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionIds: [q1.id],
      target: { mode: "existing", familyId: target.family.id },
    }),
  });
  const existingMove = await existingResponse.json();
  assert.equal(existingResponse.status, 200);
  assert.equal(existingMove.success, true);
  assert.equal(existingMove.targetCreated, false);
  assert.deepEqual(existingMove.sourceFamily.members.map((member) => member.questionId), [q2.id]);
  assert.deepEqual(existingMove.targetFamily.members.map((member) => member.questionId), [q1.id]);
  assert.equal(existingMove.targetFamily.members[0].isPrimary, true);
  assert.equal(questionStore.get(q1.id).version, q1VersionBefore);

  const newResponse = await fetch(`${baseUrl}/api/admin/question-families/${source.family.id}/move-members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionIds: [q2.id],
      target: {
        mode: "new",
        knowledgeNodeId: "move-new-target",
        name: "新建并移动题族",
        prototypeQuestionId: q2.id,
      },
    }),
  });
  const newMove = await newResponse.json();
  assert.equal(newResponse.status, 200);
  assert.equal(newMove.targetCreated, true);
  assert.equal(newMove.sourceFamily.members.length, 0);
  assert.equal(newMove.sourceFamily.source, "manual_empty_family");
  assert.deepEqual(newMove.targetFamily.members.map((member) => [member.questionId, member.role]), [[q2.id, "prototype"]]);
  assert.equal(questionStore.get(q2.id).version, q2VersionBefore);

  const beforeInvalidMove = questionFamilyStore.exportState();
  const invalidResponse = await fetch(`${baseUrl}/api/admin/question-families/${source.family.id}/move-members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionIds: [q3.id],
      target: { mode: "existing", familyId: target.family.id },
    }),
  });
  assert.equal(invalidResponse.status, 409);
  assert.deepEqual(questionFamilyStore.exportState(), beforeInvalidMove);

  const tooManyResponse = await fetch(`${baseUrl}/api/admin/question-families/${source.family.id}/move-members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionIds: Array.from({ length: 101 }, (_, index) => `too-many-${index}`),
      target: { mode: "existing", familyId: target.family.id },
    }),
  });
  const tooMany = await tooManyResponse.json();
  assert.equal(tooManyResponse.status, 422);
  assert.equal(tooMany.error, "question_family_move_too_many_questions");
  const moveActions = operationLogStore.list({ category: "question" }).items.map((item) => item.action);
  assert.equal(moveActions.includes("question_family.members_move"), true);
  assert.equal(moveActions.includes("question_family.create_and_move_members"), true);
});

test("admin batch knowledge assignment reassigns questions and returns affected families to review", async (context) => {
  const questions = [
    question("q1", "声母 b 的发音方法是什么？"),
    question("q2", "声母 p 的发音方法是什么？"),
  ];
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const structure = knowledgeStructureStore.generate({
    bookId: "modern-chinese-7-1",
    catalogNodes: [
      { id: "chapter", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
      { id: "section", level: 2, title: "第一节 辅音与声母", startPage: 2, endPage: 20 },
      { id: "source", level: 3, title: "一、声母的发音", startPage: 3, endPage: 8 },
      { id: "target", level: 3, title: "二、声母辨正", startPage: 9, endPage: 12 },
    ],
    outlineNodes: [],
    chunks: [],
    questions,
  });
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const generated = questionFamilyStore.generate(questions, "modern-chinese-7-1", {
    fingerprints: structure.fingerprints,
  });
  assert.equal(generated.families.length, 1);
  questionFamilyStore.review(generated.families[0].id, {
    status: "confirmed",
    members: generated.families[0].members,
  }, "审核员");

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore: createMemoryQuestionStore(questions),
    questionFamilyStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const reassigned = await fetch(`${baseUrl}/api/admin/questions/batch-knowledge-assignment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bookId: "modern-chinese-7-1",
      questionIds: ["q1", "q2"],
      nodeId: "target",
    }),
  }).then((response) => response.json());

  assert.equal(reassigned.success, true);
  assert.equal(reassigned.assignments.length, 2);
  assert.equal(reassigned.affectedFamilyCount, 2);
  const listing = questionFamilyStore.list({ bookId: "modern-chinese-7-1", status: "all" });
  const preserved = listing.families.find((family) => family.id === generated.families[0].id);
  const candidate = listing.families.find((family) => family.id !== generated.families[0].id
    && family.members.some((member) => member.questionId === "q1"));
  assert.equal(preserved.status, "confirmed");
  assert.equal(preserved.knowledgeNodeId, "source");
  assert.equal(preserved.members.every((member) => member.reviewStatus === "pending_fit"), true);
  assert.equal(candidate.status, "pending_review");
  assert.equal(candidate.knowledgeNodeId, "target");
  assert.equal(candidate.members.every((member) => member.reviewStatus === "pending_fit"), true);

  const delivered = await fetch(`${baseUrl}/api/questions/q1`).then((response) => response.json());
  assert.equal(delivered.question.primaryKnowledgePoint, "声母辨正");
  assert.equal(delivered.question.chapter, "语音 > 辅音与声母 > 声母辨正");
});

test("visible duplicate families and duplicate members collapse to one canonical family", () => {
  const store = createMemoryQuestionFamilyStore({ families: [
    {
      id: "family-canonical",
      bookId: "modern-chinese-7-1",
      knowledgeNodeId: "node-vowel",
      knowledgePath: "第一章 语音 > 元音 > 元音发声特征",
      name: "元音发声特征",
      focusKey: "旧内部键",
      status: "pending_review",
      source: "manual_family",
      createdAt: 1,
      members: [
        { questionId: "q1", role: "prototype", isPrimary: true },
        { questionId: "q1", role: "similar", isPrimary: false },
      ],
    },
    {
      id: "family-duplicate",
      bookId: "modern-chinese-7-1",
      knowledgeNodeId: "node-vowel",
      knowledgePath: "第一章 语音 > 元音 > 元音发声特征",
      name: "元音发声特征",
      focusKey: "另一个内部键",
      status: "confirmed",
      source: "rule_v1",
      createdAt: 2,
      members: [{ questionId: "q2", role: "prototype", isPrimary: true }],
    },
  ] });

  const listing = store.list({ bookId: "modern-chinese-7-1", status: "all" });
  assert.equal(listing.families.length, 1);
  assert.equal(listing.families[0].id, "family-canonical");
  assert.equal(listing.families[0].status, "pending_review");
  assert.equal(listing.families[0].reviewInvalidationReason, "");
  assert.deepEqual(listing.families[0].members.map((member) => member.questionId), ["q1", "q2"]);
  assert.equal(listing.families[0].members.filter((member) => member.questionId === "q1").length, 1);
  assert.equal(listing.families[0].members.find((member) => member.questionId === "q2").reviewStatus, "pending_fit");
  assert.equal(store.get("family-duplicate").id, "family-canonical");
  assert.equal(store.memberships(["q1", "q2"], { status: "all" }).q2[0].familyId, "family-canonical");

  const q2 = question("q2", "同路径同名称题族别名仍可被旧请求解析");
  const changed = store.setMemberships(q2, [{ familyId: "family-duplicate", isPrimary: true }]);
  assert.deepEqual(changed.memberships.map((membership) => membership.familyId), ["family-canonical"]);
  assert.throws(() => store.create({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "node-vowel",
    knowledgePath: "第一章 语音 > 元音 > 元音发声特征",
    name: "元音发声特征",
  }), /question_family_duplicate/);
  const renameTarget = store.create({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "node-vowel",
    knowledgePath: "第一章 语音 > 元音 > 元音发声特征",
    name: "元音发声位置辨析",
  });
  assert.throws(() => store.review(renameTarget.id, {
    name: "元音发声特征",
    status: "pending_review",
  }), /question_family_duplicate/);
  const allowed = store.create({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "node-consonant",
    knowledgePath: "第一章 语音 > 辅音 > 辅音发声特征",
    name: "元音发声特征",
  });
  assert.equal(allowed.knowledgeNodeId, "node-consonant");
  assert.throws(() => store.relocate(allowed.id, {
    knowledgeNodeId: "node-vowel",
    knowledgePath: "第一章 语音 > 元音 > 元音发声特征",
    chapter: "第一章 语音 > 元音 > 元音发声特征",
  }), /question_family_duplicate/);
});

test("visible duplicate consolidation preserves review only when semantics and members are unchanged", () => {
  const base = {
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "node-same",
    knowledgePath: "第一章 语音 > 相同路径",
    name: "相同名称",
    focusKey: "相同考法",
    assessmentAction: "相同考法",
    requiredKnowledgeNodeIds: ["node-same"],
    status: "confirmed",
    reviewedAt: 10,
    reviewedBy: "审核员",
    members: [{ questionId: "same-q", role: "prototype", isPrimary: true }],
  };
  const unchanged = createMemoryQuestionFamilyStore({ families: [
    { ...base, id: "same-manual", source: "manual_family", createdAt: 1 },
    { ...base, id: "same-auto", source: "rule_v1", createdAt: 2 },
  ] }).list({ bookId: base.bookId, status: "all" }).families[0];
  assert.equal(unchanged.id, "same-manual");
  assert.equal(unchanged.status, "confirmed");
  assert.equal(unchanged.reviewedBy, "审核员");

  const memberOnlyChange = createMemoryQuestionFamilyStore({ families: [
    { ...base, id: "members-manual", source: "manual_family", createdAt: 1 },
    {
      ...base,
      id: "members-auto",
      source: "rule_v1",
      createdAt: 2,
      members: [{ questionId: "new-q", role: "similar", isPrimary: true }],
    },
  ] }).list({ bookId: base.bookId, status: "all" }).families[0];
  assert.equal(memberOnlyChange.status, "confirmed");
  assert.equal(memberOnlyChange.reviewedBy, "审核员");
  assert.equal(memberOnlyChange.members.find((member) => member.questionId === "same-q").reviewStatus, "confirmed");
  assert.equal(memberOnlyChange.members.find((member) => member.questionId === "new-q").reviewStatus, "pending_fit");

  const conflicted = createMemoryQuestionFamilyStore({ families: [
    { ...base, id: "conflict-manual", source: "manual_family", createdAt: 1 },
    { ...base, id: "conflict-auto", source: "rule_v1", assessmentAction: "不同考法", createdAt: 2 },
  ] }).list({ bookId: base.bookId, status: "all" }).families[0];
  assert.equal(conflicted.id, "conflict-manual");
  assert.equal(conflicted.status, "pending_review");
  assert.equal(conflicted.reviewedAt, null);
  assert.equal(conflicted.reviewedBy, "");
  assert.equal(conflicted.reviewInvalidationReason, "visible_duplicate_definition_conflict");
});

test("family regeneration reuses a visible manual family instead of creating a same-path duplicate", () => {
  const questions = [
    question("visible-q1", "从发音方法来说，声母 b 是（ ）。"),
    question("visible-q2", "从发音方法看，普通话声母 x 属于（ ）。"),
  ];
  const store = createMemoryQuestionFamilyStore();
  const manual = store.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "consonant",
    knowledgePath: "语音 > 辅音与声母",
    primaryKnowledgePoint: "辅音与声母",
    name: "声母发音方法·阻碍方式",
  });
  store.generate(questions, "modern-chinese-7-1", {
    fingerprints: questions.map((item) => ({
      questionId: item.id,
      primaryNodeId: "consonant",
      primaryKnowledgePoint: "辅音与声母",
      requiredNodeIds: ["consonant"],
      knowledgePath: "语音 > 辅音与声母",
    })),
  });
  const families = store.list({ bookId: "modern-chinese-7-1", status: "all" }).families;
  assert.equal(families.length, 1);
  assert.equal(families[0].id, manual.id);
  assert.equal(families[0].members.length, 2);
});

test("question-family sets form one atomic tree without copying families or questions", () => {
  const store = createMemoryQuestionFamilyStore();
  const createFamily = (name, knowledgeNodeId, questionId) => {
    const family = store.create({
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      knowledgeNodeId,
      knowledgePath: `第一章 语音 > ${name}`,
      primaryKnowledgePoint: name,
      name,
    });
    store.addMembers(family.id, [question(questionId, `${name}测试题`)]);
    return family;
  };
  const vowel = createFamily("元音的发音特征", "node-vowel", "set-q1");
  const final = createFamily("韵母的发声特征", "node-final", "set-q2");
  const consonant = createFamily("辅音的发音特征", "node-consonant", "set-q3");
  const initial = createFamily("声母的发音特征", "node-initial", "set-q4");

  const vowelSet = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "section-vowel",
    name: "元音与韵母发音特征",
    familyIds: [vowel.id, final.id],
  }).set;
  const consonantSet = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "section-consonant",
    name: "辅音与声母发音特征",
    familyIds: [consonant.id, initial.id],
  }).set;
  const parent = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "chapter-speech",
    name: "发音特征",
    childSetIds: [vowelSet.id, consonantSet.id],
  }).set;

  assert.deepEqual(new Set(parent.directChildSetIds), new Set([vowelSet.id, consonantSet.id]));
  assert.equal(parent.familyCount, 4);
  assert.equal(parent.setCount, 2);
  assert.equal(parent.questionCount, 4);
  assert.equal(store.getSet(vowelSet.id).parentSetId, parent.id);
  assert.equal(store.exportState().families.length, 4);
  assert.equal(store.exportState().familySetLinks.filter((link) => link.memberType === "family").length, 4);
  assert.throws(() => store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "chapter-speech",
    name: "发音特征",
  }), /question_family_set_duplicate/);
  const sameNameElsewhere = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "chapter-word",
    name: "发音特征",
  }).set;
  assert.equal(sameNameElsewhere.knowledgeNodeId, "chapter-word");

  const beforeCycle = store.exportState();
  assert.throws(() => store.addSetMembers(vowelSet.id, {
    mode: "move",
    childSetIds: [parent.id],
  }), /question_family_set_cycle/);
  assert.deepEqual(store.exportState(), beforeCycle);
  assert.throws(() => store.removeSet(parent.id), /question_family_set_has_children/);

  const staleRevision = store.getSet(vowelSet.id).revision - 1;
  assert.throws(() => store.addSetMembers(vowelSet.id, {
    expectedRevision: staleRevision,
    familyIds: [consonant.id],
    mode: "move",
  }), /question_family_set_revision_conflict/);

  const detached = store.remove(consonant.id);
  assert.deepEqual(detached.detachedFamilySetIds, [consonantSet.id]);
  assert.equal(store.getSet(consonantSet.id).directFamilyIds.includes(consonant.id), false);
  assert.equal(store.get(initial.id) != null, true);
});

test("creating and editing family sets can atomically move mixed members and detach a set to root", () => {
  const store = createMemoryQuestionFamilyStore();
  const first = store.create({ bookId: "modern-chinese-7-1", knowledgeNodeId: "node-a", knowledgePath: "语音 > A", name: "A题族" });
  const second = store.create({ bookId: "modern-chinese-7-1", knowledgeNodeId: "node-b", knowledgePath: "语音 > B", name: "B题族" });
  const source = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "section",
    name: "来源集",
    familyIds: [first.id],
  }).set;
  const moved = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "section",
    name: "新目标集",
    familyIds: [first.id, second.id],
    mode: "move",
  });
  assert.deepEqual(moved.movedFromSetIds, [source.id]);
  assert.deepEqual(new Set(moved.set.directFamilyIds), new Set([first.id, second.id]));
  assert.equal(store.getSet(source.id).directFamilyCount, 0);

  const parent = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "chapter",
    name: "父集",
    childSetIds: [moved.set.id],
  }).set;
  const childBefore = store.getSet(moved.set.id);
  const detached = store.updateSet(moved.set.id, {
    expectedRevision: childBefore.revision,
    parentSetId: null,
  }).set;
  assert.equal(detached.parentSetId, "");
  assert.equal(store.getSet(parent.id).directSetCount, 0);

  const removed = store.removeSet(detached.id, "审核员", detached.revision);
  assert.deepEqual(new Set(removed.detachedFamilyIds), new Set([first.id, second.id]));
  assert.equal(store.get(first.id) != null, true);
  assert.equal(store.get(second.id) != null, true);
});

test("editing a family set commits metadata, parent and mixed members as one atomic update", () => {
  const store = createMemoryQuestionFamilyStore();
  const family = store.create({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "member-node",
    knowledgePath: "语音 > 成员",
    name: "待迁入题族",
  });
  const familySource = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "source-node",
    name: "题族来源集",
    familyIds: [family.id],
  }).set;
  const child = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "child-node",
    name: "待迁入子集",
  }).set;
  const childSource = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "source-node",
    name: "子集来源集",
    childSetIds: [child.id],
  }).set;
  const target = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "target-node",
    name: "原目标集",
  }).set;
  const oldParent = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "parent-node",
    name: "旧父集",
    childSetIds: [target.id],
  }).set;
  const newParent = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "parent-node",
    name: "新父集",
  }).set;

  const beforeMetadataOnly = store.getSet(target.id);
  const metadataOnly = store.updateSet(target.id, {
    expectedRevision: beforeMetadataOnly.revision,
    name: "只修改名称",
    familyIds: [],
    childSetIds: [],
  });
  assert.equal(metadataOnly.set.name, "只修改名称");
  assert.equal(metadataOnly.set.revision, beforeMetadataOnly.revision + 1);
  assert.deepEqual(metadataOnly.added, []);

  const beforeConflict = store.exportState();
  const targetBeforeConflict = store.getSet(target.id);
  assert.throws(() => store.updateSet(target.id, {
    expectedRevision: targetBeforeConflict.revision,
    name: "不应保存的名称",
    description: "不应保存的说明",
    parentSetId: newParent.id,
    familyIds: [family.id],
    mode: "add",
  }), /question_family_set_member_already_grouped/);
  assert.deepEqual(store.exportState(), beforeConflict);

  const before = new Map([target.id, oldParent.id, newParent.id, familySource.id, childSource.id, child.id]
    .map((setId) => [setId, store.getSet(setId)]));
  const updated = store.updateSet(target.id, {
    expectedRevision: before.get(target.id).revision,
    name: "复合更新后的目标集",
    description: "名称、父级与成员同时保存",
    knowledgeNodeId: "updated-target-node",
    parentSetId: newParent.id,
    familyIds: [family.id],
    childSetIds: [child.id],
    mode: "move",
  }, "审核员");

  assert.equal(updated.set.name, "复合更新后的目标集");
  assert.equal(updated.set.description, "名称、父级与成员同时保存");
  assert.equal(updated.set.knowledgeNodeId, "updated-target-node");
  assert.equal(updated.set.parentSetId, newParent.id);
  assert.deepEqual(new Set(updated.set.directFamilyIds), new Set([family.id]));
  assert.deepEqual(new Set(updated.set.directChildSetIds), new Set([child.id]));
  assert.deepEqual(new Set(updated.added.map((member) => `${member.type}:${member.id}`)), new Set([`family:${family.id}`, `set:${child.id}`]));
  assert.deepEqual(new Set(updated.movedFromSetIds), new Set([familySource.id, childSource.id]));
  assert.equal(updated.set.revision, before.get(target.id).revision + 1);
  [oldParent.id, newParent.id, familySource.id, childSource.id, child.id].forEach((setId) => {
    assert.equal(store.getSet(setId).revision, before.get(setId).revision + 1);
  });
  assert.equal(store.getSet(oldParent.id).directSetCount, 0);
  assert.equal(store.getSet(familySource.id).directFamilyCount, 0);
  assert.equal(store.getSet(childSource.id).directSetCount, 0);
});

test("family-set hierarchy rejects flattening descendants and overlapping selections atomically", () => {
  const store = createMemoryQuestionFamilyStore();
  const nestedFamily = store.create({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "nested-node",
    knowledgePath: "语音 > 元音 > 发音特征",
    name: "下级题族",
  });
  const leaf = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "leaf-node",
    name: "叶子集",
    familyIds: [nestedFamily.id],
  }).set;
  const middle = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "middle-node",
    name: "中间集",
    childSetIds: [leaf.id],
  }).set;
  const root = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "root-node",
    name: "根集",
    childSetIds: [middle.id],
  }).set;
  const target = store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "root-node",
    name: "另一目标集",
  }).set;

  const beforeDirectRepeat = store.exportState();
  assert.throws(() => store.addSetMembers(root.id, {
    mode: "add",
    childSetIds: [middle.id],
  }), /question_family_set_members_unchanged/);
  assert.deepEqual(store.exportState(), beforeDirectRepeat);

  for (const mode of ["add", "move"]) {
    const before = store.exportState();
    assert.throws(() => store.addSetMembers(root.id, {
      mode,
      childSetIds: [leaf.id],
    }), /question_family_set_member_already_in_subtree/);
    assert.deepEqual(store.exportState(), before);
  }

  for (const mode of ["add", "move"]) {
    const before = store.exportState();
    assert.throws(() => store.addSetMembers(root.id, {
      mode,
      familyIds: [nestedFamily.id],
    }), /question_family_set_member_already_in_subtree/);
    assert.deepEqual(store.exportState(), before);
  }

  const beforeAncestorSelection = store.exportState();
  assert.throws(() => store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "root-node",
    name: "祖先后代重叠集",
    mode: "move",
    childSetIds: [middle.id, leaf.id],
  }), /question_family_set_selection_overlap/);
  assert.deepEqual(store.exportState(), beforeAncestorSelection);

  const beforeFamilySelection = store.exportState();
  assert.throws(() => store.createSet({
    bookId: "modern-chinese-7-1",
    knowledgeNodeId: "root-node",
    name: "子集题族重叠集",
    mode: "move",
    childSetIds: [middle.id],
    familyIds: [nestedFamily.id],
  }), /question_family_set_selection_overlap/);
  assert.deepEqual(store.exportState(), beforeFamilySelection);

  const beforeMemberSelection = store.exportState();
  assert.throws(() => store.addSetMembers(target.id, {
    mode: "move",
    childSetIds: [middle.id, leaf.id],
  }), /question_family_set_selection_overlap/);
  assert.deepEqual(store.exportState(), beforeMemberSelection);
});

test("family-set API validates directory scope, exposes enriched items and logs hierarchy changes", async (context) => {
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const q1 = question("set-api-q1", "元音发音特征题");
  const q2 = question("set-api-q2", "辅音发音特征题");
  knowledgeStructureStore.generate({
    bookId: q1.bookId,
    catalogNodes: [
      { id: "set-chapter", level: 1, title: "第一章 语音", startPage: 1, endPage: 20 },
      { id: "set-vowel-section", level: 2, title: "第一节 元音与韵母", startPage: 2, endPage: 10 },
      { id: "set-vowel-node", level: 3, title: "一、元音发音特征", startPage: 3, endPage: 5 },
      { id: "set-consonant-section", level: 2, title: "第二节 辅音与声母", startPage: 11, endPage: 20 },
      { id: "set-consonant-node", level: 3, title: "一、辅音发音特征", startPage: 12, endPage: 15 },
    ],
    outlineNodes: [],
    chunks: [],
    questions: [q1, q2],
  });
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const vowelFamily = questionFamilyStore.create({
    subjectId: q1.subjectId,
    bookId: q1.bookId,
    knowledgeNodeId: "set-vowel-node",
    knowledgePath: "语音 > 元音与韵母 > 元音发音特征",
    name: "元音发音特征",
  });
  questionFamilyStore.addMembers(vowelFamily.id, [q1]);
  const secondVowelFamily = questionFamilyStore.create({
    subjectId: q1.subjectId,
    bookId: q1.bookId,
    knowledgeNodeId: "set-vowel-node",
    knowledgePath: "语音 > 元音与韵母 > 元音发音特征",
    name: "元音发音方式辨析",
  });
  const consonantFamily = questionFamilyStore.create({
    subjectId: q2.subjectId,
    bookId: q2.bookId,
    knowledgeNodeId: "set-consonant-node",
    knowledgePath: "语音 > 辅音与声母 > 辅音发音特征",
    name: "辅音发音特征",
  });
  questionFamilyStore.addMembers(consonantFamily.id, [q2]);
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    questionStore: createMemoryQuestionStore([q1, q2]),
    questionFamilyStore,
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const postSet = (body) => fetch(`${baseUrl}/api/admin/question-family-sets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const invalidResponse = await postSet({
    bookId: q1.bookId,
    knowledgeNodeId: "set-vowel-section",
    name: "错误跨目录集",
    familyIds: [consonantFamily.id],
  });
  assert.equal(invalidResponse.status, 409);
  assert.equal((await invalidResponse.json()).error, "question_family_set_scope_mismatch");

  const vowelResponse = await postSet({
    bookId: q1.bookId,
    knowledgeNodeId: "set-vowel-section",
    name: "元音与韵母发音特征",
    familyIds: [vowelFamily.id],
  });
  assert.equal(vowelResponse.status, 201);
  const vowelSet = (await vowelResponse.json()).set;
  assert.equal(vowelSet.items[0].name, "元音发音特征");
  assert.equal(vowelSet.items[0].knowledgePath.includes("元音发音特征"), true);
  assert.equal(vowelSet.items[0].memberCount, 1);

  const consonantResponse = await postSet({
    bookId: q1.bookId,
    knowledgeNodeId: "set-consonant-section",
    name: "辅音与声母发音特征",
    familyIds: [consonantFamily.id],
  });
  const consonantSet = (await consonantResponse.json()).set;
  const parentResponse = await postSet({
    bookId: q1.bookId,
    knowledgeNodeId: "set-chapter",
    name: "发音特征",
    childSetIds: [vowelSet.id, consonantSet.id],
  });
  const parent = (await parentResponse.json()).set;
  assert.equal(parent.familyCount, 2);
  assert.equal(parent.setCount, 2);
  assert.equal(parent.questionCount, 2);
  assert.equal(parent.items[0].name.length > 0, true);

  const beforeCompoundConflict = questionFamilyStore.exportState();
  const compoundConflictResponse = await fetch(`${baseUrl}/api/admin/question-family-sets/${parent.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: parent.revision,
      name: "不应保存的父集名称",
      description: "不应保存的说明",
      familyIds: [vowelFamily.id],
      mode: "move",
    }),
  });
  assert.equal(compoundConflictResponse.status, 409);
  assert.equal((await compoundConflictResponse.json()).error, "question_family_set_member_already_in_subtree");
  assert.deepEqual(questionFamilyStore.exportState(), beforeCompoundConflict);

  const beforeFlatten = questionFamilyStore.exportState();
  const flattenResponse = await fetch(`${baseUrl}/api/admin/question-family-sets/${parent.id}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "move", familyIds: [vowelFamily.id] }),
  });
  assert.equal(flattenResponse.status, 409);
  assert.equal((await flattenResponse.json()).error, "question_family_set_member_already_in_subtree");
  assert.deepEqual(questionFamilyStore.exportState(), beforeFlatten);

  const overlappingSetsResponse = await postSet({
    bookId: q1.bookId,
    knowledgeNodeId: "set-chapter",
    name: "祖先后代重复选择",
    mode: "move",
    childSetIds: [parent.id, vowelSet.id],
  });
  assert.equal(overlappingSetsResponse.status, 409);
  assert.equal((await overlappingSetsResponse.json()).error, "question_family_set_selection_overlap");
  assert.deepEqual(questionFamilyStore.exportState(), beforeFlatten);

  const overlappingFamilyResponse = await postSet({
    bookId: q1.bookId,
    knowledgeNodeId: "set-chapter",
    name: "子集题族重复选择",
    mode: "move",
    childSetIds: [vowelSet.id],
    familyIds: [vowelFamily.id],
  });
  assert.equal(overlappingFamilyResponse.status, 409);
  assert.equal((await overlappingFamilyResponse.json()).error, "question_family_set_selection_overlap");
  assert.deepEqual(questionFamilyStore.exportState(), beforeFlatten);

  const workspace = await fetch(`${baseUrl}/api/admin/question-families?bookId=${q1.bookId}&query=${encodeURIComponent("不存在")}`).then((response) => response.json());
  assert.equal(workspace.families.length, 0);
  assert.equal(workspace.familySets.length, 3);

  const relocateResponse = await fetch(`${baseUrl}/api/admin/question-families/${vowelFamily.id}/relocate`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ knowledgeNodeId: "set-consonant-node" }),
  });
  assert.equal(relocateResponse.status, 409);
  assert.equal((await relocateResponse.json()).error, "question_family_set_scope_mismatch");

  const deleteParent = await fetch(`${baseUrl}/api/admin/question-family-sets/${parent.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: parent.revision }),
  });
  assert.equal(deleteParent.status, 409);
  assert.equal((await deleteParent.json()).error, "question_family_set_has_children");

  const alternateParent = questionFamilyStore.createSet({
    bookId: q1.bookId,
    knowledgeNodeId: "set-chapter",
    name: "备用发音特征集",
  }).set;
  const vowelBeforeUpdate = questionFamilyStore.getSet(vowelSet.id);
  const parentBeforeUpdate = questionFamilyStore.getSet(parent.id);
  const alternateBeforeUpdate = questionFamilyStore.getSet(alternateParent.id);
  const compoundUpdateResponse = await fetch(`${baseUrl}/api/admin/question-family-sets/${vowelSet.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: vowelBeforeUpdate.revision,
      name: "元音与韵母发音特征（已整理）",
      description: "复合编辑一次保存",
      parentSetId: alternateParent.id,
      familyIds: [secondVowelFamily.id],
      mode: "add",
    }),
  });
  assert.equal(compoundUpdateResponse.status, 200);
  const compoundUpdate = await compoundUpdateResponse.json();
  assert.equal(compoundUpdate.set.name, "元音与韵母发音特征(已整理)");
  assert.equal(compoundUpdate.set.description, "复合编辑一次保存");
  assert.equal(compoundUpdate.set.parentSetId, alternateParent.id);
  assert.deepEqual(compoundUpdate.added, [{ type: "family", id: secondVowelFamily.id }]);
  assert.deepEqual(compoundUpdate.movedFromSetIds, []);
  assert.equal(compoundUpdate.set.revision, vowelBeforeUpdate.revision + 1);
  assert.equal(questionFamilyStore.getSet(parent.id).revision, parentBeforeUpdate.revision + 1);
  assert.equal(questionFamilyStore.getSet(alternateParent.id).revision, alternateBeforeUpdate.revision + 1);
  assert.equal(questionFamilyStore.getSet(parent.id).directChildSetIds.includes(vowelSet.id), false);
  assert.equal(questionFamilyStore.getSet(alternateParent.id).directChildSetIds.includes(vowelSet.id), true);
  const actions = operationLogStore.list({ category: "question" }).items.map((item) => item.action);
  assert.equal(actions.filter((action) => action === "question_family_set.create").length, 3);
  assert.equal(actions.filter((action) => action === "question_family_set.update").length, 1);
});
