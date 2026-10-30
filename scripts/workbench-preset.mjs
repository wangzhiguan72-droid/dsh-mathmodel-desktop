import fs, { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { document, yamlAt, standardPresetDocument, replaceDelegation, managedBlock, appendBlock, writePatch } from './task-capabilities.mjs';

const DEFAULT_RUNTIME_ROOT = fileURLToPath(new URL('../resources/runtime/host/node_modules', import.meta.url));
const BEGIN = '# BEGIN DSH math workbench v1';
const END = '# END DSH math workbench v1';

export function workbenchPreset({ runtimeRoot = DEFAULT_RUNTIME_ROOT } = {}) {
  const { doc, row, config, plugins } = standardPresetDocument(runtimeRoot);
  row.set('id', 'preset-math-workbench');
  config.set('id', 'math-workbench');
  config.set('name', '数学建模 Workbench');
  config.set('description', '数学建模三阶段工作流（建模手 → 编程手 → 论文手）与五道门禁；门禁审查由 delegate 派发独立验收。项目状态写在工作区的 .math-modeling/ 下。');
  config.set('order', 20);
  replaceDelegation(doc, plugins);
  const skillRoot = doc.createNode("dshHomePath('skills/math-modeling')");
  skillRoot.tag = 'tag:yaml.org,2002:js';
  plugins.add(doc.createNode({ id: 'workbench', name: '@deepseek-harness/dsh-mathmodel/workbench', config: { skillRoot } }));
  return { yaml: `${BEGIN}\n${doc.toString().trimEnd()}\n${END}\n` };
}

export function installWorkbenchPreset({ runtimeRoot = DEFAULT_RUNTIME_ROOT, profilePatch, apply = false, io = fs } = {}) {
  const generated = workbenchPreset({ runtimeRoot });
  const yaml = yamlAt(runtimeRoot);
  const original = readFileSync(profilePatch, 'utf8');
  const block = managedBlock(yaml, original, BEGIN, END);
  if (block) {
    const expected = document(yaml, generated.yaml).toJS();
    if (block.managed.length === expected.length && expected.every((row, i) => isDeepStrictEqual(row, block.managed[i]))) {
      return { ...generated, applied: false, changed: false, backup: null };
    }
    throw new Error('Workbench preset conflict: managed definitions differ');
  }
  if (!apply) return { ...generated, applied: false, changed: true, backup: null };
  const backup = writePatch(profilePatch, appendBlock(original, generated.yaml), { io, yaml, suffix: 'workbench' });
  return { ...generated, applied: true, changed: true, backup };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf('--profile-patch');
    if (at < 0 || !process.argv[at + 1]) throw new Error('--profile-patch requires a path');
    const result = installWorkbenchPreset({ profilePatch: resolve(process.argv[at + 1]), apply: process.argv.includes('--apply') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
