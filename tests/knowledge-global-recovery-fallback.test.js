const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAiTaskStore } = require("../apps/api/src/ai-task-store");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");
const { createMemoryKnowledgeDossierStore } = require("../apps/api/src/knowledge-dossier-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryTextbookKnowledgeStore } = require("../apps/api/src/textbook-knowledge-store");

const bookId = "global-recovery-fallback-book";
const questionId = "global-recovery-fallback-question";
const targetNodeId = "knowledge-080";

function buildStores() {
  const catalogNodes = [
    { id: "chapter", level: 1, title: "第一章 语音", startPage: 1, endPage: 120 },
    { id: "section", level: 2, title: "第一节 发音方法", startPage: 1, endPage: 120 },
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `knowledge-${String(index + 1).padStart(3, "0")}`,
      level: 3,
      title: index === 79 ? "八十、阻碍方式目标" : `${index + 1}、备用知识${index + 1}`,
      startPage: index + 1,
      endPage: index + 1,
    })),
  ];
  const question = {
    id: questionId,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId,
    chapter: "第一章 语音 > 第一节 发音方法 > 阻碍方式目标",
    primaryKnowledgePoint: "阻碍方式目标",
    knowledgePoints: ["阻碍方式目标"],
    subKnowledgePoints: [],
    type: "single_choice",
    typeLabel: "单选题",
    stem: "从阻碍方式目标看，声母 b 属于哪类辅音？",
    options: [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }],
    correctAnswer: ["A"],
    referenceAnswer: "塞音",
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    maxScore: 1,
    version: 1,
  };
  const questionStore = createMemoryQuestionStore([question]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({ bookId, catalogNodes, outlineNodes: [], chunks: [], questions: [question] });
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([{
    bookId,
    status: "ready",
    version: 1,
    source: { mode: "test" },
    progress: { processedPages: 1, totalPages: 1, failedPages: 0, percent: 100 },
    pages: [{ pdfPage: 80, printedPage: 80, text: "阻碍方式目标把辅音分为塞音、擦音等。" }],
    chunks: [{
      id: "chunk-target",
      bookId,
      catalogNodeId: targetNodeId,
      catalogPath: "语音 > 发音方法 > 阻碍方式目标",
      text: "阻碍方式目标把辅音分为塞音、擦音等。",
      retrievalText: "阻碍方式目标 辅音 塞音 擦音",
      printedPageStart: 80,
      printedPageEnd: 80,
      pdfPageStart: 80,
      enabled: true,
      retrievalEnabled: true,
    }],
  }]);
  return {
    questionStore,
    knowledgeStructureStore,
    textbookKnowledgeStore,
    questionFamilyStore: createMemoryQuestionFamilyStore(),
  };
}

function completion(response, model, content) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    model,
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
}

function promptFrom(payload) {
  return payload.messages.map((message) => String(message.content || "")).join("\n");
}

function treeIndexFrom(prompt) {
  const match = prompt.match(/完整知识树索引（可跨分支选择）：\s*\n([\s\S]*?)\n\n教材检索证据：/);
  assert.ok(match, "fallback prompt should contain its scoped tree index");
  return JSON.parse(match[1]);
}

function featureOutput() {
  return {
    questionId,
    featureProfile: {
      optionKnowledgeProtocolVersion: "option-knowledge-v2",
      choiceStructure: "direct_options",
      questionMode: "stem_direct",
      stemKeywords: ["阻碍方式目标"],
      coreKeywords: ["阻碍方式目标"],
      stemKnowledgeHints: ["阻碍方式目标"],
      optionFeatures: [
        { key: "A", keywords: ["塞音"], knowledgeRelation: "question_only", knowledgeHints: [], isCorrect: true, role: "answer", weight: 0.7, decisionRole: "supports_answer", requiredForDecision: true, basis: "题目层阻碍方式知识足以直接作答。" },
        { key: "B", keywords: ["擦音"], knowledgeRelation: "question_only", knowledgeHints: [], isCorrect: false, role: "distractor", weight: 0.3, decisionRole: "required_for_elimination", requiredForDecision: true, basis: "题目层阻碍方式知识足以排除该项。" },
      ],
      atomicStatements: [],
      optionComposition: [],
      primaryKnowledgeHints: ["阻碍方式目标"],
      secondaryKnowledgeHints: [],
      dependencySteps: [{ order: 1, label: "阻碍方式目标", source: "stem", necessity: "core", basis: "直接决定答案" }],
      knowledgePriorities: [{ label: "阻碍方式目标", role: "primary", weight: 1, basis: "题干直接询问" }],
      primaryBasis: "题干直接询问阻碍方式目标。",
      crossFamilyProbability: 0,
      callDepth: 1,
    },
  };
}

