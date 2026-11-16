#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkWorkflow } from './parse.js';
import type { Finding } from './parse.js';

const VERSION = '0.2.0';

interface Options {
  fix: boolean;
  json: boolean;
  format: 'text' | 'annotations';
  strict: boolean;
  secrets: string[];
}

function printHelp(): void {
  console.log(`actions-doctor ${VERSION}
Beginner-focused checker for GitHub Actions workflow YAML (fully offline).

Usage:
  actions-doctor check [path ...] [--fix] [--json] [--format annotations] [--secrets A,B] [--strict]
  actions-doctor [path ...]            same as "check" with no subcommand

  path   a workflow file, a directory of workflows, or nothing (defaults to
         .github/workflows in the current directory)

Options:
  --fix                  apply only safe, unambiguous fixes (e.g. 'branch:'
                         -> 'branches:'). Everything else is a suggestion.
  --json                 print findings as JSON
  --format annotations   print GitHub Actions ::error / ::warning annotations
  --secrets A,B          comma-separated list of secret names that exist,
                         used to catch typos like secrets.DEPLOY_TOKN
  --strict               warnings also fail the build (exit 1)
  --help, -h             show this help
  --version              show the version

Checks (v0.2.0): workflow keys/triggers/runners, expressions, secret
typos, reusable-workflow inputs, action versions (mutable refs and
outdated majors, offline list), strategy.matrix (empty / non-list /
unused keys), and composite action files (action.yml — inputs, outputs,
runs.steps). A file can opt out of the unpinned-action warning only with
a '# actions-doctor: ignore action-unpinned' comment in the file.

Exit code: 0 when there are no errors, 1 otherwise.
Honest note: actionlint (github.com/rhysd/actionlint) already does this
really well — actions-doctor is a plain-English companion for beginners,
not a replacement.`);
}

function escapeAnnotation(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function formatText(findings: Finding[]): string {
  const lines: string[] = [];
  for (const finding of findings) {
    const level = finding.severity === 'error' ? 'ERROR' : 'WARNING';
    const location = finding.column ? `${finding.file}:${finding.line}:${finding.column}` : `${finding.file}:${finding.line}`;
    lines.push(`${level} [${finding.rule}] ${location} ${finding.message}`);
    if (finding.suggestion) lines.push(`  ${finding.suggestion}`);
    if (finding.fix) lines.push(`  Auto-fix available: '${finding.fix.from}' -> '${finding.fix.to}' (use --fix)`);
  }
  return lines.join('\n');
}

function formatAnnotations(findings: Finding[]): string {
  return findings.map((finding) => {
    const level = finding.severity === 'error' ? 'error' : 'warning';
    const message = finding.suggestion ? `${finding.message} ${finding.suggestion}` : finding.message;
    const col = finding.column ? `,col=${finding.column}` : '';
    return `::${level} file=${escapeAnnotation(finding.file)},line=${finding.line}${col}::[${finding.rule}] ${escapeAnnotation(message)}`;
  }).join('\n');
}

function discoverFiles(paths: string[]): string[] {
  const out: string[] = [];
  const roots = paths.length > 0 ? paths : ['.github/workflows'];
  for (const root of roots) {
    const full = resolve(root);
    if (!existsSync(full)) {
      console.error(`actions-doctor: path not found: ${root}`);
      process.exitCode = 2;
      continue;
    }
    if (statSync(full).isFile()) {
      out.push(full);
    } else {
      for (const entry of readdirSync(full).sort()) {
        if (entry.endsWith('.yml') || entry.endsWith('.yaml')) out.push(join(full, entry));
      }
    }
  }
  return out;
}

/** Apply only findings that carry a safe `fix` (key rename on one line). */
export function applyFixes(file: string, findings: Finding[]): number {
  const fixable = findings.filter((f) => f.fix && f.file === file);
  if (fixable.length === 0) return 0;
  const lines = readFileSync(file, 'utf8').split('\n');
  let applied = 0;
  for (const finding of fixable) {
    const index = finding.line - 1;
    if (index < 0 || index >= lines.length) continue;
    const pattern = new RegExp(`^(\\s*)${finding.fix!.from}\\s*:`);
    if (pattern.test(lines[index])) {
      lines[index] = lines[index].replace(pattern, `$1${finding.fix!.to}:`);
      applied++;
    }
  }
  if (applied > 0) writeFileSync(file, lines.join('\n'));
  return applied;
}

function parseArgs(argv: string[]): { paths: string[]; options: Options } {
  const options: Options = { fix: false, json: false, format: 'text', strict: false, secrets: [] };
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fix') options.fix = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'text' && value !== 'annotations') {
        console.error(`actions-doctor: --format must be 'text' or 'annotations', got '${value}'`);
        process.exit(2);
      }
      options.format = value;
    } else if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'text' && value !== 'annotations') {
        console.error(`actions-doctor: --format must be 'text' or 'annotations', got '${value}'`);
        process.exit(2);
      }
      options.format = value;
    } else if (arg === '--secrets') {
      const value = argv[++i] ?? '';
      options.secrets = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--secrets=')) {
      options.secrets = arg.slice('--secrets='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version') {
      console.log(VERSION);
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.error(`actions-doctor: unknown option '${arg}' (try --help)`);
      process.exit(2);
    } else {
      paths.push(arg);
    }
  }
  return { paths, options };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === 'check') argv.shift();
  const { paths, options } = parseArgs(argv);

  const files = discoverFiles(paths);
  if (files.length === 0) {
    console.error('actions-doctor: no workflow files found.');
    process.exitCode = 1;
    return;
  }

  let allFindings: Finding[] = [];
  let fixedTotal = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const findings = checkWorkflow(text, file, { knownSecrets: options.secrets });
    if (options.fix) {
      fixedTotal += applyFixes(file, findings);
      // Re-check after fixing so the report reflects the fixed file.
      const after = checkWorkflow(readFileSync(file, 'utf8'), file, { knownSecrets: options.secrets });
      allFindings.push(...after);
    } else {
      allFindings.push(...findings);
    }
  }
  allFindings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const errors = allFindings.filter((f) => f.severity === 'error').length;
  const warnings = allFindings.filter((f) => f.severity === 'warning').length;

  if (options.json) {
    console.log(JSON.stringify({
      files,
      findings: allFindings,
      fixed: fixedTotal,
      summary: { errors, warnings, filesChecked: files.length },
    }, null, 2));
  } else if (options.format === 'annotations') {
    const out = formatAnnotations(allFindings);
    if (out) console.log(out);
    console.log(`actions-doctor: ${errors} error(s), ${warnings} warning(s) in ${files.length} file(s).`);
  } else {
    if (allFindings.length > 0) console.log(formatText(allFindings));
    if (fixedTotal > 0) console.log(`Fixed ${fixedTotal} safe issue(s) — re-run to confirm.`);
    console.log(`actions-doctor: ${errors} error(s), ${warnings} warning(s) in ${files.length} file(s).`);
  }

  process.exitCode = errors > 0 || (options.strict && warnings > 0) ? 1 : 0;
}

/* Only run as a CLI when this file is the entry point — importing
   applyFixes() from a test must not execute main(). */
const entry = process.argv[1] ?? '';
if (entry.endsWith('/cli.js') || entry.endsWith('/cli.ts') || entry.endsWith('\\cli.js')) {
  main();
}
