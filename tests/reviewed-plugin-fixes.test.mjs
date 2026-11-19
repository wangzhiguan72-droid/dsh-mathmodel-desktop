import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const fusion = fs.readFileSync(path.join(root, 'plugins/dsh-model-fusion/lib/dsh-model-fusion.js'), 'utf8');
function region(name, globals = {}, result) {
  const legacy = fusion.includes(`//#region ${name}`);
  const start = fusion.indexOf(legacy ? `//#region ${name}` : `// ${name}\n`);
  const next = /\n\/\/ (?:src|contracts)\//g; next.lastIndex = start + name.length + 4;
  const end = legacy ? fusion.indexOf('//#endregion', start) : (next.exec(fusion)?.index ?? fusion.length);
  assert.ok(start >= 0 && end > start, `missing ${name}`);
  return vm.runInNewContext(`${fusion.slice(start, end)}\n${result}`, { structuredClone, ...globals });
}

test('Fusion exposes its tools before the first native tool snapshot', () => {
  const Scope = region('src/host/native-scopes.ts', {}, 'NativeFusionScopes');
  const order = [];
  const dispose = () => {};
  const scopes = new Scope({
    canRequest() {}, canExecute() {}, beforeRequest() {},
    installTools() { order.push('install'); return [dispose]; },
    readOnlyTools() { order.push('snapshot'); return ['fusion_delegate']; },
  });
  const agent = { id: 'lead', status: 'idle', ctx: {
    tools: { guard: () => dispose, presentAs: () => dispose },
    on: () => dispose, systemPrompt: { section: () => dispose },
  } };
  scopes.install(agent, { taskId: 'task', profile: { context: { lead: {} } }, prompts: { lead: 'Lead' } }, 'lead');
  assert.deepEqual(order, ['install', 'snapshot']);
});

test('Fusion uses the new scoped executor to present the Lead allowlist', () => {
  let executor;
  class NativeExecutor {
    describe(definitions) { return { schemas: definitions, knownNames: definitions.map(row => row.name) }; }
    execute(input) { return input; }
  }
  const Scope = region('src/host/native-scopes.ts', { NativeToolExecutor: NativeExecutor }, 'NativeFusionScopes');
  const dispose = () => {};
  const scopes = new Scope({ canRequest() {}, canExecute() {}, beforeRequest() {}, installTools: () => [], readOnlyTools: () => ['read'] });
  const agent = { id: 'lead-tree', status: 'idle', ctx: {
    tools: { resolve() {}, guard: () => dispose, setExecutor: value => { executor = value; return dispose; } },
    on: () => dispose, systemPrompt: { section: () => dispose },
  } };
  scopes.install(agent, { taskId: 'tree-task', profile: { context: { lead: {} } }, prompts: { lead: 'Lead' } }, 'lead');
  const read = { name: 'read' }, write = { name: 'write' };
  assert.deepEqual(executor.describe([read, write]).schemas, [read]);
});

test('Fusion distinguishes a physically empty directory from hidden or excluded entries', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-empty-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const isEmpty = region('src/host/native-exploration.ts', { readdirSync: fs.readdirSync }, 'scopeDirectoryEmpty');
  assert.equal(isEmpty(directory), true);
  fs.writeFileSync(path.join(directory, '.hidden'), 'still a file');
  assert.equal(isEmpty(directory), false);
  assert.equal(isEmpty(path.join(directory, 'missing')), false);
});

test('Fusion keeps implementation requests open but permits explanation-only answers', () => {
  const start = fusion.indexOf('const BARE_CONTINUATION');
  const end = fusion.indexOf('const literalSpans', start);
  assert.ok(start > 0 && end > start, 'missing direct-turn completion guard');
  const prefix = 'const normalizeQuote = text => text.replace(/\\s+/g, " ").trim();\n';
  const guard = vm.runInNewContext(`${prefix}${fusion.slice(start, end)}\ndirectTurnLeavesWorkOpen`);
  assert.equal(guard(['Fix the parser and run tests.'], 'I will inspect the parser.'), true);
  assert.equal(guard(['什么是 patch？不要修改文件。'], 'patch 是补丁。'), false);
  assert.equal(guard(['Explain what a patch is, and then fix the parser.'], 'A patch changes code.'), true);
});

function contextFixture() {
  const file = path.join(root, 'plugins/dsh-context/lib/index.js');
  const source = fs.readFileSync(fs.existsSync(file) ? file : path.join(root, 'runtime/profile-web/node_modules/dsh-context/lib/index.js'), 'utf8');
  const at = source.indexOf('attributedOriginal');
  const start = source.lastIndexOf('function ', at);
  const end = source.indexOf('function ', at);
  const name = /^function\s+([\w$]+)/.exec(source.slice(start))?.[1];
  assert.ok(start > 0 && end > start && name, 'unexpected Context attribution artifact');
  const create = vm.runInNewContext(`${source.slice(start, end)}\n${name}`, {
    ir: x => x?.[Symbol.for('cordis.original')] ?? x,
    ar: 'dsh-context', or: () => undefined, Xn: () => undefined, Zn: () => undefined,
    co: x => x?.[Symbol.for('cordis.original')] ?? x,
    lo: 'dsh-context', uo: () => undefined, $a: () => undefined, to: () => undefined,
  });
  let forwarded, disposed = 0;
  const original = function (...args) { forwarded = { receiver: this, args }; return () => { disposed++; }; };
  const raw = { register: original };
  const hooks = new Map(), effects = [];
  const attribution = create({ fiber: { name: 'dsh-context' },
    on: (name, fn) => hooks.set(name, fn), effect: setup => effects.push(setup()), get: () => raw,
  });
  function access(owner) {
    const view = { [Symbol.for('cordis.original')]: raw, ctx: { fiber: { name: owner } }, register: raw.register };
    hooks.get('internal/get')({ fiber: { name: owner } }, 'tools', undefined, () => view);
    return view;
  }
  return { raw, original, attribution, access, effects, forwarded: () => forwarded, disposed: () => disposed };
}

test('Context preserves every tools.register option and its traced receiver', () => {
  const f = contextFixture(), view = f.access('plugin-a');
  const definition = { name: 'audit-tool' }, options = { when: () => true }, extension = { custom: true };
  view.register(definition, options, extension);
  assert.equal(f.forwarded().receiver, view);
  assert.deepEqual(f.forwarded().args, [definition, options, extension]);
});

test('Context attributes interleaved registrations to the actual caller and restores on unload', () => {
  const f = contextFixture(), a = f.access('plugin-a');
  f.access('plugin-b');
  const dispose = a.register({ name: 'owned-by-a' });
  assert.equal(f.attribution.ownerOf('owned-by-a'), 'plugin-a');
  dispose();
  assert.equal(f.disposed(), 1);
  assert.equal(f.attribution.ownerOf('owned-by-a'), undefined);
  for (const effect of f.effects) effect();
  assert.equal(f.raw.register, f.original);
});
