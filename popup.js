// Starred PRs from the page, grouped by ticket (task). Each kanban card = one task; PRs are rows inside the card.
// A row with prUrl === ODCB_TASK_STAR_URL is “star the whole task” (matches contentScript).
// Column state is per ticket (`odcbPrKanbanV2`). Done uses <details> (folded) with a narrow vertical label when closed.
const ODCB_TASK_STAR_URL = "__odcb_task_star__";
const STORAGE_STARRED = "odcbStarredPrs";
const STORAGE_KANBAN = "odcbPrKanbanV2";
const STORAGE_KANBAN_LEGACY = "odcbPrKanbanV1";
const DND_MIME = "application/x-odcb-pr-kanban";

const COLS = /** @type {const} */ (["new", "in_progress", "done"]);
/** @type {Record<string, (typeof COLS)[number]>} */
let kanbanState = {};
/** @type {string | null} */
let dragPacked = null;

function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "className") node.className = v;
      else if (k === "textContent") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== undefined) node.setAttribute(k, v);
    }
  }
  if (children) {
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node;
}

/** Stable id for a ticket (all PRs on the same task share this key). */
function packTicketId(ticketKey) {
  return btoa(unescape(encodeURIComponent(ticketKey || "unknown")));
}

function unpackPairFromLegacyPacked(packed) {
  const raw = JSON.parse(decodeURIComponent(escape(atob(packed))));
  return { ticketKey: raw[0], prUrl: raw[1] };
}

async function loadRows() {
  const { [STORAGE_STARRED]: list = [] } = await chrome.storage.local.get(STORAGE_STARRED);
  return Array.isArray(list) ? list : [];
}

/** Load V2; if empty, migrate from V1 (per-PR keys) to per-ticket keys. */
async function loadKanban() {
  const { [STORAGE_KANBAN]: v2 = {}, [STORAGE_KANBAN_LEGACY]: v1 = {} } = await chrome.storage.local.get([
    STORAGE_KANBAN,
    STORAGE_KANBAN_LEGACY
  ]);
  kanbanState = v2 && typeof v2 === "object" ? { ...v2 } : {};
  for (const k of Object.keys(kanbanState)) {
    if (!COLS.includes(kanbanState[k])) delete kanbanState[k];
  }
  // Re-key any V2 entries that still use the old per-PR packed id to per-ticket ids.
  const rekeyed = /** @type {Record<string, (typeof COLS)[number]>} */ ({});
  let rekeyTouched = false;
  for (const [k, col] of Object.entries(kanbanState)) {
    if (!COLS.includes(col)) continue;
    let nk = k;
    try {
      const dec = JSON.parse(decodeURIComponent(escape(atob(k))));
      if (Array.isArray(dec) && dec.length >= 2) {
        nk = packTicketId(String(dec[0]));
        if (nk !== k) rekeyTouched = true;
      }
    } catch {
      // already per-ticket key
    }
    rekeyed[nk] = col; // last duplicate wins
  }
  kanbanState = rekeyed;
  if (rekeyTouched) await saveKanban();
  if (Object.keys(kanbanState).length === 0 && v1 && typeof v1 === "object" && Object.keys(v1).length) {
    const byTicket = /** @type {Record<string, (typeof COLS)[number]>} */ ({});
    for (const [packed, col] of Object.entries(v1)) {
      if (!COLS.includes(col)) continue;
      try {
        const { ticketKey } = unpackPairFromLegacyPacked(packed);
        byTicket[packTicketId(ticketKey)] = col;
      } catch {
        // ignore bad legacy entries
      }
    }
    kanbanState = byTicket;
    await chrome.storage.local.set({ [STORAGE_KANBAN]: kanbanState });
  }
}

async function saveKanban() {
  await chrome.storage.local.set({ [STORAGE_KANBAN]: kanbanState });
}

/**
 * @param {Array<{ ticketKey: string, prUrl: string, prLabel?: string, pageTitle?: string, ticketUrl?: string, starredAt?: string }>} rows
 */
function groupRowsByTicket(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = r.ticketKey || "unknown";
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  for (const [, arr] of map) {
    arr.sort((a, b) => String(b.starredAt).localeCompare(String(a.starredAt)));
  }
  return map;
}

function isTaskOnlyRow(/** @type {{ prUrl?: string }} */ r) {
  return !!(r && r.prUrl === ODCB_TASK_STAR_URL);
}

/** @param {Map<string, object[]>} map */
function toTaskList(map) {
  return [...map.entries()].map(([ticketKey, items]) => {
    const best = items.find((r) => r.prUrl && r.prUrl !== ODCB_TASK_STAR_URL) || items[0];
    return {
      ticketKey,
      items,
      pageTitle: best?.pageTitle || "Ticket",
      ticketUrl: best?.ticketUrl || "#"
    };
  });
}

