function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function uniqueIds(values) {
  return [...new Set(asArray(values).map(String).filter(Boolean))];
}

function replaceQuestionIds(values, sourceQuestionId, targetQuestionId) {
  const before = asArray(values).map(String);
  const after = [];
  const seen = new Set();
  before.forEach((id) => {
    const nextId = id === sourceQuestionId ? targetQuestionId : id;
    if (!nextId || seen.has(nextId)) return;
    seen.add(nextId);
    after.push(nextId);
  });
  return { values: after, changed: JSON.stringify(before) !== JSON.stringify(after) };
}

function snapshotQuestion(question) {
  const { versions, ...snapshot } = question;
  return clone(snapshot);
}

function deterministicMergeTime(source, target, requestedMergedAt) {
  const timestamps = [source.createdAt, source.updatedAt, target.createdAt, target.updatedAt];
  [...asArray(source.versions), ...asArray(target.versions)].forEach((version) => {
    timestamps.push(version.updatedAt, version.createdAt);
  });
  const fallback = Math.max(0, ...timestamps.map(Number).filter(Number.isFinite)) + 1;
  const explicit = Number(requestedMergedAt);
  return Number.isFinite(explicit) && explicit > 0 ? Math.max(Math.floor(explicit), fallback) : fallback;
}

function validateMerge(questions, input) {
  const sourceQuestionId = String(input.sourceQuestionId || "");
  const targetQuestionId = String(input.targetQuestionId || "");
  if (!sourceQuestionId || !targetQuestionId) throw new Error("question_merge_questions_required");
  if (sourceQuestionId === targetQuestionId) throw new Error("question_merge_same_question");
  const source = questions.find((question) => question.id === sourceQuestionId);
  const target = questions.find((question) => question.id === targetQuestionId);
  if (!source) throw new Error("question_merge_source_not_found");
  if (!target) throw new Error("question_merge_target_not_found");
  if (String(source.bookId || "") !== String(target.bookId || "")) throw new Error("question_merge_book_mismatch");
  if (Number(source.version) !== Number(input.sourceVersion)) throw new Error("question_merge_source_version_conflict");
  if (Number(target.version) !== Number(input.targetVersion)) throw new Error("question_merge_target_version_conflict");
  if (source.mergedIntoQuestionId || source.merge?.targetQuestionId) throw new Error("question_merge_source_already_merged");
  if (target.mergedIntoQuestionId || target.merge?.targetQuestionId) throw new Error("question_merge_target_already_merged");
  if (source.status === "offline" || target.status === "offline") throw new Error("question_merge_question_offline");
  if (questions.some((question) => question.id !== sourceQuestionId && question.mergedIntoQuestionId === sourceQuestionId)) {
    throw new Error("question_merge_chain_not_allowed");
  }
  const reason = String(input.reason || "").trim();
  const actor = String(input.actor || "").trim();
  if (!reason) throw new Error("question_merge_reason_required");
  if (!actor) throw new Error("question_merge_actor_required");
  return {
    source,
    target,
    sourceQuestionId,
    targetQuestionId,
    reason,
    actor,
    primaryFamilyId: String(input.primaryFamilyId || ""),
  };
}

function transformQuestions(questions, context, mergedAt) {
  const { source, target, sourceQuestionId, targetQuestionId, reason, actor } = context;
  const nextVersion = Number(source.version) + 1;
  const merge = {
    type: "duplicate",
    sourceQuestionId,
    targetQuestionId,
    sourceVersion: Number(source.version),
    targetVersion: Number(target.version),
    reason,
    actor,
    mergedAt,
  };
  return questions.map((question) => question.id !== sourceQuestionId ? clone(question) : {
    ...clone(question),
    status: "offline",
    mergedIntoQuestionId: targetQuestionId,
    merge,
    version: nextVersion,
    updatedAt: mergedAt,
    updatedBy: actor,
    versions: [{
      version: nextVersion,
      updatedAt: mergedAt,
      updatedBy: actor,
      changeNote: `重复题合并至 ${targetQuestionId}：${reason}`,
      previousSnapshot: snapshotQuestion(question),
      merge,
    }, ...asArray(question.versions).map(clone)].slice(0, 50),
  });
}

