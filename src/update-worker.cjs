'use strict';

// Runs from a copied file beside the job, using the bundled standalone Node.
// It must not depend on the application tree being replaced.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = filename => fs.existsSync(filename);
const hasExited = child => child.exitCode !== null || child.signalCode !== null;

function sessionFormat(root) {
  const filename = path.join(root, 'resources', 'runtime', 'host', 'node_modules',
    '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
  if (!exists(filename)) return null;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe session format source');
  const matches = [...fs.readFileSync(filename, 'utf8').matchAll(/\bconst SESSION_FORMAT_VERSION\s*=\s*(\d+)\s*;/g)];
  if (matches.length !== 1) throw new Error('Cannot identify bundled session format');
  return Number(matches[0][1]);
}

function dataModule(job, options = {}) {
  if (options.dataModule) return options.dataModule;
  const filename = path.basename(__filename) === 'update-worker.cjs'
    ? path.join(__dirname, 'update-data-snapshot.cjs')
    : path.join(__dirname, `${job.nonce}.snapshot.cjs`);
  return require(filename);
}

function writeJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' });
  fs.renameSync(temporary, filename);
}

function inspectTree(root) {
  const first = fs.lstatSync(root);
  if (!first.isDirectory() || first.isSymbolicLink()) throw new Error('Update root is not an ordinary directory');
  const stack = [root];
  while (stack.length) {
    const parent = stack.pop();
    for (const name of fs.readdirSync(parent)) {
      const item = path.join(parent, name), stat = fs.lstatSync(item);
      if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new Error('Update tree has a reparse or special entry');
      if (stat.isDirectory()) stack.push(item);
    }
  }
}

function treeDigest(root) {
  inspectTree(root);
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const visit = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const filename = path.join(directory, name), stat = fs.lstatSync(filename);
      if (stat.isDirectory()) { digest.update(`D\0${relative}\n`); visit(filename, relative); }
      else {
        const fileHash = createHash('sha256'), fd = fs.openSync(filename, 'r');
        try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) fileHash.update(buffer.subarray(0, count)); }
        finally { fs.closeSync(fd); }
        digest.update(`F\0${relative}\0${stat.size}\0${fileHash.digest('hex')}\n`);
      }
    }
  };
  visit(root, '');
  return digest.digest('hex');
}

async function treeDigestAsync(root) {
  const first = await fs.promises.lstat(root);
  if (!first.isDirectory() || first.isSymbolicLink()) throw new Error('Update root is not an ordinary directory');
  const records = [];
  const visit = async (directory, prefix) => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) {
        throw new Error('Update tree has a reparse or special entry');
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(directory, entry.name);
      records.push({ relative, filename, directory: entry.isDirectory() });
      if (entry.isDirectory()) await visit(filename, relative);
    }
  };
  await visit(root, '');
  const files = records.filter(record => !record.directory);
  let next = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(16, files.length) }, async () => {
    const buffer = Buffer.alloc(1024 * 1024);
    while (next < files.length) {
      const record = files[next++], stat = await fs.promises.lstat(record.filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Update tree has a reparse or special entry');
      const file = await fs.promises.open(record.filename, 'r');
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Update file changed during validation');
        const hash = createHash('sha256');
        let total = 0, count;
        while ((count = (await file.read(buffer, 0, buffer.length, null)).bytesRead) > 0) {
          hash.update(buffer.subarray(0, count)); total += count;
        }
        if (total !== opened.size) throw new Error('Update file changed during validation');
        record.size = total; record.sha256 = hash.digest('hex');
      } finally { await file.close(); }
    }
  }));
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  const digest = createHash('sha256');
  for (const record of records) digest.update(record.directory ? `D\0${record.relative}\n`
    : `F\0${record.relative}\0${record.size}\0${record.sha256}\n`);
  return digest.digest('hex');
}

