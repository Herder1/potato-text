const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FORMAL_STATE_FILES } = require("../scripts/classification/classification-blind-replay-state");
const { contentHash } = require("../apps/api/src/classification-gold-review-store");
const { readFrozenGoldSnapshot } = require("../apps/api/src/classification-gold-review-store");
const {
  createReplayContextDocument,
  writeReplayContext: writeReplayContextFile,
} = require("../scripts/classification/classification-blind-replay-context");
const {
  aggregateMetrics,
  aggregateOptionKnowledgeMetrics,
  isRetryableTechnicalFailure,
  parseArgs,
  readAndValidateGoldSnapshot,
  readAndValidateManifest,
  renderMarkdown,
  runBlindReplayBatch,
} = require("../scripts/classification/run-classification-blind-batch");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blind-batch-"));
  const runtimeDir = path.join(root, ".runtime");
  const outputRoot = path.join(root, "outputs");
  fs.mkdirSync(runtimeDir, { recursive: true });
  FORMAL_STATE_FILES.forEach((fileName) => {
    fs.writeFileSync(path.join(runtimeDir, fileName), `${JSON.stringify({ fileName })}\n`, "utf8");
  });
  return {
    root,
    runtimeDir,
    outputRoot,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function hashRuntime(runtimeDir) {
  return Object.fromEntries(FORMAL_STATE_FILES.map((fileName) => [
    fileName,
    crypto.createHash("sha256").update(fs.readFileSync(path.join(runtimeDir, fileName))).digest("hex"),
  ]));
}

function writeManifest(root, items) {
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, "utf8");
  return manifestPath;
}

function writeGoldSnapshot(root, items) {
  const snapshotPath = path.join(root, "gold-snapshot.json");
  const payload = {
    schemaVersion: "ClassificationGoldSnapshotV1",
    snapshotId: "snapshot-test",
    title: "测试金标",
    version: "V1",
    status: "frozen",
    source: {},
    reviewBatchId: "review-test",
    reviewer: "测试员",
    reviewedAt: new Date(0).toISOString(),
    frozenAt: new Date(0).toISOString(),
    summary: { total: items.length },
    items: items.map((entry, index) => {
      const nodeId = `node-${entry.questionId}`;
      const familyId = `family-${entry.questionId}`;
      const retainedId = `${entry.questionId}-retained`;
      const memberIds = entry.mode === "mature"
        ? [entry.questionId, retainedId]
        : (entry.mode === "singleton" ? [entry.questionId] : []);
      const family = entry.mode === "unmatched" ? null : {
        id: familyId,
        name: `题族 ${entry.questionId}`,
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
        retainedIndependentMemberQuestionIds: memberIds.filter((id) => id !== entry.questionId),
        members: memberIds.map((questionId, memberIndex) => ({
          questionId,
          isPrimary: true,
          role: memberIndex === 0 ? "prototype" : "similar",
        })),
      };
      const candidateFamily = entry.mode !== "unmatched" ? null : {
        name: `候选题族 ${entry.questionId}`,
        bookId: "book-1",
        coreKnowledgeNodeId: nodeId,
        requiredKnowledgeNodeIds: [nodeId],
        textbookAnchorNodeIds: [nodeId],
        assessmentAction: "概念识别",
        inclusionBoundary: "纳入同一概念识别题",
        exclusionBoundary: "排除其他概念",
      };
      return {
        order: index + 1,
        questionId: entry.questionId,
        replayMode: entry.mode,
        goldStatus: entry.goldStatus === "auto" ? "confirmed" : entry.goldStatus,
        includedInAccuracy: entry.goldStatus !== "gold_needs_review",
        questionSnapshot: { id: entry.questionId, version: 1, bookId: "book-1", type: "single", stem: entry.questionId, options: [] },
        answerAndEvidence: {},
        knowledgeGold: {
          coreKnowledge: { id: nodeId, title: nodeId, path: nodeId },
          requiredKnowledge: [{ id: nodeId, title: nodeId, path: nodeId }],
        },
        familyGold: {
          replayMode: entry.mode,
          decision: entry.mode === "unmatched" ? "create_new" : "join_existing",
          primaryFamilyId: family?.id || "",
          relatedFamilyIds: [],
          families: family ? [family] : [],
          candidateFamily,
        },
        audit: {},
      };
    }),
  };
  const document = { ...payload, integrity: { algorithm: "sha256", contentSha256: contentHash(payload) } };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(snapshotPath, bytes);
  fs.writeFileSync(`${snapshotPath}.sha256`, `${fileHash}  ${path.basename(snapshotPath)}\n`, "utf8");
  return snapshotPath;
}

