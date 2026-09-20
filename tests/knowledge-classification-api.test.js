const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createServer, knowledgeClassificationQuestionBaseline } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryClassificationCommitStore } = require("../apps/api/src/classification-commit-store");
const { createMemoryAiTaskStore } = require("../apps/api/src/ai-task-store");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");
const { createMemoryKnowledgeDossierStore } = require("../apps/api/src/knowledge-dossier-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryTextbookKnowledgeStore } = require("../apps/api/src/textbook-knowledge-store");



const bookId = "modern-chinese-7-1";

function question(id, stem) {
  return {
    id,
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId,
    chapter: "第二章 语音 > 辅音与声母",
    primaryKnowledgePoint: "辅音的发音方法",
    knowledgePoints: ["辅音的发音方法"],
    subKnowledgePoints: ["阻碍方式"],
    type: "single_choice",
    typeLabel: "单选题",
    stem,
    options: [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }],
    correctAnswer: ["A"],
    referenceAnswer: "塞音",
    maxScore: 1,
    answerSource: "team_verified",
    answerReviewStatus: "verified",
    version: 1,
  };
}

function buildStores({ additionalCatalogNodes = [], prependKnowledgeChunks = [] } = {}) {
  const questions = [
    question("classification-q1", "从阻碍方式看，声母 b 属于哪类辅音？"),
    question("classification-q2", "从阻碍方式看，声母 d 属于哪类辅音？"),
  ];
  const questionStore = createMemoryQuestionStore(questions);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  const structure = knowledgeStructureStore.generate({
    bookId,
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "consonants", level: 2, title: "第三节 辅音与声母", startPage: 35, endPage: 50 },
      { id: "method", level: 3, title: "一、辅音的发音方法", startPage: 36, endPage: 42 },
      { id: "obstruction", level: 4, title: "（一）看阻碍的方式", startPage: 36, endPage: 38 },
      { id: "voicing", level: 4, title: "（二）看声带是否振动", startPage: 39, endPage: 40 },
      { id: "airflow", level: 4, title: "（三）看气流的强弱", startPage: 41, endPage: 42 },
      ...additionalCatalogNodes,
    ],
    outlineNodes: [],
    chunks: [],
    questions,
  });
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([{
    bookId,
    status: "ready",
    version: 3,
    source: { mode: "test" },
    progress: { processedPages: 1, totalPages: 1, failedPages: 0, percent: 100 },
    pages: [{ pdfPage: 40, printedPage: 36, text: "辅音按照形成阻碍和克服阻碍的方式，可以分为塞音、擦音等。" }],
    chunks: [...prependKnowledgeChunks, {
      id: "chunk-obstruction",
      bookId,
      catalogNodeId: "obstruction",
      catalogPath: "语音 > 辅音与声母 > 辅音的发音方法 > 看阻碍的方式",
      text: "辅音按照形成阻碍和克服阻碍的方式，可以分为塞音、擦音等。",
      retrievalText: "辅音 按照 形成阻碍 克服阻碍 塞音 擦音",
      printedPageStart: 36,
      printedPageEnd: 36,
      pdfPageStart: 40,
      enabled: true,
      retrievalEnabled: true,
    }],
    updatedAt: 300,
  }]);
  const questionFamilyStore = createMemoryQuestionFamilyStore();
  const familyBatch = questionFamilyStore.generate(questions, bookId, {
    fingerprintMap: new Map(structure.fingerprints.map((item) => [item.questionId, item])),
    nodeOrder: new Map(structure.nodes.map((node, index) => [node.id, index + 1])),
  });
  const family = familyBatch.families[0];
  questionFamilyStore.review(family.id, { status: "confirmed", members: family.members }, "原审核员");
  return {
    questions,
    questionStore,
    knowledgeStructureStore,
    textbookKnowledgeStore,
    questionFamilyStore,
  };
}

function buildVowelCrossKnowledgeStores() {
  const vowelQuestion = {
    id: "classification-vowel-q1",
    library: "official",
    status: "official",
    subjectId: "modern-chinese",
    bookId,
    chapter: "第一章语音·第三节元音与韵母",
    primaryKnowledgePoint: "韵母的结构",
    knowledgePoints: ["韵母的结构"],
    subKnowledgePoints: [],
    type: "single_choice",
    typeLabel: "单选题",
    stem: "普通话“笑”的韵腹是（）。",
    options: [
      { key: "A", text: "前、低、不圆唇元音" },
      { key: "B", text: "后、半高、圆唇元音" },
      { key: "C", text: "后、低、不圆唇元音" },
      { key: "D", text: "央、低、不圆唇元音" },
    ],
    correctAnswer: ["C"],
    referenceAnswer: "C【精析】韵母 ao 和 iao 的 a 都属于后、低、不圆唇元音。",
    answerVariants: {
      official: "C【精析】韵母 ao 和 iao 的 a 都属于后、低、不圆唇元音。",
      ai: "D。把拼音字母 a 直接当作央元音。",
      community: "",
    },
    maxScore: 2,
    answerSource: "pdf_answer",
    answerReviewStatus: "verified",
    answerVerified: true,
    version: 1,
  };
  const chunks = [
    {
      id: "chunk-finals-structure",
      bookId,
      catalogNodeId: "finals-structure",
      catalogPath: "语音 > 元音与韵母 > 韵母的结构",
      text: "韵母可以分为韵头、韵腹和韵尾。iao 中 i 是韵头，a 是韵腹，o 表示韵尾的实际音值。",
      retrievalText: "韵母的结构 韵头 韵腹 韵尾 iao",
      printedPageStart: 53,
      printedPageEnd: 53,
      enabled: true,
      retrievalEnabled: true,
    },
    {
      id: "chunk-tongue-vowel",
      bookId,
      catalogNodeId: "tongue-vowel",
      catalogPath: "语音 > 元音与韵母 > 元音的发音 > 舌面元音",
      text: "舌面元音从舌位高低、舌位前后和唇形圆展三个方面描写；[ɑ] 是后、低、不圆唇元音。",
      retrievalText: "舌面元音 舌位高低 舌位前后 唇形圆展 [ɑ] 后 低 不圆唇",
      printedPageStart: 46,
      printedPageEnd: 46,
      enabled: true,
      retrievalEnabled: true,
    },
    {
      id: "chunk-allophone",
      bookId,
      catalogNodeId: "allophone",
      catalogPath: "语音 > 音位 > 音位变体",
      text: "同一拼音字母在不同语音环境中可有不同实际音值。a 的音位变体包括 [A]、[a]、[ɑ]，iao 的实际音值为 [iɑu]。",
      retrievalText: "音位变体 拼音字母 实际音值 a [A] [a] [ɑ] iao [iɑu] 出现条件",
      printedPageStart: 99,
      printedPageEnd: 99,
      enabled: true,
      retrievalEnabled: true,
    },
  ];
  const questionStore = createMemoryQuestionStore([vowelQuestion]);
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId,
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第一章 语音", startPage: 20, endPage: 105 },
      { id: "vowels", level: 2, title: "第三节 元音与韵母", startPage: 45, endPage: 62 },
      { id: "vowel-pronunciation", level: 3, title: "一、元音的发音", startPage: 45, endPage: 50 },
      { id: "tongue-vowel", level: 4, title: "1. 舌面元音", startPage: 46, endPage: 47 },
      { id: "finals-structure", level: 3, title: "三、韵母的结构", startPage: 53, endPage: 55 },
      { id: "phoneme", level: 2, title: "第七节 音位", startPage: 95, endPage: 102 },
      { id: "allophone", level: 3, title: "（二）音位变体", startPage: 98, endPage: 100 },
    ],
    outlineNodes: [],
    chunks,
    questions: [vowelQuestion],
  });
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([{
    bookId,
    status: "ready",
    version: 9,
    source: { mode: "test" },
    progress: { processedPages: 3, totalPages: 3, failedPages: 0, percent: 100 },
    pages: [],
    chunks,
    updatedAt: 900,
  }]);
  return {
    questions: [vowelQuestion],
    questionStore,
    knowledgeStructureStore,
    textbookKnowledgeStore,
    questionFamilyStore: createMemoryQuestionFamilyStore(),
  };
}

function agent2ContractFeatureOutput() {
  return {
    questionId: "classification-q1",
    featureProfile: {
      optionKnowledgeProtocolVersion: "option-knowledge-v2",
      choiceStructure: "direct_options",
      questionMode: "stem_direct",
      stemKeywords: ["阻碍方式", "声母 b"],
      coreKeywords: ["辅音发音方法"],
      stemKnowledgeHints: ["阻碍方式"],
      optionFeatures: [{
        key: "A",
        keywords: ["塞音"],
        knowledgeRelation: "question_only",
        knowledgeHints: [],
        isCorrect: true,
        role: "answer",
        weight: 0.8,
        decisionRole: "supports_answer",
        requiredForDecision: true,
        basis: "答案直接依赖阻碍方式。",
      }, {
        key: "B",
        keywords: ["擦音"],
        knowledgeRelation: "question_only",
        knowledgeHints: [],
        isCorrect: false,
        role: "distractor",
        weight: 0.2,
        decisionRole: "required_for_elimination",
        requiredForDecision: true,
        basis: "需要区分塞音与擦音。",
      }],
      primaryKnowledgeHints: ["阻碍方式"],
      secondaryKnowledgeHints: [],
      dependencySteps: [{
        order: 1,
        label: "按形成和克服阻碍的方式判断辅音类别",
        source: "stem",
        necessity: "core",
        dependencyRole: "independent_required",
        coveredByStepRef: "",
        basis: "题干直接询问阻碍方式。",
      }, {
        order: 2,
        label: "把题面中的发音描述还原为辅音类别",
        source: "option",
        necessity: "required",
        dependencyRole: "input_descriptor",
        coveredByStepRef: "dep-1",
        basis: "只是把题面已给描述转成核心规则的输入，不是独立知识依赖。",
      }],
      knowledgePriorities: [{ label: "阻碍方式", role: "primary", weight: 1, basis: "核心考查。" }],
      primaryBasis: "题干直接考查阻碍方式。",
      crossFamilyProbability: 0.05,
      callDepth: 1,
    },
  };
}

function validAgent2ContractNavigation(prompt) {
  const candidateBlock = prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/);
  const selectedNodeId = JSON.parse(candidateBlock[1])[0].id;
  return {
    questionId: "classification-q1",
    decision: "node",
    selectedNodeIds: [selectedNodeId],
    corePathStatus: "core_path_viable",
    auxiliaryGap: null,
    candidateRejections: [],
    confidence: 0.96,
    reason: "沿教材知识树选择阻碍方式所在路径。",
  };
}

function withAgent3OptionRelationAssessments(content, prompt) {
  if (!content || !Array.isArray(content.verifications)) return content;
  const featureBlock = prompt.match(/Agent 1 题目特征：\n([\s\S]*?)\n\nAgent 2 逐层轨迹：/);
  if (!featureBlock) return content;
  const profiles = new Map(JSON.parse(featureBlock[1]).map((item) => [String(item.questionId || ""), item.features || {}]));
  return {
    ...content,
    verifications: content.verifications.map((verification) => {
      if (Object.prototype.hasOwnProperty.call(verification, "optionRelationAssessments")) return verification;
      const profile = profiles.get(String(verification.questionId || "")) || {};
      if (profile.optionKnowledgeProtocolVersion !== "option-knowledge-v2") return verification;
      const relationItems = profile.choiceStructure === "composed_options"
        ? (profile.atomicStatements || []) : (profile.optionFeatures || []);
      const evidenceChunkId = String(verification.evidenceChunkIds?.[0] || "");
      return {
        ...verification,
        optionRelationAssessments: relationItems.map((item) => ({
          key: item.key,
          decision: "confirm",
          verifiedKnowledgeNodeIds: item.knowledgeRelation === "option_specific"
            ? [verification.requiredNodeIds?.at(-1)].filter(Boolean) : [],
          proposedKnowledgeRelation: "",
          proposedKnowledgeNodeIds: [],
          evidenceChunkIds: evidenceChunkId ? [evidenceChunkId] : [],
          reason: "测试模型逐项确认 Agent 1 的删除检验结论。",
        })),
      };
    }),
  };
}

