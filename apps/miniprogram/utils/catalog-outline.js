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

function createProjectedCatalogChapters(outline, questions = [], activeQuestionId = "", options = {}) {
  const queue = [];
  const seenQuestionIds = new Set();
  (Array.isArray(questions) ? questions : []).forEach((question) => {
    const questionId = String(question && question.id || "");
    if (!questionId || seenQuestionIds.has(questionId)) return;
    seenQuestionIds.add(questionId);
    queue.push(question);
  });
  const keepEmptyChapters = options.keepEmptyChapters === true;
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

  const ungroupedQuestions = queue.filter((question) => !assignedQuestionIds.has(String(question.id)));
  const ungroupedCountBySubjectId = new Map();
  if (keepEmptyChapters) {
    ungroupedQuestions.forEach((question) => {
      const subjectId = String(question && question.subjectId || "");
      if (!subjectId) return;
      ungroupedCountBySubjectId.set(subjectId, (ungroupedCountBySubjectId.get(subjectId) || 0) + 1);
    });
  }

  // 用户端只显示"有题"的目录：后台知识树照旧显示全部节点，用户端按目录投影收敛。
  // 显示条件与徽标数字同源——该节点及其全部下级至少有一道已归组题目。客户端的小节是
  // 平铺渲染 + 按 level 缩进，所以必须整支隐藏，不能只隐藏叶子（留子不留父会错位）。
  //
  // 综合训练例外（options.keepEmptyChapters）：一级＝科目，科目是题池的骨架，不能因为"这科
  // 还没形成目录投影"就整行消失——否则用户看到的是"目录里只有两科"，而不是"另外三科还没归组"。
  // 此时科目行照常显示、题数照实显示 0 题，并单独给一个 pendingCount（本科目题池里还没形成
  // 正式投影的题数，即"待归组"），与正式投影题数分开命名、分开计数（产品手册 §6）。二级往下
  // 仍然只显示有题的分支。
  const subjectIdOfChapter = (chapter) => {
    const id = String(chapter && chapter.id || "");
    return id.startsWith("subject:") ? id.slice("subject:".length) : "";
  };
  const visibleChapters = keepEmptyChapters
    ? projected.map((chapter) => {
      const subjectId = subjectIdOfChapter(chapter);
      return {
        ...chapter,
        ...(subjectId ? { pendingCount: ungroupedCountBySubjectId.get(subjectId) || 0 } : {}),
        sections: chapter.sections.filter((section) => Number(section.questionCount) > 0),
      };
    })
    : projected
      .filter((chapter) => Number(chapter.questionCount) > 0)
      .map((chapter) => ({
        ...chapter,
        sections: chapter.sections.filter((section) => Number(section.questionCount) > 0),
      }));

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

// 综合训练是跨册题池：目录要从科目看起，同一科目的各册顶层目录（章 / 编 / 单元）按册顺序
// 拼成同一条二级列表，再往下接各自的节与小点。这里只重排层级、不复制或改写题目锚点，
// 每个节点仍保留自己册里的目录节点 id，所以题目投影、题数与高亮定位都和单册一致。
const SUBJECT_CATALOG_MAX_LEVEL = 5;

// 把多本教材的已确认目录按科目分组：科目顺序与册顺序优先取本地目录常数（data/catalog.js），
// 目录里出现常数之外的科目/册时按 id 兜底排序，不丢内容。
function subjectGroupsFromCatalogs(textbooks, subjectCatalog = []) {
  const metaById = new Map();
  (Array.isArray(subjectCatalog) ? subjectCatalog : []).forEach((subject, index) => {
    const subjectId = String(subject && subject.id || "");
    if (!subjectId) return;
    metaById.set(subjectId, {
      name: String(subject.name || subjectId),
      order: index,
      bookOrder: new Map((Array.isArray(subject.books) ? subject.books : [])
        .map((book, bookIndex) => [String(book && book.id || ""), bookIndex])),
    });
  });
  const groups = new Map();
  (Array.isArray(textbooks) ? textbooks : []).forEach((textbook) => {
    if (!textbook) return;
    const subjectId = String(textbook.subjectId || "");
    const bookId = String(textbook.bookId || textbook.id || "");
    if (!subjectId || !bookId) return;
    if (!groups.has(subjectId)) {
      const meta = metaById.get(subjectId);
      groups.set(subjectId, {
        subjectId,
        subjectName: meta ? meta.name : subjectId,
        order: meta ? meta.order : Number.MAX_SAFE_INTEGER,
        bookOrder: meta ? meta.bookOrder : new Map(),
        books: [],
      });
    }
    const group = groups.get(subjectId);
    if (group.books.some((book) => book.bookId === bookId)) return;
    group.books.push({
      bookId,
      nodes: Array.isArray(textbook.nodes) ? textbook.nodes : [],
      version: Number(textbook.version) || 0,
    });
  });
  return [...groups.values()]
    .sort((left, right) => left.order - right.order || left.subjectId.localeCompare(right.subjectId))
    .map((group) => ({
      subjectId: group.subjectId,
      subjectName: group.subjectName,
      books: group.books.slice().sort((left, right) => {
        const leftOrder = group.bookOrder.has(left.bookId) ? group.bookOrder.get(left.bookId) : Number.MAX_SAFE_INTEGER;
        const rightOrder = group.bookOrder.has(right.bookId) ? group.bookOrder.get(right.bookId) : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.bookId.localeCompare(right.bookId);
      }),
    }));
}

// 输出与 createProjectedCatalogChapters 的入参同构：科目＝一级（章位），各册顶层目录＝二级，
// 往下依次 +1 级（最深封顶 5）。同名目录不做去重——它们是不同册里各自真实的章，去重会把
// 两册的题目错误合并到一行。
function buildSubjectCatalogOutline(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const subjectId = String(group && group.subjectId || "");
    if (!subjectId) return null;
    const subjectNodeId = `subject:${subjectId}`;
    const sections = [];
    (Array.isArray(group.books) ? group.books : []).forEach((book) => {
      buildCatalogOutline(book && book.nodes).forEach((chapter) => {
        sections.push({
          id: chapter.id,
          catalogNodeId: chapter.catalogNodeId || chapter.id,
          parentId: subjectNodeId,
          title: chapter.title,
          level: 2,
          startPage: chapter.startPage,
          endPage: chapter.endPage,
        });
        (chapter.sections || []).forEach((section) => {
          sections.push({
            ...section,
            level: Math.min(SUBJECT_CATALOG_MAX_LEVEL, Math.max(3, (Number(section.level) || 2) + 1)),
          });
        });
      });
    });
    return {
      id: subjectNodeId,
      catalogNodeId: subjectNodeId,
      parentId: "",
      title: String(group.subjectName || subjectId),
      level: 1,
      isSubject: true,
      sections,
    };
  }).filter(Boolean);
}

module.exports = {
  buildCatalogOutline,
  buildSubjectCatalogOutline,
  createProjectedCatalogChapters,
  projectionAnchorNodeIds,
  subjectGroupsFromCatalogs,
};
