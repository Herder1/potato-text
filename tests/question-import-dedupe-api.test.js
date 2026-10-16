// 「导入查重分三档 + 择优补充」接口层验收（DEC-094，规则正文见产品手册 §4.6.4）：
// 疑似重复只提示不阻断、择优补充只补空缺、非事实相同必须拒绝。
// 全部走内存夹具，绝不写 .runtime（正式题库数据）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");

async function withServer(run) {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (origin, path, body) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const DEFAULTS = { subjectId: "modern-chinese", bookId: "", chapter: "" };

test("单题详情接口：疑似重复行要能按 id 打开那道既有题（DEC-094 ② 的可定位入口）", async () => {
  await withServer(async (origin) => {
    const created = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "汉字的特点是什么（详情接口用例）",
      options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
      correctAnswer: ["A"],
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(created.success, true);

    const response = await fetch(`${origin}/api/admin/questions/${encodeURIComponent(created.question.id)}`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.question.id, created.question.id);
    assert.equal(payload.question.stem, "汉字的特点是什么（详情接口用例）");

    // 取不到就 404，不能返回空对象让前端以为拿到了题
    const missing = await fetch(`${origin}/api/admin/questions/question-does-not-exist`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "question_not_found");

    // 子路径不能被单题详情抢走（顺序敏感）
    const batches = await fetch(`${origin}/api/admin/questions/import-batches`);
    assert.equal(batches.status, 200);
    assert.equal((await batches.json()).success, true);
  });
});

test("import-text dry run reports suspected duplicates without blocking them", async () => {
  await withServer(async (origin) => {
    // 先把「下列选项中正确的一项是」写进库：这是产品负责人点名的"题干相同、选项不同"场景
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "下列选项中说法正确的一项是",
      options: [{ key: "A", text: "甲说法" }, { key: "B", text: "乙说法" }],
      correctAnswer: ["A"],
      referenceAnswer: "甲说法正确。",
      maxScore: 2,
      sourceLabel: "接口回归用例",
    }).then((response) => response.json());
    assert.equal(stored.success, true);

    const text = [
      "[单选题] 下列选项中说法正确的一项是",
      "A. 甲说法",
      "B. 丙说法",
      "答案：B",
      "分值：2",
    ].join("\n");
    const preview = await post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS }).then((r) => r.json());
    assert.equal(preview.success, true);
    assert.equal(preview.total, 1);
    // 题干一样、选项不同 → 不判重（可导入），但要提示疑似
    assert.equal(preview.validCount, 1);
    assert.equal(preview.duplicateCount, 0);
    assert.equal(preview.suspectedCount, 1);
    const [item] = preview.items;
    assert.equal(item.valid, true);
    assert.equal(item.suspicion.scope, "stored");
    assert.equal(item.suspicion.questionId, stored.question.id);
    assert.ok(item.suspicion.score >= 0.85);
    // 疑似重复要给比较（2026-09-22 产品负责人要求）：对照双方的内容都要下发，
    // 否则界面只能给一个"疑似 xx%"和跳转，操作者没法判断"像在哪、差在哪"。
    assert.equal(item.comparison.incoming.stem, "下列选项中说法正确的一项是");
    assert.equal(item.comparison.incoming.options[1].text, "丙说法");
    assert.equal(item.comparison.existing.stem, "下列选项中说法正确的一项是");
    assert.equal(item.comparison.existing.options[1].text, "乙说法");
    assert.equal(item.comparison.existing.id, stored.question.id);
    // 疑似重复**不提供**择优补充（产品手册 §4.6.4 ③）：载荷里不能出现 mergeable 标记，
    // 前端正是靠"有没有这个标记"决定要不要显示「择优补充到既有题」按钮。
    assert.equal(item.comparison.mergeable, undefined);

    // 提交后必须真的写进库，并回报疑似行
    const committed = await post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS, dryRun: false }).then((r) => r.json());
    assert.equal(committed.createdCount, 1);
    assert.equal(committed.suspectedCount, 1);
    assert.equal(committed.suspected[0].scope, "stored");
  });
});

test("疑似重复也要能逐字段对比：本批内的相似行同样要给出对照内容与行号", async () => {
  await withServer(async (origin) => {
    // 两行题干相同、选项**部分重合**（1/2＝50%，刚好过选项门槛）：第 1 行先入批，第 2 行应当把它当"本批疑似"对象。
    // 选项完全不重合的通用题干自 2026-09-22 起不再报疑似（见下一条用例）。
    const text = [
      "[单选题] 下列说法不正确的一项是",
      "A. 甲说法",
      "B. 乙说法",
      "答案：A",
      "分值：2",
      "",
      "[单选题] 下列说法不正确的一项是",
      "A. 甲说法",
      "B. 丙说法",
      "答案：B",
      "分值：2",
    ].join("\n");
    const preview = await post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS }).then((r) => r.json());
    assert.equal(preview.success, true);
    assert.equal(preview.total, 2);
    assert.equal(preview.duplicateCount, 0, "题干相同但选项不同 → 不判重");
    assert.equal(preview.suspectedCount, 1);
    const second = preview.items.find((item) => item.index === 1);
    assert.equal(second.suspicion.scope, "batch");
    // 批内相似行的定位与对比都靠服务端给的序号（预览不下发整题对象，前端无法反查）
    assert.equal(second.suspicion.questionIndex, 0);
    assert.equal(second.suspicion.comparison?.incoming, undefined, "对比载荷放在 item.comparison，不在 suspicion 里");
    assert.equal(second.comparison.incoming.options[1].text, "丙说法");
    assert.equal(second.comparison.existing.options[1].text, "乙说法", "对照对象必须是本批第 1 道的原文");
    assert.equal(second.comparison.existing.stem, "下列说法不正确的一项是");
    assert.equal(second.comparison.mergeable, undefined);
    // 第 1 行自己没有疑似对象，也不该被硬塞一个空的 comparison
    const first = preview.items.find((item) => item.index === 0);
    assert.equal(first.suspicion, null);
    assert.equal(first.comparison, null);
  });
});

