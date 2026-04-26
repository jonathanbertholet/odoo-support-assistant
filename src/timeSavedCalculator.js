/**
 * “Time saved” for the panel pill: long side = `JSON.stringify` of the same anonymized compact
 * payload as the live API (so it stays consistent with what we send), but **only a fraction** of
 * those tokens are treated as prose; short side = Summary tab text at a slightly **slower** wpm; the
 * minute **gap** is **dampened** so the estimate stays conservative.
 */
import { buildAnonymizedCompactForApi } from "./cleaner.js";

/**
 * Conservative knobs — a flat JSON word count @ one wpm over-claims “time to absorb the ticket”:
 * - JSON has repeated keys / punctuation: only a fraction of whitespace tokens act like prose.
 * - The brief is re-read; use a slightly lower wpm so the right side isn’t unrealistically fast.
 * - The final gap is dampened so the pill under-promises a bit.
 */
const ODCB_WPM_PROSE = 220;
const ODCB_WPM_BRIEF = 200;
const API_JSON_WORD_EFFICACY = 0.45;
const SAVED_MINUTES_DAMPEN = 0.72;
/** @deprecated use ODCB_WPM_PROSE; kept for callers that imported the old name */
export const ODCB_READING_WPM = ODCB_WPM_PROSE;

/**
 * @param {string} text
 * @returns {number}
 */
export function countWords(/** @type {string} */ text) {
  if (!text || typeof text !== "string") return 0;
  const normalized = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  return normalized.split(" ").length;
}

/**
 * @param {number} wordCount
 * @returns {number} minutes
 */
export function readingMinutesFromWordCount(/** @type {number} */ wordCount) {
  if (wordCount <= 0) return 0;
  return wordCount / ODCB_WPM_PROSE;
}

/**
 * @param {number} wordCount
 * @param {number} wpm
 * @returns {number} minutes
 */
function minutesForWords(/** @type {number} */ wordCount, /** @type {number} */ wpm) {
  if (wordCount <= 0 || wpm <= 0) return 0;
  return wordCount / wpm;
}

/**
 * One line for the status strip: model `at_a_glance`, or legacy `current_status` + `one_liner`.
 * Kept in sync with the Summary tab and markdown export.
 * @param {any} s
 * @returns {string}
 */
function atAGlanceStatusLine(/** @type {any} */ s) {
  const g = (s?.at_a_glance || "").trim();
  if (g) return g;
  const st = (s?.current_status || "").trim();
  const one = (s?.one_liner || "").trim();
  if (st && one) return `${st}: ${one}`;
  return st || one;
}

/**
 * Words in the same content as the Summary tab (excludes timeline / next steps / replicate).
 * @param {any} s
 * @returns {number}
 */
export function countSummaryPanelBriefWords(/** @type {any} */ s) {
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

/**
 * Word count of the **anonymized compact** object (same pipeline as the live Gemini request’s data
 * block, including «ODCB_…» tokens). `JSON.stringify` makes this align with the literal payload size
 * the model conditions on, after dedupe/truncation/PII.
 * @param {any} rawExtract
 * @returns {number}
 */
export function countWordsInAnonymizedApiData(/** @type {any} */ rawExtract) {
  if (!rawExtract) return 0;
  const { compactPayload } = buildAnonymizedCompactForApi(rawExtract);
  return countWords(JSON.stringify(compactPayload));
}

/**
 * @param {any} rawExtract
 * @param {any} summary
 * @returns {{ pillLabel: string, titleTooltip: string, wordsThread: number, wordsBrief: number, minutesThread: number, minutesBrief: number, minutesSaved: number } | null}
 */
export function getTimeSavedEstimate(/** @type {any} */ rawExtract, /** @type {any} */ summary) {
  if (!rawExtract || !summary) return null;
  const wThreadRaw = countWordsInAnonymizedApiData(rawExtract);
  const wBrief = countSummaryPanelBriefWords(summary);
  // Long side: discount JSON “words” (braces, keys) then @ prose wpm. Short side: slightly slower wpm.
  const wThreadEff = wThreadRaw * API_JSON_WORD_EFFICACY;
  const tThread = minutesForWords(wThreadEff, ODCB_WPM_PROSE);
  const tBrief = minutesForWords(wBrief, ODCB_WPM_BRIEF);
  const rawSaved = Math.max(0, tThread - tBrief);
  const saved = rawSaved * SAVED_MINUTES_DAMPEN;
  const pillLabel = saved < 0.5 ? "<1 min saved" : `${Math.max(1, Math.round(saved))} min saved`;
  // Short hover: the pill uses discounted JSON “reading”, slower brief wpm, then dampen on the gap.
  const titleTooltip = `~${wThreadRaw.toLocaleString()} words in API JSON (counted as ${Math.round(
    API_JSON_WORD_EFFICACY * 100
  )}% reading load @ ${ODCB_WPM_PROSE} wpm) vs ~${wBrief.toLocaleString()} in brief @ ${ODCB_WPM_BRIEF} wpm; ≈${(tThread * 60).toFixed(0)}s vs ≈${(tBrief * 60).toFixed(0)}s, gap ×${SAVED_MINUTES_DAMPEN} for the pill.`;
  return {
    pillLabel,
    titleTooltip,
    wordsThread: wThreadRaw,
    wordsBrief: wBrief,
    minutesThread: tThread,
    minutesBrief: tBrief,
    minutesSaved: saved
  };
}
