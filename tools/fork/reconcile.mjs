#!/usr/bin/env node
// Fork reconciliation tool.
//
// This fork is upstream plus a short series of commits. Upstream moves; the
// fork has to be replayed on top and its assumptions re-checked. This script
// answers, from any upstream ref (branch, tag, release tag or commit):
//
//   * which fork commits are still needed, and which upstream already has
//   * which files upstream changed that a fork patch also touches
//   * which assumptions ("anchors") about upstream no longer hold
//
// Run `node tools/fork/reconcile.mjs status` first. See tools/fork/README.md
// and MAINTAIN_AGENTS.md.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dirname;
const REPO = resolve(HERE, '..', '..');
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'fork-manifest.json'), 'utf8'));

const C = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
};
const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (color, text) => (useColor ? `${color}${text}${C.reset}` : text);
const bold = (text) => paint(C.bold, text);
const dim = (text) => paint(C.dim, text);

function git(args, { allowFail = false, cwd = REPO } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  } catch (error) {
    if (allowFail) return undefined;
    const stderr = error.stderr?.toString().trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
  }
}

function gitLines(args, opts) {
  const out = git(args, opts);
  return out === undefined || out === '' ? [] : out.split('\n');
}

function parseArgs(argv) {
  const options = { command: 'status', upstream: undefined, json: false, fetch: true, dryRun: false, patch: undefined, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--upstream' || arg === '-u') options.upstream = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-fetch') options.fetch = false;
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--patch' || arg === '-p') options.patch = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 0) options.command = positional[0];
  return options;
}

function ensureUpstreamRemote() {
  const { remote, url } = MANIFEST.upstream;
  const existing = git(['remote'], { allowFail: true }) ?? '';
  if (!existing.split('\n').includes(remote)) {
    git(['remote', 'add', remote, url]);
    return { added: true, fetched: false };
  }
  return { added: false, fetched: false };
}

function fetchUpstream() {
  git(['fetch', '--quiet', '--tags', MANIFEST.upstream.remote], { allowFail: true });
}

function resolveRef(ref) {
  const sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (sha === undefined) throw new Error(`Cannot resolve ref: ${ref}`);
  return sha;
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ?? 'HEAD';
}

function forkCommits(base, head) {
  const raw = git(['log', '--reverse', '--format=%H%x00%s', `${base}..${head}`], { allowFail: true }) ?? '';
  if (raw === '') return [];
  return raw.split('\n').map((line) => {
    const [sha, subject] = line.split('\u0000');
    return { sha, subject };
  });
}

function commitFiles(sha) {
  const out = git(['show', '--name-status', '--format=', sha], { allowFail: true }) ?? '';
  const files = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [status, ...rest] = line.split('\t');
    files.push({ status, path: rest.join('\t') });
  }
  return files;
}

function cherryMap(upstreamRef, head) {
  const out = git(['cherry', '-v', upstreamRef, head], { allowFail: true }) ?? '';
  const map = new Map();
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([+-])\s+([0-9a-f]{40})\s+(.*)$/.exec(line);
    if (match === null) continue;
    map.set(match[2], { state: match[1], subject: match[3] });
  }
  return map;
}

function upstreamTouched(base, upstreamRef, files) {
  if (files.length === 0) return [];
  const paths = files.map((f) => f.path);
  const out = git(['log', '--oneline', `${base}..${upstreamRef}`, '--', ...paths], { allowFail: true }) ?? '';
  return out === '' ? [] : out.split('\n');
}

function checkAgainst(ref, check) {
  switch (check.type) {
    case 'file':
      return git(['cat-file', '-e', `${ref}:${check.path}`], { allowFail: true }) !== undefined;
    case 'absent':
      return git(['cat-file', '-e', `${ref}:${check.path}`], { allowFail: true }) === undefined;
    case 'grep':
      return (
        git(['grep', '-q', '-E', '-e', check.pattern, ref, '--', check.path], { allowFail: true }) !== undefined
      );
    default:
      throw new Error(`Unknown anchor check type: ${check.type}`);
  }
}

