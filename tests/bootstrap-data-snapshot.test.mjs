import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertSeparateRoots, snapshotData, assertSnapshotCurrent, restoreData } from '../scripts/bootstrap-data-snapshot.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-data-'));
  const home = path.join(root, 'home'), userData = path.join(root, 'user-data');
  const backupRoot = path.join(root, 'backups'), shared = path.join(root, 'shared-skills');
  for (const dir of [home, userData, backupRoot, shared]) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(userData, 'desktop-updates'));
  fs.writeFileSync(path.join(home, 'session.json'), 'original secret sentinel');
  fs.writeFileSync(path.join(userData, 'state.json'), 'original ui sentinel');
  fs.writeFileSync(path.join(userData, 'desktop-updates', 'job.json'), 'worker job sentinel');
  fs.writeFileSync(path.join(shared, 'keep.txt'), 'shared outside roots');
  fs.symlinkSync(shared, path.join(home, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, home, userData, backupRoot, shared, nonce: randomUUID() };
}

test('snapshot and recovery preserve links, bytes and the live worker cache', () => {
  const f = fixture();
  try {
    const record = snapshotData(f);
    assert.equal(fs.lstatSync(path.join(record.backup, 'home', 'skills')).isSymbolicLink(), true);
    fs.writeFileSync(path.join(f.home, 'session.json'), 'changed');
    fs.writeFileSync(path.join(f.userData, 'state.json'), 'changed');
    fs.writeFileSync(path.join(f.userData, 'new.txt'), 'new application data');
    fs.writeFileSync(path.join(f.userData, 'desktop-updates', 'job.json'), 'current worker job');
    restoreData(record);
    assert.equal(fs.readFileSync(path.join(f.home, 'session.json'), 'utf8'), 'original secret sentinel');
    assert.equal(fs.readFileSync(path.join(f.userData, 'state.json'), 'utf8'), 'original ui sentinel');
    assert.equal(fs.existsSync(path.join(f.userData, 'new.txt')), false);
    assert.equal(fs.readFileSync(path.join(f.userData, 'desktop-updates', 'job.json'), 'utf8'), 'current worker job');
    assert.equal(fs.lstatSync(path.join(f.home, 'skills')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(f.shared, 'keep.txt'), 'utf8'), 'shared outside roots');
  } finally {
    fs.unlinkSync(path.join(f.home, 'skills'));
    fs.unlinkSync(path.join(f.backupRoot, `dsh-desktop-bootstrap-${f.nonce}`, 'home', 'skills'));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('overlapping roots and altered backups fail before recovery changes live data', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.home, 'profiles'));
    assert.throws(() => assertSeparateRoots(f.home, path.join(f.home, 'profiles')), /Unsafe|overlap/);
    const record = snapshotData(f);
    fs.writeFileSync(path.join(record.backup, 'home', 'session.json'), 'tampered backup');
    assert.throws(() => restoreData(record), /backup changed/);
    assert.equal(fs.readFileSync(path.join(f.home, 'session.json'), 'utf8'), 'original secret sentinel');
  } finally {
    fs.unlinkSync(path.join(f.home, 'skills'));
    fs.unlinkSync(path.join(f.backupRoot, `dsh-desktop-bootstrap-${f.nonce}`, 'home', 'skills'));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('current-snapshot check ignores worker cache but detects private file and junction changes', () => {
  const f = fixture();
  try {
    const record = snapshotData(f);
    assert.doesNotThrow(() => assertSnapshotCurrent(record));
    fs.writeFileSync(path.join(f.userData, 'desktop-updates', 'job.json'), 'worker progress');
    assert.doesNotThrow(() => assertSnapshotCurrent(record));
    fs.writeFileSync(path.join(f.userData, 'state.json'), 'new user setting');
    assert.throws(() => assertSnapshotCurrent(record), /data changed/);
    fs.writeFileSync(path.join(f.userData, 'state.json'), 'original ui sentinel');
    assert.doesNotThrow(() => assertSnapshotCurrent(record));
    const alternate = path.join(f.root, 'alternate-skills');
    fs.mkdirSync(alternate);
    fs.unlinkSync(path.join(f.home, 'skills'));
    fs.symlinkSync(alternate, path.join(f.home, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertSnapshotCurrent(record), /data changed/);
  } finally {
    fs.unlinkSync(path.join(f.home, 'skills'));
    fs.unlinkSync(path.join(f.backupRoot, `dsh-desktop-bootstrap-${f.nonce}`, 'home', 'skills'));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('busy displaced cleanup keeps a diagnostic path after both data roots recover', t => {
  const f = fixture();
  const originalUnlink = fs.unlinkSync;
  try {
    const record = snapshotData(f);
    fs.writeFileSync(path.join(f.home, 'session.json'), 'new home');
    fs.writeFileSync(path.join(f.userData, 'state.json'), 'new settings');
    fs.writeFileSync(path.join(f.userData, 'desktop-updates', 'job.json'), 'current worker job');
    const displaced = `${f.home}.dsh-displaced-${f.nonce}`;
    t.mock.method(fs, 'unlinkSync', filename => {
      if (filename === path.join(displaced, 'session.json')) throw Object.assign(new Error('held by another process'), { code: 'EBUSY' });
      return originalUnlink(filename);
    });
    const outcome = restoreData(record);
    assert.deepEqual(outcome.retainedPaths, [displaced]);
    assert.match(outcome.cleanupErrors[0].message, /held by another process/);
    assert.equal(fs.readFileSync(path.join(f.home, 'session.json'), 'utf8'), 'original secret sentinel');
    assert.equal(fs.readFileSync(path.join(f.userData, 'state.json'), 'utf8'), 'original ui sentinel');
    assert.equal(fs.readFileSync(path.join(f.userData, 'desktop-updates', 'job.json'), 'utf8'), 'current worker job');
    assert.equal(fs.readFileSync(path.join(f.shared, 'keep.txt'), 'utf8'), 'shared outside roots');
  } finally {
    t.mock.restoreAll();
    const displacedLink = path.join(`${f.home}.dsh-displaced-${f.nonce}`, 'skills');
    if (fs.existsSync(displacedLink)) fs.unlinkSync(displacedLink);
    fs.unlinkSync(path.join(f.home, 'skills'));
    fs.unlinkSync(path.join(f.backupRoot, `dsh-desktop-bootstrap-${f.nonce}`, 'home', 'skills'));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('user-data stage rename failure restores both changed live roots and preserves backup', t => {
  const f = fixture();
  const originalRename = fs.renameSync;
  try {
    const record = snapshotData(f);
    fs.writeFileSync(path.join(f.home, 'session.json'), 'new home');
    fs.writeFileSync(path.join(f.userData, 'state.json'), 'new settings');
    fs.writeFileSync(path.join(f.userData, 'desktop-updates', 'job.json'), 'current worker job');
    const stage = `${f.userData}.dsh-restore-${f.nonce}`;
    t.mock.method(fs, 'renameSync', (source, destination) => {
      if (source === stage && destination === f.userData) throw Object.assign(new Error('stage rename blocked'), { code: 'EACCES' });
      return originalRename(source, destination);
    });
    assert.throws(() => restoreData(record), /stage rename blocked/);
    assert.equal(fs.readFileSync(path.join(f.home, 'session.json'), 'utf8'), 'new home');
    assert.equal(fs.readFileSync(path.join(f.userData, 'state.json'), 'utf8'), 'new settings');
    assert.equal(fs.readFileSync(path.join(f.userData, 'desktop-updates', 'job.json'), 'utf8'), 'current worker job');
    assert.equal(fs.readFileSync(path.join(record.backup, 'home', 'session.json'), 'utf8'), 'original secret sentinel');
  } finally {
    t.mock.restoreAll();
    fs.unlinkSync(path.join(f.home, 'skills'));
    fs.unlinkSync(path.join(f.backupRoot, `dsh-desktop-bootstrap-${f.nonce}`, 'home', 'skills'));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recovery copies dangling in-profile junctions and keeps Windows link kinds', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  const targetDir = path.join(f.home, 'profiles', 'mathmodel', 'node_modules', 'pkg');
  const fallback = path.join(f.home, 'profiles', 'mathmodel', '.dsh-module-fallback', 'node_modules');
  const junction = path.join(fallback, 'pkg');
  const symbolicDir = path.join(f.home, 'symbolic-dir');
  const targetFile = path.join(f.home, 'local-config.txt');
  const symbolicFile = path.join(f.home, 'symbolic-file.txt');
  let backup;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(fallback, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'index.js'), 'old profile package');
    fs.writeFileSync(targetFile, 'old local config');
    fs.symlinkSync(targetDir, junction, 'junction');
    fs.symlinkSync(targetDir, symbolicDir, 'dir');
    fs.symlinkSync(targetFile, symbolicFile, 'file');
    const originalTargets = [junction, symbolicDir, symbolicFile].map(link => fs.readlinkSync(link));
    const record = snapshotData(f);
    backup = record.backup;
    // Simulate the new runtime removing the old profile while its backup
    // junctions continue to point to their original absolute locations.
    fs.rmSync(targetDir, { recursive: true });
    fs.unlinkSync(targetFile);
    const backupJunction = path.join(backup, 'home', path.relative(f.home, junction));
    assert.equal(fs.lstatSync(backupJunction).isSymbolicLink(), true);
    assert.equal(fs.existsSync(backupJunction), false);
    restoreData(record);
    assert.deepEqual([junction, symbolicDir, symbolicFile].map(link => fs.readlinkSync(link)), originalTargets);
    assert.equal(fs.readFileSync(path.join(junction, 'index.js'), 'utf8'), 'old profile package');
    assert.equal(fs.readFileSync(symbolicFile, 'utf8'), 'old local config');
    const encoded = Buffer.from(JSON.stringify([junction, symbolicDir, symbolicFile]), 'utf8').toString('base64');
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json; @($p|ForEach-Object{(Get-Item -LiteralPath $_ -Force).LinkType}) -join ','`;
    const kinds = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert.equal(kinds, 'Junction,SymbolicLink,SymbolicLink');
    assert.equal(fs.readFileSync(path.join(f.shared, 'keep.txt'), 'utf8'), 'shared outside roots');
  } finally {
    for (const link of [junction, symbolicDir, symbolicFile, path.join(f.home, 'skills')]) {
      try { fs.unlinkSync(link); } catch { /* link may not have been created */ }
    }
    if (backup) for (const live of [junction, symbolicDir, symbolicFile, path.join(f.home, 'skills')]) {
      try { fs.unlinkSync(path.join(backup, 'home', path.relative(f.home, live))); } catch { /* snapshot may be incomplete */ }
    }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recovery reads dangling junction and symbolic links beyond Windows MAX_PATH', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  const deep = path.join(f.home, 'profiles', 'mathmodel', 'nested-' + 'a'.repeat(96), 'nested-' + 'b'.repeat(96));
  const targetDir = path.join(deep, 'node_modules', 'pkg');
  const targetFile = path.join(deep, 'config.txt');
  const junction = path.join(deep, '.dsh-module-fallback', 'node_modules', 'pkg');
  const symbolicDir = path.join(deep, 'directory-link');
  const symbolicFile = path.join(deep, 'file-link.txt');
  let backup;
  try {
    assert.ok([junction, symbolicDir, symbolicFile].every(link => link.length > 260));
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.dirname(junction), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'index.js'), 'restored long path package');
    fs.writeFileSync(targetFile, 'restored long path config');
    fs.symlinkSync(targetDir, junction, 'junction');
    fs.symlinkSync(targetDir, symbolicDir, 'dir');
    fs.symlinkSync(targetFile, symbolicFile, 'file');
    const expected = [junction, symbolicDir, symbolicFile].map(link => fs.readlinkSync(link));
    const record = snapshotData(f);
    backup = record.backup;
    fs.rmSync(targetDir, { recursive: true });
    fs.unlinkSync(targetFile);
    const dangling = path.join(backup, 'home', path.relative(f.home, junction));
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
    assert.equal(fs.existsSync(dangling), false);
    restoreData(record);
    assert.deepEqual([junction, symbolicDir, symbolicFile].map(link => fs.readlinkSync(link)), expected);
    assert.equal(fs.readFileSync(path.join(junction, 'index.js'), 'utf8'), 'restored long path package');
    assert.equal(fs.readFileSync(path.join(symbolicDir, 'index.js'), 'utf8'), 'restored long path package');
    assert.equal(fs.readFileSync(symbolicFile, 'utf8'), 'restored long path config');
    assert.equal(fs.readFileSync(path.join(f.shared, 'keep.txt'), 'utf8'), 'shared outside roots');
  } finally {
    for (const link of [junction, symbolicDir, symbolicFile, path.join(f.home, 'skills')]) {
      try { fs.unlinkSync(link); } catch { /* link may not exist */ }
    }
    if (backup) for (const link of [junction, symbolicDir, symbolicFile, path.join(f.home, 'skills')]) {
      try { fs.unlinkSync(path.join(backup, 'home', path.relative(f.home, link))); } catch { /* backup may be incomplete */ }
    }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
