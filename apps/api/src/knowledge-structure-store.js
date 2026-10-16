const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { catalogNodesWithPaths } = require("./textbook-knowledge-store");

const STRUCTURE_VERSION = 1;
const excludedKnowledgeTitles = /^(?:教学提示|思考和练习|练习|附录|参考文献|后记|目录|本章小结|词类小结)/;
const PRIMARY_NODE_ROLES = new Set(["core", "scope_anchor"]);

function normalizePrimaryNodeRole(value) {
  const role = String(value || "").trim();
  return PRIMARY_NODE_ROLES.has(role) ? role : "core";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function compactText(value) {
  return cleanText(value).toLowerCase().replace(/[^\u3400-\u9fffa-z0-9]/g, "");
}

function cleanKnowledgeTitle(value) {
  return cleanText(value)
    .replace(/^☆+\s*/, "")
    .replace(/^(?:第[一二三四五六七八九十百零〇两0-9]+[章节篇编]\s*)/, "")
    .replace(/^[（(][一二三四五六七八九十百零〇两0-9]+[）)]\s*/, "")
    .replace(/^[一二三四五六七八九十百零〇两]+[、.]\s*/, "")
    .replace(/^\d+[.、]\s*/, "")
    .replace(/[.。]+$/, "")
    .trim();
}

// 目录原文路径与知识树路径写法不同（编号前缀、全角标点、繁简），"补漏"时要把
// 同一个教材位置折算成同一个身份键；否则目录重新提取后整棵树会被当成新节点再加一遍。
const STRUCTURE_BACKUP_LIMIT = 20;

function knowledgeIdentitySegment(value) {
  return cleanText(value).toLocaleLowerCase("zh-CN")
    .replace(/^☆+\s*/, "")
    .replace(/^第[一二三四五六七八九十百零〇两0-9]+[章节篇编]\s*/, "")
    .replace(/^[（(][一二三四五六七八九十百零〇两0-9]+[）)]\s*/, "")
    .replace(/^[一二三四五六七八九十百零〇两]+[、.]\s*/, "")
    .replace(/^\d+[.、]\s*/, "")
    .replace(/[^\u3400-\u9fffa-z0-9]/g, "");
}

function knowledgePathIdentityKey(value) {
  return String(value || "").split(/\s*>\s*/).map(knowledgeIdentitySegment).filter(Boolean).join(">");
}

function knowledgeNodeIdentityKeys(nodes = []) {
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const keys = new Map();
  nodes.forEach((node) => {
    const segments = [];
    const visited = new Set();
    let current = node;
    while (current && !visited.has(String(current.id))) {
      visited.add(String(current.id));
      segments.unshift(knowledgeIdentitySegment(current.title));
      current = current.parentId ? byId.get(String(current.parentId)) : null;
    }
    keys.set(String(node.id), segments.filter(Boolean).join(">"));
  });
  return keys;
}

function stableId(prefix, values) {
  const digest = crypto.createHash("sha1").update(values.map(compactText).join("\n")).digest("hex").slice(0, 18);
  return `${prefix}-${digest}`;
}

function headingRank(title) {
  const value = cleanText(title);
  if (/^[（(][一二三四五六七八九十百零〇两]+[）)]/.test(value)) return 1;
  if (/^\d+[.、]/.test(value)) return 2;
  if (/^[（(]\d+[）)]/.test(value)) return 3;
  return 1;
}

function usefulBodyHeading(node) {
  const title = cleanKnowledgeTitle(node && node.title);
  if (!title || title.length < 2 || title.length > 40) return false;
  if (excludedKnowledgeTitles.test(title)) return false;
  if (/^(?:呼吸器官|发声器官|调音器官)[—-]/.test(title)) return false;
  if (/[↑↓]/.test(title)) return false;
  if ((title.match(/[、，,]/g) || []).length >= 5) return false;
  if (!/[\u3400-\u9fffa-z]/i.test(title)) return false;
  return true;
}

function questionText(question) {
  return cleanText([
    question.stem,
    question.referenceAnswer,
    ...(question.options || []).map((option) => option.text),
    ...(question.knowledgePoints || []),
    ...(question.subKnowledgePoints || []),
  ].join(" "));
}

function features(value) {
  const normalized = cleanText(value).toLowerCase();
  const result = new Set();
  const chinese = normalized.replace(/[^\u3400-\u9fff]/g, "");
  for (let index = 0; index < chinese.length - 1; index += 1) result.add(chinese.slice(index, index + 2));
  normalized.match(/[a-z0-9]{2,}/g)?.forEach((token) => result.add(token));
  return result;
}

function cosine(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  left.forEach((item) => { if (right.has(item)) overlap += 1; });
  return overlap / Math.sqrt(left.size * right.size);
}

function inferAction(question) {
  const stem = cleanText(question.stem);
  if (question.type === "material_analysis") return "材料分析";
  if (["short_answer", "term_definition"].includes(question.type)) return "组织表述";
  if (question.type === "fill_blank") return "直接回忆";
  if (/几(?:个|种)|多少|数量|笔画数/.test(stem)) return "数量判断";
  if (/错误的是|正确的是|说法|不正确|没有错误/.test(stem)) return "正误辨析";
  if (/属于|指的是|构词方式|造字法|结构关系/.test(stem)) return "分类判断";
  if (/根据|用例|句子中|材料|分析|说明理由/.test(stem)) return "例证分析";
  return "概念识别";
}

function buildNodes(bookId, catalogNodes, outlineNodes) {
  const nodes = [];
  const catalogStack = [];
  const catalogById = new Map();
  // A node's `order` is its position among the siblings of the same parent, so
  // orderPath reads as a real outline number (2.3.1) instead of the node's row
  // in the whole catalog.  Body-heading children continue the numbering after
  // the catalog's own children of the same parent.
  const catalogChildCount = new Map();
  catalogNodesWithPaths(catalogNodes).forEach((source, index) => {
    const level = Math.max(1, Number(source.level) || 1);
    const parentId = level > 1 ? String(catalogStack[level - 2] || "") : "";
    const title = cleanText(source.title);
    const order = (catalogChildCount.get(parentId) || 0) + 1;
    catalogChildCount.set(parentId, order);
    const node = {
      id: String(source.id || stableId("catalog-node", [bookId, title, String(index)])),
      parentId,
      bookId,
      kind: level === 1 ? "chapter" : (level === 2 ? "section" : "knowledge"),
      catalogLevel: level,
      knowledgeLevel: level >= 3 ? level - 2 : 0,
      title,
      displayTitle: cleanKnowledgeTitle(title) || title,
      source: "confirmed_catalog",
      status: "confirmed",
      confidence: 1,
      startPage: Math.max(1, Number(source.startPage) || 1),
      endPage: Math.max(1, Number(source.endPage) || Number(source.startPage) || 1),
      order,
      orderPath: [],
      path: "",
    };
    catalogStack.length = level;
    catalogStack[level - 1] = node.id;
    nodes.push(node);
    catalogById.set(node.id, node);
  });

  const outlinesByCatalog = new Map();
  (Array.isArray(outlineNodes) ? outlineNodes : []).filter(usefulBodyHeading).forEach((source) => {
    const parentId = String(source.parentId || "");
    if (!catalogById.has(parentId)) return;
    if (!outlinesByCatalog.has(parentId)) outlinesByCatalog.set(parentId, []);
    outlinesByCatalog.get(parentId).push(source);
  });
  // Running per-parent counter: the catalog node's own children are numbered
  // 1..n first, then its body-heading children continue from n+1.  Body nodes
  // that are themselves parents start their own children back at 1.
  const siblingCount = new Map(catalogChildCount);
  outlinesByCatalog.forEach((items, catalogNodeId) => {
    const stack = [];
    items.sort((left, right) => Number(left.pdfPageStart || 0) - Number(right.pdfPageStart || 0)
      || Number(left.startPage || 0) - Number(right.startPage || 0)
      || String(left.id).localeCompare(String(right.id))).forEach((source) => {
      const rank = headingRank(source.title);
      const parentId = rank > 1 && stack[rank - 2] ? stack[rank - 2] : catalogNodeId;
      const parent = nodes.find((node) => node.id === parentId) || catalogById.get(catalogNodeId);
      const title = cleanText(source.title);
      const order = (siblingCount.get(parentId) || 0) + 1;
      siblingCount.set(parentId, order);
      const node = {
        id: String(source.id || stableId("knowledge-node", [bookId, catalogNodeId, title])),
        parentId,
        bookId,
        kind: "knowledge",
        catalogLevel: 0,
        knowledgeLevel: Math.min(5, Math.max(2, Number(parent.knowledgeLevel || 1) + 1)),
        title,
        displayTitle: cleanKnowledgeTitle(title) || title,
        source: "body_heading",
        status: "pending_review",
        confidence: 0.82,
        startPage: Math.max(0, Number(source.startPage) || 0),
        endPage: Math.max(0, Number(source.endPage) || Number(source.startPage) || 0),
        pdfPageStart: Math.max(1, Number(source.pdfPageStart) || 1),
        pdfPageEnd: Math.max(1, Number(source.pdfPageEnd) || Number(source.pdfPageStart) || 1),
        order,
        orderPath: [],
        path: "",
      };
      stack.length = rank;
      stack[rank - 1] = node.id;
      nodes.push(node);
    });
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  // 2026-09-26 修：这里以前**没有环检测**——只要 parentId 指向自己或形成环（例如正文标题 id
  // 与目录节点 id 撞名，标题节点就成了自己的父节点），resolve 就会无限递归，
  // 抛 RangeError: Maximum call stack size exceeded；外层 catch 再把它当 422 返回，
  // 前端看到的就是一句英文错误（确定性通道第 1 步「重算知识指纹」直接失败）。
  // 现在按 id 记 seen：遇环停止下钻，用已解析到的信息落 path，不改变正常层级的解析结果。
  const resolve = (node, seen = new Set()) => {
    if (node.path) return node;
    if (seen.has(node.id)) return node;
    seen.add(node.id);
    const parent = node.parentId && byId.get(node.parentId);
    if (parent) resolve(parent, seen);
    node.path = [...(parent ? parent.path.split(" > ").filter(Boolean) : []), node.displayTitle].join(" > ");
    node.orderPath = [...(parent ? parent.orderPath : []), Number(node.order) || 0];
    return node;
  };
  // 必须包一层：nodes.forEach(resolve) 会把数组索引当成 seen 传进去（seen.has is not a function）。
  nodes.forEach((node) => resolve(node));
  return nodes.sort((left, right) => {
    const length = Math.max(left.orderPath.length, right.orderPath.length);
    for (let index = 0; index < length; index += 1) {
      const difference = Number(left.orderPath[index] || 0) - Number(right.orderPath[index] || 0);
      if (difference) return difference;
    }
    return left.displayTitle.localeCompare(right.displayTitle, "zh-CN");
  });
}

function isDescendant(node, ancestorId, byId) {
  let current = node;
  while (current) {
    if (current.id === ancestorId) return true;
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return false;
}

function closestCatalogNode(question, catalogNodes) {
  const chapter = compactText(question.chapter);
  const pointText = compactText([...(question.knowledgePoints || []), ...(question.subKnowledgePoints || [])].join(" "));
  return catalogNodes.map((node) => {
    const title = compactText(node.displayTitle);
    let score = Number(node.catalogLevel) / 100;
    if (title && chapter.includes(title)) score += 2;
    if (title && pointText.includes(title)) score += 1.5;
    if (compactText(node.path) && compactText(node.path).includes(chapter) && chapter.length >= 4) score += 0.5;
    return { node, score };
  }).sort((left, right) => right.score - left.score || right.node.catalogLevel - left.node.catalogLevel)[0]?.node || null;
}

function knowledgeSpan(nodes, byId) {
  if (nodes.length <= 1) return "single_point";
  const isAncestorPair = nodes.some((left) => nodes.some((right) => left.id !== right.id && isDescendant(right, left.id, byId)));
  if (isAncestorPair) return "parent_child";
  const parents = new Set(nodes.map((node) => node.parentId));
  if (parents.size === 1) return "same_branch";
  const chapters = new Set(nodes.map((node) => {
    let current = node;
    while (current && current.kind !== "chapter") current = byId.get(current.parentId);
    return current && current.id;
  }).filter(Boolean));
  return chapters.size > 1 ? "cross_chapter" : "cross_branch";
}

function commonKnowledgeAncestorNodeId(nodes, byId) {
  const knowledgeNodes = (Array.isArray(nodes) ? nodes : []).filter((node) => node?.kind === "knowledge");
  if (!knowledgeNodes.length) return "";
  // The question's theme anchor is a directory projection, not necessarily a
  // leaf knowledge node.  Walk through every node kind so cross-branch
  // questions can resolve to their shared section or chapter.
  const ancestorChains = knowledgeNodes.map((node) => {
    const chain = [];
    let current = node;
    while (current) {
      chain.push(current.id);
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    return chain;
  });
  const first = ancestorChains[0] || [];
  let shared = first.find((candidate) => ancestorChains.every((chain) => chain.includes(candidate))) || "";
  // A theme anchor should organize the range rather than duplicate a sole
  // required leaf.  Move one level up when the deepest shared node is itself
  // one of the required knowledge nodes.
  const requiredIds = new Set(knowledgeNodes.map((node) => node.id));
  if (shared && requiredIds.has(shared)) shared = String(byId.get(shared)?.parentId || "");
  return shared;
}

function buildFingerprints(questions, nodes, chunks) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const catalogNodes = nodes.filter((node) => node.source === "confirmed_catalog");
  const contentByNode = new Map();
  (Array.isArray(chunks) ? chunks : []).forEach((chunk) => {
    if (!chunk.bodyHeadingId || chunk.enabled === false) return;
    const current = contentByNode.get(chunk.bodyHeadingId) || "";
    if (current.length < 2400) contentByNode.set(chunk.bodyHeadingId, `${current} ${chunk.retrievalText || chunk.text || ""}`.slice(0, 2400));
  });
  return (Array.isArray(questions) ? questions : []).map((question) => {
    const catalog = closestCatalogNode(question, catalogNodes);
    const scope = catalog ? nodes.filter((node) => node.kind === "knowledge" && isDescendant(node, catalog.id, byId)) : nodes.filter((node) => node.kind === "knowledge");
    const text = questionText(question);
    const textFeatures = features(text);
    const compactQuestion = compactText(text);
    const scored = scope.map((node) => {
      const title = node.displayTitle;
      const titleCompact = compactText(title);
      const titleScore = cosine(textFeatures, features(title));
      const evidenceScore = cosine(textFeatures, features(`${title} ${contentByNode.get(node.id) || ""}`));
      const exact = titleCompact.length >= 2 && compactQuestion.includes(titleCompact) ? 0.55 : 0;
      const depthBoost = Number(node.knowledgeLevel || 0) * 0.012;
      return { node, score: exact + titleScore * 0.7 + evidenceScore * 0.3 + depthBoost };
    }).sort((left, right) => right.score - left.score || right.node.knowledgeLevel - left.node.knowledgeLevel);
    const best = scored[0];
    const fallback = catalog && catalog.kind === "knowledge" ? catalog : null;
    const primary = best && best.score >= 0.2 ? best.node : fallback;
    const required = primary ? [primary] : [];
    if (primary) {
      scored.filter((entry) => entry.node.id !== primary.id
        && entry.score >= Math.max(0.34, Number(best?.score || 0) - 0.07)
        && !isDescendant(primary, entry.node.id, byId)
        && !isDescendant(entry.node, primary.id, byId)).slice(0, 2).forEach((entry) => required.push(entry.node));
    }
    const auxiliary = [];
    let parent = primary && byId.get(primary.parentId);
    while (parent) {
      if (parent.kind === "knowledge") auxiliary.unshift(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : null;
    }
    const span = knowledgeSpan(required, byId);
    const confidence = primary ? Math.min(0.96, Math.max(0.55, Number(best?.score || 0.55))) : 0;
    return {
      questionId: String(question.id),
      bookId: String(question.bookId || ""),
      primaryNodeId: String(primary?.id || ""),
      primaryNodeRole: "core",
      primaryKnowledgePoint: String(primary?.displayTitle || question.primaryKnowledgePoint || question.knowledgePoints?.[0] || ""),
      knowledgePath: String(primary?.path || question.chapter || ""),
      knowledgeLevel: Number(primary?.knowledgeLevel || 0),
      requiredNodeIds: required.map((node) => node.id),
      auxiliaryNodeIds: auxiliary,
      span,
      crossKnowledge: required.length > 1,
      relations: required.length > 1 ? ["共同作答"] : (auxiliary.length ? ["包含"] : []),
      action: inferAction(question),
      confidence: Math.round(confidence * 100) / 100,
      source: primary?.source === "body_heading" ? "body_heading_rule" : "catalog_rule",
      status: "suggested",
      evidencePages: [...new Set(required.map((node) => node.startPage).filter((page) => Number(page) > 0))],
    };
  });
}

function normalizeFingerprintFocus(value) {
  if (!value || typeof value !== "object") return null;
  const key = cleanText(value.key);
  if (!key) return null;
  return {
    key,
    label: cleanText(value.label || key),
    action: cleanText(value.action),
    confidence: Math.min(1, Math.max(0, Number(value.confidence) || 0)),
    source: cleanText(value.source),
    reason: cleanText(value.reason).slice(0, 1000),
  };
}

const FINGERPRINT_OPTION_KNOWLEDGE_RELATIONS = new Set(["question_only", "option_specific", "undetermined", "unreviewed"]);
const FINGERPRINT_OPTION_ROLES = new Set(["answer", "distractor", "neutral", "unreviewed"]);

// 逐选项知识（选项 → 知识关系 / 涉及知识）。形状与协议**沿用金标审核既有的 option-knowledge-v2**，
// 不发明第二套词汇。正式指纹此前没有这个字段，导致人工确认的选项知识只留在审核条目里、
// 编辑页看不到、学生端用不上（见《链路职责矩阵》产出 6）。
// 注：relation 不是 option_specific 时清空节点与标签，与既有合同（"仅题目知识"不得带节点）一致。
function normalizeFingerprintOptionKnowledge(value) {
  return (Array.isArray(value) ? value : []).flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const key = cleanText(row.key).slice(0, 4).toUpperCase();
    if (!key) return [];
    const relation = FINGERPRINT_OPTION_KNOWLEDGE_RELATIONS.has(String(row.knowledgeRelation))
      ? String(row.knowledgeRelation) : "unreviewed";
    const nodeIds = [...new Set((Array.isArray(row.knowledgeNodeIds) ? row.knowledgeNodeIds : [])
      .map((nodeId) => String(nodeId || "")).filter(Boolean))].slice(0, 20);
    const labels = (Array.isArray(row.knowledgeLabels) ? row.knowledgeLabels : [])
      .map((label) => cleanText(label)).slice(0, 20);
    return [{
      key,
      text: cleanText(row.text, 500),
      protocolVersion: cleanText(row.protocolVersion, 40) || "option-knowledge-v2",
      knowledgeRelation: relation,
      knowledgeNodeIds: relation === "option_specific" ? nodeIds : [],
      knowledgeLabels: relation === "option_specific" ? labels : [],
      role: FINGERPRINT_OPTION_ROLES.has(String(row.role)) ? String(row.role) : "unreviewed",
      basis: cleanText(row.basis, 1000),
      uncertaintyNote: cleanText(row.uncertaintyNote, 1000),
      provenance: cleanText(row.provenance, 80),
    }];
  }).slice(0, 26);
}

function normalizeFingerprintOverride(questionId, value) {
  const source = typeof value === "string" ? { primaryNodeId: value } : (value && typeof value === "object" ? value : {});
  const primaryNodeId = String(source.primaryNodeId || source.nodeId || "");
  if (!primaryNodeId) return null;
  const hasExplicitThemeRangeAnchor = typeof value === "object" && value !== null
    && (Object.prototype.hasOwnProperty.call(source, "knowledgeThemeRangeAnchorNodeId")
      || Object.prototype.hasOwnProperty.call(source, "themeRangeAnchorNodeId")
      || Object.prototype.hasOwnProperty.call(source, "scopeAnchorNodeId"));
  const primaryNodeRole = normalizePrimaryNodeRole(source.primaryNodeRole || source.coreKnowledgeRole);
  const requiredNodeIds = [...new Set([
    ...(primaryNodeRole === "core" ? [primaryNodeId] : []),
    ...(Array.isArray(source.requiredNodeIds) ? source.requiredNodeIds : []),
  ].map(String).filter(Boolean))];
  const knowledgeThemeRangeAnchorNodeId = String(
    source.knowledgeThemeRangeAnchorNodeId
      || source.themeRangeAnchorNodeId
      || source.scopeAnchorNodeId
      || (primaryNodeRole === "scope_anchor" ? primaryNodeId : ""),
  );
  const problemKnowledgeRangeNodeIds = [...new Set([
    ...(Array.isArray(source.problemKnowledgeRangeNodeIds) ? source.problemKnowledgeRangeNodeIds : []),
    ...(Array.isArray(source.problemKnowledgeNodeIds) ? source.problemKnowledgeNodeIds : []),
    ...requiredNodeIds,
  ].map(String).filter(Boolean))];
  return {
    questionId: String(source.questionId || questionId || ""),
    primaryNodeId,
    primaryNodeRole,
    requiredNodeIds,
    problemKnowledgeRangeNodeIds,
    knowledgeThemeRangeAnchorNodeId,
    // Preserve the distinction between an omitted anchor (legacy fallback)
    // and an explicit empty anchor (a deliberate clear by the editor).
    knowledgeThemeRangeAnchorExplicit: hasExplicitThemeRangeAnchor,
    // Kept as a read-compatible alias for older classification jobs and snapshots.
    scopeAnchorNodeId: knowledgeThemeRangeAnchorNodeId,
    focus: normalizeFingerprintFocus(source.focus || {
      key: source.focusKey,
      label: source.focusLabel,
      action: source.action,
      confidence: source.confidence,
      source: source.focusSource,
      reason: source.reason,
    }),
    evidenceChunkIds: [...new Set((Array.isArray(source.evidenceChunkIds) ? source.evidenceChunkIds : []).map(String).filter(Boolean))],
    // 逐选项知识：正式指纹的一等字段（形状沿用 option-knowledge-v2）。
    optionKnowledge: normalizeFingerprintOptionKnowledge(source.optionKnowledge),
    classificationJobId: String(source.classificationJobId || ""),
    questionVersion: Math.max(0, Number(source.questionVersion) || 0),
    revision: Math.max(1, Number(source.revision) || 1),
    reviewedBy: cleanText(source.reviewedBy || ""),
    reviewedAt: Math.max(0, Number(source.reviewedAt) || 0),
    source: cleanText(source.source || "manual_review") || "manual_review",
  };
}

function normalizeManualEdits(value) {
  const updates = value?.updates && typeof value.updates === "object" ? clone(value.updates) : {};
  const fingerprintOverrides = value?.fingerprintOverrides && typeof value.fingerprintOverrides === "object"
    ? Object.fromEntries(Object.entries(value.fingerprintOverrides)
      .map(([questionId, override]) => [String(questionId), normalizeFingerprintOverride(questionId, override)])
      .filter(([, override]) => override))
    : {};
  return {
    updates,
    deletedNodeIds: [...new Set((Array.isArray(value?.deletedNodeIds) ? value.deletedNodeIds : []).map(String).filter(Boolean))],
    // 记住"被删掉的位置"：目录正文节点 id 是内容哈希，目录一旦重新提取就会换新 id，
    // 只靠 id 记不住"这里人工删过"，噪音会复活。位置键用身份键而非原文，写法差异不影响。
    deletedPaths: [...new Set((Array.isArray(value?.deletedPaths) ? value.deletedPaths : []).map(String).filter(Boolean))].slice(-2000),
    addedNodes: (Array.isArray(value?.addedNodes) ? value.addedNodes : []).map(clone),
    fingerprintOverrides,
    directoryMappings: value?.directoryMappings && typeof value.directoryMappings === "object"
      ? Object.fromEntries(Object.entries(value.directoryMappings).map(([id, ids]) => [id, [...new Set((Array.isArray(ids) ? ids : []).map(String))]])) : {},
    directoryMappingRevision: Math.max(0, Number(value?.directoryMappingRevision) || 0),
  };
}

function applyManualNodeEdits(nodes, edits) {
  const normalized = normalizeManualEdits(edits);
  const deleted = new Set(normalized.deletedNodeIds);
  const result = [...nodes.map(clone), ...normalized.addedNodes.map(clone)]
    .filter((node) => !deleted.has(node.id))
    .map((node) => {
      const update = normalized.updates[node.id];
      if (!update) return node;
      const title = update.title == null ? node.title : cleanText(update.title);
      return {
        ...node,
        title,
        displayTitle: cleanKnowledgeTitle(title) || title,
        parentId: update.parentId == null ? node.parentId : String(update.parentId),
        order: update.order == null ? node.order : Math.max(1, Number(update.order) || 1),
        status: "manually_edited",
      };
    });
  const available = new Set(result.map((node) => node.id));
  return result.filter((node) => !node.parentId || available.has(node.parentId));
}

function applyFingerprintOverrides(fingerprints, nodes, overrides = {}) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return fingerprints.map((fingerprint) => {
    const override = normalizeFingerprintOverride(fingerprint.questionId, overrides[fingerprint.questionId]);
    const node = byId.get(override?.primaryNodeId);
    if (!override || !node || node.kind !== "knowledge" || node.bookId !== fingerprint.bookId) return fingerprint;
    const requiredNodeIds = [...new Set([
      ...(override.primaryNodeRole === "core" ? [node.id] : []),
      ...override.requiredNodeIds,
    ])]
      .filter((id) => {
        const requiredNode = byId.get(id);
        return requiredNode && requiredNode.kind === "knowledge" && requiredNode.bookId === fingerprint.bookId;
      });
    const requiredNodes = requiredNodeIds.map((id) => byId.get(id));
    const auxiliaryNodeIds = [];
    let parent = node.parentId ? byId.get(node.parentId) : null;
    while (parent) {
      if (parent.kind === "knowledge") auxiliaryNodeIds.unshift(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : null;
    }
    const span = knowledgeSpan(requiredNodes, byId);
    const themeRangeAnchor = override.knowledgeThemeRangeAnchorExplicit
      ? override.knowledgeThemeRangeAnchorNodeId
      : (override.knowledgeThemeRangeAnchorNodeId
        || fingerprint.knowledgeThemeRangeAnchorNodeId
        || fingerprint.scopeAnchorNodeId
        || commonKnowledgeAncestorNodeId(requiredNodes, byId)
        || "");
    return {
      ...fingerprint,
      primaryNodeId: node.id,
      primaryNodeRole: override.primaryNodeRole,
      primaryKnowledgePoint: node.displayTitle,
      knowledgePath: node.path,
      knowledgeLevel: Number(node.knowledgeLevel || 0),
      requiredNodeIds,
      problemKnowledgeRangeNodeIds: [...new Set([
        ...(override.problemKnowledgeRangeNodeIds || []),
        ...requiredNodeIds,
      ])].filter((id) => byId.get(id)?.kind === "knowledge"),
      knowledgeThemeRangeAnchorNodeId: String(themeRangeAnchor),
      knowledgeThemeRangeAnchorExplicit: Boolean(override.knowledgeThemeRangeAnchorExplicit),
      scopeAnchorNodeId: String(themeRangeAnchor),
      // 逐选项知识：以覆盖值为准；覆盖值为空时保留既有值，避免旧调用方（不带该字段）把已确认数据抹掉。
      // 若要"清空全部选项知识"，需另加显式标记（当前无此需求）。
      optionKnowledge: (Array.isArray(override.optionKnowledge) && override.optionKnowledge.length)
        ? override.optionKnowledge
        : (Array.isArray(fingerprint.optionKnowledge) ? fingerprint.optionKnowledge : []),
      auxiliaryNodeIds,
      span,
      crossKnowledge: requiredNodeIds.length > 1,
      relations: requiredNodeIds.length > 1 ? ["共同作答"] : (auxiliaryNodeIds.length ? ["包含"] : []),
      focus: override.focus,
      evidenceChunkIds: override.evidenceChunkIds,
      classificationJobId: override.classificationJobId,
      questionVersion: override.questionVersion,
      revision: override.revision,
      reviewedBy: override.reviewedBy,
      reviewedAt: override.reviewedAt,
      confidence: 1,
      source: override.source,
      status: "confirmed",
      evidencePages: [...new Set(requiredNodes.map((requiredNode) => requiredNode.startPage).filter((page) => Number(page) > 0))],
    };
  });
}

function refreshStructure(record) {
  const nodes = record.nodes.map(clone);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const resolving = new Set();
  const resolve = (node) => {
    if (node.__resolved) return node;
    if (resolving.has(node.id)) throw new Error("knowledge_node_cycle");
    resolving.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (node.parentId && !parent) throw new Error("knowledge_parent_not_found");
    if (parent) resolve(parent);
    node.knowledgeLevel = node.kind === "knowledge"
      ? Math.min(5, Math.max(1, Number(parent?.knowledgeLevel || 0) + 1))
      : 0;
    node.path = [...(parent ? parent.path.split(" > ").filter(Boolean) : []), node.displayTitle].join(" > ");
    node.orderPath = [...(parent ? parent.orderPath : []), Number(node.order) || 0];
    node.__resolved = true;
    resolving.delete(node.id);
    return node;
  };
  nodes.forEach(resolve);
  nodes.forEach((node) => { delete node.__resolved; });
  nodes.sort((left, right) => {
    const length = Math.max(left.orderPath.length, right.orderPath.length);
    for (let index = 0; index < length; index += 1) {
      const difference = Number(left.orderPath[index] || 0) - Number(right.orderPath[index] || 0);
      if (difference) return difference;
    }
    return left.displayTitle.localeCompare(right.displayTitle, "zh-CN");
  });
  const refreshedById = new Map(nodes.map((node) => [node.id, node]));
  const fingerprints = (record.fingerprints || []).map((source) => {
    const primary = refreshedById.get(source.primaryNodeId);
    const primaryNodeRole = normalizePrimaryNodeRole(source.primaryNodeRole || source.coreKnowledgeRole);
    const required = [...new Set([
      ...(primary && primaryNodeRole === "core" ? [primary.id] : []),
      ...(source.requiredNodeIds || []),
    ].filter((id) => refreshedById.get(id)?.kind === "knowledge"))];
    const auxiliary = [];
    let parent = primary?.parentId ? refreshedById.get(primary.parentId) : null;
    while (parent) {
      if (parent.kind === "knowledge") auxiliary.unshift(parent.id);
      parent = parent.parentId ? refreshedById.get(parent.parentId) : null;
    }
    const requiredNodes = required.map((id) => refreshedById.get(id)).filter(Boolean);
    const span = knowledgeSpan(requiredNodes, refreshedById);
    return {
      ...source,
      primaryNodeId: primary?.id || "",
      primaryNodeRole,
      primaryKnowledgePoint: primary?.displayTitle || source.primaryKnowledgePoint,
      knowledgePath: primary?.path || source.knowledgePath,
      knowledgeLevel: Number(primary?.knowledgeLevel || 0),
      requiredNodeIds: required,
      problemKnowledgeRangeNodeIds: [...new Set([
        ...(Array.isArray(source.problemKnowledgeRangeNodeIds) ? source.problemKnowledgeRangeNodeIds : []),
        ...required,
      ])].filter((id) => refreshedById.get(id)?.kind === "knowledge"),
      knowledgeThemeRangeAnchorNodeId: String(
        source.knowledgeThemeRangeAnchorExplicit
          ? (source.knowledgeThemeRangeAnchorNodeId || "")
          : (source.knowledgeThemeRangeAnchorNodeId
            || source.scopeAnchorNodeId
            || (primaryNodeRole === "scope_anchor" ? primary?.id || "" : "")
            || commonKnowledgeAncestorNodeId(requiredNodes, refreshedById)
            || ""),
      ),
      knowledgeThemeRangeAnchorExplicit: Boolean(source.knowledgeThemeRangeAnchorExplicit),
      scopeAnchorNodeId: String(
        source.knowledgeThemeRangeAnchorExplicit
          ? (source.knowledgeThemeRangeAnchorNodeId || "")
          : (source.knowledgeThemeRangeAnchorNodeId
            || source.scopeAnchorNodeId
            || (primaryNodeRole === "scope_anchor" ? primary?.id || "" : "")
            || commonKnowledgeAncestorNodeId(requiredNodes, refreshedById)
            || ""),
      ),
      auxiliaryNodeIds: auxiliary,
      span,
      crossKnowledge: required.length > 1,
      relations: required.length > 1 ? ["共同作答"] : (auxiliary.length ? ["包含"] : []),
    };
  });
  const questionCounts = new Map();
  fingerprints.forEach((fingerprint) => {
    [...new Set([fingerprint.primaryNodeId, ...fingerprint.requiredNodeIds, ...fingerprint.auxiliaryNodeIds].filter(Boolean))]
      .forEach((id) => questionCounts.set(id, (questionCounts.get(id) || 0) + 1));
  });
  nodes.forEach((node) => { node.questionCount = questionCounts.get(node.id) || 0; });
  const mapped = fingerprints.filter((fingerprint) => fingerprint.primaryNodeId).length;
  return {
    ...record,
    nodes,
    fingerprints,
    updatedAt: Date.now(),
    summary: {
      ...record.summary,
      nodeCount: nodes.length,
      knowledgeNodeCount: nodes.filter((node) => node.kind === "knowledge").length,
      deepKnowledgeNodeCount: nodes.filter((node) => node.knowledgeLevel >= 2).length,
      mappedQuestionCount: mapped,
      unmappedQuestionCount: Number(record.summary?.questionCount || fingerprints.length) - mapped,
      crossKnowledgeQuestionCount: fingerprints.filter((fingerprint) => fingerprint.crossKnowledge).length,
    },
  };
}

function buildStructureRecord({ bookId, chunks = [], questions = [] }, seedNodes = [], manualEdits = {}) {
  const nodes = refreshStructure({ nodes: seedNodes, fingerprints: [], summary: { questionCount: questions.length } }).nodes;
  const fingerprints = applyFingerprintOverrides(buildFingerprints(questions, nodes, chunks), nodes, normalizeManualEdits(manualEdits).fingerprintOverrides);
  return refreshStructure({
    bookId,
    version: STRUCTURE_VERSION,
    generatedAt: Date.now(),
    nodes,
    fingerprints,
    summary: {
      questionCount: questions.length,
    },
  });
}

function buildKnowledgeStructure(input = {}, manualEdits = {}) {
  const { bookId, catalogNodes = [], outlineNodes = [] } = input;
  const editedNodes = applyManualNodeEdits(buildNodes(bookId, catalogNodes, outlineNodes), manualEdits);
  return buildStructureRecord(input, editedNodes, manualEdits);
}

// "补漏"：只把目录/正文里有、而树里还没有的节点补进来，绝不改名、不移动、不删除
// 已经存在的节点，也不复活人工删掉的节点。这是"重新生成知识结构"的安全替代——
// 误点最多多出几个节点，不会毁掉已经构建好的树。
function mergeFilledNodes(existingNodes = [], targetNodes = [], deletedNodeIds = [], deletedPaths = []) {
  const existingIds = new Set(existingNodes.map((node) => String(node.id)));
  const deletedIds = new Set((deletedNodeIds || []).map(String));
  const deletedKeys = new Set((deletedPaths || []).map(String));
  const existingKeys = new Set();
  knowledgeNodeIdentityKeys(existingNodes).forEach((key) => { if (key) existingKeys.add(key); });
  const targetKeys = knowledgeNodeIdentityKeys(targetNodes);
  const added = [];
  targetNodes.forEach((node) => {
    const id = String(node.id);
    if (existingIds.has(id) || deletedIds.has(id)) return;
    const identityKey = targetKeys.get(id) || "";
    if (identityKey && (existingKeys.has(identityKey) || deletedKeys.has(identityKey))) return;
    // 父链不完整说明这一支被人工删过（或在树上被移走了），不要凭空补一个孤儿节点。
    if (node.parentId && !existingIds.has(String(node.parentId))) return;
    existingIds.add(id);
    if (identityKey) existingKeys.add(identityKey);
    added.push(node);
  });
  return added;
}

function normalizeState(value) {
  const records = Array.isArray(value) ? value : (Array.isArray(value && value.records) ? value.records : []);
  const editsByBook = value?.editsByBook && typeof value.editsByBook === "object" ? value.editsByBook : {};
  return {
    version: STRUCTURE_VERSION,
    records: records.map(clone),
    editsByBook: Object.fromEntries(Object.entries(editsByBook).map(([bookId, edits]) => [bookId, normalizeManualEdits(edits)])),
  };
}

function createKnowledgeStructureStore(adapter) {
  const read = () => normalizeState(adapter.read());
  const write = (state) => adapter.write(clone(state));
  // 每次改动前留档（记录 + 人工编辑日志），改坏了可以整本回滚。
  const snapshot = (state, bookId, reason) => {
    if (typeof adapter.backup !== "function") return null;
    const record = state.records.find((item) => item.bookId === bookId);
    if (!record) return null;
    return adapter.backup(bookId, {
      record: clone(record),
      edits: clone(normalizeManualEdits(state.editsByBook[bookId])),
    }, { reason: String(reason || "edit") });
  };
  return {
    exportState: () => clone(read()),
    replaceState: (state) => { write(state); return clone(read()); },
    get(bookId) {
      const record = read().records.find((item) => item.bookId === bookId);
      return record ? clone(record) : null;
    },
    directoryMappings(bookId) {
      const edits = normalizeManualEdits(read().editsByBook[bookId]);
      return { links: clone(edits.directoryMappings), revision: edits.directoryMappingRevision };
    },
    setDirectoryMapping(bookId, nodeId, targetIds, expectedRevision) {
      const state = read();
      const record = state.records.find((item) => item.bookId === bookId);
      if (!record?.nodes.some((node) => node.id === nodeId)) throw new Error("knowledge_node_not_found");
      const edits = normalizeManualEdits(state.editsByBook[bookId]);
      if (expectedRevision !== edits.directoryMappingRevision) throw new Error("directory_mapping_stale");
      const ids = [...new Set(targetIds.map(String))].sort();
      if (JSON.stringify(edits.directoryMappings[nodeId]) === JSON.stringify(ids)) return this.directoryMappings(bookId);
      snapshot(state, bookId, "directory-mapping");
      edits.directoryMappings[nodeId] = ids;
      edits.directoryMappingRevision += 1;
      state.editsByBook[bookId] = edits;
      write(state);
      return this.directoryMappings(bookId);
    },
    fillMissingFingerprints(bookId, fingerprints = []) {
      const state = read();
      const record = state.records.find((item) => item.bookId === bookId);
      if (!record) throw new Error("knowledge_structure_not_found");
      const byId = new Map(record.nodes.map((node) => [node.id, node]));
      const present = (fingerprint) => Boolean(fingerprint?.primaryNodeId || fingerprint?.requiredNodeIds?.length || fingerprint?.status === "confirmed");
      const added = [];
      for (const fingerprint of fingerprints) {
        if ((record.fingerprints || []).some((item) => item.questionId === fingerprint.questionId && present(item))) continue;
        if (byId.get(fingerprint.primaryNodeId)?.kind !== "knowledge"
          || !(fingerprint.requiredNodeIds || []).length
          || fingerprint.requiredNodeIds.some((id) => byId.get(id)?.kind !== "knowledge")) throw new Error("knowledge_node_not_found");
        if (!added.some((item) => item.questionId === fingerprint.questionId)) added.push(clone(fingerprint));
      }
      if (!added.length) return { addedQuestionIds: [] };
      snapshot(state, bookId, "fill-missing-fingerprints");
      const ids = new Set(added.map((item) => item.questionId));
      // Existing records stay byte-for-byte intact; empty placeholders alone may be replaced.
      record.fingerprints = [...(record.fingerprints || []).filter((item) => !ids.has(item.questionId)), ...added];
      record.updatedAt = Date.now();
      write(state);
      return { addedQuestionIds: [...ids] };
    },
    generate(input) {
      const state = read();
      snapshot(state, input.bookId, "generate");
      const record = buildKnowledgeStructure(input, state.editsByBook[input.bookId]);
      state.records = [...state.records.filter((item) => item.bookId !== record.bookId), record];
      write(state);
      return clone(record);
    },
    // 只补不删：把目录/正文里新增的节点补进树，已有节点原样保留。
    fillGaps(input = {}) {
      const state = read();
      const bookId = String(input.bookId || "");
      const existing = state.records.find((item) => item.bookId === bookId) || null;
      const edits = normalizeManualEdits(state.editsByBook[bookId]);
      const target = buildNodes(bookId, input.catalogNodes || [], input.outlineNodes || []);
      const added = existing
        ? mergeFilledNodes(existing.nodes || [], target, edits.deletedNodeIds, edits.deletedPaths)
        : target;
      const seedNodes = existing ? [...existing.nodes, ...added] : added;
      const backup = snapshot(state, bookId, "fill-gaps");
      const record = buildStructureRecord({ ...input, bookId }, seedNodes, edits);
      state.records = [...state.records.filter((item) => item.bookId !== bookId), record];
      write(state);
      return {
        structure: clone(record),
        addedNodeCount: added.length,
        existingNodeCount: existing ? (existing.nodes || []).length : 0,
        created: !existing,
        backup,
      };
    },
    backup(bookId, metadata = {}) {
      const state = read();
      return snapshot(state, bookId, metadata.reason || "manual") || { created: false, storage: "unavailable", bookId };
    },
    listBackups(bookId) {
      return typeof adapter.listBackups === "function" ? clone(adapter.listBackups(bookId)) : [];
    },
    restoreBackup(bookId, fileName) {
      const state = read();
      if (typeof adapter.readBackup !== "function") throw new Error("knowledge_structure_backup_unavailable");
      const payload = adapter.readBackup(bookId, fileName);
      if (!payload || !payload.record) throw new Error("knowledge_structure_backup_not_found");
      snapshot(state, bookId, "before-restore");
      const restored = normalizeState({ records: [payload.record], editsByBook: { [bookId]: payload.edits || {} } });
      state.records = [...state.records.filter((item) => item.bookId !== bookId), ...restored.records];
      state.editsByBook[bookId] = restored.editsByBook[bookId];
      write(state);
      return { restored: true, fileName, structure: clone(read().records.find((item) => item.bookId === bookId) || null) };
    },
    createNode(bookId, payload = {}) {
      const state = read();
      const record = state.records.find((item) => item.bookId === bookId);
      if (!record) throw new Error("knowledge_structure_not_found");
      const title = cleanText(payload.title);
      if (!title) throw new Error("knowledge_node_title_required");
      const parentId = String(payload.parentId || "");
      if (parentId && !record.nodes.some((node) => node.id === parentId)) throw new Error("knowledge_parent_not_found");
      const siblings = record.nodes.filter((node) => node.parentId === parentId);
      const node = {
        id: `manual-knowledge-node-${crypto.randomUUID()}`,
        parentId,
        bookId,
        kind: "knowledge",
        catalogLevel: 0,
        knowledgeLevel: 1,
        title,
        displayTitle: cleanKnowledgeTitle(title) || title,
        source: "manual",
        status: "confirmed",
        confidence: 1,
        startPage: Math.max(0, Number(payload.startPage) || 0),
        endPage: Math.max(0, Number(payload.endPage) || Number(payload.startPage) || 0),
        order: Math.max(0, ...siblings.map((item) => Number(item.order) || 0)) + 1,
        orderPath: [],
        path: "",
        questionCount: 0,
      };
      const edits = normalizeManualEdits(state.editsByBook[bookId]);
      edits.addedNodes.push(node);
      state.editsByBook[bookId] = edits;
      snapshot(state, bookId, "create-node");
      const updated = refreshStructure({ ...record, nodes: [...record.nodes, node] });
      state.records = state.records.map((item) => item.bookId === bookId ? updated : item);
      write(state);
      return { structure: clone(updated), node: clone(updated.nodes.find((item) => item.id === node.id)) };
    },
    updateNode(bookId, nodeId, payload = {}) {
      const state = read();
      const record = state.records.find((item) => item.bookId === bookId);
      if (!record) throw new Error("knowledge_structure_not_found");
      const node = record.nodes.find((item) => item.id === nodeId);
      if (!node) throw new Error("knowledge_node_not_found");
      const title = payload.title == null ? node.title : cleanText(payload.title);
      if (!title) throw new Error("knowledge_node_title_required");
      const byId = new Map(record.nodes.map((item) => [item.id, item]));
      const beforeNodeId = String(payload.beforeNodeId || "");
      const afterNodeId = String(payload.afterNodeId || "");
      if (beforeNodeId && afterNodeId) throw new Error("knowledge_node_position_invalid");
      const anchorId = beforeNodeId || afterNodeId;
      const anchor = anchorId ? byId.get(anchorId) : null;
      if (anchorId && (!anchor || anchor.id === nodeId)) throw new Error("knowledge_node_position_invalid");
      const parentId = anchor
        ? String(anchor.parentId || "")
        : (payload.parentId == null ? node.parentId : String(payload.parentId || ""));
      if (parentId && !byId.has(parentId)) throw new Error("knowledge_parent_not_found");
      if (parentId === nodeId || (parentId && isDescendant(byId.get(parentId), nodeId, byId))) throw new Error("knowledge_node_cycle");

      const updatedNodes = record.nodes.map((item) => item.id === nodeId
        ? { ...item, title, displayTitle: cleanKnowledgeTitle(title) || title, parentId, status: "manually_edited" }
        : { ...item });
      const updatedById = new Map(updatedNodes.map((item) => [item.id, item]));
      const affectedParentIds = new Set([String(node.parentId || ""), parentId]);
      affectedParentIds.forEach((affectedParentId) => {
        const siblings = updatedNodes
          .filter((item) => String(item.parentId || "") === affectedParentId && item.id !== nodeId)
          .sort((left, right) => Number(left.order || 0) - Number(right.order || 0)
            || left.displayTitle.localeCompare(right.displayTitle, "zh-CN"));
        if (affectedParentId === parentId) {
          let insertionIndex = siblings.length;
          if (beforeNodeId) insertionIndex = siblings.findIndex((item) => item.id === beforeNodeId);
          else if (afterNodeId) {
            const anchorIndex = siblings.findIndex((item) => item.id === afterNodeId);
            insertionIndex = anchorIndex < 0 ? siblings.length : anchorIndex + 1;
          } else if (String(node.parentId || "") === parentId) {
            const previousSiblings = record.nodes
              .filter((item) => String(item.parentId || "") === parentId)
              .sort((left, right) => Number(left.order || 0) - Number(right.order || 0)
                || left.displayTitle.localeCompare(right.displayTitle, "zh-CN"));
            insertionIndex = Math.max(0, previousSiblings.findIndex((item) => item.id === nodeId));
          }
          siblings.splice(Math.max(0, insertionIndex), 0, updatedById.get(nodeId));
        }
        siblings.forEach((item, index) => { updatedById.get(item.id).order = index + 1; });
      });

      const edits = normalizeManualEdits(state.editsByBook[bookId]);
      updatedNodes.forEach((updatedNode) => {
        const previous = byId.get(updatedNode.id);
        if (previous
          && previous.title === updatedNode.title
          && String(previous.parentId || "") === String(updatedNode.parentId || "")
          && Number(previous.order || 0) === Number(updatedNode.order || 0)) return;
        const addedIndex = edits.addedNodes.findIndex((item) => item.id === updatedNode.id);
        if (addedIndex >= 0) {
          edits.addedNodes[addedIndex] = {
            ...edits.addedNodes[addedIndex],
            title: updatedNode.title,
            displayTitle: updatedNode.displayTitle,
            parentId: updatedNode.parentId,
            order: updatedNode.order,
          };
        } else {
          edits.updates[updatedNode.id] = {
            ...(edits.updates[updatedNode.id] || {}),
            title: updatedNode.title,
            parentId: updatedNode.parentId,
            order: updatedNode.order,
          };
        }
      });
      state.editsByBook[bookId] = edits;
      snapshot(state, bookId, "update-node");
      const updated = refreshStructure({ ...record, nodes: updatedNodes });
      state.records = state.records.map((item) => item.bookId === bookId ? updated : item);
      write(state);
      return { structure: clone(updated), node: clone(updated.nodes.find((item) => item.id === nodeId)) };
    },
    // 列出某节点（含全部下级）实际关联的题目，供审核员在删除前看清是哪些题挡住，
    // 并把它们改挂到正确节点。删除保护本身不变，这里只做只读呈现。
    questionsForNode(bookId, nodeId) {
      const state = read();
      const record = state.records.find((item) => item.bookId === bookId);
      if (!record) throw new Error("knowledge_structure_not_found");
      const byId = new Map(record.nodes.map((item) => [item.id, item]));
      const node = byId.get(nodeId);
      if (!node) throw new Error("knowledge_node_not_found");
      const subtreeIds = new Set(record.nodes
        .filter((item) => isDescendant(item, nodeId, byId)).map((item) => item.id));
      const questions = (record.fingerprints || []).map((fingerprint) => {
        const primaryNodeId = String(fingerprint.primaryNodeId || "");
        const requiredNodeIds = (Array.isArray(fingerprint.requiredNodeIds) ? fingerprint.requiredNodeIds : []).map(String);
        const auxiliaryNodeIds = (Array.isArray(fingerprint.auxiliaryNodeIds) ? fingerprint.auxiliaryNodeIds : []).map(String);
        const scopeAnchorNodeId = String(fingerprint.knowledgeThemeRangeAnchorNodeId
          || fingerprint.scopeAnchorNodeId || "");
        const hitsPrimary = subtreeIds.has(primaryNodeId);
        const hitsRequired = requiredNodeIds.filter((id) => subtreeIds.has(id));
        const hitsAuxiliary = auxiliaryNodeIds.filter((id) => subtreeIds.has(id));
        const hitsScopeAnchor = Boolean(scopeAnchorNodeId) && subtreeIds.has(scopeAnchorNodeId);
        if (!hitsPrimary && !hitsRequired.length && !hitsAuxiliary.length && !hitsScopeAnchor) return null;
        return {
          questionId: String(fingerprint.questionId || ""),
          primaryNodeId,
          primaryNodeRole: String(fingerprint.primaryNodeRole || "core"),
          requiredNodeIds,
          auxiliaryNodeIds,
          scopeAnchorNodeId,
          problemKnowledgeRangeNodeIds: (fingerprint.problemKnowledgeRangeNodeIds || []).map(String),
          // 只有焦点与作答必需知识会阻断删除；辅助知识与范围锚点仅提示。
          blocksDelete: hitsPrimary || hitsRequired.length > 0,
          references: [
            ...(hitsPrimary ? ["题目知识焦点"] : []),
            ...(hitsRequired.length ? ["作答必需知识"] : []),
            ...(hitsAuxiliary.length ? ["辅助知识"] : []),
            ...(hitsScopeAnchor ? ["范围锚点"] : []),
          ],
        };
      }).filter(Boolean);
      return { node: clone(node), subtreeNodeIds: [...subtreeIds], questions };
    },
    deleteNode(bookId, nodeId) {
      const state = read();
      const record = state.records.find((item) => item.bookId === bookId);
      if (!record) throw new Error("knowledge_structure_not_found");
      const byId = new Map(record.nodes.map((item) => [item.id, item]));
      const node = byId.get(nodeId);
      if (!node) throw new Error("knowledge_node_not_found");
      const deletedIds = new Set(record.nodes.filter((item) => isDescendant(item, nodeId, byId)).map((item) => item.id));
      const mapped = (record.fingerprints || []).filter((fingerprint) => deletedIds.has(fingerprint.primaryNodeId)
        || (fingerprint.requiredNodeIds || []).some((id) => deletedIds.has(id)));
      if (mapped.length) {
        const error = new Error("knowledge_node_has_questions");
        // 把挡住删除的题目一并返回，避免审核员只能看到一个数量。
        error.details = {
          nodeId,
          questionIds: [...new Set(mapped.map((fingerprint) => String(fingerprint.questionId || "")).filter(Boolean))],
        };
        throw error;
      }
      const edits = normalizeManualEdits(state.editsByBook[bookId]);
      edits.addedNodes = edits.addedNodes.filter((item) => !deletedIds.has(item.id));
      Object.keys(edits.updates).forEach((id) => { if (deletedIds.has(id)) delete edits.updates[id]; });
      const baseDeletedIds = [...deletedIds].filter((id) => !String(id).startsWith("manual-knowledge-node-"));
      edits.deletedNodeIds = [...new Set([...edits.deletedNodeIds, ...baseDeletedIds])];
      // 同时记住被删节点所在的位置，目录重新提取换了 id 之后也不会把人工删掉的噪音补回来。
      const deletedPathKeys = record.nodes
        .filter((item) => deletedIds.has(item.id))
        .map((item) => knowledgePathIdentityKey(item.path))
        .filter(Boolean);
      edits.deletedPaths = [...new Set([...edits.deletedPaths, ...deletedPathKeys])].slice(-2000);
      state.editsByBook[bookId] = edits;
      snapshot(state, bookId, "delete-node");
      const updated = refreshStructure({ ...record, nodes: record.nodes.filter((item) => !deletedIds.has(item.id)) });
      state.records = state.records.map((item) => item.bookId === bookId ? updated : item);
      write(state);
      return { structure: clone(updated), deletedNodeIds: [...deletedIds] };
    },
    assignQuestions(bookId, assignments = [], options = {}) {
      const state = read();
      const record = state.records.find((item) => item.bookId === bookId);
      if (!record) throw new Error("knowledge_structure_not_found");
      const byId = new Map(record.nodes.map((node) => [node.id, node]));
      const sourceAssignments = Array.isArray(assignments) ? assignments : [];
      sourceAssignments.forEach((assignment) => {
        const source = typeof assignment === "string" ? { primaryNodeId: assignment }
          : (assignment && typeof assignment === "object" ? assignment : {});
        const primaryNodeId = String(source.primaryNodeId || source.nodeId || "");
        const primaryNodeRole = normalizePrimaryNodeRole(source.primaryNodeRole || source.coreKnowledgeRole);
        const suppliedRequiredNodeIds = [...new Set((Array.isArray(source.requiredNodeIds) ? source.requiredNodeIds : [])
          .map(String).filter(Boolean))];
        if (primaryNodeRole === "scope_anchor" && suppliedRequiredNodeIds.includes(primaryNodeId)) {
          throw new Error("knowledge_assignment_scope_anchor_invalid");
        }
      });
      const normalizedAssignments = sourceAssignments
        .map((assignment) => normalizeFingerprintOverride(assignment?.questionId, assignment))
        .filter((assignment) => assignment?.questionId && assignment.primaryNodeId);
      if (!normalizedAssignments.length) throw new Error("knowledge_assignments_required");
      normalizedAssignments.forEach((assignment) => {
        const primaryNode = byId.get(assignment.primaryNodeId);
        if (!primaryNode) throw new Error("knowledge_node_not_found");
        if (primaryNode.bookId !== bookId) throw new Error("knowledge_assignment_book_mismatch");
        if (primaryNode.kind !== "knowledge") throw new Error("knowledge_assignment_node_required");
        if (!assignment.requiredNodeIds.length) throw new Error("knowledge_assignments_required");
        assignment.requiredNodeIds.forEach((nodeId) => {
          const node = byId.get(nodeId);
          if (!node) throw new Error("knowledge_node_not_found");
          if (node.bookId !== bookId) throw new Error("knowledge_assignment_book_mismatch");
          if (node.kind !== "knowledge") throw new Error("knowledge_assignment_node_required");
        });
        (assignment.problemKnowledgeRangeNodeIds || []).forEach((nodeId) => {
          const node = byId.get(nodeId);
          if (!node) throw new Error("knowledge_node_not_found");
          if (node.bookId !== bookId) throw new Error("knowledge_assignment_book_mismatch");
          if (node.kind !== "knowledge") throw new Error("knowledge_assignment_node_required");
        });
        const previousAnchor = (record.fingerprints || [])
          .find((fingerprint) => fingerprint.questionId === assignment.questionId);
        const unchangedLegacyAnchor = options.preserveExistingThemeAnchor === true
          && previousAnchor
          && assignment.knowledgeThemeRangeAnchorNodeId === String(
            previousAnchor.knowledgeThemeRangeAnchorNodeId || previousAnchor.scopeAnchorNodeId || "",
          );
        if (assignment.knowledgeThemeRangeAnchorNodeId && !unchangedLegacyAnchor) {
          const anchor = byId.get(assignment.knowledgeThemeRangeAnchorNodeId);
          if (!anchor) throw new Error("knowledge_node_not_found");
          if (anchor.bookId !== bookId) throw new Error("knowledge_assignment_book_mismatch");
          if (!["chapter", "section", "knowledge"].includes(anchor.kind)) {
            throw new Error("knowledge_assignment_node_required");
          }
        }
        if (assignment.primaryNodeRole === "scope_anchor" && (assignment.requiredNodeIds.includes(assignment.primaryNodeId)
          || !assignment.requiredNodeIds.some((nodeId) => (
            nodeId !== assignment.primaryNodeId && isDescendant(byId.get(nodeId), assignment.primaryNodeId, byId)
          )))) {
          throw new Error("knowledge_assignment_scope_anchor_invalid");
        }
      });
      const edits = normalizeManualEdits(state.editsByBook[bookId]);
      normalizedAssignments.forEach((assignment) => { edits.fingerprintOverrides[assignment.questionId] = assignment; });
      state.editsByBook[bookId] = edits;
      const existingQuestionIds = new Set((record.fingerprints || []).map((fingerprint) => fingerprint.questionId));
      const addedFingerprints = normalizedAssignments
        .filter((assignment) => !existingQuestionIds.has(assignment.questionId))
        .map((assignment) => ({
          questionId: assignment.questionId,
          bookId,
          primaryNodeId: assignment.primaryNodeId,
          primaryNodeRole: assignment.primaryNodeRole,
          requiredNodeIds: assignment.requiredNodeIds,
          problemKnowledgeRangeNodeIds: assignment.problemKnowledgeRangeNodeIds,
          knowledgeThemeRangeAnchorNodeId: assignment.knowledgeThemeRangeAnchorNodeId,
          scopeAnchorNodeId: assignment.knowledgeThemeRangeAnchorNodeId,
          source: "manual_review",
          status: "suggested",
        }));
      const sourceFingerprints = [...(record.fingerprints || []), ...addedFingerprints];
      const updatedFingerprints = applyFingerprintOverrides(sourceFingerprints, record.nodes, edits.fingerprintOverrides);
      const updated = refreshStructure({
        ...record,
        fingerprints: updatedFingerprints,
        summary: {
          ...(record.summary || {}),
          questionCount: Math.max(Number(record.summary?.questionCount) || 0, sourceFingerprints.length),
        },
      });
      state.records = state.records.map((item) => item.bookId === bookId ? updated : item);
      snapshot(state, bookId, "assign-questions");
      write(state);
      return {
        structure: clone(updated),
        assignments: normalizedAssignments.map((assignment) => ({
          ...assignment,
          nodeId: assignment.primaryNodeId,
          knowledgePath: byId.get(assignment.primaryNodeId).path,
        })),
      };
    },
    fingerprintMap(bookId) {
      const record = this.get(bookId);
      return new Map((record?.fingerprints || []).map((item) => [item.questionId, item]));
    },
    descendants(bookId, nodeId) {
      const record = this.get(bookId);
      if (!record) return new Set();
      const byId = new Map(record.nodes.map((node) => [node.id, node]));
      return new Set(record.nodes.filter((node) => isDescendant(node, nodeId, byId)).map((node) => node.id));
    },
    decorateQuestions(questions, bookId, nodeId = "") {
      const record = this.get(bookId);
      if (!record) return clone(questions);
      const fingerprints = new Map(record.fingerprints.map((item) => [item.questionId, item]));
      const allowed = nodeId ? this.descendants(bookId, nodeId) : null;
      const order = new Map(record.nodes.map((node, index) => [node.id, index]));
      return questions.map((question) => ({ ...question, knowledgeFingerprint: clone(fingerprints.get(question.id) || null) }))
        .filter((question) => !allowed || question.knowledgeFingerprint?.requiredNodeIds.some((id) => allowed.has(id)) || allowed.has(question.knowledgeFingerprint?.primaryNodeId))
        .sort((left, right) => Number(order.get(left.knowledgeFingerprint?.primaryNodeId) ?? Number.MAX_SAFE_INTEGER)
          - Number(order.get(right.knowledgeFingerprint?.primaryNodeId) ?? Number.MAX_SAFE_INTEGER)
          || Number(left.createdAt || 0) - Number(right.createdAt || 0));
    },
  };
}

function createFileKnowledgeStructureStore(filePath = path.resolve(__dirname, "../../../.runtime/knowledge-structures.json")) {
  const backupRoot = path.join(path.dirname(filePath), "knowledge-structure-backups");
  const safeBookId = (bookId) => String(bookId || "unknown").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120) || "unknown";
  const backupFileNamePattern = /^(\d+)-([a-z0-9-]*)-(\d+)\.json$/i;
  const describeBackup = (bookId, name) => {
    const matched = backupFileNamePattern.exec(name);
    return {
      fileName: name,
      storage: "file",
      bookId,
      createdAt: matched ? Number(matched[1]) : 0,
      reason: matched ? (matched[2] || "edit") : "unknown",
      nodeCount: matched ? Number(matched[3]) : 0,
    };
  };
  return createKnowledgeStructureStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { version: STRUCTURE_VERSION, records: [] }; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
    backup(bookId, payload, metadata = {}) {
      const createdAt = Date.now();
      const directory = path.join(backupRoot, safeBookId(bookId));
      fs.mkdirSync(directory, { recursive: true });
      const reason = String(metadata.reason || "edit").replace(/[^a-z0-9-]+/gi, "-").slice(0, 40).toLowerCase() || "edit";
      const nodeCount = (payload?.record?.nodes || []).length;
      const fileName = `${createdAt}-${reason}-${nodeCount}.json`;
      const backupPath = path.join(directory, fileName);
      const temporaryPath = `${backupPath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify({ createdAt, metadata, ...payload }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, backupPath);
      try {
        fs.readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && backupFileNamePattern.test(entry.name))
          .map((entry) => entry.name)
          .sort()
          .reverse()
          .slice(STRUCTURE_BACKUP_LIMIT)
          .forEach((name) => fs.unlinkSync(path.join(directory, name)));
      } catch { /* 清理失败不影响本次留档 */ }
      return { created: true, storage: "file", bookId, fileName, createdAt, reason, nodeCount };
    },
    listBackups(bookId) {
      const directory = path.join(backupRoot, safeBookId(bookId));
      try {
        return fs.readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && backupFileNamePattern.test(entry.name))
          .map((entry) => describeBackup(bookId, entry.name))
          .sort((left, right) => right.createdAt - left.createdAt || right.fileName.localeCompare(left.fileName));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
    readBackup(bookId, fileName) {
      const safeName = path.basename(String(fileName || ""));
      if (!backupFileNamePattern.test(safeName)) throw new Error("knowledge_structure_backup_not_found");
      const backupPath = path.join(backupRoot, safeBookId(bookId), safeName);
      try { return JSON.parse(fs.readFileSync(backupPath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") throw new Error("knowledge_structure_backup_not_found"); throw error; }
    },
  });
}

function createMemoryKnowledgeStructureStore(initialState = { version: STRUCTURE_VERSION, records: [] }) {
  let state = clone(initialState);
  const backups = [];
  return createKnowledgeStructureStore({
    read: () => clone(state),
    write: (value) => { state = clone(value); },
    backup(bookId, payload, metadata = {}) {
      const descriptor = {
        created: true,
        storage: "memory",
        bookId,
        fileName: `memory-${backups.length + 1}.json`,
        createdAt: Date.now(),
        reason: String(metadata.reason || "edit"),
        nodeCount: (payload?.record?.nodes || []).length,
      };
      backups.push({ ...descriptor, record: clone(payload.record), edits: clone(payload.edits || {}) });
      return descriptor;
    },
    listBackups: (bookId) => backups
      .filter((backup) => backup.bookId === bookId)
      .slice()
      .reverse()
      .map(({ record, edits, ...descriptor }) => descriptor),
    readBackup(bookId, fileName) {
      return backups.find((backup) => backup.bookId === bookId && backup.fileName === fileName) || null;
    },
  });
}

module.exports = {
  STRUCTURE_VERSION,
  buildNodes,
  buildFingerprints,
  knowledgeSpan,
  buildKnowledgeStructure,
  buildStructureRecord,
  createFileKnowledgeStructureStore,
  createMemoryKnowledgeStructureStore,
  mergeFilledNodes,
};
