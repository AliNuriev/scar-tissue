/**
 * engine/orchestrator/validation.js
 *
 * Parse and validate the strict output contracts for each pipeline agent.
 *
 * Every agent emits a plain-text response following the format defined in
 * engine/agents/<name>.md. This module extracts structured fields, rejects
 * malformed responses, and returns typed result objects consumed by the pipeline.
 *
 * A parse failure throws a ValidationError, which the pipeline catches and
 * records as a `failed` run, preserving the error message in agent.summary.
 *
 * ## Path safety rules
 *
 * - Locator `file` must be a relative path inside sandbox/.
 * - Reproducer `failing_test` must be a relative path inside sandbox/.
 * - Immunizer `guardrail` path must be inside guardrails/.
 * - Absolute paths and path traversal are rejected in all cases.
 *
 * ## Taxonomy validation
 *
 * - Historian `bug_class` must match a known id in bug-taxonomy.json.
 * - `already_covered` must be exactly the string "true" or "false".
 */

'use strict';

const path = require('node:path');
const fs   = require('node:fs');

// ── Repo root (needed for path safety checks) ─────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Taxonomy class IDs (loaded lazily and cached) ─────────────────────────────

let _taxonomyIds = null;

/**
 * Return the set of valid bug-class IDs from bug-taxonomy.json.
 * Loads once and caches; safe to call repeatedly.
 *
 * @returns {Set<string>}
 */
function getTaxonomyIds() {
  if (_taxonomyIds) return _taxonomyIds;
  const taxonomyPath = path.join(REPO_ROOT, 'engine', 'taxonomy', 'bug-taxonomy.json');
  try {
    const data = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
    _taxonomyIds = new Set((data.classes ?? []).map(c => c.id));
  } catch {
    // If the file can't be read, return an empty set (validation will fail
    // gracefully rather than crashing the orchestrator).
    _taxonomyIds = new Set();
  }
  return _taxonomyIds;
}

// Exported for tests that need to override the cached value.
function _resetTaxonomyCache() { _taxonomyIds = null; }

// ── Helpers ───────────────────────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(agent, message) {
    super(`[${agent}] ${message}`);
    this.agent = agent;
    this.name  = 'ValidationError';
  }
}

/**
 * Extract a labelled scalar value from an agent response line.
 * e.g. "file: sandbox/services/booking.js" → "sandbox/services/booking.js"
 */
function extractField(text, fieldName, agentName) {
  const re    = new RegExp(`^${fieldName}:\\s*(.+)`, 'm');
  const match = text.match(re);
  if (!match || !match[1].trim()) {
    throw new ValidationError(agentName, `Missing required field "${fieldName}"`);
  }
  return match[1].trim();
}

/**
 * Assert that `rawPath` is a safe repository-relative path inside `allowedSubdir`.
 *
 * Rejects:
 *   - absolute paths (start with / or a Windows drive letter)
 *   - paths that resolve outside the repo root
 *   - paths that resolve outside the required subdirectory
 *
 * @param {string} rawPath       The path string from the agent output.
 * @param {string} agentName     For error messages.
 * @param {string} allowedSubdir Repo-relative prefix the path must stay inside (e.g. 'sandbox').
 */
function assertSafePath(rawPath, agentName, allowedSubdir) {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new ValidationError(agentName, `Empty or non-string path`);
  }
  // Reject absolute paths (Unix-style / or Windows C:\ / C:/)
  if (path.isAbsolute(rawPath)) {
    throw new ValidationError(agentName, `Absolute path rejected: "${rawPath}"`);
  }
  // Resolve relative to repo root and check bounds
  const resolved    = path.resolve(REPO_ROOT, rawPath);
  const allowedBase = path.join(REPO_ROOT, allowedSubdir);
  if (!resolved.startsWith(allowedBase + path.sep) && resolved !== allowedBase) {
    throw new ValidationError(
      agentName,
      `Path "${rawPath}" must be inside ${allowedSubdir}/ (resolved to "${resolved}")`
    );
  }
}

// ── Incident discovery & ID validation ───────────────────────────────────────

const INCIDENT_ID_RE = /^INC-\d{3,}$/;

/**
 * Discover all incident IDs from the incidents/ directory.
 * Returns an array of IDs sorted alphabetically (INC-001, INC-002, …).
 *
 * @param {string} incidentsDir  Absolute path to the incidents/ directory.
 * @returns {string[]}
 */
function discoverIncidentIds(incidentsDir) {
  const entries = fs.readdirSync(incidentsDir);
  return entries
    .filter(e => e.endsWith('.md') && INCIDENT_ID_RE.test(e.replace(/\.md$/, '')))
    .map(e => e.replace(/\.md$/, ''))
    .sort();
}

