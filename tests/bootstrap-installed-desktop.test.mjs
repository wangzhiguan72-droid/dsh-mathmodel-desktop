import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { runBootstrap, releaseFiles } from '../scripts/bootstrap-installed-desktop.mjs';

const asar = createRequire(import.meta.url)('@electron/asar');
const worker = createRequire(import.meta.url)('../src/update-worker.cjs');
const { assertUpdateBootSafe } = createRequire(import.meta.url)('../src/update-boot-safety.cjs');

function writeSessionFormat(root, version) {
  const filename = path.join(root, 'resources', 'runtime', 'host', 'node_modules',
    '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `const SESSION_FORMAT_VERSION = ${version};\n`);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-cli-'));
  const paths = Object.fromEntries(['application', 'release', 'home', 'user-data', 'backups']
    .map(name => [name, path.join(root, name)]));
  for (const dir of Object.values(paths)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(paths.application, 'desktop.exe'), 'MZold');
  fs.writeFileSync(path.join(paths.application, 'old.txt'), 'legacy release');
  fs.writeFileSync(path.join(paths.home, 'private.txt'), 'original home');
  fs.writeFileSync(path.join(paths['user-data'], 'window.txt'), 'original window');
  const args = { 'install-dir': paths.application, 'release-dir': paths.release,
    'dsh-home': paths.home, 'user-data-dir': paths['user-data'], 'backup-root': paths.backups };
  const identity = () => ({ executableName: 'desktop.exe', metadata: { version: '0.1.0' } });
  const release = () => ({ zip: { entry: path.join(paths.release, 'release.zip'), sha256: 'a'.repeat(64) },
    nsis: { entry: path.join(paths.release, 'release.exe'), sha256: 'b'.repeat(64) } });
  const prepareStage = stage => {
    fs.writeFileSync(path.join(stage, 'desktop.exe'), 'MZnew');
    fs.writeFileSync(path.join(stage, 'new.txt'), 'release 0.1.1');
    return { name: 'Uninstall Desktop.exe', sha256: 'c'.repeat(64) };
  };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, paths, args, identity, release, prepareStage, cleanup };
}

test('read-only bootstrap plan and active-app gate leave installation and data alone', async () => {
  const f = setup();
  try {
    const dependencies = { identity: f.identity, release: f.release, activeProcesses: () => [] };
    const plan = await runBootstrap(f.args, dependencies);
    assert.equal(plan.mode, 'plan');
    assert.equal(fs.readFileSync(path.join(f.paths.application, 'old.txt'), 'utf8'), 'legacy release');
    assert.deepEqual(fs.readdirSync(f.paths.backups), []);
    await assert.rejects(runBootstrap({ ...f.args, apply: true }, {
      ...dependencies, activeProcesses: () => [{ ProcessId: 1234 }], prepareStage: f.prepareStage,
    }), /process family is active/);
    assert.deepEqual(fs.readdirSync(f.paths.backups), []);
    assert.equal(fs.existsSync(path.join(f.paths['user-data'], 'desktop-updates')), false);
  } finally { f.cleanup(); }
});

test('bootstrap identity reads the current archive after replacement at the same path', async () => {
  const f = setup();
  const archive = path.join(f.paths.application, 'resources', 'app.asar');
  try {
    fs.mkdirSync(path.dirname(archive));
    const makeArchive = async (version, output) => {
      const source = path.join(f.root, `source-${version}`);
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
        name: 'dsh-mathmodel-desktop', version, main: 'src/main.cjs',
      }));
      if (version === '0.1.1') fs.writeFileSync(path.join(source, '000-legacy-metadata.json'), JSON.stringify({
        name: 'dsh-mathmodel-desktop', version: '0.1.0', main: 'src/main.cjs',
      }));
      await asar.createPackage(source, output);
    };
    await makeArchive('0.1.0', archive);
    const dependencies = { allowNonWindows: true, release: f.release, activeProcesses: () => [] };
    assert.equal((await runBootstrap(f.args, dependencies)).fromVersion, '0.1.0');
    const replacement = path.join(f.root, 'new.asar');
    await makeArchive('0.1.1', replacement);
    fs.copyFileSync(replacement, archive);
    await assert.rejects(runBootstrap(f.args, dependencies), /accepts the installed desktop 0\.1\.0 only/);
    assert.deepEqual(fs.readdirSync(f.paths.backups), []);
    assert.equal(fs.readFileSync(path.join(f.paths.application, 'old.txt'), 'utf8'), 'legacy release');
  } finally { asar.uncache(archive); f.cleanup(); }
});

