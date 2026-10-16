const fs = require("node:fs");
const path = require("node:path");

// 「平台设置」——用户端可见法务/平台文本的唯一维护处。
//
// 口径（产品负责人 2026-10-05 确认，5 项决策）：
//   1. 用户端只读「已发布」版本；没有已发布版本时必须显式显示「尚未发布」，
//      不得拿占位或硬编码文本伪装成正式协议。
//   2. 后台只维护 正文 / 版本号 / 生效日期 / 发布·下架；**发布即锁死**（2026-10-05 追加确认）——
//      草稿可以反复改写（没人同意过、也没下发过）；一旦发布，正文与生效日期都不可再改写，
//      要改就新增一版，旧版本连同生效时间留在历史里（不覆盖、不删除）。
//   3. 「当前版本」只有 publish 一个来源：同一文档同时只有一版是 published，
//      发布新版时旧的已发布版转 retired（保留正文与生效时间）；发布时可补填生效日期。
//   4. 后台权限：登记在 server.js 的 SUPER_ADMIN_ONLY_ADMIN_PATHS → **只放行超级管理员**，
//      不为运营操作员开放（协议文本有法律效力，改协议是治理边界）。
//   5. 文档集合固定 7 份（含「个人信息收集清单」独立成篇；营业执照并入「运营主体与客服信息」）。
//
// 种子数据只建 7 份**空骨架**：不预置任何假协议文本——未发布就是未发布。

const MAX_BODY_LENGTH = 200000;
const MAX_VERSION_LENGTH = 40;
const MAX_NOTE_LENGTH = 200;

const DOC_DEFINITIONS = [
  { key: "terms", title: "用户协议", group: "协议" },
  { key: "privacy", title: "隐私政策", group: "协议" },
  { key: "ai-service", title: "AI 服务说明", group: "服务" },
  { key: "refund", title: "退款政策", group: "交易" },
  { key: "account-deletion", title: "账号注销说明", group: "账号" },
  { key: "operator", title: "运营主体与客服信息", group: "主体" },
  { key: "personal-info", title: "个人信息收集清单", group: "协议" },
];

const VERSION_STATUSES = ["draft", "published", "retired"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, maxLength) {
  return String(value === null || value === undefined ? "" : value).trim().slice(0, maxLength);
}

function requireText(value, maxLength, tooLongError) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (text.length > maxLength) throw new Error(tooLongError);
  return text;
}

function nowStamp() {
  return Date.now();
}

