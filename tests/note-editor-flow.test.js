const test = require("node:test");
const assert = require("node:assert/strict");

function createPage(modulePath) {
  let definition;
  global.Page = (value) => { definition = value; };
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  require(resolved);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

test("rich note editing saves a draft, recommends metadata and preserves formatted content", async () => {
  const store = new Map();
  let navigatedUrl = "";
  let backDelta = 0;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 375 }),
    getSystemInfoSync: () => ({ statusBarHeight: 24, windowWidth: 375 }),
    getMenuButtonBoundingClientRect: () => ({ top: 28, left: 278, width: 87, height: 32 }),
    navigateTo: ({ url }) => { navigatedUrl = url; },
    navigateBack: ({ delta } = {}) => { backDelta = delta || 1; },
    showToast() {},
    showModal() {},
  };

  // DEC-057：投稿/笔记目录只来自已确认教材目录，测试注入一份"已同步"的缓存目录。
  store.set("shukao_confirmed_catalog_ancient-literature-2-1", {
    version: 1,
    nodes: [
      { id: "sui-tang", order: 1, level: 1, title: "隋唐五代文学" },
      { id: "sui-tang-1", order: 2, level: 2, title: "初唐诗歌" },
      { id: "sui-tang-2", order: 3, level: 2, title: "盛唐诗歌" },
    ],
  });
  const editorPage = createPage("../apps/miniprogram/pages/note-editor/note-editor.js");
  editorPage.onLoad({});
  editorPage.setData({ title: "李白诗歌的艺术特色" });  editorPage.editorCtx = {
    getContents({ success }) {
      success({ html: "<h2>豪放飘逸</h2><p>善用夸张与想象。</p>", text: "豪放飘逸\n善用夸张与想象。" });
    },
  };
  editorPage.completeEditing();
  assert.match(navigatedUrl, /pages\/note-meta\/note-meta\?draftId=/);
  const draftId = decodeURIComponent(navigatedUrl.split("draftId=")[1]);
  assert.equal(store.get(`shukao_note_draft_${draftId}`).contentHtml.includes("<h2>"), true);

  const metaPage = createPage("../apps/miniprogram/pages/note-meta/note-meta.js");
  metaPage.onLoad({ draftId: encodeURIComponent(draftId) });
  assert.equal(metaPage.data.subjects[metaPage.data.subjectIndex].id, "ancient-literature");
  assert.equal(metaPage.data.recommendationLevel, "中");
  metaPage.setData({ originalConfirmed: true });
  metaPage.saveNote();

  const assets = store.get("shukao_user_assets");
  assert.equal(assets.length, 1);
  assert.equal(assets[0].type, "note");
  assert.equal(assets[0].contentHtml, "<h2>豪放飘逸</h2><p>善用夸张与想象。</p>");
  assert.equal(assets[0].editorVersion, 2);
  assert.equal(store.has(`shukao_note_draft_${draftId}`), false);
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(backDelta, 2);
  editorPage.onUnload();
  assert.equal(store.has(`shukao_note_draft_${draftId}`), false);

  delete global.Page;
  delete global.wx;
});

test("a referenced question supplies high-confidence note catalog metadata", () => {
  const store = new Map();
  const draftId = "question-reference-draft";
  store.set(`shukao_note_draft_${draftId}`, {
    id: draftId,
    title: "整理这道题",
    contentHtml: "<p>复习题目</p>",
    contentText: "复习题目",
    images: [],
    questionRefs: [{
      id: "question-1",
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      chapterId: "grammar",
      sectionId: "grammar-sentence",
      knowledgePoints: ["句法成分"],
      tags: ["易错点"],
    }],
  });
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    navigateBack() {},
    showToast() {},
  };
  const page = createPage("../apps/miniprogram/pages/note-meta/note-meta.js");
  page.onLoad({ draftId });
  assert.equal(page.data.recommendationLevel, "高");
  assert.equal(page.data.recommendationReason, "已继承引用题目的教材目录");
  assert.equal(page.data.tags.includes("句法成分"), true);

  delete global.Page;
  delete global.wx;
});

test("saved notes reopen in the rich editor from note and asset management", () => {
  const urls = [];
  global.wx = {
    getStorageSync: () => [],
    navigateTo: ({ url }) => urls.push(url),
  };

  const notesPage = createPage("../apps/miniprogram/pages/notes/notes.js");
  notesPage.editNote({ currentTarget: { dataset: { id: "note with space" } } });
  assert.equal(urls.pop(), "/pages/note-editor/note-editor?noteId=note%20with%20space");

  const assetsPage = createPage("../apps/miniprogram/pages/assets/assets.js");
  assetsPage.setData({ selectedAsset: { id: "note-2", type: "note" } });
  assetsPage.editSelectedNote();
  assert.equal(assetsPage.data.selectedAsset, null);
  assert.equal(urls.pop(), "/pages/note-editor/note-editor?noteId=note-2");

  delete global.Page;
  delete global.wx;
});

test("editing a note preserves its learning targets and publishing metadata", () => {
  const store = new Map();
  const draftId = "edit-note-draft";
  store.set("shukao_user_assets", [{
    id: "note-existing",
    type: "note",
    title: "已有笔记",
    learningTargets: ["recite", "review"],
    originality: "adapted",
    sourceReference: "《现代汉语》",
    visibility: "public",
    tags: ["语法"],
  }]);
  store.set(`shukao_note_draft_${draftId}`, {
    id: draftId,
    noteId: "note-existing",
    title: "已有笔记",
    contentHtml: "<p>修改后的正文</p>",
    contentText: "修改后的正文",
    images: [],
    questionRefs: [],
  });
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    navigateBack() {},
    showToast() {},
  };

  const page = createPage("../apps/miniprogram/pages/note-meta/note-meta.js");
  page.onLoad({ draftId });
  const selectedTargets = page.data.learningTargets.filter((item) => item.selected).map((item) => item.id);
  assert.deepEqual(selectedTargets, ["recite", "review"]);
  assert.equal(page.data.originality, "adapted");
  assert.equal(page.data.sourceReference, "《现代汉语》");
  assert.equal(page.data.visibility, "public");

  delete global.Page;
  delete global.wx;
});

