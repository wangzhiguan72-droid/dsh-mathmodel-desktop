'use strict';

// The release feed belongs to this desktop application. The dsh/npm update
// commands are deliberately outside this path: a desktop release is one whole
// application tree, including Electron, the host, and the seeded profile.
const nodeFs = require('node:fs');
const fs = process.versions.electron ? require('original-fs') : nodeFs;
const fsp = nodeFs.promises;
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const APP_ID = 'com.deepseek.harness.mathmodel';
const SCHEMA = 'dsh.desktop-update/v1';
const MAX_FEED_BYTES = 128 * 1024;
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;

function versionParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match[4]?.split('.').some(part => /^0\d+$/.test(part))) throw new Error('Invalid desktop release version');
  return [match[1], match[2], match[3], match[4] || ''];
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  const numeric = (x, y) => x.length === y.length ? (x === y ? 0 : x > y ? 1 : -1) : Math.sign(x.length - y.length);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return numeric(a[i], b[i]);
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  const leftPre = a[3].split('.'), rightPre = b[3].split('.');
  for (let i = 0; i < Math.max(leftPre.length, rightPre.length); i++) {
    if (leftPre[i] === undefined) return -1;
    if (rightPre[i] === undefined) return 1;
    const x = leftPre[i], y = rightPre[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    return xn && yn ? numeric(x, y) : xn !== yn ? (xn ? -1 : 1) : x > y ? 1 : -1;
  }
  return 0;
}

function checkedUrl(value, allowLoopbackHttp = false) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback)) {
    throw new Error('Update URL must use HTTPS');
  }
  if (url.username || url.password || url.hash) throw new Error('Update URL contains credentials or fragment');
  return url;
}

function getStream(url, allowLoopbackHttp = false, redirects = 0) {
  checkedUrl(url, allowLoopbackHttp);
  if (redirects > 3) return Promise.reject(new Error('Too many update redirects'));
  // Chromium follows the desktop's system proxy/PAC configuration. Plain
  // Node HTTPS bypasses that configuration on some Windows networks.
  if (process.versions.electron) return getChromiumStream(url, allowLoopbackHttp, redirects);
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 20000 }, response => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        const next = new URL(response.headers.location || '', url).href;
        response.resume();
        resolve(getStream(next, allowLoopbackHttp, redirects + 1));
      } else if (response.statusCode !== 200) {
        response.resume();
        reject(Object.assign(new Error(`Update server returned HTTP ${response.statusCode}`),
          { statusCode: response.statusCode }));
      } else resolve(response);
    });
    request.on('timeout', () => request.destroy(new Error('Update request timed out')));
    request.on('error', reject);
  });
}

function getChromiumStream(url, allowLoopbackHttp, redirects) {
  return new Promise((resolve, reject) => {
    // Electron's manual fetch cancels redirects before exposing a Response.
    // ClientRequest exposes each target synchronously, so it can be checked
    // before Chromium follows it through the system proxy.
    const request = require('electron').net.request({ url, redirect: 'manual',
      bypassCustomProtocolHandlers: true });
    let response, timer, settled = false, currentUrl = url;
    const clear = () => clearTimeout(timer);
    const fail = error => {
      clear();
      if (response) response.destroy(settled ? error : undefined);
      if (!settled) { settled = true; reject(error); }
      request.abort();
    };
    const reset = () => {
      clear();
      timer = setTimeout(() => fail(new Error('Update request timed out')), 20000);
      timer.unref();
    };
    request.on('redirect', (_status, _method, redirectUrl) => {
      try {
        if (++redirects > 3) throw new Error('Too many update redirects');
        const next = new URL(redirectUrl, currentUrl).href;
        checkedUrl(next, allowLoopbackHttp);
        currentUrl = next;
        request.followRedirect();
        reset();
      } catch (error) { fail(error); }
    });
    request.on('response', incoming => {
      response = incoming;
      if (incoming.statusCode !== 200) {
        fail(Object.assign(new Error(`Update server returned HTTP ${incoming.statusCode}`),
          { statusCode: incoming.statusCode }));
        return;
      }
      incoming.on('readable', reset);
      incoming.once('end', clear);
      incoming.once('close', clear);
      incoming.once('error', clear);
      incoming.once('aborted', () => incoming.destroy(new Error('Update response aborted')));
      settled = true;
      reset();
      resolve(incoming);
    });
    request.on('error', error => {
      if (!settled) fail(error);
      else if (response && !response.destroyed) response.destroy(error);
    });
    reset();
    request.end();
  });
}

