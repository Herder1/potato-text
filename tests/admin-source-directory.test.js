const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function harness(links = ["source-a"]) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: "book", hidden: false, disabled: false,
      textContent: "", innerHTML: "", listeners: {}, classList: { toggle() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; }, querySelectorAll: () => [] });
    return elements.get(selector);
  };
  const state = { questionLibraryTab: "library", questionWorkspaceMode: "families", selectedKnowledgeNodeId: "working",
    knowledgeStructure: { nodes: [{ id: "working" }] }, collapsedKnowledgeNodeIds: new Set() };
  const directories = { bookId: "book", questionNodes: [{ id: "working" }],
    dossierNodes: [{ id: "source-a", title: "来源甲", path: "来源甲" }, { id: "source-b", title: "来源乙", path: "来源乙" }],
    mappings: [{ questionNodeId: "working", dossierNodeIds: links }] };
  const context = vm.createContext({ window: {}, document: { querySelector: element }, Set, Map });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../apps/admin/library-workspace.js"), "utf8"), context);
  let questionLoads = 0, dossierLoads = 0;
  const workspace = context.window.LibraryWorkspace.create({ state, requestJson: async () => ({ directories }),
    escapeHtml: String, friendlyError: String, reload() {}, loadContent() { questionLoads++; }, loadDossiers() { dossierLoads++; } });
  await workspace.loadDirectories("book");
  function switchView(tab, mode = state.questionWorkspaceMode) {
    const previous = state.questionLibraryTab, previousMode = state.questionWorkspaceMode;
    state.questionLibraryTab = tab; state.questionWorkspaceMode = mode;
    workspace.switchDirectory(previous, tab, previousMode, mode);
    workspace.renderDirectoryHeader();
  }
  function clickSource(id) {
    element("#knowledge-tree").listeners.click({ target: { closest: selector => selector === "[data-dossier-node]" ? { dataset: { dossierNode: id } } : null }, preventDefault() {} });
  }
  return { state, workspace, directories, element, switchView, clickSource, loads: () => ({ questionLoads, dossierLoads }) };
}

test("question list and dossiers share source selection while families retain their separate tree", async () => {
  const h = await harness();
  h.switchView("library", "questions");
  assert.equal(h.workspace.dossierNodeId(), "source-a");
  assert.equal(h.workspace.usesSourceDirectory(), true);
  assert.equal(h.element("#toggle-knowledge-tree-edit").hidden, true);
  h.switchView("dossiers");
  assert.equal(h.workspace.dossierNodeId(), "source-a");
  h.switchView("library");
  assert.equal(h.workspace.dossierNodeId(), "source-a");
  h.switchView("library", "families");
  assert.equal(h.state.selectedKnowledgeNodeId, "working");
  assert.equal(h.workspace.usesSourceDirectory(), false);
  assert.equal(h.element("#toggle-knowledge-tree-edit").hidden, false);
});

for (const links of [[], ["source-a", "source-b"]]) test(`mapping ${JSON.stringify(links)} requires explicit selection, not an unrestricted list`, async () => {
  const h = await harness(links);
  h.switchView("library", "questions");
  assert.equal(h.workspace.dossierNodeId(), "");
  assert.equal(h.workspace.needsDirectorySelection(), true);
  assert.equal(h.element("#directory-navigation-note").hidden, false);
  h.clickSource("source-b");
  assert.equal(h.workspace.needsDirectorySelection(), false);
  assert.equal(h.workspace.dossierNodeId(), "source-b");
  assert.deepEqual(h.loads(), { questionLoads: 1, dossierLoads: 0 });
});

test("unlocated question filter is not sent as a dossier node", async () => {
  const h = await harness();
  h.switchView("library", "questions");
  h.clickSource("__unlocated__");
  h.switchView("dossiers");
  assert.equal(h.workspace.dossierNodeId(), "");
  assert.equal(h.workspace.needsDossierSelection(), true);
  assert.match(h.element("#directory-navigation-note").textContent, /目录未定位是题目筛选/);
});

test("textbook change clears both source selection and mapping warnings", async () => {
  const h = await harness([]);
  h.switchView("library", "questions");
  h.element("#question-book-filter").value = "all";
  await h.workspace.loadDirectories("");
  assert.equal(h.workspace.dossierNodeId(), "");
  assert.equal(h.workspace.needsDirectorySelection(), false);
  assert.equal(h.element("#directory-navigation-note").hidden, true);
});
