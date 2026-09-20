const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildItem,
  parseArgs,
} = require("../scripts/import-classification-gold-review-batch");

function rawReplay(mode = "mature") {
  const family = {
    id: "family-1",
    name: "声带振动判断",
    coreKnowledgeNodeId: "node-1",
    requiredKnowledgeNodeIds: ["node-1"],
    textbookAnchorNodeIds: ["node-1"],
    assessmentAction: "判断清浊音",
    memberQuestionIds: ["q-1", "q-2"],
    independentMemberQuestionIds: ["q-1", "q-2"],
  };
  return {
    mode,
    requestedMode: mode,
    goldStatus: "confirmed",
    question: {
      id: "q-1",
      bookId: "book-1",
      type: "single_choice",
      stem: "下列说法正确的是（ ）。",
      options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
      correctAnswer: ["A"],
      referenceAnswer: "A正确。",
      answerSource: "team_verified",
      answerReviewStatus: "verified",
    },
    gold: {
      primaryNodeId: "node-1",
      primaryNodePath: "语音 > 清浊音",
      requiredNodeIds: ["node-1"],
      requiredNodes: [{ id: "node-1", title: "清浊音", path: "语音 > 清浊音" }],
      primaryFamilyId: mode === "unmatched" ? "" : "family-1",
      familyIds: mode === "unmatched" ? [] : ["family-1"],
      families: mode === "unmatched" ? [] : [family],
    },
    knowledgeNodes: [{ id: "node-1", title: "清浊音", path: "语音 > 清浊音" }],
    evidence: [{
      id: "chunk-1",
      catalogPath: "第一章 > 清浊音",
      printedPageStart: 10,
      excerpt: "声带振动为浊音，不振动为清音。",
    }],
    result: {
      baseQuestionVersion: 3,
      agent1Features: {
        questionMode: "option_judgement",
        optionFeatures: [
          { key: "A", text: "甲", knowledgeHints: ["AI知识甲"], role: "answer" },
          { key: "B", text: "乙", knowledgeHints: ["AI知识乙"], role: "distractor" },
        ],
      },
      agent2Verification: {
        decision: "confirm",
        primaryNodeId: "node-1",
        requiredNodeIds: ["node-1"],
        evidenceChunkIds: ["chunk-1"],
        familyDecision: mode === "mature" ? "join_existing" : "create_new",
        primaryFamilyId: mode === "mature" ? "family-1" : "",
        reason: "Agent 3候选理由",
        candidateFamilyDraft: mode === "mature" ? null : {
          name: "AI候选新题族",
          coreKnowledgeNodeId: "node-1",
          requiredKnowledgeNodeIds: ["node-1"],
          textbookAnchorNodeIds: ["node-1"],
          assessmentAction: "判断清浊音",
        },
      },
    },
    evaluation: { assessmentStatus: "assessed", includedInAccuracy: true },
  };
}

test("gold import keeps Agent 1 and Agent 3 output outside the human draft", () => {
  const raw = rawReplay("mature");
  const item = buildItem(raw, {
    questionId: "q-1",
    actualMode: "mature",
    requestedMode: "mature",
  }, 0, "raw.json", "a".repeat(64));

  assert.equal(item.reviewMethod, "human_independent_gold_v1");
  assert.equal(item.humanGold.answerKnowledge.optionKnowledge[0].role, "unreviewed");
  assert.equal(item.humanGold.answerKnowledge.optionKnowledgeProtocolVersion, "option-knowledge-v2");
  assert.equal(item.humanGold.answerKnowledge.optionKnowledge[0].knowledgeRelation, "unreviewed");
  assert.deepEqual(item.humanGold.answerKnowledge.optionKnowledge[0].knowledgeLabels, []);
  assert.equal(item.humanGold.answerKnowledge.textbookEvidence[0].provenance, "textbook_source_material_unreviewed");
  assert.equal(item.humanGold.answerKnowledge.textbookEvidence[0].candidateOnly, true);
  assert.equal(item.humanGold.answerKnowledge.textbookEvidence[0].candidateOnly, true);
  assert.deepEqual(item.aiCandidates.content.optionKnowledge[0].knowledgeLabels, []);
  assert.equal(item.aiCandidates.content.optionKnowledge[0].knowledgeRelation, "unreviewed");
  assert.equal(item.aiCandidates.content.optionKnowledge[0].legacyKnowledgeHints[0], "AI知识甲");
  assert.equal(item.aiCandidates.content.optionKnowledgeProtocolVersion, "");
  assert.equal(item.aiCandidates.content.textbookEvidence[0].provenance, "ai_agent3_selected_from_replay_evidence");
  assert.equal(item.aiCandidates.content.reason, "");
  assert.equal(item.humanGold.familyGold.candidateFamily, null);
  assert.equal(item.aiCandidates.family.reason, "Agent 3候选理由");
  assert.equal(item.contentReview.result, "pending_review");
  assert.equal(item.familyReview.result, "pending_review");
});

