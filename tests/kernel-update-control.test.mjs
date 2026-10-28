import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUpdateKernelCLI } from '../scripts/update-kernel.mjs';

test('kernel CLI checks local pins without changing source or user data', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-cli-')));
  const host = path.join(root, 'runtime', 'host');
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.5-rc.3' } }));
  const sentinel = path.join(root, 'personal-data.txt');
  fs.writeFileSync(sentinel, 'retain');
  const gate = path.join(root, 'plugins', 'dsh-mathmodel', 'src', 'version.js');
  fs.mkdirSync(path.dirname(gate), { recursive: true });
  fs.writeFileSync(gate, "export const SUPPORTED_DSH_VERSIONS = ['0.1.5-rc.3'];\n");
  const before = fs.readFileSync(path.join(host, 'package.json'));
  const gateBefore = fs.readFileSync(gate);
  const lines = [];
  try {
    assert.equal(runUpdateKernelCLI(['--check'], { root, log: (line) => lines.push(line) }), 0);
    assert.match(lines.join('\n'), /0\.1\.5-rc\.3/);
    assert.deepEqual(fs.readFileSync(path.join(host, 'package.json')), before);
    assert.deepEqual(fs.readFileSync(gate), gateBefore);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'retain');
  } finally {
    assert.ok(fs.realpathSync.native(root).startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy automatic update, plugin update and partial rollback fail closed', () => {
  const messages = [];
  const options = {
    root: path.join(os.tmpdir(), 'nonexistent-dsh-kernel-cli'),
    error: (line) => messages.push(line),
  };
  for (const args of [[], ['--auto'], ['--plugins'], ['--rollback'], ['--update', '0.1.6'], ['--check', '--auto']]) {
    assert.equal(runUpdateKernelCLI(args, options), 2, JSON.stringify(args));
  }
  assert.match(messages.join('\n'), /complete desktop release/);
});
