import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listingOf } from '../scripts/verify-windows-artifacts.mjs';
const sevenZip = fileURLToPath(new URL('../node_modules/electron-winstaller/vendor/7z-x64.exe', import.meta.url));
test('real ZIP and 7z listings distinguish directories from Unicode payload files', t => {
  if (process.platform !== 'win32') return t.skip('Requires bundled Windows 7z');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifact-listing-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-artifact-listing-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'empty'), { recursive: true });
  fs.mkdirSync(path.join(source, 'nested'));
  fs.writeFileSync(path.join(source, 'control.txt'), 'control');
  fs.writeFileSync(path.join(source, 'nested', '中文 文件.txt'), 'unicode');
  for (const format of ['zip', '7z']) {
    const archive = path.join(root, 'payload.' + format);
    const built = spawnSync(sevenZip, ['a', '-bd', '-t' + format, '-mx=1', archive, '.'],
      { cwd: source, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(built.status, 0, built.stderr);
    const entries = listingOf(archive).entries;
    assert.deepEqual(entries.filter(entry => !entry.directory).map(entry => entry.path).sort(),
      ['control.txt', 'nested/中文 文件.txt']);
    assert.deepEqual(entries.filter(entry => entry.directory).map(entry => entry.path).sort(),
      ['empty', 'nested']);
  }
});