function columnForTask(ticketKey) {
  const id = packTicketId(ticketKey);
  const c = kanbanState[id];
  if (c === "new" || c === "in_progress" || c === "done") return c;
  return "new";
}

/**
 * @param {ReturnType<typeof toTaskList>} taskList
 */
function groupTasksByColumn(taskList) {
  /** @type {Record<(typeof COLS)[number], typeof taskList>} */
  const out = { new: [], in_progress: [], done: [] };
  for (const t of taskList) {
    out[columnForTask(t.ticketKey)].push(t);
  }
  return out;
}

/**
 * One card per ticket: task title, optional unstar, then any starred PR rows (no block when there are none).
 * @param {{ ticketKey: string, pageTitle: string, ticketUrl: string, items: any[] }} task
 */
function renderTaskCard(task) {
  const packed = packTicketId(task.ticketKey);
  const card = el("div", { className: "kanban-card", draggable: "true" });
  const hasTaskStar = task.items.some(isTaskOnlyRow);
  const prItems = task.items.filter((r) => !isTaskOnlyRow(r));
  const metaRow = prItems[0] || task.items[0];
  const titleRow = el("div", { className: "kanban-task-title-row" });
  const headMain = el("div", { className: "kanban-task-head" });
  headMain.appendChild(
    el("a", {
      className: "kanban-task-title",
      href: task.ticketUrl,
      target: "_blank",
      rel: "noopener noreferrer"
    }, [task.pageTitle])
  );
  if (metaRow?.model || metaRow?.resId) {
    const meta = [metaRow.model, metaRow.resId].filter(Boolean).join(" · ");
    if (meta) headMain.appendChild(el("div", { className: "kanban-task-meta", textContent: meta }));
  }
  titleRow.appendChild(headMain);
  if (hasTaskStar) {
    titleRow.appendChild(
      el("button", {
        type: "button",
        className: "kanban-unstar-task",
        title: "Remove the task from the popup (starring the title bar) — does not unstar individual PRs",
        textContent: "✕",
        onclick: async (e) => {
          e.stopPropagation();
          e.preventDefault();
          await unstar(task.ticketKey, ODCB_TASK_STAR_URL);
          await refresh();
        }
      })
    );
  }
  card.appendChild(titleRow);
  if (prItems.length) {
    const prsBlock = el("div", { className: "kanban-prs-block" });
    for (const item of prItems) {
      const prLine = el("div", { className: "kanban-pr-line" });
      prLine.appendChild(
        el("a", {
          className: "kanban-pr-link",
          href: item.prUrl,
          target: "_blank",
          rel: "noopener noreferrer"
        }, [item.prLabel || item.prUrl])
      );
      prLine.appendChild(
        el("button", {
          type: "button",
          className: "kanban-pr-unstar",
          title: "Remove star for this PR",
          textContent: "✕",
          onclick: async (e) => {
            e.stopPropagation();
            e.preventDefault();
            await unstar(item.ticketKey, item.prUrl);
            await refresh();
          }
        })
      );
      prsBlock.appendChild(prLine);
    }
    card.appendChild(prsBlock);
  }
  card.dataset.packed = packed;
  return card;
}

// Whole column (including title / folded Done bar) is the drop target.
function renderDropColumn(key, label, taskList) {
  const col = el("section", { className: "kanban-col", "data-col": key });
  const h = el("h2", { className: "kanban-h" });
  h.appendChild(document.createTextNode(label));
  h.appendChild(el("span", { className: "ct", textContent: `(${taskList.length})` }));
  const drop = el("div", { className: "kanban-drop" });
  for (const t of taskList) drop.appendChild(renderTaskCard(t));
  if (!taskList.length) drop.appendChild(el("div", { className: "empty-kanban", textContent: "—" }));
  col.appendChild(h);
  col.appendChild(drop);
  return col;
}

function renderDoneColumn(taskList) {
  const details = el("details", { className: "kanban-col kanban-col-done", "data-col": "done" });
  const sum = el("summary", { className: "kanban-done-summary" });
  // Vertical compact label when closed; layout switches to horizontal when [open] (see CSS).
  const vwrap = el("span", { className: "kanban-done-vlabel" });
  vwrap.appendChild(el("span", { className: "kanban-done-vtext", textContent: "Done" }));
  vwrap.appendChild(el("span", { className: "kanban-done-vcount", textContent: String(taskList.length) }));
  const hCount = el("span", { className: "kanban-done-htext" });
  hCount.appendChild(document.createTextNode("Done "));
  hCount.appendChild(el("span", { className: "ct", textContent: `(${taskList.length})` }));
  sum.appendChild(vwrap);
  sum.appendChild(hCount);
  const drop = el("div", { className: "kanban-drop" });
  for (const t of taskList) drop.appendChild(renderTaskCard(t));
  if (!taskList.length) drop.appendChild(el("div", { className: "empty-kanban", textContent: "—" }));
  details.appendChild(sum);
  details.appendChild(drop);
  return details;
}

