import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageSandboxAutoPlugin, verifyStagedSandboxAuto, sandboxAutoDigest, finalizeSandboxAutoProfileManifest } from '../scripts/stage-sandbox-auto.mjs';

test('fresh profile selects both Auto bundles and pins Sandbox Auto exactly in seed', t => {
  const root = path.resolve(import.meta.dirname, '..');
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'runtime/profile-web/package.json'), 'utf8'));
  assert.match(profile.dependencies['@nanmicoder/dsh-auto-mode'], /^file:/);
  assert.ok(profile.dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-auto-review'));
  assert.ok(profile.dsh.profile.bundles.includes('@nanmicoder/dsh-auto-mode'));
  assert.ok(!fs.readFileSync(path.join(root, 'build/profile.cordis.patch.yml'), 'utf8').includes('sandbox: danger-full-access'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-profile-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(profile));
  finalizeSandboxAutoProfileManifest(tmp);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'))).dependencies['@nanmicoder/dsh-auto-mode'], '0.2.0');
});

test('vendored 0.2.0 distribution matches its sealed build artifact', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const plugin = path.join(root, 'plugins/dsh-auto-mode');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'scripts/sandbox-auto-vendor-lock.json'), 'utf8'));
  assert.equal(sandboxAutoDigest(plugin), lock.sha256);
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, 'compatibility.json'))).recommendedHost, '0.2.0-rc.2');
  assert.match(fs.readFileSync(path.join(plugin, 'cordis.patch.yml'), 'utf8'), /sandbox-auto:/);
});

test('sandbox auto staging replaces stale payload and verifies exact vendored bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin');
  const profile = path.join(root, 'profile');
  const target = path.join(profile, 'node_modules', '@nanmicoder', 'dsh-auto-mode');
  for (const dir of [path.join(plugin, 'lib'), target]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: '@nanmicoder/dsh-auto-mode', version: '0.2.0', main: './lib/index.js' }));
  fs.writeFileSync(path.join(plugin, 'lib/index.js'), 'export const name = "auto-permission-mode";');
  for (const file of ['compatibility.json', 'cordis.patch.yml', 'README_ZH.md', 'LICENSE']) fs.writeFileSync(path.join(plugin, file), file);
  fs.writeFileSync(path.join(target, 'stale.js'), 'stale');
  const lock = path.join(root, 'lock.json');
  fs.writeFileSync(lock, JSON.stringify({ sha256: sandboxAutoDigest(plugin) }));
  stageSandboxAutoPlugin(profile, plugin, lock);
  assert.equal(fs.existsSync(path.join(target, 'stale.js')), false);
  assert.equal(fs.readFileSync(path.join(target, 'lib/index.js'), 'utf8'), 'export const name = "auto-permission-mode";');
  verifyStagedSandboxAuto(profile, plugin, lock);

  fs.writeFileSync(path.join(target, 'lib/index.js'), 'tampered');
  assert.throws(() => verifyStagedSandboxAuto(profile, plugin, lock), /mismatch/);
  fs.writeFileSync(path.join(plugin, 'lib/index.js'), 'source changed');
  assert.throws(() => stageSandboxAutoPlugin(profile, plugin, lock), /integrity mismatch/);
});

test('sandbox auto staging refuses symlinks and foreign package identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'node_modules', '@nanmicoder'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'foreign-plugin', version: '0.2.0', main: './lib/index.js' }));
  fs.writeFileSync(path.join(plugin, 'lib/index.js'), 'entry');
  for (const file of ['compatibility.json', 'cordis.patch.yml', 'README_ZH.md', 'LICENSE']) fs.writeFileSync(path.join(plugin, file), file);
  const lock = path.join(root, 'lock.json');
  fs.writeFileSync(lock, JSON.stringify({ sha256: sandboxAutoDigest(plugin) }));
  assert.throws(() => stageSandboxAutoPlugin(profile, plugin, lock), /identity/);
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: '@nanmicoder/dsh-auto-mode', version: '0.2.0', main: './lib/index.js' }));
  fs.writeFileSync(lock, JSON.stringify({ sha256: sandboxAutoDigest(plugin) }));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(profile, 'node_modules', '@nanmicoder', 'dsh-auto-mode'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => stageSandboxAutoPlugin(profile, plugin, lock), /Unsafe staged sandbox Auto plugin/);
});
