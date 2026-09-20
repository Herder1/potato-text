const STORAGE_KEY = "shukao_private_packs";
const CATEGORY_STORAGE_KEY = "shukao_private_pack_categories";
const LEGACY_STORAGE_KEY = "shukao_packs";
const MIGRATION_KEY = "shukao_private_packs_migrated_v1";

const QUESTION_TYPE_MAP = {
  单选题: "single_choice",
  多选题: "multiple_choice",
  判断题: "true_false",
  填空题: "fill_blank",
  断句题: "punctuation",
  加点字翻译: "classical_word_explanation",
  加点字解释: "classical_word_explanation",
  加点字词解释: "classical_word_explanation",
  古文翻译: "translation",
  简答题: "short_answer",
  名词解释: "term_definition",
  材料分析题: "material_analysis",
  作品赏析题: "appreciation",
  论述题: "essay",
};

function normalizePack(pack = {}) {
  const now = Date.now();
  const source = pack.source === "community_import" ? "community_import" : "created";
  const visibility = pack.visibility === "public" || pack.visibility === "公开" ? "public" : "private";
  const legacyQuestionIds = Array.isArray(pack.questionIds)
    ? [...new Set(pack.questionIds.filter(Boolean))]
    : [];
  const rawNodes = Array.isArray(pack.nodes) ? pack.nodes : [];
  const nodes = rawNodes.map((node, index) => ({
    ...node,
    id: node.id || `pack-node-${now}-${index}`,
    type: node.type === "directory" ? "directory" : "card",
    title: String(node.title || "").trim(),
    level: node.type === "directory" ? Math.min(3, Math.max(1, Number(node.level) || 1)) : 0,
    parentId: node.type === "directory" ? String(node.parentId || "") : "",
    directoryId: node.type === "directory" ? "" : String(node.directoryId || ""),
    questionId: node.type === "directory" ? "" : String(node.questionId || ""),
    createdAt: Number(node.createdAt) || now,
  }));
  const representedQuestionIds = new Set(nodes.filter((node) => node.type === "card" && node.questionId).map((node) => node.questionId));
  legacyQuestionIds.forEach((questionId, index) => {
    if (representedQuestionIds.has(questionId)) return;
    nodes.push({
      id: `card-${String(questionId).replace(/[^a-zA-Z0-9_-]/g, "-")}-${index}`,
      type: "card",
      title: "",
      level: 0,
      directoryId: "",
      questionId,
      createdAt: now,
    });
  });
  const directoryIds = new Set(nodes.filter((node) => node.type === "directory").map((node) => node.id));
  nodes.forEach((node) => {
    if (node.type === "card" && node.directoryId && !directoryIds.has(node.directoryId)) node.directoryId = "";
    if (node.type === "directory" && (node.parentId === node.id || !directoryIds.has(node.parentId))) node.parentId = "";
  });
  const questionIds = [...new Set(nodes.filter((node) => node.type === "card" && node.questionId).map((node) => node.questionId))];
  return {
    ...pack,
    id: pack.id || `private-pack-${now}`,
    name: String(pack.name || "未命名题包").trim() || "未命名题包",
    description: String(pack.description || "").trim(),
    tags: Array.isArray(pack.tags) ? [...new Set(pack.tags.filter(Boolean))] : [],
    nodes,
    questionIds,
    count: questionIds.length || Math.max(0, Number(pack.count) || 0),
    source,
    sourceLabel: source === "community_import" ? "社区导入" : "我创建的",
    sourcePackId: String(pack.sourcePackId || ""),
    visibility,
    visibilityLabel: visibility === "public" ? "公开" : "私密",
    status: pack.status || (visibility === "public" ? "pending_review" : "private"),
    categoryId: String(pack.categoryId || ""),
    pinned: !!pack.pinned,
    pinnedAt: pack.pinned ? Number(pack.pinnedAt) || now : 0,
    createdAt: Number(pack.createdAt) || now,
    updatedAt: Number(pack.updatedAt) || Number(pack.createdAt) || now,
  };
}

