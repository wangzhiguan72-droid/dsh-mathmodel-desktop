import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { installCompileCacheFlush } = createRequire(import.meta.url)('../src/host-compile-cache.cjs');

test('saves an enabled compile cache without keeping the host alive', () => {
  const scheduled = [], canceled = [];
  let saved = 0, unref = 0;
  const dispose = installCompileCacheFlush({
    modules: { getCompileCacheDir: () => 'fixture-cache', flushCompileCache: () => { saved++; } },
    schedule: (callback, delay) => { const timer = { callback, delay, unref: () => { unref++; } }; scheduled.push(timer); return timer; },
    cancel: timer => canceled.push(timer),
  });
  assert.deepEqual(scheduled.map(timer => timer.delay), [3000, 10000, 30000]);
  assert.equal(unref, 3);
  scheduled.forEach(timer => timer.callback());
  assert.equal(saved, 3);
  dispose();
  assert.deepEqual(canceled, scheduled);
});

test('disabled or unavailable cache does nothing and cache write errors do not stop boot', () => {
  let scheduled = 0;
  for (const modules of [{}, { getCompileCacheDir: () => undefined }]) {
    installCompileCacheFlush({ modules, schedule: () => { scheduled++; } })();
  }
  assert.equal(scheduled, 0);
  const dispose = installCompileCacheFlush({
    modules: { getCompileCacheDir: () => 'fixture-cache', flushCompileCache: () => { throw new Error('read-only cache'); } },
    schedule: callback => { assert.doesNotThrow(callback); return { unref() {} }; }, cancel() {},
  });
  dispose();
});