async function validateJob(job, filename) {
  if (!job || job.schema !== 'dsh.desktop-update-job/v1' || job.state !== 'prepared'
    || !/^[a-f0-9-]{36}$/.test(job.nonce) || job.jobPath !== filename
    || !['update', 'rollback'].includes(job.kind)) throw new Error('Invalid update job');
  const install = path.resolve(job.installDir), parent = path.dirname(install);
  if (install === path.parse(install).root || parent !== path.dirname(job.previousDir)
    || parent !== path.dirname(job.candidateDir) || install === path.resolve(job.previousDir)
    || install === path.resolve(job.candidateDir) || job.previousDir === job.candidateDir) {
    throw new Error('Update job directory boundary mismatch');
  }
  if (path.basename(job.executableName) !== job.executableName || !job.executableName.endsWith('.exe')) {
    throw new Error('Invalid update executable');
  }
  if (path.dirname(filename) !== path.join(path.resolve(job.userDataDir), 'desktop-updates')) {
    throw new Error('Update job outside desktop state directory');
  }
  inspectTree(install);
  if (!/^[a-f0-9]{64}$/i.test(job.candidateSha256)
    || await treeDigestAsync(job.candidateDir) !== job.candidateSha256) throw new Error('Staged release changed after verification');
  if (exists(job.previousDir)) throw new Error('Previous slot already exists');
  if (!fs.statSync(path.join(job.candidateDir, job.executableName)).isFile()) throw new Error('Candidate executable missing');
  const from = sessionFormat(install), to = sessionFormat(job.candidateDir);
  if ((from === null) !== (to === null)) throw new Error('Session format unavailable in one release');
  if (job.sessionFormatFrom !== undefined && job.sessionFormatFrom !== from) throw new Error('Installed session format changed');
  if (job.sessionFormatTo !== undefined && job.sessionFormatTo !== to) throw new Error('Staged session format changed');
  if (from !== to) {
    if (!job.homeDir || !path.isAbsolute(job.homeDir)) throw new Error('DSH home is required for session format backup');
    const data = dataModule(job);
    const backupRoot = path.join(os.homedir(), '.dsh-desktop-update-backups');
    data.ensurePrivateDirectory(backupRoot);
    data.assertSeparateRoots(job.homeDir, job.userDataDir, backupRoot);
    if (job.kind === 'rollback') {
      const roots = data.assertSnapshotBackup(job.restoreDataSnapshot);
      if (roots.home !== job.homeDir || roots.userData !== job.userDataDir
        || job.restoreDataSnapshot.nonce === job.nonce) throw new Error('Rollback data snapshot identity mismatch');
    }
  }
}

function pinOldProcess(pid) {
  // Keep the .NET Process instance and its OS handle alive until Exit. This
  // prevents a recycled numeric PID from being mistaken for the old desktop.
  const script = `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById(${pid}); [void]$p.Handle; Write-Output ('READY:' + $p.StartTime.ToUniversalTime().Ticks); [Console]::Out.Flush(); if(!$p.WaitForExit(2100000)){throw 'Old desktop process wait expired'}; Write-Output 'EXIT'`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  helper.stdout.setEncoding('utf8');
  helper.stderr.setEncoding('utf8');
  let buffer = '', stderr = '', readyDone = false, exitDone = false;
  let resolveReady, rejectReady, resolveExit, rejectExit;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // Validation may still be hashing a large package when the helper fails.
  // Keep the rejection available to the later await without an unhandled exit.
  void exited.catch(() => {});
  helper.stderr.on('data', chunk => { stderr += chunk; });
  helper.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!readyDone && /^READY:\d+$/.test(line)) { readyDone = true; resolveReady(line.slice(6)); }
      if (line === 'EXIT' && !exitDone) { exitDone = true; resolveExit(); }
    }
  });
  helper.on('error', error => {
    if (!readyDone) rejectReady(error);
    if (!exitDone) rejectExit(error);
  });
  helper.on('close', code => {
    const error = new Error(`Old-process handle helper exited ${code}: ${stderr.trim().slice(-300)}`);
    if (!readyDone) rejectReady(error);
    if (!exitDone) rejectExit(error);
  });
  const timeout = setTimeout(() => helper.kill(), 2110000);
  helper.once('close', () => clearTimeout(timeout));
  return { ready, exited, helper };
}

