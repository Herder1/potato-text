const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addPackNode,
  addQuestionToPack,
  attachQuestionToCard,
  copyCommunityPack,
  createPrivatePackCategory,
  createPrivatePack,
  deletePrivatePackCategory,
  getPrivatePack,
  insertPackDirectory,
  loadPrivatePacks,
  loadPrivatePackCategories,
  movePackNodeToPack,
  normalizeQuestionForPractice,
  packStats,
  renamePrivatePackCategory,
  savePrivatePack,
} = require("../apps/miniprogram/utils/private-pack-store");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getStorageSync: (key) => values.get(key) || "",
    setStorageSync: (key, value) => values.set(key, value),
  };
}

test("private packs migrate legacy data and keep question membership unique", () => {
  const storage = createStorage({ shukao_packs: [{ id: "legacy-pack", name: "旧题包", count: 2, visibility: "私人" }] });
  assert.equal(loadPrivatePacks(storage)[0].name, "旧题包");
  const created = createPrivatePack({ name: "语法易错题", tags: ["语法"] }, storage);
  addQuestionToPack(created.id, "question-1", storage);
  const updated = addQuestionToPack(created.id, "question-1", storage);
  assert.deepEqual(updated.questionIds, ["question-1"]);
  assert.equal(packStats(loadPrivatePacks(storage)).questions, 1);
});

test("community packs import once and questions normalize for practice", () => {
  const storage = createStorage();
  const first = copyCommunityPack({ id: "shared-pack", name: "语音题包", questionIds: ["q1"] }, storage);
  const second = copyCommunityPack({ id: "shared-pack", name: "语音题包", questionIds: ["q2"] }, storage);
  assert.equal(first.id, second.id);
  assert.equal(loadPrivatePacks(storage).length, 1);

  const question = normalizeQuestionForPractice({
    id: "q1",
    questionType: "单选题",
    stem: "普通话有几个基本声调？",
    optionsText: "A. 三个\nB. 四个",
    referenceAnswer: "B",
    knowledgePoints: ["声调"],
  });
  assert.equal(question.type, "single_choice");
  assert.equal(question.options.length, 2);
  assert.deepEqual(question.correctAnswer, ["B"]);
});

test("pack directories and cards preserve structure and can move between packs", () => {
  const storage = createStorage();
  const source = createPrivatePack({ name: "来源题包" }, storage);
  const target = createPrivatePack({ name: "目标题包" }, storage);
  const directory = addPackNode(source.id, { type: "directory", title: "第一章 语音", level: 1 }, "", storage);
  const card = addPackNode(source.id, { type: "card", directoryId: directory.id }, directory.id, storage);
  const attached = attachQuestionToCard(source.id, card.id, "question-voice-1", storage);
  assert.equal(attached.nodes.find((node) => node.id === card.id).directoryId, directory.id);
  assert.deepEqual(attached.questionIds, ["question-voice-1"]);

  movePackNodeToPack(source.id, directory.id, target.id, storage);
  const packs = loadPrivatePacks(storage);
  const movedSource = packs.find((pack) => pack.id === source.id);
  const movedTarget = packs.find((pack) => pack.id === target.id);
  assert.equal(movedSource.nodes.length, 0);
  assert.equal(movedTarget.nodes.some((node) => node.id === directory.id), true);
  assert.deepEqual(movedTarget.questionIds, ["question-voice-1"]);
});

test("private pack categories persist and pinned packs sort first", () => {
  const storage = createStorage();
  const category = createPrivatePackCategory("现代汉语", storage);
  const subcategory = createPrivatePackCategory("语法专题", category.id, storage);
  const textbook = createPrivatePackCategory("现代汉语上册", subcategory.id, storage);
  const flattenedFourthLevel = createPrivatePackCategory("易错题", textbook.id, storage);
  const first = createPrivatePack({ name: "语音题包", categoryId: textbook.id }, storage);
  const second = createPrivatePack({ name: "语法题包" }, storage);
  savePrivatePack({ ...first, pinned: true, pinnedAt: Date.now() }, storage);

  const categories = loadPrivatePackCategories(storage);
  assert.equal(categories[0].name, "现代汉语");
  assert.equal(categories.find((item) => item.id === subcategory.id).parentId, category.id);
  assert.equal(categories.find((item) => item.id === textbook.id).parentId, subcategory.id);
  assert.equal(categories.find((item) => item.id === flattenedFourthLevel.id).parentId, subcategory.id);
  renamePrivatePackCategory(textbook.id, "现代汉语（增订七版）上册", storage);
  assert.equal(loadPrivatePackCategories(storage).find((item) => item.id === textbook.id).name, "现代汉语（增订七版）上册");
  const packs = loadPrivatePacks(storage);
  assert.equal(packs[0].id, first.id);
  assert.equal(packs[0].categoryId, textbook.id);
  assert.equal(packs[1].id, second.id);

  deletePrivatePackCategory(subcategory.id, storage);
  assert.equal(loadPrivatePacks(storage).find((item) => item.id === first.id).categoryId, category.id);
  assert.equal(loadPrivatePackCategories(storage).some((item) => item.id === textbook.id), false);
});

// DEC-085：在某个目录下新建子目录时，要**紧贴该目录之后**插入（成为它的第一个子目录），
// 而不是跳过它已有的全部下级、插到子树末尾。
test("insertPackDirectory places a child right below its parent", () => {
  const storage = createStorage();
  const pack = createPrivatePack({ name: "目录插入" }, storage);
  const parent = addPackNode(pack.id, { type: "directory", title: "甲", level: 1 }, "", storage);
  const firstChild = addPackNode(pack.id, { type: "directory", title: "甲一", level: 2, parentId: parent.id }, parent.id, storage);
  const secondChild = addPackNode(pack.id, { type: "directory", title: "甲二", level: 2, parentId: parent.id }, firstChild.id, storage);
  addPackNode(pack.id, { type: "directory", title: "乙", level: 1 }, secondChild.id, storage);

  const inserted = insertPackDirectory(pack.id, { parentId: parent.id }, storage);
  assert.equal(inserted.level, 2);
  assert.equal(inserted.parentId, parent.id);
  assert.deepEqual(
    getPrivatePack(pack.id, storage).nodes.map((node) => node.title),
    ["甲", inserted.title, "甲一", "甲二", "乙"],
  );

  // 顶层新建（不传 parentId）仍然追加到末尾
  const topLevel = insertPackDirectory(pack.id, {}, storage);
  assert.equal(topLevel.level, 1);
  assert.equal(getPrivatePack(pack.id, storage).nodes[getPrivatePack(pack.id, storage).nodes.length - 1].id, topLevel.id);
});
