import test from 'node:test';
import assert from 'node:assert/strict';
import { measureProviderRecord, pricesFor, summarizeReceipt } from '../scripts/deepseek-benchmark-report.mjs';
const record = { auditVersion: 2, terminalStopObserved: true, responseModel: 'deepseek-flash', startedAt: '2026-10-15T15:00:00Z', httpStatus: 200, usageComplete: true,
  rawUsage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 100 } };
test('price actual response model at observed off-peak time without double counting cache', () => {
  const measured = measureProviderRecord(record);
  assert.equal(measured.estimatedCny, .00144); assert.equal(measured.hitRate, 2 / 3);
  assert.equal(measureProviderRecord({ ...record, responseModel: null }).estimatedCny, null);
  assert.equal(measureProviderRecord({ ...record, rawUsage: { input_tokens: 1 } }).estimatedCny, null);
  assert.equal(measureProviderRecord({ ...record, usageComplete: undefined }).estimatedCny, null);
  assert.equal(measureProviderRecord({ ...record, terminalStopObserved: undefined }).estimatedCny, null);
});
test('unverified holiday status inside a possible peak window yields a range', () => {
  const sample = { ...record, startedAt: '2026-10-15T02:00:00Z' };
  assert.equal(pricesFor(sample).selected, null);
  assert.deepEqual(measureProviderRecord(sample).estimatedCnyRange, [.00144, .00288]);
});
test('unknown costs and failed quality are retained in the arm denominator', () => {
  const result = summarizeReceipt({ stage: 3, ok: true, trials: [
    { name: 'a', preset: 'task-00', passed: true, elapsedMs: 100, providerRequests: [record] },
    { name: 'b', preset: 'task-00', passed: false, elapsedMs: 200, providerRequests: [{ ...record, responseModel: null }] },
  ] });
  assert.equal(result.arms[0].samples, 2); assert.equal(result.arms[0].correct, 1);
  assert.equal(result.estimatedTotalCny, null); assert.equal(result.arms[0].estimatedCnyPerCorrect, null);
  const legacy = summarizeReceipt({ stage: 3, trials: [{ name: 'legacy', preset: 'task-00', passed: true,
    elapsedMs: 100, providerRequests: [{ ...record, usageComplete: undefined }] }] });
  assert.equal(legacy.arms[0].weightedHitRate, null);
  assert.equal(legacy.arms[0].promptTokens, null);
});

test('code crossover report preserves paired failures and within-pair differences', () => {
  const rows = ['task-00', 'task-0f'].map((preset, i) => ({ name: preset, preset, taskId: 'csv', round: 1, pair: 1,
    position: i + 1, passed: i === 0, elapsedMs: 100 + i * 30, providerRequests: [record] }));
  const result = summarizeReceipt({ stage: 3, protocol: 'code-randomized-crossover-v1', trials: rows });
  assert.equal(result.pairs[0].complete, true); assert.equal(result.pairs[0].basePassed, true);
  assert.equal(result.pairs[0].fullPassed, false); assert.equal(result.pairs[0].fullMinusBaseCny, 0);
  assert.equal(result.pairs[0].fullMinusBaseMs, 30);
  assert.match(result.limitations[0], /Four generated software tasks/);
});

test('failed turn requests omitted from trial rows still contribute to total cost', () => {
  const sample = { ...record, index: 1 };
  const result = summarizeReceipt({ stage: 3, trials: [{ name: 'done', elapsedMs: 1, providerRequests: [sample] }] },
    [sample, { ...record, index: 2 }, { blockedBeforeSend: true }]);
  assert.equal(result.unassignedProviderRequests.length, 1);
  assert.equal(result.estimatedTotalCny, .00288);
});

test('bounded repair keeps failed attempts, final hidden failures, and every request cost', () => {
  const requests = [1, 2, 3].map(index => ({ ...record, index }));
  const result = summarizeReceipt({ stage: 3, ok: true, protocol: 'code-public-verified-repair-v5',
    schedule: [1], trials: [{ name: 'repair', preset: 'task-00', taskId: 'csv', elapsedMs: 300,
      passed: false, publicPassed: true, repairStopReason: 'public-passed',
      attempts: [{ publicPassed: false }, { publicPassed: true }],
      grade: { checks: { hidden: { passed: false } } }, providerRequests: requests }] });
  const trial = result.trials[0];
  assert.equal(trial.attemptCount, 2);
  assert.equal(trial.firstAttemptPublicPassed, false);
  assert.equal(trial.publicPassed, true);
  assert.equal(trial.hiddenPassed, false);
  assert.equal(trial.passed, false);
  assert.equal(trial.requests, 3);
  assert.ok(Math.abs(result.estimatedTotalCny - .00432) < 1e-12);
  assert.equal(result.arms[0].correct, 0);
  assert.match(result.limitations[0], /never pooled/);
  assert.match(result.limitations[1], /Fixed arm order/);
});
