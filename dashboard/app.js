/* Scar Tissue dashboard.
 *
 * Reads runs/*.json through the local server and renders it. There is no
 * build step and no per-incident code: every row, timeline and detail pane is
 * derived from whatever files are in runs/ at request time.
 */

'use strict';

const POLL_MS = 5000;
/* AGENT_ORDER and computeTimeline come from timeline.js, loaded before this
 * script. In the browser they are on globalThis; in tests they are imported. */

let lastPayloadHash = null;
let currentRuns = [];
let openIncidentId = null;

/* ------------------------------------------------------------------ utils */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 390 -> "6m 30s"; 41 -> "41s"; 10800 -> "3h 0m" */
function fmtDuration(sec) {
  if (!isNum(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Compact form for the top bar: 52200 -> "14.5 h" */
function fmtHours(sec) {
  if (!isNum(sec)) return '—';
  const h = sec / 3600;
  return h >= 100 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
}

function fmtDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Known statuses get their own styling; anything else degrades visibly. */
function statusClass(status) {
  return ['immunized', 'needs_review', 'failed'].includes(status) ? status : 'unknown';
}

function statusChip(status) {
  const cls = statusClass(status);
  const label = cls === 'unknown' ? String(status ?? 'unknown') : cls.replace('_', ' ');
  return el('span', `chip chip-${cls}`, label);
}

/* --------------------------------------------------------------- timeline */

function renderTimeline(run) {
  const { bars, measured, overlapping, wall, agentTotal, span } = computeTimeline(run);

  const wrap = el('div', 'timeline');

  const head = el('div', 'timeline-head');
  /* Always exactly 5 canonical lanes — bars is always AGENT_ORDER.length long. */
  head.appendChild(el('div', 'timeline-caption', '5 agents'));

  const mode = el('div', `timeline-mode${measured ? '' : ' inferred'}`);
  if (measured) {
    /* overlapping comes from the geometry module: true only when two bars with
     * dur > 0 have genuinely overlapping [offset, offset+dur) intervals. */
    mode.textContent = overlapping
      ? `parallel · ${fmtDuration(agentTotal)} of work in ${fmtDuration(wall)}`
      : `measured · ${fmtDuration(agentTotal)} of work in ${fmtDuration(wall)}`;
    mode.title = 'Bar positions come from per-agent start times in the run JSON.';
  } else {
    mode.textContent = 'sequential (inferred)';
    mode.title =
      'The run JSON has no per-agent start time, so bars are laid end to end. ' +
      'Add start_offset_sec (or started_at) to each agent and real overlap will render here.';
  }
  head.appendChild(mode);
  wrap.appendChild(head);

  const grid = el('div', 'tl-grid');

  /*
   * One row per canonical agent, all sharing one x-axis, so concurrency shows
   * up as bars occupying the same horizontal range on different rows.
   * bars is always exactly 5 entries (AGENT_ORDER), so we always get 5 lanes.
   */
  for (const bar of bars) {
    const nameCell = el('div', 'tl-name', bar.name);
    if (bar.missing) nameCell.title = 'Agent not recorded in this run';
    grid.appendChild(nameCell);

    const track = el('div', 'tl-track');
    const zero = bar.dur <= 0;
    /* bar.name is always one of the five canonical names. */
    const statusCls = bar.status ? `agent-status-${bar.status}` : 'agent-status-ok';
    const missingCls = bar.missing ? ' agent-missing' : '';

    const b = el('div', `tl-bar agent-${bar.name}${zero ? ' zero' : ''} ${statusCls}${missingCls}`);
    b.style.left = `${(bar.offset / span) * 100}%`;
    b.style.width = zero ? '' : `${Math.max((bar.dur / span) * 100, 1.2)}%`;

    const statusLabel = bar.missing ? 'not recorded' : (bar.status ?? 'ok');
    b.title = `${bar.name} · ${statusLabel} · ${zero ? 'no work recorded' : fmtDuration(bar.dur)}` +
      `\nstarts at +${fmtDuration(bar.offset)}` +
      (bar.summary ? `\n\n${bar.summary}` : '');

    /* Only label bars wide enough to hold the text. */
    if (!zero && (bar.dur / span) > 0.13) {
      b.appendChild(el('span', 'tl-bar-label', fmtDuration(bar.dur)));
    }
    track.appendChild(b);
    grid.appendChild(track);
  }

  const axis = el('div', 'tl-axis');
  axis.appendChild(el('span', null, '0s'));
  axis.appendChild(el('span', null, fmtDuration(span / 2)));
  axis.appendChild(el('span', null, fmtDuration(span)));
  grid.appendChild(axis);

  wrap.appendChild(grid);
  return wrap;
}

/* ----------------------------------------------------------- incident list */

function confidenceMeter(conf) {
  const wrap = el('div', 'conf');
  const track = el('div', 'conf-track');
  const fill = el('div', 'conf-fill');
  const pct = isNum(conf) ? Math.max(0, Math.min(1, conf)) : 0;
  fill.style.width = `${pct * 100}%`;
  // 0.6 is the install threshold from AGENTS.md.
  fill.style.background = !isNum(conf)
    ? 'var(--text-faint)'
    : conf >= 0.6 ? 'var(--immunized)' : 'var(--review)';
  track.appendChild(fill);
  wrap.appendChild(track);
  wrap.appendChild(el('span', 'conf-text', isNum(conf) ? conf.toFixed(2) : '—'));
  wrap.title = isNum(conf)
    ? `Confidence ${conf.toFixed(2)} — guardrails install at 0.60 and above`
    : 'No confidence reported';
  return wrap;
}

function renderIncidentRow(run) {
  const cls = statusClass(run.status);
  const row = el('button', `incident status-${cls}`);
  row.type = 'button';
  row.setAttribute('aria-label', `${run.incident_id} — ${run.title ?? ''}`);

  const left = el('div', 'inc-left');
  left.appendChild(el('div', 'inc-id', run.incident_id ?? '—'));
  left.appendChild(statusChip(run.status));
  left.appendChild(confidenceMeter(run.confidence));
  row.appendChild(left);

  const mid = el('div', 'inc-mid');
  mid.appendChild(el('div', 'inc-title', run.title ?? '(untitled)'));

  const tags = el('div', 'inc-tags');
  if (run.bug_class) tags.appendChild(el('span', 'tag', run.bug_class));
  if (run?.backtest?.prevented === true) {
    tags.appendChild(el('span', 'tag tag-prevented', 'backtest: prevented'));
  } else if (run?.backtest?.prevented === false) {
    tags.appendChild(el('span', 'tag', 'backtest: not prevented'));
  }
  if (run?.artifacts?.pr_url) tags.appendChild(el('span', 'tag', 'PR open'));
  tags.appendChild(el('span', 'tag', run._source_file ?? ''));
  mid.appendChild(tags);

  mid.appendChild(renderTimeline(run));
  row.appendChild(mid);

  const right = el('div', 'inc-right');
  right.appendChild(el('div', 'inc-duration', fmtDuration(run?.timeline?.duration_sec)));
  right.appendChild(el('div', 'inc-when', fmtDate(run?.timeline?.started_at)));
  if (isNum(run.manual_baseline_sec) && isNum(run?.timeline?.duration_sec)) {
    const saved = run.manual_baseline_sec - run.timeline.duration_sec;
    if (saved > 0) right.appendChild(el('div', 'inc-when', `${fmtDuration(saved)} saved`));
  }
  row.appendChild(right);

  row.addEventListener('click', () => openDrawer(run.incident_id));
  return row;
}

/* --------------------------------------------------------------- top bar */

function renderTopBar(summary, runs) {
  const s = summary ?? {};

  const rate = isNum(s.prevention_rate) ? `${Math.round(s.prevention_rate * 100)}%` : '—';
  document.getElementById('hero-value').textContent = rate;

  const counted = [
    isNum(s.incidents_immunized) ? `${s.incidents_immunized} immunized` : null,
    isNum(s.incidents_needs_review) ? `${s.incidents_needs_review} needs review` : null,
    isNum(s.incidents_failed) ? `${s.incidents_failed} failed` : null,
  ].filter(Boolean).join(' · ');
  document.getElementById('hero-sub').textContent = counted;

  document.getElementById('stat-guardrails').textContent =
    isNum(s.guardrails_active) ? s.guardrails_active : '—';
  document.getElementById('stat-guardrails-sub').textContent =
    Array.isArray(s.bug_classes_covered) && s.bug_classes_covered.length
      ? s.bug_classes_covered.join(', ')
      : '';

  // Deliberately the count of run files, not summary.incidents_total — this is
  // the number that changes when you drop a file into runs/.
  document.getElementById('stat-processed').textContent = runs.length;
  document.getElementById('stat-processed-sub').textContent =
    isNum(s.incidents_total) ? `of ${s.incidents_total} in corpus` : '';

  document.getElementById('stat-saved').textContent = fmtHours(s.time_saved_sec);
  document.getElementById('stat-saved-sub').textContent =
    isNum(s.avg_pipeline_sec) && isNum(s.avg_manual_baseline_sec)
      ? `${fmtDuration(s.avg_pipeline_sec)} vs ${fmtDuration(s.avg_manual_baseline_sec)} by hand`
      : '';

  document.getElementById('footer-generated').textContent =
    s.generated_at ? `summary.json generated ${fmtDate(s.generated_at)}` : 'no summary.json found';
}

/* ---------------------------------------------------------------- alerts */

/**
 * The top bar is read straight from summary.json, but the incident list is
 * read from the run files. If the two disagree the dashboard says so rather
 * than quietly showing contradictory numbers on the same screen.
 */
function renderAlerts(summary, runs, errors) {
  const box = document.getElementById('alerts');
  box.replaceChildren();

  for (const e of errors ?? []) {
    const a = el('div', 'alert alert-error');
    a.appendChild(el('strong', null, `${e.file}: `));
    a.appendChild(document.createTextNode(`could not be parsed — ${e.message}`));
    box.appendChild(a);
  }

  if (!summary) return;

  const actual = { immunized: 0, needs_review: 0, failed: 0 };
  for (const r of runs) {
    const c = statusClass(r.status);
    if (c in actual) actual[c] += 1;
  }

  const mismatches = [];
  const pairs = [
    ['incidents_immunized', 'immunized'],
    ['incidents_needs_review', 'needs_review'],
    ['incidents_failed', 'failed'],
  ];
  for (const [key, k] of pairs) {
    if (isNum(summary[key]) && summary[key] !== actual[k]) {
      mismatches.push(`${key} says ${summary[key]}, run files show ${actual[k]}`);
    }
  }

  if (mismatches.length) {
    const a = el('div', 'alert alert-warn');
    a.appendChild(el('strong', null, 'summary.json disagrees with runs/: '));
    a.appendChild(document.createTextNode(`${mismatches.join('; ')}. The top bar shows summary.json.`));
    box.appendChild(a);
  }
}

/* ----------------------------------------------------------- detail view */

/** Distinguish "a path to an artifact" from "the artifact inlined". */
function looksLikePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length < 300
    && !value.includes('\n')
    && /^[\w][\w./@-]*\.[A-Za-z0-9]+$/.test(value);
}

function renderDiff(text) {
  const pre = el('pre', 'code');
  for (const line of text.split('\n')) {
    let cls = null;
    if (/^\+\+\+|^---/.test(line)) cls = 'd-meta';
    else if (line.startsWith('@@')) cls = 'd-hunk';
    else if (line.startsWith('+')) cls = 'd-add';
    else if (line.startsWith('-')) cls = 'd-del';
    else if (/^(diff |index |new file|deleted file)/.test(line)) cls = 'd-meta';
    pre.appendChild(el('span', cls, `${line}\n`));
  }
  return pre;
}

function emptyNote(parts) {
  const box = el('div', 'empty');
  for (const p of parts) {
    if (typeof p === 'string') box.appendChild(document.createTextNode(p));
    else box.appendChild(p);
  }
  return box;
}

/**
 * Render one artifact section. `value` is either the artifact text itself,
 * a repo-relative path to fetch, or null.
 */
async function artifactSection(title, value, opts = {}) {
  const section = el('section', 'section');
  const head = el('div', 'section-head');
  head.appendChild(el('div', 'section-title', title));
  const pathLabel = el('div', 'section-path');
  head.appendChild(pathLabel);
  section.appendChild(head);

  if (value === null || value === undefined || value === '') {
    section.appendChild(emptyNote([opts.nullNote ?? 'Not produced for this run.']));
    return section;
  }

  if (!looksLikePath(value)) {
    // Inlined content.
    section.appendChild(opts.diff ? renderDiff(value) : (() => {
      const pre = el('pre', 'code', value);
      return pre;
    })());
    pathLabel.textContent = 'inlined in run JSON';
    return section;
  }

  pathLabel.textContent = value;
  let res;
  try {
    res = await (await fetch(`/api/file?path=${encodeURIComponent(value)}`)).json();
  } catch {
    section.appendChild(emptyNote(['Could not reach the server to read this file.']));
    return section;
  }

  if (res.exists) {
    section.appendChild(opts.diff ? renderDiff(res.content) : el('pre', 'code', res.content));
  } else {
    const code = el('code', null, value);
    section.appendChild(emptyNote([
      res.reason === 'too_large'
        ? 'File is too large to display: '
        : 'The run JSON points at this file, but it is not on disk: ',
      code,
    ]));
  }
  return section;
}

function agentBreakdown(run) {
  const section = el('section', 'section');
  const head = el('div', 'section-head');
  head.appendChild(el('div', 'section-title', 'Subagents'));
  section.appendChild(head);

  const grid = el('div', 'agent-detail');
  for (const a of run.agents ?? []) {
    const name = el('div', 'ad-name');
    const dot = el('span', `ad-dot ad-${a.status ?? 'ok'}`);
    name.appendChild(dot);
    name.appendChild(document.createTextNode(String(a.name ?? '?')));
    grid.appendChild(name);
    grid.appendChild(el('div', 'ad-dur', fmtDuration(a.duration_sec)));
    grid.appendChild(el('div', 'ad-sum', a.summary ?? ''));
  }
  section.appendChild(grid);
  return section;
}

function metaSection(run) {
  const section = el('section', 'section');
  const head = el('div', 'section-head');
  head.appendChild(el('div', 'section-title', 'Run'));
  section.appendChild(head);

  const dl = el('dl', 'kv');
  const add = (k, v) => {
    if (v === null || v === undefined || v === '') return;
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, v));
  };
  add('source file', run._source_file);
  add('incident doc', run.source_doc);
  add('bug class', run.bug_class);
  add('confidence', isNum(run.confidence) ? run.confidence.toFixed(2) : null);
  add('started', run?.timeline?.started_at);
  add('finished', run?.timeline?.finished_at);
  add('pipeline time', fmtDuration(run?.timeline?.duration_sec));
  add('manual baseline', fmtDuration(run.manual_baseline_sec));
  add('backtest prevented', String(run?.backtest?.prevented));
  add('backtest evidence', run?.backtest?.evidence);
  add('pull request', run?.artifacts?.pr_url ?? 'none yet');
  section.appendChild(dl);
  return section;
}

