import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCodeTask } from '../scripts/deepseek-code-benchmark.mjs';
import { tasks } from '../scripts/deepseek-code-tasks.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const cases = [
  {
    id: 'csv-parser',
    originalSha256: '8ff29b2ba169711ea65b4264b85f38b36d6bba80cf1e05db521123cd4dc44a6b',
    boundaryTest: String.raw`const assert = require('node:assert/strict');
const { parseCsv } = require('./solution.cjs');
assert.deepEqual(parseCsv('\n\n'), [[''], ['']]);
assert.deepEqual(parseCsv('a\r\n\r\nb\n'), [['a'], [''], ['b']]);
assert.deepEqual(parseCsv('"a\rb",c'), [['a\rb', 'c']]);
assert.deepEqual(parseCsv('"",\n'), [['', '']]);
assert.deepEqual(parseCsv('a,b\n'), [['a', 'b']]);
assert.throws(() => parseCsv('a\rb'), Error);
`,
  },
  {
    id: 'dependency-waves',
    originalSha256: '4082e07f784bb97c1a9fd13df3bd0bda77080f855aed540d4f2e9eca51073155',
    boundaryTest: String.raw`const assert = require('node:assert/strict');
const { dependencyWaves } = require('./solution.cjs');
assert.throws(() => dependencyWaves({ a: ['a'] }), Error);
assert.throws(() => dependencyWaves({ a: [], b: ['b', 'a'], c: ['a'] }), Error);
assert.deepEqual(dependencyWaves({ z: ['a', 'a'], a: [], x: ['z'], b: [] }), [['a', 'b'], ['z'], ['x']]);
assert.throws(() => dependencyWaves({ a: ['b'], b: ['a'] }), Error);
`,
  },
];

function sourceFor(entry, kind) {
  const file = kind === 'original'
    ? path.join(root, 'fixtures', 'deepseek-regressions', `${entry.id}.original.cjs`)
    : path.join(root, '..', 'scripts', 'benchmark-repairs', `${entry.id}.cjs`);
  return fs.readFileSync(file, 'utf8');
}

function evaluate(task, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-code-repair-'));
  try {
    return evaluateCodeTask({ task, source, directory });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const entry of cases) {
  const task = tasks.find(candidate => candidate.id === entry.id);

  test(`${entry.id}: original artifact is preserved and still fails the complete hidden suite`, () => {
    const original = sourceFor(entry, 'original');
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'fixtures',
      'deepseek-regressions', `${entry.id}.original.cjs`))).digest('hex'), entry.originalSha256);
    const result = evaluate(task, original);
    assert.equal(result.checks.public.passed, true, result.checks.public.stderr);
    assert.equal(result.checks.hidden.passed, false, `${entry.id} original unexpectedly passed`);
  });

  test(`${entry.id}: repaired code passes the unchanged public and hidden suites`, () => {
    const result = evaluate(task, sourceFor(entry, 'repaired'));
    assert.equal(result.passed, true, JSON.stringify(result.checks));
  });

  test(`${entry.id}: original fails and repair passes additional boundary checks`, () => {
    const boundaryTask = { ...task, hiddenTest: entry.boundaryTest };
    const original = evaluate(boundaryTask, sourceFor(entry, 'original'));
    const repaired = evaluate(boundaryTask, sourceFor(entry, 'repaired'));
    assert.equal(original.checks.hidden.passed, false, `${entry.id} original unexpectedly passed`);
    assert.equal(repaired.passed, true, JSON.stringify(repaired.checks));
  });
}
