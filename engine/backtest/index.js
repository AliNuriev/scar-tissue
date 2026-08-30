#!/usr/bin/env node
/**
 * engine/backtest/index.js
 *
 * Backtest harness: for each of the 12 incidents, run every active guardrail's
 * detection regex against ONLY the source files mapped to that incident.
 * Writes runs/summary.json and prints a results table to stdout.
 *
 * An incident can be in one of three states:
 *   prevented          — a guardrail regex matched its mapped source file(s)
 *   not_prevented      — mapped files exist, no guardrail matched
 *   not_yet_processed  — no mapping, no mapped files on disk, or no run file;
 *                        excluded from the denominator
 *
 * Usage:
 *   node engine/backtest/index.js [--sandbox <path>]
 *
 * The sandbox path defaults to "sandbox/" relative to the repo root.
 * If the path does not exist the harness reports the problem clearly and exits.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const GUARDRAILS_DIR = path.join(REPO_ROOT, 'guardrails');
const RUNS_DIR       = path.join(REPO_ROOT, 'runs');
const INCIDENTS_DIR  = path.join(REPO_ROOT, 'incidents');
const INCIDENT_MAP   = path.join(__dirname, 'incident-map.json');

// All 12 known incident IDs — iterated even when no run file exists yet.
const ALL_INCIDENT_IDS = [
  'INC-001', 'INC-002', 'INC-003', 'INC-004',
  'INC-005', 'INC-006', 'INC-007', 'INC-008',
  'INC-009', 'INC-010', 'INC-011', 'INC-012',
];

// ── frontmatter parser ────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown string.
 * Handles inline arrays and double-quoted strings with backslash escapes.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const result = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val   = line.slice(idx + 1).trim();

    // inline array  e.g.  source_incidents: [INC-001, INC-002]
    if (val.startsWith('[') && val.endsWith(']')) {
      result[key] = val
        .slice(1, -1)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      continue;
    }

    // strip surrounding quotes; unescape YAML double-quoted escape sequences
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\\\/g, '\\');
    } else if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }

    result[key] = val;
  }
  return result;
}

// ── loaders ───────────────────────────────────────────────────────────────────

/** Load and parse every active .md guardrail from guardrails/. */
function loadActiveGuardrails() {
  const guardrails = [];
  for (const entry of fs.readdirSync(GUARDRAILS_DIR)) {
    if (!entry.endsWith('.md') || entry.startsWith('_')) continue;
    const content = fs.readFileSync(path.join(GUARDRAILS_DIR, entry), 'utf8');
    const fm      = parseFrontmatter(content);
    if (!fm) {
      console.warn(`[warn] Could not parse frontmatter in ${entry}, skipping.`);
      continue;
    }
    if (fm.status !== 'active') continue;

    let regex = null;
    try {
      regex = new RegExp(fm.detection || '', 's');
    } catch (e) {
      console.warn(`[warn] Invalid regex in ${entry}: ${e.message}`);
      continue;
    }

    guardrails.push({
      id:               fm.id        || '',
      bug_class:        fm.bug_class || '',
      source_incidents: Array.isArray(fm.source_incidents)
        ? fm.source_incidents
        : fm.source_incidents ? [fm.source_incidents] : [],
      regex,
    });
  }
  return guardrails;
}

/** Load the incident → source-file mapping. */
function loadIncidentMap() {
  try {
    return JSON.parse(fs.readFileSync(INCIDENT_MAP, 'utf8'));
  } catch (e) {
    console.warn(`[warn] Could not load incident-map.json: ${e.message}`);
    return {};
  }
}

/**
 * Load a run JSON file for an incident, or null if none exists.
 * @param {string} incidentId
 */
