const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_DURATION_DAYS = 365;
const MIN_DURATION_MINUTES = 10;

const TYPE_LABELS = {
  mute: "禁言",
  no_submit: "禁止投稿",
  no_public: "公开功能限制",
  ban: "账号封禁",
};

const TYPE_DESCRIPTIONS = {
  mute: "不能投稿，也不能提交反馈与纠错（可以继续刷题、记笔记）",
  no_submit: "不能投稿社区内容，但可以提交反馈与纠错",
  no_public: "只能保存私有内容，不能公开分享、也不能成套导出分享",
  ban: "不能登录，所有写入与同步、AI 计费一律拒绝",
};

// 每种限制拦下哪些能力。能力被抽象成四个，路由按能力调用，避免每个入口各写一套判断。
const TYPE_CAPABILITIES = {
  mute: ["speak", "submit"],
  no_submit: ["submit"],
  no_public: ["publish"],
  ban: ["speak", "submit", "publish", "write"],
};

const TYPE_KEYS = new Set(Object.keys(TYPE_LABELS));
const CAPABILITY_KEYS = ["speak", "submit", "publish", "write"];
const RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialState() {
  return { restrictions: [] };
}

function cleanText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function formatUntil(timestamp) {
  const date = new Date(Number(timestamp) || 0);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 记录对外投影：status 由 liftedAt / expiresAt 派生，不额外存字段，避免到期状态写脏。 */
function decorate(item, now = Date.now()) {
  const lifted = Boolean(item.liftedAt);
  const expired = Number(item.expiresAt) <= now;
  const status = lifted ? "lifted" : (expired ? "expired" : "active");
  return {
    id: item.id,
    userId: item.userId,
    type: item.type,
    typeLabel: TYPE_LABELS[item.type] || item.type,
    typeDescription: TYPE_DESCRIPTIONS[item.type] || "",
    reason: item.reason,
    note: item.note || "",
    startsAt: item.startsAt,
    expiresAt: item.expiresAt,
    status,
    statusLabel: status === "active" ? "生效中" : (status === "lifted" ? "已解除" : "已到期"),
    unitLabel: formatUntil(item.expiresAt),
    createdBy: item.createdBy || "",
    createdById: item.createdById || "",
    liftedBy: item.liftedBy || "",
    liftedById: item.liftedById || "",
    liftedAt: item.liftedAt || 0,
    history: clone(item.history || []),
  };
}

function createUserRestrictionStore(adapter) {
  const read = () => clone(adapter.read());
  const write = (state) => adapter.write(clone(state));

  const activeItems = (state, now) => state.restrictions.filter((item) => !item.liftedAt && Number(item.expiresAt) > now);
  const itemsForUser = (state, userId, now) => activeItems(state, now).filter((item) => item.userId === userId);

  function blockedCapabilities(items) {
    const blocked = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false]));
    items.forEach((item) => {
      (TYPE_CAPABILITIES[item.type] || []).forEach((capability) => { blocked[capability] = true; });
    });
    return blocked;
  }

  function statusFrom(items, userId) {
    const blocked = blockedCapabilities(items);
    const until = items.reduce((max, item) => Math.max(max, Number(item.expiresAt) || 0), 0);
    const labels = [...new Set(items.map((item) => TYPE_LABELS[item.type] || item.type))];
    return {
      userId,
      active: blocked,
      restricted: items.length > 0,
      // 能力名与限制类型分开：路由只关心能力，运营只关心类型。
      capabilities: { speak: blocked.speak, submit: blocked.submit, publish: blocked.publish, write: blocked.write },
      activeTypes: [...new Set(items.map((item) => item.type))],
      activeTypeLabels: labels,
      expiresAt: until,
      untilLabel: until ? formatUntil(until) : "",
      message: items.length
        ? `你的账号已被${labels.join("、")}，${formatUntil(until)} 到期。`
        : "",
      items: items.map((item) => decorate(item)),
    };
  }

  function resolveExpiry({ durationDays, expiresAt }, now) {
    if (expiresAt !== undefined && expiresAt !== null && expiresAt !== "") {
      const value = Number(expiresAt);
      if (!Number.isFinite(value)) throw new Error("user_restriction_expiry_invalid");
      if (value <= now) throw new Error("user_restriction_expiry_in_past");
      if (value > now + MAX_DURATION_DAYS * 24 * 60 * 60 * 1000) throw new Error("user_restriction_expiry_too_far");
      return value;
    }
    const days = Number(durationDays);
    if (!Number.isFinite(days)) throw new Error("user_restriction_duration_required");
    if (days * 24 * 60 < MIN_DURATION_MINUTES) throw new Error("user_restriction_duration_too_short");
    if (days > MAX_DURATION_DAYS) throw new Error("user_restriction_duration_too_long");
    return now + Math.round(days * 24 * 60 * 60 * 1000);
  }

  /** 同一用户同一类型还在生效时视为“延长/改期”，而不是叠一堆重复记录。 */
  function applyOne(state, payload, now) {
    const existing = itemsForUser(state, payload.userId, now).find((item) => item.type === payload.type);
    if (existing) {
      existing.history = [...(existing.history || []), {
        action: "extend",
        reason: payload.reason,
        expiresAt: payload.expiresAt,
        actor: payload.createdBy,
        createdAt: now,
      }];
      existing.reason = payload.reason || existing.reason;
      existing.expiresAt = Math.max(Number(existing.expiresAt), payload.expiresAt);
      existing.updatedAt = now;
      return existing;
    }
    const item = {
      id: `restriction-${crypto.randomUUID()}`,
      userId: payload.userId,
      type: payload.type,
      reason: payload.reason,
      note: payload.note || "",
      startsAt: now,
      expiresAt: payload.expiresAt,
      createdBy: payload.createdBy || "",
      createdById: payload.createdById || "",
      liftedAt: 0,
      liftedBy: "",
      liftedById: "",
      createdAt: now,
      updatedAt: now,
      retentionUntil: 0,
      history: [{ action: "apply", reason: payload.reason, expiresAt: payload.expiresAt, actor: payload.createdBy, createdAt: now }],
    };
    state.restrictions.unshift(item);
    return item;
  }

  return {
    exportState: () => clone(adapter.read()),
    replaceState: (state) => { write(state && Array.isArray(state.restrictions) ? state : initialState()); return clone(adapter.read()); },

    list(filters = {}, now = Date.now()) {
      const state = read();
      const userId = cleanText(filters.userId, 80);
      const type = cleanText(filters.type || "all", 40);
      const status = cleanText(filters.status || "all", 40);
      const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
      const items = state.restrictions
        .filter((item) => {
          if (userId && item.userId !== userId) return false;
          if (type !== "all" && item.type !== type) return false;
          const decorated = decorate(item, now);
          if (status !== "all" && decorated.status !== status) return false;
          return true;
        })
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .slice(0, limit)
        .map((item) => decorate(item, now));
      return {
        items,
        summary: {
          total: state.restrictions.length,
          active: state.restrictions.filter((item) => decorate(item, now).status === "active").length,
          banned: state.restrictions.filter((item) => decorate(item, now).status === "active" && item.type === "ban").length,
          muted: state.restrictions.filter((item) => decorate(item, now).status === "active" && item.type === "mute").length,
        },
      };
    },

    statusFor(userId, now = Date.now()) {
      const state = read();
      return statusFrom(itemsForUser(state, String(userId || ""), now), String(userId || ""));
    },

    /** 后台用户列表一次取齐当前限制状态，避免逐用户重复读整个 Store。 */
    statusesFor(userIds = [], now = Date.now()) {
      const targets = [...new Set((Array.isArray(userIds) ? userIds : []).map((item) => String(item || "").trim()).filter(Boolean))];
      const byUser = new Map(targets.map((userId) => [userId, []]));
      activeItems(read(), now).forEach((item) => {
        if (byUser.has(item.userId)) byUser.get(item.userId).push(item);
      });
      return Object.fromEntries(targets.map((userId) => [userId, statusFrom(byUser.get(userId) || [], userId)]));
    },

    apply({ userId, types, type, reason, durationDays, expiresAt, createdBy, createdById, note } = {}, now = Date.now()) {
      const target = cleanText(userId, 80);
      if (!target) throw new Error("user_restriction_target_required");
      const list = (Array.isArray(types) ? types : [type]).map((item) => cleanText(item, 40)).filter(Boolean);
      if (!list.length) throw new Error("user_restriction_type_required");
      list.forEach((item) => { if (!TYPE_KEYS.has(item)) throw new Error("user_restriction_type_invalid"); });
      const expires = resolveExpiry({ durationDays, expiresAt }, now);
      const cleanReason = cleanText(reason, 300);
      if (!cleanReason) throw new Error("user_restriction_reason_required");
      const state = read();
      const created = list.map((item) => applyOne(state, {
        userId: target,
        type: item,
        reason: cleanReason,
        note,
        expiresAt: expires,
        createdBy: cleanText(createdBy, 60),
        createdById: cleanText(createdById, 80),
      }, now));
      write(state);
      return { items: created.map((item) => decorate(item, now)), status: statusFrom(itemsForUser(state, target, now), target) };
    },

    lift(id, { liftedBy, liftedById, note } = {}, now = Date.now()) {
      const state = read();
      const item = state.restrictions.find((entry) => entry.id === String(id || ""));
      if (!item) throw new Error("user_restriction_not_found");
      if (item.liftedAt) throw new Error("user_restriction_already_lifted");
      if (Number(item.expiresAt) <= now) throw new Error("user_restriction_already_expired");
      item.liftedAt = now;
      item.liftedBy = cleanText(liftedBy, 60);
      item.liftedById = cleanText(liftedById, 80);
      item.updatedAt = now;
      item.history = [...(item.history || []), { action: "lift", note: cleanText(note, 300), actor: item.liftedBy, createdAt: now }];
      write(state);
      return decorate(item, now);
    },

    /** 注销时保留治理记录，但解除与原账号的直接关联。 */
    anonymizeUser(userId, now = Date.now()) {
      const target = String(userId || "").trim();
      if (!target) return 0;
      const state = read();
      let changed = 0;
      state.restrictions.forEach((item) => {
        if (item.userId !== target) return;
        item.userId = "anonymous";
        item.anonymizedAt = now;
        item.retentionUntil = Math.max(Number(item.retentionUntil) || 0, now + RETENTION_DAYS * DAY_MS);
        item.updatedAt = now;
        changed += 1;
      });
      if (changed) write(state);
      return changed;
    },

    /** 到期或已解除的记录不参与判定，这里只做一次惰性清理，避免文件无限增长。 */
    sweep(now = Date.now(), retentionDays = 90) {
      const state = read();
      const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
      const before = state.restrictions.length;
      state.restrictions = state.restrictions.filter((item) => (
        Number(item.retentionUntil) > now
        || (!item.retentionUntil && (Number(item.expiresAt) > cutoff || item.liftedAt > cutoff))
      ));
      if (state.restrictions.length !== before) write(state);
      return before - state.restrictions.length;
    },
  };
}

function createFileUserRestrictionStore(filePath = path.resolve(__dirname, "../../../.runtime/user-restrictions.json")) {
  return createUserRestrictionStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return { restrictions: Array.isArray(value.restrictions) ? value.restrictions : [] };
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

function createMemoryUserRestrictionStore(state = initialState()) {
  let value = clone(state);
  return createUserRestrictionStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = {
  MAX_DURATION_DAYS,
  TYPE_DESCRIPTIONS,
  TYPE_LABELS,
  createFileUserRestrictionStore,
  createMemoryUserRestrictionStore,
  initialState,
};
