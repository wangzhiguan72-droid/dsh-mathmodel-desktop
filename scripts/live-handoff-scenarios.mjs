// Live handoff scenarios on an isolated Host: temp home, only the Magpie key, real models.
// Usage: node scripts/live-handoff-scenarios.mjs [find-bug|scaffold-fill|workbench-m1 ...]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installTaskCapabilityPresets } from './task-capabilities.mjs';
import { installWorkbenchPreset } from './workbench-preset.mjs';
import { createInstalledHostClient } from './installed-host-client.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { applyProfileSeed, ensureFrameworkCohort, ensureProfileFallbacks, findHostPort, childEnv, waitForGui } = require('../src/runtime.cjs');
const runtime = path.join(repo, 'resources/runtime'), host = path.join(runtime, 'host'), runtimeRoot = path.join(host, 'node_modules');
const YAML = createRequire(path.join(runtimeRoot, '__live_handoff__.cjs'))('yaml');
// --all-flash: every route on Flash. Checks the handoff mechanics only, not Astra's review quality.
const ALL_FLASH = process.argv.includes('--all-flash');
const FLASH = { provider: 'magpie', model: 'workbuddy-ai/deepseek-v4.1-flash' };
const LEAD = ALL_FLASH ? FLASH : { provider: 'wanzhao-astra', model: 'gpt-6-astra' };
// Flash is the only Magpie route needed; Astra comes from its own provider.
const ROUTES = new Set(['workbuddy-ai/deepseek-v4.1-flash']);
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const named = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const wanted = named.length ? named : ['find-bug', 'scaffold-fill', 'workbench-m1'];

