const test = require("node:test");
const assert = require("node:assert/strict");

const STORAGE_KEY = "shukao_card_box_sets";

function setupStore(initialSets) {
  const originalSets = initialSets || [{
    id: "set-1",
    title: "现代汉语",
    customSetField: "keep-set",
    cards: [{
      id: "card-1",
      question: "旧问题",
      answer: "旧答案",
      state: "learning",
      mastery: "hard",
      answerDelta: { ops: [{ insert: "旧答案\n" }] },
      futureField: { keep: true },
    }],
  }];
  const storage = new Map([[STORAGE_KEY, structuredClone(originalSets)]]);
  let writeCount = 0;
  global.wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => {
      writeCount += 1;
      storage.set(key, value);
    },
  };
  const modulePath = require.resolve("../apps/miniprogram/utils/card-box-store");
  delete require.cache[modulePath];
  return {
    store: require(modulePath),
    savedSets: () => storage.get(STORAGE_KEY),
    writeCount: () => writeCount,
  };
}

test("findCard locates a card inside its set and does not cross set boundaries", () => {
  const flow = setupStore();

  assert.equal(flow.store.findCard("set-1", "card-1").question, "旧问题");
  assert.equal(flow.store.findCard("missing-set", "card-1"), undefined);
  assert.equal(flow.store.findCard("set-1", "missing-card"), undefined);
});

test("addCardToSet appends a card and leaves existing set data intact", () => {
  const flow = setupStore();
  const input = { id: "card-2", question: "新问题", answer: "新答案", state: "new" };

  const added = flow.store.addCardToSet("set-1", input);

  assert.deepEqual(added, input);
  assert.notEqual(added, input);
  assert.equal(flow.savedSets()[0].customSetField, "keep-set");
  assert.deepEqual(flow.savedSets()[0].cards.map((card) => card.id), ["card-1", "card-2"]);
});

test("insertBlankCardInSet inserts before or after the reference card in the same directory", () => {
  const flow = setupStore();
  flow.store.updateCardInSet("set-1", "card-1", { section: "第一章" });

  const before = flow.store.insertBlankCardInSet("set-1", "card-1", "before");
  const after = flow.store.insertBlankCardInSet("set-1", "card-1", "after");
  const savedCards = flow.savedSets()[0].cards;

  assert.deepEqual(savedCards.map((card) => card.id), [before.id, "card-1", after.id]);
  assert.notEqual(before.id, after.id);
  [before, after].forEach((card) => {
    assert.equal(card.type, "qa");
    assert.equal(card.section, "第一章");
    assert.equal(card.question, "");
    assert.equal(card.answer, "");
    assert.equal(card.answerHtml, "");
    assert.deepEqual(card.answerDelta, { ops: [] });
    assert.deepEqual(card.answerSegments, []);
    assert.deepEqual(card.answerImages, []);
    assert.equal(card.mnemonic, "");
    assert.deepEqual(card.associations, []);
    assert.equal(card.state, "new");
    // C15（2026-09-23）：落盘时会给卡片补一个同步用的 updatedAt（服务端按它做 LWW），
    // 其余字段必须与插入时逐字一致——契约没变，只是多了一个受管的同步戳。
    const insertedSavedCard = savedCards.find((savedCard) => savedCard.id === card.id);
    const { updatedAt: insertedStamp, ...insertedSavedBody } = insertedSavedCard;
    assert.equal(typeof insertedStamp, "number");
    assert.deepEqual(insertedSavedBody, card);
  });
  assert.equal(flow.savedSets()[0].customSetField, "keep-set");
  assert.deepEqual(flow.savedSets()[0].cards.find((card) => card.id === "card-1").futureField, { keep: true });
});

