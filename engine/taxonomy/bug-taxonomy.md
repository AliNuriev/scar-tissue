# Bug Taxonomy

The taxonomy is the vocabulary the whole pipeline shares. Every incident gets
classified into exactly one class, and the class determines how the incident is
reproduced, how it is fixed, and what kind of guardrail is generated from it.

Without a fixed vocabulary each incident would produce a one-off rule tied to
one file and one line, which prevents nothing. The taxonomy is what forces
generalisation.

The machine-readable source of truth is `bug-taxonomy.json`. This document
explains what the fields mean and why the classes were chosen.

## Field reference

| Field | Purpose |
|---|---|
| `id` | Stable identifier. Appears as `bug_class` in `runs/*.json` and in guardrail frontmatter. |
| `definition` | What the class actually is, in one sentence. Given to the classifier agent verbatim. |
| `tier` | `core` classes ship in the demo. `stretch` classes are added only if time allows. |
| `prose_signals` | Phrases that appear in postmortems written by humans. This is how a document gets classified. |
| `code_pattern` | What the flaw looks like in source. Used by the Locator agent to find it. |
| `guardrail_strategy` | The shape of the rule this class should produce. Constrains the Immunizer so it does not invent an instance-specific rule. |
| `detection_hint` | A regular expression used by the backtest harness to decide whether the guardrail would have caught the original code. |
| `test_strategy` | How the Reproducer writes a failing test for this class. |
| `generalizes_well` | Honest flag. `false` means rules of this class tend to over-match, so the confidence score is penalised. |

## The classes

Five core classes, two stretch.

**`race-condition`** — the strongest class for the demo. It is invisible to
manual testing and to code review, it only appears under concurrency, and the
guardrail is unambiguous: a read-decide-write on shared state must be atomic.
For Galaxium Travels the natural instance is a seat or ticket being claimed by
two requests at once.

**`unvalidated-input`** - the most reliable class. Detection is close to
syntactic, the rule generalises cleanly, and every Express codebase has route
handlers that reach straight into `req.body`. This is the safety net: if
everything else proves fragile, this class still works.

**`unbounded-resource`** - high business relevance and a very readable
postmortem, but the rule over-matches on legitimately small collections. Marked
`generalizes_well: false`, which means it will sometimes land in
`needs_review`. That is deliberate and it is worth keeping for exactly that
reason, explained below.

**`boundary-error`** - the classic off-by-one, empty-collection, month-end,
rounding family. Common in real postmortems, easy to write believable incident
reports for, and the test strategy is mechanical: enumerate the boundaries.

**`resource-leak`** - connection pools, file handles, timers. The prose signal
"fixed by a restart" is an unusually strong tell, which makes the classifier's
job easy and the incident report convincing.

**`error-swallowing`** *(stretch)* - an empty `catch` block or a `catch` that
returns `null`. Detection is genuinely syntactic and therefore very reliable.
Cheap to add if the core five are working.

**`contract-violation`** *(stretch)* - shape drift between caller and callee.
Real and important, but the hardest to detect without proper AST analysis.
Include last, or not at all.

## Why `generalizes_well` and the confidence threshold matter

The `confidence_threshold` is `0.6`. Anything below it is written to
`runs/*.json` with `status: needs_review` and no guardrail is installed.

This is not a limitation to hide. It is the most defensible part of the design.

A system that claims every generated rule is correct is not credible, and any
judge who has worked with LLMs will assume the demo was cherry-picked. A system
that says "nine of twelve produced a rule I would install, two need a human, one
failed" is describing something that could actually be adopted. The
`needs_review` state in the dashboard is doing real work: it is the visible
evidence that the system knows what it does not know.

Confidence is lowered by three things: a class flagged
`generalizes_well: false`, a rule whose detection expression matches large
amounts of existing code (over-broad), and a postmortem whose prose signals
matched more than one class.

## Extending

Adding a class means adding an object to the `classes` array in the JSON.
Nothing else changes: the agents read the taxonomy at runtime, so a new class
flows through the classifier, the reproducer, the immunizer, and the backtest
harness without any code change.

That property is worth stating explicitly in the submission. It is the
difference between a demo and a system.