async function fetchSmallJson(url, allowLoopbackHttp) {
  const response = await getStream(url, allowLoopbackHttp);
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_FEED_BYTES) throw new Error('Update feed exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateRelease(feed, { appId = APP_ID, allowLoopbackHttp = false } = {}) {
  if (!feed || feed.schema !== SCHEMA || feed.appId !== appId || feed.channel !== 'stable') {
    throw new Error('Update feed identity or channel mismatch');
  }
  versionParts(feed.version);
  const asset = feed.windows?.x64;
  if (!asset || !/^[a-f0-9]{64}$/i.test(asset.sha256)
    || !Number.isSafeInteger(asset.bytes) || asset.bytes < 100 || asset.bytes > MAX_ZIP_BYTES) {
    throw new Error('Update asset digest or length is invalid');
  }
  checkedUrl(asset.url, allowLoopbackHttp);
  return { schema: SCHEMA, appId, channel: 'stable', version: feed.version,
    notes: typeof feed.notes === 'string' ? feed.notes.slice(0, 10000) : '',
    windows: { x64: { url: asset.url, sha256: asset.sha256.toLowerCase(), bytes: asset.bytes } } };
}

async function checkForUpdate({ feedUrl, currentVersion, appId = APP_ID, allowLoopbackHttp = false }) {
  if (!feedUrl) return { available: false, reason: 'feed-not-configured' };
  versionParts(currentVersion);
  const release = validateRelease(await fetchSmallJson(feedUrl, allowLoopbackHttp), { appId, allowLoopbackHttp });
  return { available: compareVersions(release.version, currentVersion) > 0, release };
}

async function downloadAsset(asset, filename, allowLoopbackHttp, onProgress) {
  const response = await getStream(asset.url, allowLoopbackHttp);
  const handle = await fsp.open(filename, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > asset.bytes) throw new Error('Update asset exceeds declared length');
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written);
        written += result.bytesWritten;
      }
      if (typeof onProgress === 'function') onProgress({ phase: 'download', bytes, total: asset.bytes });
    }
  } finally { await handle.close(); }
  if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('Update asset length or SHA-256 mismatch');
}

