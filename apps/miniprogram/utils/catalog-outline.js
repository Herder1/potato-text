// 把已确认目录摊成"章 + 扁平的节列表"。父子关系优先用服务端给的 parentId（它按知识树现算，
// 人工在后台拖对了用户端就跟着对）；旧缓存没有这个字段、或节点不在知识树里时，退回按 level
// 推导：前面最近的、层级更浅的那个节点就是父。
function buildCatalogOutline(nodes) {
  const sorted = (Array.isArray(nodes) ? nodes : [])
    .slice()
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  const idSet = new Set(sorted.map((node) => String(node && node.id || "")).filter(Boolean));
  const explicitParentId = new Map();
  sorted.forEach((node) => {
    const id = String(node && node.id || "");
    if (!id || node.parentId == null) return;
    const parentId = String(node.parentId || "");
    explicitParentId.set(id, parentId && idSet.has(parentId) ? parentId : "");
  });

  const outline = [];
  const byId = new Map();
  let currentChapter = null;
  let sectionStack = [];
  sorted.forEach((node) => {
    const title = String(node && node.title || "").trim();
    const id = String(node && node.id || "");
    if (!title || !id) return;
    const declaredLevel = Math.min(5, Math.max(1, Number(node && node.level) || 1));
    const hasExplicitParent = explicitParentId.has(id);
    // 有显式 parentId 时以它为准（空串＝顶层章）；否则按 level 判断是不是章。
    const isChapter = hasExplicitParent ? !explicitParentId.get(id) : declaredLevel === 1;
    if (isChapter) {
      currentChapter = {
        id,
        catalogNodeId: id,
        parentId: "",
        title,
        level: 1,
        startPage: Number(node.startPage) || 1,
        endPage: Number(node.endPage) || Number(node.startPage) || 1,
        sections: [],
      };
      outline.push(currentChapter);
      byId.set(id, currentChapter);
      sectionStack = [];
      return;
    }
    let parent = null;
    if (hasExplicitParent) {
      parent = byId.get(explicitParentId.get(id)) || null;
    } else {
      while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= declaredLevel) sectionStack.pop();
      parent = sectionStack.length ? sectionStack[sectionStack.length - 1] : null;
    }
    // 解析不出父就挂到当前章；连章都没有说明这是一条孤儿目录，按老行为丢弃。
    if (!parent) parent = currentChapter;
    if (!parent) return;
    const chapter = parent.level === 1 ? parent : currentChapter;
    if (!chapter) return;
    // 层级按解析出来的父子关系重算，保证缩进连续（目录里的 level 本身可能标错）。
    const section = {
      id,
      catalogNodeId: id,
      parentId: parent.id,
      title,
      level: Math.min(5, Math.max(2, Number(parent.level || 1) + 1)),
      startPage: Number(node.startPage) || 1,
      endPage: Number(node.endPage) || Number(node.startPage) || 1,
    };
    chapter.sections.push(section);
    byId.set(id, section);
    sectionStack.push(section);
  });
  return outline;
}

function projectionAnchorNodeIds(question = {}) {
  const projection = question.catalogProjection && typeof question.catalogProjection === "object"
    ? question.catalogProjection
    : {};
  const values = Array.isArray(projection.anchorNodeIds)
    ? projection.anchorNodeIds
    : (Array.isArray(question.catalogAnchorNodeIds) ? question.catalogAnchorNodeIds : []);
  return [...new Set(values.map(String).filter(Boolean))];
}

function orderedQuestionIds(questionIds, orderByQuestionId) {
  return [...questionIds].sort((left, right) => (orderByQuestionId.get(left) ?? Number.MAX_SAFE_INTEGER)
    - (orderByQuestionId.get(right) ?? Number.MAX_SAFE_INTEGER)
    || left.localeCompare(right));
}

