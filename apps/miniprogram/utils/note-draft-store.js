const DRAFT_PREFIX = "shukao_note_draft_";
const COMPLETED_PREFIX = "shukao_note_draft_completed_";

function createDraftId() {
  return `note-draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeDraft(draft = {}) {
  return {
    id: draft.id || createDraftId(),
    noteId: draft.noteId || "",
    title: draft.title || "",
    contentHtml: draft.contentHtml || "",
    contentText: draft.contentText || draft.content || "",
    images: Array.isArray(draft.images) ? draft.images : [],
    questionRefs: Array.isArray(draft.questionRefs) ? draft.questionRefs : [],
    metadata: draft.metadata && typeof draft.metadata === "object" ? draft.metadata : null,
    stage: draft.stage === "metadata" ? "metadata" : "editor",
    editorVersion: 2,
    updatedAt: Number(draft.updatedAt) || Date.now(),
  };
}

function loadNoteDraft(id, storage = wx) {
  return id ? storage.getStorageSync(`${DRAFT_PREFIX}${id}`) || null : null;
}

function saveNoteDraft(draft, storage = wx) {
  const normalized = normalizeDraft(draft);
  storage.setStorageSync(`${DRAFT_PREFIX}${normalized.id}`, normalized);
  return normalized;
}

function removeNoteDraft(id, storage = wx) {
  if (!id) return;
  storage.removeStorageSync(`${DRAFT_PREFIX}${id}`);
  storage.removeStorageSync(`${COMPLETED_PREFIX}${id}`);
}

module.exports = {
  COMPLETED_PREFIX,
  DRAFT_PREFIX,
  createDraftId,
  loadNoteDraft,
  normalizeDraft,
  removeNoteDraft,
  saveNoteDraft,
};
