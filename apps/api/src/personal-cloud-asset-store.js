const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const COLLECTIONS = ["packs", "packCategories", "questions", "notes", "aiSessions"];
const clone = (value) => JSON.parse(JSON.stringify(value));
const initialState = () => ({ users: {} });
const maps = () => Object.fromEntries(COLLECTIONS.map((kind) => [kind, {}]));
const emptyUser = () => ({ ...Object.fromEntries(COLLECTIONS.map((kind) => [kind, []])), revisions: maps(), deleted: maps(), conflicts: [], revision: 0, receipts: {} });

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function idOf(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || value === "prototype" || Object.prototype.hasOwnProperty.call(Object.prototype, value)) throw new Error("personal_asset_id_invalid");
  return value;
}

function normalizeChange(raw) {
  if (!raw || !COLLECTIONS.includes(raw.kind)) throw new Error("personal_asset_kind_invalid");
  const kind = raw.kind;
  const id = idOf(raw.id);
  const mutationId = idOf(raw.mutationId);
  const baseRevision = raw.baseRevision;
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error("personal_asset_revision_invalid");
  if (raw.deleted === true) return { kind, id, mutationId, baseRevision, deleted: true };
  const record = raw.record;
  if (!record || typeof record !== "object" || Array.isArray(record) || record.id !== id) throw new Error("personal_asset_record_invalid");
  const text = JSON.stringify(record);
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new Error("personal_asset_too_large");
  // Device-only paths cannot be restored by another device. Never acknowledge them as cloud attachments.
  if (/(?:wxfile:\/\/|file:\/\/|https?:\/\/(?:tmp|usr)\/)/i.test(text)) throw new Error("personal_asset_local_attachment");
  if (kind === "notes" && record.type !== "note") throw new Error("personal_asset_note_invalid");
  if (kind === "questions" && record.type !== "question") throw new Error("personal_asset_question_invalid");
  if (kind === "aiSessions" && (!Array.isArray(record.messages) || record.messages.some((message) => !message || !["user", "assistant"].includes(message.role) || typeof message.text !== "string" || message.streaming === true))) throw new Error("personal_asset_conversation_invalid");
  return { kind, id, mutationId, baseRevision, record: clone(record), deleted: false };
}

function publicLibrary(user) {
  const result = clone(user);
  delete result.receipts;
  result.conflicts = result.conflicts.filter((item) => !item.resolvedAt).map((item) => ({
    ...item,
    current: clone(user[item.kind].find((record) => record.id === item.assetId) || null),
    currentRevision: user.revisions[item.kind][item.assetId] || 0,
  }));
  return result;
}

function applyChange(user, change, now) {
  const { kind, id } = change;
  user.revision += 1;
  user[kind] = user[kind].filter((item) => item.id !== id);
  user.revisions[kind][id] = user.revision;
  if (change.deleted) {
    user.deleted[kind][id] = user.revision;
    user.conflicts = user.conflicts.filter((item) => item.kind !== kind || item.assetId !== id);
  }
  else {
    user[kind].push(clone(change.record));
    delete user.deleted[kind][id];
  }
  user.updatedAt = now;
}

