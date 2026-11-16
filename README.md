# actions-yaml-doctor

**Beginner-focused checker for GitHub Actions workflow YAML — catch the typo that breaks your CI, in plain English, before you push.**

```bash
npx actions-yaml-doctor check .github/workflows
# ERROR [unknown-key] .github/workflows/ci.yml:5 Unknown key 'branch' in 'on.push'.
#   Did you mean 'branches'?
# ERROR [invalid-runner] .github/workflows/ci.yml:12 'windows-95' is not a known GitHub-hosted runner label.
#   Did you mean 'windows-2022'? Common labels: ubuntu-latest, windows-latest, macos-latest.
# actions-doctor: 2 error(s), 0 warning(s) in 1 file(s).
```

## Why this exists

A one-letter typo in a workflow file — `branch:` instead of `branches:`, `run-on:` instead of `runs-on:` — fails silently or with an error message that does not point at the typo. `actions-yaml-doctor` reads your `.github/workflows/*.yml` files and tells you, in plain English, what is wrong, where it is, and what you probably meant. It runs fully offline: no network, no GitHub API, no token.

Honest note: this problem is not new, and this tool is not the best at it. [`actionlint`](https://github.com/rhysd/actionlint) is excellent — it is faster, deeper, and battle-tested on thousands of repositories. If you want the strongest possible workflow linting, use actionlint. `actions-yaml-doctor` is a companion for beginners: smaller, slower, and deliberately wordier, with "did you mean" suggestions, safe `--fix` for unambiguous typos, and `--json` / GitHub Actions annotation output for CI. If you already use actionlint, you probably do not need this too.

## Features

- **YAML syntax errors** with line and column, from the real parser — not a regex guess.
- **Schema checks** — unknown or typo'd keys at every level (workflow, `on`, job, step) with "did you mean" suggestions, missing `on` / `jobs` / `runs-on` / `steps`, a step with neither `uses` nor `run`, and invalid runner labels (`windows-95` is not a thing).
- **Expression checks** — unclosed `${{ … }}`, empty `${{ }}`, and unknown contexts like `${{ foo.bar }}`.
- **Secrets typo check** — `secrets.DEPLOY_TOKN` against the names you declare (`--secrets DEPLOY_TOKEN,API_KEY`, or the secrets your own `workflow_call` declares). `secrets.GITHUB_TOKEN` is always allowed. With no known-secret list it stays silent instead of guessing — a checker that cries wolf is worse than none.
- **Reusable workflows** — calls to a local reusable workflow are checked against the callee's `workflow_call` inputs: missing required inputs, unknown inputs, wrong types (`boolean` / `number` / `choice`). Remote `owner/repo` reusable workflows cannot be checked offline and are skipped, not guessed at.
- **`--fix`** — only for safe, unambiguous fixes, e.g. `branch:` → `branches:` and `run-on:` → `runs-on:`. Everything else is a suggestion you apply yourself.
- **CI output** — `--json`, and `--format annotations` which prints `::error file=…,line=…::…` lines GitHub shows inline on a pull request.
- **Zero runtime dependencies** beyond the `yaml` parser. Node.js 18+, TypeScript.

## Install

```bash
npm install -g actions-yaml-doctor
# or, per project:
npm install --save-dev actions-yaml-doctor
```

Requires Node.js 18 or later.

## Usage

```bash
actions-doctor check                                   # .github/workflows
actions-doctor check .github/workflows/ci.yml          # one file
actions-doctor check --fix                             # fix safe typos only
actions-doctor check --secrets DEPLOY_TOKEN,API_KEY    # enable secret typo checks
actions-doctor check --json                            # machine-readable output
actions-doctor check --format annotations              # GitHub Actions annotations
actions-doctor check --strict                          # warnings also fail the build
```

Exit code is `0` when there are no errors and `1` otherwise (`--strict` also fails on warnings).

## CI

```yaml
- run: npx actions-yaml-doctor check .github/workflows --strict
```

See [`.github/workflows/ci.yml`](.github/workflows/ci.yml) for the workflow used by this repo — it tests Node 18, 20 and 22, builds the CLI, and then runs the CLI on its own workflows (a self-check: this repo's workflows must pass its own checker).

## Examples

The [`test/fixtures/`](test/fixtures/) directory has files you can try immediately:

```bash
# Passes (exit 0)
node dist/cli.js check test/fixtures/good.yml

# Fails (exit 1) — syntax error with line number
node dist/cli.js check test/fixtures/broken-syntax.yml

# Fails (exit 1) — branch/run-on typos, invalid runner, missing steps
node dist/cli.js check test/fixtures/broken-keys.yml
node dist/cli.js check test/fixtures/broken-keys.yml --fix   # fixes branch + run-on only

# Fails (exit 1) — unclosed / empty / unknown-context expressions
node dist/cli.js check test/fixtures/broken-expressions.yml

# Fails (exit 1) — secret typos, with the known list supplied
node dist/cli.js check test/fixtures/broken-secrets.yml --secrets DEPLOY_TOKEN,API_KEY

# Fails (exit 1) — reusable workflow: missing required input, wrong type, bad choice
node dist/cli.js check test/fixtures/broken-reusable.yml
```

## What it does not do

- It does not run your workflows, call the GitHub API, or check whether an action version (`actions/checkout@v4`) exists — it is fully offline by design.
- It does not check shell scripts inside `run:` steps.
- It does not auto-fix anything ambiguous. If a fix could change what your workflow does, it stays a suggestion.

## Development

```bash
npm install
npm test        # Vitest
npm run build   # tsc -> dist/
npm run check   # self-check: this repo's own workflows must pass
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Gaurav Kumar Yadav ([FlyingDarkDev](https://flyingdarkdev.com)).
