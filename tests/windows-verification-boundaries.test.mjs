import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { snapshotProcessFamily } from '../scripts/windows-processes.mjs';
import { assertOwnedDirectory, runOwn } from '../scripts/verify-windows-install.mjs';
test('stdout inspection errors reject after the original child finishes its cleanup', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-run-own-')));
  const marker = path.join(root, 'child-cleaned.txt');
  try {
    const script = "process.stdout.write('unexpected fixture\\n');setTimeout(()=>require('fs').writeFileSync(process.argv[1],'cleaned'),50);";
    await assert.rejects(runOwn(process.execPath, ['-e', script, marker], 10000, 'callback regression',
      process.env, false, () => { throw new Error('fixture inspection rejected'); }), /fixture inspection rejected/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'cleaned');
  } finally {
    assert.equal(fs.realpathSync.native(root), root);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    fs.rmdirSync(root);
  }
});
test('created Windows AppData directory keeps its pinned identity across package virtualization', t => {
  if (process.platform !== 'win32') return t.skip('Requires Windows shell folders');
  const folder = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('ApplicationData')"],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(folder.status, 0, folder.stderr);
  const root = folder.stdout.trim();
  const created = fs.mkdtempSync(path.join(root, 'dsh-owned-path-'));
  const pin = fs.realpathSync.native(created);
  t.after(() => {
    assertOwnedDirectory(root, created, pin);
    assert.deepEqual(fs.readdirSync(created), []);
    fs.rmdirSync(created);
  });
  assertOwnedDirectory(root, created, pin);
  assert.throws(() => assertOwnedDirectory(root, created, fs.realpathSync.native(root)), /identity/);
});
test('OS snapshot returns a launched process family without unrelated processes', async t => {
  if (process.platform !== 'win32') return t.skip('Requires Windows process identities');
  const script = "const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',windowsHide:true});console.log(child.pid);process.stdin.once('data',()=>{child.kill();child.once('exit',()=>process.exit(0));});";
  const parent = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const data = await once(parent.stdout, 'data');
    const grandchild = Number(data[0].toString().trim());
    assert.ok(Number.isSafeInteger(grandchild));
    const snapshot = await snapshotProcessFamily([parent.pid]);
    const observed = snapshot.find(item => item.ProcessId === parent.pid);
    const leaf = snapshot.find(item => item.ProcessId === grandchild);
    assert.ok(observed && observed.CreationDate);
    assert.ok(Number.isFinite(Date.parse(observed.CreationDate)));
    assert.equal(leaf.ParentProcessId, parent.pid);
    assert.equal(snapshot.some(item => item.ProcessId === process.pid), false);
    const repeated = await snapshotProcessFamily([parent.pid, grandchild]);
    assert.equal(repeated.find(item => item.ProcessId === parent.pid)?.CreationDate, observed.CreationDate);
    assert.equal(repeated.find(item => item.ProcessId === grandchild)?.CreationDate, leaf.CreationDate);
  } finally {
    const closed = once(parent, 'exit');
    parent.stdin.end('quit\n');
    const timer = setTimeout(() => parent.kill(), 5000);
    await closed;
    clearTimeout(timer);
  }
});
