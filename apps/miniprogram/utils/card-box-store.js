const STORAGE_KEY = "shukao_card_box_sets";
const FOLDER_STORAGE_KEY = "shukao_card_box_folders";
const ACTIVE_FOLDER_STORAGE_KEY = "shukao_card_box_active_folder";
const DEFAULT_FOLDERS = ["我的卡集", "期末复习"];
const ALL_FOLDERS = "全部卡集";
const FALLBACK_SECTION = "未分类";

// 卡片与卡盒共用的浅色板（DEC-067）：soft 是铺在整块卡面上的浅色底，accent 用于小字与进度条。
// 取色原则：统一高明度（≈92%）+ 色相校准 + 彩度略提，避免"发灰显脏"的鼠尾草绿、灰玫瑰。
const CARD_COLORS = [
  { key: "rose", label: "浅粉", soft: "#FBD9E0", accent: "#C04A66" },
  { key: "peach", label: "蜜桃", soft: "#FDE0CE", accent: "#C2663A" },
  { key: "cream", label: "奶油", soft: "#FBEEC4", accent: "#A2842A" },
  { key: "mint", label: "薄荷", soft: "#D8F2DE", accent: "#3D8B54" },
  { key: "aqua", label: "浅青", soft: "#D2F1EC", accent: "#2A8A80" },
  { key: "lemon", label: "鹅黄", soft: "#FCECAC", accent: "#9A7A14" },
  { key: "sky", label: "天蓝", soft: "#D5ECFA", accent: "#2A79A8" },
  { key: "blue", label: "浅蓝", soft: "#D9E5FB", accent: "#4468B8" },
  { key: "lilac", label: "浅紫", soft: "#E3DAFA", accent: "#6650AE" },
];
const CARD_COLOR_KEYS = CARD_COLORS.map((item) => item.key);
function hexToRgba(hex, alpha) {
  const value = parseInt(String(hex || "").replace("#", ""), 16);
  if (!Number.isFinite(value)) return "";
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
// 整块底色：主高光 + 锐利镜面点 + 底部透光 + 背光侧折射暗部 + 浅色。
// 真机与观感反馈汇总：① 高光峰值不能贴边（会把左上角洗白、边界糊掉）；② 只堆白色高光会显“塑料”，
// 玻璃要有“小而锐的镜面点 + 背光侧同色暗部”才通透。
function cardColorBackground(value) {
  const picked = cardColor(value);
  if (!picked) return "";
  return [
    "linear-gradient(150deg, rgba(255,255,255,.42) 0%, rgba(255,255,255,.12) 34%, rgba(255,255,255,0) 58%)",
    "radial-gradient(18% 12% at 76% 9%, rgba(255,255,255,.95) 0%, rgba(255,255,255,.34) 34%, rgba(255,255,255,0) 62%)",
    "linear-gradient(0deg, rgba(255,255,255,.22) 0%, rgba(255,255,255,0) 20%)",
    `linear-gradient(336deg, ${hexToRgba(picked.accent, 0.12)} 0%, rgba(255,255,255,0) 42%)`,
    picked.soft,
  ].join(", ");
}
// 玻璃边缘：同色系深色低透明度描边，给卡片一圈可辨的边界（透明描边会让上色卡片“糊”在浅色背景里）。
function cardColorEdge(value) {
  const picked = cardColor(value);
  return picked ? hexToRgba(picked.accent, 0.26) : "";
}
// 旧版四色命名值的迁移表：green 是当年的**默认值**（没有任何颜色 UI，用户从未选择过），
// 因此映射为“无色”，避免历史卡盒被一次性刷成浅绿；amber/blue/rose 才是刻意选过的颜色。
const LEGACY_CARD_COLORS = { green: "", amber: "cream", blue: "sky", rose: "rose" };
function cardColor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const key = Object.prototype.hasOwnProperty.call(LEGACY_CARD_COLORS, raw) ? LEGACY_CARD_COLORS[raw] : raw;
  if (!key) return null;
  return CARD_COLORS.find((item) => item.key === key) || null;
}
function setCardColors(setId, cardIds, colorKey) {
  const ids = (Array.isArray(cardIds) ? cardIds : []).filter(Boolean);
  if (!setId || !ids.length) return null;
  const picked = cardColor(colorKey);
  return updateSet(setId, (set) => ({
    ...set,
    cards: (Array.isArray(set.cards) ? set.cards : []).map((card) => (
      ids.includes(card.id) ? { ...card, color: picked ? picked.key : "" } : card
    )),
  }));
}

