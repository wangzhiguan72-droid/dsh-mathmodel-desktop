import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '../../../resources/runtime/host/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { WriteLocks, children, childGuard, pathKey } from '../src/handoff.js';

test('写锁重叠被拒绝并写明占用者，释放后可再占用', () => {
  const locks = new WriteLocks();
  assert.deepEqual(locks.acquire('h1', ['src/a.js', 'src/b.js'], 'D:/r'), { ok: true });
  const r = locks.acquire('h2', ['src/c.js', 'src/b.js'], 'D:/r');
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].holder, 'h1');
  assert.equal(r.conflicts[0].file, 'src/b.js');
  assert.deepEqual(locks.acquire('h3', ['src/c.js'], 'D:/r'), { ok: true }, '失败的 acquire 不占用 c.js');
  locks.release('h1');
  assert.deepEqual(locks.acquire('h2', ['src/b.js'], 'D:/r'), { ok: true });
});

test('Windows 下大小写与分隔符不同也算同一文件', { skip: process.platform !== 'win32' }, () => {
  const locks = new WriteLocks();
  locks.acquire('h1', ['src/a.js'], 'D:/r');
  assert.equal(locks.acquire('h2', ['D:\\R\\SRC\\A.js'], 'D:/r').ok, false);
});

test('子代理守卫：禁止再派、只读不能写、写入只能写 files', t => {
  t.after(() => children.clear());
  children.set('c-read', { role: 'explore', files: new Set(), cwd: 'D:/r' });
  children.set('c-impl', { role: 'implement', files: new Set([pathKey('src/a.js', 'D:/r')]), cwd: 'D:/r' });
  const g = (id, name, file_path) => childGuard({ agent: { id }, name, arguments: { file_path } });
  assert.match(g('c-read', 'delegate'), /不能再派/);
  assert.match(g('c-impl', 'delegate'), /不能再派/);
  assert.match(g('c-read', 'edit', 'src/a.js'), /只读/);
  assert.match(g('c-read', 'write', 'src/a.js'), /只读/);
  assert.equal(g('c-read', 'read', 'src/a.js'), undefined);
  assert.equal(g('c-impl', 'write', 'src/a.js'), undefined);
  assert.match(g('c-impl', 'edit', 'src/z.js'), /files/);
  assert.match(childGuard({ agent: { id: 'c-impl' }, name: 'write', arguments: {} }), /files/, '缺路径按越界处理');
  assert.equal(g('parent', 'write', 'src/z.js'), undefined, '主代理不受约束');
  assert.equal(childGuard({ name: 'write', arguments: {} }), undefined, '无 agent 的调用不受约束');
});

test('守卫经 ToolRuntime 生效', t => {
  const root = new Context();
  root.provide('systemPrompt', { tools: () => () => {} });
  new ToolRuntime(root, { mode: 'native' });
  t.after(root.tools.guard(childGuard));
  t.after(() => children.clear());
  children.set('c1', { role: 'review', files: new Set(), cwd: 'D:/r' });
  assert.match(root.tools.guardReason({ agent: { id: 'c1' }, name: 'write', arguments: { file_path: 'x' } }), /只读/);
});