// ZIP central directory validation occurs before extraction; bsdtar is then
// constrained to a fresh owned directory and the resulting tree is checked.
function inspectZip(filename, { includeEntries = false } = {}) {
  const size = fs.statSync(filename).size;
  const fd = fs.openSync(filename, 'r');
  try {
    const tailSize = Math.min(size, 65557);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('ZIP central directory missing');
    const count = tail.readUInt16LE(eocd + 10), directorySize = tail.readUInt32LE(eocd + 12);
    const offset = tail.readUInt32LE(eocd + 16);
    if (!count || count === 65535 || directorySize > 64 * 1024 * 1024 || offset === 0xffffffff
      || tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0 || count !== tail.readUInt16LE(eocd + 8)
      || offset + directorySize > size || tail.readUInt16LE(eocd + 20) !== tailSize - eocd - 22) {
      throw new Error('Unsupported or malformed ZIP directory');
    }
    const central = Buffer.alloc(directorySize);
    fs.readSync(fd, central, 0, central.length, offset);
    const seen = new Set();
    const entries = [];
    let position = 0, files = 0, totalUncompressed = 0;
    for (let i = 0; i < count; i++) {
      if (position + 46 > central.length || central.readUInt32LE(position) !== 0x02014b50) throw new Error('ZIP entry truncated');
      const flags = central.readUInt16LE(position + 8), method = central.readUInt16LE(position + 10);
      const nameLength = central.readUInt16LE(position + 28), extra = central.readUInt16LE(position + 30);
      const comment = central.readUInt16LE(position + 32), creator = central.readUInt16LE(position + 4) >> 8;
      const attrs = central.readUInt32LE(position + 38) >>> 16;
      const compressed = central.readUInt32LE(position + 20), uncompressed = central.readUInt32LE(position + 24);
      const localOffset = central.readUInt32LE(position + 42);
      const rawName = central.subarray(position + 46, position + 46 + nameLength);
      const name = rawName.toString('utf8');
      position += 46 + nameLength + extra + comment;
      const normalized = name.replaceAll('\\', '/');
      const parts = normalized.split('/').filter(Boolean);
      if (!name || /[\x00-\x1f<>|"*?]/.test(name) || position > central.length || flags & 1 || ![0, 8].includes(method)
        || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff
        || !Buffer.from(name, 'utf8').equals(rawName)
        || normalized.startsWith('/') || normalized.includes('\\') || /^[A-Za-z]:/.test(normalized)
        || parts.some(part => part === '.' || part === '..' || part.includes(':')
          || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
        || parts.length < 1) throw new Error('Unsafe ZIP entry');
      if (creator === 3 && (attrs & 0xf000) === 0xa000) throw new Error('ZIP link entry refused');
      if (uncompressed > MAX_ZIP_BYTES || (totalUncompressed += uncompressed) > 4 * MAX_ZIP_BYTES) {
        throw new Error('ZIP expanded size exceeds limit');
      }
      const local = Buffer.alloc(30 + nameLength);
      if (localOffset + local.length > offset) throw new Error('ZIP local record overlaps directory');
      fs.readSync(fd, local, 0, local.length, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags
        || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== nameLength
        || !local.subarray(30).equals(rawName)
        || localOffset + local.length + local.readUInt16LE(28) + compressed > offset) {
        throw new Error('ZIP local and central records disagree');
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) throw new Error('Duplicate ZIP entry');
      seen.add(key);
      if (!normalized.endsWith('/')) { files++; entries.push({ name: normalized, size: uncompressed }); }
    }
    if (position !== central.length || !files) throw new Error('ZIP directory has unexpected records');
    return includeEntries ? { files, entries } : { files };
  } finally { fs.closeSync(fd); }
}

function verifyExtractedZip(root, archive) {
  assertOrdinaryTree(root);
  const actual = new Set();
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const filename = path.join(directory, name);
      if (fs.lstatSync(filename).isDirectory()) visit(filename, relative);
      else actual.add(relative);
    }
  };
  visit(root);
  if (actual.size !== archive.files) throw new Error('Extracted release file count differs from ZIP');
  for (const entry of archive.entries) {
    if (!actual.has(entry.name) || fs.statSync(path.join(root, ...entry.name.split('/'))).size !== entry.size) {
      throw new Error('Extracted release file is missing or truncated: ' + entry.name);
    }
  }
}

function assertOrdinaryTree(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Update tree is not an ordinary directory');
  const stack = [root];
  while (stack.length) {
    for (const entry of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
      const full = path.join(entry.parentPath || entry.path, entry.name);
      const item = fs.lstatSync(full);
      if (item.isSymbolicLink() || !(item.isFile() || item.isDirectory())) throw new Error('Update tree has a reparse or special entry');
      if (item.isDirectory()) stack.push(full);
    }
  }
}