test("insertBlankCardInSet guarantees a unique id when the generated id already exists", () => {
  const flow = setupStore();
  const originalNow = Date.now;
  const originalRandom = Math.random;
  try {
    Date.now = () => 123;
    Math.random = () => 0;
    flow.store.addCardToSet("set-1", { id: "card-123-0", question: "已有卡片", answer: "已有答案" });

    const inserted = flow.store.insertBlankCardInSet("set-1", "card-1", "after");

    assert.equal(inserted.id, "card-123-0-1");
    assert.equal(new Set(flow.savedSets()[0].cards.map((card) => card.id)).size, 3);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

test("insertBlankCardInSet does not write when its set, reference or placement is invalid", () => {
  const flow = setupStore();

  assert.equal(flow.store.insertBlankCardInSet("missing-set", "card-1", "before"), null);
  assert.equal(flow.store.insertBlankCardInSet("set-1", "missing-card", "after"), null);
  assert.equal(flow.store.insertBlankCardInSet("set-1", "card-1", "middle"), null);
  assert.equal(flow.writeCount(), 0);
  assert.deepEqual(flow.savedSets()[0].cards.map((card) => card.id), ["card-1"]);
});

test("insertDirectoryRelativeToCard inserts an empty same-level directory around the full subtree", () => {
  const cards = [
    { id: "level-1", section: "一级甲", question: "一级问题", answer: "一级答案", futureField: { keep: true } },
    { id: "level-2", section: "二级甲", question: "二级问题", answer: "二级答案" },
    { id: "level-3", section: "三级甲", question: "三级问题", answer: "三级答案" },
    { id: "level-2-next", section: "二级乙", question: "另一问题", answer: "另一答案" },
    { id: "level-1-next", section: "一级乙", question: "末尾问题", answer: "末尾答案" },
  ];
  const flow = setupStore([{
    id: "set-1",
    customSetField: "keep-set",
    cards: structuredClone(cards),
    sectionOrder: ["一级甲", "二级甲", "三级甲", "二级乙", "一级乙"],
    sectionLevels: { 一级甲: 1, 二级甲: 2, 三级甲: 3, 二级乙: 2, 一级乙: 1 },
  }]);

  const before = flow.store.insertDirectoryRelativeToCard("set-1", "level-1", "before", "  一级前置  ");
  const after = flow.store.insertDirectoryRelativeToCard("set-1", "level-2", "after", "二级后置");
  const saved = flow.savedSets()[0];

  assert.deepEqual(before, { title: "一级前置", level: 1, referenceTitle: "一级甲", placement: "before" });
  assert.deepEqual(after, { title: "二级后置", level: 2, referenceTitle: "二级甲", placement: "after" });
  assert.deepEqual(saved.sectionOrder, ["一级前置", "一级甲", "二级甲", "三级甲", "二级后置", "二级乙", "一级乙"]);
  assert.equal(saved.sectionLevels["一级前置"], 1);
  assert.equal(saved.sectionLevels["二级后置"], 2);
  assert.deepEqual(saved.cards, cards);
  assert.equal(saved.customSetField, "keep-set");
  assert.equal(saved.cards.some((card) => card.isDirectoryPlaceholder), false);
  assert.deepEqual(flow.store.findSet("set-1").sectionOrder, saved.sectionOrder, "relative empty directories survive reload");
});

test("insertDirectoryRelativeToCard rejects invalid or stale requests without writing", () => {
  const flow = setupStore();

  assert.equal(flow.store.insertDirectoryRelativeToCard("set-1", "card-1", "before", ""), null);
  assert.equal(flow.store.insertDirectoryRelativeToCard("set-1", "card-1", "sideways", "新目录"), null);
  assert.equal(flow.store.insertDirectoryRelativeToCard("set-1", "missing-card", "after", "新目录"), null);
  assert.equal(flow.store.insertDirectoryRelativeToCard("missing-set", "card-1", "before", "新目录"), null);
  assert.equal(flow.store.insertDirectoryRelativeToCard("set-1", "card-1", "before", "未分类"), null);
  assert.equal(flow.writeCount(), 0);
  assert.deepEqual(flow.savedSets()[0].cards.map((card) => card.id), ["card-1"]);
});

test("updateCardInSet merges onto the old card and preserves identity, state and unknown fields", () => {
  const flow = setupStore();

  const updated = flow.store.updateCardInSet("set-1", "card-1", {
    id: "attempted-id-change",
    question: "新问题",
    answerDelta: { ops: [{ insert: "新答案\n" }] },
  });

  assert.deepEqual(updated, {
    id: "card-1",
    question: "新问题",
    answer: "旧答案",
    state: "learning",
    mastery: "hard",
    answerDelta: { ops: [{ insert: "新答案\n" }] },
    futureField: { keep: true },
  });
  // C15：返回值仍是调用方给的那份（无同步戳），落盘的那份才带 updatedAt。
  const { updatedAt: savedStamp, ...savedCardBody } = flow.savedSets()[0].cards[0];
  assert.equal(typeof savedStamp, "number");
  assert.deepEqual(savedCardBody, updated);
  assert.equal(flow.savedSets()[0].customSetField, "keep-set");
});

test("card writes fail explicitly and do not persist when the set or card is missing", () => {
  const flow = setupStore();

  assert.equal(flow.store.addCardToSet("missing-set", { id: "card-2" }), null);
  assert.equal(flow.store.updateCardInSet("set-1", "missing-card", { question: "不应新增" }), null);
  assert.equal(flow.store.updateCardInSet("missing-set", "card-1", { question: "不应新增" }), null);
  assert.equal(flow.writeCount(), 0);
  assert.deepEqual(flow.savedSets()[0].cards.map((card) => card.id), ["card-1"]);
});

test("new and edited card sections are normalized and registered without removing old directories", () => {
  const flow = setupStore();

  flow.store.addCardToSet("set-1", {
    id: "card-2",
    section: "  新目录  ",
    question: "新问题",
    answer: "新答案",
  });
  assert.equal(flow.savedSets()[0].cards.find((card) => card.id === "card-2").section, "新目录");
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["未分类", "新目录"]);

  flow.store.updateCardInSet("set-1", "card-1", { section: "  修改后的目录  " });
  assert.equal(flow.savedSets()[0].cards.find((card) => card.id === "card-1").section, "修改后的目录");
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["未分类", "新目录", "修改后的目录"]);
  assert.equal(flow.savedSets()[0].sectionLevels["未分类"], 1);
  assert.equal(flow.savedSets()[0].sectionLevels["新目录"], 1);
  assert.equal(flow.savedSets()[0].sectionLevels["修改后的目录"], 1);
});

test("appendBlankCardToDirectory adds one empty card to the named directory only", () => {
  const flow = setupStore([{
    id: "set-1",
    title: "卡集",
    cards: [
      { id: "a-1", section: "第一章", question: "问题一", answer: "答案一", state: "new" },
      { id: "b-1", section: "第二章", question: "问题二", answer: "答案二", state: "new" },
    ],
    sectionOrder: ["第一章", "第二章"],
    sectionLevels: { 第一章: 1, 第二章: 2 },
  }]);

  const card = flow.store.appendBlankCardToDirectory("set-1", "第二章");

  assert.equal(card.section, "第二章");
  assert.equal(card.type, "qa");
  assert.equal(card.question, "");
  assert.equal(card.answer, "");
  assert.deepEqual(card.answerDelta, { ops: [] });
  assert.equal(flow.savedSets()[0].cards.map((item) => item.id).join(","), `a-1,b-1,${card.id}`);
  assert.equal(flow.savedSets()[0].cards[1].question, "问题二", "existing cards are untouched");
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["第一章", "第二章"], "adding a card never changes the directory list");

  assert.equal(flow.store.appendBlankCardToDirectory("set-1", "不存在"), null);
  assert.equal(flow.store.appendBlankCardToDirectory("missing-set", "第一章"), null);
});

