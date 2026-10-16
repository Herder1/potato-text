const crypto = require("node:crypto");
const { buildFingerprints, knowledgeSpan } = require("./knowledge-structure-store");
const { buildFamilyCandidates } = require("./question-family-store");

const present = (fp) => Boolean(fp?.primaryNodeId || fp?.requiredNodeIds?.length || fp?.status === "confirmed");
const normalize = (text) => String(text || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const sameSet = (a, b) => JSON.stringify([...new Set(a || [])].sort()) === JSON.stringify([...new Set(b || [])].sort());

function createQuestionCompletion({ questionStore, knowledgeStructureStore, questionFamilyStore, textbookKnowledgeStore, directories }) {
  const secret = crypto.randomBytes(32);
  let rollbackFailed = false;
  const sign = (value) => crypto.createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
  const preview = (questions) => {
    const contexts = new Map();
    return questionStore.getMany(questions.map((input) => input.id)).map((question) => {
      if (!question) throw new Error("question_not_found");
      const bookId = String(question.bookId || "");
      const row = { questionId: question.id, bookId, stem: question.stem, issues: [], fingerprint: null, family: null };
      if (!bookId || question.status === "offline") { row.issues.push(!bookId ? "没有教材归属" : "题目已下架"); return row; }
      if (!contexts.has(bookId)) {
        const directory = directories.read(bookId);
        const families = questionFamilyStore.list({ bookId, status: "all" }).families;
        const chunks = textbookKnowledgeStore.get(bookId, { includeContent: true })?.chunks || [];
        contexts.set(bookId, { directory, structure: knowledgeStructureStore.get(bookId), families, chunks,
          revision: sign({ directory: directory.revision, families, chunks }) });
      }
      const { directory, structure, families, chunks } = contexts.get(bookId);
      const storedFp = (structure?.fingerprints || []).find((item) => item.questionId === question.id);
      const existingFp = present(question.knowledgeFingerprint) ? question.knowledgeFingerprint : (present(storedFp) ? storedFp : null);
      const memberships = families.filter((family) => family.members.some((member) => member.questionId === question.id));
      row.hasFingerprint = Boolean(existingFp);
      row.hasFamily = memberships.length > 0;
      let fingerprint = existingFp;
      const byId = new Map(directory.questionNodes.map((node) => [node.id, node]));
      if (!structure?.nodes?.length) row.issues.push("题库目录尚未建立，请先整理目录");
      else if (!existingFp) {
        if (!directory.dossierNodes.length) row.issues.push("教材来源目录尚未建立");
        else {
          const source = buildFingerprints([question], directory.dossierNodes, chunks)[0];
          const mapNode = (id) => directory.mappings.filter((link) => link.dossierNodeIds.includes(id))
            .map((link) => byId.get(link.questionNodeId)).filter((node) => node?.kind === "knowledge");
          const primary = source.primaryNodeId ? mapNode(source.primaryNodeId) : [];
          if (primary.length !== 1) {
            row.issues.push(!source.primaryNodeId ? "未找到可靠的教材知识节点" : primary.length > 1
              ? "来源节点对应多个题库节点，请先明确映射或人工处理" : "来源节点尚未映射到题库知识点");
          } else {
            const required = (source.requiredNodeIds || [source.primaryNodeId]).map(mapNode);
            if (required.some((nodes) => nodes.length !== 1)) row.issues.push("作答所需知识存在未映射或多重映射，需人工核对");
            else {
              const requiredNodeIds = [...new Set(required.map(([node]) => node.id))];
              const auxiliaryNodeIds = [];
              const seen = new Set();
              let parent = byId.get(primary[0].parentId);
              while (parent && !seen.has(parent.id)) {
                seen.add(parent.id);
                if (parent.kind === "knowledge") auxiliaryNodeIds.unshift(parent.id);
                parent = byId.get(parent.parentId);
              }
              fingerprint = { ...source, primaryNodeId: primary[0].id, primaryKnowledgePoint: primary[0].displayTitle,
                knowledgePath: primary[0].path, knowledgeLevel: primary[0].knowledgeLevel,
                requiredNodeIds, auxiliaryNodeIds, crossKnowledge: requiredNodeIds.length > 1,
                span: knowledgeSpan(requiredNodeIds.map((id) => byId.get(id)), byId),
                relations: requiredNodeIds.length > 1 ? ["共同作答"] : (auxiliaryNodeIds.length ? ["包含"] : []),
                source: "directory_mapping", status: "suggested" };
              row.fingerprint = fingerprint;
            }
          }
        }
      }
      if (fingerprint && (!byId.has(fingerprint.primaryNodeId)
        || (fingerprint.requiredNodeIds || []).some((id) => !byId.has(id)))) {
        row.issues.push("已有指纹引用失效，保留原值，请单独人工修正");
        fingerprint = null;
      }
      if (!row.hasFamily && fingerprint) {
        const draft = buildFamilyCandidates([question], bookId, { fingerprints: [fingerprint], allowSingleton: true }).families[0];
        if (draft) {
          const candidates = families.filter((family) => family.status !== "rejected"
            && (family.coreKnowledgeNodeId || family.knowledgeNodeId) === fingerprint.primaryNodeId
            && sameSet(family.requiredKnowledgeNodeIds, draft.requiredKnowledgeNodeIds)
            && (!family.assessmentAction || !draft.assessmentAction || normalize(family.assessmentAction) === normalize(draft.assessmentAction))
            && (normalize(family.focusKey) === normalize(draft.focusKey) || normalize(family.name) === normalize(draft.name)));
          const conflicting = !candidates.length && families.some((family) => family.knowledgeNodeId === draft.knowledgeNodeId
            && (normalize(family.focusKey) === normalize(draft.focusKey) || normalize(family.name) === normalize(draft.name)));
          if (conflicting) row.issues.push("已有同名或同焦点题族，但知识要求或审核状态不同，请人工核对；不会重复新建");
          else row.family = { candidates: candidates.map((family) => ({ id: family.id, name: family.name, status: family.status, memberCount: family.members.length })),
            draft: candidates.length ? null : draft };
        } else row.issues.push("考查焦点尚不明确，请人工完善后再匹配题族");
      }
      // Sign source facts, not candidate timestamps regenerated on each preview.
      row.token = sign({ question, storedFp, revision: contexts.get(bookId).revision });
      return row;
    });
  };

  return {
    preview,
    commit(items, actor) {
      if (rollbackFailed) throw new Error("completion_rollback_failed");
      if (!Array.isArray(items) || !items.length || items.length > 5000) throw new Error("completion_selection_required");
      const seen = new Set();
      items.forEach((item) => {
        if (!item || typeof item.questionId !== "string" || typeof item.fingerprint !== "boolean"
          || typeof item.familyId !== "string") throw new Error("completion_selection_invalid");
        if (seen.has(item.questionId)) throw new Error("completion_selection_invalid");
        seen.add(item.questionId);
      });
      const questions = questionStore.getMany(items.map((item) => item.questionId));
      if (questions.some((question) => !question)) throw new Error("question_not_found");
      const rows = preview(questions);
      rows.forEach((row, index) => {
        const item = items[index];
        if (!row.token || row.token !== item.token) throw new Error("completion_preview_stale");
        if (item.fingerprint && !row.fingerprint) throw new Error("completion_selection_invalid");
        if (item.familyId) {
          if (!row.family || (item.familyId === "new" ? !row.family.draft : !row.family.candidates.some((family) => family.id === item.familyId))) {
            throw new Error("completion_selection_invalid");
          }
          if (!row.hasFingerprint && !item.fingerprint) throw new Error("completion_fingerprint_required");
        }
        if (!item.fingerprint && !item.familyId) throw new Error("completion_selection_required");
      });
      const beforeStructure = knowledgeStructureStore.exportState();
      const beforeFamilies = questionFamilyStore.exportState();
      const result = { fingerprintsAdded: 0, membershipsAdded: 0, familiesCreated: 0 };
      const created = new Map();
      try {
        const fingerprintsByBook = new Map();
        const membersByFamily = new Map();
        rows.forEach((row, index) => {
          if (!items[index].fingerprint) return;
          if (!fingerprintsByBook.has(row.bookId)) fingerprintsByBook.set(row.bookId, []);
          fingerprintsByBook.get(row.bookId).push(row.fingerprint);
        });
        fingerprintsByBook.forEach((fingerprints, bookId) => {
          result.fingerprintsAdded += knowledgeStructureStore.fillMissingFingerprints(bookId, fingerprints).addedQuestionIds.length;
        });
        rows.forEach((row, index) => {
          const item = items[index];
          if (!item.familyId) return;
          let familyId = item.familyId;
          if (familyId === "new") {
            const draft = row.family.draft;
            const key = JSON.stringify([draft.bookId, draft.knowledgeNodeId, normalize(draft.focusKey), [...draft.requiredKnowledgeNodeIds].sort(), draft.assessmentAction]);
            familyId = created.get(key);
            if (!familyId) {
              familyId = questionFamilyStore.create(draft).id;
              created.set(key, familyId);
              result.familiesCreated += 1;
            }
          }
          if (!membersByFamily.has(familyId)) membersByFamily.set(familyId, []);
          membersByFamily.get(familyId).push(questions[index]);
        });
        membersByFamily.forEach((questions, familyId) => {
          result.membershipsAdded += questionFamilyStore.addMembers(familyId, questions, actor, { preserveDefinition: true }).addedCount;
        });
        return result;
      } catch (error) {
        try {
          knowledgeStructureStore.replaceState(beforeStructure);
          questionFamilyStore.replaceState(beforeFamilies);
        } catch (rollbackError) { rollbackFailed = true; throw new Error("completion_rollback_failed", { cause: rollbackError }); }
        throw error;
      }
    },
  };
}

module.exports = { createQuestionCompletion, present };
