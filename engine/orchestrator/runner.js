/**
 * engine/orchestrator/runner.js
 *
 * Injectable runner adapter for invoking IBM Bob agent modes.
 *
 * ## Bob CLI availability
 *
 * The `bob` CLI was NOT found in PATH on this machine
 * (CommandNotFoundException from PowerShell — both `bob --help` and
 * `bob shell --help` were attempted and failed).
 *
 * No Bob CLI flags have been discovered. `createBobShellRunner` therefore
 * does NOT attempt any invocation. It throws `BobCliUnavailableError`
 * immediately so the caller receives a clear, actionable error before any
 * files are written or Git state is changed.
 *
 * ## How to connect a real Bob runner
 *
 * Implement the adapter contract below and pass the result as the `runner`
 * option to `runIncident`. The contract is the only stable interface:
 *
 *   runner(agentName, ctx) → Promise<{ output: string, durationMs: number }>
 *
 * `output`     — raw text response from the agent
 * `durationMs` — wall-clock milliseconds measured by a monotonic source
 *
 * The runner MUST throw on invocation failure.  The pipeline catches the
 * throw and records the agent as `error`.
 *
 * ## Mode IDs (for future integration)
 *
 * The five custom modes in .bob/custom_modes.yaml are:
 *   locator, historian, reproducer, fixer, immunizer
 *
 * These are documented here for reference only. No invocation flags are
 * assumed because the Bob CLI interface has not been verified.
 */

'use strict';

const { performance } = require('node:perf_hooks');

// ── Public constants ──────────────────────────────────────────────────────────

/** Canonical mode ID for each pipeline stage. */
const MODE_IDS = {
  locator:    'locator',
  historian:  'historian',
  reproducer: 'reproducer',
  fixer:      'fixer',
  immunizer:  'immunizer',
};

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Thrown by `createBobShellRunner` when the Bob CLI is unavailable.
 * Thrown before any file is written or Git command is run.
 */