async function waitForClassificationJob(baseUrl, jobId) {
  let payload;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    payload = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${jobId}`).then((response) => response.json());
    if (!["queued", "running"].includes(payload.job.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return payload;
}

async function runAgent2ContractScenario(context, navigationOutputs, agent3Outputs = [], storeOptions = {}) {
  const calls = [];
  let agent1Index = 0;
  let navigationIndex = 0;
  let agent3Index = 0;
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.map((message) => String(message.content || "")).join("\n");
      const phase = prompt.includes("只负责独立提取题目特征")
        ? "agent1"
        : (prompt.includes("Agent 2，只负责读取 Agent 1 已持久化") ? "agent2" : "agent3");
      calls.push({ payload, prompt, phase });
      let content;
      if (phase === "agent1") {
        const configured = storeOptions.agent1Outputs?.[agent1Index];
        agent1Index += 1;
        content = configured === undefined
          ? JSON.stringify(agent2ContractFeatureOutput())
          : (typeof configured === "function" ? JSON.stringify(configured(prompt)) : configured);
      } else if (phase === "agent2") {
        const configured = navigationOutputs[navigationIndex];
        navigationIndex += 1;
        content = typeof configured === "function"
          ? JSON.stringify(configured(prompt))
          : (configured === undefined ? JSON.stringify(validAgent2ContractNavigation(prompt)) : configured);
      } else {
        const configured = agent3Outputs[agent3Index];
        agent3Index += 1;
        const configuredContent = configured === undefined ? {
          verifications: [{
            questionId: "classification-q1",
            decision: "confirm",
            primaryNodeId: "obstruction",
            requiredNodeIds: ["obstruction"],
            focusKey: "声母发音方法·阻碍方式",
            focusLabel: "声母发音方法·阻碍方式",
            action: "分类判断",
            confidence: 0.97,
            reason: "教材按形成和克服阻碍的方式划分塞音、擦音等。",
            uncertainty: "",
            evidenceChunkIds: ["chunk-obstruction"],
          }],
        } : (typeof configured === "function" ? configured(prompt) : configured);
        content = JSON.stringify(withAgent3OptionRelationAssessments(configuredContent, prompt));
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "classification-model",
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const stores = buildStores(storeOptions);
  if (typeof storeOptions.configureStores === "function") storeOptions.configureStores(stores);
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const aiTaskStore = createMemoryAiTaskStore();
  const provider = {
    id: "agent2-contract-provider",
    name: "Agent 2 合同模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["classification-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_hierarchy_navigation: {
        mode: "provider",
        providerId: provider.id,
        model: "classification-model",
        temperature: 0.17,
        maxTokens: 1200,
      },
      knowledge_batch_verification: {
        mode: "provider",
        providerId: provider.id,
        model: "classification-model",
        temperature: 0.1,
        maxTokens: 2400,
      },
    },
  });
  const server = createServer({ aiConfigStore, aiTaskStore, ...stores, knowledgeClassificationStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createdResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, questionIds: ["classification-q1"], limit: 1 }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 202, JSON.stringify(created));
  const completed = await waitForClassificationJob(baseUrl, created.job.id);
  return {
    calls,
    aiTaskStore,
    job: completed.job,
    result: knowledgeClassificationStore.resultForQuestion(created.job.id, "classification-q1"),
  };
}

function addReviewableResults(stores) {
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const structure = stores.knowledgeStructureStore.get(bookId);
  const familyRevision = Number(stores.questionFamilyStore.exportState().generatedAtByBook[bookId]);
  const fingerprintMap = new Map(structure.fingerprints.map((fingerprint) => [fingerprint.questionId, fingerprint]));
  const familyMembershipRevisions = stores.questionFamilyStore.membershipRevisions(stores.questions.map((item) => item.id));
  const created = knowledgeClassificationStore.createJob({
    id: "classification-job",
    bookId,
    questionIds: stores.questions.map((item) => item.id),
    baseQuestionVersions: Object.fromEntries(stores.questions.map((item) => [item.id, stores.questionStore.get(item.id).version])),
    baseClassificationBaselines: Object.fromEntries(stores.questions.map((item) => [
      item.id,
      knowledgeClassificationQuestionBaseline(fingerprintMap.get(item.id), familyMembershipRevisions[item.id]),
    ])),
    baseKnowledgeRevision: structure.updatedAt,
    baseFamilyRevision: familyRevision,
    textbookKnowledgeVersion: 3,
  });
  created.results.forEach((result) => {
    knowledgeClassificationStore.saveAgent1(result.id, [{
      terminalNodeId: "obstruction",
      terminalNodeIds: ["obstruction"],
      stopReason: "leaf",
      confidence: 0.94,
      steps: [{
        parentNodeId: "method",
        candidateNodeIds: ["obstruction", "voicing", "airflow"],
        decision: "node",
        selectedNodeIds: ["obstruction"],
        confidence: 0.94,
        reason: "题干明确要求按阻碍方式判断。",
        terminal: true,
        terminalNodeIds: ["obstruction"],
        stopReason: "leaf",
      }],
    }]);
    knowledgeClassificationStore.saveAgent2(result.id, {
      questionId: result.questionId,
      decision: "confirm",
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      focusKey: "声母发音方法·阻碍方式",
      focusLabel: "声母发音方法·阻碍方式",
      action: "分类判断",
      confidence: 0.96,
      reason: "教材按形成和克服阻碍的方式划分塞音、擦音等。",
      uncertainty: "",
      evidenceChunkIds: ["chunk-obstruction"],
    });
  });
  return { knowledgeClassificationStore, results: created.results };
}

function classificationBusinessSnapshot(stores) {
  return {
    knowledgeStructure: stores.knowledgeStructureStore.exportState(),
    questionFamilies: stores.questionFamilyStore.exportState(),
    classification: stores.knowledgeClassificationStore.exportState(),
    experience: stores.knowledgeClassificationExperienceStore.exportState(),
    dossiers: stores.knowledgeDossierStore.exportState(),
    operations: stores.operationLogStore.exportState(),
  };
}

async function postClassificationApply(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

test("classification suggestions remain read-only until manual apply, then reset affected families", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const before = stores.knowledgeStructureStore.get(bookId).fingerprints.find((item) => item.questionId === "classification-q1");
  assert.notEqual(before.source, "hierarchy_agent_review");
  assert.equal(stores.questionFamilyStore.list({ bookId, status: "confirmed" }).families.length, 1);

  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/knowledge-classification/results?bookId=${bookId}`).then((response) => response.json());
  assert.equal(listing.summary.pending, 2);
  assert.equal(listing.items[0].question.stem.length > 0, true);
  assert.deepEqual(listing.items[0].question.options, [{ key: "A", text: "塞音" }, { key: "B", text: "擦音" }]);
  assert.equal(listing.items[0].agent2Verification.primaryNode.path.endsWith("看阻碍的方式"), true);

  const applyResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: results.map((result) => result.id) }),
  });
  const applied = await applyResponse.json();
  assert.equal(applyResponse.status, 200);
  assert.equal(applied.appliedCount, 2);

  const structure = stores.knowledgeStructureStore.get(bookId);
  const fingerprint = structure.fingerprints.find((item) => item.questionId === "classification-q1");
  assert.equal(fingerprint.status, "confirmed");
  assert.equal(fingerprint.source, "hierarchy_agent_review");
  assert.equal(fingerprint.primaryNodeId, "obstruction");
  assert.equal(fingerprint.focus.key, "声母发音方法·阻碍方式");
  assert.deepEqual(fingerprint.evidenceChunkIds, ["chunk-obstruction"]);
  const reviewedFamilies = stores.questionFamilyStore.list({ bookId, status: "confirmed" }).families;
  const candidateFamilies = stores.questionFamilyStore.list({ bookId, status: "pending_review" }).families;
  assert.equal(reviewedFamilies.length, 1);
  assert.equal(candidateFamilies.length, 1);
  assert.equal(reviewedFamilies[0].members.every((member) => member.reviewStatus === "pending_fit"), true);
  assert.equal(candidateFamilies[0].members.every((member) => member.reviewStatus === "pending_fit"), true);
  assert.deepEqual(stores.questionFamilyStore.confirmedForQuestion("classification-q1"), []);
  assert.equal(knowledgeClassificationStore.getResult(results[0].id).status, "applied");
  // 第 1/2 项：来源标识与采纳留痕必须真的落在巡检记录上（与题目完善同一套词汇）
  const appliedResult = knowledgeClassificationStore.getResult(results[0].id);
  assert.equal(appliedResult.source, "knowledge_inspection");
  assert.equal(appliedResult.reviewStatus, "applied");
  for (const field of [
    "primaryNodeId",
    "primaryNodeRole",
    "requiredNodeIds",
    "problemKnowledgeRangeNodeIds",
    "knowledgeThemeRangeAnchorNodeId",
  ]) {
    assert.ok(appliedResult.appliedFields.includes(field), `采纳留痕应包含 ${field}`);
  }
  // 巡检不产生新的题目版本，所以 appliedVersion 记的是"本次采纳写入的正式指纹所标注的题目版本"
  assert.equal(appliedResult.appliedVersion, Number(results[0].baseQuestionVersion) || 0);
  // 列表端点直接透出原始记录，所以来源标识与留痕在接口上可见；采纳前留痕为空
  assert.equal(listing.items[0].source, "knowledge_inspection");
  assert.deepEqual(listing.items[0].appliedFields, []);
  assert.equal(operationLogStore.list({ category: "question" }).items.some((item) => item.action === "knowledge_classification.apply"), true);
});

test("classification apply persists a scope-anchor role in the review selection and formal fingerprint", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const selectedResult = results[0];
  const current = knowledgeClassificationStore.getResult(selectedResult.id);
  knowledgeClassificationStore.updateResult(selectedResult.id, {
    agent2Verification: {
      ...current.agent2Verification,
      primaryNodeId: "method",
      primaryNodeRole: "scope_anchor",
      requiredNodeIds: ["obstruction"],
    },
  });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const applied = await postClassificationApply(baseUrl, {
    schemaVersion: "ClassificationCommitV1",
    commitId: "scope-anchor-apply-1",
    resultIds: [selectedResult.id],
    selections: [{
      resultId: selectedResult.id,
      primaryNodeId: "method",
      primaryNodeRole: "scope_anchor",
      requiredNodeIds: ["obstruction"],
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.reviewSelections[0].primaryNodeRole, "scope_anchor");
  const storedResult = knowledgeClassificationStore.getResult(selectedResult.id);
  assert.equal(storedResult.agent2Verification.primaryNodeRole, "scope_anchor");
  assert.equal(storedResult.reviewSelection.primaryNodeRole, "scope_anchor");
  const fingerprint = stores.knowledgeStructureStore.fingerprintMap(bookId).get(selectedResult.questionId);
  assert.equal(fingerprint.primaryNodeId, "method");
  assert.equal(fingerprint.primaryNodeRole, "scope_anchor");
  assert.deepEqual(fingerprint.requiredNodeIds, ["obstruction"]);
});

test("manual review can create an Agent 3 candidate family and assign the question atomically", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const candidateFamilyDraft = {
    name: "阻碍方式判别新边界",
    coreKnowledgeNodeId: "obstruction",
    requiredKnowledgeNodeIds: ["obstruction"],
    textbookAnchorNodeIds: ["obstruction"],
    assessmentAction: "根据阻碍形成和克服方式分类",
    inclusionBoundary: "题目必须要求按形成阻碍和克服阻碍的方式判断辅音类别。",
    exclusionBoundary: "只考声带振动或气流强弱的题目不纳入。",
    membership: {
      coverageRole: "required",
      contributionKnowledgeNodeIds: ["obstruction"],
    },
    textbookEvidence: { chunkIds: ["chunk-obstruction"], summary: "教材直接列出塞音、擦音等阻碍方式类别。" },
    reason: "现有题族的辨析边界不足以覆盖本题。",
  };
  knowledgeClassificationStore.updateResult(results[0].id, {
    agent2Verification: {
      ...knowledgeClassificationStore.getResult(results[0].id).agent2Verification,
      familyDecision: "create_new",
      candidateFamilyDraft,
    },
  });
  const transactionStores = {
    ...stores,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
    operationLogStore: createMemoryAdminOperationStore(),
  };
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), ...transactionStores });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const applied = await postClassificationApply(baseUrl, {
    schemaVersion: "ClassificationCommitV1",
    commitId: "candidate-family-create-1",
    resultIds: [results[0].id],
    selections: [{
      resultId: results[0].id,
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      createCandidateFamily: true,
      candidateFamilyDraft,
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.createdCandidateFamilies.length, 1);
  const createdFamily = applied.body.createdCandidateFamilies[0].family;
  assert.equal(createdFamily.name, candidateFamilyDraft.name);
  assert.equal(createdFamily.status, "pending_review");
  assert.equal(createdFamily.coreKnowledgeNodeId, "obstruction");
  assert.deepEqual(createdFamily.requiredKnowledgeNodeIds, ["obstruction"]);
  assert.deepEqual(createdFamily.textbookAnchorNodeIds, ["obstruction"]);
  assert.deepEqual(createdFamily.members.map((item) => item.questionId), [results[0].questionId]);
  const memberships = transactionStores.questionFamilyStore.memberships([results[0].questionId])[results[0].questionId];
  assert.deepEqual(memberships.map((item) => [item.familyId, item.isPrimary]), [[createdFamily.id, true]]);
  assert.equal(knowledgeClassificationStore.getResult(results[0].id).reviewSelection.createCandidateFamily, true);
});

test("classification apply replays the committed response and rejects commit reuse with changed content", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const transactionStores = {
    ...stores,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
    operationLogStore: createMemoryAdminOperationStore(),
  };
  const classificationCommitStore = createMemoryClassificationCommitStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...transactionStores,
    classificationCommitStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const payload = {
    schemaVersion: "ClassificationCommitV1",
    commitId: "classification-idempotency-1",
    resultIds: [results[0].id],
  };

  const first = await postClassificationApply(baseUrl, payload);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.commitId, payload.commitId);
  const afterFirst = classificationBusinessSnapshot(transactionStores);

  const replay = await postClassificationApply(baseUrl, payload);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(classificationBusinessSnapshot(transactionStores), afterFirst);

  const mismatch = await postClassificationApply(baseUrl, { ...payload, note: "changed review note" });
  assert.equal(mismatch.response.status, 409);
  assert.equal(mismatch.body.error, "classification_commit_request_mismatch");
  assert.deepEqual(classificationBusinessSnapshot(transactionStores), afterFirst);
  assert.equal(classificationCommitStore.get(payload.commitId).status, "committed");
});

test("classification apply requires an adjustment reason before preparing a changed review", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const selectedResult = results[0];
  const current = knowledgeClassificationStore.getResult(selectedResult.id);
  knowledgeClassificationStore.updateResult(selectedResult.id, {
    agent2Verification: {
      ...current.agent2Verification,
      requiredNodeIds: ["obstruction", "voicing"],
    },
  });
  const transactionStores = {
    ...stores,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
    operationLogStore: createMemoryAdminOperationStore(),
  };
  const classificationCommitStore = createMemoryClassificationCommitStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...transactionStores,
    classificationCommitStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const before = classificationBusinessSnapshot(transactionStores);
  const applied = await postClassificationApply(`http://127.0.0.1:${server.address().port}`, {
    schemaVersion: "ClassificationCommitV1",
    commitId: "classification-reason-required",
    resultIds: [selectedResult.id],
    selections: [{
      resultId: selectedResult.id,
      primaryNodeId: "voicing",
      requiredNodeIds: ["obstruction", "voicing"],
    }],
  });
  assert.equal(applied.response.status, 422);
  assert.equal(applied.body.error, "knowledge_classification_adjustment_reason_required");
  assert.deepEqual(classificationBusinessSnapshot(transactionStores), before);
  assert.equal(classificationCommitStore.get("classification-reason-required"), null);
});

