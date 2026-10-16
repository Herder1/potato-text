"use strict";

// A read-only browsing facet; never persist this as a domain review status.
function questionChecked(question) {
  return question.answerReviewStatus === "verified"
    || (!question.answerReviewStatus && question.status === "official");
}

function membershipChecked(member) {
  return member.familyStatus === "confirmed" && member.reviewStatus === "confirmed";
}

function membershipPending(member) {
  return member.familyStatus === "pending_review" || member.reviewStatus === "pending_fit";
}

function matchesWorkspaceStatus(question, status = "all", memberships = []) {
  if (status === "all") return true;
  if (question.status === "offline" || question.mergedIntoQuestionId || question.merge?.targetQuestionId) return false;
  if (status === "unarchived") return memberships.length === 0;
  if (status === "checked") return questionChecked(question) && (!memberships.length || memberships.some(membershipChecked));
  if (status === "pending") return !questionChecked(question) || memberships.some(membershipPending);
  return false;
}

function workspaceFamilySelection(families, questions, filters = {}) {
  const byId = new Map(questions.map(question => [question.id, question]));
  const status = filters.workspaceStatus || "all";
  const needsMember = (filters.type && filters.type !== "all") || (filters.importBatchId && filters.importBatchId !== "all");
  return families.flatMap(family => {
    if (status === "unarchived") return [];
    const workspaceMemberIds = family.members.filter(member => {
      const question = byId.get(member.questionId);
      return question && matchesWorkspaceStatus(question, status, [{ ...member, familyStatus: family.status }]);
    }).map(member => member.questionId);
    const emptyMatch = !family.members.length && !needsMember
      && (status === "all" || (status === "checked" && family.status === "confirmed") || (status === "pending" && family.status === "pending_review"));
    const searchMatch = family.searchMatch;
    const matchingQueryIds = (searchMatch?.questionIds || []).filter(id => workspaceMemberIds.includes(id));
    if (searchMatch && !(searchMatch.metadataFields || []).length && !matchingQueryIds.length) return [];
    // Keep the complete member records for editing; visibility is a separate projection.
    return workspaceMemberIds.length || emptyMatch ? [{ ...family, workspaceMemberIds,
      ...(searchMatch ? { searchMatch: { ...searchMatch, questionIds: matchingQueryIds, questionCount: matchingQueryIds.length } } : {}),
    }] : [];
  });
}

function workspaceFamilySets(sets, families, restricted) {
  if (!restricted) return sets;
  const visible = new Set(families.map(family => family.id));
  const keep = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const set of sets) {
      if (keep.has(set.id)) continue;
      if ((set.items || []).some(item => item.type === "family" ? visible.has(item.id) : keep.has(item.id))
        || sets.some(child => child.parentSetId === set.id && keep.has(child.id))) {
        keep.add(set.id);
        changed = true;
      }
    }
  }
  return sets.filter(set => keep.has(set.id));
}

module.exports = { matchesWorkspaceStatus, workspaceFamilySelection, workspaceFamilySets };
