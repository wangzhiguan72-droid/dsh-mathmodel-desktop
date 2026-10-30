import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrief, renderBrief, receiptSchema, checkViolation } from '../src/handoff.js';
import { assertObjectJsonSchema } from '../../../resources/runtime/host/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

const base = { role: 'explore', title: '查登录', goal: '找出登录失败原因', context: '已排除网络', files: [], constraints: '不改代码', done_when: '给出文件:行号' };

test('缺字段时列出全部缺失项', () => {
  const r = validateBrief({ role: 'explore', title: '查' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.sort(), ['constraints', 'context', 'done_when', 'goal']);
});

test('implement 必须给 files，escalate 必须给 escalates', () => {
  assert.equal(validateBrief({ ...base, role: 'implement' }).ok, false);
  assert.deepEqual(validateBrief({ ...base, role: 'escalate', files: ['a.js'] }).missing, ['escalates']);
  assert.equal(validateBrief({ ...base, role: 'implement', files: ['a.js'] }).ok, true);
});

test('未知角色被拒绝', () => assert.equal(validateBrief({ ...base, role: 'boss' }).ok, false));

test('首条消息声明看不到主对话，并包含全部字段', () => {
  const text = renderBrief(validateBrief(base).brief, { id: 'h1' });
  assert.match(text, /看不到主对话/);
  for (const v of [base.goal, base.context, base.constraints, base.done_when]) assert.ok(text.includes(v));
  assert.match(text, /不得修改文件/);
  const impl = renderBrief(validateBrief({ ...base, role: 'implement', files: ['src/a.js'] }).brief, { id: 'h2' });
  assert.match(impl, /只能修改以下文件/);
  assert.ok(impl.includes('src/a.js'));
});

test('review schema 要求 verdict 与 findings.level，且都在内核子集内', () => {
  const s = receiptSchema('review');
  assert.ok(s.required.includes('verdict'));
  assert.deepEqual(s.properties.verdict.enum, ['pass', 'fail']);
  assert.deepEqual(s.properties.findings.items.properties.level.enum, ['blocker', 'major', 'minor']);
  assert.equal(receiptSchema('explore').properties.verdict, undefined);
  for (const role of ['explore', 'implement', 'review', 'escalate']) assertObjectJsonSchema(receiptSchema(role));
});

test('只读角色报告改动、implement 越界都算违规', () => {
  const receipt = { files_changed: ['src/b.js'] };
  assert.equal(checkViolation('explore', validateBrief(base).brief, receipt, 'D:/r').length, 1);
  const impl = validateBrief({ ...base, role: 'implement', files: ['src/a.js'] }).brief;
  assert.equal(checkViolation('implement', impl, receipt, 'D:/r').length, 1);
  assert.equal(checkViolation('implement', impl, { files_changed: ['SRC\\A.js'] }, 'D:/r').length, process.platform === 'win32' ? 0 : 1);
  assert.equal(checkViolation('explore', validateBrief(base).brief, { files_changed: [] }, 'D:/r').length, 0);
});
