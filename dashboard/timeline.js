/**
 * timeline.js — pure timeline geometry for the Scar Tissue dashboard.
 *
 * Works in both environments:
 *   - Browser: loaded as a plain <script> before app.js; exports nothing,
 *     attaches computeTimeline to globalThis so app.js can call it.
 *   - Node tests: require('./timeline.js') and use the returned object.
 *
 * No DOM, no fetch, no side-effects beyond the global assignment in the
 * browser path. Safe to require in node:test without any shim.
 */

'use strict';

/* The five canonical agents in pipeline order. Every timeline always shows
 * exactly these five lanes — agents absent from the run JSON are rendered as
 * zero-duration markers so the lane structure is never missing. */
const AGENT_ORDER = ['locator', 'historian', 'reproducer', 'fixer', 'immunizer'];

/**
 * computeTimeline(run) -> TimelineResult
 *
 * @param {object} run  A run JSON object (or any object with .agents / .timeline).
 * @returns {{
 *   bars: Array<{name,status,summary,dur,offset,missing}>,
 *   measured: boolean,
 *   overlapping: boolean,
 *   wall: number,
 *   agentTotal: number,
 *   span: number
 * }}
 *
 * bars  — one entry per canonical agent, always exactly 5.  Each bar has:
 *   name    — agent name string
 *   status  — 'ok' | 'error' | 'partial' (or undefined when agent missing)
 *   summary — summary string or null
 *   dur     — duration in seconds (0 when absent or zero)
 *   offset  — left edge in seconds from run start (always >= 0)
 *   missing — true when the agent was not present in run.agents at all
 *
 * measured    — true only when every *recorded* agent has a valid, finite,
 *               non-negative start_offset_sec or a valid started_at relative to
 *               the run start. If timing is absent or invalid for any recorded
 *               agent the whole timeline falls back to sequential inferred.
 *
 * overlapping — true only in measured mode and only when at least two bars
 *               whose dur > 0 have genuinely overlapping [offset, offset+dur)
 *               intervals. Never true in inferred mode.
 *
 * wall        — run wall-clock duration in seconds (0 if absent or negative).
 * agentTotal  — sum of all agent durations.
 * span        — the total horizontal axis width in seconds (max of wall and
 *               maxEnd, minimum 1).
 */
function computeTimeline(run) {
  const rawAgents = Array.isArray(run && run.agents) ? run.agents : [];
  const runStart = Date.parse((run && run.timeline && run.timeline.started_at) || '');

  /* Index the raw agents by name for O(1) lookup.  If there are multiple
   * entries with the same name (shouldn't happen but be safe), the first wins. */
  const byName = Object.create(null);
  for (const a of rawAgents) {
    const n = String(a.name ?? '?');
    if (!(n in byName)) byName[n] = a;
  }

  /* Collect the recorded agents (i.e. the canonical agents that are present in
   * the run JSON).  Missing agents do not count toward timing decisions. */
  const recordedNames = AGENT_ORDER.filter(name => name in byName);

  /**
   * Resolve a finite, non-negative start offset for agent `a`, or return null
   * if the agent carries no valid timing information.
   *
   * Rules:
   *   - start_offset_sec: must be a finite number >= 0.
   *   - started_at: must parse to a finite timestamp; offset = (t - runStart)/1000
   *     must be finite and >= 0.
   *   - Negative offsets are rejected (invalid timing) and return null.
   */
  function resolveOffset(a) {
    if (typeof a.start_offset_sec === 'number' && Number.isFinite(a.start_offset_sec)) {
      return a.start_offset_sec >= 0 ? a.start_offset_sec : null;
    }
    if (a.started_at && Number.isFinite(runStart)) {
      const t = Date.parse(a.started_at);
      if (Number.isFinite(t)) {
        const off = (t - runStart) / 1000;
        return off >= 0 ? off : null;
      }
    }
    return null;
  }

  /* Measured mode requires EVERY recorded agent to have a valid, non-negative
   * start time.  A single agent with missing or invalid timing disqualifies the
   * whole timeline; we fall back to sequential inferred for the full set. */
  let measured = recordedNames.length > 0;
  for (const name of recordedNames) {
    if (resolveOffset(byName[name]) === null) {
      measured = false;
      break;
    }
  }

  /* Build bars. */
  let cursor = 0; // used only in inferred (sequential) mode
  const bars = AGENT_ORDER.map((name) => {
    const a = byName[name];
    const missing = !a;
    const dur = (a && typeof a.duration_sec === 'number' && Number.isFinite(a.duration_sec))
      ? Math.max(0, a.duration_sec)
      : 0;

    let offset;
    if (measured) {
      /* In measured mode every recorded agent has a valid offset (checked
       * above).  Missing agents (not in the run JSON) have no timing at all;
       * place them at 0 — they render as zero-dur markers and do not affect
       * overlap detection. */
      offset = missing ? 0 : resolveOffset(a);
    } else {
      /* Inferred sequential: each agent starts when the previous one ends. */
      offset = cursor;
      cursor += dur;
    }

    return {
      name,
      status: a ? (a.status ?? 'ok') : undefined,
      summary: a ? (a.summary ?? null) : null,
      dur,
      offset,
      missing,
    };
  });

  /* Wall-clock: clamp negative or non-finite values to 0. */
  const rawWall = run && run.timeline && run.timeline.duration_sec;
  const wall = (typeof rawWall === 'number' && Number.isFinite(rawWall) && rawWall >= 0)
    ? rawWall
    : 0;

  const maxEnd = bars.reduce((m, b) => Math.max(m, b.offset + b.dur), 0);
  const agentTotal = bars.reduce((s, b) => s + b.dur, 0);

  /* Detect genuine overlap: compare every pair of bars that both have dur > 0.
   * Two intervals [a, a+da) and [b, b+db) overlap iff a < b+db AND b < a+da.
   * Only meaningful in measured mode; always false in inferred mode. */
  let overlapping = false;
  if (measured) {
    const activeBars = bars.filter(b => b.dur > 0);
    outer: for (let i = 0; i < activeBars.length; i++) {
      for (let j = i + 1; j < activeBars.length; j++) {
        const a = activeBars[i];
        const b = activeBars[j];
        if (a.offset < b.offset + b.dur && b.offset < a.offset + a.dur) {
          overlapping = true;
          break outer;
        }
      }
    }
  }

  return {
    bars,
    measured,
    overlapping,
    wall,
    agentTotal,
    span: Math.max(wall, maxEnd, 1),
  };
}

/* ------------------------------------------------------------------ export */

/* Browser: attach to globalThis so app.js can call computeTimeline() directly.
 * Node: module.exports allows require('./timeline.js').computeTimeline. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeTimeline, AGENT_ORDER };
} else {
  /* eslint-disable-next-line no-undef */
  globalThis.computeTimeline = computeTimeline;
  /* eslint-disable-next-line no-undef */
  globalThis.AGENT_ORDER = AGENT_ORDER;
}