// 2026-09-22 产品负责人对着截图定的三条口径（产品手册 §4.6.4 ② 已同步）：
//   图2：通用题干撞车（题干 100% 相同、选项完全不重合）不是重复 → 不再报疑似；
//   图1：只差「（插本NN年）」来源标注的同一道题 → 判事实相同、拒绝导入（不再当新题写进去）；
//   图4：短题干（归一化后 4~5 字）原先整行不参与比对 → 现在是疑似比对的对象。
test("通用题干撞车不再报疑似：题干相同、选项完全不重合（图2 口径）", async () => {
  await withServer(async (origin) => {
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "下列成语中,结构类型全部相同的一项是（通用题干用例）",
      options: [{ key: "A", text: "甲组成语" }, { key: "B", text: "乙组成语" }],
      correctAnswer: ["A"],
      referenceAnswer: "甲组。",
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(stored.success, true);

    const text = [
      "[单选题] 下列成语中,结构类型全部相同的一项是（通用题干用例）",
      "A. 丙组成语",
      "B. 丁组成语",
      "答案：B",
      "分值：2",
    ].join("\n");
    const preview = await post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS }).then((r) => r.json());
    assert.equal(preview.validCount, 1, "题干相同、选项不同 → 照旧可导入");
    assert.equal(preview.duplicateCount, 0);
    assert.equal(preview.suspectedCount, 0, "选项零交集不算疑似重复（通用题干不是重复）");
    assert.equal(preview.items[0].suspicion, null);
    assert.equal(preview.items[0].comparison, null);
  });
});

test("只差来源标注的同一道题判事实相同并拒绝导入（图1 口径）", async () => {
  await withServer(async (origin) => {
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本22年）关于汉字的特点，下面说法错误的是（ ）",
      options: [{ key: "A", text: "属于表意体系的文字" }, { key: "B", text: "是形体复杂的方块结构" }, { key: "C", text: "分化同音词能力强" }, { key: "D", text: "音节文字" }],
      correctAnswer: ["D"],
      referenceAnswer: "教材对汉字的性质、历史和使用情况有明确说明。",
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(stored.success, true);

    const text = [
      "[单选题] 关于汉字的特点,下面说法错误的是",
      "A. 属于表意体系的文字",
      "B. 是形体复杂的方块结构",
      "C. 分化同音词能力强",
      "D. 音节文字",
      "答案：D",
      "分值：2",
    ].join("\n");
    const preview = await post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS }).then((r) => r.json());
    assert.equal(preview.duplicateCount, 1, "只差来源标注 → 事实相同");
    assert.equal(preview.storedDuplicateCount, 1);
    assert.equal(preview.validCount, 0, "判重的行不再按可导入处理（拒绝导入）");
    const duplicate = preview.items[0];
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.duplicateOf, stored.question.id);
    assert.equal(duplicate.error, "question_duplicate");

    // 只差一个 OCR 变体标点（全角「，」在 NFKC 之后变成半角「,」，而库里那版是「.」）同样是同一道题。
    // 2026-09-22 修正归一化：剥离表必须同时列半角形态，否则 NFKC 之后原表一个也匹配不到。
    const variant = [
      "[单选题] 关于汉字的特点.下面说法错误的是",
      "A. 属于表意体系的文字",
      "B. 是形体复杂的方块结构",
      "C. 分化同音词能力强",
      "D. 音节文字",
      "答案：D",
      "分值：2",
    ].join("\n");
    const variantPreview = await post(origin, "/api/admin/questions/import-text", { text: variant, defaults: DEFAULTS }).then((r) => r.json());
    assert.equal(variantPreview.duplicateCount, 1, "标点变体（, / . ）不该被当成两道题");
    assert.equal(variantPreview.validCount, 0);
  });
});

test("短题干也参与疑似比对：d、t、n、l 是（图4 口径）", async () => {
  await withServer(async (origin) => {
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本23年）d、 t、 n、 l 是（ ）",
      options: [{ key: "A", text: "舌尖前音" }, { key: "B", text: "舌尖中音" }, { key: "C", text: "舌尖后音" }, { key: "D", text: "舌面前音" }],
      correctAnswer: ["B"],
      referenceAnswer: "舌尖中音。",
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(stored.success, true);

    const text = [
      "[单选题] d、t、n、l 是",
      "A. 舌尖前音",
      "B. 舌尖中音",
      "C. 舌面前音",
      "D. 舌面中音",
      "答案：B",
      "分值：2",
    ].join("\n");
    const preview = await post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS }).then((r) => r.json());
    assert.equal(preview.total, 1);
    // 归一化后题干只剩 5 个字（原先低于 6 字门槛，整行被跳过 → 完全没提示）
    assert.equal(preview.suspectedCount, 1, "短题干与库内同题必须提示疑似");
    const [item] = preview.items;
    assert.equal(item.valid, true, "选项有差异（3/4 相同）→ 提示但不阻断导入");
    assert.equal(item.suspicion.scope, "stored");
    assert.equal(item.suspicion.questionId, stored.question.id);
    assert.equal(item.suspicion.score, 1, "剥掉来源标注后题干完全一致");
    assert.equal(item.comparison.existing.options[1].text, "舌尖中音");
  });
});