test("insertChildDirectory lands right below the parent directory", () => {
  const flow = setupStore([{
    id: "set-1",
    title: "卡集",
    cards: [],
    sectionOrder: ["一级甲", "二级甲", "一级乙"],
    sectionLevels: { 一级甲: 1, 二级甲: 2, 一级乙: 1 },
  }]);

  const inserted = flow.store.insertChildDirectory("set-1", "一级甲", "二级乙");

  assert.deepEqual(inserted, { title: "二级乙", level: 2, parentTitle: "一级甲" });
  // DEC-085：紧贴父目录下方（成为它的第一个子目录），不再插到子树末尾
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["一级甲", "二级乙", "二级甲", "一级乙"]);
  assert.deepEqual(flow.savedSets()[0].sectionLevels, { 一级甲: 1, 二级甲: 2, 一级乙: 1, 二级乙: 2 });
  assert.equal(flow.store.insertChildDirectory("set-1", "一级甲", "二级乙"), null, "duplicate names are rejected");
  assert.equal(flow.store.insertChildDirectory("set-1", "没有这个目录", "二级丙"), null);
  assert.equal(flow.store.insertChildDirectory("set-1", "一级甲", "  "), null);
});

test("insertChildDirectory never nests deeper than the third level", () => {
  const flow = setupStore([{
    id: "set-1",
    title: "卡集",
    cards: [],
    sectionOrder: ["一级", "二级", "三级"],
    sectionLevels: { 一级: 1, 二级: 2, 三级: 3 },
  }]);

  const inserted = flow.store.insertChildDirectory("set-1", "三级", "四级");

  assert.equal(inserted.title, "四级");
  assert.equal(inserted.level, 3);
  assert.equal(flow.savedSets()[0].sectionLevels["四级"], 3);
});

