import { buildAnonymizedCompactForApi, getApiDataPreviewJson, restorePiiPlaceholders } from "./cleaner.js";

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

  if (message.type === "ODCB_GET_API_DATA_PREVIEW") {
    try {
      const json = getApiDataPreviewJson(message.payload);
      sendResponse({ ok: true, json });
    } catch (error) {
      sendResponse({ ok: false, error: cleanError(error) });
    }
    return true;
  }

  if (message.type !== "ODCB_SUMMARIZE") return false;

  summarize(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: cleanError(error) }));

  return true;
});

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
  const { compactPayload, tokenToOriginal } = buildAnonymizedCompactForApi(payload);

  return {
    tokenToOriginal,
    prompt: `You are an expert Odoo support analyst. Read the extracted Odoo task/form data, the pad/description, chatter, emails, log notes, status changes and logs.

Goal: produce a clear operational brief for a support colleague who opens a long ticket and needs to understand it fast.

Rules:
- Respond in ${language}.
- Tone: ${tone}.
- **Placeholder tokens (critical):** The JSON may include tokens like «ODCB_E1» (emails), «ODCB_P1» (E.164 phones), «ODCB_A1» (chatter author, timeline actor, and Odoo 19+ partner / customer / user display names in rpc.record, e.g. partner_id), «ODCB_D1» (odoo.com hostnames), «ODCB_I1» (private IPs). These stand in for identifiers we redacted. You **must** copy the exact same «…» token when referring to the same fact or party in **important_facts**, **evidence**, **timeline**, and **next_steps** — do not re-type real PII. Do not invent identities.
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
