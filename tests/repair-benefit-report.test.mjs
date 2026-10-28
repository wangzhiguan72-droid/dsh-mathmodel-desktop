import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarizeRepairBenefit } from '../scripts/repair-benefit-report.mjs';

const request = (index, extra = {}) => ({ index, auditVersion: 2, terminalStopObserved: true,
  responseModel: 'deepseek-flash', startedAt: '2026-10-15T15:00:00Z', httpStatus: 200,
  usageComplete: true, rawUsage: { input_tokens: 1000, cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 0, output_tokens: 100 }, ...extra });
const delivery = (name, firstAttemptPassed, passed, more = {}) => {
  const first = request(name * 10 + 1), second = request(name * 10 + 2);
  return { name: `delivery-${name}`, taskId: name % 2 ? 'csv' : 'json', preset: name % 2 ? 'task-00' : 'task-0f',
    firstAttemptGrade: { passed: firstAttemptPassed }, firstAttemptPassed, firstAttemptElapsedMs: 100,
    passed, elapsedMs: 250, attempts: [{ completed: true, providerRequests: [first], elapsedMs: 100 },
      { completed: true, providerRequests: [second], elapsedMs: 100 }], providerRequests: [first, second], ...more };
};
const receipt = trials => ({ protocol: 'code-public-verified-repair-v6', ok: true,
  schedule: trials.map((_, index) => index), trials,
  allProviderRequests: trials.flatMap(trial => trial.providerRequests) });

test('compares first source with final source using every paid repair request', () => {
  const result = summarizeRepairBenefit(receipt([delivery(1, false, true), delivery(2, true, false)]));
  assert.equal(result.completeProtocol, true);
  assert.deepEqual(result.firstAttempt, { samples: 2, correct: 1, requests: 2, costCny: .00288,
    perCorrectCostCny: .00288, meanLatencyMs: 100 });
  assert.deepEqual(result.repaired, { samples: 2, correct: 1, requests: 4, costCny: .00576,
    perCorrectCostCny: .00576, meanLatencyMs: 250 });
  assert.deepEqual(result.incremental, { requests: 2, costCny: .00288, meanLatencyMs: 150 });
  assert.deepEqual(result.paired, { rescued: 1, regressed: 1, bothCorrect: 0, bothWrong: 0 });
  assert.equal(result.trials[0].firstAttempt.requests, 1);
  assert.equal(result.trials[0].repaired.requests, 2);
  assert.match(result.limitations.join(' '), /two independent task types/i);
});

test('failed and unpriced deliveries stay in denominators; blocked requests have no price', () => {
  const bad = delivery(1, false, false, { attempts: [{ providerRequests: [request(1, { responseModel: null }),
    request(2, { blockedBeforeSend: true })], elapsedMs: 100 }],
    providerRequests: [request(1, { responseModel: null }), request(2, { blockedBeforeSend: true })] });
  const result = summarizeRepairBenefit(receipt([bad]));
  assert.equal(result.firstAttempt.samples, 1);
  assert.equal(result.firstAttempt.correct, 0);
  assert.equal(result.firstAttempt.requests, 1);
  assert.equal(result.firstAttempt.costCny, null);
  assert.equal(result.repaired.costCny, null);
  assert.equal(result.incremental.costCny, null);
  assert.equal(result.trials[0].blockedRequests, 1);
});

test('rejects missing first-source fields rather than inferring from public tests', () => {
  for (const key of ['firstAttemptGrade', 'firstAttemptPassed', 'firstAttemptElapsedMs']) {
    const trial = delivery(1, false, true); delete trial[key];
    assert.throws(() => summarizeRepairBenefit(receipt([trial])), new RegExp(key));
  }
});

test('interrupted receipt is explicitly incomplete and has no benefit conclusion', () => {
  const result = summarizeRepairBenefit({ ...receipt([delivery(1, false, true)]), ok: false });
  assert.equal(result.completeProtocol, false);
  assert.equal(result.benefitConclusion, null);
  assert.match(result.limitations.join(' '), /incomplete/i);
});

test('unassigned paid requests are disclosed in total observed spend', () => {
  const run = { ...receipt([delivery(1, false, true)]), ok: false };
  run.allProviderRequests = [...run.trials[0].providerRequests, request(99), request(100, { blockedBeforeSend: true })];
  const result = summarizeRepairBenefit(run);
  assert.equal(result.unassignedProviderRequests, 1);
  assert.equal(result.unassignedCostCny, .00144);
  assert.equal(result.totalObservedCostCny, .00432);
});

test('complete comparison requires full audit with each sent index assigned once', () => {
  const absent = receipt([delivery(1, false, true)]); delete absent.allProviderRequests;
  assert.throws(() => summarizeRepairBenefit(absent), /allProviderRequests/);
  const missing = receipt([delivery(1, false, true)]); missing.allProviderRequests.pop();
  assert.throws(() => summarizeRepairBenefit(missing), /audit|unmatched/i);
  const duplicate = receipt([delivery(1, false, true)]);
  duplicate.trials[0].providerRequests.push(duplicate.trials[0].providerRequests[0]);
  assert.throws(() => summarizeRepairBenefit(duplicate), /duplicate.*index/i);
  const duplicatedAudit = receipt([delivery(1, false, true)]);
  duplicatedAudit.allProviderRequests.push(duplicatedAudit.allProviderRequests[0]);
  assert.throws(() => summarizeRepairBenefit(duplicatedAudit), /duplicate.*index/i);
  const orphan = receipt([delivery(1, false, true)]); orphan.allProviderRequests.push(request(99));
  assert.throws(() => summarizeRepairBenefit(orphan), /unassigned/i);
});

test('rejects altered records and attempts that do not partition delivery requests in order', () => {
  const changed = receipt([delivery(1, false, true)]);
  changed.allProviderRequests[0] = { ...changed.allProviderRequests[0], responseModel: 'deepseek-pro' };
  assert.throws(() => summarizeRepairBenefit(changed), /mismatch/i);
  const repeated = receipt([delivery(1, false, true)]);
  repeated.trials[0].attempts[1].providerRequests = [repeated.trials[0].attempts[0].providerRequests[0]];
  assert.throws(() => summarizeRepairBenefit(repeated), /attempt|duplicate/i);
  const skippedFirst = receipt([delivery(1, false, true)]);
  skippedFirst.trials[0].attempts[0].providerRequests = [skippedFirst.trials[0].providerRequests[1]];
  assert.throws(() => summarizeRepairBenefit(skippedFirst), /attempt|prefix/i);
});

test('CLI writes repair-benefit.json beside receipt', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'repair-benefit-'));
  try {
    const filename = path.join(directory, 'receipt.json'); writeFileSync(filename, JSON.stringify(receipt([delivery(1, false, true)])));
    const run = spawnSync(process.execPath, ['scripts/repair-benefit-report.mjs', filename], { cwd: path.resolve(''), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'repair-benefit.json'))).paired.rescued, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
