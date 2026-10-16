const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer, catalogPayload } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore, normalizeConfig } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryModerationStore } = require("../apps/api/src/moderation-store");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");
const { createMemoryExamStore } = require("../apps/api/src/exam-store");
const { createMemoryPackStore } = require("../apps/api/src/pack-store");
const { createMemoryBillingStore } = require("../apps/api/src/billing-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryAnnouncementStore } = require("../apps/api/src/announcement-store");

test("catalog contains five subjects and nine books", () => {
  const catalog = catalogPayload();
  assert.equal(catalog.subjects.length, 5);
  assert.equal(
    catalog.subjects.reduce((total, subject) => total + subject.books.length, 0),
    9,
  );
});

test("legacy mixed classification prompts migrate to independent Agent 1 and Agent 2 prompts", () => {
  const config = normalizeConfig({
    prompts: {
      knowledge_hierarchy_navigation: {
        systemPrompt: "旧知识树导航。Agent 1 提取题干核心关键词，Agent 2 再逐层归类。",
        userPromptTemplate: "{{question}}\n{{candidateNodes}}\n{{requiredOutput}}",
        version: 3,
      },
    },
  });
  assert.match(config.prompts.knowledge_feature_extraction.systemPrompt, /只负责独立提取题目特征/);
  assert.match(config.prompts.knowledge_hierarchy_navigation.systemPrompt, /只负责读取 Agent 1 已持久化的特征快照/);
  assert.doesNotMatch(config.prompts.knowledge_hierarchy_navigation.systemPrompt, /Agent 1 提取题干核心关键词/);
  assert.equal(config.prompts.knowledge_hierarchy_navigation.version, 4);
});

test("persisted Agent 2 prompts distinguish a missing core path from an auxiliary cross-path gap", () => {
  const config = normalizeConfig({
    prompts: {
      knowledge_hierarchy_navigation: {
        systemPrompt: "Agent 2。证据不足必须选择无法确定，候选遗漏必须选择候选均不合适。每层输出 core_path_viable；其他作答依赖暂未出现在本层候选时，只能用 auxiliaryGap 引用 Agent 1 dependencySteps 的真实 ref 交给 Agent 3，绝不能因此选择 none_of_candidates。",
        userPromptTemplate: "{{question}} {{candidateNodes}} {{requiredOutput}}",
      },
    },
  });
  const prompt = config.prompts.knowledge_hierarchy_navigation.systemPrompt;
  assert.doesNotMatch(prompt, /候选遗漏必须选择候选均不合适/);
  assert.doesNotMatch(prompt, /其他作答依赖暂未出现在本层候选/);
  assert.match(prompt, /只有核心路径候选全部不合适/);
  assert.match(prompt, /位于所选核心候选路径之外/);
  assert.match(prompt, /同一路径中尚未下钻到的后代知识不是辅助缺口/);
});

test("persisted Agent 3 option-relation prompts migrate to independent verified nodes", () => {
  const legacyInstruction = "必须独立核对 Agent 1 的每个选项或原子陈述关系，并在 optionRelationAssessments 中完整留痕。只能输出 confirm、dispute 或 correction：confirm/dispute 不得偷偷补关系或节点；correction 必须给 proposedKnowledgeRelation，只有 proposedKnowledgeRelation=option_specific 才可从提供的候选 knowledge 节点中选择 proposedKnowledgeNodeIds。所有结论必须引用可用教材证据并说明删除检验理由。该字段只是独立校核建议，不得覆盖 Agent 1 原始输出。";
  const config = normalizeConfig({
    prompts: {
      knowledge_batch_verification: {
        systemPrompt: `Agent 3。${legacyInstruction}`,
        userPromptTemplate: "{{questions}} {{requiredOutput}}",
      },
    },
  });
  const prompt = config.prompts.knowledge_batch_verification.systemPrompt;
  assert.doesNotMatch(prompt, /confirm\/dispute 不得偷偷补关系或节点/);
  assert.match(prompt, /verifiedKnowledgeNodeIds/);
  assert.match(prompt, /关系评估仍以 Agent 1 原始输出为准/);
});

test("persisted classification prompts migrate away from official-answer authority", () => {
  const legacyCompatibleAuthority = "答案证据必须分级使用：answerAuthority 为 verified_official 是旧结构兼容值，表示已核验来源答案或平台核验答案；它与教材正文是权威依据。AI 答案只可作为待核线索，冲突时不得覆盖或折中已核验答案。归类不仅判断题干主题，还要列全完成作答实际经过的知识节点；字母写法、实际音值、结构位置与发音性质之间发生转换时，应识别为跨知识点作答。";
  const legacyOfficialAuthority = "答案证据必须分级使用：answerAuthority 为 verified_official 时，已核验官方答案与教材正文是权威依据；AI 答案只可作为待核线索，冲突时不得覆盖或折中官方答案。归类不仅判断题干主题，还要列全完成作答实际经过的知识节点；字母写法、实际音值、结构位置与发音性质之间发生转换时，应识别为跨知识点作答。";
  const legacyOfficialExperience = "teachingRules 只包含人工批准且与当前范围匹配的教研规则，必须在其适用范围内执行；confirmedCases 是人工确认案例，只能作为类比依据。若规则或案例与已核验官方答案、教材正文冲突，仍以官方答案和教材为准，并在 reason 或 uncertainty 中明确报告冲突。";
  const store = createMemoryAiConfigStore({
    prompts: {
      knowledge_feature_extraction: { systemPrompt: `Agent 1。${legacyCompatibleAuthority}`, userPromptTemplate: "{{question}} {{requiredOutput}}" },
      knowledge_hierarchy_navigation: { systemPrompt: `Agent 2。${legacyCompatibleAuthority}`, userPromptTemplate: "{{question}} {{requiredOutput}}" },
      knowledge_global_recovery: { systemPrompt: `整树恢复。${legacyCompatibleAuthority}`, userPromptTemplate: "{{question}} {{requiredOutput}}" },
      knowledge_batch_verification: { systemPrompt: `Agent 3。${legacyOfficialAuthority} ${legacyOfficialExperience}`, userPromptTemplate: "{{questions}} {{requiredOutput}}" },
      question_enrichment: {
        systemPrompt: "你是汉语言文学官方题库完善助手。不得创造目录或改写官方答案。",
        userPromptTemplate: "{{question}} {{requiredOutput}}",
      },
    },
  });
  const config = store.load();
  const classificationSceneIds = [
    "knowledge_feature_extraction",
    "knowledge_hierarchy_navigation",
    "knowledge_global_recovery",
    "knowledge_batch_verification",
  ];

  classificationSceneIds.forEach((sceneId) => {
    const prompt = config.prompts[sceneId].systemPrompt;
    assert.doesNotMatch(prompt, /verified_official/);
    assert.equal((prompt.match(/官方答案/g) || []).length, 1);
    assert.match(prompt, /不得把平台核验答案或来源答案称为“官方答案”/);
  });
  assert.doesNotMatch(config.prompts.question_enrichment.systemPrompt, /官方题库|改写官方答案/);
  assert.match(config.prompts.question_enrichment.systemPrompt, /平台题库题目完善助手/);
  assert.match(config.prompts.question_enrichment.systemPrompt, /已核验来源答案或平台核验答案/);
});

test("health and catalog endpoints respond", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");

  const catalog = await fetch(`http://127.0.0.1:${port}/api/catalog`).then((response) => response.json());
  assert.equal(catalog.project.year, 2026);
  assert.equal(catalog.subjects[0].name, "现代汉语");
});

