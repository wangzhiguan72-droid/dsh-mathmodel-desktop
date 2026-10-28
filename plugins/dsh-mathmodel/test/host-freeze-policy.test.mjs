import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HostMutationGate,
  HostMutationLockedError,
  assertHostMutationAllowed,
  hasStartedTaskBoundary,
  installPluginManagerFreeze,
  isSupportedPluginManagerChangeSource,
} from '../src/host-freeze-policy.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const agent = (boundary, id = 'a') => ({ id, boundary });
const blank = () => agent({ openTurnStartSeq: null, lastTurn: 0 });

test('started or missing turn boundary closes host mutations, including idle agents', () => {
  assert.equal(hasStartedTaskBoundary(blank()), false);
  assert.equal(hasStartedTaskBoundary(agent({ openTurnStartSeq: 4, lastTurn: 0 }, 'idle')), true);
  assert.equal(hasStartedTaskBoundary(agent({ openTurnStartSeq: null, lastTurn: 1 })), true);
  assert.equal(hasStartedTaskBoundary(agent(undefined)), true);
  assert.equal(hasStartedTaskBoundary(agent({ openTurnStartSeq: null })), true);
  assert.doesNotThrow(() => assertHostMutationAllowed([blank()]));
  assert.throws(() => assertHostMutationAllowed([agent({ openTurnStartSeq: null, lastTurn: 2 }, 'idle')]), HostMutationLockedError);
  assert.throws(() => assertHostMutationAllowed([agent(undefined)]), HostMutationLockedError);
  assert.throws(() => assertHostMutationAllowed(undefined), HostMutationLockedError);
});

test('shared read and write queue serializes tasks, releases on failure, and checks after waiting', async () => {
  const gate = new HostMutationGate();
  const entered = deferred(), releaseRead = deferred();
  const order = [];
  const reading = gate.read(async () => { entered.resolve(); await releaseRead.promise; order.push('read'); });
  await entered.promise;
  const writing = gate.write(async () => { order.push('write'); throw new Error('failed'); });
  const nextRead = gate.read(() => { order.push('next-read'); });
  await Promise.resolve();
  assert.deepEqual(order, []);
  releaseRead.resolve();
  await reading;
  await assert.rejects(writing, /failed/);
  await nextRead;
  assert.deepEqual(order, ['read', 'write', 'next-read']);
});

class OfficialShapeManager {
  async change(operation, request, reason) {
    return withFileLock('package.json', async () => {
      const result = { ...request, changed: false };
      try { await operation(result); }
      catch (error) { result.error = error; }
      await this.settle?.();
      result.reason = reason;
      result.event = 'plugin-manager/changed';
      return result;
    });
  }
}
const withFileLock = async (_path, operation) => operation();

test('queued change rejects when task starts while waiting; successful operation keeps lock through settlement', async () => {
  const gate = new HostMutationGate();
  let agents = [blank()];
  const manager = new OfficialShapeManager();
  const restore = installPluginManagerFreeze(manager, gate, () => agents);
  const readEntered = deferred(), releaseRead = deferred();
  const reading = gate.read(async () => { readEntered.resolve(); await releaseRead.promise; });
  await readEntered.promise;
  let ran = false;
  const changing = manager.change(async () => { ran = true; }, { requestId: 'one' }, 'install');
  agents = [agent({ openTurnStartSeq: 0, lastTurn: 1 }, 'idle')];
  releaseRead.resolve();
  await reading;
  const rejected = await changing;
  assert.equal(ran, false);
  assert.equal(rejected.error instanceof HostMutationLockedError, true);
  agents = [blank()];
  const changed = await manager.change(async () => { ran = true; }, {}, 'remove');
  assert.equal(changed.error, undefined);
  assert.equal(ran, true);
  restore();
});

test('change holds gate through operation and settlement; concurrent writes serialize', async () => {
  const gate = new HostMutationGate();
  const manager = new OfficialShapeManager();
  installPluginManagerFreeze(manager, gate, () => [blank()]);
  const opEntered = deferred(), finish = deferred(), settleEntered = deferred(), settleFinish = deferred();
  manager.settle = async () => { settleEntered.resolve(); await settleFinish.promise; };
  const order = [];
  const first = manager.change(async () => { opEntered.resolve(); await finish.promise; order.push('first'); }, {}, 'first');
  await opEntered.promise;
  const second = manager.change(async () => { order.push('second'); }, {}, 'second');
  const reading = gate.read(() => { order.push('read'); });
  await Promise.resolve();
  assert.deepEqual(order, []);
  finish.resolve();
  await settleEntered.promise;
  assert.deepEqual(order, ['first']);
  settleFinish.resolve();
  await Promise.all([first, second, reading]);
  assert.deepEqual(order, ['first', 'second', 'read']);
});

test('wrapper refuses unsupported method shape and restores only its own layer', async () => {
  const manager = new OfficialShapeManager();
  const ownBefore = Object.hasOwn(manager, 'change');
  const restore = installPluginManagerFreeze(manager, new HostMutationGate(), () => [blank()]);
  assert.equal(Object.hasOwn(manager, 'change'), true);
  const later = manager.change.bind(manager);
  manager.change = later;
  restore();
  assert.equal(manager.change, later);
  manager.change = OfficialShapeManager.prototype.change;
  const restore2 = installPluginManagerFreeze(manager, new HostMutationGate(), () => [blank()]);
  restore2();
  assert.equal(manager.change, OfficialShapeManager.prototype.change);
  assert.equal(ownBefore, false);
  assert.throws(() => installPluginManagerFreeze({ change: async () => {} }, new HostMutationGate(), () => []), /unsupported/i);
});

test('shape contract matches bundled official plugin manager 0.2.0-rc.2', async () => {
  const source = await readFile(fileURLToPath(new URL('../../../runtime/host/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js', import.meta.url)), 'utf8');
  assert.equal(isSupportedPluginManagerChangeSource(source.slice(source.lastIndexOf('async change(operation, request, reason)'))), true);
});