test("选项与答案完全一致就算疑似：题干只差一字 / 整句改写也要提示（2026-09-22 第二次漏报）", async () => {
  await withServer(async (origin) => {
    // 他报的第 1 道：库内「（插本2022年）客家方言以（ ）代表」，导入稿「客家方言以( )为代表。」——
    // 选项 4/4 相同、答案同为 D，题干只差一个「为」字（字面相似度 0.77 < 0.85，原先毫无提示）。
    const hakka = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本2022年）客家方言以（ ）代表",
      options: [{ key: "A", text: "广州话" }, { key: "B", text: "潮汕话" }, { key: "C", text: "南昌话" }, { key: "D", text: "梅县话" }],
      correctAnswer: ["D"],
      referenceAnswer: "客家方言以广东梅县话为代表。",
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(hakka.success, true);

    const hakkaPreview = await post(origin, "/api/admin/questions/import-text", {
      text: ["[单选题] 客家方言以( )为代表。", "A. 广州话", "B. 潮汕话", "C. 南昌话", "D. 梅县话", "答案：D", "分值：2"].join("\n"),
      defaults: DEFAULTS,
    }).then((r) => r.json());
    assert.equal(hakkaPreview.suspectedCount, 1, "选项与答案完全一致 + ≥5 字连续公共片段（客家方言以）→ 必须提示");
    const hakkaItem = hakkaPreview.items[0];
    assert.equal(hakkaItem.valid, true, "疑似只提示、不阻断导入");
    assert.equal(hakkaItem.suspicion.scope, "stored");
    assert.equal(hakkaItem.suspicion.questionId, hakka.question.id);
    assert.equal(hakkaItem.suspicion.reason, "options_answer", "提示依据是选项与答案一致，不是字面相似度");
    assert.equal(hakkaItem.suspicion.commonRun, 5);
    assert.ok(hakkaItem.suspicion.score < 0.85, "字面相似度本来不达标——正因为如此才需要这条强证据");

    // 他报的第 2 道：库内「（插本22年）下列“广州市”拼音正确是（ ）」，导入稿整句改写
    // 「下列选项中, 符合“广州市”拼音字母拼写规则的是」——选项文本、答案 C 一致，字面相似度只有 0.36。
    const pinyin = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本22年）下列“广州市”拼音正确是（ ）",
      options: [{ key: "A", text: "GuǎngZhōuShì" }, { key: "B", text: "Guǎng Zhōushì" }, { key: "C", text: "GuǎngZhōu Shì" }, { key: "D", text: "Guǎng Zhōu Shì" }],
      correctAnswer: ["C"],
      referenceAnswer: "专名与通名分写，专名首字母大写。",
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(pinyin.success, true);

    const pinyinPreview = await post(origin, "/api/admin/questions/import-text", {
      text: ["[单选题] 下列选项中, 符合“广州市”拼音字母拼写规则的是", "A. GuǎngZhōuShì", "B. Guǎng Zhōushì", "C. Guǎngzhōu Shì", "D. GuǎngZhōu Shì", "答案：C", "分值：2"].join("\n"),
      defaults: DEFAULTS,
    }).then((r) => r.json());
    assert.equal(pinyinPreview.suspectedCount, 1, "整句改写的那道也要提示（本次导入只有这一行）");
    const pinyinItem = pinyinPreview.items[0];
    assert.equal(pinyinItem.valid, true);
    assert.equal(pinyinItem.suspicion.questionId, pinyin.question.id);
    assert.equal(pinyinItem.suspicion.reason, "options_answer");
    assert.ok(pinyinItem.suspicion.score < 0.5, `字面相似度=${pinyinItem.suspicion.score}（远低于阈值，靠选项+答案+公共片段才判出来）`);
  });
});

test("强证据的边界：选项答案相同但题干无关、或只共享来源标注，一律不提示", async () => {
  await withServer(async (origin) => {
    // 题库里"选项完全相同"的模板题很多（造字法：象形/指事/会意/形声 被 10 道不同题共用）。
    // 只有"选项+答案+≥5 字连续公共片段"三条同时成立才算疑似，否则会把模板题全报成重复。
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（东北师范大学2015年）“淼”“磊”的造字法是（ ）。",
      options: [{ key: "A", text: "象形" }, { key: "B", text: "会意" }, { key: "C", text: "指事" }, { key: "D", text: "形声" }],
      correctAnswer: ["B"],
      referenceAnswer: "会意。",
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(stored.success, true);

    // ① 换一道字（明/淼磊），选项、答案一致 → 必须不提示
    const unrelated = await post(origin, "/api/admin/questions/import-text", {
      text: ["[单选题] 从汉字构造方式看,“明”属于", "A. 象形", "B. 会意", "C. 指事", "D. 形声", "答案：B", "分值：2"].join("\n"),
      defaults: DEFAULTS,
    }).then((r) => r.json());
    assert.equal(unrelated.suspectedCount, 0, "选项与答案相同但题干无关 → 不是疑似重复（模板题噪音）");

    // ② 只共享来源标注（「大学2015年」这类）→ 必须先把来源标注剥掉再比公共片段，同样不提示
    const annotation = await post(origin, "/api/admin/questions/import-text", {
      text: ["[单选题] （四川大学2015年）“从”是", "A. 象形", "B. 会意", "C. 指事", "D. 形声", "答案：B", "分值：2"].join("\n"),
      defaults: DEFAULTS,
    }).then((r) => r.json());
    assert.equal(annotation.suspectedCount, 0, "公共片段不能是来源标注本身凑出来的");
    assert.equal(annotation.validCount, 1);

    // ③ 长句里偶然撞上 6 个字（公共片段占较短一版不足 40%）→ 同样不提示。
    //    真实录入稿 #344 就是这么一条 13% 的噪音：通用选项模板（比喻/比拟/借代/夸张）+ 撞 8 个字。
    const coincidence = await post(origin, "/api/admin/questions/import-text", {
      text: ["[单选题] 鲁迅《秋夜》中“叶子出水很高”之后描写枣树的句子运用了什么修辞手法", "A. 象形", "B. 会意", "C. 指事", "D. 形声", "答案：B", "分值：2"].join("\n"),
      defaults: DEFAULTS,
    }).then((r) => r.json());
    assert.equal(coincidence.suspectedCount, 0, "公共片段必须占较短一版 ≥40%，偶然撞几个字不算重复");
  });
});

test("import-text splits a material question into grouped sub-questions", async () => {
  await withServer(async (origin) => {
    const text = [
      "[材料分析题] 阅读下面的语段，按要求答题。",
      "材料正文一段。",
      "（1）第一问？",
      "（2）第二问？",
      "参考答案：（1）甲。",
      "（2）乙。",
      "分值：4",
    ].join("\n");
    const preview = await post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS }).then((r) => r.json());
    assert.equal(preview.total, 2);
    assert.equal(preview.validCount, 2);
    const committed = await post(origin, "/api/admin/questions/import-text", { text, defaults: DEFAULTS, dryRun: false }).then((r) => r.json());
    assert.equal(committed.createdCount, 2);
    // 提交响应只回计数；到平台题库里读回真正落库的两道小问
    const listed = await fetch(`${origin}/api/admin/questions?library=official&status=all`).then((r) => r.json());
    const created = listed.questions
      .filter((question) => String(question.stem).includes("问？"))
      .sort((left, right) => Number(left.subNumber) - Number(right.subNumber));
    assert.equal(created.length, 2);
    // 同一材料 → 同一 materialGroupId + 递增 subNumber + 共享 material
    assert.equal(created[0].materialGroupId, created[1].materialGroupId);
    assert.deepEqual(created.map((question) => question.subNumber), ["1", "2"]);
    assert.ok(created[0].material.includes("材料正文一段"));
    // 拆分结果被标记为同一题组（供后续逐小问挂知识树）
    assert.equal(created[0].isQuestionGroup, true);
    assert.equal(created[0].groupQuestionCount, 2);
  });
});