function loadRunFile(incidentId) {
  const p = path.join(RUNS_DIR, `${incidentId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`[warn] Could not parse ${incidentId}.json: ${e.message}`);
    return null;
  }
}

/**
 * Read source files listed in the incident map, resolved under sandboxPath.
 * Returns null when none of the mapped files exist on disk.
 */
function readMappedFiles(sandboxPath, relativeFiles) {
  const contents = [];
  for (const rel of relativeFiles) {
    const abs = path.join(sandboxPath, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      contents.push(fs.readFileSync(abs, 'utf8'));
    } catch {
      // unreadable — skip
    }
  }
  return contents.length > 0 ? contents.join('\n') : null;
}

// ── core ──────────────────────────────────────────────────────────────────────

function runBacktest(sandboxPath) {
  // 1. Sandbox path check — must exist (may be empty)
  if (!fs.existsSync(sandboxPath)) {
    console.error(`[error] Sandbox path not found: ${sandboxPath}`);
    console.error('        Populate the sandbox or pass --sandbox <path>.');
    process.exit(1);
  }

  // 2. Load guardrails and incident map
  const guardrails  = loadActiveGuardrails();
  const incidentMap = loadIncidentMap();

  if (guardrails.length === 0) {
    console.warn('[warn] No active guardrails found in guardrails/. Nothing to test.');
  }

  // 3. Score every incident
  // Each entry: { id, bugClass, state, caughtBy, runStatus, manualBaselineSec }
  //   state: 'prevented' | 'not_prevented' | 'not_yet_processed'
  const results = [];

  for (const incidentId of ALL_INCIDENT_IDS) {
    const mapping = incidentMap[incidentId];
    const run     = loadRunFile(incidentId);
    const bugClass = mapping?.bug_class || run?.bug_class || null;

    // Determine not_yet_processed before any regex work
    if (!mapping) {
      results.push({ id: incidentId, bugClass, state: 'not_yet_processed',
        reason: 'no entry in incident-map.json', caughtBy: null,
        runStatus: run?.status ?? null, manualBaselineSec: run?.manual_baseline_sec ?? 0 });
      continue;
    }

    const source = readMappedFiles(sandboxPath, mapping.files);
    if (source === null) {
      results.push({ id: incidentId, bugClass, state: 'not_yet_processed',
        reason: `mapped file(s) not found in sandbox: ${mapping.files.join(', ')}`,
        caughtBy: null,
        runStatus: run?.status ?? null, manualBaselineSec: run?.manual_baseline_sec ?? 0 });
      continue;
    }

    // Score: try every active guardrail against THIS incident's source only
    let prevented = false;
    let caughtBy  = null;

    for (const g of guardrails) {
      // Honesty rule: skip guardrails generated FROM this incident
      if (g.source_incidents.includes(incidentId)) {
        console.log(`[skip] ${g.id} was generated from ${incidentId} — not scored against it.`);
        continue;
      }

      // Class rule: a guardrail may only score an incident of the same bug class
      if (g.bug_class && bugClass && g.bug_class !== bugClass) {
        continue;
      }

      if (g.regex.test(source)) {
        prevented = true;
        caughtBy  = g.id;
        break;
      }
    }

    results.push({
      id: incidentId,
      bugClass,
      state: prevented ? 'prevented' : 'not_prevented',
      caughtBy,
      runStatus: run?.status ?? null,
      manualBaselineSec: run?.manual_baseline_sec ?? 0,
    });
  }

  // 4. Compute totals — exclude not_yet_processed from the denominator
  const scored         = results.filter(r => r.state !== 'not_yet_processed');
  const preventedList  = scored.filter(r => r.state === 'prevented');
  const notProcessed   = results.filter(r => r.state === 'not_yet_processed');
  const scoredCount    = scored.length;
  const preventedCount = preventedList.length;
  const preventionRate = scoredCount > 0
    ? parseFloat((preventedCount / scoredCount).toFixed(4))
    : null;

  // Bug classes covered by guardrails that scored a prevention
  const bugClassesCovered = new Set(
    preventedList.map(r => r.bugClass).filter(Boolean),
  );

  // Summary counters: drawn from run files for scored incidents
  let immunizedCount   = 0;
  let needsReviewCount = 0;
  let failedCount      = 0;
  let totalTimeSavedSec = 0;
  for (const r of scored) {
    if (r.runStatus === 'immunized')         immunizedCount++;
    else if (r.runStatus === 'needs_review') needsReviewCount++;
    else if (r.runStatus === 'failed')       failedCount++;

    if (r.state === 'prevented') totalTimeSavedSec += r.manualBaselineSec;
  }

  // Active guardrail count
  const guardrailsActive = guardrails.length;

  // 5. Print table
  const W = { id: 10, cls: 24, state: 18, guardrail: 38 };
  const row = (id, cls, state, gr) =>
    id.padEnd(W.id) + cls.padEnd(W.cls) + state.padEnd(W.state) + gr;

  console.log('');
  console.log(row('INCIDENT', 'BUG CLASS', 'STATE', 'GUARDRAIL'));
  console.log('─'.repeat(W.id + W.cls + W.state + W.guardrail));

  for (const r of results) {
    const cls = (r.bugClass || '—').slice(0, W.cls - 1);
    let stateLabel;
    if (r.state === 'prevented')          stateLabel = 'prevented';
    else if (r.state === 'not_prevented') stateLabel = 'not prevented';
    else                                  stateLabel = 'not yet processed';
    console.log(row(r.id, cls, stateLabel, r.caughtBy || '—'));
  }

  console.log('');
  if (scoredCount === 0) {
    console.log('Prevention rate : — (no scoreable incidents yet)');
  } else {
    console.log(`Prevention rate : ${preventedCount}/${scoredCount} scored (${notProcessed.length} not yet processed)`);
  }
  console.log('');

  // Log skipped incidents
  if (notProcessed.length > 0) {
    console.log('Not yet processed:');
    for (const r of notProcessed) {
      console.log(`  ${r.id}: ${r.reason}`);
    }
    console.log('');
  }

  // 6. Load existing summary for fields we preserve
  const existingSummary = (() => {
    const p = path.join(RUNS_DIR, 'summary.json');
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
  })();

  const summary = {
    generated_at:            new Date().toISOString(),
    incidents_total:         ALL_INCIDENT_IDS.length,
    incidents_immunized:     immunizedCount,
    incidents_needs_review:  needsReviewCount,
    incidents_failed:        failedCount,
    prevention_rate:         preventionRate,
    guardrails_active:       guardrailsActive,
    bug_classes_covered:     Array.from(bugClassesCovered).sort(),
    time_saved_sec:          existingSummary.time_saved_sec    ?? totalTimeSavedSec,
    avg_pipeline_sec:        existingSummary.avg_pipeline_sec  ?? 0,
    avg_manual_baseline_sec: existingSummary.avg_manual_baseline_sec ?? 0,
  };

  fs.writeFileSync(
    path.join(RUNS_DIR, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );

  const rateStr = preventionRate === null
    ? 'null (no scored incidents)'
    : `${(preventionRate * 100).toFixed(1)}%`;
  console.log(`[ok] runs/summary.json written (prevention_rate: ${rateStr})`);
}

// ── CLI entry ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let sandboxArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sandbox' && args[i + 1]) {
    sandboxArg = args[i + 1];
    break;
  }
}

const sandboxPath = sandboxArg
  ? path.resolve(sandboxArg)
  : path.join(REPO_ROOT, 'sandbox');

runBacktest(sandboxPath);
