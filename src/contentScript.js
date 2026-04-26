(() => {
  const EXT_ID = "odoo-chatter-brief-poc";
  if (document.getElementById(EXT_ID)) return;

  /** Placeholder prUrl in storage for “star this task” (no specific PR) — same value as popup. */
  const ODCB_TASK_STAR_URL = "__odcb_task_star__";
  /** `chrome.storage.local` key: { [getTicketKey()]: { fingerprint, savedAt, summary } } */
  const ODCB_TASK_SUMMARY_CACHE = "odcbTaskSummaryCache";
  const ODCB_SUMMARY_CACHE_MAX_TICKETS = 200;
  /** Last dragged position for the panel (`{ left, top }` in CSS pixels, viewport). */
  const ODCB_PANEL_POS = "odcbPanelPos";
  const state = {
    activeTab: "summary",
    lastExtract: null,
    lastSummary: null,
    busy: false,
    /** True when the current task row exists in odcbStarredPrs (task-level star in popup). */
    taskStarred: false,
    /** Rotating status label while the Gemini request is in flight (cleared when done) */
    summarizeStatusTimer: null,
    /** getTicketKey() for which we last filled `prStarredUrls` from storage */
    prStarStateTicketKey: null,
    /** In-memory: PR URLs starred for the current ticket (mirrors odcbStarredPrs) */
    prStarredUrls: null,
    settings: {
      useRpc: true,
      maxLoadMoreClicks: 15,
      model: "",
      resId: ""
    },
    apiSettings: {
      geminiApiKey: "",
      geminiModel: "gemini-3-flash-preview",
      summaryLanguage: "English",
      companyTone: "precise, practical, support-oriented"
    },
    /**
     * Fingerprint of the open Odoo record (model + resId + URL). When this changes in the SPA, we
     * refresh detection and, if the panel is open, re-extract so the brief matches the new form.
     */
    lastRecordFingerprint: /** @type {string | null} */ (null)
  };

  const root = document.createElement("div");
  root.id = EXT_ID;
  root.style.all = "initial";
  document.documentElement.appendChild(root);

  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      .odcb-panel {
        position: fixed; top: 86px; right: 18px; left: auto; width: min(560px, calc(100vw - 40px)); height: min(760px, calc(100vh - 120px));
        z-index: 2147483647; background: #fff; color: #111827; border: 1px solid #d8dee4; border-radius: 16px;
        box-shadow: 0 24px 80px rgba(0,0,0,.28); overflow: hidden;
        font: 13px/1.42 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: none;
      }
      .odcb-panel.open { display: flex; flex-direction: column; }
      .odcb-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; background: #f8f5f7; border-bottom: 1px solid #eadfe7; }
      /* Draggable by grabbing the title column (not the action buttons on the right). */
      .odcb-header-lead { flex: 1; min-width: 0; cursor: grab; touch-action: none; }
      .odcb-panel.odcb-panel-drag .odcb-header-lead { cursor: grabbing; user-select: none; -webkit-user-select: none; }
      .odcb-progress { height: 3px; width: 100%; background: #eadfe7; overflow: hidden; display: none; }
      .odcb-panel.odcb-busy .odcb-progress { display: block; }
      .odcb-progress-inner {
        height: 100%;
        width: 40%;
        background: linear-gradient(90deg, #714b67, #b76fa8, #714b67);
        background-size: 200% 100%;
        animation: odcb-progress-slide 1.1s ease-in-out infinite;
        border-radius: 2px;
      }
      @keyframes odcb-progress-slide {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(350%); }
      }
      .odcb-pr-banner { border: 1px solid #7dd3fc; border-radius: 14px; background: linear-gradient(180deg, #e0f2fe 0%, #f0f9ff 100%); color: #0c4a6e; padding: 12px 12px 10px; margin-bottom: 12px; box-shadow: 0 1px 0 rgba(255,255,255,.75) inset; }
      .odcb-pr-banner h3 { margin: 0 0 8px; font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: #0369a1; }
      /* One-line model status: compact card under PRs, replaces severity/status pills. */
      .odcb-status-snapshot { border: 1px solid #e5e7eb; border-radius: 12px; background: #f9fafb; padding: 10px 12px; margin-bottom: 10px; }
      .odcb-status-snapshot h3 { margin: 0 0 6px; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: #6b7280; }
      .odcb-status-snapshot p { margin: 0; font-size: 13px; line-height: 1.45; color: #1f2937; }
      .odcb-pr-row { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 12px; }
      .odcb-pr-row a { color: #0369a1; font-weight: 650; word-break: break-all; flex: 1; }
      .odcb-pr-row a:hover { text-decoration: underline; }
      .odcb-pr-star { flex-shrink: 0; min-width: 32px; border: 0; background: rgba(255,255,255,.7); border-radius: 8px; cursor: pointer; font-size: 16px; line-height: 1; padding: 4px 6px; color: #0369a1; }
      .odcb-pr-star:hover { background: #fff; }
      .odcb-pr-star[aria-pressed="true"] { color: #d97706; }
      .odcb-title { font-weight: 800; font-size: 15px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .odcb-title-star {
        border: 0; background: none; padding: 0; margin: 0; cursor: pointer; font: inherit; font-size: 1.05em; line-height: 1.15;
        color: #4b5563; flex-shrink: 0; vertical-align: middle;
      }
      .odcb-title-star:hover { opacity: 0.78; }
      .odcb-title-star[aria-pressed="true"] { color: #b45309; }
      .odcb-subtitle { color: #6b7280; font-size: 12px; margin-top: 2px; }
      .odcb-header-actions { display: flex; gap: 6px; align-items: center; }
      .odcb-icon-btn, .odcb-btn { border: 1px solid #d1d5db; border-radius: 9px; background: #fff; color: #111827; cursor: pointer; font: inherit; padding: 7px 9px; }
      /* Toolbar Settings matches active panel (settings view has no tab underline). */
      .odcb-icon-btn.odcb-active { background: #fdf9fb; border-color: #714b67; color: #714b67; }
      .odcb-primary { background: #714b67; color: white; border-color: #714b67; font-weight: 700; }
      .odcb-btn:disabled { opacity: .55; cursor: not-allowed; }
      .odcb-tabs { display: flex; border-bottom: 1px solid #e5e7eb; background: #fff; }
      .odcb-tab { flex: 1; padding: 9px 8px; border: 0; background: transparent; border-bottom: 2px solid transparent; cursor: pointer; font-weight: 700; color: #4b5563; }
      .odcb-tab.active { color: #714b67; border-bottom-color: #714b67; background: #fdf9fb; }
      .odcb-body { overflow: auto; padding: 14px; flex: 1; }
      .odcb-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-top: 1px solid #e5e7eb; background: #fafafa; }
      .odcb-actions-left { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .odcb-time-saved { flex-shrink: 0; margin-left: auto; }
      .odcb-time-saved[hidden] { display: none !important; }
      .odcb-time-saved-pill {
        display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.02em; color: #14532d;
        background: #dcfce7; border: 1px solid #bbf7d0; border-radius: 999px; padding: 4px 10px; white-space: nowrap; cursor: default;
      }
      .odcb-card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; margin-bottom: 10px; background: #fff; }
      .odcb-card h3 { margin: 0 0 7px; font-size: 13px; color: #111827; }
      .odcb-card p { margin: 0 0 8px; }
      .odcb-list { margin: 6px 0 0 18px; padding: 0; }
      .odcb-list li { margin: 5px 0; }
      .odcb-replicate-steps { margin: 10px 0 0; padding: 0 0 0 20px; }
      .odcb-replicate-steps li { margin: 8px 0; padding-left: 2px; }
      .odcb-kv { display: grid; grid-template-columns: 130px 1fr; gap: 5px 10px; }
      .odcb-kv strong { color: #374151; }
      .odcb-pill { display: inline-flex; align-items: center; border-radius: 999px; background: #f3f4f6; color: #374151; padding: 3px 8px; font-size: 12px; margin: 0 4px 4px 0; }
      .odcb-danger { color: #b91c1c; }
      .odcb-muted { color: #6b7280; }
      .odcb-body a.odcb-link { color: #0369a1; text-decoration: none; font-weight: 600; }
      .odcb-body a.odcb-link:hover { text-decoration: underline; }
      .odcb-richtext { white-space: pre-wrap; word-break: break-word; }
      .odcb-empty { color: #6b7280; padding: 20px 4px; text-align: center; }
      .odcb-textarea, .odcb-input { width: 100%; border: 1px solid #d1d5db; border-radius: 10px; padding: 9px; font: inherit; }
      .odcb-textarea { min-height: 190px; resize: vertical; white-space: pre-wrap; }
      .odcb-label { display: block; margin: 11px 0 5px; font-weight: 750; }
      .odcb-small { font-size: 12px; color: #6b7280; }
      .odcb-pre { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: #0f172a; color: #e5e7eb; border-radius: 12px; padding: 12px; overflow: auto; }
      .odcb-split { display: flex; gap: 8px; }
      .odcb-split > div { flex: 1; }
      /* Folded debug section under Settings (native details/summary). */
      .odcb-details { border: 1px solid #e5e7eb; border-radius: 12px; margin-bottom: 10px; background: #fff; overflow: hidden; }
      .odcb-details-summary { cursor: pointer; padding: 12px; font-weight: 750; font-size: 13px; color: #111827; list-style: none; display: flex; align-items: center; gap: 8px; }
      .odcb-details-summary::-webkit-details-marker { display: none; }
      .odcb-details-summary::before { content: "▸"; font-size: 11px; color: #6b7280; transition: transform 0.15s ease; display: inline-block; }
      .odcb-details[open] > .odcb-details-summary::before { transform: rotate(90deg); }
      .odcb-details-body { padding: 0 12px 12px; border-top: 1px solid #f3f4f6; }
    </style>
    <section class="odcb-panel" aria-label="Odoo Support Assistant">
      <div class="odcb-header">
        <div class="odcb-header-lead" data-panel-drag="1" title="Drag to move">
          <div class="odcb-title">
            <button type="button" class="odcb-title-star" data-action="toggle-task-star" title="Save this task to the extension popup" aria-pressed="false" aria-label="Save task to popup">☆</button>
            <span>Odoo Support Assistant</span>
          </div>
          <div class="odcb-subtitle">Extract chatter + pad → issue / conclusions / next steps</div>
        </div>
        <div class="odcb-header-actions">
          <button class="odcb-icon-btn" data-action="settings" title="Settings">⚙</button>
          <button class="odcb-icon-btn" data-action="refresh" title="Extract again">↻</button>
          <button class="odcb-icon-btn" data-action="close" title="Close">×</button>
        </div>
      </div>
      <div class="odcb-progress" aria-hidden="true"><div class="odcb-progress-inner"></div></div>
      <nav class="odcb-tabs">
        <button class="odcb-tab active" data-tab="summary">Summary</button>
        <button class="odcb-tab" data-tab="timeline">Timeline</button>
      </nav>
      <main class="odcb-body"></main>
      <footer class="odcb-actions">
        <div class="odcb-actions-left">
          <button class="odcb-btn odcb-primary" data-action="summarize">Summarize</button>
          <button class="odcb-btn" data-action="copy">Copy markdown</button>
        </div>
        <div class="odcb-time-saved" data-odcb-time-saved hidden aria-live="polite" title=""></div>
      </footer>
    </section>
  `;

  const $ = (selector) => shadow.querySelector(selector);
  const panel = $(".odcb-panel");
  const body = $(".odcb-body");

  // --- Draggable panel (grab title column; position persisted across visits for this profile)
  const panelDrag = { active: false, pointerId: -1, startX: 0, startY: 0, origLeft: 0, origTop: 0 };
  function clampPanelToViewport(left, top) {
    const w = panel.offsetWidth || Math.min(560, window.innerWidth - 40);
    const h = panel.offsetHeight || Math.min(760, window.innerHeight - 120);
    const maxL = Math.max(0, window.innerWidth - w);
    const maxT = Math.max(0, window.innerHeight - h);
    return { left: Math.min(maxL, Math.max(0, left)), top: Math.min(maxT, Math.max(0, top)) };
  }
  function applyPanelPosition(left, top) {
    const c = clampPanelToViewport(left, top);
    panel.style.left = `${Math.round(c.left)}px`;
    panel.style.top = `${Math.round(c.top)}px`;
    panel.style.right = "auto";
  }
  async function persistPanelPosition() {
    try {
      const r = panel.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      await chrome.storage.local.set({ [ODCB_PANEL_POS]: { left: r.left, top: r.top } });
    } catch {
      // ignore
    }
  }
  async function applyStoredPanelPosition() {
    try {
      const bag = await chrome.storage.local.get(ODCB_PANEL_POS);
      const p = bag[ODCB_PANEL_POS];
      if (!p || !Number.isFinite(p.left) || !Number.isFinite(p.top)) return;
      // Wait one frame so the open panel has dimensions before clamping.
      requestAnimationFrame(() => {
        applyPanelPosition(p.left, p.top);
      });
    } catch {
      // ignore
    }
  }
  function setupPanelDrag(/** @type {HTMLElement} */ rootPanel) {
    const lead = rootPanel?.querySelector?.(".odcb-header-lead[data-panel-drag]");
    if (!lead) return;
    lead.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if ((/** @type {Element} */ (e.target)).closest?.("button")) return;
      e.preventDefault();
      const r = rootPanel.getBoundingClientRect();
      rootPanel.style.left = `${r.left}px`;
      rootPanel.style.top = `${r.top}px`;
      rootPanel.style.right = "auto";
      panelDrag.active = true;
      panelDrag.pointerId = e.pointerId;
      panelDrag.startX = e.clientX;
      panelDrag.startY = e.clientY;
      panelDrag.origLeft = r.left;
      panelDrag.origTop = r.top;
      rootPanel.classList.add("odcb-panel-drag");
      try {
        lead.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    });
    lead.addEventListener("pointermove", (e) => {
      if (!panelDrag.active || e.pointerId !== panelDrag.pointerId) return;
      e.preventDefault();
      const nextL = panelDrag.origLeft + (e.clientX - panelDrag.startX);
      const nextT = panelDrag.origTop + (e.clientY - panelDrag.startY);
      applyPanelPosition(nextL, nextT);
    });
    const end = (e) => {
      if (!panelDrag.active || e.pointerId !== panelDrag.pointerId) return;
      panelDrag.active = false;
      rootPanel.classList.remove("odcb-panel-drag");
      try {
        lead.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      void persistPanelPosition();
    };
    lead.addEventListener("pointerup", end);
    lead.addEventListener("pointercancel", end);
  }
  setupPanelDrag(panel);
  window.addEventListener("resize", () => {
    if (!panel.classList.contains("open")) return;
    const r = panel.getBoundingClientRect();
    applyPanelPosition(r.left, r.top);
  });

  loadApiSettings();
  setupInlineLauncher();
  // Odoo 17+ is an SPA: URL/DOM change without a full reload — re-run detection and refresh data when the record changes.
  let domSyncTimer = 0;
  function scheduleDocumentSync() {
    if (domSyncTimer) clearTimeout(domSyncTimer);
    domSyncTimer = setTimeout(() => {
      domSyncTimer = 0;
      setupInlineLauncher();
      void syncRecordContext();
    }, 250);
  }
  const reinjectObserver = new MutationObserver(() => scheduleDocumentSync());
  reinjectObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => {
    void syncRecordContext();
  });
  window.addEventListener("popstate", () => {
    void syncRecordContext();
  });
  // Prime fingerprint after injection so a quick SPA navigation is still detected vs initial shell.
  setTimeout(() => {
    void syncRecordContext();
  }, 0);

  async function openPanel() {
    panel.classList.add("open");
    await applyStoredPanelPosition();
    autoDetectSettings();
    await loadApiSettings();
    if (!state.lastExtract) {
      await extract(false);
    } else {
      await tryLoadSummaryCache();
    }
    await render();
  }

  shadow.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-tab]")?.dataset.tab;
    if (tab) {
      state.activeTab = tab;
      await render();
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;

    if (action === "toggle-pr-star") {
      const starBtn = event.target.closest("button[data-pr-url]");
      if (starBtn) {
        event.preventDefault();
        const prUrl = starBtn.getAttribute("data-pr-url");
        const prLabel = starBtn.getAttribute("data-pr-label") || "";
        if (prUrl) await togglePrStar(prUrl, prLabel);
      }
      return;
    }

    if (action === "close") {
      panel.classList.remove("open");
    } else if (action === "toggle-task-star") {
      await toggleTaskStar();
    } else if (action === "settings") {
      state.activeTab = "settings";
      await loadApiSettings();
      await render();
    } else if (action === "refresh" || action === "extract") {
      await extract(true);
    } else if (action === "summarize") {
      await summarize();
    } else if (action === "copy") {
      await copyMarkdown();
    } else if (action === "save-api-settings") {
      await saveApiSettings();
    } else if (action === "open-options-page") {
      await openOptionsPage();
    }
  });

  shadow.addEventListener("input", handleSettingsInput);
  shadow.addEventListener("change", handleSettingsInput);

  function handleSettingsInput(event) {
    const target = event.target;
    if (target.matches("[data-setting]")) {
      const key = target.dataset.setting;
      if (target.type === "checkbox") state.settings[key] = target.checked;
      else if (target.type === "number") state.settings[key] = Number(target.value || 0);
      else state.settings[key] = target.value.trim();
    }
    if (target.matches("[data-api-setting]")) {
      const key = target.dataset.apiSetting;
      state.apiSettings[key] = target.value;
    }
  }

  // Re-read model + res id from the current location every time (Odoo SPA: no full page reload on record change).
  function autoDetectSettings() {
    const detected = detectOdooState();
    state.settings.model = detected.model || "";
    state.settings.resId = detected.resId ? String(detected.resId) : "";
    if (!state.settings.model && /\/tasks?\b|project/i.test(location.pathname + " " + document.body.innerText.slice(0, 1000))) {
      state.settings.model = "project.task";
    }
  }

  function getRecordFingerprint() {
    const d = detectOdooState();
    return `${d.model || ""}::${d.resId || ""}::${location.href}`;
  }

  /**
   * When the user opens another form (SPA), sync model/id and clear cached extract/summary for the new record.
   * If the panel is open, re-extract from the new page.
   */
  async function syncRecordContext() {
    autoDetectSettings();
    const fp = getRecordFingerprint();
    if (state.lastRecordFingerprint === null) {
      state.lastRecordFingerprint = fp;
      return;
    }
    if (state.lastRecordFingerprint === fp) return;
    state.lastRecordFingerprint = fp;
    state.lastExtract = null;
    state.lastSummary = null;
    state.activeTab = "summary";
    state.prStarStateTicketKey = null;
    state.prStarredUrls = null;
    if (!panel.classList.contains("open")) return;
    try {
      await loadApiSettings();
      await render();
      await extract(false);
      await render();
    } catch (error) {
      showError(error);
    }
  }

  function setupInlineLauncher() {
    const existing = document.getElementById("odcb-inline-launcher");
    const sendButton = findSendMessageButton();

    // No “Send message” in chatter = no inline button, and no floating fallback (old kanban / list views)
    if (!sendButton) {
      document.getElementById("odcb-floating-fallback-launcher")?.remove();
      existing?.remove();
      return;
    }

    const fallback = document.getElementById("odcb-floating-fallback-launcher");
    if (fallback) fallback.remove();

    let button = existing;
    if (!button) {
      button = document.createElement("button");
      button.id = "odcb-inline-launcher";
      button.type = "button";
      button.textContent = "AI brief";
      button.title = "Summarize this Odoo record";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPanel();
      });
    }

    button.className = sendButton.className || "btn btn-primary";
    button.removeAttribute("disabled");
    button.style.marginLeft = "4px";
    button.style.whiteSpace = "nowrap";

    if (button.parentElement !== sendButton.parentElement || sendButton.nextSibling !== button) {
      sendButton.insertAdjacentElement("afterend", button);
    }
  }

  function findSendMessageButton() {
    const roots = [findChatterRoot(), document].filter(Boolean);
    const labels = /^(send message|envoyer un message|envoyer message|bericht verzenden|send)$/i;
    for (const root of roots) {
      const buttons = Array.from(root.querySelectorAll("button, a[role='button']"));
      const match = buttons.find((button) => {
        if (!isVisible(button)) return false;
        if (button.id === "odcb-inline-launcher" || button.id === "odcb-floating-fallback-launcher") return false;
        const text = cleanText(button.innerText || button.textContent || button.getAttribute("aria-label") || button.title || "");
        return labels.test(text);
      });
      if (match) return match;
    }
    return null;
  }

  async function loadApiSettings() {
    try {
      const values = await chrome.storage.sync.get(["geminiApiKey", "geminiModel", "summaryLanguage", "companyTone"]);
      state.apiSettings = { ...state.apiSettings, ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null)) };
    } catch (_) {
      // Keep the panel usable even if Chrome storage is unavailable on a restricted page.
    }
  }

  async function saveApiSettings() {
    await chrome.storage.sync.set({
      geminiApiKey: state.apiSettings.geminiApiKey || "",
      geminiModel: state.apiSettings.geminiModel || "gemini-3-flash-preview",
      summaryLanguage: state.apiSettings.summaryLanguage || "English",
      companyTone: state.apiSettings.companyTone || "precise, practical, support-oriented"
    });
    setBusy(false, "API settings saved");
    setTimeout(() => setBusy(false), 1200);
  }

  async function openOptionsPage() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "ODCB_OPEN_OPTIONS" });
      if (!response?.ok) throw new Error(response?.error || "Could not open extension options");
    } catch (error) {
      showError(error);
    }
  }

  async function extract(forceRender) {
    setBusy(true, "Extracting page…");
    try {
      await expandChatter(state.settings.maxLoadMoreClicks);
      autoDetectSettings();

      const dom = extractDom();
      let rpc = null;
      let rpcMessages = [];
      const model = state.settings.model;
      const resId = Number(state.settings.resId);

      if (state.settings.useRpc && model && resId) {
        try {
          rpc = await extractRpc(model, resId);
          rpcMessages = rpc.messages || [];
        } catch (error) {
          rpc = { error: error.message, model, resId };
        }
      }

      const messages = mergeMessages(rpcMessages, dom.messages);
      // Raw = what we collected from the API / DOM; merged = de-dupe + DOM junk filter (what the model and word count use).
      const mergedFromDom = messages.filter((m) => m.source === "dom").length;
      const mergedFromRpc = messages.filter((m) => typeof m.source === "string" && m.source.startsWith("rpc")).length;
      const payload = {
        url: location.href,
        title: document.title,
        detected: { model, resId: state.settings.resId || null },
        extracted_at: new Date().toISOString(),
        stats: {
          /** Final thread size after merge (this is `messages.length`). */
          messages: messages.length,
          /** Rows from `mail.message` search_read (before merge with DOM). */
          rpcMessages: rpcMessages.length,
          /** Chatter message nodes we scanned in the DOM (before de-dupe / junk filter). */
          domMessages: dom.messages.length,
          /** Lines in the merged list that came from each source (after de-dupe; sum ≤ `messages` + by design). */
          mergedFromDom,
          mergedFromRpc,
          formChars: dom.formText.length,
          descriptionChars: dom.descriptionText.length
        },
        rpc,
        dom,
        messages
      };
      // GitHub / GitLab / Bitbucket PR links in chatter, description, and form (used for the banner, not sent as extra model fields)
      payload.prLinks = extractPrLinksFromExtract(payload);
      state.lastExtract = payload;
      // Restore a persisted brief when counts/metadata match; avoids an extra API call on reopen.
      await tryLoadSummaryCache();

      if (forceRender) await render();
      return state.lastExtract;
    } catch (error) {
      showError(error);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  // PR URL detectors (chatter text often has GitHub/GitLab links to fixes)
  const PR_URL_REGEXES = [
    /https?:\/\/github\.com\/[^/\s#]+?\/[^/\s#]+?\/pull\/\d+[^\s\])'"<>]*/gi,
    /https?:\/\/[^/\s"']+?\/[^/\s"']*?\/-\/merge_requests\/\d+[^\s\])'"<>]*/gi,
    /https?:\/\/[^/\s"']+?\/[^/\s"']*?\/pull-requests\/\d+[^\s\])'"<>]*/gi
  ];

  function getTicketKey() {
    return `${location.origin}::${state.settings.model || "unknown"}::${String(state.settings.resId || "0")}`;
  }

  /**
   * Fingerprint of the current extract for cache invalidation: ticket + message counts and pad/preview
   * char sizes only (no message bodies) so the same thread shape reuses a stored summary.
   */
  function getExtractMetadataFingerprint() {
    if (!state.lastExtract) return null;
    const st = state.lastExtract.stats || {};
    return JSON.stringify({
      k: getTicketKey(),
      /** Merged list size (and merge breakdown) — invalidates cache when de-dupe / DOM filter changes. */
      m: st.messages,
      mfd: st.mergedFromDom,
      mfr: st.mergedFromRpc,
      form: st.formChars,
      desc: st.descriptionChars
    });
  }

  /**
   * Keeps the summary cache map to at most `maxKeys` tickets, dropping the oldest by `savedAt`
   * (entries without `savedAt` sort as 0, so legacy rows go first). Mutates `map` in place.
   */
  function pruneSummaryCacheMap(/** @type {Record<string, { savedAt?: number, fingerprint: string, summary: object }>} */ map, maxKeys) {
    const keys = Object.keys(map);
    if (keys.length <= maxKeys) return;
    const rank = keys.map((k) => ({ k, t: map[k]?.savedAt ?? 0 }));
    rank.sort((a, b) => a.t - b.t);
    for (let i = 0; i < keys.length - maxKeys; i++) {
      delete map[rank[i].k];
    }
  }

  async function tryLoadSummaryCache() {
    const fp = getExtractMetadataFingerprint();
    if (!fp) return false;
    try {
      const bag = await chrome.storage.local.get(ODCB_TASK_SUMMARY_CACHE);
      const raw = bag[ODCB_TASK_SUMMARY_CACHE] || {};
      const n0 = Object.keys(raw).length;
      const map = { ...raw };
      pruneSummaryCacheMap(map, ODCB_SUMMARY_CACHE_MAX_TICKETS);
      if (Object.keys(map).length < n0) {
        await chrome.storage.local.set({ [ODCB_TASK_SUMMARY_CACHE]: map });
      }
      const ent = map[getTicketKey()];
      if (!ent || ent.fingerprint !== fp) return false;
      state.lastSummary = { ...ent.summary, input_fingerprint: fp };
      return true;
    } catch {
      return false;
    }
  }

  async function saveSummaryCache(/** @type {any} */ summary) {
    const fp = summary?.input_fingerprint;
    if (!fp) return;
    try {
      const bag = await chrome.storage.local.get(ODCB_TASK_SUMMARY_CACHE);
      const map = { ...(bag[ODCB_TASK_SUMMARY_CACHE] || {}) };
      // Newest write wins; older keys are pruned to cap storage and stay under the quota.
      const key = getTicketKey();
      map[key] = { fingerprint: fp, savedAt: Date.now(), summary: { ...summary } };
      pruneSummaryCacheMap(map, ODCB_SUMMARY_CACHE_MAX_TICKETS);
      await chrome.storage.local.set({ [ODCB_TASK_SUMMARY_CACHE]: map });
    } catch {
      // Panel still works if storage is unavailable
    }
  }

  function updatePrimaryCtaButton() {
    const btn = shadow.querySelector('[data-action="summarize"]');
    if (!btn) return;
    const fp = getExtractMetadataFingerprint();
    const sum = state.lastSummary;
    const has = !!sum;
    // Stale: we have a summary, but message counts or pad size changed since it was built.
    const stale = has && fp && sum.input_fingerprint && sum.input_fingerprint !== fp;
    if (!has) {
      btn.textContent = "Summarize";
      btn.title = "Create a brief with Gemini";
    } else if (stale) {
      btn.textContent = "Refresh";
      btn.title = "Chatter or pad changed since this summary — run a new one";
    } else {
      btn.textContent = "Regenerate";
      btn.title = "Run Gemini again on the same extract";
    }
  }

  function normalizePrUrl(href) {
    return String(href)
      .replace(/[.,;)\]}>'"»]+$/g, "")
      .replace(/^<+/, "");
  }

  /**
   * One stable key per pull/MR: same PR repeated with `/files`, `?w=1`, or `http` vs `https` becomes one link.
   * (Otherwise each regex match string differed and `Set` kept three rows for the same odoo#226256-style link.)
   */
  function canonicalizePrUrl(raw) {
    const s0 = normalizePrUrl(String(raw).trim());
    if (!s0) return "";
    let u;
    try {
      u = new URL(s0);
    } catch {
      return s0;
    }
    if (u.hostname === "www.github.com") u.hostname = "github.com";
    u.search = "";
    u.hash = "";
    const p = u.pathname;
    // GitHub: /org/repo/pull/123(/files/…) → /org/repo/pull/123
    const gh = p.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/i);
    if (gh) u.pathname = gh[1];
    else {
      // GitLab: /group/…/project/-/merge_requests/42(/diffs …) → …/merge_requests/42
      const mrm = p.match(/\/-\/merge_requests\/\d+/i);
      if (mrm) u.pathname = p.slice(0, mrm.index + mrm[0].length);
      else {
        const bbp = p.match(/^(.*\/pull-requests\/\d+)/i);
        if (bbp) u.pathname = bbp[1].replace(/\/+$/, "");
      }
    }
    if (u.hostname === "github.com" || u.hostname.endsWith(".github.com")) u.protocol = "https:";
    return u.href;
  }

  // Short label for a PR URL (e.g. org/repo#42) to save horizontal space
  function shortPrLabel(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "github.com") {
        const parts = u.pathname.split("/").filter(Boolean);
        const i = parts.indexOf("pull");
        if (i >= 2) return `${parts[0]}/${parts[1]}#${parts[i + 1] || ""}`;
      }
      const mr = u.pathname.match(/(.+)\/-\/merge_requests\/(\d+)/);
      if (mr) return `${u.hostname}${mr[1]} !${mr[2]}`;
      const bbs = u.pathname.match(/\/pull-requests\/(\d+)/i);
      if (bbs) return `${u.hostname} PR ${bbs[1]}`;
    } catch {
      // ignore
    }
    return url;
  }

  function extractPrLinksFromText(blob) {
    if (!blob) return [];
    /** @type {Map<string, { url: string, label: string }>} */
    const byKey = new Map();
    for (const re of PR_URL_REGEXES) {
      re.lastIndex = 0;
      let m = re.exec(blob);
      while (m) {
        const raw = normalizePrUrl(m[0]);
        const c = raw ? canonicalizePrUrl(raw) : "";
        if (c && !byKey.has(c)) byKey.set(c, { url: c, label: shortPrLabel(c) });
        m = re.exec(blob);
      }
    }
    return [...byKey.values()];
  }

  /** Safety net if `ex.prLinks` was stored with duplicates or legacy shapes. */
  function dedupePrLinkRows(/** @type {Array<{ url: string, label: string }>} */ rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const m = new Map();
    for (const row of rows) {
      if (!row?.url) continue;
      const c = canonicalizePrUrl(row.url) || row.url;
      if (!m.has(c)) m.set(c, { url: c, label: shortPrLabel(c) || row.label || c });
    }
    return [...m.values()];
  }

  function extractPrLinksFromExtract(ex) {
    if (!ex) return [];
    const parts = [];
    for (const m of ex.messages || []) {
      if (m?.text) parts.push(m.text);
      if (m?.subject) parts.push(m.subject);
    }
    if (ex.dom) {
      if (ex.dom.title) parts.push(ex.dom.title);
      if (ex.dom.descriptionText) parts.push(ex.dom.descriptionText);
      if (ex.dom.formText) parts.push(String(ex.dom.formText).slice(0, 25_000));
    }
    return extractPrLinksFromText(parts.join("\n"));
  }

  function getPrLinkRows() {
    const ex = state.lastExtract;
    if (!ex) return [];
    const list = ex.prLinks && ex.prLinks.length ? ex.prLinks : extractPrLinksFromExtract(ex);
    return dedupePrLinkRows(list);
  }

  // Loads which PR URLs are starred in chrome.storage.local for the current ticket key
  function isTaskStarRow(/** @type {{ prUrl?: string } | null | undefined} */ r) {
    return !!(r && r.prUrl === ODCB_TASK_STAR_URL);
  }

  /** Syncs PR star set + task-level star in header from storage for the current ticket. */
  async function ensurePrStarState() {
    const key = getTicketKey();
    const next = new Set();
    let taskS = false;
    try {
      const { odcbStarredPrs = [] } = await chrome.storage.local.get("odcbStarredPrs");
      for (const r of odcbStarredPrs) {
        if (r.ticketKey === key) {
          if (isTaskStarRow(r)) taskS = true;
          // Canonical URL so a star on …/pull/42/files matches the banner row for …/pull/42
          else if (r.prUrl) next.add(canonicalizePrUrl(r.prUrl) || r.prUrl);
        }
      }
    } catch {
      // ignore
    }
    state.prStarStateTicketKey = key;
    state.prStarredUrls = next;
    state.taskStarred = taskS;
    updateTaskStarButtonDom();
  }

  // Keeps the titlebar task star in sync with chrome.storage and state.taskStarred.
  function updateTaskStarButtonDom() {
    const btn = shadow.querySelector('[data-action="toggle-task-star"]');
    if (!btn) return;
    const on = !!state.taskStarred;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "★" : "☆";
  }

  async function toggleTaskStar() {
    const key = getTicketKey();
    let { odcbStarredPrs = [] } = await chrome.storage.local.get("odcbStarredPrs");
    const idx = odcbStarredPrs.findIndex((r) => r.ticketKey === key && isTaskStarRow(r));
    if (idx >= 0) odcbStarredPrs.splice(idx, 1);
    else
      odcbStarredPrs.push({
        ticketKey: key,
        ticketUrl: location.href,
        pageTitle: document.title,
        model: state.settings.model || "",
        resId: String(state.settings.resId || ""),
        prUrl: ODCB_TASK_STAR_URL,
        prLabel: "",
        starredAt: new Date().toISOString()
      });
    await chrome.storage.local.set({ odcbStarredPrs });
    await ensurePrStarState();
    await render();
  }

  async function togglePrStar(prUrl, prLabel) {
    const key = getTicketKey();
    const canon = canonicalizePrUrl(prUrl) || prUrl;
    await ensurePrStarState();
    if (!(state.prStarredUrls instanceof Set)) state.prStarredUrls = new Set();
    let { odcbStarredPrs = [] } = await chrome.storage.local.get("odcbStarredPrs");
    const sameUrl = (/** @type {{ prUrl?: string }} */ r) =>
      r.ticketKey === key && (canonicalizePrUrl(/** @type {string} */ (r.prUrl) || "") || r.prUrl) === canon;
    const idx = odcbStarredPrs.findIndex(sameUrl);
    if (idx >= 0) {
      odcbStarredPrs.splice(idx, 1);
      state.prStarredUrls.delete(canon);
    } else {
      odcbStarredPrs.push({
        ticketKey: key,
        ticketUrl: location.href,
        pageTitle: document.title,
        model: state.settings.model || "",
        resId: String(state.settings.resId || ""),
        prUrl: canon,
        prLabel: prLabel || shortPrLabel(canon) || canon,
        starredAt: new Date().toISOString()
      });
      state.prStarredUrls.add(canon);
    }
    await chrome.storage.local.set({ odcbStarredPrs });
    await render();
  }

  function buildPrBannerHtml() {
    const rows = getPrLinkRows();
    if (!rows.length) return "";
    const set = state.prStarredUrls instanceof Set ? state.prStarredUrls : new Set();
    const lines = rows
      .map((row) => {
        const starred = set.has(row.url);
        return `<div class="odcb-pr-row">
          <a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.label || row.url)}</a>
          <button type="button" class="odcb-pr-star" data-action="toggle-pr-star" data-pr-url="${escapeHtml(row.url)}" data-pr-label="${escapeHtml(
            row.label
          )}" title="Save to extension toolbar" aria-pressed="${starred}">${starred ? "★" : "☆"}</button>
        </div>`;
      })
      .join("");
    return `<div class="odcb-pr-banner" role="region" aria-label="Pull requests in chatter"><h3>PRs</h3>${lines}</div>`;
  }

  // Rotates the header subtitle on a timer so a static “wait” message is never mistaken for a freeze.
  function startSummarizeStatusRotation() {
    clearSummarizeStatusRotation();
    const lines = ["Calling Gemini…", "Waiting for model…", "Building the brief…"];
    const subtitle = $(".odcb-subtitle");
    let i = 0;
    state.summarizeStatusTimer = setInterval(() => {
      if (!state.busy) return;
      i = (i + 1) % lines.length;
      subtitle.textContent = lines[i];
    }, 2000);
  }

  function clearSummarizeStatusRotation() {
    if (state.summarizeStatusTimer) {
      clearInterval(state.summarizeStatusTimer);
      state.summarizeStatusTimer = null;
    }
  }

  // One-shot message to the service worker (no streaming) — matches user preference for a single JSON response
  async function summarize() {
    try {
      if (!state.lastExtract) {
        await extract(false);
        if (!state.lastExtract) throw new Error("Nothing extracted to summarize.");
      }
      setBusy(true, "Summarizing with Gemini…");
      startSummarizeStatusRotation();
      const response = await chrome.runtime.sendMessage({ type: "ODCB_SUMMARIZE", payload: state.lastExtract });
      if (!response?.ok) throw new Error(response?.error || "Summary failed");
      // Pin this brief to the current extract shape so we can reuse it from `chrome.storage.local` and show Refresh when stale.
      const fp = getExtractMetadataFingerprint();
      if (!fp) throw new Error("Missing extract metadata after summarize.");
      state.lastSummary = { ...response.result, input_fingerprint: fp };
      await saveSummaryCache(state.lastSummary);
      state.activeTab = "summary";
      clearSummarizeStatusRotation();
      setBusy(false);
      await render();
    } catch (error) {
      const msg = String(error?.message || error);
      clearSummarizeStatusRotation();
      setBusy(false);
      if (msg.toLowerCase().includes("extension context invalidated")) {
        showError(new Error("Extension was reloaded. Refresh this page and try again."));
      } else {
        showError(error);
      }
    } finally {
      clearSummarizeStatusRotation();
    }
  }

  function extractDom() {
    const title = getBestText([
      ".o_form_view .o_form_sheet h1",
      ".o_form_view h1",
      ".o_breadcrumb .active",
      ".breadcrumb .active"
    ]);

    const descriptionText = extractDescriptionText();
    const formText = cleanText(getVisibleFormRoot()?.innerText || document.body.innerText.slice(0, 25000));
    const chatterRoot = findChatterRoot();
    const rawChatterText = cleanText(chatterRoot?.innerText || "");
    const messages = extractDomMessages(chatterRoot);
    const metadata = extractFieldPairs();

    return { title, descriptionText, formText, rawChatterText, messages, metadata };
  }

  function findChatterRoot() {
    const selectors = [
      ".o-mail-Chatter",
      "[class*='o-mail-Chatter']",
      ".o_Chatter",
      ".o_chatter",
      "aside[class*='Chatter']",
      ".o_FormRenderer_chatterContainer",
      ".o-mail-Form-chatter"
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node && cleanText(node.innerText).length > 20) return node;
    }
    return null;
  }

  function getVisibleFormRoot() {
    return document.querySelector(".o_form_view .o_form_sheet_bg") || document.querySelector(".o_form_view") || document.querySelector("main");
  }

  function extractDescriptionText() {
    const candidates = [
      "[name='description']",
      ".o_field_widget[name='description']",
      ".o_field_html[name='description']",
      ".o_field_text[name='description']",
      ".note-editable",
      "[data-name='description']",
      "[class*='description']"
    ];
    const texts = [];
    for (const selector of candidates) {
      for (const element of document.querySelectorAll(selector)) {
        const text = cleanText(element.innerText || element.value || element.textContent || "");
        if (text.length > 20 && !texts.includes(text)) texts.push(text);
      }
    }
    return texts.join("\n\n---\n\n");
  }

  function extractDomMessages(chatterRoot) {
    if (!chatterRoot) return [];
    const selectors = [
      ".o-mail-Message",
      "[class*='o-mail-Message']",
      ".o_Message",
      "[data-message-id]",
      "[data-id][class*='Message']"
    ];
    const elements = unique(selectors.flatMap((selector) => Array.from(chatterRoot.querySelectorAll(selector))));

    let sourceElements = elements.filter((el) => cleanText(el.innerText).length > 15);
    if (!sourceElements.length) {
      sourceElements = Array.from(chatterRoot.children).filter((el) => cleanText(el.innerText).length > 20);
    }

    return sourceElements.map((el, i) => {
      const time = el.querySelector("time")?.getAttribute("datetime") || el.querySelector("time")?.innerText || "";
      const author = getMessageAuthor(el);
      const subject = getBestTextIn(el, ["[class*='subject']", ".o-mail-Message-subject"]);
      const kind = inferMessageKind(el);
      return {
        index: i + 1,
        source: "dom",
        id: el.getAttribute("data-message-id") || el.getAttribute("data-id") || null,
        date: cleanText(time),
        author,
        kind,
        subject,
        text: cleanText(el.innerText)
      };
    });
  }

  function getMessageAuthor(el) {
    const selectors = ["[class*='author']", "[class*='Author']", ".o-mail-Message-author", ".o_Message_author"];
    const author = getBestTextIn(el, selectors);
    if (author) return author.split("\n")[0].trim();
    const firstLine = cleanText(el.innerText).split("\n").find(Boolean) || "";
    return firstLine.slice(0, 100);
  }

  function inferMessageKind(el) {
    const text = cleanText(el.innerText).toLowerCase();
    const cls = el.className?.toString().toLowerCase() || "";
    if (/log note|internal note|note interne|note interne|logged/i.test(text + cls)) return "log_note";
    if (/email|subject:|from:|to:/i.test(text)) return "email_or_message";
    if (/→|changed|status|stage|priority|assigned|reviewer/i.test(text)) return "tracking_or_status";
    return "chatter";
  }

  function extractFieldPairs() {
    const pairs = [];
    const labels = Array.from(document.querySelectorAll(".o_form_label, .o_td_label label, label"));
    for (const label of labels) {
      const labelText = cleanText(label.innerText || label.textContent || "").replace(/\s*\?$/, "");
      if (!labelText || labelText.length > 80) continue;
      const row = label.closest("tr") || label.closest(".o_group") || label.parentElement;
      let value = "";
      if (row) {
        value = cleanText(row.innerText || "").replace(labelText, "").trim();
      }
      if (value && value.length < 400 && !pairs.some((p) => p.label === labelText && p.value === value)) {
        pairs.push({ label: labelText, value });
      }
      if (pairs.length >= 60) break;
    }
    return pairs;
  }

  /**
   * Removes author line(s), assignee/None glue, and Odoo date lines from DOM `innerText` so we
   * can see whether a message has any real user content (or drop header-only / duplicate sub-nodes).
   */
  function stripDomChatterNoise(author, text) {
    let t = cleanText(text || "");
    const a = cleanText(author || "");
    if (a) t = t.split(a).join(" ");
    // "NoneJoseph X (y)(Assignees)"-style gluing without a line break
    t = t.replace(/None([A-Z])/g, "$1");
    t = t.split("\n");
    t = t
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (/^\(Assignees\)$/i.test(line) || /^\(Assignee\)$/i.test(line)) return false;
        if (/\(Assignees\)\s*$/i.test(line) && line.length < 80) return false;
        if (/^None[^(]{0,120}\(Assignees\)/i.test(line)) return false;
        // Odoo: "Mar 9, 11:03 AM" / "9 mars 2025" style single-line time headers
        if (
          /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b\s+\d{1,2},?\s*(?:\d{1,2}:\d{2}|\d{4})/i.test(line)
        ) {
          return false;
        }
        if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:,|\s).{3,32}$/i.test(line)) return false;
        if (/^[\d/:\s,APM-–]{4,32}$/i.test(line) && /[/:]/.test(line) && line.length < 40) return false;
        return true;
      });
    t = t.join(" ").replace(/\bNone\b/gi, " ").replace(/\s+/g, " ").trim();
    return t;
  }

  /**
   * True when the DOM fragment has no user-written body: empty after layout strip, or only
   * assignee/None UI glue. Keeps e.g. "ok" (strip has letters; no Assignees-only noise).
   */
  function isJunkDomMessage(author, text) {
    const raw = cleanText(text);
    const strip = stripDomChatterNoise(author, text);
    if (strip.length >= 3) return false;
    if (strip.length > 0 && /https?:/i.test(strip)) return false;
    if (!strip.length) return true;
    if (strip.length < 3 && /\(Assignees\)|\bNone[A-Za-z]/.test(raw + cleanText(author))) return true;
    return false;
  }

  function mergeMessages(rpcMessages = [], domMessages = []) {
    const merged = [];
    const seen = new Set();

    // Prefer stable message id from RPC; otherwise dedupe on normalized body (DOM often duplicates sub-nodes).
    function keyFor(message) {
      const id = message?.id ? String(message.id) : "";
      if (id && /^\d+$/.test(id)) return `id:${id}`;
      const raw = cleanText(message?.text || message?.body || "");
      const isDom = message?.source === "dom";
      const forDedup = isDom ? stripDomChatterNoise(message?.author, raw) : raw;
      const text = (forDedup || raw)
        .replace(/\s+/g, " ")
        .toLowerCase()
        .trim()
        .slice(0, 520);
      if (text) return `t:${text}`;
      const date = cleanText(message?.date || "").slice(0, 40).toLowerCase();
      const authorK = cleanText(message?.author || "").slice(0, 80).toLowerCase();
      return `legacy:${date}|${authorK}`;
    }

    function add(message) {
      if (!message) return;
      const text = cleanText(message.text || message.body || "");
      if (!text) return;
      // DOM: skip assignee/avatar/empty sub-fragments that only repeat name + date + (Assignees).
      if (message.source === "dom" && isJunkDomMessage(message.author, text)) return;
      const key = keyFor({ ...message, text });
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({ ...message, index: merged.length + 1, text });
    }

    // RPC is cleaner and usually complete. DOM is fallback/noise-capture.
    for (const message of rpcMessages || []) add(message);
    for (const message of domMessages || []) add(message);

    return merged.map((message, index) => ({ ...message, index: index + 1 }));
  }

  async function extractRpc(model, resId) {
    const record = await fetchRecord(model, resId).catch((error) => ({ error: error.message }));
    const messages = await fetchMessages(model, resId);
    return { model, resId, record, messages };
  }

  async function fetchRecord(model, resId) {
    const fields = await odooCall(model, "fields_get", [], { attributes: ["string", "type"] });
    const preferred = [
      "display_name", "name", "description", "description_html", "partner_id", "customer_id", "user_id", "user_ids",
      "stage_id", "priority", "kanban_state", "date_deadline", "tag_ids", "project_id", "company_id",
      "sale_order_id", "sale_line_id", "subscription_id", "x_studio_subscription", "x_studio_subscription_state"
    ].filter((f) => fields[f]);
    const result = await odooCall(model, "read", [[resId], preferred], {});
    const record = result?.[0] || {};
    for (const key of Object.keys(record)) record[key] = normalizeRpcValue(record[key]);
    return record;
  }

  async function fetchMessages(model, resId) {
    const result = await odooCall("mail.message", "search_read", [], {
      domain: [["model", "=", model], ["res_id", "=", Number(resId)], ["message_type", "!=", "user_notification"]],
      fields: ["id", "date", "author_id", "email_from", "subject", "body", "message_type", "subtype_id"],
      order: "date asc, id asc",
      // Cap RPC churn for payload size; older history is still visible if DOM+merge picks it up
      limit: 350
    });
    return (result || []).map((m, i) => ({
      index: i + 1,
      source: "rpc:mail.message",
      id: m.id,
      date: m.date,
      author: Array.isArray(m.author_id) ? m.author_id[1] : (m.email_from || ""),
      kind: Array.isArray(m.subtype_id) ? m.subtype_id[1] : (m.message_type || "message"),
      subject: m.subject || "",
      text: htmlToText(m.body || "")
    }));
  }

  async function odooCall(model, method, args = [], kwargs = {}) {
    const url = `${location.origin}/web/dataset/call_kw/${model}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { model, method, args, kwargs },
        id: Date.now()
      })
    });
    if (!response.ok) throw new Error(`Odoo RPC HTTP ${response.status}`);
    const json = await response.json();
    if (json.error) throw new Error(json.error?.data?.message || json.error?.message || "Odoo RPC error");
    return json.result;
  }

  async function expandChatter(maxClicks) {
    const chatterRoot = findChatterRoot();
    if (!chatterRoot) return;
    const patterns = /load more|show more|see more|older|previous|afficher plus|voir plus|charger plus|plus ancien|précédent|meer laden|meer weergeven|vorige/i;
    for (let i = 0; i < maxClicks; i++) {
      const button = Array.from(chatterRoot.querySelectorAll("button, a"))
        .find((el) => isVisible(el) && patterns.test(cleanText(el.innerText || el.getAttribute("aria-label") || el.title || "")));
      if (!button) break;
      button.click();
      await sleep(700);
    }
  }

  function detectOdooState() {
    const params = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    let model = params.get("model") || hash.get("model") || "";
    let resId = params.get("id") || hash.get("id") || "";

    const pathParts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (!model) model = pathParts.find((part) => /^[a-z_]+\.[a-z0-9_.]+$/i.test(part)) || "";
    if (!resId) {
      const numeric = [...pathParts].reverse().find((part) => /^\d+$/.test(part));
      if (numeric) resId = numeric;
    }

    const earlyText = cleanText(document.body.innerText.slice(0, 1600));
    if (!model && /Projects\s*\/\s*Tasks|Project\s+Tasks|Tasks/i.test(earlyText)) model = "project.task";
    return { model, resId };
  }

  /** One line for the status strip: model field `at_a_glance`, or legacy current_status + one_liner. */
  function atAGlanceStatusLine(s) {
    const g = (s?.at_a_glance || "").trim();
    if (g) return g;
    const st = (s?.current_status || "").trim();
    const one = (s?.one_liner || "").trim();
    if (st && one) return `${st}: ${one}`;
    return st || one;
  }

  /** True when the last summary has at least one non-empty replication step (for conditional tab). */
  function hasReplicateSteps(/** @type {any} */ s) {
    if (!s || !Array.isArray(s.replicate_steps)) return false;
    return s.replicate_steps.some((/** @type {string} */ x) => String(x || "").trim().length > 0);
  }

  // Insert/remove the "Replicate Issue" tab when summarize returns steps; drop user back to summary if the tab is removed.
  function syncReplicateTab() {
    const nav = shadow.querySelector(".odcb-tabs");
    if (!nav) return;
    const show = hasReplicateSteps(state.lastSummary);
    const existing = nav.querySelector('button[data-tab="replicate"]');
    if (show) {
      if (!existing) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "odcb-tab";
        btn.dataset.tab = "replicate";
        btn.textContent = "Replicate Issue";
        nav.appendChild(btn);
      }
    } else {
      if (state.activeTab === "replicate") state.activeTab = "summary";
      existing?.remove();
    }
  }

  async function render() {
    await ensurePrStarState();
    syncReplicateTab();
    for (const tab of shadow.querySelectorAll(".odcb-tab")) {
      tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
    }
    const settingsBtn = shadow.querySelector('[data-action="settings"]');
    if (settingsBtn) settingsBtn.classList.toggle("odcb-active", state.activeTab === "settings");
    if (state.activeTab === "summary") await renderSummary();
    else if (state.activeTab === "timeline") renderTimelineTab();
    else if (state.activeTab === "replicate") await renderReplicateTab();
    else await renderSettings();
    updatePrimaryCtaButton();
    updateTimeSavedPill();
  }

  async function renderSummary() {
    const prBanner = buildPrBannerHtml();
    const s = state.lastSummary;
    if (!s) {
      const extract = state.lastExtract;
      body.innerHTML = `${prBanner}
        <div class="odcb-card">
          <h3>Ready</h3>
          <p>Click <strong>Summarize</strong> to create the brief.</p>
          ${extract ? `<p class="odcb-small">${formatExtractStatsLine(extract.stats)}</p>` : ""}
        </div>
        <div class="odcb-card">
          <h3>Detection</h3>
          <div class="odcb-kv">
            <strong>Model</strong><span>${escapeHtml(state.settings.model || "unknown")}</span>
            <strong>Record ID</strong><span>${escapeHtml(state.settings.resId || "unknown")}</span>
            <strong>URL</strong><span><a class="odcb-link" href="${escapeHtml(
              location.href
            )}" target="_blank" rel="noopener noreferrer">${escapeHtml(location.href)}</a></span>
          </div>
        </div>`;
      return;
    }

    // At-a-glance line (from model); fallback for older stored summaries without at_a_glance.
    const statusLine = atAGlanceStatusLine(s);
    const statusBlock =
      statusLine.length > 0
        ? `<div class="odcb-status-snapshot" role="region" aria-label="At-a-glance status">
        <h3>Status</h3>
        <p class="odcb-at-a-glance odcb-richtext">${linkifyToSafeHtml(statusLine)}</p>
      </div>`
        : "";
    body.innerHTML = `${prBanner}
      ${statusBlock}
      <div class="odcb-card">
        <h3>${linkifyToSafeHtml(s.title || "Ticket brief")}</h3>
        <p class="odcb-richtext">${linkifyToSafeHtml(s.issue || "")}</p>
      </div>
      ${renderArrayCard("Important facts", s.important_facts)}
      ${renderArrayCard("Conclusions", s.conclusions)}
      ${renderProgressCard(s.progress)}
      ${renderArrayCard("Customer questions", s.questions_for_customer)}
      ${renderArrayCard("Internal questions", s.questions_for_internal_team)}
      <div class="odcb-card"><h3>Evidence snippets</h3>${renderEvidenceItems(s.evidence)}</div>
    `;
  }

  // Chronological thread only; operational brief stays on the Summary tab
  function renderTimelineTab() {
    const s = state.lastSummary;
    if (!s) {
      body.innerHTML = `<div class="odcb-empty">No summary yet.</div>`;
      return;
    }
    body.innerHTML = `${renderTimeline(s.timeline)}`;
  }

  // Steps to reproduce, only when the model extracted them from the task (tab itself is hidden otherwise).
  async function renderReplicateTab() {
    const s = state.lastSummary;
    if (!s) {
      body.innerHTML = `<div class="odcb-empty">No summary yet.</div>`;
      return;
    }
    if (!hasReplicateSteps(s)) {
      state.activeTab = "summary";
      await render();
      return;
    }
    const items = s.replicate_steps
      .map((/** @type {string} */ x) => String(x || "").trim())
      .filter(Boolean);
    const list = items.map((line) => `<li class="odcb-richtext">${linkifyToSafeHtml(line)}</li>`).join("");
    body.innerHTML = `
      <div class="odcb-card">
        <h3>Replicate the issue</h3>
        <p class="odcb-small">From documentation in the task (chatter, description, customer notes). Re-run <strong>Summarize</strong> if the thread changed.</p>
        <ol class="odcb-replicate-steps">${list}</ol>
      </div>
    `;
  }

  /** One-line copy for the Ready card; clarifies merged vs raw sources. */
  function formatExtractStatsLine(/** @type {any} */ st) {
    if (!st) return "";
    const m = st.messages ?? 0;
    const rpcR = st.rpcMessages ?? 0;
    const domN = st.domMessages ?? 0;
    const mfr = st.mergedFromRpc ?? 0;
    const mfd = st.mergedFromDom ?? 0;
    return `Merged thread: ${m} messages (${mfr} from RPC, ${mfd} from DOM after de-dupe & filters). Scanned: ${rpcR} RPC rows · ${domN} DOM nodes.`;
  }

  /** HTML for the extracted payload (stats + JSON), shown inside Settings accordion. */
  function rawExtractSectionHtml() {
    const extract = state.lastExtract;
    if (!extract) {
      return `<p class="odcb-empty" style="padding:8px 0">Nothing extracted yet.</p>`;
    }
    const st = extract.stats || {};
    return `
      <div class="odcb-card" style="margin-bottom:10px">
        <h3>Stats</h3>
        <div class="odcb-kv">
          <strong>Messages (merged)</strong><span>${escapeHtml(String(st.messages ?? ""))}</span>
          <strong>From RPC in merge</strong><span>${escapeHtml(String(st.mergedFromRpc ?? "—"))}</span>
          <strong>From DOM in merge</strong><span>${escapeHtml(String(st.mergedFromDom ?? "—"))}</span>
          <strong>RPC rows (API)</strong><span>${escapeHtml(String(st.rpcMessages ?? ""))}</span>
          <strong>DOM nodes (scanned)</strong><span>${escapeHtml(String(st.domMessages ?? ""))}</span>
          <strong>Model</strong><span class="odcb-richtext">${linkifyToSafeHtml(String(extract.detected.model || ""))}</span>
          <strong>Record ID</strong><span class="odcb-richtext">${linkifyToSafeHtml(String(extract.detected.resId || ""))}</span>
        </div>
        ${extract.rpc?.error ? `<p class="odcb-danger odcb-richtext">RPC failed: ${linkifyToSafeHtml(extract.rpc.error)}</p>` : ""}
      </div>
      <textarea class="odcb-textarea" readonly>${escapeHtml(JSON.stringify(extract, null, 2))}</textarea>
    `;
  }

  /**
   * Settings tab: fetches the same anonymized JSON block the service worker embeds in the Gemini
   * user turn (after the instructions), so you can diff it from “Raw extract”.
   */
  async function renderSettings() {
    const api = state.apiSettings;
    let sentToApiSection = `<p class="odcb-small" style="margin:0 0 8px">Run <strong>Extract</strong> (toolbar ↻) to load the payload that will accompany the next <strong>Summarize</strong> request.</p>`;
    if (state.lastExtract) {
      try {
        const r = await chrome.runtime.sendMessage({ type: "ODCB_GET_API_DATA_PREVIEW", payload: state.lastExtract });
        if (r && r.ok && typeof r.json === "string") {
          sentToApiSection = `<p class="odcb-small" style="margin:0 0 8px">This JSON is the <strong>Extracted data</strong> part of the user message to Gemini: compacted fields, truncated where noted in code, and <code>«ODCB_…»</code> PII tokens. The instruction / rules text above that block in the real request is not shown here.</p>
        <textarea class="odcb-textarea" readonly aria-label="Data sent to API for analysis">${escapeHtml(r.json)}</textarea>`;
        } else {
          sentToApiSection = `<p class="odcb-danger odcb-richtext">${escapeHtml((r && r.error) || "Could not build API payload preview.")}</p>`;
        }
      } catch (e) {
        sentToApiSection = `<p class="odcb-danger odcb-richtext">${escapeHtml(e?.message || String(e))}</p>`;
      }
    }
    body.innerHTML = `
      <div class="odcb-card">
        <h3>Gemini API settings</h3>
        <label class="odcb-label">Gemini API key</label>
        <input class="odcb-input" type="password" data-api-setting="geminiApiKey" value="${escapeHtml(api.geminiApiKey || "")}" placeholder="AIza...">
        <div class="odcb-small">Saved in <code>chrome.storage.sync</code> on this profile. For stricter org policy, use a server-side proxy instead of a browser key (see <code>README.md</code>).</div>

        <label class="odcb-label">Gemini model</label>
        <input class="odcb-input" data-api-setting="geminiModel" value="${escapeHtml(api.geminiModel || "gemini-3-flash-preview")}" placeholder="gemini-3-flash-preview">

        <div class="odcb-split">
          <div>
            <label class="odcb-label">Summary language</label>
            <select class="odcb-input" data-api-setting="summaryLanguage">
              ${["English", "French", "Dutch"].map((lang) => `<option ${api.summaryLanguage === lang ? "selected" : ""}>${lang}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="odcb-label">Tone</label>
            <input class="odcb-input" data-api-setting="companyTone" value="${escapeHtml(api.companyTone || "precise, practical, support-oriented")}">
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px">
          <button class="odcb-btn odcb-primary" data-action="save-api-settings">Save API settings</button>
          <button class="odcb-btn" data-action="open-options-page">Open extension options page</button>
        </div>
      </div>
      <div class="odcb-card">
        <h3>Extraction settings</h3>
        <p class="odcb-small" style="margin:0 0 8px">Re-run chatter and pad capture without calling Gemini (same as the ↻ toolbar action).</p>
        <button class="odcb-btn" type="button" data-action="extract">Extract only</button>
        <label class="odcb-label"><input type="checkbox" data-setting="useRpc" ${state.settings.useRpc ? "checked" : ""}> Use Odoo RPC when model + record ID are known</label>
        <div class="odcb-small">RPC is more complete than DOM scraping because the chatter may lazy-load older messages. DOM remains the fallback.</div>
        <div class="odcb-split">
          <div><label class="odcb-label">Odoo model</label><input class="odcb-input" data-setting="model" value="${escapeHtml(state.settings.model || "")}" placeholder="project.task"></div>
          <div><label class="odcb-label">Record ID</label><input class="odcb-input" data-setting="resId" value="${escapeHtml(state.settings.resId || "")}" placeholder="12345"></div>
        </div>
        <label class="odcb-label">Max “load more” clicks</label>
        <input class="odcb-input" type="number" min="0" max="50" data-setting="maxLoadMoreClicks" value="${escapeHtml(state.settings.maxLoadMoreClicks)}">
      </div>
      <details class="odcb-details">
        <summary class="odcb-details-summary">Raw extract (debug)</summary>
        <div class="odcb-details-body">${rawExtractSectionHtml()}</div>
      </details>
      <details class="odcb-details">
        <summary class="odcb-details-summary">Sent to API (data only)</summary>
        <div class="odcb-details-body">${sentToApiSection}</div>
      </details>
      <div class="odcb-card">
        <h3>Debug checklist</h3>
        <ul class="odcb-list">
          <li>If the message count is low, set <code>model=project.task</code> plus the task ID from the URL.</li>
          <li>If RPC fails but DOM works, open Raw extract below and copy the error.</li>
          <li>Compare <strong>Raw extract</strong> to <strong>Sent to API</strong> to see truncations, last-200-messages, and PII tokenization on the way to Gemini.</li>
          <li>If DOM extraction is noisy, send the CSS classes around one chatter message and the description pad.</li>
        </ul>
      </div>
    `;
  }

  function renderArrayCard(title, items) {
    if (!items?.length) return "";
    return `<div class="odcb-card"><h3>${escapeHtml(title)}</h3><ul class="odcb-list">${items
      .map((item) => `<li class="odcb-richtext">${linkifyToSafeHtml(item)}</li>`)
      .join("")}</ul></div>`;
  }

  function renderProgressCard(progress) {
    if (!progress) return "";
    return `<div class="odcb-card"><h3>Progress</h3>
      <p class="odcb-richtext">${linkifyToSafeHtml(progress.status || "")}</p>
      ${renderArray("Done", progress.completed)}
      ${renderArray("Remaining", progress.remaining)}
    </div>`;
  }

  function renderTimeline(items) {
    if (!items?.length) {
      return `<div class="odcb-card"><h3>Timeline</h3><p class="odcb-muted">No timeline entries in the model output.</p></div>`;
    }
    return `<div class="odcb-card"><h3>Timeline</h3>${items
      .map(
        (item) => `
      <p class="odcb-richtext"><strong>${linkifyToSafeHtml(item.date || "")}</strong> · ${linkifyToSafeHtml(
        item.actor || "Unknown"
      )}: ${linkifyToSafeHtml(item.event || "")}</p>`
      )
      .join("")}</div>`;
  }

  function renderEvidenceItems(items) {
    if (!items?.length) return `<p class="odcb-muted">No evidence snippets returned.</p>`;
    return items
      .map(
        (item) =>
          `<p class="odcb-richtext"><span class="odcb-pill">${escapeHtml(
            item.source || "source"
          )}</span>${linkifyToSafeHtml(item.quote_or_fact || "")}</p>`
      )
      .join("");
  }

  function renderArray(label, items) {
    if (!items?.length) return "";
    return `<p><strong>${escapeHtml(label)}</strong></p><ul class="odcb-list">${items
      .map((item) => `<li class="odcb-richtext">${linkifyToSafeHtml(item)}</li>`)
      .join("")}</ul>`;
  }

  async function copyMarkdown() {
    const markdown = toMarkdown(state.lastSummary, state.lastExtract);
    await navigator.clipboard.writeText(markdown);
    setBusy(false, "Copied markdown");
    setTimeout(() => setBusy(false), 1000);
  }

  function toMarkdown(s, extract) {
    if (!s) return JSON.stringify(extract || {}, null, 2);
    const lines = [];
    lines.push(`# ${s.title || "Odoo ticket brief"}`);
    lines.push(``);
    lines.push(`**At a glance:** ${atAGlanceStatusLine(s) || "—"}`);
    lines.push(``);
    lines.push(`**Status:** ${s.current_status || "unknown"}`);
    lines.push(`**Severity:** ${s.severity || "unknown"}`);
    lines.push(``);
    lines.push(`## One-liner`);
    lines.push(s.one_liner || "");
    lines.push(``);
    if (hasReplicateSteps(s)) {
      lines.push(`## Replicate the issue`);
      s.replicate_steps
        .map((/** @type {string} */ x) => String(x || "").trim())
        .filter(Boolean)
        .forEach((line, i) => lines.push(`${i + 1}. ${line}`));
      lines.push(``);
    }
    lines.push(`## Issue`);
    lines.push(s.issue || "");
    pushList(lines, "Important facts", s.important_facts);
    pushList(lines, "Conclusions", s.conclusions);
    if (s.progress?.status || s.progress?.completed?.length || s.progress?.remaining?.length) {
      lines.push(`\n## Progress`);
      if (s.progress?.status) lines.push(s.progress.status);
      if (s.progress?.completed?.length) {
        lines.push("Done:");
        for (const x of s.progress.completed) lines.push(`- ${x}`);
      }
      if (s.progress?.remaining?.length) {
        lines.push("Remaining:");
        for (const x of s.progress.remaining) lines.push(`- ${x}`);
      }
    }
    pushList(lines, "Customer questions", s.questions_for_customer);
    pushList(lines, "Internal questions", s.questions_for_internal_team);
    if (s.evidence?.length) {
      lines.push(`\n## Evidence snippets`);
      for (const item of s.evidence) {
        lines.push(`- [${item.source || "source"}] ${item.quote_or_fact || ""}`);
      }
    }
    if (s.timeline?.length) {
      lines.push(`\n## Timeline`);
      for (const item of s.timeline) {
        lines.push(
          `- **${item.date || ""}** · ${item.actor || "Unknown"}: ${item.event || ""}`
        );
      }
    }
    if (s.next_steps?.length) {
      lines.push(`\n### Next steps`);
      for (const step of s.next_steps) {
        lines.push(`- **${step.owner || "Unknown"}** (${step.urgency || ""}): ${step.action || ""} — ${step.reason || ""}`);
      }
    }
    lines.push(`\n---\nGenerated from ${extract?.url || location.href}`);
    return lines.join("\n");
  }

  function pushList(lines, title, items) {
    if (!items?.length) return;
    lines.push(`\n## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
  }

  /**
   * Median adult silent reading speed (English-like text) used for the footer estimate.
   * Word counts use whitespace tokenization, which is closer to real reading time than chars/5.
   */
  const ODCB_READING_WPM = 220;

  function countWords(/** @type {string} */ text) {
    if (!text || typeof text !== "string") return 0;
    const normalized = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized) return 0;
    return normalized.split(" ").length;
  }

  function readingMinutesFromWordCount(/** @type {number} */ wordCount) {
    if (wordCount <= 0) return 0;
    return wordCount / ODCB_READING_WPM;
  }

  /**
   * Text used for "reading time" for one message. DOM rows use the same layout strip as merge so we
   * do not over-count name/date/assignee chrome on the long-read side of the time-saved pill.
   */
  function textForChatterWordCount(/** @type {any} */ m) {
    const raw = String(m?.text ?? m?.body ?? m?.message ?? "");
    if (m?.source === "dom" && m?.author) {
      const s = stripDomChatterNoise(m.author, raw);
      return s || raw;
    }
    return raw;
  }

  /**
   * Chatter + description pad for the “long read” side of the estimate.
   * Uses the **merged** `ex.messages` list (same as the model), not raw DOM node count.
   * Only `message.text` / `body` are summed; DOM uses stripped body when possible (see `textForChatterWordCount`).
   * Fallback to `rawChatterText` only when there is no merged thread (RPC off + no DOM messages).
   */
  function countChatterAndPadWords(/** @type {any} */ ex) {
    if (!ex) return 0;
    const list = ex.messages || [];
    let w = 0;
    for (const m of list) w += countWords(textForChatterWordCount(m));
    if (w === 0 && ex.dom?.rawChatterText && !list.length) w = countWords(String(ex.dom.rawChatterText));
    const desc = ex.dom?.descriptionText;
    if (desc) w += countWords(String(desc));
    return w;
  }

  /**
   * Words in the same content as the Summary tab (excludes timeline / next steps / replicate — those are other tabs
   * or not shown with the main brief, so the “saved time” is not under-counted on the right side.
   */
  function countSummaryPanelBriefWords(/** @type {any} */ s) {
    if (!s) return 0;
    const parts = [s.title, atAGlanceStatusLine(s), s.issue];
    for (const x of s.important_facts || []) parts.push(x);
    for (const x of s.conclusions || []) parts.push(x);
    if (s.progress) {
      if (s.progress.status) parts.push(s.progress.status);
      for (const x of s.progress.completed || []) parts.push(x);
      for (const x of s.progress.remaining || []) parts.push(x);
    }
    for (const x of s.questions_for_customer || []) parts.push(x);
    for (const x of s.questions_for_internal_team || []) parts.push(x);
    for (const e of s.evidence || []) parts.push(`${e?.source || ""} ${e?.quote_or_fact || ""}`.trim());
    return countWords(parts.filter(Boolean).join("\n"));
  }

  // Compares “read the raw thread + pad” vs “read the on-screen brief” (words @ ODCB_READING_WPM).
  function updateTimeSavedPill() {
    const host = shadow.querySelector("[data-odcb-time-saved]");
    if (!host) return;
    if (!state.lastSummary || !state.lastExtract) {
      host.setAttribute("hidden", "");
      host.removeAttribute("title");
      return;
    }
    const wThread = countChatterAndPadWords(state.lastExtract);
    const wBrief = countSummaryPanelBriefWords(state.lastSummary);
    const tThread = readingMinutesFromWordCount(wThread);
    const tBrief = readingMinutesFromWordCount(wBrief);
    const saved = Math.max(0, tThread - tBrief);
    const pill = saved < 0.5 ? "<1 min saved" : `${Math.max(1, Math.round(saved))} min saved`;
    const tip = `~${wThread.toLocaleString()} words in chatter+pad vs ~${wBrief.toLocaleString()} in the main brief; ~${(tThread * 60).toFixed(0)}s vs ~${(tBrief * 60).toFixed(0)}s at ${ODCB_READING_WPM} wpm.`;
    host.removeAttribute("hidden");
    host.innerHTML = `<span class="odcb-time-saved-pill">${escapeHtml(pill)}</span>`;
    host.setAttribute("title", tip);
  }

  function setBusy(isBusy, message) {
    state.busy = isBusy;
    const subtitle = $(".odcb-subtitle");
    if (message) subtitle.textContent = message;
    else subtitle.textContent = "Extract chatter + pad → issue / conclusions / next steps";
    panel.classList.toggle("odcb-busy", isBusy);
    for (const btn of shadow.querySelectorAll(".odcb-actions button, .odcb-header-actions button")) {
      btn.disabled = isBusy;
    }
  }

  function showError(error) {
    body.innerHTML = `<div class="odcb-card"><h3 class="odcb-danger">Error</h3><p class="odcb-richtext">${linkifyToSafeHtml(
      error?.message || String(error)
    )}</p></div>`;
  }

  function getBestText(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = cleanText(element?.innerText || element?.value || "");
      if (text) return text;
    }
    return "";
  }

  function getBestTextIn(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = cleanText(element?.innerText || element?.value || "");
      if (text) return text;
    }
    return "";
  }

  function htmlToText(html) {
    const div = document.createElement("div");
    div.innerHTML = html || "";
    div.querySelectorAll("style, script").forEach((el) => el.remove());
    return cleanText(div.innerText || div.textContent || "");
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeRpcValue(value) {
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "string") return value[1];
      return value.map(normalizeRpcValue).join(", ");
    }
    if (typeof value === "string" && /<[^>]+>/.test(value)) return htmlToText(value);
    return value;
  }

  function unique(list) {
    return Array.from(new Set(list));
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  /**
   * Renders user/model text as safe HTML with clickable http(s) links.
   * Does not treat input as HTML — all tags are escaped except generated <a> wrappers.
   */
  function linkifyToSafeHtml(/** @type {unknown} */ plain) {
    const s = String(plain ?? "");
    if (!s) return "";
    // https? and www. first, then host-only odoo + github/gitlab paths (prefix https)
    const re =
      /(\bhttps?:\/\/[^\s<>"']+)|(\bmailto:[^\s<>"']+)|(\bwww\.[^\s<>"']+)|(\b[\w.-]+\.odoo\.(?:com|sh)(?:\/[^\s<>"']*)?)|(\b(?:github|gitlab)\.com\/[^\s<>"']+)/gi;
    let out = "";
    let last = 0;
    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(s);
      if (!m) break;
      if (m.index > last) out += escapeHtml(s.slice(last, m.index));
      const raw = m[0];
      const href = /^https?:/i.test(raw) || /^mailto:/i.test(raw) ? raw : `https://${raw}`;
      out += `<a class="odcb-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`;
      last = m.index + raw.length;
    }
    out += escapeHtml(s.slice(last));
    return out;
  }
})();
