function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，。！？；：、“”‘’（）()【】\[\]《》<>·…—-]/g, "");
}

function familyCoreNodeId(family = {}) {
  return String(family.coreKnowledgeNodeId || family.knowledgeNodeId || "");
}

function familyRequiredNodeIds(family = {}) {
  return uniqueStrings(family.requiredKnowledgeNodeIds || []);
}

function familyAnchorNodeIds(family = {}) {
  return uniqueStrings((family.textbookAnchorNodeIds || []).length
    ? family.textbookAnchorNodeIds
    : [family.knowledgeNodeId]);
}

function textOverlap(left, right) {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function relationRecord(type, family, reason, score) {
  return {
    type,
    familyId: family.id,
    familyName: family.name,
    reason,
    score,
    source: "computed",
  };
}

function confirmedMemberQuestionIds(family = {}) {
  if (family.status !== "confirmed") return new Set();
  return new Set((family.members || [])
    .filter((member) => !member.reviewStatus || member.reviewStatus === "confirmed")
    .map((member) => String(member.questionId || ""))
    .filter(Boolean));
}

function computeFamilyRelations(target, families = []) {
  if (!target || !target.id) return [];
  const targetCore = familyCoreNodeId(target);
  const targetRequired = new Set(familyRequiredNodeIds(target));
  const targetAnchors = new Set(familyAnchorNodeIds(target));
  const targetMembers = confirmedMemberQuestionIds(target);
  const results = [];

  (Array.isArray(families) ? families : []).forEach((candidate) => {
    if (!candidate || candidate.id === target.id || candidate.bookId !== target.bookId || candidate.status === "rejected") return;
    const candidateCore = familyCoreNodeId(candidate);
    const candidateRequired = new Set(familyRequiredNodeIds(candidate));
    const candidateAnchors = familyAnchorNodeIds(candidate);
    const sharedRequired = [...targetRequired].filter((nodeId) => candidateRequired.has(nodeId));
    const sharedQuestionCount = [...confirmedMemberQuestionIds(candidate)]
      .filter((questionId) => targetMembers.has(questionId)).length;

    if (candidateCore && candidateCore !== targetCore && targetRequired.has(candidateCore)) {
      results.push(relationRecord("prerequisite", candidate, "该题族的核心知识属于当前题族的作答必需知识。", 100));
    }
    if (targetCore && candidateCore !== targetCore && candidateRequired.has(targetCore)) {
      results.push(relationRecord("dependent", candidate, "当前核心知识是该题族作答时调用的必需知识。", 95));
    }
    if (targetCore && candidateCore === targetCore) {
      const sameAction = normalizedText(target.assessmentAction || target.focusKey)
        === normalizedText(candidate.assessmentAction || candidate.focusKey);
      const sameBoundary = normalizedText(target.inclusionBoundary) === normalizedText(candidate.inclusionBoundary)
        && normalizedText(target.exclusionBoundary) === normalizedText(candidate.exclusionBoundary);
      results.push(relationRecord(
        sameAction && sameBoundary ? "possible_duplicate" : "similar",
        candidate,
        sameAction && sameBoundary
          ? "核心知识、考查动作和辨析边界一致，建议检查是否重复题族。"
          : "核心知识相同，但考查动作或辨析边界不同。",
        sameAction && sameBoundary ? 98 : 85,
      ));
    }
    const boundaryRelated = textOverlap(target.exclusionBoundary, candidate.name)
      || textOverlap(candidate.exclusionBoundary, target.name)
      || textOverlap(target.exclusionBoundary, candidate.inclusionBoundary)
      || textOverlap(candidate.exclusionBoundary, target.inclusionBoundary);
    if (boundaryRelated) {
      results.push(relationRecord("confusable", candidate, "双方纳入或排除边界存在直接交叉。", 90));
    }
    if (sharedQuestionCount) {
      results.push(relationRecord("shared_case", candidate, `有 ${sharedQuestionCount} 道已归类题目同时调用两个题族。`, 80 + Math.min(10, sharedQuestionCount)));
    }
    const crossesAnchor = candidateAnchors.some((nodeId) => nodeId && !targetAnchors.has(nodeId));
    if (crossesAnchor && sharedRequired.length) {
      results.push(relationRecord("cross_chapter", candidate, "教材锚点不同，但作答必需知识存在交集。", 65 + Math.min(10, sharedRequired.length * 2)));
    }
  });

  const byKey = new Map();
  results.forEach((relation) => {
    const key = `${relation.type}\u0000${relation.familyId}`;
    const current = byKey.get(key);
    if (!current || relation.score > current.score) byKey.set(key, relation);
  });
  return [...byKey.values()]
    .sort((left, right) => right.score - left.score || left.familyName.localeCompare(right.familyName, "zh-CN"))
    .slice(0, 30);
}

function decorateFamiliesWithDynamicRelations(families = []) {
  const items = Array.isArray(families) ? families : [];
  return items.map((family) => ({
    ...family,
    dynamicRelations: computeFamilyRelations(family, items),
  }));
}

module.exports = {
  computeFamilyRelations,
  decorateFamiliesWithDynamicRelations,
  familyAnchorNodeIds,
  familyCoreNodeId,
  familyRequiredNodeIds,
};
