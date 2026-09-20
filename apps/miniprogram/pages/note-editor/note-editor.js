const { closeTransientLayers } = require("../../utils/page-layers");
const { deleteAsset, loadAssets, saveAsset, updateAsset } = require("../../utils/asset-store");
const {
  COMPLETED_PREFIX,
  DRAFT_PREFIX,
  createDraftId,
  loadNoteDraft,
  normalizeDraft,
  removeNoteDraft,
  saveNoteDraft,
} = require("../../utils/note-draft-store");

Page({
  data: {
    navTotalHeight: 88,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    draftId: "",
    noteId: "",
    draftStage: "editor",
    title: "",
    contentHtml: "",
    contentText: "",
    images: [],
    questionRefs: [],
    toolPanel: "",
    moreMenuOpen: false,
    questionPickerOpen: false,
    questionOptions: [],
    previewOpen: false,
    textStyles: [
      { id: "h1", label: "标题 1" }, { id: "h2", label: "标题 2" }, { id: "h3", label: "标题 3" },
      { id: "body1", label: "正文 1" }, { id: "body2", label: "正文 2" }, { id: "body3", label: "正文 3" },
    ],
    colorOptions: [
      { label: "黑", value: "#202421" }, { label: "灰", value: "#707873" }, { label: "蓝", value: "#287b96" },
      { label: "绿", value: "#347553" }, { label: "红", value: "#a54b43" }, { label: "黄", value: "#f2d25d" },
    ],
    fontSizes: [
      { label: "小", value: "14px", preview: 22 }, { label: "标准", value: "17px", preview: 27 },
      { label: "大", value: "20px", preview: 32 }, { label: "特大", value: "24px", preview: 38 },
    ],
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的选择器 / 预览层 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["moreMenuOpen","questionPickerOpen","previewOpen"]);
  },

  onLoad(options = {}) {
    this.measureNavigation();
    const noteId = decodeURIComponent(options.noteId || "");
    let draftId = decodeURIComponent(options.draftId || "");
    let draft = draftId ? loadNoteDraft(draftId) : null;
    if (!draft && noteId) {
      const asset = loadAssets().find((item) => item.id === noteId && item.type === "note");
      if (asset && asset.draftId) {
        draftId = asset.draftId;
        draft = loadNoteDraft(draftId);
      }
      if (asset) {
        if (!draft) {
          draftId = createDraftId();
          draft = {
            id: draftId,
            noteId,
            title: asset.title,
            contentHtml: asset.contentHtml || `<p>${asset.content || ""}</p>`,
            contentText: asset.content || "",
            images: asset.images || [],
            questionRefs: asset.questionRefs || [],
          };
        }
      }
    }
    const normalized = normalizeDraft(draft || { id: draftId || createDraftId(), noteId });
    this.setData({
      draftId: normalized.id,
      noteId: normalized.noteId,
      draftStage: normalized.stage,
      title: normalized.title,
      contentHtml: normalized.contentHtml,
      contentText: normalized.contentText,
      images: normalized.images,
      questionRefs: normalized.questionRefs,
    });
  },

  onUnload() {
    if (wx.getStorageSync(`${COMPLETED_PREFIX}${this.data.draftId}`)) {
      wx.removeStorageSync(`${COMPLETED_PREFIX}${this.data.draftId}`);
      return;
    }
    if (!this._discarded) this.persistDraft(null, this.data.draftStage);
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = wx.getMenuButtonBoundingClientRect();
    const hasCapsule = capsule && capsule.width > 0 && capsule.height > 0;
    const statusBarHeight = windowInfo.statusBarHeight || (hasCapsule ? capsule.top : 24);
    const top = hasCapsule ? capsule.top : statusBarHeight + 4;
    const height = hasCapsule ? capsule.height : 32;
    const gap = Math.max(4, top - statusBarHeight);
    this.setData({
      statusBarHeight,
      navTotalHeight: statusBarHeight + height + gap * 2,
      capsuleSafeRight: hasCapsule ? Math.max(96, windowInfo.windowWidth - capsule.left + 8) : 96,
    });
  },

  onEditorReady() {
    if (typeof wx.createSelectorQuery !== "function") return;
    wx.createSelectorQuery().select("#note-editor").context((result) => {
      this.editorCtx = result.context;
      if (this.data.contentHtml) this.editorCtx.setContents({ html: this.data.contentHtml });
    }).exec();
  },

  onEditorInput(event) {
    this.setData({
      contentHtml: event.detail.html || "",
      contentText: event.detail.text || "",
    });
  },

  onFormatChange() {},
  updateTitle(event) { this.setData({ title: event.detail.value }); },

  toggleToolPanel(event) {
    const panel = event.currentTarget.dataset.panel;
    this.setData({ toolPanel: this.data.toolPanel === panel ? "" : panel, moreMenuOpen: false });
  },

  formatText(event) {
    if (!this.editorCtx) return;
    const name = event.currentTarget.dataset.name;
    const value = event.currentTarget.dataset.value;
    if (value === undefined) this.editorCtx.format(name);
    else this.editorCtx.format(name, value);
    this.setData({ toolPanel: "" });
  },

  applyTextStyle(event) {
    if (!this.editorCtx) return;
    const style = event.currentTarget.dataset.id;
    const headerMap = { h1: "H1", h2: "H2", h3: "H3" };
    const bodySizeMap = { body1: "18px", body2: "16px", body3: "14px" };
    if (headerMap[style]) this.editorCtx.format("header", headerMap[style]);
    else {
      this.editorCtx.format("header", "");
      this.editorCtx.format("fontSize", bodySizeMap[style] || "16px");
    }
    this.setData({ toolPanel: "" });
  },

  applyColor(event) {
    if (!this.editorCtx) return;
    const name = this.data.toolPanel === "background" ? "backgroundColor" : "color";
    this.editorCtx.format(name, event.currentTarget.dataset.value);
    this.setData({ toolPanel: "" });
  },

  applyFontSize(event) {
    if (this.editorCtx) this.editorCtx.format("fontSize", event.currentTarget.dataset.value);
    this.setData({ toolPanel: "" });
  },

  insertCallout() {
    if (this.editorCtx) this.editorCtx.insertText({ text: "\n【重点】在这里输入内容\n" });
    this.setData({ toolPanel: "" });
  },

  chooseImages() {
    this.setData({ toolPanel: "" });
    wx.chooseMedia({
      count: Math.max(1, 6 - this.data.images.length),
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const paths = result.tempFiles.map((file) => file.tempFilePath).slice(0, 6 - this.data.images.length);
        this.saveAndInsertImages(paths);
      },
    });
  },

  saveAndInsertImages(paths) {
    if (!paths.length) return;
    const saved = [];
    const finish = () => {
      const images = [...this.data.images, ...saved].slice(0, 6);
      this.setData({ images });
      saved.forEach((src) => {
        if (this.editorCtx) this.editorCtx.insertImage({ src, width: "100%", alt: "笔记图片" });
      });
    };
    if (typeof wx.saveFile !== "function") { saved.push(...paths); finish(); return; }
    let completed = 0;
    paths.forEach((tempFilePath, index) => wx.saveFile({
      tempFilePath,
      success: (result) => { saved[index] = result.savedFilePath; },
      fail: () => { saved[index] = tempFilePath; },
      complete: () => { completed += 1; if (completed === paths.length) finish(); },
    }));
  },

  openQuestionPicker() {
    const questionOptions = loadAssets()
      .filter((asset) => asset.type === "question")
      .map((asset) => ({
        ...asset,
        displayTitle: asset.stem || asset.title || "未命名题目",
        displayPath: [asset.subjectName, asset.bookTitle, asset.chapterTitle, asset.sectionTitle].filter(Boolean).join(" / ") || "暂未归入目录",
      }));
    this.setData({ toolPanel: "", questionPickerOpen: true, questionOptions });
  },

  closeQuestionPicker() { this.setData({ questionPickerOpen: false }); },

  insertQuestionReference(event) {
    const question = this.data.questionOptions.find((item) => item.id === event.currentTarget.dataset.id);
    if (!question) return;
    const exists = this.data.questionRefs.some((item) => item.id === question.id);
    if (!exists) {
      this.setData({
        questionRefs: [...this.data.questionRefs, {
          id: question.id,
          title: question.displayTitle,
          subjectId: question.subjectId || "",
          subjectName: question.subjectName || "",
          bookId: question.bookId || "",
          bookTitle: question.bookTitle || "",
          chapterId: question.chapterId || "",
          chapterTitle: question.chapterTitle || "",
          sectionId: question.sectionId || "",
          sectionTitle: question.sectionTitle || "",
          knowledgePoints: question.knowledgePoints || [],
          tags: question.tags || [],
        }],
      });
    }
    if (this.editorCtx) this.editorCtx.insertText({ text: `\n【引用题目】${question.displayTitle}\n` });
    this.setData({ questionPickerOpen: false });
  },

  toggleMoreMenu() { this.setData({ moreMenuOpen: !this.data.moreMenuOpen, toolPanel: "" }); },

  clearFormatting() {
    if (this.editorCtx) this.editorCtx.removeFormat();
    this.setData({ moreMenuOpen: false });
  },

  getContents(callback) {
    if (!this.editorCtx || typeof this.editorCtx.getContents !== "function") {
      callback({ html: this.data.contentHtml, text: this.data.contentText });
      return;
    }
    this.editorCtx.getContents({
      success: (result) => callback({ html: result.html || "", text: result.text || "" }),
      fail: () => callback({ html: this.data.contentHtml, text: this.data.contentText }),
    });
  },

  persistDraft(contents, stage = "editor") {
    let draft = normalizeDraft({
      id: this.data.draftId,
      noteId: this.data.noteId,
      title: this.data.title,
      contentHtml: contents && contents.html !== undefined ? contents.html : this.data.contentHtml,
      contentText: contents && contents.text !== undefined ? contents.text : this.data.contentText,
      images: this.data.images,
      questionRefs: this.data.questionRefs,
      stage,
      updatedAt: Date.now(),
    });
    const hasContent = String(draft.title || "").trim() || String(draft.contentText || "").trim();
    if (hasContent) {
      const existing = draft.noteId ? loadAssets().find((item) => item.id === draft.noteId && item.type === "note") : null;
      if (!existing) {
        const asset = saveAsset({
          type: "note",
          title: String(draft.title || "").trim() || "未命名笔记",
          content: draft.contentText,
          contentHtml: draft.contentHtml,
          excerpt: String(draft.contentText || "").trim().slice(0, 100),
          images: draft.images,
          questionRefs: draft.questionRefs,
          originality: "original",
          ownership: "created",
          visibility: "private",
          moderationStatus: "draft",
          draftId: draft.id,
          draftStage: stage,
        });
        draft = normalizeDraft({ ...draft, noteId: asset.id });
      } else if (existing.moderationStatus === "draft") {
        saveAsset({
          ...existing,
          title: String(draft.title || "").trim() || "未命名笔记",
          content: draft.contentText,
          contentHtml: draft.contentHtml,
          excerpt: String(draft.contentText || "").trim().slice(0, 100),
          images: draft.images,
          questionRefs: draft.questionRefs,
          draftId: draft.id,
          draftStage: stage,
        });
      } else {
        updateAsset(existing.id, { draftId: draft.id, draftStage: stage });
      }
    }
    saveNoteDraft(draft);
    this.data.noteId = draft.noteId;
    this.data.draftStage = stage;
    return draft;
  },

  saveDraftManually() {
    this.getContents((contents) => {
      this.persistDraft(contents);
      this.setData({ moreMenuOpen: false, contentHtml: contents.html, contentText: contents.text });
      wx.showToast({ title: "草稿已保存", icon: "none" });
    });
  },

  openPreview() {
    this.getContents((contents) => this.setData({
      moreMenuOpen: false,
      previewOpen: true,
      contentHtml: contents.html,
      contentText: contents.text,
    }));
  },

  closePreview() { this.setData({ previewOpen: false }); },

  completeEditing() {
    this.getContents((contents) => {
      const title = String(this.data.title || "").trim();
      const text = String(contents.text || "").trim();
      if (!title) { wx.showToast({ title: "请填写笔记标题", icon: "none" }); return; }
      if (!text) { wx.showToast({ title: "请填写笔记内容", icon: "none" }); return; }
      const draft = this.persistDraft(contents, "metadata");
      this.setData({ previewOpen: false, contentHtml: contents.html, contentText: contents.text });
      wx.navigateTo({ url: `/pages/note-meta/note-meta?draftId=${encodeURIComponent(draft.id)}` });
    });
  },

  discardDraft() {
    this.setData({ moreMenuOpen: false });
    wx.showModal({
      title: "放弃编辑",
      content: "当前笔记草稿将被删除。",
      confirmColor: "#a24b43",
      success: (result) => {
        if (!result.confirm) return;
        this._discarded = true;
        const asset = this.data.noteId ? loadAssets().find((item) => item.id === this.data.noteId && item.type === "note") : null;
        if (asset && asset.moderationStatus === "draft") deleteAsset(asset.id);
        else if (asset) updateAsset(asset.id, { draftId: "", draftStage: "" });
        removeNoteDraft(this.data.draftId);
        wx.navigateBack();
      },
    });
  },

  goBack() {
    this.getContents((contents) => {
      this.persistDraft(contents);
      wx.navigateBack();
    });
  },
});

module.exports = { COMPLETED_PREFIX, DRAFT_PREFIX, createDraftId, normalizeDraft };
