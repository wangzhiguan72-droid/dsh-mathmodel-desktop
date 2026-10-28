import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { measureProviderRecord } from './deepseek-benchmark-report.mjs';

function requireDelivery(trial, index) {
  const label = `trials[${index}]`;
  if (!trial || typeof trial !== 'object') throw new Error(`${label} must be a delivery`);
  if (!trial.firstAttemptGrade || typeof trial.firstAttemptGrade.passed !== 'boolean') throw new Error(`${label}.firstAttemptGrade.passed is required`);
  for (const field of ['firstAttemptPassed', 'passed']) {
    if (typeof trial[field] !== 'boolean') throw new Error(`${label}.${field} must be boolean`);
  }
  for (const field of ['firstAttemptElapsedMs', 'elapsedMs']) {
    if (!Number.isFinite(trial[field]) || trial[field] < 0) throw new Error(`${label}.${field} must be nonnegative milliseconds`);
  }
  if (!Array.isArray(trial.attempts) || !trial.attempts.length || !Array.isArray(trial.attempts[0].providerRequests)) {
    throw new Error(`${label}.attempts[0].providerRequests is required`);
  }
  if (!Array.isArray(trial.providerRequests)) throw new Error(`${label}.providerRequests is required`);
}

function priceRequests(requests) {
  const paid = requests.filter(row => !row.blockedBeforeSend);
  const prices = paid.map(measureProviderRecord);
  return { requests: paid.length,
    costCny: prices.every(row => row.estimatedCny !== null) ? prices.reduce((sum, row) => sum + row.estimatedCny, 0) : null,
    unknownCostRequests: prices.filter(row => row.estimatedCny === null).length,
    blockedRequests: requests.length - paid.length };
}

function sentByIndex(requests, label) {
  const indexed = new Map();
  for (const record of requests.filter(row => !row.blockedBeforeSend)) {
    if (!Number.isSafeInteger(record.index) || record.index < 0) throw new Error(`${label}: sent request has no valid index`);
    if (indexed.has(record.index)) throw new Error(`${label}: duplicate sent index ${record.index}`);
    indexed.set(record.index, record);
  }
  return indexed;
}

function verifyAttribution(receipt) {
  if (!Array.isArray(receipt.allProviderRequests)) {
    if (receipt.ok === true) throw new Error('Complete repair comparison requires allProviderRequests audit');
    return null;
  }
  const audit = sentByIndex(receipt.allProviderRequests, 'allProviderRequests audit');
  const assigned = new Map();
  for (const [number, trial] of receipt.trials.entries()) {
    const label = `trials[${number}]`, trialRequests = sentByIndex(trial.providerRequests, label);
    const attemptRequests = [];
    for (const [attempt, row] of trial.attempts.entries()) {
      if (!Array.isArray(row.providerRequests)) throw new Error(`${label}.attempts[${attempt}].providerRequests is required`);
      attemptRequests.push(...row.providerRequests.filter(record => !record.blockedBeforeSend));
    }
    const attemptMap = sentByIndex(attemptRequests, `${label} attempts`);
    const deliveryRecords = [...trialRequests.values()];
    if (attemptRequests.length !== deliveryRecords.length || attemptRequests.some((record, index) =>
      record.index !== deliveryRecords[index].index || !isDeepStrictEqual(record, deliveryRecords[index]))) {
      throw new Error(`${label}: attempts do not partition delivery requests in order; first attempt must be a prefix`);
    }
    if (attemptMap.size !== trialRequests.size) throw new Error(`${label}: attempt request count mismatch`);
    for (const [index, record] of trialRequests) {
      if (assigned.has(index)) throw new Error(`${label}: duplicate assigned sent index ${index}`);
      const audited = audit.get(index);
      if (!audited) throw new Error(`${label}: sent index ${index} unmatched in audit`);
      if (!isDeepStrictEqual(record, audited)) throw new Error(`${label}: sent index ${index} record mismatch with audit`);
      assigned.set(index, record);
    }
  }
  if (receipt.ok === true && audit.size !== assigned.size) throw new Error('Complete repair comparison has unassigned sent requests in audit');
  return { audit, assigned };
}

function arm(rows, key) {
  const costs = rows.map(row => row[key].costCny);
  const costCny = costs.every(value => value !== null) ? costs.reduce((sum, value) => sum + value, 0) : null;
  const correct = rows.filter(row => row[key].passed).length;
  return { samples: rows.length, correct, requests: rows.reduce((sum, row) => sum + row[key].requests, 0),
    costCny, perCorrectCostCny: costCny !== null && correct ? costCny / correct : null,
    meanLatencyMs: rows.length ? rows.reduce((sum, row) => sum + row[key].elapsedMs, 0) / rows.length : null };
}