function familyMemberSignature(member) {
  if (!member) return "";
  const { questionId, resolution, mergedFromQuestionId, ...fields } = member;
  return JSON.stringify(fields);
}

function pendingFamilyMember(member, reason, actor) {
  return {
    ...member,
    reviewStatus: "pending_fit",
    reviewedAt: null,
    reviewedBy: "",
    reviewInvalidationReason: reason,
    reviewInvalidatedBy: actor,
  };
}

function refreshFamilyMembershipMetadata(family, members) {
  const memberCount = asArray(members).length;
  const source = String(family.source || "");
  const reason = String(family.reason || "").trim();
  const relocated = source === "manual_moved_family" || reason.startsWith("人工整体移动");

  if (relocated) {
    return {
      source: source === "manual_moved_family"
        ? source
        : (memberCount ? "manual_family" : "manual_empty_family"),
      reason: memberCount
        ? `人工整体移动的题族，共有 ${memberCount} 道题；确认前不会用于智能复习。`
        : "人工整体移动的空题族骨架，补充并审核题目后才会进入智能复习。",
    };
  }

  if (["manual_family", "manual_empty_family"].includes(source)
    || reason.startsWith("人工维护的题族")
    || reason.startsWith("人工创建的空题族")) {
    return {
      source: memberCount ? "manual_family" : "manual_empty_family",
      reason: memberCount
        ? `人工维护的题族，共有 ${memberCount} 道题；确认前不会用于智能复习。`
        : "人工创建的空题族骨架，补充并审核题目后才会进入智能复习。",
    };
  }

  const generatedReasonPrefix = "按“核心知识点 + 具体考查命题”自动成族";
  if (["catalog_action_rule", "curated_rule"].includes(source) && reason.startsWith(generatedReasonPrefix)) {
    return {
      source,
      reason: reason.replace(/共归入\s*\d+\s*道题/u, `共归入 ${memberCount} 道题`),
    };
  }

  return { source, reason };
}

