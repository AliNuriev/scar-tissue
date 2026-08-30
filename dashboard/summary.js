/**
 * summary.js — pure decision logic for the Scar Tissue dashboard.
 *
 * Contains small functions that have no DOM, no fetch, and no side-effects,
 * so they can be required directly by node:test tests without any shim.
 *
 * Works in both environments:
 *   - Browser: loaded as a plain <script> before app.js; attaches exports to
 *     globalThis so app.js can call the functions directly.
 *   - Node tests: require('./summary.js') and use the returned object.
 */

'use strict';

/**
 * Distinguish "a repo-relative path to an artifact file" from "the artifact
 * content inlined directly in the run JSON".
 *
 * A value is treated as a path when it:
 *   - is a non-empty string shorter than 300 characters
 *   - contains no newlines (inlined content almost always has newlines)
 *   - matches a simple path pattern: starts with a word char, contains only
 *     word chars, dots, slashes, @ and hyphens, and ends with a file extension
 *
 * @param {*}       value  Any artifact field value from the run JSON.
 * @returns {boolean}
 */
function looksLikePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length < 300
    && !value.includes('\n')
    && /^[\w][\w./@-]*\.[A-Za-z0-9]+$/.test(value);
}

/**
 * Count runs by status — returns counts for the three known statuses.
 * Unknown statuses are ignored (they are rendered but not counted for
 * disagreement checking, because summary.json does not track them either).
 *
 * @param {Array}  runs  Array of run objects (from the run files).
 * @returns {{ immunized: number, needs_review: number, failed: number }}
 */
function classifyRunCounts(runs) {
  const counts = { immunized: 0, needs_review: 0, failed: 0 };
  for (const r of (runs ?? [])) {
    const s = r.status;
    if (s === 'immunized' || s === 'needs_review' || s === 'failed') {
      counts[s] += 1;
    }
  }
  return counts;
}

/**
 * Compare the status counts in summary.json with what the run files actually
 * show. Returns an array of human-readable mismatch strings (empty when they
 * agree).
 *
 * @param {object} summary  The parsed summary.json object (may be null).
 * @param {Array}  runs     Array of run objects.
 * @returns {string[]}      Mismatch descriptions; empty array when all agree.
 */
function checkCounts(summary, runs) {
  if (!summary) return [];
  const actual = classifyRunCounts(runs);
  const pairs = [
    ['incidents_immunized',   'immunized'],
    ['incidents_needs_review','needs_review'],
    ['incidents_failed',      'failed'],
  ];
  const mismatches = [];
  for (const [key, k] of pairs) {
    const v = summary[key];
    if (typeof v === 'number' && Number.isFinite(v) && v !== actual[k]) {
      mismatches.push(`${key} says ${v}, run files show ${actual[k]}`);
    }
  }
  return mismatches;
}

/**
 * Format a prevention rate (0–1) as a percentage string for the hero display,
 * e.g. 0.75 → "75%". Returns "—" when the value is missing or not finite.
 *
 * @param {*}      rate  The prevention_rate field from summary.json.
 * @returns {string}
 */
function formatPreventionRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/* ------------------------------------------------------------------ export */

/* Browser: attach to globalThis so app.js can call the functions directly.
 * Node: module.exports allows require('./summary.js').looksLikePath etc. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { looksLikePath, classifyRunCounts, checkCounts, formatPreventionRate };
} else {
  /* eslint-disable-next-line no-undef */
  globalThis.looksLikePath       = looksLikePath;
  /* eslint-disable-next-line no-undef */
  globalThis.classifyRunCounts   = classifyRunCounts;
  /* eslint-disable-next-line no-undef */
  globalThis.checkCounts         = checkCounts;
  /* eslint-disable-next-line no-undef */
  globalThis.formatPreventionRate = formatPreventionRate;
}
