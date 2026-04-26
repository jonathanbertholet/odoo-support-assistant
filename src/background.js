const DEFAULT_MODEL = "gemini-3-flash-preview";

const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    severity: { type: "STRING" },
    /** One scannable line for the panel status strip (e.g. "PRs awaiting merge: fix in review"). */
    at_a_glance: { type: "STRING" },
    one_liner: { type: "STRING" },
    current_status: { type: "STRING" },
    issue: { type: "STRING" },
    conclusions: { type: "ARRAY", items: { type: "STRING" } },
    progress: {
      type: "OBJECT",
      properties: {
        status: { type: "STRING" },
        completed: { type: "ARRAY", items: { type: "STRING" } },
        remaining: { type: "ARRAY", items: { type: "STRING" } }
      }
    },
    next_steps: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          owner: { type: "STRING" },
          action: { type: "STRING" },
          reason: { type: "STRING" },
          urgency: { type: "STRING" }
        }
      }
    },
    questions_for_customer: { type: "ARRAY", items: { type: "STRING" } },
    questions_for_internal_team: { type: "ARRAY", items: { type: "STRING" } },
    timeline: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          actor: { type: "STRING" },
          event: { type: "STRING" }
        }
      }
    },
    important_facts: { type: "ARRAY", items: { type: "STRING" } },
    evidence: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          source: { type: "STRING" },
          quote_or_fact: { type: "STRING" }
        }
      }
    },
    /**
     * Ordered steps to reproduce the issue when the task documents them; otherwise [].
     * Intentionally optional so the model can return an empty list with no tab in the panel.
     */
    replicate_steps: { type: "ARRAY", items: { type: "STRING" } }
  },
  /* conclusions is optional (empty [] when not needed); important_facts is required (may be []). */
  required: [
    "title",
    "severity",
    "at_a_glance",
    "one_liner",
    "current_status",
    "issue",
    "progress",
    "next_steps",
    "timeline",
    "important_facts",
    "evidence"
  ]
};

const CUSTOM_CS_ID_PREFIX = "odcb-orig-";

/**
 * Re-registers the content script on user-granted self-hosted / custom Odoo origins.
 * Built-in `*.odoo.com`, `*.odoo.sh`, and common `localhost` / `127.0.0.1` ports (80, 8069, 8080, 3000, 8000) are in manifest.
 * For any other self-hosted origin (e.g. `http://localhost:9999/`), the user adds it under Options and grants access so we register a content script.
 */
async function syncCustomContentScripts() {
  const { odcbCustomOrigins = [] } = await chrome.storage.local.get("odcbCustomOrigins");
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const toDrop = (existing || []).map((r) => r.id).filter((id) => id && id.startsWith(CUSTOM_CS_ID_PREFIX));
    if (toDrop.length) await chrome.scripting.unregisterContentScripts({ ids: toDrop });
  } catch {
    // getRegistered can fail in edge builds; re-registering would duplicate — rare.
  }
  for (const match of odcbCustomOrigins) {
    if (typeof match !== "string" || !match || !match.startsWith("http")) continue;
    const has = await chrome.permissions.contains({ origins: [match] });
    if (!has) continue;
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: customContentScriptIdForMatch(match),
          matches: [match],
          js: ["contentScript.js"],
          runAt: "document_idle"
        }
      ]);
    } catch {
      // Duplicate id on race; one registration per match is enough.
    }
  }
}

function customContentScriptIdForMatch(/** @type {string} */ match) {
  let h = 2166136261;
  for (let i = 0; i < match.length; i++) h = Math.imul(h ^ match.charCodeAt(i), 16777619);
  return `${CUSTOM_CS_ID_PREFIX}${(h >>> 0).toString(16)}`;
}

chrome.runtime.onInstalled.addListener(() => {
  void syncCustomContentScripts();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "ODCB_OPEN_OPTIONS") {
    try {
      chrome.runtime.openOptionsPage(() => {
        const err = chrome.runtime.lastError;
        sendResponse(err ? { ok: false, error: err.message } : { ok: true });
      });
    } catch (error) {
      sendResponse({ ok: false, error: cleanError(error) });
    }
    return true;
  }

  if (message.type === "ODCB_SYNC_CUSTOM_CONTENT_SCRIPTS") {
    syncCustomContentScripts()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: cleanError(error) }));
    return true;
  }

  if (message.type !== "ODCB_SUMMARIZE") return false;

  summarize(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: cleanError(error) }));

  return true;
});

/**
 * Shared placeholder prefix — model instructions require copying these tokens verbatim
 * in quotes so we can rehydrate PII in finalizeSummaryJson.
 */
const PII_TOKEN_PREFIX = "ODCB_";

/**
 * Mutable state: assigns stable «ODCB_…» tokens per (kind, original) for deduplication
 * and stores token → original for one-way rehydration after the API returns.
 */
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
      const n = ++next[kind];
      const token = `«${PII_TOKEN_PREFIX}${kind}${n}»`;
      byKindValue.set(k, token);
      tokenToOriginal[token] = o;
      return token;
    },
    /** Whole author / actor line: one token, same person → same line → same token. */
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

