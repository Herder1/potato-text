const test = require("node:test");
const assert = require("node:assert/strict");
const { parseQuestionImportText } = require("../apps/api/src/question-text-import");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");

const defaults = {
  subjectId: "modern-chinese",
  bookId: "modern-chinese-7-1",
  chapter: "默认章节",
};

test("plain text import parses mixed objective and subjective questions", () => {
  const text = `[单选题] 普通话以什么语音为标准音？
A. 北京语音
B. 北方语音
答案：A
参考答案：普通话以北京语音为标准音。
章节：绪论
知识点：普通话规范
分值：2
---
[简答题] 简述普通话的规范标准。
参考答案：包括标准音、基础方言和语法规范。
知识点：普通话规范
分值：10
得分点：2 | 正确定义普通话
2 | 说明标准音
2 | 说明基础方言
4 | 说明语法规范`;
  const candidates = parseQuestionImportText(text, defaults);
  assert.equal(candidates.length, 2);
  assert.equal(text.slice(candidates[0].sourceRange.start, candidates[0].sourceRange.end).startsWith("[单选题]"), true);
  assert.equal(text.slice(candidates[1].sourceRange.start, candidates[1].sourceRange.end).startsWith("[简答题]"), true);
  assert.equal(candidates[0].type, "single_choice");
  assert.equal(candidates[0].correctAnswer[0], "A");
  assert.equal(candidates[1].type, "short_answer");
  assert.equal(candidates[1].scoringPoints.length, 4);

  const store = createMemoryQuestionStore([]);
  const preview = store.previewImport(candidates);
  assert.equal(preview.every((item) => item.valid), true);
  assert.deepEqual(preview[1].sourceRange, candidates[1].sourceRange);
  const imported = store.importMany(candidates);
  assert.equal(imported.created.length, 2);
  assert.equal(store.list({ library: "official" }).questions.length, 2);
});

test("plain text import classifies natural answer points without blocking import", () => {
  const text = `[简答题] 简述新文学发展的三个方面。
参考答案：（1）文学观念发生变化。（2）文学语言得到更新。（3）文体建设取得进展。
知识点：新文学发展
分值：10
---
[简答题] 简述该概念的含义。
参考答案：该概念强调文学与时代生活之间的紧密联系，并形成新的表达方式。
知识点：文学观念
分值：5`;
  const candidates = parseQuestionImportText(text, defaults);
  const preview = createMemoryQuestionStore([]).previewImport(candidates);
  assert.equal(preview.every((item) => item.valid), true);
  assert.equal(preview[0].question.scoringPointStatus, "needs_score_allocation");
  assert.equal(preview[0].question.scoringPointCandidates.length, 3);
  assert.equal(preview[1].question.scoringPointStatus, "needs_split");
  assert.equal(preview[1].question.referenceAnswer, "该概念强调文学与时代生活之间的紧密联系，并形成新的表达方式。");
});

test("an empty analysis does not erase a subjective reference answer", () => {
  const text = `[名词解释题] 个人化写作[中山大学2010年研]\r\n答案：个人化写作是指坚守个人立场、表达个人经验的写作。\r\n参考答案：个人化写作是指坚守个人立场、表达个人经验的写作，又称“私人化写作”。\r\n解析：\r\n章节：待归类\r\n知识点：待归类\r\n分值：5`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.equal(candidate.stem, "个人化写作[中山大学2010年研]");
  assert.match(candidate.referenceAnswer, /又称“私人化写作”/);
  assert.equal(candidate.analysis, "");
  assert.equal(text.slice(candidate.sourceRange.start, candidate.sourceRange.end), text);
  assert.equal(createMemoryQuestionStore([]).previewImport([candidate])[0].valid, true);
});

test("a subjective answer field becomes the reference answer when no duplicate field exists", () => {
  const text = `[简答题] 简述个人化写作。\n答案：个人化写作强调个人立场与个人经验。\n解析：原书未提供单列解析。\n知识点：个人化写作\n分值：5`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.equal(candidate.referenceAnswer, "个人化写作强调个人立场与个人经验。");
  assert.deepEqual(candidate.correctAnswer, []);
  assert.equal(createMemoryQuestionStore([]).previewImport([candidate])[0].valid, true);
});

