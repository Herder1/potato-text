const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STORE_VERSION = 1;
const dossierStatuses = new Set([
  "draft",
  "evidence_verified",
  "boundary_verified",
  "active",
  "needs_review",
  "disputed",
  "archived",
]);
const occurrenceRoles = new Set([
  "defines",
  "overview",
  "elaborates",
  "supplements",
  "example",
  "exception",
  "mentions",
  "contradicts",
]);
const relationTypes = new Set([
  "is_a",
  "part_of",
  "supplements",
  "prerequisite_for",
  "contrasts_with",
  "confusable_with",
]);
const unresolvedRelationTypes = new Set([
  "same_concept_candidate",
  "uncertain",
]);
const relationTypeAliases = new Map([
  ["broader", "is_a"],
  ["narrower", "is_a"],
  ["prerequisite", "prerequisite_for"],
  ["contrasts", "contrasts_with"],
  ["confusable", "confusable_with"],
]);
const reviewItemTypes = new Set(["definition", "inclusion", "exclusion", "claim", "relation"]);
const reviewStatuses = new Set(["pending_review", "approved", "rejected", "insufficient_evidence"]);
const deltaTypes = new Set([
  "alias",
  "boundary",
  "relation",
  "evidence",
  "exception",
  "conflict",
  "new_concept",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, limit = 10000) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, limit);
}

function uniqueStrings(values, limit = 200) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => cleanText(value, 500)).filter(Boolean))].slice(0, limit);
}

function stableBoundaryId(kind, text) {
  const digest = crypto.createHash("sha256").update(`${kind}\u0000${cleanText(text, 6000)}`).digest("hex").slice(0, 20);
  return `dossier-boundary-${kind}-${digest}`;
}

function normalizeBoundaryItem(input = {}, fallbackKind = "inclusion") {
  const kind = ["inclusion", "exclusion"].includes(input.kind) ? input.kind : fallbackKind;
  const text = cleanText(input.text ?? input.statement, 6000);
  return {
    id: String(input.id || stableBoundaryId(kind, text)),
    kind,
    text,
  };
}

function sameStrings(left = [], right = []) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeBoundaryItems(input = {}, existing = null) {
  const inclusionCriteria = uniqueStrings(input.inclusionCriteria ?? existing?.inclusionCriteria, 100);
  const exclusionCriteria = uniqueStrings(input.exclusionCriteria ?? existing?.exclusionCriteria, 100);
  const suppliedItems = Array.isArray(input.boundaryItems)
    ? input.boundaryItems.map((item) => normalizeBoundaryItem(item)).filter((item) => item.text)
    : [];
  const suppliedInclusions = suppliedItems.filter((item) => item.kind === "inclusion").map((item) => item.text);
  const suppliedExclusions = suppliedItems.filter((item) => item.kind === "exclusion").map((item) => item.text);
  const criteriaWereSupplied = Object.prototype.hasOwnProperty.call(input, "inclusionCriteria")
    || Object.prototype.hasOwnProperty.call(input, "exclusionCriteria");
  if (suppliedItems.length && (!criteriaWereSupplied
    || (sameStrings(suppliedInclusions, inclusionCriteria) && sameStrings(suppliedExclusions, exclusionCriteria)))) {
    return suppliedItems;
  }
  const existingItems = Array.isArray(existing?.boundaryItems)
    ? existing.boundaryItems.map((item) => normalizeBoundaryItem(item)).filter((item) => item.text)
    : suppliedItems;
  const existingByKey = new Map(existingItems.map((item) => [`${item.kind}\u0000${item.text}`, item]));
  return [
    ...inclusionCriteria.map((text) => existingByKey.get(`inclusion\u0000${text}`) || normalizeBoundaryItem({ kind: "inclusion", text })),
    ...exclusionCriteria.map((text) => existingByKey.get(`exclusion\u0000${text}`) || normalizeBoundaryItem({ kind: "exclusion", text })),
  ];
}

function normalizeEvidence(input = {}) {
  return {
    chunkId: cleanText(input.chunkId, 200),
    pdfPage: Math.max(0, Number(input.pdfPage) || 0),
    printedPage: Math.max(0, Number(input.printedPage ?? input.page) || 0),
    excerpt: cleanText(input.excerpt, 3000),
  };
}

