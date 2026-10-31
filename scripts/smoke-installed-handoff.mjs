// One real delegate round-trip on the installed desktop Host (the user's own profile).
// Usage: node scripts/smoke-installed-handoff.mjs <empty workspace dir> [explore|review]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInstalledHostClient } from './installed-host-client.mjs';

const ws = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2] && !fs.existsSync(ws), 'pass a new, empty workspace path');
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, 'price.js'), 'export const toYuan = cents => cents / 10;\n');
const LEAD = { provider: 'magpie', model: 'workbuddy-ai/deepseek-v4.1-flash' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const client = await createInstalledHostClient();
const { presets } = await client.rpc('agentPresets', 'list');
for (const id of ['task', 'math-workbench']) assert.ok(presets.some(row => row.id === id && !row.broken), `preset ${id} missing or broken`);
const { workspace } = await client.rpc('workspace', 'create', { request: { path: ws } });
const { sessionId } = await client.rpc('session', 'create', { request: { workspaceId: workspace.workspaceId, agentPreset: 'task' } });
await client.rpc('session', 'rename', { request: { sessionId, title: '交接冒烟测试（可删除）' } });
await client.rpc('session', 'selectModel', { request: { sessionId, ...LEAD } });
const preview = await client.rpc('mathmodelHostCapabilities', 'describe', { sessionId });
await client.rpc('mathmodelHostCapabilities', 'confirm', { sessionId, preset: 'task', hostHash: preview.hostHash });
// Optional second argument picks the role: explore runs on Flash, review on Astra.
const role = process.argv[3] ?? 'explore';
const prompt = `用 delegate 派一个 role=${role} 的交接：查 price.js 的 toYuan 换算是否正确（分转元）。不要自己读文件，只派这一次，然后用一句话告诉我回执结论。`;
await client.rpc('session', 'prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: 'Asia/Shanghai' } });

const start = Date.now();
let events = [], ended;
while (Date.now() - start < 8 * 60 * 1000) {
  const projection = await client.rpc('session', 'projections', { request: { sessionId } });
  const page = await client.rpc('session', 'page', { request: { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 500 } });
  events = page.records.map(row => row.event).filter(Boolean);
  if ((ended = events.findLast(event => event.type === 'turn/end'))) break;
  await sleep(3000);
}
if (!ended) await client.rpc('session', 'cancel', { request: { sessionId } });
const ledgerFile = path.join(ws, '.dsh-handoff/ledger.jsonl');
const ledger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const result = {
  sessionId, elapsedMs: Date.now() - start, turnEnd: ended?.data?.reason ?? 'timeout',
  toolCalls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
  approvals: events.filter(event => event.type === 'approval/asked').length,
  handoffs: ledger.filter(row => row.kind === 'end').map(row => ({ status: row.status, violations: row.violations, error: row.error })),
  finalText: (events.filter(event => event.type === 'assistant/message').at(-1)?.data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'),
};
console.log(JSON.stringify(result, null, 2));
assert.ok(result.toolCalls.includes('delegate'), 'delegate was not called');
assert.equal(result.handoffs[0]?.status, 'done', 'handoff did not finish done');
