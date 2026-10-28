import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pluginManifest from '../../package.json' with { type: 'json' };
import { TYPERT } from '../../lib/typert.host.js';
import { assertCompatibleHarnessVersion } from '../../lib/version.js';
import { resolveRuntimeFile } from '../support/runtime.mjs';

const RC2 = '0.2.0-rc.2';

async function manifest(relativePath) {
  const file = await resolveRuntimeFile(relativePath);
  return JSON.parse(await readFile(file, 'utf8'));
}

test('官方 0.2.0-rc.2 运行时接受插件 Host 清单与浏览器依赖', async (t) => {
  const harness = await manifest('@deepseek-ai/dsh/package.json');
  if (harness.version !== RC2) return t.skip(`此用例验证新内核 ${RC2}，当前运行时为 ${harness.version}`);
  assert.equal(assertCompatibleHarnessVersion(harness.version), RC2);

  const [protocol, loader, modules] = await Promise.all([
    manifest('@deepseek-ai/dsh-typert-protocol/package.json'),
    manifest('@deepseek-ai/dsh-typert-loader/package.json'),
    manifest('@deepseek-ai/dsh-client-modules/package.json'),
  ]);
  assert.equal(protocol.version, RC2);
  assert.equal(loader.version, RC2);
  assert.equal(modules.version, RC2);

  const loaderPath = await resolveRuntimeFile('@deepseek-ai/dsh-typert-loader/lib/index.js');
  const { validateTypertManifest } = await import(pathToFileURL(loaderPath).href);
  const validated = validateTypertManifest(pluginManifest.name, TYPERT);
  assert.equal(validated.invocations.length, 22);

  const injected = pluginManifest.dsh.client.inject;
  assert.ok(injected.includes('@deepseek-ai/dsh-client-modules'));
  assert.ok(!injected.includes('@deepseek-ai/dsh-client-runtime'));
  for (const packageName of injected) {
    const dependency = await manifest(`${packageName}/package.json`);
    assert.equal(dependency.version, RC2, `${packageName} must match the official runtime`);
    assert.equal(dependency.dsh?.client?.platform, 'web');
  }
});
