const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");
const {
  createFileQuestionEnrichmentStore,
  createMemoryQuestionEnrichmentStore,
  questionEnrichmentNeeds,
} = require("../apps/api/src/question-enrichment-store");

// 提示词模板会把每个段落渲染成 JSON（对象或数组）再拼进说明文字里；
// 这里按段落标签切出该段的 JSON——顺带验证了"这一段确实在提示词里"。
function extractPromptSection(text, label) {
  const source = String(text);
  const start = source.indexOf(label);
  assert.notEqual(start, -1, `prompt_missing_section:${label}`);
  const body = source.slice(start + label.length);
  const open = body.search(/[[{]/);
  assert.notEqual(open, -1, `prompt_section_not_json:${label}`);
  const stack = [];
  let inString = false;
  for (let index = open; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (char !== stack.pop()) throw new Error(`prompt_section_json_unbalanced:${label}`);
      if (!stack.length) return JSON.parse(body.slice(open, index + 1));
    }
  }
  throw new Error(`prompt_section_json_unterminated:${label}`);
}

const pendingQuestion = {
  id: "pending-enrichment-question",
  subjectId: "modern-chinese",
  bookId: "modern-chinese-7-1",
  chapter: "待归类",
  knowledgePoints: ["待归类"],
  type: "short_answer",
  stem: "普通话的定义是什么？",
  referenceAnswer: "普通话是现代汉民族共同语。",
  maxScore: 4,
  scoringPoints: [],
};

test("question enrichment needs distinguish catalog, knowledge and scoring gaps", () => {
  assert.deepEqual(questionEnrichmentNeeds({
    ...pendingQuestion,
    scoringPointStatus: "needs_split",
  }), {
    needs: ["chapter", "knowledge_points", "scoring_points"],
    needsTextbook: false,
    needsChapter: true,
    needsKnowledgePoints: true,
    needsScoringPoints: true,
    needsFingerprint: false,
    needsFamily: false,
    complete: false,
  });
  assert.equal(questionEnrichmentNeeds({
    ...pendingQuestion,
    chapter: "第一章 绪论",
    knowledgePoints: ["现代汉语共同语"],
    scoringPointStatus: "complete",
  }).complete, true);
  // 跨册批次（2026-09-24）：教材缺失本身就是一项待完善——章节与知识点都挂在教材下面，
  // 不把它算进来，整批"未指定教材"的题会在列表里显示成一堆"生成失败"。
  assert.deepEqual(questionEnrichmentNeeds({
    ...pendingQuestion,
    bookId: "",
    chapter: "",
    knowledgePoints: [],
    type: "single_choice",
  }), {
    needs: ["textbook", "chapter", "knowledge_points"],
    needsTextbook: true,
    needsChapter: true,
    needsKnowledgePoints: true,
    needsScoringPoints: false,
    needsFingerprint: false,
    needsFamily: false,
    complete: false,
  });
});

test("question enrichment needs accept store-derived fingerprint and family gaps", () => {
  // 2026-09-26 产品负责人确认：知识指纹与题族归属也算「待完善」，但它们不是题目字段能判断的——
  // 由调用方按册算好传进来（见 server.js 的 enrichmentDerivedNeedsForBook）。
  const complete = {
    ...pendingQuestion,
    chapter: "第一章 绪论",
    knowledgePoints: ["现代汉语共同语"],
    scoringPointStatus: "complete",
  };
  assert.deepEqual(questionEnrichmentNeeds(complete, { needsFingerprint: true, needsFamily: true }).needs,
    ["knowledge_fingerprint", "family"]);
  assert.equal(questionEnrichmentNeeds(complete, { needsFingerprint: true, needsFamily: true }).complete, false);
  // 不传 derived 时行为与历史一致（只有教材/章节/知识点/得分点四项）
  assert.deepEqual(questionEnrichmentNeeds(complete).needs, []);
  // 只缺其中一项时也要能单独派生出来
  assert.deepEqual(questionEnrichmentNeeds(complete, { needsFamily: true }).needs, ["family"]);
  assert.deepEqual(questionEnrichmentNeeds(complete, { needsFingerprint: true }).needs, ["knowledge_fingerprint"]);
  // 传 null/undefined 不能抛错（历史调用方可能这样传）
  assert.equal(questionEnrichmentNeeds(complete, null).complete, true);
  assert.equal(questionEnrichmentNeeds(complete, undefined).complete, true);
});

test("question enrichment suggestions and jobs persist and interrupted jobs recover", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-enrichment-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "enrichment.json");
  const store = createFileQuestionEnrichmentStore(filePath);
  const job = store.createJob(["q-1", "q-2"]);
  store.updateJob(job.id, { status: "running", completed: 1, succeeded: 1 });
  store.addSuggestion({
    questionId: "q-1",
    questionVersion: 2,
    chapterNodeId: "node-1",
    catalogPath: "第一章",
    knowledgePoints: ["知识点"],
    confidence: 0.91,
  });

  const reloaded = createFileQuestionEnrichmentStore(filePath);
  assert.equal(reloaded.latest("q-1").confidence, 0.91);
  assert.equal(reloaded.getJob(job.id).status, "interrupted");
  assert.equal(reloaded.getJob(job.id).error, "server_interrupted");
});