test("plain text import accepts multiple choices on one line", () => {
  const text = `[单选题] 现代汉语构成新词所广泛运用的方法是（ ）。
A. 轻声、儿化 B. 简缩 C. 附加法 D. 词根复合法
答案：D
参考答案：词根复合法。
知识点：现代汉语的特点
分值：2`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.deepEqual(candidate.options.map((option) => option.key), ["A", "B", "C", "D"]);
  assert.deepEqual(candidate.options.map((option) => option.text), ["轻声、儿化", "简缩", "附加法", "词根复合法"]);
  assert.deepEqual(candidate.correctAnswer, ["D"]);
  assert.equal(createMemoryQuestionStore([]).previewImport([candidate])[0].valid, true);
});

test("plain text import accepts adjacent inline choice markers", () => {
  const text = `[单选题] 发音器官中起共鸣作用的是（ ）。
A.肺和气管B.喉头和声带C.咽腔、鼻腔和口腔D.其他
答案：C
参考答案：咽腔、鼻腔和口腔。
知识点：语音概说
分值：2`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.deepEqual(candidate.options.map((option) => option.key), ["A", "B", "C", "D"]);
  assert.deepEqual(candidate.options.map((option) => option.text), ["肺和气管", "喉头和声带", "咽腔、鼻腔和口腔", "其他"]);
  assert.equal(createMemoryQuestionStore([]).previewImport([candidate])[0].valid, true);
});

test("plain text import does not treat lowercase pinyin letters as option markers", () => {
  const text = `[单选题] 下列辅音组合中，全部属于鼻音或边音的是（ ）。
A. m、n、l、r B. b、p、m、f C. z、j、zh D. d、t、n、l
答案：A
参考答案：m、n、l、r。
知识点：辅音
分值：2`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.deepEqual(candidate.options.map((option) => option.key), ["A", "B", "C", "D"]);
  assert.deepEqual(candidate.options.map((option) => option.text), [
    "m、n、l、r",
    "b、p、m、f",
    "z、j、zh",
    "d、t、n、l",
  ]);
  assert.equal(createMemoryQuestionStore([]).previewImport([candidate])[0].valid, true);
});

test("plain text import preserves non-choice answers", () => {
  const text = `[填空题] 现代汉民族共同语以（ ）为标准音。
答案：北京语音
参考答案：以北京语音为标准音。
知识点：现代汉民族共同语
分值：2`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.deepEqual(candidate.correctAnswer, ["北京语音"]);
  assert.equal(createMemoryQuestionStore([]).previewImport([candidate])[0].valid, true);
});

test("plain text import preserves a three-level chapter path", () => {
  const text = `[填空题] 现代汉民族共同语以（ ）为标准音。
答案：北京语音
参考答案：以北京语音为标准音。
章节：绪论 > 第一节 现代汉语概说 > 二、现代汉民族共同语
知识点：现代汉民族共同语
分值：2`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.equal(candidate.chapter, "绪论·第一节 现代汉语概说·二、现代汉民族共同语");
});

test("fill blank import restores missing lines without appending them after the citation", () => {
  const text = `[填空题] 提出了新诗的“三美”原则。[中山大学2012年研]
答案：闻一多
参考答案：闻一多。
知识点：新诗格律
分值：2
---
[填空题] 1930年代的散文流派 的影响延续很久。[中山大学2012年研]
答案：论语派
参考答案：论语派。
知识点：散文流派
分值：2
---
[填空题] 1930年代， 的话剧创作吸收了民族戏曲传统。________ [中山大学2012年研]
答案：欧阳予倩
参考答案：欧阳予倩。
知识点：话剧创作
分值：2
---
[填空题] 散文集《负暄琐话》的作者是 。（北京大学2011年研）________
答案：张中行
参考答案：张中行。
知识点：散文作品
分值：2`;
  const candidates = parseQuestionImportText(text, defaults);
  assert.deepEqual(candidates.map((candidate) => candidate.stem), [
    "________提出了新诗的“三美”原则。[中山大学2012年研]",
    "1930年代的散文流派________的影响延续很久。[中山大学2012年研]",
    "1930年代，________的话剧创作吸收了民族戏曲传统。 [中山大学2012年研]",
    "散文集《负暄琐话》的作者是________。（北京大学2011年研）",
  ]);
  const preview = createMemoryQuestionStore([]).previewImport(candidates);
  assert.equal(preview.every((item) => item.valid), true);
});

