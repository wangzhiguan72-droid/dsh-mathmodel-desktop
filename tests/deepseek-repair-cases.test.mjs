import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateCodeTask } from '../scripts/deepseek-code-benchmark.mjs';
import { repairTasks } from '../scripts/deepseek-repair-cases.mjs';
import { tasks } from '../scripts/deepseek-code-tasks.mjs';

function evaluate(task, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-repair-case-'));
  try {
    return evaluateCodeTask({ task, source, directory });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('repair cases preserve the original spec and keep hidden checks outside public context', () => {
  assert.deepEqual(repairTasks.map(task => task.id), ['csv-parser', 'dependency-waves']);
  for (const task of repairTasks) {
    const original = tasks.find(candidate => candidate.id === task.id);
    assert.equal(task.spec, original.spec);
    assert.equal(task.reference, original.reference);
    assert.ok(task.hiddenTest.includes('trial'));
    assert.doesNotMatch(task.spec + task.starter + task.publicTest,
      /0x4e24d19b|0x73c1e5a9|Independent, slow oracle|serializer roundtrip trial/);
  }
});

for (const task of repairTasks) {
  test(`${task.id}: reference passes visible regression and independent holdout`, () => {
    const result = evaluate(task, task.reference);
    assert.equal(result.checks.public.passed, true, result.checks.public.stderr);
    assert.equal(result.checks.hidden.passed, true, result.checks.hidden.stderr);
  });

  test(`${task.id}: original failed source is diagnosed by visible regression`, () => {
    const result = evaluate(task, task.starter);
    assert.equal(result.checks.public.passed, false, 'Original unexpectedly passes public regression');
    assert.match(result.checks.public.stderr, /AssertionError/);
  });
}
