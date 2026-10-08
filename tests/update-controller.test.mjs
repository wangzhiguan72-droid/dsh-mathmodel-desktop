import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createUpdateController, validateFeedUrl } = require('../src/update-controller.cjs');

async function fixture(t, answers, savedSettings, coreOverrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-update-controller-'));
  const userData = path.join(root, 'data'); await mkdir(userData);
  if (savedSettings !== undefined) await writeFile(path.join(userData, 'desktop-update-settings.json'), savedSettings);
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  const calls = [], handlers = new Map();
  const webContents = { mainFrame: {}, send: (_channel, state) => calls.push(['state', state.phase]) };
  const window = { webContents, isDestroyed: () => false };
  const app = { isPackaged: true, getVersion: () => '0.1.1', getPath: name => name === 'exe' ? path.join(root, 'app.exe') : userData,
    quit: () => calls.push(['quit']) };
  const controller = createUpdateController({ app, getWindow: () => window, getNodeBin: () => 'owned-node.exe', log: () => {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showMessageBox: async (_window, options) => { calls.push(['dialog', options.title]); return { response: answers.shift() ?? 1 }; } },
    core: { checkForUpdate: async () => { calls.push(['check']); return { available: true, release: { version: '0.1.2', notes: 'fixture' } }; },
      prepareUpdate: async () => { calls.push(['prepare']); return { toVersion: '0.1.2' }; },
      launchUpdate: async () => { calls.push(['worker-ready']); },
      readLastUpdate: () => null, prepareRollback: async () => null, ...coreOverrides } });
  return { controller, calls, handlers, window };
}

test('checking highlights availability but decline never downloads or quits', async t => {
  const { controller, calls } = await fixture(t, [1]);
  await controller.check();
  assert.equal(controller.getState().phase, 'available');
  await controller.open();
  assert.equal(calls.some(([name]) => ['prepare', 'worker-ready', 'quit'].includes(name)), false);
});

test('download and restart require separate consent, worker is ready before quit', async t => {
  const { controller, calls } = await fixture(t, [0, 1, 0]);
  await controller.check(); await controller.open();
  assert.equal(controller.getState().phase, 'ready');
  assert.equal(calls.filter(([name]) => name === 'prepare').length, 1);
  assert.equal(calls.some(([name]) => name === 'quit'), false);
  await controller.open();
  assert.ok(calls.findIndex(([name]) => name === 'worker-ready') < calls.findIndex(([name]) => name === 'quit'));
});

test('update IPC refuses foreign renderers and subframes', async t => {
  const { handlers, window, calls } = await fixture(t, [0, 0]);
  await handlers.get('desktop:update-open')({ sender: {}, senderFrame: {} });
  await handlers.get('desktop:update-open')({ sender: window.webContents, senderFrame: {} });
  assert.deepEqual(calls, []);
});

test('custom channels require HTTPS without URL credentials', () => {
  assert.equal(validateFeedUrl('https://example.test/releases/feed.json'), 'https://example.test/releases/feed.json');
  for (const value of ['http://example.test/feed', 'https://u:p@example.test/feed', 'file:///C:/feed', 'https://example.test/#fragment']) {
    assert.throws(() => validateFeedUrl(value));
  }
});

test('corrupt saved settings disable checking until the user repairs the selected channel', async t => {
  const { controller, calls } = await fixture(t, [], '{broken json');
  assert.equal(controller.getState().phase, 'error');
  await controller.start(); await controller.check();
  assert.equal(calls.some(([name]) => name === 'check'), false);
  assert.match(controller.getState().detail, /更新设置无效/);
});

test('corrupt startup records show a diagnostic without an unhandled rejection or network check', async t => {
  const { controller, calls } = await fixture(t, [], undefined, {
    readLastUpdate: () => { throw new Error('malformed desktop update record'); },
  });
  await controller.start();
  assert.equal(controller.getState().phase, 'error');
  assert.match(controller.getState().detail, /malformed desktop update record/);
  assert.equal(calls.some(([name]) => name === 'check'), false);
});