test("community asset APIs publish safe assets and let owners withdraw them", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const loginResponse = await fetch(`${baseUrl}/api/auth/wechat/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "community-code", deviceId: "community-device", profile: { nickname: "测试同学" } }),
  });
  const session = await loginResponse.json();
  assert.equal(loginResponse.status, 200);
  const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` };
  const payload = {
    id: "client-note-1",
    contributor: "测试同学",
    type: "note",
    typeLabel: "共享笔记",
    title: "现代汉语语法易错点",
    content: "整理词类、短语和句法成分之间最容易混淆的判断依据，并附上复习顺序。",
    subjectId: "modern-chinese",
    chapterId: "grammar",
    originality: "original",
  };
  // 匿名投稿必须被拒：社区内容归属只能来自会话。
  const anonymousResponse = await fetch(`${baseUrl}/api/community/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, id: "client-note-anonymous" }),
  });
  assert.equal(anonymousResponse.status, 401);

  const createdResponse = await fetch(`${baseUrl}/api/community/assets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ ...payload, userId: "user-community-test" }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.asset.moderationStatus, "published");
  // 请求里声明的 userId 不再被采信，归属用会话用户。
  assert.equal(created.asset.userId, session.user.id);

  const listing = await fetch(`${baseUrl}/api/community/assets`).then((response) => response.json());
  assert.equal(listing.assets.some((asset) => asset.id === created.asset.id), true);
  const withdrawn = await fetch(`${baseUrl}/api/community/assets/${created.asset.id}/withdraw`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ userId: "user-community-test" }),
  }).then((response) => response.json());
  assert.equal(withdrawn.asset.moderationStatus, "offline");
});

test("public question packs include importable question content", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const payload = await fetch(`http://127.0.0.1:${port}/api/packs`).then((response) => response.json());
  assert.equal(payload.success, true);
  assert.equal(payload.packs.length, 1);
  assert.equal(payload.packs[0].status, "featured");
  assert.equal(payload.packs[0].questions.length, 8);
  assert.equal(payload.packs[0].questions[0].stem.length > 0, true);
});

test("admin dashboard is served", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/admin/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /薯考管理后台/);
  assert.match(html, /最大 150 MB/);
  assert.match(html, /自动补充缺失的 AI 答案、得分点和教材页码/);
  assert.match(html, /自动补全缺失的章节目录和知识点/);
  assert.match(html, /AI 一键补全/);
  assert.match(html, /公告管理/);
});

test("admin announcements can be created, published, read publicly and audited", async (context) => {
  const announcementStore = createMemoryAnnouncementStore([]);
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), announcementStore, operationLogStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${baseUrl}/api/admin/announcements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "功能更新", title: "公告接口测试", summary: "小程序顶部展示摘要", content: "公告正文", priority: 50 }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.announcement.status, "draft");

  const beforePublish = await fetch(`${baseUrl}/api/announcements`).then((response) => response.json());
  assert.equal(beforePublish.announcements.length, 0);
  const published = await fetch(`${baseUrl}/api/admin/announcements/${created.announcement.id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "publish" }),
  }).then((response) => response.json());
  assert.equal(published.announcement.status, "published");

  const publicListing = await fetch(`${baseUrl}/api/announcements`).then((response) => response.json());
  assert.equal(publicListing.announcements[0].title, "公告接口测试");
  assert.equal(operationLogStore.list({ category: "announcement" }).items.length, 2);
});

test("admin moderation actions are audited", async (context) => {
  const operationLogStore = createMemoryAdminOperationStore();
  const moderationStore = createMemoryModerationStore([]);
  const report = moderationStore.create({
    type: "unsafe_content",
    risk: "high",
    targetType: "pack",
    targetId: "pack-test-001",
    targetTitle: "测试公开题包",
    reporter: { id: "system", nickname: "内容安全初筛" },
    reason: "疑似包含广告",
  });
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), operationLogStore, moderationStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const dashboard = await fetch(`http://127.0.0.1:${port}/api/admin/moderation`).then((response) => response.json());
  assert.equal(dashboard.counts.pending, 1);
  assert.equal(dashboard.counts.highRisk, 1);

  const actionResponse = await fetch(`http://127.0.0.1:${port}/api/admin/moderation/${report.id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "offline", note: "人工确认违规" }),
  });
  const actionPayload = await actionResponse.json();
  assert.equal(actionResponse.status, 200);
  assert.equal(actionPayload.report.status, "resolved");

  const logs = await fetch(`http://127.0.0.1:${port}/api/admin/operation-logs?category=moderation`).then((response) => response.json());
  assert.equal(logs.items.length, 1);
  assert.equal(logs.items[0].action, "moderation.offline");
  assert.equal(logs.items[0].targetId, "pack-test-001");
});

test("admin textbook drafts stay private until manual confirmation", async (context) => {
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), textbookCatalogStore, operationLogStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const bookId = "modern-chinese-7-1";

  const initial = await fetch(`http://127.0.0.1:${port}/api/admin/textbooks`).then((response) => response.json());
  assert.equal(initial.textbooks.length, 9);
  assert.equal(initial.counts.confirmed, 0);

  const draftResponse = await fetch(`http://127.0.0.1:${port}/api/admin/textbooks/${bookId}/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: [{ level: 1, title: "第一章 绪论", startPage: 1, endPage: 18, knowledgePoints: ["现代汉语概述"] }] }),
  });
  const draftPayload = await draftResponse.json();
  assert.equal(draftResponse.status, 200);
  assert.equal(draftPayload.textbook.status, "draft_pending");
  assert.equal(draftPayload.textbook.confirmed, null);
  const privateCatalogResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/textbooks/${bookId}`);
  assert.equal(privateCatalogResponse.status, 404);

  const confirmResponse = await fetch(`http://127.0.0.1:${port}/api/admin/textbooks/${bookId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm" }),
  });
  const confirmPayload = await confirmResponse.json();
  assert.equal(confirmResponse.status, 200);
  assert.equal(confirmPayload.textbook.status, "confirmed");
  assert.equal(confirmPayload.textbook.confirmed.nodes.length, 1);
  const publicCatalogResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/textbooks/${bookId}`);
  const publicCatalogPayload = await publicCatalogResponse.json();
  assert.equal(publicCatalogResponse.status, 200);
  assert.equal(publicCatalogPayload.textbook.version, 1);
  assert.equal(publicCatalogPayload.textbook.nodes[0].title, "第一章 绪论");
  assert.equal(publicCatalogPayload.textbook.nodes[0].evidence, undefined);

  const revisionResponse = await fetch(`http://127.0.0.1:${port}/api/admin/textbooks/${bookId}/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: [{ level: 1, title: "第一章 修订稿", startPage: 1, endPage: 20 }] }),
  });
  assert.equal(revisionResponse.status, 200);
  const publishedDuringRevision = await fetch(`http://127.0.0.1:${port}/api/catalog/textbooks/${bookId}`).then((response) => response.json());
  assert.equal(publishedDuringRevision.textbook.version, 1);
  assert.equal(publishedDuringRevision.textbook.nodes[0].title, "第一章 绪论");
  assert.equal(operationLogStore.list({ category: "catalog" }).items.length, 3);
});

