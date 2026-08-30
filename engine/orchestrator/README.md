# engine/orchestrator

Node.js orchestrator for the scar-tissue pipeline. Reads incident documents
from `incidents/`, invokes the five IBM Bob agent modes in the correct
dependency order, records honest timing, and writes `runs/<incident-id>.json`.

---

## Quick start

```sh
# Dry-run a single incident (fake runner — safe to run anywhere)
node engine/orchestrator/index.js --incident INC-001 --dry-run

# Dry-run all discovered incidents with concurrency 2
node engine/orchestrator/index.js --all --concurrency 2 --dry-run

# Real run (requires a verified runner adapter — see below)
node engine/orchestrator/index.js --incident INC-001

# Real run + publish one PR per incident (requires verified runner + gh CLI)
node engine/orchestrator/index.js --incident INC-001 --publish
```

`--publish` is always opt-in. Dry-run and tests never push, commit, branch,
or open pull requests.

---

## Bob CLI availability and real invocation

The `bob` CLI was **not found in PATH** on this machine
(`CommandNotFoundException` from PowerShell — both `bob --help` and
`bob shell --help` were attempted and failed).

**No Bob CLI flags have been discovered or assumed.** The default real runner
(`createBobShellRunner`) throws `BobCliUnavailableError` immediately on every
call, before any files are written or Git state is changed.

### How to connect a real Bob runner

Implement the adapter contract and pass it as the `runner` option:

```js
const { runIncident } = require('./engine/orchestrator/index.js');

// Your adapter — implement once the CLI interface is confirmed.
async function myVerifiedRunner(agentName, ctx) {
  // Call the Bob CLI or API with verified flags.
  // Return { output: string, durationMs: number }
  // Throw on any failure.
}

await runIncident({
  incidentId: 'INC-001',
  runner:     myVerifiedRunner,
  dryRun:     false,
  publish:    false,
});
```

The five `agentName` values are: `locator`, `historian`, `reproducer`,
`fixer`, `immunizer`. These match the custom mode IDs in
`.bob/custom_modes.yaml`.

**Live Bob-shell execution remains unverified.** The CLI interface is not
documented in this file because it has not been confirmed.

---

## Dependency graph (per incident)

```
locator ─────┐
             ├─► reproducer ─► fixer ─► immunizer
historian ───┘
```

- **Locator** and **Historian** depend only on the incident postmortem.
  They run *concurrently* via `Promise.allSettled`. Both settle before the
  pipeline continues or records failure, so neither is left as an unobserved
  Promise.
- **Reproducer** waits for both Locator and Historian.
- **Fixer** waits for Reproducer.
- **Immunizer** waits for Fixer.

If either first-stage agent fails, both agent records are retained, and
Reproducer, Fixer, and Immunizer receive honest `aborted` error records.

Separate incidents run concurrently up to `--concurrency` (default: 2) via a
work-stealing pool.

---

## Timing and honest overlap

Every agent record carries:

| Field             | Meaning                                           |
|-------------------|---------------------------------------------------|
| `started_at`      | ISO-8601 wall-clock timestamp                     |
| `start_offset_sec`| Seconds after the incident pipeline began (float) |
| `duration_sec`    | Wall-clock duration measured by monotonic clock   |

Because Locator and Historian are launched with `Promise.allSettled`, their
`start_offset_sec` values are both very close to `0`, and the dashboard
timeline's **measured mode** renders genuine overlap between their bars.

---

## Run JSON output

Each run writes `runs/<incident-id>.json` atomically (temp file → rename)
with the shape required by `AGENTS.md`:

```json
{
  "incident_id": "INC-001",
  "status": "immunized | needs_review | failed",
  "bug_class": "<taxonomy id>",
  "confidence": 0.86,
  "timeline": { "started_at": "…", "finished_at": "…", "duration_sec": 390 },
  "agents": [
    {
      "name": "locator",
      "status": "ok | error",
      "started_at": "…",
      "start_offset_sec": 0.012,
      "duration_sec": 41.3,
      "summary": "…"
    }
  ],
  "artifacts": { "failing_test": "…", "patch_diff": "…", "guardrail": "…", "pr_url": null },
  "backtest": { "prevented": false, "evidence": null },
  "manual_baseline_sec": 10800
}
```

### Status rules

| Condition                                     | Status         |
|-----------------------------------------------|----------------|
| All agents OK, confidence ≥ 0.6               | `immunized`    |
| All agents OK, confidence < 0.6               | `needs_review` |
| Any agent runner/parse failure                | `failed`       |

Guardrails are installed to `guardrails/` (canonical) and `.bob/rules/`
(active) **only when confidence ≥ 0.6** on a real (non-dry-run) run.

---

## Publishing (opt-in)

Publishing requires `--publish`, a clean worktree, exactly one `--incident`,
and a verified runner adapter. The sequence is:

1. Worktree is asserted clean *before* any files are generated.
2. Pipeline runs and writes `runs/<incident>.json`.
3. Incident branch `scar-tissue/<inc-lower>-<yyyymmdd>` is created.
4. Run JSON and guardrail are staged (explicit allowlist only).
5. Committed.
6. Pushed.
7. PR created via `gh pr create`; URL stored in `artifacts.pr_url`.

No destructive Git commands (`reset --hard`, `checkout --`) are used.
Multiple concurrent incidents with `--publish` is not supported because true
isolated-worktree behavior is not implemented.

---

## Files

| File                     | Responsibility                                         |
|--------------------------|--------------------------------------------------------|
| `index.js`               | CLI, concurrency pool, pipeline orchestration          |
| `runner.js`              | Runner adapter contract; fake runner; unavailable stub |
| `validation.js`          | Per-agent output parsers, path safety, taxonomy checks |
| `git-publisher.js`       | Branch creation, commit, push, PR (injectable)         |
| `README.md`              | This file                                              |
| `orchestrator.test.js`   | node:test regression suite                             |

---

## Running tests

```sh
node --test engine/orchestrator/orchestrator.test.js
```

Tests use temporary directories and fake runners/adapters. They never touch
`runs/`, `sandbox/`, `guardrails/`, real branches, remotes, or the network.

---

## Shutdown behavior

`SIGINT` sets a flag. In-flight runner calls are allowed to settle naturally
before the process exits. **No child-process tracking is implemented** — the
fake runner spawns no subprocesses. A verified real runner adapter is
responsible for its own subprocess cleanup.

---

## Remaining limitations

1. **Bob CLI unverified.** No real Bob invocation has been confirmed. A real
   run requires a caller-supplied adapter (see above).
2. **Fake runner returns uniform outputs.** Real pipeline quality depends on
   the sandbox being populated and a live Bob adapter being supplied.
3. **Immunizer output format constraint.** Inner code fences inside the outer
   fenced block are handled by a greedy regex; deeply nested fences may still
   confuse the parser.
4. **`gh` CLI required for `--publish`.** If not installed or authenticated,
   publishing fails clearly — the run file is still written.
5. **Windows rename is not OS-atomic.** `writeJsonAtomic` uses temp file +
   rename, the closest available primitive.
6. **Publishing requires a single incident.** Concurrent `--publish` across
   multiple incidents is not implemented (would require isolated worktrees).
7. **`pr_url` not re-written to disk.** After publishing the PR URL is held
   in the in-memory run object and printed to stdout. The on-disk
   `runs/<id>.json` does not include it (would require a second atomic write
   after `git add` on the same file).
8. **No child-process cleanup on SIGINT.** See Shutdown behavior above.
