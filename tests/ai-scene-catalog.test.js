const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer, adminOverview } = require("./helpers/admin-auth");
const {
  createMemoryAiConfigStore,
  effectiveSceneLabel,
  normalizeConfig,
  sceneCategoryDefinitions,
  sceneDefinitions,
  updateSceneLabel,
} = require("../apps/api/src/ai-config");

const root = path.resolve(__dirname, "..");

test("every AI scene belongs to a declared display category", () => {
  const categoryIds = new Set(sceneCategoryDefinitions.map((category) => category.id));
  assert.equal(sceneDefinitions.length, 22);
  assert.equal(sceneDefinitions.every((scene) => categoryIds.has(scene.category)), true);
  // 分组只是展示属性，不得渗进路由或提示词这类功能数据。
  const config = normalizeConfig({});
  assert.equal(Object.values(config.routes).every((route) => !("category" in route)), true);
  assert.equal(Object.values(config.prompts).every((prompt) => !("category" in prompt)), true);
});

test("provider connection testing is a real configurable scene route", () => {
  const config = normalizeConfig({});
  const scene = sceneDefinitions.find((item) => item.id === "provider_connection_test");
  assert.equal(scene.category, "system");
  assert.deepEqual(scene.variables, ["providerName", "model"]);
  // 默认值与改造前的写死调用一致，未配置时测试行为不变。
  assert.deepEqual(config.routes.provider_connection_test, {
    mode: "disabled",
    providerId: "",
    model: "",
    temperature: 0,
    maxTokens: 32,
  });
  assert.equal(config.prompts.provider_connection_test.systemPrompt, "你是接口连通性测试助手。");
  assert.equal(config.prompts.provider_connection_test.userPromptTemplate, "只回复：连接成功");
  // 场景注册后任务日志直接取场景名，不再依赖运行时 override。
  assert.equal(effectiveSceneLabel(config, "provider_connection_test"), "供应商连通性测试");
});

test("scene display names are overridable without touching ids, routes or prompts", () => {
  const base = normalizeConfig({});
  const renamed = updateSceneLabel(base, "semantic_dedup", { label: "  重复题筛查  " });
  assert.equal(renamed.sceneLabels.semantic_dedup, "重复题筛查");
  assert.equal(effectiveSceneLabel(renamed, "semantic_dedup"), "重复题筛查");
  assert.deepEqual(renamed.routes.semantic_dedup, base.routes.semantic_dedup);
  assert.deepEqual(renamed.prompts.semantic_dedup, base.prompts.semantic_dedup);
  // 传回默认名或空值都等于恢复系统默认名，覆盖项会被删除而不是固化进配置。
  assert.deepEqual(updateSceneLabel(renamed, "semantic_dedup", { label: "语义查重" }).sceneLabels, {});
  assert.deepEqual(updateSceneLabel(renamed, "semantic_dedup", { label: "" }).sceneLabels, {});
});

test("scene label overrides ignore unknown scenes and reject unknown scene ids", () => {
  const config = normalizeConfig({
    sceneLabels: { semantic_dedup: "查重", not_a_scene: "不存在", subjective_scoring: "主观题评分" },
  });
  assert.deepEqual(config.sceneLabels, { semantic_dedup: "查重" });
  assert.throws(() => updateSceneLabel(config, "not_a_scene", { label: "x" }), /unsupported_ai_scene/);
  // 未注册的场景没有默认名，交由调用方回退到自己的标签。
  assert.equal(effectiveSceneLabel(config, "legacy_removed_scene"), "");
  assert.equal(effectiveSceneLabel(config, "semantic_dedup"), "查重");
});

test("admin overview and scene list use the customized display name", () => {
  const config = updateSceneLabel(normalizeConfig({}), "textbook_ocr", { label: "扫描版目录识别" });
  const overview = adminOverview(config);
  const route = overview.aiRoutes.find((item) => item.scene === "扫描版目录识别");
  assert.ok(route);
  assert.equal(overview.aiRoutes.some((item) => item.scene === "教材扫描页 OCR"), false);
});

test("admin can rename a scene label over the API while the scene id stays the route key", async (context) => {
  const aiConfigStore = createMemoryAiConfigStore();
  const server = createServer({ aiConfigStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const saved = await fetch(`http://127.0.0.1:${port}/api/admin/ai/scenes/textbook_ocr/label`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "扫描版目录识别" }),
  }).then((response) => response.json());
  assert.equal(saved.success, true);
  assert.equal(saved.scene.id, "textbook_ocr");
  assert.equal(saved.scene.label, "扫描版目录识别");
  assert.equal(saved.scene.defaultLabel, "教材扫描页 OCR");
  assert.equal(saved.scene.category, "textbook");

  const config = await fetch(`http://127.0.0.1:${port}/api/admin/ai-config`).then((response) => response.json());
  assert.equal(config.sceneDefinitions.length, 22);
  assert.equal(config.sceneDefinitions.find((scene) => scene.id === "textbook_ocr").label, "扫描版目录识别");
  assert.equal(config.sceneCategories.some((category) => category.id === "textbook"), true);
  // 路由与提示词仍以 scene.id 为键，改名不影响任何运行时解析。
  assert.equal(config.routes.textbook_ocr.mode, "disabled");
  assert.equal(typeof config.prompts.textbook_ocr.version, "number");

  const unknown = await fetch(`http://127.0.0.1:${port}/api/admin/ai/scenes/not_a_scene/label`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "x" }),
  });
  assert.equal(unknown.status, 400);

  const restored = await fetch(`http://127.0.0.1:${port}/api/admin/ai/scenes/textbook_ocr/label`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "" }),
  }).then((response) => response.json());
  assert.equal(restored.success, true);
  assert.equal(restored.scene.label, "教材扫描页 OCR");
});

test("admin scene route list is grouped, collapsible and offers a safe rename entry", () => {
  const html = fs.readFileSync(path.join(root, "apps/admin/index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "apps/admin/app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "apps/admin/styles.css"), "utf8");

  assert.match(script, /function sceneRouteGroups\(\)/);
  assert.match(script, /state\.aiConfig\.sceneCategories/);
  assert.match(script, /<details class="scene-route-group"/);
  assert.match(script, /state\.collapsedSceneGroups/);
  assert.match(script, /shukao\.admin\.sceneRouteCollapsedGroups/);
  assert.match(script, /data-scene-action="rename"/);
  assert.match(script, /\/api\/admin\/ai\/scenes\/\$\{encodeURIComponent\(sceneId\)\}\/label/);
  assert.match(script, /function taskSceneLabel\(/);
  assert.match(script, /function providerTestTarget\(/);
  assert.match(script, /routes\.provider_connection_test/);
  assert.match(html, /id="scene-route-list"/);
  assert.match(html, /id="expand-scene-groups"/);
  assert.match(html, /id="collapse-scene-groups"/);
  assert.match(html, /id="scene-label-dialog"/);
  assert.match(html, /id="scene-label-input"/);
  assert.match(styles, /\.scene-route-group-head/);
  assert.match(styles, /\.scene-route-renamed/);
});
