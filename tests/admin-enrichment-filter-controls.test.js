// 「完善题目」筛选行（2026-10-12，产品负责人确认的四处改动）的契约：
//   ① 删除「归类状态」下拉——能力并入「待完善项」的归属组（勾教材/章节/知识点＝原 classification=pending）；
//   ② 「建议状态」七态精简为四态（全部／AI 已推荐／已采纳／生成失败）；
//   ③ 删掉教材下拉里的「未指定教材（待归类）」哨兵项（接口层仍接受 bookId=__unassigned__）；
//   ④ 六个筛选控件统一改成「勾选式下拉」（可多选，不勾＝全部）。
// 前四条里前三条是界面/口径，第四条同时改了请求形态：多选走重复参数，后端按数组 OR 归一化。
// 本文件上半段锁静态契约（HTML/CSS/JS 形态），下半段在真实 HTTP 上锁多选筛选的语义。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");
const { createMemoryTextbookCatalogStore } = require("../apps/api/src/textbook-catalog-store");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

const toolbarSource = () => {
  const html = read("apps/admin/index.html");
  return html.slice(html.indexOf('<div class="question-enrichment-toolbar">'), html.indexOf('<div class="question-enrichment-selection"'));
};

test("筛选行只剩六个勾选式下拉：归类下拉已删除，建议状态只剩四态", () => {
  const toolbar = toolbarSource();
  const app = read("apps/admin/app.js");
  const html = read("apps/admin/index.html");

  // ① 归类下拉整个撤掉：筛选行里不再有它（复核弹窗的 #question-enrichment-classification-dialog 是另一回事）。
  assert.doesNotMatch(toolbar, /question-enrichment-classification/);
  assert.doesNotMatch(toolbar, /全部归类|待归已到期|已归解除/);
  assert.doesNotMatch(app, /#question-enrichment-classification"\)/);

  // ② 四态：全部（不勾）／AI 已推荐／已采纳／生成失败；其余三态不再出现在控件里。
  assert.match(app, /const questionEnrichmentStatusOptions = \["recommended", "applied", "failed"\]/);
  assert.doesNotMatch(toolbar, /尚未生成|已撤回|已拒绝|建议已过期/);

  // ③ 教材下拉不再有哨兵项；但接口层的哨兵值仍然在（题库列表与历史链接在用）。
  assert.doesNotMatch(app, /UNASSIGNED_BOOK_FILTER/);
  assert.doesNotMatch(toolbar, /未指定教材（待归类）/);
  assert.match(read("apps/api/src/question-store.js"), /const UNASSIGNED_BOOK_FILTER = "__unassigned__";/);

  // ④ 六颗控件都是 .filter-select（div），筛选行里再没有 <select>；只有搜索框一个 <input>。
  const ids = [...toolbar.matchAll(/<div class="filter-select" id="([^"]+)" data-label="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, [
    "question-enrichment-subject",
    "question-enrichment-book",
    "question-enrichment-batch",
    "question-enrichment-type",
    "question-enrichment-need",
    "question-enrichment-status",
  ]);
  assert.equal((toolbar.match(/<select\b/g) || []).length, 0);
  assert.equal((toolbar.match(/<input\b/g) || []).length, 1);
  assert.match(toolbar, /data-label="全部待完善项"/);
  assert.match(toolbar, /data-label="全部建议状态"/);

  // 多选筛选的请求形态：重复参数 + 从组件读值（不再有第二份"当前筛选"状态）。
  assert.match(app, /function questionEnrichmentFilters\(\)/);
  assert.match(app, /needs: filterSelectValues\("question-enrichment-need"\)/);
  assert.match(app, /params\.append\(key, value\)/);
});

