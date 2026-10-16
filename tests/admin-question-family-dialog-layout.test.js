const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(projectRoot, "apps", "admin", "index.html"), "utf8");
const app = fs.readFileSync(path.join(projectRoot, "apps", "admin", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(projectRoot, "apps", "admin", "styles.css"), "utf8");

function cssRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

function openingTags(tagName, marker) {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "g"))]
    .map((match) => match[0])
    .filter((tag) => tag.includes(marker));
}

function functionSource(name) {
  const start = app.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const nextFunction = app.indexOf("\nfunction ", start + 1);
  return app.slice(start, nextFunction === -1 ? app.length : nextFunction);
}

function mediaSources(maxWidth) {
  const marker = `@media (max-width: ${maxWidth}px)`;
  const blocks = [];
  let cursor = 0;
  while (cursor < styles.length) {
    const start = styles.indexOf(marker, cursor);
    if (start === -1) break;
    const open = styles.indexOf("{", start + marker.length);
    let depth = 0;
    let end = open;
    for (; end < styles.length; end += 1) {
      if (styles[end] === "{") depth += 1;
      else if (styles[end] === "}" && --depth === 0) {
        end += 1;
        break;
      }
    }
    blocks.push(styles.slice(start, end));
    cursor = end;
  }
  assert.ok(blocks.length, `missing ${maxWidth}px media query`);
  return blocks;
}

