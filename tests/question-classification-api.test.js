// 「题目录入改造」接口层验收：只确定科目的题目能录入 / 导入 / 后补归属，
// 且待归类题不会泄漏给用户端。口径见产品手册 §3.5 / §4.6 / §4.10。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");

function baseQuestion(overrides = {}) {
  return {
    subjectId: "modern-chinese",
    type: "single_choice",
    stem: "普通话以什么语音为标准音？",
    options: [
      { key: "A", text: "北京语音" },
      { key: "B", text: "北方语音" },
    ],
    correctAnswer: ["A"],
    referenceAnswer: "普通话以北京语音为标准音。",
    maxScore: 2,
    sourceLabel: "接口回归用例",
    ...overrides,
  };
}

async function withServer(run) {
  // aiConfigStore 一旦给内存实现，服务端其余默认存储也全部走内存：
  // 这个用例绝不能写进 .runtime（正式题库数据）——回归测试只碰内存夹具。
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (response) => response.json();

test("admin API accepts a subject-only question and reports it as 待归类", async () => {
  await withServer(async (origin) => {
    const created = await fetch(`${origin}/api/admin/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseQuestion()),
    });
    const payload = await created.json();
    assert.equal(created.status, 201);
    assert.equal(payload.question.subjectId, "modern-chinese");
    assert.equal(payload.question.bookId, "");
    assert.equal(payload.question.chapter, "");
    assert.deepEqual(payload.question.knowledgePoints, []);
    // 分类缺失 → 待归类 → 不自动审核通过、不自动发布。
    assert.equal(payload.question.status, "pending_review");
    assert.deepEqual(payload.question.classification.missing, ["book", "chapter", "knowledge_points"]);

    const reread = await fetch(`${origin}/api/admin/questions/${payload.question.id}`).then(json);
    assert.equal(reread.question.id, payload.question.id);
    assert.equal(reread.question.status, "pending_review");

    // 平台题目管理里可按「待归类」筛选到它。
    const pendingList = await fetch(`${origin}/api/admin/questions?classification=pending&query=${encodeURIComponent("普通话以什么语音")}`).then(json);
    assert.equal(pendingList.questions.some((question) => question.id === payload.question.id), true);
    assert.equal(pendingList.questions.find((question) => question.id === payload.question.id).classification.needsClassification, true);
    const assignedList = await fetch(`${origin}/api/admin/questions?classification=assigned&query=${encodeURIComponent("普通话以什么语音")}`).then(json);
    assert.equal(assignedList.questions.some((question) => question.id === payload.question.id), false);
  });
});

test("admin API rejects a missing subject and a fabricated textbook", async () => {
  await withServer(async (origin) => {
    const missingSubject = await fetch(`${origin}/api/admin/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseQuestion({ subjectId: "" })),
    });
    assert.equal(missingSubject.status, 422);
    assert.equal((await missingSubject.json()).error, "question_subject_required");

    const fabricatedBook = await fetch(`${origin}/api/admin/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseQuestion({ bookId: "编造的教材" })),
    });
    assert.equal(fabricatedBook.status, 422);
    assert.equal((await fabricatedBook.json()).error, "question_book_invalid");

    const crossSubjectBook = await fetch(`${origin}/api/admin/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseQuestion({ bookId: "contemporary-literature-history-3" })),
    });
    assert.equal(crossSubjectBook.status, 422);
    assert.equal((await crossSubjectBook.json()).error, "question_book_invalid");

    const chapterWithoutBook = await fetch(`${origin}/api/admin/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseQuestion({ chapter: "绪论" })),
    });
    assert.equal(chapterWithoutBook.status, 422);
    assert.equal((await chapterWithoutBook.json()).error, "question_classification_requires_book");
  });
});

test("import preview separates 待归类 rows from structurally broken rows", async () => {
  await withServer(async (origin) => {
    const text = [
      "[单选题] 只有科目时能否导入？",
      "A. 能",
      "B. 不能",
      "答案：A",
      "参考答案：能。",
      "分值：2",
      "---",
      "[单选题] 缺少正确答案的题目",
      "A. 甲",
      "B. 乙",
      "参考答案：缺少答案。",
      "分值：2",
    ].join("\n");

    const preview = await fetch(`${origin}/api/admin/questions/import-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, defaults: { subjectId: "modern-chinese" }, dryRun: true }),
    }).then(json);
    assert.equal(preview.validCount, 1);
    assert.equal(preview.errorCount, 1);
    assert.equal(preview.pendingClassificationCount, 1);
    const valid = preview.items.find((item) => item.valid);
    assert.equal(valid.needsClassification, true);
    assert.deepEqual(valid.classification.missing, ["book", "chapter", "knowledge_points"]);
    assert.deepEqual(valid.classification.missingLabels, ["教材", "章节", "知识点"]);
    const broken = preview.items.find((item) => !item.valid);
    assert.equal(broken.error, "question_choice_answer_invalid");

    // 待归类不影响导入：结构正确的行照常落库。
    const committed = await fetch(`${origin}/api/admin/questions/import-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, defaults: { subjectId: "modern-chinese" }, dryRun: false }),
    }).then(json);
    assert.equal(committed.createdCount, 1);
    assert.equal(committed.pendingClassificationCount, 1);
    assert.deepEqual(committed.pendingClassification[0].missing, ["book", "chapter", "knowledge_points"]);
    const questionId = committed.pendingClassification[0].questionId;

    // 后补归属：更新原题本身，不新建题，来源与版本链保留。
    const before = await fetch(`${origin}/api/admin/questions/${questionId}`).then(json);
    const patched = await fetch(`${origin}/api/admin/questions/import-batches/${encodeURIComponent(committed.batchId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId: "modern-chinese", bookId: "modern-chinese-7-1", chapter: "绪论", knowledgePoints: ["现代汉语共同语"] }),
    }).then(json);
    assert.equal(patched.updatedCount, 1);
    assert.equal(patched.pendingClassificationCount, 0);
    const after = await fetch(`${origin}/api/admin/questions/${questionId}`).then(json);
    assert.equal(after.question.id, before.question.id);
    assert.equal(after.question.bookId, "modern-chinese-7-1");
    assert.equal(after.question.sourceLabel, before.question.sourceLabel);
    assert.equal(after.question.version, before.question.version + 1);
    assert.equal(after.question.status, "official");
  });
});

