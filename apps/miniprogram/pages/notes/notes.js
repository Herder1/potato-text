const { deleteAsset, loadAssets, saveAsset } = require("../../utils/asset-store");
const { removeNoteDraft } = require("../../utils/note-draft-store");

Page({
  data: {
    notes: [],
    visibleNotes: [],
    query: "",
  },

  onShow() {
    // DEC-056：题目笔记已改为知识卡里的笔记卡，这里只列"我的资产"里的笔记。
    const notes = loadAssets()
      .filter((item) => item.type === "note")
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((note) => ({
        ...note,
        source: note.moderationStatus === "draft" ? "自动保存 · 待完善" : (note.sourceReference || "手动记录"),
        draftLabel: note.moderationStatus === "draft" ? "草稿" : (note.draftId ? "编辑未完成" : ""),
      }));
    this.setData({ notes, visibleNotes: notes });
  },

  search(event) {
    const query = event.detail.value.trim();
    const visibleNotes = this.data.notes.filter((note) => `${note.title}${note.content}${note.source || ""}`.includes(query));
    this.setData({ query, visibleNotes });
  },

  createNote() {
    wx.navigateTo({ url: "/pages/note-editor/note-editor" });
  },

  editNote(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    const note = this.data.notes.find((item) => item.id === id);
    if (note && note.draftId) {
      const page = note.draftStage === "metadata" ? "note-meta/note-meta" : "note-editor/note-editor";
      wx.navigateTo({ url: `/pages/${page}?draftId=${encodeURIComponent(note.draftId)}` });
      return;
    }
    wx.navigateTo({ url: `/pages/note-editor/note-editor?noteId=${encodeURIComponent(id)}` });
  },

  deleteNote(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: "删除笔记",
      content: "删除后不可恢复。",
      success: (result) => {
        if (!result.confirm) return;
        const deleting = this.data.notes.find((note) => note.id === id);
        if (deleting && deleting.draftId) removeNoteDraft(deleting.draftId);
        const notes = this.data.notes.filter((note) => note.id !== id);
        deleteAsset(id);
        this.setData({ notes, visibleNotes: notes });
      },
    });
  },
});