test("billing APIs expose products and preserve auditable bean settlement", async (context) => {
  const billingStore = createMemoryBillingStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), billingStore, operationLogStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const products = await fetch(`http://127.0.0.1:${port}/api/billing/products`).then((response) => response.json());
  assert.equal(products.products.length, 3);

  const grantResponse = await fetch(`http://127.0.0.1:${port}/api/admin/billing/users/test-user/grant-product`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "product-modern-chinese-2026" }),
  });
  const grant = await grantResponse.json();
  assert.equal(grant.account.subscriptions.length, 1);
  // 初始 2 豆币 + 单科订阅赠送 3 豆币（原 30 点额度 ÷10）
  assert.equal(grant.account.beanBalance, 5);
  assert.equal(grant.order.priceCents, 6900);
  assert.equal(grant.beanGrant.lot.source, "subscription_bonus");

  const consumeResponse = await fetch(`http://127.0.0.1:${port}/api/billing/beans/consume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "test-user", amount: 0.1, referenceId: "score-request-1", description: "主观题评分" }),
  });
  const consumed = await consumeResponse.json();
  assert.equal(consumed.account.beanBalance, 4.9);
  assert.equal(consumed.account.transactions[0].transactionType, "consume");

  // 旧额度接口语义不变：1 点额度 = 0.1 豆币，扣的是同一份豆币余额
  const legacyResponse = await fetch(`http://127.0.0.1:${port}/api/billing/credits/consume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "test-user", amount: 1, referenceId: "score-request-legacy", description: "主观题评分（旧客户端）" }),
  });
  const legacy = await legacyResponse.json();
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacy.consumedAmount, 0.1);
  assert.equal(legacy.account.beanBalance, 4.8);

  const dashboard = await fetch(`http://127.0.0.1:${port}/api/admin/billing`).then((response) => response.json());
  assert.equal(dashboard.counts.activeSubscriptions, 1);
  assert.equal(dashboard.counts.beanBalance, 4.8);
  assert.equal(operationLogStore.list({ category: "billing" }).items.length, 1);

  const groupResponse = await fetch(`http://127.0.0.1:${port}/api/admin/billing/packages/subject-modern-chinese`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageName: "现代汉语精选题库", scopeLabel: "现代汉语 · 两册" }),
  });
  assert.equal(groupResponse.status, 200);
  const group = await groupResponse.json();
  assert.equal(group.products.length, 1);
  assert.equal(group.products[0].packageName, "现代汉语精选题库");
  assert.equal(group.products[0].priceCents, 6900);
  assert.equal(operationLogStore.list({ category: "billing" }).items.length, 2);
});