/**
 * Validate an incident ID supplied via the CLI.
 * Rejects non-matching IDs and path-traversal attempts.
 *
 * @param {string}   id           The raw user-supplied ID.
 * @param {string[]} knownIds     List of discovered IDs.
 * @param {string}   incidentsDir Absolute path to incidents/.
 * @returns {string}  The validated ID.
 */
function validateIncidentId(id, knownIds, incidentsDir) {
  if (typeof id !== 'string' || !INCIDENT_ID_RE.test(id)) {
    throw new Error(`Invalid incident ID format: "${id}". Expected e.g. INC-001`);
  }
  // Guard against path traversal in the ID itself.
  const candidatePath = path.resolve(incidentsDir, `${id}.md`);
  if (!candidatePath.startsWith(incidentsDir + path.sep)) {
    throw new Error(`Path traversal attempt in incident ID: "${id}"`);
  }
  if (!knownIds.includes(id)) {
    throw new Error(`Unknown incident ID: "${id}". Available: ${knownIds.join(', ')}`);
  }
  return id;
}

// ── Agent output parsers ──────────────────────────────────────────────────────

/**
 * Parse Locator output.
 *
 * Expected format (engine/agents/locator.md):
 *   file: <relative path>
 *   function: <function or method name>
 *   justification: <2–4 sentences>
 *
 * Validates: file must be a repo-relative path inside sandbox/.
 *
 * @param {string} text
 * @returns {{ file: string, function: string, justification: string }}
 */
function parseLocator(text) {
  const file          = extractField(text, 'file',          'locator');
  const fn            = extractField(text, 'function',      'locator');
  const justification = extractField(text, 'justification', 'locator');
  // Path safety: must be inside sandbox/
  assertSafePath(file, 'locator', 'sandbox');
  return { file, function: fn, justification };
}

/**
 * Parse Historian output.
 *
 * Expected format (engine/agents/historian.md):
 *   bug_class: <id>
 *   confidence: <0.00–1.00>
 *   already_covered: <true|false>
 *   coverage_note: <sentence | "none">
 *
 * Validates:
 *   - bug_class must exist in engine/taxonomy/bug-taxonomy.json
 *   - already_covered must be exactly "true" or "false"
 *   - confidence must be a finite number in [0, 1]
 *
 * @param {string} text
 * @returns {{ bug_class: string, confidence: number, already_covered: boolean, coverage_note: string }}
 */
function parseHistorian(text) {
  const bug_class      = extractField(text, 'bug_class',      'historian');
  const confidenceRaw  = extractField(text, 'confidence',     'historian');
  const alreadyRaw     = extractField(text, 'already_covered','historian');
  const coverage_note  = extractField(text, 'coverage_note',  'historian');

  // Validate bug_class against taxonomy
  const knownIds = getTaxonomyIds();
  if (knownIds.size > 0 && !knownIds.has(bug_class)) {
    throw new ValidationError('historian',
      `bug_class "${bug_class}" is not a known taxonomy id. ` +
      `Known ids: ${[...knownIds].sort().join(', ')}`);
  }

  // Validate confidence
  const confidence = parseFloat(confidenceRaw);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ValidationError('historian', `confidence "${confidenceRaw}" is not a number in [0,1]`);
  }

  // Validate already_covered — must be exactly "true" or "false"
  const normalised = alreadyRaw.trim().toLowerCase();
  if (normalised !== 'true' && normalised !== 'false') {
    throw new ValidationError('historian',
      `already_covered must be exactly "true" or "false", got "${alreadyRaw}"`);
  }
  const already_covered = normalised === 'true';

  return { bug_class, confidence, already_covered, coverage_note };
}

/**
 * Parse Reproducer output.
 *
 * Expected format: a fenced code block with the filename as the language tag.
 *   ```path/to/test-file.test.js
 *   // test code
 *   ```
 *
 * Validates: failing_test path must be inside sandbox/.
 *
 * @param {string} text
 * @returns {{ failing_test: string, code: string }}
 */
