import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '../../../resources/runtime/host/node_modules/@deepseek-ai/dsh-scope/lib/index.js';
import { ToolRuntime, defineTool } from '../../../resources/runtime/host/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import {
  taskToolSwitchProjection, taskToolWireProjection, normalizeToolSwitches, toolDenied,
  installAgentToolSwitches, TaskToolSwitchController,
} from '../src/task-tool-switches.js';

function tool(name) {
  return defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] }, execute: async () => ({}) });
}

test('switches remove model schemas only for one Agent and cover late tools', async t => {
  const root = new Context();
  root.provide('systemPrompt', { tools: () => () => {} });
  new ToolRuntime(root, { mode: 'native' });
  const a = { id: 'first' }, b = { id: 'second' };
  const first = createScope(root, a);
  const second = createScope(root, b);
  a.ctx = first.ctx; b.ctx = second.ctx;
  t.after(async () => { await first.dispose(); await second.dispose(); });
  const definitions = ['skill', 'mcp__academic-search__search_papers', 'task_board_list', 'read_file'];
  const disposeTools = definitions.map(name => root.tools.register(tool(name)));
  t.after(() => disposeTools.forEach(dispose => dispose()));
  let selected = { skills: false, mcp: false, taskBoard: false, disabledMcpServers: [] };
  const switcher = installAgentToolSwitches(a, () => selected, root);
  t.after(() => switcher.dispose());
  assert.deepEqual(root.tools.schemas(a).map(row => row.name), ['read_file']);
  assert.equal(root.tools.schemas(b).length, definitions.length);
  assert.match(root.tools.guardReason({ agent: a, name: 'skill' }), /关闭/);
  const late = root.tools.register(tool('mcp__academic-search__lookup_mesh'));
  t.after(late);
  assert.equal(root.tools.get('mcp__academic-search__lookup_mesh', a), undefined);
  assert.ok(root.tools.get('mcp__academic-search__lookup_mesh', b));
  const shadow = first.ctx.tools.register(tool('mcp__academic-search__search_papers'));
  t.after(shadow);
  assert.ok(root.tools.get('mcp__academic-search__search_papers', a), 'own-scope shadow stays visible under native restrictions');
  assert.match(root.tools.guardReason({ agent: a, name: 'mcp__academic-search__search_papers' }), /关闭/);
  selected = { skills: true, mcp: true, taskBoard: true, disabledMcpServers: ['academic-search'] };
  switcher.refresh();
  assert.ok(root.tools.get('skill', a));
  assert.match(root.tools.guardReason({ agent: a, name: 'mcp__academic-search__search_papers' }), /关闭/);
  selected.disabledMcpServers = [];
  switcher.refresh();
  assert.equal(root.tools.schemas(a).length, 5);
});

test('after the first turn, closing keeps offered schemas and only the guard blocks calls', async t => {
  const root = new Context();
  root.provide('systemPrompt', { tools: () => () => {} });
  new ToolRuntime(root, { mode: 'native' });
  const a = { id: 'a' };
  const scope = createScope(root, a); a.ctx = scope.ctx;
  t.after(() => scope.dispose());
  const disposeTools = ['skill', 'mcp__academic-search__search_papers', 'read_file'].map(name => root.tools.register(tool(name)));
  t.after(() => disposeTools.forEach(dispose => dispose()));
  const event = data => ({ type: 'mathmodel/tool-switches', data });
  let selection = null, wire = taskToolWireProjection.init();
  const apply = e => { selection = taskToolSwitchProjection.apply(selection, e); wire = taskToolWireProjection.apply(wire, e); };
  const switcher = installAgentToolSwitches(a, () => selection, root, () => wire.selection);
  t.after(() => switcher.dispose());
  const names = () => root.tools.schemas(a).map(row => row.name).sort();
  apply(event({ mcp: false })); switcher.refresh();
  assert.deepEqual(names(), ['read_file', 'skill'], 'before the first turn the wire follows the selection');
  apply({ type: 'turn/start', data: { turn: 1 } });
  apply(event({ mcp: false, skills: false })); switcher.refresh();
  assert.deepEqual(names(), ['read_file', 'skill'], 'closing skill after the first turn keeps its schema');
  assert.match(root.tools.guardReason({ agent: a, name: 'skill' }), /关闭/);
  apply(event({ mcp: true, skills: false })); switcher.refresh();
  assert.deepEqual(names(), ['mcp__academic-search__search_papers', 'read_file', 'skill'], 'reopening widens the wire');
  assert.equal(root.tools.guardReason({ agent: a, name: 'mcp__academic-search__search_papers' }), undefined);
  apply(event({ mcp: true, skills: false, disabledMcpServers: ['academic-search'] })); switcher.refresh();
  assert.equal(names().length, 3, 'a later server-level close does not narrow either');
  assert.match(root.tools.guardReason({ agent: a, name: 'mcp__academic-search__search_papers' }), /关闭/);
  const replayed = [event({ mcp: false }), { type: 'turn/start', data: { turn: 1 } }, event({ mcp: false, skills: false })]
    .reduce(taskToolWireProjection.apply, taskToolWireProjection.init());
  assert.deepEqual(replayed.selection, normalizeToolSwitches({ mcp: false }), 'resume rebuilds the same wire');
});

