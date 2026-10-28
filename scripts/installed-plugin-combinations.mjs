// Installed desktop combination regression. Invoke with --run only after UI work is idle.
// Mutations are limited to three optional web components, two experimental bundles,
// and synthetic sessions inside the verification fixture. Original states are restored.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInstalledHostClient } from './installed-host-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'dist/fusion-installed-verification/workspace');
const receipt = path.join(root, 'dist/fusion-installed-verification/plugin-combinations.json');
const webPrefix = '@linxin666/dsh-web-all';
const webModules = [
  webPrefix, `${webPrefix}/settings`, `${webPrefix}/plugin-manager`, `${webPrefix}/market`,
  `${webPrefix}/task-board`, `${webPrefix}/task-board-github`, `${webPrefix}/git-graph`,
  `${webPrefix}/remote-web-ui`, `${webPrefix}/update`, `${webPrefix}/ssh`,
  `${webPrefix}/liangshen`, `${webPrefix}/skill-explorer`, `${webPrefix}/usage`,
  `${webPrefix}/session-archive`, `${webPrefix}/model-capabilities`,
  '@linxin666/dsh-i18n', '@linxin666/dsh-client-ui-community-plugins',
  '@linxin666/dsh-pet', '@linxin666/dsh-client-ui-preset-center',
  '@linxin666/dsh-client-ui-skin-center',
];
const optionalIds = ['include:web-ui-ssh', 'include:web-ui-liangshen', 'include:web-ui-skill-explorer'];
const bundles = {
  team: { name: '@deepseek-ai/dsh-experimental-agent-team-profile', rows: ['agent-team', 'tool-agent-team', 'ui-agent-team'] },
  auto: { name: '@deepseek-ai/dsh-experimental-auto-review', rows: ['auto-review'] },
};
const stages = [
  { name: 'default-17', optional: false, team: false, auto: false },
  { name: 'all-20', optional: true, team: false, auto: false },
  { name: 'all-20-team', optional: true, team: true, auto: false },
  { name: 'all-20-auto', optional: true, team: false, auto: true },
  { name: 'all-20-team-auto', optional: true, team: true, auto: true },
];

if (process.argv[2] !== '--run') {
  console.log(JSON.stringify({ mode: 'plan-only', stages: stages.map(stage => stage.name),
    mutations: { pluginIds: optionalIds, bundles: Object.values(bundles).map(bundle => bundle.name), modelDefault: 'restored after synthetic test' },
    run: 'node scripts/installed-plugin-combinations.mjs --run' }, null, 2));
  process.exit(0);
}

const client = await createInstalledHostClient();
const rpc = client.rpc;
const evidence = { observedAt: new Date().toISOString(), target: 'installed-desktop-host',
  stages: [], synthetic: {}, original: {}, restored: {} };