function createNodeId(type) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadPrivatePacks(storage = wx) {
  let packs = storage.getStorageSync(STORAGE_KEY);
  packs = Array.isArray(packs) ? packs : [];
  if (!storage.getStorageSync(MIGRATION_KEY)) {
    const knownIds = new Set(packs.map((pack) => pack.id));
    const legacy = storage.getStorageSync(LEGACY_STORAGE_KEY);
    (Array.isArray(legacy) ? legacy : []).forEach((pack) => {
      if (!knownIds.has(pack.id)) packs.push(normalizePack(pack));
    });
    storage.setStorageSync(STORAGE_KEY, packs);
    storage.setStorageSync(MIGRATION_KEY, true);
  }
  return packs.map(normalizePack).sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.pinned && left.pinnedAt !== right.pinnedAt) return right.pinnedAt - left.pinnedAt;
    return right.updatedAt - left.updatedAt;
  });
}

function normalizeCategory(category = {}, index = 0) {
  const now = Date.now();
  return {
    id: String(category.id || `pack-category-${now}-${index}`),
    name: String(category.name || "未命名分类").trim() || "未命名分类",
    parentId: String(category.parentId || ""),
    createdAt: Number(category.createdAt) || now,
  };
}

function loadPrivatePackCategories(storage = wx) {
  const categories = storage.getStorageSync(CATEGORY_STORAGE_KEY);
  const normalized = (Array.isArray(categories) ? categories : []).map(normalizeCategory);
  const categoryMap = new Map(normalized.map((category) => [category.id, category]));
  const resolved = new Map();
  function resolveCategory(category, trail = new Set()) {
    if (resolved.has(category.id)) return resolved.get(category.id);
    if (!category.parentId || category.parentId === category.id || !categoryMap.has(category.parentId) || trail.has(category.id)) {
      const root = { ...category, parentId: "", level: 1 };
      resolved.set(category.id, root);
      return root;
    }
    const nextTrail = new Set(trail).add(category.id);
    const parent = resolveCategory(categoryMap.get(category.parentId), nextTrail);
    const value = parent.level >= 3
      ? { ...category, parentId: parent.parentId, level: 3 }
      : { ...category, parentId: parent.id, level: parent.level + 1 };
    resolved.set(category.id, value);
    return value;
  }
  return normalized.map((category) => resolveCategory(category));
}

function createPrivatePackCategory(name, parentId = "", storage) {
  if (parentId && typeof parentId !== "string") {
    storage = parentId;
    parentId = "";
  }
  storage = storage || wx;
  const categoryName = String(name || "").trim();
  if (!categoryName) return null;
  const categories = loadPrivatePackCategories(storage);
  const requestedParent = categories.find((category) => category.id === parentId);
  const resolvedParentId = requestedParent
    ? (requestedParent.level >= 3 ? requestedParent.parentId : requestedParent.id)
    : "";
  const existing = categories.find((category) => category.name === categoryName && category.parentId === resolvedParentId);
  if (existing) return existing;
  const category = normalizeCategory({
    id: `pack-category-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: categoryName,
    parentId: resolvedParentId,
  });
  storage.setStorageSync(CATEGORY_STORAGE_KEY, [...categories, category]);
  return category;
}

function renamePrivatePackCategory(categoryId, name, storage = wx) {
  const categoryName = String(name || "").trim();
  if (!categoryId || !categoryName) return null;
  const categories = loadPrivatePackCategories(storage);
  const target = categories.find((category) => category.id === categoryId);
  if (!target) return null;
  const duplicate = categories.find((category) => category.id !== categoryId && category.parentId === target.parentId && category.name === categoryName);
  if (duplicate) return duplicate;
  const updated = categories.map((category) => category.id === categoryId ? { ...category, name: categoryName } : category);
  storage.setStorageSync(CATEGORY_STORAGE_KEY, updated);
  return updated.find((category) => category.id === categoryId);
}

function deletePrivatePackCategory(categoryId, storage = wx) {
  const categories = loadPrivatePackCategories(storage);
  const target = categories.find((category) => category.id === categoryId);
  if (!target) return { categories, packs: loadPrivatePacks(storage) };
  const deletedIds = new Set([categoryId]);
  let discovered = true;
  while (discovered) {
    discovered = false;
    categories.forEach((category) => {
      if (deletedIds.has(category.parentId) && !deletedIds.has(category.id)) {
        deletedIds.add(category.id);
        discovered = true;
      }
    });
  }
  const remainingCategories = categories.filter((category) => !deletedIds.has(category.id));
  const now = Date.now();
  const packs = loadPrivatePacks(storage).map((pack) => deletedIds.has(pack.categoryId)
    ? normalizePack({ ...pack, categoryId: target.parentId || "", updatedAt: now })
    : pack);
  storage.setStorageSync(CATEGORY_STORAGE_KEY, remainingCategories);
  storage.setStorageSync(STORAGE_KEY, packs);
  return { categories: remainingCategories, packs };
}

function savePrivatePack(pack, storage = wx) {
  const packs = loadPrivatePacks(storage);
  const normalized = normalizePack({ ...pack, updatedAt: Date.now() });
  const index = packs.findIndex((item) => item.id === normalized.id);
  if (index >= 0) packs[index] = normalized;
  else packs.unshift(normalized);
  storage.setStorageSync(STORAGE_KEY, packs.slice(0, 200));
  return normalized;
}

function createPrivatePack(input, storage = wx) {
  return savePrivatePack({
    ...input,
    id: input && input.id || `private-pack-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    questionIds: input && input.questionIds || [],
    source: input && input.source || "created",
    visibility: input && input.visibility || "private",
  }, storage);
}

