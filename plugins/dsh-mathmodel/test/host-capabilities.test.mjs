import test from 'node:test';
import assert from 'node:assert/strict';
import { HostCapabilityController, hostInventory, capabilityProjection, hostConfiguration } from '../src/host-capabilities.js';
import { Context } from '@deepseek-ai/cordis';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HostMutationGate } from '../src/host-freeze-policy.js';

test('a second task scope cannot change the global Host configuration fingerprint', async t => {
  const { createScope, scopeOf } = await import('../../../resources/runtime/host/node_modules/@deepseek-ai/dsh-scope/lib/index.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-host-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'cordis.patch.yml'), '[]');
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  const root = new Context(), task = createScope(root, {});
  t.after(() => task.dispose());
  const global = { id: 'host', options: { name: '@deepseek-harness/dsh-mathmodel' }, fiber: { ctx: root, config: { enabled: true } } };
  const entries = [global];
  const ctx = { profileContext: { dir }, loader: { entries: () => entries } };
  const baseline = await hostConfiguration(ctx, scopeOf);
  entries.push({ id: 'child', options: { name: '@deepseek-harness/dsh-mathmodel/capabilities' }, fiber: { ctx: task.ctx, config: { images: false } } });
  assert.deepEqual(await hostConfiguration(ctx, scopeOf), baseline);
  global.fiber.config.enabled = false;
  assert.notDeepEqual(await hostConfiguration(ctx, scopeOf), baseline);
});

function fixture() {
  const state = { turnBoundary: { openTurnStartSeq: null, lastTurn: 0 }, agentPreset: 'standard', mathmodelCapabilities: null };
  const events = [];
  const agent = { id: 's1', session: { append(type, data, options) { events.push({ type, data, ...options }); state.mathmodelCapabilities = capabilityProjection.apply(state.mathmodelCapabilities, { type, data }); } } };
  const current = { config: { model: 'lead-a' }, schemas: [{ name: 'task_board_list', parameters: { type: 'object' } }], plugins: [], bundles: [] };
  const controller = new HostCapabilityController({
    manager: { listPlugins: async () => current.plugins, listBundles: async () => current.bundles },
    projections: { stateOf: (_session, name) => state[name] }, agents: { get: id => id === 's1' ? agent : undefined },
    presets: { select: async (_agent, preset) => { state.agentPreset = preset; } },
    tools: { wireSchemas: () => ({ schemas: current.schemas }) }, readConfiguration: async () => current.config, gate: new HostMutationGate(),
  });
  return { state, events, agent, current, controller };
}

test('Host status distinguishes selected, activated, failure and unverified MCP connection', () => {
  const rows = hostInventory([{ name: 'dsh-model-fusion', enabled: true }], [
    { entryId: 'fusion', moduleName: 'dsh-model-fusion', enabled: true, fiberPhase: 'pending' },
    { entryId: 'mcp', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active' },
    { entryId: 'auto', moduleName: '@deepseek-ai/dsh-auto-review', enabled: true, fiberPhase: 'failed' },
  ], ['mcp__test__read']);
  assert.equal(rows.find(row => row.id === 'fusion').state, 'loading');
  assert.equal(rows.find(row => row.id === 'auto').state, 'failed');
  assert.equal(rows.find(row => row.id === 'mcp').connection, 'tools-published');
  assert.equal(rows.find(row => row.id === 'mcp').publishedTools, 1);
  assert.equal(rows.find(row => row.id === 'teams').state, 'not-installed');
  assert.equal(hostInventory([{ name: 'dsh-model-fusion', enabled: true, error: 'version mismatch' }], [
    { moduleName: 'dsh-model-fusion', enabled: true, fiberPhase: 'active' },
  ])[0].state, 'failed', 'a stale active fiber must not hide a bundle error');
});

test('MCP inventory exposes names and published tools without leaking configuration', () => {
  const inventory = hostInventory([], [
    { entryId: 'include:mcp-academic', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active' },
  ], ['mcp__academic-search__search_papers', 'mcp__other__read', 'read_file'], [
    { entryId: 'include:mcp-academic', serverName: 'academic-search', apiKey: 'must-not-return' },
  ]);
  const mcp = inventory.find(row => row.id === 'mcp');
  assert.equal(mcp.connection, 'tools-published');
  assert.equal(mcp.publishedTools, 2);
  assert.equal(mcp.servers[0].publishedTools, 1);
  assert.equal(mcp.servers[0].enabled, true);
  assert.deepEqual(mcp.servers[0].tools, ['mcp__academic-search__search_papers']);
  assert.doesNotMatch(JSON.stringify(mcp), /must-not-return|apiKey/);
});

test('confirmation persists a replayable snapshot and refuses a stale Host preview', async () => {
  const f = fixture();
  const preview = await f.controller.describe('s1');
  f.current.schemas.push({ name: 'mcp__late__read' });
  await assert.rejects(f.controller.confirm('s1', 'task', preview.hostHash), error => error.code === 'capabilities/host-changed');
  f.current.schemas.pop();
  await assert.rejects(f.controller.confirm('s1', 'task', 'stale'), error => error.code === 'capabilities/host-changed');
  assert.equal(f.events.length, 0);
  const snapshot = await f.controller.confirm('s1', 'task', preview.hostHash);
  assert.equal(snapshot.preset, 'task');
  assert.equal(f.events[0].ignorable, true, 'external events must survive the official persistence read boundary');
  assert.deepEqual(capabilityProjection.apply(null, f.events[0]), f.state.mathmodelCapabilities);
  assert.equal(await f.controller.verify(f.agent), null);
  f.current.config.model = 'lead-b';
  assert.match(await f.controller.verify(f.agent), /快照不一致/);
  f.current.config.model = 'lead-a';
  assert.equal(await f.controller.verify(f.agent), null);
});

test('only a kernel-owned native child inherits its live parent snapshot', async () => {
  const f = fixture();
  const preview = await f.controller.describe('s1');
  await f.controller.confirm('s1', 'task', preview.hostHash);
  let childSnapshot = null, owned = false;
  const child = { id: 'child', session: { header: { origin: 'subagent', parentSession: 's1', agentPreset: 'task' }, append(type, data) { childSnapshot = capabilityProjection.apply(childSnapshot, { type, data }); } } };
  f.controller.agents.isOwnedBy = () => owned;
  const stateOf = f.controller.projections.stateOf;
  f.controller.projections.stateOf = (session, key) => session === child.session ? key === 'agentPreset' ? 'task' : childSnapshot : stateOf(session, key);
  await f.controller.inheritChild(child, f.agent);
  assert.equal(childSnapshot, null);
  owned = true;
  await f.controller.inheritChild(child, f.agent);
  assert.equal(childSnapshot.inheritedFrom, 's1');
  assert.equal(await f.controller.verify(child), null);
  f.current.config.model = 'lead-other';
  assert.match(await f.controller.verify(child), /快照不一致/);
});

test('missing confirmation, changed schemas and resumed mismatches fail closed', async () => {
  const f = fixture(); f.state.agentPreset = 'task';
  assert.match(await f.controller.verify(f.agent), /先/);
  const preview = await f.controller.describe('s1');
  await f.controller.confirm('s1', 'task', preview.hostHash);
  f.current.schemas.push({ name: 'mcp__late__tool' });
  assert.match(await f.controller.verify(f.agent), /快照不一致/);
  f.state.turnBoundary.lastTurn = 1;
  await assert.rejects(f.controller.confirm('s1', 'task', preview.hostHash), error => error.code === 'agent-preset/locked');
});

test('只接受合并后的 task 预设，旧组合 id 被拒绝', async () => {
  const f = fixture();
  const preview = await f.controller.describe('s1');
  for (const preset of ['task-0f', 'task-00', 'standard']) await assert.rejects(f.controller.confirm('s1', preset, preview.hostHash), error => error.code === 'capabilities/invalid-preset');
  f.state.agentPreset = 'task-0f';
  assert.equal(await f.controller.verify(f.agent), null, '残留的旧预设会话不再被冻结检查拦住');
});

test('unsettled extensions cannot be confirmed, legacy presets keep their existing flow', async () => {
  const f = fixture();
  f.current.plugins.push({ entryId: 'auto', moduleName: '@deepseek-ai/dsh-auto-review', enabled: true, fiberPhase: 'failed' });
  const preview = await f.controller.describe('s1');
  await assert.rejects(f.controller.confirm('s1', 'task', preview.hostHash), error => error.code === 'capabilities/host-unsettled');
  assert.equal(await f.controller.verify(f.agent), null);
});
