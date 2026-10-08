import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function loadClientEntry() {
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
    if (name === 'react') return {};
    if (name === 'react-dom') return {};
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
  };
  const ctx = {
    remote: {
      async $mount(manifest) { calls.push('mount'); assert.equal(manifest.descriptors.length, 20); return async () => calls.push('dispose'); },
      $on(name, handler) { events.set(name, handler); },
    },
    get(name) {
      calls.push(`get:${name}`);
      if (name.startsWith('remote.')) return remotes[name.slice(7)] ?? (name === 'remote.skills' ? { list: async () => ({ ok: true, value: { skills: [{ name: 'demo-card' }] } }) } : undefined);
      if (name === 'sessions') return { subagentAddress: () => undefined, scope: () => ({ bail(_ctx, event, payload) { bails.push({ event, payload }); return false; } }) };
      if (name === 'conversation') return { blocks: { set() {} }, input: { for: () => ({ notify() {}, send(...args) { sends.push(args); } }) }, draftImages: () => [], releaseDraftImages() {} };
      if (name === 'inputTriggers') return { registerSource(value) { source = value; return () => {}; } };
    },
    effect(callback) { return callback(); },
    slots: {
      inject(name, callback) { assert.match(name, /^conversation\.input\./); callback(); },
      register(options, component) { slots.push({ options, component }); return () => {}; },
    },
    on(name, handler) { events.set(name, handler); },
  };
  return { ctx, calls, slots, events, remotes, bails, sends, get source() { return source; }, get cardListCalls() { return cardListCalls; } };
}

test('浏览器入口先挂载 Remote，再读取服务；注册五个 Slot 与 Skill InputTrigger', async () => {
  const plugin = await loadClientEntry();
  const fixture = createContext();
  const dispose = await plugin.apply(fixture.ctx);
  assert.equal(fixture.calls[0], 'mount');
  assert.equal(fixture.calls[1], 'get:remote.mathmodelCards');
  assert.deepEqual(fixture.slots.map(({ options }) => options.id), [
    'mathmodel-card', 'mathmodel-image-connection-settings', 'mathmodel-opencode-rt-add-provider',
    'mathmodel-stored-key-model-discovery', 'mathmodel-manual-vision-draft',
  ]);
  assert.equal(fixture.source.trigger, '/');
  assert.equal(fixture.source.name, 'skill');
  await dispose();
  assert.equal(fixture.calls.at(-1), 'dispose');
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
