import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHarnessUsage, cacheHitRate, calculateCnyCost } from './deepseek-benchmark-metrics.mjs';

export function pricesFor(record) {
  const model = record.responseModel?.toLowerCase();
  const family = model?.startsWith('deepseek') && (model.includes('flash') ? 'flash' : model.includes('pro') ? 'pro' : null);
  if (!family) return { family: null, selected: null, reason: 'unknown-response-model' };
  const date = new Date(record.startedAt), china = new Date(date.getTime() + 8 * 3600000);
  if (!Number.isFinite(date.getTime())) return { family, selected: null, reason: 'unknown-request-time' };
  const hour = china.getUTCHours(), weekday = china.getUTCDay();
  const possiblePeak = weekday > 0 && weekday < 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  const off = family === 'flash' ? { inputPerMillion: 1, cacheReadPerMillion: .02, outputPerMillion: 4 }
    : { inputPerMillion: 4.5, cacheReadPerMillion: .15, outputPerMillion: 13.5 };
  const peak = Object.fromEntries(Object.entries(off).map(([key, value]) => [key, value * 2]));
  // Outside peak hours is definitive without consulting a holiday calendar.
  return { family, off, peak, selected: possiblePeak ? null : off,
    reason: possiblePeak ? 'holiday-calendar-not-verified-provide-range' : 'outside-peak-window' };
}

export function measureProviderRecord(record) {
  const raw = record.rawUsage ?? {};
  const usage = normalizeHarnessUsage({ inputTokens: raw.input_tokens, outputTokens: raw.output_tokens,
    cacheReadTokens: raw.cache_read_input_tokens, cacheWriteTokens: raw.cache_creation_input_tokens });
  const prices = pricesFor(record), known = record.auditVersion === 2 && record.usageComplete === true && record.terminalStopObserved === true && !record.blockedBeforeSend && record.httpStatus === 200;
  const selected = known && prices.selected ? calculateCnyCost(usage, prices.selected) : { cny: null, reason: known ? prices.reason : 'unverified-terminal-usage' };
  return { usage, hitRate: known ? cacheHitRate(usage) : null, responseModel: record.responseModel,
    estimatedCny: selected.cny, costReason: selected.reason, priceStatus: prices.reason,
    estimatedCnyRange: known && prices.off ? [calculateCnyCost(usage, prices.off).cny, calculateCnyCost(usage, prices.peak).cny] : null,
    auditIncomplete: record.auditIncomplete === true, usageComplete: record.usageComplete ?? null };
}

