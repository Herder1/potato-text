const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAiTaskStore } = require("../apps/api/src/ai-task-store");
const { createMemoryExamImportStore } = require("../apps/api/src/exam-import-store");
const { createMemoryExamStore } = require("../apps/api/src/exam-store");
const { examDocumentFormat, extractExamDocument, splitWordText } = require("../apps/api/src/exam-document-import");
const { applySequentialObjectiveAnswerSections, applyVerbatimAnswerBlocks, examPagesForModel, extractSequentialObjectiveAnswerSections, extractVerbatimAnswerBlocks, mergeAnswerRecognitions, mergeExamRecognitions, normalizeExamModelOutput, reflowVerbatimAnswerText } = require("../apps/api/src/exam-paper-import");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function createDocxBuffer(paragraphs) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder("_rels").file(".rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(paragraph)}</w:t></w:r></w:p>`).join("");
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("exam documents accept PDF and DOCX and extract Word text into bounded fragments", async () => {
  assert.equal(examDocumentFormat("试卷.docx"), "docx");
  assert.equal(examDocumentFormat("答案.PDF"), "pdf");
  assert.equal(examDocumentFormat("unknown", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(examDocumentFormat("试卷.doc"), "");

  const docx = await createDocxBuffer([
    "2026 年汉语言文学学科基础模拟试卷",
    "一、单项选择题",
    "1. 现代汉民族共同语是普通话。",
    "2. 《诗经》是中国古代第一部诗歌总集。",
  ]);
  const extracted = await extractExamDocument(docx, { fileName: "综合试卷.docx" });
  assert.equal(extracted.format, "docx");
  assert.ok(extracted.textChars > 20);
  assert.ok(extracted.pageCount >= 1);
  assert.match(extracted.pages[0].text, /现代汉民族共同语/);
  assert.ok(splitWordText(`${"甲".repeat(40)}\n\n${"乙".repeat(40)}`, 50).length >= 2);
});

test("exam paper model output becomes an editable review draft", () => {
  const recognized = normalizeExamModelOutput({
    exam: { title: "2026 年模拟卷", durationMinutes: 90 },
    sections: [{
      title: "一、单项选择题",
      type: "单选题",
      questions: [{
        number: 1,
        subjectId: "modern-chinese",
        bookId: "modern-chinese-7-1",
        stem: "现代汉民族共同语是？",
        options: { A: "普通话", B: "粤语" },
        answer: "A",
        score: 2,
        chapter: "第一章·第一节·共同语",
        knowledgePoints: ["现代汉民族共同语"],
        page: 2,
        confidence: 0.96,
      }],
    }],
  }, {
    projectId: "gd-zsb-2026-hywxxkjc",
    kind: "official_mock",
    year: 2026,
  });

  assert.equal(recognized.metadata.title, "2026 年模拟卷");
  assert.equal(recognized.questions[0].type, "single_choice");
  assert.equal(recognized.questions[0].subjectId, "modern-chinese");
  assert.equal(recognized.questions[0].bookId, "modern-chinese-7-1");
  assert.equal(recognized.questions[0].referenceAnswer, "A");
  assert.equal(recognized.questions[0].answerVariants.ai, "A");
  assert.equal(recognized.questions[0].answerSource, "ai_supplement");
  assert.equal(recognized.questions[0].answerVerified, false);
  assert.equal(recognized.questions[0].options.length, 2);

  const store = createMemoryExamImportStore();
  const draft = store.create({ ...recognized, source: { fileName: "mock.pdf", pageCount: 3, textChars: 2000 } });
  assert.equal(draft.status, "needs_review");
  assert.equal(draft.questions.length, 1);
  assert.equal(store.list()[0].questionCount, 1);
  const updated = store.update(draft.id, { questions: [{ ...draft.questions[0], included: false }] });
  assert.equal(updated.questions[0].included, false);
  const confirmed = store.confirm(draft.id, "exam-1");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.examId, "exam-1");
  assert.throws(() => store.update(draft.id, {}), /exam_import_already_confirmed/);
});

test("exam PDF page text is bounded and keeps page markers", () => {
  const text = examPagesForModel(["第一页题目", "第二页答案"], 1000);
  assert.match(text, /第 1 页/);
  assert.match(text, /第一页题目/);
  assert.match(text, /第 2 页/);
});

test("unconfirmed recognition drafts can be deleted", () => {
  const store = createMemoryExamImportStore();
  const draft = store.create({
    metadata: { title: "待删除识别稿" },
    source: { fileName: "delete-me.pdf" },
    questions: [{ stem: "测试题" }],
  });
  const removed = store.remove(draft.id);
  assert.equal(removed.id, draft.id);
  assert.equal(store.get(draft.id), null);
  assert.equal(store.list().length, 0);
});

test("legacy material drafts separate shared material and subquestions", () => {
  const store = createMemoryExamImportStore();
  const draft = store.create({
    metadata: { title: "旧材料题识别稿" },
    source: { fileName: "legacy.pdf" },
    questions: [{
      localId: "legacy-material-1",
      number: "六",
      type: "material_analysis",
      stem: "材料一：共同材料甲。\n材料二：共同材料乙。\n请回答：\n（1）分析叠词的表达效果。\n（2）分析作品的艺术特色。",
      referenceAnswer: "（1）叠词形成回环效果。\n（2）语言清新自然。",
      maxScore: 10,
    }],
  });
  assert.equal(draft.questions.length, 2);
  assert.equal(draft.questions[0].material, "材料一：共同材料甲。\n材料二：共同材料乙。");
  assert.equal(draft.questions[0].stem, "分析叠词的表达效果。");
  assert.equal(draft.questions[1].stem, "分析作品的艺术特色。");
  assert.equal(draft.questions[0].materialGroupId, draft.questions[1].materialGroupId);
  assert.deepEqual(draft.questions.map((question) => question.subNumber), ["1", "2"]);
  assert.deepEqual(draft.questions.map((question) => question.referenceAnswer), ["叠词形成回环效果。", "语言清新自然。"]);
});

test("formal exam drafts can be deleted but published exams cannot", async (context) => {
  const examStore = createMemoryExamStore([]);
  const draft = examStore.create({ title: "待删除试卷", questionIds: ["demo-modern-chinese-001"], durationMinutes: 60 });
  const published = examStore.create({ title: "已发布试卷", questionIds: ["demo-modern-chinese-001"], durationMinutes: 60 });
  examStore.action(published.id, "publish");
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), examStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const deleted = await fetch(`${baseUrl}/api/admin/exams/${draft.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(examStore.get(draft.id), null);

  const rejected = await fetch(`${baseUrl}/api/admin/exams/${published.id}`, { method: "DELETE" });
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).error, "exam_delete_status_invalid");
  assert.equal(examStore.get(published.id).status, "published");
});

test("AI answer supplementation fills one draft question and rejects malformed output", async (context) => {
  const upstreamBodies = [];
  let transientAttempts = 0;
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      upstreamBodies.push(body);
      const malformed = body.includes("触发格式错误");
      const transientQuestion = body.includes("触发临时授权失败");
      const choiceQuestion = body.includes("现代汉语方言");
      const literalQuestion = body.includes("指出文中两处");
      if (transientQuestion && transientAttempts++ === 0) {
        response.writeHead(502, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "auth_unavailable: no auth available" } }));
        return;
      }
      const validContent = literalQuestion ? {
        correctAnswer: [],
        referenceAnswer: "第一处“赵盾弑其君”的“其”是第三人称代词，作定语；第二处“其我之谓矣”的“其”是语气副词，表示推测。",
        scoringPoints: [{ description: "分别指出两处‘其’的词性和用法", score: 4, textbookPage: "25-30", pageBasis: "confirmed_catalog", sourceNote: "《古代汉语》·《晋灵公不君》" }],
        chapter: "《晋灵公不君》",
        knowledgePoints: ["其的词性和用法"],
        uncertainty: "",
      } : choiceQuestion ? {
        correctAnswer: ["B"],
        referenceAnswer: "现代汉语方言差异中，语音差异最为突出。",
        scoringPoints: [{
          description: "判断依据",
          score: 1,
          textbookPage: "3-5",
          pageBasis: "confirmed_catalog",
          sourceNote: "《现代汉语（增订七版）》上册 · 三、现代汉语方言",
        }],
        chapter: "第一章·绪论·三、现代汉语方言",
        knowledgePoints: ["现代汉语方言"],
        uncertainty: "",
      } : {
        correctAnswer: [],
        referenceAnswer: "李白诗歌善用夸张想象，体现豪放飘逸的风格与独立人格。",
        scoringPoints: [
          { description: "指出豪放飘逸的风格", score: 2, textbookPage: "8-9", pageBasis: "textbook_text", sourceNote: "中国古代文学 · 李白" },
          { description: "说明夸张想象与独立人格", score: 2, textbookPage: "8-9", pageBasis: "textbook_text", sourceNote: "中国古代文学 · 李白" },
        ],
        chapter: "第三编·盛唐文学·李白",
        knowledgePoints: ["李白诗歌风格"],
        sourcePage: "8",
        uncertainty: "需结合教材表述复核",
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "answer-model",
        choices: [{ message: { content: malformed ? "不是 JSON" : JSON.stringify(validContent) } }],
        usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const provider = {
    id: "answer-provider",
    name: "答案模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["answer-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: {
      exam_answer_supplement: { mode: "provider", providerId: provider.id, model: "answer-model", temperature: 0.2, maxTokens: 1200 },
    },
  });
  const examImportStore = createMemoryExamImportStore();
  const draft = examImportStore.create({
    metadata: { title: "答案补充测试" },
    source: { fileName: "answer.pdf" },
    questions: [
      { localId: "answer-ok", number: "1", type: "short_answer", subjectId: "ancient-literature", bookId: "ancient-literature-2-1", stem: "概括李白诗歌的艺术风格。", maxScore: 4, sourcePage: "1" },
      { localId: "answer-bad", number: "2", type: "short_answer", subjectId: "ancient-literature", bookId: "ancient-literature-2-1", stem: "触发格式错误", maxScore: 4 },
      { localId: "answer-retry", number: "2-1", type: "short_answer", subjectId: "ancient-literature", bookId: "ancient-literature-2-1", stem: "触发临时授权失败：概括李白诗歌的艺术风格。", maxScore: 4 },
      { localId: "answer-choice", number: "3", type: "single_choice", subjectId: "modern-chinese", bookId: "modern-chinese-7-1", stem: "现代汉语方言差异最大体现在哪一方面？", options: [{ key: "A", text: "词汇" }, { key: "B", text: "语音" }], maxScore: 2, sourcePage: "1" },
      { localId: "answer-literal", number: "4", type: "short_answer", subjectId: "ancient-chinese", bookId: "classical-chinese-1", stem: "指出文中两处“其”的词性和用法。", material: "太史书曰：‘赵盾弑其君。’宣子曰：‘其我之谓矣！’", maxScore: 4, sourcePage: "2", warnings: ["AI 补充不确定项：旧的错误结论", "原卷分值待核对"] },
      { localId: "answer-marked", number: "5", type: "material_analysis", subjectId: "modern-chinese", bookId: "modern-chinese-7-2", stem: "分析材料中下划线句子的语法结构。", material: "需要分析的句子。另一处波浪线句子。", materialMarks: [{ type: "underline", text: "需要分析的句子。" }, { type: "wave", text: "另一处波浪线句子。" }], maxScore: 4, sourcePage: "3" },
    ],
  });
  const aiTaskStore = createMemoryAiTaskStore();
  const server = createServer({ aiConfigStore, examImportStore, aiTaskStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const generatedResponse = await fetch(`${baseUrl}/api/admin/exams/imports/${draft.id}/questions/answer-ok/supplement-answer`, { method: "POST" });
  const generated = await generatedResponse.json();
  assert.equal(generatedResponse.status, 200);
  const supplemented = generated.draft.questions.find((question) => question.localId === "answer-ok");
  assert.equal(supplemented.answerSource, "ai_supplement");
  assert.equal(supplemented.answerReviewStatus, "unreviewed");
  assert.equal(supplemented.answerVerified, false);
  assert.match(supplemented.answerVariants.ai, /豪放飘逸/);
  assert.equal(supplemented.scoringPoints.reduce((total, point) => total + point.score, 0), 4);
  assert.equal(supplemented.scoringPoints[0].textbookPage, "");
  assert.equal(supplemented.scoringPoints[0].pageBasis, "");
  assert.equal(supplemented.scoringPoints[0].sourceNote, "");
  assert.equal(supplemented.warnings.includes("未检索到足够的教材正文直接证据，得分点教材页码已留空"), true);
  assert.equal(supplemented.sourcePage, "1");
  assert.match(supplemented.referenceAnswer, /豪放飘逸/);

  const retriedResponse = await fetch(`${baseUrl}/api/admin/exams/imports/${draft.id}/questions/answer-retry/supplement-answer`, { method: "POST" });
  const retriedPayload = await retriedResponse.json();
  assert.equal(retriedResponse.status, 200);
  assert.equal(retriedPayload.retryCount, 1);
  assert.equal(transientAttempts, 2);
  assert.match(retriedPayload.draft.questions.find((question) => question.localId === "answer-retry").referenceAnswer, /豪放飘逸/);
  const retryTask = aiTaskStore.list({ sceneId: "exam_answer_supplement" })[0];
  assert.equal(retryTask.status, "succeeded");
  assert.equal(retryTask.inputSummary.retryCount, 1);
  assert.equal(retryTask.inputSummary.recoveredFromTransientFailure, true);
  assert.equal(retryTask.inputSummary.finalModel, "answer-model");

  const metadataResponse = await fetch(`${baseUrl}/api/admin/exams/imports/${draft.id}/questions/answer-ok/supplement-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers: false, metadata: true }),
  });
  const metadataPayload = await metadataResponse.json();
  const enriched = metadataPayload.draft.questions.find((question) => question.localId === "answer-ok");
  assert.equal(metadataResponse.status, 200);
  assert.equal(enriched.chapter, "");
  assert.equal(enriched.warnings.includes("AI 返回的章节不属于当前教材，系统未采纳该章节及其目录页码"), true);
  assert.deepEqual(enriched.knowledgePoints, ["李白诗歌风格"]);
  assert.equal(enriched.sourcePage, "1");

  const choiceResponse = await fetch(`${baseUrl}/api/admin/exams/imports/${draft.id}/questions/answer-choice/supplement-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers: true, metadata: true }),
  });
  const choicePayload = await choiceResponse.json();
  const choice = choicePayload.draft.questions.find((question) => question.localId === "answer-choice");
  assert.equal(choiceResponse.status, 200);
  assert.deepEqual(choice.correctAnswer, ["B"]);
  assert.equal(choice.scoringPoints.length, 1);
  assert.equal(choice.scoringPoints[0].score, 2);
  assert.equal(choice.scoringPoints[0].description, "选择 B（语音）");
  assert.equal(choice.scoringPoints[0].textbookPage, "");
  assert.equal(choice.sourcePage, "1");

  const literalResponse = await fetch(`${baseUrl}/api/admin/exams/imports/${draft.id}/questions/answer-literal/supplement-answer`, { method: "POST" });
  const literalPayload = await literalResponse.json();
  assert.equal(literalResponse.status, 200);
  const literal = literalPayload.draft.questions.find((question) => question.localId === "answer-literal");
  assert.match(literal.answerVariants.ai, /赵盾弑其君/);
  assert.match(literal.answerVariants.ai, /其我之谓矣/);
  assert.equal(literal.warnings.some((warning) => warning.includes("旧的错误结论")), false);
  assert.equal(literal.warnings.includes("原卷分值待核对"), true);
  const literalRequest = upstreamBodies.find((body) => body.includes("指出文中两处"));
  const literalPrompt = JSON.parse(literalRequest).messages.map((message) => message.content).join("\n");
  assert.match(literalPrompt, /literalEvidence/);
  assert.match(literalPrompt, /"actualCount": 2/);
  assert.match(literalPrompt, /赵盾弑其君/);
  assert.match(literalPrompt, /其我之谓矣/);

  const markedResponse = await fetch(`${baseUrl}/api/admin/exams/imports/${draft.id}/questions/answer-marked/supplement-answer`, { method: "POST" });
  assert.equal(markedResponse.status, 200);
  const markedRequest = upstreamBodies.find((body) => body.includes("分析材料中下划线句子"));
  const markedPrompt = JSON.parse(markedRequest).messages.map((message) => message.content).join("\n");
  assert.match(markedPrompt, /【下划线开始】需要分析的句子。【下划线结束】/);
  assert.doesNotMatch(markedPrompt, /【波浪线开始】/);

  const malformedResponse = await fetch(`${baseUrl}/api/admin/exams/imports/${draft.id}/questions/answer-bad/supplement-answer`, { method: "POST" });
  assert.equal(malformedResponse.status, 422);
  assert.equal(examImportStore.get(draft.id).questions.find((question) => question.localId === "answer-bad").referenceAnswer, "");
});

test("admin can delete an unconfirmed recognition draft", async (context) => {
  const examImportStore = createMemoryExamImportStore();
  const draft = examImportStore.create({ metadata: { title: "接口删除稿" }, source: { fileName: "draft.pdf" }, questions: [{ stem: "测试题" }] });
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), examImportStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/exams/imports/${draft.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal(examImportStore.get(draft.id), null);
});

test("an exam import can become a draft with doubtful AI answers", async (context) => {
  const examImportStore = createMemoryExamImportStore();
  const questionStore = createMemoryQuestionStore([]);
  const examStore = createMemoryExamStore([]);
  const draft = examImportStore.create({
    metadata: { title: "待复核答案试卷", durationMinutes: 60 },
    source: { fileName: "review.pdf" },
    questions: [{
      localId: "review-question",
      number: "1",
      subjectId: "modern-chinese",
      bookId: "modern-chinese-7-1",
      chapter: "第一章 绪论",
      knowledgePoints: ["现代汉语定义"],
      type: "single_choice",
      stem: "现代汉语是什么？",
      options: [{ key: "A", text: "现代汉民族共同语" }, { key: "B", text: "古代汉语" }],
      correctAnswer: ["A"],
      referenceAnswer: "现代汉语是现代汉民族共同语。",
      maxScore: 2,
      answerSource: "ai_supplement",
      answerReviewStatus: "doubtful",
    }],
  });
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), examImportStore, questionStore, examStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/exams/imports/${draft.id}/confirm`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.exam.status, "draft");
  assert.equal(payload.exam.origin, "manual");
  const imported = questionStore.get(payload.exam.questionIds[0]);
  assert.equal(imported.status, "pending_review");
  assert.equal(imported.answerReviewStatus, "doubtful");
});

