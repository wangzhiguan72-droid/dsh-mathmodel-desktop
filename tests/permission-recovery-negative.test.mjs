import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimeRoot = resolve(import.meta.dirname, '../resources/runtime/host/node_modules');
const runtimeRequire = createRequire(join(runtimeRoot, '__permission_negative__.cjs'));
const framework = name => import(pathToFileURL(runtimeRequire.resolve(name)).href);

test('managed preset pre-step rejects when the Host capability service is absent', async () => {
  const [{ Context }, { SystemPrompt }, { ToolRuntime }, { createScope }] = await Promise.all([
    framework('@deepseek-ai/cordis'), framework('@deepseek-ai/dsh-system-prompt'),
    framework('@deepseek-ai/dsh-tools'), framework('@deepseek-ai/dsh-scope'),
  ]);
  const source = readFileSync(resolve(import.meta.dirname, '../plugins/dsh-mathmodel/src/capabilities.js'), 'utf8')
    .replace("'@deepseek-ai/schemastery'", JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/schemastery')).href))
    .replace("'@deepseek-ai/dsh-scope'", JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-scope')).href));
  const capabilities = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const root = new Context();
  await root.plugin(SystemPrompt, {}); await root.plugin(ToolRuntime, { mode: 'native' });
  let ctx; await root.plugin({ inject: ['tools'], apply: value => { ctx = value; } });
  const scope = createScope(ctx, { id: 'managed-without-guard' });
  let entered = 0;
  try {
    capabilities.apply(scope.ctx, { images: true });
    const result = await scope.ctx.waterfall('agent/pre-step', {messages:[],turn:1,step:1,signal:new AbortController().signal},
      () => { entered++; return Promise.resolve({kind:'enter',messages:[]}); });
    assert.equal(result.kind, 'reject'); assert.equal(entered, 0);
  } finally { await scope.dispose(); await root.fiber.dispose(); }
});

test('capability replay rejects malformed or unsupported snapshots without producing accepted state', async () => {
  const { capabilityProjection } = await import('../plugins/dsh-mathmodel/src/host-capabilities.js');
  const valid = { schema: 1, preset: 'task-00', hostHash: 'h', globalToolsHash: 't', confirmedAt: 'now', inventory: [] };
  for (const data of [{ ...valid, schema: 2 }, { ...valid, hostHash: null }, { ...valid, inventory: {} }, {}]) {
    assert.throws(() => capabilityProjection.apply(null, { type: 'mathmodel/capabilities-confirmed', data }));
  }
  assert.deepEqual(capabilityProjection.apply(null, { type: 'mathmodel/capabilities-confirmed', data: valid }), valid);
});

// This is an in-memory Session boundary, not a claim about Host disk replay.
// It implements exactly the SDK methods used by ApprovalService and preserves
// an append-only event record for paired audit assertions.
function sessionFixture() {
  const events = [{ type: 'turn/start', data: { turn: 1 }, seq: 0 }];
  return {
    events,
    get seq() { return events.length; },
    eventAt(seq) { return events[seq]; },
    append(type, data) {
      const event = { type, data, seq: events.length };
      events.push(event);
      return event;
    },
  };
}

async function runtimeFixture() {
  const [{ Context }, { SystemPrompt }, { ToolRuntime }, { ApprovalService }, { createScope }] = await Promise.all([
    framework('@deepseek-ai/cordis'),
    framework('@deepseek-ai/dsh-system-prompt'),
    framework('@deepseek-ai/dsh-tools'),
    framework('@deepseek-ai/dsh-user-approval'),
    framework('@deepseek-ai/dsh-scope'),
  ]);
  const root = new Context();
  await root.plugin(SystemPrompt, {});
  await root.plugin(ToolRuntime, { mode: 'native' });
  await root.plugin(ApprovalService, { policy: 'ask' });
  let ctx;
  await root.plugin({ inject: ['tools', 'approval'], apply: child => { ctx = child; } });
  const agent = { id: 'permission-negative-agent', session: sessionFixture() };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  return { root, ctx, agent, scope };
}

test('real SDK approval and tool pipeline deny rejected, cancelled, unavailable, and never without body or paid callback', async t => {
  const cases = [
    { name: 'rejected', answer: () => 'rejected', outcome: 'rejected', answerCalls: 1 },
    { name: 'cancelled', answer: () => 'cancelled', outcome: 'cancelled', answerCalls: 1 },
    { name: 'unavailable-missing-answerer', outcome: 'unavailable', answerCalls: 0 },
    { name: 'unavailable-throwing-answerer', answer: () => { throw new Error('answerer offline'); }, outcome: 'unavailable', answerCalls: 1 },
    { name: 'never', answer: () => 'allowed-once', policy: 'never', outcome: 'rejected', answerCalls: 0 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = await runtimeFixture();
      const directory = mkdtempSync(join(tmpdir(), 'dsh-permission-negative-'));
      const sentinel = join(directory, 'must-not-exist.txt');
      let bodyCalls = 0, paidCalls = 0, answerCalls = 0, aroundCalls = 0;
      try {
        if (scenario.answer) fixture.ctx.on('approval/request', async () => {
          answerCalls += 1;
          return scenario.answer();
        });
        if (scenario.policy) fixture.agent.session.append('approval/policy', { policy: scenario.policy });
        fixture.ctx.on('tools/pre-execute', async (_exec, _next) => ({ kind: 'ask', reason: 'write requires approval' }));
        fixture.ctx.on('tools/execute', async (_exec, next) => {
          aroundCalls += 1;
          return next();
        });
        fixture.ctx.tools.register({
          name: 'sentinel_write', description: 'Count and write if dispatched',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
          execute: async () => {
            bodyCalls += 1;
            paidCalls += 1;
            writeFileSync(sentinel, 'executed');
            return { ok: true };
          },
        });
        const result = await fixture.ctx.tools.execute({
          callId: `negative-${scenario.name}`, name: 'sentinel_write', arguments: {},
          agent: fixture.agent, signal: new AbortController().signal,
        });
        assert.equal(result.isError, true);
        assert.equal(bodyCalls, 0);
        assert.equal(paidCalls, 0);
        assert.equal(aroundCalls, 0);
        assert.equal(existsSync(sentinel), false);
        assert.equal(answerCalls, scenario.answerCalls);
        const asked = fixture.agent.session.events.filter(event => event.type === 'approval/asked');
        const decided = fixture.agent.session.events.filter(event => event.type === 'approval/decided');
        assert.equal(asked.length, 1);
        assert.equal(decided.length, 1);
        assert.equal(decided[0].data.id, asked[0].data.id);
        assert.equal(decided[0].data.outcome, scenario.outcome);
      } finally {
        rmSync(directory, { recursive: true, force: true });
        await fixture.scope.dispose();
        await fixture.root.fiber.dispose();
      }
    });
  }
});

test('real SDK allowed-once positive control dispatches the exact requested tool', async () => {
  const fixture = await runtimeFixture();
  const directory = mkdtempSync(join(tmpdir(), 'dsh-permission-control-'));
  const sentinel = join(directory, 'granted.txt');
  let bodyCalls = 0;
  try {
    fixture.ctx.on('approval/request', async () => 'allowed-once');
    fixture.ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'one action' }));
    fixture.ctx.tools.register({
      name: 'sentinel_write', description: 'Write after grant',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => { bodyCalls += 1; writeFileSync(sentinel, 'granted'); return { ok: true }; },
    });
    const result = await fixture.ctx.tools.execute({
      callId: 'positive-control', name: 'sentinel_write', arguments: {},
      agent: fixture.agent, signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    assert.equal(bodyCalls, 1);
    assert.equal(existsSync(sentinel), true);
    assert.equal(fixture.agent.session.events.at(-1).data.outcome, 'allowed-once');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await fixture.scope.dispose();
    await fixture.root.fiber.dispose();
  }
});

