/**
 * engine/orchestrator/orchestrator.test.js
 *
 * Regression tests for the scar-tissue orchestrator.
 *
 * Run with:  node --test engine/orchestrator/orchestrator.test.js
 *
 * Requires Node 18+. Zero external dependencies.
 * All tests use temporary directories and fake runners/adapters.
 * They never touch runs/, sandbox/, guardrails/, real branches,
 * remotes, or the network.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

// ── Modules under test ────────────────────────────────────────────────────────

const {
  parseAgentOutput,
  ValidationError,
  discoverIncidentIds,
  validateIncidentId,
  assertSafePath,
  getTaxonomyIds,
  _resetTaxonomyCache,
  INCIDENT_ID_RE,
  REPO_ROOT,
} = require('./validation.js');

const {
  buildBranchName,
  createGitPublisher,
} = require('./git-publisher.js');

const {
  createFakeRunner,
  BobCliUnavailableError,
  createBobShellRunner,
} = require('./runner.js');

const {
  runIncident,
  parseArgs,
  pool,
  writeJsonAtomic,
  AgentError,
  _fillAbortedAgents,
  buildSummary,
  MANUAL_BASELINE_SEC,
} = require('./index.js');

// ── Temp directory helpers ────────────────────────────────────────────────────

function makeTmp(label = 'test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `scar-tissue-${label}-`));
}

// ── Seed a minimal incidents/ directory in a temp dir ────────────────────────

function seedIncidentsDir(dir, ids = ['INC-001', 'INC-002', 'INC-003']) {
  const incDir = path.join(dir, 'incidents');
  fs.mkdirSync(incDir, { recursive: true });
  for (const id of ids) {
    fs.writeFileSync(
      path.join(incDir, `${id}.md`),
      `# ${id}\n\nSynthetic incident postmortem for testing.\n`,
      'utf8',
    );
  }
  return incDir;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Incident discovery
// ══════════════════════════════════════════════════════════════════════════════

describe('1. Incident discovery', () => {
  test('discovers INC-*.md files and returns sorted IDs', (t) => {
    const tmp    = makeTmp('discovery');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const incDir = seedIncidentsDir(tmp, ['INC-003', 'INC-001', 'INC-010']);
    fs.writeFileSync(path.join(incDir, 'README.md'), '# readme', 'utf8');
    fs.writeFileSync(path.join(incDir, '.gitkeep'), '', 'utf8');

    const ids = discoverIncidentIds(incDir);
    assert.deepEqual(ids, ['INC-001', 'INC-003', 'INC-010'],
      'IDs should be sorted and exclude non-incident files');
  });

  test('returns empty array when no incident files exist', (t) => {
    const tmp = makeTmp('empty');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = path.join(tmp, 'incidents');
    fs.mkdirSync(incDir);
    assert.deepEqual(discoverIncidentIds(incDir), []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Incident ID / path validation
// ══════════════════════════════════════════════════════════════════════════════

describe('2. Incident ID and path validation', () => {
  let tmp, incDir;
  before(() => {
    tmp    = makeTmp('validation');
    incDir = seedIncidentsDir(tmp, ['INC-001', 'INC-012']);
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('accepts a valid known ID', () => {
    assert.equal(validateIncidentId('INC-001', ['INC-001', 'INC-012'], incDir), 'INC-001');
  });

  test('rejects an unknown ID with a clear error', () => {
    assert.throws(() => validateIncidentId('INC-999', ['INC-001', 'INC-012'], incDir), /Unknown incident ID/);
  });

  test('rejects malformed ID (no INC prefix)', () => {
    assert.throws(() => validateIncidentId('001', ['INC-001'], incDir), /Invalid incident ID format/);
  });

  test('rejects path traversal attempt in ID', () => {
    assert.throws(
      () => validateIncidentId('../etc/passwd', [], incDir),
      /Invalid incident ID format|Path traversal/,
    );
  });

  test('INCIDENT_ID_RE matches INC-001 through INC-999', () => {
    for (const id of ['INC-001', 'INC-012', 'INC-999']) {
      assert.ok(INCIDENT_ID_RE.test(id), `${id} should match`);
    }
  });

  test('INCIDENT_ID_RE rejects non-INC strings', () => {
    for (const bad of ['inc-001', 'INC001', 'INC-', '001', '']) {
      assert.ok(!INCIDENT_ID_RE.test(bad), `${bad} should not match`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Path safety: assertSafePath
// ══════════════════════════════════════════════════════════════════════════════

describe('3. Path safety (assertSafePath)', () => {
  test('accepts sandbox-relative path inside sandbox/', () => {
    assert.doesNotThrow(() => assertSafePath('sandbox/services/booking.js', 'locator', 'sandbox'));
  });

  test('rejects absolute path (Unix)', () => {
    assert.throws(
      () => assertSafePath('/etc/passwd', 'locator', 'sandbox'),
      /Absolute path rejected/,
    );
  });

  test('rejects absolute path (Windows-style)', () => {
    assert.throws(
      () => assertSafePath('C:\\Windows\\system32\\foo.js', 'locator', 'sandbox'),
      /Absolute path rejected/,
    );
  });

  test('rejects path traversal escaping sandbox/', () => {
    assert.throws(
      () => assertSafePath('sandbox/../../engine/agents/locator.md', 'locator', 'sandbox'),
      /must be inside sandbox/,
    );
  });

  test('rejects path targeting wrong subdirectory', () => {
    assert.throws(
      () => assertSafePath('guardrails/something.md', 'locator', 'sandbox'),
      /must be inside sandbox/,
    );
  });

  test('accepts guardrails-relative path for immunizer', () => {
    assert.doesNotThrow(() =>
      assertSafePath('guardrails/race-condition-shared-resource.md', 'immunizer', 'guardrails')
    );
  });

  test('rejects path traversal out of guardrails/', () => {
    assert.throws(
      () => assertSafePath('guardrails/../sandbox/evil.js', 'immunizer', 'guardrails'),
      /must be inside guardrails/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Agent output parsers
// ══════════════════════════════════════════════════════════════════════════════

describe('4. Agent output parsers', () => {

  test('parseLocator: valid output returns structured result', () => {
    const text = [
      'file: sandbox/services/booking.js',
      'function: bookSeat',
      'justification: The booking service matched the postmortem narrative.',
    ].join('\n');
    const r = parseAgentOutput('locator', text);
    assert.equal(r.file, 'sandbox/services/booking.js');
    assert.equal(r.function, 'bookSeat');
    assert.ok(r.justification.length > 0);
  });

  test('parseLocator: missing "file" field throws ValidationError', () => {
    const text = 'function: bookSeat\njustification: Some reason.';
    assert.throws(
      () => parseAgentOutput('locator', text),
      (err) => err instanceof ValidationError && err.agent === 'locator',
    );
  });

  test('parseLocator: absolute path is rejected', () => {
    const text = 'file: /etc/passwd\nfunction: evil\njustification: bad path.';
    assert.throws(
      () => parseAgentOutput('locator', text),
      (err) => err instanceof ValidationError && /Absolute path/i.test(err.message),
    );
  });

  test('parseLocator: path traversal out of sandbox/ is rejected', () => {
    const text = 'file: sandbox/../../engine/secret.js\nfunction: f\njustification: traversal.';
    assert.throws(
      () => parseAgentOutput('locator', text),
      (err) => err instanceof ValidationError && /must be inside sandbox/i.test(err.message),
    );
  });

  test('parseLocator: path outside sandbox/ is rejected', () => {
    const text = 'file: engine/agents/locator.md\nfunction: f\njustification: outside sandbox.';
    assert.throws(
      () => parseAgentOutput('locator', text),
      (err) => err instanceof ValidationError,
    );
  });

  test('parseHistorian: valid output', () => {
    const text = [
      'bug_class: race-condition',
      'confidence: 0.86',
      'already_covered: false',
      'coverage_note: none',
    ].join('\n');
    const r = parseAgentOutput('historian', text);
    assert.equal(r.bug_class, 'race-condition');
    assert.equal(r.confidence, 0.86);
    assert.equal(r.already_covered, false);
  });

  test('parseHistorian: invalid taxonomy ID is rejected', () => {
    const text = 'bug_class: invented-class\nconfidence: 0.80\nalready_covered: false\ncoverage_note: none';
    assert.throws(
      () => parseAgentOutput('historian', text),
      (err) => err instanceof ValidationError && /not a known taxonomy id/i.test(err.message),
    );
  });

  test('parseHistorian: confidence out of range throws ValidationError', () => {
    const text = 'bug_class: race-condition\nconfidence: 1.5\nalready_covered: false\ncoverage_note: none';
    assert.throws(() => parseAgentOutput('historian', text),
      (err) => err instanceof ValidationError && /confidence/i.test(err.message));
  });

  test('parseHistorian: already_covered with invalid value throws ValidationError', () => {
    const text = 'bug_class: race-condition\nconfidence: 0.75\nalready_covered: maybe\ncoverage_note: none';
    assert.throws(
      () => parseAgentOutput('historian', text),
      (err) => err instanceof ValidationError && /already_covered/i.test(err.message),
    );
  });

  test('parseHistorian: already_covered:true is parsed correctly', () => {
    const text = 'bug_class: race-condition\nconfidence: 0.75\nalready_covered: true\ncoverage_note: Covered.';
    const r = parseAgentOutput('historian', text);
    assert.equal(r.already_covered, true);
  });

  test('parseHistorian: already_covered:false is parsed correctly', () => {
    const text = 'bug_class: race-condition\nconfidence: 0.75\nalready_covered: false\ncoverage_note: none';
    const r = parseAgentOutput('historian', text);
    assert.equal(r.already_covered, false);
  });

  test('parseReproducer: valid fenced test block', () => {
    const text = '```sandbox/tests/INC-001.test.js\nconst assert = require("assert");\nassert.ok(true);\n```';
    const r = parseAgentOutput('reproducer', text);
    assert.equal(r.failing_test, 'sandbox/tests/INC-001.test.js');
    assert.ok(r.code.includes('assert'));
  });

  test('parseReproducer: absolute path in test filename is rejected', () => {
    const text = '```/tmp/evil.test.js\nassert.ok(true);\n```';
    assert.throws(
      () => parseAgentOutput('reproducer', text),
      // Absolute path won't match the test-file regex, so we get "Could not find fenced code block"
      (err) => err instanceof ValidationError,
    );
  });

  test('parseReproducer: test path outside sandbox/ is rejected', () => {
    const text = '```engine/some.test.js\nassert.ok(true);\n```';
    assert.throws(
      () => parseAgentOutput('reproducer', text),
      (err) => err instanceof ValidationError,
    );
  });

  test('parseReproducer: missing fenced block throws ValidationError', () => {
    assert.throws(() => parseAgentOutput('reproducer', 'No code here'),
      (err) => err instanceof ValidationError && err.agent === 'reproducer');
  });

  test('parseFixer: valid diff block', () => {
    const text = '```diff\n--- a/sandbox/services/booking.js\n+++ b/sandbox/services/booking.js\n@@ -1 +1 @@\n-old\n+new\n```';
    const r = parseAgentOutput('fixer', text);
    assert.ok(r.patch_diff.includes('---'));
  });

  test('parseFixer: no diff throws ValidationError', () => {
    assert.throws(() => parseAgentOutput('fixer', 'Nothing here'),
      (err) => err instanceof ValidationError && err.agent === 'fixer');
  });

  test('parseImmunizer: valid guardrail markdown', () => {
    const content = [
      '---',
      'id: race-condition-shared-resource',
      'bug_class: race-condition',
      'source_incidents: [INC-001]',
      'confidence: 0.86',
      'created_at: 2026-01-01T00:00:00Z',
      'scope: ["services/**/*.js"]',
      'detection: "await[^;]+find"',
      'status: active',
      '---',
      '## Rule',
      'Atomic writes only.',
      '## When this applies',
      'Shared state.',
      '## Why',
      'Double booking.',
      '## Instead of this',
      '    const x = await find();',
      '## Do this',
      '    await findAndUpdate();',
      '## Escape hatch',
      'Single-writer migration.',
    ].join('\n');
    const text = `\`\`\`guardrails/race-condition-shared-resource.md\n${content}\n\`\`\``;
    const r = parseAgentOutput('immunizer', text);
    assert.equal(r.guardrail, 'guardrails/race-condition-shared-resource.md');
    assert.ok(r.guardrailContent.includes('## Rule'));
  });

  test('parseImmunizer: absolute path in guardrail filename is rejected', () => {
    const content = '---\nid: x\nbug_class: race-condition\nconfidence: 0.8\nstatus: active\n---\n## Rule\nR\n## When this applies\nW\n## Why\nY\n## Instead of this\nI\n## Do this\nD\n## Escape hatch\nE';
    const text = `\`\`\`/tmp/evil.md\n${content}\n\`\`\``;
    assert.throws(
      () => parseAgentOutput('immunizer', text),
      (err) => err instanceof ValidationError && /Absolute path/i.test(err.message),
    );
  });

  test('parseImmunizer: guardrail path outside guardrails/ is rejected', () => {
    const content = '---\nid: x\nbug_class: race-condition\nconfidence: 0.8\nstatus: active\n---\n## Rule\nR\n## When this applies\nW\n## Why\nY\n## Instead of this\nI\n## Do this\nD\n## Escape hatch\nE';
    const text = `\`\`\`sandbox/evil.md\n${content}\n\`\`\``;
    assert.throws(
      () => parseAgentOutput('immunizer', text),
      (err) => err instanceof ValidationError && /must be inside guardrails/i.test(err.message),
    );
  });

  test('parseImmunizer: missing required section throws ValidationError', () => {
    // Missing ## Escape hatch
    const content = '---\nid: x\nbug_class: race-condition\nconfidence: 0.8\nstatus: active\n---\n## Rule\nR\n## When this applies\nW\n## Why\nY\n## Instead of this\nI\n## Do this\nD\n';
    const text = `\`\`\`guardrails/x.md\n${content}\n\`\`\``;
    assert.throws(() => parseAgentOutput('immunizer', text),
      (err) => err instanceof ValidationError && /Escape hatch/i.test(err.message));
  });

  test('parseImmunizer: confidence < 0.6 with status active is rejected', () => {
    const content = '---\nid: x\nbug_class: race-condition\nconfidence: 0.4\nstatus: active\n---\n## Rule\nR\n## When this applies\nW\n## Why\nY\n## Instead of this\nI\n## Do this\nD\n## Escape hatch\nE\n';
    const text = `\`\`\`guardrails/x.md\n${content}\n\`\`\``;
    assert.throws(
      () => parseAgentOutput('immunizer', text),
      (err) => err instanceof ValidationError && /needs_review/i.test(err.message),
    );
  });

  test('malformed agent output becomes a ValidationError', () => {
    assert.throws(() => parseAgentOutput('historian', 'garbage output with no structure'),
      (err) => err instanceof ValidationError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. BobCliUnavailableError
// ══════════════════════════════════════════════════════════════════════════════

describe('5. BobCliUnavailableError', () => {
  test('createBobShellRunner returns a runner that throws BobCliUnavailableError', async () => {
    const runner = createBobShellRunner();
    await assert.rejects(
      () => runner('locator', {}),
      (err) => err instanceof BobCliUnavailableError,
    );
  });

  test('BobCliUnavailableError message does not contain any CLI flags', () => {
    const runner = createBobShellRunner();
    return runner('locator', {}).catch(err => {
      assert.ok(err instanceof BobCliUnavailableError);
      assert.ok(!err.message.includes('--mode'),    'must not assume --mode flag');
      assert.ok(!err.message.includes('--message'), 'must not assume --message flag');
      assert.ok(!err.message.includes('bob shell'), 'must not assume bob shell subcommand');
    });
  });

  test('BobCliUnavailableError is thrown before any file is created', async (t) => {
    const tmp    = makeTmp('bob-unavail');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const incDir  = seedIncidentsDir(tmp, ['INC-001']);
    const runsDir = path.join(tmp, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const realRunner = createBobShellRunner();
    const run = await runIncident({
      incidentId: 'INC-001',
      runner:     realRunner,
      dryRun:     false,
      publish:    false,
      _incidentsDir: incDir,
      _runsDir:      runsDir,
    });

    // The run status must be failed and agent record must contain the error
    assert.equal(run.status, 'failed');
    const locAgent = run.agents.find(a => a.name === 'locator');
    assert.ok(locAgent, 'locator agent record must be present');
    assert.equal(locAgent.status, 'error');
    assert.ok(locAgent.summary.includes('Bob CLI'), `Expected 'Bob CLI' in: ${locAgent.summary}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Concurrency pool
// ══════════════════════════════════════════════════════════════════════════════

describe('6. Concurrency pool', () => {
  test('pool runs all items and returns results in index order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await pool(items, 2, async (x) => x * 2);
    assert.deepEqual(results.map(r => r.result), [2, 4, 6, 8, 10]);
  });

  test('pool collects errors without aborting other items', async () => {
    const items = ['a', 'b', 'c'];
    const results = await pool(items, 3, async (x) => {
      if (x === 'b') throw new Error('b failed');
      return x.toUpperCase();
    });
    assert.equal(results[0].result, 'A');
    assert.ok(results[1].error instanceof Error);
    assert.equal(results[2].result, 'C');
  });

  test('pool respects concurrency limit (at most N simultaneous)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await pool(items, 3, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
    });
    assert.ok(maxConcurrent <= 3, `Max concurrent was ${maxConcurrent}, expected <= 3`);
  });

  test('pool handles empty items array', async () => {
    const results = await pool([], 5, async () => 'unreachable');
    assert.deepEqual(results, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Atomic file write
// ══════════════════════════════════════════════════════════════════════════════

describe('7. Atomic file write', () => {
  test('writeJsonAtomic writes valid JSON to the destination path', (t) => {
    const tmp = makeTmp('atomic');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const dest = path.join(tmp, 'test.json');
    const data = { incident_id: 'INC-001', status: 'immunized' };
    writeJsonAtomic(dest, data);

    const read = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.deepEqual(read, data);
  });

  test('writeJsonAtomic leaves no temp file after success', (t) => {
    const tmp = makeTmp('atomic2');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const dest = path.join(tmp, 'out.json');
    writeJsonAtomic(dest, { x: 1 });

    const files = fs.readdirSync(tmp);
    assert.deepEqual(files, ['out.json'], 'No temp files should remain');
  });

  test('writeJsonAtomic creates parent directories as needed', (t) => {
    const tmp = makeTmp('atomic3');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const dest = path.join(tmp, 'nested', 'deep', 'run.json');
    writeJsonAtomic(dest, { ok: true });
    assert.ok(fs.existsSync(dest));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. Branch naming
// ══════════════════════════════════════════════════════════════════════════════

describe('8. Branch naming', () => {
  test('buildBranchName produces deterministic safe name for INC-001', () => {
    const date = new Date('2026-08-29T10:00:00Z');
    assert.equal(buildBranchName('INC-001', date), 'scar-tissue/inc-001-20260829');
  });

  test('buildBranchName is safe for Git refs (no spaces or special chars)', () => {
    const name = buildBranchName('INC-012', new Date('2026-01-15T00:00:00Z'));
    assert.ok(/^[a-z0-9\/\-]+$/.test(name), `Branch name "${name}" contains unsafe characters`);
  });

  test('different incidents produce different branch names on the same day', () => {
    const date = new Date('2026-08-29T00:00:00Z');
    const a = buildBranchName('INC-001', date);
    const b = buildBranchName('INC-002', date);
    assert.notEqual(a, b);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. Git publisher (fake adapters) — command order
// ══════════════════════════════════════════════════════════════════════════════

describe('9. Git publisher with fake adapters', () => {

  function makeFakeAdapters(overrides = {}) {
    const calls = { git: [], pr: [] };
    const gitRunner = async (args) => {
      calls.git.push([...args]);
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return overrides.dirty ? 'M some/file.js' : '';
      }
      return '';
    };
    const prRunner = async (args) => {
      calls.pr.push([...args]);
      return 'https://github.com/org/repo/pull/42';
    };
    return { calls, gitRunner, prRunner };
  }

  test('publish command order: clean-check → checkout → add → commit → push → pr create', async () => {
    const { calls, gitRunner, prRunner } = makeFakeAdapters();
    const publisher = createGitPublisher({ gitRunner, prRunner, repoRoot: '/fake' });

    await publisher.publish({
      incidentId:   'INC-001',
      filesToStage: ['runs/INC-001.json', 'guardrails/x.md'],
      prTitle:      'Test PR',
      prBody:       'Test body',
      date:         new Date('2026-08-29T00:00:00Z'),
    });

    const gitCmds = calls.git.map(a => a[0]);
    // Status check must come first
    assert.equal(gitCmds[0], 'status', 'status --porcelain must be first');
    // Then checkout to create branch
    const checkoutIdx = gitCmds.indexOf('checkout');
    assert.ok(checkoutIdx > 0, 'checkout must happen after status check');
    // Then add
    const addIdx = gitCmds.indexOf('add');
    assert.ok(addIdx > checkoutIdx, 'add must come after checkout');
    // Then commit
    const commitIdx = gitCmds.indexOf('commit');
    assert.ok(commitIdx > addIdx, 'commit must come after add');
    // Then push
    const pushIdx = gitCmds.indexOf('push');
    assert.ok(pushIdx > commitIdx, 'push must come after commit');
    // Then PR
    assert.ok(calls.pr.length > 0, 'PR must be created');
    assert.ok(calls.pr[0].includes('pr'), 'PR command must include "pr"');
  });

  test('publish returns the PR URL', async () => {
    const { gitRunner, prRunner } = makeFakeAdapters();
    const publisher = createGitPublisher({ gitRunner, prRunner, repoRoot: '/fake' });
    const prUrl = await publisher.publish({
      incidentId: 'INC-001', filesToStage: ['runs/INC-001.json'],
      prTitle: 'T', prBody: 'B', date: new Date(),
    });
    assert.equal(prUrl, 'https://github.com/org/repo/pull/42');
  });

  test('publish is rejected on a dirty worktree', async () => {
    const { gitRunner, prRunner } = makeFakeAdapters({ dirty: true });
    const publisher = createGitPublisher({ gitRunner, prRunner, repoRoot: '/fake' });
    await assert.rejects(
      () => publisher.publish({
        incidentId: 'INC-001', filesToStage: ['runs/INC-001.json'],
        prTitle: 'x', prBody: 'y',
      }),
      /dirty worktree/i,
    );
  });

  test('publish does NOT use reset --hard or checkout -- (file checkout)', async () => {
    const { calls, gitRunner, prRunner } = makeFakeAdapters();
    const publisher = createGitPublisher({ gitRunner, prRunner, repoRoot: '/fake' });
    await publisher.publish({
      incidentId: 'INC-001', filesToStage: ['runs/INC-001.json'],
      prTitle: 'T', prBody: 'B', date: new Date(),
    });
    for (const args of calls.git) {
      assert.ok(!args.includes('--hard'), 'reset --hard must not be used');
      if (args[0] === 'checkout' && args[1] === '--') {
        assert.fail('checkout -- (file checkout) must not be used');
      }
    }
  });

  test('dirty worktree check happens before any branch creation', async () => {
    const { calls, gitRunner, prRunner } = makeFakeAdapters({ dirty: true });
    const publisher = createGitPublisher({ gitRunner, prRunner, repoRoot: '/fake' });
    try {
      await publisher.publish({
        incidentId: 'INC-001', filesToStage: ['runs/INC-001.json'],
        prTitle: 'x', prBody: 'y',
      });
    } catch { /* expected */ }
    // Only the status check should have been called — no checkout
    const gitCmds = calls.git.map(a => a[0]);
    assert.ok(!gitCmds.includes('checkout'), 'checkout must not be called when worktree is dirty');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. Run JSON shape
// ══════════════════════════════════════════════════════════════════════════════

describe('10. Run JSON shape', () => {
  test('runIncident with fake runner produces valid run JSON shape', async (t) => {
    const tmp = makeTmp('run-shape');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const run = await runIncident({
      incidentId: 'INC-001',
      runner:     createFakeRunner(),
      dryRun:     true,
      publish:    false,
      _incidentsDir: incDir,
    });

    assert.ok(typeof run.incident_id === 'string');
    assert.ok(['immunized', 'needs_review', 'failed'].includes(run.status));
    assert.ok(run.timeline && typeof run.timeline.started_at === 'string');
    assert.ok(Number.isFinite(run.timeline.duration_sec) && run.timeline.duration_sec >= 0);
    assert.ok(Array.isArray(run.agents));
    assert.ok(run.artifacts && typeof run.artifacts === 'object');
    assert.ok('failing_test' in run.artifacts);
    assert.ok('patch_diff'   in run.artifacts);
    assert.ok('guardrail'    in run.artifacts);
    assert.ok('pr_url'       in run.artifacts);
    assert.ok(run.backtest && 'prevented' in run.backtest);
    assert.ok(typeof run.manual_baseline_sec === 'number');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. Timing: start_offset_sec, honest overlap, dependency ordering
// ══════════════════════════════════════════════════════════════════════════════

describe('11. Timing fields', () => {
  test('all agent start_offset_sec values are finite and non-negative', async (t) => {
    const tmp = makeTmp('timing');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const run    = await runIncident({
      incidentId: 'INC-001', runner: createFakeRunner(), dryRun: true, publish: false,
      _incidentsDir: incDir,
    });
    for (const agent of run.agents) {
      assert.ok(
        Number.isFinite(agent.start_offset_sec) && agent.start_offset_sec >= 0,
        `${agent.name}: start_offset_sec=${agent.start_offset_sec} must be finite and non-negative`,
      );
    }
  });

  test('locator and historian both start near offset 0 (genuine overlap)', async (t) => {
    const tmp = makeTmp('overlap');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const run    = await runIncident({
      incidentId: 'INC-001', runner: createFakeRunner(), dryRun: true, publish: false,
      _incidentsDir: incDir,
    });
    const locator   = run.agents.find(a => a.name === 'locator');
    const historian = run.agents.find(a => a.name === 'historian');
    assert.ok(locator,   'locator agent must be present');
    assert.ok(historian, 'historian agent must be present');
    assert.ok(locator.start_offset_sec   < 1, `locator offset ${locator.start_offset_sec} should be < 1s`);
    assert.ok(historian.start_offset_sec < 1, `historian offset ${historian.start_offset_sec} should be < 1s`);
  });

  test('reproducer starts after both locator and historian', async (t) => {
    const tmp = makeTmp('depends');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const run    = await runIncident({
      incidentId: 'INC-001', runner: createFakeRunner(), dryRun: true, publish: false,
      _incidentsDir: incDir,
    });
    const locator    = run.agents.find(a => a.name === 'locator');
    const historian  = run.agents.find(a => a.name === 'historian');
    const reproducer = run.agents.find(a => a.name === 'reproducer');
    assert.ok(reproducer.start_offset_sec >= locator.start_offset_sec,
      'reproducer must start after locator');
    assert.ok(reproducer.start_offset_sec >= historian.start_offset_sec,
      'reproducer must start after historian');
  });

  test('fixer starts after reproducer', async (t) => {
    const tmp = makeTmp('fixer-order');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const run    = await runIncident({
      incidentId: 'INC-001', runner: createFakeRunner(), dryRun: true, publish: false,
      _incidentsDir: incDir,
    });
    const reproducer = run.agents.find(a => a.name === 'reproducer');
    const fixer      = run.agents.find(a => a.name === 'fixer');
    assert.ok(fixer.start_offset_sec >= reproducer.start_offset_sec,
      'fixer must start after reproducer');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. Status rules
// ══════════════════════════════════════════════════════════════════════════════

describe('12. Status rules', () => {
  test('confidence < 0.6 produces needs_review status', async (t) => {
    const tmp = makeTmp('needs-review');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const runner = createFakeRunner({
      historian: 'bug_class: race-condition\nconfidence: 0.45\nalready_covered: false\ncoverage_note: none',
      // immunizer must also have low confidence to be consistent
      immunizer: [
        '```guardrails/race-condition-shared-resource.md',
        '---',
        'id: race-condition-shared-resource',
        'bug_class: race-condition',
        'source_incidents: [INC-TEST]',
        'confidence: 0.45',
        'created_at: 2026-01-01T00:00:00Z',
        'scope: ["services/**/*.js"]',
        'detection: "await[^;]+find"',
        'status: needs_review',
        '---',
        '## Rule',
        'Atomic writes only.',
        '## When this applies',
        'Shared state writes must be atomic.',
        '## Why',
        'Double booking occurs when two requests race.',
        '## Instead of this',
        '    const item = await find(); item.claimed = true; await item.save();',
        '## Do this',
        '    await findOneAndUpdate({ claimed: false }, { claimed: true });',
        '## Escape hatch',
        'Single-writer migration scripts are exempt.',
        '```',
      ].join('\n'),
    });
    const run = await runIncident({
      incidentId: 'INC-001', runner, dryRun: true, publish: false,
      _incidentsDir: incDir,
    });
    assert.equal(run.status, 'needs_review', `Expected needs_review, got ${run.status}`);
    assert.equal(run.confidence, 0.45);
  });

  test('agent runner failure produces failed status', async (t) => {
    const tmp = makeTmp('failed');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const failingRunner = async (agentName, ctx) => {
      if (agentName === 'locator') throw new Error('Bob shell unavailable');
      return createFakeRunner()(agentName, ctx);
    };
    const run = await runIncident({
      incidentId: 'INC-001', runner: failingRunner, dryRun: true, publish: false,
      _incidentsDir: incDir,
    });
    assert.equal(run.status, 'failed');
    const locator = run.agents.find(a => a.name === 'locator');
    assert.equal(locator.status, 'error');
    assert.ok(locator.summary.includes('Bob shell unavailable'));
  });

  test('malformed agent output produces failed status', async (t) => {
    const tmp = makeTmp('malformed');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const runner = createFakeRunner({ locator: 'this is garbage output' });
    const run = await runIncident({
      incidentId: 'INC-001', runner, dryRun: true, publish: false,
      _incidentsDir: incDir,
    });
    assert.equal(run.status, 'failed');
    const locator = run.agents.find(a => a.name === 'locator');
    assert.equal(locator.status, 'error');
    assert.ok(locator.summary.includes('Parse failed'));
  });

  test('successful pipeline with confidence >= 0.6 produces immunized status', async (t) => {
    const tmp = makeTmp('immunized');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    const run    = await runIncident({
      incidentId: 'INC-001', runner: createFakeRunner(), dryRun: true, publish: false,
      _incidentsDir: incDir,
    });
    assert.equal(run.status, 'immunized');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 13. Parallel first-stage failure semantics (Promise.allSettled)
// ══════════════════════════════════════════════════════════════════════════════

describe('13. Parallel first-stage failure (Promise.allSettled)', () => {
  /**
   * Build a runner where `agentName` takes `delayMs` before resolving,
   * and `failAgent` throws immediately. This tests that the slow agent
   * still records its completion even when the other fails fast.
   */
  function makeRacingRunner({ failAgent, delayAgent, delayMs = 30 }) {
    const fakeDefaults = createFakeRunner();
    return async function racingRunner(agentName, ctx) {
      if (agentName === failAgent) {
        throw new Error(`${failAgent} runner failed`);
      }
      if (agentName === delayAgent) {
        await new Promise(r => setTimeout(r, delayMs));
      }
      return fakeDefaults(agentName, ctx);
    };
  }

  test('locator fails, historian still runs and its record is retained', async (t) => {
    const tmp = makeTmp('locfail');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);

    const runner = makeRacingRunner({ failAgent: 'locator', delayAgent: 'historian', delayMs: 20 });
    const run    = await runIncident({
      incidentId: 'INC-001', runner, dryRun: true, publish: false,
      _incidentsDir: incDir,
    });

    assert.equal(run.status, 'failed');

    // Both locator and historian records must be present
    const locRec  = run.agents.find(a => a.name === 'locator');
    const histRec = run.agents.find(a => a.name === 'historian');
    assert.ok(locRec,  'locator record must be present');
    assert.ok(histRec, 'historian record must be present');
    assert.equal(locRec.status,  'error', 'locator must be error');
    assert.equal(histRec.status, 'ok',    'historian must be ok (it still ran)');

    // Downstream agents must all be aborted
    for (const name of ['reproducer', 'fixer', 'immunizer']) {
      const rec = run.agents.find(a => a.name === name);
      assert.ok(rec, `${name} must have an aborted record`);
      assert.equal(rec.status, 'error', `${name} must be error`);
    }
  });

  test('historian fails, locator still runs and its record is retained', async (t) => {
    const tmp = makeTmp('histfail');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);

    const runner = makeRacingRunner({ failAgent: 'historian', delayAgent: 'locator', delayMs: 20 });
    const run    = await runIncident({
      incidentId: 'INC-001', runner, dryRun: true, publish: false,
      _incidentsDir: incDir,
    });

    assert.equal(run.status, 'failed');

    const locRec  = run.agents.find(a => a.name === 'locator');
    const histRec = run.agents.find(a => a.name === 'historian');
    assert.ok(locRec,  'locator record must be present');
    assert.ok(histRec, 'historian record must be present');
    assert.equal(locRec.status,  'ok',    'locator must be ok (it ran to completion)');
    assert.equal(histRec.status, 'error', 'historian must be error');
  });

  test('both fail — all five agent records are present', async (t) => {
    const tmp = makeTmp('bothfail');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);

    const runner = async (agentName) => {
      if (agentName === 'locator' || agentName === 'historian') {
        throw new Error(`${agentName} failed`);
      }
      return createFakeRunner()(agentName, {});
    };
    const run = await runIncident({
      incidentId: 'INC-001', runner, dryRun: true, publish: false,
      _incidentsDir: incDir,
    });

    assert.equal(run.status, 'failed');
    const expected = ['locator', 'historian', 'reproducer', 'fixer', 'immunizer'];
    for (const name of expected) {
      const rec = run.agents.find(a => a.name === name);
      assert.ok(rec, `${name} record must be present`);
      assert.equal(rec.status, 'error', `${name} must be error`);
    }
  });

  test('reproducer abort does not add duplicate locator/historian records', async (t) => {
    const tmp = makeTmp('repro-abort');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const incDir = seedIncidentsDir(tmp, ['INC-001']);

    const runner = async (agentName, ctx) => {
      if (agentName === 'locator') throw new Error('locator failed');
      return createFakeRunner()(agentName, ctx);
    };
    const run = await runIncident({
      incidentId: 'INC-001', runner, dryRun: true, publish: false,
      _incidentsDir: incDir,
    });

    const agentNames = run.agents.map(a => a.name);
    // No duplicate names
    const unique = new Set(agentNames);
    assert.equal(unique.size, agentNames.length, `Duplicate agent records found: ${agentNames}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 14. _fillAbortedAgents
// ══════════════════════════════════════════════════════════════════════════════

describe('14. _fillAbortedAgents', () => {
  test('fills in error records for all unrun downstream agents', () => {
    const records = [
      { name: 'locator',    status: 'ok',    start_offset_sec: 0,   duration_sec: 1, summary: 'ok' },
      { name: 'historian',  status: 'ok',    start_offset_sec: 0,   duration_sec: 1, summary: 'ok' },
      { name: 'reproducer', status: 'error', start_offset_sec: 2,   duration_sec: 0.5, summary: 'failed' },
    ];
    _fillAbortedAgents(records, ['reproducer']);
    const names = records.map(r => r.name);
    assert.ok(names.includes('fixer'),     'fixer must be added');
    assert.ok(names.includes('immunizer'), 'immunizer must be added');
    const fixer = records.find(r => r.name === 'fixer');
    assert.equal(fixer.status, 'error');
    assert.ok(fixer.summary.includes('reproducer'));
  });

  test('locator failure causes reproducer/fixer/immunizer to be filled', () => {
    const records = [
      { name: 'locator',   status: 'error', start_offset_sec: 0, duration_sec: 0.5, summary: 'failed' },
      { name: 'historian', status: 'ok',    start_offset_sec: 0, duration_sec: 1,   summary: 'ok' },
    ];
    _fillAbortedAgents(records, ['locator']);
    const names = records.map(r => r.name);
    assert.ok(names.includes('reproducer'), 'reproducer must be added');
    assert.ok(names.includes('fixer'),      'fixer must be added');
    assert.ok(names.includes('immunizer'),  'immunizer must be added');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 15. Dry-run safety
// ══════════════════════════════════════════════════════════════════════════════

describe('15. Dry-run safety', () => {
  test('parseArgs: --dry-run sets dryRun flag and does not set publish', () => {
    const opts = parseArgs(['node', 'index.js', '--incident', 'INC-001', '--dry-run']);
    assert.equal(opts.dryRun,  true);
    assert.equal(opts.publish, false);
    assert.deepEqual(opts.incidents, ['INC-001']);
  });

  test('parseArgs: --publish sets publish flag', () => {
    const opts = parseArgs(['node', 'index.js', '--incident', 'INC-001', '--publish']);
    assert.equal(opts.publish, true);
    assert.equal(opts.dryRun,  false);
  });

  test('parseArgs: --all sets all flag', () => {
    const opts = parseArgs(['node', 'index.js', '--all', '--concurrency', '3']);
    assert.equal(opts.all, true);
    assert.equal(opts.concurrency, 3);
  });

  test('dry-run: no run file is written to disk', async (t) => {
    const tmp = makeTmp('dryrun');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const incDir  = seedIncidentsDir(tmp, ['INC-001']);
    const runsDir = path.join(tmp, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const run = await runIncident({
      incidentId: 'INC-001', runner: createFakeRunner(), dryRun: true, publish: false,
      _incidentsDir: incDir, _runsDir: runsDir,
    });
    assert.ok(!fs.existsSync(path.join(runsDir, 'INC-001.json')),
      'dry-run must not write run JSON to disk');
    assert.ok(run.incident_id === 'INC-001');
  });

  test('dry-run with fake runner does not call git or pr at all', async (t) => {
    const tmp = makeTmp('dryrun-git');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const incDir = seedIncidentsDir(tmp, ['INC-001']);
    let gitCalled = false;
    const fakeGit = async () => { gitCalled = true; return ''; };
    const fakeGitPublisher = createGitPublisher({
      gitRunner: fakeGit, prRunner: async () => '', repoRoot: '/fake',
    });

    await runIncident({
      incidentId: 'INC-001', runner: createFakeRunner(), dryRun: true, publish: false,
      publisher: fakeGitPublisher, _incidentsDir: incDir,
    });
    assert.ok(!gitCalled, 'git must not be called during dry-run');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 16. Publishing sequence via fake adapters
// ══════════════════════════════════════════════════════════════════════════════

describe('16. Publishing sequence (fake adapters)', () => {
  test('run JSON is written to disk before git add is called', async (t) => {
    const tmp = makeTmp('publish-order');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const incDir  = seedIncidentsDir(tmp, ['INC-001']);
    const runsDir = path.join(tmp, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const writeEvents = [];
    let runFileExistedAtAdd = false;

    const gitRunner = async (args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'add') {
        // Check if the run JSON file exists at the time git add is called
        runFileExistedAtAdd = fs.existsSync(path.join(runsDir, 'INC-001.json'));
        writeEvents.push('git-add');
      }
      return '';
    };
    const prRunner = async () => 'https://github.com/org/repo/pull/99';

    const publisher = createGitPublisher({ gitRunner, prRunner, repoRoot: tmp });

    await runIncident({
      incidentId: 'INC-001',
      runner:     createFakeRunner(),
      dryRun:     false,
      publish:    true,
      publisher,
      _incidentsDir: incDir,
      _runsDir:      runsDir,
    });

    assert.ok(runFileExistedAtAdd,
      'runs/INC-001.json must exist on disk before git add is called');
  });

  test('pr_url is set in the returned run object after publishing', async (t) => {
    const tmp = makeTmp('pr-url');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const incDir  = seedIncidentsDir(tmp, ['INC-001']);
    const runsDir = path.join(tmp, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const gitRunner = async (args) => {
      if (args[0] === 'status') return '';
      return '';
    };
    const prRunner  = async () => 'https://github.com/org/repo/pull/7';
    const publisher = createGitPublisher({ gitRunner, prRunner, repoRoot: tmp });

    const run = await runIncident({
      incidentId: 'INC-001',
      runner:     createFakeRunner(),
      dryRun:     false,
      publish:    true,
      publisher,
      _incidentsDir: incDir,
      _runsDir:      runsDir,
    });

    assert.equal(run.artifacts.pr_url, 'https://github.com/org/repo/pull/7',
      'pr_url must be set in the returned run object');
  });

  test('publishing failure is recorded clearly and does not succeed silently', async (t) => {
    const tmp = makeTmp('pub-fail');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const incDir  = seedIncidentsDir(tmp, ['INC-001']);
    const runsDir = path.join(tmp, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const gitRunner = async (args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'push')   throw new Error('remote: permission denied');
      return '';
    };
    const prRunner  = async () => '';
    const publisher = createGitPublisher({ gitRunner, prRunner, repoRoot: tmp });

    const run = await runIncident({
      incidentId: 'INC-001',
      runner:     createFakeRunner(),
      dryRun:     false,
      publish:    true,
      publisher,
      _incidentsDir: incDir,
      _runsDir:      runsDir,
    });

    // Publishing failed, but the run itself is not failed
    assert.ok(run.status !== 'failed' || run.backtest.evidence !== null,
      'Publishing failure must be recorded');
    assert.ok(
      run.backtest.evidence && run.backtest.evidence.includes('Publishing error'),
      `Expected "Publishing error" in evidence: ${run.backtest.evidence}`,
    );
    assert.equal(run.artifacts.pr_url, null,
      'pr_url must remain null when publishing fails');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17. CLI argument parsing edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe('17. CLI argument parsing', () => {
  test('default concurrency is 2', () => {
    const opts = parseArgs(['node', 'index.js', '--all']);
    assert.equal(opts.concurrency, 2);
  });

  test('multiple --incident flags are collected', () => {
    const opts = parseArgs(['node', 'index.js', '--incident', 'INC-001', '--incident', 'INC-003']);
    assert.deepEqual(opts.incidents, ['INC-001', 'INC-003']);
  });

  test('--concurrency parses an integer', () => {
    const opts = parseArgs(['node', 'index.js', '--all', '--concurrency', '4']);
    assert.equal(opts.concurrency, 4);
  });
});
