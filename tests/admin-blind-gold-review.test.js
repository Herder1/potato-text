const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "apps/admin/index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "apps/admin/app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "apps/admin/styles.css"), "utf8");

function functionSource(name, nextName) {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} should exist`);
  assert.ok(end > start, `${nextName} should follow ${name}`);
  return script.slice(start, end);
}

test("blind gold review exposes an explicit official-question version sync step", () => {
  assert.match(html, /id="edit-blind-gold-business-data"[^>]*>修正正式题目并形成新版本</);
  assert.match(html, /id="blind-gold-business-sync"/);
  assert.match(html, /id="blind-gold-business-note"/);
  assert.match(html, /id="sync-blind-gold-business-data"/);
  assert.match(html, /id="blind-gold-content-stage-state"/);
  assert.match(html, /id="blind-gold-family-stage-state"/);
  assert.match(styles, /\.blind-gold-review-form\.is-business-editing \.blind-gold-business-sync/);
  assert.match(script, /已保存审核基线与正式题目版本/);
  assert.doesNotMatch(script, /与当前金标草稿同步/);
});

test("business corrections use the atomic business-content contract and version guards", () => {
  const source = functionSource("syncBlindGoldBusinessContent", "setBlindGoldReviewResult");
  assert.match(source, /\/business-content`/);
  assert.match(source, /expectedRevision:\s*item\.revision/);
  assert.match(source, /expectedQuestionVersion:\s*previousVersion/);
  assert.match(source, /result:\s*"corrected"/);
  assert.match(source, /questionPatch:\s*\{/);
  assert.match(source, /knowledgeAssignment:\s*\{/);
  assert.match(source, /primaryNodeId:\s*answerKnowledge\.coreKnowledge\.id/);
  assert.match(source, /primaryNodeRole:\s*answerKnowledge\.coreKnowledgeRole/);
  assert.match(source, /requiredNodeIds:\s*answerKnowledge\.requiredKnowledge/);
  assert.match(source, /旧题族审核已失效，请现在独立审核题族裁决/);
  assert.doesNotMatch(source, /blind-replay|blindReplay|knowledge-classification\/results\/.*apply/);
});

test("content and family reviews are submitted as separate human actions", () => {
  const source = functionSource("saveBlindGoldReview", "freezeBlindGoldReviewSet");
  const contentCall = source.indexOf("/content`");
  const returnAfterContent = source.indexOf("return;", contentCall);
  const familyCall = source.indexOf("/family`");
  assert.ok(contentCall >= 0);
  assert.ok(returnAfterContent > contentCall);
  assert.ok(familyCall > returnAfterContent, "family request must be unreachable in the content-review action");
  assert.match(source, /题族仍是待审核状态/);
  assert.match(source, /答案、证据与知识不会被重复写入/);
  assert.match(source, /const answerKnowledge = blindGoldReviewCollectAnswerKnowledge\(item\)/);
  assert.match(source, /selectedEvidenceChunkIds/);
  assert.doesNotMatch(source, /const answerKnowledge = item\.answerKnowledge \|\| \{\}/);
  assert.doesNotMatch(source, /正在依次保存两阶段审核/);
});

test("content review validates every independent human-gold field before submission", () => {
  const source = functionSource("saveBlindGoldReview", "renderBlindGoldFreezePreview");
  assert.match(source, /classification_gold_review_human_evidence_required/);
  assert.match(source, /classification_gold_review_human_evidence_selection_invalid/);
  assert.match(source, /classification_gold_review_human_knowledge_required/);
  assert.match(source, /classification_gold_review_human_option_knowledge_required/);
  assert.match(source, /classification_gold_review_human_scoring_points_required/);
  assert.match(script, /classification_gold_review_human_option_knowledge_required:\s*"[^"\n]*逐项确认[^"\n]*另有选项知识[^"\n]*暂无法判断[^"\n]*(?:不确定说明|原因)[^"\n]*"/);
});

test("composed gold guard errors explain formal versioning and wrapper-role boundaries", () => {
  assert.match(script, /classification_gold_review_composed_structure_changed:\s*"[^"\n]*组合题[^"\n]*正式题目[^"\n]*新版本[^"\n]*"/);
  assert.match(script, /classification_gold_review_composed_option_knowledge_forbidden:\s*"[^"\n]*A-D[^"\n]*组合映射[^"\n]*答案角色[^"\n]*不能保存知识关系[^"\n]*原子陈述[^"\n]*"/);
});