test("admin refund keeps the two effects separate: full refund revokes, refund_only does not", async (context) => {
  const billingStore = createMemoryBillingStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), billingStore, operationLogStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const purchase = async (productId) => fetch(`${base}/api/admin/billing/users/test-user/grant-product`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId }),
  }).then((response) => response.json());
  const refund = async (orderId, body) => fetch(`${base}/api/admin/billing/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());

  // 仅退款：钱退了，订阅权与赠币都不收回
  const onlyRefundOrder = await purchase("product-modern-chinese-2026");
  const onlyRefund = await refund(onlyRefundOrder.order.id, { mode: "refund_only", reason: "客服补偿" });
  assert.equal(onlyRefund.mode, "refund_only");
  assert.equal(onlyRefund.order.refundMode, "refund_only");
  assert.equal(onlyRefund.clawedBackBeans, 0);
  assert.equal(onlyRefund.account.subscriptions.length, 1, "仅退款保留订阅权");
  assert.equal(onlyRefund.account.beanBalance, 5, "仅退款保留赠币");
  assert.equal(onlyRefund.account.transactions.some((item) => item.transactionType === "revoke"), false);

  // 默认退款：收回订阅权 + 扣回未消费赠币
  const fullRefundOrder = await purchase("product-chinese-literature-2026");
  const fullRefund = await refund(fullRefundOrder.order.id, { reason: "用户申请退款" });
  assert.equal(fullRefund.mode, "revoke");
  assert.equal(fullRefund.revokedEntitlement.id, fullRefundOrder.entitlement.id);
  assert.equal(fullRefund.clawedBackBeans, 10);
  assert.equal(fullRefund.account.beanBalance, 5, "只扣回该订单的赠币，不动其它批次");
  assert.equal(fullRefund.account.subscriptions.length, 1, "该订单的订阅权已收回，仅剩未退款的那笔");

  // 非法模式必须拒绝，且不产生任何副作用
  const invalid = await fetch(`${base}/api/admin/billing/orders/${encodeURIComponent(fullRefundOrder.order.id)}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "乱写的模式" }),
  });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error, "billing_refund_mode_invalid");

  // 两件独立操作各有自己的入口
  const secondOrder = await purchase("product-modern-chinese-2026");
  const revokeOnly = await fetch(`${base}/api/admin/billing/orders/${encodeURIComponent(secondOrder.order.id)}/revoke-entitlement`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "只收回权益" }),
  }).then((response) => response.json());
  assert.equal(revokeOnly.revokedEntitlement.id, secondOrder.entitlement.id);
  assert.equal(revokeOnly.account.beanBalance, 8, "只收回权益不动豆币（5 + 3）");
  const clawBackOnly = await fetch(`${base}/api/admin/billing/orders/${encodeURIComponent(secondOrder.order.id)}/claw-back-beans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "只扣回赠币" }),
  }).then((response) => response.json());
  assert.equal(clawBackOnly.clawedBackBeans, 3);
  assert.equal(clawBackOnly.account.beanBalance, 5);
  assert.equal(operationLogStore.list({ category: "billing" }).items.length, 7);
});

test("development test purchase creates an authenticated order that admin can refund", async (context) => {
  const billingStore = createMemoryBillingStore();
  const userAuthStore = createMemoryUserAuthStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), userAuthStore, billingStore, operationLogStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const loginResponse = await fetch(`${base}/api/auth/wechat/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "billing-test-code", deviceId: "billing-test-device" }),
  });
  const login = await loginResponse.json();
  assert.equal(loginResponse.status, 200);

  const purchase = async (requestId) => fetch(`${base}/api/billing/test-purchase`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ productId: "product-modern-chinese-2026", requestId }),
  });
  const first = await purchase("same-test-request");
  const firstPayload = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstPayload.order.channel, "user_test_simulation");
  assert.equal(firstPayload.account.subscriptions.length, 1);

  const duplicate = await purchase("same-test-request");
  const duplicatePayload = await duplicate.json();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicatePayload.duplicated, true);
  assert.equal(duplicatePayload.order.id, firstPayload.order.id);

  const refund = await fetch(`${base}/api/admin/billing/orders/${encodeURIComponent(firstPayload.order.id)}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "revoke", reason: "测试链路退款" }),
  });
  const refundPayload = await refund.json();
  assert.equal(refund.status, 200);
  assert.equal(refundPayload.order.status, "refunded");
  assert.equal(refundPayload.revokedEntitlement.id, firstPayload.entitlement.id);

  const account = await fetch(`${base}/api/billing/account`, {
    headers: { Authorization: `Bearer ${login.token}` },
  }).then((response) => response.json());
  assert.equal(account.account.subscriptions.length, 0);
  assert.equal(account.account.orders[0].status, "refunded");
  assert.ok(operationLogStore.list({ category: "billing" }).items.some((item) => item.action === "billing.test_purchase"));
});

test("admin exams and public packs use real questions and audited publishing", async (context) => {
  const operationLogStore = createMemoryAdminOperationStore();
  const moderationStore = createMemoryModerationStore([]);
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    examStore: createMemoryExamStore([]),
    packStore: createMemoryPackStore([]),
    operationLogStore,
    moderationStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const questionIds = ["demo-modern-chinese-001", "demo-modern-chinese-002"];

  const examResponse = await fetch(`http://127.0.0.1:${port}/api/admin/exams`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "接口模拟卷", kind: "official_mock", questionIds, durationMinutes: 60, freePreviewQuestionCount: 1 }),
  });
  const examPayload = await examResponse.json();
  assert.equal(examResponse.status, 201);
  assert.equal(examPayload.exam.totalScore, 4);
  const publishedExam = await fetch(`http://127.0.0.1:${port}/api/admin/exams/${examPayload.exam.id}/action`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "publish" }),
  }).then((response) => response.json());
  assert.equal(publishedExam.exam.status, "published");

  const packResponse = await fetch(`http://127.0.0.1:${port}/api/admin/packs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "接口公开题包", visibility: "public", questionIds, tags: ["测试"] }),
  });
  const packPayload = await packResponse.json();
  assert.equal(packResponse.status, 201);
  assert.equal(packPayload.pack.status, "pending_review");
  assert.equal(moderationStore.list({}).counts.pending, 1);
  assert.equal(operationLogStore.list({}).summary.total, 3);
});

test("exam APIs preserve optional-question rules and calculate the declared total", async (context) => {
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    examStore: createMemoryExamStore([]),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const questionIds = ["demo-modern-chinese-001", "demo-modern-chinese-002", "demo-modern-chinese-003"];
  const selectionRules = [{
    id: "choose-two-of-three",
    title: "三选二",
    requiredCount: 2,
    questionIds,
    scoringOrder: "first_answered",
  }];
  const response = await fetch(`${baseUrl}/api/admin/exams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "选答规则测试卷",
      questionIds,
      durationMinutes: 60,
      declaredTotalScore: 4,
      selectionRules,
    }),
  });
  const created = await response.json();
  assert.equal(response.status, 201);
  assert.equal(created.exam.rawTotalScore, 6);
  assert.equal(created.exam.calculatedTotalScore, 4);
  assert.equal(created.exam.totalScore, 4);
  assert.equal(created.exam.scoreMatches, true);
  assert.deepEqual(created.exam.selectionRules[0].questionIds, questionIds);

  await fetch(`${baseUrl}/api/admin/exams/${created.exam.id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "publish" }),
  });
  const detail = await fetch(`${baseUrl}/api/exams/${created.exam.id}`).then((item) => item.json());
  assert.equal(detail.exam.totalScore, 4);
  assert.equal(detail.exam.selectionRules[0].requiredCount, 2);
});

test("exams with doubtful AI answers publish with a full-review marker", async (context) => {
  const questionStore = createMemoryQuestionStore([]);
  const question = questionStore.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第一章 绪论",
    knowledgePoints: ["现代汉语定义"],
    type: "single_choice",
    stem: "现代汉语的含义是什么？",
    options: [{ key: "A", text: "现代汉民族共同语" }, { key: "B", text: "古代汉语" }],
    correctAnswer: ["A"],
    referenceAnswer: "现代汉语是现代汉民族共同语。",
    maxScore: 2,
    answerSource: "ai_supplement",
    answerReviewStatus: "doubtful",
  });
  const unreviewedQuestion = questionStore.create({
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第一章 绪论",
    knowledgePoints: ["现代汉语定义"],
    type: "short_answer",
    stem: "简述现代汉语的含义。",
    referenceAnswer: "现代汉语是现代汉民族共同语。",
    scoringPoints: [{ description: "指出现代汉语是现代汉民族共同语", score: 2 }],
    maxScore: 2,
    answerSource: "ai_supplement",
    answerReviewStatus: "unreviewed",
  });
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), questionStore, examStore: createMemoryExamStore([]) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createdResponse = await fetch(`${baseUrl}/api/admin/exams`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "待复核答案内部草稿", kind: "past_paper", year: 2025, questionIds: [question.id, unreviewedQuestion.id], durationMinutes: 60 }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.exam.status, "draft");

  const publishedResponse = await fetch(`${baseUrl}/api/admin/exams/${created.exam.id}/action`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "publish" }),
  });
  assert.equal(publishedResponse.status, 200);
  const published = await publishedResponse.json();
  assert.equal(published.exam.status, "published");
  assert.equal(published.exam.answerReviewSummary.status, "needs_full_review");
  assert.equal(published.exam.answerReviewSummary.doubtfulCount, 1);
  assert.equal(published.exam.answerReviewSummary.unreviewedCount, 1);
  assert.deepEqual(published.exam.answerReviewSummary.doubtfulQuestionIds, [question.id]);
  assert.deepEqual(published.exam.answerReviewSummary.unreviewedQuestionIds, [unreviewedQuestion.id]);

  const publicList = await fetch(`${baseUrl}/api/exams?kind=past_paper`).then((response) => response.json());
  assert.equal(publicList.total, 1);
  assert.equal(publicList.exams[0].id, created.exam.id);
  assert.equal(publicList.exams[0].year, 2025);
  assert.equal(publicList.exams[0].origin, "manual");
  assert.equal(publicList.exams[0].sourceLabel, "广东省教育考试院");
  assert.equal(publicList.exams[0].summary.includes("考试真题"), true);
  assert.equal(publicList.exams[0].answerReviewSummary, undefined);
  const publicDetail = await fetch(`${baseUrl}/api/exams/${created.exam.id}`).then((response) => response.json());
  assert.equal(publicDetail.exam.availableQuestionCount, 2);
  assert.deepEqual(publicDetail.questions.map((item) => item.id), [question.id, unreviewedQuestion.id]);

  questionStore.update(question.id, { answerReviewStatus: "verified", answerVerified: true });
  questionStore.update(unreviewedQuestion.id, { answerReviewStatus: "verified", answerVerified: true });
  const listed = await fetch(`${baseUrl}/api/admin/exams`).then((response) => response.json());
  const refreshed = listed.exams.find((exam) => exam.id === created.exam.id);
  assert.equal(refreshed.answerReviewSummary.status, "fully_reviewed");
  assert.equal(listed.counts.needsFullReview, 0);
});

test("admin exam listing batch-loads shared questions once", async (context) => {
  const questionStore = createMemoryQuestionStore();
  const originalGet = questionStore.get.bind(questionStore);
  const originalGetMany = questionStore.getMany.bind(questionStore);
  let getCalls = 0;
  let getManyCalls = 0;
  questionStore.get = (...args) => { getCalls += 1; return originalGet(...args); };
  questionStore.getMany = (...args) => { getManyCalls += 1; return originalGetMany(...args); };
  const now = Date.now();
  const sharedQuestionIds = ["demo-modern-chinese-001", "demo-modern-chinese-002"];
  const examStore = createMemoryExamStore([1, 2].map((index) => ({
    id: `batch-exam-${index}`,
    title: `批量读取测试卷 ${index}`,
    description: "",
    kind: "official_mock",
    year: 2026,
    questionIds: sharedQuestionIds,
    durationMinutes: 60,
    totalScore: 4,
    selectionRules: [],
    freePreviewQuestionCount: 0,
    status: "draft",
    attempts: 0,
    version: 1,
    versions: [],
    createdAt: now,
    updatedAt: now,
    createdBy: "测试",
    updatedBy: "测试",
  })));
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), questionStore, examStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/exams`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.exams.length, 2);
  assert.equal(getManyCalls, 1);
  assert.equal(getCalls, 0);
});