function normalizeClaim(input = {}) {
  return {
    id: String(input.id || `dossier-claim-${crypto.randomUUID()}`),
    statement: cleanText(input.statement, 4000),
    evidence: (Array.isArray(input.evidence) ? input.evidence : []).map(normalizeEvidence)
      .filter((item) => item.chunkId || item.excerpt),
  };
}

function normalizeOccurrence(input = {}) {
  return {
    nodeId: cleanText(input.nodeId, 200),
    path: cleanText(input.path, 1000),
    role: occurrenceRoles.has(input.role) ? input.role : "mentions",
    chunkIds: uniqueStrings(input.chunkIds, 100),
    pdfPageStart: Math.max(0, Number(input.pdfPageStart) || 0),
    pdfPageEnd: Math.max(0, Number(input.pdfPageEnd) || Number(input.pdfPageStart) || 0),
    printedPageStart: Math.max(0, Number(input.printedPageStart ?? input.startPage) || 0),
    printedPageEnd: Math.max(0, Number(input.printedPageEnd ?? input.endPage) || Number(input.printedPageStart ?? input.startPage) || 0),
    excerpt: cleanText(input.excerpt, 3000),
  };
}

function normalizeRelation(input = {}) {
  const originalType = cleanText(input.type, 100);
  const type = relationTypeAliases.get(originalType) || originalType;
  let direction = ["outgoing", "incoming", "bidirectional"].includes(input.direction) ? input.direction : "outgoing";
  if (originalType === "broader") direction = "outgoing";
  if (originalType === "narrower") direction = "incoming";
  if (["contrasts_with", "confusable_with"].includes(type)) direction = "bidirectional";
  return {
    id: String(input.id || `dossier-relation-${crypto.randomUUID()}`),
    type: relationTypes.has(type) || unresolvedRelationTypes.has(type) ? type : "uncertain",
    targetDossierId: cleanText(input.targetDossierId, 200),
    targetName: cleanText(input.targetName, 300),
    direction,
    reason: cleanText(input.reason, 2000),
    evidenceChunkIds: uniqueStrings(input.evidenceChunkIds, 100),
    status: input.status === "confirmed" ? "confirmed" : "pending_review",
  };
}

function reviewItemContentHash(item) {
  return crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex");
}

function reviewableItems(dossier = {}) {
  const items = [{
    itemType: "definition",
    itemId: "definition",
    contentHash: reviewItemContentHash({ definition: dossier.definition || "" }),
    evidenceChunkIds: [],
  }];
  (Array.isArray(dossier.boundaryItems) ? dossier.boundaryItems : []).forEach((item) => {
    items.push({
      itemType: item.kind,
      itemId: item.id,
      contentHash: reviewItemContentHash({ kind: item.kind, text: item.text }),
      evidenceChunkIds: [],
    });
  });
  (Array.isArray(dossier.claims) ? dossier.claims : []).forEach((claim) => {
    items.push({
      itemType: "claim",
      itemId: claim.id,
      contentHash: reviewItemContentHash({ statement: claim.statement, evidence: claim.evidence }),
      evidenceChunkIds: uniqueStrings(claim.evidence.map((item) => item.chunkId), 100),
    });
  });
  (Array.isArray(dossier.relations) ? dossier.relations : []).forEach((relation) => {
    items.push({
      itemType: "relation",
      itemId: relation.id,
      contentHash: reviewItemContentHash({
        type: relation.type,
        targetDossierId: relation.targetDossierId,
        targetName: relation.targetName,
        direction: relation.direction,
        reason: relation.reason,
        evidenceChunkIds: relation.evidenceChunkIds,
      }),
      evidenceChunkIds: relation.evidenceChunkIds,
    });
  });
  return items;
}

