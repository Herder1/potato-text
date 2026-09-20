const PUBLIC_PACK_CACHE_PREFIX = "shukao_public_pack_preview_";

function publicPackCacheKey(id) {
  return `${PUBLIC_PACK_CACHE_PREFIX}${String(id || "")}`;
}

function cachePublicPack(pack, storage = wx) {
  if (!pack || !pack.id) return null;
  const snapshot = {
    ...pack,
    id: String(pack.id),
    cachedAt: Date.now(),
  };
  storage.setStorageSync(publicPackCacheKey(snapshot.id), snapshot);
  return snapshot;
}

function getCachedPublicPack(id, storage = wx) {
  const value = storage.getStorageSync(publicPackCacheKey(id));
  return value && typeof value === "object" ? value : null;
}

module.exports = {
  PUBLIC_PACK_CACHE_PREFIX,
  cachePublicPack,
  getCachedPublicPack,
  publicPackCacheKey,
};
