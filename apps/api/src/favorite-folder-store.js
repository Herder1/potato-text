const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 「我的收藏」的文件夹（含子文件夹）、成员归属与置顶标记（DEC-096，2026-09-23）。
 *
 * 职责边界（刻意画清，避免和既有 store 抢语义）：
 * - 本 store **只存"用户怎么组织收藏"**：文件夹树 + 某条收藏属于哪个文件夹 + 哪条被置顶；
 * - **收藏本身不在这里**：社区收藏的真源是 `community-interaction-store`（引用关系），
 *   题目收藏的真源是 `learning-state-store` 的 `account.bookmarks`（客户端本地只是缓存）。
 *   所以这里存的是 `{ kind, refId }` 引用，读的时候由路由把两份真源合起来算条数（merge 而不复制）。
 * - 层级固定为**文件夹 → 子文件夹**两级（DEC-096 ②）：子文件夹不能再挂子文件夹，
 *   越级创建直接拒绝（`favorite_folder_depth_exceeded`），而不是默默压平。
 *
 * 一处约定：「文件夹的条数」= 该文件夹直属收藏 + 其所有子文件夹的收藏（rollup），
 * 这样抽屉里父文件夹的数字和上方子文件夹标签的数字能对得上（12 = 5 + 4 + 3）。
 */

const KINDS = new Set(["community", "question"]);
const MAX_NAME_LENGTH = 20;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialState() {
  return { users: {} };
}

function emptyUserState() {
  return { folders: [], members: [], pins: [] };
}

function normalizeKind(kind) {
  const value = String(kind || "").trim();
  if (!KINDS.has(value)) throw new Error("favorite_ref_kind_invalid");
  return value;
}

function normalizeRefId(refId) {
  const value = String(refId || "").trim();
  if (!value) throw new Error("favorite_ref_id_required");
  return value;
}

function normalizeName(name) {
  const value = String(name === undefined || name === null ? "" : name).trim();
  if (!value) throw new Error("favorite_folder_name_required");
  if (value.length > MAX_NAME_LENGTH) throw new Error("favorite_folder_name_too_long");
  return value;
}

function refKey(kind, refId) {
  return `${kind}:${refId}`;
}

