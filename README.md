# Odoo Support Assistant

A **Manifest V3** Chrome extension that adds an **AI brief** next to the Odoo chatter **Send message** button and opens a **draggable, tabbed panel** on the form. It reads the current record’s **description / pad**, **chatter** (optionally the full `mail.message` history via the same **JSON-RPC** your session already has), and optional form context, then calls **Google Gemini** with a structured schema to produce a **support triage brief** (summary, status strip, questions, evidence, timeline, and more when applicable).

- **No separate backend** — you configure your own **Gemini API key** in the extension (or options page). Payloads are sent to **Google’s generative language API** from your browser when you run **Summarize**.

## Features (high level)

- Inline **AI brief** launcher when a chatter with **Send message** is present
- **Summary**, **Timeline**, optional **Replicate issue**; **Settings**; **Copy markdown**; **estimated time saved** (heuristic)
- **Star** tasks to the **toolbar popup** (kanban by task) and star **PRs** in the brief banner; drag **panel** position (persisted)
- **Local cache** of generated briefs (fingerprinted by chatter/pad **metadata**; up to **200** tickets) with **Regenerate** / **Refresh** when the extract is stale
- **Self‑hosted / custom Odoo**: in **options**, use **“Grant & add site”** to approve a single origin; the same content script is registered for that host only
- **Built‑in** matches: `*.odoo.com`, `*.odoo.sh`, `http://localhost:*`, `http://127.0.0.1:*`

## Install (development, unpacked)

1. Clone this repository.
2. Open `chrome://extensions` → **Developer mode** → **Load unpacked** → select the repository folder.
3. Open the extension’s **options** (or the panel’s **Settings** → **Open extension options**).
4. Enter your [Gemini API key](https://aistudio.google.com/apikey) and **Save** (stored in `chrome.storage.sync`).

For a **private Odoo URL** (e.g. `https://odoo.intranet.example`), add the origin in options and accept Chrome’s site-access prompt. Reload the Odoo tab.

## First run on a long ticket

1. Open a task form with a busy chatter and description.
2. Click **AI brief** (or open the panel from the same control area).
3. In **Settings**, confirm model / res id / **Use Odoo RPC** if you want full `mail.message` history.
4. Use **Extract** (header ↻) if needed, then **Summarize**.

## Project layout

| File | Role |
|------|------|
| `manifest.json` | MV3: permissions, host patterns, `scripting` + optional origins for custom Odoo |
| `contentScript.js` | In-page UI, extract/merge, panel, storage cache, inline launcher |
| `background.js` | Gemini `generateContent` (JSON schema) + dynamic content script registration for custom origins |
| `options.html` / `options.js` | API key, model, language, custom Odoo site list + permission flow |
| `popup.html` / `popup.js` | Starred PRs by task, kanban |
| `privacy.md` | Privacy policy for the store (link in listing) |
| `store.md` | Draft **Chrome Web Store** text |
| `LICENSE` | MIT |

## Security & production use

- Storing a **Gemini** key in `chrome.storage.sync` is appropriate for **personal** or small-team use. For enterprise policies, the usual step is a **server-side** proxy: authenticate the user, keep API keys and logs on your side, and optionally **redact** PII before calling a model. The direct client-side path is the default in this repo to stay zero-backend.

- **You** are responsible for not summarizing tickets that your organization forbids to send to a third party (Google).

## Trademarks

**Odoo** is a trademark of [Odoo S.A.](https://www.odoo.com) This project is an independent, open source tool and is not affiliated with or endorsed by Odoo S.A.

## License

[MIT](LICENSE)
