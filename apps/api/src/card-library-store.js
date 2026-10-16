const fs = require("node:fs");
const path = require("node:path");

/**
 * 卡集与知识卡的服务端库（产品负责人 2026-09-23 定，见 docs/OPEN_DECISIONS.md C15）。
 *
 * 职责边界（刻意画清，避免和既有 store 抢语义）：
 * - 本 store 存**用户自己的卡集与知识卡**：卡集（含标题/简介/颜色/文件夹/目录顺序/层级）+ 卡集内的卡片；
 * - **复习清单不在本 store**：`savedKnowledgeIds`（哪些知识卡被加入复习）真源是 `learning-state-store`，
 *   这里只存卡片本体，不重复存"是否加入复习"；
 * - 卡片里的**题目引用**（笔记卡挂的 questionId）只做字段透传，题目真源仍是 `question-store`。
 *
 * 同步语义（产品负责人 2026-09-23 选定，方案 A）：
 * 1. **并集**：按 `id` 合并两边的卡集与卡片，任何一边新增的内容都不会因为另一边"没有"而消失；
 * 2. **每项按 `updatedAt` 取较新**；时间戳相同则**以请求方（本地）为准**；
 * 3. **删除写墓碑**：卡集删除记 `deletedSets`，卡片删除记集合内的 `deletedCards`，文件夹删除记 `removedFolders`；
 *    墓碑只增不删（保留在服务端），保证"A 机删掉的东西不会因为 B 机还留着而复活"；
 * 4. **本地为空只拉不推**：请求里卡集、文件夹、墓碑全空 → 视为"新设备首次拉取"，直接返回服务端现状、不写库，
 *    这样新设备（或清过缓存的设备）不会用空库把服务端数据抹掉。
 *
 * 特别约定：**排序即置顶**。客户端用数组顺序表达置顶（置顶的卡集排在最前），
 * 因此合并结果以 `libraryUpdatedAt` 较新那一方的顺序为基准，另一方独有的条目按各自相对顺序追加在后。
 *
 * 分享快照：`shareSet()` 把某个卡集**冻结**成一份只读副本（含当时的卡片与目录），
 * 与源卡集解耦（源卡集之后怎么改都不影响已分享出去的链接）；快照用随机 id，可匿名读取，不可枚举。
 */

const MAX_SETS = 500;
const MAX_CARDS_PER_SET = 500;
const MAX_FOLDERS = 100;
const MAX_TITLE_LENGTH = 60;
const MAX_TOMBSTONES = 2000;
const MAX_SHARES_PER_USER = 200;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialState() {
  return { users: {}, shares: {} };
}

function emptyUserLibrary() {
  return { sets: [], folders: [], libraryUpdatedAt: 0, deletedSets: {}, deletedFolders: {} };
}

function stampOf(value) {
  const stamp = Number(value && (value.updatedAt || value.createdAt) || 0);
  return Number.isFinite(stamp) && stamp > 0 ? Math.floor(stamp) : 0;
}

function cleanText(value, maxLength) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeSetId(value) {
  const id = String(value === undefined || value === null ? "" : value).trim();
  if (!id) throw new Error("card_set_id_required");
  return id.length > 120 ? id.slice(0, 120) : id;
}

function normalizeCard(raw, setId) {
  if (!raw || typeof raw !== "object") throw new Error("card_invalid");
  const id = String(raw.id || "").trim();
  if (!id) throw new Error("card_id_required");
  const card = clone(raw);
  card.id = id;
  card.setId = setId;
  card.updatedAt = stampOf(raw);
  if (raw.deletedAt) card.deletedAt = Number(raw.deletedAt);
  return card;
}

function normalizeSet(raw) {
  if (!raw || typeof raw !== "object") throw new Error("card_set_invalid");
  const setId = normalizeSetId(raw.id);
  const set = clone(raw);
  set.id = setId;
  set.title = cleanText(raw.title, MAX_TITLE_LENGTH) || "未命名卡集";
  set.folder = cleanText(raw.folder, 40) || "我的卡集";
  set.updatedAt = stampOf(raw);
  if (raw.deletedAt) set.deletedAt = Number(raw.deletedAt);

  const incomingCards = Array.isArray(raw.cards) ? raw.cards.slice(0, MAX_CARDS_PER_SET) : [];
  const deletedCards = Array.isArray(raw.deletedCards) ? raw.deletedCards : [];
  set.cards = [];
  incomingCards.forEach((card) => {
    if (card && card.deletedAt) {
      deletedCards.push({ id: String(card.id || "").trim(), deletedAt: Number(card.deletedAt) });
      return;
    }
    set.cards.push(normalizeCard(card, setId));
  });
  set.deletedCards = deletedCards
    .map((card) => ({ id: String(card && card.id || "").trim(), deletedAt: Number(card && card.deletedAt) || 0 }))
    .filter((card) => card.id && card.deletedAt > 0)
    .slice(0, MAX_TOMBSTONES);
  if (!set.deletedCards.length) delete set.deletedCards;
  return set;
}

