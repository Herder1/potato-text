const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { communityAssets: seedAssets } = require("../../miniprogram/data/community-assets");

const allowedTypes = new Set(["question", "note", "card_pack"]);
const allowedStatuses = new Set(["pending_review", "published", "rejected", "offline"]);
const riskPattern = /(加微信|加群|返利|代考|出售答案|赌博|色情|违法|广告推广|二维码引流)/i;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function seedState() {
  const now = Date.now();
  return seedAssets.map((asset) => ({
    ...clone(asset),
    userId: "community-seed",
    visibility: "public",
    moderationStatus: "published",
    createdAt: now,
    updatedAt: now,
  }));
}

function validateSubmission(payload = {}) {
  const type = String(payload.type || "");
  if (!allowedTypes.has(type)) throw new Error("community_asset_type_invalid");
  const title = String(payload.title || "").trim();
  const content = String(payload.content || payload.stem || payload.excerpt || "").trim();
  if (!title || !content) throw new Error("community_asset_content_required");
  if (title.length > 120 || content.length > 30000) throw new Error("community_asset_content_too_large");
  if (!payload.subjectId || !payload.chapterId) throw new Error("community_asset_catalog_required");
  if (!payload.originality) throw new Error("community_asset_originality_required");
  const searchable = `${title} ${content} ${payload.sourceReference || ""}`;
  const needsReview = riskPattern.test(searchable) || content.length < 20;
  return {
    ...clone(payload),
    title,
    excerpt: String(payload.excerpt || content).slice(0, 240),
    visibility: "public",
    moderationStatus: needsReview ? "pending_review" : "published",
    riskReason: riskPattern.test(searchable) ? "疑似广告或不适宜公开内容" : (content.length < 20 ? "内容较短，需人工确认完整性" : ""),
  };
}

function createCommunityAssetStore(initialAssets = seedState()) {
  let assets = clone(initialAssets);
  return {
    submit(payload, userId = "test-user") {
      const input = validateSubmission(payload);
      const existingIndex = assets.findIndex((asset) => asset.clientAssetId === payload.id && asset.userId === userId);
      const now = Date.now();
      const asset = {
        ...input,
        id: existingIndex >= 0 ? assets[existingIndex].id : `community-${crypto.randomUUID()}`,
        clientAssetId: String(payload.id || ""),
        userId,
        contributor: String(payload.contributor || "薯考同学").slice(0, 40),
        favoriteCount: existingIndex >= 0 ? Number(assets[existingIndex].favoriteCount) || 0 : 0,
        copyCount: existingIndex >= 0 ? Number(assets[existingIndex].copyCount) || 0 : 0,
        createdAt: existingIndex >= 0 ? assets[existingIndex].createdAt : now,
        updatedAt: now,
      };
      if (existingIndex >= 0) assets[existingIndex] = asset;
      else assets.unshift(asset);
      return clone(asset);
    },
    list({ type = "all", query = "", userId = "", includeUnpublished = false } = {}) {
      const keyword = String(query).trim().toLowerCase();
      return clone(assets.filter((asset) => {
        if (!includeUnpublished && asset.moderationStatus !== "published") return false;
        if (userId && asset.userId !== userId) return false;
        if (type !== "all" && asset.type !== type) return false;
        return !keyword || `${asset.title} ${asset.excerpt} ${asset.contributor} ${(asset.tags || []).join(" ")}`.toLowerCase().includes(keyword);
      }));
    },
    get(id) { return clone(assets.find((asset) => asset.id === id) || null); },
    collect(id) {
      const index = assets.findIndex((asset) => asset.id === id && asset.moderationStatus === "published");
      if (index < 0) throw new Error("community_asset_not_found");
      assets[index].copyCount = Number(assets[index].copyCount) + 1;
      assets[index].updatedAt = Date.now();
      return clone(assets[index]);
    },
    /** 收藏计数单独维护：只有“用户 × 内容”的收藏关系发生变化时才 ±1，避免重复点击刷数。 */
    adjustFavoriteCount(id, delta) {
      const index = assets.findIndex((asset) => asset.id === id);
      if (index < 0) throw new Error("community_asset_not_found");
      const next = Math.max(0, Number(assets[index].favoriteCount || 0) + Number(delta || 0));
      assets[index].favoriteCount = next;
      assets[index].updatedAt = Date.now();
      return clone(assets[index]);
    },
    action(id, action) {
      const index = assets.findIndex((asset) => asset.id === id);
      if (index < 0) throw new Error("community_asset_not_found");
      const status = ({ approve: "published", reject: "rejected", offline: "offline" })[action];
      if (!status || !allowedStatuses.has(status)) throw new Error("community_asset_action_invalid");
      assets[index].moderationStatus = status;
      assets[index].updatedAt = Date.now();
      return clone(assets[index]);
    },
    withdraw(id, userId) {
      const index = assets.findIndex((asset) => asset.id === id && asset.userId === userId);
      if (index < 0) throw new Error("community_asset_not_found");
      assets[index].moderationStatus = "offline";
      assets[index].updatedAt = Date.now();
      return clone(assets[index]);
    },
    exportState: () => clone(assets),
  };
}

function createMemoryCommunityAssetStore(initialAssets) {
  return createCommunityAssetStore(initialAssets || seedState());
}

function createFileCommunityAssetStore(filePath = path.resolve(__dirname, "../../../.runtime/community-assets.json")) {
  let initial;
  try { initial = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    initial = seedState();
  }
  const store = createCommunityAssetStore(initial);
  const persist = () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(store.exportState(), null, 2)}\n`);
  };
  return {
    ...store,
    submit(...args) { const result = store.submit(...args); persist(); return result; },
    collect(...args) { const result = store.collect(...args); persist(); return result; },
    action(...args) { const result = store.action(...args); persist(); return result; },
    withdraw(...args) { const result = store.withdraw(...args); persist(); return result; },
  };
}

module.exports = { createFileCommunityAssetStore, createMemoryCommunityAssetStore, validateSubmission };
