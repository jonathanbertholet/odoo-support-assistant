/**
 * Odoo Support Assistant — data processing for the Gemini request.
 * Single place for: pad/header stripping, compact payload, truncation, and PII-style tokenization
 * before the API, plus restore in the service worker. Iterate here when Odoo (e.g. 19) changes how
 * read() returns relational fields.
 */

// ——————————————————————————————————————————————————————————————————
// 1) Pad / description (helpdesk “Phone / Edition / …” preamble)
// ——————————————————————————————————————————————————————————————————

function tryStripGluedV4Header(/** @type {string} */ t) {
  if (!/^\s*Phone:\s*/i.test(t)) return null;
  const m = t.match(
    /^\s*Phone:\s*([+0-9\s().-]{5,32})\s*Edition:\s*(.+?)\s*Dbname:\s*(.+?)\s*Version:\s*(\d+\.\d+(?:\+[a-z0-9]+)?)(?=[A-Z][a-z]|[\r\n]|$)/is
  );
  if (m) return t.slice(m[0].length).trim() || t.slice(m[0].length);
  return null;
}

function tryStripLineBasedHeader(/** @type {string} */ t) {
  const lines = t.split(/\r?\n/);
  if (lines.length < 4) return null;
  const want = [/^phone\s*:/i, /^edition\s*:/i, /^dbname\s*:/i, /^version\s*:/i];
  for (let i = 0; i < 4; i++) {
    if (!want[i].test((lines[i] || "").trim())) return null;
  }
  return lines.slice(4).join("\n").trim();
}

/**
 * @returns {string} description text with the support pad header removed when detected
 */
export function cleanDescriptionForModel(/** @type {string} */ raw) {
  if (raw == null || raw === undefined) return "";
  const s = String(raw);
  if (!s.length) return s;
  const t = s.trim();
  if (!/^\s*Phone:\s*/i.test(t) && !t.slice(0, 300).toLowerCase().includes("phone:")) return s;

  const glued = tryStripGluedV4Header(t);
  if (glued != null) return glued;

  const oneLine = t.replace(/\r?\n+/g, " ").replace(/\s{2,}/g, " ");
  if (oneLine.length !== t.length) {
    const g2 = tryStripGluedV4Header(oneLine.trim());
    if (g2 != null) return g2;
  }

  const byLines = tryStripLineBasedHeader(t);
  if (byLines != null) return byLines;

  return s;
}

/**
 * @returns {{ text: string, didStrip: boolean }}
 */
export function stripOdooTaskPadPreamble(/** @type {string} */ raw) {
  const before = String(raw ?? "");
  const after = cleanDescriptionForModel(before);
  return { text: after, didStrip: after !== before };
}

// ——————————————————————————————————————————————————————————————————
// 2) Truncation + message dedupe (before tokenization)
// ——————————————————————————————————————————————————————————————————

