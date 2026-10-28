import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { profileRoot } from '../support/environment.mjs';

const webPatch = resolve(profileRoot, 'cordis.patch.yml');

async function profileEntries() {
  const source = await readFile(webPatch, 'utf8');
  const document = YAML.parseDocument(source, {
    uniqueKeys: true,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  });
  assert.deepEqual(document.errors, []);
  const rows = document.toJS();
  assert.ok(Array.isArray(rows));
  return { rows, inserts: rows.flatMap(row => row.insert ?? []) };
}

test('Web Profile 全局加载一次生图工具，使任意 Agent 模式可用且不重复注册', async () => {
  const { rows, inserts } = await profileEntries();
  const tools = inserts.filter(row => row.id === 'mathmodel-tools');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, '@deepseek-harness/dsh-mathmodel/tools');
  assert.equal(rows.filter(row => row.id === 'mathmodel-tools').length, 0);
});

test('真实 Profile 将技能根接到 DSH_HOME 并禁用重复的官方 Skill UI', async () => {
  const { rows, inserts } = await profileEntries();
  const skillUi = rows.filter(row => row.id === 'ui-skill');
  assert.equal(skillUi.length, 1);
  assert.equal(skillUi[0].name, '@deepseek-ai/dsh-client-ui-skill');
  assert.equal(skillUi[0].disabled, true);

  const mathmodel = inserts.filter(row => row.id === 'mathmodel');
  assert.equal(mathmodel.length, 1);
  assert.equal(mathmodel[0].name, '@deepseek-harness/dsh-mathmodel');
  assert.deepEqual(mathmodel[0].inject, ['credentials', 'settings']);
  assert.equal(mathmodel[0].config.skillRoot, "dshHomePath('skills')");

  const overrides = rows.filter(row => row.id === 'mathmodel');
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].name, '@deepseek-harness/dsh-mathmodel');
  assert.equal(overrides[0].config.skillRoot, "dshHomePath('skills')");
  assert.equal(overrides[0].insert, undefined);
});
