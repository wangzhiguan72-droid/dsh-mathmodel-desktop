import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasCompleteWebFamily } = require('../src/runtime.cjs');

// Bundled @linxin666/dsh-web-all@0.4.7 cordis.patch.yml inserts these active
// shell rows. Its /rows route publishes only shell rows, excludes retired
// model-capabilities, and disables win-bash outside Windows. The desktop's
// existing optional UI policy also allows the user to turn off liangshen.
const required047 = [
  'dsh-client-ui-web-ui-settings', 'dsh-client-ui-plugin-manager',
  'dsh-client-ui-market', 'dsh-client-ui-task-board',
  'dsh-client-ui-task-board-github', 'dsh-client-ui-git-graph',
  'dsh-remote-web-ui', 'dsh-update', 'dsh-usage',
  'dsh-session-archive',
  ...(process.platform === 'win32' ? ['dsh-win-bash'] : []),
].map(name => '@linxin666/' + name);

test('0.4.7 update health accepts its required family with optional UI rows enabled or disabled', () => {
  assert.equal(hasCompleteWebFamily({ children: required047 }, '0.4.7'), true);
  assert.equal(hasCompleteWebFamily({ children: [...required047].reverse() }, '0.4.7'), true);
  assert.equal(hasCompleteWebFamily({ children: [
    ...required047, '@linxin666/dsh-liangshen', '@linxin666/dsh-ssh',
    '@linxin666/dsh-client-ui-skill-explorer',
  ] }, '0.4.7'), true);
});

test('0.4.7 update health rejects missing, duplicate, extra, and retired rows', () => {
  for (const missing of required047) {
    assert.equal(hasCompleteWebFamily({ children: required047.filter(row => row !== missing) }, '0.4.7'), false, missing);
  }
  assert.equal(hasCompleteWebFamily({ children: [...required047, required047[0]] }, '0.4.7'), false);
  assert.equal(hasCompleteWebFamily({ children: [...required047, '@linxin666/unexpected'] }, '0.4.7'), false);
  assert.equal(hasCompleteWebFamily({ children: [
    ...required047, '@linxin666/dsh-client-ui-model-capabilities',
  ] }, '0.4.7'), false);
  assert.equal(hasCompleteWebFamily({ children: null }, '0.4.7'), false);
});

test('update health does not accept unrecognized WebAll versions', () => {
  assert.equal(hasCompleteWebFamily({ children: required047 }, '0.4.8'), false);
  assert.equal(hasCompleteWebFamily({ children: required047 }, 'unknown'), false);
});

// Recorded from a real rc.4 + 0.4.11 boot: 0.4.11 has no /rows route, so health
// reads the plugin manager inventory. ssh and skill-explorer ship disabled.
const { activeWebFamilyRows } = require('../src/runtime.cjs');
const inventory0411 = require('./fixtures/web-family-0.4.11-inventory.json');

test('0.4.11 health accepts the recorded live family inventory', () => {
  const children = activeWebFamilyRows(inventory0411);
  assert.ok(!children.includes('@linxin666/dsh-ssh'), 'disabled rows are not active');
  assert.ok(!children.includes('@deepseek-harness/dsh-mathmodel'), 'non-family rows are ignored');
  assert.equal(hasCompleteWebFamily({ children }, '0.4.11'), process.platform === 'win32');
  assert.equal(hasCompleteWebFamily({ children: [...children, '@linxin666/dsh-ssh'] }, '0.4.11'), process.platform === 'win32');
  assert.equal(hasCompleteWebFamily({ children: children.filter(row => row !== '@linxin666/dsh-liangshen') }, '0.4.11'), process.platform === 'win32');
});

test('0.4.11 health rejects missing, inactive, duplicate, extra, and retired rows', () => {
  const children = activeWebFamilyRows(inventory0411);
  for (const missing of children.filter(row => row !== '@linxin666/dsh-liangshen')) {
    assert.equal(hasCompleteWebFamily({ children: children.filter(row => row !== missing) }, '0.4.11'), false, missing);
  }
  const plugins = inventory0411.plugins.map(row => row.moduleName === '@linxin666/dsh-update' ? { ...row, fiberPhase: 'failed' } : row);
  assert.equal(hasCompleteWebFamily({ children: activeWebFamilyRows({ plugins }) }, '0.4.11'), false);
  assert.equal(hasCompleteWebFamily({ children: [...children, children[0]] }, '0.4.11'), false);
  assert.equal(hasCompleteWebFamily({ children: [...children, '@linxin666/unexpected'] }, '0.4.11'), false);
  assert.equal(hasCompleteWebFamily({ children: [...children, '@linxin666/dsh-client-ui-model-capabilities'] }, '0.4.11'), false);
  assert.equal(activeWebFamilyRows(null), null);
  assert.equal(hasCompleteWebFamily({}, '0.4.11'), false);
});
