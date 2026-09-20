const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classifyError, createFileAiTaskStore, createMemoryAiTaskStore } = require("../apps/api/src/ai-task-store");

test("AI task records persist, redact secrets and recover interrupted work", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-ai-task-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "tasks.json");
  const store = createFileAiTaskStore(filePath);
  const failed = store.start({
    requestId: "failed-request",
    sceneId: "explanation_chat",
    sceneLabel: "补充解析与追问",
    inputSummary: { questionId: "question-001", messageChars: 12 },
  });
  store.finish(failed.id, {
    status: "failed",
    errorCode: "provider_http_error: Bearer sk-secret-value-12345678 HTTP 401",
    failureStage: "upstream_connect",
  });
  const succeeded = store.start({ requestId: "timed-request", sceneId: "subjective_scoring" });
  store.finish(succeeded.id, {
    status: "succeeded",
    chargeable: true,
    timings: {
      retrievalMs: 18,
      contextMs: 2,
      connectMs: 140,
      upstreamFirstTokenMs: 620,
      generationMs: 580,
      upstreamMs: 1200,
      parseMs: 2,
      normalizeMs: 1,
    },
  });
  store.start({ requestId: "running-request", sceneId: "subjective_scoring" });

  const reloaded = createFileAiTaskStore(filePath);
  const dashboard = reloaded.dashboard();
  assert.equal(dashboard.tasks.length, 3);
  assert.equal(dashboard.tasks.find((task) => task.requestId === "running-request").errorCode, "server_interrupted");
  assert.deepEqual(dashboard.tasks.find((task) => task.requestId === "timed-request").timings, {
    retrievalMs: 18,
    contextMs: 2,
    connectMs: 140,
    upstreamFirstTokenMs: 620,
    generationMs: 580,
    upstreamMs: 1200,
    parseMs: 2,
    normalizeMs: 1,
  });
  const savedFailure = dashboard.tasks.find((task) => task.requestId === "failed-request");
  assert.equal(savedFailure.errorCategory, "upstream_http");
  assert.doesNotMatch(savedFailure.errorCode, /secret-value/);
  assert.deepEqual(savedFailure.inputSummary, { questionId: "question-001", messageChars: 12 });
});

test("AI task progress updates merge safely and failed work can restart", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-ai-task-progress-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFileAiTaskStore(path.join(directory, "tasks.json"));
  const task = store.start({
    sceneId: "exam_paper_extraction",
    inputSummary: { backgroundImport: true, paperFileName: "试卷.pdf", stage: "queued", percent: 3 },
  });

  const updated = store.update(task.id, { inputSummary: { stage: "recognizing_paper", percent: 42, completedUnits: 2, totalUnits: 5 } });
  assert.equal(updated.inputSummary.paperFileName, "试卷.pdf");
  assert.equal(updated.inputSummary.percent, 42);
  assert.equal(updated.inputSummary.completedUnits, 2);
  assert.ok(updated.updatedAt >= task.startedAt);

  store.finish(task.id, { status: "failed", errorCode: "provider_output_format_error" });
  const restarted = store.restart(task.id, { inputSummary: { stage: "queued", percent: 3, runAttempt: 2 } });
  assert.equal(restarted.status, "running");
  assert.equal(restarted.errorCode, "");
  assert.equal(restarted.inputSummary.paperFileName, "试卷.pdf");
  assert.equal(restarted.inputSummary.runAttempt, 2);
  assert.equal(restarted.inputSummary.completedUnits, 2);
});

test("Agent 2 JSON and navigation contract failures are classified as output format errors", () => {
  const errorCodes = [
    "knowledge_classification_agent2_navigation_json_invalid",
    "knowledge_classification_agent2_navigation_selection_outside_candidates",
    "knowledge_classification_agent2_navigation_core_path_conflict",
    "knowledge_classification_agent2_contract_failed",
  ];
  errorCodes.forEach((errorCode) => assert.equal(classifyError(errorCode), "output_format", errorCode));

  const store = createMemoryAiTaskStore();
  errorCodes.forEach((errorCode, index) => {
    const task = store.start({ sceneId: "knowledge_hierarchy_navigation", requestId: `contract-${index}` });
    const finished = store.finish(task.id, { status: "failed", errorCode, failureStage: "output_validation" });
    assert.equal(finished.errorCategory, "output_format", errorCode);
  });
  assert.deepEqual(store.dashboard().today.errorBreakdown, [{ category: "output_format", count: errorCodes.length }]);
});
