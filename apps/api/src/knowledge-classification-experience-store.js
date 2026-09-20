const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_MESSAGES = 10000;
const MAX_RULES = 2000;
const MAX_CASES = 5000;
const MAX_CORRECTIONS = 5000;
const MAX_RULE_EXCEPTIONS = 5000;
const MAX_REVIEW_EVENTS = 10000;
const MAX_DOSSIER_SUGGESTIONS = 2000;
const ruleStatuses = new Set(["draft", "active", "inactive"]);
const rulePriorities = new Set(["low", "medium", "high"]);
const messageAgents = new Set(["agent1", "agent2", "agent3", "agent4"]);
const messageRoles = new Set(["reviewer", "agent"]);
const reviewEventTypes = new Set(["classification_correction", "reviewer_feedback", "rule_conflict", "classification_confirmation"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanText(value, limit = 1000) {
  return String(value || "").trim().slice(0, limit);
}

function uniqueStrings(value, limit = 50) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 240)).filter(Boolean))].slice(0, limit);
}

function semanticTokens(value) {
  const text = cleanText(value, 12000).normalize("NFKC").toLocaleLowerCase("zh-CN");
  const tokens = new Set(text.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,8}/gu) || []);
  (text.match(/[\u3400-\u9fff]{2,}/gu) || []).forEach((part) => {
    for (let size = 2; size <= Math.min(4, part.length); size += 1) {
      for (let index = 0; index <= part.length - size; index += 1) tokens.add(part.slice(index, index + size));
    }
  });
  return [...tokens].slice(0, 300);
}