let syntheticSessionId;
async function save() {
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  await fs.writeFile(receipt, `${JSON.stringify(evidence, null, 2)}\n`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function pluginRows() {
  const result = await rpc('pluginManager', 'listPlugins', {});
  const rows = Array.isArray(result) ? result : result.plugins;
  assert(Array.isArray(rows), 'Plugin manager inventory unavailable');
  return rows;
}
async function bundleRows() {
  const rows = await rpc('pluginManager', 'listBundles', {});
  assert(Array.isArray(rows), 'Bundle inventory unavailable');
  return rows;
}
async function waitState(check, label) {
  const until = Date.now() + 45000;
  let last;
  while (Date.now() < until) {
    try { last = await check(); if (last === true) return; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not settle: ${String(last)}`);
}
async function setPlugin(id, enabled) {
  const before = (await pluginRows()).find(row => row.entryId === id);
  assert(before, `Missing plugin ${id}`);
  if (before.enabled !== enabled) await rpc('pluginManager', 'setPluginEnabled', { id, enabled });
  await waitState(async () => {
    const row = (await pluginRows()).find(item => item.entryId === id);
    return row?.enabled === enabled && (enabled ? row.fiberPhase === 'active' : row.fiberPhase !== 'active');
  }, id);
}
async function setBundle(bundle, enabled) {
  const before = (await bundleRows()).find(row => row.name === bundle.name);
  assert(before, `Missing bundle ${bundle.name}`);
  if (before.enabled !== enabled) await rpc('pluginManager', 'setBundleEnabled', { name: bundle.name, enabled });
  await waitState(async () => {
    const installed = (await bundleRows()).find(row => row.name === bundle.name);
    const plugins = await pluginRows();
    return installed?.enabled === enabled && bundle.rows.every(id => {
      const row = plugins.find(item => item.entryId === `include:${id}`);
      return enabled ? row?.enabled === true && row.fiberPhase === 'active'
        : !row || row.enabled === false && row.fiberPhase !== 'active';
    });
  }, bundle.name);
}
async function getStatus(pathname) {
  const response = await client.request(pathname);
  return response.status;
}
async function stageSnapshot(stage) {
  const plugins = await pluginRows();
  const family = webModules.map(moduleName => {
    const matches = plugins.filter(row => row.moduleName === moduleName);
    assert(matches.length === 1, `Expected one family row for ${moduleName}, got ${matches.length}`);
    const row = matches[0];
    return { entryId: row.entryId, moduleName, enabled: row.enabled, fiberPhase: row.fiberPhase ?? null };
  });
  const expectedEnabled = stage.optional ? 20 : 17;
  for (const row of family) {
    const expected = stage.optional || !optionalIds.includes(row.entryId);
    assert(row.enabled === expected, `${stage.name}: ${row.entryId} enabled=${row.enabled}`);
    assert(expected ? row.fiberPhase === 'active' : row.fiberPhase !== 'active', `${stage.name}: ${row.entryId} phase=${row.fiberPhase}`);
  }
  const actualBundles = await bundleRows();
  const experimental = {};
  for (const [key, bundle] of Object.entries(bundles)) {
    const expected = stage[key];
    const item = actualBundles.find(row => row.name === bundle.name);
    assert(item?.enabled === expected, `${stage.name}: ${key} bundle state mismatch`);
    const rows = bundle.rows.map(id => plugins.find(row => row.entryId === `include:${id}`));
    assert(rows.every(row => expected ? row?.enabled === true && row.fiberPhase === 'active'
      : !row || row.enabled === false && row.fiberPhase !== 'active'),
      `${stage.name}: ${key} bundle rows mismatch`);
    experimental[key] = { enabled: item.enabled, rows: rows.map((row, index) => ({
      entryId: `include:${bundle.rows[index]}`, registered: Boolean(row), fiberPhase: row?.fiberPhase ?? null })) };
  }
  const [familyResponse, degradedResponse, shellStatus, fusionStatus] = await Promise.all([
    client.request('/api/dsh-web-all/rows'), client.request('/api/dsh-web-all/degraded'),
    getStatus('/'), getStatus('/api/model-fusion?view=settings'),
  ]);
  assert(familyResponse.status === 200 && degradedResponse.status === 200, `${stage.name}: family HTTP service unavailable`);
  const familyService = await familyResponse.json();
  const degradedService = await degradedResponse.json();
  assert(familyService.ok === true && Array.isArray(familyService.children), `${stage.name}: family service malformed`);
  assert(degradedService.ok === true && Array.isArray(degradedService.degraded), `${stage.name}: degraded service malformed`);
  assert(degradedService.degraded.length === 0, `${stage.name}: ${degradedService.degraded.length} degraded family rows`);
  assert(familyService.children.length === (stage.optional ? 14 : 11), `${stage.name}: family child count ${familyService.children.length}`);
  assert(shellStatus === 200 && fusionStatus === 200, `${stage.name}: shell/Fusion entry unavailable`);
  return { name: stage.name, enabledFamilyCount: family.filter(row => row.enabled).length,
    activeFamilyCount: family.filter(row => row.fiberPhase === 'active').length,
    family, experimental, services: { pluginManagerRpc: 'ok', familyRowsHttp: familyResponse.status,
      activeFamilyChildren: familyService.children.length, degradedHttp: degradedResponse.status,
      degradedCount: degradedService.degraded.length, shellHttp: shellStatus, fusionSettingsHttp: fusionStatus }, pass: true };
}
async function setStage(stage) {
  for (const id of optionalIds) await setPlugin(id, stage.optional);
  await setBundle(bundles.team, stage.team);
  await setBundle(bundles.auto, stage.auto);
}
async function sessionEvents(sessionId) {
  const list = await rpc('session', 'list', { _request: {} });
  const item = list.items.find(row => row.sessionId === sessionId);
  assert(item?.projections?.asOfSeq >= 0, `Missing session ${sessionId}`);
  const page = await rpc('session', 'page', { request: { address: { kind: 'session', sessionId }, throughSeq: item.projections.asOfSeq, maxMessages: 400 } });
  return page.records.map(record => record.event).filter(Boolean);
}
async function stopSyntheticTurn(sessionId) {
  const listed = await rpc('session', 'list', { _request: {} });
  const item = listed.items.find(row => row.sessionId === sessionId);
  assert(item, `Missing synthetic session ${sessionId}`);
  if (!item.running) return { cancelRequested: false, stopped: true };
  await rpc('session', 'cancel', { request: { sessionId } });
  await waitState(async () => {
    const current = await rpc('session', 'list', { _request: {} });
    return current.items.find(row => row.sessionId === sessionId)?.running === false;
  }, `synthetic session ${sessionId} cancellation`);
  return { cancelRequested: true, stopped: true };
}
async function runPrompt(sessionId, text) {
  const before = await sessionEvents(sessionId);
  const seq = before.at(-1)?.seq ?? 0;
  try {
    await rpc('session', 'prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue',
      content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' } });
    const until = Date.now() + 180000;
    while (Date.now() < until) {
      const events = await sessionEvents(sessionId);
      if (events.some(event => event.seq > seq && event.type === 'approval/asked')) throw new Error('Synthetic turn requested human approval');
      if (events.some(event => event.seq > seq && event.type === 'turn/end')) return events.filter(event => event.seq > seq);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('Synthetic turn timed out');
  } catch (error) {
    try {
      evidence.syntheticCancellation = await stopSyntheticTurn(sessionId);
    } catch (cancelError) {
      evidence.syntheticCancellation = { stopped: false, error: String(cancelError.message || cancelError) };
      throw new Error(`${error.message}; synthetic cancellation failed: ${cancelError.message}`);
    }
    throw error;
  }
}
async function syntheticProof() {
  const created = await rpc('session', 'create', { request: { cwd: fixture, agentPreset: 'standard' } });
  syntheticSessionId = created.sessionId;
  const selected = (await rpc('session', 'list', { _request: {} })).items.find(row => row.sessionId === syntheticSessionId);
  assert(typeof selected?.cwd === 'string' && path.resolve(selected.cwd).toLowerCase() === path.resolve(fixture).toLowerCase(), 'Synthetic session workspace mismatch');
  await rpc('session', 'selectModel', { request: { sessionId: syntheticSessionId,
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' } });
  await rpc('commands', 'execute', { agentId: syntheticSessionId, line: '/permission auto', submittedAttachments: [] });
  const teamEvents = await runPrompt(syntheticSessionId,
    'Synthetic installed plugin combination check. Use Agent Teams tools only: create exactly one task about whether 2+2=4, spawn exactly one teammate named check-math to answer it, send one short message, wait for the teammate answer, move the task through in_progress to completed, then summarize. No files, shell, web, credentials, or additional delegation.');
  const taskStates = teamEvents.filter(event => event.type === 'team/task').map(event => event.data.task.status);
  const child = teamEvents.find(event => event.type === 'subagent/catalog')?.data.childId;
  const delivered = teamEvents.some(event => event.type === 'team/message/delivered');
  assert(child && delivered && taskStates.includes('completed'), 'Team path did not complete');
  const childItem = (await rpc('session', 'list', { _request: {} })).items.find(row => row.sessionId === child);
  assert(childItem?.projections?.values?.subagentTiming?.lastTurnCompleted === true, 'Teammate turn did not complete');
  const file = path.join(fixture, `combination-auto-${randomUUID().slice(0, 8)}.txt`);
  await rpc('commands', 'execute', { agentId: syntheticSessionId, line: '/permission auto', submittedAttachments: [] });
  const autoEvents = await runPrompt(syntheticSessionId,
    `Synthetic fixture write, explicitly authorized for this exact new file: ${file}. Use the dedicated write tool exactly once to write COMBINATION_AUTO_ALLOWED. No shell, other files, network, credentials, or delegation.`);
  const content = (await fs.readFile(file, 'utf8')).trim();
  assert(content === 'COMBINATION_AUTO_ALLOWED', 'Auto review fixture content mismatch');
  assert(autoEvents.some(event => event.type === 'tool/call' && event.data.name === 'write'), 'Auto review write call absent');
  assert(!autoEvents.some(event => event.type === 'tool/result' && event.data.message?.isError), 'Auto review write failed');
  return { leadSessionId: syntheticSessionId, childSessionId: child, childCompleted: true,
    teamTaskStates: taskStates, teamMessageDelivered: delivered,
    autoPreset: true, autoToolCalls: autoEvents.filter(event => event.type === 'tool/call').map(event => event.data.name),
    fixtureFile: file, fixtureContent: content,
    reviewerDecisionLimit: 'Auto reviewer risk and raw decision are not persisted; Auto preset plus successful write verifies its allow path.' };
}

const startingPlugins = await pluginRows();
const startingBundles = await bundleRows();
for (const id of optionalIds) {
  const row = startingPlugins.find(item => item.entryId === id);
  assert(row && typeof row.enabled === 'boolean', `Original state missing for ${id}`);
  evidence.original[id] = row.enabled;
}
for (const bundle of Object.values(bundles)) {
  const row = startingBundles.find(item => item.name === bundle.name);
  assert(row && typeof row.enabled === 'boolean', `Original state missing for ${bundle.name}`);
  evidence.original[bundle.name] = row.enabled;
}
evidence.originalDefaultModel = (await rpc('session', 'modelCatalog', {})).default;
await save();
try {
  for (const stage of stages) {
    await setStage(stage);
    evidence.stages.push(await stageSnapshot(stage));
    await save();
  }
  evidence.synthetic = await syntheticProof();
  evidence.pass = true;
} catch (error) {
  evidence.pass = false;
  evidence.error = String(error.message || error);
  process.exitCode = 1;
} finally {
  const restorationErrors = [];
  if (syntheticSessionId) {
    try { evidence.syntheticFinalStop = await stopSyntheticTurn(syntheticSessionId); }
    catch (error) { restorationErrors.push(`synthetic session stop: ${error.message}`); }
  }
  for (const id of optionalIds) {
    try { await setPlugin(id, evidence.original[id]); } catch (error) { restorationErrors.push(`${id}: ${error.message}`); }
  }
  for (const bundle of Object.values(bundles)) {
    try { await setBundle(bundle, evidence.original[bundle.name]); } catch (error) { restorationErrors.push(`${bundle.name}: ${error.message}`); }
  }
  if (syntheticSessionId && evidence.originalDefaultModel?.provider && evidence.originalDefaultModel?.model) {
    try {
      await rpc('session', 'selectModel', { request: { sessionId: syntheticSessionId, ...evidence.originalDefaultModel } });
      await waitState(async () => JSON.stringify((await rpc('session', 'modelCatalog', {})).default) === JSON.stringify(evidence.originalDefaultModel), 'default model restoration');
    } catch (error) { restorationErrors.push(`default model: ${error.message}`); }
  }
  try {
    const finalPlugins = await pluginRows();
    for (const id of optionalIds) evidence.restored[id] = finalPlugins.find(row => row.entryId === id)?.enabled;
  } catch (error) { restorationErrors.push(`final plugin inventory: ${error.message}`); }
  try {
    const finalBundles = await bundleRows();
    for (const bundle of Object.values(bundles)) evidence.restored[bundle.name] = finalBundles.find(row => row.name === bundle.name)?.enabled;
  } catch (error) { restorationErrors.push(`final bundle inventory: ${error.message}`); }
  try { evidence.restored.defaultModel = (await rpc('session', 'modelCatalog', {})).default; }
  catch (error) { restorationErrors.push(`final default model: ${error.message}`); }
  if (restorationErrors.length) { evidence.restorationErrors = restorationErrors; evidence.pass = false; process.exitCode = 1; }
  await save();
}
console.log(JSON.stringify({ pass: evidence.pass, stages: evidence.stages.map(stage => stage.name),
  synthetic: evidence.synthetic, error: evidence.error, restorationErrors: evidence.restorationErrors,
  evidence: receipt }, null, 2));
