/**
 * timeline.test.js — regression tests for the timeline geometry module.
 *
 * Run with:
 *   node --test dashboard/timeline.test.js
 *
 * Requires Node 18+. Zero external dependencies.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { computeTimeline, AGENT_ORDER } = require('./timeline.js');

/* ---------------------------------------------------------- helpers */

/** Load a JSON fixture from dashboard/fixtures/ or runs/. */
function loadJson(relPath) {
  const full = path.resolve(__dirname, '..', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

/** The five canonical agent names. */
const FIVE = ['locator', 'historian', 'reproducer', 'fixer', 'immunizer'];

/* ---------------------------------------------------------- tests */

test('AGENT_ORDER exports exactly the five canonical agent names in pipeline order', () => {
  assert.deepEqual(AGENT_ORDER, FIVE);
});

test('example-parallel.json → measured mode with genuinely overlapping bars', () => {
  const run = loadJson('dashboard/fixtures/example-parallel.json');
  const tl = computeTimeline(run);

  assert.equal(tl.measured, true, 'measured should be true when start_offset_sec is present');

  /* locator and historian both start at offset 0, so they overlap */
  const locator   = tl.bars.find(b => b.name === 'locator');
  const historian = tl.bars.find(b => b.name === 'historian');
  assert.ok(locator,   'locator bar must exist');
  assert.ok(historian, 'historian bar must exist');
  assert.equal(locator.offset,   0, 'locator starts at offset 0');
  assert.equal(historian.offset, 0, 'historian starts at offset 0');

  /* locator ends at 62s; historian ends at 80s — they overlap while both run */
  assert.ok(
    locator.offset + locator.dur > historian.offset,
    'locator and historian bars overlap on the time axis',
  );

  /* The geometry module must confirm genuine overlap via interval comparison */
  assert.equal(tl.overlapping, true,
    'overlapping must be true when two bars share time-axis range');
});

test('example-parallel.json → exactly five lanes are returned', () => {
  const run = loadJson('dashboard/fixtures/example-parallel.json');
  const tl = computeTimeline(run);

  assert.equal(tl.bars.length, 5, 'bars must always have exactly 5 entries');
  const names = tl.bars.map(b => b.name);
  assert.deepEqual(names, FIVE, 'bars must be in canonical AGENT_ORDER');
});

test('runs/INC-001.json → five visible agents in inferred (sequential) mode', () => {
  const run = loadJson('runs/INC-001.json');
  const tl = computeTimeline(run);

  /* INC-001 has no start_offset_sec or started_at on agents, so inferred */
  assert.equal(tl.measured, false, 'INC-001 should use inferred sequential mode');
  assert.equal(tl.bars.length, 5, 'must always produce 5 bars');

  /* In sequential mode each bar starts where the previous ended */
  let expectedCursor = 0;
  for (const bar of tl.bars) {
    assert.equal(bar.offset, expectedCursor,
      `${bar.name} offset should be ${expectedCursor} in sequential mode`);
    expectedCursor += bar.dur;
  }
});

test('runs/INC-001.json → all five canonical agents are present and non-missing', () => {
  const run = loadJson('runs/INC-001.json');
  const tl = computeTimeline(run);

  for (const bar of tl.bars) {
    assert.equal(bar.missing, false,
      `${bar.name} should not be marked missing in INC-001`);
  }
});

test('zero-duration agents remain represented as visible markers (dur === 0, offset finite)', () => {
  const run = {
    agents: [
      { name: 'locator',    status: 'ok',    duration_sec: 0 },
      { name: 'historian',  status: 'ok',    duration_sec: 30 },
      { name: 'reproducer', status: 'ok',    duration_sec: 0 },
      { name: 'fixer',      status: 'error', duration_sec: 0 },
      { name: 'immunizer',  status: 'ok',    duration_sec: 15 },
    ],
  };
  const tl = computeTimeline(run);

  assert.equal(tl.bars.length, 5, 'five bars even with zero-duration agents');
  for (const bar of tl.bars) {
    assert.ok(Number.isFinite(bar.offset), `${bar.name}: offset must be finite`);
    assert.ok(bar.dur >= 0,                `${bar.name}: dur must be non-negative`);
  }

  /* span must still be positive so the CSS width calculation produces a finite % */
  assert.ok(tl.span >= 1, 'span must be at least 1');
});

test('ISO started_at positioning: offsets derived from timestamps match expected seconds', () => {
  const runStart = '2026-09-01T10:00:00Z';
  const run = {
    timeline: { started_at: runStart, duration_sec: 120 },
    agents: [
      {
        name: 'locator',
        status: 'ok',
        duration_sec: 30,
        started_at: '2026-09-01T10:00:00Z',  // same as run start → offset 0
      },
      {
        name: 'historian',
        status: 'ok',
        duration_sec: 40,
        started_at: '2026-09-01T10:00:30Z',  // 30s after run start
      },
      { name: 'reproducer', status: 'ok', duration_sec: 20, start_offset_sec: 70 },
      { name: 'fixer',      status: 'ok', duration_sec: 15, start_offset_sec: 90 },
      { name: 'immunizer',  status: 'ok', duration_sec: 10, start_offset_sec: 105 },
    ],
  };
  const tl = computeTimeline(run);

  assert.equal(tl.measured, true, 'should be measured when started_at is present');

  const locator   = tl.bars.find(b => b.name === 'locator');
  const historian = tl.bars.find(b => b.name === 'historian');
  const reproducer = tl.bars.find(b => b.name === 'reproducer');
  assert.equal(locator.offset,   0,  'locator offset should be 0 (same as run start)');
  assert.equal(historian.offset, 30, 'historian offset should be 30s');
  assert.equal(reproducer.offset, 70, 'reproducer offset should be 70s (from start_offset_sec)');
});

test('all offsets and span are finite and non-negative for a typical run', () => {
  const run = loadJson('runs/INC-001.json');
  const tl = computeTimeline(run);

  assert.ok(Number.isFinite(tl.span) && tl.span >= 1, 'span must be finite and >= 1');
  assert.ok(Number.isFinite(tl.wall) && tl.wall >= 0, 'wall must be finite and >= 0');
  assert.ok(Number.isFinite(tl.agentTotal) && tl.agentTotal >= 0,
    'agentTotal must be finite and >= 0');

  for (const bar of tl.bars) {
    assert.ok(Number.isFinite(bar.offset) && bar.offset >= 0,
      `${bar.name}: offset must be finite and non-negative`);
    assert.ok(Number.isFinite(bar.dur) && bar.dur >= 0,
      `${bar.name}: dur must be finite and non-negative`);
    /* The key constraint: left% + width% must not overflow 100 or go negative */
    const leftPct = (bar.offset / tl.span) * 100;
    assert.ok(leftPct >= 0 && leftPct <= 100,
      `${bar.name}: leftPct ${leftPct.toFixed(2)} must be in [0, 100]`);
  }
});

test('missing agent (not in run.agents) is represented as zero-dur marker with missing=true', () => {
  const run = {
    agents: [
      { name: 'locator',   status: 'ok', duration_sec: 50 },
      /* historian, reproducer, fixer, immunizer are absent */
    ],
  };
  const tl = computeTimeline(run);

  assert.equal(tl.bars.length, 5, 'still five bars');
  const historian  = tl.bars.find(b => b.name === 'historian');
  const reproducer = tl.bars.find(b => b.name === 'reproducer');
  assert.equal(historian.missing,  true, 'historian should be missing');
  assert.equal(reproducer.missing, true, 'reproducer should be missing');
  assert.equal(historian.dur,      0,    'missing agent has dur 0');

  /* missing agents must still have a finite, non-negative offset */
  assert.ok(Number.isFinite(historian.offset) && historian.offset >= 0,
    'missing agent offset is finite and non-negative');
});

test('inferred mode does not claim parallelism: agentTotal equals sum of sequential durations', () => {
  const run = {
    agents: [
      { name: 'locator',    status: 'ok', duration_sec: 10 },
      { name: 'historian',  status: 'ok', duration_sec: 20 },
      { name: 'reproducer', status: 'ok', duration_sec: 30 },
      { name: 'fixer',      status: 'ok', duration_sec: 40 },
      { name: 'immunizer',  status: 'ok', duration_sec: 50 },
    ],
  };
  const tl = computeTimeline(run);

  assert.equal(tl.measured, false, 'no start offsets → inferred mode');

  /* In sequential mode bars do not overlap; each starts at the end of the previous. */
  let cursor = 0;
  for (const bar of tl.bars) {
    assert.equal(bar.offset, cursor, `${bar.name} starts at ${cursor}`);
    cursor += bar.dur;
  }
  /* agentTotal == wall in inferred mode (no overlap invented) */
  assert.equal(tl.agentTotal, cursor, 'agentTotal is the sequential sum');
});

test('empty agents array → five missing-marker bars, span >= 1', () => {
  const tl = computeTimeline({ agents: [] });

  assert.equal(tl.bars.length, 5);
  assert.ok(tl.span >= 1);
  for (const bar of tl.bars) {
    assert.equal(bar.missing, true);
    assert.equal(bar.dur, 0);
    assert.ok(Number.isFinite(bar.offset));
  }
});

test('null/undefined run → does not throw, returns 5 bars', () => {
  /* computeTimeline must not throw on bad input */
  for (const bad of [null, undefined, {}, { agents: null }]) {
    const tl = computeTimeline(bad);
    assert.equal(tl.bars.length, 5, `bars.length should be 5 for input: ${JSON.stringify(bad)}`);
    assert.ok(tl.span >= 1, 'span >= 1 for bad input');
  }
});

/* ------------------------------------------------ new correctness tests */

test('partial timing (one agent missing start_offset_sec) falls back to inferred mode', () => {
  /* Three agents have start_offset_sec; one does not. The whole timeline must
   * fall back to inferred sequential — never leave one agent silently at 0. */
  const run = {
    agents: [
      { name: 'locator',    status: 'ok', duration_sec: 30, start_offset_sec: 0  },
      { name: 'historian',  status: 'ok', duration_sec: 40, start_offset_sec: 0  },
      { name: 'reproducer', status: 'ok', duration_sec: 20 /* no start time */   },
      { name: 'fixer',      status: 'ok', duration_sec: 15, start_offset_sec: 50 },
      { name: 'immunizer',  status: 'ok', duration_sec: 10, start_offset_sec: 65 },
    ],
  };
  const tl = computeTimeline(run);

  assert.equal(tl.measured,    false, 'partial timing must fall back to inferred');
  assert.equal(tl.overlapping, false, 'overlapping must be false in inferred mode');

  /* Sequential: each bar starts where the previous ended */
  let cursor = 0;
  for (const bar of tl.bars) {
    assert.equal(bar.offset, cursor, `${bar.name}: inferred offset should be ${cursor}`);
    cursor += bar.dur;
  }
});

test('negative start_offset_sec is rejected — falls back to inferred mode', () => {
  const run = {
    agents: [
      { name: 'locator',    status: 'ok', duration_sec: 20, start_offset_sec: -5  },
      { name: 'historian',  status: 'ok', duration_sec: 30, start_offset_sec: 0   },
      { name: 'reproducer', status: 'ok', duration_sec: 25, start_offset_sec: 30  },
      { name: 'fixer',      status: 'ok', duration_sec: 20, start_offset_sec: 55  },
      { name: 'immunizer',  status: 'ok', duration_sec: 15, start_offset_sec: 75  },
    ],
  };
  const tl = computeTimeline(run);

  assert.equal(tl.measured, false,
    'negative start_offset_sec must disqualify measured mode');

  /* All offsets must be non-negative even after fallback */
  for (const bar of tl.bars) {
    assert.ok(bar.offset >= 0, `${bar.name}: offset must be non-negative`);
  }
});

test('measured bars with no interval overlap are not labelled parallel', () => {
  /* All agents run strictly sequentially but provide accurate start_offset_sec.
   * agentTotal will equal wall; no two bars share a time range. */
  const run = {
    timeline: { duration_sec: 100 },
    agents: [
      { name: 'locator',    status: 'ok', duration_sec: 20, start_offset_sec: 0  },
      { name: 'historian',  status: 'ok', duration_sec: 20, start_offset_sec: 20 },
      { name: 'reproducer', status: 'ok', duration_sec: 20, start_offset_sec: 40 },
      { name: 'fixer',      status: 'ok', duration_sec: 20, start_offset_sec: 60 },
      { name: 'immunizer',  status: 'ok', duration_sec: 20, start_offset_sec: 80 },
    ],
  };
  const tl = computeTimeline(run);

  assert.equal(tl.measured,    true,  'all agents timed → measured mode');
  assert.equal(tl.overlapping, false,
    'strictly sequential measured bars must NOT be labelled parallel');
});

test('negative wall-clock duration is clamped to zero', () => {
  const run = {
    timeline: { duration_sec: -50 },
    agents: [
      { name: 'locator',    status: 'ok', duration_sec: 10, start_offset_sec: 0  },
      { name: 'historian',  status: 'ok', duration_sec: 10, start_offset_sec: 0  },
      { name: 'reproducer', status: 'ok', duration_sec: 10, start_offset_sec: 10 },
      { name: 'fixer',      status: 'ok', duration_sec: 10, start_offset_sec: 20 },
      { name: 'immunizer',  status: 'ok', duration_sec: 10, start_offset_sec: 30 },
    ],
  };
  const tl = computeTimeline(run);

  assert.ok(tl.wall >= 0, `wall must be clamped to >= 0, got ${tl.wall}`);
  assert.ok(tl.span >= 1, 'span must be at least 1');
  /* Geometry must still be valid */
  for (const bar of tl.bars) {
    assert.ok(bar.offset >= 0, `${bar.name}: offset must be non-negative`);
  }
});