test("admin question APIs create searchable official questions with versions", async (context) => {
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), operationLogStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const initial = await fetch(`http://127.0.0.1:${port}/api/admin/questions?library=official`).then((response) => response.json());
  assert.equal(initial.questions.length, 11);
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/admin/questions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      chapter: "绪论",
      knowledgePoints: ["方言与共同语"],
      type: "single_choice",
      stem: "本测试题用于验证哪个后台能力？",
      options: [{ key: "A", text: "题目录入" }, { key: "B", text: "支付" }],
      correctAnswer: ["A"],
      referenceAnswer: "用于验证平台题目录入。",
      maxScore: 2,
      sourceLabel: "接口测试",
      freePreview: { question: true, answer: false, analysis: false },
    }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.question.version, 1);

  const updated = await fetch(`http://127.0.0.1:${port}/api/admin/questions/${created.question.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...created.question, stem: "本测试题用于验证哪项后台能力？", changeNote: "优化题干" }),
  }).then((response) => response.json());
  assert.equal(updated.question.version, 2);
  assert.equal(updated.question.versions[0].previousSnapshot.stem, "本测试题用于验证哪个后台能力？");

  const searched = await fetch(`http://127.0.0.1:${port}/api/admin/questions?library=official&query=${encodeURIComponent("哪项后台能力")}`).then((response) => response.json());
  assert.equal(searched.questions.length, 1);
  assert.equal(searched.questions[0].id, created.question.id);

  const importText = `[单选题] 文本导入接口是否可用？\nA. 可用\nB. 不可用\n答案：A\n参考答案：文本导入接口可用。\n知识点：批量导入\n分值：2`;
  const importDefaults = { subjectId: "modern-chinese", bookId: "modern-chinese-7-1", chapter: "绪论" };
  const preview = await fetch(`http://127.0.0.1:${port}/api/admin/questions/import-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: importText, defaults: importDefaults, dryRun: true }),
  }).then((response) => response.json());
  assert.equal(preview.validCount, 1);
  assert.equal(preview.items[0].stem, "文本导入接口是否可用？");
  assert.deepEqual(preview.items[0].sourceRange, { start: 0, end: importText.length });
  const batchDuplicateText = `${importText}\n---\n${importText}`;
  const batchDuplicatePreview = await fetch(`http://127.0.0.1:${port}/api/admin/questions/import-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: batchDuplicateText, defaults: importDefaults, dryRun: true }),
  }).then((response) => response.json());
  assert.equal(batchDuplicatePreview.validCount, 1);
  assert.equal(batchDuplicatePreview.storedDuplicateCount, 0);
  assert.equal(batchDuplicatePreview.batchDuplicateCount, 1);
  assert.equal(batchDuplicatePreview.items[1].duplicateScope, "batch");
  assert.equal(batchDuplicatePreview.items[1].duplicateIndex, 0);
  const committed = await fetch(`http://127.0.0.1:${port}/api/admin/questions/import-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: importText, defaults: importDefaults, dryRun: false }),
  }).then((response) => response.json());
  assert.equal(committed.createdCount, 1);
  assert.match(committed.batchId, /^question-import-/);

  const batches = await fetch(`http://127.0.0.1:${port}/api/admin/questions/import-batches`).then((response) => response.json());
  const importedBatch = batches.batches.find((batch) => batch.id === committed.batchId);
  assert.equal(importedBatch.count, 1);
  assert.equal(importedBatch.subjectId, "modern-chinese");

  // 归类完整（教材 + 章节 + 知识点）且答案已核对的导入题，正常进入用户端题目列表。
  const publishedBeforeMove = await fetch(`http://127.0.0.1:${port}/api/questions?library=official&bookId=modern-chinese-7-1`).then((response) => response.json());
  assert.equal(publishedBeforeMove.questions.some((question) => question.id === committed.createdIds[0]), true);
  assert.equal(publishedBeforeMove.counts.byBook["modern-chinese-7-1"], publishedBeforeMove.total);

  const batchUpdateResponse = await fetch(`http://127.0.0.1:${port}/api/admin/questions/import-batches/${encodeURIComponent(committed.batchId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subjectId: "contemporary-literature", bookId: "contemporary-literature-history-3" }),
  });
  const batchUpdate = await batchUpdateResponse.json();
  assert.equal(batchUpdateResponse.status, 200);
  assert.equal(batchUpdate.updatedCount, 1);
  assert.equal(batchUpdate.batch.subjectId, "contemporary-literature");
  const filteredBatch = await fetch(`http://127.0.0.1:${port}/api/admin/questions?library=official&importBatchId=${encodeURIComponent(committed.batchId)}`).then((response) => response.json());
  assert.equal(filteredBatch.questions.length, 1);
  assert.equal(filteredBatch.questions[0].bookId, "contemporary-literature-history-3");
  assert.equal(filteredBatch.questions[0].version, 2);
  assert.equal(filteredBatch.questions[0].versions[0].changeNote, "批次补充归属（科目／教材／章节／知识点）");
  // 换教材后，原教材的下级关联（章节/知识点）不得残留；题目因此退回「待归类」，
  // 不再自动发布到用户端，但仍留在平台题目管理里可查、可补归属。
  assert.equal(filteredBatch.questions[0].chapter, "");
  assert.deepEqual(filteredBatch.questions[0].knowledgePoints, []);
  assert.equal(filteredBatch.questions[0].status, "pending_review");
  assert.equal(filteredBatch.pendingClassificationCount, 1);

  const pendingClassification = await fetch(`http://127.0.0.1:${port}/api/admin/questions?library=official&classification=pending&importBatchId=${encodeURIComponent(committed.batchId)}`).then((response) => response.json());
  assert.equal(pendingClassification.questions.length, 1);
  assert.deepEqual(pendingClassification.questions[0].classification.missing, ["chapter", "knowledge_points"]);

  const clientQuestions = await fetch(`http://127.0.0.1:${port}/api/questions?library=official&bookId=contemporary-literature-history-3`).then((response) => response.json());
  assert.equal(clientQuestions.questions.some((question) => question.id === committed.createdIds[0]), false);

  const duplicatePreview = await fetch(`http://127.0.0.1:${port}/api/admin/questions/import-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: importText, defaults: importDefaults, dryRun: true }),
  }).then((response) => response.json());
  assert.equal(duplicatePreview.validCount, 0);
  assert.equal(duplicatePreview.duplicateCount, 1);
  assert.equal(duplicatePreview.storedDuplicateCount, 1);
  assert.equal(duplicatePreview.batchDuplicateCount, 0);
  assert.equal(duplicatePreview.errorCount, 0);
  assert.equal(duplicatePreview.items[0].error, "question_duplicate");
  assert.equal(duplicatePreview.items[0].duplicateScope, "stored");
  assert.deepEqual(duplicatePreview.items[0].sourceRange, { start: 0, end: importText.length });
  assert.equal(duplicatePreview.items[0].comparison.incoming.stem, "文本导入接口是否可用？");
  assert.equal(duplicatePreview.items[0].comparison.existing.stem, "文本导入接口是否可用？");
  assert.deepEqual(duplicatePreview.items[0].comparison.incoming.correctAnswer, ["A"]);
  assert.deepEqual(duplicatePreview.items[0].comparison.existing.correctAnswer, ["A"]);

  const deletedResponse = await fetch(`http://127.0.0.1:${port}/api/admin/questions/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [created.question.id, committed.createdIds[0]] }),
  });
  const deleted = await deletedResponse.json();
  assert.equal(deletedResponse.status, 200);
  assert.equal(deleted.deletedCount, 2);
  const afterDelete = await fetch(`http://127.0.0.1:${port}/api/admin/questions?library=official`).then((response) => response.json());
  assert.equal(afterDelete.questions.length, 11);
  assert.equal(operationLogStore.list({ category: "question" }).items.some((item) => item.action === "question.batch_delete"), true);
  assert.equal(operationLogStore.list({ category: "question" }).items.some((item) => item.action === "question.import_batch_update"), true);
});

