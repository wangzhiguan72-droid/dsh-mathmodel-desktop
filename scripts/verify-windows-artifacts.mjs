#!/usr/bin/env node
/** Verify an already completed Windows release without running its installer. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractFile } = require('@electron/asar');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repo, 'dist');
const output = path.resolve(process.argv[2] ?? path.join(dist, 'rc3-verified'));
const sevenZip = path.join(repo, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe');
const desktop = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const bridge = process.argv.includes('--bridge');
if (bridge) desktop.version = '0.1.3-bridge.1';
const base = `dsh-mathmodel-desktop-${desktop.version}-win-x64`;
const productExe = 'DeepSeek 数学建模版.exe';
const required = [
  productExe,
  'resources/app.asar',
  'resources/runtime/VERSION.json',
  'resources/runtime/node/node.exe',
  'resources/runtime/node/npm.cmd',
  'resources/runtime/node/pnpm.cmd',
  'resources/runtime/node/node_modules/npm/bin/npm-cli.js',
  'resources/runtime/node/node_modules/pnpm/bin/pnpm.cjs',
  'resources/runtime/host/node_modules/@deepseek-ai/dsh/package.json',
  'resources/runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'resources/runtime/profile-web/cordis.patch.yml',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-client-ui-git-graph/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-web-all/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-remote-web-ui/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-remote-web-ui/lib/index.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-update/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-update/lib/index.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-web-all/cordis.patch.yml',
  'resources/runtime/profile-web/node_modules/@deepseek-harness/dsh-mathmodel/package.json',
  'resources/runtime/profile-web/node_modules/@deepseek-harness/dsh-mathmodel/lib/index.js',
];
const compareFromZip = [
  productExe,
  'resources/app.asar',
  'resources/runtime/VERSION.json',
  'resources/runtime/node/npm.cmd',
  'resources/runtime/node/pnpm.cmd',
  'resources/runtime/host/node_modules/@deepseek-ai/dsh/package.json',
  'resources/runtime/profile-web/cordis.patch.yml',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-client-ui-git-graph/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-web-all/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-remote-web-ui/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-remote-web-ui/lib/index.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-update/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-update/lib/index.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-web-all/cordis.patch.yml',
  'resources/runtime/profile-web/node_modules/@deepseek-harness/dsh-mathmodel/package.json',
  'resources/runtime/profile-web/node_modules/@deepseek-harness/dsh-mathmodel/lib/index.js',
];
if (bridge) {
  for (const entries of [required, compareFromZip]) {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index].includes('/@linxin666/dsh-update/')) entries.splice(index, 1);
    }
  }
}
if (!bridge) {
  if (['0.1.6', '0.1.7', '0.1.8', '0.1.9'].includes(desktop.version)) {
    for (const relative of [
      'resources/runtime/profile-web/node_modules/dsh-model-fusion/lib/client.js',
      'resources/runtime/profile-web/node_modules/@nanmicoder/dsh-auto-mode/package.json',
      'resources/runtime/profile-web/node_modules/@nanmicoder/dsh-auto-mode/lib/index.js',
      'resources/runtime/profile-web/node_modules/@nanmicoder/dsh-auto-mode/lib/client.js',
      'resources/runtime/profile-web/node_modules/@nanmicoder/dsh-auto-mode/cordis.patch.yml',
    ]) { required.push(relative); compareFromZip.push(relative); }
    if (['0.1.7', '0.1.8', '0.1.9'].includes(desktop.version)) {
      for (const relative of [
        'resources/runtime/profile-web/node_modules/@dsh-external/dsh-better-browser/package.json',
        'resources/runtime/profile-web/node_modules/@dsh-external/dsh-better-browser/lib/index.js',
        'resources/runtime/kimi-webbridge/kimi-webbridge.exe',
      ]) { required.push(relative); compareFromZip.push(relative); }
    }
  }
  const sshClient = 'resources/runtime/profile-web/node_modules/@linxin666/dsh-ssh/lib/client.js';
  required.push(sshClient);
  compareFromZip.push(sshClient);
  for (const rel of ['resources/runtime/profile-web/package.json',
    'resources/runtime/profile-web/node_modules/dsh-model-fusion/package.json',
    'resources/runtime/profile-web/node_modules/dsh-model-fusion/lib/dsh-model-fusion.js',
    'resources/runtime/profile-web/node_modules/dsh-model-fusion/cordis.patch.yml']) {
    required.push(rel);
    compareFromZip.push(rel);
  }
}

function within(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function assertOutput() {
  assert.equal(process.platform, 'win32', 'Windows artifacts require a Windows host for this check');
  assert.ok(fs.existsSync(dist), 'dist directory is missing');
  assert.ok(fs.existsSync(output), 'release output is missing');
  const realDist = fs.realpathSync.native(dist);
  const realOutput = fs.realpathSync.native(output);
  assert.ok(within(realDist, realOutput), 'output must be a release folder below this repository\'s dist directory');
  assert.ok(fs.statSync(realOutput).isDirectory(), 'output must be a directory');
  assert.ok(fs.existsSync(sevenZip), 'electron-builder bundled 7z.exe is missing');
  return realOutput;
}

function file(root, relative) {
  const target = path.join(root, ...relative.split('/'));
  assert.ok(within(root, target), `unsafe release path: ${relative}`);
  const info = fs.lstatSync(target);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `missing regular release file: ${relative}`);
  return target;
}

function run7z(args, maxBuffer = 128 * 1024 * 1024) {
  const result = spawnSync(sevenZip, [args[0], '-sccUTF-8', ...args.slice(1)], {
    encoding: null,
    windowsHide: true,
    maxBuffer,
    timeout: 10 * 60 * 1000,
  });
  assert.equal(result.status, 0, `7z ${args[0]} failed: ${String(result.stderr).trim().slice(-500)}`);
  return result.stdout;
}

export function listingOf(archive) {
  const listing = run7z(['l', '-slt', archive]).toString('utf8');
  const marker = listing.indexOf('----------');
  assert.ok(marker >= 0, '7z did not return an archive entry listing');
  const records = listing.slice(marker).split(/\r?\n\r?\n/);
  const entries = records.flatMap((record) => {
    const itemPath = /^Path = ([^\r\n]+)/m.exec(record)?.[1];
    if (!itemPath) return [];
    return [{
      path: itemPath.replaceAll('\\', '/'),
      directory: /^Folder = \+\r?$/m.test(record) || /^Attributes = [^\r\n]*D[^\r\n]*\r?$/m.test(record),
      size: Number(/^Size = (\d+)\r?$/m.exec(record)?.[1] ?? 0),
    }];
  });
  return { header: listing.slice(0, marker), entries };
}

function unpackedFiles(root) {
  const files = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`unpacked app contains a link: ${path.relative(root, absolute)}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.add(path.relative(root, absolute).split(path.sep).join('/'));
      else throw new Error(`unpacked app contains a non-file entry: ${path.relative(root, absolute)}`);
    }
  };
  walk(root);
  return files;
}

function zipBytes(zip, entry) {
  return run7z(['x', '-so', '-y', zip, entry], 512 * 1024 * 1024);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(filename, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function noAuthorPath(value, label) {
  assert.ok(!/\bAdministrator\b|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/i.test(value),
    `${label} contains a build-machine user path`);
}

function writeIfMissingOrSame(target, contents) {
  if (fs.existsSync(target)) {
    assert.ok(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink(),
      `verification output is not a regular file: ${path.basename(target)}`);
    assert.equal(fs.readFileSync(target, 'utf8'), contents,
      `${path.basename(target)} already exists with different content`);
    return;
  }
  fs.writeFileSync(target, contents, { flag: 'wx' });
}

async function main() {
  const release = assertOutput();
  const unpacked = path.join(release, 'win-unpacked');
  assert.ok(fs.statSync(unpacked).isDirectory(), 'win-unpacked is missing');
  const installer = file(release, `${base}.exe`);
  const zip = file(release, `${base}.zip`);
  const pe = Buffer.alloc(2);
  const fd = fs.openSync(installer, 'r');
  try { fs.readSync(fd, pe, 0, pe.length, 0); } finally { fs.closeSync(fd); }
  assert.equal(pe.toString('ascii'), 'MZ', 'NSIS artifact is not a Windows PE executable');
  const nsis = listingOf(installer);
  assert.match(nsis.header, /^Type = Nsis\r?$/m, '7z does not recognize the installer as NSIS');
  const appPayload = nsis.entries.find((entry) => entry.path === '$PLUGINSDIR/app-64.7z');
  assert.ok(appPayload && appPayload.size > 0, 'NSIS installer has no embedded x64 app payload');
  // 7z validates the outer NSIS archive; it does not install the application
  // or verify the nested 7z payload against win-unpacked byte for byte.
  run7z(['t', installer], 8 * 1024 * 1024);

  for (const rel of required) file(unpacked, rel);
  const appAsar = file(unpacked, 'resources/app.asar');
  const packedMain = extractFile(appAsar, 'src/main.cjs').toString('utf8');
  const packedRuntime = extractFile(appAsar, 'src/runtime.cjs');
  assert.equal(sha256(Buffer.from(packedMain)), await hashFile(path.join(repo, 'src/main.cjs')),
    'app.asar main does not match the checked-out source');
  assert.equal(sha256(packedRuntime), await hashFile(path.join(repo, 'src/runtime.cjs')),
    'app.asar runtime does not match the checked-out source');
  const packedPackage = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'));
  assert.equal(packedPackage.version, desktop.version, 'app.asar desktop version differs');
  for (const name of ['preload.cjs', 'desktop-updates.cjs', 'update-worker.cjs', 'update-data-snapshot.cjs', 'update-boot-safety.cjs',
    'stage-validator.cjs', 'update-controller.cjs', 'update-settings-preload.cjs',
    'update-settings.html', 'update-channel.json']) {
    assert.equal(sha256(extractFile(appAsar, 'src/' + name)), await hashFile(path.join(repo, 'src', name)),
      'app.asar does not match update source: ' + name);
  }
  noAuthorPath(packedMain, 'app.asar main');
  for (const name of ['restore-specialized-presets.mjs', 'migrate-fusion-bundle.mjs']) {
    assert.equal(sha256(extractFile(appAsar, 'scripts/' + name)), await hashFile(path.join(repo, 'scripts', name)),
      'app.asar migration differs from source: ' + name);
  }
  assert.ok(packedMain.includes('DSH_DESKTOP_USER_DATA'), 'app.asar main lacks isolated user-data support');

  const patch = fs.readFileSync(file(unpacked, 'resources/runtime/profile-web/cordis.patch.yml'), 'utf8');
  noAuthorPath(patch, 'profile patch');
  assert.ok(patch.includes("dshHomePath('hooks.json')"), 'profile patch does not resolve hooks from DSH_HOME');
  assert.equal(sha256(Buffer.from(patch)), await hashFile(path.join(repo, 'build/profile.cordis.patch.yml')),
    'packaged profile patch does not match the controlled source');
  const version = JSON.parse(fs.readFileSync(file(unpacked, 'resources/runtime/VERSION.json'), 'utf8'));
  const hostPackage = JSON.parse(fs.readFileSync(file(unpacked,
    'resources/runtime/host/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  const expectedHost = bridge ? '0.1.5-rc.3' : JSON.parse(fs.readFileSync(path.join(repo, 'runtime/host/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'];
  const expectedWeb = bridge ? '0.3.23' : JSON.parse(fs.readFileSync(path.join(repo, 'runtime/profile-web/package.json'), 'utf8')).dependencies['@linxin666/dsh-web-all'];
  assert.equal(version.host, '@deepseek-ai/dsh@' + expectedHost);
  assert.equal(hostPackage.version, expectedHost);
  assert.equal(version.webAll, '@linxin666/dsh-web-all@' + expectedWeb);
  if (!bridge) {
    const seededManifest = JSON.parse(fs.readFileSync(file(unpacked, 'resources/runtime/profile-web/package.json'), 'utf8'));
    assert.ok(seededManifest.dsh?.profile?.bundles?.includes('dsh-model-fusion'), 'Fusion bundle is not selected in the seed');
    const yaml = createRequire(path.join(unpacked, 'resources/runtime/host/node_modules/__verification__.cjs'))('yaml');
    const seededRows = yaml.parse(patch, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
    assert.equal(seededRows.flatMap(row => row.insert ?? []).filter(row => row.id === 'dsh-model-fusion').length, 0, 'Fusion has a second manual loader');
    assert.equal(seededRows.filter(row => row.id === 'dsh-model-fusion' && row.name === 'dsh-model-fusion').length, 1, 'Fusion config override missing');
    assert.equal(JSON.parse(fs.readFileSync(file(unpacked, 'resources/runtime/profile-web/node_modules/dsh-model-fusion/package.json'), 'utf8')).version, '0.2.8');
    const webAllClient = fs.readFileSync(file(unpacked,
      'resources/runtime/profile-web/node_modules/@linxin666/dsh-web-all/lib/client.js'), 'utf8');
    // From 0.4.11 the aggregate no longer embeds the terminal; dsh-ssh carries the only copy.
    if (expectedWeb !== '0.4.11') assert.ok(webAllClient.includes('window.open(t, "_blank", "noopener,noreferrer");'),
      'Packaged dsh-web-all does not use the desktop-safe xterm link handler');
    assert.ok(!/const e = window\.open\(\);\s*if \(e\) \{\s*try \{\s*e\.opener = null;/.test(webAllClient),
      'Packaged dsh-web-all still uses the empty xterm popup flow');
    const sshClient = fs.readFileSync(file(unpacked,
      'resources/runtime/profile-web/node_modules/@linxin666/dsh-ssh/lib/client.js'), 'utf8');
    assert.ok(sshClient.includes('window.open(t, "_blank", "noopener,noreferrer");'),
      'Packaged dsh-ssh does not use the desktop-safe xterm link handler');
    assert.ok(!/const e = window\.open\(\);\s*if \(e\) \{\s*try \{\s*e\.opener = null;/.test(sshClient),
      'Packaged dsh-ssh still uses the empty xterm popup flow');
  }

  const zipListing = listingOf(zip);
  assert.match(zipListing.header, /^Type = zip\r?$/m, '7z does not recognize the ZIP archive');
  const listing = new Set(zipListing.entries.filter((entry) => !entry.directory).map((entry) => entry.path));
  const prefix = listing.has(productExe) ? '' : 'win-unpacked/';
  for (const rel of required) assert.ok(listing.has(prefix + rel), `ZIP is missing ${rel}`);
  const diskFiles = unpackedFiles(unpacked);
  const zipFiles = new Set([...listing].map((entry) => {
    assert.ok(entry.startsWith(prefix), `ZIP contains a file outside the app root: ${entry}`);
    return entry.slice(prefix.length);
  }));
  const missingInZip = [...diskFiles].filter((entry) => !zipFiles.has(entry));
  const extraInZip = [...zipFiles].filter((entry) => !diskFiles.has(entry));
  // electron-builder's NSIS CopyElevateHelper adds this installer helper
  // after the ZIP target has archived the app. Every other file must match.
  const unexpectedMissing = missingInZip.filter(entry => entry !== 'resources/elevate.exe');
  assert.equal(unexpectedMissing.length, 0, `ZIP omits unpacked file: ${unexpectedMissing[0] ?? ''}`);
  if (missingInZip.length > 0) {
    assert.equal(fs.readFileSync(file(unpacked, 'resources/elevate.exe')).subarray(0, 2).toString('ascii'),
      'MZ', 'NSIS-only elevation helper is not a Windows PE executable');
  }
  assert.equal(extraInZip.length, 0, `ZIP contains an extra file: ${extraInZip[0] ?? ''}`);
  assert.equal(zipFiles.size, diskFiles.size - missingInZip.length, 'ZIP and win-unpacked file counts differ');
  // This checks the compressed data and CRCs of every ZIP entry, including
  // the large runtime payload files that are not extracted individually.
  run7z(['t', zip], 8 * 1024 * 1024);
  for (const rel of compareFromZip) {
    assert.equal(sha256(zipBytes(zip, prefix + rel)), await hashFile(file(unpacked, rel)),
      `ZIP and unpacked file differ: ${rel}`);
  }

  const checksums = [
    [`${base}.exe`, await hashFile(installer)],
    [`${base}.zip`, await hashFile(zip)],
    ['win-unpacked/resources/app.asar', await hashFile(appAsar)],
    ['win-unpacked/resources/runtime/VERSION.json', await hashFile(file(unpacked,
      'resources/runtime/VERSION.json'))],
  ];
  let nestedPayloadIntegrity = 'not independently extracted';
  const nestedProof = path.join(release, 'nsis-payload-integrity.json');
  if (fs.existsSync(nestedProof)) {
    const proof = JSON.parse(fs.readFileSync(nestedProof, 'utf8'));
    assert.equal(proof.ok, true);
    assert.equal(proof.installerSha256, checksums[0][1], 'Nested proof belongs to another installer');
    assert.equal(proof.payload, 'nsis-payload-check/$PLUGINSDIR/app-64.7z');
    const nested = file(release, proof.payload);
    assert.ok(fs.lstatSync(nested).isFile() && !fs.lstatSync(nested).isSymbolicLink());
    assert.ok(fs.realpathSync.native(nested).startsWith(release + path.sep));
    assert.equal(fs.statSync(nested).size, appPayload.size);
    assert.equal(await hashFile(nested, 'sha512'), proof.sha512);
    run7z(['t', nested], 8 * 1024 * 1024);
    const nestedFiles = new Set(listingOf(nested).entries.filter(entry => !entry.directory).map(entry => entry.path));
    const missing = [...diskFiles].find(entry => !nestedFiles.has(entry));
    const extra = [...nestedFiles].find(entry => !diskFiles.has(entry));
    assert.equal(missing, undefined, 'NSIS nested payload omits: ' + missing);
    assert.equal(extra, undefined, 'NSIS nested payload adds: ' + extra);
    assert.equal(nestedFiles.size, diskFiles.size);
    nestedPayloadIntegrity = 'independently extracted; every archive entry CRC passed';
  }
  const receipt = {
    ok: true,
    host: version.host,
    webAll: version.webAll,
    builtAt: version.builtAt,
    requiredFiles: required.length,
    unpackedFiles: diskFiles.size,
    zipAllFiles: zipFiles.size,
    zipNsisOnlyOmissions: missingInZip,
    zipFilesCompared: compareFromZip.length,
    nsis: { type: 'Nsis', payload: '$PLUGINSDIR/app-64.7z', payloadBytes: appPayload.size,
      outerArchiveIntegrity: '7z t passed', nestedPayloadIntegrity },
    artifactSha256: Object.fromEntries(checksums),
  };
  writeIfMissingOrSame(path.join(release, 'SHA256SUMS.txt'),
    checksums.map(([name, hash]) => `${hash}  ${name}\n`).join(''));
  writeIfMissingOrSame(path.join(release, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
