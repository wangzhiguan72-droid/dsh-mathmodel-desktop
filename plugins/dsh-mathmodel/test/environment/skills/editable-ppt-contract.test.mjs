import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { skillRoot as skillsRoot } from '../../support/environment.mjs';

const skillRoot = resolve(skillsRoot, 'image-to-editable-ppt');

test('dsh-current Worker 分支：锁定连接、串行、import 校验哈希、失败 passed:false，且无 Codex/config/Key 建议', async () => {
  const builder = await readFile(resolve(skillRoot, 'scripts/build-page-worker-prompt.py'), 'utf8');
  const dshBlock = builder.split('IMAGE_BACKEND_DSH_CURRENT = """')[1]?.split('"""')[0] ?? '';
  assert.ok(dshBlock.length > 0);
  assert.match(dshBlock, /editable_ppt_image/);
  assert.match(dshBlock, /connection_id|connectionId/);
  assert.match(dshBlock, /page_request\.json/);
  assert.match(dshBlock, /sha256/);
  assert.match(dshBlock, /editppt image import[\s\S]*--metadata-file/);
  assert.match(dshBlock, /"passed": false/);
  assert.doesNotMatch(dshBlock, /codex login|OPENAI_API_KEY|editppt config/);
  const legacyBlock = builder.split('IMAGE_BACKEND_LEGACY = """')[1]?.split('"""')[0] ?? '';
  assert.match(legacyBlock, /codex login/); // 原后端分支保持原文案
  const template = await readFile(resolve(skillRoot, 'prompts/page-worker.md'), 'utf8');
  assert.match(template, /\{\{IMAGE_BACKEND\}\}/);
});

test('Skill 仍保留原质量门禁与串行图像调用关键词', async () => {
  const skill = await readFile(resolve(skillRoot, 'SKILL.md'), 'utf8');
  for (const keyword of ['finalize', 'object-level editable', 'no-fallback rule', 'serial', 'dsh-current', 'editable_ppt_image', 'editppt image import', 'never a quality downgrade', 'dsh_current_cli_forbidden', 'external_processing_forbidden']) {
    assert.match(skill, new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Skill 缺少关键词：${keyword}`);
  }
  const helper = await readFile(resolve(skillRoot, 'references/cli-helper.md'), 'utf8');
  assert.match(helper, /--image-backend dsh-current/);
  assert.match(helper, /--metadata-file/);
  assert.match(helper, /Codex OAuth first/); // 原后端文档保留
});
