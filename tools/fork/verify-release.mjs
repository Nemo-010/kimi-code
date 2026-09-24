#!/usr/bin/env node
// Verify a published fork release.
//
//   node tools/fork/verify-release.mjs --tag continuous
//   node tools/fork/verify-release.mjs --tag v2.1.0-fork.2 --smoke
//
// Checks that every expected asset is present and non-trivial, verifies the
// native .sha256 files, and (with --smoke) downloads the host-arch artifacts,
// extracts the AppImages and runs them with `--version`.
//
// This is what stops a half-finished build from being mistaken for a release,
// and what proves the published binaries actually execute.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  MIN_APPIMAGE,
  MIN_DESKTOP_INSTALLER,
  desktopAssetsByPlatform,
  expectedAssets,
  hostAppImageArch,
} from './release-assets.mjs';

const C = { reset: '\u001B[0m', bold: '\u001B[1m', dim: '\u001B[2m', red: '\u001B[31m', green: '\u001B[32m', yellow: '\u001B[33m' };
const color = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (c, t) => (color ? `${c}${t}${C.reset}` : t);

let optionsKeep = false;

function parseArgs(argv) {
  const options = { tag: '', repo: undefined, smoke: false, arch: hostAppImageArch(), keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tag' || arg === '-t') options.tag = argv[++i];
    else if (arg === '--repo' || arg === '-r') options.repo = argv[++i];
    else if (arg === '--arch' || arg === '-a') options.arch = argv[++i];
    else if (arg === '--smoke') options.smoke = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function sh(cmd, args, opts = {}) {
  // A hard timeout keeps a hung launch (for example an Electron binary that
  // ignores --version) from stalling the whole job.
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 300_000,
    ...opts,
  }).trimEnd();
}

function gh(args) {
  return sh('gh', args);
}

function resolveRepo(explicit) {
  if (explicit !== undefined) return explicit;
  const remote = sh('git', ['remote', 'get-url', 'origin']);
  const match = /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/.exec(remote);
  if (match === null) throw new Error(`Cannot derive repo from origin: ${remote}`);
  return match[1];
}

function listAssets(repo, tag) {
  const json = gh(['release', 'view', tag, '--repo', repo, '--json', 'tagName,assets']);
  const parsed = JSON.parse(json);
  return parsed.assets.map((a) => ({ name: a.name, size: a.size, url: a.url }));
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function download(repo, tag, name, dir) {
  gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir, '--clobber']);
  return join(dir, name);
}

