#!/usr/bin/env node
/**
 * Scar Tissue dashboard — static file server + a read-only view of runs/.
 *
 * Zero dependencies: node:http, node:fs, node:path only. No build step, no
 * npm install. `node dashboard/server.js` and open the printed URL.
 *
 * The directory is read on every request, so dropping a new JSON into runs/
 * and refreshing the page is enough — no restart, no code change.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(REPO_ROOT, 'runs');
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // The dashboard must never show a stale run list.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * Resolve a repo-relative path from untrusted query input.
 * Returns null if it escapes the repository root.
 */
function safeResolve(relative) {
  if (typeof relative !== 'string' || relative === '') return null;
  if (relative.includes('\0')) return null;
  const resolved = path.resolve(REPO_ROOT, relative);
  const withSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
  if (resolved !== REPO_ROOT && !resolved.startsWith(withSep)) return null;
  return resolved;
}

/**
 * GET /api/runs
 *
 * Reads every *.json in runs/. summary.json is pulled out separately; every
 * other file becomes a run. A malformed file is reported in `errors` rather
 * than taking the whole dashboard down — a half-written file from an
 * in-flight pipeline run should not blank the screen.
 */
async function readRuns() {
  const out = { summary: null, runs: [], errors: [] };

  let entries;
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  } catch (err) {
    out.errors.push({ file: 'runs/', message: `cannot read runs/ — ${err.message}` });
    return out;
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => e.name)
    .sort();

  for (const name of files) {
    const full = path.join(RUNS_DIR, name);
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(full, 'utf8'));
    } catch (err) {
      out.errors.push({ file: `runs/${name}`, message: err.message });
      continue;
    }

    if (name.toLowerCase() === 'summary.json') {
      out.summary = parsed;
    } else {
      // _source_file lets the UI show which file a row came from, which makes
      // "drop a file in and it appears" self-evident on screen.
      out.runs.push({ ...parsed, _source_file: `runs/${name}` });
    }
  }

  return out;
}

/**
 * GET /api/file?path=<repo-relative>
 *
 * The run JSON refers to artifacts by path (failing_test, guardrail, and
 * sometimes patch_diff). The detail view follows those pointers. Missing is a
 * normal outcome, not an error — the pipeline may not have written the file.
 */
async function readArtifact(relative) {
  const resolved = safeResolve(relative);
  if (!resolved) return { path: relative, exists: false, reason: 'rejected' };

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return { path: relative, exists: false, reason: 'not_a_file' };
    if (stat.size > 512 * 1024) {
      return { path: relative, exists: false, reason: 'too_large', size: stat.size };
    }
    return { path: relative, exists: true, content: await fs.readFile(resolved, 'utf8') };
  } catch {
    return { path: relative, exists: false, reason: 'missing' };
  }
}

async function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const resolved = path.resolve(__dirname, name);
  const dirWithSep = __dirname.endsWith(path.sep) ? __dirname : __dirname + path.sep;
  if (!resolved.startsWith(dirWithSep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await fs.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  try {
    if (url.pathname === '/api/runs') {
      sendJson(res, 200, await readRuns());
      return;
    }
    if (url.pathname === '/api/file') {
      sendJson(res, 200, await readArtifact(url.searchParams.get('path')));
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Scar Tissue dashboard → http://localhost:${PORT}`);
  console.log(`  reading ${path.relative(process.cwd(), RUNS_DIR) || RUNS_DIR}/ on every request`);
  console.log('  drop a new <incident>.json in there and refresh — no restart needed\n');
});