test("admin enrichment list, field-level apply and revert preserve official answers", async (context) => {
  const questionStore = createMemoryQuestionStore([]);
  const question = questionStore.create(pendingQuestion, "测试编辑");
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft(question.bookId, [{
    id: "catalog-modern-definition",
    level: 1,
    title: "第一章 绪论",
    startPage: 1,
    endPage: 12,
    knowledgePoints: ["现代汉语共同语"],
  }], { source: "test" }, "测试编辑");
  const textbook = textbookCatalogStore.confirm(question.bookId, "测试编辑");
  const node = textbook.confirmed.nodes[0];
  const questionEnrichmentStore = createMemoryQuestionEnrichmentStore();
  const suggestion = questionEnrichmentStore.addSuggestion({
    questionId: question.id,
    questionVersion: question.version,
    chapterNodeId: node.id,
    catalogPath: "第一章 绪论",
    knowledgePoints: ["现代汉语共同语"],
    scoringPoints: [{
      description: "指出普通话的性质",
      score: 4,
      textbookPage: "1-2",
      pageBasis: "confirmed_catalog",
      sourceNote: "现代汉语 · 第一章 绪论",
    }],
    confidence: 0.94,
  });
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    textbookCatalogStore,
    questionEnrichmentStore,
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/question-enrichment?bookId=${question.bookId}`).then((response) => response.json());
  assert.equal(listing.summary.chapter, 1);
  assert.equal(listing.summary.scoringPoints, 1);
  assert.equal(listing.items[0].suggestion.id, suggestion.id);

  // 归类状态按缺失字段实时派生：占位串「待归类」算缺失，列表条目直接带出来，
  // 后台「题目完善中心」据此筛选，不需要再存一个状态字段。
  assert.equal(listing.summary.pendingClassification, 1);
  assert.equal(listing.items[0].question.needsClassification, true);
  assert.deepEqual(listing.items[0].question.classification.missing, ["chapter", "knowledge_points"]);
  const pendingClassificationOnly = await fetch(`${baseUrl}/api/admin/question-enrichment?classification=pending`).then((response) => response.json());
  assert.equal(pendingClassificationOnly.total, 1);
  const assignedOnly = await fetch(`${baseUrl}/api/admin/question-enrichment?classification=assigned`).then((response) => response.json());
  assert.equal(assignedOnly.total, 0);

  const appliedResponse = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestionId: suggestion.id }),
  });
  const applied = await appliedResponse.json();
  assert.equal(appliedResponse.status, 200);
  assert.equal(applied.question.chapter, "第一章 绪论");
  assert.deepEqual(applied.question.knowledgePoints, ["现代汉语共同语"]);
  assert.equal(applied.question.scoringPointStatus, "complete");
  assert.equal(applied.question.referenceAnswer, pendingQuestion.referenceAnswer);
  assert.equal(applied.question.version, 2);

  // 补充归属后同一批题从「待归类」移到「已归类」——仍是同一份派生结果。
  const assignedAfterApply = await fetch(`${baseUrl}/api/admin/question-enrichment?classification=assigned`).then((response) => response.json());
  assert.equal(assignedAfterApply.total, 1);
  assert.equal(assignedAfterApply.items[0].question.needsClassification, false);
  const pendingAfterApply = await fetch(`${baseUrl}/api/admin/question-enrichment?classification=pending`).then((response) => response.json());
  assert.equal(pendingAfterApply.total, 0);

  const revertedResponse = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/revert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestionId: suggestion.id }),
  });
  const reverted = await revertedResponse.json();
  assert.equal(revertedResponse.status, 200);
  assert.equal(reverted.question.chapter, "待归类");
  assert.deepEqual(reverted.question.knowledgePoints, ["待归类"]);
  assert.deepEqual(reverted.question.scoringPoints, []);
  assert.equal(reverted.question.referenceAnswer, pendingQuestion.referenceAnswer);
  assert.equal(reverted.question.version, 3);
  assert.equal(operationLogStore.list({ category: "question" }).items.length, 2);
});

// 跨册批次（2026-09-24 产品负责人确认）：一个导入批次横跨上下册时"批次级只能挂一本教材"，
// 于是整批留空＝待归类。这里验证新形态：AI 在**整个科目**的已确认目录里挑册次，
// 建议稿带 bookId，采纳时教材归属与目录、知识点一起写入（版本 +1、留下 bookIdFrom/To 痕迹）。
test("cross-volume enrichment picks the volume in the subject catalog and writes it on apply", async (context) => {
  const catalogs = {
    "modern-chinese-7-1": [{ id: "node-upper-voicing", level: 1, title: "第一章 语音", startPage: 1, endPage: 40, knowledgePoints: ["声母"] }],
    "modern-chinese-7-2": [{ id: "node-lower-syntax", level: 1, title: "第五章 语法", startPage: 201, endPage: 260, knowledgePoints: ["短语的结构类型"] }],
  };
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  Object.entries(catalogs).forEach(([bookId, nodes]) => {
    textbookCatalogStore.setDraft(bookId, nodes, { source: "test" }, "测试编辑");
    textbookCatalogStore.confirm(bookId, "测试编辑");
  });
  const questionStore = createMemoryQuestionStore([]);
  const question = questionStore.create({
    id: "unassigned-cross-volume",
    subjectId: "modern-chinese",
    bookId: "",
    chapter: "",
    knowledgePoints: [],
    type: "single_choice",
    stem: "下列短语属于主谓短语的是？",
    options: [{ key: "A", text: "阳光灿烂" }, { key: "B", text: "灿烂阳光" }],
    correctAnswer: ["A"],
    maxScore: 2,
  }, "测试编辑");
  assert.equal(question.bookId, "");

  const prompts = [];
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      prompts.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "enrichment-model",
        choices: [{
          message: {
            content: JSON.stringify({
              bookId: "modern-chinese-7-2",
              catalogNodeId: "node-lower-syntax",
              knowledgePoints: ["短语的结构类型"],
              scoringPoints: [],
              confidence: 0.72,
              reason: "题干考短语结构类型，属下册语法章。",
              uncertainty: "题面没有页码，册次按术语判断。",
            }),
          },
        }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = {
    id: "enrichment-provider",
    name: "完善模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test",
    models: ["enrichment-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const questionEnrichmentStore = createMemoryQuestionEnrichmentStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore({
      providers: [provider],
      routes: {
        question_enrichment: { mode: "provider", providerId: provider.id, model: "enrichment-model", temperature: 0.1, maxTokens: 2000 },
      },
    }),
    questionStore,
    textbookCatalogStore,
    questionEnrichmentStore,
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${baseUrl}/api/admin/question-enrichment?bookId=__unassigned__`).then((response) => response.json());
  assert.equal(listing.total, 1);
  assert.equal(listing.summary.textbook, 1);
  assert.deepEqual(listing.items[0].needs.needs, ["textbook", "chapter", "knowledge_points"]);

  const created = await fetch(`${baseUrl}/api/admin/question-enrichment/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIds: [question.id] }),
  }).then((response) => response.json());
  let job;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    job = (await fetch(`${baseUrl}/api/admin/question-enrichment/jobs/${created.job.id}`).then((response) => response.json())).job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "completed", JSON.stringify(job));

  // 提示词里必须同时给出"候选教材"与"节点属于哪一册"：题目没有教材时没有唯一一本，
  // AI 定册次的依据就是这两样，少一样它就只能瞎猜。
  const lastMessage = String(prompts[0].messages[prompts[0].messages.length - 1].content || "");
  const candidateTextbooks = extractPromptSection(lastMessage, "候选教材（题目未定教材时必须从中选一本；目录节点自带 bookId，须与所选教材一致）：");
  const confirmedCatalog = extractPromptSection(lastMessage, "已确认目录（只能引用其中的 id）：");
  assert.deepEqual(candidateTextbooks.map((item) => item.id).sort(), ["modern-chinese-7-1", "modern-chinese-7-2"]);
  assert.equal(candidateTextbooks.every((item) => item.isCurrent === false), true);
  assert.deepEqual(
    [...new Set(confirmedCatalog.map((node) => node.bookId))].sort(),
    ["modern-chinese-7-1", "modern-chinese-7-2"],
  );
  assert.equal(confirmedCatalog.find((node) => node.id === "node-lower-syntax").bookLabel, "现代汉语（增订七版） · 下册");

  const suggestion = questionEnrichmentStore.latest(question.id);
  assert.equal(suggestion.status, "recommended");
  assert.equal(suggestion.bookId, "modern-chinese-7-2");
  assert.equal(suggestion.bookLabel, "现代汉语（增订七版） · 下册");
  assert.equal(suggestion.chapterNodeId, "node-lower-syntax");

  // 换教材必须同时采纳目录与知识点：章节与知识点是教材的下级，
  // 只换教材不写目录＝把另一册的章节路径留在题上。
  const refused = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      suggestionId: suggestion.id,
      fields: { textbook: true, chapter: false, knowledgePoints: false },
      overrides: { bookId: "modern-chinese-7-2" },
    }),
  }).then((response) => response.json());
  assert.equal(refused.success, false);
  assert.equal(refused.error, "question_enrichment_book_change_requires_classification");

  const appliedResponse = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      suggestionId: suggestion.id,
      fields: { textbook: true, chapter: true, knowledgePoints: true },
      overrides: { bookId: "modern-chinese-7-2", chapterNodeId: "node-lower-syntax", knowledgePoints: ["短语的结构类型"] },
    }),
  });
  const applied = await appliedResponse.json();
  assert.equal(appliedResponse.status, 200, JSON.stringify(applied));
  assert.equal(applied.question.bookId, "modern-chinese-7-2");
  assert.equal(applied.question.chapter, "第五章 语法");
  assert.deepEqual(applied.question.knowledgePoints, ["短语的结构类型"]);
  assert.equal(applied.question.version, 2);
  assert.deepEqual(applied.suggestion.appliedFields, ["textbook", "chapter", "knowledgePoints"]);

  const applyLog = operationLogStore.list({ category: "question" }).items.find((item) => item.action === "question.enrichment_apply");
  assert.equal(applyLog.metadata.bookIdFrom, "");
  assert.equal(applyLog.metadata.bookIdTo, "modern-chinese-7-2");

  // 撤回要把教材一起退回"待归类"，并且不能把空教材下的章节/知识点写回去。
  const reverted = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/revert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestionId: suggestion.id }),
  }).then((response) => response.json());
  assert.equal(reverted.question.bookId, "");
  assert.equal(reverted.question.chapter, "");
  assert.deepEqual(reverted.question.knowledgePoints, []);
  assert.equal(reverted.question.version, 3);
});

test("enrichment refuses to guess a volume when the AI names a book outside the subject catalog", async (context) => {
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  textbookCatalogStore.setDraft("modern-chinese-7-1", [{ id: "node-upper", level: 1, title: "第一章 语音", startPage: 1, endPage: 20, knowledgePoints: ["声母"] }], { source: "test" }, "测试编辑");
  textbookCatalogStore.confirm("modern-chinese-7-1", "测试编辑");
  const questionStore = createMemoryQuestionStore([]);
  const question = questionStore.create({
    id: "unassigned-no-subject",
    subjectId: "modern-chinese",
    bookId: "",
    chapter: "",
    knowledgePoints: [],
    type: "single_choice",
    stem: "声母的发音部位怎么判断？",
    options: [{ key: "A", text: "看阻碍部位" }, { key: "B", text: "看声带是否振动" }],
    correctAnswer: ["A"],
    maxScore: 2,
  }, "测试编辑");
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "enrichment-model",
        choices: [{ message: { content: JSON.stringify({ bookId: "ancient-literature-2-1", knowledgePoints: ["声母"], confidence: 0.5 }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = {
    id: "enrichment-provider",
    name: "完善模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test",
    models: ["enrichment-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const questionEnrichmentStore = createMemoryQuestionEnrichmentStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore({
      providers: [provider],
      routes: { question_enrichment: { mode: "provider", providerId: provider.id, model: "enrichment-model", temperature: 0.1, maxTokens: 1000 } },
    }),
    questionStore,
    textbookCatalogStore,
    questionEnrichmentStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${baseUrl}/api/admin/question-enrichment/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIds: [question.id] }),
  }).then((response) => response.json());
  let job;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    job = (await fetch(`${baseUrl}/api/admin/question-enrichment/jobs/${created.job.id}`).then((response) => response.json())).job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // 跨科目教材一律拒收：只有本科目已确认目录里的册次可以被建议出来。
  assert.equal(job.status, "failed");
  assert.equal(questionEnrichmentStore.latest(question.id).error, "question_enrichment_book_invalid");
  assert.equal(questionStore.get(question.id).bookId, "");
});

// 归属判断四级链（DEC-098，2026-09-24 产品负责人确认）：项目 → 科目 → 教材 → 知识树。
// 下面这个夹具把"AI 认为这道题其实属于另一个科目"跑通一遍：候选科目＝项目内**目录已确认**的
// 全部科目、建议必须带证据、写库只发生在人工勾了「采纳科目归属」之后、并把去向留在操作日志里。
async function startEnrichmentFixture(context, { catalogs, question, aiReplies }) {
  const textbookCatalogStore = createMemoryTextbookCatalogStore();
  Object.entries(catalogs).forEach(([bookId, nodes]) => {
    textbookCatalogStore.setDraft(bookId, nodes, { source: "test" }, "测试编辑");
    textbookCatalogStore.confirm(bookId, "测试编辑");
  });
  const questionStore = createMemoryQuestionStore([]);
  const created = questionStore.create(question, "测试编辑");
  const prompts = [];
  const replies = [...aiReplies];
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      prompts.push(JSON.parse(body));
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "enrichment-model",
        choices: [{ message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = {
    id: "enrichment-provider",
    name: "完善模拟模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test",
    models: ["enrichment-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const questionEnrichmentStore = createMemoryQuestionEnrichmentStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore({
      providers: [provider],
      routes: {
        question_enrichment: { mode: "provider", providerId: provider.id, model: "enrichment-model", temperature: 0.1, maxTokens: 2000 },
      },
    }),
    questionStore,
    textbookCatalogStore,
    questionEnrichmentStore,
    operationLogStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const runJob = async (questionId) => {
    const createdJob = await fetch(`${baseUrl}/api/admin/question-enrichment/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionIds: [questionId] }),
    }).then((response) => response.json());
    let job;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      job = (await fetch(`${baseUrl}/api/admin/question-enrichment/jobs/${createdJob.job.id}`).then((response) => response.json())).job;
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return job;
  };
  return { baseUrl, question: created, questionStore, questionEnrichmentStore, operationLogStore, prompts, runJob };
}

