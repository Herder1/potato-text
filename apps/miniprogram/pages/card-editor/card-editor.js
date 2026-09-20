const { closeTransientLayers } = require("../../utils/page-layers");
const {
  addCardToSet,
  cardId,
  findCard,
  updateCardInSet,
} = require("../../utils/card-box-store");
const {
  CLOZE_COLOR,
  answerSegmentsFromDelta,
  applyAttributesToRanges,
  deltaText,
  normalizeDelta,
  normalizeEditorText,
  plainTextToDelta,
  plainTextToHtml,
  removeHighlightAttributes,
} = require("../../utils/card-rich-content");
const {
  CARD_AI_SCHEMA_VERSION,
  cardAiFingerprint,
  normalizeCardAiResult,
  readCardAiCache,
  writeCardAiCache,
} = require("../../utils/card-ai-cache");

const HIGHLIGHT_COLOR = "#fff0a8";
const TYPE_LABELS = { qa: "问答卡", note: "笔记卡", topic: "主题卡" };
const CARD_AI_FEATURES = {
  cloze: {
    ranges: "clozes",
    attributes: { color: CLOZE_COLOR, underline: true },
    successTitle: "已自动标记挖空",
  },
  highlight: {
    ranges: "highlights",
    attributes: { backgroundColor: HIGHLIGHT_COLOR },
    successTitle: "已自动标出重点",
  },
  mnemonic: { successTitle: "口诀已生成" },
};

function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.qa;
}

