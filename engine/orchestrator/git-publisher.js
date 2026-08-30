/**
 * engine/orchestrator/git-publisher.js
 *
 * Git publisher for the scar-tissue pipeline.
 *
 * Responsibilities:
 *  - Check for a dirty worktree before touching anything.
 *  - Create an isolated, deterministically-named branch per incident.
 *  - Stage and commit only that incident's generated artefacts.
 *  - Push the branch.
 *  - Open one pull request via the GitHub CLI (`gh`) and return its URL.
 *
 * ## Safety rules (hard)
 *  - Publishing is ALWAYS opt-in; this module must never be called from dry-run
 *    code paths.
 *  - The worktree must be clean before we touch it. If it is dirty, we throw
 *    immediately rather than accidentally overwriting uncommitted work.
 *  - No destructive Git commands (reset --hard, checkout --) are used.
 *  - Secrets must never be logged; branch names and commit messages are the
 *    only things written to stdout.
 *
 * ## Branch naming (deterministic and safe for Git refs)
 *
 *   scar-tissue/<incidentId-lower>-<yyyymmdd>
 *   e.g.  scar-tissue/inc-001-20260829
 *
 * ## Injectable adapters (for testing)
 *
 * The module exports `createGitPublisher(opts)` which accepts injected
 * `gitRunner` and `prRunner` functions. Tests supply fake adapters; production
 * code uses the real shell-backed ones.
 *
 * @module git-publisher
 */

'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a safe, deterministic branch name for an incident.
 *
 * @param {string} incidentId  e.g. "INC-001"
 * @param {Date}   [date]      Optional date (defaults to now).
 * @returns {string}           e.g. "scar-tissue/inc-001-20260829"
 */
function buildBranchName(incidentId, date = new Date()) {
  const safe = incidentId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const ymd  = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `scar-tissue/${safe}-${ymd}`;
}

// ── Real shell runners ────────────────────────────────────────────────────────

/**
 * Create a git runner that calls the real `git` binary.
 *
 * @param {string} cwd  Working directory (repo root).
 * @returns {Function}  async (args: string[]) => stdout: string
 */
function createRealGitRunner(cwd) {
  return async function realGitRunner(args) {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  };
}

/**
 * Create a PR runner that calls the real `gh` CLI.
 * Requires `gh` to be authenticated.
 *
 * @param {string} cwd  Working directory (repo root).
 * @returns {Function}  async (args: string[]) => stdout: string
 */
function createRealPrRunner(cwd) {
  return async function realPrRunner(args) {
    const { stdout } = await execFileAsync('gh', args, { cwd });
    return stdout.trim();
  };
}

// ── Publisher factory ─────────────────────────────────────────────────────────

/**
 * Create a GitPublisher with injected runners.
 *
 * @param {object} opts
 * @param {Function} opts.gitRunner  async (args) => stdout
 * @param {Function} opts.prRunner   async (args) => stdout
 * @param {string}   opts.repoRoot   Absolute repo root path.
 * @returns {object}  { publish, buildBranchName }
 */
function createGitPublisher({ gitRunner, prRunner, repoRoot }) {

  /**
   * Check the worktree is clean. Throws if any tracked file is modified,
   * staged, or if there are untracked files that would conflict.
   */
  async function assertCleanWorktree() {
    const status = await gitRunner(['status', '--porcelain']);
    if (status.trim()) {
      throw new Error(
        'Refusing to publish from a dirty worktree.\n' +
        'Commit or stash your changes first.\n' +
        'Dirty files:\n' +
        status.split('\n').map(l => '  ' + l).join('\n')
      );
    }
  }

  /**
   * Publish one incident's generated artefacts.
   *
   * @param {object} opts
   * @param {string}   opts.incidentId      e.g. "INC-001"
   * @param {string[]} opts.filesToStage    Repo-relative paths to commit.
   * @param {string}   opts.prTitle         Pull-request title.
   * @param {string}   opts.prBody          Pull-request body.
   * @param {string}   [opts.baseBranch]    Target branch (default "main").
   * @param {Date}     [opts.date]          Date used for branch name (default now).
   * @returns {Promise<string>}             The URL of the created pull request.
   */
  async function publish({ incidentId, filesToStage, prTitle, prBody, baseBranch = 'main', date }) {
    // 1. Guard: clean worktree
    await assertCleanWorktree();

    // 2. Determine branch name
    const branchName = buildBranchName(incidentId, date);

    // 3. Create branch from current HEAD (does NOT modify the worktree)
    await gitRunner(['checkout', '-b', branchName]);

    try {
      // 4. Stage only the incident's files
      if (filesToStage.length === 0) {
        throw new Error('No files to stage for publishing');
      }
      await gitRunner(['add', '--', ...filesToStage]);

      // 5. Commit
      const commitMsg =
        `chore(pipeline): ${incidentId} pipeline output\n\n` +
        `Automated commit from the scar-tissue orchestrator.\n` +
        `Incident: ${incidentId}`;
      await gitRunner(['commit', '-m', commitMsg]);

      // 6. Push
      await gitRunner(['push', '--set-upstream', 'origin', branchName]);

      // 7. Create PR
      const prOutput = await prRunner([
        'pr', 'create',
        '--title', prTitle,
        '--body',  prBody,
        '--base',  baseBranch,
        '--head',  branchName,
      ]);

      // `gh pr create` prints the PR URL on the last line
      const prUrl = prOutput.split('\n').filter(Boolean).pop() ?? '';
      return prUrl;

    } catch (err) {
      // Switch back to the original branch on failure. We do NOT force-delete
      // the branch — that would be a destructive operation.
      try {
        await gitRunner(['checkout', baseBranch]);
      } catch {
        // Best effort; do not mask the original error.
      }
      throw err;
    }
  }

  return { publish, assertCleanWorktree, buildBranchName };
}

/**
 * Create a GitPublisher backed by the real shell `git` and `gh` binaries.
 *
 * @param {string} repoRoot  Absolute path to the repository root.
 * @returns {object}
 */
function createRealGitPublisher(repoRoot) {
  return createGitPublisher({
    gitRunner: createRealGitRunner(repoRoot),
    prRunner:  createRealPrRunner(repoRoot),
    repoRoot,
  });
}

module.exports = {
  buildBranchName,
  createGitPublisher,
  createRealGitPublisher,
  createRealGitRunner,
  createRealPrRunner,
};
