// Offline, isolated Host integration. No model prompt, API key or installed profile is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installTaskCapabilityPresets } from './task-capabilities.mjs';
import { restoreSpecializedPresets } from './restore-specialized-presets.mjs';
import { createInstalledHostClient } from './installed-host-client.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const negativeChecks = process.argv.includes('--negative');
if (process.platform !== 'win32') throw new Error('This isolated bundled-Node check requires Windows');
const require = createRequire(import.meta.url);
const { applyProfileSeed, ensureFrameworkCohort, ensureProfileFallbacks, findHostPort, childEnv, waitForGui } = require('../src/runtime.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-capabilities-'));
const home = path.join(root, 'home'), profile = path.join(home, 'profiles', 'mathmodel');
const runtime = path.join(repo, 'resources/runtime'), host = path.join(runtime, 'host');
const runtimeRoot = path.join(host, 'node_modules');
const workspace = path.join(root, 'workspace'), logFile = path.join(root, 'host.log'), catalogFile = path.join(root, 'catalog.json');
const readyFile = path.join(root, 'host-ready');
const commandFile = path.join(root, 'control.json'), answerFile = path.join(root, 'control-answer.json');
const policyAudit = path.join(root, 'file-policy-audit.jsonl');
for (const dir of [workspace, path.join(root, 'os-home'), path.join(root, 'roaming'), path.join(root, 'local'), path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
if (negativeChecks) for (const name of ['TASK.md', 'public.test.cjs', 'solution.cjs']) fs.writeFileSync(path.join(workspace, name), 'fixture-content');
applyProfileSeed(path.join(runtime, 'profile-web'), profile, 'seed', 'capability-verification', { appVersion: '0.1.4' });
restoreSpecializedPresets({ runtimeRoot, profilePatch: path.join(profile, 'cordis.patch.yml'), apply: true });
installTaskCapabilityPresets({ runtimeRoot, profilePatch: path.join(profile, 'cordis.patch.yml'), apply: true });
ensureFrameworkCohort(home, host, 'mathmodel', 'capability-verification');
ensureProfileFallbacks(home, host, 'mathmodel');
fs.mkdirSync(path.join(home, 'skills', 'capability-fixture'), { recursive: true });
fs.writeFileSync(path.join(home, 'skills', 'capability-fixture', 'SKILL.md'), '---\nname: capability-fixture\ndescription: Offline capability fixture\n---\nRead-only fixture.\n');
const probeFile = path.join(root, 'probe.mjs');
fs.writeFileSync(probeFile, `import { writeFile as writeTemp, readFile, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createBenchmarkFileGuard } from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/benchmark-file-policy.mjs')).href)};
async function writeFile(file, data) { await writeTemp(file+'.tmp',data); await rename(file+'.tmp',file); }
export const inject = ['agentPresets', 'tools', 'agents', 'mathmodelHostCapabilities'];
export function apply(ctx) {
  ${negativeChecks ? `ctx.tools.guard(createBenchmarkFileGuard({workspace:${JSON.stringify(workspace)},auditFile:${JSON.stringify(policyAudit)}}));` : ''}
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !existsSync(${JSON.stringify(readyFile)})) return; busy = true;
    try {
      const roster = (await ctx.agentPresets.list()).filter(row => row.id === 'task');
      if (roster.length !== 1) { busy = false; return; }
      const catalogs = [];
      for (const row of roster) {
        if (row.broken) throw new Error(row.id + ': ' + row.broken);
        const lease = await ctx.agentPresets.acquireScope(row.id);
        try {
          const schemas = ctx.tools.wireSchemas(lease.key).schemas;
          const repeated = ctx.tools.wireSchemas(lease.key).schemas;
          const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
          catalogs.push({ id: row.id, names: schemas.map(schema => schema.name), schemaSha256: digest(schemas), repeatedSha256: digest(repeated) });
        } finally { await lease[Symbol.asyncDispose](); }
      }
      await writeFile(${JSON.stringify(catalogFile)}, JSON.stringify({ ok: true, catalogs }));
      clearInterval(timer);
    } catch (error) {
      await writeFile(${JSON.stringify(catalogFile)}, JSON.stringify({ ok: false, error: error.message })); clearInterval(timer);
    }
  }, 500);
  ctx.effect(() => () => clearInterval(timer));
  let controlling = false;
  const control = setInterval(async () => {
    if (controlling || !existsSync(${JSON.stringify(commandFile)})) return;
    controlling = true;
    try {
      const command = JSON.parse(await readFile(${JSON.stringify(commandFile)}, 'utf8'));
      await unlink(${JSON.stringify(commandFile)});
      const agent = ctx.agents.get(command.sessionId);
      if (!agent) throw new Error('fixture agent absent');
      if (command.action === 'turn') {
        agent.session.append('turn/start', { turn: 1 });
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      }
      if (command.action === 'tamper') {
        const original = ctx.mathmodelHostCapabilities.controller.projections.stateOf(agent.session, 'mathmodelCapabilities');
        agent.session.append('mathmodel/capabilities-confirmed', {...original, ...command.overrides}, {ignorable:true});
      }
      if (command.action === 'tool') {
        const boundary = ctx.mathmodelHostCapabilities.controller.projections.stateOf(agent.session, 'turnBoundary');
        const turn = boundary.lastTurn + 1;
        agent.session.append('turn/start', {turn});
        try {
          const result = await ctx.tools.execute({agent, callId:'negative-tool-'+turn, name:command.tool,
            arguments:command.args, signal:new AbortController().signal});
          await writeFile(${JSON.stringify(answerFile)}, JSON.stringify({ok:true, result}));
        } finally { agent.session.append('turn/end', {turn, reason:{kind:'completed'}}); }
        return;
      }
      const reason = await ctx.mathmodelHostCapabilities.controller.gate.read(() => ctx.mathmodelHostCapabilities.controller.verify(agent));
      const preStep = command.action === 'pre-step'
        ? await agent.dispatch.waterfall('agent/pre-step', { messages: [], turn: 2, step: 1, signal: new AbortController().signal },
          () => Promise.resolve({ kind: 'enter', messages: [] })) : null;
      await writeFile(${JSON.stringify(answerFile)}, JSON.stringify({ ok: true, reason, preStep, status: agent.status }));
    } catch (error) { await writeFile(${JSON.stringify(answerFile)}, JSON.stringify({ ok: false, error: error.message })); }
    finally { controlling = false; }
  }, 500);
  ctx.effect(() => () => clearInterval(control));
}
`);
fs.appendFileSync(path.join(profile, 'cordis.patch.yml'), `\n- insert:\n    - id: capability-verification-probe\n      name: ${JSON.stringify(probeFile.replaceAll('\\', '/'))}\n`);
const port = await findHostPort();
const baseEnv = {
  SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
  TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
  USERPROFILE: path.join(root, 'os-home'), HOME: path.join(root, 'os-home'), DSH_AGENTS_HOME: path.join(root, 'os-home', '.agents'),
  APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
};
const nodeHome = path.join(runtime, 'node-win-x64');
let child, exited;
function launchHost() {
  const logOffset = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0;
  child = spawn(path.join(nodeHome, 'node.exe'), [path.join(runtimeRoot, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'mathmodel', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workspace, env: childEnv(home, nodeHome, process.platform, baseEnv, [runtimeRoot, path.join(home, 'profiles', 'node_modules')]), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => fs.appendFileSync(logFile, data));
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return logOffset;
}
async function stopHost() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const stopped = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 10000))]);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
async function awaitHost(logOffset) {
  await waitForGui(port, { deadlineMs: 180000, isAlive: () => child.exitCode === null,
    getTokenUrl: () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(logOffset).match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/m)?.[1] : undefined });
  fs.writeFileSync(readyFile, 'ready');
}
const firstLogOffset = launchHost();
try {
  await awaitHost(firstLogOffset);
  const deadline = Date.now() + 180000;
  while (!fs.existsSync(catalogFile)) {
    if (child.exitCode !== null) throw new Error('Isolated Host exited before verification');
    if (Date.now() > deadline) throw new Error('Isolated Host catalog timed out');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  assert.equal(catalog.ok, true, catalog.error);
  for (const row of catalog.catalogs) {
    for (const name of ['vision_analyze', 'image_generate', 'editable_ppt_image', 'web_search', 'web_fetch', 'skill', 'delegate', 'handoff_ledger']) assert.ok(row.names.includes(name), `${row.id}: ${name}`);
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'list_agents', 'send_message']) assert.ok(!row.names.includes(name), `${row.id}: ${name} must be absent`);
    assert.equal(row.schemaSha256, row.repeatedSha256);
  }
  const client = await createInstalledHostClient({ logFile });
  const registered = await client.rpc('workspace', 'create', { request: { path: workspace } });
  const workspaceId = registered.workspace.workspaceId;
  const roster = await client.rpc('agentPresets', 'list');
  assert.equal(roster.presets.filter(row => row.id === 'task' && !row.broken).length, 1);
  const sessions = [];
  for (const row of Array.from({ length: 5 }, () => catalog.catalogs[0])) {
    const created = await client.rpc('session', 'create', { request: { agentPreset: row.id, workspaceId } });
    const projection = await client.rpc('session', 'projections', { request: { sessionId: created.sessionId } });
    assert.equal(projection.values.agentPreset, row.id);
    assert.equal(projection.values.sessionListMetadata.blank, true);
    const skills = await client.rpc('skills', 'list', { request: { sessionId: created.sessionId } });
    const list = Array.isArray(skills) ? skills : skills.skills ?? skills.items;
    assert.ok(Array.isArray(list), 'Unexpected skill catalog shape');
    assert.equal(list.some(skill => skill.name === 'capability-fixture'), true);
    sessions.push({ preset: row.id, sessionId: created.sessionId, blank: true, fixtureSkillVisible: list.some(skill => skill.name === 'capability-fixture') });
  }
  const preview = await client.rpc('mathmodelHostCapabilities', 'describe', { sessionId: sessions[0].sessionId });
  const changed = await client.rpc('mathmodelHostCapabilities', 'confirm', { sessionId: sessions[0].sessionId, preset: 'task', hostHash: preview.hostHash });
  assert.equal(changed.preset, 'task');
  const selected = await client.rpc('session', 'projections', { request: { sessionId: sessions[0].sessionId } });
  assert.equal(selected.values.agentPreset, 'task');
  const control = async (action, options = {}) => {
    if (fs.existsSync(answerFile)) fs.unlinkSync(answerFile);
    fs.writeFileSync(commandFile+'.tmp', JSON.stringify({ action, sessionId: sessions[0].sessionId, ...options }));
    fs.renameSync(commandFile+'.tmp',commandFile);
    const until = Date.now() + 15000;
    while (!fs.existsSync(answerFile)) { if (Date.now() > until) throw new Error('Fixture command timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
    const answer = JSON.parse(fs.readFileSync(answerFile, 'utf8')); assert.equal(answer.ok, true, answer.error); return answer;
  };
  const begun = await control('turn');
  assert.equal(begun.reason, null);
  assert.equal((await control('pre-step')).preStep.kind, 'enter');
  const frozen = await client.rpc('mathmodelHostCapabilities', 'describe', { sessionId: sessions[0].sessionId });
  assert.equal(frozen.locked, true);
  assert.equal(frozen.confirmed.preset, 'task');
  const refused = await client.rpc('pluginManager', 'setBundleEnabled', { name: 'dsh-model-fusion', enabled: false });
  assert.equal(refused.changed, false);
  assert.equal(refused.application, 'failed');
  assert.equal((await client.rpc('mathmodelHostCapabilities', 'describe', { sessionId: sessions[0].sessionId })).matches, true);
  const negatives = [];
  const coldTargets = [];
  if (negativeChecks) {
    const outside = path.join(root, 'solution.cjs'), secret = 'BENCHMARK-PRIVATE-CANARY-ONLY';
    fs.writeFileSync(outside, secret);
    const allowed = await control('tool', {tool:'read', args:{file_path:'TASK.md'}});
    assert.equal(allowed.result.isError, false, JSON.stringify(allowed.result));
    for (const [name, tool, file_path, content] of [
      ['outside-read','read',outside], ['parent-traversal','read','../solution.cjs'],
      ['outside-write','write',outside,'overwritten'], ['fixture-write','write','TASK.md','overwritten'],
    ]) {
      const result = (await control('tool', {tool, args:{file_path, ...(content ? {content} : {})}})).result;
      assert.equal(result.isError, true, name); assert.ok(!JSON.stringify(result).includes(secret), name+' leaked content');
      assert.match(JSON.stringify(result), /Benchmark file policy denied/, name);
      assert.equal(fs.readFileSync(outside, 'utf8'), secret);
      assert.equal(fs.readFileSync(path.join(workspace, 'TASK.md'), 'utf8'), 'fixture-content');
      negatives.push({name, denied:true, sideEffects:0, contentLeaked:false});
    }
    const original = fs.readFileSync(path.join(workspace, 'solution.cjs'), 'utf8');
    fs.unlinkSync(path.join(workspace, 'solution.cjs')); fs.linkSync(outside, path.join(workspace, 'solution.cjs'));
    try {
      const result = (await control('tool', {tool:'read', args:{file_path:'solution.cjs'}})).result;
      assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes(secret));
      negatives.push({name:'hardlink-read',denied:true,sideEffects:0,contentLeaked:false});
    } finally { fs.unlinkSync(path.join(workspace, 'solution.cjs')); fs.writeFileSync(path.join(workspace, 'solution.cjs'), original); }
    await control('turn', {sessionId:sessions[1].sessionId});
    coldTargets.push({sessionId:sessions[1].sessionId,preset:sessions[1].preset,kind:'missing-confirmation'});
    for (const [index, overrides, kind] of [
      [2,{hostHash:'0'.repeat(64)},'host-hash'], [3,{globalToolsHash:'0'.repeat(64)},'tools-hash'],
      [4,{preset:'standard'},'preset-mismatch'],
    ]) {
      const target = sessions[index], p = await client.rpc('mathmodelHostCapabilities','describe',{sessionId:target.sessionId});
      await client.rpc('mathmodelHostCapabilities','confirm',{sessionId:target.sessionId,preset:target.preset,hostHash:p.hostHash});
      await control('turn',{sessionId:target.sessionId});
      const tampered = await control('tamper',{sessionId:target.sessionId,overrides});
      assert.match(tampered.reason,/快照不一致/);
      coldTargets.push({sessionId:target.sessionId,preset:target.preset,kind});
    }
  }
  await stopHost();
  fs.unlinkSync(readyFile);
  fs.unlinkSync(catalogFile);
  await awaitHost(launchHost());
  const resumedClient = await createInstalledHostClient({ logFile });
  // rc.5: session/create reuses a named Session only while it is blank. A started one becomes live
  // through any Agent-resolving call; renaming it sends no prompt and calls no model.
  const resume = sessionId => resumedClient.rpc('session', 'rename', { request: { sessionId, title: 'capability verification' } });
  await resume(sessions[0].sessionId);
  const resumed = await resumedClient.rpc('session', 'projections', { request: { sessionId: sessions[0].sessionId } });
  assert.equal(resumed.values.agentPreset, 'task');
  const restored = await resumedClient.rpc('mathmodelHostCapabilities', 'describe', { sessionId: sessions[0].sessionId });
  assert.equal(restored.locked, true);
  assert.equal(restored.matches, true);
  assert.deepEqual(restored.confirmed, frozen.confirmed);
  const afterRestart = await control('pre-step');
  assert.equal(afterRestart.reason, null);
  assert.equal(afterRestart.preStep.kind, 'enter');
  if (negativeChecks) for (const target of coldTargets) {
    await resume(target.sessionId);
    const rejected = await control('pre-step',{sessionId:target.sessionId});
    assert.equal(rejected.preStep.kind,'reject',target.kind);
    assert.match(rejected.reason,target.kind === 'missing-confirmation' ? /请先/ : /快照不一致/,target.kind);
    await assert.rejects(resumedClient.rpc('mathmodelHostCapabilities','confirm',{sessionId:target.sessionId,preset:target.preset,hostHash:frozen.hostHash}));
    negatives.push({name:'cold-resume-'+target.kind,denied:true,modelRequests:0,autoReconfirmed:false});
  }
  const manifestFile = path.join(profile, 'package.json');
  const originalManifest = fs.readFileSync(manifestFile, 'utf8');
  let drifted, recovered;
  try {
    const manifest = JSON.parse(originalManifest);
    manifest.dsh.profile.capabilityVerificationNonce = 'isolated-external-change';
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    drifted = await control('pre-step');
    assert.match(drifted.reason, /Host.*不一致/);
    assert.equal(drifted.preStep.kind, 'reject');
    if (negativeChecks) {
      const before = fs.readFileSync(path.join(workspace,'solution.cjs'),'utf8');
      const denied = (await control('tool',{tool:'write',args:{file_path:'solution.cjs',content:'changed'}})).result;
      assert.equal(denied.isError,true); assert.match(JSON.stringify(denied),/capabilities\/frozen|快照不一致/);
      assert.equal(fs.readFileSync(path.join(workspace,'solution.cjs'),'utf8'),before);
      negatives.push({name:'configuration-drift-tool-write',denied:true,sideEffects:0});
    }
  } finally { fs.writeFileSync(manifestFile, originalManifest); }
  recovered = await control('pre-step');
  assert.equal(recovered.reason, null);
  assert.equal(recovered.preStep.kind, 'enter');
  if (negativeChecks) {
    const unobserved = (await control('tool',{tool:'write',args:{file_path:'solution.cjs',content:'must-not-write'}})).result;
    assert.equal(unobserved.isError,true); assert.match(JSON.stringify(unobserved),/FS_NOT_OBSERVED/);
    negatives.push({name:'unobserved-write-after-resume',denied:true,sideEffects:0});
    const observed = (await control('tool',{tool:'read',args:{file_path:'solution.cjs'}})).result;
    assert.equal(observed.isError,false,JSON.stringify(observed));
    const permitted = (await control('tool',{tool:'write',args:{file_path:'solution.cjs',content:'recovered-once'}})).result;
    assert.equal(permitted.isError,false,JSON.stringify(permitted));
    assert.equal(fs.readFileSync(path.join(workspace,'solution.cjs'),'utf8'),'recovered-once');
    negatives.push({name:'restored-configuration-tool-write',allowed:true,sideEffects:1});
  }
  assert.equal((await resumedClient.rpc('mathmodelHostCapabilities', 'describe', { sessionId: sessions[0].sessionId })).matches, true);
  const concurrentTask = await resumedClient.rpc('session', 'create', { request: { workspaceId, agentPreset: 'task' } });
  const concurrentPreview = await resumedClient.rpc('mathmodelHostCapabilities', 'describe', { sessionId: concurrentTask.sessionId });
  await resumedClient.rpc('mathmodelHostCapabilities', 'confirm', { sessionId: concurrentTask.sessionId, preset: 'task', hostHash: concurrentPreview.hostHash });
  assert.equal((await resumedClient.rpc('mathmodelHostCapabilities', 'describe', { sessionId: sessions[0].sessionId })).matches, true, 'a different task scope must not alter the Host fingerprint');
  assert.equal((await control('pre-step')).preStep.kind, 'enter');
  const receipt = { ok: true, root, observedAt: new Date().toISOString(), modelPromptSent: false, installedProfileChanged: false, negativeChecks, negatives, blankSelectionChanged: true, hostSnapshot: frozen, blockedHostMutation: refused, syntheticBoundary: begun, coldResume: restored, afterRestart, configurationDrift: drifted, configurationRecovered: recovered, catalogs: catalog.catalogs, sessions };
  fs.writeFileSync(path.join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  fs.copyFileSync(path.join(root, 'receipt.json'), path.join(repo, negativeChecks ? 'dist/permissions-recovery-receipt.json' : 'dist/task-capabilities-receipt.json'));
  if (negativeChecks) fs.copyFileSync(policyAudit,path.join(repo,'dist/permissions-file-policy-audit.jsonl'));
  console.log(`task preset catalog and blank session verified; ${path.join(root, 'receipt.json')}`);
  if (process.env.DSH_CAPABILITY_UI_HOLD === '1') {
    console.log(`UI verification ready; stop by creating ${path.join(root, 'ui-stop')}`);
    const deadline = Date.now() + 900000;
    while (Date.now() < deadline && !fs.existsSync(path.join(root, 'ui-stop'))) await new Promise(resolve => setTimeout(resolve, 500));
  }
} finally {
  await stopHost();
  console.log(`Isolated verification files: ${root}`);
}