function normalizedColor(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function isClozeColor(value) {
  const color = normalizedColor(value);
  return color === CLOZE_COLOR || color === "rgb(22,143,216)";
}

function isHighlightColor(value) {
  const color = normalizedColor(value);
  return color === HIGHLIGHT_COLOR || color === "rgb(255,240,168)";
}

function imageSourcesFromDelta(delta) {
  if (!delta || !Array.isArray(delta.ops)) return [];
  return [...new Set(delta.ops
    .map((op) => op && op.insert && typeof op.insert === "object" ? op.insert.image : "")
    .filter(Boolean))];
}

function currentApp() {
  if (typeof getApp !== "function") return null;
  try { return getApp(); } catch (error) { return null; }
}

function cardAiFailureTitle(error, statusCode = 0) {
  const reason = String(error || "");
  if (reason.includes("route_unavailable") || reason.includes("provider_unavailable")) return "请先配置知识卡 AI 模型";
  if (reason.includes("source_too_long") || statusCode === 413) return "答案过长，请精简后再试";
  if (reason.includes("output_format") || statusCode === 422) return "模型结果无法对应原文，未扣额度";
  if (/timeout/i.test(reason)) return "生成超时，未扣额度";
  if (/network|request:fail|fetch failed/i.test(reason)) return "网络异常，未扣额度";
  return "生成失败，未扣额度";
}

Page({
  data: {
    navTotalHeight: 88,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    typePickerTop: 100,
    type: "qa",
    typeLabel: TYPE_LABELS.qa,
    typePickerOpen: false,
    isEditing: false,
    question: "",
    answer: "",
    answerHtml: "",
    answerDelta: { ops: [] },
    answerImages: [],
    section: "未分类",
    mnemonic: "",
    keyboardHeight: 0,
    keyboardToolbarVisible: false,
    toolbarDocked: false,
    toolbarLevel: "primary",
    assistantOpen: false,
    activeFormats: {},
    activeCloze: false,
    activeHighlight: false,
    assistantBusy: false,
    keyboardSpacerHeight: 0,
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的选择器 / 预览层 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["typePickerOpen","keyboardToolbarVisible","assistantOpen"]);
  },

  onLoad(options = {}) {
    this.measureNavigation();
    this.setId = decodeURIComponent(options.setId || "");
    this.cardId = decodeURIComponent(options.cardId || "");
    this.answerFocused = false;
    this._cardAiDisposed = false;
    this.registerKeyboardListener();

    const requestedType = options.type || "qa";
    if (!this.cardId) {
      this.setData({ type: requestedType, typeLabel: typeLabel(requestedType) });
      return;
    }

    const card = findCard(this.setId, this.cardId);
    if (!card) {
      this.invalidCard = true;
      wx.showToast({ title: "没有找到这张卡片", icon: "none" });
      return;
    }

    const hasStoredDelta = card.answerDelta
      && Array.isArray(card.answerDelta.ops)
      && card.answerDelta.ops.length > 0;
    const answer = normalizeEditorText(card.answer || deltaText(card.answerDelta));
    const answerDelta = hasStoredDelta ? normalizeDelta(card.answerDelta, answer) : null;
    this.setData({
      isEditing: true,
      type: card.type || requestedType,
      typeLabel: typeLabel(card.type || requestedType),
      question: card.question || "",
      answer,
      answerHtml: card.answerHtml || plainTextToHtml(answer),
      answerDelta,
      answerImages: Array.isArray(card.answerImages) ? card.answerImages : [],
      section: card.section || "未分类",
      mnemonic: card.mnemonic || "",
    }, () => this.setAnswerContents());
  },

  onUnload() {
    this._cardAiDisposed = true;
    if (this._cardAiRequestTask && typeof this._cardAiRequestTask.abort === "function") this._cardAiRequestTask.abort();
    if (this._keyboardHeightHandler && typeof wx.offKeyboardHeightChange === "function") {
      wx.offKeyboardHeightChange(this._keyboardHeightHandler);
    }
    if (this._toolbarTimer) clearTimeout(this._toolbarTimer);
    if (this._keyboardCloseTimer) clearTimeout(this._keyboardCloseTimer);
    if (this._toolbarInteractionTimer) clearTimeout(this._toolbarInteractionTimer);
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function"
      ? wx.getWindowInfo()
      : (typeof wx.getSystemInfoSync === "function" ? wx.getSystemInfoSync() : { statusBarHeight: 24, windowWidth: 375 });
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function" ? wx.getMenuButtonBoundingClientRect() : null;
    const hasCapsule = capsule && capsule.width > 0 && capsule.height > 0;
    const statusBarHeight = windowInfo.statusBarHeight || (hasCapsule ? capsule.top : 24);
    const top = hasCapsule ? capsule.top : statusBarHeight + 4;
    const height = hasCapsule ? capsule.height : 32;
    const gap = Math.max(4, top - statusBarHeight);
    const navTotalHeight = statusBarHeight + height + gap * 2;
    this.toolbarHeightPx = 96 * (windowInfo.windowWidth || 375) / 750;
    this.setData({
      statusBarHeight,
      navTotalHeight,
      capsuleSafeRight: hasCapsule ? Math.max(96, windowInfo.windowWidth - capsule.left + 8) : 96,
      typePickerTop: navTotalHeight + 10,
    });
  },

  registerKeyboardListener() {
    if (typeof wx.onKeyboardHeightChange !== "function") return;
    const applyHeight = (height) => {
      const keyboardHeight = Math.max(0, Number(height) || 0);
      const keyboardToolbarVisible = keyboardHeight > 0 && this.answerFocused;
      this.setData({
        keyboardHeight,
        keyboardToolbarVisible,
        toolbarDocked: keyboardToolbarVisible,
        keyboardSpacerHeight: keyboardToolbarVisible
          ? keyboardHeight + (this.toolbarHeightPx || 48) + 16
          : 0,
        ...(keyboardToolbarVisible ? {} : { assistantOpen: false, toolbarLevel: "primary" }),
      });
    };
    this._keyboardHeightHandler = ({ height = 0 }) => {
      const keyboardHeight = Math.max(0, Number(height) || 0);
      if (!keyboardHeight && this._toolbarInteracting) {
        if (this._keyboardCloseTimer) clearTimeout(this._keyboardCloseTimer);
        this._keyboardCloseTimer = setTimeout(() => applyHeight(0), 180);
        return;
      }
      if (this._keyboardCloseTimer) clearTimeout(this._keyboardCloseTimer);
      applyHeight(keyboardHeight);
    };
    wx.onKeyboardHeightChange(this._keyboardHeightHandler);
  },

  goBack() { wx.navigateBack(); },
  openTypePicker() { this.setData({ typePickerOpen: true }); },
  closeTypePicker() { this.setData({ typePickerOpen: false }); },
  selectType(event) {
    const type = event.currentTarget.dataset.type;
    this.setData({ type, typeLabel: typeLabel(type), typePickerOpen: false });
  },
  input(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },

  onPlainFieldFocus() {
    this.answerFocused = false;
    this.setData({ keyboardToolbarVisible: false, toolbarDocked: false, keyboardSpacerHeight: 0, assistantOpen: false, toolbarLevel: "primary" });
  },

  onAnswerFocus() {
    this.answerFocused = true;
    if (this.data.keyboardHeight > 0) this.setData({
      keyboardToolbarVisible: true,
      toolbarDocked: true,
      keyboardSpacerHeight: this.data.keyboardHeight + (this.toolbarHeightPx || 48) + 16,
    });
  },

  onAnswerBlur() {
    if (this._toolbarTimer) clearTimeout(this._toolbarTimer);
    this._toolbarTimer = setTimeout(() => {
      if (!this.data.keyboardHeight && !this._toolbarInteracting) {
        this.answerFocused = false;
        this.setData({ keyboardToolbarVisible: false, toolbarDocked: false, keyboardSpacerHeight: 0, assistantOpen: false, toolbarLevel: "primary" });
      }
    }, 80);
  },

  holdAnswerToolbar() {
    if (this._toolbarTimer) clearTimeout(this._toolbarTimer);
    if (this._toolbarInteractionTimer) clearTimeout(this._toolbarInteractionTimer);
    this.answerFocused = true;
    this._toolbarInteracting = true;
    this._toolbarInteractionTimer = setTimeout(() => { this._toolbarInteracting = false; }, 220);
  },

  onAnswerEditorReady() {
    if (typeof wx.createSelectorQuery !== "function") return;
    wx.createSelectorQuery().select("#card-answer-editor").context((result) => {
      this.editorCtx = result.context;
      this.setAnswerContents();
    }).exec();
  },

  setAnswerContents() {
    if (!this.editorCtx) return;
    if (this.data.answerDelta && Array.isArray(this.data.answerDelta.ops) && this.data.answerDelta.ops.length) {
      this.editorCtx.setContents({ delta: normalizeDelta(this.data.answerDelta, this.data.answer) });
    }
    else if (this.data.answerHtml) this.editorCtx.setContents({ html: this.data.answerHtml });
  },

  onAnswerInput(event) {
    const answer = normalizeEditorText(event.detail.text || "");
    this.setData({
      answer,
      answerHtml: event.detail.html || plainTextToHtml(answer),
      answerDelta: normalizeDelta(event.detail.delta, answer),
    });
  },

  onAnswerFormatChange(event) {
    const activeFormats = event.detail || {};
    this.setData({
      activeFormats,
      activeCloze: Boolean(activeFormats.underline) && isClozeColor(activeFormats.color),
      activeHighlight: isHighlightColor(activeFormats.backgroundColor),
    });
  },

  formatText(event) {
    if (!this.editorCtx) return;
    const name = event.currentTarget.dataset.name;
    const value = event.currentTarget.dataset.value;
    if (value === undefined) this.editorCtx.format(name);
    else this.editorCtx.format(name, value);
    this.setData({ assistantOpen: false });
  },

  withSelectedText(callback) {
    if (!this.editorCtx || typeof this.editorCtx.getSelectionText !== "function") {
      wx.showToast({ title: "请先选择文字", icon: "none" });
      return;
    }
    this.editorCtx.getSelectionText({
      success: ({ text = "" }) => {
        if (!String(text).trim()) {
          wx.showToast({ title: "请先选择文字", icon: "none" });
          return;
        }
        callback();
      },
      fail: () => wx.showToast({ title: "请先选择文字", icon: "none" }),
    });
  },

  markCloze() {
    this.withSelectedText(() => {
      this.editorCtx.format("color", CLOZE_COLOR);
      this.editorCtx.format("underline", true);
      this.setData({ assistantOpen: false });
    });
  },

  markHighlight() {
    this.withSelectedText(() => {
      this.editorCtx.format("backgroundColor", HIGHLIGHT_COLOR);
      this.setData({ assistantOpen: false });
    });
  },

  undo() { if (this.editorCtx && typeof this.editorCtx.undo === "function") this.editorCtx.undo(); },
  redo() { if (this.editorCtx && typeof this.editorCtx.redo === "function") this.editorCtx.redo(); },

  toggleSecondaryToolbar() {
    this.setData({
      toolbarLevel: this.data.toolbarLevel === "secondary" ? "primary" : "secondary",
      assistantOpen: false,
    });
  },

  toggleAssistant() {
    if (this.data.assistantBusy) {
      wx.showToast({ title: "正在分析答案", icon: "none" });
      return;
    }
    this.setData({ assistantOpen: !this.data.assistantOpen, toolbarLevel: "primary" });
  },

  clearFormatting() {
    if (this.editorCtx && typeof this.editorCtx.removeFormat === "function") this.editorCtx.removeFormat();
  },

  getAnswerContents(callback) {
    const fallback = {
      html: this.data.answerHtml || plainTextToHtml(this.data.answer),
      text: normalizeEditorText(this.data.answer),
      delta: normalizeDelta(this.data.answerDelta, this.data.answer),
    };
    if (!this.editorCtx || typeof this.editorCtx.getContents !== "function") {
      callback(fallback);
      return;
    }
    this.editorCtx.getContents({
      success: (result) => callback({
        html: result.html || fallback.html,
        text: normalizeEditorText(result.text || ""),
        delta: normalizeDelta(result.delta, result.text || fallback.text),
      }),
      fail: () => callback(fallback),
    });
  },

  cardAiScope() {
    const app = currentApp();
    return String(app && app.globalData && app.globalData.userId || "guest");
  },

  cachedCardAiResult(question, answer, fingerprint) {
    if (this._cardAiCache && this._cardAiCache.fingerprint === fingerprint) return this._cardAiCache.result;
    const cached = readCardAiCache(question, answer, this.cardAiScope());
    if (!cached || cached.fingerprint !== fingerprint) return null;
    this._cardAiCache = cached;
    return cached.result;
  },

  applyCardAiFeature(feature, result, fingerprint) {
    const settings = CARD_AI_FEATURES[feature];
    if (!settings || this._cardAiDisposed) return;
    this.getAnswerContents((contents) => {
      if (this._cardAiDisposed) return;
      const currentFingerprint = cardAiFingerprint(this.data.question, contents.text, this.cardAiScope());
      if (currentFingerprint !== fingerprint) {
        wx.showToast({ title: "答案已变化，请重新生成", icon: "none" });
        return;
      }
      if (feature === "mnemonic") {
        this.setData({ mnemonic: result.mnemonic.text, assistantOpen: false });
        wx.showToast({ title: settings.successTitle, icon: "none" });
        return;
      }
      const ranges = result[settings.ranges] || [];
      if (!ranges.length || !this.editorCtx || typeof this.editorCtx.setContents !== "function") {
        wx.showToast({ title: "模型没有找到可标记内容", icon: "none" });
        return;
      }
      const baseDelta = feature === "highlight"
        ? removeHighlightAttributes(contents.delta, contents.text)
        : contents.delta;
      const delta = applyAttributesToRanges(baseDelta, ranges, settings.attributes, contents.text);
      this.editorCtx.setContents({
        delta,
        success: () => this.getAnswerContents((next) => {
          this.setData({
            answer: next.text,
            answerHtml: next.html,
            answerDelta: next.delta,
            assistantOpen: false,
          });
          wx.showToast({ title: settings.successTitle, icon: "none" });
        }),
        fail: () => wx.showToast({ title: "格式应用失败，请重试", icon: "none" }),
      });
    });
  },

  finishCardAiRequest(token, patch = {}) {
    if (this._cardAiRequestToken !== token || this._cardAiDisposed) return false;
    this._cardAiRequestToken = "";
    this._cardAiRequestTask = null;
    this.setData({ assistantBusy: false, ...patch });
    return true;
  },

  requestCardAiResult(feature, question, answer, fingerprint) {
    const app = currentApp();
    const apiBaseUrls = app && typeof app.apiBaseUrlCandidates === "function"
      ? app.apiBaseUrlCandidates()
      : [String(app && app.globalData && app.globalData.apiBaseUrl || "").replace(/\/$/, "")].filter(Boolean);
    if (!apiBaseUrls.length || typeof wx.request !== "function") {
      wx.showToast({ title: "请先配置知识卡 AI 模型", icon: "none" });
      return;
    }
    if (app && app.globalData && Number(app.globalData.aiCredits) < 1) {
      wx.showToast({ title: "AI 额度不足", icon: "none" });
      return;
    }

    const requestId = `card-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const token = `${requestId}:${fingerprint}`;
    this._cardAiRequestToken = token;
    this.setData({ assistantBusy: true, assistantOpen: false });
    const fail = (reason, statusCode = 0) => {
      if (!this.finishCardAiRequest(token)) return;
      wx.showToast({ title: cardAiFailureTitle(reason, statusCode), icon: "none" });
    };
    const requestAt = (index, previousError = "") => {
      const apiBaseUrl = apiBaseUrls[index];
      if (!apiBaseUrl) {
        fail(previousError || "request_failed");
        return;
      }
      this._cardAiRequestTask = wx.request({
        url: `${apiBaseUrl}/api/ai/card-memory-assistance`,
        method: "POST",
        timeout: 135000,
        header: app && app.globalData && app.globalData.authToken
          ? { Authorization: `Bearer ${app.globalData.authToken}` }
          : {},
        data: {
          requestId,
          userId: String(app && app.globalData && app.globalData.userId || "test-user"),
          question,
          answer,
          requestedFeature: feature,
        },
        success: (response) => {
          if (this._cardAiRequestToken !== token || this._cardAiDisposed) return;
          const payload = response.data || {};
          if (response.statusCode === 404 && index + 1 < apiBaseUrls.length) {
            requestAt(index + 1, payload.error || "route_not_found");
            return;
          }
          const result = response.statusCode === 200
            && payload.success
            && payload.schemaVersion === CARD_AI_SCHEMA_VERSION
            ? normalizeCardAiResult(payload.result, answer)
            : null;
          if (!result) {
            fail(payload.error || "invalid_card_ai_result", response.statusCode);
            return;
          }
          if (payload.chargeable === true && app && typeof app.spendAiCredit === "function" && !app.spendAiCredit(1, {
            referenceId: String(payload.result && payload.result.requestId || requestId),
            source: "card_memory_assistance",
            description: "知识卡重点、挖空与口诀生成",
          })) {
            fail("billing_credit_insufficient");
            return;
          }
          if (app && app.globalData) app.globalData.apiBaseUrl = apiBaseUrl;
          const cached = writeCardAiCache(question, answer, this.cardAiScope(), result);
          this._cardAiCache = cached || { fingerprint, result };
          if (!this.finishCardAiRequest(token)) return;
          this.applyCardAiFeature(feature, result, fingerprint);
        },
        fail: (error) => {
          if (this._cardAiRequestToken !== token || this._cardAiDisposed) return;
          if (index + 1 < apiBaseUrls.length) {
            requestAt(index + 1, error && error.errMsg || "request_failed");
            return;
          }
          fail(error && error.errMsg || previousError || "request_failed");
        },
      });
    };
    requestAt(0);
  },

  runCardAiAssistance(feature) {
    if (!CARD_AI_FEATURES[feature]) return;
    if (this.data.assistantBusy || this._cardAiRequestToken) {
      wx.showToast({ title: "正在分析答案", icon: "none" });
      return;
    }
    this.getAnswerContents((contents) => {
      const answer = normalizeEditorText(contents.text);
      if (!answer.trim()) {
        wx.showToast({ title: "先输入一段答案", icon: "none" });
        return;
      }
      const question = String(this.data.question || "").trim();
      if (feature !== "mnemonic" && !question) {
        wx.showToast({ title: "先填写卡片问题", icon: "none" });
        return;
      }
      const fingerprint = cardAiFingerprint(question, answer, this.cardAiScope());
      const cached = this.cachedCardAiResult(question, answer, fingerprint);
      if (cached) {
        this.applyCardAiFeature(feature, cached, fingerprint);
        return;
      }
      this.requestCardAiResult(feature, question, answer, fingerprint);
    });
  },

  autoCloze() { this.runCardAiAssistance("cloze"); },
  autoHighlight() { this.runCardAiAssistance("highlight"); },
  createMnemonic() { this.runCardAiAssistance("mnemonic"); },

  chooseAnswerImage() {
    this.setData({ assistantOpen: false });
    if (typeof wx.chooseMedia !== "function") return;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const tempFilePath = result.tempFiles && result.tempFiles[0] && result.tempFiles[0].tempFilePath;
        if (!tempFilePath) return;
        const insert = (src) => {
          if (this.editorCtx) this.editorCtx.insertImage({ src, width: "100%", alt: "卡片答案图片" });
          this.setData({ answerImages: [...this.data.answerImages, src] });
        };
        if (typeof wx.saveFile !== "function") { insert(tempFilePath); return; }
        wx.saveFile({
          tempFilePath,
          success: ({ savedFilePath }) => insert(savedFilePath || tempFilePath),
          fail: () => insert(tempFilePath),
        });
      },
    });
  },

  save() {
    if (this.saving) return;
    if (this.invalidCard) {
      wx.showToast({ title: "这张卡片已不存在", icon: "none" });
      return;
    }
    this.saving = true;
    this.getAnswerContents((contents) => {
      const question = String(this.data.question || "").trim();
      const answer = normalizeEditorText(contents.text).trim();
      if (!question || !answer) {
        this.saving = false;
        wx.showToast({ title: "请填写正面和背面内容", icon: "none" });
        return;
      }

      const answerDelta = normalizeDelta(contents.delta || plainTextToDelta(answer), answer);
      const answerImages = imageSourcesFromDelta(answerDelta);
      const editable = {
        type: this.data.type,
        section: String(this.data.section || "").trim() || "未分类",
        question,
        answer,
        answerHtml: contents.html || plainTextToHtml(answer),
        answerDelta,
        answerSegments: answerSegmentsFromDelta(answerDelta, answer),
        answerImages,
        mnemonic: String(this.data.mnemonic || "").trim(),
      };

      const saved = this.cardId
        ? updateCardInSet(this.setId, this.cardId, editable)
        : addCardToSet(this.setId, {
          id: cardId(),
          ...editable,
          associations: [],
          state: "new",
        });
      if (!saved) {
        this.saving = false;
        wx.showToast({ title: "保存失败，请返回后重试", icon: "none" });
        return;
      }
      wx.navigateBack();
    });
  },
});
