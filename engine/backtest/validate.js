#!/usr/bin/env node
/**
 * engine/backtest/validate.js
 *
 * Validation command: checks a guardrail file before installing it.
 *
 * Three checks:
 *   1. The detection regex matches the BEFORE file (pre-fix code).
 *   2. The detection regex does NOT match the AFTER file (post-fix code).
 *   3. The regex matches fewer than MAX_MATCHES places across the whole repo
 *      (over-broad check).  Configurable via --max-matches N (default 10).
 *
 * Usage:
 *   node engine/backtest/validate.js \
 *       --guardrail guardrails/race-condition-shared-resource.md \
 *       --before engine/backtest/fixtures/services/booking.before.js \
 *       --after  engine/backtest/fixtures/services/booking.after.js \
 *       [--repo  <path>]           (defaults to repo root)
 *       [--max-matches N]          (default 10)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MAX_MATCHES = 10;

// ── frontmatter parser (same logic as index.js) ──────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const raw    = match[1];
  const result = {};

  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val   = line.slice(idx + 1).trim();

    if (val.startsWith('[') && val.endsWith(']')) {
      result[key] = val
        .slice(1, -1)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      continue;
    }

    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\\\/g, '\\');
    } else if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }

    result[key] = val;
  }

  return result;
}

// ── source collection (same logic as index.js) ───────────────────────────────

function collectSourceFiles(dir) {
  const files = [];
  const SOURCE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (SOURCE_EXTS.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Count all non-overlapping matches of `regex` across an array of file contents.
 * Returns { count, examples } where examples is up to 3 { file, snippet } objects.
 */
function countMatches(regex, files) {
  let count = 0;
  const examples = [];

  for (const { filePath, content } of files) {
    // Reset lastIndex for global regex if reused
    const localRe = new RegExp(regex.source, regex.flags.replace('g', '') + 'g');
    let m;
    while ((m = localRe.exec(content)) !== null) {
      count++;
      if (examples.length < 3) {
        examples.push({ file: filePath, snippet: m[0].slice(0, 80).replace(/\n/g, '↵') });
      }
    }
  }

  return { count, examples };
}

// ── validation logic ──────────────────────────────────────────────────────────

function validate({ guardrailPath, beforePath, afterPath, repoPath, maxMatches }) {
  // Load guardrail
  if (!fs.existsSync(guardrailPath)) {
    console.error(`[error] Guardrail file not found: ${guardrailPath}`);
    process.exit(1);
  }
  const guardrailContent = fs.readFileSync(guardrailPath, 'utf8');
  const fm = parseFrontmatter(guardrailContent);
  if (!fm || !fm.detection) {
    console.error('[error] Could not parse frontmatter or missing "detection" field.');
    process.exit(1);
  }

  const { id, detection } = fm;
  let regex;
  try {
    regex = new RegExp(detection, 's');
  } catch (e) {
    console.error(`[error] "detection" is not a valid regex: ${e.message}`);
    process.exit(1);
  }

  console.log(`\nValidating guardrail: ${id}`);
  console.log(`Regex: ${detection}\n`);

  let passed = true;

  // ── Check 1: regex matches the BEFORE file ────────────────────────────────
  if (!fs.existsSync(beforePath)) {
    console.error(`[error] --before file not found: ${beforePath}`);
    process.exit(1);
  }
  const beforeCode = fs.readFileSync(beforePath, 'utf8');
  const check1     = regex.test(beforeCode);

  if (check1) {
    console.log('  ✓  Check 1 PASSED — regex matches pre-fix code');
  } else {
    console.log('  ✗  Check 1 FAILED — regex does NOT match pre-fix code');
    console.log('     This guardrail does not describe the bug it claims to prevent.');
    passed = false;
  }

  // ── Check 2: regex does NOT match the AFTER file ──────────────────────────
  if (!fs.existsSync(afterPath)) {
    console.error(`[error] --after file not found: ${afterPath}`);
    process.exit(1);
  }
  const afterCode = fs.readFileSync(afterPath, 'utf8');
  const check2    = !regex.test(afterCode);

  if (check2) {
    console.log('  ✓  Check 2 PASSED — regex does not match post-fix code');
  } else {
    console.log('  ✗  Check 2 FAILED — regex STILL matches post-fix code');
    console.log('     The detection expression does not distinguish before from after.');
    passed = false;
  }

  // ── Check 3: not over-broad across the repo ───────────────────────────────
  let repoFiles = [];
  if (fs.existsSync(repoPath)) {
    repoFiles = collectSourceFiles(repoPath).map(filePath => ({
      filePath,
      content: (() => { try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; } })(),
    }));
  } else {
    console.log(`  -  Check 3 SKIPPED — repo path not found: ${repoPath}`);
    console.log(`     (run with --repo <path> to enable the over-broad check)\n`);
    printResult(passed);
    return;
  }

  const { count, examples } = countMatches(new RegExp(detection, 'gs'), repoFiles);
  const check3 = count <= maxMatches;

  if (check3) {
    console.log(`  ✓  Check 3 PASSED — ${count} match(es) across repo (threshold: ${maxMatches})`);
  } else {
    console.log(`  ✗  Check 3 FAILED — ${count} matches across repo (threshold: ${maxMatches})`);
    console.log('     This regex is too broad; it will flag many unrelated sites.');
    if (examples.length > 0) {
      console.log('     Sample matches:');
      for (const ex of examples) {
        console.log(`       ${ex.file}: ${ex.snippet}`);
      }
    }
    passed = false;
  }

  console.log('');
  printResult(passed);
}

function printResult(passed) {
  if (passed) {
    console.log('Result: VALID — guardrail is ready to install.\n');
    process.exit(0);
  } else {
    console.log('Result: INVALID — do not install this guardrail.\n');
    process.exit(1);
  }
}

// ── CLI parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const guardrailArg  = getArg('--guardrail');
const beforeArg     = getArg('--before');
const afterArg      = getArg('--after');
const repoArg       = getArg('--repo');
const maxMatchesArg = getArg('--max-matches');

if (!guardrailArg || !beforeArg || !afterArg) {
  console.error([
    'Usage:',
    '  node engine/backtest/validate.js \\',
    '      --guardrail <guardrail.md> \\',
    '      --before    <pre-fix-file.js> \\',
    '      --after     <post-fix-file.js> \\',
    '      [--repo     <repo-root>]',
    '      [--max-matches N]',
  ].join('\n'));
  process.exit(1);
}

validate({
  guardrailPath: path.resolve(guardrailArg),
  beforePath:    path.resolve(beforeArg),
  afterPath:     path.resolve(afterArg),
  repoPath:      repoArg ? path.resolve(repoArg) : REPO_ROOT,
  maxMatches:    maxMatchesArg ? parseInt(maxMatchesArg, 10) : DEFAULT_MAX_MATCHES,
});