function transformQuestionFamilies(state, context, mergedAt) {
  const next = clone(objectValue(state));
  next.families = asArray(next.families);
  const { sourceQuestionId, targetQuestionId, actor } = context;
  const sourcePrimaryFamilyIds = next.families
    .filter((family) => asArray(family.members).some((member) => member.questionId === sourceQuestionId && member.isPrimary === true))
    .map((family) => family.id);
  const targetPrimaryFamilyIds = next.families
    .filter((family) => asArray(family.members).some((member) => member.questionId === targetQuestionId && member.isPrimary === true))
    .map((family) => family.id);
  const primaryFamilyCandidates = [...new Set([...sourcePrimaryFamilyIds, ...targetPrimaryFamilyIds])];
  if (context.primaryFamilyId && !primaryFamilyCandidates.includes(context.primaryFamilyId)) {
    throw new Error("question_merge_primary_family_invalid");
  }
  if (primaryFamilyCandidates.length > 1 && !context.primaryFamilyId) {
    throw new Error("question_merge_primary_family_conflict");
  }
  const preferredPrimaryFamilyId = context.primaryFamilyId || primaryFamilyCandidates[0] || "";
  const affectedFamilyIds = new Set();
  const collapsedFamilyIds = [];

  next.families = next.families.map((family) => {
    const members = asArray(family.members);
    const sourceIndex = members.findIndex((member) => member.questionId === sourceQuestionId);
    const targetIndexes = members.flatMap((member, index) => member.questionId === targetQuestionId ? [index] : []);
    if (sourceIndex < 0) return family;
    const sourceMember = members[sourceIndex];
    const targetMember = targetIndexes.length ? members[targetIndexes[0]] : null;
    const sameExistingMembership = Boolean(targetMember
      && familyMemberSignature(sourceMember) === familyMemberSignature(targetMember));
    const replacementDraft = {
      ...clone(sameExistingMembership ? targetMember : sourceMember),
      questionId: targetQuestionId,
      mergedFromQuestionId: sourceQuestionId,
      ...(targetMember && !sameExistingMembership
        ? { resolution: "prefer_source" }
        : {}),
    };
    const replacement = sameExistingMembership
      ? replacementDraft
      : pendingFamilyMember(replacementDraft, "question_merged", actor);
    const insertAt = Math.min(sourceIndex, ...(targetIndexes.length ? targetIndexes : [sourceIndex]));
    const transformed = [];
    members.forEach((member, index) => {
      if (index === insertAt) transformed.push(replacement);
      if (index === sourceIndex || targetIndexes.includes(index)) return;
      transformed.push(clone(member));
    });
    if (targetMember) collapsedFamilyIds.push(family.id);
    if (transformed.length && !transformed.some((member) => member.role === "prototype")) {
      const replacementIndex = transformed.findIndex((member) => member.questionId === targetQuestionId);
      const prototypeIndex = replacementIndex >= 0 ? replacementIndex : 0;
      transformed[prototypeIndex] = pendingFamilyMember(
        { ...transformed[prototypeIndex], role: "prototype" },
        "question_family_prototype_promoted_after_merge",
        actor,
      );
    }
    affectedFamilyIds.add(family.id);
    return {
      ...family,
      ...refreshFamilyMembershipMetadata(family, transformed),
      members: transformed,
      updatedAt: mergedAt,
    };
  });

  if (preferredPrimaryFamilyId) {
    next.families = next.families.map((family) => {
      let changed = false;
      const members = asArray(family.members).map((member) => {
        if (member.questionId !== targetQuestionId) return member;
        const isPrimary = family.id === preferredPrimaryFamilyId;
        if (member.isPrimary === isPrimary) return member;
        changed = true;
        return pendingFamilyMember({
          ...member,
          isPrimary,
          ...(sourcePrimaryFamilyIds.length ? { resolution: "prefer_source" } : {}),
        }, "question_primary_membership_updated_after_merge", actor);
      });
      if (!changed) return family;
      affectedFamilyIds.add(family.id);
      return {
        ...family,
        members,
        updatedAt: mergedAt,
      };
    });
  }

  // Compatibility-only field. Ungrouped questions are derived from current active relations.
  next.unresolvedByBook = {};
  next.membershipRevisionByQuestion = clone(objectValue(next.membershipRevisionByQuestion));
  next.membershipRevisionByQuestion[sourceQuestionId] = Math.max(0, Number(next.membershipRevisionByQuestion[sourceQuestionId]) || 0) + 1;
  next.membershipRevisionByQuestion[targetQuestionId] = Math.max(0, Number(next.membershipRevisionByQuestion[targetQuestionId]) || 0) + 1;
  return {
    state: next,
    summary: {
      affectedFamilyIds: [...affectedFamilyIds],
      collapsedFamilyIds: [...new Set(collapsedFamilyIds)],
      resolution: context.primaryFamilyId
        ? "explicit_primary_family"
        : (collapsedFamilyIds.length || sourcePrimaryFamilyIds.length ? "prefer_source" : "none"),
      primaryFamilyId: preferredPrimaryFamilyId,
      primaryFamilyCandidates,
      membershipRevisions: {
        [sourceQuestionId]: next.membershipRevisionByQuestion[sourceQuestionId],
        [targetQuestionId]: next.membershipRevisionByQuestion[targetQuestionId],
      },
    },
  };
}

