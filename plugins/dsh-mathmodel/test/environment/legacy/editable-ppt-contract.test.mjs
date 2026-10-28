import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dshHome } from '../../support/environment.mjs';
import { resolveStandardPreset } from '../../support/runtime.mjs';

const presetFile = resolve(dshHome, '.agent-presets/editable-ppt/agent.cordis.yml');
const ids = (text) => [...text.matchAll(/^\s*- id:\s*([^\s]+)\s*$/gm)].map((match) => match[1]);

test('editable-ppt Persona 声明 DSH 当前连接边界但不复制工具 schema', async () => {
  const source = await readFile(presetFile, 'utf8');
  assert.match(source, /DSH 当前生图连接/);
  assert.match(source, /editable_ppt_image/);
  assert.match(source, /禁止 Codex 和任何后端回退/);
  assert.match(source, /任务开始时锁定/);
  // Persona 保持短小：不含枚举 schema、错误矩阵或执行步骤清单。
  assert.doesNotMatch(source, /additionalProperties|"enum"|codex_backend_forbidden|dsh_current_cli_forbidden/);
  const personaText = source.match(/text: >-\n((?: {6}.+\n?)+)/)?.[1] ?? '';
  assert.ok(personaText.length > 0 && personaText.length < 800, `Persona 应保持短小，当前 ${personaText.length} 字符`);
});
test('editable-ppt roster 与官方 standard 无差异（仅 Persona 文本不同）', async () => {
  const [source, baseline] = await Promise.all([readFile(presetFile, 'utf8'), readFile(await resolveStandardPreset(), 'utf8')]);
  assert.deepEqual(ids(source), ids(baseline));
});