test("merge-duplicate fills missing fields of the identical existing question", async () => {
  await withServer(async (origin) => {
    const listUrl = `${origin}/api/admin/questions?library=official&status=all`;
    const created = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "现代汉语构成新词所广泛运用的方法是",
      options: [{ key: "A", text: "词根复合法" }, { key: "B", text: "附加法" }],
      correctAnswer: ["A"],
      referenceAnswer: "",
      maxScore: 2,
      sourceLabel: "",
      sourcePage: "",
    }).then((response) => response.json());
    const existingId = created.question.id;
    assert.equal(created.question.referenceAnswer, "");
    const totalBefore = await fetch(listUrl).then((r) => r.json()).then((p) => p.questions.length);

    const merged = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: existingId,
      question: {
        ...DEFAULTS,
        type: "single_choice",
        stem: "现代汉语构成新词所广泛运用的方法是（　）。",
        options: [{ key: "A", text: "词根复合法" }, { key: "B", text: "附加法" }],
        correctAnswer: ["A"],
        referenceAnswer: "词根复合法。",
        sourceLabel: "《现代汉语》增订七版",
        sourcePage: "第 25 页",
        maxScore: 2,
      },
    }).then((response) => response.json());
    assert.equal(merged.success, true);
    assert.equal(merged.updated, true);
    assert.equal(merged.questionId, existingId);
    assert.ok(merged.filled.includes("referenceAnswer"));
    assert.equal(merged.version, created.question.version + 1);

    const reread = await fetch(`${origin}/api/admin/questions/${existingId}`).then((r) => r.json());
    assert.equal(reread.question.referenceAnswer, "词根复合法。");
    assert.equal(reread.question.sourceLabel, "《现代汉语》增订七版");
    // 归属仍为空：择优补充不碰归属（DEC-094 ③）
    assert.equal(reread.question.bookId, "");
    assert.equal(reread.question.chapter, "");
    // 平台题库里没有因此多出一道题：择优补充是"更新既有题"，不是"新建题"
    assert.equal(await fetch(listUrl).then((r) => r.json()).then((p) => p.questions.length), totalBefore);
    // 择优补充必须有审计记录（改的是既有题，不能悄悄改）
    const logs = await fetch(`${origin}/api/admin/operation-logs?limit=20`).then((r) => r.json());
    const entry = (logs.logs || logs.items || []).find((row) => row.action === "question.fill_missing");
    assert.ok(entry, "缺少 question.fill_missing 操作日志");
    assert.equal(entry.targetId, existingId);
    assert.ok(entry.metadata.filled.includes("referenceAnswer"));
  });
});

test("merge-duplicate gives the filled answer a real source instead of claiming 已核对", async () => {
  await withServer(async (origin) => {
    const stem = "普通话以________为标准音。";
    const created = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "fill_blank",
      stem,
      options: [],
      correctAnswer: [],
      referenceAnswer: "",
      maxScore: 2,
      answerSource: "missing",
    }).then((response) => response.json());
    assert.equal(created.question.answerSource, "missing");

    const merged = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: created.question.id,
      question: {
        ...DEFAULTS,
        type: "fill_blank",
        stem,
        options: [],
        correctAnswer: [],
        referenceAnswer: "北京语音。",
        maxScore: 2,
      },
    }).then((response) => response.json());
    assert.equal(merged.success, true);
    assert.ok(merged.filled.includes("answerSource"));
    const reread = await fetch(`${origin}/api/admin/questions/${created.question.id}`).then((r) => r.json());
    // 补答案不能顺带把"没人核对过的答案"标成已核对（那会满足转 official 的前置条件）
    assert.equal(reread.question.answerSource, "pdf_answer");
    assert.equal(reread.question.answerReviewStatus, "unreviewed");
    assert.notEqual(reread.question.status, "official");
  });
});

test("merge-duplicate refuses a candidate whose facts differ", async () => {
  await withServer(async (origin) => {
    const created = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "第一道题",
      options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
      correctAnswer: ["A"],
      referenceAnswer: "甲。",
      maxScore: 2,
    }).then((response) => response.json());

    const response = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: created.question.id,
      question: {
        ...DEFAULTS,
        type: "single_choice",
        stem: "完全不同的另一道题",
        options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
        correctAnswer: ["A"],
        referenceAnswer: "甲。",
        maxScore: 2,
      },
    });
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.success, false);
    assert.equal(payload.error, "question_merge_requires_identical");
  });
});