function nodeKnowledgePatch(node, fingerprint = {}, nodes = []) {
  const previousPrimaryNodeId = String(fingerprint.primaryNodeId || "");
  const primaryNodeRole = ["core", "scope_anchor"].includes(String(fingerprint.primaryNodeRole || ""))
    ? String(fingerprint.primaryNodeRole) : "core";
  let requiredNodeIds = uniqueIds(fingerprint.requiredNodeIds);
  if (primaryNodeRole === "scope_anchor") {
    requiredNodeIds = requiredNodeIds.filter((id) => id !== previousPrimaryNodeId && id !== node.id);
  } else {
    requiredNodeIds = requiredNodeIds.map((id) => id === previousPrimaryNodeId ? node.id : id);
    if (!requiredNodeIds.includes(node.id)) requiredNodeIds.unshift(node.id);
  }
  const nodeById = new Map(asArray(nodes).map((item) => [item.id, item]));
  const evidencePages = [...new Set(requiredNodeIds
    .map((id) => Number(nodeById.get(id)?.startPage))
    .filter((page) => Number.isFinite(page) && page > 0)
    .map(Math.floor))];
  const auxiliaryNodeIds = [];
  let parent = node.parentId ? nodeById.get(node.parentId) : null;
  while (parent) {
    if (parent.kind === "knowledge") auxiliaryNodeIds.unshift(parent.id);
    parent = parent.parentId ? nodeById.get(parent.parentId) : null;
  }
  return {
    primaryNodeId: node.id,
    primaryNodeRole,
    primaryKnowledgePoint: String(node.displayTitle || node.title || ""),
    knowledgePath: String(node.path || node.displayTitle || node.title || ""),
    knowledgeLevel: Math.max(0, Number(node.knowledgeLevel) || 0),
    requiredNodeIds,
    auxiliaryNodeIds,
    evidencePages,
  };
}

function refreshKnowledgeCounts(record, questionCount) {
  const fingerprints = asArray(record.fingerprints);
  const questionCounts = new Map();
  fingerprints.forEach((fingerprint) => {
    uniqueIds([fingerprint.primaryNodeId, ...asArray(fingerprint.requiredNodeIds), ...asArray(fingerprint.auxiliaryNodeIds)])
      .forEach((nodeId) => questionCounts.set(nodeId, (questionCounts.get(nodeId) || 0) + 1));
  });
  const nodes = asArray(record.nodes).map((node) => ({ ...node, questionCount: questionCounts.get(node.id) || 0 }));
  const mappedQuestionCount = fingerprints.filter((fingerprint) => fingerprint.primaryNodeId).length;
  const activeQuestionCount = Math.max(0, Number(questionCount) || 0);
  return {
    ...record,
    nodes,
    summary: {
      ...objectValue(record.summary),
      questionCount: activeQuestionCount,
      nodeCount: nodes.length,
      knowledgeNodeCount: nodes.filter((node) => node.kind === "knowledge").length,
      deepKnowledgeNodeCount: nodes.filter((node) => Number(node.knowledgeLevel) >= 2).length,
      mappedQuestionCount,
      unmappedQuestionCount: Math.max(0, activeQuestionCount - mappedQuestionCount),
      crossKnowledgeQuestionCount: fingerprints.filter((fingerprint) => fingerprint.crossKnowledge === true).length,
    },
  };
}

function chooseKnowledgeValue(sourceValue, targetValue, preferredKnowledgeNodeId) {
  if (preferredKnowledgeNodeId) {
    if (sourceValue?.primaryNodeId === preferredKnowledgeNodeId) return { value: sourceValue, action: "prefer_source" };
    if (targetValue?.primaryNodeId === preferredKnowledgeNodeId) return { value: targetValue, action: "prefer_target" };
  }
  if (targetValue) return { value: targetValue, action: "preserve_target" };
  if (sourceValue) return { value: sourceValue, action: "copy_source" };
  return { value: null, action: preferredKnowledgeNodeId ? "create_corrected" : "none" };
}

function replaceFingerprints(fingerprints, sourceQuestionId, targetQuestionId, selected) {
  const indexes = asArray(fingerprints).flatMap((fingerprint, index) => [sourceQuestionId, targetQuestionId].includes(fingerprint.questionId) ? [index] : []);
  const insertAt = indexes.length ? Math.min(...indexes) : asArray(fingerprints).length;
  const next = asArray(fingerprints).filter((fingerprint) => ![sourceQuestionId, targetQuestionId].includes(fingerprint.questionId)).map(clone);
  if (selected) next.splice(Math.min(insertAt, next.length), 0, selected);
  return next;
}