function columnTargetFromEvent(/** @type {Event} */ e) {
  const t = e.target;
  if (!t || typeof /** @type {any} */ (t).closest !== "function") return null;
  const node = /** @type {HTMLElement} */ (t).closest("[data-col]");
  if (!node || node.closest?.(".kanban-card")) return null;
  return node;
}

function setupDragDelegation(root) {
  root.ondragstart = (e) => {
    const card = e.target && /** @type {HTMLElement} */ (e.target).closest?.(".kanban-card");
    if (!card || !root.contains(card)) return;
    const packed = card.dataset.packed;
    if (!packed) return;
    dragPacked = packed;
    e.dataTransfer.setData(DND_MIME, packed);
    e.dataTransfer.effectAllowed = "move";
    if (e.dataTransfer) e.dataTransfer.setData("text/plain", "");
  };
  root.ondragend = () => {
    dragPacked = null;
    for (const elx of root.querySelectorAll(".kanban-dragover")) elx.classList.remove("kanban-dragover");
  };
  const highlight = (e, on) => {
    const z = columnTargetFromEvent(e);
    if (!z || !root.contains(z)) return;
    z.classList.toggle("kanban-dragover", on);
  };
  root.ondragenter = (e) => {
    if (columnTargetFromEvent(e)) e.preventDefault();
    highlight(e, true);
  };
  root.ondragleave = (e) => {
    const z = columnTargetFromEvent(e);
    if (e.relatedTarget && z && z.contains(/** @type {Node} */ (e.relatedTarget))) return;
    highlight(e, false);
  };
  root.ondragover = (e) => {
    if (columnTargetFromEvent(e)) e.preventDefault();
  };
  root.ondrop = async (e) => {
    const z = columnTargetFromEvent(e);
    if (!z || !root.contains(z)) return;
    e.preventDefault();
    z.classList.remove("kanban-dragover");
    const packed = e.dataTransfer.getData(DND_MIME) || dragPacked;
    if (!packed) return;
    const col = z.getAttribute("data-col");
    if (col !== "new" && col !== "in_progress" && col !== "done") return;
    if (z.tagName === "DETAILS" && col === "done") /** @type {HTMLDetailsElement} */ (z).open = true;
    kanbanState[packed] = col;
    await saveKanban();
    const rows = await loadRows();
    fillKanban(root, rows);
  };
}

/**
 * Renders the mini kanban: New | In progress | Done (folded <details> with compact vertical tab when closed).
 * @param {HTMLElement} root
 * @param {Array<{ ticketKey: string, prUrl: string, prLabel?: string, pageTitle?: string, ticketUrl?: string, model?: string, resId?: string, starredAt?: string }>} rows
 */
function fillKanban(root, rows) {
  root.replaceChildren();
  if (!rows.length) {
    root.appendChild(
      el("p", { className: "empty" }, [
        "Nothing saved yet. Open the Chatter brief on a task: use ☆/★ in the title bar to save the task, and stars next to each PR in the PRs section to save links."
      ])
    );
    return;
  }
  const map = groupRowsByTicket(rows);
  const taskList = toTaskList(map);
  const grouped = groupTasksByColumn(taskList);
  const k = el("div", { className: "kanban" });
  k.appendChild(renderDropColumn("new", "New", grouped.new));
  k.appendChild(renderDropColumn("in_progress", "In progress", grouped.in_progress));
  k.appendChild(renderDoneColumn(grouped.done));
  root.appendChild(k);
}

async function unstar(ticketKey, prUrl) {
  const rows = await loadRows();
  const next = rows.filter((r) => !(r.ticketKey === ticketKey && r.prUrl === prUrl));
  await chrome.storage.local.set({ [STORAGE_STARRED]: next });
  const stillThisTicket = next.filter((r) => r.ticketKey === ticketKey);
  if (stillThisTicket.length === 0) {
    const tid = packTicketId(ticketKey);
    if (kanbanState[tid] !== undefined) {
      delete kanbanState[tid];
      await saveKanban();
    }
  }
}

async function refresh() {
  const rows = await loadRows();
  await loadKanban();
  const root = document.getElementById("root");
  if (!root) return;
  fillKanban(root, rows);
  setupDragDelegation(root);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_STARRED] || changes[STORAGE_KANBAN] || changes[STORAGE_KANBAN_LEGACY]) refresh();
});

refresh();
