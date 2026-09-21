const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  CORE_KNOWLEDGE_ROLES,
  OPTION_KNOWLEDGE_PROTOCOL_VERSION,
  OPTION_KNOWLEDGE_RELATIONS,
  createFileClassificationGoldReviewStore,
} = require("../../apps/api/src/classification-gold-review-store");
const {
  FORMAL_STATE_FILES,
  hashFormalState,
} = require("./classification-blind-replay-state");

const DEFAULT_BATCH_PATH = "D:/\u9f99\u867e\u5de5\u4f5c\u7ad9/outputs/AI\u5206\u5c42\u76f2\u6d4b20\u9898/blind-batch-2026-08-31T22-25-05-927Z-5cd223633c7c";
const DEFAULT_EXPECTED_COUNT = 20;
const DEFAULT_BATCH_ID = "classification-gold-review-blind-batch-2026-08-31-v1";
const DEFAULT_TITLE = "20\u9898\u76f2\u6d4b\u91d1\u6807\u96c6V1";
const DEFAULT_VERSION = "V1";
const AI_AGENT1_PROVENANCE = "ai_agent1_blind_replay";
const AI_AGENT3_PROVENANCE = "ai_agent3_blind_replay";
const HISTORICAL_GOLD_PROVENANCE = "historical_replay_gold_snapshot";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeCoreKnowledgeRole(value) {
  const role = String(value || "").trim();
  return CORE_KNOWLEDGE_ROLES.has(role) ? role : "core";
}

function readJson(filePath, errorCode) {
  const bytes = fs.readFileSync(filePath);
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes, sha256: sha256(bytes) };
  } catch (error) {
    throw new Error(`${errorCode}:${error.message}`);
  }
}

function pathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parsePositiveInteger(value, errorCode) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(errorCode);
  return parsed;
}

function readOptionValue(argv, index, argument) {
  const value = String(argv[index + 1] || "");
  if (!value || value.startsWith("--")) throw new Error(`classification_gold_import_argument_value_required:${argument}`);
  return value;
}

function parseArgs(argv) {
  const options = {
    batchPath: DEFAULT_BATCH_PATH,
    runtimeDir: path.resolve(__dirname, "../../.runtime"),
    storePath: path.resolve(__dirname, "../../.runtime/classification-gold-reviews.json"),
    batchId: DEFAULT_BATCH_ID,
    title: DEFAULT_TITLE,
    version: DEFAULT_VERSION,
    expectedCount: DEFAULT_EXPECTED_COUNT,
    replacePending: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--batch=")) options.batchPath = argument.slice("--batch=".length);
    else if (argument.startsWith("--batch-path=")) options.batchPath = argument.slice("--batch-path=".length);
    else if (argument.startsWith("--runtime-dir=")) options.runtimeDir = argument.slice("--runtime-dir=".length);
    else if (argument.startsWith("--store=")) options.storePath = argument.slice("--store=".length);
    else if (argument.startsWith("--store-path=")) options.storePath = argument.slice("--store-path=".length);
    else if (argument.startsWith("--batch-id=")) options.batchId = argument.slice("--batch-id=".length);
    else if (argument.startsWith("--title=")) options.title = argument.slice("--title=".length);
    else if (argument.startsWith("--version=")) options.version = argument.slice("--version=".length);
    else if (argument.startsWith("--expected-count=")) {
      options.expectedCount = parsePositiveInteger(argument.slice("--expected-count=".length), "classification_gold_import_expected_count_invalid");
    } else if (["--batch", "--batch-path", "--runtime-dir", "--store", "--store-path", "--batch-id", "--title", "--version", "--expected-count"].includes(argument)) {
      const value = readOptionValue(argv, index, argument);
      index += 1;
      if (["--batch", "--batch-path"].includes(argument)) options.batchPath = value;
      else if (argument === "--runtime-dir") options.runtimeDir = value;
      else if (["--store", "--store-path"].includes(argument)) options.storePath = value;
      else if (argument === "--batch-id") options.batchId = value;
      else if (argument === "--title") options.title = value;
      else if (argument === "--version") options.version = value;
      else options.expectedCount = parsePositiveInteger(value, "classification_gold_import_expected_count_invalid");
    } else if (argument === "--replace-pending") options.replacePending = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`classification_gold_import_argument_unknown:${argument}`);
  }
  for (const key of ["batchPath", "runtimeDir", "storePath", "batchId", "title", "version"]) {
    if (!String(options[key] || "").trim()) throw new Error(`classification_gold_import_${key}_required`);
  }
  options.batchPath = path.resolve(options.batchPath);
  options.runtimeDir = path.resolve(options.runtimeDir);
  options.storePath = path.resolve(options.storePath);
  return options;
}