// One pass each; order avoids nested confusion (emails do not look like E.164).
const PII_EMAIL_RE = /[a-zA-Z0-9._%+\-][a-zA-Z0-9._%+\-]*@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}/g;
const PII_E164_RE = /\+[1-9]\d{6,14}\b/g;
// Customer DB hostnames in descriptions (e.g. acme-corp.odoo.com); keep simple so we do not match odd paths.
const PII_ODOO_HOST_RE = /\b[\w-]+\.odoo\.com\b/gi;
// Obvious private IPv4; keeps internal host references out of the cloud request.
const PII_PRIVATE_IP_RE =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

/**
 * Replaces inline emails, E.164 phones, *.odoo.com subdomains, and private IPs in one string.
 */
function anonymizeInlineStrings(/** @type {string} */ s, /** @type {ReturnType<typeof createPiiTokenState>} */ state) {
  if (!s || typeof s !== "string") return s;
  let out = s.replace(PII_EMAIL_RE, (m) => state.tokenFor("E", m));
  out = out.replace(PII_E164_RE, (m) => state.tokenFor("P", m));
  out = out.replace(PII_ODOO_HOST_RE, (m) => state.tokenFor("D", m));
  out = out.replace(PII_PRIVATE_IP_RE, (m) => state.tokenFor("I", m));
  return out;
}

/**
 * Recurses the compact payload: message `author` and timeline `actor` are fully tokenized;
 * all other string values get inline PII tokenization.
 */
function applyPiiTokenizationToTree(/** @type {any} */ root, state) {
  const WHOLE = new Set(["author", "actor"]);
  function walk(/** @type {any} */ v, /** @type {string | null} */ key) {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walkChild(v, i, v[i]);
    } else if (typeof v === "object") {
      for (const k of Object.keys(v)) walkChild(v, k, v[k]);
    }
  }
  function walkChild(/** @type {any} */ parent, /** @type {string | number} */ k, /** @type {any} */ val) {
    if (val === null || val === undefined) return;
    if (typeof val === "string") {
      if (typeof k === "string" && WHOLE.has(k)) {
        parent[k] = val.trim() ? state.authorOrActor(val) : val;
      } else {
        parent[k] = anonymizeInlineStrings(val, state);
      }
      return;
    }
    walk(val, typeof k === "string" ? k : null);
  }
  walk(root, null);
}

/**
 * Replaces «ODCB_*» tokens in any string in the generated JSON, longest-first, so ODCB_10
 * does not break before ODCB_1.
 */
function restorePiiPlaceholders(/** @type {any} */ root, /** @type {Record<string, string> | null} */ tokenToOriginal) {
  if (!tokenToOriginal) return;
  const tokens = Object.keys(tokenToOriginal);
  if (!tokens.length) return;
  tokens.sort((a, b) => b.length - a.length);
  function patch(s) {
    if (typeof s !== "string" || !s) return s;
    let out = s;
    for (const t of tokens) {
      if (out.includes(t)) out = out.split(t).join(tokenToOriginal[t]);
    }
    return out;
  }
  function rec(/** @type {any} */ v) {
    if (v === null || v === undefined) return;
    if (typeof v === "string") return; // not used at root
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

/** Build the request body for generateContent (JSON schema). */
function buildSummaryRequestBody(prompt) {
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.15,
      responseMimeType: "application/json",
      responseSchema: SUMMARY_SCHEMA
    }
  };
}

/**
 * Inflates «ODCB_*» placeholders back to real author lines, phones, etc. after the model
 * (hopefully) copied them into the structured JSON.
 */
function finalizeSummaryJson(/** @type {string} */ text, /** @type {Record<string, string> | null} */ tokenToOriginal) {
  const parsed = parseJson(text);
  // No generation timestamp; panel and markdown omit metadata blocks.
  // Optional in schema: normalize so the content script can render without assuming keys exist.
  if (!Array.isArray(parsed.important_facts)) parsed.important_facts = [];
  if (!Array.isArray(parsed.conclusions)) parsed.conclusions = [];
  // Optional field: normalize so the content script can treat missing as no steps.
  if (!Array.isArray(parsed.replicate_steps)) parsed.replicate_steps = [];
  restorePiiPlaceholders(parsed, tokenToOriginal);
  return parsed;
}