test("classification apply restores all business stores after early, middle, late, and commit failures", async (context) => {
  const faultCases = ["family", "experience", "operation", "commit"];
  for (const fault of faultCases) {
    await context.test(fault, async () => {
      const stores = buildStores();
      const { knowledgeClassificationStore, results } = addReviewableResults(stores);
      const baseFamilyStore = stores.questionFamilyStore;
      const baseExperienceStore = createMemoryKnowledgeClassificationExperienceStore();
      const baseOperationStore = createMemoryAdminOperationStore();
      const baseCommitStore = createMemoryClassificationCommitStore();
      let shouldFail = true;
      const failOnce = (name, target, method) => ({
        ...target,
        [method](...args) {
          if (fault === name && shouldFail) {
            shouldFail = false;
            throw new Error(`classification_commit_test_failure:${name}`);
          }
          return target[method](...args);
        },
      });
      const transactionStores = {
        ...stores,
        questionFamilyStore: failOnce("family", baseFamilyStore, "generate"),
        knowledgeClassificationStore,
        knowledgeClassificationExperienceStore: failOnce("experience", baseExperienceStore, "addCase"),
        knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
        operationLogStore: failOnce("operation", baseOperationStore, "append"),
      };
      const classificationCommitStore = failOnce("commit", baseCommitStore, "markCommitted");
      const server = createServer({
        aiConfigStore: createMemoryAiConfigStore(),
        ...transactionStores,
        classificationCommitStore,
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const payload = {
        schemaVersion: "ClassificationCommitV1",
        commitId: `classification-rollback-${fault}`,
        resultIds: [results[0].id],
      };
      const before = classificationBusinessSnapshot(transactionStores);
      try {
        const failed = await postClassificationApply(baseUrl, payload);
        assert.equal(failed.response.status, 422, JSON.stringify(failed.body));
        assert.match(failed.body.error, /classification_commit_test_failure/);
        assert.deepEqual(classificationBusinessSnapshot(transactionStores), before);
        assert.equal(baseCommitStore.get(payload.commitId).status, "failed");
        assert.equal(baseCommitStore.get(payload.commitId).recovery, "rolled_back");

        const retried = await postClassificationApply(baseUrl, payload);
        assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
        assert.equal(baseCommitStore.get(payload.commitId).status, "committed");
        assert.equal(baseCommitStore.get(payload.commitId).attempt, 2);
        assert.equal(baseExperienceStore.exportState().cases.length, 1);
        assert.equal(baseOperationStore.exportState().filter((item) => item.action === "knowledge_classification.apply").length, 1);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});

test("classification apply uses the reviewed primary family instead of creating a duplicate family", async (context) => {
  const stores = buildStores();
  const generatedFamily = stores.questionFamilyStore.list({ bookId, status: "all" }).families[0];
  const existingFamily = stores.questionFamilyStore.review(generatedFamily.id, {
    status: "confirmed",
    requiredKnowledgeNodeIds: ["obstruction"],
    members: generatedFamily.members,
  }, "测试审核员");
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const selectedResult = results.find((result) => result.questionId === "classification-q1");
  const currentVerification = knowledgeClassificationStore.getResult(selectedResult.id).agent2Verification;
  knowledgeClassificationStore.updateResult(selectedResult.id, {
    agent2Verification: {
      ...currentVerification,
      familyDecision: "join_existing",
      primaryFamilyId: existingFamily.id,
      relatedFamilyIds: [],
      matchedFamilyIds: [existingFamily.id],
    },
  });

  const knowledgeClassificationExperienceStore = createMemoryKnowledgeClassificationExperienceStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/knowledge-classification/results?bookId=${bookId}`).then((response) => response.json());
  const listedResult = listing.items.find((item) => item.id === selectedResult.id);
  assert.equal(listedResult.agent2Verification.primaryFamily.id, existingFamily.id);
  assert.equal(listedResult.agent2Verification.candidateFamilies[0].name, existingFamily.name);

  const response = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resultIds: [selectedResult.id],
      selections: [{
        resultId: selectedResult.id,
        primaryNodeId: "obstruction",
        requiredNodeIds: ["obstruction"],
        familyMemberships: [{
          familyId: existingFamily.id,
          isPrimary: true,
          coverageRole: "required",
          contributionKnowledgeNodeIds: ["obstruction"],
        }],
      }],
      adjustmentReason: "人工确认该题应归入已有题族，并补齐本题成员贡献知识。",
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.reviewSelections[0].familyMemberships, [{
    familyId: existingFamily.id,
    isPrimary: true,
    coverageRole: "required",
    contributionKnowledgeNodeIds: ["obstruction"],
  }]);
  const families = stores.questionFamilyStore.list({ bookId, status: "all" }).families;
  assert.equal(families.length, 1);
  assert.equal(families[0].id, existingFamily.id);
  assert.equal(families[0].members.some((member) => member.questionId === selectedResult.questionId), true);
  assert.deepEqual(stores.questionFamilyStore.memberships([selectedResult.questionId])[selectedResult.questionId]
    .map((membership) => [membership.familyId, membership.isPrimary]), [[existingFamily.id, true]]);
  const confirmedCase = knowledgeClassificationExperienceStore.exportState().cases
    .find((item) => item.questionId === selectedResult.questionId);
  assert.equal(confirmedCase.primaryFamilyId, existingFamily.id);
  assert.deepEqual(confirmedCase.familyIds, [existingFamily.id]);
});

test("classification apply returns 409 and leaves official fingerprints unchanged after a question version change", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  stores.questionStore.update("classification-q1", { stem: "管理员已经修改了这道题。", changeNote: "并发修改" }, "管理员");
  const before = stores.knowledgeStructureStore.get(bookId).fingerprints.find((item) => item.questionId === "classification-q1");

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: results.map((result) => result.id) }),
  });
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.error, "knowledge_classification_result_stale");
  assert.deepEqual(payload.details.staleResults.find((item) => item.questionId === "classification-q1").reasons, ["question_version_changed"]);
  const after = stores.knowledgeStructureStore.get(bookId).fingerprints.find((item) => item.questionId === "classification-q1");
  assert.deepEqual(after, before);
  assert.equal(knowledgeClassificationStore.getResult(results[0].id).status, "stale");
  assert.equal(stores.questionFamilyStore.list({ bookId, status: "confirmed" }).families.length, 1);
});

test("classification apply rejects an old suggestion after the same question was manually reassigned", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const selectedResult = results.find((item) => item.questionId === "classification-q1");
  stores.knowledgeStructureStore.assignQuestions(bookId, [{
    questionId: selectedResult.questionId,
    primaryNodeId: "voicing",
    requiredNodeIds: ["voicing"],
    focusKey: "声母发音方法·声带振动",
    focusLabel: "看声带是否振动",
    source: "manual_review",
  }]);

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [selectedResult.id] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(payload.details.staleResults[0].reasons, ["question_knowledge_assignment_changed"]);
  assert.equal(stores.knowledgeStructureStore.fingerprintMap(bookId).get(selectedResult.questionId).primaryNodeId, "voicing");
  assert.equal(knowledgeClassificationStore.getResult(selectedResult.id).status, "stale");
});

test("classification apply rejects an old suggestion after the same question's family memberships changed", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const selectedResult = results.find((item) => item.questionId === "classification-q1");
  stores.questionFamilyStore.setMemberships(stores.questionStore.get(selectedResult.questionId), [], "人工审核员");

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [selectedResult.id] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(payload.details.staleResults[0].reasons, ["question_family_memberships_changed"]);
  assert.deepEqual(stores.questionFamilyStore.memberships([selectedResult.questionId], { bookId, status: "all" })[selectedResult.questionId], []);
  assert.equal(knowledgeClassificationStore.getResult(selectedResult.id).status, "stale");
});

test("classification apply requires legacy pending suggestions without a per-question baseline to be rerun", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const selectedResult = results.find((item) => item.questionId === "classification-q1");
  knowledgeClassificationStore.updateResult(selectedResult.id, { classificationBaseline: null });

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [selectedResult.id] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(payload.details.staleResults[0].reasons, ["question_classification_baseline_missing"]);
  assert.notEqual(stores.knowledgeStructureStore.fingerprintMap(bookId).get(selectedResult.questionId).source, "hierarchy_agent_review");
  assert.equal(knowledgeClassificationStore.getResult(selectedResult.id).status, "stale");
});

test("fingerprint and family updates for another question do not expire a reviewable suggestion", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  stores.knowledgeStructureStore.assignQuestions(bookId, [{
    questionId: "classification-q2",
    primaryNodeId: "obstruction",
    requiredNodeIds: ["obstruction", "method"],
  }]);
  const refreshedStructure = stores.knowledgeStructureStore.get(bookId);
  stores.questionFamilyStore.generate(stores.questions, bookId, {
    fingerprintMap: new Map(refreshedStructure.fingerprints.map((item) => [item.questionId, item])),
    nodeOrder: new Map(refreshedStructure.nodes.map((node, index) => [node.id, index + 1])),
  });

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [results.find((item) => item.questionId === "classification-q1").id] }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.appliedCount, 1);
});

test("older classification result points to the latest pending suggestion", async (context) => {
  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const structure = stores.knowledgeStructureStore.get(bookId);
  const newer = knowledgeClassificationStore.createJob({
    id: "classification-job-newer",
    bookId,
    questionIds: ["classification-q1"],
    baseQuestionVersions: { "classification-q1": 1 },
    baseKnowledgeRevision: structure.updatedAt,
    baseFamilyRevision: Number(stores.questionFamilyStore.exportState().generatedAtByBook[bookId]),
    textbookKnowledgeVersion: 3,
  }).results[0];
  knowledgeClassificationStore.saveAgent1(newer.id, [{
    terminalNodeId: "obstruction",
    terminalNodeIds: ["obstruction"],
    stopReason: "leaf",
    confidence: 0.95,
    steps: [],
  }]);
  knowledgeClassificationStore.saveAgent2(newer.id, {
    questionId: "classification-q1",
    decision: "confirm",
    primaryNodeId: "obstruction",
    requiredNodeIds: ["obstruction"],
    focusKey: "newer",
    focusLabel: "更新建议",
    action: "分类判断",
    confidence: 0.97,
    reason: "这是同题更新后的巡检建议。",
    evidenceChunkIds: ["chunk-obstruction"],
  });

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const oldResult = results.find((item) => item.questionId === "classification-q1");

  const latestListing = await fetch(`${baseUrl}/api/admin/knowledge-classification/results?bookId=${bookId}&query=classification-q1`).then((response) => response.json());
  assert.equal(latestListing.items.some((item) => item.id === oldResult.id), false);
  assert.equal(latestListing.items[0].id, newer.id);
  assert.equal(latestListing.summary.history, 1);

  const listing = await fetch(`${baseUrl}/api/admin/knowledge-classification/results?bookId=${bookId}&query=classification-q1&includeHistory=true`).then((response) => response.json());
  const oldItem = listing.items.find((item) => item.id === oldResult.id);
  assert.equal(oldItem.hasNewerResult, true);
  assert.equal(oldItem.latestResultId, newer.id);
  assert.equal(oldItem.isHistoricalRecord, true);
  assert.equal(listing.summary.history, 1);

  const response = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [oldResult.id] }),
  });
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.deepEqual(payload.details.staleResults[0].reasons, ["newer_result_available"]);
  assert.equal(payload.details.staleResults[0].latestResultId, newer.id);
});

test("verified official answers outrank conflicting structured answers and block classification apply", async (context) => {
  const stores = buildStores();
  stores.questionStore.update("classification-q1", {
    correctAnswer: ["A"],
    referenceAnswer: "B【解析】教材答案为擦音。",
    answerVariants: {
      official: "B【解析】教材答案为擦音。",
      ai: "A。AI 候选答案为塞音。",
      community: "",
    },
    answerSource: "pdf_answer",
    answerReviewStatus: "verified",
    answerVerified: true,
    changeNote: "制造已核验答案冲突测试",
  }, "测试审核员");
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    ...stores,
    knowledgeClassificationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/knowledge-classification/results?bookId=${bookId}&issue=answer_conflict`).then((response) => response.json());
  assert.equal(listing.total, 1);
  assert.equal(listing.items[0].risk, "high");
  assert.equal(listing.items[0].issue, "answer_conflict");
  assert.deepEqual(listing.items[0].answerConflict.structuredAnswer, ["A"]);
  assert.deepEqual(listing.items[0].answerConflict.referenceAnswer, ["B"]);
  assert.equal(listing.items[0].answerConflict.authority, "verified_official");
  assert.equal(listing.items[0].answerConflict.answerSource, "pdf_answer");

  const response = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [results[0].id] }),
  });
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.error, "knowledge_classification_answer_conflict");
  assert.notEqual(stores.knowledgeStructureStore.get(bookId).fingerprints.find((item) => item.questionId === "classification-q1").source, "hierarchy_agent_review");
});

test("reviewer feedback becomes a draft rule only after three independent cases, then requires approval", async (context) => {
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.map((message) => String(message.content || "")).join("\n");
      assert.match(prompt, /审核员最新反馈/);
      assert.match(prompt, /已核验答案只能证明答案内容，不能单独证明知识归属/);
      assert.match(prompt, /针对本次反馈重新检索的教材证据/);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "classification-model",
        choices: [{ message: { content: JSON.stringify({
          disposition: "accept",
          reply: "接受反馈。以后必须区分三种辅音发音方法维度。",
          evidenceAudit: {
            citedEvidenceChunkIds: ["chunk-obstruction"],
            conclusion: "教材按阻碍方式区分塞音与擦音。",
          },
          reusable: true,
          ruleDraft: {
            updateMode: "replace",
            title: "区分辅音发音方法维度",
            statement: "声带振动、气流强弱和阻碍方式必须分别归类，综合题另设综合考查维度。",
            triggerTerms: ["声带", "气流", "阻碍方式"],
            positiveExamples: ["清音和浊音归入声带振动"],
            negativeExamples: ["塞音和擦音不得归入声带振动"],
            priority: "high",
          },
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const stores = buildStores();
  const { knowledgeClassificationStore, results } = addReviewableResults(stores);
  const knowledgeClassificationExperienceStore = createMemoryKnowledgeClassificationExperienceStore();
  ["classification-q2", "classification-q3"].forEach((questionId) => knowledgeClassificationExperienceStore.recordReviewEvent({
    bookId,
    questionId,
    eventType: "reviewer_feedback",
    topicKey: "agent2|obstruction|区分辅音发音方法维度",
    reason: "这三类发音方法必须分别归类，综合题也要单列。",
    proposal: {
      type: "rule",
      title: "区分辅音发音方法维度",
      statement: "声带振动、气流强弱和阻碍方式必须分别归类，综合题另设综合考查维度。",
      scopeNodeIds: ["obstruction"],
      triggerTerms: ["声带", "气流", "阻碍方式"],
      priority: "high",
    },
  }, "预置审核员"));
  const provider = {
    id: "classification-provider",
    name: "分类模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["classification-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_hierarchy_navigation: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 1800 },
      knowledge_batch_verification: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 1800 },
    },
  });
  const server = createServer({
    aiConfigStore,
    ...stores,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const feedbackResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/results/${results[0].id}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "agent2", message: "这三类发音方法必须分别归类，综合题也要单列。", createRuleDraft: true }),
  });
  const feedback = await feedbackResponse.json();
  assert.equal(feedbackResponse.status, 200, JSON.stringify(feedback));
  assert.equal(feedback.modelError, "", JSON.stringify(feedback));
  assert.ok(feedback.rule, JSON.stringify(feedback));
  assert.equal(feedback.rule.status, "draft");
  assert.equal(feedback.rule.scopeNodeIds.includes("obstruction"), true);
  assert.equal(feedback.agentMessage.ruleDraftId, feedback.rule.id);

  const followupResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/results/${results[0].id}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "agent2", message: "补充：选项全部来自阻碍方式时，也要以阻碍方式为主。", createRuleDraft: true }),
  });
  const followup = await followupResponse.json();
  assert.equal(followupResponse.status, 200, JSON.stringify(followup));
  assert.equal(followup.ruleAction, "updated");
  assert.equal(followup.rule.id, feedback.rule.id);
  assert.equal(followup.rule.version, 2);

  const experience = await fetch(`${baseUrl}/api/admin/knowledge-classification/results/${results[0].id}/experience`).then((response) => response.json());
  assert.equal(experience.messages.length, 4);
  assert.equal(experience.rules[0].id, feedback.rule.id);

  const approvalResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/rules/${feedback.rule.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  });
  const approval = await approvalResponse.json();
  assert.equal(approvalResponse.status, 200, JSON.stringify(approval));
  assert.equal(approval.rule.status, "active");
  assert.equal(approval.rule.version, 3);

  const applyResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [results[0].id] }),
  });
  const applied = await applyResponse.json();
  assert.equal(applyResponse.status, 200, JSON.stringify(applied));
  assert.equal(applied.confirmedCases.length, 1);
  assert.equal(applied.confirmedCases[0].questionId, results[0].questionId);

  const rules = await fetch(`${baseUrl}/api/admin/knowledge-classification/rules?bookId=${bookId}&status=active`).then((response) => response.json());
  assert.equal(rules.summary.active, 1);
  assert.equal(rules.items[0].id, feedback.rule.id);
  const cases = await fetch(`${baseUrl}/api/admin/knowledge-classification/cases?bookId=${bookId}`).then((response) => response.json());
  assert.equal(cases.items.some((item) => item.questionId === results[0].questionId), true);

  const activeDelete = await fetch(`${baseUrl}/api/admin/knowledge-classification/rules/${feedback.rule.id}`, { method: "DELETE" });
  assert.equal(activeDelete.status, 200);
  assert.equal(knowledgeClassificationExperienceStore.getRule(feedback.rule.id), null);
  const disposable = knowledgeClassificationExperienceStore.createRule({
    bookId,
    title: "临时草稿",
    statement: "仅用于验证删除接口",
    status: "draft",
  });
  const draftDelete = await fetch(`${baseUrl}/api/admin/knowledge-classification/rules/${disposable.id}`, { method: "DELETE" });
  assert.equal(draftDelete.status, 200);
  assert.equal(knowledgeClassificationExperienceStore.getRule(disposable.id), null);
});