function resolveBatchSummaryPath(batchPath) {
  const stat = fs.statSync(batchPath);
  return stat.isDirectory() ? path.join(batchPath, "\u6279\u6b21\u6c47\u603b.json") : batchPath;
}

function assertHashMap(label, expected, actual) {
  const missing = FORMAL_STATE_FILES.filter((fileName) => !expected?.[fileName] || expected[fileName] === "missing");
  if (missing.length) throw new Error(`classification_gold_import_${label}_baseline_missing:${missing.join(",")}`);
  const differences = FORMAL_STATE_FILES.filter((fileName) => String(expected[fileName]) !== String(actual?.[fileName] || ""));
  if (differences.length) throw new Error(`classification_gold_import_${label}_baseline_mismatch:${differences.join(",")}`);
}

function assertRecordedHashMap(label, expected, actual) {
  const recordedFiles = Object.keys(actual || {});
  if (!recordedFiles.length) throw new Error(`classification_gold_import_${label}_baseline_required`);
  const unknown = recordedFiles.filter((fileName) => !FORMAL_STATE_FILES.includes(fileName));
  if (unknown.length) throw new Error(`classification_gold_import_${label}_baseline_unknown:${unknown.join(",")}`);
  const differences = recordedFiles.filter((fileName) => !expected?.[fileName]
    || String(expected[fileName]) !== String(actual[fileName]));
  if (differences.length) throw new Error(`classification_gold_import_${label}_baseline_mismatch:${differences.join(",")}`);
}

function assertStoreOutsideFormalState(storePath, runtimeDir) {
  const collision = FORMAL_STATE_FILES.find((fileName) => path.resolve(runtimeDir, fileName) === path.resolve(storePath));
  if (collision) throw new Error(`classification_gold_import_store_formal_file_forbidden:${collision}`);
}

function resolveKnowledgeNode(raw, nodeId, fallback = {}) {
  const found = (Array.isArray(raw.knowledgeNodes) ? raw.knowledgeNodes : []).find((node) => node.id === nodeId) || {};
  return {
    id: String(nodeId || fallback.id || fallback.nodeId || found.id || ""),
    title: String(fallback.title || fallback.label || fallback.displayTitle || found.title || found.displayTitle || ""),
    path: String(fallback.path || fallback.knowledgePath || found.path || ""),
  };
}

function resolveKnowledgeNodes(raw, nodeIds, fallbackNodes = []) {
  const fallbackById = new Map((Array.isArray(fallbackNodes) ? fallbackNodes : []).map((node) => [node.id || node.nodeId, node]));
  return [...new Set(Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : [])]
    .map((nodeId) => resolveKnowledgeNode(raw, nodeId, fallbackById.get(nodeId) || {}));
}

function selectedEvidence(raw) {
  const selectedIds = new Set(raw.result?.agent2Verification?.evidenceChunkIds || []);
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).filter((item) => selectedIds.has(item.id));
  if (selectedIds.size !== evidence.length) {
    const foundIds = new Set(evidence.map((item) => item.id));
    const missing = [...selectedIds].filter((id) => !foundIds.has(id));
    throw new Error(`classification_gold_import_selected_evidence_missing:${raw.question?.id}:${missing.join(",")}`);
  }
  if (!evidence.length) throw new Error(`classification_gold_import_selected_evidence_required:${raw.question?.id}`);
  return evidence.map((item) => ({
    ...item,
    chunkId: item.id,
    bookId: raw.question?.bookId || "",
    provenance: "ai_agent3_selected_from_replay_evidence",
  }));
}

