#!/usr/bin/env node
// Pre-publish gate. Runs after `actions/download-artifact` and before any
// upload, so a build that "succeeded" but produced nothing usable can never
// reach (or overwrite) a good release.
//
//   node tools/fork/validate-artifacts.mjs --dir dist-release

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  MIN_DESKTOP_INSTALLER,
  desktopInstallerPattern,
  expectedAssets,
} from './release-assets.mjs';

const C = { reset: '\u001B[0m', bold: '\u001B[1m', red: '\u001B[31m', green: '\u001B[32m', yellow: '\u001B[33m' };
const color = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (c, t) => (color ? `${c}${t}${C.reset}` : t);

function parseArgs(argv) {
  const options = { dir: undefined, allowMissingDesktop: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir' || arg === '-d') options.dir = argv[++i];
    else if (arg === '--allow-missing-desktop') options.allowMissingDesktop = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.dir === undefined) {
    console.log(`Pre-publish artifact gate.

Usage: node tools/fork/validate-artifacts.mjs --dir <dir>

Options:
  -d, --dir <dir>              directory containing downloaded artifacts
      --allow-missing-desktop  do not require a desktop installer
  -h, --help                   this text`);
    if (options.dir === undefined) process.exitCode = 1;
    return;
  }
  const files = walk(options.dir);
  const byName = new Map(files.map((f) => [basename(f), f]));
  console.log(paint(C.bold, `Validating ${files.length} artifact file(s) under ${options.dir}`));

  const problems = [];
  for (const want of expectedAssets()) {
    const path = byName.get(want.name);
    if (path === undefined) {
      problems.push(`missing ${want.name}`);
      console.log(`  ${paint(C.red, '✗')} ${want.name} (missing)`);
      continue;
    }
    const size = statSync(path).size;
    if (size < want.min) {
      problems.push(`${want.name} is ${size} bytes, expected >= ${want.min}`);
      console.log(`  ${paint(C.red, '✗')} ${want.name} (${size} bytes, expected >= ${want.min})`);
      continue;
    }
    console.log(`  ${paint(C.green, '✓')} ${want.name} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
  }

  for (const target of expectedAssets().filter((a) => a.name.endsWith('.zip'))) {
    const zip = byName.get(target.name);
    const sha = byName.get(`${target.name}.sha256`);
    if (zip === undefined || sha === undefined) continue;
    const expected = readFileSync(sha, 'utf8').trim().split(/\s+/)[0];
    const actual = sha256(zip);
    if (expected !== actual) {
      problems.push(`${target.name} sha256 mismatch`);
      console.log(`  ${paint(C.red, '✗')} ${target.name} sha256 mismatch`);
    }
  }

  if (!options.allowMissingDesktop) {
    const installers = files.filter((f) => desktopInstallerPattern().test(basename(f)));
    if (installers.length === 0) {
      problems.push('no desktop installer (.dmg/.zip/.exe/.deb)');
      console.log(`  ${paint(C.red, '✗')} desktop installer (missing)`);
    }
    for (const installer of installers) {
      const size = statSync(installer).size;
      const ok = size >= MIN_DESKTOP_INSTALLER;
      if (!ok) problems.push(`${basename(installer)} is only ${size} bytes`);
      console.log(`  ${ok ? paint(C.green, '✓') : paint(C.red, '✗')} ${basename(installer)} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
    }
  }

  console.log('');
  if (problems.length === 0) {
    console.log(paint(C.green, paint(C.bold, 'Artifacts OK.')));
  } else {
    console.log(paint(C.red, paint(C.bold, `Artifact validation FAILED (${problems.length} problem(s)) — refusing to publish:`)));
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(paint(C.red, `error: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
}
