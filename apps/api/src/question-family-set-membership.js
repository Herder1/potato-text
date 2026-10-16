"use strict";

function deriveQuestionFamilySets(memberships = [], sets = []) {
  const byId = new Map(sets.map((set) => [set.id, set]));
  const directSetByFamily = new Map();
  sets.forEach((set) => (set.directFamilyIds || []).forEach((familyId) => {
    directSetByFamily.set(familyId, set.id);
  }));
  const results = new Map();
  [...memberships].sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
    .forEach((member) => {
      let setId = directSetByFamily.get(member.familyId);
      const visited = new Set();
      while (setId && !visited.has(setId) && byId.has(setId)) {
        visited.add(setId);
        const set = byId.get(setId);
        if (!results.has(setId)) {
          results.set(setId, { setId, name: set.name, sources: [] });
        }
        results.get(setId).sources.push({
          familyId: member.familyId,
          familyName: member.familyName,
          isPrimary: member.isPrimary === true,
          reviewStatus: member.reviewStatus,
          familyStatus: member.familyStatus,
          confirmed: member.reviewStatus === "confirmed" && member.familyStatus === "confirmed",
          status: member.familyStatus === "rejected" ? "rejected"
            : member.reviewStatus === "inactive" ? "inactive"
            : (member.reviewStatus === "confirmed" && member.familyStatus === "confirmed" ? "confirmed" : "pending"),
          relation: setId === directSetByFamily.get(member.familyId) ? "direct" : "ancestor",
        });
        setId = set.parentSetId;
      }
    });
  return [...results.values()];
}

module.exports = { deriveQuestionFamilySets };