async function waitOldProcess(exited, timeout = 30000) {
  let timer;
  try {
    await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Old desktop process did not exit')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitNewBoot(child, marker, nonce, timeout = 180000) {
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (spawnError) throw spawnError;
    if (exists(marker)) {
      const proof = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (proof.nonce !== nonce || proof.pid !== child.pid) throw new Error('New desktop boot marker identity mismatch');
      // A marker written by main only after the GUI and bundled host respond.
      if (hasExited(child)) throw new Error('Updated desktop exited just after boot');
      return;
    }
    if (hasExited(child)) throw new Error(`Updated desktop exited ${child.signalCode || child.exitCode} before boot`);
    await pause(250);
  }
  throw new Error('Updated desktop did not complete boot');
}

async function stopChild(child, userDataDir, nonce) {
  if (!child || hasExited(child)) return;
  const request = path.join(userDataDir, `desktop-update-quit-${nonce}.json`);
  try {
  try { fs.writeFileSync(request, JSON.stringify({ nonce, pid: child.pid }), { flag: 'wx' }); } catch { /* bounded fallback below */ }
  let until = Date.now() + 12000;
  while (!hasExited(child) && Date.now() < until) await pause(100);
  if (hasExited(child)) return;
  try { child.kill(); } catch { /* already exited */ }
  until = Date.now() + 10000;
  while (!hasExited(child) && Date.now() < until) await pause(100);
  if (!hasExited(child)) throw new Error('Updated process did not exit; old release retained in backup');
  } finally {
    try {
      const value = JSON.parse(fs.readFileSync(request, 'utf8'));
      if (value.nonce === nonce && value.pid === child.pid && hasExited(child)) fs.unlinkSync(request);
    } catch { /* No owned request remains. */ }
  }
}

async function stopOrphanedUpdateHosts(job, childPid, launchedAt, stoppedAt) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(childPid) || childPid <= 0) return [];
  const nodeExecutable = path.join(job.installDir, 'resources', 'runtime', 'node', 'node.exe');
  const tag = `--title=dsh-desktop-update-host-${job.nonce}`;
  // The GUI can exit before its Node host. A mapped node.exe can then prevent
  // moving the failed release aside. Match the direct parent, executable,
  // exact nonce argument and launch interval; hold each OS process handle while
  // checking its CIM identity again before termination.
  const ps = value => `'${String(value).replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$parentPid = ${childPid}
$expectedExe = ${ps(nodeExecutable)}
$tag = ${ps(tag)}
$launched = [DateTimeOffset]::FromUnixTimeMilliseconds(${launchedAt}).UtcDateTime.Ticks
$stopped = [DateTimeOffset]::FromUnixTimeMilliseconds(${stoppedAt}).UtcDateTime.Ticks
$matching = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $parentPid")
foreach ($item in $matching) {
  if (![string]::Equals($item.ExecutablePath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)) { continue }
  $pattern = '(?:^|\\s)"?' + [regex]::Escape($tag) + '(?:"(?=\\s|$)|(?=\\s|$))'
  if (![regex]::IsMatch([string]$item.CommandLine, $pattern)) { continue }
  $created = $item.CreationDate.ToUniversalTime().Ticks
  if ($created -lt $launched -or $created -gt $stopped) { throw ('Tagged host creation time outside update launch: ' + $item.ProcessId) }
  try { $process = [System.Diagnostics.Process]::GetProcessById([int]$item.ProcessId) }
  catch {
    if (!(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($item.ProcessId)")) { continue }
    throw
  }
  try {
    [void]$process.Handle
    $fresh = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($item.ProcessId)"
    if (!$fresh -or $fresh.ParentProcessId -ne $parentPid -or
      ![string]::Equals($fresh.ExecutablePath, $expectedExe, [StringComparison]::OrdinalIgnoreCase) -or
      ![regex]::IsMatch([string]$fresh.CommandLine, $pattern) -or
      $fresh.CreationDate.ToUniversalTime().Ticks -ne $created -or
      [Math]::Abs($process.StartTime.ToUniversalTime().Ticks - $created) -gt [TimeSpan]::TicksPerSecond) {
      throw ('Tagged host identity changed: ' + $item.ProcessId)
    }
    if (!$process.HasExited) {
      $process.Kill()
      if (!$process.WaitForExit(10000)) { throw ('Tagged host did not exit: ' + $item.ProcessId) }
    }
    Write-Output ('STOPPED:' + $item.ProcessId)
  } finally { $process.Dispose() }
}
`;
  const helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  helper.stdout.setEncoding('utf8'); helper.stderr.setEncoding('utf8');
  helper.stdout.on('data', chunk => { stdout += chunk; });
  helper.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { helper.kill(); reject(new Error('Tagged host inspection timed out')); }, 35000);
    helper.once('error', error => { clearTimeout(timeout); reject(error); });
    helper.once('close', value => { clearTimeout(timeout); resolve(value); });
  });
  if (code !== 0) throw new Error(`Tagged host could not be safely stopped: ${stderr.trim().slice(-500) || `PowerShell exit ${code}`}`);
  return [...stdout.matchAll(/^STOPPED:(\d+)\s*$/gm)].map(match => Number(match[1]));
}

