const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateDifficulty, inferExamTrack, knowledgeDifficultyProfiles, frequencyProfiles, primaryKnowledgePoint, questionFrequency } = require("../apps/api/src/question-assessment");

test("difficulty assessment keeps exam source level separate from relative difficulty", () => {
  const question = { type: "fill_blank", stem: "《呐喊》的作者是________。", knowledgePoints: ["鲁迅"], sourceLabel: "北京大学 2024 年考研真题" };
  assert.equal(inferExamTrack(question), "graduate");
  assert.equal(estimateDifficulty(question).score, 50);
});

test("difficulty belongs to the primary knowledge point rather than the question type", () => {
  const choice = estimateDifficulty({ type: "single_choice", stem: "下列说法正确的是（ ）。", knowledgePoints: ["词类划分的依据"] });
  const material = estimateDifficulty({ type: "material_analysis", stem: "结合材料作答。", material: "很长的材料", maxScore: 20, knowledgePoints: ["词类划分的依据"] });
  assert.equal(choice.score, material.score);
  assert.equal(choice.knowledgePoint, "词类划分的依据");
});

test("questions receive different relative ranks inside the same knowledge group", () => {
  const questions = [
    { id: "basic", subjectId: "modern-chinese", bookId: "book", type: "fill_blank", stem: "直接作答。", primaryKnowledgePoint: "词类划分的依据", knowledgePoints: ["词类划分的依据"], knowledgeDepthScore: 25, contentObscurityScore: 20 },
    { id: "deep-material", subjectId: "modern-chinese", bookId: "book", type: "material_analysis", stem: "结合材料作答。", primaryKnowledgePoint: "词类划分的依据", knowledgePoints: ["词类划分的依据", "语境中的词类活用边界"], knowledgeDepthScore: 80, contentObscurityScore: 70 },
    { id: "deep-choice", subjectId: "modern-chinese", bookId: "book", type: "single_choice", stem: "选择正确说法。", primaryKnowledgePoint: "词类划分的依据", knowledgePoints: ["词类划分的依据", "语境中的词类活用边界"], knowledgeDepthScore: 80, contentObscurityScore: 70 },
  ];
  const profiles = knowledgeDifficultyProfiles(questions);
  assert.ok(estimateDifficulty(questions[1], profiles).score > estimateDifficulty(questions[0], profiles).score);
  assert.equal(estimateDifficulty(questions[1], profiles).score, estimateDifficulty(questions[2], profiles).score);
});

test("secondary label count alone never raises relative difficulty", () => {
  const questions = [
    { id: "one-label", subjectId: "modern-chinese", bookId: "book", primaryKnowledgePoint: "语音性质", knowledgePoints: ["语音性质"] },
    { id: "many-labels", subjectId: "modern-chinese", bookId: "book", primaryKnowledgePoint: "语音性质", knowledgePoints: ["语音性质", "物理属性", "生理属性", "社会属性"] },
  ];
  const profiles = knowledgeDifficultyProfiles(questions);
  assert.equal(profiles.get("one-label").score, 50);
  assert.equal(profiles.get("many-labels").score, 50);
});

test("rare occurrence inside the question bank is not treated as content obscurity", () => {
  const questions = [
    { id: "common-1", subjectId: "modern-chinese", bookId: "book", primaryKnowledgePoint: "韵母", subKnowledgePoints: ["韵母结构"] },
    { id: "common-2", subjectId: "modern-chinese", bookId: "book", primaryKnowledgePoint: "韵母", subKnowledgePoints: ["韵母结构"] },
    { id: "rare", subjectId: "modern-chinese", bookId: "book", primaryKnowledgePoint: "韵母", subKnowledgePoints: ["四呼边界"] },
  ];
  const profiles = knowledgeDifficultyProfiles(questions);
  assert.equal(profiles.get("common-1").score, 50);
  assert.equal(profiles.get("common-2").score, 50);
  assert.equal(profiles.get("rare").score, 50);
  assert.equal(profiles.get("rare").knowledgeObscurityScore, 0);
});

