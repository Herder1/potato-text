const { subjects } = require("../../data/catalog");
const { createCatalogSelection } = require("../../utils/asset-catalog");
const { cleanLabel, normalizeCatalogResolved, recommendNoteCatalog } = require("../../utils/note-catalog-recommender");
const { loadAssets, saveAsset, syncPublicAsset, updateAsset } = require("../../utils/asset-store");
const { COMPLETED_PREFIX, loadNoteDraft, removeNoteDraft, saveNoteDraft } = require("../../utils/note-draft-store");

function cleanCatalogLabel(value) {
  return cleanLabel(value);
}

function matchIndex(items, text, id = "") {
  if (id) {
    const exact = items.findIndex((item) => item.id === id);
    if (exact >= 0) return exact;
  }
  let bestIndex = 0;
  let bestScore = 0;
  items.forEach((item, index) => {
    const label = cleanCatalogLabel(item.title || item.name);
    const score = label && text.includes(label) ? label.length : 0;
    if (score > bestScore) { bestIndex = index; bestScore = score; }
  });
  return bestIndex;
}

Page({
  data: {
    draftId: "",
    draft: null,
    subjects,
    subjectIndex: 0,
    books: [],
    bookIndex: 0,
    chapters: [],
    chapterIndex: 0,
    sections: [],
    sectionIndex: 0,
    catalogResolved: { subject: false, book: false, chapter: false, section: false },
    recommendationLevel: "待确认",
    recommendationReason: "根据标题和正文匹配教材目录",
    recommendedTags: [],
    tags: [],
    tagDraft: "",
    learningTargets: [
      { id: "knowledge", label: "知识整理", selected: true },
      { id: "mistake", label: "错题总结", selected: false },
      { id: "recite", label: "背诵", selected: false },
      { id: "review", label: "复习提示", selected: false },
    ],
    originality: "original",
    originalConfirmed: false,
    sourceReference: "",
    visibility: "private",
    saving: false,
  },

  onLoad(options = {}) {
    const draftId = decodeURIComponent(options.draftId || "");
    const draft = loadNoteDraft(draftId);
    if (!draft) {
      wx.showToast({ title: "笔记草稿不存在", icon: "none" });
      wx.navigateBack();
      return;
    }
    const existing = draft.noteId ? loadAssets().find((item) => item.id === draft.noteId && item.type === "note") : null;
    const metadata = draft.metadata || null;
    const storedTargetIds = metadata && metadata.learningTargets || existing && existing.learningTargets;
    const learningTargets = Array.isArray(storedTargetIds)
      ? this.data.learningTargets.map((item) => ({ ...item, selected: storedTargetIds.includes(item.id) }))
      : this.data.learningTargets;
    this.setData({
      draftId,
      draft,
      learningTargets,
      originality: metadata && metadata.originality || existing && existing.originality || "original",
      originalConfirmed: metadata ? metadata.originalConfirmed === true : !!(existing && existing.originality === "original"),
      sourceReference: metadata && metadata.sourceReference || existing && existing.sourceReference || "",
      visibility: (metadata && metadata.visibility || existing && existing.visibility) === "public" ? "public" : "private",
    });
    const catalogSource = metadata
      ? { ...metadata, tags: metadata.tags || [] }
      : (existing && existing.moderationStatus !== "draft" ? existing : null);
    this.buildRecommendations(catalogSource);
    if (metadata) this.restoreMetadata(metadata);
  },

  onHide() { this.persistMetadataDraft(); },
  onUnload() { this.persistMetadataDraft(); },

  restoreMetadata(metadata) {
    const subjectIndex = Math.max(0, subjects.findIndex((item) => item.id === metadata.subjectId));
    const subject = subjects[subjectIndex] || subjects[0];
    const bookIndex = Math.max(0, (subject.books || []).findIndex((item) => item.id === metadata.bookId));
    const selection = createCatalogSelection(subjectIndex, bookIndex);
    const chapterIndex = Math.max(0, (selection.chapters || []).findIndex((item) => item.id === metadata.chapterId));
    const chapter = selection.chapters[chapterIndex] || selection.chapters[0];
    const sections = chapter && chapter.sections || [];
    const sectionIndex = Math.max(0, sections.findIndex((item) => item.id === metadata.sectionId));
    this.setData({
      subjectIndex,
      books: selection.books,
      bookIndex,
      chapters: selection.chapters,
      chapterIndex,
      sections,
      sectionIndex,
      catalogResolved: normalizeCatalogResolved(metadata.catalogResolved || this.data.catalogResolved),
      tags: Array.isArray(metadata.tags) ? metadata.tags : this.data.tags,
      recommendationLevel: "草稿",
      recommendationReason: "已恢复上次未完成的目录与标签",
    });
  },

  metadataSnapshot() {
    const resolved = normalizeCatalogResolved(this.data.catalogResolved);
    const subject = resolved.subject && this.data.subjects[this.data.subjectIndex];
    const book = resolved.book && this.data.books[this.data.bookIndex];
    const chapter = resolved.chapter && this.data.chapters[this.data.chapterIndex];
    const section = resolved.section && this.data.sections[this.data.sectionIndex];
    return {
      catalogResolved: resolved,
      subjectId: subject && subject.id || "",
      bookId: book && book.id || "",
      chapterId: chapter && chapter.id || "",
      sectionId: section && section.id || "",
      tags: this.data.tags,
      learningTargets: this.data.learningTargets.filter((item) => item.selected).map((item) => item.id),
      originality: this.data.originality,
      originalConfirmed: this.data.originalConfirmed,
      sourceReference: this.data.sourceReference,
      visibility: this.data.visibility,
    };
  },

  persistMetadataDraft() {
    if (this._completed || !this.data.draft) return;
    const metadata = this.metadataSnapshot();
    const draft = saveNoteDraft({ ...this.data.draft, metadata, stage: "metadata", updatedAt: Date.now() });
    this.data.draft = draft;
    const asset = draft.noteId ? loadAssets().find((item) => item.id === draft.noteId && item.type === "note") : null;
    if (!asset) return;
    if (asset.moderationStatus === "draft") {
      updateAsset(asset.id, {
        draftId: draft.id,
        draftStage: "metadata",
        tags: metadata.tags,
        learningTargets: metadata.learningTargets,
        subjectId: metadata.subjectId,
        bookId: metadata.bookId,
        chapterId: metadata.chapterId,
        sectionId: metadata.sectionId,
      });
    } else updateAsset(asset.id, { draftId: draft.id, draftStage: "metadata" });
  },

  setMetadataData(patch) {
    this.setData(patch, () => this.persistMetadataDraft());
  },

  buildRecommendations(existing) {
    const draft = this.data.draft;
    const text = `${draft.title || ""} ${draft.contentText || ""}`;
    const reference = (draft.questionRefs || [])[0] || {};
    const forced = {
      subjectId: existing && existing.subjectId || reference.subjectId || "",
      bookId: existing && existing.bookId || reference.bookId || "",
      chapterId: existing && existing.chapterId || reference.chapterId || "",
      sectionId: existing && existing.sectionId || reference.sectionId || "",
    };
    const recommendation = recommendNoteCatalog(text, forced) || {
      subjectIndex: 0,
      bookIndex: 0,
      chapterIndex: 0,
      sectionIndex: 0,
      resolved: { subject: false, book: false, chapter: false, section: false },
      usefulMatches: [],
    };
    const subjectIndex = Math.max(0, recommendation.subjectIndex);
    const subject = subjects[subjectIndex] || subjects[0];
    const bookIndex = Math.max(0, recommendation.bookIndex);
    const selection = createCatalogSelection(subjectIndex, bookIndex);
    const chapterIndex = Math.max(0, recommendation.chapterIndex);
    const chapter = selection.chapters[chapterIndex] || selection.chapters[0];
    const sections = chapter && chapter.sections || [];
    const sectionIndex = Math.max(0, recommendation.sectionIndex);
    const section = sections[sectionIndex];
    const inheritedTags = (draft.questionRefs || []).flatMap((item) => [...(item.knowledgePoints || []), ...(item.tags || [])]);
    const catalogTags = [
      recommendation.resolved.section && section && cleanCatalogLabel(section.title),
      recommendation.resolved.chapter && chapter && cleanCatalogLabel(chapter.title),
    ].filter(Boolean);
    const recommendedTags = [...new Set([...inheritedTags, ...(recommendation.usefulMatches || []), ...catalogTags])].slice(0, 6);
    const tags = existing && existing.tags && existing.tags.length ? existing.tags : recommendedTags.slice(0, 4);
    const hasReferencePath = !!(reference.subjectId || reference.bookId || reference.chapterId);
    const matchedTerms = (recommendation.usefulMatches || []).slice(0, 2);
    const recommendationLevel = existing
      ? "已沿用"
      : (hasReferencePath ? "高" : (recommendation.resolved.section ? "高" : (recommendation.resolved.chapter ? "中" : (recommendation.resolved.subject ? "仅科目" : "待确认"))));
    const recommendationReason = existing
      ? "沿用这条笔记原有的教材目录"
      : (hasReferencePath
        ? "已继承引用题目的教材目录"
        : (matchedTerms.length ? `已匹配正文中的“${matchedTerms.join("、")}”` : "未发现足够明确的目录依据，请手动选择"));
    this.setData({
      subjectIndex,
      books: selection.books,
      bookIndex,
      chapters: selection.chapters,
      chapterIndex,
      sections,
      sectionIndex,
      catalogResolved: recommendation.resolved,
      recommendedTags,
      tags,
      recommendationLevel,
      recommendationReason,
    });
  },

  applyCatalog(subjectIndex, bookIndex, catalogResolved) {
    const selection = createCatalogSelection(subjectIndex, bookIndex);
    const chapters = selection.chapters;
    const sections = chapters[0] && chapters[0].sections || [];
    this.setMetadataData({ subjectIndex, books: selection.books, bookIndex, chapters, chapterIndex: 0, sections, sectionIndex: 0, catalogResolved, recommendationLevel: "已修改" });
  },
  chooseSubject(event) { this.applyCatalog(Number(event.detail.value), 0, { subject: true, book: false, chapter: false, section: false }); },
  chooseBook(event) { this.applyCatalog(this.data.subjectIndex, Number(event.detail.value), { subject: true, book: true, chapter: false, section: false }); },
  chooseChapter(event) {
    const chapterIndex = Number(event.detail.value);
    this.setMetadataData({ chapterIndex, sections: this.data.chapters[chapterIndex].sections || [], sectionIndex: 0, catalogResolved: { subject: true, book: true, chapter: true, section: false }, recommendationLevel: "已修改" });
  },
  chooseSection(event) { this.setMetadataData({ sectionIndex: Number(event.detail.value), catalogResolved: { subject: true, book: true, chapter: true, section: true }, recommendationLevel: "已修改" }); },
  updateTagDraft(event) { this.setData({ tagDraft: event.detail.value }); },
  addTag() {
    const tag = String(this.data.tagDraft || "").trim().replace(/^#/, "").slice(0, 16);
    if (!tag || this.data.tags.includes(tag)) return;
    this.setMetadataData({ tags: [...this.data.tags, tag].slice(0, 8), tagDraft: "" });
  },
  addRecommendedTag(event) {
    const tag = event.currentTarget.dataset.value;
    if (!tag || this.data.tags.includes(tag)) return;
    this.setMetadataData({ tags: [...this.data.tags, tag].slice(0, 8) });
  },
  removeTag(event) { this.setMetadataData({ tags: this.data.tags.filter((tag) => tag !== event.currentTarget.dataset.value) }); },
  toggleLearningTarget(event) {
    const id = event.currentTarget.dataset.id;
    this.setMetadataData({ learningTargets: this.data.learningTargets.map((item) => item.id === id ? { ...item, selected: !item.selected } : item) });
  },
  selectOriginality(event) { this.setMetadataData({ originality: event.currentTarget.dataset.value, originalConfirmed: false }); },
  confirmOriginal(event) { this.setMetadataData({ originalConfirmed: event.detail.value.length > 0 }); },
  updateSource(event) { this.setMetadataData({ sourceReference: event.detail.value }); },
  selectVisibility(event) { this.setMetadataData({ visibility: event.currentTarget.dataset.value }); },

  saveNote() {
    if (this.data.saving) return;
    if (this.data.originality === "original" && !this.data.originalConfirmed) { wx.showToast({ title: "请确认原创声明", icon: "none" }); return; }
    if (this.data.originality !== "original" && !String(this.data.sourceReference || "").trim()) { wx.showToast({ title: "请填写内容来源", icon: "none" }); return; }
    const draft = this.data.draft;
    const existing = draft.noteId ? loadAssets().find((item) => item.id === draft.noteId && item.type === "note") : null;
    const subject = this.data.catalogResolved.subject ? this.data.subjects[this.data.subjectIndex] : null;
    const book = this.data.catalogResolved.book ? this.data.books[this.data.bookIndex] : null;
    const chapter = this.data.catalogResolved.chapter ? this.data.chapters[this.data.chapterIndex] : null;
    const section = this.data.catalogResolved.section ? this.data.sections[this.data.sectionIndex] : null;
    const moderationStatus = this.data.visibility === "public"
      ? (existing && existing.visibility === "public" && existing.moderationStatus === "published" ? "published" : "pending_review")
      : "private";
    this.setData({ saving: true });
    const asset = saveAsset({
      ...(existing || {}),
      id: existing && existing.id,
      type: "note",
      title: draft.title,
      content: draft.contentText,
      contentHtml: draft.contentHtml,
      excerpt: String(draft.contentText || "").trim().slice(0, 100),
      editorVersion: 2,
      questionRefs: draft.questionRefs || [],
      images: draft.images || [],
      learningTargets: this.data.learningTargets.filter((item) => item.selected).map((item) => item.id),
      sourceReference: String(this.data.sourceReference || "").trim(),
      originality: this.data.originality,
      visibility: this.data.visibility,
      moderationStatus,
      subjectId: subject && subject.id,
      subjectName: subject && subject.name,
      bookId: book && book.id,
      bookTitle: book && `${book.title}${book.volume ? ` ${book.volume}` : ""}`,
      chapterId: chapter && chapter.id,
      chapterTitle: chapter && chapter.title,
      sectionId: section && section.id,
      sectionTitle: section && section.title,
      tags: this.data.tags,
      ownership: existing && existing.ownership || "created",
      draftId: "",
      draftStage: "",
    });
    const finish = () => {
      this._completed = true;
      removeNoteDraft(this.data.draftId);
      wx.setStorageSync(`${COMPLETED_PREFIX}${this.data.draftId}`, true);
      this.setData({ saving: false });
      wx.showToast({ title: this.data.visibility === "public" ? "已提交初筛" : "笔记已保存", icon: "success" });
      setTimeout(() => wx.navigateBack({ delta: 2 }), 250);
    };
    if (asset.visibility === "public") syncPublicAsset(asset, finish);
    else finish();
  },
});

module.exports = { cleanCatalogLabel, matchIndex };
