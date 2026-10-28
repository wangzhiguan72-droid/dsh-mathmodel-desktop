import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { taskCapabilityPresets, installTaskCapabilityPresets } from '../scripts/task-capabilities.mjs';

const runtimeRoot = resolve(import.meta.dirname, '../resources/runtime/host/node_modules');
const yaml = createRequire(join(runtimeRoot, '__capabilities__.cjs'))('yaml');
const parse = text => yaml.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ jsExpression: value }) }] }).toJS();
const runtimeRequire = createRequire(join(runtimeRoot, '__framework__.cjs'));
const framework = name => import(pathToFileURL(runtimeRequire.resolve(name)).href);

test('all sixteen combinations alter real rows, retain core and platform expressions', () => {
  const generated = taskCapabilityPresets({ runtimeRoot });
  const rows = parse(generated.yaml).flatMap(row => row.insert ?? []);
  const upstream = parse(readFileSync(join(runtimeRoot, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8'))[0].insert[0].config.plugins;
  assert.deepEqual(upstream.map(plugin => plugin.id).filter(id => ['time-context', 'tool-schedule', 'tool-plugin-market'].includes(id)),
    ['time-context', 'tool-schedule', 'tool-plugin-market']);
  assert.equal(rows.length, 16);
  assert.equal(new Set(rows.map(row => row.config.id)).size, 16);
  for (const [mask, row] of rows.entries()) {
    const ids = row.config.plugins.map(plugin => plugin.id);
    assert.equal(ids.includes('tool-web'), Boolean(mask & 1));
    assert.equal(ids.includes('skill-filesystem'), Boolean(mask & 2));
    assert.equal(ids.includes('tool-skill'), Boolean(mask & 2));
    assert.equal(ids.includes('delegation'), Boolean(mask & 4));
    for (const id of ['tool-fs', 'tool-pwsh', 'tool-bash', 'planning', 'compaction', 'tool-ask-user']) assert.ok(ids.includes(id));
    for (const id of ['time-context', 'tool-schedule', 'tool-plugin-market']) assert.ok(ids.includes(id));
    assert.deepEqual(ids.filter(id => id !== 'task-capabilities'),
      upstream.filter(plugin => !((!(mask & 1) && plugin.id === 'tool-web')
        || (!(mask & 2) && ['skill-filesystem', 'tool-skill'].includes(plugin.id))
        || (!(mask & 4) && plugin.id === 'delegation'))).map(plugin => plugin.id));
    assert.equal(row.config.plugins.find(plugin => plugin.id === 'task-capabilities').config.images, Boolean(mask & 8));
    assert.equal(row.config.plugins.find(plugin => plugin.id === 'tool-bash').disabled.jsExpression, "process.platform === 'win32'");
    assert.match(row.config.name, /任务/);
  }
});

test('official tool registry hides images per scope, contains late registration and scoped shadows', async () => {
  const [{ Context }, { SystemPrompt }, { ToolRuntime }, { createScope }, { AgentPresetRegistry }] = await Promise.all([
    framework('@deepseek-ai/cordis'), framework('@deepseek-ai/dsh-system-prompt'), framework('@deepseek-ai/dsh-tools'), framework('@deepseek-ai/dsh-scope'), framework('@deepseek-ai/dsh-agent-preset-registry'),
  ]);
  const source = readFileSync(resolve(import.meta.dirname, '../plugins/dsh-mathmodel/src/capabilities.js'), 'utf8')
    .replace("'@deepseek-ai/schemastery'", JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/schemastery')).href))
    .replace("'@deepseek-ai/dsh-scope'", JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-scope')).href));
  const capabilities = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const root = new Context();
  await root.plugin(SystemPrompt, {});
  await root.plugin(ToolRuntime, { mode: 'native' });
  let ctx;
  await root.plugin({ inject: ['tools'], apply: child => { ctx = child; } });
  const off = { id: 'off' }, on = { id: 'on' };
  const offScope = createScope(ctx, off), onScope = createScope(ctx, on);
  off.ctx = offScope.ctx; on.ctx = onScope.ctx;
  const definition = name => ({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] }, execute: async () => ({ ok: true }) });
  try {
    assert.throws(() => capabilities.apply(ctx, { images: false }), /preset scope/);
    capabilities.apply(offScope.ctx, { images: false });
    capabilities.apply(onScope.ctx, { images: true });
    for (const name of capabilities.IMAGE_TOOLS) ctx.tools.register(definition(name));
    ctx.tools.register(definition('safe_tool'));
    for (const name of capabilities.IMAGE_TOOLS) {
      assert.equal(ctx.tools.get(name, off), undefined);
      assert.ok(ctx.tools.get(name, on));
      assert.ok(ctx.tools.get(name));
      assert.equal(ctx.tools.resolveExecution(name, off, true), undefined);
      assert.match(ctx.tools.guardReason({ name, agent: off }), /未启用/);
    }
    assert.ok(ctx.tools.get('safe_tool', off));
    offScope.ctx.tools.register(definition('image_generate'));
    assert.ok(ctx.tools.get('image_generate', off));
    assert.match(ctx.tools.guardReason({ name: 'image_generate', agent: off }), /未启用/);
    assert.equal(ctx.tools.guardReason({ name: 'image_generate', agent: on }), undefined);
    // Run the upstream lock itself; a completed or in-flight first turn cannot recompose.
    for (const boundary of [{ openTurnStartSeq: 1, lastTurn: 0 }, { openTurnStartSeq: null, lastTurn: 1 }]) {
      let recomposed = false;
      const registry = { switches: new Map(), owner: { sessionProjections: { stateOf: () => boundary } }, recompose: async () => { recomposed = true; } };
      await assert.rejects(AgentPresetRegistry.prototype.select.call(registry, off, 'task-0f'), error => error.code === 'agent-preset/locked');
      assert.equal(recomposed, false);
    }
  } finally {
    await offScope.dispose(); await onScope.dispose();
    await root.fiber.dispose();
  }
});

test('install preserves user rows, creates one backup, is idempotent, fails on conflicting id', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-task-capabilities-'));
  try {
    const profilePatch = join(directory, 'cordis.patch.yml');
    const original = '# user\r\n- insert: []\r\n';
    writeFileSync(profilePatch, original);
    const options = { runtimeRoot, profilePatch };
    assert.equal(installTaskCapabilityPresets(options).changed, true);
    assert.equal(readFileSync(profilePatch, 'utf8'), original);
    const first = installTaskCapabilityPresets({ ...options, apply: true });
    assert.equal(readFileSync(first.backup, 'utf8'), original);
    const installed = readFileSync(profilePatch, 'utf8');
    assert.ok(installed.startsWith(original));
    assert.equal(installTaskCapabilityPresets({ ...options, apply: true }).applied, false);
    assert.equal(readFileSync(profilePatch, 'utf8'), installed);
    assert.equal(readdirSync(directory).length, 2);
    const extraManagedRow = installed.replace('# END DSH task capabilities v1', '- insert: []\r\n# END DSH task capabilities v1');
    writeFileSync(profilePatch, extraManagedRow);
    assert.throws(() => installTaskCapabilityPresets({ ...options, apply: true }), /managed definitions differ/);
    assert.equal(readFileSync(profilePatch, 'utf8'), extraManagedRow);
    writeFileSync(profilePatch, installed + '\n- id: preset-task-00\n  config:\n    plugins: []\n');
    assert.throws(() => installTaskCapabilityPresets({ ...options, apply: true }), /conflict/);
    assert.ok(readFileSync(profilePatch, 'utf8').endsWith('    plugins: []\n'));
    writeFileSync(profilePatch, installed.replace('# END DSH task capabilities v1', '# broken marker'));
    assert.throws(() => installTaskCapabilityPresets({ ...options, apply: true }), /markers/);
    writeFileSync(profilePatch, '- insert:\n    - id: preset-task-00\n      name: custom\n');
    assert.throws(() => installTaskCapabilityPresets({ ...options, apply: true }), /conflict/);
    assert.equal(readFileSync(profilePatch, 'utf8').includes('name: custom'), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restart accepts only the Host-persisted mathmodel settings row after managed presets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-task-capabilities-restart-'));
  try {
    const profilePatch = join(directory, 'cordis.patch.yml');
    writeFileSync(profilePatch, '- insert: []\n');
    const options = { runtimeRoot, profilePatch, apply: true };
    installTaskCapabilityPresets(options);
    const installed = readFileSync(profilePatch, 'utf8');
    const hostRow = '- id: mathmodel\n  name: "@deepseek-harness/dsh-mathmodel"\n  config:\n    skillRoot: !!js dshHomePath(\'skills\')\n    imageConnections:\n      schema: dsh.mathmodel.image-connections/v2\n      connections: []\n';
    const persisted = installed.replace('# END DSH task capabilities v1', `${hostRow}\n# END DSH task capabilities v1`);
    writeFileSync(profilePatch, persisted);
    assert.equal(installTaskCapabilityPresets(options).changed, false);
    assert.equal(readFileSync(profilePatch, 'utf8'), persisted);
    assert.equal(readdirSync(directory).length, 2);
    writeFileSync(profilePatch, persisted.replace('images: false', 'images: true'));
    assert.throws(() => installTaskCapabilityPresets(options), /managed definitions differ/);
    writeFileSync(profilePatch, persisted.replace(hostRow, `${hostRow}- insert: []\n`));
    assert.throws(() => installTaskCapabilityPresets(options), /managed definitions differ/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('known 0.1.6 managed presets migrate to the new roster without changing user rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-task-capabilities-migration-'));
  try {
    const profilePatch = join(directory, 'cordis.patch.yml');
    const hostRow = '- id: mathmodel\n  name: "@deepseek-harness/dsh-mathmodel"\n  config:\n    skillRoot: !!js dshHomePath(\'skills\')\n    imageConnections:\n      schema: dsh.mathmodel.image-connections/v2\n      connections: []\n';
    const legacy = readFileSync(resolve(import.meta.dirname, 'fixtures/task-capabilities-0.1.6.yml'), 'utf8')
      .replace('# END DSH task capabilities v1', `${hostRow}# END DSH task capabilities v1`);
    const original = `# user row\n- insert: []\n\n${legacy}`;
    writeFileSync(profilePatch, original);
    const options = { runtimeRoot, profilePatch, apply: true };
    const migrated = installTaskCapabilityPresets(options);
    const result = readFileSync(profilePatch, 'utf8');
    assert.equal(migrated.applied, true);
    assert.equal(readFileSync(migrated.backup, 'utf8'), original);
    assert.ok(result.startsWith('# user row\n- insert: []\n'));
    assert.ok(result.includes(hostRow));
    assert.equal(parse(result).flatMap(row => row.insert ?? []).filter(row => row.id?.startsWith('preset-task-')).length, 16);
    assert.equal(installTaskCapabilityPresets(options).changed, false);
    writeFileSync(profilePatch, original.replace('images: false', 'images: true'));
    assert.throws(() => installTaskCapabilityPresets(options), /managed definitions differ/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed temporary write preserves original patch and its backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-task-capabilities-write-'));
  try {
    const profilePatch = join(directory, 'cordis.patch.yml');
    const original = '# personal patch\n- insert: []\n';
    writeFileSync(profilePatch, original);
    const io = { ...fs, writeFileSync(target, ...args) {
      if (typeof target === 'number') throw new Error('injected temporary write failure');
      return fs.writeFileSync(target, ...args);
    } };
    assert.throws(() => installTaskCapabilityPresets({ runtimeRoot, profilePatch, apply: true, io }), /injected temporary write failure/);
    assert.equal(readFileSync(profilePatch, 'utf8'), original);
    const files = readdirSync(directory);
    assert.equal(files.length, 2);
    assert.equal(files.filter(name => name.includes('.capabilities-') && name.endsWith('.tmp')).length, 0);
    const backup = files.find(name => name.includes('.bak-capabilities-'));
    assert.ok(backup);
    assert.equal(readFileSync(join(directory, backup), 'utf8'), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