function comparison(rows) {
  const firstAttempt = arm(rows, 'firstAttempt'), repaired = arm(rows, 'repaired');
  return { firstAttempt, repaired,
    incremental: { requests: repaired.requests - firstAttempt.requests,
      costCny: repaired.costCny !== null && firstAttempt.costCny !== null ? repaired.costCny - firstAttempt.costCny : null,
      meanLatencyMs: repaired.meanLatencyMs !== null && firstAttempt.meanLatencyMs !== null ? repaired.meanLatencyMs - firstAttempt.meanLatencyMs : null },
    paired: { rescued: rows.filter(row => !row.firstAttempt.passed && row.repaired.passed).length,
      regressed: rows.filter(row => row.firstAttempt.passed && !row.repaired.passed).length,
      bothCorrect: rows.filter(row => row.firstAttempt.passed && row.repaired.passed).length,
      bothWrong: rows.filter(row => !row.firstAttempt.passed && !row.repaired.passed).length } };
}

export function summarizeRepairBenefit(receipt) {
  if (!receipt?.protocol?.startsWith('code-public-verified-repair-') || !Array.isArray(receipt.trials)) {
    throw new Error('A code-public-verified-repair receipt with trials is required');
  }
  const trials = receipt.trials.map((trial, index) => {
    requireDelivery(trial, index);
    const first = priceRequests(trial.attempts[0].providerRequests), final = priceRequests(trial.providerRequests);
    return { name: trial.name, taskId: trial.taskId, preset: trial.preset,
      firstAttempt: { passed: trial.firstAttemptPassed, gradePassed: trial.firstAttemptGrade.passed,
        elapsedMs: trial.firstAttemptElapsedMs, requests: first.requests, costCny: first.costCny,
        unknownCostRequests: first.unknownCostRequests },
      repaired: { passed: trial.passed, elapsedMs: trial.elapsedMs, requests: final.requests,
        costCny: final.costCny, unknownCostRequests: final.unknownCostRequests },
      attempts: trial.attempts.length, blockedRequests: final.blockedRequests };
  });
  const attribution = verifyAttribution(receipt);
  const measured = comparison(trials), completeProtocol = receipt.ok === true &&
    Array.isArray(receipt.schedule) && receipt.schedule.length === trials.length && attribution !== null;
  const presets = [...new Set(trials.map(row => row.preset).filter(Boolean))];
  const byPreset = Object.fromEntries(presets.map(preset => [preset, comparison(trials.filter(row => row.preset === preset))]));
  const unassigned = attribution ? [...attribution.audit].filter(([index]) => !attribution.assigned.has(index)).map(([, record]) => record) : [];
  const extra = attribution ? priceRequests(unassigned) : null;
  return { schema: 1, protocol: receipt.protocol, source: receipt.output ?? null, completeProtocol,
    benefitConclusion: completeProtocol ? `Observed ${measured.paired.rescued} rescued and ${measured.paired.regressed} regressed deliveries in this batch; no population-level benefit is established.` : null,
    ...measured, byPreset, trials,
    unassignedProviderRequests: extra?.requests ?? null, unassignedCostCny: extra?.costCny ?? null,
    totalObservedCostCny: measured.repaired.costCny !== null && extra?.costCny !== null && extra?.costCny !== undefined ? measured.repaired.costCny + extra.costCny : null,
    billing: 'Official documented CNY estimate, not an account bill; unknown actual model, incomplete terminal usage, and uncertain peak pricing yield unknown cost.',
    priceSource: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    limitations: [
      'Only two independent task types are repeated across presets and rounds; repeated deliveries are not independent tasks and results cannot be generalized.',
      'The first-attempt grade uses its source after delivery and remains hidden from the model; the final grade uses the source after at most three public-feedback attempts.',
      'First-attempt latency is one model turn; repaired latency includes the full delivery and evaluator overhead, so the latency difference is descriptive.',
      'No same-condition official baseline or verified account bill is available; estimated CNY cannot prove savings against official clients.',
      'Failed deliveries and requests with unknown prices remain in the denominator; blocked-before-send requests have no provider charge.',
      ...(!completeProtocol ? ['Incomplete receipt or schedule: observed rows are partial and no full-batch benefit conclusion is valid.'] : []),
    ] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2];
  if (!filename) throw new Error('Usage: node scripts/repair-benefit-report.mjs <receipt.json>');
  const report = summarizeRepairBenefit(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const output = path.join(path.dirname(filename), 'repair-benefit.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, completeProtocol: report.completeProtocol,
    firstAttempt: report.firstAttempt, repaired: report.repaired, incremental: report.incremental,
    paired: report.paired }, null, 2));
}
