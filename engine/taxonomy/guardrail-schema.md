# Guardrail Schema

A guardrail is the product of this system. Everything else - the failing test,
the patch, the PR - is ordinary incident response that a competent engineer
would do anyway. The guardrail is the part that makes the lesson permanent.

## The one rule that matters

**A guardrail describes a class of mistake, never an instance of one.**

Bad, and worthless:

> Remember to lock the seat check in `services/booking.js` line 88.

Good:

> Any sequence that reads shared state, branches on it, and writes back to it
> must be atomic. Splitting the check and the claim into separate awaited
> statements is forbidden.

The first prevents nothing - the bug is already fixed there. The second
prevents the same mistake in a file that does not exist yet.

The Immunizer agent's only real job is making that jump. If it cannot, it must
say so and return low confidence rather than emit an instance-specific rule.
A pile of instance-specific rules is worse than nothing: it creates the
appearance of protection while consuming context on every request.

## Two locations, one source of truth

```
guardrails/<guardrail-id>.md    canonical, committed, reviewed
.bob/rules/<guardrail-id>.md    deployed, what Bob actually reads
```

`guardrails/` is the repository. `.bob/rules/` is the installation. A guardrail
is installed by copying it across, and uninstalled by deleting it.

This separation exists for one reason: **it makes the before/after demo
possible.** With `.bob/rules/` empty, Bob writes the vulnerable pattern. Install
the guardrails, ask again, and Bob refuses. If the rules were only ever in one
place there would be no way to show the difference on video.

It also means guardrails are reviewable in a pull request like any other code,
which is the honest answer to "who checks the AI".

## File format

Markdown with YAML frontmatter. Bob reads the prose; the harness reads the
frontmatter.

```markdown
---
id: race-condition-shared-resource
bug_class: race-condition
source_incidents: [INC-001]
confidence: 0.86
created_at: 2026-08-29T10:18:30Z
scope: ["src/**/*.js", "services/**/*.js"]
detection: "await[^;]+find[^;]+;[\\s\\S]{0,400}?if[\\s\\S]{0,400}?await[^;]+(save|update|insert)"
status: active
---

## Rule

One or two sentences. Imperative. States what is forbidden and what is
required instead. This is the part Bob obeys, so it must be unambiguous and
must not reference any specific file.

## When this applies

The conditions under which the rule is in force. Being explicit here is what
keeps the rule from firing on unrelated code.

## Why

Two or three sentences of history: what happened, what it cost. This is not
decoration. A rule with a reason attached survives contact with a developer in
a hurry; a bare prohibition gets worked around.

## Instead of this

```js
// the vulnerable pattern, minimal, generic, not copied from the incident
```

## Do this

```js
// the safe equivalent
```

## Escape hatch

When the rule may legitimately be broken, and what is required to do so.
```

### Frontmatter fields

| Field | Meaning |
|---|---|
| `id` | Filename without extension. Kebab-case, describes the class not the incident. |
| `bug_class` | Must match a class `id` in the taxonomy. |
| `source_incidents` | Array. A rule can be reinforced by later incidents; append rather than duplicate. |
| `confidence` | 0 to 1. Below the taxonomy threshold the rule is not installed. |
| `scope` | Globs the rule applies to. Narrow scope means fewer false positives. |
| `detection` | Regex used by the backtest harness. Explained below. |
| `status` | `active`, `needs_review`, or `retired`. |

### On the code examples

Both blocks must be **generic**, not lifted from the incident. If the "instead
of this" block is the actual buggy function from `booking.js`, Bob will learn
to avoid that function rather than the pattern. Strip it to the smallest form
that still shows the shape.

## Why every section is required

The four prose sections are not filler. Each one closes a specific failure mode
of AI-generated rules:

**Rule** without **When this applies** produces a rule that fires everywhere and
gets disabled within a day.

**Rule** without **Why** produces a rule that a developer under deadline
pressure will override without thinking, because it looks arbitrary.

**Rule** without the **code examples** produces a rule that Bob interprets
loosely, because natural language is ambiguous about code and examples are not.

**Rule** without an **escape hatch** produces a rule that is wrong some of the
time and has no legitimate way to be wrong, so people work around it silently —
which is worse than not having it.

## The escape hatch

Every rule has cases where it should not apply. Pretending otherwise is how
static analysis tools get muted wholesale.

The convention is an inline marker with a reason:

```js
// scar-tissue-allow: race-condition-shared-resource - single-writer migration script
```

The reason is mandatory. The harness can then count suppressions, and a rule
that is suppressed constantly is a rule that needs rewriting — which is a signal
worth having.

## The detection expression

This field is what turns the whole project from a claim into a measurement.

Regex, not AST. AST analysis is the correct engineering choice and the wrong
hackathon choice; a regex over source is a heuristic that is good enough to
produce a defensible number in the time available. This limitation belongs in
the writeup rather than hidden, stating it costs nothing and buys credibility.

The expression must satisfy two conditions before the rule is installed:

1. **It matches the original code** at the incident's location. If it does not
   match the code that actually caused the outage, the rule does not describe
   the bug and confidence collapses.
2. **It does not match the patched code.** If it fires on the fix, the rule is
   describing the wrong thing entirely.

Both checks run automatically when the guardrail is generated. Together they
are the guard against a plausible-sounding rule that means nothing - which is
the single most likely way this system produces garbage.

Additionally, the expression is run across the whole repository. A rule that
matches hundreds of existing sites is over-broad and gets its confidence
reduced, because installing it would bury the developer in warnings.

## How the backtest uses it

For each historical incident, the harness:

1. Checks out the code as it was **before** the fix.
2. Runs every installed guardrail's detection expression against it.
3. If any expression matches at the incident's location, the incident is marked
   `prevented: true`.

The proportion of incidents marked prevented is the `prevention_rate` in
`runs/summary.json` - the single headline number of the project.

Two properties make it honest. A guardrail generated from incident N is tested
against incidents that are not N, so the system is not graded on memorising its
own training case. And the whole thing is deterministic: same code, same rules,
same number, every run. No LLM in the measurement loop.

## Lifecycle

```
incident document
        │
        ▼
   classified into a bug class
        │
        ▼
   Immunizer drafts a guardrail
        │
        ▼
   validation: matches pre-fix code?  does not match post-fix code?  not over-broad?
        │
        ├── passes ────► confidence ≥ 0.6 ──► guardrails/  ──►  .bob/rules/   [active]
        │
        └── fails  ────► confidence < 0.6  ──► guardrails/  ──►  (not installed)  [needs_review]
```

A rule can later be reinforced: a second incident of the same class appends its
id to `source_incidents` and raises confidence, rather than creating a duplicate
rule. The number of active guardrails should stay close to the number of bug
classes, not the number of incidents. If it starts tracking the incident count,
generalisation has failed and that is the signal to look at.