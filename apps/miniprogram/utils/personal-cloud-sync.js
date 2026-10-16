const { createSyncStatus } = require("./sync-status");

const CORE_KEYS = [
  "shukao_private_packs",
  "shukao_private_pack_categories",
  "shukao_user_assets",
  "shukao_ai_history",
  "shukao_packs", "shukao_private_questions", "shukao_private_packs_migrated_v1", "shukao_assets_migrated_v1",
  "shukao_active_pack_questions", "shukao_active_pack_name", "shukao_active_pack_id",
];

/**
 * 学习与复习数据：**退出/切换时存档，guest → 账号登录时由该账号接管**（"这台设备上我本人的进度"）。
 * 接管的依据：登录后要能继续保存进度（口径第 3 条）＋既有行为"未登录期间练习 → 登录后带走"
 * （tests/miniprogram-auth.test.js 锁的就是登录时把本机 attempts 上行）。
 * 注意**不含**个人资产（题包/资产/AI 会话）与笔记草稿——那几类沿用 DEC-106 的
 * "历史本地内容不自动归属"，由 tests/personal-cloud-sync.test.js 的同名用例守住。
 */
const STUDENT_PROGRESS_KEYS = [
  // 知识卡与卡集（DEC-097：本机是可离线读写的工作副本）
  "shukao_card_box_sets", "shukao_card_box_folders", "shukao_card_box_removed_sets",
  "shukao_card_box_removed_folders", "shukao_card_box_library_updated",
  // 题目收藏（真源＝服务端 learning-state 的 account.bookmarks）
  "shukao_bookmarks",
  // 学习与复习进度
  "shukao_attempts", "shukao_review_states", "shukao_review_history", "shukao_active_review_ids",
  "shukao_saved_knowledge_cards",
  // 学习结果类（没有明确上行链路）
  "shukao_exam_results", "shukao_learning_diagnosis_reports",
  "shukao_subjective_score_history", "shukao_subjective_score_feedback",
  "shukao_book_practice_progress", "shukao_pack_practice_progress", "shukao_knowledge_activity",
];

/**
 * 账号余额的本机镜像：只存档、**不接管**——余额以服务端下发为准，
 * 未登录期间本机那份没有意义，接管过来只会误导。
 */
const BALANCE_MIRROR_KEYS = ["shukao_beans", "shukao_ai_credits"];

/**
 * 按账号命名空间存档的个人数据键（2026-10-03，产品负责人 9 条口径"临时 B、最终混合"）：
 *   · 退出登录、切换账号时**不得立即清空本地学习数据** → 这些键一律**存档**（快照进该账号的作用域），
 *     界面切走、数据不删；
 *   · 只对**当前活跃账号**可见（进入某作用域只恢复该作用域的存档），换账号看不到别人的数据；
 *   · 服务端仍是唯一权威（口径第 1 条）：本机存档只是"弱网/服务端不可达时的兜底副本"，
 *     同步成功后按保留期限回收（口径第 6 条，见 PRUNE_* 常量），**不作为永久数据方案**（口径第 7 条）。
 *
 * 为什么不再"有服务端真源就退出即清"：API 地址与生产配置修复前（RELEASE_CHECKLIST B7 / OPEN_DECISIONS C14），
 * 服务端可能根本不可达，清掉就等于用户真的丢数据；丢失不可逆，本机多留一份是可逆的。
 */
const PERSONAL_DATA_KEYS = [
  ...STUDENT_PROGRESS_KEYS, ...BALANCE_MIRROR_KEYS,
  "shukao_message_read_ids", "shukao_unread_notification_count",
];

/** 前缀型个人数据键：编辑中笔记草稿、历史遗留的逐题书签（shukao_bookmark_<id>）。 */
const PERSONAL_DATA_PREFIXES = ["shukao_note_draft_", "shukao_bookmark_"];

/** guest → 账号接管时按前缀匹配的键：历史逐题书签属于学习数据；笔记草稿**不**接管。 */
const ADOPTED_PREFIXES = ["shukao_bookmark_"];

