const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * DEC-100（产品手册 §4.6.12）搬迁契约：知识依据／题族归属的改库能力从 AI 巡检弹窗搬到「完善题目」。
 * 这些用例是**静态源码 + 纯函数**两层契约：
 *  - 静态层：入口在哪、校验判据是什么、有没有出现"两处都能改库"；
 *  - 纯函数层：载荷形状与提交前校验逐条对齐后端，未放宽也未加严。
 */
const adminRoot = path.resolve(__dirname, "../apps/admin");
const appJs = fs.readFileSync(path.join(adminRoot, "app.js"), "utf8");
const html = fs.readFileSync(path.join(adminRoot, "index.html"), "utf8");
const styles = fs.readFileSync(path.join(adminRoot, "styles.css"), "utf8");
const guard = require(path.join(adminRoot, "knowledge-inspection-apply-guard.js"));

function sourceBetween(startName, endName) {
  const start = appJs.indexOf(`function ${startName}`);
  assert.notEqual(start, -1, `找不到函数 ${startName}`);
  const end = appJs.indexOf(`function ${endName}`, start + 1);
  assert.notEqual(end, -1, `找不到函数 ${endName}`);
  return appJs.slice(start, end);
}

function objectSource(startName, endName) {
  const start = appJs.indexOf(`async function ${startName}`) >= 0
    ? appJs.indexOf(`async function ${startName}`)
    : appJs.indexOf(`function ${startName}`);
  assert.notEqual(start, -1, `找不到函数 ${startName}`);
  const end = appJs.indexOf(`function ${endName}`, start + 1);
  assert.notEqual(end, -1, `找不到函数 ${endName}`);
  return appJs.slice(start, end);
}

