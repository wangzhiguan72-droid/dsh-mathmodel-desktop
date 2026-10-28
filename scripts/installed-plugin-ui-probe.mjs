import fs from 'node:fs/promises';
import { createInstalledHostClient } from './installed-host-client.mjs';

const ids = ['include:web-ui-ssh', 'include:web-ui-liangshen', 'include:web-ui-skill-explorer'];
const client = await createInstalledHostClient();
const receiptPath = new URL('../dist/fusion-installed-verification/optional-ui-plugins.json', import.meta.url);
const mode = process.argv[2] || 'inventory';
if (mode === 'fusion') {
  const response = await client.request('/api/model-fusion?view=settings');
  if (!response.ok) throw new Error(`Fusion HTTP ${response.status}`);
  const settings = await response.json();
  await fs.writeFile(new URL('../dist/fusion-installed-verification/fusion-settings-ui.json', import.meta.url), JSON.stringify(settings, null, 2));
  console.log(JSON.stringify({ authorized: settings.authorized, pair: settings.pair, revision: settings.revision }));
} else if (mode === 'enable') {
  const before = await client.rpc('pluginManager', 'listPlugins');
  const beforeRows = Array.isArray(before) ? before : before.plugins;
  if (!Array.isArray(beforeRows)) throw new Error('Plugin inventory unavailable');
  await fs.writeFile(receiptPath, JSON.stringify({ at: new Date().toISOString(), before: beforeRows.filter(row => ids.includes(row.entryId)).map(({entryId, moduleName, enabled, fiberPhase}) => ({entryId, moduleName, enabled, fiberPhase})) }, null, 2));
  for (const id of ids) await client.rpc('pluginManager', 'setPluginEnabled', { id, enabled: true });
} else if (mode === 'restore') {
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const rows = Array.isArray(receipt.before) ? receipt.before : receipt.before.plugins;
  if (!Array.isArray(rows)) throw new Error('Original plugin inventory shape unavailable; refusing guessed restoration');
  for (const id of ids) {
    const row = rows.find(item => item.entryId === id);
    if (!row || typeof row.enabled !== 'boolean') throw new Error(`Missing original state for ${id}`);
    await client.rpc('pluginManager', 'setPluginEnabled', { id, enabled: row.enabled });
  }
}
if (mode !== 'fusion') {
const result = await client.rpc('pluginManager', 'listPlugins');
const rows = Array.isArray(result) ? result : result.plugins;
console.log(JSON.stringify(Array.isArray(rows) ? rows.filter(row => ids.includes(row.entryId)).map(({entryId, moduleName, enabled, fiberPhase}) => ({entryId, moduleName, enabled, fiberPhase})) : result));
}
