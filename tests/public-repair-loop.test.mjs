import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublicRepairLoop } from '../scripts/public-repair-loop.mjs';

const result = (passed, stderr = '') => ({ passed, checks: { public: { passed, stderr, stdout: '', status: passed ? 0 : 1 }, hidden: { stderr: 'HIDDEN-MUST-NOT-REACH-MODEL' } } });

test('failed public execution is returned to the next attempt, then success stops requests', async () => {
  const inputs = [], saved = [];
  const actual = await runPublicRepairLoop({ maxAttempts: 3,
    requestAttempt: async input => { inputs.push(input); return { source: input.attempt === 1 ? 'broken' : 'fixed' }; },
    verifyPublic: async ({ source }) => result(source === 'fixed', 'AssertionError: actual [] expected [[""]]'),
    saveAttempt: async attempt => { saved.push(attempt); },
  });
  assert.equal(inputs.length, 2); assert.equal(inputs[0].feedback, null);
  assert.match(inputs[1].feedback, /AssertionError/);
  assert.ok(!JSON.stringify(inputs).includes('HIDDEN-MUST-NOT-REACH-MODEL'));
  assert.equal(actual.publicPassed, true); assert.equal(actual.reason, 'public-passed');
  assert.equal(saved.length, 2); assert.equal(actual.attempts[0].publicResult.passed, false);
});

test('single successful public verification does not fabricate additional attempts', async () => {
  let called = 0;
  const actual = await runPublicRepairLoop({ requestAttempt: async () => ({ source: String(++called) }), verifyPublic: async () => result(true) });
  assert.equal(called, 1); assert.equal(actual.publicPassed, true);
});

test('a settled request-budget interruption is retained and cannot pass until a completed attempt', async () => {
  const inputs = [];
  const actual = await runPublicRepairLoop({
    requestAttempt: async input => { inputs.push(input); return { source: 'fixed', completed: input.attempt > 1, interruption: input.attempt === 1 ? 'request-budget' : null }; },
    verifyPublic: async () => result(true),
  });
  assert.equal(inputs.length, 2);
  assert.equal(actual.attempts[0].publicPassed, false);
  assert.equal(actual.attempts[0].publicTestsPassed, true);
  assert.match(inputs[1].feedback, /request budget/);
  assert.equal(actual.publicPassed, true);
});

test('repeated request-budget interruptions exhaust attempts without claiming verified delivery', async () => {
  const actual = await runPublicRepairLoop({ maxAttempts: 3,
    requestAttempt: async () => ({ source: 'same candidate', completed: false, interruption: 'request-budget' }),
    verifyPublic: async () => result(true),
  });
  assert.equal(actual.publicPassed, false);
  assert.equal(actual.reason, 'attempt-budget');
  assert.equal(actual.attempts.length, 3);
});

test('unchanged failing source stops after two interrupted attempts instead of consuming a third budget', async () => {
  const actual = await runPublicRepairLoop({ maxAttempts: 3,
    requestAttempt: async () => ({ source: 'unchanged broken candidate', completed: false, interruption: 'request-budget' }),
    verifyPublic: async () => result(false, 'still broken'),
  });
  assert.equal(actual.reason, 'no-progress');
  assert.equal(actual.attempts.length, 2);
  assert.equal(actual.publicPassed, false);
});

test('budget and unchanged failing source fail closed, retaining the failures', async () => {
  const budget = await runPublicRepairLoop({ maxAttempts: 2,
    requestAttempt: async ({ attempt }) => ({ source: `broken-${attempt}` }), verifyPublic: async () => result(false, 'still wrong') });
  assert.equal(budget.reason, 'attempt-budget'); assert.equal(budget.publicPassed, false); assert.equal(budget.attempts.length, 2);
  const unchanged = await runPublicRepairLoop({ maxAttempts: 3,
    requestAttempt: async () => ({ source: 'same broken code' }), verifyPublic: async () => result(false, 'still wrong') });
  assert.equal(unchanged.reason, 'no-progress'); assert.equal(unchanged.attempts.length, 2);
});

test('verification errors propagate instead of being turned into model success', async () => {
  await assert.rejects(runPublicRepairLoop({ requestAttempt: async () => ({ source: 'candidate' }), verifyPublic: async () => { throw new Error('evaluator unavailable'); } }), /evaluator unavailable/);
  await assert.rejects(runPublicRepairLoop({ requestAttempt: async () => { throw new Error('provider unavailable'); }, verifyPublic: async () => result(true) }), /provider unavailable/);
});

test('public diagnostic feedback is bounded and hidden-only success never passes', async () => {
  const inputs = [];
  const actual = await runPublicRepairLoop({ maxAttempts: 2,
    requestAttempt: async input => { inputs.push(input); return { source: String(input.attempt) }; },
    verifyPublic: async () => ({ passed: true, checks: { public: { passed: false, stderr: 'x'.repeat(20000), status: 1 }, hidden: { passed: true } } }),
  });
  assert.equal(actual.publicPassed, false); assert.ok(inputs[1].feedback.length <= 4200);
  await assert.rejects(runPublicRepairLoop({ maxAttempts: 0 }), /attempt/i);
});