function sourceEvidence(raw) {
  return (Array.isArray(raw.evidence) ? raw.evidence : []).map((item) => ({
    ...item,
    chunkId: item.id,
    bookId: raw.question?.bookId || "",
    provenance: "textbook_source_material_unreviewed",
  }));
}

function aiOptionKnowledge(raw) {
  const features = raw.result?.agent1Features?.optionFeatures || [];
  return features.map((feature, index) => {
    const knowledgeNodeIds = feature.matchedNodeIds || [];
    const knowledgeLabels = feature.knowledgeHints || [];
    const explicitRelation = OPTION_KNOWLEDGE_RELATIONS.has(feature.knowledgeRelation)
      && feature.knowledgeRelation !== "unreviewed" ? feature.knowledgeRelation : "unreviewed";
    const optionSpecific = explicitRelation === "option_specific";
    return {
      key: feature.key || raw.question?.options?.[index]?.key,
      text: feature.text || raw.question?.options?.[index]?.text,
      protocolVersion: explicitRelation === "unreviewed" ? "" : OPTION_KNOWLEDGE_PROTOCOL_VERSION,
      knowledgeRelation: explicitRelation,
      knowledgeNodeIds: optionSpecific ? knowledgeNodeIds : [],
      knowledgeLabels: optionSpecific ? knowledgeLabels : [],
      legacyKnowledgeNodeIds: explicitRelation === "unreviewed" ? knowledgeNodeIds : [],
      legacyKnowledgeHints: explicitRelation === "unreviewed" ? knowledgeLabels : [],
      basis: feature.basis || "",
      uncertaintyNote: explicitRelation === "undetermined" ? (feature.uncertaintyNote || feature.basis || "") : "",
      role: feature.role === "answer" ? "answer" : (feature.role === "distractor" ? "distractor" : "neutral"),
      provenance: AI_AGENT1_PROVENANCE,
    };
  });
}

function humanOptionKnowledge(raw) {
  return (raw.question?.options || []).map((option, index) => ({
    key: option.key || String.fromCharCode(65 + index),
    text: option.text || "",
    protocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
    knowledgeRelation: "unreviewed",
    knowledgeNodeIds: [],
    knowledgeLabels: [],
    role: "unreviewed",
    provenance: "human_review_required",
  }));
}

function choiceStructure(raw) {
  return raw.question?.choiceStructure === "composed_options" ? "composed_options" : "direct_options";
}

function humanAtomicStatements(raw) {
  if (choiceStructure(raw) !== "composed_options") return [];
  return (raw.question?.atomicStatements || []).map((statement, index) => ({
    key: statement.key || String(index + 1),
    text: statement.text || "",
    protocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
    knowledgeRelation: "unreviewed",
    basis: "",
    knowledgeNodeIds: [],
    knowledgeLabels: [],
    uncertaintyNote: "",
    verdict: statement.verdict || "",
    provenance: "human_review_required",
  }));
}

function aiAtomicStatements(raw) {
  if (choiceStructure(raw) !== "composed_options") return [];
  const features = raw.result?.agent1Features?.atomicStatements || [];
  return features.map((feature, index) => {
    const knowledgeNodeIds = feature.knowledgeNodeIds || feature.matchedNodeIds || [];
    const knowledgeLabels = feature.knowledgeLabels || feature.knowledgeHints || [];
    const explicitRelation = OPTION_KNOWLEDGE_RELATIONS.has(feature.knowledgeRelation)
      && feature.knowledgeRelation !== "unreviewed" ? feature.knowledgeRelation : "unreviewed";
    return {
      key: feature.key || raw.question?.atomicStatements?.[index]?.key,
      text: feature.text || raw.question?.atomicStatements?.[index]?.text,
      protocolVersion: explicitRelation === "unreviewed" ? "" : OPTION_KNOWLEDGE_PROTOCOL_VERSION,
      knowledgeRelation: explicitRelation,
      basis: feature.basis || "",
      knowledgeNodeIds: explicitRelation === "option_specific" ? knowledgeNodeIds : [],
      knowledgeLabels: explicitRelation === "option_specific" ? knowledgeLabels : [],
      legacyKnowledgeNodeIds: explicitRelation === "unreviewed" ? knowledgeNodeIds : [],
      legacyKnowledgeHints: explicitRelation === "unreviewed" ? knowledgeLabels : [],
      uncertaintyNote: explicitRelation === "undetermined" ? (feature.uncertaintyNote || feature.basis || "") : "",
      verdict: feature.verdict || raw.question?.atomicStatements?.[index]?.verdict || "",
      provenance: AI_AGENT1_PROVENANCE,
    };
  });
}

