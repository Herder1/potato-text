// Run while API writes are stopped. Dry-run by default; --write backs up first.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createFileUserAuthStore, createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
if (fileIndex >= 0 && (!args[fileIndex + 1] || args[fileIndex + 1].startsWith("--"))) {
  throw new Error("--file requires a path");
}
const filePath = path.resolve(fileIndex < 0 ? path.join(__dirname, "../.runtime/users.json") : args[fileIndex + 1]);
const write = args.includes("--write");
if (!fs.existsSync(filePath)) {
  console.log(`No user file: ${filePath}`);
  process.exit(0);
}

const original = fs.readFileSync(filePath);
const originalHash = crypto.createHash("sha256").update(original).digest("hex");
const store = createFileUserAuthStore(filePath);
const before = store.exportState();
const users = before.users || [];
createMemoryUserAuthStore(before).assignPublicIds();
const existing = users.filter((user) => user.publicId).length;
const missing = users.length - existing;
console.log(`Users: ${users.length}; existing numeric IDs: ${existing}; to assign: ${missing}`);
if (!write || !missing) {
  if (!write) console.log("Dry run. Stop API writes, then pass --write to back up and assign IDs.");
  return;
}
const currentHash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
if (currentHash !== originalHash) throw new Error("User data changed during preview; aborting");
const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
const result = store.assignPublicIds();
const after = store.exportState();
const ids = after.users.map((user) => String(user.publicId || ""));
if (result.assigned !== missing || after.users.length !== users.length
  || ids.some((id) => !/^[1-9]\d{8}$/.test(id)) || new Set(ids).size !== ids.length
  || JSON.stringify({ ...after, users: after.users.map(({ publicId, ...user }) => user) })
    !== JSON.stringify({ ...before, users: users.map(({ publicId, ...user }) => user) })) {
  throw new Error(`Validation failed; restore manually from ${backupPath} while writes are stopped`);
}
console.log(`Assigned ${result.assigned} IDs. Backup: ${backupPath}`);
