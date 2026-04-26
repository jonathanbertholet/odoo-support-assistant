/**
 * Normalizes helpdesk / pad preambles on Odoo task descriptions. Support tickets often
 * start with a glued block (no newlines) like:
 *   Phone: +44…Edition: onlineDbname: foo.odoo.comVersion: 19.0+eHi, please see…
 * Those technical header lines are poor signal for the brief and bloat the prompt; we
 * remove them and keep the user narrative. Safe to re-run (no-op if the pattern is absent).
 */

/**
 * Tries a single RegExp for the four-field “Phone → Edition → Dbname → Version” run,
 * with Version ending before a capital letter that starts a word (e.g. “Hi,”).
 * @param {string} t trimmed input
 * @returns {string | null} text after the block, or null if this pattern does not match
 */
function tryStripGluedV4Header(/** @type {string} */ t) {
  if (!/^\s*Phone:\s*/i.test(t)) return null;
  // Phone: E.164-ish; then Edition, Dbname, Version (often concatenated with no newlines);
  // Version: semver + optional +suffix (e.g. 19.0+e) — stop before a word like “Hi,”.
  const m = t.match(
    /^\s*Phone:\s*([+0-9\s().-]{5,32})\s*Edition:\s*(.+?)\s*Dbname:\s*(.+?)\s*Version:\s*(\d+\.\d+(?:\+[a-z0-9]+)?)(?=[A-Z][a-z]|[\r\n]|$)/is
  );
  if (m) return t.slice(m[0].length).trim() || t.slice(m[0].length);
  return null;
}

/**
 * When the glued string does not match, remove the first four lines if they are exactly
 * Phone / Edition / Dbname / Version (in that order, case-insensitive).
 * @param {string} t
 * @returns {string | null} remainder or null
 */
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
  if (!/^\s*Phone:\s*/i.test(t) && !t.toLowerCase().includes("phone:")) {
    // Fast path: no “Phone:” in the first ~200 chars
    if (!t.slice(0, 300).toLowerCase().includes("phone:")) return s;
  }

  const glued = tryStripGluedV4Header(t);
  if (glued != null) return glued;

  // Sometimes there are newlines; try glued on first line-joined minified
  const oneLine = t.replace(/\r?\n+/g, " ").replace(/\s{2,}/g, " ");
  if (oneLine.length !== t.length) {
    const g2 = tryStripGluedV4Header(oneLine.trim());
    if (g2 != null) {
      // Restore remaining line breaks haphazardly: keep a single \n for readability
      return g2;
    }
  }

  const byLines = tryStripLineBasedHeader(t);
  if (byLines != null) return byLines;

  return s;
}

/**
 * Exposed for tests / UI if we later need structured header fields.
 * @param {string} raw
 * @returns {{ text: string, didStrip: boolean }}
 */
export function stripOdooTaskPadPreamble(/** @type {string} */ raw) {
  const before = String(raw ?? "");
  const after = cleanDescriptionForModel(before);
  return { text: after, didStrip: after !== before };
}