function businessScoringPoints(raw) {
  return (Array.isArray(raw.question?.scoringPoints) ? raw.question.scoringPoints : [])
    .map((point) => ({ ...point, provenance: point.provenance || "business_question_snapshot" }));
}

function aiScoringPoints(raw) {
  if ((raw.question?.options || []).length) return [];
  const dependencies = raw.result?.agent1Features?.dependencySteps || [];
  return dependencies.filter((step) => step.dependencyRole === "independent_required")
    .map((step, index) => ({
      id: `ai-point-${index + 1}`,
      description: step.label,
      score: 0,
      knowledgeNodeIds: step.nodeIds || [],
      knowledgeLabels: step.label ? [step.label] : [],
      provenance: AI_AGENT1_PROVENANCE,
    }));
}

function enrichFamily(raw, family, provenance) {
  if (!family || typeof family !== "object") return null;
  const coreNodeId = family.coreKnowledgeNodeId || family.knowledgeNodeId || "";
  const requiredNodeIds = family.requiredKnowledgeNodeIds || (coreNodeId ? [coreNodeId] : []);
  const anchorNodeIds = family.textbookAnchorNodeIds || (family.knowledgeNodeId ? [family.knowledgeNodeId] : []);
  return {
    ...family,
    coreKnowledge: resolveKnowledgeNode(raw, coreNodeId, {
      path: family.knowledgePath,
      title: family.primaryKnowledgePoint,
    }),
    requiredKnowledge: resolveKnowledgeNodes(raw, requiredNodeIds),
    textbookAnchors: resolveKnowledgeNodes(raw, anchorNodeIds),
    provenance,
  };
}

function expectedFamilyDecision(raw) {
  if (raw.mode === "mature") return "join_existing";
  if (raw.mode === "singleton" || raw.mode === "unmatched") return "create_new";
  throw new Error(`classification_gold_import_mode_invalid:${raw.question?.id}:${raw.mode}`);
}

