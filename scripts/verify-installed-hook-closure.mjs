import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInstalledHostClient } from './installed-host-client.mjs';

const client = await createInstalledHostClient();
const fixture = path.resolve('dist/fusion-installed-verification/workspace');
const probe = path.join(process.env.LOCALAPPDATA, 'Programs/dsh-mathmodel-desktop', `fusion-hook-closure-${randomUUID()}.txt`);
const sentinel = 'HOOK_CLOSURE_PROBE';
const evidence = { observedAt: new Date().toISOString(), installedDesktop: true, probe, pass: false };
const original = (await client.rpc('session', 'modelCatalog', {})).default;
const exists = async filename => {
  try { await fs.stat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
assert.equal(await exists(probe), false);
let sessionId;
try {
  sessionId = (await client.rpc('session', 'create', { request: { cwd: fixture, agentPreset: 'standard' } })).sessionId;
  evidence.sessionId = sessionId;
  const item = (await client.rpc('session', 'list', { _request: {} })).items.find(row => row.sessionId === sessionId);
  assert.equal(path.resolve(item.cwd).toLowerCase(), fixture.toLowerCase());
  await client.rpc('session', 'selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' } });
  await client.rpc('commands', 'execute', { agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [] });
  await client.rpc('session', 'prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue',
    content: [{ type: 'text', text: `Bounded negative PreToolUse test on the newly installed desktop. Invoke the dedicated write tool exactly once with file_path ${probe} and content ${sentinel}. This exact new probe is authorized for this test; its guard should reject it. Do not use shell, inspect other files, retry, or work around the guard. Report the actual tool result.` }], clientTimeZone: 'Asia/Shanghai' } });
  let events = [];
  const until = Date.now() + 150000;
  while (Date.now() < until) {
    const projection = await client.rpc('session', 'projections', { request: { sessionId } });
    const page = await client.rpc('session', 'page', { request: { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 200 } });
    events = page.records.map(row => row.event).filter(Boolean);
    if (events.some(row => row.type === 'turn/end')) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  evidence.events = events.filter(row => /^(turn\/|tool\/|hook\/)/.test(row.type)).map(row => ({
    seq: row.seq, type: row.type, name: row.type === 'tool/call' ? row.data.name : undefined,
    decision: row.type === 'hook/result' ? row.data.decision : undefined,
    exitCode: row.type === 'hook/result' ? row.data.exitCode : undefined }));
  assert.ok(events.some(row => row.type === 'turn/end'), 'Hook turn did not finish');
  assert.equal(events.filter(row => row.type === 'tool/call' && row.data.name === 'write').length, 1);
  assert.ok(events.some(row => row.type === 'hook/result' && row.data.exitCode === 2 && row.data.decision === 'block'), 'Hook did not block with exit 2');
  evidence.probeAbsent = !(await exists(probe));
  assert.equal(evidence.probeAbsent, true);
  evidence.pass = true;
} catch (error) {
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  if (sessionId) {
    const current = (await client.rpc('session', 'list', { _request: {} })).items.find(row => row.sessionId === sessionId);
    if (current?.running) await client.rpc('session', 'cancel', { request: { sessionId } });
    await client.rpc('session', 'selectModel', { request: { sessionId, ...original } });
    for (let attempt = 0; attempt < 20; attempt++) {
      evidence.restoredDefault = (await client.rpc('session', 'modelCatalog', {})).default;
      if (JSON.stringify(evidence.restoredDefault) === JSON.stringify(original)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (JSON.stringify(evidence.restoredDefault) !== JSON.stringify(original)) { evidence.pass = false; process.exitCode = 1; }
  }
  if (await exists(probe)) {
    if ((await fs.readFile(probe, 'utf8')).trim() === sentinel) {
      await fs.unlink(probe);
      evidence.unexpectedWriteCleaned = true;
    } else evidence.unexpectedFilePreserved = true;
    evidence.pass = false;
    process.exitCode = 1;
  }
  await fs.writeFile(path.resolve('dist/fusion-installed-verification/closure-hook-path.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence));