// 生效日期统一成 YYYY-MM-DD：已是该形状就原样保留，否则按可解析时间取本机日期。
function normalizeEffectiveDate(value) {
  if (value === "" || value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const numeric = Number(text);
  const parsed = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error("platform_content_effective_date_invalid");
  const date = new Date(parsed);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function findDefinition(key) {
  const target = cleanText(key, MAX_VERSION_LENGTH);
  return DOC_DEFINITIONS.find((item) => item.key === target) || null;
}

function seedPlatformContent() {
  const documents = {};
  for (const definition of DOC_DEFINITIONS) {
    documents[definition.key] = {
      key: definition.key,
      title: definition.title,
      group: definition.group,
      versions: [],
      currentVersion: null,
    };
  }
  return { documents, updatedAt: 0 };
}

function normalizeVersionRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const version = cleanText(raw.version, MAX_VERSION_LENGTH);
  if (!version) return null;
  const status = VERSION_STATUSES.includes(raw.status) ? raw.status : "draft";
  return {
    version,
    body: String(raw.body === null || raw.body === undefined ? "" : raw.body),
    effectiveDate: normalizeEffectiveDate(raw.effectiveDate),
    status,
    note: cleanText(raw.note, MAX_NOTE_LENGTH),
    createdAt: Number(raw.createdAt) || 0,
    createdBy: cleanText(raw.createdBy, 60),
    // 草稿改写痕迹（2026-10-05）：已发布版本不会有这两个值。
    updatedAt: Number(raw.updatedAt) || null,
    updatedBy: cleanText(raw.updatedBy, 60),
    publishedAt: Number(raw.publishedAt) || null,
    firstPublishedAt: Number(raw.firstPublishedAt) || Number(raw.publishedAt) || null,
    publishedBy: cleanText(raw.publishedBy, 60),
    retiredAt: Number(raw.retiredAt) || null,
  };
}

/**
 * 归一化整份状态：固定 7 份文档一定存在；版本按写入顺序保留（append-only）；
 * 同一文档最多一版 published（以 currentVersion 为准，多余的降级为 retired）。
 */
function normalizeState(rawState) {
  const rawDocuments = (rawState && typeof rawState === "object" && rawState.documents && typeof rawState.documents === "object")
    ? rawState.documents
    : {};
  const documents = {};
  for (const definition of DOC_DEFINITIONS) {
    const raw = rawDocuments[definition.key] && typeof rawDocuments[definition.key] === "object" ? rawDocuments[definition.key] : {};
    const versions = (Array.isArray(raw.versions) ? raw.versions : []).map(normalizeVersionRecord).filter(Boolean);
    let currentVersion = versions.some((item) => item.version === raw.currentVersion && item.status === "published") ? raw.currentVersion : null;
    if (!currentVersion) {
      const published = versions.find((item) => item.status === "published");
      currentVersion = published ? published.version : null;
    }
    for (const version of versions) {
      if (version.status === "published" && version.version !== currentVersion) {
        version.status = "retired";
        version.retiredAt = version.retiredAt || nowStamp();
      }
    }
    documents[definition.key] = {
      key: definition.key,
      title: definition.title,
      group: definition.group,
      versions,
      currentVersion,
    };
  }
  return { documents, updatedAt: Number(rawState && rawState.updatedAt) || 0 };
}

function documentStatus(document) {
  if (!document.versions.length) return "empty";
  return document.currentVersion ? "published" : "draft";
}

function currentVersionOf(document) {
  if (!document.currentVersion) return null;
  return document.versions.find((item) => item.version === document.currentVersion) || null;
}

function versionSummary(version) {
  return {
    version: version.version,
    status: version.status,
    effectiveDate: version.effectiveDate,
    note: version.note,
    // 后台历史要能「载入旧版正文」再改出新版本，所以这里带正文；用户端接口不走这个函数。
    body: version.body,
    bodyLength: version.body.length,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
    updatedAt: version.updatedAt || null,
    updatedBy: version.updatedBy || "",
    publishedAt: version.publishedAt,
    firstPublishedAt: version.firstPublishedAt || version.publishedAt || null,
    publishedBy: version.publishedBy,
    retiredAt: version.retiredAt,
  };
}

function documentSummary(document) {
  const current = currentVersionOf(document);
  return {
    key: document.key,
    title: document.title,
    group: document.group,
    status: documentStatus(document),
    currentVersion: document.currentVersion,
    effectiveDate: current ? current.effectiveDate : null,
    publishedAt: current ? current.publishedAt : null,
    versionCount: document.versions.length,
    draftCount: document.versions.filter((item) => item.status === "draft").length,
    updatedAt: document.versions.reduce((latest, item) => Math.max(latest, item.createdAt || 0), 0),
  };
}

function createPlatformContentStore(adapter) {
  const read = () => normalizeState(clone(adapter.read()));
  const write = (state) => adapter.write(clone(state));
  const requireDocument = (state, key) => {
    const definition = findDefinition(key);
    if (!definition) throw new Error("platform_content_unknown_document");
    return state.documents[definition.key];
  };

  return {
    exportState: () => clone(read()),
    definitions: () => DOC_DEFINITIONS.map((item) => ({ ...item })),

    // 后台视图：全部文档（含草稿、历史版本与正文）。
    documents() {
      return clone(read());
    },

    summaries() {
      const state = read();
      return DOC_DEFINITIONS.map((definition) => documentSummary(state.documents[definition.key]));
    },

    history(key) {
      const state = read();
      const document = requireDocument(state, key);
      return clone(document.versions.slice().reverse().map(versionSummary));
    },

    // 用户端视图：只暴露已发布版本。
    publicList() {
      const state = read();
      return DOC_DEFINITIONS
        .map((definition) => state.documents[definition.key])
        .filter((document) => Boolean(document.currentVersion))
        .map((document) => {
          const current = currentVersionOf(document);
          return {
            key: document.key,
            title: document.title,
            group: document.group,
            version: current.version,
            effectiveDate: current.effectiveDate,
            publishedAt: current.publishedAt,
          };
        });
    },

    publicDocument(key) {
      const state = read();
      const document = requireDocument(state, key);
      const current = currentVersionOf(document);
      if (!current) {
        return {
          key: document.key,
          title: document.title,
          group: document.group,
          published: false,
          status: documentStatus(document),
        };
      }
      return {
        key: document.key,
        title: document.title,
        group: document.group,
        published: true,
        version: current.version,
        effectiveDate: current.effectiveDate,
        body: current.body,
        publishedAt: current.publishedAt,
      };
    },

    current(key) {
      const state = read();
      const document = requireDocument(state, key);
      const current = currentVersionOf(document);
      return current ? clone(current) : null;
    },

    // 新增或更新草稿：同一文档内版本号唯一，但**草稿可改写**（2026-10-05 产品负责人选定）——
    // 草稿没有任何用户同意记录、也没下发过，允许反复修改；一旦发布即锁死（正文与生效日期都不可再改）。
    saveVersion(key, payload = {}, actor = "系统") {
      const state = read();
      const document = requireDocument(state, key);
      const version = cleanText(payload.version, MAX_VERSION_LENGTH + 1);
      if (!version) throw new Error("platform_content_version_required");
      if (version.length > MAX_VERSION_LENGTH) throw new Error("platform_content_version_too_long");
      const body = requireText(payload.body, MAX_BODY_LENGTH, "platform_content_body_too_long");
      if (!body) throw new Error("platform_content_body_required");
      const existing = document.versions.find((item) => item.version === version);
      const effectiveDate = normalizeEffectiveDate(payload.effectiveDate);
      const note = cleanText(payload.note, MAX_NOTE_LENGTH);
      if (existing) {
        // 已发布/已下架的历史版本一律不可改写：改版只能新增版本号。
        if (existing.status !== "draft") throw new Error("platform_content_version_conflict");
        existing.body = body;
        // 留空＝沿用这一版原本的生效日期（重存草稿不该把已经定好的日期悄悄清掉）；要改就显式填新日期。
        if (effectiveDate) existing.effectiveDate = effectiveDate;
        existing.note = note;
        existing.updatedAt = nowStamp();
        existing.updatedBy = cleanText(actor, 60);
        state.updatedAt = existing.updatedAt;
        write(state);
        return clone(existing);
      }
      const record = {
        version,
        body,
        effectiveDate,
        status: "draft",
        note,
        createdAt: nowStamp(),
        createdBy: cleanText(actor, 60),
        updatedAt: null,
        updatedBy: "",
        publishedAt: null,
        publishedBy: "",
        retiredAt: null,
      };
      document.versions.push(record);
      state.updatedAt = record.createdAt;
      write(state);
      return clone(record);
    },

    // 发布指定版本：允许在"草稿 → 发布"这一步补填生效日期（草稿常常先存正文、后定生效日）。
    // 已发布版本不可改写：重复发布同一版本直接返回；曾发布过（retired）的版本可以重新发布（回滚），
    // 但它的正文、生效日期与首次发布时间都不改写。
    publish(key, version, actor = "系统", options = {}) {
      const state = read();
      const document = requireDocument(state, key);
      const target = document.versions.find((item) => item.version === cleanText(version, MAX_VERSION_LENGTH));
      if (!target) throw new Error("platform_content_version_not_found");
      const suppliedDate = options.effectiveDate === undefined || options.effectiveDate === null ? "" : String(options.effectiveDate).trim();
      if (suppliedDate && target.status === "draft") target.effectiveDate = normalizeEffectiveDate(suppliedDate);
      if (!target.effectiveDate) throw new Error("platform_content_effective_date_required");
      if (target.status === "published") return documentSummary(document);
      const stamp = nowStamp();
      const everPublished = Boolean(target.publishedAt);
      for (const item of document.versions) {
        if (item.status === "published") {
          item.status = "retired";
          item.retiredAt = stamp;
        }
      }
      target.status = "published";
      if (!everPublished) target.firstPublishedAt = stamp;
      target.publishedAt = stamp;
      target.publishedBy = cleanText(actor, 60);
      target.retiredAt = null;
      document.currentVersion = target.version;
      state.updatedAt = stamp;
      write(state);
      return documentSummary(document);
    },

    unpublish(key) {
      const state = read();
      const document = requireDocument(state, key);
      const current = currentVersionOf(document);
      if (!current) throw new Error("platform_content_not_published");
      const stamp = nowStamp();
      current.status = "retired";
      current.retiredAt = stamp;
      document.currentVersion = null;
      state.updatedAt = stamp;
      write(state);
      return documentSummary(document);
    },

    // 整体替换（恢复/回填用）。归一化会保留全部历史版本，不会因替换丢掉已发布版本。
    replaceState(nextState) {
      const normalized = normalizeState(nextState);
      normalized.updatedAt = normalized.updatedAt || nowStamp();
      write(normalized);
      return clone(normalized);
    },
  };
}

function createFilePlatformContentStore(filePath = path.resolve(__dirname, "../../../.runtime/platform-content.json")) {
  return createPlatformContentStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return value && typeof value === "object" ? value : seedPlatformContent();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return seedPlatformContent();
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

function createMemoryPlatformContentStore(initialState = seedPlatformContent()) {
  let state = clone(initialState);
  return createPlatformContentStore({
    read: () => clone(state),
    write: (next) => { state = clone(next); },
  });
}

module.exports = {
  DOC_DEFINITIONS,
  MAX_BODY_LENGTH,
  createFilePlatformContentStore,
  createMemoryPlatformContentStore,
  createPlatformContentStore,
  normalizeEffectiveDate,
  seedPlatformContent,
};