test("enrichment offers every subject of the project and writes the subject only on human acceptance", async (context) => {
  const { baseUrl, question, questionStore, questionEnrichmentStore, operationLogStore, prompts, runJob } = await startEnrichmentFixture(context, {
    catalogs: {
      "modern-chinese-7-1": [{ id: "node-upper-phonetics", level: 1, title: "第一章 语音", startPage: 1, endPage: 40, knowledgePoints: ["声母"] }],
      "classical-chinese-1": [{ id: "node-cc-1-script", level: 1, title: "第一单元 文字", startPage: 1, endPage: 30, knowledgePoints: ["古今字"] }],
    },
    question: {
      id: "subject-mismatch-question",
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      chapter: "",
      knowledgePoints: [],
      type: "single_choice",
      stem: "下列各组字中，属于古今字关系的是？",
      options: [{ key: "A", text: "莫—暮" }, { key: "B", text: "看—瞧" }],
      correctAnswer: ["A"],
      maxScore: 2,
    },
    aiReplies: [{
      projectId: "gd-zsb-2026-hywxxkjc",
      subjectId: "classical-chinese",
      bookId: "classical-chinese-1",
      catalogNodeId: "node-cc-1-script",
      knowledgePoints: ["古今字"],
      scoringPoints: [],
      confidence: 0.83,
      reason: "古今字属古代汉语文字单元，现代汉语教材不设此考点。",
      uncertainty: "题面未给来源页码。",
    }],
  });

  const job = await runJob(question.id);
  assert.equal(job.status, "completed", JSON.stringify(job));

  // 提示词必须把两级候选都给出来：候选科目（题目当前科目标 isCurrent）与候选教材（带 subjectId）。
  const lastMessage = String(prompts[0].messages[prompts[0].messages.length - 1].content || "");
  const candidateSubjects = extractPromptSection(lastMessage, "候选科目（必须从中选一个；科目与教材必须同源）：");
  const candidateTextbooks = extractPromptSection(lastMessage, "候选教材（题目未定教材时必须从中选一本；目录节点自带 bookId，须与所选教材一致）：");
  assert.deepEqual(candidateSubjects.map((subject) => subject.id).sort(), ["classical-chinese", "modern-chinese"]);
  assert.equal(candidateSubjects.find((subject) => subject.id === "modern-chinese").isCurrent, true);
  assert.equal(candidateSubjects.find((subject) => subject.id === "classical-chinese").isCurrent, false);
  assert.deepEqual(candidateTextbooks.map((item) => item.subjectId).sort(), ["classical-chinese", "modern-chinese"]);
  // 项目一级也在提示词里（今天只有一个项目，接口按多项目预留）。
  assert.equal(extractPromptSection(lastMessage, "候选考试项目（必须复述唯一项目 id）：")[0].id, "gd-zsb-2026-hywxxkjc");

  const suggestion = questionEnrichmentStore.latest(question.id);
  assert.equal(suggestion.subjectId, "classical-chinese");
  assert.equal(suggestion.subjectLabel, "古代汉语");
  assert.equal(suggestion.bookId, "classical-chinese-1");

  // 列表把"建议换科目"单独计数：它不允许走批量采纳，必须逐条复核。
  const listing = await fetch(`${baseUrl}/api/admin/question-enrichment?subjectId=all`).then((response) => response.json());
  assert.equal(listing.summary.subject, 1);

  // 只勾科目、不带目录与知识点 → 拒绝：换科目等于换一整棵知识树。
  const refused = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      suggestionId: suggestion.id,
      fields: { subject: true, textbook: false, chapter: false, knowledgePoints: false },
      overrides: { subjectId: "classical-chinese" },
    }),
  }).then((response) => response.json());
  assert.equal(refused.success, false);
  assert.equal(refused.error, "question_enrichment_subject_change_requires_classification");

  // 批量采纳跳过"建议换科目"的那些，并如实报出跳过数，不让数字对不上。
  const batch = await fetch(`${baseUrl}/api/admin/question-enrichment/apply-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIds: [question.id], confidenceThreshold: 0.5 }),
  }).then((response) => response.json());
  assert.equal(batch.success, false);
  assert.equal(batch.error, "question_enrichment_subject_change_requires_review");
  assert.equal(questionStore.get(question.id).subjectId, "modern-chinese");

  const appliedResponse = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      suggestionId: suggestion.id,
      fields: { subject: true, textbook: true, chapter: true, knowledgePoints: true },
      overrides: { subjectId: "classical-chinese", bookId: "classical-chinese-1", chapterNodeId: "node-cc-1-script", knowledgePoints: ["古今字"] },
    }),
  });
  const applied = await appliedResponse.json();
  assert.equal(appliedResponse.status, 200, JSON.stringify(applied));
  assert.equal(applied.question.subjectId, "classical-chinese");
  assert.equal(applied.question.bookId, "classical-chinese-1");
  assert.equal(applied.question.chapter, "第一单元 文字");
  assert.deepEqual(applied.question.knowledgePoints, ["古今字"]);
  assert.equal(applied.question.version, 2);
  assert.deepEqual(applied.suggestion.appliedFields, ["subject", "textbook", "chapter", "knowledgePoints"]);

  const applyLog = operationLogStore.list({ category: "question" }).items.find((item) => item.action === "question.enrichment_apply");
  assert.equal(applyLog.metadata.subjectIdFrom, "modern-chinese");
  assert.equal(applyLog.metadata.subjectIdTo, "classical-chinese");
  assert.equal(applyLog.metadata.bookIdFrom, "modern-chinese-7-1");
  assert.equal(applyLog.metadata.bookIdTo, "classical-chinese-1");

  // 准确率的度量口径：这一级的建议数 / 采纳数 / 目标值都能读到，否则"可以设置目标"无从核对。
  const accuracy = await fetch(`${baseUrl}/api/admin/question-enrichment/accuracy`).then((response) => response.json());
  assert.equal(accuracy.success, true);
  assert.equal(accuracy.levels.subject.suggested, 1);
  assert.equal(accuracy.levels.subject.accepted, 1);
  assert.equal(accuracy.rates.subject, 1);
  assert.equal(accuracy.projectCount, 1);
  assert.deepEqual(accuracy.targets, { subject: 0.95, textbook: 0.85 });

  // 撤回要把科目与教材一起退回原状（教材为空＝回到待归类），并留下科目去向。
  const reverted = await fetch(`${baseUrl}/api/admin/question-enrichment/questions/${question.id}/revert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestionId: suggestion.id }),
  }).then((response) => response.json());
  assert.equal(reverted.question.subjectId, "modern-chinese");
  assert.equal(reverted.question.bookId, "modern-chinese-7-1");
  assert.equal(reverted.question.chapter, "");
  assert.deepEqual(reverted.question.knowledgePoints, []);
  const revertLog = operationLogStore.list({ category: "question" }).items.find((item) => item.action === "question.enrichment_revert");
  assert.equal(revertLog.metadata.subjectIdTo, "modern-chinese");
});