function normalizeIncoming(payload = {}) {
  const sets = (Array.isArray(payload.sets) ? payload.sets : [])
    .slice(0, MAX_SETS)
    .filter((set) => set && !set.deletedAt)
    .map(normalizeSet);
  const removedSets = (Array.isArray(payload.removedSets) ? payload.removedSets : [])
    .map((entry) => ({
      id: String(entry && entry.id || "").trim(),
      at: Number(entry && (entry.at || entry.deletedAt)) || 0,
    }))
    .filter((entry) => entry.id && entry.at > 0)
    .slice(0, MAX_TOMBSTONES);
  const folders = (Array.isArray(payload.folders) ? payload.folders : [])
    .map((name) => cleanText(name, 40))
    .filter(Boolean)
    .slice(0, MAX_FOLDERS);
  const removedFolders = (Array.isArray(payload.removedFolders) ? payload.removedFolders : [])
    .map((entry) => ({
      name: cleanText(entry && entry.name, 40),
      at: Number(entry && (entry.at || entry.deletedAt)) || 0,
    }))
    .filter((entry) => entry.name && entry.at > 0)
    .slice(0, MAX_TOMBSTONES);
  return {
    sets,
    removedSets,
    folders,
    removedFolders,
    libraryUpdatedAt: Number(payload.libraryUpdatedAt) || 0,
    isEmpty: !sets.length && !removedSets.length && !folders.length && !removedFolders.length,
  };
}

/**
 * 卡片级合并：并集 + 每张卡按 `updatedAt` 取较新；同刻以本地（请求方）为准；删除用墓碑压制。
 * `baseSet` 是顺序基准（较新的那一版卡集），`baseIsIncoming` 决定"同刻谁赢"。
 */
function mergeCards(baseSet, otherSet, baseIsIncoming) {
  const visible = new Map();
  const tombstones = new Map();
  const order = [];

  const track = (id) => {
    if (!visible.has(id) && !tombstones.has(id)) order.push(id);
  };

  const feed = (cards, deletedCards, preferIncoming) => {
    (Array.isArray(cards) ? cards : []).forEach((card) => {
      const id = String(card && card.id || "").trim();
      if (!id) return;
      track(id);
      const stamp = stampOf(card);
      const current = visible.get(id);
      if (!current || stamp > stampOf(current) || (stamp === stampOf(current) && preferIncoming)) {
        visible.set(id, card);
      }
      const tombstone = tombstones.get(id);
      if (tombstone && tombstone.deletedAt < stamp) tombstones.delete(id);
    });
    (Array.isArray(deletedCards) ? deletedCards : []).forEach((entry) => {
      const id = String(entry && entry.id || "").trim();
      if (!id) return;
      track(id);
      const at = Number(entry && entry.deletedAt) || 0;
      if (!at) return;
      const existing = tombstones.get(id);
      if (!existing || existing.deletedAt < at) tombstones.set(id, { id, deletedAt: at });
    });
  };

  feed(baseSet && baseSet.cards, baseSet && baseSet.deletedCards, baseIsIncoming);
  feed(otherSet && otherSet.cards, otherSet && otherSet.deletedCards, !baseIsIncoming);

  const cards = [];
  const deletedCards = [];
  order.forEach((id) => {
    const card = visible.get(id);
    const tombstone = tombstones.get(id);
    if (tombstone && (!card || tombstone.deletedAt >= stampOf(card))) {
      deletedCards.push(tombstone);
      return;
    }
    if (tombstone) deletedCards.push(tombstone);
    if (card) cards.push(card);
  });
  return { cards, deletedCards };
}

