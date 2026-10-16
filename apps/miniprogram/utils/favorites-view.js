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
      // 点收藏要能跳到对应的详情页，所以原始 type 也带出来（卡片集/题包进卡片集页，其余进知识库）。
      type: asset.type || "",
      contributor: asset.contributor || "薯考同学",
      favoriteCount: Math.max(0, Number(asset.favoriteCount) || 0),
      available: asset.moderationStatus === "published",
      statusLabel: asset.moderationStatus === "published" ? "" : "已下架",
      // 新版收藏页的卡片底部要写「知识卡 · 教育学 · 教育学基础」这一行出处（DEC-096），
      // 目录名在内容里本来就是现成的，照原样带出来，不在客户端拼猜。
      subjectName: asset.subjectName || "",
      chapterTitle: asset.chapterTitle || "",
      sectionTitle: asset.sectionTitle || "",
      tags: Array.isArray(asset.tags) ? asset.tags : [],
    }));
}

module.exports = {
  buildCommunityFavoriteItems,
  buildFavoriteQuestionItems,
  communityTypeLabels,
  isBookmarked,
};
