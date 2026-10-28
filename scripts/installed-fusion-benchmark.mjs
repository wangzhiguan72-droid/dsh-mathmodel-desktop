// Paired synthetic benchmark against the installed desktop Host.
// Import and --check are inert. Only the explicit --run flag creates sessions or calls models.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInstalledHostClient } from './installed-host-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist/fusion-installed-verification');
const baselineRoute = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' });
// The virtual route has no reasoning-effort field; its configured lead/worker pair is low.
const fusionRoute = Object.freeze({ provider: 'dsh-model-fusion', model: 'auto' });
const workerRoute = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' });
const waitMs = 2500;
const defaultTimeoutMs = 600000;

const spec = `import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarize } from './solution.mjs';
import transactions from './transactions.json' with { type: 'json' };

const expected = (items) => {
  const bySku = new Map();
  let grossCents = 0, refundCents = 0;
  for (const item of items) {
    if (!item || typeof item.sku !== 'string' || !item.sku ||
        !['sale', 'return'].includes(item.type) ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        !Number.isSafeInteger(item.unitCents) || item.unitCents < 0) {
      throw new TypeError('invalid transaction');
    }
    const cents = item.quantity * item.unitCents;
    if (!Number.isSafeInteger(cents)) throw new RangeError('amount overflow');
    const row = bySku.get(item.sku) ?? { sku: item.sku, sold: 0, returned: 0, netCents: 0 };
    if (item.type === 'sale') { row.sold += item.quantity; grossCents += cents; row.netCents += cents; }
    else { row.returned += item.quantity; refundCents += cents; row.netCents -= cents; }
    bySku.set(item.sku, row);
  }
  return { grossCents, refundCents, netCents: grossCents - refundCents,
    bySku: [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku, 'en')) };
};

test('matches the independent reference on fixture transactions', () => {
  assert.deepEqual(summarize(transactions), expected(transactions));
});
test('empty input is zero', () => assert.deepEqual(summarize([]), expected([])));
test('sale and return for one SKU remain separate counts', () => {
  const rows = [{ sku: 'A', type: 'sale', quantity: 3, unitCents: 119 },
    { sku: 'A', type: 'return', quantity: 1, unitCents: 119 }];
  assert.deepEqual(summarize(rows), expected(rows));
});
test('rejects malformed transactions', () => {
  for (const row of [null, {}, { sku: 'A', type: 'sale', quantity: 0, unitCents: 1 },
    { sku: 'A', type: 'sale', quantity: 1.5, unitCents: 1 },
    { sku: 'A', type: 'sale', quantity: 1, unitCents: -1 }]) {
    assert.throws(() => summarize([row]));
  }
});
test('CLI emits only the JSON summary', () => {
  const file = fileURLToPath(new URL('./solution.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [file, 'transactions.json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), expected(transactions));
});
`;

function transactionsFor(pair) {
  const skus = ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'OMEGA'];
  return Array.from({ length: 30 }, (_, index) => ({
    sku: skus[(index * 3 + pair) % skus.length],
    type: index % 7 === 0 ? 'return' : 'sale',
    quantity: (index * 5 + pair) % 4 + 1,
    unitCents: 119 + ((index * 17 + pair * 13) % 91),
  }));
}

function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function prepareFixture(base, pair, arm) {
  const cwd = path.join(base, `pair-${pair}-${arm}`);
  await fs.mkdir(cwd, { recursive: false });
  const input = `${JSON.stringify(transactionsFor(pair), null, 2)}\n`;
  await fs.writeFile(path.join(cwd, 'transactions.json'), input);
  await fs.writeFile(path.join(cwd, 'spec.test.mjs'), spec);
  await fs.writeFile(path.join(cwd, 'README.md'), 'Synthetic benchmark fixture. No user data.\n');
  execFileSync('git', ['init', '-q', cwd]);
  execFileSync('git', ['-C', cwd, 'add', 'transactions.json', 'spec.test.mjs', 'README.md']);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=DSH Benchmark', '-c', 'user.email=benchmark@localhost',
    'commit', '-q', '-m', 'Synthetic baseline fixture']);
  return { cwd, protectedHashes: { 'transactions.json': sha256(input), 'spec.test.mjs': sha256(spec) } };
}