function evaluateAnchors(upstreamRef, head) {
  return MANIFEST.anchors.map((anchor) => {
    const scope = anchor.scope ?? 'both';
    const results = anchor.checks.map((check) => ({
      check,
      upstream: scope === 'fork' ? null : checkAgainst(upstreamRef, check),
      head: scope === 'upstream' ? null : checkAgainst(head, check),
    }));
    return {
      id: anchor.id,
      scope,
      description: anchor.description,
      results,
      upstreamOk: results.every((r) => r.upstream !== false),
      headOk: results.every((r) => r.head !== false),
    };
  });
}

function classifyPatches(commits, cherries) {
  return commits.map((commit) => {
    const match = MANIFEST.patches.find((p) => commit.subject.includes(p.match));
    const cherry = cherries.get(commit.sha);
    const state = cherry === undefined ? 'unknown' : cherry.state === '-' ? 'obsolete' : 'needed';
    return { ...commit, patch: match ?? null, state, files: commitFiles(commit.sha) };
  });
}

function statusReport(options) {
  const head = resolveRef('HEAD');
  const upstreamRef = options.upstream ?? MANIFEST.upstream.defaultRef;
  const upstreamSha = resolveRef(upstreamRef);
  const base = git(['merge-base', upstreamRef, head]);
  const behind = Number(git(['rev-list', '--count', `${base}..${upstreamRef}`]));
  const commits = forkCommits(base, head);
  const cherries = cherryMap(upstreamRef, head);
  const patches = classifyPatches(commits, cherries);
  const anchors = evaluateAnchors(upstreamRef, head);
  const classified = patches.filter((p) => p.patch !== null);
  const unclassified = patches.filter((p) => p.patch === null);
  const drift = classified.map((p) => ({
    id: p.patch.id,
    title: p.patch.title,
    commits: upstreamTouched(base, upstreamRef, p.files),
  }));
  return {
    repo: REPO,
    branch: currentBranch(),
    head,
    upstream: { ref: upstreamRef, sha: upstreamSha },
    base,
    behind,
    patches,
    unclassified,
    drift,
    anchors,
  };
}

