import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRuntimeFile } from '../support/runtime.mjs';

test('官方 rc.3 预设发现与读取接受真实目录中的组合文件', async (t) => {
  const harnessManifest = await resolveRuntimeFile('@deepseek-ai/dsh/package.json');
  const version = JSON.parse(await readFile(harnessManifest, 'utf8')).version;
  if (version !== '0.1.5-rc.3') return t.skip(`此用例验证旧内核 0.1.5-rc.3，当前运行时为 ${version}`);
  assert.equal(version, '0.1.5-rc.3');
  const packagePath = await resolveRuntimeFile('@deepseek-ai/dsh-agent-presets/lib/index.js');
  const { agentPresetProjectionDefinition, discoverPresets, readComposition } = await import(pathToFileURL(packagePath).href);
  assert.equal(agentPresetProjectionDefinition.init({ agentPreset: 'standard' }), 'standard');
  assert.equal(agentPresetProjectionDefinition.apply('standard', { type: 'agent-preset/selected', data: { agentPreset: 'fixture' } }), 'fixture');
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-rc3-'));
  try {
    const directory = join(root, 'fixture');
    const composition = '- id: local-fixture\n  name: ./fixture-plugin.mjs\n';
    await mkdir(directory);
    await writeFile(join(directory, 'agent.cordis.yml'), composition);
    await writeFile(join(directory, 'fixture-plugin.mjs'), 'export default () => {};\n');
    const rows = await discoverPresets([{ path: root, trust: 'user' }], pathToFileURL(packagePath).href);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'fixture');
    assert.equal(rows[0].broken, undefined);
    assert.equal(await readComposition(rows[0]), composition);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