function createFavoriteFolderStore(adapter) {
  const read = () => clone(adapter.read());
  const write = (state) => adapter.write(clone(state));

  const userStateOf = (state, userId) => {
    const key = String(userId || "").trim();
    if (!key) throw new Error("favorite_user_required");
    if (!state.users[key]) state.users[key] = emptyUserState();
    const record = state.users[key];
    if (!Array.isArray(record.folders)) record.folders = [];
    if (!Array.isArray(record.members)) record.members = [];
    if (!Array.isArray(record.pins)) record.pins = [];
    return record;
  };

  const sortedFolders = (record) => record.folders
    .slice()
    .sort((left, right) => {
      const byOrder = Number(left.order || 0) - Number(right.order || 0);
      if (byOrder) return byOrder;
      return Number(left.createdAt || 0) - Number(right.createdAt || 0);
    });

  return {
    exportState: () => clone(adapter.read()),
    replaceState(state) {
      const next = state && state.users && typeof state.users === "object" ? clone(state) : initialState();
      write(next);
      return clone(adapter.read());
    },

    /** 一个用户的完整组织数据（文件夹按 order 排好，便于直接渲染抽屉）。 */
    list(userId) {
      const state = read();
      const record = state.users[String(userId || "").trim()] || emptyUserState();
      return {
        folders: sortedFolders(record),
        members: clone(record.members),
        pins: clone(record.pins),
      };
    },

    createFolder({ userId, name, parentId = null, icon = "" } = {}, now = Date.now()) {
      const state = read();
      const record = userStateOf(state, userId);
      const normalizedName = normalizeName(name);
      const parent = String(parentId || "").trim();
      if (parent) {
        const parentFolder = record.folders.find((folder) => folder.id === parent);
        if (!parentFolder) throw new Error("favorite_folder_parent_missing");
        // 两级封顶：父级自己必须是顶层文件夹，否则就是"子文件夹的子文件夹"。
        if (parentFolder.parentId) throw new Error("favorite_folder_depth_exceeded");
      }
      const siblings = record.folders.filter((folder) => String(folder.parentId || "") === parent);
      if (siblings.some((folder) => folder.name === normalizedName)) throw new Error("favorite_folder_name_duplicate");
      const folder = {
        id: `fav-folder-${crypto.randomUUID()}`,
        name: normalizedName,
        icon: String(icon || "").trim(),
        parentId: parent || null,
        order: siblings.reduce((max, item) => Math.max(max, Number(item.order || 0)), 0) + 1,
        createdAt: now,
        updatedAt: now,
      };
      record.folders.push(folder);
      write(state);
      return { folder: clone(folder) };
    },

    updateFolder({ userId, folderId, name, icon } = {}, now = Date.now()) {
      const state = read();
      const record = userStateOf(state, userId);
      const target = record.folders.find((folder) => folder.id === String(folderId || ""));
      if (!target) throw new Error("favorite_folder_missing");
      if (name !== undefined) {
        const normalizedName = normalizeName(name);
        const parent = String(target.parentId || "");
        const duplicated = record.folders.some((folder) => folder.id !== target.id
          && String(folder.parentId || "") === parent && folder.name === normalizedName);
        if (duplicated) throw new Error("favorite_folder_name_duplicate");
        target.name = normalizedName;
      }
      if (icon !== undefined) target.icon = String(icon || "").trim();
      target.updatedAt = now;
      write(state);
      return { folder: clone(target) };
    },

    /** 删除文件夹：连它的子文件夹一起删；文件夹里的收藏**不删**，退回"未分类"（只出现在「全部收藏」里）。 */
    deleteFolder({ userId, folderId } = {}) {
      const state = read();
      const record = userStateOf(state, userId);
      const targetId = String(folderId || "");
      const target = record.folders.find((folder) => folder.id === targetId);
      if (!target) throw new Error("favorite_folder_missing");
      const removedFolderIds = [target.id, ...record.folders.filter((folder) => folder.parentId === target.id).map((folder) => folder.id)];
      const removedSet = new Set(removedFolderIds);
      const unfiledMembers = record.members.filter((member) => removedSet.has(member.folderId)).length;
      record.folders = record.folders.filter((folder) => !removedSet.has(folder.id));
      record.members = record.members.filter((member) => !removedSet.has(member.folderId));
      write(state);
      return { removedFolderIds, unfiledMembers };
    },

    /** 同级重排：必须一次给全该层级的全部 id（缺项即拒绝），避免半个列表保持沉默的旧顺序。 */
    reorder({ userId, parentId = null, order = [] } = {}) {
      const state = read();
      const record = userStateOf(state, userId);
      const parent = String(parentId || "").trim();
      const siblings = record.folders.filter((folder) => String(folder.parentId || "") === parent);
      const wanted = (Array.isArray(order) ? order : []).map((id) => String(id || ""));
      if (wanted.length !== siblings.length) throw new Error("favorite_folder_reorder_incomplete");
      const siblingIds = new Set(siblings.map((folder) => folder.id));
      if (wanted.some((id) => !siblingIds.has(id)) || new Set(wanted).size !== wanted.length) {
        throw new Error("favorite_folder_reorder_invalid");
      }
      wanted.forEach((id, index) => {
        const folder = record.folders.find((item) => item.id === id);
        folder.order = index + 1;
      });
      write(state);
      return { folders: sortedFolders(record).filter((folder) => String(folder.parentId || "") === parent).map((folder) => clone(folder)) };
    },

    /** 把一条收藏放进某个文件夹（folderId 传空＝移出，回到"未分类"）。幂等。 */
    assign({ userId, kind, refId, folderId = null } = {}, now = Date.now()) {
      const state = read();
      const record = userStateOf(state, userId);
      const normalizedKind = normalizeKind(kind);
      const normalizedRefId = normalizeRefId(refId);
      const targetFolder = String(folderId || "").trim();
      if (targetFolder && !record.folders.some((folder) => folder.id === targetFolder)) {
        throw new Error("favorite_folder_missing");
      }
      const key = refKey(normalizedKind, normalizedRefId);
      record.members = record.members.filter((member) => refKey(member.kind, member.refId) !== key);
      let assigned = false;
      if (targetFolder) {
        record.members.unshift({
          id: `fav-member-${crypto.randomUUID()}`,
          kind: normalizedKind,
          refId: normalizedRefId,
          folderId: targetFolder,
          createdAt: now,
          updatedAt: now,
        });
        assigned = true;
      }
      write(state);
      return { assigned, folderId: assigned ? targetFolder : null };
    },

    /** 置顶是**全局**的（DEC-096 ④）：同一条收藏在任何文件夹里都排最前。 */
    setPin({ userId, kind, refId, pinned = true } = {}, now = Date.now()) {
      const state = read();
      const record = userStateOf(state, userId);
      const normalizedKind = normalizeKind(kind);
      const normalizedRefId = normalizeRefId(refId);
      const key = refKey(normalizedKind, normalizedRefId);
      const existing = record.pins.find((pin) => refKey(pin.kind, pin.refId) === key);
      if (pinned) {
        if (!existing) record.pins.unshift({ kind: normalizedKind, refId: normalizedRefId, pinnedAt: now });
      } else {
        record.pins = record.pins.filter((pin) => refKey(pin.kind, pin.refId) !== key);
      }
      write(state);
      return { pinned: Boolean(pinned) };
    },

    isPinned({ userId, kind, refId } = {}) {
      const record = read().users[String(userId || "").trim()] || emptyUserState();
      const key = refKey(normalizeKind(kind), normalizeRefId(refId));
      return record.pins.some((pin) => refKey(pin.kind, pin.refId) === key);
    },

    folderIdOf({ userId, kind, refId } = {}) {
      const record = read().users[String(userId || "").trim()] || emptyUserState();
      const key = refKey(normalizeKind(kind), normalizeRefId(refId));
      const member = record.members.find((item) => refKey(item.kind, item.refId) === key);
      return member ? member.folderId : null;
    },

    /**
     * 清掉"已经不再收藏"的成员关系与置顶（取消收藏后残留的引用）。
     * 由读取路由在算数前调用：这样取消收藏（社区走 unfavorite、题目走书签同步）两条路径都不必各自清理，
     * 也不会出现"文件夹里有个数字，点进去却什么都没有"。
     */
    prune({ userId, validRefs = {} } = {}) {
      const state = read();
      const key = String(userId || "").trim();
      if (!key || !state.users[key]) return { removedMembers: 0, removedPins: 0 };
      const record = state.users[key];
      const validKeys = new Set();
      Object.keys(validRefs).forEach((kind) => {
        if (!KINDS.has(kind)) return;
        (Array.isArray(validRefs[kind]) ? validRefs[kind] : []).forEach((refId) => {
          validKeys.add(refKey(kind, String(refId || "")));
        });
      });
      const membersBefore = record.members.length;
      const pinsBefore = record.pins.length;
      record.members = record.members.filter((member) => validKeys.has(refKey(member.kind, member.refId)));
      record.pins = record.pins.filter((pin) => validKeys.has(refKey(pin.kind, pin.refId)));
      const removedMembers = membersBefore - record.members.length;
      const removedPins = pinsBefore - record.pins.length;
      if (removedMembers || removedPins) write(state);
      return { removedMembers, removedPins };
    },

    /** 每个文件夹的直属条数；`withChildren` 把子文件夹的条数并进父文件夹（与抽屉里的数字口径一致）。 */
    countsByFolder(userId) {
      const record = read().users[String(userId || "").trim()] || emptyUserState();
      const direct = {};
      record.folders.forEach((folder) => { direct[folder.id] = 0; });
      record.members.forEach((member) => {
        if (direct[member.folderId] === undefined) return;
        direct[member.folderId] += 1;
      });
      const withChildren = { ...direct };
      record.folders.forEach((folder) => {
        if (!folder.parentId) return;
        if (withChildren[folder.parentId] === undefined) return;
        withChildren[folder.parentId] += direct[folder.id] || 0;
      });
      return { direct, withChildren };
    },

    /** `{ "community:asset-1": "fav-folder-x" }` —— 页面一次拿全，避免逐条查询。 */
    membershipMap(userId) {
      const record = read().users[String(userId || "").trim()] || emptyUserState();
      const result = {};
      record.members.forEach((member) => { result[refKey(member.kind, member.refId)] = member.folderId; });
      return result;
    },

    deleteUser(userId) {
      const key = String(userId || "").trim();
      const state = read();
      if (!key || !state.users[key]) return false;
      delete state.users[key];
      write(state);
      return true;
    },

    counts() {
      const state = read();
      return Object.keys(state.users).reduce((total, key) => {
        const record = state.users[key];
        return {
          folders: total.folders + record.folders.length,
          members: total.members + record.members.length,
          pins: total.pins + record.pins.length,
        };
      }, { folders: 0, members: 0, pins: 0 });
    },
  };
}

function createFileFavoriteFolderStore(filePath = path.resolve(__dirname, "../../../.runtime/favorite-folders.json")) {
  return createFavoriteFolderStore({
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

function createMemoryFavoriteFolderStore(state = initialState()) {
  let value = clone(state);
  return createFavoriteFolderStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = {
  createFavoriteFolderStore,
  createFileFavoriteFolderStore,
  createMemoryFavoriteFolderStore,
  initialState,
  MAX_NAME_LENGTH,
};
