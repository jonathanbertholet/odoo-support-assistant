const FIELDS = ["geminiApiKey", "geminiModel", "summaryLanguage", "companyTone"];
const CUSTOM_ORIGINS_KEY = "odcbCustomOrigins";

init();

document.getElementById("save").addEventListener("click", onSave);
document.getElementById("addSite").addEventListener("click", onAddCustomSite);

/** Hostnames already served by the extension’s static content_scripts. */
function isCoveredByBuiltInHostname(/** @type {string} */ host) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1") return true;
  if (h === "odoo.com" || h.endsWith(".odoo.com")) return true;
  if (h.endsWith(".odoo.sh")) return true;
  return false;
}

/**
 * @param {string} userInput
 * @returns {URL}
 */
function parseUserSiteUrl(userInput) {
  const t = String(userInput).trim();
  if (!t) throw new Error("Enter a site URL");
  return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
}

/** e.g. https://a.com:8080/* */
function toOriginMatch(/** @type {URL} */ u) {
  if (!u.protocol || !/^https?:$/.test(u.protocol)) throw new Error("Only http and https are supported");
  return `${u.origin}/*`;
}

function setSiteStatus(/** @type {string} */ t, isError) {
  const el = document.getElementById("siteStatus");
  if (!el) return;
  el.textContent = t;
  el.className = isError ? "hint danger" : "hint";
}

async function onAddCustomSite() {
  setSiteStatus("");
  let u;
  try {
    u = parseUserSiteUrl(document.getElementById("userOdooUrl")?.value || "");
  } catch (e) {
    setSiteStatus((/** @type {Error} */ (e))?.message || "Invalid URL", true);
    return;
  }
  if (isCoveredByBuiltInHostname(u.hostname)) {
    setSiteStatus("This host is already included. No need to add it.", true);
    return;
  }
  const match = toOriginMatch(u);
  try {
    // User gesture: Chrome shows a permission dialog for this origin.
    const granted = await /** @type {any} */ (chrome.permissions.request)({ origins: [match] });
    if (!granted) {
      setSiteStatus("Permission was not granted. The extension was not added for this site.", true);
      return;
    }
    const { [CUSTOM_ORIGINS_KEY]: list = [] } = await chrome.storage.local.get(CUSTOM_ORIGINS_KEY);
    const next = Array.from(new Set([...list, match].filter((x) => typeof x === "string" && x)));
    await chrome.storage.local.set({ [CUSTOM_ORIGINS_KEY]: next });
    document.getElementById("userOdooUrl").value = "";
    await renderCustomSiteList();
    const r = await chrome.runtime.sendMessage({ type: "ODCB_SYNC_CUSTOM_CONTENT_SCRIPTS" });
    if (r && !r.ok) throw new Error(r.error || "Register failed");
    setSiteStatus("Added. Reload your Odoo tab to pick up the content script on that origin.");
  } catch (e) {
    setSiteStatus(/** @type {Error} */ (e)?.message || String(e), true);
  }
}

async function onRemoveCustomSite(match) {
  setSiteStatus("");
  try {
    await /** @type {any} */ (chrome.permissions.remove)({ origins: [match] });
    const { [CUSTOM_ORIGINS_KEY]: list = [] } = await chrome.storage.local.get(CUSTOM_ORIGINS_KEY);
    const next = list.filter((x) => x !== match);
    await chrome.storage.local.set({ [CUSTOM_ORIGINS_KEY]: next });
    await renderCustomSiteList();
    const r = await chrome.runtime.sendMessage({ type: "ODCB_SYNC_CUSTOM_CONTENT_SCRIPTS" });
    if (r && !r.ok) throw new Error(r.error || "Unregister failed");
    setSiteStatus("Removed. Reload any open tab on that site if the panel was already loaded.");
  } catch (e) {
    setSiteStatus(/** @type {Error} */ (e)?.message || String(e), true);
  }
}

async function renderCustomSiteList() {
  const { [CUSTOM_ORIGINS_KEY]: list = [] } = await chrome.storage.local.get(CUSTOM_ORIGINS_KEY);
  const ul = document.getElementById("customSiteList");
  if (!ul) return;
  ul.replaceChildren();
  for (const match of list) {
    if (typeof match !== "string") continue;
    const li = document.createElement("li");
    const has = await /** @type {any} */ (chrome.permissions.contains)({ origins: [match] });
    const code = document.createElement("code");
    code.textContent = match;
    code.title = has ? "Permission granted" : "Permission missing from browser — re-add or remove and add again";
    if (!has) code.style.opacity = "0.65";
    li.appendChild(code);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "remove-site";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => void onRemoveCustomSite(match));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

async function onSave() {
  const values = {};
  for (const field of FIELDS) {
    const el = document.getElementById(field);
    values[field] = el ? el.value.trim() : "";
  }
  await chrome.storage.sync.set(values);
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "Saved";
    setTimeout(() => (status.textContent = ""), 2000);
  }
}

async function init() {
  const values = await chrome.storage.sync.get(FIELDS);
  for (const field of FIELDS) {
    const el = document.getElementById(field);
    if (el && values[field]) el.value = values[field];
  }
  await renderCustomSiteList();
}