function parseReproducer(text) {
  // Match ```<path>\n<code>\n```
  const match = text.match(/```([^\n`]+\.(?:test\.js|spec\.js|test\.ts))\n([\s\S]*?)```/);
  if (!match) {
    throw new ValidationError('reproducer',
      'Could not find fenced code block with a test file path as the language tag');
  }
  const failing_test = match[1].trim();
  const code         = match[2];
  if (!code.trim()) {
    throw new ValidationError('reproducer', 'Test code block is empty');
  }
  // Path safety: must be inside sandbox/
  assertSafePath(failing_test, 'reproducer', 'sandbox');
  return { failing_test, code };
}

/**
 * Parse Fixer output.
 *
 * Expected format: a unified diff inside a fenced diff block.
 *   ```diff
 *   --- a/<file>
 *   +++ b/<file>
 *   @@ ... @@
 *   ```
 *
 * @param {string} text
 * @returns {{ patch_diff: string }}
 */
function parseFixer(text) {
  // Allow bare diff blocks with or without the ```diff fence.
  const fenced = text.match(/```diff\n([\s\S]*?)```/);
  if (fenced) {
    const diff = fenced[1].trim();
    if (!diff) throw new ValidationError('fixer', 'Diff block is empty');
    return { patch_diff: diff };
  }
  // Fallback: look for --- a/ line anywhere in the text.
  const raw = text.match(/(---\s+a\/[\s\S]+)/);
  if (raw) {
    return { patch_diff: raw[1].trim() };
  }
  throw new ValidationError('fixer', 'Could not find a unified diff in the output');
}

/**
 * Parse Immunizer output.
 *
 * Expected format: a fenced Markdown file with YAML frontmatter
 * following engine/taxonomy/guardrail-schema.md.
 *
 * Validates:
 *   - All required sections present.
 *   - Frontmatter has id, bug_class, confidence.
 *   - Guardrail path (if present) must be inside guardrails/.
 *   - Guardrail confidence must be consistent with the status field.
 *
 * @param {string} text
 * @returns {{ guardrail: string|null, guardrailContent: string }}
 */
function parseImmunizer(text) {
  // Find a fenced block with a .md path label.
  // Use a greedy match so inner code fences don't close the outer block prematurely.
  const fenced = text.match(/```([^\n`]+\.md)\n([\s\S]*)```/);
  if (fenced) {
    const guardrailPath = fenced[1].trim();
    const content       = fenced[2];
    // Path safety: must be inside guardrails/
    assertSafePath(guardrailPath, 'immunizer', 'guardrails');
    _validateGuardrailContent(content);
    return { guardrail: guardrailPath, guardrailContent: content };
  }
  // Fallback: the agent returned raw markdown starting with ---
  const raw = text.match(/(---[\s\S]+)/);
  if (raw) {
    const content = raw[1];
    _validateGuardrailContent(content);
    return { guardrail: null, guardrailContent: content };
  }
  throw new ValidationError('immunizer', 'Could not find guardrail markdown in the output');
}

/**
 * Validate required sections and frontmatter of a guardrail markdown.
 * Also validates that status and confidence are internally consistent.
 */
function _validateGuardrailContent(content) {
  const required = [
    '## Rule',
    '## When this applies',
    '## Why',
    '## Instead of this',
    '## Do this',
    '## Escape hatch',
  ];
  for (const section of required) {
    if (!content.includes(section)) {
      throw new ValidationError('immunizer', `Guardrail is missing required section: "${section}"`);
    }
  }
  // Required frontmatter fields
  if (!content.includes('id:') || !content.includes('bug_class:') || !content.includes('confidence:')) {
    throw new ValidationError('immunizer', 'Guardrail frontmatter is missing id, bug_class, or confidence');
  }
  // Parse and cross-validate confidence vs status in frontmatter
  const confMatch   = content.match(/^confidence:\s*([\d.]+)/m);
  const statusMatch = content.match(/^status:\s*(\S+)/m);
  if (confMatch && statusMatch) {
    const conf   = parseFloat(confMatch[1]);
    const status = statusMatch[1].trim();
    if (Number.isFinite(conf)) {
      // confidence < 0.6 must have status needs_review or similar, not active
      if (conf < 0.6 && status === 'active') {
        throw new ValidationError('immunizer',
          `Guardrail confidence ${conf} < 0.6 but status is "active". ` +
          `Low-confidence guardrails must have status "needs_review".`);
      }
    }
  }
}

/**
 * Dispatch to the correct parser by agent name.
 *
 * @param {string} agentName
 * @param {string} output
 * @returns {object}  Parsed result object.
 */
function parseAgentOutput(agentName, output) {
  switch (agentName) {
    case 'locator':    return parseLocator(output);
    case 'historian':  return parseHistorian(output);
    case 'reproducer': return parseReproducer(output);
    case 'fixer':      return parseFixer(output);
    case 'immunizer':  return parseImmunizer(output);
    default:
      throw new ValidationError(agentName, `Unknown agent name: ${agentName}`);
  }
}

module.exports = {
  ValidationError,
  discoverIncidentIds,
  validateIncidentId,
  parseAgentOutput,
  parseLocator,
  parseHistorian,
  parseReproducer,
  parseFixer,
  parseImmunizer,
  assertSafePath,
  getTaxonomyIds,
  _resetTaxonomyCache,
  INCIDENT_ID_RE,
  REPO_ROOT,
};
