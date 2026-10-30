import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '../../../resources/runtime/host/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { apply, writeLocks, children } from '../src/handoff.js';

const KNOWN = new Set(['magpie']);
const receipt = (files = [], extra = {}) => ({ status: 'done', summary: 's', findings: [], files_changed: files, commands_run: [], not_verified: [], open_questions: [], ...extra });

function setup(config = {}) {
  const root = new Context();
  const sections = [];
  root.provide('systemPrompt', { tools: () => () => {}, section: s => { sections.push(s); return () => {}; }, getSectionOrder: () => 2800 });
  new ToolRuntime(root, { mode: 'native' });
  const fake = { started: [], pending: [], disposed: 0 };
  root.provide('subagents', {
    startActivation(spec) {
      fake.started.push(spec);
      let settle;
      const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      fake.pending.push(settle);
      return Promise.resolve({ childId: spec.childId, result, dispose: () => { fake.disposed++; } });
    },
  });
  root.provide('workingDirectory', { ensure: async () => 'D:/r' });
  root.provide('llm', { resolveCallConfig: async ({ provider }) => { if (!KNOWN.has(provider)) throw new Error(`no provider ${provider}`); } });
  const ledger = [];
  let n = 0;
  apply(root, config, { randomUUID: () => `id-${++n}`, now: () => 't', appendLine: async (_file, row) => { ledger.push(row); }, readLedger: async () => ledger });
  fake.resolve = value => fake.pending.shift().resolve(value);
  fake.reject = error => fake.pending.shift().reject(error);
  const call = (name, args, signal = new AbortController().signal, agent = { id: 'p1' }) => root.tools.get(name).execute(args, { agent, signal, callId: 'c' });
  return { root, fake, ledger, sections, call };
}
const brief = (role, files = []) => ({ role, title: '一块活', goal: 'g', context: 'c', files, constraints: 'k', done_when: 'd', ...(role === 'escalate' ? { escalates: 'id-0' } : {}) });
const tick = () => new Promise(r => setImmediate(r));

test.afterEach(() => { for (const id of [...children.keys()]) { writeLocks.release(id); children.delete(id); } });

test('缺字段不启动子代理，错误里列出缺失项', async () => {
  const { fake, call } = setup();
  await assert.rejects(call('delegate', { role: 'explore', title: 't' }), /goal/);
  assert.equal(fake.started.length, 0);
});

test('按角色选路线，带上 outputSchema、预留 childId 与 caller 交付', async () => {
  const { fake, call } = setup();
  const p = call('delegate', brief('review'));
  await tick();
  fake.resolve({ structured: receipt([], { verdict: 'pass' }), stopReason: 'end_turn' });
  const r = await p;
  const spec = fake.started[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.childId, 'id-1');
  assert.equal(spec.request.parent.id, 'p1');
  assert.deepEqual(spec.request.agentOptions, { provider: 'magpie', model: 'workbuddy-ai/gpt-6-astra' });
  assert.ok(spec.request.outputSchema.required.includes('verdict'));
  assert.match(spec.request.prompt[0].text, /看不到主对话/);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.status, 'done');
  const flash = setup();
  const q = flash.call('delegate', brief('explore'));
  await tick();
  flash.fake.resolve({ structured: receipt(), stopReason: 'end_turn' });
  await q;
  assert.equal(flash.fake.started[0].request.agentOptions.model, 'workbuddy-ai/deepseek-v4.1-flash');
});

test('路线不存在时报角色名、不启动', async () => {
  const { fake, call } = setup({ roles: { explore: { provider: 'nope', model: 'x' } } });
  await assert.rejects(call('delegate', brief('explore')), /explore/);
  assert.equal(fake.started.length, 0);
});

test('两个 implement 争同一个文件，第二个被拒绝；第一个结束后释放', async () => {
  const { fake, call } = setup();
  const first = call('delegate', brief('implement', ['src/a.js']));
  await tick();
  await assert.rejects(call('delegate', brief('implement', ['src/a.js'])), /src\/a\.js[\s\S]*id-1/);
  assert.equal(fake.started.length, 1);
  fake.resolve({ structured: receipt(['src/a.js']), stopReason: 'end_turn' });
  await first;
  const third = call('delegate', brief('implement', ['src/a.js']));
  await tick();
  assert.equal(fake.started.length, 2);
  fake.resolve({ structured: receipt(['src/a.js']), stopReason: 'end_turn' });
  await third;
});

test('只读交接可以并行，不占写锁', async () => {
  const { fake, call } = setup();
  const a = call('delegate', brief('explore', ['src/a.js']));
  const b = call('delegate', brief('explore', ['src/a.js']));
  await tick();
  assert.equal(fake.started.length, 2);
  fake.resolve({ structured: receipt(), stopReason: 'end_turn' });
  fake.resolve({ structured: receipt(), stopReason: 'end_turn' });
  await Promise.all([a, b]);
});

