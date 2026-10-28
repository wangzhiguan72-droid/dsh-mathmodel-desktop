import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function loadClientEntry(react = {}) {
  const source = await readFile(new URL('../src/client-bundle.cjs', import.meta.url), 'utf8');
  let definition;
  const document = {
    getElementById: () => null,
    createElement: () => ({ dataset: {} }),
    querySelectorAll: () => [],
    querySelector: () => null,
    head: { appendChild() {} },
    documentElement: {},
  };
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document,
    MutationObserver: class { observe() {} },
    AbortController,
    console,
  });
  assert.equal(definition.id, '@deepseek-harness/dsh-mathmodel');
  return definition.factory((name) => {
    if (name === 'react') return react;
    if (name === 'react-dom') return { createPortal: element => element };
    throw new Error(`unexpected browser import: ${name}`);
  });
}

function createContext() {
  const calls = [];
  const slots = [];
  const events = new Map();
  const bails = [];
  const sends = [];
  let source;
  let cardListCalls = 0;
  const card = { skill: 'demo-card', title: '演示', summary: '摘要', category: 'test', fields: [] };
  const remotes = {
    mathmodelCards: {
      list: async () => { cardListCalls++; return { ok: true, value: { cards: [card] } }; },
      help: async () => ({ ok: true, value: { title: '帮助' } }),
      render: async () => ({ ok: true, value: { text: 'draft' } }),
    },
    mathmodelCredentials: {},
    mathmodelPreflight: { run: async () => ({ ok: true, value: { status: 'ready' } }) },
    mathmodelProviders: {},
    mathmodelImageConnections: { list: async () => ({ ok: true, value: { connections: [] } }) },
    mathmodelOpenCodeRt: {},
    mathmodelStoredKeyModelDiscovery: {},
    mathmodelManualVision: {},
    mathmodelHostCapabilities: {
      describe: async () => ({ ok: true, value: { hostHash: 'host', inventory: [] } }),
      confirm: async (sessionId, preset, hostHash) => { calls.push(`preset:${sessionId}:${preset}:${hostHash}`); return { ok: true, value: { preset } }; },
    },
  };
  const ctx = {
    remote: {
      agentPresets: { select: async (sessionId, preset) => { calls.push(`preset:${sessionId}:${preset}`); return { ok: true, value: preset }; } },
      async $mount(manifest) {
        calls.push('mount');
        assert.equal(manifest.descriptors.length, 25);
        for (const descriptor of manifest.descriptors) {
          assert.equal(descriptor.result.create().parse('result'), 'result');
          for (const parameter of descriptor.parameters) assert.equal(typeof parameter.codec.create().parse, 'function');
        }
        return async () => calls.push('dispose');
      },
      $on(name, handler) { events.set(name, handler); },
    },
    get(name) {
      calls.push(`get:${name}`);
      if (name.startsWith('remote.')) return remotes[name.slice(7)] ?? (name === 'remote.skills' ? { list: async () => ({ ok: true, value: { skills: [{ name: 'demo-card' }] } }) } : undefined);
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', blank: true } } }) }, subagentAddress: () => undefined, scope: () => ({ bail(_ctx, event, payload) { bails.push({ event, payload }); return false; } }) };
      if (name === 'conversation') return { blocks: { set() {} }, input: { for: () => ({ notify() {}, send(...args) { sends.push(args); } }) }, draftImages: () => [], releaseDraftImages() {} };
      if (name === 'inputTriggers') return { registerSource(value) { source = value; return () => {}; } };
    },
    effect(callback) { return callback(); },
    inject(_names, callback) { remotes.agentPresets = ctx.remote.agentPresets; callback(ctx); },
    slots: {
      inject(name, callback) { assert.match(name, /^conversation\.input\./); callback(); },
      register(options, component) { slots.push({ options, component }); return () => {}; },
    },
    on(name, handler) { events.set(name, handler); },
  };
  return { ctx, calls, slots, events, remotes, bails, sends, get source() { return source; }, get cardListCalls() { return cardListCalls; } };
}

