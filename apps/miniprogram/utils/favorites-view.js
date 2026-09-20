// 「我的收藏」视图数据。
// 收藏在这套设计里有两个来源，刻意分开两段、互不推导：
//   1) 社区公开内容收藏 = 引用关系（服务端按“人 × 内容”记录，见 community-interaction-store）；
//   2) 题目收藏 = 设备本地书签（shukao_bookmarks / 旧键 shukao_bookmark_<id>，与复习页同一套存储）。
const communityTypeLabels = {
  question: "题目分享",
  note: "共享笔记",
  card_pack: "卡片集",
};

function isBookmarked(bookmarkStates, questionId) {
  const record = bookmarkStates && bookmarkStates[questionId];
  return Boolean(record && record.value === true);
}

function buildFavoriteQuestionItems({ officialQuestions = [], bookmarkStates = {}, legacyLookup } = {}) {
  const questions = Array.isArray(officialQuestions) ? officialQuestions : [];
  return questions
    .filter((question) => {
      if (!question || !question.id) return false;
      if (isBookmarked(bookmarkStates, question.id)) return true;
      return typeof legacyLookup === "function" && legacyLookup(question.id) === true;
    })
    .map((question) => ({
      id: question.id,
      stem: question.stem || question.title || "未命名题目",
      breadcrumb: question.breadcrumb || [question.subject, question.chapter, question.knowledgePoint].filter(Boolean).join(" · "),
      knowledgePoint: question.knowledgePoint || "",
    }));
}

function buildCommunityFavoriteItems(assets = []) {
  return (Array.isArray(assets) ? assets : [])
    .filter(Boolean)
    .map((asset) => ({
      id: asset.id,
      title: asset.title || "未命名内容",
      excerpt: asset.excerpt || "",
      typeLabel: communityTypeLabels[asset.type] || "社区内容",
      contributor: asset.contributor || "薯考同学",
      favoriteCount: Math.max(0, Number(asset.favoriteCount) || 0),
      available: asset.moderationStatus === "published",
      statusLabel: asset.moderationStatus === "published" ? "" : "已下架",
    }));
}

module.exports = {
  buildCommunityFavoriteItems,
  buildFavoriteQuestionItems,
  communityTypeLabels,
  isBookmarked,
};
