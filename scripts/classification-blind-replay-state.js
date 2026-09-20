const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FORMAL_STATE_FILES = Object.freeze([
  "questions.json",
  "question-families.json",
  "knowledge-structures.json",
  "knowledge-classification-experience.json",
  "knowledge-classification.json",
  "ai-tasks.json",
  "admin-actions.json",
  "knowledge-dossiers.json",
  "textbook-knowledge.json",
  "textbook-catalogs.json",
  "ai-config.json",
]);

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) => error.code === "ENOENT" ? resolve("missing") : reject(error));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashFormalState(runtimeDir) {
  const entries = await Promise.all(FORMAL_STATE_FILES.map(async (fileName) => [
    fileName,
    await hashFile(path.join(runtimeDir, fileName)),
  ]));
  return Object.fromEntries(entries);
}

module.exports = {
  FORMAL_STATE_FILES,
  hashFormalState,
};
