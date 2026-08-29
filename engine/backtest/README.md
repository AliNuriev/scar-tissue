# engine/backtest

Two standalone Node scripts.  No dependencies beyond the Node standard library.

---

## Commands

### 1. Run the backtest

```sh
node engine/backtest/index.js
```

Tests all active guardrails against the mapped source files for each incident
and writes `runs/summary.json`.

**Options**

| Flag | Default | Meaning |
|---|---|---|
| `--sandbox <path>` | `sandbox/` | Root of the source tree under test |

**Examples**

```sh
# Default — uses sandbox/ relative to the repo root
node engine/backtest/index.js

# Explicit path
node engine/backtest/index.js --sandbox /path/to/galaxium-travels/src
```

If the sandbox path does not exist the harness reports the problem clearly
and exits with code 1 rather than crashing.

**What it does**

1. Reads every `.md` file in `guardrails/` (skipping `_TEMPLATE.md`).
2. Keeps only those whose `status` is `active`.
3. Iterates all 12 incident IDs, regardless of whether a run file exists.
4. For each incident, resolves its mapped files from `incident-map.json`
   and reads only those files from the sandbox.
5. Runs every active guardrail's `detection` regex against **only that
   incident's mapped files**.  A match credits that incident as prevented.
6. **Honesty rule**: a guardrail whose `source_incidents` includes the
   incident being tested is skipped and the skip is logged.
7. Prints a table and overwrites `runs/summary.json`.

**Three-state output**

| State | Meaning |
|---|---|
| `prevented` | A guardrail regex matched the incident's mapped file(s) |
| `not prevented` | Mapped files exist on disk, no guardrail matched |
| `not yet processed` | No mapping, mapped files missing, or no run file — excluded from denominator |

**Output table example**

```
INCIDENT  BUG CLASS               STATE             GUARDRAIL
──────────────────────────────────────────────────────────────────────────────
INC-001   race-condition          not prevented     —
INC-002   unbounded-resource      not yet processed —
INC-006   race-condition          prevented         race-condition-shared-resource
…

Prevention rate : 1/4 scored (8 not yet processed)
```

`prevention_rate` in `summary.json` is `null` when no incidents are
scoreable, rather than a misleading 0.

---

### 2. Validate a guardrail

```sh
node engine/backtest/validate.js \
    --guardrail <guardrail.md> \
    --before    <pre-fix-file.js> \
    --after     <post-fix-file.js> \
    [--repo     <repo-root>] \
    [--max-matches N]
```

Runs three checks before a guardrail is installed.

| Check | What it tests | Failure meaning |
|---|---|---|
| 1 | Regex **matches** the pre-fix code | The guardrail does not describe the actual bug |
| 2 | Regex **does not match** the post-fix code | The guardrail cannot distinguish fixed from broken |
| 3 | Regex matches **≤ N** places across the repo | The regex is too broad and would produce noise |

A guardrail failing check 1 or 2 is meaningless: it either does not see the
bug, or it cannot tell when the bug is gone.  Both are grounds for rejection.

Check 3 is a breadth check.  `--max-matches` defaults to `10`.  Tune it
upward for a class that is expected to appear frequently.

`--repo` defaults to the repo root.  If it does not exist, check 3 is skipped
with a notice.

**Example — using the bundled fixtures**

```sh
# Validate the race-condition guardrail against the booking fixtures
node engine/backtest/validate.js \
    --guardrail guardrails/race-condition-shared-resource.md \
    --before    engine/backtest/fixtures/services/booking.before.js \
    --after     engine/backtest/fixtures/services/booking.after.js

# Validate an unvalidated-input guardrail against the search fixtures
node engine/backtest/validate.js \
    --guardrail guardrails/unvalidated-input-route-handler.md \
    --before    engine/backtest/fixtures/routes/search.before.js \
    --after     engine/backtest/fixtures/routes/search.after.js
```

Exit code is `0` when all checks pass, `1` when any check fails.

---

## incident-map.json

`engine/backtest/incident-map.json` maps each of the 12 incident IDs to the
sandbox file(s) responsible for that incident, plus the expected `bug_class`.

```json
{
  "INC-001": {
    "bug_class": "race-condition",
    "files": ["services/booking.js"]
  }
}
```

The harness tests each incident's guardrail regex **only against those files**.
This prevents a guardrail for bug class A from being credited with preventing
an incident that belongs to bug class B just because the pattern happens to
appear somewhere else in the codebase.

Add or update entries here as new incidents are processed and sandbox files
are populated.

---

## Detection is regex-based, not AST-based

Every guardrail's `detection` field is a regular expression that is run
against raw source text.  This is intentional.

**What it gains:** zero build-time dependencies, no language parser to
maintain, works across JS/TS variants without configuration, and runs fast
enough to score all twelve incidents in under a second.

**What it trades away:**

- **False positives** — a regex cannot distinguish a function call from the
  same string in a comment or a string literal.  A match does not prove the
  dangerous pattern is actually reachable.
- **False negatives** — a semantically equivalent pattern written differently
  (different whitespace, renamed variable, refactored helper) will not match.
  The regex encodes one surface form of the bug, not the concept.
- **No cross-file reasoning** — if the vulnerable code is split across two
  files the regex will not see it.

The practical implication: the `prevention_rate` in `runs/summary.json` is
a **lower bound**, not an exact count.  It answers the question "would the
installed guardrails have flagged this pattern?" not "would they have caught
this specific bug in all its possible forms?"  That limitation belongs in
any writeup that cites the number; stating it costs nothing and buys
credibility.

---

## Fixtures

`engine/backtest/fixtures/` contains small before/after code pairs for use
with the validation command when the sandbox is not yet populated.

| Fixture pair | Bug class | Incident |
|---|---|---|
| `services/booking.before.js` / `booking.after.js` | `race-condition` | INC-001 |
| `services/loyalty.before.js` / `loyalty.after.js` | `race-condition` | INC-006 |
| `routes/search.before.js` / `search.after.js` | `unvalidated-input` | INC-003 |
| `routes/fares.before.js` / `fares.after.js` | `unvalidated-input` | INC-007 |

Each file is under 30 lines.  Add pairs here as new guardrail classes are
added.