const prompt = `Implement solution.mjs in this synthetic workspace. Export summarize(transactions) and support
\`node solution.mjs transactions.json\`, printing exactly one JSON object. Follow the output and validation
contract in spec.test.mjs. Do not change transactions.json, spec.test.mjs, or README.md. Run
\`node --test spec.test.mjs\` and report the real result. If Fusion delegation tools are available,
delegate implementation and its automated check to the Sidekick, then inspect its report and record
an accepting review only if the check and code justify it. Do not claim verification from a plan or
from a model statement alone. Keep all changes inside this synthetic workspace.`;

function usageFromEvents(events) {
  const usage = events.filter(event => event.type === 'assistant/message')
    .map(event => event.data?.usage).filter(Boolean);
  const sum = key => usage.reduce((total, item) => total + (Number.isFinite(item[key]) ? item[key] : 0), 0);
  return { reportedMessages: usage.length, inputTokens: sum('inputTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
    outputTokens: sum('outputTokens'), reasoningTokens: sum('reasoningTokens') };
}

async function sessionEvents(client, sessionId) {
  const projection = await client.rpc('session', 'projections', { request: { sessionId } });
  if (!projection?.asOfSeq) return [];
  const address = { kind: 'session', sessionId };
  const events = [];
  let beforeSeq;
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const page = await client.rpc('session', 'page', {
      request: { address, throughSeq: projection.asOfSeq, maxMessages: 250,
        ...(beforeSeq === undefined ? {} : { beforeSeq }) },
    });
    const rows = page?.records?.map(record => record.event).filter(Boolean) ?? [];
    events.push(...rows);
    if (!page?.hasMore || rows.length === 0) break;
    beforeSeq = Math.min(...rows.map(event => event.seq));
  }
  return [...new Map(events.map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
}

async function fusionStatus(client, sessionId) {
  const response = await client.request(`/api/model-fusion?view=status&sessionId=${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw new Error(`Fusion status HTTP ${response.status}`);
  return response.json();
}

async function waitForTurn(client, sessionId, arm, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latestEvents = [], latestStatus;
  while (Date.now() < deadline) {
    latestEvents = await sessionEvents(client, sessionId);
    const ended = latestEvents.findLast(event => event.type === 'turn/end');
    const pendingApproval = latestEvents.findLast(event => event.type === 'approval/asked' &&
      !latestEvents.some(decided => decided.type === 'approval/decided' && decided.data?.id === event.data?.id));
    if (pendingApproval && !ended) {
      return { events: latestEvents, status: latestStatus, timedOut: false,
        attention: true, pendingApproval: { id: pendingApproval.data?.id,
          toolName: pendingApproval.data?.toolName } };
    }
    if (arm === 'fusion') {
      latestStatus = await fusionStatus(client, sessionId);
      if (ended && (latestStatus?.task?.stage === '完成' || latestStatus?.task?.phase === 'COMPLETED')) {
        return { events: latestEvents, status: latestStatus, timedOut: false };
      }
      if (ended && latestStatus?.task?.attention) {
        return { events: latestEvents, status: latestStatus, timedOut: false, attention: true };
      }
    } else if (ended) return { events: latestEvents, timedOut: false };
    await sleep(waitMs);
  }
  return { events: latestEvents, status: latestStatus, timedOut: true };
}

async function evaluateFixture(fixture) {
  const protectedFilesUnchanged = await Promise.all(Object.entries(fixture.protectedHashes)
    .map(async ([name, digest]) => fs.readFile(path.join(fixture.cwd, name))
      .then(content => sha256(content) === digest, () => false)));
  const solutionPresent = await fs.stat(path.join(fixture.cwd, 'solution.mjs')).then(s => s.isFile(), () => false);
  let exitCode = null, testOutput = '';
  if (solutionPresent) {
    try {
      testOutput = execFileSync(process.execPath, ['--test', 'spec.test.mjs'], {
        cwd: fixture.cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 2_000_000,
      });
      exitCode = 0;
    } catch (error) {
      exitCode = typeof error.status === 'number' ? error.status : -1;
      testOutput = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    }
  }
  return { solutionPresent, protectedFilesUnchanged: protectedFilesUnchanged.every(Boolean),
    testExitCode: exitCode, passed: solutionPresent && protectedFilesUnchanged.every(Boolean) && exitCode === 0,
    testSummary: [...testOutput.matchAll(/^(?:#|ℹ) (?:tests|pass|fail) \d+\r?$/gm)]
      .map(match => match[0].trimEnd()) };
}

function verifiedFusion(task, events, fixturePassed, turnCompleted) {
  return fixturePassed && turnCompleted && task?.stage === '完成' &&
    task?.verification === 'verified' && Boolean(task?.workerId) && task?.automatedChecks > 0 &&
    events.some(e => e.type === 'tool/call' && e.data?.name === 'fusion_delegate') &&
    events.some(e => e.type === 'tool/call' && e.data?.name === 'fusion_review_result');
}

async function runArm(client, fixture, arm, timeoutMs, progress) {
  const selection = arm === 'baseline' ? baselineRoute : fusionRoute;
  const created = await client.rpc('session', 'create', { request: { cwd: fixture.cwd } });
  if (typeof created?.sessionId !== 'string') throw new Error('Session create did not return an id');
  const sessionId = created.sessionId;
  await progress({ status: 'session-created', sessionId });
  const list = await client.rpc('session', 'list', { _request: {} });
  const actualSession = (Array.isArray(list) ? list : list?.items)?.find(entry => entry.sessionId === sessionId);
  const actualCwd = actualSession?.cwd;
  if (typeof actualCwd !== 'string' || path.resolve(actualCwd).toLowerCase() !==
      path.resolve(fixture.cwd).toLowerCase()) {
    throw new Error(`Session cwd mismatch for ${arm}: ${actualCwd ?? 'unavailable'}`);
  }
  await progress({ status: 'cwd-confirmed', sessionId, actualCwd });
  const permission = await client.rpc('commands', 'execute', {
    agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [],
  });
  if (permission?.result?.kind !== 'success') {
    throw new Error(`Full permission was not accepted for ${arm}: ${permission?.result?.text ?? 'unknown'}`);
  }
  const projection = await client.rpc('session', 'projections', { request: { sessionId } });
  if (projection?.values?.permissions?.currentValue !== 'danger-full-access') {
    throw new Error(`Full permission was not confirmed for ${arm}`);
  }
  await progress({ status: 'permission-confirmed', sessionId, permissionPreset: 'danger-full-access' });
  const selected = await client.rpc('session', 'selectModel', { request: { sessionId, ...selection } });
  if (selected?.selected?.provider !== selection.provider || selected.selected.model !== selection.model) {
    throw new Error(`Model selection did not confirm ${arm}`);
  }
  await progress({ status: 'model-selected', sessionId });
  const start = Date.now();
  const requestId = randomUUID();
  let accepted;
  try {
    accepted = await client.rpc('session', 'prompt', {
      request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }],
        clientTimeZone: 'Asia/Shanghai' },
    });
  } catch (error) {
    // A transport error can occur after the Host accepted the prompt.
    await client.rpc('session', 'cancel', { request: { sessionId } }).catch(() => {});
    throw error;
  }
  if (accepted?.accepted !== true) throw new Error(`Prompt was not accepted for ${arm}`);
  await progress({ status: 'prompt-accepted', sessionId, requestId });
  const settled = await waitForTurn(client, sessionId, arm, timeoutMs);
  let cancellation = null;
  if (settled.timedOut || settled.attention) {
    try {
      const cancelled = await client.rpc('session', 'cancel', { request: { sessionId } });
      cancellation = { attempted: true, accepted: cancelled?.accepted === true };
    } catch (error) {
      cancellation = { attempted: true, accepted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const end = Date.now();
  await progress({ status: 'turn-settled', sessionId, timedOut: settled.timedOut,
    cancellation, attention: settled.attention ?? false,
    pendingApproval: settled.pendingApproval ?? null });
  const events = settled.events;
  const turnEnd = events.findLast(event => event.type === 'turn/end');
  const fixtureResult = await evaluateFixture(fixture);
  const task = settled.status?.task;
  const delegationObserved = events.some(e => e.type === 'tool/call' && e.data?.name === 'fusion_delegate');
  const acceptingReviewObserved = events.some(e => e.type === 'tool/call' && e.data?.name === 'fusion_review_result');
  return {
    arm, sessionId, model: selection, startedAt: new Date(start).toISOString(),
    elapsedMs: end - start, timedOut: settled.timedOut, cancellation,
    attention: settled.attention ?? false, pendingApproval: settled.pendingApproval ?? null,
    turnEndReason: turnEnd?.data?.reason ?? null,
    turnCompleted: turnEnd?.data?.reason?.kind === 'completed',
    eventTimes: { turnStart: events.find(e => e.type === 'turn/start')?.time ?? null,
      turnEnd: turnEnd?.time ?? null },
    sessionUsage: usageFromEvents(events),
    toolNames: [...new Set(events.filter(e => e.type === 'tool/call').map(e => e.data?.name).filter(Boolean))],
    fixture: fixtureResult,
    ...(arm === 'fusion' ? { fusion: {
      selected: settled.status?.selected ?? false, taskId: task?.id ?? null,
      phase: task?.phase ?? (task?.stage === '完成' ? 'COMPLETED (from status stage)' : null),
      stage: task?.stage ?? null, verification: task?.verification ?? null,
      workerId: task?.workerId ?? null, automatedChecks: task?.automatedChecks ?? null,
      byRole: task?.usage?.byRole ?? null, usage: task?.usage ?? null,
      delegationObserved, acceptingReviewObserved,
      verifiedQuality: verifiedFusion(task, events, fixtureResult.passed,
        turnEnd?.data?.reason?.kind === 'completed'),
    } } : {}),
  };
}

function comparison(pairs) {
  return pairs.map(({ pair, arms }) => {
    const baseline = arms.find(arm => arm.arm === 'baseline');
    const fusion = arms.find(arm => arm.arm === 'fusion');
    const bothCompleted = baseline?.fixture?.passed === true && baseline?.turnCompleted === true &&
      fusion?.fusion?.verifiedQuality === true &&
      !baseline.timedOut && !fusion.timedOut;
    return { pair, bothCompleted,
      baselineMs: baseline?.elapsedMs ?? null, fusionMs: fusion?.elapsedMs ?? null,
      // Positive delta means Fusion took longer. Incomplete samples have no speed claim.
      ...(bothCompleted ? { deltaMs: fusion.elapsedMs - baseline.elapsedMs,
        deltaPercent: Number(((fusion.elapsedMs / baseline.elapsedMs - 1) * 100).toFixed(2)) } : {}),
    };
  });
}

async function preflight(client) {
  const settingsResponse = await client.request('/api/model-fusion?view=settings');
  if (!settingsResponse.ok) throw new Error(`Fusion settings HTTP ${settingsResponse.status}`);
  const settings = await settingsResponse.json();
  if (!settings.authorized || settings.pair?.lead?.provider !== baselineRoute.provider ||
      settings.pair?.lead?.model !== baselineRoute.model ||
      settings.pair?.lead?.reasoningEffort !== 'low' ||
      settings.pair?.worker?.provider !== workerRoute.provider ||
      settings.pair?.worker?.model !== workerRoute.model ||
      settings.pair?.worker?.reasoningEffort !== 'low') {
    throw new Error('Installed Fusion is not authorized with the requested pro/flash model pair');
  }
  return { pair: settings.pair, revision: settings.revision };
}

async function resumeCompletedFirstPair(client, result) {
  if (result?.syntheticOnly !== true || result.pairs?.length !== 1 ||
      result.pairs[0]?.pair !== 1 || result.pairs[0]?.arms?.length !== 2 ||
      result.stoppedEarly?.pair !== 1 || result.stoppedEarly?.arm !== 'fusion' ||
      result.stoppedEarly?.reason !== 'quality gate did not pass') {
    throw new Error('Receipt is not the known first-pair status-stage correction');
  }
  const baseline = result.pairs[0].arms[0];
  const fusion = result.pairs[0].arms[1];
  if (baseline.arm !== 'baseline' || !baseline.turnCompleted || !baseline.fixture?.passed ||
      fusion.arm !== 'fusion' || !fusion.turnCompleted || !fusion.fixture?.passed ||
      !fusion.sessionId || fusion.fusion?.verifiedQuality !== false) {
    throw new Error('First-pair evidence is incomplete');
  }
  const sessions = await client.rpc('session', 'list', { _request: {} });
  const entry = (Array.isArray(sessions) ? sessions : sessions?.items)
    ?.find(item => item.sessionId === fusion.sessionId);
  if (!entry || entry.running) throw new Error('Fusion session is absent or still running');
  const status = await fusionStatus(client, fusion.sessionId);
  const events = await sessionEvents(client, fusion.sessionId);
  if (!verifiedFusion(status.task, events, fusion.fixture.passed, fusion.turnCompleted)) {
    throw new Error('Live first-pair Fusion evidence does not pass the corrected quality gate');
  }
  fusion.fusion.stage = status.task.stage;
  fusion.fusion.phase = 'COMPLETED (from status stage)';
  fusion.fusion.verifiedQuality = true;
  result.corrections = [...(result.corrections ?? []), {
    at: new Date().toISOString(), pair: 1, arm: 'fusion',
    reason: 'Public status exposes stage=完成 rather than internal task.phase; rechecked live events and status',
  }];
  delete result.stoppedEarly;
}

async function main(argv) {
  if (!argv.includes('--run')) {
    console.log('Prepared benchmark script. Pass --run only after the other live desktop checks finish.');
    return;
  }
  const timeoutFlag = argv.indexOf('--timeout-ms');
  const timeoutMs = timeoutFlag < 0 ? defaultTimeoutMs : Number(argv[timeoutFlag + 1]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 1200000) {
    throw new Error('--timeout-ms must be an integer from 30000 to 1200000');
  }
  const resumeIndex = argv.indexOf('--resume');
  const resumePath = resumeIndex < 0 ? null : path.resolve(argv[resumeIndex + 1] ?? '');
  if (resumePath && path.dirname(resumePath).toLowerCase() !== root.toLowerCase()) {
    throw new Error('Resume receipt must be inside the benchmark evidence directory');
  }
  const id = resumePath ? null : randomUUID();
  const receipt = resumePath ?? path.join(root, `installed-fusion-benchmark-${id}.json`);
  const result = resumePath ? JSON.parse(await fs.readFile(receipt, 'utf8')) : {
    schemaVersion: 1, id, startedAt: new Date().toISOString(),
    syntheticOnly: true, timeoutMs, baselineRoute, fusionRoute, workerRoute,
    workspaces: path.join(root, `benchmark-${id}`), pairs: [], restoration: { attempted: false },
  };
  const workspaces = result.workspaces;
  if (resumePath && (path.resolve(workspaces).toLowerCase() !==
      path.join(root, `benchmark-${result.id}`).toLowerCase() ||
      path.basename(receipt) !== `installed-fusion-benchmark-${result.id}.json`)) {
    throw new Error('Resume receipt and workspace identities do not match');
  }
  const save = () => fs.writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`);
  if (!resumePath) {
    await fs.mkdir(workspaces, { recursive: true });
    await save();
  }
  let client, originalDefault;
  try {
    client = await createInstalledHostClient();
    const catalog = await client.rpc('session', 'modelCatalog', {});
    originalDefault = catalog?.default;
    if (!originalDefault?.provider || !originalDefault?.model) {
      throw new Error('Installed Host did not report its original default model');
    }
    result.originalDefault = originalDefault;
    if (resumePath) await resumeCompletedFirstPair(client, result);
    await save();
    const preflightResult = await preflight(client); // Read-only: do not configure Fusion here.
    result.fusionRevision = preflightResult.revision;
    await save();
    let stoppedEarly = false;
    for (let pair = result.pairs.length + 1; pair <= 3; pair++) {
      const row = { pair, arms: [] };
      result.pairs.push(row);
      await save();
      for (const arm of ['baseline', 'fusion']) {
        const armIndex = row.arms.push({ arm, status: 'preparing-fixture' }) - 1;
        await save();
        try {
          const fixture = await prepareFixture(workspaces, pair, arm);
          row.arms[armIndex] = { arm, status: 'fixture-ready', workspace: fixture.cwd };
          await save();
          row.arms[armIndex] = await runArm(client, fixture, arm, timeoutMs, async update => {
            row.arms[armIndex] = { ...row.arms[armIndex], ...update };
            await save();
          });
        } catch (error) {
          const prior = row.arms[armIndex];
          if (prior?.sessionId && prior.status === 'prompt-accepted') {
            try {
              const cancelled = await client.rpc('session', 'cancel', { request: { sessionId: prior.sessionId } });
              prior.cancellation = { attempted: true, accepted: cancelled?.accepted === true };
            } catch (cancelError) {
              prior.cancellation = { attempted: true, accepted: false,
                error: cancelError instanceof Error ? cancelError.message : String(cancelError) };
            }
          }
          row.arms[armIndex] = { ...prior, status: 'error',
            error: error instanceof Error ? error.message : String(error) };
        }
        await save();
        const latest = row.arms.at(-1);
        if (latest.error || latest.timedOut || latest.attention || !latest.turnCompleted ||
            (arm === 'fusion' && !latest.fusion?.verifiedQuality)) {
          result.stoppedEarly = { pair, arm, reason: latest.error ??
            (latest.timedOut ? 'timeout; cancellation requested' :
              (latest.attention ? 'session needs attention' : 'quality gate did not pass')) };
          stoppedEarly = true;
          break;
        }
      }
      if (stoppedEarly) break;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    if (client && originalDefault) {
      result.restoration = { attempted: true, requested: originalDefault };
      try {
        const created = await client.rpc('session', 'create', { request: { cwd: workspaces } });
        if (typeof created?.sessionId !== 'string') throw new Error('Restoration session create did not return an id');
        result.restoration.sessionId = created.sessionId;
        const response = await client.rpc('session', 'selectModel', {
          request: { sessionId: created.sessionId, ...originalDefault },
        });
        let actual;
        for (let attempt = 0; attempt < 20; attempt++) {
          actual = (await client.rpc('session', 'modelCatalog', {}))?.default;
          if (actual?.provider === originalDefault.provider && actual?.model === originalDefault.model &&
              (actual?.reasoningEffort ?? null) === (originalDefault.reasoningEffort ?? null)) break;
          await sleep(250); // selectModel saves the global default asynchronously.
        }
        result.restoration.actualDefault = actual ?? null;
        result.restoration.confirmed = response?.selected?.provider === originalDefault.provider &&
          response?.selected?.model === originalDefault.model &&
          (response?.selected?.reasoningEffort ?? null) === (originalDefault.reasoningEffort ?? null) &&
          actual?.provider === originalDefault.provider && actual?.model === originalDefault.model &&
          (actual?.reasoningEffort ?? null) === (originalDefault.reasoningEffort ?? null);
        if (!result.restoration.confirmed) process.exitCode = 1;
      } catch (error) {
        result.restoration.confirmed = false;
        result.restoration.error = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
      }
    } else {
      result.restoration.reason = 'Original default was unavailable before any benchmark model selection';
    }
    result.finishedAt = new Date().toISOString();
    result.comparison = comparison(result.pairs);
    if (result.stoppedEarly || result.pairs.some(pair => pair.arms.some(arm => arm.cancellation?.accepted === false))) {
      process.exitCode = 1;
    }
    await save();
  }
  console.log(JSON.stringify({ receipt, restoration: result.restoration, error: result.error ?? null,
    pairs: result.pairs.map(pair => pair.arms.map(arm => ({
    arm: arm.arm, elapsedMs: arm.elapsedMs ?? null, fixturePassed: arm.fixture?.passed ?? false,
    fusionVerified: arm.fusion?.verifiedQuality ?? null, error: arm.error ?? null,
  }))) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

export { transactionsFor, usageFromEvents, prepareFixture, evaluateFixture, comparison };
