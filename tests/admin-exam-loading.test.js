const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("admin exam page renders partial results and prevents overlapping refreshes", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  assert.match(script, /let examLoadPromise = null/);
  assert.match(script, /if \(examLoadPromise\) return examLoadPromise/);
  assert.match(script, /正在读取试卷记录/);
  assert.match(script, /Promise\.allSettled\(requests\)/);
  assert.match(script, /requestJson\("\/api\/admin\/exams"\)\.then/);
  assert.match(script, /requestJson\("\/api\/admin\/exams\/imports"\)\.then/);
  assert.match(script, /requestJson\("\/api\/admin\/exams\/import-jobs"\)\.then/);
});

test("exam review dialog stays centered and keeps the established three-column editor", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/admin/styles.css"), "utf8");
  assert.match(styles, /\.exam-review-dialog\s*\{[\s\S]*?width:\s*min\(1180px, calc\(100vw - 48px\)\)/);
  assert.match(styles, /\.exam-review-dialog\[open\]\s*\{[\s\S]*?inset:\s*50% auto auto 50%/);
  assert.match(styles, /\.exam-review-dialog\[open\]\s*\{[\s\S]*?transform:\s*translate\(-50%, -50%\)/);
  assert.match(styles, /\.exam-recognized-grid\s*\{[\s\S]*?grid-template-columns:\s*145px minmax\(0, 1fr\) 160px/);
  assert.match(styles, /\.exam-recognized-grid input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="hidden"\]\)[\s\S]*?border:\s*1px solid #d6dfda/);
  assert.match(styles, /\.exam-recognized-grid textarea\s*\{[\s\S]*?min-height:\s*82px/);
});

test("exam editor shows selected questions until management is explicitly opened", () => {
  const root = path.resolve(__dirname, "../apps/admin");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(html, /id="manage-exam-questions"[^>]*>管理题目<\/button>/);
  assert.match(html, /id="exam-question-pool-title">试卷题目<\/strong>/);
  assert.match(script, /examQuestionManagementMode:\s*false/);
  assert.match(script, /state\.examQuestionManagementMode\s*=\s*!exam/);
  assert.match(script, /selected\.map\(\(id\) => questionById\.get\(id\)\)\.filter\(Boolean\)/);
  assert.match(script, /state\.examQuestionManagementMode\s*=\s*!state\.examQuestionManagementMode/);
});