test('tampered release artifact fails receipt verification before installation or data writes', async () => {
  const f = setup();
  try {
    const names = ['dsh-mathmodel-desktop-0.1.3-win-x64.zip', 'dsh-mathmodel-desktop-0.1.3-win-x64.exe'];
    const receipts = {};
    for (const name of names) {
      const bytes = Buffer.alloc(1000001, name.endsWith('.zip') ? 31 : 47);
      fs.writeFileSync(path.join(f.paths.release, name), bytes);
      receipts[name] = createHash('sha256').update(bytes).digest('hex');
    }
    fs.writeFileSync(path.join(f.paths.release, 'verification.json'), JSON.stringify({ ok: true,
      unpackedFiles: 43557, zipAllFiles: 43557, artifactSha256: receipts }));
    fs.writeFileSync(path.join(f.paths.release, 'SHA256SUMS.txt'), names.map(name => `${receipts[name]}  ${name}`).join('\n'));
    assert.equal(releaseFiles(f.paths.release).zip.sha256, receipts[names[0]]);
    fs.appendFileSync(path.join(f.paths.release, names[0]), 'tampering');
    await assert.rejects(runBootstrap({ ...f.args, apply: true }, {
      identity: f.identity, activeProcesses: () => [], prepareStage: f.prepareStage,
    }), /SHA-256 mismatch/);
    assert.deepEqual(fs.readdirSync(f.paths.backups), []);
    assert.equal(fs.existsSync(path.join(f.paths['user-data'], 'desktop-updates')), false);
    assert.equal(fs.readFileSync(path.join(f.paths.application, 'old.txt'), 'utf8'), 'legacy release');
  } finally { f.cleanup(); }
});

test('desktop opened during long preparation stops replacement and retains verified backup', async () => {
  const f = setup();
  let checks = 0;
  try {
    await assert.rejects(runBootstrap({ ...f.args, apply: true }, {
      identity: f.identity, release: f.release, prepareStage: f.prepareStage,
      activeProcesses: () => (++checks === 1 ? [] : [{ ProcessId: 5678 }]),
    }), /became active before replacement/);
    assert.equal(checks, 2);
    assert.equal(fs.readFileSync(path.join(f.paths.application, 'old.txt'), 'utf8'), 'legacy release');
    assert.equal(fs.readFileSync(path.join(f.paths.home, 'private.txt'), 'utf8'), 'original home');
    assert.equal(fs.readdirSync(f.paths.backups).length, 1);
    assert.ok(fs.readdirSync(f.root).some(name => name.startsWith('.dsh-stage-')));
  } finally { f.cleanup(); }
});

test('session changed after snapshot aborts before swap without launching either application', async () => {
  const f = setup();
  let checks = 0, launches = 0;
  try {
    await assert.rejects(runBootstrap({ ...f.args, apply: true }, {
      identity: f.identity, release: f.release, prepareStage: f.prepareStage,
      activeProcesses: () => {
        checks++;
        if (checks === 2) fs.writeFileSync(path.join(f.paths.home, 'private.txt'), 'new session after backup');
        return [];
      },
      launchApp: () => { launches++; throw new Error('Launch must not occur'); },
    }), /data changed after bootstrap snapshot/);
    assert.equal(checks, 2);
    assert.equal(launches, 0);
    assert.equal(fs.readFileSync(path.join(f.paths.application, 'old.txt'), 'utf8'), 'legacy release');
    assert.equal(fs.readFileSync(path.join(f.paths.home, 'private.txt'), 'utf8'), 'new session after backup');
    assert.equal(fs.readdirSync(f.paths.backups).length, 1);
  } finally { f.cleanup(); }
});

