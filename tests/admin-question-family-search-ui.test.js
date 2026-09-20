const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(projectRoot, "apps", "admin", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(projectRoot, "apps", "admin", "styles.css"), "utf8");

function functionSource(name) {
  const start = app.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const nextFunction = app.indexOf("\nfunction ", start + 1);
  return app.slice(start, nextFunction === -1 ? app.length : nextFunction);
}

test("question-family search owns temporary expansion without replacing normal expansion", () => {
  assert.match(app, /expandedQuestionFamilyIds:\s*new Set\(\)/);
  assert.match(app, /questionFamilySearchExpandedIds:\s*new Set\(\)/);
  assert.match(app, /questionFamilySearchShowAllIds:\s*new Set\(\)/);

  const syncSource = functionSource("syncQuestionFamilySearchView");
  assert.match(syncSource, /questionFamilySearchExpandedIds\.clear\(\)/);
  assert.match(syncSource, /questionFamilySearchShowAllIds\.clear\(\)/);
  assert.doesNotMatch(syncSource, /expandedQuestionFamilyIds\.clear\(\)/);

  const rowSource = functionSource("questionFamilyRowHtml");
  assert.match(rowSource, /searching\s*\?\s*state\.questionFamilySearchExpandedIds\.has\(family\.id\)\s*:\s*state\.expandedQuestionFamilyIds\.has\(family\.id\)/);
  assert.doesNotMatch(rowSource, /expandedQuestionFamilyIds\.has\(family\.id\)\s*\|\|/);
  assert.doesNotMatch(rowSource, /matchedQuestions\.length\s*>\s*0/);
});

test("search ranks family metadata before member-only matches and labels the reason", () => {
  const matchSource = functionSource("questionFamilySearchMatchInfo");
  assert.match(matchSource, /searchMatch\.fields/);
  assert.match(matchSource, /searchMatch\.metadataFields/);
  assert.match(matchSource, /searchMatch\.questionIds/);
  assert.match(matchSource, /backendMemberOnly\s*=\s*searchMatch\.kind\s*===\s*"member_question"/);
  assert.match(matchSource, /genericMetadataMatched\s*=\s*!backendMemberOnly/);
  assert.match(matchSource, /nameMatched\s*\?\s*4/);
  assert.match(matchSource, /pathMatched\s*\?\s*3/);
  assert.match(matchSource, /成员题命中/);
  assert.match(matchSource, /题族名称命中/);
  assert.match(matchSource, /知识路径命中/);

  const tableSource = functionSource("renderQuestionFamilyTable");
  assert.match(tableSource, /familySearchInfoById/);
  assert.match(tableSource, /searchRows[\s\S]*\.sort\(\(left, right\) => compareQuestionFamilySearchMatches/);
  assert.match(app, /class="question-family-search-match"/);
  assert.match(styles, /\.question-family-title \.question-family-search-match\s*\{/);
});

test("expanded search results show matching questions first and reveal all members on demand", () => {
  const rowSource = functionSource("questionFamilyRowHtml");
  assert.match(rowSource, /const matchedMembers\s*=/);
  assert.match(rowSource, /const unmatchedMembers\s*=/);
  assert.match(rowSource, /\[\.\.\.matchedMembers, \.\.\.unmatchedMembers\]/);
  assert.match(rowSource, /searching\s*&&\s*!showAllMembers\s*\?\s*matchedMembers/);
  assert.match(rowSource, /data-question-family-action="show-all-members"/);
  assert.match(rowSource, /查看全部 \$\{filteredMembers\.length\} 道/);
  assert.match(rowSource, /仅看命中题/);
  assert.match(styles, /\.question-family-member-visibility\s*\{/);

  const clickStart = app.indexOf('document.querySelector("#question-family-table-body").addEventListener("click"');
  assert.notEqual(clickStart, -1);
  const clickSource = app.slice(clickStart, clickStart + 5000);
  assert.match(clickSource, /questionFamilyAction === "show-all-members"/);
  assert.match(clickSource, /questionFamilySearchShowAllIds/);
  assert.match(clickSource, /questionFamilySearchExpandedIds\.add\(familyId\)/);
  assert.match(clickSource, /searching\s*\?\s*state\.questionFamilySearchExpandedIds\s*:\s*state\.expandedQuestionFamilyIds/);
});

test("nested family sets stay visible during search while family rows remain manually expandable", () => {
  const setSource = functionSource("questionFamilySetRowHtml");
  assert.match(setSource, /expandedQuestionFamilySetIds\.has\(set\.id\)\s*\|\|\s*Boolean\(context\.query\)/);
  assert.match(setSource, /questionFamilySetItemSearchOrder/);
  assert.match(setSource, /searchInfo:\s*context\.familySearchInfoById\.get\(family\.id\)/);

  const managementSource = functionSource("renderQuestionFamilyManagement");
  assert.match(managementSource, /data-question-family-select/);
  assert.match(managementSource, /questionSelectedIds/);
});