function hasCommand(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Run a desktop app under a dummy display and wait for it to connect to the
// bundled server. Uses xvfb-run when present; otherwise reports a skip.
async function guiSmoke(launch, dir, label, { tolerateMissingLibs = false } = {}) {
  if (!hasCommand('xvfb-run')) return [label, true, 'skipped: no xvfb-run'];
  const home = mkdtempSync(join(dir, 'home-'));
  const child = spawn(
    'xvfb-run',
    [
      '-a',
      launch,
      '--no-sandbox',
      '--disable-gpu',
      // GitHub runners have a tiny /dev/shm; keep Chromium out of it.
      '--disable-dev-shm-usage',
    ],
    {
      env: { ...process.env, KIMI_CODE_HOME: home, ELECTRON_DISABLE_SANDBOX: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  const deadline = Date.now() + 90_000;
  let connected = false;
  while (Date.now() < deadline) {
    if (output.includes('[kimi-desktop] connected to')) {
      connected = true;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (child.pid === undefined) {
    child.kill('SIGKILL');
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  const missingFont = output.includes('Could not find any font');
  if (connected && !missingFont) {
    return [label, true, output.split('\n').find((l) => l.includes('connected to'))?.trim() ?? ''];
  }
  if (!connected && tolerateMissingLibs) {
    // The zip uses the distro's libraries, and a runner is not the target
    // distro. A missing shared library is a skip, not a release failure.
    const missing = /error while loading shared libraries: ([^:]+)/.exec(output);
    if (missing !== null) return [label, true, `skipped: host is missing ${missing[1]}`];
  }
  let detail = output.slice(-400);
  if (missingFont) detail = `fontconfig could not resolve a family: ${detail}`;
  try {
    const log = readFileSync(join(home, 'server', 'kimi-desktop.log'), 'utf8').trim().split('\n').slice(-5).join(' | ');
    if (log.length > 0) detail = `${detail} | server log: ${log}`;
  } catch {
    // No server log; the captured output is all we have.
  }
  return [label, false, detail];
}

// The desktop AppImage has to carry its own fontconfig rules and at least one
// real font. sharun only points FONTCONFIG_FILE at the bundled fonts.conf when
// the host has no /etc/fonts/fonts.conf, so a host without fontconfig (or one
// whose generic-family rules never load) leaves Chromium without a "sans"
// family and the whole UI renders with no text.
function fontChecks(squash, dir) {
  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });
  const count = (path, test) => {
    try {
      return readdirSync(path).filter(test).length;
    } catch {
      return 0;
    }
  };
  const rules = count(join(squash, 'etc', 'fonts', 'conf.d'), (f) => f.endsWith('.conf'));
  record('desktop AppImage fontconfig rules', rules >= 10, `${rules} rule(s) in etc/fonts/conf.d`);
  const fonts = count(join(squash, 'share', 'fonts'), (f) => /\.(ttf|otf|ttc)$/i.test(f));
  record('desktop AppImage bundled fonts', fonts >= 1, `${fonts} font file(s) in share/fonts`);
  if (!hasCommand('fc-match')) return results;
  const env = {
    ...process.env,
    FONTCONFIG_PATH: join(squash, 'etc', 'fonts'),
    FONTCONFIG_FILE: join(squash, 'etc', 'fonts', 'fonts.conf'),
    XDG_CACHE_HOME: mkdtempSync(join(dir, 'fc-cache-')),
  };
  try {
    const sans = sh('fc-match', ['--format=%{family}|%{file}', 'sans-serif'], { env }).split('|');
    const mono = sh('fc-match', ['--format=%{family}|%{file}', 'monospace'], { env }).split('|');
    const ok = sans[0] !== mono[0] && !/mono/i.test(sans[0]) && existsSync(sans[1]);
    record('desktop AppImage font resolution', ok, `sans-serif -> ${sans[0]}, monospace -> ${mono[0]}`);
  } catch (error) {
    record('desktop AppImage font resolution', false, error instanceof Error ? error.message : String(error));
  }
  return results;
}

// The Linux desktop zip is the no-install counterpart of the .deb. Check that
// it really contains a runnable binary and not, say, a macOS app bundle.
async function desktopZipSmoke(repo, tag, names, dir) {
  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });
  const name = names.find((asset) => /^Kimi-Code-Desktop-.+-linux-.+\.zip$/.test(asset));
  if (name === undefined) {
    record('desktop Linux portable zip', false, 'no Kimi-Code-Desktop-*-linux-*.zip asset published');
    return results;
  }
  try {
    const zipPath = download(repo, tag, name, dir);
    const out = join(dir, 'desktop-zip');
    sh('unzip', ['-oq', zipPath, '-d', out]);
    const binary = join(out, 'kimi-desktop');
    if (!existsSync(binary)) {
      record(`${name} binary`, false, 'no kimi-desktop at the archive root');
      return results;
    }
    const mode = statSync(binary).mode;
    const executable = (mode & 0o111) !== 0;
    record(`${name} executable bit`, executable, executable ? '' : `mode ${(mode & 0o777).toString(8)}`);
    if (!executable) return results;
    record(...(await guiSmoke(binary, dir, `${name} GUI (dummy display)`, { tolerateMissingLibs: true })));
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
  return results;
}

async function runSmoke(repo, tag, arch, dir, names) {
  const nativeTarget = `linux-${arch === 'aarch64' ? 'arm64' : 'x64'}`;
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? paint(C.green, '✓') : paint(C.red, '✗')} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  console.log(paint(C.bold, '\nSmoke test'));
  const zipName = `kimi-code-${nativeTarget}.zip`;
  const shaName = `${zipName}.sha256`;
  try {
    const zipPath = download(repo, tag, zipName, dir);
    const shaPath = download(repo, tag, shaName, dir);
    const expected = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
    const actual = sha256(zipPath);
    record('native sha256', expected === actual, expected === actual ? '' : `expected ${expected.slice(0, 12)}… got ${actual.slice(0, 12)}…`);
    sh('unzip', ['-oq', zipPath, '-d', join(dir, 'native')]);
    const bin = join(dir, 'native', 'kimi');
    const version = sh(bin, ['--version']);
    record('native binary --version', /^\d+\.\d+\.\d+/.test(version), version);
  } catch (error) {
    record('native zip', false, error.message);
  }

  for (const appimage of [`kimi-code-${arch}.AppImage`, `Kimi-Code-Desktop-${arch}.AppImage`]) {
    try {
      const path = download(repo, tag, appimage, dir);
      const size = statSync(path).size;
      if (size < MIN_APPIMAGE) {
        record(appimage, false, `only ${size} bytes`);
        continue;
      }
      sh('chmod', ['+x', path]);
      const extractDir = mkdtempSync(join(dir, 'extract-'));
      sh(path, ['--appimage-extract'], { cwd: extractDir });
      const squash = join(extractDir, 'squashfs-root');
      const entries = readdirSync(join(squash, 'bin'));
      const cli = appimage.startsWith('kimi-code-');
      const target = cli ? join(squash, 'bin', 'kimi') : join(squash, 'bin', 'kimi-desktop');
      if (!entries.includes(basename(target))) {
        record(appimage, false, `extracted AppDir has no bin/${basename(target)}`);
        continue;
      }
      if (cli) {
        const version = sh(target, ['--version']);
        record(`${appimage} --version`, /^\d+\.\d+\.\d+/.test(version), version);
      } else {
        const backend = sh(join(squash, 'bin', 'kimi'), ['--version']);
        record(`${appimage} bundled kimi --version`, /^\d+\.\d+\.\d+/.test(backend), backend);
        for (const check of fontChecks(squash, dir)) record(check.name, check.ok, check.detail);
        // A packaged Electron app does not handle --version, so the only way to
        // prove the desktop runs is to launch it under a dummy display and wait
        // for it to bring up (or attach to) its server.
        record(...(await guiSmoke(join(squash, 'AppRun'), dir, `${appimage} GUI (dummy display)`)));
      }
      if (!optionsKeep) rmSync(extractDir, { recursive: true, force: true });
    } catch (error) {
      record(appimage, false, error.message);
    }
  }
  for (const check of await desktopZipSmoke(repo, tag, names, dir)) record(check.name, check.ok, check.detail);
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  optionsKeep = options.keep;
  if (options.help || options.tag === '') {
    console.log(`Verify a published fork release.

Usage: node tools/fork/verify-release.mjs --tag <tag> [options]

Options:
  -t, --tag <tag>    release tag to verify (required)
  -r, --repo <o/r>   repository (default: origin remote)
  -a, --arch <arch>  x86_64 | aarch64 (default: host)
      --smoke        download host-arch artifacts, extract and execute them
      --keep         keep the temporary download directory
  -h, --help         this text`);
    if (options.tag === '') process.exitCode = 1;
    return;
  }
  const repo = resolveRepo(options.repo);
  console.log(paint(C.bold, `Verifying ${repo}@${options.tag}`));
  const assets = listAssets(repo, options.tag);
  const names = assets.map((a) => a.name);
  const byName = new Map(assets.map((a) => [a.name, a]));
  console.log(`  ${assets.length} asset(s) published`);

  const problems = [];
  console.log(paint(C.bold, '\nRequired assets'));
  for (const want of expectedAssets()) {
    const found = byName.get(want.name);
    if (found === undefined) {
      problems.push(`missing ${want.name}`);
      console.log(`  ${paint(C.red, '✗')} ${want.name} (missing)`);
    } else if (found.size < want.min) {
      problems.push(`suspiciously small ${want.name} (${found.size} bytes)`);
      console.log(`  ${paint(C.yellow, '!')} ${want.name} (${found.size} bytes, expected >= ${want.min})`);
    } else {
      console.log(`  ${paint(C.green, '✓')} ${want.name} (${(found.size / 1024 / 1024).toFixed(1)} MiB)`);
    }
  }

  for (const platform of desktopAssetsByPlatform(names)) {
    if (platform.names.length === 0) {
      problems.push(`no ${platform.label}`);
      console.log(`  ${paint(C.red, '✗')} ${platform.label} (missing)`);
      continue;
    }
    for (const name of platform.names) {
      const asset = byName.get(name);
      const small = asset.size < MIN_DESKTOP_INSTALLER;
      if (small) problems.push(`suspiciously small ${name} (${asset.size} bytes)`);
      console.log(
        `  ${small ? paint(C.yellow, '!') : paint(C.green, '✓')} ${name} (${(asset.size / 1024 / 1024).toFixed(1)} MiB)`,
      );
    }
  }

  let smoke = [];
  if (options.smoke) {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-verify-'));
    try {
      smoke = await runSmoke(repo, options.tag, options.arch, dir, names);
    } finally {
      if (!options.keep) rmSync(dir, { recursive: true, force: true });
      else console.log(paint(C.dim, `\nkept ${dir}`));
    }
    for (const r of smoke) if (!r.ok) problems.push(`smoke: ${r.name}`);
  }

  console.log('');
  if (problems.length === 0) {
    console.log(paint(C.green, paint(C.bold, 'Release verified.')));
  } else {
    console.log(paint(C.red, paint(C.bold, `Release FAILED verification (${problems.length} problem(s)):`)));
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(paint(C.red, `error: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
}