// 卡盒颜色：旧命名色先迁移到新色板 key，未知值清空。
function normalizeSetColor(value) {
  const picked = cardColor(value);
  return picked ? picked.key : "";
}
function setSetsColor(setIds, colorKey) {
  const ids = (Array.isArray(setIds) ? setIds : []).filter(Boolean);
  if (!ids.length) return 0;
  const picked = cardColor(colorKey);
  let changed = 0;
  const sets = loadCardSets().map((set) => {
    if (!ids.includes(set.id)) return set;
    changed += 1;
    return { ...set, color: picked ? picked.key : "" };
  });
  if (changed) saveCardSets(sets);
  return changed;
}
// 彩虹色：按给定顺序依次套用渐变色，超出色板长度时循环。
function applyRainbowSetColors(setIds) {
  const ids = (Array.isArray(setIds) ? setIds : []).filter(Boolean);
  if (!ids.length) return [];
  const assignment = new Map(ids.map((id, index) => [id, CARD_COLORS[index % CARD_COLORS.length].key]));
  const sets = loadCardSets().map((set) => (
    assignment.has(set.id) ? { ...set, color: assignment.get(set.id) } : set
  ));
  saveCardSets(sets);
  return ids.map((id) => assignment.get(id));
}

const seedSets = [
  {
    id: "modern-chinese",
    title: "现代汉语",
    subtitle: "增订七版 · 上册",
    author: "黄伯荣、廖序东",
    subject: "专业课",
    progress: 12,
    due: 3,
    color: "green",
    cards: [
      { id: "mc-1", type: "qa", section: "第一章 绪论", question: "什么是现代汉民族共同语？", answer: "以北京语音为标准音、以北方话为基础方言、以典范的现代白话文著作为语法规范的普通话。", mnemonic: "北京音，北方话，白话文。", hints: ["以北京语音为标准音", "以北方话为基础方言", "以典范的现代白话文著作为语法规范"], associations: ["普通话的推广", "现代汉语方言"], state: "learning" },
      { id: "mc-2", type: "qa", section: "第一章 绪论", question: "现代汉语有哪些主要方言？", answer: "官话、吴语、湘语、赣语、客家语、闽语、粤语七大方言。", mnemonic: "官吴湘赣，客闽粤。", hints: ["共七大方言", "官话、吴语、湘语、赣语", "客家语、闽语、粤语"], associations: ["方言调查"], state: "new" },
      { id: "mc-3", type: "qa", section: "第二章 语音", question: "汉语音节由哪些部分构成？", answer: "音节通常由声母、韵母和声调构成；韵母又可分析为韵头、韵腹和韵尾。", mnemonic: "声韵调，韵头腹尾。", hints: ["声母、韵母和声调", "韵母可再分三部分"], associations: ["声母发音部位", "韵母结构"], state: "learning" },
    ],
  },
  { id: "ancient-literature", title: "中国古代文学", subtitle: "先秦至唐宋", author: "课程重点整理", subject: "专业课", progress: 0, due: 0, color: "amber", cards: [
    { id: "al-1", type: "qa", section: "诗经", question: "《诗经》的主要内容分类是什么？", answer: "风、雅、颂。", mnemonic: "风雅颂。", hints: ["三类", "风、雅、颂"], associations: ["赋比兴"], state: "new" },
    { id: "al-2", type: "note", section: "楚辞", question: "香草美人", answer: "常被用来寄托高洁人格与政治理想，是《离骚》重要的象征系统。", mnemonic: "香草寄德，美人寄君。", hints: ["象征系统", "人格与理想"], associations: ["《离骚》"], state: "new" },
  ] },
  { id: "linguistics", title: "语言学概论", subtitle: "期末高频概念", author: "我的整理", subject: "专业课", progress: 38, due: 6, color: "blue", cards: [
    { id: "lg-1", type: "qa", section: "语言的本质", question: "语言的社会性体现在哪里？", answer: "语言是社会约定俗成的交际工具，随着社会发展而发展，并服务于社会成员的共同交际。", mnemonic: "约定、交际、发展。", hints: ["社会约定俗成", "共同交际工具"], associations: ["语言的全民性"], state: "learning" },
  ] },
  { id: "writing", title: "写作素材", subtitle: "论述题可用表达", author: "持续收集", subject: "通识", progress: 0, due: 0, color: "rose", cards: [] },
];

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function uniqueNames(names) { return [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))]; }
function sectionTitle(card) { return String(card && card.section || FALLBACK_SECTION).trim() || FALLBACK_SECTION; }
function directoryLevel(levels, title) { return Math.min(3, Math.max(1, Number(levels && levels[title]) || 1)); }
function orderedSectionNames(set) {
  return uniqueNames([
    ...(Array.isArray(set && set.sectionOrder) ? set.sectionOrder : []),
    ...((set && Array.isArray(set.cards)) ? set.cards.map(sectionTitle) : []),
  ]);
}
function relativeDirectoryInsertIndex(titles, levels, referenceTitle, placement) {
  const referenceIndex = titles.indexOf(referenceTitle);
  if (referenceIndex < 0) return -1;
  if (placement === "before") return referenceIndex;
  if (placement !== "after") return -1;
  const referenceLevel = directoryLevel(levels, referenceTitle);
  let insertIndex = referenceIndex + 1;
  while (insertIndex < titles.length && directoryLevel(levels, titles[insertIndex]) > referenceLevel) {
    insertIndex += 1;
  }
  return insertIndex;
}
function groupCardsBySectionOrder(cards, titles) {
  return (titles || []).flatMap((title) => (cards || []).filter((card) => sectionTitle(card) === title));
}