test("question-family definition grid pairs compact and tall controls", () => {
  assert.match(html, /question-family-definition-core[\s\S]*question-family-definition-primary-anchor[\s\S]*question-family-definition-required[\s\S]*question-family-definition-textbook-anchors/);
  assert.match(html, /class="field question-family-definition-core"/);
  assert.match(html, /class="field question-family-definition-required"/);
  assert.match(html, /class="field question-family-definition-primary-anchor"/);
  assert.match(html, /class="field question-family-definition-textbook-anchors"/);

  const grid = cssRule(".question-family-definition-grid");
  assert.match(grid, /grid-template-areas:\s*"core primary-anchor"\s*"required textbook-anchors"/);
  assert.match(grid, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(cssRule(".question-family-definition-core"), /grid-area:\s*core/);
  assert.match(cssRule(".question-family-definition-primary-anchor"), /grid-area:\s*primary-anchor/);
  assert.match(cssRule(".question-family-definition-required"), /grid-area:\s*required/);
  assert.match(cssRule(".question-family-definition-textbook-anchors"), /grid-area:\s*textbook-anchors/);
  assert.match(styles, /\.question-family-definition-grid > \.field,\s*\.question-family-definition-grid > \.field \+ \.field\s*\{\s*margin-top:\s*0/);
});

test("question-family definition helper copy stays visually secondary", () => {
  const helper = cssRule(".question-family-definition-grid > .field > small");
  assert.match(helper, /color:\s*#929c97/);
  assert.match(helper, /font-size:\s*8px/);
  assert.match(helper, /font-weight:\s*400/);
});

test("question-family boundary columns and member relationship controls stay aligned", () => {
  assert.match(cssRule(".question-family-boundary-grid > .field + .field"), /margin-top:\s*0/);

  const memberSelect = cssRule(".question-family-member select");
  assert.match(memberSelect, /min-height:\s*34px/);
  assert.match(memberSelect, /font-family:\s*inherit/);
  assert.match(memberSelect, /font-size:\s*12px/);
  assert.match(memberSelect, /line-height:\s*1\.4/);
});

test("question-family definition single and multi-select controls share one text scale", () => {
  const definitionSelect = cssRule(".question-family-definition-grid select");
  const definitionPicker = cssRule(".question-family-definition-grid .question-family-multiselect-trigger");
  for (const control of [definitionSelect, definitionPicker]) {
    assert.match(control, /min-height:\s*40px/);
    assert.match(control, /font-family:\s*inherit/);
    assert.match(control, /font-size:\s*12px/);
    assert.match(control, /line-height:\s*1\.4/);
  }
});

test("question-family confirmation keeps boundaries optional", () => {
  assert.match(html, /<span>纳入边界（选填）<\/span>/);
  assert.match(html, /<span>排除边界（选填）<\/span>/);

  const payloadSource = functionSource("questionFamilyDefinitionPayload");
  assert.match(payloadSource, /inclusionBoundary:/);
  assert.match(payloadSource, /exclusionBoundary:/);

  const saveSource = functionSource("saveQuestionFamily");
  assert.match(saveSource, /effectiveStatus === "confirmed" && !definition\.assessmentAction/);
  assert.doesNotMatch(saveSource, /请补齐纳入边界和排除边界/);
  assert.doesNotMatch(saveSource, /effectiveStatus === "confirmed"[^\n]*definition\.inclusionBoundary/);
  assert.doesNotMatch(saveSource, /effectiveStatus === "confirmed"[^\n]*definition\.exclusionBoundary/);
});

test("a one-question family can be confirmed while remaining visibly sample-limited", () => {
  const reviewSource = functionSource("openQuestionFamilyReview");
  const rowSource = functionSource("questionFamilyRowHtml");
  const saveSource = functionSource("saveQuestionFamily");

  assert.match(reviewSource, /family\.members\.length\s*===\s*1/);
  assert.match(reviewSource, /确认单题题族/);
  assert.match(reviewSource, /单题可确认，暂无同类 \/ 变式训练/);
  assert.match(rowSource, /单题待扩充/);
  assert.match(rowSource, /question-family-sample-warning/);
  assert.match(saveSource, /members\.length\s*\?\s*"confirmed"/);
  assert.doesNotMatch(saveSource, /members\.length\s*>=\s*2\s*\?\s*"confirmed"/);
  assert.match(saveSource, /当前样本不足，暂不提供同类 \/ 变式训练/);
});

test("question-family member rows keep intrinsic height inside the scrolling form", () => {
  const form = cssRule(".question-family-form");
  assert.match(form, /display:\s*grid/);
  assert.match(form, /align-content:\s*start/);
  assert.match(form, /grid-auto-rows:\s*max-content/);
  assert.match(form, /overflow-y:\s*auto/);

  const member = cssRule(".question-family-member");
  assert.match(member, /display:\s*grid/);
  assert.match(member, /min-height:\s*94px/);

  const comparison = cssRule(".question-family-fingerprint-comparison");
  assert.match(comparison, /display:\s*grid/);
  assert.match(comparison, /gap:\s*7px/);

  const reviewStart = app.indexOf("function openQuestionFamilyReview");
  const reviewEnd = app.indexOf("function openEmptyQuestionFamilyDialog", reviewStart);
  assert.notEqual(reviewStart, -1);
  assert.notEqual(reviewEnd, -1);
  const reviewSource = app.slice(reviewStart, reviewEnd);
  assert.match(reviewSource, /querySelector\("#question-family-members"\)\.innerHTML\s*=\s*family\.members\.length[\s\S]*family\.members\.map\(questionFamilyMemberHtml\)\.join\(""\)/);
});

test("family definition state and member assignment state remain independent", () => {
  assert.match(html, /id="question-status-filter"/);
  assert.doesNotMatch(html, /id="question-family-status"|id="question-family-member-status"/);

  const loadSource = functionSource("loadQuestionFamilies");
  assert.match(loadSource, /questionWorkspaceFilters\(\)/);
  assert.doesNotMatch(loadSource, /question-family-member-status/);

  const renderSource = functionSource("questionFamilyRowHtml");
  assert.match(renderSource, /workspaceMemberIds/);
  assert.match(functionSource("questionFamilyMemberReviewStatus"), /member\.reviewStatus/);
  assert.match(functionSource("questionFamilyMemberReviewStatus"), /family\.status === "pending_review" \? "pending_fit" : "confirmed"/);
});

test("pending family members can be reviewed without changing family definition state", () => {
  const rowSource = functionSource("questionFamilyRowHtml");
  assert.match(rowSource, /confirmedMembers/);
  assert.match(rowSource, /个成员待审/);
  assert.match(rowSource, /has-pending-members/);
  assert.match(functionSource("questionFamilyMemberReviewActionsHtml"), /确认归属/);
  assert.match(functionSource("questionFamilyMemberReviewActionsHtml"), /驳回归属/);

  const reviewSource = functionSource("reviewQuestionFamilyMember");
  assert.match(reviewSource, /\/members\/\$\{encodeURIComponent\(questionId\)\}\/review/);
  assert.match(reviewSource, /expectedRevision:/);
  assert.match(reviewSource, /题族定义状态保持不变/);
  assert.match(functionSource("confirmQuestionFamilyMemberRejection"), /"rejected"/);
  assert.doesNotMatch(reviewSource, /window\.confirm|confirm\(/);

  assert.match(html, /id="question-family-member-review-dialog"/);
  assert.match(html, /id="question-family-member-review-reason"/);
  assert.match(styles, /\.question-family-member-review-actions/);
  assert.match(styles, /\.question-family-row\.has-pending-members/);
  assert.doesNotMatch(app, /题族已回到待审核|受影响题族已回待审核/);
});

test("family members distinguish formal knowledge, confirmed fingerprints, candidates, and missing states", () => {
  const memberSource = functionSource("questionFamilyMemberHtml");
  const factsSource = functionSource("questionFamilyMemberKnowledgeFactsHtml");
  assert.match(memberSource, /familyKnowledgeCompatibility/);
  assert.match(memberSource, /fullyIncompatible/);
  assert.match(memberSource, /has-knowledge-partial/);
  assert.match(memberSource, /member\.fingerprintReviewStatus === "suggested"/);
  assert.match(memberSource, /unassessed/);
  assert.match(factsSource, /question\.primaryKnowledgePoint/);
  assert.match(factsSource, /question\.knowledgeFingerprint/);
  assert.match(factsSource, /question\.candidateKnowledgeFingerprint/);
  assert.match(factsSource, /题目原有知识标签/);
  assert.match(factsSource, /已确认结构指纹/);
  assert.match(factsSource, /AI 候选结构指纹/);
  assert.match(factsSource, /当前题族定义/);
  const comparisonSource = functionSource("questionFamilyMemberCompatibilityHtml");
  assert.match(comparisonSource, /题目指纹 × 题族指纹/);
  assert.match(comparisonSource, /完全不一致/);
  assert.match(comparisonSource, /AI 候选不参与正式一致性结论/);
  assert.match(comparisonSource, /data-open-question-fingerprint/);
  assert.match(cssRule(".question-family-member.has-knowledge-mismatch"), /inset 3px 0 0/);
  assert.match(cssRule(".question-family-member.has-knowledge-partial"), /inset 3px 0 0/);
});

test("family workspace tree uses confirmed topic-family projection counts", () => {
  const treeSource = functionSource("renderKnowledgeTree");
  assert.match(treeSource, /isFamilyWorkspace/);
  assert.match(treeSource, /familyTreeSummary\?\.nodeQuestionCounts/);
  assert.match(treeSource, /已确认主题族投影/);
  const scopeSource = functionSource("renderQuestionFamilyScopeSummary");
  assert.match(scopeSource, /正式投影（已确认定义和归属、含下级、去重）/);
  assert.match(html, /id="question-family-scope-summary"/);
});

test("question-family member fingerprints are read-only and edit from the question editor", () => {
  const memberSource = functionSource("questionFamilyMemberHtml");
  assert.doesNotMatch(memberSource, /data-family-member-primary-knowledge/);
  assert.doesNotMatch(memberSource, /data-family-member-required-knowledge/);
  assert.doesNotMatch(memberSource, /question-family-member-multiselect/);
  assert.match(functionSource("questionFamilyMemberCompatibilityHtml"), /data-open-question-fingerprint/);
  assert.doesNotMatch(html, /id="reassign-question-family"/);
  assert.doesNotMatch(app, /function reassignQuestionFamily/);
  assert.doesNotMatch(app, /\/knowledge-structure\/question-assignments[\s\S]{0,500}question-family-dialog/);

  const membersSource = functionSource("currentQuestionFamilyMembers");
  assert.match(membersSource, /questionId:\s*row\.dataset\.questionId/);
  assert.match(membersSource, /role:\s*row\.querySelector\("\[data-family-member-role\]"\)\.value/);
  assert.match(membersSource, /trainingLevel:\s*row\.querySelector\("\[data-family-member-level\]"\)\.value/);
});

test("question editor owns searchable formal-fingerprint pickers", () => {
  assert.match(html, /id="question-knowledge-fingerprint"/);
  assert.match(html, /id="question-fingerprint-core"[^>]*hidden/);
  assert.match(html, /id="question-fingerprint-required"[^>]*multiple[^>]*hidden/);
  assert.match(html, /id="question-fingerprint-range"[^>]*multiple[^>]*hidden/);
  assert.doesNotMatch(html, /id="question-fingerprint-theme-anchor"/);
  assert.match(html, /id="question-family-set-attribution-list"/);
  assert.match(html, /id="load-question-fingerprint-candidate"/);
  assert.match(html, /id="save-question-fingerprint"/);
  const renderSource = functionSource("renderQuestionFingerprintPicker");
  assert.match(renderSource, /data-question-fingerprint-search/);
  assert.match(renderSource, /toLocaleLowerCase\("zh-CN"\)/);
  assert.match(renderSource, /data-question-fingerprint-option/);
  assert.match(renderSource, /作答核心，已自动包含/);
  assert.match(cssRule(".question-family-multiselect"), /position:\s*relative[\s\S]*min-width:\s*0/);
  assert.match(styles, /^\.question-family-multiselect-trigger\s*\{[^}]*width:\s*100%/m);
  assert.match(cssRule(".question-family-multiselect-panel"), /position:\s*fixed/);
  assert.match(cssRule(".question-family-multiselect-panel"), /max-width:\s*calc\(100vw\s*-\s*[0-9]+px\)/);
  assert.match(cssRule(".question-family-multiselect-options"), /overflow-y:\s*auto/);
  assert.match(styles, /\.question-family-multiselect-option\.is-locked\s*>\s*input\[disabled\]\[checked\][^{]*\{[^}]*appearance:\s*none/);
  assert.match(styles, /\.question-family-multiselect-option\.is-locked\s*>\s*input\[disabled\]\[checked\]::after/);
  assert.ok(mediaSources(760).some((mobile) => /\.question-fingerprint-editor-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(mobile)));
});

test("question-family multiselect stays inside its dialog", () => {
  // 面板挂在顶层（popover + position:fixed）。弹窗是 modal dialog，会为它的 fixed 后代
  // 建立包含块，所以 left/top 必须按包含块写；直接写视口坐标会整体偏移弹窗自己的位置
  // （实测弹窗 left=340 时写 547px 实际渲染在 888px，右边越过弹窗 266px）。
  const originSource = functionSource("questionFamilyMultiselectOrigin");
  assert.match(originSource, /panel\.offsetParent/);
  assert.match(originSource, /getBoundingClientRect\(\)/);
  assert.match(originSource, /document\.body/);
  const positionSource = functionSource("positionQuestionFamilyMultiselect");
  assert.match(positionSource, /questionFamilyMultiselectOrigin\(panel\)/);
  assert.match(positionSource, /panel\.style\.left = `\$\{left - origin\.left\}px`/);
  assert.match(positionSource, /panel\.style\.top = `\$\{rect\.bottom - origin\.top \+ gap\}px`/);
  assert.match(positionSource, /panel\.style\.bottom = `\$\{origin\.bottom - rect\.top \+ gap\}px`/);
  assert.doesNotMatch(positionSource, /window\.innerHeight - rect\.top/, "bottom 不能再按视口算");

  // 触发器比弹窗宽时，面板要收回弹窗边界内（旧口径只按视口收敛）
  const boundsSource = functionSource("questionFamilyMultiselectBounds");
  assert.match(boundsSource, /closest\("dialog\[open\]"\)/);
  assert.match(boundsSource, /window\.innerWidth/);
  assert.match(boundsSource, /window\.innerHeight/);
  assert.match(positionSource, /questionFamilyMultiselectBounds\(root\)/);
  assert.doesNotMatch(positionSource, /window\.innerWidth\s*-\s*width\s*-\s*margin/, "不能再只按视口收敛");
  assert.match(positionSource, /Math\.min\(preferredWidth,\s*maxRight\s*-\s*minLeft\)/);

  // 打开后弹窗还会重排，面板必须再量一帧并跟随触发器尺寸变化。
  const openSource = functionSource("syncQuestionFamilyMultiselectOpenState");
  assert.match(openSource, /trackQuestionFamilyMultiselectPosition\(root\)/);
  assert.match(openSource, /requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*positionQuestionFamilyMultiselect\(root\)/);
  const trackSource = functionSource("trackQuestionFamilyMultiselectPosition");
  assert.match(trackSource, /new ResizeObserver/);
  assert.match(trackSource, /questionFamilyMultiselectIsOpen\(tracked\)/);
  assert.match(trackSource, /positionQuestionFamilyMultiselect\(tracked\)/);
});

test("admin static assets bust the browser cache on every change", () => {
  // app.js / styles.css 没有内容哈希，只靠 ?v= 破缓存；改了脚本却忘了抬版本号，
  // 浏览器会一直用旧的 app.js（这次"修完还复现"就是这个原因）。
  const scriptVersion = html.match(/app\.js\?v=(\d{8}\.\d+)/);
  const styleVersion = html.match(/styles\.css\?v=(\d{8}\.\d+)/);
  assert.ok(scriptVersion, "app.js 必须带版本号");
  assert.ok(styleVersion, "styles.css 必须带版本号");
  assert.equal(scriptVersion[1], styleVersion[1], "两个静态资源版本号必须一致");
  const revision = Number(scriptVersion[1].split(".")[1]);
  assert.ok(revision >= 10, `静态资源版本号至少要到 .10（当前 .${revision}）`);
});

test("question fingerprint keeps theme range separate while retaining the core in the minimum sufficient set", () => {
  const normalizeSource = functionSource("normalizeQuestionFingerprintDraftRequiredNodeIds");
  assert.match(normalizeSource, /state\.questionFingerprintDraftRequiredNodeIds/);
  assert.match(normalizeSource, /filter\(Boolean\)/);
  assert.match(normalizeSource, /state\.questionFingerprintDraftProblemKnowledgeRangeNodeIds/);

  const applySource = functionSource("applyQuestionFingerprintDraft");
  assert.match(applySource, /normalizeQuestionFingerprintPrimaryNodeRole\(fingerprint\?\.primaryNodeRole\)/);
  assert.match(applySource, /normalizeQuestionFingerprintDraftRequiredNodeIds\(\)/);

  const summarySource = functionSource("questionFingerprintSummary");
  assert.match(summarySource, /knowledgeThemeRangeAnchorNodeId/);
  assert.match(summarySource, /旧知识范围锚点（历史兼容）/);
  assert.match(summarySource, /filter\(Boolean\)/);
  assert.match(app, /#question-fingerprint-required[\s\S]*normalizeQuestionFingerprintDraftRequiredNodeIds\(\)/);
});

test("question-family member summaries and contribution candidates respect the primary role", () => {
  const summarySource = functionSource("questionFamilyFingerprintSummary");
  assert.match(summarySource, /normalizeQuestionFingerprintPrimaryNodeRole\(fingerprint\.primaryNodeRole\)/);
  assert.match(summarySource, /范围锚点：\$\{primaryPath\}；作答必需/);
  assert.match(summarySource, /作答核心：\$\{primaryPath\}/);

  for (const name of [
    "questionFamilyMemberContributionNodeIds",
    "questionFamilyMemberContributionSuggestionNodeIds",
    "questionFamilyMemberContributionHtml",
  ]) {
    const source = functionSource(name);
    assert.match(source, /normalizeQuestionFingerprintPrimaryNodeRole\(member\.primaryNodeRole\)/);
    assert.match(source, /primaryNodeRole === "core" \? \[member\.knowledgeNodeId\] : \[\]/);
    assert.match(source, /primaryNodeRole === "scope_anchor" && nodeId === String\(member\.knowledgeNodeId/);
  }
});

test("question fingerprint popovers are anchored after entering the top layer", () => {
  const openSource = functionSource("setQuestionFingerprintPickerOpen");
  assert.match(openSource, /panel\.showPopover\(\)/);
  assert.match(openSource, /positionQuestionFamilyMultiselect\(root\)/);
  assert.ok(
    openSource.indexOf("panel.showPopover()") < openSource.indexOf("positionQuestionFamilyMultiselect(root)"),
    "the fingerprint panel must be positioned after showPopover() moves it to the top layer",
  );
  assert.match(app, /#question-form[\s\S]*positionQuestionFamilyMultiselect\(openRoot\)/);
});

test("formal-fingerprint save is version-guarded and never rides on family confirmation", () => {
  const saveSource = functionSource("saveQuestionFingerprint");
  assert.match(saveSource, /expectedQuestionVersion:\s*question\.version/);
  assert.match(saveSource, /expectedFingerprintSignature/);
  assert.match(saveSource, /\/knowledge-fingerprint/);
  assert.match(saveSource, /accept_candidate/);
  assert.match(saveSource, /primaryNodeRole,/);
  assert.match(saveSource, /state\.questionEditorContentDirty/);
  const familySaveSource = functionSource("saveQuestionFamily");
  assert.doesNotMatch(familySaveSource, /knowledge-fingerprint|question-assignments/);
});

test("question-family knowledge fields use collapsed searchable single and multiple pickers", () => {
  const singleSelectIds = ["question-family-core-knowledge", "question-family-location-node"];
  const multipleSelectIds = ["question-family-required-knowledge", "question-family-textbook-anchors"];
  for (const selectId of [...singleSelectIds, ...multipleSelectIds]) {
    const tags = openingTags("select", `id="${selectId}"`);
    assert.equal(tags.length, 1);
    assert.match(tags[0], /\bhidden\b/);
  }
  singleSelectIds.forEach((selectId) => assert.doesNotMatch(openingTags("select", `id="${selectId}"`)[0], /\bmultiple\b/));
  multipleSelectIds.forEach((selectId) => assert.match(openingTags("select", `id="${selectId}"`)[0], /\bmultiple\b/));

  for (const type of ["core", "primary-anchor", "required", "anchors"]) {
    assert.match(html, new RegExp(`class="[^"]*question-family-multiselect[^"]*"[^>]*data-question-family-multiselect="${type}"|data-question-family-multiselect="${type}"[^>]*class="[^"]*question-family-multiselect[^"]*"`));
  }

  const triggers = openingTags("button", "question-family-multiselect-trigger")
    .filter((trigger) => /\bid="question-family-/.test(trigger));
  assert.equal(triggers.length, 4);
  triggers.forEach((trigger) => {
    assert.match(trigger, /\baria-haspopup="dialog"/);
    assert.match(trigger, /\baria-expanded="false"/);
    assert.match(trigger, /\baria-controls="[^"]+"/);
  });

  const panels = openingTags("div", "question-family-multiselect-panel")
    .filter((panel) => /\bid="question-family-/.test(panel));
  assert.equal(panels.length, 4);
  panels.forEach((panel) => {
    assert.match(panel, /\brole="dialog"/);
    assert.match(panel, /\b(?:hidden|popover="auto")/);
    assert.match(panel, /\baria-(?:label|labelledby)="[^"]+"/);
  });
  const searches = openingTags("input", 'type="search"')
    .filter((tag) => tag.includes("data-question-family-multiselect-search") && !tag.includes("data-blind-gold-primary-family"));
  assert.equal(searches.length, 4);
  searches.forEach((search) => assert.match(search, /\baria-(?:label|labelledby)="[^"]+"/));
  const optionGroups = openingTags("div", "question-family-multiselect-options")
    .filter((group) => group.includes("data-question-family-multiselect-options") && !group.includes("data-blind-gold-primary-family"));
  assert.equal(optionGroups.length, 4);
  assert.equal(optionGroups.filter((tag) => tag.includes('role="radiogroup"')).length, 2);
  assert.equal(optionGroups.filter((tag) => tag.includes('role="group"')).length, 2);
  optionGroups.forEach((group) => assert.match(group, /\baria-(?:label|labelledby)="[^"]+"/));
  assert.doesNotMatch(html, /id="question-family-location-search"/);
});

test("question-family pickers fold, filter, synchronize single and multiple choices, and preserve locked nodes", () => {
  const configSource = functionSource("questionFamilyMultiselectConfig");
  const renderSource = functionSource("renderQuestionFamilyMultiselect");
  const syncOpenSource = functionSource("syncQuestionFamilyMultiselectOpenState");
  const openSource = functionSource("setQuestionFamilyMultiselectOpen");

  assert.match(renderSource, /toLocaleLowerCase\("zh-CN"\)/);
  assert.match(renderSource, /includes\(query\)/);
  assert.match(configSource, /type\s*===\s*"core"[\s\S]*multiple:\s*false/);
  assert.match(configSource, /type\s*===\s*"primary-anchor"[\s\S]*multiple:\s*false/);
  assert.match(configSource, /type\s*===\s*"anchors"[\s\S]*questionFamilyMoveKnowledgeNodeId/);
  assert.match(configSource, /type\s*===\s*"core"[\s\S]*lockedId:\s*""/);
  assert.match(renderSource, /config\.multiple\s*\?\s*"checkbox"\s*:\s*"radio"/);
  assert.match(renderSource, /checked/);
  assert.match(renderSource, /disabled/);
  assert.match(configSource, /随(?:目录)?主锚点保留/);
  assert.match(app, /\.selected\s*=/);

  assert.match(syncOpenSource, /aria-expanded/);
  assert.match(syncOpenSource, /root\?\.isConnected/);
  assert.match(syncOpenSource, /!panel\s*\|\|\s*!trigger\s*\|\|\s*!search/);
  assert.match(openSource, /showPopover|\.hidden\s*=\s*false/);
  assert.match(openSource, /hidePopover|\.hidden\s*=\s*true/);
  assert.ok(
    openSource.indexOf("panel.hidden = false") < openSource.indexOf("panel.showPopover()"),
    "the panel must be unhidden before a second popover opening",
  );
  assert.match(app, /setQuestionFamilyMultiselectOpen\([^,]+,\s*!/);
  assert.match(app, /event\.key\s*(?:===|!==)\s*"Escape"[\s\S]*setQuestionFamilyMultiselectOpen\([^,]+,\s*false\)[\s\S]*\.focus\(\)/);
  assert.match(app, /document\.addEventListener\("click"[\s\S]*closest\("\.question-family-multiselect"\)[\s\S]*setQuestionFamilyMultiselectOpen\([^,]+,\s*false\)/);

  assert.match(app, /questionFamilyRequiredKnowledgeNodeIds\s*=\s*\[\.\.\.new Set/);
  assert.match(app, /questionFamilyTextbookAnchorNodeIds\s*=\s*\[\.\.\.new Set/);
  assert.match(app, /scopeAnchorNodeId:\s*coreKnowledgeNodeId[\s\S]*coverageKnowledgeNodeIds:/);
  assert.match(app, /questionFamilyMoveKnowledgeNodeId,[\s\S]*questionFamilyTextbookAnchorNodeIds/);
  assert.match(app, /config\.multiple[\s\S]*option\.selected\s*=\s*control\.checked[\s\S]*item\.selected\s*=\s*item\s*===\s*option/);
  assert.match(app, /renderQuestionFamilyMultiselect\("core"\)/);
  assert.match(app, /renderQuestionFamilyMultiselect\("primary-anchor"\)/);
  assert.match(app, /renderQuestionFamilyMultiselect\("required"\)/);
  assert.match(app, /renderQuestionFamilyMultiselect\("anchors"\)/);
});

test("question-family primary anchor moves only through the normal save flow", () => {
  const saveSource = functionSource("saveQuestionFamily");
  assert.doesNotMatch(html, /id="move-question-family"/);
  assert.doesNotMatch(html, /question-family-primary-anchor-action/);
  assert.doesNotMatch(app, /function relocateQuestionFamily/);
  assert.match(saveSource, /primaryAnchorChanged/);
  assert.match(saveSource, /确认题族后将同步移动目录，题目成员不变/);
  assert.match(saveSource, /state\.selectedKnowledgeNodeId\s*=\s*primaryAnchorNodeId/);
  assert.match(saveSource, /state\.expandedQuestionFamilyIds\.add\(familyId\)/);
  assert.match(saveSource, /renderKnowledgeTree\(\)/);
});

test("question-family status filter survives every workspace mutation and refresh", () => {
  const loadSource = functionSource("loadQuestionFamilies");
  assert.match(loadSource, /questionWorkspaceFilters\(\)/);
  assert.doesNotMatch(loadSource, /question-status-filter[^\n]*\.value\s*=/);
  assert.match(app, /querySelector\("#refresh-question-workspace"\)\.addEventListener\("click",\s*loadCurrentQuestionLibraryContent\)/);

  for (const name of [
    "confirmQuestionGrouping",
    "addSelectedQuestionFamilyMembers",
    "removeQuestionFamilyMember",
    "deleteQuestionFamily",
    "saveQuestionFamily",
  ]) {
    const source = functionSource(name);
    assert.match(source, /await loadQuestionFamilies\(\)/, `${name} must refresh the filtered workspace`);
    assert.doesNotMatch(source, /question-status-filter[^\n]*\.value\s*=/, `${name} must not overwrite the active status filter`);
  }
});

test("question-family multiselect stays usable on narrow screens", () => {
  const picker = cssRule(".question-family-multiselect");
  const panel = cssRule(".question-family-multiselect-panel");
  const options = cssRule(".question-family-multiselect-options");
  assert.match(picker, /position:\s*relative/);
  assert.match(styles, /^\.question-family-multiselect-trigger\s*\{[^}]*width:\s*100%/m);
  assert.match(panel, /position:\s*fixed/);
  assert.match(panel, /max-width:\s*calc\(100vw\s*-\s*[0-9]+px\)/);
  assert.match(panel, /max-height:\s*min\([^;]*100vh[^;]*\)/);
  assert.match(options, /overflow-y:\s*auto/);

  assert.ok(mediaSources(760).some((mobile) => /\.question-family-definition-grid\s*\{[^}]*grid-template-areas:\s*"core"\s*"primary-anchor"\s*"required"\s*"textbook-anchors"/.test(mobile)));
});
