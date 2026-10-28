import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const codexAuth = resolve(import.meta.dirname, '../src/image/codex-auth.js');
const grokAuth = resolve(import.meta.dirname, '../src/image/grok-auth.js');

test('本地 Codex/Grok 认证只消费 Host service，不再直接读写凭据文件', async () => {
  const [codexSource, grokSource] = await Promise.all([
    readFile(codexAuth, 'utf8'),
    readFile(grokAuth, 'utf8'),
  ]);
  for (const source of [codexSource, grokSource]) {
    assert.match(source, /subscriptionSessions/);
    assert.doesNotMatch(source, /node:fs|readFile|writeFile|auth\.json|pi-ai-oauth/);
  }
});
