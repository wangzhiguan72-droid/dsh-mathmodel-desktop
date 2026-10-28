import assert from 'node:assert/strict';

const tokenFields = Object.freeze([
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'reasoningTokens', 'totalTokens',
]);

function nonnegativeCount(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
  return value;
}

/**
 * Read one durable Harness assistant/message event, or its TokenUsage value.
 * The six buckets are deliberately nullable: an absent provider counter is unknown.
 * Per dsh-llm TokenUsage, inputTokens excludes cacheReadTokens/cacheWriteTokens.
 */
export function normalizeHarnessUsage(eventOrUsage) {
  const usage = eventOrUsage?.type === 'assistant/message'
    ? eventOrUsage.data?.usage
    : eventOrUsage;
  return Object.fromEntries(tokenFields.map((field) => [
    field, nonnegativeCount(usage?.[field], field),
  ]));
}

/** Exact cache-read share of prompt tokens when every prompt bucket is known. */
export function cacheHitRate(eventOrUsage) {
  const usage = normalizeHarnessUsage(eventOrUsage);
  if ([usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].includes(null)) return null;
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return promptTokens === 0 ? null : usage.cacheReadTokens / promptTokens;
}

/**
 * Price one model call in CNY using caller-supplied CNY / 1,000,000 tokens.
 * No provider price is embedded here. Thinking tokens are already in outputTokens.
 */
export function calculateCnyCost(eventOrUsage, prices) {
  const usage = normalizeHarnessUsage(eventOrUsage);
  const buckets = [
    ['input', usage.inputTokens, prices?.inputPerMillion],
    ['cacheRead', usage.cacheReadTokens, prices?.cacheReadPerMillion],
    ['cacheWrite', usage.cacheWriteTokens, prices?.cacheWritePerMillion],
    ['output', usage.outputTokens, prices?.outputPerMillion],
  ];
  const breakdown = {};
  let millionTokenCost = 0;
  for (const [name, tokens, rate] of buckets) {
    if (tokens === null) return { cny: null, breakdown: null, reason: `unknown-${name}-tokens` };
    // Zero observed tokens cost exactly zero, even when a rate is not listed.
    if (tokens === 0) {
      breakdown[name] = { tokens, ratePerMillion: rate ?? null, cny: 0 };
      continue;
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      return { cny: null, breakdown: null, reason: `unknown-${name}-price` };
    }
    millionTokenCost += tokens * rate;
    breakdown[name] = { tokens, ratePerMillion: rate, cny: tokens * rate / 1_000_000 };
  }
  return {
    cny: millionTokenCost / 1_000_000,
    breakdown,
    reason: null,
  };
}

/** Compare a model's JSON-only answer with a fixed, independent expected value. */
export function scoreJsonTask(responseText, expected) {
  if (typeof responseText !== 'string') return { passed: false, reason: 'non-text-answer' };
  let actual;
  try {
    actual = JSON.parse(responseText.trim());
  } catch {
    return { passed: false, reason: 'invalid-json' };
  }
  try {
    assert.deepStrictEqual(actual, expected);
    return { passed: true, reason: null };
  } catch {
    return { passed: false, reason: 'wrong-answer' };
  }
}
