const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(projectRoot, "apps", "admin", "index.html"), "utf8");
const app = fs.readFileSync(path.join(projectRoot, "apps", "admin", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(projectRoot, "apps", "admin", "styles.css"), "utf8");

test("question editor provides searchable, visibly deduplicated family membership", () => {
  assert.match(html, /id="question-family-membership-search"[^>]*type="search"/);
  assert.match(html, /id="question-family-membership-match-count"/);
  assert.match(app, /function questionFamilyVisibleKey/);
  assert.match(app, /function normalizeQuestionMembershipDraft/);
  assert.match(app, /selectedVisibleKeys\.has\(visibleKey\)/);
  assert.match(app, /questionMembershipSearchQuery/);
  assert.match(app, /family\.knowledgePath,[\s\S]*family\.id/);
});

test("question editor preserves the explicit family-membership role and contribution contract", () => {
  assert.match(app, /function questionMembershipCoverageRole/);
  assert.match(app, /function questionMembershipContributionPickerHtml/);
  assert.match(app, /data-question-membership-role="required"/);
  assert.match(app, /data-question-membership-role="reference"/);
  assert.match(app, /data-question-membership-contribution-picker/);
  assert.match(app, /普通关联不参与作答覆盖，无需填写/);
  assert.match(app, /可参考：[\s\S]*未自动选中/);
  assert.match(app, /coverageRole:\s*state\.questionMembershipDraft\.length === 0 \? "required" : "reference"/);
  assert.match(app, /contributionKnowledgeNodeIds:\s*\[\]/);

  const payloadSource = app.slice(
    app.indexOf("function questionFormPayload"),
    app.indexOf("async function openQuestionVersions"),
  );
  assert.match(payloadSource, /familyMemberships:\s*state\.questionMembershipDraft\.map/);
  assert.match(payloadSource, /coverageRole:\s*questionMembershipCoverageRole\(membership\)/);
  assert.match(payloadSource, /contributionKnowledgeNodeIds:[\s\S]*questionMembershipKnowledgeNodeIds\(membership\.contributionKnowledgeNodeIds\)/);
});

test("family membership editing never rewrites question knowledge metadata", () => {
  assert.doesNotMatch(app, /function syncQuestionKnowledgeFromMemberships/);
  assert.match(app, /document\.querySelector\("#question-chapter"\)\.value = question\.chapter/);
  assert.match(app, /document\.querySelector\("#question-primary-knowledge-point"\)\.value = question\.primaryKnowledgePoint/);
  assert.match(html, /题族归属不改写题目知识指纹或教材字段/);
  assert.match(styles, /\.question-membership-contribution-picker \.question-family-multiselect-trigger/);
});

test("question-family editor separates knowledge, textbook anchors, and assessment boundaries", () => {
  assert.match(html, /id="question-family-focus-key"/);
  assert.match(html, /id="question-family-core-knowledge"/);
  assert.match(html, /id="question-family-required-knowledge"[^>]*multiple/);
  assert.match(html, /id="question-family-textbook-anchors"[^>]*multiple/);
  assert.match(html, /id="question-family-assessment-action"/);
  assert.match(html, /id="question-family-inclusion-boundary"/);
  assert.match(html, /id="question-family-exclusion-boundary"/);
  assert.match(html, /id="question-family-dynamic-relations"[^>]*hidden/);
  assert.match(app, /function questionFamilyDefinitionPayload/);
  assert.match(app, /focusKey: document\.querySelector\("#question-family-focus-key"\)\.value\.trim\(\)/);
  assert.match(app, /coreKnowledgeNodeId,[\s\S]*requiredKnowledgeNodeIds:[\s\S]*textbookAnchorNodeIds:/);
  assert.match(app, /scopeAnchorNodeId:\s*coreKnowledgeNodeId[\s\S]*coverageKnowledgeNodeIds:/);
  assert.doesNotMatch(app, /focusKey:\s*definition\.assessmentAction \|\| name|focusKey:\s*name/);
  assert.match(app, /renderQuestionFamilyDynamicRelations\(family\.dynamicRelations\)/);
  assert.match(styles, /\.question-family-definition-grid/);
  assert.match(styles, /\.question-family-dynamic-relation/);
});

test("question editor supports simultaneous insert and graduate exam tags", () => {
  assert.match(html, /id="question-exam-tags"/);
  assert.match(html, /data-question-exam-tag[^>]*value="insert"/);
  assert.match(html, /data-question-exam-tag[^>]*value="graduate"/);
  assert.match(app, /examTags:\s*\[\.\.\.document\.querySelectorAll\("\[data-question-exam-tag\]:checked"\)\]/);
  assert.match(app, /new Set\(Array\.isArray\(question\.examTags\) \? question\.examTags : \[\]\)/);
  assert.match(app, /questionExamTagsSummary\(question\)/);
});

test("admin exposes a nested question-family set editor", () => {
  assert.match(html, /id="create-question-family-set"[^>]*>新建题族集</);
  assert.match(html, /id="question-family-set-dialog"/);
  assert.match(html, /id="question-family-set-parent"/);
  assert.match(html, /id="question-family-set-member-search"[^>]*type="search"/);
  assert.match(html, /data-question-family-set-member-tab="current"/);
  assert.match(html, /data-question-family-set-member-tab="candidates"/);
  assert.match(html, /id="question-family-set-current-members"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(html, /id="question-family-set-member-candidates"/);
  assert.match(html, /id="delete-question-family-set"[^>]*>解散题族集</);
  assert.match(app, /function questionFamilySetRowHtml/);
  assert.match(app, /function questionFamilySetDescendantSetIds/);
  assert.match(app, /function questionFamilySetCoveredContent/);
  assert.match(app, /function normalizeQuestionFamilySetSelectedItems/);
  assert.match(app, /function setQuestionFamilySetMemberTab/);
  assert.match(app, /questionFamilySetMemberTab:\s*"candidates"/);
  assert.match(app, /coverage\.familyIds\.has\(family\.id\)/);
  assert.match(app, /coverage\.setIds\.has\(set\.id\)/);
  assert.match(app, /coveredSelectedSetIds\.has\(id\)/);
  assert.match(app, /data-question-family-set-action="toggle"/);
  assert.match(styles, /\.question-family-set-row/);
  assert.match(styles, /\.question-family-set-children/);
  assert.match(styles, /\.question-family-set-member-tabs/);
  assert.match(styles, /\.question-family-set-member-panels/);
  assert.match(styles, /\.question-family-set-current,\s*\n\.question-family-set-candidates\s*\{[^}]*height:\s*100%/s);
});

test("question-family set editor uses the real move and detach API contract", () => {
  const submitSource = app.slice(
    app.indexOf("async function submitQuestionFamilySet"),
    app.indexOf("async function removeQuestionFamilySetMember"),
  );
  assert.match(app, /requestJson\("\/api\/admin\/question-family-sets"/);
  assert.match(submitSource, /requestJson\(`\/api\/admin\/question-family-sets\/\$\{encodeURIComponent\(current\.id\)\}`[\s\S]*method:\s*"PATCH"/);
  assert.match(submitSource, /method:\s*"PATCH"[\s\S]*mode:\s*"move"[\s\S]*familyIds,[\s\S]*childSetIds,/);
  assert.doesNotMatch(submitSource, /\/question-family-sets\/[^`]*\/members`/);
  assert.match(app, /\/members\/\$\{encodeURIComponent\(type\)\}\/\$\{encodeURIComponent\(memberId\)\}/);
  assert.match(app, /const candidateScrollTop = event\.currentTarget\.scrollTop/);
  assert.match(app, /renderQuestionFamilySetMembers\(\{ candidateScrollTop \}\)/);
  assert.match(app, /scrollTop = Math\.max\(0, options\.candidateScrollTop\)/);
  assert.match(app, /current\.directSetCount \|\| current\.setCount/);
  assert.match(app, /question_family_set_member_already_in_subtree:\s*"所选内容已由下级题族集包含/);
  assert.match(app, /question_family_set_selection_overlap:\s*"所选题族集与题族存在层级重叠/);
  assert.match(app, /题族和题目均已保留/);
});
