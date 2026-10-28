// Bounded synthetic verification against the authenticated, installed desktop Host.
// It never reads model credentials or project files beyond its own fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInstalledHostClient } from './installed-host-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'dist/fusion-installed-verification/workspace');
const evidencePath = path.join(root, 'dist/fusion-installed-verification/installed-feature-paths.json');
const workspaceId = '64290ba2-c584-4113-be07-551e5df943b2';
const teamBundle = '@deepseek-ai/dsh-experimental-agent-team-profile';
const autoBundle = '@deepseek-ai/dsh-experimental-auto-review';
const client = await createInstalledHostClient();
const evidence = { capturedAt: new Date().toISOString(), installedHost: true, model: 'deepseek-official/deepseek-flash', fixture, tests: {} };
const originalModel = (await client.rpc('session', 'modelCatalog', {})).default;
let lastSessionId;

async function bundles() {
  return await client.rpc('pluginManager', 'listBundles', {});
}
async function setBundle(name, enabled) {
  await client.rpc('pluginManager', 'setBundleEnabled', { name, enabled });
  const actual = (await bundles()).find(bundle => bundle.name === name);
  if (actual?.enabled !== enabled) throw new Error(`Bundle state mismatch: ${name}`);
}
async function newSession() {
  const created = await client.rpc('session', 'create', { request: { workspaceId, agentPreset: 'standard' } });
  const sessionId = created.sessionId;
  lastSessionId = sessionId;
  await client.rpc('session', 'selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' } });
  return sessionId;
}
async function command(sessionId, line) {
  return await client.rpc('commands', 'execute', { agentId: sessionId, line, submittedAttachments: [] });
}
async function prompt(sessionId, text) {
  await client.rpc('session', 'prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' } });
}
async function events(sessionId) {
  const list = await client.rpc('session', 'list', { _request: {} });
  const item = list.find?.(entry => entry.sessionId === sessionId) ?? list.items?.find(entry => entry.sessionId === sessionId);
  const seq = item?.projections?.asOfSeq;
  if (typeof seq !== 'number') throw new Error(`No projection cursor for ${sessionId}`);
  const page = await client.rpc('session', 'page', { request: { address: { kind: 'session', sessionId }, throughSeq: seq, maxMessages: 400 } });
  return page.records.map(record => record.event).filter(Boolean);
}
async function waitTurn(sessionId, after = 0, timeoutMs = 180000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const all = await events(sessionId);
    const done = all.findLast(event => event.seq > after && event.type === 'turn/end');
    if (done) return all;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${sessionId}`);
}
function slim(all) {
  return all.filter(event => /^(turn\/|tool\/|team\/|subagent\/|approval\/|auto-review\/|permission\/|hook\/)/.test(event.type))
    .map(event => ({ seq: event.seq, type: event.type, name: event.type === 'tool/call' ? event.data?.name : undefined,
      reason: event.type === 'turn/end' ? event.data?.reason : undefined,
      taskStatus: event.type === 'team/task' ? event.data?.task?.status : undefined,
      memberPhase: event.type === 'team/member' ? event.data?.member?.phase : undefined,
      preset: event.type === 'permission/preset' ? event.data?.preset : undefined,
      policy: event.type === 'approval/policy' ? event.data?.policy : undefined,
      hookDecision: event.type === 'hook/result' ? event.data?.decision : undefined,
      hookExitCode: event.type === 'hook/result' ? event.data?.exitCode : undefined }));
}
async function save() {
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

const original = Object.fromEntries((await bundles()).filter(bundle => [teamBundle, autoBundle].includes(bundle.name)).map(bundle => [bundle.name, bundle.enabled]));
evidence.originalBundles = original;
evidence.originalDefaultModel = originalModel;
await save();
try {
  await setBundle(teamBundle, true);
  const sessionId = await newSession();
  evidence.tests.agentTeams = { sessionId, status: 'running' };
  await save();
  await prompt(sessionId, 'Synthetic Agent Teams verification. Use the Agent Teams tools: create exactly one shared task to inspect a trivial arithmetic statement, spawn exactly one teammate named check_math to answer whether 2+2=4, send that teammate one brief message, wait for its result, mark the task completed, then summarize. No file access, shell, web, credentials, or other delegation.');
  const teamEvents = await waitTurn(sessionId);
  evidence.tests.agentTeams = { sessionId, status: 'observed', events: slim(teamEvents), toolNames: teamEvents.filter(e => e.type === 'tool/call').map(e => e.data?.name) };
  await save();
  await setBundle(teamBundle, original[teamBundle]);

  await setBundle(autoBundle, true);
  const autoSession = await newSession();
  const autoFile = path.join(fixture, `auto-review-probe-${randomUUID().slice(0, 8)}.txt`);
  evidence.tests.autoReview = { sessionId: autoSession, status: 'running' };
  await save();
  await command(autoSession, '/permission auto');
  await prompt(autoSession, `Synthetic Auto review verification, explicitly authorized to write one new fixture file at ${autoFile}. Use the dedicated write tool exactly once to put AUTO_REVIEW_ALLOWED in that file; do not use shell or access any other files.`);
  const autoEvents = await waitTurn(autoSession);
  let file;
  try { file = (await fs.readFile(autoFile, 'utf8')).trim(); } catch { file = null; }
  evidence.tests.autoReview = { sessionId: autoSession, status: 'observed', filePath: autoFile, fileContent: file, events: slim(autoEvents), toolNames: autoEvents.filter(e => e.type === 'tool/call').map(e => e.data?.name) };
  await save();
} catch (error) {
  evidence.error = String(error.message || error);
  await save();
  process.exitCode = 1;
} finally {
  for (const [name, enabled] of Object.entries(original)) {
    try { await setBundle(name, enabled); } catch (error) { evidence.restoreError = String(error.message || error); process.exitCode = 1; }
  }
  if (lastSessionId && originalModel?.provider && originalModel?.model) {
    try {
      await client.rpc('session', 'selectModel', { request: { sessionId: lastSessionId, ...originalModel } });
      for (let attempt = 0; attempt < 10; attempt++) {
        evidence.defaultModelRestored = (await client.rpc('session', 'modelCatalog', {})).default;
        if (JSON.stringify(evidence.defaultModelRestored) === JSON.stringify(originalModel)) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (JSON.stringify(evidence.defaultModelRestored) !== JSON.stringify(originalModel)) throw new Error('Original default model did not persist');
    } catch (error) { evidence.modelRestoreError = String(error.message || error); process.exitCode = 1; }
  }
  evidence.finalBundles = Object.fromEntries((await bundles()).filter(bundle => [teamBundle, autoBundle].includes(bundle.name)).map(bundle => [bundle.name, bundle.enabled]));
  await save();
}
console.log(JSON.stringify({ tests: Object.fromEntries(Object.entries(evidence.tests).map(([name, test]) => [name, { status: test.status, sessionId: test.sessionId, toolNames: test.toolNames, fileContent: test.fileContent }])), error: evidence.error, finalBundles: evidence.finalBundles }, null, 2));
