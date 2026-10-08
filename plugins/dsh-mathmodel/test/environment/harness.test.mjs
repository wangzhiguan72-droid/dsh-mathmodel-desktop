import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { TYPERT } from '../../lib/typert.host.js';
import { detectHarnessVersion, SUPPORTED_DSH_VERSIONS } from '../../lib/index.js';
import { resolveRuntimeFile } from '../support/runtime.mjs';

test('Host Typert 清单通过官方 Harness 校验器', async () => {
  const loaderPath = await resolveRuntimeFile('@deepseek-ai/dsh-typert-loader/lib/index.js');
  const { validateTypertManifest } = await import(pathToFileURL(loaderPath).href);
  const validated = validateTypertManifest('@deepseek-harness/dsh-mathmodel', TYPERT);
  assert.equal(validated.invocations.length, 20);
  assert.deepEqual(
    new Set(validated.invocations.map((item) => item.namespace)),
    new Set(['mathmodelCards', 'mathmodelCredentials', 'mathmodelPreflight', 'mathmodelProviders', 'mathmodelImageConnections', 'mathmodelOpenCodeRt', 'mathmodelStoredKeyModelDiscovery', 'mathmodelManualVision']),
  );
});

test('从安装的官方 Harness 解析锚点发现兼容版本', async () => {
  const manifest = await resolveRuntimeFile('@deepseek-ai/dsh/package.json');
  const detected = detectHarnessVersion(pathToFileURL(manifest));
  assert.ok(SUPPORTED_DSH_VERSIONS.includes(detected), `未列入白名单的版本：${detected}`);
});