test("改库入口：/apply 的 UI 调用点只有一处，且在完善题目侧", () => {
  const callSites = appJs.match(/knowledge-classification\/apply/g) || [];
  assert.equal(callSites.length, 1, "全文件只允许出现一次改库地址字符串");
  const submitSource = sourceBetween("submitKnowledgeClassificationApply", "renderEnrichmentClassificationReadonly");
  assert.match(submitSource, /method: "POST"/);
  // 两处前端入口都走同一个 submitter（老巡检函数复用，不再自己 fetch）。
  assert.match(appJs, /await submitKnowledgeClassificationApply\(body\)/);
  // 提交点在完善题目的确认按钮路径上。
  const applySource = objectSource("applyEnrichmentClassification", "questionEnrichmentQuery");
  assert.match(applySource, /buildApplyRequest\(\{/);
  assert.match(applySource, /familyKnowledgeProtocolVersion: blindGoldFamilyKnowledgeProtocolVersion/);
  // 老巡检入口只剩转发壳：不读 DOM、不构造载荷（否则就是"两处都能改库"）。
  const shellSource = objectSource("applyKnowledgeInspection", "rejectKnowledgeInspection");
  assert.doesNotMatch(shellSource, /querySelector|selectedNodeIds|familyMemberships|candidateFamilyDraft/);
  assert.match(shellSource, /return openEnrichmentClassification\(/);
  // 巡检侧必须保持零提交控件：弹窗里没有 apply 按钮、没有可提交的选择控件。
  assert.doesNotMatch(html, /id="apply-knowledge-inspection"/);
  assert.doesNotMatch(html, /id="knowledge-inspection-family-choices"[^>]*>\s*<input/);
});

test("改库入口：完善题目侧两个区块（知识依据 / 题族归属）齐备，且巡检侧只读", () => {
  assert.match(html, /id="question-enrichment-classification-dialog"/);
  assert.match(html, /id="question-enrichment-knowledge-basis"/);
  assert.match(html, /id="question-enrichment-knowledge-choices"/);
  assert.match(html, /id="question-enrichment-knowledge-readonly"/);
  assert.match(html, /data-enrichment-primary-role/);
  assert.match(html, /value="core"/);
  assert.match(html, /value="scope_anchor"/);
  assert.match(html, /id="question-enrichment-knowledge-role-hint"/);
  assert.match(html, /id="question-enrichment-family-ownership"/);
  assert.match(html, /id="question-enrichment-family-choices"/);
  assert.match(html, /id="question-enrichment-create-candidate-family"/);
  assert.match(html, /id="question-enrichment-family-deferred"/);
  assert.match(html, /id="apply-question-enrichment-classification"/);
  // 上半区只读：巡检结论与体检项都靠 app.js 渲染，不是可提交控件。
  assert.match(html, /id="question-enrichment-inspection-audit"/);
  assert.match(html, /id="question-enrichment-inspection-rule-findings"/);
  assert.match(html, /id="question-enrichment-inspection-empty"[^>]*>尚无巡检结论/);
  assert.match(html, /去看这道题的巡检结论/);
});

test("改库入口：完善题目行上有入口按钮，巡检侧不再有改库按钮", () => {
  const actions = objectSource("questionEnrichmentActions", "renderQuestionEnrichmentTable");
  assert.match(actions, /data-enrichment-action="adjudicate"/);
  assert.doesNotMatch(actions, /data-enrichment-action="inspection"/);
  assert.match(actions, /查看\/裁决/);
  assert.match(appJs, /if \(button\.dataset\.enrichmentAction === "adjudicate"\) await openQuestionReview\(questionId\)/);
  assert.match(appJs, /openEnrichmentClassification\(session\.id, \{ embedded: true \}\)/);
});

test("纯函数：载荷形状与后端 ClassificationCommitV1 逐字一致", () => {
  const body = guard.buildApplyRequest({
    resultId: "result-1",
    commitId: "commit-1",
    adjustmentReason: "",
    familyKnowledgeProtocolVersion: "family-knowledge-v1",
    selection: {
      selectedNodeIds: ["node-b", "node-a", "node-a"],
      selectedPrimary: "node-a",
      primaryNodeRole: "core",
      familyMemberships: [{ familyId: "fam-1", isPrimary: true, coverageRole: "reference", contributionKnowledgeNodeIds: ["node-b", "node-b"] }],
      familyDeferred: false,
      createCandidateFamily: false,
    },
  });
  assert.equal(body.schemaVersion, "ClassificationCommitV1");
  assert.equal(body.commitId, "commit-1");
  assert.deepEqual(body.resultIds, ["result-1"]);
  assert.equal(body.selections.length, 1);
  const selection = body.selections[0];
  assert.equal(selection.resultId, "result-1");
  assert.equal(selection.primaryNodeId, "node-a");
  assert.equal(selection.primaryNodeRole, "core");
  assert.deepEqual(selection.requiredNodeIds, ["node-a", "node-b"]);
  assert.equal(selection.familyKnowledgeProtocolVersion, "family-knowledge-v1");
  // 主题族恒为 required（后端也这么归一），关联族的普通关联不承担知识。
  assert.deepEqual(selection.familyMemberships, [{
    familyId: "fam-1",
    isPrimary: true,
    coverageRole: "required",
    contributionKnowledgeNodeIds: ["node-b"],
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(selection, "createCandidateFamily"), false);
  assert.equal(guard.APPLY_ENDPOINT, "/api/admin/knowledge-classification/apply");
});

test("纯函数：新建候选题族时带上草案，且协议版本随之带上", () => {
  const draft = {
    name: "辅音的发音方法",
    focusKey: "辅音发音方法·阻碍方式",
    scopeAnchorNodeId: "node-anchor",
    coverageKnowledgeNodeIds: ["node-anchor"],
    textbookAnchorNodeIds: ["node-textbook"],
    assessmentAction: "判断辅音发音方法",
    inclusionBoundary: "考查阻碍方式",
    exclusionBoundary: "不考清浊",
    textbookEvidence: { chunkIds: ["chunk-1"], summary: "教材正文" },
    reason: "没有可复用题族",
    membership: { coverageRole: "required", contributionKnowledgeNodeIds: ["node-anchor"] },
  };
  const body = guard.buildApplyRequest({
    resultId: "result-2",
    commitId: "commit-2",
    selection: {
      selectedNodeIds: ["node-anchor"],
      selectedPrimary: "node-anchor",
      primaryNodeRole: "core",
      familyMemberships: [],
      familyDeferred: false,
      createCandidateFamily: true,
      candidateFamilyDraft: draft,
    },
  });
  assert.equal(body.selections[0].createCandidateFamily, true);
  assert.deepEqual(body.selections[0].candidateFamilyDraft, draft);
  // 不新建时不得夹带草案字段（后端按 hasOwnProperty 区分）。
  const withoutDraft = guard.buildApplyRequest({
    resultId: "result-2",
    commitId: "commit-3",
    selection: { selectedNodeIds: ["node-a"], selectedPrimary: "node-a", familyDeferred: true },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(withoutDraft.selections[0], "candidateFamilyDraft"), false);
});

test("纯函数：提交前校验逐条对齐后端判据（未放宽也未加严）", () => {
  const base = { selectedNodeIds: ["node-a", "node-b"], selectedPrimary: "node-a", primaryNodeRole: "core", familyDeferred: true };
  const validate = (selection, extra = {}) => guard.validateApplySelection({ selection, ...extra });
  assert.equal(validate(base), "");
  // 1 结果不可采纳（老巡检判据）优先。
  assert.equal(validate(base, { resultBlockReason: "这条巡检结果当前不能采纳。" }), "这条巡检结果当前不能采纳。");
  // 2 最小充分知识集不能为空。
  assert.equal(validate({ ...base, selectedNodeIds: [] }), "请至少勾选一个作答必需知识");
  // 3 必须指定知识焦点。
  assert.equal(validate({ ...base, selectedPrimary: "" }), "请指定题目知识焦点");
  // 4 作答核心必须在最小充分知识集里。
  assert.equal(validate({ ...base, selectedPrimary: "node-z" }), "作答核心必须计入最小充分知识集");
  // 5 范围锚点不能计入最小充分知识集。
  assert.equal(validate({ ...base, primaryNodeRole: "scope_anchor" }), "范围锚点不能计入最小充分知识集");
  assert.equal(validate({ selectedNodeIds: ["node-b"], selectedPrimary: "node-a", primaryNodeRole: "scope_anchor", familyDeferred: true }), "");
  // 6 选了已有题族就必须指定主题族。
  const memberships = [{ familyId: "fam-1", isPrimary: false, coverageRole: "required" }];
  assert.equal(validate({ ...base, familyMemberships: memberships }), "请从已选题族中指定一个主题族");
  assert.equal(validate({ ...base, familyMemberships: [{ ...memberships[0], isPrimary: true }] }), "");
  // 7 新建题族时已有题族不能再当主题族。
  assert.equal(validate({ ...base, createCandidateFamily: true, candidateFamilyDraft: {}, familyMemberships: [{ ...memberships[0], isPrimary: true }] }), "新建题族将自动成为主题族，已有题族只能作为关联题族");
  // 8 候选题族草案缺项时用草案校验的错误（这里注入同一个错误文案）。
  assert.equal(validate({ ...base, createCandidateFamily: true, candidateFamilyDraft: {} }, { candidateDraftError: "请填写候选题族名称" }), "请填写候选题族名称");
  // 9 既不选题族也不进待归组 → 拦下。
  assert.equal(validate({ ...base, familyDeferred: false }), "请选择主题族，或明确将本题放入待归组");
  assert.equal(validate(base), "");
  // 10 覆盖缺口（题族承担知识不覆盖最小充分知识集）。
  assert.equal(validate({ ...base, familyDeferred: true }, { familyCoverageError: "题族覆盖不足：缺少 node-a" }), "题族覆盖不足：缺少 node-a");
  // 11 与 AI 建议不同必须写调整依据。
  assert.equal(validate({ ...base, familyDeferred: true }, { adjusted: true }), "你调整了 AI 建议，请填写一句调整依据，供 Agent 4 沉淀为修正案例。");
  assert.equal(validate({ ...base, familyDeferred: true }, { adjusted: true, adjustmentReason: "AI 漏了范围锚点" }), "");
  // 判据归一：未知角色按 core 处理（与 normalizeQuestionFingerprintPrimaryNodeRole 一致）。
  assert.equal(guard.normalizeApplyPrimaryNodeRole("unknown"), "core");
  assert.equal(guard.normalizeApplyPrimaryNodeRole("scope_anchor"), "scope_anchor");
});

test("完善题目侧复用后端判据：没有巡检结论时可渲染、提交被明确拦下", () => {
  const blockSource = sourceBetween("enrichmentClassificationBlockReason", "enrichmentClassificationApplyGuard");
  // 没有巡检结论时给出可执行的话术（/apply 按 resultId 落库，没有结论就没有可提交对象），且不发请求。
  assert.match(blockSource, /这道题还没有巡检结论/);
  assert.match(blockSource, /if \(!result \|\| !knowledgeInspectionResultId\(result\)\) \{/);
  assert.match(appJs, /const blockReason = enrichmentClassificationBlockReason\(selection\);\s*if \(blockReason\) \{[\s\S]*?setSmallDialogStatus\("#question-enrichment-classification-status", blockReason, "error"\);\s*return;/);
  // 静态空态也必须是同一口径（产品负责人 2026-09-26：不许许诺「不需要先跑巡检」／「可直接人工确认归属」）。
  assert.match(html, /id="question-enrichment-inspection-empty" hidden>尚无巡检结论。[\s\S]{0,150}最小充分知识集和知识焦点角色仍需巡检依据/);
  assert.doesNotMatch(html, /可直接人工确认归属/);
  assert.doesNotMatch(html, /不需要先跑巡检/);
  assert.doesNotMatch(appJs, /不需要先跑巡检/);
  assert.match(blockSource, /knowledgeInspectionApplyBlockReason\(result\)/);
  assert.match(blockSource, /knowledgeInspectionCandidateFamilyDraftError\(selection\.candidateFamilyDraft\)/);
  assert.match(blockSource, /knowledgeInspectionFamilyCoverageError\(enrichmentClassificationCoverageAudit\(selection\)\)/);
  assert.match(blockSource, /enrichmentClassificationSelectionAdjusted\(selection, result\)/);
  assert.match(blockSource, /validateApplySelection\(\{/);
  assert.match(blockSource, /adjustmentReason: document\.querySelector\("#question-enrichment-classification-adjustment-reason"\)\?\.value \|\| ""/);
  // 复用同一批纯函数，不另起一套"什么算合法"的判据。
  assert.match(appJs, /function enrichmentClassificationCoverageAudit\(selection = enrichmentClassificationSelection\(\)\)/);
  assert.match(appJs, /knowledgeInspectionFamilyCoverageAudit\(\{/);
  assert.match(appJs, /function enrichmentClassificationSelectionAdjusted\(selection, result\)/);
});

test("完善题目侧：AI 只读区复用巡检渲染函数，未巡检时走空态", () => {
  const readonlySource = sourceBetween("enrichmentClassificationReadonlyHtml", "renderEnrichmentInspectionSummary");
  assert.match(readonlySource, /knowledgeInspectionFeatureHtml\(agent1\)/);
  assert.match(readonlySource, /knowledgeInspectionTraceHtml\(agent2\)/);
  assert.match(readonlySource, /knowledgeInspectionEvidenceHtml\(agent3\)/);
  assert.match(readonlySource, /尚无巡检结论/);
  const summarySource = sourceBetween("renderEnrichmentInspectionSummary", "renderEnrichmentClassificationQuestion");
  assert.match(summarySource, /knowledgeInspectionAuditReview\(result\)/);
  assert.match(summarySource, /knowledgeInspectionRuleFindingsHtml\(result \|\| \{\}\)/);
  assert.match(summarySource, /empty\.hidden = Boolean\(result\)/);
  assert.match(summarySource, /rules\.hidden = !ruleHtml/);
  // 跳转入口＝切到 AI 巡检页并定位本题，不复制一份巡检面板。
  const jumpSource = sourceBetween("openQuestionInspectionFromEnrichment", "loadEnrichmentClassificationResult");
  assert.match(jumpSource, /setQuestionLibraryTab\("inspections"\)/);
  assert.match(jumpSource, /document\.querySelector\("#knowledge-inspection-search"\)\.value = questionId/);
});

test("完善题目侧：新增隐藏元素都有 [hidden] 兜底", () => {
  [".enrichment-field-toggle[hidden]", ".enrichment-classification-adjustment[hidden]",
    ".question-enrichment-inspection-audit[hidden]", ".question-enrichment-inspection-rule-findings[hidden]",
    ".question-enrichment-classification-draft[hidden]", ".enrichment-classification-family-detail[hidden]",
    ".enrichment-classification-contribution[hidden]",
    ".question-enrichment-classification-deterministic[hidden]", "#question-enrichment-knowledge-repeat-note[hidden]"].forEach((selector) => {
    assert.ok(styles.includes(selector), `styles.css 缺少 ${selector} { display: none; }`);
  });
  // 静态 hidden 的元素必须带能兜住的 class。
  assert.match(html, /class="question-enrichment-classification-draft" id="question-enrichment-family-draft" hidden/);
  assert.match(html, /class="enrichment-field-toggle enrichment-classification-adjustment" id="question-enrichment-classification-adjustment" hidden/);
  assert.match(html, /class="question-enrichment-classification-deterministic" id="question-enrichment-deterministic-rebuild-row" hidden/);
  assert.match(html, /id="question-enrichment-knowledge-repeat-note" hidden/);
});

test("完善题目侧：缓存版本号同值 bump", () => {
  const versions = [...html.matchAll(/\?v=([0-9.]+)/g)].map((match) => match[1]);
  assert.ok(versions.length >= 3, `?v= 出现次数异常（${versions.length}）`);
  assert.equal(new Set(versions).size, 1, `?v= 必须三处同值：${versions.join(", ")}`);
  assert.match(html, /knowledge-inspection-apply-guard\.js\?v=/);
});

// ── 2026-09-26 产品负责人三项决定：①纯缺题组／指纹的题不跑 AI ②无结论时提交按钮保持可点
//    ③无结论时「知识依据」栏保留但标明是当前值回勾。以下用例把这些口径钉在静态源码上。 ──

test("DEC-104：无结论时可进入补缺预览，且只在无结论时可见", () => {
  assert.match(html, /id="question-enrichment-deterministic-rebuild-row"/);
  assert.match(html, /id="question-enrichment-deterministic-rebuild"( type="button")?>预览并补齐缺失指纹与题族</);
  // 说明行必须讲清"纯计算、不调 AI"和"知识依据仍要巡检结论"，免得被当成"跑了一次巡检"。
  assert.match(html, /不调用 AI，不覆盖已有指纹和归属/);
  assert.match(html, /最小充分知识集和知识焦点角色仍需巡检依据/);
  // 初值 hidden（有结论的题不该看到它），由 renderEnrichmentInspectionSummary 按 result 反切。
  const summary = sourceBetween("renderEnrichmentInspectionSummary", "renderEnrichmentClassificationQuestion");
  assert.match(summary, /#question-enrichment-deterministic-rebuild-row/);
  assert.match(summary, /rebuildRow\.hidden = Boolean\(result\)/);
  // 绑定与实现。
  assert.match(appJs, /#question-enrichment-deterministic-rebuild"\)\.addEventListener\("click", rebuildEnrichmentDeterministic\)/);
});

test("DEC-104：单题补齐只打开预览，不直接重建或提交", () => {
  const source = sourceBetween("rebuildEnrichmentDeterministic", "applyEnrichmentClassification");
  assert.match(source, /libraryWorkspace\.openCompletion\(\[questionId\]\)/);
  assert.doesNotMatch(source, /requestJson|knowledge-classification\/apply|submitKnowledgeClassificationApply/);
  assert.match(source, /if \(!questionId\) return/);
});

test("题族候选只有一处装配：有结论用服务端候选，无结论用题族库（服务端筛选，前端不重算）", () => {
  const helper = sourceBetween("enrichmentClassificationFamilyCandidates", "loadEnrichmentFamilyCandidates");
  assert.match(helper, /knowledgeInspectionAgent\(result, 3\)\.candidateFamilies/);
  assert.match(helper, /state\.enrichmentClassificationFamilyCandidates/);
  // 渲染器不再自己读 agent3（否则就是第二份候选装配逻辑）。
  const renderSource = sourceBetween("renderEnrichmentFamilyChoices", "enrichmentClassificationFamilyCandidates");
  assert.doesNotMatch(renderSource, /knowledgeInspectionAgent\(result, 3\)\.candidateFamilies/);
  assert.match(renderSource, /const candidateFamilies = enrichmentClassificationFamilyCandidates\(result\)/);
  // 无结论分支的候选来源：同一条题族接口契约，bookId 固定成"这道题的教材"。
  const loader = sourceBetween("loadEnrichmentFamilyCandidates", "renderEnrichmentCandidateFamilyDraft");
  assert.match(loader, /requestJson\(`\/api\/admin\/question-families\?\$\{query\}`\)/);
  assert.match(loader, /new URLSearchParams\(\{ bookId, status: "all"/);
  assert.match(loader, /knowledgeNodeId/);
});

test("决定 1 + B：无结论时提交只写题族归属，绝不写知识依据", () => {
  const applySource = sourceBetween("applyEnrichmentClassification", "setEnrichmentClassificationLocked");
  assert.match(applySource, /if \(!knowledgeInspectionResultId\(result\)\) return applyEnrichmentFamilyMembershipOnly\(questionId, selection\);/);
  const source = sourceBetween("applyEnrichmentFamilyMembershipOnly", "rebuildEnrichmentDeterministic");
  // 写入口是题族库自己的成员接口，不是结果驱动的改库接口。
  assert.match(source, /requestJson\(`\/api\/admin\/question-families\/\$\{encodeURIComponent\(familyId\)\}\/members`, \{/);
  assert.match(source, /body: JSON\.stringify\(\{ questionIds: \[questionId\] \}\)/);
  assert.doesNotMatch(source, /knowledge-classification\/apply|submitKnowledgeClassificationApply/);
  // 三种出路的中文口径，且必须说清"只写了题族归属"。
  assert.match(source, /本次只写了题族归属/);
  assert.match(source, /最小充分知识集／知识焦点角色需要巡检结论，没有写。/);
  assert.match(source, /已放入待归组（没有写入题族关系）/);
  assert.match(source, /无巡检结论时不能新建候选题族/);
  assert.match(source, /无巡检结论时只能写题族归属/);
  // 部分失败不许静默：逐条报出成功与失败。
  assert.match(source, /部分写入：已加入 \$\{written\.length\} 个题族/);
});

test("决定 3：无结论时「1. 知识依据」栏常显「当前值回勾」标注", () => {
  assert.match(html, /id="question-enrichment-knowledge-repeat-note" hidden>无巡检结论：下面是<b>题目当前知识点<\/b>的回勾/);
  assert.match(html, /不是新建议，也不表示指纹已确认/);
  assert.match(html, /指纹请到「题目详情」人工核对并保存/);
  assert.match(html, /id="question-enrichment-edit-fingerprint"/);
  const note = sourceBetween("renderEnrichmentKnowledgeRepeatNote", "enrichmentClassificationSelection");
  assert.match(note, /#question-enrichment-knowledge-repeat-note/);
  assert.match(note, /note\.hidden = Boolean\(result\)/);
  // 必须由巡检摘要渲染器每次都切到（否则打开有结论的题时会误显）。
  const summary = sourceBetween("renderEnrichmentInspectionSummary", "renderEnrichmentClassificationQuestion");
  assert.match(summary, /renderEnrichmentKnowledgeRepeatNote\(result\)/);
});

test("决定 2：无结论时「确认并写入」保持可点（静态禁止 disabled 写法）", () => {
  // 只锁"按 id 显式禁用"这一种写法；提交期间的整窗锁是按 class/控件批量锁的，不在此列。
  assert.doesNotMatch(appJs, /#apply-question-enrichment-classification"\)[\s\S]{0,200}?\.disabled\s*=/);
  assert.doesNotMatch(appJs, /apply-question-enrichment-classification[\s\S]{0,80}?\.disabled\s*=\s*true/);
  assert.match(appJs, /knowledgeInspectionApplyControlLock\.lock\(dialog\.querySelectorAll\("button, input, textarea, select"\)\)/);
  // 无结论时点它必须给中文原因（而不是静默失败）。
  const source = sourceBetween("applyEnrichmentFamilyMembershipOnly", "rebuildEnrichmentDeterministic");
  assert.match(source, /setSmallDialogStatus\("#question-enrichment-classification-status",[\s\S]*?"error"\)/);
});

test("E：题目知识点只映射到知识树里的真实节点，匹配不到就不进候选", () => {
  const nodes = sourceBetween("enrichmentClassificationNodes", "enrichmentClassificationQuestionKnowledgePoints");
  // 以前匹配不上会把纯文本当节点 id（假节点），现在禁止这个兜底。
  assert.doesNotMatch(nodes, /id: String\(point\)/);
  assert.doesNotMatch(nodes, /path: String\(point\)/);
  assert.match(nodes, /matchKnowledgeNodeByPoint\(point\)/);
  const match = sourceBetween("matchKnowledgeNodeByPoint", "enrichmentClassificationUnmatchedKnowledgePoints");
  assert.match(match, /enrichmentClassificationStructureNodes\(\)/);
  assert.match(match, /const exactTitle = pool\.find\(\(node\) => titleOf\(node\) === text\)/);
  assert.match(match, /const exactPath = pool\.find/);
  assert.match(match, /title\.includes\(text\) \|\| text\.includes\(title\)/);
  assert.match(match, /return null/);
  // 只有 kind === "knowledge" 的节点才是合法归属（后端 knowledge_assignment_node_required 同一口径）。
  const pool = sourceBetween("enrichmentClassificationStructureNodes", "matchKnowledgeNodeByPoint");
  assert.match(pool, /node\.kind === "knowledge"/);
  // 匹配不到的知识点要单独提示，不许静默丢弃。
  const renderSource = sourceBetween("renderEnrichmentKnowledgeChoices", "renderEnrichmentKnowledgeRepeatNote");
  assert.match(renderSource, /enrichmentClassificationUnmatchedKnowledgePoints\(result\)/);
  assert.match(renderSource, /id="question-enrichment-unmatched-knowledge"/);
  assert.match(renderSource, /这些知识点在知识树里没有对应节点，没有进候选/);
});
