import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertCompatibleHarnessVersion,
  detectHarnessVersion,
  SUPPORTED_DSH_VERSIONS,
} from '../lib/index.js';

test('接受白名单内的 DeepSeek Harness 版本', () => {
  assert.ok(SUPPORTED_DSH_VERSIONS.includes('0.1.5-rc.3'));
  assert.ok(SUPPORTED_DSH_VERSIONS.includes('0.2.0-rc.2'));
  assert.ok(SUPPORTED_DSH_VERSIONS.includes('0.2.1-alpha.4'));
  assert.ok(SUPPORTED_DSH_VERSIONS.includes('0.2.1-rc.2'));
  assert.ok(SUPPORTED_DSH_VERSIONS.includes('0.2.1-rc.4'));
  for (const version of SUPPORTED_DSH_VERSIONS) {
    assert.equal(assertCompatibleHarnessVersion(version), version);
  }
});

test('错误版本给出可操作的中文错误', () => {
  assert.throws(
    () => assertCompatibleHarnessVersion('0.1.0-rc.7'),
    /需要 .+，当前 0\.1\.0-rc\.7/,
  );
});

test('未知版本失败关闭', () => {
  assert.throws(() => assertCompatibleHarnessVersion(null), /当前 未检测到/);
  assert.throws(() => assertCompatibleHarnessVersion('0.2.1-alpha.2'), /当前 0\.2\.1-alpha\.2/);
});

test('从独立 npm 包解析锚点发现 Harness 版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mathmodel-version-'));
  try {
    const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.3' }));
    assert.equal(detectHarnessVersion(pathToFileURL(join(root, 'consumer.js'))), '0.1.5-rc.3');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
