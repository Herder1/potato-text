(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports
    ? require("./question-enrichment-diff") : root.QuestionEnrichmentDiff);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuestionReviewModel = api;
})(typeof globalThis === "object" ? globalThis : this, function ({ suggestionChanges }) {
  const text = value => String(value || "").trim();
  const present = value => Boolean(text(value)) && !/^(待归类|未归类|待补充|未知|暂无|无)$/.test(text(value));
  const list = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(present))];
  const set = value => list(value).sort();
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
  function activeSuggestion(item) {
    return suggestionChanges(item).length ? item.suggestion : null;
  }
  function fingerprintContent(value) {
    const role = text(value.primaryNodeRole || value.coreKnowledgeRole || "core");
    const primaryNodeId = text(value.primaryNodeId || value.nodeId);
    const required = set([...(value.requiredNodeIds || []), ...(role === "core" ? [primaryNodeId] : [])]);
    const focusKey = text(value.focus?.key || value.focusKey);
    return {
      primaryNodeId, primaryNodeRole: role, requiredNodeIds: required,
      problemKnowledgeRangeNodeIds: set([...(value.problemKnowledgeRangeNodeIds || value.problemKnowledgeNodeIds || []), ...required]),
      knowledgeThemeRangeAnchorNodeId: text(value.knowledgeThemeRangeAnchorNodeId || value.themeRangeAnchorNodeId || value.scopeAnchorNodeId || (role === "scope_anchor" ? primaryNodeId : "")),
      auxiliaryNodeIds: set(value.auxiliaryNodeIds),
      action: text(value.assessmentAction || value.action || value.focus?.action),
      focus: { key: focusKey, label: focusKey ? "" : text(value.focus?.label || value.focusLabel), action: text(value.focus?.action) },
      relations: (value.relations || []).map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      optionKnowledge: (value.optionKnowledge || []).map(row => ({
        key: text(row.key).toUpperCase(), text: text(row.text), knowledgeRelation: text(row.knowledgeRelation || "unreviewed"),
        role: text(row.role || "unreviewed"), knowledgeNodeIds: set(row.knowledgeNodeIds),
        knowledgeLabels: list(row.knowledgeNodeIds).length ? [] : set(row.knowledgeLabels),
      })).sort((a, b) => a.key.localeCompare(b.key)),
    };
  }
  function sameFingerprint(left, right) {
    return Boolean(left && right) && same(fingerprintContent(left), fingerprintContent(right));
  }
  function familyAdditions(question, memberships) {
    // Existing pending/rejected membership is still a relationship, not a new addition.
    const existing = new Set((question?.familyMemberships || []).map(m => text(m.familyId)));
    return list((memberships || []).map(m => m.familyId)).filter(id => !existing.has(id));
  }
  function validCandidate(candidate, question) {
    return candidate && !["stale", "rejected", "inactive", "failed"].includes(candidate.status)
      && (!candidate.questionVersion || Number(candidate.questionVersion) === Number(question.version));
  }
  function fields(item, bookName = value => value) {
    const q = item.question || {};
    const s = activeSuggestion(item) || {};
    const memberships = (q.familyMemberships || []).filter(m => !["inactive", "rejected"].includes(m.reviewStatus) && !["archived", "rejected"].includes(m.familyStatus));
    const confirmedFamilies = memberships.filter(m => m.reviewStatus === "confirmed");
    const confirmedIds = new Set(confirmedFamilies.map(m => m.familyId));
    const candidateFamilies = memberships.filter(m => m.reviewStatus !== "confirmed" && !confirmedIds.has(m.familyId));
    const fp = q.knowledgeFingerprint?.status === "confirmed" && q.knowledgeFingerprint.primaryNodeId ? q.knowledgeFingerprint : null;
    const candidate = validCandidate(q.candidateKnowledgeFingerprint, q) && q.candidateKnowledgeFingerprint?.primaryNodeId ? q.candidateKnowledgeFingerprint : null;
    const fingerprintLabel = value => text(value?.primaryNodeLabel || value?.focus?.object || value?.primaryKnowledgePoint || value?.primaryNodeId);
    const names = rows => rows.map(m => m.familyName || m.familyId).join("、");
    const make = (key, label, current, proposed, currentText = current, proposedText = proposed) => {
      const hasCurrent = Array.isArray(current) ? current.length > 0 : present(current);
      const hasProposed = Array.isArray(proposed) ? proposed.length > 0 : present(proposed);
      return { key, label, value: text(hasCurrent ? currentText : hasProposed ? proposedText : ""),
        status: hasCurrent ? "stored" : hasProposed ? "suggested" : "missing",
        newSuggestion: hasCurrent && hasProposed && !same(Array.isArray(current) ? set(current) : text(current), Array.isArray(proposed) ? set(proposed) : text(proposed)) };
    };
    return [
      make("stem", "题干", q.stem, s.stem),
      make("book", "教材", q.bookId, s.bookId, q.bookId ? bookName(q.bookId) : "", s.bookLabel || (s.bookId ? bookName(s.bookId) : "")),
      make("chapter", "目录", q.chapter, s.catalogPath),
      make("fingerprint", "指纹", fp ? JSON.stringify(fingerprintContent(fp)) : "", candidate ? JSON.stringify(fingerprintContent(candidate)) : "", q.knowledgeFingerprintLabel || fingerprintLabel(fp), q.knowledgeFingerprintLabel || fingerprintLabel(candidate)),
      make("knowledge", "知识点", list(q.knowledgePoints), list(s.knowledgePoints), list(q.knowledgePoints).join("、"), list(s.knowledgePoints).join("、")),
      make("family", "题族", confirmedFamilies.map(m => m.familyId), candidateFamilies.map(m => m.familyId), names(confirmedFamilies), names(candidateFamilies)),
    ];
  }
  function needsAttribution(item) {
    return fields(item).some(field => ["fingerprint", "family"].includes(field.key) && (field.status !== "stored" || field.newSuggestion));
  }
  function initialTab(item) {
    return activeSuggestion(item) ? "suggestions" : needsAttribution(item) ? "classification" : "details";
  }
  return { activeSuggestion, suggestionChanges, sameFingerprint, familyAdditions, fields, needsAttribution, initialTab };
});
