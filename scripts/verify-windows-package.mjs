import { snapshotProcessFamily } from './windows-processes.mjs';
import { createInstalledHostClient } from './installed-host-client.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { SEED_MARKER, WEB_FAMILY_ROWS_0411, activeWebFamilyRows } = require('../src/runtime.cjs');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.resolve(process.argv[2] ?? path.join(repo, 'dist/win-unpacked'));
if (process.platform !== 'win32') throw new Error('This packaged-app check requires Windows.');
const executableName = process.env.DSH_PACKAGE_EXECUTABLE ?? 'DeepSeek 数学建模版.exe';
assert.equal(path.basename(executableName), executableName, 'Executable override must be a file name.');
assert.ok(executableName.endsWith('.exe'), 'Executable override must name a Windows executable.');
assert.ok(fs.existsSync(path.join(release, executableName)), 'Build the Windows app first.');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-package-rc3-')));
const home = path.join(root, 'home');
const userData = path.join(root, 'electron-data');
const profile = path.join(home, 'profiles/mathmodel');
const logFile = path.join(userData, 'logs/dsh-host.log');
const stateFile = path.join(root, 'state.json');
const markerFile = path.join(profile, SEED_MARKER);
const quitRequest = path.join(userData, 'desktop-quit-request');
const workspace = path.join(root, 'fixture-workspace');
const gitBinary = process.env.DSH_PACKAGE_SMOKE_GIT === '1'
  ? path.resolve(process.env.DSH_PACKAGE_GIT_BIN ?? 'C:/Program Files/Git/cmd/git.exe') : undefined;
const receipts = [];
let currentChild;
let currentHostPid;
let currentRoot;
let currentTree = new Map();
let currentDiagnostics;
let verificationError;

for (const dir of [home, userData, workspace, path.join(home, 'storages'),
  path.join(root, 'roaming'), path.join(root, 'local'), path.join(root, 'os-home'), path.join(root, 'tmp')]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(home, 'hooks.json'), '{}\n');
if (gitBinary) {
  assert.ok(fs.statSync(gitBinary).isFile(), 'Git fixture requires an installed Git executable.');
  fs.writeFileSync(path.join(root, 'gitconfig'), `[core]\n\thooksPath = "${path.join(root, 'git-hooks').replaceAll('\\', '/')}"\n[commit]\n\tgpgSign = false\n`);
  fs.mkdirSync(path.join(root, 'git-hooks'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Git Graph rc3 package fixture\n');
  for (const args of [
    ['init', '--initial-branch=main'], ['add', 'README.md'],
    ['-c', 'user.name=Package Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--no-gpg-sign', '-m', 'Fixture baseline'],
  ]) {
    const result = spawnSync(gitBinary, args, { cwd: workspace, env: isolatedEnv(),
      encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, `Git fixture failed: ${result.stderr}`);
  }
}
const skill = path.join(home, 'skills/package-smoke-card');
fs.mkdirSync(skill, { recursive: true });
fs.writeFileSync(path.join(skill, 'SKILL.md'), `---
name: package-smoke-card
description: Windows 包验证夹具
user-invocable: true
disable-model-invocation: true
---
# 包验证夹具
仅用于验证卡片与草稿，不执行工具或发送消息。
`);
fs.writeFileSync(path.join(skill, 'mathmodel-card.yml'), `schema: dsh.mathmodel.card/v1
skill: package-smoke-card
title: Windows 包验证
summary: 验证完整 Profile 中的卡片和草稿接线
category: test
fields:
  - id: user_notes
    label: 验证内容
    type: text
    required: true
prompt:
  objective: 验证 Windows 包的草稿写入
  instructions: [只生成草稿，不自动发送]
help:
  purpose: 完整 Profile 卡片验证
  inputs: [验证内容]
  outputs: [结构化草稿]
  limits: [不发送消息，不调用模型]
  dependencies: []
`);
const now = new Date().toISOString();
fs.writeFileSync(path.join(home, 'storages/workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['package-fixture'], archivedSessionIds: [] },
  tables: { workspaces: { 'package-fixture': { path: workspace, title: 'package rc3 fixture', sessionIds: [], createdAt: now, updatedAt: now } } },
}));

const ended = child => child.exitCode !== null || child.signalCode !== null;
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function sharedHostFiles(appDir) {
  const hostScope = path.join(appDir, 'resources/runtime/host/node_modules/@deepseek-ai');
  const seedScope = path.join(appDir, 'resources/runtime/profile-web/node_modules/@deepseek-ai');
  const result = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Packaged host must contain physical files.');
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) result[path.relative(hostScope, target)] =
        createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    }
  };
  for (const name of fs.readdirSync(seedScope)) {
    const pkg = path.join(hostScope, name);
    if (fs.existsSync(path.join(pkg, 'package.json'))) walk(pkg);
  }
  assert.ok(Object.keys(result).length > 0, 'No shared host package files found.');
  return result;
}
async function processes() {
  return snapshotProcessFamily([currentChild?.pid, ...currentTree.keys()]);
}
const sameProcess = (left, right) => left && right && left.ProcessId === right.ProcessId &&
  left.ParentProcessId === right.ParentProcessId && left.CreationDate === right.CreationDate;
