import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const bundle = fs.readFileSync(path.join(root, 'plugins/dsh-model-fusion/lib/dsh-model-fusion.js'), 'utf8');
// Upstream 0.2.8 picks the subagent API by presence (subagent-seam.ts), so load that
// region together with the transport class.
const start = bundle.indexOf('//#region src/host/subagent-seam.ts');
const end = bundle.indexOf('//#endregion', bundle.indexOf('var NativeWorkerTransport = class {'));
assert.ok(start >= 0 && end > start);
const Transport = vm.runInNewContext(`${bundle.slice(start, end)}\nNativeWorkerTransport`, {
  SessionId$1: value => value,
  ReasoningEffortId: value => value,
});

test('Fusion creates a reserved local activation with parent delivery and accepts its message id', async () => {
  let spec;
  const parent = { id: 'lead', session: { header: { delegationDepth: 0 } } };
  const ctx = {
    agents: { get: () => undefined },
    subagents: {
      getProvider: () => ({ prepareContinuable() {}, inheritsParentContext: false }),
      async startActivation(value) { spec = value; return { childId: value.childId, messageId: 'accepted-1', result: Promise.resolve({ stopReason: 'completed' }), dispose() {} }; },
    },
  };
  const transport = new Transport(ctx);
  const accepted = await transport.start(parent, {
    childId: 'reserved-worker', label: 'work', brief: 'task',
    route: { provider: 'deepseek', model: 'worker', reasoningEffort: 'medium' },
  }, new AbortController().signal);
  assert.equal(accepted.messageId, 'accepted-1');
  assert.equal(spec.delivery, 'parent');
  assert.equal(spec.childId, 'reserved-worker');
  assert.equal(spec.request.parent, parent);
  assert.equal(spec.request.maxDepth, 1);
  assert.equal(spec.request.prompt[0].text, 'task');
  assert.equal(spec.request.agentOptions.model, 'worker');
  assert.equal('persona' in spec.request, false);
  assert.equal('toolFilter' in spec.request, false);
});

test('Fusion continues the same child and drains only its direct child', async () => {
  let sent, drained;
  const parent = { id: 'lead' };
  const ctx = {
    agents: { get: () => undefined },
    subagents: {
      async sendMessage(...args) { sent = args; return 'accepted-2'; },
      async drainChildren(...args) { drained = args; },
    },
  };
  const transport = new Transport(ctx);
  const accepted = await transport.continue(parent, 'worker', 'feedback', new AbortController().signal);
  assert.equal(accepted.childId, 'worker');
  assert.equal(accepted.messageId, 'accepted-2');
  assert.equal(sent[0], parent);
  assert.equal(sent[1], 'worker');
  assert.equal(sent[2][0].text, 'feedback');
  await transport.release(parent, 'worker');
  assert.equal(drained[0], parent);
  assert.equal(drained[1][0], 'worker');
});

test('Fusion worker scope keeps the configured tool ceiling after the API migration', () => {
  // 0.2.1 dropped the start-time toolFilter. Upstream 0.2.8 returns the configured
  // workerTools as an implement-mode Worker's allowlist, and the worker scope restricts to it.
  const coordinator = fs.readFileSync(path.join(root, 'plugins/dsh-model-fusion/src/host/coordinator.ts'), 'utf8');
  const scopes = fs.readFileSync(path.join(root, 'plugins/dsh-model-fusion/src/host/native-scopes.ts'), 'utf8');
  assert.match(coordinator, /return hasStartActivation\(this\.ctx\.subagents\) \? \[\.\.\.this\.options\.workerTools\] : undefined/);
  assert.match(scopes, /if \(role === 'worker'\) stageDisposers\.push\(scope\.tools\.restrict\(\{ allow: tools \}\)\)/);
  assert.match(bundle, /return hasStartActivation\(this\.ctx\.subagents\) \? \[\.\.\.this\.options\.workerTools\] : void 0;/);
  assert.match(bundle, /if \(role === "worker"\) stageDisposers\.push\(scope\.tools\.restrict\(\{ allow: tools \}\)\);/);
});