test('real SDK rejects approval outside an open turn before either audit append', async () => {
  const fixture = await runtimeFixture();
  try {
    fixture.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const before = fixture.agent.session.seq;
    await assert.rejects(
      fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'sentinel_write' }),
      /outside an open turn/,
    );
    assert.equal(fixture.agent.session.seq, before);
  } finally {
    await fixture.scope.dispose();
    await fixture.root.fiber.dispose();
  }
});

test('real SDK maps an aborted approval signal to cancelled without invoking an answerer', async () => {
  const fixture = await runtimeFixture();
  let answerCalls = 0;
  try {
    fixture.ctx.on('approval/request', async () => { answerCalls += 1; return 'allowed-once'; });
    const controller = new AbortController();
    controller.abort();
    const outcome = await fixture.ctx.approval.request({
      agent: fixture.agent, toolName: 'sentinel_write', signal: controller.signal,
    });
    assert.equal(outcome, 'cancelled');
    assert.equal(answerCalls, 0);
    assert.deepEqual(
      fixture.agent.session.events.slice(-2).map(event => event.type),
      ['approval/asked', 'approval/decided'],
    );
    assert.equal(fixture.agent.session.events.at(-1).data.outcome, 'cancelled');
  } finally {
    await fixture.scope.dispose();
    await fixture.root.fiber.dispose();
  }
});

test('stored Auto permission identity fails closed before any recovery append when integration is absent', async () => {
  const [{ PermissionPresetService }] = await Promise.all([framework('@deepseek-ai/dsh-permission-presets')]);
  const session = sessionFixture();
  session.append('permission/preset', { preset: 'auto' });
  const before = session.seq;
  // Directly invoke the official recovery method with its folded state; this
  // tests the SDK admission guard, not Host session loading or disk replay.
  const receiver = {
    autoAdmit: undefined,
    permissionState: () => ({ preset: 'auto', sandbox: null, approval: null, seeded: true }),
  };
  assert.throws(
    () => PermissionPresetService.prototype.pinInitialPermission.call(receiver, session),
    /cannot restore preset "auto" without its active integration/,
  );
  assert.equal(session.seq, before);
});