// 对比处置（2026-09-22 产品负责人定稿）：两道事实相同的题里同一字段两版不同时，人工点名"用导入稿这版"
// 或"合并两版参考答案"——这是**唯一**允许覆盖非空字段的入口，写入即降级「待核对」并记审计。
test("对比处置：mode=absorb 用导入稿覆盖参考答案，并降级为待核对", async () => {
  await withServer(async (origin) => {
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本22年）关于汉字的特点，下面说法错误的是（ ）",
      options: [{ key: "A", text: "方块结构" }, { key: "B", text: "音节文字" }],
      correctAnswer: ["A"],
      referenceAnswer: "教材原版参考答案（较短）。",
      maxScore: 2,
      answerSource: "team_verified",
    }).then((response) => response.json());
    assert.equal(stored.question.answerReviewStatus, "verified");

    const candidate = {
      ...DEFAULTS,
      type: "single_choice",
      stem: "关于汉字的特点,下面说法错误的是",
      options: [{ key: "A", text: "方块结构" }, { key: "B", text: "音节文字" }],
      correctAnswer: ["A"],
      referenceAnswer: "汉字的特点有：属于表意体系的文字；是形体复杂的方块结构。",
      maxScore: 2,
      answerSource: "pdf_answer",
    };
    const absorbed = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: candidate,
      mode: "absorb",
      fields: ["referenceAnswer"],
    }).then((response) => response.json());
    assert.equal(absorbed.success, true);
    assert.equal(absorbed.mode, "absorb");
    assert.equal(absorbed.updated, true);
    assert.deepEqual(absorbed.overwritten, ["referenceAnswer"]);
    assert.equal(absorbed.answerReviewStatus, "unreviewed");
    assert.equal(absorbed.version, stored.question.version + 1);

    const reread = await fetch(`${origin}/api/admin/questions/${stored.question.id}`).then((r) => r.json());
    assert.equal(reread.question.referenceAnswer, candidate.referenceAnswer, "覆盖必须真的写进既有题");
    // 改了答案就必须重新核对：不能留着 verified 直接对用户可见
    assert.equal(reread.question.answerReviewStatus, "unreviewed");
    assert.equal(reread.question.answerSource, "pdf_answer");
    assert.equal(reread.question.answerVariants.official, candidate.referenceAnswer, "答案分层随参考答案一起更新");

    // 合并两版：既有那版保留 + 追加导入稿那版，两段都在
    // （导入稿那版必须与既有那版不同，否则没有可合并的内容 → updated:false 是对的）
    const secondVersion = { ...candidate, referenceAnswer: "汉字的特点有：属于表意体系的文字。（另一版表述）" };
    const merged = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: secondVersion,
      mode: "absorb",
      fields: ["referenceAnswer"],
      mergeReferenceAnswer: true,
    }).then((response) => response.json());
    assert.equal(merged.updated, true);
    assert.deepEqual(merged.overwritten, ["referenceAnswer(合并两版)"]);
    const mergedRead = await fetch(`${origin}/api/admin/questions/${stored.question.id}`).then((r) => r.json());
    assert.equal(mergedRead.question.referenceAnswer, `${candidate.referenceAnswer}\n\n【导入稿同题另版参考答案】${secondVersion.referenceAnswer}`);
    // 两版一致时不做无意义的写入
    const noop = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: { ...candidate, referenceAnswer: mergedRead.question.referenceAnswer },
      mode: "absorb",
      fields: ["referenceAnswer"],
    }).then((response) => response.json());
    assert.equal(noop.updated, false);
    // 审计：覆盖既有题必须有操作日志（question.absorb_comparison）
    const logs = await fetch(`${origin}/api/admin/operation-logs?limit=20`).then((r) => r.json());
    const entries = (logs.logs || logs.items || []).filter((row) => row.action === "question.absorb_comparison");
    assert.ok(entries.length >= 2, "两次处置都要留审计（覆盖 + 合并）");
    entries.forEach((row) => assert.equal(row.targetId, stored.question.id));
    assert.ok(entries.some((row) => row.metadata.overwritten.includes("referenceAnswer")));
    assert.ok(entries.some((row) => row.metadata.overwritten.includes("referenceAnswer(合并两版)")));
    // 日志里查不到 answerReviewStatus（admin-operation-store 对含 answer 的键做安全过滤），
    // 所以"降级待核对"这条必须核题目本体——合并之后同样不能留在已核对。
    assert.equal(mergedRead.question.answerReviewStatus, "unreviewed");
  });
});

test("对比处置的边界：必须点名字段、字段必须在白名单、非事实相同一律拒绝", async () => {
  await withServer(async (origin) => {
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本21年）现代汉语的语音标准是（ ）",
      options: [{ key: "A", text: "北京语音" }, { key: "B", text: "北方话" }],
      correctAnswer: ["A"],
      referenceAnswer: "北京语音。",
      maxScore: 2,
    }).then((response) => response.json());
    const candidate = {
      ...DEFAULTS,
      type: "single_choice",
      stem: "现代汉语的语音标准是",
      options: [{ key: "A", text: "北京语音" }, { key: "B", text: "北方话" }],
      correctAnswer: ["A"],
      referenceAnswer: "北京语音为标准音。",
      maxScore: 2,
    };
    // ① 不点名字段 → 拒绝（不给"整题覆盖"这种入口）
    const noFields = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id, question: candidate, mode: "absorb", fields: [],
    });
    assert.equal(noFields.status, 422);
    assert.equal((await noFields.json()).error, "question_absorb_fields_required");
    // ② 白名单外（归属字段在 DEC-093 的流程里改，不在这里）→ 拒绝
    for (const field of ["chapter", "knowledgePoints", "bookId", "stem", "options"]) {
      const illegal = await post(origin, "/api/admin/questions/merge-duplicate", {
        existingQuestionId: stored.question.id, question: candidate, mode: "absorb", fields: [field],
      });
      assert.equal(illegal.status, 422, `${field} 不该被允许`);
      assert.equal((await illegal.json()).error, "question_absorb_field_invalid");
    }
    // ③ 非事实相同 → 拒绝（服务端重算指纹，不信前端）
    const different = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: { ...candidate, stem: "另一个完全不同的题干" },
      mode: "absorb",
      fields: ["referenceAnswer"],
    });
    assert.equal(different.status, 422);
    assert.equal((await different.json()).error, "question_merge_requires_identical");
  });
});

// ── 人工裁决（产品负责人 2026-09-22 定稿）────────────────────────────────────────
// 疑似重复只是提示，操作者在对比弹窗里逐行定夺：「确认是同一道题」→ 不重复入库；
// 「确认不是重复」→ 照常入库、只留痕。裁决随"导入"这一次请求送上来（导入接口是按文本重解析的）。
const KEDONG_STEM = "（插本2022年）客家方言以（ ）代表";
const KEDONG_OPTIONS = [
  { key: "A", text: "广州话" }, { key: "B", text: "潮汕话" },
  { key: "C", text: "南昌话" }, { key: "D", text: "梅县话" },
];
const KEDONG_DRAFT = [
  "[单选题] 客家方言以( )为代表。",
  "A.广州话", "B.潮汕话", "C.南昌话", "D.梅县话", "答案：D", "分值：2",
].join("\n");