const SCENARIOS = {
  'find-bug': {
    preset: 'task',
    files: {
      'package.json': '{ "type": "module" }\n',
      'src/price.js': "// Applies a percentage discount and rounds to cents.\nexport function discounted(price, percent) {\n  const factor = 1 - percent / 10;\n  return Math.round(price * factor * 100) / 100;\n}\n",
      'src/cart.js': "import { discounted } from './price.js';\nexport function total(items, percent = 0) {\n  return items.reduce((sum, item) => sum + discounted(item.price * item.qty, percent), 0);\n}\n",
      'test/cart.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\ntest('10% off', () => assert.equal(total([{ price: 20, qty: 2 }], 10), 36));\ntest('no discount', () => assert.equal(total([{ price: 5, qty: 3 }]), 15));\n",
    },
    prompt: [
      '`node --test` 在这个仓库里失败了。请这样做：',
      '1. 先用 delegate 派一个 role=explore 的子代理去查失败原因（交接单写清楚它看不到我们的对话），你自己先别读源码。',
      '2. 根据回执自己修好 bug，只改必要的那一行。',
      '3. 再用 delegate 派一个 role=review 的子代理独立验收修复。',
      '4. 自己跑一次 `node --test` 确认通过，然后用一两句话告诉我结果。',
    ].join('\n'),
    check(ws, ledger) {
      const roles = ledger.filter(row => row.kind === 'start').map(row => row.role);
      assert.ok(roles.includes('explore'), 'no explore handoff');
      assert.ok(roles.includes('review'), 'no review handoff');
      assert.match(fs.readFileSync(path.join(ws, 'src/price.js'), 'utf8'), /percent \/ 100/);
      assert.equal(fs.readFileSync(path.join(ws, 'src/cart.js'), 'utf8'), SCENARIOS['find-bug'].files['src/cart.js'], 'cart.js must stay untouched');
      assert.equal(runTests(ws), 0, 'tests still fail');
    },
  },
  'scaffold-fill': {
    preset: 'task',
    files: {
      'package.json': '{ "type": "module" }\n',
      'src/slug.js': "// slugify('Hello, World!') === 'hello-world'\nexport function slugify(text) {\n  throw new Error('TODO');\n}\n",
      'src/chunk.js': "// chunk([1,2,3,4,5], 2) => [[1,2],[3,4],[5]]; size must be a positive integer\nexport function chunk(items, size) {\n  throw new Error('TODO');\n}\n",
      'test/slug.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.js';\ntest('slug', () => { assert.equal(slugify('Hello, World!'), 'hello-world'); assert.equal(slugify('  A  b--C '), 'a-b-c'); });\n",
      'test/chunk.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { chunk } from '../src/chunk.js';\ntest('chunk', () => { assert.deepEqual(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]); assert.deepEqual(chunk([], 3), []); assert.throws(() => chunk([1], 0)); });\n",
    },
    prompt: [
      '`src/slug.js` 和 `src/chunk.js` 都还是空壳，测试在 `test/` 里。请这样做：',
      '1. 在同一条消息里发两个 delegate（role=implement），一个只负责 src/slug.js，另一个只负责 src/chunk.js，让它们并行。files 只写各自那一个文件。',
      '2. 两个都回来后，派一个 role=review 的子代理验收两个实现。',
      '3. 自己跑 `node --test`，用一两句话告诉我结果。',
    ].join('\n'),
    check(ws, ledger) {
      const starts = ledger.filter(row => row.kind === 'start' && row.role === 'implement');
      assert.equal(starts.length, 2, 'expected two implement handoffs');
      const endOf = id => ledger.find(row => row.kind === 'end' && row.id === id);
      const [a, b] = starts;
      assert.ok(Date.parse(b.at) < Date.parse(endOf(a.id).at) && Date.parse(a.at) < Date.parse(endOf(b.id).at), 'implement handoffs did not overlap');
      assert.ok(ledger.some(row => row.kind === 'start' && row.role === 'review'), 'no review handoff');
      assert.equal(runTests(ws), 0, 'tests still fail');
    },
  },
  'workbench-m1': {
    preset: 'math-workbench',
    files: {
      '题目.md': '# 练习题：校园共享单车调度\n某校园有 3 个停车点 A、B、C，早高峰各点需求分别为 40、25、35 辆，现有车辆分别为 50、10、40 辆。点间调度成本（元/辆）：A→B 2，A→C 3，C→B 1。求满足需求且总调度成本最低的方案。\n',
    },
    prompt: [
      '这是一道很小的练习题（见 题目.md），只做建模手阶段并走完 M1 门禁：',
      '1. mm_project_init 初始化项目（title 写“共享单车调度练习”），然后 mm_phase_enter phase=modeling。',
      '2. 写出建模手要求的两个交付物 题目分析报告.md 和 术语表格.md（简短即可，但要有模型与求解思路）。',
      '3. mm_gate gate=M1 mode=prepare，再按返回的说明用 delegate role=review 派发独立验收，最后 mm_gate gate=M1 mode=record 把 delegate 的返回值填进 review。',
      '不要进入编程手。最后告诉我 M1 的结论。',
    ].join('\n'),
    check(ws, ledger) {
      assert.ok(ledger.some(row => row.kind === 'start' && row.role === 'review'), 'no review handoff');
      const state = JSON.parse(fs.readFileSync(path.join(ws, '.math-modeling/state.json'), 'utf8'));
      const gate = state.phases.modeling.gateM1;
      assert.ok(gate && ['pass', 'fail', 'blocked'].includes(gate.status), 'M1 was not recorded');
      for (const name of ['题目分析报告.md', '术语表格.md']) assert.ok(fs.existsSync(path.join(ws, name)), `${name} missing`);
      return { m1: gate.status, findings: gate.receipt.findings.length };
    },
  },
};

function runTests(ws) {
  return spawnSync(process.execPath, ['--test'], { cwd: ws, windowsHide: true, encoding: 'utf8' }).status;
}
async function eventsOf(client, sessionId) {
  const projection = await client.rpc('session', 'projections', { request: { sessionId } });
  const page = await client.rpc('session', 'page', { request: { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 500 } });
  return page.records.map(row => row.event).filter(Boolean);
}
// Children are read through their parent's address; the Host refuses a bare child id.
async function childEventsOf(client, parentSessionId, childSessionId) {
  // page requires throughSeq; take the child's own cut when projections accepts its id, else read to the end.
  const throughSeq = await client.rpc('session', 'projections', { request: { sessionId: childSessionId } }).then(p => p.asOfSeq, () => Number.MAX_SAFE_INTEGER);
  const page = await client.rpc('session', 'page', { request: { address: { kind: 'subagent', parentSessionId, childSessionId, mode: 'unknown' }, throughSeq, maxMessages: 500 } });
  return page.records.map(row => row.event).filter(Boolean);
}
// The model each child actually called, from its own request headers.
const modelsOf = events => [...new Set(events.filter(event => event.type === 'request/header' || event.type === 'assistant/message')
  .map(event => event.data?.config ?? event.data).filter(data => data?.model).map(data => `${data.provider}/${data.model}`))];
