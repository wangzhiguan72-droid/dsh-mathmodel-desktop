import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ensureFrameworkCohort, SEED_MARKER } = require('../src/runtime.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cohort-'));
  const home = path.join(root, 'home');
  const host = path.join(root, 'host');
  const profile = path.join(home, 'profiles', 'mathmodel');
  const hostPkg = path.join(host, 'node_modules', '@deepseek-ai', 'dsh-scope');
  const profilePkg = path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-scope');
  const source = 'const scopes = new WeakMap(); export function createScope(ctx) { scopes.set(ctx, Symbol("scope")); } export function scopeOf(ctx) { return scopes.get(ctx); }\n';
  for (const pkg of [hostPkg, profilePkg]) {
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-scope', version: '0.1.5-rc.3', type: 'module' }));
    fs.writeFileSync(path.join(pkg, 'index.mjs'), source);
  }
  fs.writeFileSync(path.join(profile, 'package.json'), '{}');
  fs.writeFileSync(path.join(profile, SEED_MARKER), JSON.stringify({ stamp: 'fixture' }));
  return { root, home, host, profile, hostPkg, profilePkg };
}

function observesSameScope(hostPkg, profilePkg) {
  const script = 'import { pathToFileURL } from "node:url"; const host = await import(pathToFileURL(process.argv[1])); const profile = await import(pathToFileURL(process.argv[2])); const ctx = {}; host.createScope(ctx); process.stdout.write(String(typeof profile.scopeOf(ctx) === "symbol"));';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, path.join(hostPkg, 'index.mjs'), path.join(profilePkg, 'index.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('seeded profile shares the host ESM singleton and keeps its old package as a backup', (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  assert.equal(observesSameScope(paths.hostPkg, paths.profilePkg), 'false');
  const result = ensureFrameworkCohort(paths.home, paths.host, 'mathmodel');
  assert.deepEqual(result.linked, ['dsh-scope']);
  assert.equal(fs.lstatSync(paths.profilePkg).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(paths.profilePkg), fs.realpathSync(paths.hostPkg));
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'dsh-scope', 'index.mjs'), 'utf8').includes('WeakMap'), true);
  assert.equal(observesSameScope(paths.hostPkg, paths.profilePkg), 'true');
  assert.deepEqual(ensureFrameworkCohort(paths.home, paths.host, 'mathmodel').linked, []);
});

test('Electron reseed preserves the old host behind framework junctions', { skip: process.platform !== 'win32' }, (t) => {
  const paths = fixture();
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(paths.root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(paths.root, { recursive: true, force: true });
  });
  const seed = path.join(paths.root, 'seed');
  fs.cpSync(paths.profile, seed, { recursive: true });
  ensureFrameworkCohort(paths.home, paths.host, 'mathmodel');
  const probe = path.join(paths.root, 'probe.cjs');
  const receipt = path.join(paths.root, 'result.txt');
  const userData = path.join(paths.root, 'electron-data');
  fs.mkdirSync(userData);
  const externalProfile = path.join(paths.root, 'external-profile');
  const externalProfiles = path.join(paths.root, 'external-profiles');
  fs.symlinkSync(paths.host, externalProfile, 'junction');
  fs.symlinkSync(paths.host, externalProfiles, 'junction');
  fs.writeFileSync(probe, [
    "const fs = require('node:fs');",
    "const { app } = require('electron');",
    `app.setPath('userData', ${JSON.stringify(userData)});`,
    `app.setPath('crashDumps', ${JSON.stringify(userData)});`,
    'try {',
    `  const runtime = require(${JSON.stringify(fileURLToPath(new URL('../src/runtime.cjs', import.meta.url)))});`,
    `  for (const target of ${JSON.stringify([externalProfile, path.join(externalProfiles, 'mathmodel')])}) {`,
    '    let rejected = false;',
    `    try { runtime.applyProfileSeed(${JSON.stringify(seed)}, target, 'reseed', 'new', {}); }`,
    '    catch (error) { if (/not a local directory/.test(error.message)) rejected = true; else throw error; }',
    "    if (!rejected) throw new Error('Electron must reject an external profile junction');",
    '  }',
    `  runtime.applyProfileSeed(${JSON.stringify(seed)}, ${JSON.stringify(paths.profile)}, 'reseed', 'new', {});`,
    `  fs.writeFileSync(${JSON.stringify(receipt)}, String(fs.existsSync(${JSON.stringify(path.join(paths.hostPkg, 'index.mjs'))})));`,
    '  app.exit(0);',
    '} catch (error) {',
    `  fs.writeFileSync(${JSON.stringify(receipt)}, error.stack);`,
    '  app.exit(1);',
    '}',
  ].join('\n'));
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    PATH: process.env.PATH ?? process.env.Path, TEMP: paths.root, TMP: paths.root,
    APPDATA: userData, LOCALAPPDATA: userData, USERPROFILE: userData, HOME: userData };
  const result = spawnSync(require('electron'), [probe], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(receipt, 'utf8'), 'true', 'reseed must not remove the original host package');
  assert.equal(fs.readFileSync(path.join(paths.hostPkg, 'index.mjs'), 'utf8').includes('WeakMap'), true);
});