/** 卡集级合并：按 id 并集，整集字段 LWW；顺序以较新的库为基准。 */
function mergeSets(server, incoming) {
  const serverSets = new Map((server.sets || []).map((set) => [set.id, set]));
  const incomingSets = new Map((incoming.sets || []).map((set) => [set.id, set]));
  const deletedSets = { ...(server.deletedSets || {}) };
  incoming.removedSets.forEach((entry) => {
    const existing = Number(deletedSets[entry.id] || 0);
    if (entry.at > existing) deletedSets[entry.id] = entry.at;
  });
  (incoming.sets || []).forEach((set) => {
    if (set.deletedAt && set.deletedAt > Number(deletedSets[set.id] || 0)) deletedSets[set.id] = set.deletedAt;
  });

  const incomingLibraryNewer = incoming.libraryUpdatedAt >= Number(server.libraryUpdatedAt || 0);
  const baseIds = (incomingLibraryNewer ? incoming.sets : server.sets).map((set) => set.id);
  const otherIds = (incomingLibraryNewer ? server.sets : incoming.sets).map((set) => set.id);
  const order = [...new Set([...baseIds, ...otherIds])];

  const sets = [];
  order.forEach((id) => {
    const tombstoneAt = Number(deletedSets[id] || 0);
    const serverSet = serverSets.get(id);
    const incomingSet = incomingSets.get(id);
    if (!serverSet && !incomingSet) return;
    const serverStamp = stampOf(serverSet);
    const incomingStamp = stampOf(incomingSet);
    const winner = incomingStamp >= serverStamp ? (incomingSet || serverSet) : (serverSet || incomingSet);
    // 墓碑比双方任何一版都新 → 视为已删除（不再出现在结果里，墓碑继续保留）。
    if (tombstoneAt && tombstoneAt > Math.max(serverStamp, incomingStamp)) return;
    const merged = { ...winner };
    delete merged.deletedAt;
    const baseSet = incomingStamp >= serverStamp ? incomingSet : serverSet;
    const otherSet = baseSet === incomingSet ? serverSet : incomingSet;
    const cards = mergeCards(baseSet, otherSet, baseSet === incomingSet);
    merged.cards = cards.cards;
    if (cards.deletedCards.length) merged.deletedCards = cards.deletedCards;
    else delete merged.deletedCards;
    sets.push(merged);
  });

  return { sets, deletedSets, tombstones: Object.keys(deletedSets) };
}

function mergeFolders(server, incoming, survivingSets) {
  const deletedFolders = { ...(server.deletedFolders || {}) };
  incoming.removedFolders.forEach((entry) => {
    const existing = Number(deletedFolders[entry.name] || 0);
    if (entry.at > existing) deletedFolders[entry.name] = entry.at;
  });
  const names = [];
  const push = (name) => {
    const clean = cleanText(name, 40);
    if (!clean || names.includes(clean)) return;
    const removedAt = Number(deletedFolders[clean] || 0);
    if (removedAt && removedAt >= Math.max(Number(server.libraryUpdatedAt || 0), incoming.libraryUpdatedAt)) return;
    names.push(clean);
  };
  (server.folders || []).forEach(push);
  incoming.folders.forEach(push);
  (survivingSets || []).forEach((set) => push(set.folder));
  return { folders: names.slice(0, MAX_FOLDERS), deletedFolders };
}

function visibleSets(library) {
  const deleted = library.deletedSets || {};
  return (library.sets || [])
    .filter((set) => !set.deletedAt)
    .filter((set) => !deleted[set.id] || deleted[set.id] <= stampOf(set))
    .map((set) => {
      const record = clone(set);
      const cards = (record.cards || []).filter((card) => !card.deletedAt);
      record.cards = cards;
      if (record.deletedCards && !record.deletedCards.length) delete record.deletedCards;
      return record;
    });
}

function publicLibrary(library) {
  return {
    libraryUpdatedAt: Number(library.libraryUpdatedAt || 0),
    folders: clone(library.folders || []),
    sets: visibleSets(library),
    deletedSetIds: Object.keys(library.deletedSets || {}),
    deletedFolders: clone(library.deletedFolders || {}),
  };
}

