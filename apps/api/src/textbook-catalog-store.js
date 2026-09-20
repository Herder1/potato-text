const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { books } = require("../../../packages/domain/catalog");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialRecords() {
  return books.map((book) => ({
    bookId: book.id,
    status: "awaiting_pdf",
    pdf: null,
    draft: null,
    confirmed: null,
    history: [],
    updatedAt: null,
  }));
}

function normalizeCatalogSiblingLevels(nodes) {
  let numberedSiblingLevel = 0;
  return nodes.map((node) => {
    const compactTitle = String(node.title || "").replace(/\s+/g, "");
    if (Number(node.level) <= 2) numberedSiblingLevel = 0;
    if (Number(node.level) === 3 && /^一(?:、|[“《（(A-Za-z\u4e00-\u9fff])/.test(compactTitle)) numberedSiblingLevel = 3;
    if (numberedSiblingLevel === 3 && Number(node.level) > 3 && /^[二三四五六七八九十](?:、|[“《（(A-Za-z\u4e00-\u9fff])/.test(compactTitle)) {
      return { ...node, level: 3 };
    }
    return node;
  });
}

function cleanCatalogTitle(value) {
  const source = String(value || "").trim();
  const hadNullByte = source.includes("\0");
  let title = source.replace(/\0/g, "").replace(/\s+/g, " ").trim().replace(/[.;,，；。]+$/, "");
  if (hadNullByte) {
    const numberedSuffix = title.match(/([一二三四五六七八九十]+、\S.*)$/);
    if (numberedSuffix && numberedSuffix.index > 0
      && /[录里出]{2,}/.test(title.slice(0, numberedSuffix.index))) {
      title = numberedSuffix[1];
    }
  }
  return title;
}

function normalizeCatalogAuxiliaryLevels(nodes) {
  return nodes.map((node, index) => {
    const next = nodes[index + 1];
    if (!next) return node;
    const title = String(node.title || "").replace(/\s+/g, "");
    const nextTitle = String(next.title || "").replace(/\s+/g, "");
    const samePrintedPage = Number(node.startPage) === Number(next.startPage);
    const appendixBeforeNumberedSibling = /^附录/.test(title)
      && /^[一二三四五六七八九十]+、/.test(nextTitle)
      && Number(next.level) > Number(node.level)
      && samePrintedPage;
    return appendixBeforeNumberedSibling ? { ...node, level: Number(next.level) } : node;
  });
}

function normalizeCatalogPageRanges(nodes) {
  const ordered = Array.isArray(nodes) ? nodes : [];
  return ordered.map((node, index) => {
    const startPage = Math.max(1, Number(node.startPage) || 1);
    const next = ordered.slice(index + 1).find((candidate) => (
      Number(candidate.level || 1) <= Number(node.level || 1)
      && Number(candidate.startPage || 0) >= startPage
    ));
    let descendantEnd = Math.max(startPage, Number(node.endPage) || startPage);
    for (let cursor = index + 1; cursor < ordered.length; cursor += 1) {
      if (Number(ordered[cursor].level || 1) <= Number(node.level || 1)) break;
      descendantEnd = Math.max(
        descendantEnd,
        Number(ordered[cursor].startPage) || startPage,
        Number(ordered[cursor].endPage) || startPage,
      );
    }
    const fallbackEnd = descendantEnd;
    const boundaryOffset = Number(node.level || 1) <= 2 ? 1 : 0;
    return {
      ...node,
      startPage,
      endPage: next ? Math.max(startPage, (Number(next.startPage) || startPage) - boundaryOffset) : fallbackEnd,
    };
  });
}

function catalogOrdinalNumber(value) {
  const source = String(value || "").trim();
  if (/^\d+$/.test(source)) return Number(source);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const character of source) {
    if (Object.hasOwn(digits, character)) current = digits[character];
    else if (character === "十") { total += (current || 1) * 10; current = 0; }
    else if (character === "百") { total += (current || 1) * 100; current = 0; }
    else return 0;
  }
  return total + current;
}

// 把标题开头的编号形式归一成"层级种类"，用于体检时判断 level 是否偏离本书惯例。
function numberingKind(title) {
  const value = String(title || "").trim().replace(/^☆+\s*/, "");
  if (/^第[一二三四五六七八九十百零〇两0-9]+编/.test(value)) return "第X编";
  if (/^第[一二三四五六七八九十百零〇两0-9]+单元/.test(value)) return "第X单元";
  if (/^第[一二三四五六七八九十百零〇两0-9]+章/.test(value)) return "第X章";
  if (/^第[一二三四五六七八九十百零〇两0-9]+节/.test(value)) return "第X节";
  if (/^[一二三四五六七八九十百零〇两]+[、.]/.test(value)) return "一、";
  if (/^[（(][一二三四五六七八九十百零〇两0-9]+[）)]/.test(value)) return "（一）";
  if (/^\d+[.、]/.test(value)) return "1.";
  return "";
}

function auditCatalogNodes(nodes) {
  const source = Array.isArray(nodes) ? nodes : [];
  const rootLevel = Math.max(1, Number(source[0] && source[0].level) || 1);
  const issues = [];
  const addIssue = (severity, code, node, index, message) => issues.push({
    severity,
    code,
    index,
    nodeId: String(node && node.id || ""),
    title: String(node && node.title || ""),
    message,
  });
  const stack = [];
  const seen = new Map();
  const partPattern = /^(?:第[一二三四五六七八九十百零〇0-9]+[编篇]|[上中下][编篇])/;
  const chapterPattern = /^第([一二三四五六七八九十百零〇0-9]+)章/;
  const chapterGroups = new Map();
  let activePart = "根目录";
  let firstPartIndex = -1;

  source.forEach((node, index) => {
    const level = Math.max(1, Number(node.level) || 1);
    const startPage = Math.max(1, Number(node.startPage) || 1);
    const endPage = Math.max(startPage, Number(node.endPage) || startPage);
    const title = String(node.title || "").trim();
    const previous = source[index - 1];
    if (previous && level > Number(previous.level || 1) + 1) {
      addIssue("error", "level_jump", node, index, `“${title}”从 ${previous.level} 级跳到 ${level} 级`);
    }
    if (index === 0 && level > 1) {
      addIssue("warning", "root_level_missing", node, index, "目录从二级或更深层级开始，请确认是否缺少上级目录");
    }
    const parent = level > 1 ? stack[level - 2] : null;
    if (level > 1 && !parent && level !== rootLevel) {
      addIssue("error", "orphan_node", node, index, `“${title}”缺少 ${level - 1} 级父目录`);
    } else if (parent && (startPage < parent.startPage || endPage > parent.endPage + 1)) {
      addIssue("error", "outside_parent_range", node, index, `“${title}”页码 ${startPage}-${endPage} 超出父目录“${parent.title}”范围 ${parent.startPage}-${parent.endPage}`);
    }
    if (previous && startPage < Number(previous.startPage || 1)) {
      addIssue("error", "page_order_reversed", node, index, `“${title}”起始页早于上一条目录`);
    }
    const duplicateKey = `${level}:${title.replace(/\s+/g, "")}:${startPage}`;
    if (seen.has(duplicateKey)) {
      addIssue("error", "duplicate_node", node, index, `“${title}”与第 ${seen.get(duplicateKey) + 1} 条目录重复`);
    } else seen.set(duplicateKey, index);

    stack.length = level;
    stack[level - 1] = { title, startPage, endPage, level };
    if (partPattern.test(title)) {
      activePart = title;
      if (firstPartIndex < 0) firstPartIndex = index;
    }
    const chapterMatch = title.match(chapterPattern);
    if (chapterMatch) {
      if (firstPartIndex >= 0 && index > firstPartIndex && level !== 2) {
        addIssue("error", "chapter_outside_part", node, index, `“${title}”应作为“${activePart}”的二级目录`);
      }
      if (!chapterGroups.has(activePart)) chapterGroups.set(activePart, []);
      chapterGroups.get(activePart).push({ number: catalogOrdinalNumber(chapterMatch[1]), node, index });
    }
  });

  chapterGroups.forEach((chapters, group) => {
    chapters.forEach((chapter, index) => {
      const previous = chapters[index - 1];
      if (!previous || !chapter.number || !previous.number) return;
      if (chapter.number !== previous.number + 1) {
        addIssue("warning", "chapter_sequence_gap", chapter.node, chapter.index,
          `${group}章序从第 ${previous.number} 章跳到第 ${chapter.number} 章`);
      }
    });
  });

  // 标题里的编号本身就写着层级（第X章 / 第X节 / 一、/（一）/ 1.）。同一本书里同一种编号
  // 出现在"比它常见的层级更深"的位置时，几乎一定是把 level 标错了——它会挂到上一条目录
  // 底下（客户端目录只按 level 推父子），而且还会把子节点的题数汇总上去，让空目录看着有题。
  // 只报警告、不阻断确认：像“总绪论”那种浅一层的用法是合理的，深浅由人判断。
  const numberingLevels = new Map();
  source.forEach((node, index) => {
    const title = String(node.title || "").trim().replace(/^☆+\s*/, "");
    const kind = numberingKind(title);
    if (!kind) return;
    const level = Math.max(1, Number(node.level) || 1);
    if (!numberingLevels.has(kind)) numberingLevels.set(kind, new Map());
    const levels = numberingLevels.get(kind);
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push({ node, index, title });
  });
  numberingLevels.forEach((levels, kind) => {
    if (levels.size <= 1) return;
    // 取"最常见"的那一层；数量打平时取更浅的层级——没有明显多数时不要报警。
    const dominant = [...levels.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0] - right[0])[0];
    [...levels.entries()].forEach(([level, entries]) => {
      if (level <= dominant[0]) return;
      entries.forEach(({ node, index, title }) => addIssue("warning", "level_numbering_conflict", node, index,
        `“${title}”标为第 ${level} 级，但本书另外 ${dominant[1].length} 处“${kind}”都在第 ${dominant[0]} 级；这会让它挂到上一条目录下面`));
    });
  });

  const blockingCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    valid: source.length > 0 && blockingCount === 0,
    nodeCount: source.length,
    blockingCount,
    warningCount,
    issues,
  };
}