test("moveCardInSet reorders inside a directory and can move a card across directories", () => {
  const flow = setupStore([{
    id: "set-1",
    title: "卡集",
    cards: [
      { id: "c-1", section: "第一章", question: "一", answer: "a", state: "new" },
      { id: "c-2", section: "第一章", question: "二", answer: "a", state: "new" },
      { id: "c-3", section: "第二章", question: "三", answer: "a", state: "new" },
    ],
    sectionOrder: ["第一章", "第二章"],
    sectionLevels: { 第一章: 1, 第二章: 1 },
  }]);

  flow.store.moveCardInSet("set-1", "c-2", "第一章", 0);
  assert.deepEqual(flow.savedSets()[0].cards.map((card) => card.id), ["c-2", "c-1", "c-3"]);

  flow.store.moveCardInSet("set-1", "c-2", "第二章", 0);
  const moved = flow.savedSets()[0].cards;
  assert.deepEqual(moved.map((card) => card.id), ["c-1", "c-2", "c-3"]);
  assert.equal(moved.find((card) => card.id === "c-2").section, "第二章");
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["第一章", "第二章"], "moving a card never changes the directory list");

  flow.store.moveCardInSet("set-1", "c-1", "第二章", 99);
  assert.deepEqual(flow.savedSets()[0].cards.map((card) => card.id), ["c-2", "c-3", "c-1"]);
  assert.equal(flow.store.moveCardInSet("set-1", "missing", "第一章", 0), null);
  assert.equal(flow.store.moveCardInSet("set-1", "c-1", "没有这个目录", 0), null);
});

test("moveCardInSet keeps a card inside an empty directory at the right place", () => {
  const flow = setupStore([{
    id: "set-1",
    title: "卡集",
    cards: [
      { id: "c-1", section: "第一章", question: "一", answer: "a", state: "new" },
      { id: "c-2", section: "第二章", question: "二", answer: "a", state: "new" },
    ],
    sectionOrder: ["第一章", "空目录", "第二章"],
    sectionLevels: { 第一章: 1, 空目录: 1, 第二章: 1 },
  }]);

  flow.store.moveCardInSet("set-1", "c-1", "空目录", 0);

  assert.deepEqual(flow.savedSets()[0].cards.map((card) => `${card.id}:${card.section}`), [
    "c-1:空目录",
    "c-2:第二章",
  ]);
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["第一章", "空目录", "第二章"]);
});

test("moveDirectoryToIndex reorders directories and keeps their cards grouped", () => {
  const flow = setupStore([{
    id: "set-1",
    title: "卡集",
    cards: [
      { id: "a-1", section: "第一章", question: "一", answer: "a", state: "new" },
      { id: "b-1", section: "第二章", question: "二", answer: "a", state: "new" },
    ],
    sectionOrder: ["第一章", "第二章", "第三章"],
    sectionLevels: { 第一章: 1, 第二章: 1, 第三章: 1 },
  }]);

  flow.store.moveDirectoryToIndex("set-1", "第三章", 0);
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["第三章", "第一章", "第二章"]);
  assert.deepEqual(flow.savedSets()[0].cards.map((card) => `${card.section}:${card.id}`), ["第一章:a-1", "第二章:b-1"]);

  flow.store.moveDirectoryToIndex("set-1", "第三章", 2);
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["第一章", "第二章", "第三章"]);
  assert.equal(flow.store.moveDirectoryToIndex("set-1", "没有这个目录", 0), null);
});

