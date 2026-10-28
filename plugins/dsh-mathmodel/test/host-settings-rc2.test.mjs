import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { Config, installMathmodelHost } from '../lib/index.js';

const runtimeHost = path.resolve(import.meta.dirname, '../../../runtime/host');
const runtimeModule = name => pathToFileURL(path.join(runtimeHost, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href;

async function fixture(t, oldSettings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mathmodel-settings-rc2-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('dsh-mathmodel-settings-rc2-'));
    assert.equal(fs.realpathSync.native(path.dirname(root)).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (oldSettings) fs.writeFileSync(path.join(root, 'settings.yaml'), YAML.stringify(oldSettings));
  const patchFile = path.join(root, 'mathmodel-config.yml');
  fs.writeFileSync(patchFile, YAML.stringify({ skillRoot: root }));
  const { Context } = await import(runtimeModule('cordis'));
  const { SettingsForms } = await import(runtimeModule('dsh-settings'));
  const make = () => {
    const ctx = new Context();
    const readPatch = () => fs.existsSync(patchFile) ? YAML.parse(fs.readFileSync(patchFile, 'utf8')) : {};
    const entry = { options: { id: 'mathmodel', name: '@deepseek-harness/dsh-mathmodel', config: readPatch() },
      fiber: { uid: 1, state: 2, runtime: { Config }, config: Config(readPatch()), ctx } };
    const configEditor = {
      configuration: () => [{ entry, inherited: {}, override: readPatch() }],
      entries: () => [entry],
      edit: async (target, change) => {
        assert.equal(target, entry);
        const next = change(entry.options.config, {});
        const parsed = Config(next);
        fs.writeFileSync(patchFile, YAML.stringify(next));
        entry.options.config = next;
        entry.fiber.config = parsed;
      },
    };
    ctx.provide('loader', { await: async () => {} });
    ctx.provide('configEditor', configEditor);
    ctx.provide('profileContext', { home: root });
    ctx.provide('credentials', { describe: async () => ({ configured: false, writable: true }),
      resolve: async () => undefined, set: async () => {}, unset: async () => {} });
    new SettingsForms(ctx);
    installMathmodelHost(ctx, { skillRoot: root });
    return { ctx, entry };
  };
  return { root, patchFile, make };
}

test('0.2.0-rc.2 SettingsForms loads old namespaces, persists edits, and reloads plugin Config', async t => {
  const old = {
    'mathmodel-providers': { providerOrder: ['openai', 'dashscope', 'gemini', 'custom'],
      openaiModel: 'fixture-model' },
    'mathmodel-image-connections': { schema: 'dsh.mathmodel.image-connections/v2',
      activeConnectionId: '', connections: [] },
    'mathmodel-opencode-rt': { verifiedVisionModels: ['fixture-vision'] },
  };
  const f = await fixture(t, old);
  const first = f.make();
  await assert.rejects(first.ctx.get('mathmodelImageConnections').list(), /migration is still in progress/);
  for (let i = 0; i < 50; i++) {
    const row = first.ctx.settings.describe().find(item => item.ns === 'mathmodel');
    if (row?.value?.legacySettingsMigrated) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const row = first.ctx.settings.describe().find(item => item.ns === 'mathmodel');
  assert.equal(row?.value?.legacySettingsMigrated, true);
  assert.equal(row.value.providers.openaiModel, 'fixture-model');
  assert.deepEqual(row.value.openCodeRt.verifiedVisionModels, ['fixture-vision']);
  assert.deepEqual(row.value.imageConnections.connections, []);
  assert.ok(fs.existsSync(path.join(f.root, 'settings.yaml.imported')));
  assert.ok(fs.existsSync(f.patchFile));
  for (const name of ['mathmodelCards', 'mathmodelCredentials', 'mathmodelPreflight',
    'mathmodelProviders', 'mathmodelImageConnections', 'mathmodelOpenCodeRt',
    'mathmodelStoredKeyModelDiscovery', 'mathmodelManualVision']) {
    assert.ok(first.ctx.get(name), `${name} registered with current Cordis`);
  }
  assert.equal((await first.ctx.get('mathmodelProviders').status()).settings.openaiModel, 'fixture-model');
  assert.deepEqual((await first.ctx.get('mathmodelImageConnections').list()).connections, []);
  await first.ctx.settings.update('mathmodel', { providers: {
    ...row.value.providers, openaiModel: 'edited-model',
  } });
  const second = f.make();
  const reloaded = second.ctx.settings.describe().find(item => item.ns === 'mathmodel');
  assert.equal(reloaded.value.providers.openaiModel, 'edited-model');
  assert.deepEqual(reloaded.value.openCodeRt.verifiedVisionModels, ['fixture-vision']);
  assert.equal(reloaded.value.legacySettingsMigrated, true);
  assert.equal(YAML.parse(fs.readFileSync(f.patchFile, 'utf8')).skillRoot, f.root);
});
