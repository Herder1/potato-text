const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KINDS = new Set(["favorite", "copy"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialState() {
  return { favorites: [], copies: [] };
}

function normalizeKind(kind) {
  const value = String(kind || "").trim();
  if (!KINDS.has(value)) throw new Error("community_interaction_kind_invalid");
  return value;
}

function bucketOf(state, kind) {
  return kind === "favorite" ? state.favorites : state.copies;
}

/**
 * 社区内容与用户之间的关系记录。
 * - favorite：收藏 = 引用关系（不复制内容），同一个人重复收藏只算一次；
 * - copy：复制到我的资产 = 生成私有副本，同一人同一内容只计数一次。
 * 两个动作各自一份记录，互不推导，避免把手册里两个不同动作合成一个数字。
 */
function createCommunityInteractionStore(adapter) {
  const read = () => clone(adapter.read());
  const write = (state) => adapter.write(clone(state));

  return {
    exportState: () => clone(adapter.read()),
    replaceState: (state) => {
      const next = state && Array.isArray(state.favorites) && Array.isArray(state.copies) ? state : initialState();
      write(next);
      return clone(adapter.read());
    },

    has({ kind, assetId, userId }) {
      const bucket = bucketOf(read(), normalizeKind(kind));
      return bucket.some((item) => item.assetId === String(assetId || "") && item.userId === String(userId || ""));
    },

    /** 幂等新增：已存在返回 created=false，调用方据此决定是否调整计数。 */
    add({ kind, assetId, userId }, now = Date.now()) {
      const normalizedKind = normalizeKind(kind);
      const target = { assetId: String(assetId || "").trim(), userId: String(userId || "").trim() };
      if (!target.assetId || !target.userId) throw new Error("community_interaction_target_required");
      const state = read();
      const bucket = bucketOf(state, normalizedKind);
      const existing = bucket.find((item) => item.assetId === target.assetId && item.userId === target.userId);
      if (existing) return { created: false, record: clone(existing) };
      const record = {
        id: `interaction-${crypto.randomUUID()}`,
        kind: normalizedKind,
        assetId: target.assetId,
        userId: target.userId,
        createdAt: now,
      };
      bucket.unshift(record);
      write(state);
      return { created: true, record: clone(record) };
    },

    remove({ kind, assetId, userId }) {
      const normalizedKind = normalizeKind(kind);
      const state = read();
      const bucket = bucketOf(state, normalizedKind);
      const before = bucket.length;
      const remaining = bucket.filter((item) => !(item.assetId === String(assetId || "") && item.userId === String(userId || "")));
      if (remaining.length === before) return { removed: false };
      if (normalizedKind === "favorite") state.favorites = remaining;
      else state.copies = remaining;
      write(state);
      return { removed: true };
    },

    list({ kind = "favorite", userId = "", assetId = "" } = {}) {
      const normalizedKind = normalizeKind(kind);
      const bucket = bucketOf(read(), normalizedKind);
      return clone(bucket.filter((item) => {
        if (userId && item.userId !== String(userId)) return false;
        if (assetId && item.assetId !== String(assetId)) return false;
        return true;
      }));
    },

    /** 某个用户收藏的内容 id（按收藏时间倒序），供“我的收藏”列表使用。 */
    assetIdsForUser(userId, kind = "favorite") {
      const normalizedKind = normalizeKind(kind);
      return bucketOf(read(), normalizedKind)
        .filter((item) => item.userId === String(userId || ""))
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .map((item) => item.assetId);
    },

    /** 某个用户对一批内容的动作状态，用于列表里回显“已收藏/已复制”。 */
    statesForUser(userId, assetIds = []) {
      const target = String(userId || "");
      const wanted = new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id || "")));
      const state = read();
      const result = {};
      wanted.forEach((id) => { result[id] = { favorited: false, copied: false }; });
      if (!target) return result;
      state.favorites.forEach((item) => {
        if (item.userId === target && result[item.assetId]) result[item.assetId].favorited = true;
      });
      state.copies.forEach((item) => {
        if (item.userId === target && result[item.assetId]) result[item.assetId].copied = true;
      });
      return result;
    },

    deleteUser(userId) {
      const target = String(userId || "");
      if (!target) return 0;
      const state = read();
      const before = state.favorites.length + state.copies.length;
      state.favorites = state.favorites.filter((item) => item.userId !== target);
      state.copies = state.copies.filter((item) => item.userId !== target);
      const removed = before - (state.favorites.length + state.copies.length);
      if (removed) write(state);
      return removed;
    },

    counts() {
      const state = read();
      return { favorites: state.favorites.length, copies: state.copies.length };
    },
  };
}

function createFileCommunityInteractionStore(filePath = path.resolve(__dirname, "../../../.runtime/community-interactions.json")) {
  return createCommunityInteractionStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return {
          favorites: Array.isArray(value.favorites) ? value.favorites : [],
          copies: Array.isArray(value.copies) ? value.copies : [],
        };
      } catch (error) {
        if (error.code === "ENOENT") return initialState();
        throw error;
      }
    },
    write(state) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryCommunityInteractionStore(state = initialState()) {
  let value = clone(state);
  return createCommunityInteractionStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = {
  createFileCommunityInteractionStore,
  createMemoryCommunityInteractionStore,
  initialState,
};