/**
 * **需要登录后一次性确认**才归属的个人资产键（2026-10-03 产品负责人选定"统一归属 + 登录时一次性确认"）。
 * 动机：DEC-106 原本规定"历史本地内容不自动归属"，初衷是**隐私**（共享设备上，别人未登录时留下的内容不该被
 * 下一个登录者静默上传到云端）。现在把它从"静默丢弃"改为"**可见地询问一次**"：确认 → 归入当前账号；
 * 不确定 → 留在本机（并记下已问过，不再重复打扰）。
 * 迁移标记与"当前题包"指针不算内容，不参与询问。
 */
const CONFIRMED_ADOPTION_KEYS = [
  "shukao_private_packs", "shukao_private_pack_categories",
  "shukao_user_assets", "shukao_ai_history", "shukao_packs", "shukao_private_questions",
];
const CONFIRMED_ADOPTION_PREFIXES = ["shukao_note_draft_"];

/**
 * 存档回收的保留期限（口径第 6 条）。**默认值待产品负责人确认**，先按"够弱网兜底、又不无限占空间"取：
 *   · 账号超过 30 天没登录 → 整条作用域（含存档）回收；
 *   · 已确认同步过（lastSyncedAt>0 且待同步队列为空）的账号，存档在 7 天后回收，只留簿记；
 *   · 最多保留 3 个账号的存档 + 当前的 guest。
 * 回收只影响本机副本；服务端仍是唯一权威，下次登录从服务端拉取。
 */
const SCOPE_RETENTION_DAYS = 30;
const SYNCED_SNAPSHOT_RETENTION_DAYS = 7;
const MAX_ACCOUNT_SCOPES = 3;
const ACTIVE_SCOPE_KEY = "shukao_personal_cloud_active_scope";
const SCOPE_PREFIX = "shukao_personal_cloud_scope_";
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function storageApi() { return typeof wx === "undefined" ? null : wx; }
function ownerScope(context) { return encodeURIComponent(JSON.stringify([context.environment, context.baseUrl, context.userId])); }
function requestContext(context) {
  if (!context || !context.userId || !context.baseUrl || !context.token) return null;
  return {
    userId: String(context.userId),
    baseUrl: String(context.baseUrl).replace(/\/$/, ""),
    token: String(context.token),
    environment: String(context.environment || "develop"),
  };
}
function scopeKey(scope) { return `${SCOPE_PREFIX}${scope}`; }
function emptyScope() { return { queue: [], revisions: {}, conflicts: [], lastError: "", lastSyncedAt: 0, attempts: 0 }; }
const KINDS = ["packs", "packCategories", "questions", "notes", "aiSessions"];
const assetKey = (kind, id) => JSON.stringify([kind, id]);
function localAttachment(value) { return /(?:wxfile:\/\/|file:\/\/|https?:\/\/(?:tmp|usr)\/)/i.test(JSON.stringify(value)); }
function byteLength(text) {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}
function blockedChange(item) {
  return !item.deleted && (isNoteDraft(item) || localAttachment(item.record) || byteLength(JSON.stringify(item.record)) > 2 * 1024 * 1024);
}
function isNoteDraft(item) { return !item.deleted && item.kind === "notes" && item.record && item.record.moderationStatus === "draft"; }
function kindForAsset(record) {
  if (!record || !record.type) return "";
  if (record.type === "question") return "questions";
  if (record.type === "note") return "notes";
  return "";
}

