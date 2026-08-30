#!/usr/bin/env node
/**
 * engine/orchestrator/index.js
 *
 * Scar-tissue incident orchestrator.
 *
 * ## Usage
 *
 *   node engine/orchestrator/index.js --incident INC-001 --dry-run
 *   node engine/orchestrator/index.js --all --concurrency 2 --dry-run
 *   node engine/orchestrator/index.js --incident INC-001
 *   node engine/orchestrator/index.js --incident INC-001 --publish
 *
 * ## Dependency graph (per incident)
 *
 *   locator ─────┐
 *                ├─► reproducer ─► fixer ─► immunizer
 *   historian ───┘
 *
 *   Locator and Historian are independent and run concurrently via
 *   Promise.allSettled. Both settle before the pipeline continues,
 *   regardless of which one finishes first or fails first.
 *
 *   Reproducer waits for both.
 *   Fixer waits for Reproducer.
 *   Immunizer waits for Fixer.
 *
 * ## Flags
 *
 *   --incident <ID>        Run a single incident (repeatable).
 *   --all                  Run all discovered incidents.
 *   --concurrency <N>      Max simultaneous incidents (default: 2).
 *   --dry-run              Use a fake runner; write no files; no Git/PR side effects.
 *   --publish              Opt-in: create a branch, commit, push, and open a PR.
 *                          Requires exactly one --incident and concurrency 1.
 *
 * ## Shutdown
 *
 *   SIGINT sets a flag that is checked between pipeline stages. In-flight
 *   runner calls are allowed to settle. No child-process tracking is
 *   implemented — the fake runner spawns no subprocesses. The real runner
 *   (once a verified adapter is supplied) is responsible for its own
 *   subprocess cleanup.
 */

'use strict';

const fs      = require('node:fs');
const path    = require('node:path');
const { performance } = require('node:perf_hooks');

const { createFakeRunner, createBobShellRunner } = require('./runner.js');
const {
  ValidationError,
  parseAgentOutput,
  discoverIncidentIds,
  validateIncidentId,
} = require('./validation.js');
const {
  buildBranchName,
  createGitPublisher,
  createRealGitRunner,
  createRealPrRunner,
} = require('./git-publisher.js');

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT       = path.resolve(__dirname, '..', '..');
const INCIDENTS_DIR   = path.join(REPO_ROOT, 'incidents');
const RUNS_DIR        = path.join(REPO_ROOT, 'runs');
const BACKTEST_SCRIPT = path.join(REPO_ROOT, 'engine', 'backtest', 'index.js');

const DEFAULT_CONCURRENCY = 2;
const MANUAL_BASELINE_SEC = 10800; // 3 hours — standard baseline per AGENTS.md

// ── CLI parser ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    incidents:   [],
    all:         false,
    concurrency: DEFAULT_CONCURRENCY,
    dryRun:      false,
    publish:     false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--incident' && args[i + 1]) {
      opts.incidents.push(args[++i]);
    } else if (a === '--all') {
      opts.all = true;
    } else if (a === '--concurrency' && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`[error] --concurrency must be a positive integer, got "${args[i]}"`);
        process.exit(1);
      }
      opts.concurrency = n;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--publish') {
      opts.publish = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`[error] Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
scar-tissue orchestrator — run the five-stage pipeline for one or more incidents.

Usage:
  node engine/orchestrator/index.js [flags]

Flags:
  --incident <ID>      Run a single incident (repeatable for multiple).
  --all                Run all incidents discovered in incidents/.
  --concurrency <N>    Max simultaneous incidents (default: ${DEFAULT_CONCURRENCY}).
  --dry-run            Fake runner, no file writes, no Git/PR side effects.
  --publish            Opt-in: create a branch, commit artefacts, push, open PR.
                       Requires exactly one --incident and concurrency 1.
  --help, -h           Show this help.

Examples:
  node engine/orchestrator/index.js --incident INC-001 --dry-run
  node engine/orchestrator/index.js --all --concurrency 2 --dry-run
  node engine/orchestrator/index.js --incident INC-001
  node engine/orchestrator/index.js --incident INC-001 --publish
`.trim());
}

// ── Monotonic clock helpers ───────────────────────────────────────────────────

/** Current monotonic time in seconds (float). */
function mono() {
  return performance.now() / 1000;
}

// ── Atomic file write ─────────────────────────────────────────────────────────

/**
 * Write JSON to `dest` atomically using a temp file + rename.
 * On Windows, rename is not truly atomic at the OS level but is the
 * closest available primitive.
 */
