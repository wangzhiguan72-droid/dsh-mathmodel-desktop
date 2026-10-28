import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tasks, referenceSolutions } from '../scripts/deepseek-code-tasks.mjs';

function runFixture(source, check) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-code-task-fixture-'));
  try {
    fs.writeFileSync(path.join(directory, 'solution.cjs'), source);
    fs.writeFileSync(path.join(directory, 'check.test.cjs'), check);
    return spawnSync(process.execPath, ['check.test.cjs'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('four distinct software tasks have private references and meaningful hidden checks', () => {
  assert.equal(tasks.length, 4);
  assert.equal(new Set(tasks.map(task => task.id)).size, 4);
  for (const task of tasks) {
    for (const field of ['id', 'spec', 'starter', 'publicTest', 'hiddenTest', 'reference']) {
      assert.equal(typeof task[field], 'string', `${task.id}.${field}`);
      assert.ok(task[field].length > 0, `${task.id}.${field}`);
    }
    assert.equal(task.reference, referenceSolutions[task.id]);
    assert.ok((task.hiddenTest.match(/assert\./g) ?? []).length >= 8, task.id);
    assert.doesNotMatch(task.starter + task.publicTest + task.spec, /referenceSolutions|hiddenTest/);
  }
});

for (const task of tasks) {
  test(`${task.id}: reference passes public and hidden tests in fresh Node processes`, () => {
    for (const [name, check] of [['public', task.publicTest], ['hidden', task.hiddenTest]]) {
      const run = runFixture(task.reference, check);
      assert.equal(run.error, undefined, `${name}: ${run.error?.message}`);
      assert.equal(run.status, 0, `${name}: ${run.stderr}`);
    }
  });

  test(`${task.id}: starter fails its visible acceptance test`, () => {
    const run = runFixture(task.starter, task.publicTest);
    assert.equal(run.error, undefined, run.error?.message);
    assert.notEqual(run.status, 0, task.id);
  });
}
