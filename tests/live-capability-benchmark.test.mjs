import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, repairAttemptCompletion, requestHitRate } from '../scripts/live-capability-benchmark.mjs';

test('request hit rate counts all three prompt buckets and refuses incomplete usage', () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, output_tokens: 5 };
  assert.equal(requestHitRate({ usageComplete: true, rawUsage: usage }), 0.75);
  assert.equal(requestHitRate({ usageComplete: false, rawUsage: usage }), null);
  assert.equal(requestHitRate({ usageComplete: true, rawUsage: { ...usage, cache_creation_input_tokens: undefined } }), null);
});

test('score final assistant answer without mixing in tool-call preambles', () => {
  assert.equal(textOf([
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Reading the fixture.' }, { type: 'tool-call', name: 'read' }] } } },
    { type: 'tool/result', data: {} },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"sum":42}' }] } } },
  ]), '{"sum":42}');
});

test('only a settled local request limit is recoverable, never timeout, provider loss, or fixture tampering', () => {
  const limited = { turnEndReason: { kind: 'benchmark-request-limit' }, providerRequests: [
    { usageComplete: true }, { blockedBeforeSend: true, reason: 'turn-request-budget' },
  ] };
  assert.equal(repairAttemptCompletion(limited, true), false);
  assert.equal(repairAttemptCompletion({ turnEndReason: { kind: 'completed' }, providerRequests: [{ usageComplete: true }] }, true), true);
  assert.throws(() => repairAttemptCompletion(limited, false), /fixture/i);
  assert.throws(() => repairAttemptCompletion({ ...limited, turnEndReason: { kind: 'benchmark-timeout' } }, true), /turn/i);
  assert.throws(() => repairAttemptCompletion({ ...limited, providerRequests: [{ usageComplete: false }] }, true), /usage/i);
  assert.throws(() => repairAttemptCompletion({ ...limited, providerRequests: [{ usageComplete: true }, { blockedBeforeSend: true, reason: 'request/output-budget' }] }, true), /turn/i);
});
