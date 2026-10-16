const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createControlLock,
  createGuard,
} = require("../apps/admin/knowledge-inspection-apply-guard");

test("knowledge inspection is read-only: the apply path has no UI entry and no write control renders", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  // DEC-100（产品手册 §4.6.12）：巡检只诊断、不改库 —— 原来这套"满足条件才能采纳"的判定不再有界面入口。
  assert.match(script, /function knowledgeInspectionResolvedNodeId/);
  assert.match(script, /agent2\.primaryNodeId \|\| agent2\.primaryNode\?\.id/);
  assert.match(script, /本次巡检没有形成明确知识节点，不能直接采纳/);
  assert.doesNotMatch(html, /id="apply-knowledge-inspection"/);
  assert.doesNotMatch(html, /data-knowledge-node-choice/);
  assert.doesNotMatch(html, /data-knowledge-primary-choice/);
  assert.doesNotMatch(script, /lockedCore \? "disabled"/);
  assert.match(script, /knowledgeInspectionPrimaryNodeRole/);
  assert.match(script, /knowledge-inspection-primary-node-role/);
  assert.match(script, /handleKnowledgeInspectionChoiceChange/);
  assert.match(script, /button\.textContent = result\.answerConflict[\s\S]*?无可采纳建议/);
});

test("knowledge inspection dialog keeps status and actions visible while details scroll", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/admin/styles.css"), "utf8");
  assert.match(styles, /\.knowledge-inspection-dialog\[open\]\s*\{[\s\S]*?display:\s*flex/);
  assert.match(styles, /\.knowledge-inspection-dialog\[open\]\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(styles, /\.knowledge-inspection-dialog-body\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test("knowledge inspection hides the textbook knowledge tree so the review workspace keeps the full width", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/admin/styles.css"), "utf8");
  const setTabSource = script.slice(
    script.indexOf("function setQuestionLibraryTab"),
    script.indexOf("function questionTableUnits"),
  );
  // 「完善题目」「AI 巡检」「盲测金标」「裁决台」都是工作流/基准面板、不使用左侧教材知识树，应一起隐藏
  // （见《链路职责矩阵》第十三节第一条；「盲测金标」由 DEC-092 拆为平级子标签时并入本组）。
  // 断言用"成员包含"而不是整表相等：本仓库有多个会话并行推进，别人会往同一行加新标签
  //（例如已并入的 authoring），整表写死会互相绊倒；少一个成员仍然会失败。
  const hiddenList = (() => {
    const start = setTabSource.indexOf('"without-knowledge-tree"');
    const from = setTabSource.indexOf("[", start);
    const to = setTabSource.indexOf("]", from);
    return setTabSource.slice(from, to + 1);
  })();
  for (const tab of ["inspections", "gold-review", "enrichment"]) {
    assert.match(hiddenList, new RegExp(`"${tab}"`), `隐藏知识树的标签应包含 ${tab}；实际=${hiddenList}`);
  }
  assert.match(setTabSource, /querySelector\("\.question-browser-section"\)\?\.classList\.toggle\(\s*"without-knowledge-tree",[\s\S]{0,140}?\.includes\(state\.questionLibraryTab\),\s*\)/);
  assert.match(styles, /\.question-browser-section\.without-knowledge-tree\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.question-browser-section\.without-knowledge-tree\s*>\s*\.knowledge-tree-panel\s*\{\s*display:\s*none/);
});

test("knowledge inspection exposes review conversations and human-approved teaching rules", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  assert.match(html, /data-question-library-tab="rules"[^>]*>教研规则/);
  assert.match(html, /id="knowledge-inspection-agent-tabs"/);
  assert.match(html, /id="knowledge-inspection-feedback-form"/);
  assert.match(html, /id="knowledge-inspection-experience"/);
  assert.match(script, /\/api\/admin\/knowledge-classification\/results\/\$\{encodeURIComponent\(resultId\)\}\/experience/);
  assert.match(script, /\/api\/admin\/knowledge-classification\/results\/\$\{encodeURIComponent\(resultId\)\}\/feedback/);
  assert.match(script, /createRuleDraft:/);
  assert.match(script, /updateTeachingRule\("active"\)/);
  assert.match(script, /updateTeachingRule\("inactive"\)/);
  assert.match(script, /只有已启用规则会进入后续巡检/);
});

test("every teaching-rule status can request an audited delete", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const deleteSource = script.slice(
    script.indexOf("async function deleteTeachingRule"),
    script.indexOf("async function reviewExperienceRule"),
  );
  assert.match(html, /id="delete-teaching-rule"[^>]*>删除规则</);
  assert.doesNotMatch(deleteSource, /rule\.status\s*!==\s*"draft"/);
  assert.match(deleteSource, /rule\.status === "active"/);
  assert.match(deleteSource, /method:\s*"DELETE"/);
  assert.match(deleteSource, /审计记录已保留/);
});

test("knowledge inspection shows live two-Agent progress and preserves structured API errors", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  assert.match(script, /agent1Processed \+ agent2Processed/);
  assert.match(script, /Agent 1→2 \$\{escapeHtml\(agent1Processed\)\}/);
  assert.match(script, /error\.details = payload\.details/);
  assert.match(script, /question_version_changed: "本题在巡检后被编辑过"/);
  assert.match(script, /question_knowledge_assignment_changed: "本题的知识归属已在巡检后被人工调整"/);
  assert.match(script, /question_family_memberships_changed: "本题的题族归属已在巡检后被人工调整"/);
  assert.match(script, /question_classification_baseline_missing: "这条旧建议缺少归类基线，请重新巡检"/);
  assert.match(script, /newer_result_available: "同一题已有更新的巡检建议"/);
  assert.match(script, /打开最新建议/);
});

test("Agent 1 route clearly shows and tests its Agent 2 model fallback", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  assert.match(script, /knowledge_feature_extraction:\s*\{[\s\S]*?sceneId:\s*"knowledge_hierarchy_navigation"[\s\S]*?label:\s*"Agent 2"/);
  assert.match(script, /function effectiveSceneRoute/);
  assert.match(script, /isInherited \? "自动复用"/);
  assert.match(script, /未单独配置时自动复用/);
  assert.match(script, /const displayedRoute = binding\.inherited \? binding\.route : route/);
  assert.match(script, /syncRouteModels\(displayedRoute\.model\)/);
  assert.match(script, /async function testSceneRoute[\s\S]*?effectiveSceneRoute\(sceneId\)/);
});

test("knowledge inspection separates knowledge evidence from primary and related family decisions", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  assert.match(html, /题目知识焦点/);
  assert.match(html, /最小充分知识集/);
  assert.match(html, /主题族/);
  assert.match(html, /关联题族/);
  assert.match(html, /暂无准确题族，进入待归组/);
  assert.match(script, /function knowledgeInspectionRequiredNodes/);
  assert.match(script, /function knowledgeInspectionSuggestedFamilyMemberships/);
  assert.match(script, /function knowledgeInspectionSelectedFamilyMemberships/);
  assert.match(script, /确认知识与题族归类/);
  // DEC-100：载荷构造的唯一实现在 guard 纯函数里（老弹窗函数体已删成转发壳）。
  const guardSource = fs.readFileSync(path.resolve(__dirname, "../apps/admin/knowledge-inspection-apply-guard.js"), "utf8");
  assert.match(guardSource, /selections:\s*\[\{[\s\S]*?familyMemberships,/);
});

test("inspection shows the Agent 3 candidate family draft read-only instead of an editable form", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../apps/admin/styles.css"), "utf8");
  // DEC-100（产品手册 §4.6.12）：原来这里是一套可编辑的"新建候选题族"表单（含"人工确认创建并归入"勾选），
  // 巡检只诊断不改库后整块改成只读展示；创建候选题族只能在「完善题目」里做。
  assert.doesNotMatch(html, /id="knowledge-inspection-create-candidate-family"/);
  assert.doesNotMatch(html, /人工确认创建并归入/);
  [
    "family-draft-name",
    "family-draft-focus-key",
    "family-draft-core",
    "family-draft-required",
    "family-draft-anchors",
    "family-draft-action",
    "family-draft-inclusion",
    "family-draft-exclusion",
    "family-draft-evidence-chunks",
    "family-draft-evidence-summary",
  ].forEach((id) => assert.doesNotMatch(html, new RegExp(`id="knowledge-inspection-${id}"`)));
  assert.match(html, /id="knowledge-inspection-family-draft"[^>]*hidden/);
  const draftRenderSource = script.slice(
    script.indexOf("function renderKnowledgeInspectionCandidateFamilyDraft"),
    script.indexOf("function openKnowledgeInspection", script.indexOf("function renderKnowledgeInspectionCandidateFamilyDraft")),
  );
  assert.match(draftRenderSource, /候选题族名称/);
  assert.match(draftRenderSource, /题族判别焦点/);
  assert.match(draftRenderSource, /只读展示，不能在这里创建/);
  assert.doesNotMatch(draftRenderSource, /<input|<select|<textarea/);
  // 写路径的数据形状没有变（应用层契约仍由既有接口消费），只是不再由巡检界面提交：
  assert.match(script, /function renderKnowledgeInspectionCandidateFamilyDraft/);
  assert.match(script, /function knowledgeInspectionSelectedCandidateFamilyDraft/);
  // DEC-100：字段形状（含新建题族时的草案夹带）现在由 guard 纯函数唯一实现，巡检界面不再提交。
  const guardSource = fs.readFileSync(path.resolve(__dirname, "../apps/admin/knowledge-inspection-apply-guard.js"), "utf8");
  assert.match(guardSource, /createCandidateFamily \? \{ createCandidateFamily: true, candidateFamilyDraft \} : \{\}/);
  assert.match(script, /const isPrimary = !createCandidateFamily && input\.value === primaryFamilyId/);
  assert.match(script, /membership:\s*\{[\s\S]*?coverageRole:\s*"required",[\s\S]*?contributionKnowledgeNodeIds/);
  assert.match(script, /familyDeferred/);
  assert.match(script, /candidateFamilyDraft:\s*content\.createCandidateFamily/);
  assert.match(styles, /\.knowledge-inspection-family-draft\s*\{[\s\S]*?display:\s*grid/);
});

test("inspection candidate families separate scope from coverage and can use the full knowledge tree", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const sourceBetween = (startName, endName) => script.slice(
    script.indexOf(`function ${startName}`),
    script.indexOf(`function ${endName}`, script.indexOf(`function ${startName}`) + 1),
  );
  const selectedSource = sourceBetween("knowledgeInspectionSelectedCandidateFamilyDraft", "knowledgeInspectionCandidateFamilyDraftKey");
  const validationSource = sourceBetween("knowledgeInspectionCandidateFamilyDraftError", "knowledgeInspectionNodeLabelById");
  const renderSource = sourceBetween("renderKnowledgeInspectionCandidateFamilyDraft", "openKnowledgeInspection");

  // DEC-100（产品手册 §4.6.12）：这两句说明现在由只读展示函数输出（原来是可编辑表单的字段说明）。
  assert.match(renderSource, /后台目录锚点[\s\S]*?用于组织和检索，不会自动写入题目知识/);
  assert.match(renderSource, /题族覆盖知识[\s\S]*?这个题族稳定判别任务能够覆盖的知识/);
  assert.match(selectedSource, /const scopeAnchorNodeId = document\.querySelector\("#knowledge-inspection-family-draft-core"\)/);
  assert.match(selectedSource, /const coverageKnowledgeNodeIds = selectedValues\("#knowledge-inspection-family-draft-required"\)/);
  assert.match(selectedSource, /focusKey: document\.querySelector\("#knowledge-inspection-family-draft-focus-key"\)\?\.value\.trim\(\) \|\| ""/);
  assert.match(selectedSource, /scopeAnchorNodeId,[\s\S]*?coverageKnowledgeNodeIds,/);
  assert.doesNotMatch(selectedSource, /coverageKnowledgeNodeIds\.(?:push|add)\(scopeAnchorNodeId\)/);

  assert.match(renderSource, /const nodeMap = new Map\(\(state\.knowledgeStructure\?\.nodes \|\| \[\]\)/);
  assert.match(renderSource, /const knowledgeNodes = \[\.\.\.nodeMap\.values\(\)\]\.filter\(\(node\) => node\.id && node\.path && node\.kind === "knowledge"\)/);
  assert.match(renderSource, /const selectableNodes = knowledgeNodes\.length \? knowledgeNodes : offeredNodes/);

  assert.match(validationSource, /后台目录锚点/);
  assert.match(validationSource, /候选题族覆盖知识/);
  assert.match(validationSource, /候选题族判别焦点/);
  assert.doesNotMatch(validationSource, /knowledgeInspectionResolvedNodeId|knowledgeInspectionRequiredNodes|核心知识.*相等|最小充分知识.*相等/);
  assert.doesNotMatch(validationSource, /inclusionBoundary|exclusionBoundary/);
  assert.match(selectedSource, /inclusionBoundary:/);
  assert.match(selectedSource, /exclusionBoundary:/);
});

test("inspection family memberships submit explicit roles and per-question contributions", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const sourceBetween = (startName, endName) => script.slice(
    script.indexOf(`function ${startName}`),
    script.indexOf(`function ${endName}`, script.indexOf(`function ${startName}`) + 1),
  );
  const selectedSource = sourceBetween("knowledgeInspectionSelectedFamilyMemberships", "knowledgeInspectionCandidateFamilyDraft");
  const suggestedSource = sourceBetween("knowledgeInspectionSuggestedFamilyMemberships", "knowledgeInspectionCandidateFamilyById");
  const refreshSource = sourceBetween("knowledgeInspectionRefreshFamilyContributionRow", "renderKnowledgeInspectionCandidateContribution");
  const clickSource = sourceBetween("handleKnowledgeInspectionDialogClick", "handleKnowledgeInspectionDialogInput");
  const openSource = sourceBetween("openKnowledgeInspection", "closeKnowledgeInspectionDialog");
  const applyStart = script.indexOf("async function applyKnowledgeInspection");
  const applySource = script.slice(applyStart, script.indexOf("async function rejectKnowledgeInspection", applyStart));
  // DEC-100：老入口只剩三行转发壳；载荷构造与提交判据的唯一实现在 guard 纯函数里。
  const guard = fs.readFileSync(path.resolve(__dirname, "../apps/admin/knowledge-inspection-apply-guard.js"), "utf8");
  const guardValidateSource = guard.slice(guard.indexOf("function validateApplySelection"), guard.indexOf("function buildApplyRequest"));
  const guardBuildSource = guard.slice(guard.indexOf("function buildApplyRequest"), guard.indexOf("return { createGuard"));
  const submitSource = script.slice(
    script.indexOf("async function submitKnowledgeClassificationApply"),
    script.indexOf("function renderEnrichmentClassificationReadonly"),
  );

  // DEC-100：原来的"每个关联族需明确用途"是编辑态文案；只读态改成说明归属改动只能去「完善题目」。
  assert.match(html, /题族归属（只读展示）/);
  assert.match(html, /题族归属（主题族／关联族／新建候选题族）的修改在「完善题目」里完成/);
  assert.match(selectedSource, /const coverageRole = isPrimary \? "required" : String\(row\?\.dataset\.knowledgeFamilyCoverageRole \|\| ""\)/);
  assert.match(selectedSource, /const contributionKnowledgeNodeIds = coverageRole === "reference" \? \[\]/);
  assert.match(selectedSource, /return \{ familyId: input\.value, isPrimary, coverageRole, contributionKnowledgeNodeIds \}/);
  assert.match(suggestedSource, /const coverageRole = isPrimary \? "required"/);
  assert.match(suggestedSource, /return \{ familyId, isPrimary, coverageRole, contributionKnowledgeNodeIds \}/);
  assert.doesNotMatch(suggestedSource, /contributionKnowledgeNodeIds\s*=\s*knowledgeInspectionSelectedQuestionNodes/);

  // DEC-100（产品手册 §4.6.12）：巡检弹窗不再渲染可提交的题族用途按钮与主题族单选，
  // 题族归属改成只读展示（主题族／关联族／普通关联只能看，改在「完善题目」里做）。
  const readonlyFamilySource = sourceBetween("renderKnowledgeInspectionReadonlyFamilies", "renderKnowledgeInspectionAuditState");
  assert.doesNotMatch(openSource, /data-knowledge-family-role="/);
  assert.doesNotMatch(openSource, /data-knowledge-primary-family/);
  assert.match(readonlyFamilySource, /建议主题族（作答必需）/);
  assert.match(readonlyFamilySource, /建议关联题族（普通关联）/);
  assert.match(readonlyFamilySource, /只读展示/);
  assert.match(refreshSource, /roleControls\.hidden = !selected \|\| primary/);
  assert.match(refreshSource, /primaryRole\.hidden = !primary/);
  assert.match(refreshSource, /contribution\.hidden = !selected \|\| role !== "required"/);
  assert.match(clickSource, /row\.dataset\.knowledgeFamilyCoverageRole = roleButton\.dataset\.knowledgeFamilyRole/);
  assert.match(clickSource, /roleButton\.dataset\.knowledgeFamilyRole === "reference"[\s\S]*?knowledgeInspectionRememberFamilyContribution/);
  assert.match(clickSource, /data-use-knowledge-inspection-contribution-suggestion/);

  // DEC-100：/apply 的调用点只剩 submitKnowledgeClassificationApply 一处，载荷构造抽到
  // knowledge-inspection-apply-guard.js 的 buildApplyRequest（逐字保留原来的形状）——
  // 形状断言因此改到那份唯一实现上，老入口（applySource）则断言"不得再有 DOM 读取与载荷构造"。
  assert.match(guardBuildSource, /familyMemberships,/);
  assert.match(guardBuildSource, /createCandidateFamily \? \{ createCandidateFamily: true, candidateFamilyDraft \} : \{\}/);
  assert.match(guardBuildSource, /schemaVersion: APPLY_SCHEMA_VERSION/);
  assert.match(submitSource, /requestJson\("\/api\/admin\/knowledge-classification\/apply", \{ method: "POST", body: JSON\.stringify\(body\) \}\)/);
  assert.equal((script.match(/knowledge-classification\/apply/g) || []).length, 1, "app.js 里改库地址字符串只允许出现一次");
  assert.doesNotMatch(applySource, /querySelector|selectedNodeIds|familyMemberships|candidateFamilyDraft/, "老入口不得再读 DOM 或构造载荷");
  assert.match(applySource, /return openEnrichmentClassification\(/, "老入口只能是转发到「完善题目」的壳");
});

test("inspection family coverage validates member contributions and only requires a core focus", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const sourceBetween = (startName, endName) => script.slice(
    script.indexOf(`function ${startName}`),
    script.indexOf(`function ${endName}`, script.indexOf(`function ${startName}`) + 1),
  );
  const candidateSource = sourceBetween("knowledgeInspectionSelectedCandidateFamilyDraft", "knowledgeInspectionCandidateFamilyDraftKey");
  const auditSource = sourceBetween("knowledgeInspectionFamilyCoverageAudit", "knowledgeInspectionFamilyCoverageError");
  const errorSource = sourceBetween("knowledgeInspectionFamilyCoverageError", "syncKnowledgeInspectionFamilyCoverageSummary");
  const summarySource = sourceBetween("syncKnowledgeInspectionFamilyCoverageSummary", "setKnowledgeInspectionCandidateFamilyDraftEnabled");

  assert.match(html, /id="knowledge-inspection-family-coverage-summary"[^>]*aria-live="polite"/);
  // DEC-100（产品手册 §4.6.12）："候选题族的本题贡献"下拉是可提交控件，随只读化一起移除；
  // 覆盖校验（下面那些断言）仍是写路径契约的一部分，保留在服务端与校验函数里。
  assert.doesNotMatch(html, /id="knowledge-inspection-candidate-contribution"/);
  assert.match(candidateSource, /membership:\s*\{[\s\S]*?coverageRole:\s*"required",[\s\S]*?contributionKnowledgeNodeIds/);
  assert.match(auditSource, /contributionKnowledgeNodeIds: candidateFamilyDraft\.membership\?\.contributionKnowledgeNodeIds \|\| \[\]/);
  assert.match(auditSource, /const expectedNodes = expectedIds\.map/);
  assert.match(auditSource, /const role = isPrimary \? "required" : String\(membership\.coverageRole \|\| ""\)/);
  assert.match(auditSource, /if \(role === "reference"\) \{[\s\S]*?return;/);
  assert.match(auditSource, /knowledgeInspectionFamilyCoverageNodes\(family, result\)/);
  assert.match(auditSource, /blindGoldKnowledgeNodeIsWithin\(expectedNode, contributionNode\)/);
  assert.match(auditSource, /blindGoldKnowledgeNodeCovers\(coveredNode, contributionNode\)/);
  assert.match(auditSource, /contributors\.push\(\.\.\.contributionIds\)/);
  assert.match(auditSource, /const missingIds = expectedIds\.filter/);
  assert.match(auditSource, /const extraIds = actualIds\.filter/);
  assert.match(auditSource, /const primaryMissingFocus = Boolean\(primaryNodeRole === "core" && primaryNodeId && themeFound && !themeContributionIds[\s\S]*blindGoldKnowledgeNodeCovers/);
  assert.match(auditSource, /!missingIds\.length && !extraIds\.length && !primaryMissingFocus/);
  assert.match(errorSource, /主题族必须承载题目知识焦点/);
  assert.match(summarySource, /联合覆盖 \$\{escapeHtml\(coveredCount\)\}\/\$\{escapeHtml\(audit\.expectedIds\.length\)\}/);
  assert.match(summarySource, /普通关联 \$\{escapeHtml\(audit\.referenceCount \|\| 0\)\} 个，不计入联合覆盖/);
});

test("inspection keeps a scope anchor outside required knowledge and submits its role", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const applyStart = script.indexOf("async function applyKnowledgeInspection");
  const applyEnd = script.indexOf("async function rejectKnowledgeInspection", applyStart);
  const applySource = script.slice(applyStart, applyEnd);
  const guard = fs.readFileSync(path.resolve(__dirname, "../apps/admin/knowledge-inspection-apply-guard.js"), "utf8");
  const guardValidateSource = guard.slice(guard.indexOf("function normalizeApplySelection"), guard.indexOf("function buildApplyRequest"));
  const requiredStart = script.indexOf("function knowledgeInspectionRequiredNodes");
  const requiredEnd = script.indexOf("function knowledgeInspectionCurrentPath", requiredStart);
  const requiredSource = script.slice(requiredStart, requiredEnd);

  assert.match(html, /id="knowledge-inspection-primary-node-role"/);
  // DEC-100：角色单选（value="core"／value="scope_anchor" 的 radio）随只读化移除，角色只作只读展示；
  // 角色的语义与写路径校验保留在 guard 纯函数（validateApplySelection）与完善题目侧。
  assert.doesNotMatch(html, /knowledge-inspection-primary-node-role"[^>]*role="radiogroup"/);
  assert.match(script, /范围锚点（不计入最小充分知识集）/);
  assert.match(requiredSource, /primaryNodeRole === "core"/);
  assert.match(requiredSource, /primaryNodeRole === "scope_anchor" && node\.id === primaryId/);
  assert.match(guardValidateSource, /primaryNodeRole === "core" && !selection\.selectedNodeIds\.includes\(selection\.selectedPrimary\)/);
  assert.match(guardValidateSource, /primaryNodeRole === "scope_anchor" && selection\.selectedNodeIds\.includes\(selection\.selectedPrimary\)/);
  assert.match(guardValidateSource, /primaryNodeRole: normalizeApplyPrimaryNodeRole\(selection\.primaryNodeRole\)/);
  // 完善题目侧也提交同一个角色字段（界面上的 core／scope_anchor 单选）。
  assert.match(html, /name="question-enrichment-primary-node-role" value="scope_anchor"/);
  assert.match(script, /const primaryNodeRole = normalizeQuestionFingerprintPrimaryNodeRole\(document\.querySelector\('input\[name="question-enrichment-primary-node-role"\]:checked'\)\?\.value\)/);
});

test("inspection role changes immediately normalize required knowledge and refresh coverage", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const handlerStart = script.indexOf("function handleKnowledgeInspectionChoiceChange");
  const handlerEnd = script.indexOf("function handleKnowledgeInspectionFamilyChoiceChange", handlerStart);
  const handlerSource = script.slice(handlerStart, handlerEnd);

  // DEC-100：只读弹窗里已没有角色单选，change 监听随写控件一起摘除
  //（处理函数体保留，供写路径与静态契约继续引用）。
  assert.doesNotMatch(script, /#knowledge-inspection-primary-node-role"\)\.addEventListener/);
  assert.match(handlerSource, /primaryNodeRole === "core"\) input\.checked = true/);
  assert.match(handlerSource, /primaryNodeRole === "scope_anchor"\) input\.checked = false/);
  assert.match(handlerSource, /input\.disabled = isPrimary && primaryNodeRole === "core"/);
  assert.match(handlerSource, /syncKnowledgeInspectionFamilyRows\(\)/);
  assert.match(handlerSource, /updateKnowledgeInspectionApplyButton\(\)/);
  assert.match(handlerSource, /syncKnowledgeInspectionAdjustmentReason\(\)/);
  const familySyncStart = script.indexOf("function syncKnowledgeInspectionFamilyRows");
  const familySyncEnd = script.indexOf("function handleKnowledgeInspectionContributionOptionChange", familySyncStart);
  assert.match(script.slice(familySyncStart, familySyncEnd), /syncKnowledgeInspectionFamilyCoverageSummary\(\)/);
});

test("inspection coverage resolves canonical aliases and never counts the scope anchor", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const helpers = script.slice(
    script.indexOf("function knowledgeInspectionResolveKnowledgeNode"),
    script.indexOf("function knowledgeInspectionSelectedQuestionNodes"),
  );
  const audit = script.slice(
    script.indexOf("function knowledgeInspectionFamilyCoverageAudit"),
    script.indexOf("function knowledgeInspectionFamilyCoverageError"),
  );
  assert.match(helpers, /blindGoldKnowledgeNodeIds\(node\)\.includes\(id\)/);
  assert.match(helpers, /blindGoldKnowledgeNodesCompatible/);
  assert.match(helpers, /coverageKnowledge \|\| family\.requiredKnowledge/);
  assert.doesNotMatch(helpers, /scopeAnchorNodeId|coreKnowledgeNodeId|textbookAnchorNodeIds/);
  assert.match(audit, /blindGoldKnowledgeNodeIsWithin\(expectedNode, contributionNode\)/);
  assert.match(audit, /blindGoldKnowledgeNodeCovers\(coveredNode, contributionNode\)/);
});

test("missing inspection contributions stay empty until the reviewer adopts a suggestion", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const defaultSource = script.slice(
    script.indexOf("function knowledgeInspectionDefaultContributionNodeIds"),
    script.indexOf("function knowledgeInspectionFamilyCoverageAudit"),
  );
  const pickerSource = script.slice(
    script.indexOf("function knowledgeInspectionContributionCandidates"),
    script.indexOf("function knowledgeInspectionSelectedFamilyMemberships"),
  );
  assert.match(defaultSource, /return knowledgeInspectionStoredFamilyContribution/);
  assert.doesNotMatch(defaultSource, /filter\(\(nodeId\) => coverage\.has/);
  assert.match(pickerSource, /function knowledgeInspectionContributionSuggestionNodeIds/);
  assert.match(pickerSource, /data-use-knowledge-inspection-contribution-suggestion/);
  assert.match(pickerSource, /采用建议/);
});

test("inspection contribution picker keeps reviewed and historical knowledge searchable during directory drift", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const source = script.slice(
    script.indexOf("function knowledgeInspectionContributionCandidates"),
    script.indexOf("function knowledgeInspectionContributionSuggestionNodeIds"),
  );

  assert.match(source, /const matchedQuestionNodes = questionNodes\.filter/);
  assert.match(source, /return blindGoldUniqueKnowledgeNodes\(\[\s*\.\.\.matchedQuestionNodes,\s*\.\.\.questionNodes,\s*\.\.\.selectedNodes,/);
});

test("inspection idempotency keys include family roles and member contributions", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  const sourceBetween = (startName, endName) => script.slice(
    script.indexOf(`function ${startName}`),
    script.indexOf(`function ${endName}`, script.indexOf(`function ${startName}`) + 1),
  );
  const selectionKeySource = sourceBetween("knowledgeInspectionFamilySelectionKey", "createKnowledgeInspectionCommitId");
  const commitKeySource = sourceBetween("getKnowledgeInspectionCommitId", "knowledgeInspectionSelectionAdjusted");
  const candidateKeySource = sourceBetween("knowledgeInspectionCandidateFamilyDraftKey", "knowledgeInspectionCandidateFamilyDraftError");

  assert.match(selectionKeySource, /membership\.coverageRole \|\| ""/);
  assert.match(selectionKeySource, /new Set\(membership\.contributionKnowledgeNodeIds \|\| \[\]\)/);
  assert.match(commitKeySource, /coverageRole: String\(membership\.coverageRole \|\| ""\)/);
  assert.match(commitKeySource, /contributionKnowledgeNodeIds: \[\.\.\.new Set\(membership\.contributionKnowledgeNodeIds \|\| \[\]\)\]/);
  assert.match(commitKeySource, /candidateFamilyDraft: content\.createCandidateFamily \? knowledgeInspectionCandidateFamilyDraftKey/);
  assert.match(candidateKeySource, /membership:\s*\{[\s\S]*?coverageRole:\s*"required",[\s\S]*?contributionKnowledgeNodeIds/);
});

test("knowledge inspection apply guard blocks close and switch until the active request finishes", () => {
  const guard = createGuard();
  const firstSession = guard.open("result-a");
  const firstRequest = guard.begin(firstSession, { resultId: "result-a", commitId: "commit-a" });

  assert.ok(firstRequest);
  assert.equal(guard.close(firstSession), false);
  assert.equal(guard.open("result-b"), null);
  assert.equal(guard.isCurrent(firstRequest), true);

  assert.equal(guard.finish(firstRequest), true);
  assert.equal(guard.close(firstSession), true);
  const secondSession = guard.open("result-b");
  assert.ok(secondSession);

  assert.equal(guard.finish(firstRequest), false);
  assert.equal(guard.close(firstSession), false);
  assert.equal(guard.currentSession(), secondSession);
});

test("knowledge inspection control lock freezes mutable controls and restores prior disabled states", () => {
  const lock = createControlLock();
  const enabledControl = { disabled: false };
  const disabledControl = { disabled: true };
  const lateControl = { disabled: false };

  lock.lock([enabledControl, disabledControl]);
  lock.lock([lateControl]);
  assert.equal(lock.isLocked(), true);
  assert.deepEqual([enabledControl.disabled, disabledControl.disabled, lateControl.disabled], [true, true, true]);

  lock.unlock();
  assert.equal(lock.isLocked(), false);
  assert.deepEqual([enabledControl.disabled, disabledControl.disabled, lateControl.disabled], [false, true, false]);
});

test("knowledge inspection apply flow wires request identity, full dialog lock, and cancel interception", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "../apps/admin/app.js"), "utf8");
  assert.match(html, /knowledge-inspection-apply-guard\.js[\s\S]*app\.js/);
  assert.match(script, /knowledgeInspectionApplyGuard\.begin\(state\.knowledgeInspectionDialogSession/);
  assert.match(script, /if \(!knowledgeInspectionApplyGuard\.isCurrent\(applyRequest\)\) return/);
  assert.match(script, /dialog\.inert = true/);
  assert.match(script, /knowledgeInspectionApplyControlLock\.lock\(dialog\.querySelectorAll\("button, input, textarea, select"\)\)/);
  assert.match(script, /addEventListener\("cancel", \(event\) => \{\s*event\.preventDefault\(\);\s*closeKnowledgeInspectionDialog\(\);/);
});
