# AGENTS.md — Working context for any agent in this repository

## What this project does

This project is an automated post-incident pipeline for a Node/Express codebase. It takes synthetic
incident postmortems, classifies each one into a bug class, locates the responsible code, writes a
failing test, patches the code, and produces a generalized guardrail file. The pipeline measures
itself: `runs/summary.json` reports what fraction of historical incidents a set of installed
guardrails would have prevented, with no LLM in the measurement loop.

## Repository layout

| Path | What lives there | Owner |
|---|---|---|
| `incidents/` | Twelve synthetic postmortem documents (INC-001 … INC-012); read-only inputs | dataset |
| `engine/agents/` | Prompt files for the five pipeline agents (one `.md` per agent) | pipeline |
| `engine/taxonomy/` | `bug-taxonomy.json` (the class list) and `guardrail-schema.md` (the file format) | pipeline |
| `engine/orchestrator/` | Orchestration harness that sequences the five agents | pipeline |
| `engine/backtest/` | Backtest harness that scores guardrail coverage against historical incidents | pipeline |
| `sandbox/` | Clone of the target codebase (`galaxium-travels`) that agents read and patch | pipeline |
| `guardrails/` | Canonical guardrail files; committed, reviewed, source of truth | pipeline |
| `.bob/rules/` | Installed guardrails that Bob actually reads at request time | runtime |
| `runs/` | Pipeline output: one `<incident-id>.json` per run, plus `summary.json` | output |
| `dashboard/` | Visualisation of `runs/summary.json`; reads output, writes nothing | dashboard |
| `docs/` | Supporting documentation | docs |

## Data contract

The pipeline writes **one JSON file per incident** to `runs/<incident-id>.json` and regenerates
`runs/summary.json` after every run. These two file shapes are the only interface between the engine
and the dashboard; nothing else is shared.

**`runs/<incident-id>.json` shape:**
```json
{
  "incident_id": "INC-001",
  "status": "immunized | needs_review | failed",
  "bug_class": "<taxonomy id>",
  "confidence": 0.86,
  "timeline": { "started_at": "…", "finished_at": "…", "duration_sec": 390 },
  "agents": [ { "name": "…", "status": "ok | error", "duration_sec": 0, "summary": "…" } ],
  "artifacts": { "failing_test": "…", "patch_diff": "…", "guardrail": "…", "pr_url": null },
  "backtest": { "prevented": true, "evidence": "…" },
  "manual_baseline_sec": 10800
}
```

**`runs/summary.json` shape:**
```json
{
  "generated_at": "…",
  "incidents_total": 12,
  "incidents_immunized": 9,
  "incidents_needs_review": 2,
  "incidents_failed": 1,
  "prevention_rate": 0.75,
  "guardrails_active": 9,
  "bug_classes_covered": ["race-condition", "…"],
  "time_saved_sec": 41400,
  "avg_pipeline_sec": 312,
  "avg_manual_baseline_sec": 7800
}
```

## Pipeline stages (in order)

1. **Locator** (`engine/agents/locator.md`) — reads the postmortem prose, identifies the one file
   and function most likely responsible for the failure.
2. **Historian** (`engine/agents/historian.md`) — classifies the incident into exactly one bug
   class from `engine/taxonomy/bug-taxonomy.json` using `prose_signals` matching; sets confidence.
3. **Reproducer** (`engine/agents/reproducer.md`) — writes a single failing test targeting the
   located function and the bug class's `test_strategy`.
4. **Fixer** (`engine/agents/fixer.md`) — produces the minimal unified diff that makes the failing
   test pass, touching only the located file.
5. **Immunizer** (`engine/agents/immunizer.md`) — drafts a guardrail file in the format defined by
   `engine/taxonomy/guardrail-schema.md`, generalizing the lesson to a class, not an instance.

## Hard rules

- **A guardrail describes a class of mistake, never an instance.** A rule that names a file, line,
  function, or entity from the incident is invalid and will be rejected.
- **Confidence below 0.6 means the guardrail is not installed.** Set `status: needs_review` and
  do not copy the file to `.bob/rules/`.
- **`guardrails/` is canonical; `.bob/rules/` is the installation target.** Install a guardrail by
  copying it across. Uninstall by deleting from `.bob/rules/` only — never delete from `guardrails/`.
- **Never commit secrets.** `.env.example` shows the required keys; `.env` is gitignored.
- **All content is in English.** Prompts, guardrail prose, test comments, commit messages.

## How to add a new bug class

Append an object to the `classes` array in `engine/taxonomy/bug-taxonomy.json`. No code changes
are required. The new class is available to the Historian on the next pipeline run. Follow the
existing schema: `id` (kebab-case), `name`, `definition`, `tier`, `prose_signals`, `code_pattern`,
`guardrail_strategy`, `detection_hint`, `test_strategy`, `generalizes_well`, `notes`.
