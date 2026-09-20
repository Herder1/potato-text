const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const miniprogramRoot = path.resolve(__dirname, "../apps/miniprogram");
const mediaExtensions = new Set([
  ".aac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mp3",
  ".ogg",
  ".png",
  ".svg",
  ".wav",
  ".webp",
]);
const maxMediaBytes = 200 * 1024;

function collectMediaFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectMediaFiles(entryPath);
    return mediaExtensions.has(path.extname(entry.name).toLowerCase()) ? [entryPath] : [];
  });
}

test("mini program image and audio assets stay within 200 KB", () => {
  const oversized = collectMediaFiles(miniprogramRoot)
    .map((filePath) => ({
      file: path.relative(miniprogramRoot, filePath),
      bytes: fs.statSync(filePath).size,
    }))
    .filter((asset) => asset.bytes > maxMediaBytes);

  assert.deepEqual(oversized, []);
});
