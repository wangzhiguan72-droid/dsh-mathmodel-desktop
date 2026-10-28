import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function makeCodeSchedule(taskIds, seed) {
  if (taskIds.length !== 4 || new Set(taskIds).size !== 4 || !Number.isSafeInteger(seed)) throw new Error('Four unique task IDs and an integer seed required');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const shuffle = values => { for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; } return values; };
  const pairs = shuffle([1, 2].flatMap(round => taskIds.map(taskId => ({ round, taskId }))));
  const orders = shuffle([0, 0, 0, 0, 1, 1, 1, 1]);
  return pairs.flatMap((pair, index) => (orders[index] ? ['task-0f', 'task-00'] : ['task-00', 'task-0f'])
    .map((preset, position) => ({ ...pair, pair: index + 1, position: position + 1, preset })));
}

export function evaluateCodeTask({ task, source, directory, node = process.execPath, checks: selectedChecks = ['public', 'hidden'] }) {
  if (!Array.isArray(selectedChecks) || !selectedChecks.length || selectedChecks.some(name => !['public', 'hidden'].includes(name))) throw new Error('Unknown evaluation check selection');
  fs.mkdirSync(directory, { recursive: true });
  const evaluationDirectory = fs.realpathSync(directory);
  fs.writeFileSync(path.join(evaluationDirectory, 'solution.cjs'), source);
  fs.writeFileSync(path.join(evaluationDirectory, '.code-eval-guard.mjs'), `import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = new Set(['public.test.cjs', 'hidden.test.cjs', 'solution.cjs']
  .map(name => pathToFileURL(path.join(root, name)).href));
const builtins = new Set(['node:assert', 'node:assert/strict', 'assert', 'assert/strict']);
const deny = () => { throw new Error('Code evaluation module blocked'); };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!builtins.has(specifier) && specifier !== './solution.cjs' && !files.has(specifier)) deny();
    const resolved = nextResolve(specifier, context);
    if (!files.has(resolved.url) && !builtins.has(resolved.url)) deny();
    return resolved;
  },
  load(url, context, nextLoad) {
    if (!files.has(url) && !builtins.has(url)) deny();
    return nextLoad(url, context);
  },
});
for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
}
for (const name of ['getBuiltinModule', 'binding', '_linkedBinding', 'exit', 'reallyExit', 'abort', 'kill']) {
  Object.defineProperty(process, name, { value: deny, configurable: false, writable: false });
}
`);
  const checks = {};
  for (const name of selectedChecks) {
    const test = name === 'public' ? task.publicTest : task.hiddenTest;
    fs.writeFileSync(path.join(evaluationDirectory, `${name}.test.cjs`), test);
    const run = spawnSync(node, ['--max-old-space-size=128', '--permission',
      `--allow-fs-read=${evaluationDirectory}`, '--disallow-code-generation-from-strings',
      '--import=./.code-eval-guard.mjs', `${name}.test.cjs`], {
      cwd: evaluationDirectory, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64000,
    });
    checks[name] = { passed: run.status === 0 && !run.error && !run.signal, status: run.status,
      signal: run.signal, errorCode: run.error?.code ?? null, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
  }
  return { passed: Object.values(checks).every(check => check.passed), checks,
    sourceSha256: createHash('sha256').update(source).digest('hex') };
}
