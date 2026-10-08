import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { skillRoot } from '../../support/environment.mjs';

const root = resolve(skillRoot, 'claude-vision-skill');

// The two historical content contracts remain unchanged in ../legacy/vision-contract.test.mjs.
test('Claude Vision 仅手动触发，按已注册工具优先使用原生识图', async () => {
  const source = await readFile(resolve(root, 'SKILL.md'), 'utf8');
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const meta = parseDocument(match[1], { strict: true, uniqueKeys: true }).toJS();
  assert.equal(meta['user-invocable'], true);
  assert.equal(meta['disable-model-invocation'], true);
  assert.match(source, /优先走本机已注册的原生 `read_image` \/ `describe_image`/);
  assert.match(source, /只有 mathmodel-tools 已启用、工具表里确实出现 `vision_analyze` 时才用/);
  assert.match(source, /不直接运行本目录的旧 `vision\.js`/);
  assert.match(source, /不读取 Skill `\.env`/);
  assert.match(source, /qwen3\.7-plus/);
  assert.match(source, /qwen3\.7-flash-2026-07-15/);
});

test('旧 vision.js 只读取显式进程环境变量', async () => {
  const source = await readFile(resolve(root, 'vision.js'), 'utf8');
  assert.doesNotMatch(source, /loadEnvFile|readFileSync\([^\n]*\.env|__dirname[^\n]*\.env|process\.cwd\(\)[^\n]*\.env/);
  assert.match(source, /仅读取调用进程显式提供的环境变量/);
});

test('凭据与连通性流程不把 Key 放入 Prompt 或伪造成功', async () => {
  const source = await readFile(resolve(root, 'SKILL.md'), 'utf8');
  assert.match(source, /不要要求用户把 Key 粘贴到对话文本/);
  assert.match(source, /没有测试图片时只说明尚未测试，不编造连通成功/);
  assert.match(source, /不得读取、复制、移动、改写或删除它/);
});
