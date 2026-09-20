const { closeTransientLayers } = require("../../utils/page-layers");
const { findSet, updateSet } = require("../../utils/card-box-store");
const {
  answerSegmentsFromDelta,
  buildHintLines,
  buildHintText,
  deltaText,
  plainTextToHtml,
} = require("../../utils/card-rich-content");

function sanitizeAnswerHtml(value) {
  let html = String(value || "");
  html = html.replace(/<!--([\s\S]*?)-->/g, "");
  html = html.replace(/<(script|style|iframe|object|embed|form|button|textarea|select|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  html = html.replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link|base|svg|math)\b[^>]*\/?\s*>/gi, "");
  html = html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\s+(?:href|src|xlink:href)\s*=\s*(["'])\s*(?:javascript|vbscript|data\s*:\s*text\/html)[\s\S]*?\1/gi, "");
  html = html.replace(/\s+(?:href|src|xlink:href)\s*=\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^\s>]*/gi, "");
  html = html.replace(/\s+style\s*=\s*(["'])[^"']*(?:expression\s*\(|url\s*\(|javascript\s*:|@import|behavior\s*:)[^"']*\1/gi, "");
  return html;
}

function answerTextForCard(card) {
  const plainAnswer = String(card && card.answer || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (plainAnswer.trim()) return plainAnswer;
  const deltaAnswer = deltaText(card && card.answerDelta);
  if (deltaAnswer) return deltaAnswer;
  return (Array.isArray(card && card.answerSegments) ? card.answerSegments : [])
    .map((segment) => String(segment && segment.text || ""))
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "");
}

function studyCard(card) {
  const answer = answerTextForCard(card);
  const answerSegments = Array.isArray(card && card.answerSegments) && card.answerSegments.length
    ? card.answerSegments
    : answerSegmentsFromDelta(card && card.answerDelta, answer);
  const safeHtml = sanitizeAnswerHtml(card && card.answerHtml);
  return {
    ...card,
    answer,
    answerSegments,
    answerNodes: safeHtml || plainTextToHtml(answer),
  };
}

Page({
  data: {
    card: null,
    setTitle: "",
    // DEC-088：左右滑动切卡需要知道"当前是第几张 / 一共几张"
    cardIndex: 0,
    cardTotal: 0,
    slideDirection: "",
    flipped: false,
    hintLevel: 0,
    hintLines: [],
    showMnemonic: false,
    showAssociations: false,
    maskedAnswer: "",
    selectedMastery: "",
    // ②「来源题目」：默认只显示题干摘要，点开才看整道题。
    questionSourceOpen: false,
    questionSourceLoading: false,
    questionSourceNotice: "",
    questionDetail: null,
    questionOptions: [],
    questionAnswerText: "",
  },
  onLoad(options) { this.setId = options.setId; this.cardId = options.cardId; },
  // 离开页面自动收掉所有瞬态浮层（带遮罩的长按工具栏 / 抽屉 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["questionSourceOpen"]);
  },

  onShow() {
    const set = findSet(this.setId);
    const cards = set && Array.isArray(set.cards) ? set.cards : [];
    this.cardIds = cards.map((item) => String(item.id));
    if (!this.cardIds.includes(String(this.cardId))) this.cardId = this.cardIds[0] || this.cardId;
    this.loadCard();
  },

  // DEC-088：单张卡片的装载抽成方法，供「左右滑动切卡」复用（onShow 与切卡都走这里）。
  loadCard({ resetFace = false, slide = "" } = {}) {
    const set = findSet(this.setId);
    const card = set && set.cards.find((item) => String(item.id) === String(this.cardId));
    if (!card) return;
    const ids = this.cardIds || [];
    const index = ids.indexOf(String(this.cardId));
    if (slide) {
      if (this._slideTimer) clearTimeout(this._slideTimer);
      this._slideTimer = setTimeout(() => this.setData({ slideDirection: "" }), 300);
    }
    this.setData({
      card: studyCard(card),
      setTitle: set.title,
      cardIndex: index < 0 ? 0 : index,
      cardTotal: ids.length,
      slideDirection: slide,
      hintLevel: 0,
      hintLines: [],
      maskedAnswer: "",
      selectedMastery: card.mastery || "",
      ...(resetFace ? { flipped: false, showMnemonic: false } : {}),
      questionSourceOpen: false,
      questionSourceNotice: "",
      questionDetail: null,
      questionOptions: [],
      questionAnswerText: "",
    });
  },

  // 左右滑动切卡：上一张 / 下一张（到头给提示，不循环）。
  showRelativeCard(delta) {
    const ids = this.cardIds || [];
    if (ids.length <= 1) {
      wx.showToast({ title: "这个卡集只有一张卡片", icon: "none" });
      return;
    }
    const next = (Number(this.data.cardIndex) || 0) + delta;
    if (next < 0) {
      wx.showToast({ title: "已经是第一张卡片", icon: "none" });
      return;
    }
    if (next >= ids.length) {
      wx.showToast({ title: "已经是最后一张卡片", icon: "none" });
      return;
    }
    this.cardId = ids[next];
    this.loadCard({ resetFace: true, slide: delta > 0 ? "left" : "right" });
  },

  handleCardSwipeStart(event) {
    const touch = (event.touches && event.touches[0]) || {};
    this._swipe = { x: Number(touch.clientX) || 0, y: Number(touch.clientY) || 0 };
  },

  handleCardSwipeEnd(event) {
    const start = this._swipe;
    this._swipe = null;
    if (!start) return;
    const touch = (event.changedTouches && event.changedTouches[0]) || {};
    const dx = (Number(touch.clientX) || 0) - start.x;
    const dy = (Number(touch.clientY) || 0) - start.y;
    // 竖向滑动留给页面 / 卡片内滚动，只认横向、且要够远（60px）并明显大于竖向位移。
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    this.showRelativeCard(dx < 0 ? 1 : -1);
  },
  // 笔记卡没有正反面，点卡片不翻页。
  flip() { if (this.data.card && this.data.card.type === "note") return; this.setData({ flipped: !this.data.flipped }); },
  hint() { const level = Math.min(3, this.data.hintLevel + 1); this.setData({ hintLevel: level, hintLines: buildHintLines(this.data.card, level), maskedAnswer: buildHintText(this.data.card, level) }); },
  toggleMnemonic() { this.setData({ showMnemonic: !this.data.showMnemonic }); },
  openAssociations() { this.setData({ showAssociations: true }); },
  closeAssociations() { this.setData({ showAssociations: false }); },
  rate(e) { const state = e.currentTarget.dataset.state; this.setData({ selectedMastery: state }); updateSet(this.setId, (set) => ({ ...set, cards: set.cards.map((card) => card.id === this.cardId ? { ...card, state: "learning", mastery: state } : card), progress: Math.min(100, set.progress + (state === "easy" ? 4 : 1)) })); wx.showToast({ title: state === "again" ? "已安排复习" : "已记录掌握程度", icon: "none" }); },

  // ②「来源题目」：默认只用卡片上的题干快照，点开后再按题目 id 回查整道题。
  openQuestionSource() {
    if (!this.data.card || !this.data.card.questionId) return;
    this.setData({ questionSourceOpen: true });
    this.loadQuestionDetail();
  },

  closeQuestionSource() { this.setData({ questionSourceOpen: false }); },

  noop() {},

  loadQuestionDetail() {
    const card = this.data.card || {};
    const questionId = String(card.questionId || "");
    if (!questionId || this.data.questionDetail) return;
    const app = typeof getApp === "function" ? getApp() : null;
    const baseUrl = app && app.globalData && app.globalData.apiBaseUrl;
    if (!baseUrl || typeof wx.request !== "function") {
      this.setData({ questionSourceNotice: "离线状态，先显示记录时的题干" });
      return;
    }
    this.setData({ questionSourceLoading: true, questionSourceNotice: "" });
    const query = [`library=official`, `query=${encodeURIComponent(questionId)}`];
    if (card.bookId) query.push(`bookId=${encodeURIComponent(card.bookId)}`);
    wx.request({
      url: `${String(baseUrl).replace(/\/$/, "")}/api/questions?${query.join("&")}`,
      method: "GET",
      timeout: 8000,
      success: (response) => {
        const questions = response && response.statusCode === 200 && response.data && response.data.questions;
        const detail = (Array.isArray(questions) ? questions : []).find((item) => String(item.id) === questionId) || null;
        if (!detail) {
          this.setData({ questionSourceLoading: false, questionSourceNotice: "题目已更新或已下线，先显示记录时的题干" });
          return;
        }
        this.setData({
          questionSourceLoading: false,
          questionDetail: detail,
          questionOptions: Array.isArray(detail.options) ? detail.options : [],
          questionAnswerText: String(detail.referenceAnswer || "").trim()
            || (Array.isArray(detail.correctAnswer) ? detail.correctAnswer.join("、") : ""),
        });
      },
      fail: () => this.setData({ questionSourceLoading: false, questionSourceNotice: "读取题目失败，先显示记录时的题干" }),
    });
  },

  // 去刷题页看整道题（练习页支持按 questionId 定位）。
  goToPracticeQuestion() {
    const card = this.data.card || {};
    if (!card.questionId) return;
    const params = [`questionId=${encodeURIComponent(card.questionId)}`];
    if (card.bookId) params.push(`bookId=${encodeURIComponent(card.bookId)}`);
    if (card.subjectId) params.push(`subjectId=${encodeURIComponent(card.subjectId)}`);
    this.setData({ questionSourceOpen: false });
    wx.navigateTo({ url: `/pages/practice/practice?${params.join("&")}` });
  },
});

module.exports = { answerTextForCard, sanitizeAnswerHtml, studyCard };