function normalizeReviewDecisions(input = [], dossier = {}) {
  const supplied = new Map((Array.isArray(input) ? input : []).map((item) => [
    `${cleanText(item?.itemType, 50)}:${cleanText(item?.itemId, 200)}`,
    item,
  ]));
  return reviewableItems(dossier).map((item) => {
    const source = supplied.get(`${item.itemType}:${item.itemId}`) || {};
    const contentChanged = Boolean(source.contentHash) && source.contentHash !== item.contentHash;
    const status = contentChanged || !reviewStatuses.has(source.status) ? "pending_review" : source.status;
    return {
      itemType: reviewItemTypes.has(item.itemType) ? item.itemType : "claim",
      itemId: item.itemId,
      status,
      note: contentChanged ? "" : cleanText(source.note, 2000),
      evidenceChunkIds: contentChanged
        ? item.evidenceChunkIds
        : uniqueStrings(source.evidenceChunkIds ?? item.evidenceChunkIds, 100),
      contentHash: item.contentHash,
      reviewedBy: status === "pending_review" ? "" : cleanText(source.reviewedBy, 100),
      reviewedAt: status === "pending_review" ? 0 : Number(source.reviewedAt) || 0,
    };
  });
}

function normalizeVerification(input = {}) {
  return {
    evidenceCoverage: Math.min(1, Math.max(0, Number(input.evidenceCoverage) || 0)),
    claimsVerified: input.claimsVerified === true,
    boundaryComplete: input.boundaryComplete === true,
    sourceRolesClear: input.sourceRolesClear === true,
    relationCyclesValid: input.relationCyclesValid !== false,
    conflicts: uniqueStrings(input.conflicts, 100),
    warnings: uniqueStrings(input.warnings, 100),
    verifierNotes: cleanText(input.verifierNotes, 5000),
    claimChecks: (Array.isArray(input.claimChecks) ? input.claimChecks : []).map((item) => ({
      claimId: cleanText(item?.claimId, 200),
      supported: item?.supported === true,
      issue: cleanText(item?.issue, 2000),
      evidenceChunkIds: uniqueStrings(item?.evidenceChunkIds, 100),
    })).filter((item) => item.claimId),
    verifiedAt: Number(input.verifiedAt) || 0,
    verifiedBy: cleanText(input.verifiedBy, 100),
  };
}

