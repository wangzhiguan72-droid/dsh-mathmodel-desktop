import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStartupTiming, configureHostCompileCache } = require('../src/startup-timing.cjs');

test('desktop startup lines show wall time and elapsed monotonic time', () => {
  let tick = 100;
  const timing = createStartupTiming({ now: () => tick, iso: () => '2026-10-22T09:00:00.000Z' });
  tick = 154.6;
  assert.equal(timing.annotate('[desktop] GUI loaded'),
    '[desktop] GUI loaded [startup +55ms 2026-10-22T09:00:00.000Z]');
  assert.equal(timing.stage('gui-loaded'), '[desktop] startup gui-loaded: 55ms since previous stage');
  tick = 170;
  assert.equal(timing.stage('complete'), '[desktop] startup complete: 15ms since previous stage');
});

test('host output, including the anchored tokenized URL, remains unchanged', () => {
  const timing = createStartupTiming({ now: () => 5, iso: () => 'unused' });
  const line = 'dsh web: http://127.0.0.1:3082/?token=example';
  assert.equal(timing.annotate(line), line);
  assert.equal(timing.annotate('Processing request of type ListToolsRequest'),
    'Processing request of type ListToolsRequest');
});

test('compile cache default preserves the update title and host arguments', () => {
  const original = ['--title=update-host', 'host.js', '--profile', 'mathmodel'];
  const launch = configureHostCompileCache(original, {}, {
    hostBin: 'host.js', preloadPath: 'startup-cache.cjs', cacheDir: 'home/cache/node-compile',
    preloadExists: () => true,
  });
  assert.deepEqual(launch.args,
    ['--title=update-host', '--require', 'startup-cache.cjs', 'host.js', '--profile', 'mathmodel']);
  assert.equal(launch.env.NODE_COMPILE_CACHE, 'home/cache/node-compile');
  assert.deepEqual(original, ['--title=update-host', 'host.js', '--profile', 'mathmodel']);
});

test('compile cache respects an existing path and a disable switch', () => {
  const options = { hostBin: 'host.js', preloadPath: 'startup-cache.cjs',
    cacheDir: 'default-cache', preloadExists: () => true };
  const custom = configureHostCompileCache(['host.js'], { NODE_COMPILE_CACHE: 'custom-cache' }, options);
  assert.equal(custom.env.NODE_COMPILE_CACHE, 'custom-cache');
  assert.deepEqual(custom.args, ['--require', 'startup-cache.cjs', 'host.js']);
  const disabled = configureHostCompileCache(['host.js'], { NODE_DISABLE_COMPILE_CACHE: '1' }, options);
  assert.equal(disabled.env.NODE_COMPILE_CACHE, undefined);
  assert.deepEqual(disabled.args, ['host.js']);
});

test('missing preload does not alter the host command', () => {
  const launch = configureHostCompileCache(['host.js'], {}, {
    hostBin: 'host.js', preloadPath: 'missing.cjs', cacheDir: 'default-cache',
    preloadExists: () => false,
  });
  assert.deepEqual(launch.args, ['host.js']);
});
