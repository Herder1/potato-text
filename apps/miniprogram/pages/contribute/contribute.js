const { subjects } = require("../../data/catalog");
const { createCatalogSelection } = require("../../utils/asset-catalog");
const { loadAssets, saveAsset, syncPublicAsset } = require("../../utils/asset-store");
const { addQuestionToPack, attachQuestionToCard, getPrivatePack } = require("../../utils/private-pack-store");

const questionTypes = ["单选题", "多选题", "断句题", "加点字词解释", "古文翻译", "简答题", "材料分析题", "作品赏析题", "论述题", "判断题", "填空题", "名词解释"];
const originalityOptions = [
  { id: "original", label: "原创", note: "由我独立整理" },
  { id: "adapted", label: "改编整理", note: "基于教材或资料改写" },
  { id: "collected", label: "转载收录", note: "保留原始来源" },
];

Page({
  data: {
    packId: "",
    packName: "",
    cardId: "",
    questionId: "",
    editingAsset: null,
    methods: ["手动填写", "图片 OCR"],
    activeMethod: "手动填写",
    subjects,
    subjectIndex: 0,
    books: [],
    bookIndex: 0,
    chapters: [],
    catalogReady: false,
    chapterIndex: 0,
    sections: [],
    sectionIndex: 0,
    knowledgePointOptions: [],
    selectedKnowledgePoints: [],
    customTags: [],
    tagDraft: "",
    types: questionTypes,
    typeIndex: 0,
    originalityOptions,
    originality: "original",
    originalConfirmed: false,
    visibility: "private",
    imagePath: "",
    stem: "",
    optionsText: "",
    referenceAnswer: "",
    scoringPointsText: "",
    sourceReference: "",
    ocrStatus: "",
  },

  onLoad(options = {}) {
    const packId = decodeURIComponent(options.packId || "");
    const cardId = decodeURIComponent(options.cardId || "");
    const questionId = decodeURIComponent(options.questionId || "");
    const pack = packId ? getPrivatePack(packId) : null;
    if (packId && !pack) {
      wx.showToast({ title: "请先选择有效题包", icon: "none" });
      wx.navigateBack();
      return;
    }
    const editingAsset = questionId ? loadAssets().find((asset) => asset.id === questionId && asset.type === "question") : null;
    this.setData({ packId, packName: pack ? pack.name : "", cardId, questionId, editingAsset: editingAsset || null });
    this.applyCatalogSelection(0, 0);
    if (editingAsset) this.restoreAssetDraft(editingAsset);
    else this.refreshBookCatalog();
  },

  restoreAssetDraft(asset) {
    const subjectIndex = Math.max(0, this.data.subjects.findIndex((subject) => subject.id === asset.subjectId));
    this.applyCatalogSelection(subjectIndex, 0);
    const bookIndex = Math.max(0, this.data.books.findIndex((book) => book.id === asset.bookId));
    this.applyCatalogSelection(subjectIndex, bookIndex);
    const chapterIndex = Math.max(0, this.data.chapters.findIndex((chapter) => chapter.id === asset.chapterId));
    const chapter = this.data.chapters[chapterIndex];
    const sections = chapter ? chapter.sections : [];
    const sectionIndex = Math.max(0, sections.findIndex((section) => section.id === asset.sectionId));
    const knowledgePointOptions = this.knowledgePointsFor(chapter, sections[sectionIndex]).map((item) => ({
      ...item,
      selected: (asset.knowledgePoints || []).includes(item.label),
    }));
    this.setData({
      chapterIndex,
      sections,
      sectionIndex,
      knowledgePointOptions,
      selectedKnowledgePoints: asset.knowledgePoints || [],
      customTags: asset.tags || [],
      typeIndex: Math.max(0, this.data.types.indexOf(asset.questionType)),
      originality: asset.originality || "original",
      originalConfirmed: asset.originality === "original",
      visibility: asset.visibility === "public" ? "public" : "private",
      imagePath: asset.imagePath || "",
      stem: asset.stem || "",
      optionsText: asset.optionsText || "",
      referenceAnswer: asset.referenceAnswer || "",
      scoringPointsText: asset.scoringPointsText || "",
      sourceReference: asset.sourceReference || "",
    });
  },

  applyCatalogSelection(subjectIndex, bookIndex) {
    const selection = createCatalogSelection(subjectIndex, bookIndex);
    const chapters = selection.chapters;
    const sections = chapters[0] ? chapters[0].sections : [];
    const knowledgePointOptions = this.knowledgePointsFor(chapters[0], sections[0]);
    this.setData({
      subjectIndex,
      books: selection.books,
      bookIndex,
      chapters,
      // DEC-057：目录只来自已确认教材目录，没同步过时整段为空，页面据此提示先同步。
      catalogReady: selection.catalogReady === true,
      chapterIndex: 0,
      sections,
      sectionIndex: 0,
      knowledgePointOptions,
      selectedKnowledgePoints: [],
    });
  },

  knowledgePointsFor(chapter, section) {
    return [...new Set([section && section.title, ...(chapter && chapter.knowledgePoints || []), ...(section && section.knowledgePoints || [])])]
      .filter(Boolean)
      .map((label) => ({ label, selected: false }));
  },

  switchMethod(event) { this.setData({ activeMethod: event.currentTarget.dataset.method }); },

  chooseSubject(event) {
    this.applyCatalogSelection(Number(event.detail.value), 0);
    this.refreshBookCatalog();
  },

  chooseBook(event) {
    this.applyCatalogSelection(this.data.subjectIndex, Number(event.detail.value));
    this.refreshBookCatalog();
  },

  chooseChapter(event) {
    const chapterIndex = Number(event.detail.value);
    const chapter = this.data.chapters[chapterIndex];
    const sections = chapter ? chapter.sections : [];
    this.setData({
      chapterIndex,
      sections,
      sectionIndex: 0,
      knowledgePointOptions: this.knowledgePointsFor(chapter, sections[0]),
      selectedKnowledgePoints: [],
    });
  },

  chooseSection(event) {
    const sectionIndex = Number(event.detail.value);
    const chapter = this.data.chapters[this.data.chapterIndex];
    const section = this.data.sections[sectionIndex];
    this.setData({ sectionIndex, knowledgePointOptions: this.knowledgePointsFor(chapter, section), selectedKnowledgePoints: [] });
  },

  refreshBookCatalog() {
    const book = this.data.books[this.data.bookIndex];
    if (!book || typeof wx.request !== "function" || typeof getApp !== "function") return;
    const baseUrl = String(getApp().globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) return;
    wx.request({
      url: `${baseUrl}/api/catalog/textbooks/${encodeURIComponent(book.id)}`,
      timeout: 6000,
      success: (response) => {
        const textbook = response.statusCode === 200 && response.data && response.data.textbook;
        if (!textbook || !Array.isArray(textbook.nodes)) return;
        wx.setStorageSync(`shukao_confirmed_catalog_${book.id}`, textbook);
        this.applyCatalogSelection(this.data.subjectIndex, this.data.bookIndex);
      },
    });
  },

  toggleKnowledgePoint(event) {
    const value = event.currentTarget.dataset.value;
    const selected = this.data.selectedKnowledgePoints.includes(value)
      ? this.data.selectedKnowledgePoints.filter((item) => item !== value)
      : [...this.data.selectedKnowledgePoints, value];
    this.setData({
      selectedKnowledgePoints: selected,
      knowledgePointOptions: this.data.knowledgePointOptions.map((item) => ({ ...item, selected: selected.includes(item.label) })),
    });
  },

  updateTagDraft(event) { this.setData({ tagDraft: event.detail.value }); },
  addTag() {
    const tag = String(this.data.tagDraft || "").trim().replace(/^#/, "").slice(0, 16);
    if (!tag || this.data.customTags.includes(tag)) return;
    this.setData({ customTags: [...this.data.customTags, tag].slice(0, 8), tagDraft: "" });
  },
  removeTag(event) { this.setData({ customTags: this.data.customTags.filter((tag) => tag !== event.currentTarget.dataset.value) }); },

  chooseType(event) { this.setData({ typeIndex: Number(event.detail.value) }); },
  selectOriginality(event) { this.setData({ originality: event.currentTarget.dataset.value, originalConfirmed: false }); },
  confirmOriginal(event) { this.setData({ originalConfirmed: event.detail.value.length > 0 }); },
  selectVisibility(event) { this.setData({ visibility: event.currentTarget.dataset.value }); },
  updateStem(event) { this.setData({ stem: event.detail.value }); },
  updateOptions(event) { this.setData({ optionsText: event.detail.value }); },
  updateReferenceAnswer(event) { this.setData({ referenceAnswer: event.detail.value }); },
  updateScoringPoints(event) { this.setData({ scoringPointsText: event.detail.value }); },
  updateSourceReference(event) { this.setData({ sourceReference: event.detail.value }); },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const tempFilePath = result.tempFiles[0].tempFilePath;
        this.setData({ imagePath: tempFilePath, ocrStatus: "正在识别演示图片…" });
        if (typeof wx.saveFile === "function") {
          wx.saveFile({ tempFilePath, success: (saved) => this.setData({ imagePath: saved.savedFilePath }) });
        }
        setTimeout(() => this.setData({ ocrStatus: "识别完成，请检查并修改", stem: this.data.stem || "图片中的题干将在接入 OCR 服务后显示在这里。" }), 600);
      },
    });
  },

  saveQuestion() {
    const stem = String(this.data.stem || "").trim();
    if (!stem) { wx.showToast({ title: "请填写题干", icon: "none" }); return; }
    if (this.data.originality === "original" && !this.data.originalConfirmed) {
      wx.showToast({ title: "请确认原创声明", icon: "none" }); return;
    }
    if (this.data.originality !== "original" && !String(this.data.sourceReference || "").trim()) {
      wx.showToast({ title: "请填写资料来源", icon: "none" }); return;
    }
    const subject = this.data.subjects[this.data.subjectIndex];
    const book = this.data.books[this.data.bookIndex];
    const chapter = this.data.chapters[this.data.chapterIndex];
    const section = this.data.sections[this.data.sectionIndex];
    const asset = saveAsset({
      ...(this.data.editingAsset || {}),
      type: "question",
      title: stem.slice(0, 42),
      stem,
      questionType: this.data.types[this.data.typeIndex],
      optionsText: this.data.optionsText.trim(),
      referenceAnswer: this.data.referenceAnswer.trim(),
      scoringPointsText: this.data.scoringPointsText.trim(),
      sourceReference: this.data.sourceReference.trim(),
      originality: this.data.originality,
      visibility: this.data.visibility,
      subjectId: subject.id,
      subjectName: subject.name,
      bookId: book && book.id,
      bookTitle: book && `${book.title}${book.volume ? ` ${book.volume}` : ""}`,
      chapterId: chapter && chapter.id,
      chapterTitle: chapter && chapter.title,
      sectionId: section && section.id,
      sectionTitle: section && section.title,
      knowledgePoints: this.data.selectedKnowledgePoints,
      tags: this.data.customTags,
      imagePath: this.data.imagePath,
      ownership: "created",
      packId: this.data.packId,
    });
    if (this.data.packId && this.data.cardId) attachQuestionToCard(this.data.packId, this.data.cardId, asset.id);
    else if (this.data.packId) addQuestionToPack(this.data.packId, asset.id);
    const privateQuestions = wx.getStorageSync("shukao_private_questions") || [];
    const legacyQuestion = { ...asset, id: asset.id, status: asset.moderationStatus };
    const existingIndex = privateQuestions.findIndex((question) => question.id === asset.id);
    if (existingIndex >= 0) privateQuestions[existingIndex] = legacyQuestion;
    else privateQuestions.unshift(legacyQuestion);
    wx.setStorageSync("shukao_private_questions", privateQuestions.slice(0, 300));
    const finish = (savedAsset) => wx.showModal({
      title: this.data.editingAsset ? "题目已更新" : savedAsset.visibility === "public"
        ? (savedAsset.moderationStatus === "published" ? "已通过初筛并公开" : "已提交公共初筛")
        : "已保存为私密题目",
      content: this.data.packId
        ? `题目已加入“${this.data.packName}”，返回后可继续录入或开始刷题。`
        : (savedAsset.visibility === "public"
          ? (savedAsset.moderationStatus === "published" ? "题目已进入知识库社区，可被其他用户收藏或复制。" : "审核期间仍可在我的资产中查看状态和管理。")
          : "只有你可以查看和使用，可随时在我的资产中申请公开。"),
      showCancel: false,
      success: () => wx.navigateBack(),
    });
    if (asset.visibility === "public") syncPublicAsset(asset, (synced) => finish(synced || asset));
    else finish(asset);
  },
});