function getPrivatePack(id, storage = wx) {
  return loadPrivatePacks(storage).find((pack) => pack.id === id) || null;
}

function addQuestionToPack(packId, questionId, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack || !questionId) return null;
  if (pack.questionIds.includes(questionId)) return pack;
  const nodes = [...pack.nodes, {
    id: createNodeId("card"),
    type: "card",
    title: "",
    directoryId: "",
    questionId,
    createdAt: Date.now(),
  }];
  return savePrivatePack({ ...pack, nodes, questionIds: [...pack.questionIds, questionId] }, storage);
}

function removeQuestionFromPack(packId, questionId, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const nodes = pack.nodes.map((node) => node.questionId === questionId ? { ...node, questionId: "" } : node);
  return savePrivatePack({ ...pack, nodes, questionIds: pack.questionIds.filter((id) => id !== questionId) }, storage);
}

// ── 目录/卡片的编排能力（题包编辑页复用知识卡卡集页那套交互所需的最小集合）──

// 目录子树集合：根目录 + 全部后代目录 + 这些目录下的卡片。
function packSubtreeIds(nodes, rootId) {
  const inside = new Set([String(rootId || "")]);
  let changed = true;
  while (changed) {
    changed = false;
    (nodes || []).forEach((node) => {
      if (node.type === "directory" && node.parentId && inside.has(String(node.parentId)) && !inside.has(String(node.id))) {
        inside.add(String(node.id));
        changed = true;
      }
    });
  }
  (nodes || []).forEach((node) => {
    if (node.type === "card" && node.directoryId && inside.has(String(node.directoryId))) inside.add(String(node.id));
  });
  inside.delete("");
  return inside;
}

// 一个目录子树的最后一个节点下标（新子目录/新卡片默认追加在它后面）。
function packSubtreeLastIndex(nodes, rootId) {
  const inside = packSubtreeIds(nodes, rootId);
  return (nodes || []).reduce((last, node, index) => inside.has(String(node.id)) ? index : last, -1);
}

// 在指定目录下新建目录；不传 afterNodeId 时**紧贴该目录之后**插入（成为它的第一个子目录，DEC-085）。
// 不传 parentId 时是顶层新建，追加到末尾。level 自动取父级 +1（封顶三级）。
function insertPackDirectory(packId, input = {}, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const parentId = String(input.parentId || "");
  const parent = parentId ? pack.nodes.find((node) => node.id === parentId && node.type === "directory") : null;
  if (parentId && !parent) return null;
  if (parent && Number(parent.level) >= 3) return null;
  const nodes = [...pack.nodes];
  let anchor = nodes.findIndex((node) => node.id === String(input.afterNodeId || ""));
  if (anchor < 0 && parent) anchor = nodes.findIndex((node) => node.id === parent.id);
  if (anchor < 0) anchor = nodes.length - 1;
  const node = {
    id: createNodeId("directory"),
    type: "directory",
    title: String(input.title || ""),
    level: parent ? Math.min(3, Math.max(1, Number(parent.level) || 1) + 1) : 1,
    parentId: parent ? String(parent.id) : "",
    createdAt: Date.now(),
  };
  nodes.splice(anchor + 1, 0, node);
  savePrivatePack({ ...pack, nodes }, storage);
  return node;
}

