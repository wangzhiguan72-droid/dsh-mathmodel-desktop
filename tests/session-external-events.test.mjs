import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { patchSessionExternalEvents, patchSessionExternalEventsSource } from '../scripts/patch-session-external-events.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const runtimeRoot = path.join(repo, 'resources', 'runtime', 'host', 'node_modules');
const libDir = path.join(runtimeRoot, '@deepseek-ai', 'dsh-session', 'lib');
const sourceFile = path.join(libDir, 'index.js');

test('pinned Session.append patch is guarded and idempotent', async () => {
  const source = await fs.readFile(sourceFile, 'utf8');
  const once = patchSessionExternalEventsSource(source);
  assert.equal(patchSessionExternalEventsSource(once), once);
  assert.match(once, /surfaceOpts\?\.ignorable === true \? \{ ignorable: true \} : \{\}/);
  assert.throws(() => patchSessionExternalEventsSource(source.replace('const surfaceOpts = opts[0];', 'const surfaceOpts = opts.at(0);')), /shape changed/);
  assert.throws(() => patchSessionExternalEventsSource('append(type, data, ...opts) {}'), /shape changed/);
});

test('official Session emits an explicitly ignorable external event and strict stored validation still rejects unmarked events', async () => {
  const source = patchSessionExternalEventsSource(await fs.readFile(sourceFile, 'utf8'));
  // Resolve the pinned package's bare imports from its own lib directory.
  const fixture = path.join(libDir, `.external-events-test-${randomUUID()}.mjs`);
  try {
    await fs.writeFile(fixture, source);
    const { Session } = await import(pathToFileURL(fixture).href);
    const { validateStoredEvents, SessionFormatUnsupportedError } = await import(pathToFileURL(path.join(runtimeRoot, '@deepseek-ai', 'dsh-session-persistence', 'lib', 'index.js')).href);
    const marked = Session.create('external-marked');
    marked.append('mathmodel/capabilities-confirmed', { schema: 1 }, { ignorable: true });
    const stored = structuredClone(marked.snapshotEvents());
    assert.equal(stored[0].ignorable, true);
    assert.equal(validateStoredEvents({ id: marked.id }, stored).length, 1);
    const unmarked = Session.create('external-unmarked');
    unmarked.append('mathmodel/capabilities-confirmed', { schema: 1 });
    assert.equal(unmarked.snapshotEvents()[0].ignorable, undefined);
    assert.throws(() => validateStoredEvents({ id: unmarked.id }, structuredClone(unmarked.snapshotEvents())), SessionFormatUnsupportedError);
    const nontrue = Session.create('external-nontrue');
    nontrue.append('mathmodel/capabilities-confirmed', { schema: 1 }, { ignorable: 'true' });
    assert.equal(nontrue.snapshotEvents()[0].ignorable, undefined);
  } finally { await fs.rm(fixture, { force: true }); }
});
