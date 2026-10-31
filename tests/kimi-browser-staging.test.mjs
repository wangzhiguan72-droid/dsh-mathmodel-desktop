import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  kimiBrowserDigest,
  stageKimiBrowserPlugin,
  verifyStagedKimiBrowser,
} from '../scripts/stage-kimi-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'plugins', 'dsh-better-browser');
const lock = path.join(root, 'scripts', 'kimi-browser-vendor-lock.json');

test('Kimi browser distribution is sealed and selected in the profile', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'package.json'), 'utf8'));
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'profile-web', 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@dsh-external/dsh-better-browser');
  assert.equal(manifest.version, '0.3.6');
  assert.equal(kimiBrowserDigest(vendor), JSON.parse(fs.readFileSync(lock, 'utf8')).sha256);
  assert.match(profile.dependencies[manifest.name], /^file:/);
  assert.ok(profile.dsh.profile.bundles.includes(manifest.name));
  assert.match(fs.readFileSync(path.join(vendor, 'lib', 'index.js'), 'utf8'), /webbridge_navigate/);
});

test('Kimi browser staging copies only sealed runtime assets as real files', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kimi-stage-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const profile = path.join(temp, 'profile');
  const target = path.join(profile, 'node_modules', '@dsh-external', 'dsh-better-browser');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'stale.txt'), 'old');
  stageKimiBrowserPlugin(profile, vendor, lock);
  assert.equal(fs.existsSync(path.join(target, 'stale.txt')), false);
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
  assert.equal(verifyStagedKimiBrowser(profile, vendor, lock), kimiBrowserDigest(vendor));
  fs.writeFileSync(path.join(target, 'lib', 'index.js'), 'tampered');
  assert.throws(() => verifyStagedKimiBrowser(profile, vendor, lock), /mismatch/);
});

test('Kimi browser staging rejects unsafe targets', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kimi-stage-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const profile = path.join(temp, 'profile');
  const scope = path.join(profile, 'node_modules', '@dsh-external');
  fs.mkdirSync(scope, { recursive: true });
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(scope, 'dsh-better-browser'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => stageKimiBrowserPlugin(profile, vendor, lock), /Unsafe staged Kimi browser plugin/);
});