function sectionCardIndexes(cards, section) {
  const indexes = [];
  (cards || []).forEach((card, index) => {
    if (sectionTitle(card) === section) indexes.push(index);
  });
  return indexes;
}

function emptySectionInsertIndex(cards, sectionOrder, section) {
  const position = sectionOrder.indexOf(section);
  if (position < 0) return cards.length;
  const laterSections = new Set(sectionOrder.slice(position + 1));
  if (!laterSections.size) return cards.length;
  const index = cards.findIndex((card) => laterSections.has(sectionTitle(card)));
  return index < 0 ? cards.length : index;
}

function moveCardInSet(setId, cardId, targetSection, targetIndex) {
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0 || !Array.isArray(sets[setIndex].cards)) return null;
  const set = sets[setIndex];
  const card = set.cards.find((item) => item.id === cardId);
  if (!card) return null;

  const sectionOrder = orderedSectionNames(set);
  const directory = String(targetSection || "").trim() || sectionTitle(card);
  if (!sectionOrder.includes(directory)) return null;

  const remaining = set.cards.filter((item) => item.id !== cardId);
  const slots = sectionCardIndexes(remaining, directory);
  const requested = Math.max(0, Math.floor(Number(targetIndex) || 0));
  const slot = Math.min(requested, slots.length);
  const insertIndex = slot >= slots.length
    ? (slots.length ? slots[slots.length - 1] + 1 : emptySectionInsertIndex(remaining, sectionOrder, directory))
    : slots[slot];
  const moved = { ...card, section: directory };
  remaining.splice(insertIndex, 0, moved);

  const unchanged = directory === sectionTitle(card)
    && remaining.every((item, index) => item.id === set.cards[index].id);
  if (unchanged) return moved;

  sets[setIndex] = { ...set, cards: remaining };
  saveCardSets(sets);
  return moved;
}