function removeOrdinaryTree(root) {
  inspectTree(root);
  fs.rmSync(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 500 });
}

async function transact(job, oldPid, oldStart, oldExited, options = {}) {
  await validateJob(job, job.jobPath);
  writeJson(job.workerReady, { nonce: job.nonce, pid: process.pid, oldPid, oldStart });
  await waitOldProcess(oldExited, options.oldExitTimeoutMs || 30000);
  // These are sibling rename operations on the same volume; no files are
  // overlaid. The old app remains complete until a healthy new boot is proven.
  let child, childLaunchedAt, oldMoved = false, candidateMoved = false;
  const launch = options.launchApp || ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
  // A bootstrap caller must recheck that the legacy app stayed idle after
  // hashing. A rejected gate must never enter recovery or rewrite live data.
  if (options.beforeSwap) {
    if (await treeDigestAsync(job.candidateDir) !== job.candidateSha256) throw new Error('Staged release changed while waiting for exit');
    job.previousSha256 = await treeDigestAsync(job.installDir);
    await options.beforeSwap();
  }
  try {
    if (!options.beforeSwap) {
      if (await treeDigestAsync(job.candidateDir) !== job.candidateSha256) throw new Error('Staged release changed while waiting for exit');
      job.previousSha256 = await treeDigestAsync(job.installDir);
    }
    if (sessionFormat(job.installDir) !== sessionFormat(job.candidateDir)) {
      const data = dataModule(job, options);
      const backupRoot = path.join(os.homedir(), '.dsh-desktop-update-backups');
      data.ensurePrivateDirectory(backupRoot);
      data.assertSeparateRoots(job.homeDir, job.userDataDir, backupRoot);
      job.dataSnapshot = data.snapshotData({ home: job.homeDir, userData: job.userDataDir,
        backupRoot, nonce: job.nonce });
      data.assertSnapshotCurrent(job.dataSnapshot);
      writeJson(job.jobPath, job);
    }
    fs.renameSync(job.installDir, job.previousDir);
    oldMoved = true;
    fs.renameSync(job.candidateDir, job.installDir);
    candidateMoved = true;
    if (job.restoreDataSnapshot) {
      const data = dataModule(job, options);
      data.restoreData(job.restoreDataSnapshot);
    }
    const env = { ...process.env, DSH_DESKTOP_UPDATE_JOB: job.jobPath,
      DSH_DESKTOP_UPDATE_NONCE: job.nonce };
    delete env.ELECTRON_RUN_AS_NODE;
    childLaunchedAt = Date.now();
    child = launch(path.join(job.installDir, job.executableName), [], {
      cwd: job.installDir, env, detached: process.platform === 'win32', stdio: 'ignore', windowsHide: false,
    });
    job.startedNewPid = child.pid;
    await waitNewBoot(child, job.bootMarker, job.nonce, options.bootTimeoutMs || 1200000);
    job.state = 'succeeded';
    job.completedAt = new Date().toISOString();
    writeJson(job.jobPath, job);
    // A legacy bootstrap has separate data recovery and cannot be offered by
    // the ordinary rollback menu, even if its parent exits before archiving.
    if (job.bootstrap !== true) {
      writeJson(path.join(path.dirname(job.jobPath), 'last-update.json'), job);
      writeJson(path.join(path.dirname(job.jobPath), 'last-successful-update.json'), job);
    }
    child.unref();
    return job;
  } catch (error) {
    // The legacy process can open after the idle check. If the first rename
    // fails, its files and data are still live and must not enter recovery.
    if (job.bootstrap === true && !oldMoved) {
      job.state = 'aborted';
      job.error = String(error.message || error);
      job.completedAt = new Date().toISOString();
      writeJson(job.jobPath, job);
      return job;
    }
    let recoveryError, recoveryPublished = false;
    try {
      await stopChild(child, job.userDataDir, job.nonce);
      if (child) job.stoppedOrphanHostPids = await stopOrphanedUpdateHosts(job, child.pid, childLaunchedAt, Date.now());
      if (candidateMoved && exists(job.installDir)) {
        const failedDir = path.join(path.dirname(job.installDir), `.dsh-failed-${job.nonce}`);
        fs.renameSync(job.installDir, failedDir);
        // Leave the failed release in its own slot for diagnosis; no deletion
        // crosses a link or special-file boundary.
        job.failedDir = failedDir;
      }
      if (oldMoved) fs.renameSync(job.previousDir, job.installDir);
      if (candidateMoved && job.dataSnapshot) {
        const data = dataModule(job, options);
        data.restoreData(job.dataSnapshot);
      }
      const restoreEnv = { ...process.env, DSH_DESKTOP_UPDATE_RECOVERED: job.nonce };
      delete restoreEnv.ELECTRON_RUN_AS_NODE;
      delete restoreEnv.DSH_DESKTOP_UPDATE_JOB;
      delete restoreEnv.DSH_DESKTOP_UPDATE_NONCE;
      const restored = launch(path.join(job.installDir, job.executableName), [], {
        cwd: job.installDir, env: restoreEnv,
        detached: process.platform === 'win32', stdio: 'ignore', windowsHide: false,
      });
      await new Promise((resolve, reject) => { restored.once('spawn', resolve); restored.once('error', reject); });
      restored.unref();
      job.restartedOldPid = restored.pid;
      // Publish recovery before cleanup: the relaunched GUI reads this record
      // during startup, while removing a large failed tree can take minutes.
      job.state = 'rolled-back';
      job.error = String(error.message || error);
      job.completedAt = new Date().toISOString();
      writeJson(job.jobPath, job);
      writeJson(path.join(path.dirname(job.jobPath), 'last-update.json'), job);
      recoveryPublished = true;
      if (job.failedDir) {
        try { removeOrdinaryTree(job.failedDir); delete job.failedDir; }
        catch (cleanupError) { job.cleanupError = String(cleanupError.message || cleanupError); }
      }
    } catch (failure) { recoveryError = String(failure.message || failure); }
    job.state = recoveryError ? 'recovery-failed' : 'rolled-back';
    job.error = String(error.message || error);
    if (recoveryError) job.recoveryError = recoveryError;
    job.completedAt = new Date().toISOString();
    writeJson(job.jobPath, job);
    // Cleanup diagnostics belong to this job. The restored GUI can start a
    // newer transaction while cleanup runs; do not publish this old job again.
    if (!recoveryPublished) writeJson(path.join(path.dirname(job.jobPath), 'last-update.json'), job);
    if (recoveryError) throw new Error(`${job.error}; recovery: ${recoveryError}`);
    return job;
  }
}

async function main() {
  const filename = path.resolve(process.argv[2] || '');
  const oldPid = Number(process.argv[3]);
  if (!Number.isSafeInteger(oldPid) || oldPid <= 0) throw new Error('Invalid old process ID');
  const job = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const pinned = pinOldProcess(oldPid);
  const oldStart = await pinned.ready;
  await transact(job, oldPid, oldStart, pinned.exited);
}

if (require.main === module) main().catch(error => {
  // The worker has no inherited console; persist the error beside the job.
  try { fs.writeFileSync(`${process.argv[2]}.worker-error`, String(error.stack || error)); } catch { /* no state path */ }
  process.exitCode = 1;
});

module.exports = { validateJob, inspectTree, treeDigest, treeDigestAsync, pinOldProcess, waitNewBoot, stopOrphanedUpdateHosts, transact, removeOrdinaryTree };
