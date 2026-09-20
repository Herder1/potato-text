const { subjects } = require("../data/catalog");

// DEC-057：投稿/笔记只复用已确认教材目录，不再保留自造的兜底章节目录
// （自造章节名会让投稿挂到不存在的位置）。目录没同步过时整段为空，由页面提示先同步。
function cachedOutline(bookId, storage = wx) {
  const textbook = storage.getStorageSync(`shukao_confirmed_catalog_${bookId}`);
  if (!textbook || !Array.isArray(textbook.nodes)) return [];
  const nodes = textbook.nodes.slice().sort((a, b) => Number(a.order) - Number(b.order));
  const chapters = [];
  let chapter = null;
  let section = null;
  nodes.forEach((node) => {
    if (Number(node.level) === 1) {
      chapter = { id: String(node.id), title: node.title, knowledgePoints: node.knowledgePoints || [], sections: [] };
      chapters.push(chapter);
      section = null;
    } else if (Number(node.level) === 2 && chapter) {
      section = { id: String(node.id), title: node.title, knowledgePoints: node.knowledgePoints || [] };
      chapter.sections.push(section);
    } else if (chapter) {
      const point = String(node.title || "").trim();
      if (point) (section || chapter).knowledgePoints.push(point);
      (node.knowledgePoints || []).forEach((item) => (section || chapter).knowledgePoints.push(item));
    }
  });
  return chapters;
}

function createCatalogSelection(subjectIndex = 0, bookIndex = 0, storage = wx) {
  const subject = subjects[subjectIndex] || subjects[0];
  const books = subject.books || [];
  const book = books[bookIndex] || books[0];
  const chapters = book ? cachedOutline(book.id, storage) : [];
  return { subject, books, book, chapters, catalogReady: chapters.length > 0 };
}

module.exports = { cachedOutline, createCatalogSelection };
