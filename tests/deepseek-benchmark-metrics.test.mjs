import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHarnessUsage, cacheHitRate, calculateCnyCost, scoreJsonTask,
} from '../scripts/deepseek-benchmark-metrics.mjs';

const prices = {
  inputPerMillion: 2,
  cacheReadPerMillion: 0.04,
  cacheWritePerMillion: 2,
  outputPerMillion: 8,
};

test('normalizes a durable assistant/message usage without conflating cache and input', () => {
  const event = {
    type: 'assistant/message',
    data: { usage: {
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 900,
      cacheWriteTokens: 0, reasoningTokens: 5, totalTokens: 1020,
    } },
  };
  assert.deepEqual(normalizeHarnessUsage(event), {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 900,
    cacheWriteTokens: 0, reasoningTokens: 5, totalTokens: 1020,
  });
  assert.equal(cacheHitRate(event), 0.9);
});

test('unknown usage buckets stay unknown and cannot be priced', () => {
  const usage = normalizeHarnessUsage({ inputTokens: 10, outputTokens: 2 });
  assert.equal(usage.cacheReadTokens, null);
  assert.equal(usage.cacheWriteTokens, null);
  assert.equal(cacheHitRate(usage), null);
  assert.deepEqual(calculateCnyCost(usage, prices), {
    cny: null, breakdown: null, reason: 'unknown-cacheRead-tokens',
  });
  assert.equal(calculateCnyCost(undefined, prices).cny, null);
  assert.throws(() => normalizeHarnessUsage({ inputTokens: -1 }), /inputTokens/);
});

test('CNY cost bills disjoint buckets once and requires explicit nonzero rates', () => {
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900,
    cacheWriteTokens: 0, reasoningTokens: 5, totalTokens: 1020 };
  const cost = calculateCnyCost(usage, prices);
  assert.equal(cost.reason, null);
  assert.equal(cost.cny, (100 * 2 + 900 * 0.04 + 20 * 8) / 1_000_000);
  assert.equal(cost.breakdown.cacheRead.tokens, 900);
  assert.equal(cost.breakdown.cacheWrite.cny, 0);
  assert.equal(calculateCnyCost(usage, { ...prices, outputPerMillion: undefined }).reason,
    'unknown-output-price');
  assert.equal(calculateCnyCost({ ...usage, cacheWriteTokens: 1 },
    { ...prices, cacheWritePerMillion: undefined }).reason, 'unknown-cacheWrite-price');
});

test('cache ratio is unknown with zero prompt denominator', () => {
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
});

test('JSON task scoring checks exact values and rejects prose or malformed output', () => {
  const expected = { result: [2, 4, 8], sum: 14 };
  assert.deepEqual(scoreJsonTask('{"sum":14,"result":[2,4,8]}', expected),
    { passed: true, reason: null });
  assert.deepEqual(scoreJsonTask('{"sum":15,"result":[2,4,8]}', expected),
    { passed: false, reason: 'wrong-answer' });
  assert.deepEqual(scoreJsonTask('答案是 {"sum":14}', expected),
    { passed: false, reason: 'invalid-json' });
  assert.deepEqual(scoreJsonTask(undefined, expected),
    { passed: false, reason: 'non-text-answer' });
});
