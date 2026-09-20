const { closeTransientLayers } = require("../../utils/page-layers");
const { subjects } = require("../../data/catalog");
const { COMPREHENSIVE_SUBJECT_ID, buildLearningAnalysis } = require("../../utils/learning-analysis");

const DIAGNOSIS_REPORTS_KEY = "shukao_learning_diagnosis_reports";
const DIAGNOSIS_REQUEST_TIMEOUT_MS = 60 * 1000;
const TREND_PERIOD_DAYS = 7;
const TREND_PERIOD_OPTIONS = [7, 14, 30];
const DEFAULT_TREND_PERIOD_DAYS = 14;

const analysisSubjects = [
  { id: COMPREHENSIVE_SUBJECT_ID, name: "汉语言学科综合" },
  ...subjects.map((subject) => ({ id: subject.id, name: subject.name })),
];

function diagnosisReports(storage = wx) {
  const stored = storage.getStorageSync(DIAGNOSIS_REPORTS_KEY);
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

function readDiagnosisReport(subjectId, storage = wx) {
  const saved = diagnosisReports(storage)[subjectId];
  const text = typeof saved === "string" ? saved.trim() : String(saved && saved.text || "").trim();
  if (!text) return null;
  return {
    text,
    generatedAt: Number(saved && saved.generatedAt) || 0,
    requestId: String(saved && saved.requestId || ""),
  };
}

function saveDiagnosisReport(subjectId, report = {}, storage = wx) {
  const text = String(report.text || "").trim();
  if (!subjectId || !text) return null;
  const saved = {
    text,
    generatedAt: Number(report.generatedAt) || Date.now(),
    requestId: String(report.requestId || ""),
  };
  storage.setStorageSync(DIAGNOSIS_REPORTS_KEY, {
    ...diagnosisReports(storage),
    [subjectId]: saved,
  });
  return saved;
}

function drawRadar(page, canvasId, dimensions, size = { width: 330, height: 230 }) {
  if (!wx.createCanvasContext || !Array.isArray(dimensions) || dimensions.length < 3) return;
  const context = wx.createCanvasContext(canvasId, page);
  const centerX = size.width / 2;
  const centerY = size.height / 2 + 3;
  const radius = Math.min(size.width * 0.28, size.height * 0.34);
  const count = dimensions.length;
  const pointAt = (index, ratio = 1) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
    return { x: centerX + Math.cos(angle) * radius * ratio, y: centerY + Math.sin(angle) * radius * ratio };
  };

  context.clearRect(0, 0, size.width, size.height);
  context.setLineWidth(1);
  [0.25, 0.5, 0.75, 1].forEach((ratio) => {
    context.beginPath();
    dimensions.forEach((item, index) => {
      const point = pointAt(index, ratio);
      if (!index) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
    context.setStrokeStyle(ratio === 1 ? "#cfd6d1" : "#e5e9e6");
    context.stroke();
  });
  dimensions.forEach((item, index) => {
    const point = pointAt(index);
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.lineTo(point.x, point.y);
    context.setStrokeStyle("#e4e8e5");
    context.stroke();
  });

  context.beginPath();
  dimensions.forEach((item, index) => {
    const ratio = item.hasData ? Math.max(0.06, item.accuracy / 100) : 0.04;
    const point = pointAt(index, ratio);
    if (!index) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.setFillStyle("rgba(19,123,255,0.20)");
  context.fill();
  context.setLineWidth(2);
  context.setStrokeStyle("#137bff");
  context.stroke();

  dimensions.forEach((item, index) => {
    const ratio = item.hasData ? Math.max(0.06, item.accuracy / 100) : 0.04;
    const point = pointAt(index, ratio);
    context.beginPath();
    context.arc(point.x, point.y, 3, 0, Math.PI * 2);
    context.setFillStyle(item.hasData ? "#137bff" : "#bfc6c1");
    context.fill();
    const labelPoint = pointAt(index, 1.24);
    context.setFillStyle("#4f5752");
    context.setFontSize(count > 5 ? 11 : 12);
    context.setTextAlign(labelPoint.x < centerX - 10 ? "right" : (labelPoint.x > centerX + 10 ? "left" : "center"));
    context.setTextBaseline("middle");
    context.fillText(item.label, labelPoint.x, labelPoint.y);
  });
  context.draw();
}

function trendDirection(delta) {
  if (!Number.isFinite(delta) || delta === 0) return delta === 0 ? "flat" : "neutral";
  return delta > 0 ? "up" : "down";
}

function buildTrendSummary(trend = {}, metric = "accuracy") {
  const period = Math.max(1, Math.floor(Number(trend.periodDays) || TREND_PERIOD_DAYS));
  if (metric === "attempts") {
    const current = Math.max(0, Number(trend.currentAttemptCount) || 0);
    const previous = Math.max(0, Number(trend.previousAttemptCount) || 0);
    const delta = Number.isFinite(trend.attemptDelta) ? trend.attemptDelta : current - previous;
    const comparisonLabel = delta > 0
      ? `较前${period}天多 ${delta} 题`
      : (delta < 0 ? `较前${period}天少 ${Math.abs(delta)} 题` : `与前${period}天持平`);
    return {
      metric,
      value: String(current),
      unit: "题",
      comparisonLabel,
      direction: trendDirection(delta),
      hasData: Array.isArray(trend.days) && trend.days.some((item) => Number(item.attemptCount) > 0),
      emptyText: `近${period}天暂无刷题记录`,
    };
  }

  const current = Number.isFinite(trend.currentAccuracy) ? trend.currentAccuracy : null;
  const delta = Number.isFinite(trend.accuracyDelta) ? trend.accuracyDelta : null;
  const comparisonLabel = delta === null
    ? `暂无前${period}天对比`
    : (delta > 0
      ? `较前${period}天提升 ${delta} 个百分点`
      : (delta < 0 ? `较前${period}天下降 ${Math.abs(delta)} 个百分点` : `与前${period}天持平`));
  return {
    metric: "accuracy",
    value: current === null ? "--" : String(current),
    unit: current === null ? "" : "%",
    comparisonLabel,
    direction: trendDirection(delta),
    hasData: Array.isArray(trend.days) && trend.days.some((item) => item.hasAccuracy),
    emptyText: `近${period}天暂无已评分作答`,
  };
}

function countChartMaximum(days = []) {
  const maximum = Math.max(0, ...days.map((item) => Number(item.attemptCount) || 0));
  if (maximum <= 4) return 4;
  if (maximum <= 10) return 10;
  if (maximum <= 20) return Math.ceil(maximum / 5) * 5;
  return Math.ceil(maximum / 10) * 10;
}

function trendAxisDateLabel(day = {}) {
  const keyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day.dateKey || ""));
  if (keyMatch) return `${keyMatch[2]}/${keyMatch[3]}`;
  const labelMatch = /^(\d{1,2})\/(\d{1,2})$/.exec(String(day.dateLabel || ""));
  if (!labelMatch) return String(day.dateLabel || "");
  return `${labelMatch[1].padStart(2, "0")}/${labelMatch[2].padStart(2, "0")}`;
}

function trendPointLabel(value, metric) {
  if (!Number.isFinite(value)) return "";
  if (metric === "attempts") return value > 0 ? `${Math.round(value)}题` : "";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

function drawTrend(page, canvasId, trend, metric = "accuracy", size = { width: 330, height: 190 }) {
  if (!trend || !Array.isArray(trend.days) || !trend.days.length || typeof wx.createSelectorQuery !== "function") return;
  const query = wx.createSelectorQuery();
  const scopedQuery = query && typeof query.in === "function" ? query.in(page) : query;
  if (!scopedQuery || typeof scopedQuery.select !== "function") return;
  scopedQuery.select(`#${canvasId}`).fields({ node: true, size: true }).exec((result) => {
    const target = result && result[0];
    const canvas = target && target.node;
    if (!canvas || typeof canvas.getContext !== "function") return;
    const width = Math.max(1, Number(target.width) || size.width);
    const height = Math.max(1, Number(target.height) || size.height);
    const windowInfo = typeof wx.getWindowInfo === "function"
      ? wx.getWindowInfo()
      : (typeof wx.getSystemInfoSync === "function" ? wx.getSystemInfoSync() : {});
    const pixelRatio = Math.min(3, Math.max(1, Number(windowInfo.pixelRatio) || 1));
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(pixelRatio, pixelRatio);

    const days = trend.days;
    const left = 36;
    const right = 16;
    const top = 26;
    const bottom = 32;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const maximum = metric === "attempts" ? countChartMaximum(days) : 100;
    const lineColor = metric === "attempts" ? "#e79434" : "#1686a7";
    const values = days.map((item) => (
      metric === "attempts"
        ? Math.max(0, Number(item.attemptCount) || 0)
        : (item.hasAccuracy && Number.isFinite(item.accuracy) ? item.accuracy : null)
    ));
    const xAt = (index) => left + (days.length === 1 ? chartWidth / 2 : (chartWidth * index) / (days.length - 1));
    const yAt = (value) => top + chartHeight - (Math.max(0, Math.min(maximum, value)) / maximum) * chartHeight;

    context.clearRect(0, 0, width, height);
    context.font = "10px sans-serif";
    context.textBaseline = "middle";
    [0, 0.5, 1].forEach((ratio) => {
      const y = top + chartHeight * ratio;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(width - right, y);
      context.lineWidth = 1;
      context.strokeStyle = ratio === 1 ? "#d9dedb" : "#ecefec";
      context.stroke();
      const axisValue = Math.round(maximum * (1 - ratio));
      context.fillStyle = "#8b918d";
      context.textAlign = "right";
      context.fillText(metric === "accuracy" ? `${axisValue}%` : String(axisValue), left - 6, y);
    });

    context.textAlign = "center";
    context.textBaseline = "top";
    context.font = "9px sans-serif";
    const labelStep = Math.max(1, Math.ceil(days.length / 7));
    const lastIndex = days.length - 1;
    days.forEach((item, index) => {
      const shouldShowDate = days.length <= 7 || index % labelStep === lastIndex % labelStep;
      if (!shouldShowDate) return;
      context.beginPath();
      context.moveTo(xAt(index), top + chartHeight);
      context.lineTo(xAt(index), top + chartHeight + 4);
      context.lineWidth = 1;
      context.strokeStyle = "#d9dedb";
      context.stroke();
      context.fillStyle = "#8b918d";
      context.fillText(trendAxisDateLabel(item), xAt(index), height - bottom + 10);
    });

    context.beginPath();
    let hasStarted = false;
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        hasStarted = false;
        return;
      }
      const x = xAt(index);
      const y = yAt(value);
      if (!hasStarted) context.moveTo(x, y);
      else context.lineTo(x, y);
      hasStarted = true;
    });
    context.lineWidth = 2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = lineColor;
    context.stroke();

    values.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      context.beginPath();
      context.arc(xAt(index), yAt(value), 3, 0, Math.PI * 2);
      context.fillStyle = "#ffffff";
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = lineColor;
      context.stroke();
    });

    context.font = "600 9px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.fillStyle = lineColor;
    values.forEach((value, index) => {
      const label = trendPointLabel(value, metric);
      if (!label) return;
      if (days.length > 14 && index % labelStep !== lastIndex % labelStep) return;
      const measuredWidth = typeof context.measureText === "function"
        ? Number(context.measureText(label).width) || label.length * 5
        : label.length * 5;
      const halfWidth = measuredWidth / 2;
      const labelX = Math.max(halfWidth + 2, Math.min(width - halfWidth - 2, xAt(index)));
      context.fillText(label, labelX, Math.max(12, yAt(value) - 7));
    });
  });
}