test("人工裁决：确认是同一道题的疑似行不重复入库，无效下标不得挡掉正常题", async () => {
  await withServer(async (origin) => {
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: KEDONG_STEM,
      options: KEDONG_OPTIONS,
      correctAnswer: ["D"],
      referenceAnswer: "梅县话。",
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(stored.success, true);
    const draft = `${KEDONG_DRAFT}\n---\n[单选题] 人工裁决用例：与库内毫无关系的新题\nA.甲\nB.乙\nC.丙\nD.丁\n答案：B\n分值：2`;
    const preview = await post(origin, "/api/admin/questions/import-text", { text: draft, defaults: DEFAULTS }).then((response) => response.json());
    assert.equal(preview.total, 2);
    assert.equal(preview.suspectedCount, 1, "第 1 行应被判疑似（选项与答案完全一致）");
    assert.equal(preview.items[0].suspicion.reason, "options_answer");
    assert.equal(preview.items[0].suspicion.commonRun, 5);

    const committed = await post(origin, "/api/admin/questions/import-text", {
      text: draft,
      defaults: DEFAULTS,
      dryRun: false,
      // 第 0 行＝「确认是同一道题」；第 1 行不是疑似，这个下标必须被忽略（不能把好题挡在库外）
      decisions: { confirmedDuplicateIndexes: [0], dismissedSuspicionIndexes: [1] },
    }).then((response) => response.json());
    assert.equal(committed.success, true);
    assert.equal(committed.createdCount, 1, "只该新建那道无关的新题");
    assert.equal(committed.confirmedDuplicateCount, 1);
    assert.equal(committed.confirmedDuplicates[0].index, 0);
    assert.equal(committed.confirmedDuplicates[0].reason, "options_answer");
    assert.equal(committed.confirmedDuplicates[0].commonRun, 5);
    assert.deepEqual(committed.ignoredDecisionIndexes, [1], "非疑似行的下标一律忽略并原样回报");
    assert.equal(committed.dismissedSuspicionCount, 0);
    assert.equal(committed.suspectedCount, 0, "已被人工确认的行不再是待处理的疑似");

    const listUrl = `${origin}/api/admin/questions?library=official&status=all`;
    const listed = await fetch(listUrl).then((response) => response.json());
    assert.equal(listed.questions.filter((question) => String(question.stem).includes("客家方言")).length, 1, "确认重复的行没有第二次入库");
    assert.equal(listed.questions.filter((question) => String(question.stem).includes("人工裁决用例")).length, 1, "被忽略的下标不影响正常题入库");

    // 审计：人工裁决单独留痕（谁、哪一行、依据什么、对照哪道既有题）
    const logs = await fetch(`${origin}/api/admin/operation-logs?limit=20`).then((response) => response.json());
    const verdict = (logs.logs || logs.items || []).find((row) => row.action === "question.suspicion_verdict");
    assert.ok(verdict, "人工裁决必须有操作日志");
    assert.deepEqual(verdict.metadata.confirmedIndexes, [0]);
    assert.deepEqual(verdict.metadata.confirmedQuestionIds, [stored.question.id]);
    assert.deepEqual(verdict.metadata.confirmedReasons, ["options_answer"]);
    assert.deepEqual(verdict.metadata.confirmedCommonRuns, [5]);
    assert.deepEqual(verdict.metadata.ignoredDecisionIndexes, [1]);
    assert.deepEqual(verdict.metadata.dismissedIndexes, []);
  });
});

test("人工裁决：确认不是重复的疑似行照常入库，只在日志里留痕", async () => {
  await withServer(async (origin) => {
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: KEDONG_STEM,
      options: KEDONG_OPTIONS,
      correctAnswer: ["D"],
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(stored.success, true);
    const committed = await post(origin, "/api/admin/questions/import-text", {
      text: KEDONG_DRAFT,
      defaults: DEFAULTS,
      dryRun: false,
      decisions: { dismissedSuspicionIndexes: [0] },
    }).then((response) => response.json());
    assert.equal(committed.createdCount, 1, "「确认不是重复」不影响入库");
    assert.equal(committed.confirmedDuplicateCount, 0);
    assert.equal(committed.dismissedSuspicionCount, 1);
    assert.equal(committed.dismissedSuspicions[0].index, 0);
    assert.equal(committed.suspectedCount, 1, "仍作为疑似重复回报，便于导入后回看");
    const listUrl = `${origin}/api/admin/questions?library=official&status=all`;
    const listed = await fetch(listUrl).then((response) => response.json());
    assert.equal(listed.questions.filter((question) => String(question.stem).includes("客家方言")).length, 2, "人工认定不是重复 → 照常入库");
    const logs = await fetch(`${origin}/api/admin/operation-logs?limit=20`).then((response) => response.json());
    const verdict = (logs.logs || logs.items || []).find((row) => row.action === "question.suspicion_verdict");
    assert.ok(verdict, "反向裁决同样要留痕");
    assert.deepEqual(verdict.metadata.dismissedIndexes, [0]);
    assert.equal(verdict.metadata.dismissedScores[0] > 0.5, true);
    assert.deepEqual(verdict.metadata.confirmedIndexes, []);
  });
});