function transformKnowledgeStructures(state, context, preferredKnowledgeNodeId, mergedAt) {
  const next = clone(objectValue(state));
  next.records = asArray(next.records);
  const { source, target, sourceQuestionId, targetQuestionId } = context;
  const recordIndex = next.records.findIndex((record) => record.bookId === source.bookId);
  if (recordIndex < 0) {
    if (preferredKnowledgeNodeId) throw new Error("question_merge_knowledge_structure_not_found");
    return { state: next, summary: { action: "none", sourceFingerprintRemoved: false, targetFingerprintUpdated: false } };
  }
  const record = next.records[recordIndex];
  const sourceFingerprint = asArray(record.fingerprints).find((fingerprint) => fingerprint.questionId === sourceQuestionId) || null;
  const targetFingerprint = asArray(record.fingerprints).find((fingerprint) => fingerprint.questionId === targetQuestionId) || null;
  const preferredNode = preferredKnowledgeNodeId
    ? asArray(record.nodes).find((node) => node.id === preferredKnowledgeNodeId && node.bookId === source.bookId)
    : null;
  if (preferredKnowledgeNodeId && !preferredNode) throw new Error("question_merge_knowledge_node_not_found");
  const choice = chooseKnowledgeValue(sourceFingerprint, targetFingerprint, preferredKnowledgeNodeId);
  let selectedFingerprint = choice.value ? { ...clone(choice.value), questionId: targetQuestionId, bookId: target.bookId } : null;
  if (preferredNode) {
    const patch = nodeKnowledgePatch(preferredNode, selectedFingerprint || {}, record.nodes);
    selectedFingerprint = {
      ...(selectedFingerprint || { bookId: target.bookId, requiredNodeIds: [], auxiliaryNodeIds: [] }),
      questionId: targetQuestionId,
      ...patch,
      span: patch.requiredNodeIds.length > 1 ? (selectedFingerprint?.span || "same_branch") : "single_point",
      crossKnowledge: patch.requiredNodeIds.length > 1,
      relations: patch.requiredNodeIds.length > 1 ? ["共同作答"] : (patch.auxiliaryNodeIds.length ? ["包含"] : []),
      source: "question_merge",
      status: "confirmed",
      confidence: 1,
      questionVersion: Number(target.version),
    };
  } else if (selectedFingerprint && Object.prototype.hasOwnProperty.call(selectedFingerprint, "questionVersion")) {
    selectedFingerprint.questionVersion = Number(target.version);
  }
  const sourceFingerprintRemoved = Boolean(sourceFingerprint);
  const targetFingerprintUpdated = Boolean(selectedFingerprint) && (sourceFingerprintRemoved || preferredKnowledgeNodeId || !targetFingerprint);
  const previousQuestionCount = Number(record.summary?.questionCount);
  const activeQuestionCount = Math.max(0, (Number.isFinite(previousQuestionCount) ? previousQuestionCount : asArray(record.fingerprints).length) - 1);
  next.records[recordIndex] = refreshKnowledgeCounts({
    ...record,
    fingerprints: replaceFingerprints(record.fingerprints, sourceQuestionId, targetQuestionId, selectedFingerprint),
    ...(sourceFingerprintRemoved || targetFingerprintUpdated ? { updatedAt: mergedAt } : {}),
  }, activeQuestionCount);

  next.editsByBook = clone(objectValue(next.editsByBook));
  const existingEdits = next.editsByBook[source.bookId];
  const overrides = objectValue(existingEdits?.fingerprintOverrides);
  const sourceOverride = overrides[sourceQuestionId] || null;
  const targetOverride = overrides[targetQuestionId] || null;
  const overrideChoice = chooseKnowledgeValue(sourceOverride, targetOverride, preferredKnowledgeNodeId);
  let selectedOverride = overrideChoice.value ? { ...clone(overrideChoice.value), questionId: targetQuestionId } : null;
  if (preferredNode) {
    const patch = nodeKnowledgePatch(preferredNode, selectedOverride || {}, record.nodes);
    selectedOverride = {
      ...(selectedOverride || {}),
      questionId: targetQuestionId,
      primaryNodeId: preferredNode.id,
      primaryNodeRole: patch.primaryNodeRole,
      requiredNodeIds: patch.requiredNodeIds,
      questionVersion: Number(target.version),
      source: "question_merge",
    };
  } else if (selectedOverride) {
    selectedOverride.questionVersion = Number(target.version);
  }
  if (existingEdits || sourceOverride || targetOverride || selectedOverride) {
    const nextOverrides = { ...clone(overrides) };
    delete nextOverrides[sourceQuestionId];
    delete nextOverrides[targetQuestionId];
    if (selectedOverride) nextOverrides[targetQuestionId] = selectedOverride;
    next.editsByBook[source.bookId] = { ...clone(existingEdits || {}), fingerprintOverrides: nextOverrides };
  }
  return {
    state: next,
    summary: {
      action: preferredNode && !["prefer_source", "prefer_target"].includes(choice.action) ? "corrected" : choice.action,
      preferredKnowledgeNodeId: preferredKnowledgeNodeId || "",
      sourceFingerprintRemoved,
      targetFingerprintUpdated,
      overrideAction: overrideChoice.action,
    },
  };
}