// 多选后整组移动：被拖的卡片连同其它已选卡片一起进目标目录，保持原有相对顺序（DEC-074）。
function moveCardsInSet(setId, cardIds, targetSection, targetIndex) {
  const ids = (Array.isArray(cardIds) ? cardIds : [cardIds]).map((id) => String(id || "")).filter(Boolean);
  if (ids.length <= 1) return moveCardInSet(setId, ids[0] || "", targetSection, targetIndex);
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0 || !Array.isArray(sets[setIndex].cards)) return null;
  const set = sets[setIndex];
  const movingIds = new Set(ids);
  const moving = set.cards.filter((card) => movingIds.has(card.id));
  if (!moving.length) return null;
  const sectionOrder = orderedSectionNames(set);
  const directory = String(targetSection || "").trim() || sectionTitle(moving[0]);
  if (!sectionOrder.includes(directory)) return null;

  const remaining = set.cards.filter((card) => !movingIds.has(card.id));
  const slots = sectionCardIndexes(remaining, directory);
  const requested = Math.max(0, Math.floor(Number(targetIndex) || 0));
  const slot = Math.min(requested, slots.length);
  const insertIndex = slot >= slots.length
    ? (slots.length ? slots[slots.length - 1] + 1 : emptySectionInsertIndex(remaining, sectionOrder, directory))
    : slots[slot];
  remaining.splice(insertIndex, 0, ...moving.map((card) => ({ ...card, section: directory })));

  sets[setIndex] = { ...set, cards: remaining };
  saveCardSets(sets);
  return { movedCount: moving.length, directory };
}

function moveDirectoryToIndex(setId, title, targetIndex) {
  const directory = String(title || "").trim();
  if (!directory) return null;
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0) return null;
  const set = sets[setIndex];
  const sectionOrder = orderedSectionNames(set);
  const fromIndex = sectionOrder.indexOf(directory);
  if (fromIndex < 0) return null;

  const remaining = sectionOrder.filter((item) => item !== directory);
  const slot = Math.max(0, Math.min(Math.floor(Number(targetIndex) || 0), remaining.length));
  if (slot === fromIndex) return { sectionOrder };
  remaining.splice(slot, 0, directory);
  sets[setIndex] = {
    ...set,
    sectionOrder: remaining,
    cards: groupCardsBySectionOrder(set.cards, remaining),
  };
  saveCardSets(sets);
  return { sectionOrder: remaining };
}

function moveCardSet(setId, targetSetId, placement) {
  const id = String(setId || "").trim();
  const target = String(targetSetId || "").trim();
  if (!id || !target || id === target) return null;
  if (placement !== "before" && placement !== "after") return null;
  const sets = loadCardSets();
  const fromIndex = sets.findIndex((set) => set.id === id);
  if (fromIndex < 0 || !sets.some((set) => set.id === target)) return null;
  const [moved] = sets.splice(fromIndex, 1);
  const targetIndex = sets.findIndex((set) => set.id === target);
  sets.splice(targetIndex + (placement === "after" ? 1 : 0), 0, moved);
  saveCardSets(sets);
  return { setId: id, targetSetId: target, placement };
}

function adoptCardsIntoDirectory(setId, directory, sourceSection, cardIndex) {
  const target = String(directory || "").trim();
  const source = String(sourceSection || "").trim();
  if (!target || !source || target === source) return null;
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0 || !Array.isArray(sets[setIndex].cards)) return null;
  const set = sets[setIndex];
  const sectionOrder = orderedSectionNames(set);
  if (!sectionOrder.includes(target) || !sectionOrder.includes(source)) return null;

  const sourceCards = set.cards.filter((card) => sectionTitle(card) === source);
  const from = Math.max(0, Math.min(Math.floor(Number(cardIndex) || 0), sourceCards.length));
  const adoptedIds = new Set(sourceCards.slice(from).map((card) => card.id));
  if (!adoptedIds.size) return null;

  const ownCards = set.cards.filter((card) => sectionTitle(card) === target);
  const adoptedCards = set.cards.filter((card) => adoptedIds.has(card.id));
  const movedCards = set.cards.map((card) => (adoptedIds.has(card.id) ? { ...card, section: target } : card));
  const byId = new Map(movedCards.map((card) => [card.id, card]));
  const takenOver = [...ownCards, ...adoptedCards].map((card) => byId.get(card.id));
  const order = sectionOrder.filter((item) => item !== target);
  const sourceIndex = order.indexOf(source);
  if (sourceIndex < 0) return null;
  order.splice(sourceIndex + 1, 0, target);
  const level = directoryLevel(set.sectionLevels, source);
  const cards = order.flatMap((title) => (
    title === target ? takenOver : movedCards.filter((card) => sectionTitle(card) === title)
  ));
  sets[setIndex] = {
    ...set,
    cards,
    sectionOrder: order,
    sectionLevels: { ...(set.sectionLevels || {}), [target]: level },
  };
  saveCardSets(sets);
  return {
    directory: target,
    sourceSection: source,
    movedCount: adoptedIds.size,
    remainingCount: sourceCards.length - adoptedIds.size,
    level,
  };
}

