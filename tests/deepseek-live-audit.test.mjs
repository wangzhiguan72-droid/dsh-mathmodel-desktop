import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installDeepSeekAudit } from '../scripts/deepseek-live-audit.mjs';

test('per-turn budget blocks before send and resets only for a new owned turn key', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-audit-turn-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = globalThis.fetch; let sent = 0;
  globalThis.fetch = async () => { sent++; return new Response('data: {"type":"message_stop"}\n\n'); };
  const turnBudgetFile = path.join(dir, 'turn.json'), filename = path.join(dir, 'audit.jsonl');
  await fs.writeFile(turnBudgetFile, JSON.stringify({ key: 'a', maximumRequests: 1 }));
  const dispose = installDeepSeekAudit({ filename, turnBudgetFile });
  t.after(() => { dispose(); globalThis.fetch = original; });
  const request = () => globalThis.fetch('https://api.deepseek.com/messages', { body: '{"max_tokens":10}' });
  await (await request()).text();
  await assert.rejects(request(), /per-turn request budget/); assert.equal(sent, 1);
  await fs.writeFile(turnBudgetFile, JSON.stringify({ key: 'b', maximumRequests: 1 }));
  await (await request()).text(); assert.equal(sent, 2);
  const records = (await fs.readFile(filename, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(row => row.blockedBeforeSend).length, 1);
});

test('provider audit records actual model and usage without authentication or prompt text', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    { type: 'message_start', message: { model: 'actual-flash', usage: { input_tokens: 23, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 });
  const filename = path.join(dir, 'audit.jsonl');
  const dispose = installDeepSeekAudit({ filename, maxRequests: 1 });
  t.after(() => { dispose(); globalThis.fetch = original; });
  const response = await globalThis.fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST', headers: { 'x-api-key': 'SECRET-KEY' }, body: JSON.stringify({ model: 'alias', max_tokens: 10, system: 'PRIVATE-PROMPT', tools: [{ name: 'read' }], messages: [] }) });
  await response.text();
  let output;
  for (let i = 0; i < 100; i++) { try { output = await fs.readFile(filename, 'utf8'); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  assert.ok(output); assert.ok(!output.includes('SECRET-KEY')); assert.ok(!output.includes('PRIVATE-PROMPT'));
  const record = JSON.parse(output);
  assert.equal(record.responseModel, 'actual-flash'); assert.equal(record.rawUsage.output_tokens, 7);
  assert.equal(record.rawUsage.cache_read_input_tokens, 100);
  assert.equal(record.usageComplete, true); assert.equal(record.terminalStopObserved, true);
  assert.deepEqual(record.toolNames, ['read']);
  await assert.rejects(globalThis.fetch('https://api.deepseek.com/messages', { body: '{"max_tokens":10}' }), /budget reached/);
});

test('excessive output budget is rejected before a provider request', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-audit-budget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = globalThis.fetch; let sent = false;
  globalThis.fetch = async () => { sent = true; throw new Error('must not send'); };
  const dispose = installDeepSeekAudit({ filename: path.join(dir, 'audit.jsonl'), maxOutputTokens: 10 });
  t.after(() => { dispose(); globalThis.fetch = original; });
  await assert.rejects(globalThis.fetch('https://api.deepseek.com/messages', { body: '{"max_tokens":11}' }), /budget reached/);
  await assert.rejects(globalThis.fetch('https://api.deepseek.com/messages', { body: '{}' }), /budget reached/);
  assert.equal(sent, false);
});

test('four counters without message_stop remain incomplete', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-audit-truncated-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ type: 'message_start', message: {
    model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
  } }) + '\n\n');
  const filename = path.join(dir, 'audit.jsonl'), dispose = installDeepSeekAudit({ filename });
  t.after(() => { dispose(); globalThis.fetch = original; });
  await (await globalThis.fetch('https://api.deepseek.com/messages', { body: '{"max_tokens":10}' })).text();
  const record = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(record.usageComplete, false); assert.equal(record.auditIncomplete, true);
  assert.equal(JSON.parse(await fs.readFile(filename + '.state.json', 'utf8')).inFlight, 0);
});

test('audit remains in flight until delayed terminal events are observed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-audit-delayed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const encoder = new TextEncoder(), original = globalThis.fetch;
  const encode = value => encoder.encode('data: ' + JSON.stringify(value) + '\n\n');
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encode({ type: 'message_start', message: { model: 'deepseek-flash', usage: { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } }));
    setTimeout(() => {
      controller.enqueue(encode({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }));
      controller.enqueue(encode({ type: 'message_stop' })); controller.close();
    }, 150);
  } }));
  const filename = path.join(dir, 'audit.jsonl'), dispose = installDeepSeekAudit({ filename });
  t.after(() => { dispose(); globalThis.fetch = original; });
  const response = await globalThis.fetch('https://api.deepseek.com/messages', { body: '{"max_tokens":10}' });
  assert.equal(JSON.parse(await fs.readFile(filename + '.state.json', 'utf8')).inFlight, 1);
  assert.equal(await fs.readFile(filename, 'utf8'), '');
  await response.text();
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).usageComplete, true);
  assert.equal(JSON.parse(await fs.readFile(filename + '.state.json', 'utf8')).inFlight, 0);
});