test("business correction controls cannot masquerade as an editable gold-only draft", () => {
  const editSource = functionSource("beginBlindGoldBusinessEdit", "cancelBlindGoldBusinessEdit");
  assert.match(editSource, /不会只修改金标草稿/);
  assert.match(script, /classification_gold_review_question_version_conflict/);
  assert.match(script, /classification_gold_review_knowledge_assignment_invalid/);
  assert.match(styles, /#blind-gold-business-change-note\[hidden\]/);
  assert.match(styles, /\.blind-gold-business-sync-actions\[hidden\]/);
  assert.match(html, /id="blind-gold-answer-source"[^>]*>[\s\S]*?value="pdf_answer"[\s\S]*?value="team_verified"[\s\S]*?value="ai_supplement"[\s\S]*?value="community_consensus"/);
  assert.doesNotMatch(html, /id="blind-gold-answer-source"[^>]*type="text"/);
});

test("option knowledge and scoring points record formal business-correction provenance", () => {
  const source = functionSource("blindGoldReviewCollectAnswerKnowledge", "blindGoldReviewCollectFamilyGold");
  const matches = source.match(/state\.blindGoldBusinessEditMode \? "human_business_correction"/g) || [];
  assert.ok(matches.length >= 2);
  const goldMatches = source.match(/state\.blindGoldContentEditable \? "human_gold_review"/g) || [];
  assert.ok(goldMatches.length >= 2);
  assert.doesNotMatch(source, /state\.blindGoldReviewResult === "corrected" \? "human_gold_review"/);
});

test("gold-only content revision is explicit, remains corrected, and never opens formal-question editing", () => {
  assert.match(html, /id="edit-blind-gold-content-review"[^>]*>对照 AI 后修订阶段 1</);
  assert.match(html, /id="add-blind-gold-scoring-point"/);
  const beginSource = functionSource("beginBlindGoldContentEdit", "cancelBlindGoldBusinessEdit");
  assert.match(beginSource, /state\.blindGoldContentEditable = true/);
  assert.match(beginSource, /state\.blindGoldReviewResult = "corrected"/);
  assert.match(beginSource, /#blind-gold-review-note"\)\.value = ""/);
  assert.match(beginSource, /结果固定为“人工修正”/);
  assert.doesNotMatch(beginSource, /beginBlindGoldBusinessEdit|blindGoldBusinessEditMode = true|\/business-content/);
  const resultSource = functionSource("setBlindGoldReviewResult", "updateBlindGoldReviewItem");
  assert.match(resultSource, /blindGoldReviewStageIsComplete\(item\?\.contentReview\) && state\.blindGoldContentEditable\) result = "corrected"/);
  assert.doesNotMatch(resultSource, /beginBlindGoldBusinessEdit/);
  assert.match(script, /#edit-blind-gold-content-review"\)\.addEventListener\("click", beginBlindGoldContentEdit\)/);
  assert.match(styles, /#edit-blind-gold-content-review\[hidden\]/);
  assert.match(styles, /\.blind-gold-content-edit-actions/);
});

test("first-stage edits do not choose a verdict while post-review edits stay corrected", () => {
  const source = functionSource("markBlindGoldContentChanged", "syncBlindGoldBusinessContent");
  assert.match(source, /const revisingCompletedContent = blindGoldReviewStageIsComplete\(item\.contentReview\)/);
  assert.match(source, /if \(revisingCompletedContent\) \{[\s\S]*?state\.blindGoldReviewResult = "corrected"/);
  assert.doesNotMatch(source, /if \(!revisingCompletedContent\)[\s\S]*?state\.blindGoldReviewResult/);
  assert.match(source, /可记录人工选择或调整证据、选项知识、得分点的依据/);
});

test("subjective scoring points can be added, edited, and removed inside the human gold stage", () => {
  const addSource = functionSource("addBlindGoldScoringPoint", "removeBlindGoldScoringPoint");
  const removeSource = functionSource("removeBlindGoldScoringPoint", "markBlindGoldContentChanged");
  assert.match(addSource, /blindGoldScoringPointRowHtml/);
  assert.match(addSource, /markBlindGoldContentChanged/);
  assert.match(removeSource, /closest\("\[data-blind-gold-scoring-point\]"\)\?\.remove\(\)/);
  assert.match(script, /#add-blind-gold-scoring-point"\)\.addEventListener\("click", addBlindGoldScoringPoint\)/);
  assert.match(script, /data-blind-gold-remove-scoring-point/);
  assert.match(styles, /\.blind-gold-scoring-point-row/);
});

test("fill-blank questions do not get blocked by the subjective scoring-point guard", () => {
  const typeSource = functionSource("blindGoldQuestionRequiresScoringPoints", "blindGoldReviewItemResult");
  const saveSource = functionSource("saveBlindGoldReview", "freezeBlindGoldReviewSet");
  assert.match(typeSource, /subjectiveQuestionTypes\.has\(String\(question\.type \|\| ""\)\.trim\(\)\)/);
  assert.match(saveSource, /blindGoldQuestionRequiresScoringPoints\(item\.question\)/);
  assert.match(saveSource, /classification_gold_review_human_scoring_points_required/);
});

test("formal business sync carries the explicit human textbook-evidence selection", () => {
  const source = functionSource("syncBlindGoldBusinessContent", "setBlindGoldReviewResult");
  assert.match(source, /const selectedEvidenceChunkIds = answerKnowledge\.textbookEvidence\.map/);
  assert.match(source, /answerKnowledge,[\s\S]*?selectedEvidenceChunkIds,[\s\S]*?questionPatch/);
  assert.match(source, /evidenceChunkIds: selectedEvidenceChunkIds/);
});

test("each selected textbook loads its full knowledge tree and official family catalog", () => {
  const source = functionSource("ensureBlindGoldReviewCatalog", "loadBlindGoldReviewSets");
  assert.match(script, /blindGoldKnowledgeStructures:\s*new Map\(\)/);
  assert.match(script, /blindGoldFamilyCatalogs:\s*new Map\(\)/);
  assert.match(source, /\/api\/admin\/knowledge-structure\?bookId=\$\{encodeURIComponent\(bookId\)\}&generate=true/);
  assert.match(source, /\/api\/admin\/question-family-options\?bookId=\$\{encodeURIComponent\(bookId\)\}/);
  assert.match(source, /state\.blindGoldKnowledgeStructures\.set\(bookId/);
  assert.match(source, /state\.blindGoldFamilyCatalogs\.set\(bookId/);
  assert.match(script, /state\.blindGoldKnowledgeStructures\.get\(item\?\.question\?\.bookId/);
  assert.match(script, /state\.blindGoldFamilyCatalogs\.get\(item\?\.question\?\.bookId/);
});

test("stale blind-gold catalog responses do not repaint the review or claim success", () => {
  const source = functionSource("ensureBlindGoldReviewCatalog", "loadBlindGoldReviewSets");
  assert.match(source, /const catalogLoaded = await request/);
  assert.match(source, /if \(!catalogLoaded\) return false/);
  assert.match(source, /renderBlindGoldReviewDetail\(\);\s*initializeBlindGoldKnowledgePickers\(\);/);
});

test("cross-knowledge gold can choose related families from the full textbook catalog", () => {
  assert.match(html, /data-blind-gold-family-picker/);
  assert.match(html, /data-blind-gold-family-trigger/);
  assert.match(html, /placeholder="搜索题族名称或教材位置"/);
  assert.match(html, /data-blind-gold-family-options/);
  assert.match(html, /id="blind-gold-related-families"[^>]*multiple hidden/);
  assert.doesNotMatch(html, /id="blind-gold-related-families"[^>]*size=/);
  const selectedSource = functionSource("blindGoldRelatedFamilyRelationsFromSelect", "blindGoldRelatedFamilyRelationSignature");
  const source = functionSource("blindGoldReviewCollectFamilyGold", "beginBlindGoldBusinessEdit");
  assert.match(selectedSource, /#blind-gold-related-families/);
  assert.match(selectedSource, /selectedOptions/);
  assert.match(source, /relatedFamilyIds\.forEach/);
  assert.match(source, /relatedFamilyIds,/);
  assert.match(source, /const familyMap = new Map\(\);/);
  assert.doesNotMatch(source, /new Map\(\(item\.familyGold\?\.families/);
  assert.match(source, /decision === "join_existing"/);
});

test("formal family catalog overlays the current item's historical snapshot", () => {
  const source = functionSource("blindGoldReviewFamilies", "blindGoldReviewFamilyById");
  const storedSnapshot = source.indexOf("blindGoldReviewStoredFamilyGold(item)");
  const formalCatalog = source.indexOf("state.blindGoldFamilyCatalogs.get");
  assert.ok(storedSnapshot >= 0 && formalCatalog > storedSnapshot);
  assert.match(source, /storedFamilyGold\.families[\s\S]*?addFamily\(family, "historical_snapshot"\)/);
  assert.match(source, /state\.blindGoldFamilyCatalogs\.get\([\s\S]*?addFamily\(family, "current_catalog"\)/);
  assert.match(source, /if \(source === "current_catalog"\)/);
  assert.doesNotMatch(source, /state\.blindGoldReviewBatch\?\.items/);
});

test("primary family selection uses the searchable downward popup", () => {
  assert.match(html, /data-question-family-multiselect="blind-gold-primary"/);
  assert.match(html, /id="blind-gold-primary-family-panel"[^>]*popover="auto"/);
  assert.match(html, /data-question-family-multiselect-search[^>]*placeholder="搜索题族名称或教材位置"/);
  assert.match(html, /id="blind-gold-existing-family-field"/);
  assert.match(html, /id="blind-gold-existing-family" hidden/);
  assert.match(script, /type === "blind-gold-primary"/);
  assert.match(script, /renderQuestionFamilyMultiselect\("blind-gold-primary"\)/);
  assert.match(script, /const familyLabel = `\$\{family\.name \|\| family\.id\}\$\{family\.knowledgePath \? ` · \$\{family\.knowledgePath\}` : ""\}\$\{statusLabel\}`/);
  assert.match(styles, /\.blind-gold-primary-family-picker \.question-family-multiselect-panel/);
});

test("related-family gold uses a searchable custom multiselect with compact coverage roles", () => {
  const pickerSource = functionSource("blindGoldRelatedFamilyPickerRoot", "blindGoldReviewKnowledgeSummary");
  const decisionSource = functionSource("syncBlindGoldFamilyDecision", "blindGoldReviewNextPendingItem");
  const eligibilitySource = functionSource("syncBlindGoldFamilyOptionEligibility", "syncBlindGoldFamilyDecision");
  const editSource = functionSource("setBlindGoldReviewEditState", "renderBlindGoldReviewDetail");
  assert.match(pickerSource, /option\.selected[\s\S]*?!query[\s\S]*?option\.textContent\.toLocaleLowerCase/);
  assert.match(pickerSource, /visible\.sort\(\(left, right\) => Number\(right\.selected\) - Number\(left\.selected\)/);
  assert.match(pickerSource, /data-blind-gold-family-option type="checkbox"/);
  assert.match(pickerSource, /data-blind-gold-family-role="required"/);
  assert.match(pickerSource, /data-blind-gold-family-role="reference"/);
  assert.match(pickerSource, /aria-pressed="\$\{coverageRole === "required"\}"/);
  assert.match(pickerSource, /作答必需/);
  assert.match(pickerSource, /普通关联/);
  assert.match(pickerSource, /blindGoldRelatedFamilySelectionLimit = 30/);
  assert.match(pickerSource, /selectionLimitReached && !option\.selected/);
  assert.match(pickerSource, /没有匹配的题族/);
  assert.match(pickerSource, /positionQuestionFamilyMultiselect\(root\)/);
  assert.match(decisionSource, /syncBlindGoldFamilyOptionEligibility\(primaryFamilyId\)/);
  assert.match(script, /option\.dataset\.familyStatus === "pending_review"/);
  assert.match(eligibilitySource, /option\.dataset\.blindGoldDisabledReason = historicalSnapshot[\s\S]*?isPrimary \? "primary"/);
  assert.match(decisionSource, /renderBlindGoldRelatedFamilyPicker\(\)/);
  assert.match(editSource, /data-blind-gold-family-trigger[\s\S]*?disabled = !familyEditable/);
  assert.match(script, /option\.selected = familyOption\.checked;[\s\S]*?renderBlindGoldRelatedFamilyPicker\(\)/);
  assert.match(script, /selectedCount >= blindGoldRelatedFamilySelectionLimit[\s\S]*?最多选择/);
  assert.match(script, /data-blind-gold-family-role[\s\S]*?option\.dataset\.coverageRole = coverageRole/);
  assert.match(script, /option\.dataset\.requiredForAnswer = String\(coverageRole === "required"\)/);
  assert.match(script, /data-blind-gold-knowledge-picker\], \[data-blind-gold-family-picker\]/);
  assert.match(script, /event\.key !== "Escape"[\s\S]*?setBlindGoldRelatedFamilyPickerOpen\(false\)/);
  assert.match(script, /root\.matches\("\[data-blind-gold-knowledge-picker\], \[data-blind-gold-family-picker\](?:, \.blind-gold-primary-family-picker)?"\)/);
  assert.match(styles, /\.blind-gold-family-picker \.question-family-multiselect-trigger/);
  assert.match(styles, /\.blind-gold-family-coverage-role button\[aria-pressed="true"\]/);
});

test("related-family coverage roles preserve legacy gold and submit the explicit V3 contract", () => {
  const compatibilitySource = functionSource("blindGoldRelatedFamilyCoverageRole", "syncBlindGoldRelatedFamilyPickerSummary");
  const detailSource = functionSource("renderBlindGoldReviewDetail", "renderBlindGoldReview");
  const collectSource = functionSource("blindGoldReviewCollectFamilyGold", "beginBlindGoldBusinessEdit");
  const stageSource = functionSource("syncBlindGoldReviewStages", "setBlindGoldReviewEditState");
  assert.match(compatibilitySource, /familyGold\.relatedFamilyIds[\s\S]*?upsert\(familyId\)/);
  assert.match(compatibilitySource, /familyGold\.relatedFamilyRelations/);
  assert.match(compatibilitySource, /familyGold\.relatedFamilies/);
  assert.match(compatibilitySource, /familyGold\.relatedFamilyRoles/);
  assert.match(compatibilitySource, /familyGold\.families/);
  assert.match(compatibilitySource, /coverageRole,/);
  assert.match(compatibilitySource, /requiredForAnswer: coverageRole === "required"/);
  assert.match(detailSource, /blindGoldReviewRelatedFamilyRelations\(familyGold\)/);
  assert.match(detailSource, /data-coverage-role="\$\{escapeHtml\(relation\.coverageRole\)\}"/);
  assert.match(detailSource, /data-required-for-answer="\$\{relation\.requiredForAnswer\}"/);
  assert.match(collectSource, /const relatedFamilyRelations = blindGoldRelatedFamilyRelationsFromSelect\(primaryFamilyId\)/);
  assert.match(collectSource, /const relatedFamilyIds = relatedFamilyRelations\.map/);
  assert.match(collectSource, /relatedFamilyRelations,/);
  assert.match(collectSource, /coverageRole: relation\.coverageRole/);
  assert.match(collectSource, /requiredForAnswer: relation\.requiredForAnswer/);
  assert.doesNotMatch(collectSource, /const relatedFamilyIds = decision === "join_existing"/);
  assert.match(stageSource, /blindGoldRelatedFamilyRelationSignature\(currentRelatedRelations\)/);
  assert.match(stageSource, /必需 \$\{relatedCounts\.required\} · 普通 \$\{relatedCounts\.reference\}/);
  assert.match(html, /“作答必需”会与主题族共同覆盖最小充分知识集/);
});

test("family adjudication uses member contributions for joint coverage without counting reference families", () => {
  assert.match(html, /id="blind-gold-family-coverage-summary"[^>]*aria-live="polite"/);
  assert.match(html, /id="blind-gold-family-contributions"/);
  assert.match(html, /本题的题族知识贡献/);
  assert.match(html, /后台目录锚点不参与联合覆盖/);
  const coverageSource = functionSource("blindGoldNormalizedKnowledgeText", "syncBlindGoldRelatedFamilyPickerSummary");
  const collectSource = functionSource("blindGoldReviewCollectFamilyGold", "beginBlindGoldBusinessEdit");
  const stageSource = functionSource("syncBlindGoldReviewStages", "setBlindGoldReviewEditState");
  assert.match(coverageSource, /function blindGoldKnowledgeNodesCompatible/);
  assert.match(coverageSource, /canonicalNodeId/);
  assert.match(coverageSource, /aliasNodeIds/);
  assert.match(coverageSource, /const blindGoldFamilyKnowledgeProtocolVersion = "family_knowledge_v3"/);
  assert.match(coverageSource, /if \(familyGold\.familyKnowledgeProtocolVersion === blindGoldFamilyKnowledgeProtocolVersion\) return true/);
  assert.match(coverageSource, /batch\.status === "frozen"/);
  assert.match(coverageSource, /!blindGoldReviewIsRevisionBatch\(batch\)/);
  assert.match(coverageSource, /blindGoldRevisionRequiredStages\(item, batch\)\.includes\("family"\)/);
  assert.doesNotMatch(coverageSource, /versionNumber\s*>=\s*2/);
  assert.match(coverageSource, /normalized\.coverageKnowledge \|\| normalized\.requiredKnowledge/);
  assert.match(coverageSource, /if \(role === "reference"\) return \[\]/);
  assert.match(coverageSource, /membership\?\.contributionKnowledgeNodeIds \|\| \[\]/);
  assert.match(coverageSource, /if \(stored\.length\) return stored;\s*return \[\];/);
  assert.match(coverageSource, /function blindGoldFamilyContributionSuggestion/);
  assert.match(coverageSource, /data-use-blind-gold-family-contribution-suggestion/);
  assert.match(coverageSource, /const expected = blindGoldUniqueKnowledgeNodes\(answerKnowledge\.requiredKnowledge/);
  assert.match(coverageSource, /const requiredRelations = relations\.filter\(\(relation\) => relation\.coverageRole === "required"\)/);
  assert.match(coverageSource, /referenceCount: relations\.filter\(\(relation\) => relation\.coverageRole === "reference"\)\.length/);
  assert.match(coverageSource, /const knowledge = useContributionProtocol[\s\S]*?blindGoldFamilyContributionNodes/);
  assert.match(coverageSource, /const actual = blindGoldUniqueKnowledgeNodes\(contributionAudits\.flatMap\(\(entry\) => entry\.knowledge\)\)/);
  assert.match(coverageSource, /const missing = expected\.filter/);
  assert.match(coverageSource, /const extra = actual\.filter/);
  assert.match(coverageSource, /primaryContribution\.some\(\(node\) => blindGoldKnowledgeNodeCovers\(node, questionCore\)\)/);
  assert.match(coverageSource, /联合覆盖 \$\{escapeHtml\(coverage\.covered\.length\)\}\/\$\{escapeHtml\(coverage\.expected\.length\)\}/);
  assert.match(coverageSource, /blindGoldReviewKnowledgeTagsHtml\(coverage\.missing\)/);
  assert.match(coverageSource, /普通关联 \$\{escapeHtml\(coverage\.referenceCount\)\} 个，不计入联合覆盖/);
  assert.match(coverageSource, /题目知识焦点“\$\{escapeHtml\(blindGoldReviewNodeLabel\(coverage\.questionCore\)\)\}”尚未由/);
  assert.doesNotMatch(coverageSource, /主题核心不一致：题目/);
  assert.match(collectSource, /familyKnowledgeProtocolVersion: blindGoldFamilyKnowledgeProtocolVersion/);
  assert.match(collectSource, /membership:\s*\{/);
  assert.match(collectSource, /contributionKnowledgeNodeIds: contributionKnowledge\.map/);
  assert.match(collectSource, /contributionKnowledgeLabels: contributionKnowledge\.map/);
  assert.match(stageSource, /syncBlindGoldFamilyCoverageSummary\(item\)/);
  assert.match(script, /option\.selected = familyOption\.checked;[\s\S]*?syncBlindGoldReviewStages\(\)/);
  assert.match(script, /option\.dataset\.coverageRole = coverageRole;[\s\S]*?syncBlindGoldReviewStages\(\)/);
  assert.match(styles, /\.blind-gold-family-coverage-summary \{[^}]*flex-wrap:\s*wrap/);
  assert.doesNotMatch(styles, /\.blind-gold-family-coverage-summary \{[^}]*box-shadow/);
});

test("single-node contribution suggestions remain explicit and sit beside the contribution picker", () => {
  const rowSource = functionSource("blindGoldFamilyContributionRowHtml", "renderBlindGoldFamilyContributions");
  const editStateSource = functionSource("setBlindGoldReviewEditState", "renderBlindGoldReviewDetail");
  assert.match(rowSource, /suggestion\.length === 1[\s\S]*?填入建议：\$\{blindGoldReviewNodeShortLabel\(suggestion\[0\]\)\}/);
  assert.match(rowSource, /blind-gold-family-contribution-controls[\s\S]*?blind-gold-family-contribution-picker[\s\S]*?data-use-blind-gold-family-contribution-suggestion/);
  assert.match(rowSource, /suggestion\.length && !suggestionMatchesSelection/);
  assert.match(rowSource, /手动勾选有效项后可直接审核/);
  assert.doesNotMatch(rowSource, /blindGoldFamilyContributionDrafts\.set/);
  assert.match(editStateSource, /data-use-blind-gold-family-contribution-suggestion/);
  assert.match(script, /if \(contributionSuggestion\) \{[\s\S]*?if \(contributionSuggestion\.disabled\) return;[\s\S]*?blindGoldFamilyContributionDrafts\.set[\s\S]*?renderBlindGoldFamilyContributions\(item\);[\s\S]*?syncBlindGoldReviewStages\(\);/);
  assert.match(styles, /\.blind-gold-family-contribution-controls \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.blind-gold-family-contribution-controls \.family-contribution-suggestion \{[^}]*min-height:\s*36px/);
});

test("family contribution picker keeps reviewed question knowledge available while family ids are resolving", () => {
  const rowSource = functionSource("blindGoldFamilyContributionRowHtml", "renderBlindGoldFamilyContributions");
  assert.match(rowSource, /const sourceCandidates = blindGoldUniqueKnowledgeNodes\(\[/);
  assert.match(rowSource, /const matchedCandidates = blindGoldUniqueKnowledgeNodes\(\[/);
  assert.match(rowSource, /const catalogNodes = blindGoldReviewKnowledgeNodes\(item\)/);
  assert.match(rowSource, /const coverageCandidates = blindGoldReviewKnowledgeDescendants\(coverage, catalogNodes\)/);
  assert.match(rowSource, /const validCatalogCandidates = blindGoldUniqueKnowledgeNodes\(\[/);
  assert.match(rowSource, /\.\.\.invalidSelected/);
  assert.match(rowSource, /validCatalogCandidates\.length \|\| catalogNodes\.length \? \[\] : sourceCandidates/);
  assert.match(rowSource, /const hasUnmatchedQuestionKnowledge = questionRequired\.some\(/);
  assert.match(rowSource, /本题还有知识未被当前题族覆盖/);
  assert.match(rowSource, /手动勾选有效项即可提交，无需点击建议按钮/);
});

test("family contribution selections survive redraws and are captured before submit", () => {
  const nodeSource = functionSource("blindGoldFamilyContributionNodes", "blindGoldFamilyContributionSuggestion");
  const renderSource = functionSource("renderBlindGoldFamilyContributions", "blindGoldReviewFamilyCoverage");
  const collectSource = functionSource("blindGoldReviewCollectFamilyGold", "blindGoldReviewSelectedHistoricalFamilyIds");
  assert.match(nodeSource, /state\.blindGoldFamilyContributionDrafts\.has\(draftKey\)/);
  assert.match(nodeSource, /if \(resolved\.length\) return resolved/);
  assert.match(renderSource, /blindGoldKnowledgePickerRoots\(\)[\s\S]*?rememberBlindGoldFamilyContribution\(root, item\)/);
  assert.match(collectSource, /blindGoldKnowledgePickerRoots\(\)[\s\S]*?rememberBlindGoldFamilyContribution\(root, item\)/);
});

test("family contribution drafts survive a browser refresh without crossing batches or item revisions", () => {
  assert.match(script, /const blindGoldFamilyContributionDraftStorageKey = "shukao\.blindGoldFamilyContributionDrafts\.v1"/);
  const storageSource = functionSource("blindGoldFamilyContributionDraftStorageEntries", "persistBlindGoldFamilyContributionDrafts");
  assert.match(storageSource, /globalThis\.sessionStorage/);
  assert.match(storageSource, /JSON\.parse/);
  assert.match(storageSource, /Array\.isArray\(parsed\?\.drafts\)/);

  const persistSource = functionSource("persistBlindGoldFamilyContributionDrafts", "restoreBlindGoldFamilyContributionDrafts");
  assert.match(persistSource, /batchId/);
  assert.match(persistSource, /itemRevision/);
  assert.match(persistSource, /nodeKeys:/);
  assert.match(persistSource, /entry\.batchId !== batchId/);
  assert.match(persistSource, /storage\.setItem\(blindGoldFamilyContributionDraftStorageKey/);

  const restoreSource = functionSource("restoreBlindGoldFamilyContributionDrafts", "clearBlindGoldFamilyContributionDrafts");
  assert.match(restoreSource, /entry\.batchId === batchId/);
  assert.match(restoreSource, /entry\.itemRevision && currentRevision && entry\.itemRevision !== currentRevision/);
  assert.match(restoreSource, /blindGoldFamilyContributionKey\(item, entry\.familyKey\)/);

  const clearSource = functionSource("clearBlindGoldFamilyContributionDrafts", "blindGoldFamilyStoredContribution");
  assert.match(clearSource, /options\.persist !== false/);
  const rememberSource = functionSource("rememberBlindGoldFamilyContribution", "blindGoldFamilyContributionSignature");
  assert.match(rememberSource, /persistBlindGoldFamilyContributionDrafts\(\)/);
  assert.match(rememberSource, /blindGoldFamilyContributionDirty === "true"/);
  assert.match(rememberSource, /blindGoldFamilyContributionDirtyKeys\.has\(draftKey\)/);
  assert.match(rememberSource, /draftHasRenderableOption/);
  assert.match(rememberSource, /Array\.isArray\(existingDraft\) && existingDraft\.length/);
  const loadSource = functionSource("loadBlindGoldReviewSets", "saveBlindGoldReview");
  assert.match(loadSource, /clearBlindGoldFamilyContributionDrafts\("", \{ persist: false \}\)/);
  assert.match(loadSource, /restoreBlindGoldFamilyContributionDrafts\(state\.blindGoldReviewBatch\)/);
  const updateSource = functionSource("updateBlindGoldReviewItem", "renderBlindGoldReviewEmpty");
  assert.match(updateSource, /clearBlindGoldFamilyContributionDrafts\(item\.questionId\)/);

  const suggestionStart = script.indexOf('const contributionSuggestion = event.target.closest("[data-use-blind-gold-family-contribution-suggestion]")');
  const suggestionEnd = script.indexOf('const roleButton = event.target.closest("[data-blind-gold-family-role]")', suggestionStart);
  assert.ok(suggestionStart >= 0 && suggestionEnd > suggestionStart);
  assert.match(script.slice(suggestionStart, suggestionEnd), /persistBlindGoldFamilyContributionDrafts\(\)/);
  assert.match(script, /root\.dataset\.blindGoldFamilyContributionDirty = "true"/);
  assert.match(script, /blindGoldFamilyContributionDirtyKeys\.add\(/);
});

test("family contribution node keys resolve across textbook id and alias changes", () => {
  const resolverSource = functionSource("blindGoldReviewResolveNode", "blindGoldReviewNodeOptions");
  const nodeSource = functionSource("blindGoldFamilyContributionNodes", "blindGoldFamilyContributionSuggestion");
  assert.match(resolverSource, /blindGoldKnowledgeNodeIds\(node\)\.includes\(payload\)/);
  assert.match(resolverSource, /blindGoldNormalizedKnowledgeText\(node\.path \|\| node\.knowledgePath\)/);
  assert.match(resolverSource, /blindGoldNormalizedKnowledgeText\(node\.title \|\| node\.name \|\| node\.label\)/);
  assert.match(nodeSource, /if \(draftNodes\.length \|\| !draftKeys\.length\) return draftNodes/);
});

test("rejected family saves keep the transient review controls editable", () => {
  const detailSource = functionSource("renderBlindGoldReviewDetail", "renderBlindGoldReview");
  const renderSource = functionSource("renderBlindGoldReview", "invalidateBlindGoldReviewLoads");
  const saveSource = functionSource("saveBlindGoldReview", "renderBlindGoldFreezePreview");
  assert.match(detailSource, /preserveTransient/);
  assert.match(detailSource, /transientReviewResult/);
  assert.match(renderSource, /renderBlindGoldReviewDetail\(options\)/);
  assert.match(saveSource, /let saveFailed = false/);
  assert.match(saveSource, /saveFailed = true/);
  assert.match(saveSource, /renderBlindGoldReview\(saveFailed \? \{ preserveTransient: true \} : \{\}\)/);
});

test("V3 family review exposes a final replay-mode segment and derives the family decision", () => {
  assert.match(html, /id="blind-gold-replay-mode"/);
  assert.match(html, /name="blind-gold-replay-mode" value="mature"/);
  assert.match(html, /name="blind-gold-replay-mode" value="singleton"/);
  assert.match(html, /name="blind-gold-replay-mode" value="unmatched"/);
  assert.match(styles, /\.blind-gold-replay-mode label:has\(input:checked\)/);
  const decisionSource = functionSource("syncBlindGoldFamilyDecision", "syncBlindGoldReplayMode");
  const stageSource = functionSource("syncBlindGoldReviewStages", "setBlindGoldReviewEditState");
  const collectSource = functionSource("blindGoldReviewCollectFamilyGold", "beginBlindGoldBusinessEdit");
  assert.match(decisionSource, /replayMode === "unmatched" \? "create_new" : "join_existing"/);
  assert.match(decisionSource, /#blind-gold-existing-family-field"\)\.hidden = isNew/);
  assert.match(decisionSource, /#blind-gold-related-family-field"\)\.hidden = false/);
  assert.match(decisionSource, /#blind-gold-family-definition"\)\.hidden = isNew/);
  assert.match(decisionSource, /syncBlindGoldReviewStages\(item\)/);
  assert.match(stageSource, /const replayMode = blindGoldReviewSelectedReplayMode\(item\)/);
  assert.match(stageSource, /const candidateNameControl = document\.querySelector\("#blind-gold-new-family-name"\)/);
  assert.match(stageSource, /candidateNameControl \? candidateNameControl\.value\.trim\(\)/);
  assert.match(stageSource, /待填写题族名称/);
  assert.match(stageSource, /const familySelectionChanged = replayMode !== storedReplayMode/);
  assert.match(stageSource, /familySelectionChanged \? "待保存" : "待确认"/);
  assert.match(styles, /#blind-gold-existing-family-field\[hidden\],[\s\S]*?#blind-gold-related-family-field\[hidden\],[\s\S]*?#blind-gold-family-definition\[hidden\][\s\S]*?display: none/);
  assert.match(collectSource, /const replayMode = blindGoldReviewSelectedReplayMode\(item\)/);
  assert.match(collectSource, /const decision = replayMode === "unmatched" \? "create_new" : "join_existing"/);
  assert.match(collectSource, /const relatedFamilyRelations = blindGoldRelatedFamilyRelationsFromSelect\(primaryFamilyId\)/);
  assert.doesNotMatch(collectSource, /const relatedFamilyIds = decision === "join_existing"/);
  assert.match(script, /#blind-gold-replay-mode"\)\.addEventListener\("change", syncBlindGoldReplayMode\)/);
});

test("unmatched replay mode keeps candidate scope anchor and coverage selections independent", () => {
  const source = functionSource("blindGoldReviewPrefillCandidateFromKnowledge", "syncBlindGoldFamilyOptionEligibility");
  assert.match(source, /blindGoldReviewHumanAnswerKnowledge\(item\)/);
  assert.match(source, /answerKnowledge\.coreKnowledge/);
  assert.match(source, /answerKnowledge\.requiredKnowledge/);
  assert.match(source, /const coreKey = blindGoldReviewNodeKey\(coreKnowledge\)/);
  assert.match(source, /map\(blindGoldReviewNodeKey\)/);
  assert.match(source, /const coreSelect = document\.querySelector\("#blind-gold-new-family-core"\)/);
  assert.match(source, /const requiredSelect = document\.querySelector\("#blind-gold-new-family-required"\)/);
  assert.match(source, /requiredKeys\.has\(option\.value\)/);
  assert.doesNotMatch(source, /requiredKeys\.add\(coreKey\)/);
  assert.match(script, /已按人工确认的题目知识焦点与最小充分知识集预填覆盖范围/);
  assert.match(script, /题族判别焦点、后台目录锚点、考查动作和边界仍需逐项核对/);
});

test("final replay mode is visible in audit labels and drives filtering", () => {
  const auditSource = functionSource("blindGoldReviewModeAuditLabel", "escapeHtml");
  const filterSource = functionSource("blindGoldReviewFilteredItems", "renderBlindGoldReviewSummary");
  assert.match(auditSource, /`\$\{originalLabel\} → \$\{finalLabel\}`/);
  assert.match(filterSource, /blindGoldReviewReplayMode\(item\) !== mode/);
  assert.match(script, /const mode = blindGoldReviewModeAuditLabel\(item\)/);
  assert.match(script, /blindGoldReviewModeAuditLabel\(item, replayMode\)/);
});

test("pending families are marked and blocked for non-disputed family review", () => {
  const eligibilitySource = functionSource("syncBlindGoldFamilyOptionEligibility", "syncBlindGoldFamilyDecision");
  assert.match(eligibilitySource, /blindGoldReviewApiResult\(state\.blindGoldReviewResult\) === "disputed"/);
  assert.match(eligibilitySource, /blindGoldFormalFamilyDraftOverride\(\)/);
  assert.match(eligibilitySource, /liveOverrideIds/);
  assert.match(eligibilitySource, /option\.dataset\.familyStatus === "pending_review"/);
  assert.match(eligibilitySource, /option\.disabled = pendingReview && !allowUnconfirmed/);
  assert.match(eligibilitySource, /option\.disabled && option\.selected && !historicalSnapshot && !liveOverrideIds\.has\(option\.value\)/);
  assert.match(script, /data-family-status="\$\{escapeHtml\(family\.status \|\| "unknown"\)\}"/);
  assert.doesNotMatch(script, /待审核 · 仅可取消/);
  assert.doesNotMatch(script, /removingBlockedSelection/);
});

test("family semantic failures render structured Chinese details instead of a raw code", () => {
  const formatterSource = functionSource("blindGoldReviewSemanticIssueText", "blindGoldReviewSemanticIssues");
  const issueSource = functionSource("blindGoldReviewSemanticIssues", "setBlindGoldReviewSemanticFeedback");
  const feedbackSource = functionSource("setBlindGoldReviewSemanticFeedback", "setBlindGoldReviewFeedback");
  const saveSource = functionSource("saveBlindGoldReview", "renderBlindGoldFreezePreview");
  assert.match(formatterSource, /非争议金标只能使用已确认题族/);
  assert.match(formatterSource, /在正式关系中不是本题主题族/);
  assert.match(formatterSource, /最小充分知识集/);
  assert.match(formatterSource, /已填写本题贡献/);
  assert.match(formatterSource, /手动勾选有效项即可提交，无需点击建议按钮/);
  assert.match(issueSource, /error\?\.details\?\.issues/);
  assert.match(issueSource, /error\?\.payload\?\.details\?\.issues/);
  assert.match(issueSource, /error\?\.payload\?\.issues/);
  assert.match(feedbackSource, /issues\.slice\(0, 3\)/);
  assert.match(feedbackSource, /<details><summary>展开全部/);
  assert.match(saveSource, /error\?\.message \|\| error\?\.payload\?\.error/);
  assert.match(saveSource, /errorCode === "classification_gold_review_family_semantic_invalid"/);
  assert.match(saveSource, /setBlindGoldReviewSemanticFeedback\(error, item\)/);
  assert.match(styles, /\.blind-gold-review-feedback\.has-details/);
});

test("blind gold review assets use a fresh cache key after the knowledge-role update", () => {
  // 只校验“带日期版本号”这个不变量，不锁死具体日期，避免每次抬版本号都要改测试。
  assert.match(html, /styles\.css\?v=\d{8}\.\d+/);
  assert.match(html, /app\.js\?v=\d{8}\.\d+/);
});

test("switching blind-gold questions closes the related-family popover before repainting", () => {
  const source = functionSource("renderBlindGoldReviewDetail", "renderBlindGoldReview");
  assert.match(source, /setBlindGoldKnowledgePickerOpen\(null, false\);[\s\S]*?setBlindGoldRelatedFamilyPickerOpen\(false\);/);
});

test("formal question or knowledge drift blocks review until an explicit reload", () => {
  assert.match(html, /id="reload-blind-gold-business-data"[^>]*>重新载入正式数据</);
  const source = functionSource("reloadBlindGoldBusinessData", "beginBlindGoldBusinessEdit");
  assert.match(source, /\["question_drift", "knowledge_drift"\]/);
  assert.match(source, /\/reload`/);
  assert.match(source, /expectedRevision:\s*item\.revision/);
  assert.match(source, /两阶段审核会重置为待审核/);
  assert.doesNotMatch(source, /blind-replay|blindReplay|knowledge-classification\/results\/.*apply/);
  assert.match(script, /freezeButton\.disabled = !summary\.readyToFreeze \|\| hasBusinessDrift/);
  assert.match(styles, /\.blind-gold-business-sync\.has-drift/);
});

test("formal family drift exposes a dedicated catalog reload recovery action", () => {
  assert.match(html, /id="reload-blind-gold-family-catalog"[^>]*>重新载入题族目录<\/button>/);
  assert.match(script, /#reload-blind-gold-family-catalog"\)\.addEventListener\("click", reloadBlindGoldFamilyCatalog\)/);
  assert.match(script, /blindGoldFamilyCatalogReloadRequired:\s*false/);
  const editStateSource = functionSource("setBlindGoldReviewEditState", "renderBlindGoldReviewDetail");
  assert.match(editStateSource, /const familyCatalogAvailable = !readOnly && Boolean\(item\?\.question\?\.bookId\)/);
  assert.match(editStateSource, /reloadFamilyButton\.hidden = !familyCatalogAvailable/);
});

test("formal family drift save errors retain a dedicated reload state and recovery guidance", () => {
  const source = functionSource("saveBlindGoldReview", "renderBlindGoldFreezePreview");
  assert.match(source, /errorCode === "classification_gold_review_formal_family_drift"/);
  assert.match(source, /state\.blindGoldFamilyCatalogReloadRequired = true/);
  assert.match(source, /请点击顶部“重新载入题族目录”/);
  assert.match(source, /答案与知识阶段不会被自动改写/);
});

test("formal family drift explains that refresh cannot confirm membership and offers a manager action", () => {
  assert.match(script, /刷新只重新读取目录，不会把“归属待审核”自动变成“归属已确认/);
  assert.match(script, /id="open-blind-gold-formal-family-manager"/);
  assert.match(script, /async function openBlindGoldFormalFamilyManager/);
  assert.match(script, /openView\("题库管理"\)/);
  assert.match(script, /openQuestionFamilyReview\(family\.id\)/);
});

test("pending formal membership can be confirmed from gold review without replacing the gold draft", () => {
  const syncSource = functionSource("renderBlindGoldFormalFamilySync", "applyBlindGoldFormalFamilySyncToDraft");
  assert.match(syncSource, /data-confirm-blind-gold-formal-membership/);
  assert.match(syncSource, /data-membership-revision/);
  const confirmSource = functionSource("confirmBlindGoldFormalFamilyMembership", "blindGoldFormalFamilyDraftNeedsLiveReconciliation");
  assert.match(confirmSource, /const bookId = String\(item\.question\?\.bookId \|\| ""\)\.trim\(\)/);
  assert.match(confirmSource, /question-families\/\$\{encodeURIComponent\(familyId\)\}\/members\/\$\{encodeURIComponent\(questionId\)\}\/review/);
  assert.match(confirmSource, /status: "confirmed"/);
  assert.match(confirmSource, /expectedRevision/);
  assert.match(confirmSource, /未改动你的金标答案、知识或贡献选择/);
  assert.match(confirmSource, /draftWasSynced = refreshedItem\?\.formalFamilySync\?\.status === "drift"/);
  assert.match(confirmSource, /applyBlindGoldFormalFamilySyncToDraft\(\)/);
  assert.match(script, /data-confirm-blind-gold-formal-membership/);
});

test("pending membership errors expose the confirmation action beside the blocking reason", () => {
  const feedbackSource = functionSource("setBlindGoldReviewSemanticFeedback", "setBlindGoldReviewFeedback");
  assert.match(feedbackSource, /issue\.code === "family_membership_not_confirmed"/);
  assert.match(feedbackSource, /blind-gold-review-feedback-actions/);
  assert.match(feedbackSource, /data-confirm-blind-gold-formal-membership/);
  assert.match(feedbackSource, /确认.*归属并继续/);
  assert.match(styles, /\.blind-gold-review-feedback-actions/);
});

test("family save performs a local formal-relation preflight before posting", () => {
  const preflightSource = functionSource("blindGoldFormalFamilyPreflightIssues", "blindGoldReviewFamilyById");
  assert.match(preflightSource, /currentPrimaryFamilyId/);
  assert.match(preflightSource, /family_membership_not_confirmed/);
  const saveSource = functionSource("saveBlindGoldReview", "renderBlindGoldFreezePreview");
  assert.match(saveSource, /blindGoldFormalFamilyPreflightIssues\(item, familyGold, result\)/);
  assert.match(saveSource, /setBlindGoldReviewSemanticFeedback\(\{ details: \{ issues: formalPreflightIssues \} \}/);
});

test("family catalog reload force-refreshes catalog caches without calling the business reload endpoint", () => {
  const source = functionSource("reloadBlindGoldFamilyCatalog", "beginBlindGoldBusinessEdit");
  assert.match(source, /state\.blindGoldKnowledgeStructures\.delete\(bookId\)/);
  assert.match(source, /state\.blindGoldFamilyCatalogs\.delete\(bookId\)/);
  assert.match(source, /state\.blindGoldCatalogRequests\.delete\(bookId\)/);
  assert.match(source, /invalidateBlindGoldReviewCatalogCaches\(bookId\)/);
  assert.match(source, /ensureBlindGoldReviewCatalog\(item, \{ quiet: true, force: true \}\)/);
  assert.match(source, /\/api\/admin\/knowledge-classification\/gold-review\/sets\/\$\{encodeURIComponent\(batch\.id\)\}`/);
  assert.doesNotMatch(source, /\/items\/\$\{encodeURIComponent\(item\.questionId\)\}\/reload/);
});

test("catalog reload and a normal page refresh temporarily align a drifted family draft", () => {
  const reloadSource = functionSource("reloadBlindGoldFamilyCatalog", "beginBlindGoldBusinessEdit");
  const loadSource = functionSource("loadBlindGoldReviewSets", "saveBlindGoldReview");
  const switchSource = script.slice(
    script.indexOf('document.querySelector("#blind-gold-review-list").addEventListener("click"'),
    script.indexOf('["#blind-gold-review-status", "#blind-gold-review-mode"]'),
  );
  assert.match(reloadSource, /refreshedItem\.formalFamilySync\?\.status === "drift"/);
  assert.match(reloadSource, /applyBlindGoldFormalFamilySyncToDraft\(\)/);
  assert.match(reloadSource, /未自动保存或确认/);
  assert.match(loadSource, /refreshedItem\.formalFamilySync\?\.status === "drift"/);
  assert.match(loadSource, /applyBlindGoldFormalFamilySyncToDraft\(\)/);
  assert.match(loadSource, /未自动保存或确认/);
  assert.match(switchSource, /ensureBlindGoldReviewCatalog\(item, \{ quiet: true \}\)\.then/);
  assert.match(switchSource, /current\.formalFamilySync\?\.status !== "drift"/);
  assert.match(switchSource, /applyBlindGoldFormalFamilySyncToDraft\(\)/);
  const syncSource = functionSource("applyBlindGoldFormalFamilySyncToDraft", "blindGoldReviewFamilyById");
  assert.match(syncSource, /return false;/);
  assert.match(syncSource, /return true;/);
});

test("normal blind-gold load reuses the detail request before forcing a cached catalog refresh", () => {
  const loadSource = functionSource("loadBlindGoldReviewSets", "saveBlindGoldReview");
  assert.match(loadSource, /catalogAlreadyCached/);
  assert.match(loadSource, /state\.blindGoldCatalogRequests\.has\(catalogBookId\)/);
  assert.match(loadSource, /force: catalogAlreadyCached && !state\.blindGoldCatalogRequests\.has\(catalogBookId\)/);
});

test("catalog reload reapplies the temporary family alignment after its final repaint", () => {
  const source = functionSource("reloadBlindGoldFamilyCatalog", "beginBlindGoldBusinessEdit");
  const repaint = source.indexOf("renderBlindGoldReview();", source.indexOf("finally"));
  assert.ok(repaint >= 0, "catalog reload should repaint after releasing the mutation lock");
  assert.match(
    source.slice(repaint),
    /if \(draftWasSynced\)[\s\S]*?currentItem\.formalFamilySync\?\.status === "drift"[\s\S]*?applyBlindGoldFormalFamilySyncToDraft\(\);/,
  );
});

test("formal family alignment survives detail redraw without rewriting the historical gold draft", () => {
  assert.match(script, /blindGoldFormalFamilyDraftOverrides:\s*new Map\(\)/);
  const helperSource = functionSource("blindGoldFormalFamilyDraftOverrideKey", "blindGoldReviewReplayMode");
  assert.match(helperSource, /state\.blindGoldFormalFamilyDraftOverrides\.get/);
  assert.match(helperSource, /itemRevision/);
  const applySource = functionSource("applyBlindGoldFormalFamilySyncToDraft", "blindGoldFormalFamilyDraftNeedsLiveReconciliation");
  assert.match(applySource, /state\.blindGoldFormalFamilyDraftOverrides\.set/);
  assert.match(applySource, /primaryFamilyId/);
  assert.match(applySource, /relatedFamilyRelations/);
  assert.doesNotMatch(applySource, /item\.humanGold\s*=|item\.familyGold\s*=/);
  const detailSource = functionSource("renderBlindGoldReviewDetail", "renderBlindGoldReview");
  assert.match(detailSource, /blindGoldEffectiveFamilyGoldForRender\(item\)/);
  const effectiveSource = functionSource("blindGoldEffectiveFamilyGoldForRender", "blindGoldReviewReplayMode");
  assert.match(effectiveSource, /blindGoldFormalFamilyDraftOverride\(item\)/);
  assert.match(effectiveSource, /relatedFamilyRelations/);
  const editStateSource = functionSource("setBlindGoldReviewEditState", "renderBlindGoldReviewDetail");
  assert.match(editStateSource, /const familyEditable = !readOnly[\s\S]*?contentComplete[\s\S]*?!state\.blindGoldReviewSaving/);
  assert.doesNotMatch(editStateSource, /familyEditable[\s\S]*?state\.blindGoldReviewResult === "corrected"/);
  const syncSource = functionSource("renderBlindGoldFormalFamilySync", "applyBlindGoldFormalFamilySyncToDraft");
  assert.match(syncSource, /历史题族裁决|本批金标草稿/);
  assert.match(syncSource, /当前待提交草稿/);
  const updateSource = functionSource("updateBlindGoldReviewItem", "renderBlindGoldReviewEmpty");
  assert.match(updateSource, /clearBlindGoldFormalFamilyDraftOverride\(item\)/);
  const loadSource = functionSource("loadBlindGoldReviewSets", "saveBlindGoldReview");
  assert.match(loadSource, /clearBlindGoldFormalFamilyDraftOverride\(\)/);
  assert.match(script, /#blind-gold-related-families"\)\.addEventListener\("change", \(\) => \{[\s\S]*?clearBlindGoldFormalFamilyDraftOverride/);
});

test("new-family gold requires an independent focus plus five definition fields while keeping boundaries optional", () => {
  assert.match(html, /名称、题族判别焦点、后台目录锚点、覆盖知识、教材锚点和考查动作必须齐全；后台目录锚点只负责组织，纳入与排除边界可后补/);
  assert.match(html, /id="blind-gold-new-family-focus-key"/);
  const source = functionSource("saveBlindGoldReview", "freezeBlindGoldReviewSet");
  assert.match(source, /!candidate\.name && "名称"/);
  assert.match(source, /!candidate\.focusKey && "题族判别焦点"/);
  assert.match(source, /candidate\.scopeAnchor\?\.id \|\| candidate\.coreKnowledge\?\.id/);
  assert.match(source, /candidate\.coverageKnowledge \|\| candidate\.requiredKnowledge/);
  assert.match(source, /candidate\.textbookAnchors/);
  assert.match(source, /!candidate\.assessmentAction && "考查动作"/);
  const validation = source.slice(source.indexOf("const missing = ["), source.indexOf("].filter(Boolean)") + 18);
  assert.doesNotMatch(validation, /inclusionBoundary|exclusionBoundary/);
});

test("candidate-family gold reads and writes an independent discrimination focus", () => {
  const detailSource = functionSource("renderBlindGoldReviewDetail", "renderBlindGoldReview");
  const candidateSource = functionSource("blindGoldReviewCollectCandidateFamily", "blindGoldReviewCollectAnswerKnowledge");
  assert.match(detailSource, /#blind-gold-new-family-focus-key"\)\.value = candidate\.focusKey \|\| ""/);
  assert.match(candidateSource, /focusKey: document\.querySelector\("#blind-gold-new-family-focus-key"\)\?\.value\.trim\(\) \|\| ""/);
  assert.doesNotMatch(candidateSource, /focusKey:\s*(?:candidate\.)?assessmentAction|focusKey:\s*.*name/);
});

test("new-family knowledge fields reuse searchable single and multiselect components", () => {
  const pickerSource = functionSource("blindGoldKnowledgePickerRoots", "blindGoldReviewKnowledgeSummary");
  const syncSource = functionSource("syncBlindGoldNewFamilyRequiredKnowledgeCore", "syncBlindGoldKnowledgePickerSummary");
  const knowledgeNodeSource = functionSource("blindGoldReviewKnowledgeNodes", "blindGoldReviewResolveNode");
  const editSource = functionSource("setBlindGoldReviewEditState", "renderBlindGoldReviewDetail");
  const detailSource = functionSource("renderBlindGoldReviewDetail", "renderBlindGoldReview");
  assert.match(html, /id="blind-gold-new-family-core-picker"[^>]*data-blind-gold-knowledge-picker[^>]*data-blind-gold-knowledge-single="true"/);
  assert.match(html, /id="blind-gold-new-family-required-picker"[^>]*data-blind-gold-knowledge-picker/);
  assert.doesNotMatch(html, /id="blind-gold-new-family-required-picker"[^>]*data-blind-gold-lock-selector/);
  assert.match(html, /id="blind-gold-new-family-anchors-picker"[^>]*data-blind-gold-knowledge-picker/);
  assert.match(html, /id="blind-gold-new-family-core"[^>]*data-blind-gold-knowledge-select hidden/);
  assert.match(html, /id="blind-gold-new-family-required"[^>]*data-blind-gold-knowledge-select multiple hidden/);
  assert.match(html, /id="blind-gold-new-family-anchors"[^>]*data-blind-gold-knowledge-select multiple hidden/);
  assert.doesNotMatch(html, /id="blind-gold-new-family-(?:required|anchors)"[^>]*size=/);
  assert.match(html, /placeholder="搜索后台目录锚点或教材路径"/);
  assert.match(html, /placeholder="搜索覆盖知识或教材路径"/);
  assert.match(html, /placeholder="搜索教材锚点或教材路径"/);
  assert.match(pickerSource, /function syncBlindGoldNewFamilyRequiredKnowledgeCore\(\)/);
  assert.match(syncSource, /\[coreRoot, requiredRoot, anchorsRoot\]\.forEach\(renderBlindGoldKnowledgePicker\)/);
  assert.doesNotMatch(syncSource, /selected\s*=\s*true|locked|lockSelector/);
  assert.match(knowledgeNodeSource, /state\.blindGoldKnowledgeStructures\.get\(item\?\.question\?\.bookId/);
  assert.match(knowledgeNodeSource, /\(structure\?\.nodes \|\| \[\]\)\.filter\(\(node\) => !node\.kind \|\| node\.kind === "knowledge"\)/);
  assert.match(detailSource, /syncBlindGoldNewFamilyRequiredKnowledgeCore\(\);[\s\S]*?initializeBlindGoldKnowledgePickers\(\)/);
  assert.match(editSource, /#blind-gold-new-family-fields \[data-blind-gold-knowledge-trigger\][\s\S]*?control\.disabled = !familyEditable/);
  assert.match(editSource, /syncBlindGoldNewFamilyRequiredKnowledgeCore\(\)/);
  assert.match(script, /#blind-gold-new-family-fields"\)\.addEventListener\("change"[\s\S]*?#blind-gold-new-family-core[\s\S]*?syncBlindGoldFamilyDecision\(\)/);
  assert.match(script, /#blind-gold-new-family-fields"\)\.addEventListener\("input"[\s\S]*?data-blind-gold-knowledge-search[\s\S]*?syncBlindGoldFamilyDecision\(\)/);
});

test("selected questions hide the stale empty state and expose staged accordions", () => {
  assert.match(styles, /\.blind-gold-review-empty\[hidden\][\s\S]*?display:\s*none/);
  assert.match(html, /<details class="blind-gold-stage" id="blind-gold-content-stage" open>/);
  assert.match(html, /<details class="blind-gold-stage" id="blind-gold-family-stage">/);
  assert.match(html, /id="blind-gold-content-stage-summary"/);
  assert.match(html, /id="blind-gold-family-stage-summary"/);
  const source = functionSource("syncBlindGoldReviewStages", "setBlindGoldReviewEditState");
  assert.match(source, /contentStage\.open = true;[\s\S]*?familyStage\.open = false/);
  assert.match(source, /contentStage\.open = false;[\s\S]*?familyStage\.open = true/);
  assert.match(source, /familyStage\.classList\.toggle\("is-locked", !contentComplete\)/);
});

test("option knowledge uses a compact row table with explicit relationship summaries and click-open editors", () => {
  const source = functionSource("blindGoldReviewOptionKnowledgeHtml", "syncBlindGoldOptionKnowledgeSummary");
  assert.match(source, /\$\{composed \? "原子陈述" : "选项"\}/);
  assert.match(source, /\$\{composed \? "单元" : "角色"\}/);
  assert.match(source, /知识关系 \/ 涉及知识/);
  assert.match(source, /<details class="blind-gold-option-knowledge-row"/);
  assert.match(source, /data-blind-gold-option-tags/);
  assert.match(source, /data-blind-gold-option-role/);
  assert.match(source, /data-blind-gold-option-knowledge-relation/);
  assert.match(source, /<option value="unreviewed" disabled [^>]*>未判断<\/option>[\s\S]*?>仅使用题目知识<\/option>[\s\S]*?>另有选项知识<\/option>[\s\S]*?>暂无法判断<\/option>/);
  assert.match(source, /<option value="unreviewed" disabled [^>]*>待人工判断<\/option>/);
  assert.match(source, /data-blind-gold-option-knowledge-field \$\{knowledgeRelation === "option_specific" \? "" : "hidden"\}/);
  assert.match(styles, /\.blind-gold-option-table-head,[\s\S]*?grid-template-columns/);
  assert.match(styles, /\.blind-gold-option-relation-badge\.option_specific/);
  assert.match(styles, /\.blind-gold-option-knowledge-field\[hidden\],[\s\S]*?\.blind-gold-option-uncertainty-field\[hidden\]\s*\{ display:\s*none/);
});

test("option-specific knowledge uses a searchable row-scoped multiselect", () => {
  const htmlSource = functionSource("blindGoldKnowledgePickerHtml", "blindGoldReviewOptionKnowledgeHtml");
  const storedSource = functionSource("blindGoldReviewStoredKnowledgeNodes", "blindGoldReviewCatalogFamily");
  const renderSource = functionSource("renderBlindGoldKnowledgePicker", "initializeBlindGoldKnowledgePickers");
  const openSource = functionSource("syncBlindGoldKnowledgePickerOpenState", "blindGoldReviewKnowledgeSummary");
  assert.match(htmlSource, /data-blind-gold-knowledge-search/);
  assert.match(htmlSource, /data-blind-gold-knowledge-options/);
  assert.match(htmlSource, /data-blind-gold-option-knowledge multiple hidden/);
  assert.match(htmlSource, /blindGoldReviewNodeOptions\(nodes, selectedNodes\)/);
  assert.match(renderSource, /option\.selected\s*\|\|[\s\S]*?option\.textContent\.toLocaleLowerCase/);
  assert.match(renderSource, /visible\.sort\(\(left, right\) => Number\(right\.selected\) - Number\(left\.selected\)[\s\S]*?lockedValue/);
  assert.match(renderSource, /data-blind-gold-knowledge-option type="\$\{single \? "radio" : "checkbox"\}"/);
  assert.match(openSource, /positionQuestionFamilyMultiselect\(root\)/);
  assert.match(script, /option\.selected = pickerOption\.checked;[\s\S]*?select\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
  assert.match(script, /renderBlindGoldKnowledgePicker\(search\.closest\("\[data-blind-gold-knowledge-picker\]"\)\)/);
  assert.match(script, /event\.key !== "Escape"/);
  assert.match(script, /if \(!\(goldContentEditable \|\| businessEditable\)\) setBlindGoldKnowledgePickerOpen\(null, false\)/);
  assert.match(script, /root\.matches\("\[data-blind-gold-knowledge-picker\], \[data-blind-gold-family-picker\](?:, \.blind-gold-primary-family-picker)?"\) \? Math\.max\(rect\.width, 420\)/);
  assert.match(storedSource, /labels\.slice\(ids\.length\)/);
  assert.match(storedSource, /blindGoldReviewNodeLabel\(node\) === label && \(node\.id \|\| node\.path\)/);
  assert.match(styles, /\.blind-gold-knowledge-picker \.question-family-multiselect-trigger/);
  assert.match(styles, /\.blind-gold-review-form \.blind-gold-knowledge-picker \.question-family-multiselect-option > input,[\s\S]*?\.blind-gold-review-form \.blind-gold-family-picker \.question-family-multiselect-option > input,[\s\S]*?(?:\.blind-gold-review-form \.blind-gold-primary-family-picker \.question-family-multiselect-option > input)? \{ width: 16px; height: 16px/);
  assert.doesNotMatch(htmlSource, /data-blind-gold-option-knowledge[^>]*size=/);
});

test("subjective scoring-point knowledge uses the searchable custom picker", () => {
  const scoringSource = functionSource("blindGoldScoringPointRowHtml", "blindGoldReviewOptionRelationSummary");
  const pickerSource = functionSource("blindGoldKnowledgePickerHtml", "blindGoldReviewOptionKnowledgeHtml");
  const collectSource = functionSource("blindGoldReviewCollectAnswerKnowledge", "blindGoldReviewCollectFamilyGold");
  const addSource = functionSource("addBlindGoldScoringPoint", "removeBlindGoldScoringPoint");
  assert.match(scoringSource, /const pickerId = `blind-gold-scoring-knowledge-\$\{index\}`/);
  assert.match(scoringSource, /blindGoldKnowledgePickerHtml\(nodes, selectedNodes, pickerId, `得分点 \$\{index \+ 1\}`, frozen, "", "data-blind-gold-scoring-knowledge"\)/);
  assert.doesNotMatch(scoringSource, /<select data-blind-gold-scoring-knowledge multiple size=/);
  assert.match(pickerSource, /selectDataAttribute = "data-blind-gold-option-knowledge"/);
  assert.match(pickerSource, /hiddenSelectAttributes/);
  assert.match(pickerSource, /data-blind-gold-option-knowledge multiple hidden/);
  assert.match(addSource, /initializeBlindGoldKnowledgePickers\(\)/);
  assert.match(collectSource, /row\.querySelector\("\[data-blind-gold-scoring-knowledge\]"\)\?\.selectedOptions/);
  assert.match(script, /data-blind-gold-scoring-knowledge/);
});

test("option knowledge relation is recalled, clears non-applicable knowledge, and persists with the gold row", () => {
  const renderSource = functionSource("blindGoldReviewOptionKnowledgeHtml", "syncBlindGoldOptionKnowledgeSummary");
  const fallbackSource = functionSource("blindGoldOptionKnowledgeRelation", "blindGoldOptionKnowledgeRelationSummaryHtml");
  const relationSource = functionSource("syncBlindGoldOptionKnowledgeRelation", "blindGoldKnowledgePickerRoots");
  const collectSource = functionSource("blindGoldReviewCollectAnswerKnowledge", "blindGoldReviewCollectFamilyGold");
  const saveSource = functionSource("saveBlindGoldReview", "freezeBlindGoldReviewSet");
  assert.match(fallbackSource, /Object\.hasOwn\(blindGoldOptionKnowledgeRelationLabels, relation\)/);
  assert.match(fallbackSource, /return "unreviewed"/);
  assert.doesNotMatch(fallbackSource, /selectedNodes\.length|knowledgeNodeIds|knowledgeLabels/);
  assert.match(renderSource, /blindGoldOptionKnowledgeRelation\(option\)/);
  assert.match(renderSource, /knowledgeRelation === "option_specific" \? selectedNodes : \[\]/);
  assert.match(relationSource, /relation === "option_specific"/);
  assert.match(relationSource, /\[\.\.\.select\.options\]\.forEach\(\(option\) => \{ option\.selected = false; \}\)/);
  assert.match(relationSource, /field\.hidden = !optionSpecific/);
  assert.match(collectSource, /knowledgeRelation = row\.querySelector\("\[data-blind-gold-option-knowledge-relation\]"\)\?\.value \|\| "unreviewed"/);
  assert.match(collectSource, /const selected = knowledgeRelation === "option_specific"/);
  assert.match(collectSource, /knowledgeRelation,/);
  assert.match(saveSource, /const resolvedRelations = new Set\(\["question_only", "option_specific", "undetermined"\]\)/);
  assert.match(saveSource, /!resolvedRelations\.has\(relation\)/);
  assert.match(saveSource, /relation === "option_specific"[\s\S]*?reviewed\.knowledgeNodeIds/);
  assert.match(saveSource, /relation === "undetermined"[\s\S]*?reviewed\.uncertaintyNote[\s\S]*?\.trim\(\)/);
  assert.match(script, /event\.target\.matches\("\[data-blind-gold-option-knowledge-relation\]"\)[\s\S]*?syncBlindGoldOptionKnowledgeRelation\(row, \{ clear: true \}\)/);
});

test("option relation summary is derived from four states with explicit precedence", () => {
  assert.match(html, /id="blind-gold-option-relation-overview"/);
  assert.match(html, /id="blind-gold-option-relation-status"/);
  assert.match(html, /id="blind-gold-option-relation-counts"/);
  const summarySource = functionSource("blindGoldReviewOptionRelationSummary", "renderBlindGoldOptionRelationSummary");
  const renderSource = functionSource("renderBlindGoldOptionRelationSummary", "syncBlindGoldOptionKnowledgeSummary");
  const unreviewedIndex = summarySource.indexOf("counts.unreviewed");
  const undeterminedIndex = summarySource.indexOf("counts.undetermined");
  const allQuestionOnlyIndex = summarySource.indexOf("counts.question_only === values.length");
  const allOptionSpecificIndex = summarySource.indexOf("counts.option_specific === values.length");
  assert.ok(unreviewedIndex >= 0 && undeterminedIndex > unreviewedIndex, "unreviewed must take precedence over undetermined");
  assert.ok(allQuestionOnlyIndex > undeterminedIndex, "undetermined must take precedence over completed relation modes");
  assert.ok(allOptionSpecificIndex > allQuestionOnlyIndex);
  assert.match(summarySource, /const applicable = Boolean\(\(item\?\.question\?\.options \|\| \[\]\)\.length \|\| choiceStructure === "composed_options"\)/);
  assert.match(summarySource, /let status = "不适用"/);
  assert.match(summarySource, /待判断 \$\{counts\.unreviewed\} 项/);
  assert.match(summarySource, /已完成，\$\{counts\.undetermined\} 项暂无法判断/);
  assert.match(summarySource, /全部仅使用题目知识/);
  assert.match(summarySource, /全部另有选项知识/);
  assert.match(summarySource, /status = "混合"/);
  assert.match(renderSource, /<span class="not_applicable"><b>-<\/b>非选择题<\/span>/);
  assert.match(renderSource, /options\.fromDom[\s\S]*?#blind-gold-answer-knowledge \[data-blind-gold-option-knowledge-relation\]/);
  assert.match(script, /syncBlindGoldOptionKnowledgeSummary\(row\)[\s\S]*?renderBlindGoldOptionRelationSummary\(selectedBlindGoldReviewItem\(\), \{ fromDom: true \}\)/);
});

test("bulk question-only action is first-stage-only, confirmable, and gold-local", () => {
  assert.match(html, /id="set-all-blind-gold-question-only"[^>]*>全部设为仅使用题目知识<\/button>/);
  const source = functionSource("setAllBlindGoldOptionsQuestionOnly", "blindGoldKnowledgePickerRoots");
  const editSource = functionSource("setBlindGoldReviewEditState", "renderBlindGoldReviewDetail");
  assert.match(source, /const contentComplete = blindGoldReviewStageIsComplete\(item\?\.contentReview\)/);
  assert.match(source, /state\.blindGoldReviewBatch\?\.status === "frozen"/);
  assert.match(source, /contentComplete[\s\S]*?!state\.blindGoldContentEditable[\s\S]*?state\.blindGoldBusinessEditMode[\s\S]*?state\.blindGoldReviewSaving/);
  assert.match(source, /#blind-gold-answer-knowledge \[data-blind-gold-option-row\]/);
  assert.match(source, /selectedOptions/);
  assert.match(source, /data-blind-gold-option-uncertainty-note/);
  assert.match(source, /window\.confirm\([\s\S]*?已选知识节点与不确定说明将被清除/);
  const confirmIndex = source.indexOf("window.confirm");
  const cancelIndex = source.indexOf("if (!confirmed) return;");
  const mutationIndex = source.indexOf('relation.value = "question_only"');
  assert.ok(confirmIndex >= 0 && cancelIndex > confirmIndex && mutationIndex > cancelIndex, "cancel must return before any row mutation");
  assert.match(source, /\[\.\.\.knowledge\.options\]\.forEach\(\(option\) => \{ option\.selected = false; \}\)/);
  assert.match(source, /if \(uncertainty\) uncertainty\.value = ""/);
  assert.match(source, /syncBlindGoldOptionKnowledgeRelation\(row, \{ clear: true \}\)/);
  assert.match(source, /markBlindGoldContentChanged\(\)/);
  assert.doesNotMatch(source, /requestJson|saveBlindGoldReview|syncBlindGoldBusinessContent|business-content|\/content`|dispatchEvent/);
  assert.match(editSource, /setAllQuestionOnlyButton\.disabled = frozen \|\| contentComplete \|\| !goldContentEditable \|\| state\.blindGoldReviewSaving/);
  assert.match(script, /#set-all-blind-gold-question-only"\)\.addEventListener\("click", setAllBlindGoldOptionsQuestionOnly\)/);
});

test("undetermined relations require and retain only an explicit uncertainty note", () => {
  const renderSource = functionSource("blindGoldReviewOptionKnowledgeHtml", "syncBlindGoldOptionKnowledgeSummary");
  const relationSource = functionSource("syncBlindGoldOptionKnowledgeRelation", "setAllBlindGoldOptionsQuestionOnly");
  const collectSource = functionSource("blindGoldReviewCollectAnswerKnowledge", "blindGoldReviewCollectFamilyGold");
  const saveSource = functionSource("saveBlindGoldReview", "freezeBlindGoldReviewSet");
  assert.match(renderSource, /data-blind-gold-option-uncertainty-field \$\{knowledgeRelation === "undetermined" \? "" : "hidden"\}/);
  assert.match(renderSource, /data-blind-gold-option-uncertainty-note[\s\S]*?option\.uncertaintyNote/);
  assert.match(relationSource, /const undetermined = relation === "undetermined"/);
  assert.match(relationSource, /if \(!undetermined && uncertaintyNote && options\.clear !== false\) uncertaintyNote\.value = ""/);
  assert.match(relationSource, /uncertaintyField\.hidden = !undetermined/);
  assert.match(collectSource, /uncertaintyNote: knowledgeRelation === "undetermined"[\s\S]*?data-blind-gold-option-uncertainty-note/);
  assert.match(collectSource, /uncertaintyNote:[\s\S]*?: ""/);
  assert.match(saveSource, /relation === "undetermined"[\s\S]*?reviewed\.uncertaintyNote[\s\S]*?\.trim\(\)/);
  assert.match(script, /#blind-gold-answer-knowledge"\)\.addEventListener\("input", \(event\) => \{[\s\S]{0,500}data-blind-gold-option-uncertainty-note[\s\S]{0,300}markBlindGoldContentChanged\(\)/);
});

test("option-knowledge-v2 separates direct options from composed atomic statements", () => {
  const renderSource = functionSource("blindGoldReviewOptionKnowledgeHtml", "syncBlindGoldOptionKnowledgeSummary");
  const collectSource = functionSource("blindGoldReviewCollectAnswerKnowledge", "blindGoldReviewCollectFamilyGold");
  const saveSource = functionSource("saveBlindGoldReview", "freezeBlindGoldReviewSet");
  assert.match(script, /const blindGoldOptionKnowledgeProtocolVersion = "option-knowledge-v2"/);
  assert.match(script, /return value === "composed_options" \? "composed_options" : "direct_options"/);
  assert.match(renderSource, /const composed = choiceStructure === "composed_options"/);
  assert.match(renderSource, /const rows = composed[\s\S]*?blindGoldReviewAtomicStatements\(item, answerKnowledge\)[\s\S]*?: \(item\.question\?\.options \|\| \[\]\)\.map/);
  assert.match(renderSource, /data-blind-gold-unit-kind="\$\{composed \? "atomic" : "option"\}"/);
  assert.match(renderSource, /\$\{composed \? `<label class="blind-gold-atomic-basis-field">/);
  assert.match(renderSource, /data-blind-gold-atomic-basis[\s\S]*?option\.basis/);
  assert.doesNotMatch(renderSource.slice(renderSource.indexOf(': `<label><span>角色'), renderSource.indexOf("<label><span>知识关系")), /data-blind-gold-atomic-basis/);
  assert.match(renderSource, /blindGoldReviewOptionComposition\(item, answerKnowledge\)/);
  assert.match(renderSource, /aria-label="组合选项映射与答案角色"/);
  assert.match(renderSource, /原子映射/);
  assert.match(collectSource, /optionKnowledgeProtocolVersion: blindGoldOptionKnowledgeProtocolVersion/);
  assert.match(collectSource, /choiceStructure,/);
  assert.match(collectSource, /const optionKnowledge = choiceStructure === "composed_options" \? \[\] : collectedKnowledgeUnits/);
  assert.match(collectSource, /const atomicStatements = choiceStructure === "composed_options" \? collectedKnowledgeUnits : \[\]/);
  assert.match(collectSource, /basis: atomic \? row\.querySelector\("\[data-blind-gold-atomic-basis\]"\)\?\.value\.trim\(\) \|\| ""/);
  assert.match(collectSource, /const optionComposition = choiceStructure === "composed_options"[\s\S]*?blindGoldReviewOptionComposition/);
  assert.match(saveSource, /const choiceStructure = answerKnowledge\.choiceStructure \|\| "direct_options"/);
  assert.match(saveSource, /if \(choiceStructure === "composed_options"\)/);
  assert.match(saveSource, /answerKnowledge\.atomicStatements/);
  assert.match(saveSource, /!String\(reviewed\.basis \|\| ""\)\.trim\(\)/);
  assert.match(saveSource, /answerKnowledge\.optionComposition/);
  assert.match(saveSource, /answerKnowledge\.optionKnowledge/);
  assert.match(saveSource, /atomicKeys/);
  assert.match(saveSource, /reviewed\.role === "unreviewed"/);
  assert.match(script, /data-blind-gold-option-uncertainty-note\], \[data-blind-gold-atomic-basis\][\s\S]{0,200}markBlindGoldContentChanged\(\)/);
  assert.match(styles, /\.blind-gold-atomic-basis-field textarea/);
  assert.match(styles, /\.blind-gold-option-row-editor\.is-atomic \.blind-gold-option-knowledge-field,[\s\S]*?grid-column:\s*2/);
});

test("option knowledge relation follows gold edit permissions and keeps a single-column narrow editor", () => {
  const renderSource = functionSource("blindGoldReviewOptionKnowledgeHtml", "syncBlindGoldOptionKnowledgeSummary");
  const editSource = functionSource("setBlindGoldReviewEditState", "renderBlindGoldReviewDetail");
  assert.match(renderSource, /data-blind-gold-option-knowledge-relation \$\{frozen \? "disabled" : ""\}/);
  assert.match(editSource, /#blind-gold-answer-knowledge input, #blind-gold-answer-knowledge select, #blind-gold-answer-knowledge textarea, #blind-gold-answer-knowledge button/);
  assert.match(editSource, /control\.disabled = !\(goldContentEditable \|\| businessEditable\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.blind-gold-option-row-editor \{ padding-left: 10px; grid-template-columns: minmax\(0, 1fr\); \}/);
});

test("question knowledge focus distinguishes answer core from a non-covering scope anchor", () => {
  const roleSource = functionSource("blindGoldReviewHumanAnswerKnowledge", "blindGoldReviewChoiceStructure");
  const pickerSource = functionSource("blindGoldKnowledgePickerRoots", "blindGoldReviewKnowledgeSummary");
  const coverageSource = functionSource("blindGoldReviewFamilyCoverage", "syncBlindGoldRelatedFamilyPickerSummary");
  const collectSource = functionSource("blindGoldReviewCollectAnswerKnowledge", "blindGoldReviewCollectFamilyGold");
  assert.match(html, /id="blind-gold-core-knowledge-role"[^>]*role="radiogroup"/);
  assert.match(html, /name="blind-gold-core-knowledge-role" value="core" checked/);
  assert.match(html, /name="blind-gold-core-knowledge-role" value="scope_anchor"/);
  assert.match(roleSource, /answerKnowledge\?\.coreKnowledgeRole === "scope_anchor" \? "scope_anchor" : "core"/);
  assert.match(roleSource, /blindGoldCoreKnowledgeRoleLabels/);
  assert.match(html, /id="blind-gold-required-knowledge-picker"[^>]*data-blind-gold-lock-core="true"/);
  assert.match(html, /placeholder="搜索最小充分知识集"/);
  assert.match(html, /id="blind-gold-required-knowledge"[^>]*data-blind-gold-knowledge-select[^>]*multiple hidden/);
  assert.doesNotMatch(html, /id="blind-gold-required-knowledge"[^>]*size=/);
  assert.match(pickerSource, /#blind-gold-review-form \[data-blind-gold-knowledge-picker\]/);
  assert.match(pickerSource, /blindGoldKnowledgePickerLockedValue/);
  assert.match(pickerSource, /blindGoldSelectedCoreKnowledgeRole\(\) !== "core"\) return ""/);
  assert.match(pickerSource, /removeScopeAnchor = false/);
  assert.match(pickerSource, /selectedRole === "scope_anchor" && removeScopeAnchor/);
  assert.match(pickerSource, /focusOption\.selected = false/);
  assert.match(pickerSource, /题目知识焦点，已锁定/);
  assert.match(script, /#blind-gold-core-knowledge"\)\.addEventListener\("change"[\s\S]*?removeScopeAnchor: true/);
  assert.match(script, /#blind-gold-core-knowledge-role"\)\.addEventListener\("change"[\s\S]*?removeScopeAnchor: true/);
  assert.match(script, /requiredKnowledgeKeys[\s\S]*?option\.selected = requiredKnowledgeKeys\.has\(option\.value\)/);
  assert.match(collectSource, /blindGoldReviewSelectedNodes\("#blind-gold-required-knowledge", item\)/);
  assert.match(collectSource, /coreKnowledgeRole = blindGoldSelectedCoreKnowledgeRole\(item\)/);
  assert.match(collectSource, /coreKnowledgeRole,/);
  assert.match(coverageSource, /const expected = blindGoldUniqueKnowledgeNodes\(answerKnowledge\.requiredKnowledge \|\| \[\]\)/);
  assert.match(coverageSource, /coreRole === "scope_anchor" \? "scope_anchor"/);
  assert.match(coverageSource, /\["matched", "scope_anchor"\]\.includes\(coverage\.coreStatus\)/);
  assert.match(coverageSource, /后台目录锚点：\$\{escapeHtml\(blindGoldReviewNodeLabel\(coverage\.questionCore\)\)\}（不计入联合覆盖）/);
  assert.match(script, /classification_gold_review_scope_anchor_invalid: "范围锚点必须覆盖至少一个实际作答必需知识/);
  assert.match(script, /#blind-gold-core-knowledge, #blind-gold-required-knowledge"\)[\s\S]*?control\.disabled = !businessEditable/);
  assert.match(script, /input\[name="blind-gold-core-knowledge-role"\][\s\S]*?control\.disabled = !businessEditable/);
  assert.match(styles, /\.blind-gold-field-grid \.blind-gold-knowledge-field/);
  assert.match(styles, /\.blind-gold-core-knowledge-role \{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.blind-gold-core-knowledge-role \{ width: 100%; min-width: 0; \}/);
});

test("question knowledge focus reuses the searchable knowledge picker in single-select mode", () => {
  const pickerSource = functionSource("blindGoldKnowledgePickerRoots", "blindGoldReviewKnowledgeSummary");
  assert.match(html, /id="blind-gold-core-knowledge-picker"[^>]*data-blind-gold-knowledge-picker[^>]*data-blind-gold-knowledge-single="true"/);
  assert.match(html, /id="blind-gold-core-knowledge-panel"[^>]*popover="auto"/);
  assert.match(html, /placeholder="搜索知识焦点或教材路径"/);
  assert.match(html, /id="blind-gold-core-knowledge"[^>]*data-blind-gold-knowledge-select hidden/);
  assert.match(pickerSource, /const single = root\.dataset\.blindGoldKnowledgeSingle === "true"/);
  assert.match(pickerSource, /type="\$\{single \? "radio" : "checkbox"\}"/);
  assert.match(script, /if \(single\) \[\.\.\.select\.options\]\.forEach\(\(entry\) => \{ entry\.selected = entry === option; \}\)/);
  assert.match(script, /if \(single\) \{[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?setBlindGoldKnowledgePickerOpen\(root, false\);[\s\S]*?focus\(\)[\s\S]*?\}, 0\)/);
  assert.match(script, /renderBlindGoldKnowledgePicker\(coreRoot\)/);
});

test("formal family pickers exclude historical snapshot families while preserving audit data", () => {
  const source = functionSource("blindGoldReviewFormalFamilies", "blindGoldReviewFamilyIsHistorical");
  assert.match(source, /blindGoldReviewFamilies\(item\)\.filter\(\(family\) => !blindGoldReviewFamilyIsHistorical\(family\)\)/);
  assert.match(script, /历史快照 · 仅供追溯，不可提交/);
  assert.match(script, /当前正式题族目录/);
});

test("family contribution picker keeps textbook descendants and reviewed source knowledge available", () => {
  const source = functionSource("blindGoldFamilyContributionRowHtml", "renderBlindGoldFamilyContributions");
  assert.match(source, /blindGoldReviewKnowledgeDescendants\(coverage, catalogNodes\)/);
  assert.match(source, /\.\.\.coverageCandidates/);
  assert.match(source, /\.\.\.invalidSelected/);
  assert.match(source, /validCatalogCandidates\.length \|\| catalogNodes\.length \? \[\] : sourceCandidates/);
  assert.match(source, /本题还有知识未被当前题族覆盖/);
});

test("mutation responses are applied as authoritative item state without a refresh", () => {
  const source = functionSource("updateBlindGoldReviewItem", "renderBlindGoldReviewEmpty");
  assert.match(source, /const authoritative = options\?\.authoritative === true/);
  assert.match(source, /if \(!authoritative\)/);
  assert.match(script, /updateBlindGoldReviewItem\(contentResponse\.item,[\s\S]*?\{ authoritative: true \}\)/);
  assert.match(script, /updateBlindGoldReviewItem\(familyResponse\.item,[\s\S]*?\{ authoritative: true \}\)/);
  assert.match(script, /batch\.summary = blindGoldReviewSummaryFromItems\(batch\.items/);
});

test("question summary stays visible and visible version labels distinguish gold from formal questions", () => {
  assert.match(html, /id="blind-gold-question-sticky-summary"/);
  assert.match(html, /id="blind-gold-question-knowledge-path"/);
  assert.match(styles, /\.blind-gold-question-head\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*?\.blind-gold-question-head \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(script, /正式题目版本 v\$\{question\.version \|\| 0\}/);
  assert.match(script, /#blind-gold-question-knowledge-path/);
  assert.match(script, /blindGoldReviewNodeLabel\(answerKnowledge\.coreKnowledge/);
  assert.match(script, /金标集版本 \$\{batch\.version \|\| "V1"\}/);
  assert.match(script, /生成题目版本 v\$\{\(Number\(item\.question\?\.version\) \|\| 0\) \+ 1\}/);
});

test("list rows show review stage and risk without rendering the long question id", () => {
  const source = functionSource("renderBlindGoldReviewList", "blindGoldReviewKnowledgeTagsHtml");
  assert.match(source, /blindGoldReviewItemStage\(item\)/);
  assert.match(source, /blindGoldReviewItemRisk\(item\)/);
  assert.match(source, /blind-gold-review-list-mode/);
  assert.doesNotMatch(source, /正式题目版本 v/);
  assert.doesNotMatch(source, /blindGoldReviewNodeLabel/);
  assert.doesNotMatch(source, /<small>\$\{escapeHtml\(item\.questionId\)/);
  assert.match(script, /label: "答案知识完成 · 题族待审"/);
  assert.match(script, /label: "可冻结"/);
});

test("review navigation advances only through the explicit save-and-next action", () => {
  assert.match(html, /id="save-and-next-blind-gold-review"[^>]*>保存并审核下一题</);
  const source = functionSource("saveBlindGoldReview", "freezeBlindGoldReviewSet");
  assert.match(source, /event\.submitter\?\.id === "save-and-next-blind-gold-review"/);
  assert.match(source, /const nextPending = advanceAfterSave \? blindGoldReviewNextPendingItem\(item\) : null/);
  assert.match(source, /if \(nextPending\) \{[\s\S]*?state\.selectedBlindGoldQuestionId = nextPending\.questionId/);
  assert.doesNotMatch(source, /state\.blindGoldReviewBatch\.items\.find\(\(entry\) => blindGoldReviewItemResult\(entry\) === "pending_review"\)/);
});

test("AI candidates stay hidden until the corresponding human stage has been submitted", () => {
  assert.match(html, /id="blind-gold-content-ai-comparison"[^>]*hidden/);
  assert.match(html, /id="blind-gold-family-ai-comparison"[^>]*hidden/);
  const source = functionSource("renderBlindGoldAiComparisons", "blindGoldEvidenceRowHtml");
  assert.match(source, /stage\.available === true && stage\.revealed === true && stage\.candidate/);
  assert.match(source, /panel\.hidden = !revealed/);
  assert.match(source, /panel\.open = Boolean\(revealed\)/);
  assert.match(source, /先于 AI 候选独立提交/);
  assert.doesNotMatch(source, /officialBaseline/);
  assert.match(script, /evidence\.humanSelection\?\.status === "selected"/);
  assert.match(script, /candidateOnly:\s*false/);
});

test("textbook evidence keeps the complete source pool while human selection controls checked rows", () => {
  const rowSource = functionSource("blindGoldEvidenceRowHtml", "blindGoldEvidenceListHtml");
  const displaySource = functionSource("blindGoldReviewDisplayedEvidence", "renderBlindGoldFamilyDefinition");
  const collectSource = functionSource("blindGoldReviewCollectAnswerKnowledge", "blindGoldReviewCollectFamilyGold");
  assert.match(rowSource, /evidence\.humanSelection\?\.status === "selected"/);
  assert.doesNotMatch(rowSource, /candidateOnly !== true/);
  assert.match(displaySource, /item\?\.sourceMaterials\?\.textbookEvidence \|\| \[\]/);
  assert.match(displaySource, /humanByChunkId/);
  assert.match(displaySource, /humanOnlyEvidence/);
  assert.match(displaySource, /return \[\.\.\.fullSourcePool, \.\.\.humanOnlyEvidence\]/);
  assert.match(collectSource, /selectedChunkId/);
  assert.match(collectSource, /displayedEvidence\.find\(\(evidence\) => selectedChunkId && evidence\.chunkId === selectedChunkId\)/);
  assert.doesNotMatch(collectSource, /displayedEvidence\[Number\(row\.dataset\.blindGoldEvidenceIndex\)\]/);
});

test("freezing requires a real hash preview before an explicit commit", () => {
  assert.match(html, /id="blind-gold-freeze-preview-dialog"/);
  assert.match(html, /id="blind-gold-freeze-preview-content-hash"/);
  assert.match(html, /id="blind-gold-freeze-preview-file-hash"/);
  assert.match(html, /id="commit-blind-gold-freeze"[^>]*>确认冻结</);
  const prepareSource = functionSource("freezeBlindGoldReviewSet", "commitBlindGoldReviewSet");
  assert.match(prepareSource, /\/freeze\/prepare`/);
  assert.match(prepareSource, /response\.preparation/);
  assert.match(script, /#blind-gold-freeze-preview-expiry"\)\.textContent = formatTaskTime\(preparation\.expiresAt\)/);
  assert.doesNotMatch(prepareSource, /\bformatTime\(/);
  assert.match(prepareSource, /showModal\(\)/);
  assert.doesNotMatch(prepareSource, /\/freeze`/);
  // 结束锚点原为 setKnowledgeInspectionSubtab；DEC-092 把子标签机制整块删除后，
  // 它后面的函数变成 knowledgeInspectionQuery（仅锚点变化，本用例的语义断言不变）。
  const commitSource = functionSource("commitBlindGoldReviewSet", "knowledgeInspectionQuery");
  assert.match(commitSource, /\/freeze\/commit`/);
  assert.match(commitSource, /token:\s*preparation\.token/);
  assert.match(commitSource, /预览哈希与落盘哈希一致/);
});

test("freeze semantic blockers are rendered as a navigable per-question checklist", () => {
  const source = functionSource("setBlindGoldFreezeSemanticFeedback", "setBlindGoldReviewFeedback");
  assert.match(source, /blindGoldReviewSemanticIssues\(error\)/);
  assert.match(source, /data-blind-gold-freeze-question-id/);
  assert.match(source, /点击任一条目可直接定位到对应题目/);
  assert.match(script, /setBlindGoldFreezeSemanticFeedback\(error\)/);
  assert.match(script, /focusBlindGoldFreezeIssue\(button\.dataset\.blindGoldFreezeQuestionId\)/);
  assert.match(styles, /\.blind-gold-freeze-issue-button/);
});

test("a frozen gold set opens a custom immutable-parent revision dialog", () => {
  assert.match(html, /id="blind-gold-revision-dialog"/);
  assert.match(html, /父版本保持不变/);
  assert.match(html, /只重审风险项/);
  assert.match(html, /不会启动盲测、不会采纳 AI 预测/);
  assert.match(html, /统一一致性预检共标记 11 题：7 题属于已知硬问题；另 4 题因核心知识或最小充分知识与题族定义不一致而追加/);
  assert.match(html, /id="blind-gold-revision-risk-list"/);
  assert.match(html, /id="confirm-blind-gold-revision"[^>]*>创建 V2 修订草稿</);
  const summarySource = functionSource("renderBlindGoldReviewSummary", "renderBlindGoldFreezeSummary");
  assert.match(summarySource, /blindGoldRevisionNextVersion\(batch\.version\)/);
  const openSource = functionSource("openBlindGoldRevisionDialog", "closeBlindGoldRevisionDialog");
  assert.match(openSource, /batch\.status !== "frozen"/);
  assert.match(openSource, /blindGoldRevisionRisks\(batch\)/);
  assert.match(openSource, /risk\.stem/);
  assert.match(openSource, /showModal\(\)/);
  assert.doesNotMatch(openSource, /window\.(?:alert|confirm)/);
  assert.match(script, /order: 6,[\s\S]*?order: 7,[\s\S]*?order: 9,[\s\S]*?order: 11/);
});

test("frozen revision risks fall back to immutable revision audit fields", () => {
  const source = functionSource("blindGoldRevisionRisks", "blindGoldProvenanceLabel");
  assert.match(source, /qualificationIssues/);
  assert.match(source, /reopenedQuestionIds/);
  assert.match(source, /requestedRiskQuestionIds/);
  assert.match(source, /source\?\.riskQuestionIds/);
  assert.match(source, /冻结批次修订审计要求人工复核/);
  assert.match(source, /const issueByQuestionId = new Map/);
});

test("revision creation posts only the human revision contract and never runs blind testing", () => {
  const source = functionSource("createBlindGoldRevisionDraft", "closeBlindGoldFreezePreview");
  assert.match(source, /\/sets\/\$\{encodeURIComponent\(draft\.sourceBatchId\)\}\/revisions`/);
  assert.match(source, /method:\s*"POST"/);
  assert.match(source, /version:\s*draft\.version/);
  assert.match(source, /title:\s*draft\.title/);
  assert.match(source, /riskQuestionIds:\s*draft\.risks\.map/);
  assert.match(source, /reason:\s*draft\.reason/);
  assert.match(source, /response\.batch \|\| response\.set/);
  assert.match(source, /没有启动盲测、采纳 AI 预测或运行经验沉淀/);
  assert.doesNotMatch(source, /blind-replay|blindReplay|knowledge-classification\/results\/.*apply|agent4/i);
  assert.doesNotMatch(source, /window\.(?:alert|confirm)/);
});

test("revision drafts expose lineage hashes and revision-specific list stages", () => {
  assert.match(html, /id="blind-gold-revision-lineage"/);
  assert.match(html, /id="blind-gold-revision-parent-version"/);
  assert.match(html, /id="blind-gold-revision-parent-file-hash"/);
  assert.match(html, /id="blind-gold-revision-parent-content-hash"/);
  assert.match(html, /id="blind-gold-review-status">[\s\S]*?value="needs_revision">需重审</);
  const lineageSource = functionSource("renderBlindGoldRevisionLineage", "renderBlindGoldReviewList");
  assert.match(lineageSource, /source\.parentVersion/);
  assert.match(lineageSource, /source\.parentFileSha256/);
  assert.match(lineageSource, /source\.parentContentSha256/);
  const stageSource = functionSource("blindGoldReviewItemStage", "blindGoldReviewItemRisk");
  assert.match(stageSource, /label: "继承完成"/);
  assert.match(stageSource, /label: "内容待重审"/);
  assert.match(stageSource, /label: "题族待重审"/);
  assert.match(stageSource, /label: "可冻结"/);
  const filterSource = functionSource("blindGoldReviewFilteredItems", "renderBlindGoldReviewSummary");
  assert.match(filterSource, /status === "needs_revision"/);
  assert.match(filterSource, /"content_re_review", "family_re_review"/);
});

test("late formal-family drift reopens an inherited revision item and refreshes its catalog", () => {
  assert.match(script, /async function sha256Hex\(value\)/);
  assert.match(script, /async function reopenBlindGoldFormalFamilyDrift\(error\)/);
  assert.match(script, /formal_family_live_drift_preflight/);
  assert.match(script, /family-reviews\/reopen/);
  assert.match(script, /state\.blindGoldFamilyCatalogs\.delete\(bookId\)/);
  assert.match(script, /error\.message === "classification_gold_review_formal_family_drift"[\s\S]*?reopenBlindGoldFormalFamilyDrift\(error\)/);
});

test("inherited revision items remain read-only while risk stages stay reviewable", () => {
  const revisionSource = functionSource("blindGoldReviewIsRevisionBatch", "blindGoldRevisionRequiredStages");
  assert.match(revisionSource, /source\?\.parentReviewBatchId/);
  const stageSource = functionSource("blindGoldRevisionItemIsInherited", "blindGoldReviewItemIsReadOnly");
  assert.match(stageSource, /blindGoldRevisionRequiredStages\(item, batch\)\.length === 0/);
  const editSource = functionSource("setBlindGoldReviewEditState", "renderBlindGoldReviewDetail");
  assert.match(editSource, /const revisionLocked = blindGoldRevisionItemIsInherited\(item\)/);
  assert.match(editSource, /const readOnly = frozen \|\| revisionLocked/);
  assert.match(editSource, /form\.classList\.toggle\("is-revision-inherited", revisionLocked\)/);
  assert.match(styles, /\.blind-gold-review-form\.is-revision-inherited::before/);
  assert.match(styles, /\.blind-gold-review-list-state\.inherited_complete/);
  assert.match(styles, /\.blind-gold-review-list-state\.family_re_review/);
});

test("the review page runs the coverage preflight on load and exposes a re-verify action", () => {
  // 页面徽标读的是已保存状态，无法反映“保存之后才被判定不合格”的题目。
  // 审核页必须在批次就绪时主动跑覆盖门禁预检，而不是等到冻结才暴露阻断。
  assert.match(html, /id="verify-blind-gold-preflight"/);
  assert.match(html, /id="verify-blind-gold-preflight"[^>]*title="[^"]*重新开放题族审核/);
  assert.match(script, /family-reviews\/preflight/);
  assert.match(script, /family-reviews\/sync-preflight/);
  const preflightSource = functionSource("blindGoldPreflightIssues", "blindGoldReviewItemStage");
  assert.match(preflightSource, /state\.blindGoldPreflight/);
  assert.match(preflightSource, /async function refreshBlindGoldPreflight/);
  const loadSource = functionSource("verifyBlindGoldPreflight", "loadBlindGoldReviewSets");
  assert.match(loadSource, /已重新校验：\$\{blocked\.length\} 题未通过覆盖门禁/);
  // 批次就绪后立即预检，且必须带 isCurrentLoad 守卫，避免过期请求覆盖新批次。
  assert.match(script, /await refreshBlindGoldPreflight\(\{ quiet: true \}\);\s*\n\s*if \(!isCurrentLoad\(\)\) return false;/);
});

test("preflight blockers are rendered on the item row instead of only at freeze time", () => {
  const stageSource = functionSource("blindGoldReviewItemStage", "blindGoldReviewItemRisk");
  assert.match(stageSource, /blindGoldPreflightIssues\(item\.questionId\)\.length\) return blindGoldPreflightStage\(item\)/);
  assert.match(stageSource, /function blindGoldPreflightStage\(item = \{\}\)/);
  assert.match(stageSource, /key: "preflight_blocked"/);
  assert.match(stageSource, /label: "预检阻断"/);
  const riskSource = functionSource("blindGoldReviewItemRisk", "blindGoldReviewPreferredResult");
  assert.match(riskSource, /预检阻断：\$\{summary\}/);
  const filterSource = functionSource("blindGoldReviewFilteredItems", "renderBlindGoldReviewSummary");
  assert.match(filterSource, /"content_re_review", "family_re_review", "preflight_blocked"/);
  const summarySource = functionSource("renderBlindGoldReviewSummary", "renderBlindGoldReviewList");
  assert.match(summarySource, /#verify-blind-gold-preflight/);
  assert.match(summarySource, /预检阻断 \$\{preflightBlocked\}/);
  assert.match(styles, /\.blind-gold-review-list-state\.preflight_blocked/);
});

test("the blind gold review action bar sticks to the bottom as one compact row", () => {
  // 原来用 top: calc(100vh - 128px) 模拟底栏，实际会随内容滚动且高度偏大。
  const barStart = styles.indexOf(".blind-gold-review-actions {");
  const barEnd = styles.indexOf(".blind-gold-freeze-preview-dialog");
  assert.ok(barStart >= 0 && barEnd > barStart, "找不到审核操作栏样式块");
  const bar = styles.slice(barStart, barEnd);
  assert.match(bar, /position:\s*sticky/);
  assert.match(bar, /bottom:\s*0/);
  assert.doesNotMatch(bar, /100vh - 128px/);
  assert.match(bar, /display:\s*flex/);
  // 审核说明压成单行，操作栏整体只占一行
  assert.match(bar, /\.blind-gold-review-actions textarea \{[^}]*height:\s*30px/);
  assert.match(bar, /\.blind-gold-review-actions > label \{[^}]*display:\s*flex/);
  // 保存按钮靠右
  assert.match(bar, /\.blind-gold-review-save-actions \{[^}]*margin-left:\s*auto/);
});

test("blocking review errors are surfaced in the alert dialog instead of the inline banner", () => {
  // 题族裁决阻断与冻结阻断都改为弹窗，横幅只留结果摘要
  const semanticSource = functionSource("setBlindGoldReviewSemanticFeedback", "blindGoldFreezeIssueItem");
  assert.match(semanticSource, /openBlindGoldReviewAlert\(""/);
  assert.doesNotMatch(semanticSource, /element\.innerHTML/);
  assert.match(semanticSource, /setBlindGoldReviewFeedback\(/);
  const freezeSource = functionSource("setBlindGoldFreezeSemanticFeedback", "setBlindGoldReviewFeedback");
  assert.match(freezeSource, /openBlindGoldReviewAlert\(""/);
  assert.doesNotMatch(freezeSource, /element\.innerHTML/);

  // 弹窗必须支持富内容（清单 + 可选展开 + 就地操作按钮）
  const alertSource = functionSource("openBlindGoldReviewAlert", "closeBlindGoldReviewAlert");
  assert.match(alertSource, /options\.html/);
  assert.match(alertSource, /body\.innerHTML = options\.html/);
  assert.match(html, /id="blind-gold-review-alert-message"/);
  // 富内容要放进 div，不能放在 p 里（否则 ol/details 会被解析器截断）
  assert.doesNotMatch(html, /<p class="blind-gold-review-alert-message"/);
  assert.match(styles, /\.blind-gold-review-alert-message\.has-rich-content/);

  // 就地操作与“定位题目”委托在弹窗上，因为内容已经不在原来的反馈条和表单里
  assert.match(script, /#blind-gold-review-alert-dialog"\)\.addEventListener\("click"[\s\S]{0,500}data-confirm-blind-gold-formal-membership/);
  assert.match(script, /#blind-gold-review-alert-dialog"\)\.addEventListener\("click"[\s\S]{0,900}data-blind-gold-freeze-question-id/);
});

test("every blind gold review exception goes through the alert dialog", () => {
  // 横幅只保留异步进度与结果消息；除两条与弹窗配套的摘要外不得再有 error 语气横幅
  const errorBanners = script.match(/setBlindGoldReviewFeedback\([^\n]*"error"\)/g) || [];
  assert.deepEqual(
    errorBanners.map((line) => line.trim()),
    [
      'setBlindGoldReviewFeedback("本题未保存：题族裁决未通过一致性检查，详情见弹窗提示。", "error")',
      'setBlindGoldReviewFeedback("未生成冻结预览：题族裁决未通过一致性检查，详情见弹窗提示。", "error")',
    ],
  );
  // 请求失败类也要走弹窗
  assert.match(script, /openBlindGoldReviewAlert\(`重新载入失败：\$\{friendlyError\(error\)\}`\)/);
  assert.match(script, /openBlindGoldReviewAlert\(`生成冻结预览失败：\$\{friendlyError\(error\)\}`\)/);
  assert.match(script, /openBlindGoldReviewAlert\(`确认正式题族成员失败：\$\{friendlyError\(error\)\}`\)/);
});

test("replay mode save failures explain which level changed", () => {
  // 服务端 details 里带着原层级与本次提交层级，必须转成中文说明而不是只亮英文码
  const source = functionSource("blindGoldReplayModeErrorText", "blindGoldSaveFailureMessage");
  assert.match(source, /details\.previousReplayMode/);
  assert.match(source, /details\.requestedReplayMode/);
  assert.match(source, /blindGoldReviewModeLabels/);
  // 错误码集合定义在函数之前，单独断言整份脚本里包含
  assert.match(script, /"classification_gold_review_replay_mode_correction_required"/);
  const failureSource = functionSource("blindGoldSaveFailureMessage", "saveBlindGoldReview");
  assert.match(failureSource, /人工修正/);
  assert.match(failureSource, /最终盲测层级/);
  // 保存失败分支必须用它而不是直接贴错误码
  const saveSource = functionSource("saveBlindGoldReview", "renderBlindGoldFreezePreview");
  assert.match(saveSource, /openBlindGoldReviewAlert\(blindGoldSaveFailureMessage\(error,/);
});