test("enrichment refuses a subject outside the project candidates", async (context) => {
  const { baseUrl, question, questionStore, questionEnrichmentStore, runJob } = await startEnrichmentFixture(context, {
    catalogs: {
      "modern-chinese-7-1": [{ id: "node-upper-phonetics", level: 1, title: "第一章 语音", startPage: 1, endPage: 40, knowledgePoints: ["声母"] }],
    },
    question: {
      id: "subject-outside-question",
      subjectId: "modern-chinese",
      bookId: "",
      chapter: "",
      knowledgePoints: [],
      type: "single_choice",
      stem: "关于《离骚》的艺术特色，下列说法正确的是？",
      options: [{ key: "A", text: "香草美人" }, { key: "B", text: "平铺直叙" }],
      correctAnswer: ["A"],
      maxScore: 2,
    },
    // 中国古代文学在本项目里没有已确认目录：它不在候选科目里，选它就必须拒收
    // （跨科目的归属变更只能在候选内发生，否则等于把题目挂到一棵不存在的树上）。
    aiReplies: [{
      subjectId: "ancient-literature",
      bookId: "ancient-literature-2-1",
      knowledgePoints: ["离骚"],
      scoringPoints: [],
      confidence: 0.6,
      reason: "《离骚》属中国古代文学。",
    }],
  });

  const job = await runJob(question.id);
  assert.equal(job.status, "failed");
  assert.equal(questionEnrichmentStore.latest(question.id).error, "question_enrichment_subject_invalid");
  assert.equal(questionStore.get(question.id).subjectId, "modern-chinese");
  assert.equal(questionStore.get(question.id).bookId, "");
});