// 在指定目录（或未归档区）末尾新建空白卡片。
function appendPackCard(packId, directoryId = "", storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const targetId = String(directoryId || "");
  const nodes = [...pack.nodes];
  let anchor = targetId ? nodes.findIndex((node) => node.id === targetId) : -1;
  nodes.forEach((node, index) => {
    if (node.type === "card" && String(node.directoryId || "") === targetId) anchor = Math.max(anchor, index);
  });
  if (anchor < 0) anchor = nodes.length - 1;
  const node = {
    id: createNodeId("card"),
    type: "card",
    title: "",
    level: 0,
    parentId: "",
    directoryId: targetId,
    questionId: "",
    createdAt: Date.now(),
  };
  nodes.splice(anchor + 1, 0, node);
  savePrivatePack({ ...pack, nodes }, storage);
  return node;
}

// 在某张卡片后面插入一张空白卡片（保持同目录）。
function insertPackCardAfter(packId, afterCardId, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const index = pack.nodes.findIndex((node) => node.id === String(afterCardId || "") && node.type === "card");
  if (index < 0) return null;
  const nodes = [...pack.nodes];
  const node = {
    id: createNodeId("card"),
    type: "card",
    title: "",
    level: 0,
    parentId: "",
    directoryId: String(nodes[index].directoryId || ""),
    questionId: "",
    createdAt: Date.now(),
  };
  nodes.splice(index + 1, 0, node);
  savePrivatePack({ ...pack, nodes }, storage);
  return node;
}

// 把卡片移到目标目录（空字符串 = 未归档）。
function movePackCardToDirectory(packId, nodeId, directoryId = "", storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  return updatePackNode(packId, nodeId, { directoryId: String(directoryId || "") }, storage);
}

// 把目录挂到目标目录下（空字符串 = 一级）；同时按新层级重算整棵子树的 level。
function movePackDirectoryUnder(packId, directoryId, targetParentId = "", storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const id = String(directoryId || "");
  const targetId = String(targetParentId || "");
  const node = pack.nodes.find((item) => item.id === id && item.type === "directory");
  if (!node) return null;
  const target = targetId ? pack.nodes.find((item) => item.id === targetId && item.type === "directory") : null;
  if (targetId && !target) return null;
  if (target && packSubtreeIds(pack.nodes, id).has(target.id)) return null;
  const baseLevel = target ? Math.min(3, Math.max(1, Number(target.level) || 1) + 1) : 1;
  const subtree = packSubtreeIds(pack.nodes, id);
  const depthWithin = (item) => {
    let depth = 0;
    let cursor = item;
    const guard = new Set();
    while (cursor && cursor.parentId && guard.size < 10) {
      if (cursor.parentId === id) return depth + 1;
      guard.add(cursor.id);
      cursor = pack.nodes.find((candidate) => candidate.id === cursor.parentId && candidate.type === "directory");
      depth += 1;
    }
    return depth;
  };
  const nodes = pack.nodes.map((item) => {
    if (item.id === id) return { ...item, parentId: target ? target.id : "", level: baseLevel };
    if (item.type === "directory" && subtree.has(String(item.id))) {
      return { ...item, level: Math.min(3, baseLevel + depthWithin(item)) };
    }
    return item;
  });
  return savePrivatePack({ ...pack, nodes }, storage);
}

