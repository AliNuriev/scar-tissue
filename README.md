# scar-tissue

An automated post-incident pipeline that turns postmortem documents into
installed guardrails for IBM Bob.

---

## Problem

An incident happens, a postmortem is written, the symptom is fixed, and months
later the same class of bug appears elsewhere — because the lesson lived in a
document nobody reads. The team that wrote INC-001 also wrote a thorough
postmortem; four months later the same race-condition appeared in a different
module as INC-006, and the postmortem prevented nothing. AI coding agents make
this worse: they have no memory of the team's history and will generate the
exact pattern the team already got burned by. The fix needs to be somewhere the
agent reads, not somewhere a human files.

---

## Solution

The pipeline takes incident postmortem documents as input and, for each one,
produces a failing test, a minimal patch, and a guardrail file installed into
`.bob/rules/` that blocks the whole **class** of bug in future code generation
— not just the instance.

Five subagents run in sequence:

1. **Locator** — reads the postmortem prose and identifies the one file and
   function most likely responsible.
2. **Historian** — classifies the incident into exactly one bug class from the
   taxonomy, using `prose_signals` matching; sets a confidence score.
3. **Reproducer** — writes a single failing test targeting the located function
   and the bug class's `test_strategy`.
4. **Fixer** — produces the minimal unified diff that makes the failing test
   pass, touching only the located file.
5. **Immunizer** — drafts a guardrail file that generalises the lesson to a
   class, not an instance.

The output of this system is configuration for **IBM Bob itself**: guardrail
files installed into `.bob/rules/` change what Bob is willing to write on the
next request.

---

## How IBM Bob was used

**Five custom modes** are registered in [`.bob/custom_modes.yaml`](.bob/custom_modes.yaml),
one per pipeline subagent. Each mode has a distinct `roleDefinition`, a
`whenToUse` clause, and write permissions scoped to exactly what that agent
needs:

| Mode | Write permission |
|---|---|
| Locator | read-only |
| Historian | read-only |
| Reproducer | `sandbox/**/*.test.{js,ts}` only |
| Fixer | `sandbox/**/*.{js,ts}` (non-test) only |
| Immunizer | `guardrails/*.md` only |

**Five agent prompt files** live in [`engine/agents/`](engine/agents/): one
`.md` per subagent. Each mode's `customInstructions` field tells Bob to read
its prompt file before acting, so the full instructions load at request time
rather than being embedded in the YAML.

**Document understanding** — postmortems deliberately do not name their bug
class. The Historian classifies them by counting `prose_signals` matches from
[`engine/taxonomy/bug-taxonomy.json`](engine/taxonomy/bug-taxonomy.json).
Phrases like "could not reproduce locally", "double booking", and "simultaneous
requests" are the signals that identify a race-condition class; "returned 500
instead of 400" and "wrong type" identify unvalidated-input. No LLM
classification prompt is needed beyond the taxonomy file itself.

**Full pipeline run on INC-003** — the complete five-stage pipeline was run in
Agent mode on INC-003 (unvalidated-input class): Locator identified
`routes/search.js`, Historian classified the bug class at 0.93 confidence,
Reproducer wrote a failing test, Fixer patched the handler, and Immunizer
produced [`guardrails/unvalidated-input-route-handler.md`](guardrails/unvalidated-input-route-handler.md).
Session screenshots are in [`bob_sessions/alinuriev/04-pipeline-INC-003/`](bob_sessions/alinuriev/04-pipeline-INC-003/).

**Installed guardrails change what Bob writes** — with both guardrails active,
Bob cites `race-condition-shared-resource` and `unvalidated-input-route-handler`
by name and writes the atomic (`findOneAndUpdate`) and input-validated versions
instead of the read-check-write and unvalidated patterns found elsewhere in the
sandbox. Screenshots of this state are in
[`bob_sessions/alinuriev/05-guardrail-demo/`](bob_sessions/alinuriev/05-guardrail-demo/).
The folder contains only the "after" state; a side-by-side before/after
comparison is not evidenced there.

---

## Architecture