// 2026-09-23 00:2x 产品负责人真机报错回归 + 00:5x 口径修订：「已确认是同一道题」的行点「替换所选」→
// 「写入既有题失败：question_merge_requires_identical」。根因是**模糊路径**的疑似行（两版选项文字
// 略有出入，例如"现代汉语是现代汉民族的语言" vs "…所使用的语言"）也长出了那两颗覆盖按钮，而服务端
// 对"覆盖非空"要求 strongEvidenceBetween()（含「选项集合完全相同」）——这类行必然不成立，于是必失败。
// 他随后给了口径修正（原话）：「虽然两者文字有所区别，但无论是答案还是选项，意思是表述相同和相近，
// 但左边的答案明显更好，**不能靠文字一模一样来辨别是否是同一道题**」——判"是不是同一道题"的依据是
// **人工确认**，服务端只保留一道"别把内容写到无关题目上"的兜底（强证据**或**模糊判据任一成立）。
// 于是三条边界一起钉住：① 未确认 → 一个字都写不进去；② 人工确认后**可以覆盖非空字段**（替换/合并），
// 不再要求两版逐字相同；③ 伪造标记（或根本不是同一道题）仍被 422 挡下。
test("人工确认的模糊路径疑似（两版选项文字不同）：确认后可覆盖非空字段，未确认或伪造标记仍被拒", async () => {
  await withServer(async (origin) => {
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本2023年）下列说法错误的是（ ）",
      options: [
        { key: "A", text: "现代汉语有口语" },
        { key: "B", text: "现代汉语是现代汉民族所使用的语言" },
        { key: "C", text: "官话是从汉代确定的" },
        { key: "D", text: "唐宋时，白话产生了" },
      ],
      correctAnswer: ["C"],
      referenceAnswer: "教材在“现代汉语概说”中对此作了明确说明，官话是从汉代确定的符合该知识点。",
      maxScore: 2,
      sourceLabel: "《现代汉语（增订第七版）》上册",
    }).then((response) => response.json());
    assert.equal(stored.success, true);
    // 导入稿：题干剥掉年份标注后相同、B 项文字略有出入、参考答案是另一版（他截图里"左边明显更好"的那版）
    const candidate = {
      ...DEFAULTS,
      type: "single_choice",
      stem: "下列说法错误的是",
      options: [
        { key: "A", text: "现代汉语有口语" },
        { key: "B", text: "现代汉语是现代汉民族的语言" },
        { key: "C", text: "官话是从汉代确定的" },
        { key: "D", text: "唐宋时,白话产生了" },
      ],
      correctAnswer: ["C"],
      referenceAnswer: "A项现代汉语有口语和书面语两种形式。B项，汉语是汉民族的语言。C项，官话是从汉代确定的。D项，到了唐宋时代，一种接近口语的书面语——白话产生了。",
      maxScore: 2,
    };
    const marker = { reason: "stem_similarity", score: 0.92, commonRun: 8 };
    // ① 不带人工确认 → 照旧拒绝（老边界没丢）
    const withoutConfirm = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: candidate,
    });
    assert.equal(withoutConfirm.status, 422);
    assert.equal((await withoutConfirm.json()).error, "question_merge_requires_identical");
    // ② 人工确认后「择优补充」：只填空缺——本例既有题没有空缺字段，故 updated=false 但**不能报错**，
    //    差异字段要如实进 conflicts（前端据此提示"这些字段没动"）
    const filled = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: candidate,
      operatorConfirmedSuspicion: marker,
    }).then((response) => response.json());
    assert.equal(filled.success, true, "人工确认的疑似行必须能走择优补充（补空缺），不能再报 422");
    assert.equal(filled.authorization, "operator_confirmed_suspicion");
    assert.equal(filled.updated, false, "既有题没有空缺字段 → 一个字都不写");
    assert.ok(filled.conflicts.includes("referenceAnswer"), "两版不同的字段要如实回报为冲突");
    // ③ 补齐场景：既有题参考答案为空时，人工确认能把空缺补上
    const blank = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本2023年）下列说法错误的是（ ）",
      options: [
        { key: "A", text: "现代汉语有口语" },
        { key: "B", text: "现代汉语是现代汉民族所使用的语言" },
        { key: "C", text: "官话是从汉代确定的" },
        { key: "D", text: "唐宋时，白话产生了" },
      ],
      correctAnswer: ["C"],
      maxScore: 2,
    }).then((response) => response.json());
    const filledBlank = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: blank.question.id,
      question: candidate,
      operatorConfirmedSuspicion: marker,
    }).then((response) => response.json());
    assert.equal(filledBlank.success, true);
    assert.equal(filledBlank.updated, true);
    assert.ok(filledBlank.filled.includes("referenceAnswer"));
    const reread = await fetch(`${origin}/api/admin/questions/${blank.question.id}`).then((response) => response.json());
    assert.equal(reread.question.referenceAnswer, candidate.referenceAnswer);
    assert.equal(reread.question.stem, "（插本2023年）下列说法错误的是（ ）", "题干绝不能被导入稿改写");
    assert.equal(reread.question.answerSource, blank.question.answerSource, "只补空缺不改原有的答案来源");
    assert.match(String(reread.question.versions[0].changeNote), /人工确认的疑似重复/);
    assert.equal(reread.question.versions.length > (blank.question.versions || []).length, true, "补空缺必须留版本记录");
    // ④【2026-09-23 00:5x 口径修订后的主路径】人工确认 + 覆盖非空字段（替换/合并）：
    //    本条正是他真机上那条——两版选项文字不同（模糊判据成立）→ **必须能写进去**，
    //    且写的是导入稿那版（"左边明显更好"）、版本 +1、答案状态降「待核对」。
    const absorb = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: candidate,
      mode: "absorb",
      fields: ["referenceAnswer"],
      operatorConfirmedSuspicion: marker,
    });
    assert.equal(absorb.status, 200, "人工确认为同一道题之后，覆盖非空字段不该再被 422（不能靠逐字相同判同题）");
    const absorbed = await absorb.json();
    assert.equal(absorbed.authorization, "operator_confirmed_suspicion");
    assert.ok(absorbed.overwritten.includes("referenceAnswer"), "既有参考答案非空 → 记 overwritten");
    assert.equal(absorbed.answerReviewStatus, "unreviewed", "动了答案必须降级待核对");
    const absorbedRead = await fetch(`${origin}/api/admin/questions/${stored.question.id}`).then((response) => response.json());
    assert.equal(absorbedRead.question.referenceAnswer, candidate.referenceAnswer, "库里应变成导入稿那版");
    assert.equal(absorbedRead.question.stem, "（插本2023年）下列说法错误的是（ ）", "题干仍不被改写");
    assert.equal(absorbedRead.question.version, stored.question.version + 1, "覆盖非空 → 版本 +1");
    assert.equal(absorbedRead.question.answerReviewStatus, "unreviewed");
    // ⑤ 伪造标记（两版选项毫不相干、内容也不是同一道题）→ 覆盖仍必须被拒：服务端只保留"别写错题"的兜底
    const forged = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: {
        ...candidate,
        referenceAnswer: "伪造标记不该生效。",
        options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }, { key: "C", text: "丙" }, { key: "D", text: "丁" }],
      },
      mode: "absorb",
      fields: ["referenceAnswer"],
      operatorConfirmedSuspicion: marker,
    });
    assert.equal(forged.status, 422, "选项毫不相干的两版不允许覆盖（伪造的确认标记无效）");
    assert.equal((await forged.json()).error, "question_merge_requires_identical");
  });
});