function isCanonicalDirectoryPlaceholder(card) {
  return Boolean(card && card.isDirectoryPlaceholder)
    && String(card.question || "").trim() === "新目录"
    && String(card.answer || "").trim() === "在这里添加第一张卡片";
}
function normalizeCardSet(set) {
  if (!set || typeof set !== "object") return set;
  const sourceCards = Array.isArray(set.cards) ? set.cards : [];
  const sectionOrder = uniqueNames([
    ...(Array.isArray(set.sectionOrder) ? set.sectionOrder : []),
    ...sourceCards.map(sectionTitle),
  ]);
  const cards = sourceCards.reduce((items, card) => {
    if (!card || typeof card !== "object" || isCanonicalDirectoryPlaceholder(card)) return items;
    const normalizedCard = { ...card };
    if (Object.prototype.hasOwnProperty.call(card, "section")) normalizedCard.section = sectionTitle(card);
    if (normalizedCard.isDirectoryPlaceholder) delete normalizedCard.isDirectoryPlaceholder;
    items.push(normalizedCard);
    return items;
  }, []);
  const previousLevels = set.sectionLevels || {};
  const sectionLevels = Object.fromEntries(sectionOrder.map((title) => [
    title,
    Math.min(3, Math.max(1, Number(previousLevels[title]) || 1)),
  ]));
  return { ...set, color: normalizeSetColor(set.color), cards, sectionOrder, sectionLevels };
}
function normalizeCardSets(sets) { return (sets || []).map(normalizeCardSet).filter(Boolean); }
function loadCardSets() {
  const stored = wx.getStorageSync(STORAGE_KEY);
  return normalizeCardSets(Array.isArray(stored) ? stored : clone(seedSets));
}
function saveCardSets(sets) {
  const normalized = normalizeCardSets(sets);
  wx.setStorageSync(STORAGE_KEY, normalized);
  return normalized;
}
function ensureCardSetMetadata(id) {
  const stored = wx.getStorageSync(STORAGE_KEY);
  const source = Array.isArray(stored) ? stored : clone(seedSets);
  const index = source.findIndex((set) => set.id === id);
  if (index < 0) return null;
  const normalized = normalizeCardSet(source[index]);
  if (JSON.stringify(source[index]) !== JSON.stringify(normalized)) {
    const next = [...source];
    next[index] = normalized;
    saveCardSets(next);
  }
  return normalized;
}
function loadCardFolders() {
  const stored = wx.getStorageSync(FOLDER_STORAGE_KEY);
  const saved = Array.isArray(stored) ? stored : DEFAULT_FOLDERS;
  const assigned = loadCardSets().map((set) => set.folder).filter(Boolean);
  const folders = uniqueNames([...saved, ...assigned]);
  return folders.length ? folders : [DEFAULT_FOLDERS[0]];
}
function saveCardFolders(folders) {
  const normalized = uniqueNames(folders);
  wx.setStorageSync(FOLDER_STORAGE_KEY, normalized.length ? normalized : [DEFAULT_FOLDERS[0]]);
  return normalized.length ? normalized : [DEFAULT_FOLDERS[0]];
}
function loadActiveCardFolder() {
  const folders = loadCardFolders();
  const remembered = String(wx.getStorageSync(ACTIVE_FOLDER_STORAGE_KEY) || "").trim();
  const activeFolder = remembered === ALL_FOLDERS || folders.includes(remembered)
    ? remembered
    : folders[0];
  if (remembered !== activeFolder) wx.setStorageSync(ACTIVE_FOLDER_STORAGE_KEY, activeFolder);
  return activeFolder;
}
function saveActiveCardFolder(name) {
  const folders = loadCardFolders();
  const requested = String(name || "").trim();
  const activeFolder = requested === ALL_FOLDERS || folders.includes(requested)
    ? requested
    : folders[0];
  if (wx.getStorageSync(ACTIVE_FOLDER_STORAGE_KEY) !== activeFolder) {
    wx.setStorageSync(ACTIVE_FOLDER_STORAGE_KEY, activeFolder);
  }
  return activeFolder;
}
function createCardFolder(name) {
  const folder = String(name || "").trim();
  const folders = loadCardFolders();
  if (!folder || folder === ALL_FOLDERS || folders.includes(folder)) return null;
  saveCardFolders([...folders, folder]);
  return folder;
}
function renameCardFolder(previousName, nextName) {
  const previous = String(previousName || "").trim();
  const next = String(nextName || "").trim();
  const folders = loadCardFolders();
  if (!previous || !next || next === ALL_FOLDERS || !folders.includes(previous) || (previous !== next && folders.includes(next))) return null;
  const remembered = String(wx.getStorageSync(ACTIVE_FOLDER_STORAGE_KEY) || "").trim();
  const sets = loadCardSets().map((set) => ((set.folder || DEFAULT_FOLDERS[0]) === previous ? { ...set, folder: next } : set));
  saveCardSets(sets);
  saveCardFolders(folders.map((folder) => folder === previous ? next : folder));
  if (remembered === previous) saveActiveCardFolder(next);
  return next;
}
function deleteCardFolder(name) {
  const folder = String(name || "").trim();
  const folders = loadCardFolders();
  if (!folder || !folders.includes(folder) || folders.length < 2) return null;
  const remaining = folders.filter((item) => item !== folder);
  const fallback = remaining.includes(DEFAULT_FOLDERS[0]) ? DEFAULT_FOLDERS[0] : remaining[0];
  const remembered = String(wx.getStorageSync(ACTIVE_FOLDER_STORAGE_KEY) || "").trim();
  const sets = loadCardSets().map((set) => ((set.folder || DEFAULT_FOLDERS[0]) === folder ? { ...set, folder: fallback } : set));
  saveCardSets(sets);
  saveCardFolders(remaining);
  if (remembered === folder) saveActiveCardFolder(fallback);
  return { folders: remaining, fallback };
}
function findSet(id) { return loadCardSets().find((item) => item.id === id); }
function findCard(setId, id) {
  const set = findSet(setId);
  return set && Array.isArray(set.cards) ? set.cards.find((card) => card.id === id) : undefined;
}
function updateSet(id, updater) {
  const sets = loadCardSets();
  const index = sets.findIndex((item) => item.id === id);
  if (index < 0) return null;
  sets[index] = updater(sets[index]);
  saveCardSets(sets);
  return sets[index];
}
function cardId() { return `card-${Date.now()}-${Math.floor(Math.random() * 10000)}`; }
function addCardToSet(setId, card) {
  if (!card || typeof card !== "object") return null;
  let addedCard = null;
  const updatedSet = updateSet(setId, (set) => {
    addedCard = { ...card };
    const cards = [...(Array.isArray(set.cards) ? set.cards : []), addedCard];
    return { ...set, cards };
  });
  return updatedSet ? addedCard : null;
}
function insertBlankCardInSet(setId, referenceId, placement) {
  if (placement !== "before" && placement !== "after") return null;
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0 || !Array.isArray(sets[setIndex].cards)) return null;
  const referenceIndex = sets[setIndex].cards.findIndex((card) => card.id === referenceId);
  if (referenceIndex < 0) return null;

  const referenceCard = sets[setIndex].cards[referenceIndex];
  const existingIds = new Set(sets[setIndex].cards.map((card) => card.id));
  const blankCard = {
    ...blankCardInDirectory(sectionTitle(referenceCard)),
    id: uniqueCardId(existingIds, cardId()),
  };
  const cards = [...sets[setIndex].cards];
  cards.splice(referenceIndex + (placement === "after" ? 1 : 0), 0, blankCard);
  sets[setIndex] = { ...sets[setIndex], cards };
  saveCardSets(sets);
  return blankCard;
}
function blankCardInDirectory(directory) {
  const generatedId = cardId();
  return {
    id: generatedId,
    type: "qa",
    section: directory,
    question: "",
    answer: "",
    answerHtml: "",
    answerDelta: { ops: [] },
    answerSegments: [],
    answerImages: [],
    mnemonic: "",
    associations: [],
    state: "new",
  };
}