function normalizeNodes(nodes, options = {}) {
  if (!Array.isArray(nodes)) throw new Error("catalog_nodes_required");
  const normalized = nodes.map((node, index) => {
    const title = cleanCatalogTitle(node && node.title).slice(0, 240);
    const level = Math.min(5, Math.max(1, Number(node && node.level) || 1));
    const startPage = Math.max(1, Number(node && node.startPage) || 1);
    const endPage = Math.max(startPage, Number(node && node.endPage) || startPage);
    if (!title) throw new Error("catalog_node_title_required");
    return {
      id: String(node.id || `catalog-node-${crypto.randomUUID()}`),
      order: index + 1,
      level,
      title,
      startPage,
      endPage,
      evidence: String(node.evidence || "").trim().slice(0, 1200),
      knowledgePoints: (Array.isArray(node.knowledgePoints) ? node.knowledgePoints : String(node.knowledgePoints || "").split(/[；;，,]/))
        .map((item) => String(item).trim()).filter(Boolean).slice(0, 30),
    };
  }).slice(0, 600);
  const leveled = options.bookId === "modern-literature-30-years-3"
    ? normalizeCatalogSiblingLevels(normalized)
    : normalized;
  return normalizeCatalogPageRanges(normalizeCatalogAuxiliaryLevels(leveled));
}

