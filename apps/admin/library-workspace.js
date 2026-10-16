(function (root) {
  "use strict";
  root.LibraryWorkspace = { create };
  function create({ state, requestJson, escapeHtml: escape, friendlyError, reload, loadDossiers, loadContent }) {
    const $ = (selector) => document.querySelector(selector);
    let directories = null;
    let loadSequence = 0;
    let sourceId = "";
    let sourceHighlights = [];
    let questionHighlights = [];
    let needsSourceSelection = false;
    let needsQuestionSelection = false;
    const collapsedSourceIds = new Set();
    let mappingNode = "";
    let mappingSource = "";
    let draftTargets = new Set();
    let dirty = false;
    let savingMapping = false;
    let previewRows = [];
    let selectedQuestionIds = null;
    let previewSequence = 0;
    let committing = false;
    const book = () => $("#question-book-filter").value;
    const usesSourceDirectory = (tab = state.questionLibraryTab, mode = state.questionWorkspaceMode) => tab === "dossiers" || (tab === "library" && mode === "questions");
    const reloadDirectoryContent = () => state.questionLibraryTab === "dossiers" ? loadDossiers() : loadContent();
    const errorText = (error) => ({
      completion_preview_stale: "预览后数据或映射发生变化，请重新预览。",
      completion_fingerprint_required: "选择题族前，请同时勾选缺失的指纹。",
      completion_selection_required: "请至少选择一项缺失内容。",
      completion_scope_too_large: "范围超过 5000 道，请按较小批次或勾选题目预览。",
      deterministic_rebuild_scope_required: "请先选择一本教材或一个导入批次。",
      completion_rollback_failed: "保存发生异常且恢复未完成，已停止继续补齐。请联系维护人员核查存档。",
      directory_mapping_stale: "目录或映射已发生变化，请关闭弹窗重新打开。",
      completion_postgres_transaction_required: "当前数据库模式尚不支持跨库确认，本次未写入。",
    }[error?.message] || friendlyError(error));
    const note = (text) => { $("#directory-navigation-note").textContent = text; $("#directory-navigation-note").hidden = !text; };
    async function loadDirectories(bookId, options = {}) {
      const sequence = ++loadSequence;
      if (!bookId || bookId === "all") { directories = null; sourceId = ""; sourceHighlights = []; questionHighlights = []; needsSourceSelection = false; needsQuestionSelection = false; collapsedSourceIds.clear(); note(""); return; }
      if (directories?.bookId !== bookId) { directories = null; sourceId = ""; sourceHighlights = []; questionHighlights = []; needsSourceSelection = false; needsQuestionSelection = false; collapsedSourceIds.clear(); note(""); }
      const payload = await requestJson(`/api/admin/knowledge-structure/directories?bookId=${encodeURIComponent(bookId)}`, options);
      if (sequence !== loadSequence || bookId !== book()) return;
      if (directories?.bookId !== bookId) { sourceId = ""; sourceHighlights = []; questionHighlights = []; needsSourceSelection = false; note(""); }
      directories = payload.directories;
      if (sourceId && sourceId !== "__unlocated__" && !directories.dossierNodes.some((node) => node.id === sourceId)) {
        sourceId = ""; needsSourceSelection = true;
        note("原来源目录节点已失效，请重新选择；题目归属未改动。");
      }
    }
    function linksForQuestion(id) { return directories?.mappings.find((link) => link.questionNodeId === id)?.dossierNodeIds || []; }
    function linksForSource(id) { return (directories?.mappings || []).filter((link) => link.dossierNodeIds.includes(id)).map((link) => link.questionNodeId); }
    function switchDirectory(previous, next, previousMode = state.questionWorkspaceMode, nextMode = state.questionWorkspaceMode) {
      const fromSource = usesSourceDirectory(previous, previousMode);
      const toSource = usesSourceDirectory(next, nextMode);
      if (!["library", "dossiers"].includes(previous) || !["library", "dossiers"].includes(next)) return;
      if (fromSource === toSource) {
        if (next === "dossiers" && sourceId === "__unlocated__") {
          sourceId = ""; needsSourceSelection = true;
          note("目录未定位是题目筛选，请选择要查看的知识档案节点。");
        }
        return;
      }
      if (toSource) {
        if (needsQuestionSelection) { needsQuestionSelection = false; note(""); return; }
        sourceHighlights = linksForQuestion(state.selectedKnowledgeNodeId);
        sourceId = sourceHighlights.length === 1 ? sourceHighlights[0] : "";
        needsSourceSelection = Boolean(state.selectedKnowledgeNodeId && !sourceId);
        note(needsSourceSelection ? (sourceHighlights.length ? "对应多个知识档案节点，已高亮，请选择一个。" : "当前题库节点未设置映射，请选择档案节点或编辑映射。") : "");
        const byId = new Map((directories?.dossierNodes || []).map(node => [node.id, node]));
        for (const id of sourceHighlights) {
          const seen = new Set(); let node = byId.get(id);
          while (node && !seen.has(node.id)) { seen.add(node.id); collapsedSourceIds.delete(node.id); node = byId.get(node.parentId); }
        }
      } else {
        if (needsSourceSelection) { needsSourceSelection = false; note(""); return; }
        questionHighlights = linksForSource(sourceId);
        state.selectedKnowledgeNodeId = questionHighlights.length === 1 ? questionHighlights[0] : "";
        needsQuestionSelection = Boolean(sourceId && questionHighlights.length !== 1);
        note(sourceId && questionHighlights.length !== 1 ? (questionHighlights.length ? "对应多个题库节点，已高亮，请选择一个。" : "此档案节点尚未对应题库节点。") : "");
        const byId = new Map((state.knowledgeStructure?.nodes || []).map((node) => [node.id, node]));
        questionHighlights.forEach((id) => {
          const seen = new Set();
          let node = byId.get(id);
          while (node && !seen.has(node.id)) { seen.add(node.id); state.collapsedKnowledgeNodeIds.delete(node.id); node = byId.get(node.parentId); }
        });
      }
    }
    function treeRows(nodes, renderRow, query = "", rememberCollapse = false) {
      if (query) {
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const keep = new Set();
        nodes.filter((node) => `${node.path} ${node.title} ${node.displayTitle}`.toLowerCase().includes(query)).forEach((node) => {
          while (node && !keep.has(node.id)) { keep.add(node.id); node = byId.get(node.parentId); }
        });
        nodes = nodes.filter((node) => keep.has(node.id));
      }
      const children = new Map();
      nodes.forEach((node) => { const siblings = children.get(node.parentId || "") || []; siblings.push(node); children.set(node.parentId || "", siblings); });
      const seen = new Set();
      const walk = (parent, depth) => (children.get(parent) || []).map((node) => {
        if (seen.has(node.id)) return "";
        seen.add(node.id);
        const nested = walk(node.id, depth + 1);
        return nested ? `<details ${rememberCollapse && collapsedSourceIds.has(node.id) ? "" : "open"} ${rememberCollapse ? `data-source-branch="${escape(node.id)}"` : ""} class="directory-branch"><summary>${renderRow(node, depth)}</summary>${nested}</details>` : `<div class="directory-leaf">${renderRow(node, depth)}</div>`;
      }).join("");
      return walk("", 0) || `<p class="directory-empty">${query ? "没有匹配节点" : "尚无目录节点"}</p>`;
    }
    function renderDirectoryHeader() {
      const dossier = usesSourceDirectory();
      const concreteBook = Boolean(book() && book() !== "all");
      $("#library-directory-title").textContent = dossier ? "知识档案目录" : "题库目录";
      for (const id of ["toggle-knowledge-tree-edit", "knowledge-structure-backups", "generate-knowledge-structure"]) {
        $("#" + id).hidden = dossier;
        $("#" + id).disabled = !concreteBook;
      }
      if (!concreteBook || dossier) state.knowledgeTreeEditMode = false;
      $("#add-knowledge-node").hidden = dossier || !state.knowledgeTreeEditMode;
      $("#edit-directory-mapping").disabled = directories?.bookId !== book() || !directories?.questionNodes?.length || !directories?.dossierNodes?.length;
      $("#knowledge-tree").classList.toggle("is-editing", !dossier && state.knowledgeTreeEditMode);
    }
    function renderDossierTree() {
      const nodes = directories?.bookId === book() ? directories.dossierNodes : [];
      if (!book() || book() === "all") {
        $("#knowledge-tree-summary").textContent = "全部教材";
        renderBookChoices();
        return;
      }
      const questions = state.questionLibraryTab === "library" && state.questionWorkspaceMode === "questions";
      const candidate = questions ? state.questionSourceTreeSummary : state.knowledgeDossierTreeSummary;
      const summary = candidate?.bookId === book() ? candidate : null;
      const counts = (questions ? summary?.nodeQuestionCounts : summary?.nodeDossierCounts) || {};
      $("#knowledge-tree-summary").textContent = questions
        ? (summary ? `${nodes.length} 个来源节点 · 当前筛选 ${summary.questionCount} 道题 · 已定位 ${summary.locatedQuestionCount} 道` : `${nodes.length} 个来源节点 · ${state.questionSourceTreeError || (needsSourceSelection ? "请选择映射节点" : "正在读取题数")}`)
        : `${nodes.length} 个来源节点 · ${summary ? `${summary.dossierCount} 份档案` : "正在读取档案数"}`;
      const count = questions ? summary?.questionCount : summary?.dossierCount;
      $("#knowledge-tree").innerHTML = `<button type="button" class="knowledge-tree-all ${!sourceId && !needsSourceSelection ? "is-active" : ""}" data-dossier-node=""><span>全部目录</span>${count == null ? "" : `<small>${Number(count)}</small>`}</button>`
        + (questions ? `<button type="button" class="knowledge-tree-all ${sourceId === "__unlocated__" ? "is-active" : ""}" data-dossier-node="__unlocated__" title="缺少教材目录或不能唯一匹配；与没有题族归属的未归档不同"><span>目录未定位</span>${summary ? `<small>${summary.unlocatedQuestionCount}</small>` : ""}</button>` : "")
        + treeRows(nodes, (node) => `<button type="button" class="directory-node ${sourceId === node.id ? "is-active" : ""} ${sourceHighlights.includes(node.id) ? "is-mapped" : ""}" data-dossier-node="${escape(node.id)}" title="${escape(node.path)}"><span>${escape(node.orderPath?.join(".") || "")} ${escape(node.displayTitle || node.title)}</span><small>${summary ? Number(counts[node.id] || 0) : ""}</small></button>`, "", true);
    }
    function markQuestionMatches() {
      $("#knowledge-tree").querySelectorAll("[data-knowledge-node-id]").forEach((node) => node.classList.toggle("is-mapped", questionHighlights.includes(node.dataset.knowledgeNodeId)));
    }
    function renderBookChoices() {
      const subjectId = $("#question-subject-filter").value || "all";
      const books = (state.questionCatalog?.books || []).filter(item => subjectId === "all" || item.subjectId === subjectId);
      $("#knowledge-tree").innerHTML = books.map(item => `<button type="button" class="knowledge-tree-all" data-directory-book="${escape(item.id)}" title="查看此教材目录"><span>${escape(item.title)}${item.volume ? ` · ${escape(item.volume)}` : ""}</span></button>`).join("");
    }
    $("#knowledge-tree").addEventListener("click", (event) => {
      const bookButton = event.target.closest("[data-directory-book]");
      if (bookButton) {
        $("#question-book-filter").value = bookButton.dataset.directoryBook;
        $("#question-book-filter").dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      if (event.target.closest("[data-knowledge-node-id]")) { questionHighlights = []; needsQuestionSelection = false; note(""); }
      const button = event.target.closest("[data-dossier-node]");
      if (!button) return;
      event.preventDefault();
      sourceId = button.dataset.dossierNode;
      needsSourceSelection = false;
      sourceHighlights = sourceId ? [sourceId] : [];
      note("");
      renderDossierTree();
      reloadDirectoryContent();
    });
    $("#knowledge-tree").addEventListener("toggle", event => {
      const branch = event.target;
      if (!branch.dataset?.sourceBranch || !branch.isConnected) return;
      if (branch.open) collapsedSourceIds.delete(branch.dataset.sourceBranch);
      else collapsedSourceIds.add(branch.dataset.sourceBranch);
    }, true);
    function renderMapping() {
      const query = $("#directory-mapping-search").value.trim().toLowerCase();
      $("#directory-mapping-question").innerHTML = treeRows(directories.questionNodes, (node) => `<button type="button" class="directory-node ${node.id === mappingNode ? "is-active" : ""} ${linksForSource(mappingSource).includes(node.id) ? "is-mapped" : ""}" data-mapping-question="${escape(node.id)}"><span>${escape(node.orderPath?.join(".") || "")} ${escape(node.displayTitle || node.title)}</span><small>${linksForQuestion(node.id).length || ""}</small></button>`, query);
      $("#directory-mapping-source").innerHTML = treeRows(directories.dossierNodes, (node) => `<div class="directory-mapping-row ${draftTargets.has(node.id) ? "is-mapped" : ""}"><input type="checkbox" aria-label="对应 ${escape(node.displayTitle || node.title)}" data-mapping-target="${escape(node.id)}" ${draftTargets.has(node.id) ? "checked" : ""} ${!mappingNode || savingMapping ? "disabled" : ""}/><button type="button" class="directory-node ${mappingSource === node.id ? "is-active" : ""}" data-mapping-source="${escape(node.id)}">${escape(node.orderPath?.join(".") || "")} ${escape(node.displayTitle || node.title)}</button></div>`, query);
      const selected = directories.questionNodes.find((node) => node.id === mappingNode);
      $("#directory-mapping-selection").textContent = selected ? `${selected.path || selected.displayTitle} → ${draftTargets.size} 个档案节点` : "选择左侧题库节点";
      $("#save-directory-mapping").disabled = savingMapping || !dirty || !mappingNode;
    }
    async function openMapping() {
      const dialog = $("#directory-mapping-dialog");
      $("#directory-mapping-status").textContent = "正在读取…";
      $("#directory-mapping-question").replaceChildren();
      $("#directory-mapping-source").replaceChildren();
      $("#save-directory-mapping").disabled = true;
      if (!dialog.open) dialog.showModal();
      try {
        await loadDirectories(book());
        if (!dialog.open || !directories) return;
        mappingNode = state.selectedKnowledgeNodeId || directories.questionNodes[0]?.id || "";
        mappingSource = "";
        draftTargets = new Set(linksForQuestion(mappingNode)); dirty = false;
        $("#directory-mapping-search").value = "";
        $("#directory-mapping-status").textContent = directories.invalidSourceIds.length || directories.mappings.some((link) => link.invalidTargetIds.length)
          ? "存在失效映射，请核对后保存；题目与指纹未改动。" : "";
        renderMapping();
      } catch (error) { $("#directory-mapping-status").textContent = errorText(error); }
    }
    $("#edit-directory-mapping").addEventListener("click", openMapping);
    $("#directory-mapping-question").addEventListener("click", (event) => {
      const button = event.target.closest("[data-mapping-question]");
      if (!button || savingMapping) return;
      event.preventDefault();
      if (dirty && button.dataset.mappingQuestion !== mappingNode) { $("#directory-mapping-status").textContent = "请先保存或撤销当前节点的改动。"; return; }
      mappingNode = button.dataset.mappingQuestion; mappingSource = "";
      draftTargets = new Set(linksForQuestion(mappingNode)); renderMapping();
    });
    $("#directory-mapping-source").addEventListener("click", (event) => {
      const button = event.target.closest("[data-mapping-source]");
      if (!button || savingMapping) return;
      event.preventDefault(); mappingSource = button.dataset.mappingSource; renderMapping();
    });
    $("#directory-mapping-source").addEventListener("change", (event) => {
      const input = event.target.closest("[data-mapping-target]");
      if (!input || savingMapping) return;
      if (input.checked) draftTargets.add(input.dataset.mappingTarget); else draftTargets.delete(input.dataset.mappingTarget);
      dirty = true; renderMapping();
    });
    $("#directory-mapping-search").addEventListener("input", () => { if (directories) renderMapping(); });
    $("#reset-directory-mapping").addEventListener("click", () => { if (savingMapping) return; draftTargets = new Set(linksForQuestion(mappingNode)); dirty = false; $("#directory-mapping-status").textContent = ""; renderMapping(); });
    $("#save-directory-mapping").addEventListener("click", async () => {
      if (savingMapping || !dirty) return;
      savingMapping = true; renderMapping();
      try {
        const payload = await requestJson("/api/admin/knowledge-structure/directory-mapping", { method: "PUT", body: JSON.stringify({ bookId: directories.bookId, questionNodeId: mappingNode, dossierNodeIds: [...draftTargets], revision: directories.revision }) });
        directories = payload.directories; dirty = false;
        $("#directory-mapping-status").textContent = "映射已保存。题目、指纹及题族归属保持不变。";
        if (usesSourceDirectory() && needsSourceSelection && mappingNode === state.selectedKnowledgeNodeId) {
          switchDirectory("library", state.questionLibraryTab, "families", state.questionWorkspaceMode); renderDossierTree(); await reloadDirectoryContent();
        } else if (!usesSourceDirectory() && needsQuestionSelection) {
          switchDirectory("dossiers", "library", "questions", "families"); await reloadDirectoryContent();
        }
      } catch (error) { $("#directory-mapping-status").textContent = errorText(error); }
      finally { savingMapping = false; renderMapping(); }
    });
    function canCloseMapping() {
      if (savingMapping) return false;
      return !dirty || window.confirm("放弃未保存的映射改动？");
    }
    $("#close-directory-mapping").addEventListener("click", () => { if (canCloseMapping()) $("#directory-mapping-dialog").close(); });
    $("#directory-mapping-dialog").addEventListener("cancel", (event) => { if (!canCloseMapping()) event.preventDefault(); });

    function clearPreview() { ++previewSequence; previewRows = []; $("#completion-rows").replaceChildren(); $("#confirm-completion").disabled = true; $("#completion-select-all").checked = false; }
    function renderPreview() {
      $("#completion-rows").innerHTML = previewRows.map((row, index) => `<tr data-completion-index="${index}"><td><strong>${escape(row.stem)}</strong>${row.issues.map((issue) => `<small class="completion-issue">${escape(issue)}</small>`).join("")}</td><td>${row.hasFingerprint ? "已有，保留" : row.fingerprint ? `<label><input type="checkbox" data-completion-fingerprint="${index}"/> ${escape(row.fingerprint.knowledgePath)}</label>` : "暂无可靠建议"}</td><td>${row.hasFamily ? "已有，保留" : row.family ? `<select aria-label="题族建议" data-completion-family="${index}"><option value="">暂不处理</option>${row.family.candidates.map((family) => `<option value="${escape(family.id)}">加入已有：${escape(family.name)}（${family.memberCount}题）</option>`).join("")}${row.family.draft ? `<option value="new">新建候选：${escape(row.family.draft.name)}</option>` : ""}</select>` : "暂无可靠建议"}</td></tr>`).join("") || '<tr><td colspan="3">当前范围没有题目</td></tr>';
      $("#completion-status").textContent = `共 ${previewRows.length} 道；已有指纹和归属均保留。仅所选缺失项会写入，新增题族及成员仍需审核。`;
    }
    function selections() {
      return previewRows.flatMap((row, index) => {
        const fingerprint = $(`[data-completion-fingerprint="${index}"]`)?.checked === true;
        const familyId = $(`[data-completion-family="${index}"]`)?.value || "";
        return fingerprint || familyId ? [{ questionId: row.questionId, token: row.token, fingerprint, familyId }] : [];
      });
    }
    function syncCompletionButton() { $("#confirm-completion").disabled = committing || !selections().length; }
    async function previewCompletion() {
      if (committing) return;
      clearPreview(); const sequence = previewSequence;
      $("#completion-status").textContent = "正在检查缺失项，不会改动数据…";
      $("#preview-completion").disabled = true;
      try {
        const scope = selectedQuestionIds ? { questionIds: selectedQuestionIds } : $("#completion-scope").value === "book"
          ? { bookId: $("#completion-book").value } : { importBatchId: $("#completion-batch").value };
        const payload = await requestJson("/api/admin/question-enrichment/completion-preview", { method: "POST", body: JSON.stringify(scope) });
        if (sequence !== previewSequence || !$("#completion-dialog").open) return;
        previewRows = payload.rows || []; renderPreview();
      } catch (error) { if (sequence === previewSequence) $("#completion-status").textContent = errorText(error); }
      finally { if (sequence === previewSequence) $("#preview-completion").disabled = false; }
    }
    function openCompletion(ids = null, initialBook = "") {
      if (committing) return;
      selectedQuestionIds = ids;
      clearPreview();
      $("#completion-status").textContent = ids ? `已选 ${ids.length} 道题` : "选择范围后预览缺失项。";
      $("#completion-scope-row").hidden = Boolean(ids);
      $("#completion-book").innerHTML = $("#question-book-filter").innerHTML;
      $("#completion-book").querySelector('option[value="all"]')?.remove();
      // 2026-10-12：完善题目的批次筛选已改成勾选式下拉（不是 <select>），批次候选只从导入面板取。
      const batches = $("#question-import-batch-filter");
      $("#completion-batch").innerHTML = batches.innerHTML;
      $("#completion-batch").querySelector('option[value="all"]')?.remove();
      $("#completion-book").querySelector('option[value="__unassigned__"]')?.remove();
      // 沿用"完善题目里正筛着哪本教材"作默认：勾选式下拉的值从 filterSelectValues 读（可多选，取第一本）。
      const enrichmentBooks = typeof filterSelectValues === "function" ? filterSelectValues("question-enrichment-book") : [];
      const preferred = [initialBook, enrichmentBooks[0], book()].find((value) => value && value !== "all" && value !== "__unassigned__");
      if ([...$("#completion-book").options].some((option) => option.value === preferred)) $("#completion-book").value = preferred;
      $("#completion-scope").value = "book"; syncScope();
      $("#preview-completion").disabled = false;
      if (!$("#completion-dialog").open) $("#completion-dialog").showModal();
      if (ids) previewCompletion();
    }
    function syncScope() {
      $("#completion-book-field").hidden = $("#completion-scope").value !== "book";
      $("#completion-batch-field").hidden = $("#completion-scope").value !== "batch";
    }
    $("#completion-scope-row").addEventListener("change", () => { clearPreview(); syncScope(); $("#preview-completion").disabled = false; $("#completion-status").textContent = "范围已变更，请重新预览。"; });
    $("#preview-completion").addEventListener("click", previewCompletion);
    $("#completion-rows").addEventListener("change", syncCompletionButton);
    $("#completion-select-all").addEventListener("change", (event) => {
      $("#completion-rows").querySelectorAll("input[type=checkbox]").forEach((input) => { input.checked = event.target.checked; });
      $("#completion-rows").querySelectorAll("select").forEach((select) => { select.selectedIndex = event.target.checked && select.options.length === 2 ? 1 : 0; });
      syncCompletionButton();
    });
    $("#confirm-completion").addEventListener("click", async () => {
      if (committing) return;
      const items = selections(); if (!items.length) return;
      committing = true; syncCompletionButton();
      $("#completion-dialog").querySelectorAll("input,select,button").forEach((element) => { element.disabled = true; });
      try {
        const result = await requestJson("/api/admin/question-enrichment/completion-commit", { method: "POST", body: JSON.stringify({ items }) });
        clearPreview();
        $("#completion-status").textContent = `已补指纹 ${result.fingerprintsAdded} 道、归族 ${result.membershipsAdded} 道，新建候选族 ${result.familiesCreated} 个。已有内容未覆盖。`;
        await reload();
      } catch (error) { $("#completion-status").textContent = errorText(error); }
      finally {
        committing = false;
        $("#completion-dialog").querySelectorAll("input,select,button").forEach((element) => { element.disabled = false; });
        syncCompletionButton();
      }
    });
    $("#close-completion").addEventListener("click", () => { if (!committing) { clearPreview(); $("#completion-dialog").close(); } });
    $("#completion-dialog").addEventListener("cancel", (event) => { if (committing) event.preventDefault(); else clearPreview(); });
    return { loadDirectories, switchDirectory, usesSourceDirectory, renderDirectoryHeader, renderDossierTree, renderBookChoices, markQuestionMatches, openMapping, openCompletion,
      needsDirectorySelection: () => usesSourceDirectory() ? needsSourceSelection : needsQuestionSelection,
      dossierNodeId: () => sourceId, needsDossierSelection: () => needsSourceSelection,
      dossierNode: () => directories?.dossierNodes.find((node) => node.id === sourceId) };
  }
})(window);
