const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function seedPacks() {
  const now = Date.now();
  return [{
    id: "pack-featured-001", name: "现代汉语语法高频易错题", description: "按知识点整理短语、句子成分与常见语法错误。", tags: ["现代汉语", "语法", "易错题"],
    creatorType: "team", creator: { id: "team-official", nickname: "薯考题库团队" }, visibility: "public", status: "featured",
    questionIds: Array.from({ length: 8 }, (_, index) => `demo-modern-chinese-${String(index + 1).padStart(3, "0")}`),
    metrics: { favorites: 286, comments: 12, copies: 38 }, version: 1,
    versions: [{ version: 1, actor: "系统种子数据", note: "创建公共精选题包", createdAt: now }], createdAt: now, updatedAt: now, updatedBy: "系统种子数据",
  }];
}

function normalizePack(payload, existing = null) {
  const name = String(payload.name ?? existing?.name ?? "").trim().slice(0, 100);
  const description = String(payload.description ?? existing?.description ?? "").trim().slice(0, 1000);
  const questionIds = [...new Set((Array.isArray(payload.questionIds) ? payload.questionIds : (existing?.questionIds || [])).map((item) => String(item).trim()).filter(Boolean))].slice(0, 500);
  const tags = [...new Set((Array.isArray(payload.tags) ? payload.tags : String(payload.tags ?? existing?.tags ?? "").split(/[，,；;]/)).map((item) => String(item).trim()).filter(Boolean))].slice(0, 12);
  const visibility = (payload.visibility ?? existing?.visibility) === "public" ? "public" : "private";
  if (!name) throw new Error("pack_name_required");
  return { name, description, questionIds, tags, visibility };
}

function createPackStore(adapter) {
  const read = () => adapter.read().map(clone);
  const write = (items) => adapter.write(items.map(clone));
  return {
    exportState: () => clone(adapter.read()),
    replaceState(state) {
      if (!Array.isArray(state)) throw new Error("pack_state_invalid");
      write(state);
      return clone(adapter.read());
    },
    list(filters = {}) {
      const query = String(filters.query || "").trim().toLowerCase(); const status = String(filters.status || "all"); const creatorType = String(filters.creatorType || "all"); const all = read();
      const packs = all.filter((item) => { if (status !== "all" && item.status !== status) return false; if (creatorType !== "all" && item.creatorType !== creatorType) return false; return !query || [item.name, item.description, ...(item.tags || []), item.creator?.nickname, item.id].join(" ").toLowerCase().includes(query); }).sort((left, right) => right.updatedAt - left.updatedAt);
      return { packs, counts: { total: all.length, private: all.filter((item) => item.status === "private").length, pending: all.filter((item) => item.status === "pending_review").length, public: all.filter((item) => item.status === "public").length, featured: all.filter((item) => item.status === "featured").length, offline: all.filter((item) => item.status === "offline").length } };
    },
    get(id) { const item = read().find((pack) => pack.id === id); return item ? clone(item) : null; },
    create(payload, actor = "超级管理员") {
      const packs = read(); const now = Date.now(); const values = normalizePack(payload); const creatorType = payload.creatorType === "user" ? "user" : "team";
      const pack = { id: String(payload.id || `pack-${crypto.randomUUID()}`), ...values, creatorType, creator: payload.creator || { id: "team-official", nickname: "薯考题库团队" }, status: values.visibility === "public" ? "pending_review" : "private", metrics: { favorites: 0, comments: 0, copies: 0 }, version: 1, versions: [{ version: 1, actor, note: "创建题包", createdAt: now }], createdAt: now, updatedAt: now, updatedBy: actor };
      write([pack, ...packs]); return clone(pack);
    },
    update(id, payload, actor = "超级管理员") {
      const packs = read(); const index = packs.findIndex((item) => item.id === id); if (index < 0) throw new Error("pack_not_found"); const current = packs[index]; const values = normalizePack(payload, current); const now = Date.now(); const version = current.version + 1;
      let status = current.status; if (values.visibility === "private" && ["pending_review", "public", "featured"].includes(status)) status = "private"; if (values.visibility === "public" && status === "private") status = "pending_review";
      packs[index] = { ...current, ...values, status, version, updatedAt: now, updatedBy: actor, versions: [{ version, actor, note: String(payload.changeNote || "编辑题包").slice(0, 300), createdAt: now }, ...current.versions].slice(0, 50) }; write(packs); return clone(packs[index]);
    },
    action(id, action, actor = "超级管理员") {
      const packs = read(); const index = packs.findIndex((item) => item.id === id); if (index < 0) throw new Error("pack_not_found"); const current = packs[index];
      const transitions = { submit_review: { visibility: "public", status: "pending_review" }, publish: { visibility: "public", status: "public" }, feature: { visibility: "public", status: "featured" }, offline: { status: "offline" }, restore: { status: current.visibility === "public" ? "public" : "private" }, private: { visibility: "private", status: "private" } };
      const transition = transitions[action]; if (!transition) throw new Error("pack_action_invalid"); if (["publish", "feature"].includes(action) && !current.questionIds.length) throw new Error("pack_questions_required");
      const now = Date.now(); const version = current.version + 1; packs[index] = { ...current, ...transition, version, updatedAt: now, updatedBy: actor, versions: [{ version, actor, note: ({ submit_review: "提交公开审核", publish: "通过审核并公开", feature: "加入公共精选", offline: "下架题包", restore: "恢复题包", private: "转为私人题包" })[action], createdAt: now }, ...current.versions].slice(0, 50) }; write(packs); return clone(packs[index]);
    },
  };
}

function createFilePackStore(filePath = path.resolve(__dirname, "../../../.runtime/packs.json")) { return createPackStore({ read() { try { const value = JSON.parse(fs.readFileSync(filePath, "utf8")); return Array.isArray(value) ? value : seedPacks(); } catch (error) { if (error.code !== "ENOENT") throw error; return seedPacks(); } }, write(items) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); const temporaryPath = `${filePath}.tmp`; fs.writeFileSync(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporaryPath, filePath); } }); }
function createMemoryPackStore(initialItems = seedPacks()) { let items = clone(initialItems); return createPackStore({ read: () => clone(items), write: (next) => { items = clone(next); } }); }

module.exports = { createFilePackStore, createMemoryPackStore };