function semanticSimilarity(left, right) {
  const leftTokens = new Set(semanticTokens(left));
  const rightTokens = new Set(semanticTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const matches = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return matches / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function vectorEmbedding(value, dimensions = 64) {
  const vector = Array.from({ length: dimensions }, () => 0);
  semanticTokens(value).forEach((token) => {
    const digest = crypto.createHash("sha256").update(token).digest();
    const index = digest.readUInt16BE(0) % dimensions;
    vector[index] += digest[2] % 2 === 0 ? 1 : -1;
  });
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return vector.map((item) => magnitude ? Math.round((item / magnitude) * 1000000) / 1000000 : 0);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  return left.reduce((sum, item, index) => sum + Number(item || 0) * Number(right[index] || 0), 0);
}

function normalizeMessage(input = {}) {
  const now = Date.now();
  return {
    id: String(input.id || `classification-message-${crypto.randomUUID()}`),
    resultId: String(input.resultId || ""),
    questionId: String(input.questionId || ""),
    bookId: String(input.bookId || ""),
    agent: messageAgents.has(input.agent) ? input.agent : "agent2",
    role: messageRoles.has(input.role) ? input.role : "reviewer",
    message: cleanText(input.message, 4000),
    ruleDraftId: String(input.ruleDraftId || ""),
    createdBy: cleanText(input.createdBy, 100),
    createdAt: Number(input.createdAt) || now,
  };
}

function ruleSnapshot(rule = {}) {
  return {
    version: Math.max(1, Number(rule.version) || 1),
    title: cleanText(rule.title, 120),
    statement: cleanText(rule.statement, 4000),
    scopeNodeIds: uniqueStrings(rule.scopeNodeIds, 30),
    scopePath: cleanText(rule.scopePath, 500),
    questionTypes: uniqueStrings(rule.questionTypes, 20),
    triggerTerms: uniqueStrings(rule.triggerTerms, 30),
    positiveExamples: uniqueStrings(rule.positiveExamples, 20),
    negativeExamples: uniqueStrings(rule.negativeExamples, 20),
    priority: rulePriorities.has(rule.priority) ? rule.priority : "medium",
    status: ruleStatuses.has(rule.status) ? rule.status : "draft",
    changedBy: cleanText(rule.changedBy || rule.updatedBy, 100),
    changedAt: Number(rule.changedAt || rule.updatedAt) || Date.now(),
  };
}

function normalizeRule(input = {}) {
  const now = Date.now();
  const status = ruleStatuses.has(input.status) ? input.status : "draft";
  return {
    id: String(input.id || `classification-rule-${crypto.randomUUID()}`),
    bookId: String(input.bookId || ""),
    title: cleanText(input.title, 120),
    statement: cleanText(input.statement || input.rule, 4000),
    scopeNodeIds: uniqueStrings(input.scopeNodeIds, 30),
    scopePath: cleanText(input.scopePath, 500),
    questionTypes: uniqueStrings(input.questionTypes, 20),
    triggerTerms: uniqueStrings(input.triggerTerms, 30),
    positiveExamples: uniqueStrings(input.positiveExamples, 20),
    negativeExamples: uniqueStrings(input.negativeExamples, 20),
    priority: rulePriorities.has(input.priority) ? input.priority : "medium",
    status,
    version: Math.max(1, Number(input.version) || 1),
    sourceResultId: String(input.sourceResultId || ""),
    sourceQuestionId: String(input.sourceQuestionId || ""),
    sourceFeedbackId: String(input.sourceFeedbackId || ""),
    sourceFeedbackIds: uniqueStrings([
      ...(Array.isArray(input.sourceFeedbackIds) ? input.sourceFeedbackIds : []),
      input.sourceFeedbackId,
    ], 100),
    sourceAgent: messageAgents.has(input.sourceAgent) ? input.sourceAgent : "agent2",
    createdBy: cleanText(input.createdBy, 100),
    updatedBy: cleanText(input.updatedBy, 100),
    approvedBy: cleanText(input.approvedBy, 100),
    history: (Array.isArray(input.history) ? input.history : []).map(ruleSnapshot).slice(-30),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    approvedAt: input.approvedAt ? Number(input.approvedAt) : null,
  };
}

function normalizeCase(input = {}) {
  const now = Date.now();
  const vectorSource = [
    input.stem,
    input.focusLabel,
    input.knowledgePath,
    input.reason,
    ...(Array.isArray(input.options) ? input.options.map((option) => option?.text || option?.content) : []),
    ...(Array.isArray(input.features?.stemKeywords) ? input.features.stemKeywords : []),
    ...(Array.isArray(input.features?.primaryKnowledgeHints) ? input.features.primaryKnowledgeHints : []),
  ].filter(Boolean).join("\n");
  return {
    id: String(input.id || `classification-case-${crypto.randomUUID()}`),
    bookId: String(input.bookId || ""),
    questionId: String(input.questionId || ""),
    resultId: String(input.resultId || ""),
    questionType: cleanText(input.questionType, 80),
    stem: cleanText(input.stem, 2000),
    options: (Array.isArray(input.options) ? input.options : []).map((option) => ({
      key: cleanText(option && (option.key || option.label), 20),
      text: cleanText(option && (option.text || option.content), 800),
    })).filter((option) => option.text).slice(0, 12),
    primaryNodeId: String(input.primaryNodeId || ""),
    primaryNodeRole: ["core", "scope_anchor"].includes(String(input.primaryNodeRole || ""))
      ? String(input.primaryNodeRole) : "core",
    requiredNodeIds: uniqueStrings(input.requiredNodeIds, 20),
    knowledgePath: cleanText(input.knowledgePath, 500),
    focusKey: cleanText(input.focusKey, 240),
    focusLabel: cleanText(input.focusLabel, 240),
    primaryFamilyId: String(input.primaryFamilyId || ""),
    familyIds: uniqueStrings(input.familyIds, 20),
    action: cleanText(input.action, 100),
    reason: cleanText(input.reason, 2400),
    features: input.features && typeof input.features === "object" && !Array.isArray(input.features) ? clone(input.features) : null,
    vectorTokens: uniqueStrings(input.vectorTokens?.length ? input.vectorTokens : semanticTokens([
      input.stem,
      input.focusLabel,
      input.knowledgePath,
      input.reason,
      ...(Array.isArray(input.options) ? input.options.map((option) => option?.text || option?.content) : []),
    ].filter(Boolean).join("\n")), 300),
    vectorEmbedding: Array.isArray(input.vectorEmbedding) && input.vectorEmbedding.length === 64
      ? input.vectorEmbedding.map((item) => Number(item) || 0)
      : vectorEmbedding(vectorSource),
    referenceWeight: Math.min(3, Math.max(1, Number(input.referenceWeight) || 1)),
    ruleIds: uniqueStrings(input.ruleIds, 30),
    confirmedBy: cleanText(input.confirmedBy, 100),
    status: input.status === "archived" ? "archived" : "confirmed",
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
}

function normalizeCorrection(input = {}) {
  const now = Date.now();
  return {
    id: String(input.id || `classification-correction-${crypto.randomUUID()}`),
    bookId: String(input.bookId || ""),
    questionId: String(input.questionId || ""),
    resultId: String(input.resultId || ""),
    suggestedPrimaryNodeId: String(input.suggestedPrimaryNodeId || ""),
    suggestedRequiredNodeIds: uniqueStrings(input.suggestedRequiredNodeIds, 20),
    finalPrimaryNodeId: String(input.finalPrimaryNodeId || ""),
    finalRequiredNodeIds: uniqueStrings(input.finalRequiredNodeIds, 20),
    reason: cleanText(input.reason, 2000),
    features: input.features && typeof input.features === "object" && !Array.isArray(input.features) ? clone(input.features) : null,
    correctedBy: cleanText(input.correctedBy, 100),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
}

function normalizeRuleException(input = {}) {
  const now = Date.now();
  return {
    id: String(input.id || `classification-rule-exception-${crypto.randomUUID()}`),
    ruleId: String(input.ruleId || ""),
    bookId: String(input.bookId || ""),
    questionId: String(input.questionId || ""),
    resultId: String(input.resultId || ""),
    suggestedPrimaryNodeId: String(input.suggestedPrimaryNodeId || ""),
    finalPrimaryNodeId: String(input.finalPrimaryNodeId || ""),
    reason: cleanText(input.reason, 2000),
    status: input.status === "resolved" ? "resolved" : "open",
    createdBy: cleanText(input.createdBy, 100),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
}

function normalizeReviewEvent(input = {}) {
  const now = Date.now();
  const proposal = input.proposal && typeof input.proposal === "object" && !Array.isArray(input.proposal)
    ? input.proposal : {};
  return {
    id: String(input.id || `classification-review-event-${crypto.randomUUID()}`),
    bookId: String(input.bookId || ""),
    questionId: String(input.questionId || ""),
    resultId: String(input.resultId || ""),
    eventType: reviewEventTypes.has(input.eventType) ? input.eventType : "reviewer_feedback",
    topicKey: cleanText(input.topicKey, 500),
    reason: cleanText(input.reason, 4000),
    suggestedPrimaryNodeId: String(input.suggestedPrimaryNodeId || ""),
    finalPrimaryNodeId: String(input.finalPrimaryNodeId || ""),
    sourceFeedbackIds: uniqueStrings(input.sourceFeedbackIds, 100),
    evidenceChunkIds: uniqueStrings(input.evidenceChunkIds, 50),
    proposal: {
      type: proposal.type === "dossier" ? "dossier" : (proposal.type === "rule" ? "rule" : "none"),
      title: cleanText(proposal.title, 160),
      statement: cleanText(proposal.statement, 4000),
      dossierId: String(proposal.dossierId || ""),
      scopeNodeIds: uniqueStrings(proposal.scopeNodeIds, 50),
      scopePath: cleanText(proposal.scopePath, 800),
      triggerTerms: uniqueStrings(proposal.triggerTerms, 50),
      positiveExamples: uniqueStrings(proposal.positiveExamples, 50),
      negativeExamples: uniqueStrings(proposal.negativeExamples, 50),
      priority: rulePriorities.has(proposal.priority) ? proposal.priority : "medium",
      patch: proposal.patch && typeof proposal.patch === "object" && !Array.isArray(proposal.patch) ? clone(proposal.patch) : null,
    },
    promotedRuleId: String(input.promotedRuleId || ""),
    promotedDossierSuggestionId: String(input.promotedDossierSuggestionId || ""),
    recordedBy: cleanText(input.recordedBy, 100),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
}

function normalizeDossierSuggestion(input = {}) {
  const now = Date.now();
  return {
    id: String(input.id || `classification-dossier-suggestion-${crypto.randomUUID()}`),
    bookId: String(input.bookId || ""),
    topicKey: cleanText(input.topicKey, 500),
    dossierId: String(input.dossierId || ""),
    title: cleanText(input.title, 160),
    statement: cleanText(input.statement, 4000),
    patch: input.patch && typeof input.patch === "object" && !Array.isArray(input.patch) ? clone(input.patch) : null,
    supportingEventIds: uniqueStrings(input.supportingEventIds, 100),
    supportingQuestionIds: uniqueStrings(input.supportingQuestionIds, 100),
    independentCaseCount: Math.max(0, Number(input.independentCaseCount) || 0),
    status: ["draft", "accepted", "rejected"].includes(input.status) ? input.status : "draft",
    createdBy: cleanText(input.createdBy, 100),
    updatedBy: cleanText(input.updatedBy, 100),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
}

function normalizeState(value) {
  return {
    messages: (Array.isArray(value && value.messages) ? value.messages : []).map(normalizeMessage),
    rules: (Array.isArray(value && value.rules) ? value.rules : []).map(normalizeRule),
    cases: (Array.isArray(value && value.cases) ? value.cases : []).map(normalizeCase),
    corrections: (Array.isArray(value && value.corrections) ? value.corrections : []).map(normalizeCorrection),
    ruleExceptions: (Array.isArray(value && value.ruleExceptions) ? value.ruleExceptions : []).map(normalizeRuleException),
    reviewEvents: (Array.isArray(value && value.reviewEvents) ? value.reviewEvents : []).map(normalizeReviewEvent),
    dossierSuggestions: (Array.isArray(value && value.dossierSuggestions) ? value.dossierSuggestions : []).map(normalizeDossierSuggestion),
  };
}

function createKnowledgeClassificationExperienceStore(adapter) {
  const read = () => normalizeState(adapter.read());
  const write = (state) => {
    const normalized = normalizeState(state);
    return adapter.write({
      messages: normalized.messages.slice(0, MAX_MESSAGES),
      rules: normalized.rules.slice(0, MAX_RULES),
      cases: normalized.cases.slice(0, MAX_CASES),
      corrections: normalized.corrections.slice(0, MAX_CORRECTIONS),
      ruleExceptions: normalized.ruleExceptions.slice(0, MAX_RULE_EXCEPTIONS),
      reviewEvents: normalized.reviewEvents.slice(0, MAX_REVIEW_EVENTS),
      dossierSuggestions: normalized.dossierSuggestions.slice(0, MAX_DOSSIER_SUGGESTIONS),
    });
  };
  return {
    exportState: () => clone(read()),
    replaceState: (state) => { write(state); return clone(read()); },
    addMessage(input = {}) {
      const state = read();
      const message = normalizeMessage(input);
      if (!message.resultId || !message.questionId || !message.bookId || !message.message) {
        throw new Error("knowledge_classification_feedback_required");
      }
      state.messages = [message, ...state.messages.filter((item) => item.id !== message.id)];
      write(state);
      return clone(message);
    },
    messages(filters = {}) {
      const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
      return read().messages.filter((message) => {
        if (filters.resultId && message.resultId !== filters.resultId) return false;
        if (filters.questionId && message.questionId !== filters.questionId) return false;
        if (filters.bookId && filters.bookId !== "all" && message.bookId !== filters.bookId) return false;
        if (filters.agent && filters.agent !== "all" && message.agent !== filters.agent) return false;
        return true;
      }).sort((left, right) => left.createdAt - right.createdAt).slice(-limit).map(clone);
    },
    createRule(input = {}) {
      const state = read();
      const rule = normalizeRule(input);
      if (!rule.bookId || !rule.title || !rule.statement) throw new Error("knowledge_classification_rule_required");
      state.rules = [rule, ...state.rules.filter((item) => item.id !== rule.id)];
      write(state);
      return clone(rule);
    },
    upsertDraftRule(input = {}, actor = "") {
      const state = read();
      const mergeMode = input.mergeMode === "replace" ? "replace" : "append";
      const proposed = normalizeRule({ ...input, status: "draft" });
      if (!proposed.bookId || !proposed.title || !proposed.statement) throw new Error("knowledge_classification_rule_required");
      const proposedScope = new Set(proposed.scopeNodeIds);
      const candidates = state.rules.filter((rule) => rule.status === "draft"
        && rule.bookId === proposed.bookId
        && rule.sourceAgent === proposed.sourceAgent
        && (!proposed.sourceQuestionId || rule.sourceQuestionId === proposed.sourceQuestionId));
      const current = candidates.find((rule) => {
        if (rule.sourceQuestionId && rule.sourceQuestionId === proposed.sourceQuestionId) return true;
        const scopeOverlap = !proposedScope.size || !rule.scopeNodeIds.length || rule.scopeNodeIds.some((id) => proposedScope.has(id));
        if (!scopeOverlap) return false;
        return semanticSimilarity(`${rule.title}\n${rule.statement}`, `${proposed.title}\n${proposed.statement}`) >= 0.45;
      });
      if (!current) {
        state.rules = [proposed, ...state.rules.filter((item) => item.id !== proposed.id)];
        write(state);
        return { rule: clone(proposed), action: "created" };
      }
      const now = Date.now();
      const appendStatement = proposed.statement && !current.statement.includes(proposed.statement)
        && semanticSimilarity(current.statement, proposed.statement) < 0.9;
      const next = normalizeRule({
        ...current,
        title: mergeMode === "replace" ? proposed.title : (current.title || proposed.title),
        statement: mergeMode === "replace"
          ? proposed.statement
          : (appendStatement ? `${current.statement}\n补充：${proposed.statement}` : current.statement),
        scopeNodeIds: mergeMode === "replace" ? proposed.scopeNodeIds : [...current.scopeNodeIds, ...proposed.scopeNodeIds],
        scopePath: mergeMode === "replace" ? proposed.scopePath : (current.scopePath || proposed.scopePath),
        questionTypes: mergeMode === "replace" ? proposed.questionTypes : [...current.questionTypes, ...proposed.questionTypes],
        triggerTerms: mergeMode === "replace" ? proposed.triggerTerms : [...current.triggerTerms, ...proposed.triggerTerms],
        positiveExamples: mergeMode === "replace" ? proposed.positiveExamples : [...current.positiveExamples, ...proposed.positiveExamples],
        negativeExamples: mergeMode === "replace" ? proposed.negativeExamples : [...current.negativeExamples, ...proposed.negativeExamples],
        priority: mergeMode === "replace" ? proposed.priority : (proposed.priority === "high" ? "high" : current.priority),
        sourceFeedbackId: proposed.sourceFeedbackId || current.sourceFeedbackId,
        sourceFeedbackIds: [...current.sourceFeedbackIds, ...proposed.sourceFeedbackIds],
        version: current.version + 1,
        history: [...current.history, ruleSnapshot({ ...current, changedBy: actor, changedAt: now })],
        updatedBy: actor,
        updatedAt: now,
      });
      state.rules[state.rules.findIndex((rule) => rule.id === current.id)] = next;
      write(state);
      return { rule: clone(next), action: "updated" };
    },
    getRule(id) {
      const rule = read().rules.find((item) => item.id === id);
      return rule ? clone(rule) : null;
    },
    getRules(ids = []) {
      const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
      return read().rules.filter((rule) => wanted.has(rule.id)).map(clone);
    },
    rules(filters = {}) {
      const query = cleanText(filters.query, 200).toLocaleLowerCase("zh-CN");
      const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 300));
      return read().rules.filter((rule) => {
        if (filters.bookId && filters.bookId !== "all" && rule.bookId !== filters.bookId) return false;
        if (filters.status && filters.status !== "all" && rule.status !== filters.status) return false;
        if (query && ![rule.title, rule.statement, rule.scopePath, ...rule.triggerTerms]
          .join(" ").toLocaleLowerCase("zh-CN").includes(query)) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit).map(clone);
    },
    updateRule(id, patch = {}, actor = "") {
      const state = read();
      const index = state.rules.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("knowledge_classification_rule_not_found");
      const current = state.rules[index];
      const now = Date.now();
      const nextStatus = ruleStatuses.has(patch.status) ? patch.status : current.status;
      const editable = {
        title: patch.title === undefined ? current.title : patch.title,
        statement: patch.statement === undefined ? current.statement : patch.statement,
        scopeNodeIds: patch.scopeNodeIds === undefined ? current.scopeNodeIds : patch.scopeNodeIds,
        scopePath: patch.scopePath === undefined ? current.scopePath : patch.scopePath,
        questionTypes: patch.questionTypes === undefined ? current.questionTypes : patch.questionTypes,
        triggerTerms: patch.triggerTerms === undefined ? current.triggerTerms : patch.triggerTerms,
        positiveExamples: patch.positiveExamples === undefined ? current.positiveExamples : patch.positiveExamples,
        negativeExamples: patch.negativeExamples === undefined ? current.negativeExamples : patch.negativeExamples,
        priority: patch.priority === undefined ? current.priority : patch.priority,
        status: nextStatus,
      };
      const next = normalizeRule({
        ...current,
        ...editable,
        id,
        version: current.version + 1,
        history: [...current.history, ruleSnapshot({ ...current, changedBy: actor, changedAt: now })],
        updatedBy: actor,
        updatedAt: now,
        approvedBy: nextStatus === "active" ? (actor || current.approvedBy) : current.approvedBy,
        approvedAt: nextStatus === "active" ? now : current.approvedAt,
      });
      if (!next.title || !next.statement) throw new Error("knowledge_classification_rule_required");
      state.rules[index] = next;
      write(state);
      return clone(next);
    },
    deleteRule(id) {
      const state = read();
      const rule = state.rules.find((item) => item.id === id);
      if (!rule) throw new Error("knowledge_classification_rule_not_found");
      state.rules = state.rules.filter((item) => item.id !== id);
      state.messages = state.messages.map((message) => message.ruleDraftId === id ? { ...message, ruleDraftId: "" } : message);
      write(state);
      return clone(rule);
    },
    addCase(input = {}) {
      const state = read();
      const previous = state.cases.find((item) => item.questionId === String(input.questionId || "") && item.status === "confirmed");
      const item = normalizeCase({ ...input, id: previous?.id || input.id, createdAt: previous?.createdAt || input.createdAt });
      if (!item.bookId || !item.questionId || !item.primaryNodeId) throw new Error("knowledge_classification_case_required");
      state.cases = [item, ...state.cases.filter((entry) => entry.id !== item.id)];
      write(state);
      return clone(item);
    },
    cases(filters = {}) {
      const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
      return read().cases.filter((item) => {
        if (filters.bookId && filters.bookId !== "all" && item.bookId !== filters.bookId) return false;
        if (filters.questionId && item.questionId !== filters.questionId) return false;
        if (filters.status && filters.status !== "all" && item.status !== filters.status) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit).map(clone);
    },
    addCorrection(input = {}) {
      const state = read();
      const correction = normalizeCorrection(input);
      if (!correction.bookId || !correction.questionId || !correction.finalPrimaryNodeId || !correction.reason) {
        throw new Error("knowledge_classification_correction_required");
      }
      const previous = state.corrections.find((item) => item.resultId === correction.resultId && item.questionId === correction.questionId);
      const next = normalizeCorrection({ ...correction, id: previous?.id || correction.id, createdAt: previous?.createdAt || correction.createdAt });
      state.corrections = [next, ...state.corrections.filter((item) => item.id !== next.id)];
      write(state);
      return clone(next);
    },
    corrections(filters = {}) {
      const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
      return read().corrections.filter((item) => {
        if (filters.bookId && filters.bookId !== "all" && item.bookId !== filters.bookId) return false;
        if (filters.questionId && item.questionId !== filters.questionId) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit).map(clone);
    },
    addRuleException(input = {}) {
      const state = read();
      const item = normalizeRuleException(input);
      if (!item.ruleId || !item.bookId || !item.questionId || !item.reason) throw new Error("knowledge_classification_rule_exception_required");
      const previous = state.ruleExceptions.find((entry) => entry.ruleId === item.ruleId && entry.questionId === item.questionId && entry.status === "open");
      const next = normalizeRuleException({ ...item, id: previous?.id || item.id, createdAt: previous?.createdAt || item.createdAt });
      state.ruleExceptions = [next, ...state.ruleExceptions.filter((entry) => entry.id !== next.id)];
      write(state);
      return clone(next);
    },
    ruleExceptions(filters = {}) {
      const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
      return read().ruleExceptions.filter((item) => {
        if (filters.ruleId && item.ruleId !== filters.ruleId) return false;
        if (filters.bookId && filters.bookId !== "all" && item.bookId !== filters.bookId) return false;
        if (filters.status && filters.status !== "all" && item.status !== filters.status) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit).map(clone);
    },
    reviewEvents(filters = {}) {
      const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 200));
      return read().reviewEvents.filter((item) => {
        if (filters.bookId && filters.bookId !== "all" && item.bookId !== filters.bookId) return false;
        if (filters.questionId && item.questionId !== filters.questionId) return false;
        if (filters.resultId && item.resultId !== filters.resultId) return false;
        if (filters.topicKey && item.topicKey !== filters.topicKey) return false;
        if (filters.eventType && filters.eventType !== "all" && item.eventType !== filters.eventType) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit).map(clone);
    },
    dossierSuggestions(filters = {}) {
      const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
      return read().dossierSuggestions.filter((item) => {
        if (filters.bookId && filters.bookId !== "all" && item.bookId !== filters.bookId) return false;
        if (filters.dossierId && item.dossierId !== filters.dossierId) return false;
        if (filters.status && filters.status !== "all" && item.status !== filters.status) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit).map(clone);
    },
    recordReviewEvent(input = {}, actor = "") {
      let state = read();
      const event = normalizeReviewEvent({ ...input, recordedBy: actor || input.recordedBy });
      if (!event.bookId || !event.questionId || !event.topicKey || !event.reason) {
        throw new Error("knowledge_classification_review_event_required");
      }
      const previous = state.reviewEvents.find((item) => item.bookId === event.bookId
        && item.topicKey === event.topicKey && item.questionId === event.questionId);
      const now = Date.now();
      const next = normalizeReviewEvent({
        ...(previous || {}),
        ...event,
        id: previous?.id || event.id,
        reason: previous && previous.reason !== event.reason && !previous.reason.includes(event.reason)
          ? `${previous.reason}\n补充：${event.reason}` : event.reason,
        sourceFeedbackIds: [...(previous?.sourceFeedbackIds || []), ...event.sourceFeedbackIds],
        evidenceChunkIds: [...(previous?.evidenceChunkIds || []), ...event.evidenceChunkIds],
        proposal: event.proposal.type !== "none" ? event.proposal : previous?.proposal,
        createdAt: previous?.createdAt || event.createdAt,
        updatedAt: now,
      });
      state.reviewEvents = [next, ...state.reviewEvents.filter((item) => item.id !== next.id)];
      write(state);

      const supportingEvents = state.reviewEvents.filter((item) => item.bookId === next.bookId && item.topicKey === next.topicKey);
      const supportingQuestionIds = [...new Set(supportingEvents.map((item) => item.questionId).filter(Boolean))];
      const independentCaseCount = supportingQuestionIds.length;
      if (independentCaseCount < 3 || next.proposal.type === "none") {
        return { event: clone(next), independentCaseCount, thresholdReached: false, rule: null, ruleAction: "none", dossierSuggestion: null };
      }

      let rule = null;
      let ruleAction = "none";
      let dossierSuggestion = null;
      if (next.proposal.type === "rule") {
        const promoted = this.upsertDraftRule({
          bookId: next.bookId,
          title: next.proposal.title,
          statement: next.proposal.statement,
          scopeNodeIds: next.proposal.scopeNodeIds,
          scopePath: next.proposal.scopePath,
          triggerTerms: next.proposal.triggerTerms,
          positiveExamples: [...next.proposal.positiveExamples, ...supportingQuestionIds],
          negativeExamples: next.proposal.negativeExamples,
          priority: next.proposal.priority,
          sourceFeedbackIds: supportingEvents.flatMap((item) => item.sourceFeedbackIds),
          sourceAgent: "agent4",
          createdBy: actor,
          updatedBy: actor,
        }, actor);
        rule = promoted.rule;
        ruleAction = promoted.action;
        state = read();
        state.reviewEvents = state.reviewEvents.map((item) => item.bookId === next.bookId && item.topicKey === next.topicKey
          ? normalizeReviewEvent({ ...item, promotedRuleId: rule.id, updatedAt: now }) : item);
        write(state);
      } else {
        state = read();
        const current = state.dossierSuggestions.find((item) => item.bookId === next.bookId
          && item.topicKey === next.topicKey && item.status === "draft");
        dossierSuggestion = normalizeDossierSuggestion({
          ...(current || {}),
          bookId: next.bookId,
          topicKey: next.topicKey,
          dossierId: next.proposal.dossierId,
          title: next.proposal.title,
          statement: next.proposal.statement,
          patch: next.proposal.patch,
          supportingEventIds: supportingEvents.map((item) => item.id),
          supportingQuestionIds,
          independentCaseCount,
          createdBy: current?.createdBy || actor,
          updatedBy: actor,
          updatedAt: now,
        });
        state.dossierSuggestions = [dossierSuggestion, ...state.dossierSuggestions.filter((item) => item.id !== dossierSuggestion.id)];
        state.reviewEvents = state.reviewEvents.map((item) => item.bookId === next.bookId && item.topicKey === next.topicKey
          ? normalizeReviewEvent({ ...item, promotedDossierSuggestionId: dossierSuggestion.id, updatedAt: now }) : item);
        write(state);
      }
      return { event: clone(next), independentCaseCount, thresholdReached: true, rule: clone(rule), ruleAction, dossierSuggestion: clone(dossierSuggestion) };
    },
    context(filters = {}) {
      const nodeIds = new Set(uniqueStrings(filters.nodeIds, 100));
      const text = cleanText(filters.text, 12000).normalize("NFKC").toLocaleLowerCase("zh-CN");
      const questionType = String(filters.questionType || "");
      const limitRules = Math.min(20, Math.max(1, Number(filters.limitRules) || 8));
      const limitCases = Math.min(10, Math.max(1, Number(filters.limitCases) || 3));
      const priorityScore = { high: 3, medium: 2, low: 1 };
      const scoredRules = read().rules.flatMap((rule) => {
        if (rule.status !== "active" || (filters.bookId && rule.bookId !== filters.bookId)) return [];
        if (rule.questionTypes.length && !rule.questionTypes.includes(questionType)) return [];
        const nodeMatches = rule.scopeNodeIds.filter((id) => nodeIds.has(id)).length;
        if (rule.scopeNodeIds.length && !nodeMatches) return [];
        const termMatches = rule.triggerTerms.filter((term) => text.includes(term.normalize("NFKC").toLocaleLowerCase("zh-CN"))).length;
        const score = nodeMatches * 5 + termMatches * 3 + (rule.questionTypes.length ? 2 : 0) + priorityScore[rule.priority];
        return [{ rule, score }];
      }).sort((left, right) => right.score - left.score || right.rule.updatedAt - left.rule.updatedAt);
      const rules = scoredRules.slice(0, limitRules).map((item) => clone(item.rule));
      const ruleIds = new Set(rules.map((rule) => rule.id));
      const queryTokens = new Set(semanticTokens(text));
      const queryEmbedding = vectorEmbedding(text);
      const correctedQuestionIds = new Set(read().corrections.map((item) => item.questionId));
      const cases = read().cases.flatMap((item) => {
        if (item.status !== "confirmed" || (filters.bookId && item.bookId !== filters.bookId)) return [];
        if (questionType && item.questionType && item.questionType !== questionType) return [];
        const vectorMatches = item.vectorTokens.filter((token) => queryTokens.has(token)).length;
        const tokenScore = vectorMatches / Math.max(1, Math.min(item.vectorTokens.length, queryTokens.size));
        const cosineScore = Math.max(0, cosineSimilarity(queryEmbedding, item.vectorEmbedding));
        const vectorScore = Math.max(tokenScore, cosineScore);
        const relationScore = item.ruleIds.some((id) => ruleIds.has(id)) ? 4
          : (item.requiredNodeIds.some((id) => nodeIds.has(id)) || nodeIds.has(item.primaryNodeId) ? 3 : 0);
        if (!relationScore && vectorScore < 0.12) return [];
        const correctionWeight = correctedQuestionIds.has(item.questionId) ? 2 : item.referenceWeight;
        return [{ item, score: relationScore + vectorScore * 5 + correctionWeight }];
      }).sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
        .slice(0, limitCases).map(({ item }) => clone(item));
      return { rules, cases };
    },
    summary(filters = {}) {
      const state = read();
      const rules = state.rules.filter((rule) => !filters.bookId || filters.bookId === "all" || rule.bookId === filters.bookId);
      const cases = state.cases.filter((item) => !filters.bookId || filters.bookId === "all" || item.bookId === filters.bookId);
      const messages = state.messages.filter((item) => !filters.bookId || filters.bookId === "all" || item.bookId === filters.bookId);
      return {
        rules: rules.length,
        draft: rules.filter((rule) => rule.status === "draft").length,
        active: rules.filter((rule) => rule.status === "active").length,
        inactive: rules.filter((rule) => rule.status === "inactive").length,
        cases: cases.filter((item) => item.status === "confirmed").length,
        messages: messages.length,
        corrections: state.corrections.filter((item) => !filters.bookId || filters.bookId === "all" || item.bookId === filters.bookId).length,
        openExceptions: state.ruleExceptions.filter((item) => item.status === "open" && (!filters.bookId || filters.bookId === "all" || item.bookId === filters.bookId)).length,
        reviewEvents: state.reviewEvents.filter((item) => !filters.bookId || filters.bookId === "all" || item.bookId === filters.bookId).length,
        dossierSuggestions: state.dossierSuggestions.filter((item) => item.status === "draft"
          && (!filters.bookId || filters.bookId === "all" || item.bookId === filters.bookId)).length,
      };
    },
  };
}

function createFileKnowledgeClassificationExperienceStore(filePath = path.resolve(__dirname, "../../../.runtime/knowledge-classification-experience.json")) {
  return createKnowledgeClassificationExperienceStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { messages: [], rules: [], cases: [], corrections: [], ruleExceptions: [], reviewEvents: [], dossierSuggestions: [] }; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryKnowledgeClassificationExperienceStore(initialState = { messages: [], rules: [], cases: [], corrections: [], ruleExceptions: [], reviewEvents: [], dossierSuggestions: [] }) {
  let state = clone(initialState);
  return createKnowledgeClassificationExperienceStore({ read: () => clone(state), write: (next) => { state = clone(next); } });
}

module.exports = {
  createFileKnowledgeClassificationExperienceStore,
  createMemoryKnowledgeClassificationExperienceStore,
  normalizeCase,
  normalizeMessage,
  normalizeRule,
  normalizeCorrection,
  normalizeRuleException,
  normalizeReviewEvent,
  normalizeDossierSuggestion,
};
