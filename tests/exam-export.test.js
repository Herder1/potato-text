const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryExamStore } = require("../apps/api/src/exam-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { generateExamExportBundle } = require("../apps/api/src/exam-export");

function exportQuestion(overrides = {}) {
  return {
    id: "export-question-1",
    type: "short_answer",
    stem: "简述现代汉语的含义。",
    referenceAnswer: "现代汉语是现代汉民族共同语。",
    scoringPoints: [{ description: "指出现代汉语是现代汉民族共同语", score: 2, textbookPage: "7" }],
    maxScore: 2,
    answerReviewStatus: "verified",
    ...overrides,
  };
}

test("exam exporter always creates matching paper and answer PDFs", () => {
  const bundle = generateExamExportBundle({
    exam: { title: "2026 汉语言文学学科基础模拟卷", durationMinutes: 150, totalScore: 4 },
    questions: [
      exportQuestion({
        id: "choice-1",
        type: "single_choice",
        stem: "现代汉语的含义是（ ）",
        options: [{ key: "A", text: "现代汉民族共同语" }, { key: "B", text: "古代汉语" }],
        correctAnswer: ["A"],
        referenceAnswer: "现代汉语是现代汉民族共同语。",
      }),
      exportQuestion({ id: "short-1", answerReviewStatus: "doubtful" }),
    ],
  });
  assert.equal(bundle.paper.buffer.subarray(0, 8).toString("ascii"), "%PDF-1.7");
  assert.equal(bundle.answer.buffer.subarray(0, 8).toString("ascii"), "%PDF-1.7");
  assert.equal(bundle.paper.buffer.includes(Buffer.from("/FontFile2")), true);
  assert.equal(bundle.answer.buffer.includes(Buffer.from("/FontFile2")), true);
  assert.equal(bundle.paper.buffer.includes(Buffer.from("/STSong-Light")), false);
  assert.equal(bundle.paper.name.endsWith("-试卷.pdf"), true);
  assert.equal(bundle.answer.name.endsWith("-答案.pdf"), true);
  assert.deepEqual(bundle.reviewQuestionNumbers, [2]);
  assert.equal(bundle.paper.pageCount > 0, true);
  assert.equal(bundle.answer.pageCount > 0, true);
});

test("exam exporter refuses the whole bundle when any answer is missing", () => {
  assert.throws(() => generateExamExportBundle({
    exam: { title: "缺答案试卷" },
    questions: [exportQuestion({ referenceAnswer: "", scoringPoints: [] })],
  }), (error) => {
    assert.equal(error.message, "exam_export_answers_incomplete");
    assert.deepEqual(error.missingQuestionNumbers, [1]);
    return true;
  });
});

test("exam export API generates and downloads both files together", async (context) => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-export-test-"));
  context.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  const examStore = createMemoryExamStore();
  examStore.action("exam-official-001", "publish");
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    examStore,
    questionStore: createMemoryQuestionStore(),
    examExportRoot: exportRoot,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/exam-exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ examId: "exam-official-001", userId: "test-user" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201, `attempt ${attempt}: ${JSON.stringify(payload)}`);
    assert.equal(payload.export.status, "ready");
    assert.deepEqual(payload.export.files.map((file) => file.kind), ["paper", "answer"]);

    for (const file of payload.export.files) {
      const downloaded = await fetch(`${baseUrl}${file.url}`);
      const buffer = Buffer.from(await downloaded.arrayBuffer());
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.headers.get("content-type"), "application/pdf");
      assert.equal(buffer.subarray(0, 8).toString("ascii"), "%PDF-1.7");
      assert.equal(buffer.length, file.size);
    }
  }
});

test("practice page keeps export inside the existing share entry", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/practice/practice.wxml"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/practice/practice.js"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/miniprogram/pages/practice/practice.wxss"), "utf8");
  assert.match(source, /分享与导出/);
  assert.match(source, /分享当前题目/);
  assert.match(source, /导出整套试卷/);
  assert.match(source, /生成并下载试卷与答案/);
  assert.match(script, /practiceMode === "exam"/);
  assert.match(script, /\/api\/exam-exports/);
  assert.match(styles, /\.share-submit\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  assert.match(styles, /\.share-submit\s*\{[^}]*white-space:\s*nowrap;/s);
});
