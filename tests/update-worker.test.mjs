import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { transact, pinOldProcess, treeDigest, treeDigestAsync, stopOrphanedUpdateHosts } = require('../src/update-worker.cjs');
const { prepareRollback } = require('../src/desktop-updates.cjs');

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-update-worker-')));
  const installDir = path.join(root, 'application');
  const candidateDir = path.join(root, 'stage');
  const userDataDir = path.join(root, 'user-data');
  const stateDir = path.join(userDataDir, 'desktop-updates');
  for (const dir of [installDir, candidateDir, stateDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'app.exe'), 'MZold');
  fs.writeFileSync(path.join(installDir, 'identity.txt'), 'old release');
  fs.writeFileSync(path.join(candidateDir, 'app.exe'), 'MZnew');
  fs.writeFileSync(path.join(candidateDir, 'identity.txt'), 'new release');
  const nonce = '4da8df08-1ed9-489d-97c7-8d568ebf3eac';
  const jobPath = path.join(stateDir, `${nonce}.job.json`);
  const job = { schema: 'dsh.desktop-update-job/v1', nonce, kind: 'update', state: 'prepared',
    appId: 'com.deepseek.harness.mathmodel', fromVersion: '0.1.0', toVersion: '0.1.1',
    executableName: 'app.exe', packageName: 'dsh-mathmodel-desktop', installDir,
    previousDir: path.join(root, 'previous'), candidateDir, extractionDir: candidateDir,
    userDataDir, jobPath, bootMarker: `${jobPath}.boot-ok`, workerReady: `${jobPath}.worker-ready`,
    candidateSha256: treeDigest(candidateDir) };
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const appScript = path.join(root, 'fake-app.cjs');
  fs.writeFileSync(appScript, `const fs=require('fs');
if(process.env.DSH_DESKTOP_UPDATE_JOB){
 const job=JSON.parse(fs.readFileSync(process.env.DSH_DESKTOP_UPDATE_JOB));
 if(process.env.DSH_TEST_BOOT_FAIL==='1') process.exit(7);
 fs.writeFileSync(job.bootMarker,JSON.stringify({nonce:job.nonce,pid:process.pid}),{flag:'wx'});
}
setInterval(()=>{},1000);
`);
  const children = [];
  const launchApp = (_file, _args, options) => {
    const child = spawn(process.execPath, [appScript], options);
    children.push(child);
    return child;
  };
  const cleanup = async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    const physical = fs.realpathSync.native(root);
    assert.equal(physical, root);
    const physicalTmp = fs.realpathSync.native(os.tmpdir());
    assert.equal(path.dirname(root).toLowerCase(), physicalTmp.toLowerCase());
    assert.ok(path.basename(root).startsWith('dsh-desktop-update-worker-'));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, job, launchApp, cleanup };
}

test('worker pins the original process handle until exit', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const pinned = pinOldProcess(child.pid);
    assert.match(await pinned.ready, /^\d+$/);
    child.kill();
    await pinned.exited;
  } finally { if (child.exitCode === null) child.kill(); }
});

test('concurrent tree hashing preserves the digest and rejects directory junctions', async () => {
  const f = fixture();
  const link = path.join(f.job.candidateDir, 'linked-old-release');
  try {
    fs.mkdirSync(path.join(f.job.candidateDir, '中文目录'));
    fs.writeFileSync(path.join(f.job.candidateDir, '中文目录/empty.txt'), '');
    fs.writeFileSync(path.join(f.job.candidateDir, '中文目录/bulk.bin'), Buffer.alloc(3 * 1024 * 1024, 9));
    assert.equal(await treeDigestAsync(f.job.candidateDir), treeDigest(f.job.candidateDir));
    fs.symlinkSync(f.job.installDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(treeDigestAsync(f.job.candidateDir), /reparse|special/);
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    await f.cleanup();
  }
});

test('bootstrap success never publishes ordinary rollback records', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  f.job.bootstrap = true;
  try {
    const outcome = await transact(f.job, process.pid, 'fixture', Promise.resolve(),
      { launchApp: f.launchApp, bootTimeoutMs: 3000 });
    assert.equal(outcome.state, 'succeeded');
    assert.equal(JSON.parse(fs.readFileSync(f.job.jobPath)).state, 'succeeded');
    for (const name of ['last-update.json', 'last-successful-update.json']) {
      assert.equal(fs.existsSync(path.join(path.dirname(f.job.jobPath), name)), false);
    }
  } finally { await f.cleanup(); }
});