test("导入题目文本的「默认书籍」允许留空：整批待归类，不伪造教材、可再筛出来补归属", async () => {
  await withServer(async (origin) => {
    const text = [
      "[单选题] 导入面板留空默认书籍时能否入库？",
      "A. 能，标记为待归类",
      "B. 不能",
      "答案：A",
      "参考答案：能。",
      "分值：2",
    ].join("\n");

    // 默认书籍留空：不套用任何教材，整批标记为待归类。
    const preview = await fetch(`${origin}/api/admin/questions/import-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, defaults: { subjectId: "modern-chinese", bookId: "", chapter: "" }, dryRun: true }),
    }).then(json);
    assert.equal(preview.validCount, 1);
    assert.equal(preview.errorCount, 0);
    assert.equal(preview.pendingClassificationCount, 1);
    assert.deepEqual(preview.items[0].classification.missing, ["book", "chapter", "knowledge_points"]);

    const committed = await fetch(`${origin}/api/admin/questions/import-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, defaults: { subjectId: "modern-chinese", bookId: "", chapter: "" }, dryRun: false }),
    }).then(json);
    assert.equal(committed.createdCount, 1);
    const questionId = committed.createdIds[0];
    const question = await fetch(`${origin}/api/admin/questions/${questionId}`).then(json);
    // 关键：没有替操作者"挑一本默认教材"——教材/章节/知识点就是空的。
    assert.equal(question.question.bookId, "");
    assert.equal(question.question.chapter, "");
    assert.deepEqual(question.question.knowledgePoints, []);
    assert.equal(question.question.status, "pending_review");

    // 导入后按「未指定教材（待归类）」+「待归类」能再筛出来补归属。
    const unassigned = await fetch(`${origin}/api/admin/question-enrichment?bookId=__unassigned__&classification=pending`).then(json);
    assert.equal(unassigned.items.some((item) => item.question.id === questionId), true);
    assert.equal(unassigned.summary.pendingClassification >= 1, true);
    const byRealBook = await fetch(`${origin}/api/admin/question-enrichment?bookId=modern-chinese-7-1`).then(json);
    assert.equal(byRealBook.items.some((item) => item.question.id === questionId), false);

    // 默认章节不能单独存在：没有教材时给默认章节＝结构错误，且原因明确指出要补教材。
    const chapterWithoutBook = await fetch(`${origin}/api/admin/questions/import-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, defaults: { subjectId: "modern-chinese", bookId: "", chapter: "绪论" }, dryRun: true }),
    }).then(json);
    assert.equal(chapterWithoutBook.validCount, 0);
    assert.equal(chapterWithoutBook.errorCount, 1);
    assert.equal(chapterWithoutBook.items[0].error, "question_classification_requires_book");
  });
});

test("导入面板与完善题目的教材控件都允许「不指定教材」，并可单独筛选待归类", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "app.js"), "utf8");

  // 默认书籍/默认章节都写明"可暂缺"，且默认书籍不是 required
  assert.match(html, /默认书籍（可暂缺）<\/span><select id="import-book">/);
  assert.match(html, /默认章节（可暂缺）<\/span><input id="import-chapter"/);
  assert.doesNotMatch(html, /默认书籍[^<]*<select id="import-book" required>/);
  // 下拉首项是「暂不指定教材」，且默认不预选任何真教材
  assert.match(app, /'<option value="">（暂不指定教材 · 待归类）<\/option>'/);
  assert.match(app, /select\.value = books\.some\(\(book\) => book\.id === selectedBookId\) \? selectedBookId : ""/);
  // 未指定教材时默认章节禁用（不静默丢弃，让操作者看得见）
  assert.match(app, /chapter\.disabled = !select\.value/);
  // 换默认书籍要清掉旧教材的默认章节
  assert.match(app, /questionImportBookId && select\.value !== questionImportBookId/);
  assert.match(app, /#import-book"\)\.addEventListener\("change"/);
  // 完善题目的教材筛选 2026-10-12 删掉了「未指定教材（待归类）」哨兵项：
  // 「缺什么 → 归属 → 待定教材」筛的是同一批题；接口层的 bookId=__unassigned__ 仍然接受（见本用例上文）。
  assert.doesNotMatch(app, /UNASSIGNED_BOOK_FILTER/);
  assert.match(app, /\{ label: "归属（缺任一即为待归类）", needs: \["textbook", "chapter", "knowledge_points"\] \}/);
});

// 「待归类」筛选的落位是产品负责人 2026-09-21 选定的（选项 A）：放进「题库管理 → 完善题目」
// 筛选行，与「导入批次」并列——因为含批次/状态筛选的 #question-list-panel 工具栏在官方题库下
// 恒定 display:none（变更日志 2026-09-21 01:48 已实测更正），而完善题目是官方题库下真正可达、
// 且能按导入批次看到全部平台题目的列表。这条契约防止有人把它挪回不可达的工具栏。
// 2026-10-12：产品负责人把这颗独立的「归类状态」下拉撤了，能力并入同行的「待完善项」——
// 「勾选 归属（教材/章节/知识点）」＝原 classification=pending（二者判定同源，见
// question-classification-state.js）。落位约束不变：必须在完善题目筛选行里，与导入批次同排。
test("「缺归属」筛选位于「完善题目」筛选行，不在题库管理下恒隐藏的题目列表工具栏", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "app.js"), "utf8");
  const toolbar = html.slice(html.indexOf('<div class="question-enrichment-toolbar">'), html.indexOf('<div class="question-enrichment-selection"'));

  // 控件本体在完善题目筛选行里，且与导入批次同排相邻；原归类下拉已不在筛选行里。
  assert.match(toolbar, /id="question-enrichment-batch"[\s\S]{0,300}?id="question-enrichment-type"/);
  assert.doesNotMatch(toolbar, /question-enrichment-classification/);
  assert.match(toolbar, /id="question-enrichment-need" data-label="全部待完善项"/);
  assert.doesNotMatch(html, /id="question-classification-filter"/);
  // 请求要带上所勾选项（多选＝重复参数），取值只从勾选控件读
  assert.match(app, /needs: filterSelectValues\("question-enrichment-need"\)/);
  assert.match(app, /\["need", filters\.needs\]/);
  assert.match(app, /分类缺失|归属（缺任一即为待归类）/);
  // 列表工具栏那次筛选已经撤掉（不留双入口）
  assert.doesNotMatch(app, /#question-classification-filter/);
  // 六项状态逐项标出缺失，替代重复的整题“待归类 · 缺”标签。
  assert.match(app, /QuestionReviewModel\.fields\(item, questionBookName\)/);
  assert.match(app, /missing: "缺失"/);
  assert.match(app, /未指定教材（待归类）/);
});

test("待归类 questions never reach the user-facing question list or scoring", async () => {
  await withServer(async (origin) => {
    const created = await fetch(`${origin}/api/admin/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseQuestion({ stem: "待归类题不应泄漏给用户端" })),
    }).then(json);
    const questionId = created.question.id;
    assert.equal(created.question.status, "pending_review");

    // 用户端题目列表（官方库）不包含它。
    const userList = await fetch(`${origin}/api/questions?library=official`).then(json);
    assert.equal(userList.questions.some((question) => question.id === questionId), false);
    // 即使显式按科目问，也不给。
    const bySubject = await fetch(`${origin}/api/questions?library=official&subjectId=modern-chinese`).then(json);
    assert.equal(bySubject.questions.some((question) => question.id === questionId), false);

    // 主观题评分接口不得替未发布题提供参考答案（也不能因未发布而扣费）。
    const scoring = await fetch(`${origin}/api/ai/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, answer: "随便答一句" }),
    });
    assert.equal(scoring.status >= 400, true);

    // 管理员把它补完归属后，用户端才看得到。
    await fetch(`${origin}/api/admin/questions/${questionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: "modern-chinese-7-1", chapter: "绪论", knowledgePoints: ["现代汉语共同语"] }),
    }).then(json);
    const afterPublish = await fetch(`${origin}/api/admin/questions/${questionId}`).then(json);
    assert.equal(afterPublish.question.status, "official");
    const userListAfter = await fetch(`${origin}/api/questions?library=official&bookId=modern-chinese-7-1`).then(json);
    assert.equal(userListAfter.questions.some((question) => question.id === questionId), true);
  });
});