function normalizeDossier(input = {}, existing = null) {
  const now = Date.now();
  const boundaryItems = normalizeBoundaryItems(input, existing);
  const normalized = {
    id: String(input.id || existing?.id || `knowledge-dossier-${crypto.randomUUID()}`),
    bookId: cleanText(input.bookId ?? existing?.bookId, 200),
    canonicalName: cleanText(input.canonicalName ?? existing?.canonicalName, 300),
    aliases: uniqueStrings(input.aliases ?? existing?.aliases, 100),
    definition: cleanText(input.definition ?? existing?.definition, 6000),
    boundaryItems,
    inclusionCriteria: boundaryItems.filter((item) => item.kind === "inclusion").map((item) => item.text),
    exclusionCriteria: boundaryItems.filter((item) => item.kind === "exclusion").map((item) => item.text),
    claims: (Array.isArray(input.claims) ? input.claims : (existing?.claims || [])).map(normalizeClaim)
      .filter((item) => item.statement),
    occurrences: (Array.isArray(input.occurrences) ? input.occurrences : (existing?.occurrences || [])).map(normalizeOccurrence)
      .filter((item) => item.nodeId || item.chunkIds.length || item.excerpt),
    relations: (Array.isArray(input.relations) ? input.relations : (existing?.relations || [])).map(normalizeRelation)
      .filter((item) => item.targetDossierId || item.targetName),
    verification: normalizeVerification(input.verification ?? existing?.verification),
    status: dossierStatuses.has(input.status) ? input.status : (existing?.status || "draft"),
    sourceRunId: cleanText(input.sourceRunId ?? existing?.sourceRunId, 200),
    version: Math.max(1, Number(input.version) || Number(existing?.version) || 1),
    reviewedBy: cleanText(input.reviewedBy ?? existing?.reviewedBy, 100),
    reviewedAt: Number(input.reviewedAt) || Number(existing?.reviewedAt) || 0,
    createdAt: Number(input.createdAt) || Number(existing?.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
  normalized.reviewDecisions = normalizeReviewDecisions(input.reviewDecisions ?? existing?.reviewDecisions, normalized);
  const approvedRelationIds = new Set(normalized.reviewDecisions
    .filter((item) => item.itemType === "relation" && item.status === "approved")
    .map((item) => item.itemId));
  normalized.relations = normalized.relations.map((relation) => ({
    ...relation,
    status: approvedRelationIds.has(relation.id) ? "confirmed" : "pending_review",
  }));
  return normalized;
}

function manualReviewProblems(dossier) {
  const decisions = Array.isArray(dossier.reviewDecisions) ? dossier.reviewDecisions : [];
  const requiredItems = reviewableItems(dossier);
  const decisionMap = new Map(decisions.map((item) => [`${item.itemType}:${item.itemId}`, item]));
  const statuses = requiredItems.map((item) => decisionMap.get(`${item.itemType}:${item.itemId}`)?.status || "pending_review");
  const problems = [];
  if (statuses.includes("rejected")) problems.push("manual_review_rejected");
  if (statuses.includes("insufficient_evidence")) problems.push("manual_review_insufficient_evidence");
  if (statuses.some((status) => status !== "approved")) problems.push("manual_review_required");
  const validEvidenceIds = new Set([
    ...(dossier.claims || []).flatMap((claim) => claim.evidence.map((item) => item.chunkId)),
    ...(dossier.occurrences || []).flatMap((item) => item.chunkIds),
  ].filter(Boolean));
  const approvedDecisions = decisions.filter((item) => item.status === "approved");
  if (approvedDecisions.some((item) => !item.evidenceChunkIds.length)) problems.push("manual_review_evidence_required");
  if (approvedDecisions.some((item) => item.evidenceChunkIds.some((id) => !validEvidenceIds.has(id)))) {
    problems.push("manual_review_evidence_invalid");
  }
  return problems;
}

function activationProblems(dossier) {
  const problems = [];
  if (!dossier.canonicalName || !dossier.definition) problems.push("definition_required");
  if (!dossier.inclusionCriteria.length || !dossier.exclusionCriteria.length) problems.push("boundary_required");
  if (!dossier.claims.length || dossier.claims.some((claim) => !claim.evidence.length)) problems.push("claim_evidence_required");
  if (!dossier.occurrences.length || dossier.occurrences.some((item) => !occurrenceRoles.has(item.role))) problems.push("occurrence_role_required");
  if (!dossier.verification.claimsVerified || dossier.verification.evidenceCoverage < 1) problems.push("evidence_verification_required");
  if (!dossier.verification.boundaryComplete || !dossier.verification.sourceRolesClear) problems.push("boundary_verification_required");
  if (!dossier.verification.relationCyclesValid || dossier.verification.conflicts.length) problems.push("unresolved_conflict");
  manualReviewProblems(dossier).forEach((problem) => problems.push(problem));
  relationProblems(dossier).forEach((problem) => problems.push(problem));
  return [...new Set(problems)];
}

function relationProblems(dossier, allDossiers = []) {
  const problems = [];
  const relations = Array.isArray(dossier?.relations) ? dossier.relations : [];
  const knownIds = new Set((Array.isArray(allDossiers) ? allDossiers : []).map((item) => item.id));
  relations.forEach((relation) => {
    if (!relationTypes.has(relation.type)) problems.push("relation_type_unresolved");
    if (["contrasts_with", "confusable_with"].includes(relation.type) && relation.direction !== "bidirectional") {
      problems.push("relation_direction_invalid");
    }
    if (["is_a", "part_of", "prerequisite_for", "supplements"].includes(relation.type)
      && !["outgoing", "incoming"].includes(relation.direction)) problems.push("relation_direction_invalid");
    if (!relation.targetDossierId) {
      problems.push("confirmed_relation_target_required");
      return;
    }
    if (knownIds.size && !knownIds.has(relation.targetDossierId)) problems.push("relation_target_not_found");
    if (relation.targetDossierId === dossier.id) problems.push("relation_self_reference");
  });
  if (knownIds.size) {
    const dossierMap = new Map(allDossiers.map((item) => [item.id, item]));
    dossierMap.set(dossier.id, dossier);
    ["is_a", "part_of", "prerequisite_for"].forEach((type) => {
      const adjacency = new Map();
      dossierMap.forEach((item) => {
        (item.relations || []).filter((relation) => relation.type === type && relation.status === "confirmed" && relation.targetDossierId)
          .forEach((relation) => {
            const from = relation.direction === "incoming" ? relation.targetDossierId : item.id;
            const to = relation.direction === "incoming" ? item.id : relation.targetDossierId;
            if (!adjacency.has(from)) adjacency.set(from, new Set());
            adjacency.get(from).add(to);
          });
      });
      const visiting = new Set();
      const visited = new Set();
      const hasCycle = (nodeId) => {
        if (visiting.has(nodeId)) return true;
        if (visited.has(nodeId)) return false;
        visiting.add(nodeId);
        for (const targetId of adjacency.get(nodeId) || []) if (hasCycle(targetId)) return true;
        visiting.delete(nodeId);
        visited.add(nodeId);
        return false;
      };
      if ([...adjacency.keys()].some(hasCycle)) problems.push("relation_cycle_detected");
    });
  }
  return [...new Set(problems)];
}

function normalizeRun(input = {}, existing = null) {
  const now = Date.now();
  const statuses = new Set(["queued", "compiling", "verifying", "completed", "failed"]);
  return {
    id: String(input.id || existing?.id || `knowledge-dossier-run-${crypto.randomUUID()}`),
    bookId: cleanText(input.bookId ?? existing?.bookId, 200),
    nodeId: cleanText(input.nodeId ?? existing?.nodeId, 200),
    nodePath: cleanText(input.nodePath ?? existing?.nodePath, 1000),
    status: statuses.has(input.status) ? input.status : (existing?.status || "queued"),
    dossierIds: uniqueStrings(input.dossierIds ?? existing?.dossierIds, 500),
    error: cleanText(input.error ?? existing?.error, 1000),
    createdAt: Number(input.createdAt) || Number(existing?.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    completedAt: Number(input.completedAt) || Number(existing?.completedAt) || 0,
  };
}

function normalizeDelta(input = {}, existing = null) {
  const now = Date.now();
  return {
    id: String(input.id || existing?.id || `knowledge-dossier-delta-${crypto.randomUUID()}`),
    bookId: cleanText(input.bookId ?? existing?.bookId, 200),
    dossierId: cleanText(input.dossierId ?? existing?.dossierId, 200),
    questionId: cleanText(input.questionId ?? existing?.questionId, 200),
    resultId: cleanText(input.resultId ?? existing?.resultId, 200),
    type: deltaTypes.has(input.type) ? input.type : (existing?.type || "exception"),
    title: cleanText(input.title ?? existing?.title, 300),
    reason: cleanText(input.reason ?? existing?.reason, 4000),
    suggestedPatch: input.suggestedPatch && typeof input.suggestedPatch === "object" && !Array.isArray(input.suggestedPatch)
      ? clone(input.suggestedPatch)
      : clone(existing?.suggestedPatch || {}),
    evidence: (Array.isArray(input.evidence) ? input.evidence : (existing?.evidence || [])).map(normalizeEvidence),
    sourceAgent: cleanText(input.sourceAgent ?? existing?.sourceAgent, 100) || "Agent 4",
    status: ["pending", "applied", "rejected"].includes(input.status) ? input.status : (existing?.status || "pending"),
    reviewNote: cleanText(input.reviewNote ?? existing?.reviewNote, 2000),
    reviewedBy: cleanText(input.reviewedBy ?? existing?.reviewedBy, 100),
    reviewedAt: Number(input.reviewedAt) || Number(existing?.reviewedAt) || 0,
    createdAt: Number(input.createdAt) || Number(existing?.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
}

function normalizeState(input = {}) {
  return {
    version: STORE_VERSION,
    dossiers: (Array.isArray(input.dossiers) ? input.dossiers : []).map((item) => normalizeDossier(item)),
    deltas: (Array.isArray(input.deltas) ? input.deltas : []).map((item) => normalizeDelta(item)),
    runs: (Array.isArray(input.runs) ? input.runs : []).map((item) => normalizeRun(item)),
  };
}

function createKnowledgeDossierStore(adapter) {
  const read = () => normalizeState(adapter.read());
  const write = (state) => adapter.write(normalizeState(state));
  return {
    exportState: () => clone(read()),
    replaceState: (state) => { write(state); return clone(read()); },
    list(filters = {}) {
      const query = cleanText(filters.query, 300).toLocaleLowerCase("zh-CN");
      const nodeId = cleanText(filters.nodeId, 200);
      return read().dossiers.filter((dossier) => {
        if (filters.bookId && filters.bookId !== "all" && dossier.bookId !== filters.bookId) return false;
        if (filters.status && filters.status !== "all" && dossier.status !== filters.status) return false;
        if (nodeId && !dossier.occurrences.some((item) => item.nodeId === nodeId)) return false;
        if (query && ![dossier.canonicalName, dossier.definition, ...dossier.aliases].join(" ").toLocaleLowerCase("zh-CN").includes(query)) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt).map(clone);
    },
    get(id) {
      const dossier = read().dossiers.find((item) => item.id === id);
      return dossier ? clone(dossier) : null;
    },
    save(input = {}, actor = "") {
      const state = read();
      const index = state.dossiers.findIndex((item) => item.id === String(input.id || ""));
      const existing = index >= 0 ? state.dossiers[index] : null;
      const next = normalizeDossier({
        ...input,
        version: existing ? existing.version + 1 : 1,
        reviewedBy: input.reviewedBy ?? (actor || existing?.reviewedBy),
        reviewedAt: input.reviewedAt ?? (actor ? Date.now() : existing?.reviewedAt),
        updatedAt: Date.now(),
      }, existing);
      if (existing) {
        const changed = (left, right) => JSON.stringify(left) !== JSON.stringify(right);
        const claimsChanged = changed(existing.claims, next.claims);
        const boundariesChanged = changed(
          { definition: existing.definition, boundaries: existing.boundaryItems?.map(({ kind, text }) => ({ kind, text })) },
          { definition: next.definition, boundaries: next.boundaryItems.map(({ kind, text }) => ({ kind, text })) },
        );
        const occurrencesChanged = changed(existing.occurrences, next.occurrences);
        const relationSemantics = (relations = []) => relations.map(({ status, ...relation }) => relation);
        const relationsChanged = changed(relationSemantics(existing.relations), relationSemantics(next.relations));
        if (claimsChanged || boundariesChanged || occurrencesChanged || relationsChanged) {
          next.verification = {
            ...next.verification,
            ...(claimsChanged ? { evidenceCoverage: 0, claimsVerified: false, claimChecks: [] } : {}),
            ...(boundariesChanged ? { boundaryComplete: false } : {}),
            ...(occurrencesChanged ? { sourceRolesClear: false } : {}),
            ...(relationsChanged ? { relationCyclesValid: false } : {}),
            verifiedAt: 0,
            verifiedBy: "",
          };
        }
      }
      if (actor) {
        const existingDecisions = new Map((existing?.reviewDecisions || []).map((item) => [`${item.itemType}:${item.itemId}`, item]));
        next.reviewDecisions = next.reviewDecisions.map((decision) => {
          if (decision.status === "pending_review") return decision;
          const previous = existingDecisions.get(`${decision.itemType}:${decision.itemId}`);
          const unchanged = previous?.status === decision.status
            && previous?.contentHash === decision.contentHash
            && previous?.note === decision.note
            && sameStrings(previous?.evidenceChunkIds || [], decision.evidenceChunkIds || []);
          return unchanged ? { ...decision, reviewedBy: previous.reviewedBy, reviewedAt: previous.reviewedAt } : {
            ...decision,
            reviewedBy: actor,
            reviewedAt: Date.now(),
          };
        });
        const approvedRelationIds = new Set(next.reviewDecisions
          .filter((item) => item.itemType === "relation" && item.status === "approved")
          .map((item) => item.itemId));
        next.relations = next.relations.map((relation) => ({
          ...relation,
          status: approvedRelationIds.has(relation.id) ? "confirmed" : "pending_review",
        }));
      }
      if (!next.bookId || !next.canonicalName) throw new Error("knowledge_dossier_required");
      if (next.status === "active") {
        const problems = [...new Set([...activationProblems(next), ...relationProblems(next, state.dossiers)])];
        if (problems.length) {
          const error = new Error("knowledge_dossier_activation_blocked");
          error.details = { problems };
          throw error;
        }
      }
      if (index >= 0) state.dossiers[index] = next;
      else state.dossiers.unshift(next);
      write(state);
      return clone(next);
    },
    createRun(input = {}) {
      const state = read();
      const run = normalizeRun(input);
      if (!run.bookId || !run.nodeId) throw new Error("knowledge_dossier_scope_required");
      state.runs.unshift(run);
      write(state);
      return clone(run);
    },
    updateRun(id, patch = {}) {
      const state = read();
      const index = state.runs.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("knowledge_dossier_run_not_found");
      state.runs[index] = normalizeRun({ ...state.runs[index], ...patch, id, updatedAt: Date.now() }, state.runs[index]);
      write(state);
      return clone(state.runs[index]);
    },
    recoverInterruptedRuns() {
      const state = read();
      let recovered = 0;
      state.runs = state.runs.map((run) => {
        if (!["compiling", "verifying"].includes(run.status)) return run;
        recovered += 1;
        return normalizeRun({ ...run, status: "failed", error: "server_interrupted", completedAt: Date.now(), updatedAt: Date.now() }, run);
      });
      if (recovered) write(state);
      return recovered;
    },
    runs(filters = {}) {
      return read().runs.filter((run) => !filters.bookId || filters.bookId === "all" || run.bookId === filters.bookId)
        .sort((left, right) => right.createdAt - left.createdAt).slice(0, Math.min(200, Number(filters.limit) || 50)).map(clone);
    },
    createDelta(input = {}) {
      const state = read();
      const proposed = normalizeDelta(input);
      if (!proposed.bookId || !proposed.title || !proposed.reason) throw new Error("knowledge_dossier_delta_required");
      const duplicate = state.deltas.find((item) => item.status === "pending"
        && item.bookId === proposed.bookId
        && item.dossierId === proposed.dossierId
        && item.questionId === proposed.questionId
        && item.type === proposed.type
        && item.title === proposed.title);
      if (duplicate) return clone(duplicate);
      state.deltas.unshift(proposed);
      write(state);
      return clone(proposed);
    },
    deltas(filters = {}) {
      return read().deltas.filter((delta) => {
        if (filters.bookId && filters.bookId !== "all" && delta.bookId !== filters.bookId) return false;
        if (filters.dossierId && delta.dossierId !== filters.dossierId) return false;
        if (filters.status && filters.status !== "all" && delta.status !== filters.status) return false;
        return true;
      }).sort((left, right) => right.createdAt - left.createdAt).map(clone);
    },
    reviewDelta(id, decision, actor = "", reviewNote = "") {
      const state = read();
      const index = state.deltas.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("knowledge_dossier_delta_not_found");
      if (!['applied', 'rejected'].includes(decision)) throw new Error("knowledge_dossier_delta_decision_invalid");
      state.deltas[index] = normalizeDelta({
        ...state.deltas[index],
        status: decision,
        reviewNote,
        reviewedBy: actor,
        reviewedAt: Date.now(),
        updatedAt: Date.now(),
      }, state.deltas[index]);
      write(state);
      return clone(state.deltas[index]);
    },
  };
}

function createFileKnowledgeDossierStore(filePath = path.resolve(__dirname, "../../../.runtime/knowledge-dossiers.json")) {
  return createKnowledgeDossierStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { version: STORE_VERSION, dossiers: [], deltas: [], runs: [] }; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryKnowledgeDossierStore(initialState = { version: STORE_VERSION, dossiers: [], deltas: [], runs: [] }) {
  let state = clone(initialState);
  return createKnowledgeDossierStore({ read: () => clone(state), write: (next) => { state = clone(next); } });
}

module.exports = {
  activationProblems,
  createFileKnowledgeDossierStore,
  createMemoryKnowledgeDossierStore,
  dossierStatuses,
  manualReviewProblems,
  occurrenceRoles,
  relationTypes,
  relationProblems,
  reviewableItems,
  reviewStatuses,
};
