#!/usr/bin/env node
/** Create the desktop update manifest from a finished Windows ZIP release. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { compareVersions } = require('../src/desktop-updates.cjs');

const schema = 'dsh.desktop-update/v1';
const appId = 'com.deepseek.harness.mathmodel';
const upgradeFlags = ['--upgrade-zip', '--upgrade-version', '--upgrade-url', '--upgrade-min-version'];
const baseFlags = ['--zip', '--version', '--url', '--notes-file'];
const flags = new Set([...baseFlags, '--base-feed', '--out', ...upgradeFlags, '--upgrade-notes-file']);

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flags.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--') || options[flag]) {
      throw new Error(`Invalid or duplicate argument: ${flag ?? '(missing)'}`);
    }
    options[flag] = argv[i + 1];
  }
  if (options['--base-feed']) {
    // A published base route is reused as is; only the upgrade route is built here.
    if (baseFlags.some(flag => options[flag])) throw new Error('--base-feed replaces --zip, --version, --url and --notes-file');
    if (!options['--upgrade-zip']) throw new Error('--base-feed requires an upgrade');
  }
  for (const flag of options['--base-feed'] ? ['--out'] : ['--zip', '--version', '--url', '--out']) {
    if (!options[flag]) throw new Error(`Missing required argument: ${flag}`);
  }
  if (upgradeFlags.some(flag => options[flag]) && upgradeFlags.some(flag => !options[flag])) {
    throw new Error('Upgrade ZIP, version, URL and minimum version must be supplied together');
  }
  if (options['--upgrade-notes-file'] && !options['--upgrade-zip']) throw new Error('Upgrade notes require an upgrade');
  return options;
}

function validVersion(version) {
  // SemVer 2.0: no leading zeros in numeric identifiers.
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || (match[4] && match[4].split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) {
    throw new Error(`Invalid SemVer version: ${version}`);
  }
}

function validUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Update ZIP URL must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('Update ZIP URL must be HTTPS without credentials or fragments');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(host)) {
    throw new Error('Update ZIP URL cannot target loopback');
  }
  if (!url.pathname.toLowerCase().endsWith('.zip')) throw new Error('Update URL must point to a ZIP asset');
  return url.href;
}

async function inspectZip(zipPath) {
  if (path.extname(zipPath).toLowerCase() !== '.zip') throw new Error('Release artifact must be a .zip file');
  const info = await fs.lstat(zipPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 22) throw new Error('Release ZIP must be a nonempty regular file');
  const handle = await fs.open(zipPath, 'r');
  try {
    const start = Buffer.alloc(4);
    await handle.read(start, 0, 4, 0);
    if (start.readUInt32LE(0) !== 0x04034b50) throw new Error('Release artifact lacks ZIP local file header');
    const tailSize = Math.min(info.size, 22 + 0xffff);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, info.size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Release artifact lacks a complete ZIP central directory');
    const entries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0 ||
        entries === 0 || entries !== tail.readUInt16LE(eocd + 8) ||
        centralOffset + centralSize > info.size - tailSize + eocd) {
      throw new Error('Release ZIP central directory is incomplete or unsupported');
    }
    const central = Buffer.alloc(4);
    await handle.read(central, 0, 4, centralOffset);
    if (central.readUInt32LE(0) !== 0x02014b50) throw new Error('Release ZIP central directory is invalid');
  } finally {
    await handle.close();
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(zipPath)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest('hex') };
}

/** Reuse the base route of an already published manifest, revalidating every field it carries. */
async function readBaseFeed(feedPath, outPath) {
  const resolved = path.resolve(feedPath);
  if (resolved === outPath) throw new Error('Output cannot overwrite the base feed');
  const info = await fs.lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('Base feed must be a small regular file');
  const base = JSON.parse(await fs.readFile(resolved, 'utf8'));
  const asset = base?.windows?.x64;
  if (base?.schema !== schema || base.appId !== appId || base.channel !== 'stable' || typeof base.notes !== 'string'
    || Buffer.byteLength(base.notes) > 16 * 1024 || typeof asset?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
    throw new Error('Base feed is not a published desktop update manifest');
  }
  validVersion(base.version);
  const url = validUrl(asset.url);
  if (url !== asset.url) throw new Error('Base feed URL is not canonical');
  return { schema, appId, channel: 'stable', version: base.version, notes: base.notes,
    windows: { x64: { url, sha256: asset.sha256, bytes: asset.bytes } } };
}

export async function createUpdateFeed(argv) {
  const options = parseArgs(argv);
  const outPath = path.resolve(options['--out']);
  let feed, zipPath;
  if (options['--base-feed']) {
    feed = await readBaseFeed(options['--base-feed'], outPath);
  } else {
    validVersion(options['--version']);
    const url = validUrl(options['--url']);
    zipPath = path.resolve(options['--zip']);
    if (zipPath === outPath) throw new Error('Output cannot overwrite the ZIP');
    const notes = options['--notes-file'] ? await fs.readFile(options['--notes-file'], 'utf8') : '';
    if (Buffer.byteLength(notes) > 16 * 1024) throw new Error('Release notes exceed 16 KiB');
    const { bytes, sha256 } = await inspectZip(zipPath);
    feed = {
      schema, appId, channel: 'stable', version: options['--version'], notes,
      windows: { x64: { url, sha256, bytes } },
    };
  }
  if (options['--upgrade-zip']) {
    const upgradeVersion = options['--upgrade-version'];
    const minVersion = options['--upgrade-min-version'];
    validVersion(upgradeVersion);
    validVersion(minVersion);
    if (compareVersions(minVersion, feed.version) < 0 || compareVersions(upgradeVersion, minVersion) <= 0) {
      throw new Error('Upgrade version order is invalid');
    }
    const upgradeUrl = validUrl(options['--upgrade-url']);
    const upgradeZip = path.resolve(options['--upgrade-zip']);
    if (upgradeZip === zipPath || upgradeZip === outPath) throw new Error('Upgrade ZIP must be a separate artifact');
    const upgradeNotes = options['--upgrade-notes-file'] ? await fs.readFile(options['--upgrade-notes-file'], 'utf8') : '';
    if (Buffer.byteLength(upgradeNotes) > 16 * 1024) throw new Error('Upgrade notes exceed 16 KiB');
    const upgradeAsset = await inspectZip(upgradeZip);
    feed.upgrades = [{ schema, appId, channel: 'stable', minVersion, version: upgradeVersion,
      notes: upgradeNotes, windows: { x64: { url: upgradeUrl, ...upgradeAsset } } }];
  }
  // Create beside the destination, then replace it only after every input validates.
  const temporary = `${outPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(feed, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, outPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return feed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createUpdateFeed(process.argv.slice(2)).then(feed => {
    process.stdout.write(`Update manifest created for ${feed.version} (${feed.windows.x64.bytes} bytes, SHA-256 ${feed.windows.x64.sha256})\n`);
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
