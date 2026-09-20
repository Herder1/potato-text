const STORAGE_KEY = "shukao_user_assets";
const MIGRATION_KEY = "shukao_assets_migrated_v1";

const statusLabels = {
  draft: "草稿",
  private: "私密",
  pending_review: "待初筛",
  published: "已公开",
  rejected: "未通过",
  offline: "已下架",
};

const typeLabels = {
  question: "题目",
  note: "笔记",
  card_pack: "卡片集",
  question_pack: "题包",
};

function normalizeAsset(asset = {}) {
  const visibility = asset.visibility === "public" ? "public" : "private";
  const moderationStatus = asset.moderationStatus
    || (visibility === "public" ? "pending_review" : "private");
  return {
    ...asset,
    visibility,
    moderationStatus,
    typeLabel: typeLabels[asset.type] || "内容",
    statusLabel: statusLabels[moderationStatus] || "处理中",
    tags: Array.isArray(asset.tags) ? asset.tags : [],
    knowledgePoints: Array.isArray(asset.knowledgePoints) ? asset.knowledgePoints : [],
    createdAt: Number(asset.createdAt) || Date.now(),
    updatedAt: Number(asset.updatedAt) || Number(asset.createdAt) || Date.now(),
  };
}

function loadAssets(storage = wx) {
  let assets = storage.getStorageSync(STORAGE_KEY);
  assets = Array.isArray(assets) ? assets : [];
  if (!storage.getStorageSync(MIGRATION_KEY)) {
    const knownIds = new Set(assets.map((asset) => asset.id));
    // DEC-056：题目笔记已改为知识卡里的笔记卡，不再有 shukao_notes 这套存储，
    // 因此这里不再迁移笔记；历史私有题目的迁移保持不变。
    const legacyQuestions = storage.getStorageSync("shukao_private_questions");
    (Array.isArray(legacyQuestions) ? legacyQuestions : []).forEach((question) => {
      if (knownIds.has(question.id)) return;
      assets.push(normalizeAsset({
        ...question,
        type: "question",
        title: question.title || String(question.stem || "未命名题目").slice(0, 42),
        originality: question.originality || "collected",
        visibility: question.visibility || "private",
        ownership: "created",
      }));
    });
    storage.setStorageSync(STORAGE_KEY, assets);
    storage.setStorageSync(MIGRATION_KEY, true);
  }
  return assets.map(normalizeAsset);
}

function privatePackToAsset(pack = {}) {
  return normalizeAsset({
    id: pack.id,
    packId: pack.id,
    type: "question_pack",
    title: pack.name || "未命名题包",
    excerpt: pack.description || `共 ${(pack.questionIds || []).length} 道题`,
    content: pack.description || "",
    tags: pack.tags || [],
    originality: pack.source === "community_import" ? "collected" : "original",
    ownership: pack.source === "community_import" ? "collected" : "created",
    visibility: pack.visibility || "private",
    moderationStatus: pack.status || (pack.visibility === "public" ? "pending_review" : "private"),
    questionCount: (pack.questionIds || []).length,
    sourceLabel: pack.sourceLabel || (pack.source === "community_import" ? "社区导入" : "我创建的"),
    categoryId: pack.categoryId || "",
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
  });
}

function loadManagedAssets(storage = wx) {
  const { loadPrivatePacks } = require("./private-pack-store");
  return [...loadAssets(storage), ...loadPrivatePacks(storage).map(privatePackToAsset)]
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function saveAsset(asset, storage = wx) {
  const now = Date.now();
  const normalized = normalizeAsset({
    ...asset,
    id: asset.id || `asset-${asset.type || "content"}-${now}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: asset.createdAt || now,
    updatedAt: now,
  });
  const assets = loadAssets(storage);
  const index = assets.findIndex((item) => item.id === normalized.id);
  if (index >= 0) assets[index] = normalized;
  else assets.unshift(normalized);
  storage.setStorageSync(STORAGE_KEY, assets.slice(0, 500));
  return normalized;
}

function updateAsset(id, patch, storage = wx) {
  const asset = loadAssets(storage).find((item) => item.id === id);
  if (!asset) return null;
  return saveAsset({ ...asset, ...patch, id }, storage);
}

function deleteAsset(id, storage = wx) {
  const assets = loadAssets(storage).filter((item) => item.id !== id);
  storage.setStorageSync(STORAGE_KEY, assets);
  return assets;
}

function releaseAssetsFromPack(packId, storage = wx) {
  const assets = loadAssets(storage).map((asset) => asset.packId === packId
    ? normalizeAsset({ ...asset, packId: "", updatedAt: Date.now() })
    : asset);
  storage.setStorageSync(STORAGE_KEY, assets);
  return assets;
}

function collectAsset(sourceAsset, storage = wx) {
  const existing = loadAssets(storage).find((asset) => asset.sourceAssetId === sourceAsset.id);
  if (existing) return existing;
  return saveAsset({
    ...sourceAsset,
    id: `asset-collected-${Date.now()}`,
    sourceAssetId: sourceAsset.id,
    ownership: "collected",
    originality: "collected",
    visibility: "private",
    moderationStatus: "private",
    title: sourceAsset.title,
  }, storage);
}

function assetStats(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return {
    total: list.length,
    questions: list.filter((asset) => asset.type === "question").length,
    notes: list.filter((asset) => asset.type === "note").length,
    packs: list.filter((asset) => asset.type === "question_pack").length,
    publicCount: list.filter((asset) => asset.moderationStatus === "published").length,
    pendingCount: list.filter((asset) => asset.moderationStatus === "pending_review").length,
    collected: list.filter((asset) => asset.ownership === "collected").length,
  };
}

function syncPublicAsset(asset, callback = () => {}) {
  if (!asset || asset.visibility !== "public" || typeof wx === "undefined" || typeof wx.request !== "function" || typeof getApp !== "function") {
    callback(asset, false);
    return;
  }
  const app = getApp();
  const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
  if (!baseUrl) { callback(asset, false); return; }
  wx.request({
    url: `${baseUrl}/api/community/assets`,
    method: "POST",
    timeout: 8000,
    header: typeof app.authHeader === "function" ? app.authHeader() : {},
    data: { ...asset, contributor: app.globalData.user && app.globalData.user.nickname || "薯考同学" },
    success: (response) => {
      const remote = response.statusCode === 201 && response.data && response.data.asset;
      if (!remote) {
        // 被限制公开/禁止投稿/封禁时，把服务端给的原因直接告诉用户，而不是静默失败。
        const notice = response.data && response.data.restriction && response.data.restriction.message;
        if (notice && typeof wx.showModal === "function") {
          wx.showModal({ title: "暂时无法公开分享", content: String(notice), showCancel: false });
        }
        callback(asset, false);
        return;
      }
      const synced = updateAsset(asset.id, {
        remoteId: remote.id,
        moderationStatus: remote.moderationStatus,
        visibility: remote.visibility,
      });
      callback(synced, true);
    },
    fail: () => callback(asset, false),
  });
}

module.exports = {
  STORAGE_KEY,
  assetStats,
  collectAsset,
  deleteAsset,
  loadAssets,
  loadManagedAssets,
  normalizeAsset,
  privatePackToAsset,
  releaseAssetsFromPack,
  saveAsset,
  statusLabels,
  syncPublicAsset,
  typeLabels,
  updateAsset,
};