function addPackNode(packId, node, afterNodeId = "", storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const normalizedNode = {
    id: node.id || createNodeId(node.type === "directory" ? "directory" : "card"),
    type: node.type === "directory" ? "directory" : "card",
    title: String(node.title || ""),
    level: node.type === "directory" ? Math.min(3, Math.max(1, Number(node.level) || 1)) : 0,
    parentId: node.type === "directory" ? String(node.parentId || "") : "",
    directoryId: node.type === "card" ? String(node.directoryId || "") : "",
    questionId: node.type === "card" ? String(node.questionId || "") : "",
    createdAt: Date.now(),
  };
  const nodes = [...pack.nodes];
  const afterIndex = afterNodeId ? nodes.findIndex((item) => item.id === afterNodeId) : -1;
  if (afterIndex >= 0) nodes.splice(afterIndex + 1, 0, normalizedNode);
  else nodes.push(normalizedNode);
  savePrivatePack({ ...pack, nodes }, storage);
  return normalizedNode;
}

function updatePackNode(packId, nodeId, patch, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const nodes = pack.nodes.map((node) => node.id === nodeId ? { ...node, ...patch, id: node.id, type: node.type } : node);
  return savePrivatePack({ ...pack, nodes }, storage);
}

function deletePackNode(packId, nodeId, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const target = pack.nodes.find((node) => node.id === nodeId);
  if (!target) return pack;
  const nodes = pack.nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => target.type === "directory" && node.directoryId === nodeId ? { ...node, directoryId: "" } : node);
  return savePrivatePack({ ...pack, nodes, questionIds: pack.questionIds.filter((id) => id !== target.questionId) }, storage);
}

function duplicatePackNode(packId, nodeId, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const target = pack.nodes.find((node) => node.id === nodeId);
  if (!target) return null;
  return addPackNode(packId, {
    ...target,
    id: "",
    title: target.type === "directory" ? `${target.title} 副本` : "",
    questionId: "",
  }, nodeId, storage);
}

// 把卡片移动到目标目录的第 index 位（index 按“目标目录里去掉自己之后”的卡片序列算，与卡集页同一约定）。
function movePackCardTo(packId, nodeId, targetDirectoryId = "", index = 0, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const id = String(nodeId || "");
  const target = String(targetDirectoryId || "");
  const node = pack.nodes.find((item) => item.id === id && item.type === "card");
  if (!node) return null;
  if (target && !pack.nodes.some((item) => item.id === target && item.type === "directory")) return null;
  const siblings = pack.nodes
    .filter((item) => item.type === "card" && String(item.directoryId || "") === target)
    .filter((item) => item.id !== id);
  const position = Math.max(0, Math.min(siblings.length, Number(index) || 0));
  const rest = pack.nodes.filter((item) => item.id !== id);
  const anchor = siblings[position];
  let insertAt = -1;
  if (anchor) insertAt = rest.findIndex((item) => item.id === anchor.id);
  if (insertAt < 0) {
    const last = siblings[siblings.length - 1];
    if (last) insertAt = rest.findIndex((item) => item.id === last.id) + 1;
  }
  if (insertAt < 0) {
    const directoryIndex = target ? rest.findIndex((item) => item.id === target) : -1;
    insertAt = directoryIndex >= 0 ? directoryIndex + 1 : rest.length;
  }
  rest.splice(insertAt, 0, { ...node, directoryId: target });
  return savePrivatePack({ ...pack, nodes: rest }, storage);
}

// 多选后整组移动（DEC-074 / DEC-076）：一批卡片一起进目标目录，保持原有相对顺序、插在落点位置。
function movePackCardsTo(packId, nodeIds, targetDirectoryId = "", index = 0, storage = wx) {
  const ids = (Array.isArray(nodeIds) ? nodeIds : [nodeIds]).map((id) => String(id || "")).filter(Boolean);
  if (ids.length <= 1) return movePackCardTo(packId, ids[0] || "", targetDirectoryId, index, storage);
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const target = String(targetDirectoryId || "");
  if (target && !pack.nodes.some((item) => item.id === target && item.type === "directory")) return null;
  const idSet = new Set(ids);
  const moving = pack.nodes.filter((item) => item.type === "card" && idSet.has(String(item.id)));
  if (!moving.length) return null;
  const rest = pack.nodes.filter((item) => !(item.type === "card" && idSet.has(String(item.id))));
  const siblings = rest.filter((item) => item.type === "card" && String(item.directoryId || "") === target);
  const position = Math.max(0, Math.min(siblings.length, Number(index) || 0));
  const anchor = siblings[position];
  let insertAt = anchor ? rest.findIndex((item) => item.id === anchor.id) : -1;
  if (insertAt < 0) {
    const last = siblings[siblings.length - 1];
    if (last) insertAt = rest.findIndex((item) => item.id === last.id) + 1;
  }
  if (insertAt < 0) {
    const directoryIndex = target ? rest.findIndex((item) => item.id === target) : -1;
    insertAt = directoryIndex >= 0 ? directoryIndex + 1 : rest.length;
  }
  rest.splice(insertAt, 0, ...moving.map((card) => ({ ...card, directoryId: target })));
  savePrivatePack({ ...pack, nodes: rest }, storage);
  return { movedCount: moving.length };
}