function createPersonalCloudSync({ storage, request, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = Date.now, onChanged = () => {} }) {
  let context = null;
  let activeScope = String(storage.getStorageSync(ACTIVE_SCOPE_KEY) || "guest");
  let timer = null;
  let flight = null;
  let generation = 0;
  // 待同步标记（口径第 4 条）：失败就标 pending、成功才标 synced，绝不把没送上去的东西说成已同步。
  // 注意别和下面的 status() 重名——那是给界面读同步进度的查询函数。
  const syncBook = createSyncStatus({ storage, now });

  function readScope(scope = activeScope) {
    return { ...emptyScope(), ...clone(storage.getStorageSync(scopeKey(scope)) || {}) };
  }
  function writeScope(value, scope = activeScope) { storage.setStorageSync(scopeKey(scope), clone(value)); }
  function workspaceSnapshot() {
    return Object.fromEntries(workspaceKeys().map((key) => [key, clone(storage.getStorageSync(key))]));
  }
  function workspaceKeys() {
    // 前缀型键（笔记草稿、历史逐题书签）只能在运行期枚举出来：静态清单再全也会漏。
    const dynamic = typeof storage.getStorageInfoSync === "function"
      ? storage.getStorageInfoSync().keys.filter((key) => PERSONAL_DATA_PREFIXES.some((prefix) => key.startsWith(prefix)))
      : [];
    return [...new Set([...CORE_KEYS, ...PERSONAL_DATA_KEYS, ...dynamic])];
  }
  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * guest → 账号的"接管"合并（口径第 3 条：退出/切换时不得立即清空本地学习数据）。
   * 未登录期间的本机内容归当前登录的这个账号：数组按 id 求并集、普通对象浅合并、标量以本机现值为准，
   * 同 id 项优先保留账号存档里那一版。
   */
  function mergeWorkspaceValue(accountValue, guestValue) {
    if (accountValue === undefined || accountValue === "") return guestValue;
    if (guestValue === undefined || guestValue === "") return accountValue;
    if (Array.isArray(accountValue) && Array.isArray(guestValue)) {
      const byId = new Map();
      [...accountValue, ...guestValue].forEach((item) => {
        const key = isPlainObject(item) ? String(item.id || item.questionId || JSON.stringify(item)) : String(item);
        if (!byId.has(key)) byId.set(key, item);
      });
      return [...byId.values()];
    }
    if (isPlainObject(accountValue) && isPlainObject(guestValue)) return { ...accountValue, ...guestValue };
    return guestValue;
  }

  function restoreWorkspace(value, adopt) {
    const snapshot = { ...(value || {}) };
    if (adopt) {
      Object.keys(adopt).forEach((key) => {
        if (adopt[key] === undefined || adopt[key] === "") return;
        snapshot[key] = mergeWorkspaceValue(snapshot[key], adopt[key]);
      });
    }
    [...new Set([...workspaceKeys(), ...Object.keys(snapshot)])].forEach((key) => {
      if (snapshot[key] === undefined || snapshot[key] === "") storage.removeStorageSync(key);
      else storage.setStorageSync(key, clone(snapshot[key]));
    });
  }

  /**
   * 只听"该被这个账号接管"的那部分：学习与复习数据（含历史逐题书签）。
   * 个人资产（题包/资产/AI 会话）与笔记草稿**不在此列**——沿用 DEC-106 的历史本地内容不自动归属。
   */
  function pickAdoptable(workspace) {
    const picked = {};
    Object.keys(workspace || {}).forEach((key) => {
      if (STUDENT_PROGRESS_KEYS.includes(key) || ADOPTED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        picked[key] = workspace[key];
      }
    });
    return picked;
  }

  /**
   * guest 命名空间里"要问一次才归属"的内容（个人资产 + 笔记草稿）。
   * 返回 { count, keys, declined }：declined=true 表示用户已经选过"留在本机"，不要再自动问。
   */
  function pendingGuestAdoption() {
    const guest = readScope("guest");
    const workspace = guest.workspace || {};
    const keys = Object.keys(workspace).filter((key) => isConfirmedAdoptionKey(key) && hasContent(workspace[key]));
    return {
      count: keys.reduce((sum, key) => sum + countWorkspaceItems(workspace[key]), 0),
      keys,
      declined: Number(guest.adoptionDeclinedAt) > 0,
    };
  }

  /** 用户选"归入当前账号"：把 guest 快照里那部分并进当前作用域与工作区，并从 guest 快照移除（不留双份）。 */
  function adoptGuestWorkspace() {
    if (activeScope === "guest") return false;
    const guest = readScope("guest");
    const workspace = guest.workspace || {};
    const keys = Object.keys(workspace).filter((key) => isConfirmedAdoptionKey(key) && hasContent(workspace[key]));
    if (!keys.length) return false;
    keys.forEach((key) => {
      const merged = mergeWorkspaceValue(storage.getStorageSync(key), workspace[key]);
      if (merged === undefined || merged === "") storage.removeStorageSync(key);
      else storage.setStorageSync(key, clone(merged));
      delete workspace[key];
    });
    guest.workspace = workspace;
    guest.adoptionDeclinedAt = 0;
    writeScope(guest, "guest");
    const current = readScope();
    current.workspace = workspaceSnapshot();
    writeScope(current);
    return true;
  }

  /** 用户选"留在本机"：不归入，并记下已问过，避免每次登录都弹。 */
  function keepGuestWorkspace() {
    const guest = readScope("guest");
    guest.adoptionDeclinedAt = now();
    writeScope(guest, "guest");
    return true;
  }

  function isConfirmedAdoptionKey(key) {
    return CONFIRMED_ADOPTION_KEYS.includes(key) || CONFIRMED_ADOPTION_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  function hasContent(value) {
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  }

  function countWorkspaceItems(value) {
    return Array.isArray(value) ? value.length : 1;
  }

  /**
   * 作用域切换（口径第 2/3/5 条）：
   *   · 离开时把当前本机内容存进**当前作用域**的命名空间——数据不删，只是切走；
   *   · 进入账号作用域**严格隔离**：只恢复该账号的存档，别的账号的存档一个都不进来；
   *   · 唯一例外是 guest → 账号：**学习与复习数据**由这个账号接管并与存档合并（不清空）；
   *   · 进入 guest 时恢复 guest 存档——未登录界面看不到任何账号的数据。
   * 每次切换记 lastUsedAt，并按保留期限回收过期存档（口径第 6 条）。
   */
  function switchWorkspace(nextScope) {
    if (nextScope === activeScope) return;
    const previousScope = activeScope;
    const current = readScope();
    current.workspace = workspaceSnapshot();
    current.lastUsedAt = now();
    writeScope(current);
    const adopt = previousScope === "guest" && nextScope !== "guest" ? pickAdoptable(current.workspace) : null;
    const next = readScope(nextScope);
    restoreWorkspace(next.workspace, adopt && Object.keys(adopt).length ? adopt : null);
    // 已被接管的那部分从 guest 快照里去掉：一份内容只留一份，不留"本机一份、账号一份"的双份状态。
    if (adopt && Object.keys(adopt).length) {
      Object.keys(adopt).forEach((key) => { delete current.workspace[key]; });
      writeScope(current);
    }
    if (nextScope !== "guest") {
      storage.setStorageSync("shukao_private_packs_migrated_v1", true);
      storage.setStorageSync("shukao_assets_migrated_v1", true);
    }
    activeScope = nextScope;
    storage.setStorageSync(ACTIVE_SCOPE_KEY, activeScope);
    next.lastUsedAt = now();
    if (adopt) next.workspace = workspaceSnapshot();
    writeScope(next, nextScope);
    pruneStaleScopes(nextScope);
  }

  /**
   * 存档回收（口径第 6 条；阈值是**默认值、待产品负责人确认**）：
   *   · 超过 SCOPE_RETENTION_DAYS 没用的账号 → 整条作用域回收；
   *   · 超出 MAX_ACCOUNT_SCOPES 的最旧账号 → 回收；
   *   · 已确认同步过（lastSyncedAt>0 且队列空）且存档超过 SYNCED_SNAPSHOT_RETENTION_DAYS → 只丢存档、留簿记。
   * 回收只动本机副本；服务端是唯一权威（口径第 1 条），下次登录重新拉取。
   */
  function pruneStaleScopes(keepScope) {
    if (typeof storage.getStorageInfoSync !== "function") return;
    const nowMs = now();
    const day = 24 * 60 * 60 * 1000;
    const records = storage.getStorageInfoSync().keys
      .filter((key) => key.startsWith(SCOPE_PREFIX))
      .map((key) => {
        const scope = key.slice(SCOPE_PREFIX.length);
        return { key, scope, value: readScope(scope) };
      });
    const accounts = records
      .filter((record) => record.scope !== "guest" && record.scope !== keepScope)
      .sort((left, right) => (Number(right.value.lastUsedAt) || 0) - (Number(left.value.lastUsedAt) || 0));
    accounts.forEach((record, index) => {
      const usedAt = Number(record.value.lastUsedAt) || 0;
      const stale = usedAt > 0 && nowMs - usedAt > SCOPE_RETENTION_DAYS * day;
      const overQuota = index >= MAX_ACCOUNT_SCOPES;
      if (stale || overQuota) {
        storage.removeStorageSync(record.key);
        return;
      }
      const syncedAndOld = Number(record.value.lastSyncedAt) > 0
        && Array.isArray(record.value.queue) && record.value.queue.length === 0
        && usedAt > 0 && nowMs - usedAt > SYNCED_SNAPSHOT_RETENTION_DAYS * day;
      if (syncedAndOld && record.value.workspace && Object.keys(record.value.workspace).length) {
        record.value.workspace = {};
        writeScope(record.value, record.scope);
      }
    });
  }
  function cancelTimer() { if (timer !== null) clearTimeoutFn(timer); timer = null; }

  function configure(next) {
    const normalized = requestContext(next);
    const nextScope = normalized ? ownerScope(normalized) : "guest";
    const changedScope = nextScope !== activeScope;
    if (changedScope) switchWorkspace(nextScope);
    if ((context && context.userId) !== (normalized && normalized.userId)
      || (context && context.token) !== (normalized && normalized.token)
      || (context && context.baseUrl) !== (normalized && normalized.baseUrl) || changedScope) {
      generation += 1;
      flight = null;
      cancelTimer();
    }
    context = normalized ? { ...normalized, scope: nextScope } : null;
    return context;
  }

  function enqueue({ kind, record, id = record && record.id, deleted = false }) {
    if (activeScope === "guest" || !id || !KINDS.includes(kind)) return false;
    const state = readScope();
    const existing = state.queue.filter((item) => item.kind === kind && item.id === String(id)).slice(-1)[0];
    const conflicted = state.conflicts.some((item) => item.kind === kind && item.assetId === String(id));
    const change = {
      kind,
      id: String(id),
      mutationId: `personal-${now()}-${Math.random().toString(36).slice(2, 9)}`,
      baseRevision: existing ? existing.baseRevision : conflicted ? 0 : Number(state.revisions[kind] && state.revisions[kind][id]) || 0,
      deleted: deleted === true,
    };
    if (!change.deleted) change.record = clone(record);
    if (existing && !existing.attempted) {
      if (existing.after) change.after = existing.after;
      state.queue = state.queue.filter((item) => item !== existing);
    } else if (existing) change.after = existing.mutationId;
    state.queue.push(change);
    writeScope(state);
    // 入队即"待同步"：还没收到服务端回执之前，界面不许显示已同步（口径第 4 条）。
    syncBook.markPending("assets", "");
    schedule();
    return true;
  }

  function applyLibrary(library, state = readScope()) {
    if (!library || !KINDS.every((kind) => Array.isArray(library[kind])) || !library.revisions || !Array.isArray(library.conflicts)) throw new Error("personal_asset_response_invalid");
    const protectedKeys = new Set(state.queue.map((item) => assetKey(item.kind, item.id)));
    const localAssets = storage.getStorageSync("shukao_user_assets") || [];
    const local = {
      packs: storage.getStorageSync("shukao_private_packs") || [],
      packCategories: storage.getStorageSync("shukao_private_pack_categories") || [],
      questions: localAssets.filter((item) => item.type === "question"),
      notes: localAssets.filter((item) => item.type === "note"),
      aiSessions: storage.getStorageSync("shukao_ai_history") || [],
    };
    library.conflicts.forEach((item) => {
      const record = local[item.kind].find((row) => row.id === item.assetId);
      if ((!record && item.incomingDeleted) || (record && JSON.stringify(record) === JSON.stringify(item.incoming))) {
        protectedKeys.add(assetKey(item.kind, item.assetId));
      }
    });
    const merged = {};
    KINDS.forEach((kind) => {
      merged[kind] = library[kind].filter((item) => !protectedKeys.has(assetKey(kind, item.id)))
        .concat(local[kind].filter((item) => protectedKeys.has(assetKey(kind, item.id))));
    });
    storage.setStorageSync("shukao_private_packs", clone(merged.packs));
    storage.setStorageSync("shukao_private_pack_categories", clone(merged.packCategories));
    storage.setStorageSync("shukao_user_assets", clone(localAssets.filter((item) => !["question", "note"].includes(item.type)).concat(merged.questions, merged.notes)));
    storage.setStorageSync("shukao_ai_history", clone(merged.aiSessions.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))));
    state.revisions = clone(library.revisions || {});
    state.conflicts = Array.isArray(library.conflicts) ? clone(library.conflicts) : [];
    state.lastError = "";
    state.attempts = 0;
    state.lastSyncedAt = now();
    writeScope(state);
    return library;
  }

  function schedule(delay = 1200) {
    if (!context) return;
    cancelTimer();
    timer = setTimeoutFn(() => { timer = null; sync(); }, delay);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function call(path, method, data, activeContext) {
    return new Promise((resolve, reject) => {
      request({
        url: `${activeContext.baseUrl}/api/personal-assets${path}`,
        method,
        data,
        timeout: 15000,
        header: { "Content-Type": "application/json", Authorization: `Bearer ${activeContext.token}` },
        success(response) {
          const body = response && response.data || {};
          if (!response || response.statusCode !== 200 || body.success !== true) {
            const error = new Error(String(body.error || "personal_asset_sync_failed"));
            error.status = response && response.statusCode;
            reject(error);
            return;
          }
          resolve(body);
        },
        fail: (error) => reject(new Error(String(error && error.errMsg || "personal_asset_network_failed"))),
      });
    });
  }

  function batch(state) {
    const seen = new Set();
    const result = [];
    let size = 0;
    for (const item of state.queue) {
      const key = assetKey(item.kind, item.id);
      if (seen.has(key) || item.after) continue;
      seen.add(key);
      if (blockedChange(item)) continue;
      const bytes = byteLength(JSON.stringify(item));
      if (bytes > 6 * 1024 * 1024) continue;
      if (result.length >= 100 || size + bytes > 6 * 1024 * 1024) break;
      size += bytes;
      item.attempted = true;
      result.push(item);
    }
    return result;
  }

  function sync() {
    if (!context) return Promise.resolve(null);
    if (flight) return flight;
    cancelTimer();
    const activeContext = context;
    const epoch = generation;
    const state = readScope();
    const sent = batch(state);
    const sentIds = new Set(sent.map((item) => item.mutationId));
    writeScope(state);
    const changes = sent.map(({ attempted, after, ...item }) => clone(item));
    const operation = call("/sync", "POST", { changes }, activeContext).then((body) => {
      if (epoch !== generation || activeScope !== activeContext.scope) return null;
      const latest = readScope();
      const receipts = body.acknowledgements || [];
      if (sent.some((item) => !receipts.some((receipt) => receipt.mutationId === item.mutationId))) throw new Error("personal_asset_receipt_missing");
      latest.queue = latest.queue.filter((item) => !sentIds.has(item.mutationId));
      for (const receipt of receipts) {
        if (!sentIds.has(receipt.mutationId)) continue;
        latest.queue.forEach((item) => {
          if (item.after !== receipt.mutationId) return;
          if (!receipt.conflictId) item.baseRevision = receipt.revision;
          delete item.after;
        });
      }
      const library = applyLibrary(body.library, latest);
      syncBook.markSynced("assets");
      if (batch(clone(latest)).length) schedule();
      return library;
    }).catch((error) => {
      if (epoch !== generation || activeScope !== activeContext.scope) return null;
      const latest = readScope();
      latest.lastError = error.message;
      latest.attempts += 1;
      writeScope(latest);
      syncBook.markPending("assets", error.message);
      if (!error.status || error.status >= 500) schedule(Math.min(60000, 2000 * 2 ** Math.min(latest.attempts, 5)));
      return null;
    }).finally(() => {
      if (flight === operation) { flight = null; onChanged(); }
    });
    flight = operation;
    return operation;
  }

  function status() {
    const state = readScope();
    const guest = readScope("guest").workspace || {};
    return {
      loggedIn: Boolean(context),
      syncing: Boolean(flight),
      queued: state.queue.length,
      conflicts: state.conflicts.length,
      conflictItems: clone(state.conflicts),
      blocked: state.queue.filter((item) => !isNoteDraft(item) && blockedChange(item)).length,
      drafts: state.queue.filter(isNoteDraft).length,
      unowned: ["shukao_private_packs", "shukao_user_assets", "shukao_ai_history"].reduce((sum, key) => sum + (Array.isArray(guest[key]) ? guest[key].length : 0), 0),
      lastError: state.lastError,
      lastSyncedAt: state.lastSyncedAt,
    };
  }

  function resolveConflict(conflictId, choice) {
    if (!context || flight) return Promise.resolve(null);
    const conflict = readScope().conflicts.find((item) => item.id === conflictId);
    if (!conflict) return Promise.resolve(null);
    if (readScope().queue.some((item) => item.kind === conflict.kind && item.id === conflict.assetId)) return Promise.resolve(null);
    const epoch = generation;
    cancelTimer();
    const operation = call(`/conflicts/${encodeURIComponent(conflictId)}/resolve`, "POST", {
      choice,
      expectedRevision: Number(conflict.currentRevision) || 0,
    }, context).then((body) => epoch === generation ? applyLibrary(body.library) : null).catch((error) => {
      if (epoch === generation) writeScope({ ...readScope(), lastError: error.message });
      return null;
    }).finally(() => {
      if (flight === operation) {
        flight = null;
        if (batch(readScope()).length) schedule();
        onChanged();
      }
    });
    flight = operation;
    return operation;
  }

  function exportAssets() {
    if (!context) return Promise.resolve(null);
    const epoch = generation;
    return call("/export", "GET", undefined, context).then((body) => epoch === generation ? body.export : null).catch(() => null);
  }

  function forget() { generation += 1; cancelTimer(); flight = null; context = null; activeScope = "guest"; }
  return {
    configure, enqueue, sync, schedule, status, resolveConflict, exportAssets, forget,
    owner: () => activeScope,
    // 登录时一次性确认归属用（个人资产 + 笔记草稿）
    pendingGuestAdoption, adoptGuestWorkspace, keepGuestWorkspace,
  };
}