test("勾选面板的显隐、分组与兜底样式：作者 display 压不过 hidden 的那一类缺陷不复发", () => {
  const app = read("apps/admin/app.js");
  const css = read("apps/admin/styles.css");

  // 面板显隐显式写死 [hidden]，避免 .filter-select-panel 的 display 把 UA 的 [hidden]{display:none} 压掉。
  assert.match(css, /\.filter-select-panel\[hidden\]\s*\{\s*display: none;\s*\}/);
  assert.match(app, /panel\.hidden = false;/);
  assert.match(app, /panel\.hidden = true;/);
  // 工具栏不再是裁剪浮层的横向滚动容器（否则面板会被整块裁掉）。
  const toolbarRule = css.slice(css.indexOf(".question-enrichment-toolbar {"), css.indexOf("}", css.indexOf(".question-enrichment-toolbar {")));
  assert.match(toolbarRule, /flex-wrap: wrap;/);
  assert.doesNotMatch(toolbarRule, /overflow-x/);
  assert.match(css, /\.filter-select\s*\{[^}]*position: relative;[^}]*flex: 0 0 140px;/s);
  assert.match(css, /\.filter-select-option input\[type="checkbox"\]\s*\{[^}]*width: auto;[^}]*min-height: 0;/s);
  // 面板里的复选框不能被工具栏的输入框样式（width:100% / min-height:36px）撑成大块。
  assert.doesNotMatch(css, /\.question-enrichment-toolbar input\s*\{/);
  assert.match(css, /\.question-enrichment-toolbar > input\s*\{[^}]*flex: 1 1 210px;/s);

  // 「缺什么」分三组：归属组就是「待归类」这一派生状态的入口。
  assert.match(app, /\{ label: "归属（缺任一即为待归类）", needs: \["textbook", "chapter", "knowledge_points"\] \}/);
  assert.match(app, /\{ label: "内容", needs: \["scoring_points"\] \}/);
  assert.match(app, /\{ label: "结构", needs: \["knowledge_fingerprint", "family"\] \}/);
  assert.match(app, /onChange: \(\) => onQuestionEnrichmentFilterChange\(\{ cascadeBooks: true \}\)/);
});

