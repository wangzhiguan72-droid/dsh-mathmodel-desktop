import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('uninstall preserves personal homes and linked skill libraries', async () => {
  const installer = await readFile(new URL('../build/installer.nsh', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(installer, /^\s*(?:RMDir|Delete)\s+(?:\/\w+\s+)*["']?\$(?:APPDATA|LOCALAPPDATA|PROFILE|DOCUMENTS|HOME)\b/im);
  assert.match(builder, /deleteAppDataOnUninstall:\s*false/);
});

test('the distributed profile resolves hooks and skills inside the selected DSH_HOME', async () => {
  const seed = await readFile(new URL('../build/profile.cordis.patch.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(seed, /[A-Z]:\\Users\\|configPath:\s*[A-Z]:/i);
  assert.match(seed, /configPath:\s*!!js dshHomePath\('hooks\.json'\)/);
  assert.match(seed, /- insert:\s*\n\s+- id: hooks-claude-code\s*\n/, 'a new hook plugin must be inserted, not patched by an absent id');
  assert.doesNotMatch(seed, /^- id: hooks-claude-code\s*$/m);
  assert.match(seed, /skillRoot:\s*!!js dshHomePath\('skills'\)/);
  assert.match(seed, /id: session-telemetry-otel[\s\S]*?disabled: true/);
});