// 把目录排到同一父级下的第 index 位（index 同样按“去掉自己之后”的兄弟序列算）。
function movePackDirectoryToIndex(packId, directoryId, index = 0, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const id = String(directoryId || "");
  const node = pack.nodes.find((item) => item.id === id && item.type === "directory");
  if (!node) return null;
  const siblings = pack.nodes
    .filter((item) => item.type === "directory" && String(item.parentId || "") === String(node.parentId || ""))
    .filter((item) => item.id !== id);
  const position = Math.max(0, Math.min(siblings.length, Number(index) || 0));
  const rest = pack.nodes.filter((item) => item.id !== id);
  const anchor = siblings[position];
  let insertAt = anchor ? rest.findIndex((item) => item.id === anchor.id) : -1;
  if (insertAt < 0) {
    const last = siblings[siblings.length - 1];
    if (last) insertAt = rest.findIndex((item) => item.id === last.id) + 1;
    else insertAt = rest.length;
  }
  rest.splice(insertAt, 0, node);
  return savePrivatePack({ ...pack, nodes: rest }, storage);
}

// DEC-054 的题包版：把源目录从第 index 张起的卡片划给被拖拽目录，
// 被拖拽目录排到源目录之后并继承源目录的层级（同级同父）。
function adoptPackCardsIntoDirectory(packId, directoryId, sourceDirectoryId, index = 0, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const dragged = pack.nodes.find((item) => item.id === String(directoryId || "") && item.type === "directory");
  const source = pack.nodes.find((item) => item.id === String(sourceDirectoryId || "") && item.type === "directory");
  if (!dragged || !source || dragged.id === source.id) return null;
  if (packSubtreeIds(pack.nodes, dragged.id).has(source.id)) return null;
  const sourceCards = pack.nodes.filter((item) => item.type === "card" && String(item.directoryId || "") === source.id);
  const moving = sourceCards.slice(Math.max(0, Number(index) || 0)).map((item) => item.id);
  if (!moving.length) return null;
  const movingSet = new Set(moving);
  const updated = pack.nodes.map((item) => {
    if (item.id === dragged.id) {
      return { ...item, parentId: String(source.parentId || ""), level: Math.min(3, Math.max(1, Number(source.level) || 1)) };
    }
    if (item.type === "card" && movingSet.has(item.id)) return { ...item, directoryId: dragged.id };
    return item;
  });
  const draggedNode = updated.find((item) => item.id === dragged.id);
  const rest = updated.filter((item) => item.id !== dragged.id);
  const sourceIndex = rest.findIndex((item) => item.id === source.id);
  rest.splice(sourceIndex + 1, 0, draggedNode);
  savePrivatePack({ ...pack, nodes: rest }, storage);
  return { movedCount: moving.length, directory: dragged.title || "未命名目录" };
}

// 给一批卡片节点上色（空字符串 = 无色）；颜色键的合法性由调用方用知识卡色板校验。
function setPackCardsColor(packId, nodeIds, colorKey = "", storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const targets = new Set((Array.isArray(nodeIds) ? nodeIds : [nodeIds]).map((id) => String(id || "")).filter(Boolean));
  if (!targets.size) return pack;
  const color = String(colorKey || "");
  const nodes = pack.nodes.map((node) => (
    node.type === "card" && targets.has(String(node.id)) ? { ...node, color } : node
  ));
  return savePrivatePack({ ...pack, nodes }, storage);
}

