const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAiTaskStore } = require("../apps/api/src/ai-task-store");
const { createMemoryKnowledgeDossierStore } = require("../apps/api/src/knowledge-dossier-store");
const { createMemoryKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createMemoryQuestionFamilyStore } = require("../apps/api/src/question-family-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createServer, isRetryableProviderFailure } = require("./helpers/admin-auth");
const { createMemoryTextbookKnowledgeStore } = require("../apps/api/src/textbook-knowledge-store");

const bookId = "modern-chinese-7-1";

test("HTTP 520-524 provider failures are treated as transient", () => {
  assert.equal(isRetryableProviderFailure(new Error("provider_http_error:HTTP 520")), true);
  assert.equal(isRetryableProviderFailure(new Error("provider_http_error:HTTP 522")), true);
  assert.equal(isRetryableProviderFailure(new Error("provider_http_error:HTTP 524")), true);
});

function verifiedDossier() {
  return {
    bookId,
    canonicalName: "普通话声韵拼合规律",
    definition: "普通话声母和韵母组合时受到的系统性限制。",
    inclusionCriteria: ["直接判断声母和韵母能否拼合"],
    exclusionCriteria: ["只说明音节结构"],
    claims: [{ statement: "舌面音只能与齐齿呼、撮口呼韵母相拼。", evidence: [{ chunkId: "chunk-rules", excerpt: "舌面音只能与齐齿呼、撮口呼韵母相拼。" }] }],
    occurrences: [{ nodeId: "rules", path: "第二章 语音 > 音节 > 声韵拼合规律", role: "defines", chunkIds: ["chunk-rules"] }],
    relations: [],
    verification: {
      evidenceCoverage: 1,
      claimsVerified: true,
      boundaryComplete: true,
      sourceRolesClear: true,
      relationCyclesValid: true,
      conflicts: [],
    },
    status: "boundary_verified",
  };
}

test("knowledge dossier API filters by a selected knowledge-tree branch and requires explicit activation", async (context) => {
  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId,
    catalogNodes: [
      { id: "phonetics", level: 1, title: "第二章 语音", startPage: 20, endPage: 80 },
      { id: "syllable", level: 2, title: "音节", startPage: 55, endPage: 65 },
      { id: "rules", level: 3, title: "声韵拼合规律", startPage: 60, endPage: 62 },
    ],
    outlineNodes: [],
    chunks: [],
    questions: [],
  });
  const knowledgeDossierStore = createMemoryKnowledgeDossierStore();
  const dossier = knowledgeDossierStore.save(verifiedDossier());
  const questionStore = createMemoryQuestionStore([
    { id: "question-1", library: "official", status: "official", bookId, subjectId: "chinese-language", type: "single_choice", stem: "有效原型题", correctAnswer: ["A"], answerSource: "team_verified", answerReviewStatus: "verified" },
    { id: "question-2", library: "official", status: "official", bookId, subjectId: "chinese-language", type: "single_choice", stem: "待审成员题", correctAnswer: ["A"], answerSource: "team_verified", answerReviewStatus: "verified" },
    { id: "question-pending", library: "official", status: "official", bookId, subjectId: "chinese-language", type: "single_choice", stem: "待审关系题", correctAnswer: ["A"], answerSource: "team_verified", answerReviewStatus: "verified" },
    { id: "question-offline", library: "official", status: "offline", bookId, subjectId: "chinese-language", type: "single_choice", stem: "已下线题", correctAnswer: ["A"], answerSource: "team_verified", answerReviewStatus: "verified" },
    { id: "question-merged", library: "official", status: "official", bookId, subjectId: "chinese-language", type: "single_choice", stem: "已合并源题", correctAnswer: ["A"], answerSource: "team_verified", answerReviewStatus: "verified", mergedIntoQuestionId: "question-1" },
  ]);
  const questionFamilyStore = createMemoryQuestionFamilyStore({
    families: [{
      id: "family-rules",
      bookId,
      subjectId: "chinese-language",
      knowledgeNodeId: "syllable",
      coreKnowledgeNodeId: "rules",
      requiredKnowledgeNodeIds: ["rules"],
      textbookAnchorNodeIds: ["syllable", "rules"],
      assessmentAction: "分类判断",
      inclusionBoundary: "直接判断声母和韵母能否拼合",
      exclusionBoundary: "不纳入只判断音节结构的题目",
      name: "声韵拼合判断",
      focusKey: "声韵拼合判断",
      knowledgePath: "第二章 语音 > 音节 > 声韵拼合规律",
      status: "confirmed",
      members: [
        { questionId: "question-1", isPrimary: true, role: "prototype", action: "分类判断", reviewStatus: "confirmed" },
        { questionId: "question-pending", isPrimary: false, role: "similar", action: "待审污染动作", reviewStatus: "pending_fit" },
        { questionId: "question-offline", isPrimary: false, role: "similar", action: "分类判断", reviewStatus: "confirmed" },
        { questionId: "question-merged", isPrimary: false, role: "similar", action: "分类判断", reviewStatus: "confirmed" },
      ],
    }, {
      id: "family-rules-contrast",
      bookId,
      subjectId: "chinese-language",
      knowledgeNodeId: "syllable",
      coreKnowledgeNodeId: "rules",
      requiredKnowledgeNodeIds: ["rules"],
      textbookAnchorNodeIds: ["syllable"],
      assessmentAction: "正误辨析",
      name: "声韵拼合正误辨析",
      focusKey: "声韵拼合正误辨析",
      knowledgePath: "第二章 语音 > 音节 > 声韵拼合规律",
      status: "confirmed",
      members: [{ questionId: "question-1", isPrimary: false, role: "similar", action: "分类判断", reviewStatus: "confirmed" }],
    }, {
      id: "family-rules-action-gap",
      bookId,
      subjectId: "chinese-language",
      knowledgeNodeId: "syllable",
      coreKnowledgeNodeId: "rules",
      requiredKnowledgeNodeIds: ["rules"],
      textbookAnchorNodeIds: ["syllable"],
      inclusionBoundary: "直接判断声韵拼合规律",
      exclusionBoundary: "不纳入音节结构题",
      name: "声韵拼合待补考查动作",
      focusKey: "声韵拼合待补考查动作",
      knowledgePath: "第二章 语音 > 音节 > 声韵拼合规律",
      status: "confirmed",
      members: [{ questionId: "question-2", isPrimary: false, role: "prototype", action: "", reviewStatus: "pending_fit" }],
    }],
    familySets: [{
      id: "family-set-syllable",
      bookId,
      subjectId: "chinese-language",
      knowledgeNodeId: "syllable",
      name: "音节规则",
    }],
    familySetLinks: [{
      id: "family-set-link-rules",
      setId: "family-set-syllable",
      memberType: "family",
      memberId: "family-rules",
    }, {
      id: "family-set-link-rules-contrast",
      setId: "family-set-syllable",
      memberType: "family",
      memberId: "family-rules-contrast",
    }],
  });
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    knowledgeStructureStore,
    knowledgeDossierStore,
    questionFamilyStore,
    questionStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/knowledge-dossiers?bookId=${bookId}&nodeId=phonetics`).then((response) => response.json());
  assert.equal(listing.items.length, 1);
  assert.equal(listing.items[0].canonicalName, dossier.canonicalName);
  assert.equal(listing.items[0].affectedFamilies.find((family) => family.id === "family-rules").memberCount, 4);
  assert.equal(listing.items[0].affectedFamilies.find((family) => family.id === "family-rules").formalMemberCount, 1);
  assert.deepEqual(listing.items[0].affectedFamilies.find((family) => family.id === "family-rules").formalQuestionIds, ["question-1"]);
  assert.deepEqual(listing.items[0].affectedFamilies.find((family) => family.id === "family-rules").memberActions, ["分类判断"]);
  assert.equal(listing.items[0].affectedFamilies.find((family) => family.id === "family-rules").rawMemberActions.includes("待审污染动作"), true);
  assert.equal(listing.items[0].familyCoverage.summary.confirmedFamilyCount, 3);
  assert.equal(listing.items[0].familyCoverage.summary.formallyConsumableFamilyCount, 1);
  assert.equal(listing.items[0].familyCoverage.summary.questionCount, 1);
  assert.equal(listing.items[0].familyCoverage.summary.coveredMethodCount, 1);
  assert.equal(listing.items[0].familyCoverage.summary.familySetCount, 1);
  assert.equal(listing.items[0].familyCoverage.confirmedFamilies[0].coreKnowledge.id, "rules");
  assert.deepEqual(listing.items[0].familyCoverage.confirmedFamilies[0].textbookAnchors.map((anchor) => anchor.id), ["syllable", "rules"]);
  assert.equal(listing.items[0].familyCoverage.familySets[0].id, "family-set-syllable");
  assert.equal(listing.items[0].familyCoverage.familySets[0].familyCount, 1);
  assert.equal(listing.items[0].familyCoverage.familySets[0].questionCount, 1);
  assert.deepEqual(listing.items[0].familyCoverage.coveredMethods.map((method) => method.action), ["分类判断"]);
  assert.equal(listing.items[0].familyCoverage.confirmedFamilies.find((family) => family.id === "family-rules-contrast").formallyConsumable, false);
  assert.equal(listing.items[0].familyCoverage.confirmedFamilies.find((family) => family.id === "family-rules-action-gap").hasConfirmedPrototype, false);
  assert.equal(listing.items[0].familyCoverage.gaps.length, 1);
  assert.equal(listing.items[0].familyCoverage.gaps[0].code, "family_action_unresolved");
  assert.equal(listing.summary.familyCoverageGaps, 1);
  assert.equal(listing.items[0].familyCoverage.risks.find((risk) => risk.familyId === "family-rules").riskCodes.includes("family_boundary_missing"), false);
  assert.equal(listing.items[0].familyCoverage.risks.find((risk) => risk.familyId === "family-rules-contrast").riskCodes.includes("family_boundary_missing"), true);
  assert.equal(listing.items[0].familyCoverage.risks.find((risk) => risk.familyId === "family-rules-contrast").riskCodes.includes("family_action_inconsistent"), true);
  assert.equal(listing.items[0].familyCoverage.risks.find((risk) => risk.familyId === "family-rules-contrast").riskCodes.includes("family_singleton"), true);
  assert.equal(listing.items[0].familyCoverage.risks.every((risk) => risk.riskCodes.includes("active_dossier_evidence_missing")), true);
  assert.equal(listing.relationTargets[0].id, dossier.id);
  assert.equal(listing.treeSummary.dossierCount, 1);
  assert.equal(listing.treeSummary.locatedDossierCount, 1);
  assert.equal(listing.treeSummary.nodeDossierCounts.phonetics, 1);
  assert.equal(listing.treeSummary.nodeDossierCounts.syllable, 1);
  assert.equal(listing.treeSummary.nodeDossierCounts.rules, 1);
  assert.equal(listing.summary.active, 0);

  const reviewDecisions = dossier.reviewDecisions.map((decision) => ({
    ...decision,
    status: "approved",
    evidenceChunkIds: decision.evidenceChunkIds.length ? decision.evidenceChunkIds : ["chunk-rules"],
  }));
  const response = await fetch(`${baseUrl}/api/admin/knowledge-dossiers/${dossier.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "active", reviewDecisions }),
  });
  const activated = await response.json();
  assert.equal(response.status, 200);
  assert.equal(activated.dossier.status, "active");
});