test("人工确认的改写型疑似：可只补空缺，也可逐字段点名覆盖/合并（服务端独立复核证据）", async () => {
  await withServer(async (origin) => {
    const options = [
      { key: "A", text: "GuǎngZhōuShì" }, { key: "B", text: "Guǎng Zhōushì" },
      { key: "C", text: "Guǎngzhōu Shì" }, { key: "D", text: "GuǎngZhōu Shì" },
    ];
    // 既有题：参考答案与来源都空缺——人工确认后能补的就是这些空缺
    const stored = await post(origin, "/api/admin/questions", {
      ...DEFAULTS,
      type: "single_choice",
      stem: "（插本22年）下列“广州市”拼音正确是（ ）",
      options,
      correctAnswer: ["C"],
      maxScore: 2,
    }).then((response) => response.json());
    assert.equal(stored.success, true);
    const candidate = {
      ...DEFAULTS,
      type: "single_choice",
      stem: "下列选项中, 符合“广州市”拼音字母拼写规则的是",
      options,
      correctAnswer: ["C"],
      referenceAnswer: "应拼作 Guǎngzhōu Shì。",
      maxScore: 2,
      sourceLabel: "插本22年真题",
    };
    // ① 不带人工确认：两版题干不同（整句改写）→ 指纹不同，仍按老口径拒绝
    const refused = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: candidate,
    });
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).error, "question_merge_requires_identical");
    // ② 带人工确认（对应弹窗里的「确认是同一道题」）→ 只补空缺
    const filled = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: candidate,
      operatorConfirmedSuspicion: { reason: "options_answer", score: 0.357, commonRun: 5 },
    }).then((response) => response.json());
    assert.equal(filled.success, true);
    assert.equal(filled.updated, true);
    assert.equal(filled.authorization, "operator_confirmed_suspicion");
    assert.ok(filled.filled.includes("referenceAnswer"));
    const read = await fetch(`${origin}/api/admin/questions/${stored.question.id}`).then((response) => response.json());
    assert.equal(read.question.referenceAnswer, "应拼作 Guǎngzhōu Shì。");
    assert.equal(read.question.stem, "（插本22年）下列“广州市”拼音正确是（ ）", "题干不属于补空缺范围，绝不能被导入稿改写");
    assert.match(String(read.question.versions[0].changeNote), /人工确认的疑似重复/);
    // ③ 人工确认之后**也允许"逐字段点名覆盖"**（2026-09-22 第五次口径修订：产品负责人要求
    //    「疑似重复也需要这种替换和合并」）。三条边界一起核：授权来源要写对、覆盖内容要真的落库、
    //    版本说明要能与"事实相同"区分。
    const absorb = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: { ...candidate, referenceAnswer: "应拼作 Guǎngzhōu Shì（导入稿另一版）。" },
      mode: "absorb",
      fields: ["referenceAnswer"],
      operatorConfirmedSuspicion: { reason: "options_answer", score: 0.357, commonRun: 5 },
    }).then((response) => response.json());
    assert.equal(absorb.success, true);
    assert.equal(absorb.updated, true);
    assert.equal(absorb.authorization, "operator_confirmed_suspicion");
    assert.deepEqual(absorb.overwritten, ["referenceAnswer"]);
    assert.equal(absorb.answerReviewStatus, "unreviewed");
    const afterAbsorb = await fetch(`${origin}/api/admin/questions/${stored.question.id}`).then((response) => response.json());
    assert.equal(afterAbsorb.question.referenceAnswer, "应拼作 Guǎngzhōu Shì（导入稿另一版）。", "人工确认后的覆盖必须真的写进既有题");
    assert.equal(afterAbsorb.question.stem, "（插本22年）下列“广州市”拼音正确是（ ）", "题干不在白名单里，覆盖也改不了它");
    assert.match(String(afterAbsorb.question.versions[0].changeNote), /人工确认的疑似重复/);
    // ③b 合并两版走同一条授权：既有那版保留 + 追加导入稿那版
    const absorbedMerge = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: { ...candidate, referenceAnswer: "应拼作 Guǎngzhōu Shì（导入稿第三版）。" },
      mode: "absorb",
      fields: ["referenceAnswer"],
      mergeReferenceAnswer: true,
      operatorConfirmedSuspicion: { reason: "options_answer", score: 0.357, commonRun: 5 },
    }).then((response) => response.json());
    assert.equal(absorbedMerge.success, true);
    assert.equal(absorbedMerge.authorization, "operator_confirmed_suspicion");
    assert.ok(absorbedMerge.overwritten.includes("referenceAnswer(合并两版)"));
    const afterAbsorbedMerge = await fetch(`${origin}/api/admin/questions/${stored.question.id}`).then((response) => response.json());
    assert.match(String(afterAbsorbedMerge.question.referenceAnswer), /【导入稿同题另版参考答案】/);
    assert.match(String(afterAbsorbedMerge.question.referenceAnswer), /应拼作 Guǎngzhōu Shì（导入稿另一版）。/);
    // ③c 没有人工确认这一条，改写型疑似照旧一个字都不许覆盖（老口径的边界没有丢）
    const absorbWithoutConfirm = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: { ...candidate, referenceAnswer: "应拼作 Guǎngzhōu Shì（导入稿第四版）。" },
      mode: "absorb",
      fields: ["referenceAnswer"],
    });
    assert.equal(absorbWithoutConfirm.status, 422);
    assert.equal((await absorbWithoutConfirm.json()).error, "question_merge_requires_identical");
    // ③d 伪造人工确认（证据不成立：选项完全不同）→ 覆盖也必须被拒：服务端自己重算强证据
    const forgedAbsorb = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: {
        ...candidate,
        referenceAnswer: "应拼作 Guǎngzhōu Shì（导入稿第五版）。",
        options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }, { key: "C", text: "丙" }, { key: "D", text: "丁" }],
      },
      mode: "absorb",
      fields: ["referenceAnswer"],
      operatorConfirmedSuspicion: { reason: "options_answer", score: 0.9, commonRun: 99 },
    });
    assert.equal(forgedAbsorb.status, 422);
    assert.equal((await forgedAbsorb.json()).error, "question_merge_requires_identical");
    // ④ 证据不成立（选项完全不同）时，即便声称"我确认过了"也必须拒绝：服务端自己重算强证据
    const forged = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: { ...candidate, options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }, { key: "C", text: "丙" }, { key: "D", text: "丁" }] },
      operatorConfirmedSuspicion: { reason: "options_answer", score: 0.9, commonRun: 99 },
    });
    assert.equal(forged.status, 422);
    assert.equal((await forged.json()).error, "question_merge_requires_identical");
    // ⑤ 两版事实相同的稿仍走原路径（授权来源必须能分辨，不能都记成"人工确认"）
    const identical = await post(origin, "/api/admin/questions/merge-duplicate", {
      existingQuestionId: stored.question.id,
      question: { ...candidate, stem: "（插本22年）下列“广州市”拼音正确是（ ）", referenceAnswer: "" },
    }).then((response) => response.json());
    assert.equal(identical.authorization, "identical_fingerprint");
  });
});