test("adoptCardsIntoDirectory hands the tail cards of one directory to another", () => {
  const flow = setupStore([{
    id: "set-1",
    title: "卡集",
    cards: [
      { id: "a-1", section: "第一章", question: "一", answer: "a", state: "new" },
      { id: "a-2", section: "第一章", question: "二", answer: "a", state: "new" },
      { id: "a-3", section: "第一章", question: "三", answer: "a", state: "new" },
      { id: "d-1", section: "第四节", question: "四", answer: "a", state: "new" },
      { id: "b-1", section: "第二章", question: "五", answer: "a", state: "new" },
    ],
    sectionOrder: ["第一章", "第二章", "第四节"],
    sectionLevels: { 第一章: 2, 第二章: 1, 第四节: 1 },
  }]);

  const adopted = flow.store.adoptCardsIntoDirectory("set-1", "第四节", "第一章", 1);

  assert.deepEqual(adopted, {
    directory: "第四节",
    sourceSection: "第一章",
    movedCount: 2,
    remainingCount: 1,
    level: 2,
  });
  assert.deepEqual(flow.savedSets()[0].cards.map((card) => `${card.section}:${card.id}`), [
    "第一章:a-1",
    "第四节:d-1",
    "第四节:a-2",
    "第四节:a-3",
    "第二章:b-1",
  ]);
  assert.deepEqual(flow.savedSets()[0].sectionOrder, ["第一章", "第四节", "第二章"]);
  assert.equal(flow.savedSets()[0].sectionLevels["第四节"], 2, "the directory inherits the level of the cards it takes over");

  assert.equal(flow.store.adoptCardsIntoDirectory("set-1", "第一章", "第一章", 0), null);
  assert.equal(flow.store.adoptCardsIntoDirectory("set-1", "第四节", "第一章", 99), null, "nothing left to adopt");
  assert.equal(flow.store.adoptCardsIntoDirectory("set-1", "第四节", "没有这个目录", 0), null);
});

test("createCardSet accepts an author and falls back to the default", () => {
  const flow = setupStore([]);

  const custom = flow.store.createCardSet("甲卡集", "说明", "我的卡集", "王一");
  assert.equal(custom.author, "王一");

  const fallback = flow.store.createCardSet("乙卡集", "", "我的卡集", "   ");
  assert.equal(fallback.author, "我的整理");

  const legacy = flow.store.createCardSet("丙卡集");
  assert.equal(legacy.author, "我的整理", "the author argument stays optional");
});