function writeReplayContext(root, snapshotPath) {
  const loadedGold = readFrozenGoldSnapshot(snapshotPath, { requireSidecar: true });
  const families = loadedGold.snapshot.items.flatMap((entry) => entry.familyGold?.families || []);
  const questionIds = [...new Set([
    ...loadedGold.snapshot.items.map((entry) => entry.questionId),
    ...families.flatMap((family) => family.members.map((member) => member.questionId)),
  ])];
  const runtimeState = {
    sourceFileHashes: {},
    data: {
      questions: questionIds.map((questionId) => ({
        id: questionId,
        bookId: "book-1",
        version: 1,
        library: "official",
        status: "official",
        type: "single",
        stem: questionId,
        options: [],
        correctAnswer: ["A"],
      })),
      questionFamilies: { families, familySets: [], familySetLinks: [], familyAliases: {} },
      knowledgeStructures: { records: [{ bookId: "book-1", nodes: [], fingerprints: [] }], editsByBook: {} },
      textbookKnowledge: [{ bookId: "book-1", chunks: [] }],
      textbookCatalogs: [{ bookId: "book-1", nodes: [] }],
      knowledgeDossiers: { dossiers: [], deltas: [], runs: [] },
      knowledgeClassificationExperience: { messages: [], rules: [], cases: [], corrections: [], ruleExceptions: [], reviewEvents: [], dossierSuggestions: [] },
      aiConfig: { providers: [], routes: {}, prompts: {} },
    },
  };
  const prepared = createReplayContextDocument({ loadedGold, runtimeState, expectedCount: loadedGold.snapshot.items.length, now: new Date(0) });
  return writeReplayContextFile(prepared, path.join(root, "replay-context.json")).filePath;
}

function item(questionId, mode, overrides = {}) {
  return {
    questionId,
    mode,
    goldStatus: "confirmed",
    unmatchedGoldStatus: mode === "unmatched" ? "confirmed" : "unreviewed",
    ...overrides,
  };
}

function replayResult(options, hashes, evaluation = {}, isolation = {}) {
  const mergedEvaluation = {
    assessmentStatus: "assessed",
    executionFailed: false,
    executionFailureCode: "",
    includedInAccuracy: true,
    modelGeneralizationSuccess: true,
    countedResult: true,
    ...evaluation,
  };
  return {
    report: {
      question: { id: options.questionId },
      mode: options.mode,
      goldStatus: options.goldStatus,
      unmatchedGoldStatus: options.unmatchedGoldStatus,
      evaluation: mergedEvaluation,
      isolation: {
        formalStateUnchanged: true,
        changedFormalFiles: [],
        beforeHashes: hashes,
        afterHashes: hashes,
        ...isolation,
      },
    },
    reportPath: path.join(options.outputRoot, `${options.questionId}.md`),
    rawPath: path.join(options.outputRoot, `${options.questionId}.json`),
  };
}