test("gold import maps question focus roles without adding a scope anchor to required knowledge", () => {
  const raw = rawReplay("mature");
  raw.gold.primaryNodeId = "node-scope";
  raw.gold.primaryNodePath = "词汇 > 词汇概说 > 词汇单位";
  raw.gold.primaryNodeRole = "scope_anchor";
  raw.gold.requiredNodeIds = ["node-answer"];
  raw.gold.requiredNodes = [{ id: "node-answer", title: "语素识别", path: "词汇 > 语素识别" }];
  raw.knowledgeNodes.push(
    { id: "node-scope", title: "词汇单位", path: "词汇 > 词汇概说 > 词汇单位" },
    { id: "node-answer", title: "语素识别", path: "词汇 > 语素识别" },
  );
  raw.result.agent2Verification.primaryNodeId = "node-scope";
  raw.result.agent2Verification.primaryNodeRole = "scope_anchor";
  raw.result.agent2Verification.requiredNodeIds = ["node-answer"];

  const item = buildItem(raw, {
    questionId: "q-1",
    actualMode: "mature",
    requestedMode: "mature",
  }, 0, "raw.json", "f".repeat(64));

  assert.equal(item.officialBaseline.answerKnowledge.coreKnowledgeRole, "scope_anchor");
  assert.equal(item.humanGold.answerKnowledge.coreKnowledgeRole, "scope_anchor");
  assert.deepEqual(item.humanGold.answerKnowledge.requiredKnowledge.map((node) => node.id), ["node-answer"]);
  assert.equal(item.aiCandidates.content.coreKnowledgeRole, "scope_anchor");
  assert.deepEqual(item.aiCandidates.content.requiredKnowledge.map((node) => node.id), ["node-answer"]);
});

test("gold import accepts only explicit legal Agent 1 relations and never derives them from hints", () => {
  const raw = rawReplay("mature");
  raw.result.agent1Features.optionFeatures[0].knowledgeRelation = "question_only";
  raw.result.agent1Features.optionFeatures[0].basis = "题目层规则足以判断。";
  raw.result.agent1Features.optionFeatures[1].knowledgeRelation = "option_specific";
  raw.result.agent1Features.optionFeatures[1].basis = "删除该独立规则后无法排除。";
  raw.result.agent1Features.optionFeatures[1].matchedNodeIds = ["node-option-b"];
  const item = buildItem(raw, {
    questionId: "q-1",
    actualMode: "mature",
    requestedMode: "mature",
  }, 0, "raw.json", "e".repeat(64));

  assert.equal(item.aiCandidates.content.optionKnowledgeProtocolVersion, "option-knowledge-v2");
  assert.equal(item.aiCandidates.content.optionKnowledge[0].knowledgeRelation, "question_only");
  assert.deepEqual(item.aiCandidates.content.optionKnowledge[0].knowledgeLabels, []);
  assert.equal(item.aiCandidates.content.optionKnowledge[1].knowledgeRelation, "option_specific");
  assert.deepEqual(item.aiCandidates.content.optionKnowledge[1].knowledgeNodeIds, ["node-option-b"]);
});

test("gold import never reuses the family verification reason during content review", () => {
  const raw = rawReplay("mature");
  raw.result.agent2Verification.reason = "FAMILY_REASON_SENTINEL";
  raw.result.agent2Verification.contentReason = "独立的答案与知识候选说明";
  const withContentReason = buildItem(raw, {
    questionId: "q-1",
    actualMode: "mature",
    requestedMode: "mature",
  }, 0, "raw.json", "c".repeat(64));

  assert.equal(withContentReason.aiCandidates.content.reason, "独立的答案与知识候选说明");
  assert.equal(withContentReason.aiCandidates.family.reason, "FAMILY_REASON_SENTINEL");

  delete raw.result.agent2Verification.contentReason;
  const withoutContentReason = buildItem(raw, {
    questionId: "q-1",
    actualMode: "mature",
    requestedMode: "mature",
  }, 0, "raw.json", "d".repeat(64));
  assert.equal(withoutContentReason.aiCandidates.content.reason, "");
  assert.equal(withoutContentReason.aiCandidates.family.reason, "FAMILY_REASON_SENTINEL");
});

test("singleton human draft uses the hidden formal family, not the Agent 3 family draft", () => {
  const raw = rawReplay("singleton");
  const item = buildItem(raw, {
    questionId: "q-1",
    actualMode: "singleton",
    requestedMode: "singleton",
  }, 0, "raw.json", "b".repeat(64));

  assert.equal(item.humanGold.familyGold.decision, "create_new");
  assert.equal(item.humanGold.familyGold.candidateFamily.name, "声带振动判断");
  assert.equal(item.humanGold.familyGold.candidateFamily.provenance, "historical_hidden_family_baseline");
  assert.equal(item.aiCandidates.family.candidateFamily.name, "AI候选新题族");
});

test("replace-pending import mode is explicit", () => {
  assert.equal(parseArgs(["--replace-pending", "--dry-run"]).replacePending, true);
});