// 按“每张卡片 → 颜色键”的映射批量上色（彩虹色用）：一次落盘，避免逐张保存。
function applyPackCardColors(packId, colorByNodeId, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const map = colorByNodeId || {};
  let changed = 0;
  const nodes = pack.nodes.map((node) => {
    if (node.type !== "card") return node;
    const key = String(node.id);
    if (!Object.prototype.hasOwnProperty.call(map, key)) return node;
    changed += 1;
    return { ...node, color: String(map[key] || "") };
  });
  if (!changed) return pack;
  return savePrivatePack({ ...pack, nodes }, storage);
}

function movePackNode(packId, nodeId, direction, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  if (!pack) return null;
  const nodes = [...pack.nodes];
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return pack;
  const node = nodes[index];
  const siblingIndexes = nodes
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter(({ item }) => item.type === node.type && (node.type === "directory" ? item.parentId === node.parentId : item.directoryId === node.directoryId))
    .map(({ itemIndex }) => itemIndex);
  const siblingPosition = siblingIndexes.indexOf(index);
  const targetPosition = direction === "up" ? siblingPosition - 1 : siblingPosition + 1;
  if (targetPosition < 0 || targetPosition >= siblingIndexes.length) return pack;
  const targetIndex = siblingIndexes[targetPosition];
  [nodes[index], nodes[targetIndex]] = [nodes[targetIndex], nodes[index]];
  return savePrivatePack({ ...pack, nodes }, storage);
}

function attachQuestionToCard(packId, cardId, questionId, storage = wx) {
  const pack = getPrivatePack(packId, storage);
  const card = pack && pack.nodes.find((node) => node.id === cardId && node.type === "card");
  if (!card || !questionId) return addQuestionToPack(packId, questionId, storage);
  const nodes = pack.nodes.map((node) => node.id === cardId ? { ...node, questionId } : node);
  const questionIds = [...pack.questionIds.filter((id) => id !== card.questionId), questionId];
  return savePrivatePack({ ...pack, nodes, questionIds }, storage);
}

function movePackNodeToPack(sourcePackId, nodeId, targetPackId, storage = wx) {
  if (!sourcePackId || !targetPackId || sourcePackId === targetPackId) return null;
  const source = getPrivatePack(sourcePackId, storage);
  const target = getPrivatePack(targetPackId, storage);
  if (!source || !target) return null;
  const node = source.nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  const movingIds = new Set([nodeId]);
  if (node.type === "directory") {
    let discovered = true;
    while (discovered) {
      discovered = false;
      source.nodes.forEach((item) => {
        if (item.type === "directory" && item.parentId && movingIds.has(item.parentId) && !movingIds.has(item.id)) {
          movingIds.add(item.id);
          discovered = true;
        }
      });
    }
    source.nodes.forEach((item) => {
      if (item.type === "card" && movingIds.has(item.directoryId)) movingIds.add(item.id);
    });
  }
  const movingNodes = source.nodes.filter((item) => movingIds.has(item.id));
  const movingQuestionIds = new Set(movingNodes.map((item) => item.questionId).filter(Boolean));
  const sourceNodes = source.nodes.filter((item) => !movingIds.has(item.id));
  savePrivatePack({ ...source, nodes: sourceNodes, questionIds: source.questionIds.filter((id) => !movingQuestionIds.has(id)) }, storage);
  return savePrivatePack({
    ...target,
    nodes: [...target.nodes, ...movingNodes.map((item) => ({
      ...item,
      parentId: item.type === "directory" && item.id === node.id ? "" : item.parentId,
      directoryId: item.type === "card" && node.type !== "directory" ? "" : item.directoryId,
    }))],
    questionIds: [...target.questionIds, ...movingQuestionIds],
  }, storage);
}

function deletePrivatePack(id, storage = wx) {
  const packs = loadPrivatePacks(storage).filter((pack) => pack.id !== id);
  storage.setStorageSync(STORAGE_KEY, packs);
  return packs;
}

function copyCommunityPack(sourcePack, storage = wx) {
  const sourcePackId = sourcePack && sourcePack.id;
  const existing = loadPrivatePacks(storage).find((pack) => pack.sourcePackId === sourcePackId);
  if (existing) return existing;
  return createPrivatePack({
    name: sourcePack.name || sourcePack.title || "社区题包",
    description: sourcePack.description || sourcePack.excerpt || "",
    tags: sourcePack.tags || [],
    questionIds: sourcePack.questionIds || [],
    source: "community_import",
    sourcePackId,
  }, storage);
}