function buildItem(raw, resultEntry, index, rawPath, rawSha256) {
  const questionId = String(resultEntry.questionId || "");
  if (raw.question?.id !== questionId) throw new Error(`classification_gold_import_question_mismatch:${questionId}`);
  if (raw.mode !== resultEntry.actualMode || raw.requestedMode !== resultEntry.requestedMode) {
    throw new Error(`classification_gold_import_mode_mismatch:${questionId}`);
  }
  const questionVersion = Number(raw.result?.baseQuestionVersion || raw.job?.baseQuestionVersions?.[questionId] || 0);
  if (!Number.isInteger(questionVersion) || questionVersion < 1) {
    throw new Error(`classification_gold_import_question_version_required:${questionId}`);
  }
  const gold = raw.gold || {};
  const coreKnowledge = resolveKnowledgeNode(raw, gold.primaryNodeId, {
    path: gold.primaryNodePath,
    title: gold.requiredNodes?.find((node) => node.id === gold.primaryNodeId)?.title,
  });
  const coreKnowledgeRole = normalizeCoreKnowledgeRole(gold.primaryNodeRole);
  const requiredKnowledge = resolveKnowledgeNodes(raw, gold.requiredNodeIds, gold.requiredNodes);
  const textbookSourceMaterial = sourceEvidence(raw);
  const agent3SelectedEvidence = selectedEvidence(raw);
  const manualOptionDraft = humanOptionKnowledge(raw);
  const manualAtomicDraft = humanAtomicStatements(raw);
  const officialScoringPoints = businessScoringPoints(raw);
  const agent1OptionCandidate = aiOptionKnowledge(raw);
  const agent1AtomicCandidate = aiAtomicStatements(raw);
  const agent1ScoringCandidate = aiScoringPoints(raw);
  const familyDecision = expectedFamilyDecision(raw);
  const families = (Array.isArray(gold.families) ? gold.families : [])
    .map((family) => enrichFamily(raw, family, HISTORICAL_GOLD_PROVENANCE)).filter(Boolean);
  const aiCandidateDraft = raw.result?.agent2Verification?.candidateFamilyDraft || null;
  const aiCandidateFamily = aiCandidateDraft
    ? enrichFamily(raw, aiCandidateDraft, AI_AGENT3_PROVENANCE)
    : null;
  const historicalPrimaryFamily = families.find((family) => family.id === gold.primaryFamilyId) || null;
  const humanCandidateFamily = raw.mode === "singleton" && historicalPrimaryFamily
    ? {
      ...historicalPrimaryFamily,
      id: "",
      provenance: "historical_hidden_family_baseline",
    }
    : null;
  if (familyDecision === "join_existing" && !gold.primaryFamilyId) {
    throw new Error(`classification_gold_import_primary_family_required:${questionId}`);
  }
  if (raw.mode === "singleton" && !humanCandidateFamily?.name) {
    throw new Error(`classification_gold_import_hidden_family_baseline_required:${questionId}`);
  }
  const relatedFamilyIds = (gold.familyIds || []).filter((familyId) => familyId && familyId !== gold.primaryFamilyId);
  const question = {
    ...raw.question,
    choiceStructure: choiceStructure(raw),
    atomicStatements: choiceStructure(raw) === "composed_options" ? (raw.question?.atomicStatements || []) : [],
    optionComposition: choiceStructure(raw) === "composed_options" ? (raw.question?.optionComposition || []) : [],
    version: questionVersion,
    answerVerified: raw.question.answerReviewStatus === "verified",
  };
  const baselineAnswerKnowledge = {
    correctAnswer: raw.question.correctAnswer,
    referenceAnswer: raw.question.referenceAnswer,
    answerSource: raw.question.answerSource,
    answerReviewStatus: raw.question.answerReviewStatus,
    textbookEvidence: [],
    coreKnowledge,
    coreKnowledgeRole,
    requiredKnowledge,
    optionKnowledge: [],
    optionKnowledgeProtocolVersion: "",
    choiceStructure: choiceStructure(raw),
    atomicStatements: [],
    optionComposition: choiceStructure(raw) === "composed_options" ? (raw.question?.optionComposition || []) : [],
    scoringPoints: officialScoringPoints,
  };
  const baselineFamilyGold = {
    replayMode: raw.mode,
    decision: gold.primaryFamilyId ? "join_existing" : "create_new",
    primaryFamilyId: gold.primaryFamilyId || "",
    relatedFamilyIds,
    families,
    candidateFamily: null,
    reason: "Formal family and knowledge snapshot captured before the replay batch.",
  };
  const manualFamilyGold = {
    replayMode: raw.mode,
    decision: familyDecision,
    primaryFamilyId: raw.mode === "mature" ? (gold.primaryFamilyId || "") : "",
    relatedFamilyIds: raw.mode === "mature" ? relatedFamilyIds : [],
    families,
    candidateFamily: humanCandidateFamily,
    reason: raw.mode === "mature"
      ? "成熟题族留一题场景：请独立判断是否归回既有题族。"
      : (raw.mode === "singleton"
        ? "单题题族隐藏场景：正式历史六维定义仅作基线，请独立裁决是否新建等价题族。"
        : "无匹配场景：请独立确认是否需要新建题族并填写六维定义。"),
  };
  const verification = raw.result?.agent2Verification || {};
  return {
    order: index + 1,
    questionId,
    sourceMode: raw.mode,
    sourceGoldStatus: raw.goldStatus,
    reviewMethod: "human_independent_gold_v1",
    question,
    officialBaseline: {
      question,
      answerKnowledge: baselineAnswerKnowledge,
      familyGold: baselineFamilyGold,
      capturedQuestionVersion: questionVersion,
      provenance: {
        question: "formal_question_replay_snapshot",
        knowledge: HISTORICAL_GOLD_PROVENANCE,
        families: HISTORICAL_GOLD_PROVENANCE,
      },
    },
    sourceMaterials: {
      sourceAnswer: {
        correctAnswer: raw.question.correctAnswer,
        referenceAnswer: raw.question.referenceAnswer,
        answerSource: raw.question.answerSource,
        answerReviewStatus: raw.question.answerReviewStatus,
        provenance: "formal_question_replay_snapshot",
      },
      textbookEvidence: textbookSourceMaterial,
      provenance: "blind_replay_textbook_source_corpus",
    },
    humanGold: {
      answerKnowledge: {
        ...baselineAnswerKnowledge,
        optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
        textbookEvidence: textbookSourceMaterial.map((evidence) => ({ ...evidence, candidateOnly: true })),
        optionKnowledge: manualOptionDraft,
        atomicStatements: manualAtomicDraft,
      },
      answerKnowledgeProvenance: {
        answer: "formal_question_replay_snapshot",
        textbookEvidence: "textbook_source_material_awaiting_human_confirmation",
        coreKnowledge: HISTORICAL_GOLD_PROVENANCE,
        requiredKnowledge: HISTORICAL_GOLD_PROVENANCE,
        optionKnowledge: manualOptionDraft.length ? "human_review_required" : "not_applicable",
        scoringPoints: officialScoringPoints.length ? "business_question_snapshot" : "human_review_required",
        goldOrigin: "human_submission_only",
      },
      familyGold: manualFamilyGold,
      familyGoldProvenance: {
        decision: "blind_replay_mode_policy_awaiting_human_confirmation",
        primaryFamilyId: HISTORICAL_GOLD_PROVENANCE,
        families: HISTORICAL_GOLD_PROVENANCE,
        candidateFamily: humanCandidateFamily ? "historical_hidden_family_baseline" : "human_review_required",
        goldOrigin: "human_submission_only",
      },
    },
    aiCandidates: {
      policy: "reveal_after_corresponding_human_stage_v1",
      validity: "current",
      basedOnQuestionVersion: questionVersion,
      content: {
        textbookEvidence: agent3SelectedEvidence,
        coreKnowledge: resolveKnowledgeNode(raw, verification.primaryNodeId),
        coreKnowledgeRole: normalizeCoreKnowledgeRole(verification.primaryNodeRole),
        requiredKnowledge: resolveKnowledgeNodes(raw, verification.requiredNodeIds),
        optionKnowledge: agent1OptionCandidate,
        optionKnowledgeProtocolVersion: [
          ...agent1OptionCandidate,
          ...agent1AtomicCandidate,
        ].length && [...agent1OptionCandidate, ...agent1AtomicCandidate]
          .every((entry) => entry.knowledgeRelation !== "unreviewed")
          ? OPTION_KNOWLEDGE_PROTOCOL_VERSION : "",
        choiceStructure: choiceStructure(raw),
        atomicStatements: agent1AtomicCandidate,
        optionComposition: choiceStructure(raw) === "composed_options" ? (raw.question?.optionComposition || []) : [],
        scoringPoints: agent1ScoringCandidate,
        questionMode: raw.result?.agent1Features?.questionMode || "",
        reason: verification.contentReason || "",
        agent1: raw.result?.agent1Features || {},
        agent3: {
          contractStatus: verification.agent3ContractStatus || "",
          decision: verification.decision || "",
          uncertainty: verification.uncertainty || "",
          riskHints: verification.riskHints || [],
          evidenceChunkIds: verification.evidenceChunkIds || [],
        },
      },
      family: {
        replayMode: raw.mode,
        decision: verification.familyDecision,
        primaryFamilyId: verification.primaryFamilyId || "",
        relatedFamilyIds: verification.relatedFamilyIds || [],
        families,
        candidateFamily: aiCandidateFamily,
        reason: verification.reason || "",
        confidence: verification.confidence,
        matchedFamilyIds: verification.matchedFamilyIds || [],
        duplicateFamilyIds: verification.duplicateFamilyIds || [],
        similarityReason: verification.familySimilarityReason || "",
        agent3: {
          contractStatus: verification.agent3ContractStatus || "",
          decision: verification.decision || "",
        },
      },
      audit: {
        provenance: "blind_replay_diagnostic_only",
        rawPath,
        rawSha256,
        assessmentStatus: raw.evaluation?.assessmentStatus || "",
        includedInPriorAccuracy: raw.evaluation?.includedInAccuracy === true,
      },
    },
    contentReview: {
      result: "pending_review",
      note: "",
      reviewer: "",
      reviewedAt: 0,
      basedOnKnowledgeDigest: "",
    },
    familyReview: {
      result: "pending_review",
      note: "",
      reviewer: "",
      reviewedAt: 0,
      basedOnKnowledgeDigest: "",
    },
    revision: 1,
  };
}