export function summarizeReceipt(receipt, providerAudit = receipt.allProviderRequests) {
  const trials = receipt.trials.map(trial => {
    const records = trial.providerRequests.filter(record => !record.blockedBeforeSend).map(record => ({ ...measureProviderRecord(record), toolsSha256: record.toolsSha256, systemSha256: record.systemSha256,
      toolCount: record.toolNames?.length ?? null, providerMs: record.elapsedMs, firstTextMs: record.firstTextMs ?? null }));
    const estimatedCny = records.every(row => row.estimatedCny !== null) ? records.reduce((sum, row) => sum + row.estimatedCny, 0) : null;
    return { name: trial.name, preset: trial.preset ?? null, kind: trial.kind ?? null, passed: trial.passed,
      ...(trial.taskId ? { taskId: trial.taskId, round: trial.round, pair: trial.pair, position: trial.position,
        hiddenPassed: trial.grade?.checks.hidden.passed ?? false, fixtureIntegrity: trial.fixtureIntegrity } : {}),
      ...(trial.attempts ? { attemptCount: trial.attempts.length, firstAttemptPublicPassed: trial.attempts[0]?.publicPassed ?? false,
        publicPassed: trial.publicPassed ?? false, repairStopReason: trial.repairStopReason ?? null } : {}),
      elapsedMs: trial.elapsedMs, requests: records.length, estimatedCny, records };
  });
  const arms = [...new Set(trials.map(row => row.preset).filter(Boolean))].map(preset => {
    const rows = trials.filter(row => row.preset === preset), correct = rows.filter(row => row.passed === true).length;
    const allPriced = rows.every(row => row.estimatedCny !== null), estimatedCny = allPriced ? rows.reduce((sum, row) => sum + row.estimatedCny, 0) : null;
    const provider = rows.flatMap(row => row.records);
    const promptKnown = provider.every(row => row.hitRate !== null && row.usage.inputTokens !== null && row.usage.cacheReadTokens !== null && row.usage.cacheWriteTokens !== null);
    const promptTokens = promptKnown ? provider.reduce((sum, row) => sum + row.usage.inputTokens + row.usage.cacheReadTokens + row.usage.cacheWriteTokens, 0) : null;
    const cacheReadTokens = promptKnown ? provider.reduce((sum, row) => sum + row.usage.cacheReadTokens, 0) : null;
    return { preset, samples: rows.length, correct, estimatedCny, estimatedCnyPerCorrect: estimatedCny !== null && correct ? estimatedCny / correct : null,
      promptTokens, cacheReadTokens, weightedHitRate: promptTokens ? cacheReadTokens / promptTokens : null,
      meanTurnMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0) / rows.length,
      toolSchemaHashes: [...new Set(provider.map(row => row.toolsSha256))], systemHashes: [...new Set(provider.map(row => row.systemSha256))], toolCounts: [...new Set(provider.map(row => row.toolCount))] };
  });
  const pairs = [...new Set(trials.map(row => row.pair).filter(Boolean))].map(pair => {
    const rows = trials.filter(row => row.pair === pair), base = rows.find(row => row.preset === 'task-00'), full = rows.find(row => row.preset === 'task-0f');
    return { pair, taskId: rows[0].taskId, round: rows[0].round, complete: Boolean(base && full),
      basePassed: base?.passed ?? null, fullPassed: full?.passed ?? null,
      fullMinusBaseCny: base?.estimatedCny != null && full?.estimatedCny != null ? full.estimatedCny - base.estimatedCny : null,
      fullMinusBaseMs: base && full ? full.elapsedMs - base.elapsedMs : null };
  });
  const assigned = new Set(receipt.trials.flatMap(row => row.providerRequests).map(row => row.index));
  const unassigned = (providerAudit ?? []).filter(row => !row.blockedBeforeSend && !assigned.has(row.index)).map(measureProviderRecord);
  const allCosts = [...trials.map(row => row.estimatedCny), ...unassigned.map(row => row.estimatedCny)];
  return { schema: 1, stage: receipt.stage, protocol: receipt.protocol, ok: receipt.ok, observedAt: new Date().toISOString(), source: receipt.output,
    coverage: { plannedTrials: receipt.schedule?.length ?? receipt.limits?.maximumTurns ?? null,
      recordedTrials: trials.length, unassignedRequests: unassigned.length, completeProtocol: receipt.ok === true && (!receipt.schedule || trials.length === receipt.schedule.length) },
    billing: 'Official documented CNY estimate, not an account bill; thinking is already included in output tokens.',
    priceSource: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    cacheSource: 'https://api-docs.deepseek.com/guides/kv_cache/', trials, arms, ...(pairs.length ? { pairs } : {}),
    unassignedProviderRequests: unassigned,
    estimatedTotalCny: allCosts.every(value => value !== null) ? allCosts.reduce((sum, value) => sum + value, 0) : null,
    limitations: [receipt.protocol?.startsWith('code-public-verified-repair-') ? 'Bounded public-test feedback repair on two known failures, two arms; final independent holdout, never pooled with one-shot or blind scores.' : receipt.protocol?.startsWith('code-repair-recheck-') ? 'Repair recheck: two failed implementations, two arms, added public regression cases; never pool with the earlier blind crossover scores.' : receipt.protocol?.startsWith('code-randomized-crossover-') ? 'Four generated software tasks, two rounds; repeats are not independent tasks.' : 'Small synthetic pilot: three unique questions; repeats are not independent tasks.',
      receipt.protocol?.startsWith('code-randomized-crossover-') ? 'Seeded balanced paired crossover; cache carryover and time variation remain; no population-level superiority claim.' : 'Fixed arm order within repair pairs; no statistical significance or general engineering quality claim.',
      ...(receipt.ok !== true ? ['Incomplete run: completed-trial arm scores omit interrupted/unrecorded deliveries and must not be compared as full-protocol success rates.'] : []),
      'First observed request may already be cached.', 'Costs with missing counters or unknown actual model remain unknown.', 'No personal installed profile change; no account deduction verification.'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2];
  if (!filename) throw new Error('Usage: node scripts/deepseek-benchmark-report.mjs <receipt.json>');
  const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const auditFile = path.join(path.dirname(filename), 'provider-audit.jsonl');
  const providerAudit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : undefined;
  const result = summarizeReceipt(receipt, providerAudit);
  const output = path.join(path.dirname(filename), 'summary.json'); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output, ok: result.ok, estimatedTotalCny: result.estimatedTotalCny, arms: result.arms }, null, 2));
}