const ledgerOf = ws => {
  const file = path.join(ws, '.dsh-handoff/ledger.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-handoff-'));
const home = path.join(root, 'home'), profile = path.join(home, 'profiles', 'mathmodel'), logFile = path.join(root, 'host.log');
const output = path.join(repo, 'dist', `live-handoff-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(output, { recursive: true });
for (const name of ['os-home', 'local', 'roaming', 'tmp', 'workspaces']) fs.mkdirSync(path.join(root, name));
console.log(`fixture: ${root}`);
applyProfileSeed(path.join(runtime, 'profile-web'), profile, 'seed', 'live-handoff', { appVersion: '0.2.0' });
const patch = path.join(profile, 'cordis.patch.yml');
installTaskCapabilityPresets({ runtimeRoot, profilePatch: patch, apply: true });
installWorkbenchPreset({ runtimeRoot, profilePatch: patch, apply: true });
if (ALL_FLASH) {
  const roles = JSON.stringify(Object.fromEntries(['explore', 'implement', 'review', 'escalate'].map(role => [role, FLASH])));
  fs.writeFileSync(patch, fs.readFileSync(patch, 'utf8').replace(/^( *)(name: "@deepseek-harness\/dsh-mathmodel\/handoff")/gm, (line, indent) => `${line}\n${indent}config: { roles: ${roles} }`));
}
ensureFrameworkCohort(home, host, 'mathmodel', 'live-handoff');
ensureProfileFallbacks(home, host, 'mathmodel');
// A real copy (not a link) of the knowledge base, so nothing here can reach the user's files.
fs.cpSync(path.join(os.homedir(), '.dsh-mathmodel/skills/math-modeling'), path.join(home, 'skills/math-modeling'), { recursive: true, dereference: true });
// Only the Magpie and Astra routes and their keys enter this store.
const userPatch = YAML.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-mathmodel/profiles/mathmodel/cordis.patch.yml'), 'utf8'));
const providers = userPatch.find(row => row.id === 'llm-pi-ai')?.config?.providers;
const magpie = providers?.magpie, astra = providers?.['wanzhao-astra'];
assert.ok(magpie?.baseURL?.startsWith('http://127.0.0.1:'), 'Magpie provider not found in the user profile');
assert.ok(astra?.models?.some(model => model.id === 'gpt-6-astra'), 'wanzhao-astra provider not found in the user profile');
const credentials = YAML.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-mathmodel/.credentials.yaml'), 'utf8'));
const keys = Object.fromEntries([magpie.apiKeyEnv, astra.apiKeyEnv].map(name => [name, credentials.refs?.[name]]));
for (const [name, value] of Object.entries(keys)) assert.ok(value, `${name} reference missing`);
fs.writeFileSync(path.join(home, '.credentials.yaml'), YAML.stringify({ version: 1, refs: keys }), { mode: 0o600 });
// Unattended: file sandbox stays on, any escalation is refused instead of waiting for a click.
fs.appendFileSync(patch, `\n${YAML.stringify([
  { id: 'llm-pi-ai', config: { providers: { magpie: { ...magpie, models: magpie.models.filter(model => ROUTES.has(model.id)).map(model => ({ ...model,
    // The seed llm-pi-ai schema knows only these effort names.
    ...(model.reasoningEfforts ? { reasoningEfforts: Object.fromEntries(Object.entries(model.reasoningEfforts).filter(([key]) => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(key))) } : {}) })) },
    'wanzhao-astra': astra } } },
  { id: 'approval', config: { policy: 'never' } },
  { id: 'permission', config: { defaultPreset: 'unattended', presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' }, 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'sandbox-auto': { sandbox: 'workspace-write', approval: 'ask', name: 'Sandbox Auto' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    unattended: { sandbox: 'workspace-write', approval: 'never' } } } },
  { id: 'session-title-llm', disabled: true },
])}`);

const port = await findHostPort(), nodeHome = path.join(runtime, 'node-win-x64');
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
  TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), USERPROFILE: path.join(root, 'os-home'), HOME: path.join(root, 'os-home'),
  DSH_AGENTS_HOME: path.join(root, 'os-home', '.agents'), APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
  NO_PROXY: '127.0.0.1,localhost' };
const child = spawn(path.join(nodeHome, 'node.exe'), [path.join(runtimeRoot, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'mathmodel', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: path.join(root, 'workspaces'), env: childEnv(home, nodeHome, process.platform, env, [runtimeRoot, path.join(home, 'profiles', 'node_modules')]), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => fs.appendFileSync(logFile, data));
const exited = new Promise(resolve => child.once('exit', resolve));
const results = [];
const save = () => fs.writeFileSync(path.join(output, 'receipt.json'), `${JSON.stringify({ root, lead: LEAD, allFlash: ALL_FLASH, results }, null, 2)}\n`);
try {
  await waitForGui(port, { deadlineMs: 240000, isAlive: () => child.exitCode === null,
    getTokenUrl: () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/m)?.[1] : undefined });
  const client = await createInstalledHostClient({ logFile });
  for (const name of wanted) {
    const scenario = SCENARIOS[name];
    assert.ok(scenario, `unknown scenario ${name}`);
    const ws = path.join(root, 'workspaces', name);
    for (const [file, text] of Object.entries(scenario.files)) { fs.mkdirSync(path.dirname(path.join(ws, file)), { recursive: true }); fs.writeFileSync(path.join(ws, file), text); }
    const { workspace } = await client.rpc('workspace', 'create', { request: { path: ws } });
    const { sessionId } = await client.rpc('session', 'create', { request: { workspaceId: workspace.workspaceId, agentPreset: scenario.preset } });
    await client.rpc('session', 'selectModel', { request: { sessionId, ...LEAD } });
    if (scenario.preset === 'task') {
      const preview = await client.rpc('mathmodelHostCapabilities', 'describe', { sessionId });
      await client.rpc('mathmodelHostCapabilities', 'confirm', { sessionId, preset: 'task', hostHash: preview.hostHash });
    }
    const start = Date.now();
    const row = { name, sessionId, workspace: ws, startedAt: new Date(start).toISOString() };
    results.push(row); save();
    await client.rpc('session', 'prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: scenario.prompt }], clientTimeZone: 'Asia/Shanghai' } });
    let events, ended;
    while (Date.now() - start < TURN_TIMEOUT_MS) {
      events = await eventsOf(client, sessionId);
      ended = events.findLast(event => event.type === 'turn/end');
      if (ended) break;
      if (child.exitCode !== null) throw new Error('Host exited during scenario');
      await sleep(3000);
    }
    if (!ended) { await client.rpc('session', 'cancel', { request: { sessionId } }); row.error = 'timeout'; }
    const ledger = ledgerOf(ws);
    Object.assign(row, {
      elapsedMs: Date.now() - start, turnEnd: ended?.data?.reason ?? null,
      toolCalls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      approvals: events.filter(event => event.type === 'approval/asked').map(event => event.data),
      finalText: (events.filter(event => event.type === 'assistant/message').at(-1)?.data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'),
      handoffs: ledger.filter(entry => entry.kind === 'end').map(entry => ({ id: entry.id, role: ledger.find(s => s.kind === 'start' && s.id === entry.id)?.role,
        status: entry.status, verdict: entry.verdict, files: entry.files_changed, violations: entry.violations, error: entry.error })),
    });
    for (const handoff of row.handoffs) {
      const childEvents = await childEventsOf(client, sessionId, handoff.id).catch(error => ({ error: error.message }));
      handoff.models = Array.isArray(childEvents) ? modelsOf(childEvents) : childEvents;
      if (Array.isArray(childEvents)) handoff.eventTypes = [...new Set(childEvents.map(event => event.type))];
    }
    try { row.checks = scenario.check(ws, ledger) ?? true; row.passed = !row.error; }
    catch (error) { row.passed = false; row.failure = error.message; }
    save();
    console.log(`${name}: ${row.passed ? 'PASS' : 'FAIL'} in ${Math.round(row.elapsedMs / 1000)}s; handoffs=${row.handoffs.map(h => `${h.role}:${h.status}${h.verdict ? '/' + h.verdict : ''}${h.violations?.length ? '!' : ''}`).join(',')}${row.failure ? `; ${row.failure}` : ''}`);
  }
} finally {
  save();
  child.kill();
  await Promise.race([exited, sleep(10000)]);
  console.log(`receipt: ${path.join(output, 'receipt.json')}`);
}
if (results.some(row => !row.passed)) process.exitCode = 1;