test("fill blank import keeps an ambiguous missing position for manual correction", () => {
  const text = `[填空题] 文学常识题目没有可判断的空缺位置
答案：待填内容
参考答案：待填内容。
知识点：文学常识
分值：2`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.equal(candidate.stem, "文学常识题目没有可判断的空缺位置");
  const [preview] = createMemoryQuestionStore([]).previewImport([candidate]);
  assert.equal(preview.valid, false);
  assert.equal(preview.error, "question_fill_blank_position_missing");
});

test("plain text import splits unnumbered type headings even when separator lines are sparse", () => {
  const text = `[填空题] 第一题直接以题型开头。
答案：答案一
参考答案：答案一。
知识点：知识点一
分值：2

[填空题] 第二题也没有题号。
答案：答案二
参考答案：答案二。
知识点：知识点二
分值：2

---

[名词解释题] 第三题使用题型别名。
参考答案：第三题答案。
知识点：知识点三
分值：5
得分点：5 | 完整解释概念`;
  const candidates = parseQuestionImportText(text, defaults);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((candidate) => candidate.type), ["fill_blank", "fill_blank", "term_definition"]);
  assert.deepEqual(candidates.map((candidate) => candidate.stem), [
    "第一题直接以题型开头。",
    "第二题也没有题号。",
    "第三题使用题型别名。",
  ]);
  candidates.forEach((candidate) => {
    assert.equal(text.slice(candidate.sourceRange.start, candidate.sourceRange.end).includes(candidate.stem), true);
  });
});

test("文本里的「教材：」只作原始来源描述，不推断教材归属、也不混进参考答案", () => {
  // 真实录入稿的形态：答案 → 参考答案 → 分值 → 教材 → 分隔线。
  // 历史缺陷：教材行没被识别，于是被追加进参考答案（372/372 全中）。
  const text = [
    "[单选题] 下列说法错误的是",
    "A. 现代汉语有口语",
    "B. 现代汉语是现代汉民族的语言",
    "答案：A",
    "参考答案：A 项正确。",
    "分值：2",
    "教材：《现代汉语（增订七版）》上下册",
    "",
    "---",
    "",
    "[单选题] 显式写了来源时以来源为准",
    "A. 甲",
    "B. 乙",
    "答案：B",
    "参考答案：B 项正确。",
    "分值：2",
    "教材：《不该覆盖的来源》",
    "来源：某校 2023 年真题",
  ].join("\n");
  const candidates = parseQuestionImportText(text, defaults);
  assert.equal(candidates.length, 2);
  // 参考答案里不再出现教材行
  assert.equal(candidates[0].referenceAnswer, "A 项正确。");
  // 文本里的教材是「原始来源描述」→ sourceLabel；不据此推断 bookId（"上下册"跨两册，推不出唯一一本）
  assert.equal(candidates[0].sourceLabel, "《现代汉语（增订七版）》上下册");
  assert.equal(candidates[0].bookId, defaults.bookId);
  // 显式「来源」优先，无论与「教材」的先后顺序
  assert.equal(candidates[1].sourceLabel, "某校 2023 年真题");
  // 分值这类单值标签会结束上一个多行字段：后面没被识别的行不再被吞进参考答案
  assert.equal(/\n/.test(candidates[0].referenceAnswer), false);
});