async function summarize(payload) {
  const settings = await chrome.storage.sync.get(["geminiApiKey", "geminiModel", "summaryLanguage", "companyTone"]);
  const apiKey = settings.geminiApiKey;
  const model = settings.geminiModel || DEFAULT_MODEL;
  const language = settings.summaryLanguage || "English";
  const tone = settings.companyTone || "precise, practical, support-oriented";

  if (!apiKey) {
    throw new Error("Gemini API key missing. Open the extension options and save your API key.");
  }

  const { prompt, tokenToOriginal } = buildPrompt(payload, language, tone);
  // Non-streaming: Google's Gemini API returns one full GenerateContentResponse from
  // `:generateContent`. Streaming is a separate method (`:streamGenerateContent` + `alt=sse`).
  // See: https://ai.google.dev/gemini-api/docs/text-generation ("By default, the model returns
  // a response only after the entire generation process is complete.")
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = buildSummaryRequestBody(prompt);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API returned ${response.status}: ${errText.slice(0, 1200)}`);
  }

  const json = await response.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
  if (!text.trim()) throw new Error("Gemini returned an empty response.");

  return finalizeSummaryJson(text, tokenToOriginal);
}

/**
 * @returns {{ prompt: string, tokenToOriginal: Record<string, string> }}
 */
function buildPrompt(payload, language, tone) {
  const compactPayload = compactForPrompt(payload);
  const pii = createPiiTokenState();
  applyPiiTokenizationToTree(compactPayload, pii);
  const tokenToOriginal = pii.getTokenToOriginal();

  return {
    tokenToOriginal,
    prompt: `You are an expert Odoo support analyst. Read the extracted Odoo task/form data, the pad/description, chatter, emails, log notes, status changes and logs.

Goal: produce a clear operational brief for a support colleague who opens a long ticket and needs to understand it fast.

Rules:
- Respond in ${language}.
- Tone: ${tone}.
- **Placeholder tokens (critical):** The JSON may include tokens like «ODCB_E1» (emails), «ODCB_P1» (phone numbers in E.164 form), «ODCB_A1» (message author/actor line), «ODCB_D1» (Odoo hostnames), «ODCB_I1» (private IPs). These stand in for real identifiers we redacted before sending. You **must** copy the exact same «…» token whenever you refer to the same fact, quote, or person in **important_facts**, **evidence** (source and quote_or_fact), **timeline** (actor, event if needed), and **next_steps** — do not type real email addresses, phone numbers, or personal names; keep the tokens so downstream tooling can restore them. Do not invent or substitute real PII.
- Separate verified facts from interpretations.
- Do not invent technical root causes.
- When the customer is waiting, make that obvious.
- Where there is no «ODCB_…» token, preserve important dates, amounts, order references, database names, ticket IDs, URLs, app names, module names, model names, traceback fragments, payment provider references, and reproduction steps.
- If evidence is weak or missing, say so in the evidence array (brief quotes only).
- For next steps, assign a likely owner: Support, Customer, Developer, Platform, Functional, or Unknown.
- at_a_glance: exactly one line for a quick support triage strip. Format: short state label, colon+space, then a very brief situation hint (no more than about 20 words). Examples: "Under investigation: reproducing on customer DB", "PRs awaiting merge: calendar invite template", "Fix deployed: 16.0 backport in staging". It must read like a status headline, not a full summary.
- replicate_steps: ordered, actionable steps to reproduce the issue or observe the behavior, only from what is documented in the thread (description, customer messages, internal notes, logs with repro sequences). If nothing in the data describes how to reproduce, return an empty array []. Do not fabricate or guess steps. One string per step; keep each step short.
- Do not include separate risks/watchouts or suggested customer reply fields (those are not part of the output).
- important_facts vs conclusions: **important_facts** is required (always include the field) = verified, stance-neutral facts; use [] only if there are truly no discrete facts. **conclusions** is optional in meaning: short synthesis only when you add value; may be [] or omitted from overlap. **Never repeat the same or nearly the same point in both**—if a bullet would exist in both, keep it in one only (prefer important_facts for raw facts, conclusions for synthesis). If the thread is thin, put facts in important_facts and leave conclusions as []. It is better to return [] for conclusions than to pad or duplicate.

Extracted data:
${JSON.stringify(compactPayload, null, 2)}`
  };
}

/**
 * Strips near-duplicate messages (same body, different DOM sub-node extractions) so the model
 * does not see the same paragraph five times. Key is normalized message text, not author/date.
 */
function dedupeMessagesByText(messages) {
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

function compactForPrompt(payload) {
  const clone = JSON.parse(JSON.stringify(payload || {}));

  if (Array.isArray(clone.messages)) {
    const sliced = dedupeMessagesByText(clone.messages).slice(-200);
    clone.messages = sliced.map((m, index) => {
      const subj = (m.subject && String(m.subject).trim()) ? truncate(m.subject, 160) : "";
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
    // Merged+deduped thread is in `messages`; the DOM copy is usually redundant and noisy.
    delete clone.dom.messages;
    clone.dom.formText = truncate(clone.dom.formText, 5000);
    clone.dom.descriptionText = truncate(clone.dom.descriptionText, 5000);
    // Redundant with structured `messages` and often a huge source of DOM duplicates; omit to save context.
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
      if (typeof clone.rpc.record[key] === "string") clone.rpc.record[key] = truncate(clone.rpc.record[key], 3000);
    }
  }

  return clone;
}

function truncate(value, max) {
  if (!value) return value;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch (error) {
      throw new Error(`Could not parse Gemini JSON. First 500 chars: ${text.slice(0, 500)}`);
    }
  }
}

function cleanError(error) {
  return error?.message || String(error || "Unknown error");
}