test("batch manifest requires the expected unique questions and all three replay modes", () => {
  const fixture = createFixture();
  try {
    const twoItems = [item("q-1", "mature"), item("q-2", "singleton")];
    const shortPath = writeManifest(fixture.root, twoItems);
    assert.throws(
      () => readAndValidateManifest(shortPath, 3),
      /blind_batch_expected_count_mismatch:3:2/,
    );

    const duplicatePath = writeManifest(fixture.root, [
      item("q-1", "mature"),
      item("q-1", "singleton"),
      item("q-3", "unmatched"),
    ]);
    assert.throws(
      () => readAndValidateManifest(duplicatePath, 3),
      /blind_batch_duplicate_question_id:q-1/,
    );

    const missingModePath = writeManifest(fixture.root, [
      item("q-1", "mature"),
      item("q-2", "mature"),
      item("q-3", "singleton"),
    ]);
    assert.throws(
      () => readAndValidateManifest(missingModePath, 3),
      /blind_batch_mode_distribution_missing:unmatched/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("batch manifest accepts selector-style samples and defaults non-unmatched gold policy", () => {
  const fixture = createFixture();
  try {
    const manifestPath = path.join(fixture.root, "samples-manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      samples: [
        { questionId: "q-1", mode: "mature", goldStatus: "auto" },
        { questionId: "q-2", mode: "singleton", goldStatus: "gold_needs_review" },
        item("q-3", "unmatched"),
      ],
    })}\n`, "utf8");
    const loaded = readAndValidateManifest(manifestPath, 3);
    assert.equal(loaded.items[0].unmatchedGoldStatus, "unreviewed");
    assert.equal(loaded.items[1].unmatchedGoldStatus, "unreviewed");
    assert.equal(loaded.items[2].unmatchedGoldStatus, "confirmed");
  } finally {
    fixture.cleanup();
  }
});

test("frozen gold reports total, scoreable, and disputed mode distributions separately", () => {
  const fixture = createFixture();
  try {
    const snapshotPath = writeGoldSnapshot(fixture.root, [
      item("q-1", "mature"),
      item("q-2", "singleton", { goldStatus: "gold_needs_review" }),
      item("q-3", "unmatched"),
    ]);
    const loaded = readAndValidateGoldSnapshot(snapshotPath, 3);
    assert.deepEqual(loaded.modeDistributions, {
      total: { mature: 1, singleton: 1, unmatched: 1 },
      scoreable: { mature: 1, singleton: 0, unmatched: 1 },
      disputed: { mature: 0, singleton: 1, unmatched: 0 },
    });
  } finally {
    fixture.cleanup();
  }
});

test("continuous gate rejects a mode represented only by disputed gold before any replay", async () => {
  const fixture = createFixture();
  try {
    const snapshotPath = writeGoldSnapshot(fixture.root, [
      item("q-1", "mature"),
      item("q-2", "singleton", { goldStatus: "gold_needs_review" }),
      item("q-3", "unmatched"),
    ]);
    let replayCalls = 0;
    await assert.rejects(
      () => runBlindReplayBatch({
        goldSnapshotPath: snapshotPath,
        replayContextPath: path.join(fixture.root, "not-needed.json"),
        runtimeDir: fixture.runtimeDir,
        outputRoot: fixture.outputRoot,
        expectedCount: 3,
        runKind: "gate",
      }, {
        runBlindReplay: async () => { replayCalls += 1; },
      }),
      (error) => {
        assert.match(error.message, /blind_batch_scoreable_mode_distribution_missing:singleton/);
        assert.equal(error.modeDistributions.scoreable.singleton, 0);
        return true;
      },
    );
    assert.equal(replayCalls, 0);
  } finally {
    fixture.cleanup();
  }
});

test("batch CLI defaults to 20 questions and accepts zero-delay test retries", () => {
  const options = parseArgs([
    "--gold-snapshot=gold.json",
    "--replay-context=context.json",
    "--max-technical-retries=2",
    "--retry-delays-ms=0,0",
  ]);
  assert.equal(options.expectedCount, 20);
  assert.equal(options.maxTechnicalRetries, 2);
  assert.deepEqual(options.retryDelaysMs, [0, 0]);
  assert.equal(options.runKind, "diagnostic");
  assert.equal(parseArgs(["--gold-snapshot", "gold.json", "--replay-context", "context.json", "--run-kind", "calibration"]).runKind, "calibration");
  assert.equal(parseArgs(["--gold-snapshot=gold.json", "--replay-context=context.json", "--run-kind=gate"]).runKind, "gate");
  assert.equal(parseArgs(["--gold-snapshot=gold.json", "--replay-context=context.json", "--run-kind=contract_smoke"]).runKind, "contract_smoke");
  assert.throws(
    () => parseArgs(["--gold-snapshot=gold.json", "--replay-context=context.json", "--run-kind=production"]),
    /blind_batch_run_kind_invalid/,
  );
  assert.throws(
    () => parseArgs(["--gold-snapshot=gold.json", "--replay-context=context.json", "--manifest=legacy.json"]),
    /blind_batch_manifest_not_supported_use_frozen_gold_snapshot/,
  );
  assert.throws(
    () => parseArgs(["--gold-snapshot", "gold.json", "--replay-context", "context.json", "--max-technical-retries=3"]),
    /blind_batch_max_technical_retries_invalid/,
  );
});

test("batch Markdown distinguishes running, completed, and aborted states", () => {
  const base = {
    manifestSha256: "hash",
    expectedCount: 20,
    distribution: { mature: 12, singleton: 5, unmatched: 3 },
    baselineHashes: {},
    results: [],
    attempts: [],
  };
  assert.match(renderMarkdown({ ...base, status: "running" }), /\| 状态 \| 进行中 \|/);
  assert.match(renderMarkdown({ ...base, status: "completed" }), /\| 状态 \| 完成 \|/);
  assert.match(renderMarkdown({ ...base, status: "aborted" }), /\| 状态 \| 已中止 \|/);
  assert.match(renderMarkdown({ ...base, status: "completed", runKind: "calibration", countsTowardGate: false }), /\| 计入连续门禁 \| 否 \|/);
  assert.match(renderMarkdown({ ...base, status: "completed", runKind: "gate", countsTowardGate: true }), /\| 计入连续门禁 \| 是 \|/);
});

test("batch retries provider failures but never retries an exhausted contract failure", () => {
  assert.equal(isRetryableTechnicalFailure({ evaluation: {
    assessmentStatus: "unassessed",
    executionFailed: true,
    executionFailureCode: "provider_timeout",
  } }), true);
  assert.equal(isRetryableTechnicalFailure({ evaluation: {
    assessmentStatus: "unassessed",
    executionFailed: true,
    executionFailureCode: "fetch failed",
  } }), true);
  assert.equal(isRetryableTechnicalFailure({ evaluation: {
    assessmentStatus: "unassessed",
    executionFailed: true,
    executionFailureCode: "agent3_contract_failed",
  } }), false);
  assert.equal(isRetryableTechnicalFailure({ evaluation: {
    assessmentStatus: "unassessed",
    executionFailed: true,
    executionFailureCode: "output_format_invalid",
  } }), false);
});

test("batch aggregates option relation and node metrics without hiding abstentions", () => {
  const optionKnowledge = aggregateOptionKnowledgeMetrics([
    {
      optionKnowledge: {
        applicable: true,
        eligibleCount: 2,
        correctCount: 1,
        confusionMatrix: {
          question_only: { question_only: 1 },
          option_specific: { undetermined: 1 },
        },
        questionExact: false,
        falseAbstentionCount: 1,
        goldUndetermined: { count: 1, predictedUndeterminedCount: 1 },
        nodeEndToEnd: { truePositive: 1, falsePositive: 1, falseNegative: 2, unitCount: 2 },
        nodeConditional: { truePositive: 1, falsePositive: 0, falseNegative: 1, unitCount: 1 },
      },
    },
    {
      optionKnowledge: {
        applicable: true,
        eligibleCount: 1,
        correctCount: 1,
        confusionMatrix: {
          option_specific: { option_specific: 1 },
        },
        questionExact: true,
        falseAbstentionCount: 0,
        goldUndetermined: { count: 1, predictedUndeterminedCount: 0 },
        nodeEndToEnd: { truePositive: 2, falsePositive: 0, falseNegative: 0, unitCount: 1 },
        nodeConditional: { truePositive: 1, falsePositive: 1, falseNegative: 0, unitCount: 1 },
      },
    },
  ]);

  assert.equal(optionKnowledge.applicableQuestionCount, 2);
  assert.equal(optionKnowledge.eligibleCount, 3);
  assert.equal(optionKnowledge.correctCount, 2);
  assert.equal(optionKnowledge.accuracy, 2 / 3);
  assert.equal(optionKnowledge.confusionMatrix.question_only.question_only, 1);
  assert.equal(optionKnowledge.confusionMatrix.option_specific.option_specific, 1);
  assert.equal(optionKnowledge.confusionMatrix.option_specific.undetermined, 1);
  assert.equal(optionKnowledge.perClass.question_only.f1, 1);
  assert.equal(optionKnowledge.perClass.option_specific.f1, 2 / 3);
  assert.ok(Math.abs(optionKnowledge.macroF1 - (5 / 6)) < 1e-12);
  assert.equal(optionKnowledge.questionExactCount, 1);
  assert.equal(optionKnowledge.questionExactRate, 0.5);
  assert.equal(optionKnowledge.falseAbstentionCount, 1);
  assert.equal(optionKnowledge.falseAbstentionRate, 1 / 3);
  assert.deepEqual(optionKnowledge.goldUndetermined, {
    count: 2,
    predictedUndeterminedCount: 1,
    recall: 0.5,
  });
  assert.ok(Math.abs(optionKnowledge.nodeEndToEnd.f1 - (2 / 3)) < 1e-12);
  assert.ok(Math.abs(optionKnowledge.nodeConditional.f1 - (2 / 3)) < 1e-12);

  const markdown = renderMarkdown({
    status: "completed",
    manifestSha256: "hash",
    expectedCount: 2,
    distribution: { mature: 1, singleton: 1, unmatched: 0 },
    baselineHashes: {},
    results: [],
    attempts: [],
    metrics: {
      questionCount: 2,
      attemptCount: 2,
      scoredCount: 2,
      passedCount: 1,
      failedCount: 1,
      accuracy: 0.5,
      unassessedCount: 0,
      optionKnowledge,
    },
  });
  assert.match(markdown, /选项关系准确率 \/ macro-F1 \| 66\.67% \/ 83\.33%/);
  assert.match(markdown, /选项关系整题完全命中率 \| 50\.00%/);
  assert.match(markdown, /确定样本错误弃权率 \| 33\.33%/);
  assert.match(markdown, /选项节点端到端 \/ 条件 F1 \| 66\.67% \/ 66\.67%/);
  assert.match(markdown, /\| question_only \| 1 \| 1 \| 1 \| 100\.00% \| 100\.00% \| 100\.00% \|/);
  assert.match(markdown, /\| option_specific \| 2 \| 1 \| 1 \| 100\.00% \| 50\.00% \| 66\.67% \|/);
  assert.match(markdown, /\| option_specific \| 0 \| 1 \| 1 \| 0 \| 0 \| 0 \|/);
  assert.match(markdown, /Gold 为 `undetermined` 的诊断项：2 项；Agent 1 同样返回 `undetermined`：1 项；诊断召回率：50\.00%/);
  assert.match(markdown, /\| 端到端 \| 3 \| 3 \| 1 \| 2 \| 75\.00% \| 60\.00% \| 66\.67% \|/);
  assert.match(markdown, /\| 关系命中后条件指标 \| 2 \| 2 \| 1 \| 1 \| 66\.67% \| 66\.67% \| 66\.67% \|/);
});

test("batch aggregates quality, chain health, and all three replay modes independently", () => {
  const common = {
    attemptCount: 1,
    retried: false,
    assessmentStatus: "assessed",
    executionFailed: false,
    executionFailureCode: "",
    includedInAccuracy: true,
    countedResult: true,
    optionKnowledge: { applicable: false },
    retrySummary: {},
  };
  const candidateFields = {
    name: true,
    coreKnowledgeNodeId: true,
    requiredKnowledgeNodeIds: true,
    textbookAnchorNodeIds: true,
    assessmentAction: true,
    textbookEvidence: true,
    inclusionBoundary: false,
    exclusionBoundary: false,
  };
  const results = [
    {
      ...common,
      questionId: "q-mature",
      requestedMode: "mature",
      actualMode: "mature",
      coreKnowledgeExact: true,
      requiredKnowledge: { exact: false, f1: 0.8, predicted: ["a", "extra"], expected: ["a"] },
      familyDecision: "join_existing",
      primaryFamilyExact: true,
      familyMemberships: { exact: false, f1: 0.8 },
      agent3ContractStatus: "valid",
      retrySummary: { providerRetryCount: 1, totalRetryCount: 1, firstFailureReason: "provider_timeout" },
    },
    {
      ...common,
      questionId: "q-singleton",
      requestedMode: "singleton",
      actualMode: "singleton",
      coreKnowledgeExact: true,
      requiredKnowledge: { exact: true, f1: 1, predicted: ["b"], expected: ["b"] },
      familyDecision: "create_new",
      familyMemberships: { exact: true, f1: 1 },
      candidateFamilyDraftProposed: true,
      candidateFamilyDraft: {
        complete: false,
        fields: candidateFields,
        semanticComparable: true,
        semanticMatch: false,
        coreKnowledgeExact: true,
        requiredKnowledge: { exact: true },
        textbookAnchors: { recall: 1 },
        actionSemanticMatch: true,
      },
      agent3ContractStatus: "corrected",
      retrySummary: { constraintRetryCount: 1, totalRetryCount: 1, firstFailureReason: "candidate_contract_invalid" },
    },
    {
      ...common,
      questionId: "q-unmatched",
      requestedMode: "unmatched",
      actualMode: "mature",
      countedResult: false,
      coreKnowledgeExact: false,
      requiredKnowledge: { exact: true, f1: 1, predicted: ["c"], expected: ["c"] },
      familyDecision: "unresolved",
      familyMemberships: { exact: false, f1: 0 },
      unresolved: true,
      candidateFamilyDraftProposed: false,
      candidateFamilyDraft: null,
      agent3ContractStatus: "valid",
    },
    {
      ...common,
      questionId: "q-unmatched-provider-failure",
      requestedMode: "unmatched",
      actualMode: "unmatched",
      assessmentStatus: "unassessed",
      executionFailed: true,
      executionFailureCode: "provider_unavailable",
      includedInAccuracy: false,
      countedResult: null,
      agent3ContractStatus: "",
    },
  ];
  const attempts = [
    { questionId: "q-mature", mode: "mature", retrySummary: { providerRetryCount: 1, totalRetryCount: 1, firstFailureReason: "provider_timeout" } },
    { questionId: "q-mature", mode: "mature", retrySummary: { constraintRetryCount: 2, totalRetryCount: 2, firstFailureReason: "early_contract_invalid" } },
    ...results.slice(1).map((entry) => ({
      questionId: entry.questionId,
      mode: entry.requestedMode,
      retrySummary: entry.retrySummary,
    })),
  ];
  const metrics = aggregateMetrics(results, attempts);

  assert.equal(metrics.coreKnowledge.accuracy, 2 / 3);
  assert.ok(Math.abs(metrics.requiredKnowledge.f1.average - (2.8 / 3)) < 1e-12);
  assert.equal(metrics.existingFamily.memberships.f1.average, 0.8);
  assert.equal(metrics.requiredFamilyMemberships.applicableCount, 3);
  assert.equal(metrics.requiredFamilyMemberships.passedCount, 1);
  assert.equal(metrics.candidateFamily.applicableCount, 2, "missing unmatched draft remains a failed candidate case");
  assert.equal(metrics.candidateFamily.requiredCompleteCount, 1);
  assert.equal(metrics.candidateFamily.boundaryCompleteCount, 0);
  assert.equal(metrics.candidateFamily.successfulCount, 1, "optional boundaries do not fail candidate quality");
  assert.equal(metrics.unresolved.rate, 1 / 3);
  assert.equal(metrics.errorPropagation.rate, 1 / 3);
  assert.equal(metrics.modeConsistency.mismatchCount, 1);
  assert.equal(metrics.contracts.byStatus.corrected, 1);
  assert.equal(metrics.internalRetries.constraintRetryCount, 3);
  assert.equal(metrics.internalRetries.constraintRetryQuestionCount, 2);
  assert.equal(metrics.execution.failedCount, 1);
  assert.equal(metrics.byMode.mature.questionCount, 1);
  assert.equal(metrics.byMode.singleton.candidateFamily.successRate, 1);
  assert.equal(metrics.byMode.unmatched.questionCount, 2);

  const markdown = renderMarkdown({
    status: "completed",
    runKind: "calibration",
    countsTowardGate: false,
    manifestSha256: "hash",
    expectedCount: 4,
    distribution: { mature: 1, singleton: 1, unmatched: 2 },
    baselineHashes: {},
    finalHashes: {},
    results,
    attempts: [],
    metrics,
  });
  assert.match(markdown, /候选建族边界完整（诊断，不作硬门槛）/);
  assert.match(markdown, /\| singleton \| 1 \|/);
  assert.match(markdown, /约束修复 \| 3 次，涉及 2 题/);
  assert.match(markdown, /candidate_contract_invalid/);
  assert.match(markdown, /early_contract_invalid/);
});

test("batch replay is serial and retries only unassessed technical failures", async () => {
  const fixture = createFixture();
  try {
    const goldSnapshotPath = writeGoldSnapshot(fixture.root, [
      item("q-mature", "mature"),
      item("q-singleton", "singleton"),
      item("q-unmatched", "unmatched"),
    ]);
    const replayContextPath = writeReplayContext(fixture.root, goldSnapshotPath);
    const baseline = hashRuntime(fixture.runtimeDir);
    const callCounts = new Map();
    const order = [];
    const slept = [];
    let active = 0;
    let maxActive = 0;
    const runner = async (options) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      const callCount = (callCounts.get(options.questionId) || 0) + 1;
      callCounts.set(options.questionId, callCount);
      order.push(`${options.questionId}:${callCount}`);
      active -= 1;
      if (options.questionId === "q-mature" && callCount === 1) {
        return replayResult(options, baseline, {
          assessmentStatus: "unassessed",
          executionFailed: true,
          executionFailureCode: "provider_timeout",
          includedInAccuracy: false,
          modelGeneralizationSuccess: false,
          countedResult: null,
        });
      }
      if (options.questionId === "q-singleton") {
        return replayResult(options, baseline, {
          modelGeneralizationSuccess: false,
          countedResult: false,
        });
      }
      if (options.questionId === "q-unmatched") {
        return replayResult(options, baseline, {
          assessmentStatus: "unassessed",
          executionFailed: true,
          executionFailureCode: "provider_unavailable",
          includedInAccuracy: false,
          modelGeneralizationSuccess: false,
          countedResult: null,
        });
      }
      return replayResult(options, baseline);
    };

    const result = await runBlindReplayBatch({
      goldSnapshotPath,
      replayContextPath,
      runtimeDir: fixture.runtimeDir,
      outputRoot: fixture.outputRoot,
      expectedCount: 3,
      retryDelaysMs: [0, 0],
      runKind: "calibration",
      countsTowardGate: true,
    }, {
      runBlindReplay: runner,
      sleep: async (delayMs) => { slept.push(delayMs); },
      writeLog: () => {},
    });

    assert.equal(maxActive, 1);
    assert.deepEqual(order, [
      "q-mature:1",
      "q-mature:2",
      "q-singleton:1",
      "q-unmatched:1",
      "q-unmatched:2",
      "q-unmatched:3",
    ]);
    assert.deepEqual(slept, [0, 0, 0]);
    assert.equal(callCounts.get("q-singleton"), 1, "an assessed model failure must not be retried");
    assert.equal(result.summary.status, "completed");
    const { optionKnowledge } = result.summary.metrics;
    assert.equal(result.summary.metrics.questionCount, 3);
    assert.equal(result.summary.metrics.attemptCount, 6);
    assert.equal(result.summary.metrics.retriedQuestionCount, 2);
    assert.equal(result.summary.metrics.assessedCount, 2);
    assert.equal(result.summary.metrics.unassessedCount, 1);
    assert.equal(result.summary.metrics.scoredCount, 2);
    assert.equal(result.summary.metrics.passedCount, 1);
    assert.equal(result.summary.metrics.failedCount, 1);
    assert.equal(result.summary.metrics.accuracy, 0.5);
    assert.equal(result.summary.runKind, "calibration");
    assert.equal(result.summary.countsTowardGate, false);
    assert.equal(optionKnowledge.applicableQuestionCount, 0);
    assert.equal(optionKnowledge.eligibleCount, 0);
    assert.equal(optionKnowledge.accuracy, null);
    assert.deepEqual(hashRuntime(fixture.runtimeDir), baseline);
    assert.ok(fs.existsSync(result.manifestSnapshotPath));
    assert.ok(fs.existsSync(result.checkpointPath));
    assert.ok(fs.existsSync(result.attemptsPath));
    assert.ok(fs.existsSync(result.summaryJsonPath));
    assert.ok(fs.existsSync(result.summaryMarkdownPath));
    assert.equal(
      result.summary.manifestSha256,
      crypto.createHash("sha256").update(fs.readFileSync(goldSnapshotPath)).digest("hex"),
    );
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpointPath, "utf8"));
    assert.equal(checkpoint.status, "completed");
    assert.equal(checkpoint.runKind, "calibration");
    assert.equal(checkpoint.countsTowardGate, false);
    assert.deepEqual(checkpoint.finalHashes, baseline);
    assert.deepEqual(checkpoint.formalStateDifferences, []);
    assert.equal(checkpoint.completedQuestionCount, 3);
    assert.equal(checkpoint.currentQuestionIndex, 3);
    const attemptsDocument = JSON.parse(fs.readFileSync(result.attemptsPath, "utf8"));
    assert.equal(attemptsDocument.runKind, "calibration");
    assert.equal(attemptsDocument.countsTowardGate, false);
    assert.match(fs.readFileSync(result.summaryMarkdownPath, "utf8"), /\| 计入连续门禁 \| 否 \|/);
  } finally {
    fixture.cleanup();
  }
});

test("batch aborts immediately when a replay mutates formal runtime state", async () => {
  const fixture = createFixture();
  try {
    const goldSnapshotPath = writeGoldSnapshot(fixture.root, [
      item("q-mature", "mature"),
      item("q-singleton", "singleton"),
      item("q-unmatched", "unmatched"),
    ]);
    const replayContextPath = writeReplayContext(fixture.root, goldSnapshotPath);
    const baseline = hashRuntime(fixture.runtimeDir);
    let calls = 0;
    let caught;
    try {
      await runBlindReplayBatch({
        goldSnapshotPath,
        replayContextPath,
        runtimeDir: fixture.runtimeDir,
        outputRoot: fixture.outputRoot,
        expectedCount: 3,
        retryDelaysMs: [0, 0],
      }, {
        runBlindReplay: async (options) => {
          calls += 1;
          fs.writeFileSync(path.join(fixture.runtimeDir, "questions.json"), "changed\n", "utf8");
          return replayResult(options, baseline, {}, {
            formalStateUnchanged: false,
            changedFormalFiles: ["questions.json"],
            afterHashes: hashRuntime(fixture.runtimeDir),
          });
        },
        sleep: async () => {},
        writeLog: () => {},
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    assert.match(caught.message, /blind_batch_isolation_audit_failed:q-mature/);
    assert.equal(calls, 1);
    const summary = JSON.parse(fs.readFileSync(path.join(caught.batchOutputDir, "批次汇总.json"), "utf8"));
    assert.equal(summary.status, "aborted");
    assert.equal(summary.attempts.length, 1);
    assert.equal(summary.attempts[0].isolationAudit.passed, false);
    assert.equal(summary.results.length, 0);
    assert.equal(summary.formalStateDifferences.includes("questions.json"), true);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(caught.batchOutputDir, "批次检查点.json"), "utf8"));
    assert.equal(checkpoint.formalStateDifferences.includes("questions.json"), true);
  } finally {
    fixture.cleanup();
  }
});

test("batch rejects a replay whose reported beforeHashes differ from the batch baseline", async () => {
  const fixture = createFixture();
  try {
    const goldSnapshotPath = writeGoldSnapshot(fixture.root, [
      item("q-mature", "mature"),
      item("q-singleton", "singleton"),
      item("q-unmatched", "unmatched"),
    ]);
    const replayContextPath = writeReplayContext(fixture.root, goldSnapshotPath);
    const baseline = hashRuntime(fixture.runtimeDir);
    let calls = 0;
    await assert.rejects(
      runBlindReplayBatch({
        goldSnapshotPath,
        replayContextPath,
        runtimeDir: fixture.runtimeDir,
        outputRoot: fixture.outputRoot,
        expectedCount: 3,
        retryDelaysMs: [0, 0],
      }, {
        runBlindReplay: async (options) => {
          calls += 1;
          return replayResult(options, baseline, {}, {
            beforeHashes: { ...baseline, "questions.json": "wrong-before-hash" },
          });
        },
        sleep: async () => {},
        writeLog: () => {},
      }),
      /blind_batch_isolation_audit_failed:q-mature:report_before:questions.json/,
    );
    assert.equal(calls, 1);
  } finally {
    fixture.cleanup();
  }
});

test("a thrown replay error aborts without retrying the question", async () => {
  const fixture = createFixture();
  try {
    const goldSnapshotPath = writeGoldSnapshot(fixture.root, [
      item("q-mature", "mature"),
      item("q-singleton", "singleton"),
      item("q-unmatched", "unmatched"),
    ]);
    const replayContextPath = writeReplayContext(fixture.root, goldSnapshotPath);
    let calls = 0;
    await assert.rejects(
      runBlindReplayBatch({
        goldSnapshotPath,
        replayContextPath,
        runtimeDir: fixture.runtimeDir,
        outputRoot: fixture.outputRoot,
        expectedCount: 3,
        retryDelaysMs: [0, 0],
      }, {
        runBlindReplay: async () => {
          calls += 1;
          throw new Error("unexpected runner crash");
        },
        sleep: async () => {},
        writeLog: () => {},
      }),
      /blind_batch_replay_threw:q-mature:unexpected runner crash/,
    );
    assert.equal(calls, 1);
  } finally {
    fixture.cleanup();
  }
});

test("batch context preflight blocks before the replay runner and records zero model calls", async () => {
  const fixture = createFixture();
  try {
    const goldSnapshotPath = writeGoldSnapshot(fixture.root, [
      item("q-mature", "mature"),
      item("q-singleton", "singleton"),
      item("q-unmatched", "unmatched"),
    ]);
    const replayContextPath = writeReplayContext(fixture.root, goldSnapshotPath);
    let replayCalls = 0;
    let caught;
    try {
      await runBlindReplayBatch({
        goldSnapshotPath,
        replayContextPath,
        runtimeDir: fixture.runtimeDir,
        outputRoot: fixture.outputRoot,
        expectedCount: 3,
        retryDelaysMs: [0, 0],
        runKind: "contract_smoke",
      }, {
        runBlindReplay: async () => {
          replayCalls += 1;
          throw new Error("must not run");
        },
        buildReplayContextPreflight: () => ({
          status: "blocked",
          eligibleForReplay: false,
          modelCallsPerformed: 0,
          summary: { blockerCount: 1, warningCount: 0 },
          blockers: [{ questionId: "q-mature", replayMode: "mature", stage: "context", code: "fixture_block", message: "blocked" }],
          warnings: [],
          items: [],
        }),
        writeLog: () => {},
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    assert.match(caught.message, /blind_batch_context_preflight_failed:1/);
    assert.equal(replayCalls, 0);
    const summary = JSON.parse(fs.readFileSync(path.join(caught.batchOutputDir, "批次汇总.json"), "utf8"));
    assert.equal(summary.status, "aborted");
    assert.equal(summary.runKind, "contract_smoke");
    assert.equal(summary.countsTowardGate, false);
    assert.equal(summary.contextPreflight.modelCallsPerformed, 0);
    assert.equal(summary.attempts.length, 0);
  } finally {
    fixture.cleanup();
  }
});