test("classification job persists Agent 1 features before Agent 2 navigation and excludes non-active dossiers", async (context) => {
  const calls = [];
  let verificationFamilyIds = {};
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      calls.push(payload);
      const prompt = payload.messages.map((message) => String(message.content || "")).join("\n");
      let content;
      if (prompt.includes("只负责独立提取题目特征")) {
        content = {
          questionId: "classification-q1",
          featureProfile: {
            optionKnowledgeProtocolVersion: "option-knowledge-v2",
            choiceStructure: "direct_options",
            questionMode: "option_judgement",
            stemKeywords: ["独立特征标记", "正确的是"],
            coreKeywords: ["辅音发音方法"],
            stemKnowledgeHints: ["辅音发音方法"],
            optionFeatures: [{
              key: "A",
              keywords: ["塞音"],
              knowledgeRelation: "question_only",
              knowledgeHints: [],
              isCorrect: true,
              role: "answer",
              weight: 0.4,
              decisionRole: "supports_answer",
              requiredForDecision: true,
              basis: "直接验证答案。",
            }, {
              key: "B",
              keywords: ["擦音"],
              knowledgeRelation: "question_only",
              knowledgeHints: [],
              isCorrect: false,
              role: "distractor",
              weight: 0.6,
              decisionRole: "required_for_elimination",
              requiredForDecision: true,
              basis: "用于排除干扰项。",
            }],
            primaryKnowledgeHints: ["阻碍方式"],
            secondaryKnowledgeHints: [],
            dependencySteps: [{ order: 1, label: "判断阻碍方式", source: "stem", necessity: "core", basis: "题干直接询问。" }],
            knowledgePriorities: [{ label: "阻碍方式", role: "primary", weight: 1, basis: "核心考查。" }],
            primaryBasis: "题干直接考查阻碍方式。",
            crossFamilyProbability: 0.1,
            callDepth: 1,
          },
        };
      } else if (prompt.includes("Agent 2，只负责读取 Agent 1 已持久化")) {
        const candidateBlock = prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/);
        const selectedNodeId = JSON.parse(candidateBlock[1])[0].id;
        content = {
          questionId: "classification-q1",
          decision: "node",
          selectedNodeIds: [selectedNodeId],
          corePathStatus: "core_path_viable",
          auxiliaryGap: null,
          candidateRejections: [],
          confidence: 0.95,
          reason: "沿辅音发音方法路径逐层选择。",
        };
      } else {
        content = {
          verifications: [{
            questionId: "classification-q1",
            decision: "confirm",
            primaryNodeId: "obstruction",
            requiredNodeIds: ["obstruction"],
            focusKey: "声母发音方法·阻碍方式",
            focusLabel: "声母发音方法·阻碍方式",
            action: "分类判断",
            confidence: 0.97,
            reason: "教材按形成和克服阻碍的方式划分塞音、擦音等。",
            uncertainty: "教材中一般 a 的央元音描写与已核验解析存在差异。",
            evidenceChunkIds: ["chunk-obstruction"],
            familyDecision: "join_existing",
            primaryFamilyId: verificationFamilyIds.primary,
            primaryFamilyContributionKnowledgeNodeIds: ["obstruction"],
            relatedFamilyIds: [verificationFamilyIds.required],
            relatedFamilyRelations: [{
              familyId: verificationFamilyIds.required,
              coverageRole: "reference",
            }],
            relatedFamilyAssessments: [{
              familyId: verificationFamilyIds.required,
              necessaryAfterDeletionTest: false,
              deletionTest: "去掉该相邻维度后，仍可依据阻碍方式完成本题。",
              reason: "保留为辅音发音方法下的相邻参考关系。",
            }],
            matchedFamilyIds: [verificationFamilyIds.primary, verificationFamilyIds.required, verificationFamilyIds.background],
          }],
        };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "classification-model",
        choices: [{ message: { content: JSON.stringify(withAgent3OptionRelationAssessments(content, prompt)) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const stores = buildStores();
  const primaryFamily = stores.questionFamilyStore.create({
    subjectId: "modern-chinese",
    bookId,
    name: "阻碍方式分类判断",
    knowledgeNodeId: "obstruction",
    knowledgePath: "语音 > 辅音与声母 > 辅音的发音方法 > 看阻碍的方式",
    coreKnowledgeNodeId: "obstruction",
    requiredKnowledgeNodeIds: ["obstruction"],
    textbookAnchorNodeIds: ["obstruction"],
    assessmentAction: "分类判断",
  });
  stores.questionFamilyStore.review(primaryFamily.id, { status: "confirmed", members: [{ questionId: "classification-q2", isPrimary: true, role: "prototype", trainingLevel: "foundation", action: "分类判断", confidence: 1, reason: "测试样题" }] }, "测试审核员");
  const confirmedSimilar = stores.questionStore.create(question(
    "classification-q3-confirmed-similar",
    "已确认的普通成员可作为参照样题。",
  ));
  stores.questionFamilyStore.addMembers(primaryFamily.id, [confirmedSimilar], "测试审核员");
  stores.questionFamilyStore.reviewMember(primaryFamily.id, confirmedSimilar.id, {
    status: "confirmed",
    expectedRevision: stores.questionFamilyStore.membershipRevisions([confirmedSimilar.id])[confirmedSimilar.id],
  }, "测试审核员");
  stores.questionFamilyStore.markPendingForQuestions(["classification-q2"], "question_content_updated", "测试审核员");
  const offlineSample = stores.questionStore.create(question(
    "classification-q4-offline",
    "不得作为 Agent 3 样题的下线题。",
  ));
  stores.questionStore.transition(offlineSample.id, "offline", "测试审核员");
  const mergedSample = stores.questionStore.create(question(
    "classification-q5-merged",
    "不得作为 Agent 3 样题的已合并源题。",
  ));
  stores.questionStore.replaceState(stores.questionStore.exportState().map((item) => (item.id === mergedSample.id
    ? { ...item, mergedIntoQuestionId: "classification-q1" }
    : item)));
  const activePrototype = stores.questionStore.create(question(
    "classification-q6-active-prototype",
    "Agent 3 可使用的在线未合并原型题。",
  ));
  const sampleQualityFamily = stores.questionFamilyStore.create({
    subjectId: "modern-chinese",
    bookId,
    name: "阻碍方式正式样题有效性",
    knowledgeNodeId: "obstruction",
    knowledgePath: "语音 > 辅音与声母 > 辅音的发音方法 > 看阻碍的方式",
    coreKnowledgeNodeId: "obstruction",
    requiredKnowledgeNodeIds: ["obstruction"],
    textbookAnchorNodeIds: ["obstruction"],
    assessmentAction: "分类判断",
  });
  stores.questionFamilyStore.review(sampleQualityFamily.id, {
    status: "confirmed",
    members: [
      { questionId: offlineSample.id, isPrimary: true, role: "similar", action: "分类判断" },
      { questionId: mergedSample.id, isPrimary: true, role: "similar", action: "分类判断" },
      { questionId: activePrototype.id, isPrimary: true, role: "prototype", action: "分类判断" },
    ],
  }, "测试审核员");
  const requiredFamily = stores.questionFamilyStore.create({
    subjectId: "modern-chinese",
    bookId,
    name: "声带振动辨析",
    knowledgeNodeId: "voicing",
    knowledgePath: "语音 > 辅音与声母 > 辅音的发音方法 > 看声带是否振动",
    coreKnowledgeNodeId: "voicing",
    requiredKnowledgeNodeIds: ["voicing"],
    textbookAnchorNodeIds: ["voicing"],
    assessmentAction: "辨析",
  });
  stores.questionFamilyStore.review(requiredFamily.id, {
    status: "confirmed",
    members: [{
      questionId: "classification-q2",
      isPrimary: false,
      role: "prototype",
      trainingLevel: "foundation",
      action: "辨析",
      coverageRole: "required",
      contributionKnowledgeNodeIds: ["voicing"],
      confidence: 1,
      reason: "测试样题",
    }],
  }, "测试审核员");
  // 让 requiredFamily 里的 q2 真正处于"归属待复核"状态：待复核成员不得被当作参照样题。
  // （原先只在 primaryFamily 时代标记过一次，随后 requiredFamily 又把 q2 建成已确认成员，
  //   旧断言之所以通过是因为全局只有 1 个样题名额被其他族先占用，并非规则本身在起作用。）
  stores.questionFamilyStore.markPendingForQuestions(["classification-q2"], "question_content_updated", "测试审核员");
  const backgroundFamily = stores.questionFamilyStore.create({
    subjectId: "modern-chinese",
    bookId,
    name: "气流强弱辨析",
    knowledgeNodeId: "airflow",
    knowledgePath: "语音 > 辅音与声母 > 辅音的发音方法 > 看气流的强弱",
    coreKnowledgeNodeId: "airflow",
    requiredKnowledgeNodeIds: ["airflow"],
    textbookAnchorNodeIds: ["airflow"],
    assessmentAction: "辨析",
  });
  verificationFamilyIds = {
    primary: primaryFamily.id,
    required: requiredFamily.id,
    background: backgroundFamily.id,
  };
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const knowledgeClassificationExperienceStore = createMemoryKnowledgeClassificationExperienceStore();
  const knowledgeDossierStore = createMemoryKnowledgeDossierStore();
  knowledgeDossierStore.save({
    bookId,
    canonicalName: "辅音阻碍方式",
    definition: "按照形成和克服阻碍的方式区分辅音类别。",
    inclusionCriteria: ["直接判断塞音、擦音、塞擦音等阻碍方式"],
    exclusionCriteria: ["只判断声带振动或气流强弱"],
    status: "evidence_verified",
    claims: [{ statement: "塞音和擦音属于不同阻碍方式", evidence: [{ chunkId: "chunk-obstruction", excerpt: "可以分为塞音、擦音等。" }] }],
    occurrences: [{ nodeId: "obstruction", path: "语音 > 辅音与声母 > 看阻碍的方式", role: "defines", chunkIds: ["chunk-obstruction"] }],
  });
  const ruleDraft = knowledgeClassificationExperienceStore.createRule({
    bookId,
    title: "区分辅音发音方法维度",
    statement: "声带振动、气流强弱和阻碍方式必须分别形成稳定的考查维度。",
    scopeNodeIds: ["phonetics", "consonants", "method", "obstruction"],
    questionTypes: ["single_choice"],
    triggerTerms: ["阻碍方式"],
    status: "draft",
  });
  const activeRule = knowledgeClassificationExperienceStore.updateRule(ruleDraft.id, { status: "active" }, "测试审核员");
  const aiTaskStore = createMemoryAiTaskStore();
  const provider = {
    id: "classification-provider",
    name: "分类模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["classification-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_hierarchy_navigation: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 1200 },
      knowledge_batch_verification: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 2400 },
    },
  });
  const server = createServer({
    aiConfigStore,
    aiTaskStore,
    ...stores,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore,
    knowledgeDossierStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, questionIds: ["classification-q1"], limit: 1 }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 202);

  let job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const payload = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${created.job.id}`).then((response) => response.json());
    job = payload.job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "completed", JSON.stringify({ job, results: knowledgeClassificationStore.results({ jobId: job.id, limit: 10 }), calls }, null, 2));
  assert.equal(job.succeeded, 1);

  const result = knowledgeClassificationStore.resultForQuestion(job.id, "classification-q1");
  assert.equal(result.status, "pending_review");
  assert.equal(result.agent1FeatureHandoff.status, "completed");
  assert.equal(result.agent1FeatureHandoff.configuredSceneId, "knowledge_hierarchy_navigation");
  assert.equal(result.agent1Features.stemKeywords.includes("独立特征标记"), true);
  assert.deepEqual(result.agent1Features.coreKnowledgeNodeIds, []);
  assert.deepEqual(result.agent1Features.optionFeatures[0].matchedNodeIds, []);
  assert.equal(result.agent1Trajectories[0].steps.length, 4);
  assert.equal(result.agent1Trajectories[0].terminalNodeId, "obstruction");
  assert.equal(result.agent2Verification.focusKey, "声母发音方法·阻碍方式");
  assert.equal(result.agent2Verification.primaryFamilyId, primaryFamily.id);
  assert.deepEqual(result.agent2Verification.relatedFamilyIds, [requiredFamily.id]);
  assert.deepEqual(result.agent2Verification.relatedFamilyRelations, [{
    familyId: requiredFamily.id,
    coverageRole: "reference",
    requiredForAnswer: false,
    contributionKnowledgeNodeIds: [],
    contributionKnowledgeNodeIdsProvided: true,
  }]);
  assert.deepEqual(result.agent2Verification.matchedFamilyIds, [primaryFamily.id, requiredFamily.id, backgroundFamily.id]);
  assert.equal(result.agent2Verification.relatedFamilyAssessments.find((item) => item.familyId === requiredFamily.id).accepted, true);
  assert.equal(result.agent2Verification.relatedFamilyAssessments.some((item) => item.familyId === backgroundFamily.id), false);
  assert.equal(result.agent1RuleIds.includes(activeRule.id), true);
  assert.equal(result.agent2RuleIds.includes(activeRule.id), true);
  assert.equal(calls.length, 6);
  assert.equal(calls.every((call) => call.response_format?.type === "json_object"), true);
  assert.equal(calls.every((call) => call.messages.some((message) => String(message.content || "").includes("塞音") && String(message.content || "").includes("擦音"))), true);
  assert.equal(calls.some((call) => call.messages.some((message) => String(message.content || "").includes("区分辅音发音方法维度"))), true);
  assert.equal(calls.some((call) => call.messages.some((message) => String(message.content || "").includes("辅音阻碍方式") && String(message.content || "").includes("pending_human_activation"))), false);
  const callPrompts = calls.map((call) => call.messages.map((message) => String(message.content || "")).join("\n"));
  const featureCallIndex = callPrompts.findIndex((prompt) => prompt.includes("只负责独立提取题目特征"));
  const navigationCallIndexes = callPrompts.map((prompt, index) => prompt.includes("Agent 2，只负责读取 Agent 1 已持久化") ? index : -1).filter((index) => index >= 0);
  const verificationCallIndex = callPrompts.findIndex((prompt) => prompt.includes("你是 Agent 3"));
  assert.equal(featureCallIndex, 0);
  assert.equal(navigationCallIndexes.length, 4);
  assert.equal(navigationCallIndexes.every((index) => index > featureCallIndex && callPrompts[index].includes("独立特征标记")), true);
  navigationCallIndexes.forEach((index) => {
    const featureBlock = callPrompts[index].match(/Agent 1 已持久化的只读特征快照：\n([\s\S]*?)\n\n当前匹配策略：/);
    assert.ok(featureBlock);
    assert.deepEqual(JSON.parse(featureBlock[1]), result.agent1FeatureHandoff.features);
  });
  assert.equal(verificationCallIndex > navigationCallIndexes.at(-1), true);
  assert.doesNotMatch(callPrompts[verificationCallIndex], /从阻碍方式看，声母 d 属于哪类辅音/);
  // 已确认的普通成员（非 prototype）也可以作为参照样题：人工已审核其归属，
  // 不应因为该族没有 prototype 就把可用样题整体丢掉（实测「名字拼写规范」「a的音位变体」即属此类）。
  assert.match(callPrompts[verificationCallIndex], /已确认的普通成员可作为参照样题/);
  assert.doesNotMatch(callPrompts[verificationCallIndex], /不得作为 Agent 3 样题的下线题/);
  assert.doesNotMatch(callPrompts[verificationCallIndex], /不得作为 Agent 3 样题的已合并源题/);
  assert.match(callPrompts[verificationCallIndex], /Agent 3 可使用的在线未合并原型题/);
  assert.equal(callPrompts[featureCallIndex].includes("当前层候选节点"), false);
  assert.equal(aiTaskStore.list({ sceneId: "knowledge_feature_extraction" }).length, 1);
  assert.equal(aiTaskStore.list({ sceneId: "knowledge_hierarchy_navigation" }).length, 4);
  assert.equal(aiTaskStore.list({ sceneId: "knowledge_batch_verification" }).length, 1);
  assert.equal(created.job.knowledgeRevisionFormat, "topology-v1");
  assert.notEqual(stores.knowledgeStructureStore.get(bookId).fingerprints.find((item) => item.questionId === "classification-q1").source, "hierarchy_agent_review");

  stores.knowledgeStructureStore.updateNode(bookId, "obstruction", { title: "看形成和克服阻碍的方式" });
  const applyResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [result.id] }),
  });
  const applyPayload = await applyResponse.json();
  assert.equal(applyResponse.status, 409);
  assert.deepEqual(applyPayload.details.staleResults[0].reasons, ["knowledge_nodes_changed"]);
});

test("Agent 3 searches the complete knowledge tree after Agent 2 rejects all candidates", async (context) => {
  const prompts = [];
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.map((message) => String(message.content || "")).join("\n");
      prompts.push(prompt);
      let content;
      if (prompt.includes("只负责独立提取题目特征")) {
        content = agent2ContractFeatureOutput();
      } else if (prompt.includes("Agent 2，只负责读取 Agent 1 已持久化")) {
        const candidateBlock = prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/);
        const candidates = JSON.parse(candidateBlock[1]);
        content = {
          questionId: "classification-q1",
          decision: "none_of_candidates",
          selectedNodeIds: [],
          corePathStatus: "core_path_not_viable",
          auxiliaryGap: null,
          candidateRejections: candidates.map((candidate) => ({ nodeId: candidate.id, reason: "不能承载题目的核心考查。" })),
          confidence: 0.72,
          reason: "当前五个候选不足以确定归属。",
        };
      } else if (prompt.includes("知识树整树恢复步骤")) {
        content = {
          recoveries: [{
            questionId: "classification-q1",
            decision: "recover",
            primaryNodeId: "obstruction",
            requiredNodeIds: ["obstruction"],
            confidence: 0.91,
            reason: "整树检索后，阻碍方式是作答的最小充分知识。",
            uncertainty: "",
            evidenceChunkIds: ["chunk-obstruction"],
          }],
        };
      } else {
        content = {
          verifications: [{
            questionId: "classification-q1",
            decision: "confirm",
            primaryNodeId: "obstruction",
            requiredNodeIds: ["obstruction"],
            focusKey: "声母发音方法·阻碍方式",
            focusLabel: "声母发音方法·阻碍方式",
            action: "分类判断",
            confidence: 0.95,
            reason: "教材按形成和克服阻碍的方式划分塞音、擦音等。",
            uncertainty: "",
            evidenceChunkIds: ["chunk-obstruction"],
          }],
        };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "classification-model",
        choices: [{ message: { content: JSON.stringify(withAgent3OptionRelationAssessments(content, prompt)) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const stores = buildStores();
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const aiTaskStore = createMemoryAiTaskStore();
  const provider = {
    id: "classification-provider",
    name: "分类模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["classification-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_hierarchy_navigation: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 1200 },
      knowledge_batch_verification: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 2400 },
    },
  });
  const server = createServer({
    aiConfigStore,
    aiTaskStore,
    ...stores,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, questionIds: ["classification-q1"], limit: 1 }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 202, JSON.stringify(created));
  let job;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    job = (await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${created.job.id}`).then((response) => response.json())).job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "completed", JSON.stringify({ job, prompts }, null, 2));
  const result = knowledgeClassificationStore.resultForQuestion(job.id, "classification-q1");
  assert.equal(result.status, "pending_review");
  assert.equal(result.agent1Trajectories[0].stopReason, "none_of_candidates");
  assert.equal(result.agent2Verification.primaryNodeId, "obstruction");
  assert.equal(result.agent2Verification.recoveredFrom, "none_of_candidates");
  const recoveryPrompt = prompts.find((prompt) => prompt.includes("知识树整树恢复步骤"));
  assert.match(recoveryPrompt, /obstruction/);
  assert.match(recoveryPrompt, /airflow/);
  assert.equal(aiTaskStore.list({ sceneId: "knowledge_global_recovery" }).length, 1);
  assert.equal(aiTaskStore.list({ sceneId: "knowledge_batch_verification" }).length, 1);
});