test("admin knowledge dossier workspace exposes compilation, independent verification and pending deltas", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/admin/styles.css"), "utf8");
  assert.match(html, /data-question-library-tab="dossiers"[^>]*>知识档案/);
  assert.match(html, /id="compile-knowledge-dossiers"/);
  assert.match(html, /id="knowledge-dossier-delta-list"/);
  assert.match(script, /function compileKnowledgeDossiers/);
  assert.match(script, /data-dossier-action="verify"/);
  assert.match(script, /data-dossier-review-status="\$\{status\}"/);
  assert.match(script, /knowledge-dossier-advanced/);
  assert.match(script, /knowledgeDossierTreeSummary/);
  assert.match(script, /nodeDossierCounts/);
  assert.match(script, /function knowledgeDossierFamilyCoverageHtml/);
  assert.match(script, /knowledge-dossier-boundary-actions[^\n]*knowledgeDossierReviewDecisionsHtml\(decision, true\)[^\n]*remove-boundary/);
  assert.match(script, /已覆盖考法/);
  assert.match(script, /题库缺口/);
  assert.match(styles, /\.knowledge-dossier-boundary-groups\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.knowledge-dossier-review-unit\[data-boundary-kind\]\s*>\s*textarea\s*\{[^}]*min-height:\s*58px/);
  assert.doesNotMatch(script, /name="structuredData"/);
  assert.match(script, /reviewKnowledgeDossierDelta/);
});

