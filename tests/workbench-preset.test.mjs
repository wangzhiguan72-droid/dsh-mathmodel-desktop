import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { workbenchPreset, installWorkbenchPreset } from '../scripts/workbench-preset.mjs';
import { installTaskCapabilityPresets } from '../scripts/task-capabilities.mjs';
import { restoreSpecializedPresets } from '../scripts/restore-specialized-presets.mjs';

const runtimeRoot = resolve(import.meta.dirname, '../resources/runtime/host/node_modules');
const yaml = createRequire(join(runtimeRoot, '__workbench__.cjs'))('yaml');
const parse = text => yaml.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ jsExpression: value }) }] }).toJS();
const withDir = body => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-workbench-preset-'));
  try { return body(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test('生成的预设去掉 delegation，挂上 handoff 与 workbench，知识库指向 skills/math-modeling', () => {
  const { yaml: text } = workbenchPreset({ runtimeRoot });
  assert.ok(text.startsWith('# BEGIN DSH math workbench v1\n') && text.endsWith('# END DSH math workbench v1\n'));
  const rows = parse(text).flatMap(row => row.insert ?? []);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, 'preset-math-workbench');
  assert.equal(row.config.id, 'math-workbench');
  assert.equal(row.config.name, '数学建模 Workbench');
  assert.equal(row.config.order, 20);
  const ids = row.config.plugins.map(plugin => plugin.id);
  assert.ok(!ids.includes('delegation'));
  for (const id of ['handoff', 'workbench', 'skill-filesystem', 'tool-skill', 'tool-fs']) assert.ok(ids.includes(id), id);
  const workbench = row.config.plugins.find(plugin => plugin.id === 'workbench');
  assert.equal(workbench.name, '@deepseek-harness/dsh-mathmodel/workbench');
  assert.equal(workbench.config.skillRoot.jsExpression, "dshHomePath('skills/math-modeling')");
});

test('追加到 profile 不改动其他行，留一份备份，再跑一次 changed=false', () => withDir(directory => {
  const profilePatch = join(directory, 'cordis.patch.yml');
  const original = '# user\n- insert: []\n';
  writeFileSync(profilePatch, original);
  const first = installWorkbenchPreset({ runtimeRoot, profilePatch, apply: true });
  assert.equal(first.applied, true);
  assert.equal(readFileSync(first.backup, 'utf8'), original);
  const installed = readFileSync(profilePatch, 'utf8');
  assert.ok(installed.startsWith(original));
  assert.ok(first.backup.includes('.bak-workbench-'));
  const again = installWorkbenchPreset({ runtimeRoot, profilePatch, apply: true });
  assert.equal(again.changed, false);
  assert.equal(readFileSync(profilePatch, 'utf8'), installed);
  assert.equal(readdirSync(directory).length, 2);
}));

test('块被手改时报错，文件不变', () => withDir(directory => {
  const profilePatch = join(directory, 'cordis.patch.yml');
  writeFileSync(profilePatch, '- insert: []\n');
  installWorkbenchPreset({ runtimeRoot, profilePatch, apply: true });
  const edited = readFileSync(profilePatch, 'utf8').replace('name: 数学建模 Workbench', 'name: 改过');
  writeFileSync(profilePatch, edited);
  assert.throws(() => installWorkbenchPreset({ runtimeRoot, profilePatch, apply: true }), /managed definitions differ/);
  assert.equal(readFileSync(profilePatch, 'utf8'), edited);
}));

test('三个托管块共存：专用预设与任务预设的安装器都不受 workbench 块影响', () => withDir(directory => {
  const profilePatch = join(directory, 'cordis.patch.yml');
  writeFileSync(profilePatch, '- insert: []\n');
  restoreSpecializedPresets({ runtimeRoot, profilePatch, apply: true });
  installTaskCapabilityPresets({ runtimeRoot, profilePatch, sessionsDir: join(directory, 'sessions'), apply: true });
  installWorkbenchPreset({ runtimeRoot, profilePatch, apply: true });
  const all = readFileSync(profilePatch, 'utf8');
  assert.equal(restoreSpecializedPresets({ runtimeRoot, profilePatch, apply: true }).applied, false);
  assert.equal(installTaskCapabilityPresets({ runtimeRoot, profilePatch, sessionsDir: join(directory, 'sessions'), apply: true }).changed, false);
  assert.equal(installWorkbenchPreset({ runtimeRoot, profilePatch, apply: true }).changed, false);
  assert.equal(readFileSync(profilePatch, 'utf8'), all);
}));