test("enrichment refuses a suggestion that mixes a subject with another subject's book", async (context) => {
  const { baseUrl, question, questionEnrichmentStore, runJob } = await startEnrichmentFixture(context, {
    catalogs: {
      "modern-chinese-7-1": [{ id: "node-upper-phonetics", level: 1, title: "第一章 语音", startPage: 1, endPage: 40, knowledgePoints: ["声母"] }],
      "classical-chinese-1": [{ id: "node-cc-1-script", level: 1, title: "第一单元 文字", startPage: 1, endPage: 30, knowledgePoints: ["古今字"] }],
    },
    question: {
      id: "subject-book-mismatch-question",
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      chapter: "",
      knowledgePoints: [],
      type: "single_choice",
      stem: "下列各组字中，属于古今字关系的是？",
      options: [{ key: "A", text: "莫—暮" }, { key: "B", text: "看—瞧" }],
      correctAnswer: ["A"],
      maxScore: 2,
    },
    // 说古代汉语，却挑了一本现代汉语的册次：两级判断自相矛盾，宁可拒收也不给一条拼起来的建议。
    aiReplies: [{
      subjectId: "classical-chinese",
      bookId: "modern-chinese-7-1",
      catalogNodeId: "node-upper-phonetics",
      knowledgePoints: ["声母"],
      scoringPoints: [],
      confidence: 0.5,
      reason: "科目与教材不一致的坏样本。",
    }],
  });

  const job = await runJob(question.id);
  assert.equal(job.status, "failed");
  assert.equal(questionEnrichmentStore.latest(question.id).error, "question_enrichment_subject_book_mismatch");
  assert.equal(questionEnrichmentStore.latest(question.id).bookId, "");
});