test("note catalog recommendation searches across textbook volumes and knowledge points", () => {
  const { recommendNoteCatalog } = require("../apps/miniprogram/utils/note-catalog-recommender");
  const storage = {
    getStorageSync(key) {
      if (key === "shukao_confirmed_catalog_modern-chinese-7-1") return {
        nodes: [
          { id: "intro", level: 1, order: 1, title: "绪论" },
          { id: "overview", level: 2, order: 2, title: "第一节 现代汉语概说" },
        ],
      };
      if (key === "shukao_confirmed_catalog_modern-chinese-7-2") return {
        nodes: [
          { id: "grammar", level: 1, order: 1, title: "第四章 语法" },
          { id: "word-class", level: 2, order: 2, title: "第二节 词类" },
          { id: "auxiliary", level: 3, order: 3, title: "助词" },
          { id: "structural-auxiliary", level: 4, order: 4, title: "结构助词“的、地、得”" },
        ],
      };
      return "";
    },
  };

  const result = recommendNoteCatalog("如何辨别‘的’？‘的’分为结构助词、语气词。", {}, storage);
  assert.equal(result.subjectIndex, 0);
  assert.equal(result.bookIndex, 1);
  assert.equal(result.chapters[result.chapterIndex].id, "grammar");
  assert.equal(result.sections[result.sectionIndex].id, "word-class");
  assert.deepEqual(result.resolved, { subject: true, book: true, chapter: true, section: true });
  assert.equal(result.usefulMatches.includes("结构助词"), true);
});

test("note catalog recommendation leaves unsupported paths unresolved", () => {
  const { recommendNoteCatalog } = require("../apps/miniprogram/utils/note-catalog-recommender");
  // DEC-057：没有已确认目录（从未同步过）时不再用自造章节目录兜底，直接给不出建议。
  const result = recommendNoteCatalog("今天吃什么", {}, { getStorageSync: () => "" });
  assert.equal(result, null);
});

test("a matched lower catalog level always resolves its parent subject", () => {
  const { recommendNoteCatalog, normalizeCatalogResolved } = require("../apps/miniprogram/utils/note-catalog-recommender");
  // 低层级命中时父级必须一并解析（纯函数口径）。
  assert.deepEqual(normalizeCatalogResolved({ section: true }), { subject: true, book: true, chapter: true, section: true });
  const storage = {
    getStorageSync(key) {
      if (key === "shukao_confirmed_catalog_modern-chinese-7-2") {
        return {
          version: 1,
          nodes: [
            { id: "grammar", order: 1, level: 1, title: "第四章 语法" },
            { id: "syntax", order: 2, level: 2, title: "第四节 句法成分和句型" },
          ],
        };
      }
      return "";
    },
  };
  const result = recommendNoteCatalog("如何辨别时间宾语和时间补语", {}, storage);
  assert.equal(result.subjectIndex, 0);
  assert.equal(result.bookIndex, 1);
  assert.deepEqual(result.resolved, { subject: true, book: true, chapter: true, section: true });
});

test("an unfinished metadata step remains a visible and resumable note draft", () => {
  const store = new Map();
  let navigatedUrl = "";
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 375 }),
    getSystemInfoSync: () => ({ statusBarHeight: 24, windowWidth: 375 }),
    getMenuButtonBoundingClientRect: () => ({ top: 28, left: 278, width: 87, height: 32 }),
    navigateTo: ({ url }) => { navigatedUrl = url; },
    navigateBack() {},
    showToast() {},
    showModal() {},
  };

  const editorPage = createPage("../apps/miniprogram/pages/note-editor/note-editor.js");
  editorPage.onLoad({});
  editorPage.setData({ title: "结构助词辨析" });
  editorPage.editorCtx = {
    getContents({ success }) {
      success({ html: "<p>辨别的、地、得。</p>", text: "辨别的、地、得。" });
    },
  };
  editorPage.completeEditing();
  const draftId = decodeURIComponent(navigatedUrl.split("draftId=")[1]);
  const draftAsset = store.get("shukao_user_assets")[0];
  assert.equal(draftAsset.moderationStatus, "draft");
  assert.equal(draftAsset.draftStage, "metadata");

  const metaPage = createPage("../apps/miniprogram/pages/note-meta/note-meta.js");
  metaPage.onLoad({ draftId });
  metaPage.setData({ tags: ["助词辨析"], visibility: "private" });
  metaPage.onHide();

  const notesPage = createPage("../apps/miniprogram/pages/notes/notes.js");
  notesPage.onShow();
  assert.equal(notesPage.data.notes[0].draftLabel, "草稿");
  notesPage.editNote({ currentTarget: { dataset: { id: draftAsset.id } } });
  assert.equal(navigatedUrl, `/pages/note-meta/note-meta?draftId=${encodeURIComponent(draftId)}`);

  const resumedPage = createPage("../apps/miniprogram/pages/note-meta/note-meta.js");
  resumedPage.onLoad({ draftId });
  assert.deepEqual(resumedPage.data.tags, ["助词辨析"]);

  delete global.Page;
  delete global.wx;
});
