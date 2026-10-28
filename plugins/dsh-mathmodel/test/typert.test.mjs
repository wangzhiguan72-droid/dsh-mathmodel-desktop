import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT } from '../lib/typert.host.js';
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js';
import { MathmodelCardsGateway } from '../lib/host.js';
import { MathmodelHostCapabilitiesGateway } from '../src/host-capabilities.js';

test('新版 Cordis 与 Typert 实际注册卡片 Remote 并执行调用', async () => {
  const ctx = new Context();
  const cards = {
    list: async () => ['card'],
    help: async () => ({ title: 'help' }),
    render: async () => ({ text: 'draft' }),
  };
  const gateway = new MathmodelCardsGateway(ctx, cards);
  assert.equal(ctx.get('mathmodelCards').name, 'mathmodelCards');
  assert.deepEqual(remoteMethods(gateway).map((entry) => entry.method), ['list', 'help', 'render']);
  assert.deepEqual(await gateway.list(), ['card']);
  assert.deepEqual(await gateway.render(), { text: 'draft' });
});

test('Client 与 Host Remote 端点完全一致', () => {
  assert.deepEqual(
    TYPERT_REMOTE.descriptors.map((item) => item.id),
    TYPERT.invocations.map((item) => item.id),
  );
});

test('Host 快照 Remote 在真实 Cordis 中注册 describe 与 confirm', async () => {
  const ctx = new Context();
  const gateway = new MathmodelHostCapabilitiesGateway(ctx, { describe: async id => ({ id }), confirm: async (...args) => args });
  assert.deepEqual(remoteMethods(gateway).map(entry => entry.method), ['describe', 'confirm', 'describeTools', 'setTools', 'selectModel']);
  assert.deepEqual(await gateway.describe('s1'), { id: 's1' });
  assert.deepEqual(await gateway.confirm('s1', 'task-05', 'digest'), ['s1', 'task-05', 'digest']);
});

test('浏览器 bundle 的 Remote 签名与 Host 清单一致', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/client-bundle.cjs', import.meta.url), 'utf8'));
  const browserDescriptors = [...source.matchAll(/descriptor\('([^']+)', '([^']+)'(?:, \[([^\]]*)\])?\)/g)].map((match) => ({
    id: `${match[1]}.${match[2]}`,
    parameters: [...(match[3] ?? '').matchAll(/param\('([^']+)'\)/g)].map((parameter) => parameter[1]),
  }));
  const hostDescriptors = TYPERT.invocations.map((item) => ({
    id: `${item.service}.${item.method}`,
    parameters: item.parameters.map((parameter) => parameter.name),
  }));
  assert.deepEqual(browserDescriptors, hostDescriptors);
});

test('浏览器入口先挂载贡献，再访问 mathmodel Remote', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
  const mount = source.indexOf('await ctx.remote.$mount(TYPERT_REMOTE)');
  const resolveRemote = source.indexOf("ctx.get('remote.mathmodelCards')");
  const firstCall = source.indexOf('mathmodelCards.list()');
  const unwrap = source.indexOf('async function unwrapRemote');
  assert.ok(mount >= 0);
  assert.ok(resolveRemote > mount);
  assert.ok(unwrap >= 0);
  assert.ok(firstCall > mount);
  assert.match(source, /unwrapRemote\(\s*mathmodelCards\.render/);
  assert.match(source, /await disposeRemote\(\)/);
});
