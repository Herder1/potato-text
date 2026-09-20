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

  return { createGuard, createControlLock };
});
