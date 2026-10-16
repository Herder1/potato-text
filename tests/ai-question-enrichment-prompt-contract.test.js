const assert = require("node:assert/strict");
const test = require("node:test");

const { defaultConfig } = require("../apps/api/src/ai-config");

/**
 * 「题目归属判断与得分点完善」（question_enrichment）系统提示词的**契约守卫**。
 *
 * 为什么需要它：这条系统提示词是服务端强校验的对照物——它必须让模型知道要输出
 * projectId / subjectId / bookId / catalogNodeId（四级链），并遵守同源、分值合计、
 * 页码证据等规则；漏掉任何一条，都会让服务端直接抛
 * question_enrichment_subject_invalid / _book_invalid / _subject_book_mismatch /
 * _scoring_points_mismatch，表现为"整题完善失败"。
 *
 * 断言只锁**契约**（必须表达的意思），不锁具体措辞，因此重写提示词时只要语义仍在就不会误伤；
 * 反过来，把这条提示词换成"只判目录归属"的旧口径写法会立刻失败（见本文件最后一条反例）。
 */
const SYSTEM_PROMPT = defaultConfig.prompts.question_enrichment.systemPrompt;

const CLAUSES = [
  ["四级归属链（考试项目 → 科目 → 教材 → 知识树，按此顺序）", (text) => /考试项目[\s\S]{0,30}科目[\s\S]{0,30}教材[\s\S]{0,30}知识树/.test(text)],
  ["科目与教材必须同源", (text) => /科目与教材必须同源/.test(text)],
  ["目录节点不得创造", (text) => /不得创造目录/.test(text)],
  ["不得改写已核验答案", (text) => /改写已核验[^。；]{0,10}答案/.test(text)],
  ["知识点须是学科概念", (text) => /学科概念/.test(text)],
  ["知识点不得用泛化词", (text) => /泛化词/.test(text)],
  ["得分点分值之和必须等于总分", (text) => /分值之和必须严格等于题目总分/.test(text)],
  ["教材页码受来源约束", (text) => /教材页码/.test(text)],
  ["页码证据不足必须留空", (text) => /证据不足[^。；]{0,12}留空/.test(text)],
  ["改科目/改教材必须给出证据指向", (text) => /哪条证据指向/.test(text)],
  ["结果只作人工建议，不直接发布", (text) => /不直接发布/.test(text)],
  ["只输出有效 JSON 且不要 Markdown", (text) => /只输出[\s\S]{0,10}JSON/.test(text) && /Markdown/.test(text)],
  // 系统提示词**不参与变量渲染**（server.js 直接把 scene.prompt.systemPrompt 透传给上游），
  // 因此里面出现任何 {{...}} 都只会以字面量发给模型，属于必然的脏输入。
  ["系统提示词不得含未定义变量占位符", (text) => !/\{\{[a-zA-Z0-9_]+\}\}/.test(text)],
];

test("question_enrichment 系统提示词必须满足全部契约条款", () => {
  assert.equal(typeof SYSTEM_PROMPT, "string");
  assert.ok(SYSTEM_PROMPT.length > 100, "系统提示词过短，疑似被清空");
  const missing = CLAUSES.filter(([, check]) => !check(SYSTEM_PROMPT)).map(([label]) => label);
  assert.deepEqual(missing, [], `系统提示词缺少以下契约条款：\n${missing.join("\n")}\n\n当前提示词：\n${SYSTEM_PROMPT}`);
});

test("契约守卫有牙齿：只判“目录归属”的旧口径写法必须被拒", () => {
  // 反例取自 2026-09-25 产品负责人提供的一份候选稿（节选其关键特征）：
  // 它只谈目录归属、用 {{input_data}} 当输入槽，且没有四级链与同源规则。
  const rejectedSample = "你是一位专精于汉语言文学学科题库建设的专业助手。在处理 {{input_data}} 时，"
    + "以教材正文为依据。题目只能归属到输入中已确认存在的 catalogNodeId，禁止发明新目录。"
    + "知识点应使用学科概念名称，不得使用页码、题号、章节标题或泛化词。"
    + "所有得分点分值之和必须严格等于题目总分。证据不足时留空并说明。只输出有效 JSON，不要 Markdown。";
  const fourLevel = CLAUSES.find(([label]) => label.startsWith("四级归属链"))[1];
  const noPlaceholder = CLAUSES.find(([label]) => label.startsWith("系统提示词不得含"))[1];
  const sameOrigin = CLAUSES.find(([label]) => label.startsWith("科目与教材必须同源"))[1];
  const evidence = CLAUSES.find(([label]) => label.startsWith("改科目/改教材"))[1];
  assert.equal(fourLevel(rejectedSample), false, "反例本应缺四级链");
  assert.equal(noPlaceholder(rejectedSample), false, "反例本应带未定义占位符");
  assert.equal(sameOrigin(rejectedSample), false, "反例本应缺同源规则");
  assert.equal(evidence(rejectedSample), false, "反例本应缺换归属证据规则");
  // 而反例里写对的部分不该误伤：保持"守卫只拒该拒的"
  assert.equal(CLAUSES.find(([label]) => label.startsWith("知识点须是"))[1](rejectedSample), true);
  assert.equal(CLAUSES.find(([label]) => label.startsWith("得分点分值"))[1](rejectedSample), true);
});
