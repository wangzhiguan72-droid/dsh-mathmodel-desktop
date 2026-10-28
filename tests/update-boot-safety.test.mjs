import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertUpdateBootSafe } = require('../src/update-boot-safety.cjs');
const { snapshotData } = require('../src/update-data-snapshot.cjs');
const { hasCompleteWebFamily } = require('../src/runtime.cjs');

test('legacy update jobs may start the bridge but cannot write a V4 profile', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-safe-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installDir = path.join(root, 'app'), userDataDir = path.join(root, 'data'), homeDir = path.join(root, 'home');
  const module = path.join(installDir, 'resources/runtime/host/node_modules/@deepseek-ai/dsh-session/lib/index.js');
  fs.mkdirSync(path.dirname(module), { recursive: true });
  fs.mkdirSync(path.join(userDataDir, 'desktop-updates'), { recursive: true });
  fs.mkdirSync(homeDir);
  fs.writeFileSync(path.join(homeDir, 'sentinel'), 'old home');
  const nonce = randomUUID(), jobPath = path.join(userDataDir, 'desktop-updates', nonce + '.json');
  const job = { nonce, installDir, toVersion: '0.1.3', state: 'prepared' };
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const options = { jobPath, nonce, installDir, userDataDir, homeDir, version: '0.1.3' };
  fs.writeFileSync(module, 'const SESSION_FORMAT_VERSION = 3;');
  assert.doesNotThrow(() => assertUpdateBootSafe(options));
  fs.writeFileSync(module, 'const SESSION_FORMAT_VERSION = 4;');
  assert.throws(() => assertUpdateBootSafe(options), /Protected updater/);
  assert.equal(fs.readFileSync(path.join(homeDir, 'sentinel'), 'utf8'), 'old home');
  job.sessionFormatFrom = 4; job.sessionFormatTo = 4;
  fs.writeFileSync(jobPath, JSON.stringify(job));
  assert.doesNotThrow(() => assertUpdateBootSafe(options));
  job.sessionFormatFrom = 3;
  fs.writeFileSync(jobPath, JSON.stringify(job));
  assert.throws(() => assertUpdateBootSafe(options), /snapshot identity/);
  job.homeDir = homeDir;
  fs.mkdirSync(path.join(root, 'backups'));
  job.dataSnapshot = snapshotData({ home: homeDir, userData: userDataDir, backupRoot: path.join(root, 'backups'), nonce });
  fs.writeFileSync(jobPath, JSON.stringify(job));
  assert.doesNotThrow(() => assertUpdateBootSafe(options));
  job.dataSnapshot.nonce = randomUUID();
  fs.writeFileSync(jobPath, JSON.stringify(job));
  assert.throws(() => assertUpdateBootSafe(options), /snapshot identity/);
  assert.throws(() => assertUpdateBootSafe({ ...options, nonce: randomUUID() }), /identity mismatch/);
});

test('bridge readiness requires all thirteen exact legacy family rows', () => {
  const children = ['dsh-client-ui-web-ui-settings', 'dsh-client-ui-plugin-manager',
    'dsh-client-ui-community-plugins', 'dsh-client-ui-market', 'dsh-client-ui-task-board',
    'dsh-client-ui-git-graph', 'dsh-remote-web-ui', 'dsh-pet', 'dsh-usage', 'dsh-session-archive',
    'dsh-client-ui-model-capabilities', 'dsh-client-ui-preset-center', 'dsh-client-ui-skin-center']
    .map(name => '@linxin666/' + name);
  assert.equal(hasCompleteWebFamily({ children }, '0.3.23'), true);
  assert.equal(hasCompleteWebFamily({ children }, '0.4.5'), false);
  assert.equal(hasCompleteWebFamily({ children }, 'unknown'), false);
  assert.equal(hasCompleteWebFamily({ children: children.slice(1) }, '0.3.23'), false);
  assert.equal(hasCompleteWebFamily({ children: [...children, '@linxin666/dsh-ssh'] }, '0.3.23'), false);
});
