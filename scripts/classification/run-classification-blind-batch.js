const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readFrozenGoldSnapshot } = require("../../apps/api/src/classification-gold-review-store");

const {
  FORMAL_STATE_FILES,
  hashFormalState,
} = require("./classification-blind-replay-state");
const {
  buildReplayContextPreflight,
  readReplayContext,
  replayModeDistributions,
  writePreflightReport,
} = require("./classification-blind-replay-context");

const DEFAULT_EXPECTED_COUNT = 20;
const DEFAULT_MAX_TECHNICAL_RETRIES = 2;
const DEFAULT_RETRY_DELAYS_MS = [10_000, 30_000];
const REQUIRED_MODES = ["mature", "singleton", "unmatched"];
const MODES = new Set(REQUIRED_MODES);
const RUN_KINDS = new Set(["calibration", "gate", "diagnostic", "contract_smoke"]);
const GOLD_STATUSES = new Set(["auto", "confirmed", "gold_needs_review"]);
const UNMATCHED_GOLD_STATUSES = new Set(["unreviewed", "confirmed"]);

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function pathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertOutputOutsideRuntime(outputPath, runtimeDir) {
  if (pathInside(outputPath, runtimeDir)) throw new Error("blind_batch_output_runtime_forbidden");
}

function parseNonNegativeInteger(value, errorCode) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(errorCode);
  return parsed;
}

function normalizeRetryDelays(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  if (values.length !== 2) throw new Error("blind_batch_retry_delays_invalid");
  return values.map((entry) => parseNonNegativeInteger(entry, "blind_batch_retry_delays_invalid"));
}

function parseArgs(argv) {
  const options = {
    manifestPath: "",
    goldSnapshotPath: "",
    replayContextPath: "",
    outputRoot: "",
    expectedCount: DEFAULT_EXPECTED_COUNT,
    maxTechnicalRetries: DEFAULT_MAX_TECHNICAL_RETRIES,
    retryDelaysMs: [...DEFAULT_RETRY_DELAYS_MS],
    timeoutMs: undefined,
    runKind: "diagnostic",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--gold-snapshot=")) options.goldSnapshotPath = argument.slice("--gold-snapshot=".length);
    else if (argument === "--gold-snapshot") options.goldSnapshotPath = String(argv[++index] || "");
    else if (argument.startsWith("--replay-context=")) options.replayContextPath = argument.slice("--replay-context=".length);
    else if (argument === "--replay-context") options.replayContextPath = String(argv[++index] || "");
    else if (argument.startsWith("--manifest=")) options.manifestPath = argument.slice("--manifest=".length);
    else if (argument.startsWith("--output-root=")) options.outputRoot = argument.slice("--output-root=".length);
    else if (argument.startsWith("--run-kind=")) options.runKind = argument.slice("--run-kind=".length);
    else if (argument.startsWith("--expected-count=")) {
      options.expectedCount = parseNonNegativeInteger(argument.slice("--expected-count=".length), "blind_batch_expected_count_invalid");
    } else if (argument.startsWith("--max-technical-retries=")) {
      options.maxTechnicalRetries = parseNonNegativeInteger(argument.slice("--max-technical-retries=".length), "blind_batch_max_technical_retries_invalid");
    } else if (argument.startsWith("--retry-delays-ms=")) {
      options.retryDelaysMs = normalizeRetryDelays(argument.slice("--retry-delays-ms=".length));
    } else if (argument.startsWith("--timeout-ms=")) {
      options.timeoutMs = parseNonNegativeInteger(argument.slice("--timeout-ms=".length), "blind_batch_timeout_invalid");
    } else if (argument === "--manifest") options.manifestPath = String(argv[++index] || "");
    else if (argument === "--output-root") options.outputRoot = String(argv[++index] || "");
    else if (argument === "--run-kind") options.runKind = String(argv[++index] || "");
    else if (argument === "--expected-count") {
      options.expectedCount = parseNonNegativeInteger(argv[++index], "blind_batch_expected_count_invalid");
    } else if (argument === "--max-technical-retries") {
      options.maxTechnicalRetries = parseNonNegativeInteger(argv[++index], "blind_batch_max_technical_retries_invalid");
    } else if (argument === "--retry-delays-ms") {
      options.retryDelaysMs = normalizeRetryDelays(argv[++index]);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = parseNonNegativeInteger(argv[++index], "blind_batch_timeout_invalid");
    } else if (argument === "--help") options.help = true;
    else throw new Error(`blind_batch_argument_unknown:${argument}`);
  }
  if (!options.help && !options.goldSnapshotPath) throw new Error("blind_batch_gold_snapshot_required");
  if (!options.help && !options.replayContextPath) throw new Error("blind_batch_replay_context_required");
  if (!options.help && options.manifestPath) {
    throw new Error("blind_batch_manifest_not_supported_use_frozen_gold_snapshot");
  }
  if (!options.help && options.expectedCount < 1) throw new Error("blind_batch_expected_count_invalid");
  if (!options.help && options.maxTechnicalRetries > DEFAULT_MAX_TECHNICAL_RETRIES) {
    throw new Error("blind_batch_max_technical_retries_invalid");
  }
  if (!options.help && !RUN_KINDS.has(options.runKind)) throw new Error("blind_batch_run_kind_invalid");
  return options;
}

function readAndValidateGoldSnapshot(snapshotPath, expectedCount = DEFAULT_EXPECTED_COUNT) {
  const loaded = readFrozenGoldSnapshot(snapshotPath, { requireSidecar: true });
  const samples = loaded.snapshot.items;
  if (samples.length !== expectedCount) {
    throw new Error(`blind_batch_expected_count_mismatch:${expectedCount}:${samples.length}`);
  }
  const items = samples.map((item, index) => {
    const normalized = {
      questionId: String(item.questionId || "").trim(),
      mode: String(item.replayMode || "").trim(),
      goldStatus: String(item.goldStatus || "").trim(),
      includedInAccuracy: item.includedInAccuracy !== false
        && String(item.goldStatus || "").trim() !== "gold_needs_review",
      unmatchedGoldStatus: item.replayMode === "unmatched" ? "confirmed" : "unreviewed",
    };
    if (!normalized.questionId) throw new Error(`blind_batch_question_id_required:${index + 1}`);
    if (!MODES.has(normalized.mode)) throw new Error(`blind_batch_mode_invalid:${index + 1}:${normalized.mode}`);
    if (!["confirmed", "gold_needs_review"].includes(normalized.goldStatus)) {
      throw new Error(`blind_batch_gold_status_invalid:${index + 1}:${normalized.goldStatus}`);
    }
    return normalized;
  });
  if (new Set(items.map((item) => item.questionId)).size !== items.length) {
    throw new Error("blind_batch_duplicate_question_id");
  }
  const modeDistributions = replayModeDistributions(items);
  return {
    snapshot: loaded.snapshot,
    items,
    distribution: modeDistributions.total,
    scoreableDistribution: modeDistributions.scoreable,
    disputedDistribution: modeDistributions.disputed,
    modeDistributions,
    snapshotPath: loaded.filePath,
    raw: loaded.bytes,
    sha256: loaded.fileSha256,
    contentSha256: loaded.contentSha256,
  };
}

