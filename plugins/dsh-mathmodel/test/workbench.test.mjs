import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '../../../resources/runtime/host/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { apply, gateReceiptFromReview } from '../src/workbench.js';

const TOOLS = ['mm_check_deliverables', 'mm_complete', 'mm_gate', 'mm_log', 'mm_phase_enter', 'mm_project_init', 'mm_skill_read', 'mm_state', 'mm_todo'];

// Minimal stand-in for the Host `fs` service, backed by the real disk.
const localFs = {
  resolve: async p => resolve(String(p)),
  processPath: target => target,
  stat: async target => { const s = statSync(target); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size }; },
  readText: async target => readFileSync(target, 'utf8'),
  writeText: async (target, content) => { await fsp.writeFile(target, content); },
  listDir: async target => (await fsp.readdir(target, { withFileTypes: true })).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: join(target, e.name) })),
  contains: (outer, inner) => { const r = relative(outer, inner); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); },
};

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const skillRoot = join(dir, 'skill'), project = join(dir, 'project');
  mkdirSync(skillRoot); mkdirSync(project);
  writeFileSync(join(skillRoot, 'SKILL.md'), '---\nname: math-modeling\n---\n# 数学建模\n');
  const root = new Context();
  const sections = [], skills = [];
  root.provide('systemPrompt', { tools: () => () => {}, section: s => { sections.push(s); return () => {}; } });
  new ToolRuntime(root, { mode: 'native' });
  root.provide('fs', localFs);
  root.provide('workingDirectory', { ensure: async () => project });
  root.provide('skills', { register: skill => { skills.push(skill); return () => {}; } });
  await apply(root, { skillRoot });
  const call = (name, args = {}) => root.tools.get(name).execute(args, { agent: { id: 'p1' }, signal: new AbortController().signal });
  return { root, sections, skills, skillRoot, project, call };
}

test('review 回执映射成 mm_gate 回执：verdict→状态，blocked 优先，level 换成 P 级', () => {
  const review = { status: 'done', verdict: 'fail', receipt: { findings: [{ level: 'major', claim: '量纲错', evidence: 'model.md:12' }, { level: 'blocker', claim: '漏 Q3', evidence: 'paper.md:1' }], open_questions: ['重算 Q2', '补 Q3'] } };
  assert.deepEqual(gateReceiptFromReview(review, { scope: 'M1', inputSnapshot: 'h' }), {
    scope: 'M1', inputSnapshot: 'h', status: 'FAIL', evidence: ['model.md:12', 'paper.md:1'],
    findings: [{ level: 'P1', text: '量纲错' }, { level: 'P0', text: '漏 Q3' }], rework: '重算 Q2；补 Q3',
  });
  const blocked = { status: 'blocked', verdict: 'pass', receipt: { findings: [], open_questions: [] } };
  assert.equal(gateReceiptFromReview(blocked, { scope: 'M1', inputSnapshot: 'h' }).status, 'BLOCKED');
  assert.equal(gateReceiptFromReview({ status: 'done', verdict: 'pass', receipt: { findings: [], open_questions: [] } }, { scope: 'M1', inputSnapshot: 'h' }).status, 'PASS');
  assert.equal(gateReceiptFromReview({ status: 'blocked', receipt: null }, { scope: 'M1', inputSnapshot: 'h' }).status, 'BLOCKED', '回执缺失按 BLOCKED');
});

test('在 rc.5 ToolRuntime 上注册全部 mm_* 工具与知识库 skill', async t => {
  const { root, sections, skills, skillRoot } = await setup(t);
  assert.deepEqual(root.tools.schemas().map(row => row.name).filter(name => name.startsWith('mm_')).sort(), TOOLS);
  assert.equal(skills[0].name, 'math-modeling');
  assert.match(skills[0].source, new RegExp(skillRoot.replace(/\\/g, '\\\\')));
  assert.match(sections.find(s => s.name === 'math-modeling-workbench').text, /delegate role=review/);
});

test('不传 skillRoot 时用配置的知识库，项目根取会话工作目录', async t => {
  const { call, skillRoot, project } = await setup(t);
  const r = await call('mm_project_init', { title: '测试' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.project.skillRoot, resolve(skillRoot));
  assert.equal(r.project.projectRoot, resolve(project));
  assert.ok(statSync(join(project, '.math-modeling', 'state.json')).isFile(), '元数据目录由插件自己创建');
});

test('mm_gate record 接受 delegate 的 review 结果', async t => {
  const { call } = await setup(t);
  await call('mm_project_init', { title: '测试' });
  const review = { status: 'done', verdict: 'pass', receipt: { findings: [{ level: 'minor', claim: '符号表可再补', evidence: 'terms.md:3' }], open_questions: [] } };
  const r = await call('mm_gate', { gate: 'M1', mode: 'record', review, scope: 'M1 全量', inputSnapshot: 'sha:abc' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'pass');
  const prepared = await call('mm_gate', { gate: 'P1', mode: 'prepare' });
  assert.match(prepared.recordInstruction, /delegate role=review/);
});

test('文案里不再出现旧的 subagent 工具派发说法', () => {
  const source = readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('派发独立只读 Subagent'));
  assert.ok(!source.includes('subagent 工具'));
  assert.ok(!source.includes('import.meta.url'), '知识库路径不再从插件位置推导');
});