function packStats(packs) {
  const list = Array.isArray(packs) ? packs : [];
  return {
    total: list.length,
    questions: list.reduce((sum, pack) => sum + (pack.questionIds || []).length, 0),
    created: list.filter((pack) => pack.source !== "community_import").length,
    imported: list.filter((pack) => pack.source === "community_import").length,
  };
}

function parseOptions(optionsText) {
  return String(optionsText || "")
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.trim().match(/^([A-Z])[.、．:：\s]+(.+)$/i);
      return match
        ? { key: match[1].toUpperCase(), text: match[2].trim() }
        : { key: String.fromCharCode(65 + index), text: line.trim() };
    })
    .filter((option) => option.text);
}

function normalizeQuestionForPractice(asset, index = 0) {
  const type = QUESTION_TYPE_MAP[asset.questionType] || asset.typeCode || "short_answer";
  const isChoice = type === "single_choice" || type === "multiple_choice" || type === "true_false";
  const answerMatches = Array.isArray(asset.correctAnswer) && asset.correctAnswer.length
    ? asset.correctAnswer.map((answer) => String(answer).toUpperCase())
    : (String(asset.referenceAnswer || "").toUpperCase().match(/[A-Z]/g) || []);
  const scoringPoints = Array.isArray(asset.scoringPoints) && asset.scoringPoints.length
    ? asset.scoringPoints
    : String(asset.scoringPointsText || "")
      .split(/\r?\n/)
      .map((line, pointIndex) => ({ id: `point-${pointIndex + 1}`, description: line.trim(), score: 1, evidenceGroups: [] }))
      .filter((point) => point.description);
  return {
    id: asset.id,
    chapterId: `private-pack-${asset.packId || "questions"}`,
    sectionId: `private-pack-${asset.packId || "questions"}`,
    type,
    typeLabel: asset.questionType || "简答题",
    answerMode: isChoice ? "choice" : "text",
    score: Math.max(1, Number(asset.score) || (scoringPoints.length || 10)),
    breadcrumb: [asset.subjectName, asset.questionType].filter(Boolean).join(" · ") || "私人题库",
    knowledgePoint: (asset.knowledgePoints || [])[0] || (asset.tags || [])[0] || "自建题目",
    stem: asset.stem || asset.title || `题目 ${index + 1}`,
    options: type === "true_false"
      ? (parseOptions(asset.optionsText).length ? parseOptions(asset.optionsText) : [{ key: "A", text: "正确" }, { key: "B", text: "错误" }])
      : parseOptions(asset.optionsText),
    correctAnswer: isChoice ? [...new Set(answerMatches)] : [],
    referenceAnswer: asset.referenceAnswer || "暂未填写参考答案",
    scoringPoints,
    source: asset.sourceReference || "私人题包",
    answerPlaceholder: "请输入你的答案，可分点作答……",
    answerMaxLength: 3000,
  };
}

module.exports = {
  CATEGORY_STORAGE_KEY,
  STORAGE_KEY,
  addPackNode,
  addQuestionToPack,
  adoptPackCardsIntoDirectory,
  appendPackCard,
  applyPackCardColors,
  attachQuestionToCard,
  copyCommunityPack,
  createPrivatePackCategory,
  createPrivatePack,
  deletePrivatePack,
  deletePrivatePackCategory,
  deletePackNode,
  duplicatePackNode,
  getPrivatePack,
  insertPackCardAfter,
  insertPackDirectory,
  loadPrivatePacks,
  loadPrivatePackCategories,
  movePackCardToDirectory,
  movePackCardsTo,
  movePackCardTo,
  movePackDirectoryToIndex,
  movePackDirectoryUnder,
  normalizePack,
  normalizeQuestionForPractice,
  renamePrivatePackCategory,
  movePackNode,
  movePackNodeToPack,
  packStats,
  removeQuestionFromPack,
  savePrivatePack,
  setPackCardsColor,
  updatePackNode,
};
