import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pluginManifest from '../../package.json' with { type: 'json' };
import { TYPERT } from '../../lib/typert.host.js';
import { assertCompatibleHarnessVersion } from '../../lib/version.js';
import { isSupportedPluginManagerChangeSource } from '../../lib/host-freeze-policy.js';
import { resolveRuntimeFile } from '../support/runtime.mjs';

const VERSIONS = new Set(['0.2.1-alpha.4', '0.2.1-rc.2', '0.2.1-rc.4', '0.2.1-rc.5']);

async function runtimeManifest(name) {
  const file = await resolveRuntimeFile(`${name}/package.json`);
  return JSON.parse(await readFile(file, 'utf8'));
}

test('官方 0.2.1 内核接受数学建模插件契约', async (t) => {
  const harness = await runtimeManifest('@deepseek-ai/dsh');
  if (!VERSIONS.has(harness.version)) return t.skip(`此用例验证 0.2.1，当前运行时为 ${harness.version}`);
  assert.equal(assertCompatibleHarnessVersion(harness.version), harness.version);

  for (const name of ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-loader', ...pluginManifest.dsh.client.inject]) {
    const dependency = await runtimeManifest(name);
    assert.equal(dependency.version, harness.version, name);
  }
  assert.equal((await runtimeManifest('@deepseek-ai/cordis')).version, '4.0.5');
  assert.equal((await runtimeManifest('@deepseek-ai/schemastery')).version, '3.18.5');

  const loaderPath = await resolveRuntimeFile('@deepseek-ai/dsh-typert-loader/lib/index.js');
  const { validateTypertManifest } = await import(pathToFileURL(loaderPath).href);
  const { invocations } = validateTypertManifest(pluginManifest.name, TYPERT);
  assert.equal(invocations.length, 25);
  for (const [method, parameters] of [
    ['describeTools', ['sessionId']],
    ['setTools', ['sessionId', 'selection']],
    ['selectModel', ['sessionId', 'provider', 'model']],
  ]) {
    const matches = invocations.filter(row => row.service === 'mathmodelHostCapabilities' && row.method === method);
    assert.equal(matches.length, 1, method);
    assert.equal(matches[0].id, `${pluginManifest.name}#mathmodelHostCapabilities/${method}`);
    assert.deepEqual(matches[0].parameters.map(parameter => parameter.name), parameters);
    assert.equal(matches[0].invocation.kind, 'direct');
  }
  const setTools = invocations.find(row => row.service === 'mathmodelHostCapabilities' && row.method === 'setTools');
  assert.deepEqual(setTools.parameters[1].codec.create().parse({
    skills: true, mcp: false, taskBoard: true, disabledMcpServers: ['academic-search'],
  }), { skills: true, mcp: false, taskBoard: true, disabledMcpServers: ['academic-search'] });
  assert.throws(() => setTools.parameters[1].codec.create().parse({
    skills: true, mcp: false, taskBoard: true, disabledMcpServers: [], unexpected: true,
  }));

  const managerPath = await resolveRuntimeFile('@deepseek-ai/dsh-plugin-manager/lib/index.js');
  const managerSource = await readFile(managerPath, 'utf8');
  assert.equal(isSupportedPluginManagerChangeSource(managerSource.slice(managerSource.lastIndexOf('async change(operation, request, reason)'))), true);
});