test('user-managed profile is not modified', (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  fs.unlinkSync(path.join(paths.profile, SEED_MARKER));
  assert.deepEqual(ensureFrameworkCohort(paths.home, paths.host, 'mathmodel').linked, []);
  assert.equal(fs.lstatSync(paths.profilePkg).isSymbolicLink(), false);
});

test('external scoped node_modules junction is rejected before any mutation', (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const external = path.join(paths.root, 'external-scope');
  const scope = path.dirname(paths.profilePkg);
  fs.renameSync(scope, external);
  fs.symlinkSync(external, scope, 'junction');
  assert.throws(() => ensureFrameworkCohort(paths.home, paths.host, 'mathmodel'), /escapes its owner/);
  assert.equal(fs.lstatSync(path.join(external, 'dsh-scope')).isSymbolicLink(), false);
});

test('missing host package leaves the seeded profile copy in place', (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  fs.rmSync(paths.hostPkg, { recursive: true, force: true });
  assert.deepEqual(ensureFrameworkCohort(paths.home, paths.host, 'mathmodel').linked, []);
  assert.equal(fs.lstatSync(paths.profilePkg).isSymbolicLink(), false);
});

test('version mismatch fails clearly and preserves the profile package', (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  for (const parent of [path.dirname(paths.hostPkg), path.dirname(paths.profilePkg)]) {
    const earlierPkg = path.join(parent, 'dsh-alpha');
    fs.mkdirSync(earlierPkg);
    fs.writeFileSync(path.join(earlierPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-alpha', version: '0.1.5-rc.3' }));
  }
  fs.writeFileSync(path.join(paths.profilePkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-scope', version: '0.1.5-rc.2' }));
  assert.throws(() => ensureFrameworkCohort(paths.home, paths.host, 'mathmodel'), /dsh-scope differs between profile/);
  assert.equal(fs.lstatSync(paths.profilePkg).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(path.dirname(paths.profilePkg), 'dsh-alpha')).isSymbolicLink(), false);
  assert.equal(fs.readdirSync(paths.profile).some((name) => name.startsWith('.dsh-framework-cohort-backup-')), false);
});

test('unexpected seed stamp fails before any package is moved', (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  assert.throws(() => ensureFrameworkCohort(paths.home, paths.host, 'mathmodel', 'current'), /seed stamp differs/);
  assert.equal(fs.lstatSync(paths.profilePkg).isSymbolicLink(), false);
});

test('invalid seed marker and missing official scope fail clearly', (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const marker = path.join(paths.profile, SEED_MARKER);
  fs.writeFileSync(marker, '{broken');
  assert.throws(() => ensureFrameworkCohort(paths.home, paths.host, 'mathmodel'), /invalid profile seed marker/);
  fs.writeFileSync(marker, '{}');
  assert.throws(() => ensureFrameworkCohort(paths.home, paths.host, 'mathmodel'), /invalid profile seed marker/);
  fs.writeFileSync(marker, JSON.stringify({ stamp: 'fixture' }));
  fs.rmSync(path.dirname(paths.profilePkg), { recursive: true, force: true });
  assert.throws(() => ensureFrameworkCohort(paths.home, paths.host, 'mathmodel'), /official package scope is missing/);
});

test('second link failure rolls back every package in the batch', (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const secondName = 'dsh-zeta';
  const secondProfile = path.join(path.dirname(paths.profilePkg), secondName);
  const secondHost = path.join(path.dirname(paths.hostPkg), secondName);
  for (const pkg of [secondProfile, secondHost]) {
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${secondName}`, version: '0.1.5-rc.3' }));
    fs.writeFileSync(path.join(pkg, 'original.txt'), pkg);
  }
  const originalSymlink = fs.symlinkSync;
  let links = 0;
  fs.symlinkSync = (...args) => {
    if (++links === 2) throw new Error('injected second link failure');
    return originalSymlink(...args);
  };
  try {
    assert.throws(() => ensureFrameworkCohort(paths.home, paths.host, 'mathmodel'), /injected second link failure.*previous packages restored/);
  } finally {
    fs.symlinkSync = originalSymlink;
  }
  assert.equal(links, 2);
  assert.equal(fs.lstatSync(paths.profilePkg).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(secondProfile).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(secondProfile, 'original.txt'), 'utf8'), secondProfile);
  assert.equal(observesSameScope(paths.hostPkg, paths.profilePkg), 'false');
});
