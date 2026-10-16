const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, "..", ...parts), "utf8");

test("admin feedback queue exposes follow-up action, conversation state and status filters", () => {
  const script = read("apps/admin/app.js");
  const markup = read("apps/admin/index.html");
  const styles = read("apps/admin/styles.css");
  assert.match(script, /data-moderation-action="ask"/);
  assert.match(script, /\/api\/admin\/moderation\/\$\{encodeURIComponent\(reportId\)\}\/messages/);
  assert.match(script, /待用户补充/);
  assert.match(script, /用户已补充/);
  assert.match(markup, /value="awaiting_reply">待用户补充/);
  assert.match(markup, /value="user_replied">用户已补充/);
  assert.match(styles, /\.moderation-conversation\s*\{/);
  assert.match(styles, /\.moderation-message p\s*\{/);
});

test("conversation entry stays accessible while waiting and after closure", () => {
  const script = read("apps/admin/app.js");
  const source = script.slice(script.indexOf("function moderationActions("), script.indexOf("function moderationConversationHtml("));
  const context = vm.createContext({ escapeHtml: (value) => String(value) });
  vm.runInContext(source, context);
  for (const status of ["pending", "processing", "resolved", "rejected"]) {
    const html = context.moderationActions({ id: "r", status, canAsk: false, messages: [{ id: "m" }] });
    assert.match(html, /data-moderation-action="ask"/);
    assert.match(html, /沟通记录/);
  }
  assert.match(context.moderationActions({ id: "r", status: "pending", canAsk: true }), />追问</);
  assert.doesNotMatch(context.moderationActions({ id: "r", status: "pending", canAsk: false }), /data-moderation-action="ask"/);
});

test("dialog has original context, full chronological transcript, readonly mode and draft-safe sending", () => {
  const script = read("apps/admin/app.js");
  const markup = read("apps/admin/index.html");
  const css = read("apps/admin/styles.css");
  const dialog = script.slice(script.indexOf("let feedbackChat ="), script.indexOf("async function handleModerationAction("));
  assert.match(markup, /id="feedback-chat-dialog" aria-labelledby="feedback-chat-title"/);
  assert.match(markup, /id="feedback-chat-input"[^>]+maxlength="1000"/);
  assert.match(dialog, /messages = \[\.\.\.\(report.messages \|\| \[\]\)\]\.sort/);
  assert.doesNotMatch(dialog, /messages\.slice/);
  assert.match(dialog, /escapeHtml\(message.content/);
  assert.match(dialog, /feedbackChatTime\(message.createdAt\)/);
  assert.match(dialog, /chat\.draft\.pending\.content !== content/);
  assert.match(dialog, /body: JSON.stringify\(pending\)/);
  assert.match(dialog, /clearInterval\(feedbackChat.timer\)/);
  assert.match(dialog, /chat.token === adminToken\(\)/);
  assert.match(css, /\.feedback-chat-dialog:not\(\[open\]\)/);
  assert.match(css, /\.feedback-chat-compose\[hidden\]/);
  const action = script.slice(script.indexOf('if (action === "ask")'), script.indexOf("const billingProductTypeLabels"));
  assert.match(action, /await openFeedbackChat\(reportId\)/);
  assert.doesNotMatch(action.slice(0, action.indexOf("const labels")), /window.prompt/);
});
