const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function createPage(definition) {
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

test("learning diagnosis reports persist by subject and successful regeneration overwrites only that subject", () => {
  let definition;
  let requestMode = "success";
  let requestTimeout = 0;
  let toastTitle = "";
  const storage = new Map([
    ["shukao_learning_diagnosis_reports", {
      "chinese-comprehensive": { text: "已保存的综合诊断", generatedAt: 1, requestId: "old-all" },
      "modern-chinese": { text: "已保存的现代汉语诊断", generatedAt: 2, requestId: "old-modern" },
    }],
  ]);
  const app = {
    globalData: { aiCredits: 5, apiBaseUrl: "https://example.test", officialQuestions: [] },
    spendAiCredit: () => true,
  };
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    showToast: ({ title }) => { toastTitle = title; },
    request: ({ success, fail, timeout }) => {
      requestTimeout = timeout;
      if (requestMode === "fail") fail(new Error("offline"));
      else success({
        statusCode: 200,
        data: { success: true, result: { requestId: "new-modern", text: "重新生成的现代汉语诊断" } },
      });
    },
  };

  const modulePath = require.resolve("../apps/miniprogram/pages/analysis/analysis.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = createPage(definition);
  page.refreshAnalysis = () => {};
  page.onLoad({ subjectId: "chinese-comprehensive" });
  assert.equal(page.data.aiAdvice, "已保存的综合诊断");

  page.selectSubject({ currentTarget: { dataset: { id: "modern-chinese" } } });
  assert.equal(page.data.aiAdvice, "已保存的现代汉语诊断");
  page.setData({
    analysis: {
      subjectName: "现代汉语",
      dimensions: [],
      weakUnits: [],
      missingPoints: [],
      errorAttributions: [],
    },
  });
  page.requestAiAdvice();
  assert.equal(requestTimeout, 60 * 1000);
  assert.equal(page.data.aiAdvice, "重新生成的现代汉语诊断");
  assert.equal(storage.get("shukao_learning_diagnosis_reports")["modern-chinese"].text, "重新生成的现代汉语诊断");
  assert.equal(storage.get("shukao_learning_diagnosis_reports")["chinese-comprehensive"].text, "已保存的综合诊断");

  requestMode = "fail";
  page.requestAiAdvice();
  assert.equal(page.data.aiAdvice, "重新生成的现代汉语诊断");
  assert.equal(storage.get("shukao_learning_diagnosis_reports")["modern-chinese"].text, "重新生成的现代汉语诊断");
  assert.equal(toastTitle, "生成失败，未扣额度");

  const reopenedPage = createPage(definition);
  reopenedPage.onLoad({ subjectId: "modern-chinese" });
  assert.equal(reopenedPage.data.aiAdvice, "重新生成的现代汉语诊断");

  delete require.cache[modulePath];
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("learning diagnosis actions omit the credit suffix", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/analysis/analysis.wxml"), "utf8");
  assert.match(markup, /aiAdvice \? '重新生成' : 'AI 建议'/);
  assert.doesNotMatch(markup, /1 点/);
});

test("learning diagnosis switches subject from the radar card heading", () => {
  const root = path.join(__dirname, "../apps/miniprogram/pages/analysis");
  const markup = fs.readFileSync(path.join(root, "analysis.wxml"), "utf8");
  const config = JSON.parse(fs.readFileSync(path.join(root, "analysis.json"), "utf8"));
  assert.equal(config.navigationBarTitleText, "学情分析");
  assert.equal(config.navigationStyle, undefined);
  assert.doesNotMatch(markup, /class="page-title">学情分析<\/view>/);
  assert.match(markup, /class="section-subject-trigger[\s\S]*bindtap="toggleSubjectMenu"[\s\S]*\{\{analysis\.subjectName\}\}/);
  assert.match(markup, /class="section-subject-menu"[\s\S]*bindtap="selectSubject"/);
  assert.doesNotMatch(markup, /class="analysis-nav"|class="analysis-scope"|class="scope-selector/);
});

test("learning analysis merges ability and trend charts under one subject-aware overview", () => {
  let definition;
  global.Page = (value) => { definition = value; };
  global.wx = { getStorageSync: () => "" };
  const modulePath = require.resolve("../apps/miniprogram/pages/analysis/analysis.js");
  delete require.cache[modulePath];
  require(modulePath);

  const root = path.join(__dirname, "../apps/miniprogram/pages/analysis");
  const markup = fs.readFileSync(path.join(root, "analysis.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "analysis.wxss"), "utf8");
  assert.match(markup, /class="section-subject-trigger[\s\S]*class="overview-tabs"[\s\S]*data-overview="ability"[\s\S]*data-overview="trend"/);
  assert.match(markup, /class="trend-switch"[\s\S]*data-metric="accuracy"[\s\S]*data-metric="attempts"/);
  assert.match(
    markup,
    /wx:for="\{\{trendPeriodOptions\}\}"[\s\S]{0,260}data-days="\{\{item\}\}"[\s\S]{0,120}bindtap="selectTrendPeriod"/,
    "the trend panel offers a period switch",
  );
  assert.match(markup, /aria-label="切换趋势周期"/);
  assert.match(markup, /data-days="\{\{item\}\}"[\s\S]{0,200}bindtap="selectTrendPeriod"/);
  assert.match(markup, /\{\{item\}\}天<\/view>/);
  assert.doesNotMatch(markup, /<text>最近14天<\/text>/, "the固定 14 day label is replaced by the period switch");
  assert.match(markup, /<canvas[^>]*type="2d"[^>]*id="learningTrend"/);
  assert.match(markup, /class="overview-content" style="height: \{\{462 \+ analysis\.dimensions\.length \* 50\}\}rpx;"[\s\S]*activeOverviewTab === 'ability'[\s\S]*wx:else class="trend-panel"/);
  assert.doesNotMatch(markup, /class="trend-current"/);
  assert.match(markup, /class="trend-comparison-row"/);
  assert.doesNotMatch(markup, /class="trend-section"/);
  assert.match(markup, /class="analysis-tabs"[\s\S]*data-tab="diagnosis"[\s\S]*data-tab="missing"[\s\S]*data-tab="weak"[\s\S]*data-tab="attribution"/);
  assert.match(styles, /\.overview-tabs \{[^}]*grid-template-columns:\s*repeat\(2,/);
  assert.match(styles, /\.trend-panel \{[^}]*display:\s*flex[^}]*height:\s*100%[^}]*flex-direction:\s*column/);
  assert.match(styles, /\.learning-trend \{[^}]*min-height:\s*0[^}]*flex:\s*1/);
  assert.match(styles, /\.trend-empty \{[^}]*min-height:\s*0[^}]*flex:\s*1/);
  assert.match(styles, /\.analysis-tabs \{[^}]*grid-template-columns:\s*repeat\(4,/);
  assert.match(styles, /\.ai-diagnosis \{[^}]*background:\s*transparent/);
  assert.doesNotMatch(styles, /\.ai-diagnosis \{[^}]*background:\s*#303330/);
  assert.doesNotMatch(styles, /\.ai-diagnosis \{[^}]*color:\s*#fff/);
  assert.match(styles, /\.ai-generated \{[^}]*background:\s*transparent[^}]*border-top:/);
  assert.doesNotMatch(styles, /\.ai-generated \{[^}]*border-radius:/);
  assert.match(styles, /\.ai-diagnosis button:last-child \{[^}]*background:\s*transparent/);
  assert.doesNotMatch(styles, /\.ai-diagnosis button:last-child \{[^}]*background:\s*#4b504c/);

  const page = createPage(definition);
  page.setData({ analysis: { trend: { days: [], currentAttemptCount: 0, previousAttemptCount: 0 } } });
  page.selectOverviewTab({ currentTarget: { dataset: { overview: "trend" } } });
  assert.equal(page.data.activeOverviewTab, "trend");
  page.selectAnalysisTab({ currentTarget: { dataset: { tab: "missing" } } });
  assert.equal(page.data.activeAnalysisTab, "missing");
  page.selectTrendMetric({ currentTarget: { dataset: { metric: "attempts" } } });
  assert.equal(page.data.activeTrendMetric, "attempts");

  assert.deepEqual(page.data.trendPeriodOptions, [7, 14, 30]);
  assert.equal(page.data.trendPeriodDays, 14, "the trend defaults to the 14 day window");
  let refreshed = 0;
  page.refreshAnalysis = () => { refreshed += 1; };
  page.selectTrendPeriod({ currentTarget: { dataset: { days: 30 } } });
  assert.equal(page.data.trendPeriodDays, 30);
  assert.equal(refreshed, 1, "switching the period rebuilds the analysis");
  page.selectTrendPeriod({ currentTarget: { dataset: { days: 30 } } });
  assert.equal(refreshed, 1, "re-selecting the current period does nothing");
  page.selectTrendPeriod({ currentTarget: { dataset: { days: 99 } } });
  assert.equal(page.data.trendPeriodDays, 30, "unsupported periods are ignored");
  page.selectTrendPeriod({ currentTarget: { dataset: { days: 7 } } });
  assert.equal(page.data.trendPeriodDays, 7);
  assert.equal(refreshed, 2);

  if (page._overviewDrawTimer) clearTimeout(page._overviewDrawTimer);

  delete require.cache[modulePath];
  delete global.Page;
  delete global.wx;
});

test("learning trend canvas scales for device pixels and keeps one evenly spaced date row", () => {
  let definition;
  const textCalls = [];
  const arcCalls = [];
  const scales = [];
  const context = {
    scale: (...args) => scales.push(args),
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    measureText: (value) => ({ width: String(value).length * 6 }),
    fillText: (value, x, y) => textCalls.push({ value, x, y }),
    arc: (x, y) => arcCalls.push({ x, y }),
    fill() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const query = {
    in: () => query,
    select: () => query,
    fields: () => query,
    exec: (callback) => callback([{ node: canvas, width: 330, height: 190 }]),
  };
  global.Page = (value) => { definition = value; };
  global.wx = {
    createSelectorQuery: () => query,
    getWindowInfo: () => ({ pixelRatio: 2 }),
  };
  const modulePath = require.resolve("../apps/miniprogram/pages/analysis/analysis.js");
  delete require.cache[modulePath];
  const { drawTrend } = require(modulePath);
  const days = Array.from({ length: 14 }, (_, index) => ({
    dateLabel: index === 12 ? "9/1" : (index === 13 ? "9/2" : `8/${20 + index}`),
    attemptCount: index,
    accuracy: index * 5,
    hasAccuracy: true,
  }));
  drawTrend({}, "learningTrend", { days }, "attempts");

  assert.equal(typeof definition, "object");
  assert.equal(canvas.width, 660);
  assert.equal(canvas.height, 380);
  assert.deepEqual(scales, [[2, 2]]);
  const dateCalls = textCalls.filter((item) => /^\d{2}\/\d{2}$/.test(item.value));
  assert.deepEqual(dateCalls.map((item) => item.value), [
    "08/21", "08/23", "08/25", "08/27", "08/29", "08/31", "09/02",
  ]);
  const gaps = dateCalls.slice(1).map((item, index) => item.x - dateCalls[index].x);
  assert.ok(gaps.every((gap) => Math.abs(gap - gaps[0]) < 0.001));
  assert.equal(new Set(dateCalls.map((item) => item.y)).size, 1);
  const pointLabels = textCalls.filter((item) => /^\d+题$/.test(item.value));
  assert.deepEqual(pointLabels.map((item) => item.value), days.slice(1).map((item) => `${item.attemptCount}题`));
  assert.equal(pointLabels.some((item) => item.value === "0题"), false);
  pointLabels.forEach((label) => {
    const point = arcCalls.find((item) => Math.abs(item.x - label.x) < 0.001);
    assert.ok(point);
    assert.ok(label.y < point.y);
    const halfWidth = label.value.length * 3;
    assert.ok(label.x - halfWidth >= 2);
    assert.ok(label.x + halfWidth <= 328);
  });

  textCalls.length = 0;
  arcCalls.length = 0;
  const accuracyDays = days.map((item, index) => ({
    ...item,
    accuracy: index === 0 ? 0 : (index === days.length - 1 ? 100 : null),
    hasAccuracy: index === 0 || index === days.length - 1,
  }));
  drawTrend({}, "learningTrend", { days: accuracyDays }, "accuracy");
  const accuracyLabels = textCalls.filter((item) => item.x >= 36 && /^\d+(?:\.\d+)?%$/.test(item.value));
  assert.deepEqual(accuracyLabels.map((item) => item.value), ["0%", "100%"]);
  accuracyLabels.forEach((label) => {
    const point = arcCalls.find((item) => Math.abs(item.x - label.x) < 0.001);
    assert.ok(point);
    assert.ok(label.y < point.y);
    assert.ok(label.y >= 0);
  });

  delete require.cache[modulePath];
  delete global.Page;
  delete global.wx;
});

test("a diagnosis response is saved under the subject that started the request", () => {
  let definition;
  let completeRequest;
  const storage = new Map();
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({
    globalData: { aiCredits: 2, apiBaseUrl: "https://example.test", officialQuestions: [] },
    spendAiCredit: () => true,
  });
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    showToast() {},
    request: ({ success }) => { completeRequest = success; },
  };

  const modulePath = require.resolve("../apps/miniprogram/pages/analysis/analysis.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = createPage(definition);
  page.refreshAnalysis = () => {};
  page.onLoad({ subjectId: "modern-chinese" });
  page.setData({
    analysis: {
      subjectName: "现代汉语",
      dimensions: [],
      weakUnits: [],
      missingPoints: [],
      errorAttributions: [],
    },
  });
  page.requestAiAdvice();
  page.selectSubject({ currentTarget: { dataset: { id: "classical-chinese" } } });
  completeRequest({ statusCode: 200, data: { success: true, result: { requestId: "late-modern", text: "现代汉语延迟报告" } } });

  const reports = storage.get("shukao_learning_diagnosis_reports");
  assert.equal(reports["modern-chinese"].text, "现代汉语延迟报告");
  assert.equal(reports["classical-chinese"], undefined);
  assert.equal(page.data.aiAdvice, "");

  delete require.cache[modulePath];
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});
