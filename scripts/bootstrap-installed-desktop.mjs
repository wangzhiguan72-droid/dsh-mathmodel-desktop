import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertSafeRoot, assertSeparateRoots, snapshotData, assertSnapshotCurrent, restoreData } from './bootstrap-data-snapshot.mjs';

const require = createRequire(import.meta.url);
const { extractFile, uncache } = require('@electron/asar');
const updates = require('../src/desktop-updates.cjs');
const worker = require('../src/update-worker.cjs');
const VERSION = '0.1.2';
const PACKAGE = 'dsh-mathmodel-desktop';
const executablePattern = /^Uninstall .+\.exe$/i;

function hashFile(filename) {
  const hash = createHash('sha256'), fd = fs.openSync(filename, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

export function releaseFiles(releaseDir) {
  const verify = JSON.parse(fs.readFileSync(path.join(releaseDir, 'verification.json'), 'utf8'));
  if (verify.ok !== true || verify.unpackedFiles < 10000 || verify.zipAllFiles !== verify.unpackedFiles) {
    throw new Error('Release verification receipt is incomplete');
  }
  const checksums = fs.readFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), 'utf8');
  const expectedNames = [`dsh-mathmodel-desktop-${VERSION}-win-x64.zip`, `dsh-mathmodel-desktop-${VERSION}-win-x64.exe`];
  const artifacts = expectedNames.map(name => {
    const entry = path.join(releaseDir, name), stat = fs.lstatSync(entry);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1000000) throw new Error('Release artifact is not an ordinary file');
    const expected = verify.artifactSha256?.[name];
    if (!/^[a-f0-9]{64}$/.test(expected) || !checksums.split(/\r?\n/).includes(`${expected}  ${name}`)
      || hashFile(entry) !== expected) throw new Error(`Release SHA-256 mismatch: ${name}`);
    return { name, entry, bytes: stat.size, sha256: expected };
  });
  return { zip: artifacts[0], nsis: artifacts[1] };
}

function installedIdentity(installDir) {
  const files = fs.readdirSync(installDir).filter(name => name.toLowerCase().endsWith('.exe') && !executablePattern.test(name));
  if (files.length !== 1) throw new Error('Installed executable is ambiguous');
  const name = files[0], stat = fs.lstatSync(path.join(installDir, name));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Installed executable is unsafe');
  const asar = path.join(installDir, 'resources', 'app.asar');
  uncache(asar);
  const metadata = JSON.parse(extractFile(asar, 'package.json').toString('utf8'));
  if (metadata.name !== PACKAGE || metadata.version !== '0.1.0' || metadata.main !== 'src/main.cjs') {
    throw new Error('This bootstrap accepts the installed desktop 0.1.0 only');
  }
  return { executableName: name, metadata };
}

function activeProcessRows(installDir) {
  if (process.platform !== 'win32') return [];
  const literal = Buffer.from(installDir, 'utf8').toString('base64');
  const source = `$ErrorActionPreference='Stop'; $root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${literal}')).TrimEnd('\\')+'\\'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ExecutablePath=$_.ExecutablePath } } | ConvertTo-Json -Compress`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
  if (!output) return [];
  const result = JSON.parse(output);
  return Array.isArray(result) ? result : [result];
}

function extractSafeUninstaller(nsis, destination) {
  const sevenZip = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'electron-winstaller', 'vendor', '7z-x64.exe');
  if (!fs.statSync(sevenZip).isFile()) throw new Error('Bundled 7z is unavailable');
  const temp = path.join(destination, '.nsis-uninstaller');
  fs.mkdirSync(temp);
  try {
    execFileSync(sevenZip, ['e', '-y', `-o${temp}`, nsis, '-ir!$R9\\Uninstall*.exe'],
      { windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 });
    const names = fs.readdirSync(temp);
    if (names.length !== 1 || !executablePattern.test(names[0])) throw new Error('Trusted NSIS uninstaller not found exactly once');
    const source = path.join(temp, names[0]), stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100000) throw new Error('Trusted NSIS uninstaller is invalid');
    const target = path.join(destination, names[0]);
    if (fs.existsSync(target)) throw new Error('ZIP unexpectedly contains an uninstaller');
    fs.renameSync(source, target);
    return { name: names[0], sha256: hashFile(target) };
  } finally { if (fs.existsSync(temp) && fs.readdirSync(temp).length === 0) fs.rmdirSync(temp); }
}

