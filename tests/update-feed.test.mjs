import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUpdateFeed } from '../scripts/create-update-feed.mjs';

const script = fileURLToPath(new URL('../scripts/create-update-feed.mjs', import.meta.url));

// A valid stored ZIP with one empty entry; its CRC-32 is zero.
function tinyZip() {
  const name = Buffer.from('empty.txt');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-feed-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-update-feed-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const zip = path.join(root, 'desktop.zip');
  const out = path.join(root, 'desktop-update.json');
  fs.writeFileSync(zip, tinyZip());
  const args = ['--zip', zip, '--version', '0.1.1', '--url',
    'https://github.com/owner/repo/releases/download/v0.1.1/desktop.zip', '--out', out];
  return { root, zip, out, args };
}

test('published manifest derives exact size and SHA-256 from the release ZIP', async t => {
  const { root, zip, out, args } = fixture(t);
  const notes = path.join(root, 'notes.txt');
  fs.writeFileSync(notes, '修复更新回滚\n');
  const feed = await createUpdateFeed([...args, '--notes-file', notes]);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), feed);
  assert.equal(feed.schema, 'dsh.desktop-update/v1');
  assert.equal(feed.appId, 'com.deepseek.harness.mathmodel');
  assert.equal(feed.channel, 'stable');
  assert.equal(feed.version, '0.1.1');
  assert.equal(feed.notes, '修复更新回滚\n');
  assert.equal(feed.windows.x64.bytes, fs.statSync(zip).size);
  assert.equal(feed.windows.x64.sha256,
    createHash('sha256').update(fs.readFileSync(zip)).digest('hex'));
  assert.deepEqual(fs.readdirSync(root).sort(), ['desktop-update.json', 'desktop.zip', 'notes.txt']);
});

test('CLI creates the same manifest without importing or publishing anything', t => {
  const { out, args } = fixture(t);
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Update manifest created for 0\.1\.1/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).version, '0.1.1');
});

test('two-hop manifest pins both independent ZIPs and rejects incomplete upgrade inputs', async t => {
  const { root, zip, out, args } = fixture(t);
  const kernelZip = path.join(root, 'kernel.zip');
  fs.writeFileSync(kernelZip, tinyZip());
  const set = (items, flag, value) => items.map((item, index) => items[index - 1] === flag ? value : item);
  const bridgeArgs = set(args, '--version', '0.1.3-bridge.1');
  const upgrade = ['--upgrade-zip', kernelZip, '--upgrade-version', '0.1.3',
    '--upgrade-min-version', '0.1.3-bridge.1', '--upgrade-url',
    'https://github.com/owner/repo/releases/download/v0.1.3/kernel.zip'];
  const feed = await createUpdateFeed([...bridgeArgs, ...upgrade]);
  assert.equal(feed.version, '0.1.3-bridge.1');
  assert.equal(feed.upgrades.length, 1);
  assert.equal(feed.upgrades[0].version, '0.1.3');
  assert.equal(feed.upgrades[0].minVersion, '0.1.3-bridge.1');
  assert.equal(feed.windows.x64.sha256, createHash('sha256').update(fs.readFileSync(zip)).digest('hex'));
  assert.equal(feed.upgrades[0].windows.x64.sha256,
    createHash('sha256').update(fs.readFileSync(kernelZip)).digest('hex'));
  const saved = fs.readFileSync(out, 'utf8');
  for (const invalid of [
    [...bridgeArgs, '--upgrade-zip', kernelZip],
    [...bridgeArgs, ...set(upgrade, '--upgrade-min-version', '0.1.2')],
    [...bridgeArgs, ...set(upgrade, '--upgrade-version', '0.1.3-bridge.1')],
    [...bridgeArgs, ...set(upgrade, '--upgrade-url', 'http://example.test/kernel.zip')],
  ]) {
    await assert.rejects(createUpdateFeed(invalid));
    assert.equal(fs.readFileSync(out, 'utf8'), saved);
  }
});

test('invalid versions, URLs, options and ZIPs leave an existing manifest untouched', async t => {
  const { zip, out, args } = fixture(t);
  fs.writeFileSync(out, 'existing feed');
  const replace = (flag, value) => args.map((item, index) => args[index - 1] === flag ? value : item);
  for (const bad of [
    replace('--version', '01.2.3'),
    replace('--version', '1.2.3-01'),
    replace('--url', 'http://example.com/desktop.zip'),
    replace('--url', 'https://user:pass@example.com/desktop.zip'),
    replace('--url', 'https://localhost/desktop.zip'),
    replace('--url', 'https://127.0.0.1/desktop.zip'),
    replace('--url', 'https://example.com/desktop.exe'),
    [...args, '--unknown', 'value'],
    [...args, '--version', '1.2.3'],
  ]) {
    await assert.rejects(createUpdateFeed(bad));
    assert.equal(fs.readFileSync(out, 'utf8'), 'existing feed');
  }
  fs.writeFileSync(zip, Buffer.from('PK\x03\x04incomplete'));
  await assert.rejects(createUpdateFeed(args), /ZIP/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'existing feed');
});
