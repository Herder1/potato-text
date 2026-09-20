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
