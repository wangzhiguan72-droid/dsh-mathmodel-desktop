import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCodeSchedule, evaluateCodeTask } from '../scripts/deepseek-code-benchmark.mjs';

test('public-only evaluation neither reads nor materializes hidden tests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-only-grade-'));
  try {
    const task = { publicTest: "require('node:assert/strict').equal(require('./solution.cjs'),42)",
      get hiddenTest() { throw new Error('hidden test must remain private until final acceptance'); } };
    const result = evaluateCodeTask({ task, source: 'module.exports=42', directory, checks: ['public'] });
    assert.equal(result.passed, true); assert.deepEqual(Object.keys(result.checks), ['public']);
    assert.equal(fs.existsSync(path.join(directory, 'hidden.test.cjs')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
import { tasks } from '../scripts/deepseek-code-tasks.mjs';

test('seeded paired schedule has balanced arm order, task and round coverage', () => {
  const a = makeCodeSchedule(['a', 'b', 'c', 'd'], 12345);
  assert.deepEqual(a, makeCodeSchedule(['a', 'b', 'c', 'd'], 12345));
  assert.notDeepEqual(a, makeCodeSchedule(['a', 'b', 'c', 'd'], 321));
  assert.equal(a.length, 16);
  assert.equal(a.filter(row => row.position === 1 && row.preset === 'task-00').length, 4);
  assert.equal(new Set(a.map(row => `${row.taskId}/${row.round}/${row.preset}`)).size, 16);
  for (let i = 0; i < a.length; i += 2) {
    assert.equal(a[i].taskId, a[i + 1].taskId); assert.equal(a[i].round, a[i + 1].round);
    assert.notEqual(a[i].preset, a[i + 1].preset);
  }
});

test('external evaluator scores actual code and preserves hidden failures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-grade-'));
  try {
    const task = { publicTest: "require('node:assert/strict').equal(require('./solution.cjs')(2),4)",
      hiddenTest: "require('node:assert/strict').equal(require('./solution.cjs')(-3),9)" };
    assert.equal(evaluateCodeTask({ task, source: 'module.exports=x=>x*x;', directory }).passed, true);
    const wrong = evaluateCodeTask({ task, source: 'module.exports=x=>x*2;', directory });
    assert.equal(wrong.passed, false); assert.equal(wrong.checks.public.passed, true); assert.equal(wrong.checks.hidden.passed, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('all reference solutions pass with evaluation restrictions enabled', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-grade-references-'));
  try {
    for (const task of tasks) {
      const result = evaluateCodeTask({ task, source: task.reference, directory });
      assert.equal(result.passed, true, `${task.id}: ${result.checks.public.stderr}\n${result.checks.hidden.stderr}`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('evaluator restricts filesystem, subprocess, module and network entry points', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'code-grade-boundary-'));
  const directory = path.join(parent, 'evaluation');
  const sentinel = path.join(parent, 'outside-sentinel.txt');
  fs.writeFileSync(sentinel, 'must remain unread and unchanged');
  try {
    const source = `module.exports = {
      read: () => require('node:fs').readFileSync(${JSON.stringify(sentinel)}, 'utf8'),
      write: () => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'changed'),
      spawn: () => require('node:child_process').spawnSync('node', ['-v']),
      http: () => require('node:http'),
      net: () => require('node:net'),
      dynamicHttp: () => import('node:http'),
      fetch: () => fetch('https://example.invalid'),
      websocket: () => new WebSocket('ws://example.invalid'),
      directBuiltin: () => process.getBuiltinModule('node:fs'),
      binding: () => process.binding('fs'),
      linkedBinding: () => process._linkedBinding('fs'),
      earlyExit: () => process.exit(0),
      signal: () => process.kill(process.pid),
      evalString: () => new Function('return 1')(),
    };`;
    const publicTest = `const assert = require('node:assert/strict');
const candidate = require('./solution.cjs');
assert.equal(process.permission.has('fs.read', ${JSON.stringify(sentinel)}), false);
assert.equal(process.permission.has('fs.write', ${JSON.stringify(path.join(directory, 'solution.cjs'))}), false);
for (const name of ['read', 'write', 'spawn', 'http', 'net', 'directBuiltin', 'binding', 'linkedBinding', 'earlyExit', 'signal']) {
  assert.throws(candidate[name], /blocked/);
}
assert.throws(candidate.fetch, TypeError);
assert.throws(candidate.websocket, TypeError);
assert.throws(candidate.evalString, EvalError);
process.exitCode = 1;
candidate.dynamicHttp().then(
  () => { throw new Error('dynamic import escaped the module guard'); },
  error => { assert.match(error.message, /blocked/); process.exitCode = 0; },
);
`;
    const task = { publicTest, hiddenTest: "require('node:assert/strict').ok(true)" };
    const result = evaluateCodeTask({ task, source, directory });
    assert.equal(result.passed, true, result.checks.public.stderr);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain unread and unchanged');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
