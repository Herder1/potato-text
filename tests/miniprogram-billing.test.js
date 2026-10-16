const test = require("node:test");
const assert = require("node:assert/strict");

test("mini program synchronizes server bean balance and settles successful AI usage", () => {
  let definition;
  const storage = new Map();
  const requests = [];
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    request(options) {
      requests.push(options);
      if (options.url.includes("/api/billing/account")) {
        options.success({ statusCode: 200, data: { account: { beanBalance: 2, subscriptions: [], transactions: [] } } });
      } else {
        options.success({ statusCode: 200, data: { account: { beanBalance: 1.9, subscriptions: [], transactions: [] } } });
      }
    },
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);

  definition.onLaunch();
  assert.equal(definition.globalData.beans, 2);
  assert.equal(definition.spendBeans(0.1, { referenceId: "ai-call-test", source: "subjective_scoring", description: "主观题评分" }), true);
  assert.equal(definition.globalData.beans, 1.9);
  const consumptionRequest = requests.find((request) => request.url.includes("/api/billing/beans/consume"));
  assert.equal(consumptionRequest.data.amount, 0.1);
  assert.equal(consumptionRequest.data.referenceId, "ai-call-test");
  assert.equal(consumptionRequest.data.description, "主观题评分");
  // 不足 0.1 豆币时不再扣费，也不会发出请求
  const requestCount = requests.length;
  definition.globalData.beans = 0;
  assert.equal(definition.spendBeans(0.1, { referenceId: "ai-call-insufficient" }), false);
  assert.equal(requests.length, requestCount);

  delete global.App;
  delete global.wx;
});

test("mini program migrates the legacy local AI credit cache to beans exactly once", () => {
  let definition;
  const storage = new Map([["shukao_ai_credits", 20]]);
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    request() {},
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);

  definition.onLaunch();
  // 20 点 AI 额度 → 2 豆币，旧键清掉
  assert.equal(definition.globalData.beans, 2);
  assert.equal(storage.get("shukao_beans"), 2);
  assert.equal(storage.has("shukao_ai_credits"), false);

  // 再次启动（模拟热重启）不会二次折算
  definition.globalData.beans = 2;
  definition.onLaunch();
  assert.equal(definition.globalData.beans, 2);

  delete global.App;
  delete global.wx;
});

test("mini program synchronizes imported official questions", () => {
  let definition;
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: () => "",
    setStorageSync() {},
    request(options) {
      options.success({
        statusCode: 200,
        data: {
          questions: [{
            id: "question-imported-live",
            subjectId: "modern-chinese",
            bookId: "modern-chinese-7-1",
            chapter: "第一章 语音",
            knowledgePoints: ["语音概说"],
            type: "single_choice",
            typeLabel: "单选题",
            stem: "后台导入题目",
            options: [{ key: "A", text: "正确" }, { key: "B", text: "错误" }],
            correctAnswer: ["A"],
            referenceAnswer: "正确。",
            maxScore: 2,
          }],
        },
      });
    },
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);

  let synchronized;
  definition.syncOfficialQuestions((questions, metadata) => {
    synchronized = { questions, metadata };
  }, { force: true });
  assert.equal(synchronized.metadata.source, "server");
  assert.equal(synchronized.questions[0].id, "question-imported-live");
  assert.equal(synchronized.questions[0].chapterId, "第一章 语音");
  assert.equal(synchronized.questions[0].score, 2);

  delete global.App;
  delete global.wx;
});

test("mini program synchronizes and caches one requested textbook independently", () => {
  let definition;
  const storage = new Map();
  let requestedUrl = "";
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    request(options) {
      requestedUrl = options.url;
      options.success({
        statusCode: 200,
        data: { questions: [{
          id: "contemporary-live",
          subjectId: "contemporary-literature",
          bookId: "contemporary-literature-history-3",
          chapter: "第三章 矛盾和冲突",
          knowledgePoints: ["对规范的质疑"],
          type: "short_answer",
          stem: "测试题",
          referenceAnswer: "测试答案",
          maxScore: 5,
        }] },
      });
    },
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);

  let synchronized;
  definition.syncOfficialQuestions((questions) => { synchronized = questions; }, {
    force: true,
    bookId: "contemporary-literature-history-3",
  });
  assert.match(requestedUrl, /bookId=contemporary-literature-history-3/);
  assert.equal(synchronized.length, 1);
  assert.equal(storage.get("shukao_official_questions_contemporary-literature-history-3")[0].id, "contemporary-live");

  delete global.App;
  delete global.wx;
});

test("mini program never substitutes demo questions when official sync fails", () => {
  let definition;
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: () => "",
    setStorageSync() {},
    request(options) {
      options.fail({ errMsg: "request:fail domain not configured" });
    },
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);

  let synchronized;
  definition.syncOfficialQuestions((questions, metadata) => {
    synchronized = { questions, metadata };
  }, { force: true });
  assert.deepEqual(synchronized.questions, []);
  assert.equal(synchronized.metadata.source, "unavailable");
  assert.match(synchronized.metadata.error, /domain not configured/);

  delete global.App;
  delete global.wx;
});

test("mini program renders a textbook cache before validating it with an etag", () => {
  let definition;
  let pendingRequest;
  let requestCount = 0;
  const bookId = "modern-literature-30-years-3";
  const cacheKey = `shukao_official_questions_${bookId}`;
  const metadataKey = `${cacheKey}_metadata`;
  const cachedQuestion = {
    id: "modern-literature-cached",
    subjectId: "modern-literature",
    bookId,
    chapter: "第一章",
    knowledgePoints: ["文学革命"],
    type: "short_answer",
    stem: "缓存题目",
    referenceAnswer: "缓存答案",
    maxScore: 5,
  };
  const storage = new Map([
    [cacheKey, [cachedQuestion]],
    [metadataKey, { etag: '"questions-cache"', updatedAt: 1 }],
  ]);
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    request(options) {
      requestCount += 1;
      pendingRequest = options;
    },
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);

  const updates = [];
  definition.syncOfficialQuestions((questions, metadata) => updates.push({ questions, metadata }), {
    force: true,
    bookId,
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].metadata.source, "cache");
  assert.equal(updates[0].questions[0].id, cachedQuestion.id);
  assert.equal(pendingRequest.header["If-None-Match"], '"questions-cache"');

  const parallelUpdates = [];
  definition.syncOfficialQuestions((questions, metadata) => parallelUpdates.push({ questions, metadata }), {
    force: true,
    bookId,
  });
  assert.equal(requestCount, 1);
  assert.equal(parallelUpdates[0].metadata.source, "cache");

  pendingRequest.success({ statusCode: 304, data: null, header: { ETag: '"questions-cache"' } });
  assert.equal(updates.length, 2);
  assert.equal(updates[1].metadata.source, "validated");
  assert.equal(updates[1].metadata.notModified, true);
  assert.equal(parallelUpdates[1].metadata.source, "validated");
  assert.equal(storage.get(cacheKey)[0].id, cachedQuestion.id);
  assert.ok(storage.get(metadataKey).updatedAt > 1);

  delete global.App;
  delete global.wx;
});