function versionedReferenceOwner(item, questionIds, selectionRules, context, mergedAt, kind) {
  const { actor, reason, sourceQuestionId, targetQuestionId } = context;
  const nextVersion = Math.max(0, Number(item.version) || 0) + 1;
  return {
    ...item,
    questionIds,
    ...(selectionRules ? { selectionRules } : {}),
    ...(kind === "exam" ? { freePreviewQuestionCount: Math.min(Number(item.freePreviewQuestionCount) || 0, questionIds.length) } : {}),
    version: nextVersion,
    updatedAt: mergedAt,
    updatedBy: actor,
    versions: [{
      version: nextVersion,
      actor,
      note: `题目合并：${sourceQuestionId} → ${targetQuestionId}（${reason}）`,
      createdAt: mergedAt,
    }, ...asArray(item.versions).map(clone)].slice(0, 50),
  };
}

function transformSelectionRules(rules, allowedQuestionIds, sourceQuestionId, targetQuestionId) {
  const allowed = new Set(allowedQuestionIds);
  const used = new Set();
  const transformed = [];
  asArray(rules).forEach((rule) => {
    const replaced = replaceQuestionIds(rule.questionIds, sourceQuestionId, targetQuestionId).values
      .filter((id) => allowed.has(id) && !used.has(id));
    if (replaced.length < 2) return;
    replaced.forEach((id) => used.add(id));
    transformed.push({
      ...clone(rule),
      questionIds: replaced,
      requiredCount: Math.max(1, Math.min(Number(rule.requiredCount) || 1, replaced.length - 1)),
    });
  });
  return transformed;
}

function transformExams(exams, context, mergedAt) {
  const updatedIds = [];
  const state = asArray(exams).map((exam) => {
    if (exam.status === "offline") return clone(exam);
    const replaced = replaceQuestionIds(exam.questionIds, context.sourceQuestionId, context.targetQuestionId);
    const selectionRules = transformSelectionRules(exam.selectionRules, replaced.values, context.sourceQuestionId, context.targetQuestionId);
    const rulesChanged = JSON.stringify(asArray(exam.selectionRules)) !== JSON.stringify(selectionRules);
    if (!replaced.changed && !rulesChanged) return clone(exam);
    updatedIds.push(exam.id);
    return versionedReferenceOwner(exam, replaced.values, selectionRules, context, mergedAt, "exam");
  });
  return { state, updatedIds };
}

function transformPacks(packs, context, mergedAt) {
  const updatedIds = [];
  const state = asArray(packs).map((pack) => {
    if (pack.status === "offline") return clone(pack);
    const replaced = replaceQuestionIds(pack.questionIds, context.sourceQuestionId, context.targetQuestionId);
    if (!replaced.changed) return clone(pack);
    updatedIds.push(pack.id);
    return versionedReferenceOwner(pack, replaced.values, null, context, mergedAt, "pack");
  });
  return { state, updatedIds };
}

function latestMappedState(sourceState, targetState, timestampField) {
  if (!sourceState) return clone(targetState);
  if (!targetState) return clone(sourceState);
  return Number(sourceState[timestampField] || 0) > Number(targetState[timestampField] || 0)
    ? clone(sourceState)
    : clone(targetState);
}

