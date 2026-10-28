// Explicitly paid, bounded, synthetic-only integration through the bundled official Host.
// No import side effects: invoke with --run --stage=2 or --stage=3.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installTaskCapabilityPresets } from './task-capabilities.mjs';
import { createInstalledHostClient } from './installed-host-client.mjs';
import { scoreJsonTask } from './deepseek-benchmark-metrics.mjs';
import { makeCodeSchedule, evaluateCodeTask } from './deepseek-code-benchmark.mjs';
import { runPublicRepairLoop } from './public-repair-loop.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { applyProfileSeed, ensureFrameworkCohort, ensureProfileFallbacks, findHostPort, childEnv, waitForGui } = require('../src/runtime.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const route = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' };

async function eventsOf(client, sessionId) {
  const projection = await client.rpc('session', 'projections', { request: { sessionId } });
  const page = await client.rpc('session', 'page', { request: { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 250 } });
  assert.equal(page.hasMore, false, 'benchmark event page exceeded its limit');
  return page.records.map(row => row.event).filter(Boolean);
}
export const textOf = events => (events.filter(row => row.type === 'assistant/message').at(-1)?.data.message?.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n');
export function repairAttemptCompletion(trial, fixtureIntegrity) {
  if (!fixtureIntegrity) throw new Error('Immutable fixture boundary failed');
  const sent = trial.providerRequests.filter(row => !row.blockedBeforeSend);
  if (!sent.length || sent.some(row => row.usageComplete !== true)) throw new Error('Incomplete repair usage');
  if (trial.turnEndReason.kind === 'completed') return true;
  if (trial.turnEndReason.kind === 'benchmark-request-limit' && trial.providerRequests.some(row => row.blockedBeforeSend && row.reason === 'turn-request-budget')) return false;
  throw new Error('Repair turn did not complete or settle at its local request budget');
}
function parseAnswer(text) { try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')); } catch { return null; } }

// Cache share of one audited request's prompt; null when any bucket is unknown.
export function requestHitRate(row) {
  const usage = row?.rawUsage ?? {};
  const parts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(key => usage[key]);
  if (row?.usageComplete !== true || parts.some(value => !Number.isSafeInteger(value))) return null;
  const total = parts[0] + parts[1] + parts[2];
  return total ? parts[1] / total : null;
}

export async function runLiveBenchmark({ stage, clarifyFormat = false, codeTasks = false, repairCheck = false, switchArm, seed = randomBytes(4).readUInt32LE() }) {
  if (process.platform !== 'win32' || ![2, 3].includes(stage)) throw new Error('This explicit integration requires Windows and stage 2 or 3');
  if (codeTasks && (stage !== 3 || clarifyFormat)) throw new Error('Code tasks require stage 3 without clarify-format');
  if (switchArm !== undefined && (stage !== 3 || codeTasks || clarifyFormat || !['restrict', 'guard'].includes(switchArm))) throw new Error('Switch cache arm requires stage 3 and restrict|guard');
  if (repairCheck && !codeTasks) throw new Error('Repair check requires code tasks');
  const tasks = codeTasks ? repairCheck ? (await import('./deepseek-repair-cases.mjs')).repairTasks : (await import('./deepseek-code-tasks.mjs')).tasks : [];
  const schedule = repairCheck ? [
    { taskId: 'csv-parser', round: 1, pair: 1, position: 1, preset: 'task-00' },
    { taskId: 'csv-parser', round: 1, pair: 1, position: 2, preset: 'task-0f' },
    { taskId: 'dependency-waves', round: 1, pair: 2, position: 1, preset: 'task-0f' },
    { taskId: 'dependency-waves', round: 1, pair: 2, position: 2, preset: 'task-00' },
  ] : codeTasks ? makeCodeSchedule(tasks.map(task => task.id), seed) : null;
  const maxRequests = repairCheck ? 72 : codeTasks ? 96 : 24, maxOutputTokens = codeTasks ? 2048 : 1024, turnTimeoutMs = codeTasks ? 180000 : 120000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-live-stage${stage}-`));
  const home = path.join(root, 'home'), profile = path.join(home, 'profiles', 'mathmodel'), workspace = path.join(root, 'workspace');
  const runtime = path.join(repo, 'resources/runtime'), host = path.join(runtime, 'host'), runtimeRoot = path.join(host, 'node_modules');
  const logFile = path.join(root, 'host.log'), auditFile = path.join(root, 'provider-audit.jsonl');
  const fileAuditFile = path.join(root, 'file-policy-audit.jsonl');
  const turnBudgetFile = codeTasks ? path.join(root, 'turn-budget.json') : undefined;
  if (turnBudgetFile) fs.writeFileSync(turnBudgetFile, JSON.stringify({ key: 'startup', maximumRequests: 1 }));
  const credentialFile = path.join(home, '.credentials.yaml');
  const output = path.join(repo, 'dist', `live-stage${stage}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(output, { recursive: true });
  for (const name of ['workspace', 'os-home', 'local', 'roaming', 'tmp']) fs.mkdirSync(path.join(root, name));
  const YAML = createRequire(path.join(runtimeRoot, '__benchmark__.cjs'))('yaml');
  applyProfileSeed(path.join(runtime, 'profile-web'), profile, 'seed', 'live-benchmark', { appVersion: '0.1.4' });
  installTaskCapabilityPresets({ runtimeRoot, profilePatch: path.join(profile, 'cordis.patch.yml'), apply: true });
  ensureFrameworkCohort(home, host, 'mathmodel', 'live-benchmark');
  ensureProfileFallbacks(home, host, 'mathmodel');
  // Only the already-authorized DeepSeek reference enters this owned temporary store.
  const source = YAML.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-mathmodel', '.credentials.yaml'), 'utf8'));
  if (typeof source.refs?.DEEPSEEK_API_KEY !== 'string' || !source.refs.DEEPSEEK_API_KEY.trim()) throw new Error('Configured DeepSeek credential reference is unavailable');
  fs.appendFileSync(path.join(profile, 'cordis.patch.yml'), `\n- id: llm-deepseek\n  config:\n    thinking: disabled\n    reasoningEffort: off\n    maxTokens: ${maxOutputTokens}\n- id: session-title-llm\n  disabled: true\n`);
  const skillDir = path.join(home, 'skills', 'capability-fixture'); fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: capability-fixture\ndescription: Synthetic capability acceptance fixture; use when explicitly asked.\n---\nRead capability-input.json from the current workspace and return JSON only, with its sum and verificationToken. The verificationToken is SKILL-LIVE-42. Do not use shell, network, other files or delegation.\n');
  fs.writeFileSync(path.join(workspace, 'capability-input.json'), JSON.stringify({ values: [17, -5, 30], verificationToken: 'FILE-LIVE-42' }));
  const probe = path.join(root, 'audit-probe.mjs');
  fs.writeFileSync(probe, `import {installDeepSeekAudit} from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/deepseek-live-audit.mjs')).href)};\nimport {createBenchmarkFileGuard} from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/benchmark-file-policy.mjs')).href)};\nexport const inject = ['llm', 'agentPresets', 'mathmodelHostCapabilities', 'tools'];\nexport function apply(ctx) { ${codeTasks ? `ctx.tools.guard(createBenchmarkFileGuard({workspace:${JSON.stringify(workspace)},auditFile:${JSON.stringify(fileAuditFile)}}));` : ''} ctx.effect(() => installDeepSeekAudit({filename:${JSON.stringify(auditFile)},maxRequests:${maxRequests},maxOutputTokens:${maxOutputTokens},turnBudgetFile:${JSON.stringify(turnBudgetFile)}})); }\n`);
  fs.appendFileSync(path.join(profile, 'cordis.patch.yml'), `\n- insert:\n    - id: live-benchmark-audit\n      name: ${JSON.stringify(probe.replaceAll('\\', '/'))}\n`);
  const receipt = { stage, protocol: switchArm ? `tool-switch-cache-${switchArm}-v1` : repairCheck ? 'code-public-verified-repair-v6' : codeTasks ? 'code-randomized-crossover-v3' : clarifyFormat ? 'clarified-schema-followup-v2' : 'initial-v1', startedAt: new Date().toISOString(), root, output, route, syntheticOnly: true, installedProfileChanged: false,
    ...(codeTasks ? { seed, schedule, taskContracts: tasks.map(({ id, spec }) => ({ id, spec })) } : {}),
    limits: { maximumProviderRequests: maxRequests, outputTokensPerRequest: maxOutputTokens, turnTimeoutMs, maximumTurns: switchArm ? 12 : repairCheck ? 12 : codeTasks ? schedule.length : stage === 2 ? 8 : clarifyFormat ? 2 : 10,
      ...(repairCheck ? { attemptsPerDelivery: 3, maximumDeliveries: 4, feedback: 'public-tests-only', hiddenAcceptance: 'final-source-only' } : {}) }, trials: [] };
  const save = () => fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (codeTasks) {
    receipt.fixtureValidation = tasks.map(task => {
      const reference = evaluateCodeTask({ task, source: task.reference, directory: path.join(output, 'preflight', task.id, 'reference') });
      const starter = evaluateCodeTask({ task, source: task.starter, directory: path.join(output, 'preflight', task.id, 'starter') });
      const hash = value => createHash('sha256').update(value).digest('hex');
      return { taskId: task.id, referencePassed: reference.passed, starterPassed: starter.passed,
        specSha256: hash(task.spec), publicSha256: hash(task.publicTest), hiddenSha256: hash(task.hiddenTest) };
    });
    save();
    assert.ok(receipt.fixtureValidation.every(row => row.referencePassed && !row.starterPassed), 'Fixture preflight failed before provider calls');
  }
  const audit = () => fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) : [];
  const drainAudit = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const state = JSON.parse(fs.readFileSync(auditFile + '.state.json', 'utf8'));
        if (state.inFlight === 0 && audit().filter(row => !row.blockedBeforeSend).length === state.settled) return audit();
      } catch {}
      await sleep(50);
    }
    throw new Error('Provider audit did not settle; request attribution is unknown');
  };
  let child, exited, activeSession;
  try {
    fs.writeFileSync(credentialFile, YAML.stringify({ version: 1, refs: { DEEPSEEK_API_KEY: source.refs.DEEPSEEK_API_KEY } }), { mode: 0o600 });
    const port = await findHostPort(), nodeHome = path.join(runtime, 'node-win-x64');
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
      TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), USERPROFILE: path.join(root, 'os-home'), HOME: path.join(root, 'os-home'),
      DSH_AGENTS_HOME: path.join(root, 'os-home', '.agents'), APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local') };
    child = spawn(path.join(nodeHome, 'node.exe'), [path.join(runtimeRoot, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'mathmodel', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: workspace, env: childEnv(home, nodeHome, process.platform, env, [runtimeRoot, path.join(home, 'profiles', 'node_modules')]), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolve => child.once('exit', resolve));
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => fs.appendFileSync(logFile, data));
    console.log(`Stage ${stage} owned fixture: ${root}`); save();
    await waitForGui(port, { deadlineMs: 180000, isAlive: () => child.exitCode === null,
      getTokenUrl: () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/m)?.[1] : undefined });
    const client = await createInstalledHostClient({ logFile });
    assert.ok(fs.existsSync(auditFile), 'Provider audit observer did not activate');
    const registered = await client.rpc('workspace', 'create', { request: { path: workspace } });
    const workspaceId = registered.workspace.workspaceId;
    const create = async preset => {
      const { sessionId } = await client.rpc('session', 'create', { request: { workspaceId, agentPreset: preset } });
      await client.rpc('session', 'selectModel', { request: { sessionId, ...route } });
      return sessionId;
    };
    const confirm = async (sessionId, preset) => {
      const preview = await client.rpc('mathmodelHostCapabilities', 'describe', { sessionId });
      return client.rpc('mathmodelHostCapabilities', 'confirm', { sessionId, preset, hostHash: preview.hostHash });
    };
    const turn = async (sessionId, prompt, name, expected, { record = true } = {}) => {
      activeSession = sessionId;
      const before = await eventsOf(client, sessionId), lastSeq = before.at(-1)?.seq ?? -1, firstAudit = (await drainAudit()).length, start = Date.now();
      if (turnBudgetFile) fs.writeFileSync(turnBudgetFile, JSON.stringify({ key: name, maximumRequests: 6 }));
      const firstFileAudit = fs.existsSync(fileAuditFile) ? fs.readFileSync(fileAuditFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
      const accepted = await client.rpc('session', 'prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: 'Asia/Shanghai' } });
      assert.equal(accepted.accepted, true);
      let events, ended, interrupted;
      while (Date.now() - start < turnTimeoutMs) {
        events = (await eventsOf(client, sessionId)).filter(row => row.seq > lastSeq);
        ended = events.findLast(row => row.type === 'turn/end');
        if (ended) break;
        if (codeTasks && audit().slice(firstAudit).some(row => row.blockedBeforeSend)) { interrupted = 'benchmark-request-limit'; break; }
        if (events.some(row => row.type === 'approval/asked' && !events.some(decided => decided.type === 'approval/decided' && decided.data.id === row.data.id))) throw new Error(`Unexpected approval in synthetic trial ${name}`);
        await sleep(700);
      }
      if (!ended) {
        await client.rpc('session', 'cancel', { request: { sessionId } });
        if (!codeTasks) throw new Error(`Live turn timed out: ${name}`);
        interrupted ??= 'benchmark-timeout';
        const deadline = Date.now() + 15000;
        do {
          events = (await eventsOf(client, sessionId)).filter(row => row.seq > lastSeq);
          ended = events.findLast(row => row.type === 'turn/end');
          if (!ended) await sleep(200);
        } while (!ended && Date.now() < deadline);
        if (!ended) throw new Error(`Cancelled turn did not settle: ${name}`);
      }
      const text = textOf(events), answer = parseAnswer(text), providerRequests = (await drainAudit()).slice(firstAudit);
      const projection = await client.rpc('session', 'projections', { request: { sessionId } });
      const trial = { name, sessionId, startedAt: new Date(start).toISOString(), elapsedMs: Date.now() - start,
        turnEndReason: interrupted ? { kind: interrupted } : ended.data.reason, text, answer, passed: expected === undefined ? null : scoreJsonTask(text, expected).passed,
        blockedReason: projection.values.mathmodelCapabilities?.blockedReason ?? null,
        toolNames: events.filter(row => row.type === 'tool/call').map(row => row.data.name),
        ...(codeTasks ? { filePolicy: fs.existsSync(fileAuditFile) ? fs.readFileSync(fileAuditFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).slice(firstFileAudit) : [] } : {}),
        usage: events.filter(row => row.type === 'assistant/message').map(row => row.data.usage ?? null), providerRequests };
      if (record) receipt.trials.push(trial); save();
      if (codeTasks && providerRequests.some(row => row.blockedBeforeSend && row.reason === 'turn-request-budget')) trial.turnEndReason = { kind: 'benchmark-request-limit' };
      console.log(`${name}: end=${trial.turnEndReason.kind}; sent=${providerRequests.filter(row => !row.blockedBeforeSend).length}; blocked=${providerRequests.filter(row => row.blockedBeforeSend).length}; quality=${trial.passed}`);
      activeSession = undefined;
      return trial;
    };
    // Same synthetic prefix and objective questions across arms. The first trial is observed warmup, never asserted cold.
    const prefix = 'Synthetic benchmark rules: respond with JSON only and do not call tools. No file edits, network or delegation.\n' +
      Array.from({ length: 180 }, (_, i) => `Reference row ${i}: integer accounting uses exact cents; sorting is ascending; empty totals are zero.`).join('\n');
    const questions = [
      { text: 'Compute sum of [17,-5,30], count, and minimum. Return keys sum,count,min.', answer: { sum: 42, count: 3, min: -5 } },
      { text: 'For sales 3*119 and 2*207 cents, and a refund of 1*119 cents, return keys grossCents,refundCents,netCents.', answer: { grossCents: 771, refundCents: 119, netCents: 652 } },
      { text: 'Deduplicate [3,1,3,2,1,0] preserving first appearance; return key values.', answer: { values: [3, 1, 2, 0] } },
    ];
    if (stage === 2) {
      const unconfirmed = await create('task-00');
      const denied = await turn(unconfirmed, 'Reply only {"ok":true}. Do not use tools.', 'missing-confirmation');
      assert.equal(denied.providerRequests.length, 0, 'unconfirmed task reached the provider');
      const baseline = await create('task-00'); await confirm(baseline, 'task-00');
      const a = await turn(baseline, 'Use the read tool to read capability-input.json in this workspace. Return only {"sum":the sum of values,"verificationToken":the file verificationToken}. Do not use shell, web, delegation, other files or write anything.', 'file-read-without-skills', { sum: 42, verificationToken: 'FILE-LIVE-42' });
      assert.equal(a.passed, true); assert.ok(a.providerRequests.length > 0); assert.ok(a.toolNames.includes('read'));
      assert.ok(a.providerRequests.every(row => !row.toolNames.includes('skill') && !row.toolNames.includes('vision_analyze')));
      await assert.rejects(confirm(baseline, 'task-0f'), /locked|任务已开始/);
      const skills = await create('task-02'); await confirm(skills, 'task-02');
      const b = await turn(skills, 'Use the capability-fixture skill, follow its instructions, read capability-input.json, and return only {"sum":42,"verificationToken":the token specified inside the skill}. Do not use shell, web, delegation, other files or write anything.', 'skill-and-file-read', { sum: 42, verificationToken: 'SKILL-LIVE-42' });
      assert.equal(b.passed, true); assert.ok(b.toolNames.includes('skill')); assert.ok(b.providerRequests.some(row => row.toolNames.includes('skill')));
      assert.equal((await client.rpc('mathmodelHostCapabilities', 'describe', { sessionId: baseline })).matches, true);
      const refused = await client.rpc('pluginManager', 'setBundleEnabled', { name: 'dsh-model-fusion', enabled: false });
      assert.equal(refused.changed, false); assert.equal(refused.application, 'failed'); receipt.hostMutationRefused = true;
      const filename = path.join(profile, 'package.json'), original = fs.readFileSync(filename, 'utf8');
      try {
        const manifest = JSON.parse(original); manifest.dsh.profile.liveVerificationNonce = 'drift'; fs.writeFileSync(filename, JSON.stringify(manifest));
        const blocked = await turn(baseline, 'Reply only {"ok":true}. Do not use tools.', 'configuration-drift');
        assert.equal(blocked.providerRequests.length, 0, 'drifted task reached the provider');
        assert.equal(blocked.turnEndReason.kind, 'blocked'); assert.match(blocked.blockedReason, /快照不一致/);
      } finally { fs.writeFileSync(filename, original); }
      const recovered = await turn(baseline, 'Reply only {"ok":true}. Do not use tools.', 'restored-configuration', { ok: true });
      assert.equal(recovered.passed, true); assert.ok(recovered.providerRequests.length > 0);
      receipt.ok = true;
    } else if (codeTasks) {
      fs.unlinkSync(path.join(workspace, 'capability-input.json'));
      for (const item of schedule) {
        const task = tasks.find(row => row.id === item.taskId);
        const fixtures = { 'solution.cjs': task.starter, 'public.test.cjs': task.publicTest, 'TASK.md': task.spec };
        for (const [name, content] of Object.entries(fixtures)) fs.writeFileSync(path.join(workspace, name), content);
        const sessionId = await create(item.preset); await confirm(sessionId, item.preset);
        if (repairCheck) {
          const name = `${item.taskId}-r${item.round}-${item.preset}`, started = Date.now();
          const delivery = { ...item, name, sessionId, kind: 'public-verified-model-repair', attempts: [], providerRequests: [], passed: false, elapsedMs: 0 };
          receipt.trials.push(delivery); save();
          const integrity = () => ['TASK.md', 'public.test.cjs'].every(file => fs.readFileSync(path.join(workspace, file), 'utf8') === fixtures[file]) &&
            fs.readdirSync(workspace).length === 3;
          const loop = await runPublicRepairLoop({
            maxAttempts: 3,
            requestAttempt: async ({ attempt, feedback }) => {
              const instruction = feedback ?? 'Repair the implementation in solution.cjs to satisfy TASK.md and the public regression tests. Read TASK.md, solution.cjs and public.test.cjs. The evaluator will execute the public tests after this turn and return real failure diagnostics if needed.';
              const prompt = instruction + '\nRead the current solution.cjs before editing. Only file read/write/edit are permitted. Modify ONLY solution.cjs. Preserve the entire specification and immutable test files. Do not use shell/network/delegation or create files. Read each needed file once, preferably in the same request. After one successful edit/write STOP calling tools and give a brief final answer. The evaluator executes tests and returns public failure diagnostics on the next attempt. Each attempt allows six model requests.';
              const trial = await turn(sessionId, prompt, `${name}-attempt-${attempt}`, undefined, { record: false });
              const source = fs.readFileSync(path.join(workspace, 'solution.cjs'), 'utf8');
              let completed;
              try { completed = repairAttemptCompletion(trial, integrity()); } catch (error) {
                delivery.attempts.push({ ...trial, attempt, publicPassed: false, verificationUnavailable: true });
                delivery.providerRequests.push(...trial.providerRequests); delivery.elapsedMs = Date.now() - started;
                delivery.fixtureIntegrity = integrity(); save();
                throw error;
              }
              return { source, trial, completed, interruption: completed ? null : 'request-budget' };
            },
            verifyPublic: (candidate, attempt) => evaluateCodeTask({ task, source: candidate.source,
              directory: path.join(output, 'artifacts', name, `attempt-${attempt}`), checks: ['public'] }),
            saveAttempt: async record => {
              const trial = record.candidate.trial;
              delivery.attempts.push({ ...trial, attempt: record.attempt, sourceSha256: record.sourceSha256,
                publicPassed: record.publicPassed, publicTestsPassed: record.publicTestsPassed, completed: record.completed, publicResult: record.publicResult });
              delivery.providerRequests.push(...trial.providerRequests); delivery.elapsedMs = Date.now() - started;
              save(); console.log(`${name}: attempt=${record.attempt}; public=${record.publicPassed}`);
            },
          });
          const source = fs.readFileSync(path.join(workspace, 'solution.cjs'), 'utf8');
          delivery.publicPassed = loop.publicPassed; delivery.repairStopReason = loop.reason;
          delivery.grade = evaluateCodeTask({ task, source, directory: path.join(output, 'artifacts', name, 'final') });
          // Run both holdouts only after the public-feedback loop has ended.
          // Neither hidden result nor its diagnostics can enter a model turn.
          const first = loop.attempts[0];
          delivery.firstAttemptGrade = evaluateCodeTask({ task, source: first.candidate.source,
            directory: path.join(output, 'artifacts', name, 'first-attempt-holdout') });
          delivery.firstAttemptPassed = first.completed && delivery.firstAttemptGrade.passed && first.candidate.source !== task.starter;
          delivery.firstAttemptElapsedMs = first.candidate.trial.elapsedMs;
          delivery.fixtureIntegrity = integrity(); delivery.elapsedMs = Date.now() - started;
          delivery.passed = loop.publicPassed && delivery.grade.passed && delivery.fixtureIntegrity && source !== task.starter;
          delivery.turnEndReason = delivery.attempts.at(-1)?.turnEndReason;
          delivery.toolNames = delivery.attempts.flatMap(attempt => attempt.toolNames);
          delivery.filePolicy = delivery.attempts.flatMap(attempt => attempt.filePolicy);
          assert.ok(delivery.providerRequests.filter(row => !row.blockedBeforeSend).every(row => row.usageComplete === true), 'Incomplete repair usage');
          save(); console.log(`${name}: final-hidden=${delivery.grade.checks.hidden.passed}; delivery=${delivery.passed}; attempts=${delivery.attempts.length}`);
          await sleep(3000); continue;
        }
        const prompt = 'Implement the software task in TASK.md. First read TASK.md, solution.cjs and public.test.cjs using file tools, then edit ONLY solution.cjs to satisfy the complete specification. Use CommonJS, no dependencies. Public tests are examples; unseen tests will grade edge cases. Do not change TASK.md/public.test.cjs or create any other file. Only file read/write/edit are permitted. Do NOT execute or test your code, use pwsh/shell, network, external services or delegation. After one successful write, STOP using tools and give a brief final description. The external evaluator runs all tests after your turn. You have at most six model requests to deliver.';
        const trial = await turn(sessionId, prompt, `${item.taskId}-r${item.round}-${item.preset}`);
        Object.assign(trial, item, { kind: 'real-code-hidden-tests' });
        const unchanged = ['TASK.md', 'public.test.cjs'].every(name => fs.readFileSync(path.join(workspace, name), 'utf8') === fixtures[name]);
        const files = fs.readdirSync(workspace);
        const source = fs.readFileSync(path.join(workspace, 'solution.cjs'), 'utf8');
        const grade = evaluateCodeTask({ task, source, directory: path.join(output, 'artifacts', trial.name) });
        trial.grade = grade; trial.fixtureIntegrity = unchanged && files.length === 3 && files.every(name => name in fixtures);
        trial.passed = grade.passed && trial.fixtureIntegrity && trial.turnEndReason.kind === 'completed' && source !== task.starter;
        save(); console.log(`${trial.name}: hidden=${grade.checks.hidden.passed}; delivery=${trial.passed}`);
        assert.ok(trial.providerRequests.some(row => !row.blockedBeforeSend));
        assert.ok(trial.providerRequests.filter(row => !row.blockedBeforeSend).every(row => row.usageComplete === true), 'Incomplete provider usage');
        assert.equal(trial.fixtureIntegrity, true, 'Task fixture modified outside allowed file');
        await sleep(3000);
      }
      receipt.ok = true;
      receipt.allDeliveriesPassed = receipt.trials.every(trial => trial.passed === true);
    } else if (switchArm) {
      // Every session confirms task-0f. Only the toggle arm closes Skills while idle between its two turns;
      // the second turn's request is the measured one. Which plugin build ran is the staged file hash, not the label.
      receipt.stagedSwitchSha256 = createHash('sha256').update(fs.readFileSync(path.join(runtime, 'profile-web/node_modules/@deepseek-harness/dsh-mathmodel/lib/task-tool-switches.js'))).digest('hex');
      const off = { skills: false, mcp: true, taskBoard: true, disabledMcpServers: [] };
      for (const [round, arms] of [[1, ['control', 'toggle']], [2, ['toggle', 'control']], [3, ['control', 'toggle']]]) {
        for (const arm of arms) {
          const sessionId = await create('task-0f'); await confirm(sessionId, 'task-0f');
          const first = await turn(sessionId, `${prefix}\nQuestion: ${questions[0].text}`, `${arm}-r${round}-turn1`, questions[0].answer);
          Object.assign(first, { arm, round, kind: 'before-switch' });
          if (arm === 'toggle') {
            let switched;
            for (let attempt = 0; !switched; attempt++) {
              try { switched = await client.rpc('mathmodelHostCapabilities', 'setTools', { sessionId, selection: off }); }
              catch (error) { if (attempt >= 20 || !/空闲|busy/.test(error.message)) throw error; await sleep(500); }
            }
            first.switchedToolCount = switched.toolCount; first.switchedSkillVisible = switched.effectiveToolNames.includes('skill');
          }
          await sleep(3000);
          const second = await turn(sessionId, `Question: ${questions[1].text}`, `${arm}-r${round}-turn2`, questions[1].answer);
          Object.assign(second, { arm, round, kind: 'after-switch' });
          for (const trial of [first, second]) {
            assert.equal(trial.turnEndReason.kind, 'completed'); assert.equal(trial.toolNames.length, 0, 'No-tool cache trial invoked a tool');
            const sent = trial.providerRequests.filter(row => !row.blockedBeforeSend);
            trial.skillOnWire = sent.some(row => row.toolNames.includes('skill'));
            trial.firstRequestHitRate = requestHitRate(sent[0]);
          }
          assert.equal(first.skillOnWire, true, 'task-0f did not offer the skill tool before the switch');
          console.log(`${arm}-r${round}: turn2 hit=${second.firstRequestHitRate}; skillOnWire=${second.skillOnWire}`);
          save(); await sleep(3000);
        }
      }
      const after = receipt.trials.filter(row => row.kind === 'after-switch');
      receipt.switchCacheSummary = Object.fromEntries(['control', 'toggle'].map(arm => {
        const rows = after.filter(row => row.arm === arm), rates = rows.map(row => row.firstRequestHitRate);
        return [arm, { rates, mean: rates.includes(null) ? null : rates.reduce((a, b) => a + b, 0) / rates.length,
          skillOnWire: rows.map(row => row.skillOnWire), passed: rows.map(row => row.passed) }];
      }));
      receipt.ok = true;
    } else {
      for (const preset of ['task-00', 'task-0f']) {
        for (const index of clarifyFormat ? [4] : [0, 1, 2, 3, 4]) {
          const question = questions[index < 3 ? 0 : index - 2];
          const sessionId = await create(preset); await confirm(sessionId, preset);
          const questionText = clarifyFormat ? 'Deduplicate [3,1,3,2,1,0] preserving first appearance. Return exactly one JSON object with a single property named "values" whose value is the resulting array: {"values":[...]}. Do not use a property named "answer".' : question.text;
          const trial = await turn(sessionId, `${prefix}\nQuestion: ${questionText}`, `${preset}-${clarifyFormat ? 'clarified-schema' : index < 3 ? `repeat-${index + 1}` : `tail-${index - 2}`}`, question.answer);
          trial.preset = preset; trial.kind = clarifyFormat ? 'clarified-schema-followup' : index === 0 ? 'observed-warmup' : index < 3 ? 'identical-repeat' : 'changed-tail'; trial.expected = question.answer; save();
          assert.equal(trial.turnEndReason.kind, 'completed'); assert.ok(trial.providerRequests.length > 0);
          if (trial.toolNames.length) throw new Error('No-tool quality trial unexpectedly invoked a tool');
          await sleep(3000);
        }
      }
      receipt.ok = true;
    }
    receipt.finishedAt = new Date().toISOString(); receipt.actualProviderRequests = audit().filter(row => !row.blockedBeforeSend).length; save();
    console.log(`Stage ${stage} completed; receipt: ${path.join(output, 'receipt.json')}`);
    return receipt;
  } catch (error) { receipt.ok = false; receipt.failure = error.message; save(); throw error; }
  finally {
    if (activeSession && child?.exitCode === null) { try { const client = await createInstalledHostClient({ logFile }); await client.rpc('session', 'cancel', { request: { sessionId: activeSession } }); } catch {} }
    if (child && child.exitCode === null) { child.kill(); await Promise.race([exited, sleep(10000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
    if (fs.existsSync(credentialFile)) fs.unlinkSync(credentialFile);
    if (fs.existsSync(auditFile)) fs.copyFileSync(auditFile, path.join(output, 'provider-audit.jsonl'));
    if (fs.existsSync(fileAuditFile)) fs.copyFileSync(fileAuditFile, path.join(output, 'file-policy-audit.jsonl'));
    receipt.allProviderRequests = audit();
    receipt.actualProviderRequests = receipt.allProviderRequests.filter(row => !row.blockedBeforeSend).length;
    receipt.temporaryCredentialRemoved = !fs.existsSync(credentialFile); save();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--run')) console.log('Explicit paid integration: node scripts/live-capability-benchmark.mjs --run --stage=2 (then --stage=3).');
  else await runLiveBenchmark({ stage: Number(process.argv.find(row => row.startsWith('--stage='))?.slice(8)), clarifyFormat: process.argv.includes('--clarify-format'), codeTasks: process.argv.includes('--code-tasks'), repairCheck: process.argv.includes('--repair-check'), switchArm: process.argv.find(row => row.startsWith('--switch-cache='))?.slice(15) });
}
