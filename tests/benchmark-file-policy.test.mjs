import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBenchmarkFileGuard } from '../scripts/benchmark-file-policy.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-policy-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  for (const name of ['TASK.md', 'public.test.cjs', 'solution.cjs']) fs.writeFileSync(path.join(workspace, name), 'fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auditFile = path.join(root, 'policy.jsonl');
  return { root, workspace, auditFile, guard: createBenchmarkFileGuard({ workspace, auditFile }),
    call: (name, file_path) => ({ name, arguments: { file_path }, callId: 'test' }) };
}

test('only three pinned fixture reads and solution edits are admitted with content-free auditing', t => {
  const f = fixture(t);
  for (const name of ['TASK.md', 'public.test.cjs', 'solution.cjs']) assert.equal(f.guard(f.call('read', name)), undefined);
  assert.equal(f.guard(f.call('write', path.join(f.workspace, 'solution.cjs'))), undefined);
  assert.equal(f.guard({ name: 'edit', arguments: JSON.stringify({ file_path: './solution.cjs', old_string: 'SECRET-PAYLOAD' }) }), undefined);
  assert.match(f.guard(f.call('write', 'TASK.md')), /read-only/);
  assert.match(f.guard(f.call('pwsh', 'solution.cjs')), /tool-not-allowed/);
  assert.match(f.guard({ name: 'read', arguments: 'SECRET-CANARY-MALFORMED-JSON' }), /invalid-tool-arguments/);
  assert.ok(!fs.readFileSync(f.auditFile, 'utf8').includes('SECRET-CANARY-MALFORMED-JSON'));
  assert.ok(!fs.readFileSync(f.auditFile, 'utf8').includes('SECRET-PAYLOAD'));
});

test('outside files, traversal, ADS, URI, device and malformed paths fail closed', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'solution.cjs'), 'outside');
  for (const value of [path.join(f.root, 'solution.cjs'), '../solution.cjs', 'sub/../solution.cjs',
    'solution.cjs:secret', 'C:solution.cjs', 'file:///solution.cjs', '\\\\?\\C:\\solution.cjs',
    'solution.cjs.', 'solution.cjs ', 'solution.cjs\0', 'hidden.test.cjs', '', null]) {
    assert.match(f.guard(f.call('read', value)), /denied/, String(value));
  }
});

test('hard links and symlink substitutions cannot turn an allowed filename into an outside read', t => {
  const f = fixture(t), file = path.join(f.workspace, 'solution.cjs'), outside = path.join(f.root, 'outside.cjs');
  fs.writeFileSync(outside, 'outside'); fs.unlinkSync(file); fs.linkSync(outside, file);
  assert.match(f.guard(f.call('read', 'solution.cjs')), /linked-or-nonregular/);
  fs.unlinkSync(file); fs.symlinkSync(outside, file, 'file');
  assert.match(f.guard(f.call('read', 'solution.cjs')), /linked-or-nonregular/);
});

test('workspace replacement by a junction fails the pinned identity check', t => {
  const f = fixture(t), renamed = path.join(f.root, 'original'), outside = path.join(f.root, 'other');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'solution.cjs'), 'outside');
  fs.renameSync(f.workspace, renamed); fs.symlinkSync(outside, f.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(f.guard(f.call('read', 'solution.cjs')), /workspace-identity-changed/);
});
