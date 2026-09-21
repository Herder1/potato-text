const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const { readFrozenGoldSnapshot } = require("../../apps/api/src/classification-gold-review-store");
const {
  buildGoldSemanticPreflight,
  buildReplayContextFromRuntime,
  writePreflightReport,
} = require("./classification-blind-replay-context");

function parsePositiveInteger(value, errorCode) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(errorCode);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    goldSnapshotPath: "",
    runtimeDir: path.resolve(__dirname, "../../.runtime"),
    outputPath: "",
    reportPath: "",
    expectedCount: undefined,
    semanticOnly: false,
    snapshotOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--gold-snapshot=")) options.goldSnapshotPath = argument.slice("--gold-snapshot=".length);
    else if (argument === "--gold-snapshot") options.goldSnapshotPath = String(argv[++index] || "");
    else if (argument.startsWith("--runtime-dir=")) options.runtimeDir = argument.slice("--runtime-dir=".length);
    else if (argument === "--runtime-dir") options.runtimeDir = String(argv[++index] || "");
    else if (argument.startsWith("--output=")) options.outputPath = argument.slice("--output=".length);
    else if (argument === "--output") options.outputPath = String(argv[++index] || "");
    else if (argument.startsWith("--report=")) options.reportPath = argument.slice("--report=".length);
    else if (argument === "--report") options.reportPath = String(argv[++index] || "");
    else if (argument.startsWith("--expected-count=")) options.expectedCount = parsePositiveInteger(argument.slice("--expected-count=".length), "blind_replay_preflight_expected_count_invalid");
    else if (argument === "--expected-count") options.expectedCount = parsePositiveInteger(argv[++index], "blind_replay_preflight_expected_count_invalid");
    else if (argument === "--semantic-only") options.semanticOnly = true;
    else if (argument === "--snapshot-only") options.snapshotOnly = true;
    else if (argument === "--help") options.help = true;
    else throw new Error(`blind_replay_preflight_argument_unknown:${argument}`);
  }
  if (!options.help && !options.goldSnapshotPath) throw new Error("blind_replay_preflight_gold_snapshot_required");
  if (!options.help && !options.semanticOnly && !options.outputPath) throw new Error("blind_replay_context_output_required");
  return options;
}

function defaultSemanticReportPath(options, loadedGold) {
  if (options.reportPath) return path.resolve(options.reportPath);
  const base = options.outputPath
    ? path.resolve(`${options.outputPath}.gold-preflight.json`)
    : path.resolve(path.dirname(loadedGold.filePath), `${path.basename(loadedGold.filePath, ".json")}.semantic-preflight.json`);
  return base;
}

function run(options) {
  const loadedGold = readFrozenGoldSnapshot(options.goldSnapshotPath, { requireSidecar: true });
  const formalFamilyStatePath = path.resolve(options.runtimeDir, "question-families.json");
  const formalFamilyBytes = !options.snapshotOnly && fs.existsSync(formalFamilyStatePath)
    ? fs.readFileSync(formalFamilyStatePath)
    : null;
  const semanticReport = buildGoldSemanticPreflight(loadedGold, {
    expectedCount: options.expectedCount,
    ...(formalFamilyBytes ? {
      formalFamilyState: JSON.parse(formalFamilyBytes.toString("utf8")),
      formalFamilyStatePath,
      formalFamilyStateSha256: crypto.createHash("sha256").update(formalFamilyBytes).digest("hex"),
    } : {}),
  });
  const semanticPaths = writePreflightReport(semanticReport, defaultSemanticReportPath(options, loadedGold));
  if (options.semanticOnly) return { semanticReport, semanticPaths };
  if (!semanticReport.eligibleForContextFreeze) {
    const error = new Error("blind_replay_context_gold_preflight_failed");
    error.preflightReport = semanticReport;
    error.preflightPath = semanticPaths.jsonPath;
    throw error;
  }
  return {
    semanticReport,
    semanticPaths,
    ...buildReplayContextFromRuntime({
      goldSnapshotPath: options.goldSnapshotPath,
      runtimeDir: options.runtimeDir,
      outputPath: options.outputPath,
      expectedCount: options.expectedCount,
    }),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      "用法：",
      "  node scripts/classification/prepare-classification-blind-replay-context.js --gold-snapshot 快照.json --semantic-only [--snapshot-only] [--report 预检.json]",
      "  node scripts/classification/prepare-classification-blind-replay-context.js --gold-snapshot 快照.json --output 回放上下文C1.json [--runtime-dir .runtime] [--expected-count 20]",
      "",
    ].join("\n"));
    return;
  }
  const result = run(options);
  if (options.semanticOnly) {
    process.stdout.write(`[盲测预检] ${result.semanticReport.status === "passed" ? "通过" : "阻断"}；模型调用 0；报告：${result.semanticPaths.jsonPath}\n`);
    return;
  }
  process.stdout.write(`[盲测上下文] C1 已冻结：${result.paths.filePath}\n`);
  process.stdout.write(`[盲测上下文] 上下文预检：${result.preflight.status}；模型调用 0；报告：${result.paths.jsonPath}\n`);
  if (!result.preflight.eligibleForReplay) throw new Error("blind_replay_context_preflight_failed");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[盲测预检] 失败：${error.message || error}\n`);
    if (error.preflightPath) process.stderr.write(`[盲测预检] 报告：${error.preflightPath}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  defaultSemanticReportPath,
  parseArgs,
  run,
};
