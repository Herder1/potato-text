(function initializeKnowledgeInspectionApplyGuard(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ShukaoKnowledgeInspectionApplyGuard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createKnowledgeInspectionApplyGuardApi() {
  function createGuard() {
    let sequence = 0;
    let currentSession = null;
    let currentRequest = null;

    return {
      open(resultId) {
        if (currentRequest) return null;
        currentSession = Object.freeze({
          id: `knowledge-inspection-${++sequence}`,
          resultId: String(resultId || ""),
        });
        return currentSession;
      },
      begin(session, metadata = {}) {
        if (!session || session !== currentSession || currentRequest) return null;
        currentRequest = Object.freeze({
          session,
          resultId: String(metadata.resultId || session.resultId || ""),
          commitId: String(metadata.commitId || ""),
        });
        return currentRequest;
      },
      isCurrent(request) {
        return Boolean(request && request === currentRequest && request.session === currentSession);
      },
      finish(request) {
        if (!this.isCurrent(request)) return false;
        currentRequest = null;
        return true;
      },
      close(session = currentSession) {
        if (currentRequest || !session || session !== currentSession) return false;
        currentSession = null;
        return true;
      },
      currentSession() {
        return currentSession;
      },
      currentRequest() {
        return currentRequest;
      },
    };
  }

  function createControlLock() {
    const disabledBeforeLock = new Map();

    return {
      lock(controls = []) {
        [...controls].forEach((control) => {
          if (!control || !("disabled" in control)) return;
          if (!disabledBeforeLock.has(control)) disabledBeforeLock.set(control, Boolean(control.disabled));
          control.disabled = true;
        });
      },
      unlock() {
        disabledBeforeLock.forEach((wasDisabled, control) => {
          control.disabled = wasDisabled;
        });
        disabledBeforeLock.clear();
      },
      isLocked() {
        return disabledBeforeLock.size > 0;
      },
    };
  }

  // ── 改库载荷的**唯一**构造函数（DEC-100：改库入口只在「完善题目」）──
  // 这一段是从巡检弹窗原来那段内联构造里抽出来的纯函数，语义逐字保留（未放宽／未加严），
  // 前端两处（老弹窗的死代码与完善题目的活路径）都调它，避免出现第二份"什么算合法提交"的判据。
  const APPLY_SCHEMA_VERSION = "ClassificationCommitV1";
  const APPLY_ENDPOINT = "/api/admin/knowledge-classification/apply";

  function normalizeApplyPrimaryNodeRole(value) {
    return value === "scope_anchor" ? "scope_anchor" : "core";
  }

  function normalizeApplySelection(selection = {}) {
    const selectedNodeIds = [...new Set(
      (Array.isArray(selection.selectedNodeIds) ? selection.selectedNodeIds : [])
        .map((nodeId) => String(nodeId || "")).filter(Boolean),
    )].sort();
    const familyMemberships = (Array.isArray(selection.familyMemberships) ? selection.familyMemberships : [])
      .map((membership) => {
        const isPrimary = Boolean(membership && membership.isPrimary);
        const rawRole = String(membership && membership.coverageRole || "").trim();
        return {
          familyId: String(membership && membership.familyId || ""),
          isPrimary,
          coverageRole: isPrimary ? "required" : (rawRole === "required" ? "required" : "reference"),
          contributionKnowledgeNodeIds: [...new Set(
            (Array.isArray(membership && membership.contributionKnowledgeNodeIds) ? membership.contributionKnowledgeNodeIds : [])
              .map((nodeId) => String(nodeId || "")).filter(Boolean),
          )],
        };
      })
      .filter((membership) => membership.familyId);
    return {
      selectedNodeIds,
      selectedPrimary: String(selection.selectedPrimary || ""),
      primaryNodeRole: normalizeApplyPrimaryNodeRole(selection.primaryNodeRole),
      familyMemberships,
      familyDeferred: selection.familyDeferred === true,
      createCandidateFamily: selection.createCandidateFamily === true,
      candidateFamilyDraft: selection.createCandidateFamily === true ? (selection.candidateFamilyDraft || null) : null,
    };
  }

  /**
   * 提交前校验：判据与顺序**逐条对应**后端 `knowledgeInspectionApplyBlockReason` 与原弹窗内联校验。
   * 返回 ""＝可以提交；返回非空字符串＝要显示的拦截原因。前端只是提前提示，不得放宽或加严。
   */
  function validateApplySelection(options = {}) {
    const selection = normalizeApplySelection(options.selection);
    const resultBlockReason = String(options.resultBlockReason || "");
    if (resultBlockReason) return resultBlockReason;
    if (!selection.selectedNodeIds.length) return "请至少勾选一个作答必需知识";
    if (!selection.selectedPrimary) return "请指定题目知识焦点";
    if (selection.primaryNodeRole === "core" && !selection.selectedNodeIds.includes(selection.selectedPrimary)) {
      return "作答核心必须计入最小充分知识集";
    }
    if (selection.primaryNodeRole === "scope_anchor" && selection.selectedNodeIds.includes(selection.selectedPrimary)) {
      return "范围锚点不能计入最小充分知识集";
    }
    if (!selection.createCandidateFamily && selection.familyMemberships.length
      && !selection.familyMemberships.some((membership) => membership.isPrimary)) {
      return "请从已选题族中指定一个主题族";
    }
    if (selection.createCandidateFamily && selection.familyMemberships.some((membership) => membership.isPrimary)) {
      return "新建题族将自动成为主题族，已有题族只能作为关联题族";
    }
    const candidateDraftError = selection.createCandidateFamily ? String(options.candidateDraftError || "") : "";
    if (candidateDraftError) return candidateDraftError;
    if (!selection.createCandidateFamily && !selection.familyMemberships.length && !selection.familyDeferred) {
      return "请选择主题族，或明确将本题放入待归组";
    }
    const familyCoverageError = String(options.familyCoverageError || "");
    if (familyCoverageError) return familyCoverageError;
    if (options.adjusted === true && !String(options.adjustmentReason || "").trim()) {
      return "你调整了 AI 建议，请填写一句调整依据，供 Agent 4 沉淀为修正案例。";
    }
    return "";
  }

  function buildApplyRequest(options = {}) {
    const selection = normalizeApplySelection(options.selection);
    const resultId = String(options.resultId || "");
    const familyMemberships = selection.familyMemberships;
    const candidateFamilyDraft = selection.candidateFamilyDraft;
    return {
      schemaVersion: APPLY_SCHEMA_VERSION,
      commitId: String(options.commitId || ""),
      resultIds: [resultId],
      selections: [{
        resultId,
        primaryNodeId: selection.selectedPrimary,
        primaryNodeRole: selection.primaryNodeRole,
        requiredNodeIds: selection.selectedNodeIds,
        familyKnowledgeProtocolVersion: String(options.familyKnowledgeProtocolVersion || ""),
        familyMemberships,
        ...(selection.createCandidateFamily ? { createCandidateFamily: true, candidateFamilyDraft } : {}),
      }],
      adjustmentReason: String(options.adjustmentReason || ""),
    };
  }

  return { createGuard, createControlLock, APPLY_SCHEMA_VERSION, APPLY_ENDPOINT, normalizeApplyPrimaryNodeRole, normalizeApplySelection, validateApplySelection, buildApplyRequest };
});