async function runScenario(context, { outOfScope = false } = {}) {
  const allKnowledgeNodeIds = Array.from({ length: 100 }, (_, index) => `knowledge-${String(index + 1).padStart(3, "0")}`);
  const requests = [];
  const primary = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(504, { "Content-Type": "text/plain" });
      response.end("gateway timeout");
    });
  });
  await new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => primary.close(resolve)));

  const secondary = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const prompt = promptFrom(payload);
      requests.push({ model: payload.model, prompt });
      if (prompt.includes("只负责独立提取题目特征")) return completion(response, payload.model, featureOutput());
      if (prompt.includes("只负责读取 Agent 1 已持久化")) {
        const candidates = JSON.parse(prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/)[1]);
        return completion(response, payload.model, {
          questionId,
          decision: "none_of_candidates",
          selectedNodeIds: [],
          corePathStatus: "core_path_not_viable",
          auxiliaryGap: null,
          candidateRejections: candidates.map((candidate) => ({ nodeId: candidate.id, reason: "不能承载核心考查。" })),
          confidence: 0.8,
          reason: "当前五候选不包含核心知识。",
        });
      }
      if (prompt.includes("Agent 3 的知识树整树恢复步骤")) {
        const offered = treeIndexFrom(prompt);
        const offeredIds = new Set(offered.map((node) => node.id));
        const selectedId = outOfScope
          ? allKnowledgeNodeIds.find((id) => !offeredIds.has(id))
          : targetNodeId;
        assert.ok(selectedId);
        return completion(response, payload.model, { recoveries: [{
          questionId,
          decision: "recover",
          primaryNodeId: selectedId,
          requiredNodeIds: [selectedId],
          confidence: 0.92,
          reason: "限时备用候选重新定位。",
          uncertainty: "",
          evidenceChunkIds: ["chunk-target"],
        }] });
      }
      if (prompt.includes("负责回到教材原文独立核验知识与题族")) {
        return completion(response, payload.model, { verifications: [{
          questionId,
          decision: "confirm",
           primaryNodeId: targetNodeId,
           requiredNodeIds: [targetNodeId],
           optionRelationAssessments: [{
             key: "A",
             decision: "confirm",
             verifiedKnowledgeNodeIds: [],
             proposedKnowledgeRelation: "",
             proposedKnowledgeNodeIds: [],
             evidenceChunkIds: ["chunk-target"],
             reason: "教材中的阻碍方式分类足以确认 A 使用题目层知识。",
           }, {
             key: "B",
             decision: "confirm",
             verifiedKnowledgeNodeIds: [],
             proposedKnowledgeRelation: "",
             proposedKnowledgeNodeIds: [],
             evidenceChunkIds: ["chunk-target"],
             reason: "教材中的阻碍方式分类足以确认 B 使用题目层知识。",
           }],
           focusKey: "obstruction-target",
          focusLabel: "阻碍方式目标",
          action: "分类判断",
          confidence: 0.95,
          reason: "教材证据支持。",
          uncertainty: "",
          evidenceChunkIds: ["chunk-target"],
          familyDecision: "unresolved",
          primaryFamilyId: "",
          relatedFamilyIds: [],
          relatedFamilyAssessments: [],
          matchedFamilyIds: [],
          duplicateFamilyIds: [],
          familySimilarityReason: "没有现有题族。",
        }] });
      }
      response.writeHead(500).end();
      return undefined;
    });
  });
  await new Promise((resolve) => secondary.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => secondary.close(resolve)));

  const primaryProvider = { id: "recovery-primary", name: "恢复主模型", protocol: "openai_chat_completions", baseUrl: `http://127.0.0.1:${primary.address().port}`, apiKey: "test", models: ["primary-model"], timeoutMs: 5000, supportsJsonMode: true, enabled: true };
  const navigationProvider = { id: "navigation", name: "分层模型", protocol: "openai_chat_completions", baseUrl: `http://127.0.0.1:${secondary.address().port}`, apiKey: "test", models: ["navigation-model"], timeoutMs: 5000, supportsJsonMode: true, enabled: true };
  const fallbackProvider = { id: "recovery-fallback", name: "恢复备用模型", protocol: "openai_chat_completions", baseUrl: `http://127.0.0.1:${secondary.address().port}`, apiKey: "test", models: ["fallback-model"], timeoutMs: 5000, supportsJsonMode: true, enabled: true };
  const aiTaskStore = createMemoryAiTaskStore();
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const server = createServer({
    ...buildStores(),
    aiTaskStore,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
    aiConfigStore: createMemoryAiConfigStore({
      providers: [primaryProvider, navigationProvider, fallbackProvider],
      routes: {
        knowledge_feature_extraction: { mode: "provider", providerId: navigationProvider.id, model: "navigation-model", temperature: 0.1, maxTokens: 2200 },
        knowledge_hierarchy_navigation: { mode: "provider", providerId: navigationProvider.id, model: "navigation-model", temperature: 0.1, maxTokens: 1800 },
        knowledge_global_recovery: { mode: "provider", providerId: primaryProvider.id, model: "primary-model", temperature: 0.1, maxTokens: 3500 },
        knowledge_batch_verification: { mode: "provider", providerId: fallbackProvider.id, model: "fallback-model", temperature: 0.1, maxTokens: 5000 },
      },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createdResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, questionIds: [questionId], limit: 1 }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 202, JSON.stringify(created));
  let job;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    job = (await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${created.job.id}`).then((response) => response.json())).job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    job,
    result: knowledgeClassificationStore.resultForQuestion(created.job.id, questionId),
    recoveryTasks: aiTaskStore.list({ sceneId: "knowledge_global_recovery", limit: 10 }),
    requests,
  };
}

test("global recovery switches from a failed primary route to a scoped different model and reaches review", async (context) => {
  const { job, result, recoveryTasks, requests } = await runScenario(context);
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.equal(result.status, "pending_review");
  assert.equal(result.agent2Verification.primaryNodeId, targetNodeId);
  assert.equal(result.agent2Verification.recoveredFrom, "none_of_candidates");

  const primaryTask = recoveryTasks.find((task) => task.inputSummary.attemptKind === "full_primary");
  const fallbackTask = recoveryTasks.find((task) => task.inputSummary.attemptKind === "fallback_scoped");
  assert.equal(primaryTask.providerId, "recovery-primary");
  assert.equal(primaryTask.model, "primary-model");
  assert.equal(primaryTask.status, "failed");
  assert.match(primaryTask.errorCode, /HTTP 504/);
  assert.equal(fallbackTask.providerId, "recovery-fallback");
  assert.equal(fallbackTask.model, "fallback-model");
  assert.equal(fallbackTask.status, "succeeded");
  assert.ok(fallbackTask.inputSummary.knowledgeNodeCount <= 64);
  assert.ok(fallbackTask.inputSummary.knowledgeNodeCount < fallbackTask.inputSummary.originalKnowledgeNodeCount);
  const fallbackRequest = requests.find((request) => request.model === "fallback-model" && request.prompt.includes("evidence_scoped"));
  assert.ok(fallbackRequest);
  assert.ok(treeIndexFrom(fallbackRequest.prompt).length <= 64);
});

test("scoped global recovery rejects a node outside the fallback scope without persisting verification", async (context) => {
  const { job, result, recoveryTasks } = await runScenario(context, { outOfScope: true });
  assert.equal(job.status, "failed");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "knowledge_global_recovery_exhausted");
  assert.equal(result.agent2Verification, null);
  const fallbackTask = recoveryTasks.find((task) => task.inputSummary.attemptKind === "fallback_scoped");
  assert.equal(fallbackTask.status, "failed");
  assert.equal(fallbackTask.errorCode, "knowledge_classification_global_recovery_selection_outside_scope");
});
