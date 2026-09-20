const assert = require("node:assert/strict");
const test = require("node:test");
const {
  OPTION_KNOWLEDGE_PROTOCOL_VERSION,
  extractQuestionClassificationFeatures,
  normalizeFeatureProfile,
  validateFeatureProfileContract,
} = require("../apps/api/src/question-classification-features");

test("heuristic features preserve raw hints without guessing option knowledge relations", () => {
  const question = {
    stem: "下列关于清音和浊音的说法，正确的是（ ）。",
    type: "single_choice",
    options: [
      { key: "A", text: "清音和浊音根据声带是否振动区分" },
      { key: "B", text: "塞音和擦音根据阻碍方式区分" },
      { key: "C", text: "送气音根据气流强弱区分" },
    ],
    correctAnswer: ["A"],
    knowledgePoints: ["辅音的发音方法"],
  };
  const structure = {
    nodes: [
      { id: "voicing", kind: "knowledge", title: "看声带是否振动", parentId: "method" },
      { id: "obstruction", kind: "knowledge", title: "看阻碍方式", parentId: "method" },
      { id: "airflow", kind: "knowledge", title: "看气流强弱", parentId: "method" },
    ],
  };
  const features = extractQuestionClassificationFeatures(question, structure);
  assert.equal(features.questionMode, "option_judgement");
  assert.equal(features.optionFeatures.length, 3);
  assert.equal(features.optionFeatures[0].weight, 0.4);
  assert.equal(Math.round(features.optionFeatures.slice(1).reduce((sum, item) => sum + item.weight, 0) * 10), 6);
  assert.deepEqual(features.optionFeatures.map((item) => item.knowledgeRelation), ["unreviewed", "unreviewed", "unreviewed"]);
  assert.deepEqual(features.optionFeatures.map((item) => item.matchedNodeIds), [[], [], []]);
  assert.deepEqual(features.optionFeatures.map((item) => item.legacyKnowledgeHints[0]), ["声带是否振动", "阻碍方式", "气流强弱"]);
  assert.deepEqual(features.optionFeatures.map((item) => item.decisionRole), ["supports_answer", "required_for_elimination", "required_for_elimination"]);
  assert.equal(features.optionFeatures.every((item) => item.requiredForDecision === false), true);
  assert.deepEqual(features.coreKnowledgeNodeIds, ["voicing"]);
  assert.deepEqual(features.requiredKnowledgeNodeIds, ["voicing"]);
  assert.equal(features.knowledgePriorities[0].role, "primary");
  assert.equal(features.knowledgePriorities.slice(1).every((item) => item.role === "secondary"), true);
  assert.equal(features.dependencySteps[0].necessity, "core");
  assert.equal(features.dependencySteps.slice(1).every((item) => item.necessity === "incidental"), true);
  assert.equal(features.callDepth >= 3, true);
  assert.equal(features.crossFamilyProbability > 0.4, true);
});

test("Agent 1 V2 contract accepts direct relations and rejects inferred or incomplete values", () => {
  const question = {
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
  };
  const profile = {
    optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
    choiceStructure: "direct_options",
    optionFeatures: [{
      key: "A",
      knowledgeRelation: "question_only",
      knowledgeHints: [],
      basis: "删除该项候选知识后，题目层规则仍能判断。",
    }, {
      key: "B",
      knowledgeRelation: "option_specific",
      knowledgeHints: ["乙的专属规则"],
      basis: "删除该规则后无法排除 B。",
    }],
    atomicStatements: [],
    optionComposition: [],
  };
  assert.equal(validateFeatureProfileContract(profile, question), profile);
  assert.throws(() => validateFeatureProfileContract({
    ...profile,
    optionFeatures: profile.optionFeatures.map((item) => ({ ...item, knowledgeRelation: undefined })),
  }, question), (error) => error.message === "knowledge_feature_extraction_contract_invalid"
    && error.contractViolations.some((item) => item.code === "option_relation_invalid"));
  const normalizedLegacy = normalizeFeatureProfile({
    optionFeatures: [{ key: "A", knowledgeHints: ["旧 AI 提示"] }],
  });
  assert.equal(normalizedLegacy.optionFeatures[0].knowledgeRelation, "unreviewed");
  assert.deepEqual(normalizedLegacy.optionFeatures[0].knowledgeHints, []);
  assert.deepEqual(normalizedLegacy.optionFeatures[0].legacyKnowledgeHints, ["旧 AI 提示"]);
});

test("Agent 1 V2 contract keeps composed-option knowledge on atomic statements", () => {
  const question = { options: [{ key: "A" }, { key: "B" }] };
  const profile = {
    optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
    choiceStructure: "composed_options",
    optionFeatures: [{ key: "A", basis: "组合答案" }, { key: "B", basis: "组合答案" }],
    atomicStatements: [{
      key: "①", text: "陈述一", knowledgeRelation: "question_only", knowledgeHints: [], basis: "题目规则足够",
    }, {
      key: "②", text: "陈述二", knowledgeRelation: "undetermined", knowledgeHints: [], uncertaintyNote: "教材证据不足", basis: "暂不能确认",
    }],
    optionComposition: [{ optionKey: "A", atomicKeys: ["①"] }, { optionKey: "B", atomicKeys: ["①", "②"] }],
  };
  assert.equal(validateFeatureProfileContract(profile, question), profile);
  const normalized = normalizeFeatureProfile(profile);
  assert.deepEqual(normalized.atomicStatements.map((item) => item.key), ["①", "②"]);
  const forbiddenOptionKnowledgeFields = [
    "knowledgeRelation",
    "knowledgeHints",
    "legacyKnowledgeHints",
    "matchedNodeIds",
    "uncertaintyNote",
  ];
  normalized.optionFeatures.forEach((option) => {
    forbiddenOptionKnowledgeFields.forEach((field) => assert.equal(
      Object.prototype.hasOwnProperty.call(option, field),
      false,
      `${option.key} must not persist ${field}`,
    ));
  });
  assert.throws(() => validateFeatureProfileContract({
    ...profile,
    optionFeatures: [{ ...profile.optionFeatures[0], knowledgeRelation: "question_only" }, profile.optionFeatures[1]],
  }, question), (error) => error.contractViolations.some((item) => item.code === "composed_option_knowledge_forbidden"));
});