async function openDrawer(incidentId) {
  const run = currentRuns.find((r) => r.incident_id === incidentId);
  if (!run) return;
  openIncidentId = incidentId;

  document.getElementById('drawer-id').textContent =
    `${run.incident_id} · ${run._source_file ?? ''}`;
  document.getElementById('drawer-title').textContent = run.title ?? '(untitled)';

  const meta = document.getElementById('drawer-meta');
  meta.replaceChildren(statusChip(run.status));
  if (run.bug_class) meta.appendChild(el('span', 'tag', run.bug_class));
  meta.appendChild(el('span', 'tag', fmtDuration(run?.timeline?.duration_sec)));

  const body = document.getElementById('drawer-body');
  body.replaceChildren(el('div', 'empty', 'Loading artifacts…'));

  document.getElementById('drawer').hidden = false;
  document.getElementById('drawer-scrim').hidden = false;

  const a = run.artifacts ?? {};
  const sections = await Promise.all([
    artifactSection('Failing test', a.failing_test, {
      nullNote: 'No failing test recorded for this run.',
    }),
    artifactSection('Patch', a.patch_diff, {
      diff: true,
      nullNote: 'No patch recorded for this run.',
    }),
    artifactSection('Generated guardrail', a.guardrail, {
      nullNote: run.status === 'needs_review'
        ? 'No guardrail installed. Confidence is below the 0.60 threshold, so the pipeline ' +
          'flagged this for a human instead of installing a rule — this is the intended path, not a failure.'
        : 'No guardrail produced for this run.',
    }),
  ]);

  // Guard against a second row being clicked while these were loading.
  if (openIncidentId !== incidentId) return;

  body.replaceChildren();
  sections.forEach((s) => body.appendChild(s));
  body.appendChild(agentBreakdown(run));
  body.appendChild(metaSection(run));
}