const bornAfterParent = (child, parent) => {
  const childTime = Date.parse(child.CreationDate);
  const parentTime = Date.parse(parent.CreationDate);
  return Number.isFinite(childTime) && Number.isFinite(parentTime) && childTime >= parentTime;
};
const redactDiagnostics = value => String(value).replace(
  /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s]*/gi, '<loopback-url>');
async function trackOwned() {
  const snapshot = await processes();
  const observedRoot = snapshot.find(item => item.ProcessId === currentChild?.pid);
  if (currentChild && !ended(currentChild) && sameProcess(observedRoot, currentRoot)) {
    const owned = new Map([[currentRoot.ProcessId, currentRoot]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of snapshot) {
        const parent = owned.get(item.ParentProcessId);
        if (parent && !owned.has(item.ProcessId) && bornAfterParent(item, parent)) {
          owned.set(item.ProcessId, item);
          changed = true;
        }
      }
    }
    for (const item of snapshot) {
      if (owned.has(item.ProcessId)) currentTree.set(item.ProcessId, item);
    }
  }
  return snapshot;
}
async function waitUntil(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await pause(500);
  }
  throw new Error(message);
}

function isolatedEnv() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    SystemDrive: path.parse(systemRoot).root.slice(0, -1),
    ComSpec: path.join(systemRoot, 'System32/cmd.exe'),
    PATH: [path.join(systemRoot, 'System32'), systemRoot,
      ...(gitBinary ? [path.dirname(gitBinary)] : [])].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    DSH_HOME: home, DSH_PROFILE: 'mathmodel',
    DSH_DESKTOP_USER_DATA: userData, DSH_DESKTOP_HEADLESS: '1',
    DSH_DESKTOP_VERIFY: '1',
    APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
    USERPROFILE: path.join(root, 'os-home'), HOME: path.join(root, 'os-home'),
    ...(gitBinary ? { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') } : {}),
  };
}

