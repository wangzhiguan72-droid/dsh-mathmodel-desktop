import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SkillHelpCatalog } from '../lib/index.js';

test('单个损坏的 frontmatter 不会拖垮其他 Skill 说明', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-skill-help-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'valid'));
  await mkdir(resolve(root, 'broken'));
  await writeFile(resolve(root, 'valid', 'SKILL.md'), [
    '---',
    'name: valid',
    'description: 这是一个完整有效的测试技能说明。',
    '---',
    '',
    '# Valid',
  ].join('\n'));
  await writeFile(resolve(root, 'broken', 'SKILL.md'), '***\nname: broken\n***\n');

  const skills = await new SkillHelpCatalog(root).list();
  assert.deepEqual(skills.map((item) => item.skill), ['valid']);
});