let singleton = null;
let singletonStorage = null;
function personalCloudSync() {
  const storage = storageApi();
  if (!storage) return null;
  if (!singleton || singletonStorage !== storage) {
    if (singleton) singleton.forget();
    singletonStorage = storage;
    singleton = createPersonalCloudSync({ storage, request: (options) => storage.request(options), onChanged: () => {
      const app = typeof getApp === "function" ? getApp() : null;
      if (app && typeof app.onPersonalAssetsSynced === "function") app.onPersonalAssetsSynced();
    } });
  }
  return singleton;
}
function notifyPersonalAssetChanged(change, storage) {
  if (storage && storage !== storageApi()) return false;
  const sync = personalCloudSync();
  return sync ? sync.enqueue(change) : false;
}

module.exports = {
  ACTIVE_SCOPE_KEY,
  SCOPE_PREFIX,
  createPersonalCloudSync,
  notifyPersonalAssetChanged,
  personalCloudSync,
  kindForAsset,
  // 按账号命名空间存档的个人数据键与保留期限（口径第 2/6 条）
  PERSONAL_DATA_KEYS,
  PERSONAL_DATA_PREFIXES,
  CONFIRMED_ADOPTION_KEYS,
  CONFIRMED_ADOPTION_PREFIXES,
  SCOPE_RETENTION_DAYS,
  SYNCED_SNAPSHOT_RETENTION_DAYS,
  MAX_ACCOUNT_SCOPES,
};