test("classification pipeline exposes each review before the full batch finishes", async (context) => {
  let delayedSecondNavigation = false;
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.map((message) => String(message.content || "")).join("\n");
      const questionId = prompt.includes("classification-q2") ? "classification-q2" : "classification-q1";
      const navigation = prompt.includes("Agent 2，只负责读取 Agent 1 已持久化");
      let content;
      if (prompt.includes("只负责独立提取题目特征")) {
        const featureOutput = agent2ContractFeatureOutput();
        content = { ...featureOutput, questionId };
      } else if (navigation) {
        const candidateBlock = prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/);
        const selectedNodeId = JSON.parse(candidateBlock[1])[0].id;
        content = {
          questionId,
          decision: "node",
          selectedNodeIds: [selectedNodeId],
          corePathStatus: "core_path_viable",
          auxiliaryGap: null,
          candidateRejections: [],
          confidence: 0.96,
          reason: "沿教材层级逐层定位。",
        };
      } else {
        content = {
          verifications: [{
            questionId,
            decision: "confirm",
            primaryNodeId: "obstruction",
            requiredNodeIds: ["obstruction"],
            focusKey: "声母发音方法·阻碍方式",
            focusLabel: "声母发音方法·阻碍方式",
            action: "分类判断",
            confidence: 0.97,
            reason: "教材按形成和克服阻碍的方式划分塞音、擦音等。",
            uncertainty: "",
            evidenceChunkIds: ["chunk-obstruction"],
          }],
        };
      }
      const send = () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          model: "classification-model",
          choices: [{ message: { content: JSON.stringify(withAgent3OptionRelationAssessments(content, prompt)) } }],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        }));
      };
      if (navigation && questionId === "classification-q2" && !delayedSecondNavigation) {
        delayedSecondNavigation = true;
        setTimeout(send, 350);
      } else {
        send();
      }
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const stores = buildStores();
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const provider = {
    id: "classification-provider",
    name: "流水线模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["classification-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_hierarchy_navigation: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 1200 },
      knowledge_batch_verification: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 2400 },
    },
  });
  const server = createServer({ aiConfigStore, ...stores, knowledgeClassificationStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, questionIds: ["classification-q1", "classification-q2"], limit: 2 }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 202, JSON.stringify(created));

  let observedJob = null;
  let firstResult = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const payload = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${created.job.id}`).then((response) => response.json());
    const candidate = payload.results.find((result) => result.questionId === "classification-q1");
    if (payload.job.status === "running"
      && payload.job.agent1CurrentQuestionId === "classification-q2"
      && candidate?.status === "pending_review") {
      observedJob = payload.job;
      firstResult = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(observedJob, "第一题应在第二题仍由 Agent 1 处理时进入人工审核");
  assert.equal(observedJob.agent1Processed, 1);
  assert.equal(observedJob.agent2Processed, 1);
  assert.equal(observedJob.reviewReady, 1);

  const applyResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultIds: [firstResult.id] }),
  });
  const applied = await applyResponse.json();
  assert.equal(applyResponse.status, 200, JSON.stringify(applied));

  let finalJob;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const payload = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${created.job.id}`).then((response) => response.json());
    finalJob = payload.job;
    if (!["queued", "running"].includes(finalJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(finalJob.status, "completed", JSON.stringify(finalJob));
  assert.equal(finalJob.succeeded, 2);
  assert.equal(finalJob.reviewReady, 1);
  assert.equal(knowledgeClassificationStore.resultForQuestion(created.job.id, "classification-q1").status, "applied");
  assert.equal(knowledgeClassificationStore.resultForQuestion(created.job.id, "classification-q2").status, "pending_review");
});

test("vowel structure questions expose cross-branch evidence nodes and preserve verified official authority", async (context) => {
  const calls = [];
  let verificationPrompt = "";
  let invalidNavigationReturned = false;
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      calls.push(payload);
      const prompt = payload.messages.map((message) => String(message.content || "")).join("\n");
      let content;
      if (prompt.includes("只负责独立提取题目特征")) {
        content = {
          questionId: "classification-vowel-q1",
          featureProfile: {
            optionKnowledgeProtocolVersion: "option-knowledge-v2",
            choiceStructure: "direct_options",
            questionMode: "option_judgement",
            stemKeywords: ["笑", "韵腹"],
            coreKeywords: ["韵腹", "韵母结构"],
            stemKnowledgeHints: ["韵母的结构"],
            optionFeatures: [
              { key: "A", keywords: ["前低不圆唇"], knowledgeRelation: "option_specific", knowledgeHints: ["元音性质"], isCorrect: false, role: "distractor", weight: 0.15, decisionRole: "required_for_elimination", requiredForDecision: true, basis: "需要核对实际音值的发音性质。" },
              { key: "B", keywords: ["后半高圆唇"], knowledgeRelation: "option_specific", knowledgeHints: ["元音性质"], isCorrect: false, role: "distractor", weight: 0.15, decisionRole: "required_for_elimination", requiredForDecision: true, basis: "需要核对实际音值的发音性质。" },
              { key: "C", keywords: ["后低不圆唇"], knowledgeRelation: "option_specific", knowledgeHints: ["实际音值", "元音性质"], isCorrect: true, role: "answer", weight: 0.55, decisionRole: "supports_answer", requiredForDecision: true, basis: "先确定韵腹，再判断实际音值。" },
              { key: "D", keywords: ["央低不圆唇"], knowledgeRelation: "option_specific", knowledgeHints: ["元音性质"], isCorrect: false, role: "distractor", weight: 0.15, decisionRole: "required_for_elimination", requiredForDecision: true, basis: "需要核对实际音值的发音性质。" },
            ],
            primaryKnowledgeHints: ["韵母的结构"],
            secondaryKnowledgeHints: ["同一拼音字母在不同语音环境中的实际音值变化"],
            dependencySteps: [
              { order: 1, label: "识别 iao 中 a 的韵腹结构位置", source: "stem", necessity: "core", basis: "先确定题干询问的韵腹。" },
              { order: 2, label: "同一拼音字母在不同语音环境中的实际音值变化", source: "answer", necessity: "required", basis: "字母 a 的实际音值不能直接按字母名称判断。" },
            ],
            knowledgePriorities: [
              { label: "韵母的结构", role: "primary", weight: 0.65, basis: "题干直接询问韵腹。" },
              { label: "实际音值变化", role: "secondary", weight: 0.35, basis: "用于推出元音性质。" },
            ],
            primaryBasis: "先确定韵腹，再跨路径核对实际音值。",
            crossFamilyProbability: 0.9,
            callDepth: 2,
          },
        };
      } else if (prompt.includes("Agent 2，只负责读取 Agent 1 已持久化")) {
        const candidateBlock = prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/);
        const candidates = JSON.parse(candidateBlock[1]);
        const selected = ["finals-structure", "vowels", "phonetics"].map((id) => candidates.find((item) => item.id === id)).find(Boolean) || candidates[0];
        const crossesIntoPhonemeBranch = candidates.some((item) => item.id === "vowels")
          && candidates.some((item) => item.id === "phoneme");
        content = {
          questionId: "classification-vowel-q1",
          decision: "node",
          selectedNodeIds: [invalidNavigationReturned ? selected.id : "allophone"],
          corePathStatus: "core_path_viable",
          auxiliaryGap: invalidNavigationReturned && crossesIntoPhonemeBranch ? {
            type: "auxiliary_gap",
            dependencyStepRefs: ["dep-2"],
            reason: "核心路径进入元音与韵母，但实际音值变化位于音位分支，无法沿所选路径继续下钻到达。",
          } : null,
          candidateRejections: [],
          confidence: 0.96,
          reason: "先确定 iao 的韵腹，主路径归入韵母结构。",
        };
        invalidNavigationReturned = true;
      } else {
        verificationPrompt = prompt;
        content = {
          verifications: [{
            questionId: "classification-vowel-q1",
            decision: "cross_knowledge",
            primaryNodeId: "finals-structure",
            requiredNodeIds: ["finals-structure", "allophone", "vowel-pronunciation"],
            requiredNodeAssessments: [{
              nodeId: "allophone",
              dependencyStepRefs: ["dep-2"],
              necessaryAfterDeletionTest: true,
              deletionTest: "删除音位变体后，无法由拼音字母 a 推得 iao 中的实际音值 [ɑ]。",
              entailedByPrimaryRule: false,
              reason: "实际音值变化是独立的推导步骤。",
            }, {
              nodeId: "vowel-pronunciation",
              dependencyStepRefs: ["dep-2"],
              necessaryAfterDeletionTest: true,
              deletionTest: "删除元音发音性质后，无法把 [ɑ] 判定为后、低、不圆唇元音。",
              entailedByPrimaryRule: false,
              reason: "选项要求完成发音性质判定。",
            }],
            focusKey: "韵腹·实际音值·元音性质",
            focusLabel: "由 iao 的韵腹推导 [ɑ] 的发音性质",
            action: "结构识别后跨知识点推导",
            confidence: 0.98,
            reason: "先由韵母结构确定 a 是韵腹，再由音位变体确定实际音值 [ɑ]，最后按舌面元音维度判断为后、低、不圆唇。",
            uncertainty: "",
            evidenceChunkIds: ["chunk-finals-structure", "chunk-tongue-vowel", "chunk-allophone"],
          }],
        };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "classification-model",
        choices: [{ message: { content: JSON.stringify(withAgent3OptionRelationAssessments(content, prompt)) } }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const stores = buildVowelCrossKnowledgeStores();
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const provider = {
    id: "classification-provider",
    name: "分类模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["classification-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_hierarchy_navigation: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 1200 },
      knowledge_batch_verification: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 2400 },
    },
  });
  const server = createServer({ aiConfigStore, ...stores, knowledgeClassificationStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, questionIds: ["classification-vowel-q1"], limit: 1 }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 202);

  let job;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const payload = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${created.job.id}`).then((response) => response.json());
    job = payload.job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "completed", JSON.stringify({ job, calls }, null, 2));
  const result = knowledgeClassificationStore.resultForQuestion(job.id, "classification-vowel-q1");
  assert.equal(result.agent2Verification.decision, "cross_knowledge");
  assert.deepEqual(result.agent2Verification.requiredNodeIds, ["finals-structure", "allophone", "vowel-pronunciation"]);
  assert.equal(result.classificationOutcome, "auxiliary_gap");
  const auxiliaryGap = result.agent1Trajectories.flatMap((trajectory) => trajectory.steps)
    .map((step) => step.auxiliaryGap).find(Boolean);
  assert.ok(auxiliaryGap);
  assert.deepEqual(auxiliaryGap.dependencyStepRefs, ["dep-2"]);
  assert.deepEqual(auxiliaryGap.dependencies[0].nodeIds, []);
  assert.equal(auxiliaryGap.dependencies[0].label, "同一拼音字母在不同语音环境中的实际音值变化");
  assert.equal(result.agent2Verification.reason, "先由韵母结构确定 a 是韵腹，再由音位变体确定实际音值 [ɑ]，最后按舌面元音维度判断为后、低、不圆唇。");
  assert.deepEqual(result.agent2Verification.riskHints.map((hint) => hint.nodeId), ["finals-structure", "tongue-vowel", "allophone"]);
  assert.equal(result.agent2Verification.riskHints.every((hint) => hint.type === "bridge_candidate" && hint.requiresHumanReview), true);
  assert.match(result.agent2Verification.riskHints[0].message, /只是候选风险提示/);
  assert.match(result.agent2Verification.reason, /音位变体确定实际音值/);
  assert.equal(result.agent2Verification.uncertainty, "");
  assert.match(verificationPrompt, /"answerAuthority":\s*"verified_source_or_platform"/);
  assert.match(verificationPrompt, /"verifiedSourceOrPlatform":\s*"C【精析】/);
  assert.doesNotMatch(verificationPrompt, /"official":/);
  assert.match(verificationPrompt, /不得把平台核验答案或来源答案称为“官方答案”/);
  assert.match(verificationPrompt, /"ai":\s*"D。/);
  assert.match(verificationPrompt, /"candidateKnowledgeNodeIds":\s*\[[\s\S]*?"finals-structure"/);
  assert.match(verificationPrompt, /"candidateKnowledgeNodeIds":\s*\[[\s\S]*?"tongue-vowel"/);
  assert.match(verificationPrompt, /"candidateKnowledgeNodeIds":\s*\[[\s\S]*?"allophone"/);
  assert.match(verificationPrompt, /"id":\s*"allophone"/);
  assert.match(verificationPrompt, /"id":\s*"chunk-allophone"/);
  assert.match(verificationPrompt, /同一拼音字母在不同语音环境中的实际音值变化/);
  assert.equal(calls.some((call) => call.messages.some((message) => String(message.content || "").includes("知识树整树恢复步骤"))), false);
  assert.match(verificationPrompt, /relatedFamilyAssessments/);
  assert.match(verificationPrompt, /relatedFamilyRelations/);
  assert.match(verificationPrompt, /coverageRole/);
  assert.match(verificationPrompt, /只有 required 的成员贡献参与最小充分知识集覆盖/);
  assert.match(verificationPrompt, /familyDecision=create_new 时 primaryFamilyId 必须为空，但可以保留已有 required 或 reference 关联题族/);
  assert.equal(calls.some((call) => call.messages.some((message) => String(message.content || "").includes("allowedCandidateNodeIds"))), true);

  const applyResponse = await fetch(`${baseUrl}/api/admin/knowledge-classification/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resultIds: [result.id],
      selections: [{
        resultId: result.id,
        primaryNodeId: "vowel-pronunciation",
        requiredNodeIds: ["finals-structure", "vowel-pronunciation"],
      }],
      adjustmentReason: "人工判断本题核心训练方向更接近元音发音，保留韵母结构作为共同必需知识。",
    }),
  });
  const applied = await applyResponse.json();
  assert.equal(applyResponse.status, 200, JSON.stringify(applied));
  assert.equal(applied.agent4.correctionCount, 1);
  assert.equal(applied.agent4.corrections[0].suggestedPrimaryNodeId, "finals-structure");
  assert.equal(applied.agent4.corrections[0].finalPrimaryNodeId, "vowel-pronunciation");
  assert.deepEqual(applied.reviewSelections[0], {
    resultId: result.id,
    primaryNodeId: "vowel-pronunciation",
    primaryNodeRole: "core",
    requiredNodeIds: ["finals-structure", "vowel-pronunciation"],
  });
  const fingerprint = stores.knowledgeStructureStore.get(bookId).fingerprints
    .find((item) => item.questionId === "classification-vowel-q1");
  assert.equal(fingerprint.primaryNodeId, "vowel-pronunciation");
  assert.deepEqual(fingerprint.requiredNodeIds, ["vowel-pronunciation", "finals-structure"]);
});