```
incidents/<INC-N>.md
        │
        ▼  Locator (read-only)
        │  → file, function, justification
        │
        ▼  Historian (read-only)
        │  → bug_class, confidence  (prose_signals matching against taxonomy)
        │
        ▼  Reproducer (writes sandbox/**/*.test.js)
        │  → failing test
        │
        ▼  Fixer (writes sandbox/**/*.js, non-test)
        │  → minimal unified diff
        │
        ▼  Immunizer (writes guardrails/*.md)
           → guardrail file
                │
                ▼  manual install (cp guardrails/<id>.md .bob/rules/)
                   → active guardrail read by Bob on every future request
```

Backtest harness (`engine/backtest/index.js`) runs every active guardrail's
`detection` regex against the mapped sandbox files for each incident and writes
`runs/summary.json`. No LLM in the measurement loop.

---

## Impact

**Prevention rate: 2 of 4 scored incidents** (8 of 12 have not been processed
and are excluded from the denominator).

From `runs/summary.json` (generated 2026-08-29):

| Metric | Value |
|---|---|
| Incidents total | 12 |
| Incidents immunized | 2 |
| Guardrails active | 2 |
| Bug classes covered | race-condition, unvalidated-input |
| Prevention rate | 2 / 4 scored |
| Estimated time saved | 52 200 s (~14.5 hours) |
| Avg pipeline duration | 525 s |
| Avg manual baseline | 10 800 s (3 hours) |

**Two cross-incident preventions demonstrate generalisation:**

- The `race-condition-shared-resource` guardrail was derived from INC-001
  (`services/booking.js`). The backtest shows it catches INC-006
  (`services/loyalty.js`) — a different module, written four months later, by
  the same team that had already filed a thorough postmortem on the first
  incident. The guardrail blocked the class where the postmortem did not.

- The `unvalidated-input-route-handler` guardrail was derived from INC-003
  (`routes/search.js`). The backtest shows it catches INC-007
  (`routes/fares.js`) — a different route handler, reached through a different
  input source. The guardrail generalised from one handler to the whole class.

This demonstrates the core thesis: a class-level rule installed where the
agent reads it prevents recurrences that an instance-level postmortem does not.

**Limitations (stated plainly):**

- Detection is regex-based, not AST-based. A regex cannot distinguish a
  pattern in live code from the same string in a comment or literal, and it
  will miss semantically equivalent forms written with different whitespace or
  variable names. The `prevention_rate` is a lower bound, not an exact count.
- 8 of 12 incidents have not been processed. Their sandbox files do not yet
  exist, so they are excluded from the scored denominator. The prevention rate
  applies only to the 4 incidents that have been fully mapped and populated.
- The sandbox (`sandbox/`) is a small fixture set rather than a full
  application. The guardrails have been validated against these fixtures;
  broader applicability depends on the full codebase being present.

---

## How to run

**Run the backtest** (scores all active guardrails against mapped sandbox files
and writes `runs/summary.json`):

```sh
node engine/backtest/index.js
```

**Validate a guardrail** before installing it (three checks: matches pre-fix
code, does not match post-fix code, not over-broad across the repo):

```sh
# race-condition guardrail against booking fixtures
node engine/backtest/validate.js \
    --guardrail guardrails/race-condition-shared-resource.md \
    --before    engine/backtest/fixtures/services/booking.before.js \
    --after     engine/backtest/fixtures/services/booking.after.js

# unvalidated-input guardrail against search fixtures
node engine/backtest/validate.js \
    --guardrail guardrails/unvalidated-input-route-handler.md \
    --before    engine/backtest/fixtures/routes/search.before.js \
    --after     engine/backtest/fixtures/routes/search.after.js
```

Exit code is `0` when all checks pass, `1` when any check fails.

---

## Team

- **Ali Nuriev** — team lead
- **Harsh Yadav** — general member

---

## Bob session evidence

[`bob_sessions/alinuriev/`](bob_sessions/alinuriev/) contains screenshot
evidence from five Bob sessions:

| Folder | What it shows |
|---|---|
| `01-subagent-prompts/` | Writing the five agent prompt files in `engine/agents/` |
| `02-agents-config/` | Registering the five custom modes in `.bob/custom_modes.yaml` |
| `03-backtest-harness/` | Building and fixing the backtest harness in `engine/backtest/` |
| `04-pipeline-INC-003/` | Full five-stage pipeline run on INC-003: locate → classify → test → fix → guardrail |
| `05-guardrail-demo/` | Before/after demo: Bob generates the vulnerable pattern without guardrails; refuses with them installed |

`bob_sessions/harshyadav/` exists as a placeholder; session evidence has not
been added yet.