test('last bootstrap idle gate aborts before swap, recovery or data changes', async () => {
  const f = fixture();
  let launched = false;
  try {
    await assert.rejects(transact(f.job, process.pid, 'fixture', Promise.resolve(), {
      beforeSwap: () => { throw new Error('legacy application became active'); },
      launchApp: () => { launched = true; throw new Error('must not launch'); },
    }), /became active/);
    assert.equal(launched, false);
    assert.equal(fs.readFileSync(path.join(f.job.installDir, 'identity.txt'), 'utf8'), 'old release');
    assert.equal(fs.existsSync(f.job.previousDir), false);
    assert.equal(fs.readFileSync(path.join(f.job.candidateDir, 'identity.txt'), 'utf8'), 'new release');
  } finally { await f.cleanup(); }
});

test('bootstrap rename rejection never launches recovery into live legacy data', async t => {
  const f = fixture();
  f.job.bootstrap = true;
  const originalRename = fs.renameSync;
  let launched = false;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (source === f.job.installDir) throw new Error('legacy application acquired a file lock');
    return originalRename(source, target);
  });
  try {
    const outcome = await transact(f.job, process.pid, 'fixture', Promise.resolve(), {
      beforeSwap: () => {}, launchApp: () => { launched = true; throw new Error('must not launch'); },
    });
    assert.equal(outcome.state, 'aborted');
    assert.match(outcome.error, /file lock/);
    assert.equal(launched, false);
    assert.equal(fs.readFileSync(path.join(f.job.installDir, 'identity.txt'), 'utf8'), 'old release');
    assert.equal(fs.existsSync(f.job.previousDir), false);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('whole-tree update preserves old release and records healthy new boot', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const outcome = await transact(f.job, process.pid, 'fixture', Promise.resolve(),
      { launchApp: f.launchApp, bootTimeoutMs: 3000 });
    assert.equal(outcome.state, 'succeeded');
    assert.equal(fs.readFileSync(path.join(f.job.installDir, 'identity.txt'), 'utf8'), 'new release');
    assert.equal(fs.readFileSync(path.join(f.job.previousDir, 'identity.txt'), 'utf8'), 'old release');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'user-data/desktop-updates/last-update.json'))).state, 'succeeded');
  } finally { await f.cleanup(); }
});

test('failed new boot restores old release and removes new-only tree', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  process.env.DSH_TEST_BOOT_FAIL = '1';
  try {
    const outcome = await transact(f.job, process.pid, 'fixture', Promise.resolve(),
      { launchApp: f.launchApp, bootTimeoutMs: 3000 });
    assert.equal(outcome.state, 'rolled-back');
    assert.equal(fs.readFileSync(path.join(f.job.installDir, 'identity.txt'), 'utf8'), 'old release');
    assert.equal(fs.existsSync(f.job.previousDir), false);
    assert.equal(fs.existsSync(path.join(f.root, `.dsh-failed-${f.job.nonce}`)), false);
  } finally { delete process.env.DSH_TEST_BOOT_FAIL; await f.cleanup(); }
});

test('failed-tree cleanup cannot overwrite a newer transaction status', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture();
  const globalRecord = path.join(f.job.userDataDir, 'desktop-updates/last-update.json');
  const next = { nonce: randomUUID(), state: 'succeeded' };
  const originalRemove = fs.rmSync;
  let published = false;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === path.join(f.root, `.dsh-failed-${f.job.nonce}`)) {
      assert.equal(JSON.parse(fs.readFileSync(globalRecord)).nonce, f.job.nonce);
      fs.writeFileSync(globalRecord, JSON.stringify(next));
      published = true;
    }
    return originalRemove(target, options);
  });
  process.env.DSH_TEST_BOOT_FAIL = '1';
  try {
    const outcome = await transact(f.job, process.pid, 'fixture', Promise.resolve(),
      { launchApp: f.launchApp, bootTimeoutMs: 3000 });
    assert.equal(published, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(globalRecord)), next);
    assert.equal(outcome.state, 'rolled-back');
    const finalJob = JSON.parse(fs.readFileSync(f.job.jobPath));
    assert.equal(finalJob.state, 'rolled-back');
    assert.equal(finalJob.failedDir, undefined);
  } finally { delete process.env.DSH_TEST_BOOT_FAIL; t.mock.restoreAll(); await f.cleanup(); }
});

test('signal-terminated new process restores the old app without a recovery failure', async () => {
  const f = fixture();
  try {
    const outcome = await transact(f.job, process.pid, 'fixture', Promise.resolve(), {
      bootTimeoutMs: 10000,
      launchApp: (file, args, options) => {
        if (!options.env.DSH_DESKTOP_UPDATE_JOB) return f.launchApp(file, args, options);
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
        child.once('spawn', () => setTimeout(() => child.kill(), 50));
        return child;
      },
    });
    assert.equal(outcome.state, 'rolled-back');
    assert.match(outcome.error, /before boot/);
    assert.equal(outcome.recoveryError, undefined);
    assert.equal(fs.readFileSync(path.join(f.job.installDir, 'identity.txt'), 'utf8'), 'old release');
    assert.ok(outcome.restartedOldPid > 0);
  } finally { await f.cleanup(); }
});

