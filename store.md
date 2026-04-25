# Chrome Web Store — listing copy (draft)

Use the sections below in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole). Replace `YOUR_GITHUB_USER` with the real repo path after publish.

## Short description (max ~132 characters)

**Suggested (132 chars):**

> AI briefs for Odoo: summarize chatter, pad, and mail into a support-ready panel. Star tasks & PRs, cache, optional self-hosted Odoo.

## Detailed description (long)

**Odoo Support Assistant** helps support and project teams get through long Odoo form threads faster. It adds an **AI brief** action next to the chatter **Send message** control and opens a **compact panel** with:

- **Summary** — issue, important facts, conclusions, progress, questions, and evidence, structured for triage
- **Timeline** and optional **Replicate issue** (when the thread documents clear steps)
- **Copy as markdown** for pasting in Slack, Linear, or internal docs
- **PR links** in the thread, with stars so you can track fixes from the **toolbar popup** (kanban by task)
- **Estimated time saved** (reading-time heuristic vs. scrolling the full thread and pad)
- **Cached briefs** (up to 200 recent tasks) when chatter metadata hasn’t changed, with **Regenerate** / **Refresh** as appropriate
- **Draggable** panel

**Data & AI:** you bring your own **Google Gemini** API key (saved in your Chrome profile). The extension sends extracted text from the **current** Odoo record to the Gemini API when you run **Summarize** — it does not use a project-owned server.

**Where it works:** out of the box on **odoo.com**, **odoo.sh**, and **localhost / 127.0.0.1** development URLs. For **on‑prem or private hostnames**, open the extension’s **options** and use **“Grant & add site”** to approve a single origin (your `https://erp.example.com` style URL). Only origins you add are injected; you can remove them later.

**Open source & license:** MIT. **Homepage / repository:** [github.com/jonathanbertholet/odoo-support-assistant](https://github.com/jonathanbertholet/odoo-support-assistant)

**Privacy policy:** see `privacy.md` in the repository (link this URL in the store’s privacy policy field).

## Category

Productivity

## Trademarks

“Odoo” is a trademark of Odoo S.A. This extension is an independent, community project and is not affiliated with or endorsed by Odoo S.A.

Before you submit, add at least a **128×128** icon and wire `icons` + `action.default_icon` in `manifest.json` (the Web Store also wants promotional images; see the dashboard).

## Screenshots (checklist)

- Toolbar popup with kanban and starred task / PRs
- In-page **Summary** with status strip and evidence
- Options: Gemini + **Custom Odoo site** row
- (Optional) Timeline tab

## Single purpose (store justification)

The extension’s single purpose is to assist users working in Odoo by summarizing the current record’s chatter and related form text and presenting that summary in the browser, with optional starring of follow-up links.

## Permissions (plain language for review)

- **storage** — save API key preferences, cache of briefs, panel position, and starred items locally.
- **scripting** — register the same content script on user-approved custom Odoo origins.
- **host_permissions** (declared) — call Google’s Gemini API and run on public Odoo host patterns.
- **optional_host_permissions** (`<all_urls>`) — so the user can **opt in** to one origin at a time for private Odoo; the extension only requests the origins the user adds in options.

## Support / contact

GitHub issues on the public repository (set after upload).