test("Agent 2 retries invalid JSON once with temperature zero and continues after a valid correction", async (context) => {
  const invalidRawOutput = "{first navigation response is not valid JSON";
  const scenario = await runAgent2ContractScenario(context, [
    invalidRawOutput,
    validAgent2ContractNavigation,
  ]);

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.status, "pending_review", JSON.stringify(scenario.result));
  const firstDepthDiagnostics = scenario.result.agent2NavigationDiagnostics.filter((item) => item.depth === 1);
  assert.equal(firstDepthDiagnostics.length, 2);
  assert.equal(firstDepthDiagnostics[0].contractAttempt, 1);
  assert.equal(firstDepthDiagnostics[0].status, "format_invalid");
  assert.equal(firstDepthDiagnostics[0].errorCode, "knowledge_classification_agent2_navigation_json_invalid");
  assert.equal(firstDepthDiagnostics[0].rawOutput, invalidRawOutput);
  assert.equal(firstDepthDiagnostics[1].contractAttempt, 2);
  assert.equal(firstDepthDiagnostics[1].status, "valid");
  assert.equal(firstDepthDiagnostics[1].retryOfTaskId, firstDepthDiagnostics[0].taskId);

  const navigationCalls = scenario.calls.filter((call) => call.phase === "agent2");
  assert.equal(navigationCalls[0].payload.temperature, 0.17);
  assert.equal(navigationCalls[1].payload.temperature, 0);
  assert.match(navigationCalls[1].prompt, /knowledge_classification_agent2_navigation_json_invalid/);
  assert.match(navigationCalls[1].prompt, /first navigation response is not valid JSON/);
  assert.match(navigationCalls[1].prompt, /"allowedAuxiliaryGapDependencyStepRefs":\s*\[\s*"dep-1"\s*\]/);
  assert.match(navigationCalls[1].prompt, /input_descriptor、terminology_only、absorbed_by_core 和 incidental 均不得引用/);
  assert.equal(scenario.aiTaskStore.list({ sceneId: "knowledge_batch_verification" }).length, 1);
});

test("Agent 1 retries an invalid option-relation contract once and preserves both attempts", async (context) => {
  const invalid = agent2ContractFeatureOutput();
  delete invalid.featureProfile.optionFeatures[0].knowledgeRelation;
  const scenario = await runAgent2ContractScenario(context, [], [], {
    agent1Outputs: [JSON.stringify(invalid), JSON.stringify(agent2ContractFeatureOutput())],
  });

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.agent1FeatureDiagnostics.length, 2);
  assert.equal(scenario.result.agent1FeatureDiagnostics[0].status, "contract_invalid");
  assert.equal(scenario.result.agent1FeatureDiagnostics[0].errorCode, "knowledge_feature_extraction_contract_invalid");
  assert.equal(scenario.result.agent1FeatureDiagnostics[0].violations.some((item) => item.code === "option_relation_invalid"), true);
  assert.equal(scenario.result.agent1FeatureDiagnostics[1].status, "valid");
  assert.equal(scenario.result.agent1FeatureDiagnostics[1].retryOfTaskId, scenario.result.agent1FeatureDiagnostics[0].taskId);
  assert.equal(scenario.result.agent1FeatureHandoff.rawFeatures.optionFeatures[0].knowledgeRelation, "question_only");
  const calls = scenario.calls.filter((call) => call.phase === "agent1");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.temperature, 0);
  assert.match(calls[1].prompt, /option_relation_invalid/);
  assert.match(calls[1].prompt, /逐条修复 violations/);
});

test("Agent 1 marks a second invalid option-relation contract unassessed instead of using heuristic fallback", async (context) => {
  const invalid = agent2ContractFeatureOutput();
  invalid.featureProfile.optionFeatures = invalid.featureProfile.optionFeatures.slice(0, 1);
  const scenario = await runAgent2ContractScenario(context, [], [], {
    agent1Outputs: [JSON.stringify(invalid), JSON.stringify(invalid)],
  });

  assert.equal(scenario.job.status, "failed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.status, "failed");
  assert.equal(scenario.result.agent1Status, "failed");
  assert.equal(scenario.result.agent2Status, "skipped");
  assert.equal(scenario.result.classificationOutcome, "agent1_contract_failed");
  assert.equal(scenario.result.error, "knowledge_feature_extraction_contract_failed");
  assert.equal(scenario.result.agent1Features, null);
  assert.deepEqual(scenario.result.agent1FeatureDiagnostics.map((item) => item.contractAttempt), [1, 2]);
  assert.equal(scenario.result.agent1FeatureDiagnostics.every((item) => item.status === "contract_invalid"), true);
  assert.equal(scenario.calls.some((call) => call.phase === "agent2" || call.phase === "agent3"), false);
});

test("Agent 3 primary and repair prompts keep every V2 relation item beyond the compact display limit", async (context) => {
  const optionKeys = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const featureOutput = agent2ContractFeatureOutput();
  featureOutput.featureProfile.optionFeatures = optionKeys.map((key, index) => ({
    key,
    keywords: [`选项${key}`],
    knowledgeRelation: "question_only",
    knowledgeHints: [],
    isCorrect: index === 0,
    role: index === 0 ? "answer" : "distractor",
    weight: index === 0 ? 0.6 : 0.05,
    decisionRole: index === 0 ? "supports_answer" : "required_for_elimination",
    requiredForDecision: true,
    basis: "题目层规则足以完成该项判断。",
  }));
  const verificationFromPrompt = (prompt, optionRelationAssessments) => {
    const featureBlock = prompt.match(/Agent 1 题目特征：\n([\s\S]*?)\n\nAgent 2 逐层轨迹：/);
    assert.ok(featureBlock);
    const suppliedFeatures = JSON.parse(featureBlock[1])[0].features;
    assert.deepEqual(suppliedFeatures.optionFeatures.map((item) => item.key), optionKeys);
    return {
      verifications: [{
        questionId: "classification-q1",
        decision: "unable",
        primaryNodeId: "",
        requiredNodeIds: [],
        requiredNodeAssessments: [],
        optionRelationAssessments,
        focusKey: "",
        focusLabel: "",
        action: "",
        confidence: 0.4,
        reason: "测试关系项完整传递，知识裁决保持无法确定。",
        uncertainty: "本测试不执行正式归类。",
        evidenceChunkIds: ["chunk-obstruction"],
        familyDecision: "unresolved",
        primaryFamilyId: "",
        relatedFamilyIds: [],
        relatedFamilyAssessments: [],
        matchedFamilyIds: [],
        duplicateFamilyIds: [],
      }],
    };
  };
  const validAssessments = optionKeys.map((key) => ({
    key,
    decision: "confirm",
    verifiedKnowledgeNodeIds: [],
    proposedKnowledgeRelation: "",
    proposedKnowledgeNodeIds: [],
    evidenceChunkIds: ["chunk-obstruction"],
    reason: "教材证据与删除检验支持题目层知识足以判断。",
  }));
  const scenario = await runAgent2ContractScenario(context, [], [
    (prompt) => verificationFromPrompt(prompt, []),
    (prompt) => verificationFromPrompt(prompt, validAssessments),
  ], {
    agent1Outputs: [JSON.stringify(featureOutput)],
    configureStores(stores) {
      stores.questionStore.update("classification-q1", {
        options: optionKeys.map((key) => ({ key, text: `选项${key}` })),
        correctAnswer: ["A"],
      }, "测试审核员");
    },
  });

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  const verificationCalls = scenario.calls.filter((call) => call.phase === "agent3");
  assert.equal(verificationCalls.length, 2);
  assert.equal(scenario.result.agent2Verification.optionRelationAssessments.length, optionKeys.length);
  assert.deepEqual(scenario.result.agent2Verification.optionRelationAssessments.map((item) => item.key), optionKeys);
});

test("Agent 2 multiple-not-offered retry selects the unique direct core path", async (context) => {
  const invalidMultipleSelection = (prompt) => {
    const candidateBlock = prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/);
    const candidates = JSON.parse(candidateBlock[1]);
    assert.equal(candidates.length >= 2, true);
    return {
      questionId: "classification-q1",
      decision: "multiple",
      selectedNodeIds: candidates.slice(0, 2).map((candidate) => candidate.id),
      corePathStatus: "core_path_viable",
      auxiliaryGap: null,
      candidateRejections: [],
      confidence: 0.75,
      reason: "现有题族样例同时涉及两个目录。",
    };
  };
  const scenario = await runAgent2ContractScenario(context, [
    invalidMultipleSelection,
    validAgent2ContractNavigation,
  ], [], {
    additionalCatalogNodes: [{ id: "lexicon", level: 1, title: "第三章 词汇", startPage: 81, endPage: 120 }],
  });

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  const firstDepthDiagnostics = scenario.result.agent2NavigationDiagnostics.filter((item) => item.depth === 1);
  assert.equal(firstDepthDiagnostics.length, 2);
  assert.equal(firstDepthDiagnostics[0].errorCode, "knowledge_classification_agent2_navigation_multiple_not_offered");
  assert.equal(firstDepthDiagnostics[1].status, "valid");

  const navigationCalls = scenario.calls.filter((call) => call.phase === "agent2");
  const correctionPrompt = navigationCalls[1].prompt;
  assert.match(correctionPrompt, /选择唯一核心路径/);
  assert.match(correctionPrompt, /承载 Agent 1 的主知识/);
  assert.match(correctionPrompt, /教材规则能够最直接推出答案/);
  assert.match(correctionPrompt, /题族样例和相似案例只能辅助检索，不得压过更直接的教材规则/);
  assert.match(correctionPrompt, /宽泛上位路径不得压过具体且可直接作答的规则路径/);
  assert.match(correctionPrompt, /independent_required 依赖，必须通过 auxiliaryGap 提交/);
});

test("Agent 2 stops after two invalid JSON outputs, preserves both, and skips Agent 3", async (context) => {
  const invalidRawOutputs = [
    "{first invalid navigation JSON",
    "{second invalid navigation JSON",
  ];
  const scenario = await runAgent2ContractScenario(context, invalidRawOutputs);

  assert.equal(scenario.job.status, "failed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.status, "failed");
  assert.equal(scenario.result.agent1Status, "failed");
  assert.equal(scenario.result.agent2Status, "skipped");
  assert.equal(scenario.result.classificationOutcome, "agent2_contract_failed");
  assert.equal(scenario.result.error, "knowledge_classification_agent2_contract_failed");
  assert.deepEqual(
    scenario.result.agent2NavigationDiagnostics.map((item) => item.rawOutput),
    invalidRawOutputs,
  );
  assert.deepEqual(
    scenario.result.agent2NavigationDiagnostics.map((item) => item.contractAttempt),
    [1, 2],
  );
  assert.equal(scenario.result.agent2NavigationDiagnostics.every((item) => item.status === "format_invalid"), true);

  const navigationCalls = scenario.calls.filter((call) => call.phase === "agent2");
  assert.equal(navigationCalls.length, 2);
  assert.equal(navigationCalls[1].payload.temperature, 0);
  assert.equal(scenario.calls.some((call) => call.phase === "agent3"), false);
  assert.equal(scenario.aiTaskStore.list({ sceneId: "knowledge_batch_verification" }).length, 0);
});

test("Agent 2 treats JSON null as a contract error and uses its single retry", async (context) => {
  const scenario = await runAgent2ContractScenario(context, [
    "null",
    validAgent2ContractNavigation,
  ]);

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.status, "pending_review", JSON.stringify(scenario.result));
  const firstDepthDiagnostics = scenario.result.agent2NavigationDiagnostics.filter((item) => item.depth === 1);
  assert.equal(firstDepthDiagnostics.length, 2);
  assert.equal(firstDepthDiagnostics[0].status, "contract_invalid");
  assert.equal(firstDepthDiagnostics[0].errorCode, "knowledge_classification_agent2_navigation_output_invalid");
  assert.equal(firstDepthDiagnostics[0].rawOutput, "null");
  assert.equal(firstDepthDiagnostics[1].status, "valid");
  assert.equal(firstDepthDiagnostics[1].contractAttempt, 2);
  const navigationCalls = scenario.calls.filter((call) => call.phase === "agent2");
  assert.equal(navigationCalls[1].payload.temperature, 0);
});

