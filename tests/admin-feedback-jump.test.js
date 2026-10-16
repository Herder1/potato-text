const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../apps/admin/app.js"), "utf8");
const jump = source.slice(source.indexOf("async function jumpToFeedbackQuestion("), source.indexOf('\ndocument.addEventListener("click"', source.indexOf("async function jumpToFeedbackQuestion(")));

function setup(id, response, error) {
  const status = { dataset: { moderationQuestionStatus: id }, textContent: "" };
  const calls = [];
  const context = {
    document: { querySelectorAll: () => [status], querySelector: () => ({ scrollIntoView: () => { status.scrolled = true; } }) },
    requestJson: async (url) => { calls.push(url); if (error) throw error; return response; },
    openQuestionEditor: async (...args) => calls.push(args),
    friendlyError: (error) => error.message,
  };
  vm.createContext(context);
  vm.runInContext(jump, context);
  return { status, calls, run: () => context.jumpToFeedbackQuestion(id) };
}

test("feedback jump fetches exact ID and opens the existing editor without changing filters or navigating to the overview", async () => {
  const question = { id: 'question/"quoted"', status: "offline", library: "public" };
  const f = setup(question.id, { question });
  await f.run();
  assert.equal(f.calls[0], `/api/admin/questions/${encodeURIComponent(question.id)}`);
  assert.equal(f.calls[1][0], question.id);
  assert.equal(f.calls[1][1].question, question);
  assert.equal(f.status.textContent, "已打开对应题目");
  assert.equal(f.status.scrolled, true);
  assert.doesNotMatch(jump, /setTimeout|openView|question-search|library=official/);
});

test("feedback jump keeps missing/error cases in the feedback list with a visible explanation", async () => {
  for (const [response, error] of [[{}, null], [{ question: { id: "wrong" } }, null], [null, new Error("question_not_found")], [null, new Error("permission_denied")]]) {
    const f = setup("missing", response, error);
    await f.run();
    assert.equal(f.calls.length, 1);
    assert.match(f.status.textContent, /无法跳转|打不开/);
  }
  const empty = setup("", {});
  await empty.run();
  assert.equal(empty.calls.length, 0);
});