test("preview isolates invalid rows and JSON import accepts a questions array", () => {
  const json = JSON.stringify({ questions: [{
    ...defaults,
    type: "single_choice",
    knowledgePoints: ["普通话规范"],
    stem: "有效题目",
    options: [{ key: "A", text: "正确" }, { key: "B", text: "错误" }],
    correctAnswer: ["A"],
    referenceAnswer: "A 正确。",
    maxScore: 2,
  }, {
    ...defaults,
    type: "single_choice",
    knowledgePoints: ["普通话规范"],
    stem: "缺少答案的题目",
    options: [{ key: "A", text: "选项一" }, { key: "B", text: "选项二" }],
    referenceAnswer: "缺少正确答案。",
    maxScore: 2,
  }] });
  const candidates = parseQuestionImportText(json, defaults);
  const store = createMemoryQuestionStore([]);
  const preview = store.previewImport(candidates);
  assert.equal(preview.filter((item) => item.valid).length, 1);
  assert.equal(preview.find((item) => !item.valid).error, "question_choice_answer_invalid");
  const result = store.importMany(candidates);
  assert.equal(result.created.length, 1);
  assert.equal(result.errors.length, 1);
});

test("plain text import splits a material question into one question per sub-question", () => {
  // DEC-094：文本导入复用试卷导入那套材料题拆分——材料进 material，小问各自成题并共享 materialGroupId。
  const text = `[材料分析题] 阅读下面的语段，按要求答题。
某市消协受理教育培训投诉近 7 万件，高居服务类第三位。
（1）材料中画横线的文字使用了什么修辞手法？
（2）从构词法看，画波浪线的词语“支付”是什么类型的合成词？
（3）指出材料中“培训费用”的结构类型。
参考答案：（1）排比。
（2）联合型合成词。
（3）“培训费用”是偏正短语。
分值：6`;
  const candidates = parseQuestionImportText(text, defaults);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((item) => item.subNumber), ["1", "2", "3"]);
  assert.ok(candidates[0].material.includes("某市消协受理教育培训投诉"));
  assert.ok(candidates.every((item) => item.materialGroupId === candidates[0].materialGroupId));
  assert.ok(candidates.every((item) => !item.stem.includes("参考答案")));
  assert.equal(candidates[0].referenceAnswer, "排比。");
  assert.equal(candidates[1].referenceAnswer, "联合型合成词。");
  assert.equal(candidates[2].referenceAnswer, "“培训费用”是偏正短语。");
  // 分值口径见产品手册 §4.6.7 / DEC-099（2026-09-25 产品负责人确认）：
  // 原卷没写明小问分值、此时也还没有得分点 → 按均分**占位**并标「分值待核对」（6 ÷ 3 = 2/2/2，
  // 数字与旧口径一致，但性质是占位而不是已定分值）；正式分配在完善环节按得分点数做。
  assert.deepEqual(candidates.map((item) => item.maxScore), [2, 2, 2]);
  assert.deepEqual(candidates.map((item) => item.scoreBasis), ["placeholder", "placeholder", "placeholder"]);
  assert.ok(candidates[0].warnings.some((warning) => warning.includes("分值待核对")));
  assert.ok(candidates[0].warnings.some((warning) => warning.includes("已自动拆分")));
  const store = createMemoryQuestionStore([]);
  const preview = store.previewImport(candidates);
  assert.equal(preview.filter((item) => item.valid).length, 3);
});

test("原卷写明的小问分值优先：拆出来的每个小问照抄卷面分值，不再被均分覆盖（DEC-099）", () => {
  const text = `[材料分析题] 阅读下面的语段，按要求答题。
某市消协受理教育培训投诉近 7 万件，高居服务类第三位。
（1）材料中画横线的文字使用了什么修辞手法？（3分）
（2）从构词法看，画波浪线的词语“支付”是什么类型的合成词？（2分）
（3）指出材料中“培训费用”的结构类型。2分
参考答案：（1）排比。
（2）联合型合成词。
（3）“培训费用”是偏正短语。
分值：7`;
  const candidates = parseQuestionImportText(text, defaults);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((item) => item.maxScore), [3, 2, 2], "原卷写明的小问分值必须原样保留");
  assert.deepEqual(candidates.map((item) => item.scoreBasis), ["declared", "declared", "declared"]);
  assert.equal(candidates.reduce((sum, item) => sum + item.maxScore, 0), 7, "各问之和等于题组总分");
  assert.ok(candidates[0].warnings.some((warning) => warning.includes("原卷写明的小问分值")));
  assert.ok(!candidates[0].warnings.some((warning) => warning.includes("分值待核对")));
});

