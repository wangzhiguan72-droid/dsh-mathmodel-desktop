import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

export async function resolveRuntimeFile(relativePath, env = process.env) {
  const override = env.DSH_TEST_RUNTIME_ROOT?.trim();
  const roots = override ? [resolve(override)] : [
    resolve(repositoryRoot, 'resources/runtime/host/node_modules'),
    resolve(repositoryRoot, 'runtime/host/node_modules'),
  ];
  const candidates = roots.map((root) => resolve(root, relativePath));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`运行时文件 ${relativePath} 不存在；已探测：\n  ${candidates.join('\n  ')}`);
}

export async function resolveStandardPreset() {
  const relativePath = '@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml';
  if (process.env.DSH_AGENT_PRESETS_ROOT) {
    const override = resolve(process.env.DSH_AGENT_PRESETS_ROOT, 'presets/standard/agent.cordis.yml');
    try {
      await access(override);
      return override;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`standard preset 不存在：${override}`);
    }
  }
  return resolveRuntimeFile(relativePath);
}
