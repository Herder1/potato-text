const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const miniprogramRoot = path.join(__dirname, "../apps/miniprogram");
const pagesRoot = path.join(miniprogramRoot, "pages");

function readPageMarkup(page) {
  return fs.readFileSync(path.join(pagesRoot, page, `${page}.wxml`), "utf8");
}

test("the shared back icon is a single tailless chevron", () => {
  const icon = fs.readFileSync(path.join(miniprogramRoot, "assets/icons/arrow-left.svg"), "utf8");
  assert.equal((icon.match(/<path\b/g) || []).length, 1);
  assert.match(icon, /d="m15 19-7-7 7-7"/);
  assert.doesNotMatch(icon, /M19 12H5|M5 12h14/);
});

test("visible custom back controls reuse the shared chevron", () => {
  const pageBackControls = ["card-box", "card-editor", "card-set", "card-set-editor", "note-editor", "pack-collection", "practice"];
  pageBackControls.forEach((page) => {
    const markup = readPageMarkup(page);
    assert.match(markup, /bindtap="goBack"/);
    assert.match(markup, /src="\/assets\/icons\/arrow-left\.svg"/);
    assert.doesNotMatch(markup, /bindtap="goBack"[^>]*>取消</);
  });

  assert.match(readPageMarkup("note-editor"), /class="preview-back"[\s\S]{0,180}arrow-left\.svg/);
  assert.match(readPageMarkup("wrong-book"), /class="wrong-chapter-back"[\s\S]{0,180}arrow-left\.svg/);
});