test("card colors resolve the palette, migrate legacy names and ignore junk", () => {
  const flow = setupStore([]);
  const { cardColor, CARD_COLORS, CARD_COLOR_KEYS } = flow.store;

  assert.equal(CARD_COLORS.length, 9);
  assert.deepEqual(CARD_COLOR_KEYS, ["rose", "peach", "cream", "mint", "aqua", "lemon", "sky", "blue", "lilac"]);
  assert.equal(cardColor("mint").soft, "#D8F2DE");
  assert.equal(cardColor("green"), null, "the retired default colour maps to no colour");
  assert.equal(cardColor("amber").key, "cream", "deliberate legacy colours still migrate");
  assert.equal(cardColor("blue").key, "sky", "legacy blue maps to the closest pastel");
  assert.equal(cardColor("blue").key, "sky", "legacy blue maps to the closest pastel");
  assert.equal(cardColor(""), null);
  assert.equal(cardColor("chartreuse"), null);

  const { cardColorBackground } = flow.store;
  assert.match(cardColorBackground("aqua"), /^linear-gradient\(150deg, rgba\(255,255,255,\.42\)/, "the milky wash stays weak");
  assert.match(cardColorBackground("aqua"), /radial-gradient\(18% 12% at 76% 9%, rgba\(255,255,255,\.95\)/, "a small sharp specular keeps it from looking plastic");
  assert.match(cardColorBackground("aqua"), /linear-gradient\(0deg, rgba\(255,255,255,\.22\)/, "the bottom edge catches light");
  assert.match(cardColorBackground("aqua"), /linear-gradient\(336deg, rgba\(42, 138, 128, 0\.12\)/, "the shaded side uses a same-hue refraction, not white");
  assert.match(cardColorBackground("aqua"), /#D2F1EC$/, "the lights are layered over the palette colour");
  assert.equal(cardColorBackground(""), "", "unpainted surfaces stay flat white");
  assert.equal(cardColorBackground("green"), "", "the retired default colour stays flat");
  assert.equal(flow.store.cardColorEdge("aqua"), "rgba(42, 138, 128, 0.26)", "painted cards get a same-hue glass edge");
  assert.equal(flow.store.cardColorEdge(""), "", "unpainted cards keep their neutral border");
});

test("setCardColors only touches the requested cards and can clear them", () => {
  const flow = setupStore([{
    id: "set-1",
    title: "甲",
    cards: [
      { id: "c-1", question: "一", color: "" },
      { id: "c-2", question: "二" },
      { id: "c-3", question: "三", color: "rose" },
    ],
  }]);

  flow.store.setCardColors("set-1", ["c-1", "c-2"], "aqua");
  let cards = flow.savedSets()[0].cards;
  assert.equal(cards.find((card) => card.id === "c-1").color, "aqua");
  assert.equal(cards.find((card) => card.id === "c-2").color, "aqua");
  assert.equal(cards.find((card) => card.id === "c-3").color, "rose", "untouched cards keep their color");

  flow.store.setCardColors("set-1", ["c-1"], "");
  cards = flow.savedSets()[0].cards;
  assert.equal(cards.find((card) => card.id === "c-1").color, "", "an empty key clears the color");
  assert.equal(cards.find((card) => card.id === "c-2").color, "aqua");

  assert.equal(flow.store.setCardColors("set-1", [], "rose"), null);
  assert.equal(flow.store.setCardColors("missing", ["c-1"], "rose"), null);
});

test("set colours migrate to palette keys and can be unified or rained", () => {
  const flow = setupStore([
    { id: "set-1", title: "一", color: "green", cards: [] },
    { id: "set-2", title: "二", color: "amber", cards: [] },
    { id: "set-3", title: "三", color: "", cards: [] },
    { id: "set-4", title: "四", color: "#3977e8", cards: [] },
  ]);
  const { normalizeSetColor, setSetsColor, applyRainbowSetColors } = flow.store;

  assert.equal(normalizeSetColor("green"), "", "the retired default colour becomes 无颜色");
  assert.equal(normalizeSetColor("amber"), "cream");
  assert.equal(normalizeSetColor("rose"), "rose");
  assert.equal(normalizeSetColor("#3977e8"), "", "unknown values are cleared");
  assert.equal(flow.store.loadCardSets()[0].color, "", "loading clears the retired default colour");

  assert.equal(setSetsColor(["set-1", "set-3"], "aqua"), 2);
  let sets = flow.savedSets();
  assert.equal(sets.find((set) => set.id === "set-1").color, "aqua");
  assert.equal(sets.find((set) => set.id === "set-3").color, "aqua");
  assert.equal(sets.find((set) => set.id === "set-2").color, "cream", "other sets keep their migrated colour");

  assert.equal(setSetsColor(["set-1"], ""), 1);
  assert.equal(flow.savedSets().find((set) => set.id === "set-1").color, "");

  const applied = applyRainbowSetColors(["set-2", "set-3", "set-1"]);
  assert.deepEqual(applied, ["rose", "peach", "cream"], "the gradient walks the palette in the given order");
  sets = flow.savedSets();
  assert.equal(sets.find((set) => set.id === "set-2").color, "rose");
  assert.equal(sets.find((set) => set.id === "set-3").color, "peach");
  assert.equal(sets.find((set) => set.id === "set-1").color, "cream");
  assert.equal(sets.find((set) => set.id === "set-4").color, "", "sets outside the list are untouched");

  const ten = Array.from({ length: 10 }, (_, index) => `rain-${index}`);
  const wide = setupStore(ten.map((id) => ({ id, title: id, cards: [] })));
  const wideApplied = wide.store.applyRainbowSetColors(ten);
  assert.equal(wideApplied.length, 10);
  assert.equal(wideApplied[8], wide.store.CARD_COLORS[8].key);
  assert.equal(wideApplied[9], wide.store.CARD_COLORS[0].key, "the palette cycles once exhausted");
});

test("moveCardSet reorders card sets before or after another set", () => {
  const flow = setupStore([
    { id: "set-1", title: "甲", cards: [] },
    { id: "set-2", title: "乙", cards: [] },
    { id: "set-3", title: "丙", cards: [] },
  ]);

  assert.deepEqual(flow.store.moveCardSet("set-3", "set-1", "before"), {
    setId: "set-3",
    targetSetId: "set-1",
    placement: "before",
  });
  assert.deepEqual(flow.savedSets().map((set) => set.id), ["set-3", "set-1", "set-2"]);

  flow.store.moveCardSet("set-3", "set-2", "after");
  assert.deepEqual(flow.savedSets().map((set) => set.id), ["set-1", "set-2", "set-3"]);

  flow.store.moveCardSet("set-2", "set-1", "before");
  assert.deepEqual(flow.savedSets().map((set) => set.id), ["set-2", "set-1", "set-3"]);

  assert.equal(flow.store.moveCardSet("set-1", "set-1", "before"), null);
  assert.equal(flow.store.moveCardSet("set-1", "missing", "before"), null);
  assert.equal(flow.store.moveCardSet("missing", "set-1", "before"), null);
  assert.equal(flow.store.moveCardSet("set-1", "set-2", "sideways"), null);
});

test.afterEach(() => {
  delete global.wx;
});
