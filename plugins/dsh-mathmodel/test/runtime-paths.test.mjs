import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntimeFile } from './support/runtime.mjs';

test('显式 runtime 根缺少官方包时失败，不改用另一份安装', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(resolveRuntimeFile('@deepseek-ai/dsh/package.json', { DSH_TEST_RUNTIME_ROOT: root }),
    (error) => error.message.includes(root) && !error.message.includes('resources/runtime'));
});

test('显式 runtime 根读取指定安装的文件', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'manifest.json');
  await writeFile(file, '{}');
  assert.equal(await resolveRuntimeFile('manifest.json', { DSH_TEST_RUNTIME_ROOT: root }), file);
});