test("admin question group transition updates every answer item in one request", async (context) => {
  const operationLogStore = createMemoryAdminOperationStore();
  const questionStore = createMemoryQuestionStore([]);
  const questionIds = [1, 2, 3, 4].map((groupOrder) => questionStore.create({
    id: `api-material-${groupOrder}`,
    subjectId: "modern-chinese",
    bookId: "modern-chinese-7-1",
    chapter: "第四章 语法",
    knowledgePoints: ["句法分析"],
    type: "material_analysis",
    stem: `分析材料中的第 ${groupOrder} 个现象。`,
    referenceAnswer: `第 ${groupOrder} 个作答项答案。`,
    maxScore: 5,
    sourceLabel: "题组接口测试",
    questionGroupId: "exam-import:api-draft:mg48",
    questionGroupTitle: "第48题 · 材料题组",
    groupOrder,
  }).id);
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    operationLogStore,
    questionStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/admin/questions/batch-transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [questionIds[0]], action: "offline" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.count, 4);
  assert.equal(payload.questions.every((question) => question.status === "offline"), true);
  assert.equal(questionStore.list({ library: "official", status: "offline" }).counts.offline, 1);
  assert.equal(operationLogStore.list({ category: "question" }).items.some((item) => item.action === "question.batch_offline"), true);
});

test("subjective scoring endpoint returns a chargeable structured result only on success", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/ai/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionId: "demo-modern-chinese-011",
      answer: "现代汉民族共同语即普通话，以北京语音为标准音，以北方话为基础方言，以典范的现代白话文著作为语法规范。",
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.chargeable, false);
  assert.equal(payload.fastScoring, true);
  assert.equal(payload.result.totalScore, 10);
  assert.equal(payload.result.hitPoints.length, 4);

  const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/ai/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionId: "demo-modern-chinese-011", answer: "" }),
  });
  const invalidPayload = await invalidResponse.json();
  assert.equal(invalidResponse.status, 422);
  assert.equal(invalidPayload.chargeable, false);

  const disabledExplanation = await fetch(`http://127.0.0.1:${port}/api/ai/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionId: "demo-modern-chinese-001", userMessage: "请解析" }),
  });
  const disabledExplanationPayload = await disabledExplanation.json();
  assert.equal(disabledExplanation.status, 503);
  assert.equal(disabledExplanationPayload.chargeable, false);
  assert.equal(disabledExplanationPayload.error, "explanation_route_unavailable");
});

test("admin can save multiple model settings without exposing API keys", async (context) => {
  const aiConfigStore = createMemoryAiConfigStore();
  const server = createServer({ aiConfigStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const saved = await fetch(`http://127.0.0.1:${port}/api/admin/ai/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "测试供应商",
      baseUrl: "https://model.example.com/v1",
      apiKey: "Bearer secret-api-key-1234",
      models: ["model-a", "model-b"],
      enabled: true,
      supportsJsonMode: true,
    }),
  }).then((response) => response.json());
  assert.equal(saved.success, true);
  assert.equal(saved.provider.hasApiKey, true);
  assert.equal(saved.provider.apiKeyMasked.endsWith("1234"), true);
  assert.equal("apiKey" in saved.provider, false);
  assert.equal(aiConfigStore.load().providers[0].apiKey, "secret-api-key-1234");

  const config = await fetch(`http://127.0.0.1:${port}/api/admin/ai-config`).then((response) => response.json());
  assert.equal(config.providers.length, 1);
  assert.equal("apiKey" in config.providers[0], false);
  assert.equal(config.sceneDefinitions.length, 22);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "exam_paper_extraction"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "provider_connection_test" && scene.category === "system"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "exam_answer_supplement"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "learning_diagnosis"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "textbook_body_ocr"), true);
  assert.match(config.prompts.textbook_body_ocr.userPromptTemplate, /blocks/);
  assert.match(config.prompts.textbook_body_ocr.systemPrompt, /插图区域/);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "textbook_question_generation"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "question_enrichment"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "knowledge_feature_extraction"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "knowledge_batch_verification_fallback" && scene.routeOnly), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "knowledge_hierarchy_navigation"), true);
  assert.match(config.prompts.knowledge_feature_extraction.systemPrompt, /不负责选择教材目录/);
  assert.match(config.prompts.knowledge_hierarchy_navigation.systemPrompt, /不得重新生成、修改或覆盖 Agent 1 特征/);
  assert.doesNotMatch(config.prompts.knowledge_hierarchy_navigation.systemPrompt, /同时执行两个有边界的步骤/);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "knowledge_global_recovery"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "knowledge_batch_verification"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "knowledge_dossier_compilation"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "knowledge_dossier_verification"), true);
  assert.equal(config.sceneDefinitions.some((scene) => scene.id === "card_memory_assistance"), true);
  assert.equal(config.routes.semantic_dedup.mode, "disabled");
  assert.equal(config.prompts.subjective_scoring.version, 1);

  const routeResponse = await fetch(`http://127.0.0.1:${port}/api/admin/ai/routes/subjective_scoring`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "provider",
      providerId: saved.provider.id,
      model: "model-b",
      temperature: 0.2,
      maxTokens: 1800,
      reasoningEffort: "low",
      reviewModel: "model-a",
      reviewReasoningEffort: "medium",
      confidenceThreshold: 0.8,
    }),
  }).then((response) => response.json());
  assert.equal(routeResponse.success, true);
  assert.equal(routeResponse.route.model, "model-b");
  assert.equal(routeResponse.route.reasoningEffort, "low");
  assert.equal(routeResponse.route.reviewModel, "model-a");
  assert.equal(routeResponse.route.reviewReasoningEffort, "medium");
  assert.equal(routeResponse.route.confidenceThreshold, 0.8);

  const explanationRoute = await fetch(`http://127.0.0.1:${port}/api/admin/ai/routes/explanation_chat`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "provider",
      providerId: saved.provider.id,
      model: "model-b",
      fastModel: "model-a",
      temperature: 0.4,
      maxTokens: 2400,
      reasoningEffort: "low",
    }),
  }).then((response) => response.json());
  assert.equal(explanationRoute.success, true);
  assert.equal(explanationRoute.route.fastModel, "model-a");
  assert.equal(explanationRoute.route.reasoningEffort, "low");

  const dedupRoute = await fetch(`http://127.0.0.1:${port}/api/admin/ai/routes/semantic_dedup`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "provider",
      providerId: saved.provider.id,
      model: "model-a",
      temperature: 0.1,
      maxTokens: 1200,
    }),
  }).then((response) => response.json());
  assert.equal(dedupRoute.success, true);
  assert.equal(dedupRoute.route.model, "model-a");

  const promptResponse = await fetch(`http://127.0.0.1:${port}/api/admin/ai/prompts/semantic_dedup`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemPrompt: "自定义查重系统提示词",
      userPromptTemplate: "题目：{{candidateQuestion}}",
    }),
  }).then((response) => response.json());
  assert.equal(promptResponse.success, true);
  assert.equal(promptResponse.prompt.version, 2);
  assert.equal(promptResponse.prompt.systemPrompt, "自定义查重系统提示词");
});