test("knowledge dossier compilation preserves the first provider error and succeeds after a transient retry", async (context) => {
  let attempts = 0;
  const prompts = [];
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      attempts += 1;
      prompts.push(JSON.parse(body).messages.map((message) => String(message.content || "")).join("\n"));
      if (attempts === 1) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({}));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "dossier-model",
        choices: [{ message: { content: JSON.stringify({
          dossiers: [{
            action: "new",
            canonicalName: "现代汉语",
            aliases: [],
            definition: "现代汉民族使用的共同语和方言。",
            inclusionCriteria: ["讨论现代汉民族的共同语或方言"],
            exclusionCriteria: ["古代汉语"],
            claims: [{ statement: "现代汉语包括共同语和方言。", evidence: [{ chunkId: "chunk-overview", excerpt: "现代汉语包括共同语和方言。" }] }],
            occurrences: [{ nodeId: "overview", role: "defines", chunkIds: ["chunk-overview"], excerpt: "现代汉语包括共同语和方言。" }],
            relations: [],
          }],
          warnings: [],
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId,
    catalogNodes: [
      { id: "overview", level: 1, title: "绪论 现代汉语概说", startPage: 1, endPage: 5 },
      { id: "overview-exercise", parentId: "overview", level: 2, title: "思考和练习一", startPage: 8, endPage: 8 },
    ],
    outlineNodes: [],
    chunks: [],
    questions: [],
  });
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([{
    bookId,
    status: "ready",
    pages: [{ pdfPage: 10, printedPage: 1, text: "现代汉语包括共同语和方言。" }],
    chunks: [{
      id: "chunk-overview",
      bookId,
      catalogNodeId: "overview",
      catalogPath: "绪论 现代汉语概说",
      text: "现代汉语包括共同语和方言。",
      retrievalText: "现代汉语包括共同语和方言。",
      printedPageStart: 1,
      printedPageEnd: 1,
      pdfPageStart: 10,
      pdfPageEnd: 10,
      enabled: true,
      retrievalEnabled: true,
    }, {
      id: "chunk-exercise",
      bookId,
      catalogNodeId: "overview-exercise",
      catalogPath: "绪论 现代汉语概说 > 思考和练习一",
      text: "练习题不应进入知识档案编译证据。",
      retrievalText: "练习题不应进入知识档案编译证据。",
      printedPageStart: 8,
      printedPageEnd: 8,
      pdfPageStart: 18,
      pdfPageEnd: 18,
      enabled: true,
      retrievalEnabled: true,
    }],
  }]);
  const aiTaskStore = createMemoryAiTaskStore();
  const provider = {
    id: "dossier-provider",
    name: "档案模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["dossier-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_dossier_compilation: { mode: "provider", providerId: provider.id, model: "dossier-model", temperature: 0.1, maxTokens: 7000 },
    },
  });
  const knowledgeDossierStore = createMemoryKnowledgeDossierStore();
  const server = createServer({
    aiConfigStore,
    aiTaskStore,
    knowledgeStructureStore,
    textbookKnowledgeStore,
    knowledgeDossierStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/knowledge-dossiers/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, nodeId: "overview" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(attempts, 2);
  assert.equal(prompts.every((prompt) => !prompt.includes("练习题不应进入知识档案编译证据")), true);
  assert.equal(payload.dossiers[0].canonicalName, "现代汉语");
  const task = aiTaskStore.list({ sceneId: "knowledge_dossier_compilation", limit: 10 })[0];
  assert.equal(task.inputSummary.retryCount, 1);
  assert.match(task.inputSummary.firstFailure, /HTTP 503/);
});

test("knowledge dossier verification keeps cited evidence while bounding model input and output", async (context) => {
  let upstreamRequest = null;
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      upstreamRequest = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "dossier-model",
        choices: [{ message: { content: JSON.stringify({
          claimChecks: [{ claimId: "claim-rules", supported: true, issue: "", evidenceChunkIds: ["chunk-rules"] }],
          evidenceCoverage: 1,
          claimsVerified: true,
          boundaryComplete: true,
          sourceRolesClear: true,
          relationCyclesValid: true,
          conflicts: [],
          warnings: [],
          verifierNotes: "引用、边界与来源角色均通过核验。",
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const knowledgeStructureStore = createMemoryKnowledgeStructureStore();
  knowledgeStructureStore.generate({
    bookId,
    catalogNodes: [{ id: "rules", level: 1, title: "声韵拼合规律", startPage: 1, endPage: 60 }],
    outlineNodes: [],
    chunks: [],
    questions: [],
  });
  const scopeChunks = Array.from({ length: 40 }, (_, index) => ({
    id: index === 39 ? "chunk-rules" : `chunk-context-${index}`,
    bookId,
    catalogNodeId: "rules",
    catalogPath: "语音 > 音节 > 声韵拼合规律",
    text: index === 39 ? "舌面音只能与齐齿呼、撮口呼韵母相拼。" : `范围上下文 ${index} ${"补充材料".repeat(180)}`,
    retrievalText: index === 39 ? "舌面音只能与齐齿呼、撮口呼韵母相拼。" : `范围上下文 ${index} ${"补充材料".repeat(180)}`,
    printedPageStart: index + 1,
    printedPageEnd: index + 1,
    pdfPageStart: index + 10,
    pdfPageEnd: index + 10,
    enabled: true,
    retrievalEnabled: true,
  }));
  const textbookKnowledgeStore = createMemoryTextbookKnowledgeStore([{
    bookId,
    status: "ready",
    pages: [],
    chunks: scopeChunks,
  }]);
  const provider = {
    id: "dossier-provider",
    name: "档案模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["dossier-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      knowledge_dossier_verification: { mode: "provider", providerId: provider.id, model: "dossier-model", temperature: 0, maxTokens: 16000 },
    },
  });
  const knowledgeDossierStore = createMemoryKnowledgeDossierStore();
  const dossier = knowledgeDossierStore.save({
    ...verifiedDossier(),
    claims: [{
      id: "claim-rules",
      statement: "舌面音只能与齐齿呼、撮口呼韵母相拼。",
      evidence: [{ chunkId: "chunk-rules", excerpt: "舌面音只能与齐齿呼、撮口呼韵母相拼。" }],
    }],
    status: "draft",
    verification: {},
  });
  const server = createServer({
    aiConfigStore,
    knowledgeStructureStore,
    textbookKnowledgeStore,
    knowledgeDossierStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/knowledge-dossiers/${dossier.id}/verify`, { method: "POST" });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.dossier.status, "boundary_verified");
  assert.equal(payload.dossier.verification.claimChecks[0].claimId, "claim-rules");
  assert.equal(payload.dossier.verification.claimChecks[0].supported, true);
  assert.equal(upstreamRequest.max_tokens, 2200);
  assert.equal(upstreamRequest.reasoning_effort, "low");
  const userPrompt = upstreamRequest.messages.find((message) => message.role === "user").content;
  assert.match(userPrompt, /chunk-rules/);
  assert.match(userPrompt, /舌面音只能与齐齿呼、撮口呼韵母相拼/);
  assert.ok(userPrompt.length < 24000, `verification prompt was ${userPrompt.length} characters`);
});
