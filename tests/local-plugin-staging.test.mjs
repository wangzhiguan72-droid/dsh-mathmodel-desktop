import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stageLocalPlugin } from '../scripts/build-runtime.mjs';

test('fresh local plugin replaces the unchanged-version pnpm cache', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin'), profile = path.join(root, 'profile');
  const target = path.join(profile, 'node_modules/@deepseek-harness/dsh-mathmodel');
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: '@deepseek-harness/dsh-mathmodel', version: '0.1.1', main: 'lib/index.js' }));
  fs.writeFileSync(path.join(plugin, 'lib/index.js'), 'export const Config = {};');
  fs.writeFileSync(path.join(target, 'lib/index.js'), 'old cached settings registration');
  fs.writeFileSync(path.join(target, 'lib/removed.js'), 'stale removed export');
  stageLocalPlugin(profile, plugin);
  assert.equal(fs.readFileSync(path.join(target, 'lib/index.js'), 'utf8'), 'export const Config = {};');
  assert.equal(fs.existsSync(path.join(target, 'lib/removed.js')), false);
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'foreign-plugin', main: 'lib/index.js' }));
  assert.throws(() => stageLocalPlugin(profile, plugin), /identity/);
  assert.equal(fs.readFileSync(path.join(target, 'lib/index.js'), 'utf8'), 'export const Config = {};');
});