function remapActiveState(map, sourceQuestionId, targetQuestionId, timestampField) {
  const next = clone(objectValue(map));
  if (!Object.prototype.hasOwnProperty.call(next, sourceQuestionId)) return { value: next, changed: false };
  const selected = latestMappedState(next[sourceQuestionId], next[targetQuestionId], timestampField);
  if (selected && typeof selected === "object" && selected.questionId === sourceQuestionId) selected.questionId = targetQuestionId;
  delete next[sourceQuestionId];
  next[targetQuestionId] = selected;
  return { value: next, changed: true };
}

function transformLearningState(state, context, mergedAt) {
  const next = clone(objectValue(state));
  let updatedAccounts = 0;
  next.accounts = asArray(next.accounts).map((account) => {
    const reviewStates = remapActiveState(account.reviewStates, context.sourceQuestionId, context.targetQuestionId, "lastReviewAt");
    const bookmarks = remapActiveState(account.bookmarks, context.sourceQuestionId, context.targetQuestionId, "updatedAt");
    if (!reviewStates.changed && !bookmarks.changed) return account;
    updatedAccounts += 1;
    return { ...account, reviewStates: reviewStates.value, bookmarks: bookmarks.value, updatedAt: mergedAt };
  });
  return { state: next, updatedAccounts };
}

function transformPendingAiStates(classificationState, enrichmentState, context, mergedAt) {
  const classification = clone(objectValue(classificationState));
  const enrichment = clone(objectValue(enrichmentState));
  const classificationResultIds = [];
  const enrichmentSuggestionIds = [];
  classification.jobs = asArray(classification.jobs);
  classification.results = asArray(classification.results).map((result) => {
    if (result.questionId !== context.sourceQuestionId || !["queued", "processing", "pending_review"].includes(result.status)) return result;
    classificationResultIds.push(result.id);
    return {
      ...result,
      status: "stale",
      error: `question_merged_into:${context.targetQuestionId}`,
      updatedAt: mergedAt,
    };
  });
  enrichment.jobs = asArray(enrichment.jobs);
  enrichment.suggestions = asArray(enrichment.suggestions).map((suggestion) => {
    if (suggestion.questionId !== context.sourceQuestionId || suggestion.status !== "recommended") return suggestion;
    enrichmentSuggestionIds.push(suggestion.id);
    return {
      ...suggestion,
      status: "stale",
      error: `question_merged_into:${context.targetQuestionId}`,
      updatedAt: mergedAt,
    };
  });
  return { classification, enrichment, classificationResultIds, enrichmentSuggestionIds };
}

function transformQuestionMerge(states = {}, input = {}) {
  const questions = asArray(states.questions);
  const context = validateMerge(questions, input);
  const mergedAt = deterministicMergeTime(context.source, context.target, input.mergedAt);
  const families = transformQuestionFamilies(states.questionFamilies, context, mergedAt);
  const knowledge = transformKnowledgeStructures(
    states.knowledgeStructures,
    context,
    String(input.preferredKnowledgeNodeId || ""),
    mergedAt,
  );
  const exams = transformExams(states.exams, context, mergedAt);
  const packs = transformPacks(states.packs, context, mergedAt);
  const learning = transformLearningState(states.learningState, context, mergedAt);
  const ai = transformPendingAiStates(states.knowledgeClassification, states.questionEnrichment, context, mergedAt);
  return {
    nextStates: {
      questions: transformQuestions(questions, context, mergedAt),
      questionFamilies: families.state,
      knowledgeStructures: knowledge.state,
      exams: exams.state,
      packs: packs.state,
      learningState: learning.state,
      knowledgeClassification: ai.classification,
      questionEnrichment: ai.enrichment,
    },
    summary: {
      sourceQuestionId: context.sourceQuestionId,
      targetQuestionId: context.targetQuestionId,
      sourceVersion: Number(context.source.version),
      targetVersion: Number(context.target.version),
      mergedAt,
      family: families.summary,
      knowledge: knowledge.summary,
      updatedExamIds: exams.updatedIds,
      updatedPackIds: packs.updatedIds,
      updatedLearningAccountCount: learning.updatedAccounts,
      staleClassificationResultIds: ai.classificationResultIds,
      staleEnrichmentSuggestionIds: ai.enrichmentSuggestionIds,
    },
  };
}

module.exports = { transformQuestionMerge };