function createCardLibraryStore(adapter) {
  const read = () => clone(adapter.read());
  const write = (state) => adapter.write(clone(state));

  return {
    exportState: () => clone(adapter.read()),
    replaceState(state) {
      if (!state || typeof state !== "object" || !state.users) throw new Error("card_library_invalid");
      write(state);
      return clone(adapter.read());
    },

    /** 读某个用户的服务端库（永不抛错；没有记录返回空库）。 */
    get(userId) {
      const key = String(userId || "").trim();
      const library = read().users[key];
      return library ? publicLibrary(library) : publicLibrary(emptyUserLibrary());
    },

    /**
     * 上传本地库并取回合并结果（语义见文件头）。
     * 返回 `{ library, uploaded }`；`uploaded=false` 表示这次是"本地为空只拉不推"。
     */
    sync(userId, payload = {}, now = Date.now()) {
      const key = String(userId || "").trim();
      if (!key) throw new Error("card_library_user_required");
      const incoming = normalizeIncoming(payload);
      const state = read();
      const current = state.users[key] || emptyUserLibrary();
      if (incoming.isEmpty) {
        return { library: publicLibrary(current), uploaded: false };
      }

      const mergedSets = mergeSets(current, incoming);
      const mergedFolders = mergeFolders(current, incoming, mergedSets.sets);
      // `libraryUpdatedAt` ＝"已知最新的一次内容改动"，**不是**同步时刻：
      // 顺序基准与文件夹墓碑都要拿它比大小，若每次同步都推进到 now，比较就失去意义。
      const newestSetStamp = mergedSets.sets.reduce((newest, set) => Math.max(newest, stampOf(set)), 0);
      const library = {
        sets: mergedSets.sets,
        deletedSets: mergedSets.deletedSets,
        folders: mergedFolders.folders,
        deletedFolders: mergedFolders.deletedFolders,
        libraryUpdatedAt: Math.max(Number(current.libraryUpdatedAt || 0), incoming.libraryUpdatedAt, newestSetStamp),
      };
      library.sets = library.sets.slice(0, MAX_SETS);
      state.users[key] = library;
      write(state);
      return { library: publicLibrary(library), uploaded: true };
    },

    /** 分享快照：把卡集冻结成只读副本（与源卡集解耦），返回 `{ shareId, sharedAt }`。 */
    shareSet(userId, setId, now = Date.now()) {
      const key = String(userId || "").trim();
      const target = String(setId || "").trim();
      if (!key) throw new Error("card_library_user_required");
      if (!target) throw new Error("card_set_id_required");
      const state = read();
      const library = state.users[key];
      if (!library) throw new Error("card_set_not_found");
      const set = visibleSets(library).find((item) => item.id === target);
      if (!set) throw new Error("card_set_not_found");
      const owned = Object.values(state.shares || {}).filter((entry) => entry.userId === key);
      if (owned.length >= MAX_SHARES_PER_USER) {
        const oldest = owned.sort((left, right) => Number(left.sharedAt || 0) - Number(right.sharedAt || 0))[0];
        delete state.shares[oldest.shareId];
      }
      const shareId = `cs-${now.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
      state.shares[shareId] = {
        shareId,
        userId: key,
        setId: set.id,
        title: set.title,
        sharedAt: now,
        snapshot: { ...clone(set), cards: (set.cards || []).map((card) => clone(card)) },
      };
      write(state);
      return { shareId, sharedAt: now, title: set.title };
    },

    /** 分享快照按 id 读取（匿名可读，随机 id 不可枚举）；读不到返回 null。 */
    getShare(shareId) {
      const key = String(shareId || "").trim();
      if (!key) return null;
      const entry = (read().shares || {})[key];
      if (!entry) return null;
      return {
        shareId: entry.shareId,
        sharedAt: Number(entry.sharedAt || 0),
        set: clone(entry.snapshot),
      };
    },

    deleteUser(userId) {
      const key = String(userId || "").trim();
      const state = read();
      if (!key || !state.users[key]) return false;
      delete state.users[key];
      Object.keys(state.shares || {}).forEach((shareId) => {
        if (state.shares[shareId].userId === key) delete state.shares[shareId];
      });
      write(state);
      return true;
    },

    counts() {
      const state = read();
      const users = Object.keys(state.users || {});
      return users.reduce((total, key) => {
        const library = state.users[key];
        return {
          users: total.users + 1,
          sets: total.sets + (library.sets || []).length,
          cards: total.cards + (library.sets || []).reduce((count, set) => count + (set.cards || []).length, 0),
          shares: total.shares,
        };
      }, { users: 0, sets: 0, cards: 0, shares: Object.keys(state.shares || {}).length });
    },
  };
}

function createFileCardLibraryStore(filePath = path.resolve(__dirname, "../../../.runtime/card-library.json")) {
  return createCardLibraryStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return value && value.users && typeof value.users === "object" ? value : initialState();
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

function createMemoryCardLibraryStore(state = initialState()) {
  let value = clone(state);
  return createCardLibraryStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = {
  createCardLibraryStore,
  createFileCardLibraryStore,
  createMemoryCardLibraryStore,
  initialState,
  MAX_SETS,
  MAX_CARDS_PER_SET,
  MAX_FOLDERS,
};