Page({
  data: {
    subjects: analysisSubjects,
    activeSubjectId: COMPREHENSIVE_SUBJECT_ID,
    activeSubjectName: "汉语言学科综合",
    subjectMenuOpen: false,
    analysis: null,
    aiGenerating: false,
    aiAdvice: "",
    activeTrendMetric: "accuracy",
    trendPeriodDays: DEFAULT_TREND_PERIOD_DAYS,
    trendPeriodOptions: TREND_PERIOD_OPTIONS,
    trendSummary: buildTrendSummary({ periodDays: DEFAULT_TREND_PERIOD_DAYS }),
    activeOverviewTab: "ability",
    activeAnalysisTab: "diagnosis",
  },

  onLoad(options = {}) {
    const subjectId = analysisSubjects.some((subject) => subject.id === options.subjectId)
      ? options.subjectId : COMPREHENSIVE_SUBJECT_ID;
    const activeSubject = analysisSubjects.find((subject) => subject.id === subjectId);
    const savedReport = readDiagnosisReport(subjectId);
    this.setData({
      activeSubjectId: subjectId,
      activeSubjectName: activeSubject ? activeSubject.name : "汉语言学科综合",
      aiAdvice: savedReport ? savedReport.text : "",
    });
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的长按工具栏 / 抽屉 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["subjectMenuOpen"]);
  },

  onShow() {
    this.restoreDiagnosisReport();
    this.refreshAnalysis();
    const app = getApp();
    if (typeof app.syncOfficialQuestions === "function") app.syncOfficialQuestions(() => this.refreshAnalysis(), { force: true });
    if (typeof app.syncLearningState === "function" && app.globalData.loggedIn) app.syncLearningState(() => this.refreshAnalysis());
  },

  onUnload() {
    if (this._overviewDrawTimer) clearTimeout(this._overviewDrawTimer);
    this._overviewDrawTimer = null;
    this._overviewDrawToken = (this._overviewDrawToken || 0) + 1;
  },

  restoreDiagnosisReport(subjectId = this.data.activeSubjectId) {
    const savedReport = readDiagnosisReport(subjectId);
    this.setData({ aiAdvice: savedReport ? savedReport.text : "" });
  },

  refreshAnalysis() {
    const attempts = wx.getStorageSync("shukao_attempts") || [];
    const questionMap = new Map((getApp().globalData.officialQuestions || []).map((question) => [question.id, question]));
    attempts.forEach((attempt) => {
      if (attempt && attempt.question && attempt.question.id && !questionMap.has(attempt.question.id)) questionMap.set(attempt.question.id, attempt.question);
    });
    const questions = [...questionMap.values()];
    const analysis = buildLearningAnalysis({
      attempts,
      questions,
      scoreHistory: wx.getStorageSync("shukao_subjective_score_history") || [],
      subjectId: this.data.activeSubjectId,
      trendPeriodDays: this.data.trendPeriodDays,
    });
    const trendSummary = buildTrendSummary(analysis.trend, this.data.activeTrendMetric);
    this.setData({ analysis, trendSummary }, () => {
      this.scheduleOverviewDraw();
    });
  },

  scheduleOverviewDraw(delay = 30) {
    if (this._overviewDrawTimer) clearTimeout(this._overviewDrawTimer);
    const token = (this._overviewDrawToken || 0) + 1;
    this._overviewDrawToken = token;
    const schedule = () => {
      if (token !== this._overviewDrawToken) return;
      this._overviewDrawTimer = setTimeout(() => {
        this._overviewDrawTimer = null;
        if (token === this._overviewDrawToken) this.drawOverviewChart();
      }, delay);
    };
    if (typeof wx.nextTick === "function") wx.nextTick(schedule);
    else schedule();
  },

  drawOverviewChart() {
    if (!this.data.analysis) return;
    if (this.data.activeOverviewTab === "ability") {
      drawRadar(this, "abilityRadar", this.data.analysis.dimensions);
      return;
    }
    if (this.data.trendSummary.hasData) {
      drawTrend(this, "learningTrend", this.data.analysis.trend, this.data.activeTrendMetric);
    }
  },

  selectOverviewTab(event) {
    const tab = event.currentTarget.dataset.overview;
    if (!["ability", "trend"].includes(tab) || tab === this.data.activeOverviewTab) return;
    this.setData({ activeOverviewTab: tab }, () => {
      this.scheduleOverviewDraw();
    });
  },

  selectTrendMetric(event) {
    const metric = event.currentTarget.dataset.metric;
    if (!this.data.analysis || !["accuracy", "attempts"].includes(metric)) return;
    const trendSummary = buildTrendSummary(this.data.analysis.trend, metric);
    this.setData({ activeTrendMetric: metric, trendSummary }, () => {
      if (this.data.activeOverviewTab === "trend") this.scheduleOverviewDraw();
    });
  },

  selectTrendPeriod(event) {
    const days = Number(event.currentTarget.dataset.days);
    if (!TREND_PERIOD_OPTIONS.includes(days) || days === this.data.trendPeriodDays) return;
    this.setData({ trendPeriodDays: days }, () => this.refreshAnalysis());
  },

  selectAnalysisTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!["diagnosis", "missing", "weak", "attribution"].includes(tab)) return;
    this.setData({ activeAnalysisTab: tab });
  },

  toggleSubjectMenu() {
    this.setData({ subjectMenuOpen: !this.data.subjectMenuOpen });
  },

  selectSubject(event) {
    const id = event.currentTarget.dataset.id;
    const subject = analysisSubjects.find((item) => item.id === id);
    if (!subject) return;
    if (id === this.data.activeSubjectId) {
      this.setData({ subjectMenuOpen: false });
      return;
    }
    const savedReport = readDiagnosisReport(id);
    this.setData({
      activeSubjectId: id,
      activeSubjectName: subject.name,
      subjectMenuOpen: false,
      aiAdvice: savedReport ? savedReport.text : "",
    }, () => this.refreshAnalysis());
  },

  requestAiAdvice() {
    if (this.data.aiGenerating || !this.data.analysis) return;
    const app = getApp();
    if (app.globalData.aiCredits < 1) {
      wx.showToast({ title: "AI 额度不足", icon: "none" });
      return;
    }
    const apiBaseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!apiBaseUrl || typeof wx.request !== "function") {
      wx.showToast({ title: "请先在后台配置学情诊断模型", icon: "none" });
      return;
    }
    const analysis = this.data.analysis;
    const requestSubjectId = this.data.activeSubjectId;
    const questionMap = new Map((app.globalData.officialQuestions || []).map((question) => [question.id, question]));
    (wx.getStorageSync("shukao_attempts") || []).forEach((attempt) => {
      if (attempt && attempt.question && attempt.question.id && !questionMap.has(attempt.question.id)) questionMap.set(attempt.question.id, attempt.question);
    });
    const wrongQuestionIds = analysis.weakUnits.flatMap((unit) => unit.wrongQuestionIds).slice(0, 10);
    this.setData({ aiGenerating: true });
    wx.request({
      url: `${apiBaseUrl}/api/ai/learning-diagnosis`,
      method: "POST",
      timeout: DIAGNOSIS_REQUEST_TIMEOUT_MS,
      data: {
        requestId: `learning-diagnosis-${Date.now()}`,
        subject: analysis.subjectName,
        unitProfile: analysis.dimensions.map((item) => ({
          unit: item.label,
          attempts: item.attemptCount,
          wrong: item.wrongCount,
          accuracy: item.hasData ? item.accuracy : null,
        })),
        recentWrongQuestions: wrongQuestionIds.map((id) => {
          const question = questionMap.get(id) || {};
          return { id, stem: question.stem || "", knowledgePoint: question.knowledgePoint || "" };
        }),
        missingPoints: analysis.missingPoints,
        errorAttributions: analysis.errorAttributions,
      },
      success: (response) => {
        const payload = response.data || {};
        const result = payload.result || {};
        if (response.statusCode !== 200 || !payload.success || !String(result.text || "").trim()) {
          this.setData({ aiGenerating: false });
          wx.showToast({ title: "生成失败，未扣额度", icon: "none" });
          return;
        }
        if (!app.spendAiCredit(1, {
          referenceId: result.requestId,
          source: "learning_diagnosis",
          description: "学情诊断建议",
        })) {
          this.setData({ aiGenerating: false });
          return;
        }
        const savedReport = saveDiagnosisReport(requestSubjectId, {
          text: result.text,
          requestId: result.requestId,
          generatedAt: Date.now(),
        });
        this.setData({
          aiGenerating: false,
          ...(this.data.activeSubjectId === requestSubjectId ? { aiAdvice: savedReport.text } : {}),
        });
      },
      fail: () => {
        this.setData({ aiGenerating: false });
        wx.showToast({ title: "生成失败，未扣额度", icon: "none" });
      },
    });
  },

  startTargetedPractice() {
    const questionIds = this.data.analysis && this.data.analysis.targetedQuestionIds;
    if (!questionIds || !questionIds.length) {
      wx.showToast({ title: "先完成一些练习，系统才能生成专项题组", icon: "none" });
      return;
    }
    wx.setStorageSync("shukao_active_review_ids", questionIds);
    wx.navigateTo({ url: "/pages/practice/practice?mode=review" });
  },
});

module.exports = {
  DIAGNOSIS_REPORTS_KEY,
  DIAGNOSIS_REQUEST_TIMEOUT_MS,
  buildTrendSummary,
  drawTrend,
  diagnosisReports,
  drawRadar,
  readDiagnosisReport,
  saveDiagnosisReport,
  trendPointLabel,
};