test("多选筛选：重复参数按「命中任一」过滤，单值与 all 仍然兼容", async (context) => {
  const questionStore = createMemoryQuestionStore([]);
  const bookOf = { "q-chapter": "modern-chinese-7-1", "q-knowledge": "modern-chinese-7-2", "q-all-missing": "", "q-complete": "modern-chinese-7-1" };
  const create = (id, payload) => questionStore.create({
    id,
    subjectId: "modern-chinese",
    bookId: bookOf[id],
    type: "single_choice",
    stem: `${id} 的题干`,
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
    correctAnswer: ["A"],
    maxScore: 2,
    ...payload,
  }, "测试编辑");
  // 四种待完善形态：只缺章节 / 只缺知识点 / 三级全缺（＝待归类）/ 齐全
  create("q-chapter", { chapter: "", knowledgePoints: ["现代汉语共同语"] });
  create("q-knowledge", { chapter: "第一章 绪论", knowledgePoints: [] });
  create("q-all-missing", { chapter: "", knowledgePoints: [] });
  create("q-complete", { chapter: "第一章 绪论", knowledgePoints: ["现代汉语共同语"] });

  const questionEnrichmentStore = createMemoryQuestionEnrichmentStore();
  questionEnrichmentStore.addSuggestion({ questionId: "q-chapter", questionVersion: 1, chapterNodeId: "n1", catalogPath: "第一章", knowledgePoints: ["x"], confidence: 0.9 });
  questionEnrichmentStore.addSuggestion({ questionId: "q-knowledge", questionVersion: 1, chapterNodeId: "n1", catalogPath: "第一章", knowledgePoints: ["x"], confidence: 0.9, status: "failed" });

  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    questionStore,
    questionEnrichmentStore,
    textbookCatalogStore: createMemoryTextbookCatalogStore(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const listedIds = async (query) => {
    const payload = await fetch(`${baseUrl}/api/admin/question-enrichment?${query}`).then((response) => response.json());
    return payload.items.map((item) => item.question.id).sort();
  };

  // 单值（旧链接、旧调用方）逐项等价
  assert.deepEqual(await listedIds("need=chapter"), ["q-all-missing", "q-chapter"]);
  assert.deepEqual(await listedIds("need=knowledge_points"), ["q-all-missing", "q-knowledge"]);
  // 多值＝命中任一：等价于原「归类状态＝待归类（缺归属）」
  assert.deepEqual(await listedIds("need=chapter&need=knowledge_points&need=textbook"), ["q-all-missing", "q-chapter", "q-knowledge"]);
  assert.deepEqual(await listedIds("classification=pending"), ["q-all-missing", "q-chapter", "q-knowledge"]);
  // 「全部」＝不筛（"all" 与不传参一致）
  assert.deepEqual(await listedIds("need=all"), ["q-all-missing", "q-chapter", "q-complete", "q-knowledge"]);
  // 教材多选：命中任一；旧的哨兵值仍然表示"教材为空"
  assert.deepEqual(await listedIds("bookId=modern-chinese-7-1&bookId=modern-chinese-7-2"), ["q-chapter", "q-complete", "q-knowledge"]);
  assert.deepEqual(await listedIds("bookId=__unassigned__"), ["q-all-missing"]);
  assert.deepEqual(await listedIds("bookId=__unassigned__&bookId=modern-chinese-7-1"), ["q-all-missing", "q-chapter", "q-complete"]);
  // 题型多选、科目多选
  assert.deepEqual(await listedIds("type=single_choice&type=short_answer"), ["q-all-missing", "q-chapter", "q-complete", "q-knowledge"]);
  assert.deepEqual(await listedIds("type=short_answer"), []);
  assert.deepEqual(await listedIds("subjectId=ancient-chinese"), []);
  // 建议状态多选：recommended 仍要求"有可采纳改动"
  assert.deepEqual(await listedIds("suggestionStatus=recommended"), ["q-chapter"]);
  assert.deepEqual(await listedIds("suggestionStatus=recommended&suggestionStatus=failed"), ["q-chapter", "q-knowledge"]);
  assert.deepEqual(await listedIds("suggestionStatus=stale"), []);
});

test("多选筛选同时是生成范围：POST /jobs 用同一套数组筛选挑题", async (context) => {
  // 上游假模型：立刻返回一个不符合建议稿结构的 JSON，任务会很快失败——本用例只看"挑了哪些题"。
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const questionStore = createMemoryQuestionStore([]);
  const create = (id, payload) => questionStore.create({
    id, subjectId: "modern-chinese", bookId: "modern-chinese-7-1", type: "single_choice",
    stem: `${id} 的题干`, options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], correctAnswer: ["A"], maxScore: 2,
    ...payload,
  }, "测试编辑");
  create("q-chapter", { chapter: "", knowledgePoints: ["现代汉语共同语"] });
  create("q-knowledge", { chapter: "第一章 绪论", knowledgePoints: [] });
  create("q-complete", { chapter: "第一章 绪论", knowledgePoints: ["现代汉语共同语"] });

  const provider = {
    id: "filter-upstream", label: "假上游", kind: "openai-compatible",
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "test-key", enabled: true,
  };
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore({
      providers: [provider],
      routes: { question_enrichment: { mode: "provider", providerId: provider.id, model: "enrichment-model", temperature: 0.1, maxTokens: 500 } },
    }),
    questionStore,
    questionEnrichmentStore: createMemoryQuestionEnrichmentStore(),
    textbookCatalogStore: createMemoryTextbookCatalogStore(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const createJob = async (body) => fetch(`${baseUrl}/api/admin/question-enrichment/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());

  const multi = await createJob({ needs: ["chapter", "knowledge_points"], limit: 50 });
  assert.deepEqual([...multi.job.questionIds].sort(), ["q-chapter", "q-knowledge"], "多选＝命中任一，缺任一项的题都要进任务");
  const single = await createJob({ need: "chapter", limit: 50 });
  assert.deepEqual([...single.job.questionIds].sort(), ["q-chapter"], "旧单值形态仍然只挑缺章节的题");
  // 不勾任何一项＝按"待完善"挑（既有口径：只要不是 complete）
  const unfiltered = await createJob({ limit: 50 });
  assert.deepEqual([...unfiltered.job.questionIds].sort(), ["q-chapter", "q-knowledge"]);

  // 等三口干完再收摊：任务体在 setImmediate 里跑，留着它会让测试进程不退出。
  const settle = async (jobId) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = (await fetch(`${baseUrl}/api/admin/question-enrichment/jobs/${jobId}`).then((response) => response.json())).job;
      if (!["queued", "running"].includes(job.status)) return job.status;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return "timeout";
  };
  const statuses = await Promise.all([multi, single, unfiltered].map((payload) => settle(payload.job.id)));
  assert.deepEqual(statuses, ["failed", "failed", "failed"], "假上游给的不是建议稿结构，三口干都该快速失败（本用例只看挑了哪些题）");
});