function treeDigest(root) {
  assertOrdinaryTree(root);
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

function asarPackage(asar) {
  const fd = fs.openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const length = head.readUInt32LE(12);
    if (length < 10 || length > 16 * 1024 * 1024) throw new Error('Invalid app.asar header');
    const body = Buffer.alloc(length);
    fs.readSync(fd, body, 0, length, 16);
    const files = JSON.parse(body.toString('utf8')).files;
    for (const name of ['package.json', 'src/main.cjs', 'src/desktop-updates.cjs', 'src/update-worker.cjs', 'src/stage-validator.cjs']) {
      const parts = name.split('/');
      let entry = { files };
      for (const part of parts) entry = entry?.files?.[part];
      if (!entry || entry.unpacked) throw new Error(`Candidate app.asar missing ${name}`);
    }
    const packageEntry = files['package.json'];
    if (!Number.isSafeInteger(packageEntry.size) || !/^\d+$/.test(packageEntry.offset)) throw new Error('Invalid app.asar package entry');
    const packageBuffer = Buffer.alloc(packageEntry.size);
    fs.readSync(fd, packageBuffer, 0, packageBuffer.length, 8 + head.readUInt32LE(4) + Number(packageEntry.offset));
    return JSON.parse(packageBuffer.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function validateCandidate(root, { executableName, packageName, version }) {
  assertOrdinaryTree(root);
  if (path.basename(executableName) !== executableName || !executableName.endsWith('.exe')) throw new Error('Invalid executable name');
  const executable = path.join(root, executableName);
  const first = Buffer.alloc(2);
  const fd = fs.openSync(executable, 'r');
  try { fs.readSync(fd, first, 0, 2, 0); } finally { fs.closeSync(fd); }
  if (first.toString('ascii') !== 'MZ') throw new Error('Candidate executable is not PE');
  const metadata = asarPackage(path.join(root, 'resources', 'app.asar'));
  if (metadata.name !== packageName || metadata.version !== version || metadata.main !== 'src/main.cjs') {
    throw new Error('Candidate application identity or version mismatch');
  }
  const runtime = path.join(root, 'resources', 'runtime');
  if (!fs.statSync(path.join(runtime, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')).isFile()
    || !fs.statSync(path.join(runtime, 'node', 'node.exe')).isFile()) {
    throw new Error('Candidate host or Node runtime missing');
  }
  return metadata;
}

function assertInstallPath(installDir) {
  const resolved = path.resolve(installDir), parent = path.dirname(resolved);
  if (resolved === path.parse(resolved).root || parent === resolved) throw new Error('Unsafe installation root');
  const item = fs.lstatSync(resolved), parentItem = fs.lstatSync(parent);
  if (!item.isDirectory() || item.isSymbolicLink() || !parentItem.isDirectory() || parentItem.isSymbolicLink()) {
    throw new Error('Installation path is a link or special directory');
  }
  return { resolved, parent };
}

async function atomicJson(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await fsp.rename(temp, filename);
}

async function validateInBackground({ candidateDir, archiveManifest, executableName, packageName,
  version, cache, nonce, nodeBin }) {
  const script = path.join(cache, `${nonce}.validator.cjs`);
  const coreModule = path.join(cache, `${nonce}.validator-core.cjs`);
  const treeModule = path.join(cache, `${nonce}.validator-tree.cjs`);
  const validatorNode = path.join(cache, `${nonce}.validator-node.exe`);
  const requestPath = path.join(cache, `${nonce}.validation-request.json`);
  const output = path.join(cache, `${nonce}.validation-result.json`);
  await fsp.copyFile(path.join(__dirname, 'stage-validator.cjs'), script, fs.constants.COPYFILE_EXCL);
  await fsp.copyFile(path.join(__dirname, 'desktop-updates.cjs'), coreModule, fs.constants.COPYFILE_EXCL);
  await fsp.copyFile(path.join(__dirname, 'update-worker.cjs'), treeModule, fs.constants.COPYFILE_EXCL);
  await fsp.copyFile(nodeBin, validatorNode, fs.constants.COPYFILE_EXCL);
  await atomicJson(requestPath, { schema: 'dsh.stage-validation/v1', nonce, output, coreModule, treeModule,
    candidateDir, archiveManifest, identity: { executableName, packageName, version } });
  await execFileAsync(validatorNode, [script, requestPath], { cwd: cache, windowsHide: true,
    timeout: 1800000, maxBuffer: 1024 * 1024, env: { ...process.env, UV_THREADPOOL_SIZE: '16' } });
  const result = JSON.parse(await fsp.readFile(output, 'utf8'));
  if (result.nonce !== nonce || !/^[a-f0-9]{64}$/.test(result.candidateSha256)) throw new Error('Stage validation result mismatch');
  return result.candidateSha256;
}

async function prepareUpdate({ release, installDir, executableName, packageName = 'dsh-mathmodel-desktop',
  appId = APP_ID, userDataDir, cacheDir, currentVersion, allowLoopbackHttp = false, onProgress, nodeBin }) {
  if (process.platform !== 'win32') throw new Error('Desktop self-update is Windows-only');
  const valid = validateRelease(release, { appId, allowLoopbackHttp });
  if (compareVersions(valid.version, currentVersion) <= 0) throw new Error('Release is not newer than installed app');
  const { resolved, parent } = assertInstallPath(installDir);
  const nonce = randomUUID(), state = path.resolve(userDataDir);
  await fsp.mkdir(state, { recursive: true });
  const cache = cacheDir ? path.resolve(cacheDir) : path.join(state, 'desktop-updates');
  await fsp.mkdir(cache, { recursive: true });
  const archive = path.join(cache, `${nonce}.zip`);
  const extraction = path.join(parent, `.dsh-stage-${nonce}`);
  const candidate = extraction;
  const previous = path.join(parent, `.dsh-previous-${nonce}`);
  const jobPath = path.join(cache, `${nonce}.job.json`);
  try {
    await downloadAsset(valid.windows.x64, archive, allowLoopbackHttp, onProgress);
    if (typeof onProgress === 'function') onProgress({ phase: 'verify', bytes: valid.windows.x64.bytes, total: valid.windows.x64.bytes });
    const archiveManifest = inspectZip(archive, { includeEntries: true });
    await fsp.mkdir(extraction, { recursive: false });
    if (typeof onProgress === 'function') onProgress({ phase: 'extract' });
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await execFileAsync(tar, ['-xf', archive, '-C', extraction], { windowsHide: true, timeout: 1200000, maxBuffer: 1024 * 1024 });
    const releaseUninstallers = fs.readdirSync(candidate).filter(name => /^Uninstall .*\.exe$/i.test(name));
    if (releaseUninstallers.length) throw new Error('Release ZIP must not replace the installed uninstaller');
    const existingUninstallers = fs.readdirSync(resolved).filter(name => /^Uninstall .*\.exe$/i.test(name));
    if (existingUninstallers.length > 1) throw new Error('Ambiguous installed uninstaller');
    if (existingUninstallers.length === 1) {
      const name = existingUninstallers[0], source = path.join(resolved, name);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Installed uninstaller is not an ordinary file');
      await fsp.copyFile(source, path.join(candidate, name), fs.constants.COPYFILE_EXCL);
      archiveManifest.files++;
      archiveManifest.entries.push({ name, size: stat.size });
    }
    let candidateSha256;
    if (process.versions.electron || nodeBin) {
      if (!nodeBin) throw new Error('Bundled Node is required for background validation');
      candidateSha256 = await validateInBackground({ candidateDir: candidate, archiveManifest,
        executableName, packageName, version: valid.version, cache, nonce, nodeBin });
    } else {
      verifyExtractedZip(candidate, archiveManifest);
      validateCandidate(candidate, { executableName, packageName, version: valid.version });
      candidateSha256 = treeDigest(candidate);
    }
    // A reversible write probe catches protected installation directories while
    // the old process and its host are still running.
    const probe = path.join(parent, `.dsh-write-${nonce}`);
    await fsp.writeFile(probe, '', { flag: 'wx' });
    await fsp.unlink(probe);
    const job = { schema: 'dsh.desktop-update-job/v1', nonce, kind: 'update', state: 'prepared',
      appId, fromVersion: currentVersion, toVersion: valid.version, executableName, packageName,
      installDir: resolved, previousDir: previous, candidateDir: candidate, extractionDir: extraction,
      userDataDir: state, archiveSha256: valid.windows.x64.sha256, candidateSha256,
      createdAt: new Date().toISOString(),
      jobPath, bootMarker: `${jobPath}.boot-ok`, workerReady: `${jobPath}.worker-ready` };
    await atomicJson(jobPath, job);
    if (typeof onProgress === 'function') onProgress({ phase: 'ready' });
    return job;
  } catch (error) {
    // Never remove a staged tree containing an unexpected link. Leave it for
    // diagnosis instead of allowing recursive deletion to cross a boundary.
    if (fs.existsSync(extraction)) {
      try { assertOrdinaryTree(extraction); await fsp.rm(extraction, { recursive: true }); } catch { /* retained */ }
    }
    await fsp.rm(archive, { force: true });
    throw error;
  }
}

async function prepareRollback({ installDir, executableName, userDataDir, nodeBin, currentVersion }) {
  let last;
  try { last = JSON.parse(fs.readFileSync(path.join(path.resolve(userDataDir), 'desktop-updates', 'last-successful-update.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read last successful update: ' + error.message);
    last = readLastUpdate({ userDataDir });
  }
  if (!last || last.state !== 'succeeded' || !last.previousDir) return null;
  if (currentVersion !== last.toVersion) throw new Error('Current desktop version differs from the last successful update');
  const { resolved, parent } = assertInstallPath(installDir);
  if (resolved !== last.installDir || path.dirname(last.previousDir) !== parent
    || executableName !== last.executableName) throw new Error('Previous release identity mismatch');
  const nonce = randomUUID(), jobPath = path.join(path.dirname(last.jobPath), `${nonce}.job.json`);
  let previousSha256;
  if (process.versions.electron || nodeBin) {
    if (!nodeBin) throw new Error('Bundled Node is required for background validation');
    previousSha256 = await validateInBackground({ candidateDir: last.previousDir,
      executableName, packageName: last.packageName, version: last.fromVersion,
      cache: path.dirname(last.jobPath), nonce, nodeBin });
  } else previousSha256 = treeDigest(last.previousDir);
  if (!last.previousSha256 || previousSha256 !== last.previousSha256) throw new Error('Previous release changed after the update');
  const job = { ...last, nonce, kind: 'rollback', state: 'prepared',
    fromVersion: last.toVersion, toVersion: last.fromVersion,
    candidateDir: last.previousDir, previousDir: path.join(parent, `.dsh-undone-${nonce}`),
    extractionDir: null, createdAt: new Date().toISOString(), jobPath,
    bootMarker: `${jobPath}.boot-ok`, workerReady: `${jobPath}.worker-ready` };
  job.candidateSha256 = previousSha256;
  await atomicJson(jobPath, job);
  return job;
}

function readLastUpdate({ userDataDir }) {
  const filename = path.join(path.resolve(userDataDir), 'desktop-updates', 'last-update.json');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read desktop update record: ' + error.message);
  }
}

function acknowledgeBoot({ jobPath, nonce, installDir, userDataDir, pid = process.pid, version }) {
  if (!jobPath || !nonce) return false;
  const state = path.resolve(userDataDir);
  if (path.dirname(path.resolve(jobPath)) !== path.join(state, 'desktop-updates')) {
    throw new Error('Update boot job outside desktop state directory');
  }
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  if (job.schema !== 'dsh.desktop-update-job/v1' || job.state !== 'prepared'
    || job.nonce !== nonce || job.installDir !== path.resolve(installDir)
    || job.userDataDir !== state || job.toVersion !== version || !fs.existsSync(job.previousDir)) {
    throw new Error('Update boot identity mismatch');
  }
  fs.writeFileSync(job.bootMarker, JSON.stringify({ nonce, pid, version,
    completedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  return true;
}

async function launchUpdate(job, { currentPid = process.pid, nodeBin, timeoutMs = 1800000 } = {}) {
  if (!job || job.state !== 'prepared' || !fs.existsSync(job.jobPath)) throw new Error('Update job is not prepared');
  if (!Number.isSafeInteger(currentPid) || currentPid <= 0) throw new Error('Invalid current desktop PID');
  if (!nodeBin || !fs.statSync(nodeBin).isFile()) throw new Error('Bundled Node executable missing');
  const workerDir = path.dirname(job.jobPath);
  const workerPath = path.join(workerDir, `${job.nonce}.worker.cjs`);
  const workerNode = path.join(workerDir, `${job.nonce}.node.exe`);
  await fsp.copyFile(path.join(__dirname, 'update-worker.cjs'), workerPath, fs.constants.COPYFILE_EXCL);
  // nodeBin lives inside the install tree. Copy the executable out before the
  // swap so Windows has no image mapping into the directory being renamed.
  await fsp.copyFile(nodeBin, workerNode, fs.constants.COPYFILE_EXCL);
  const child = spawn(workerNode, [workerPath, job.jobPath, String(currentPid)], {
    cwd: workerDir, detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UV_THREADPOOL_SIZE: '16' },
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fs.existsSync(job.workerReady)) {
      const ready = JSON.parse(await fsp.readFile(job.workerReady, 'utf8'));
      if (ready.nonce !== job.nonce || ready.pid !== child.pid) throw new Error('Update worker identity mismatch');
      return { workerPid: child.pid, jobPath: job.jobPath };
    }
    if (spawnError || child.exitCode !== null) throw new Error('Update worker exited before readiness: ' + (spawnError?.message || child.exitCode));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try { child.kill(); } catch { /* worker already stopped */ }
  throw new Error('Update worker did not become ready');
}

module.exports = { APP_ID, SCHEMA, compareVersions, validateRelease, checkForUpdate,
  inspectZip, verifyExtractedZip, assertOrdinaryTree, treeDigest, validateCandidate, validateInBackground, prepareUpdate, prepareRollback,
  readLastUpdate, launchUpdate, acknowledgeBoot };