function truncate(/** @type {any} */ value, /** @type {number} */ max) {
  if (value == null) return value;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

/**
 * Strips near-duplicate messages (same body, different DOM sub-node extractions).
 */
function dedupeMessagesByText(/** @type {any[]} */ messages) {
  if (!Array.isArray(messages)) return [];
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    const key = String(m.text || m.body || "")
      .replace(/\s+/g, " ")
      .toLowerCase()
      .trim()
      .slice(0, 520);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// ——————————————————————————————————————————————————————————————————
// 3) Compact JSON for the “Extracted data:” model block
// ——————————————————————————————————————————————————————————————————

/**
 * @param {any} payload raw extract from the content script
 * @returns {any} deep clone, truncated fields, no extra keys — ready for PII pass
 */
export function compactForPrompt(/** @type {any} */ payload) {
  const clone = JSON.parse(JSON.stringify(payload || {}));

  if (Array.isArray(clone.messages)) {
    const sliced = dedupeMessagesByText(clone.messages).slice(-200);
    clone.messages = sliced.map((m, index) => {
      const subj = m.subject && String(m.subject).trim() ? truncate(m.subject, 160) : "";
      return {
        index: m.index ?? index + 1,
        source: m.source || "chatter",
        id: m.id,
        date: truncate(m.date, 60),
        author: truncate(m.author, 80),
        kind: truncate(m.kind, 60),
        ...(subj ? { subject: subj } : {}),
        text: truncate(m.text || m.body || "", 1000)
      };
    });
  }

  if (clone.dom) {
    delete clone.dom.messages;
    clone.dom.formText = truncate(clone.dom.formText, 5000);
    clone.dom.descriptionText = truncate(cleanDescriptionForModel(String(clone.dom.descriptionText || "")), 5000);
    if (Array.isArray(clone.messages) && clone.messages.length > 0) {
      delete clone.dom.rawChatterText;
    } else {
      clone.dom.rawChatterText = truncate(clone.dom.rawChatterText, 8000);
    }
    if (Array.isArray(clone.dom.metadata) && clone.dom.metadata.length > 40) {
      clone.dom.metadata = clone.dom.metadata.slice(0, 40);
    }
  }

  if (clone.rpc?.record) {
    for (const key of Object.keys(clone.rpc.record)) {
      if (typeof clone.rpc.record[key] === "string") {
        let v = clone.rpc.record[key];
        if (key === "description" || (v.includes("Phone:") && v.includes("Dbname:"))) v = cleanDescriptionForModel(v);
        clone.rpc.record[key] = truncate(v, 3000);
      }
    }
  }

  return clone;
}

// ——————————————————————————————————————————————————————————————————
// 4) PII / identity tokens (inline + whole field)
// ——————————————————————————————————————————————————————————————————

const PII_TOKEN_PREFIX = "ODCB_";

function createPiiTokenState() {
  const tokenToOriginal = Object.create(null);
  /** @type {Map<string, string>} */
  const byKindValue = new Map();
  const next = { E: 0, P: 0, A: 0, D: 0, I: 0 };
  return {
    /** @param {'E'|'P'|'A'|'D'|'I'} kind @param {string} original */
    tokenFor(kind, original) {
      const o = String(original);
      const k = `${kind}\0${o}`;
      if (byKindValue.has(k)) return byKindValue.get(k);
      const n = ++next[/** @type {keyof typeof next} */ (kind)];
      const token = `«${PII_TOKEN_PREFIX}${kind}${n}»`;
      byKindValue.set(k, token);
      tokenToOriginal[token] = o;
      return token;
    },
    authorOrActor(/** @type {string} */ s) {
      const t = String(s).trim();
      if (!t) return s;
      return this.tokenFor("A", t);
    },
    getTokenToOriginal() {
      return tokenToOriginal;
    }
  };
}

const PII_EMAIL_RE = /[a-zA-Z0-9._%+\-][a-zA-Z0-9._%+\-]*@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-z0-9])?\.[a-zA-Z]{2,}/g;
const PII_E164_RE = /\+[1-9]\d{6,14}\b/g;
const PII_ODOO_HOST_RE = /\b[\w-]+\.odoo\.com\b/gi;
const PII_PRIVATE_IP_RE =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

function anonymizeInlineStrings(/** @type {string} */ s, /** @type {ReturnType<typeof createPiiTokenState>} */ state) {
  if (!s || typeof s !== "string") return s;
  let out = s.replace(PII_EMAIL_RE, (m) => state.tokenFor("E", m));
  out = out.replace(PII_E164_RE, (m) => state.tokenFor("P", m));
  out = out.replace(PII_ODOO_HOST_RE, (m) => state.tokenFor("D", m));
  out = out.replace(PII_PRIVATE_IP_RE, (m) => state.tokenFor("I", m));
  return out;
}

/** Chatter / timeline. */
const WHOLE_AUTHOR_KEYS = new Set(["author", "actor"]);