class BobCliUnavailableError extends Error {
  constructor() {
    super(
      'The Bob CLI is not available. ' +
      'Real incident runs require a verified runner adapter. ' +
      'See engine/orchestrator/README.md for integration instructions. ' +
      'Use --dry-run to exercise the pipeline with the fake runner.'
    );
    this.name = 'BobCliUnavailableError';
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build the prompt string for a given agent and its input context.
 * Exported for testing and future runner implementations.
 *
 * @param {string} agentName  - One of the five pipeline stage names.
 * @param {object} ctx        - Context object passed from the pipeline.
 * @returns {string}
 */
function buildPrompt(agentName, ctx) {
  switch (agentName) {
    case 'locator':
      return (
        `Read engine/agents/locator.md then act on it.\n` +
        `Incident postmortem:\n\n${ctx.postmortem}`
      );
    case 'historian':
      return (
        `Read engine/agents/historian.md then act on it.\n` +
        `Incident postmortem:\n\n${ctx.postmortem}\n\n` +
        `Taxonomy: engine/taxonomy/bug-taxonomy.json\n` +
        `Existing guardrail ids: ${JSON.stringify(ctx.existingGuardrailIds ?? [])}`
      );
    case 'reproducer':
      return (
        `Read engine/agents/reproducer.md then act on it.\n` +
        `Located file: ${ctx.locatorResult.file}\n` +
        `Located function: ${ctx.locatorResult.function}\n` +
        `Bug class: ${ctx.historianResult.bug_class}\n\n` +
        `Read the located function from the sandbox and the taxonomy entry for the bug class.`
      );
    case 'fixer':
      return (
        `Read engine/agents/fixer.md then act on it.\n` +
        `Located file: ${ctx.locatorResult.file}\n` +
        `Located function: ${ctx.locatorResult.function}\n` +
        `Failing test: ${ctx.reproducerResult.failing_test}\n\n` +
        `Run the failing test, then produce the minimal patch.`
      );
    case 'immunizer':
      return (
        `Read engine/agents/immunizer.md then act on it.\n` +
        `Incident: ${ctx.incidentId}\n` +
        `Bug class: ${ctx.historianResult.bug_class}\n` +
        `Confidence: ${ctx.historianResult.confidence}\n` +
        `Located file: ${ctx.locatorResult.file}\n` +
        `Failing test: ${ctx.reproducerResult.failing_test}\n` +
        `Patch diff: ${ctx.fixerResult.patch_diff}\n\n` +
        `Read the before/after code from the sandbox and produce the guardrail file.`
      );
    default:
      throw new Error(`Unknown agent name: ${agentName}`);
  }
}

// ── Placeholder real runner (fails immediately) ───────────────────────────────

/**
 * Create a runner placeholder for the Bob CLI.
 *
 * This runner throws `BobCliUnavailableError` on every call because the Bob
 * CLI interface has not been verified on this machine. It exists to give the
 * pipeline a clear, early failure rather than a cryptic spawn error.
 *
 * To perform a real run, supply a verified runner implementation via the
 * `runner` option of `runIncident`. See README.md.
 *
 * @returns {Function}  runner(agentName, ctx) → Promise<never>
 */
function createBobShellRunner() {
  return async function bobShellRunner(_agentName, _ctx) {
    throw new BobCliUnavailableError();
  };
}

// ── Fake runner (for tests and dry-runs) ─────────────────────────────────────

/**
 * Create a fake runner for tests and dry-runs. Responses are deterministic
 * minimal strings that satisfy each agent's output contract.
 *
 * @param {object} [overrides]  Per-agent output overrides for targeted tests.
 *   Pass a function as the value for dynamic responses:
 *     createFakeRunner({ historian: (ctx) => '...' })
 *   Pass null/undefined to force a runner-level throw for that agent.
 * @returns {Function}  runner(agentName, ctx) → Promise<{output, durationMs}>
 */
function createFakeRunner(overrides = {}) {
  return async function fakeRunner(agentName, ctx) {
    const defaults = {
      locator: [
        'file: sandbox/services/booking.js',
        'function: bookSeat',
        'justification: The booking service handles seat reservation and matched the incident narrative.',
      ].join('\n'),

      historian: [
        'bug_class: race-condition',
        'confidence: 0.86',
        'already_covered: false',
        'coverage_note: none',
      ].join('\n'),

      reproducer:
        '```sandbox/tests/INC-TEST.test.js\n// Asserts atomic seat claim\nconst assert = require("node:assert");\nassert.ok(true);\n```',

      fixer:
        '```diff\n--- a/sandbox/services/booking.js\n+++ b/sandbox/services/booking.js\n@@ -1,1 +1,1 @@\n-old line\n+new line\n```',

      // NOTE: Inner code fences would close the outer ``` block prematurely
      // under a non-greedy regex, so code examples use indented plain text.
      immunizer: [
        '```guardrails/race-condition-shared-resource.md',
        '---',
        'id: race-condition-shared-resource',
        'bug_class: race-condition',
        'source_incidents: [INC-TEST]',
        'confidence: 0.86',
        'created_at: 2026-01-01T00:00:00Z',
        'scope: ["services/**/*.js"]',
        'detection: "await[^;]+find"',
        'status: active',
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
    };

    // Allow override as a function (receives ctx) or a plain string.
    let output;
    if (Object.prototype.hasOwnProperty.call(overrides, agentName)) {
      const ov = overrides[agentName];
      if (ov === null || ov === undefined) {
        throw new Error(`Fake runner: forced failure for agent "${agentName}"`);
      }
      output = typeof ov === 'function' ? ov(ctx) : ov;
    } else {
      output = defaults[agentName];
    }

    if (output === undefined) throw new Error(`No fake output for agent: ${agentName}`);

    // Simulate a tiny delay so timing is non-zero and monotonic.
    const t0 = performance.now();
    await new Promise(r => setTimeout(r, 5));
    const durationMs = performance.now() - t0;
    return { output, durationMs };
  };
}

module.exports = {
  BobCliUnavailableError,
  createBobShellRunner,
  createFakeRunner,
  buildPrompt,
  MODE_IDS,
};
