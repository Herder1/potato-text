(function () {
  const BASE = "/api/admin/knowledge-classification/assessment-modes";
  const statusNames = { trial: "试行", active: "已启用", inactive: "已停用" };
  const errors = {
    assessment_mode_version_conflict: "考法标准已变化，请刷新后重新核对。",
    assessment_mode_assignment_changed: "其他管理员已修改本题考法，请刷新后重新核对。",
    assessment_mode_question_changed: "题目已产生新版本，请重新打开题目。",
    assessment_mode_selection_out_of_scope: "已选考法中有停用或超出当前科目、题型范围的条目，请核对后移除。",
    assessment_mode_no_options: "当前科目、题型尚无可用考法标准。",
    assessment_mode_route_unavailable: "尚未配置题目完善的 AI 路由。",
    assessment_mode_ai_output_invalid: "AI 返回的考法或理由不符合标准，本次未采用。",
    assessment_mode_required: "请填写名称、定义，并选择适用题型。",
    assessment_mode_duplicate: "此范围内已有同名考法。",
    assessment_mode_scope_invalid: "请选择有效科目、题型和状态。",
    assessment_mode_text_invalid: "文本格式或长度不符合要求。",
    assessment_mode_selection_invalid: "考法选择格式不正确，请刷新后重试。",
  };

  function create({ request, escapeHtml: esc, getCatalog, openQuestion, questionState, setBusy, friendlyError, setStandardsView }) {
    const $ = (selector) => document.querySelector(selector);
    const picker = $("#question-assessment-modes");
    const panel = $("#assessment-mode-standards");
    let catalog, standards = [], editing = null, dialog, formBaseline = "";
    let question = null, current = null, selected = new Map(), dirty = false, busy = false, operation = "", sequence = 0;
    const expandedModes = new Set();
    let standardSequence = 0, managerSequence = 0;
    const message = (error) => errors[error.message] || friendlyError(error);
    const scopeLabel = (mode) => `${catalog?.subjects.find((s) => s.id === mode.subjectId)?.name || mode.subjectId} · ${mode.questionTypes.map((id) => catalog?.questionTypes.find((t) => t.id === id)?.label || id).join("、")}`;
    const option = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
    const note = (value) => { picker.querySelector("[data-mode-note]").textContent = value; };
    const qUrl = () => `/api/admin/questions/${encodeURIComponent(question.id)}/assessment-modes`;

    picker.innerHTML = `
      <span>考法（选填）</span>
      <div class="assessment-mode-control-row">
        <details class="assessment-mode-picker">
          <summary data-mode-summary>未标注</summary>
          <input type="search" data-mode-search placeholder="搜索考法" aria-label="搜索考法" autocomplete="off" />
          <div class="assessment-mode-options" data-mode-options></div>
        </details>
        <div class="assessment-mode-actions">
          <button type="button" class="secondary-action" data-mode-ai>AI 建议</button>
          <button type="button" class="secondary-action" data-mode-reset>恢复</button>
          <button type="button" class="primary-action" data-mode-save>确认考法</button>
        </div>
      </div>
      <div class="assessment-mode-selected" data-mode-selected></div>
      <p class="assessment-mode-note" data-mode-note role="status" aria-live="polite"></p>
      <div class="assessment-mode-suggestion" data-mode-suggestion hidden></div>
      <details class="assessment-mode-legacy" data-mode-legacy hidden><summary>历史考查动作</summary><p data-mode-legacy-text></p></details>`;

    panel.innerHTML = `
      <div class="assessment-mode-toolbar">
        <label>科目<select data-mode-subject aria-label="考法标准科目"></select></label>
        <label>题型<select data-mode-type aria-label="考法标准题型"></select></label>
        <label>状态<select data-mode-status aria-label="考法标准状态">${option("all", "全部状态")}${Object.entries(statusNames).map(([id, name]) => option(id, name)).join("")}</select></label>
        <input type="search" data-mode-query placeholder="搜索名称、定义或边界" aria-label="搜索考法标准" />
        <button type="button" class="primary-action" data-mode-new>新建考法</button>
        <button type="button" class="secondary-action" data-mode-refresh>刷新</button>
      </div>
      <p data-mode-manager-note role="status" aria-live="polite"></p>
      <div class="table-wrap"><table class="assessment-mode-table"><thead><tr><th>考法</th><th>定义与边界</th><th>适用范围</th><th>状态</th><th>操作</th></tr></thead><tbody data-mode-table></tbody></table></div>`;

    function renderOptions() {
      const focusedId = document.activeElement?.dataset?.modeId;
      const focusedHelpId = document.activeElement?.dataset?.modeHelp;
      const optionsContainer = picker.querySelector("[data-mode-options]");
      const scrollTop = optionsContainer.scrollTop;
      const query = picker.querySelector("[data-mode-search]").value.trim();
      const options = (current?.options || []).filter((mode) => [mode.name, mode.definition, mode.code].join(" ").includes(query));
      optionsContainer.innerHTML = options.length ? options.map((mode) => `
        <div class="assessment-mode-option">
          <div class="assessment-mode-option-heading">
            <label><input type="checkbox" data-mode-id="${esc(mode.id)}" ${selected.has(mode.id) ? "checked" : ""} ${busy ? "disabled" : ""} />
              <span>${esc(mode.name)} <small>${esc(statusNames[mode.status])}</small></span></label>
            <button type="button" class="assessment-mode-help" data-mode-help="${esc(mode.id)}" aria-expanded="${expandedModes.has(mode.id)}" aria-controls="assessment-mode-definition-${esc(mode.id)}" aria-label="${esc(mode.name)}：定义与例题">定义与例题</button>
          </div>
          <div class="assessment-mode-definition" id="assessment-mode-definition-${esc(mode.id)}" ${expandedModes.has(mode.id) ? "" : "hidden"}><p>${esc(mode.definition)}</p><p>纳入：${esc(mode.inclusion || "未补充")}</p><p>排除：${esc(mode.exclusion || "未补充")}</p><p>正例：${esc(mode.positiveExamples || "未补充")}</p><p>反例：${esc(mode.negativeExamples || "未补充")}</p><p>组合：${esc(mode.combination || "未补充")}</p></div>
        </div>`).join("") : '<p>没有匹配的考法</p>';
      optionsContainer.scrollTop = scrollTop;
      picker.querySelector("[data-mode-summary]").textContent = selected.size
        ? [...selected.values()].map((mode) => mode.name).join("、") : "选择考法";
      picker.querySelector("[data-mode-selected]").innerHTML = [...selected.values()].map((mode) => {
        const available = current?.options.some((row) => row.id === mode.id);
        return `<span class="assessment-mode-tag">${esc(mode.name)}${available ? "" : "（已停用或不适用）"}<button type="button" data-mode-remove="${esc(mode.id)}" title="移除此考法" aria-label="移除${esc(mode.name)}" ${busy ? "disabled" : ""}>×</button></span>`;
      }).join("");
      picker.querySelector("[data-mode-save]").disabled = busy || !current || questionState().contentDirty;
      const aiButton = picker.querySelector("[data-mode-ai]");
      aiButton.disabled = busy || !current?.options.length || questionState().contentDirty;
      aiButton.textContent = busy && operation === "suggest" ? "生成中…" : "AI 建议";
      aiButton.setAttribute("aria-busy", String(busy && operation === "suggest"));
      picker.querySelector("[data-mode-reset]").disabled = busy || !question;
      if (focusedId) [...picker.querySelectorAll("[data-mode-id]")].find((el) => el.dataset.modeId === focusedId)?.focus({ preventScroll: true });
      if (focusedHelpId) [...picker.querySelectorAll("[data-mode-help]")].find((el) => el.dataset.modeHelp === focusedHelpId)?.focus({ preventScroll: true });
    }

    async function loadQuestion(q) {
      const token = ++sequence;
      question = q;
      current = null;
      selected = new Map();
      expandedModes.clear();
      dirty = false;
      picker.querySelector("[data-mode-suggestion]").hidden = true;
      picker.querySelector("details").open = false;
      picker.querySelector("[data-mode-search]").value = "";
      const legacy = $("#question-fingerprint-action").value;
      picker.querySelector("[data-mode-legacy]").hidden = !legacy;
      picker.querySelector("[data-mode-legacy-text]").textContent = legacy;
      note(q ? "正在读取考法…" : "保存题目后可标注考法");
      renderOptions();
      if (!q) return;
      try {
        const result = await request(qUrl());
        if (sequence !== token) return;
        current = result;
        selected = new Map((result.assignment?.modes || []).map((mode) => [mode.id, result.options.find((row) => row.id === mode.id) || mode]));
        note(result.reviewReasons.length ? `待复核：${result.reviewReasons.join("；")}`
          : result.assignment?.modes.length ? `已确认 · ${result.assignment.confirmedBy}` : result.options.length ? "未标注" : "当前科目、题型尚无可用考法");
        renderOptions();
      } catch (error) {
        if (sequence === token) { note(`读取失败：${message(error)}`); renderOptions(); }
      }
    }

    async function perform(kind) {
      if (busy || questionState().busy || !current) return;
      if (questionState().contentDirty) { note("题目有未保存修改，请先保存题目内容。"); return; }
      const token = sequence;
      busy = true;
      operation = kind;
      setBusy(true);
      renderOptions();
      note(kind === "save" ? "正在保存…" : "正在生成建议…");
      try {
        if (kind === "save") {
          const result = await request(qUrl(), { method: "PUT", body: JSON.stringify({
            expectedQuestionVersion: current.questionVersion,
            expectedRevision: current.assignment?.revision || 0,
            modeIds: [...selected.keys()],
            modeVersions: Object.fromEntries([...selected.values()].map((mode) => [mode.id, mode.version])),
          }) });
          if (token !== sequence) return;
          current = result;
          dirty = false;
          picker.querySelector("[data-mode-suggestion]").hidden = true;
          picker.querySelector("details").open = false;
          note(selected.size ? "考法已确认" : "考法已清空");
        } else {
          const result = await request(`${qUrl()}/suggest`, { method: "POST", body: "{}" });
          if (token !== sequence) return;
          const box = picker.querySelector("[data-mode-suggestion]");
          box.hidden = false;
          box.innerHTML = `<strong>AI 建议 · 未确认</strong>${result.selections.map((row) => `<p><b>${esc(row.name)}</b>：${esc(row.reason)}</p>`).join("") || "<p>未找到适合的考法</p>"}${result.uncertainty ? `<p>待判断：${esc(result.uncertainty)}</p>` : ""}<button type="button" class="secondary-action" data-mode-use>填入待确认选择</button>`;
          box.querySelector("[data-mode-use]").onclick = () => {
            if (busy) return;
            selected = new Map(result.selections.map((row) => [row.id, row]));
            dirty = true;
            renderOptions();
            note("AI 建议已填入，尚未确认");
          };
          note("建议已生成，当前标注未改动");
        }
      } catch (error) {
        if (token === sequence) note(`未完成：${message(error)}`);
      } finally {
        busy = false;
        operation = "";
        setBusy(false);
        renderOptions();
      }
    }

    picker.addEventListener("input", (event) => {
      event.stopPropagation();
      if (event.target.matches("[data-mode-search]")) renderOptions();
    });
    picker.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.matches("[data-mode-search]")) event.preventDefault();
    });
    picker.addEventListener("change", (event) => {
      // Re-rendering removes the checkbox before parent form handlers run.
      event.stopPropagation();
      const id = event.target.dataset.modeId;
      if (!id || busy) return;
      if (event.target.checked) selected.set(id, current.options.find((mode) => mode.id === id));
      else selected.delete(id);
      dirty = true;
      renderOptions();
      note("考法有未确认修改");
    });
    picker.addEventListener("click", (event) => {
      const help = event.target.closest("[data-mode-help]");
      if (help) {
        const id = help.dataset.modeHelp;
        const expanded = !expandedModes.has(id);
        if (expanded) expandedModes.add(id);
        else expandedModes.delete(id);
        help.setAttribute("aria-expanded", String(expanded));
        document.getElementById(help.getAttribute("aria-controls")).hidden = !expanded;
        return;
      }
      const remove = event.target.closest("[data-mode-remove]");
      if (remove && !busy) { selected.delete(remove.dataset.modeRemove); dirty = true; renderOptions(); note("考法有未确认修改"); }
      if (event.target.closest("[data-mode-save]")) perform("save");
      if (event.target.closest("[data-mode-ai]")) perform("suggest");
      if (event.target.closest("[data-mode-reset]") && !busy && (!dirty || window.confirm("放弃未确认的考法修改并重新读取？"))) loadQuestion(question);
    });

    function renderTable() {
      const query = panel.querySelector("[data-mode-query]").value.trim();
      const subject = panel.querySelector("[data-mode-subject]").value;
      const type = panel.querySelector("[data-mode-type]").value;
      const status = panel.querySelector("[data-mode-status]").value;
      const rows = standards.filter((mode) => (subject === "all" || mode.subjectId === subject)
        && (type === "all" || mode.questionTypes.includes(type)) && (status === "all" || mode.status === status)
        && [mode.name, mode.definition, mode.inclusion, mode.exclusion].join(" ").includes(query));
      panel.querySelector("[data-mode-table]").innerHTML = rows.map((mode) => `<tr>
        <td><strong>${esc(mode.name)}</strong><small>${esc(mode.code || "")} · v${mode.version}</small></td>
        <td>${esc(mode.definition)}<small>${esc(mode.exclusion)}</small></td>
        <td>${esc(scopeLabel(mode))}</td><td>${esc(statusNames[mode.status])}</td>
        <td><button type="button" class="secondary-action" data-mode-edit="${esc(mode.id)}">编辑</button></td></tr>`).join("")
        || '<tr><td colspan="5">没有符合筛选条件的考法</td></tr>';
      panel.querySelector("[data-mode-manager-note]").textContent = `${rows.length} 项`;
    }

    async function loadStandards() {
      const token = ++managerSequence;
      panel.querySelector("[data-mode-manager-note]").textContent = "正在读取…";
      try {
        catalog = await getCatalog();
        if (token !== managerSequence) return;
        const sub = panel.querySelector("[data-mode-subject]");
        const type = panel.querySelector("[data-mode-type]");
        if (!sub.options.length) sub.innerHTML = option("all", "全部科目") + catalog.subjects.map((s) => option(s.id, s.name)).join("");
        if (!type.options.length) type.innerHTML = option("all", "全部题型") + catalog.questionTypes.map((t) => option(t.id, t.label)).join("");
        const result = await request(BASE);
        if (token !== managerSequence) return;
        standards = result.items;
        renderTable();
      } catch (error) {
        if (token === managerSequence) panel.querySelector("[data-mode-manager-note]").textContent = `读取失败：${message(error)}`;
      }
    }
    function tab(name) {
      $("#teaching-rule-legacy").hidden = name !== "experience";
      panel.hidden = name !== "modes";
      setStandardsView(name === "modes");
      document.querySelectorAll("[data-teaching-section]").forEach((button) => {
        button.setAttribute("aria-selected", String(button.dataset.teachingSection === name));
        button.tabIndex = button.dataset.teachingSection === name ? 0 : -1;
      });
      if (name === "modes") loadStandards();
    }
    document.querySelectorAll("[data-teaching-section]").forEach((button) => button.addEventListener("click", () => tab(button.dataset.teachingSection)));
    document.querySelector(".assessment-mode-tabs").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...document.querySelectorAll("[data-teaching-section]")];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : (index + 1) % 2;
      tab(buttons[next].dataset.teachingSection);
      buttons[next].focus();
    });
    panel.addEventListener("input", (event) => { if (event.target.matches("[data-mode-query]")) renderTable(); });
    panel.addEventListener("change", renderTable);
    panel.addEventListener("click", (event) => {
      const edit = event.target.closest("[data-mode-edit]");
      if (edit) openStandard(edit.dataset.modeEdit);
      if (event.target.closest("[data-mode-new]")) openStandard();
      if (event.target.closest("[data-mode-refresh]")) loadStandards();
    });

    function formValues() {
      const form = dialog.querySelector("form");
      return Object.fromEntries([...new FormData(form).entries()].filter(([key]) => key !== "questionTypes").concat([
        ["questionTypes", [...form.querySelectorAll('[name="questionTypes"]:checked')].map((el) => el.value)],
      ]));
    }
    function closeStandard() {
      if (dialog.querySelector('[type="submit"]').disabled) return;
      if (JSON.stringify(formValues()) !== formBaseline && !window.confirm("放弃尚未保存的标准修改？")) return;
      standardSequence++;
      dialog.close();
    }
    async function openStandard(id = "") {
      if (!catalog) catalog = await getCatalog();
      const token = ++standardSequence;
      editing = id ? standards.find((mode) => mode.id === id) : null;
      if (id && !editing) return;
      if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.id = "assessment-mode-dialog";
        dialog.className = "assessment-mode-dialog";
        document.body.append(dialog);
        dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeStandard(); });
      }
      const mode = editing || { name: "", subjectId: panel.querySelector("[data-mode-subject]").value !== "all" ? panel.querySelector("[data-mode-subject]").value : "ancient-literature", questionTypes: [], status: "trial" };
      dialog.innerHTML = `<form>
        <div class="section-head"><h2>${editing ? "编辑考法标准" : "新建考法标准"}</h2><button type="button" class="secondary-action" data-mode-close aria-label="关闭" title="关闭">×</button></div>
        <div class="assessment-mode-form-grid">
          <label class="field"><span>名称</span><input name="name" maxlength="80" required value="${esc(mode.name)}" /></label>
          <label class="field"><span>科目</span><select name="subjectId">${catalog.subjects.map((s) => option(s.id, s.name)).join("")}</select></label>
          <label class="field"><span>状态</span><select name="status">${Object.entries(statusNames).map(([id, name]) => option(id, name)).join("")}</select></label>
          <fieldset class="assessment-mode-type-list"><legend>适用题型</legend>${catalog.questionTypes.map((t) => `<label><input name="questionTypes" type="checkbox" value="${esc(t.id)}" ${mode.questionTypes.includes(t.id) ? "checked" : ""} />${esc(t.label)}</label>`).join("")}</fieldset>
          ${[["definition", "定义"], ["inclusion", "纳入边界"], ["exclusion", "排除边界"], ["positiveExamples", "正例"], ["negativeExamples", "反例"], ["combination", "组合说明"]].map(([key, label]) => `<label class="field"><span>${label}</span><textarea name="${key}" rows="3" maxlength="4000" ${key === "definition" ? "required" : ""}>${esc(mode[key] || "")}</textarea></label>`).join("")}
        </div>
        <section class="assessment-mode-impact"><h3>已引用题目</h3><div data-mode-impact>${editing ? "正在读取…" : "尚无引用"}</div></section>
        <details class="assessment-mode-history"><summary>修订历史（${mode.history?.length || 0}）</summary>${[...(mode.history || [])].reverse().map((old) => `<details><summary>v${old.version} · ${esc(statusNames[old.status])} · ${esc(old.updatedBy)}</summary><p>${esc(old.name)} · ${esc(scopeLabel(old))}</p>${[["definition", "定义"], ["inclusion", "纳入"], ["exclusion", "排除"], ["positiveExamples", "正例"], ["negativeExamples", "反例"], ["combination", "组合"]].map(([key, label]) => `<p>${label}：${esc(old[key] || "未填写")}</p>`).join("")}</details>`).join("")}</details>
        <p data-mode-dialog-note role="status" aria-live="polite">${esc(mode.provenance || "")}</p>
        <div class="assessment-mode-dialog-footer"><button type="button" class="secondary-action" data-mode-close>取消</button><button type="submit" class="primary-action">保存标准</button></div>
      </form>`;
      dialog.querySelector('[name="subjectId"]').value = mode.subjectId;
      dialog.querySelector('[name="status"]').value = mode.status;
      formBaseline = JSON.stringify(formValues());
      dialog.querySelectorAll("[data-mode-close]").forEach((btn) => { btn.onclick = closeStandard; });
      dialog.querySelector("form").onsubmit = async (event) => {
        event.preventDefault();
        const button = dialog.querySelector('[type="submit"]');
        if (button.disabled) return;
        const payload = { ...formValues(), expectedVersion: editing?.version };
        button.disabled = true;
        try {
          const result = await request(editing ? `${BASE}/${encodeURIComponent(editing.id)}` : BASE, { method: editing ? "PATCH" : "POST", body: JSON.stringify(payload) });
          editing = result.mode;
          formBaseline = JSON.stringify(formValues());
          await loadStandards();
          await openStandard(result.mode.id);
          dialog.querySelector("[data-mode-dialog-note]").textContent = `已保存 v${result.mode.version} · ${result.affected.length} 道已引用题目待复核，未自动重标`;
        } catch (error) {
          dialog.querySelector("[data-mode-dialog-note]").textContent = `未保存：${message(error)}`;
        } finally { button.disabled = false; }
      };
      if (!dialog.open) dialog.showModal();
      if (!editing) return;
      try {
        const result = await request(`${BASE}/${encodeURIComponent(editing.id)}/impact`);
        if (token !== standardSequence) return;
        const root = dialog.querySelector("[data-mode-impact]");
        root.innerHTML = `<p>${result.items.length} 道</p>` + result.items.map((row) => `<button class="assessment-mode-question-link" type="button" data-mode-question="${esc(row.questionId)}">${esc(row.stem)}<small>引用 v${row.standardVersion}</small></button>`).join("");
        root.querySelectorAll("[data-mode-question]").forEach((button) => { button.onclick = async () => {
          closeStandard();
          if (!dialog.open) await openQuestion(button.dataset.modeQuestion);
        }; });
      } catch (error) { if (token === standardSequence) dialog.querySelector("[data-mode-impact]").textContent = `读取失败：${message(error)}`; }
    }

    return {
      loadQuestion, loadStandards, sync: renderOptions, syncManagerLayout: () => setStandardsView(!panel.hidden),
      dirty: () => dirty,
      busy: () => busy,
      discard() {
        if (busy) return false;
        if (dirty && !window.confirm("考法有未确认修改，是否放弃？")) return false;
        if (dirty) {
          selected = new Map((current?.assignment?.modes || []).map((mode) => [mode.id, current.options.find((row) => row.id === mode.id) || mode]));
          renderOptions();
          note("未确认修改已放弃");
        }
        dirty = false;
        return true;
      },
    };
  }
  window.AssessmentModes = { create };
})();
