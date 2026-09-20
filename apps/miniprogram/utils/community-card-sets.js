// 社区卡集 → 我的卡集的导入支持（DEC-079）。
// 来源与「题包从知识库社区收藏导入」一致：知识库 / 社区精选里的卡片集资产。
const { communityAssets } = require("../data/community-assets");

const CARD_SET_ASSET_TYPES = ["card_pack", "card_set"];

function isCommunityCardSet(asset) {
  return CARD_SET_ASSET_TYPES.includes(String(asset && asset.type || "").trim());
}

// 远端结果优先、种子兜底，按 id 去重，顺序保持“先远端后种子”。
function communityCardSetOptions(remoteAssets) {
  const merged = new Map();
  const sources = [...(Array.isArray(remoteAssets) ? remoteAssets : []), ...communityAssets];
  sources.forEach((asset) => {
    if (!isCommunityCardSet(asset)) return;
    const id = String(asset && asset.id || "").trim();
    if (!id || merged.has(id)) return;
    merged.set(id, asset);
  });
  return [...merged.values()];
}

function draftCardFromItem(item, asset, index) {
  const source = item || {};
  const question = String(source.question || source.stem || source.title || "").trim();
  const answer = String(source.answer || source.referenceAnswer || source.content || "").trim();
  return {
    type: source.type === "note" ? "note" : "qa",
    section: String(source.section || source.catalogPath || (asset && asset.catalogPath) || "").trim(),
    question: question || String(asset && asset.title || "").trim() || "社区卡片",
    answer,
    mnemonic: String(source.mnemonic || "").trim(),
  };
}

// 把社区资产整理成“可以直接落进卡集”的草稿：标题/作者/学科 + 卡片数组（可能为空）。
function cardSetDraftFromAsset(asset) {
  const source = asset || {};
  const path = String(source.catalogPath || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const rawCards = Array.isArray(source.cards)
    ? source.cards
    : (Array.isArray(source.questions) ? source.questions : []);
  return {
    sourceAssetId: String(source.id || "").trim(),
    title: String(source.title || source.name || "社区卡集").trim() || "社区卡集",
    description: String(source.excerpt || source.description || "").trim(),
    subject: path[0] || "未分类",
    author: String(source.contributor || source.author || "社区贡献者").trim() || "社区贡献者",
    tags: Array.isArray(source.tags) ? source.tags.map((tag) => String(tag)) : [],
    cards: rawCards.map((item, index) => draftCardFromItem(item, source, index)),
  };
}

module.exports = { CARD_SET_ASSET_TYPES, isCommunityCardSet, communityCardSetOptions, cardSetDraftFromAsset };
