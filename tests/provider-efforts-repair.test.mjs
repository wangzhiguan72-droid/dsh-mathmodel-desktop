import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { repairEffortKeys } from '../scripts/repair-provider-efforts.mjs';
const require = createRequire(new URL('../resources/runtime/host/__fixture__.cjs', import.meta.url));
const YAML = require('yaml');

test('repairs unsupported aliases while preserving wire values, credentials and unrelated YAML bytes', () => {
  const source = '# personal config\r\n- id: llm-pi-ai\r\n  config:\r\n    apiKeyEnv: KEEP_ME\r\n    models:\r\n      - id: magpie/gpt\r\n        reasoningEfforts:\r\n          none: none\r\n          high: high\r\n          max: max\r\n          ultra: ultra\r\n- id: untouched\r\n  config: !!js dshHomePath(\'skills\')\r\n';
  const { candidate, models } = repairEffortKeys(source, YAML);
  assert.equal(candidate, source.replace('none: none', 'off: none').replace('          ultra: ultra\r\n', ''));
  assert.equal(models.length, 2);
  assert.equal(repairEffortKeys(candidate, YAML).candidate, candidate);
});

test('existing off alias is not overwritten and unknown aliases fail before mutation', () => {
  const source = 'id: fixture\nreasoningEfforts:\n  off: null\n  none: none\n  high: high\n';
  assert.equal(repairEffortKeys(source, YAML).candidate, source.replace('  none: none\n', ''));
  assert.throws(() => repairEffortKeys('reasoningEfforts:\n  mystery: value\n', YAML), /Unknown/);
});