function createPersonalCloudAssetStore({ read, write }) {
  return {
    get(userId) {
      return publicLibrary(read().users[idOf(userId)] || emptyUser());
    },
    sync(userId, payload = {}, now = Date.now()) {
      const key = idOf(userId);
      if (!payload || typeof payload !== "object" || (payload.changes !== undefined && !Array.isArray(payload.changes))) throw new Error("personal_asset_changes_invalid");
      const raw = payload.changes || [];
      if (raw.length > 500) throw new Error("personal_asset_batch_too_large");
      const changes = raw.map(normalizeChange);
      const state = read();
      const user = clone(state.users[key] || emptyUser());
      if (!changes.length) return { uploaded: false, acknowledgements: [], library: publicLibrary(user) };
      let modified = false;
      for (const change of changes) {
        const hash = fingerprint(change);
        const receipt = user.receipts[change.mutationId];
        if (receipt) {
          if (receipt.hash !== hash) throw new Error("personal_asset_mutation_reused");
          continue;
        }
        // Explicit limits fail atomically rather than silently discarding content or retry receipts.
        if (Object.keys(user.receipts).length >= 100000) throw new Error("personal_asset_receipt_limit");
        const revision = user.revisions[change.kind][change.id] || 0;
        const existing = user[change.kind].find((item) => item.id === change.id);
        const identical = change.deleted ? Boolean(user.deleted[change.kind][change.id]) : existing && fingerprint(existing) === fingerprint(change.record);
        if (change.baseRevision !== revision && !identical) {
          const conflict = {
            id: `conflict-${fingerprint([change.kind, change.id, change.mutationId]).slice(0, 32)}`,
            kind: change.kind,
            assetId: change.id,
            incoming: change.deleted ? null : clone(change.record),
            incomingDeleted: change.deleted,
            current: existing ? clone(existing) : null,
            currentRevision: revision,
            createdAt: now,
          };
          user.conflicts.push(conflict);
          user.receipts[change.mutationId] = { hash, conflictId: conflict.id };
        } else {
          if (!identical) applyChange(user, change, now);
          user.receipts[change.mutationId] = { hash, revision: user.revisions[change.kind][change.id] || 0 };
        }
        modified = true;
      }
      if (modified) {
        state.users[key] = user;
        write(state);
      }
      const acknowledgements = changes.map((change) => {
        const { hash, ...receipt } = user.receipts[change.mutationId];
        return { mutationId: change.mutationId, ...receipt };
      });
      return { uploaded: modified, acknowledgements, library: publicLibrary(user) };
    },
    resolve(userId, conflictId, { choice, expectedRevision } = {}, now = Date.now()) {
      const state = read();
      const key = idOf(userId);
      const user = state.users[key];
      const conflict = user && user.conflicts.find((item) => item.id === conflictId);
      if (!conflict) throw new Error("personal_asset_conflict_not_found");
      if (conflict.resolvedAt) return publicLibrary(user);
      if (!["incoming", "current"].includes(choice)) throw new Error("personal_asset_choice_invalid");
      const revision = user.revisions[conflict.kind][conflict.assetId] || 0;
      if (revision !== expectedRevision) throw new Error("personal_asset_conflict_changed");
      // Resolution never destroys either version; private export retains the full conflict record.
      conflict.resolvedCurrent = user[conflict.kind].find((item) => item.id === conflict.assetId) || null;
      if (choice === "incoming") applyChange(user, { kind: conflict.kind, id: conflict.assetId, record: conflict.incoming, deleted: conflict.incomingDeleted }, now);
      conflict.resolvedAt = now;
      conflict.choice = choice;
      write(state);
      return publicLibrary(user);
    },
    exportUser(userId) {
      const user = clone(read().users[idOf(userId)] || emptyUser());
      delete user.receipts;
      return { schemaVersion: 1, exportedAt: Date.now(), library: user };
    },
    deleteUser(userId) {
      const state = read();
      const key = idOf(userId);
      if (!Object.prototype.hasOwnProperty.call(state.users, key)) return false;
      delete state.users[key];
      write(state);
      return true;
    },
    exportState() { return clone(read()); },
  };
}

function createFilePersonalCloudAssetStore(filePath = path.resolve(__dirname, "../../../.runtime/personal-cloud-assets.json")) {
  return createPersonalCloudAssetStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!value || !value.users || typeof value.users !== "object" || Array.isArray(value.users)) throw new Error("personal_asset_store_invalid");
        return value;
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

function createMemoryPersonalCloudAssetStore(state = initialState()) {
  let value = clone(state);
  return createPersonalCloudAssetStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = { COLLECTIONS, createFilePersonalCloudAssetStore, createMemoryPersonalCloudAssetStore, createPersonalCloudAssetStore, emptyUser, initialState };
