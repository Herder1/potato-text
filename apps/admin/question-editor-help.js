(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.QuestionEditorHelp = api;
    api.attach(root.document);
  }
})(typeof globalThis === "object" ? globalThis : this, function () {
  function position(anchor, size, viewport) {
    const gap = 8;
    const left = Math.max(gap, Math.min(anchor.left, viewport.width - size.width - gap));
    const below = anchor.bottom + gap;
    const top = below + size.height <= viewport.height - gap
      ? below : Math.max(gap, anchor.top - size.height - gap);
    return { left, top };
  }

  function attach(doc) {
    const dialog = doc?.getElementById("question-editor-dialog");
    if (!dialog) return null;
    const win = doc.defaultView;
    const tooltip = doc.createElement("div");
    tooltip.id = "question-editor-help-tooltip";
    tooltip.className = "question-detail-help-tooltip";
    tooltip.setAttribute("popover", "manual");
    tooltip.setAttribute("role", "tooltip");
    dialog.append(tooltip);
    const entries = new Map();
    let active = null;
    let timer;
    let frame;
    let sequence = 0;

    function syncPlaceholder(input) {
      const empty = String(!input.textContent.trim());
      if (input.dataset.questionPlaceholderEmpty !== empty) input.dataset.questionPlaceholderEmpty = empty;
    }

    function close() {
      win.clearTimeout(timer);
      if (tooltip.matches(":popover-open")) tooltip.hidePopover();
      active = null;
    }
    function show(trigger) {
      win.clearTimeout(timer);
      const source = doc.getElementById(trigger.dataset.questionHelpSource);
      if (!dialog.open || !source || !trigger.checkVisibility() || !source.textContent.trim()) return close();
      const text = source.textContent.trim();
      if (tooltip.textContent !== text) tooltip.textContent = text;
      active = trigger;
      if (!tooltip.matches(":popover-open")) tooltip.showPopover();
      const location = position(trigger.getBoundingClientRect(), tooltip.getBoundingClientRect(),
        { width: win.innerWidth, height: win.innerHeight });
      tooltip.style.left = `${location.left}px`;
      tooltip.style.top = `${location.top}px`;
    }
    function scheduleClose() {
      win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        if (active && (active.matches(":hover") || doc.activeElement === active || tooltip.matches(":hover"))) return;
        close();
      }, 120);
    }
    function sync() {
      frame = null;
      dialog.querySelectorAll(".answer-rich-input[data-answer-placeholder]").forEach(syncPlaceholder);
      for (const [source, trigger] of entries) {
        if (!source.isConnected) { trigger.remove(); entries.delete(source); }
      }
      dialog.querySelectorAll("[data-question-help-for]").forEach((source) => {
        const target = dialog.querySelector(source.dataset.questionHelpFor);
        if (!target) return;
        if (!source.id) source.id = `question-detail-help-source-${++sequence}`;
        let trigger = entries.get(source);
        if (!trigger?.isConnected) {
          trigger = doc.createElement("span");
          trigger.className = "question-detail-help-trigger";
          trigger.tabIndex = 0;
          trigger.setAttribute("role", "button");
          trigger.setAttribute("aria-label", `${source.dataset.questionHelpLabel || "此项"}说明`);
          trigger.setAttribute("aria-describedby", source.id);
          trigger.dataset.questionHelpSource = source.id;
          trigger.textContent = "?";
          target.append(trigger);
          entries.set(source, trigger);
        }
        const hidden = source.dataset.questionHelpInline === "true" || !source.textContent.trim();
        if (trigger.hidden !== hidden) trigger.hidden = hidden;
      });
      if (active) show(active);
    }
    const observer = new win.MutationObserver(() => {
      if (frame === null || frame === undefined) frame = win.requestAnimationFrame(sync);
    });
    observer.observe(dialog, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["data-question-help-inline", "hidden", "open"] });
    const triggerFor = (event) => event.target.closest?.(".question-detail-help-trigger");
    dialog.addEventListener("pointerover", (event) => {
      const trigger = triggerFor(event);
      if (trigger) show(trigger);
      else if (tooltip.contains(event.target)) win.clearTimeout(timer);
    });
    dialog.addEventListener("pointerout", scheduleClose);
    dialog.addEventListener("focusin", (event) => { const trigger = triggerFor(event); if (trigger) show(trigger); });
    dialog.addEventListener("focusout", scheduleClose);
    dialog.addEventListener("input", (event) => {
      const input = event.target.closest?.(".answer-rich-input[data-answer-placeholder]");
      if (input) syncPlaceholder(input);
    });
    dialog.addEventListener("click", (event) => {
      const trigger = triggerFor(event);
      if (!trigger) return;
      event.preventDefault();
      event.stopPropagation();
      show(trigger);
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && active) { event.preventDefault(); event.stopPropagation(); close(); }
      else if (["Enter", " "].includes(event.key) && triggerFor(event)) {
        event.preventDefault(); event.stopPropagation(); show(triggerFor(event));
      }
    }, true);
    dialog.addEventListener("close", close);
    dialog.addEventListener("scroll", (event) => {
      if (event.target === tooltip) return;
      win.requestAnimationFrame(() => {
        if (active && (active.matches(":hover") || doc.activeElement === active)) show(active);
        else close();
      });
    }, true);
    win.addEventListener("resize", close);
    sync();
    return { sync, close };
  }
  return { attach, position };
});
