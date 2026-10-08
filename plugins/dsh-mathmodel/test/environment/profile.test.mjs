import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { profileRoot } from '../support/environment.mjs';

const webPatch = resolve(profileRoot, 'cordis.patch.yml');

test('Web Profile 全局加载一次生图工具，使任意 Agent 模式可用且不重复注册', async () => {
  const source = await readFile(webPatch, 'utf8');
  assert.match(source, /id: mathmodel-tools/);
  assert.match(source, /@deepseek-harness\/dsh-mathmodel\/tools/);
});


test('真实 Profile 将技能根接到 DSH_HOME 并禁用重复的官方 Skill UI', async () => {
  const source = await readFile(webPatch, 'utf8');
  assert.match(source, /skillRoot:\s*!!js dshHomePath\('skills'\)/);
  assert.match(source, /id: ui-skill[\s\S]*?disabled: true/);
  assert.equal((source.match(/id: mathmodel-tools\s*$/gm) ?? []).length, 1);
  assert.equal((source.match(/id: mathmodel\s*$/gm) ?? []).length, 1);
});