function uniqueCardId(existingIds, generatedId) {
  let nextId = generatedId;
  let duplicateIndex = 1;
  while (existingIds.has(nextId)) {
    nextId = `${generatedId}-${duplicateIndex}`;
    duplicateIndex += 1;
  }
  return nextId;
}

function appendBlankCardToDirectory(setId, directoryTitle) {
  const directory = String(directoryTitle || "").trim();
  if (!directory) return null;
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0 || !Array.isArray(sets[setIndex].cards)) return null;
  const set = sets[setIndex];
  if (!orderedSectionNames(set).includes(directory)) return null;

  const existingIds = new Set(set.cards.map((item) => item.id));
  const generatedId = uniqueCardId(existingIds, cardId());
  const blankCard = { ...blankCardInDirectory(directory), id: generatedId };
  sets[setIndex] = { ...set, cards: [...set.cards, blankCard] };
  saveCardSets(sets);
  return blankCard;
}

// 按标题依次确保一条目录链存在（最多三级），返回最末一级的标题。
// 已存在的目录按标题直接复用，不会重复建立；新目录按层级插到上一个目录的完整子树之后，
// 顶层目录追加到集合末尾。供"刷题笔记自动建档"这类程序化写入使用，不经过界面。
function ensureDirectoryPath(setId, titles = []) {
  const wanted = uniqueNames(titles).slice(0, 3);
  if (!wanted.length) return null;
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0) return null;
  const set = sets[setIndex];
  const sectionOrder = orderedSectionNames(set);
  const levels = { ...(set.sectionLevels || {}) };
  let parentTitle = "";
  wanted.forEach((title, depth) => {
    if (sectionOrder.includes(title)) { parentTitle = title; return; }
    const targetLevel = parentTitle ? Math.min(3, directoryLevel(levels, parentTitle) + 1) : 1;
    if (parentTitle && targetLevel !== depth + 1) return; // 父目录不够深，后面的层级不再补
    const insertIndex = parentTitle
      ? relativeDirectoryInsertIndex(sectionOrder, levels, parentTitle, "after")
      : sectionOrder.length;
    sectionOrder.splice(insertIndex < 0 ? sectionOrder.length : insertIndex, 0, title);
    levels[title] = targetLevel;
    parentTitle = title;
  });
  sets[setIndex] = {
    ...set,
    sectionOrder,
    sectionLevels: levels,
    cards: groupCardsBySectionOrder(Array.isArray(set.cards) ? set.cards : [], sectionOrder),
  };
  saveCardSets(sets);
  return parentTitle || null;
}