function readAndValidateManifest(manifestPath, expectedCount = DEFAULT_EXPECTED_COUNT) {
  const absolutePath = path.resolve(manifestPath);
  const raw = fs.readFileSync(absolutePath);
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`blind_batch_manifest_json_invalid:${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("blind_batch_manifest_items_required");
  }
  const manifestItems = Array.isArray(manifest.items)
    ? manifest.items
    : (Array.isArray(manifest.samples) ? manifest.samples : null);
  if (!manifestItems) throw new Error("blind_batch_manifest_items_required");
  if (manifestItems.length !== expectedCount) {
    throw new Error(`blind_batch_expected_count_mismatch:${expectedCount}:${manifestItems.length}`);
  }

  const items = manifestItems.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`blind_batch_item_invalid:${index + 1}`);
    }
    const normalized = {
      questionId: String(item.questionId || "").trim(),
      mode: String(item.mode || "").trim(),
      goldStatus: String(item.goldStatus || "").trim(),
      includedInAccuracy: String(item.goldStatus || "").trim() !== "gold_needs_review",
      unmatchedGoldStatus: String(item.unmatchedGoldStatus || (item.mode === "unmatched" ? "" : "unreviewed")).trim(),
    };
    if (!normalized.questionId) throw new Error(`blind_batch_question_id_required:${index + 1}`);
    if (!MODES.has(normalized.mode)) throw new Error(`blind_batch_mode_invalid:${index + 1}:${normalized.mode}`);
    if (!GOLD_STATUSES.has(normalized.goldStatus)) {
      throw new Error(`blind_batch_gold_status_invalid:${index + 1}:${normalized.goldStatus}`);
    }
    if (!UNMATCHED_GOLD_STATUSES.has(normalized.unmatchedGoldStatus)) {
      throw new Error(`blind_batch_unmatched_gold_status_invalid:${index + 1}:${normalized.unmatchedGoldStatus}`);
    }
    return normalized;
  });

  const seen = new Set();
  items.forEach((item) => {
    if (seen.has(item.questionId)) throw new Error(`blind_batch_duplicate_question_id:${item.questionId}`);
    seen.add(item.questionId);
  });
  const modeDistributions = replayModeDistributions(items);
  const distribution = modeDistributions.total;
  const missingModes = REQUIRED_MODES.filter((mode) => distribution[mode] === 0);
  if (missingModes.length) throw new Error(`blind_batch_mode_distribution_missing:${missingModes.join(",")}`);

  return {
    manifest,
    items,
    distribution,
    scoreableDistribution: modeDistributions.scoreable,
    disputedDistribution: modeDistributions.disputed,
    modeDistributions,
    manifestPath: absolutePath,
    raw,
    sha256: sha256(raw),
  };
}

function hashDifferences(expected, actual) {
  const names = new Set([...FORMAL_STATE_FILES, ...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  return [...names].filter((fileName) => String(expected?.[fileName] || "") !== String(actual?.[fileName] || ""));
}

function assertCompleteFormalHashes(hashes) {
  const missing = FORMAL_STATE_FILES.filter((fileName) => !hashes?.[fileName] || hashes[fileName] === "missing");
  if (missing.length) throw new Error(`blind_batch_formal_file_missing:${missing.join(",")}`);
}

function auditReplayIsolation(report, baselineHashes, observedBeforeHashes, observedAfterHashes) {
  const isolation = report?.isolation;
  const failures = [];
  const observedBeforeDifferences = hashDifferences(baselineHashes, observedBeforeHashes);
  const observedAfterDifferences = hashDifferences(baselineHashes, observedAfterHashes);
  const reportBeforeDifferences = hashDifferences(baselineHashes, isolation?.beforeHashes || {});
  const reportAfterDifferences = hashDifferences(baselineHashes, isolation?.afterHashes || {});
  if (observedBeforeDifferences.length) failures.push(`observed_before:${observedBeforeDifferences.join(",")}`);
  if (observedAfterDifferences.length) failures.push(`observed_after:${observedAfterDifferences.join(",")}`);
  if (!isolation) failures.push("report_isolation_missing");
  if (reportBeforeDifferences.length) failures.push(`report_before:${reportBeforeDifferences.join(",")}`);
  if (reportAfterDifferences.length) failures.push(`report_after:${reportAfterDifferences.join(",")}`);
  if (isolation?.formalStateUnchanged !== true) failures.push("report_formal_state_unchanged_not_true");
  if (!Array.isArray(isolation?.changedFormalFiles) || isolation.changedFormalFiles.length > 0) {
    failures.push(`report_changed_files:${(isolation?.changedFormalFiles || ["missing"]).join(",")}`);
  }
  return {
    passed: failures.length === 0,
    failures,
    observedBeforeHashes,
    observedAfterHashes,
    reportBeforeHashes: isolation?.beforeHashes || null,
    reportAfterHashes: isolation?.afterHashes || null,
  };
}

function isRetryableTechnicalFailure(report) {
  const evaluation = report?.evaluation || {};
  if (evaluation.assessmentStatus !== "unassessed" || evaluation.executionFailed !== true) return false;
  const code = String(evaluation.executionFailureCode || "").trim().toLowerCase();
  if (!code || code === "agent3_contract_failed" || /contract|output_format|validation/u.test(code)) return false;
  return /timeout|timed.?out|network|fetch|provider|upstream|rate.?limit|too.?many.?requests|auth|unauthori[sz]ed|forbidden|connection|econn|socket|dns|unavailable|overload/u.test(code);
}

function resultSummary(item, attempts, report) {
  const evaluation = report.evaluation;
  const candidateFamilyDraft = evaluation.candidateFamilyDraft
    && typeof evaluation.candidateFamilyDraft === "object"
    ? evaluation.candidateFamilyDraft : null;
  const reportedContractStatus = evaluation.agent3ContractStatus
    || evaluation.contractStatus
    || evaluation.contract?.status
    || report.result?.agent2Verification?.agent3ContractStatus
    || (evaluation.executionFailureCode === "agent3_contract_failed" ? "failed" : "");
  return {
    questionId: item.questionId,
    requestedMode: item.mode,
    actualMode: report.mode || "",
    goldStatus: report.goldStatus || evaluation.goldStatus || item.goldStatus,
    unmatchedGoldStatus: report.unmatchedGoldStatus || evaluation.unmatchedGoldStatus || item.unmatchedGoldStatus,
    attemptCount: attempts.length,
    retried: attempts.length > 1,
    assessmentStatus: evaluation.assessmentStatus,
    executionFailed: evaluation.executionFailed === true,
    executionFailureCode: evaluation.executionFailureCode || "",
    includedInAccuracy: evaluation.includedInAccuracy === true,
    modelGeneralizationSuccess: evaluation.modelGeneralizationSuccess === true,
    countedResult: evaluation.countedResult === null ? null : evaluation.countedResult === true,
    coreKnowledgeExact: typeof evaluation.coreKnowledgeExact === "boolean" ? evaluation.coreKnowledgeExact : null,
    requiredKnowledge: evaluation.requiredKnowledge || {},
    optionKnowledge: evaluation.optionKnowledge || { applicable: false },
    primaryFamilyExact: typeof evaluation.primaryFamilyExact === "boolean" ? evaluation.primaryFamilyExact : null,
    primaryFamilyMetricApplicable: evaluation.primaryFamilyMetricApplicable === true,
    familyMemberships: evaluation.familyMemberships || {},
    familyDecision: String(evaluation.familyDecision || ""),
    unresolved: evaluation.unresolved === true,
    candidateFamilyDraftProposed: evaluation.candidateFamilyDraftProposed === true
      || candidateFamilyDraft?.proposed === true,
    candidateFamilyDraft,
    hiddenGoldFamilyIdReturned: evaluation.hiddenGoldFamilyIdReturned === true,
    agent3ContractStatus: String(reportedContractStatus || ""),
    retrySummary: {
      providerRetryCount: Number(report.retrySummary?.providerRetryCount) || 0,
      constraintRetryCount: Number(report.retrySummary?.constraintRetryCount) || 0,
      fallbackAttemptCount: Number(report.retrySummary?.fallbackAttemptCount) || 0,
      totalRetryCount: Number(report.retrySummary?.totalRetryCount) || 0,
      firstFailureReason: String(report.retrySummary?.firstFailureReason || ""),
    },
    reportPath: attempts.at(-1)?.reportPath || "",
    rawPath: attempts.at(-1)?.rawPath || "",
  };
}

const RELATION_GOLD_CLASSES = ["question_only", "option_specific"];
const RELATION_PREDICTION_CLASSES = ["question_only", "option_specific", "undetermined", "unreviewed", "missing", "invalid"];

function metricRatio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function aggregateNodeMetrics(items, field) {
  const totals = items.reduce((sum, item) => {
    const metric = item.optionKnowledge?.[field] || {};
    sum.truePositive += Number(metric.truePositive) || 0;
    sum.falsePositive += Number(metric.falsePositive) || 0;
    sum.falseNegative += Number(metric.falseNegative) || 0;
    sum.unitCount += Number(metric.unitCount) || 0;
    return sum;
  }, { truePositive: 0, falsePositive: 0, falseNegative: 0, unitCount: 0 });
  const precision = metricRatio(totals.truePositive, totals.truePositive + totals.falsePositive);
  const recall = metricRatio(totals.truePositive, totals.truePositive + totals.falseNegative);
  return {
    ...totals,
    precision,
    recall,
    f1: precision === null || recall === null || precision + recall === 0
      ? (precision === 0 || recall === 0 ? 0 : null)
      : (2 * precision * recall) / (precision + recall),
  };
}

function aggregateOptionKnowledgeMetrics(results) {
  const items = results.filter((item) => item.optionKnowledge?.applicable === true);
  const confusionMatrix = Object.fromEntries(RELATION_GOLD_CLASSES.map((goldClass) => [
    goldClass,
    Object.fromEntries(RELATION_PREDICTION_CLASSES.map((predictionClass) => [predictionClass, 0])),
  ]));
  items.forEach((item) => {
    RELATION_GOLD_CLASSES.forEach((goldClass) => {
      RELATION_PREDICTION_CLASSES.forEach((predictionClass) => {
        confusionMatrix[goldClass][predictionClass] += Number(
          item.optionKnowledge.confusionMatrix?.[goldClass]?.[predictionClass],
        ) || 0;
      });
    });
  });
  const perClass = Object.fromEntries(RELATION_GOLD_CLASSES.map((className) => {
    const truePositive = confusionMatrix[className][className];
    const support = Object.values(confusionMatrix[className]).reduce((sum, count) => sum + count, 0);
    const predicted = RELATION_GOLD_CLASSES.reduce(
      (sum, goldClass) => sum + confusionMatrix[goldClass][className],
      0,
    );
    const precision = metricRatio(truePositive, predicted);
    const recall = metricRatio(truePositive, support);
    const f1 = precision === null || recall === null || precision + recall === 0
      ? (precision === 0 || recall === 0 ? 0 : null)
      : (2 * precision * recall) / (precision + recall);
    return [className, { support, predicted, truePositive, precision, recall, f1 }];
  }));
  const eligibleCount = items.reduce((sum, item) => sum + (Number(item.optionKnowledge.eligibleCount) || 0), 0);
  const correctCount = items.reduce((sum, item) => sum + (Number(item.optionKnowledge.correctCount) || 0), 0);
  const exactItems = items.filter((item) => item.optionKnowledge.questionExact !== null);
  const falseAbstentionCount = items.reduce(
    (sum, item) => sum + (Number(item.optionKnowledge.falseAbstentionCount) || 0),
    0,
  );
  const goldUndeterminedCount = items.reduce(
    (sum, item) => sum + (Number(item.optionKnowledge.goldUndetermined?.count) || 0),
    0,
  );
  const goldUndeterminedPredictedCount = items.reduce(
    (sum, item) => sum + (Number(item.optionKnowledge.goldUndetermined?.predictedUndeterminedCount) || 0),
    0,
  );
  const f1Values = RELATION_GOLD_CLASSES.map((className) => perClass[className].f1).filter((value) => value !== null);
  return {
    applicableQuestionCount: items.length,
    eligibleCount,
    correctCount,
    accuracy: metricRatio(correctCount, eligibleCount),
    confusionMatrix,
    perClass,
    macroF1: f1Values.length ? f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length : null,
    questionExactCount: exactItems.filter((item) => item.optionKnowledge.questionExact === true).length,
    questionExactRate: metricRatio(
      exactItems.filter((item) => item.optionKnowledge.questionExact === true).length,
      exactItems.length,
    ),
    falseAbstentionCount,
    falseAbstentionRate: metricRatio(falseAbstentionCount, eligibleCount),
    goldUndetermined: {
      count: goldUndeterminedCount,
      predictedUndeterminedCount: goldUndeterminedPredictedCount,
      recall: metricRatio(goldUndeterminedPredictedCount, goldUndeterminedCount),
    },
    nodeEndToEnd: aggregateNodeMetrics(items, "nodeEndToEnd"),
    nodeConditional: aggregateNodeMetrics(items, "nodeConditional"),
  };
}

function aggregateBooleanMetric(items, selector) {
  const values = items.map(selector).filter((value) => typeof value === "boolean");
  const passedCount = values.filter(Boolean).length;
  return {
    applicableCount: values.length,
    passedCount,
    failedCount: values.length - passedCount,
    accuracy: metricRatio(passedCount, values.length),
  };
}

function aggregateAverageMetric(items, selector) {
  const values = items.map(selector)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number).filter(Number.isFinite);
  return {
    applicableCount: values.length,
    average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
  };
}

const CANDIDATE_REQUIRED_FIELDS = [
  "name",
  "coreKnowledgeNodeId",
  "requiredKnowledgeNodeIds",
  "textbookAnchorNodeIds",
  "assessmentAction",
  "textbookEvidence",
];

function candidateRequiredComplete(draft) {
  if (!draft || typeof draft !== "object") return false;
  if (typeof draft.requiredComplete === "boolean") return draft.requiredComplete;
  if (draft.fields && typeof draft.fields === "object") {
    return CANDIDATE_REQUIRED_FIELDS.every((field) => draft.fields[field] === true);
  }
  return draft.complete === true;
}

function candidateBoundaryComplete(draft) {
  if (!draft || typeof draft !== "object") return false;
  if (typeof draft.boundaryComplete === "boolean") return draft.boundaryComplete;
  return draft.fields?.inclusionBoundary === true && draft.fields?.exclusionBoundary === true;
}

function candidateSemanticQualityMatch(draft) {
  if (!candidateRequiredComplete(draft)) return false;
  if (draft.semanticComparable !== true) return true;
  const semanticChecks = [
    draft.coreKnowledgeExact,
    draft.requiredKnowledge?.exact,
    Number.isFinite(Number(draft.textbookAnchors?.recall)) ? Number(draft.textbookAnchors.recall) > 0 : undefined,
    draft.actionSemanticMatch,
  ].filter((value) => typeof value === "boolean");
  return semanticChecks.length ? semanticChecks.every(Boolean) : draft.semanticMatch === true;
}

function aggregateContractMetrics(results) {
  const byStatus = { valid: 0, corrected: 0, failed: 0, unknown: 0 };
  results.forEach((item) => {
    const value = String(item.agent3ContractStatus || "").trim();
    const status = Object.hasOwn(byStatus, value) ? value : "unknown";
    byStatus[status] += 1;
  });
  const knownCount = byStatus.valid + byStatus.corrected + byStatus.failed;
  const passedCount = byStatus.valid + byStatus.corrected;
  return {
    questionCount: results.length,
    knownCount,
    unknownCount: byStatus.unknown,
    passedCount,
    failedCount: byStatus.failed,
    passRate: metricRatio(passedCount, knownCount),
    byStatus,
  };
}

function aggregateExecutionMetrics(results) {
  const failedItems = results.filter((item) => item.executionFailed === true);
  const failureCodes = {};
  failedItems.forEach((item) => {
    const code = String(item.executionFailureCode || "unknown");
    failureCodes[code] = (failureCodes[code] || 0) + 1;
  });
  return {
    questionCount: results.length,
    succeededCount: results.length - failedItems.length,
    failedCount: failedItems.length,
    failureRate: metricRatio(failedItems.length, results.length),
    failureCodes,
  };
}

function aggregateInternalRetryMetrics(records) {
  const providerQuestionIds = new Set();
  const constraintQuestionIds = new Set();
  const fallbackQuestionIds = new Set();
  const totals = records.reduce((summary, item) => {
    summary.providerRetryCount += Number(item.retrySummary?.providerRetryCount) || 0;
    summary.constraintRetryCount += Number(item.retrySummary?.constraintRetryCount) || 0;
    summary.fallbackAttemptCount += Number(item.retrySummary?.fallbackAttemptCount) || 0;
    summary.totalRetryCount += Number(item.retrySummary?.totalRetryCount) || 0;
    if ((Number(item.retrySummary?.providerRetryCount) || 0) > 0) providerQuestionIds.add(String(item.questionId || ""));
    if ((Number(item.retrySummary?.constraintRetryCount) || 0) > 0) constraintQuestionIds.add(String(item.questionId || ""));
    if ((Number(item.retrySummary?.fallbackAttemptCount) || 0) > 0) fallbackQuestionIds.add(String(item.questionId || ""));
    const reason = String(item.retrySummary?.firstFailureReason || "").trim();
    if (reason) summary.firstFailureReasons[reason] = (summary.firstFailureReasons[reason] || 0) + 1;
    return summary;
  }, {
    providerRetryCount: 0,
    constraintRetryCount: 0,
    fallbackAttemptCount: 0,
    totalRetryCount: 0,
    firstFailureReasons: {},
  });
  return {
    ...totals,
    providerRetryQuestionCount: providerQuestionIds.size,
    constraintRetryQuestionCount: constraintQuestionIds.size,
    fallbackQuestionCount: fallbackQuestionIds.size,
  };
}

function aggregateScopeMetrics(results, attempts) {
  const scored = results.filter((item) => item.includedInAccuracy);
  const existingFamilyItems = scored.filter((item) => item.requestedMode === "mature");
  const candidateFamilyItems = scored.filter((item) => ["singleton", "unmatched"].includes(item.requestedMode));
  const candidateSuccessfulCount = candidateFamilyItems.filter((item) => (
    candidateSemanticQualityMatch(item.candidateFamilyDraft)
      && item.hiddenGoldFamilyIdReturned !== true
  )).length;
  const errorPropagationItems = scored.filter((item) => (
    Array.isArray(item.requiredKnowledge?.predicted) && Array.isArray(item.requiredKnowledge?.expected)
  ));
  const errorPropagationCount = errorPropagationItems.filter((item) => {
    const expected = new Set(item.requiredKnowledge.expected.map(String));
    return item.requiredKnowledge.predicted.some((nodeId) => !expected.has(String(nodeId)));
  }).length;
  return {
    questionCount: results.length,
    attemptCount: attempts.length,
    retriedQuestionCount: results.filter((item) => item.retried).length,
    assessedCount: results.filter((item) => item.assessmentStatus === "assessed").length,
    diagnosticOnlyCount: results.filter((item) => item.assessmentStatus === "diagnostic_only").length,
    unassessedCount: results.filter((item) => item.assessmentStatus === "unassessed").length,
    scoredCount: scored.length,
    passedCount: scored.filter((item) => item.countedResult === true).length,
    failedCount: scored.filter((item) => item.countedResult === false).length,
    accuracy: scored.length ? scored.filter((item) => item.countedResult === true).length / scored.length : null,
    coreKnowledge: aggregateBooleanMetric(scored, (item) => item.coreKnowledgeExact),
    requiredKnowledge: {
      ...aggregateBooleanMetric(scored, (item) => item.requiredKnowledge?.exact),
      f1: aggregateAverageMetric(scored, (item) => item.requiredKnowledge?.f1),
    },
    familyDecision: aggregateBooleanMetric(scored, (item) => {
      if (!item.familyDecision) return null;
      if (item.requestedMode === "mature") return item.familyDecision === "join_existing";
      if (["singleton", "unmatched"].includes(item.requestedMode)) return item.familyDecision === "create_new";
      return null;
    }),
    existingFamily: {
      primary: aggregateBooleanMetric(existingFamilyItems, (item) => item.primaryFamilyExact),
      memberships: {
        ...aggregateBooleanMetric(existingFamilyItems, (item) => item.familyMemberships?.exact),
        f1: aggregateAverageMetric(existingFamilyItems, (item) => item.familyMemberships?.f1),
      },
    },
    requiredFamilyMemberships: {
      ...aggregateBooleanMetric(scored, (item) => item.familyMemberships?.exact),
      f1: aggregateAverageMetric(scored, (item) => item.familyMemberships?.f1),
    },
    candidateFamily: {
      applicableCount: candidateFamilyItems.length,
      proposedCount: candidateFamilyItems.filter((item) => item.candidateFamilyDraftProposed).length,
      completeCount: candidateFamilyItems.filter((item) => item.candidateFamilyDraft?.complete === true).length,
      requiredCompleteCount: candidateFamilyItems.filter(
        (item) => candidateRequiredComplete(item.candidateFamilyDraft),
      ).length,
      boundaryCompleteCount: candidateFamilyItems.filter(
        (item) => candidateBoundaryComplete(item.candidateFamilyDraft),
      ).length,
      semanticComparableCount: candidateFamilyItems.filter(
        (item) => item.candidateFamilyDraft?.semanticComparable === true,
      ).length,
      semanticMatchCount: candidateFamilyItems.filter(
        (item) => item.candidateFamilyDraft?.semanticComparable === true
          && candidateSemanticQualityMatch(item.candidateFamilyDraft),
      ).length,
      successfulCount: candidateSuccessfulCount,
      successRate: metricRatio(candidateSuccessfulCount, candidateFamilyItems.length),
    },
    contracts: aggregateContractMetrics(results),
    execution: aggregateExecutionMetrics(results),
    internalRetries: aggregateInternalRetryMetrics(
      attempts.some((item) => item.retrySummary) ? attempts : results,
    ),
    unresolved: {
      applicableCount: scored.length,
      count: scored.filter((item) => item.unresolved === true).length,
      rate: metricRatio(scored.filter((item) => item.unresolved === true).length, scored.length),
    },
    errorPropagation: {
      applicableCount: errorPropagationItems.length,
      count: errorPropagationCount,
      rate: metricRatio(errorPropagationCount, errorPropagationItems.length),
    },
    modeConsistency: {
      applicableCount: results.filter((item) => item.actualMode).length,
      mismatchCount: results.filter((item) => item.actualMode && item.actualMode !== item.requestedMode).length,
    },
    optionKnowledge: aggregateOptionKnowledgeMetrics(scored),
  };
}

function aggregateMetrics(results, attempts) {
  const metrics = aggregateScopeMetrics(results, attempts);
  metrics.byMode = Object.fromEntries(REQUIRED_MODES.map((mode) => [
    mode,
    aggregateScopeMetrics(
      results.filter((item) => item.requestedMode === mode),
      attempts.filter((item) => item.mode === mode),
    ),
  ]));
  return metrics;
}

function markdownValue(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMarkdown(summary) {
  const statusLabel = {
    running: "进行中",
    completed: "完成",
    aborted: "已中止",
  }[summary.status] || String(summary.status || "未知");
  const metrics = summary.metrics || aggregateMetrics(summary.results || [], summary.attempts || []);
  const accuracy = metrics.accuracy === null ? "不适用" : `${(metrics.accuracy * 100).toFixed(2)}%`;
  const optionMetrics = metrics.optionKnowledge || {};
  const modeDistributions = summary.modeDistributions || {
    total: summary.distribution || {},
    scoreable: summary.scoreableDistribution || summary.distribution || {},
    disputed: summary.disputedDistribution || {},
  };
  const modeDistributionRows = [
    ["全部", modeDistributions.total],
    ["可计分", modeDistributions.scoreable],
    ["争议诊断", modeDistributions.disputed],
  ].map(([label, values]) => `| ${label} | ${values?.mature || 0} | ${values?.singleton || 0} | ${values?.unmatched || 0} |`).join("\n");
  const metricPercent = (value) => value === null || value === undefined ? "不适用" : `${(value * 100).toFixed(2)}%`;
  const scoreLabel = (metric = {}) => `${metric.passedCount ?? 0}/${metric.applicableCount ?? 0}（${metricPercent(metric.accuracy)}）`;
  const runKindLabel = {
    calibration: "校准",
    gate: "门禁",
    diagnostic: "诊断",
    contract_smoke: "合同冒烟",
  }[summary.runKind] || String(summary.runKind || "diagnostic");
  const relationClassRows = RELATION_GOLD_CLASSES.map((className) => {
    const metric = optionMetrics.perClass?.[className] || {};
    return `| ${className} | ${metric.support ?? 0} | ${metric.predicted ?? 0} | ${metric.truePositive ?? 0} | ${metricPercent(metric.precision)} | ${metricPercent(metric.recall)} | ${metricPercent(metric.f1)} |`;
  }).join("\n");
  const relationConfusionRows = RELATION_GOLD_CLASSES.map((goldClass) => `| ${goldClass} | ${RELATION_PREDICTION_CLASSES.map(
    (predictionClass) => Number(optionMetrics.confusionMatrix?.[goldClass]?.[predictionClass]) || 0,
  ).join(" | ")} |`).join("\n");
  const nodeMetricRows = [
    ["端到端", optionMetrics.nodeEndToEnd || {}],
    ["关系命中后条件指标", optionMetrics.nodeConditional || {}],
  ].map(([label, metric]) => `| ${label} | ${metric.unitCount ?? 0} | ${metric.truePositive ?? 0} | ${metric.falsePositive ?? 0} | ${metric.falseNegative ?? 0} | ${metricPercent(metric.precision)} | ${metricPercent(metric.recall)} | ${metricPercent(metric.f1)} |`).join("\n");
  const modeMetricRows = REQUIRED_MODES.map((mode) => {
    const current = metrics.byMode?.[mode] || {};
    const familyMetric = mode === "mature"
      ? `${scoreLabel(current.requiredFamilyMemberships)} / F1 ${metricPercent(current.requiredFamilyMemberships?.f1?.average)}`
      : `候选建族 ${current.candidateFamily?.successfulCount ?? 0}/${current.candidateFamily?.applicableCount ?? 0}（${metricPercent(current.candidateFamily?.successRate)}）；必需关联 ${scoreLabel(current.requiredFamilyMemberships)}`;
    return `| ${mode} | ${current.questionCount ?? 0} | ${metricPercent(current.accuracy)} | ${scoreLabel(current.coreKnowledge)} | ${scoreLabel(current.requiredKnowledge)} / F1 ${metricPercent(current.requiredKnowledge?.f1?.average)} | ${scoreLabel(current.familyDecision)} | ${familyMetric} | ${metricPercent(current.unresolved?.rate)} | ${metricPercent(current.errorPropagation?.rate)} | ${current.contracts?.passedCount ?? 0}/${current.contracts?.knownCount ?? 0} | ${current.internalRetries?.constraintRetryCount ?? 0} | ${current.execution?.failedCount ?? 0} |`;
  }).join("\n");
  const resultRows = (summary.results || []).map((item) => {
    const familyResult = item.requestedMode === "mature"
      ? item.familyMemberships?.exact
      : candidateSemanticQualityMatch(item.candidateFamilyDraft) && item.familyMemberships?.exact;
    const displayBoolean = (value) => typeof value !== "boolean" ? "-" : (value ? "通过" : "未通过");
    return `| ${markdownValue(item.questionId)} | ${item.requestedMode} | ${item.attemptCount} | ${item.assessmentStatus} | ${displayBoolean(item.coreKnowledgeExact)} | ${displayBoolean(item.requiredKnowledge?.exact)} | ${markdownValue(item.familyDecision || "-")} / ${displayBoolean(familyResult)} | ${markdownValue(item.agent3ContractStatus || "未知")}（约束修复 ${item.retrySummary?.constraintRetryCount ?? 0}） | ${item.executionFailed ? markdownValue(item.executionFailureCode || "失败") : "否"} | ${item.countedResult === null ? "-" : (item.countedResult ? "通过" : "未通过")} |`;
  }).join("\n");
  const attemptRows = (summary.attempts || []).map((item) => `| ${item.sequence} | ${markdownValue(item.questionId)} | ${item.attemptNumber} | ${item.assessmentStatus || "运行异常"} | ${item.retryScheduled ? `是（${item.retryDelayMs} ms）` : "否"} | ${item.isolationAudit?.passed ? "通过" : "未通过"} | ${markdownValue(item.error || item.executionFailureCode || "-")} |`).join("\n");
  const retryFailureRows = Object.entries(metrics.internalRetries?.firstFailureReasons || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => `| ${markdownValue(reason)} | ${count} |`).join("\n");
  const baselineRows = FORMAL_STATE_FILES.map((fileName) => `| ${fileName} | ${summary.baselineHashes?.[fileName] || "-"} | ${summary.finalHashes?.[fileName] || "-"} |`).join("\n");
  return `# AI 分层盲测批次报告

## 批次状态

| 项目 | 结果 |
| --- | --- |
| 状态 | ${statusLabel} |
| 运行类型 | ${runKindLabel}（\`${summary.runKind || "diagnostic"}\`） |
| 计入连续门禁 | ${summary.countsTowardGate === true ? "是" : "否"} |
| 冻结金标文件 SHA-256 | \`${summary.goldSnapshotSha256 || summary.manifestSha256}\` |
| 回放上下文 C1 SHA-256 | \`${summary.replayContextSha256 || "-"}\` |
| 金标/C1 绑定 | ${summary.contextPreflight?.status === "passed" ? "通过" : (summary.contextPreflight?.status || "未校验")}（模型调用 ${summary.contextPreflight?.modelCallsPerformed ?? 0}） |
| 计划题数 | ${summary.expectedCount} |
| 已完成题数 | ${metrics.questionCount} |
| 总尝试次数 | ${metrics.attemptCount} |
| 计分题 | ${metrics.scoredCount} |
| 通过 / 未通过 | ${metrics.passedCount} / ${metrics.failedCount} |
| 准确率 | ${accuracy} |
| 核心知识 exact | ${scoreLabel(metrics.coreKnowledge)} |
| 最小充分知识集 exact / 平均 F1 | ${scoreLabel(metrics.requiredKnowledge)} / ${metricPercent(metrics.requiredKnowledge?.f1?.average)} |
| 题族决策 | ${scoreLabel(metrics.familyDecision)} |
| 作答必需题族归属 exact / 平均 F1 | ${scoreLabel(metrics.requiredFamilyMemberships)} / ${metricPercent(metrics.requiredFamilyMemberships?.f1?.average)} |
| 候选建族必需字段完整 | ${metrics.candidateFamily?.requiredCompleteCount ?? 0}/${metrics.candidateFamily?.applicableCount ?? 0} |
| 候选建族边界完整（诊断，不作硬门槛） | ${metrics.candidateFamily?.boundaryCompleteCount ?? 0}/${metrics.candidateFamily?.applicableCount ?? 0} |
| 候选建族质量通过 | ${metrics.candidateFamily?.successfulCount ?? 0}/${metrics.candidateFamily?.applicableCount ?? 0}（${metricPercent(metrics.candidateFamily?.successRate)}） |
| 无法确定率 | ${metrics.unresolved?.count ?? 0}/${metrics.unresolved?.applicableCount ?? 0}（${metricPercent(metrics.unresolved?.rate)}） |
| 错误扩散率 | ${metrics.errorPropagation?.count ?? 0}/${metrics.errorPropagation?.applicableCount ?? 0}（${metricPercent(metrics.errorPropagation?.rate)}） |
| 请求/实际模式不一致 | ${metrics.modeConsistency?.mismatchCount ?? 0}/${metrics.modeConsistency?.applicableCount ?? 0} |
| 合同状态 valid / corrected / failed / unknown | ${metrics.contracts?.byStatus?.valid ?? 0} / ${metrics.contracts?.byStatus?.corrected ?? 0} / ${metrics.contracts?.byStatus?.failed ?? 0} / ${metrics.contracts?.byStatus?.unknown ?? 0} |
| 约束修复 | ${metrics.internalRetries?.constraintRetryCount ?? 0} 次，涉及 ${metrics.internalRetries?.constraintRetryQuestionCount ?? 0} 题 |
| 供应商重试 / 备用恢复 | ${metrics.internalRetries?.providerRetryCount ?? 0} / ${metrics.internalRetries?.fallbackAttemptCount ?? 0} |
| 执行失败 | ${metrics.execution?.failedCount ?? 0}/${metrics.execution?.questionCount ?? metrics.questionCount}（${metricPercent(metrics.execution?.failureRate)}） |
| 正式数据哈希差异 | ${(summary.formalStateDifferences || []).map(markdownValue).join("、") || "无"} |
| 选项关系准确率 / macro-F1 | ${metricPercent(optionMetrics.accuracy)} / ${metricPercent(optionMetrics.macroF1)} |
| 选项关系整题完全命中率 | ${metricPercent(optionMetrics.questionExactRate)} |
| 确定样本错误弃权率 | ${metricPercent(optionMetrics.falseAbstentionRate)} |
| 选项节点端到端 / 条件 F1 | ${metricPercent(optionMetrics.nodeEndToEnd?.f1)} / ${metricPercent(optionMetrics.nodeConditional?.f1)} |
| 未评估 | ${metrics.unassessedCount} |
| 中止原因 | ${markdownValue(summary.abortReason || "-")} |

## 选项知识关系指标

| Gold 类别 | 支持数 | 预测为该类 | 命中 | Precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${relationClassRows}

| Gold \\ 预测 | ${RELATION_PREDICTION_CLASSES.join(" | ")} |
| --- | ${RELATION_PREDICTION_CLASSES.map(() => "---:").join(" | ")} |
${relationConfusionRows}

Gold 为 \`undetermined\` 的诊断项：${optionMetrics.goldUndetermined?.count ?? 0} 项；Agent 1 同样返回 \`undetermined\`：${optionMetrics.goldUndetermined?.predictedUndeterminedCount ?? 0} 项；诊断召回率：${metricPercent(optionMetrics.goldUndetermined?.recall)}。这些项不进入主关系准确率分母。

## 选项知识节点指标

| 口径 | 关系单元 | TP | FP | FN | Precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${nodeMetricRows}

## 模式分布

| 口径 | 成熟题族留一 | 单题题族整族隐藏 | 无匹配题建族 |
| --- | ---: | ---: | ---: |
${modeDistributionRows}

## 分层指标

| 模式 | 题数 | 总体准确率 | 核心知识 | 最小充分知识集 | 题族决策 | 旧题族归属 / 候选建族 | 无法确定率 | 错误扩散率 | 合同通过 | 约束修复 | 执行失败 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${modeMetricRows}

## 链路重试与首次失败

| 首次失败原因 | 题数 |
| --- | ---: |
${retryFailureRows || "| 无 | 0 |"}

## 逐题结果

| 题目 | 请求模式 | 尝试 | 评估状态 | 核心知识 | 最小充分知识集 | 题族决策 / 归属或建族 | 合同状态 | 执行失败 | 总结果 |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
${resultRows || "| - | - | - | - | - | - | - | - | - |"}

## 逐次尝试

| 序号 | 题目 | 本题尝试 | 评估状态 | 安排重试 | 正式文件隔离 | 说明 |
| ---: | --- | ---: | --- | --- | --- | --- |
${attemptRows || "| - | - | - | - | - | - | - |"}

## 正式文件基线

| 文件 | 运行前 SHA-256 | 运行后/中止时 SHA-256 |
| --- | --- | --- |
${baselineRows}
`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function persistBatchState(paths, state) {
  state.summary.metrics = aggregateMetrics(state.summary.results, state.summary.attempts);
  writeJson(paths.attemptsPath, {
    schemaVersion: 1,
    batchId: state.summary.batchId,
    runKind: state.summary.runKind,
    countsTowardGate: state.summary.countsTowardGate,
    manifestSha256: state.summary.manifestSha256,
    attempts: state.summary.attempts,
  });
  writeJson(paths.checkpointPath, {
    schemaVersion: 1,
    batchId: state.summary.batchId,
    status: state.summary.status,
    runKind: state.summary.runKind,
    countsTowardGate: state.summary.countsTowardGate,
    updatedAt: state.updatedAt,
    manifestSha256: state.summary.manifestSha256,
    baselineHashes: state.summary.baselineHashes,
    finalHashes: state.summary.finalHashes || null,
    formalStateDifferences: state.summary.formalStateDifferences || [],
    finalHashError: state.summary.finalHashError || "",
    currentQuestionIndex: state.currentQuestionIndex,
    completedQuestionCount: state.summary.results.length,
    attempts: state.summary.attempts,
    results: state.summary.results,
    abortReason: state.summary.abortReason || "",
  });
  writeJson(paths.summaryJsonPath, state.summary);
  fs.writeFileSync(paths.summaryMarkdownPath, renderMarkdown(state.summary), "utf8");
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function runBlindReplayBatch(options = {}, dependencies = {}) {
  if (options.manifestPath) throw new Error("blind_batch_manifest_not_supported_use_frozen_gold_snapshot");
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, "../.."));
  const runtimeDir = path.resolve(options.runtimeDir || path.join(projectRoot, ".runtime"));
  const outputRoot = path.resolve(options.outputRoot || path.join(projectRoot, "..", "outputs", "AI盲测批次"));
  const expectedCount = options.expectedCount === undefined
    ? DEFAULT_EXPECTED_COUNT
    : parseNonNegativeInteger(options.expectedCount, "blind_batch_expected_count_invalid");
  if (expectedCount < 1) throw new Error("blind_batch_expected_count_invalid");
  const retryDelaysMs = normalizeRetryDelays(options.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS);
  const maxTechnicalRetries = options.maxTechnicalRetries === undefined
    ? DEFAULT_MAX_TECHNICAL_RETRIES
    : parseNonNegativeInteger(options.maxTechnicalRetries, "blind_batch_max_technical_retries_invalid");
  if (maxTechnicalRetries > DEFAULT_MAX_TECHNICAL_RETRIES) {
    throw new Error("blind_batch_max_technical_retries_invalid");
  }
  const replayRunner = dependencies.runBlindReplay
    || ((replayOptions) => require("./run-classification-blind-replay").runBlindReplay(replayOptions));
  const replayContextReader = dependencies.readReplayContext || readReplayContext;
  const replayContextPreflightBuilder = dependencies.buildReplayContextPreflight || buildReplayContextPreflight;
  const formalHasher = dependencies.hashFormalState || hashFormalState;
  const sleep = dependencies.sleep || defaultSleep;
  const now = dependencies.now || (() => new Date());
  const writeLog = dependencies.writeLog || ((message) => process.stdout.write(message));
  const runKind = String(options.runKind || "diagnostic");
  if (!RUN_KINDS.has(runKind)) throw new Error("blind_batch_run_kind_invalid");
  const countsTowardGate = runKind === "gate";
  if (!options.goldSnapshotPath) throw new Error("blind_batch_gold_snapshot_required");
  if (!options.replayContextPath) throw new Error("blind_batch_replay_context_required");
  const loaded = readAndValidateGoldSnapshot(options.goldSnapshotPath, expectedCount);
  const missingScoreableModes = REQUIRED_MODES.filter((mode) => loaded.scoreableDistribution[mode] === 0);
  if (countsTowardGate && missingScoreableModes.length) {
    const error = new Error(`blind_batch_scoreable_mode_distribution_missing:${missingScoreableModes.join(",")}`);
    error.modeDistributions = loaded.modeDistributions;
    throw error;
  }
  const goldForContext = {
    snapshot: loaded.snapshot,
    filePath: loaded.snapshotPath,
    fileSha256: loaded.sha256,
    contentSha256: loaded.contentSha256,
  };
  const replayContext = replayContextReader(options.replayContextPath, goldForContext);
  const contextPreflight = replayContextPreflightBuilder(goldForContext, replayContext, { expectedCount });
  assertOutputOutsideRuntime(outputRoot, runtimeDir);

  const startedAt = now();
  const batchId = `blind-batch-${timestampForPath(startedAt)}-${loaded.sha256.slice(0, 12)}`;
  const outputDir = path.join(outputRoot, batchId);
  assertOutputOutsideRuntime(outputDir, runtimeDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const paths = {
    outputDir,
    manifestSnapshotPath: path.join(outputDir, "冻结金标快照.json"),
    goldSnapshotSidecarPath: path.join(outputDir, "冻结金标快照.json.sha256"),
    replayContextSnapshotPath: path.join(outputDir, "冻结回放上下文C1.json"),
    replayContextSidecarPath: path.join(outputDir, "冻结回放上下文C1.json.sha256"),
    replayContextBindingPath: path.join(outputDir, "冻结回放上下文C1.json.binding.json"),
    replayContextBindingSidecarPath: path.join(outputDir, "冻结回放上下文C1.json.binding.json.sha256"),
    contextPreflightJsonPath: path.join(outputDir, "零模型上下文预检.json"),
    contextPreflightMarkdownPath: path.join(outputDir, "零模型上下文预检.md"),
    checkpointPath: path.join(outputDir, "批次检查点.json"),
    attemptsPath: path.join(outputDir, "逐题尝试.json"),
    summaryJsonPath: path.join(outputDir, "批次汇总.json"),
    summaryMarkdownPath: path.join(outputDir, "批次汇总.md"),
    replayOutputRoot: path.join(outputDir, "单题回放"),
  };
  fs.writeFileSync(paths.manifestSnapshotPath, loaded.raw);
  fs.writeFileSync(paths.goldSnapshotSidecarPath, `${loaded.sha256}  ${path.basename(paths.manifestSnapshotPath)}\n`, "utf8");
  fs.writeFileSync(paths.replayContextSnapshotPath, replayContext.bytes);
  fs.writeFileSync(paths.replayContextSidecarPath, `${replayContext.fileSha256}  ${path.basename(paths.replayContextSnapshotPath)}\n`, "utf8");
  fs.writeFileSync(paths.replayContextBindingPath, replayContext.bindingBytes);
  fs.writeFileSync(paths.replayContextBindingSidecarPath, `${replayContext.bindingFileSha256}  ${path.basename(paths.replayContextBindingPath)}\n`, "utf8");
  writePreflightReport(contextPreflight, paths.contextPreflightJsonPath);

  const baselineHashes = await formalHasher(runtimeDir);
  assertCompleteFormalHashes(baselineHashes);
  const state = {
    currentQuestionIndex: 0,
    updatedAt: startedAt.toISOString(),
    summary: {
      schemaVersion: 1,
      batchId,
      status: "running",
      runKind,
      countsTowardGate,
      startedAt: startedAt.toISOString(),
      finishedAt: "",
      expectedCount,
      goldSnapshotPath: loaded.snapshotPath,
      manifestSnapshotPath: paths.manifestSnapshotPath,
      manifestSha256: loaded.sha256,
      goldSnapshotSha256: loaded.sha256,
      goldSnapshotContentSha256: loaded.contentSha256,
      goldSnapshotId: loaded.snapshot.snapshotId,
      goldSnapshotVersion: loaded.snapshot.version,
      replayContextPath: replayContext.filePath,
      replayContextSnapshotPath: paths.replayContextSnapshotPath,
      replayContextId: replayContext.document.contextId,
      replayContextVersion: replayContext.document.version,
      replayContextSha256: replayContext.fileSha256,
      replayContextContentSha256: replayContext.contentSha256,
      replayContextDataSha256: replayContext.contextDataSha256,
      replayContextBindingId: replayContext.document.bindingId,
      replayContextBindingSha256: replayContext.bindingFileSha256,
      contextPreflight: {
        status: contextPreflight.status,
        eligibleForReplay: contextPreflight.eligibleForReplay,
        modelCallsPerformed: contextPreflight.modelCallsPerformed,
        blockerCount: contextPreflight.summary.blockerCount,
        warningCount: contextPreflight.summary.warningCount,
        reportPath: paths.contextPreflightJsonPath,
      },
      distribution: loaded.distribution,
      scoreableDistribution: loaded.scoreableDistribution,
      disputedDistribution: loaded.disputedDistribution,
      modeDistributions: loaded.modeDistributions,
      baselineHashes,
      finalHashes: null,
      formalStateDifferences: [],
      finalHashError: "",
      retryPolicy: {
        retryOnlyWhen: "assessmentStatus=unassessed and executionFailed=true",
        maxAdditionalRetries: maxTechnicalRetries,
        delaysMs: retryDelaysMs,
      },
      attempts: [],
      results: [],
      abortReason: "",
      metrics: {},
    },
  };
  persistBatchState(paths, state);

  writeLog(`[批次盲测] ${runKind} 运行，清单 ${loaded.sha256.slice(0, 12)}，C1 ${replayContext.fileSha256.slice(0, 12)}，${expectedCount} 道不同题目。\n`);
  try {
    if (!contextPreflight.eligibleForReplay) {
      throw new Error(`blind_batch_context_preflight_failed:${contextPreflight.summary.blockerCount}`);
    }
    writeLog("[批次盲测] 零模型预检通过，开始串行回放。\n");
    for (let itemIndex = 0; itemIndex < loaded.items.length; itemIndex += 1) {
      const item = loaded.items[itemIndex];
      state.currentQuestionIndex = itemIndex;
      const questionAttempts = [];
      let finalReport = null;
      for (let attemptNumber = 1; attemptNumber <= 1 + maxTechnicalRetries; attemptNumber += 1) {
        const sequence = state.summary.attempts.length + 1;
        const attemptStartedAt = now();
        const observedBeforeHashes = await formalHasher(runtimeDir);
        const preflightDifferences = hashDifferences(baselineHashes, observedBeforeHashes);
        if (preflightDifferences.length) {
          throw new Error(`blind_batch_formal_state_changed_before_attempt:${item.questionId}:${preflightDifferences.join(",")}`);
        }
        writeLog(`[批次盲测] ${itemIndex + 1}/${expectedCount} ${item.questionId}，第 ${attemptNumber} 次尝试。\n`);

        let replay;
        try {
          replay = await replayRunner({
            questionId: item.questionId,
            goldSnapshotPath: paths.manifestSnapshotPath,
            replayContextPath: paths.replayContextSnapshotPath,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            outputRoot: paths.replayOutputRoot,
          });
        } catch (error) {
          const observedAfterHashes = await formalHasher(runtimeDir);
          const attempt = {
            sequence,
            questionIndex: itemIndex,
            questionId: item.questionId,
            mode: item.mode,
            attemptNumber,
            startedAt: attemptStartedAt.toISOString(),
            finishedAt: now().toISOString(),
            assessmentStatus: "",
            executionFailed: null,
            executionFailureCode: "",
            retryScheduled: false,
            retryDelayMs: 0,
            reportPath: "",
            rawPath: "",
            error: String(error?.stack || error?.message || error),
            isolationAudit: {
              passed: hashDifferences(baselineHashes, observedAfterHashes).length === 0,
              failures: hashDifferences(baselineHashes, observedAfterHashes).map((fileName) => `observed_after:${fileName}`),
              observedBeforeHashes,
              observedAfterHashes,
            },
          };
          questionAttempts.push(attempt);
          state.summary.attempts.push(attempt);
          state.updatedAt = now().toISOString();
          persistBatchState(paths, state);
          if (!attempt.isolationAudit.passed) {
            throw new Error(`blind_batch_formal_state_changed_after_runner_error:${item.questionId}:${attempt.isolationAudit.failures.join(";")}`);
          }
          throw new Error(`blind_batch_replay_threw:${item.questionId}:${error?.message || error}`);
        }

        const observedAfterHashes = await formalHasher(runtimeDir);
        if (!replay?.report?.evaluation) {
          const invalidReportDifferences = hashDifferences(baselineHashes, observedAfterHashes);
          if (invalidReportDifferences.length) {
            throw new Error(`blind_batch_formal_state_changed_after_invalid_report:${item.questionId}:${invalidReportDifferences.join(",")}`);
          }
          throw new Error(`blind_batch_replay_report_invalid:${item.questionId}`);
        }
        const isolationAudit = auditReplayIsolation(
          replay.report,
          baselineHashes,
          observedBeforeHashes,
          observedAfterHashes,
        );
        const retryable = isRetryableTechnicalFailure(replay.report);
        const retryScheduled = retryable && attemptNumber <= maxTechnicalRetries;
        const retryDelayMs = retryScheduled ? retryDelaysMs[attemptNumber - 1] : 0;
        const attempt = {
          sequence,
          questionIndex: itemIndex,
          questionId: item.questionId,
          mode: item.mode,
          attemptNumber,
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: now().toISOString(),
          assessmentStatus: replay.report.evaluation.assessmentStatus,
          executionFailed: replay.report.evaluation.executionFailed === true,
          executionFailureCode: replay.report.evaluation.executionFailureCode || "",
          includedInAccuracy: replay.report.evaluation.includedInAccuracy === true,
          modelGeneralizationSuccess: replay.report.evaluation.modelGeneralizationSuccess === true,
          retrySummary: {
            providerRetryCount: Number(replay.report.retrySummary?.providerRetryCount) || 0,
            constraintRetryCount: Number(replay.report.retrySummary?.constraintRetryCount) || 0,
            fallbackAttemptCount: Number(replay.report.retrySummary?.fallbackAttemptCount) || 0,
            totalRetryCount: Number(replay.report.retrySummary?.totalRetryCount) || 0,
            firstFailureReason: String(replay.report.retrySummary?.firstFailureReason || ""),
          },
          retryScheduled,
          retryDelayMs,
          reportPath: replay.reportPath || "",
          rawPath: replay.rawPath || "",
          error: "",
          isolationAudit,
        };
        questionAttempts.push(attempt);
        state.summary.attempts.push(attempt);
        state.updatedAt = now().toISOString();
        persistBatchState(paths, state);

        if (!isolationAudit.passed) {
          throw new Error(`blind_batch_isolation_audit_failed:${item.questionId}:${isolationAudit.failures.join(";")}`);
        }
        if (retryScheduled) {
          writeLog(`[批次盲测] 本题未评估，${retryDelayMs} ms 后仅重试原题。\n`);
          await sleep(retryDelayMs);
          continue;
        }
        finalReport = replay.report;
        break;
      }

      if (!finalReport) throw new Error(`blind_batch_final_report_missing:${item.questionId}`);
      state.summary.results.push(resultSummary(item, questionAttempts, finalReport));
      state.currentQuestionIndex = itemIndex + 1;
      state.updatedAt = now().toISOString();
      persistBatchState(paths, state);
    }

    const finalHashes = await formalHasher(runtimeDir);
    const finalDifferences = hashDifferences(baselineHashes, finalHashes);
    state.summary.finalHashes = finalHashes;
    state.summary.formalStateDifferences = finalDifferences;
    if (finalDifferences.length) throw new Error(`blind_batch_formal_state_changed_at_finish:${finalDifferences.join(",")}`);
    state.summary.status = "completed";
    state.summary.finishedAt = now().toISOString();
    state.updatedAt = state.summary.finishedAt;
    persistBatchState(paths, state);
    writeLog(`[批次盲测] 完成：${state.summary.results.length} 道，${state.summary.attempts.length} 次尝试。\n`);
    writeLog(`[批次盲测] 报告：${paths.summaryMarkdownPath}\n`);
    return { summary: state.summary, ...paths };
  } catch (error) {
    state.summary.status = "aborted";
    state.summary.abortReason = String(error?.message || error);
    try {
      const abortHashes = await formalHasher(runtimeDir);
      state.summary.finalHashes = abortHashes;
      state.summary.formalStateDifferences = hashDifferences(baselineHashes, abortHashes);
      state.summary.finalHashError = "";
    } catch (hashError) {
      state.summary.finalHashError = String(hashError?.message || hashError);
    }
    state.summary.finishedAt = now().toISOString();
    state.updatedAt = state.summary.finishedAt;
    persistBatchState(paths, state);
    error.batchOutputDir = outputDir;
    error.batchSummaryPath = paths.summaryMarkdownPath;
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("用法：node scripts/classification/run-classification-blind-batch.js --gold-snapshot 冻结金标快照.json --replay-context 回放上下文C1.json [--run-kind calibration|contract_smoke|gate|diagnostic] [--expected-count 20] [--max-technical-retries 2] [--retry-delays-ms 10000,30000] [--timeout-ms 毫秒] [--output-root 目录]\n");
    return;
  }
  await runBlindReplayBatch(options);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[批次盲测] 失败：${error.stack || error.message || error}\n`);
    if (error.batchSummaryPath) process.stderr.write(`[批次盲测] 中止报告：${error.batchSummaryPath}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_EXPECTED_COUNT,
  DEFAULT_MAX_TECHNICAL_RETRIES,
  DEFAULT_RETRY_DELAYS_MS,
  REQUIRED_MODES,
  RUN_KINDS,
  aggregateMetrics,
  aggregateOptionKnowledgeMetrics,
  auditReplayIsolation,
  hashDifferences,
  isRetryableTechnicalFailure,
  normalizeRetryDelays,
  parseArgs,
  readAndValidateManifest,
  readAndValidateGoldSnapshot,
  renderMarkdown,
  runBlindReplayBatch,
};