test("material question split survives OCR-confused numbering without losing content", () => {
  // 录入稿实测：第 1 问常被识别成「（l)」「（D」「（I）」，答案编号甚至变成「01）」。
  // 要求：不丢小问、不丢答案，且给出"编号疑似有偏差"的提示。
  const text = `[材料分析题] 阅读下面的语段，按要求答题。
2022 年，一些学生家长在校外培训机构捆绑销售的诱导下超限额支付培训费用。
（l)材料中画横线的文字使用了什么修辞手法"
（2）从构词法看，画波浪线的词语“支付”是什么类型的合成词？
（3）指出材料中“培训费用”的结构类型。
（D）指出加点词语“维护”的词性，并简要说明判断的依据。
参考答案：（D排比。
（2）联合型合成词。
（3）“培训费用”是偏正短语。
01）动词，表示动作行为。
分值：8`;
  const candidates = parseQuestionImportText(text, defaults);
  assert.equal(candidates.length, 4);
  assert.deepEqual(candidates.map((item) => item.subNumber), ["1", "2", "3", "4"]);
  assert.equal(candidates[0].referenceAnswer, "排比。");
  assert.equal(candidates[3].referenceAnswer, "动词，表示动作行为。");
  assert.ok(candidates.every((item) => item.maxScore === 2));
  assert.ok(candidates[0].warnings.some((warning) => warning.includes("编号疑似有识别偏差")));
});

test("题组总分缺失时按科目默认满分兜底（DEC-099 修订）：现代汉语 14 分 → 各问占位且标「分值待核对」", () => {
  const text = `[材料分析题] 阅读下面的语段，按要求答题。
材料正文一段。
（1）第一问？
（2）第二问？
参考答案：（1）甲。
（2）乙。`;
  const candidates = parseQuestionImportText(text, defaults);
  assert.equal(candidates.length, 2);
  // 产品负责人 2026-09-25：现代汉语每个材料题组 14 分、其余四科 20 分；原卷没写时才兜底。
  assert.deepEqual(candidates.map((item) => item.maxScore), [7, 7]);
  assert.deepEqual(candidates.map((item) => item.scoreBasis), ["placeholder", "placeholder"]);
  assert.ok(candidates[0].warnings.some((warning) => warning.includes("科目默认材料题组满分 14 分")));
  assert.ok(candidates[0].warnings.some((warning) => warning.includes("分值待核对")));
  // 兜底后分值 > 0，所以不再被"缺分值"拦下（这是本轮修掉的用户可见问题）
  const preview = createMemoryQuestionStore([]).previewImport(candidates);
  assert.ok(preview.every((item) => item.valid), preview.map((item) => item.error).join(","));
});

test("其他四科的默认题组满分是 20（古汉／古代文学／现代文学／当代文学），原卷写了就以原卷为准", () => {
  const text = `[材料分析题] 阅读下面的语段，按要求答题。
材料正文一段。
（1）第一问？
（2）第二问？
（3）第三问？
（4）第四问？
参考答案：（1）甲。
（2）乙。
（3）丙。
（4）丁。`;
  for (const subjectId of ["classical-chinese", "ancient-literature", "modern-literature", "contemporary-literature"]) {
    const candidates = parseQuestionImportText(text, { ...defaults, subjectId });
    assert.deepEqual(candidates.map((item) => item.maxScore), [5, 5, 5, 5], subjectId);
    assert.ok(candidates.reduce((sum, item) => sum + item.maxScore, 0) === 20, `${subjectId} 合计应为 20`);
  }
  // 卷面写了题组总分（15 分）→ 15 优先，默认值不参与
  const declared = parseQuestionImportText(`${text}
分值：15`, { ...defaults, subjectId: "classical-chinese" });
  assert.equal(declared.reduce((sum, item) => sum + item.maxScore, 0), 15);
  assert.ok(declared[0].warnings.some((warning) => warning.includes("原卷未写明每问分值")));
});

