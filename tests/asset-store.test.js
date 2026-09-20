const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assetStats,
  collectAsset,
  deleteAsset,
  loadAssets,
  loadManagedAssets,
  releaseAssetsFromPack,
  saveAsset,
  updateAsset,
} = require("../apps/miniprogram/utils/asset-store");

function createStorage() {
  const values = new Map();
  return {
    getStorageSync: (key) => values.get(key) || "",
    setStorageSync: (key, value) => values.set(key, value),
  };
}

test("user assets preserve directory, originality, visibility and moderation state", () => {
  const storage = createStorage();
  const question = saveAsset({
    type: "question",
    title: "李白诗歌艺术特色",
    subjectId: "ancient-literature",
    chapterId: "sui-tang",
    sectionId: "high-tang",
    knowledgePoints: ["李白"],
    tags: ["简答题"],
    originality: "original",
    visibility: "public",
  }, storage);
  assert.equal(question.moderationStatus, "pending_review");
  assert.equal(question.statusLabel, "待初筛");
  assert.deepEqual(loadAssets(storage)[0].knowledgePoints, ["李白"]);

  const privateAsset = updateAsset(question.id, { visibility: "private", moderationStatus: "private" }, storage);
  assert.equal(privateAsset.statusLabel, "私密");
  assert.equal(assetStats(loadAssets(storage)).questions, 1);
  assert.equal(deleteAsset(question.id, storage).length, 0);
});

test("community assets copy once into a private personal asset", () => {
  const storage = createStorage();
  const source = { id: "shared-1", type: "note", title: "文学史时间轴", visibility: "public", moderationStatus: "published" };
  const first = collectAsset(source, storage);
  const second = collectAsset(source, storage);
  assert.equal(first.id, second.id);
  assert.equal(first.visibility, "private");
  assert.equal(first.ownership, "collected");
  assert.equal(loadAssets(storage).length, 1);
});

test("question packs appear in managed assets and deleting a pack releases its questions", () => {
  const storage = createStorage();
  const { addQuestionToPack, createPrivatePack, deletePrivatePack } = require("../apps/miniprogram/utils/private-pack-store");
  const pack = createPrivatePack({ name: "现代汉语错题", source: "created" }, storage);
  const question = saveAsset({
    type: "question",
    title: "方言中差异最大的因素",
    stem: "方言中差异最大的因素是（ ）。",
    packId: pack.id,
    visibility: "private",
  }, storage);
  addQuestionToPack(pack.id, question.id, storage);

  const managed = loadManagedAssets(storage);
  assert.equal(managed.some((asset) => asset.type === "question_pack" && asset.id === pack.id), true);
  assert.equal(assetStats(managed).packs, 1);
  assert.equal(assetStats(managed).total, 2);

  deletePrivatePack(pack.id, storage);
  releaseAssetsFromPack(pack.id, storage);
  assert.equal(loadAssets(storage).find((asset) => asset.id === question.id).packId, "");
  assert.equal(loadManagedAssets(storage).some((asset) => asset.type === "question_pack"), false);
});