function validateRawIsolation(raw, baselineHashes) {
  const questionId = raw.question?.id || "unknown";
  if (raw.isolation?.formalStateUnchanged !== true || (raw.isolation?.changedFormalFiles || []).length) {
    throw new Error(`classification_gold_import_replay_isolation_failed:${questionId}`);
  }
  assertHashMap(`replay_before_${questionId}`, baselineHashes, raw.isolation.beforeHashes);
  assertHashMap(`replay_after_${questionId}`, baselineHashes, raw.isolation.afterHashes);
}

function readBatchArtifacts(options) {
  const summaryPath = resolveBatchSummaryPath(options.batchPath);
  const batchDir = path.dirname(summaryPath);
  const summaryRead = readJson(summaryPath, "classification_gold_import_summary_json_invalid");
  const summary = summaryRead.value;
  if (summary.status !== "completed") throw new Error(`classification_gold_import_batch_not_completed:${summary.status || "missing"}`);
  if (!Array.isArray(summary.results) || summary.results.length !== options.expectedCount) {
    throw new Error(`classification_gold_import_result_count_mismatch:${options.expectedCount}:${summary.results?.length || 0}`);
  }
  const questionIds = summary.results.map((entry) => String(entry.questionId || ""));
  if (questionIds.some((questionId) => !questionId) || new Set(questionIds).size !== questionIds.length) {
    throw new Error("classification_gold_import_question_ids_invalid");
  }
  const manifestSnapshotPath = path.resolve(summary.manifestSnapshotPath || path.join(batchDir, "\u6279\u6b21\u6e05\u5355\u5feb\u7167.json"));
  if (!pathInside(manifestSnapshotPath, batchDir)) throw new Error("classification_gold_import_manifest_outside_batch");
  const manifestRead = readJson(manifestSnapshotPath, "classification_gold_import_manifest_json_invalid");
  if (manifestRead.sha256 !== summary.manifestSha256) throw new Error("classification_gold_import_manifest_hash_mismatch");
  assertRecordedHashMap("manifest", summary.baselineHashes, manifestRead.value?.runtimeSnapshot?.files);
  const manifestItems = manifestRead.value.samples || manifestRead.value.items || [];
  const manifestIds = manifestItems.map((item) => String(item.questionId || ""));
  if (manifestIds.length !== questionIds.length || manifestIds.some((questionId, index) => questionId !== questionIds[index])) {
    throw new Error("classification_gold_import_manifest_result_order_mismatch");
  }
  const rawEntries = summary.results.map((entry, index) => {
    const rawPath = path.resolve(path.isAbsolute(entry.rawPath) ? entry.rawPath : path.join(batchDir, entry.rawPath));
    if (!pathInside(rawPath, batchDir)) throw new Error(`classification_gold_import_raw_outside_batch:${entry.questionId}`);
    const rawRead = readJson(rawPath, "classification_gold_import_raw_json_invalid");
    validateRawIsolation(rawRead.value, summary.baselineHashes);
    return { entry, index, rawPath, raw: rawRead.value, rawSha256: rawRead.sha256 };
  });
  return {
    summaryPath,
    summarySha256: summaryRead.sha256,
    batchDir,
    summary,
    manifestSnapshotPath,
    manifestSha256: manifestRead.sha256,
    rawEntries,
  };
}