function createProjectedCatalogChapters(outline, questions = [], activeQuestionId = "") {
  const queue = [];
  const seenQuestionIds = new Set();
  (Array.isArray(questions) ? questions : []).forEach((question) => {
    const questionId = String(question && question.id || "");
    if (!questionId || seenQuestionIds.has(questionId)) return;
    seenQuestionIds.add(questionId);
    queue.push(question);
  });
  const orderByQuestionId = new Map(queue.map((question, index) => [String(question.id), index]));
  const chapters = (Array.isArray(outline) ? outline : []).map((chapter) => ({
    ...chapter,
    sections: (Array.isArray(chapter.sections) ? chapter.sections : []).map((section) => ({ ...section })),
  }));
  const aliasToNodeId = new Map();
  const childrenByNodeId = new Map();
  const directQuestionIdsByNodeId = new Map();

  const addAliases = (node) => {
    const nodeId = String(node.id || node.catalogNodeId || "");
    if (!nodeId) return;
    [node.id, node.catalogNodeId]
      .map((value) => String(value || ""))
      .filter(Boolean)
      .forEach((alias) => aliasToNodeId.set(alias, nodeId));
  };
  chapters.forEach((chapter) => {
    addAliases(chapter);
    chapter.sections.forEach(addAliases);
  });
  chapters.forEach((chapter) => {
    const chapterId = String(chapter.id);
    chapter.sections.forEach((section) => {
      const sectionId = aliasToNodeId.get(String(section.id || ""));
      const parentId = aliasToNodeId.get(String(section.parentId || "")) || chapterId;
      const children = childrenByNodeId.get(parentId) || [];
      if (sectionId) children.push(sectionId);
      childrenByNodeId.set(parentId, children);
    });
  });

  const assignedQuestionIds = new Set();
  queue.forEach((question) => {
    const questionId = String(question.id);
    let assigned = false;
    projectionAnchorNodeIds(question).forEach((anchorNodeId) => {
      const nodeId = aliasToNodeId.get(anchorNodeId);
      if (!nodeId) return;
      const ids = directQuestionIdsByNodeId.get(nodeId) || new Set();
      ids.add(questionId);
      directQuestionIdsByNodeId.set(nodeId, ids);
      assigned = true;
    });
    if (assigned) assignedQuestionIds.add(questionId);
  });

  const resolvedQuestionIdsByNodeId = new Map();
  const resolving = new Set();
  const resolveQuestionIds = (nodeId) => {
    if (resolvedQuestionIdsByNodeId.has(nodeId)) return resolvedQuestionIdsByNodeId.get(nodeId);
    if (resolving.has(nodeId)) return new Set(directQuestionIdsByNodeId.get(nodeId) || []);
    resolving.add(nodeId);
    const ids = new Set(directQuestionIdsByNodeId.get(nodeId) || []);
    (childrenByNodeId.get(nodeId) || []).forEach((childId) => {
      resolveQuestionIds(childId).forEach((questionId) => ids.add(questionId));
    });
    resolving.delete(nodeId);
    resolvedQuestionIdsByNodeId.set(nodeId, ids);
    return ids;
  };

  const projected = chapters.map((chapter) => {
    const chapterId = String(chapter.id);
    const chapterQuestionIds = orderedQuestionIds(resolveQuestionIds(chapterId), orderByQuestionId);
    return {
      ...chapter,
      expanded: chapterQuestionIds.includes(String(activeQuestionId || "")) || chapter.expanded === true,
      questionId: chapterQuestionIds[0] || "",
      questionIds: chapterQuestionIds,
      questionCount: chapterQuestionIds.length,
      sections: chapter.sections.map((section) => {
        const sectionId = aliasToNodeId.get(String(section.id || ""));
        const sectionQuestionIds = orderedQuestionIds(resolveQuestionIds(sectionId), orderByQuestionId);
        return {
          ...section,
          level: Number(section.level) || 2,
          parentId: section.parentId || chapter.id,
          questionId: sectionQuestionIds[0] || "",
          questionIds: sectionQuestionIds,
          questionCount: sectionQuestionIds.length,
        };
      }),
    };
  });

  // 用户端只显示"有题"的目录：后台知识树照旧显示全部节点，用户端按目录投影收敛。
  // 显示条件与徽标数字同源——该节点及其全部下级至少有一道已归组题目。客户端的小节是
  // 平铺渲染 + 按 level 缩进，所以必须整支隐藏，不能只隐藏叶子（留子不留父会错位）。
  const visibleChapters = projected
    .filter((chapter) => Number(chapter.questionCount) > 0)
    .map((chapter) => ({
      ...chapter,
      sections: chapter.sections.filter((section) => Number(section.questionCount) > 0),
    }));

  const ungroupedQuestions = queue.filter((question) => !assignedQuestionIds.has(String(question.id)));
  // 兜底：如果连一个"有题的目录章"都没有（例如这本书的题全部还没归入题族、或题库刚同步完
  // 还没有题），不能只留一个"待归组"或把目录清空——用户会失去课本结构的导航，
  // 而空目录还会显示成"目录暂未同步"，等于误报同步失败。此时退回完整目录。
  const result = visibleChapters.length ? visibleChapters : projected;
  if (ungroupedQuestions.length) {
    const questionIds = ungroupedQuestions.map((question) => String(question.id));
    result.push({
      id: "catalog-unassigned",
      title: "待归组",
      expanded: questionIds.includes(String(activeQuestionId || "")),
      questionId: questionIds[0] || "",
      questionIds,
      questionCount: questionIds.length,
      sections: [],
    });
  }
  return result;
}

module.exports = {
  buildCatalogOutline,
  createProjectedCatalogChapters,
  projectionAnchorNodeIds,
};