/**
 * Odoo 19+ read() often returns many2one labels as a plain string (e.g. partner_id: "Acme, Jane Doe").
 * Tokenize the whole value when it looks like a display name, not a bare id list.
 */
const REDACT_REL_DISPLAY_KEYS = new Set([
  "partner_id",
  "commercial_partner_id",
  "partner_shipping_id",
  "partner_invoice_id",
  "customer_id",
  "user_id"
]);

/**
 * @param {string} v
 * @returns {boolean} true if we should replace the string with a name token
 */
function shouldTokenizeRelDisplayString(/** @type {string} */ v) {
  const t = String(v).trim();
  if (!t) return false;
  // Pure numeric ids, or csv of ids only (many2many stringified in 19+)
  if (/^\d+(\s*,\s*\d+)*$/.test(t)) return false;
  // Contains letters → treat as a label (company/person/team)
  return /[A-Za-zÀ-ÿ]/.test(t);
}

function applyPiiTokenizationToTree(/** @type {any} */ root, /** @type {ReturnType<typeof createPiiTokenState>} */ state) {
  function walk(/** @type {any} */ v) {
    if (v === null || v === undefined) return;
    if (typeof v === "string") return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walkChild(v, i, v[i]);
    } else if (typeof v === "object") {
      for (const k of Object.keys(v)) walkChild(v, k, v[k]);
    }
  }
  function walkChild(/** @type {any} */ parent, /** @type {string | number} */ k, /** @type {any} */ val) {
    if (val === null || val === undefined) return;
    if (typeof val === "string") {
      if (typeof k === "string") {
        if (WHOLE_AUTHOR_KEYS.has(k) || (REDACT_REL_DISPLAY_KEYS.has(k) && shouldTokenizeRelDisplayString(val))) {
          parent[k] = val.trim() ? state.authorOrActor(val) : val;
        } else {
          parent[k] = anonymizeInlineStrings(val, state);
        }
      } else {
        parent[k] = anonymizeInlineStrings(val, state);
      }
      return;
    }
    walk(val);
  }
  walk(root);
}

/**
 * Inflates «ODCB_*» in the model JSON (longest token first).
 * @param {any} root
 * @param {Record<string, string> | null} tokenToOriginal
 */
export function restorePiiPlaceholders(/** @type {any} */ root, /** @type {Record<string, string> | null} */ tokenToOriginal) {
  if (!tokenToOriginal) return;
  const tokens = Object.keys(tokenToOriginal);
  if (!tokens.length) return;
  tokens.sort((a, b) => b.length - a.length);
  function patch(/** @type {string} */ s) {
    if (typeof s !== "string" || !s) return s;
    let out = s;
    for (const t of tokens) {
      if (out.includes(t)) out = out.split(t).join(tokenToOriginal[t]);
    }
    return out;
  }
  function rec(/** @type {any} */ v) {
    if (v === null || v === undefined) return;
    if (typeof v === "string") return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === "string") v[i] = patch(v[i]);
        else rec(v[i]);
      }
    } else if (typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (typeof v[k] === "string") v[k] = patch(v[k]);
        else rec(v[k]);
      }
    }
  }
  rec(root);
}

/**
 * @returns {{ compactPayload: object, tokenToOriginal: Record<string, string> }}
 */
export function buildAnonymizedCompactForApi(/** @type {any} */ payload) {
  const compactPayload = compactForPrompt(payload);
  const pii = createPiiTokenState();
  applyPiiTokenizationToTree(compactPayload, pii);
  return { compactPayload, tokenToOriginal: pii.getTokenToOriginal() };
}

/**
 * @returns {string} pretty JSON for “Sent to API”
 */
export function getApiDataPreviewJson(/** @type {any} */ payload) {
  const { compactPayload } = buildAnonymizedCompactForApi(payload);
  return JSON.stringify(compactPayload, null, 2);
}