test('orphan host cleanup stops only the tagged direct child with a matching executable', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const runtime = path.join(f.job.installDir, 'resources/runtime/node');
  fs.mkdirSync(runtime, { recursive: true });
  const copiedNode = path.join(runtime, 'node.exe');
  fs.copyFileSync(process.execPath, copiedNode);
  const record = path.join(f.root, 'orphan-pids.json');
  const parentScript = path.join(f.root, 'spawn-orphans.cjs');
  fs.writeFileSync(parentScript, `const fs=require('fs'),{spawn}=require('child_process');
const node=process.argv[2], nonce=process.argv[3], record=process.argv[4];
const tagged=spawn(node,['--title=dsh-desktop-update-host-'+nonce,'-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
const other=spawn(node,['--title=unrelated-host-'+nonce,'-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(record,JSON.stringify({tagged:tagged.pid,other:other.pid}));
setTimeout(()=>process.exit(7),250);
`);
  const started = Date.now();
  const parent = spawn(process.execPath, [parentScript, copiedNode, f.job.nonce, record], { stdio: 'ignore' });
  let pids;
  try {
    await new Promise((resolve, reject) => { parent.once('exit', resolve); parent.once('error', reject); });
    pids = JSON.parse(fs.readFileSync(record, 'utf8'));
    const stopped = await stopOrphanedUpdateHosts(f.job, parent.pid, started, Date.now());
    assert.deepEqual(stopped, [pids.tagged]);
    assert.throws(() => process.kill(pids.tagged, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(pids.other, 0));
  } finally {
    for (const pid of [pids?.tagged, pids?.other]) if (pid) try { process.kill(pid); } catch {}
    if (parent.exitCode === null) parent.kill();
    await f.cleanup();
  }
});

test('crashed updated desktop with a mapped tagged Node host restores the old release', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const runtime = path.join(f.job.candidateDir, 'resources/runtime/node');
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
  f.job.candidateSha256 = treeDigest(f.job.candidateDir);
  fs.writeFileSync(f.job.jobPath, JSON.stringify(f.job));
  const parentScript = path.join(f.root, 'spawn-tagged-then-crash.cjs');
  const ready = path.join(f.root, 'tagged-host-ready');
  fs.writeFileSync(parentScript, `const {spawn}=require('child_process'),path=require('path'),fs=require('fs');
const node=path.join(process.env.DSH_TEST_INSTALL_DIR,'resources/runtime/node/node.exe');
const ready=process.argv[2];
const child=spawn(node,['--title=dsh-desktop-update-host-'+process.env.DSH_DESKTOP_UPDATE_NONCE,'-e',
  'require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',ready],{detached:true,stdio:'ignore'});
child.once('error',()=>process.exit(8));
const timer=setInterval(()=>{if(fs.existsSync(ready)&&Number(fs.readFileSync(ready,'utf8'))===child.pid){clearInterval(timer);process.exit(7)}},20);
setTimeout(()=>process.exit(8),15000).unref();
`);
  try {
    const outcome = await transact(f.job, process.pid, 'fixture', Promise.resolve(), {
      bootTimeoutMs: 20000,
      launchApp: (file, args, options) => options.env.DSH_DESKTOP_UPDATE_JOB
        ? spawn(process.execPath, [parentScript, ready], { ...options, env: { ...options.env, DSH_TEST_INSTALL_DIR: f.job.installDir } })
        : f.launchApp(file, args, options),
    });
    assert.equal(outcome.state, 'rolled-back');
    assert.ok(fs.existsSync(ready), 'tagged host never completed its startup handshake');
    assert.equal(outcome.stoppedOrphanHostPids.length, 1);
    assert.equal(fs.readFileSync(path.join(f.job.installDir, 'identity.txt'), 'utf8'), 'old release');
    assert.equal(fs.existsSync(f.job.previousDir), false);
  } finally { await f.cleanup(); }
});