function buildImportPayload(options, artifacts) {
  return {
    id: options.batchId,
    title: options.title,
    version: options.version,
    status: "reviewing",
    source: {
      kind: "classification_blind_batch_final_replays",
      sourceBatchId: artifacts.summary.batchId,
      batchSummaryPath: artifacts.summaryPath,
      batchSummarySha256: artifacts.summarySha256,
      manifestSnapshotPath: artifacts.manifestSnapshotPath,
      manifestSha256: artifacts.manifestSha256,
      baselineHashes: artifacts.summary.baselineHashes,
      importedBy: "scripts/classification/import-classification-gold-review-batch.js",
      reviewMethod: "human_independent_gold_v1",
      aiComparisonPolicy: "reveal_after_corresponding_human_stage_v1",
      optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
    },
    items: artifacts.rawEntries.map(({ raw, entry, index, rawPath, rawSha256 }) => (
      buildItem(raw, entry, index, rawPath, rawSha256)
    )),
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/classification/import-classification-gold-review-batch.js [options]",
    "",
    "Options:",
    "  --batch <directory-or-summary.json>  Override the default 20-question batch.",
    "  --runtime-dir <directory>            Formal runtime used for strict baseline verification.",
    "  --store <file>                       Gold review draft store path.",
    "  --batch-id <id>                      Review batch id.",
    "  --title <title>                      Review batch title.",
    "  --version <version>                  Snapshot version label.",
    "  --expected-count <number>            Expected final replay count (default: 20).",
    "  --replace-pending                    Replace only an identical, entirely unreviewed batch.",
    "  --dry-run                            Validate and build without importing.",
    "  --help                               Show this help.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  assertStoreOutsideFormalState(options.storePath, options.runtimeDir);
  const artifacts = readBatchArtifacts(options);
  const formalBefore = await hashFormalState(options.runtimeDir);
  assertHashMap("runtime", artifacts.summary.baselineHashes, formalBefore);
  const payload = buildImportPayload(options, artifacts);
  if (payload.items.length !== options.expectedCount
      || payload.items.some((item) => item.contentReview.result !== "pending_review" || item.familyReview.result !== "pending_review")) {
    throw new Error("classification_gold_import_pending_items_invalid");
  }
  let imported = null;
  if (!options.dryRun) {
    const store = createFileClassificationGoldReviewStore(options.storePath);
    imported = options.replacePending ? store.replacePendingBatch(payload) : store.importBatch(payload);
  }
  const formalAfter = await hashFormalState(options.runtimeDir);
  assertHashMap("runtime_after_import", formalBefore, formalAfter);
  const output = {
    dryRun: options.dryRun,
    replacedPending: !options.dryRun && options.replacePending,
    batchId: payload.id,
    title: payload.title,
    version: payload.version,
    itemCount: payload.items.length,
    pendingContentReview: payload.items.filter((item) => item.contentReview.result === "pending_review").length,
    pendingFamilyReview: payload.items.filter((item) => item.familyReview.result === "pending_review").length,
    manifestSha256: artifacts.manifestSha256,
    baselineVerified: true,
    formalStateUnchanged: true,
    storePath: options.dryRun ? null : options.storePath,
    summary: imported?.summary || null,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return { options, artifacts, payload, imported, output };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BATCH_PATH,
  buildImportPayload,
  buildItem,
  main,
  parseArgs,
  readBatchArtifacts,
  selectedEvidence,
};