async function start(appDir, phase) {
  fs.rmSync(quitRequest, { force: true });
  const offset = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0;
  const child = spawn(path.join(appDir, executableName), [
    '--enable-automation', '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=127.0.0.1;localhost',
  ], { cwd: home, env: isolatedEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  currentChild = child;
  currentHostPid = undefined;
  currentRoot = undefined;
  currentTree = new Map();
  let stderr = '';
  let launchError;
  currentDiagnostics = () => ({ phase, stderr: redactDiagnostics(stderr),
    log: fs.existsSync(logFile) ? redactDiagnostics(fs.readFileSync(logFile, 'utf8').slice(offset)) : '' });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  child.stdout.on('data', () => {});
  child.on('error', error => { launchError = error; });
  // Await OS inspection asynchronously so the original ChildProcess exit
  // event is delivered before a potentially reused PID is accepted.
  const initial = await processes();
  if (launchError) throw launchError;
  assert.ok(!ended(child), 'App exited before its OS identity was captured.');
  currentRoot = initial.find(item => item.ProcessId === child.pid);
  assert.ok(currentRoot, 'Cannot capture the launched application identity.');
  currentTree.set(child.pid, currentRoot);
  await trackOwned();
  let lastTracked = Date.now();
  const log = await waitUntil(async () => {
    if (launchError) throw launchError;
    const value = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(offset) : '';
    const hostPid = value.match(/\[desktop\] host pid: (\d+)/);
    if (hostPid) currentHostPid = Number(hostPid[1]);
    if (/\[desktop\] boot failed:/.test(value)) throw new Error(`${phase}: ${value}`);
    if (ended(child)) throw new Error(`${phase}: app exited ${child.exitCode ?? child.signalCode}: ${stderr}`);
    if (value.includes('[desktop] GUI loaded') || Date.now() - lastTracked > 10000) {
      await trackOwned();
      lastTracked = Date.now();
    }
    return value.includes('[desktop] GUI loaded') ? value : false;
  // This also includes copying the complete profile before the application's
  // separate 180s host-readiness timer starts.
  }, 1200000, `${phase}: packaged app did not load its GUI. ${stderr}`);
  assert.ok(log.includes(`[desktop] Electron user data: ${userData}`), 'User data escaped the isolated fixture.');
  assert.ok(log.includes(`[desktop] Electron session data: ${userData}`), 'Browser data escaped the isolated fixture.');
  assert.doesNotMatch(log, /plugin degraded|version-gate error|boot failed:|failed to import:|skipping profile bundle|does not provide an export named/i);
  const url = log.match(/dsh web:\s*(http:\/\/[^\s]+)/)?.[1];
  assert.ok(url, 'Host did not print its authenticated loopback URL.');
  const first = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const cookies = first.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const endpoint = new URL('/api/dsh-web-all/degraded', url);
  const response = await fetch(endpoint, { headers: { cookie: cookies }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Full-profile health route returned ${response.status}.`);
  const health = await response.json();
  assert.deepEqual(health.degraded, [], JSON.stringify(health));
  const webFamilyVersion = JSON.parse(fs.readFileSync(path.join(appDir, 'resources/runtime/profile-web/node_modules/@linxin666/dsh-web-all/package.json'), 'utf8')).version;
  const hostClient = await createInstalledHostClient({ logFile });
  let children;
  if (['0.4.11', '0.4.12'].includes(webFamilyVersion)) {
    // 0.4.11 removed /rows; the plugin manager inventory is the family ledger.
    children = activeWebFamilyRows(await hostClient.rpc('pluginManager', 'listPlugins'));
    assert.ok(children, 'Plugin manager inventory is unreadable');
  } else {
    const rowsResponse = await fetch(new URL('/api/dsh-web-all/rows', url), {
      headers: { cookie: cookies }, signal: AbortSignal.timeout(30000),
    });
    assert.equal(rowsResponse.status, 200);
    ({ children } = await rowsResponse.json());
  }
  let capabilityCheck;
  if (process.env.DSH_PACKAGE_SMOKE_CAPABILITIES === '1') {
    const presets = (await hostClient.rpc('agentPresets', 'list')).presets.filter(row => row.id === 'task' || row.id === 'math-workbench');
    assert.deepEqual(presets.map(row => row.id).sort(), ['math-workbench', 'task'], 'Packaged app is missing the task or workbench preset');
    assert.ok(presets.every(row => !row.broken), 'Packaged task preset is broken');
    const registered = await hostClient.rpc('workspace', 'create', { request: { path: workspace } });
    const { sessionId } = await hostClient.rpc('session', 'create', { request: { workspaceId: registered.workspace.workspaceId, agentPreset: 'task' } });
    const preview = await hostClient.rpc('mathmodelHostCapabilities', 'describe', { sessionId });
    await hostClient.rpc('mathmodelHostCapabilities', 'confirm', { sessionId, preset: 'task', hostHash: preview.hostHash });
    const confirmed = await hostClient.rpc('mathmodelHostCapabilities', 'describe', { sessionId });
    assert.equal(confirmed.matches, true);
    assert.equal(confirmed.confirmed.preset, 'task');
    capabilityCheck = { presets: presets.length, confirmed: 'task', matches: true, modelRequestsSent: false };
  }
  const fusionBundle = (await hostClient.rpc('pluginManager', 'listBundles')).find(row => row.name === 'dsh-model-fusion');
  assert.equal(fusionBundle?.enabled, true, 'Fresh package does not select the Fusion bundle');
  const pluginInventory = await hostClient.rpc('pluginManager', 'listPlugins');
  const allPlugins = Array.isArray(pluginInventory) ? pluginInventory : pluginInventory.plugins;
  const fusionRows = allPlugins.filter(row => row.moduleName === 'dsh-model-fusion');
  assert.equal(fusionRows.length, 1, 'Fresh package has missing or duplicate Fusion loaders');
  assert.equal(fusionRows[0].fiberPhase, 'active');
  assert.equal((await hostClient.request('/api/model-fusion?view=settings')).status, 200);
  const permissionCatalog = await hostClient.rpc('permissionPresets', 'catalog', {});
  for (const mode of ['auto', 'sandbox-auto']) {
    assert.ok(permissionCatalog.options.some(row => row.value === mode), `Fresh package is missing permission mode ${mode}`);
  }
  assert.equal(permissionCatalog.defaultPreset, 'workspace-write', 'Package must not enable automatic permissions by default');
  for (const moduleName of ['@deepseek-ai/dsh-experimental-auto-review', '@nanmicoder/dsh-auto-mode']) {
    assert.ok(allPlugins.some(row => row.moduleName === moduleName && row.enabled && row.fiberPhase === 'active'), `Fresh package plugin is inactive: ${moduleName}`);
  }
  if (fs.existsSync(path.join(appDir, 'resources/runtime/kimi-webbridge/kimi-webbridge.exe'))) {
    assert.ok(allPlugins.some(row => row.moduleName === '@dsh-external/dsh-better-browser' && row.enabled && row.fiberPhase === 'active'), 'Kimi browser adapter is not active');
  }
  const expectedRows = ['0.4.11', '0.4.12'].includes(webFamilyVersion)
    // Fresh 0.4.11 defaults: every row active except the opt-in ssh and skill-explorer.
    ? [...WEB_FAMILY_ROWS_0411, '@linxin666/dsh-liangshen']
    : [
      'dsh-client-ui-web-ui-settings', 'dsh-client-ui-plugin-manager',
      'dsh-client-ui-market', 'dsh-client-ui-task-board', 'dsh-client-ui-task-board-github',
      'dsh-client-ui-git-graph', 'dsh-remote-web-ui', 'dsh-update',
      'dsh-usage', 'dsh-session-archive',
      ...(webFamilyVersion === '0.4.7' ? ['dsh-liangshen', 'dsh-win-bash'] : ['dsh-client-ui-model-capabilities']),
    ].map(name => '@linxin666/' + name);
  assert.deepEqual([...children].sort(), expectedRows.sort(), 'Full profile default family rows changed.');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  const scope = path.join(profile, 'node_modules/@deepseek-ai');
  const hostScope = path.join(appDir, 'resources/runtime/host/node_modules/@deepseek-ai');
  let shared = 0;
  for (const name of fs.readdirSync(scope)) {
    const hostPkg = path.join(hostScope, name);
    if (!fs.existsSync(hostPkg)) continue;
    assert.equal(fs.realpathSync.native(path.join(scope, name)), fs.realpathSync.native(hostPkg), `${name} has split module identity.`);
    shared++;
  }
  assert.ok(shared > 0);
  const action = log.match(/\[desktop\] profile action: (\w+)/)?.[1];
  assert.ok(action, 'App did not report its actual profile action.');
  const node = path.join(appDir, 'resources/runtime/node/node.exe');
  const toolVersion = args => {
    const result = spawnSync(node, args, { encoding: 'utf8', windowsHide: true, timeout: 15000,
      cwd: home, env: isolatedEnv() });
    assert.equal(result.status, 0, `Bundled tool failed: ${args.at(-1)}`);
    return result.stdout.trim();
  };
  const receipt = { phase, action, seededAt: marker.seededAt, sharedPackages: shared,
    ...(capabilityCheck ? { capabilityCheck } : {}),
    activeFamilyRows: children.length, degraded: health.degraded.length, fusionBundleEnabled: true, activeFusionRows: fusionRows.length,
    permissionModes: permissionCatalog.options.map(row => row.value), defaultPermission: permissionCatalog.defaultPreset,
    bundledNode: toolVersion(['--version']),
    bundledNpm: toolVersion([path.join(appDir, 'resources/runtime/node/node_modules/npm/bin/npm-cli.js'), '--version']),
    bundledPnpm: toolVersion([path.join(appDir, 'resources/runtime/node/node_modules/pnpm/bin/pnpm.cjs'), '--version']) };
  receipts.push(receipt);
  fs.writeFileSync(stateFile, JSON.stringify({ root, home, profile, userData, url, appPid: child.pid, hostPid: currentHostPid, phase }, null, 2));
  console.log(`${phase}: GUI loaded; ${shared} shared packages; ${children.length} active family rows; 0 degraded plugins; action=${action}`);
  return receipt;
}

async function stop() {
  if (!currentChild) return;
  const child = currentChild;
  const stopOriginalChild = async () => {
    if (!ended(child)) {
      fs.writeFileSync(quitRequest, 'quit\n');
      try {
        await waitUntil(() => ended(child), 10000, 'Original app did not accept graceful quit.');
      } catch {
        if (!ended(child)) child.kill();
      }
    }
    await waitUntil(() => ended(child),
      15000, 'Original application handle did not exit.');
    currentChild = undefined;
    currentHostPid = undefined;
  };
  if (!currentRoot) {
    // Startup may fail before CIM captures an identity. The original process
    // handle can still be closed without trusting or targeting a numeric PID.
    await stopOriginalChild();
    return;
  }
  // Release the GUI and host before starting another OS inspection process.
  if (!ended(child) && sameProcess(currentTree.get(child.pid), currentRoot)) {
    fs.writeFileSync(quitRequest, 'quit\n');
  }
  let snapshot;
  try {
    snapshot = await trackOwned();
  } catch (error) {
    // The original child handle remains safe when OS identity inspection is
    // unavailable; an unverified numeric PID is never used for a tree kill.
    await stopOriginalChild();
    throw error;
  }
  const owned = [...currentTree.values()].filter(item => snapshot.some(candidate => sameProcess(candidate, item)));
  // PIDs printed in logs are diagnostic only; force cleanup uses the actual
  // process tree and rechecks creation times to avoid targeting a reused PID.
  try {
    if (!ended(child) && owned.some(item => sameProcess(item, currentRoot))) {
      fs.writeFileSync(quitRequest, 'quit\n');
    }
    await waitUntil(async () => {
      const remaining = await processes();
      return ended(child) && owned.every(item => !remaining.some(candidate => sameProcess(candidate, item)));
    },
      15000, 'App or owned host did not exit normally.');
  } catch (error) {
    for (const item of owned) {
      const kill = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference="Stop"; try { $ownedProcess=[Diagnostics.Process]::GetProcessById([int]$env:DSH_VERIFY_PID) } catch [ArgumentException] { exit 0 }; try { $null=$ownedProcess.Handle; $born=$ownedProcess.StartTime.ToUniversalTime(); $expected=[DateTimeOffset]::Parse($env:DSH_VERIFY_CREATED).UtcDateTime; if ([Math]::Abs(($born-$expected).TotalMilliseconds) -gt 1) { throw "Process identity changed" }; if (-not $ownedProcess.HasExited) { $ownedProcess.Kill(); $null=$ownedProcess.WaitForExit(5000) } } finally { $ownedProcess.Dispose() }'],
      { windowsHide: true, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, DSH_VERIFY_PID: String(item.ProcessId), DSH_VERIFY_CREATED: item.CreationDate } });
      if (kill.status !== 0) console.error('Owned-process handle cleanup failed:', kill.stderr.trim());
    }
    throw error;
  } finally {
    currentChild = undefined;
    currentHostPid = undefined;
    currentRoot = undefined;
    currentTree = new Map();
  }
}

console.log(`Package verification fixture: ${root}`);
try {
  const originalHost = sharedHostFiles(release);
  const first = await start(release, 'first');
  assert.equal(first.action, 'seed');
  await stop();
  const patch = path.join(profile, 'cordis.patch.yml');
  fs.appendFileSync(patch, '\n# package-smoke-preserve-user-patch\n- id: web-ui-remote-web-ui\n  config:\n    plugin: "@linxin666/dsh-remote-web-ui"\n    config:\n      autoTunnel: false\n      relay: false\n');
  if (gitBinary) fs.appendFileSync(patch, '\n- id: web-ui-git-graph\n  config:\n    plugin: "@linxin666/dsh-client-ui-git-graph"\n    config:\n      autoIsolate: true\n      autoBaseline: current\n      agentTool: false\n');
  const restarted = await start(release, 'restart');
  assert.equal(restarted.action, 'leave');
  assert.equal(restarted.seededAt, first.seededAt);
  await stop();
  assert.deepEqual(sharedHostFiles(release), originalHost, 'Original host changed after seed or restart.');
  const relocated = path.join(root, 'relocated-app');
  assert.ok(path.resolve(relocated).startsWith(root + path.sep));
  fs.cpSync(release, relocated, { recursive: true, dereference: true });
  const moved = await start(relocated, 'relocated');
  assert.equal(moved.action, 'reseed');
  assert.notEqual(moved.seededAt, first.seededAt);
  assert.ok(fs.readFileSync(patch, 'utf8').includes('# package-smoke-preserve-user-patch'));
  assert.deepEqual(sharedHostFiles(release), originalHost, 'Relocation changed the original host packages.');
  if (process.env.DSH_PACKAGE_SMOKE_HOLD === '1') {
    console.log(`BROWSER_READY state=${stateFile}`);
    await waitUntil(() => fs.existsSync(path.join(root, 'finish-browser-check')), 1800000, 'Browser verification was not completed.');
  }
  await stop();
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({ ok: true, receipts,
    originalHostPreserved: true, originalHostFiles: Object.keys(originalHost).length }, null, 2));
  console.log(`Package verification passed: ${path.join(root, 'receipt.json')}`);
} catch (error) {
  verificationError = error;
  try {
    fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({
      error: redactDiagnostics(error.stack ?? error), ...currentDiagnostics?.(),
    }, null, 2));
  } catch (diagnosticError) {
    console.error('Could not save failure diagnostics:', diagnosticError);
  }
  throw error;
} finally {
  try {
    try {
      await stop();
    } catch (cleanupError) {
      if (!verificationError) throw cleanupError;
      console.error('Additional cleanup failure:', cleanupError);
    }
  } finally {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      delete state.url;
      delete state.appPid;
      delete state.hostPid;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    }
  }
}
