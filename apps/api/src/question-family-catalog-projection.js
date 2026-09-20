const crypto = require("node:crypto");

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "")).filter(Boolean))];
}

function familyTextbookAnchorNodeIds(family = {}) {
  const explicit = uniqueStrings(family.textbookAnchorNodeIds);
  return explicit.length ? explicit : uniqueStrings([family.knowledgeNodeId]);
}

function memberIsFormallyConfirmed(family, member) {
  if (!family || family.status !== "confirmed" || !member) return false;
  return !member.reviewStatus || member.reviewStatus === "confirmed";
}

function familyHasConfirmedPrototype(family) {
  return Boolean(family && family.status === "confirmed"
    && (Array.isArray(family.members) ? family.members : [])
      .some((member) => member.role === "prototype" && memberIsFormallyConfirmed(family, member)));
}

function resolveCatalogAnchorNodeId(anchorNodeId, nodeById, catalogNodeIds, options = {}) {
  if (!anchorNodeId) return "";
  if (options.catalogValidationRequired !== true) return anchorNodeId;
  if (!catalogNodeIds.size) return "";
  if (catalogNodeIds.has(anchorNodeId)) return anchorNodeId;
  const visited = new Set();
  let node = nodeById.get(anchorNodeId);
  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    if (catalogNodeIds.has(node.id)) return node.id;
    node = node.parentId ? nodeById.get(String(node.parentId)) : null;
  }
  return "";
}

function projectionRevision(families = []) {
  const facts = (Array.isArray(families) ? families : [])
    .filter(familyHasConfirmedPrototype)
    .map((family) => ({
      id: String(family.id || ""),
      anchorNodeIds: familyTextbookAnchorNodeIds(family).sort(),
      primaryQuestionIds: uniqueStrings((family.members || [])
        .filter((member) => memberIsFormallyConfirmed(family, member) && member.isPrimary === true)
        .map((member) => member.questionId)).sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return crypto.createHash("sha1").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}

function buildQuestionFamilyCatalogProjection({
  families = [],
  knowledgeNodes = [],
  catalogNodeIds,
} = {}) {
  const nodesById = new Map((Array.isArray(knowledgeNodes) ? knowledgeNodes : [])
    .filter((node) => node && node.id)
    .map((node) => [String(node.id), node]));
  const publishedCatalogNodeIds = new Set(uniqueStrings(catalogNodeIds));
  const catalogValidationRequired = catalogNodeIds instanceof Set || Array.isArray(catalogNodeIds);
  const drafts = new Map();

  (Array.isArray(families) ? families : [])
    .filter(familyHasConfirmedPrototype)
    .forEach((family) => {
      const validAnchors = familyTextbookAnchorNodeIds(family).map((sourceAnchorNodeId) => ({
        sourceAnchorNodeId,
        resolvedCatalogAnchorNodeId: resolveCatalogAnchorNodeId(
          sourceAnchorNodeId,
          nodesById,
          publishedCatalogNodeIds,
          { catalogValidationRequired },
        ),
      })).filter((anchor) => anchor.resolvedCatalogAnchorNodeId);
      const anchorNodeIds = uniqueStrings(validAnchors.map((anchor) => anchor.resolvedCatalogAnchorNodeId));
      const sourceAnchorNodeIds = uniqueStrings(validAnchors.map((anchor) => (
        nodesById.has(anchor.sourceAnchorNodeId) ? anchor.sourceAnchorNodeId : anchor.resolvedCatalogAnchorNodeId
      )));
      if (!anchorNodeIds.length) return;
      (Array.isArray(family.members) ? family.members : [])
        .filter((member) => memberIsFormallyConfirmed(family, member) && member.isPrimary === true && member.questionId)
        .forEach((member) => {
          const questionId = String(member.questionId);
          const current = drafts.get(questionId) || {
            familyIds: new Set(),
            anchorNodeIds: new Set(),
            sourceAnchorNodeIds: new Set(),
          };
          current.familyIds.add(String(family.id || ""));
          anchorNodeIds.forEach((anchorNodeId) => current.anchorNodeIds.add(anchorNodeId));
          sourceAnchorNodeIds.forEach((anchorNodeId) => current.sourceAnchorNodeIds.add(anchorNodeId));
          drafts.set(questionId, current);
        });
    });

  return {
    revision: projectionRevision(families),
    byQuestionId: Object.fromEntries([...drafts.entries()].map(([questionId, draft]) => [questionId, {
      source: "confirmed_topic_family",
      topicFamilyIds: [...draft.familyIds].filter(Boolean).sort(),
      anchorNodeIds: [...draft.anchorNodeIds].sort(),
      sourceAnchorNodeIds: [...draft.sourceAnchorNodeIds].sort(),
    }])),
  };
}

function decorateQuestionsWithFamilyCatalogProjection(questions = [], projection = {}) {
  const byQuestionId = projection && projection.byQuestionId && typeof projection.byQuestionId === "object"
    ? projection.byQuestionId
    : {};
  return (Array.isArray(questions) ? questions : []).map((question) => {
    const item = byQuestionId[question.id];
    return {
      ...question,
      catalogProjection: item ? {
        source: item.source,
        topicFamilyIds: item.topicFamilyIds || [],
        anchorNodeIds: item.anchorNodeIds || [],
      } : {
        source: "unassigned",
        topicFamilyIds: [],
        anchorNodeIds: [],
      },
    };
  });
}

function buildQuestionFamilyCatalogTreeSummary({
  projection = {},
  knowledgeNodes = [],
  activeQuestionIds = [],
  anchorField = "anchorNodeIds",
} = {}) {
  const nodeById = new Map((Array.isArray(knowledgeNodes) ? knowledgeNodes : [])
    .filter((node) => node && node.id)
    .map((node) => [String(node.id), node]));
  const hasActiveFilter = activeQuestionIds instanceof Set || Array.isArray(activeQuestionIds);
  const activeIds = activeQuestionIds instanceof Set
    ? activeQuestionIds
    : new Set(uniqueStrings(activeQuestionIds));
  const questionIdsByNodeId = new Map();
  const projectedQuestionIds = new Set();
  const byQuestionId = projection && projection.byQuestionId && typeof projection.byQuestionId === "object"
    ? projection.byQuestionId
    : {};

  Object.entries(byQuestionId).forEach(([questionId, item]) => {
    if (hasActiveFilter && !activeIds.has(questionId)) return;
    projectedQuestionIds.add(questionId);
    uniqueStrings(item?.[anchorField]).forEach((anchorNodeId) => {
      const visited = new Set();
      let node = nodeById.get(anchorNodeId);
      while (node && !visited.has(node.id)) {
        visited.add(node.id);
        if (!questionIdsByNodeId.has(node.id)) questionIdsByNodeId.set(node.id, new Set());
        questionIdsByNodeId.get(node.id).add(questionId);
        node = node.parentId ? nodeById.get(String(node.parentId)) : null;
      }
    });
  });

  return {
    questionCount: projectedQuestionIds.size,
    nodeQuestionCounts: Object.fromEntries([...questionIdsByNodeId.entries()]
      .map(([nodeId, questionIds]) => [nodeId, questionIds.size])),
  };
}

module.exports = {
  buildQuestionFamilyCatalogProjection,
  buildQuestionFamilyCatalogTreeSummary,
  decorateQuestionsWithFamilyCatalogProjection,
  familyHasConfirmedPrototype,
  familyTextbookAnchorNodeIds,
  projectionRevision,
  resolveCatalogAnchorNodeId,
};