function printStatus(report) {
  console.log(bold(`Fork reconciliation: ${report.branch} vs ${report.upstream.ref}`));
  console.log(`  head      ${report.head.slice(0, 12)}`);
  console.log(`  upstream  ${report.upstream.sha.slice(0, 12)}  (${report.upstream.ref})`);
  console.log(`  base      ${report.base.slice(0, 12)}  (merge-base)`);
  console.log(`  drift     upstream is ${report.behind} commit(s) ahead of the merge-base`);
  console.log('');

  const needed = report.patches.filter((p) => p.state === 'needed');
  const obsolete = report.patches.filter((p) => p.state === 'obsolete');

  console.log(bold('Fork patches'));
  if (report.patches.length === 0) {
    console.log(`  ${paint(C.green, 'none')} — the fork is identical to upstream at this ref`);
  }
  for (const p of report.patches) {
    const label = p.state === 'needed' ? paint(C.green, 'needed  ') : p.state === 'obsolete' ? paint(C.yellow, 'obsolete') : paint(C.red, 'unknown ');
    const title = p.patch === null ? paint(C.red, '(unclassified)') : p.patch.title;
    console.log(`  ${label} ${p.sha.slice(0, 8)}  ${title}`);
    console.log(`           ${dim(p.subject)}`);
    if (p.state === 'obsolete') {
      console.log(`           ${paint(C.yellow, 'upstream already contains an equivalent change — drop this commit on rebase')}`);
    }
    if (p.patch !== null && p.patch.purpose !== undefined) {
      console.log(`           ${dim(p.patch.purpose)}`);
    }
  }
  console.log('');

  console.log(bold('Upstream drift on files a fork patch owns'));
  const drifted = report.drift.filter((d) => d.commits.length > 0);
  if (drifted.length === 0) {
    console.log(`  ${paint(C.green, 'none')} — no upstream commit since the merge-base touches a fork-owned file`);
  }
  for (const d of drifted) {
    console.log(`  ${paint(C.yellow, 'review')} ${d.title} (${d.commits.length} upstream commit(s))`);
    for (const c of d.commits.slice(0, 8)) console.log(`           ${dim(c)}`);
    if (d.commits.length > 8) console.log(`           ${dim(`… and ${d.commits.length - 8} more`)}`);
  }
  console.log('');

  console.log(bold('Anchor checks'));
  for (const a of report.anchors) {
    const upstream =
      a.scope === 'fork'
        ? dim('upstream n/a')
        : a.upstreamOk
          ? paint(C.green, 'upstream ok')
          : paint(C.red, 'upstream DRIFTED');
    const headState =
      a.scope === 'upstream'
        ? dim('fork n/a')
        : a.headOk
          ? paint(C.green, 'fork ok')
          : paint(C.red, 'fork BROKEN');
    console.log(`  ${upstream}  ${headState}  ${a.id}`);
    console.log(`           ${dim(a.description)}`);
    for (const r of a.results) {
      if (r.upstream !== false && r.head !== false) continue;
      const where = `${r.check.type}:${r.check.path}${r.check.pattern === undefined ? '' : `:${r.check.pattern}`}`;
      const side = r.upstream === false ? 'upstream' : 'fork';
      console.log(`           ${paint(C.red, '✗')} ${side} ${where}`);
    }
  }
  console.log('');

  const verdict =
    report.patches.length === 0
      ? paint(C.green, 'IN SYNC — nothing to reapply')
      : needed.length === report.patches.length && drifted.length === 0 && report.anchors.every((a) => a.upstreamOk && a.headOk)
        ? paint(C.green, 'CLEAN — all patches needed, no drift, all anchors hold')
        : paint(C.yellow, 'ATTENTION — see the items above before releasing');
  console.log(bold('Verdict: ') + verdict);
  if (obsolete.length > 0) console.log(`  ${obsolete.length} obsolete patch(es): drop them while rebasing`);
  if (drifted.length > 0) console.log(`  ${drifted.length} patch(es) touch files upstream changed: re-verify those patches`);
  if (!report.anchors.every((a) => a.upstreamOk)) {
    console.log(`  anchor drift: a fork assumption no longer matches upstream — update the patch and the anchor`);
  }
  console.log('');
  console.log(dim('Next: `node tools/fork/reconcile.mjs rebase --upstream <ref>` then re-run status.'));
}

function printDiff(options) {
  const head = resolveRef('HEAD');
  const upstreamRef = options.upstream ?? MANIFEST.upstream.defaultRef;
  const base = git(['merge-base', upstreamRef, head]);
  const commits = forkCommits(base, head);
  const cherries = cherryMap(upstreamRef, head);
  const patches = classifyPatches(commits, cherries);
  const selected =
    options.patch === undefined
      ? patches
      : patches.filter((p) => p.sha.startsWith(options.patch) || p.patch?.id === options.patch);
  if (selected.length === 0) {
    console.log(`No fork patch matches '${options.patch ?? ''}'.`);
    return;
  }
  for (const p of selected) {
    const paths = p.files.map((f) => f.path);
    console.log(bold(`${p.patch?.title ?? p.subject} (${p.sha.slice(0, 8)})`));
    console.log(dim(`  files: ${paths.join(', ') || '(none)'}`));
    const log = git(['log', '--oneline', `${base}..${upstreamRef}`, '--', ...paths], { allowFail: true }) ?? '';
    if (log === '') {
      console.log(`  ${paint(C.green, 'upstream has not touched these files since the merge-base')}`);
    } else {
      console.log(`  ${paint(C.yellow, 'upstream commits touching these files:')}`);
      for (const line of log.split('\n')) console.log(`    ${line}`);
      const stat = git(['diff', '--stat', base, upstreamRef, '--', ...paths], { allowFail: true }) ?? '';
      if (stat !== '') {
        console.log('');
        for (const line of stat.split('\n')) console.log(`    ${line}`);
      }
    }
    console.log('');
  }
}

