import type { Finding, ParsedWorkflow } from '../parse.js';

/**
 * Latest known major version per action — an offline snapshot (Nov 2026).
 * No network call is ever made, so this list can go stale; when it does,
 * `action-outdated` simply stops flagging that action until the list is
 * updated in this file. It never claims an action exists or that a SHA
 * matches a release — only the major-version comparison is checked.
 */
export const KNOWN_ACTION_MAJORS: Record<string, number> = {
  'actions/checkout': 4,
  'actions/setup-node': 4,
  'actions/setup-python': 5,
  'actions/setup-go': 5,
  'actions/setup-java': 4,
  'actions/cache': 4,
  'actions/upload-artifact': 4,
  'actions/download-artifact': 4,
  'actions/github-script': 7,
  'actions/labeler': 5,
  'actions/stale': 9,
  'actions/dependency-review-action': 4,
  'docker/build-push-action': 6,
  'docker/setup-buildx-action': 3,
  'docker/setup-qemu-action': 3,
  'docker/login-action': 3,
  'docker/metadata-action': 5,
  'softprops/action-gh-release': 2,
  'codecov/codecov-action': 5,
  'peter-evans/create-pull-request': 7,
};

/**
 * File-wide suppression for the unpinned rule only, e.g. at the top of a
 * workflow that intentionally tracks a major-version tag:
 * `# actions-doctor: ignore action-unpinned`
 * Outdated-major findings are NOT suppressed by this marker.
 */
export const IGNORE_UNPINNED_MARKER = 'actions-doctor: ignore action-unpinned';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SHORT_SHA_RE = /^[0-9a-f]{7,39}$/;
const VERSION_TAG_RE = /^v(\d+)(?:\.\d+)?(?:\.\d+)?$/;

/** True for a `uses:` value that refers to a GitHub Action (not a local
 * reusable workflow, not a Docker action, not a workflow file). */
function isActionUse(uses: string): boolean {
  if (!uses) return false;
  if (uses.startsWith('./') || uses.startsWith('../')) return false;
  if (uses.startsWith('docker://')) return false;
  if (uses.includes('.github/workflows/')) return false; // reusable workflow
  if (uses.endsWith('.yml') || uses.endsWith('.yaml')) return false;
  return true;
}

export function checkActions(parsed: ParsedWorkflow): Finding[] {
  const findings: Finding[] = [];
  const ignoreUnpinned = parsed.text.includes(IGNORE_UNPINNED_MARKER);

  for (const scalar of parsed.scalars) {
    if (!scalar.path.endsWith('.uses')) continue;
    const uses = scalar.value;
    if (!isActionUse(uses)) continue;

    const at = uses.lastIndexOf('@');
    const repo = at >= 0 ? uses.slice(0, at) : uses;
    const ref = at >= 0 ? uses.slice(at + 1) : '';
    // `owner/repo/path` — the known list is keyed by `owner/repo`.
    const actionKey = repo.split('/').slice(0, 2).join('/');
    const latestMajor = KNOWN_ACTION_MAJORS[actionKey];

    const line = scalar.line;
    const column = scalar.column;

    if (at < 0) {
      if (!ignoreUnpinned) {
        findings.push({
          file: parsed.file, line, column, rule: 'action-unpinned', severity: 'warning',
          message: `Action '${uses}' has no version pinned — it will always run the latest code on the default branch.`,
          suggestion: `Pin it to a version, e.g. '${uses}@v4', or better to a full commit SHA.`,
        });
      }
      continue;
    }

    if (FULL_SHA_RE.test(ref)) {
      // Pinned by full SHA — the recommended form. No version to compare.
      continue;
    }

    if (SHORT_SHA_RE.test(ref)) {
      if (!ignoreUnpinned) {
        findings.push({
          file: parsed.file, line, column, rule: 'action-unpinned', severity: 'warning',
          message: `Action '${uses}' is pinned to a short SHA '${ref}' — short SHAs can be ambiguous.`,
          suggestion: 'Use the full 40-character commit SHA instead.',
        });
      }
      continue;
    }

    // Any other ref (v4, v4.2.1, main, a branch name) is mutable: tags and
    // branches can be moved after you pin them.
    if (!ignoreUnpinned) {
      findings.push({
        file: parsed.file, line, column, rule: 'action-unpinned', severity: 'warning',
        message: `Action '${uses}' is pinned to the mutable ref '@${ref}' — tags and branches can move after you pin them.`,
        suggestion: 'Pin it by full 40-character commit SHA instead (see the action’s releases page for the SHA of the version you want).',
      });
    }

    // Outdated major: only when the ref is a version tag we can parse.
    const versionMatch = VERSION_TAG_RE.exec(ref);
    if (versionMatch && latestMajor !== undefined) {
      const major = Number(versionMatch[1]);
      if (major < latestMajor) {
        findings.push({
          file: parsed.file, line, column, rule: 'action-outdated', severity: 'warning',
          message: `Action '${actionKey}@v${major}' is outdated — the latest known major version is v${latestMajor}.`,
          suggestion: `Upgrade to '${actionKey}@v${latestMajor}' (and pin that version by SHA if you can).`,
        });
      }
    }
  }
  return findings;
}
