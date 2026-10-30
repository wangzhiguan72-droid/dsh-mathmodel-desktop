import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { taskCapabilityPresets, installTaskCapabilityPresets, findLegacyPresetSessions } from '../scripts/task-capabilities.mjs';

const runtimeRoot = resolve(import.meta.dirname, '../resources/runtime/host/node_modules');
const yaml = createRequire(join(runtimeRoot, '__capabilities__.cjs'))('yaml');
const parse = text => yaml.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ jsExpression: value }) }] }).toJS();
const runtimeRequire = createRequire(join(runtimeRoot, '__framework__.cjs'));
const framework = name => import(pathToFileURL(runtimeRequire.resolve(name)).href);

const hostRow = '- id: mathmodel\n  name: "@deepseek-harness/dsh-mathmodel"\n  config:\n    skillRoot: !!js dshHomePath(\'skills\')\n    imageConnections:\n      schema: dsh.mathmodel.image-connections/v2\n      connections: []\n';
const v1Block = () => readFileSync(resolve(import.meta.dirname, 'fixtures/task-capabilities-v1.yml'), 'utf8');
const withDir = (label, body) => {
  const directory = mkdtempSync(join(tmpdir(), `dsh-task-${label}-`));
  try { return body(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};
const sessionsWith = (directory, lines) => {
  const sessions = join(directory, 'sessions', 's1');
  fs.mkdirSync(sessions, { recursive: true });
  // Two frames, like the real writer: the reference sits in the second one.
  writeFileSync(join(sessions, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map(line => zstdCompressSync(Buffer.from(`${line}\n`)))));
  return join(directory, 'sessions');
};

test('只生成一个“任务”预设：没有 delegation 组，挂上 handoff，保留核心与平台表达式', () => {
  const { presets, yaml: text } = taskCapabilityPresets({ runtimeRoot });
  assert.deepEqual(presets.map(preset => preset.id), ['task']);
  const rows = parse(text).flatMap(row => row.insert ?? []);
  assert.equal(rows.length, 1);
  const [row] = rows;
  const ids = row.config.plugins.map(plugin => plugin.id);
  const upstream = parse(readFileSync(join(runtimeRoot, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8'))[0].insert[0].config.plugins.map(plugin => plugin.id);
  assert.equal(row.id, 'preset-task');
  assert.equal(row.config.id, 'task');
  assert.equal(row.config.name, '任务');
  assert.equal(row.config.order, 30);
  assert.ok(!ids.includes('delegation'));
  assert.deepEqual(ids.filter(id => !['handoff', 'task-capabilities'].includes(id)), upstream.filter(id => id !== 'delegation'));
  assert.equal(ids.indexOf('handoff'), upstream.indexOf('delegation'), 'handoff 占原 delegation 的位置');
  assert.equal(row.config.plugins.find(plugin => plugin.id === 'handoff').name, '@deepseek-harness/dsh-mathmodel/handoff');
  assert.equal(row.config.plugins.find(plugin => plugin.id === 'task-capabilities').config.images, true);
  assert.equal(row.config.plugins.find(plugin => plugin.id === 'tool-bash').disabled.jsExpression, "process.platform === 'win32'");
  assert.ok(text.startsWith('# BEGIN DSH task capabilities v2\n') && text.endsWith('# END DSH task capabilities v2\n'));
});

test('findLegacyPresetSessions 逐帧读取，只认 task-00～task-0f', () => withDir('legacy', directory => {
  assert.deepEqual(findLegacyPresetSessions(join(directory, 'missing')), []);
  const clean = sessionsWith(directory, ['{"type":"x"}', '{"agentPreset":"task"}']);
  assert.deepEqual(findLegacyPresetSessions(clean), []);
  sessionsWith(directory, ['{"type":"x"}', '{"agentPreset":"task-0f"}']);
  assert.equal(findLegacyPresetSessions(clean).length, 1);
}));

test('official tool registry hides images per scope, contains late registration and scoped shadows', async () => {
  const [{ Context }, { SystemPrompt }, { ToolRuntime }, { createScope }, { AgentPresetRegistry }] = await Promise.all([
    framework('@deepseek-ai/cordis'), framework('@deepseek-ai/dsh-system-prompt'), framework('@deepseek-ai/dsh-tools'), framework('@deepseek-ai/dsh-scope'), framework('@deepseek-ai/dsh-agent-preset-registry'),
  ]);
  const source = readFileSync(resolve(import.meta.dirname, '../plugins/dsh-mathmodel/src/capabilities.js'), 'utf8')
    .replace("'@deepseek-ai/schemastery'", JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/schemastery')).href))
    .replace("'@deepseek-ai/dsh-scope'", JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-scope')).href));
  const capabilities = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const switches = await import('../plugins/dsh-mathmodel/src/task-tool-switches.js');
  const imagesOff = switches.normalizeToolSwitches({ images: false });
  for (const name of capabilities.IMAGE_TOOLS) assert.equal(switches.toolDenied(name, imagesOff), true, `images switch covers ${name}`);
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
      await assert.rejects(AgentPresetRegistry.prototype.select.call(registry, off, 'task'), error => error.code === 'agent-preset/locked');
      assert.equal(recomposed, false);
    }
  } finally {
    await offScope.dispose(); await onScope.dispose();
    await root.fiber.dispose();
  }
});

test('新 profile 追加 v2 块，保留用户行，留一份备份，再跑幂等；块内被改则报错', () => withDir('install', directory => {
  const profilePatch = join(directory, 'cordis.patch.yml');
  const original = '# user\r\n- insert: []\r\n';
  writeFileSync(profilePatch, original);
  const options = { runtimeRoot, profilePatch, sessionsDir: join(directory, 'sessions') };
  assert.equal(installTaskCapabilityPresets(options).changed, true);
  assert.equal(readFileSync(profilePatch, 'utf8'), original);
  const first = installTaskCapabilityPresets({ ...options, apply: true });
  assert.equal(readFileSync(first.backup, 'utf8'), original);
  const installed = readFileSync(profilePatch, 'utf8');
  assert.ok(installed.startsWith(original));
  assert.equal(installTaskCapabilityPresets({ ...options, apply: true }).applied, false);
  assert.equal(readFileSync(profilePatch, 'utf8'), installed);
  assert.equal(readdirSync(directory).length, 2);
  const extra = installed.replace('# END DSH task capabilities v2', '- insert: []\r\n# END DSH task capabilities v2');
  writeFileSync(profilePatch, extra);
  assert.throws(() => installTaskCapabilityPresets({ ...options, apply: true }), /managed definitions differ/);
  assert.equal(readFileSync(profilePatch, 'utf8'), extra);
  writeFileSync(profilePatch, installed + '\n- id: preset-task\n  config:\n    plugins: []\n');
  assert.throws(() => installTaskCapabilityPresets({ ...options, apply: true }), /conflict/);
  writeFileSync(profilePatch, installed.replace('# END DSH task capabilities v2', '# broken marker'));
  assert.throws(() => installTaskCapabilityPresets({ ...options, apply: true }), /markers/);
}));

test('重启时容忍块尾的 Host 设置行', () => withDir('restart', directory => {
  const profilePatch = join(directory, 'cordis.patch.yml');
  writeFileSync(profilePatch, '- insert: []\n');
  const options = { runtimeRoot, profilePatch, sessionsDir: join(directory, 'sessions'), apply: true };
  installTaskCapabilityPresets(options);
  const persisted = readFileSync(profilePatch, 'utf8').replace('# END DSH task capabilities v2', `${hostRow}\n# END DSH task capabilities v2`);
  writeFileSync(profilePatch, persisted);
  assert.equal(installTaskCapabilityPresets(options).changed, false);
  assert.equal(readFileSync(profilePatch, 'utf8'), persisted);
  writeFileSync(profilePatch, persisted.replace(hostRow, `${hostRow}- insert: []\n`));
  assert.throws(() => installTaskCapabilityPresets(options), /managed definitions differ/);
}));

for (const [label, block] of [['v1', v1Block], ['0.1.6', () => readFileSync(resolve(import.meta.dirname, 'fixtures/task-capabilities-0.1.6.yml'), 'utf8')]]) {
  test(`${label} 十六行块迁移为 v2 单行块，保留用户行与 Host 设置行，留一份备份`, () => withDir('migrate', directory => {
    const profilePatch = join(directory, 'cordis.patch.yml');
    const original = `# user row\n- insert: []\n\n${block().replace(/# END DSH task capabilities v1/, `${hostRow}# END DSH task capabilities v1`)}`;
    writeFileSync(profilePatch, original);
    const options = { runtimeRoot, profilePatch, sessionsDir: sessionsWith(directory, ['{"agentPreset":"task"}']), apply: true };
    const migrated = installTaskCapabilityPresets(options);
    const result = readFileSync(profilePatch, 'utf8');
    assert.equal(migrated.applied, true);
    assert.equal(migrated.migrated, true);
    assert.equal(readFileSync(migrated.backup, 'utf8'), original);
    assert.ok(result.startsWith('# user row\n- insert: []\n'));
    assert.ok(result.includes(hostRow));
    assert.ok(!result.includes('task capabilities v1'));
    assert.deepEqual(parse(result).flatMap(row => row.insert ?? []).filter(row => row.id?.startsWith('preset-task')).map(row => row.id), ['preset-task']);
    assert.equal(installTaskCapabilityPresets(options).changed, false);
  }));
}

test('有会话引用旧预设时不迁移、不改文件', () => withDir('referenced', directory => {
  const profilePatch = join(directory, 'cordis.patch.yml');
  const original = `- insert: []\n\n${v1Block()}`;
  writeFileSync(profilePatch, original);
  const sessionsDir = sessionsWith(directory, ['{"type":"x"}', '{"agentPreset":"task-0f"}']);
  const result = installTaskCapabilityPresets({ runtimeRoot, profilePatch, sessionsDir, apply: true });
  assert.equal(result.applied, false);
  assert.match(result.skipped, /1 个会话引用旧 task 预设/);
  assert.equal(readFileSync(profilePatch, 'utf8'), original);
  assert.equal(readdirSync(directory).length, 2);
}));

test('v1 块被手改过时 skipped，不抛错、不改文件', () => withDir('edited', directory => {
  const profilePatch = join(directory, 'cordis.patch.yml');
  const original = `- insert: []\n\n${v1Block().replace('images: false', 'images: true')}`;
  writeFileSync(profilePatch, original);
  const result = installTaskCapabilityPresets({ runtimeRoot, profilePatch, sessionsDir: join(directory, 'sessions'), apply: true });
  assert.equal(result.applied, false);
  assert.match(result.skipped, /手动修改/);
  assert.equal(readFileSync(profilePatch, 'utf8'), original);
}));

test('写临时文件失败时原文件与备份不变', () => withDir('write', directory => {
  const profilePatch = join(directory, 'cordis.patch.yml');
  const original = '# personal patch\n- insert: []\n';
  writeFileSync(profilePatch, original);
  const io = { ...fs, writeFileSync(target, ...args) {
    if (typeof target === 'number') throw new Error('injected temporary write failure');
    return fs.writeFileSync(target, ...args);
  } };
  assert.throws(() => installTaskCapabilityPresets({ runtimeRoot, profilePatch, sessionsDir: join(directory, 'sessions'), apply: true, io }), /injected temporary write failure/);
  assert.equal(readFileSync(profilePatch, 'utf8'), original);
  const files = readdirSync(directory);
  assert.equal(files.length, 2);
  assert.equal(files.filter(name => name.endsWith('.tmp')).length, 0);
  assert.equal(readFileSync(join(directory, files.find(name => name.includes('.bak-capabilities-'))), 'utf8'), original);
}));
