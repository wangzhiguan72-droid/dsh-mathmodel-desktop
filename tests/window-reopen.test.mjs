import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/main.cjs', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf("  app.on('second-instance'"), source.indexOf('  app.whenReady()'));

function reopen({ programmatic = false, minimized = false, destroyed = false, absent = false } = {}) {
  const calls = [];
  let callback;
  vm.runInNewContext(handler, {
    app: { on: (_, fn) => { callback = fn; } },
    isProgrammaticLaunch: () => programmatic,
    mainWindow: absent ? null : {
      isDestroyed: () => destroyed,
      isMinimized: () => minimized,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
    },
  });
  callback(null, []);
  return calls;
}

test('reopening a hidden running desktop shows and focuses its window', () => {
  assert.deepEqual(reopen(), ['show', 'focus']);
  assert.deepEqual(reopen({ minimized: true }), ['restore', 'show', 'focus']);
});

test('helper launches do not raise the window, and closed windows are ignored', () => {
  assert.deepEqual(reopen({ programmatic: true }), []);
  assert.deepEqual(reopen({ destroyed: true }), []);
  assert.deepEqual(reopen({ absent: true }), []);
});
