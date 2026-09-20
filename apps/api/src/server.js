const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { AsyncLocalStorage } = require("node:async_hooks");
const { examProject, subjects, books } = require("../../../packages/domain/catalog");
const { normalizeText, scoreFastSubjectiveAnswer, scoreSubjectiveAnswer } = require("../../miniprogram/utils/subjective-scoring");
const {
  createFileAiConfigStore,
  effectiveSceneLabel,
  normalizeApiKey,
  normalizeProtocol,
  removeProvider,
  sanitizeConfig,
  sceneDefinitions,
  updatePrompt,
  updateRoute,
  updateSceneLabel,
  upsertProvider,
} = require("./ai-config");
const {
  completePromptWithProvider,
  completeVisionPromptWithProvider,
  listProviderModels,
  parseJsonContent,
  renderPromptTemplate,
  scoreWithProvider,
  streamPromptWithProvider,
  testProvider,
} = require("./ai-provider");
const { createFileAiTaskStore, createMemoryAiTaskStore } = require("./ai-task-store");
const { createFileAiScoreCacheStore, createMemoryAiScoreCacheStore } = require("./ai-score-cache-store");
const {
  CARD_ASSISTANCE_SCHEMA_VERSION,
  buildCardAssistanceSource,
  normalizeCardAssistanceOutput,
} = require("./card-assistance");
const { createFileQuestionStore, createMemoryQuestionStore } = require("./question-store");
const { createFileQuestionFamilyStore, createMemoryQuestionFamilyStore } = require("./question-family-store");
const { decorateFamiliesWithDynamicRelations } = require("./question-family-relations");
const {
  buildQuestionFamilyCatalogProjection,
  buildQuestionFamilyCatalogTreeSummary,
  decorateQuestionsWithFamilyCatalogProjection,
} = require("./question-family-catalog-projection");
const { createFileKnowledgeStructureStore, createMemoryKnowledgeStructureStore } = require("./knowledge-structure-store");
const { estimateDifficulty, knowledgeDifficultyProfiles } = require("./question-assessment");
const { createFileQuestionEnrichmentStore, createMemoryQuestionEnrichmentStore, questionEnrichmentNeeds } = require("./question-enrichment-store");
const { createFileKnowledgeClassificationStore, createMemoryKnowledgeClassificationStore } = require("./knowledge-classification-store");
const {
  CORE_KNOWLEDGE_ROLES,
  contentHash,
  createFileClassificationGoldReviewStore,
  createMemoryClassificationGoldReviewStore,
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  normalizeAnswerKnowledge,
  normalizeFamilyGold,
  validateGoldReviewBatchFamilySemantics,
} = require("./classification-gold-review-store");
const {
  OPTION_KNOWLEDGE_PROTOCOL_VERSION,
  extractQuestionClassificationFeatures,
  normalizeFeatureProfile,
  validateFeatureProfileContract,
} = require("./question-classification-features");
const { filterRelatedFamilySuggestions } = require("./classification-verification-policy");
const { actionTextSimilarity } = require("../../../packages/domain/assessment-action-semantics");
const {
  createFileKnowledgeClassificationExperienceStore,
  createMemoryKnowledgeClassificationExperienceStore,
} = require("./knowledge-classification-experience-store");
const {
  createFileKnowledgeDossierStore,
  createMemoryKnowledgeDossierStore,
} = require("./knowledge-dossier-store");
const {
  batchByTerminalNode,
  buildKnowledgeAdjacency,
  controlOptionAvailability,
  directChildCandidates,
  normalizeAgent1Output,
  normalizeAgent1Trajectory,
  normalizeAgent2NavigationOutput,
  isAgent2NavigationContractError,
  isAgent3ContractError,
  normalizeAgent2Output,
  validateAgent3VerificationContract,
  normalizeGlobalRecoveryOutput,
  normalizeCandidateFamilyDraft,
} = require("./knowledge-classification-pipeline");
const { createFileAdminOperationStore, createMemoryAdminOperationStore } = require("./admin-operation-store");
const {
  ROLE_LABELS: ADMIN_ROLE_LABELS,
  SESSION_HOURS: ADMIN_SESSION_HOURS,
  createFileAdminAccountStore,
  createMemoryAdminAccountStore,
} = require("./admin-account-store");
const {
  SCHEMA_VERSION: CLASSIFICATION_COMMIT_SCHEMA_VERSION,
  createFileClassificationCommitStore,
  createMemoryClassificationCommitStore,
  requestHash: classificationCommitRequestHash,
} = require("./classification-commit-store");
const { createClassificationCommitCoordinator } = require("./classification-commit-coordinator");
const { SUGGESTION_SOURCES } = require("./suggestion-lifecycle");
const {
  SCHEMA_VERSION: QUESTION_MERGE_COMMIT_SCHEMA_VERSION,
  createFileQuestionMergeCommitStore,
  createMemoryQuestionMergeCommitStore,
  requestHash: questionMergeCommitRequestHash,
} = require("./question-merge-commit-store");
const { createQuestionMergeCoordinator } = require("./question-merge-coordinator");
const { transformQuestionMerge } = require("./question-merge-transform");
const { createFileModerationStore, createMemoryModerationStore } = require("./moderation-store");
const { auditCatalogNodes, createFileTextbookCatalogStore, createMemoryTextbookCatalogStore, normalizeCatalogPageRanges } = require("./textbook-catalog-store");
const { catalogNodesWithPaths, createFileTextbookKnowledgeStore, createMemoryTextbookKnowledgeStore } = require("./textbook-knowledge-store");
const { formatTextbookEvidence, generatedQuestionSchema, normalizeBodyOcrPages, normalizeGeneratedQuestions, printedPageFromText } = require("./textbook-rag");
const { createFileExamStore, createMemoryExamStore } = require("./exam-store");
const { createFileExamImportStore, createMemoryExamImportStore } = require("./exam-import-store");
const { createFilePackStore, createMemoryPackStore } = require("./pack-store");
const { createFileBillingStore, createMemoryBillingStore } = require("./billing-store");
const { createFileCommunityAssetStore, createMemoryCommunityAssetStore } = require("./community-asset-store");
const { createFileUserAuthStore, createMemoryUserAuthStore } = require("./user-auth-store");
const {
  createFileCommunityInteractionStore,
  createMemoryCommunityInteractionStore,
} = require("./community-interaction-store");
const {
  TYPE_DESCRIPTIONS: RESTRICTION_TYPE_DESCRIPTIONS,
  TYPE_LABELS: RESTRICTION_TYPE_LABELS,
  createFileUserRestrictionStore,
  createMemoryUserRestrictionStore,
} = require("./user-restriction-store");
const { createFileLearningStateStore, createMemoryLearningStateStore } = require("./learning-state-store");
const { createFileAnnouncementStore, createMemoryAnnouncementStore } = require("./announcement-store");
const { catalogPagesForModel, extractPdf, loadPdfFile, loadPdfPagePreview, loadPdfPagePreviewFromPath, localCatalogDraft, renderPdfPageRangeForOcr, renderPdfPagesForOcr, requiresPdfOcr, savePdfFile, tocCatalogDraft } = require("./textbook-pdf");
const { applySequentialObjectiveAnswerSections, applyVerbatimAnswerBlocks, deleteExamSourceFiles, examPagesForModel, extractVerbatimAnswerBlocks, loadExamSourceFile, mergeAnswerRecognitions, mergeExamRecognitions, normalizeExamModelOutput, saveExamSourceFile } = require("./exam-paper-import");
const { deleteExamJobFiles, extractExamDocument, loadExamJobFile, readExamMultipart, saveExamJobFile } = require("./exam-document-import");
const { generateExamExportBundle, persistExamExportBundle, persistExamExportBundleToStorage } = require("./exam-export");
const { createObjectStorageFromEnv, defaultMimeType } = require("./object-storage");
const { parseQuestionImportText } = require("./question-text-import");
const { parseMineruLayout } = require("./mineru-layout");
const { formatMaterialWithMarks, materialMarksForQuestion } = require("./material-mark");
const { groupQuestionUnits } = require("./question-group");
const { catalogNodeForChapter, evidencePageRange, resolveQuestionTextbookContext } = require("./question-textbook-context");

const adminRoot = path.resolve(__dirname, "../../admin");
const MAX_AGENT3_CANDIDATE_KNOWLEDGE_NODES = 16;
const MAX_AUXILIARY_GAP_NODE_MATCHES = 12;
const MAX_AUXILIARY_GAP_SIBLINGS_PER_NODE = 4;
// Agent 3 单次调用的超时上限。原先 75/55/45、总预算 180s，是按更快的旧模型（gpt-5.4-mini）
// 定的；模型目录轮换后替代模型更慢，成熟题族（上下文最大）会精确撞上主尝试上限而整轮失败。
// 历史记录也显示 Agent 3 正常耗时可到 200s 以上，故按 150/120/90、总预算 420s 重新定标。
const AGENT3_PRIMARY_TIMEOUT_MS = 150000;
const AGENT3_FALLBACK_TIMEOUT_MS = 120000;
const AGENT3_CONTRACT_REPAIR_TIMEOUT_MS = 90000;
const AGENT3_TOTAL_BUDGET_MS = 420000;
const AGENT3_CONTEXT_LIMITS = Object.freeze({
  primary: Object.freeze({
    evidenceChunks: 6,
    evidenceExcerptChars: 450,
    evidenceTotalChars: 2200,
    dossiers: 3,
    dossierClaims: 2,
    rules: 2,
    cases: 1,
    // 候选题族上限：原为 6，实测第 5 题（bd667683）的正确族在候选池 13 个里排在第 7 名开外被裁掉，
    // 模型因此完全看不到它。排序分依赖模型选定的知识节点，一旦知识判断偏一点，正确族就会被挤出去，
    // 形成"知识判断错 → 正确族被裁 → 只能新建"的叠加失败。上限提高到 12，使中小候选池不再被截断。
    confirmedFamilies: 12,
    pendingFamilies: 2,
    relatedNodes: 16,
    familySampleChars: 900,
    familySampleCount: 3,
    featureOptions: 8,
    featureDependencySteps: 8,
  }),
  fallback: Object.freeze({
    evidenceChunks: 4,
    evidenceExcerptChars: 450,
    evidenceTotalChars: 1700,
    dossiers: 1,
    dossierClaims: 1,
    rules: 2,
    cases: 1,
    confirmedFamilies: 8,
    pendingFamilies: 1,
    relatedNodes: 12,
    familySampleChars: 600,
    familySampleCount: 2,
    featureOptions: 6,
    featureDependencySteps: 6,
  }),
  repair: Object.freeze({
    evidenceChunks: 2,
    evidenceExcerptChars: 400,
    evidenceTotalChars: 800,
    dossiers: 0,
    dossierClaims: 0,
    rules: 0,
    cases: 0,
    confirmedFamilies: 6,
    pendingFamilies: 1,
    relatedNodes: 10,
    familySampleChars: 400,
    familySampleCount: 2,
    featureOptions: 4,
    featureDependencySteps: 6,
  }),
});

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function mergedQuestionTargetId(question) {
  return String(question?.mergedIntoQuestionId || question?.merge?.targetQuestionId || "").trim();
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mergedQuestionMappings(questionStore) {
  return questionStore.list({ status: "all", includeMergedSources: true }).questions
    .map((question) => ({ sourceQuestionId: String(question.id || ""), targetQuestionId: mergedQuestionTargetId(question) }))
    .filter((mapping) => mapping.sourceQuestionId && mapping.targetQuestionId);
}

function canonicalizeLearningActiveMap(value, mappings, timestampField) {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {};
  mappings.forEach(({ sourceQuestionId, targetQuestionId }) => {
    if (!Object.prototype.hasOwnProperty.call(result, sourceQuestionId)) return;
    const sourceState = result[sourceQuestionId];
    const targetState = result[targetQuestionId];
    const selected = !targetState || Number(sourceState && sourceState[timestampField]) > Number(targetState[timestampField])
      ? cloneJsonValue(sourceState)
      : cloneJsonValue(targetState);
    if (selected && typeof selected === "object" && selected.questionId === sourceQuestionId) selected.questionId = targetQuestionId;
    delete result[sourceQuestionId];
    result[targetQuestionId] = selected;
  });
  return result;
}

function canonicalizeLearningSyncPayload(payload, mappings) {
  return {
    ...(payload && typeof payload === "object" ? payload : {}),
    reviewStates: canonicalizeLearningActiveMap(payload?.reviewStates, mappings, "lastReviewAt"),
    bookmarks: canonicalizeLearningActiveMap(payload?.bookmarks, mappings, "updatedAt"),
  };
}

function knowledgeClassificationQuestionBaseline(fingerprint, familyMembershipRevision = 0) {
  const source = fingerprint && typeof fingerprint === "object" ? fingerprint : {};
  const focus = source.focus && typeof source.focus === "object" ? source.focus : {};
  const primaryNodeRole = CORE_KNOWLEDGE_ROLES.has(String(source.primaryNodeRole || ""))
    ? String(source.primaryNodeRole) : "core";
  const knowledgeFingerprintSignature = classificationCommitRequestHash({
    primaryNodeId: String(source.primaryNodeId || ""),
    primaryNodeRole,
    requiredNodeIds: [...new Set((Array.isArray(source.requiredNodeIds) ? source.requiredNodeIds : []).map(String).filter(Boolean))].sort(),
    problemKnowledgeRangeNodeIds: [...new Set((Array.isArray(source.problemKnowledgeRangeNodeIds)
      ? source.problemKnowledgeRangeNodeIds : []).map(String).filter(Boolean))].sort(),
    knowledgeThemeRangeAnchorNodeId: String(source.knowledgeThemeRangeAnchorNodeId
      || source.scopeAnchorNodeId || ""),
    focus: {
      key: String(focus.key || ""),
      label: String(focus.label || ""),
      action: String(focus.action || ""),
      source: String(focus.source || ""),
      reason: String(focus.reason || ""),
    },
    evidenceChunkIds: [...new Set((Array.isArray(source.evidenceChunkIds) ? source.evidenceChunkIds : []).map(String).filter(Boolean))].sort(),
    source: String(source.source || ""),
  });
  const familyMembershipSignature = classificationCommitRequestHash({
    revision: Math.max(0, Number(familyMembershipRevision) || 0),
  });
  return { knowledgeFingerprintSignature, familyMembershipSignature };
}

function normalizedPrimaryNodeRole(value) {
  const role = String(value || "").trim();
  return CORE_KNOWLEDGE_ROLES.has(role) ? role : "core";
}

function knowledgeScopeAnchorMatchesRequired(nodeMap, scopeAnchorNodeId, requiredNodeIds) {
  const anchorId = String(scopeAnchorNodeId || "");
  return (Array.isArray(requiredNodeIds) ? requiredNodeIds : []).some((nodeId) => {
    let current = nodeMap.get(String(nodeId || ""));
    while (current?.parentId) {
      current = nodeMap.get(current.parentId);
      if (current?.id === anchorId) return true;
    }
    return false;
  });
}

function knowledgeThemeRangeAnchorMatchesRange(nodeMap, anchorNodeId, rangeNodeIds = [], requiredNodeIds = []) {
  const anchorId = String(anchorNodeId || "");
  const candidates = [...new Set([
    ...(Array.isArray(rangeNodeIds) ? rangeNodeIds : []),
    ...(Array.isArray(requiredNodeIds) ? requiredNodeIds : []),
  ].map(String).filter(Boolean))];
  if (!anchorId || !candidates.length) return false;
  return candidates.every((nodeId) => {
    let current = nodeMap.get(nodeId);
    while (current) {
      if (current.id === anchorId) return true;
      current = current.parentId ? nodeMap.get(current.parentId) : null;
    }
    return false;
  });
}

// 一组节点的共同祖先（含节点自身），按从深到浅排列。
// 用于在范围锚点不合法时，直接给出审核员可以采用的候选锚点。
function knowledgeCommonAncestorNodes(nodeMap, nodeIds = []) {
  const candidates = [...new Set((Array.isArray(nodeIds) ? nodeIds : []).map(String).filter(Boolean))];
  if (!candidates.length) return [];
  const chains = candidates.map((nodeId) => {
    const chain = [];
    let current = nodeMap.get(nodeId);
    while (current) {
      chain.push(current);
      current = current.parentId ? nodeMap.get(current.parentId) : null;
    }
    return chain;
  });
  const [first, ...rest] = chains;
  return first.filter((node) => rest.every((chain) => chain.some((item) => item.id === node.id)));
}

function isKnowledgeThemeRangeAnchorNode(node) {
  return Boolean(node && ["chapter", "section", "knowledge"].includes(node.kind));
}

function sendJson(response, status, body, extraHeaders = {}) {
  const serialized = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extraHeaders,
  };
  const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(response.req && response.req.headers["accept-encoding"] || ""));
  if (acceptsGzip && Buffer.byteLength(serialized, "utf8") >= 32 * 1024) {
    headers["Content-Encoding"] = "gzip";
    headers.Vary = "Accept-Encoding";
    response.writeHead(status, headers);
    response.end(zlib.gzipSync(serialized, { level: zlib.constants.Z_BEST_SPEED }));
    return;
  }
  response.writeHead(status, headers);
  response.end(serialized);
}

function readJsonBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) reject(new Error("payload_too_large"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function readBufferBody(request, maxBytes = 150 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new Error("payload_too_large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks, size));
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function bearerToken(request) {
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isLocalMachineAddress(value) {
  const address = String(value || "").replace(/^::ffff:/, "");
  if (!address) return false;
  if (address === "::1" || address.startsWith("127.")) return true;
  // 自调用可能走本机局域网地址（后台通过 IP 访问时），本机网卡地址同样算“自己”。
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (String(entry.address || "").replace(/^::ffff:/, "") === address) return true;
    }
  }
  return false;
}

// 后台权限清单：分三档，**不在任何清单里的后台路径默认只允许超级管理员**。
// 这样新增后台接口不会因为“兜底放行”而悄悄对运营开放；新增业务接口必须显式加进运营白名单。
const SUPER_ADMIN_ONLY_ADMIN_PATHS = [
  "/api/admin/accounts",   // 后台账号管理
  "/api/admin/ai-config",  // 模型供应商与密钥配置（含掩码后的密钥信息）
  "/api/admin/ai/",        // 供应商/模型/场景路由/提示词/连通性测试
  "/api/admin/billing",    // 收费、商品与额度发放
];

// 运营操作员可用的后台业务前缀（内容、题库、考试、审核与限制记录等）。
const OPERATOR_ADMIN_PATHS = [
  "/api/admin/overview",
  "/api/admin/moderation",
  "/api/admin/operation-logs",
  "/api/admin/questions",
  "/api/admin/question-catalog",
  "/api/admin/question-families",
  "/api/admin/question-family-sets",
  "/api/admin/question-family-options",
  "/api/admin/question-enrichment",
  "/api/admin/knowledge-structure",
  "/api/admin/knowledge-dossiers",
  "/api/admin/knowledge-dossier-deltas",
  "/api/admin/knowledge-classification",
  "/api/admin/adjudication",
  "/api/admin/textbooks",
  "/api/admin/exams",
  "/api/admin/packs",
  "/api/admin/announcements",
  "/api/admin/ai-tasks",
  "/api/admin/user-restrictions",
  "/api/admin/community",
];

// 自助接口：登录、退出、看自己、改自己密码。任何已登录管理员都可用（登录本身在闸门之前处理）。
const SELF_SERVICE_ADMIN_PATHS = ["/api/admin/auth/"];

function matchesAdminPrefix(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * 后台路径 → 所需角色。
 * - super_admin：密钥、收费、账号等敏感面；
 * - admin：运营白名单内的业务面；
 * - self：登录/退出/看自己/改自己密码；
 * - unclassified：未登记的新接口，按“默认拒绝”只放行超级管理员。
 */
function adminPermissionForPath(pathname) {
  const path = String(pathname || "");
  if (matchesAdminPrefix(path, SELF_SERVICE_ADMIN_PATHS)) return "self";
  if (matchesAdminPrefix(path, SUPER_ADMIN_ONLY_ADMIN_PATHS)) return "super_admin";
  if (matchesAdminPrefix(path, OPERATOR_ADMIN_PATHS)) return "admin";
  return "unclassified";
}

/**
 * 服务端自调用（试卷导入流水线）的独立授权：进程内随机凭证 + 本机来源 + 限定 /api/admin/exams/ 路径。
 * 三者缺一不可，且该凭证不来自环境变量、不签会话，因此不是免登录后门。
 */
function isInternalServiceRequest({ headerValue, remoteAddress, pathname }, token = INTERNAL_SERVICE_TOKEN) {
  return String(headerValue || "") === String(token)
    && isLocalMachineAddress(remoteAddress)
    && String(pathname || "").startsWith("/api/admin/exams/");
}

// 匿名兜底身份只用于本地/测试：正式环境（NODE_ENV=production）必须显式登录。
function developmentIdentityAllowed() {
  return String(process.env.NODE_ENV || "development").toLowerCase() !== "production";
}

/**
 * 统一解析“这个请求到底是谁”：
 * 有会话就用会话身份；没有会话时，只有在非正式环境才允许显式的 test-user 兜底，否则返回 null 让调用方回 401。
 */
function resolveRequestIdentity(request, declaredUserId, userAuthStore) {
  const session = userAuthStore.authenticate(bearerToken(request));
  if (session) return { userId: session.user.id, user: session.user, authenticated: true };
  const declared = String(declaredUserId || "").trim();
  if (declared && declared !== "test-user") return { userId: "", user: null, authenticated: false };
  if (!developmentIdentityAllowed()) return { userId: "", user: null, authenticated: false };
  return { userId: "test-user", user: null, authenticated: false };
}

async function exchangeWechatCode(code, developmentIdentity = "") {
  const appId = String(process.env.WECHAT_APP_ID || "").trim();
  const appSecret = String(process.env.WECHAT_APP_SECRET || "").trim();
  if (appId && appSecret) {
    const endpoint = new URL("https://api.weixin.qq.com/sns/jscode2session");
    endpoint.searchParams.set("appid", appId);
    endpoint.searchParams.set("secret", appSecret);
    endpoint.searchParams.set("js_code", code);
    endpoint.searchParams.set("grant_type", "authorization_code");
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    const payload = await response.json();
    if (!response.ok || payload.errcode || !payload.openid) throw new Error(`wechat_code_exchange_failed:${payload.errcode || response.status}`);
    return { openid: payload.openid, unionid: payload.unionid || "", authMode: "wechat" };
  }
  if (process.env.NODE_ENV === "production" && process.env.WECHAT_AUTH_MODE !== "mock") {
    throw new Error("wechat_credentials_not_configured");
  }
  const seed = String(developmentIdentity || code || "").trim();
  if (!seed) throw new Error("wechat_code_required");
  return {
    openid: `dev-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`,
    unionid: "",
    authMode: "development",
  };
}

function catalogPayload() {
  return {
    project: examProject,
    subjects: subjects.map((subject) => ({
      ...subject,
      books: books.filter((book) => book.subjectId === subject.id),
    })),
  };
}

function discoveryPayload() {
  return {
    channels: [
      { id: "featured", label: "精选" },
      { id: "course", label: "工具" },
      { id: "material", label: "资料" },
    ],
    products: [
      {
        id: "course-2026-foundation",
        kind: "course",
        kindLabel: "练习工具",
        title: "汉语言文学练习规划与题目包",
        subtitle: "五科九本 · 练习范围与题目建议",
        priceLabel: "¥ 299",
        badge: "筹备中",
        description: "围绕广东专升本考纲梳理练习范围与题目使用建议。",
        accent: "cyan",
      },
      {
        id: "material-literature-map",
        kind: "material",
        kindLabel: "复习资料",
        title: "中国古代文学史朝代脉络图",
        subtitle: "作家、作品、流派与文体一图串联",
        priceLabel: "¥ 19.9",
        badge: "即将上线",
        description: "将先秦至明清的重要作家、作品、流派和文学现象整理为可检索的复习资料。",
        accent: "green",
      },
      {
        id: "material-nine-books",
        kind: "material",
        kindLabel: "题库资料",
        title: "九本教材核心考点与作品速览",
        subtitle: "适合碎片时间查看",
        priceLabel: "¥ 39.9",
        badge: "内测预览",
        description: "按教材目录整理核心概念、作品梗概、经典名句、艺术特色与常见得分点。",
        accent: "amber",
      },
    ],
    entrances: [
      { id: "video", title: "视频讲解", subtitle: "章节要点与题目示范", status: "筹备中", icon: "play" },
      { id: "games", title: "学习营地", subtitle: "作家作品配对、朝代排序与限时挑战", status: "规划中", icon: "game" },
    ],
  };
}

const objectiveQuestionTypes = new Set(["single_choice", "multiple_choice"]);

function chineseCount(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const values = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
  return values[value] || 0;
}

function extractQuestionLiteralEvidence(stem, material) {
  const source = String(material || "");
  if (!source) return [];
  const tokens = [...String(stem || "").matchAll(/[“‘\"']([^”’\"']{1,12})[”’\"']/g)]
    .map((match) => match[1].trim())
    .filter((token, index, all) => token && source.includes(token) && all.indexOf(token) === index);
  return tokens.map((token) => {
    const occurrences = [];
    let fromIndex = 0;
    while (occurrences.length < 20) {
      const index = source.indexOf(token, fromIndex);
      if (index < 0) break;
      occurrences.push({
        ordinal: occurrences.length + 1,
        context: source.slice(Math.max(0, index - 14), Math.min(source.length, index + token.length + 14)).replace(/\s+/g, " "),
      });
      fromIndex = index + token.length;
    }
    const countMatch = String(stem || "").match(new RegExp(`([一二两三四五六七八九十\\d]+)处[“‘\\\"']${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[”’\\\"']`));
    return {
      token,
      expectedCount: countMatch ? chineseCount(countMatch[1]) : 0,
      actualCount: occurrences.length,
      occurrences,
    };
  });
}

function answerContradictsLiteralEvidence(answer, evidence) {
  if (!evidence.some((item) => item.expectedCount > 1 && item.actualCount >= item.expectedCount)) return false;
  return /(?:实际|材料中)?(?:仅|只)(?:有|出现)?一处|实际只出现一处/.test(String(answer || ""));
}

function compactQuestionAnswerVariants(question) {
  const variants = question.answerVariants && typeof question.answerVariants === "object"
    ? question.answerVariants
    : {};
  const defaults = {
    official: ["pdf_answer", "team_verified"].includes(question.answerSource) ? String(question.referenceAnswer || "") : "",
    ai: question.answerSource === "ai_supplement" ? String(question.referenceAnswer || "") : "",
    community: question.answerSource === "community_consensus" ? String(question.referenceAnswer || "") : "",
  };
  const normalized = {
    official: variants.official == null ? defaults.official : String(variants.official),
    ai: variants.ai == null ? defaults.ai : String(variants.ai),
    community: variants.community == null ? defaults.community : String(variants.community),
  };
  return Object.keys(defaults).every((key) => normalized[key] === defaults[key]) ? undefined : normalized;
}

function clientQuestionPayload(question) {
  if (!question) return null;
  const subject = subjects.find((item) => item.id === question.subjectId);
  const book = books.find((item) => item.id === question.bookId);
  const knowledgePoint = question.knowledgePoints && question.knowledgePoints[0] || "未归类知识点";
  const source = [question.sourceLabel, question.sourcePage].filter(Boolean).join(" · ");
  return {
    id: question.id,
    subjectId: question.subjectId,
    bookId: question.bookId,
    type: question.type,
    typeLabel: question.typeLabel,
    stem: question.stem,
    options: question.options,
    correctAnswer: question.correctAnswer,
    referenceAnswer: question.referenceAnswer,
    answerVariants: question.answerVariants,
    hiddenAnswerVariants: Array.isArray(question.hiddenAnswerVariants) ? question.hiddenAnswerVariants : [],
    scoringPoints: question.scoringPoints,
    scoringPolicy: question.scoringPolicy,
    scoringPointStatus: question.scoringPointStatus,
    maxScore: question.maxScore,
    difficultyScore: question.difficultyScore,
    difficultyStars: question.difficultyStars,
    difficultyAssessment: question.difficultyAssessment,
    examTrack: question.examTrack,
    examTags: Array.isArray(question.examTags) ? question.examTags : [],
    frequency: question.frequency,
    material: question.material,
    materialMarks: question.materialMarks,
    materialGroupId: question.materialGroupId,
    questionGroupId: question.questionGroupId,
    questionGroupTitle: question.questionGroupTitle,
    groupOrder: question.groupOrder,
    groupQuestionCount: question.groupQuestionCount,
    groupTotalScore: question.groupTotalScore,
    groupQuestionIds: question.groupQuestionIds,
    isQuestionGroup: question.isQuestionGroup,
    usesSharedMaterial: question.usesSharedMaterial,
    groupNumber: question.groupNumber,
    subNumber: question.subNumber,
    responseMode: question.responseMode,
    annotationText: question.annotationText,
    answerSource: question.answerSource,
    sourceLabel: question.sourceLabel,
    sourcePage: question.sourcePage,
    freePreview: question.freePreview,
    chapter: question.chapter,
    catalogProjection: question.catalogProjection,
    primaryKnowledgePoint: question.primaryKnowledgePoint,
    subKnowledgePoints: question.subKnowledgePoints,
    knowledgeDepthScore: question.knowledgeDepthScore,
    contentObscurityScore: question.contentObscurityScore,
    knowledgePoints: question.knowledgePoints,
    subjectName: subject && subject.name || "",
    bookTitle: book && book.title || "",
    bookVolume: book && book.volume || "",
    chapterId: question.chapter,
    sectionId: knowledgePoint,
    knowledgePoint,
    score: Number(question.maxScore) || 1,
    source,
    breadcrumb: [subject && subject.name, book && `${book.title}${book.volume ? ` · ${book.volume}` : ""}`, question.chapter].filter(Boolean).join(" · "),
    answerMode: objectiveQuestionTypes.has(question.type) ? "choice" : "text",
    answerPlaceholder: "请依据教材作答，可分点说明……",
    answerMaxLength: 2000,
  };
}

function publicClientQuestionPayload(question) {
  const payload = clientQuestionPayload(question);
  if (!payload) return null;
  payload.answerVariants = compactQuestionAnswerVariants(question);
  delete payload.subjectName;
  delete payload.bookTitle;
  delete payload.bookVolume;
  delete payload.chapterId;
  delete payload.sectionId;
  delete payload.knowledgePoint;
  delete payload.source;
  delete payload.breadcrumb;
  delete payload.answerMode;
  delete payload.answerPlaceholder;
  delete payload.answerMaxLength;
  return payload;
}

function publicExamSourceLabel(exam) {
  if (exam.sourceLabel) return String(exam.sourceLabel).trim().slice(0, 120);
  if (exam.origin === "imported") return "用户导入";
  if (exam.kind === "past_paper") return "广东省教育考试院";
  return "薯考平台题库";
}

function publicExamSummary(exam) {
  if (exam.summary) return String(exam.summary).trim().slice(0, 300);
  const description = String(exam.description || "")
    .replace(/项目\s*[：:].*?文件名\s*[：:].*?[。；;]/gu, "")
    .replace(/本试卷共\s*\d+\s*页[，,、]\s*\d+\s*小题[，,、]\s*满分\s*\d+(?:\.\d+)?\s*分[。；;]?/gu, "")
    .replace(/五科九本综合试卷[，,、].*$/gu, "")
    .replace(/当前(?:只输出|仅录入).*$/gu, "")
    .trim();
  if (description) return description.slice(0, 300);
  if (exam.kind === "past_paper") return `${Number(exam.year) || "历年"} 年广东普通专升本汉语言文学学科基础考试真题。`;
  if (exam.origin === "imported") return "由用户上传或从公共题库导入，请在使用前核对题目与答案。";
  return "按照广东普通专升本汉语言文学学科基础考试结构编排。";
}

function publicExamPayload(exam) {
  return {
    id: exam.id,
    title: exam.title,
    description: exam.description,
    sourceLabel: publicExamSourceLabel(exam),
    summary: publicExamSummary(exam),
    kind: exam.kind,
    origin: exam.origin === "imported" ? "imported" : "manual",
    year: exam.year,
    durationMinutes: exam.durationMinutes,
    totalScore: exam.totalScore,
    questionCount: Array.isArray(exam.questionIds) ? exam.questionIds.length : 0,
    freePreviewQuestionCount: exam.freePreviewQuestionCount,
    attempts: Number(exam.attempts) || 0,
    selectionRules: (Array.isArray(exam.selectionRules) ? exam.selectionRules : []).map((rule) => ({
      id: rule.id,
      title: rule.title,
      requiredCount: rule.requiredCount,
      questionIds: rule.questionIds,
      scoringOrder: rule.scoringOrder,
    })),
    updatedAt: exam.updatedAt,
  };
}

function publicQuestionList(questionStore, filters = {}) {
  const library = filters.library === "public" ? "public" : "official";
  const listed = questionStore.list({
    library,
    subjectId: filters.subjectId || "all",
    bookId: filters.bookId || "all",
    chapter: filters.chapter || "all",
    type: filters.type || "all",
    subjectIds: Array.isArray(filters.subjectIds) ? filters.subjectIds : [],
    bookIds: Array.isArray(filters.bookIds) ? filters.bookIds : [],
    difficultyStars: Array.isArray(filters.difficultyStars) ? filters.difficultyStars : [],
    query: filters.query || "",
  }).questions.filter((question) => library === "official"
    ? question.status === "official"
    : ["public", "featured"].includes(question.status));
  const units = groupQuestionUnits(listed);
  const counts = units.reduce((result, unit) => {
    const question = unit.questions[0];
    if (!question) return result;
    result.bySubject[question.subjectId] = (result.bySubject[question.subjectId] || 0) + 1;
    result.byBook[question.bookId] = (result.byBook[question.bookId] || 0) + 1;
    return result;
  }, { bySubject: {}, byBook: {} });
  const revision = listed.reduce((result, question) => ({
    latestUpdatedAt: Math.max(result.latestUpdatedAt, Number(question.updatedAt) || 0),
    versionTotal: result.versionTotal + (Number(question.version) || 0),
  }), { latestUpdatedAt: 0, versionTotal: 0 });
  const version = revision.latestUpdatedAt;
  const etag = `"questions-relative-difficulty-v2-${listed.length}-${version}-${revision.versionTotal}"`;
  return { records: listed, counts, total: units.length, answerItemCount: listed.length, version, etag };
}

function adminOverview(aiConfig = null, aiTaskDashboard = null, questionCounts = null, moderationDashboard = null) {
  const config = aiConfig || { providers: [], routes: {} };
  const todayTasks = aiTaskDashboard && aiTaskDashboard.today;
  const moderation = moderationDashboard || { reports: [], counts: {} };
  return {
    metrics: [
      { label: "指定教材", value: books.length, detail: "均待上传 PDF" },
      { label: "平台题目", value: questionCounts ? questionCounts.official : 0, detail: "已持久化题目" },
      { label: "待人工审核", value: moderation.counts.pending || 0, detail: `${moderation.counts.highRisk || 0} 条高风险内容` },
      {
        label: "今日 AI 调用",
        value: todayTasks ? todayTasks.total : 0,
        detail: todayTasks && todayTasks.total
          ? `成功率 ${todayTasks.successRate}% · ${todayTasks.failed} 次失败`
          : `${config.providers.length} 个模型供应商`,
      },
    ],
    books,
    moderation: moderation.reports.slice(0, 3).map((item) => ({
      id: item.id,
      type: item.source === "system_review" ? "系统初筛" : "用户举报",
      title: item.targetTitle,
      risk: ({ low: "低", medium: "中", high: "高" })[item.risk] || "中",
      age: item.status === "processing" ? "处理中" : "待处理",
    })),
    aiRoutes: sceneDefinitions.map((scene) => {
      const sceneLabel = effectiveSceneLabel(config, scene.id) || scene.label;
      const route = config.routes && config.routes[scene.id];
      const directProvider = route && route.mode === "provider"
        ? config.providers.find((item) => item.id === route.providerId)
        : null;
      const fallbackSceneId = scene.id === "knowledge_feature_extraction" ? "knowledge_hierarchy_navigation" : "";
      const fallbackRoute = !directProvider && fallbackSceneId ? config.routes[fallbackSceneId] : null;
      const fallbackProvider = fallbackRoute && fallbackRoute.mode === "provider"
        ? config.providers.find((item) => item.id === fallbackRoute.providerId)
        : null;
      const provider = directProvider || fallbackProvider;
      const effectiveRoute = directProvider ? route : fallbackRoute;
      if (effectiveRoute && provider) {
        if (fallbackProvider) {
          return { scene: sceneLabel, provider: `复用 ${provider.name}`, model: effectiveRoute.model, fallback: "来自 Agent 2" };
        }
        return { scene: sceneLabel, provider: provider.name, model: effectiveRoute.model, fallback: "失败不扣额度" };
      }
      if (route && route.mode === "local_rule_demo") {
        return { scene: sceneLabel, provider: "本地规则演示", model: "未配置", fallback: "可切换正式模型" };
      }
      if (fallbackSceneId) return { scene: sceneLabel, provider: "等待配置 Agent 2", model: "自动复用", fallback: "Agent 2 配置后生效" };
      return { scene: sceneLabel, provider: "未配置", model: "未配置", fallback: "关闭" };
    }),
  };
}

function aiTaskMetadata(config, sceneId, payload = {}, overrides = {}) {
  const route = config.routes && config.routes[sceneId];
  const provider = route && config.providers.find((item) => item.id === route.providerId);
  return {
    requestId: String(payload.requestId || `${sceneId}-${Date.now()}`),
    sceneId,
    sceneLabel: effectiveSceneLabel(config, sceneId) || overrides.sceneLabel || sceneId,
    providerId: String(overrides.providerId || provider?.id || ""),
    providerName: String(overrides.providerName || provider?.name || ""),
    protocol: String(overrides.protocol || provider?.protocol || ""),
    model: String(overrides.model || (route && route.model) || ""),
    mode: String(overrides.mode || (route && route.mode) || "disabled"),
    streaming: overrides.streaming === true,
    inputSummary: overrides.inputSummary || {},
  };
}

function classificationPromptProfile(prompt, values, componentCounts = {}) {
  const componentChars = Object.fromEntries(Object.entries(values || {}).map(([key, value]) => {
    const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return [key, String(serialized || "").length];
  }));
  const systemPromptChars = String(prompt?.systemPrompt || "").length;
  const userPromptChars = renderPromptTemplate(prompt?.userPromptTemplate || "", values || {}).length;
  return {
    promptChars: systemPromptChars + userPromptChars,
    systemPromptChars,
    userPromptChars,
    componentChars,
    componentCounts,
  };
}

function isRetryableProviderFailure(error) {
  const message = String(error && error.message || error || "").toLowerCase();
  return message === "provider_timeout"
    || message.includes("auth_unavailable")
    || message.includes("provider_http_error:http 502")
    || message.includes("provider_http_error:http 503")
    || message.includes("provider_http_error:http 504")
    || /provider_http_error:http 52[0-4]/.test(message)
    || message.includes("fetch failed")
    || message.includes("econnreset")
    || message.includes("econnrefused");
}

async function completePromptWithTransientRetry(provider, route, prompt, values, onRetry = null, options = {}) {
  const retryDelays = [500, 1500];
  const requestedMaxRetries = Number(options.maxRetries);
  const maxRetries = Number.isInteger(requestedMaxRetries)
    ? Math.min(retryDelays.length, Math.max(0, requestedMaxRetries))
    : retryDelays.length;
  let firstFailure = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const completion = await completePromptWithProvider(provider, route, prompt, values, options);
      return {
        completion,
        retryCount: attempt,
        firstFailure: firstFailure ? String(firstFailure.message || firstFailure) : "",
      };
    } catch (error) {
      if (!firstFailure) firstFailure = error;
      const retryable = isRetryableProviderFailure(error);
      const defaultRetries = String(error && error.message || "") === "provider_timeout" ? 1 : retryDelays.length;
      const retriesAllowed = Math.min(defaultRetries, maxRetries);
      if (!retryable || attempt >= retriesAllowed) throw error;
      if (onRetry) onRetry({ attempt: attempt + 1, error });
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }
  throw firstFailure || new Error("provider_temporarily_unavailable");
}

function subjectiveScoringRoute(route, question, isRescore) {
  const complexQuestion = question && ["appreciation", "essay"].includes(question.type);
  const useReview = isRescore || complexQuestion;
  return {
    ...route,
    model: useReview && route.reviewModel ? route.reviewModel : route.model,
    reasoningEffort: useReview
      ? (route.reviewReasoningEffort || "medium")
      : (route.reasoningEffort || "low"),
    useReview,
  };
}

function scoringCacheKey(question, answer, route, prompt) {
  const value = JSON.stringify({
    questionId: question.id,
    questionVersion: question.version || 1,
    answer: normalizeText(answer),
    providerId: route.providerId || "local",
    model: route.model || route.mode,
    reviewModel: route.reviewModel || "",
    promptVersion: prompt && prompt.version || 1,
    schemaVersion: 2,
  });
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mergeAiUsage(...usages) {
  const values = usages.filter(Boolean);
  if (!values.length) return null;
  return values.reduce((total, usage) => ({
    prompt_tokens: total.prompt_tokens + Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    completion_tokens: total.completion_tokens + Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    total_tokens: total.total_tokens + Number(usage.total_tokens ?? 0),
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
}

function catalogTitleIsCorrupted(value) {
  const title = String(value || "").trim();
  if (!title) return true;
  const withoutPlaceholders = title.replace(/[?？\uFFFD\s:：,，.。()（）\[\]【】|/_-]/g, "");
  return !withoutPlaceholders || title.includes("\uFFFD");
}

function catalogNodesFromModel(raw, options = {}) {
  const source = Array.isArray(raw) ? raw : (raw && (raw.chapters || raw.nodes || raw.catalog || raw.outline));
  if (!Array.isArray(source)) throw new Error("provider_output_format_error");
  const nodes = [];
  let corruptedTitleCount = 0;
  const visit = (node, inheritedLevel = 1) => {
    if (!node || typeof node !== "object") return;
    const title = String(node.title || node.name || node.heading || "").trim();
    if (title && catalogTitleIsCorrupted(title)) corruptedTitleCount += 1;
    if (title && !catalogTitleIsCorrupted(title)) {
      nodes.push({
        level: Math.min(5, Math.max(1, Number(node.level || node.depth) || inheritedLevel)),
        title,
        startPage: Number(node.startPage || node.page || node.pageStart || node.printedPage || node.printed_page || node.page_number) || 1,
        endPage: Number(node.endPage || node.pageEnd || node.startPage || node.page || node.printedPage || node.printed_page || node.page_number) || 1,
        evidence: String(node.evidence || node.excerpt || node.textEvidence || node.sourceText || node.source_text || ""),
        knowledgePoints: Array.isArray(node.knowledgePoints) ? node.knowledgePoints
          : (Array.isArray(node.knowledge_points) ? node.knowledge_points : (Array.isArray(node.points) ? node.points : [])),
      });
    }
    const children = node.children || node.sections || node.subsections || node.entries || node.items || [];
    if (Array.isArray(children)) children.forEach((child) => visit(child, inheritedLevel + 1));
  };
  source.forEach((node) => visit(node, 1));
  if (!nodes.length && options.allowEmpty !== true) {
    throw new Error(corruptedTitleCount ? "provider_output_catalog_titles_corrupted" : "provider_output_format_error");
  }
  return nodes;
}

function mergeCatalogNodes(groups) {
  const merged = [];
  const seen = new Set();
  groups.flat().forEach((node) => {
    const key = `${String(node.title || "").replace(/\s/g, "")}:${Number(node.startPage) || 1}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(node);
    }
  });
  return merged;
}

function normalizeCatalogHierarchy(nodes) {
  const ordinal = "[一二三四五六七八九十百零〇0-9]+";
  const partPattern = new RegExp(`^(?:第${ordinal}[编篇]|[上中下][编篇])`);
  const chapterPattern = new RegExp(`^第${ordinal}章`);
  const sectionPattern = new RegExp(`^第${ordinal}节`);
  const numberedHeadingPattern = new RegExp(`^${ordinal}[、.]`);
  const parenthesizedHeadingPattern = new RegExp(`^[（(]${ordinal}[）)]`);
  const hasPartLevel = nodes.some((node) => partPattern.test(String(node.title || "").replace(/\s/g, "")));
  if (!hasPartLevel) return nodes;
  let insidePart = false;
  let chapterLevel = null;
  let sectionLevel = null;
  return nodes.map((node) => {
    const title = String(node.title || "").replace(/\s/g, "");
    let level = Math.min(4, Math.max(1, Number(node.level) || 1));
    if (/^总绪论/.test(title)) {
      insidePart = false;
      chapterLevel = 1;
      sectionLevel = null;
      level = 1;
    } else if (partPattern.test(title)) {
      insidePart = true;
      chapterLevel = null;
      sectionLevel = null;
      level = 1;
    } else if (chapterPattern.test(title) || (insidePart && /^(绪论|阅读文献|附录)/.test(title))) {
      level = insidePart ? 2 : 1;
      chapterLevel = level;
      sectionLevel = null;
    } else if (sectionPattern.test(title)) {
      level = insidePart ? 3 : 2;
      sectionLevel = level;
    } else if (numberedHeadingPattern.test(title)) {
      level = Math.min(4, (sectionLevel || chapterLevel || (insidePart ? 2 : 1)) + 1);
    } else if (parenthesizedHeadingPattern.test(title)) {
      level = Math.min(4, Math.max(3, (sectionLevel || chapterLevel || 2) + 1));
    } else if (sectionLevel) {
      level = Math.min(4, Math.max(sectionLevel + 1, level));
    } else if (chapterLevel) {
      level = Math.min(4, Math.max(chapterLevel + 1, level));
    } else if (insidePart) {
      level = Math.min(4, Math.max(2, level));
    } else {
      level = Math.min(3, Math.max(2, level));
    }
    return { ...node, level };
  });
}

function catalogNodePageLabel(node) {
  const startPage = Math.max(1, Number(node && node.startPage) || 1);
  const endPage = Math.max(startPage, Number(node && node.endPage) || startPage);
  return endPage === startPage ? String(startPage) : `${startPage}-${endPage}`;
}

function refreshCatalogBackedQuestionPages(questionStore, textbookCatalogStore, bookId) {
  const textbook = textbookCatalogStore.get(bookId);
  const nodes = textbook && textbook.confirmed && textbook.confirmed.nodes || [];
  if (!nodes.length) return { questionsUpdated: 0, pointsUpdated: 0 };
  let questionsUpdated = 0;
  let pointsUpdated = 0;
  questionStore.list({ bookId }).questions.forEach((question) => {
    let changed = false;
    const chapter = String(question.chapter || "").replace(/\s+/g, "");
    const scoringPoints = (question.scoringPoints || []).map((point) => {
      if (point.pageBasis !== "confirmed_catalog") return point;
      const sourceNote = String(point.sourceNote || "").replace(/\s+/g, "");
      const matched = nodes.filter((node) => {
        const title = String(node.title || "").replace(/\s+/g, "");
        return title && (sourceNote.includes(title) || chapter.includes(title));
      }).sort((left, right) => {
        const leftInSource = sourceNote.includes(String(left.title || "").replace(/\s+/g, "")) ? 1 : 0;
        const rightInSource = sourceNote.includes(String(right.title || "").replace(/\s+/g, "")) ? 1 : 0;
        return rightInSource - leftInSource
          || Number(right.level || 0) - Number(left.level || 0)
          || String(right.title || "").length - String(left.title || "").length;
      })[0];
      if (!matched) return point;
      const textbookPage = catalogNodePageLabel(matched);
      if (String(point.textbookPage || "") === textbookPage) return point;
      changed = true;
      pointsUpdated += 1;
      return { ...point, textbookPage };
    });
    if (!changed) return;
    questionStore.update(question.id, {
      scoringPoints,
      changeNote: "已确认教材目录页码范围同步",
    }, "系统目录页码修复");
    questionsUpdated += 1;
  });
  return { questionsUpdated, pointsUpdated };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// 服务端自调用（试卷导入流水线）用的进程内随机凭证：只接受回环地址且限定 /api/admin/exams/ 路径，
// 既不来自环境变量也无法被外部获取，因此不构成免登录后门。
const INTERNAL_SERVICE_HEADER = "x-shukao-internal-service";
const INTERNAL_SERVICE_TOKEN = crypto.randomBytes(32).toString("base64url");

// 每个请求一份的操作人上下文，让 logOperation 记录真实操作人，而不是写死的“超级管理员”。
const adminActorContext = new AsyncLocalStorage();

function requestLocalJson(urlValue, options = {}) {
  const endpoint = new URL(urlValue);
  const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body || ""));
  return new Promise((resolve, reject) => {
    const localRequest = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: options.method || "POST",
      headers: {
        ...(options.headers || {}),
        ...(endpoint.pathname.startsWith("/api/admin/exams/") ? { [INTERNAL_SERVICE_HEADER]: INTERNAL_SERVICE_TOKEN } : {}),
        "Content-Length": body.length,
      },
    }, (localResponse) => {
      const chunks = [];
      localResponse.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      localResponse.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; }
        catch (error) { reject(new Error("local_response_invalid_json")); return; }
        resolve({
          ok: Number(localResponse.statusCode) >= 200 && Number(localResponse.statusCode) < 300,
          status: Number(localResponse.statusCode) || 0,
          payload,
        });
      });
    });
    localRequest.setTimeout(Number(options.timeoutMs) || 20 * 60 * 1000, () => {
      localRequest.destroy(new Error("local_request_timeout"));
    });
    localRequest.on("error", reject);
    localRequest.end(body);
  });
}

async function postLocalFormJson(urlValue, formData, timeoutMs) {
  const encoded = new Response(formData);
  const body = Buffer.from(await encoded.arrayBuffer());
  return requestLocalJson(urlValue, {
    method: "POST",
    headers: { "Content-Type": encoded.headers.get("content-type") },
    body,
    timeoutMs,
  });
}

function explanationContext(config, payload, question, evidenceChunks = []) {
  const userMessage = String(payload.userMessage || "").trim();
  if (!question || !userMessage || userMessage.length > 4000) {
    const error = new Error("invalid_explanation_request");
    error.statusCode = 400;
    throw error;
  }
  const route = config.routes.explanation_chat;
  const provider = route && route.mode === "provider"
    ? config.providers.find((item) => item.id === route.providerId && item.enabled)
    : null;
  if (!provider) {
    const error = new Error("explanation_route_unavailable");
    error.statusCode = 503;
    throw error;
  }
  const simpleObjectiveTypes = new Set(["single_choice", "multiple_choice", "true_false", "fill_blank"]);
  const isSimpleObjective = simpleObjectiveTypes.has(question.type)
    && String(question.material || "").length <= 1200;
  const automaticFastModel = (provider.models || []).find((model) => /^gpt-5\.4-mini(?:-|$)/i.test(model))
    || (provider.models || []).find((model) => /(?:mini|flash|haiku|small|fast)/i.test(model));
  const fastModel = String(route.fastModel || automaticFastModel || "").trim();
  const selectedRoute = {
    ...route,
    model: isSimpleObjective && fastModel ? fastModel : route.model,
    reasoningEffort: route.reasoningEffort || "low",
  };
  const conversationHistory = (Array.isArray(payload.conversationHistory) ? payload.conversationHistory : [])
    .slice(-20)
    .map((message) => ({
      role: message && message.role === "assistant" ? "assistant" : "user",
      text: String((message && message.text) || "").slice(0, 4000),
    }))
    .filter((message) => message.text);
  const questionMaterialMarks = materialMarksForQuestion(question);
  return {
    provider,
    route: selectedRoute,
    prompt: config.prompts.explanation_chat,
    requestId: payload.requestId || `explain-${Date.now()}`,
    basis: evidenceChunks.length ? "教材原文 + AI 整合" : "AI 补充",
    strategy: isSimpleObjective && fastModel ? "fast_objective" : "standard",
    values: {
      question: {
        id: question.id,
        type: question.typeLabel,
        stem: question.stem,
        material: question.material,
        materialMarks: questionMaterialMarks,
        materialWithMarks: formatMaterialWithMarks(question.material, questionMaterialMarks),
        materialMarkInstruction: "涉及原卷线型或加点文字时，只分析 materialWithMarks 中对应的【标记开始】与【标记结束】之间内容。",
        options: question.options || [],
        knowledgePoint: question.knowledgePoint,
        source: question.source,
      },
      referenceAnswer: question.referenceAnswer,
      answerBasis: {
        correctAnswer: question.correctAnswer || [],
        source: question.source,
        userAnswer: String(payload.userAnswer || "未提供").slice(0, 6000),
        result: String(payload.resultLabel || "").slice(0, 500),
      },
      textbookEvidence: formatTextbookEvidence(evidenceChunks, 14000),
      conversationHistory,
      userMessage,
    },
  };
}

function writeStreamEvent(response, event) {
  if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
}

function serveStatic(response, pathname) {
  const relative = pathname === "/admin/" || pathname === "/admin" ? "index.html" : pathname.replace(/^\/admin\//, "");
  const filePath = path.resolve(adminRoot, relative);
  if (!filePath.startsWith(adminRoot)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "asset_not_found" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
}

function createServer(options = {}) {
  const aiConfigStore = options.aiConfigStore || createFileAiConfigStore();
  const aiTaskStore = options.aiTaskStore
    || (options.aiConfigStore
      ? createMemoryAiTaskStore()
      : createFileAiTaskStore(undefined, { recoverInterrupted: options.recoverExamImportJobs === true }));
  const aiScoreCacheStore = options.aiScoreCacheStore
    || (options.aiConfigStore ? createMemoryAiScoreCacheStore() : createFileAiScoreCacheStore());
  const examStore = options.examStore || (options.aiConfigStore ? createMemoryExamStore() : createFileExamStore());
  const questionStore = options.questionStore
    || (options.aiConfigStore ? createMemoryQuestionStore() : createFileQuestionStore());
  const questionFamilyStore = options.questionFamilyStore
    || (options.aiConfigStore ? createMemoryQuestionFamilyStore() : createFileQuestionFamilyStore());
  if (typeof questionStore.setFrequencyPaperProvider === "function") {
    questionStore.setFrequencyPaperProvider(() => examStore.list({ status: "all", kind: "all" }).exams);
  }
  const questionEnrichmentStore = options.questionEnrichmentStore
    || (options.aiConfigStore ? createMemoryQuestionEnrichmentStore() : createFileQuestionEnrichmentStore());
  const knowledgeClassificationStore = options.knowledgeClassificationStore
    || (options.aiConfigStore
      ? createMemoryKnowledgeClassificationStore()
      : createFileKnowledgeClassificationStore(undefined, { recoverInterrupted: false }));
  const classificationGoldReviewStore = options.classificationGoldReviewStore
    || (options.aiConfigStore
      ? createMemoryClassificationGoldReviewStore()
      : createFileClassificationGoldReviewStore());
  const knowledgeClassificationExperienceStore = options.knowledgeClassificationExperienceStore
    || (options.aiConfigStore
      ? createMemoryKnowledgeClassificationExperienceStore()
      : createFileKnowledgeClassificationExperienceStore());
  const knowledgeDossierStore = options.knowledgeDossierStore
    || (options.aiConfigStore
      ? createMemoryKnowledgeDossierStore()
      : createFileKnowledgeDossierStore());
  const operationLogStore = options.operationLogStore
    || (options.aiConfigStore ? createMemoryAdminOperationStore() : createFileAdminOperationStore());
  const adminAccountStore = options.adminAccountStore
    || (options.aiConfigStore ? createMemoryAdminAccountStore() : createFileAdminAccountStore());
  const moderationStore = options.moderationStore
    || (options.aiConfigStore ? createMemoryModerationStore() : createFileModerationStore());
  const textbookCatalogStore = options.textbookCatalogStore
    || (options.aiConfigStore ? createMemoryTextbookCatalogStore() : createFileTextbookCatalogStore());
  const textbookKnowledgeStore = options.textbookKnowledgeStore
    || (options.aiConfigStore ? createMemoryTextbookKnowledgeStore() : createFileTextbookKnowledgeStore());
  const knowledgeStructureStore = options.knowledgeStructureStore
    || (options.aiConfigStore ? createMemoryKnowledgeStructureStore() : createFileKnowledgeStructureStore());
  const classificationCommitStore = options.classificationCommitStore
    || (options.aiConfigStore || options.persistence
      ? createMemoryClassificationCommitStore()
      : createFileClassificationCommitStore());
  const classificationCommitCoordinator = createClassificationCommitCoordinator({
    commitStore: classificationCommitStore,
    knowledgeStructureStore,
    questionFamilyStore,
    knowledgeClassificationExperienceStore,
    knowledgeDossierStore,
    knowledgeClassificationStore,
    operationLogStore,
  });
  const decorateQuestionKnowledgeFingerprint = (question, structureOverride = null) => {
    if (!question) return null;
    const structure = structureOverride || knowledgeStructureStore.get(question.bookId);
    const fingerprint = (structure?.fingerprints || []).find((item) => item.questionId === question.id) || null;
    const confirmedKnowledgeFingerprint = fingerprint?.status === "confirmed" ? fingerprint : null;
    const candidateKnowledgeFingerprint = fingerprint && fingerprint.status !== "confirmed" ? fingerprint : null;
    const fingerprintSignature = fingerprint
      ? knowledgeClassificationQuestionBaseline(fingerprint, 0).knowledgeFingerprintSignature
      : "";
    return {
      ...question,
      knowledgeFingerprint: confirmedKnowledgeFingerprint,
      candidateKnowledgeFingerprint,
      knowledgeFingerprintStatus: confirmedKnowledgeFingerprint ? "confirmed" : (candidateKnowledgeFingerprint ? "suggested" : "missing"),
      knowledgeFingerprintSignature: fingerprintSignature,
    };
  };
  const withQuestionFamilyMemberships = (questions, structureOverride = null) => {
    const items = Array.isArray(questions) ? questions : [];
    const memberships = questionFamilyStore.memberships(items.map((question) => question.id), { status: "all" });
    const structures = new Map();
    return items.map((question) => ({
      ...decorateQuestionKnowledgeFingerprint(question, (() => {
        if (structureOverride && structureOverride.bookId === question.bookId) return structureOverride;
        if (!structures.has(question.bookId)) structures.set(question.bookId, knowledgeStructureStore.get(question.bookId));
        return structures.get(question.bookId);
      })()),
      familyMemberships: memberships[question.id] || [],
    }));
  };
  const questionFamilySetsForBook = (bookId, query = "") => {
    if (typeof questionFamilyStore.listSets !== "function") {
      return { sets: [], summary: { total: 0, rootCount: 0, groupedFamilyCount: 0, ungroupedFamilyCount: 0 } };
    }
    const result = questionFamilyStore.listSets({ bookId, query });
    const structure = knowledgeStructureStore.get(bookId);
    const knowledgeNodeMap = new Map((structure?.nodes || []).map((node) => [node.id, node]));
    const families = questionFamilyStore.list({ bookId, status: "all" }).families;
    const familyMap = new Map(families.map((family) => [family.id, family]));
    const setMap = new Map(result.sets.map((familySet) => [familySet.id, familySet]));
    return {
      ...result,
      sets: result.sets.map((familySet) => ({
        ...familySet,
        knowledgePath: knowledgeNodeMap.get(familySet.knowledgeNodeId)?.path || "",
        items: familySet.items.map((item) => {
          if (item.type === "family") {
            const family = familyMap.get(item.id);
            return {
              ...item,
              name: family?.name || item.id,
              status: family?.status || "",
              knowledgeNodeId: family?.knowledgeNodeId || "",
              knowledgePath: knowledgeNodeMap.get(family?.knowledgeNodeId)?.path || family?.knowledgePath || "",
              memberCount: family?.members?.length || 0,
            };
          }
          const child = setMap.get(item.id);
          return {
            ...item,
            name: child?.name || item.id,
            knowledgeNodeId: child?.knowledgeNodeId || "",
            knowledgePath: knowledgeNodeMap.get(child?.knowledgeNodeId)?.path || "",
            revision: child?.revision || 0,
            familyCount: child?.familyCount || 0,
            setCount: child?.setCount || 0,
            questionCount: child?.questionCount || 0,
          };
        }),
      })),
    };
  };
  const validateQuestionFamilySetScope = ({ bookId, knowledgeNodeId, parentSetId = "", familyIds = [], childSetIds = [] }) => {
    const structure = knowledgeStructureStore.get(bookId);
    if (!structure) throw new Error("knowledge_structure_not_found");
    const node = structure.nodes.find((item) => item.id === String(knowledgeNodeId || ""));
    if (!node) throw new Error("knowledge_node_not_found");
    const allowedNodeIds = knowledgeStructureStore.descendants(bookId, node.id);
    const families = [...new Set((Array.isArray(familyIds) ? familyIds : []).map(String).filter(Boolean))]
      .map((familyId) => questionFamilyStore.get(familyId));
    if (families.some((family) => !family)) throw new Error("question_family_not_found");
    if (families.some((family) => family.bookId !== bookId)) throw new Error("question_family_set_book_mismatch");
    if (families.some((family) => !allowedNodeIds.has(family.knowledgeNodeId))) throw new Error("question_family_set_scope_mismatch");
    const childSets = [...new Set((Array.isArray(childSetIds) ? childSetIds : []).map(String).filter(Boolean))]
      .map((setId) => questionFamilyStore.getSet(setId));
    if (childSets.some((familySet) => !familySet)) throw new Error("question_family_set_not_found");
    if (childSets.some((familySet) => familySet.bookId !== bookId)) throw new Error("question_family_set_book_mismatch");
    if (childSets.some((familySet) => !allowedNodeIds.has(familySet.knowledgeNodeId))) throw new Error("question_family_set_scope_mismatch");
    const parent = parentSetId ? questionFamilyStore.getSet(parentSetId) : null;
    if (parentSetId && !parent) throw new Error("question_family_set_not_found");
    if (parent && parent.bookId !== bookId) throw new Error("question_family_set_book_mismatch");
    if (parent && !knowledgeStructureStore.descendants(bookId, parent.knowledgeNodeId).has(node.id)) {
      throw new Error("question_family_set_scope_mismatch");
    }
    return { structure, node, families, childSets, parent };
  };
  const questionFamilySetErrorStatus = (error) => {
    if (["knowledge_structure_not_found", "knowledge_node_not_found", "question_family_not_found", "question_family_set_not_found", "question_family_set_member_not_found"].includes(error.message)) return 404;
    if ([
      "question_family_set_duplicate",
      "question_family_set_member_already_grouped",
      "question_family_set_member_already_in_subtree",
      "question_family_set_selection_overlap",
      "question_family_set_cycle",
      "question_family_set_depth_exceeded",
      "question_family_set_has_children",
      "question_family_set_revision_conflict",
      "question_family_set_scope_mismatch",
      "question_family_set_members_unchanged",
      "question_family_rejected",
    ].includes(error.message)) return 409;
    return 422;
  };
  const questionFamilyMemberReviewErrorStatus = (error) => {
    if (["question_family_not_found", "question_family_member_not_found"].includes(error.message)) return 404;
    if (["question_family_membership_revision_conflict", "question_family_rejected"].includes(error.message)) return 409;
    return 422;
  };
  const classificationGoldReviewErrorStatus = (error) => {
    if ([
      "classification_gold_review_batch_not_found",
      "classification_gold_review_item_not_found",
    ].includes(error.message)) return 404;
    if ([
      "classification_gold_review_frozen",
      "classification_gold_review_revision_conflict",
      "classification_gold_review_content_first",
      "classification_gold_review_incomplete",
      "classification_gold_review_business_sync_required",
      "classification_gold_review_formal_question_drift",
      "classification_gold_review_formal_knowledge_drift",
      "classification_gold_review_question_version_conflict",
      "classification_gold_review_question_version_not_advanced",
      "classification_gold_snapshot_version_exists",
      "classification_gold_review_prepare_required",
      "classification_gold_review_prepare_token_invalid",
      "classification_gold_review_prepare_expired",
      "classification_gold_review_prepare_stale",
      "classification_gold_review_confirmed_value_changed",
      "classification_gold_review_parent_not_frozen",
      "classification_gold_review_parent_snapshot_hash_mismatch",
      "classification_gold_review_batch_conflict",
      "classification_gold_review_revision_stage_locked",
      "classification_gold_review_formal_family_drift",
      "classification_gold_review_reload_not_required",
      "classification_gold_review_replay_mode_locked",
    ].includes(error.message)) return 409;
    if ([
      "classification_gold_review_result_invalid",
      "classification_gold_review_note_required",
      "classification_gold_review_primary_family_required",
      "classification_gold_review_candidate_family_required",
      "classification_gold_review_candidate_family_incomplete",
      "classification_gold_review_business_correction_required",
      "classification_gold_review_business_evidence_required",
      "classification_gold_review_business_answer_source_invalid",
      "classification_gold_review_knowledge_assignment_invalid",
      "classification_gold_review_knowledge_mismatch",
      "classification_gold_review_question_mismatch",
      "classification_gold_review_human_evidence_required",
      "classification_gold_review_human_evidence_selection_invalid",
      "classification_gold_review_human_knowledge_required",
      "classification_gold_review_scope_anchor_invalid",
      "classification_gold_review_human_option_knowledge_required",
      "classification_gold_review_human_scoring_points_required",
      "classification_gold_snapshot_preparation_corrupt",
      "classification_gold_review_revision_identity_invalid",
      "classification_gold_review_revision_risk_items_invalid",
      "classification_gold_review_formal_family_facts_hash_mismatch",
      "classification_gold_review_reopen_request_invalid",
      "classification_gold_review_family_semantic_invalid",
      "classification_gold_review_replay_mode_invalid",
      "classification_gold_review_replay_mode_conflict",
      "classification_gold_review_replay_mode_correction_required",
      "classification_gold_review_replay_mode_change_reason_required",
    ].includes(error.message)) return 422;
    return Number(error.statusCode) || 500;
  };
  const classificationGoldFormalBaseline = (item) => {
    const questionId = String(item?.questionId || "");
    const formalQuestion = questionStore.get(questionId);
    if (!formalQuestion || Number(formalQuestion.version || 0) !== Number(item?.question?.version || 0)) {
      throw new Error("classification_gold_review_formal_question_drift");
    }
    const expectedAnswer = normalizeAnswerKnowledge(item.answerKnowledge, item.question);
    const formalAnswer = normalizeAnswerKnowledge({}, formalQuestion);
    const answerFields = (answer) => JSON.stringify({
      correctAnswer: answer.correctAnswer,
      referenceAnswer: answer.referenceAnswer,
      answerSource: answer.answerSource,
      answerReviewStatus: answer.answerReviewStatus,
    });
    if (answerFields(expectedAnswer) !== answerFields(formalAnswer)) {
      throw new Error("classification_gold_review_formal_question_drift");
    }
    const structure = knowledgeStructureStore.get(formalQuestion.bookId);
    const fingerprint = (structure?.fingerprints || []).find((entry) => entry.questionId === questionId);
    const expectedPrimaryNodeId = String(expectedAnswer.coreKnowledge?.id || "");
    const expectedPrimaryNodeRole = normalizedPrimaryNodeRole(expectedAnswer.coreKnowledgeRole);
    const expectedRequiredNodeIds = [...new Set((expectedAnswer.requiredKnowledge || [])
      .map((node) => String(node?.id || "")).filter(Boolean))].sort();
    const formalRequiredNodeIds = [...new Set((fingerprint?.requiredNodeIds || []).map(String).filter(Boolean))].sort();
    if (!fingerprint || !expectedPrimaryNodeId || fingerprint.primaryNodeId !== expectedPrimaryNodeId
      || normalizedPrimaryNodeRole(fingerprint.primaryNodeRole) !== expectedPrimaryNodeRole
      || JSON.stringify(formalRequiredNodeIds) !== JSON.stringify(expectedRequiredNodeIds)) {
      throw new Error("classification_gold_review_formal_knowledge_drift");
    }
    return { formalQuestion, structure, fingerprint, expectedAnswer };
  };
  // Formal family snapshots historically stored knowledge IDs only.  The
  // current knowledge tree uses a mixture of catalog-node and outline IDs, so
  // semantic validation needs the stable textbook path as well.  Resolve a
  // node against the live tree without rewriting its submitted/legacy ID.
  const classificationGoldNormalizeKnowledgeLookupText = (input) => String(input || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，。！？；：、“”‘’（）()【】[\]《》<>·…—-]/g, "");
  const classificationGoldKnowledgeResolutionContext = (bookId, structure = null) => {
    const resolvedBookId = String(bookId || "");
    const currentStructure = structure || knowledgeStructureStore.get(resolvedBookId);
    const nodes = Array.isArray(currentStructure?.nodes) ? currentStructure.nodes : [];
    const byId = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const byPath = new Map();
    const byTitle = new Map();
    nodes.forEach((node) => {
      const path = classificationGoldNormalizeKnowledgeLookupText(node.path);
      const title = classificationGoldNormalizeKnowledgeLookupText(node.displayTitle || node.title);
      if (path && !byPath.has(path)) byPath.set(path, node);
      if (title && !byTitle.has(title)) byTitle.set(title, node);
    });
    return { bookId: resolvedBookId, nodes, byId, byPath, byTitle };
  };
  const classificationGoldMaterializeKnowledgeNode = (bookId, value = {}, fallbackNodes = [], options = {}) => {
    const source = value && typeof value === "object" ? value : {};
    const suppliedId = String(source.id || source.nodeId || "").trim();
    const suppliedPath = String(source.path || source.knowledgePath || "").trim();
    const suppliedTitle = String(source.title || source.label || source.displayTitle || "").trim();
    const resolutionContext = options.resolutionContext?.bookId === String(bookId || "")
      ? options.resolutionContext : classificationGoldKnowledgeResolutionContext(bookId);
    const nodes = resolutionContext.nodes;
    const byId = resolutionContext.byId;
    const normalizeText = classificationGoldNormalizeKnowledgeLookupText;
    const normalizedPath = normalizeText(suppliedPath);
    const normalizedTitle = normalizeText(suppliedTitle);
    const sourceAliases = [
      ...(Array.isArray(source.aliasNodeIds) ? source.aliasNodeIds : []),
      ...(Array.isArray(source.aliases) ? source.aliases : []),
    ].map((id) => String(id || "").trim()).filter(Boolean);
    const resolved = [suppliedId, ...sourceAliases]
      .map((id) => byId.get(id))
      .find(Boolean)
      || (normalizedPath ? resolutionContext.byPath.get(normalizedPath) || null : null)
      || (normalizedTitle ? resolutionContext.byTitle.get(normalizedTitle) || null : null)
      || fallbackNodes.find((node) => {
        const candidate = node && typeof node === "object" ? node : {};
        return (suppliedId && [candidate.id, candidate.nodeId, candidate.canonicalNodeId,
          ...(Array.isArray(candidate.aliasNodeIds) ? candidate.aliasNodeIds : [])]
          .map((id) => String(id || "").trim()).includes(suppliedId))
          || (normalizedPath && normalizeText(candidate.path || candidate.knowledgePath) === normalizedPath)
          || (normalizedTitle && normalizeText(candidate.title || candidate.displayTitle || candidate.label) === normalizedTitle);
      })
      || null;
    const id = suppliedId || String(resolved?.id || "").trim();
    const canonicalNodeId = String(source.canonicalNodeId || resolved?.canonicalNodeId || "").trim();
    const aliasNodeIds = [...new Set([
      ...sourceAliases,
      ...(Array.isArray(resolved?.aliasNodeIds) ? resolved.aliasNodeIds : []),
    ].map((nodeId) => String(nodeId || "").trim()).filter(Boolean))];
    const title = suppliedTitle || String(resolved?.displayTitle || resolved?.title || "").trim();
    const path = suppliedPath || String(resolved?.path || "").trim();
    return {
      id,
      canonicalNodeId,
      aliasNodeIds,
      title,
      path,
      ...(resolved?.parentId ? { parentId: String(resolved.parentId) } : (source.parentId
        ? { parentId: String(source.parentId) } : {})),
    };
  };
  const classificationGoldMaterializeKnowledgeNodes = (
    bookId,
    values = [],
    nodeIds = [],
    fallbackNodes = [],
    labels = [],
    options = {},
  ) => {
    const explicit = Array.isArray(values) ? values : [];
    const ids = [...new Set([
      ...(Array.isArray(nodeIds) ? nodeIds : []),
      ...explicit.map((node) => node?.id || node?.nodeId).filter(Boolean),
    ].map((id) => String(id || "").trim()).filter(Boolean))];
    const candidates = [
      ...explicit,
      ...ids.filter((id) => !explicit.some((node) => String(node?.id || node?.nodeId || "") === id))
        .map((id, index) => ({
          id,
          path: String(labels[index] || "").includes(">") ? String(labels[index]) : "",
          title: String(labels[index] || "").includes(">") ? "" : String(labels[index] || ""),
        })),
    ];
    const resolved = [];
    candidates.forEach((candidate) => {
      const node = classificationGoldMaterializeKnowledgeNode(bookId, candidate, fallbackNodes, options);
      if (!node.id && !node.path && !node.title) return;
      const key = `${node.id}|${node.path}|${node.title}`;
      if (resolved.some((entry) => `${entry.id}|${entry.path}|${entry.title}` === key)) return;
      resolved.push(node);
    });
    return resolved.slice(0, 40);
  };
  const classificationGoldItemKnowledgeFallbackNodes = (item = {}) => {
    const answer = item.humanGold?.answerKnowledge || item.answerKnowledge || {};
    return [
      answer.coreKnowledge,
      ...(Array.isArray(answer.requiredKnowledge) ? answer.requiredKnowledge : []),
      ...(Array.isArray(answer.optionKnowledge) ? answer.optionKnowledge : []),
      ...(Array.isArray(answer.scoringPoints) ? answer.scoringPoints : []),
    ].filter((node) => node && typeof node === "object");
  };
  const classificationGoldMaterializeFamily = (family = {}, item = {}, options = {}) => {
    const bookId = String(family.bookId || item.question?.bookId || "");
    const fallbackNodes = classificationGoldItemKnowledgeFallbackNodes(item);
    const coreKnowledge = classificationGoldMaterializeKnowledgeNode(bookId, family.coreKnowledge || {
      id: family.coreKnowledgeNodeId || family.knowledgeNodeId,
      title: family.primaryKnowledgePoint,
      path: family.knowledgePath,
    }, fallbackNodes, options);
    const requiredValues = Array.isArray(family.requiredKnowledge) ? family.requiredKnowledge : [];
    const requiredIds = [...new Set([
      ...(Array.isArray(family.requiredKnowledgeNodeIds) ? family.requiredKnowledgeNodeIds : []),
      ...requiredValues.map((node) => node?.id || node?.nodeId).filter(Boolean),
    ].map((id) => String(id || "").trim()).filter(Boolean))];
    const textbookValues = Array.isArray(family.textbookAnchors) ? family.textbookAnchors : [];
    const textbookIds = [...new Set([
      ...(Array.isArray(family.textbookAnchorNodeIds) ? family.textbookAnchorNodeIds : []),
      ...textbookValues.map((node) => node?.id || node?.nodeId).filter(Boolean),
    ].map((id) => String(id || "").trim()).filter(Boolean))];
    const materializeMember = (member = {}) => {
      const contribution = classificationGoldMaterializeKnowledgeNodes(
        bookId,
        member.contributionKnowledge,
        member.contributionKnowledgeNodeIds,
        fallbackNodes,
        member.contributionKnowledgeLabels,
        options,
      );
      return {
        ...member,
        contributionKnowledgeNodeIds: contribution.map((node) => node.id).filter(Boolean),
        contributionKnowledge: contribution,
      };
    };
    const members = (Array.isArray(family.members) ? family.members : []).map(materializeMember);
    const membership = family.membership && typeof family.membership === "object"
      ? materializeMember(family.membership) : family.membership;
    return {
      ...family,
      coreKnowledge,
      coreKnowledgeNodeId: String(family.coreKnowledgeNodeId || family.knowledgeNodeId || coreKnowledge.id || ""),
      requiredKnowledge: classificationGoldMaterializeKnowledgeNodes(
        bookId,
        requiredValues,
        requiredIds,
        fallbackNodes,
        [],
        options,
      ),
      requiredKnowledgeNodeIds: requiredIds,
      textbookAnchors: classificationGoldMaterializeKnowledgeNodes(
        bookId,
        textbookValues,
        textbookIds,
        fallbackNodes,
        [],
        options,
      ),
      textbookAnchorNodeIds: textbookIds,
      members,
      ...(membership ? { membership } : {}),
    };
  };
  // A formal-family fact is the reviewable, currently usable view of a
  // family.  Pending-fit, offline, and merged questions are deliberately
  // excluded.  Keep this projection shared by the catalog endpoint and the
  // gold-review snapshot code so the hash shown to a reviewer is the hash
  // that submission validation expects.
  const classificationGoldFormalFamilyMemberRecords = (family = {}, questionById = null) => {
    const rawMembers = Array.isArray(family.members) ? family.members : [];
    const memberQuestionIds = rawMembers.map((member) => String(member.questionId || ""));
    const memberQuestions = questionById instanceof Map
      ? memberQuestionIds.map((questionId) => questionById.get(questionId) || null)
      : questionStore.getMany(memberQuestionIds);
    const activeQuestionIdSet = new Set(memberQuestions
      .filter((question) => question.status !== "offline" && !mergedQuestionTargetId(question))
      .map((question) => String(question.id || "")));
    return rawMembers.filter((member) => member.reviewStatus === "confirmed"
      && activeQuestionIdSet.has(String(member.questionId || ""))).map((member) => ({
      // Keep the complete historical contribution payload while taking a
      // formal snapshot. Older family records may carry only a legacy ID,
      // but path/alias/label evidence is needed to resolve that ID against
      // the current knowledge tree without mutating formal family data.
      questionId: String(member.questionId || ""),
      isPrimary: member.isPrimary === true,
      role: member.role,
      trainingLevel: member.trainingLevel,
      action: member.action,
      variationDimensions: member.variationDimensions,
      contributionKnowledgeNodeIds: member.contributionKnowledgeNodeIds,
      contributionKnowledge: member.contributionKnowledge,
      contributionKnowledgeLabels: member.contributionKnowledgeLabels,
      confidence: member.confidence,
      reason: member.reason,
      reviewStatus: member.reviewStatus,
    })).filter((member) => member.questionId);
  };
  const classificationGoldFormalFamilyHashView = (family = {}, item = {}, options = {}) => {
    const members = classificationGoldFormalFamilyMemberRecords(family, options.questionById);
    // The hash must not depend on the review item's answer-knowledge fallback.
    // Catalog responses only have formal family data, while a submitted review
    // item also carries its own knowledge labels. Using that fallback in one
    // path but not the other produced false stale-family errors after refresh.
    const hashItem = {
      question: {
        bookId: String(family.bookId || item?.question?.bookId || ""),
      },
    };
    const resolutionContext = options.resolutionContext
      || classificationGoldKnowledgeResolutionContext(hashItem.question.bookId);
    // Materialize the formal member projection once.  The previous path
    // rebuilt the whole family (core, anchors, and knowledge lookup maps)
    // once per member, which made the editor's catalog request quadratic.
    const materializedFamily = classificationGoldMaterializeFamily({ ...family, members }, hashItem, {
      ...options,
      resolutionContext,
    });
    const materializedMembers = materializedFamily.members;
    const independentMemberQuestionIds = [...new Set(members
      .filter((member) => member.isPrimary).map((member) => member.questionId))];
    return {
      ...materializedFamily,
      memberQuestionIds: [...new Set(materializedMembers.map((member) => member.questionId))],
      independentMemberQuestionIds,
      independentMemberCount: independentMemberQuestionIds.length,
      retainedIndependentMemberQuestionIds: independentMemberQuestionIds,
      members: materializedMembers,
    };
  };
  const classificationGoldRevisionFormalFamilyFacts = (batch) => {
    const questionIds = (batch?.items || []).map((item) => String(item.questionId || "")).filter(Boolean);
    const membershipRevisions = typeof questionFamilyStore.membershipRevisions === "function"
      ? questionFamilyStore.membershipRevisions(questionIds) : {};
    const missingFamilyIdsByQuestion = {};
    const factsByQuestionId = Object.fromEntries((batch?.items || []).map((item) => {
      const questionId = String(item.questionId || "");
      const selectedFamilyIds = [...new Set([
        ...(item.familyGold?.decision === "join_existing" ? [item.familyGold?.primaryFamilyId] : []),
        ...(item.familyGold?.relatedFamilyIds || []),
      ].map(String).filter(Boolean))];
      const facts = selectedFamilyIds.map((familyId) => {
        const family = questionFamilyStore.get(familyId);
        if (!family) {
          (missingFamilyIdsByQuestion[questionId] ||= []).push(familyId);
          return null;
        }
        const rawMembers = Array.isArray(family.members) ? family.members : [];
        const members = classificationGoldFormalFamilyMemberRecords(family);
        const rawMembership = rawMembers.find((member) => String(member.questionId || "") === questionId) || null;
        const membership = members.find((member) => member.questionId === questionId) || rawMembership;
        const materializedMembers = members.map((member) => classificationGoldMaterializeFamily({
          ...family,
          members: [member],
        }, item).members[0]);
        const independentMemberQuestionIds = [...new Set(members
          .filter((member) => member.isPrimary).map((member) => member.questionId))];
        const materializedFamily = classificationGoldMaterializeFamily(family, item);
        return {
          ...materializedFamily,
          memberQuestionIds: [...new Set(materializedMembers.map((member) => member.questionId))],
          independentMemberQuestionIds,
          independentMemberCount: independentMemberQuestionIds.length,
          retainedIndependentMemberQuestionIds: independentMemberQuestionIds
            .filter((memberQuestionId) => memberQuestionId !== questionId),
          members: materializedMembers,
          membership: membership ? {
            questionId,
            isPrimary: membership.isPrimary,
             role: membership.role,
             reviewStatus: membership.reviewStatus,
             contributionKnowledgeNodeIds: membership.contributionKnowledgeNodeIds,
             contributionKnowledge: classificationGoldMaterializeKnowledgeNodes(
               family.bookId || item.question?.bookId,
               membership.contributionKnowledge,
               membership.contributionKnowledgeNodeIds,
               classificationGoldItemKnowledgeFallbackNodes(item),
               membership.contributionKnowledgeLabels,
             ),
             revision: Math.max(0, Number(membershipRevisions[questionId]) || 0),
          } : null,
          provenance: "formal_family_revision_snapshot",
        };
      }).filter(Boolean);
      return [questionId, facts];
    }));
    return {
      factsByQuestionId,
      provenance: {
        source: "question_family_store_revision_snapshot",
        capturedAt: new Date().toISOString(),
        contentSha256: contentHash(factsByQuestionId),
        membershipRevisions,
        missingFamilyIdsByQuestion,
        formalBusinessDataMutated: false,
      },
    };
  };
  const classificationGoldSortedStrings = (values = []) => [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "")).filter(Boolean))].sort();
  const classificationGoldComparableFamilyFact = (value = {}, options = {}) => {
    const family = normalizeFamilyGold({
      replayMode: "mature",
      decision: "join_existing",
      primaryFamilyId: value.id,
      families: [value],
    }).families[0] || {};
    const members = (family.members || []).map((member) => ({
      questionId: member.questionId,
      isPrimary: member.isPrimary,
      role: member.role,
      trainingLevel: member.trainingLevel,
      action: member.action,
      variationDimensions: classificationGoldSortedStrings(member.variationDimensions),
      confidence: member.confidence,
      reason: member.reason,
      reviewStatus: member.reviewStatus,
    })).sort((left, right) => left.questionId.localeCompare(right.questionId)
      || left.role.localeCompare(right.role));
    const membership = options.includeMembership === false || !family.membership ? null : {
      questionId: family.membership.questionId,
      isPrimary: family.membership.isPrimary,
      role: family.membership.role,
      reviewStatus: family.membership.reviewStatus,
      revision: family.membership.revision,
    };
    return {
      identity: { id: family.id, version: family.version },
      status: family.status,
      textbook: {
        bookId: family.bookId,
        textbookAnchorNodeIds: classificationGoldSortedStrings(family.textbookAnchorNodeIds),
      },
      definition: {
        name: family.name,
        focusKey: family.focusKey,
        assessmentAction: family.assessmentAction,
        inclusionBoundary: family.inclusionBoundary,
        exclusionBoundary: family.exclusionBoundary,
      },
      coreKnowledgeNodeId: family.coreKnowledgeNodeId,
      requiredKnowledgeNodeIds: classificationGoldSortedStrings(family.requiredKnowledgeNodeIds),
      memberQuestionIds: classificationGoldSortedStrings(family.memberQuestionIds),
      independentMemberQuestionIds: classificationGoldSortedStrings(family.independentMemberQuestionIds),
      independentMemberCount: family.independentMemberCount,
      members,
      membership,
    };
  };
  const classificationGoldFamilyFactSha256 = (family) => contentHash(
    classificationGoldComparableFamilyFact(family, { includeMembership: false }),
  );
  const classificationGoldFormalFamilyDriftError = (questionId, issues) => {
    const error = new Error("classification_gold_review_formal_family_drift");
    error.details = {
      questionId,
      issueCount: issues.length,
      issues,
    };
    return error;
  };
  const classificationGoldSelectedFamilyIds = (familyGold = {}) => [...new Set([
    ...(familyGold.decision === "join_existing" ? [familyGold.primaryFamilyId] : []),
    ...(familyGold.relatedFamilyIds || []),
  ].map(String).filter(Boolean))];
  // Keep the live formal membership relation separate from the historical
  // family facts embedded in a gold-review draft.  A confirmed family
  // definition can still have a pending member fit review, and a deleted or
  // replaced family can remain in an old draft; neither state should be
  // silently rewritten when the review page is opened.
  const classificationGoldFormalFamilySync = (item) => {
    const questionId = String(item?.questionId || "").trim();
    const rawFamilyGold = item?.humanGold?.familyGold || item?.familyGold || {};
    const draftFamilyIds = classificationGoldSelectedFamilyIds(rawFamilyGold);
    const draftPrimaryFamilyId = rawFamilyGold.decision === "join_existing"
      ? String(rawFamilyGold.primaryFamilyId || "")
      : "";
    if (!questionId) {
      return {
        status: "not_available",
        questionId: "",
        draftFamilyIds,
        currentFamilyIds: [],
        draftPrimaryFamilyId,
        currentPrimaryFamilyId: "",
        currentMemberships: [],
        issues: [],
      };
    }
    const memberships = typeof questionFamilyStore.memberships === "function"
      ? (questionFamilyStore.memberships([questionId], { status: "all" })[questionId] || [])
      : [];
    const currentMemberships = memberships.map((membership) => {
      const family = typeof questionFamilyStore.get === "function"
        ? questionFamilyStore.get(membership.familyId)
        : null;
      return {
        familyId: String(membership.familyId || ""),
        familyName: String(membership.familyName || family?.name || membership.familyId || ""),
        familyStatus: String(membership.familyStatus || family?.status || ""),
        familyVersion: Math.max(0, Number(family?.version || 0)),
        isPrimary: membership.isPrimary === true,
        role: String(membership.role || ""),
        coverageRole: String(membership.coverageRole || ""),
        reviewStatus: String(membership.reviewStatus || ""),
        membershipRevision: Math.max(0, Number(membership.membershipRevision) || 0),
      };
    }).filter((membership) => membership.familyId);
    const currentFamilyIds = [...new Set(currentMemberships.map((membership) => membership.familyId))];
    const currentPrimary = currentMemberships.find((membership) => membership.isPrimary) || null;
    const currentPrimaryFamilyId = currentPrimary?.familyId || "";
    const issues = [];
    draftFamilyIds.filter((familyId) => !currentFamilyIds.includes(familyId)).forEach((familyId) => {
      issues.push({
        code: "draft_family_missing",
        familyId,
        message: "金标草稿引用的题族已不在当前正式题族目录中。",
      });
    });
    currentFamilyIds.filter((familyId) => !draftFamilyIds.includes(familyId)).forEach((familyId) => {
      issues.push({
        code: "current_family_added",
        familyId,
        message: "当前正式题目已加入金标草稿未记录的题族。",
      });
    });
    if (draftPrimaryFamilyId && currentPrimaryFamilyId && draftPrimaryFamilyId !== currentPrimaryFamilyId) {
      issues.push({
        code: "primary_family_changed",
        familyId: currentPrimaryFamilyId,
        expected: draftPrimaryFamilyId,
        actual: currentPrimaryFamilyId,
        message: "当前正式主题族与金标草稿记录的主题族不同。",
      });
    }
    currentMemberships.filter((membership) => membership.reviewStatus !== "confirmed").forEach((membership) => {
      issues.push({
        code: "membership_pending",
        familyId: membership.familyId,
        actual: membership.reviewStatus || "pending_fit",
        message: "当前题目与该正式题族的成员归属仍待审核。",
      });
    });
    currentMemberships.filter((membership) => membership.familyStatus && membership.familyStatus !== "confirmed").forEach((membership) => {
      issues.push({
        code: "family_definition_pending",
        familyId: membership.familyId,
        actual: membership.familyStatus,
        message: "当前正式题族定义尚未确认。",
      });
    });
    return {
      status: issues.length ? "drift" : (draftFamilyIds.length || currentFamilyIds.length ? "synced" : "not_available"),
      questionId,
      draftFamilyIds,
      currentFamilyIds,
      draftPrimaryFamilyId,
      currentPrimaryFamilyId,
      currentMemberships,
      issues,
    };
  };
  // 教材证据卡片要显示"现在"的教材位置：批次里只冻结了 chunkId 和当时的
  // catalogPath 字符串，这里用 chunkId 回正文库取该片段当前的 catalogNodeId /
  // bodyHeadingId，再按知识树现算路径。原字符串仍留在 catalogPath 里，作为
  // "审核时路径"的留痕，避免人工改名或合并后证据卡片停留在旧结构上。
  // 只留 id → 两个节点 id 的稀疏索引，避免把整本正文库的 chunk 正文常驻内存。
  const classificationGoldCurrentChunkIndex = (() => {
    const cache = new Map();
    return (bookId) => {
      if (!cache.has(bookId)) {
        const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: true });
        cache.set(bookId, new Map((knowledge?.chunks || []).map((chunk) => [String(chunk.id), {
          catalogNodeId: String(chunk.catalogNodeId || ""),
          bodyHeadingId: String(chunk.bodyHeadingId || ""),
        }])));
      }
      return cache.get(bookId);
    };
  })();
  const classificationGoldDecorateEvidencePath = (evidence) => {
    if (!evidence || typeof evidence !== "object") return evidence;
    const bookId = String(evidence.bookId || "");
    const chunkId = String(evidence.chunkId || "");
    if (!bookId || !chunkId) return evidence;
    const chunk = classificationGoldCurrentChunkIndex(bookId).get(chunkId);
    if (!chunk) return evidence;
    const byId = classificationGoldKnowledgeResolutionContext(bookId).byId;
    const node = byId.get(chunk.bodyHeadingId) || byId.get(chunk.catalogNodeId);
    const currentCatalogPath = String(node?.path || "");
    if (!currentCatalogPath || currentCatalogPath === evidence.catalogPath) return evidence;
    return { ...evidence, currentCatalogPath };
  };
  const classificationGoldDecorateEvidenceList = (list) => (
    Array.isArray(list) ? list.map(classificationGoldDecorateEvidencePath) : list
  );
  const classificationGoldDecorateItem = (item) => ({
    ...item,
    businessSync: classificationGoldBusinessSyncStatus(item),
    formalFamilySync: classificationGoldFormalFamilySync(item),
    sourceMaterials: item.sourceMaterials
      ? { ...item.sourceMaterials, textbookEvidence: classificationGoldDecorateEvidenceList(item.sourceMaterials.textbookEvidence) }
      : item.sourceMaterials,
    officialBaseline: item.officialBaseline?.answerKnowledge
      ? {
        ...item.officialBaseline,
        answerKnowledge: {
          ...item.officialBaseline.answerKnowledge,
          textbookEvidence: classificationGoldDecorateEvidenceList(item.officialBaseline.answerKnowledge.textbookEvidence),
        },
      }
      : item.officialBaseline,
    humanGold: item.humanGold?.answerKnowledge
      ? {
        ...item.humanGold,
        answerKnowledge: {
          ...item.humanGold.answerKnowledge,
          textbookEvidence: classificationGoldDecorateEvidenceList(item.humanGold.answerKnowledge.textbookEvidence),
        },
      }
      : item.humanGold,
    answerKnowledge: item.answerKnowledge
      ? { ...item.answerKnowledge, textbookEvidence: classificationGoldDecorateEvidenceList(item.answerKnowledge.textbookEvidence) }
      : item.answerKnowledge,
  });
  const classificationGoldFamilyGoldWithFormalFacts = (item, rawFamilyGold = {}, options = {}) => {
    const selectedFamilyIds = classificationGoldSelectedFamilyIds(rawFamilyGold);
    const factSnapshot = classificationGoldRevisionFormalFamilyFacts({
      items: [{
        ...item,
        familyGold: {
          ...rawFamilyGold,
          families: selectedFamilyIds.map((id) => ({ id })),
        },
      }],
    });
    const facts = factSnapshot.factsByQuestionId[item.questionId] || [];
    const factById = new Map(facts.map((family) => [family.id, family]));
    const oldById = new Map((rawFamilyGold.families || [])
      .filter((family) => family?.id).map((family) => [family.id, family]));
    const issues = [];
    selectedFamilyIds.forEach((familyId) => {
      const current = factById.get(familyId);
      const submitted = oldById.get(familyId);
      if (!current) {
        issues.push({
          code: "formal_family_missing",
          familyId,
          field: "identity",
          expected: "current_formal_family",
          actual: "missing",
        });
        return;
      }
      if (!submitted) {
        issues.push({
          code: "submitted_family_fact_missing",
          familyId,
          field: "families",
          expected: familyId,
          actual: "missing",
        });
        return;
      }
      const submittedFactSha256 = String(submitted.formalFactSha256 || submitted.factSha256 || "").toLowerCase();
      if (options.phase === "submission" && submittedFactSha256) {
        // The catalog and the submission guard must hash the same formal
        // projection.  Raw family records may contain pending-fit, offline,
        // or merged members that are intentionally excluded from the
        // reviewable formal fact.
        const currentFormalFamily = typeof questionFamilyStore.get === "function"
          ? questionFamilyStore.get(familyId)
          : null;
        const currentFactSha256 = classificationGoldFamilyFactSha256(
          classificationGoldFormalFamilyHashView(currentFormalFamily || current, item),
        );
        if (submittedFactSha256 !== currentFactSha256) {
          issues.push({
            code: "formal_family_snapshot_stale",
            familyId,
            field: "formalFactSha256",
            expected: currentFactSha256,
            actual: submittedFactSha256,
          });
        }
        return;
      }
      const currentFact = classificationGoldComparableFamilyFact(current);
      const submittedFact = classificationGoldComparableFamilyFact(submitted);
      Object.keys(currentFact).forEach((field) => {
        if (contentHash(currentFact[field]) === contentHash(submittedFact[field])) return;
        issues.push({
          code: `formal_family_${field}_drift`,
          familyId,
          field,
          expected: currentFact[field],
          actual: submittedFact[field],
        });
      });
    });
    if (issues.length) throw classificationGoldFormalFamilyDriftError(item.questionId, issues);
    return {
      familyGold: {
        ...rawFamilyGold,
        families: selectedFamilyIds.map((familyId) => {
          const formalFamily = factById.get(familyId);
          const submittedFamily = oldById.get(familyId) || {};
          const submittedMembership = submittedFamily.membership && typeof submittedFamily.membership === "object"
            ? submittedFamily.membership : {};
          const formalMembership = formalFamily?.membership && typeof formalFamily.membership === "object"
            ? formalFamily.membership : null;
          const hasSubmittedContribution = Object.prototype.hasOwnProperty.call(
            submittedMembership,
            "contributionKnowledgeNodeIds",
          ) || Object.prototype.hasOwnProperty.call(submittedMembership, "contributionKnowledge")
            || Object.prototype.hasOwnProperty.call(submittedFamily, "contributionKnowledgeNodeIds")
            || Object.prototype.hasOwnProperty.call(submittedFamily, "contributionKnowledge");
          const submittedContributionKnowledgeNodeIds = Array.isArray(submittedMembership.contributionKnowledgeNodeIds)
            ? submittedMembership.contributionKnowledgeNodeIds
            : (Array.isArray(submittedFamily.contributionKnowledgeNodeIds)
              ? submittedFamily.contributionKnowledgeNodeIds
              : (Array.isArray(submittedMembership.contributionKnowledge)
                ? submittedMembership.contributionKnowledge.map((node) => node?.id).filter(Boolean)
                : (Array.isArray(submittedFamily.contributionKnowledge)
                  ? submittedFamily.contributionKnowledge.map((node) => node?.id).filter(Boolean)
                  : [])));
          const submittedContributionKnowledge = hasSubmittedContribution
            ? classificationGoldMaterializeKnowledgeNodes(
              submittedFamily.bookId || item.question?.bookId,
              Array.isArray(submittedMembership.contributionKnowledge)
                ? submittedMembership.contributionKnowledge
                : (Array.isArray(submittedFamily.contributionKnowledge)
                  ? submittedFamily.contributionKnowledge : []),
              submittedContributionKnowledgeNodeIds,
              classificationGoldItemKnowledgeFallbackNodes(item),
              Array.isArray(submittedMembership.contributionKnowledgeLabels)
                ? submittedMembership.contributionKnowledgeLabels
                : (Array.isArray(submittedFamily.contributionKnowledgeLabels)
                  ? submittedFamily.contributionKnowledgeLabels : []),
            )
            : [];
          const normalizedSubmittedContributionKnowledgeNodeIds = hasSubmittedContribution
            ? submittedContributionKnowledge.map((node) => node.id).filter(Boolean)
            : submittedContributionKnowledgeNodeIds;
          const membership = formalMembership
            ? (hasSubmittedContribution
              ? {
                ...formalMembership,
                contributionKnowledgeNodeIds: normalizedSubmittedContributionKnowledgeNodeIds,
                contributionKnowledge: submittedContributionKnowledge,
              }
              : formalMembership)
            : (hasSubmittedContribution || Object.keys(submittedMembership).length
              ? {
                ...submittedMembership,
                questionId: submittedMembership.questionId || item.questionId,
                ...(hasSubmittedContribution ? {
                  contributionKnowledgeNodeIds: normalizedSubmittedContributionKnowledgeNodeIds,
                  contributionKnowledge: submittedContributionKnowledge,
                } : {}),
              }
              : null);
          return {
            ...formalFamily,
            ...(membership ? { membership } : {}),
            ...(Object.prototype.hasOwnProperty.call(submittedFamily, "coverageRole")
              ? { coverageRole: submittedFamily.coverageRole } : {}),
            ...(typeof submittedFamily.requiredForAnswer === "boolean"
              ? { requiredForAnswer: submittedFamily.requiredForAnswer } : {}),
          };
        }),
      },
      provenance: factSnapshot.provenance,
    };
  };
  const classificationGoldValidateSubmittedFamily = (batch, item, familyGold, result) => {
    const validation = validateGoldReviewBatchFamilySemantics({
      version: batch.version,
      source: batch.source,
      items: [{
        ...item,
        familyGold,
        humanGold: { ...item.humanGold, familyGold },
        familyReview: { result },
      }],
    }, { questionIds: [item.questionId] });
    if (validation.valid) return validation;
    const error = new Error("classification_gold_review_family_semantic_invalid");
    error.details = {
      issueCount: validation.issueCount,
      questionCount: validation.questionCount,
      issues: validation.issues,
    };
    throw error;
  };
  const classificationGoldFamilyPayloadWithFinalReplayMode = (payload = {}, item = {}, options = {}) => {
    const familyGold = payload.familyGold && typeof payload.familyGold === "object"
      ? payload.familyGold : {};
    const submittedProtocolVersion = String(familyGold.familyKnowledgeProtocolVersion || "").trim();
    if (options.requireCurrentFamilyKnowledgeProtocol === true
      && submittedProtocolVersion
      && submittedProtocolVersion !== FAMILY_KNOWLEDGE_PROTOCOL_VERSION) {
      const error = new Error("classification_gold_review_family_semantic_invalid");
      error.details = {
        issueCount: 1,
        questionCount: 1,
        issues: [{
          questionId: item.questionId,
          order: item.order,
          code: "family_knowledge_protocol_missing",
          label: "题族知识协议待升级",
          message: `当前修订必须使用 ${FAMILY_KNOWLEDGE_PROTOCOL_VERSION}，不能继续按 ${submittedProtocolVersion} 的旧核心知识等值口径提交。`,
          source: "family_semantic_gate_v3",
          requiredStages: ["family"],
          expected: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
          actual: submittedProtocolVersion,
        }],
      };
      throw error;
    }
    const explicitFinalReplayMode = String(payload.finalReplayMode || "").trim();
    const submittedFamilyReplayMode = Object.prototype.hasOwnProperty.call(familyGold, "replayMode")
      ? String(familyGold.replayMode || "").trim() : "";
    const allowedModes = new Set(["mature", "singleton", "unmatched"]);
    const invalidMode = [explicitFinalReplayMode, submittedFamilyReplayMode]
      .find((mode) => mode && !allowedModes.has(mode));
    if (invalidMode) {
      const error = new Error("classification_gold_review_replay_mode_invalid");
      error.details = {
        code: error.message,
        label: "盲测层级无效",
        questionId: item.questionId,
        requestedReplayMode: invalidMode,
      };
      throw error;
    }
    if (explicitFinalReplayMode && submittedFamilyReplayMode
      && explicitFinalReplayMode !== submittedFamilyReplayMode) {
      const error = new Error("classification_gold_review_replay_mode_conflict");
      error.details = {
        code: error.message,
        label: "盲测层级字段互相冲突",
        questionId: item.questionId,
        finalReplayMode: explicitFinalReplayMode,
        familyReplayMode: submittedFamilyReplayMode,
      };
      throw error;
    }
    const finalReplayMode = explicitFinalReplayMode || submittedFamilyReplayMode
      || item.finalReplayMode || item.familyGold?.replayMode || item.sourceMode;
    return {
      ...familyGold,
      ...(options.requireCurrentFamilyKnowledgeProtocol === true ? {
        familyKnowledgeProtocolVersion: FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
      } : {}),
      replayMode: finalReplayMode,
      ...(payload.replayModeChangeReason
        ? { replayModeChangeReason: String(payload.replayModeChangeReason).trim() }
        : {}),
    };
  };
  const classificationGoldBusinessSyncStatus = (item) => {
    const formalQuestion = questionStore.get(String(item?.questionId || ""));
    const versions = {
      formalQuestionVersion: Number(formalQuestion?.version || 0),
      auditQuestionVersion: Number(item?.question?.version || 0),
    };
    try {
      classificationGoldFormalBaseline(item);
      return { status: "synced", ...versions };
    } catch (error) {
      if (error.message === "classification_gold_review_formal_question_drift") {
        return { status: "question_drift", ...versions };
      }
      if (error.message === "classification_gold_review_formal_knowledge_drift") {
        return { status: "knowledge_drift", ...versions };
      }
      throw error;
    }
  };
  const knowledgeDossierEvidenceIsComplete = (dossier) => dossier?.status === "active"
    && dossier.verification?.claimsVerified === true
    && Number(dossier.verification?.evidenceCoverage || 0) >= 1
    && dossier.verification?.boundaryComplete === true
    && dossier.verification?.sourceRolesClear === true
    && (dossier.claims || []).length > 0
    && (dossier.claims || []).every((claim) => (claim.evidence || []).length > 0);
  const knowledgeDossierFamilyContext = (bookId, dossiers = null, families = null) => {
    const structure = knowledgeStructureStore.get(bookId);
    const nodeById = new Map((structure?.nodes || []).map((node) => [node.id, node]));
    const allDossiers = Array.isArray(dossiers) ? dossiers : knowledgeDossierStore.list({ bookId });
    const allFamilies = Array.isArray(families)
      ? families
      : questionFamilyStore.list({ bookId, status: "all" }).families;
    const familyQuestionIds = [...new Set(allFamilies.flatMap((family) => (family.members || [])
      .map((member) => String(member.questionId || "")).filter(Boolean)))];
    const activeQuestionIds = new Set(questionStore.getMany(familyQuestionIds)
      .filter((question) => question && question.status !== "offline" && !mergedQuestionTargetId(question))
      .map((question) => String(question.id || "")));
    const rawFamilySets = questionFamilySetsForBook(bookId).sets || [];
    const familySetById = new Map(rawFamilySets.map((familySet) => [familySet.id, familySet]));
    const familySetPath = (familySet) => {
      const names = [];
      const visited = new Set();
      let current = familySet;
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        names.unshift(current.name || current.id);
        current = current.parentSetId ? familySetById.get(current.parentSetId) : null;
      }
      return names.join(" > ");
    };
    const familySets = rawFamilySets.map((familySet) => ({
      ...familySet,
      setPath: familySetPath(familySet),
    }));
    const activeEvidenceNodeIds = new Set();
    allDossiers.filter(knowledgeDossierEvidenceIsComplete).forEach((dossier) => {
      (dossier.occurrences || []).forEach((occurrence) => {
        if (occurrence.nodeId && nodeById.has(occurrence.nodeId)) activeEvidenceNodeIds.add(occurrence.nodeId);
      });
    });
    return {
      bookId,
      nodeById,
      dossiers: allDossiers,
      families: allFamilies,
      familySets,
      activeEvidenceNodeIds,
      activeQuestionIds,
    };
  };
  const knowledgeDossierNodeView = (nodeId, context) => {
    const node = context.nodeById.get(nodeId);
    return {
      id: nodeId,
      name: node?.displayTitle || node?.title || nodeId,
      path: node?.path || nodeId,
    };
  };
  const questionFamilyBoundaryPresent = (family, kind) => {
    const values = kind === "inclusion"
      ? [family.inclusionCriteria, family.inclusionBoundary, family.inclusionRules]
      : [family.exclusionCriteria, family.exclusionBoundary, family.exclusionRules];
    return values.some((value) => Array.isArray(value)
      ? value.some((item) => String(item || "").trim())
      : Boolean(String(value || "").trim()));
  };
  const knowledgeDossierFamilyView = (family, context) => {
    const members = Array.isArray(family.members) ? family.members : [];
    const formalMembers = family.status === "confirmed"
      ? members.filter((member) => member.reviewStatus === "confirmed"
        && context.activeQuestionIds.has(String(member.questionId || "")))
      : [];
    const formalQuestionIds = [...new Set(formalMembers
      .map((member) => String(member.questionId || "")).filter(Boolean))];
    const hasConfirmedPrototype = formalMembers.some((member) => member.role === "prototype");
    const formallyConsumable = family.status === "confirmed" && hasConfirmedPrototype;
    const rawMemberActions = [...new Set(members.map((member) => String(member.action || "").trim()).filter(Boolean))];
    const memberActions = [...new Set(formalMembers.map((member) => String(member.action || "").trim()).filter(Boolean))];
    const assessmentAction = String(family.assessmentAction || "").trim();
    const actions = assessmentAction ? [assessmentAction] : memberActions;
    const coreKnowledgeNodeId = String(family.coreKnowledgeNodeId || family.knowledgeNodeId || "");
    const requiredKnowledgeNodeIds = [...new Set([
      coreKnowledgeNodeId,
      ...(family.requiredKnowledgeNodeIds || []),
    ].map(String).filter(Boolean))];
    const textbookAnchorNodeIds = [...new Set((family.textbookAnchorNodeIds?.length
      ? family.textbookAnchorNodeIds
      : [family.knowledgeNodeId]).map(String).filter(Boolean))];
    const missingActiveEvidenceNodeIds = requiredKnowledgeNodeIds
      .filter((nodeId) => !context.activeEvidenceNodeIds.has(nodeId));
    const riskCodes = [];
    if (family.status !== "confirmed") riskCodes.push("family_not_confirmed");
    if (!formalMembers.length) riskCodes.push("family_without_members");
    if (formalMembers.length === 1) riskCodes.push("family_singleton");
    if (!assessmentAction) riskCodes.push("family_action_missing");
    if (memberActions.length > 1 || (assessmentAction && memberActions.some((action) => action !== assessmentAction))) {
      riskCodes.push("family_action_inconsistent");
    }
    if (!questionFamilyBoundaryPresent(family, "inclusion") || !questionFamilyBoundaryPresent(family, "exclusion")) {
      riskCodes.push("family_boundary_missing");
    }
    if (missingActiveEvidenceNodeIds.length) riskCodes.push("active_dossier_evidence_missing");
    const familySetIds = context.familySets
      .filter((familySet) => (familySet.descendantFamilyIds || []).includes(family.id))
      .map((familySet) => familySet.id);
    return {
      id: family.id,
      name: family.name,
      status: family.status,
      version: family.version,
      focusKey: family.focusKey,
      knowledgePath: family.knowledgePath,
      assessmentAction,
      memberActions,
      rawMemberActions,
      textbookAnchor: knowledgeDossierNodeView(textbookAnchorNodeIds[0] || family.knowledgeNodeId, context),
      textbookAnchors: textbookAnchorNodeIds.map((nodeId) => knowledgeDossierNodeView(nodeId, context)),
      coreKnowledge: knowledgeDossierNodeView(coreKnowledgeNodeId, context),
      requiredKnowledge: requiredKnowledgeNodeIds.map((nodeId) => knowledgeDossierNodeView(nodeId, context)),
      actions,
      memberCount: members.length,
      rawMemberCount: members.length,
      questionIds: [...new Set(members.map((member) => String(member.questionId || "")).filter(Boolean))],
      formalMemberCount: formalMembers.length,
      formalQuestionIds,
      hasConfirmedPrototype,
      formallyConsumable,
      familySetIds,
      inclusionBoundaryPresent: questionFamilyBoundaryPresent(family, "inclusion"),
      exclusionBoundaryPresent: questionFamilyBoundaryPresent(family, "exclusion"),
      missingActiveEvidenceNodeIds,
      riskCodes,
    };
  };
  const knowledgeDossierFamilyCoverage = (dossier, context) => {
    const occurrenceNodeIds = new Set((dossier?.occurrences || []).map((item) => item.nodeId).filter(Boolean));
    const relatedFamilies = occurrenceNodeIds.size
      ? context.families.filter((family) => [
        family.coreKnowledgeNodeId || family.knowledgeNodeId,
        ...(family.requiredKnowledgeNodeIds || []),
      ].some((nodeId) => occurrenceNodeIds.has(nodeId)))
        .map((family) => knowledgeDossierFamilyView(family, context))
      : [];
    const confirmedFamilies = relatedFamilies.filter((family) => family.status === "confirmed");
    const pendingFamilies = relatedFamilies.filter((family) => family.status !== "confirmed");
    const formallyConsumableFamilies = confirmedFamilies.filter((family) => family.formallyConsumable);
    const formallyConsumableFamilyIds = new Set(formallyConsumableFamilies.map((family) => family.id));
    const formallyConsumableFamilyById = new Map(formallyConsumableFamilies.map((family) => [family.id, family]));
    const familySets = context.familySets.filter((familySet) => (familySet.descendantFamilyIds || [])
      .some((familyId) => formallyConsumableFamilyIds.has(familyId)))
      .map((familySet) => {
        const matchedFamilyIds = (familySet.descendantFamilyIds || [])
          .filter((familyId) => formallyConsumableFamilyIds.has(familyId));
        const questionIds = new Set(matchedFamilyIds.flatMap((familyId) => (
          formallyConsumableFamilyById.get(familyId)?.formalQuestionIds || []
        )));
        return {
          id: familySet.id,
          name: familySet.name,
          setPath: familySet.setPath,
          knowledgePath: familySet.knowledgePath,
          parentSetId: familySet.parentSetId,
          familyCount: matchedFamilyIds.length,
          setCount: familySet.setCount,
          questionCount: questionIds.size,
          matchedFamilyIds,
        };
      });
    const coveredMethodMap = new Map();
    formallyConsumableFamilies.filter((family) => family.actions.length === 1).forEach((family) => {
      const action = family.actions[0];
      const current = coveredMethodMap.get(action) || { action, familyIds: new Set(), questionIds: new Set() };
      current.familyIds.add(family.id);
      family.formalQuestionIds.forEach((questionId) => current.questionIds.add(questionId));
      coveredMethodMap.set(action, current);
    });
    const coveredMethods = [...coveredMethodMap.values()].map((method) => ({
      action: method.action,
      familyIds: [...method.familyIds],
      familyCount: method.familyIds.size,
      questionCount: method.questionIds.size,
    })).sort((left, right) => right.familyCount - left.familyCount || left.action.localeCompare(right.action, "zh-CN"));
    const gaps = [];
    if (!confirmedFamilies.length) {
      gaps.push({
        code: "confirmed_family_missing",
        conceptName: dossier.canonicalName,
        occurrencePaths: [...new Set((dossier.occurrences || []).map((item) => item.path).filter(Boolean))],
      });
    } else {
      confirmedFamilies.filter((family) => family.actions.length !== 1).forEach((family) => {
        gaps.push({ code: "family_action_unresolved", familyId: family.id, familyName: family.name });
      });
    }
    const risks = relatedFamilies.filter((family) => family.riskCodes.length).map((family) => ({
      familyId: family.id,
      familyName: family.name,
      status: family.status,
      riskCodes: family.riskCodes,
      missingActiveEvidenceNodeIds: family.missingActiveEvidenceNodeIds,
    }));
    const questionIds = new Set(formallyConsumableFamilies.flatMap((family) => family.formalQuestionIds));
    return {
      summary: {
        confirmedFamilyCount: confirmedFamilies.length,
        formallyConsumableFamilyCount: formallyConsumableFamilies.length,
        pendingFamilyCount: pendingFamilies.length,
        familySetCount: familySets.length,
        coveredMethodCount: coveredMethods.length,
        questionCount: questionIds.size,
        gapCount: gaps.length,
        riskFamilyCount: risks.length,
      },
      confirmedFamilies,
      pendingFamilies,
      familySets,
      coveredMethods,
      gaps,
      risks,
    };
  };
  const affectedFamiliesForDossier = (dossier, context = null) => {
    const resolvedContext = context || knowledgeDossierFamilyContext(dossier.bookId);
    const coverage = knowledgeDossierFamilyCoverage(dossier, resolvedContext);
    return [...coverage.confirmedFamilies, ...coverage.pendingFamilies];
  };
  const knowledgeDossierTreeSummary = (bookId, dossiers = []) => {
    const structure = bookId && bookId !== "all" ? knowledgeStructureStore.get(bookId) : null;
    const nodes = structure?.nodes || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodeDossierCounts = new Map(nodes.map((node) => [node.id, 0]));
    let locatedDossierCount = 0;
    dossiers.forEach((dossier) => {
      const countedNodeIds = new Set();
      (dossier.occurrences || []).forEach((occurrence) => {
        let node = nodeById.get(occurrence.nodeId);
        const visitedNodeIds = new Set();
        while (node && !visitedNodeIds.has(node.id)) {
          visitedNodeIds.add(node.id);
          countedNodeIds.add(node.id);
          node = node.parentId ? nodeById.get(node.parentId) : null;
        }
      });
      if (countedNodeIds.size) locatedDossierCount += 1;
      countedNodeIds.forEach((nodeId) => {
        nodeDossierCounts.set(nodeId, (nodeDossierCounts.get(nodeId) || 0) + 1);
      });
    });
    return {
      bookId,
      dossierCount: dossiers.length,
      locatedDossierCount,
      nodeDossierCounts: Object.fromEntries(nodeDossierCounts),
    };
  };
  const resolveQuestionFamilyAssignment = (bookId, rawMemberships = []) => {
    const selections = [];
    const seen = new Set();
    (Array.isArray(rawMemberships) ? rawMemberships : []).forEach((membership) => {
      const familyId = String(membership?.familyId || "");
      if (!familyId || seen.has(familyId)) return;
      seen.add(familyId);
      const isPrimary = membership?.isPrimary === true;
      selections.push({
        familyId,
        isPrimary,
        coverageRole: isPrimary
          ? "required"
          : (["required", "reference"].includes(String(membership?.coverageRole || ""))
            ? String(membership.coverageRole) : ""),
        contributionKnowledgeNodeIds: [...new Set((Array.isArray(membership?.contributionKnowledgeNodeIds)
          ? membership.contributionKnowledgeNodeIds : []).map(String).filter(Boolean))],
      });
    });
    if (!selections.length) {
      return { selections };
    }
    if (selections.filter((membership) => membership.isPrimary).length !== 1) throw new Error("question_family_primary_required");
    const families = selections.map((membership) => {
      const family = questionFamilyStore.get(membership.familyId);
      if (!family) throw new Error("question_family_not_found");
      if (family.bookId !== String(bookId || "")) throw new Error("question_family_book_mismatch");
      return family;
    });
    return { selections };
  };
  const questionFamilySensitiveSnapshot = (question = {}) => JSON.stringify({
    subjectId: question.subjectId,
    bookId: question.bookId,
    type: question.type,
    stem: question.stem,
    material: question.material,
    options: question.options,
    correctAnswer: question.correctAnswer,
    referenceAnswer: question.referenceAnswer,
    scoringPoints: question.scoringPoints,
  });
  const markQuestionFamilyMembersPending = (questionIds, reason, actor = currentAdminDisplayName() || "超级管理员") => (
    typeof questionFamilyStore.markPendingForQuestions === "function"
      ? questionFamilyStore.markPendingForQuestions(questionIds, reason, actor)
      : { affectedFamilyIds: [], actor }
  );
  const detachQuestionFamilyMembers = (questionIds, reason, actor = currentAdminDisplayName() || "超级管理员") => (
    typeof questionFamilyStore.detachQuestions === "function"
      ? questionFamilyStore.detachQuestions(questionIds, reason, actor)
      : {
        affectedFamilyIds: [],
        emptiedFamilyIds: [],
        promotedPrototypeMembers: [],
        detachedQuestionIds: [],
        actor,
      }
  );
  const decorateManualQuestionKnowledge = (questions) => {
    const structureByBook = new Map();
    return questions.map((question) => {
      if (!structureByBook.has(question.bookId)) {
        const structure = knowledgeStructureStore.get(question.bookId);
        structureByBook.set(question.bookId, new Map((structure?.fingerprints || []).map((fingerprint) => [fingerprint.questionId, fingerprint])));
      }
      const fingerprint = structureByBook.get(question.bookId).get(question.id);
      if (fingerprint?.status !== "confirmed") return question;
      return {
        ...question,
        chapter: fingerprint.knowledgePath,
        primaryKnowledgePoint: fingerprint.primaryKnowledgePoint,
        knowledgePoints: [fingerprint.primaryKnowledgePoint, ...((fingerprint.requiredNodeIds || [])
          .filter((nodeId) => nodeId !== fingerprint.primaryNodeId)
          .map((nodeId) => knowledgeStructureStore.get(question.bookId)?.nodes?.find((node) => node.id === nodeId)?.displayTitle)
          .filter(Boolean))],
        subKnowledgePoints: fingerprint.knowledgePath.split(" > ").slice(-2),
        knowledgeFingerprint: fingerprint,
      };
    });
  };
  const publicKnowledgeRevision = (questions) => Math.max(0, ...[...new Set(questions.map((question) => question.bookId))]
    .map((bookId) => Number(knowledgeStructureStore.get(bookId)?.updatedAt || 0)));
  const questionFamilyCatalogProjectionForBook = (bookId) => {
    const families = questionFamilyStore.list({ bookId, status: "confirmed" }).families;
    const structure = knowledgeStructureStore.get(bookId);
    const textbook = textbookCatalogStore.get(bookId);
    return buildQuestionFamilyCatalogProjection({
      families,
      knowledgeNodes: structure?.nodes || [],
      catalogNodeIds: textbook?.confirmed?.nodes?.map((node) => node.id) || [],
    });
  };
  const decoratePublicFamilyCatalogProjection = (questions) => {
    const byQuestionId = {};
    const revisionParts = [];
    [...new Set(questions.map((question) => String(question.bookId || "")).filter(Boolean))].forEach((bookId) => {
      const textbook = textbookCatalogStore.get(bookId);
      const projection = questionFamilyCatalogProjectionForBook(bookId);
      Object.assign(byQuestionId, projection.byQuestionId);
      revisionParts.push([
        bookId,
        projection.revision,
        Number(textbook?.confirmed?.version) || 0,
        Number(textbook?.confirmed?.confirmedAt) || 0,
      ].join(":"));
    });
    return {
      questions: decorateQuestionsWithFamilyCatalogProjection(questions, { byQuestionId }),
      revision: crypto.createHash("sha1").update(revisionParts.sort().join("|")).digest("hex").slice(0, 16),
    };
  };
  const examImportStore = options.examImportStore
    || (options.aiConfigStore ? createMemoryExamImportStore() : createFileExamImportStore());
  const packStore = options.packStore || (options.aiConfigStore ? createMemoryPackStore() : createFilePackStore());
  const billingStore = options.billingStore || (options.aiConfigStore ? createMemoryBillingStore() : createFileBillingStore());
  const communityAssetStore = options.communityAssetStore
    || (options.aiConfigStore ? createMemoryCommunityAssetStore() : createFileCommunityAssetStore());
  const userAuthStore = options.userAuthStore
    || (options.aiConfigStore ? createMemoryUserAuthStore() : createFileUserAuthStore());
  const userRestrictionStore = options.userRestrictionStore
    || (options.aiConfigStore ? createMemoryUserRestrictionStore() : createFileUserRestrictionStore());
  const communityInteractionStore = options.communityInteractionStore
    || (options.aiConfigStore ? createMemoryCommunityInteractionStore() : createFileCommunityInteractionStore());
  const learningStateStore = options.learningStateStore
    || (options.aiConfigStore ? createMemoryLearningStateStore() : createFileLearningStateStore());
  const questionMergeCommitStore = options.questionMergeCommitStore
    || (options.aiConfigStore || options.persistence
      ? createMemoryQuestionMergeCommitStore()
      : createFileQuestionMergeCommitStore());
  const questionMergeCoordinator = createQuestionMergeCoordinator({
    commitStore: questionMergeCommitStore,
    questionStore,
    questionFamilyStore,
    knowledgeStructureStore,
    examStore,
    packStore,
    learningStateStore,
    knowledgeClassificationStore,
    questionEnrichmentStore,
    operationLogStore,
  });
  questionMergeCoordinator.recoverPrepared();
  classificationCommitCoordinator.recoverPrepared();
  if (typeof questionStore.backfillDifficultyScores === "function") questionStore.backfillDifficultyScores();
  questionEnrichmentStore.recoverInterrupted();
  knowledgeClassificationStore.recoverInterrupted();
  if (typeof knowledgeDossierStore.recoverInterruptedRuns === "function") knowledgeDossierStore.recoverInterruptedRuns();
  const announcementStore = options.announcementStore
    || (options.aiConfigStore ? createMemoryAnnouncementStore() : createFileAnnouncementStore());
  const examExportRoot = path.resolve(options.examExportRoot || path.resolve(__dirname, "../../../.runtime/exam-exports"));
  const examJobRoot = path.resolve(options.examJobRoot || path.resolve(__dirname, "../../../.runtime/exams/jobs"));
  const examUploadRoot = path.resolve(options.examUploadRoot || path.resolve(__dirname, "../../../.runtime/exams/uploads"));
  const objectStorage = options.objectStorage || null;
  const mirrorObjectStorageLocally = options.objectStorageMirrorLocal === true || process.env.OBJECT_STORAGE_MIRROR_LOCAL === "true";
  const isObjectStorageNotFound = (error) => error && (error.code === "object_storage_file_not_found" || error.status === 404);
  const textbookObjectKey = (bookId) => `textbooks/${bookId}.pdf`;
  const examSourceObjectKey = (importId, role, fileName) => {
    const safeRole = role === "answer" ? "answer" : "paper";
    const extension = path.extname(String(fileName || "")).toLowerCase() === ".docx" ? ".docx" : ".pdf";
    return `exams/uploads/${importId}-${safeRole}${extension}`;
  };
  const examExportObjectKey = (exportId, kind) => `exam-exports/${exportId}/${kind}.pdf`;
  const loadStoredTextbookPdf = async (bookId) => {
    if (!objectStorage) return loadPdfFile(bookId);
    try { return await objectStorage.getBuffer(textbookObjectKey(bookId)); }
    catch (error) { if (!isObjectStorageNotFound(error)) throw error; return loadPdfFile(bookId); }
  };
  const saveStoredTextbookPdf = async (bookId, buffer, fileName) => {
    if (!objectStorage) return savePdfFile(bookId, buffer);
    const saved = await objectStorage.put(textbookObjectKey(bookId), {
      buffer,
      fileName: fileName || `${bookId}.pdf`,
      mimeType: "application/pdf",
      metadata: { category: "textbook", bookId },
    });
    if (mirrorObjectStorageLocally) savePdfFile(bookId, buffer);
    return saved;
  };
  const loadStoredTextbookPreview = async (bookId, page) => {
    if (!objectStorage || typeof objectStorage.materialize !== "function") return loadPdfPagePreview(bookId, page);
    try {
      const pdfPath = await objectStorage.materialize(textbookObjectKey(bookId));
      return await loadPdfPagePreviewFromPath(pdfPath, bookId, page);
    } catch (error) {
      if (!isObjectStorageNotFound(error)) throw error;
      return loadPdfPagePreview(bookId, page);
    }
  };
  const saveStoredExamSourceFile = async (importId, role, fileName, buffer) => {
    if (!objectStorage) return saveExamSourceFile(importId, role, fileName, buffer, examUploadRoot);
    const saved = await objectStorage.put(examSourceObjectKey(importId, role, fileName), {
      buffer,
      fileName,
      mimeType: defaultMimeType(fileName),
      metadata: { category: "exam_import", importId, role: role === "answer" ? "answer" : "paper" },
    });
    if (mirrorObjectStorageLocally) saveExamSourceFile(importId, role, fileName, buffer, examUploadRoot);
    return saved;
  };
  const loadStoredExamSourceFile = async (importId, role, fileName) => {
    if (!objectStorage) return loadExamSourceFile(importId, role, fileName, examUploadRoot);
    try { return await objectStorage.getBuffer(examSourceObjectKey(importId, role, fileName)); }
    catch (error) { if (!isObjectStorageNotFound(error)) throw error; return loadExamSourceFile(importId, role, fileName, examUploadRoot); }
  };
  const deleteStoredExamSourceFiles = async (importId, source = {}) => {
    if (objectStorage) {
      const entries = [
        source.fileName && ["paper", source.fileName],
        source.answerFileName && ["answer", source.answerFileName],
      ].filter(Boolean);
      await Promise.all(entries.map(([role, fileName]) => objectStorage
        .delete(examSourceObjectKey(importId, role, fileName))
        .catch((error) => { if (!isObjectStorageNotFound(error)) throw error; })));
    }
    return deleteExamSourceFiles(importId, examUploadRoot);
  };
  const activeExamImportJobs = new Map();
  const examImportQueue = [];
  let examImportQueueRunning = false;
  // 登录态的操作人身份优先于调用方显式传入的 actor：以前几处写死的“超级管理员”
  // 会把真实操作人覆盖掉，同名账号也无法追溯，所以这里同时落 actorId。
  const currentAdminDisplayName = () => {
    const actor = adminActorContext.getStore() || {};
    return actor.displayName || actor.username || "";
  };
  const logOperation = (payload = {}) => {
    const actor = adminActorContext.getStore() || {};
    const signedIn = Boolean(actor.accountId);
    return operationLogStore.append({
      ...payload,
      actorId: signedIn ? actor.accountId : (payload.actorId || ""),
      actor: signedIn
        ? (actor.displayName || actor.username)
        : (payload.actor || actor.displayName || actor.username || "系统"),
      actorRole: signedIn
        ? (ADMIN_ROLE_LABELS[actor.role] || "system")
        : (payload.actorRole || ADMIN_ROLE_LABELS[actor.role] || "system"),
    });
  };

  // ---------- 用户侧治理：限制（禁言 / 禁止投稿 / 公开功能限制 / 账号封禁） ----------
  // 举报处置动作与限制类型的对应关系；四类都会真的落到用户状态上，并在对应入口拦截。
  const RESTRICTION_ACTIONS = {
    mute_user: "mute",
    no_submit_user: "no_submit",
    no_public_user: "no_public",
    ban_user: "ban",
  };

  const restrictionPayload = (state) => ({
    error: "user_restricted",
    restriction: {
      types: state.activeTypes,
      typeLabels: state.activeTypeLabels,
      expiresAt: state.expiresAt,
      until: state.untilLabel,
      message: state.message,
    },
  });

  /** 能力拦截：speak（发言/反馈）、submit（投稿）、publish（公开分享）、write（任意写入）。返回 true = 已拒绝。 */
  const guardUserCapability = (response, userId, capability) => {
    if (!userId) return false;
    const state = userRestrictionStore.statusFor(userId);
    if (!state.capabilities[capability]) return false;
    sendJson(response, 403, { success: false, ...restrictionPayload(state) });
    return true;
  };

  /** 付费/写入类用户接口的统一封禁拦截（封禁账号不能花钱、不能同步）。 */
  const guardBannedUser = (response, request, declaredUserId = "") => {
    const identity = resolveRequestIdentity(request, declaredUserId, userAuthStore);
    return guardUserCapability(response, identity.userId, "write");
  };

  // 社区内容列表回显“我是否收藏/复制过”：收藏与复制分开两个状态，互不推导。
  const decorateCommunityAssets = (assets, userId = "") => {
    const states = communityInteractionStore.statesForUser(userId, assets.map((asset) => asset.id));
    return assets.map((asset) => ({
      ...asset,
      viewerFavorited: Boolean(states[asset.id] && states[asset.id].favorited),
      viewerCopied: Boolean(states[asset.id] && states[asset.id].copied),
    }));
  };

  // 部署初始化：账号表为空时才用环境变量建首个超级管理员，且只在这一次建号时读取；
  // 登录永远只校验库内账号，环境变量不能换 token、也不能免登录。
  if (options.bootstrapAdmin !== false) {
    try {
      const bootstrap = adminAccountStore.ensureBootstrapAdmin({
        username: process.env.ADMIN_INIT_USERNAME || "admin",
        password: process.env.ADMIN_INIT_PASSWORD || "",
        displayName: process.env.ADMIN_INIT_DISPLAY_NAME || "",
      });
      if (bootstrap.created) {
        logOperation({
          actor: "系统初始化",
          actorRole: "系统",
          action: "admin_account.bootstrap",
          category: "admin_account",
          targetType: "admin_account",
          targetId: bootstrap.account.id,
          summary: `部署初始化创建首个超级管理员 ${bootstrap.account.username}`,
        });
        const ephemeralStore = Boolean(options.adminAccountStore || options.aiConfigStore);
        if (!ephemeralStore) {
          process.stdout.write(`[薯考后台] 已创建首个超级管理员：${bootstrap.account.username}\n`);
          process.stdout.write(bootstrap.generatedPassword
            ? `[薯考后台] 初始密码（仅本次显示，请登录后立即修改）：${bootstrap.generatedPassword}\n`
            : "[薯考后台] 初始密码来自 ADMIN_INIT_PASSWORD，请登录后立即修改。\n");
        }
      }
    } catch (error) {
      process.stderr.write(`[薯考后台] 管理员账号初始化失败，后台将保持锁定：${error.message}\n`);
    }
  }
  const loadQuestionsByIds = (ids) => {
    const normalizedIds = (Array.isArray(ids) ? ids : []).map(String);
    return typeof questionStore.getMany === "function"
      ? questionStore.getMany(normalizedIds)
      : normalizedIds.map((id) => questionStore.get(id));
  };
  const examQuestions = (exam = {}, questionLookup = null) => {
    const questionIds = [...new Set((Array.isArray(exam.questionIds) ? exam.questionIds : []).map(String).filter(Boolean))];
    return questionLookup
      ? questionIds.map((id) => questionLookup.get(id)).filter(Boolean)
      : loadQuestionsByIds(questionIds).filter(Boolean);
  };
  const examScoreSummary = (exam = {}, loadedQuestions = null) => {
    const questionIds = [...new Set((Array.isArray(exam.questionIds) ? exam.questionIds : []).map(String).filter(Boolean))];
    const questions = loadedQuestions || examQuestions(exam);
    const questionMap = new Map(questions.map((question) => [String(question.id), question]));
    const rawTotalScore = [...questionMap.values()].reduce((total, question) => total + Number(question.maxScore || 0), 0);
    const selectionRules = (Array.isArray(exam.selectionRules) ? exam.selectionRules : []).map((rule) => ({
      ...rule,
      questionIds: (Array.isArray(rule.questionIds) ? rule.questionIds : []).filter((id) => questionMap.has(id)),
    }));
    const excludedQuestionIds = [];
    selectionRules.forEach((rule) => {
      const orderedIds = questionIds.filter((id) => rule.questionIds.includes(id));
      excludedQuestionIds.push(...orderedIds.slice(Math.max(0, Number(rule.requiredCount) || 0)));
    });
    const calculatedTotalScore = rawTotalScore - [...new Set(excludedQuestionIds)]
      .reduce((total, id) => total + Number(questionMap.get(id)?.maxScore || 0), 0);
    const declaredTotalScore = Math.max(0, Number(exam.declaredTotalScore) || 0);
    const totalScore = declaredTotalScore || calculatedTotalScore;
    return {
      totalScore,
      rawTotalScore,
      calculatedTotalScore,
      declaredTotalScore,
      scoreMatches: !declaredTotalScore || Math.abs(declaredTotalScore - calculatedTotalScore) < 0.001,
      selectionRules,
      excludedQuestionIds: [...new Set(excludedQuestionIds)],
    };
  };
  const validateQuestionReferences = (questionIds, allowEmpty = false, scoreSettings = {}) => {
    const ids = [...new Set((Array.isArray(questionIds) ? questionIds : []).map(String).filter(Boolean))];
    if (!allowEmpty && !ids.length) throw new Error("content_questions_required");
    const questions = loadQuestionsByIds(ids);
    if (questions.some((question) => !question)) throw new Error("content_question_not_found");
    if (questions.some((question) => question.status === "offline")) throw new Error("content_question_offline");
    const scoreSummary = examScoreSummary({
      questionIds: ids,
      selectionRules: scoreSettings.selectionRules,
      declaredTotalScore: scoreSettings.declaredTotalScore,
    });
    return { questionIds: ids, ...scoreSummary };
  };
  const examAnswerReviewSummary = (exam, loadedQuestions = null) => {
    const questions = loadedQuestions || examQuestions(exam);
    const unreviewedQuestionIds = questions
      .filter((question) => question.answerReviewStatus === "unreviewed")
      .map((question) => question.id);
    const doubtfulQuestionIds = questions
      .filter((question) => question.answerReviewStatus === "doubtful")
      .map((question) => question.id);
    const pendingQuestionIds = [...unreviewedQuestionIds, ...doubtfulQuestionIds];
    return {
      status: pendingQuestionIds.length ? "needs_full_review" : "fully_reviewed",
      totalCount: questions.length,
      verifiedCount: questions.length - pendingQuestionIds.length,
      unreviewedCount: unreviewedQuestionIds.length,
      doubtfulCount: doubtfulQuestionIds.length,
      pendingCount: pendingQuestionIds.length,
      unreviewedQuestionIds,
      doubtfulQuestionIds,
      pendingQuestionIds,
    };
  };
  const withExamAnswerReview = (exam, questionLookup = null) => {
    const questions = examQuestions(exam, questionLookup);
    return {
      ...exam,
      ...examScoreSummary(exam, questions),
      answerReviewSummary: examAnswerReviewSummary(exam, questions),
    };
  };
  const withExamAnswerReviews = (exams = []) => {
    const ids = [...new Set(exams.flatMap((exam) => Array.isArray(exam.questionIds) ? exam.questionIds.map(String) : []))];
    const questionLookup = new Map(loadQuestionsByIds(ids)
      .filter(Boolean)
      .map((question) => [String(question.id), question]));
    return exams.map((exam) => withExamAnswerReview(exam, questionLookup));
  };
  const examImportCandidates = (draft) => draft.questions.filter((question) => question.included !== false).map((question, index) => ({
    subjectId: question.subjectId,
    bookId: question.bookId,
    chapter: question.chapter,
    knowledgePoints: question.knowledgePoints,
    type: question.type,
    stem: question.stem,
    options: question.options,
    correctAnswer: question.correctAnswer,
    referenceAnswer: question.referenceAnswer,
    answerVariants: question.answerVariants,
    hiddenAnswerVariants: question.hiddenAnswerVariants,
    answerSource: question.answerSource,
    answerReviewStatus: question.answerReviewStatus,
    answerVerified: question.answerVerified,
    scoringPoints: question.scoringPoints,
    scoringPolicy: question.scoringPolicy,
    maxScore: question.maxScore,
    material: question.material,
    materialMarks: question.materialMarks,
    materialGroupId: question.materialGroupId,
    questionGroupId: question.materialGroupId ? `exam-import:${draft.id}:${question.materialGroupId}` : "",
    questionGroupTitle: question.materialGroupId ? `第${question.groupNumber || question.number || index + 1}题 · 材料题组` : "",
    groupOrder: question.materialGroupId ? (Number(String(question.subNumber || "").normalize("NFKC").replace(/[^0-9]/g, "")) || index + 1) : 0,
    usesSharedMaterial: question.usesSharedMaterial !== false,
    groupNumber: question.groupNumber,
    subNumber: question.subNumber,
    responseMode: question.responseMode,
    annotationText: question.annotationText,
    sourceLabel: draft.source.fileName,
    sourcePage: question.sourcePage,
    freePreview: { question: false, answer: false, analysis: false },
    changeNote: `试卷文件识别导入 · ${draft.source.fileName}`,
  }));
  const inferExamSelectionRules = (draft, questionIds) => {
    const included = draft.questions.filter((question) => question.included !== false);
    const grouped = new Map();
    included.forEach((question, index) => {
      const sectionTitle = String(question.sectionTitle || "").trim();
      const match = sectionTitle.match(/任选\s*(\d+)\s*题/);
      if (!match || !questionIds[index]) return;
      const key = sectionTitle;
      if (!grouped.has(key)) grouped.set(key, { sectionTitle, requiredCount: Number(match[1]), questionIds: [] });
      grouped.get(key).questionIds.push(questionIds[index]);
    });
    return [...grouped.values()].filter((rule) => rule.requiredCount > 0 && rule.requiredCount < rule.questionIds.length).map((rule, index) => ({
      id: `import-selection-rule-${index + 1}`,
      title: rule.sectionTitle.split("（")[0].trim() || `选答规则 ${index + 1}`,
      requiredCount: rule.requiredCount,
      questionIds: rule.questionIds,
      scoringOrder: "first_answered",
    }));
  };
  const examDeclaredTotalScore = (draft) => {
    const explicit = Number(draft.metadata && draft.metadata.totalScore);
    if (explicit > 0) return explicit;
    const match = String(draft.metadata && draft.metadata.description || "").match(/满分\s*(\d+(?:\.\d+)?)\s*分/);
    return match ? Number(match[1]) : 0;
  };
  const examImportPreview = (draft) => {
    const included = draft.questions.filter((question) => question.included !== false);
    if (!included.length) return [];
    const preview = questionStore.previewImport(examImportCandidates(draft), currentAdminDisplayName() || "超级管理员");
    return preview.map((item, index) => ({
      index,
      localId: included[index] && included[index].localId,
      valid: item.valid,
      duplicate: item.duplicate === true,
      duplicateOf: item.duplicateOf || "",
      error: item.error || "",
    }));
  };
  const generateCatalogDraft = async (bookId, extracted) => {
    const textbook = textbookCatalogStore.get(bookId);
    if (!textbook) throw new Error("textbook_not_found");
    const tocNodes = normalizeCatalogPageRanges(tocCatalogDraft(extracted.pages));
    if (tocNodes.length >= 3) {
      return {
        textbook: textbookCatalogStore.setDraft(bookId, tocNodes, { source: "local_heading_rules", pageRange: `1-${Math.min(extracted.pageCount, 80)}` }, currentAdminDisplayName() || "超级管理员"),
        source: "local_heading_rules",
      };
    }
    const config = aiConfigStore.load();
    const ocrRequired = requiresPdfOcr(extracted);
    const preferredSceneId = ocrRequired && config.routes.textbook_ocr?.mode === "provider"
      ? "textbook_ocr"
      : "textbook_extraction";
    const route = config.routes[preferredSceneId];
    const provider = route && route.mode === "provider"
      ? config.providers.find((item) => item.id === route.providerId && item.enabled)
      : null;
    if (!provider) {
      if (requiresPdfOcr(extracted)) return { textbook, warning: "textbook_pdf_ocr_route_unavailable", source: "ocr_required" };
      const nodes = normalizeCatalogPageRanges(localCatalogDraft(extracted.pages));
      if (!nodes.length) return { textbook, warning: "catalog_headings_not_detected", source: "local_heading_rules" };
      return {
        textbook: textbookCatalogStore.setDraft(bookId, nodes, { source: "local_heading_rules", pageRange: `1-${Math.min(extracted.pageCount, 120)}` }, currentAdminDisplayName() || "超级管理员"),
        source: "local_heading_rules",
      };
    }
    const task = aiTaskStore.start(aiTaskMetadata(config, preferredSceneId, {}, {
      inputSummary: { bookId, pageCount: extracted.pageCount, textChars: extracted.textChars },
    }));
    try {
      const pageRange = `1-${Math.min(extracted.pageCount, ocrRequired ? 24 : 80)}`;
      const effectiveRoute = /^kimi-k3$/i.test(route.model) ? { ...route, temperature: 1 } : route;
      const extractionProvider = { ...provider, timeoutMs: Math.max(Number(provider.timeoutMs) || 30000, ocrRequired ? 300000 : 120000) };
      const values = {
        bookMetadata: { id: textbook.id, title: textbook.title, volume: textbook.volume, authors: textbook.authors, publisher: textbook.publisher },
        extractedText: ocrRequired ? "扫描版 PDF 没有可用文字层，请从页面图像识别目录。" : catalogPagesForModel(extracted.pages),
        pageRange,
      };
      let completion;
      let nodes;
      if (ocrRequired) {
        const renderedPages = await renderPdfPagesForOcr(await loadStoredTextbookPdf(bookId), { pageCount: extracted.pageCount, pageLimit: 24 });
        // Send a small group of pages per vision request. One request per page
        // makes a 40-page scanned book prone to upstream gateway timeouts.
        const pageGroups = [];
        for (let index = 0; index < renderedPages.length; index += 2) pageGroups.push(renderedPages.slice(index, index + 2));
        const recognizePages = async (pages) => {
          const pageCompletion = await completeVisionPromptWithProvider(
            extractionProvider,
            effectiveRoute,
            config.prompts[preferredSceneId],
            { ...values, pageRange: `${pages[0].pageNumber}-${pages[pages.length - 1].pageNumber}` },
            pages,
          );
          return {
            pageNumber: pages[0].pageNumber,
            completion: pageCompletion,
            nodes: catalogNodesFromModel(parseJsonContent(pageCompletion.content), { allowEmpty: true }),
          };
        };
        const pageResults = await mapWithConcurrency(pageGroups, 2, async (pages) => {
          try {
            return await recognizePages(pages);
          } catch (error) {
            return { error, pages };
          }
        });
        const retryResults = [];
        for (const failedGroup of pageResults.filter((item) => item.error)) {
          const singlePageResults = await mapWithConcurrency(failedGroup.pages, 1, async (page) => {
            try {
              return await recognizePages([page]);
            } catch (error) {
              return { error, pages: [page] };
            }
          });
          retryResults.push(...singlePageResults);
        }
        const successfulPageResults = [...pageResults, ...retryResults]
          .filter((item) => item.completion)
          .sort((left, right) => left.pageNumber - right.pageNumber);
        const pageErrors = retryResults.filter((item) => item.error).map((item) => item.error);
        nodes = normalizeCatalogPageRanges(normalizeCatalogHierarchy(mergeCatalogNodes(successfulPageResults.map((item) => item.nodes))));
        if (!nodes.length && pageErrors.length) throw pageErrors[0];
        if (!nodes.length) throw new Error("catalog_headings_not_detected");
        const lastCompletion = successfulPageResults[successfulPageResults.length - 1].completion;
        const totalOutputChars = successfulPageResults.reduce((total, item) => total + item.completion.content.length, 0);
        completion = { ...lastCompletion, content: "".padEnd(totalOutputChars, " ") };
        if (pageErrors.length) completion.partialWarning = `OCR 有 ${pageErrors.length} 页逐页重试后仍失败，已保存其余识别结果`;
      } else {
        completion = await completePromptWithProvider(extractionProvider, effectiveRoute, config.prompts.textbook_extraction, values);
        nodes = normalizeCatalogPageRanges(catalogNodesFromModel(parseJsonContent(completion.content)));
      }
      const saved = textbookCatalogStore.setDraft(bookId, nodes, { source: ocrRequired ? "ai_vision_ocr" : "ai_model", model: completion.model, pageRange }, currentAdminDisplayName() || "超级管理员");
      aiTaskStore.finish(task.id, { status: "succeeded", chargeable: false, usage: completion.usage, outputChars: completion.content.length });
      return {
        textbook: saved,
        source: ocrRequired ? "ai_vision_ocr" : "ai_model",
        model: completion.model,
        warning: completion.partialWarning,
      };
    } catch (error) {
      aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "catalog_extraction" });
      const nodes = normalizeCatalogPageRanges(localCatalogDraft(extracted.pages));
      if (!nodes.length) return { textbook: textbookCatalogStore.get(bookId), warning: error.message, source: "ai_failed" };
      return {
        textbook: textbookCatalogStore.setDraft(bookId, nodes, { source: "local_heading_rules", pageRange: `1-${Math.min(extracted.pageCount, 120)}` }, currentAdminDisplayName() || "超级管理员"),
        warning: error.message,
        source: "local_heading_rules",
      };
    }
  };
  const activeKnowledgeBuilds = new Map();
  const configuredScene = (config, primarySceneId, fallbackSceneId = "") => {
    const primaryRoute = config.routes[primarySceneId];
    const route = primaryRoute && primaryRoute.mode === "provider"
      ? primaryRoute
      : (fallbackSceneId ? config.routes[fallbackSceneId] : null);
    const provider = route && route.mode === "provider"
      ? config.providers.find((item) => item.id === route.providerId && item.enabled)
      : null;
    return provider ? {
      route,
      provider,
      prompt: config.prompts[primarySceneId],
      configuredSceneId: primaryRoute && primaryRoute.mode === "provider" ? primarySceneId : fallbackSceneId,
    } : null;
  };
  const cardAssistanceCache = new Map();
  const activeCardAssistanceGenerations = new Map();
  const cardAssistanceCacheTtl = 30 * 24 * 60 * 60 * 1000;
  const cardAssistanceRequiredOutput = {
    schemaVersion: CARD_ASSISTANCE_SCHEMA_VERSION,
    concepts: [{
      id: "k1",
      pointId: "p1",
      role: "direct_answer",
      highlight: { quote: "对应分点中的连续原文重点", occurrence: 0 },
      clozes: [{ quote: "highlight.quote 内适合挖空的连续原文", occurrence: 0 }],
    }, {
      id: "k2",
      pointId: "p1",
      role: "contrast",
      highlight: { quote: "同一分点中另一个不重叠的核心短语", occurrence: 0 },
      clozes: [{ quote: "该重点内的短挖空", occurrence: 0 }],
    }],
    mnemonic: { text: "只基于上述概念的简短口诀", conceptIds: ["k1"] },
  };
  const cardAssistanceCacheKey = (source, scene, userScope) => crypto.createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: CARD_ASSISTANCE_SCHEMA_VERSION,
      sourceDigest: source.sourceDigest,
      userScope,
      configuredSceneId: scene.configuredSceneId,
      providerId: scene.provider.id,
      model: scene.route.model,
      temperature: scene.route.temperature,
      maxTokens: scene.route.maxTokens,
      promptVersion: scene.prompt.version || 1,
      systemPrompt: scene.prompt.systemPrompt,
      userPromptTemplate: scene.prompt.userPromptTemplate,
    }))
    .digest("hex");
  const cachedCardAssistance = (key) => {
    const cached = cardAssistanceCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.savedAt > cardAssistanceCacheTtl) {
      cardAssistanceCache.delete(key);
      return null;
    }
    cardAssistanceCache.delete(key);
    cardAssistanceCache.set(key, cached);
    return cached;
  };
  const cacheCardAssistance = (key, result) => {
    cardAssistanceCache.delete(key);
    cardAssistanceCache.set(key, { result, savedAt: Date.now() });
    while (cardAssistanceCache.size > 200) {
      cardAssistanceCache.delete(cardAssistanceCache.keys().next().value);
    }
  };
  const knowledgeClassificationBridgeTerms = (question) => {
    const text = [
      question?.stem,
      question?.material,
      ...(question?.options || []).map((option) => option.text),
      question?.answerVariants?.official,
      question?.referenceAnswer,
    ].filter(Boolean).join(" ").normalize("NFKC");
    const terms = [];
    const asksFinalStructure = /(韵腹|韵头|韵尾|韵母结构)/u.test(text);
    const usesVowelDimensions = /(前|央|后)[、,，\s]*(?:半高|半低|高|低)|(?:半高|半低|高|低)[、,，\s]*(?:圆唇|不圆唇)|舌位|圆唇|不圆唇/u.test(text);
    if (asksFinalStructure) terms.push("韵母的结构", "韵母发音", "实际音值", "国际音标");
    if (usesVowelDimensions) terms.push("舌面元音", "元音的发音", "舌位高低", "舌位前后", "唇形圆展");
    if (asksFinalStructure && usesVowelDimensions) terms.push("音位变体", "普通话元音音位", "出现条件");
    return [...new Set(terms)];
  };
  const knowledgeClassificationRequiredBridgeTitles = (question) => {
    const terms = new Set(knowledgeClassificationBridgeTerms(question));
    if (terms.has("音位变体")) return ["韵母的结构", "舌面元音", "音位变体"];
    if (terms.has("舌面元音")) return ["舌面元音"];
    if (terms.has("韵母的结构")) return ["韵母的结构"];
    return [];
  };
  const verifiedOfficialAnswer = (question) => {
    const official = String(question?.answerVariants?.official || "").trim();
    return question?.answerReviewStatus === "verified" && official ? official : "";
  };
  const retrieveQuestionEvidence = (question, extraQuery = "", limit = 6) => {
    if (!question || !question.bookId) return [];
    const officialAnswer = verifiedOfficialAnswer(question);
    const query = [
      question.stem,
      question.material,
      ...(question.options || []).map((option) => `${option.key || ""} ${option.text || ""}`),
      (question.correctAnswer || []).join(" "),
      officialAnswer || question.referenceAnswer,
      !officialAnswer ? question.answerVariants?.ai : "",
      (question.knowledgePoints || []).join(" "),
      ...knowledgeClassificationBridgeTerms(question),
      extraQuery,
    ].filter(Boolean).join("\n").slice(0, 12000);
    return textbookKnowledgeStore.search(question.bookId, query, { limit });
  };
  const resolveTextbookContext = (question) => resolveQuestionTextbookContext({
    question,
    books,
    getCatalog: (bookId) => textbookCatalogStore.get(bookId),
    getKnowledge: (bookId) => textbookKnowledgeStore.get(bookId),
    search: (bookId, query, options) => textbookKnowledgeStore.search(bookId, query, options),
  });
  const textbookCatalogScope = (bookId, catalogNodeId) => {
    if (!catalogNodeId) return null;
    const textbook = textbookCatalogStore.get(bookId);
    const confirmedNode = catalogNodesWithPaths(textbook && textbook.confirmed && textbook.confirmed.nodes)
      .find((node) => node.id === catalogNodeId);
    return confirmedNode || textbookKnowledgeStore.outline(bookId)
      .find((node) => node.id === catalogNodeId) || null;
  };
  const activeQuestionEnrichmentJobs = new Set();
  const enrichmentEvidence = (chunks) => (Array.isArray(chunks) ? chunks : []).map((chunk) => ({
    chunkId: String(chunk.id || ""),
    printedPage: Number(chunk.printedPageStart) > 0
      ? `${chunk.printedPageStart}${Number(chunk.printedPageEnd) > Number(chunk.printedPageStart) ? `-${chunk.printedPageEnd}` : ""}`
      : "",
    catalogPath: String(chunk.catalogPath || ""),
    excerpt: String(typeof chunk.retrievalText === "string" ? chunk.retrievalText : chunk.text || "").trim().slice(0, 1200),
  }));
  const questionEnrichmentCatalog = (bookId) => {
    const textbook = textbookCatalogStore.get(bookId);
    if (!textbook || !textbook.confirmed || !Array.isArray(textbook.confirmed.nodes) || !textbook.confirmed.nodes.length) {
      throw new Error("catalog_confirmed_not_found");
    }
    return {
      textbook,
      nodes: catalogNodesWithPaths(textbook.confirmed.nodes).filter((node) => node.id && node.path),
    };
  };
  const normalizeQuestionEnrichmentSuggestion = (raw, question, nodes, evidenceChunks, context = {}) => {
    const requestedNodeId = String(raw && (raw.catalogNodeId || raw.chapterNodeId) || "");
    const currentPathNode = nodes.find((node) => node.path === question.chapter);
    const node = nodes.find((item) => item.id === requestedNodeId) || (!requestedNodeId ? currentPathNode : null);
    if (!node) throw new Error("question_enrichment_catalog_node_invalid");
    const knowledgePoints = (Array.isArray(raw && raw.knowledgePoints) ? raw.knowledgePoints : [])
      .map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
    if (!knowledgePoints.length) throw new Error("question_enrichment_knowledge_points_required");
    const needs = questionEnrichmentNeeds(question);
    const scoringPoints = (Array.isArray(raw && raw.scoringPoints) ? raw.scoringPoints : []).map((point) => ({
      description: String(point && point.description || "").trim(),
      score: Number(point && point.score),
      textbookPage: String(point && point.textbookPage || "").trim().slice(0, 100),
      pageBasis: ["confirmed_catalog", "textbook_text"].includes(point && point.pageBasis) ? point.pageBasis : "",
      sourceNote: String(point && point.sourceNote || "").trim().slice(0, 500),
    })).filter((point) => point.description && Number.isFinite(point.score) && point.score > 0).slice(0, 30);
    if (needs.needsScoringPoints) {
      const totalScore = scoringPoints.reduce((total, point) => total + point.score, 0);
      if (!scoringPoints.length || Math.abs(totalScore - Number(question.maxScore)) > 0.001) {
        throw new Error("question_enrichment_scoring_points_mismatch");
      }
    }
    return {
      questionId: question.id,
      questionVersion: question.version,
      status: "recommended",
      chapterNodeId: node.id,
      catalogPath: node.path,
      knowledgePoints,
      scoringPoints,
      confidence: Number(raw && raw.confidence) || 0,
      reason: String(raw && raw.reason || ""),
      uncertainty: String(raw && raw.uncertainty || ""),
      evidence: enrichmentEvidence(evidenceChunks),
      model: String(context.model || ""),
      promptVersion: Number(context.promptVersion) || 1,
      jobId: String(context.jobId || ""),
    };
  };
  const generateQuestionEnrichmentSuggestion = async (question, jobId) => {
    const config = aiConfigStore.load();
    const scene = configuredScene(config, "question_enrichment");
    if (!scene) throw new Error("question_enrichment_route_unavailable");
    const { textbook, nodes } = questionEnrichmentCatalog(question.bookId);
    const evidenceChunks = retrieveQuestionEvidence(question, "判断章节归属、知识点与结构化得分点", 8);
    const task = aiTaskStore.start(aiTaskMetadata(config, "question_enrichment", {}, {
      providerId: scene.provider.id,
      providerName: scene.provider.name,
      protocol: scene.provider.protocol,
      model: scene.route.model,
      mode: "provider",
      inputSummary: {
        jobId,
        questionId: question.id,
        questionVersion: question.version,
        bookId: question.bookId,
        needs: questionEnrichmentNeeds(question).needs,
      },
    }));
    try {
      const requiredOutput = {
        catalogNodeId: "必须从已确认目录中选择一个 id",
        knowledgePoints: ["主知识点", "辅助知识点"],
        scoringPoints: [{
          description: "独立可判分的得分点；非主观题返回空数组",
          score: Number(question.maxScore),
          textbookPage: "教材印刷页码或页码范围；证据不足留空",
          pageBasis: "textbook_text | confirmed_catalog | 空字符串",
          sourceNote: "教材名 · 目录路径",
        }],
        confidence: 0.9,
        reason: "目录与知识点判断依据",
        uncertainty: "不确定项，没有则留空",
      };
      const completion = await completePromptWithProvider(
        { ...scene.provider, timeoutMs: Math.max(120000, Number(scene.provider.timeoutMs) || 0) },
        { ...scene.route, temperature: Math.min(0.2, Number(scene.route.temperature) || 0.1) },
        scene.prompt,
        {
          question: {
            id: question.id,
            type: question.type,
            material: question.material,
            stem: question.stem,
            options: question.options,
            referenceAnswer: question.referenceAnswer,
            maxScore: question.maxScore,
            currentChapter: question.chapter,
            currentKnowledgePoints: question.knowledgePoints,
            currentScoringPoints: question.scoringPoints,
            scoringPointStatus: question.scoringPointStatus,
            fieldsNeedingCompletion: questionEnrichmentNeeds(question).needs,
            immutableFields: ["referenceAnswer", "answerVariants", "correctAnswer", "stem", "options"],
          },
          confirmedCatalog: nodes.slice(0, 500).map((node) => ({
            id: node.id,
            level: node.level,
            path: node.path,
            startPage: node.startPage,
            endPage: node.endPage,
            knowledgePoints: node.knowledgePoints || [],
          })),
          textbookEvidence: formatTextbookEvidence(evidenceChunks, 18000),
          requiredOutput,
        },
      );
      const suggestion = normalizeQuestionEnrichmentSuggestion(
        parseJsonContent(completion.content),
        question,
        nodes,
        evidenceChunks,
        { model: completion.model, promptVersion: config.prompts.question_enrichment && config.prompts.question_enrichment.version, jobId },
      );
      const saved = questionEnrichmentStore.addSuggestion(suggestion);
      aiTaskStore.finish(task.id, {
        status: "succeeded",
        chargeable: false,
        usage: completion.usage,
        outputChars: completion.content.length,
      });
      return saved;
    } catch (error) {
      aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "question_enrichment" });
      throw error;
    }
  };
  const runQuestionEnrichmentJob = async (jobId) => {
    if (activeQuestionEnrichmentJobs.has(jobId)) return;
    const initialJob = questionEnrichmentStore.getJob(jobId);
    if (!initialJob || !["queued", "running"].includes(initialJob.status)) return;
    activeQuestionEnrichmentJobs.add(jobId);
    questionEnrichmentStore.updateJob(jobId, { status: "running", startedAt: initialJob.startedAt || Date.now(), error: "" });
    try {
      await mapWithConcurrency(initialJob.questionIds, 2, async (questionId) => {
        let succeeded = false;
        let errorMessage = "";
        try {
          const question = questionStore.get(questionId);
          if (!question) throw new Error("question_not_found");
          if (questionEnrichmentNeeds(question).complete) throw new Error("question_enrichment_not_required");
          await generateQuestionEnrichmentSuggestion(question, jobId);
          succeeded = true;
        } catch (error) {
          errorMessage = error.message;
          const question = questionStore.get(questionId);
          questionEnrichmentStore.addSuggestion({
            questionId,
            questionVersion: question && question.version || 1,
            status: "failed",
            jobId,
            error: errorMessage,
          });
        }
        const current = questionEnrichmentStore.getJob(jobId);
        questionEnrichmentStore.updateJob(jobId, {
          currentQuestionId: questionId,
          completed: current.completed + 1,
          succeeded: current.succeeded + (succeeded ? 1 : 0),
          failed: current.failed + (succeeded ? 0 : 1),
          error: errorMessage || current.error,
        });
      });
      const completed = questionEnrichmentStore.getJob(jobId);
      questionEnrichmentStore.updateJob(jobId, {
        status: completed.failed === 0 ? "completed" : (completed.succeeded > 0 ? "partial" : "failed"),
        currentQuestionId: "",
        finishedAt: Date.now(),
      });
    } catch (error) {
      questionEnrichmentStore.updateJob(jobId, { status: "failed", error: error.message, finishedAt: Date.now() });
    } finally {
      activeQuestionEnrichmentJobs.delete(jobId);
    }
  };
  const activeKnowledgeClassificationJobs = new Set();
  const activeKnowledgeClassificationApplies = new Set();
  const knowledgeClassificationQuestionPayload = (question, context = {}) => ({
    id: question.id,
    type: question.type,
    stem: question.stem,
    material: question.material || "",
    options: question.options || [],
    correctAnswer: question.correctAnswer || [],
    referenceAnswer: question.referenceAnswer || "",
    answerSource: question.answerSource || "missing",
    answerReviewStatus: question.answerReviewStatus || "unreviewed",
    answerVerified: question.answerVerified === true,
    answerVariants: {
      verifiedSourceOrPlatform: String(question.answerVariants?.official || ""),
      ai: String(question.answerVariants?.ai || ""),
      community: String(question.answerVariants?.community || ""),
    },
    answerAuthority: verifiedOfficialAnswer(question)
      ? "verified_source_or_platform"
      : (question.answerReviewStatus === "verified" ? "verified_structured" : "unverified"),
    currentChapter: question.chapter || "",
    currentKnowledgePoints: question.knowledgePoints || [],
    candidateKnowledgeNodeIds: [...new Set((context.candidateKnowledgeNodeIds || []).map(String).filter(Boolean))],
    classificationCorrection: context.classificationCorrection || null,
  });
  const compactAgent3QuestionPayload = (question, context = {}) => ({
    id: question.id,
    type: question.type,
    stem: String(question.stem || ""),
    material: String(question.material || ""),
    options: (question.options || []).map((option) => ({
      key: option.key,
      text: String(option.text || ""),
    })),
    correctAnswer: question.correctAnswer || [],
    referenceAnswer: String(question.referenceAnswer || "").slice(0, 1000),
    answerSource: question.answerSource || "missing",
    answerReviewStatus: question.answerReviewStatus || "unreviewed",
    answerVerified: question.answerVerified === true,
    answerVariants: {
      verifiedSourceOrPlatform: String(question.answerVariants?.official || "").slice(0, 1000),
      ai: String(question.answerVariants?.ai || "").slice(0, 600),
    },
    answerAuthority: verifiedOfficialAnswer(question)
      ? "verified_source_or_platform"
      : (question.answerReviewStatus === "verified" ? "verified_structured" : "unverified"),
    candidateKnowledgeNodeIds: [...new Set((context.candidateKnowledgeNodeIds || []).map(String).filter(Boolean))],
  });
  const compactClassificationRule = (rule) => ({
    id: rule.id,
    version: rule.version,
    title: rule.title,
    rule: rule.statement,
    scopePath: rule.scopePath,
    triggerTerms: rule.triggerTerms,
    positiveExamples: rule.positiveExamples,
    negativeExamples: rule.negativeExamples,
    priority: rule.priority,
    authority: "human_approved",
  });
  const compactClassificationCase = (item) => ({
    id: item.id,
    questionId: item.questionId,
    stem: item.stem,
    options: item.options,
    knowledgePath: item.knowledgePath,
    primaryNodeId: item.primaryNodeId,
    primaryNodeRole: normalizedPrimaryNodeRole(item.primaryNodeRole),
    requiredNodeIds: item.requiredNodeIds,
    focusLabel: item.focusLabel,
    reason: item.reason,
    features: item.features,
    referenceWeight: item.referenceWeight,
    authority: "human_confirmed_case",
  });
  const classificationExperienceForQuestion = (question, nodeIds = []) => {
    const context = knowledgeClassificationExperienceStore.context({
      bookId: question.bookId,
      nodeIds,
      questionType: question.type,
      text: [
        question.stem,
        question.material,
        question.referenceAnswer,
        ...(question.options || []).map((option) => option.text),
      ].filter(Boolean).join("\n"),
      limitRules: 8,
      limitCases: 3,
    });
    const filteredCases = context.cases.filter((item) => String(item.questionId || "") !== String(question.id || ""));
    return {
      rules: context.rules.map(compactClassificationRule),
      cases: filteredCases.map(compactClassificationCase),
      excludedSelfCaseCount: context.cases.length - filteredCases.length,
      matchingStrategy: knowledgeClassificationExperienceStore.cases({ bookId: question.bookId, status: "confirmed", limit: 500 }).length >= 30
        ? "confirmed_case_vector_primary_rules_exception_fallback"
        : "knowledge_dossier_confirmed_family_case_primary_rules_exception_fallback",
    };
  };
  const compactAgent3FeatureProfile = (profile, limits = AGENT3_CONTEXT_LIMITS.primary) => {
    if (!profile || typeof profile !== "object") return null;
    const composedOptions = profile.choiceStructure === "composed_options";
    return {
      optionKnowledgeProtocolVersion: profile.optionKnowledgeProtocolVersion || "legacy",
      choiceStructure: profile.choiceStructure || "direct_options",
      questionMode: profile.questionMode,
      coreKeywords: (profile.coreKeywords || []).slice(0, 10),
      primaryKnowledgeHints: (profile.primaryKnowledgeHints || []).slice(0, 8),
      secondaryKnowledgeHints: (profile.secondaryKnowledgeHints || []).slice(0, 6),
      optionFeatures: (profile.optionFeatures || []).slice(0, 12).map((item) => ({
        key: item.key,
        isCorrect: item.isCorrect === true,
        role: item.role,
        decisionRole: item.decisionRole,
        requiredForDecision: item.requiredForDecision === true,
        basis: String(item.basis || "").slice(0, 120),
        ...(!composedOptions ? {
          knowledgeHints: (item.knowledgeHints || []).slice(0, 6),
          knowledgeRelation: item.knowledgeRelation || "unreviewed",
          uncertaintyNote: String(item.uncertaintyNote || "").slice(0, 160),
        } : {}),
      })),
      atomicStatements: (profile.atomicStatements || []).slice(0, 24).map((item) => ({
        key: item.key,
        text: String(item.text || "").slice(0, 300),
        knowledgeRelation: item.knowledgeRelation || "unreviewed",
        knowledgeHints: (item.knowledgeHints || []).slice(0, 6),
        uncertaintyNote: String(item.uncertaintyNote || "").slice(0, 160),
        verdict: item.verdict || "unknown",
        basis: String(item.basis || "").slice(0, 160),
      })),
      optionComposition: (profile.optionComposition || []).slice(0, 12).map((item) => ({
        optionKey: item.optionKey,
        atomicKeys: (item.atomicKeys || []).slice(0, 16),
      })),
      dependencySteps: (profile.dependencySteps || []).slice(0, limits.featureDependencySteps).map((step) => ({
        ref: step.ref,
        label: step.label,
        dependencyRole: step.dependencyRole,
        coveredByStepRef: step.coveredByStepRef || "",
        nodeIds: (step.nodeIds || []).slice(0, 6),
        basis: String(step.basis || "").slice(0, 160),
      })),
      primaryBasis: String(profile.primaryBasis || "").slice(0, 280),
      crossFamilyProbability: profile.crossFamilyProbability,
      callDepth: profile.callDepth,
    };
  };
  const compactAgent3Navigation = (result, recoveredFrom = "") => ({
    questionId: result?.questionId || "",
    trajectories: (result?.agent1Trajectories || []).slice(0, 2).map((trajectory) => {
      const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
      const lastStep = steps.at(-1) || null;
      return {
        selectedPathNodeIds: [...new Set(steps.flatMap((step) => step.selectedNodeIds || []))].slice(0, 12),
        terminalNodeIds: (trajectory.terminalNodeIds || []).slice(0, 8),
        stopReason: trajectory.stopReason || lastStep?.stopReason || "",
        lastStep: lastStep ? {
          parentNodeId: lastStep.parentNodeId || "",
          candidateNodeIds: (lastStep.candidateNodeIds || []).slice(0, 5),
          decision: lastStep.decision || "",
          selectedNodeIds: (lastStep.selectedNodeIds || []).slice(0, 2),
          corePathStatus: lastStep.corePathStatus || "",
          auxiliaryGap: lastStep.auxiliaryGap ? {
            dependencyStepRefs: (lastStep.auxiliaryGap.dependencyStepRefs || []).slice(0, 8),
            dependencies: (lastStep.auxiliaryGap.dependencies || []).slice(0, 8).map((dependency) => ({
              ref: dependency.ref,
              label: String(dependency.label || "").slice(0, 160),
              nodeIds: (dependency.nodeIds || []).slice(0, 6),
            })),
            reason: String(lastStep.auxiliaryGap.reason || "").slice(0, 240),
          } : null,
          reason: String(lastStep.reason || "").slice(0, 240),
        } : null,
      };
    }),
    ...(recoveredFrom ? { recoveredFrom } : {}),
  });
  const compactAgent3Dossier = (dossier, candidateNodeSet, limits) => ({
    id: dossier.id,
    canonicalName: dossier.canonicalName,
    aliases: (dossier.aliases || []).slice(0, 8),
    status: dossier.status,
    authority: "active_semantic_reference",
    definition: String(dossier.definition || "").slice(0, 360),
    inclusionCriteria: (dossier.inclusionCriteria || []).slice(0, 3).map((item) => String(item || "").slice(0, 160)),
    exclusionCriteria: (dossier.exclusionCriteria || []).slice(0, 3).map((item) => String(item || "").slice(0, 160)),
    claims: (dossier.claims || []).slice(0, limits.dossierClaims).map((claim) => ({
      statement: String(claim.statement || "").slice(0, 220),
      evidenceChunkIds: (claim.evidence || []).map((item) => item.chunkId).filter(Boolean).slice(0, 3),
    })),
    occurrences: (dossier.occurrences || []).filter((occurrence) => candidateNodeSet.has(occurrence.nodeId))
      .slice(0, 4).map((occurrence) => ({ nodeId: occurrence.nodeId, path: occurrence.path, role: occurrence.role })),
  });
  const compactAgent3Rule = (rule) => ({
    id: rule.id,
    version: rule.version,
    title: rule.title,
    rule: String(rule.rule || rule.statement || "").slice(0, 320),
    scopePath: rule.scopePath,
    triggerTerms: (rule.triggerTerms || []).slice(0, 6),
    priority: rule.priority,
    authority: "human_approved",
  });
  const compactAgent3Case = (item) => ({
    id: item.id,
    questionId: item.questionId,
    stem: String(item.stem || "").slice(0, 220),
    options: (item.options || []).slice(0, 8).map((option) => ({
      key: option.key,
      text: String(option.text || "").slice(0, 100),
    })),
    knowledgePath: item.knowledgePath,
    primaryNodeId: item.primaryNodeId,
    primaryNodeRole: normalizedPrimaryNodeRole(item.primaryNodeRole),
    requiredNodeIds: (item.requiredNodeIds || []).slice(0, 8),
    focusLabel: item.focusLabel,
    reason: String(item.reason || "").slice(0, 180),
    referenceWeight: item.referenceWeight,
    authority: "human_confirmed_case",
  });
  const compactClassificationEvidence = (chunks, excerptLimit = 1000, totalExcerptLimit = Number.MAX_SAFE_INTEGER) => {
    let remaining = Math.max(0, Number(totalExcerptLimit) || 0);
    return (Array.isArray(chunks) ? chunks : []).flatMap((chunk) => {
      if (remaining <= 0) return [];
      const source = String(typeof chunk.retrievalText === "string" ? chunk.retrievalText : chunk.text || "").trim();
      const excerpt = source.slice(0, Math.min(excerptLimit, remaining));
      if (!chunk.id || !excerpt) return [];
      remaining -= excerpt.length;
      return [{
        id: String(chunk.id || ""),
        printedPage: Number(chunk.printedPageStart) > 0
          ? `${chunk.printedPageStart}${Number(chunk.printedPageEnd) > Number(chunk.printedPageStart) ? `-${chunk.printedPageEnd}` : ""}`
          : "",
        catalogPath: String(chunk.catalogPath || "").slice(0, 220),
        excerpt,
      }];
    });
  };
  const knowledgeFamilyRevision = (bookId) => Number(questionFamilyStore.exportState().generatedAtByBook?.[bookId] || 0);
  const knowledgeTopologyRevision = (structure) => {
    const topology = (structure?.nodes || []).map((node) => ({
      id: String(node.id || ""),
      parentId: String(node.parentId || ""),
      kind: String(node.kind || ""),
      title: String(node.title || ""),
      displayTitle: String(node.displayTitle || ""),
      order: Number(node.order) || 0,
    })).sort((left, right) => left.id.localeCompare(right.id));
    const digest = crypto.createHash("sha256").update(JSON.stringify(topology)).digest("hex");
    return Number.parseInt(digest.slice(0, 13), 16);
  };
  const knowledgeClassificationReferencedNodeIds = (result) => [...new Set([
    result.agent2Verification?.primaryNodeId,
    ...(result.agent2Verification?.requiredNodeIds || []),
    ...(result.agent1Trajectories || []).flatMap((trajectory) => trajectory.terminalNodeIds || []),
  ].map(String).filter(Boolean))];
  const knowledgeClassificationStaleReasons = (result, context = {}) => {
    const reasons = [];
    const { question, structure, knowledge, latestResult, familyMembershipRevision } = context;
    if (result.status !== "pending_review") reasons.push("result_already_reviewed");
    if (!result.agent2Verification) reasons.push("result_not_reviewable");
    if (!question) reasons.push("question_deleted");
    else if (Number(question.version) !== Number(result.baseQuestionVersion)) reasons.push("question_version_changed");

    if (result.knowledgeRevisionFormat === "topology-v1") {
      if (!structure || knowledgeTopologyRevision(structure) !== Number(result.baseKnowledgeRevision)) reasons.push("knowledge_nodes_changed");
    } else {
      const nodeMap = new Map((structure?.nodes || []).map((node) => [node.id, node]));
      const invalidReference = knowledgeClassificationReferencedNodeIds(result)
        .some((nodeId) => nodeMap.get(nodeId)?.kind !== "knowledge");
      if (!structure || invalidReference) reasons.push("knowledge_nodes_changed");
    }

    if (Number(knowledge?.version || knowledge?.updatedAt || 0) !== Number(result.textbookKnowledgeVersion)) {
      reasons.push("textbook_knowledge_changed");
    }
    const currentFingerprint = (structure?.fingerprints || []).find((fingerprint) => fingerprint.questionId === result.questionId);
    const currentBaseline = knowledgeClassificationQuestionBaseline(currentFingerprint, familyMembershipRevision);
    if (result.classificationBaseline) {
      if (result.classificationBaseline.knowledgeFingerprintSignature !== currentBaseline.knowledgeFingerprintSignature) {
        reasons.push("question_knowledge_assignment_changed");
      }
      if (result.classificationBaseline.familyMembershipSignature !== currentBaseline.familyMembershipSignature) {
        reasons.push("question_family_memberships_changed");
      }
    } else {
      reasons.push("question_classification_baseline_missing");
    }
    if (latestResult && latestResult.id !== result.id) reasons.push("newer_result_available");
    return [...new Set(reasons)];
  };
  const knowledgeClassificationAnswerConflict = (question) => {
    if (!question || !objectiveQuestionTypes.has(question.type)) return null;
    const structured = [...new Set((question.correctAnswer || []).map((key) => String(key).trim().toUpperCase()).filter(Boolean))].sort();
    if (!structured.length) return null;
    const optionKeys = new Set((question.options || []).map((option) => String(option.key || "").trim().toUpperCase()).filter(Boolean));
    const officialAnswer = verifiedOfficialAnswer(question);
    const reference = String(officialAnswer || question.referenceAnswer || "").normalize("NFKC").trim();
    const match = reference.match(/^(?:(?:参考)?答案\s*[:：]?\s*)?([A-Z](?:\s*[,，、/]?\s*[A-Z])*)(?=$|[\s.。:：;；【（(])/i);
    if (!match) return null;
    const referenced = [...new Set((match[1].toUpperCase().match(/[A-Z]/g) || []).filter((key) => optionKeys.has(key)))].sort();
    if (!referenced.length || structured.join("") === referenced.join("")) return null;
    return {
      structuredAnswer: structured,
      referenceAnswer: referenced,
      authority: officialAnswer ? "verified_official" : "reference_answer",
      answerSource: question.answerSource || "missing",
      answerReviewStatus: question.answerReviewStatus || "unreviewed",
    };
  };
  const knowledgeClassificationRisk = (result, question = null) => {
    const trajectory = result.agent1Trajectories?.[0] || null;
    const verification = result.agent2Verification;
    const confidence = Number(verification?.confidence || trajectory?.confidence || 0);
    if (knowledgeClassificationAnswerConflict(question)
      || ["failed", "interrupted", "stale"].includes(result.status)
      || ["unable", "missing_node"].includes(verification?.decision)
      || ["unable", "none_of_candidates", "previous_level_wrong"].includes(trajectory?.stopReason)
      || confidence < 0.65) return "high";
    if (["move_parent", "move_sibling", "cross_knowledge"].includes(verification?.decision)
      || trajectory?.stopReason === "multiple" || confidence < 0.85) return "medium";
    return "low";
  };
  const knowledgeClassificationIssue = (result, question = null) => {
    const stopReason = result.agent1Trajectories?.[0]?.stopReason;
    const decision = result.agent2Verification?.decision;
    if (knowledgeClassificationAnswerConflict(question)) return "answer_conflict";
    if (result.status === "stale") return "stale";
    if (["failed", "interrupted"].includes(result.status)) return "failed";
    if (stopReason === "previous_level_wrong") return "previous_level_wrong";
    if (stopReason === "none_of_candidates" || decision === "missing_node") return "missing_node";
    if (stopReason === "unable" || decision === "unable") return "uncertain";
    if (["move_parent", "move_sibling"].includes(decision)) return "moved";
    if (decision === "cross_knowledge" || stopReason === "multiple") return "cross_knowledge";
    return "confirmed";
  };
  const classificationNodeScores = (question, structure, adjacency) => {
    const text = [
      question.stem,
      question.material,
      question.referenceAnswer,
      ...(question.options || []).map((option) => option.text),
      question.chapter,
      ...(question.knowledgePoints || []),
    ].filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase("zh-CN");
    const existing = (structure.fingerprints || []).find((fingerprint) => fingerprint.questionId === question.id);
    const existingAncestors = new Set();
    let current = existing?.primaryNodeId ? adjacency.byId.get(existing.primaryNodeId) : null;
    while (current) {
      existingAncestors.add(current.id);
      current = current.parentId ? adjacency.byId.get(current.parentId) : null;
    }
    return Object.fromEntries((structure.nodes || []).map((node) => {
      const title = String(node.displayTitle || node.title || "").normalize("NFKC").toLocaleLowerCase("zh-CN");
      let score = existingAncestors.has(node.id) ? 3 : 0;
      if (title && text.includes(title)) score += 2;
      [...title].filter((character) => /[\u3400-\u9fff]/.test(character)).forEach((character) => {
        if (text.includes(character)) score += 0.015;
      });
      score += Math.min(0.5, Number(node.knowledgeLevel || 0) * 0.02);
      return [node.id, score];
    }));
  };
  const runKnowledgeClassificationModel = async (
    sceneId,
    values,
    inputSummary,
    fallbackSceneId = "",
    routeOverrides = {},
    executionOptions = {},
  ) => {
    const config = aiConfigStore.load();
    let scene = configuredScene(config, sceneId, fallbackSceneId);
    if (executionOptions.routeSceneId) {
      const routeSceneId = String(executionOptions.routeSceneId);
      const route = config.routes[routeSceneId];
      const provider = route && route.mode === "provider"
        ? config.providers.find((item) => item.id === route.providerId && item.enabled)
        : null;
      if (provider) {
        scene = {
          route,
          provider,
          prompt: config.prompts[sceneId],
          configuredSceneId: routeSceneId,
        };
      }
    }
    if (!scene) throw new Error(`${sceneId}_route_unavailable`);
    const contextProfile = classificationPromptProfile(
      scene.prompt,
      values,
      inputSummary?.contextCounts || {},
    );
    const task = aiTaskStore.start(aiTaskMetadata(config, sceneId, {}, {
      providerId: scene.provider.id,
      providerName: scene.provider.name,
      protocol: scene.provider.protocol,
      model: scene.route.model,
      mode: "provider",
      inputSummary: { ...inputSummary, contextProfile },
    }));
    let completed = null;
    let parsed = null;
    try {
      const explicitTimeoutMs = Number(executionOptions.timeoutMs);
      const timeoutMs = Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0
        ? Math.max(1000, explicitTimeoutMs)
        : Math.max(120000, Number(scene.provider.timeoutMs) || 0);
      const requestedTemperature = routeOverrides.temperature ?? scene.route.temperature;
      completed = await completePromptWithTransientRetry(
        { ...scene.provider, timeoutMs },
        {
          ...scene.route,
          ...routeOverrides,
          temperature: Math.min(0.2, Math.max(0, Number.isFinite(Number(requestedTemperature))
            ? Number(requestedTemperature) : 0.1)),
        },
        scene.prompt,
        values,
        ({ attempt, error }) => aiTaskStore.update(task.id, {
          inputSummary: {
            retryCount: attempt,
            firstFailure: String(error?.message || error || "provider_retry"),
          },
        }),
        { jsonMode: true, maxRetries: executionOptions.maxRetries },
      );
      try {
        parsed = parseJsonContent(completed.completion.content);
      } catch (error) {
        if (executionOptions.invalidJsonErrorCode) throw new Error(executionOptions.invalidJsonErrorCode);
        throw error;
      }
      const validated = typeof executionOptions.validateRaw === "function"
        ? executionOptions.validateRaw(parsed) : null;
      aiTaskStore.finish(task.id, {
        status: "succeeded",
        chargeable: false,
        usage: completed.completion.usage,
        outputChars: completed.completion.content.length,
      });
      return {
        raw: parsed,
        validated,
        rawOutput: completed.completion.content,
        completion: completed.completion,
        configuredSceneId: scene.configuredSceneId,
        taskId: task.id,
      };
    } catch (error) {
      aiTaskStore.finish(task.id, {
        status: "failed",
        errorCode: error.message,
        failureStage: executionOptions.failureStage || sceneId,
      });
      error.aiTaskId = task.id;
      error.rawOutput = completed?.completion?.content || "";
      error.parsedOutput = parsed;
      error.configuredSceneId = scene.configuredSceneId;
      throw error;
    }
  };
  const knowledgeDossierScope = (bookId, nodeId) => {
    const structure = knowledgeStructureStore.get(bookId);
    if (!structure) throw new Error("knowledge_structure_not_found");
    const node = structure.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("knowledge_node_not_found");
    const descendantIds = knowledgeStructureStore.descendants(bookId, nodeId);
    const isExerciseNode = (item) => /思考和练习|复习与练习|练习题/.test(String(item?.displayTitle || item?.title || ""));
    if (isExerciseNode(node)) throw new Error("knowledge_dossier_exercise_scope_not_supported");
    const excludedNodeIds = new Set(structure.nodes
      .filter((item) => descendantIds.has(item.id) && isExerciseNode(item))
      .map((item) => item.id));
    const scopeNodeIds = new Set([...descendantIds].filter((id) => !excludedNodeIds.has(id)));
    const scopeNodes = structure.nodes.filter((item) => scopeNodeIds.has(item.id));
    const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: true });
    if (!knowledge?.chunks?.length) throw new Error("textbook_knowledge_not_built");
    const withinPageRange = (chunk) => {
      const printedStart = Number(node.startPage) || 0;
      const printedEnd = Number(node.endPage) || printedStart;
      const pdfStart = Number(node.pdfPageStart) || 0;
      const pdfEnd = Number(node.pdfPageEnd) || pdfStart;
      return (printedStart > 0 && Number(chunk.printedPageEnd || chunk.printedPageStart) >= printedStart
          && Number(chunk.printedPageStart || chunk.printedPageEnd) <= printedEnd)
        || (pdfStart > 0 && Number(chunk.pdfPageEnd || chunk.pdfPageStart) >= pdfStart
          && Number(chunk.pdfPageStart || chunk.pdfPageEnd) <= pdfEnd);
    };
    let chunks = knowledge.chunks.filter((chunk) => {
      const linkedNodeIds = [String(chunk.bodyHeadingId || ""), String(chunk.catalogNodeId || "")].filter(Boolean);
      if (linkedNodeIds.some((id) => excludedNodeIds.has(id))) return false;
      return chunk.enabled !== false && (
        linkedNodeIds.some((id) => scopeNodeIds.has(id))
        || withinPageRange(chunk)
      );
    });
    if (!chunks.length) chunks = textbookKnowledgeStore.search(bookId, `${node.path}\n${node.displayTitle || node.title}`, { limit: 30 });
    chunks = chunks.sort((left, right) => (
      Number(scopeNodeIds.has(String(right.bodyHeadingId || ""))) - Number(scopeNodeIds.has(String(left.bodyHeadingId || "")))
      || Number(left.pdfPageStart || 0) - Number(right.pdfPageStart || 0)
    )).slice(0, 60);
    return { structure, node, scopeNodes, chunks };
  };
  const exactDossierExcerpt = (chunk, proposed = "") => {
    const source = String(chunk?.retrievalText || chunk?.text || "").trim();
    const excerpt = String(proposed || "").trim();
    if (excerpt && source.includes(excerpt)) return excerpt.slice(0, 3000);
    return source.slice(0, 1200);
  };
  const normalizeCompiledDossier = (item, scope, runId) => {
    const chunkMap = new Map(scope.chunks.map((chunk) => [String(chunk.id), chunk]));
    const nodeMap = new Map(scope.structure.nodes.map((node) => [String(node.id), node]));
    const claims = (Array.isArray(item?.claims) ? item.claims : []).map((claim) => ({
      statement: String(claim?.statement || "").trim(),
      evidence: (Array.isArray(claim?.evidence) ? claim.evidence : []).map((evidence) => {
        const chunk = chunkMap.get(String(evidence?.chunkId || ""));
        if (!chunk) return null;
        return {
          chunkId: chunk.id,
          pdfPage: Number(chunk.pdfPageStart) || 0,
          printedPage: Number(chunk.printedPageStart) || 0,
          excerpt: exactDossierExcerpt(chunk, evidence.excerpt),
        };
      }).filter(Boolean),
    })).filter((claim) => claim.statement);
    const occurrences = (Array.isArray(item?.occurrences) ? item.occurrences : []).map((occurrence) => {
      const requestedNode = nodeMap.get(String(occurrence?.nodeId || ""));
      const occurrenceNode = requestedNode && scope.scopeNodes.some((node) => node.id === requestedNode.id)
        ? requestedNode
        : scope.node;
      const chunkIds = [...new Set((Array.isArray(occurrence?.chunkIds) ? occurrence.chunkIds : [])
        .map(String).filter((chunkId) => chunkMap.has(chunkId)))];
      const firstChunk = chunkMap.get(chunkIds[0]);
      return {
        nodeId: occurrenceNode.id,
        path: occurrenceNode.path,
        role: occurrence?.role,
        chunkIds,
        pdfPageStart: Number(firstChunk?.pdfPageStart || occurrenceNode.pdfPageStart) || 0,
        pdfPageEnd: Number(firstChunk?.pdfPageEnd || occurrenceNode.pdfPageEnd || firstChunk?.pdfPageStart) || 0,
        printedPageStart: Number(firstChunk?.printedPageStart || occurrenceNode.startPage) || 0,
        printedPageEnd: Number(firstChunk?.printedPageEnd || occurrenceNode.endPage || firstChunk?.printedPageStart) || 0,
        excerpt: firstChunk ? exactDossierExcerpt(firstChunk, occurrence?.excerpt) : "",
      };
    });
    if (!occurrences.length) {
      const firstChunk = scope.chunks[0];
      occurrences.push({
        nodeId: scope.node.id,
        path: scope.node.path,
        role: "mentions",
        chunkIds: firstChunk ? [firstChunk.id] : [],
        pdfPageStart: Number(firstChunk?.pdfPageStart || scope.node.pdfPageStart) || 0,
        pdfPageEnd: Number(firstChunk?.pdfPageEnd || scope.node.pdfPageEnd) || 0,
        printedPageStart: Number(firstChunk?.printedPageStart || scope.node.startPage) || 0,
        printedPageEnd: Number(firstChunk?.printedPageEnd || scope.node.endPage) || 0,
        excerpt: exactDossierExcerpt(firstChunk),
      });
    }
    return {
      bookId: scope.node.bookId,
      canonicalName: String(item?.canonicalName || "").trim(),
      aliases: item?.aliases,
      definition: item?.definition,
      inclusionCriteria: item?.inclusionCriteria,
      exclusionCriteria: item?.exclusionCriteria,
      claims,
      occurrences,
      relations: item?.relations,
      status: item?.action === "uncertain" ? "needs_review" : "draft",
      sourceRunId: runId,
    };
  };
  const dossierCompilationSchema = {
    dossiers: [{
      action: "new | merge | refine | supplement | uncertain",
      targetDossierId: "仅在处理已有档案时填写",
      canonicalName: "规范知识概念名称",
      aliases: ["教材中的其他名称"],
      definition: "严格依据教材的定义或说明",
      inclusionCriteria: ["属于本概念边界的判断条件"],
      exclusionCriteria: ["容易混入但不属于本概念的内容"],
      claims: [{ statement: "单一可核验事实声明", evidence: [{ chunkId: "输入中的真实片段 ID", excerpt: "该片段中的逐字原文" }] }],
      occurrences: [{ nodeId: "输入范围内真实目录节点 ID", role: "defines | overview | elaborates | supplements | example | exception | mentions | contradicts", chunkIds: ["真实片段 ID"], excerpt: "逐字原文" }],
      relations: [{ type: "is_a | part_of | prerequisite_for | supplements | contrasts_with | confusable_with", targetDossierId: "已有档案 ID", targetName: "目标概念名", direction: "outgoing | incoming | bidirectional", reason: "判断依据", evidenceChunkIds: ["真实片段 ID"] }],
      uncertainty: "证据不足或边界无法确定时说明",
    }],
    warnings: ["本轮无法解决的问题"],
  };
  const mergeDossierPatch = (current, patch = {}) => ({
    ...current,
    ...patch,
    aliases: [...new Set([...(current.aliases || []), ...(Array.isArray(patch.aliases) ? patch.aliases : [])])],
    inclusionCriteria: [...new Set([...(current.inclusionCriteria || []), ...(Array.isArray(patch.inclusionCriteria) ? patch.inclusionCriteria : [])])],
    exclusionCriteria: [...new Set([...(current.exclusionCriteria || []), ...(Array.isArray(patch.exclusionCriteria) ? patch.exclusionCriteria : [])])],
    claims: [...(current.claims || []), ...(Array.isArray(patch.claims) ? patch.claims : [])],
    occurrences: [...(current.occurrences || []), ...(Array.isArray(patch.occurrences) ? patch.occurrences : [])],
    relations: [...(current.relations || []), ...(Array.isArray(patch.relations) ? patch.relations : [])],
    status: current.status === "active" ? "needs_review" : (patch.status || current.status),
  });
  const independentQuestionFeatureProfile = (value, fallback = {}) => {
    const normalized = normalizeFeatureProfile(value, fallback);
    return {
      ...normalized,
      stemMatchedNodeIds: [],
      optionFeatures: normalized.optionFeatures.map((option) => (normalized.choiceStructure === "composed_options"
        ? { ...option }
        : { ...option, matchedNodeIds: [] })),
      atomicStatements: (normalized.atomicStatements || []).map((statement) => ({ ...statement, matchedNodeIds: [] })),
      coreKnowledgeNodeIds: [],
      requiredKnowledgeNodeIds: [],
      dependencySteps: normalized.dependencySteps.map((step) => ({ ...step, nodeIds: [] })),
      knowledgePriorities: normalized.knowledgePriorities.map((priority) => ({ ...priority, nodeIds: [] })),
    };
  };
  const runKnowledgeFeatureExtraction = async (question, structure, jobId, progress = {}) => {
    const fallback = independentQuestionFeatureProfile(extractQuestionClassificationFeatures(question, structure));
    knowledgeClassificationStore.updateJob(jobId, {
      currentQuestionId: question.id,
      currentQuestionIndex: Number(progress.questionIndex) || 0,
      currentDepth: 0,
      agent1CurrentQuestionId: question.id,
      agent1CurrentQuestionIndex: Number(progress.questionIndex) || 0,
      agent1CurrentDepth: 0,
      progressMessage: `Agent 1 正在提取第 ${Number(progress.questionIndex) || 1}/${Number(progress.total) || 1} 题的题干、选项与解题依赖`,
    });
    const diagnostics = [];
    let contractCorrection = null;
    let retryOfTaskId = "";
    const contractCodes = new Set([
      "knowledge_feature_extraction_json_invalid",
      "knowledge_feature_extraction_output_invalid",
      "knowledge_feature_extraction_question_mismatch",
      "knowledge_feature_extraction_contract_invalid",
    ]);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await runKnowledgeClassificationModel("knowledge_feature_extraction", {
          question: knowledgeClassificationQuestionPayload(question),
          contractCorrection,
          requiredOutput: {
            questionId: question.id,
            featureProfile: {
              optionKnowledgeProtocolVersion: OPTION_KNOWLEDGE_PROTOCOL_VERSION,
              choiceStructure: "direct_options | composed_options",
              questionMode: "stem_direct | option_judgement | material_analysis | composite（只描述题型，不代表知识关系）",
              stemKeywords: ["题干核心关键词"],
              coreKeywords: ["直接决定考查对象的核心关键词"],
              stemKnowledgeHints: ["题干直接询问的知识名称，不输出目录节点 id"],
              optionFeatures: [{
                key: "A",
                keywords: ["选项关键词"],
                knowledgeRelation: "直选题逐项必填 question_only | option_specific | undetermined；组合题的 A/B/C/D 不填此字段",
                knowledgeHints: ["仅 option_specific 时填写删除后无法判断该项的额外知识名称；其他关系必须为空"],
                uncertaintyNote: "仅 undetermined 时必填证据不足原因",
                isCorrect: true,
                role: "answer | distractor | statement",
                weight: 0.4,
                decisionRole: "supports_answer | required_for_elimination | incidental | unknown",
                requiredForDecision: true,
                basis: "执行删除检验后，为什么需要或不需要调用独立选项知识",
              }],
              atomicStatements: [{
                key: "①（仅 composed_options 使用，必须稳定且唯一）",
                text: "原子陈述原文",
                knowledgeRelation: "question_only | option_specific | undetermined",
                knowledgeHints: ["仅 option_specific 时填写"],
                uncertaintyNote: "仅 undetermined 时必填",
                verdict: "true | false | unknown",
                basis: "删除检验依据",
              }],
              optionComposition: [{ optionKey: "A", atomicKeys: ["①", "②"] }],
              primaryKnowledgeHints: ["核心考查知识名称"],
              secondaryKnowledgeHints: ["确实参与作答的辅助知识名称"],
              dependencySteps: [{
                order: 1,
                label: "解题依赖的知识或判断",
                source: "stem | option | material | answer | bridge",
                necessity: "core | required | secondary | incidental",
                dependencyRole: "independent_required | input_descriptor | terminology_only | absorbed_by_core | incidental",
                coveredByStepRef: "被其他步骤或核心规则覆盖时填写对应 dependencySteps ref，否则留空",
                basis: "调用理由",
              }],
              knowledgePriorities: [{ label: "知识名称", role: "primary | secondary", weight: 0.4, basis: "主次判断依据" }],
              primaryBasis: "核心考查知识与作答最小充分知识集的判断依据",
              crossFamilyProbability: 0.5,
              callDepth: 2,
            },
          },
        }, {
          jobId,
          questionId: question.id,
          phase: "feature_extraction",
          contractAttempt: attempt,
          retryOfTaskId,
        }, "knowledge_hierarchy_navigation", attempt === 2 ? { temperature: 0 } : {}, {
          invalidJsonErrorCode: "knowledge_feature_extraction_json_invalid",
          failureStage: "knowledge_feature_extraction",
          validateRaw: (raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)
              || !raw.featureProfile || typeof raw.featureProfile !== "object" || Array.isArray(raw.featureProfile)) {
              throw new Error("knowledge_feature_extraction_output_invalid");
            }
            if (String(raw.questionId || "") !== String(question.id)) {
              throw new Error("knowledge_feature_extraction_question_mismatch");
            }
            return validateFeatureProfileContract(raw.featureProfile, question);
          },
        });
        diagnostics.push({
          contractAttempt: attempt,
          taskId: response.taskId,
          retryOfTaskId,
          status: "valid",
          errorCode: "",
          violations: [],
          createdAt: Date.now(),
        });
        const features = independentQuestionFeatureProfile({ ...response.validated, extractionSource: "model" }, fallback);
        return {
          features,
          source: "model",
          configuredSceneId: response.configuredSceneId,
          model: String(response.completion?.model || ""),
          warning: "",
          diagnostics,
          rawFeatures: response.validated,
        };
      } catch (error) {
        const errorCode = String(error?.message || error || "knowledge_feature_extraction_failed");
        const contractError = contractCodes.has(errorCode);
        const violations = Array.isArray(error?.contractViolations) ? error.contractViolations : [];
        diagnostics.push({
          contractAttempt: attempt,
          taskId: error.aiTaskId || "",
          retryOfTaskId,
          status: contractError ? "contract_invalid" : "transport_failed",
          errorCode,
          violations,
          createdAt: Date.now(),
        });
        if (contractError && attempt < 2) {
          retryOfTaskId = error.aiTaskId || "";
          contractCorrection = {
            errorCode,
            violations,
            previousRawOutput: String(error.rawOutput || "").slice(0, 8000),
            instruction: "上一次输出违反选项知识关系 V2 合同。逐条修复 violations；必须完整覆盖全部选项或原子陈述，不得猜测、遗漏、重复或把组合项复制为知识项。只输出规定 JSON。",
          };
          continue;
        }
        const terminalError = new Error(contractError
          ? "knowledge_feature_extraction_contract_failed" : errorCode);
        terminalError.classificationOutcome = contractError
          ? "agent1_contract_failed" : "provider_or_infrastructure_failed";
        terminalError.featureExtractionDiagnostics = diagnostics;
        throw terminalError;
      }
    }
    throw new Error("knowledge_feature_extraction_contract_failed");
  };
  const runKnowledgeNavigation = async (question, structure, jobId, featureSnapshot, progress = {}) => {
    const adjacency = buildKnowledgeAdjacency(structure.nodes);
    const scores = classificationNodeScores(question, structure, adjacency);
    const evidence = compactClassificationEvidence(retrieveQuestionEvidence(question, "判断教材知识树归属", 6), 800);
    const activeDossiers = knowledgeDossierStore.list({ bookId: question.bookId }).filter((dossier) => dossier.status === "active");
    const confirmedFamilies = questionFamilyStore.list({ bookId: question.bookId, status: "confirmed" }).families;
    const steps = [];
    const usedRuleIds = new Set();
    const usedCaseIds = new Set();
    const navigationDiagnostics = [];
    const features = normalizeFeatureProfile(featureSnapshot);
    let currentNodeId = "";
    for (let depth = 0; depth < 20; depth += 1) {
      knowledgeClassificationStore.updateJob(jobId, {
        currentQuestionId: question.id,
        currentQuestionIndex: Number(progress.questionIndex) || 0,
        currentDepth: depth + 1,
        agent1CurrentQuestionId: question.id,
        agent1CurrentQuestionIndex: Number(progress.questionIndex) || 0,
        agent1CurrentDepth: depth + 1,
        progressMessage: `Agent 2 正在归类第 ${Number(progress.questionIndex) || 1}/${Number(progress.total) || 1} 题 · 第 ${depth + 1} 层候选`,
      });
      const candidates = directChildCandidates(adjacency, currentNodeId, { scores, limit: 5 });
      if (!candidates.length) throw new Error("knowledge_classification_candidates_empty");
      const candidateNodeIds = candidates.map((node) => node.id);
      const currentScopeNodeIds = new Set([currentNodeId, ...candidateNodeIds].filter(Boolean));
      const dossierContext = activeDossiers.filter((dossier) => (dossier.occurrences || [])
        .some((occurrence) => currentScopeNodeIds.has(occurrence.nodeId))).slice(0, 12).map((dossier) => ({
        id: dossier.id,
        canonicalName: dossier.canonicalName,
        inclusionCriteria: dossier.inclusionCriteria,
        exclusionCriteria: dossier.exclusionCriteria,
        occurrences: (dossier.occurrences || []).filter((occurrence) => currentScopeNodeIds.has(occurrence.nodeId))
          .map((occurrence) => ({ nodeId: occurrence.nodeId, path: occurrence.path, role: occurrence.role })),
      }));
      const familyContext = confirmedFamilies.filter((family) => currentScopeNodeIds.has(family.coreKnowledgeNodeId || family.knowledgeNodeId)
        || (family.requiredKnowledgeNodeIds || []).some((id) => currentScopeNodeIds.has(id)))
        .slice(0, 12).map((family) => ({
          id: family.id,
          name: family.name,
          coreKnowledgeNodeId: family.coreKnowledgeNodeId || family.knowledgeNodeId,
          requiredKnowledgeNodeIds: family.requiredKnowledgeNodeIds,
          assessmentAction: family.assessmentAction || "",
          inclusionBoundary: family.inclusionBoundary || "",
          exclusionBoundary: family.exclusionBoundary || "",
        }));
      const experience = classificationExperienceForQuestion(question, [currentNodeId, ...candidateNodeIds].filter(Boolean));
      experience.rules.forEach((rule) => usedRuleIds.add(rule.id));
      experience.cases.forEach((item) => usedCaseIds.add(item.id));
      const available = controlOptionAvailability(adjacency, currentNodeId, candidateNodeIds);
      available.multiple = available.multiple && candidates.every((node) => node.kind === "knowledge");
      const controlOptions = [
        available.stay && { id: "stay", label: "当前层级已经足够" },
        available.multiple && { id: "multiple", label: "涉及多个节点（必须选两个）" },
        { id: "unable", label: "无法确定" },
        { id: "none_of_candidates", label: "候选均不合适" },
        available.previous_level_wrong && { id: "previous_level_wrong", label: "上一层可能选错" },
      ].filter(Boolean);
      let step;
      let classificationCorrection = null;
      let retryOfTaskId = "";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await runKnowledgeClassificationModel("knowledge_hierarchy_navigation", {
            question: knowledgeClassificationQuestionPayload(question, { classificationCorrection }),
            currentPath: currentNodeId ? adjacency.byId.get(currentNodeId)?.path || "" : "知识树根节点",
            candidateNodes: candidates.map((node) => ({ id: node.id, title: node.displayTitle || node.title, kind: node.kind, path: node.path })),
            controlOptions,
            textbookEvidence: evidence,
            knowledgeDossiers: dossierContext,
            confirmedFamilies: familyContext,
            teachingRules: experience.rules,
            confirmedCases: experience.cases,
            questionFeatures: features,
            matchingStrategy: experience.matchingStrategy,
            requiredOutput: {
              questionId: question.id,
              decision: "node | stay | multiple | unable | none_of_candidates | previous_level_wrong",
              selectedNodeIds: ["仅从候选节点 id 中选择；控制选项为空数组"],
              corePathStatus: "core_path_viable | core_path_not_viable | uncertain",
              auxiliaryGap: {
                type: "auxiliary_gap",
                dependencyStepRefs: ["仅引用 questionFeatures.dependencySteps 中 dependencyRole=independent_required 的 ref；input_descriptor、terminology_only、absorbed_by_core 和 incidental 均不得引用；没有缺口时必须为 null"],
                reason: "核心路径可继续，但该作答依赖位于所选路径之外且无法继续下钻到达的原因",
              },
              candidateRejections: [{
                nodeId: "仅 none_of_candidates 时逐个填写全部候选 id；其他决策必须为空数组",
                reason: "该节点为何不能承载核心路径",
              }],
              confidence: 0.9,
              reason: "简要判断依据",
            },
          }, {
            jobId,
            questionId: question.id,
            depth: depth + 1,
            currentNodeId,
            candidateNodeIds,
            contractAttempt: attempt,
            retryOfTaskId,
          }, "", attempt === 2 ? { temperature: 0 } : {}, {
            invalidJsonErrorCode: "knowledge_classification_agent2_navigation_json_invalid",
            validateRaw: (raw) => {
              const normalized = normalizeAgent2NavigationOutput(raw, {
                adjacency,
                questionId: question.id,
                currentNodeId,
                candidateNodeIds,
                dependencySteps: features.dependencySteps,
              });
              if (normalized.decision === "multiple" && !available.multiple) {
                throw new Error("knowledge_classification_agent2_navigation_multiple_not_offered");
              }
              return normalized;
            },
          });
          step = response.validated;
          navigationDiagnostics.push({
            depth: depth + 1,
            parentNodeId: currentNodeId,
            candidateNodeIds,
            contractAttempt: attempt,
            taskId: response.taskId,
            retryOfTaskId,
            status: "valid",
            errorCode: "",
            rawOutput: response.rawOutput,
            parsedOutput: response.raw,
            createdAt: Date.now(),
          });
          break;
        } catch (error) {
          const contractError = isAgent2NavigationContractError(error);
          navigationDiagnostics.push({
            depth: depth + 1,
            parentNodeId: currentNodeId,
            candidateNodeIds,
            contractAttempt: attempt,
            taskId: error.aiTaskId || "",
            retryOfTaskId,
            status: contractError
              ? (String(error.message).endsWith("_json_invalid") ? "format_invalid" : "contract_invalid")
              : "transport_failed",
            errorCode: String(error.message || "knowledge_classification_navigation_failed"),
            rawOutput: error.rawOutput || "",
            parsedOutput: error.parsedOutput || null,
            createdAt: Date.now(),
          });
          if (!contractError) {
            error.navigationDiagnostics = navigationDiagnostics;
            error.classificationOutcome = "provider_or_infrastructure_failed";
            throw error;
          }
          if (attempt >= 2) {
            const terminalError = new Error("knowledge_classification_agent2_contract_failed");
            terminalError.navigationDiagnostics = navigationDiagnostics;
            terminalError.classificationOutcome = "agent2_contract_failed";
            throw terminalError;
          }
          retryOfTaskId = error.aiTaskId || "";
          const multipleNotOfferedCorrection = error.message === "knowledge_classification_agent2_navigation_multiple_not_offered"
            ? " 本次必须从 allowedCandidateNodeIds 中选择唯一核心路径：该路径必须承载 Agent 1 的主知识，并且其教材规则能够最直接推出答案。已有题族、题族样例和相似案例只能辅助检索，不得压过更直接的教材规则；宽泛上位路径不得压过具体且可直接作答的规则路径。其他位于所选核心路径之外、无法继续下钻到达的 independent_required 依赖，必须通过 auxiliaryGap 提交。"
            : "";
          classificationCorrection = {
            error: error.message,
            previousRawOutput: String(error.rawOutput || "").slice(0, 6000),
            previousDecision: String(error.parsedOutput?.decision || ""),
            previousSelectedNodeIds: Array.isArray(error.parsedOutput?.selectedNodeIds)
              ? error.parsedOutput.selectedNodeIds.map(String) : [],
            allowedCandidateNodeIds: candidateNodeIds,
            allowedControlOptionIds: controlOptions.map((option) => option.id),
            allowedAuxiliaryGapDependencyStepRefs: features.dependencySteps
              .filter((dependency) => dependency.dependencyRole === "independent_required").map((dependency) => dependency.ref),
            instruction: `上一次输出违反 Agent 2 合同。只输出规定 JSON；核心路径成立时必须继续导航。auxiliaryGap.dependencyStepRefs 只能引用 allowedAuxiliaryGapDependencyStepRefs，input_descriptor、terminology_only、absorbed_by_core 和 incidental 均不得引用。只有位于所选核心路径之外且无法继续下钻到达的独立必需知识才能写入 auxiliaryGap；同路径后代不算缺口。只有核心路径本身不成立时才能选择 none_of_candidates。${multipleNotOfferedCorrection}`,
          };
        }
      }
      steps.push(step);
      if (step.terminal) break;
      currentNodeId = step.selectedNodeIds[0];
    }
    return {
      trajectory: normalizeAgent1Trajectory({ questionId: question.id, steps }, { adjacency, questionId: question.id }),
      ruleIds: [...usedRuleIds],
      caseIds: [...usedCaseIds],
      navigationDiagnostics,
      classificationOutcome: steps.at(-1)?.stopReason === "none_of_candidates"
        ? "semantic_no_candidate"
        : (steps.some((item) => item.auxiliaryGap) ? "auxiliary_gap" : ""),
    };
  };
  const classificationChunksForNodes = (knowledge, structure, nodeIds) => {
    const byId = new Map((structure.nodes || []).map((node) => [node.id, node]));
    const wanted = (nodeIds || []).map((id) => byId.get(id)).filter(Boolean);
    const seen = new Set();
    return (knowledge.chunks || []).filter((chunk) => {
      const matches = wanted.some((node) => node.source === "body_heading"
        ? chunk.bodyHeadingId === node.id
        : (chunk.catalogNodeId === node.id || chunk.catalogPath === node.path || chunk.catalogPath?.startsWith(`${node.path} > `)));
      if (!matches || seen.has(chunk.id) || chunk.enabled === false || chunk.retrievalEnabled === false) return false;
      seen.add(chunk.id);
      return true;
    }).slice(0, 12);
  };
  // 章节参考资料桶：课本把"国际音标简表""记音符号对照表"等符号体系放在附录/记音符号标题下，
  // 关键词检索很难把它们排进前几名，但它们常常是作答必需的旁证（第 7 题把拼音字母映射到
  // 国际音标音值即如此）。这里按目录路径确定性地取该章 1 段，保证这类"课本里有、检索够不到"
  // 的内容至少进一次上下文。
  // 章节参考资料桶：课本把"国际音标简表""记音符号对照表"等符号体系放在附录/记音符号标题下，
  // 关键词检索很难把它们排进前几名，但它们常常是作答必需的旁证。
  // 注意：① 知识树路径用简称、教材目录用全称，不能用 startsWith 比前缀；
  //       ② **不能只按路径取第一段**——实测"附录二国际音标简表"下的可用片段正文其实是
  //          "隔音符号"教学提示（切片归属问题），按路径取会把无关内容塞进上下文。
  //          因此要求正文层面命中需求关键词，否则返回空（宁可不加，也不加错的）。
  const CLASSIFICATION_REFERENCE_NEED_PATTERN = /(国际音标|记音符号|注音符号|注音字母|拼音方案|音标|符号表)/;
  const classificationReferenceChunksForChapter = (knowledge, chapterPath, limit = 1) => {
    const core = String(chapterPath || "").trim()
      .replace(/^第[一二三四五六七八九十百零\d]+[章节编部分]\s*/u, "")
      .split(/[\s>＞]+/)[0]
      .trim();
    if (core.length < 2) return [];
    return (knowledge.chunks || []).filter((chunk) => {
      const path = String(chunk.catalogPath || "");
      if (chunk.enabled === false || chunk.retrievalEnabled === false) return false;
      if (!path.includes(core)) return false;
      if (!(path.includes("记音符号") || path.includes("附录"))) return false;
      // 内容层面校验：路径命中但正文无关的片段（如错挂在附录标题下的教学提示）一律不要。
      return CLASSIFICATION_REFERENCE_NEED_PATTERN.test(String(chunk.text || chunk.retrievalText || ""));
    }).slice(0, limit);
  };
  const classificationNodeIdsFromEvidence = (structure, adjacency, chunks, question) => {    const directIds = (chunks || []).flatMap((chunk) => [chunk.bodyHeadingId, chunk.catalogNodeId])
      .map(String).filter((id) => adjacency.byId.has(id));
    const evidenceText = [
      ...knowledgeClassificationBridgeTerms(question),
      ...(chunks || []).flatMap((chunk) => [
        chunk.catalogPath,
        chunk.bodyHeading,
        chunk.retrievalText,
        chunk.text,
      ]),
    ].filter(Boolean).join("\n").normalize("NFKC").toLocaleLowerCase("zh-CN");
    const titleMatches = (structure.nodes || []).filter((node) => {
      if (node.kind !== "knowledge") return false;
      const title = String(node.displayTitle || node.title || "").normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
      return title.length >= 3 && evidenceText.includes(title);
    }).sort((left, right) => String(right.displayTitle || right.title || "").length - String(left.displayTitle || left.title || "").length)
      .map((node) => node.id);
    const relatedIds = new Set([...directIds, ...titleMatches]);
    [...relatedIds].forEach((id) => {
      let current = adjacency.byId.get(id);
      while (current?.parentId) {
        relatedIds.add(current.parentId);
        current = adjacency.byId.get(current.parentId);
      }
    });
    return [...relatedIds].slice(0, 48);
  };
  const classificationNeighbourNodeIds = (adjacency, nodeIds, options = {}) => {
    const relatedIds = new Set(nodeIds || []);
    const siblingLimit = Number.isFinite(Number(options.siblingLimit))
      ? Math.max(0, Number(options.siblingLimit)) : Number.MAX_SAFE_INTEGER;
    (nodeIds || []).forEach((id) => {
      const node = adjacency.byId.get(id);
      if (!node?.parentId) return;
      relatedIds.add(node.parentId);
      (adjacency.childrenByParentId.get(node.parentId) || [])
        .filter((sibling) => sibling.id !== id)
        .slice(0, siblingLimit)
        .forEach((sibling) => relatedIds.add(sibling.id));
    });
    return [...relatedIds];
  };
  const classificationAuxiliaryGaps = (result) => (result?.agent1Trajectories || [])
    .flatMap((trajectory) => (trajectory.steps || []).map((step) => step.auxiliaryGap).filter(Boolean));
  const classificationAuxiliaryGapQuery = (result) => classificationAuxiliaryGaps(result).flatMap((gap) => [
    ...(gap.dependencies || []).map((dependency) => dependency.label),
    gap.reason,
  ]).filter(Boolean).join("\n").slice(0, 3000);
  const classificationNodeIdsFromAuxiliaryGaps = (structure, adjacency, result) => {
    const gaps = classificationAuxiliaryGaps(result);
    const directIds = gaps.flatMap((gap) => (gap.dependencies || []).flatMap((dependency) => dependency.nodeIds || []))
      .map(String).filter((id) => adjacency.byId.get(id)?.kind === "knowledge");
    const gapText = gaps.flatMap((gap) => [
      gap.reason,
      ...(gap.dependencies || []).map((dependency) => dependency.label),
    ]).filter(Boolean).join("\n").normalize("NFKC").toLocaleLowerCase("zh-CN");
    const gapLabels = [...new Set(gaps.flatMap((gap) => (gap.dependencies || [])
      .map((dependency) => String(dependency.label || "").normalize("NFKC").toLocaleLowerCase("zh-CN").trim())))]
      .filter((label) => label.length >= 2);
    const titleMatches = gapText ? (structure.nodes || []).flatMap((node) => {
      if (node.kind !== "knowledge") return [];
      const title = String(node.displayTitle || node.title || "").normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
      if (title.length < 2) return [];
      let score = gapText.includes(title) ? 10 + Math.min(20, title.length) : 0;
      gapLabels.forEach((label) => {
        if (title === label) score = Math.max(score, 100 + title.length);
        else if (title.includes(label) || label.includes(title)) score = Math.max(score, 50 + Math.min(title.length, label.length));
      });
      return score ? [{ id: node.id, score, path: node.path || "" }] : [];
    }).sort((left, right) => right.score - left.score
      || left.path.localeCompare(right.path, "zh-CN"))
      .map((item) => item.id) : [];
    return [...new Set([...directIds, ...titleMatches])].slice(0, MAX_AUXILIARY_GAP_NODE_MATCHES);
  };
  const supplementClassificationBridgeNodes = (verification, question, adjacency, candidateNodeIds) => {
    const bridgeTitles = new Set(knowledgeClassificationRequiredBridgeTitles(question)
      .map((title) => title.normalize("NFKC").toLocaleLowerCase("zh-CN")));
    if (!bridgeTitles.size) return verification;
    const bridgeNodeIds = (candidateNodeIds || []).filter((id) => {
      const node = adjacency.byId.get(id);
      const title = String(node?.displayTitle || node?.title || "").normalize("NFKC").toLocaleLowerCase("zh-CN");
      return node?.kind === "knowledge" && bridgeTitles.has(title);
    });
    if (!bridgeNodeIds.length) return verification;
    const existingHints = Array.isArray(verification.riskHints) ? verification.riskHints : [];
    const riskHints = bridgeNodeIds.map((nodeId) => {
      const node = adjacency.byId.get(nodeId);
      const title = node?.displayTitle || node?.title || nodeId;
      return {
        type: "bridge_candidate",
        source: "deterministic_keyword_bridge",
        nodeId,
        title,
        message: `系统检测到“${title}”可能参与结构位置、实际音值或发音性质转换；这只是候选风险提示，未通过删除检验前不进入最小充分知识集。`,
        requiresHumanReview: true,
      };
    });
    return {
      ...verification,
      riskHints: [...existingHints, ...riskHints],
    };
  };
  const runKnowledgeGlobalRecovery = async (job, result, question, structure) => {
    const adjacency = buildKnowledgeAdjacency(structure.nodes);
    const evidenceChunks = retrieveQuestionEvidence(question, "分层候选失败后检索整棵知识树", 12);
    const evidenceNodeIds = classificationNodeIdsFromEvidence(structure, adjacency, evidenceChunks, question);
    const experience = classificationExperienceForQuestion(question, evidenceNodeIds);
    const stopReason = result.agent1Trajectories?.[0]?.stopReason || "unable";
    const knowledgeTreeIndex = (structure.nodes || []).map((node) => ({
      id: node.id,
      parentId: node.parentId || "",
      title: node.displayTitle || node.title,
      path: node.path,
      kind: node.kind,
    }));
    const recoveryRunId = `knowledge-recovery-${crypto.randomUUID()}`;
    const totalBudgetMs = 170000;
    const deadline = Date.now() + totalBudgetMs;
    const knowledgeNodeCount = knowledgeTreeIndex.filter((node) => node.kind === "knowledge").length;
    const questionFeatures = result.agent1Features || extractQuestionClassificationFeatures(question, structure);
    const recoveryValues = (treeIndex, scope = "full_tree") => ({
      question: knowledgeClassificationQuestionPayload(question),
      questionFeatures,
      navigationFailure: {
        stopReason,
        trajectories: result.agent1Trajectories || [],
        scope,
        originalKnowledgeNodeCount: knowledgeNodeCount,
        offeredKnowledgeNodeCount: treeIndex.filter((node) => node.kind === "knowledge").length,
        instruction: scope === "full_tree"
          ? "原路径和前五候选只用于说明失败原因，不得限制整树检索。"
          : "这是从完整知识树按教材证据、原轨迹和文本相关性跨分支召回的限时备用候选。只能从提供节点选择；局部候选不足时输出 unable，不能据此声称知识树缺少节点。",
      },
      knowledgeTreeIndex: treeIndex,
      textbookEvidence: compactClassificationEvidence(evidenceChunks, 1200),
      teachingRules: experience.rules,
      confirmedCases: experience.cases,
      requiredOutput: {
        recoveries: [{
          questionId: question.id,
          decision: scope === "full_tree" ? "recover | unable | missing_node" : "recover | unable",
          primaryNodeId: "recover 时填写当前提供知识树索引中的核心考查 knowledge 节点 id",
          primaryNodeRole: "core | scope_anchor；默认 core",
          requiredNodeIds: ["recover 时填写作答的最小充分知识集；core 时包含 primaryNodeId，scope_anchor 时排除范围锚点"],
          confidence: 0.9,
          reason: "重新定位依据",
          uncertainty: "没有则留空",
          evidenceChunkIds: ["只能引用提供的教材证据 id"],
        }],
      },
    });
    const normalizeRecovery = (raw, allowedNodeIds = null) => normalizeGlobalRecoveryOutput(raw, {
      adjacency,
      questionIds: [question.id],
      evidenceChunkIdsByQuestion: { [question.id]: evidenceChunks.map((chunk) => chunk.id) },
      ...(allowedNodeIds ? { allowedNodeIds } : {}),
    }).recoveries[0];
    let recovery;
    let primaryError = null;
    try {
      const primary = await runKnowledgeClassificationModel("knowledge_global_recovery", recoveryValues(knowledgeTreeIndex), {
        jobId: job.id,
        questionId: question.id,
        stopReason,
        recoveryRunId,
        attemptIndex: 1,
        attemptKind: "full_primary",
        treeScope: "full_tree",
        knowledgeNodeCount,
        originalKnowledgeNodeCount: knowledgeNodeCount,
        timeoutMs: 120000,
        totalBudgetMs,
        budgetRemainingMs: totalBudgetMs,
      }, "knowledge_batch_verification", { maxTokens: 3500 }, {
        timeoutMs: 120000,
        maxRetries: 0,
        failureStage: "knowledge_global_recovery_primary",
        validateRaw: (raw) => normalizeRecovery(raw),
      });
      recovery = primary.validated;
    } catch (error) {
      primaryError = error;
      if (!isRetryableProviderFailure(error)) throw error;
    }
    if (!recovery) {
      const trajectorySteps = (result.agent1Trajectories || []).flatMap((trajectory) => trajectory.steps || []);
      const lastSteps = trajectorySteps.slice(-2);
      const trajectoryNodeIds = [...new Set(lastSteps.flatMap((step) => [
        step.parentNodeId,
        ...(step.candidateNodeIds || []),
        ...(step.selectedNodeIds || []),
        ...(step.terminalNodeIds || []),
      ]).map(String).filter(Boolean))];
      const scores = classificationNodeScores(question, structure, adjacency);
      const scoreNodeIds = (structure.nodes || []).filter((node) => node.kind === "knowledge")
        .sort((left, right) => Number(scores[right.id] || 0) - Number(scores[left.id] || 0)
          || String(left.path || left.title || "").localeCompare(String(right.path || right.title || ""), "zh-CN"))
        .slice(0, 20).map((node) => node.id);
      const evidenceSet = new Set(evidenceNodeIds);
      const trajectorySet = new Set(trajectoryNodeIds);
      const seedIds = [...new Set([...evidenceNodeIds, ...trajectoryNodeIds, ...scoreNodeIds])];
      const expandedIds = classificationNeighbourNodeIds(adjacency, seedIds);
      const fallbackNodeIds = [...new Set([...seedIds, ...expandedIds])]
        .filter((id) => adjacency.byId.get(id)?.kind === "knowledge")
        .sort((leftId, rightId) => (
          Number(evidenceSet.has(rightId)) - Number(evidenceSet.has(leftId))
          || Number(trajectorySet.has(rightId)) - Number(trajectorySet.has(leftId))
          || Number(scores[rightId] || 0) - Number(scores[leftId] || 0)
          || String(adjacency.byId.get(leftId)?.path || "").localeCompare(String(adjacency.byId.get(rightId)?.path || ""), "zh-CN")
        )).slice(0, 64);
      const fallbackIndex = fallbackNodeIds.map((id) => adjacency.byId.get(id)).filter(Boolean).map((node) => ({
        id: node.id,
        parentId: node.parentId || "",
        title: node.displayTitle || node.title,
        path: node.path,
        kind: node.kind,
      }));
      const config = aiConfigStore.load();
      const primaryScene = configuredScene(config, "knowledge_global_recovery", "knowledge_batch_verification");
      const primaryRoute = primaryScene?.route;
      const fallbackRoute = config.routes.knowledge_batch_verification;
      const primaryProvider = primaryScene?.provider;
      const fallbackProvider = config.providers.find((provider) => provider.id === fallbackRoute?.providerId && provider.enabled);
      const differentRoute = Boolean(fallbackProvider && fallbackRoute?.mode === "provider"
        && (fallbackProvider.id !== primaryProvider?.id || fallbackRoute.model !== primaryRoute?.model));
      const sufficientlySmaller = knowledgeNodeCount > 0 && fallbackNodeIds.length <= Math.floor(knowledgeNodeCount * 0.35);
      if (!fallbackIndex.length || (!differentRoute && !sufficientlySmaller)) {
        const unavailable = new Error("knowledge_global_recovery_fallback_unavailable");
        unavailable.classificationOutcome = "provider_or_infrastructure_failed";
        throw unavailable;
      }
      const remainingMs = deadline - Date.now() - 5000;
      if (remainingMs < 1000) {
        const exhausted = new Error("knowledge_global_recovery_exhausted");
        exhausted.classificationOutcome = "provider_or_infrastructure_failed";
        throw exhausted;
      }
      try {
        const fallback = await runKnowledgeClassificationModel("knowledge_global_recovery", recoveryValues(fallbackIndex, "evidence_scoped"), {
          jobId: job.id,
          questionId: question.id,
          stopReason,
          recoveryRunId,
          attemptIndex: 2,
          attemptKind: "fallback_scoped",
          parentTaskId: primaryError?.aiTaskId || "",
          fallbackReason: primaryError?.message || "provider_timeout",
          treeScope: "evidence_scoped",
          knowledgeNodeCount: fallbackNodeIds.length,
          originalKnowledgeNodeCount: knowledgeNodeCount,
          timeoutMs: Math.min(45000, remainingMs),
          totalBudgetMs,
          budgetRemainingMs: Math.max(0, deadline - Date.now()),
        }, "knowledge_batch_verification", { maxTokens: 2500, temperature: 0 }, {
          routeSceneId: differentRoute ? "knowledge_batch_verification" : "",
          timeoutMs: Math.min(45000, remainingMs),
          maxRetries: 0,
          failureStage: "knowledge_global_recovery_fallback",
          validateRaw: (raw) => normalizeRecovery(raw, fallbackNodeIds),
        });
        recovery = fallback.validated;
        if (recovery.decision === "missing_node") {
          recovery = {
            ...recovery,
            decision: "unable",
            primaryNodeId: "",
            requiredNodeIds: [],
            uncertainty: [recovery.uncertainty, "限时备用候选不足，不能据此判断知识树缺少节点。"].filter(Boolean).join(" "),
          };
        }
      } catch (error) {
        const exhausted = new Error("knowledge_global_recovery_exhausted");
        exhausted.causeCode = error.message;
        exhausted.classificationOutcome = "provider_or_infrastructure_failed";
        throw exhausted;
      }
    }
    return {
      recovery: { ...recovery, recoveredFrom: stopReason },
      ruleIds: experience.rules.map((rule) => rule.id),
      caseIds: experience.cases.map((item) => item.id),
    };
  };
  const uniqueClassificationChunks = (chunks, limit) => {
    const seen = new Set();
    return (chunks || []).filter((chunk) => {
      const id = String(chunk?.id || "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, limit);
  };
  // 同一教材节点只允许贡献少量片段。实测第 7 题（dff6df0a）6 个证据名额中有 3 个来自
  // 同一个"普通话元音音位"节点，属纯预算浪费，挤掉了"国际音标/记音符号"这类必要旁证。
  const capClassificationChunksPerNode = (chunks, perNodeLimit) => {
    const usedByNode = new Map();
    return (chunks || []).filter((chunk) => {
      const nodeKey = String(chunk?.catalogPath || chunk?.catalogNodeId || chunk?.nodeId || chunk?.id || "");
      const used = usedByNode.get(nodeKey) || 0;
      if (used >= perNodeLimit) return false;
      usedByNode.set(nodeKey, used + 1);
      return true;
    });
  };
  // 题干、选项或知识路径出现"符号体系/语音"类线索时，额外检索记音符号/国际音标/拼音方案等片段。
  // 实测第 7 题要把拼音字母映射到国际音标音值，而课本里"三、记音符号 >（二）国际音标"
  // 与"附录二国际音标简表"两处内容在一次运行中从未被检索出来，模型只能凭选项的音值描写去猜。
  // 注意：触发不能只看题干文字——第 7 题题干与选项里都没有"国际音标"字样，只有"前、低、不圆唇元音"
  // 这类音值描写，因此必须同时看知识路径（该题终止节点位于「第一章语音」下）。
  const CLASSIFICATION_SYMBOL_TEXT_PATTERN = /(国际音标|注音符号|注音字母|记音符号|拼音方案|拼写规则|正词法|字母表|音值|符号表)/;
  const CLASSIFICATION_PHONETIC_PATH_PATTERN = /(语音|音位|音值|元音|辅音|声母|韵母|声调)/;
  const classificationSymbolEvidenceQuery = (question, pathText = "") => {
    const questionText = [
      question?.stem,
      question?.material,
      ...(question?.options || []).map((option) => option.text),
    ].filter(Boolean).join(" ");
    // 题干/选项直接点了符号体系 → 给 2 段；只是知识路径落在语音范围 → 给 1 段，避免稀释其他题。
    if (CLASSIFICATION_SYMBOL_TEXT_PATTERN.test(questionText)) {
      return { query: "核对题目涉及的国际音标、注音符号、记音符号与符号对照表", limit: 2 };
    }
    if (CLASSIFICATION_PHONETIC_PATH_PATTERN.test(String(pathText || ""))) {
      return { query: "国际音标、注音符号、记音符号与符号对照表", limit: 1 };
    }
    return null;
  };
  const compactAgent3FamilySample = (question, budget) => {
    if (!question || budget < 120) return null;
    const sample = {
      stem: String(question.stem || "").slice(0, 500),
      options: (question.options || []).slice(0, 10).map((option) => ({
        key: option.key,
        text: String(option.text || "").slice(0, 180),
      })),
    };
    while (JSON.stringify(sample).length > budget) {
      if (sample.stem.length > 80) {
        sample.stem = sample.stem.slice(0, Math.max(80, Math.floor(sample.stem.length * 0.7)));
        continue;
      }
      const longest = sample.options.reduce((selected, option) => (
        option.text.length > (selected?.text.length || 0) ? option : selected
      ), null);
      if (!longest || longest.text.length <= 40) return null;
      longest.text = longest.text.slice(0, Math.max(40, Math.floor(longest.text.length * 0.7)));
    }
    return sample;
  };
  const compactAgent3Families = (families, limits, options = {}) => {
    const excludedQuestionIds = new Set((options.excludeQuestionIds || []).map(String));
    const question = options.question || null;
    const queryText = [
      question?.stem,
      question?.material,
      ...(question?.options || []).map((option) => option.text),
      ...(options.features?.coreKeywords || []),
      ...(options.features?.primaryKnowledgeHints || []),
      ...(options.features?.dependencySteps || []).map((step) => step.label),
    ].filter(Boolean).join(" ");
    const preferredNodeIds = new Set((options.preferredNodeIds || []).map(String));
    const ranked = (families || []).map((family) => {
      const confirmedMembers = (family.members || [])
        .filter((member) => member.reviewStatus === "confirmed" && member.questionId);
      const confirmedQuestions = questionStore.getMany(confirmedMembers.map((member) => String(member.questionId)))
        .filter((candidate) => candidate && candidate.status !== "offline" && !mergedQuestionTargetId(candidate));
      const confirmedQuestionById = new Map(confirmedQuestions.map((candidate) => [String(candidate.id), candidate]));
      // 已确认成员即可作为参照样题：不再额外要求该族必须存在 prototype 成员。
      // 原条件会把「只有已确认普通成员」的题族完全剥夺参照题（实测「名字拼写规范」
      // 与「a的音位变体」都留下了已确认样题却被挡掉），这属于没有动用人工审核成果。
      // 选取时按与本题题干/选项的相关性排序，prototype 只作为轻微加权。
      const sampleCandidates = family.status === "confirmed"
        ? confirmedMembers
          .map((member) => ({
            question: confirmedQuestionById.get(String(member.questionId)) || null,
            isPrototype: member.role === "prototype",
          }))
          .filter((item) => item.question && !excludedQuestionIds.has(String(item.question.id)))
          .map((item) => {
            const text = [
              item.question.stem,
              ...(item.question.options || []).map((option) => option.text),
            ].filter(Boolean).join(" ");
            return { ...item, score: actionTextSimilarity(queryText, text) + (item.isPrototype ? 0.15 : 0) };
          })
          .sort((left, right) => right.score - left.score)
        : [];
      const sampleQuestion = sampleCandidates[0]?.question || null;
      const familyText = [
        family.name,
        family.focusKey,
        family.assessmentAction,
        family.inclusionBoundary,
        family.exclusionBoundary,
        sampleQuestion?.stem,
        ...(sampleQuestion?.options || []).map((option) => option.text),
      ].filter(Boolean).join(" ");
      const knowledgeIds = [
        family.coreKnowledgeNodeId || family.knowledgeNodeId,
        ...(family.requiredKnowledgeNodeIds || []),
      ].map(String).filter(Boolean);
      const knowledgeScore = knowledgeIds.reduce((score, id) => score + (preferredNodeIds.has(id) ? 1 : 0), 0);
      return {
        family,
        sampleQuestion,
        score: knowledgeScore * 3 + actionTextSimilarity(queryText, familyText) * 5,
      };
    });
    const ordered = ranked.sort((left, right) => (
      right.score - left.score
      || Number(right.family.updatedAt || 0) - Number(left.family.updatedAt || 0)
      || String(left.family.id || "").localeCompare(String(right.family.id || ""))
    ));
    const selected = [
      ...ordered.filter((item) => item.family.status === "confirmed").slice(0, limits.confirmedFamilies),
      ...ordered.filter((item) => item.family.status !== "confirmed").slice(0, limits.pendingFamilies),
    ];
    let sampleBudget = limits.familySampleChars;
    let remainingSampleCount = limits.familySampleCount;
    return selected.map(({ family, sampleQuestion }) => {
      const sample = remainingSampleCount > 0 ? compactAgent3FamilySample(sampleQuestion, sampleBudget) : null;
      const sampleChars = sample ? JSON.stringify(sample).length : 0;
      sampleBudget = Math.max(0, sampleBudget - sampleChars);
      if (sample) remainingSampleCount -= 1;
      return {
        id: family.id,
        name: family.name,
        status: family.status,
        coreKnowledgeNodeId: family.coreKnowledgeNodeId || family.knowledgeNodeId,
        requiredKnowledgeNodeIds: (family.requiredKnowledgeNodeIds || []).slice(0, 8),
        textbookAnchorNodeIds: (family.textbookAnchorNodeIds || [family.knowledgeNodeId].filter(Boolean)).slice(0, 4),
        assessmentAction: String(family.assessmentAction || "").slice(0, 120),
        inclusionBoundary: String(family.inclusionBoundary || "").slice(0, 180),
        exclusionBoundary: String(family.exclusionBoundary || "").slice(0, 180),
        focusKey: family.focusKey,
        sampleQuestions: sample ? [sample] : [],
      };
    });
  };
  const runKnowledgeVerificationBatch = async (job, batch, questions, structure, knowledge) => {
    const adjacency = buildKnowledgeAdjacency(structure.nodes);
    const questionMap = new Map(questions.map((question) => [question.id, question]));
    const results = knowledgeClassificationStore.results({ jobId: job.id, limit: 1000 });
    const resultMap = new Map(results.map((result) => [result.questionId, result]));
    const terminalNodeIdsByQuestion = {};
    const evidenceChunkIdsByQuestion = {};
    const terminalDirectEvidenceChunkIdsByQuestion = {};
    const candidateNodeIdsByQuestion = {};
    const evidenceById = new Map();
    const relatedNodeIds = new Set();
    const experienceByQuestion = {};
    const candidateFamiliesByQuestion = {};
    const candidateDossiersByQuestion = {};
    const candidateSelectionStatsByQuestion = {};
    const candidateFamilyStatsByQuestion = {};
    const symbolEvidenceDebugByQuestion = {};
    const allFamilies = questionFamilyStore.list({ bookId: job.bookId, status: "all" }).families;
    const usableDossiers = knowledgeDossierStore.list({ bookId: job.bookId })
      .filter((dossier) => dossier.status === "active");
    batch.questionIds.forEach((questionId) => {
      const result = resultMap.get(questionId);
      terminalNodeIdsByQuestion[questionId] = batch.terminalNodeIdsByQuestion?.[questionId]
        || result?.agent1Trajectories?.flatMap((trajectory) => trajectory.terminalNodeIds || []) || [];
      const question = questionMap.get(questionId);
      const auxiliaryGapQuery = classificationAuxiliaryGapQuery(result);
      const auxiliaryGapNodeIds = classificationNodeIdsFromAuxiliaryGaps(structure, adjacency, result);
      const directChunks = classificationChunksForNodes(knowledge, structure, terminalNodeIdsByQuestion[questionId]);
      const terminalDirectChunks = uniqueClassificationChunks(
        terminalNodeIdsByQuestion[questionId].flatMap((nodeId) => (
          classificationChunksForNodes(knowledge, structure, [nodeId]).slice(0, 1)
        )),
        terminalNodeIdsByQuestion[questionId].length,
      );
      const searchedChunks = retrieveQuestionEvidence(question, "复核知识点、跨知识关联与具体考查维度", 6);
      const auxiliarySearchedChunks = auxiliaryGapQuery
        ? retrieveQuestionEvidence(question, `复核 Agent 2 交接的跨路径辅助作答依赖：\n${auxiliaryGapQuery}`, 8)
        : [];
      const auxiliaryDirectChunks = classificationChunksForNodes(knowledge, structure, auxiliaryGapNodeIds);
      const terminalPathText = terminalNodeIdsByQuestion[questionId]
        .map((nodeId) => adjacency.byId.get(nodeId)?.path || "")
        .filter(Boolean)
        .join(" ");
      const symbolEvidence = classificationSymbolEvidenceQuery(question, terminalPathText);
      const symbolSearchedChunks = symbolEvidence
        ? retrieveQuestionEvidence(question, symbolEvidence.query, symbolEvidence.limit + 2)
        : [];
      // 仅当知识路径落在语音范围时，补该章的附录/记音符号参考资料 1 段。
      const chapterReferenceChunks = CLASSIFICATION_PHONETIC_PATH_PATTERN.test(terminalPathText)
        ? classificationReferenceChunksForChapter(knowledge, terminalPathText.split(" > ")[0], 1)
        : [];
      symbolEvidenceDebugByQuestion[questionId] = {
        terminalPathText: terminalPathText.slice(0, 200),
        chapterPrefix: terminalPathText.split(" > ")[0] || "",
        symbolQuery: symbolEvidence ? symbolEvidence.query : "",
        symbolHitCount: symbolSearchedChunks.length,
        referenceHitCount: chapterReferenceChunks.length,
        referenceChunkIds: chapterReferenceChunks.map((chunk) => String(chunk.id || "")),
      };
      const offered = capClassificationChunksPerNode(
        uniqueClassificationChunks([
          ...terminalDirectChunks,
          ...chapterReferenceChunks,
          ...symbolSearchedChunks.slice(0, symbolEvidence ? symbolEvidence.limit : 0),
          ...searchedChunks.slice(0, 3),
          ...directChunks,
          ...auxiliarySearchedChunks.slice(0, 2),
          ...auxiliaryDirectChunks.slice(0, 1),
        ], AGENT3_CONTEXT_LIMITS.primary.evidenceChunks * 3),
        2,
      ).slice(0, AGENT3_CONTEXT_LIMITS.primary.evidenceChunks);
      offered.forEach((chunk) => { if (!evidenceById.has(chunk.id)) evidenceById.set(chunk.id, chunk); });
      evidenceChunkIdsByQuestion[questionId] = [...new Set(offered.map((chunk) => chunk.id))];
      terminalDirectEvidenceChunkIdsByQuestion[questionId] = terminalDirectChunks.map((chunk) => chunk.id);
      const evidenceNodeIds = classificationNodeIdsFromEvidence(structure, adjacency, offered, question);
      const terminalKnowledgeIds = terminalNodeIdsByQuestion[questionId]
        .filter((id) => adjacency.byId.get(id)?.kind === "knowledge");
      const terminalNeighbourIds = classificationNeighbourNodeIds(
        adjacency,
        terminalKnowledgeIds,
        { siblingLimit: 8 },
      ).filter((id) => !terminalKnowledgeIds.includes(id));
      const auxiliaryNeighbourIds = classificationNeighbourNodeIds(
        adjacency,
        auxiliaryGapNodeIds,
        { siblingLimit: MAX_AUXILIARY_GAP_SIBLINGS_PER_NODE },
      ).filter((id) => !auxiliaryGapNodeIds.includes(id));
      const candidateBuckets = {
        terminal: terminalKnowledgeIds,
        auxiliaryDirect: auxiliaryGapNodeIds,
        evidenceDirect: evidenceNodeIds,
        terminalNeighbours: terminalNeighbourIds,
        auxiliaryNeighbours: auxiliaryNeighbourIds,
      };
      const allCandidateIds = [...new Set(Object.values(candidateBuckets).flat())]
        .filter((id) => adjacency.byId.get(id)?.kind === "knowledge");
      const candidateIds = allCandidateIds.slice(0, MAX_AGENT3_CANDIDATE_KNOWLEDGE_NODES);
      candidateSelectionStatsByQuestion[questionId] = {
        offered: candidateIds.length,
        totalBeforeLimit: allCandidateIds.length,
        dropped: Math.max(0, allCandidateIds.length - candidateIds.length),
        bucketCounts: Object.fromEntries(Object.entries(candidateBuckets).map(([key, ids]) => [key, ids.length])),
        auxiliaryDirectOffered: auxiliaryGapNodeIds.filter((id) => candidateIds.includes(id)).length,
        // 留痕：候选知识节点的实际 ID。此前只记数量，无法判断"金标用的节点是被位置截断丢掉、
        // 还是发出去了却没被模型选中"。桶内是按位置切（无相关性排序），故必须记 ID 与所属桶。
        offeredNodeIds: [...candidateIds],
        droppedNodeIds: allCandidateIds.filter((id) => !candidateIds.includes(id)),
        bucketNodeIds: Object.fromEntries(Object.entries(candidateBuckets)
          .map(([key, ids]) => [key, [...new Set(ids)]])),
      };
      candidateIds.forEach((id) => relatedNodeIds.add(id));
      candidateNodeIdsByQuestion[questionId] = candidateIds;
      const candidateNodeSet = new Set(candidateNodeIdsByQuestion[questionId]);
      candidateDossiersByQuestion[questionId] = usableDossiers.filter((dossier) => dossier.occurrences
        .some((occurrence) => candidateNodeSet.has(occurrence.nodeId)))
        .slice(0, AGENT3_CONTEXT_LIMITS.primary.dossiers)
        .map((dossier) => compactAgent3Dossier(dossier, candidateNodeSet, AGENT3_CONTEXT_LIMITS.primary));
      experienceByQuestion[questionId] = classificationExperienceForQuestion(question, candidateNodeIdsByQuestion[questionId]);
      const candidateFamilyPool = allFamilies.filter((family) => candidateNodeSet.has(family.knowledgeNodeId)
        || candidateNodeSet.has(family.coreKnowledgeNodeId)
        || (family.requiredKnowledgeNodeIds || []).some((id) => candidateNodeSet.has(id)));
      candidateFamiliesByQuestion[questionId] = compactAgent3Families(candidateFamilyPool, AGENT3_CONTEXT_LIMITS.primary, {
        question,
        features: result?.agent1Features || null,
        preferredNodeIds: [...terminalKnowledgeIds, ...auxiliaryGapNodeIds],
        excludeQuestionIds: batch.questionIds,
      });
      candidateFamilyStatsByQuestion[questionId] = {
        pool: candidateFamilyPool.length,
        offered: candidateFamiliesByQuestion[questionId].length,
        truncated: Math.max(0, candidateFamilyPool.length - candidateFamiliesByQuestion[questionId].length),
        // 实际候选留痕：记录过滤后（pool）与最终发出（offered）的题族 ID，以及哪些族带上了样题。
        // 只有数量不足以定位"正确题族是在哪一步被裁掉或被忽略"，必须留 ID 才能事后核对。
        poolFamilyIds: candidateFamilyPool.map((family) => String(family.id || "")).filter(Boolean),
        offeredFamilyIds: candidateFamiliesByQuestion[questionId]
          .map((family) => String(family.id || "")).filter(Boolean),
        sampledFamilyIds: candidateFamiliesByQuestion[questionId]
          .filter((family) => (family.sampleQuestions || []).length)
          .map((family) => String(family.id || "")).filter(Boolean),
        excludedSelfSampleCount: candidateFamilyPool.filter((family) => (family.members || [])
          .some((member) => String(member.questionId || "") === String(questionId))).length,
        excludedSelfCaseCount: experienceByQuestion[questionId].excludedSelfCaseCount,
      };
    });
    const verificationRequest = (agent3Correction = null, mode = "primary") => {
      const limits = AGENT3_CONTEXT_LIMITS[mode] || AGENT3_CONTEXT_LIMITS.primary;
      const modeCandidateNodeIdsByQuestion = Object.fromEntries(batch.questionIds.map((questionId) => [
        questionId,
        candidateNodeIdsByQuestion[questionId].slice(0, limits.relatedNodes),
      ]));
      const prioritizedRelatedIds = [...new Set([
        ...batch.questionIds.flatMap((questionId) => modeCandidateNodeIdsByQuestion[questionId]),
        ...relatedNodeIds,
      ])].slice(0, limits.relatedNodes);
      const modeEvidenceChunkIdsByQuestion = Object.fromEntries(batch.questionIds.map((questionId) => [
        questionId,
        [...new Set([
          ...(terminalDirectEvidenceChunkIdsByQuestion[questionId] || []),
          ...(evidenceChunkIdsByQuestion[questionId] || []),
        ])].slice(0, limits.evidenceChunks),
      ]));
      const modeEvidenceIds = new Set(batch.questionIds.flatMap((questionId) => modeEvidenceChunkIdsByQuestion[questionId]));
      const modeFamiliesByQuestion = Object.fromEntries(batch.questionIds.map((questionId) => {
        const families = candidateFamiliesByQuestion[questionId] || [];
        const selected = [
          ...families.filter((family) => family.status === "confirmed").slice(0, limits.confirmedFamilies),
          ...families.filter((family) => family.status !== "confirmed").slice(0, limits.pendingFamilies),
        ];
        let sampleBudget = limits.familySampleChars;
        let remainingSampleCount = limits.familySampleCount;
        return [questionId, selected.map((family) => {
          const sample = (family.sampleQuestions || [])[0];
          const sampleChars = sample ? JSON.stringify(sample).length : 0;
          const includeSample = remainingSampleCount > 0 && sample && sampleChars <= sampleBudget;
          if (includeSample) {
            sampleBudget -= sampleChars;
            remainingSampleCount -= 1;
          }
          return { ...family, sampleQuestions: includeSample ? [sample] : [] };
        })];
      }));
      const values = {
        knowledgeNode: batch.terminalNodeIds.map((id) => adjacency.byId.get(id)).filter(Boolean).map((node) => ({
          id: node.id,
          title: node.displayTitle || node.title,
          path: String(node.path || "").slice(0, 220),
        })),
        relatedNodes: prioritizedRelatedIds.map((id) => adjacency.byId.get(id)).filter(Boolean).map((node) => ({
          id: node.id,
          parentId: node.parentId,
          title: node.displayTitle || node.title,
        })),
      questions: batch.questionIds.map((id) => compactAgent3QuestionPayload(questionMap.get(id), {
        candidateKnowledgeNodeIds: modeCandidateNodeIdsByQuestion[id],
      })),
      navigationResults: batch.questionIds.map((id) => compactAgent3Navigation(
        resultMap.get(id),
        batch.recoveredFromByQuestion?.[id] || "",
      )),
      questionFeatures: batch.questionIds.map((id) => ({
        questionId: id,
        features: compactAgent3FeatureProfile(resultMap.get(id)?.agent1Features || null, limits),
      })),
      textbookEvidence: compactClassificationEvidence(
        [...evidenceById.values()].filter((chunk) => modeEvidenceIds.has(chunk.id)),
        limits.evidenceExcerptChars,
        limits.evidenceTotalChars,
      ),
      knowledgeDossiers: batch.questionIds.map((questionId) => ({
        questionId,
        dossiers: candidateDossiersByQuestion[questionId].slice(0, limits.dossiers)
          .map((dossier) => ({ ...dossier, claims: (dossier.claims || []).slice(0, limits.dossierClaims) })),
      })),
      teachingRules: batch.questionIds.map((questionId) => ({
        questionId,
        rules: experienceByQuestion[questionId].rules.slice(0, limits.rules).map(compactAgent3Rule),
      })),
      confirmedCases: batch.questionIds.map((questionId) => ({
        questionId,
        cases: experienceByQuestion[questionId].cases.slice(0, limits.cases).map(compactAgent3Case),
      })),
      matchingStrategies: batch.questionIds.map((questionId) => ({ questionId, strategy: experienceByQuestion[questionId].matchingStrategy })),
      candidateFamilies: batch.questionIds.map((questionId) => ({ questionId, families: modeFamiliesByQuestion[questionId] })),
      agent3Correction,
      requiredOutput: {
        verifications: batch.questionIds.map((questionId) => ({
          questionId,
          decision: "confirm | move_parent | move_sibling | cross_knowledge | unable | missing_node；单节点严禁 cross_knowledge",
          primaryNodeId: "必须是输入中的 knowledge 节点；无法确定时留空",
          primaryNodeRole: "core | scope_anchor；默认 core。只有主节点仅表示整题范围、且至少有一个 required 后代节点时才用 scope_anchor",
          requiredNodeIds: ["作答最小充分 knowledge 集；core 时必须含主节点，scope_anchor 时不得包含范围锚点"],
          requiredNodeAssessments: [{
            nodeId: "每个非核心 requiredNodeId 必须且只能填写一次；只有核心节点时为空数组",
            dependencyStepRefs: ["只能引用 Agent 1 中 dependencyRole=independent_required 且未被 coveredByStepRef 覆盖的真实 ref"],
            necessaryAfterDeletionTest: true,
            deletionTest: "删除该节点后为何无法仅凭核心规则可靠完成作答",
            entailedByPrimaryRule: false,
            reason: "该节点独立参与哪个判定步骤；题面已给标签、前置背景、术语解释和核心规则已吸收的概念不得填写",
          }],
          optionRelationAssessments: [{
            key: "直选题使用 A/B/C/D；组合题使用①②③等原子陈述 key，必须完整覆盖 Agent 1 的全部关系项",
            decision: "confirm | dispute | correction",
            verifiedKnowledgeNodeIds: ["仅 confirm 且 Agent 1=option_specific 时必填；从本题候选 knowledge 节点中独立选择"],
            proposedKnowledgeRelation: "仅 correction 时填写 question_only | option_specific | undetermined",
            proposedKnowledgeNodeIds: ["仅 correction + option_specific 时，从本题候选 knowledge 节点中选择"],
            evidenceChunkIds: ["只能引用提供的教材证据 id"],
            reason: "独立核对 Agent 1 删除检验的依据；不得覆盖 Agent 1 原始输出",
          }],
          focusKey: "同一考查维度使用稳定且一致的短键",
          focusLabel: "供人工阅读的考查维度",
          action: "作答动作",
          confidence: 0.9,
          reason: "教材依据",
          uncertainty: "没有则留空",
          evidenceChunkIds: ["只能引用提供的证据 id"],
          familyDecision: "join_existing | create_new | needs_merge | unresolved",
          primaryFamilyId: "建议作为主题族的现有题族 id；没有准确题族时留空",
          primaryFamilyContributionKnowledgeNodeIds: ["主题题族对本题实际承载的知识；必须非空，core 时包含题目核心知识，scope_anchor 时只承载 required 知识"],
          relatedFamilyIds: ["正式关联题族 id；包含作答必需关联与普通参考关联"],
          relatedFamilyRelations: [{
            familyId: "relatedFamilyIds 中的题族 id",
            coverageRole: "required | reference；required 参与最小充分知识集联合覆盖，reference 不参与",
            contributionKnowledgeNodeIds: ["required 填该题族对本题实际承载的知识；reference 必须为空"],
          }],
          relatedFamilyAssessments: [{
            familyId: "relatedFamilyIds 中的题族 id",
            necessaryAfterDeletionTest: "coverageRole=required 时必须为 true；reference 时必须为 false",
            deletionTest: "required 说明去掉该能力后为何不能作答；reference 可说明去掉后仍能作答",
            reason: "为什么它是作答必需关联或普通参考关联",
          }],
          matchedFamilyIds: ["与本题特征最接近的现有题族 id"],
          duplicateFamilyIds: ["疑似语义重复、需要人工合并检查的题族 id"],
          familySimilarityReason: "本题与现有题族的相似/差异依据；没有候选时留空",
          candidateFamilyDraft: {
            name: "候选新题族名称；仅 familyDecision=create_new 时填写",
            focusKey: "稳定判别焦点；独立于题族名称和考查动作",
            coreKnowledgeNodeId: "题族范围锚点 id，用于组织定位，不要求等于题目核心知识",
            requiredKnowledgeNodeIds: ["题族长期覆盖的知识集合，必须非空，可包含本题未调用的同族知识"],
            textbookAnchorNodeIds: ["只能用 knowledgeNode/relatedNodes 中的真实 id；拿不准时使用范围锚点"],
            assessmentAction: "本题族共同的考查或作答动作",
            inclusionBoundary: "哪些题应纳入本题族",
            exclusionBoundary: "哪些相似题不得纳入本题族",
            membership: {
              coverageRole: "required",
              contributionKnowledgeNodeIds: ["候选题族对本题实际承载的知识；必须非空，core 时包含题目核心知识，scope_anchor 时只承载 required 知识"],
            },
            textbookEvidence: { chunkIds: ["输入中的真实教材片段 id"], summary: "教材如何支持该边界" },
            reason: "为什么现有题族均不合适且需要新建",
          },
        })),
        },
      };
      const contextCounts = {
        mode,
        questions: batch.questionIds.length,
        candidateKnowledgeNodes: Object.values(modeCandidateNodeIdsByQuestion).reduce((total, ids) => total + ids.length, 0),
        relatedNodes: values.relatedNodes.length,
        evidenceChunks: values.textbookEvidence.length,
        // 留痕：实际发给模型的教材证据片段 ID。用于核查"课本里有的内容（如附录二 国际音标简表）
        // 是否真的被送到模型面前"，此前只有数量无法判断。
        offeredEvidenceIds: Object.fromEntries(batch.questionIds.map((questionId) => [
          questionId,
          modeEvidenceChunkIdsByQuestion[questionId] || [],
        ])),
        dossiers: values.knowledgeDossiers.reduce((total, item) => total + item.dossiers.length, 0),
        rules: values.teachingRules.reduce((total, item) => total + item.rules.length, 0),
        cases: values.confirmedCases.reduce((total, item) => total + item.cases.length, 0),
        families: values.candidateFamilies.reduce((total, item) => total + item.families.length, 0),
        familySamples: values.candidateFamilies.reduce((total, item) => total
          + item.families.reduce((count, family) => count + family.sampleQuestions.length, 0), 0),
        excludedSelfCases: batch.questionIds.reduce((total, questionId) => total
          + Number(experienceByQuestion[questionId].excludedSelfCaseCount || 0), 0),
        candidateSelection: Object.fromEntries(batch.questionIds.map((questionId) => [
          questionId,
          candidateSelectionStatsByQuestion[questionId],
        ])),
        symbolEvidenceDebug: Object.fromEntries(batch.questionIds.map((questionId) => [
          questionId,
          symbolEvidenceDebugByQuestion[questionId] || null,
        ])),
        candidateFamilySelection: Object.fromEntries(batch.questionIds.map((questionId) => [
          questionId,
          candidateFamilyStatsByQuestion[questionId],
        ])),
      };
      const promptValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]));
      return {
        values: promptValues,
        contextCounts,
        candidateFamiliesByQuestion: modeFamiliesByQuestion,
        evidenceChunkIdsByQuestion: modeEvidenceChunkIdsByQuestion,
        candidateNodeIdsByQuestion: modeCandidateNodeIdsByQuestion,
      };
    };
    const normalizeVerificationAttempt = (raw, {
      enforceContract = true,
      allowUnresolvedFamilyDecision = false,
      diagnostics = [],
      requestContext = verificationRequest(null, "primary"),
      decisionTerminalNodeIdsByQuestion = terminalNodeIdsByQuestion,
    } = {}) => {
      const normalized = normalizeAgent2Output(raw, {
        adjacency,
        questionIds: batch.questionIds,
        terminalNodeIdsByQuestion: decisionTerminalNodeIdsByQuestion,
        evidenceChunkIdsByQuestion: requestContext.evidenceChunkIdsByQuestion,
      }).verifications;
      const rawVerificationMap = new Map((Array.isArray(raw.verifications) ? raw.verifications : [])
        .map((item) => [String(item?.questionId || ""), item]));
      return normalized.map((verification) => {
        const rawVerification = rawVerificationMap.get(verification.questionId) || {};
        const offeredNodeIds = new Set(requestContext.candidateNodeIdsByQuestion[verification.questionId] || []);
        if (verification.requiredNodeIds.some((nodeId) => !offeredNodeIds.has(nodeId))) {
          throw new Error("knowledge_classification_agent3_selection_outside_candidates");
        }
        const offeredFamilies = requestContext.candidateFamiliesByQuestion[verification.questionId] || [];
        const validFamilyIds = new Set(offeredFamilies.map((family) => family.id));
        const primaryFamilyId = String(rawVerification.primaryFamilyId || "");
        const rawRelatedFamilyIds = [...new Set((Array.isArray(rawVerification.relatedFamilyIds) ? rawVerification.relatedFamilyIds : [])
          .map(String).filter((id) => validFamilyIds.has(id) && id !== primaryFamilyId))].slice(0, 12);
        const relatedFamilyPolicy = filterRelatedFamilySuggestions({
          validFamilyIds,
          primaryFamilyId,
          rawRelatedFamilyIds,
          rawRelations: rawVerification.relatedFamilyRelations,
          rawAssessments: rawVerification.relatedFamilyAssessments,
        });
        const matchedFamilyIds = [...new Set((Array.isArray(rawVerification.matchedFamilyIds) ? rawVerification.matchedFamilyIds : [])
          .map(String).filter((id) => validFamilyIds.has(id)))].slice(0, 12);
        let decorated = {
          ...verification,
          ...(batch.recoveredFromByQuestion?.[verification.questionId]
            ? { recoveredFrom: batch.recoveredFromByQuestion[verification.questionId] }
            : {}),
          familyDecision: ["join_existing", "create_new", "needs_merge", "unresolved"].includes(String(rawVerification.familyDecision || ""))
            ? String(rawVerification.familyDecision)
            : (primaryFamilyId ? "join_existing" : "unresolved"),
          primaryFamilyId,
          relatedFamilyIds: relatedFamilyPolicy.relatedFamilyIds,
          relatedFamilyRelations: relatedFamilyPolicy.relatedFamilyRelations,
          relatedFamilyAssessments: relatedFamilyPolicy.assessments,
          matchedFamilyIds: [...new Set([primaryFamilyId, ...rawRelatedFamilyIds, ...matchedFamilyIds]
            .filter((id) => validFamilyIds.has(id)))].slice(0, 12),
          duplicateFamilyIds: [...new Set((Array.isArray(rawVerification.duplicateFamilyIds) ? rawVerification.duplicateFamilyIds : [])
            .map(String).filter((id) => validFamilyIds.has(id)))].slice(0, 12),
          familySimilarityReason: String(rawVerification.familySimilarityReason || "").trim().slice(0, 1600),
        };
        if (enforceContract) {
          decorated = validateAgent3VerificationContract(decorated, {
            rawVerification,
            dependencySteps: resultMap.get(verification.questionId)?.agent1Features?.dependencySteps || [],
            featureProfile: resultMap.get(verification.questionId)?.agent1Features || null,
            candidateFamilies: offeredFamilies,
            allowedKnowledgeNodeIds: offeredNodeIds,
            evidenceChunkIds: requestContext.evidenceChunkIdsByQuestion[verification.questionId] || [],
            allowUnresolvedFamilyDecision,
          });
        } else {
          decorated = {
            ...decorated,
            familyDecision: "unresolved",
            primaryFamilyId: "",
            relatedFamilyIds: [],
            relatedFamilyRelations: [],
            relatedFamilyAssessments: [],
            matchedFamilyIds: [],
            duplicateFamilyIds: [],
            candidateFamilyDraft: null,
            requiredNodeAssessments: [],
            agent3ContractStatus: "failed",
            agent3Diagnostics: diagnostics,
          };
        }
        return supplementClassificationBridgeNodes(decorated, questionMap.get(verification.questionId), adjacency, candidateNodeIdsByQuestion[verification.questionId]);
      });
    };
    const deriveSingleKnowledgeDecision = (questionId, primaryNodeId) => {
      const terminals = terminalNodeIdsByQuestion[questionId] || [];
      if (terminals.includes(primaryNodeId)) return { decision: "confirm", terminals };
      const terminalParents = new Set(terminals.map((id) => adjacency.byId.get(id)?.parentId).filter(Boolean));
      if (terminals.some((id) => adjacency.byId.get(id)?.parentId === primaryNodeId)) {
        return { decision: "move_parent", terminals };
      }
      const primary = adjacency.byId.get(primaryNodeId);
      if (primary?.parentId && terminalParents.has(primary.parentId)) {
        return { decision: "move_sibling", terminals };
      }
      return { decision: "confirm", terminals: [primaryNodeId], relocatedByAgent3: true };
    };
    const compactAgent3PreviousDecision = (raw) => ({
      verifications: (Array.isArray(raw?.verifications) ? raw.verifications : []).slice(0, batch.questionIds.length)
        .map((item) => ({
          questionId: String(item?.questionId || ""),
          decision: String(item?.decision || ""),
          primaryNodeId: String(item?.primaryNodeId || ""),
          primaryNodeRole: normalizedPrimaryNodeRole(item?.primaryNodeRole),
          requiredNodeIds: [...new Set((Array.isArray(item?.requiredNodeIds) ? item.requiredNodeIds : []).map(String).filter(Boolean))].slice(0, 8),
          requiredNodeAssessments: (Array.isArray(item?.requiredNodeAssessments) ? item.requiredNodeAssessments : []).slice(0, 7)
            .map((assessment) => ({
              nodeId: String(assessment?.nodeId || ""),
              dependencyStepRefs: (assessment?.dependencyStepRefs || []).slice(0, 8),
              necessaryAfterDeletionTest: assessment?.necessaryAfterDeletionTest === true,
              entailedByPrimaryRule: assessment?.entailedByPrimaryRule === true,
            })),
          focusKey: String(item?.focusKey || "").slice(0, 120),
          focusLabel: String(item?.focusLabel || "").slice(0, 160),
          action: String(item?.action || "").slice(0, 180),
          confidence: Math.min(1, Math.max(0, Number(item?.confidence) || 0)),
          reason: String(item?.reason || "").slice(0, 280),
          uncertainty: String(item?.uncertainty || "").slice(0, 220),
          evidenceChunkIds: [...new Set((Array.isArray(item?.evidenceChunkIds) ? item.evidenceChunkIds : [])
            .map(String).filter(Boolean))].slice(0, 6),
          familyDecision: String(item?.familyDecision || ""),
          primaryFamilyId: String(item?.primaryFamilyId || ""),
          relatedFamilyIds: (Array.isArray(item?.relatedFamilyIds) ? item.relatedFamilyIds : []).slice(0, 8),
          relatedFamilyRelations: (Array.isArray(item?.relatedFamilyRelations) ? item.relatedFamilyRelations : []).slice(0, 8)
            .map((relation) => ({
              familyId: String(relation?.familyId || ""),
              coverageRole: ["required", "reference"].includes(String(relation?.coverageRole || ""))
                ? String(relation.coverageRole) : "",
              contributionKnowledgeNodeIds: [...new Set((Array.isArray(relation?.contributionKnowledgeNodeIds)
                ? relation.contributionKnowledgeNodeIds : []).map(String).filter(Boolean))].slice(0, 8),
            })),
          primaryFamilyContributionKnowledgeNodeIds: [...new Set((Array.isArray(item?.primaryFamilyContributionKnowledgeNodeIds)
            ? item.primaryFamilyContributionKnowledgeNodeIds : []).map(String).filter(Boolean))].slice(0, 8),
          familySimilarityReason: String(item?.familySimilarityReason || "").slice(0, 240),
          candidateFamilyDraft: item?.candidateFamilyDraft && typeof item.candidateFamilyDraft === "object" ? {
            name: String(item.candidateFamilyDraft.name || "").slice(0, 160),
            focusKey: String(item.candidateFamilyDraft.focusKey || item?.focusKey || "").slice(0, 240),
            coreKnowledgeNodeId: String(item.candidateFamilyDraft.coreKnowledgeNodeId || ""),
            requiredKnowledgeNodeIds: [...new Set((Array.isArray(item.candidateFamilyDraft.requiredKnowledgeNodeIds)
              ? item.candidateFamilyDraft.requiredKnowledgeNodeIds : []).map(String).filter(Boolean))].slice(0, 8),
            textbookAnchorNodeIds: [...new Set((Array.isArray(item.candidateFamilyDraft.textbookAnchorNodeIds)
              ? item.candidateFamilyDraft.textbookAnchorNodeIds : []).map(String).filter(Boolean))].slice(0, 4),
            assessmentAction: String(item.candidateFamilyDraft.assessmentAction || "").slice(0, 180),
            inclusionBoundary: String(item.candidateFamilyDraft.inclusionBoundary || "").slice(0, 220),
            exclusionBoundary: String(item.candidateFamilyDraft.exclusionBoundary || "").slice(0, 220),
            membership: {
              coverageRole: "required",
              contributionKnowledgeNodeIds: [...new Set((Array.isArray(item.candidateFamilyDraft.membership?.contributionKnowledgeNodeIds)
                ? item.candidateFamilyDraft.membership.contributionKnowledgeNodeIds : []).map(String).filter(Boolean))].slice(0, 8),
            },
            textbookEvidence: {
              chunkIds: [...new Set((Array.isArray(item.candidateFamilyDraft.textbookEvidence?.chunkIds)
                ? item.candidateFamilyDraft.textbookEvidence.chunkIds : []).map(String).filter(Boolean))].slice(0, 6),
              summary: String(item.candidateFamilyDraft.textbookEvidence?.summary || "").slice(0, 280),
            },
            reason: String(item.candidateFamilyDraft.reason || "").slice(0, 280),
          } : null,
        })),
    });
    const normalizeDegradedKnowledgeAttempt = (raw, requestContext, diagnostics) => {
      if (!raw || !Array.isArray(raw.verifications)) return null;
      const decisionTerminals = { ...terminalNodeIdsByQuestion };
      const recoveredDecisionByQuestion = {};
      const sanitized = {
        ...raw,
        verifications: raw.verifications.map((item) => {
          const questionId = String(item?.questionId || "");
          const primaryNodeId = String(item?.primaryNodeId || "");
          const primaryNodeRole = normalizedPrimaryNodeRole(item?.primaryNodeRole);
          const requiredNodeIds = [...new Set((Array.isArray(item?.requiredNodeIds) ? item.requiredNodeIds : [])
            .map(String).filter(Boolean))].slice(0, 8);
          let decision = String(item?.decision || "");
          if (primaryNodeId && requiredNodeIds.length === 1
            && (primaryNodeRole === "scope_anchor" || requiredNodeIds[0] === primaryNodeId)) {
            const derived = deriveSingleKnowledgeDecision(questionId, primaryNodeId);
            decision = derived.decision;
            decisionTerminals[questionId] = derived.terminals;
            recoveredDecisionByQuestion[questionId] = {
              originalDecision: String(item?.decision || ""),
              decision,
              relocatedByAgent3: derived.relocatedByAgent3 === true,
            };
          } else if (primaryNodeId && requiredNodeIds.length > 1
            && (primaryNodeRole === "scope_anchor" || requiredNodeIds.includes(primaryNodeId))) {
            decision = "cross_knowledge";
            recoveredDecisionByQuestion[questionId] = {
              originalDecision: String(item?.decision || ""),
              decision,
              relocatedByAgent3: false,
            };
          }
          return {
            ...item,
            decision,
            primaryNodeRole,
            requiredNodeIds,
            familyDecision: "unresolved",
            primaryFamilyId: "",
            relatedFamilyIds: [],
            relatedFamilyRelations: [],
            relatedFamilyAssessments: [],
            candidateFamilyDraft: null,
          };
        }),
      };
      const validated = normalizeVerificationAttempt(sanitized, {
        enforceContract: true,
        allowUnresolvedFamilyDecision: true,
        requestContext,
        decisionTerminalNodeIdsByQuestion: decisionTerminals,
      });
      return validated.map((verification) => ({
        ...verification,
        familyDecision: "unresolved",
        primaryFamilyId: "",
        relatedFamilyIds: [],
        relatedFamilyRelations: [],
        relatedFamilyAssessments: [],
        matchedFamilyIds: [],
        duplicateFamilyIds: [],
        candidateFamilyDraft: null,
        agent3ContractStatus: "failed",
        agent3KnowledgeRecovery: recoveredDecisionByQuestion[verification.questionId] || null,
        agent3Diagnostics: diagnostics,
      }));
    };
    const isAgent3FamilyContractCode = (code) => /family|join_|draft_/.test(String(code || ""));
    const agent3Diagnostics = [];
    const deadline = Date.now() + AGENT3_TOTAL_BUDGET_MS;
    const config = aiConfigStore.load();
    const primaryScene = configuredScene(config, "knowledge_batch_verification");
    const fallbackScene = configuredScene(config, "knowledge_batch_verification_fallback");
    const normalizedEndpoint = (provider) => String(provider?.baseUrl || "").trim().replace(/\/$/, "").toLowerCase();
    const fallbackRouteIsIndependent = Boolean(primaryScene && fallbackScene
      && primaryScene.provider.id !== fallbackScene.provider.id
      && (normalizedEndpoint(primaryScene.provider) !== normalizedEndpoint(fallbackScene.provider)
        || primaryScene.provider.protocol !== fallbackScene.provider.protocol)
      && primaryScene.route.model !== fallbackScene.route.model);
    const invokeVerification = async ({
      requestContext,
      attemptKind,
      routeSceneId = "",
      timeoutCapMs,
      parentTaskId = "",
      fallbackReason = "",
      contractAttempt = 1,
    }) => {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1000) {
        const exhausted = new Error("knowledge_batch_verification_budget_exhausted");
        exhausted.classificationOutcome = "provider_or_infrastructure_failed";
        throw exhausted;
      }
      const timeoutMs = Math.min(timeoutCapMs, remainingMs);
      return runKnowledgeClassificationModel("knowledge_batch_verification", requestContext.values, {
        jobId: job.id,
        questionIds: batch.questionIds,
        terminalNodeIds: batch.terminalNodeIds,
        contractAttempt,
        attemptKind,
        parentTaskId,
        retryOfTaskId: parentTaskId,
        fallbackReason,
        timeoutMs,
        totalBudgetMs: AGENT3_TOTAL_BUDGET_MS,
        budgetRemainingMs: remainingMs,
        contextCounts: requestContext.contextCounts,
        offeredEvidenceChunkIds: requestContext.evidenceChunkIdsByQuestion,
      }, "", {
        temperature: attemptKind === "primary" ? 0.1 : 0,
        reasoningEffort: "low",
      }, {
        routeSceneId,
        timeoutMs,
        maxRetries: 0,
        invalidJsonErrorCode: "knowledge_classification_agent3_json_invalid",
        failureStage: `knowledge_batch_verification_${attemptKind}`,
        validateRaw: (raw) => normalizeVerificationAttempt(raw, {
          enforceContract: true,
          requestContext,
        }),
      });
    };
    let activeRequest = verificationRequest(null, "primary");
    let activeRouteSceneId = "";
    let response = null;
    let contractError = null;
    try {
      response = await invokeVerification({
        requestContext: activeRequest,
        attemptKind: "primary",
        timeoutCapMs: AGENT3_PRIMARY_TIMEOUT_MS,
      });
    } catch (error) {
      if (isAgent3ContractError(error)) {
        contractError = error;
      } else {
        if (!isRetryableProviderFailure(error) || !fallbackRouteIsIndependent) throw error;
        activeRequest = verificationRequest(null, "fallback");
        activeRouteSceneId = "knowledge_batch_verification_fallback";
        try {
          response = await invokeVerification({
            requestContext: activeRequest,
            attemptKind: "fallback",
            routeSceneId: activeRouteSceneId,
            timeoutCapMs: AGENT3_FALLBACK_TIMEOUT_MS,
            parentTaskId: error.aiTaskId || "",
            fallbackReason: String(error.message || "provider_failure"),
          });
        } catch (fallbackError) {
          if (!isAgent3ContractError(fallbackError)) {
            fallbackError.firstFailure = String(error.message || "provider_failure");
            fallbackError.classificationOutcome = "provider_or_infrastructure_failed";
            throw fallbackError;
          }
          contractError = fallbackError;
        }
      }
    }
    let verifications = null;
    if (response) {
      verifications = response.validated.map((verification) => ({
        ...verification,
        agent3ContractStatus: "valid",
        // 逐层留痕：主尝试也必须记录模型原始输出与解析结果，否则最常见的成功路径
        // 事后无法回看"模型到底输出了什么"。
        agent3Diagnostics: [{
          contractAttempt: 1,
          taskId: response.taskId || "",
          retryOfTaskId: "",
          status: "valid",
          errorCode: "",
          rawOutput: String(response.rawOutput || "").slice(0, 12000),
          parsedOutput: response.raw || null,
          createdAt: Date.now(),
        }],
      }));
    } else if (contractError) {
      const correctionErrorCode = String(contractError.message || "knowledge_classification_agent3_contract_invalid");
      const correctionFocus = correctionErrorCode === "knowledge_classification_family_draft_required"
        ? "你上次选择了 create_new 却漏填 candidateFamilyDraft。本次若仍无完全匹配的 confirmed 题族，必须保留 create_new 并一次填全草稿字段，不能改用 unresolved。"
        : (correctionErrorCode === "knowledge_classification_agent2_unresolved_nodes_invalid"
          ? "你上次使用 unable 或 missing_node，却又给出了 primaryNodeId/requiredNodeIds。既然知识节点已经能够确定，就必须保留这些节点，并按它们相对原路径的位置改为 confirm、move_parent、move_sibling 或合法的 cross_knowledge；不得再用 unable、missing_node 或 unresolved 逃避。答案证据不足写入 uncertainty，不得因此丢弃已经有教材依据的知识与考查动作。若没有完全匹配的 confirmed 题族，必须选择 create_new 并一次填全 candidateFamilyDraft。"
          : (correctionErrorCode === "knowledge_classification_agent3_family_decision_required"
            ? "你已经给出了可成立的知识裁决和作答动作，却把题族裁决留为 unresolved。若没有完全匹配的 confirmed 题族，必须选择 create_new 并一次填全 candidateFamilyDraft；只有知识节点或考查动作本身确实无法确定时，题族才可 unresolved。"
        : (correctionErrorCode === "knowledge_classification_family_draft_anchor_invalid"
          ? "你上次填写了不存在的教材锚点。保持已经形成的知识裁决和 create_new，只从 allowedKnowledgeNodeIds 选择 textbookAnchorNodeIds；拿不准时直接使用 coreKnowledgeNodeId，不能改成 unable 或 unresolved 来逃避草稿。"
          : (correctionErrorCode.startsWith("knowledge_classification_agent3_join_")
            ? "你上次选择的 primaryFamilyId 与本题成员贡献或考查动作不兼容。join_existing 的题族范围锚点不要求等于题目主节点；主题题族必须是 confirmed 且考查动作兼容，主题成员贡献必须非空，primaryNodeRole=core 时包含主节点，scope_anchor 时只承载 required 知识，并与 required 关联题族的成员贡献联合后完整且无额外地覆盖题目最小充分知识集。reference 贡献必须为空。若仍无法满足，改为 create_new 并填写完整候选草稿。"
          : (correctionErrorCode.includes("family_draft") || correctionErrorCode.includes("draft_"))
            ? "保持已经形成的知识裁决；按 errorCode 修正 candidateFamilyDraft。草稿 coreKnowledgeNodeId 是题族范围锚点，不要求等于题目主节点；requiredKnowledgeNodeIds 是题族覆盖知识。请修正 candidateFamilyDraft.membership.contributionKnowledgeNodeIds：它必须非空，primaryNodeRole=core 时包含题目主节点，scope_anchor 时不得包含范围锚点，并与 required 关联题族的成员贡献联合后恰好覆盖题目最小充分知识集；证据只能引用本次片段。"
        : (correctionErrorCode.includes("related_family")
          ? "relatedFamilyIds 中每项都必须同时出现在 relatedFamilyRelations 和 relatedFamilyAssessments。coverageRole=required 时必须通过删除检验并参与知识联合覆盖；coverageRole=reference 时不参与覆盖，但要说明正式参考关系；仅仅相似的题族只留在 matchedFamilyIds。"
          : (correctionErrorCode === "knowledge_classification_agent2_cross_knowledge_required"
            ? "你上次只给出一个 requiredNodeId 却选择 cross_knowledge；本次必须改为与主节点位置一致的单知识 decision，不能为了保留 cross_knowledge 增加无必要节点。"
            : "只修复 errorCode 指向的字段，并保持其他已通过教材核验的判断内部一致。"))))));
      agent3Diagnostics.push({
        contractAttempt: 1,
        taskId: contractError.aiTaskId || "",
        retryOfTaskId: "",
        status: "contract_invalid",
        errorCode: String(contractError.message || "knowledge_classification_agent3_contract_invalid"),
        rawOutput: String(contractError.rawOutput || "").slice(0, 12000),
        parsedOutput: contractError.parsedOutput || null,
        createdAt: Date.now(),
      });
      const correction = {
        errorCode: correctionErrorCode,
        previousDecision: compactAgent3PreviousDecision(contractError.parsedOutput),
        instruction: `${correctionFocus} 这是唯一一次约束纠正。多个解题步骤不等于多个必需知识节点；先计算作答最小充分知识集，再决定 decision，并显式输出 primaryNodeRole=core|scope_anchor。core 时主节点属于 required 且由主题贡献承载；scope_anchor 时主节点只作范围组织，不得进入 required 或成员贡献，但必须是至少一个 required 节点的祖先范围。requiredNodeIds 只有一个时严禁 cross_knowledge；只有至少两个节点且每个独立必需节点均通过删除检验时才可 cross_knowledge。只能使用本次候选知识、证据和题族 ID；题族范围锚点不参与题目知识覆盖，必须由主题题族/候选题族与 coverageRole=required 关联题族的成员贡献联合后完整且无额外地覆盖题目 requiredNodeIds，reference 贡献必须为空。不得创造、猜测或沿用未提供的候选。`,
        mismatchDetails: [],
      };
      const repairRequest = verificationRequest(correction, "repair");
      correction.mismatchDetails = batch.questionIds.map((questionId) => ({
          questionId,
          allowedKnowledgeNodeIds: repairRequest.candidateNodeIdsByQuestion[questionId],
          dependencySteps: compactAgent3FeatureProfile(
            resultMap.get(questionId)?.agent1Features || null,
            AGENT3_CONTEXT_LIMITS.repair,
          )?.dependencySteps || [],
          candidateFamilies: repairRequest.candidateFamiliesByQuestion[questionId].map((family) => ({
            id: family.id,
            status: family.status,
            coreKnowledgeNodeId: family.coreKnowledgeNodeId,
            requiredKnowledgeNodeIds: family.requiredKnowledgeNodeIds,
            assessmentAction: family.assessmentAction,
          })),
        }));
      repairRequest.values.agent3Correction = JSON.stringify(correction);
      try {
        const repaired = await invokeVerification({
          requestContext: repairRequest,
          attemptKind: "contract_repair",
          routeSceneId: activeRouteSceneId,
          timeoutCapMs: AGENT3_CONTRACT_REPAIR_TIMEOUT_MS,
          parentTaskId: contractError.aiTaskId || "",
          fallbackReason: String(contractError.message || "contract_invalid"),
          contractAttempt: 2,
        });
        agent3Diagnostics.push({
          contractAttempt: 2,
          taskId: repaired.taskId,
          retryOfTaskId: contractError.aiTaskId || "",
          status: "valid",
          errorCode: "",
          rawOutput: String(repaired.rawOutput || "").slice(0, 12000),
          parsedOutput: repaired.raw || null,
          createdAt: Date.now(),
        });
        verifications = repaired.validated.map((verification) => ({
          ...verification,
          agent3ContractStatus: "corrected",
          agent3Diagnostics,
        }));
      } catch (repairError) {
        const repairWasContractInvalid = isAgent3ContractError(repairError);
        agent3Diagnostics.push({
          contractAttempt: 2,
          taskId: repairError.aiTaskId || "",
          retryOfTaskId: contractError.aiTaskId || "",
          status: repairWasContractInvalid ? "contract_invalid" : "transport_failed",
          errorCode: String(repairError.message || "knowledge_classification_agent3_contract_repair_failed"),
          rawOutput: String(repairError.rawOutput || "").slice(0, 12000),
          parsedOutput: repairError.parsedOutput || null,
          createdAt: Date.now(),
        });
        const degradedCandidates = [
          { raw: repairError.parsedOutput, requestContext: repairRequest },
          { raw: contractError.parsedOutput, requestContext: activeRequest },
        ].filter((item) => item.raw);
        for (const candidate of degradedCandidates) {
          try {
            verifications = normalizeDegradedKnowledgeAttempt(
              candidate.raw,
              candidate.requestContext,
              agent3Diagnostics,
            );
            break;
          } catch (degradeError) {
            // Try the previous parsed output before declaring the execution unusable.
          }
        }
        if (!verifications) throw repairError;
        agent3Diagnostics.push({
          contractAttempt: 2,
          taskId: repairError.aiTaskId || "",
          retryOfTaskId: contractError.aiTaskId || "",
          status: "degraded",
          errorCode: isAgent3FamilyContractCode(repairError.message || contractError.message)
            ? "agent3_family_contract_failed"
            : "agent3_contract_degraded",
          rawOutput: String(repairError.rawOutput || "").slice(0, 12000),
          parsedOutput: repairError.parsedOutput || null,
          createdAt: Date.now(),
        });
        verifications = verifications.map((verification) => ({
          ...verification,
          agent3ContractStatus: "failed",
          agent3Diagnostics,
        }));
      }
    }
    return {
      verifications,
      ruleIdsByQuestion: Object.fromEntries(batch.questionIds.map((questionId) => [questionId, experienceByQuestion[questionId].rules.map((rule) => rule.id)])),
      caseIdsByQuestion: Object.fromEntries(batch.questionIds.map((questionId) => [questionId, experienceByQuestion[questionId].cases.map((item) => item.id)])),
    };
  };
  const runKnowledgeClassificationJob = async (jobId) => {
    if (activeKnowledgeClassificationJobs.has(jobId)) return;
    activeKnowledgeClassificationJobs.add(jobId);
    const startedAt = Date.now();
    try {
      const job = knowledgeClassificationStore.getJob(jobId);
      if (!job) return;
      knowledgeClassificationStore.updateJob(jobId, {
        status: "running",
        stage: "pipeline",
        startedAt,
        error: "",
        progressMessage: "四 Agent 流水线已启动：特征快照将逐题交给分层归类与教材题族核验",
      });
      const structure = knowledgeStructureStore.get(job.bookId);
      if (!structure) throw new Error("knowledge_structure_not_found");
      const knowledge = textbookKnowledgeStore.get(job.bookId, { includeContent: true });
      const questions = questionStore.getMany(job.questionIds).filter(Boolean);
      let agent1Completed = 0;
      let agent1Processed = 0;
      let agent1Failed = 0;
      let agent2Completed = 0;
      let agent2Processed = 0;
      let agent2Failed = 0;
      let reviewReady = 0;
      const agent2Queue = [];
      let producerFinished = false;
      let producerError = null;
      let wakeAgent2 = null;
      const countReviewReady = () => knowledgeClassificationStore.results({ jobId, limit: 1000 })
        .filter((result) => result.status === "pending_review").length;
      const enqueueAgent2 = (item) => {
        agent2Queue.push(item);
        knowledgeClassificationStore.updateJob(jobId, {
          agent2Queued: agent2Queue.length,
          progressMessage: `Agent 2 已交付第 ${item.questionIndex}/${questions.length} 题，等待 Agent 3 核验`,
        });
        if (wakeAgent2) {
          wakeAgent2();
          wakeAgent2 = null;
        }
      };
      const waitForAgent2Item = async () => {
        while (!agent2Queue.length && !producerFinished) {
          await new Promise((resolve) => { wakeAgent2 = resolve; });
        }
        return agent2Queue.shift() || null;
      };
      const agent2Worker = (async () => {
        while (!producerFinished || agent2Queue.length) {
          const item = await waitForAgent2Item();
          if (!item) continue;
          const { question, questionIndex } = item;
          const result = knowledgeClassificationStore.resultForQuestion(jobId, question.id);
          reviewReady = countReviewReady();
          knowledgeClassificationStore.updateJob(jobId, {
            agent2Queued: agent2Queue.length,
            agent2CurrentQuestionId: question.id,
            agent2CurrentQuestionIndex: questionIndex,
            progressMessage: `Agent 3 正在核验第 ${questionIndex}/${questions.length} 题的教材证据与题族；已可审核 ${reviewReady} 题`,
          });
          if (result.agent1Status === "failed") {
            knowledgeClassificationStore.updateResult(result.id, { agent2Status: "skipped" });
            agent2Processed += 1;
            agent2Completed += 1;
          } else {
            const terminalNodeIds = [...new Set((result.agent1Trajectories || []).flatMap((trajectory) => trajectory.terminalNodeIds || []))];
            knowledgeClassificationStore.updateResult(result.id, { agent2Status: "running" });
            try {
              let effectiveTerminalNodeIds = terminalNodeIds;
              let recoveredFrom = "";
              let recoveryRuleIds = [];
              let recoveryCaseIds = [];
              if (!effectiveTerminalNodeIds.length) {
                const recovered = await runKnowledgeGlobalRecovery(job, result, question, structure);
                recoveredFrom = recovered.recovery.recoveredFrom;
                recoveryRuleIds = recovered.ruleIds;
                recoveryCaseIds = recovered.caseIds;
                if (recovered.recovery.decision !== "recover") {
                  knowledgeClassificationStore.saveAgent2(result.id, {
                    ...recovered.recovery,
                    decision: recovered.recovery.decision,
                    focusKey: "",
                    focusLabel: "",
                    action: "",
                  }, "uncertain", { ruleIds: recoveryRuleIds, caseIds: recoveryCaseIds });
                  effectiveTerminalNodeIds = [];
                } else {
                  effectiveTerminalNodeIds = recovered.recovery.requiredNodeIds;
                }
              }
              if (effectiveTerminalNodeIds.length) {
                const verified = await runKnowledgeVerificationBatch(job, {
                  questionIds: [question.id],
                  terminalNodeIds: effectiveTerminalNodeIds,
                  terminalNodeIdsByQuestion: { [question.id]: effectiveTerminalNodeIds },
                  recoveredFromByQuestion: recoveredFrom ? { [question.id]: recoveredFrom } : {},
                }, questions, structure, knowledge);
                const verification = verified.verifications[0];
                knowledgeClassificationStore.saveAgent2(
                  result.id,
                  verification,
                  ["unable", "missing_node"].includes(verification.decision) ? "uncertain" : "completed",
                  {
                    ruleIds: [...new Set([...recoveryRuleIds, ...verified.ruleIdsByQuestion[question.id]])],
                    caseIds: [...new Set([...recoveryCaseIds, ...verified.caseIdsByQuestion[question.id]])],
                  },
                );
              }
              agent2Completed += 1;
            } catch (error) {
              agent2Failed += 1;
              knowledgeClassificationStore.updateResult(result.id, {
                status: "failed",
                agent2Status: "failed",
                classificationOutcome: error.classificationOutcome || "provider_or_infrastructure_failed",
                error: error.message,
              });
            }
            agent2Processed += 1;
          }
          reviewReady = countReviewReady();
          knowledgeClassificationStore.updateJob(jobId, {
            agent2Completed,
            agent2Processed,
            agent2Queued: agent2Queue.length,
            reviewReady,
            failed: agent1Failed + agent2Failed,
            agent2CurrentQuestionId: "",
            agent2CurrentQuestionIndex: 0,
            progressMessage: `Agent 3 已处理 ${agent2Processed}/${questions.length} 题；${reviewReady} 题可立即审核`,
          });
        }
      })();

      try {
        for (const [questionIndex, question] of questions.entries()) {
          const result = knowledgeClassificationStore.resultForQuestion(jobId, question.id);
          knowledgeClassificationStore.updateResult(result.id, { status: "processing", agent1Status: "running" });
          knowledgeClassificationStore.updateJob(jobId, {
            currentQuestionId: question.id,
            currentQuestionIndex: questionIndex + 1,
            currentDepth: 0,
            agent1CurrentQuestionId: question.id,
            agent1CurrentQuestionIndex: questionIndex + 1,
            agent1CurrentDepth: 0,
            agent1Completed,
            agent1Processed,
            failed: agent1Failed + agent2Failed,
            progressMessage: `准备提取第 ${questionIndex + 1}/${questions.length} 题的独立特征`,
          });
          try {
            const extraction = await runKnowledgeFeatureExtraction(question, structure, jobId, {
              questionIndex: questionIndex + 1,
              total: questions.length,
            });
            const handoff = knowledgeClassificationStore.saveAgent1Features(result.id, extraction.features, extraction);
            const navigation = await runKnowledgeNavigation(question, structure, jobId, handoff.agent1Features, {
              questionIndex: questionIndex + 1,
              total: questions.length,
            });
            const uncertain = ["unable", "none_of_candidates", "previous_level_wrong"].includes(navigation.trajectory.stopReason);
            knowledgeClassificationStore.saveAgent1(result.id, [navigation.trajectory], uncertain ? "uncertain" : "completed", navigation);
            agent1Completed += 1;
          } catch (error) {
            agent1Failed += 1;
            knowledgeClassificationStore.updateResult(result.id, {
              status: "failed",
              agent1Status: "failed",
              agent1FeatureDiagnostics: error.featureExtractionDiagnostics || [],
              agent2NavigationDiagnostics: error.navigationDiagnostics || [],
              classificationOutcome: error.classificationOutcome || "provider_or_infrastructure_failed",
              error: error.message,
            });
          }
          agent1Processed += 1;
          enqueueAgent2({ question, questionIndex: questionIndex + 1 });
          knowledgeClassificationStore.updateJob(jobId, {
            currentQuestionId: question.id,
            currentQuestionIndex: questionIndex + 1,
            currentDepth: 0,
            agent1CurrentQuestionId: "",
            agent1CurrentQuestionIndex: 0,
            agent1CurrentDepth: 0,
            agent1Completed,
            agent1Processed,
            failed: agent1Failed + agent2Failed,
            progressMessage: `Agent 1/2 已处理 ${agent1Processed}/${questions.length} 题；Agent 3 已处理 ${agent2Processed}/${questions.length} 题`,
          });
        }
      } catch (error) {
        producerError = error;
      } finally {
        producerFinished = true;
        if (wakeAgent2) {
          wakeAgent2();
          wakeAgent2 = null;
        }
      }
      await agent2Worker;
      if (producerError) throw producerError;
      const finalResults = knowledgeClassificationStore.results({ jobId, limit: 1000 });
      const succeeded = finalResults.filter((result) => ["pending_review", "applied", "rejected"].includes(result.status)).length;
      const pendingReview = finalResults.filter((result) => result.status === "pending_review").length;
      const failed = finalResults.filter((result) => ["failed", "interrupted"].includes(result.status)).length;
      const status = succeeded && failed ? "partial" : (succeeded ? "completed" : "failed");
      knowledgeClassificationStore.updateJob(jobId, {
        status,
        stage: status === "failed" ? "failed" : "review",
        completed: finalResults.length,
        succeeded,
        failed,
        agent1Completed: finalResults.filter((result) => ["completed", "uncertain"].includes(result.agent1Status)).length,
        agent2Completed: finalResults.filter((result) => ["completed", "uncertain", "skipped"].includes(result.agent2Status)).length,
        agent1Processed: finalResults.filter((result) => !["pending", "running"].includes(result.agent1Status)).length,
        agent2Processed: finalResults.filter((result) => !["pending", "running"].includes(result.agent2Status)).length,
        agent2Queued: 0,
        reviewReady: pendingReview,
        agent1CurrentQuestionId: "",
        agent1CurrentQuestionIndex: 0,
        agent1CurrentDepth: 0,
        agent2CurrentQuestionId: "",
        agent2CurrentQuestionIndex: 0,
        currentQuestionId: "",
        currentQuestionIndex: 0,
        currentDepth: 0,
        currentBatchStart: 0,
        currentBatchEnd: 0,
        progressMessage: status === "failed" ? "巡检失败" : "Agent 1-3 巡检已完成，等待人工审核；确认或改判后由 Agent 4 沉淀经验",
        finishedAt: Date.now(),
        error: status === "failed" ? "knowledge_classification_job_failed" : "",
      });
    } catch (error) {
      const job = knowledgeClassificationStore.getJob(jobId);
      if (job) knowledgeClassificationStore.updateJob(jobId, { status: "failed", stage: "failed", error: error.message, finishedAt: Date.now(), currentQuestionId: "" });
    } finally {
      activeKnowledgeClassificationJobs.delete(jobId);
    }
  };
  const classificationFeedbackScope = (result, structure) => {
    const nodeMap = new Map((structure?.nodes || []).map((node) => [node.id, node]));
    const nodeIds = [...new Set([
      ...(result.agent2Verification?.requiredNodeIds || []),
      result.agent2Verification?.primaryNodeId,
      ...(result.agent1Trajectories || []).flatMap((trajectory) => trajectory.terminalNodeIds || []),
    ].map(String).filter((id) => id && nodeMap.has(id)))];
    const primary = nodeMap.get(result.agent2Verification?.primaryNodeId)
      || nodeMap.get(nodeIds[0]);
    return { nodeIds, scopePath: primary?.path || "" };
  };
  const classificationFeedbackClaimedNodes = (structure, userMessage) => {
    const normalized = String(userMessage || "").normalize("NFKC").replace(/\s+/g, "");
    if (!normalized) return [];
    return (structure?.nodes || []).filter((node) => {
      const titles = [node.displayTitle, node.title]
        .map((value) => String(value || "").normalize("NFKC").replace(/^[（(]?[一二三四五六七八九十0-9]+[）).、]?/u, "").replace(/\s+/g, ""))
        .filter((value) => value.length >= 2);
      return titles.some((title) => normalized.includes(title));
    }).sort((left, right) => Number(right.knowledgeLevel || 0) - Number(left.knowledgeLevel || 0)).slice(0, 8);
  };
  const runClassificationFeedbackConversation = async ({ result, question, agent, userMessage, messages, structure }) => {
    const config = aiConfigStore.load();
    const sceneId = agent === "agent1" ? "knowledge_feature_extraction"
      : (agent === "agent2" ? "knowledge_hierarchy_navigation" : "knowledge_batch_verification");
    const scene = configuredScene(config, sceneId, agent === "agent1" ? "knowledge_hierarchy_navigation" : "");
    if (!scene) throw new Error(`${sceneId}_route_unavailable`);
    const scope = classificationFeedbackScope(result, structure);
    const experience = classificationExperienceForQuestion(question, scope.nodeIds);
    const task = aiTaskStore.start(aiTaskMetadata(config, sceneId, {}, {
      providerId: scene.provider.id,
      providerName: scene.provider.name,
      protocol: scene.provider.protocol,
      model: scene.route.model,
      mode: "provider",
      inputSummary: { resultId: result.id, questionId: question.id, agent, purpose: "teaching_feedback" },
    }));
    const prompt = {
      version: 1,
      systemPrompt: `你是原知识归类巡检中的 ${{ agent1: "Agent 1（题干、选项与依赖特征提取）", agent2: "Agent 2（知识树逐层归类与相似案例匹配）", agent3: "Agent 3（教材证据与题族相似度核验）", agent4: "Agent 4（人工结论、修正案例与规则例外沉淀）" }[agent]}。审核员正在指出你的判断问题或补充教研经验。你必须结合题目、全部选项、已核验来源答案或平台核验答案、教材证据、原巡检轨迹和已批准规则回应；不得迎合错误反馈，也不得擅自修改题库或批准规则。知识归类判断的是完成作答所调用的教材知识，不要求题干显式出现知识点名称；已核验答案只能证明答案内容，不能单独证明知识归属。若审核员点名教材章节或知识节点，必须优先核对该节点的直接正文证据，再与原归类比较。若要拒绝该反馈，必须引用能够直接反驳审核员主张的教材片段 id；没有直接反证时只能标为“暂不能确认”，不得沿用原结论反复驳回。每次反馈首先只能形成审核事件；若内容可复用，请输出稳定 topicKey 和一份规则或知识档案修订建议，但系统必须累计至少 3 道不同题目的同主题案例后才生成正式草案。单题反馈、同题重复讨论或证据不足都不得直接生成规则。只输出有效 JSON，不要 Markdown。`,
      userPromptTemplate: "题目：\n{{question}}\n\n原巡检结果：\n{{classificationResult}}\n\n审核员点名或提及的知识节点：\n{{reviewerClaimedKnowledgeNodes}}\n\n针对本次反馈重新检索的教材证据：\n{{textbookEvidence}}\n\n当前已批准规则：\n{{teachingRules}}\n\n已确认案例：\n{{confirmedCases}}\n\n本题对话记录：\n{{conversationHistory}}\n\n审核员最新反馈：\n{{userMessage}}\n\n严格按以下结构输出：\n{{requiredOutput}}",
    };
    const knowledge = textbookKnowledgeStore.get(question.bookId, { includeContent: true });
    const chunkMap = new Map((knowledge.chunks || []).map((chunk) => [chunk.id, chunk]));
    const reviewerClaimedNodes = classificationFeedbackClaimedNodes(structure, userMessage);
    const targetedEvidence = [
      ...textbookKnowledgeStore.search(question.bookId, userMessage, { limit: 8 }),
      ...reviewerClaimedNodes.flatMap((node) => textbookKnowledgeStore.search(question.bookId, `${node.path}\n${node.displayTitle || node.title}`, { limit: 3 })),
      ...retrieveQuestionEvidence(question, userMessage, 8),
    ].filter((chunk, index, items) => chunk?.id && items.findIndex((item) => item?.id === chunk.id) === index).slice(0, 12);
    const evidenceIds = [...new Set([
      ...targetedEvidence.map((chunk) => chunk.id),
      ...(result.agent2Verification?.evidenceChunkIds || []),
      ...retrieveQuestionEvidence(question, "复盘人工教研反馈", 4).map((chunk) => chunk.id),
    ])];
    try {
      const completed = await completePromptWithTransientRetry(
        { ...scene.provider, timeoutMs: Math.max(120000, Number(scene.provider.timeoutMs) || 0) },
        { ...scene.route, temperature: Math.min(0.25, Number(scene.route.temperature) || 0.1) },
        prompt,
        {
          question: knowledgeClassificationQuestionPayload(question),
          classificationResult: agent === "agent1"
            ? { features: result.agent1Features, trajectories: result.agent1Trajectories }
            : { features: result.agent1Features, navigation: result.agent1Trajectories, verification: result.agent2Verification },
          reviewerClaimedKnowledgeNodes: reviewerClaimedNodes.map((node) => ({
            id: node.id,
            title: node.displayTitle || node.title,
            path: node.path,
            knowledgeLevel: node.knowledgeLevel,
          })),
          textbookEvidence: compactClassificationEvidence(evidenceIds.map((id) => chunkMap.get(id)).filter(Boolean), 1600),
          teachingRules: experience.rules,
          confirmedCases: experience.cases,
          conversationHistory: messages.slice(-20).map((message) => ({ role: message.role, agent: message.agent, message: message.message })),
          userMessage,
          requiredOutput: {
            disposition: "accept | partial_accept | uncertain | reject",
            reply: "直接回应审核员，说明是否接受反馈及理由",
            evidenceAudit: {
              citedEvidenceChunkIds: ["实际用于结论的教材片段 id；拒绝反馈时不能为空"],
              conclusion: "教材证据如何支持当前结论",
            },
            reusable: true,
            topicKey: "同一教研问题跨题保持稳定的短键",
            experienceProposal: {
              type: "rule | dossier",
              updateMode: "replace",
              title: "简短规则名称",
              statement: "可在后续题目中执行的明确判断规则",
              dossierId: "仅档案修订建议填写",
              patch: { inclusionCriteria: ["仅档案修订建议填写"] },
              triggerTerms: ["规则触发词"],
              positiveExamples: ["应按此规则处理的例子"],
              negativeExamples: ["不适用或易混淆的反例"],
              priority: "low | medium | high",
            },
          },
        },
        null,
        { jsonMode: true },
      );
      const raw = parseJsonContent(completed.completion.content);
      const validEvidenceIds = new Set(evidenceIds);
      const citedEvidenceIds = (Array.isArray(raw?.evidenceAudit?.citedEvidenceChunkIds)
        ? raw.evidenceAudit.citedEvidenceChunkIds : []).map(String).filter((id) => validEvidenceIds.has(id));
      const disposition = ["accept", "partial_accept", "uncertain", "reject"].includes(raw?.disposition)
        ? raw.disposition : "uncertain";
      if (disposition === "reject" && !citedEvidenceIds.length) {
        raw.disposition = "uncertain";
        raw.reply = "暂不能否定这条反馈：本轮没有提供能够直接反驳审核员所指教材节点的正文证据。请以审核员点名的目录重新核验后再形成结论。";
        raw.reusable = false;
        delete raw.ruleDraft;
        delete raw.experienceProposal;
      }
      raw.evidenceAudit = {
        ...(raw.evidenceAudit && typeof raw.evidenceAudit === "object" ? raw.evidenceAudit : {}),
        citedEvidenceChunkIds: citedEvidenceIds,
      };
      aiTaskStore.finish(task.id, { status: "succeeded", chargeable: false, usage: completed.completion.usage, outputChars: completed.completion.content.length });
      return { raw, model: completed.completion.model };
    } catch (error) {
      aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: `${sceneId}_feedback` });
      throw error;
    }
  };
  const saveClassificationFeedback = async (result, payload = {}) => {
    const question = questionStore.get(result.questionId);
    if (!question) throw new Error("question_not_found");
    const agent = ["agent1", "agent2", "agent3", "agent4"].includes(payload.agent) ? payload.agent : "agent2";
    const userMessage = String(payload.message || "").trim();
    if (!userMessage || userMessage.length > 4000) throw new Error("knowledge_classification_feedback_required");
    const reviewerMessage = knowledgeClassificationExperienceStore.addMessage({
      resultId: result.id,
      questionId: result.questionId,
      bookId: result.bookId,
      agent,
      role: "reviewer",
      message: userMessage,
      createdBy: currentAdminDisplayName() || "超级管理员",
    });
    const messages = knowledgeClassificationExperienceStore.messages({ resultId: result.id, agent, limit: 100 });
    const structure = knowledgeStructureStore.get(result.bookId);
    const scope = classificationFeedbackScope(result, structure);
    let raw = {};
    let modelError = "";
    try {
      const completion = await runClassificationFeedbackConversation({ result, question, agent, userMessage, messages, structure });
      raw = completion.raw && typeof completion.raw === "object" ? completion.raw : {};
    } catch (error) {
      modelError = error.message;
    }
    const proposed = raw.experienceProposal && typeof raw.experienceProposal === "object"
      ? raw.experienceProposal
      : (raw.ruleDraft && typeof raw.ruleDraft === "object" ? { ...raw.ruleDraft, type: "rule" } : {});
    const proposalAllowed = payload.createRuleDraft !== false && raw.reusable === true && proposed.title && proposed.statement;
    const fallbackTopic = [agent, ...scope.nodeIds.slice().sort(), String(proposed.title || "本题审核").normalize("NFKC").replace(/\s+/g, "")].join("|");
    const recorded = knowledgeClassificationExperienceStore.recordReviewEvent({
      bookId: result.bookId,
      questionId: result.questionId,
      resultId: result.id,
      eventType: "reviewer_feedback",
      topicKey: String(raw.topicKey || fallbackTopic).slice(0, 500),
      reason: userMessage,
      sourceFeedbackIds: [reviewerMessage.id],
      evidenceChunkIds: raw.evidenceAudit?.citedEvidenceChunkIds,
      proposal: proposalAllowed ? {
        type: proposed.type === "dossier" ? "dossier" : "rule",
        title: String(proposed.title).slice(0, 160),
        statement: String(proposed.statement),
        dossierId: proposed.dossierId,
        patch: proposed.patch,
        scopeNodeIds: scope.nodeIds,
        scopePath: scope.scopePath,
        triggerTerms: proposed.triggerTerms,
        positiveExamples: proposed.positiveExamples,
        negativeExamples: proposed.negativeExamples,
        priority: proposed.priority,
      } : { type: "none" },
    }, currentAdminDisplayName() || "超级管理员");
    const rule = recorded.rule || null;
    const reply = String(raw.reply || (modelError
      ? "你的反馈已经作为审核事件完整记录。模型复盘本次未完成，不会据此直接生成规则。"
      : (recorded.thresholdReached
        ? "已累计至少 3 个独立同类案例，并生成待人工审核的规则或档案修订草案。"
        : `已记录为审核事件；当前同主题有 ${recorded.independentCaseCount} 个独立案例，达到 3 个后才会形成规则或档案修订草案。`)));
    const agentMessage = knowledgeClassificationExperienceStore.addMessage({
      resultId: result.id,
      questionId: result.questionId,
      bookId: result.bookId,
      agent,
      role: "agent",
      message: reply,
      ruleDraftId: rule?.id || "",
      createdBy: `Agent ${agent.slice(-1)}`,
    });
    return {
      reviewerMessage,
      agentMessage,
      reviewEvent: recorded.event,
      independentCaseCount: recorded.independentCaseCount,
      thresholdReached: recorded.thresholdReached,
      rule,
      dossierSuggestion: recorded.dossierSuggestion,
      ruleAction: recorded.ruleAction || "none",
      modelError,
    };
  };
  const applyQuestionEnrichmentSuggestion = (questionId, payload = {}) => {
    const question = questionStore.get(questionId);
    if (!question) throw new Error("question_not_found");
    const suggestion = payload.suggestionId
      ? questionEnrichmentStore.getSuggestion(String(payload.suggestionId))
      : questionEnrichmentStore.latest(questionId);
    if (!suggestion || suggestion.questionId !== questionId || suggestion.status !== "recommended") {
      throw new Error("question_enrichment_suggestion_not_found");
    }
    if (Number(suggestion.questionVersion) !== Number(question.version)) {
      questionEnrichmentStore.updateSuggestion(suggestion.id, { status: "stale" });
      throw new Error("question_enrichment_suggestion_stale");
    }
    const needs = questionEnrichmentNeeds(question);
    const requested = payload.fields && typeof payload.fields === "object" ? payload.fields : {};
    const overrides = payload.overrides && typeof payload.overrides === "object" ? payload.overrides : {};
    const useChapter = requested.chapter !== undefined ? requested.chapter === true : needs.needsChapter;
    const useKnowledgePoints = requested.knowledgePoints !== undefined
      ? requested.knowledgePoints === true : needs.needsKnowledgePoints;
    const useScoringPoints = requested.scoringPoints !== undefined
      ? requested.scoringPoints === true : needs.needsScoringPoints;
    const patch = { changeNote: "采纳题目完善建议" };
    const appliedFields = [];
    if (useChapter) {
      const { nodes } = questionEnrichmentCatalog(question.bookId);
      const chapterNodeId = String(overrides.chapterNodeId || suggestion.chapterNodeId);
      const node = nodes.find((item) => item.id === chapterNodeId);
      if (!node) throw new Error("question_enrichment_catalog_node_invalid");
      patch.chapter = node.path;
      appliedFields.push("chapter");
    }
    if (useKnowledgePoints) {
      const knowledgePoints = (Array.isArray(overrides.knowledgePoints) ? overrides.knowledgePoints : suggestion.knowledgePoints)
        .map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
      if (!knowledgePoints.length) throw new Error("question_enrichment_knowledge_points_required");
      patch.knowledgePoints = knowledgePoints;
      appliedFields.push("knowledgePoints");
    }
    if (useScoringPoints) {
      const scoringPoints = Array.isArray(overrides.scoringPoints) ? overrides.scoringPoints : suggestion.scoringPoints;
      const total = scoringPoints.reduce((sum, point) => sum + Number(point.score || 0), 0);
      if (!scoringPoints.length || Math.abs(total - Number(question.maxScore)) > 0.001) {
        throw new Error("question_enrichment_scoring_points_mismatch");
      }
      patch.scoringPoints = scoringPoints;
      appliedFields.push("scoringPoints");
    }
    if (!appliedFields.length) throw new Error("question_enrichment_apply_fields_required");
    const updated = questionStore.update(questionId, patch, "题目完善审核员");
    const familyResult = questionFamilySensitiveSnapshot(question) !== questionFamilySensitiveSnapshot(updated)
      ? markQuestionFamilyMembersPending([questionId], "question_enrichment_applied", "题目完善审核员")
      : { affectedFamilyIds: [] };
    const appliedSuggestion = questionEnrichmentStore.updateSuggestion(suggestion.id, {
      status: "applied",
      appliedFields,
      appliedVersion: updated.version,
      appliedAt: Date.now(),
    });
    logOperation({
      action: "question.enrichment_apply",
      category: "question",
      targetType: "question",
      targetId: questionId,
      summary: `采纳题目完善建议：${question.stem}`,
      metadata: {
        suggestionId: suggestion.id,
        appliedFields,
        version: updated.version,
        confidence: suggestion.confidence,
        affectedFamilyIds: familyResult.affectedFamilyIds || [],
      },
    });
    return { question: updated, suggestion: appliedSuggestion, affectedFamilyIds: familyResult.affectedFamilyIds || [] };
  };
  const revertQuestionEnrichmentSuggestion = (questionId, suggestionId) => {
    const question = questionStore.get(questionId);
    if (!question) throw new Error("question_not_found");
    const suggestion = questionEnrichmentStore.getSuggestion(suggestionId);
    if (!suggestion || suggestion.questionId !== questionId || suggestion.status !== "applied") {
      throw new Error("question_enrichment_suggestion_not_found");
    }
    if (Number(question.version) !== Number(suggestion.appliedVersion)) throw new Error("question_enrichment_revert_conflict");
    const appliedVersion = (question.versions || []).find((version) => Number(version.version) === Number(suggestion.appliedVersion));
    const previous = appliedVersion && appliedVersion.previousSnapshot;
    if (!previous) throw new Error("question_enrichment_revert_unavailable");
    const patch = { changeNote: "撤回题目完善建议" };
    if (suggestion.appliedFields.includes("chapter")) patch.chapter = previous.chapter;
    if (suggestion.appliedFields.includes("knowledgePoints")) patch.knowledgePoints = previous.knowledgePoints;
    if (suggestion.appliedFields.includes("scoringPoints")) patch.scoringPoints = previous.scoringPoints;
    const updated = questionStore.update(questionId, patch, "题目完善审核员");
    const familyResult = questionFamilySensitiveSnapshot(question) !== questionFamilySensitiveSnapshot(updated)
      ? markQuestionFamilyMembersPending([questionId], "question_enrichment_reverted", "题目完善审核员")
      : { affectedFamilyIds: [] };
    const reverted = questionEnrichmentStore.updateSuggestion(suggestion.id, { status: "reverted" });
    logOperation({
      action: "question.enrichment_revert",
      category: "question",
      targetType: "question",
      targetId: questionId,
      summary: `撤回题目完善建议：${question.stem}`,
      metadata: {
        suggestionId: suggestion.id,
        restoredFromVersion: suggestion.appliedVersion,
        version: updated.version,
        affectedFamilyIds: familyResult.affectedFamilyIds || [],
      },
    });
    return { question: updated, suggestion: reverted, affectedFamilyIds: familyResult.affectedFamilyIds || [] };
  };
  const runTextbookKnowledgeBuild = async (bookId, options = {}) => {
    const textbook = textbookCatalogStore.get(bookId);
    if (!textbook || !textbook.pdf) throw new Error("textbook_pdf_not_found");
    if (!textbook.confirmed || !textbook.confirmed.nodes.length) throw new Error("catalog_confirmed_not_found");
    const pdfBuffer = await loadStoredTextbookPdf(bookId);
    const extracted = await extractPdf(pdfBuffer);
    const totalPages = Math.max(1, Number(extracted.pageCount) || extracted.pages.length);
    const sourceHash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");
    textbookKnowledgeStore.begin(bookId, {
      totalPages,
      resume: options.rebuild !== true,
      source: {
        fileName: textbook.pdf.fileName,
        size: textbook.pdf.size,
        fingerprint: sourceHash,
        catalogVersion: textbook.confirmed.version,
        mode: requiresPdfOcr(extracted) ? "vision_ocr" : "pdf_text_layer",
      },
    });
    const config = aiConfigStore.load();
    let task = null;
    let failedPages = 0;
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    try {
      if (!requiresPdfOcr(extracted)) {
        const pages = extracted.pages.map((text, index) => ({
          pdfPage: index + 1,
          printedPage: printedPageFromText(text),
          text,
          confidence: 1,
        }));
        textbookKnowledgeStore.appendPages(bookId, pages, {
          bookTitle: textbook.title,
          catalogNodes: textbook.confirmed.nodes,
          totalPages,
        });
      } else {
        const scene = configuredScene(config, "textbook_body_ocr", "textbook_ocr");
        if (!scene) throw new Error("textbook_body_ocr_route_unavailable");
        task = aiTaskStore.start(aiTaskMetadata(config, "textbook_body_ocr", {}, {
          inputSummary: { bookId, pageCount: totalPages, source: "scanned_pdf" },
        }));
        const provider = { ...scene.provider, timeoutMs: Math.max(240000, Number(scene.provider.timeoutMs) || 0) };
        const route = { ...scene.route, temperature: 0, maxTokens: Math.max(10000, Number(scene.route.maxTokens) || 0), reasoningEffort: "low" };
        const completedPages = new Set((textbookKnowledgeStore.get(bookId, { includeContent: true }).pages || [])
          .map((page) => Number(page.pdfPage)).filter(Boolean));
        const groups = [];
        for (let startPage = 1; startPage <= totalPages; startPage += 4) {
          const endPage = Math.min(totalPages, startPage + 3);
          let complete = true;
          for (let page = startPage; page <= endPage; page += 1) {
            if (!completedPages.has(page)) {
              complete = false;
              break;
            }
          }
          if (!complete) groups.push({ startPage, endPage });
        }
        for (let cursor = 0; cursor < groups.length; cursor += 2) {
          const wave = groups.slice(cursor, cursor + 2);
          const results = await Promise.allSettled(wave.map(async (group) => {
            const images = await renderPdfPageRangeForOcr(pdfBuffer, {
              pageCount: totalPages,
              startPage: group.startPage,
              endPage: group.endPage,
              dpi: 120,
            });
            const completion = await completeVisionPromptWithProvider(
              provider,
              route,
              scene.prompt,
              {
                bookMetadata: { id: textbook.id, title: textbook.title, authors: textbook.authors, publisher: textbook.publisher },
                pageRange: `${group.startPage}-${group.endPage}`,
              },
              images,
              { mode: "body_ocr" },
            );
            const pages = normalizeBodyOcrPages(parseJsonContent(completion.content), images);
            if (!pages.some((page) => page.text)) throw new Error("textbook_body_ocr_empty");
            return { pages, completion };
          }));
          results.forEach((result, index) => {
            if (result.status === "fulfilled") {
              const completionUsage = result.value.completion.usage || {};
              usage.prompt_tokens += Number(completionUsage.prompt_tokens ?? completionUsage.input_tokens) || 0;
              usage.completion_tokens += Number(completionUsage.completion_tokens ?? completionUsage.output_tokens) || 0;
              usage.total_tokens += Number(completionUsage.total_tokens) || 0;
              textbookKnowledgeStore.appendPages(bookId, result.value.pages, {
                bookTitle: textbook.title,
                catalogNodes: textbook.confirmed.nodes,
                totalPages,
                failedPages,
              });
            } else {
              failedPages += wave[index].endPage - wave[index].startPage + 1;
              const partial = textbookKnowledgeStore.get(bookId, { includeContent: true });
              textbookKnowledgeStore.appendPages(bookId, [], {
                bookTitle: textbook.title,
                catalogNodes: textbook.confirmed.nodes,
                totalPages,
                failedPages,
                pageOffset: partial.pageOffset,
              });
            }
          });
        }
      }
      const knowledge = textbookKnowledgeStore.reindex(bookId, {
        bookTitle: textbook.title,
        catalogNodes: textbook.confirmed.nodes,
      });
      if (task) aiTaskStore.finish(task.id, {
        status: "succeeded",
        chargeable: false,
        usage,
        outputChars: knowledge.characterCount,
      });
      logOperation({
        action: "textbook_knowledge.build",
        category: "catalog",
        targetType: "textbook_knowledge",
        targetId: bookId,
        summary: `构建教材正文知识库：${textbook.title}`,
        metadata: { chunkCount: knowledge.chunkCount, pageCount: knowledge.pageCount, failedPages, version: knowledge.version },
      });
      return knowledge;
    } catch (error) {
      const knowledge = textbookKnowledgeStore.fail(bookId, error);
      if (task) aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "textbook_knowledge_build", usage });
      logOperation({
        action: "textbook_knowledge.build_failed",
        category: "catalog",
        targetType: "textbook_knowledge",
        targetId: bookId,
        summary: `教材正文知识库构建失败：${textbook.title}`,
        metadata: { error: error.message, processedPages: knowledge.progress.processedPages, failedPages },
      });
      throw error;
    }
  };
  const startTextbookKnowledgeBuild = (bookId, options = {}) => {
    if (activeKnowledgeBuilds.has(bookId)) return activeKnowledgeBuilds.get(bookId);
    const promise = runTextbookKnowledgeBuild(bookId, options)
      .finally(() => activeKnowledgeBuilds.delete(bookId));
    activeKnowledgeBuilds.set(bookId, promise);
    return promise;
  };
  const updateExamJob = (id, patch) => aiTaskStore.update(id, { inputSummary: patch });
  const runExamImportJob = async (id, baseUrl) => {
    const initial = aiTaskStore.get(id);
    if (!initial || initial.status !== "running") return;
    const summary = initial.inputSummary || {};
    try {
      updateExamJob(id, { stage: "upload_complete", percent: 6, message: "文件上传完成，正在读取内容" });
      const paperFile = loadExamJobFile(id, "paper", summary.paperFileName, summary.paperMimeType, examJobRoot);
      const answerFile = summary.answerFileName
        ? loadExamJobFile(id, "answer", summary.answerFileName, summary.answerMimeType, examJobRoot)
        : null;
      const formData = new FormData();
      formData.append("paper", new Blob([paperFile.buffer], { type: paperFile.mimeType || "application/octet-stream" }), paperFile.fileName);
      if (answerFile) formData.append("answer", new Blob([answerFile.buffer], { type: answerFile.mimeType || "application/octet-stream" }), answerFile.fileName);
      formData.append("kind", summary.kind || "official_mock");
      formData.append("year", String(summary.year || new Date().getFullYear()));
      formData.append("backgroundTaskId", id);
      const recognitionResult = await postLocalFormJson(`${baseUrl}/api/admin/exams/import-files`, formData, 20 * 60 * 1000);
      if (!recognitionResult.ok) throw new Error(recognitionResult.payload.error || `exam_import_http_${recognitionResult.status}`);
      let draft = recognitionResult.payload.draft;
      const supplementTargets = (draft.questions || []).filter((question) => question.included !== false).map((question) => {
        const needsAnswer = summary.autoSupplementAnswers && (!(question.answerVariants && question.answerVariants.ai)
          || !(question.scoringPoints || []).length
          || (question.scoringPoints || []).some((point) => !point.textbookPage));
        const needsMetadata = summary.autoSupplementMetadata && (!question.chapter || !(question.knowledgePoints || []).length);
        return { question, needsAnswer, needsMetadata };
      }).filter((item) => item.needsAnswer || item.needsMetadata);
      const supplementCalls = supplementTargets.flatMap((target) => [
        target.needsAnswer && { question: target.question, body: { answers: true, metadata: false }, label: "答案与得分点" },
        target.needsMetadata && { question: target.question, body: { answers: false, metadata: true }, label: "目录与知识点" },
      ].filter(Boolean));
      const supplementFailures = [];
      for (let index = 0; index < supplementCalls.length; index += 1) {
        const call = supplementCalls[index];
        updateExamJob(id, {
          stage: "supplementing",
          percent: 92 + Math.round(((index + 1) / Math.max(1, supplementCalls.length)) * 7),
          completedUnits: index,
          totalUnits: supplementCalls.length,
          message: `AI 补全 ${index + 1} / ${supplementCalls.length} · 第 ${call.question.number} 题${call.label}`,
          draftId: draft.id,
        });
        try {
          const supplementResult = await requestLocalJson(`${baseUrl}/api/admin/exams/imports/${encodeURIComponent(draft.id)}/questions/${encodeURIComponent(call.question.localId)}/supplement-answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(call.body),
            timeoutMs: 10 * 60 * 1000,
          });
          if (!supplementResult.ok) throw new Error(supplementResult.payload.error || `exam_supplement_http_${supplementResult.status}`);
          draft = supplementResult.payload.draft;
        } catch (error) {
          supplementFailures.push({ number: call.question.number, label: call.label, error: error.message });
        }
      }
      const finalSummary = {
        stage: supplementFailures.length ? "completed_with_warnings" : "completed",
        percent: 100,
        completedUnits: supplementCalls.length,
        totalUnits: supplementCalls.length,
        draftId: draft.id,
        questionCount: draft.questions.length,
        supplementFailedCount: supplementFailures.length,
        message: supplementFailures.length
          ? `识别完成，${supplementFailures.length} 项 AI 补全失败，已保留草稿供人工处理`
          : "识别完成，已生成待校对草稿",
      };
      updateExamJob(id, finalSummary);
      aiTaskStore.finish(id, { status: "succeeded", chargeable: false, outputChars: 0 });
      deleteExamJobFiles(id, examJobRoot);
    } catch (error) {
      updateExamJob(id, { stage: "failed", message: error.message, percent: Math.min(99, Number(aiTaskStore.get(id)?.inputSummary?.percent) || 0) });
      aiTaskStore.finish(id, { status: "failed", errorCode: error.message, failureStage: "exam_background_import" });
    }
  };
  const refreshExamImportQueuePositions = () => {
    examImportQueue.forEach((queued, index) => {
      const jobsAhead = index + (examImportQueueRunning ? 1 : 0);
      updateExamJob(queued.id, {
        stage: "queued",
        percent: 3,
        message: jobsAhead > 0 ? `排队中，前面还有 ${jobsAhead} 份试卷` : "等待后台识别",
      });
    });
  };
  const drainExamImportQueue = async () => {
    if (examImportQueueRunning) return;
    examImportQueueRunning = true;
    try {
      while (examImportQueue.length) {
        const queued = examImportQueue.shift();
        refreshExamImportQueuePositions();
        try {
          if (aiTaskStore.get(queued.id)?.status === "running") await runExamImportJob(queued.id, queued.baseUrl);
        } finally {
          activeExamImportJobs.delete(queued.id);
          queued.resolve(aiTaskStore.get(queued.id));
          refreshExamImportQueuePositions();
        }
      }
    } finally {
      examImportQueueRunning = false;
    }
  };
  const startExamImportJob = (id, baseUrl) => {
    if (activeExamImportJobs.has(id)) return activeExamImportJobs.get(id);
    let resolveJob;
    const promise = new Promise((resolve) => { resolveJob = resolve; });
    activeExamImportJobs.set(id, promise);
    examImportQueue.push({ id, baseUrl, resolve: resolveJob });
    refreshExamImportQueuePositions();
    setImmediate(() => { drainExamImportQueue(); });
    return promise;
  };
  const handleRequest = async (request, response) => {
    if (options.persistence) {
      const nativeEnd = response.end.bind(response);
      let ending = false;
      response.end = (...args) => {
        if (ending) return response;
        ending = true;
        options.persistence.flush()
          .then(() => nativeEnd(...args))
          .catch((error) => response.destroy(error));
        return response;
      };
    }
    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      response.end();
      return;
    }

    // ---------- 管理后台身份与权限：请求处理的第一道关卡，必须排在所有 /api/admin/* 路由之前 ----------
    // 后台路由既有 url.pathname === "…" 形式，也有 /^\/api\/admin\/…/ 正则形式（如前台的社区审核），
    // 所以鉴权按前缀统一前置，而不是贴着各路由写——后者一旦漏一处就是未授权可执行。
    if (request.method === "POST" && url.pathname === "/api/admin/auth/login") {
      try {
        const payload = await readJsonBody(request);
        const session = adminAccountStore.login({ username: payload.username, password: payload.password });
        // 登录只签发会话，不写业务操作日志：业务日志记的是“谁改了什么”，
        // 而且审计写入失败绝不能把人锁在后台外面。
        sendJson(response, 200, {
          success: true,
          token: session.token,
          expiresAt: session.expiresAt,
          sessionHours: session.sessionHours,
          account: session.account,
        });
      } catch (error) {
        const status = error.message === "admin_login_locked" ? 429
          : (error.message === "admin_account_disabled" ? 403 : 401);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (url.pathname.startsWith("/api/admin/")) {
      const internalServiceRequest = isInternalServiceRequest({
        headerValue: request.headers[INTERNAL_SERVICE_HEADER],
        remoteAddress: request.socket && request.socket.remoteAddress,
        pathname: url.pathname,
      });
      const session = internalServiceRequest ? null : adminAccountStore.authenticate(bearerToken(request));
      const actor = adminActorContext.getStore();
      if (internalServiceRequest) {
        if (actor) {
          actor.username = "system";
          actor.displayName = "系统导入任务";
          actor.role = "";
        }
      } else if (!session) {
        sendJson(response, 401, { success: false, error: "admin_session_invalid" });
        return;
      } else if (actor) {
        actor.username = session.account.username;
        actor.displayName = session.account.displayName;
        actor.role = session.account.role;
        actor.accountId = session.account.id;
      }

      // 初始密码未改时只放行“看自己 / 改密码 / 退出”，其余一律拦住：
      // 共用初始凭据期间不该还能改题库、调模型或动钱。
      const passwordRotationPaths = ["/api/admin/auth/me", "/api/admin/auth/logout", "/api/admin/auth/password"];
      if (session && session.account.mustChangePassword && !passwordRotationPaths.includes(url.pathname)) {
        sendJson(response, 403, { success: false, error: "admin_password_change_required" });
        return;
      }

      // 服务端权限清单：命中仅超管前缀 → 只给超级管理员；未登记的新接口 → 同样只给超级管理员（默认拒绝运营）。
      if (session && adminPermissionForPath(url.pathname) !== "admin" && session.account.role !== "super_admin") {
        sendJson(response, 403, { success: false, error: "admin_permission_denied" });
        return;
      }

      if (url.pathname === "/api/admin/auth/me") {
        if (!session) {
          sendJson(response, 401, { success: false, error: "admin_session_invalid" });
          return;
        }
        sendJson(response, 200, {
          success: true,
          account: session.account,
          expiresAt: session.session.expiresAt,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/auth/logout") {
        adminAccountStore.logout(bearerToken(request));
        sendJson(response, 200, { success: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/auth/password") {
        try {
          const payload = await readJsonBody(request);
          adminAccountStore.changePassword(session.account.id, payload.currentPassword, payload.newPassword);
          logOperation({
            action: "admin_account.change_password",
            category: "admin_account",
            targetType: "admin_account",
            targetId: session.account.id,
            summary: `${session.account.username} 修改自己的登录密码`,
          });
          sendJson(response, 200, { success: true, reloginRequired: true });
        } catch (error) {
          sendJson(response, ["admin_current_password_invalid", "admin_password_unchanged", "admin_password_too_short", "admin_password_too_long", "admin_password_equals_username"].includes(error.message) ? 422 : 400, {
            success: false,
            error: error.message,
          });
        }
        return;
      }

      const accountActionMatch = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/(status|password)$/);
      if (url.pathname === "/api/admin/accounts" || accountActionMatch) {
        // 角色判定已由上面的权限清单统一处理（/api/admin/accounts* 属于超管专属）。
        try {
          if (request.method === "GET" && url.pathname === "/api/admin/accounts") {
            sendJson(response, 200, {
              success: true,
              ...adminAccountStore.list({
                query: url.searchParams.get("query") || "",
                role: url.searchParams.get("role") || "all",
                status: url.searchParams.get("status") || "all",
              }),
            });
            return;
          }
          const payload = request.method === "POST" ? await readJsonBody(request) : {};
          if (request.method === "POST" && url.pathname === "/api/admin/accounts") {
            const created = adminAccountStore.create(payload, session.account.username);
            logOperation({
              action: "admin_account.create",
              category: "admin_account",
              targetType: "admin_account",
              targetId: created.account.id,
              summary: `创建${created.account.roleLabel}账号 ${created.account.username}`,
            });
            sendJson(response, 201, { success: true, account: created.account, generatedPassword: created.generatedPassword });
            return;
          }
          if (request.method === "POST" && accountActionMatch && accountActionMatch[2] === "status") {
            const accountId = decodeURIComponent(accountActionMatch[1]);
            const updated = adminAccountStore.setStatus(accountId, payload.status, session.account.username);
            logOperation({
              action: "admin_account.set_status",
              category: "admin_account",
              targetType: "admin_account",
              targetId: updated.id,
              summary: `${updated.status === "active" ? "启用" : "停用"}账号 ${updated.username}（停用同时撤销其全部会话）`,
            });
            sendJson(response, 200, { success: true, account: updated });
            return;
          }
          if (request.method === "POST" && accountActionMatch && accountActionMatch[2] === "password") {
            const accountId = decodeURIComponent(accountActionMatch[1]);
            const reset = adminAccountStore.resetPassword(accountId, payload.password, session.account.username);
            logOperation({
              action: "admin_account.reset_password",
              category: "admin_account",
              targetType: "admin_account",
              targetId: reset.account.id,
              summary: `重置账号 ${reset.account.username} 的登录密码（同时撤销其全部会话）`,
            });
            sendJson(response, 200, { success: true, account: reset.account, generatedPassword: reset.generatedPassword });
            return;
          }
          sendJson(response, 405, { success: false, error: "method_not_allowed" });
        } catch (error) {
          const conflict = ["admin_username_taken", "admin_last_super_admin", "admin_cannot_disable_self", "admin_account_not_found"].includes(error.message);
          sendJson(response, conflict ? 409 : 422, { success: false, error: error.message });
        }
        return;
      }

      // 用户限制：运营可下发与查看，只有超级管理员能解除。
      const restrictionLiftMatch = url.pathname.match(/^\/api\/admin\/user-restrictions\/([^/]+)\/lift$/);
      if (url.pathname === "/api/admin/user-restrictions" || restrictionLiftMatch) {
        try {
          if (request.method === "GET" && url.pathname === "/api/admin/user-restrictions") {
            sendJson(response, 200, {
              success: true,
              typeOptions: Object.entries(RESTRICTION_TYPE_LABELS).map(([value, label]) => ({
                value,
                label,
                description: RESTRICTION_TYPE_DESCRIPTIONS[value],
              })),
              ...userRestrictionStore.list({
                userId: url.searchParams.get("userId") || "",
                type: url.searchParams.get("type") || "all",
                status: url.searchParams.get("status") || "all",
                limit: url.searchParams.get("limit") || 100,
              }),
            });
            return;
          }
          const payload = request.method === "POST" ? await readJsonBody(request) : {};
          if (request.method === "POST" && url.pathname === "/api/admin/user-restrictions") {
            const applied = userRestrictionStore.apply({
              userId: payload.userId,
              type: payload.type,
              types: payload.types,
              reason: payload.reason,
              note: payload.note,
              durationDays: payload.durationDays,
              expiresAt: payload.expiresAt,
              createdBy: session.account.displayName || session.account.username,
              createdById: session.account.id,
            });
            if (applied.items.some((item) => item.type === "ban")) userAuthStore.logoutUser(String(payload.userId || ""));
            logOperation({
              action: "user_restriction.apply",
              category: "moderation",
              targetType: "user",
              targetId: String(payload.userId || ""),
              summary: `限制用户 ${payload.userId}：${applied.items.map((item) => item.typeLabel).join("、")}至 ${applied.status.untilLabel}`,
              metadata: { types: applied.items.map((item) => item.type), expiresAt: applied.status.expiresAt, reason: applied.items[0] && applied.items[0].reason },
            });
            sendJson(response, 201, { success: true, ...applied });
            return;
          }
          if (request.method === "POST" && restrictionLiftMatch) {
            if (session.account.role !== "super_admin") {
              sendJson(response, 403, { success: false, error: "admin_permission_denied" });
              return;
            }
            const lifted = userRestrictionStore.lift(decodeURIComponent(restrictionLiftMatch[1]), {
              liftedBy: session.account.displayName || session.account.username,
              liftedById: session.account.id,
              note: payload.note,
            });
            logOperation({
              action: "user_restriction.lift",
              category: "moderation",
              targetType: "user",
              targetId: lifted.userId,
              summary: `解除 ${lifted.userId} 的${lifted.typeLabel}`,
              metadata: { restrictionId: lifted.id, type: lifted.type },
            });
            sendJson(response, 200, { success: true, restriction: lifted });
            return;
          }
          sendJson(response, 405, { success: false, error: "method_not_allowed" });
        } catch (error) {
          sendJson(response, error.message === "user_restriction_not_found" ? 404 : 422, { success: false, error: error.message });
        }
        return;
      }
    }

    if (!["GET", "HEAD"].includes(request.method)
      && (classificationCommitCoordinator.isRecoveryRequired() || questionMergeCoordinator.isRecoveryRequired())) {
      sendJson(response, 503, {
        success: false,
        error: questionMergeCoordinator.isRecoveryRequired()
          ? "question_merge_commit_recovery_required"
          : "classification_commit_recovery_required",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: "shukao-api", version: "0.1.0", fileStorage: objectStorage?.driver || "local" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/catalog") {
      sendJson(response, 200, catalogPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/discovery") {
      sendJson(response, 200, { success: true, ...discoveryPayload() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/wechat/login") {
      try {
        const payload = await readJsonBody(request);
        const code = String(payload.code || "").trim();
        if (!code) throw new Error("wechat_code_required");
        const identity = await exchangeWechatCode(code, payload.deviceId);
        const session = userAuthStore.loginWechat({ ...identity, profile: payload.profile });
        if (session.isNewUser) {
          billingStore.grantCredits(session.user.id, {
            amount: 5,
            source: "registration_reward",
            sourceLabel: "新用户注册奖励",
            expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
            referenceId: `registration:${session.user.id}`,
          });
        }
        // 封禁账号不能登录：签发的会话立即撤销（capabilities.write 只由 ban 触发）。
        const restriction = userRestrictionStore.statusFor(session.user.id);
        if (restriction.capabilities.write) {
          userAuthStore.logout(session.token);
          // 注意顺序：restrictionPayload 里也带 error，必须放在后面用更具体的错误码覆盖。
          sendJson(response, 403, { success: false, ...restrictionPayload(restriction), error: "user_account_banned" });
          return;
        }
        sendJson(response, 200, {
          success: true,
          authMode: identity.authMode,
          user: session.user,
          token: session.token,
          expiresAt: session.expiresAt,
          account: billingStore.dashboard(session.user.id).account,
        });
      } catch (error) {
        const configurationError = error.message === "wechat_credentials_not_configured";
        sendJson(response, configurationError ? 503 : 401, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/me") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_invalid" });
        return;
      }
      sendJson(response, 200, { success: true, user: session.user, account: billingStore.dashboard(session.user.id).account });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      userAuthStore.logout(bearerToken(request));
      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/account") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_invalid" });
        return;
      }
      learningStateStore.deleteUser(session.user.id);
      // 注销要一并清掉个人关系数据：社区收藏与复制记录（否则“谁收藏过什么”会残留）。
      communityInteractionStore.deleteUser(session.user.id);
      userAuthStore.deleteUser(session.user.id);
      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/learning/state") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_invalid" });
        return;
      }
      sendJson(response, 200, { success: true, state: learningStateStore.get(session.user.id) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/learning/state/sync") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_invalid" });
        return;
      }
      if (guardUserCapability(response, session.user.id, "write")) return;
      try {
        const payload = await readJsonBody(request, 2 * 1024 * 1024);
        const mappings = mergedQuestionMappings(questionStore);
        if (typeof learningStateStore.remapActiveQuestions === "function") {
          learningStateStore.remapActiveQuestions(session.user.id, mappings);
        }
        const state = learningStateStore.merge(session.user.id, canonicalizeLearningSyncPayload(payload, mappings));
        sendJson(response, 200, { success: true, state });
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/community/assets") {
      const viewer = userAuthStore.authenticate(bearerToken(request));
      sendJson(response, 200, {
        success: true,
        assets: decorateCommunityAssets(communityAssetStore.list({
          type: url.searchParams.get("type") || "all",
          query: url.searchParams.get("query") || "",
        }), viewer ? viewer.user.id : ""),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/community/assets/mine") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_required" });
        return;
      }
      // 身份只来自已验证会话，不接受 URL 上声明的 userId（否则可以冒用他人身份看未发布内容）。
      sendJson(response, 200, {
        success: true,
        assets: decorateCommunityAssets(communityAssetStore.list({ userId: session.user.id, includeUnpublished: true }), session.user.id),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/community/assets") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_required" });
        return;
      }
      try {
        const payload = await readJsonBody(request, 128 * 1024);
        if (guardUserCapability(response, session.user.id, "submit")) return;
        // 公开功能限制：还能保存私有内容，但不能把内容公开分享。
        if (String(payload.visibility || "") === "public" && guardUserCapability(response, session.user.id, "publish")) return;
        // 归属只认会话用户；payload.userId 一律忽略。
        const asset = communityAssetStore.submit(payload, session.user.id);
        if (asset.moderationStatus === "pending_review") {
          moderationStore.create({
            source: "system_review",
            type: "unsafe_content",
            risk: asset.riskReason ? "medium" : "low",
            targetType: "community_asset",
            targetId: asset.id,
            targetTitle: asset.title,
            reporter: { id: "system", nickname: "公开内容初筛" },
            reason: asset.riskReason || "公开资产等待人工确认",
            detail: "社区资产公开前需确认目录、来源、完整性和内容安全。",
            reportedUser: { id: asset.userId, nickname: asset.contributor },
          });
        }
        logOperation({
          action: "community_asset.submit",
          category: "community",
          targetType: "community_asset",
          targetId: asset.id,
          summary: `用户提交${asset.typeLabel || "社区资产"}：${asset.title}`,
          metadata: { type: asset.type, moderationStatus: asset.moderationStatus, userId: asset.userId },
        });
        sendJson(response, 201, { success: true, asset });
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 422, { success: false, error: error.message });
      }
      return;
    }

    // 复制到我的资产：登录才计数，且同一个人对同一内容只计一次（复制数按“人 × 内容”去重）。
    const communityCollectMatch = url.pathname.match(/^\/api\/community\/assets\/([^/]+)\/collect$/);
    if (request.method === "POST" && communityCollectMatch) {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_required" });
        return;
      }
      try {
        const assetId = decodeURIComponent(communityCollectMatch[1]);
        const existing = communityAssetStore.get(assetId);
        if (!existing || existing.moderationStatus !== "published") throw new Error("community_asset_not_found");
        const added = communityInteractionStore.add({ kind: "copy", assetId, userId: session.user.id });
        const asset = added.created ? communityAssetStore.collect(assetId) : existing;
        sendJson(response, 200, { success: true, asset, copied: added.created });
      } catch (error) {
        sendJson(response, error.message === "community_asset_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    // 收藏：引用关系（不复制内容），登录必需、幂等，重复收藏不加计数。
    const communityFavoriteMatch = url.pathname.match(/^\/api\/community\/assets\/([^/]+)\/(favorite|unfavorite)$/);
    if (request.method === "POST" && communityFavoriteMatch) {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_required" });
        return;
      }
      try {
        const assetId = decodeURIComponent(communityFavoriteMatch[1]);
        const existing = communityAssetStore.get(assetId);
        if (!existing || existing.moderationStatus !== "published") throw new Error("community_asset_not_found");
        const unset = communityFavoriteMatch[2] === "unfavorite";
        const changed = unset
          ? communityInteractionStore.remove({ kind: "favorite", assetId, userId: session.user.id }).removed
          : communityInteractionStore.add({ kind: "favorite", assetId, userId: session.user.id }).created;
        // 计数只在关系真正变化时调整，因此同一人重复点击不会刷数。
        const asset = changed
          ? communityAssetStore.adjustFavoriteCount(assetId, unset ? -1 : 1)
          : communityAssetStore.get(assetId);
        sendJson(response, 200, { success: true, asset, favorited: !unset, changed });
      } catch (error) {
        sendJson(response, error.message === "community_asset_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    // 我的收藏（只看引用，不复制内容）
    if (request.method === "GET" && url.pathname === "/api/community/assets/favorites") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_required" });
        return;
      }
      const assetIds = communityInteractionStore.assetIdsForUser(session.user.id, "favorite");
      const known = new Map(communityAssetStore.list({ includeUnpublished: true }).map((asset) => [asset.id, asset]));
      const assets = assetIds.map((id) => known.get(id)).filter(Boolean);
      sendJson(response, 200, {
        success: true,
        assets,
        unavailableCount: assetIds.length - assets.length,
      });
      return;
    }

    const communityWithdrawMatch = url.pathname.match(/^\/api\/community\/assets\/([^/]+)\/withdraw$/);
    if (request.method === "POST" && communityWithdrawMatch) {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_required" });
        return;
      }
      try {
        const assetId = decodeURIComponent(communityWithdrawMatch[1]);
        await readJsonBody(request).catch(() => ({}));
        const existing = communityAssetStore.get(assetId);
        if (!existing) throw new Error("community_asset_not_found");
        // 只能撤回自己的内容：跨用户操作返回 403 而不是静默改别人的东西。
        if (existing.userId !== session.user.id) {
          sendJson(response, 403, { success: false, error: "community_asset_not_owned" });
          return;
        }
        const asset = communityAssetStore.withdraw(assetId, session.user.id);
        sendJson(response, 200, { success: true, asset });
      } catch (error) {
        sendJson(response, error.message === "community_asset_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    const adminCommunityActionMatch = url.pathname.match(/^\/api\/admin\/community\/assets\/([^/]+)\/action$/);
    if (request.method === "POST" && adminCommunityActionMatch) {
      try {
        const payload = await readJsonBody(request);
        const asset = communityAssetStore.action(decodeURIComponent(adminCommunityActionMatch[1]), payload.action);
        logOperation({
          action: `community_asset.${payload.action}`,
          category: "community",
          targetType: "community_asset",
          targetId: asset.id,
          summary: `${asset.title} · 状态更新为 ${asset.moderationStatus}`,
          metadata: { moderationStatus: asset.moderationStatus },
        });
        sendJson(response, 200, { success: true, asset });
      } catch (error) {
        sendJson(response, error.message === "community_asset_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/billing/products") {
      sendJson(response, 200, { success: true, products: billingStore.listProducts(true) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/billing/account") {
      // 匿名 test-user 兜底只保留在非正式环境；production 下必须登录。
      const identity = resolveRequestIdentity(request, url.searchParams.get("userId"), userAuthStore);
      if (!identity.userId) {
        sendJson(response, 401, { success: false, error: "auth_session_required" });
        return;
      }
      sendJson(response, 200, { success: true, account: billingStore.dashboard(identity.userId).account });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/billing/credits/consume") {
      try {
        const payload = await readJsonBody(request);
        const identity = resolveRequestIdentity(request, payload.userId, userAuthStore);
        if (!identity.userId) {
          sendJson(response, 401, { success: false, error: "auth_session_required" });
          return;
        }
        if (guardUserCapability(response, identity.userId, "write")) return;
        const result = billingStore.consumeCredits(identity.userId, payload);
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, error.message === "billing_credit_insufficient" ? 409 : 422, { success: false, error: error.message });
      }
      return;
    }

    const publicTextbookCatalogMatch = url.pathname.match(/^\/api\/catalog\/textbooks\/([^/]+)$/);
    if (request.method === "GET" && publicTextbookCatalogMatch) {
      const bookId = decodeURIComponent(publicTextbookCatalogMatch[1]);
      const textbook = textbookCatalogStore.get(bookId);
      // Keep the last confirmed version public while editors prepare a new
      // draft. A revision must not make an already published catalog vanish.
      if (!textbook || !textbook.confirmed) {
        sendJson(response, 404, { success: false, error: "textbook_catalog_not_published" });
        return;
      }
      // 目录节点在用户端的父子关系以知识树为准：目录里的 level 是 AI/人工填的，可能标错
      // （实测《现代汉语》上册有 2 个"节"被标成第 3 级，结果挂到了上一条"思考和练习"下面）；
      // 而知识树是可以被人工拖着纠正的。这里对每个目录节点沿树的 parentId 上溯，取"最近的
      // 另一个目录节点"作为父；上溯不到就挂到顶层，节点根本不在树里时返回 null，让客户端
      // 退回按 level 推导。只借层级，节点集合仍完全来自已确认目录。
      const structure = knowledgeStructureStore.get(bookId);
      const treeById = new Map((structure?.nodes || []).map((node) => [String(node.id), node]));
      const publishedIds = new Set(textbook.confirmed.nodes.map((node) => String(node.id)));
      const catalogParentIdOf = (nodeId) => {
        const start = treeById.get(String(nodeId));
        if (!start) return null;
        const visited = new Set([String(nodeId)]);
        let current = start.parentId ? treeById.get(String(start.parentId)) : null;
        while (current && !visited.has(String(current.id))) {
          visited.add(String(current.id));
          if (publishedIds.has(String(current.id))) return String(current.id);
          current = current.parentId ? treeById.get(String(current.parentId)) : null;
        }
        return "";
      };
      sendJson(response, 200, {
        success: true,
        textbook: {
          id: textbook.id,
          bookId: textbook.bookId,
          subjectId: textbook.subjectId,
          title: textbook.title,
          volume: textbook.volume,
          version: textbook.confirmed.version,
          confirmedAt: textbook.confirmed.confirmedAt,
          nodes: textbook.confirmed.nodes.map((node) => {
            const parentId = catalogParentIdOf(node.id);
            return {
              id: node.id,
              order: node.order,
              level: node.level,
              title: node.title,
              startPage: node.startPage,
              endPage: node.endPage,
              knowledgePoints: node.knowledgePoints,
              ...(parentId == null ? {} : { parentId }),
            };
          }),
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/questions") {
      const result = publicQuestionList(questionStore, {
        library: url.searchParams.get("library") || "official",
        subjectId: url.searchParams.get("subjectId") || "all",
        bookId: url.searchParams.get("bookId") || "all",
        chapter: url.searchParams.get("chapter") || "all",
        type: url.searchParams.get("type") || "all",
        query: url.searchParams.get("query") || "",
      });
      const knowledgeQuestions = decorateManualQuestionKnowledge(result.records);
      const catalogProjection = decoratePublicFamilyCatalogProjection(knowledgeQuestions);
      const questions = catalogProjection.questions;
      const etag = result.etag.replace(/"$/, `-${publicKnowledgeRevision(questions)}-${catalogProjection.revision}"`);
      if (String(request.headers["if-none-match"] || "") === etag) {
        response.writeHead(304, {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          ETag: etag,
        });
        response.end();
        return;
      }
      if (url.searchParams.get("summary") === "1") {
        sendJson(response, 200, {
          success: true,
          total: result.total,
          answerItemCount: result.answerItemCount,
          counts: result.counts,
          version: result.version,
          etag,
        }, { ETag: etag });
        return;
      }
      sendJson(response, 200, {
        success: true,
        total: result.total,
        answerItemCount: result.answerItemCount,
        questions: questions.map(publicClientQuestionPayload),
        counts: result.counts,
        version: result.version,
        etag,
      }, { ETag: etag });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/questions/training-pool") {
      const list = (key) => String(url.searchParams.get(key) || "").split(",").map((value) => value.trim()).filter(Boolean);
      const result = publicQuestionList(questionStore, {
        library: "official",
        subjectIds: list("subjectIds"),
        bookIds: list("bookIds"),
        difficultyStars: list("difficultyStars").map(Number).filter((value) => value >= 1 && value <= 5),
      });
      const questions = decorateManualQuestionKnowledge(result.records);
      sendJson(response, 200, {
        success: true,
        pool: "comprehensive",
        total: result.total,
        answerItemCount: result.answerItemCount,
        questions: questions.map(publicClientQuestionPayload),
        counts: result.counts,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/exams") {
      const kind = url.searchParams.get("kind") || "all";
      const year = Number(url.searchParams.get("year")) || 0;
      const result = examStore.list({ status: "published", kind });
      const exams = withExamAnswerReviews(result.exams.filter((exam) => !year || exam.year === year))
        .map(publicExamPayload);
      sendJson(response, 200, { success: true, total: exams.length, exams });
      return;
    }

    const publicExamMatch = url.pathname.match(/^\/api\/exams\/([^/]+)$/);
    if (request.method === "GET" && publicExamMatch) {
      const exam = examStore.get(decodeURIComponent(publicExamMatch[1]));
      if (!exam || exam.status !== "published") {
        sendJson(response, 404, { success: false, error: "exam_not_found" });
        return;
      }
      const reviewedExam = withExamAnswerReview(exam);
      const questions = decorateManualQuestionKnowledge(loadQuestionsByIds(exam.questionIds)
        .filter((question) => question && question.status !== "offline"))
        .map(clientQuestionPayload);
      sendJson(response, 200, {
        success: true,
        exam: { ...publicExamPayload(reviewedExam), availableQuestionCount: questions.length },
        questions,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/exam-exports") {
      try {
        const payload = await readJsonBody(request, 5 * 1024 * 1024);
        // 先定身份再干活：未登录（且非开发态）不该触发任何导出工作。
        const identity = resolveRequestIdentity(request, payload.userId, userAuthStore);
        if (!identity.userId) {
          sendJson(response, 401, { success: false, error: "auth_session_required" });
          return;
        }
        // 成套导出属于“公开分享”能力：被限制公开的账号不能导出分享。
        if (guardUserCapability(response, identity.userId, "publish")) return;
        let sourceExam = payload.exam;
        let sourceQuestions = payload.questions;
        const sourceExamId = String(payload.examId || sourceExam && sourceExam.id || "");
        if (sourceExamId) {
          const storedExam = examStore.get(sourceExamId);
          if (!storedExam || storedExam.status !== "published") throw new Error("exam_export_exam_not_found");
          sourceExam = { ...storedExam, ...examScoreSummary(storedExam) };
          sourceQuestions = storedExam.questionIds
            .map((id) => questionStore.get(id))
            .filter((question) => question && question.status !== "offline");
        }
        const bundle = generateExamExportBundle({ exam: sourceExam, questions: sourceQuestions }, {
          headerText: String(process.env.EXAM_EXPORT_HEADER || "更多汉语言插本文学资讯，请关注公众号：汉化土豆"),
          watermarkText: String(process.env.EXAM_EXPORT_WATERMARK || "薯考"),
        });
        const exportMetadata = { userId: identity.userId };
        const manifest = objectStorage
          ? await persistExamExportBundleToStorage(bundle, objectStorage, exportMetadata)
          : persistExamExportBundle(bundle, examExportRoot, exportMetadata);
        const exportRecord = {
          ...manifest,
          files: manifest.files.map((file) => ({
            ...file,
            url: `/api/exam-exports/${encodeURIComponent(manifest.id)}/${file.kind}.pdf`,
          })),
        };
        logOperation({
          actor: identity.user ? identity.user.nickname : "测试用户",
          actorRole: identity.authenticated ? "user" : "test_user",
          action: "exam.export",
          category: "exam",
          targetType: "exam_export",
          targetId: manifest.id,
          summary: `生成试卷与答案：${manifest.title}`,
          metadata: { examId: manifest.examId, questionCount: manifest.questionCount, reviewQuestionNumbers: manifest.reviewQuestionNumbers },
        });
        sendJson(response, 201, { success: true, export: exportRecord });
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 422, {
          success: false,
          error: error.message,
          missingQuestionNumbers: error.missingQuestionNumbers || [],
        });
      }
      return;
    }

    const examExportFileMatch = url.pathname.match(/^\/api\/exam-exports\/(export-[0-9a-f-]+)\/(paper|answer)\.pdf$/i);
    if (request.method === "GET" && examExportFileMatch) {
      try {
        const exportId = examExportFileMatch[1];
        const kind = examExportFileMatch[2].toLowerCase();
        let file;
        let content;
        if (objectStorage) {
          try {
            const objectKey = examExportObjectKey(exportId, kind);
            file = await objectStorage.stat(objectKey);
            if (!file) throw new Error("exam_export_file_not_found");
            content = await objectStorage.getBuffer(objectKey);
            file = { name: file.fileName };
          } catch (error) {
            if (!isObjectStorageNotFound(error) && error.message !== "exam_export_file_not_found") throw error;
          }
        }
        if (!content) {
          const directory = path.resolve(examExportRoot, exportId);
          if (!directory.startsWith(`${examExportRoot}${path.sep}`)) throw new Error("exam_export_not_found");
          const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
          file = manifest.files.find((item) => item.kind === kind);
          if (!file) throw new Error("exam_export_file_not_found");
          content = fs.readFileSync(path.join(directory, `${kind}.pdf`));
        }
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Length": content.length,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "private, max-age=3600",
        });
        response.end(content);
      } catch (error) {
        sendJson(response, error.code === "ENOENT" ? 404 : 422, { success: false, error: error.message || "exam_export_not_found" });
      }
      return;
    }

    const publicQuestionMatch = url.pathname.match(/^\/api\/questions\/([^/]+)$/);
    if (request.method === "GET" && publicQuestionMatch) {
      const question = questionStore.get(decodeURIComponent(publicQuestionMatch[1]));
      if (!question || question.status === "offline" || !["official", "public", "featured"].includes(question.status)) {
        sendJson(response, 404, { success: false, error: "question_not_found" });
        return;
      }
      sendJson(response, 200, { success: true, question: clientQuestionPayload(decorateManualQuestionKnowledge([question])[0]) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/packs") {
      const query = url.searchParams.get("query") || "";
      const packs = packStore.list({ query }).packs
        .filter((pack) => ["public", "featured"].includes(pack.status))
        .map((pack) => ({
          ...pack,
          questions: pack.questionIds.map((id) => questionStore.get(id)).filter((question) => question && question.status !== "offline"),
        }));
      sendJson(response, 200, { success: true, packs });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/announcements") {
      sendJson(response, 200, { success: true, announcements: announcementStore.publicList() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/feedback/mine") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_invalid" });
        return;
      }
      const items = moderationStore.list({}).reports
        .filter((item) => item.targetType === "app_feedback" && item.reporter && item.reporter.id === session.user.id)
        .map((item) => ({
          id: item.id,
          category: item.feedbackCategory || "other",
          content: item.detail,
          status: item.status,
          resolution: item.resolution,
          response: item.history && item.history.length ? item.history[0].note : "",
          attachmentCount: Array.isArray(item.attachments) ? item.attachments.length : 0,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        }));
      sendJson(response, 200, { success: true, items });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/feedback") {
      const session = userAuthStore.authenticate(bearerToken(request));
      if (!session) {
        sendJson(response, 401, { success: false, error: "auth_session_invalid" });
        return;
      }
      try {
        const payload = await readJsonBody(request, 1024 * 1024);
        // 禁言/封禁账号不能提交反馈与纠错（这是当前唯一的“发言”入口）。
        if (guardUserCapability(response, session.user.id, "speak")) return;
        const category = String(payload.category || "other").trim();
        const content = String(payload.content || "").trim();
        const categoryLabels = {
          feature_issue: "功能异常",
          content_issue: "内容问题",
          experience: "体验建议",
          account: "账号与订阅",
          other: "其他反馈",
        };
        if (!categoryLabels[category]) throw new Error("feedback_category_invalid");
        if (content.length < 5) throw new Error("feedback_content_too_short");
        const report = moderationStore.create({
          source: "user_report",
          type: "product_feedback",
          risk: "low",
          targetType: "app_feedback",
          targetId: `feedback-${crypto.randomUUID()}`,
          targetTitle: categoryLabels[category],
          reporter: { id: session.user.id, nickname: session.user.nickname },
          reason: content.slice(0, 120),
          detail: content,
          feedbackCategory: category,
          contact: payload.contact,
          attachments: payload.attachments,
          clientContext: payload.clientContext,
        });
        logOperation({
          action: "feedback.submit",
          category: "moderation",
          targetType: "app_feedback",
          targetId: report.id,
          summary: `${session.user.nickname}提交${categoryLabels[category]}`,
          metadata: { feedbackCategory: category, attachmentCount: report.attachments.length },
        });
        sendJson(response, 201, { success: true, item: report });
      } catch (error) {
        const status = error.message === "payload_too_large" ? 413 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/overview") {
      sendJson(response, 200, adminOverview(
        aiConfigStore.load(),
        aiTaskStore.dashboard({ limit: 1 }),
        questionStore.list({}).counts,
        moderationStore.list({ status: "pending" }),
      ));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/moderation") {
      sendJson(response, 200, {
        success: true,
        ...moderationStore.list({
          status: url.searchParams.get("status") || "all",
          risk: url.searchParams.get("risk") || "all",
          type: url.searchParams.get("type") || "all",
          query: url.searchParams.get("query") || "",
        }),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/moderation") {
      try {
        const payload = await readJsonBody(request);
        const report = moderationStore.create(payload);
        sendJson(response, 201, { success: true, report });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    const moderationActionMatch = url.pathname.match(/^\/api\/admin\/moderation\/([^/]+)\/action$/);
    if (request.method === "POST" && moderationActionMatch) {
      try {
        const payload = await readJsonBody(request);
        const reportId = decodeURIComponent(moderationActionMatch[1]);
        const before = moderationStore.get(reportId);
        if (!before) throw new Error("moderation_not_found");
        let linkedQuestion = null;
        let linkedQuestionAffectedFamilyIds = [];
        if (payload.action === "offline" && before.targetType === "question" && questionStore.get(before.targetId)) {
          linkedQuestion = questionStore.transition(before.targetId, "offline", currentAdminDisplayName() || "超级管理员");
          linkedQuestionAffectedFamilyIds = markQuestionFamilyMembersPending(
            [linkedQuestion.id],
            "question_offline",
            currentAdminDisplayName() || "超级管理员",
          ).affectedFamilyIds || [];
        }
        let linkedPack = null;
        if (payload.action === "offline" && before.targetType === "pack" && packStore.get(before.targetId)) {
          linkedPack = packStore.action(before.targetId, "offline", currentAdminDisplayName() || "超级管理员");
        }
        let linkedCommunityAsset = null;
        if (before.targetType === "community_asset" && communityAssetStore.get(before.targetId)) {
          if (payload.action === "offline") linkedCommunityAsset = communityAssetStore.action(before.targetId, "offline");
          if (payload.action === "resolve") linkedCommunityAsset = communityAssetStore.action(before.targetId, "approve");
        }
        // 治理动作真的落到用户状态上：禁言 / 禁止投稿 / 公开功能限制 / 账号封禁。
        let restriction = null;
        const restrictionType = RESTRICTION_ACTIONS[payload.action];
        if (restrictionType) {
          const targetUserId = String(before.reportedUser && before.reportedUser.id || payload.userId || "").trim();
          if (!targetUserId) throw new Error("user_restriction_target_required");
          restriction = userRestrictionStore.apply({
            userId: targetUserId,
            type: restrictionType,
            reason: payload.reason || before.reason || "举报处置",
            note: payload.note,
            durationDays: payload.durationDays,
            expiresAt: payload.expiresAt,
            createdBy: currentAdminDisplayName() || "超级管理员",
            createdById: (adminActorContext.getStore() || {}).accountId || "",
          });
          // 封禁必须立刻踢掉该用户已有会话，否则旧 token 还能继续用。
          if (restrictionType === "ban") userAuthStore.logoutUser(targetUserId);
        }
        const report = moderationStore.action(reportId, payload.action, currentAdminDisplayName() || "超级管理员", payload.note);
        logOperation({
          action: `moderation.${payload.action}`,
          category: "moderation",
          targetType: report.targetType,
          targetId: report.targetId,
          summary: restriction
            ? `${report.resolution || "更新审核状态"}：${report.targetTitle}（${restriction.items.map((item) => item.typeLabel).join("、")}至 ${restriction.status.untilLabel}）`
            : `${report.resolution || "更新审核状态"}：${report.targetTitle}`,
          metadata: {
            reportId: report.id,
            reportStatus: report.status,
            linkedQuestionUpdated: Boolean(linkedQuestion),
            linkedQuestionAffectedFamilyIds,
            linkedPackUpdated: Boolean(linkedPack),
            linkedCommunityAssetUpdated: Boolean(linkedCommunityAsset),
            restrictionTypes: restriction ? restriction.items.map((item) => item.type) : [],
            restrictionExpiresAt: restriction ? restriction.status.expiresAt : 0,
          },
        });
        sendJson(response, 200, {
          success: true,
          report,
          restriction: restriction ? { items: restriction.items, status: restriction.status } : null,
          linkedQuestion,
          linkedQuestionAffectedFamilyIds,
          linkedPack,
          linkedCommunityAsset,
        });
      } catch (error) {
        sendJson(response, error.message === "moderation_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/operation-logs") {
      sendJson(response, 200, {
        success: true,
        ...operationLogStore.list({
          category: url.searchParams.get("category") || "all",
          actor: url.searchParams.get("actor") || "all",
          query: url.searchParams.get("query") || "",
          limit: url.searchParams.get("limit") || 100,
        }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/question-catalog") {
      sendJson(response, 200, { success: true, ...questionStore.catalog() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/knowledge-dossiers") {
      const bookId = url.searchParams.get("bookId") || "all";
      const status = url.searchParams.get("status") || "all";
      const nodeId = url.searchParams.get("nodeId") || "";
      const filteredItems = knowledgeDossierStore.list({
        bookId,
        status,
        query: url.searchParams.get("query") || "",
      });
      const allBookItems = knowledgeDossierStore.list({ bookId });
      const allBookFamilies = questionFamilyStore.list({ bookId, status: "all" }).families;
      const familyContext = knowledgeDossierFamilyContext(bookId, allBookItems, allBookFamilies);
      const familyCoverageByDossierId = new Map(allBookItems.map((dossier) => [
        dossier.id,
        knowledgeDossierFamilyCoverage(dossier, familyContext),
      ]));
      const allowedNodeIds = nodeId && bookId !== "all" ? knowledgeStructureStore.descendants(bookId, nodeId) : null;
      const scopedItems = allowedNodeIds
        ? filteredItems.filter((dossier) => dossier.occurrences.some((occurrence) => allowedNodeIds.has(occurrence.nodeId)))
        : filteredItems;
      const items = scopedItems.map((dossier) => ({
        ...dossier,
        affectedFamilies: affectedFamiliesForDossier(dossier, familyContext),
        familyCoverage: familyCoverageByDossierId.get(dossier.id),
      }));
      const pendingDeltas = knowledgeDossierStore.deltas({ bookId, status: "pending" });
      sendJson(response, 200, {
        success: true,
        items,
        treeSummary: knowledgeDossierTreeSummary(bookId, allBookItems),
        relationTargets: allBookItems.map((dossier) => ({
          id: dossier.id,
          canonicalName: dossier.canonicalName,
          status: dossier.status,
        })),
        deltas: pendingDeltas,
        runs: knowledgeDossierStore.runs({ bookId, limit: 20 }),
        summary: {
          total: allBookItems.length,
          active: allBookItems.filter((item) => item.status === "active").length,
          needsReview: allBookItems.filter((item) => ["draft", "evidence_verified", "needs_review", "disputed"].includes(item.status)).length,
          pendingDeltas: pendingDeltas.length,
          familyCovered: [...familyCoverageByDossierId.values()].filter((coverage) => coverage.summary.confirmedFamilyCount > 0).length,
          familyCoverageGaps: [...familyCoverageByDossierId.values()].filter((coverage) => coverage.summary.gapCount > 0).length,
          familyAuditRisks: [...familyCoverageByDossierId.values()].filter((coverage) => coverage.summary.riskFamilyCount > 0).length,
        },
      });
      return;
    }

    const knowledgeDossierDetailMatch = url.pathname.match(/^\/api\/admin\/knowledge-dossiers\/([^/]+)$/);
    if (request.method === "GET" && knowledgeDossierDetailMatch) {
      const dossier = knowledgeDossierStore.get(decodeURIComponent(knowledgeDossierDetailMatch[1]));
      const familyContext = dossier ? knowledgeDossierFamilyContext(dossier.bookId) : null;
      sendJson(response, dossier ? 200 : 404, dossier
        ? {
          success: true,
          dossier: {
            ...dossier,
            affectedFamilies: affectedFamiliesForDossier(dossier, familyContext),
            familyCoverage: knowledgeDossierFamilyCoverage(dossier, familyContext),
          },
          deltas: knowledgeDossierStore.deltas({ dossierId: dossier.id }),
        }
        : { success: false, error: "knowledge_dossier_not_found" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/knowledge-dossiers/compile") {
      let run = null;
      try {
        const payload = await readJsonBody(request).catch(() => ({}));
        const bookId = String(payload.bookId || "");
        const nodeId = String(payload.nodeId || "");
        if (!bookId || !nodeId) throw new Error("knowledge_dossier_scope_required");
        const scope = knowledgeDossierScope(bookId, nodeId);
        const book = books.find((item) => item.id === bookId);
        run = knowledgeDossierStore.createRun({ bookId, nodeId, nodePath: scope.node.path, status: "compiling" });
        const existingDossiers = knowledgeDossierStore.list({ bookId }).slice(0, 100);
        const { raw } = await runKnowledgeClassificationModel("knowledge_dossier_compilation", {
          bookMetadata: book || { id: bookId },
          scopeNode: scope.node,
          scopeNodes: scope.scopeNodes.map((node) => ({
            id: node.id,
            parentId: node.parentId,
            kind: node.kind,
            title: node.displayTitle || node.title,
            path: node.path,
            startPage: node.startPage,
            endPage: node.endPage,
          })),
          textbookEvidence: formatTextbookEvidence(scope.chunks, 26000),
          existingDossiers: existingDossiers.map((dossier) => ({
            id: dossier.id,
            canonicalName: dossier.canonicalName,
            aliases: dossier.aliases,
            definition: dossier.definition,
            inclusionCriteria: dossier.inclusionCriteria,
            exclusionCriteria: dossier.exclusionCriteria,
            occurrencePaths: dossier.occurrences.map((item) => `${item.role}: ${item.path}`),
          })),
          requiredOutput: dossierCompilationSchema,
        }, { bookId, nodeId, nodePath: scope.node.path, evidenceCount: scope.chunks.length }, "knowledge_batch_verification", {
          maxTokens: 3600,
          reasoningEffort: "low",
        });
        const compiled = (Array.isArray(raw?.dossiers) ? raw.dossiers : [])
          .map((item) => ({ item, dossier: normalizeCompiledDossier(item, scope, run.id) }))
          .filter(({ dossier }) => dossier.canonicalName);
        if (!compiled.length) throw new Error("knowledge_dossier_compilation_empty");
        const saved = [];
        const deltas = [];
        compiled.forEach(({ item, dossier }) => {
          const target = item.targetDossierId && knowledgeDossierStore.get(String(item.targetDossierId));
          if (target && target.bookId === bookId && item.action !== "new") {
            deltas.push(knowledgeDossierStore.createDelta({
              bookId,
              dossierId: target.id,
              type: item.action === "supplement" ? "evidence" : "boundary",
              title: `编译建议：${dossier.canonicalName}`,
              reason: String(item.uncertainty || `教材范围“${scope.node.path}”可能补充或调整现有知识档案。`),
              suggestedPatch: dossier,
              evidence: dossier.claims.flatMap((claim) => claim.evidence),
              sourceAgent: "知识编译 Agent",
            }));
            return;
          }
          saved.push(knowledgeDossierStore.save(dossier));
        });
        const completedRun = knowledgeDossierStore.updateRun(run.id, {
          status: "completed",
          dossierIds: [...saved.map((item) => item.id), ...deltas.map((item) => item.dossierId).filter(Boolean)],
          completedAt: Date.now(),
        });
        logOperation({
          action: "knowledge_dossier.compile",
          category: "question",
          targetType: "knowledge_dossier_run",
          targetId: run.id,
          summary: `从“${scope.node.path}”编译 ${saved.length} 份知识档案草稿和 ${deltas.length} 条增量建议`,
          metadata: { bookId, nodeId, dossierIds: saved.map((item) => item.id), deltaIds: deltas.map((item) => item.id) },
        });
        sendJson(response, 200, { success: true, run: completedRun, dossiers: saved, deltas, warnings: raw.warnings || [] });
      } catch (error) {
        if (run) knowledgeDossierStore.updateRun(run.id, { status: "failed", error: error.message, completedAt: Date.now() });
        sendJson(response, error.message === "knowledge_node_not_found" ? 404 : 422, { success: false, error: error.message, ...(error.details ? { details: error.details } : {}) });
      }
      return;
    }

    const knowledgeDossierVerifyMatch = url.pathname.match(/^\/api\/admin\/knowledge-dossiers\/([^/]+)\/verify$/);
    if (request.method === "POST" && knowledgeDossierVerifyMatch) {
      try {
        const dossierId = decodeURIComponent(knowledgeDossierVerifyMatch[1]);
        const dossier = knowledgeDossierStore.get(dossierId);
        if (!dossier) throw new Error("knowledge_dossier_not_found");
        const structure = knowledgeStructureStore.get(dossier.bookId);
        const validNodeIds = [...new Set(dossier.occurrences.map((item) => item.nodeId)
          .filter((nodeId) => structure?.nodes?.some((node) => node.id === nodeId)))];
        if (!validNodeIds.length) throw new Error("knowledge_dossier_scope_required");
        const scopes = validNodeIds.map((nodeId) => knowledgeDossierScope(dossier.bookId, nodeId));
        const referencedChunkIds = new Set([
          ...dossier.claims.flatMap((claim) => claim.evidence.map((item) => item.chunkId)),
          ...dossier.occurrences.flatMap((item) => item.chunkIds),
        ]);
        const knowledge = textbookKnowledgeStore.get(dossier.bookId, { includeContent: true });
        const referencedChunks = (knowledge.chunks || []).filter((chunk) => referencedChunkIds.has(chunk.id));
        const evidenceChunks = [...new Map([
          ...referencedChunks,
          ...scopes.flatMap((scope) => scope.chunks),
        ].map((chunk) => [chunk.id, chunk])).values()].slice(0, 24);
        const relatedIds = new Set(dossier.relations.map((item) => item.targetDossierId).filter(Boolean));
        const relatedDossiers = knowledgeDossierStore.list({ bookId: dossier.bookId })
          .filter((item) => item.id !== dossier.id && (relatedIds.has(item.id) || item.status === "active")).slice(0, 30);
        const book = books.find((item) => item.id === dossier.bookId);
        const { raw } = await runKnowledgeClassificationModel("knowledge_dossier_verification", {
          bookMetadata: book || { id: dossier.bookId },
          dossier,
          relatedDossiers,
          textbookEvidence: formatTextbookEvidence(evidenceChunks, 14000),
          requiredOutput: {
            claimChecks: [{ claimId: "声明 ID", supported: true, issue: "不支持时说明", evidenceChunkIds: ["真实片段 ID"] }],
            evidenceCoverage: 1,
            claimsVerified: true,
            boundaryComplete: true,
            sourceRolesClear: true,
            relationCyclesValid: true,
            conflicts: ["未解决冲突，没有则为空数组"],
            warnings: ["非阻断提醒"],
            verifierNotes: "独立核验结论与修改建议",
          },
        }, { bookId: dossier.bookId, dossierId, claimCount: dossier.claims.length }, "knowledge_batch_verification", {
          maxTokens: 2200,
          reasoningEffort: "low",
        });
        const verification = {
          evidenceCoverage: Number(raw.evidenceCoverage) || 0,
          claimsVerified: raw.claimsVerified === true && (raw.claimChecks || []).every((item) => item.supported === true),
          boundaryComplete: raw.boundaryComplete === true,
          sourceRolesClear: raw.sourceRolesClear === true,
          relationCyclesValid: raw.relationCyclesValid !== false,
          conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
          warnings: [...(Array.isArray(raw.warnings) ? raw.warnings : []), ...(raw.claimChecks || []).filter((item) => item.supported !== true).map((item) => item.issue).filter(Boolean)],
          verifierNotes: raw.verifierNotes,
          claimChecks: Array.isArray(raw.claimChecks) ? raw.claimChecks : [],
          verifiedAt: Date.now(),
          verifiedBy: "独立核验 Agent",
        };
        const fullyVerified = verification.claimsVerified && verification.evidenceCoverage >= 1
          && verification.boundaryComplete && verification.sourceRolesClear
          && verification.relationCyclesValid && !verification.conflicts.length;
        const status = fullyVerified ? "boundary_verified" : (verification.claimsVerified ? "evidence_verified" : "needs_review");
        const saved = knowledgeDossierStore.save({ ...dossier, verification, status });
        sendJson(response, 200, { success: true, dossier: saved, claimChecks: raw.claimChecks || [] });
      } catch (error) {
        sendJson(response, error.message === "knowledge_dossier_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "PUT" && knowledgeDossierDetailMatch) {
      try {
        const dossierId = decodeURIComponent(knowledgeDossierDetailMatch[1]);
        const current = knowledgeDossierStore.get(dossierId);
        if (!current) throw new Error("knowledge_dossier_not_found");
        const payload = await readJsonBody(request);
        const dossier = knowledgeDossierStore.save({ ...current, ...payload, id: dossierId }, currentAdminDisplayName() || "超级管理员");
        sendJson(response, 200, { success: true, dossier });
      } catch (error) {
        sendJson(response, error.message === "knowledge_dossier_not_found" ? 404 : 422, { success: false, error: error.message, ...(error.details ? { details: error.details } : {}) });
      }
      return;
    }

    const knowledgeDossierDeltaReviewMatch = url.pathname.match(/^\/api\/admin\/knowledge-dossier-deltas\/([^/]+)\/review$/);
    if (request.method === "POST" && knowledgeDossierDeltaReviewMatch) {
      try {
        const deltaId = decodeURIComponent(knowledgeDossierDeltaReviewMatch[1]);
        const payload = await readJsonBody(request).catch(() => ({}));
        const delta = knowledgeDossierStore.deltas({ status: "all" }).find((item) => item.id === deltaId);
        if (!delta) throw new Error("knowledge_dossier_delta_not_found");
        const decision = payload.decision === "applied" ? "applied" : (payload.decision === "rejected" ? "rejected" : "");
        if (!decision) throw new Error("knowledge_dossier_delta_decision_invalid");
        let dossier = delta.dossierId ? knowledgeDossierStore.get(delta.dossierId) : null;
        if (decision === "applied") {
          if (dossier) dossier = knowledgeDossierStore.save(mergeDossierPatch(dossier, delta.suggestedPatch), currentAdminDisplayName() || "超级管理员");
          else if (delta.type === "new_concept") dossier = knowledgeDossierStore.save({ ...delta.suggestedPatch, bookId: delta.bookId }, currentAdminDisplayName() || "超级管理员");
        }
        const reviewed = knowledgeDossierStore.reviewDelta(deltaId, decision, currentAdminDisplayName() || "超级管理员", payload.reviewNote || "");
        sendJson(response, 200, { success: true, delta: reviewed, dossier });
      } catch (error) {
        sendJson(response, error.message === "knowledge_dossier_delta_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/knowledge-structure") {
      const bookId = url.searchParams.get("bookId") || "modern-chinese-7-1";
      let structure = knowledgeStructureStore.get(bookId);
      if (!structure && url.searchParams.get("generate") === "true") {
        const textbook = textbookCatalogStore.get(bookId);
        const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: true });
        const questions = questionStore.list({ library: "official", status: "all", bookId }).questions
          .filter((question) => question.status !== "offline");
        structure = knowledgeStructureStore.generate({
          bookId,
          catalogNodes: textbook?.confirmed?.nodes || [],
          outlineNodes: textbookKnowledgeStore.outline(bookId),
          chunks: knowledge.chunks || [],
          questions,
        });
      }
      sendJson(response, structure ? 200 : 404, structure
        ? { success: true, structure }
        : { success: false, error: "knowledge_structure_not_found" });
      return;
    }

    // "补漏"：把目录/正文里有、树里还没有的节点补进来，已有节点一律不动。
    // 这是界面上那个按钮的默认行为——误点最多多出几个节点，不会毁掉已构建的树。
    if (request.method === "POST" && url.pathname === "/api/admin/knowledge-structure/fill-gaps") {
      try {
        const payload = await readJsonBody(request).catch(() => ({}));
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const textbook = textbookCatalogStore.get(bookId);
        if (!textbook?.confirmed?.nodes?.length) throw new Error("catalog_confirmed_not_found");
        const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: true });
        if (!knowledge.chunks?.length) throw new Error("textbook_knowledge_not_built");
        const questions = questionStore.list({ library: "official", status: "all", bookId }).questions
          .filter((question) => question.status !== "offline");
        const result = knowledgeStructureStore.fillGaps({
          bookId,
          catalogNodes: textbook.confirmed.nodes,
          outlineNodes: textbookKnowledgeStore.outline(bookId),
          chunks: knowledge.chunks,
          questions,
        });
        logOperation({
          action: "knowledge_structure.fill_gaps",
          category: "question",
          targetType: "knowledge_structure",
          targetId: bookId,
          summary: `按目录补齐知识树：新增 ${result.addedNodeCount} 个节点，原有 ${result.existingNodeCount} 个节点未改动`,
          metadata: { addedNodeCount: result.addedNodeCount, existingNodeCount: result.existingNodeCount },
        });
        sendJson(response, 200, {
          success: true,
          structure: result.structure,
          addedNodeCount: result.addedNodeCount,
          existingNodeCount: result.existingNodeCount,
          created: result.created,
        });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/knowledge-structure/backups") {
      try {
        const payload = await readJsonBody(request).catch(() => ({}));
        const bookId = String(payload.bookId || "");
        if (!bookId) throw new Error("knowledge_structure_book_required");
        const backup = knowledgeStructureStore.backup(bookId, { reason: String(payload.reason || "manual") });
        sendJson(response, 200, { success: true, backup });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/knowledge-structure/backups") {
      try {
        const bookId = String(url.searchParams.get("bookId") || "");
        if (!bookId) throw new Error("knowledge_structure_book_required");
        sendJson(response, 200, { success: true, bookId, backups: knowledgeStructureStore.listBackups(bookId) });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    const knowledgeStructureBackupRestoreMatch = url.pathname.match(/^\/api\/admin\/knowledge-structure\/backups\/([^/]+)\/restore$/);
    if (request.method === "POST" && knowledgeStructureBackupRestoreMatch) {
      try {
        const fileName = decodeURIComponent(knowledgeStructureBackupRestoreMatch[1]);
        const payload = await readJsonBody(request).catch(() => ({}));
        const bookId = String(payload.bookId || "");
        if (!bookId) throw new Error("knowledge_structure_book_required");
        const result = knowledgeStructureStore.restoreBackup(bookId, fileName);
        logOperation({
          action: "knowledge_structure.restore",
          category: "question",
          targetType: "knowledge_structure",
          targetId: bookId,
          summary: `回滚知识树存档 ${fileName}`,
          metadata: { fileName, nodeCount: (result.structure?.nodes || []).length },
        });
        sendJson(response, 200, { success: true, structure: result.structure, restored: true, fileName });
      } catch (error) {
        sendJson(response, error.message === "knowledge_structure_backup_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/knowledge-structure/generate") {
      try {
        const payload = await readJsonBody(request).catch(() => ({}));
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const textbook = textbookCatalogStore.get(bookId);
        if (!textbook?.confirmed?.nodes?.length) throw new Error("catalog_confirmed_not_found");
        const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: true });
        if (!knowledge.chunks?.length) throw new Error("textbook_knowledge_not_built");
        const questions = questionStore.list({ library: "official", status: "all", bookId }).questions
          .filter((question) => question.status !== "offline");
        const structure = knowledgeStructureStore.generate({
          bookId,
          catalogNodes: textbook.confirmed.nodes,
          outlineNodes: textbookKnowledgeStore.outline(bookId),
          chunks: knowledge.chunks,
          questions,
        });
        logOperation({
          action: "knowledge_structure.generate",
          category: "question",
          targetType: "knowledge_structure",
          targetId: bookId,
          summary: `为教材生成 ${structure.summary.knowledgeNodeCount} 个知识点节点和 ${structure.summary.mappedQuestionCount} 个题目指纹`,
          metadata: structure.summary,
        });
        sendJson(response, 200, { success: true, structure });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/knowledge-structure/nodes") {
      try {
        const payload = await readJsonBody(request);
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const result = knowledgeStructureStore.createNode(bookId, payload);
        logOperation({
          action: "knowledge_structure.node_create",
          category: "question",
          targetType: "knowledge_node",
          targetId: result.node.id,
          summary: `新增知识节点：${result.node.path}`,
          metadata: { bookId, nodeId: result.node.id, parentId: result.node.parentId },
        });
        sendJson(response, 201, { success: true, ...result });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    const knowledgeNodeQuestionsMatch = url.pathname.match(/^\/api\/admin\/knowledge-structure\/nodes\/([^/]+)\/questions$/);
    if (request.method === "GET" && knowledgeNodeQuestionsMatch) {
      try {
        const bookId = url.searchParams.get("bookId") || "modern-chinese-7-1";
        const nodeId = decodeURIComponent(knowledgeNodeQuestionsMatch[1]);
        const result = knowledgeStructureStore.questionsForNode(bookId, nodeId);
        const questionIds = result.questions.map((row) => row.questionId);
        const questionById = new Map(questionStore.getMany(questionIds).filter(Boolean)
          .map((question) => [String(question.id), question]));
        const questions = result.questions.map((row) => {
          const question = questionById.get(row.questionId);
          return {
            ...row,
            stem: question ? String(question.stem || "") : "",
            questionVersion: question ? Number(question.version) || 0 : 0,
            missing: !question,
          };
        });
        sendJson(response, 200, {
          success: true,
          node: result.node,
          subtreeNodeIds: result.subtreeNodeIds,
          questionCount: questions.length,
          blockingCount: questions.filter((row) => row.blocksDelete).length,
          questions,
        });
      } catch (error) {
        sendJson(response, error.message === "knowledge_node_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    const knowledgeNodeMatch = url.pathname.match(/^\/api\/admin\/knowledge-structure\/nodes\/([^/]+)$/);
    if (knowledgeNodeMatch && request.method === "PUT") {
      try {
        const payload = await readJsonBody(request);
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const nodeId = decodeURIComponent(knowledgeNodeMatch[1]);
        const result = knowledgeStructureStore.updateNode(bookId, nodeId, payload);
        logOperation({
          action: "knowledge_structure.node_update",
          category: "question",
          targetType: "knowledge_node",
          targetId: nodeId,
          summary: `修改知识节点：${result.node.path}`,
          metadata: { bookId, nodeId, parentId: result.node.parentId },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    if (knowledgeNodeMatch && request.method === "DELETE") {
      try {
        const payload = await readJsonBody(request).catch(() => ({}));
        const bookId = String(payload.bookId || url.searchParams.get("bookId") || "modern-chinese-7-1");
        const nodeId = decodeURIComponent(knowledgeNodeMatch[1]);
        const deletedScope = knowledgeStructureStore.descendants(bookId, nodeId);
        const referencedSets = typeof questionFamilyStore.listSets === "function"
          ? questionFamilyStore.listSets({ bookId }).sets.filter((familySet) => deletedScope.has(familySet.knowledgeNodeId))
          : [];
        if (referencedSets.length) throw new Error("knowledge_node_has_family_sets");
        const result = knowledgeStructureStore.deleteNode(bookId, nodeId);
        logOperation({
          action: "knowledge_structure.node_delete",
          category: "question",
          targetType: "knowledge_node",
          targetId: nodeId,
          summary: `删除知识节点及其下级，共 ${result.deletedNodeIds.length} 个节点`,
          metadata: { bookId, nodeId, deletedNodeIds: result.deletedNodeIds },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, 422, {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/questions/batch-knowledge-assignment") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const bookId = String(payload.bookId || "");
        const primaryNodeId = String(payload.primaryNodeId || payload.nodeId || "");
        const primaryNodeRole = normalizedPrimaryNodeRole(payload.primaryNodeRole || payload.coreKnowledgeRole);
        const requiredNodeIds = [...new Set([
          ...(primaryNodeRole === "core" ? [primaryNodeId] : []),
          ...(Array.isArray(payload.requiredNodeIds) ? payload.requiredNodeIds : []),
        ].map(String).filter(Boolean))];
        const questionIds = [...new Set((Array.isArray(payload.questionIds) ? payload.questionIds : []).map(String).filter(Boolean))];
        if (!bookId || !primaryNodeId || !questionIds.length) throw new Error("knowledge_assignments_required");
        const selectedQuestions = questionStore.getMany(questionIds).filter(Boolean);
        if (selectedQuestions.length !== questionIds.length) throw new Error("knowledge_question_not_found");
        if (selectedQuestions.some((question) => mergedQuestionTargetId(question))) throw new Error("question_merged_source_read_only");
        if (selectedQuestions.some((question) => question.bookId !== bookId)) throw new Error("knowledge_assignment_book_mismatch");

        const selectedIdSet = new Set(questionIds);
        const affectedPreviousFamilyIds = questionFamilyStore.list({ bookId, status: "all" }).families
          .filter((family) => family.members.some((member) => selectedIdSet.has(member.questionId)))
          .map((family) => family.id);
        const assigned = knowledgeStructureStore.assignQuestions(bookId, questionIds.map((questionId) => ({
          questionId,
          primaryNodeId,
          primaryNodeRole,
          requiredNodeIds,
        })));
        const questions = questionStore.list({ library: "official", status: "all", bookId }).questions
          .filter((question) => question.status !== "offline");
        const fingerprintMap = new Map(assigned.structure.fingerprints.map((item) => [item.questionId, item]));
        const nodeOrder = new Map(assigned.structure.nodes.map((node, index) => [node.id, index + 1]));
        const regenerated = questionFamilyStore.generate(questions, bookId, {
          fingerprintMap,
          nodeOrder,
          archiveReason: "question_knowledge_reassigned",
          resetReviewQuestionIds: questionIds,
        });
        const affectedPreviousFamilyIdSet = new Set(affectedPreviousFamilyIds);
        const affectedFamilyCount = regenerated.families.filter((family) => affectedPreviousFamilyIdSet.has(family.id)
          || family.members.some((member) => selectedIdSet.has(member.questionId))).length;
        logOperation({
          action: "knowledge_structure.question_batch_assign",
          category: "question",
          targetType: "knowledge_fingerprint",
          targetId: primaryNodeId,
          summary: `批量调整 ${questionIds.length} 道题的核心考查知识与最小充分知识集并重新归组`,
          metadata: { bookId, primaryNodeId, primaryNodeRole, requiredNodeIds, questionIds, affectedPreviousFamilyIds, affectedFamilyCount },
        });
        sendJson(response, 200, {
          success: true,
          structure: assigned.structure,
          assignments: assigned.assignments,
          affectedFamilyCount,
          familySummary: {
            total: regenerated.total,
            pending: regenerated.pending,
            confirmed: regenerated.confirmed,
            rejected: regenerated.rejected,
          },
        });
      } catch (error) {
        sendJson(response, error.message === "question_merged_source_read_only" ? 409 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/knowledge-structure/question-assignments") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const assignmentQuestionIds = [...new Set((Array.isArray(payload.assignments) ? payload.assignments : [])
          .map((assignment) => String(assignment && assignment.questionId || "")).filter(Boolean))];
        if (questionStore.getMany(assignmentQuestionIds).filter(Boolean).some((question) => mergedQuestionTargetId(question))) {
          throw new Error("question_merged_source_read_only");
        }
        const result = knowledgeStructureStore.assignQuestions(bookId, payload.assignments);
        logOperation({
          action: "knowledge_structure.question_assign",
          category: "question",
          targetType: "knowledge_fingerprint",
          targetId: bookId,
          summary: `人工调整 ${result.assignments.length} 道题的知识归属`,
          metadata: { bookId, assignments: result.assignments },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, error.message === "question_merged_source_read_only" ? 409 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/knowledge-classification/gold-review/sets") {
      const sets = classificationGoldReviewStore.list();
      sendJson(response, 200, { success: true, sets, items: sets });
      return;
    }

    const classificationGoldRevisionMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/revisions$/);
    if (request.method === "POST" && classificationGoldRevisionMatch) {
      try {
        const parentBatchId = decodeURIComponent(classificationGoldRevisionMatch[1]);
        const payload = await readJsonBody(request, 1024 * 1024);
        const parentBatch = classificationGoldReviewStore.get(parentBatchId);
        if (!parentBatch) throw new Error("classification_gold_review_batch_not_found");
        const formalFacts = classificationGoldRevisionFormalFamilyFacts(parentBatch);
        const formalBaselineStatuses = Object.fromEntries(parentBatch.items.map((item) => [
          item.questionId,
          classificationGoldBusinessSyncStatus(item),
        ]));
        const formalBaselineProvenance = {
          source: "formal_question_and_knowledge_revision_precheck",
          capturedAt: new Date().toISOString(),
          contentSha256: contentHash(formalBaselineStatuses),
          statuses: formalBaselineStatuses,
          formalBusinessDataMutated: false,
        };
        const formalDriftIssues = Object.entries(formalBaselineStatuses)
          .filter(([, status]) => status.status !== "synced")
          .map(([questionId, status]) => ({
            questionId,
            code: status.status === "knowledge_drift" ? "formal_knowledge_drift" : "formal_question_drift",
            message: status.status === "knowledge_drift"
              ? "V1 的知识金标与当前正式知识指纹不一致，必须先完成答案与知识审核。"
              : "V1 的题目或答案版本与当前正式题目不一致，必须先完成答案与知识审核。",
            source: "formal_baseline_revision_precheck",
            requiredStages: ["content", "family"],
            expected: status.formalQuestionVersion,
            actual: status.auditQuestionVersion,
          }));
        const formalFamilyMissingIssues = Object.entries(formalFacts.provenance.missingFamilyIdsByQuestion || {})
          .flatMap(([questionId, familyIds]) => (familyIds || []).map((familyId) => ({
            questionId,
            familyId,
            code: "formal_family_missing",
            message: "V1 选择的题族在当前正式题族库中不存在，必须重新审核题族裁决。",
            source: "formal_family_revision_precheck",
            requiredStages: ["family"],
            expected: familyId,
            actual: "missing",
          })));
        const defaultRevisionId = `${parentBatchId}-${String(payload.version || "revision").toLowerCase()}`;
        const created = classificationGoldReviewStore.createRevisionDraft(parentBatchId, {
          ...payload,
          id: payload.id || defaultRevisionId,
          reviewer: currentAdminDisplayName() || "超级管理员",
          qualificationIssues: [
            ...(Array.isArray(payload.qualificationIssues) ? payload.qualificationIssues : []),
            ...formalDriftIssues,
            ...formalFamilyMissingIssues,
          ],
          formalFamilyFactsByQuestionId: formalFacts.factsByQuestionId,
          formalFamilyFactsProvenance: formalFacts.provenance,
          formalBaselineProvenance,
        });
        if (created.created) {
          logOperation({
            action: "knowledge_classification.gold_review_revision_create",
            category: "question",
            targetType: "classification_gold_review_batch",
            targetId: created.batch.id,
            summary: `从冻结金标集建立修订草稿：${created.batch.title} ${created.batch.version}`,
            metadata: {
              parentBatchId,
              parentSnapshotId: created.batch.source.parentSnapshotId,
              parentFileSha256: created.batch.source.parentFileSha256,
              parentContentSha256: created.batch.source.parentContentSha256,
              formalFamilyFactsSha256: created.batch.source.formalFamilyFactsSha256,
              requestedRiskQuestionIds: created.revisionReview.requestedRiskQuestionIds,
              automaticallyReopenedQuestionIds: created.revisionReview.automaticallyReopenedQuestionIds,
              inheritedQuestionIds: created.revisionReview.inheritedQuestionIds,
              blindReplayStarted: false,
              automatedAiAcceptance: false,
              agent4Triggered: false,
              formalBusinessDataMutated: false,
            },
          });
        }
        sendJson(response, created.created ? 201 : 200, {
          success: true,
          ...created,
          blindReplayStarted: false,
          automatedAiAcceptance: false,
          agent4Triggered: false,
          formalBusinessDataMutated: false,
        });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldFamilyPreflightMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/family-reviews\/preflight$/);
    if ((request.method === "GET" || request.method === "POST") && classificationGoldFamilyPreflightMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldFamilyPreflightMatch[1]);
        let payload = {};
        if (request.method === "POST") payload = await readJsonBody(request, 1024 * 1024);
        const queryQuestionIds = [
          ...url.searchParams.getAll("questionId"),
          ...String(url.searchParams.get("questionIds") || "").split(","),
        ].map((value) => String(value || "").trim()).filter(Boolean);
        const questionIds = Array.isArray(payload.questionIds) && payload.questionIds.length
          ? payload.questionIds
          : queryQuestionIds;
        const validation = classificationGoldReviewStore.validateFamilySemantics(batchId, { questionIds });
        const batch = classificationGoldReviewStore.get(batchId);
        sendJson(response, 200, {
          success: true,
          batch,
          validation,
          preflightReportHash: contentHash({ batchId, questionIds, validation }),
          automatedAiAcceptance: false,
          agent4Triggered: false,
          formalBusinessDataMutated: false,
        });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldFamilyPreflightSyncMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/family-reviews\/(?:sync-preflight|preflight\/sync)$/);
    if (request.method === "POST" && classificationGoldFamilyPreflightSyncMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldFamilyPreflightSyncMatch[1]);
        const payload = await readJsonBody(request, 1024 * 1024);
        const synced = classificationGoldReviewStore.syncPreflightIssues(batchId, {
          ...payload,
          reviewer: currentAdminDisplayName() || "超级管理员",
        });
        if (!synced.idempotentReplay && synced.changed) {
          logOperation({
            action: "knowledge_classification.gold_review_preflight_sync",
            category: "question",
            targetType: "classification_gold_review_batch",
            targetId: batchId,
            summary: `根据语义预检重开 ${synced.operation.questionIds.length} 道题的题族复审`,
            metadata: {
              batchId,
              questionIds: synced.operation.questionIds,
              preflightReportHash: synced.operation.preflightReportHash,
              operationKey: synced.operation.operationKey,
              semanticIssueCount: synced.operation.semanticIssueCount,
              warningCount: synced.operation.warningCount,
              automatedAiAcceptance: false,
              agent4Triggered: false,
              formalBusinessDataMutated: false,
            },
          });
        }
        sendJson(response, 200, {
          success: true,
          ...synced,
          automatedAiAcceptance: false,
          agent4Triggered: false,
          formalBusinessDataMutated: false,
        });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldFamilyReopenMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/family-reviews\/reopen$/);
    if (request.method === "POST" && classificationGoldFamilyReopenMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldFamilyReopenMatch[1]);
        const payload = await readJsonBody(request, 512 * 1024);
        const reopened = classificationGoldReviewStore.reopenFamilyReviews(batchId, {
          ...payload,
          reviewer: currentAdminDisplayName() || "超级管理员",
        });
        if (!reopened.idempotentReplay) {
          logOperation({
            action: "knowledge_classification.gold_review_family_reopen",
            category: "question",
            targetType: "classification_gold_review_batch",
            targetId: batchId,
            summary: `根据一致性预检追加 ${reopened.operation.questionIds.length} 道题的题族复审`,
            metadata: {
              batchId,
              questionIds: reopened.operation.questionIds,
              preflightReportHash: reopened.operation.preflightReportHash,
              operationKey: reopened.operation.operationKey,
              automatedAiAcceptance: false,
              agent4Triggered: false,
              formalBusinessDataMutated: false,
            },
          });
        }
        sendJson(response, 200, {
          success: true,
          ...reopened,
          blindReplayStarted: false,
          automatedAiAcceptance: false,
          agent4Triggered: false,
          formalBusinessDataMutated: false,
        });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldReviewSetMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)$/);
    if (request.method === "GET" && classificationGoldReviewSetMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldReviewSetMatch[1]);
        const batch = classificationGoldReviewStore.get(batchId);
        if (!batch) throw new Error("classification_gold_review_batch_not_found");
        const decoratedBatch = {
          ...batch,
          items: batch.items.map((item) => classificationGoldDecorateItem(item)),
        };
        sendJson(response, 200, { success: true, set: decoratedBatch, batch: decoratedBatch });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldReloadMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/items\/([^/]+)\/reload$/);
    if (request.method === "POST" && classificationGoldReloadMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldReloadMatch[1]);
        const questionId = decodeURIComponent(classificationGoldReloadMatch[2]);
        const payload = await readJsonBody(request, 256 * 1024);
        const batch = classificationGoldReviewStore.get(batchId);
        if (!batch) throw new Error("classification_gold_review_batch_not_found");
        if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
        const item = batch.items.find((entry) => entry.questionId === questionId);
        if (!item) throw new Error("classification_gold_review_item_not_found");
        const businessSync = classificationGoldBusinessSyncStatus(item);
        if (!["question_drift", "knowledge_drift"].includes(businessSync.status)) {
          throw new Error("classification_gold_review_reload_not_required");
        }
        const formalQuestion = questionStore.get(questionId);
        if (!formalQuestion) throw new Error("question_not_found");
        const structure = knowledgeStructureStore.get(formalQuestion.bookId);
        const fingerprint = (structure?.fingerprints || []).find((entry) => entry.questionId === questionId);
        if (!fingerprint?.primaryNodeId || !(fingerprint.requiredNodeIds || []).length) {
          throw new Error("classification_gold_review_formal_knowledge_drift");
        }
        const knowledgeNodeMap = new Map((structure.nodes || []).map((node) => [node.id, node]));
        const knowledgeNode = (nodeId) => {
          const node = knowledgeNodeMap.get(nodeId);
          return { id: nodeId, title: node?.displayTitle || node?.title || nodeId, path: node?.path || "" };
        };
        const answerKnowledge = {
          correctAnswer: formalQuestion.correctAnswer,
          referenceAnswer: formalQuestion.referenceAnswer,
          answerSource: formalQuestion.answerSource,
          answerReviewStatus: formalQuestion.answerReviewStatus,
          textbookEvidence: item.answerKnowledge.textbookEvidence,
          coreKnowledge: knowledgeNode(fingerprint.primaryNodeId),
          coreKnowledgeRole: normalizedPrimaryNodeRole(fingerprint.primaryNodeRole),
          requiredKnowledge: fingerprint.requiredNodeIds.map(knowledgeNode),
          optionKnowledge: item.answerKnowledge.optionKnowledge,
          scoringPoints: formalQuestion.scoringPoints,
        };
        const memberships = questionFamilyStore.memberships([questionId], { status: "all" })[questionId] || [];
        const familyGold = {
          ...item.familyGold,
          families: (item.familyGold.families || []).map((family) => questionFamilyStore.get(family.id) || family),
          reason: [item.familyGold.reason, "正式答案或知识基线已重载，原盲测模式与题族裁决草稿保持不变，需重新人工审核。"]
            .filter(Boolean).join("\n"),
        };
        const reloaded = classificationGoldReviewStore.reloadItem(batchId, questionId, {
          expectedRevision: payload.expectedRevision,
          formalDriftConfirmed: true,
          formalDriftStatus: businessSync.status,
          question: formalQuestion,
          answerKnowledge,
          answerKnowledgeProvenance: {
            source: "formal_question_reload",
            questionVersion: formalQuestion.version,
            fingerprint: {
              primaryNodeId: fingerprint.primaryNodeId,
              primaryNodeRole: normalizedPrimaryNodeRole(fingerprint.primaryNodeRole),
              requiredNodeIds: fingerprint.requiredNodeIds,
              // 主题范围锚点与问题知识范围必须随指纹留痕：审核界面要据此判断
              // "选项标注的知识点是否落在本题主题范围之内"（跨主题只能记在选项行）。
              knowledgeThemeRangeAnchorNodeId: String(fingerprint.knowledgeThemeRangeAnchorNodeId
                || fingerprint.themeRangeAnchorNodeId
                || fingerprint.scopeAnchorNodeId || ""),
              problemKnowledgeRangeNodeIds: [...new Set([
                ...(Array.isArray(fingerprint.problemKnowledgeRangeNodeIds) ? fingerprint.problemKnowledgeRangeNodeIds : []),
                ...(Array.isArray(fingerprint.requiredNodeIds) ? fingerprint.requiredNodeIds : []),
              ].map(String).filter(Boolean))],
            },
          },
          familyGold,
          familyGoldProvenance: {
            ...(item.familyGoldProvenance || {}),
            source: "formal_baseline_reload_family_draft_preserved",
            questionVersion: formalQuestion.version,
            formalFamilyIds: memberships.map((membership) => membership.familyId),
            preservedDecision: item.familyGold.decision,
            preservedReplayMode: item.familyGold.replayMode,
          },
        });
        logOperation({
          action: "knowledge_classification.gold_review_reload",
          category: "question",
          targetType: "classification_gold_review_item",
          targetId: `${batchId}:${questionId}`,
          summary: `从正式题库重载盲测金标草稿：${questionId}`,
          metadata: {
            batchId,
            questionId,
            questionVersion: formalQuestion.version,
            primaryNodeId: fingerprint.primaryNodeId,
            primaryNodeRole: normalizedPrimaryNodeRole(fingerprint.primaryNodeRole),
            requiredNodeIds: fingerprint.requiredNodeIds,
            familyIds: memberships.map((membership) => membership.familyId),
            itemRevision: reloaded.item.revision,
            reviewsReset: true,
            blindReplayStarted: false,
          },
        });
        sendJson(response, 200, {
          success: true,
          ...reloaded,
          item: classificationGoldDecorateItem(reloaded.item),
          question: formalQuestion,
          knowledgeAssignment: {
            questionId,
            primaryNodeId: fingerprint.primaryNodeId,
            primaryNodeRole: normalizedPrimaryNodeRole(fingerprint.primaryNodeRole),
            requiredNodeIds: fingerprint.requiredNodeIds,
          },
          familyMemberships: memberships,
          blindReplayStarted: false,
        });
      } catch (error) {
        const status = error.message === "question_not_found" ? 404 : classificationGoldReviewErrorStatus(error);
        sendJson(response, status, {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldBusinessContentMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/items\/([^/]+)\/business-content$/);
    if (request.method === "PUT" && classificationGoldBusinessContentMatch) {
      if (options.persistence) {
        sendJson(response, 503, { success: false, error: "classification_gold_review_business_transaction_required" });
        return;
      }
      try {
        const batchId = decodeURIComponent(classificationGoldBusinessContentMatch[1]);
        const questionId = decodeURIComponent(classificationGoldBusinessContentMatch[2]);
        const payload = await readJsonBody(request, 1024 * 1024);
        const batch = classificationGoldReviewStore.get(batchId);
        if (!batch) throw new Error("classification_gold_review_batch_not_found");
        if (batch.status === "frozen") throw new Error("classification_gold_review_frozen");
        const item = batch.items.find((entry) => entry.questionId === questionId);
        if (!item) throw new Error("classification_gold_review_item_not_found");
        if (Number(payload.expectedRevision) !== item.revision) throw new Error("classification_gold_review_revision_conflict");
        if (payload.result !== "corrected") throw new Error("classification_gold_review_business_correction_required");
        const note = String(payload.note || "").trim().slice(0, 4000);
        if (!note) throw new Error("classification_gold_review_note_required");

        const currentQuestion = questionStore.get(questionId);
        if (!currentQuestion) throw new Error("question_not_found");
        const expectedQuestionVersion = Number(payload.expectedQuestionVersion);
        if (!Number.isInteger(expectedQuestionVersion) || expectedQuestionVersion < 1
          || expectedQuestionVersion !== Number(currentQuestion.version || 0)
          || expectedQuestionVersion !== Number(item.question.version || 0)) {
          throw new Error("classification_gold_review_question_version_conflict");
        }
        const correctedAnswerKnowledge = normalizeAnswerKnowledge(payload.answerKnowledge, currentQuestion);
        if (!(correctedAnswerKnowledge.textbookEvidence || []).length) {
          throw new Error("classification_gold_review_business_evidence_required");
        }
        const requestedAssignment = payload.knowledgeAssignment && typeof payload.knowledgeAssignment === "object"
          ? payload.knowledgeAssignment
          : {};
        const primaryNodeId = String(requestedAssignment.primaryNodeId || "").trim();
        const primaryNodeRole = normalizedPrimaryNodeRole(
          requestedAssignment.primaryNodeRole || requestedAssignment.coreKnowledgeRole
            || correctedAnswerKnowledge.coreKnowledgeRole,
        );
        const requiredNodeIds = [...new Set([
          ...(primaryNodeRole === "core" ? [primaryNodeId] : []),
          ...(Array.isArray(requestedAssignment.requiredNodeIds) ? requestedAssignment.requiredNodeIds : []),
        ].map((nodeId) => String(nodeId || "").trim()).filter(Boolean))];
        if (!primaryNodeId || !requiredNodeIds.length) {
          throw new Error("classification_gold_review_knowledge_assignment_invalid");
        }
        const goldCoreNodeId = String(correctedAnswerKnowledge.coreKnowledge?.id || "").trim();
        const goldCoreKnowledgeRole = normalizedPrimaryNodeRole(correctedAnswerKnowledge.coreKnowledgeRole);
        const goldRequiredNodeIds = [...new Set((correctedAnswerKnowledge.requiredKnowledge || [])
          .map((node) => String(node?.id || "").trim()).filter(Boolean))];
        if (goldCoreNodeId !== primaryNodeId || goldCoreKnowledgeRole !== primaryNodeRole
          || goldRequiredNodeIds.length !== requiredNodeIds.length
          || goldRequiredNodeIds.some((nodeId) => !requiredNodeIds.includes(nodeId))) {
          throw new Error("classification_gold_review_knowledge_mismatch");
        }
        const structure = knowledgeStructureStore.get(currentQuestion.bookId);
        const knowledgeNodeMap = new Map((structure?.nodes || []).map((node) => [node.id, node]));
        const formalFingerprint = (structure?.fingerprints || [])
          .find((entry) => entry.questionId === questionId) || null;
        if (!structure || !(structure.fingerprints || []).some((fingerprint) => fingerprint.questionId === questionId)
          || knowledgeNodeMap.get(primaryNodeId)?.kind !== "knowledge"
          || requiredNodeIds.some((nodeId) => knowledgeNodeMap.get(nodeId)?.kind !== "knowledge")) {
          throw new Error("classification_gold_review_knowledge_assignment_invalid");
        }
        if (primaryNodeRole === "scope_anchor"
          && !knowledgeScopeAnchorMatchesRequired(knowledgeNodeMap, primaryNodeId, requiredNodeIds)) {
          throw new Error("classification_gold_review_scope_anchor_invalid");
        }
        const primaryNode = knowledgeNodeMap.get(primaryNodeId);
        const answerSource = correctedAnswerKnowledge.answerSource || currentQuestion.answerSource;
        if (!new Set(["pdf_answer", "team_verified", "ai_supplement", "community_consensus"]).has(answerSource)) {
          throw new Error("classification_gold_review_business_answer_source_invalid");
        }
        const answerVariantKey = answerSource === "ai_supplement" ? "ai"
          : (answerSource === "community_consensus" ? "community" : "official");
        const correctedQuestionPayload = {
          correctAnswer: correctedAnswerKnowledge.correctAnswer,
          referenceAnswer: correctedAnswerKnowledge.referenceAnswer,
          scoringPoints: correctedAnswerKnowledge.scoringPoints,
          answerSource,
          answerReviewStatus: "verified",
          answerVerified: true,
          answerVariants: {
            ...(currentQuestion.answerVariants || {}),
            [answerVariantKey]: correctedAnswerKnowledge.referenceAnswer,
          },
          primaryKnowledgePoint: primaryNode.displayTitle || primaryNode.title,
          knowledgePoints: requiredNodeIds.map((nodeId) => {
            const node = knowledgeNodeMap.get(nodeId);
            return node.displayTitle || node.title;
          }),
          subKnowledgePoints: requiredNodeIds.filter((nodeId) => nodeId !== primaryNodeId).map((nodeId) => {
            const node = knowledgeNodeMap.get(nodeId);
            return node.displayTitle || node.title;
          }),
          changeNote: `盲测金标审核修正：${note}`,
        };
        const assignmentPayload = {
          questionId,
          primaryNodeId,
          primaryNodeRole,
          requiredNodeIds,
          focus: requestedAssignment.focus,
          evidenceChunkIds: requestedAssignment.evidenceChunkIds,
          source: "gold_review_business_correction",
        };
        const rollbackStores = [
          ["questions", questionStore],
          ["knowledgeStructures", knowledgeStructureStore],
          ["questionFamilies", questionFamilyStore],
          ["goldReviews", classificationGoldReviewStore],
          ["operations", operationLogStore],
        ];
        const beforeState = Object.fromEntries(rollbackStores.map(([name, store]) => {
          if (typeof store.exportState !== "function" || typeof store.replaceState !== "function") {
            throw new Error(`classification_gold_review_business_store_incompatible:${name}`);
          }
          return [name, store.exportState()];
        }));
        let correctedQuestion;
        let assigned;
        let affectedFamilyIds = [];
        let reviewed;
        try {
          correctedQuestion = questionStore.update(questionId, correctedQuestionPayload, currentAdminDisplayName() || "超级管理员");
          const synchronizedAnswerKnowledge = normalizeAnswerKnowledge({
            ...correctedAnswerKnowledge,
            correctAnswer: correctedQuestion.correctAnswer,
            referenceAnswer: correctedQuestion.referenceAnswer,
            answerSource: correctedQuestion.answerSource,
            answerReviewStatus: correctedQuestion.answerReviewStatus,
            scoringPoints: correctedQuestion.scoringPoints,
          }, correctedQuestion);
          assigned = knowledgeStructureStore.assignQuestions(currentQuestion.bookId, [{
            ...assignmentPayload,
            questionVersion: correctedQuestion.version,
          }]);
          affectedFamilyIds = typeof questionFamilyStore.markPendingForQuestions === "function"
            ? questionFamilyStore.markPendingForQuestions(
              [questionId],
              "gold_review_business_content_updated",
              currentAdminDisplayName() || "超级管理员",
            ).affectedFamilyIds
            : [];
          reviewed = classificationGoldReviewStore.reviewBusinessContent(batchId, questionId, {
            expectedRevision: payload.expectedRevision,
            result: "corrected",
            note,
            question: correctedQuestion,
            answerKnowledge: synchronizedAnswerKnowledge,
            selectedEvidenceChunkIds: payload.selectedEvidenceChunkIds
              || payload.humanSelectedEvidenceChunkIds
              || payload.humanEvidenceSelection?.chunkIds,
            answerKnowledgeProvenance: {
              ...(payload.answerKnowledgeProvenance && typeof payload.answerKnowledgeProvenance === "object"
                ? payload.answerKnowledgeProvenance
                : {}),
              source: "formal_question_business_correction",
              questionVersion: correctedQuestion.version,
              knowledgeAssignment: assignmentPayload,
              // 留痕主题范围锚点与问题知识范围：审核界面据此显示"选项知识是否纳入范围"。
              // 这两个字段来自当前正式指纹（本对话框不改它们，改锚点在题目编辑页）。
              fingerprint: {
                primaryNodeId,
                primaryNodeRole,
                requiredNodeIds,
                knowledgeThemeRangeAnchorNodeId: String(formalFingerprint?.knowledgeThemeRangeAnchorNodeId
                  || formalFingerprint?.themeRangeAnchorNodeId
                  || formalFingerprint?.scopeAnchorNodeId || ""),
                problemKnowledgeRangeNodeIds: [...new Set([
                  ...(Array.isArray(formalFingerprint?.problemKnowledgeRangeNodeIds)
                    ? formalFingerprint.problemKnowledgeRangeNodeIds : []),
                  ...requiredNodeIds,
                ].map(String).filter(Boolean))],
              },
              ...(String(payload.reviewEvidenceNote || "").trim()
                ? { reviewEvidenceNote: String(payload.reviewEvidenceNote).trim().slice(0, 4000) }
                : {}),
            },
            reviewer: currentAdminDisplayName() || "超级管理员",
          });
          logOperation({
            action: "knowledge_classification.gold_review_business_content",
            category: "question",
            targetType: "classification_gold_review_item",
            targetId: `${batchId}:${questionId}`,
            summary: `修正正式题目至 v${correctedQuestion.version} 并同步盲测金标：${questionId}`,
            metadata: {
              batchId,
              questionId,
              previousQuestionVersion: expectedQuestionVersion,
              questionVersion: correctedQuestion.version,
              itemRevision: reviewed.item.revision,
              primaryNodeId,
              requiredNodeIds,
              affectedFamilyIds,
              familyReviewReset: true,
              blindReplayStarted: false,
            },
          });
        } catch (error) {
          try {
            [...rollbackStores].reverse().forEach(([name, store]) => store.replaceState(beforeState[name]));
          } catch (rollbackError) {
            rollbackError.statusCode = 503;
            rollbackError.details = { originalError: error.message, recoveryError: rollbackError.message };
            throw rollbackError;
          }
          throw error;
        }
        const knowledgeAssignment = assigned.assignments.find((assignment) => assignment.questionId === questionId);
        sendJson(response, 200, {
          success: true,
          ...reviewed,
          item: classificationGoldDecorateItem(reviewed.item),
          question: correctedQuestion,
          knowledgeAssignment,
          affectedFamilyIds,
          blindReplayStarted: false,
        });
      } catch (error) {
        const status = error.statusCode || (error.message === "question_not_found" ? 404 : classificationGoldReviewErrorStatus(error));
        sendJson(response, status, {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldContentReviewMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/items\/([^/]+)\/content$/);
    if (request.method === "PUT" && classificationGoldContentReviewMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldContentReviewMatch[1]);
        const questionId = decodeURIComponent(classificationGoldContentReviewMatch[2]);
        const payload = await readJsonBody(request, 1024 * 1024);
        const result = payload.result === "confirmed_current" ? "confirmed" : payload.result;
        const batch = classificationGoldReviewStore.get(batchId);
        if (!batch) throw new Error("classification_gold_review_batch_not_found");
        const item = batch.items.find((entry) => entry.questionId === questionId);
        if (!item) throw new Error("classification_gold_review_item_not_found");
        classificationGoldFormalBaseline(item);
        const reviewed = classificationGoldReviewStore.reviewContent(batchId, questionId, {
          ...payload,
          result,
          reviewer: currentAdminDisplayName() || "超级管理员",
        });
        logOperation({
          action: "knowledge_classification.gold_review_content",
          category: "question",
          targetType: "classification_gold_review_item",
          targetId: `${batchId}:${questionId}`,
          summary: `审核盲测金标的答案、证据与知识：${questionId}`,
          metadata: {
            batchId,
            questionId,
            result,
            itemRevision: reviewed.item.revision,
            knowledgeDigest: reviewed.item.knowledgeDigest,
            familyReviewReset: true,
          },
        });
        sendJson(response, 200, {
          success: true,
          ...reviewed,
          item: classificationGoldDecorateItem(reviewed.item),
        });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), { success: false, error: error.message });
      }
      return;
    }

    const classificationGoldFamilyReviewMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/items\/([^/]+)\/family$/);
    if (request.method === "PUT" && classificationGoldFamilyReviewMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldFamilyReviewMatch[1]);
        const questionId = decodeURIComponent(classificationGoldFamilyReviewMatch[2]);
        const payload = await readJsonBody(request, 1024 * 1024);
        const result = payload.result === "confirmed_current" ? "confirmed" : payload.result;
        const batch = classificationGoldReviewStore.get(batchId);
        if (!batch) throw new Error("classification_gold_review_batch_not_found");
        const item = batch.items.find((entry) => entry.questionId === questionId);
        if (!item) throw new Error("classification_gold_review_item_not_found");
        classificationGoldFormalBaseline(item);
        const requestedFamilyGold = classificationGoldFamilyPayloadWithFinalReplayMode(payload, item, {
          requireCurrentFamilyKnowledgeProtocol: Boolean(batch.source?.parentSnapshotId),
        });
        const submittedFamily = batch.source?.parentSnapshotId
          ? classificationGoldFamilyGoldWithFormalFacts(item, requestedFamilyGold, { phase: "submission" })
          : { familyGold: requestedFamilyGold, provenance: null };
        const semanticValidation = batch.source?.parentSnapshotId
          ? classificationGoldValidateSubmittedFamily(batch, item, submittedFamily.familyGold, result)
          : null;
        const reviewed = classificationGoldReviewStore.reviewFamily(batchId, questionId, {
          ...payload,
          familyGold: submittedFamily.familyGold,
          finalReplayMode: submittedFamily.familyGold.replayMode,
          ...(submittedFamily.provenance ? {
            familyGoldProvenance: {
              source: "formal_family_review_snapshot",
              contentSha256: submittedFamily.provenance.contentSha256,
              capturedAt: submittedFamily.provenance.capturedAt,
              membershipRevisions: submittedFamily.provenance.membershipRevisions,
              formalBusinessDataMutated: false,
            },
          } : {}),
          result,
          reviewer: currentAdminDisplayName() || "超级管理员",
        });
        logOperation({
          action: "knowledge_classification.gold_review_family",
          category: "question",
          targetType: "classification_gold_review_item",
          targetId: `${batchId}:${questionId}`,
          summary: `审核盲测金标的题族裁决：${questionId}`,
          metadata: {
            batchId,
            questionId,
            result,
            familyDecision: reviewed.item.familyGold.decision,
            primaryFamilyId: reviewed.item.familyGold.primaryFamilyId,
            relatedFamilyRelations: reviewed.item.familyGold.relatedFamilyRelations,
            semanticWarningCount: semanticValidation?.warningCount || 0,
            itemRevision: reviewed.item.revision,
            basedOnKnowledgeDigest: reviewed.item.familyReview.basedOnKnowledgeDigest,
          },
        });
        sendJson(response, 200, {
          success: true,
          ...reviewed,
          semanticWarnings: semanticValidation?.warnings || [],
          item: classificationGoldDecorateItem(reviewed.item),
        });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldFreezePrepareMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/freeze\/prepare$/);
    if (request.method === "POST" && classificationGoldFreezePrepareMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldFreezePrepareMatch[1]);
        const existing = classificationGoldReviewStore.get(batchId);
        if (!existing) throw new Error("classification_gold_review_batch_not_found");
        existing.items.forEach((item) => {
          classificationGoldFormalBaseline(item);
          if (existing.source?.parentSnapshotId) {
            classificationGoldFamilyGoldWithFormalFacts(item, item.familyGold, { phase: "freeze" });
          }
        });
        const prepared = classificationGoldReviewStore.prepareFreeze(batchId, { reviewer: currentAdminDisplayName() || "超级管理员" });
        logOperation({
          action: "knowledge_classification.gold_review_freeze_prepare",
          category: "question",
          targetType: "classification_gold_snapshot_preparation",
          targetId: prepared.preparation.snapshotId,
          summary: `预生成盲测金标快照并等待人工确认：${existing.title} ${existing.version}`,
          metadata: {
            batchId,
            batchRevision: prepared.preparation.batchRevision,
            snapshotId: prepared.preparation.snapshotId,
            version: prepared.preparation.version,
            fileSha256: prepared.preparation.fileSha256,
            contentSha256: prepared.preparation.contentSha256,
            byteLength: prepared.preparation.byteLength,
            summary: prepared.preparation.summary,
            snapshotWritten: false,
            blindReplayStarted: false,
          },
        });
        sendJson(response, 200, { success: true, ...prepared, snapshotWritten: false, blindReplayStarted: false });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldFreezeCommitMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/freeze\/commit$/);
    if (request.method === "POST" && classificationGoldFreezeCommitMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldFreezeCommitMatch[1]);
        const payload = await readJsonBody(request, 64 * 1024);
        const existing = classificationGoldReviewStore.get(batchId);
        if (!existing) throw new Error("classification_gold_review_batch_not_found");
        existing.items.forEach((item) => {
          classificationGoldFormalBaseline(item);
          if (existing.source?.parentSnapshotId) {
            classificationGoldFamilyGoldWithFormalFacts(item, item.familyGold, { phase: "freeze" });
          }
        });
        const frozen = classificationGoldReviewStore.commitFreeze(batchId, {
          token: payload.token,
          reviewer: currentAdminDisplayName() || "超级管理员",
        });
        logOperation({
          action: "knowledge_classification.gold_review_freeze",
          category: "question",
          targetType: "classification_gold_snapshot",
          targetId: frozen.snapshot.snapshotId,
          summary: `冻结盲测金标集：${frozen.batch.title} ${frozen.batch.version}`,
          metadata: {
            batchId,
            snapshotId: frozen.snapshot.snapshotId,
            version: frozen.snapshot.version,
            fileSha256: frozen.snapshot.fileSha256,
            contentSha256: frozen.snapshot.contentSha256,
            summary: frozen.snapshot.summary,
            preparedBytesCommittedUnchanged: true,
            blindReplayStarted: false,
          },
        });
        sendJson(response, 200, { success: true, ...frozen, snapshotWritten: true, blindReplayStarted: false });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const classificationGoldFreezeMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/gold-review\/sets\/([^/]+)\/freeze$/);
    if (request.method === "POST" && classificationGoldFreezeMatch) {
      try {
        const batchId = decodeURIComponent(classificationGoldFreezeMatch[1]);
        const existing = classificationGoldReviewStore.get(batchId);
        if (!existing) throw new Error("classification_gold_review_batch_not_found");
        existing.items.forEach((item) => classificationGoldFormalBaseline(item));
        const frozen = classificationGoldReviewStore.freeze(batchId, { reviewer: currentAdminDisplayName() || "超级管理员" });
        if (existing.status !== "frozen") {
          logOperation({
            action: "knowledge_classification.gold_review_freeze",
            category: "question",
            targetType: "classification_gold_snapshot",
            targetId: frozen.snapshot.snapshotId,
            summary: `冻结盲测金标集：${frozen.batch.title} ${frozen.batch.version}`,
            metadata: {
              batchId,
              snapshotId: frozen.snapshot.snapshotId,
              version: frozen.snapshot.version,
              fileSha256: frozen.snapshot.fileSha256,
              contentSha256: frozen.snapshot.contentSha256,
              summary: frozen.snapshot.summary,
              blindReplayStarted: false,
            },
          });
        }
        sendJson(response, 200, { success: true, ...frozen, blindReplayStarted: false });
      } catch (error) {
        sendJson(response, classificationGoldReviewErrorStatus(error), { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/knowledge-classification/results") {
      const bookId = url.searchParams.get("bookId") || "modern-chinese-7-1";
      const query = String(url.searchParams.get("query") || "").trim().toLocaleLowerCase("zh-CN");
      const status = url.searchParams.get("status") || "all";
      const risk = url.searchParams.get("risk") || "all";
      const issue = url.searchParams.get("issue") || "all";
      const includeHistory = url.searchParams.get("includeHistory") === "true";
      const pageSize = Math.min(100, Math.max(20, Number(url.searchParams.get("pageSize")) || 50));
      const allResults = knowledgeClassificationStore.results({ bookId, limit: 1000 });
      const questionMap = new Map(questionStore.getMany(allResults.map((result) => result.questionId)).filter(Boolean).map((question) => [question.id, question]));
      const structure = knowledgeStructureStore.get(bookId);
      const nodeMap = new Map((structure?.nodes || []).map((node) => [node.id, node]));
      const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: true });
      const chunkMap = new Map((knowledge.chunks || []).map((chunk) => [chunk.id, chunk]));
      const experienceState = knowledgeClassificationExperienceStore.exportState();
      const experienceRuleMap = new Map(experienceState.rules.map((rule) => [rule.id, rule]));
      const experienceCaseMap = new Map(experienceState.cases.map((item) => [item.id, item]));
      const experienceMessageCounts = experienceState.messages.reduce((counts, message) => {
        counts.set(message.resultId, (counts.get(message.resultId) || 0) + 1);
        return counts;
      }, new Map());
      const allBookFamilies = questionFamilyStore.list({ bookId, status: "all" }).families;
      const familyMap = new Map(allBookFamilies.map((family) => [family.id, family]));
      const currentMembershipMap = questionFamilyStore.memberships([...questionMap.keys()], { bookId, status: "all" });
      const latestReviewableByQuestion = new Map();
      const latestRecordByQuestion = new Map();
      allResults.forEach((result) => {
        if (!latestRecordByQuestion.has(result.questionId)) latestRecordByQuestion.set(result.questionId, result);
        if (result.status !== "pending_review" || !result.agent2Verification || latestReviewableByQuestion.has(result.questionId)) return;
        latestReviewableByQuestion.set(result.questionId, result);
      });
      const decorated = allResults.map((result) => {
        const baseQuestion = questionMap.get(result.questionId) || null;
        const currentFamilyMemberships = currentMembershipMap[result.questionId] || [];
        const question = baseQuestion ? { ...baseQuestion, familyMemberships: currentFamilyMemberships } : null;
        const answerConflict = knowledgeClassificationAnswerConflict(question);
        const resultRisk = knowledgeClassificationRisk(result, question);
        const resultIssue = knowledgeClassificationIssue(result, question);
        const verification = result.agent2Verification ? (() => {
          const requiredNodeSet = new Set(result.agent2Verification.requiredNodeIds || []);
          const currentFamilyIds = currentFamilyMemberships.map((membership) => membership.familyId);
          const relatedAssessmentMap = new Map((result.agent2Verification.relatedFamilyAssessments || [])
            .map((assessment) => [assessment.familyId, assessment]));
          const orderedFamilyIds = [...new Set([
            result.agent2Verification.primaryFamilyId,
            ...(result.agent2Verification.relatedFamilyIds || []),
            ...(result.agent2Verification.matchedFamilyIds || []),
            ...(result.agent2Verification.duplicateFamilyIds || []),
            ...currentFamilyIds,
            ...allBookFamilies.filter((family) => family.status !== "rejected"
              && (requiredNodeSet.has(family.knowledgeNodeId)
                || (family.requiredKnowledgeNodeIds || []).some((nodeId) => requiredNodeSet.has(nodeId))))
              .map((family) => family.id),
          ].filter(Boolean))].slice(0, 30);
          const candidateFamilies = orderedFamilyIds.map((familyId) => familyMap.get(familyId)).filter(Boolean).map((family) => {
            const membership = currentFamilyMemberships.find((item) => item.familyId === family.id);
            return {
              id: family.id,
              name: family.name,
              status: family.status,
              knowledgeNodeId: family.knowledgeNodeId,
              knowledgePath: family.knowledgePath,
              requiredKnowledgeNodeIds: family.requiredKnowledgeNodeIds,
              focusKey: family.focusKey,
              memberCount: family.members.length,
              isCurrent: Boolean(membership),
              isCurrentPrimary: membership?.isPrimary === true,
              relatedFamilyAssessment: relatedAssessmentMap.get(family.id) || null,
              suggestedRole: family.id === result.agent2Verification.primaryFamilyId ? "primary"
                : ((result.agent2Verification.relatedFamilyIds || []).includes(family.id) ? "related"
                  : ((result.agent2Verification.duplicateFamilyIds || []).includes(family.id) ? "duplicate"
                    : ((result.agent2Verification.matchedFamilyIds || []).includes(family.id) ? "matched" : "candidate"))),
            };
          });
          return {
            ...result.agent2Verification,
            primaryNode: nodeMap.get(result.agent2Verification.primaryNodeId) || null,
            requiredNodes: (result.agent2Verification.requiredNodeIds || []).map((id) => nodeMap.get(id)).filter(Boolean),
            evidence: compactClassificationEvidence((result.agent2Verification.evidenceChunkIds || []).map((id) => chunkMap.get(id)).filter(Boolean), 1600),
            candidateFamilies,
            primaryFamily: familyMap.get(result.agent2Verification.primaryFamilyId) || null,
            relatedFamilies: (result.agent2Verification.relatedFamilyIds || []).map((id) => familyMap.get(id)).filter(Boolean),
          };
        })() : null;
        const terminalNodeIds = result.agent1Trajectories?.flatMap((trajectory) => trajectory.terminalNodeIds || []) || [];
        const agreement = Boolean(verification?.primaryNodeId && terminalNodeIds.includes(verification.primaryNodeId));
        const disagreements = [
          result.agent1Trajectories?.some((trajectory) => trajectory.stopReason === "previous_level_wrong") && "Agent 2 判断上一层路径可能选错",
          verification && ["move_parent", "move_sibling"].includes(verification.decision) && "Agent 3 根据教材正文调整了 Agent 2 的候选节点",
          verification?.decision === "cross_knowledge" && "Agent 3 判断作答需要跨知识点",
          answerConflict && `${answerConflict.authority === "verified_official" ? "题库结构化答案" : "当前结构化答案"} ${answerConflict.structuredAnswer.join("、")} 与${answerConflict.authority === "verified_official" ? "已核验答案" : "参考解析答案"} ${answerConflict.referenceAnswer.join("、")} 不一致`,
          ...(verification?.riskHints || []).map((hint) => hint.message).filter(Boolean),
          ...(verification?.relatedFamilyAssessments || []).filter((assessment) => assessment.accepted !== true)
            .map((assessment) => {
              const familyName = familyMap.get(assessment.familyId)?.name || assessment.familyId;
              return `“${familyName}”未进入关联题族：${assessment.deletionTest || assessment.reason || "未提供通过删除检验的依据"}`;
            }),
          verification?.uncertainty,
        ].filter(Boolean);
        const usedRuleIds = [...new Set([...(result.agent1RuleIds || []), ...(result.agent2RuleIds || [])])];
        const usedCaseIds = [...new Set([...(result.agent1CaseIds || []), ...(result.agent2CaseIds || [])])];
        const latestResult = latestReviewableByQuestion.get(result.questionId);
        const latestRecord = latestRecordByQuestion.get(result.questionId);
        return {
          ...result,
          risk: resultRisk,
          issue: resultIssue,
          question,
          answerConflict,
          agreement,
          disagreements,
          hasNewerResult: Boolean(latestResult && latestResult.id !== result.id),
          latestResultId: latestResult && latestResult.id !== result.id ? latestResult.id : "",
          isHistoricalRecord: Boolean(latestRecord && latestRecord.id !== result.id),
          latestRecordId: latestRecord && latestRecord.id !== result.id ? latestRecord.id : "",
          suggestedKnowledgePath: verification?.primaryNode?.path || "",
          agent2Verification: verification,
          agent3Verification: verification,
          agent3: verification,
          experience: {
            agent1RuleIds: result.agent1RuleIds || [],
            agent1CaseIds: result.agent1CaseIds || [],
            agent2RuleIds: result.agent2RuleIds || [],
            agent2CaseIds: result.agent2CaseIds || [],
            rules: usedRuleIds.map((id) => experienceRuleMap.get(id)).filter(Boolean),
            cases: usedCaseIds.map((id) => experienceCaseMap.get(id)).filter(Boolean),
            messageCount: experienceMessageCounts.get(result.id) || 0,
          },
          agent1Trajectories: (result.agent1Trajectories || []).map((trajectory) => ({
            ...trajectory,
            terminalNodes: (trajectory.terminalNodeIds || []).map((id) => nodeMap.get(id)).filter(Boolean),
            steps: (trajectory.steps || []).map((step) => ({
              ...step,
              parentNode: nodeMap.get(step.parentNodeId) || null,
              candidates: (step.candidateNodeIds || []).map((id) => nodeMap.get(id)).filter(Boolean),
              selectedNodes: (step.selectedNodeIds || []).map((id) => nodeMap.get(id)).filter(Boolean),
            })),
          })),
          agent1: { features: result.agent1Features },
          agent2: { trace: (result.agent1Trajectories || []).flatMap((trajectory) => trajectory.steps || []) },
        };
      });
      const visibleRecords = includeHistory ? decorated : decorated.filter((result) => !result.isHistoricalRecord);
      const filtered = visibleRecords.filter((result) => {
        if (status !== "all" && (status === "running"
          ? !["queued", "processing"].includes(result.status)
          : result.status !== status && result.reviewStatus !== status)) return false;
        if (risk !== "all" && result.risk !== risk) return false;
        if (issue !== "all" && result.issue !== issue) return false;
        if (query && ![result.questionId, result.question?.stem, result.question?.chapter, result.agent2Verification?.focusLabel]
          .filter(Boolean).join(" ").toLocaleLowerCase("zh-CN").includes(query)) return false;
        return true;
      });
      const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.min(pageCount, Math.max(1, Number(url.searchParams.get("page")) || 1));
      const summary = {
        total: visibleRecords.length,
        history: decorated.filter((result) => result.isHistoricalRecord).length,
        agent1: visibleRecords.filter((result) => ["queued", "processing"].includes(result.status) || result.agent1Status === "running").length,
        agent2: visibleRecords.filter((result) => result.agent2Status === "running").length,
        pending: visibleRecords.filter((result) => result.status === "pending_review").length,
        applied: visibleRecords.filter((result) => result.reviewStatus === "applied").length,
        rejected: visibleRecords.filter((result) => result.reviewStatus === "rejected").length,
        highRisk: visibleRecords.filter((result) => result.risk === "high").length,
      };
      sendJson(response, 200, {
        success: true,
        summary,
        total: filtered.length,
        page,
        pageSize,
        pageCount,
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        jobs: knowledgeClassificationStore.jobs({ bookId, limit: 10 }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/knowledge-classification/rules") {
      const bookId = url.searchParams.get("bookId") || "all";
      const status = url.searchParams.get("status") || "all";
      const query = url.searchParams.get("query") || "";
      sendJson(response, 200, {
        success: true,
        summary: knowledgeClassificationExperienceStore.summary({ bookId }),
        items: knowledgeClassificationExperienceStore.rules({ bookId, status, query, limit: 1000 }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/knowledge-classification/cases") {
      const bookId = url.searchParams.get("bookId") || "all";
      sendJson(response, 200, {
        success: true,
        items: knowledgeClassificationExperienceStore.cases({ bookId, status: url.searchParams.get("status") || "confirmed", limit: 500 }),
      });
      return;
    }

    const knowledgeClassificationRuleMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/rules\/([^/]+)$/);
    if (request.method === "DELETE" && knowledgeClassificationRuleMatch) {
      try {
        const ruleId = decodeURIComponent(knowledgeClassificationRuleMatch[1]);
        const payload = await readJsonBody(request, 64 * 1024).catch(() => ({}));
        const deletionReason = String(payload.reason || "管理员二次确认删除").trim().slice(0, 300);
        const rule = knowledgeClassificationExperienceStore.deleteRule(ruleId);
        logOperation({
          action: "knowledge_classification.rule_delete",
          category: "question",
          targetType: "knowledge_classification_rule",
          targetId: rule.id,
          summary: `删除教研规则：${rule.title}`,
          metadata: {
            bookId: rule.bookId,
            status: rule.status,
            version: rule.version,
            sourceResultId: rule.sourceResultId,
            deletionReason,
            deletedRule: {
              title: rule.title,
              statement: rule.statement,
              scopeNodeIds: (rule.scopeNodeIds || []).join(","),
              scopePath: rule.scopePath,
              questionTypes: (rule.questionTypes || []).join(","),
              triggerTerms: (rule.triggerTerms || []).join(","),
              positiveExamples: (rule.positiveExamples || []).join(","),
              negativeExamples: (rule.negativeExamples || []).join(","),
              priority: rule.priority,
              sourceQuestionId: rule.sourceQuestionId,
              sourceFeedbackIds: (rule.sourceFeedbackIds || []).join(","),
              createdAt: rule.createdAt,
              updatedAt: rule.updatedAt,
            },
          },
        });
        sendJson(response, 200, { success: true, rule });
      } catch (error) {
        sendJson(response, error.message === "knowledge_classification_rule_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }
    if (request.method === "PATCH" && knowledgeClassificationRuleMatch) {
      try {
        const ruleId = decodeURIComponent(knowledgeClassificationRuleMatch[1]);
        const current = knowledgeClassificationExperienceStore.getRule(ruleId);
        if (!current) throw new Error("knowledge_classification_rule_not_found");
        const payload = await readJsonBody(request, 512 * 1024);
        const scopeNodeIds = payload.scopeNodeIds === undefined ? current.scopeNodeIds : payload.scopeNodeIds;
        const triggerTerms = payload.triggerTerms === undefined ? current.triggerTerms : payload.triggerTerms;
        if (payload.status === "active" && !(Array.isArray(scopeNodeIds) && scopeNodeIds.length)
          && !(Array.isArray(triggerTerms) && triggerTerms.length)) {
          throw new Error("knowledge_classification_rule_scope_required");
        }
        if (Array.isArray(scopeNodeIds) && scopeNodeIds.length) {
          const structure = knowledgeStructureStore.get(current.bookId);
          const nodeIds = new Set((structure?.nodes || []).map((node) => node.id));
          if (scopeNodeIds.some((id) => !nodeIds.has(String(id)))) throw new Error("knowledge_classification_rule_scope_invalid");
        }
        const rule = knowledgeClassificationExperienceStore.updateRule(ruleId, payload, currentAdminDisplayName() || "超级管理员");
        logOperation({
          action: `knowledge_classification.rule_${rule.status}`,
          category: "question",
          targetType: "knowledge_classification_rule",
          targetId: rule.id,
          summary: `${rule.status === "active" ? "批准" : (rule.status === "inactive" ? "停用" : "更新")}教研规则：${rule.title}`,
          metadata: { bookId: rule.bookId, version: rule.version, sourceResultId: rule.sourceResultId },
        });
        sendJson(response, 200, { success: true, rule });
      } catch (error) {
        sendJson(response, error.message === "knowledge_classification_rule_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    const knowledgeClassificationExperienceMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/results\/([^/]+)\/experience$/);
    if (request.method === "GET" && knowledgeClassificationExperienceMatch) {
      const resultId = decodeURIComponent(knowledgeClassificationExperienceMatch[1]);
      const result = knowledgeClassificationStore.getResult(resultId);
      if (!result) {
        sendJson(response, 404, { success: false, error: "knowledge_classification_result_not_found" });
        return;
      }
      const messages = knowledgeClassificationExperienceStore.messages({ resultId, limit: 300 });
      const ruleIds = [...new Set([
        ...(result.agent1RuleIds || []),
        ...(result.agent2RuleIds || []),
        ...messages.map((message) => message.ruleDraftId),
      ].filter(Boolean))];
      const caseIds = [...new Set([...(result.agent1CaseIds || []), ...(result.agent2CaseIds || [])])];
      const reviewEvents = knowledgeClassificationExperienceStore.reviewEvents({ resultId, limit: 300 });
      const dossierSuggestionIds = new Set(reviewEvents.map((item) => item.promotedDossierSuggestionId).filter(Boolean));
      sendJson(response, 200, {
        success: true,
        messages,
        reviewEvents,
        dossierSuggestions: knowledgeClassificationExperienceStore.dossierSuggestions({ bookId: result.bookId, status: "all", limit: 300 })
          .filter((item) => dossierSuggestionIds.has(item.id)),
        rules: knowledgeClassificationExperienceStore.getRules(ruleIds),
        cases: knowledgeClassificationExperienceStore.cases({ questionId: result.questionId, status: "all", limit: 20 })
          .concat(knowledgeClassificationExperienceStore.exportState().cases.filter((item) => caseIds.includes(item.id)))
          .filter((item, index, items) => items.findIndex((entry) => entry.id === item.id) === index),
      });
      return;
    }

    const knowledgeClassificationFeedbackMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/results\/([^/]+)\/feedback$/);
    if (request.method === "POST" && knowledgeClassificationFeedbackMatch) {
      try {
        const resultId = decodeURIComponent(knowledgeClassificationFeedbackMatch[1]);
        const result = knowledgeClassificationStore.getResult(resultId);
        if (!result) throw new Error("knowledge_classification_result_not_found");
        const payload = await readJsonBody(request, 64 * 1024);
        const saved = await saveClassificationFeedback(result, payload);
        logOperation({
          action: "knowledge_classification.feedback",
          category: "question",
          targetType: "knowledge_classification_result",
          targetId: result.id,
          summary: `向 Agent ${String(saved.reviewerMessage.agent || "agent2").slice(-1)} 提交教研反馈`,
          metadata: { bookId: result.bookId, questionId: result.questionId, ruleDraftId: saved.rule?.id || "" },
        });
        sendJson(response, 200, { success: true, ...saved });
      } catch (error) {
        const status = error.message === "knowledge_classification_result_not_found" ? 404 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/knowledge-classification/jobs") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const config = aiConfigStore.load();
        if (!configuredScene(config, "knowledge_feature_extraction", "knowledge_hierarchy_navigation")) throw new Error("knowledge_feature_extraction_route_unavailable");
        if (!configuredScene(config, "knowledge_hierarchy_navigation")) throw new Error("knowledge_hierarchy_navigation_route_unavailable");
        if (!configuredScene(config, "knowledge_batch_verification")) throw new Error("knowledge_batch_verification_route_unavailable");
        const structure = knowledgeStructureStore.get(bookId);
        if (!structure) throw new Error("knowledge_structure_not_found");
        const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: true });
        if (!knowledge.chunks?.length) throw new Error("textbook_knowledge_not_built");
        const requestedIds = new Set((Array.isArray(payload.questionIds) ? payload.questionIds : []).map(String).filter(Boolean));
        const reclassifyConfirmed = payload.reclassifyConfirmed === true;
        const currentFingerprints = new Map((structure.fingerprints || []).map((fingerprint) => [fingerprint.questionId, fingerprint]));
        const activeQuestionIds = new Set(knowledgeClassificationStore.jobs({ bookId, limit: 100 })
          .filter((job) => ["queued", "running"].includes(job.status))
          .flatMap((job) => job.questionIds));
        const limit = Math.min(50, Math.max(1, Number(payload.limit) || 20));
        const questions = questionStore.list({
          library: "official",
          status: "all",
          bookId,
          subjectId: payload.subjectId || "all",
          type: payload.type || "all",
          query: payload.query || "",
        }).questions.filter((question) => (!requestedIds.size || requestedIds.has(question.id))
          && !activeQuestionIds.has(question.id)
          && (reclassifyConfirmed || currentFingerprints.get(question.id)?.status !== "confirmed"))
          .slice(0, limit);
        if (!questions.length) throw new Error("knowledge_classification_questions_required");
        const baseFamilyMembershipRevisions = questionFamilyStore.membershipRevisions(questions.map((question) => question.id));
        const created = knowledgeClassificationStore.createJob({
          bookId,
          questionIds: questions.map((question) => question.id),
          baseQuestionVersions: Object.fromEntries(questions.map((question) => [question.id, Number(question.version) || 1])),
          baseClassificationBaselines: Object.fromEntries(questions.map((question) => [
            question.id,
            knowledgeClassificationQuestionBaseline(currentFingerprints.get(question.id), baseFamilyMembershipRevisions[question.id]),
          ])),
          baseKnowledgeRevision: knowledgeTopologyRevision(structure),
          knowledgeRevisionFormat: "topology-v1",
          baseFamilyRevision: knowledgeFamilyRevision(bookId),
          textbookKnowledgeVersion: Number(knowledge.version || knowledge.updatedAt || 0),
        });
        logOperation({
          action: "knowledge_classification.job_create",
          category: "question",
          targetType: "knowledge_classification_job",
          targetId: created.job.id,
          summary: `创建 ${created.job.total} 道题的四 Agent AI 知识巡检`,
          metadata: { bookId, questionIds: created.job.questionIds, reclassifyConfirmed },
        });
        setImmediate(() => runKnowledgeClassificationJob(created.job.id));
        sendJson(response, 202, { success: true, job: created.job });
      } catch (error) {
        const unavailable = error.message.endsWith("_route_unavailable");
        sendJson(response, unavailable ? 503 : 422, { success: false, error: error.message });
      }
      return;
    }

    const knowledgeClassificationJobMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/jobs\/([^/]+)$/);
    if (request.method === "GET" && knowledgeClassificationJobMatch) {
      const jobId = decodeURIComponent(knowledgeClassificationJobMatch[1]);
      const job = knowledgeClassificationStore.getJob(jobId);
      sendJson(response, job ? 200 : 404, job
        ? { success: true, job, results: knowledgeClassificationStore.results({ jobId, limit: 1000 }) }
        : { success: false, error: "knowledge_classification_job_not_found" });
      return;
    }

    const knowledgeClassificationRejectMatch = url.pathname.match(/^\/api\/admin\/knowledge-classification\/results\/([^/]+)\/reject$/);
    if (request.method === "POST" && knowledgeClassificationRejectMatch) {
      try {
        const questionId = decodeURIComponent(knowledgeClassificationRejectMatch[1]);
        const payload = await readJsonBody(request).catch(() => ({}));
        const result = payload.resultId
          ? knowledgeClassificationStore.getResult(String(payload.resultId))
          : knowledgeClassificationStore.results({ questionId, status: "pending_review", limit: 1 })[0];
        if (!result || result.questionId !== questionId) throw new Error("knowledge_classification_result_not_found");
        const rejected = knowledgeClassificationStore.rejectResult(result.id, currentAdminDisplayName() || "超级管理员", payload.note || "");
        logOperation({ action: "knowledge_classification.reject", category: "question", targetType: "knowledge_classification_result", targetId: result.id, summary: `拒绝 AI 知识巡检建议：${questionId}`, metadata: { jobId: result.jobId, questionId } });
        sendJson(response, 200, { success: true, result: rejected });
      } catch (error) {
        sendJson(response, error.message === "knowledge_classification_result_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/knowledge-classification/apply") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        if (options.persistence) {
          const error = new Error("classification_commit_postgres_transaction_required");
          error.statusCode = 503;
          throw error;
        }
        const schemaVersion = String(payload.schemaVersion || CLASSIFICATION_COMMIT_SCHEMA_VERSION);
        if (schemaVersion !== CLASSIFICATION_COMMIT_SCHEMA_VERSION) {
          const error = new Error("classification_commit_schema_unsupported");
          error.statusCode = 422;
          throw error;
        }
        const commitId = String(payload.commitId || crypto.randomUUID()).trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(commitId)) {
          const error = new Error("classification_commit_id_invalid");
          error.statusCode = 422;
          throw error;
        }
        const resultIds = [...new Set((Array.isArray(payload.resultIds) ? payload.resultIds : []).map(String).filter(Boolean))];
        if (!resultIds.length) throw new Error("knowledge_classification_results_required");
        const commitSelections = (Array.isArray(payload.selections) ? payload.selections : []).map((selection) => ({
          resultId: String(selection?.resultId || ""),
          primaryNodeId: String(selection?.primaryNodeId || ""),
          primaryNodeRole: normalizedPrimaryNodeRole(selection?.primaryNodeRole),
          requiredNodeIds: [...new Set((Array.isArray(selection?.requiredNodeIds) ? selection.requiredNodeIds : []).map(String).filter(Boolean))].sort(),
          ...(Object.prototype.hasOwnProperty.call(selection || {}, "familyMemberships") ? {
            familyMemberships: (Array.isArray(selection.familyMemberships) ? selection.familyMemberships : [])
              .map((membership) => ({
                familyId: String(membership?.familyId || ""),
                isPrimary: membership?.isPrimary === true,
                coverageRole: membership?.isPrimary === true
                  ? "required"
                  : (["required", "reference"].includes(String(membership?.coverageRole || ""))
                    ? String(membership.coverageRole) : ""),
                contributionKnowledgeNodeIds: [...new Set((Array.isArray(membership?.contributionKnowledgeNodeIds)
                  ? membership.contributionKnowledgeNodeIds : []).map(String).filter(Boolean))].sort(),
              }))
              .filter((membership) => membership.familyId)
              .sort((left, right) => left.familyId.localeCompare(right.familyId)),
          } : {}),
          ...(selection?.createCandidateFamily === true ? {
            createCandidateFamily: true,
            candidateFamilyDraft: {
              name: String(selection.candidateFamilyDraft?.name || ""),
              focusKey: String(selection.candidateFamilyDraft?.focusKey || ""),
              coreKnowledgeNodeId: String(selection.candidateFamilyDraft?.coreKnowledgeNodeId || ""),
              requiredKnowledgeNodeIds: [...new Set((Array.isArray(selection.candidateFamilyDraft?.requiredKnowledgeNodeIds)
                ? selection.candidateFamilyDraft.requiredKnowledgeNodeIds : []).map(String).filter(Boolean))].sort(),
              textbookAnchorNodeIds: [...new Set((Array.isArray(selection.candidateFamilyDraft?.textbookAnchorNodeIds)
                ? selection.candidateFamilyDraft.textbookAnchorNodeIds : []).map(String).filter(Boolean))].sort(),
              assessmentAction: String(selection.candidateFamilyDraft?.assessmentAction || ""),
              inclusionBoundary: String(selection.candidateFamilyDraft?.inclusionBoundary || ""),
              exclusionBoundary: String(selection.candidateFamilyDraft?.exclusionBoundary || ""),
              membership: {
                coverageRole: "required",
                contributionKnowledgeNodeIds: [...new Set((Array.isArray(selection.candidateFamilyDraft?.membership?.contributionKnowledgeNodeIds)
                  ? selection.candidateFamilyDraft.membership.contributionKnowledgeNodeIds
                  : (Array.isArray(selection.candidateFamilyDraft?.contributionKnowledgeNodeIds)
                    ? selection.candidateFamilyDraft.contributionKnowledgeNodeIds : [])).map(String).filter(Boolean))].sort(),
              },
              textbookEvidence: {
                chunkIds: [...new Set((Array.isArray(selection.candidateFamilyDraft?.textbookEvidence?.chunkIds)
                  ? selection.candidateFamilyDraft.textbookEvidence.chunkIds : []).map(String).filter(Boolean))].sort(),
                summary: String(selection.candidateFamilyDraft?.textbookEvidence?.summary || ""),
              },
              reason: String(selection.candidateFamilyDraft?.reason || ""),
            },
          } : {}),
          ...(Object.prototype.hasOwnProperty.call(selection || {}, "adjustmentReason")
            ? { adjustmentReason: String(selection.adjustmentReason || "") }
            : {}),
        })).sort((left, right) => left.resultId.localeCompare(right.resultId));
        const commitRequest = {
          schemaVersion,
          resultIds: [...resultIds].sort(),
          selections: commitSelections,
          note: String(payload.note || ""),
          adjustmentReason: String(payload.adjustmentReason || ""),
        };
        const requestHash = classificationCommitRequestHash(commitRequest);
        const commitInspection = classificationCommitCoordinator.inspect(commitId, requestHash);
        if (commitInspection.action === "replay") {
          sendJson(response, 200, commitInspection.commit.response);
          return;
        }
        const results = resultIds.map((id) => knowledgeClassificationStore.getResult(id));
        if (results.some((result) => !result)) throw new Error("knowledge_classification_result_not_found");
        const requestedSelectionMap = new Map((Array.isArray(payload.selections) ? payload.selections : []).map((selection) => [String(selection?.resultId || ""), selection]));
        const bookIds = [...new Set(results.map((result) => result.bookId))];
        if (bookIds.length !== 1) throw new Error("knowledge_classification_book_mismatch");
        const bookId = bookIds[0];
        const applyLockKey = "classification-commit-global";
        if (activeKnowledgeClassificationApplies.has(applyLockKey)) throw new Error("knowledge_classification_apply_locked");
        activeKnowledgeClassificationApplies.add(applyLockKey);
        let commitPrepared = false;
        try {
          const structure = knowledgeStructureStore.get(bookId);
          const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: false });
          const questions = questionStore.getMany(results.map((result) => result.questionId)).filter(Boolean);
          const questionMap = new Map(questions.map((question) => [question.id, question]));
          const currentFamilyMembershipRevisions = questionFamilyStore.membershipRevisions(results.map((result) => result.questionId));
          const latestReviewableByQuestion = new Map();
          knowledgeClassificationStore.results({ bookId, limit: 1000 }).forEach((candidate) => {
            if (candidate.status !== "pending_review" || !candidate.agent2Verification || latestReviewableByQuestion.has(candidate.questionId)) return;
            latestReviewableByQuestion.set(candidate.questionId, candidate);
          });
          const staleResults = results.map((result) => {
            const latest = latestReviewableByQuestion.get(result.questionId);
            const reasons = knowledgeClassificationStaleReasons(result, {
              question: questionMap.get(result.questionId),
              structure,
              knowledge,
              latestResult: latest,
              familyMembershipRevision: currentFamilyMembershipRevisions[result.questionId],
            });
            return { result, reasons, latestResultId: latest && latest.id !== result.id ? latest.id : "" };
          }).filter((item) => item.reasons.length);
          if (staleResults.length) {
            staleResults.forEach(({ result, reasons }) => {
              if (result.status === "pending_review" && reasons.some((reason) => reason !== "result_already_reviewed")) {
                knowledgeClassificationStore.updateResult(result.id, { status: "stale", error: "knowledge_classification_result_stale" });
              }
            });
            const error = new Error("knowledge_classification_result_stale");
            error.statusCode = 409;
            error.details = {
              staleResults: staleResults.map(({ result, reasons, latestResultId }) => ({
                resultId: result.id,
                questionId: result.questionId,
                reasons,
                latestResultId,
              })),
            };
            throw error;
          }
          const answerConflicts = results.filter((result) => knowledgeClassificationAnswerConflict(questionMap.get(result.questionId)));
          if (answerConflicts.length) {
            const error = new Error("knowledge_classification_answer_conflict");
            error.statusCode = 409;
            throw error;
          }
          const unresolved = results.filter((result) => ["unable", "missing_node"].includes(result.agent2Verification.decision));
          if (unresolved.length) throw new Error("knowledge_classification_result_unresolved");
          const knowledgeAdjacency = buildKnowledgeAdjacency(structure?.nodes || []);
          const knowledgeNodeMap = new Map((structure?.nodes || []).filter((node) => node.kind === "knowledge").map((node) => [node.id, node]));
          const normalizedContributionNodeIds = (value) => [...new Set((Array.isArray(value) ? value : [])
            .map(String).filter(Boolean))].sort();
          const familyCoverageNodeIds = (family) => normalizedContributionNodeIds(family?.requiredKnowledgeNodeIds);
          const validateMembershipCoverage = ({
            familyMemberships,
            familyById,
            candidateFamilyDraft,
            primaryNodeId,
            primaryNodeRole,
            requiredNodeIds,
          }) => {
            const expected = normalizedContributionNodeIds(requiredNodeIds);
            const expectedSet = new Set(expected);
            const participants = (familyMemberships || []).map((membership) => ({
              membership,
              coverageNodeIds: familyCoverageNodeIds(familyById.get(membership.familyId)),
            }));
            if (candidateFamilyDraft) {
              participants.push({
                membership: {
                  familyId: "",
                  isPrimary: true,
                  coverageRole: "required",
                  contributionKnowledgeNodeIds: normalizedContributionNodeIds(
                    candidateFamilyDraft.membership?.contributionKnowledgeNodeIds,
                  ),
                },
                coverageNodeIds: familyCoverageNodeIds(candidateFamilyDraft),
              });
            }
            if (!participants.length) return;
            const primary = participants.find(({ membership }) => membership.isPrimary);
            if (!primary || (primaryNodeRole === "core"
              && !primary.membership.contributionKnowledgeNodeIds.includes(primaryNodeId))) {
              throw new Error("knowledge_classification_primary_family_contribution_mismatch");
            }
            participants.forEach(({ membership, coverageNodeIds }) => {
              const contribution = normalizedContributionNodeIds(membership.contributionKnowledgeNodeIds);
              if (!coverageNodeIds.length || contribution.some((nodeId) => (
                !expectedSet.has(nodeId) || !coverageNodeIds.includes(nodeId)
              ))) {
                throw new Error("knowledge_classification_family_contribution_invalid");
              }
              if (membership.coverageRole === "reference" && contribution.length) {
                throw new Error("knowledge_classification_reference_family_contribution_forbidden");
              }
              if ((membership.isPrimary || membership.coverageRole === "required") && !contribution.length) {
                throw new Error("knowledge_classification_family_contribution_required");
              }
            });
            const actual = normalizedContributionNodeIds(participants
              .filter(({ membership }) => membership.isPrimary || membership.coverageRole === "required")
              .flatMap(({ membership }) => membership.contributionKnowledgeNodeIds));
            if (actual.length !== expected.length || actual.some((nodeId, index) => nodeId !== expected[index])) {
              throw new Error("knowledge_classification_family_contribution_coverage_mismatch");
            }
          };
          const reviewed = results.map((result) => {
            const verification = result.agent2Verification;
            const offeredNodeIds = [...new Set([verification.primaryNodeId, ...(verification.requiredNodeIds || [])].map(String).filter(Boolean))];
            const requested = requestedSelectionMap.get(result.id);
            const requiredNodeIds = [...new Set((requested
              ? (Array.isArray(requested.requiredNodeIds) ? requested.requiredNodeIds : [])
              : (verification.requiredNodeIds || [])).map(String).filter(Boolean))];
            const primaryNodeId = String(requested?.primaryNodeId || verification.primaryNodeId || "");
            const primaryNodeRole = normalizedPrimaryNodeRole(requested?.primaryNodeRole || verification.primaryNodeRole);
            if (!requiredNodeIds.length) throw new Error("knowledge_classification_selection_required");
            if (!primaryNodeId || (primaryNodeRole === "core" && !requiredNodeIds.includes(primaryNodeId))) {
              throw new Error("knowledge_classification_primary_selection_required");
            }
            if (primaryNodeRole === "scope_anchor" && (requiredNodeIds.includes(primaryNodeId)
              || !knowledgeScopeAnchorMatchesRequired(knowledgeNodeMap, primaryNodeId, requiredNodeIds))) {
              throw new Error("knowledge_classification_scope_anchor_invalid");
            }
            if (requested && requiredNodeIds.some((nodeId) => !offeredNodeIds.includes(nodeId))) throw new Error("knowledge_classification_selection_not_offered");
            if (requiredNodeIds.some((nodeId) => !knowledgeNodeMap.has(nodeId))) throw new Error("knowledge_classification_selection_node_invalid");
            const createCandidateFamily = requested?.createCandidateFamily === true;
            let candidateFamilyDraft = null;
            if (createCandidateFamily) {
              if (verification.familyDecision !== "create_new" || !verification.candidateFamilyDraft) {
                throw new Error("knowledge_classification_family_draft_not_offered");
              }
              candidateFamilyDraft = normalizeCandidateFamilyDraft(
                requested.candidateFamilyDraft || verification.candidateFamilyDraft,
                {
                  adjacency: knowledgeAdjacency,
                  primaryNodeId,
                  primaryNodeRole,
                  requiredNodeIds,
                  focusKey: verification.focusKey,
                  evidenceChunkIds: verification.evidenceChunkIds,
                },
              );
            }
            const hasFamilyMemberships = Boolean(requested && Object.prototype.hasOwnProperty.call(requested, "familyMemberships"));
            const familyMemberships = [];
            const selectedFamilyIds = new Set();
            const familyById = new Map();
            if (hasFamilyMemberships) {
              (Array.isArray(requested.familyMemberships) ? requested.familyMemberships : []).forEach((membership) => {
                const familyId = String(membership?.familyId || "");
                if (!familyId || selectedFamilyIds.has(familyId)) return;
                const family = questionFamilyStore.get(familyId);
                if (!family) throw new Error("question_family_not_found");
                if (family.bookId !== bookId) throw new Error("question_family_book_mismatch");
                if (family.status === "rejected") throw new Error("question_family_rejected");
                const familyKnowledgeIds = new Set(familyCoverageNodeIds(family));
                const offeredFamilyIds = new Set([
                  verification.primaryFamilyId,
                  ...(verification.relatedFamilyIds || []),
                  ...(verification.matchedFamilyIds || []),
                  ...(verification.duplicateFamilyIds || []),
                ].filter(Boolean));
                if (!offeredFamilyIds.has(familyId) && ![...familyKnowledgeIds].some((nodeId) => requiredNodeIds.includes(nodeId))) {
                  throw new Error("knowledge_classification_family_knowledge_mismatch");
                }
                const isPrimary = membership?.isPrimary === true;
                const coverageRole = isPrimary ? "required" : String(membership?.coverageRole || "");
                if (!isPrimary && !["required", "reference"].includes(coverageRole)) {
                  throw new Error("knowledge_classification_family_coverage_role_required");
                }
                if (!Object.prototype.hasOwnProperty.call(membership || {}, "contributionKnowledgeNodeIds")) {
                  throw new Error("knowledge_classification_family_contribution_required");
                }
                selectedFamilyIds.add(familyId);
                familyById.set(familyId, family);
                familyMemberships.push({
                  familyId,
                  isPrimary,
                  coverageRole,
                  contributionKnowledgeNodeIds: normalizedContributionNodeIds(membership.contributionKnowledgeNodeIds),
                });
              });
              const primaryFamilyCount = familyMemberships.filter((membership) => membership.isPrimary).length;
              if ((!createCandidateFamily && familyMemberships.length && primaryFamilyCount !== 1)
                || (createCandidateFamily && primaryFamilyCount !== 0)) {
                  throw new Error(createCandidateFamily ? "knowledge_classification_candidate_family_primary_conflict" : "question_family_primary_required");
              }
            }
            if (createCandidateFamily && !Object.prototype.hasOwnProperty.call(
              requested?.candidateFamilyDraft?.membership || {},
              "contributionKnowledgeNodeIds",
            )) {
              throw new Error("knowledge_classification_family_contribution_required");
            }
            if ((hasFamilyMemberships && familyMemberships.length) || createCandidateFamily) {
              validateMembershipCoverage({
                familyMemberships,
                familyById,
                candidateFamilyDraft,
                primaryNodeId,
                primaryNodeRole,
                requiredNodeIds,
              });
            }
            const suggestedRequiredNodeIds = [...new Set((verification.requiredNodeIds || []).map(String).filter(Boolean))].sort();
            const selectedRequiredNodeIds = [...requiredNodeIds].sort();
            const wasAdjusted = primaryNodeId !== verification.primaryNodeId
              || primaryNodeRole !== normalizedPrimaryNodeRole(verification.primaryNodeRole)
              || suggestedRequiredNodeIds.join("\u0000") !== selectedRequiredNodeIds.join("\u0000");
            const suggestedFamilyMemberships = Array.isArray(verification.familyMemberships)
              ? verification.familyMemberships
              : [
                ...(verification.primaryFamilyId ? [{
                  familyId: verification.primaryFamilyId,
                  isPrimary: true,
                  coverageRole: "required",
                  contributionKnowledgeNodeIds: requiredNodeIds,
                }] : []),
                ...(verification.relatedFamilyRelations || []).map((relation) => ({
                  familyId: relation.familyId,
                  isPrimary: false,
                  coverageRole: relation.coverageRole,
                  contributionKnowledgeNodeIds: relation.contributionKnowledgeNodeIds || [],
                })),
              ];
            const familySelectionKey = (memberships) => memberships.map((membership) => [
              membership.familyId,
              membership.isPrimary ? "1" : "0",
              membership.coverageRole || "",
              normalizedContributionNodeIds(membership.contributionKnowledgeNodeIds).join(","),
            ].join(":"))
              .sort().join("\u0000");
            const familyWasAdjusted = hasFamilyMemberships
              && familySelectionKey(familyMemberships) !== familySelectionKey(suggestedFamilyMemberships);
            const adjustmentReason = String(requested?.adjustmentReason || payload.adjustmentReason || "").trim().slice(0, 2000);
            if ((wasAdjusted || familyWasAdjusted) && !adjustmentReason) {
              throw new Error("knowledge_classification_adjustment_reason_required");
            }
            return {
              result,
              verification: { ...verification, primaryNodeId, primaryNodeRole, requiredNodeIds },
              originalVerification: verification,
              reviewSelection: {
                primaryNodeId,
                primaryNodeRole,
                requiredNodeIds,
                wasAdjusted,
                familyWasAdjusted,
                adjustmentReason,
                ...(hasFamilyMemberships ? { familyMemberships } : {}),
                ...(createCandidateFamily ? { createCandidateFamily: true, candidateFamilyDraft } : {}),
              },
            };
          });
          const selectedIdSet = new Set(results.map((result) => result.questionId));
          const affectedPreviousFamilyIds = questionFamilyStore.list({ bookId, status: "all" }).families
            .filter((family) => family.members.some((member) => selectedIdSet.has(member.questionId)))
            .map((family) => family.id);
          const assignments = reviewed.map(({ result, verification }) => ({
            questionId: result.questionId,
            primaryNodeId: verification.primaryNodeId,
            primaryNodeRole: verification.primaryNodeRole,
            requiredNodeIds: verification.requiredNodeIds,
            focusKey: verification.focusKey,
            focusLabel: verification.focusLabel,
            action: verification.action,
            confidence: verification.confidence,
            reason: verification.reason,
            evidenceChunkIds: verification.evidenceChunkIds,
            classificationJobId: result.jobId,
            questionVersion: result.baseQuestionVersion,
            source: "hierarchy_agent_review",
          }));
          classificationCommitCoordinator.prepare({
            commitId,
            requestHash,
            mode: options.aiConfigStore ? "memory_rollback" : "file_rollback",
            bookId,
            resultIds,
            actor: currentAdminDisplayName() || "超级管理员",
            dependencies: {
              questionVersions: Object.fromEntries(results.map((result) => [
                result.questionId,
                Number(questionMap.get(result.questionId)?.version || 0),
              ])),
              knowledgeStructureRevision: Number(structure?.updatedAt || 0),
              textbookKnowledgeVersion: Number(knowledge?.version || 0),
              familyRevision: Number(questionFamilyStore.exportState().generatedAtByBook?.[bookId] || 0),
            },
            reviewSelections: reviewed.map(({ result, reviewSelection }) => ({
              resultId: result.id,
              primaryNodeId: reviewSelection.primaryNodeId,
              primaryNodeRole: reviewSelection.primaryNodeRole,
              requiredNodeIds: reviewSelection.requiredNodeIds,
              ...(Object.prototype.hasOwnProperty.call(reviewSelection, "familyMemberships")
                ? { familyMemberships: reviewSelection.familyMemberships }
                : {}),
              ...(reviewSelection.createCandidateFamily ? {
                createCandidateFamily: true,
                candidateFamilyDraft: reviewSelection.candidateFamilyDraft,
              } : {}),
              adjustmentReason: reviewSelection.adjustmentReason,
            })),
            request: commitRequest,
          });
          commitPrepared = true;
          const assigned = knowledgeStructureStore.assignQuestions(bookId, assignments);
          const allQuestions = questionStore.list({ library: "official", status: "all", bookId }).questions;
          const fingerprintMap = new Map(assigned.structure.fingerprints.map((fingerprint) => [fingerprint.questionId, fingerprint]));
          const nodeOrder = new Map(assigned.structure.nodes.map((node, index) => [node.id, index + 1]));
          const regenerated = questionFamilyStore.generate(allQuestions, bookId, {
            fingerprintMap,
            nodeOrder,
            archiveReason: "knowledge_classification_applied",
            resetReviewQuestionIds: results.map((result) => result.questionId),
            excludedQuestionIds: reviewed.filter(({ reviewSelection }) => reviewSelection.createCandidateFamily
              || Object.prototype.hasOwnProperty.call(reviewSelection, "familyMemberships"))
              .map(({ result }) => result.questionId),
            preserveFamilyIds: reviewed.flatMap(({ reviewSelection }) => (reviewSelection.familyMemberships || []).map((membership) => membership.familyId)),
          });
          const createdCandidateFamilies = reviewed.filter(({ reviewSelection }) => reviewSelection.createCandidateFamily)
            .map(({ result, verification, reviewSelection }) => {
              const question = questionMap.get(result.questionId);
              const draft = reviewSelection.candidateFamilyDraft;
              const anchor = knowledgeAdjacency.byId.get(draft.textbookAnchorNodeIds[0]);
              const coreNode = knowledgeNodeMap.get(draft.coreKnowledgeNodeId);
              const family = questionFamilyStore.create({
                subjectId: question?.subjectId,
                bookId,
                name: draft.name,
                focusKey: draft.focusKey,
                primaryKnowledgePoint: coreNode?.displayTitle || coreNode?.title || verification.focusLabel,
                knowledgeNodeId: draft.textbookAnchorNodeIds[0],
                knowledgePath: anchor?.path || "",
                chapter: anchor?.path || "",
                coreKnowledgeNodeId: draft.coreKnowledgeNodeId,
                requiredKnowledgeNodeIds: draft.requiredKnowledgeNodeIds,
                textbookAnchorNodeIds: draft.textbookAnchorNodeIds,
                assessmentAction: draft.assessmentAction,
                inclusionBoundary: draft.inclusionBoundary,
                exclusionBoundary: draft.exclusionBoundary,
                reason: draft.reason || "Agent 3 提出的候选新题族经人工确认创建；成员与题族边界仍处于待审核状态。",
              });
              reviewSelection.familyMemberships = [
                ...(reviewSelection.familyMemberships || []).map((membership) => ({ ...membership, isPrimary: false })),
                {
                  familyId: family.id,
                  isPrimary: true,
                  coverageRole: "required",
                  contributionKnowledgeNodeIds: draft.membership.contributionKnowledgeNodeIds,
                },
              ];
              return { resultId: result.id, questionId: result.questionId, family };
            });
          const familyMembershipResults = reviewed.filter(({ reviewSelection }) => reviewSelection.createCandidateFamily
              || Object.prototype.hasOwnProperty.call(reviewSelection, "familyMemberships"))
            .map(({ result, reviewSelection }) => questionFamilyStore.setMemberships(
              questionMap.get(result.questionId),
              reviewSelection.familyMemberships,
              currentAdminDisplayName() || "超级管理员",
            ));
          const finalizedCandidateFamilies = createdCandidateFamilies.map((item) => ({
            ...item,
            family: questionFamilyStore.get(item.family.id),
          }));
          const postApplyFamilySummary = questionFamilyStore.list({ bookId, status: "all" }).summary;
          const assignedNodeMap = new Map((assigned.structure.nodes || []).map((node) => [node.id, node]));
          const confirmedCases = reviewed.map(({ result, verification, reviewSelection }) => {
            const question = questionMap.get(result.questionId);
            return knowledgeClassificationExperienceStore.addCase({
              bookId,
              questionId: result.questionId,
              resultId: result.id,
              questionType: question?.type,
              stem: question?.stem,
              options: question?.options,
              primaryNodeId: verification.primaryNodeId,
              primaryNodeRole: verification.primaryNodeRole,
              requiredNodeIds: verification.requiredNodeIds,
              knowledgePath: assignedNodeMap.get(verification.primaryNodeId)?.path || "",
              focusKey: verification.focusKey,
              focusLabel: verification.focusLabel,
              primaryFamilyId: reviewSelection.familyMemberships?.find((membership) => membership.isPrimary)?.familyId || "",
              familyIds: (reviewSelection.familyMemberships || []).map((membership) => membership.familyId),
              action: verification.action,
              reason: verification.reason,
              features: result.agent1Features,
              referenceWeight: reviewSelection.wasAdjusted ? 2 : 1,
              ruleIds: [...new Set([
                ...(result.agent1RuleIds || []),
                ...(result.agent2RuleIds || []),
              ])],
              confirmedBy: currentAdminDisplayName() || "超级管理员",
            });
          });
          const corrections = reviewed.filter(({ reviewSelection }) => reviewSelection.wasAdjusted)
            .map(({ result, originalVerification, reviewSelection }) => knowledgeClassificationExperienceStore.addCorrection({
              bookId,
              questionId: result.questionId,
              resultId: result.id,
              suggestedPrimaryNodeId: originalVerification.primaryNodeId,
              suggestedRequiredNodeIds: originalVerification.requiredNodeIds,
              finalPrimaryNodeId: reviewSelection.primaryNodeId,
              finalRequiredNodeIds: reviewSelection.requiredNodeIds,
              reason: reviewSelection.adjustmentReason || "人工调整了 AI 建议（历史接口未提供调整依据）",
              features: result.agent1Features,
              correctedBy: currentAdminDisplayName() || "超级管理员",
            }));
          const correctionReviewEvents = reviewed.filter(({ reviewSelection }) => reviewSelection.wasAdjusted)
            .map(({ result, originalVerification, reviewSelection }) => {
              const originalNode = assignedNodeMap.get(originalVerification.primaryNodeId);
              const finalNode = assignedNodeMap.get(reviewSelection.primaryNodeId);
              return knowledgeClassificationExperienceStore.recordReviewEvent({
                bookId,
                questionId: result.questionId,
                resultId: result.id,
                eventType: "classification_correction",
                topicKey: `classification-correction:${originalVerification.primaryNodeId}->${reviewSelection.primaryNodeId}`,
                reason: reviewSelection.adjustmentReason || "人工调整了 AI 分类建议。",
                suggestedPrimaryNodeId: originalVerification.primaryNodeId,
                finalPrimaryNodeId: reviewSelection.primaryNodeId,
                evidenceChunkIds: originalVerification.evidenceChunkIds,
                proposal: {
                  type: "rule",
                  title: `人工改判：${originalNode?.displayTitle || originalNode?.title || originalVerification.primaryNodeId} → ${finalNode?.displayTitle || finalNode?.title || reviewSelection.primaryNodeId}`,
                  statement: reviewSelection.adjustmentReason || `同类题不得归入 ${originalVerification.primaryNodeId}，应优先核验 ${reviewSelection.primaryNodeId}。`,
                  scopeNodeIds: reviewSelection.requiredNodeIds,
                  scopePath: finalNode?.path || "",
                  positiveExamples: [result.questionId],
                  priority: "medium",
                },
              }, "Agent 4 / 超级管理员");
            });
          const ruleExceptions = reviewed.flatMap(({ result, originalVerification, reviewSelection }) => {
            if (!reviewSelection.wasAdjusted) return [];
            const activeRuleIds = knowledgeClassificationExperienceStore.getRules([...new Set([
              ...(result.agent1RuleIds || []),
              ...(result.agent2RuleIds || []),
            ])]).filter((rule) => rule.status === "active").map((rule) => rule.id);
            return activeRuleIds.map((ruleId) => knowledgeClassificationExperienceStore.addRuleException({
              ruleId,
              bookId,
              questionId: result.questionId,
              resultId: result.id,
              suggestedPrimaryNodeId: originalVerification.primaryNodeId,
              finalPrimaryNodeId: reviewSelection.primaryNodeId,
              reason: reviewSelection.adjustmentReason || "人工调整了 AI 建议（历史接口未提供调整依据）",
              createdBy: "Agent 4 / 超级管理员",
            }));
          });
          const bookDossiers = knowledgeDossierStore.list({ bookId });
          const dossierByNodeId = new Map();
          bookDossiers.forEach((dossier) => dossier.occurrences.forEach((occurrence) => {
            if (!dossierByNodeId.has(occurrence.nodeId)) dossierByNodeId.set(occurrence.nodeId, []);
            dossierByNodeId.get(occurrence.nodeId).push(dossier);
          }));
          const dossierDeltas = reviewed.flatMap(({ result, originalVerification, reviewSelection }) => {
            const deltas = [];
            const primaryDossiers = dossierByNodeId.get(reviewSelection.primaryNodeId) || [];
            if (reviewSelection.wasAdjusted) {
              primaryDossiers.slice(0, 3).forEach((dossier) => {
                const reason = reviewSelection.adjustmentReason || `Agent 2 建议 ${originalVerification.primaryNodeId}，人工修正为 ${reviewSelection.primaryNodeId}。`;
                const recorded = knowledgeClassificationExperienceStore.recordReviewEvent({
                  bookId,
                  questionId: result.questionId,
                  resultId: result.id,
                  eventType: "classification_correction",
                  topicKey: `dossier-boundary:${dossier.id}:${originalVerification.primaryNodeId}->${reviewSelection.primaryNodeId}`,
                  reason,
                  proposal: {
                    type: "dossier",
                    dossierId: dossier.id,
                    title: `档案边界修订候选：${dossier.canonicalName}`,
                    statement: reason,
                    patch: { reviewCases: [{ questionId: result.questionId, reason }] },
                  },
                }, "Agent 4 / 超级管理员");
                if (recorded.thresholdReached && recorded.independentCaseCount === 3) {
                  deltas.push(knowledgeDossierStore.createDelta({
                    bookId,
                    dossierId: dossier.id,
                    questionId: result.questionId,
                    resultId: result.id,
                    type: "exception",
                    title: `三例触发的档案修订建议：${dossier.canonicalName}`,
                    reason,
                    suggestedPatch: recorded.dossierSuggestion?.patch || {},
                    sourceAgent: "Agent 4",
                  }));
                }
              });
            }
            const relatedDossiers = reviewSelection.requiredNodeIds
              .filter((nodeId) => nodeId !== reviewSelection.primaryNodeId)
              .flatMap((nodeId) => dossierByNodeId.get(nodeId) || [])
              .filter((dossier, index, items) => items.findIndex((item) => item.id === dossier.id) === index);
            if (primaryDossiers.length && relatedDossiers.length) {
              const primaryDossier = primaryDossiers[0];
              const relatedIds = relatedDossiers.slice(0, 5).map((related) => related.id).sort();
              const suggestedPatch = {
                relations: relatedDossiers.slice(0, 5).map((related) => ({
                    type: "supplements",
                    targetDossierId: related.id,
                    targetName: related.canonicalName,
                    direction: "bidirectional",
                    reason: `题目 ${result.questionId} 的人工确认作答路径同时调用两个概念。`,
                    status: "pending_review",
                  })),
              };
              const reason = reviewSelection.adjustmentReason || "人工确认该题的最小充分知识集同时包含多个规范概念，建议审核概念关系。";
              const recorded = knowledgeClassificationExperienceStore.recordReviewEvent({
                bookId,
                questionId: result.questionId,
                resultId: result.id,
                eventType: "classification_confirmation",
                topicKey: `dossier-relation:${primaryDossier.id}:${relatedIds.join("+")}`,
                reason,
                proposal: {
                  type: "dossier",
                  dossierId: primaryDossier.id,
                  title: `跨知识关系修订候选：${primaryDossier.canonicalName}`,
                  statement: reason,
                  patch: suggestedPatch,
                },
              }, "Agent 4 / 超级管理员");
              if (recorded.thresholdReached && recorded.independentCaseCount === 3) {
                deltas.push(knowledgeDossierStore.createDelta({
                  bookId,
                  dossierId: primaryDossier.id,
                  questionId: result.questionId,
                  resultId: result.id,
                  type: "relation",
                  title: `三例触发的跨知识关系建议：${primaryDossier.canonicalName}`,
                  reason,
                  suggestedPatch: recorded.dossierSuggestion?.patch || suggestedPatch,
                  sourceAgent: "Agent 4",
                }));
              }
            }
            return deltas;
          });
          logOperation({
            action: "knowledge_classification.apply",
            category: "question",
            targetType: "knowledge_classification_batch",
            targetId: bookId,
            summary: `人工采纳 ${reviewed.length} 条四 Agent 知识巡检建议并重新归组`,
            metadata: {
              bookId,
              resultIds,
              questionIds: results.map((result) => result.questionId),
              reviewSelections: reviewed.map(({ result, reviewSelection }) => ({
                resultId: result.id,
                primaryNodeId: reviewSelection.primaryNodeId,
                primaryNodeRole: reviewSelection.primaryNodeRole,
                requiredNodeIds: reviewSelection.requiredNodeIds,
                ...(Object.prototype.hasOwnProperty.call(reviewSelection, "familyMemberships") ? { familyMemberships: reviewSelection.familyMemberships } : {}),
                ...(reviewSelection.createCandidateFamily ? {
                  createCandidateFamily: true,
                  candidateFamilyId: reviewSelection.familyMemberships?.find((membership) => membership.isPrimary)?.familyId || "",
                } : {}),
              })),
              affectedPreviousFamilyIds,
              affectedFamilyIds: [...new Set(familyMembershipResults.flatMap((item) => item.affectedFamilyIds || []))],
            },
          });
          // 与题目完善同一套留痕：本次采纳写入的正式字段清单（不是"差异"，而是"这次写入了哪些字段"）。
          // 题目完善记的是 patch 键（chapter / knowledgePoints / scoringPoints），巡检对应的就是它写进正式指纹的字段。
          const classificationAppliedFields = (reviewSelection) => [
            "primaryNodeId",
            "primaryNodeRole",
            "requiredNodeIds",
            "problemKnowledgeRangeNodeIds",
            "knowledgeThemeRangeAnchorNodeId",
            ...(Object.prototype.hasOwnProperty.call(reviewSelection, "familyMemberships") ? ["familyMemberships"] : []),
            ...(reviewSelection.createCandidateFamily ? ["createCandidateFamily"] : []),
          ];
          const applied = reviewed.map(({ result, reviewSelection }) => knowledgeClassificationStore.applyResult(
            result.id,
            currentAdminDisplayName() || "超级管理员",
            payload.note || "",
            reviewSelection,
            classificationAppliedFields(reviewSelection),
            // 采纳到哪个版本：题目完善写的是"应用后的题目新版本"；巡检不产生新题目版本，
            // 所以记录"本次采纳写入的正式指纹所标注的题目版本"（与指纹自身的 questionVersion 同源，
            // 不会与落盘产物产生分歧）。
            Number(result.baseQuestionVersion) || 0,
          ));
          const responseBody = {
            success: true,
            schemaVersion: CLASSIFICATION_COMMIT_SCHEMA_VERSION,
            commitId,
            appliedCount: applied.length,
            reviewSelections: reviewed.map(({ result, reviewSelection }) => ({
              resultId: result.id,
              primaryNodeId: reviewSelection.primaryNodeId,
              primaryNodeRole: reviewSelection.primaryNodeRole,
              requiredNodeIds: reviewSelection.requiredNodeIds,
              ...(Object.prototype.hasOwnProperty.call(reviewSelection, "familyMemberships") ? { familyMemberships: reviewSelection.familyMemberships } : {}),
              ...(reviewSelection.createCandidateFamily ? {
                createCandidateFamily: true,
                candidateFamilyId: reviewSelection.familyMemberships?.find((membership) => membership.isPrimary)?.familyId || "",
              } : {}),
            })),
            familyMemberships: familyMembershipResults.flatMap((item) => item.memberships || []),
            createdCandidateFamilies: finalizedCandidateFamilies,
            confirmedCases,
            agent4: {
              confirmedCaseCount: confirmedCases.length,
              correctionCount: corrections.length,
              reviewEventCount: correctionReviewEvents.length,
              promotedRuleDraftCount: correctionReviewEvents.filter((item) => item.rule).length,
              ruleExceptionCount: ruleExceptions.length,
              dossierDeltaCount: dossierDeltas.length,
              corrections,
              reviewEvents: correctionReviewEvents.map((item) => item.event),
              ruleExceptions,
              dossierDeltas,
            },
            familySummary: {
              total: postApplyFamilySummary.total,
              pending: postApplyFamilySummary.pending,
              confirmed: postApplyFamilySummary.confirmed,
            },
          };
          classificationCommitCoordinator.commit(commitId, responseBody);
          commitPrepared = false;
          sendJson(response, 200, responseBody);
        } catch (error) {
          if (commitPrepared) {
            try {
              classificationCommitCoordinator.rollback(commitId, error);
              commitPrepared = false;
            } catch (rollbackError) {
              rollbackError.statusCode = 503;
              rollbackError.details = {
                originalError: error.message,
                recoveryError: rollbackError.message,
                commitId,
              };
              throw rollbackError;
            }
          }
          throw error;
        } finally {
          activeKnowledgeClassificationApplies.delete(applyLockKey);
        }
      } catch (error) {
        const status = error.statusCode || (error.message === "knowledge_classification_result_not_found" ? 404 : 422);
        sendJson(response, status, {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/question-family-sets") {
      const bookId = url.searchParams.get("bookId") || "modern-chinese-7-1";
      const query = url.searchParams.get("query") || "";
      sendJson(response, 200, { success: true, ...questionFamilySetsForBook(bookId, query) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/question-family-sets") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const knowledgeNodeId = String(payload.knowledgeNodeId || "");
        const familyIds = [...new Set((Array.isArray(payload.familyIds) ? payload.familyIds : []).map(String).filter(Boolean))];
        const childSetIds = [...new Set((Array.isArray(payload.childSetIds) ? payload.childSetIds : []).map(String).filter(Boolean))];
        const validated = validateQuestionFamilySetScope({
          bookId,
          knowledgeNodeId,
          parentSetId: String(payload.parentSetId || ""),
          familyIds,
          childSetIds,
        });
        const result = questionFamilyStore.createSet({
          ...payload,
          bookId,
          knowledgeNodeId: validated.node.id,
          subjectId: validated.families[0]?.subjectId || validated.parent?.subjectId || validated.childSets[0]?.subjectId || "",
          familyIds,
          childSetIds,
        }, currentAdminDisplayName() || "超级管理员");
        const familySet = questionFamilySetsForBook(bookId).sets.find((item) => item.id === result.set.id) || result.set;
        logOperation({
          action: "question_family_set.create",
          category: "question",
          targetType: "question_family_set",
          targetId: familySet.id,
          summary: `创建题族集“${familySet.name}”`,
          metadata: {
            bookId,
            knowledgeNodeId: validated.node.id,
            parentSetId: familySet.parentSetId,
            familyIds,
            childSetIds,
            movedFromSetIds: result.movedFromSetIds || [],
          },
        });
        sendJson(response, 201, { success: true, ...result, set: familySet });
      } catch (error) {
        sendJson(response, questionFamilySetErrorStatus(error), { success: false, error: error.message });
      }
      return;
    }

    const questionFamilySetMemberMatch = url.pathname.match(/^\/api\/admin\/question-family-sets\/([^/]+)\/members\/(family|set)\/([^/]+)$/);
    if (request.method === "DELETE" && questionFamilySetMemberMatch) {
      try {
        const setId = decodeURIComponent(questionFamilySetMemberMatch[1]);
        const memberType = decodeURIComponent(questionFamilySetMemberMatch[2]);
        const memberId = decodeURIComponent(questionFamilySetMemberMatch[3]);
        const payload = await readJsonBody(request).catch(() => ({}));
        const current = questionFamilyStore.getSet(setId);
        if (!current) throw new Error("question_family_set_not_found");
        const result = questionFamilyStore.removeSetMember(setId, memberType, memberId, currentAdminDisplayName() || "超级管理员", payload.expectedRevision);
        const familySet = questionFamilySetsForBook(current.bookId).sets.find((item) => item.id === setId) || result.set;
        logOperation({
          action: "question_family_set.member_remove",
          category: "question",
          targetType: "question_family_set",
          targetId: setId,
          summary: `从题族集“${current.name}”移除${memberType === "family" ? "题族" : "下级题族集"}`,
          metadata: { bookId: current.bookId, memberType, memberId },
        });
        sendJson(response, 200, { success: true, ...result, set: familySet });
      } catch (error) {
        sendJson(response, questionFamilySetErrorStatus(error), { success: false, error: error.message });
      }
      return;
    }

    const questionFamilySetMembersMatch = url.pathname.match(/^\/api\/admin\/question-family-sets\/([^/]+)\/members$/);
    if (request.method === "POST" && questionFamilySetMembersMatch) {
      try {
        const setId = decodeURIComponent(questionFamilySetMembersMatch[1]);
        const payload = await readJsonBody(request, 512 * 1024);
        const target = questionFamilyStore.getSet(setId);
        if (!target) throw new Error("question_family_set_not_found");
        const familyIds = [...new Set((Array.isArray(payload.familyIds) ? payload.familyIds : []).map(String).filter(Boolean))];
        const childSetIds = [...new Set((Array.isArray(payload.childSetIds) ? payload.childSetIds : []).map(String).filter(Boolean))];
        validateQuestionFamilySetScope({
          bookId: target.bookId,
          knowledgeNodeId: target.knowledgeNodeId,
          parentSetId: target.parentSetId,
          familyIds,
          childSetIds,
        });
        const result = questionFamilyStore.addSetMembers(setId, { ...payload, familyIds, childSetIds }, currentAdminDisplayName() || "超级管理员");
        const familySet = questionFamilySetsForBook(target.bookId).sets.find((item) => item.id === setId) || result.set;
        logOperation({
          action: payload.mode === "move" ? "question_family_set.members_move" : "question_family_set.members_add",
          category: "question",
          targetType: "question_family_set",
          targetId: setId,
          summary: `${payload.mode === "move" ? "移动" : "加入"} ${result.added.length} 个成员至题族集“${target.name}”`,
          metadata: { bookId: target.bookId, familyIds, childSetIds, movedFromSetIds: result.movedFromSetIds },
        });
        sendJson(response, 200, { success: true, ...result, set: familySet });
      } catch (error) {
        sendJson(response, questionFamilySetErrorStatus(error), { success: false, error: error.message });
      }
      return;
    }

    const questionFamilySetMatch = url.pathname.match(/^\/api\/admin\/question-family-sets\/([^/]+)$/);
    if (["PATCH", "PUT"].includes(request.method) && questionFamilySetMatch) {
      try {
        const setId = decodeURIComponent(questionFamilySetMatch[1]);
        const payload = await readJsonBody(request, 512 * 1024);
        const current = questionFamilyStore.getSet(setId);
        if (!current) throw new Error("question_family_set_not_found");
        const hasParentSetId = Object.prototype.hasOwnProperty.call(payload, "parentSetId");
        const hasFamilyIds = Object.prototype.hasOwnProperty.call(payload, "familyIds");
        const hasChildSetIds = Object.prototype.hasOwnProperty.call(payload, "childSetIds");
        const knowledgeNodeId = String(payload.knowledgeNodeId == null ? current.knowledgeNodeId : payload.knowledgeNodeId);
        const parentSetId = hasParentSetId ? String(payload.parentSetId || "") : current.parentSetId;
        const familyIds = [...new Set((hasFamilyIds && Array.isArray(payload.familyIds) ? payload.familyIds : []).map(String).filter(Boolean))];
        const childSetIds = [...new Set((hasChildSetIds && Array.isArray(payload.childSetIds) ? payload.childSetIds : []).map(String).filter(Boolean))];
        const validated = validateQuestionFamilySetScope({
          bookId: current.bookId,
          knowledgeNodeId,
          parentSetId,
          familyIds: [...new Set([...current.directFamilyIds, ...familyIds])],
          childSetIds: [...new Set([...current.directChildSetIds, ...childSetIds])],
        });
        const result = questionFamilyStore.updateSet(setId, {
          ...payload,
          knowledgeNodeId: validated.node.id,
          ...(hasParentSetId ? { parentSetId } : {}),
          ...(hasFamilyIds ? { familyIds } : {}),
          ...(hasChildSetIds ? { childSetIds } : {}),
        }, currentAdminDisplayName() || "超级管理员");
        const familySet = questionFamilySetsForBook(current.bookId).sets.find((item) => item.id === setId) || result.set;
        logOperation({
          action: "question_family_set.update",
          category: "question",
          targetType: "question_family_set",
          targetId: setId,
          summary: `修改题族集“${familySet.name}”`,
          metadata: {
            bookId: current.bookId,
            previousKnowledgeNodeId: current.knowledgeNodeId,
            knowledgeNodeId: familySet.knowledgeNodeId,
            previousParentSetId: result.previousParentSetId,
            parentSetId: familySet.parentSetId,
            added: result.added || [],
            movedFromSetIds: result.movedFromSetIds || [],
          },
        });
        sendJson(response, 200, { success: true, ...result, set: familySet });
      } catch (error) {
        sendJson(response, questionFamilySetErrorStatus(error), { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "DELETE" && questionFamilySetMatch) {
      try {
        const setId = decodeURIComponent(questionFamilySetMatch[1]);
        const payload = await readJsonBody(request).catch(() => ({}));
        const current = questionFamilyStore.getSet(setId);
        if (!current) throw new Error("question_family_set_not_found");
        const result = questionFamilyStore.removeSet(setId, currentAdminDisplayName() || "超级管理员", payload.expectedRevision);
        logOperation({
          action: "question_family_set.delete",
          category: "question",
          targetType: "question_family_set",
          targetId: setId,
          summary: `删除题族集“${current.name}”`,
          metadata: { bookId: current.bookId, detachedFamilyIds: result.detachedFamilyIds, parentSetId: result.parentSetId },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, questionFamilySetErrorStatus(error), { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/question-family-options") {
      const bookId = url.searchParams.get("bookId") || "modern-chinese-7-1";
      const result = questionFamilyStore.list({ bookId, status: "all" });
      // Materialize the book's questions once for every family in this
      // response.  The old path called questionStore.getMany() separately
      // for each family, which made a catalog refresh read and re-derive the
      // entire question library hundreds of times.
      const bookQuestions = questionStore.list({
        status: "all",
        bookId,
        includeMergedSources: true,
      }).questions;
      const questionById = new Map(bookQuestions.map((question) => [String(question.id || ""), question]));
      const structure = knowledgeStructureStore.get(bookId);
      const resolutionContext = classificationGoldKnowledgeResolutionContext(bookId, structure);
      const nodeById = new Map((structure?.nodes || []).map((node) => [String(node.id), node]));
      const materializeNode = (id, fallback = {}) => {
        const nodeId = String(id || fallback.id || fallback.nodeId || "");
        const node = nodeById.get(nodeId);
        return {
          id: nodeId,
          canonicalNodeId: String(fallback.canonicalNodeId || node?.canonicalNodeId || ""),
          aliasNodeIds: [...new Set([
            ...(Array.isArray(fallback.aliasNodeIds) ? fallback.aliasNodeIds : []),
            ...(Array.isArray(node?.aliasNodeIds) ? node.aliasNodeIds : []),
          ].map(String).filter(Boolean))],
          title: String(fallback.title || fallback.displayTitle || node?.displayTitle || node?.title || ""),
          path: String(fallback.path || fallback.knowledgePath || node?.path || ""),
          ...(node?.parentId ? { parentId: String(node.parentId) } : (fallback.parentId ? { parentId: String(fallback.parentId) } : {})),
        };
      };
      const familyOption = (family) => {
        const coreId = family.coreKnowledgeNodeId || family.knowledgeNodeId || "";
        const coreKnowledge = materializeNode(coreId, family.coreKnowledge || {
          id: coreId,
          title: family.primaryKnowledgePoint,
          path: family.knowledgePath,
        });
        const requiredIds = [...new Set((family.requiredKnowledgeNodeIds || []).map(String).filter(Boolean))];
        const anchorIds = [...new Set((family.textbookAnchorNodeIds || []).map(String).filter(Boolean))];
        const requiredKnowledge = requiredIds.map((id) => materializeNode(id,
          (family.requiredKnowledge || []).find((node) => String(node?.id || node?.nodeId || "") === id) || {},
        ));
        const textbookAnchors = anchorIds.map((id) => materializeNode(id,
          (family.textbookAnchors || []).find((node) => String(node?.id || node?.nodeId || "") === id) || {},
        ));
        return {
          id: family.id,
          version: family.version,
          formalFactSha256: classificationGoldFamilyFactSha256(
            classificationGoldFormalFamilyHashView(family, { question: { bookId } }, { questionById, resolutionContext }),
          ),
          name: family.name,
          status: family.status,
          bookId: family.bookId,
          knowledgeNodeId: family.knowledgeNodeId,
          knowledgePath: family.knowledgePath,
          primaryKnowledgePoint: family.primaryKnowledgePoint,
          coreKnowledgeNodeId: family.coreKnowledgeNodeId,
          coreKnowledge,
          requiredKnowledgeNodeIds: requiredIds,
          requiredKnowledge,
          textbookAnchorNodeIds: anchorIds,
          textbookAnchors,
          focusKey: family.focusKey || "",
          assessmentAction: family.assessmentAction || "",
          inclusionBoundary: family.inclusionBoundary || "",
          exclusionBoundary: family.exclusionBoundary || "",
          memberCount: family.members.length,
        };
      };
      sendJson(response, 200, {
        success: true,
        families: result.families.map(familyOption),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/question-families") {
      const bookId = url.searchParams.get("bookId") || "modern-chinese-7-1";
      const knowledgeNodeId = url.searchParams.get("knowledgeNodeId") || "";
      const query = String(url.searchParams.get("query") || "").trim();
      const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("zh-CN");
      const allBookQuestions = questionStore.list({ library: "official", status: "all", bookId }).questions;
      const matchedQuestionIds = new Set(normalizedQuery ? allBookQuestions.filter((question) => [
        question.id,
        question.stem,
        question.material,
        question.referenceAnswer,
        question.chapter,
        ...(question.knowledgePoints || []),
        ...(question.options || []).flatMap((option) => [option.key, option.text, `${option.key}. ${option.text}`]),
      ].filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase("zh-CN").includes(normalizedQuery))
        .map((question) => question.id) : []);
      const knowledgeNodeIds = knowledgeNodeId ? knowledgeStructureStore.descendants(bookId, knowledgeNodeId) : null;
      const result = questionFamilyStore.list({
        bookId,
        status: url.searchParams.get("status") || "all",
        query,
        matchingQuestionIds: matchedQuestionIds,
        knowledgeNodeIds,
      });
      const questionMap = new Map(allBookQuestions.map((question) => [question.id, question]));
      const currentStructure = knowledgeStructureStore.get(bookId);
      const knowledgeNodeMap = new Map((currentStructure?.nodes || []).map((node) => [node.id, node]));
      const fingerprintMap = new Map((currentStructure?.fingerprints || []).map((fingerprint) => [fingerprint.questionId, fingerprint]));
      const membershipMap = questionFamilyStore.memberships(allBookQuestions.map((question) => question.id), { bookId, status: "all" });
      const membershipRevisions = questionFamilyStore.membershipRevisions(allBookQuestions.map((question) => question.id));
      const activeBookQuestions = allBookQuestions.filter((question) => question.status !== "offline"
        && !question.mergedIntoQuestionId
        && !question.merge?.targetQuestionId);
      const catalogProjection = questionFamilyCatalogProjectionForBook(bookId);
      const confirmedTopicQuestionCount = activeBookQuestions
        .filter((question) => Boolean(catalogProjection.byQuestionId[question.id])).length;
      const catalogTreeSummary = buildQuestionFamilyCatalogTreeSummary({
        projection: catalogProjection,
        knowledgeNodes: currentStructure?.nodes || [],
        activeQuestionIds: new Set(activeBookQuestions.map((question) => question.id)),
        anchorField: "sourceAnchorNodeIds",
      });
      const pendingGroupingQuestionCount = activeBookQuestions.length - confirmedTopicQuestionCount;
      const familiesWithRelations = decorateFamiliesWithDynamicRelations(result.families);
      const familyQuestion = (question) => {
        if (!question) return null;
        // The catalog request already resolved the book's knowledge structure
        // above. Reusing it here avoids cloning/parsing the full tree once per
        // family member (which made the editor workspace several seconds slow).
        const decoratedQuestion = decorateQuestionKnowledgeFingerprint(question, currentStructure);
        return {
          id: decoratedQuestion.id,
          subjectId: decoratedQuestion.subjectId,
          bookId: decoratedQuestion.bookId,
          stem: decoratedQuestion.stem,
          options: decoratedQuestion.options || [],
          type: decoratedQuestion.type,
          typeLabel: decoratedQuestion.typeLabel,
          chapter: decoratedQuestion.chapter,
          primaryKnowledgePoint: decoratedQuestion.primaryKnowledgePoint,
          knowledgePoints: decoratedQuestion.knowledgePoints || [],
          knowledgeFingerprint: decoratedQuestion.knowledgeFingerprint,
          candidateKnowledgeFingerprint: decoratedQuestion.candidateKnowledgeFingerprint,
          knowledgeFingerprintStatus: decoratedQuestion.knowledgeFingerprintStatus,
          knowledgeFingerprintSignature: decoratedQuestion.knowledgeFingerprintSignature,
          difficultyStars: decoratedQuestion.difficultyStars,
          difficultyScore: decoratedQuestion.difficultyScore,
          maxScore: decoratedQuestion.maxScore,
          status: decoratedQuestion.status,
          answerReviewStatus: decoratedQuestion.answerReviewStatus,
          version: Number(decoratedQuestion.version) || 1,
          updatedAt: Number(decoratedQuestion.updatedAt) || Number(decoratedQuestion.createdAt) || 0,
          updatedBy: decoratedQuestion.updatedBy,
          library: decoratedQuestion.library,
          sourceLabel: decoratedQuestion.sourceLabel,
          sourcePage: decoratedQuestion.sourcePage,
          mergedIntoQuestionId: decoratedQuestion.mergedIntoQuestionId || "",
          merge: decoratedQuestion.merge || null,
          familyMemberships: membershipMap[question.id] || [],
        };
      };
      const allUngroupedQuestions = activeBookQuestions
        .filter((question) => !(membershipMap[question.id] || []).length);
      // 选中教材目录时，按「本题知识指纹是否落在该目录（含下级）内」筛选未成族题目，
      // 而不是直接清空列表。审核员需要在右侧直接看到本目录下还有几道题尚未成族，
      // 不必打开“编辑知识点”弹窗才知道。
      const inSelectedKnowledgeScope = (question) => {
        if (!knowledgeNodeIds) return true;
        const fingerprint = fingerprintMap.get(question.id);
        if (!fingerprint) return false;
        return [
          fingerprint.primaryNodeId,
          ...(fingerprint.requiredNodeIds || []),
          ...(fingerprint.auxiliaryNodeIds || []),
        ].filter(Boolean).some((nodeId) => knowledgeNodeIds.has(nodeId));
      };
      const ungroupedQuestions = (url.searchParams.get("status") || "all") === "all"
        ? allUngroupedQuestions.filter((question) => {
          if (normalizedQuery && !matchedQuestionIds.has(question.id)) return false;
          return inSelectedKnowledgeScope(question);
        }).sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt)).map(familyQuestion)
        : [];
      sendJson(response, 200, {
        success: true,
        summary: {
          ...result.summary,
          activeQuestionCount: activeBookQuestions.length,
          confirmedTopicQuestionCount,
          pendingGroupingQuestionCount,
          unresolvedQuestionCount: allUngroupedQuestions.length,
        },
        catalogTreeSummary: {
          bookId,
          ...catalogTreeSummary,
        },
        ungroupedQuestions,
        familySets: questionFamilySetsForBook(bookId).sets,
        families: familiesWithRelations.map((family) => {
          const members = family.members.map((member) => {
            const question = questionMap.get(member.questionId);
            const fingerprint = fingerprintMap.get(member.questionId) || null;
            const requiredKnowledgeNodeIds = fingerprint?.requiredNodeIds || [];
            const familyCoreNodeId = String(family.coreKnowledgeNodeId || family.knowledgeNodeId || "");
            const questionCoreNodeId = String(fingerprint?.primaryNodeId || "");
            const questionPrimaryNodeRole = fingerprint?.primaryNodeRole === "scope_anchor"
              ? "scope_anchor"
              : "core";
            const memberContributionNodeIds = [...new Set((Array.isArray(member.contributionKnowledgeNodeIds)
              ? member.contributionKnowledgeNodeIds : []).map(String).filter(Boolean))].sort();
            const usesMemberContribution = member.coverageRole !== "reference" && memberContributionNodeIds.length > 0;
            const familyRequiredNodeIds = usesMemberContribution
              ? memberContributionNodeIds
              : [...new Set([
                familyCoreNodeId,
                ...(family.requiredKnowledgeNodeIds || []),
              ].map(String).filter(Boolean))].sort();
            const questionRequiredNodeIds = [...new Set([
              ...(questionPrimaryNodeRole === "core" ? [questionCoreNodeId] : []),
              ...requiredKnowledgeNodeIds,
            ].map(String).filter(Boolean))].sort();
            const questionRequiredNodeIdSet = new Set(questionRequiredNodeIds);
            const missingFamilyKnowledgeNodeIds = familyRequiredNodeIds
              .filter((nodeId) => !questionRequiredNodeIdSet.has(nodeId));
            const extraQuestionKnowledgeNodeIds = member.isPrimary
              ? questionRequiredNodeIds.filter((nodeId) => !familyRequiredNodeIds.includes(nodeId))
              : [];
            const relationshipRole = member.isPrimary ? "topic" : "related";
            const sharedKnowledgeNodeIds = familyRequiredNodeIds.filter((nodeId) => questionRequiredNodeIdSet.has(nodeId));
            const contributionWithinQuestionKnowledge = familyRequiredNodeIds.length > 0
              && familyRequiredNodeIds.every((nodeId) => questionRequiredNodeIdSet.has(nodeId));
            const coreKnowledgeMatches = usesMemberContribution
              ? (questionPrimaryNodeRole === "scope_anchor"
                ? contributionWithinQuestionKnowledge
                : memberContributionNodeIds.includes(questionCoreNodeId))
              : (relationshipRole === "topic"
                ? Boolean(questionCoreNodeId && questionCoreNodeId === familyCoreNodeId)
                : Boolean(familyCoreNodeId && questionRequiredNodeIdSet.has(familyCoreNodeId)));
            const requiredKnowledgeMatches = usesMemberContribution
              ? contributionWithinQuestionKnowledge
              : (relationshipRole === "topic"
                ? familyRequiredNodeIds.length === questionRequiredNodeIds.length
                  && familyRequiredNodeIds.every((nodeId) => questionRequiredNodeIdSet.has(nodeId))
                : familyRequiredNodeIds.every((nodeId) => questionRequiredNodeIdSet.has(nodeId)));
            const questionAssessmentAction = String(fingerprint?.focus?.action || fingerprint?.action || "").trim();
            const familyAssessmentAction = String(family.assessmentAction || "").trim();
            const compactAction = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\u3400-\u9fffa-z0-9]/g, "");
            const actionMatches = Boolean(questionAssessmentAction && familyAssessmentAction
              && compactAction(questionAssessmentAction) === compactAction(familyAssessmentAction));
            const fingerprintReviewStatus = fingerprint?.status === "confirmed"
              ? "confirmed"
              : (fingerprint ? "suggested" : "missing");
            const knowledgeRoleConflict = Boolean(fingerprint && (
              usesMemberContribution
                ? (!coreKnowledgeMatches || !requiredKnowledgeMatches)
                : (member.isPrimary
                  ? (questionCoreNodeId !== familyCoreNodeId
                    || missingFamilyKnowledgeNodeIds.length
                    || extraQuestionKnowledgeNodeIds.length)
                  : missingFamilyKnowledgeNodeIds.length)
            ));
            const familyKnowledgeMismatch = fingerprintReviewStatus === "confirmed" && knowledgeRoleConflict;
            const compatibilityStatus = fingerprintReviewStatus === "confirmed"
              ? (knowledgeRoleConflict ? "incompatible" : "compatible")
              : (fingerprintReviewStatus === "suggested"
                ? (knowledgeRoleConflict ? "provisional_conflict" : "provisional_compatible")
                : "unassessed");
            const comparisonOverallStatus = fingerprintReviewStatus !== "confirmed"
              ? "unassessed"
              : (coreKnowledgeMatches && requiredKnowledgeMatches
                ? "compatible"
                : (sharedKnowledgeNodeIds.length ? "partial" : "incompatible"));
            return {
              ...member,
              membershipRevision: Math.max(0, Number(membershipRevisions[member.questionId]) || 0),
              knowledgeNodeId: questionCoreNodeId,
              primaryNodeRole: questionPrimaryNodeRole,
              knowledgePath: fingerprint?.knowledgePath || knowledgeNodeMap.get(fingerprint?.primaryNodeId)?.path || "",
              requiredKnowledgeNodeIds,
              requiredKnowledgeNodes: requiredKnowledgeNodeIds.map((id) => knowledgeNodeMap.get(id)).filter(Boolean),
              knowledgeSpan: fingerprint?.span || "single_point",
              knowledgeSource: fingerprint?.source || "",
              fingerprintReviewStatus,
              familyKnowledgeMismatch,
              familyKnowledgeCompatibility: {
                role: relationshipRole,
                status: compatibilityStatus,
                overallStatus: comparisonOverallStatus,
                fullyIncompatible: comparisonOverallStatus === "incompatible",
                missingFamilyKnowledgeNodeIds,
                extraQuestionKnowledgeNodeIds,
                sharedKnowledgeNodeIds,
                contributionKnowledgeNodeIds: memberContributionNodeIds,
                usesMemberContribution,
                items: {
                  coreKnowledge: {
                    status: fingerprintReviewStatus === "confirmed" ? (coreKnowledgeMatches ? "match" : "mismatch") : "unassessed",
                    questionNodeId: questionCoreNodeId,
                    familyNodeId: familyCoreNodeId,
                  },
                  requiredKnowledge: {
                    status: fingerprintReviewStatus !== "confirmed"
                      ? "unassessed"
                      : (requiredKnowledgeMatches ? "match" : (sharedKnowledgeNodeIds.length ? "partial" : "mismatch")),
                    questionNodeIds: questionRequiredNodeIds,
                    familyNodeIds: familyRequiredNodeIds,
                  },
                  assessmentAction: {
                    status: !questionAssessmentAction || !familyAssessmentAction
                      ? "unassessed"
                      : (actionMatches ? "match" : "review"),
                    questionValue: questionAssessmentAction,
                    familyValue: familyAssessmentAction,
                  },
                },
              },
              question: familyQuestion(question),
            };
          });
          return {
            ...family,
            knowledgePath: knowledgeNodeMap.get(family.knowledgeNodeId)?.path || family.knowledgePath,
            knowledgeLevel: Number(knowledgeNodeMap.get(family.knowledgeNodeId)?.knowledgeLevel ?? family.knowledgeLevel),
            coreKnowledgeNode: knowledgeNodeMap.get(family.coreKnowledgeNodeId) || null,
            requiredKnowledgeNodes: (family.requiredKnowledgeNodeIds || []).map((id) => knowledgeNodeMap.get(id)).filter(Boolean),
            textbookAnchorNodes: (family.textbookAnchorNodeIds || [family.knowledgeNodeId])
              .map((id) => knowledgeNodeMap.get(id)).filter(Boolean),
            members,
            matchedQuestions: normalizedQuery
              ? members.filter((member) => matchedQuestionIds.has(member.questionId)).map((member) => ({
                ...member.question,
                familyId: family.id,
                familyName: family.name,
                memberRole: member.role,
                trainingLevel: member.trainingLevel,
              }))
              : [],
          };
        }),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/question-families") {
      try {
        const payload = await readJsonBody(request);
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const structure = knowledgeStructureStore.get(bookId);
        if (!structure) throw new Error("knowledge_structure_not_found");
        const nodeById = new Map(structure.nodes.map((item) => [item.id, item]));
        const coreKnowledgeNodeId = String(payload.coreKnowledgeNodeId || payload.knowledgeNodeId || "");
        const requiredKnowledgeNodeIds = [...new Set((Array.isArray(payload.requiredKnowledgeNodeIds)
          ? payload.requiredKnowledgeNodeIds
          : [coreKnowledgeNodeId]).map(String).filter(Boolean))];
        const textbookAnchorNodeIds = [...new Set((Array.isArray(payload.textbookAnchorNodeIds) && payload.textbookAnchorNodeIds.length
          ? payload.textbookAnchorNodeIds
          : [payload.knowledgeNodeId || coreKnowledgeNodeId]).map(String).filter(Boolean))];
        const coreNode = nodeById.get(coreKnowledgeNodeId);
        const anchorNode = nodeById.get(textbookAnchorNodeIds[0]);
        if (!coreNode || !anchorNode || !requiredKnowledgeNodeIds.length
          || requiredKnowledgeNodeIds.some((nodeId) => !nodeById.has(nodeId))
          || textbookAnchorNodeIds.some((nodeId) => !nodeById.has(nodeId))) throw new Error("knowledge_node_not_found");
        if (coreNode.kind !== "knowledge"
          || requiredKnowledgeNodeIds.some((nodeId) => nodeById.get(nodeId)?.kind !== "knowledge")) {
          throw new Error("question_family_knowledge_required");
        }
        const questions = questionStore.list({ library: "official", status: "all", bookId }).questions;
        const questionIds = [...new Set((Array.isArray(payload.questionIds) ? payload.questionIds : []).map(String).filter(Boolean))].slice(0, 100);
        const selectedQuestions = questionIds.length ? questionStore.getMany(questionIds) : [];
        if (selectedQuestions.some((question) => mergedQuestionTargetId(question))) throw new Error("question_merged_source_read_only");
        if (selectedQuestions.some((question) => !question || question.library !== "official" || question.status === "offline")) {
          throw new Error("question_family_question_not_found");
        }
        if (selectedQuestions.some((question) => question.bookId !== bookId)) throw new Error("question_family_book_mismatch");
        let family = questionFamilyStore.create({
          ...payload,
          subjectId: questions[0]?.subjectId || "",
          bookId,
          knowledgeNodeId: anchorNode.id,
          coreKnowledgeNodeId: coreNode.id,
          requiredKnowledgeNodeIds,
          textbookAnchorNodeIds,
          chapter: anchorNode.path,
          primaryKnowledgePoint: coreNode.displayTitle || coreNode.title,
          knowledgePath: anchorNode.path,
          knowledgeLevel: coreNode.knowledgeLevel,
          orderIndex: structure.nodes.findIndex((item) => item.id === anchorNode.id) + 1,
        });
        let addedCount = 0;
        if (selectedQuestions.length) {
          const added = questionFamilyStore.addMembers(family.id, selectedQuestions, currentAdminDisplayName() || "超级管理员", {
            contributionKnowledgeNodeIdsByQuestion: payload.contributionKnowledgeNodeIdsByQuestion,
            coverageRoleByQuestion: payload.coverageRoleByQuestion,
          });
          family = added.family;
          addedCount = added.addedCount;
        }
        logOperation({
          action: selectedQuestions.length ? "question_family.create_with_members" : "question_family.create_empty",
          category: "question",
          targetType: "question_family",
          targetId: family.id,
          summary: selectedQuestions.length ? `创建题族“${family.name}”并加入 ${addedCount} 道题` : `创建空题族：${family.name}`,
          metadata: {
            bookId,
            coreKnowledgeNodeId,
            requiredKnowledgeNodeIds,
            textbookAnchorNodeIds,
            knowledgePath: anchorNode.path,
            questionIds,
          },
        });
        sendJson(response, 201, { success: true, family, addedCount });
      } catch (error) {
        const status = ["knowledge_structure_not_found", "knowledge_node_not_found"].includes(error.message) ? 404
          : (error.message === "question_merged_source_read_only" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/question-families/generate") {
      try {
        const payload = await readJsonBody(request).catch(() => ({}));
        const bookId = String(payload.bookId || "modern-chinese-7-1");
        const questions = questionStore.list({ library: "official", status: "all", bookId }).questions
          .filter((question) => question.status !== "offline");
        let structure = knowledgeStructureStore.get(bookId);
        if (!structure) {
          const textbook = textbookCatalogStore.get(bookId);
          const knowledge = textbookKnowledgeStore.get(bookId, { includeContent: true });
          structure = knowledgeStructureStore.generate({
            bookId,
            catalogNodes: textbook?.confirmed?.nodes || [],
            outlineNodes: textbookKnowledgeStore.outline(bookId),
            chunks: knowledge.chunks || [],
            questions,
          });
        }
        const fingerprintMap = new Map(structure.fingerprints.map((item) => [item.questionId, item]));
        const nodeOrder = new Map(structure.nodes.map((node, index) => [node.id, index + 1]));
        const result = questionFamilyStore.generate(questions, bookId, {
          fingerprintMap,
          nodeOrder,
          archiveReason: "knowledge_structure_regenerated",
          resetReviewFamilyIds: payload.resetFamilyIds,
        });
        logOperation({
          action: "question_family.generate",
          category: "question",
          targetType: "question_family_batch",
          targetId: bookId,
          summary: `为《现代汉语上册》生成 ${result.familyCount} 个待审核题族`,
          metadata: {
            bookId,
            questionCount: result.questionCount,
            groupedQuestionCount: result.groupedQuestionCount,
            unresolvedQuestionCount: result.unresolvedQuestionCount,
          },
        });
        sendJson(response, 200, { success: true, ...result, families: undefined });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    const questionFamilyMembersMatch = url.pathname.match(/^\/api\/admin\/question-families\/([^/]+)\/members$/);
    if (request.method === "POST" && questionFamilyMembersMatch) {
      try {
        const familyId = decodeURIComponent(questionFamilyMembersMatch[1]);
        const payload = await readJsonBody(request, 256 * 1024);
        const questionIds = [...new Set((Array.isArray(payload.questionIds) ? payload.questionIds : []).map(String).filter(Boolean))].slice(0, 100);
        if (!questionIds.length) throw new Error("question_family_questions_required");
        const questions = questionStore.getMany(questionIds);
        if (questions.some((question) => mergedQuestionTargetId(question))) throw new Error("question_merged_source_read_only");
        if (questions.some((question) => !question || question.library !== "official" || question.status === "offline")) {
          throw new Error("question_family_question_not_found");
        }
        const result = questionFamilyStore.addMembers(familyId, questions, currentAdminDisplayName() || "超级管理员", {
          contributionKnowledgeNodeIdsByQuestion: payload.contributionKnowledgeNodeIdsByQuestion,
          coverageRoleByQuestion: payload.coverageRoleByQuestion,
        });
        logOperation({
          action: "question_family.members_add",
          category: "question",
          targetType: "question_family",
          targetId: familyId,
          summary: `向题族“${result.family.name}”加入 ${result.addedCount} 道题`,
          metadata: { bookId: result.family.bookId, questionIds },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        const status = ["question_family_not_found", "question_family_question_not_found"].includes(error.message) ? 404
          : (error.message === "question_merged_source_read_only" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const questionFamilyMoveMembersMatch = url.pathname.match(/^\/api\/admin\/question-families\/([^/]+)\/move-members$/);
    if (request.method === "POST" && questionFamilyMoveMembersMatch) {
      try {
        const sourceFamilyId = decodeURIComponent(questionFamilyMoveMembersMatch[1]);
        const sourceFamily = questionFamilyStore.get(sourceFamilyId);
        if (!sourceFamily) throw new Error("question_family_not_found");
        const payload = await readJsonBody(request, 512 * 1024);
        const rawQuestionIds = Array.isArray(payload.questionIds) ? payload.questionIds : [];
        const questionIds = [...new Set(rawQuestionIds.map(String).filter(Boolean))];
        if (!questionIds.length) throw new Error("question_family_questions_required");
        if (questionIds.length > 100) throw new Error("question_family_move_too_many_questions");
        const questions = questionStore.getMany(questionIds);
        if (questions.some((question) => mergedQuestionTargetId(question))) throw new Error("question_merged_source_read_only");
        if (questions.some((question) => !question || question.library !== "official" || question.status === "offline")) {
          throw new Error("question_family_question_not_found");
        }

        const target = payload.target && typeof payload.target === "object" ? payload.target : {};
        let movePayload;
        if (target.mode === "existing") {
          movePayload = { questionIds, targetFamilyId: String(target.familyId || "") };
        } else if (target.mode === "new") {
          const structure = knowledgeStructureStore.get(sourceFamily.bookId);
          if (!structure) throw new Error("knowledge_structure_not_found");
          const knowledgeNodeId = String(target.knowledgeNodeId || "");
          const node = structure.nodes.find((item) => item.id === knowledgeNodeId);
          if (!node) throw new Error("knowledge_node_not_found");
          if (node.kind !== "knowledge") throw new Error("question_family_knowledge_required");
          movePayload = {
            questionIds,
            prototypeQuestionId: String(target.prototypeQuestionId || ""),
            targetFamily: {
              subjectId: sourceFamily.subjectId,
              bookId: sourceFamily.bookId,
              chapter: node.path,
              primaryKnowledgePoint: node.displayTitle || node.title,
              knowledgeNodeId: node.id,
              knowledgePath: node.path,
              knowledgeLevel: node.knowledgeLevel,
              orderIndex: structure.nodes.findIndex((item) => item.id === node.id) + 1,
              name: String(target.name || ""),
              focusKey: String(target.focusKey || target.name || ""),
            },
          };
        } else {
          throw new Error("question_family_move_target_required");
        }

        const result = questionFamilyStore.moveMembers(sourceFamilyId, movePayload, questions, currentAdminDisplayName() || "超级管理员");
        logOperation({
          action: result.targetCreated ? "question_family.create_and_move_members" : "question_family.members_move",
          category: "question",
          targetType: "question_family",
          targetId: result.targetFamily.id,
          summary: `${result.targetCreated ? "新建" : "移动到"}题族“${result.targetFamily.name}”并迁移 ${result.movedCount} 道题`,
          metadata: {
            bookId: result.targetFamily.bookId,
            sourceFamilyId: result.sourceFamily.id,
            targetFamilyId: result.targetFamily.id,
            questionIds: result.movedQuestionIds,
            primaryTransferredQuestionIds: result.primaryTransferredQuestionIds,
            alreadyInTargetQuestionIds: result.alreadyInTargetQuestionIds,
            targetCreated: result.targetCreated,
          },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        const notFound = [
          "question_family_not_found",
          "question_family_question_not_found",
          "knowledge_structure_not_found",
          "knowledge_node_not_found",
        ].includes(error.message);
        const conflict = [
          "question_family_member_not_found",
          "question_family_move_target_same",
          "question_family_rejected",
          "question_family_duplicate",
          "question_merged_source_read_only",
        ].includes(error.message);
        sendJson(response, notFound ? 404 : (conflict ? 409 : 422), { success: false, error: error.message });
      }
      return;
    }

    const questionFamilyMemberReviewMatch = url.pathname.match(/^\/api\/admin\/question-families\/([^/]+)\/members\/([^/]+)\/review$/);
    if (request.method === "PUT" && questionFamilyMemberReviewMatch) {
      try {
        const familyId = decodeURIComponent(questionFamilyMemberReviewMatch[1]);
        const questionId = decodeURIComponent(questionFamilyMemberReviewMatch[2]);
        const payload = await readJsonBody(request, 64 * 1024);
        const result = questionFamilyStore.reviewMember(familyId, questionId, payload, currentAdminDisplayName() || "超级管理员");
        // The gold-review page already has the family catalog in memory.  A
        // member review changes the catalog's formal hash, so return the new
        // hash with this mutation and let the client update that one entry
        // instead of reserializing the entire textbook catalog.
        const formalFactSha256 = result.family
          ? classificationGoldFamilyFactSha256(
            classificationGoldFormalFamilyHashView(result.family, {
              question: { bookId: result.family.bookId },
            }),
          )
          : "";
        if (result.affectedQuestionIds.length) {
          logOperation({
            action: result.decision === "confirmed"
              ? "question_family.member_confirmed"
              : "question_family.member_rejected",
            category: "question",
            targetType: "question_family_member",
            targetId: `${familyId}:${questionId}`,
            summary: result.decision === "confirmed"
              ? `确认题目 ${questionId} 归属于题族“${result.family.name}”`
              : `驳回题目 ${questionId} 归属于题族“${result.family.name}”`,
            metadata: {
              bookId: result.family.bookId,
              familyId: result.family.id,
              questionId,
              decision: result.decision,
              previousReviewStatus: result.previousMember.reviewStatus,
              isPrimary: result.previousMember.isPrimary,
              role: result.previousMember.role,
              expectedRevision: Number(payload.expectedRevision),
              previousMembershipRevision: Number(payload.expectedRevision),
              membershipRevision: result.membershipRevision,
              affectedQuestionIds: result.affectedQuestionIds,
              membershipRevisions: result.membershipRevisions,
              note: String(payload.note || "").slice(0, 1000),
            },
          });
        }
        sendJson(response, 200, { success: true, ...result, formalFactSha256 });
      } catch (error) {
        sendJson(response, questionFamilyMemberReviewErrorStatus(error), { success: false, error: error.message });
      }
      return;
    }

    const questionFamilyMemberMatch = url.pathname.match(/^\/api\/admin\/question-families\/([^/]+)\/members\/([^/]+)$/);
    if (request.method === "DELETE" && questionFamilyMemberMatch) {
      try {
        const familyId = decodeURIComponent(questionFamilyMemberMatch[1]);
        const questionId = decodeURIComponent(questionFamilyMemberMatch[2]);
        const result = questionFamilyStore.removeMember(familyId, questionId, currentAdminDisplayName() || "超级管理员");
        logOperation({
          action: "question_family.member_remove",
          category: "question",
          targetType: "question_family",
          targetId: familyId,
          summary: `从题族“${result.family.name}”移除题目 ${questionId}`,
          metadata: { bookId: result.family.bookId, questionId },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        const status = ["question_family_not_found", "question_family_member_not_found"].includes(error.message) ? 404 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const questionFamilyRelocateMatch = url.pathname.match(/^\/api\/admin\/question-families\/([^/]+)\/relocate$/);
    if (request.method === "PUT" && questionFamilyRelocateMatch) {
      try {
        const familyId = decodeURIComponent(questionFamilyRelocateMatch[1]);
        const payload = await readJsonBody(request, 512 * 1024);
        const current = questionFamilyStore.get(familyId);
        if (!current) throw new Error("question_family_not_found");
        const structure = knowledgeStructureStore.get(current.bookId);
        if (!structure) throw new Error("knowledge_structure_not_found");
        const nodeById = new Map(structure.nodes.map((item) => [item.id, item]));
        const knowledgeNodeId = String(payload.knowledgeNodeId || "");
        const textbookAnchorNodeIds = [...new Set((Array.isArray(payload.textbookAnchorNodeIds) && payload.textbookAnchorNodeIds.length
          ? [knowledgeNodeId, ...payload.textbookAnchorNodeIds]
          : [knowledgeNodeId]).map(String).filter(Boolean))];
        const coreKnowledgeNodeId = String(payload.backendDirectoryAnchorNodeId
          || payload.scopeAnchorNodeId
          || payload.coreKnowledgeNodeId
          || current.backendDirectoryAnchorNodeId
          || current.coreKnowledgeNodeId
          || current.knowledgeNodeId
          || "");
        const requiredKnowledgeNodeIds = [...new Set((Array.isArray(payload.requiredKnowledgeNodeIds)
          ? payload.requiredKnowledgeNodeIds
          : current.requiredKnowledgeNodeIds || []).map(String).filter(Boolean))];
        const node = nodeById.get(knowledgeNodeId);
        if (!node || !requiredKnowledgeNodeIds.length
          || textbookAnchorNodeIds.some((nodeId) => !nodeById.has(nodeId))
          || requiredKnowledgeNodeIds.some((nodeId) => !nodeById.has(nodeId))) throw new Error("knowledge_node_not_found");
        if (nodeById.get(coreKnowledgeNodeId)?.kind !== "knowledge"
          || requiredKnowledgeNodeIds.some((nodeId) => nodeById.get(nodeId)?.kind !== "knowledge")) {
          throw new Error("question_family_knowledge_required");
        }
        const containingSets = typeof questionFamilyStore.setsForFamily === "function" ? questionFamilyStore.setsForFamily(current.id) : [];
        if (containingSets.some((familySet) => {
          const allowed = knowledgeStructureStore.descendants(current.bookId, familySet.knowledgeNodeId);
          return textbookAnchorNodeIds.some((nodeId) => !allowed.has(nodeId));
        })) {
          throw new Error("question_family_set_scope_mismatch");
        }
        const result = questionFamilyStore.relocate(familyId, {
          ...payload,
          knowledgeNodeId: node.id,
          coreKnowledgeNodeId,
          requiredKnowledgeNodeIds,
          textbookAnchorNodeIds,
          chapter: node.path,
          primaryKnowledgePoint: node.displayTitle || node.title,
          knowledgePath: node.path,
          knowledgeLevel: node.knowledgeLevel,
          orderIndex: structure.nodes.findIndex((item) => item.id === node.id) + 1,
        }, currentAdminDisplayName() || "超级管理员");
        logOperation({
          action: "question_family.relocate",
          category: "question",
          targetType: "question_family",
          targetId: result.family.id,
          summary: `整体移动题族“${result.family.name}”至 ${result.family.knowledgePath}`,
          metadata: {
            bookId: result.family.bookId,
            previousKnowledgeNodeId: result.previousKnowledgeNodeId,
            knowledgeNodeId: result.family.knowledgeNodeId,
            memberCount: result.family.members.length,
          },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        const status = ["question_family_not_found", "knowledge_structure_not_found", "knowledge_node_not_found"].includes(error.message)
          ? 404
          : (error.message === "question_family_set_scope_mismatch" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const questionFamilyMatch = url.pathname.match(/^\/api\/admin\/question-families\/([^/]+)$/);
    if (request.method === "DELETE" && questionFamilyMatch) {
      try {
        const familyId = decodeURIComponent(questionFamilyMatch[1]);
        const result = questionFamilyStore.remove(familyId, currentAdminDisplayName() || "超级管理员");
        logOperation({
          action: "question_family.delete",
          category: "question",
          targetType: "question_family",
          targetId: familyId,
          summary: `删除题族“${result.family.name}”`,
          metadata: {
            bookId: result.family.bookId,
            knowledgeNodeId: result.family.knowledgeNodeId,
            memberCount: result.removedQuestionIds.length,
            ungroupedQuestionCount: result.ungroupedQuestionIds.length,
            promotedPrimaryQuestionCount: result.promotedPrimaryQuestionIds.length,
          },
        });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, error.message === "question_family_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }
    if (request.method === "PUT" && questionFamilyMatch) {
      try {
        const familyId = decodeURIComponent(questionFamilyMatch[1]);
        const payload = await readJsonBody(request, 512 * 1024);
        const current = questionFamilyStore.get(familyId);
        if (!current) throw new Error("question_family_not_found");
        const structure = knowledgeStructureStore.get(current.bookId);
        if (!structure) throw new Error("knowledge_structure_not_found");
        const nodeById = new Map(structure.nodes.map((item) => [item.id, item]));
        const coreKnowledgeNodeId = String(payload.backendDirectoryAnchorNodeId
          || payload.scopeAnchorNodeId
          || payload.coreKnowledgeNodeId
          || current.backendDirectoryAnchorNodeId
          || current.coreKnowledgeNodeId
          || current.knowledgeNodeId
          || "");
        const requiredKnowledgeNodeIds = [...new Set((Array.isArray(payload.requiredKnowledgeNodeIds)
          ? payload.requiredKnowledgeNodeIds
          : current.requiredKnowledgeNodeIds || []).map(String).filter(Boolean))];
        const requestedAnchorNodeIds = Array.isArray(payload.textbookAnchorNodeIds)
          ? payload.textbookAnchorNodeIds
          : current.textbookAnchorNodeIds || [current.knowledgeNodeId];
        const knowledgeNodeId = String(payload.userDirectoryAnchorNodeId
          || payload.locationNodeId
          || payload.knowledgeNodeId
          || requestedAnchorNodeIds[0]
          || current.userDirectoryAnchorNodeId
          || current.knowledgeNodeId
          || "");
        const textbookAnchorNodeIds = [...new Set([knowledgeNodeId, ...requestedAnchorNodeIds].map(String).filter(Boolean))];
        const node = nodeById.get(knowledgeNodeId);
        if (!nodeById.has(coreKnowledgeNodeId)
          || !node
          || !requiredKnowledgeNodeIds.length
          || requiredKnowledgeNodeIds.some((nodeId) => !nodeById.has(nodeId))
          || textbookAnchorNodeIds.some((nodeId) => !nodeById.has(nodeId))) throw new Error("knowledge_node_not_found");
        if (nodeById.get(coreKnowledgeNodeId)?.kind !== "knowledge"
          || requiredKnowledgeNodeIds.some((nodeId) => nodeById.get(nodeId)?.kind !== "knowledge")) {
          throw new Error("question_family_knowledge_required");
        }
        const locationChanged = knowledgeNodeId !== current.knowledgeNodeId
          || JSON.stringify(textbookAnchorNodeIds) !== JSON.stringify(current.textbookAnchorNodeIds);
        if (locationChanged) {
          const containingSets = typeof questionFamilyStore.setsForFamily === "function"
            ? questionFamilyStore.setsForFamily(current.id)
            : [];
          if (containingSets.some((familySet) => {
            const allowed = knowledgeStructureStore.descendants(current.bookId, familySet.knowledgeNodeId);
            return textbookAnchorNodeIds.some((nodeId) => !allowed.has(nodeId));
          })) {
            throw new Error("question_family_set_scope_mismatch");
          }
        }
        payload.coreKnowledgeNodeId = coreKnowledgeNodeId;
        payload.backendDirectoryAnchorNodeId = coreKnowledgeNodeId;
        payload.scopeAnchorNodeId = coreKnowledgeNodeId;
        payload.requiredKnowledgeNodeIds = requiredKnowledgeNodeIds;
        payload.textbookAnchorNodeIds = textbookAnchorNodeIds;
        payload.knowledgeNodeId = knowledgeNodeId;
        payload.userDirectoryAnchorNodeId = knowledgeNodeId;
        payload.locationNodeId = knowledgeNodeId;
        payload.chapter = node.path;
        payload.primaryKnowledgePoint = node.displayTitle || node.title;
        payload.knowledgePath = node.path;
        payload.knowledgeLevel = node.knowledgeLevel;
        payload.orderIndex = structure.nodes.findIndex((item) => item.id === node.id) + 1;
        const family = questionFamilyStore.review(familyId, payload, currentAdminDisplayName() || "超级管理员");
        logOperation({
          action: `question_family.${family.status}`,
          category: "question",
          targetType: "question_family",
          targetId: family.id,
          summary: `${family.status === "confirmed" ? "确认" : (family.status === "rejected" ? "驳回" : "重置")}${locationChanged ? "并移动" : ""}题族：${family.name}`,
          metadata: {
            bookId: family.bookId,
            memberCount: family.members.length,
            confidence: family.confidence,
            locationChanged,
            previousKnowledgeNodeId: current.knowledgeNodeId,
            knowledgeNodeId: family.knowledgeNodeId,
            coreKnowledgeNodeId: family.coreKnowledgeNodeId,
            requiredKnowledgeNodeIds: family.requiredKnowledgeNodeIds,
            textbookAnchorNodeIds: family.textbookAnchorNodeIds,
          },
        });
        sendJson(response, 200, { success: true, family });
      } catch (error) {
        const status = ["question_family_not_found", "knowledge_structure_not_found", "knowledge_node_not_found"].includes(error.message)
          ? 404
          : (error.message === "question_family_set_scope_mismatch" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/textbooks") {
      const result = textbookCatalogStore.list();
      const textbooks = result.textbooks.map((textbook) => ({
        ...textbook,
        knowledge: { ...textbookKnowledgeStore.get(textbook.bookId), active: activeKnowledgeBuilds.has(textbook.bookId) },
      }));
      sendJson(response, 200, {
        success: true,
        textbooks,
        counts: {
          ...result.counts,
          knowledgeReady: textbooks.filter((textbook) => ["ready", "partial"].includes(textbook.knowledge.status)).length,
          knowledgeBuilding: textbooks.filter((textbook) => textbook.knowledge.active || textbook.knowledge.status === "building").length,
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/exams") {
      const result = examStore.list({ query: url.searchParams.get("query") || "", status: url.searchParams.get("status") || "all", kind: url.searchParams.get("kind") || "all" });
      const allExams = withExamAnswerReviews(examStore.list().exams);
      const reviewedById = new Map(allExams.map((exam) => [exam.id, exam]));
      const exams = result.exams.map((exam) => reviewedById.get(exam.id)).filter(Boolean);
      sendJson(response, 200, {
        success: true,
        ...result,
        exams,
        counts: {
          ...result.counts,
          needsFullReview: allExams.filter((exam) => exam.answerReviewSummary.status === "needs_full_review").length,
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/exams/imports") {
      sendJson(response, 200, { success: true, drafts: examImportStore.list() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/exams/import-jobs") {
      const jobs = aiTaskStore.list({ sceneId: "exam_paper_extraction", limit: 200 })
        .filter((task) => task.inputSummary && task.inputSummary.backgroundImport === true);
      sendJson(response, 200, { success: true, jobs });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/exams/import-jobs") {
      let job = null;
      try {
        const upload = await readExamMultipart(request);
        const config = aiConfigStore.load();
        const route = config.routes.exam_paper_extraction;
        const provider = route && route.mode === "provider"
          ? config.providers.find((item) => item.id === route.providerId && item.enabled)
          : null;
        if (!provider) throw new Error("exam_extraction_route_unavailable");
        const paperFile = upload.files.paper;
        const answerFile = upload.files.answer || null;
        job = aiTaskStore.start(aiTaskMetadata(config, "exam_paper_extraction", {}, {
          streaming: true,
          inputSummary: {
            backgroundImport: true,
            stage: "queued",
            percent: 3,
            message: "文件已接收，等待后台识别",
            paperFileName: paperFile.fileName,
            paperMimeType: paperFile.mimeType,
            paperSize: paperFile.size,
            answerFileName: answerFile && answerFile.fileName || "",
            answerMimeType: answerFile && answerFile.mimeType || "",
            answerSize: answerFile && answerFile.size || 0,
            kind: upload.fields.kind || "official_mock",
            year: Number(upload.fields.year) || new Date().getFullYear(),
            autoSupplementAnswers: upload.fields.autoSupplementAnswers === "true",
            autoSupplementMetadata: upload.fields.autoSupplementMetadata === "true",
            runAttempt: 1,
            retryCount: 0,
            completedUnits: 0,
            totalUnits: 0,
          },
        }));
        saveExamJobFile(job.id, "paper", paperFile, examJobRoot);
        if (answerFile) saveExamJobFile(job.id, "answer", answerFile, examJobRoot);
        const baseUrl = `http://127.0.0.1:${request.socket.localPort}`;
        sendJson(response, 202, { success: true, job: aiTaskStore.get(job.id) });
        setImmediate(() => { startExamImportJob(job.id, baseUrl); });
      } catch (error) {
        if (job) {
          aiTaskStore.finish(job.id, { status: "failed", errorCode: error.message, failureStage: "exam_upload" });
          try { deleteExamJobFiles(job.id, examJobRoot); } catch (cleanupError) { /* preserve the original upload error */ }
        }
        const status = ["payload_too_large", "exam_file_too_large"].includes(error.message) ? 413
          : (error.message === "exam_extraction_route_unavailable" ? 503 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const adminExamImportJobRetryMatch = url.pathname.match(/^\/api\/admin\/exams\/import-jobs\/([^/]+)\/retry$/);
    if (request.method === "POST" && adminExamImportJobRetryMatch) {
      try {
        const id = decodeURIComponent(adminExamImportJobRetryMatch[1]);
        const current = aiTaskStore.get(id);
        if (!current || !current.inputSummary || current.inputSummary.backgroundImport !== true) throw new Error("exam_import_job_not_found");
        if (current.status === "running") throw new Error("exam_import_job_running");
        loadExamJobFile(id, "paper", current.inputSummary.paperFileName, current.inputSummary.paperMimeType, examJobRoot);
        const restarted = aiTaskStore.restart(id, {
          inputSummary: {
            stage: "queued",
            percent: 3,
            message: "正在重新识别",
            runAttempt: Number(current.inputSummary.runAttempt || 1) + 1,
            retryCount: 0,
            completedUnits: 0,
            totalUnits: 0,
          },
        });
        const baseUrl = `http://127.0.0.1:${request.socket.localPort}`;
        sendJson(response, 202, { success: true, job: restarted });
        setImmediate(() => { startExamImportJob(id, baseUrl); });
      } catch (error) {
        const status = error.message === "exam_import_job_not_found" ? 404 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && ["/api/admin/exams/import-pdf", "/api/admin/exams/import-files"].includes(url.pathname)) {
      let task = null;
      let backgroundTaskId = "";
      try {
        const isMultipart = url.pathname === "/api/admin/exams/import-files";
        const isDirectPdf = String(request.headers["content-type"] || "").startsWith("application/pdf");
        let payload;
        let paperFile;
        let answerFile = null;
        if (isMultipart) {
          const upload = await readExamMultipart(request);
          backgroundTaskId = String(upload.fields.backgroundTaskId || "");
          payload = {
            fileName: upload.files.paper.fileName,
            defaults: {
              kind: upload.fields.kind || "official_mock",
              year: Number(upload.fields.year) || new Date().getFullYear(),
              projectId: "gd-zsb-2026-hywxxkjc",
              durationMinutes: 120,
            },
          };
          paperFile = upload.files.paper;
          answerFile = upload.files.answer || null;
        } else {
          payload = isDirectPdf ? {
            fileName: url.searchParams.get("fileName") || "exam.pdf",
            defaults: {
              kind: url.searchParams.get("kind") || "official_mock",
              year: Number(url.searchParams.get("year")) || new Date().getFullYear(),
              projectId: "gd-zsb-2026-hywxxkjc",
              durationMinutes: 120,
            },
          } : await readJsonBody(request, 205 * 1024 * 1024);
          const buffer = isDirectPdf
            ? await readBufferBody(request)
            : Buffer.from(String(payload.dataBase64 || "").replace(/^data:application\/pdf;base64,/, ""), "base64");
          paperFile = { fileName: payload.fileName || "exam.pdf", mimeType: "application/pdf", size: buffer.length, buffer };
        }
        const buffer = paperFile.buffer;
        const extracted = await extractExamDocument(buffer, paperFile);
        const answerExtracted = answerFile ? await extractExamDocument(answerFile.buffer, answerFile) : null;
        const config = aiConfigStore.load();
        const chunks = [];
        for (let coreStart = 0; coreStart < extracted.pages.length; coreStart += 2) {
          const coreEnd = Math.min(extracted.pages.length, coreStart + 2);
          const contextStart = Math.max(0, coreStart - 1);
          const contextEnd = Math.min(extracted.pages.length, coreEnd + 1);
          chunks.push({ coreStart, coreEnd, contextStart, contextEnd });
        }
        const extractionSummary = {
          fileName: payload.fileName,
          format: extracted.format,
          size: buffer.length,
          pageCount: extracted.pageCount,
          textChars: extracted.textChars,
          chunkCount: chunks.length,
          answerFileName: answerFile && answerFile.fileName || "",
          answerFormat: answerExtracted && answerExtracted.format || "",
          stage: "recognizing_paper",
          percent: 10,
          message: `正在识别试卷分片 0 / ${chunks.length}`,
          completedUnits: 0,
          totalUnits: chunks.length,
        };
        if (backgroundTaskId) {
          task = aiTaskStore.get(backgroundTaskId);
          if (!task || task.status !== "running" || task.inputSummary?.backgroundImport !== true) throw new Error("exam_import_job_not_found");
          aiTaskStore.update(task.id, { inputSummary: extractionSummary });
          task = aiTaskStore.get(task.id);
        } else {
          task = aiTaskStore.start(aiTaskMetadata(config, "exam_paper_extraction", payload, {
            streaming: true,
            inputSummary: extractionSummary,
          }));
        }
        if (extracted.textChars < 80) throw new Error(extracted.format === "pdf" ? "exam_pdf_ocr_required" : "exam_docx_empty");
        const route = config.routes.exam_paper_extraction;
        const provider = route && route.mode === "provider"
          ? config.providers.find((item) => item.id === route.providerId && item.enabled)
          : null;
        if (!provider) throw new Error("exam_extraction_route_unavailable");
        const defaults = payload.defaults && typeof payload.defaults === "object" ? payload.defaults : {};
        const catalog = questionStore.catalog();
        const catalogContext = catalog.subjects.map((subject) => ({
          subjectId: subject.id,
          subjectName: subject.name,
          books: catalog.books.filter((book) => book.subjectId === subject.id).map((book) => {
            const textbook = textbookCatalogStore.get(book.id);
            const confirmedNodes = textbook && textbook.confirmed && textbook.confirmed.nodes || [];
            return {
              bookId: book.id,
              title: book.title,
              volume: book.volume,
              catalog: confirmedNodes.filter((node) => Number(node.level) <= 3).slice(0, 160).map((node) => ({
                level: node.level,
                title: node.title,
                knowledgePoints: (node.knowledgePoints || []).slice(0, 8),
              })),
            };
          }),
        }));
        const requiredOutput = {
          exam: { title: "试卷名称", description: "说明", year: new Date().getFullYear(), durationMinutes: 120, totalQuestionCount: "卷面声明的总题数" },
          sections: [{
            title: "题型分组名称",
            type: "single_choice|multiple_choice|true_false|fill_blank|punctuation|classical_word_explanation|translation|short_answer|term_definition|material_analysis|appreciation|essay",
            questions: [{
              number: "大题号",
              subNumber: "材料题小问号，没有则留空",
              materialGroupId: "同一共享材料使用相同且稳定的编号",
              material: "只放共享材料，不要把小问并入材料",
              materialMarks: [{ type: "underline|double_underline|wave|dot", text: "原卷中带该标记的完整文字", occurrence: 1 }],
              usesSharedMaterial: true,
              subjectId: "必须从可用目录选择",
              bookId: "必须从该科目教材中选择",
              stem: "独立题干或该材料下的一道小问",
              responseMode: "text|annotation，只有需要在原句上标记时使用 annotation",
              annotationText: "需要用户添加下划线、波浪线、着重号或下标点的原句",
              options: [{ key: "A", text: "选项" }],
              correctAnswer: [],
              referenceAnswer: "",
              answerSource: "pdf_answer|missing",
              scoringPoints: [],
              scoringPolicy: { mode: "double_choice_partial", oneCorrectScore: 1, allCorrectScore: 3, extraOptionScore: 0, emptyScore: 0 },
              maxScore: 1,
              chapter: "章·节·三级标题",
              knowledgePoints: ["知识点"],
              sourcePage: "1",
              confidence: 0.95,
              warnings: [],
            }],
          }],
          warnings: [],
        };
        let receivedFirstToken = false;
        const chunkResults = new Array(chunks.length);
        let nextChunkIndex = 0;
        let paperCompletedCount = 0;
        let chunkRetryCount = 0;
        const retryableExamChunkError = (error) => /output_format|invalid_json|empty_response|stream_incomplete|timeout|network|fetch failed|econn/i.test(String(error && error.message || error));
        const recognizeNextChunk = async () => {
          while (nextChunkIndex < chunks.length) {
            const chunkIndex = nextChunkIndex;
            nextChunkIndex += 1;
            const chunk = chunks[chunkIndex];
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              try {
                const retryInstruction = attempt > 1 ? `这是第 ${attempt} 次尝试。上次输出无法解析，请只输出完整 JSON 对象，不要解释、不要 Markdown、不要截断。` : "";
                const completion = await streamPromptWithProvider(
                  { ...provider, timeoutMs: Math.max(Number(provider.timeoutMs) || 30000, 300000) },
                  { ...route, reasoningEffort: "low", maxTokens: Math.min(Number(route.maxTokens) || 12000, 7000) },
                  config.prompts.exam_paper_extraction,
                  {
                    examMetadata: {
                      ...defaults,
                      projectId: catalog.project.id,
                      projectName: catalog.project.name,
                      fileName: payload.fileName,
                      scope: "五科九本综合试卷，每道题独立归类",
                      extractionInstruction: `当前只输出题号首次出现在第 ${chunk.coreStart + 1}-${chunk.coreEnd} 个页面或文档片段的题目；相邻内容仅用于补全跨页题干、选项或答案。共享材料与每个小问必须分开，同一材料的小问使用相同 materialGroupId，并分别输出得分点和分值；如果某一小问无需材料，设置 usesSharedMaterial=false。原卷材料中已有下划线、双下划线、波浪线或加点时，必须按该小问实际引用范围写入 materialMarks，type 分别使用 underline、double_underline、wave、dot，text 必须逐字取自 material。materialMarks 表示原卷已有标记；responseMode 和 annotationText 只表示用户需要在原句上作答，二者不得混用。现代汉语题若要求用户在原句添加下划线、波浪线、着重号、下标点或标点，设置 responseMode=annotation 并把待作答原句放入 annotationText。加点字词解释题不得归入古文翻译，题干必须写成“原文\\n加点字词：”，例如“孟尝君客我！\\n客：”；若着重号无法可靠识别，保留原文并在 warnings 标注“加点字词待核对”，不得猜测。试卷文件未明确提供答案时，correctAnswer、referenceAnswer 和 scoringPoints 必须留空并标记 answerSource=missing，禁止根据常识补答案。双选题若卷面声明少选部分得分，必须输出 scoringPolicy。${retryInstruction}`,
                    },
                    catalogContext,
                    pageRange: `核心页 ${chunk.coreStart + 1}-${chunk.coreEnd}；上下文页 ${chunk.contextStart + 1}-${chunk.contextEnd}`,
                    extractedText: examPagesForModel(extracted.pages.slice(chunk.contextStart, chunk.contextEnd), 120000, chunk.contextStart + 1),
                    requiredOutput,
                  },
                  {
                    onDelta() {
                      if (receivedFirstToken) return;
                      receivedFirstToken = true;
                      aiTaskStore.markFirstToken(task.id);
                    },
                  },
                );
                chunkResults[chunkIndex] = {
                  status: "fulfilled",
                  attempts: attempt,
                  completion,
                  recognized: normalizeExamModelOutput(parseJsonContent(completion.content), defaults),
                };
                break;
              } catch (error) {
                const shouldRetry = attempt < 3 && retryableExamChunkError(error);
                if (!shouldRetry) {
                  chunkResults[chunkIndex] = { status: "rejected", error, attempts: attempt };
                  break;
                }
                chunkRetryCount += 1;
                aiTaskStore.update(task.id, { inputSummary: { retryCount: chunkRetryCount, message: `第 ${chunk.coreStart + 1}-${chunk.coreEnd} 个页面或片段格式异常，正在自动重试 ${attempt - 1} / 2` } });
                await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
              }
            }
            paperCompletedCount += 1;
            aiTaskStore.update(task.id, { inputSummary: {
              stage: "recognizing_paper",
              percent: 10 + Math.round((paperCompletedCount / Math.max(1, chunks.length)) * 55),
              completedUnits: paperCompletedCount,
              totalUnits: chunks.length,
              retryCount: chunkRetryCount,
              message: `正在识别试卷分片 ${paperCompletedCount} / ${chunks.length}`,
            } });
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, () => recognizeNextChunk()));
        const completedChunks = chunkResults.filter((item) => item && item.status === "fulfilled");
        if (!completedChunks.length) throw (chunkResults.find((item) => item && item.error)?.error || new Error("provider_output_format_error"));
        let recognized = mergeExamRecognitions(completedChunks.map((item) => item.recognized));
        aiTaskStore.update(task.id, { inputSummary: { stage: "merging_paper", percent: 68, message: `试卷分片识别完成，已提取 ${recognized.questions.length} 个作答项` } });
        const answerCompletedChunks = [];
        let answerMergeSummary = { matchedCount: 0, ambiguousCount: 0, unmatchedCount: 0, missingAnswerCount: recognized.questions.length };
        if (answerExtracted) {
          const verbatimAnswerBlocks = extractVerbatimAnswerBlocks(answerExtracted.pages);
          const answerChunks = [];
          for (let start = 0; start < answerExtracted.pages.length; start += 6) {
            answerChunks.push({ start, end: Math.min(answerExtracted.pages.length, start + 6) });
          }
          const paperQuestionIndex = recognized.questions.map((question) => ({
            number: question.number,
            subNumber: question.subNumber,
            type: question.type,
            stem: String(question.stem || "").slice(0, 180),
            maxScore: question.maxScore,
          }));
          const answerMappingOutput = {
            exam: { title: "答案文件映射" },
            sections: [{
              title: "答案题号映射",
              type: "题型可留空",
              questions: [{
                number: "必须沿用试卷大题号",
                subNumber: "必须沿用试卷小题号，没有则留空",
                correctAnswer: ["仅选择题填写选项字母"],
                referenceAnswer: "从答案原文逐字复制一段不超过80字的识别指纹，不要概括",
                answerSource: "pdf_answer",
              }],
            }],
            warnings: [],
          };
          let answerCompletedCount = 0;
          const answerResults = await Promise.all(answerChunks.map(async (answerChunk) => {
            let result;
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              try {
                const retryInstruction = attempt > 1 ? `这是第 ${attempt} 次尝试，上次输出格式无效；只输出完整 JSON 对象。` : "";
                const completion = await streamPromptWithProvider(
                  { ...provider, timeoutMs: Math.max(Number(provider.timeoutMs) || 30000, 300000) },
                  { ...route, reasoningEffort: "low", maxTokens: Math.min(Math.max(Number(route.maxTokens) || 5000, 3500), 6000) },
                  config.prompts.exam_paper_extraction,
                  {
                    examMetadata: {
                      ...defaults,
                      projectId: catalog.project.id,
                      projectName: catalog.project.name,
                      fileName: answerFile.fileName,
                      sourceRole: "独立答案文件",
                      paperQuestionIndex,
                      extractionInstruction: `当前文件是与试卷分开的答案文件。你的任务仅是把答案原文块匹配到 paperQuestionIndex 的题号，不负责生成或转录完整答案。必须沿用 paperQuestionIndex 中的 number 和 subNumber；一道大题有多个小问时逐小问输出。referenceAnswer 只逐字复制对应答案开头一段不超过80字的原文作为匹配指纹，禁止概括、改写或输出完整长答案。选择题可填写 correctAnswer，其他字段留空。不要创建试卷中不存在的题目；没有明确对应关系的内容不要输出。answerSource 必须为 pdf_answer。${retryInstruction}`,
                    },
                    catalogContext: [],
                    pageRange: `答案文件片段 ${answerChunk.start + 1}-${answerChunk.end}`,
                    extractedText: examPagesForModel(answerExtracted.pages.slice(answerChunk.start, answerChunk.end), 120000, answerChunk.start + 1),
                    requiredOutput: answerMappingOutput,
                  },
                  { onDelta() {} },
                );
                result = {
                  status: "fulfilled",
                  attempts: attempt,
                  completion,
                  recognized: normalizeExamModelOutput(parseJsonContent(completion.content), defaults),
                };
                answerCompletedChunks.push(result);
                break;
              } catch (error) {
                const shouldRetry = attempt < 3 && retryableExamChunkError(error);
                if (!shouldRetry) { result = { status: "rejected", error, answerChunk, attempts: attempt }; break; }
                chunkRetryCount += 1;
                aiTaskStore.update(task.id, { inputSummary: { retryCount: chunkRetryCount, message: `答案片段 ${answerChunk.start + 1}-${answerChunk.end} 格式异常，正在自动重试 ${attempt - 1} / 2` } });
                await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
              }
            }
            answerCompletedCount += 1;
            aiTaskStore.update(task.id, { inputSummary: {
              stage: "recognizing_answer",
              percent: 70 + Math.round((answerCompletedCount / Math.max(1, answerChunks.length)) * 16),
              completedUnits: answerCompletedCount,
              totalUnits: answerChunks.length,
              retryCount: chunkRetryCount,
              message: `正在识别独立答案 ${answerCompletedCount} / ${answerChunks.length}`,
            } });
            return result;
          }));
          const completedAnswers = answerResults.filter((item) => item.status === "fulfilled");
          if (completedAnswers.length) {
            const mergedAnswers = mergeAnswerRecognitions(
              recognized,
              completedAnswers.map((item) => item.recognized),
              { verbatimOfficialOnly: true },
            );
            recognized = mergedAnswers.recognition;
            answerMergeSummary = mergedAnswers;
            const verbatimRecovery = applyVerbatimAnswerBlocks(recognized, verbatimAnswerBlocks);
            recognized = verbatimRecovery.recognition;
            answerMergeSummary.verbatimRecoveredCount = verbatimRecovery.recoveredCount;
            answerMergeSummary.verbatimMatchedCount = verbatimRecovery.matchedCount;
          } else {
            recognized.warnings.push("独立答案文件未能识别，试卷题目已保留，请人工补充答案");
          }
          const sequentialRecovery = applySequentialObjectiveAnswerSections(recognized, answerExtracted.pages);
          recognized = sequentialRecovery.recognition;
          answerMergeSummary.sequentialRecoveredCount = sequentialRecovery.recoveredCount;
          answerMergeSummary.sourceRecoveredCount = (Number(answerMergeSummary.verbatimRecoveredCount) || 0) + sequentialRecovery.recoveredCount;
          aiTaskStore.update(task.id, { inputSummary: {
            stage: "matching_answers",
            percent: 88,
            message: `独立答案原文已恢复 ${answerMergeSummary.sourceRecoveredCount} 道`,
          } });
          answerResults.filter((item) => item.status === "rejected").forEach((item) => {
            recognized.warnings.push(`答案文件片段 ${item.answerChunk.start + 1}-${item.answerChunk.end} 识别失败：${item.error.message}`);
          });
        }
        recognized.metadata.description = String(recognized.metadata.description || "")
          .replace(/[；;，,]?当前(?:只输出|仅录入)[\s\S]*$/u, "")
          .trim();
        if (answerExtracted && /未提供(?:独立)?答案文件|答案文件(?:缺失|未提供)/u.test(recognized.metadata.description)) {
          const description = recognized.metadata.description
            .replace(/[；;，,]?未提供(?:独立)?答案文件[^。！？]*[。！？]?/gu, "")
            .replace(/[；;，,]?答案文件(?:缺失|未提供)[^。！？]*[。！？]?/gu, "")
            .trim();
          recognized.metadata.description = `${description}${description && !/[。！？]$/u.test(description) ? "。" : ""}已上传独立答案文件，系统已按题号与题型顺序配对，仍需人工校对。`;
        }
        chunkResults.forEach((item, index) => {
          if (item && item.status === "fulfilled") return;
          const chunk = chunks[index];
          recognized.warnings.push(`第 ${chunk.coreStart + 1}-${chunk.coreEnd} 页识别失败：${item && item.error ? item.error.message : "unknown_error"}`);
        });
        recognized.questions = recognized.questions.map((question) => {
          const rawSubject = String(question.subjectId || "").trim();
          const subject = catalog.subjects.find((item) => item.id === rawSubject || item.name === rawSubject);
          const rawBook = String(question.bookId || "").trim();
          const bookMatches = catalog.books.filter((item) => (!subject || item.subjectId === subject.id)
            && (item.id === rawBook || `${item.title}${item.volume ? ` · ${item.volume}` : ""}` === rawBook || `${item.title}${item.volume || ""}` === rawBook));
          const book = bookMatches.length === 1 ? bookMatches[0] : null;
          const warnings = [...(question.warnings || [])];
          if (!subject) warnings.push("科目未可靠识别，请人工选择");
          if (!book) warnings.push("教材未可靠识别，请人工选择");
          return { ...question, subjectId: subject ? subject.id : "", bookId: book ? book.id : "", warnings };
        });
        recognized.questions = recognized.questions.map((question) => {
          if (!question.bookId) return question;
          const resolution = resolveTextbookContext(question);
          if (!resolution.changed || !resolution.highConfidence || !resolution.book) {
            if (!resolution.invalidCurrentChapter) return question;
            return {
              ...question,
              warnings: [...new Set([...(question.warnings || []), "章节路径不属于当前教材，教材页码与得分点依据暂不可信，请重新选择教材或章节"])],
              scoringPoints: (question.scoringPoints || []).map((point) => ({
                ...point,
                textbookPage: "",
                pageBasis: "",
                sourceNote: "",
              })),
            };
          }
          const previousBook = catalog.books.find((item) => item.id === question.bookId);
          return {
            ...question,
            subjectId: resolution.book.subjectId,
            bookId: resolution.book.id,
            chapter: resolution.chapterNode && resolution.chapterNode.path || "",
            scoringPoints: (question.scoringPoints || []).map((point) => ({
              ...point,
              textbookPage: "",
              pageBasis: "",
              sourceNote: "",
            })),
            warnings: [...new Set([
              ...(question.warnings || []),
              `检测到具体作品在《${resolution.book.title}》中有更充分的直接论述，已由《${previousBook && previousBook.title || question.bookId}》调整教材归属，请人工复核`,
            ])],
          };
        });
        aiTaskStore.update(task.id, { inputSummary: { stage: "saving_draft", percent: 90, message: "正在保存待校对草稿" } });
        const draft = examImportStore.create({
          ...recognized,
          source: {
            fileName: payload.fileName,
            format: extracted.format,
            size: buffer.length,
            pageCount: extracted.pageCount,
            textChars: extracted.textChars,
            answerFileName: answerFile && answerFile.fileName || "",
            answerFormat: answerExtracted && answerExtracted.format || "",
            answerSize: answerFile && answerFile.buffer.length || 0,
            answerPageCount: answerExtracted && answerExtracted.pageCount || 0,
            answerTextChars: answerExtracted && answerExtracted.textChars || 0,
            answerMatchedCount: Number(answerMergeSummary.sourceRecoveredCount) || Number(answerMergeSummary.verbatimRecoveredCount) || 0,
            model: [...new Set([...completedChunks, ...answerCompletedChunks].map((item) => item.completion.model))].join(", "),
          },
        }, currentAdminDisplayName() || "超级管理员");
        try {
          await saveStoredExamSourceFile(draft.id, "paper", paperFile.fileName, paperFile.buffer);
          if (answerFile) await saveStoredExamSourceFile(draft.id, "answer", answerFile.fileName, answerFile.buffer);
        } catch (error) {
          await deleteStoredExamSourceFiles(draft.id, { fileName: paperFile.fileName, answerFileName: answerFile && answerFile.fileName || "" }).catch(() => undefined);
          try { examImportStore.remove(draft.id); } catch { /* keep the storage error as the API response */ }
          throw error;
        }
        aiTaskStore.update(task.id, { inputSummary: { stage: "draft_ready", percent: 92, message: "识别草稿已生成", draftId: draft.id, questionCount: draft.questions.length } });
        const preview = examImportPreview(draft);
        const allCompletedChunks = [...completedChunks, ...answerCompletedChunks];
        const usage = allCompletedChunks.reduce((total, item) => ({
          prompt_tokens: total.prompt_tokens + Number(item.completion.usage && (item.completion.usage.prompt_tokens ?? item.completion.usage.input_tokens) || 0),
          completion_tokens: total.completion_tokens + Number(item.completion.usage && (item.completion.usage.completion_tokens ?? item.completion.usage.output_tokens) || 0),
          total_tokens: total.total_tokens + Number(item.completion.usage && item.completion.usage.total_tokens || 0),
        }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        if (!backgroundTaskId) aiTaskStore.finish(task.id, { status: "succeeded", chargeable: false, usage, outputChars: allCompletedChunks.reduce((total, item) => total + item.completion.content.length, 0) });
        logOperation({
          action: "exam_import.recognize",
          category: "exam",
          targetType: "exam_import",
          targetId: draft.id,
          summary: `识别试卷文件：${payload.fileName || draft.metadata.title}`,
          metadata: { questionCount: draft.questions.length, pageCount: extracted.pageCount, format: extracted.format, answerFileName: draft.source.answerFileName, answerMatchedCount: draft.source.answerMatchedCount, model: draft.source.model, chunkCount: chunks.length, completedChunks: completedChunks.length, warningCount: draft.warnings.length },
        });
        sendJson(response, 201, { success: true, draft, preview });
      } catch (error) {
        if (task) aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "exam_paper_extraction" });
        const normalizedError = error.message === "textbook_pdf_invalid" ? "exam_pdf_invalid"
          : (error.message === "textbook_pdf_too_large" ? "exam_pdf_too_large"
            : (error.message === "provider_timeout" ? "exam_extraction_timeout" : error.message));
        const status = ["payload_too_large", "exam_pdf_too_large", "exam_file_too_large"].includes(normalizedError) ? 413
          : (normalizedError === "exam_extraction_route_unavailable" ? 503 : 422);
        sendJson(response, status, { success: false, error: normalizedError });
      }
      return;
    }

    const adminExamImportMatch = url.pathname.match(/^\/api\/admin\/exams\/imports\/([^/]+)$/);
    const adminExamOfficialAnswerRecoveryMatch = url.pathname.match(/^\/api\/admin\/exams\/imports\/([^/]+)\/recover-official-answers$/);
    if (request.method === "POST" && adminExamOfficialAnswerRecoveryMatch) {
      try {
        const importId = decodeURIComponent(adminExamOfficialAnswerRecoveryMatch[1]);
        const draft = examImportStore.get(importId);
        if (!draft) throw new Error("exam_import_not_found");
        if (!draft.source.answerFileName) throw new Error("exam_answer_file_not_found");
        const answerBuffer = await loadStoredExamSourceFile(importId, "answer", draft.source.answerFileName);
        const extracted = await extractExamDocument(answerBuffer, { fileName: draft.source.answerFileName, mimeType: draft.source.answerFormat === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf" });
        const blocks = extractVerbatimAnswerBlocks(extracted.pages);
        const verbatimRecovery = applyVerbatimAnswerBlocks({ questions: draft.questions }, blocks);
        const sequentialRecovery = applySequentialObjectiveAnswerSections(verbatimRecovery.recognition, extracted.pages);
        const recoveredCount = verbatimRecovery.recoveredCount + sequentialRecovery.recoveredCount;
        if (!recoveredCount) throw new Error("exam_official_answer_recovery_empty");
        const matchedCount = sequentialRecovery.recognition.questions.filter((question) => question.answerSource === "pdf_answer"
          && String(question.answerVariants && question.answerVariants.official || question.referenceAnswer || "").trim()).length;
        const cleanedDescription = String(draft.metadata.description || "")
            .replace(/[；;，,]?未提供(?:独立)?答案文件[^。！？]*[。！？]?/gu, "")
            .replace(/[；;，,]?答案文件(?:缺失|未提供)[^。！？]*[。！？]?/gu, "")
            .trim();
        const description = /未提供(?:独立)?答案文件|答案文件(?:缺失|未提供)/u.test(draft.metadata.description || "")
          ? `${cleanedDescription}${cleanedDescription && !/[。！？]$/u.test(cleanedDescription) ? "。" : ""}已上传独立答案文件，系统已按题号与题型顺序配对，仍需人工校对。`
          : draft.metadata.description;
        const updated = examImportStore.update(importId, {
          metadata: { description },
          questions: sequentialRecovery.recognition.questions,
          source: { answerMatchedCount: Math.max(Number(draft.source.answerMatchedCount) || 0, matchedCount) },
        }, currentAdminDisplayName() || "超级管理员");
        logOperation({
          action: "exam_import.recover_official_answers",
          category: "exam",
          targetType: "exam_import",
          targetId: importId,
          summary: `从答案原文件恢复来源答案：${draft.metadata.title}`,
          metadata: { recoveredCount, blockCount: verbatimRecovery.blockCount, sequentialSectionCount: sequentialRecovery.sectionCount, answerFileName: draft.source.answerFileName },
        });
        sendJson(response, 200, { success: true, draft: updated, recoveredCount, blockCount: verbatimRecovery.blockCount, sequentialSectionCount: sequentialRecovery.sectionCount });
      } catch (error) {
        const status = error.message === "exam_import_not_found" ? 404 : (error.code === "ENOENT" || error.message === "exam_answer_file_not_found" ? 404 : 422);
        sendJson(response, status, { success: false, error: error.code === "ENOENT" ? "exam_answer_file_not_found" : error.message });
      }
      return;
    }
    if (request.method === "GET" && adminExamImportMatch) {
      const draft = examImportStore.get(decodeURIComponent(adminExamImportMatch[1]));
      sendJson(response, draft ? 200 : 404, draft ? { success: true, draft, preview: examImportPreview(draft) } : { success: false, error: "exam_import_not_found" });
      return;
    }

    if (request.method === "PUT" && adminExamImportMatch) {
      try {
        const payload = await readJsonBody(request, 4 * 1024 * 1024);
        const draft = examImportStore.update(decodeURIComponent(adminExamImportMatch[1]), payload, currentAdminDisplayName() || "超级管理员");
        const preview = examImportPreview(draft);
        logOperation({ action: "exam_import.update", category: "exam", targetType: "exam_import", targetId: draft.id, summary: `校对试卷识别草稿：${draft.metadata.title}`, metadata: { questionCount: draft.questions.length } });
        sendJson(response, 200, { success: true, draft, preview });
      } catch (error) {
        sendJson(response, error.message === "exam_import_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "DELETE" && adminExamImportMatch) {
      try {
        const importId = decodeURIComponent(adminExamImportMatch[1]);
        const removed = examImportStore.remove(importId);
        await deleteStoredExamSourceFiles(importId, removed.source);
        logOperation({
          action: "exam_import.delete",
          category: "exam",
          targetType: "exam_import",
          targetId: importId,
          summary: `删除试卷识别草稿：${removed.metadata.title}`,
          metadata: { fileName: removed.source.fileName, questionCount: removed.questions.length },
        });
        sendJson(response, 200, { success: true, id: importId });
      } catch (error) {
        const status = error.message === "exam_import_not_found" ? 404 : (error.message === "exam_import_already_confirmed" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const adminExamAnswerSupplementMatch = url.pathname.match(/^\/api\/admin\/exams\/imports\/([^/]+)\/questions\/([^/]+)\/supplement-answer$/);
    if (request.method === "POST" && adminExamAnswerSupplementMatch) {
      const importId = decodeURIComponent(adminExamAnswerSupplementMatch[1]);
      const localId = decodeURIComponent(adminExamAnswerSupplementMatch[2]);
      const supplementOptions = await readJsonBody(request).catch(() => ({}));
      const supplementAnswers = supplementOptions.answers !== false;
      const supplementMetadata = supplementOptions.metadata === true;
      const config = aiConfigStore.load();
      const configuredRoute = config.routes.exam_answer_supplement;
      const fallbackRoute = config.routes.exam_paper_extraction;
      const route = configuredRoute && configuredRoute.mode === "provider" ? configuredRoute : fallbackRoute;
      const provider = route && route.mode === "provider"
        ? config.providers.find((item) => item.id === route.providerId && item.enabled)
        : null;
      const draft = examImportStore.get(importId);
      const question = draft && draft.questions.find((item) => item.localId === localId);
      if (!draft || !question) {
        sendJson(response, 404, { success: false, error: draft ? "exam_import_question_not_found" : "exam_import_not_found" });
        return;
      }
      if (!provider) {
        sendJson(response, 503, { success: false, error: "exam_answer_supplement_route_unavailable" });
        return;
      }
      const contextResolution = resolveTextbookContext(question);
      const resolvedBook = contextResolution.book
        && (!contextResolution.changed || contextResolution.highConfidence)
        ? contextResolution.book
        : null;
      const effectiveQuestion = resolvedBook ? {
        ...question,
        subjectId: resolvedBook.subjectId,
        bookId: resolvedBook.id,
        chapter: contextResolution.chapterNode && contextResolution.chapterNode.path || question.chapter,
      } : question;
      const task = aiTaskStore.start(aiTaskMetadata(config, "exam_answer_supplement", {}, {
        providerId: provider.id,
        providerName: provider.name,
        protocol: provider.protocol,
        model: route.model,
        mode: "provider",
        inputSummary: { importId, localId, type: question.type, maxScore: question.maxScore },
      }));
      try {
        const catalog = questionStore.catalog();
        const subject = catalog.subjects.find((item) => item.id === effectiveQuestion.subjectId);
        const book = catalog.books.find((item) => item.id === effectiveQuestion.bookId);
        const textbook = book && textbookCatalogStore.get(book.id);
        const catalogNodes = catalogNodesWithPaths(textbook && textbook.confirmed && textbook.confirmed.nodes || []);
        const evidenceChunks = contextResolution.evidenceChunks.length
          ? contextResolution.evidenceChunks
          : retrieveQuestionEvidence(effectiveQuestion, "生成参考答案、得分点和知识点", 8);
        const literalEvidence = extractQuestionLiteralEvidence(question.stem, question.material);
        const questionMaterialMarks = materialMarksForQuestion(question);
        const materialWithMarks = formatMaterialWithMarks(question.material, questionMaterialMarks);
        const requiredOutput = {
          correctAnswer: supplementAnswers && (question.type === "single_choice" || question.type === "multiple_choice") ? ["A"] : [],
          referenceAnswer: supplementAnswers
            ? (question.type === "single_choice"
              ? "完整候选解析：先给出答案，再说明正确项的具体依据并排除最易混淆项；不得只报答案；用 **短语** 标记重点"
              : (question.type === "multiple_choice"
                ? "完整候选解析：先给出答案，再逐项说明每个选项为何应选或不选并指出易错原因；不得只报答案；用 **短语** 标记重点"
                : "完整候选参考答案；用 **短语** 标记核心概念、关键判断、得分点关键词和结论"))
            : "",
          scoringPoints: supplementAnswers ? [{
            description: "得分点；选择题也必须填写一条简要判分依据",
            score: question.maxScore,
            textbookPage: "得分点对应的教材印刷页码或页码范围，例如 3-5；无法可靠确定则留空",
            pageBasis: "confirmed_catalog | textbook_text | 空字符串",
            sourceNote: "教材名 · 对应目录标题；无法可靠确定则留空",
          }] : [],
          chapter: supplementMetadata ? "从已确认目录选择的完整章节路径，无法确定则留空" : "",
          knowledgePoints: supplementMetadata ? ["知识点"] : [],
          uncertainty: "不确定项，没有则留空",
        };
        const completionResult = await completePromptWithTransientRetry(
          { ...provider, timeoutMs: Math.max(Number(provider.timeoutMs) || 30000, 120000) },
          route,
          config.prompts.exam_answer_supplement,
          {
            question: {
              type: question.type,
              material: question.material,
              materialMarks: questionMaterialMarks,
              materialWithMarks,
              stem: question.stem,
              options: question.options,
              maxScore: question.maxScore,
              sectionTitle: question.sectionTitle,
              currentChapter: effectiveQuestion.chapter,
              currentKnowledgePoints: effectiveQuestion.knowledgePoints,
              sourcePosition: question.sourcePage,
              pageFieldInstruction: "sourcePosition 是题目所在的试卷来源页或 Word 文档片段，只读且不得写入得分点教材页码。scoringPoints[].textbookPage 才是教材印刷页码。",
              requestedFields: { answers: supplementAnswers, metadata: supplementMetadata },
              literalEvidenceInstruction: "literalEvidence 由系统对共享材料逐字检索生成。凡题干要求分析文中若干处同一字词，必须按 occurrences 逐项作答；不得跳过任何一处，也不得在 actualCount 已满足 expectedCount 时声称原文缺失。",
              materialMarkInstruction: "materialMarks 是本小题在原卷中实际对应的文字标记。回答下划线、双下划线、波浪线或加点题时，只能分析 materialWithMarks 中同名的【标记开始】与【标记结束】之间的原文，不得自行改选材料中的其他句段。",
              literalEvidence,
            },
            catalogContext: {
              subject: subject && subject.name,
              book: book && `${book.title}${book.volume ? ` · ${book.volume}` : ""}`,
              chapter: effectiveQuestion.chapter,
              knowledgePoints: effectiveQuestion.knowledgePoints,
              confirmedCatalog: catalogNodes.filter((node) => Number(node.level) <= 4).slice(0, 240).map((node) => ({ level: node.level, title: node.title, startPage: node.startPage, endPage: node.endPage, knowledgePoints: node.knowledgePoints || [] })),
            },
            textbookResolution: {
              selectedBookId: question.bookId,
              resolvedBookId: effectiveQuestion.bookId,
              changed: effectiveQuestion.bookId !== question.bookId,
              exactWorkTitles: contextResolution.workTitles,
              chapter: contextResolution.chapterNode && contextResolution.chapterNode.path || "",
              instruction: "具体作品的直接教材论述优先于作者姓名命中。章节、知识点、得分点页码和来源必须属于 resolvedBookId；正文证据不足时页码留空。",
            },
            textbookEvidence: formatTextbookEvidence(evidenceChunks, 16000),
            requiredOutput,
          },
          ({ attempt, error }) => aiTaskStore.update(task.id, {
            inputSummary: {
              retryCount: attempt,
              retryingModel: route.model,
              firstFailureReason: String(error.message || error).slice(0, 300),
            },
          }),
        );
        const { completion } = completionResult;
        aiTaskStore.update(task.id, {
          inputSummary: {
            retryCount: completionResult.retryCount,
            recoveredFromTransientFailure: completionResult.retryCount > 0,
            finalModel: completion.model || route.model,
          },
        });
        const raw = parseJsonContent(completion.content);
        const isChoice = question.type === "single_choice" || question.type === "multiple_choice";
        const parsedCorrectAnswer = [...new Set((Array.isArray(raw.correctAnswer) ? raw.correctAnswer : String(raw.correctAnswer || "").split(/[，,、\s]/))
          .flatMap((item) => String(item).normalize("NFKC").toUpperCase().match(/[A-L]/g) || []))];
        const correctAnswer = question.type === "single_choice" ? parsedCorrectAnswer.slice(0, 1) : parsedCorrectAnswer;
        const referenceAnswer = String(raw.referenceAnswer || "").trim();
        if (supplementAnswers && answerContradictsLiteralEvidence(referenceAnswer, literalEvidence)) {
          throw new Error("provider_output_literal_evidence_conflict");
        }
        const effectiveCorrectAnswer = supplementAnswers && correctAnswer.length
          ? [...new Set(correctAnswer)] : (question.correctAnswer || []);
        const choiceAnswerDescription = isChoice && effectiveCorrectAnswer.length
          ? `选择 ${effectiveCorrectAnswer.map((key) => {
            const option = (question.options || []).find((item) => item.key === key);
            return option && option.text ? `${key}（${option.text}）` : key;
          }).join("、")}`
          : "";
        const modelScoringPoints = Array.isArray(raw.scoringPoints) ? raw.scoringPoints : [];
        const rawScoringPoints = supplementAnswers && isChoice && choiceAnswerDescription
          ? [{
            ...(modelScoringPoints[0] || {}),
            description: choiceAnswerDescription,
            score: question.maxScore,
          }]
          : modelScoringPoints;
        const generatedChapter = String(raw.chapter || "").trim().slice(0, 500);
        const generatedCatalogNode = catalogNodeForChapter(generatedChapter, catalogNodes);
        const existingCatalogNode = catalogNodeForChapter(effectiveQuestion.chapter, catalogNodes);
        const resolvedCatalogNode = contextResolution.book && contextResolution.book.id === effectiveQuestion.bookId
          ? contextResolution.chapterNode : null;
        const matchedCatalogNode = generatedCatalogNode || resolvedCatalogNode || existingCatalogNode;
        const chapter = matchedCatalogNode && matchedCatalogNode.path || "";
        const scopedEvidence = matchedCatalogNode
          ? evidenceChunks.filter((chunk) => String(chunk.catalogPath || "") === matchedCatalogNode.path
            || String(chunk.catalogPath || "").startsWith(`${matchedCatalogNode.path} > `))
          : [];
        const directEvidence = contextResolution.anchors.length
          ? contextResolution.directEvidenceChunks
          : scopedEvidence.filter((chunk) => Number(chunk.score) >= 0.15);
        const hasDirectTextbookEvidence = directEvidence.length > 0;
        const textbookEvidencePage = hasDirectTextbookEvidence ? evidencePageRange(directEvidence) : "";
        const textbookSourceNote = hasDirectTextbookEvidence && matchedCatalogNode
          ? [book && `${book.title}${book.volume ? ` · ${book.volume}` : ""}`, matchedCatalogNode.path].filter(Boolean).join(" · ")
          : "";
        const scoringPoints = rawScoringPoints.map((point) => {
          const rawDescription = String(point && (point.description || point.point) || "").trim();
          const description = isChoice && (!rawDescription || /^(?:得分点|判断依据|判分依据|选择正确选项)[。；：:]?$/.test(rawDescription))
            ? choiceAnswerDescription : rawDescription;
          return {
            description,
            score: Number(point && (point.score ?? point.points)),
            textbookPage: textbookEvidencePage,
            pageBasis: textbookEvidencePage ? "textbook_text" : "",
            sourceNote: textbookSourceNote,
          };
        }).filter((point) => point.description && Number.isFinite(point.score) && point.score > 0);
        const scoreTotal = scoringPoints.reduce((total, point) => total + point.score, 0);
        const knowledgePoints = (Array.isArray(raw.knowledgePoints) ? raw.knowledgePoints : String(raw.knowledgePoints || "").split(/[，,；;\n]/))
          .map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
        const scoringInvalid = supplementAnswers
          && (!scoringPoints.length || Math.abs(scoreTotal - Number(question.maxScore)) > 0.001);
        const answerInvalid = supplementAnswers && (!referenceAnswer || (isChoice && !effectiveCorrectAnswer.length));
        const metadataInvalid = supplementMetadata
          && !chapter
          && !(knowledgePoints.length || (question.knowledgePoints || []).length);
        if (answerInvalid || metadataInvalid || scoringInvalid) {
          throw new Error("provider_output_format_error");
        }
        const questions = draft.questions.map((item) => item.localId === localId ? {
          ...item,
          subjectId: effectiveQuestion.subjectId,
          bookId: effectiveQuestion.bookId,
          correctAnswer: supplementAnswers && isChoice ? effectiveCorrectAnswer : item.correctAnswer,
          answerVariants: {
            official: item.answerVariants && item.answerVariants.official || "",
            ai: supplementAnswers ? referenceAnswer : (item.answerVariants && item.answerVariants.ai || ""),
            community: item.answerVariants && item.answerVariants.community || "",
          },
          referenceAnswer: supplementAnswers && !["pdf_answer", "team_verified", "community_consensus"].includes(item.answerSource)
            ? referenceAnswer : item.referenceAnswer,
          scoringPoints: supplementAnswers && scoringPoints.length
            ? scoringPoints
            : (supplementMetadata && textbookEvidencePage
              ? (item.scoringPoints || []).map((point) => point.textbookPage ? point : {
                ...point,
                textbookPage: textbookEvidencePage,
                pageBasis: "textbook_text",
                sourceNote: textbookSourceNote,
              })
              : item.scoringPoints),
          answerSource: supplementAnswers && item.answerSource === "missing" ? "ai_supplement" : item.answerSource,
          answerReviewStatus: supplementAnswers && !["pdf_answer", "team_verified", "community_consensus"].includes(item.answerSource)
            ? "unreviewed" : item.answerReviewStatus,
          answerVerified: supplementAnswers && !["pdf_answer", "team_verified", "community_consensus"].includes(item.answerSource)
            ? false : item.answerVerified,
          chapter: effectiveQuestion.bookId !== item.bookId
            ? chapter
            : (supplementMetadata && chapter ? chapter : item.chapter),
          knowledgePoints: supplementMetadata && !(item.knowledgePoints || []).length && knowledgePoints.length ? knowledgePoints : item.knowledgePoints,
          sourcePage: item.sourcePage,
          warnings: [...new Set([
            ...(item.warnings || []).filter((warning) => !/^AI 补充不确定项：/.test(warning)
              && warning !== "AI 补充答案及得分点需人工核对"
              && warning !== "AI 补充目录及知识点需人工核对"
              && !/^检测到具体作品在《.+》中有更充分的直接论述/.test(warning)),
            effectiveQuestion.bookId !== item.bookId
              ? `检测到具体作品在《${book && book.title || effectiveQuestion.bookId}》中有更充分的直接论述，已同步修正科目、教材和章节路径，请人工复核`
              : "",
            generatedChapter && !generatedCatalogNode
              ? "AI 返回的章节不属于当前教材，系统未采纳该章节及其目录页码"
              : "",
            supplementAnswers && !hasDirectTextbookEvidence
              ? "未检索到足够的教材正文直接证据，得分点教材页码已留空"
              : "",
            raw.uncertainty && !/currentSourcePage|sourcePage|sourcePosition|试卷\s*(?:PDF\s*)?(?:页码|来源页|文档片段).*教材|教材.*试卷\s*(?:PDF\s*)?(?:页码|来源页|文档片段)/i.test(String(raw.uncertainty))
              ? `AI 补充不确定项：${String(raw.uncertainty).slice(0, 300)}`
              : (supplementAnswers ? "AI 补充答案及得分点需人工核对" : "AI 补充目录及知识点需人工核对"),
          ].filter(Boolean))],
        } : item);
        const updated = examImportStore.update(importId, { questions }, currentAdminDisplayName() || "超级管理员");
        const preview = examImportPreview(updated);
        aiTaskStore.finish(task.id, { status: "succeeded", chargeable: false, usage: completion.usage, outputChars: completion.content.length });
        logOperation({ action: "exam_import.answer_supplement", category: "exam", targetType: "exam_import", targetId: importId, summary: `AI 补充试卷答案：${updated.metadata.title} · 第 ${question.number} 题`, metadata: { localId, model: completion.model, type: question.type } });
        sendJson(response, 200, {
          success: true,
          draft: updated,
          preview,
          model: completion.model,
          retryCount: completionResult.retryCount,
        });
      } catch (error) {
        aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "exam_answer_supplement" });
        sendJson(response, ["provider_output_format_error", "provider_output_literal_evidence_conflict"].includes(error.message) ? 422 : 502, { success: false, error: error.message });
      }
      return;
    }

    const adminExamImportConfirmMatch = url.pathname.match(/^\/api\/admin\/exams\/imports\/([^/]+)\/confirm$/);
    if (request.method === "POST" && adminExamImportConfirmMatch) {
      try {
        const importId = decodeURIComponent(adminExamImportConfirmMatch[1]);
        const draft = examImportStore.get(importId);
        if (!draft) throw new Error("exam_import_not_found");
        if (draft.status === "confirmed") throw new Error("exam_import_already_confirmed");
        const preview = examImportPreview(draft);
        if (!preview.length) throw new Error("exam_import_questions_required");
        if (preview.some((item) => !item.valid && !item.duplicate)) {
          const error = new Error("exam_import_questions_invalid");
          error.preview = preview;
          throw error;
        }
        const result = questionStore.importMany(examImportCandidates(draft), currentAdminDisplayName() || "超级管理员");
        const questionIds = preview.map((item, index) => item.duplicate ? item.duplicateOf : result.created.find((question) => question.stem === examImportCandidates(draft)[index].stem)?.id).filter(Boolean);
        const selectionRules = inferExamSelectionRules(draft, questionIds);
        const references = validateQuestionReferences(questionIds, false, {
          selectionRules,
          declaredTotalScore: examDeclaredTotalScore(draft),
        });
        const exam = examStore.create({ ...draft.metadata, ...references }, currentAdminDisplayName() || "超级管理员");
        const confirmed = examImportStore.confirm(importId, exam.id, currentAdminDisplayName() || "超级管理员");
        logOperation({
          action: "exam_import.confirm",
          category: "exam",
          targetType: "exam",
          targetId: exam.id,
          summary: `确认导入试卷草稿：${exam.title}`,
          metadata: { importId, createdQuestions: result.created.length, reusedQuestions: preview.filter((item) => item.duplicate).length, status: exam.status },
        });
        sendJson(response, 201, { success: true, draft: confirmed, exam: withExamAnswerReview(exam), createdQuestions: result.created.length, reusedQuestions: preview.filter((item) => item.duplicate).length });
      } catch (error) {
        const status = error.message === "exam_import_not_found" ? 404 : (error.message === "exam_import_already_confirmed" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message, preview: error.preview });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/exams") {
      try {
        const payload = await readJsonBody(request);
        const references = validateQuestionReferences(payload.questionIds, false, payload);
        const exam = examStore.create({ ...payload, ...references }, currentAdminDisplayName() || "超级管理员");
        logOperation({ action: "exam.create", category: "exam", targetType: "exam", targetId: exam.id, summary: `创建模拟试卷：${exam.title}`, metadata: { questionCount: exam.questionIds.length, totalScore: exam.totalScore, durationMinutes: exam.durationMinutes } });
        sendJson(response, 201, { success: true, exam: withExamAnswerReview(exam) });
      } catch (error) { sendJson(response, 422, { success: false, error: error.message }); }
      return;
    }

    const adminExamMatch = url.pathname.match(/^\/api\/admin\/exams\/([^/]+)$/);
    if (request.method === "DELETE" && adminExamMatch) {
      try {
        const examId = decodeURIComponent(adminExamMatch[1]);
        const removed = examStore.remove(examId);
        logOperation({ action: "exam.delete", category: "exam", targetType: "exam", targetId: examId, summary: `删除试卷草稿：${removed.title}`, metadata: { questionCount: removed.questionIds.length, version: removed.version } });
        sendJson(response, 200, { success: true, id: examId });
      } catch (error) {
        sendJson(response, error.message === "exam_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }
    if (request.method === "PUT" && adminExamMatch) {
      try {
        const payload = await readJsonBody(request);
        const references = validateQuestionReferences(payload.questionIds, false, payload);
        const exam = examStore.update(decodeURIComponent(adminExamMatch[1]), { ...payload, ...references }, currentAdminDisplayName() || "超级管理员");
        logOperation({ action: "exam.update", category: "exam", targetType: "exam", targetId: exam.id, summary: `更新模拟试卷：${exam.title}`, metadata: { version: exam.version, questionCount: exam.questionIds.length, totalScore: exam.totalScore } });
        sendJson(response, 200, { success: true, exam: withExamAnswerReview(exam) });
      } catch (error) { sendJson(response, error.message === "exam_not_found" ? 404 : 422, { success: false, error: error.message }); }
      return;
    }

    const adminExamActionMatch = url.pathname.match(/^\/api\/admin\/exams\/([^/]+)\/action$/);
    if (request.method === "POST" && adminExamActionMatch) {
      try {
        const payload = await readJsonBody(request);
        const exam = examStore.action(decodeURIComponent(adminExamActionMatch[1]), payload.action, currentAdminDisplayName() || "超级管理员");
        const reviewedExam = withExamAnswerReview(exam);
        logOperation({ action: `exam.${payload.action}`, category: "exam", targetType: "exam", targetId: exam.id, summary: `更新模拟试卷状态：${exam.title} · ${exam.status}`, metadata: { status: exam.status, version: exam.version, answerReviewSummary: reviewedExam.answerReviewSummary } });
        sendJson(response, 200, { success: true, exam: reviewedExam });
      } catch (error) { sendJson(response, error.message === "exam_not_found" ? 404 : 422, { success: false, error: error.message }); }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/packs") {
      sendJson(response, 200, { success: true, ...packStore.list({ query: url.searchParams.get("query") || "", status: url.searchParams.get("status") || "all", creatorType: url.searchParams.get("creatorType") || "all" }) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/announcements") {
      sendJson(response, 200, { success: true, ...announcementStore.list({
        query: url.searchParams.get("query") || "",
        status: url.searchParams.get("status") || "all",
      }) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/announcements") {
      try {
        const payload = await readJsonBody(request);
        const announcement = announcementStore.create(payload, currentAdminDisplayName() || "超级管理员");
        logOperation({ action: "announcement.create", category: "announcement", targetType: "announcement", targetId: announcement.id, summary: `创建公告草稿：${announcement.title}`, metadata: { status: announcement.status, priority: announcement.priority, startsAt: announcement.startsAt, endsAt: announcement.endsAt } });
        sendJson(response, 201, { success: true, announcement });
      } catch (error) { sendJson(response, 422, { success: false, error: error.message }); }
      return;
    }

    const adminAnnouncementMatch = url.pathname.match(/^\/api\/admin\/announcements\/([^/]+)$/);
    if (request.method === "PUT" && adminAnnouncementMatch) {
      try {
        const payload = await readJsonBody(request);
        const announcement = announcementStore.update(decodeURIComponent(adminAnnouncementMatch[1]), payload, currentAdminDisplayName() || "超级管理员");
        logOperation({ action: "announcement.update", category: "announcement", targetType: "announcement", targetId: announcement.id, summary: `编辑公告：${announcement.title}`, metadata: { status: announcement.status, priority: announcement.priority, startsAt: announcement.startsAt, endsAt: announcement.endsAt } });
        sendJson(response, 200, { success: true, announcement });
      } catch (error) { sendJson(response, error.message === "announcement_not_found" ? 404 : 422, { success: false, error: error.message }); }
      return;
    }

    if (request.method === "DELETE" && adminAnnouncementMatch) {
      try {
        const announcement = announcementStore.remove(decodeURIComponent(adminAnnouncementMatch[1]));
        logOperation({ action: "announcement.delete", category: "announcement", targetType: "announcement", targetId: announcement.id, summary: `删除公告：${announcement.title}`, metadata: { status: announcement.status } });
        sendJson(response, 200, { success: true });
      } catch (error) { sendJson(response, error.message === "announcement_not_found" ? 404 : 422, { success: false, error: error.message }); }
      return;
    }

    const adminAnnouncementActionMatch = url.pathname.match(/^\/api\/admin\/announcements\/([^/]+)\/action$/);
    if (request.method === "POST" && adminAnnouncementActionMatch) {
      try {
        const payload = await readJsonBody(request);
        const announcement = announcementStore.action(decodeURIComponent(adminAnnouncementActionMatch[1]), payload.action, currentAdminDisplayName() || "超级管理员");
        logOperation({ action: `announcement.${payload.action}`, category: "announcement", targetType: "announcement", targetId: announcement.id, summary: `更新公告状态：${announcement.title} · ${announcement.status}`, metadata: { status: announcement.status, startsAt: announcement.startsAt, endsAt: announcement.endsAt } });
        sendJson(response, 200, { success: true, announcement });
      } catch (error) { sendJson(response, error.message === "announcement_not_found" ? 404 : 422, { success: false, error: error.message }); }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/packs") {
      try {
        const payload = await readJsonBody(request);
        const references = validateQuestionReferences(payload.questionIds, true);
        const pack = packStore.create({ ...payload, questionIds: references.questionIds }, currentAdminDisplayName() || "超级管理员");
        if (pack.status === "pending_review") moderationStore.create({ source: "system_review", type: "unsafe_content", risk: "low", targetType: "pack", targetId: pack.id, targetTitle: pack.name, reporter: { id: "system", nickname: "公开内容初筛" }, reason: "新公开题包等待内容安全审核", detail: "题包公开前需检查广告、非法内容及与学习无关信息。", reportedUser: pack.creatorType === "user" ? pack.creator : null });
        logOperation({ action: "pack.create", category: "pack", targetType: "pack", targetId: pack.id, summary: `创建题包：${pack.name}`, metadata: { visibility: pack.visibility, status: pack.status, questionCount: pack.questionIds.length } });
        sendJson(response, 201, { success: true, pack });
      } catch (error) { sendJson(response, 422, { success: false, error: error.message }); }
      return;
    }

    const adminPackMatch = url.pathname.match(/^\/api\/admin\/packs\/([^/]+)$/);
    if (request.method === "PUT" && adminPackMatch) {
      try {
        const payload = await readJsonBody(request);
        const references = validateQuestionReferences(payload.questionIds, true);
        const pack = packStore.update(decodeURIComponent(adminPackMatch[1]), { ...payload, questionIds: references.questionIds }, currentAdminDisplayName() || "超级管理员");
        logOperation({ action: "pack.update", category: "pack", targetType: "pack", targetId: pack.id, summary: `更新题包：${pack.name}`, metadata: { version: pack.version, visibility: pack.visibility, status: pack.status, questionCount: pack.questionIds.length } });
        sendJson(response, 200, { success: true, pack });
      } catch (error) { sendJson(response, error.message === "pack_not_found" ? 404 : 422, { success: false, error: error.message }); }
      return;
    }

    const adminPackActionMatch = url.pathname.match(/^\/api\/admin\/packs\/([^/]+)\/action$/);
    if (request.method === "POST" && adminPackActionMatch) {
      try {
        const payload = await readJsonBody(request);
        if (["publish", "feature"].includes(payload.action)) {
          const current = packStore.get(decodeURIComponent(adminPackActionMatch[1]));
          if (!current) throw new Error("pack_not_found");
          const pendingQuestions = current.questionIds.map((id) => questionStore.get(id))
            .filter((question) => question && question.answerReviewStatus !== "verified");
          if (pendingQuestions.length) throw new Error("content_questions_answer_review_required");
        }
        const pack = packStore.action(decodeURIComponent(adminPackActionMatch[1]), payload.action, currentAdminDisplayName() || "超级管理员");
        if (payload.action === "submit_review") moderationStore.create({ source: "system_review", type: "unsafe_content", risk: "low", targetType: "pack", targetId: pack.id, targetTitle: pack.name, reporter: { id: "system", nickname: "公开内容初筛" }, reason: "公开题包等待内容安全审核", detail: "公开前需人工确认内容安全。", reportedUser: pack.creatorType === "user" ? pack.creator : null });
        logOperation({ action: `pack.${payload.action}`, category: "pack", targetType: "pack", targetId: pack.id, summary: `更新题包状态：${pack.name} · ${pack.status}`, metadata: { status: pack.status, visibility: pack.visibility, version: pack.version } });
        sendJson(response, 200, { success: true, pack });
      } catch (error) { sendJson(response, error.message === "pack_not_found" ? 404 : 422, { success: false, error: error.message }); }
      return;
    }

    const textbookKnowledgeMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/knowledge$/);
    if (request.method === "GET" && textbookKnowledgeMatch) {
      const bookId = decodeURIComponent(textbookKnowledgeMatch[1]);
      const textbook = textbookCatalogStore.get(bookId);
      if (!textbook) sendJson(response, 404, { success: false, error: "textbook_not_found" });
      else sendJson(response, 200, {
        success: true,
        textbook: { bookId, title: textbook.title, subjectId: textbook.subjectId, confirmed: Boolean(textbook.confirmed) },
        knowledge: {
          ...textbookKnowledgeStore.get(bookId),
          outline: textbookKnowledgeStore.outline(bookId),
          active: activeKnowledgeBuilds.has(bookId),
        },
      });
      return;
    }

    const textbookKnowledgeReindexMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/knowledge\/reindex$/);
    if (request.method === "POST" && textbookKnowledgeReindexMatch) {
      try {
        const bookId = decodeURIComponent(textbookKnowledgeReindexMatch[1]);
        const textbook = textbookCatalogStore.get(bookId);
        if (!textbook) throw new Error("textbook_not_found");
        if (!textbook.confirmed) throw new Error("catalog_confirmed_not_found");
        const totalPages = Number(textbook.pdf && textbook.pdf.pageCount) || 0;
        const beforeReindex = textbookKnowledgeStore.get(bookId, { includeContent: true });
        const removedPageCount = totalPages
          ? (beforeReindex.pages || []).filter((page) => Number(page.pdfPage) > totalPages).length
          : 0;
        const backup = removedPageCount ? textbookKnowledgeStore.backup(bookId, {
          reason: "pdf_page_count_reconcile",
          totalPages,
          removedPageCount,
        }) : null;
        const knowledge = textbookKnowledgeStore.reindex(bookId, {
          bookTitle: textbook.title,
          catalogNodes: textbook.confirmed.nodes,
          catalogVersion: Number(textbook.confirmed.version) || 0,
          maxPdfPage: totalPages,
        });
        logOperation({
          action: "textbook_knowledge.reindex",
          category: "catalog",
          targetType: "textbook_knowledge",
          targetId: bookId,
          summary: `重新提取正文层级并分段：${textbook.title}`,
          metadata: { chunkCount: knowledge.chunkCount, outlineCount: knowledge.outlineCount, removedPageCount, backupCreated: Boolean(backup && backup.created), version: knowledge.version },
        });
        sendJson(response, 200, { success: true, reconciliation: { removedPageCount, backup }, knowledge: { ...knowledge, outline: textbookKnowledgeStore.outline(bookId) } });
      } catch (error) {
        const status = error.message === "textbook_not_found" ? 404 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const textbookMineruImportMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/knowledge\/import-mineru$/);
    if (request.method === "POST" && textbookMineruImportMatch) {
      try {
        const bookId = decodeURIComponent(textbookMineruImportMatch[1]);
        const textbook = textbookCatalogStore.get(bookId);
        if (!textbook) throw new Error("textbook_not_found");
        if (!textbook.pdf) throw new Error("textbook_pdf_not_found");
        if (!textbook.confirmed) throw new Error("catalog_confirmed_not_found");
        const startPdfPageValue = url.searchParams.get("startPdfPage");
        if (!startPdfPageValue) throw new Error("mineru_start_page_required");
        if (url.searchParams.get("confirmMappedRange") !== "1") throw new Error("mineru_import_confirmation_required");
        const buffer = await readBufferBody(request, 64 * 1024 * 1024);
        const parsed = parseMineruLayout(buffer, { startPdfPage: startPdfPageValue });
        const fileName = String(url.searchParams.get("fileName") || "layout.json").slice(0, 240);
        const importMode = url.searchParams.get("importMode") === "replace_book" ? "replace_book" : "merge_range";
        const preserveMissingPages = importMode !== "replace_book";
        const totalPages = Number(textbook.pdf.pageCount) || 0;
        if (totalPages < 1) throw new Error("textbook_pdf_page_count_missing");
        if (parsed.metadata.mappedPageEnd > totalPages) {
          throw new Error("mineru_mapped_range_exceeds_pdf");
        }
        if (importMode === "replace_book" && parsed.metadata.mappedPageStart !== 1) {
          throw new Error("mineru_replace_book_must_start_at_page_one");
        }
        const beforeImport = textbookKnowledgeStore.get(bookId, { includeContent: true });
        const existingPageNumbers = new Set((beforeImport.pages || []).map((page) => Number(page.pdfPage)));
        const removedOutOfRangePageCount = totalPages
          ? (beforeImport.pages || []).filter((page) => Number(page.pdfPage) > totalPages).length
          : 0;
        const replacedPageCount = parsed.pages.filter((page) => existingPageNumbers.has(Number(page.pdfPage))).length;
        const backup = textbookKnowledgeStore.backup(bookId, {
          reason: "mineru_import",
          fileName,
          mappedPageStart: parsed.metadata.mappedPageStart,
          mappedPageEnd: parsed.metadata.mappedPageEnd,
        });
        if (!backup || backup.created !== true) throw new Error("textbook_knowledge_backup_failed");
        const fingerprint = crypto.createHash("sha256").update(buffer).digest("hex");
        const knowledge = textbookKnowledgeStore.importStructuredPages(bookId, parsed.pages, {
          bookTitle: textbook.title,
          catalogNodes: textbook.confirmed.nodes,
          totalPages: totalPages || parsed.metadata.mappedPageEnd,
          preserveMissingPages,
          quality: parsed.quality,
          source: {
            mode: "mineru_layout",
            fileName,
            importMode,
            fingerprint,
            catalogVersion: Number(textbook.confirmed.version) || 0,
            ...parsed.metadata,
            importedAt: Date.now(),
          },
        });
        logOperation({
          action: "textbook_knowledge.import_mineru",
          category: "catalog",
          targetType: "textbook_knowledge",
          targetId: bookId,
          summary: `导入 MinerU 结构化正文：${textbook.title}`,
          metadata: {
            fileName,
            parsedPages: parsed.metadata.pageCount,
            retainedMissingPages: preserveMissingPages,
            importMode,
            mappedPageStart: parsed.metadata.mappedPageStart,
            mappedPageEnd: parsed.metadata.mappedPageEnd,
            replacedPageCount,
            removedOutOfRangePageCount,
            backupCreated: backup.created,
            chunkCount: knowledge.chunkCount,
            removedMetaBlocks: parsed.quality.removedMetaBlocks,
            reviewBlocks: parsed.quality.reviewBlocks,
            version: knowledge.version,
          },
        });
        sendJson(response, 201, {
          success: true,
          import: {
            metadata: parsed.metadata,
            quality: parsed.quality,
            preserveMissingPages,
            importMode,
            replacedPageCount,
            removedOutOfRangePageCount,
            preservedPageCount: preserveMissingPages
              ? Math.max(0, existingPageNumbers.size - replacedPageCount - removedOutOfRangePageCount)
              : 0,
            backup,
          },
          knowledge: { ...knowledge, outline: textbookKnowledgeStore.outline(bookId) },
        });
      } catch (error) {
        const status = error.message === "payload_too_large" ? 413
          : (["textbook_not_found", "textbook_pdf_not_found"].includes(error.message) ? 404 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const textbookKnowledgeBuildMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/knowledge\/build$/);
    if (request.method === "POST" && textbookKnowledgeBuildMatch) {
      try {
        const payload = await readJsonBody(request).catch(() => ({}));
        const bookId = decodeURIComponent(textbookKnowledgeBuildMatch[1]);
        const textbook = textbookCatalogStore.get(bookId);
        if (!textbook) throw new Error("textbook_not_found");
        if (!textbook.pdf) throw new Error("textbook_pdf_not_found");
        if (!textbook.confirmed) throw new Error("catalog_confirmed_not_found");
        const alreadyActive = activeKnowledgeBuilds.has(bookId);
        if (!alreadyActive) startTextbookKnowledgeBuild(bookId, { rebuild: payload.rebuild === true }).catch(() => {});
        sendJson(response, alreadyActive ? 200 : 202, {
          success: true,
          started: !alreadyActive,
          knowledge: { ...textbookKnowledgeStore.get(bookId), active: true },
        });
      } catch (error) {
        const status = error.message === "textbook_not_found" || error.message === "textbook_pdf_not_found" ? 404 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const textbookKnowledgeChunksMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/knowledge\/chunks$/);
    if (request.method === "GET" && textbookKnowledgeChunksMatch) {
      const bookId = decodeURIComponent(textbookKnowledgeChunksMatch[1]);
      const catalogNodeId = url.searchParams.get("catalogNodeId") || "";
      const catalogScope = textbookCatalogScope(bookId, catalogNodeId);
      const scope = url.searchParams.get("scope") || "";
      const result = textbookKnowledgeStore.listChunks(bookId, {
        query: url.searchParams.get("query") || "",
        catalogPathPrefix: catalogScope && catalogScope.path,
        contentKind: scope === "unmapped" ? "unmapped" : (scope === "body" ? "body" : ""),
        page: url.searchParams.get("page") || 1,
        pageSize: url.searchParams.get("pageSize") || 20,
      });
      sendJson(response, 200, { success: true, ...result });
      return;
    }

    const textbookKnowledgeChunkMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/knowledge\/chunks\/([^/]+)$/);
    if (request.method === "PUT" && textbookKnowledgeChunkMatch) {
      try {
        const bookId = decodeURIComponent(textbookKnowledgeChunkMatch[1]);
        const chunkId = decodeURIComponent(textbookKnowledgeChunkMatch[2]);
        const payload = await readJsonBody(request, 256 * 1024);
        const chunk = textbookKnowledgeStore.updateChunk(bookId, chunkId, payload);
        logOperation({ action: "textbook_knowledge.chunk_update", category: "catalog", targetType: "textbook_knowledge_chunk", targetId: chunkId, summary: `校对教材正文片段：${chunk.catalogPath}`, metadata: { bookId, printedPage: chunk.printedPageStart, enabled: chunk.enabled } });
        sendJson(response, 200, { success: true, chunk });
      } catch (error) {
        sendJson(response, error.message === "textbook_knowledge_chunk_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    const textbookKnowledgeSearchMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/knowledge\/search$/);
    if (request.method === "POST" && textbookKnowledgeSearchMatch) {
      try {
        const bookId = decodeURIComponent(textbookKnowledgeSearchMatch[1]);
        const payload = await readJsonBody(request, 16 * 1024);
        const query = String(payload.query || "").trim();
        if (!query) throw new Error("textbook_knowledge_query_required");
        const catalogScope = textbookCatalogScope(bookId, payload.catalogNodeId);
        const results = textbookKnowledgeStore.search(bookId, query, {
          catalogPathPrefix: catalogScope && catalogScope.path,
          limit: payload.limit,
        });
        sendJson(response, 200, { success: true, query, results });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    const textbookQuestionGenerationMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/knowledge\/generate-questions$/);
    if (request.method === "POST" && textbookQuestionGenerationMatch) {
      const bookId = decodeURIComponent(textbookQuestionGenerationMatch[1]);
      const payload = await readJsonBody(request, 32 * 1024).catch(() => ({}));
      const config = aiConfigStore.load();
      const textbook = textbookCatalogStore.get(bookId);
      const scene = configuredScene(config, "textbook_question_generation", "exam_answer_supplement");
      if (!textbook || !textbook.confirmed) {
        sendJson(response, 404, { success: false, error: textbook ? "catalog_confirmed_not_found" : "textbook_not_found" });
        return;
      }
      if (!scene) {
        sendJson(response, 503, { success: false, error: "textbook_question_generation_route_unavailable" });
        return;
      }
      const count = Math.min(10, Math.max(1, Number(payload.count) || 3));
      const catalogScope = textbookCatalogScope(bookId, payload.catalogNodeId);
      const query = String(payload.query || catalogScope && catalogScope.title || "文学史核心知识").trim();
      const evidenceChunks = textbookKnowledgeStore.search(bookId, query, { catalogPathPrefix: catalogScope && catalogScope.path, limit: 10 });
      if (!evidenceChunks.length) {
        sendJson(response, 422, { success: false, error: "textbook_knowledge_evidence_not_found" });
        return;
      }
      const task = aiTaskStore.start(aiTaskMetadata(config, "textbook_question_generation", payload, {
        inputSummary: { bookId, query: query.slice(0, 120), count, questionType: payload.questionType || "single_choice" },
      }));
      try {
        const completion = await completePromptWithProvider(
          { ...scene.provider, timeoutMs: Math.max(120000, Number(scene.provider.timeoutMs) || 0) },
          { ...scene.route, maxTokens: Math.max(4000, Number(scene.route.maxTokens) || 0) },
          scene.prompt,
          {
            bookMetadata: { id: textbook.id, title: textbook.title, authors: textbook.authors, publisher: textbook.publisher },
            catalogPath: catalogScope && catalogScope.path || evidenceChunks[0].catalogPath,
            questionFocus: query,
            questionType: String(payload.questionType || "single_choice"),
            difficulty: String(payload.difficulty || "medium"),
            count,
            textbookEvidence: formatTextbookEvidence(evidenceChunks, 18000),
            requiredOutput: generatedQuestionSchema(),
          },
        );
        const candidates = normalizeGeneratedQuestions(parseJsonContent(completion.content), {
          bookId,
          bookTitle: textbook.title,
          subjectId: textbook.subjectId,
          catalogPath: catalogScope && catalogScope.path || evidenceChunks[0].catalogPath,
          questionType: payload.questionType,
          count,
          evidenceChunks,
        });
        aiTaskStore.finish(task.id, { status: "succeeded", chargeable: false, usage: completion.usage, outputChars: completion.content.length });
        logOperation({ action: "textbook_knowledge.generate_questions", category: "question", targetType: "textbook", targetId: bookId, summary: `依据教材正文生成 ${candidates.length} 道候选题：${textbook.title}`, metadata: { query, model: completion.model } });
        sendJson(response, 201, { success: true, candidates, saved: [], model: completion.model, evidence: evidenceChunks });
      } catch (error) {
        aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "textbook_question_generation" });
        sendJson(response, 502, { success: false, error: error.message });
      }
      return;
    }

    const textbookPdfPageMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/pdf-page$/);
    if (request.method === "GET" && textbookPdfPageMatch) {
      try {
        const bookId = decodeURIComponent(textbookPdfPageMatch[1]);
        if (!textbookCatalogStore.get(bookId)) throw new Error("textbook_not_found");
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const content = await loadStoredTextbookPreview(bookId, page);
        response.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": content.length,
          "Cache-Control": "private, max-age=3600",
        });
        response.end(content);
      } catch (error) {
        const status = ["textbook_not_found", "textbook_pdf_not_found"].includes(error.message) ? 404 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const textbookPdfMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/pdf$/);
    if (request.method === "GET" && textbookPdfMatch) {
      try {
        const bookId = decodeURIComponent(textbookPdfMatch[1]);
        if (!textbookCatalogStore.get(bookId)) throw new Error("textbook_not_found");
        const content = await loadStoredTextbookPdf(bookId);
        const range = String(request.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
        if (range) {
          const start = range[1] ? Math.max(0, Number(range[1])) : 0;
          const end = range[2] ? Math.min(content.length - 1, Number(range[2])) : content.length - 1;
          if (start > end || start >= content.length) throw new Error("pdf_range_invalid");
          response.writeHead(206, {
            "Content-Type": "application/pdf",
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${content.length}`,
            "Accept-Ranges": "bytes",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${bookId}.pdf`)}`,
            "Cache-Control": "private, max-age=3600",
          });
          response.end(content.subarray(start, end + 1));
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Length": content.length,
          "Accept-Ranges": "bytes",
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${bookId}.pdf`)}`,
          "Cache-Control": "private, max-age=3600",
        });
        response.end(content);
      } catch (error) {
        const status = error.message === "textbook_not_found" || error.message === "textbook_pdf_not_found" ? 404 : 416;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }
    if (request.method === "POST" && textbookPdfMatch) {
      try {
        const bookId = decodeURIComponent(textbookPdfMatch[1]);
        if (!textbookCatalogStore.get(bookId)) throw new Error("textbook_not_found");
        const isDirectPdf = String(request.headers["content-type"] || "").startsWith("application/pdf");
        const payload = isDirectPdf
          ? { fileName: url.searchParams.get("fileName") || `${bookId}.pdf` }
          : await readJsonBody(request, 205 * 1024 * 1024);
        const buffer = isDirectPdf
          ? await readBufferBody(request)
          : Buffer.from(String(payload.dataBase64 || "").replace(/^data:application\/pdf;base64,/, ""), "base64");
        const extracted = await extractPdf(buffer);
        await saveStoredTextbookPdf(bookId, buffer, payload.fileName);
        textbookCatalogStore.savePdf(bookId, {
          fileName: payload.fileName,
          size: buffer.length,
          pageCount: extracted.pageCount,
          textChars: extracted.textChars,
        }, currentAdminDisplayName() || "超级管理员");
        logOperation({ action: "catalog.pdf_upload", category: "catalog", targetType: "textbook", targetId: bookId, summary: `上传教材 PDF：${payload.fileName || bookId}`, metadata: { size: buffer.length, pageCount: extracted.pageCount, textChars: extracted.textChars } });
        const result = await generateCatalogDraft(bookId, extracted);
        if (result.textbook.draft) logOperation({ action: "catalog.draft_generate", category: "catalog", targetType: "textbook", targetId: bookId, summary: `生成待确认目录：${result.textbook.title}`, metadata: { source: result.source, nodeCount: result.textbook.draft.nodes.length, model: result.model } });
        sendJson(response, 201, { success: true, ...result });
      } catch (error) {
        const status = error.message === "payload_too_large" || error.message === "textbook_pdf_too_large" ? 413
          : (error.message === "textbook_not_found" ? 404 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const textbookExtractMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/extract$/);
    if (request.method === "POST" && textbookExtractMatch) {
      try {
        const bookId = decodeURIComponent(textbookExtractMatch[1]);
        const extracted = await extractPdf(await loadStoredTextbookPdf(bookId));
        const result = await generateCatalogDraft(bookId, extracted);
        if (result.textbook.draft) logOperation({ action: "catalog.draft_generate", category: "catalog", targetType: "textbook", targetId: bookId, summary: `重新生成待确认目录：${result.textbook.title}`, metadata: { source: result.source, nodeCount: result.textbook.draft.nodes.length, model: result.model } });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, error.message === "textbook_pdf_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    const textbookDraftMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/draft$/);
    if (request.method === "PUT" && textbookDraftMatch) {
      try {
        const bookId = decodeURIComponent(textbookDraftMatch[1]);
        const payload = await readJsonBody(request, 1024 * 1024);
        const current = textbookCatalogStore.get(bookId);
        if (!current) throw new Error("textbook_not_found");
        const textbook = current.draft
          ? textbookCatalogStore.updateDraft(bookId, payload.nodes, currentAdminDisplayName() || "超级管理员")
          : textbookCatalogStore.setDraft(bookId, payload.nodes, { source: "manual" }, currentAdminDisplayName() || "超级管理员");
        logOperation({ action: "catalog.draft_update", category: "catalog", targetType: "textbook", targetId: bookId, summary: `人工校对目录草稿：${textbook.title}`, metadata: { nodeCount: textbook.draft.nodes.length } });
        sendJson(response, 200, { success: true, textbook });
      } catch (error) {
        sendJson(response, error.message === "textbook_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    const textbookActionMatch = url.pathname.match(/^\/api\/admin\/textbooks\/([^/]+)\/action$/);
    if (request.method === "POST" && textbookActionMatch) {
      try {
        const bookId = decodeURIComponent(textbookActionMatch[1]);
        const payload = await readJsonBody(request);
        let textbook;
        let pageRefresh = { questionsUpdated: 0, pointsUpdated: 0 };
        if (payload.action === "confirm") {
          const current = textbookCatalogStore.get(bookId);
          if (!current) throw new Error("textbook_not_found");
          const audit = auditCatalogNodes(current.draft && current.draft.nodes || []);
          if (!audit.valid) {
            sendJson(response, 422, { success: false, error: "catalog_audit_failed", audit });
            return;
          }
          textbook = textbookCatalogStore.confirm(bookId, currentAdminDisplayName() || "超级管理员");
          pageRefresh = refreshCatalogBackedQuestionPages(questionStore, textbookCatalogStore, bookId);
          const knowledgeBefore = textbookKnowledgeStore.get(bookId, { includeContent: true });
          if ((knowledgeBefore.pages || []).length) {
            const totalPages = Number(textbook.pdf && textbook.pdf.pageCount) || 0;
            const removedPageCount = totalPages
              ? knowledgeBefore.pages.filter((page) => Number(page.pdfPage) > totalPages).length
              : 0;
            if (removedPageCount) textbookKnowledgeStore.backup(bookId, {
              reason: "catalog_confirm_reconcile",
              totalPages,
              removedPageCount,
              catalogVersion: Number(textbook.confirmed.version) || 0,
            });
            const refreshedKnowledge = textbookKnowledgeStore.reindex(bookId, {
              bookTitle: textbook.title,
              catalogNodes: textbook.confirmed.nodes,
              catalogVersion: Number(textbook.confirmed.version) || 0,
              maxPdfPage: totalPages,
            });
            pageRefresh.knowledgeReindexed = true;
            pageRefresh.knowledgePagesRemoved = removedPageCount;
            pageRefresh.knowledgeVersion = refreshedKnowledge.version;
          }
        }
        else if (payload.action === "reject") textbook = textbookCatalogStore.rejectDraft(bookId, payload.note, currentAdminDisplayName() || "超级管理员");
        else throw new Error("catalog_action_invalid");
        logOperation({ action: `catalog.${payload.action}`, category: "catalog", targetType: "textbook", targetId: bookId, summary: `${payload.action === "confirm" ? "确认目录进入知识库" : "退回目录草稿"}：${textbook.title}`, metadata: { status: textbook.status, version: textbook.confirmed && textbook.confirmed.version, ...pageRefresh } });
        sendJson(response, 200, { success: true, textbook, catalogAudit: textbook.catalogAudit });
      } catch (error) {
        sendJson(response, error.message === "textbook_not_found" ? 404 : 422, { success: false, error: error.message, audit: error.audit });
      }
      return;
    }

    // 裁决台统一队列（《链路职责矩阵》第十三节，形态 B）。
    // 本端点只做"一个入口看全 + 分流与追溯"：采纳 / 驳回 / 就地修正仍在各自的裁决界面完成。
    // 合并规则写死：两边各取**全量** → 按 updatedAt 倒序 → 同一时间戳按 source、再按 id 稳定排序 → 最后分页。
    // 禁止"各自分页再归并"，否则会出现"第 2 页比第 1 页新"。
    if (request.method === "GET" && url.pathname === "/api/admin/adjudication/queue") {
      const bookId = url.searchParams.get("bookId") || "all";
      const sourceFilter = url.searchParams.get("source") || "all";
      const statusFilter = url.searchParams.get("status") || "all";
      const query = String(url.searchParams.get("query") || "").trim().toLowerCase();
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 20));
      const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);

      const questionById = new Map(questionStore.list({ library: "official", status: "all" }).questions
        .map((question) => [question.id, question]));

      // 来源标签与筛选项都由数据推导：将来第三条产线接入时这里只多一项，界面结构不变（设计第十三节第四节）。
      const sourceLabels = {
        [SUGGESTION_SOURCES.QUESTION_ENRICHMENT]: "题目完善",
        [SUGGESTION_SOURCES.KNOWLEDGE_INSPECTION]: "AI 巡检",
      };
      const sourceLabelOf = (value) => sourceLabels[value] || value;
      const statusLabels = { recommended: "待处理", applied: "已采纳", rejected: "已驳回" };
      const lifecycleOf = (value) => (["recommended", "applied", "rejected"].includes(value) ? value : "other");
      const enrichmentFieldLabels = { chapter: "目录位置", knowledgePoints: "知识点", scoringPoints: "结构化得分点" };
      const inspectionFieldLabels = {
        primaryNodeId: "作答核心",
        primaryNodeRole: "核心角色",
        requiredNodeIds: "最小充分知识集",
        problemKnowledgeRangeNodeIds: "问题知识范围",
        knowledgeThemeRangeAnchorNodeId: "主题范围锚点",
        familyMemberships: "题族归属",
        createCandidateFamily: "新建候选题族",
      };
      // 巡检采纳是一条"整套指纹"裁决，所以未采纳时展示的就是这套字段
      const INSPECTION_ADOPTED_FIELDS = [
        "primaryNodeId",
        "primaryNodeRole",
        "requiredNodeIds",
        "problemKnowledgeRangeNodeIds",
        "knowledgeThemeRangeAnchorNodeId",
      ];
      const entries = [];

      if (sourceFilter === "all" || sourceFilter === SUGGESTION_SOURCES.QUESTION_ENRICHMENT) {
        questionEnrichmentStore.suggestions().forEach((suggestion) => {
          const question = questionById.get(suggestion.questionId);
          if (bookId !== "all" && question?.bookId !== bookId) return;
          const status = lifecycleOf(suggestion.status);
          const fieldKeys = [];
          if (suggestion.chapterNodeId) fieldKeys.push("chapter");
          if ((suggestion.knowledgePoints || []).length) fieldKeys.push("knowledgePoints");
          if ((suggestion.scoringPoints || []).length) fieldKeys.push("scoringPoints");
          entries.push({
            id: suggestion.id,
            source: suggestion.source,
            sourceLabel: sourceLabelOf(suggestion.source),
            questionId: suggestion.questionId,
            questionStem: question?.stem || "",
            bookId: question?.bookId || "",
            status,
            statusLabel: status === "other" ? String(suggestion.status || "其他") : statusLabels[status],
            statusRaw: String(suggestion.status || ""),
            targetType: "question",
            fieldKeys,
            fieldLabels: fieldKeys.map((key) => enrichmentFieldLabels[key] || key),
            reviewedBy: "",
            reviewedAt: Number(suggestion.appliedAt) || null,
            updatedAt: Number(suggestion.updatedAt) || 0,
            appliedFields: Array.isArray(suggestion.appliedFields) ? suggestion.appliedFields : [],
            appliedVersion: Number(suggestion.appliedVersion) || 0,
          });
        });
      }

      if (sourceFilter === "all" || sourceFilter === SUGGESTION_SOURCES.KNOWLEDGE_INSPECTION) {
        knowledgeClassificationStore.allResults().forEach((result) => {
          if (bookId !== "all" && result.bookId !== bookId) return;
          const question = questionById.get(result.questionId);
          const status = lifecycleOf(result.reviewStatus);
          const appliedFields = Array.isArray(result.appliedFields) ? result.appliedFields : [];
          const fieldKeys = appliedFields.length ? appliedFields : INSPECTION_ADOPTED_FIELDS;
          entries.push({
            id: result.id,
            source: result.source,
            sourceLabel: sourceLabelOf(result.source),
            questionId: result.questionId,
            questionStem: question?.stem || "",
            bookId: result.bookId,
            status,
            statusLabel: status === "other" ? String(result.reviewStatus || "其他") : statusLabels[status],
            statusRaw: String(result.reviewStatus || ""),
            targetType: "fingerprint",
            fieldKeys,
            fieldLabels: fieldKeys.map((key) => inspectionFieldLabels[key] || key),
            reviewedBy: result.reviewedBy || "",
            reviewedAt: Number(result.reviewedAt) || null,
            updatedAt: Number(result.updatedAt) || 0,
            appliedFields,
            appliedVersion: Number(result.appliedVersion) || 0,
          });
        });
      }

      // 同一道题在同一条产线上只保留"最新一条"：更早的巡检结果属于历史记录，
      // 不该混进待裁决队列（与题目完善页 / 巡检页的"最新建议"口径一致）；看历史请去各自产线页。
      const latestBySourceQuestion = new Map();
      entries.forEach((entry) => {
        const key = `${entry.source}\u0000${entry.questionId}`;
        const current = latestBySourceQuestion.get(key);
        if (!current || entry.updatedAt > current.updatedAt) latestBySourceQuestion.set(key, entry);
      });
      const deduped = [...latestBySourceQuestion.values()];

      deduped.sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
        if (left.source !== right.source) return left.source < right.source ? -1 : 1;
        return left.id < right.id ? -1 : (left.id > right.id ? 1 : 0);
      });

      const sourceOptions = [...deduped.reduce((map, entry) => {
        map.set(entry.source, (map.get(entry.source) || 0) + 1);
        return map;
      }, new Map()).entries()]
        .map(([value, count]) => ({ value, label: sourceLabelOf(value), count }))
        .sort((left, right) => (left.value < right.value ? -1 : 1));

      const filtered = deduped.filter((entry) => {
        if (statusFilter !== "all" && entry.status !== statusFilter) return false;
        if (query && ![entry.questionStem, entry.questionId, entry.id, entry.sourceLabel]
          .filter(Boolean).join(" ").toLowerCase().includes(query)) return false;
        return true;
      });

      const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.min(pageCount, requestedPage);
      sendJson(response, 200, {
        success: true,
        bookId,
        page,
        pageSize,
        pageCount,
        total: filtered.length,
        summary: {
          total: filtered.length,
          recommended: filtered.filter((entry) => entry.status === "recommended").length,
          applied: filtered.filter((entry) => entry.status === "applied").length,
          rejected: filtered.filter((entry) => entry.status === "rejected").length,
          other: filtered.filter((entry) => entry.status === "other").length,
          bySource: sourceOptions.reduce((map, option) => { map[option.value] = option.count; return map; }, {}),
        },
        sourceOptions,
        statusOptions: [
          { value: "all", label: "全部状态" },
          { value: "recommended", label: "待处理" },
          { value: "applied", label: "已采纳" },
          { value: "rejected", label: "已驳回" },
        ],
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/question-enrichment") {
      const filters = {
        bookId: url.searchParams.get("bookId") || "all",
        subjectId: url.searchParams.get("subjectId") || "all",
        importBatchId: url.searchParams.get("importBatchId") || "all",
        type: url.searchParams.get("type") || "all",
        need: url.searchParams.get("need") || "all",
        suggestionStatus: url.searchParams.get("suggestionStatus") || "all",
        query: String(url.searchParams.get("query") || "").trim().toLowerCase(),
      };
      const suggestions = questionEnrichmentStore.suggestions();
      const latestByQuestion = new Map();
      suggestions.forEach((suggestion) => {
        if (!latestByQuestion.has(suggestion.questionId)) latestByQuestion.set(suggestion.questionId, suggestion);
      });
      const allQuestions = questionStore.list({ library: "official", status: "all" }).questions;
      const baseQuestions = allQuestions.filter((question) => {
        if (filters.bookId !== "all" && question.bookId !== filters.bookId) return false;
        if (filters.subjectId !== "all" && question.subjectId !== filters.subjectId) return false;
        if (filters.importBatchId !== "all" && question.importBatchId !== filters.importBatchId) return false;
        if (filters.type !== "all" && question.type !== filters.type) return false;
        if (filters.query && ![question.stem, question.chapter, ...(question.knowledgePoints || []), question.id]
          .join(" ").toLowerCase().includes(filters.query)) return false;
        return true;
      });
      const itemForQuestion = (question) => {
        const needs = questionEnrichmentNeeds(question);
        let suggestion = latestByQuestion.get(question.id) || null;
        if (suggestion && suggestion.status === "recommended" && Number(suggestion.questionVersion) !== Number(question.version)) {
          suggestion = { ...suggestion, status: "stale" };
        }
        return { question, needs, suggestion };
      };
      const allItems = baseQuestions.map(itemForQuestion);
      const filteredItems = allItems.filter((item) => {
        if (filters.need !== "all" && !item.needs.needs.includes(filters.need)) return false;
        if (filters.suggestionStatus !== "all" && (item.suggestion ? item.suggestion.status : "none") !== filters.suggestionStatus) return false;
        return true;
      });
      const pageSize = Math.min(100, Math.max(20, Number(url.searchParams.get("pageSize")) || 80));
      const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
      const page = Math.min(pageCount, Math.max(1, Number(url.searchParams.get("page")) || 1));
      const offset = (page - 1) * pageSize;
      const summary = {
        total: allItems.length,
        pending: allItems.filter((item) => !item.needs.complete).length,
        chapter: allItems.filter((item) => item.needs.needsChapter).length,
        knowledgePoints: allItems.filter((item) => item.needs.needsKnowledgePoints).length,
        scoringPoints: allItems.filter((item) => item.needs.needsScoringPoints).length,
        recommended: allItems.filter((item) => item.suggestion && item.suggestion.status === "recommended").length,
        failed: allItems.filter((item) => item.suggestion && item.suggestion.status === "failed").length,
        completed: allItems.filter((item) => item.needs.complete).length,
      };
      sendJson(response, 200, {
        success: true,
        summary,
        total: filteredItems.length,
        page,
        pageSize,
        pageCount,
        items: filteredItems.slice(offset, offset + pageSize),
        jobs: questionEnrichmentStore.jobs(10),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/question-enrichment/jobs") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const config = aiConfigStore.load();
        if (!configuredScene(config, "question_enrichment")) throw new Error("question_enrichment_route_unavailable");
        const requestedIds = [...new Set((Array.isArray(payload.questionIds) ? payload.questionIds : []).map(String).filter(Boolean))];
        let questions = questionStore.list({
          library: "official",
          status: "all",
          subjectId: payload.subjectId || "all",
          bookId: payload.bookId || "all",
          type: payload.type || "all",
          importBatchId: payload.importBatchId || "all",
          query: payload.query || "",
        }).questions;
        if (requestedIds.length) {
          const requestedSet = new Set(requestedIds);
          questions = questions.filter((question) => requestedSet.has(question.id));
        }
        if (payload.need && payload.need !== "all") {
          questions = questions.filter((question) => questionEnrichmentNeeds(question).needs.includes(payload.need));
        } else {
          questions = questions.filter((question) => !questionEnrichmentNeeds(question).complete);
        }
        const runningIds = new Set(questionEnrichmentStore.jobs(100)
          .filter((job) => ["queued", "running"].includes(job.status))
          .flatMap((job) => job.questionIds));
        const limit = Math.min(50, Math.max(1, Number(payload.limit) || 50));
        const questionIds = questions.map((question) => question.id).filter((id) => !runningIds.has(id)).slice(0, limit);
        if (!questionIds.length) throw new Error("question_enrichment_questions_required");
        const job = questionEnrichmentStore.createJob(questionIds);
        logOperation({
          action: "question.enrichment_job_create",
          category: "question",
          targetType: "question_enrichment_job",
          targetId: job.id,
          summary: `创建 ${job.total} 道题目的 AI 完善任务`,
          metadata: { questionIds, bookId: payload.bookId || "all", need: payload.need || "all" },
        });
        setImmediate(() => runQuestionEnrichmentJob(job.id));
        sendJson(response, 202, { success: true, job });
      } catch (error) {
        sendJson(response, error.message === "question_enrichment_route_unavailable" ? 503 : 422, { success: false, error: error.message });
      }
      return;
    }

    const questionEnrichmentJobMatch = url.pathname.match(/^\/api\/admin\/question-enrichment\/jobs\/([^/]+)$/);
    if (request.method === "GET" && questionEnrichmentJobMatch) {
      const job = questionEnrichmentStore.getJob(decodeURIComponent(questionEnrichmentJobMatch[1]));
      sendJson(response, job ? 200 : 404, job ? { success: true, job } : { success: false, error: "question_enrichment_job_not_found" });
      return;
    }

    const questionEnrichmentActionMatch = url.pathname.match(/^\/api\/admin\/question-enrichment\/questions\/([^/]+)\/(apply|reject|revert)$/);
    if (request.method === "POST" && questionEnrichmentActionMatch) {
      const questionId = decodeURIComponent(questionEnrichmentActionMatch[1]);
      const action = questionEnrichmentActionMatch[2];
      try {
        const payload = await readJsonBody(request).catch(() => ({}));
        if (action === "apply") {
          sendJson(response, 200, { success: true, ...applyQuestionEnrichmentSuggestion(questionId, payload) });
        } else if (action === "revert") {
          const suggestionId = String(payload.suggestionId || questionEnrichmentStore.latest(questionId)?.id || "");
          sendJson(response, 200, { success: true, ...revertQuestionEnrichmentSuggestion(questionId, suggestionId) });
        } else {
          const suggestion = payload.suggestionId
            ? questionEnrichmentStore.getSuggestion(String(payload.suggestionId))
            : questionEnrichmentStore.latest(questionId);
          if (!suggestion || suggestion.questionId !== questionId) throw new Error("question_enrichment_suggestion_not_found");
          const rejected = questionEnrichmentStore.updateSuggestion(suggestion.id, { status: "rejected" });
          logOperation({ action: "question.enrichment_reject", category: "question", targetType: "question", targetId: questionId, summary: "拒绝题目完善建议", metadata: { suggestionId: suggestion.id } });
          sendJson(response, 200, { success: true, suggestion: rejected });
        }
      } catch (error) {
        const status = ["question_not_found", "question_enrichment_suggestion_not_found"].includes(error.message) ? 404 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/question-enrichment/apply-batch") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const threshold = Math.min(1, Math.max(0, Number(payload.confidenceThreshold) || 0.85));
        const requested = new Set((Array.isArray(payload.questionIds) ? payload.questionIds : []).map(String).filter(Boolean));
        const latest = new Map();
        questionEnrichmentStore.suggestions().forEach((suggestion) => {
          if (!latest.has(suggestion.questionId)) latest.set(suggestion.questionId, suggestion);
        });
        const candidates = [...latest.values()].filter((suggestion) => suggestion.status === "recommended"
          && suggestion.confidence >= threshold
          && (!requested.size || requested.has(suggestion.questionId)))
          .slice(0, 100);
        if (!candidates.length) throw new Error("question_enrichment_suggestions_required");
        const results = candidates.map((suggestion) => {
          try {
            const result = applyQuestionEnrichmentSuggestion(suggestion.questionId, { suggestionId: suggestion.id, fields: payload.fields });
            return { questionId: suggestion.questionId, success: true, version: result.question.version };
          } catch (error) {
            return { questionId: suggestion.questionId, success: false, error: error.message };
          }
        });
        sendJson(response, 200, {
          success: true,
          appliedCount: results.filter((item) => item.success).length,
          failedCount: results.filter((item) => !item.success).length,
          results,
        });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/questions") {
      const bookId = url.searchParams.get("bookId") || "all";
      const knowledgeNodeId = url.searchParams.get("knowledgeNodeId") || "";
      const result = questionStore.list({
        library: url.searchParams.get("library") || "official",
        status: url.searchParams.get("status") || "all",
        subjectId: url.searchParams.get("subjectId") || "all",
        bookId,
        type: url.searchParams.get("type") || "all",
        importBatchId: url.searchParams.get("importBatchId") || "all",
        query: url.searchParams.get("query") || "",
      });
      // Reuse the request's knowledge structure while decorating every row.
      // Loading the file once per question made a 300+ row catalog take
      // several seconds after an edit/save refresh.
      const requestStructure = bookId !== "all" ? knowledgeStructureStore.get(bookId) : null;
      const questions = bookId !== "all"
        ? knowledgeStructureStore.decorateQuestions(result.questions, bookId, knowledgeNodeId)
        : result.questions;
      sendJson(response, 200, {
        success: true,
        ...result,
        questions: withQuestionFamilyMemberships(questions, requestStructure),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/questions/assess-difficulty") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const requestedIds = new Set((Array.isArray(payload.questionIds) ? payload.questionIds : []).map(String));
        const includeAssessed = payload.includeAssessed === true;
        const allQuestions = questionStore.list({ library: "official", status: "all" }).questions;
        const difficultyProfiles = knowledgeDifficultyProfiles(allQuestions);
        const scopedQuestions = allQuestions.filter((question) => !requestedIds.size || requestedIds.has(question.id));
        const candidates = scopedQuestions
          .filter((question) => includeAssessed || !(question.difficultyAssessment?.source === "manual" && question.difficultyAssessment?.status === "confirmed"))
          .filter((question) => Number(question.knowledgeDepthScore) > 0 || Number(question.contentObscurityScore) > 0)
          .slice(0, Math.min(200, Math.max(1, Number(payload.limit) || 100)));
        const questions = candidates.map((question) => {
          const assessment = estimateDifficulty(question, difficultyProfiles);
          return questionStore.update(question.id, {
            difficultyScore: assessment.score,
            difficultyAssessment: { status: "suggested", source: "knowledge_rule", ...assessment, assessedAt: Date.now() },
            changeNote: "重算知识点组内相对难度",
          }, "知识点难度评估助手");
        });
        const skippedUnassessed = scopedQuestions.filter((question) => Number(question.knowledgeDepthScore) <= 0 && Number(question.contentObscurityScore) <= 0).length;
        logOperation({ action: "question.difficulty_assess", category: "question", targetType: "question_batch", targetId: "difficulty", summary: `重算 ${questions.length} 道题目的组内相对难度`, metadata: { includeAssessed, skippedUnassessed } });
        sendJson(response, 200, { success: true, assessed: questions.length, skippedUnassessed, questions });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/questions/import-batches") {
      sendJson(response, 200, { success: true, batches: questionStore.importBatches() });
      return;
    }

    const adminQuestionImportBatchMatch = url.pathname.match(/^\/api\/admin\/questions\/import-batches\/([^/]+)$/);
    if (request.method === "PUT" && adminQuestionImportBatchMatch) {
      try {
        const batchId = decodeURIComponent(adminQuestionImportBatchMatch[1]);
        const payload = await readJsonBody(request);
        const stores = [questionStore, questionFamilyStore];
        const beforeState = stores.map((store) => store.exportState());
        let result;
        let familyResult = { affectedFamilyIds: [], detachedQuestionIds: [] };
        try {
          const previousQuestions = beforeState[0].filter((question) => question.importBatchId === batchId);
          result = questionStore.updateImportBatch(batchId, payload, currentAdminDisplayName() || "超级管理员");
          const movedQuestionIds = previousQuestions
            .filter((question) => question.subjectId !== String(payload.subjectId || "")
              || question.bookId !== String(payload.bookId || ""))
            .map((question) => question.id);
          familyResult = detachQuestionFamilyMembers(
            movedQuestionIds,
            "question_catalog_updated",
            currentAdminDisplayName() || "超级管理员",
          );
        } catch (error) {
          [...stores].reverse().forEach((store, reverseIndex) => {
            const snapshotIndex = stores.length - 1 - reverseIndex;
            store.replaceState(beforeState[snapshotIndex]);
          });
          throw error;
        }
        logOperation({
          action: "question.import_batch_update",
          category: "question",
          targetType: "question_batch",
          targetId: batchId,
          summary: `统一修改导入批次 ${result.updated.length} 道题目的科目与教材`,
          metadata: {
            batchId,
            updatedCount: result.updated.length,
            subjectId: payload.subjectId,
            bookId: payload.bookId,
            affectedFamilyIds: familyResult.affectedFamilyIds || [],
            detachedQuestionIds: familyResult.detachedQuestionIds || [],
          },
        });
        sendJson(response, 200, {
          success: true,
          updatedCount: result.updated.length,
          batch: result.batch,
          affectedFamilyIds: familyResult.affectedFamilyIds || [],
          detachedQuestionIds: familyResult.detachedQuestionIds || [],
        });
      } catch (error) {
        const status = error.message === "question_import_batch_not_found" ? 404
          : (error.message === "question_merged_source_read_only" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/questions/batch-delete") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const stores = [questionStore, questionFamilyStore];
        const beforeState = stores.map((store) => store.exportState());
        let result;
        let familyResult;
        try {
          result = questionStore.deleteMany(payload.ids);
          familyResult = detachQuestionFamilyMembers(
            result.deleted.map((question) => question.id),
            "question_deleted",
            currentAdminDisplayName() || "超级管理员",
          );
        } catch (error) {
          [...stores].reverse().forEach((store, reverseIndex) => {
            const snapshotIndex = stores.length - 1 - reverseIndex;
            store.replaceState(beforeState[snapshotIndex]);
          });
          throw error;
        }
        if (result.deleted.length) logOperation({
          action: "question.batch_delete",
          category: "question",
          targetType: "question_batch",
          targetId: result.deleted.map((question) => question.id).join(","),
          summary: `批量删除 ${result.deleted.length} 道题目`,
          metadata: {
            deletedCount: result.deleted.length,
            deletedIds: result.deleted.map((question) => question.id),
            notFoundIds: result.notFoundIds,
            affectedFamilyIds: familyResult.affectedFamilyIds || [],
            emptiedFamilyIds: familyResult.emptiedFamilyIds || [],
            promotedPrototypeMembers: familyResult.promotedPrototypeMembers || [],
          },
        });
        sendJson(response, 200, {
          success: true,
          deletedCount: result.deleted.length,
          deletedIds: result.deleted.map((question) => question.id),
          notFoundIds: result.notFoundIds,
          affectedFamilyIds: familyResult.affectedFamilyIds || [],
          emptiedFamilyIds: familyResult.emptiedFamilyIds || [],
          promotedPrototypeMembers: familyResult.promotedPrototypeMembers || [],
        });
      } catch (error) {
        const status = ["question_merged_source_read_only", "question_merge_target_delete_forbidden"].includes(error.message) ? 409 : 422;
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/questions/batch-transition") {
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const questions = questionStore.transitionMany(payload.ids, payload.action, currentAdminDisplayName() || "超级管理员");
        const familyResult = markQuestionFamilyMembersPending(
          questions.map((question) => question.id),
          `question_${payload.action}`,
          currentAdminDisplayName() || "超级管理员",
        );
        logOperation({
          action: `question.batch_${payload.action}`,
          category: "question",
          targetType: "question_group",
          targetId: questions.map((question) => question.id).join(","),
          summary: `整组${payload.action === "offline" ? "下架" : "恢复"}材料题组（${questions.length} 个作答项）`,
          metadata: {
            action: payload.action,
            questionGroupId: questions[0] && questions[0].questionGroupId || "",
            questionIds: questions.map((question) => question.id),
            affectedFamilyIds: familyResult.affectedFamilyIds || [],
          },
        });
        sendJson(response, 200, {
          success: true,
          count: questions.length,
          questions,
          affectedFamilyIds: familyResult.affectedFamilyIds || [],
        });
      } catch (error) {
        const status = error.message === "question_not_found" ? 404
          : (error.message === "question_merged_source_read_only" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    // 只读：某题的逐选项知识（选项 → 知识关系 / 涉及知识）与主题范围锚点。
    // 数据现状：逐选项知识只存在于"人工确认过的金标审核条目"（humanGold.answerKnowledge.optionKnowledge）；
    // 正式指纹与已存分类结果里都没有该字段。因此本题若未进入金标审核，就如实返回 unavailable，
    // 绝不拿未经确认的 AI 草稿充数。锚点优先取正式指纹（它一直都有）。
    const adminQuestionOptionKnowledgeMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)\/option-knowledge$/);
    if (request.method === "GET" && adminQuestionOptionKnowledgeMatch) {
      const questionId = decodeURIComponent(adminQuestionOptionKnowledgeMatch[1]);
      const question = questionStore.get(questionId);
      if (!question) {
        sendJson(response, 404, { error: "question_not_found" });
        return true;
      }
      let optionKnowledge = [];
      let sourceBatchId = "";
      for (const summary of classificationGoldReviewStore.list() || []) {
        const batch = classificationGoldReviewStore.get(summary.id);
        const item = (batch?.items || []).find((entry) => String(entry.questionId) === questionId);
        const rows = item?.humanGold?.answerKnowledge?.optionKnowledge;
        if (Array.isArray(rows) && rows.length) {
          optionKnowledge = rows;
          sourceBatchId = String(summary.id);
          break;
        }
      }
      const structure = knowledgeStructureStore.get(question.bookId);
      const fingerprint = (structure?.fingerprints || [])
        .find((entry) => entry.questionId === questionId) || null;
      const themeAnchorNodeId = String(fingerprint?.knowledgeThemeRangeAnchorNodeId
        || fingerprint?.themeRangeAnchorNodeId
        || fingerprint?.scopeAnchorNodeId || "");
      const optionsByKey = new Map((question.options || []).map((option) => [String(option.key), option]));
      // 是否落在主题范围锚点之下：在服务端算好（这里能拿到完整知识树），前端就不必依赖页面状态。
      // 判据与后端硬校验一致：沿 parentId 上溯命中锚点即视为在范围内。
      const nodeById = new Map((structure?.nodes || []).map((node) => [String(node.id), node]));
      const withinThemeScope = (nodeId) => {
        if (!themeAnchorNodeId) return false;
        let current = nodeById.get(String(nodeId));
        const guard = new Set();
        while (current && !guard.has(current.id)) {
          guard.add(current.id);
          if (String(current.id) === themeAnchorNodeId) return true;
          current = current.parentId ? nodeById.get(String(current.parentId)) : null;
        }
        return false;
      };
      sendJson(response, 200, {
        questionId,
        available: optionKnowledge.length > 0,
        reason: optionKnowledge.length ? "" : "not_in_gold_review",
        source: optionKnowledge.length ? "human_gold_review" : "",
        batchId: sourceBatchId,
        themeAnchorNodeId,
        problemKnowledgeRangeNodeIds: [...new Set([
          ...((Array.isArray(fingerprint?.problemKnowledgeRangeNodeIds)
            ? fingerprint.problemKnowledgeRangeNodeIds : [])),
          ...((Array.isArray(fingerprint?.requiredNodeIds) ? fingerprint.requiredNodeIds : [])),
        ].map(String).filter(Boolean))],
        requiredNodeIds: [...new Set((fingerprint?.requiredNodeIds || []).map(String).filter(Boolean))],
        primaryNodeId: String(fingerprint?.primaryNodeId || ""),
        options: optionKnowledge.map((row) => ({
          key: String(row.key || ""),
          text: String(optionsByKey.get(String(row.key))?.text || row.text || ""),
          role: String(row.role || ""),
          knowledgeRelation: String(row.knowledgeRelation || ""),
          knowledgeNodeIds: [...new Set((row.knowledgeNodeIds || []).map(String).filter(Boolean))],
          knowledgeLabels: [...new Set((row.knowledgeLabels || []).map(String).filter(Boolean))],
          // 每个选项知识节点是否落在主题锚点之下（服务端判定，前端直接展示，不依赖页面知识树）
          withinThemeScope: (row.knowledgeNodeIds || []).map((nodeId) => withinThemeScope(nodeId)),
          uncertaintyNote: String(row.uncertaintyNote || ""),
        })),
      });
      return true;
    }

    const adminQuestionFingerprintMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)\/knowledge-fingerprint$/);
    if (request.method === "PUT" && adminQuestionFingerprintMatch) {
      try {
        const questionId = decodeURIComponent(adminQuestionFingerprintMatch[1]);
        const payload = await readJsonBody(request, 256 * 1024);
        const question = questionStore.get(questionId);
        if (!question) throw new Error("question_not_found");
        if (mergedQuestionTargetId(question)) throw new Error("question_merged_source_read_only");
        const expectedQuestionVersion = Math.max(0, Number(payload.expectedQuestionVersion) || 0);
        if (expectedQuestionVersion && expectedQuestionVersion !== Number(question.version || 1)) {
          const error = new Error("question_fingerprint_question_version_conflict");
          error.statusCode = 409;
          throw error;
        }
        const bookId = String(payload.bookId || question.bookId || "");
        if (!bookId || bookId !== question.bookId) throw new Error("knowledge_assignment_book_mismatch");
        const structure = knowledgeStructureStore.get(bookId);
        if (!structure) throw new Error("knowledge_structure_not_found");
        const currentFingerprint = (structure.fingerprints || []).find((item) => item.questionId === questionId) || null;
        const currentSignature = currentFingerprint
          ? knowledgeClassificationQuestionBaseline(currentFingerprint, 0).knowledgeFingerprintSignature
          : "";
        if (Object.prototype.hasOwnProperty.call(payload, "expectedFingerprintSignature")
          && String(payload.expectedFingerprintSignature || "") !== currentSignature) {
          const error = new Error("question_fingerprint_revision_conflict");
          error.statusCode = 409;
          throw error;
        }
        const action = ["create", "update", "accept_candidate"].includes(payload.action) ? payload.action : "update";
        if (action === "accept_candidate" && currentFingerprint?.status !== "suggested") {
          const error = new Error("question_fingerprint_candidate_changed");
          error.statusCode = 409;
          throw error;
        }
        const primaryNodeId = String(payload.primaryNodeId || "");
        const hasExplicitPrimaryNodeRole = Object.prototype.hasOwnProperty.call(payload, "primaryNodeRole")
          || Object.prototype.hasOwnProperty.call(payload, "coreKnowledgeRole");
        const hasIndependentScopeFields = Object.prototype.hasOwnProperty.call(payload, "knowledgeThemeRangeAnchorNodeId")
          || Object.prototype.hasOwnProperty.call(payload, "problemKnowledgeRangeNodeIds")
          || Object.prototype.hasOwnProperty.call(payload, "problemKnowledgeNodeIds");
        // New saves keep the core and the theme-range anchor independent. The
        // old scope_anchor role remains readable for historical snapshots.
        const primaryNodeRole = hasIndependentScopeFields
          ? "core"
          : normalizedPrimaryNodeRole(hasExplicitPrimaryNodeRole
            ? (payload.primaryNodeRole || payload.coreKnowledgeRole)
            : currentFingerprint?.primaryNodeRole);
        const requiredNodeIds = [...new Set([
          ...(primaryNodeRole === "core" ? [primaryNodeId] : []),
          ...(Array.isArray(payload.requiredNodeIds)
            ? payload.requiredNodeIds
            : (currentFingerprint?.requiredNodeIds || [])),
        ].map(String).filter(Boolean))];
        // An explicit range/anchor submission is a replacement, not a patch.
        // Otherwise a stale cross-branch node from the previous fingerprint
        // is silently merged back in and can make an otherwise valid theme
        // anchor fail the common-ancestor check.  Keep the old fallback only
        // for legacy clients that omit all independent scope fields.
        const hasExplicitRange = Object.prototype.hasOwnProperty.call(payload, "problemKnowledgeRangeNodeIds")
          || Object.prototype.hasOwnProperty.call(payload, "problemKnowledgeNodeIds");
        const submittedRangeNodeIds = hasExplicitRange
          ? [
            ...(Array.isArray(payload.problemKnowledgeRangeNodeIds) ? payload.problemKnowledgeRangeNodeIds : []),
            ...(Array.isArray(payload.problemKnowledgeNodeIds) ? payload.problemKnowledgeNodeIds : []),
          ]
          : [
            ...(Array.isArray(currentFingerprint?.problemKnowledgeRangeNodeIds)
              ? currentFingerprint.problemKnowledgeRangeNodeIds : []),
          ];
        const problemKnowledgeRangeNodeIds = [...new Set([
          ...submittedRangeNodeIds,
          ...requiredNodeIds,
        ].map(String).filter(Boolean))];
        const hasExplicitThemeAnchor = Object.prototype.hasOwnProperty.call(payload, "knowledgeThemeRangeAnchorNodeId")
          || Object.prototype.hasOwnProperty.call(payload, "themeRangeAnchorNodeId")
          || Object.prototype.hasOwnProperty.call(payload, "scopeAnchorNodeId");
        const knowledgeThemeRangeAnchorNodeId = String(
          hasExplicitThemeAnchor
            ? (payload.knowledgeThemeRangeAnchorNodeId
              ?? payload.themeRangeAnchorNodeId
              ?? payload.scopeAnchorNodeId
              ?? "")
            : (currentFingerprint?.knowledgeThemeRangeAnchorNodeId
              || currentFingerprint?.scopeAnchorNodeId
              || (primaryNodeRole === "scope_anchor" ? primaryNodeId : "")),
        );
        if (!primaryNodeId || !requiredNodeIds.length) throw new Error("knowledge_assignments_required");
        const nodeMap = new Map((structure.nodes || []).map((node) => [node.id, node]));
        const primaryNode = nodeMap.get(primaryNodeId);
        if (!primaryNode) throw new Error("knowledge_node_not_found");
        if (primaryNode.bookId !== bookId) throw new Error("knowledge_assignment_book_mismatch");
        if (primaryNode.kind !== "knowledge") throw new Error("knowledge_assignment_node_required");
        requiredNodeIds.forEach((nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node) throw new Error("knowledge_node_not_found");
          if (node.bookId !== bookId) throw new Error("knowledge_assignment_book_mismatch");
          if (node.kind !== "knowledge") throw new Error("knowledge_assignment_node_required");
        });
        problemKnowledgeRangeNodeIds.forEach((nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node) throw new Error("knowledge_node_not_found");
          if (node.bookId !== bookId) throw new Error("knowledge_assignment_book_mismatch");
          if (node.kind !== "knowledge") throw new Error("knowledge_assignment_node_required");
        });
        if (knowledgeThemeRangeAnchorNodeId) {
          const anchor = nodeMap.get(knowledgeThemeRangeAnchorNodeId);
          if (!anchor) throw new Error("knowledge_node_not_found");
          if (anchor.bookId !== bookId) throw new Error("knowledge_assignment_book_mismatch");
          if (!isKnowledgeThemeRangeAnchorNode(anchor)) throw new Error("knowledge_assignment_node_required");
          if (hasIndependentScopeFields && !knowledgeThemeRangeAnchorMatchesRange(
            nodeMap,
            knowledgeThemeRangeAnchorNodeId,
            problemKnowledgeRangeNodeIds,
            requiredNodeIds,
          )) {
            // 不只报错误码：告诉审核员是哪些节点没被覆盖、以及可以直接采用的候选锚点。
            const evaluated = [...new Set([
              ...problemKnowledgeRangeNodeIds,
              ...requiredNodeIds,
            ].map(String).filter(Boolean))];
            const uncoveredNodeIds = evaluated.filter((nodeId) => {
              let current = nodeMap.get(nodeId);
              while (current) {
                if (current.id === knowledgeThemeRangeAnchorNodeId) return false;
                current = current.parentId ? nodeMap.get(current.parentId) : null;
              }
              return true;
            });
            const commonAncestors = knowledgeCommonAncestorNodes(nodeMap, evaluated);
            const labelOf = (nodeId) => nodeMap.get(nodeId)?.path
              || nodeMap.get(nodeId)?.title || nodeId;
            const error = new Error("knowledge_assignment_theme_anchor_invalid");
            error.details = {
              anchorNodeId: knowledgeThemeRangeAnchorNodeId,
              anchorLabel: labelOf(knowledgeThemeRangeAnchorNodeId),
              uncoveredNodeIds,
              uncoveredLabels: uncoveredNodeIds.map(labelOf),
              validAnchorNodeIds: commonAncestors.map((node) => node.id),
              validAnchorLabels: commonAncestors.map((node) => node.path || node.title || node.id),
            };
            throw error;
          }
        }
        if (primaryNodeRole === "scope_anchor"
          && (requiredNodeIds.includes(primaryNodeId)
            || !knowledgeScopeAnchorMatchesRequired(nodeMap, primaryNodeId, requiredNodeIds))) {
          throw new Error("knowledge_assignment_scope_anchor_invalid");
        }
        const stores = [questionStore, knowledgeStructureStore, questionFamilyStore];
        if (stores.some((store) => typeof store.exportState !== "function" || typeof store.replaceState !== "function")) {
          const error = new Error("question_fingerprint_transaction_required");
          error.statusCode = 503;
          throw error;
        }
        const beforeState = stores.map((store) => store.exportState());
        try {
          const reviewedAt = Date.now();
          const updatedQuestion = questionStore.update(questionId, {
            changeNote: action === "accept_candidate" ? "采纳并确认 AI 知识指纹" : "人工修改正式知识指纹",
          }, currentAdminDisplayName() || "超级管理员");
          const assessmentAction = String(payload.assessmentAction || currentFingerprint?.focus?.action || "").trim();
          const focus = assessmentAction ? {
            ...(currentFingerprint?.focus || {}),
            key: currentFingerprint?.focus?.key || `manual:${primaryNodeId}`,
            label: currentFingerprint?.focus?.label || nodeMap.get(primaryNodeId)?.displayTitle || nodeMap.get(primaryNodeId)?.title || primaryNodeId,
            action: assessmentAction,
            source: action === "accept_candidate" ? "manual_candidate_acceptance" : "manual_question_editor",
          } : null;
          const assigned = knowledgeStructureStore.assignQuestions(bookId, [{
            questionId,
            primaryNodeId,
            primaryNodeRole,
            requiredNodeIds,
            problemKnowledgeRangeNodeIds,
            knowledgeThemeRangeAnchorNodeId,
            // 逐选项知识：编辑页表格提交的载荷（形状 option-knowledge-v2）。
            // 缺省时不要覆盖既有值（前端在无数据时不会提交该键）。
            ...(Array.isArray(payload.optionKnowledge) && payload.optionKnowledge.length
              ? { optionKnowledge: payload.optionKnowledge } : {}),
            focus,
            evidenceChunkIds: currentFingerprint?.evidenceChunkIds || [],
            questionVersion: updatedQuestion.version,
            revision: Math.max(0, Number(currentFingerprint?.revision) || 0) + 1,
            reviewedBy: currentAdminDisplayName() || "超级管理员",
            reviewedAt,
            source: action === "accept_candidate" ? "manual_candidate_acceptance" : "manual_question_editor",
          }]);
          const familyResult = typeof questionFamilyStore.markPendingForQuestions === "function"
            ? questionFamilyStore.markPendingForQuestions([questionId], "question_knowledge_updated", currentAdminDisplayName() || "超级管理员")
            : { affectedFamilyIds: [] };
          const decoratedQuestion = withQuestionFamilyMemberships([updatedQuestion])[0];
          logOperation({
            action: "question.knowledge_fingerprint_update",
            category: "question",
            targetType: "knowledge_fingerprint",
            targetId: questionId,
            summary: `更新题目正式知识指纹并升版至 v${updatedQuestion.version}`,
            metadata: {
              bookId,
              questionId,
              questionVersion: updatedQuestion.version,
              fingerprintRevision: Math.max(0, Number(currentFingerprint?.revision) || 0) + 1,
              primaryNodeId,
              primaryNodeRole,
              requiredNodeIds,
              problemKnowledgeRangeNodeIds,
              knowledgeThemeRangeAnchorNodeId,
              action,
              previousFingerprintSignature: currentSignature,
              affectedFamilyIds: familyResult.affectedFamilyIds || [],
            },
          });
          sendJson(response, 200, {
            success: true,
            question: decoratedQuestion,
            structure: assigned.structure,
            assignment: assigned.assignments[0],
            affectedFamilyIds: familyResult.affectedFamilyIds || [],
          });
        } catch (error) {
          [...stores].reverse().forEach((store, index) => {
            const snapshotIndex = stores.length - 1 - index;
            store.replaceState(beforeState[snapshotIndex]);
          });
          throw error;
        }
      } catch (error) {
        sendJson(response, Number(error.statusCode) || (error.message === "question_not_found" ? 404
          : (error.message === "question_merged_source_read_only" ? 409 : 422)), {
          success: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return;
    }

    const adminQuestionMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)$/);
    if (request.method === "GET" && adminQuestionMatch) {
      const question = questionStore.get(decodeURIComponent(adminQuestionMatch[1]));
      const decorated = question ? withQuestionFamilyMemberships([question])[0] : null;
      sendJson(response, decorated ? 200 : 404, decorated ? { success: true, question: decorated } : { success: false, error: "question_not_found" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/questions/import-text") {
      try {
        const payload = await readJsonBody(request, 8 * 1024 * 1024);
        const candidates = parseQuestionImportText(payload.text, {
          subjectId: payload.defaults && payload.defaults.subjectId,
          bookId: payload.defaults && payload.defaults.bookId,
          chapter: payload.defaults && payload.defaults.chapter,
          sourceLabel: payload.defaults && payload.defaults.sourceLabel,
          sourcePage: payload.defaults && payload.defaults.sourcePage,
          changeNote: "批量文本导入",
        });
        if (payload.dryRun !== false) {
          const preview = questionStore.previewImport(candidates, currentAdminDisplayName() || "超级管理员");
          const comparisonQuestion = (question) => question ? ({
            id: question.id,
            library: question.library,
            status: question.status,
            type: question.type,
            typeLabel: question.typeLabel,
            stem: question.stem,
            options: question.options,
            correctAnswer: question.correctAnswer,
            referenceAnswer: question.referenceAnswer,
            chapter: question.chapter,
            knowledgePoints: question.knowledgePoints,
            maxScore: question.maxScore,
            sourceLabel: question.sourceLabel,
            sourcePage: question.sourcePage,
          }) : null;
          sendJson(response, 200, {
            success: true,
            total: preview.length,
            validCount: preview.filter((item) => item.valid).length,
            duplicateCount: preview.filter((item) => item.duplicate).length,
            storedDuplicateCount: preview.filter((item) => item.duplicate && item.duplicateScope === "stored").length,
            batchDuplicateCount: preview.filter((item) => item.duplicate && item.duplicateScope === "batch").length,
            errorCount: preview.filter((item) => !item.valid && !item.duplicate).length,
            items: preview.map((item) => (item.valid ? {
              index: item.index,
              valid: true,
              stem: item.question.stem,
              typeLabel: item.question.typeLabel,
              chapter: item.question.chapter,
              knowledgePoints: item.question.knowledgePoints,
              maxScore: item.question.maxScore,
              scoringPointStatus: item.question.scoringPointStatus,
              scoringPointCandidateCount: item.question.scoringPointCandidates?.length || 0,
              sourceRange: item.sourceRange,
            } : (item.duplicate ? {
              index: item.index,
              valid: false,
              duplicate: true,
              duplicateOf: item.duplicateOf,
              duplicateScope: item.duplicateScope,
              duplicateIndex: item.duplicateIndex,
              error: item.error,
              sourceRange: item.sourceRange,
              source: item.source,
              comparison: {
                incoming: comparisonQuestion(item.question),
                existing: comparisonQuestion(item.existingQuestion),
              },
            } : item))),
          });
        } else {
          const result = questionStore.importMany(candidates, currentAdminDisplayName() || "超级管理员");
          if (result.created.length) logOperation({
            action: "question.import",
            category: "question",
            targetType: "question_batch",
            targetId: result.batchId,
            summary: `批量导入 ${result.created.length} 道平台题目`,
            metadata: { batchId: result.batchId, total: result.total, createdCount: result.created.length, duplicateCount: result.duplicates.length, errorCount: result.errors.length },
          });
          sendJson(response, 201, {
            success: true,
            total: result.total,
            createdCount: result.created.length,
            duplicateCount: result.duplicates.length,
            storedDuplicateCount: result.duplicates.filter((item) => item.duplicateScope === "stored").length,
            batchDuplicateCount: result.duplicates.filter((item) => item.duplicateScope === "batch").length,
            errorCount: result.errors.length,
            createdIds: result.created.map((question) => question.id),
            batchId: result.batchId,
            errors: result.errors,
            duplicates: result.duplicates,
          });
        }
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/questions") {
      try {
        const payload = await readJsonBody(request);
        const hasMemberships = Object.prototype.hasOwnProperty.call(payload, "familyMemberships");
        const assignment = hasMemberships
          ? resolveQuestionFamilyAssignment(payload.bookId, payload.familyMemberships)
          : null;
        const questionPayload = { ...payload, ...(assignment?.knowledgePatch || {}) };
        delete questionPayload.familyMemberships;
        const question = questionStore.create(questionPayload, currentAdminDisplayName() || "超级管理员");
        const membershipResult = assignment && typeof questionFamilyStore.setMemberships === "function"
          ? questionFamilyStore.setMemberships(question, assignment.selections, currentAdminDisplayName() || "超级管理员")
          : { memberships: [], affectedFamilyIds: [] };
        logOperation({ action: "question.create", category: "question", targetType: "question", targetId: question.id, summary: `录入平台题目：${question.stem}`, metadata: { subjectId: question.subjectId, bookId: question.bookId, type: question.type } });
        sendJson(response, 201, {
          success: true,
          question: { ...question, familyMemberships: membershipResult.memberships },
          affectedFamilyIds: membershipResult.affectedFamilyIds,
        });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "PUT" && adminQuestionMatch) {
      try {
        const payload = await readJsonBody(request);
        const questionId = decodeURIComponent(adminQuestionMatch[1]);
        const previous = questionStore.get(questionId);
        if (!previous) throw new Error("question_not_found");
        const hasMemberships = Object.prototype.hasOwnProperty.call(payload, "familyMemberships");
        const targetBookId = String(payload.bookId || previous.bookId || "");
        const assignment = hasMemberships
          ? resolveQuestionFamilyAssignment(targetBookId, payload.familyMemberships)
          : null;
        const questionPayload = { ...payload, ...(assignment?.knowledgePatch || {}) };
        delete questionPayload.familyMemberships;
        const stores = [questionStore, questionFamilyStore];
        const beforeState = stores.map((store) => store.exportState());
        let question;
        let membershipResult;
        let affectedFamilyIds;
        try {
          question = questionStore.update(questionId, questionPayload, currentAdminDisplayName() || "超级管理员");
          const catalogChanged = previous.subjectId !== question.subjectId || previous.bookId !== question.bookId;
          const familySensitiveChange = questionFamilySensitiveSnapshot(previous) !== questionFamilySensitiveSnapshot(question);
          const contentResult = catalogChanged
            ? detachQuestionFamilyMembers([question.id], "question_catalog_updated", currentAdminDisplayName() || "超级管理员")
            : (familySensitiveChange
              ? markQuestionFamilyMembersPending([question.id], "question_content_updated", currentAdminDisplayName() || "超级管理员")
              : { affectedFamilyIds: [] });
          membershipResult = assignment && typeof questionFamilyStore.setMemberships === "function"
            ? questionFamilyStore.setMemberships(question, assignment.selections, currentAdminDisplayName() || "超级管理员")
            : { memberships: withQuestionFamilyMemberships([question])[0].familyMemberships, affectedFamilyIds: [] };
          affectedFamilyIds = [...new Set([
            ...(contentResult.affectedFamilyIds || []),
            ...(membershipResult.affectedFamilyIds || []),
          ])];
        } catch (error) {
          [...stores].reverse().forEach((store, reverseIndex) => {
            const snapshotIndex = stores.length - 1 - reverseIndex;
            store.replaceState(beforeState[snapshotIndex]);
          });
          throw error;
        }
        logOperation({ action: "question.update", category: "question", targetType: "question", targetId: question.id, summary: `更新题目至 v${question.version}：${question.stem}`, metadata: { version: question.version, changeNote: payload.changeNote, affectedFamilyIds } });
        sendJson(response, 200, {
          success: true,
          question: { ...question, familyMemberships: membershipResult.memberships },
          affectedFamilyIds,
        });
      } catch (error) {
        const status = error.message === "question_not_found" ? 404
          : (error.message === "question_merged_source_read_only" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const questionMergeMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)\/merge$/);
    if (request.method === "POST" && questionMergeMatch) {
      if (options.persistence) {
        sendJson(response, 503, { success: false, error: "question_merge_commit_postgres_transaction_required" });
        return;
      }
      try {
        const payload = await readJsonBody(request, 512 * 1024);
        const sourceQuestionId = decodeURIComponent(questionMergeMatch[1]);
        const targetQuestionId = String(payload.targetQuestionId || "").trim();
        const commitId = String(payload.commitId || "").trim().slice(0, 160);
        const reason = String(payload.reason || "").trim().slice(0, 1000);
        const sourceVersion = Number(payload.sourceVersion);
        const targetVersion = Number(payload.targetVersion);
        const preferredKnowledgeNodeId = String(payload.preferredKnowledgeNodeId || "").trim();
        const primaryFamilyId = String(payload.primaryFamilyId || "").trim();
        if (payload.schemaVersion !== QUESTION_MERGE_COMMIT_SCHEMA_VERSION) throw new Error("question_merge_schema_version_invalid");
        if (!commitId) throw new Error("question_merge_commit_identity_required");
        if (!targetQuestionId) throw new Error("question_merge_target_not_found");
        if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || !Number.isInteger(targetVersion) || targetVersion < 1) {
          throw new Error("question_merge_versions_required");
        }
        if (!reason) throw new Error("question_merge_reason_required");
        const commitRequest = {
          schemaVersion: QUESTION_MERGE_COMMIT_SCHEMA_VERSION,
          sourceQuestionId,
          targetQuestionId,
          sourceVersion,
          targetVersion,
          reason,
          preferredKnowledgeNodeId,
          primaryFamilyId,
        };
        const requestHash = questionMergeCommitRequestHash(commitRequest);
        const result = await questionMergeCoordinator.execute({
          commitId,
          requestHash,
          mode: options.aiConfigStore ? "memory_rollback" : "file_rollback",
          sourceQuestionId,
          targetQuestionId,
          actor: currentAdminDisplayName() || "超级管理员",
          reason,
          dependencies: { sourceVersion, targetVersion },
          request: commitRequest,
        }, ({ currentState }) => {
          const transformed = transformQuestionMerge(currentState, {
            ...commitRequest,
            actor: currentAdminDisplayName() || "超级管理员",
            mergedAt: Date.now(),
          });
          questionMergeCoordinator.applyStates({ ...currentState, ...transformed.nextStates });
          const operation = logOperation({
            action: "question.merge",
            category: "question",
            targetType: "question",
            targetId: targetQuestionId,
            summary: `合并重复题 ${sourceQuestionId} 至 ${targetQuestionId}，源题已下架`,
            metadata: {
              commitId,
              sourceQuestionId,
              targetQuestionId,
              sourceVersion,
              targetVersion,
              reason,
              preferredKnowledgeNodeId,
              primaryFamilyId,
              ...transformed.summary,
            },
          });
          return {
            response: {
              success: true,
              schemaVersion: QUESTION_MERGE_COMMIT_SCHEMA_VERSION,
              commitId,
              summary: transformed.summary,
              sourceQuestion: questionStore.get(sourceQuestionId),
              targetQuestion: questionStore.get(targetQuestionId),
              operationId: operation.id,
            },
          };
        });
        sendJson(response, 200, { ...result.response, replayed: result.replayed });
      } catch (error) {
        const notFound = new Set([
          "question_merge_source_not_found",
          "question_merge_target_not_found",
          "question_merge_knowledge_structure_not_found",
          "question_merge_knowledge_node_not_found",
        ]);
        const conflict = new Set([
          "question_merge_commit_request_mismatch",
          "question_merge_source_version_conflict",
          "question_merge_target_version_conflict",
          "question_merge_source_already_merged",
          "question_merge_target_already_merged",
          "question_merge_chain_not_allowed",
          "question_merge_primary_family_conflict",
        ]);
        const status = error.statusCode || (notFound.has(error.message) ? 404 : (conflict.has(error.message) ? 409 : 422));
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    const questionTransitionMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)\/transition$/);
    if (request.method === "POST" && questionTransitionMatch) {
      try {
        const payload = await readJsonBody(request);
        const question = questionStore.transition(decodeURIComponent(questionTransitionMatch[1]), payload.action, currentAdminDisplayName() || "超级管理员");
        const affectedFamilyIds = typeof questionFamilyStore.markPendingForQuestions === "function"
          ? questionFamilyStore.markPendingForQuestions([question.id], `question_${payload.action}`, currentAdminDisplayName() || "超级管理员").affectedFamilyIds
          : [];
        logOperation({ action: `question.${payload.action}`, category: "question", targetType: "question", targetId: question.id, summary: `${question.stem} · 状态更新为 ${question.status}`, metadata: { status: question.status, library: question.library, version: question.version, affectedFamilyIds } });
        sendJson(response, 200, { success: true, question, affectedFamilyIds });
      } catch (error) {
        const status = error.message === "question_not_found" ? 404
          : (error.message === "question_merged_source_read_only" ? 409 : 422);
        sendJson(response, status, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/ai-tasks") {
      sendJson(response, 200, {
        success: true,
        ...aiTaskStore.dashboard({
          status: url.searchParams.get("status") || "all",
          sceneId: url.searchParams.get("sceneId") || "all",
          limit: url.searchParams.get("limit") || 100,
        }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/billing") {
      const userId = url.searchParams.get("userId") || "test-user";
      sendJson(response, 200, { success: true, ...billingStore.dashboard(userId) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/billing/products") {
      try {
        const payload = await readJsonBody(request);
        const product = billingStore.upsertProduct(payload);
        logOperation({ action: payload.id ? "billing.product_update" : "billing.product_create", category: "billing", targetType: "product", targetId: product.id, summary: `${payload.id ? "更新" : "创建"}订阅商品：${product.name}`, metadata: { productType: product.productType, priceCents: product.priceCents, active: product.active } });
        sendJson(response, 200, { success: true, product });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    const billingProductActionMatch = url.pathname.match(/^\/api\/admin\/billing\/products\/([^/]+)\/action$/);
    if (request.method === "POST" && billingProductActionMatch) {
      try {
        const payload = await readJsonBody(request);
        const productId = decodeURIComponent(billingProductActionMatch[1]);
        const product = billingStore.setProductActive(productId, payload.action === "enable");
        logOperation({ action: `billing.product_${product.active ? "enable" : "disable"}`, category: "billing", targetType: "product", targetId: product.id, summary: `${product.active ? "上架" : "停用"}商品：${product.name}`, metadata: { active: product.active } });
        sendJson(response, 200, { success: true, product });
      } catch (error) {
        sendJson(response, error.message === "billing_product_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    const billingGrantProductMatch = url.pathname.match(/^\/api\/admin\/billing\/users\/([^/]+)\/grant-product$/);
    if (request.method === "POST" && billingGrantProductMatch) {
      try {
        const payload = await readJsonBody(request);
        const userId = decodeURIComponent(billingGrantProductMatch[1]);
        const result = billingStore.grantProduct(userId, String(payload.productId || ""), "admin_simulation");
        logOperation({ action: "billing.product_grant", category: "billing", targetType: "user", targetId: userId, summary: `为 ${userId} 模拟开通：${result.product.name}`, metadata: { productId: result.product.id, expiresAt: result.entitlement && result.entitlement.expiresAt, creditAmount: result.creditGrant && result.creditGrant.lot.grantedAmount } });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, error.message === "billing_product_not_found" ? 404 : 422, { success: false, error: error.message });
      }
      return;
    }

    const billingGrantCreditsMatch = url.pathname.match(/^\/api\/admin\/billing\/users\/([^/]+)\/grant-credits$/);
    if (request.method === "POST" && billingGrantCreditsMatch) {
      try {
        const payload = await readJsonBody(request);
        const userId = decodeURIComponent(billingGrantCreditsMatch[1]);
        const expiresAt = Number(payload.validityDays) > 0 ? Date.now() + Number(payload.validityDays) * 24 * 60 * 60 * 1000 : null;
        const result = billingStore.grantCredits(userId, {
          amount: payload.amount,
          source: String(payload.source || "admin_adjustment"),
          sourceLabel: String(payload.description || "管理员发放"),
          description: String(payload.description || "管理员发放"),
          expiresAt,
          referenceId: `admin-credit-${Date.now()}`,
        });
        logOperation({ action: "billing.credit_grant", category: "billing", targetType: "user", targetId: userId, summary: `为 ${userId} 发放 ${result.lot.grantedAmount} 点 AI 额度`, metadata: { source: result.lot.source, expiresAt: result.lot.expiresAt, balanceAfter: result.balanceAfter } });
        sendJson(response, 200, { success: true, ...result });
      } catch (error) {
        sendJson(response, 422, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/ai-config") {
      sendJson(response, 200, sanitizeConfig(aiConfigStore.load()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/ai/providers") {
      try {
        const payload = await readJsonBody(request);
        const { config, provider } = upsertProvider(aiConfigStore.load(), payload);
        const savedConfig = aiConfigStore.save(config);
        const sanitizedProvider = sanitizeConfig(savedConfig).providers.find((item) => item.id === provider.id);
        logOperation({ action: payload.id ? "ai_provider.update" : "ai_provider.create", category: "ai_config", targetType: "ai_provider", targetId: provider.id, summary: `${payload.id ? "更新" : "新增"}模型供应商：${provider.name}`, metadata: { protocol: provider.protocol, models: provider.models, enabled: provider.enabled } });
        sendJson(response, 200, { success: true, provider: sanitizedProvider });
      } catch (error) {
        sendJson(response, 400, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/ai/models") {
      try {
        const payload = await readJsonBody(request);
        const config = aiConfigStore.load();
        const savedProvider = config.providers.find((item) => item.id === payload.providerId);
        const baseUrl = String(payload.baseUrl || (savedProvider && savedProvider.baseUrl) || "").trim().replace(/\/$/, "");
        const apiKey = normalizeApiKey(payload.apiKey) || normalizeApiKey(savedProvider && savedProvider.apiKey);
        let parsedUrl;
        try {
          parsedUrl = new URL(baseUrl);
        } catch (error) {
          throw new Error("invalid_provider_base_url");
        }
        if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("invalid_provider_base_url");
        if (!apiKey) throw new Error("provider_api_key_required");
        const provider = {
          protocol: normalizeProtocol(payload.protocol || (savedProvider && savedProvider.protocol)),
          baseUrl,
          apiKey,
          timeoutMs: Math.min(120000, Math.max(3000, Number(payload.timeoutMs) || (savedProvider && savedProvider.timeoutMs) || 30000)),
        };
        const models = await listProviderModels(provider);
        sendJson(response, 200, { success: true, models });
      } catch (error) {
        sendJson(response, 502, { success: false, error: error.message });
      }
      return;
    }

    const providerDeleteMatch = url.pathname.match(/^\/api\/admin\/ai\/providers\/([^/]+)$/);
    if (request.method === "DELETE" && providerDeleteMatch) {
      try {
        const providerId = decodeURIComponent(providerDeleteMatch[1]);
        const currentProvider = aiConfigStore.load().providers.find((item) => item.id === providerId);
        const nextConfig = removeProvider(aiConfigStore.load(), providerId);
        aiConfigStore.save(nextConfig);
        logOperation({ action: "ai_provider.delete", category: "ai_config", targetType: "ai_provider", targetId: providerId, summary: `删除模型供应商：${currentProvider ? currentProvider.name : providerId}` });
        sendJson(response, 200, { success: true });
      } catch (error) {
        sendJson(response, error.message === "provider_not_found" ? 404 : 400, { success: false, error: error.message });
      }
      return;
    }

    const sceneLabelMatch = url.pathname.match(/^\/api\/admin\/ai\/scenes\/([^/]+)\/label$/);
    if (request.method === "PUT" && sceneLabelMatch) {
      try {
        const payload = await readJsonBody(request);
        const sceneId = decodeURIComponent(sceneLabelMatch[1]);
        const savedConfig = aiConfigStore.save(updateSceneLabel(aiConfigStore.load(), sceneId, payload));
        const scene = sanitizeConfig(savedConfig).sceneDefinitions.find((item) => item.id === sceneId);
        logOperation({ action: "ai_scene_label.update", category: "ai_config", targetType: "ai_scene", targetId: sceneId, summary: `更新 AI 场景显示名：${scene ? scene.label : sceneId}`, metadata: { label: scene ? scene.label : "", customized: !!savedConfig.sceneLabels[sceneId] } });
        sendJson(response, 200, { success: true, scene });
      } catch (error) {
        sendJson(response, 400, { success: false, error: error.message });
      }
      return;
    }

    const routeUpdateMatch = url.pathname.match(/^\/api\/admin\/ai\/routes\/([^/]+)$/);
    if (request.method === "PUT" && routeUpdateMatch) {
      try {
        const payload = await readJsonBody(request);
        const sceneId = decodeURIComponent(routeUpdateMatch[1]);
        const nextConfig = updateRoute(aiConfigStore.load(), sceneId, payload);
        const savedConfig = aiConfigStore.save(nextConfig);
        logOperation({ action: "ai_route.update", category: "ai_config", targetType: "ai_scene", targetId: sceneId, summary: `更新 AI 场景路由：${sceneId}`, metadata: { mode: savedConfig.routes[sceneId].mode, providerId: savedConfig.routes[sceneId].providerId, model: savedConfig.routes[sceneId].model } });
        sendJson(response, 200, { success: true, route: savedConfig.routes[sceneId] });
      } catch (error) {
        sendJson(response, 400, { success: false, error: error.message });
      }
      return;
    }

    const promptUpdateMatch = url.pathname.match(/^\/api\/admin\/ai\/prompts\/([^/]+)$/);
    if (request.method === "PUT" && promptUpdateMatch) {
      try {
        const payload = await readJsonBody(request);
        const sceneId = decodeURIComponent(promptUpdateMatch[1]);
        const nextConfig = updatePrompt(aiConfigStore.load(), sceneId, payload);
        const savedConfig = aiConfigStore.save(nextConfig);
        logOperation({ action: "ai_prompt.update", category: "ai_config", targetType: "ai_scene", targetId: sceneId, summary: `更新 AI 提示词：${sceneId}`, metadata: { version: savedConfig.prompts[sceneId].version } });
        sendJson(response, 200, { success: true, prompt: savedConfig.prompts[sceneId] });
      } catch (error) {
        sendJson(response, 400, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/ai/test") {
      let task = null;
      try {
        const payload = await readJsonBody(request);
        const config = aiConfigStore.load();
        const provider = config.providers.find((item) => item.id === payload.providerId);
        const model = String(payload.model || "").trim();
        // 连通性测试是一条正式场景路由：提示词、温度与最大 Token 都由
        // 「供应商连通性测试」决定，被测供应商与模型仍由调用方指定。
        const testRoute = config.routes.provider_connection_test || {};
        const testPrompt = config.prompts.provider_connection_test || {};
        const viaTestRoute = payload.viaTestRoute === true;
        task = aiTaskStore.start(aiTaskMetadata(config, "provider_connection_test", payload, {
          providerId: provider && provider.id,
          providerName: provider && provider.name,
          protocol: provider && provider.protocol,
          model,
          inputSummary: {
            source: "admin",
            viaTestRoute,
            ...(payload.sceneId ? { requestedSceneId: String(payload.sceneId) } : {}),
          },
        }));
        if (!provider || !provider.enabled) throw new Error("provider_not_found_or_disabled");
        if (!provider.models.includes(model)) throw new Error("provider_model_not_found");
        const result = await testProvider(provider, model, {
          systemPrompt: testPrompt.systemPrompt,
          userPrompt: renderPromptTemplate(testPrompt.userPromptTemplate || "", { providerName: provider.name, model }),
          temperature: testRoute.temperature,
          maxTokens: testRoute.maxTokens,
        });
        aiTaskStore.finish(task.id, {
          status: "succeeded",
          chargeable: false,
          usage: result.usage,
          outputChars: String(result.preview || "").length,
        });
        sendJson(response, 200, {
          success: true,
          result: { ...result, providerId: provider.id, providerName: provider.name, viaTestRoute },
        });
      } catch (error) {
        if (task) aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "connection_test" });
        sendJson(response, 502, { success: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/card-memory-assistance") {
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 400, {
          success: false, chargeable: false, error: error.message,
        });
        return;
      }

      // 封禁账号不能用付费 AI 功能（也会消耗额度）。
      if (guardBannedUser(response, request, payload.userId)) return;
      const requestedFeature = String(payload.requestedFeature || "").trim();
      const question = typeof payload.question === "string" ? payload.question : "";
      if ((requestedFeature === "cloze" || requestedFeature === "highlight") && !question.trim()) {
        sendJson(response, 400, {
          success: false,
          chargeable: false,
          error: "card_assistance_question_required",
        });
        return;
      }

      let source;
      try {
        source = buildCardAssistanceSource(
          question,
          payload.answer,
        );
      } catch (error) {
        sendJson(response, error.message === "card_assistance_source_too_long" ? 413 : 400, {
          success: false, chargeable: false, error: error.message,
        });
        return;
      }

      const config = aiConfigStore.load();
      const scene = configuredScene(config, "card_memory_assistance", "knowledge_note_extraction");
      if (!scene) {
        sendJson(response, 503, {
          success: false,
          chargeable: false,
          error: "card_memory_assistance_route_unavailable",
        });
        return;
      }
      const authenticated = userAuthStore.authenticate(bearerToken(request));
      // 缓存作用域：有会话用会话身份；匿名只在非正式环境沿用 test-user，正式环境归入 anonymous，避免冒名污染他人缓存。
      const userScope = String(authenticated && authenticated.user && authenticated.user.id
        || (developmentIdentityAllowed() ? payload.userId || "test-user" : "anonymous")).slice(0, 160);
      const cacheKey = cardAssistanceCacheKey(source, scene, userScope);
      const requestId = String(payload.requestId || `card-memory-${Date.now()}`);
      const resultForResponse = (result) => ({ ...result, requestId });
      const cached = cachedCardAssistance(cacheKey);
      if (cached) {
        sendJson(response, 200, {
          success: true,
          schemaVersion: CARD_ASSISTANCE_SCHEMA_VERSION,
          chargeable: false,
          result: resultForResponse(cached.result),
          generation: { source: "cache", cacheHit: true, billingReferenceId: "" },
        });
        return;
      }

      const activeGeneration = activeCardAssistanceGenerations.get(cacheKey);
      if (activeGeneration) {
        try {
          const generated = await activeGeneration;
          sendJson(response, 200, {
            success: true,
            schemaVersion: CARD_ASSISTANCE_SCHEMA_VERSION,
            chargeable: false,
            model: generated.completion.model,
            usage: generated.completion.usage,
            result: resultForResponse(generated.result),
            generation: { source: "inflight_cache", cacheHit: true, billingReferenceId: "" },
          });
        } catch (error) {
          sendJson(response, error.message === "provider_output_format_error" ? 422 : 502, {
            success: false, chargeable: false, error: error.message,
          });
        }
        return;
      }

      const task = aiTaskStore.start(aiTaskMetadata(config, "card_memory_assistance", { ...payload, requestId }, {
        providerId: scene.provider.id,
        providerName: scene.provider.name,
        protocol: scene.provider.protocol,
        model: scene.route.model,
        mode: "provider",
        inputSummary: {
          requestedFeature: String(payload.requestedFeature || ""),
          questionChars: source.question.length,
          answerChars: source.answer.length,
          pointCount: source.points.length,
          configuredSceneId: scene.configuredSceneId,
        },
      }));
      const generation = (async () => {
        const upstreamStartedAt = Date.now();
        try {
          const outputTokenBudget = Math.min(
            Number(scene.route.maxTokens) || 1800,
            Math.max(1200, 1200 + (source.points.length * 500)),
          );
          const completions = [];
          let completed;
          let result;
          let parseMs = 0;
          let normalizeMs = 0;
          for (let outputAttempt = 0; outputAttempt < 2; outputAttempt += 1) {
            const prompt = outputAttempt === 0 ? scene.prompt : {
              ...scene.prompt,
              systemPrompt: `${scene.prompt.systemPrompt}\n上一次输出未通过范围、数量或覆盖校验。请重新独立生成完整 JSON，尤其检查每个分点的短语长度、role、clozes 包含关系、数量与覆盖率；不要复述或解释错误。`,
            };
            completed = await completePromptWithTransientRetry(
              { ...scene.provider, timeoutMs: Math.max(60000, Number(scene.provider.timeoutMs) || 0) },
              { ...scene.route, temperature: 0, maxTokens: outputTokenBudget, reasoningEffort: "low" },
              prompt,
              {
                question: source.question || "（未填写问题）",
                answerPoints: source.points,
                requiredOutput: cardAssistanceRequiredOutput,
              },
              ({ attempt, error }) => aiTaskStore.update(task.id, {
                inputSummary: { retryCount: attempt, firstFailure: String(error.message || error) },
              }),
              { jsonMode: true },
            );
            completions.push(completed.completion);
            try {
              const parseStartedAt = Date.now();
              const raw = parseJsonContent(completed.completion.content);
              parseMs += Date.now() - parseStartedAt;
              const normalizeStartedAt = Date.now();
              result = normalizeCardAssistanceOutput(raw, source);
              normalizeMs += Date.now() - normalizeStartedAt;
              break;
            } catch (error) {
              if (error.message !== "provider_output_format_error" || outputAttempt > 0) throw error;
              aiTaskStore.update(task.id, { inputSummary: { outputValidationRetryCount: 1 } });
            }
          }
          const usage = completions.reduce((total, completion) => {
            Object.entries(completion.usage || {}).forEach(([key, value]) => {
              if (Number.isFinite(Number(value))) total[key] = Number(total[key] || 0) + Number(value);
              else if (total[key] === undefined) total[key] = value;
            });
            return total;
          }, {});
          const normalizedUsage = Object.keys(usage).length ? usage : null;
          cacheCardAssistance(cacheKey, result);
          aiTaskStore.finish(task.id, {
            status: "succeeded",
            chargeable: true,
            usage: normalizedUsage,
            outputChars: completions.reduce((total, completion) => total + completion.content.length, 0),
            timings: { upstreamMs: Date.now() - upstreamStartedAt, parseMs, normalizeMs },
          });
          return { result, completion: { ...completed.completion, usage: normalizedUsage } };
        } catch (error) {
          aiTaskStore.finish(task.id, {
            status: "failed",
            errorCode: error.message,
            failureStage: error.message === "provider_output_format_error" ? "output_validation" : "upstream_completion",
            timings: { upstreamMs: Date.now() - upstreamStartedAt },
          });
          throw error;
        }
      })();
      activeCardAssistanceGenerations.set(cacheKey, generation);
      try {
        const generated = await generation;
        sendJson(response, 200, {
          success: true,
          schemaVersion: CARD_ASSISTANCE_SCHEMA_VERSION,
          chargeable: true,
          provider: scene.provider.id,
          model: generated.completion.model,
          usage: generated.completion.usage,
          result: resultForResponse(generated.result),
          generation: {
            id: task.id,
            source: "model",
            cacheHit: false,
            billingReferenceId: task.requestId,
          },
        });
      } catch (error) {
        sendJson(response, error.message === "provider_output_format_error" ? 422 : 502, {
          success: false, chargeable: false, error: error.message,
        });
      } finally {
        if (activeCardAssistanceGenerations.get(cacheKey) === generation) {
          activeCardAssistanceGenerations.delete(cacheKey);
        }
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/learning-diagnosis") {
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 400, {
          success: false, chargeable: false, error: error.message,
        });
        return;
      }
      if (guardBannedUser(response, request, payload.userId)) return;
      const config = aiConfigStore.load();
      const route = config.routes.learning_diagnosis;
      const provider = route && route.mode === "provider"
        ? config.providers.find((item) => item.id === route.providerId && item.enabled)
        : null;
      const subject = String(payload.subject || "").trim();
      if (!subject || !provider) {
        sendJson(response, provider ? 400 : 503, {
          success: false,
          chargeable: false,
          error: provider ? "invalid_learning_diagnosis_request" : "learning_diagnosis_route_unavailable",
        });
        return;
      }
      const task = aiTaskStore.start(aiTaskMetadata(config, "learning_diagnosis", payload, {
        inputSummary: {
          subject,
          unitCount: Array.isArray(payload.unitProfile) ? payload.unitProfile.length : 0,
          wrongQuestionCount: Array.isArray(payload.recentWrongQuestions) ? payload.recentWrongQuestions.length : 0,
        },
      }));
      try {
        const completion = await completePromptWithProvider(
          provider,
          route,
          config.prompts.learning_diagnosis,
          {
            subject,
            unitProfile: payload.unitProfile || [],
            recentWrongQuestions: payload.recentWrongQuestions || [],
            missingPoints: payload.missingPoints || [],
            errorAttributions: payload.errorAttributions || [],
          },
        );
        aiTaskStore.finish(task.id, {
          status: "succeeded",
          chargeable: true,
          usage: completion.usage,
          outputChars: completion.content.length,
        });
        sendJson(response, 200, {
          success: true,
          chargeable: true,
          model: completion.model,
          usage: completion.usage,
          result: { requestId: payload.requestId || `learning-diagnosis-${Date.now()}`, text: completion.content, basis: "AI 补充" },
        });
      } catch (error) {
        aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "upstream_diagnosis" });
        sendJson(response, 502, { success: false, chargeable: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/explain/stream") {
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 400, {
          success: false,
          chargeable: false,
          error: error.message,
        });
        return;
      }
      if (guardBannedUser(response, request, payload.userId)) return;
      const config = aiConfigStore.load();
      const task = aiTaskStore.start(aiTaskMetadata(config, "explanation_chat", payload, {
        streaming: true,
        inputSummary: {
          questionId: String(payload.questionId || ""),
          messageChars: String(payload.userMessage || "").length,
          answerChars: String(payload.userAnswer || "").length,
          conversationTurns: Array.isArray(payload.conversationHistory) ? payload.conversationHistory.length : 0,
        },
      }));
      response.once("close", () => {
        aiTaskStore.finish(task.id, {
          status: "failed",
          errorCode: "client_disconnected",
          failureStage: "client_stream",
        });
      });
      let context;
      let retrievalMs = 0;
      let contextMs = 0;
      try {
        const storedQuestion = questionStore.get(payload.questionId);
        const retrievalStartedAt = Date.now();
        const evidenceChunks = retrieveQuestionEvidence(storedQuestion, payload.userMessage, 4);
        retrievalMs = Date.now() - retrievalStartedAt;
        const contextStartedAt = Date.now();
        context = explanationContext(config, payload, clientQuestionPayload(storedQuestion), evidenceChunks);
        contextMs = Date.now() - contextStartedAt;
        aiTaskStore.update(task.id, {
          model: context.route.model,
          timings: { retrievalMs, contextMs },
          inputSummary: { routeStrategy: context.strategy, evidenceChunks: evidenceChunks.length },
        });
      } catch (error) {
        aiTaskStore.finish(task.id, {
          status: "failed",
          errorCode: error.message,
          failureStage: "request_validation",
          timings: { retrievalMs, contextMs },
        });
        sendJson(response, error.statusCode || 400, { success: false, chargeable: false, error: error.message });
        return;
      }
      let streamStarted = false;
      let receivedFirstToken = false;
      let outputChars = 0;
      let pendingText = "";
      let flushTimer = null;
      const upstreamStartedAt = Date.now();
      let readyAt = 0;
      let firstDeltaAt = 0;
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (!pendingText) return;
        writeStreamEvent(response, { type: "delta", text: pendingText });
        pendingText = "";
      };
      try {
        const completion = await streamPromptWithProvider(
          context.provider,
          context.route,
          context.prompt,
          context.values,
          {
            onReady() {
              readyAt = Date.now();
              streamStarted = true;
              response.writeHead(200, {
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store, no-transform",
                "X-Accel-Buffering": "no",
              });
              if (typeof response.flushHeaders === "function") response.flushHeaders();
              writeStreamEvent(response, {
                type: "meta",
                requestId: context.requestId,
                model: context.route.model,
                basis: context.basis,
              });
            },
            onDelta(delta) {
              if (!receivedFirstToken) {
                receivedFirstToken = true;
                firstDeltaAt = Date.now();
                aiTaskStore.markFirstToken(task.id);
              }
              outputChars += delta.length;
              pendingText += delta;
              if (!flushTimer) flushTimer = setTimeout(flush, 40);
            },
          },
        );
        flush();
        const upstreamFinishedAt = Date.now();
        aiTaskStore.finish(task.id, {
          status: "succeeded",
          chargeable: true,
          usage: completion.usage,
          outputChars: completion.content.length,
          timings: {
            retrievalMs,
            contextMs,
            connectMs: readyAt ? readyAt - upstreamStartedAt : 0,
            upstreamFirstTokenMs: firstDeltaAt ? firstDeltaAt - upstreamStartedAt : 0,
            generationMs: firstDeltaAt ? upstreamFinishedAt - firstDeltaAt : 0,
            upstreamMs: upstreamFinishedAt - upstreamStartedAt,
          },
        });
        writeStreamEvent(response, {
          type: "done",
          chargeable: true,
          model: completion.model,
          usage: completion.usage,
        });
        response.end();
      } catch (error) {
        if (flushTimer) clearTimeout(flushTimer);
        const upstreamFailedAt = Date.now();
        aiTaskStore.finish(task.id, {
          status: "failed",
          errorCode: error.message,
          failureStage: streamStarted ? "upstream_stream" : "upstream_connect",
          outputChars,
          timings: {
            retrievalMs,
            contextMs,
            connectMs: readyAt ? readyAt - upstreamStartedAt : 0,
            upstreamFirstTokenMs: firstDeltaAt ? firstDeltaAt - upstreamStartedAt : 0,
            generationMs: firstDeltaAt ? upstreamFailedAt - firstDeltaAt : 0,
            upstreamMs: upstreamFailedAt - upstreamStartedAt,
          },
        });
        if (!streamStarted) sendJson(response, 502, { success: false, chargeable: false, error: error.message });
        else {
          writeStreamEvent(response, { type: "error", chargeable: false, error: error.message });
          response.end();
        }
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/explain") {
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 400, {
          success: false,
          chargeable: false,
          error: error.message,
        });
        return;
      }
      if (guardBannedUser(response, request, payload.userId)) return;
      const config = aiConfigStore.load();
      const task = aiTaskStore.start(aiTaskMetadata(config, "explanation_chat", payload, {
        streaming: false,
        inputSummary: {
          questionId: String(payload.questionId || ""),
          messageChars: String(payload.userMessage || "").length,
          answerChars: String(payload.userAnswer || "").length,
          conversationTurns: Array.isArray(payload.conversationHistory) ? payload.conversationHistory.length : 0,
        },
      }));
      let context;
      let retrievalMs = 0;
      let contextMs = 0;
      try {
        const storedQuestion = questionStore.get(payload.questionId);
        const retrievalStartedAt = Date.now();
        const evidenceChunks = retrieveQuestionEvidence(storedQuestion, payload.userMessage, 4);
        retrievalMs = Date.now() - retrievalStartedAt;
        const contextStartedAt = Date.now();
        context = explanationContext(config, payload, clientQuestionPayload(storedQuestion), evidenceChunks);
        contextMs = Date.now() - contextStartedAt;
        aiTaskStore.update(task.id, {
          model: context.route.model,
          timings: { retrievalMs, contextMs },
          inputSummary: { routeStrategy: context.strategy, evidenceChunks: evidenceChunks.length },
        });
      } catch (error) {
        aiTaskStore.finish(task.id, {
          status: "failed",
          errorCode: error.message,
          failureStage: "request_validation",
          timings: { retrievalMs, contextMs },
        });
        sendJson(response, error.statusCode || 400, { success: false, chargeable: false, error: error.message });
        return;
      }
      const upstreamStartedAt = Date.now();
      try {
        const completion = await completePromptWithProvider(
          context.provider,
          context.route,
          context.prompt,
          context.values,
        );
        aiTaskStore.finish(task.id, {
          status: "succeeded",
          chargeable: true,
          usage: completion.usage,
          outputChars: completion.content.length,
          timings: {
            retrievalMs,
            contextMs,
            upstreamMs: Date.now() - upstreamStartedAt,
          },
        });
        sendJson(response, 200, {
          success: true,
          chargeable: true,
          provider: context.provider.id,
          model: completion.model,
          usage: completion.usage,
          result: { requestId: context.requestId, text: completion.content, basis: context.basis },
        });
      } catch (error) {
        aiTaskStore.finish(task.id, {
          status: "failed",
          errorCode: error.message,
          failureStage: "upstream_completion",
          timings: { retrievalMs, contextMs, upstreamMs: Date.now() - upstreamStartedAt },
        });
        sendJson(response, 502, { success: false, chargeable: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/score") {
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.message === "payload_too_large" ? 413 : 400, {
          success: false,
          chargeable: false,
          error: error.message,
        });
        return;
      }
      if (guardBannedUser(response, request, payload.userId)) return;
      const config = aiConfigStore.load();
      const isRescore = payload.rescore === true;
      const route = config.routes.subjective_scoring;
      const task = aiTaskStore.start(aiTaskMetadata(config, "subjective_scoring", payload, {
        model: isRescore && route.reviewModel ? route.reviewModel : route.model,
        inputSummary: {
          questionId: String(payload.questionId || ""),
          answerChars: String(payload.answer || "").length,
          rescore: isRescore,
        },
      }));
      const question = clientQuestionPayload(questionStore.get(payload.questionId));
      if (!question || question.answerMode !== "text" || typeof payload.answer !== "string") {
        aiTaskStore.finish(task.id, { status: "failed", errorCode: "invalid_scoring_request", failureStage: "request_validation" });
        sendJson(response, 400, { success: false, chargeable: false, error: "invalid_scoring_request" });
        return;
      }
      if (question.scoringPointStatus !== "complete" || !(question.scoringPoints || []).length) {
        aiTaskStore.finish(task.id, { status: "failed", errorCode: "question_scoring_not_ready", failureStage: "request_validation" });
        sendJson(response, 409, { success: false, chargeable: false, error: "question_scoring_not_ready" });
        return;
      }
      const cacheKey = scoringCacheKey(question, payload.answer, route, config.prompts.subjective_scoring);
      if (!isRescore) {
        const cached = aiScoreCacheStore.get(cacheKey);
        if (cached) {
          const result = {
            ...cached.result,
            requestId: payload.requestId || `score-${Date.now()}`,
            graderMode: "score_cache",
            graderVersion: `cache:${cached.result.graderVersion}`,
            createdAt: Date.now(),
          };
          aiTaskStore.finish(task.id, {
            status: "succeeded",
            chargeable: false,
            mode: "score_cache",
            outputChars: JSON.stringify(result).length,
          });
          sendJson(response, 200, { success: true, chargeable: false, cached: true, provider: "score_cache", result });
          return;
        }

        const fastResult = scoreFastSubjectiveAnswer(question, payload.answer, {
          requestId: payload.requestId || `score-${Date.now()}`,
        });
        if (fastResult) {
          aiScoreCacheStore.set({ key: cacheKey, questionId: question.id, model: fastResult.graderMode, result: fastResult });
          aiTaskStore.finish(task.id, {
            status: "succeeded",
            chargeable: false,
            mode: fastResult.graderMode,
            outputChars: JSON.stringify(fastResult).length,
          });
          sendJson(response, 200, { success: true, chargeable: false, fastScoring: true, provider: fastResult.graderMode, result: fastResult });
          return;
        }
      }
      if (route && route.mode === "provider") {
        const provider = config.providers.find((item) => item.id === route.providerId && item.enabled);
        if (!provider) {
          aiTaskStore.finish(task.id, { status: "failed", errorCode: "scoring_provider_unavailable", failureStage: "route_resolution" });
          sendJson(response, 503, { success: false, chargeable: false, error: "scoring_provider_unavailable" });
          return;
        }
        try {
          const effectiveRoute = subjectiveScoringRoute(route, question, isRescore);
          let scored = await scoreWithProvider(
            provider,
            effectiveRoute,
            question,
            payload.answer,
            payload.requestId || `score-${Date.now()}`,
            config.prompts.subjective_scoring,
          );
          let escalated = false;
          const threshold = Number(route.confidenceThreshold) || 0.75;
          if (!effectiveRoute.useReview && route.reviewModel && route.reviewModel !== effectiveRoute.model
            && scored.result.confidence < threshold) {
            const reviewRoute = {
              ...route,
              model: route.reviewModel,
              reasoningEffort: route.reviewReasoningEffort || "medium",
            };
            const reviewed = await scoreWithProvider(
              provider,
              reviewRoute,
              question,
              payload.answer,
              payload.requestId || `score-${Date.now()}`,
              config.prompts.subjective_scoring,
            );
            reviewed.result.initialConfidence = scored.result.confidence;
            reviewed.result.scoringPath = "confidence_escalation";
            reviewed.usage = mergeAiUsage(scored.usage, reviewed.usage);
            reviewed.outputChars += scored.outputChars;
            reviewed.timings = {
              upstreamMs: scored.timings.upstreamMs + reviewed.timings.upstreamMs,
              parseMs: scored.timings.parseMs + reviewed.timings.parseMs,
              normalizeMs: scored.timings.normalizeMs + reviewed.timings.normalizeMs,
            };
            scored = reviewed;
            escalated = true;
          } else {
            scored.result.scoringPath = effectiveRoute.useReview ? "review_model" : "fast_model";
          }
          aiScoreCacheStore.set({ key: cacheKey, questionId: question.id, model: scored.model, result: scored.result });
          aiTaskStore.finish(task.id, {
            status: "succeeded",
            chargeable: true,
            usage: scored.usage,
            outputChars: scored.outputChars,
            timings: scored.timings,
            model: scored.model,
            inputSummary: { ...task.inputSummary, escalated },
          });
          sendJson(response, 200, {
            success: true,
            chargeable: true,
            provider: provider.id,
            model: scored.model,
            usage: scored.usage,
            escalated,
            result: scored.result,
          });
        } catch (error) {
          aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "upstream_scoring" });
          sendJson(response, 502, {
            success: false,
            chargeable: false,
            error: error.message,
          });
        }
        return;
      }
      try {
        const result = scoreSubjectiveAnswer(question, payload.answer, { requestId: payload.requestId });
        aiTaskStore.finish(task.id, {
          status: "succeeded",
          chargeable: true,
          outputChars: JSON.stringify(result).length,
        });
        sendJson(response, 200, {
          success: true,
          chargeable: true,
          provider: "local_rule_demo",
          result,
        });
      } catch (error) {
        aiTaskStore.finish(task.id, { status: "failed", errorCode: error.message, failureStage: "local_scoring" });
        sendJson(response, 422, {
          success: false,
          chargeable: false,
          error: error.message,
        });
      }
      return;
    }

    if (url.pathname.startsWith("/admin")) {
      serveStatic(response, url.pathname);
      return;
    }

    if (url.pathname === "/") {
      response.writeHead(302, { Location: "/admin/" });
      response.end();
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  };

  // 每个请求独立一份操作人上下文，避免并发请求串号。
  const server = http.createServer((request, response) => {
    const adminActor = { username: "", displayName: "", role: "", accountId: "" };
    return adminActorContext.run(adminActor, () => handleRequest(request, response));
  });
  server.once("listening", () => {
    if (options.recoverExamImportJobs !== true) return;
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 3212}`;
    const recoverableJobs = aiTaskStore.list({ sceneId: "exam_paper_extraction", limit: 200 })
      .filter((task) => task.status === "failed"
        && task.inputSummary && task.inputSummary.backgroundImport === true
        && ["interrupted", "network", "timeout"].includes(task.errorCategory)
        && Number(task.inputSummary.autoResumeCount || 0) < 2
        && Date.now() - Number(task.updatedAt || 0) < 24 * 60 * 60 * 1000)
      .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    recoverableJobs.forEach((task) => {
      try {
        loadExamJobFile(task.id, "paper", task.inputSummary.paperFileName, task.inputSummary.paperMimeType, examJobRoot);
        aiTaskStore.restart(task.id, {
          inputSummary: {
            stage: "queued",
            percent: 3,
            message: "服务恢复，已自动重新排队",
            runAttempt: Number(task.inputSummary.runAttempt || 1) + 1,
            autoResumeCount: Number(task.inputSummary.autoResumeCount || 0) + 1,
            retryCount: 0,
            completedUnits: 0,
            totalUnits: 0,
          },
        });
        startExamImportJob(task.id, baseUrl);
      } catch (error) {
        // Missing temporary files cannot be recovered; keep the original failure visible.
      }
    });
  });
  return server;
}

if (require.main === module && process.env.PERSISTENCE_DRIVER !== "postgres") {
  if (String(process.env.FILE_STORAGE_DRIVER || "local").toLowerCase() === "kvault") {
    throw new Error("K-Vault file storage requires PERSISTENCE_DRIVER=postgres");
  }
  const port = Number(process.env.PORT || 3212);
  const host = process.env.HOST || "0.0.0.0";
  createServer({ recoverExamImportJobs: true }).listen(port, host, () => {
    process.stdout.write(`薯考本地服务已启动：http://127.0.0.1:${port}/admin/（局域网已开放）\n`);
  });
}

if (require.main === module && process.env.PERSISTENCE_DRIVER === "postgres") {
  (async () => {
    const { createPostgresPersistence } = require("./postgres-persistence");
    const persistence = await createPostgresPersistence();
    const objectStorage = createObjectStorageFromEnv({ knex: persistence.knex });
    const port = Number(process.env.PORT || 3212);
    const host = process.env.HOST || "0.0.0.0";
    const server = createServer({ ...persistence.stores, persistence, objectStorage, recoverExamImportJobs: true });
    server.listen(port, host, () => {
      process.stdout.write(`PostgreSQL API listening on http://${host}:${port}\n`);
    });
    const shutdown = () => server.close(async () => {
      await persistence.close();
      process.exit(0);
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = { createServer, catalogPayload, discoveryPayload, adminOverview, catalogNodePageLabel, catalogTitleIsCorrupted, normalizeCatalogHierarchy, normalizeCatalogPageRanges, refreshCatalogBackedQuestionPages, isRetryableProviderFailure, knowledgeClassificationQuestionBaseline, adminPermissionForPath, isInternalServiceRequest, OPERATOR_ADMIN_PATHS, SUPER_ADMIN_ONLY_ADMIN_PATHS };
