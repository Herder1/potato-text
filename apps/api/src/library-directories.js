const crypto = require("node:crypto");
const { buildNodes } = require("./knowledge-structure-store");

function descendantIds(nodes, nodeId) {
  const result = new Set(nodes.some((node) => node.id === nodeId) ? [nodeId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    nodes.forEach((node) => {
      if (result.has(node.parentId) && !result.has(node.id)) { result.add(node.id); changed = true; }
    });
  }
  return result;
}

function dossierNodeIds(directory, nodeId) {
  if (directory.dossierNodes.some((node) => node.id === nodeId)) return [nodeId];
  return directory.mappings.find((link) => link.questionNodeId === nodeId)?.dossierNodeIds || [];
}

function questionNodeIds(directory, nodeId) {
  if (directory.dossierNodes.some((node) => node.id === nodeId)) {
    return directory.mappings.filter((link) => link.dossierNodeIds.includes(nodeId)).map((link) => link.questionNodeId);
  }
  return directory.questionNodes.some((node) => node.id === nodeId) ? [nodeId] : [];
}

function createLibraryDirectories({ knowledgeStructureStore, textbookCatalogStore, textbookKnowledgeStore }) {
  const read = (bookId) => {
    const questionNodes = knowledgeStructureStore.get(bookId)?.nodes || [];
    const catalog = textbookCatalogStore.get(bookId);
    const dossierNodes = buildNodes(bookId, catalog?.confirmed?.nodes || [], textbookKnowledgeStore.outline(bookId) || []);
    const stored = knowledgeStructureStore.directoryMappings(bookId);
    const questionIds = new Set(questionNodes.map((node) => node.id));
    const dossierIds = new Set(dossierNodes.map((node) => node.id));
    const mappings = questionNodes.map((node) => {
      const explicit = Object.prototype.hasOwnProperty.call(stored.links, node.id);
      const ids = explicit ? stored.links[node.id] : (dossierIds.has(node.id) ? [node.id] : []);
      return { questionNodeId: node.id, dossierNodeIds: ids.filter((id) => dossierIds.has(id)),
        invalidTargetIds: ids.filter((id) => !dossierIds.has(id)), source: explicit ? "manual" : "identity" };
    });
    const invalidSourceIds = Object.keys(stored.links).filter((id) => !questionIds.has(id));
    const revision = crypto.createHash("sha256").update(JSON.stringify({ questionNodes, dossierNodes, stored })).digest("hex");
    return { bookId, questionNodes, dossierNodes, mappings, invalidSourceIds, revision, mappingRevision: stored.revision };
  };
  return {
    read,
    save(bookId, questionNodeId, dossierNodeIds, expectedRevision) {
      const current = read(bookId);
      if (current.revision !== expectedRevision) throw new Error("directory_mapping_stale");
      if (!Array.isArray(dossierNodeIds) || dossierNodeIds.length > 500) throw new Error("directory_mapping_invalid");
      if (!current.questionNodes.some((node) => node.id === questionNodeId)) throw new Error("knowledge_node_not_found");
      if (dossierNodeIds.some((id) => typeof id !== "string" || !current.dossierNodes.some((node) => node.id === id))) {
        throw new Error("directory_mapping_target_invalid");
      }
      knowledgeStructureStore.setDirectoryMapping(bookId, questionNodeId, dossierNodeIds, current.mappingRevision);
      return read(bookId);
    },
  };
}

module.exports = { createLibraryDirectories, descendantIds, dossierNodeIds, questionNodeIds };
