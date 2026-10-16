const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "../apps/admin/index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../apps/admin/styles.css"), "utf8");

test("original library remains the sole active management entry with all original tabs", () => {
  assert.match(html, /data-view="题库管理"/);
  assert.doesNotMatch(html, /data-view="题库管理（新）"/);
  assert.doesNotMatch(html, /id="new-library"|data-question-library-tab="adjudication"/);
  for (const tab of ["library", "dossiers", "authoring", "enrichment", "inspections", "gold-review", "rules"]) {
    assert.match(html, new RegExp(`data-question-library-tab="${tab}"`));
  }
});

test("blanket read-only lock is removed without enabling legitimately disabled controls", () => {
  assert.doesNotMatch(app, /LEGACY_LIBRARY_READONLY|enforceLegacyQuestionLibraryReadOnly|watchLegacyQuestionLibraryReadOnly|legacyReadonlyObserver/);
  assert.doesNotMatch(html, /id="legacy-library-banner"|id="question-library-legacy-badge"/);
  assert.doesNotMatch(css, /is-legacy-readonly/);
  assert.match(html, /id="edit-question-import-batch"[^>]*disabled/);
  assert.match(app, /querySelector\("#edit-question-import-batch"\)\.disabled = select\.value === "all"/);
});

test("retired view redirects to original before routing and never loads abandoned data", () => {
  const start = app.indexOf("async function openView(name)");
  const routing = app.slice(start, app.indexOf("function openDialog(", start));
  assert.match(routing, /if \(requestedEnrichment\) name = "题库管理"/);
  assert.match(routing, /if \(name === "题库管理（新）"\) name = "题库管理"/);
  assert.ok(routing.indexOf('name === "题库管理（新）"') < routing.indexOf("state.currentView = name"));
  assert.doesNotMatch(routing, /querySelector\("#new-library"\)/);
  assert.doesNotMatch(routing, /loadNewLibrary|applyNewLibraryLayout|\.disabled\s*=\s*false/);
});

test("retired implementations and event bindings are deleted, not merely hidden", () => {
  assert.doesNotMatch(app, /bindArchivedNewLibraryEvents|newLibrary|NewLibrary|new-library|adjudication|Adjudication/);
  assert.doesNotMatch(css, /new-library|#nl-|\.nl-|adjudication/);
  assert.equal(fs.existsSync(path.join(__dirname, "../apps/api/src/new-library-copy.js")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "../apps/api/src/new-library-mapping.js")), false);
});