function insertChildDirectory(setId, parentTitle, title) {  const directory = String(title || "").trim();
  const parent = String(parentTitle || "").trim();
  if (!directory || !parent) return null;
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0) return null;
  const set = sets[setIndex];
  const sectionOrder = orderedSectionNames(set);
  if (!sectionOrder.includes(parent) || sectionOrder.includes(directory)) return null;

  // DEC-085：新建子目录要**紧贴所选目录下方**插入（成为它的第一个子目录），
  // 而不是跳过它已有的全部下级、插到子树末尾。
  const parentIndex = sectionOrder.indexOf(parent);
  if (parentIndex < 0) return null;
  const insertIndex = parentIndex + 1;
  const level = Math.min(3, directoryLevel(set.sectionLevels, parent) + 1);
  sectionOrder.splice(insertIndex, 0, directory);
  sets[setIndex] = {
    ...set,
    sectionOrder,
    sectionLevels: { ...(set.sectionLevels || {}), [directory]: level },
  };
  saveCardSets(sets);
  return { title: directory, level, parentTitle: parent };
}

function insertDirectoryRelativeToCard(setId, referenceId, placement, title) {
  const directory = String(title || "").trim();
  if (!directory || (placement !== "before" && placement !== "after")) return null;
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0 || !Array.isArray(sets[setIndex].cards)) return null;
  const referenceCard = sets[setIndex].cards.find((card) => card.id === referenceId);
  if (!referenceCard) return null;

  const set = sets[setIndex];
  const sectionOrder = orderedSectionNames(set);
  if (sectionOrder.includes(directory)) return null;
  const referenceTitle = sectionTitle(referenceCard);
  const insertIndex = relativeDirectoryInsertIndex(
    sectionOrder,
    set.sectionLevels,
    referenceTitle,
    placement,
  );
  if (insertIndex < 0) return null;

  sectionOrder.splice(insertIndex, 0, directory);
  const level = directoryLevel(set.sectionLevels, referenceTitle);
  sets[setIndex] = {
    ...set,
    sectionOrder,
    sectionLevels: { ...(set.sectionLevels || {}), [directory]: level },
  };
  saveCardSets(sets);
  return { title: directory, level, referenceTitle, placement };
}
function updateCardInSet(setId, id, patch) {
  if (!patch || typeof patch !== "object") return null;
  const sets = loadCardSets();
  const setIndex = sets.findIndex((set) => set.id === setId);
  if (setIndex < 0 || !Array.isArray(sets[setIndex].cards)) return null;
  const cardIndex = sets[setIndex].cards.findIndex((card) => card.id === id);
  if (cardIndex < 0) return null;
  const previousCard = sets[setIndex].cards[cardIndex];
  const updatedCard = { ...previousCard, ...patch, id: previousCard.id };
  const cards = [...sets[setIndex].cards];
  cards[cardIndex] = updatedCard;
  sets[setIndex] = { ...sets[setIndex], cards };
  saveCardSets(sets);
  return updatedCard;
}
function setId() { return `set-${Date.now()}-${Math.floor(Math.random() * 10000)}`; }
function createCardSet(title = "新建卡集", description = "", folder = "我的卡集", author = "我的整理") {
  const sets = loadCardSets();
  const resolvedAuthor = String(author || "").trim() || "我的整理";
  const set = { id: setId(), title, description, subtitle: "未命名版本", author: resolvedAuthor, subject: "未分类", progress: 0, due: 0, color: "", folder: folder || "我的卡集", cards: [], sectionOrder: [], sectionLevels: {} };
  sets.unshift(set);
  saveCardSets(sets);
  return set;
}

module.exports = {
  CARD_COLORS,
  CARD_COLOR_KEYS,
  cardColor,
  cardColorBackground,
  cardColorEdge,
  setCardColors,
  normalizeSetColor,
  setSetsColor,
  applyRainbowSetColors,
  loadCardSets,
  ensureCardSetMetadata,
  loadCardFolders,
  loadActiveCardFolder,
  saveActiveCardFolder,
  createCardFolder,
  renameCardFolder,
  deleteCardFolder,
  findSet,
  findCard,
  updateSet,
  cardId,
  addCardToSet,
  insertBlankCardInSet,
  appendBlankCardToDirectory,
  insertDirectoryRelativeToCard,
  insertChildDirectory,
  ensureDirectoryPath,
  updateCardInSet,
  moveCardInSet,
  moveCardsInSet,
  moveDirectoryToIndex,
  moveCardSet,
  adoptCardsIntoDirectory,
  createCardSet,
};
