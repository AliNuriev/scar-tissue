# Incident Dataset

Twelve incident reports written as input for the pipeline. Each one is a
postmortem of the kind a team would actually file: a narrative, a timeline, an
impact statement, a root cause, and action items.

## Provenance

**These documents are synthetic.** They were written by the team for this
hackathon and describe a fictional airline booking platform. They contain no
personal information, no customer data, no proprietary information, and no
material from any employer. Any resemblance to a real outage is a resemblance
to the general shape of software failure, which is the point.

## Design

The reports deliberately do **not** name their bug class. Classification is the
pipeline's job, and a dataset that labels itself would make the demo
meaningless.

What they do contain is the prose a human would write: "we could not reproduce
this locally", "fixed by a restart", "fine in staging", "worked before the
deploy". Those phrases are the `prose_signals` in
`engine/taxonomy/bug-taxonomy.json`, and they are how a document gets
classified.

The root cause sections describe the flawed code in plain English without
quoting it, which is what real postmortems do and what makes the Locator agent
necessary.

## Intended distribution

| Incident | Expected class |
|---|---|
| INC-001 | race-condition |
| INC-002 | unbounded-resource |
| INC-003 | unvalidated-input |
| INC-004 | boundary-error |
| INC-005 | resource-leak |
| INC-006 | race-condition |
| INC-007 | unvalidated-input |
| INC-008 | boundary-error |
| INC-009 | unbounded-resource |
| INC-010 | resource-leak |
| INC-011 | error-swallowing *(stretch)* |
| INC-012 | contract-violation *(stretch)* |

This table is the expected outcome, not an input. It is kept here so the
classification results can be scored, and it must not be given to the agents.

Two classes appear twice on purpose. INC-006 is the same class as INC-001 in a
different part of the codebase four months later, which is the entire thesis of
the project stated as a dataset: the postmortem for the first one existed and
was thorough, and it prevented nothing. The pipeline should reinforce the
existing guardrail rather than emit a second one.

The last two incidents belong to classes flagged as harder to detect. They are
expected to produce lower confidence and may land in `needs_review`. That is
the intended result, not a shortfall.