test("Agent 3 corrects unresolved-with-nodes into a confirmed new-family draft", async (context) => {
  const invalidVerification = {
    verifications: [{
      questionId: "classification-q1",
      decision: "unable",
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      requiredNodeAssessments: [],
      focusKey: "阻碍方式分类",
      focusLabel: "阻碍方式分类",
      action: "分类判断",
      confidence: 0.62,
      reason: "答案说明不足，但教材节点已经能够确定。",
      uncertainty: "来源答案没有逐项解释。",
      evidenceChunkIds: ["chunk-obstruction"],
      familyDecision: "unresolved",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      relatedFamilyAssessments: [],
      matchedFamilyIds: [],
      duplicateFamilyIds: [],
      familySimilarityReason: "没有完全匹配的已确认题族。",
    }],
  };
  const correctedVerification = {
    verifications: [{
      questionId: "classification-q1",
      decision: "confirm",
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      requiredNodeAssessments: [],
      focusKey: "阻碍方式分类",
      focusLabel: "阻碍方式分类",
      action: "分类判断",
      confidence: 0.88,
      reason: "教材可确认核心知识；来源答案解释不足单列为不确定性。",
      uncertainty: "来源答案没有逐项解释，不影响已由教材确认的知识归属。",
      evidenceChunkIds: ["chunk-obstruction"],
      familyDecision: "create_new",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      relatedFamilyAssessments: [],
      matchedFamilyIds: [],
      duplicateFamilyIds: [],
      familySimilarityReason: "没有核心知识、必需集合和考查动作均匹配的 confirmed 题族。",
      candidateFamilyDraft: {
        name: "辅音阻碍方式分类判断",
        coreKnowledgeNodeId: "obstruction",
        requiredKnowledgeNodeIds: ["obstruction"],
        textbookAnchorNodeIds: ["obstruction"],
        assessmentAction: "分类判断",
        inclusionBoundary: "纳入依据阻碍形成和克服方式判断辅音类别的题目。",
        exclusionBoundary: "排除只判断声带振动或气流强弱的题目。",
        membership: {
          coverageRole: "required",
          contributionKnowledgeNodeIds: ["obstruction"],
        },
        textbookEvidence: {
          chunkIds: ["chunk-obstruction"],
          summary: "教材直接说明塞音、擦音等阻碍方式类别。",
        },
        reason: "现有 confirmed 题族均不满足相同核心知识和考查动作。",
      },
    }],
  };
  const scenario = await runAgent2ContractScenario(context, [], [
    invalidVerification,
    correctedVerification,
  ]);

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.status, "pending_review", JSON.stringify(scenario.result));
  assert.equal(scenario.result.agent2Verification.decision, "confirm");
  assert.equal(scenario.result.agent2Verification.primaryNodeId, "obstruction");
  assert.deepEqual(scenario.result.agent2Verification.requiredNodeIds, ["obstruction"]);
  assert.equal(scenario.result.agent2Verification.familyDecision, "create_new");
  assert.equal(scenario.result.agent2Verification.candidateFamilyDraft.name, "辅音阻碍方式分类判断");
  assert.equal(scenario.result.agent2Verification.agent3ContractStatus, "corrected");
  assert.deepEqual(scenario.result.agent2Verification.agent3Diagnostics.map((item) => item.status), [
    "contract_invalid",
    "valid",
  ]);
  assert.equal(scenario.result.agent2Verification.agent3Diagnostics[0].errorCode, "knowledge_classification_agent2_unresolved_nodes_invalid");

  const verificationCalls = scenario.calls.filter((call) => call.phase === "agent3");
  assert.equal(verificationCalls.length, 2);
  assert.match(verificationCalls[1].prompt, /(?:已有|已经|确定).*(?:节点|primaryNodeId|requiredNodeIds).*(?:confirm|move_parent|move_sibling)/s);
  assert.match(verificationCalls[1].prompt, /答案证据不足.*uncertainty/s);
  assert.match(verificationCalls[1].prompt, /(?:不得|不能).*(?:unable|missing_node).*(?:逃避|规避)/s);
  assert.match(verificationCalls[1].prompt, /(?:没有|无).*(?:匹配|合适).*confirmed.*题族.*create_new.*candidateFamilyDraft/s);

  const verificationTasks = scenario.aiTaskStore.list({ sceneId: "knowledge_batch_verification", limit: 10 });
  assert.equal(verificationTasks.length, 2);
  const primaryTask = verificationTasks.find((task) => task.inputSummary.attemptKind === "primary");
  const repairTask = verificationTasks.find((task) => task.inputSummary.attemptKind === "contract_repair");
  assert.equal(primaryTask.errorCode, "knowledge_classification_agent2_unresolved_nodes_invalid");
  assert.equal(repairTask.status, "succeeded");
  assert.equal(repairTask.inputSummary.parentTaskId, primaryTask.id);
  assert.equal(repairTask.inputSummary.contractAttempt, 2);
});

test("Agent 3 repair reserves terminal direct evidence after noisy search and keeps the bounded prior draft", async (context) => {
  const draft = {
    name: "辅音阻碍方式分类判断",
    coreKnowledgeNodeId: "obstruction",
    requiredKnowledgeNodeIds: ["obstruction"],
    textbookAnchorNodeIds: ["not-an-offered-node"],
    assessmentAction: "依据形成和克服阻碍的方式分类",
    inclusionBoundary: "纳入根据阻碍方式判断塞音、擦音等类别的题目。",
    exclusionBoundary: "排除只判断声带振动或气流强弱的题目。",
    textbookEvidence: {
      chunkIds: ["chunk-obstruction"],
      summary: "教材直接说明形成和克服阻碍的分类标准。",
    },
    reason: "现有题族没有同时满足该核心知识与考查动作。",
  };
  const verification = (candidateFamilyDraft) => ({
    verifications: [{
      questionId: "classification-q1",
      decision: "confirm",
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      requiredNodeAssessments: [],
      focusKey: "阻碍方式分类",
      focusLabel: "阻碍方式分类",
      action: "依据形成和克服阻碍的方式分类",
      confidence: 0.91,
      reason: "教材直接给出按阻碍方式划分辅音的标准。",
      uncertainty: "仅教材锚点需要纠正。",
      evidenceChunkIds: ["chunk-obstruction"],
      familyDecision: "create_new",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      relatedFamilyAssessments: [],
      matchedFamilyIds: [],
      duplicateFamilyIds: [],
      familySimilarityReason: "没有完全匹配的已确认题族。",
      candidateFamilyDraft,
    }],
  });
  const noiseChunks = [1, 2, 3].map((index) => ({
    id: `chunk-noise-${index}`,
    bookId,
    catalogNodeId: index === 1 ? "voicing" : "airflow",
    catalogPath: index === 1
      ? "语音 > 辅音与声母 > 辅音的发音方法 > 看声带是否振动"
      : "语音 > 辅音与声母 > 辅音的发音方法 > 看气流的强弱",
    text: `噪声检索片段 ${index}，不提供形成和克服阻碍的教材规则。`,
    retrievalText: "从阻碍方式看 声母 b 属于哪类辅音 塞音 擦音 单选题 参考答案 塞音",
    printedPageStart: 39 + index,
    printedPageEnd: 39 + index,
    pdfPageStart: 43 + index,
    enabled: true,
    retrievalEnabled: true,
  }));
  const scenario = await runAgent2ContractScenario(context, [], [
    verification(draft),
    verification({ ...draft, textbookAnchorNodeIds: ["obstruction"] }),
  ], { prependKnowledgeChunks: noiseChunks });

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.agent2Verification.agent3ContractStatus, "corrected");
  assert.equal(scenario.result.agent2Verification.candidateFamilyDraft.textbookAnchorNodeIds[0], "obstruction");
  assert.deepEqual(scenario.result.agent2Verification.evidenceChunkIds, ["chunk-obstruction"]);

  const verificationCalls = scenario.calls.filter((call) => call.phase === "agent3");
  assert.equal(verificationCalls.length, 2);
  assert.match(verificationCalls[0].prompt, /chunk-noise-/);
  assert.match(verificationCalls[0].prompt, /chunk-obstruction/);
  assert.match(verificationCalls[1].prompt, /chunk-obstruction/);
  assert.match(verificationCalls[1].prompt, /辅音 按照 形成阻碍 克服阻碍 塞音 擦音/);
  assert.match(verificationCalls[1].prompt, /辅音阻碍方式分类判断/);
  assert.match(verificationCalls[1].prompt, /依据形成和克服阻碍的方式分类/);
  assert.match(verificationCalls[1].prompt, /not-an-offered-node/);
  assert.match(verificationCalls[1].prompt, /仅教材锚点需要纠正/);

  const tasks = scenario.aiTaskStore.list({ sceneId: "knowledge_batch_verification", limit: 10 });
  const primaryTask = tasks.find((task) => task.inputSummary.attemptKind === "primary");
  const repairTask = tasks.find((task) => task.inputSummary.attemptKind === "contract_repair");
  assert.equal(primaryTask.errorCode, "knowledge_classification_family_draft_anchor_invalid");
  assert.equal(repairTask.inputSummary.offeredEvidenceChunkIds["classification-q1"][0], "chunk-obstruction");
  assert.match(repairTask.inputSummary.offeredEvidenceChunkIds["classification-q1"][1], /^chunk-noise-/);
});

test("Agent 3 requires a family decision when confirmed knowledge has no matching family", async (context) => {
  const confirmedWithoutFamily = {
    verifications: [{
      questionId: "classification-q1",
      decision: "confirm",
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      requiredNodeAssessments: [],
      focusKey: "阻碍方式分类",
      focusLabel: "阻碍方式分类",
      action: "分类判断",
      confidence: 0.9,
      reason: "教材能够确认唯一核心知识和考查动作。",
      uncertainty: "",
      evidenceChunkIds: ["chunk-obstruction"],
      familyDecision: "unresolved",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      relatedFamilyAssessments: [],
      matchedFamilyIds: [],
      duplicateFamilyIds: [],
      familySimilarityReason: "候选 confirmed 题族均不匹配。",
    }],
  };
  const correctedWithDraft = {
    verifications: [{
      questionId: "classification-q1",
      decision: "confirm",
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      requiredNodeAssessments: [],
      focusKey: "阻碍方式分类",
      focusLabel: "阻碍方式分类",
      action: "分类判断",
      confidence: 0.9,
      reason: "教材能够确认唯一核心知识和考查动作。",
      uncertainty: "",
      evidenceChunkIds: ["chunk-obstruction"],
      familyDecision: "create_new",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      relatedFamilyAssessments: [],
      matchedFamilyIds: [],
      duplicateFamilyIds: [],
      familySimilarityReason: "候选 confirmed 题族均不匹配，因此提出新题族草稿。",
      candidateFamilyDraft: {
        name: "辅音阻碍方式分类判断",
        coreKnowledgeNodeId: "obstruction",
        requiredKnowledgeNodeIds: ["obstruction"],
        textbookAnchorNodeIds: ["obstruction"],
        assessmentAction: "分类判断",
        inclusionBoundary: "纳入依据阻碍形成和克服方式判断辅音类别的题目。",
        exclusionBoundary: "排除只判断声带振动或气流强弱的题目。",
        textbookEvidence: {
          chunkIds: ["chunk-obstruction"],
          summary: "教材直接说明塞音、擦音等阻碍方式类别。",
        },
        reason: "现有 confirmed 题族均不满足相同核心知识、必需集合和考查动作。",
      },
    }],
  };
  const scenario = await runAgent2ContractScenario(context, [], [
    confirmedWithoutFamily,
    correctedWithDraft,
  ]);

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.status, "pending_review", JSON.stringify(scenario.result));
  assert.equal(scenario.result.agent2Verification.decision, "confirm");
  assert.equal(scenario.result.agent2Verification.primaryNodeId, "obstruction");
  assert.deepEqual(scenario.result.agent2Verification.requiredNodeIds, ["obstruction"]);
  assert.equal(scenario.result.agent2Verification.familyDecision, "create_new");
  assert.equal(scenario.result.agent2Verification.candidateFamilyDraft.name, "辅音阻碍方式分类判断");
  assert.equal(scenario.result.agent2Verification.agent3ContractStatus, "corrected");
  assert.deepEqual(scenario.result.agent2Verification.agent3Diagnostics.map((item) => item.status), [
    "contract_invalid",
    "valid",
  ]);
  assert.equal(
    scenario.result.agent2Verification.agent3Diagnostics[0].errorCode,
    "knowledge_classification_agent3_family_decision_required",
  );

  const verificationCalls = scenario.calls.filter((call) => call.phase === "agent3");
  assert.equal(verificationCalls.length, 2);
  assert.match(verificationCalls[1].prompt, /knowledge_classification_agent3_family_decision_required/);
  assert.match(verificationCalls[1].prompt, /create_new.*candidateFamilyDraft/s);
  const verificationTasks = scenario.aiTaskStore.list({ sceneId: "knowledge_batch_verification", limit: 10 });
  assert.equal(verificationTasks.length, 2);
  const primaryTask = verificationTasks.find((task) => task.inputSummary.attemptKind === "primary");
  const repairTask = verificationTasks.find((task) => task.inputSummary.attemptKind === "contract_repair");
  assert.equal(primaryTask.errorCode, "knowledge_classification_agent3_family_decision_required");
  assert.equal(repairTask.status, "succeeded");
  assert.equal(repairTask.inputSummary.parentTaskId, primaryTask.id);
  assert.equal(repairTask.inputSummary.contractAttempt, 2);
});