function normalizeRecordNodes(record) {
  return {
    ...record,
    draft: record.draft && { ...record.draft, nodes: normalizeNodes(record.draft.nodes || [], { bookId: record.bookId }) },
    confirmed: record.confirmed && { ...record.confirmed, nodes: normalizeNodes(record.confirmed.nodes || [], { bookId: record.bookId }) },
  };
}

function createTextbookCatalogStore(adapter) {
  const read = () => {
    const stored = adapter.read();
    const map = new Map((Array.isArray(stored) ? stored : []).map((item) => [item.bookId, item]));
    return initialRecords().map((record) => normalizeRecordNodes({ ...record, ...(map.get(record.bookId) || {}) }));
  };
  const write = (items) => adapter.write(items.map(clone));
  const findIndex = (items, bookId) => {
    const index = items.findIndex((item) => item.bookId === bookId);
    if (index < 0) throw new Error("textbook_not_found");
    return index;
  };
  return {
    exportState: () => clone(adapter.read()),
    list() {
      const records = read();
      return {
        textbooks: books.map((book) => {
          const textbook = { ...clone(book), ...clone(records.find((item) => item.bookId === book.id)) };
          const nodes = textbook.draft && textbook.draft.nodes || textbook.confirmed && textbook.confirmed.nodes || [];
          return { ...textbook, catalogAudit: auditCatalogNodes(nodes) };
        }),
        counts: {
          total: books.length,
          awaitingPdf: records.filter((item) => !item.pdf).length,
          draftPending: records.filter((item) => item.status === "draft_pending").length,
          confirmed: records.filter((item) => item.status === "confirmed").length,
        },
      };
    },
    get(bookId) {
      const item = this.list().textbooks.find((record) => record.bookId === bookId);
      return item ? clone(item) : null;
    },
    savePdf(bookId, metadata, actor = "超级管理员") {
      const records = read();
      const index = findIndex(records, bookId);
      const now = Date.now();
      records[index] = {
        ...records[index],
        status: "pdf_uploaded",
        pdf: {
          fileName: String(metadata.fileName || "教材.pdf").slice(0, 240),
          size: Number(metadata.size) || 0,
          pageCount: Number(metadata.pageCount) || 0,
          textChars: Number(metadata.textChars) || 0,
          uploadedAt: now,
          uploadedBy: actor,
        },
        draft: null,
        updatedAt: now,
        history: [{ action: "pdf_upload", actor, note: `上传 ${metadata.fileName || "教材 PDF"}`, createdAt: now }, ...(records[index].history || [])].slice(0, 50),
      };
      write(records);
      return this.get(bookId);
    },
    setDraft(bookId, nodes, metadata = {}, actor = "超级管理员") {
      const records = read();
      const index = findIndex(records, bookId);
      const normalizedNodes = normalizeNodes(nodes, { bookId });
      const now = Date.now();
      const version = Number(records[index].draft && records[index].draft.version || 0) + 1;
      records[index] = {
        ...records[index],
        status: "draft_pending",
        draft: {
          version,
          nodes: normalizedNodes,
          source: String(metadata.source || "manual").slice(0, 80),
          model: String(metadata.model || "").slice(0, 160),
          pageRange: String(metadata.pageRange || "").slice(0, 100),
          generatedAt: now,
          updatedAt: now,
          updatedBy: actor,
        },
        updatedAt: now,
        history: [{ action: "draft_generate", actor, note: `生成目录草稿 v${version}，共 ${normalizedNodes.length} 项`, createdAt: now }, ...(records[index].history || [])].slice(0, 50),
      };
      write(records);
      return this.get(bookId);
    },
    updateDraft(bookId, nodes, actor = "超级管理员") {
      const records = read();
      const index = findIndex(records, bookId);
      if (!records[index].draft) throw new Error("catalog_draft_not_found");
      const normalizedNodes = normalizeNodes(nodes, { bookId });
      const now = Date.now();
      records[index].draft = { ...records[index].draft, nodes: normalizedNodes, updatedAt: now, updatedBy: actor };
      records[index].updatedAt = now;
      records[index].history = [{ action: "draft_update", actor, note: `人工校对目录草稿，共 ${normalizedNodes.length} 项`, createdAt: now }, ...(records[index].history || [])].slice(0, 50);
      write(records);
      return this.get(bookId);
    },
    confirm(bookId, actor = "超级管理员") {
      const records = read();
      const index = findIndex(records, bookId);
      const record = records[index];
      if (!record.draft || !record.draft.nodes.length) throw new Error("catalog_draft_not_found");
      const audit = auditCatalogNodes(record.draft.nodes);
      if (!audit.valid) {
        const error = new Error("catalog_audit_failed");
        error.audit = audit;
        throw error;
      }
      const now = Date.now();
      const version = Number(record.confirmed && record.confirmed.version || 0) + 1;
      records[index] = {
        ...record,
        status: "confirmed",
        confirmed: { version, nodes: clone(record.draft.nodes), confirmedAt: now, confirmedBy: actor, sourceDraftVersion: record.draft.version },
        draft: null,
        updatedAt: now,
        history: [{ action: "catalog_confirm", actor, note: `确认目录 v${version} 进入知识库`, createdAt: now }, ...(record.history || [])].slice(0, 50),
      };
      write(records);
      return this.get(bookId);
    },
    repairConfirmedRanges(bookId, actor = "系统目录页码修复") {
      const records = read();
      const index = findIndex(records, bookId);
      if (!records[index].confirmed) throw new Error("catalog_confirmed_not_found");
      const now = Date.now();
      records[index] = {
        ...records[index],
        confirmed: {
          ...records[index].confirmed,
          nodes: normalizeNodes(records[index].confirmed.nodes, { bookId }),
        },
        updatedAt: now,
        history: [{ action: "catalog_page_range_repair", actor, note: "修复目录层级与教材页码范围", createdAt: now }, ...(records[index].history || [])].slice(0, 50),
      };
      write(records);
      return this.get(bookId);
    },
    rejectDraft(bookId, note = "", actor = "超级管理员") {
      const records = read();
      const index = findIndex(records, bookId);
      if (!records[index].draft) throw new Error("catalog_draft_not_found");
      const now = Date.now();
      records[index] = {
        ...records[index],
        status: records[index].pdf ? "pdf_uploaded" : "awaiting_pdf",
        draft: null,
        updatedAt: now,
        history: [{ action: "draft_reject", actor, note: String(note || "退回目录草稿").slice(0, 500), createdAt: now }, ...(records[index].history || [])].slice(0, 50),
      };
      write(records);
      return this.get(bookId);
    },
  };
}

function createFileTextbookCatalogStore(filePath = path.resolve(__dirname, "../../../.runtime/textbook-catalogs.json")) {
  return createTextbookCatalogStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return initialRecords(); }
    },
    write(items) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryTextbookCatalogStore(initialItems = initialRecords()) {
  let items = clone(initialItems);
  return createTextbookCatalogStore({ read: () => clone(items), write: (next) => { items = clone(next); } });
}

module.exports = {
  auditCatalogNodes,
  cleanCatalogTitle,
  createFileTextbookCatalogStore,
  createMemoryTextbookCatalogStore,
  normalizeCatalogAuxiliaryLevels,
  normalizeCatalogPageRanges,
  normalizeCatalogSiblingLevels,
  normalizeNodes,
};
