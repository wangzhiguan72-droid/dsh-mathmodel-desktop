import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createTaskCapabilityActions } = createRequire(import.meta.url)('../src/client-bundle.cjs');

test('manual combination only selects the captured blank session and never submits a prompt', async () => {
  const calls = [];
  let blank = true;
  const actions = createTaskCapabilityActions({ session: id => ({ id, blank }), describe: async () => ({ hostHash: 'host' }), confirm: async (...args) => { calls.push(args); return { preset: args[1] }; } });
  const preview = await actions.describe('first');
  assert.deepEqual(await actions.apply('first', 5, preview), { preset: 'task-05' });
  assert.deepEqual(calls, [['first', 'task-05', 'host']]);
  blank = false;
  await assert.rejects(actions.apply('first', 15), /已经开始/);
  for (const mask of [-1, 16, 1.5, '5']) await assert.rejects(actions.apply('first', mask), /无效/);
  assert.equal(calls.length, 1);
});

test('a server-side first-turn race remains a visible refusal', async () => {
  const actions = createTaskCapabilityActions({ session: () => ({ blank: true }), confirm: async () => { throw new Error('agent-preset/locked'); } });
  await assert.rejects(actions.apply('raced', 0, { hostHash: 'host' }), /locked/);
  await assert.rejects(actions.apply('raced', 0), /Host/);
});

test('idle task switches and model choice bypass the first-turn preset lock without sending messages', async () => {
  const calls = [];
  const actions = createTaskCapabilityActions({
    session: () => ({ blank: false }),
    describeTools: async id => ({ sessionId: id }),
    setTools: async (...args) => { calls.push(['tools', ...args]); return { selection: args[1] }; },
    selectModel: async (...args) => { calls.push(['model', ...args]); return { provider: args[1] }; },
  });
  const selection = { skills: false, mcp: false, taskBoard: false, disabledMcpServers: [] };
  assert.deepEqual(await actions.describeTools('s1'), { sessionId: 's1' });
  assert.deepEqual(await actions.setTools('s1', selection), { selection });
  assert.deepEqual(await actions.selectModel('s1', 'deepseek-official', 'deepseek-flash'), { provider: 'deepseek-official' });
  assert.deepEqual(calls, [['tools', 's1', selection], ['model', 's1', 'deepseek-official', 'deepseek-flash']]);
});