function readBootstrapArguments(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--apply' || key === '--headless-verify') { args[key.slice(2)] = true; continue; }
    if (!['--install-dir', '--release-dir', '--dsh-home', '--user-data-dir', '--backup-root', '--report'].includes(key)
      || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete bootstrap argument: ${key}`);
    args[key.slice(2)] = argv[++i];
  }
  for (const name of ['install-dir', 'release-dir', 'dsh-home', 'user-data-dir', 'backup-root']) {
    if (!args[name]) throw new Error(`Missing --${name}`);
  }
  return args;
}

export function archiveBootstrapRecord(job, snapshot) {
  const cache = path.dirname(job.jobPath);
  const latest = path.join(cache, 'last-update.json');
  const successful = path.join(cache, 'last-successful-update.json');
  const published = JSON.parse(fs.readFileSync(job.jobPath, 'utf8'));
  if (published.nonce !== job.nonce || published.state !== 'succeeded' || job.state !== 'succeeded') {
    throw new Error('Bootstrap transaction record changed');
  }
  const record = { schema: 'dsh.desktop-bootstrap/v1', nonce: job.nonce, completedAt: job.completedAt,
    fromVersion: job.fromVersion, toVersion: job.toVersion, installDir: job.installDir,
    previousDir: job.previousDir, backup: snapshot.backup, candidateSha256: job.candidateSha256,
    previousSha256: job.previousSha256 };
  fs.writeFileSync(path.join(cache, `bootstrap-${job.nonce}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  // The ordinary menu cannot roll back to a 0.1.0 host that lacks its boot
  // acknowledgment protocol. The complete original is held in previousDir.
  for (const filename of [successful, latest]) {
    if (!fs.existsSync(filename)) continue;
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (record.nonce === job.nonce && record.state === 'succeeded') fs.unlinkSync(filename);
  }
  return record;
}

export async function runBootstrap(args, dependencies = {}) {
  if (process.platform !== 'win32' && !dependencies.allowNonWindows) throw new Error('Windows bootstrap only');
  const installDir = assertSafeRoot(args['install-dir']);
  const releaseDir = assertSafeRoot(args['release-dir']);
  const home = assertSafeRoot(args['dsh-home']);
  const userData = assertSafeRoot(args['user-data-dir']);
  const backupRoot = assertSafeRoot(args['backup-root']);
  assertSeparateRoots(installDir, releaseDir, home, userData, backupRoot);
  // The candidate and backup are siblings of the installation, so the
  // transaction uses same-volume renames even when data backups live elsewhere.
  const identity = dependencies.identity?.(installDir) || installedIdentity(installDir);
  const release = dependencies.release?.(releaseDir) || releaseFiles(releaseDir);
  const active = dependencies.activeProcesses?.(installDir) ?? activeProcessRows(installDir);
  if (active.length) throw new Error(`Installed desktop process family is active (${active.map(row => row.ProcessId).join(', ')})`);
  const result = { schema: 'dsh.desktop-bootstrap-report/v1', mode: args.apply ? 'apply' : 'plan',
    installDir, releaseDir, home, userData, backupRoot, fromVersion: identity.metadata.version,
    toVersion: VERSION, executableName: identity.executableName, zipSha256: release.zip.sha256,
    nsisSha256: release.nsis.sha256, activeProcesses: active.length };
  if (!args.apply) return result;
  const nonce = randomUUID(), parent = path.dirname(installDir);
  const stage = path.join(parent, `.dsh-stage-${nonce}`), previous = path.join(parent, `.dsh-previous-${nonce}`);
  fs.mkdirSync(stage);
  let uninstaller;
  if (dependencies.prepareStage) uninstaller = dependencies.prepareStage(stage);
  else {
    const archiveManifest = updates.inspectZip(release.zip.entry, { includeEntries: true });
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', release.zip.entry, '-C', stage], { windowsHide: true, timeout: 1200000, maxBuffer: 1024 * 1024 });
    updates.verifyExtractedZip(stage, archiveManifest);
    uninstaller = extractSafeUninstaller(release.nsis.entry, stage);
    updates.validateCandidate(stage, { executableName: identity.executableName, packageName: PACKAGE, version: VERSION });
  }
  const candidateSha256 = await worker.treeDigestAsync(stage);
  const stateDir = path.join(userData, 'desktop-updates');
  if (fs.existsSync(stateDir)) {
    const stateStat = fs.lstatSync(stateDir);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error('Unsafe desktop update cache');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const jobPath = path.join(stateDir, `${nonce}.job.json`);
  const job = { schema: 'dsh.desktop-update-job/v1', nonce, kind: 'update', state: 'prepared',
    bootstrap: true,
    appId: updates.APP_ID, fromVersion: identity.metadata.version, toVersion: VERSION,
    executableName: identity.executableName, packageName: PACKAGE, installDir, previousDir: previous,
    candidateDir: stage, extractionDir: stage, userDataDir: userData, archiveSha256: release.zip.sha256,
    candidateSha256, createdAt: new Date().toISOString(), jobPath,
    bootMarker: `${jobPath}.boot-ok`, workerReady: `${jobPath}.worker-ready` };
  const snapshot = snapshotData({ home, userData, backupRoot, nonce });
  fs.writeFileSync(jobPath, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
  const activeBeforeSwap = dependencies.activeProcesses?.(installDir) ?? activeProcessRows(installDir);
  if (activeBeforeSwap.length) {
    throw new Error(`Installed desktop process family became active before replacement (${activeBeforeSwap.map(row => row.ProcessId).join(', ')})`);
  }
  const launcher = dependencies.launchApp || ((file, argv, options) => spawn(file, argv, options));
  let restoreResult;
  const launchApp = (file, argv, options) => {
    if (options.env.DSH_DESKTOP_UPDATE_RECOVERED === nonce) restoreResult = restoreData(snapshot);
    return launcher(file, argv, { ...options, env: { ...options.env,
      DSH_HOME: home, DSH_DESKTOP_USER_DATA: userData,
      ...(args['headless-verify'] ? { DSH_DESKTOP_VERIFY: '1', DSH_DESKTOP_HEADLESS: '1' } : {}) } });
  };
  const outcome = await worker.transact(job, process.pid, 'bootstrap-cli', Promise.resolve(),
    { launchApp, bootTimeoutMs: dependencies.bootTimeoutMs || 1200000,
      beforeSwap: () => {
        assertSnapshotCurrent(snapshot);
        const running = dependencies.activeProcesses?.(installDir) ?? activeProcessRows(installDir);
        if (running.length) throw new Error('Installed desktop became active before replacement');
      } });
  const record = outcome.state === 'succeeded' ? archiveBootstrapRecord(outcome, snapshot) : null;
  const report = { ...result, mode: 'apply', nonce, state: outcome.state, jobPath, stage,
    previousDir: outcome.previousDir, backup: snapshot.backup, uninstallerSha256: uninstaller.sha256,
    candidateSha256, previousSha256: outcome.previousSha256, startedNewPid: outcome.startedNewPid,
    restartedOldPid: outcome.restartedOldPid, error: outcome.error, restoreCleanup: restoreResult,
    bootstrapRecord: record && path.join(stateDir, `bootstrap-${nonce}.json`) };
  if (args.report) fs.writeFileSync(path.resolve(args.report), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runBootstrap(readBootstrapArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.state && report.state !== 'succeeded') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(String(error.stack || error) + '\n');
    process.exitCode = 1;
  }
}
