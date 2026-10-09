import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compareVersions, validateRelease, checkForUpdate, prepareUpdate, inspectZip, verifyExtractedZip } = require('../src/desktop-updates.cjs');

function release(url, sha256 = 'a'.repeat(64)) {
  return { schema: 'dsh.desktop-update/v1', appId: 'com.deepseek.harness.mathmodel', channel: 'stable',
    version: '0.1.2', notes: 'fixture', windows: { x64: { url, sha256, bytes: 128 } } };
}

function oneEntryZip(name, attributes = 0) {
  const bytes = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(bytes.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(3 << 8, 4);
  central.writeUInt16LE(bytes.length, 28); central.writeUInt32LE(attributes >>> 0, 38);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + bytes.length, 12); end.writeUInt32LE(local.length + bytes.length, 16);
  return Buffer.concat([local, bytes, central, bytes, end]);
}

test('release versions follow SemVer ordering and reject malformed identifiers', () => {
  assert.equal(compareVersions('0.1.2-rc.10', '0.1.2-rc.9'), 1);
  assert.equal(compareVersions('0.1.2', '0.1.2-rc.10'), 1);
  assert.equal(compareVersions('0.1.2+build.2', '0.1.2+build.1'), 0);
  for (const version of ['01.2.3', '1.2.3-rc..1', '1.2.3-01']) assert.throws(() => compareVersions(version, '0.1.1'));
});

test('foreign feeds and unsafe download URLs are refused', () => {
  assert.throws(() => validateRelease({ ...release('https://example.test/app.zip'), appId: 'foreign-app' }));
  assert.throws(() => validateRelease(release('http://example.test/app.zip')));
  assert.throws(() => validateRelease(release('https://user:password@example.test/app.zip')));
});

test('ZIP inspection rejects traversal, Windows aliases and links before extraction', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-zip-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const filename = path.join(root, 'fixture.zip');
  fs.writeFileSync(filename, oneEntryZip('resources/file.txt'));
  assert.deepEqual(inspectZip(filename), { files: 1 });
  for (const name of ['../escape.txt', '/absolute', 'C:/escape', 'resources/NUL.txt', 'resources/bad. ', 'resources/a\0b']) {
    fs.writeFileSync(filename, oneEntryZip(name)); assert.throws(() => inspectZip(filename), name);
  }
  fs.writeFileSync(filename, oneEntryZip('link', 0xa000 << 16));
  assert.throws(() => inspectZip(filename), /link/);
});

test('metadata checks never download and a bad SHA never changes the current app', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-http-test-'));
  const installDir = path.join(root, 'app'); fs.mkdirSync(installDir);
  const sentinel = path.join(installDir, 'old.txt'); fs.writeFileSync(sentinel, 'old bytes');
  let assets = 0, base;
  const server = http.createServer((request, response) => {
    if (request.url === '/feed') response.end(JSON.stringify(release(base + '/asset')));
    else { assets++; response.end(Buffer.alloc(128)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true });
  });
  const result = await checkForUpdate({ feedUrl: base + '/feed', currentVersion: '0.1.1', allowLoopbackHttp: true });
  assert.equal(result.available, true); assert.equal(assets, 0);
  await assert.rejects(prepareUpdate({ release: result.release, currentVersion: '0.1.1', installDir,
    executableName: 'app.exe', userDataDir: path.join(root, 'data'), allowLoopbackHttp: true }), /SHA-256/);
  assert.equal(assets, 1); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'old bytes');
  assert.deepEqual(fs.readdirSync(root).sort(), ['app', 'data']);
});

test('an absent update feed preserves its HTTP status for the update UI', async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  await assert.rejects(checkForUpdate({ feedUrl: `http://127.0.0.1:${server.address().port}/feed`,
    currentVersion: '0.1.1', allowLoopbackHttp: true }), error => error.statusCode === 404);
});

test('missing, truncated and extra extracted files reject the whole release', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-extracted-update-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const manifest = { files: 1, entries: [{ name: 'optional.txt', size: 5 }] };
  assert.throws(() => verifyExtractedZip(root, manifest), /count/);
  fs.writeFileSync(path.join(root, 'optional.txt'), 'four');
  assert.throws(() => verifyExtractedZip(root, manifest), /truncated/);
  fs.writeFileSync(path.join(root, 'optional.txt'), 'five!');
  verifyExtractedZip(root, manifest);
  fs.writeFileSync(path.join(root, 'unexpected.txt'), 'extra');
  assert.throws(() => verifyExtractedZip(root, manifest), /count/);
});