function closeDrawer() {
  openIncidentId = null;
  document.getElementById('drawer').hidden = true;
  document.getElementById('drawer-scrim').hidden = true;
}

/* ------------------------------------------------------------------ load */

function renderAll(payload) {
  const runs = (payload.runs ?? []).slice().sort((x, y) =>
    String(x.incident_id ?? '').localeCompare(String(y.incident_id ?? '')));
  currentRuns = runs;

  renderTopBar(payload.summary, runs);
  renderAlerts(payload.summary, runs, payload.errors);

  const list = document.getElementById('incident-list');
  list.replaceChildren();
  if (!runs.length) {
    list.appendChild(emptyNote(['No run files in ', el('code', null, 'runs/'), ' yet.']));
    return;
  }
  for (const run of runs) list.appendChild(renderIncidentRow(run));

  // Keep an open detail pane in sync if its file changed underneath us.
  if (openIncidentId) {
    if (currentRuns.some((r) => r.incident_id === openIncidentId)) openDrawer(openIncidentId);
    else closeDrawer();
  }
}

async function load() {
  let payload;
  try {
    payload = await (await fetch('/api/runs')).json();
  } catch (err) {
    document.getElementById('alerts').replaceChildren(
      el('div', 'alert alert-error',
        'Cannot reach the dashboard server. Start it with: node dashboard/server.js'));
    return;
  }

  // Re-render only on change, so polling does not fight with scrolling.
  const hash = JSON.stringify(payload);
  if (hash === lastPayloadHash) return;
  lastPayloadHash = hash;
  renderAll(payload);
}

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-scrim').addEventListener('click', closeDrawer);
document.getElementById('refresh').addEventListener('click', () => { lastPayloadHash = null; load(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

load();
setInterval(load, POLL_MS);
