import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dshHome, profileRoot } from '../../support/environment.mjs';
import { resolveStandardPreset } from '../../support/runtime.mjs';

const preset = resolve(dshHome, '.agent-presets/mathmodel/agent.cordis.yml');
const imagegenPreset = resolve(dshHome, '.agent-presets/imagegen/agent.cordis.yml');
const webPatch = resolve(profileRoot, 'cordis.patch.yml');
const webPackage = resolve(profileRoot, 'package.json');
const subscriptionsPatch = resolve(profileRoot, 'patches/dsh-plugin-subscriptions@0.6.0.patch');
const subscriptionsClient = resolve(profileRoot, 'node_modules/dsh-plugin-subscriptions/lib/client.js');
const ids = (text) => [...text.matchAll(/^\s*- id:\s*([^\s]+)\s*$/gm)].map((match) => match[1]);

test('mathmodel 保留 standard 全部插件行，公共生图工具由 Web Profile 统一加载', async () => {
  const [source, baseline] = await Promise.all([readFile(preset, 'utf8'), readFile(await resolveStandardPreset(), 'utf8')]);
  const sourceIds = new Set(ids(source));
  for (const id of ids(baseline)) assert.equal(sourceIds.has(id), true, `缺少 standard 行 ${id}`);
  assert.equal(sourceIds.has('mathmodel-tools'), false);
});

test('imagegen 保留 standard 全部插件行，公共生图工具由 Web Profile 统一加载', async () => {
  const [source, baseline] = await Promise.all([readFile(imagegenPreset, 'utf8'), readFile(await resolveStandardPreset(), 'utf8')]);
  const sourceIds = new Set(ids(source));
  for (const id of ids(baseline)) assert.equal(sourceIds.has(id), true, `缺少 standard 行 ${id}`);
  assert.equal(sourceIds.size, ids(baseline).length);
  assert.equal(sourceIds.has('mathmodel-tools'), false);
});

test('订阅插件 0.6.0 统一 Codex/Claude/Grok 且 Host/Client 不重复注册 image_generate', async () => {
  const [profileSource, patchSource, compatibilityPatch, clientSource] = await Promise.all([
    readFile(webPackage, 'utf8'),
    readFile(webPatch, 'utf8'),
    readFile(subscriptionsPatch, 'utf8'),
    readFile(subscriptionsClient, 'utf8'),
  ]);
  const profile = JSON.parse(profileSource);
  const providerBlock = patchSource.match(/- id: llm-subscriptions\s*\n\s*config:\s*\n\s*providers:\s*\n((?:\s+- [^\n]+\n)+)/)?.[1];
  const patchAdditions = compatibilityPatch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  assert.equal(profile.dependencies['dsh-plugin-subscriptions'], '0.6.0');
  assert.equal('dsh-llm-oauth' in profile.dependencies, false);
  assert.equal(profile.dsh.profile.bundles.includes('dsh-llm-oauth'), false);
  assert.deepEqual([...(providerBlock ?? '').matchAll(/^\s*-\s+([^\s]+)\s*$/gm)].map((match) => match[1]), ['codex', 'claude', 'grok']);
  assert.match(patchSource, /registerImageTool:\s*false/);
  assert.doesNotMatch(patchSource, /id:\s*llm-oauth/);
  assert.match(patchAdditions, /subscriptionSessions/);
  assert.match(patchAdditions, /subscriptionTokenManagers\.set\("codex", tokens\)/);
  assert.match(patchAdditions, /subscriptionTokenManagers\.set\("grok", tokens\)/);
  assert.match(patchAdditions, /tokens\.session\(void 0, options\.force === true\)/);
  assert.match(patchAdditions, /config\.registerImageTool !== false/);
  assert.match(compatibilityPatch, /key: "image_generate"/);
  assert.match(compatibilityPatch, /^-\s*key: "image_generate"/m);
  assert.doesNotMatch(patchAdditions, /key: "image_generate"/);
  assert.doesNotMatch(clientSource, /key: "image_generate"/);
  assert.match(clientSource, /key: "video_generate"/);
});

test('mathmodel Persona 明示中文建模、证据边界和卡片锁定配置', async () => {
  const source = await readFile(preset, 'utf8');
  assert.match(source, /Chinese-first mathematical modeling agent/);
  assert.match(source, /Never fabricate data, citations, experiments, scores, or verification/);
  assert.match(source, /honor every locked option and do not ask it again/);
});
