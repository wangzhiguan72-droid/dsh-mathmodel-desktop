import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = fs.readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8');
function load(protocol, hostname) {
  const ipc = new EventEmitter(), exposed = {}, calls = [];
  ipc.invoke = async channel => { calls.push(channel); return { phase: 'current', currentVersion: '0.1.2' }; };
  vm.runInNewContext(source, { location: { protocol, hostname },
    window: { addEventListener() {} }, require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } }, ipcRenderer: ipc };
    } });
  return { exposed, ipc, calls };
}

test('only the owned local GUI receives the update state and confirmation bridge', async () => {
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const { exposed, calls } = load('http:', hostname);
    assert.deepEqual(Object.keys(exposed.desktopUpdates).sort(), ['getState', 'onState', 'open']);
    assert.equal((await exposed.desktopUpdates.getState()).currentVersion, '0.1.2');
    await exposed.desktopUpdates.open();
    assert.deepEqual(calls, ['desktop:update-state', 'desktop:update-open']);
  }
  for (const [protocol, hostname] of [['file:', ''], ['https:', 'example.test'], ['http:', '127.0.0.1.example.test']]) {
    assert.equal(load(protocol, hostname).exposed.desktopUpdates, undefined);
  }
});

test('sidebar subscriptions release their IPC listener when unmounted', () => {
  const { exposed, ipc } = load('http:', '127.0.0.1');
  const observed = [];
  const remove = exposed.desktopUpdates.onState(value => observed.push(value.phase));
  ipc.emit('desktop:update-status', {}, { phase: 'available' });
  remove();
  ipc.emit('desktop:update-status', {}, { phase: 'current' });
  assert.deepEqual(observed, ['available']);
  assert.equal(ipc.listenerCount('desktop:update-status'), 0);
});
