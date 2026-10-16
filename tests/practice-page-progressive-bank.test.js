const test = require("node:test");
const assert = require("node:assert/strict");
const { applyDataPatch } = require("./helpers/set-data");
const { demoQuestions, subjects } = require("../apps/miniprogram/data/catalog");

// C17（F5/A 方案，产品负责人 2026-09-24 选定「先 A」）的页面级契约测试。
// A ＝综合训练两段式载入：
//   第一段只等「优先册」（本机实测单册 193–614ms vs 整库 1456ms），先把第一道题画出来；
//   第二段首屏画完后逐册补齐其余册（按册请求：整库那条路径在第一段刷新过 globalData 之后会空转），
//   到齐后把队列接长——当前题按 id 重新定位、作答状态一律不动。
// 这里用合成题库把这条时序钉住；真机首屏耗时/渲染仍需真机验收（本机只能量到请求与队列的时序）。
const CANONICAL_BOOKS = subjects.flatMap((subject) => (Array.isArray(subject.books) ? subject.books : []).map((book) => String(book.id || ""))).filter(Boolean);
const PRIMARY_BOOK_ID = CANONICAL_BOOKS[0];
const SECOND_BOOK_ID = CANONICAL_BOOKS[1];
const MODERN_LITERATURE_BOOK_ID = "modern-literature-30-years-3";

function buildQuestion(id, bookId, subjectId) {
  const source = demoQuestions[Number(String(id).replace(/\D/g, "")) % demoQuestions.length];
  return {
    ...structuredClone(source),
    id,
    bookId,
    subjectId,
    bookTitle: `${bookId} 书名`,
    subjectName: `${subjectId} 科目`,
    referenceAnswer: `参考答案 ${id}`,
  };
}

const primaryBank = Array.from({ length: 3 }, (_, index) => buildQuestion(`p-${index + 1}`, PRIMARY_BOOK_ID, "modern-chinese"));
const secondBank = Array.from({ length: 2 }, (_, index) => buildQuestion(`s-${index + 1}`, SECOND_BOOK_ID, "modern-chinese"));
const literatureBank = Array.from({ length: 2 }, (_, index) => buildQuestion(`l-${index + 1}`, MODERN_LITERATURE_BOOK_ID, "modern-literature"));

function setupPage({ storage = new Map(), options = { mode: "comprehensive" } } = {}) {
  let definition;
  const calls = [];
  const toasts = [];
  const app = {
    globalData: { beans: 2 },
    syncOfficialQuestions(callback, callOptions = {}) {
      calls.push({ callback, options: callOptions, bookId: String(callOptions.bookId || "") });
    },
  };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 44, safeArea: { bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 48, left: 290 }),
    showToast(payload) { toasts.push(payload && payload.title || ""); },
    navigateBack() {},
  };
  const practicePath = require.resolve("../apps/miniprogram/pages/practice/practice.js");
  delete require.cache[practicePath];
  require(practicePath);
  const records = [];
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    records.push({ keys: Object.keys(patch), patch });
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  // 目录侧不在本用例范围内（另有 C16/目录测试覆盖）：桩掉目录请求，只观察题库的两段式时序。
  page.requestBookCatalog = () => {};
  page.onLoad(options);
  return { page, calls, storage, records, toasts };
}