test('浏览器入口先挂载 Remote，再读取服务；注册六个 Slot 与 Skill InputTrigger', async () => {
  const plugin = await loadClientEntry();
  const fixture = createContext();
  const dispose = await plugin.apply(fixture.ctx);
  assert.equal(fixture.calls[0], 'mount');
  assert.equal(fixture.calls[1], 'get:remote.mathmodelCards');
  assert.deepEqual(fixture.slots.map(({ options }) => options.id), [
    'mathmodel-card', 'mathmodel-image-connection-settings', 'mathmodel-opencode-rt-add-provider',
    'mathmodel-stored-key-model-discovery', 'mathmodel-task-capabilities', 'mathmodel-manual-vision-draft',
  ]);
  assert.equal(fixture.source.trigger, '/');
  assert.equal(fixture.source.name, 'skill');
  await dispose();
  assert.equal(fixture.calls.at(-1), 'dispose');
});

test('能力入口直接接官方空白会话选择，不发送消息，不要求开发者工具', async () => {
  const plugin = await loadClientEntry();
  const fixture = createContext();
  const dispose = await plugin.apply(fixture.ctx);
  const picker = fixture.slots.find(slot => slot.options.id === 'mathmodel-task-capabilities');
  const props = picker.options.inject('s1');
  assert.equal(props.sessionId, 's1');
  assert.deepEqual(await props.actions.apply('s1', 5, await props.actions.describe('s1')), { preset: 'task-05' });
  assert.ok(fixture.calls.includes('preset:s1:task-05:host'));
  assert.equal(fixture.sends.length, 0);
  await dispose();
});

test('能力面板可渲染四项选择，读取 Host 后确认；已开始任务只读', async () => {
  const states = []; let cursor = 0;
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useSyncExternalStore: (_subscribe, get) => get(), useEffect() {},
    useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
  };
  const plugin = await loadClientEntry(react), fixture = createContext();
  const dispose = await plugin.apply(fixture.ctx);
  const picker = fixture.slots.find(slot => slot.options.id === 'mathmodel-task-capabilities');
  const props = picker.options.inject('s1');
  let blank = true;
  props.sessions.list = { subscribe: () => () => {}, getSnapshot: () => ({ byId: { s1: { id: 's1', blank, projectionValues: { agentPreset: 'task-0f' } } } }) };
  const render = () => { cursor = 0; return picker.component(props); };
  const flatten = value => value && typeof value === 'object' ? [value, ...value.children.flatMap(flatten)] : [];
  let nodes = flatten(render());
  await nodes.find(node => node.props['aria-label'] === '任务前能力组合').props.onClick();
  nodes = flatten(render());
  assert.equal(nodes.filter(node => node.props.type === 'checkbox').length, 4);
  assert.equal(nodes.find(node => node.props.role === 'dialog').props['aria-modal'], true);
  const confirm = nodes.find(node => node.type === 'button' && node.children.includes('确认组合与 Host 快照'));
  assert.equal(confirm.props.disabled, false);
  await confirm.props.onClick();
  assert.ok(fixture.calls.includes('preset:s1:task-0f:host'));
  // The Host turn boundary is authoritative even while the list's blank flag is stale.
  fixture.remotes.mathmodelHostCapabilities.describe = async () => ({ ok: true, value: { hostHash: 'host', inventory: [], locked: true, matches: true } });
  nodes = flatten(render());
  await nodes.find(node => node.props['aria-label'] === '任务前能力组合').props.onClick();
  nodes = flatten(render());
  assert.ok(nodes.filter(node => node.props.type === 'checkbox').every(node => node.props.disabled));
  assert.ok(nodes.find(node => node.type === 'button' && node.children.includes('任务已锁定')).props.disabled);
  assert.equal(fixture.sends.length, 0);
  await dispose();
});

