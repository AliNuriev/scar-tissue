# dashboard/

Reads `runs/*.json` and renders the Immunity Ledger. No build step, no framework, no
dependencies — plain HTML, CSS and JavaScript served by a ~150-line Node script.

## Run it

```bash
node dashboard/server.js
# → http://localhost:4173
```

`PORT=5000 node dashboard/server.js` to change the port.

Nothing to install. The only requirement is Node 18+, which the repo already needs.

## Dropping in a new run

`runs/` is read on **every request**, and the page re-polls every 5 seconds. Drop a new
`<incident-id>.json` into `runs/` and it appears within five seconds — no restart, no rebuild, no
code change. That is the acceptance criterion for this component, and it is the reason the
dashboard is served rather than opened as a file: a page on `file://` cannot list a directory.

`summary.json` is picked out by name and drives the top bar. Every other `.json` in the directory
becomes a row.

A half-written file (the pipeline mid-flush) does not blank the screen: it is reported as a banner
and the other runs keep rendering.

## What is on screen

**Top bar** — from `summary.json`. Prevention rate as the hero number, then guardrails active,
incidents processed, engineer time saved.

"Incidents processed" is the count of run files, not `summary.incidents_total`, because that is the
number that visibly changes when you drop a file in. `incidents_total` is shown beneath it as
"of N in corpus".

**Incident list** — one row per run file. The three statuses are separated by hue *and* by glyph,
so they stay distinguishable in a compressed video and for colour-blind viewers:

| Status | Colour | Glyph | Reading |
|---|---|---|---|
| `immunized` | green | ✓ | Guardrail generated and installed |
| `needs_review` | amber, dashed border | ◆ | Low confidence — the system is asking for a human |
| `failed` | red | ✕ | The pipeline could not resolve the incident |
| anything else | grey | ? | Unrecognised status, rendered rather than dropped |

`needs_review` is deliberately amber-and-dashed, not a second shade of red. It is the
human-in-the-loop path working as designed, and the detail view says so in words as well.

**Agent timeline** — see below.

**Detail view** — click any row. Shows the failing test, the patch, and the generated guardrail,
then a per-subagent breakdown and the raw run metadata. Escape or the scrim closes it.

Artifacts may be given either as inline text or as a repo-relative path; the dashboard handles
both. When the run JSON points at a file that is not on disk it says exactly that, naming the
path, rather than rendering an empty box.

## The agent timeline

One row per subagent, all sharing a single horizontal time axis, so concurrency shows up as bars
occupying the same horizontal range on different rows.

**The run JSON does not currently say when each agent started.** `agents[]` carries `duration_sec`
and nothing else, and durations alone cannot tell you what ran in parallel. So the timeline works
in two modes:

- **`measured`** — the agent has `start_offset_sec` (seconds from run start) or `started_at` (ISO
  timestamp). Bars are positioned truthfully and real overlap renders. The badge also reports
  agent-seconds against wall-clock, e.g. *"parallel · 5m 54s of work in 3m 20s"* — which is the
  number that proves parallelism.
- **`sequential (inferred)`** — neither field is present. Bars are laid end to end and the badge
  says `sequential (inferred)` in amber.

The fallback exists so the dashboard renders today. It is labelled because drawing invented
overlap in front of judges is worse than drawing none. **Adding `start_offset_sec` to each agent in
the orchestrator output is all that is needed** — no dashboard change.

To see the measured mode:

```bash
cp dashboard/fixtures/example-parallel.json runs/
```

## Fixtures

`fixtures/` holds example run files for states the real data does not cover yet. They are not read
by the dashboard; copy one into `runs/` to exercise a code path, then delete it.

| File | Exercises |
|---|---|
| `example-failed.json` | The `failed` status, and agents with `status: "error"` |
| `example-parallel.json` | `start_offset_sec`, measured mode, genuinely overlapping bars |

```bash
cp dashboard/fixtures/example-failed.json runs/     # appears within 5s
rm runs/example-failed.json                          # disappears within 5s
```

## Layout

| File | Role |
|---|---|
| `server.js` | Static server + `/api/runs` and `/api/file`. Zero dependencies. |
| `index.html` | Structure only |
| `styles.css` | All styling; single dark theme, fixed so status colours read the same on any projector |
| `app.js` | Fetch, render, timeline geometry, detail view |
| `fixtures/` | Example run files (see above) |

## Tests

```bash
node --test dashboard/timeline.test.js
```

Runs dependency-free `node:test` regression tests against the timeline geometry
module (`dashboard/timeline.js`). Requires Node 18+. Covers:

- `dashboard/fixtures/example-parallel.json` → measured mode with overlapping bars
- `runs/INC-001.json` → five visible lanes in inferred sequential mode
- Zero-duration agents remain as visible markers
- ISO `started_at` timestamp positioning
- Offsets and span are finite and non-negative for all inputs

### API

| Endpoint | Returns |
|---|---|
| `GET /api/runs` | `{ summary, runs[], errors[] }` — the directory, read fresh |
| `GET /api/file?path=<repo-relative>` | `{ path, exists, content }` for artifact pointers |

`/api/file` resolves against the repository root and rejects anything that escapes it. It is a
local dev server: do not expose it to a network.

## Self-checking

The top bar comes from `summary.json` while the list comes from the run files. If the two disagree
the dashboard shows an amber banner naming the discrepancy instead of quietly displaying
contradictory numbers on the same screen.

With the current fixtures this banner is visible: `summary.json` reports
`incidents_needs_review: 0`, but `INC-002.json` has `status: "needs_review"`.