test('direct V3 to V4 bootstrap supplies a verified snapshot to the new boot guard', async t => {
  const f = setup();
  try {
    writeSessionFormat(f.paths.application, 3);
    t.mock.method(worker, 'transact', async job => {
      assert.equal(job.homeDir, f.paths.home);
      assert.equal(job.sessionFormatFrom, 3);
      assert.equal(job.sessionFormatTo, 4);
      assert.equal(job.dataSnapshot.nonce, job.nonce);
      assert.equal(job.dataSnapshot.home, f.paths.home);
      assert.equal(job.dataSnapshot.userData, f.paths['user-data']);
      assert.ok(fs.existsSync(path.join(job.dataSnapshot.backup, 'snapshot.json')));
      fs.renameSync(job.installDir, job.previousDir);
      fs.renameSync(job.candidateDir, job.installDir);
      const boot = { jobPath: job.jobPath, nonce: job.nonce, installDir: job.installDir,
        userDataDir: f.paths['user-data'], homeDir: f.paths.home, version: '0.1.3' };
      assert.doesNotThrow(() => assertUpdateBootSafe(boot));
      const altered = { ...job, dataSnapshot: undefined };
      fs.writeFileSync(job.jobPath, JSON.stringify(altered));
      assert.throws(() => assertUpdateBootSafe(boot), /snapshot identity mismatch/);
      return { ...job, state: 'aborted' };
    });
    const result = await runBootstrap({ ...f.args, apply: true }, {
      allowNonWindows: true, identity: f.identity, release: f.release,
      activeProcesses: () => [],
      prepareStage: stage => {
        const uninstaller = f.prepareStage(stage);
        writeSessionFormat(stage, 4);
        return uninstaller;
      },
    });
    assert.equal(result.state, 'aborted');
  } finally { t.mock.restoreAll(); f.cleanup(); }
});

test('failed new boot restores private data before launching the legacy desktop despite busy cleanup', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(), children = [];
  const originalUnlink = fs.unlinkSync;
  let observed;
  try {
    t.mock.method(fs, 'unlinkSync', filename => {
      if (filename.startsWith(f.paths.home + '.dsh-displaced-') && path.basename(filename) === 'private.txt') {
        throw Object.assign(new Error('old home file held open'), { code: 'EBUSY' });
      }
      return originalUnlink(filename);
    });
    const result = await runBootstrap({ ...f.args, apply: true }, {
      identity: f.identity, release: f.release, activeProcesses: () => [], prepareStage: f.prepareStage,
      bootTimeoutMs: 1000,
      launchApp: (_file, _argv, options) => {
        if (options.env.DSH_DESKTOP_UPDATE_JOB) {
          fs.writeFileSync(path.join(f.paths.home, 'private.txt'), 'new app mutation');
          fs.writeFileSync(path.join(f.paths['user-data'], 'window.txt'), 'new app mutation');
          const child = spawn(process.execPath, ['-e', 'process.exit(7)'], options); children.push(child); return child;
        }
        observed = {
          home: fs.readFileSync(path.join(f.paths.home, 'private.txt'), 'utf8'),
          userData: fs.readFileSync(path.join(f.paths['user-data'], 'window.txt'), 'utf8'),
          oldApp: fs.readFileSync(path.join(f.paths.application, 'old.txt'), 'utf8'),
        };
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options); children.push(child); return child;
      },
    });
    assert.equal(result.state, 'rolled-back');
    assert.deepEqual(observed, { home: 'original home', userData: 'original window', oldApp: 'legacy release' });
    assert.equal(fs.existsSync(path.join(f.paths.application, 'new.txt')), false);
    assert.ok(fs.existsSync(path.join(result.backup, 'snapshot.json')));
    assert.equal(result.restoreCleanup.retainedPaths.length, 1);
    assert.ok(result.restoreCleanup.retainedPaths[0].startsWith(f.paths.home + '.dsh-displaced-'));
  } finally {
    t.mock.restoreAll();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise(resolve => setTimeout(resolve, 150));
    f.cleanup();
  }
});