function printRebasePlan(options, report) {
  const upstreamRef = options.upstream ?? MANIFEST.upstream.defaultRef;
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const backup = `fork-backup/${stamp}`;
  console.log(bold('Rebase plan'));
  console.log(`  1. git branch ${backup}                 # safety net for the current branch`);
  console.log(`  2. git rebase ${upstreamRef}            # replay the fork patches`);
  console.log('  3. resolve conflicts, then `git rebase --continue`');
  console.log('  4. node tools/fork/reconcile.mjs status  # re-check drift and anchors');
  console.log('  5. pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run lint && pnpm test');
  if (options.dryRun) {
    console.log(dim('\n(--dry-run: nothing was changed)'));
    return;
  }
  if (report.behind === 0) {
    console.log(paint(C.green, '\nAlready based on that ref; nothing to do.'));
    return;
  }
  git(['branch', backup]);
  console.log(`\nBackup branch created: ${backup}`);
  const result = git(['rebase', upstreamRef], { allowFail: true });
  if (result === undefined) {
    const conflicts = gitLines(['diff', '--name-only', '--diff-filter=U']);
    console.log(paint(C.red, '\nRebase stopped with conflicts.'));
    for (const file of conflicts) console.log(`  conflict: ${file}`);
    console.log(`\nResolve, then: git rebase --continue`);
    console.log(`Abort with:    git rebase --abort`);
    console.log(`Restore with:  git reset --hard ${backup}`);
    process.exitCode = 2;
    return;
  }
  console.log(paint(C.green, '\nRebase completed.'));
  console.log(dim('Re-run: node tools/fork/reconcile.mjs status'));
}

function verify() {
  const steps = [
    ['pnpm install --frozen-lockfile', ['pnpm', ['install', '--frozen-lockfile']]],
    ['pnpm run typecheck', ['pnpm', ['run', 'typecheck']]],
    ['pnpm run lint', ['pnpm', ['run', 'lint']]],
    ['pnpm run sherif', ['pnpm', ['run', 'sherif']]],
  ];
  let failed = false;
  for (const [label, [cmd, args]] of steps) {
    process.stdout.write(`→ ${label}\n`);
    try {
      execFileSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
    } catch {
      failed = true;
      console.log(paint(C.red, `✗ ${label}`));
    }
  }
  console.log(failed ? paint(C.red, '\nVerification FAILED') : paint(C.green, '\nVerification passed'));
  process.exitCode = failed ? 1 : 0;
}

function printHelp() {
  console.log(`Fork reconciliation tool

Usage: node tools/fork/reconcile.mjs <command> [options]

Commands:
  status        (default) compare the fork against an upstream ref
  diff          show upstream changes to files a fork patch owns
  rebase        back up the branch and rebase onto an upstream ref
  verify        run install/typecheck/lint/sherif locally

Options:
  -u, --upstream <ref>  upstream branch/tag/commit (default ${MANIFEST.upstream.defaultRef})
      --no-fetch        do not fetch the upstream remote first
      --json            emit the status report as JSON
  -p, --patch <id>      limit 'diff' to one patch id or commit sha
  -n, --dry-run         print the rebase plan without changing anything
  -h, --help            this text

Examples:
  node tools/fork/reconcile.mjs status
  node tools/fork/reconcile.mjs status --upstream '@moonshot-ai/kimi-code@2.1.0'
  node tools/fork/reconcile.mjs diff --patch desktop-restore
  node tools/fork/reconcile.mjs rebase --upstream upstream/main`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === 'help') {
    printHelp();
    return;
  }
  if (!existsSync(join(REPO, '.git'))) throw new Error(`Not a git checkout: ${REPO}`);
  const remote = ensureUpstreamRemote();
  if (remote.added) console.log(dim(`Added git remote '${MANIFEST.upstream.remote}' -> ${MANIFEST.upstream.url}`));
  if (options.fetch) fetchUpstream();

  switch (options.command) {
    case 'status': {
      const report = statusReport(options);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printStatus(report);
      break;
    }
    case 'diff':
      printDiff(options);
      break;
    case 'rebase':
      printRebasePlan(options, statusReport(options));
      break;
    case 'verify':
      verify();
      break;
    default:
      throw new Error(`Unknown command: ${options.command}. Run with --help.`);
  }
}

try {
  main();
} catch (error) {
  console.error(paint(C.red, `error: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
}