test('运行中的子代理被守卫约束，结束后解除', async () => {
  const { root, fake, call } = setup();
  const p = call('delegate', brief('explore'));
  await tick();
  assert.match(root.tools.guardReason({ agent: { id: 'id-1' }, name: 'write', arguments: { file_path: 'x' } }), /只读/);
  fake.resolve({ structured: receipt(), stopReason: 'end_turn' });
  await p;
  assert.equal(root.tools.guardReason({ agent: { id: 'id-1' }, name: 'write', arguments: { file_path: 'x' } }), undefined);
});

test('子代理失败也释放写锁并写 end 行', async () => {
  const { fake, ledger, call } = setup();
  const p = call('delegate', brief('implement', ['src/a.js']));
  await tick();
  fake.reject(new Error('model down'));
  await assert.rejects(p, /model down/);
  assert.equal(ledger.at(-1).kind, 'end');
  assert.match(ledger.at(-1).error, /model down/);
  assert.equal(writeLocks.acquire('x', ['src/a.js'], 'D:/r').ok, true);
  writeLocks.release('x');
});

test('回执缺失记为 blocked 并标违规；output 块展平成文字，diagnostic 带出', async () => {
  const { fake, call } = setup();
  const p = call('delegate', brief('explore'));
  await tick();
  fake.resolve({ output: [{ type: 'text', text: '没' }, { type: 'image', data: 'x' }, { type: 'text', text: '交回执' }], diagnostic: 'schema 未满足', stopReason: 'error' });
  const r = await p;
  assert.equal(r.status, 'blocked');
  assert.equal(r.violations.length, 1);
  assert.equal(r.output, ['没', '交回执'].join('\n'));
  assert.equal(r.diagnostic, 'schema 未满足');
  assert.equal(r.stopReason, 'error');
});

test('默认交接 id 用内核的 session- 前缀', async () => {
  const root = new Context();
  root.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 2800 });
  new ToolRuntime(root, { mode: 'native' });
  const ids = [];
  root.provide('subagents', { startActivation: async spec => { ids.push(spec.childId); return { result: Promise.resolve({ structured: receipt(), stopReason: 'completed' }), dispose() {} }; } });
  root.provide('workingDirectory', { ensure: async () => 'D:/r' });
  apply(root, {}, { now: () => 't', appendLine: async () => {}, readLedger: async () => [] });
  await root.tools.get('delegate').execute(brief('explore'), { agent: { id: 'p1' }, signal: new AbortController().signal });
  assert.match(ids[0], /^session-[0-9a-f-]{36}$/);
});

test('只读角色报告改了文件，结果、渲染和账本都带违规', async () => {
  const { root, fake, ledger, call } = setup();
  const p = call('delegate', brief('explore'));
  await tick();
  fake.resolve({ structured: receipt(['src/b.js']), stopReason: 'end_turn' });
  const r = await p;
  assert.equal(r.violations.length, 1);
  assert.equal(ledger.at(-1).violations.length, 1);
  assert.deepEqual(ledger.map(row => row.kind), ['start', 'end']);
  const text = root.tools.get('delegate').output.render(brief('explore'), r).map(part => part.text).join('\n');
  assert.match(text, /\[explore\] 一块活 · done · 改动 1 个文件/);
  assert.match(text, /⚠ 违规/);
});

test('中止调用会 dispose 子代理', async () => {
  const { fake, call } = setup();
  const ac = new AbortController();
  const p = call('delegate', brief('explore'), ac.signal);
  await tick();
  ac.abort();
  fake.reject(new Error('aborted'));
  await p.catch(() => {});
  assert.equal(fake.disposed, 1);
});

test('handoff_ledger 只列本会话，默认 20 条', async () => {
  const { ledger, call } = setup();
  for (let i = 0; i < 25; i++) ledger.push({ kind: 'start', id: `a${i}`, parent: 'p1', role: 'explore', title: `t${i}` }, { kind: 'end', id: `a${i}`, status: 'done', violations: [] });
  for (let i = 0; i < 3; i++) ledger.push({ kind: 'start', id: `b${i}`, parent: 'p2', role: 'explore', title: 'x' });
  const r = await call('handoff_ledger', {});
  assert.equal(r.handoffs.length, 20);
  assert.equal(r.handoffs[0].id, 'a5');
  assert.deepEqual(r.handoffs.at(-1), { id: 'a24', role: 'explore', title: 't24', status: 'done', violations: 0 });
  assert.equal((await call('handoff_ledger', { limit: 3 })).handoffs.length, 3);
});

test('系统提示段是固定文本，包含“回执是报告，不是证据”', () => {
  const { sections } = setup();
  const section = sections.find(s => s.name === 'tool:delegate');
  assert.equal(section.text(), section.text());
  assert.match(section.text(), /回执是报告，不是证据/);
});
