# Privacy policy — Odoo Support Assistant

Last updated: April 24, 2026.

This document describes what the **Odoo Support Assistant** browser extension (the “Extension”) does with your data. It is intended for the Chrome Web Store (or similar) listings and for users who install the open source build from a public source repository. If you install from source, the same rules apply to that build.

## Who we are

The Extension is distributed as open source. There is no separate backend “we” that receives your data except where **you** point the Extension (e.g. to Google’s generative language API using **your** API key).

## What the Extension accesses

- **On Odoo pages** (or sites you add under “Custom Odoo site” in options), the content script reads what is available in the open tab: form fields, chatter, description/pad, and (optionally) `mail.message` data via the same Odoo **JSON-RPC** endpoint your browser already uses. This is used to build a text payload and show you a panel in the page.
- **Storage** (Chrome `storage.sync` and `storage.local` on your device):
  - Your **Gemini API key**, model, language, and tone (sync).
  - **Starred tasks / PRs** and kanban state for the toolbar popup (local).
  - A **fingerprinted cache** of the last generated briefs for up to **200** record keys (local), so you are not always re-calling the model when nothing changed.
  - **Optional** panel position (local).
- **API calls**: When you click **Summarize** (or equivalent), the Extension sends the **extracted task text** from your current tab to **Google’s Gemini API** using the key you provided. Google’s handling of that request is covered by [Google’s terms and privacy policy](https://ai.google.dev/terms) for the product you use (e.g. Google AI Studio / Gemini API).

## What we do not do

- We do not sell your data.
- We do not add remote analytics or third-party tracking in the Extension.
- The Extension has **no** separate server of its own. Your brief is not sent to a project-owned database.

## Data sent to Google (Gemini)

The payload is built from the visible Odoo task (chatter, description, form snippets, and optional RPC message bodies). It may include **personal or business** information that appears in the ticket. You should not summarize tickets you are not allowed to process under your own policies.

## Custom Odoo site permission

For self-hosted Odoo, you may **grant the Extension access** to a specific origin. Only origins you add (and only after you accept Chrome’s permission prompt) are used to inject the same content script. You can remove a site in the options page, which also revokes the optional host permission for that pattern where supported.

## Children

The Extension is not directed at children.

## Changes

We may update this file in the repository when behavior changes. The store listing will link to the current version in the default branch of the public repo.

## Contact

For privacy questions about this open source project, open an issue in the [GitHub repository](https://github.com/jonathanbertholet/odoo-support-assistant) or the contact method published there by the maintainers.