test("Agent 3 corrects an incompatible joined family into a complete new-family draft", async (context) => {
  let incompatibleFamilyId = "";
  const invalidJoin = () => ({
    verifications: [{
      questionId: "classification-q1",
      decision: "confirm",
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      requiredNodeAssessments: [],
      focusKey: "阻碍方式分类",
      focusLabel: "阻碍方式分类",
      action: "分类判断",
      confidence: 0.91,
      reason: "教材支持阻碍方式分类。",
      uncertainty: "",
      evidenceChunkIds: ["chunk-obstruction"],
      familyDecision: "join_existing",
      primaryFamilyId: incompatibleFamilyId,
      relatedFamilyIds: [],
      relatedFamilyAssessments: [],
      matchedFamilyIds: [incompatibleFamilyId],
      duplicateFamilyIds: [],
      familySimilarityReason: "名称近似，但核心知识与考查动作不一致。",
    }],
  });
  const correctedCreateNew = () => ({
    verifications: [{
      questionId: "classification-q1",
      decision: "confirm",
      primaryNodeId: "obstruction",
      requiredNodeIds: ["obstruction"],
      requiredNodeAssessments: [],
      focusKey: "阻碍方式分类",
      focusLabel: "阻碍方式分类",
      action: "分类判断",
      confidence: 0.94,
      reason: "教材支持阻碍方式分类。",
      uncertainty: "",
      evidenceChunkIds: ["chunk-obstruction"],
      familyDecision: "create_new",
      primaryFamilyId: "",
      relatedFamilyIds: [],
      relatedFamilyAssessments: [],
      matchedFamilyIds: [incompatibleFamilyId],
      duplicateFamilyIds: [],
      familySimilarityReason: "不兼容题族仅作为相似候选，不能直接加入。",
      candidateFamilyDraft: {
        name: "辅音阻碍方式分类判断",
        coreKnowledgeNodeId: "obstruction",
        requiredKnowledgeNodeIds: ["obstruction"],
        textbookAnchorNodeIds: ["obstruction"],
        assessmentAction: "分类判断",
        inclusionBoundary: "纳入依据阻碍形成和克服方式判断辅音类别的题目。",
        exclusionBoundary: "排除只判断声带振动或气流强弱的题目。",
        textbookEvidence: {
          chunkIds: ["chunk-obstruction"],
          summary: "教材直接说明塞音、擦音等阻碍方式类别。",
        },
        reason: "候选 confirmed 题族均不满足相同核心知识、必需集合和考查动作。",
      },
    }],
  });
  const scenario = await runAgent2ContractScenario(context, [], [
    invalidJoin,
    correctedCreateNew,
  ], {
    configureStores(stores) {
      const incompatibleFamily = stores.questionFamilyStore.create({
        subjectId: "modern-chinese",
        bookId,
        name: "清浊概念识别",
        knowledgeNodeId: "voicing",
        knowledgePath: "语音 > 辅音与声母 > 辅音的发音方法 > 看声带是否振动",
        coreKnowledgeNodeId: "voicing",
        requiredKnowledgeNodeIds: ["voicing"],
        textbookAnchorNodeIds: ["voicing"],
        assessmentAction: "概念识别",
      });
      incompatibleFamilyId = incompatibleFamily.id;
      stores.questionFamilyStore.review(incompatibleFamily.id, {
        status: "confirmed",
        members: [{
          questionId: "classification-q2",
          isPrimary: true,
          role: "prototype",
          trainingLevel: "foundation",
          action: "概念识别",
          confidence: 1,
          reason: "测试样题",
        }],
      }, "测试审核员");
    },
  });

  assert.equal(scenario.job.status, "completed", JSON.stringify(scenario.job));
  assert.equal(scenario.result.agent2Verification.agent3ContractStatus, "corrected");
  assert.equal(scenario.result.agent2Verification.familyDecision, "create_new");
  assert.equal(scenario.result.agent2Verification.primaryFamilyId, "");
  assert.deepEqual(scenario.result.agent2Verification.matchedFamilyIds, [incompatibleFamilyId]);
  assert.equal(scenario.result.agent2Verification.candidateFamilyDraft.name, "辅音阻碍方式分类判断");
  assert.equal(
    scenario.result.agent2Verification.agent3Diagnostics[0].errorCode,
    "knowledge_classification_agent3_join_core_mismatch",
  );

  const verificationCalls = scenario.calls.filter((call) => call.phase === "agent3");
  assert.equal(verificationCalls.length, 2);
  assert.match(verificationCalls[1].prompt, /主题题族必须是 confirmed 且考查动作兼容/);
  assert.match(verificationCalls[1].prompt, /题族范围锚点不要求等于题目核心知识/);
  assert.match(verificationCalls[1].prompt, /若仍无法满足，改为 create_new 并填写完整候选草稿/);
  assert.match(verificationCalls[1].prompt, /reference 贡献必须为空/);

  const tasks = scenario.aiTaskStore.list({ sceneId: "knowledge_batch_verification", limit: 10 });
  const primaryTask = tasks.find((task) => task.inputSummary.attemptKind === "primary");
  const repairTask = tasks.find((task) => task.inputSummary.attemptKind === "contract_repair");
  assert.equal(primaryTask.errorCode, "knowledge_classification_agent3_join_core_mismatch");
  assert.equal(repairTask.status, "succeeded");
  assert.equal(repairTask.inputSummary.parentTaskId, primaryTask.id);
});

test("Agent 3 retries an incompatible family twice, preserves knowledge, and degrades the family decision", async (context) => {
  let verificationCalls = 0;
  const stores = buildStores();
  const incompatibleFamily = stores.questionFamilyStore.create({
    subjectId: "modern-chinese",
    bookId,
    name: "清浊概念识别",
    knowledgeNodeId: "voicing",
    knowledgePath: "语音 > 辅音与声母 > 辅音的发音方法 > 看声带是否振动",
    coreKnowledgeNodeId: "voicing",
    requiredKnowledgeNodeIds: ["voicing"],
    textbookAnchorNodeIds: ["voicing"],
    assessmentAction: "概念识别",
  });
  stores.questionFamilyStore.review(incompatibleFamily.id, { status: "confirmed", members: [{ questionId: "classification-q2", isPrimary: true, role: "prototype", trainingLevel: "foundation", action: "概念识别", confidence: 1, reason: "测试样题" }] }, "测试审核员");
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.map((message) => String(message.content || "")).join("\n");
      let content;
      if (prompt.includes("只负责独立提取题目特征")) {
        content = {
          questionId: "classification-q1",
          featureProfile: {
            optionKnowledgeProtocolVersion: "option-knowledge-v2",
            choiceStructure: "direct_options",
            questionMode: "stem_direct",
            stemKeywords: ["阻碍方式"],
            coreKeywords: ["阻碍方式"],
            stemKnowledgeHints: ["阻碍方式"],
            optionFeatures: [{ key: "A", keywords: ["塞音"], knowledgeRelation: "question_only", knowledgeHints: [], isCorrect: true, role: "answer", weight: 0.7, decisionRole: "supports_answer", requiredForDecision: true, basis: "题目层规则足以直接作答" }, { key: "B", keywords: ["擦音"], knowledgeRelation: "question_only", knowledgeHints: [], isCorrect: false, role: "distractor", weight: 0.3, decisionRole: "required_for_elimination", requiredForDecision: true, basis: "题目层规则足以排除" }],
            primaryKnowledgeHints: ["阻碍方式"],
            secondaryKnowledgeHints: [],
            dependencySteps: [{ order: 1, label: "判断阻碍方式", source: "stem", necessity: "core", dependencyRole: "independent_required", coveredByStepRef: "", basis: "直接决定答案" }],
            knowledgePriorities: [{ label: "阻碍方式", role: "primary", weight: 1, basis: "题干直接询问" }],
            primaryBasis: "题干直接询问阻碍方式。",
            crossFamilyProbability: 0,
            callDepth: 1,
          },
        };
      } else if (prompt.includes("只负责读取 Agent 1 已持久化")) {
        const candidates = JSON.parse(prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/)[1]);
        const preferred = ["phonetics", "consonants", "method", "obstruction"].find((id) => candidates.some((candidate) => candidate.id === id));
        content = {
          questionId: "classification-q1",
          decision: "node",
          selectedNodeIds: [preferred || candidates[0].id],
          corePathStatus: "core_path_viable",
          auxiliaryGap: null,
          candidateRejections: [],
          confidence: 0.95,
          reason: "沿核心路径继续。",
        };
      } else {
        verificationCalls += 1;
        content = { verifications: [{
          questionId: "classification-q1",
          decision: "confirm",
          primaryNodeId: "obstruction",
          requiredNodeIds: ["obstruction"],
          requiredNodeAssessments: [],
          focusKey: "阻碍方式分类",
          focusLabel: "阻碍方式分类",
          action: "分类判断",
          confidence: 0.95,
          reason: "教材证据支持阻碍方式。",
          uncertainty: "",
          evidenceChunkIds: ["chunk-obstruction"],
          familyDecision: "join_existing",
          primaryFamilyId: incompatibleFamily.id,
          relatedFamilyIds: [],
          relatedFamilyAssessments: [],
          matchedFamilyIds: [incompatibleFamily.id],
          duplicateFamilyIds: [],
          familySimilarityReason: "名称看起来接近，但核心节点不同。",
        }] };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ model: "classification-model", choices: [{ message: { content: JSON.stringify(withAgent3OptionRelationAssessments(content, prompt)) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = { id: "classification-provider", name: "分类模拟模型", protocol: "openai_chat_completions", baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "test", models: ["classification-model"], timeoutMs: 5000, supportsJsonMode: true, enabled: true };
  const aiTaskStore = createMemoryAiTaskStore();
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const server = createServer({
    ...stores,
    aiTaskStore,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
    aiConfigStore: createMemoryAiConfigStore({
      providers: [provider],
      routes: {
        knowledge_feature_extraction: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 2200 },
        knowledge_hierarchy_navigation: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 1800 },
        knowledge_batch_verification: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 5000 },
      },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId, questionIds: ["classification-q1"], limit: 1 }) }).then((response) => response.json());
  let job;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    job = (await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${created.job.id}`).then((response) => response.json())).job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.equal(verificationCalls, 2);
  const result = knowledgeClassificationStore.resultForQuestion(job.id, "classification-q1");
  assert.equal(result.status, "pending_review");
  assert.equal(result.agent2Verification.primaryNodeId, "obstruction");
  assert.deepEqual(result.agent2Verification.requiredNodeIds, ["obstruction"]);
  assert.equal(result.agent2Verification.familyDecision, "unresolved");
  assert.equal(result.agent2Verification.primaryFamilyId, "");
  assert.equal(result.agent2Verification.agent3ContractStatus, "failed");
  assert.equal(result.agent2Verification.agent3Diagnostics.at(-1).errorCode, "agent3_family_contract_failed");
  const tasks = aiTaskStore.list({ sceneId: "knowledge_batch_verification", limit: 10 });
  assert.equal(tasks.length, 2);
  assert.equal(tasks.every((task) => task.status === "failed" && task.errorCode === "knowledge_classification_agent3_join_core_mismatch"), true);
});

test("Agent 3 repairs single-node cross-knowledge once then preserves knowledge with an unresolved family", async (context) => {
  let verificationCalls = 0;
  const stores = buildStores();
  const incompatibleFamily = stores.questionFamilyStore.create({
    subjectId: "modern-chinese",
    bookId,
    name: "清浊概念识别",
    knowledgeNodeId: "voicing",
    knowledgePath: "语音 > 辅音与声母 > 辅音的发音方法 > 看声带是否振动",
    coreKnowledgeNodeId: "voicing",
    requiredKnowledgeNodeIds: ["voicing"],
    textbookAnchorNodeIds: ["voicing"],
    assessmentAction: "概念识别",
  });
  stores.questionFamilyStore.review(incompatibleFamily.id, { status: "confirmed", members: [{ questionId: "classification-q2", isPrimary: true, role: "prototype", trainingLevel: "foundation", action: "概念识别", confidence: 1, reason: "测试样题" }] }, "测试审核员");
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.map((message) => String(message.content || "")).join("\n");
      let content;
      if (prompt.includes("只负责独立提取题目特征")) {
        content = {
          questionId: "classification-q1",
          featureProfile: {
            optionKnowledgeProtocolVersion: "option-knowledge-v2",
            choiceStructure: "direct_options",
            questionMode: "stem_direct",
            stemKeywords: ["阻碍方式"],
            coreKeywords: ["阻碍方式"],
            stemKnowledgeHints: ["阻碍方式"],
            optionFeatures: [{ key: "A", keywords: ["塞音"], knowledgeRelation: "question_only", knowledgeHints: [], isCorrect: true, role: "answer", weight: 0.7, decisionRole: "supports_answer", requiredForDecision: true, basis: "题目层规则足以直接作答" }, { key: "B", keywords: ["擦音"], knowledgeRelation: "question_only", knowledgeHints: [], isCorrect: false, role: "distractor", weight: 0.3, decisionRole: "required_for_elimination", requiredForDecision: true, basis: "题目层规则足以排除" }],
            primaryKnowledgeHints: ["阻碍方式"],
            secondaryKnowledgeHints: [],
            dependencySteps: [{ order: 1, label: "判断阻碍方式", source: "stem", necessity: "core", dependencyRole: "independent_required", coveredByStepRef: "", basis: "直接决定答案" }],
            knowledgePriorities: [{ label: "阻碍方式", role: "primary", weight: 1, basis: "题干直接询问" }],
            primaryBasis: "题干直接询问阻碍方式。",
            crossFamilyProbability: 0,
            callDepth: 1,
          },
        };
      } else if (prompt.includes("只负责读取 Agent 1 已持久化")) {
        const candidates = JSON.parse(prompt.match(/当前层候选节点（只能选择其中的 id）：\n([\s\S]*?)\n\n可用控制选项：/)[1]);
        const preferred = ["phonetics", "consonants", "method", "obstruction"].find((id) => candidates.some((candidate) => candidate.id === id));
        content = {
          questionId: "classification-q1",
          decision: "node",
          selectedNodeIds: [preferred || candidates[0].id],
          corePathStatus: "core_path_viable",
          auxiliaryGap: null,
          candidateRejections: [],
          confidence: 0.95,
          reason: "沿核心路径继续。",
        };
      } else {
        verificationCalls += 1;
        content = { verifications: [{
          questionId: "classification-q1",
          decision: "cross_knowledge",
          primaryNodeId: "obstruction",
          requiredNodeIds: ["obstruction"],
          requiredNodeAssessments: [],
          focusKey: "阻碍方式分类",
          focusLabel: "阻碍方式分类",
          action: "分类判断",
          confidence: 0.95,
          reason: "教材证据支持阻碍方式。",
          uncertainty: "",
          evidenceChunkIds: ["chunk-obstruction"],
          familyDecision: "unresolved",
          primaryFamilyId: "",
          relatedFamilyIds: [],
          relatedFamilyAssessments: [],
          matchedFamilyIds: [],
          duplicateFamilyIds: [],
          familySimilarityReason: "名称看起来接近，但核心节点不同。",
        }] };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ model: "classification-model", choices: [{ message: { content: JSON.stringify(withAgent3OptionRelationAssessments(content, prompt)) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = { id: "classification-provider", name: "分类模拟模型", protocol: "openai_chat_completions", baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "test", models: ["classification-model"], timeoutMs: 5000, supportsJsonMode: true, enabled: true };
  const aiTaskStore = createMemoryAiTaskStore();
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  const server = createServer({
    ...stores,
    aiTaskStore,
    knowledgeClassificationStore,
    knowledgeClassificationExperienceStore: createMemoryKnowledgeClassificationExperienceStore(),
    knowledgeDossierStore: createMemoryKnowledgeDossierStore(),
    aiConfigStore: createMemoryAiConfigStore({
      providers: [provider],
      routes: {
        knowledge_feature_extraction: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 2200 },
        knowledge_hierarchy_navigation: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 1800 },
        knowledge_batch_verification: { mode: "provider", providerId: provider.id, model: "classification-model", temperature: 0.1, maxTokens: 5000 },
      },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId, questionIds: ["classification-q1"], limit: 1 }) }).then((response) => response.json());
  let job;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    job = (await fetch(`${baseUrl}/api/admin/knowledge-classification/jobs/${created.job.id}`).then((response) => response.json())).job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.equal(verificationCalls, 2);
  const result = knowledgeClassificationStore.resultForQuestion(job.id, "classification-q1");
  assert.equal(result.status, "pending_review");
  assert.equal(result.agent2Verification.primaryNodeId, "obstruction");
  assert.deepEqual(result.agent2Verification.requiredNodeIds, ["obstruction"]);
  assert.equal(result.agent2Verification.familyDecision, "unresolved");
  assert.equal(result.agent2Verification.primaryFamilyId, "");
  assert.equal(result.agent2Verification.agent3ContractStatus, "failed");
  assert.deepEqual(result.agent2Verification.agent3Diagnostics.map((item) => item.status), [
    "contract_invalid",
    "contract_invalid",
    "degraded",
  ]);
  assert.equal(result.agent2Verification.agent3Diagnostics.at(-1).errorCode, "agent3_contract_degraded");
  const tasks = aiTaskStore.list({ sceneId: "knowledge_batch_verification", limit: 10 });
  assert.equal(tasks.length, 2);
  assert.equal(tasks.every((task) => task.status === "failed" && task.errorCode === "knowledge_classification_agent2_cross_knowledge_required"), true);
  const primaryTask = tasks.find((task) => task.inputSummary.attemptKind === "primary");
  const repairTask = tasks.find((task) => task.inputSummary.attemptKind === "contract_repair");
  assert.equal(repairTask.inputSummary.contractAttempt, 2);
  assert.equal(repairTask.inputSummary.parentTaskId, primaryTask.id);
  assert.equal(repairTask.inputSummary.retryOfTaskId, primaryTask.id);
});
