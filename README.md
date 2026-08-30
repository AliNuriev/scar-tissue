# scar-tissue

An automated post-incident pipeline that turns postmortem documents into installed coding rules for IBM Bob.

> **Demo video:** https://youtu.be/oR6vMDyG60k

---

## Problem

INC-001: two passengers booked the same seat within the same second. Both requests read the seat as
available, both passed the check, and both wrote a booking. The postmortem was filed, the root cause
was documented, the fix was merged.

Four months later INC-006 happened — the same class of bug, in a different module. The postmortem
for the first incident existed, was accurate, and prevented nothing. No mechanism connected the
lesson to the next engineer who wrote a read-decide-write sequence on shared state.

AI coding assistants make this worse. A model that has never seen a team's incident history will
reproduce the same vulnerable pattern confidently and fluently, because the pattern is common and
the postmortem lives in a document the model has no access to.

---

## Solution

Five specialised subagents process each incident in sequence:

1. **Locator** — reads the postmortem prose and identifies the one file and function most likely responsible for the failure.
2. **Historian** — classifies the incident into exactly one bug class from `engine/taxonomy/bug-taxonomy.json` using `prose_signals` matching; sets confidence.
3. **Reproducer** — writes a single failing test targeting the located function and the bug class's `test_strategy`.
4. **Fixer** — produces the minimal unified diff that makes the failing test pass, touching only the located file.
5. **Immunizer** — drafts a guardrail file generalising the lesson to a class, not an instance.

The output of the pipeline is configuration for IBM Bob itself. Guardrails are written to
`guardrails/` (canonical, reviewed) and installed into `.bob/rules/` (what Bob reads at request
time). With rules installed, Bob refuses to write the vulnerable pattern and cites the rule by name.

---

## How IBM Bob was used

### Five custom modes

Five modes are defined in [`.bob/custom_modes.yaml`](.bob/custom_modes.yaml), one per pipeline
agent. Each mode's write permissions are scoped to exactly what that agent needs to touch:

| Mode | Write scope |
|---|---|
| Locator | read-only |
| Historian | read-only |
| Reproducer | `sandbox/.*\.test\.[jt]sx?$` — test files inside sandbox only |
| Fixer | `sandbox/(?!.*\.test\.[jt]sx?$).*\.[jt]sx?$` — non-test source files inside sandbox only |
| Immunizer | `guardrails/.*\.md$` — guardrail files in `guardrails/` only |

### Document understanding

Incident classification is driven by `prose_signals` matching: each bug class in
`engine/taxonomy/bug-taxonomy.json` carries a list of phrases a postmortem author would naturally
write ("fixed by a restart", "could not reproduce locally", "two users at the same time"). The
Historian agent counts matches and sets confidence accordingly. No labelled training data is
required; the taxonomy is the classifier.

### End-to-end runs in Agent mode

Four incidents (INC-001, INC-002, INC-003, INC-005) were processed end to end in Agent mode,
producing failing tests, patches, and guardrail files. The session transcripts and exported task
reports are in [`bob_sessions/`](bob_sessions/), with Ali Nuriev's exported session in
[`bob_sessions/session-exports-alinuriev/`](bob_sessions/session-exports-alinuriev/).

### The guardrail demo

With `.bob/rules/` empty, Bob writes the vulnerable pattern. Copy the guardrails in and ask again:
Bob writes the atomic, validated version and cites both the rule name and the escape hatch. The
separation between `guardrails/` and `.bob/rules/` exists precisely to make this before/after
demonstrable.

---

## Architecture

```
incident document (incidents/INC-NNN.md)
        │
        ▼  Locator      → file + function
        ▼  Historian    → bug class + confidence
        ▼  Reproducer   → failing test in sandbox/
        ▼  Fixer        → patch diff applied to sandbox/
        ▼  Immunizer    → guardrails/<id>.md
        │
        ▼  human review + copy to .bob/rules/
        │
        ▼  backtest: node engine/backtest/index.js --sandbox sandbox
                     → runs/summary.json  (prevention_rate: 33.3%)
```

---

## Impact

Four guardrails are active, covering four bug classes: `race-condition`, `unbounded-resource`,
`unvalidated-input`, and `resource-leak`.

The backtest scores each guardrail against every incident it did not generate. Four
cross-incident preventions result:

| Guardrail (source) | Incident prevented | Module |
|---|---|---|
| `race-condition-shared-resource` (INC-001) | INC-006 | different module, same pattern |
| `unbounded-resource-missing-limit` (INC-002) | INC-009 | different module, same pattern |
| `unvalidated-input-route-handler` (INC-003) | INC-007 | different module, same pattern |
| `resource-leak-missing-finally` (INC-005) | INC-010 | different module, same pattern |

**Prevention rate: 33.3% (4 of 12 incidents).** This is the number `node engine/backtest/index.js
--sandbox sandbox` prints and writes to `runs/summary.json`.

### How the measurement stays honest

- A guardrail is never scored against its own source incident. The harness logs and skips it.
- A guardrail may only score incidents that belong to the same bug class.
- The detection regex is tested only against the file(s) mapped to that incident in
  `engine/backtest/incident-map.json`, not the whole codebase.
- No language model participates in the measurement loop. The harness is a deterministic regex
  match over source files. Same rules, same code, same number on every run.

### Limitations, plainly stated

- **Detection is regex-based, not AST-based.** A regex cannot distinguish a function call from the
  same string in a comment or a string literal, and a semantically equivalent pattern written
  differently will not match. The `prevention_rate` is a lower bound.
- **Four of seven bug classes have rules.** `boundary-error`, `error-swallowing`, and
  `contract-violation` have no guardrail installed yet.
- **Eight incidents have not been through the pipeline.** INC-004 and INC-006 through INC-012 have
  no run files; they are scored by the backtest only as targets, not as processed incidents.
- **The sandbox is a fixture set, not a full application.** `sandbox/` is a curated set of source
  files representing `galaxium-travels`, written to exercise known bug patterns, not a deployable
  service.

---

## How to run

```sh
# Run the backtest and regenerate runs/summary.json
node engine/backtest/index.js --sandbox sandbox

# Validate a guardrail against its before/after fixtures
node engine/backtest/validate.js \
    --guardrail guardrails/race-condition-shared-resource.md \
    --before    engine/backtest/fixtures/services/booking.before.js \
    --after     engine/backtest/fixtures/services/booking.after.js

node engine/backtest/validate.js \
    --guardrail guardrails/unvalidated-input-route-handler.md \
    --before    engine/backtest/fixtures/routes/search.before.js \
    --after     engine/backtest/fixtures/routes/search.after.js

# Run the dashboard (http://localhost:4173)
node dashboard/server.js
```

Node 18+ required. No other dependencies.

---

## Team

**Ali Nuriev** — team lead  
**Harsh Yadav** — general member