function writeJsonAtomic(dest, data) {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `.tmp-${path.basename(dest)}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, dest);
}

// ── Guardrail installer ───────────────────────────────────────────────────────

/**
 * Install a guardrail file to guardrails/ and (if confidence >= 0.6) to .bob/rules/.
 * Only called on real (non-dry-run) runs.
 */
function installGuardrail(guardrailContent, guardrailPath, confidence) {
  const guardrailsDir = path.join(REPO_ROOT, 'guardrails');
  const bobRulesDir   = path.join(REPO_ROOT, '.bob', 'rules');

  let destName;
  if (guardrailPath) {
    destName = path.basename(guardrailPath);
  } else {
    const m = guardrailContent.match(/^id:\s*(.+)/m);
    destName = m ? `${m[1].trim()}.md` : `guardrail-${Date.now()}.md`;
  }

  const canonicalPath = path.join(guardrailsDir, destName);
  fs.mkdirSync(guardrailsDir, { recursive: true });
  fs.writeFileSync(canonicalPath, guardrailContent, 'utf8');

  if (confidence >= 0.6) {
    fs.mkdirSync(bobRulesDir, { recursive: true });
    fs.copyFileSync(canonicalPath, path.join(bobRulesDir, destName));
  }

  return path.relative(REPO_ROOT, canonicalPath);
}

// ── Agent error sentinel ──────────────────────────────────────────────────────

class AgentError extends Error {
  constructor(agentName, message, rec) {
    super(message);
    this.agentName = agentName;
    this.rec       = rec;
    this.name      = 'AgentError';
  }
}

/** Add placeholder "aborted" records for agents that never ran. */
function _fillAbortedAgents(agentRecords, failedAgentNames) {
  const order    = ['locator', 'historian', 'reproducer', 'fixer', 'immunizer'];
  const recorded = new Set(agentRecords.map(r => r.name));

  // Find the earliest failure index to determine what has not run.
  const failIndices = failedAgentNames.map(n => order.indexOf(n)).filter(i => i >= 0);
  const firstFail   = failIndices.length > 0 ? Math.min(...failIndices) : order.length;

  for (let i = firstFail + 1; i < order.length; i++) {
    const name = order[i];
    if (!recorded.has(name)) {
      agentRecords.push({
        name,
        status:           'error',
        started_at:       new Date().toISOString(),
        start_offset_sec: 0,
        duration_sec:     0,
        summary:          `Aborted: upstream agent(s) "${failedAgentNames.join('", "')}" failed`,
      });
    }
  }
}

/** Build a brief human-readable summary from a parsed agent result. */
function buildSummary(agentName, parsed) {
  switch (agentName) {
    case 'locator':
      return `Located ${parsed.file} → ${parsed.function}`;
    case 'historian':
      return `Classified as ${parsed.bug_class} (confidence: ${parsed.confidence})`;
    case 'reproducer':
      return `Wrote failing test: ${parsed.failing_test}`;
    case 'fixer':
      return `Produced patch diff (${parsed.patch_diff.split('\n').length} lines)`;
    case 'immunizer':
      return `Generated guardrail: ${parsed.guardrail ?? '(embedded)'}`;
    default:
      return JSON.stringify(parsed).slice(0, 120);
  }
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the five-stage pipeline for a single incident.
 *
 * @param {object} opts
 * @param {string}   opts.incidentId       e.g. "INC-001"
 * @param {Function} opts.runner           The injected agent runner.
 * @param {boolean}  opts.dryRun           If true, write no files.
 * @param {object}   [opts.publisher]      Git publisher (or null for dry-run).
 * @param {boolean}  [opts.publish]        Whether to publish.
 * @param {string}   [opts._incidentsDir]  Override for test isolation.
 * @param {string}   [opts._runsDir]       Override for test isolation.
 * @returns {Promise<object>}              The run result object.
 */
async function runIncident({
  incidentId, runner, dryRun, publisher, publish,
  _incidentsDir, _runsDir,
}) {
  const incDir  = _incidentsDir ?? INCIDENTS_DIR;
  const runsDir = _runsDir      ?? RUNS_DIR;

  const runStart     = new Date();
  const runStartMono = mono();

  // Load postmortem prose
  const postmortemPath = path.join(incDir, `${incidentId}.md`);
  if (!fs.existsSync(postmortemPath)) {
    throw new Error(`Incident file not found: ${postmortemPath}`);
  }
  const postmortem = fs.readFileSync(postmortemPath, 'utf8');

  // Agent records (filled in as stages complete)
  const agentRecords = [];

  /**
   * Run a single agent stage, capturing timing and parsing output.
   * Pushes the record into agentRecords unconditionally (ok or error).
   * Returns the parsed result on success; throws AgentError on failure.
   */
  async function runStage(agentName, ctx) {
    const stageStart  = mono();
    const startOffset = stageStart - runStartMono;
    let output, durationMs, durationSec;

    try {
      ({ output, durationMs } = await runner(agentName, ctx));
      durationSec = durationMs / 1000;
    } catch (err) {
      const rec = {
        name:             agentName,
        status:           'error',
        started_at:       new Date(runStart.getTime() + startOffset * 1000).toISOString(),
        start_offset_sec: startOffset,
        duration_sec:     (mono() - stageStart),
        summary:          `Runner failed: ${err.message ?? String(err)}`.slice(0, 400),
      };
      agentRecords.push(rec);
      throw new AgentError(agentName, rec.summary, rec);
    }

    let parsed;
    try {
      parsed = parseAgentOutput(agentName, output);
    } catch (err) {
      const rec = {
        name:             agentName,
        status:           'error',
        started_at:       new Date(runStart.getTime() + startOffset * 1000).toISOString(),
        start_offset_sec: startOffset,
        duration_sec:     durationSec,
        summary:          `Parse failed: ${err.message ?? String(err)}`.slice(0, 400),
      };
      agentRecords.push(rec);
      throw new AgentError(agentName, rec.summary, rec);
    }

    const summary = buildSummary(agentName, parsed);
    agentRecords.push({
      name:             agentName,
      status:           'ok',
      started_at:       new Date(runStart.getTime() + startOffset * 1000).toISOString(),
      start_offset_sec: startOffset,
      duration_sec:     durationSec,
      summary,
    });
    return parsed;
  }

  let locatorResult    = null;
  let historianResult  = null;
  let reproducerResult = null;
  let fixerResult      = null;
  let immunizerResult  = null;

  let finalStatus = 'immunized';
  let artifacts   = { failing_test: null, patch_diff: null, guardrail: null, pr_url: null };

  // ── Stage 1 & 2: Locator and Historian — concurrent, both settle ────────────
  //
  // Promise.allSettled guarantees both Promises run to completion regardless of
  // which one fails first. This prevents an early Locator failure from leaving
  // an unobserved Historian Promise. After allSettled both agent records are
  // already in agentRecords via runStage.
  //
  const [locRes, histRes] = await Promise.allSettled([
    runStage('locator',   { incidentId, postmortem }),
    runStage('historian', { incidentId, postmortem, existingGuardrailIds: [] }),
  ]);

  const parallelFailed = [];
  if (locRes.status  === 'fulfilled') { locatorResult   = locRes.value;  }
  else                                { parallelFailed.push('locator');   }
  if (histRes.status === 'fulfilled') { historianResult = histRes.value; }
  else                                { parallelFailed.push('historian'); }

  if (parallelFailed.length > 0) {
    // One or both first-stage agents failed. Fill aborted records for all
    // downstream agents (reproducer, fixer, immunizer never ran).
    finalStatus = 'failed';
    _fillAbortedAgents(agentRecords, parallelFailed);
  } else {
    // ── Stage 3–5: dependent stages ─────────────────────────────────────────
    try {
      reproducerResult = await runStage('reproducer', {
        incidentId, postmortem, locatorResult, historianResult,
      });
      artifacts.failing_test = reproducerResult.failing_test;

      fixerResult = await runStage('fixer', {
        incidentId, postmortem, locatorResult, historianResult, reproducerResult,
      });
      artifacts.patch_diff = fixerResult.patch_diff;

      immunizerResult = await runStage('immunizer', {
        incidentId, postmortem, locatorResult, historianResult, reproducerResult, fixerResult,
      });

      // Install guardrail (only on real runs)
      if (!dryRun && immunizerResult) {
        const guardrailRelPath = installGuardrail(
          immunizerResult.guardrailContent,
          immunizerResult.guardrail,
          historianResult.confidence,
        );
        artifacts.guardrail = guardrailRelPath;
      } else if (immunizerResult) {
        artifacts.guardrail = immunizerResult.guardrail ?? '(dry-run, not written)';
      }

      // Status: confidence below 0.6 → needs_review
      finalStatus = historianResult.confidence >= 0.6 ? 'immunized' : 'needs_review';

    } catch (err) {
      finalStatus = 'failed';
      if (err instanceof AgentError) {
        _fillAbortedAgents(agentRecords, [err.agentName]);
      } else {
        // Unexpected non-AgentError — record it
        agentRecords.push({
          name:             'orchestrator',
          status:           'error',
          started_at:       new Date().toISOString(),
          start_offset_sec: mono() - runStartMono,
          duration_sec:     0,
          summary:          `Unexpected error: ${err.message ?? String(err)}`.slice(0, 400),
        });
      }
    }
  }

  const runFinished = new Date();
  const durationSec = (mono() - runStartMono);

  const run = {
    incident_id: incidentId,
    status:      finalStatus,
    bug_class:   historianResult?.bug_class   ?? null,
    confidence:  historianResult?.confidence  ?? null,
    timeline: {
      started_at:   runStart.toISOString(),
      finished_at:  runFinished.toISOString(),
      duration_sec: durationSec,
    },
    agents:    agentRecords,
    artifacts,
    backtest: {
      prevented: false,
      evidence:  null,
    },
    manual_baseline_sec: MANUAL_BASELINE_SEC,
  };

  // ── Write run file BEFORE publishing ───────────────────────────────────────
  // Publishing stages files that already exist on disk. The run JSON must be
  // written first so `git add runs/<id>.json` finds the file.
  if (!dryRun) {
    const dest = path.join(runsDir, `${incidentId}.json`);
    writeJsonAtomic(dest, run);
    console.log(`[${incidentId}] Written: ${path.relative(REPO_ROOT, dest)}`);
  } else {
    console.log(`[${incidentId}] (dry-run) Run JSON not written.`);
  }

  // ── Publish if requested ────────────────────────────────────────────────────
  //
  // Sequence (tested via fake adapters):
  //   1. Worktree must be clean before generation (checked in publisher.publish).
  //   2. Pipeline runs and writes run JSON to disk (done above).
  //   3. Branch is created.
  //   4. Files staged (run JSON + guardrail).
  //   5. Commit.
  //   6. Push.
  //   7. PR created; URL returned.
  //   8. run.artifacts.pr_url is updated in memory.
  //
  // We do NOT re-write the run JSON after updating pr_url, because that would
  // require a second atomic write on the same file that is already staged.
  // The PR URL is present in the in-memory run object returned by this function.
  // The caller prints it to stdout; it is available to anyone with push access
  // via `gh pr view`.
  //
  if (publish && !dryRun && publisher && finalStatus !== 'failed') {
    try {
      const filesToStage = [
        path.relative(REPO_ROOT, path.join(runsDir, `${incidentId}.json`)),
        ...(artifacts.guardrail && !artifacts.guardrail.startsWith('(')
          ? [artifacts.guardrail] : []),
      ].filter(Boolean);

      const prUrl = await publisher.publish({
        incidentId,
        filesToStage,
        prTitle: `[scar-tissue] ${incidentId} — pipeline output (${run.bug_class ?? 'unknown'})`,
        prBody:
          `Automated pipeline output for ${incidentId}.\n` +
          `Status: ${finalStatus}\n` +
          `Bug class: ${run.bug_class}\n` +
          `Confidence: ${run.confidence}`,
      });
      run.artifacts.pr_url = prUrl;
      console.log(`[${incidentId}] PR created: ${prUrl}`);
    } catch (pubErr) {
      // Publishing failure is reported clearly. The run status is not changed
      // to success — the publishing failure is surfaced in backtest evidence.
      console.error(`[${incidentId}] Publishing failed: ${pubErr.message}`);
      run.backtest.evidence = `Publishing error: ${pubErr.message.slice(0, 200)}`;
    }
  }

  return run;
}

// ── Concurrency-limited pool ──────────────────────────────────────────────────

/**
 * Run tasks from `items` with at most `concurrency` running at once.
 * Each item is processed by `fn(item)`. Errors are collected; they do
 * not abort other tasks.
 *
 * @param {Array}    items
 * @param {number}   concurrency
 * @param {Function} fn           async item → result
 * @returns {Promise<Array<{item, result?, error?}>>}
 */
async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let   idx     = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const item = items[i];
      try {
        results[i] = { item, result: await fn(item) };
      } catch (err) {
        results[i] = { item, error: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let _shuttingDown = false;

process.on('SIGINT', () => {
  if (!_shuttingDown) {
    _shuttingDown = true;
    console.error(
      '\n[orchestrator] Received SIGINT. ' +
      'In-flight runner calls will settle before the process exits. ' +
      'No child-process tracking is implemented; the fake runner spawns ' +
      'no subprocesses. A verified real runner adapter is responsible ' +
      'for its own subprocess cleanup.'
    );
  }
});

// ── Main entry ────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  // Validate flag combinations
  if (opts.publish && opts.dryRun) {
    console.error('[error] --publish and --dry-run are mutually exclusive');
    process.exit(1);
  }

  // Publishing currently requires exactly one incident and concurrency 1.
  // True isolated-worktree behavior per incident is not implemented.
  if (opts.publish && (opts.incidents.length !== 1 || opts.all)) {
    console.error(
      '[error] --publish requires exactly one --incident and cannot be combined with --all. ' +
      'True isolated-worktree behavior per concurrent incident is not implemented.'
    );
    process.exit(1);
  }

  // Resolve incident IDs
  const knownIds = discoverIncidentIds(INCIDENTS_DIR);

  let targetIds;
  if (opts.all) {
    targetIds = knownIds;
  } else if (opts.incidents.length > 0) {
    targetIds = opts.incidents.map(id => validateIncidentId(id, knownIds, INCIDENTS_DIR));
  } else {
    console.error('[error] Specify --incident <ID> or --all');
    printHelp();
    process.exit(1);
  }

  if (opts.dryRun) {
    console.log('[orchestrator] DRY-RUN mode — fake runner, no files written, no Git side effects.');
  }

  // Build runner — default is the placeholder that throws BobCliUnavailableError
  const runner = opts.dryRun
    ? createFakeRunner()
    : createBobShellRunner();

  // Build publisher (only for real runs with --publish)
  let publisher = null;
  if (opts.publish && !opts.dryRun) {
    publisher = createGitPublisher({
      gitRunner: createRealGitRunner(REPO_ROOT),
      prRunner:  createRealPrRunner(REPO_ROOT),
      repoRoot:  REPO_ROOT,
    });
  }

  console.log(`[orchestrator] Running ${targetIds.length} incident(s) with concurrency=${opts.concurrency}`);
  console.log(`[orchestrator] Incidents: ${targetIds.join(', ')}`);

  const allResults = await pool(targetIds, opts.concurrency, async (incidentId) => {
    console.log(`[${incidentId}] Starting pipeline`);
    try {
      const run = await runIncident({
        incidentId,
        runner,
        dryRun:    opts.dryRun,
        publisher,
        publish:   opts.publish,
      });
      console.log(`[${incidentId}] Finished — status: ${run.status}, confidence: ${run.confidence ?? 'n/a'}`);
      return run;
    } catch (err) {
      console.error(`[${incidentId}] Fatal error: ${err.message}`);
      throw err;
    }
  });

  // Summary table
  console.log('\n┌────────────────── Pipeline Summary ─────────────────────┐');
  for (const r of allResults) {
    if (r.error) {
      console.log(`│  ${r.item.padEnd(8)}  FATAL ERROR: ${String(r.error.message).slice(0, 40).padEnd(40)}  │`);
    } else {
      const status = r.result.status.padEnd(12);
      const conf   = r.result.confidence != null ? r.result.confidence.toFixed(2) : 'n/a ';
      console.log(`│  ${r.item.padEnd(8)}  ${status}  confidence: ${conf}  │`);
    }
  }
  console.log('└──────────────────────────────────────────────────────────┘\n');

  // Regenerate summary.json after real completed runs
  if (!opts.dryRun) {
    const successCount = allResults.filter(r => !r.error).length;
    if (successCount > 0) {
      console.log('[orchestrator] Regenerating runs/summary.json via backtest harness...');
      try {
        const { execFileSync } = require('node:child_process');
        execFileSync(process.execPath, [BACKTEST_SCRIPT], {
          stdio: 'inherit',
          cwd: REPO_ROOT,
        });
      } catch (e) {
        console.error(`[orchestrator] Warning: backtest harness failed: ${e.message}`);
      }
    }
  }

  const anyFailed = allResults.some(r => r.error || r.result?.status === 'failed');
  process.exit(anyFailed ? 1 : 0);
}

// ── Exports (for tests) ───────────────────────────────────────────────────────

module.exports = {
  runIncident,
  parseArgs,
  pool,
  buildBranchName,
  writeJsonAtomic,
  AgentError,
  _fillAbortedAgents,
  buildSummary,
  MANUAL_BASELINE_SEC,
};

// Run main if invoked directly
if (require.main === module) {
  main().catch(err => {
    console.error('[orchestrator] Unhandled error:', err.message);
    process.exit(2);
  });
}