test("plain text import keeps a material question intact when there is only one sub-question", () => {
  const text = `[材料分析题] 阅读下面的语段，按要求答题。
只有一段材料，没有问题编号。
（1）唯一的提问？
参考答案：（1）唯一的答案。`;
  const [candidate] = parseQuestionImportText(text, defaults);
  assert.equal(candidate.materialGroupId, undefined);
  assert.ok(candidate.stem.includes("唯一的提问"));
});

test("材料题里的选项形材料行与小问行都不能丢（回归 2026-09-25：小问行被整行丢弃导致拆不开）", () => {
  const text = `[材料分析题] 阅读下面的材料, 回答问题。
A. 大道之行也,与三代之英,丘未之逮也。(《礼记·大同》)
B. 姜氏何厌之有?(《左传·郑伯克段于鄢》)
(1)以上面的三个句子为例,分析古代汉语宾语前置的多种表现形式。
(2)分析上面句子中加点字"之"的用法和意义。
参考答案：(1)否定句中代词宾语前置。\n(2)“之”是代词。
分值：
教材：《古代汉语（校订重排本）》第1—2册`;
  const candidates = parseQuestionImportText(text, { ...defaults, subjectId: "classical-chinese", bookId: "classical-chinese-1" });
  // 修前：小问行被丢 → 拆不开（1 条、无分值、被「缺分值」拦）；修后：拆成 2 个小问，按科目默认 20 分占位
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((item) => item.subNumber), ["1", "2"]);
  assert.ok(candidates[0].materialGroupId);
  assert.deepEqual(candidates.map((item) => item.maxScore), [10, 10]);
  assert.equal(candidates.reduce((sum, item) => sum + item.maxScore, 0), 20);
  // 材料原句（A./B.）不能被当成选项吃掉，必须留在材料里
  assert.deepEqual(candidates[0].options, []);
  assert.ok(String(candidates[0].material || "").includes("大道之行也"), "材料例句应留在材料里");
  assert.ok(candidates[1].stem.includes("分析上面句子中加点字"));
  const preview = createMemoryQuestionStore([]).previewImport(candidates);
  assert.ok(preview.every((item) => item.valid), preview.map((item) => item.error).join(","));
});

test("客观题没写分值 → 按题型默认值兜底（单选 2 分、多选 3 分），卷面写了仍以卷面为准", () => {
  const text = `[单选题] 普通话以什么语音为标准音？
A. 北京语音
B. 北方语音
答案：A
章节：绪论

[多选题] 下列属于合成词的有哪些？
A. 朋友
B. 葡萄
答案：A

[单选题] 卷面写了分值的单选题？
A. 甲
B. 乙
答案：A
分值：5

[判断题] 普通话就是北京话。
答案：错`;
  const candidates = parseQuestionImportText(text, defaults);
  assert.deepEqual(candidates.map((item) => item.type), ["single_choice", "multiple_choice", "single_choice", "true_false"]);
  // 单选 2 分、多选 3 分（只补这两类）；卷面写的 5 分不动；判断题不补（保持原样的"没写分值"）
  assert.deepEqual(candidates.map((item) => item.maxScore), [2, 3, 5, undefined]);
  assert.deepEqual(candidates.map((item) => item.scoreBasis), ["type-default", "type-default", undefined, undefined]);
  assert.deepEqual(candidates.map((item) => item.scoreNeedsReview), [true, true, undefined, undefined]);
  assert.ok(candidates[0].warnings.some((warning) => warning.includes("题型默认值填入 2 分")));
  assert.ok(candidates[1].warnings.some((warning) => warning.includes("题型默认值填入 3 分")));
  assert.ok(!(candidates[2].warnings || []).some((warning) => warning.includes("题型默认值")));
  // 兜底后单选/多选不再被「缺分值」拦下；判断题仍被拦（不扩大口径）
  const preview = createMemoryQuestionStore([]).previewImport(candidates);
  assert.deepEqual(preview.map((item) => item.valid), [true, true, true, false]);
  assert.equal(preview[3].error, "question_score_invalid");
});
