import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const plugin = path.join(root, 'plugins/dsh-auto-mode');
const hostModules = path.join(root, 'runtime/host/node_modules');
const version = '0.2.1-rc.5';

test('sandbox auto declares the exact installed kernel cohort', () => {
  const compatibility = JSON.parse(fs.readFileSync(path.join(plugin, 'compatibility.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json')));
  assert.ok(compatibility.supportedHosts.some(host => host.version === version));
  assert.equal(manifest.engines.dsh.includes(version), true);
  for (const name of ['dsh-permission-presets', 'dsh-tools', 'dsh-llm', 'dsh-session', 'dsh-user-approval']) {
    const installed = JSON.parse(fs.readFileSync(path.join(hostModules, '@deepseek-ai', name, 'package.json')));
    assert.equal(installed.version, version);
    assert.ok(manifest.peerDependencies[`@deepseek-ai/${name}`].includes(version));
  }
});

test('latest host retains the permission, tool guard, and current-directory seams', async () => {
  const imports = async name => import(pathToFileURL(path.join(hostModules, '@deepseek-ai', name, 'lib/index.js')).href);
  const { ToolRuntime } = await imports('dsh-tools');
  const { PermissionPresetService } = await imports('dsh-permission-presets');
  const { WorkingDirectoryService } = await imports('dsh-working-directory');
  assert.equal(typeof ToolRuntime.prototype.guard, 'function');
  assert.equal(typeof PermissionPresetService.prototype.resolve, 'function');
  assert.equal(typeof PermissionPresetService.prototype.current, 'function');
  assert.equal(typeof WorkingDirectoryService.prototype.get, 'function');
  assert.equal(typeof WorkingDirectoryService.prototype.ensure, 'function');
  const source = fs.readFileSync(path.join(hostModules, '@deepseek-ai/dsh-tools/lib/index.js'), 'utf8');
  assert.match(source, /"tools\/pre-execute"/);
  assert.match(source, /"tools\/post-execute"/);
  assert.match(source, /"tools\/result"/);
});

test('sandbox auto applies against latest host peers and guards live working directory', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-latest-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const copied = path.join(temporary, 'plugin');
  fs.mkdirSync(copied);
  fs.cpSync(path.join(plugin, 'lib'), path.join(copied, 'lib'), { recursive: true });
  for (const name of ['package.json', 'compatibility.json']) {
    fs.copyFileSync(path.join(plugin, name), path.join(copied, name));
  }
  fs.symlinkSync(hostModules, path.join(copied, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { apply } = await import(pathToFileURL(path.join(copied, 'lib/index.js')).href);

  const handlers = new Map();
  let guard;
  const original = path.join(temporary, 'original');
  const current = path.join(temporary, 'current');
  fs.mkdirSync(original);
  fs.mkdirSync(current);
  const session = { header: { cwd: original, origin: 'user' }, seq: 0, eventAt: () => undefined };
  const agent = { session };
  let ensured = 0;
  const ctx = {
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), current: () => 'sandbox-auto' },
    workingDirectory: { get: () => current, ensure: async () => { ensured += 1; return current; } },
    tools: { guard: fn => { guard = fn; } },
    llm: { stream: () => { throw new Error('classifier must not run for deterministic cases'); } },
    on: (name, fn) => { handlers.set(name, fn); },
    inject: (services, callback) => {
      if (services.includes('sessions')) callback({ on: () => {}, sessions: { list: () => [] } });
      if (services.includes('systemPrompt')) callback({ systemPrompt: { context: () => {} } });
    },
    get: name => name === 'workingDirectory' ? ctx.workingDirectory : undefined,
  };
  apply(ctx);
  assert.equal(typeof guard, 'function');
  const pre = handlers.get('tools/pre-execute');
  assert.equal(typeof pre, 'function');
  const exec = (name, args) => ({ name, arguments: args, agent, signal: new AbortController().signal });
  const next = async () => ({ kind: 'allow' });
  assert.equal(guard(exec('write', { file_path: 'notes.txt' })), undefined);
  assert.deepEqual(await pre(exec('read', { file_path: 'notes.txt' }), next), { kind: 'allow' });
  assert.deepEqual(await pre(exec('write', { file_path: 'notes.txt' }), next), { kind: 'allow' });
  assert.equal(ensured, 2);
  assert.match(guard(exec('web_fetch', { url: 'https://example.com/?token=123456789' })), /credential/);
  assert.match(guard(exec('write', { file_path: 'C:\\' })), /filesystem root/);
  assert.match((await pre(exec('write', { file_path: path.join(current, '.git/config') }), next)).reason, /classifier unavailable; action denied/);
  assert.equal((await pre(exec('write', { file_path: path.join(original, '.git/config') }), next)).kind, 'allow');
  ctx.get = () => undefined;
  assert.throws(() => guard(exec('write', { file_path: 'notes.txt' })), /current working-directory service is unavailable/);
  assert.equal((await pre(exec('write', { file_path: 'notes.txt' }), next)).kind, 'deny');
});
