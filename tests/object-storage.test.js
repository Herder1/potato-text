const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Busboy = require("busboy");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryExamStore } = require("../apps/api/src/exam-store");
const {
  createKVaultObjectStorage,
  createMemoryFileMetadataRepository,
  createMemoryObjectStorage,
  sha256,
} = require("../apps/api/src/object-storage");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { createServer } = require("./helpers/admin-auth");

async function startKVaultStub(context) {
  const state = { authorization: [], uploads: [], files: new Map(), deleted: [] };
  const server = http.createServer((request, response) => {
    state.authorization.push(request.headers.authorization || "");
    if (request.method === "POST" && request.url === "/api/v1/upload") {
      const parser = Busboy({ headers: request.headers });
      const fields = {};
      const chunks = [];
      let fileName = "";
      let mimeType = "";
      parser.on("field", (name, value) => { fields[name] = value; });
      parser.on("file", (_name, stream, info) => {
        fileName = info.filename;
        mimeType = info.mimeType;
        stream.on("data", (chunk) => chunks.push(chunk));
      });
      parser.on("finish", () => {
        const id = `remote-${state.files.size + 1}`;
        const buffer = Buffer.concat(chunks);
        state.files.set(id, buffer);
        state.uploads.push({ id, fileName, mimeType, fields, buffer });
        const origin = `http://127.0.0.1:${server.address().port}`;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          success: true,
          file: { id, name: fileName, size: buffer.length, type: mimeType, storage: fields.storage || "telegram" },
          links: {
            download: `${origin}/file/${id}`,
            share: `${origin}/s/${id}`,
            delete: `${origin}/api/v1/file/${id}`,
          },
        }));
      });
      request.pipe(parser);
      return;
    }
    const match = request.url.match(/^\/api\/v1\/file\/(remote-\d+)$/);
    if (match && request.method === "GET") {
      const buffer = state.files.get(match[1]);
      if (!buffer) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: false, error: { code: "FILE_NOT_FOUND", message: "not found" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buffer.length });
      response.end(buffer);
      return;
    }
    if (match && request.method === "DELETE") {
      state.deleted.push(match[1]);
      state.files.delete(match[1]);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, deleted: true, fileId: match[1] }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "not found" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("K-Vault storage uploads with a server-side token and verifies remote bytes", async (context) => {
  const stub = await startKVaultStub(context);
  const repository = createMemoryFileMetadataRepository();
  const storage = createKVaultObjectStorage({
    baseUrl: stub.baseUrl,
    token: "test-secret-token",
    storageType: "r2",
    folderPrefix: "question-bank",
    cacheRoot: false,
    repository,
  });
  const buffer = Buffer.from("persistent file payload");
  const saved = await storage.put("textbooks/book-1.pdf", {
    buffer,
    fileName: "book.pdf",
    mimeType: "application/pdf",
    metadata: { category: "textbook" },
  });

  assert.equal(saved.remoteId, "remote-1");
  assert.equal(saved.storageBackend, "r2");
  assert.equal(saved.sha256, sha256(buffer));
  assert.equal(stub.state.uploads[0].fields.storage, "r2");
  assert.equal(stub.state.uploads[0].fields.folderPath, "question-bank/textbooks");
  assert.equal(stub.state.uploads[0].fileName, "book.pdf");
  assert.deepEqual(await storage.getBuffer("textbooks/book-1.pdf", { bypassCache: true }), buffer);
  assert.deepEqual(await storage.verify("textbooks/book-1.pdf"), {
    objectKey: "textbooks/book-1.pdf",
    size: buffer.length,
    sha256: sha256(buffer),
    remoteId: "remote-1",
  });
  assert.equal(await storage.delete("textbooks/book-1.pdf"), true);
  assert.deepEqual(stub.state.deleted, ["remote-1"]);
  assert.ok(stub.state.authorization.every((value) => value === "Bearer test-secret-token"));
});

test("exam exports remain downloadable through the existing API when stored remotely", async (context) => {
  const objectStorage = createMemoryObjectStorage();
  const examStore = createMemoryExamStore();
  examStore.action("exam-official-001", "publish");
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    examStore,
    questionStore: createMemoryQuestionStore(),
    objectStorage,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/exam-exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ examId: "exam-official-001" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 201);
  for (const file of payload.export.files) {
    const objectKey = `exam-exports/${payload.export.id}/${file.kind}.pdf`;
    const stored = await objectStorage.stat(objectKey);
    assert.equal(stored.metadata.category, "exam_export");
    const downloaded = await fetch(`${baseUrl}${file.url}`);
    const content = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(downloaded.status, 200);
    assert.equal(content.subarray(0, 8).toString("ascii"), "%PDF-1.7");
    assert.equal(content.length, file.size);
  }
});

test("textbook upload and range reads use object storage without changing the API", async (context) => {
  const objectStorage = createMemoryObjectStorage();
  const server = createServer({ aiConfigStore: createMemoryAiConfigStore(), objectStorage });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const pdf = fs.readFileSync(path.resolve(__dirname, "../node_modules/pdf-parse/test/data/01-valid.pdf"));
  const upload = await fetch(`${baseUrl}/api/admin/textbooks/modern-chinese-7-1/pdf?fileName=modern.pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: pdf,
  });
  assert.equal(upload.status, 201, await upload.text());
  const stored = await objectStorage.stat("textbooks/modern-chinese-7-1.pdf");
  assert.equal(stored.size, pdf.length);
  assert.equal(stored.metadata.bookId, "modern-chinese-7-1");

  const downloaded = await fetch(`${baseUrl}/api/admin/textbooks/modern-chinese-7-1/pdf`, {
    headers: { Range: "bytes=0-31" },
  });
  const content = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(downloaded.status, 206);
  assert.deepEqual(content, pdf.subarray(0, 32));
});