test("question type, score and material length do not change a content assessment", () => {
  const questions = [
    { id: "choice", subjectId: "modern-chinese", bookId: "book", type: "single_choice", maxScore: 2, primaryKnowledgePoint: "词类划分", knowledgeDepthScore: 65, contentObscurityScore: 40 },
    { id: "material", subjectId: "modern-chinese", bookId: "book", type: "material_analysis", maxScore: 30, material: "很长的材料".repeat(100), primaryKnowledgePoint: "词类划分", knowledgeDepthScore: 65, contentObscurityScore: 40 },
  ];
  const profiles = knowledgeDifficultyProfiles(questions);
  assert.equal(profiles.get("choice").score, profiles.get("material").score);
});

test("the primary knowledge point follows the tested concept instead of the chapter title", () => {
  assert.equal(primaryKnowledgePoint({ chapter: "第一单元 > 文选：左传 > 晋灵公不君", stem: "找出文中的判断句。", knowledgePoints: ["晋灵公不君", "（七）判断句", "也字"] }), "（七）判断句");
  assert.equal(primaryKnowledgePoint({ chapter: "第四章语法", stem: "判断三个词的词性。", knowledgePoints: ["划分词类的依据", "虚词", "能愿动词", "副词", "连词"] }), "划分词类的依据");
});

test("the Guangdong zsb project supplies an insert-track fallback when the file name omits it", () => {
  assert.equal(inferExamTrack({ projectId: "gd-zsb-2026-hywxxkjc", sourceLabel: "2025年汉语言文学学科基础.pdf" }), "insert");
  assert.equal(inferExamTrack({ projectId: "gd-zsb-2026-hywxxkjc", sourceLabel: "北京大学 2025 年考研真题" }), "graduate");
  assert.equal(inferExamTrack({ projectId: "gd-zsb-2026-hywxxkjc", stem: "（首都师范大学2015年）不含复韵母的是（ ）。" }), "graduate");
  assert.equal(inferExamTrack({ projectId: "gd-zsb-2026-hywxxkjc", stem: "（暨南大学2016年）‘烟’和‘央’的区别是（ ）。" }), "graduate");
});

test("frequency uses weighted paper coverage and includes mock papers", () => {
  const questions = Array.from({ length: 10 }, (_, index) => ({
    id: `past-${index}`,
    projectId: "gd-zsb-2026-hywxxkjc",
    knowledgePoints: index < 3 ? ["通假字"] : ["古今异义"],
    sourceLabel: `广东插本 ${2015 + index} 年真题`,
  }));
  questions.push({ id: "mock-hit", projectId: "gd-zsb-2026-hywxxkjc", knowledgePoints: ["通假字"], sourceLabel: "插本模拟卷" });
  questions.push({ id: "textbook", projectId: "gd-zsb-2026-hywxxkjc", knowledgePoints: ["通假字"], sourceLabel: "《现代汉语》教材第一章" });
  const papers = [
    ...Array.from({ length: 10 }, (_, index) => ({ id: `paper-${index}`, kind: "past_paper", status: "published", questionIds: [`past-${index}`] })),
    { id: "mock-paper", kind: "official_mock", status: "published", questionIds: ["mock-hit"] },
    { id: "draft-paper", kind: "official_mock", status: "draft", questionIds: ["textbook"] },
  ];
  const profiles = frequencyProfiles(questions, papers);
  const frequency = questionFrequency(questions[0], profiles);
  assert.equal(frequency.label, "高频");
  assert.equal(frequency.rate, 32.7);
  assert.equal(frequency.pastPaperCount, 3);
  assert.equal(frequency.totalPastPaperCount, 10);
  assert.equal(frequency.mockPaperCount, 1);
  assert.equal(frequency.totalMockPaperCount, 1);
});

test("university-year citations identify the exam track but not a complete paper", () => {
  const questions = Array.from({ length: 9 }, (_, index) => ({
    id: `graduate-${index}`,
    stem: `（测试大学${2010 + index}年）题目${index}`,
    knowledgePoints: index < 3 ? ["（七）判断句"] : ["古今异义"],
    sourceLabel: "考研辅导书真题精选",
  }));
  const profiles = frequencyProfiles(questions);
  const frequency = questionFrequency({ stem: "（测试大学2010年）另一题", knowledgePoints: ["判断句"] }, profiles);
  assert.equal(frequency.track, "graduate");
  assert.equal(frequency.rate, 0);
  assert.equal(frequency.pastPaperCount, 0);
  assert.equal(frequency.totalPastPaperCount, 0);
  assert.equal(frequency.label, "样本不足");
});