test("exam PDF endpoint accepts direct PDF bodies without Base64 expansion", async (context) => {
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const pdf = fs.readFileSync(path.resolve(__dirname, "../node_modules/pdf-parse/test/data/01-valid.pdf"));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/exams/import-pdf?fileName=direct.pdf&kind=past_paper&year=2025`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: pdf,
  });
  const payload = await response.json();
  assert.notEqual(response.status, 413);
  assert.notEqual(payload.error, "exam_pdf_invalid");
  assert.notEqual(payload.error, "payload_too_large");
});

test("multipart import accepts a Word paper with a separate PDF answer", async (context) => {
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const isAnswer = body.includes("答案文件片段");
      const content = isAnswer ? {
        exam: { title: "答案文件" },
        questions: [{ number: "1", correctAnswer: ["A"], referenceAnswer: "A. 普通话", answerSource: "pdf_answer", scoringPoints: [{ description: "选择普通话", score: 2 }] }],
        warnings: [],
      } : {
        exam: { title: "混合格式模拟卷", durationMinutes: 90, totalQuestionCount: 1 },
        questions: [{ number: "1", type: "single_choice", subjectId: "modern-chinese", bookId: "modern-chinese-7-1", stem: "现代汉民族共同语是？", options: [{ key: "A", text: "普通话" }, { key: "B", text: "粤语" }], correctAnswer: [], referenceAnswer: "", answerSource: "missing", maxScore: 2, sourcePage: "1" }],
        warnings: [],
      };
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.write(`data: ${JSON.stringify({ model: "exam-model", choices: [{ delta: { content: JSON.stringify(content) } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const provider = {
    id: "exam-provider",
    name: "试卷识别模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["exam-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: { exam_paper_extraction: { mode: "provider", providerId: provider.id, model: "exam-model", temperature: 0.1, maxTokens: 2000 } },
  });
  const examImportStore = createMemoryExamImportStore();
  const server = createServer({ aiConfigStore, examImportStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const paper = await createDocxBuffer([
    "2026 年汉语言文学学科基础模拟试卷",
    "一、单项选择题（每题 2 分）",
    "1. 现代汉民族共同语是？A. 普通话 B. 粤语。请从两个选项中选择正确答案，并在答题区域填写对应字母。",
  ]);
  const answer = fs.readFileSync(path.resolve(__dirname, "../node_modules/pdf-parse/test/data/01-valid.pdf"));
  const form = new FormData();
  form.append("paper", new Blob([paper], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "综合试卷.docx");
  form.append("answer", new Blob([answer], { type: "application/pdf" }), "参考答案.pdf");
  form.append("kind", "official_mock");
  form.append("year", "2026");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/exams/import-files`, { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.draft.source.format, "docx");
  assert.equal(payload.draft.source.answerFormat, "pdf");
  assert.equal(payload.draft.source.answerFileName, "参考答案.pdf");
  assert.equal(payload.draft.source.answerMatchedCount, 0);
  assert.equal(payload.draft.questions.length, 1);
  assert.equal(payload.draft.questions[0].referenceAnswer, "");
  assert.equal(payload.draft.questions[0].answerSource, "missing");
  assert.match(payload.draft.questions[0].warnings.join(" "), /AI 仅用于匹配/);
  assert.equal(payload.draft.questions[0].answerReviewStatus, "unreviewed");
  assert.equal(payload.draft.questions[0].answerVerified, false);

  const deleted = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/exams/imports/${payload.draft.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
});

test("background exam import returns immediately, reports progress and retries malformed model output", async (context) => {
  let upstreamCalls = 0;
  let activeUpstreamCalls = 0;
  let maxActiveUpstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      upstreamCalls += 1;
      activeUpstreamCalls += 1;
      maxActiveUpstreamCalls = Math.max(maxActiveUpstreamCalls, activeUpstreamCalls);
      const content = upstreamCalls === 1 ? "{not valid json" : JSON.stringify({
        exam: { title: "后台识别模拟卷", durationMinutes: 90, totalQuestionCount: 1 },
        questions: [{
          number: "1",
          type: "single_choice",
          subjectId: "modern-chinese",
          bookId: "modern-chinese-7-1",
          stem: "现代汉民族共同语是？",
          options: [{ key: "A", text: "普通话" }, { key: "B", text: "粤语" }],
          correctAnswer: ["A"],
          referenceAnswer: "A. 普通话",
          answerSource: "pdf_answer",
          maxScore: 2,
          sourcePage: "1",
        }],
        warnings: [],
      });
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        response.write(`data: ${JSON.stringify({ model: "exam-model", choices: [{ delta: { content } }] })}\n\n`);
        response.end("data: [DONE]\n\n", () => { activeUpstreamCalls -= 1; });
      }, 25);
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const provider = {
    id: "exam-provider",
    name: "试卷识别模型",
    protocol: "openai_chat_completions",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: "test-key",
    models: ["exam-model"],
    timeoutMs: 5000,
    supportsJsonMode: true,
    enabled: true,
  };
  const aiConfigStore = createMemoryAiConfigStore({
    providers: [provider],
    routes: { exam_paper_extraction: { mode: "provider", providerId: provider.id, model: "exam-model", temperature: 0.1, maxTokens: 2000 } },
  });
  const aiTaskStore = createMemoryAiTaskStore();
  const examImportStore = createMemoryExamImportStore();
  const examJobRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "shukao-exam-jobs-"));
  context.after(() => fs.rmSync(examJobRoot, { recursive: true, force: true }));
  const server = createServer({ aiConfigStore, aiTaskStore, examImportStore, examJobRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const paper = await createDocxBuffer([
    "2026 年汉语言文学学科基础模拟试卷",
    "一、单项选择题（每题 2 分）",
    "1. 现代汉民族共同语是？A. 普通话 B. 粤语。请从两个选项中选择正确答案，并在答题区域填写对应字母。",
  ]);
  const form = new FormData();
  form.append("paper", new Blob([paper], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "后台识别.docx");
  form.append("kind", "official_mock");
  form.append("year", "2026");
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/admin/exams/import-jobs`, { method: "POST", body: form });
  const accepted = await response.json();
  assert.equal(response.status, 202);
  assert.equal(accepted.job.status, "running");
  assert.ok(Date.now() - startedAt < 1000);

  const secondForm = new FormData();
  secondForm.append("paper", new Blob([paper], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "后台识别二.docx");
  secondForm.append("kind", "official_mock");
  secondForm.append("year", "2026");
  const secondResponse = await fetch(`${baseUrl}/api/admin/exams/import-jobs`, { method: "POST", body: secondForm });
  const secondAccepted = await secondResponse.json();
  assert.equal(secondResponse.status, 202);
  assert.equal(secondAccepted.job.inputSummary.stage, "queued");

  let finalJob = accepted.job;
  let secondFinalJob = secondAccepted.job;
  const observedStages = new Set([finalJob.inputSummary.stage]);
  for (let attempt = 0; attempt < 150 && (finalJob.status === "running" || secondFinalJob.status === "running"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const jobsResponse = await fetch(`${baseUrl}/api/admin/exams/import-jobs`);
    const jobsPayload = await jobsResponse.json();
    finalJob = jobsPayload.jobs.find((job) => job.id === accepted.job.id);
    secondFinalJob = jobsPayload.jobs.find((job) => job.id === secondAccepted.job.id);
    observedStages.add(finalJob.inputSummary.stage);
  }
  assert.equal(finalJob.status, "succeeded", JSON.stringify(finalJob));
  assert.equal(secondFinalJob.status, "succeeded", JSON.stringify(secondFinalJob));
  assert.equal(finalJob.inputSummary.percent, 100);
  assert.ok(finalJob.inputSummary.retryCount >= 1);
  assert.ok(upstreamCalls >= 3);
  assert.equal(maxActiveUpstreamCalls, 1);
  assert.ok(observedStages.has("recognizing_paper") || observedStages.has("completed"));
  assert.equal(examImportStore.list().length, 2);
  assert.equal(examImportStore.list()[0].metadata.title, "后台识别模拟卷");
});

test("invalid model output cannot become an empty exam draft", () => {
  assert.throws(() => normalizeExamModelOutput({ exam: { title: "空结果" }, questions: [] }), /provider_output_format_error/);
});

test("overlapping PDF chunks merge cross-page question details by number", () => {
  const merged = mergeExamRecognitions([
    { metadata: { title: "综合卷" }, warnings: [], questions: [{ number: "5", stem: "下列汉字属于形声字的是", options: [], correctAnswer: [], knowledgePoints: [], warnings: [] }] },
    { metadata: { title: "综合卷" }, warnings: [], questions: [{ number: "5", stem: "下列汉字属于形声字的是（ ）", options: [{ key: "A", text: "河" }, { key: "B", text: "本" }], correctAnswer: ["A"], knowledgePoints: ["六书"], warnings: [] }] },
  ]);
  assert.equal(merged.questions.length, 1);
  assert.equal(merged.questions[0].options.length, 2);
  assert.deepEqual(merged.questions[0].correctAnswer, ["A"]);
});

test("overlapping recognition keeps material subquestions separate by number and subNumber", () => {
  const merged = mergeExamRecognitions([
    { metadata: { title: "材料卷" }, warnings: [], questions: [
      { number: "六", subNumber: "1", type: "material_analysis", materialGroupId: "material-6", material: "共同材料", stem: "分析第一问。", options: [], correctAnswer: [], knowledgePoints: [], warnings: [] },
      { number: "六", subNumber: "2", type: "material_analysis", materialGroupId: "material-6", material: "共同材料", stem: "分析第二问。", options: [], correctAnswer: [], knowledgePoints: [], warnings: [] },
    ] },
    { metadata: { title: "材料卷" }, warnings: [], questions: [
      { number: "六", subNumber: "1", type: "material_analysis", materialGroupId: "material-6", material: "共同材料全文", stem: "分析第一问的作用。", options: [], correctAnswer: [], knowledgePoints: ["第一问知识点"], warnings: [] },
    ] },
  ]);
  assert.equal(merged.questions.length, 2);
  assert.deepEqual(merged.questions.map((question) => question.subNumber), ["1", "2"]);
  assert.match(merged.questions[0].stem, /作用/);
  assert.deepEqual(merged.questions[0].knowledgePoints, ["第一问知识点"]);
});

test("a separate answer file only enriches matching paper questions", () => {
  const paper = {
    metadata: { title: "试卷" },
    warnings: [],
    questions: [
      { number: "1", subNumber: "", stem: "第一题", correctAnswer: [], referenceAnswer: "", scoringPoints: [], warnings: [] },
      { number: "六", subNumber: "1", stem: "材料第一问", correctAnswer: [], referenceAnswer: "", scoringPoints: [], warnings: [] },
      { number: "六", subNumber: "2", stem: "材料第二问", correctAnswer: [], referenceAnswer: "", scoringPoints: [], warnings: [] },
    ],
  };
  const merged = mergeAnswerRecognitions(paper, [{ warnings: [], questions: [
    { number: "1", correctAnswer: ["A"], referenceAnswer: "A", scoringPoints: [] },
    { number: "六", subNumber: "2", correctAnswer: [], referenceAnswer: "第二问答案", scoringPoints: [{ description: "答出要点", score: 2 }] },
    { number: "99", correctAnswer: ["B"], referenceAnswer: "答案文件多出的题目", scoringPoints: [] },
  ] }]);

  assert.equal(merged.recognition.questions.length, 3);
  assert.equal(merged.matchedCount, 2);
  assert.equal(merged.unmatchedCount, 1);
  assert.deepEqual(merged.recognition.questions[0].correctAnswer, ["A"]);
  assert.equal(merged.recognition.questions[1].referenceAnswer, "");
  assert.equal(merged.recognition.questions[2].referenceAnswer, "第二问答案");
  assert.equal(merged.recognition.questions[2].answerSource, "pdf_answer");
  assert.equal(merged.recognition.questions[2].answerReviewStatus, "unreviewed");
  assert.equal(merged.recognition.questions[2].answerVerified, false);
  assert.match(merged.recognition.warnings.join(" "), /1 项未匹配/);
});

test("official answers are restored verbatim from numbered source blocks without page furniture", () => {
  const blocks = extractVerbatimAnswerBlocks([{ text: [
    "43. ‘汤沈之争’可概括如下：",
    "（1）戏曲观念的转变。保留完整例证。",
    "（2）戏曲理论的完善。保留完整论述。",
    "第 4 页，共 9 页",
    "更多汉语言插本文学资讯，请关注公众号：汉化土豆",
    "（3）戏曲创作对理想境界的追求。保留结论。",
    "44. 《聊斋志异》答案原文。",
  ].join("\n") }]);
  const mainBlocks = blocks.filter((block) => !block.subNumber);
  assert.equal(mainBlocks.length, 2);
  assert.match(mainBlocks[0].text, /保留完整例证/);
  assert.match(mainBlocks[0].text, /保留结论/);
  assert.doesNotMatch(mainBlocks[0].text, /第 4 页|公众号/);

  const paper = {
    questions: [{
      number: "43",
      subNumber: "",
      referenceAnswer: "汤沈之争推动戏曲观念转变、戏曲理论完善，并影响戏曲创作。",
      answerVariants: { official: "汤沈之争推动戏曲观念转变、戏曲理论完善，并影响戏曲创作。", ai: "AI 候选答案", community: "" },
      answerSource: "pdf_answer",
      warnings: [],
    }],
  };
  const recovered = applyVerbatimAnswerBlocks(paper, blocks);
  assert.equal(recovered.recoveredCount, 1);
  assert.equal(recovered.recognition.questions[0].referenceAnswer, mainBlocks[0].text);
  assert.equal(recovered.recognition.questions[0].answerVariants.official, mainBlocks[0].text);
  assert.equal(recovered.recognition.questions[0].answerVariants.ai, "AI 候选答案");
  assert.match(recovered.recognition.questions[0].warnings[0], /原文恢复/);
});

test("unnumbered objective answers are restored by section and original order", () => {
  const pages = [{ text: [
    "一、单项选择题（本大题共2小题）",
    "",
    "B【精析】第一题的完整解析。",
    "",
    "A【精析】第二题的完整解析。",
    "",
    "二、双项选择题（本大题共2小题）",
    "",
    "AC【精析】第三题的完整解析。",
    "",
    "BD【精析】第四题的完整解析。",
    "",
    "三、名句默写题（本大题共1小题）",
    "5. 明月松间照。",
  ].join("\n") }];
  const sections = extractSequentialObjectiveAnswerSections(pages);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((section) => section.entries.length), [2, 2]);

  const paper = { questions: [
    { number: "1", type: "single_choice", correctAnswer: [], referenceAnswer: "", answerVariants: { official: "", ai: "", community: "" }, answerSource: "missing", warnings: [] },
    { number: "2", type: "single_choice", correctAnswer: [], referenceAnswer: "", answerVariants: { official: "", ai: "", community: "" }, answerSource: "missing", warnings: [] },
    { number: "3", type: "multiple_choice", correctAnswer: [], referenceAnswer: "", answerVariants: { official: "", ai: "", community: "" }, answerSource: "missing", warnings: [] },
    { number: "4", type: "multiple_choice", correctAnswer: [], referenceAnswer: "", answerVariants: { official: "", ai: "", community: "" }, answerSource: "missing", warnings: [] },
    { number: "5", type: "fill_blank", correctAnswer: [], referenceAnswer: "", answerVariants: { official: "", ai: "", community: "" }, answerSource: "missing", warnings: [] },
  ] };
  const recovered = applySequentialObjectiveAnswerSections(paper, pages);
  assert.equal(recovered.recoveredCount, 4);
  assert.deepEqual(recovered.recognition.questions[0].correctAnswer, ["B"]);
  assert.deepEqual(recovered.recognition.questions[2].correctAnswer, ["A", "C"]);
  assert.match(recovered.recognition.questions[0].answerVariants.official, /完整解析/);
  assert.equal(recovered.recognition.questions[3].answerSource, "pdf_answer");
  assert.equal(recovered.recognition.questions[4].answerSource, "missing");
});

test("ordered objective answers keep their positions when only some answers are missing", () => {
  const pages = [{ text: [
    "一、单项选择题（本大题共3小题）",
    "",
    "1.A【精析】第一题。",
    "",
    "2.B【精析】第二题。",
    "",
    "3.C【精析】第三题。",
  ].join("\n") }];
  const paper = { questions: [
    { number: "1", type: "single_choice", options: [{ key: "A", text: "甲" }], correctAnswer: ["A"], referenceAnswer: "第一题已有答案", answerVariants: { official: "第一题已有答案" }, answerSource: "pdf_answer", warnings: [] },
    { number: "2", type: "single_choice", options: [{ key: "B", text: "乙" }], correctAnswer: [], referenceAnswer: "", answerVariants: { official: "" }, answerSource: "missing", warnings: [] },
    { number: "3", type: "single_choice", options: [{ key: "C", text: "丙" }], correctAnswer: ["C"], referenceAnswer: "第三题已有答案", answerVariants: { official: "第三题已有答案" }, answerSource: "pdf_answer", warnings: [] },
  ] };
  const recovered = applySequentialObjectiveAnswerSections(paper, pages);
  assert.equal(recovered.recoveredCount, 1);
  assert.match(recovered.recognition.questions[1].answerVariants.official, /第二题/);
});

test("a duplicated printed number does not shift later objective answers", () => {
  const pages = [{ text: [
    "一、单项选择题（本大题共3小题）",
    "",
    "1.A【精析】甲答案。",
    "",
    "1.D【精析】无关的额外答案。",
    "",
    "2.B【精析】乙答案。",
    "",
    "3.C【精析】丙答案。",
  ].join("\n") }];
  const paper = { questions: [
    { number: "1", type: "single_choice", stem: "选择甲", options: [{ key: "A", text: "甲" }], correctAnswer: ["A"], referenceAnswer: "", answerVariants: { official: "" }, answerSource: "missing", warnings: [] },
    { number: "2", type: "single_choice", stem: "选择乙", options: [{ key: "B", text: "乙" }], correctAnswer: ["B"], referenceAnswer: "", answerVariants: { official: "" }, answerSource: "missing", warnings: [] },
    { number: "3", type: "single_choice", stem: "选择丙", options: [{ key: "C", text: "丙" }], correctAnswer: ["C"], referenceAnswer: "", answerVariants: { official: "" }, answerSource: "missing", warnings: [] },
  ] };
  const recovered = applySequentialObjectiveAnswerSections(paper, pages);
  assert.equal(recovered.recoveredCount, 3);
  assert.match(recovered.recognition.questions[1].answerVariants.official, /乙答案/);
  assert.match(recovered.recognition.questions[2].answerVariants.official, /丙答案/);
  assert.doesNotMatch(recovered.recognition.questions[0].answerVariants.official, /额外/);
});

test("a unique numbered answer can be restored by its repeated question stem", () => {
  const blocks = extractVerbatimAnswerBlocks([{ text: [
    "44. 《诗经》的艺术特征",
    "（1）写实与诗言志。保留完整论述。",
    "（2）赋、比、兴。保留完整例证。",
  ].join("\n") }]);
  const paper = { questions: [{
    number: "44",
    subNumber: "",
    type: "short_answer",
    stem: "《诗经》的艺术特征",
    referenceAnswer: "",
    answerVariants: { official: "", ai: "", community: "" },
    answerSource: "missing",
    warnings: [],
  }] };
  const recovered = applyVerbatimAnswerBlocks(paper, blocks);
  assert.equal(recovered.recoveredCount, 1);
  assert.match(recovered.recognition.questions[0].answerVariants.official, /完整例证/);
});

test("one located subquestion stem can recover its following answer block", () => {
  const stem = "请结合《李有才板话》分析赵树理的艺术特点。";
  const blocks = extractVerbatimAnswerBlocks([{ text: [
    "50.（1）第一问答案原文。",
    `2．${stem}`,
    "第二问完整答案与具体例证。",
  ].join("\n") }]);
  const paper = { questions: [
    { number: "50", subNumber: "1", type: "appreciation", stem: "分析李有才形象。", referenceAnswer: "第一问答案原文。", answerVariants: { official: "第一问答案原文。" }, answerSource: "pdf_answer", warnings: [] },
    { number: "50", subNumber: "2", type: "appreciation", stem, referenceAnswer: "", answerVariants: { official: "" }, answerSource: "missing", warnings: [] },
  ] };
  const recovered = applyVerbatimAnswerBlocks(paper, blocks);
  assert.equal(recovered.recoveredCount, 1);
  assert.match(recovered.recognition.questions[1].answerVariants.official, /具体例证/);
});

test("verbatim answer blocks preserve material-question subanswers and implicit first subanswer", () => {
  const blocks = extractVerbatimAnswerBlocks([{ text: [
    "47.（1）名词作状语的作用。狐鸣表示比喻，兄事表示对人的态度。",
    "（2）东、西、水等名词活用作动词。",
    "（3）可根据代词、副词和能愿动词的位置进行鉴别。",
    "48.第一问答案没有显式小题号。",
    "（2）第二问分析购买的构词方式。",
  ].join("\n") }]);

  assert.equal(blocks.find((block) => block.number === "47" && block.subNumber === "1").text,
    "名词作状语的作用。狐鸣表示比喻，兄事表示对人的态度。");
  assert.equal(blocks.find((block) => block.number === "47" && block.subNumber === "2").text,
    "东、西、水等名词活用作动词。");
  assert.equal(blocks.find((block) => block.number === "48" && block.subNumber === "1").text,
    "第一问答案没有显式小题号。");

  const paper = { questions: [{
    number: "47",
    subNumber: "（1）",
    referenceAnswer: "名词作状语可表示比喻和处所。",
    answerVariants: { official: "名词作状语可表示比喻和处所。", ai: "AI 候选答案", community: "" },
    answerSource: "pdf_answer",
    warnings: [],
  }] };
  const recovered = applyVerbatimAnswerBlocks(paper, blocks);
  assert.equal(recovered.matchedCount, 1);
  assert.equal(recovered.recoveredCount, 1);
  assert.match(recovered.recognition.questions[0].referenceAnswer, /狐鸣表示比喻/);
  assert.equal(recovered.recognition.questions[0].answerVariants.ai, "AI 候选答案");
});

test("repeated question stems split answer subquestions when later subquestion numbers are missing", () => {
  const firstStem = "请分析福贵这一人物形象的特点，并结合节选片段举例说明。";
  const secondStem = "余华在《活着》中展现了普通人生活的苦难，请分析其创作特点。";
  const blocks = extractVerbatimAnswerBlocks([{ text: [
    `50.（1）${firstStem}`,
    "福贵坚韧、乐观，经历苦难后依然坚持生活。",
    secondStem,
    "余华采用冷静客观的叙述风格，书写苦难中的生命力量。",
  ].join("\n") }]);
  const paper = { questions: [
    {
      number: "50", subNumber: "（1）", stem: firstStem,
      referenceAnswer: "福贵坚韧、乐观。",
      answerVariants: { official: "福贵坚韧、乐观。", ai: "", community: "" },
      answerSource: "pdf_answer", warnings: [],
    },
    {
      number: "50", subNumber: "（2）", stem: secondStem,
      referenceAnswer: "余华采用冷静客观的叙述风格。",
      answerVariants: { official: "余华采用冷静客观的叙述风格。", ai: "", community: "" },
      answerSource: "pdf_answer", warnings: [],
    },
  ] };

  const recovered = applyVerbatimAnswerBlocks(paper, blocks);
  assert.equal(recovered.recoveredCount, 2);
  assert.match(recovered.recognition.questions[0].referenceAnswer, /经历苦难后依然坚持生活/);
  assert.doesNotMatch(recovered.recognition.questions[0].referenceAnswer, /创作特点/);
  assert.match(recovered.recognition.questions[1].referenceAnswer, /生命力量/);
});

test("AI answer matching cannot overwrite an official answer when verbatim mode is enabled", () => {
  const paper = { metadata: { title: "试卷" }, warnings: [], questions: [{
    number: "47",
    subNumber: "1",
    stem: "分析名词作状语的作用。",
    correctAnswer: [],
    referenceAnswer: "原文件中的完整答案与例证。",
    answerVariants: { official: "原文件中的完整答案与例证。", ai: "", community: "" },
    answerSource: "pdf_answer",
    scoringPoints: [],
    warnings: [],
  }] };
  const merged = mergeAnswerRecognitions(paper, [{ warnings: [], questions: [{
    number: "47",
    subNumber: "1",
    referenceAnswer: "AI 概括答案。",
    answerVariants: { official: "AI 概括答案。" },
    scoringPoints: [],
  }] }], { verbatimOfficialOnly: true });

  assert.equal(merged.recognition.questions[0].referenceAnswer, "原文件中的完整答案与例证。");
  assert.equal(merged.recognition.questions[0].answerVariants.official, "原文件中的完整答案与例证。");
  assert.match(merged.recognition.questions[0].warnings.join(" "), /AI 仅用于匹配/);
});

test("official answer reflow joins visual wraps but keeps numbered headings", () => {
  const answer = reflowVerbatimAnswerText([
    "（1）积淀深厚的现实主义传统与时代典型的创造",
    "茅盾的小说反映重大题材和时代特色，其创作",
    "广阔展示了30年代社会纷繁景象及其复杂变化，提高了小说反映广阔社会生",
    "活的可能性。",
    "（2）全方位地描摹社会现象。",
    "下一部分正文。",
  ].join("\n\n"));
  assert.match(answer, /（1）[^\n]+\n\n茅盾的小说[^\n]*其创作广阔展示/);
  assert.match(answer, /广阔社会生活的可能性。/);
  assert.match(answer, /\n\n（2）全方位地描摹社会现象。\n\n下一部分正文。/);
});

test("admin can recover shortened official answers from the saved answer document", async (context) => {
  const examImportStore = createMemoryExamImportStore();
  const draft = examImportStore.create({
    id: "exam-import-recover-answer-test",
    metadata: { title: "答案恢复测试卷" },
    source: { fileName: "试卷.docx", answerFileName: "答案.docx", answerFormat: "docx" },
    questions: [{
      number: "43",
      type: "short_answer",
      stem: "汤沈之争有何影响？",
      referenceAnswer: "汤沈之争推动戏曲观念和理论发展。",
      answerVariants: { official: "汤沈之争推动戏曲观念和理论发展。", ai: "AI 答案", community: "" },
      answerSource: "pdf_answer",
      maxScore: 10,
    }],
  });
  const examUploadRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "shukao-answer-recovery-"));
  context.after(() => fs.rmSync(examUploadRoot, { recursive: true, force: true }));
  const answer = await createDocxBuffer([
    "43. 汤沈之争推动戏曲观念的转变。",
    "（1）完整保留曲律与文采之争的具体例证。",
    "（2）完整保留戏曲理论完善的论述。",
    "（3）完整保留对后世戏曲创作影响的结论。",
  ]);
  fs.writeFileSync(path.join(examUploadRoot, `${draft.id}-answer.docx`), answer);
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), examImportStore, examUploadRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/exams/imports/${draft.id}/recover-official-answers`, { method: "POST", body: "{}" });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.recoveredCount, 1);
  assert.match(payload.draft.questions[0].answerVariants.official, /具体例证/);
  assert.match(payload.draft.questions[0].answerVariants.official, /后世戏曲创作/);
  assert.equal(payload.draft.questions[0].answerVariants.ai, "AI 答案");
});

test("exam import drafts retain separate paper and answer metadata without marking answers reviewed", () => {
  const store = createMemoryExamImportStore();
  const draft = store.create({
    metadata: { title: "Word 试卷与 PDF 答案" },
    source: {
      fileName: "试卷.docx",
      format: "docx",
      pageCount: 4,
      answerFileName: "答案.pdf",
      answerFormat: "pdf",
      answerPageCount: 2,
      answerMatchedCount: 1,
    },
    questions: [{ number: "1", stem: "第一题", referenceAnswer: "答案", answerSource: "pdf_answer", answerReviewStatus: "unreviewed", answerVerified: false }],
  });
  assert.equal(draft.source.format, "docx");
  assert.equal(draft.source.answerFormat, "pdf");
  assert.equal(draft.source.answerFileName, "答案.pdf");
  assert.equal(draft.source.answerMatchedCount, 1);
  assert.equal(draft.questions[0].answerReviewStatus, "unreviewed");
  assert.equal(draft.questions[0].answerVerified, false);
});

test("material subquestions keep shared material and independent scoring items", () => {
  const merged = mergeExamRecognitions([{
    metadata: { title: "综合卷", totalQuestionCount: 3 },
    warnings: [],
    questions: [
      { number: "1", type: "single_choice", stem: "第一题", warnings: [] },
      { number: "2", type: "material_analysis", sectionTitle: "（一）古文材料", stem: "共同材料。找出判断句。", maxScore: 2, warnings: [] },
      { number: "3", type: "material_analysis", sectionTitle: "（一）古文材料", stem: "共同材料。指出宾语前置句。", maxScore: 2, warnings: [] },
      { number: "4", type: "material_analysis", sectionTitle: "（二）现代汉语材料", stem: "另一材料。判断词性。", maxScore: 3, warnings: [] },
      { number: "5", type: "material_analysis", sectionTitle: "（二）现代汉语材料", stem: "另一材料。分析短语结构。", maxScore: 3, warnings: [] },
    ],
  }]);
  assert.equal(merged.questions.length, 5);
  assert.equal(merged.metadata.totalQuestionCount, 3);
  assert.equal(merged.metadata.totalResponseItemCount, 5);
  assert.deepEqual(merged.questions.map((question) => question.number), ["1", "2", "2", "3", "3"]);
  assert.equal(merged.questions[1].material, "共同材料。");
  assert.equal(merged.questions[2].material, "共同材料。");
  assert.equal(merged.questions[1].stem, "找出判断句。");
  assert.equal(merged.questions[2].stem, "指出宾语前置句。");
  assert.deepEqual(merged.questions.slice(1, 3).map((question) => question.subNumber), ["1", "2"]);
  assert.deepEqual(merged.questions.slice(1, 3).map((question) => question.maxScore), [2, 2]);
});

test("modern Chinese marking questions and material inheritance are preserved", () => {
  const recognized = normalizeExamModelOutput({
    questions: [{
      number: "1",
      subjectId: "现代汉语",
      type: "材料分析题",
      stem: "请用下划线标记句子的主语。",
      material: "小王认真完成了练习。",
      materialGroupId: "material-1",
      usesSharedMaterial: false,
      maxScore: 2,
    }],
  });
  assert.equal(recognized.questions[0].responseMode, "annotation");
  assert.equal(recognized.questions[0].usesSharedMaterial, false);
});

test("original material marks stay separate from the user's annotation response", () => {
  const recognized = normalizeExamModelOutput({
    questions: [{
      number: "48",
      subNumber: "2",
      subjectId: "现代汉语",
      type: "材料分析题",
      stem: "分析材料中双下划线复句的层次和关系。",
      material: "前句说明原因。这不仅造成审美疲劳，也引起社会关注。",
      materialMarks: [{ type: "双下划线", text: "前句说明原因。这不仅造成审美疲劳，也引起社会关注。" }],
      responseMode: "text",
      annotationText: "",
      maxScore: 2,
    }],
  });
  assert.equal(recognized.questions[0].responseMode, "text");
  assert.deepEqual(recognized.questions[0].materialMarks, [{
    type: "double_underline",
    text: "前句说明原因。这不仅造成审美疲劳，也引起社会关注。",
    occurrence: 1,
  }]);
});

test("a comprehensive exam keeps each question's own subject and textbook", async (context) => {
  const examImportStore = createMemoryExamImportStore();
  const questionStore = createMemoryQuestionStore([]);
  const examStore = createMemoryExamStore([]);
  const draft = examImportStore.create({
    metadata: { title: "汉语言文学学科基础综合卷", year: 2025, durationMinutes: 150, kind: "past_paper" },
    source: { fileName: "2025-comprehensive.pdf", pageCount: 10, textChars: 6856 },
    questions: [
      { subjectId: "modern-chinese", bookId: "modern-chinese-7-1", type: "single_choice", stem: "汉语方言中差异最大的是？", options: [{ key: "A", text: "词汇" }, { key: "B", text: "语音" }], correctAnswer: ["B"], referenceAnswer: "B", answerSource: "team_verified", maxScore: 2, chapter: "语音", knowledgePoints: ["方言差异"] },
      { subjectId: "ancient-literature", bookId: "ancient-literature-2-1", type: "single_choice", stem: "中国古代第一部诗歌总集是？", options: [{ key: "A", text: "《诗经》" }, { key: "B", text: "《楚辞》" }], correctAnswer: ["A"], referenceAnswer: "A", answerSource: "team_verified", maxScore: 2, chapter: "先秦文学", knowledgePoints: ["《诗经》"] },
    ],
  });
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), examImportStore, questionStore, examStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/exams/imports/${draft.id}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.exam.status, "draft");
  assert.deepEqual(questionStore.list({ library: "official" }).questions.map((question) => question.subjectId).sort(), ["ancient-literature", "modern-chinese"]);
});