test('failed user-data restore blocks legacy relaunch and retains the private backup', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(), children = [];
  const originalRename = fs.renameSync;
  let legacyLaunches = 0;
  try {
    t.mock.method(fs, 'renameSync', (source, destination) => {
      if (source.startsWith(f.paths['user-data'] + '.dsh-restore-') && destination === f.paths['user-data']) {
        throw Object.assign(new Error('user data rename blocked'), { code: 'EACCES' });
      }
      return originalRename(source, destination);
    });
    await assert.rejects(runBootstrap({ ...f.args, apply: true }, {
      identity: f.identity, release: f.release, activeProcesses: () => [], prepareStage: f.prepareStage,
      bootTimeoutMs: 1000,
      launchApp: (_file, _argv, options) => {
        if (!options.env.DSH_DESKTOP_UPDATE_JOB) { legacyLaunches++; throw new Error('Legacy launch must not occur'); }
        fs.writeFileSync(path.join(f.paths.home, 'private.txt'), 'new app mutation');
        fs.writeFileSync(path.join(f.paths['user-data'], 'window.txt'), 'new app mutation');
        const child = spawn(process.execPath, ['-e', 'process.exit(7)'], options); children.push(child); return child;
      },
    }), /user data rename blocked/);
    assert.equal(legacyLaunches, 0);
    assert.equal(fs.readFileSync(path.join(f.paths.application, 'old.txt'), 'utf8'), 'legacy release');
    assert.equal(fs.readFileSync(path.join(f.paths.home, 'private.txt'), 'utf8'), 'new app mutation');
    assert.equal(fs.readFileSync(path.join(f.paths['user-data'], 'window.txt'), 'utf8'), 'new app mutation');
    assert.equal(fs.readdirSync(f.paths.backups).length, 1);
  } finally {
    t.mock.restoreAll();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise(resolve => setTimeout(resolve, 150));
    f.cleanup();
  }
});

test('healthy bootstrap archives its own transaction and excludes legacy rollback from menu state', { skip: process.platform !== 'win32' }, async () => {
  const f = setup(), children = [];
  try {
    const script = path.join(f.root, 'healthy-app.cjs');
    fs.writeFileSync(script, `const fs=require('fs'); const job=JSON.parse(fs.readFileSync(process.env.DSH_DESKTOP_UPDATE_JOB)); fs.writeFileSync(job.bootMarker,JSON.stringify({nonce:job.nonce,pid:process.pid}),{flag:'wx'}); setInterval(()=>{},1000);`);
    const result = await runBootstrap({ ...f.args, apply: true }, {
      identity: f.identity, release: f.release, activeProcesses: () => [], prepareStage: f.prepareStage,
      bootTimeoutMs: 3000,
      launchApp: (_file, _argv, options) => {
        const child = spawn(process.execPath, [script], options); children.push(child); return child;
      },
    });
    assert.equal(result.state, 'succeeded');
    assert.equal(fs.readFileSync(path.join(f.paths.application, 'new.txt'), 'utf8'), 'release 0.1.1');
    assert.equal(fs.readFileSync(path.join(result.previousDir, 'old.txt'), 'utf8'), 'legacy release');
    const cache = path.join(f.paths['user-data'], 'desktop-updates');
    assert.equal(fs.existsSync(path.join(cache, 'last-successful-update.json')), false);
    assert.equal(fs.existsSync(path.join(cache, 'last-update.json')), false);
    const record = JSON.parse(fs.readFileSync(result.bootstrapRecord, 'utf8'));
    assert.equal(record.nonce, result.nonce);
    assert.equal(record.backup, result.backup);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise(resolve => setTimeout(resolve, 150));
    f.cleanup();
  }
});