test("configured OpenAI-compatible provider handles connection tests and scoring failures safely", async (context) => {
  let authorization = "";
  let lastUpstreamPayload = null;
  let upstreamCompletionCalls = 0;
  const upstream = http.createServer((request, response) => {
    authorization = request.headers.authorization || "";
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "score-model" }, { id: "backup-model" }] }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      upstreamCompletionCalls += 1;
      const payload = JSON.parse(body);
      lastUpstreamPayload = payload;
      const isConnectivityTest = payload.max_tokens === 32;
      const isExplanation = body.includes("真实解析请求");
      const malformed = body.includes("触发格式错误");
      const structuredResult = {
        totalScore: 10,
        hitPoints: [
          { id: "definition", description: "共同语即普通话", awardedScore: 2, maxScore: 2, evidence: ["普通话"], status: "hit" },
          { id: "standard-pronunciation", description: "北京语音为标准音", awardedScore: 2, maxScore: 2, evidence: ["北京语音"], status: "hit" },
          { id: "base-dialect", description: "北方话为基础方言", awardedScore: 2, maxScore: 2, evidence: ["北方话"], status: "hit" },
          { id: "grammar-standard", description: "现代白话文语法规范", awardedScore: 4, maxScore: 4, evidence: ["现代白话文"], status: "hit" },
        ],
        missedPoints: [],
        errors: [],
        expressionSuggestions: ["表达完整"],
        referenceComparison: "覆盖全部得分点",
        confidence: 0.94,
        uncertainty: "低不确定性",
      };
      const content = isConnectivityTest
        ? "连接成功"
        : (isExplanation ? "这是由真实模型接口生成的补充解析。" : (malformed ? "不是 JSON" : JSON.stringify(structuredResult)));
      if (isExplanation && payload.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        response.write(`data: ${JSON.stringify({ model: payload.model, choices: [{ delta: { content: "## 核心判断\n\n" } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ model: payload.model, choices: [{ delta: { content: "这是流式生成的**补充解析**。" } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: payload.model,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamPort = upstream.address().port;
  const provider = {
    id: "provider-test",
    name: "本地模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: "test-secret",
    models: ["score-model", "gpt-5.4-mini"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      subjective_scoring: {
        mode: "provider",
        providerId: provider.id,
        model: "score-model",
        temperature: 0.2,
        maxTokens: 1800,
      },
      explanation_chat: {
        mode: "provider",
        providerId: provider.id,
        model: "score-model",
        fastModel: "gpt-5.4-mini",
        temperature: 0.4,
        maxTokens: 1600,
        reasoningEffort: "low",
      },
    },
    prompts: {
      subjective_scoring: {
        systemPrompt: "自定义阅卷系统提示词",
        userPromptTemplate: "题目：{{question}}\n用户答案：{{studentAnswer}}\n输出：{{requiredOutput}}",
        version: 3,
      },
      explanation_chat: {
        systemPrompt: "自定义解析系统提示词",
        userPromptTemplate: "真实解析请求：{{question}}\n追问：{{userMessage}}\n历史：{{conversationHistory}}",
        version: 2,
      },
      provider_connection_test: {
        systemPrompt: "自定义连通性测试系统提示词",
        userPromptTemplate: "连通性测试请求：{{providerName}} / {{model}}",
        version: 2,
      },
    },
  });
  const server = createServer({ aiConfigStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const modelsPayload = await fetch(`http://127.0.0.1:${port}/api/admin/ai/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: provider.id }),
  }).then((response) => response.json());
  assert.equal(modelsPayload.success, true);
  assert.deepEqual(modelsPayload.models, ["backup-model", "score-model"]);
  assert.equal(authorization, "Bearer test-secret");

  const testPayload = await fetch(`http://127.0.0.1:${port}/api/admin/ai/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: provider.id, model: "score-model" }),
  }).then((response) => response.json());
  assert.equal(testPayload.success, true);
  assert.equal(testPayload.result.preview, "连接成功");
  assert.equal(testPayload.result.viaTestRoute, false);
  assert.equal(authorization, "Bearer test-secret");
  // 连通性测试的提示词来自「供应商连通性测试」场景路由，不再是写死的一句。
  assert.equal(lastUpstreamPayload.messages[0].content, "自定义连通性测试系统提示词");
  assert.equal(lastUpstreamPayload.messages[1].content, "连通性测试请求：本地模拟模型 / score-model");
  assert.equal(lastUpstreamPayload.max_tokens, 32);

  const scoringResponse = await fetch(`http://127.0.0.1:${port}/api/ai/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionId: "demo-modern-chinese-011",
      answer: "普通话采用北京语音作为标准音，也以北方话作为基础方言，现代白话文著作形成语法规范。",
    }),
  });
  const scoringPayload = await scoringResponse.json();
  assert.equal(scoringResponse.status, 200);
  assert.equal(scoringPayload.chargeable, true);
  assert.equal(scoringPayload.result.graderMode, "ai_model");
  assert.equal(scoringPayload.result.totalScore, 10);
  assert.equal(lastUpstreamPayload.max_tokens, 1000);
  assert.deepEqual(lastUpstreamPayload.response_format, { type: "json_object" });
  assert.equal(lastUpstreamPayload.reasoning_effort, "low");
  assert.equal(lastUpstreamPayload.messages[0].content, "自定义阅卷系统提示词");
  assert.match(lastUpstreamPayload.messages[1].content, /北京语音/);
  const callsAfterInitialScore = upstreamCompletionCalls;

  const cachedScoringResponse = await fetch(`http://127.0.0.1:${port}/api/ai/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionId: "demo-modern-chinese-011",
      answer: "普通话采用北京语音作为标准音，也以北方话作为基础方言，现代白话文著作形成语法规范。",
      requestId: "cached-score-request",
    }),
  });
  const cachedScoringPayload = await cachedScoringResponse.json();
  assert.equal(cachedScoringPayload.cached, true);
  assert.equal(cachedScoringPayload.chargeable, false);
  assert.equal(upstreamCompletionCalls, callsAfterInitialScore);

  const rescoringResponse = await fetch(`http://127.0.0.1:${port}/api/ai/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionId: "demo-modern-chinese-011",
      answer: "普通话采用北京语音作为标准音，也以北方话作为基础方言，现代白话文著作形成语法规范。",
      requestId: "rescore-request",
      rescore: true,
    }),
  });
  const rescoringPayload = await rescoringResponse.json();
  assert.equal(rescoringPayload.chargeable, true);
  assert.equal(lastUpstreamPayload.reasoning_effort, "medium");
  assert.equal(upstreamCompletionCalls, callsAfterInitialScore + 1);

  const explanationResponse = await fetch(`http://127.0.0.1:${port}/api/ai/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionId: "demo-modern-chinese-001",
      userMessage: "为什么其他选项不对？",
      userAnswer: "A",
      resultLabel: "回答正确",
      conversationHistory: [{ role: "assistant", text: "上一轮解析" }],
    }),
  });
  const explanationPayload = await explanationResponse.json();
  assert.equal(explanationResponse.status, 200);
  assert.equal(explanationPayload.success, true);
  assert.equal(explanationPayload.chargeable, true);
  assert.equal(explanationPayload.result.text, "这是由真实模型接口生成的补充解析。");
  assert.equal(lastUpstreamPayload.messages[0].content, "自定义解析系统提示词");
  assert.match(lastUpstreamPayload.messages[1].content, /为什么其他选项不对/);
  assert.equal(lastUpstreamPayload.model, "gpt-5.4-mini");
  assert.equal(lastUpstreamPayload.reasoning_effort, "low");

  const complexExplanationResponse = await fetch(`http://127.0.0.1:${port}/api/ai/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionId: "demo-modern-chinese-011",
      userMessage: "请说明这个主观题的作答思路",
      userAnswer: "",
      resultLabel: "未作答",
      conversationHistory: [],
    }),
  });
  assert.equal(complexExplanationResponse.status, 200);
  assert.equal(lastUpstreamPayload.model, "score-model");
  assert.equal(lastUpstreamPayload.reasoning_effort, "low");

  const streamingResponse = await fetch(`http://127.0.0.1:${port}/api/ai/explain/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionId: "demo-modern-chinese-001",
      userMessage: "请流式解析",
      userAnswer: "A",
      resultLabel: "回答正确",
      conversationHistory: [],
      requestId: "stream-test-request",
    }),
  });
  const streamEvents = (await streamingResponse.text()).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(streamingResponse.status, 200);
  assert.deepEqual(streamEvents.map((event) => event.type), ["meta", "delta", "done"]);
  assert.equal(streamEvents[0].requestId, "stream-test-request");
  assert.equal(streamEvents[1].text, "## 核心判断\n\n这是流式生成的**补充解析**。");
  assert.equal(streamEvents[2].chargeable, true);
  assert.equal(streamEvents[2].usage.total_tokens, 120);
  assert.equal(lastUpstreamPayload.stream, true);
  assert.equal(lastUpstreamPayload.model, "gpt-5.4-mini");
  assert.equal(lastUpstreamPayload.reasoning_effort, "low");

  const malformedResponse = await fetch(`http://127.0.0.1:${port}/api/ai/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionId: "demo-modern-chinese-011", answer: "这是一段用于触发格式错误的主观题答案。" }),
  });
  const malformedPayload = await malformedResponse.json();
  assert.equal(malformedResponse.status, 502);
  assert.equal(malformedPayload.chargeable, false);
  assert.equal(malformedPayload.error, "provider_output_format_error");

  const taskDashboard = await fetch(`http://127.0.0.1:${port}/api/admin/ai-tasks`).then((response) => response.json());
  assert.equal(taskDashboard.success, true);
  assert.equal(taskDashboard.today.total, 8);
  assert.equal(taskDashboard.today.succeeded, 7);
  assert.equal(taskDashboard.today.failed, 1);
  assert.equal(taskDashboard.today.errorBreakdown[0].category, "output_format");
  const streamingTask = taskDashboard.tasks.find((task) => task.streaming);
  assert.equal(streamingTask.status, "succeeded");
  assert.equal(Number.isFinite(streamingTask.firstTokenMs), true);
  assert.equal(streamingTask.inputSummary.questionId, "demo-modern-chinese-001");
  assert.equal(streamingTask.inputSummary.routeStrategy, "fast_objective");
  assert.equal(streamingTask.inputSummary.evidenceChunks <= 4, true);
  assert.equal(streamingTask.model, "gpt-5.4-mini");
  assert.equal(Number.isFinite(streamingTask.timings.retrievalMs), true);
  assert.equal(Number.isFinite(streamingTask.timings.connectMs), true);
  assert.equal(Number.isFinite(streamingTask.timings.upstreamFirstTokenMs), true);
  assert.equal(Number.isFinite(streamingTask.timings.generationMs), true);
  const complexExplanationTask = taskDashboard.tasks.find((task) => task.sceneId === "explanation_chat" && task.inputSummary.routeStrategy === "standard");
  assert.equal(complexExplanationTask.model, "score-model");
  assert.equal("userMessage" in streamingTask.inputSummary, false);
  const failedTask = taskDashboard.tasks.find((task) => task.status === "failed");
  assert.equal(failedTask.chargeable, false);
  assert.equal(failedTask.firstTokenMs, null);
  assert.equal(failedTask.failureStage, "upstream_scoring");
  const scoringTask = taskDashboard.tasks.find((task) => task.sceneId === "subjective_scoring" && task.status === "succeeded");
  assert.equal(Number.isFinite(scoringTask.timings.upstreamMs), true);
  assert.equal(Number.isFinite(scoringTask.timings.parseMs), true);
  assert.equal(Number.isFinite(scoringTask.timings.normalizeMs), true);

  const failedOnly = await fetch(`http://127.0.0.1:${port}/api/admin/ai-tasks?status=failed`).then((response) => response.json());
  assert.equal(failedOnly.tasks.length, 1);
  assert.equal(failedOnly.tasks[0].errorCode, "provider_output_format_error");
});