function teardown() {
  delete global.Page;
  delete global.getApp;
  delete global.wx;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingCalls = (calls) => calls.filter((call) => !call.done);
const deliver = (call, questions) => { call.done = true; call.callback(questions, { source: "server" }); };
const queueSetDataCount = (records) => records.filter((record) => record.keys.includes("questionQueue")).length;
// 逐册补齐是"完成一册补发下一册"（并发 2）：把 8 册全部走完，直到不再有新请求发出。
async function drainTail(calls, banksByBook = {}, onRound) {
  let seen = -1;
  while (calls.length !== seen || pendingCalls(calls).length) {
    seen = calls.length;
    if (onRound) onRound(pendingCalls(calls));
    pendingCalls(calls).forEach((call) => deliver(call, banksByBook[call.bookId] || []));
    await sleep(20);
  }
}

test("C17/F5-A：首屏只等优先册；首屏画完后逐册补齐其余册（不再发整库请求）", async () => {
  const { page, calls } = setupPage();
  assert.equal(calls.length, 1, "综合训练首屏只应发一个请求");
  assert.deepEqual(calls[0].options, { force: true, bookId: PRIMARY_BOOK_ID }, "首屏必须先拉科目顺序里的第一册");
  assert.equal(page.data.practiceReady, false, "优先册还没回来就不该建会话");

  deliver(calls[0], primaryBank);
  assert.equal(page.data.practiceReady, true);
  assert.equal(page._questionQueue.length, primaryBank.length, "首屏队列＝优先册的题");
  assert.equal(page.data.question.total, primaryBank.length);

  await sleep(500);
  let maxInflight = 0;
  await drainTail(calls, { [SECOND_BOOK_ID]: secondBank }, (pending) => { maxInflight = Math.max(maxInflight, pending.length); });
  const tailBooks = calls.slice(1).map((call) => call.bookId);
  assert.equal(tailBooks.length, CANONICAL_BOOKS.length - 1, "其余 8 册应逐册补齐（9 册 − 首屏 1 册）");
  assert.deepEqual([...tailBooks].sort(), CANONICAL_BOOKS.filter((bookId) => bookId !== PRIMARY_BOOK_ID).sort(), "补齐的册＝科目顺序里的其余册");
  assert.ok(calls.slice(1).every((call) => call.options.force === true), "补齐必须 force，否则会命中内存缓存空转");
  assert.ok(calls.slice(1).every((call) => call.bookId), "补齐一律按册请求，不能退化成不带 bookId 的整库请求");
  assert.ok(maxInflight <= 2, `并发补册不应超过 2 路，实际 ${maxInflight}`);
  assert.ok(maxInflight >= 2, "至少要保持 2 路并发，否则串行 8 册太慢");

  await sleep(400);
  assert.equal(page._questionQueue.length, primaryBank.length + secondBank.length, "只有真正带回题的册会接长队列");
  assert.equal(page.data.question.id, primaryBank[0].id, "当前题不能被打断");
  assert.equal(page.data.question.total, primaryBank.length + secondBank.length, "题号总数要跟着新队列重算");
  teardown();
});

test("C17/F5-A：多册同时回来只重建一次（防抖），已接长的队列不再重复 setData", async () => {
  const { page, calls, records } = setupPage();
  deliver(calls[0], primaryBank);
  await sleep(500);
  // 让 8 册的请求都发出来（先回空题池释放并发额度），再统一投递两册的题（模拟同时到达）。
  while (calls.length < CANONICAL_BOOKS.length) {
    pendingCalls(calls).forEach((call) => deliver(call, []));
    await sleep(20);
  }
  const tail = calls.slice(1);
  assert.equal(tail.length, CANONICAL_BOOKS.length - 1);
  records.length = 0;
  tail.filter((call) => call.bookId === SECOND_BOOK_ID)[0].callback(secondBank, { source: "server" });
  tail.filter((call) => call.bookId === MODERN_LITERATURE_BOOK_ID)[0].callback(literatureBank, { source: "server" });
  await sleep(400);
  assert.equal(queueSetDataCount(records), 1, "同一窗口内的多册只应触发一次队列 setData");
  const expected = primaryBank.length + secondBank.length + literatureBank.length;
  assert.equal(page._questionQueue.length, expected);
  assert.equal(page.data.question.total, expected, "题号总数要跟着新队列重算");
  assert.equal(page.data.answerCardItems.length, expected, "答题卡只会变多");

  // 同一批再回一次（缓存回调 + 服务端回调会各回一次）：没有新题就不该再 setData。
  records.length = 0;
  tail.forEach((call) => call.callback([], { source: "cache" }));
  await sleep(400);
  assert.equal(records.length, 0, "幂等：没有新题就不该再 setData");
  assert.equal(page._questionQueue.length, expected);
  teardown();
});

test("C17/F5-A：补齐只动队列/答题卡/选项，不动作答状态", async () => {
  const { page, calls } = setupPage();
  deliver(calls[0], primaryBank);
  await sleep(500);
  page.data.selected = "A";
  page.data.selectedMap = { A: true };
  page.data.submitted = false;
  const responsesBefore = structuredClone(page.data.responses);
  const selectedBefore = page.data.selected;

  const tail = pendingCalls(calls);
  await drainTail(calls, { [SECOND_BOOK_ID]: secondBank });
  assert.ok(tail.length >= 1);
  await sleep(400);
  assert.equal(page.data.selected, selectedBefore, "补齐不能清掉用户已选的选项");
  assert.equal(page.data.submitted, false);
  assert.deepEqual(page.data.responses, responsesBefore, "补齐不能重算作答状态");
  assert.equal(page.data.currentQuestionIndex, 0, "当前题序号不该漂移");
  teardown();
});

test("C17/F5-A：优先册＝最近练过的那一册；被当前范围排除的册不当优先册", () => {
  const storage = new Map();
  storage.set("shukao_book_practice_progress", { [SECOND_BOOK_ID]: { questionId: "s-1", updatedAt: Date.now() } });
  const recent = setupPage({ storage });
  assert.equal(recent.calls[0].bookId, SECOND_BOOK_ID, "最近练过的那一册应先拉");
  teardown();

  const scopedStorage = new Map();
  scopedStorage.set("shukao_book_practice_progress", { [SECOND_BOOK_ID]: { questionId: "s-1", updatedAt: Date.now() } });
  scopedStorage.set("shukao_training_preferences", { selectedScopeBookIds: [MODERN_LITERATURE_BOOK_ID] });
  const scoped = setupPage({ storage: scopedStorage });
  assert.equal(scoped.calls[0].bookId, MODERN_LITERATURE_BOOK_ID, "优先册必须在当前综合范围允许的册里挑，否则首屏会空题池");
  teardown();
});

test("C17/F5-A：优先册拿不到题时退回整库，不让用户看到空态（退回后不再逐册补齐）", async () => {
  const empty = setupPage();
  empty.calls[0].callback([], { source: "unavailable" });
  assert.equal(empty.calls.length, 2, "优先册为空应立即退回整库");
  assert.deepEqual(empty.calls[1].options, { force: true }, "退回整库＝不带 bookId");
  empty.calls[1].callback([...primaryBank, ...secondBank], { source: "server" });
  assert.equal(empty.page.data.practiceReady, true);
  assert.equal(empty.page._questionQueue.length, primaryBank.length + secondBank.length);
  await sleep(500);
  assert.equal(empty.calls.length, 2, "退回整库后不该再逐册补拉");
  teardown();

  // 优先册有题、但被当前综合范围整册筛掉：同样退回整库。
  const storage = new Map();
  storage.set("shukao_training_preferences", { selectedScopeSubjectIds: ["modern-literature"] });
  const filtered = setupPage({ storage });
  filtered.calls[0].callback(primaryBank, { source: "server" });
  assert.equal(filtered.calls.length, 2, "优先册被范围筛空时必须退回整库");
  filtered.calls[1].callback([...primaryBank, ...literatureBank], { source: "server" });
  assert.equal(filtered.page._questionQueue.length, literatureBank.length, "退回整库后仍按范围筛出这一科的题");
  teardown();
});

test("C17/F5-A：范围只允许一科时，只补该科的其余册", async () => {
  const storage = new Map();
  storage.set("shukao_training_preferences", { selectedScopeSubjectIds: ["modern-chinese"] });
  const { page, calls } = setupPage({ storage });
  assert.equal(calls[0].bookId, PRIMARY_BOOK_ID, "优先册落在这一科里");
  deliver(calls[0], primaryBank);
  await sleep(500);
  assert.deepEqual(pendingCalls(calls).map((call) => call.bookId), [SECOND_BOOK_ID], "现代汉语只有两册：只补没拉的那一册");
  teardown();
});

test("C17/F5-A：跨册材料题补齐后并成一组，当前题按 id 重定位（不是沿用旧序号）", async () => {
  // 真实数据里就有这种组：material:…:g48 的 4 个成员跨现代汉语上/下册（上册 327 题、下册 16 题）。
  // 首屏只有上册时，序 1 还没到；下册到齐后这一组并到一起，排在它后面的题整体前移。
  const groupId = "material:question-import-cross:g48";
  const member = (id, bookId, order) => ({
    ...buildQuestion(id, bookId, "modern-chinese"),
    questionGroupId: groupId,
    groupOrder: order,
    subNumber: String(order),
  });
  const upBook = [
    member("p-1", PRIMARY_BOOK_ID, 2),
    member("p-2", PRIMARY_BOOK_ID, 3),
    member("p-3", PRIMARY_BOOK_ID, 4),
    buildQuestion("p-4", PRIMARY_BOOK_ID, "modern-chinese"),
    buildQuestion("p-5", PRIMARY_BOOK_ID, "modern-chinese"),
  ];
  const downBook = [member("down-1", SECOND_BOOK_ID, 1)];

  const { page, calls } = setupPage();
  deliver(calls[0], upBook);
  await sleep(500);
  page.loadQuestion(3); // 用户翻到 p-4（排在材料组后面那道）
  assert.equal(page.data.question.id, "p-4");
  assert.equal(page.data.currentQuestionIndex, 3);

  const downCall = pendingCalls(calls).filter((call) => call.bookId === SECOND_BOOK_ID)[0];
  deliver(downCall, downBook);
  await sleep(400);
  const ids = page._questionQueue.map((item) => item.id);
  assert.deepEqual(ids.slice(0, 4), ["down-1", "p-1", "p-2", "p-3"], "跨册材料题的成员要并成连续一组，序 1 必须排在前面");
  assert.equal(page.data.question.id, "p-4", "当前题不能因为前移被换掉");
  assert.equal(page.data.currentQuestionIndex, 4, "序号要按 id 重定位，否则下一题会跳错");
  assert.equal(page._questionQueue[page.data.currentQuestionIndex].id, "p-4");
  teardown();
});

test("C17/F5-A：补齐期间选了「还没到」的范围 → 提示正在载入，到齐后自动应用", async () => {
  const { page, calls, toasts } = setupPage();
  deliver(calls[0], primaryBank);
  await sleep(500);
  // 用户在范围面板里只勾了第二册（这一册还没补齐）。
  page.data.selectedScopeSubjectIds = [];
  page.data.selectedScopeBookIds = [SECOND_BOOK_ID];
  page.applyComprehensiveScope();
  assert.ok(toasts.includes("正在载入该范围，请稍候"), `应提示正在载入，实际提示 ${JSON.stringify(toasts)}`);
  assert.equal(page._pendingComprehensiveScope, true);
  assert.ok(!toasts.includes("当前组合暂无题目"), "不能误报暂无题目");

  const secondCall = pendingCalls(calls).filter((call) => call.bookId === SECOND_BOOK_ID)[0];
  deliver(secondCall, secondBank);
  await sleep(400);
  assert.equal(page._pendingComprehensiveScope, false, "到齐后应把范围真正应用上");
  assert.deepEqual(page._questionQueue.map((item) => item.id), secondBank.map((item) => item.id), "应用后的题池＝该范围的题");
  assert.equal(page.data.question.total, secondBank.length);
  teardown();
});

test("C17/F5-A：非综合模式（普通/单册综合/限量）保持原来的一次整库同步", async () => {
  const normal = setupPage({ options: { mode: "normal" } });
  assert.equal(normal.calls.length, 1);
  assert.deepEqual(normal.calls[0].options, { force: true, bookId: "" }, "普通练习仍是一次整库");
  await sleep(500);
  assert.equal(normal.calls.length, 1, "普通模式不该有后台补齐");
  teardown();

  const singleBook = setupPage({ options: { mode: "comprehensive", bookId: SECOND_BOOK_ID } });
  assert.equal(singleBook.calls.length, 1);
  assert.deepEqual(singleBook.calls[0].options, { force: true, bookId: SECOND_BOOK_ID }, "指定单册的综合训练照旧只拉这一册");
  await sleep(500);
  assert.equal(singleBook.calls.length, 1);
  teardown();

  const limited = setupPage({ options: { mode: "comprehensive", count: "20" } });
  assert.equal(limited.calls.length, 1);
  assert.deepEqual(limited.calls[0].options, { force: true, bookId: "" }, "限量会话不拆两段（题量口径会变）");
  await sleep(500);
  assert.equal(limited.calls.length, 1);
  teardown();
});
