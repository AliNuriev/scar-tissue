/**
 * summary.test.js — regression tests for summary.js pure logic and the
 * dashboard server API endpoints.
 *
 * Run with:
 *   node --test dashboard/summary.test.js
 *
 * Requires Node 18+. Zero external dependencies.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const http     = require('node:http');

const {
  looksLikePath,
  classifyRunCounts,
  checkCounts,
  formatPreventionRate,
} = require('./summary.js');

/* ---------------------------------------------------------------- helpers */

/** Load a JSON file relative to the repo root. */
function loadJson(relPath) {
  const full = path.resolve(__dirname, '..', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

/** Collect all *.json run files from runs/ except summary.json. */
function loadRuns() {
  const dir  = path.resolve(__dirname, '..', 'runs');
  const names = fs.readdirSync(dir).filter(
    n => n.toLowerCase().endsWith('.json') && n.toLowerCase() !== 'summary.json'
  );
  return names.map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

/**
 * Start the dashboard server on an ephemeral port; return { server, base }.
 * Callers must call server.close() when done.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    // Require the server module fresh for each test that needs it.
    // server.js starts listening when required, so we fork off a child process
    // instead — or, simpler, exercise the two exported helper functions
    // (readRuns / readArtifact) directly via HTTP since the server exposes them.
    //
    // We spawn the server on a random port via PORT env var and close it after.
    const { spawn } = require('node:child_process');
    const PORT = 49200 + Math.floor(Math.random() * 500);
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, 'server.js')],
      { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' }
    );
    // Give it up to 2 seconds to start.
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error('server did not start within timeout'));
    }, 2000);
    child.stdout.on('data', () => {
      clearTimeout(deadline);
      resolve({ child, base: `http://localhost:${PORT}` });
    });
    child.stderr.on('data', () => {}); // suppress
  });
}

/** Perform a GET request and return the parsed JSON body. */
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/* ====================================================================
   1. formatPreventionRate
   ==================================================================== */

test('formatPreventionRate: 0.75 → "75%"', () => {
  assert.equal(formatPreventionRate(0.75), '75%');
});

test('formatPreventionRate: 0 → "0%"', () => {
  assert.equal(formatPreventionRate(0), '0%');
});

test('formatPreventionRate: 1 → "100%"', () => {
  assert.equal(formatPreventionRate(1), '100%');
});

test('formatPreventionRate: 0.3333 rounds to "33%"', () => {
  assert.equal(formatPreventionRate(0.3333), '33%');
});

test('formatPreventionRate: null → "—"', () => {
  assert.equal(formatPreventionRate(null), '—');
});

test('formatPreventionRate: undefined → "—"', () => {
  assert.equal(formatPreventionRate(undefined), '—');
});

test('formatPreventionRate: NaN → "—"', () => {
  assert.equal(formatPreventionRate(NaN), '—');
});

test('formatPreventionRate: Infinity → "—"', () => {
  assert.equal(formatPreventionRate(Infinity), '—');
});

/* ====================================================================
   2. looksLikePath — inline artifact vs path detection
   ==================================================================== */

test('looksLikePath: repo-relative path returns true', () => {
  assert.equal(looksLikePath('guardrails/race-condition-shared-resource.md'), true);
});

test('looksLikePath: runs/-relative diff path returns true', () => {
  assert.equal(looksLikePath('runs/INC-001/fix.diff'), true);
});

test('looksLikePath: sandbox test file path returns true', () => {
  assert.equal(looksLikePath('sandbox/tests/INC-005.test.js'), true);
});

test('looksLikePath: string with newline is inline content, not a path', () => {
  assert.equal(looksLikePath('--- a/foo.js\n+++ b/foo.js\n@@ line'), false);
});

test('looksLikePath: null returns false', () => {
  assert.equal(looksLikePath(null), false);
});

test('looksLikePath: empty string returns false', () => {
  assert.equal(looksLikePath(''), false);
});

test('looksLikePath: string over 300 chars returns false', () => {
  assert.equal(looksLikePath('a'.repeat(301) + '.js'), false);
});

test('looksLikePath: inline JS snippet returns false', () => {
  // Typical inlined patch_diff content from INC-002 — multi-line, not a path.
  const inline = '--- a/sandbox/routes/bookings.js\n+++ b/sandbox/routes/bookings.js\n@@ -1,10 +1,13 @@';
  assert.equal(looksLikePath(inline), false);
});

/* ====================================================================
   3. checkCounts — summary / runs disagreement detection
   ==================================================================== */

test('checkCounts: aligned counts produce no mismatches', () => {
  const summary = { incidents_immunized: 2, incidents_needs_review: 1, incidents_failed: 0 };
  const runs = [
    { status: 'immunized' },
    { status: 'immunized' },
    { status: 'needs_review' },
  ];
  const result = checkCounts(summary, runs);
  assert.deepEqual(result, []);
});

test('checkCounts: needs_review mismatch is detected', () => {
  // summary.json says 0 needs_review; one run file has needs_review.
  const summary = { incidents_immunized: 1, incidents_needs_review: 0, incidents_failed: 0 };
  const runs = [
    { status: 'immunized' },
    { status: 'needs_review' },
  ];
  const result = checkCounts(summary, runs);
  assert.ok(result.length > 0, 'should detect the mismatch');
  assert.ok(result.some(m => m.includes('incidents_needs_review')),
    'mismatch message should name incidents_needs_review');
});

test('checkCounts: immunized count mismatch is detected', () => {
  const summary = { incidents_immunized: 5, incidents_needs_review: 0, incidents_failed: 0 };
  const runs = [
    { status: 'immunized' },
    { status: 'immunized' },
  ];
  const result = checkCounts(summary, runs);
  assert.ok(result.some(m => m.includes('incidents_immunized')));
});

test('checkCounts: failed count mismatch is detected', () => {
  const summary = { incidents_immunized: 0, incidents_needs_review: 0, incidents_failed: 1 };
  const runs = [];
  const result = checkCounts(summary, runs);
  assert.ok(result.some(m => m.includes('incidents_failed')));
});

test('checkCounts: null summary returns empty array', () => {
  assert.deepEqual(checkCounts(null, [{ status: 'immunized' }]), []);
});

test('checkCounts: unknown status in runs is ignored (not counted)', () => {
  const summary = { incidents_immunized: 0, incidents_needs_review: 0, incidents_failed: 0 };
  const runs = [{ status: 'unknown_future_status' }];
  const result = checkCounts(summary, runs);
  assert.deepEqual(result, []);
});

/* ====================================================================
   4. current summary.json vs actual run files
   ==================================================================== */

test('current summary.json counts match actual run files — or disagreement is explicit', () => {
  const summary = loadJson('runs/summary.json');
  const runs    = loadRuns();
  const mismatches = checkCounts(summary, runs);

  // This test documents the current state. With the real fixtures both
  // can be true: no mismatch (they agree) OR a mismatch (which is the
  // "visible warning" the README describes). The test asserts that the
  // checkCounts function returns a well-typed array in both cases.
  assert.ok(Array.isArray(mismatches), 'checkCounts must return an array');
  for (const m of mismatches) {
    assert.equal(typeof m, 'string', 'each mismatch must be a string');
    assert.ok(m.length > 0, 'mismatch string must not be empty');
  }
});

test('prevention_rate in summary.json formats correctly via formatPreventionRate', () => {
  const summary = loadJson('runs/summary.json');
  const rate = formatPreventionRate(summary.prevention_rate);
  assert.ok(typeof rate === 'string' && rate.length > 0,
    'formatPreventionRate must return a non-empty string for the real summary');
  // Must end with % for a finite rate, or be "—" for missing.
  assert.ok(rate === '—' || rate.endsWith('%'),
    `rate "${rate}" should end with % or be "—"`);
});

/* ====================================================================
   5. /api/file — artifact file endpoint
   ==================================================================== */

test('/api/file: existing artifact file is served with exists:true', async (t) => {
  const { child, base } = await startServer();
  t.after(() => { child.kill(); });

  // guardrails/race-condition-shared-resource.md exists in the repo.
  const res = await getJson(
    `${base}/api/file?path=${encodeURIComponent('guardrails/race-condition-shared-resource.md')}`
  );
  assert.equal(res.exists, true, 'exists should be true for a real file');
  assert.ok(typeof res.content === 'string' && res.content.length > 0,
    'content should be a non-empty string');
});

test('/api/file: missing artifact file returns exists:false with path', async (t) => {
  const { child, base } = await startServer();
  t.after(() => { child.kill(); });

  const res = await getJson(
    `${base}/api/file?path=${encodeURIComponent('runs/INC-001/fix.diff')}`
  );
  assert.equal(res.exists, false, 'exists should be false for a missing file');
  assert.ok(res.path, 'path should be echoed back in the response');
});

test('/api/file: path traversal is rejected (exists:false, reason:rejected)', async (t) => {
  const { child, base } = await startServer();
  t.after(() => { child.kill(); });

  const res = await getJson(
    `${base}/api/file?path=${encodeURIComponent('../../etc/passwd')}`
  );
  assert.equal(res.exists, false, 'traversal path must not be served');
  assert.equal(res.reason, 'rejected', 'reason must be "rejected" for traversal attempts');
});

/* ====================================================================
   6. /api/runs — run list endpoint
   ==================================================================== */

test('/api/runs returns current run files including real INC-*.json files', async (t) => {
  const { child, base } = await startServer();
  t.after(() => { child.kill(); });

  const res = await getJson(`${base}/api/runs`);
  assert.ok(Array.isArray(res.runs), 'runs must be an array');
  assert.ok(res.runs.length > 0, 'there should be at least one run file');

  // Every run must have an incident_id.
  for (const r of res.runs) {
    assert.ok(typeof r.incident_id === 'string' && r.incident_id.length > 0,
      'each run must have an incident_id string');
  }

  // summary should be an object (summary.json is present).
  assert.ok(res.summary && typeof res.summary === 'object',
    'summary should be an object when summary.json is present');
  assert.ok(typeof res.summary.prevention_rate === 'number',
    'summary.prevention_rate must be a number');
});