test('consecutive failed boots use distinct cooperative quit requests and restore twice', async () => {
  const f = fixture(), updated = [];
  const stale = path.join(f.job.userDataDir, 'desktop-update-quit-request');
  fs.writeFileSync(stale, 'legacy stale request');
  const script = path.join(f.root, 'cooperative-failed-app.cjs');
  fs.writeFileSync(script, `const fs=require('fs'),path=require('path');
const job=JSON.parse(fs.readFileSync(process.env.DSH_DESKTOP_UPDATE_JOB));
const request=path.join(job.userDataDir,'desktop-update-quit-'+job.nonce+'.json');
setInterval(()=>{try{const value=JSON.parse(fs.readFileSync(request));
 if(value.nonce===job.nonce&&value.pid===process.pid)process.exit(0)}catch{}},20);
`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const job = { ...f.job };
      if (attempt) {
        job.nonce = randomUUID(); job.candidateDir = path.join(f.root, 'second-stage');
        fs.mkdirSync(job.candidateDir);
        fs.writeFileSync(path.join(job.candidateDir, 'app.exe'), 'MZsecond');
        job.previousDir = path.join(f.root, 'second-previous');
        job.jobPath = path.join(f.job.userDataDir, 'desktop-updates', job.nonce + '.job.json');
        job.bootMarker = job.jobPath + '.boot-ok'; job.workerReady = job.jobPath + '.worker-ready';
        job.candidateSha256 = treeDigest(job.candidateDir);
        fs.writeFileSync(job.jobPath, JSON.stringify(job));
      }
      const result = await transact(job, process.pid, 'fixture', Promise.resolve(), {
        bootTimeoutMs: 250,
        launchApp: (file, args, options) => {
          if (!options.env.DSH_DESKTOP_UPDATE_JOB) return f.launchApp(file, args, options);
          const child = spawn(process.execPath, [script], options); updated.push(child); return child;
        },
      });
      assert.equal(result.state, 'rolled-back');
      assert.equal(updated.at(-1).exitCode, 0);
      assert.equal(updated.at(-1).signalCode, null);
      assert.equal(fs.existsSync(path.join(f.job.userDataDir, `desktop-update-quit-${job.nonce}.json`)), false);
      assert.equal(fs.readFileSync(path.join(f.job.installDir, 'identity.txt'), 'utf8'), 'old release');
    }
    assert.equal(fs.readFileSync(stale, 'utf8'), 'legacy stale request');
  } finally {
    for (const child of updated) if (child.exitCode === null && child.signalCode === null) child.kill();
    await f.cleanup();
  }
});

test('stage changed after readiness restarts the intact old app', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const oldExited = new Promise(resolve => setTimeout(() => {
      fs.writeFileSync(path.join(f.job.candidateDir, 'identity.txt'), 'changed after READY');
      resolve();
    }, 100));
    const outcome = await transact(f.job, process.pid, 'fixture', oldExited, { launchApp: f.launchApp });
    assert.equal(outcome.state, 'rolled-back');
    assert.match(outcome.error, /changed while waiting/);
    assert.equal(fs.readFileSync(path.join(f.job.installDir, 'identity.txt'), 'utf8'), 'old release');
    assert.equal(fs.existsSync(f.job.previousDir), false);
    assert.ok(outcome.restartedOldPid > 0);
  } finally { await f.cleanup(); }
});

test('manual rollback retains the last successful backup after a failed attempt and rejects tampering', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    await transact(f.job, process.pid, 'fixture', Promise.resolve(), { launchApp: f.launchApp, bootTimeoutMs: 3000 });
    fs.writeFileSync(path.join(f.root, 'user-data/desktop-updates/last-update.json'), JSON.stringify({ state: 'rolled-back' }));
    await assert.rejects(prepareRollback({ installDir: f.job.installDir, executableName: 'app.exe',
      userDataDir: f.job.userDataDir, currentVersion: '0.1.3' }), /Current desktop version/);
    const restored = await prepareRollback({ installDir: f.job.installDir, executableName: 'app.exe', userDataDir: f.job.userDataDir, currentVersion: '0.1.1' });
    assert.equal(restored.kind, 'rollback');
    assert.equal(restored.toVersion, '0.1.0');
    const record = path.join(f.job.userDataDir, 'desktop-updates/last-successful-update.json');
    const saved = fs.readFileSync(record);
    fs.writeFileSync(record, '{corrupt record');
    await assert.rejects(prepareRollback({ installDir: f.job.installDir, executableName: 'app.exe',
      userDataDir: f.job.userDataDir, currentVersion: '0.1.1' }), /Cannot read last successful update/);
    fs.writeFileSync(record, saved);
    fs.writeFileSync(path.join(f.job.previousDir, 'identity.txt'), 'changed backup');
    await assert.rejects(prepareRollback({ installDir: f.job.installDir, executableName: 'app.exe', userDataDir: f.job.userDataDir, currentVersion: '0.1.1' }), /changed/);
  } finally { await f.cleanup(); }
});