test('本任务开关在旧任务仍可编辑，读取真实服务并通过模型选择退出 Fusion', async () => {
  let states = [], cursor = 0, effects = [];
  const state = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
  };
  const react = {
    Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useSyncExternalStore: (_subscribe, get) => get(), useState: state,
    useRef: initial => state({ current: initial })[0], useEffect: effect => effects.push(effect),
  };
  const plugin = await loadClientEntry(react), fixture = createContext();
  const dispose = await plugin.apply(fixture.ctx);
  const picker = fixture.slots.find(slot => slot.options.id === 'mathmodel-task-capabilities');
  const props = picker.options.inject('s1');
  const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...value.children.flatMap(flatten)] : [];
  let nodes = flatten(picker.component(props));
  await nodes.find(node => node.props['aria-label'] === '任务前能力组合').props.onClick();
  cursor = 0;
  const extension = flatten(picker.component(props)).find(node => typeof node.type === 'function' && node.type.name === 'TaskExtensionSwitches');
  let runtime = { canEdit: true, selection: { skills: true, mcp: true, taskBoard: true, disabledMcpServers: [] },
    skillToolAvailable: true, toolCount: 84, model: { provider: 'dsh-model-fusion', model: 'auto' },
    modelGroups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash' }] }],
    inventory: [{ id: 'mcp', publishedTools: 16, servers: [{ entryId: 'mcp', serverName: 'academic-search', enabled: true, publishedTools: 16, tools: ['mcp__academic-search__search_papers'] }] }],
  };
  const changed = [], models = [];
  extension.props.actions = {
    describeTools: async () => runtime,
    setTools: async (id, selection) => { changed.push({ id, selection }); runtime = { ...runtime, selection }; return runtime; },
    selectModel: async (...args) => { models.push(args); return runtime; },
  };
  states = []; cursor = 0; effects = [];
  extension.type(extension.props); effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  cursor = 0; nodes = flatten(extension.type(extension.props));
  const checkbox = nodes.find(node => node.props.type === 'checkbox');
  assert.equal(checkbox.props.disabled, false);
  await checkbox.props.onChange({ target: { checked: false } });
  assert.equal(changed[0].selection.skills, false);
  cursor = 0; nodes = flatten(extension.type(extension.props));
  await nodes.find(node => node.type === 'button' && node.children.includes('关闭本任务 Fusion，使用普通模型')).props.onClick();
  assert.deepEqual(models, [['s1', 'deepseek-official', 'deepseek-flash']]);
  assert.equal(fixture.sends.length, 0);
  await dispose();
});

test('入口 Remote 信封解包、会话预设切换与连接重置使目录缓存失效', async () => {
  const plugin = await loadClientEntry();
  const fixture = createContext();
  const dispose = await plugin.apply(fixture.ctx);
  const overlay = fixture.slots[0].options.inject('s1');
  assert.equal((await overlay.loadSkillHelp()).title, '帮助');
  fixture.remotes.mathmodelCards.help = async () => ({ ok: false, error: { code: 'denied', message: '拒绝访问' } });
  await assert.rejects(overlay.loadSkillHelp(), (error) => error.code === 'denied' && /拒绝访问/.test(error.message));
  const session = { sessionId: 's1' };
  const request = { query: 'demo', signal: new AbortController().signal };
  assert.equal((await fixture.source.candidates(session, request))[0].name, 'demo-card');
  assert.equal(fixture.cardListCalls, 1);
  await fixture.source.candidates(session, request);
  assert.equal(fixture.cardListCalls, 1);
  fixture.events.get('agent-preset/selected')('s1', 'standard');
  await fixture.source.candidates(session, request);
  assert.equal(fixture.cardListCalls, 2);
  fixture.events.get('connection/reset')();
  await fixture.source.candidates(session, request);
  assert.equal(fixture.cardListCalls, 3);
  await dispose();
});

test('入口卡片取消不写草稿，CAS 冲突不发送', async () => {
  const plugin = await loadClientEntry();
  const fixture = createContext();
  const dispose = await plugin.apply(fixture.ctx);
  const flow = fixture.slots[0].options.inject('s1').flow;
  const card = { skill: 'demo-card', title: '演示', fields: [] };
  const span = { start: 0, end: 4, draftRev: 1 };
  flow.open({ sessionId: 's1', span, card });
  flow.cancel();
  assert.equal(fixture.bails.length, 0);
  assert.equal(fixture.sends.length, 0);
  flow.open({ sessionId: 's1', span, card });
  assert.equal(await flow.confirm(), false);
  assert.equal(fixture.bails.length, 1);
  assert.equal(fixture.bails[0].event, 'slash/input-insert-text');
  assert.equal(fixture.bails[0].payload.text, 'draft');
  assert.equal(fixture.sends.length, 0);
  assert.equal(flow.getSnapshot().open, false);
  await dispose();
});