test('only a runtime-owned subagent inherits a parent switch snapshot', async t => {
  const root = new Context();
  root.provide('systemPrompt', { tools: () => () => {} });
  new ToolRuntime(root, { mode: 'native' });
  const parent = { id: 'parent', session: {} };
  const child = { id: 'child', session: { header: { origin: 'subagent', parentSession: 'parent' } } };
  const owner = createScope(root, parent), childScope = createScope(root, child);
  t.after(async () => { await childScope.dispose(); await owner.dispose(); });
  child.ctx = childScope.ctx;
  let owned = false, childState = null;
  let parentState = normalizeToolSwitches({ mcp: false, skills: false });
  const events = [];
  child.session.append = (type, data, options) => {
    events.push({ type, data, options });
    childState = taskToolSwitchProjection.apply(childState, { type, data });
  };
  const controller = new TaskToolSwitchController({
    agents: { get: id => id === 'parent' ? parent : id === 'child' ? child : undefined, isOwnedBy: () => owned },
    projections: { stateOf: (session, key) => key === 'mathmodelToolSwitches' ? session === child.session ? childState : parentState : null },
  });
  t.after(() => controller.dispose());
  controller.attach(child, root);
  assert.equal(childState, null);
  controller.dispose(child.id);
  owned = true;
  controller.attach(child, root);
  assert.equal(childState.mcp, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].options.ignorable, true);
  controller.attach(child, root);
  assert.equal(events.length, 1);
  controller.dispose(child.id);
  parentState = normalizeToolSwitches({ mcp: true, skills: true });
  controller.attach(child, root);
  assert.equal(childState.mcp, true, 'resumed child reconciles stale saved switches with its live parent');
  assert.equal(events.length, 2);
});

test('parent switch change waits for every owned descendant and updates their saved views', () => {
  const parent = { id: 'parent', status: 'idle', session: { header: {} } };
  const child = { id: 'child', status: 'idle', session: { header: { origin: 'subagent', parentSession: 'parent' } } };
  const grandchild = { id: 'grandchild', status: 'running', session: { header: { origin: 'subagent', parentSession: 'child' } } };
  const agents = [parent, child, grandchild];
  const states = new Map(agents.map(agent => [agent.id, null]));
  const appended = [];
  for (const agent of agents) {
    agent.session.append = (type, data, options) => {
      appended.push(agent.id);
      assert.equal(options.ignorable, true);
      states.set(agent.id, taskToolSwitchProjection.apply(states.get(agent.id), { type, data }));
    };
  }
  const controller = new TaskToolSwitchController({
    agents: { get: id => agents.find(agent => agent.id === id), list: () => agents,
      isOwnedBy: (id, owner) => id === 'child' && owner === parent || id === 'grandchild' && owner === child },
    projections: { stateOf: (session, key) => key === 'mathmodelToolSwitches'
      ? states.get(agents.find(agent => agent.session === session).id)
      : { openTurnStartSeq: null, lastTurn: 1 } },
  });
  const refreshed = [];
  for (const agent of agents) controller.track(agent, { refresh() { refreshed.push(agent.id); } });
  assert.throws(() => controller.set('parent', { mcp: false }), /空闲/);
  assert.deepEqual(appended, []);
  grandchild.status = 'idle';
  assert.throws(() => controller.set('child', { mcp: false }), /子任务/);
  const result = controller.set('parent', { mcp: false });
  assert.deepEqual(appended, ['child', 'grandchild', 'parent']);
  assert.deepEqual(refreshed, ['child', 'grandchild', 'parent']);
  for (const agent of agents) assert.equal(states.get(agent.id).mcp, false);
  assert.equal(result.selection.mcp, false);
});

test('projection replays saved switches and validates input', () => {
  assert.deepEqual(normalizeToolSwitches(null), { skills: true, mcp: true, taskBoard: true, disabledMcpServers: [] });
  const value = normalizeToolSwitches({ skills: false, disabledMcpServers: ['academic-search'] });
  const replay = taskToolSwitchProjection.apply(null, { type: 'mathmodel/tool-switches', data: value });
  assert.deepEqual(replay, value);
  assert.deepEqual(taskToolSwitchProjection.wire.view(replay), value);
  assert.equal(toolDenied('mcp__academic-search__search_papers', value), true);
  assert.equal(toolDenied('mcp__other__search', value), false);
  assert.equal(toolDenied('skill', value), true);
  assert.throws(() => normalizeToolSwitches({ disabledMcpServers: ['bad/name'] }), /MCP/);
});

test('controller requires an idle turn, saves durable event, and refreshes one session', () => {
  const events = [];
  let selected = null;
  let boundary = { openTurnStartSeq: null, lastTurn: 2 };
  const agent = { id: 'a', status: 'idle', ctx: { tools: { view: () => ({ visible: new Map([['skill', {}]]) }) } },
    session: { append(type, data, opts) { events.push({ type, data, opts }); selected = taskToolSwitchProjection.apply(selected, { type, data }); } } };
  const controller = new TaskToolSwitchController({ agents: { get: id => id === 'a' ? agent : undefined, list: () => [agent] },
    projections: { stateOf: (_session, key) => key === 'mathmodelToolSwitches' ? selected : boundary } });
  let refreshed = 0;
  controller.track(agent, { refresh() { refreshed += 1; } });
  assert.equal(controller.describe('a').canEdit, true);
  assert.deepEqual(controller.describe('a').effectiveToolNames, ['skill']);
  const result = controller.set('a', { skills: false, mcp: true, taskBoard: true, disabledMcpServers: [] });
  assert.equal(result.selection.skills, false);
  assert.equal(events[0].opts.ignorable, true);
  assert.equal(refreshed, 1);
  agent.status = 'running';
  assert.throws(() => controller.set('a', { skills: true }), /空闲/);
  agent.status = 'idle';
  boundary = { openTurnStartSeq: 4, lastTurn: 2 };
  assert.throws(() => controller.set('a', { skills: true }), /空闲/);
  assert.equal(events.length, 1);
});
