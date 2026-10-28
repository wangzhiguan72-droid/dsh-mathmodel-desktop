import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const oldDecoder = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe');
const arm64Payload = path.join(root, 'runtime', 'host', 'node_modules', 'node-pty',
  'prebuilds', 'win32-arm64', 'conpty', 'conpty.dll');

async function cachedEncoder() {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', '7zip@1.0.0');
  if (!existsSync(cache)) return null;
  for (const entry of await readdir(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('7zip-win-x64-')) continue;
    const binary = path.join(cache, entry.name, 'bin', '7za.exe');
    if (existsSync(binary)) return binary;
  }
  return null;
}

function run(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, timeout: 60000, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.error, undefined, `${binary} failed to run: ${result.error}`);
  return result;
}

test('NSIS bundled 7z decoder accepts BCJ but rejects automatic ARM64 filtering', async t => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('Requires x64 Windows');
  const encoder = await cachedEncoder();
  if (!encoder || !existsSync(oldDecoder) || !existsSync(arm64Payload)) {
    return t.skip('Cached builder 7z, bundled NSIS decoder, or packaged ARM64 node-pty payload unavailable');
  }
  const payload = await readFile(arm64Payload);
  assert.equal(payload.subarray(0, 2).toString(), 'MZ', 'ARM64 payload is not a PE file');
  assert.equal(payload.readUInt16LE(payload.readUInt32LE(0x3c) + 4), 0xaa64, 'Payload is not ARM64');

  const fixture = await mkdtemp(path.join(os.tmpdir(), 'dsh-nsis-codec-'));
  t.after(async () => {
    const resolved = path.resolve(fixture);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^dsh-nsis-codec-[\w-]+$/);
    await rm(resolved, { recursive: true, force: true });
  });
  await copyFile(arm64Payload, path.join(fixture, 'conpty.dll'));

  const common = ['a', '-t7z', '-mx=9', '-mtc=off', '-mta=off'];
  const automatic = run(encoder, [...common, 'automatic.7z', 'conpty.dll'], fixture);
  assert.equal(automatic.status, 0, `Modern 7z failed to create automatic archive:\n${automatic.stdout}\n${automatic.stderr}`);
  const unsupported = run(oldDecoder, ['t', 'automatic.7z'], fixture);
  assert.notEqual(unsupported.status, 0, 'Bundled NSIS decoder unexpectedly accepted automatic ARM64 filtering');
  assert.match(`${unsupported.stdout}\n${unsupported.stderr}`, /Unsupported Method/);

  const bcj = run(encoder, [...common, '-mf=BCJ', 'bcj.7z', 'conpty.dll'], fixture);
  assert.equal(bcj.status, 0, `Modern 7z failed to create BCJ archive:\n${bcj.stdout}\n${bcj.stderr}`);
  const compatible = run(oldDecoder, ['t', 'bcj.7z'], fixture);
  assert.equal(compatible.status, 0, `Bundled NSIS decoder rejected BCJ archive:\n${compatible.stdout}\n${compatible.stderr}`);
});

test('Windows archive policy selects BCJ while preserving an explicit filter', t => {
  const previous = process.env.ELECTRON_BUILDER_7Z_FILTER;
  t.after(() => {
    if (previous === undefined) delete process.env.ELECTRON_BUILDER_7Z_FILTER;
    else process.env.ELECTRON_BUILDER_7Z_FILTER = previous;
  });
  const { configureArchiveFilter } = require('../scripts/after-pack.cjs');
  const { compute7zCompressArgs } = require('app-builder-lib/out/targets/archive.js');
  delete process.env.ELECTRON_BUILDER_7Z_FILTER;
  configureArchiveFilter('linux');
  assert.equal(process.env.ELECTRON_BUILDER_7Z_FILTER, undefined);
  configureArchiveFilter('win32');
  assert.equal(process.env.ELECTRON_BUILDER_7Z_FILTER, 'BCJ');
  assert.ok(compute7zCompressArgs('7z').includes('-mf=BCJ'));
  process.env.ELECTRON_BUILDER_7Z_FILTER = 'ARM';
  configureArchiveFilter('win32');
  assert.equal(process.env.ELECTRON_BUILDER_7Z_FILTER, 'ARM');
});
