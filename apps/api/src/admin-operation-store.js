const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value !== "object") return typeof value === "string" ? cleanText(value, 300) : value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(api.?key|secret|password|token|prompt|answer|content|body)/i.test(key))
    .slice(0, 30)
    .map(([key, item]) => [key, sanitizeMetadata(item, depth + 1)]));
}

function createAdminOperationStore(adapter) {
  const read = () => adapter.read().map(clone);
  const write = (items) => adapter.write(items.map(clone));
  return {
    exportState: () => clone(adapter.read()),
    replaceState: (items) => { write(Array.isArray(items) ? items : []); return clone(adapter.read()); },
    append(payload) {
      const item = {
        id: `operation-${crypto.randomUUID()}`,
        // actorId 是稳定的账号主键，actor/actorRole 只是显示信息；同名账号靠 actorId 区分。
        actorId: cleanText(payload.actorId, 80),
        actor: cleanText(payload.actor || "超级管理员", 60),
        actorRole: cleanText(payload.actorRole || "super_admin", 60),
        action: cleanText(payload.action, 100),
        category: cleanText(payload.category || String(payload.action || "").split(".")[0] || "system", 60),
        targetType: cleanText(payload.targetType || "system", 60),
        targetId: cleanText(payload.targetId, 160),
        summary: cleanText(payload.summary, 300),
        metadata: sanitizeMetadata(payload.metadata || {}),
        createdAt: Number(payload.createdAt) || Date.now(),
      };
      if (!item.action || !item.summary) throw new Error("operation_required_fields_missing");
      write([item, ...read()].slice(0, 5000));
      return clone(item);
    },
    list(filters = {}) {
      const category = cleanText(filters.category || "all");
      const actor = cleanText(filters.actor || "all");
      const query = cleanText(filters.query, 200).toLowerCase();
      const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
      const all = read();
      const items = all.filter((item) => {
        if (category !== "all" && item.category !== category) return false;
        if (actor !== "all" && item.actor !== actor) return false;
        if (query && ![item.action, item.summary, item.targetId, item.actor]
          .join(" ").toLowerCase().includes(query)) return false;
        return true;
      }).sort((left, right) => right.createdAt - left.createdAt).slice(0, limit);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      return {
        items,
        summary: {
          total: all.length,
          today: all.filter((item) => item.createdAt >= todayStart.getTime()).length,
          categories: [...new Set(all.map((item) => item.category))].sort().map((name) => ({
            name,
            count: all.filter((item) => item.category === name).length,
          })),
          actors: [...new Set(all.map((item) => item.actor))].sort(),
        },
      };
    },
  };
}

function createFileAdminOperationStore(filePath = path.resolve(__dirname, "../../../.runtime/admin-actions.json")) {
  return createAdminOperationStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(value) ? value : [];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return [];
      }
    },
    write(items) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryAdminOperationStore(initialItems = []) {
  let items = clone(initialItems);
  return createAdminOperationStore({ read: () => clone(items), write: (next) => { items = clone(next); } });
}

module.exports = { createFileAdminOperationStore, createMemoryAdminOperationStore, sanitizeMetadata };
