// Read-only verification of the actual installed tree and its authenticated Host.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInstalledHostClient } from './installed-host-client.mjs';

const { activeWebFamilyRows, hasCompleteWebFamily } = createRequire(import.meta.url)('../src/runtime.cjs');
const phase = process.argv[2];
assert.ok(['first', 'restart', 'final'].includes(phase), 'Expected first, restart, or final');
const release = path.resolve(process.argv[3] ?? 'dist/fusion-release-closure-20261012-final');
const install = path.join(process.env.LOCALAPPDATA, 'Programs/dsh-mathmodel-desktop');
const expected = JSON.parse(await fs.readFile(path.join(release, 'verification.json'), 'utf8'));
const version = JSON.parse(await fs.readFile(path.join(install, 'resources/runtime/VERSION.json'), 'utf8'));
const digest = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
const appAsarSha256 = await digest(path.join(install, 'resources/app.asar'));
assert.equal(appAsarSha256, expected.artifactSha256['win-unpacked/resources/app.asar']);
assert.equal(version.builtAt, expected.builtAt);
const runtimeFiles = [
  'resources/runtime/host/node_modules/@deepseek-ai/dsh/package.json',
  'resources/runtime/profile-web/package.json',
  'resources/runtime/profile-web/cordis.patch.yml',
  'resources/runtime/profile-web/node_modules/dsh-model-fusion/package.json',
  'resources/runtime/profile-web/node_modules/dsh-model-fusion/lib/dsh-model-fusion.js',
  'resources/runtime/profile-web/node_modules/dsh-model-fusion/cordis.patch.yml',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-ssh/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-web-all/lib/client.js',
  'resources/runtime/profile-web/node_modules/@linxin666/dsh-client-ui-git-graph/lib/client.js',
];
const installedRuntimeHashes = {};
for (const relative of runtimeFiles) {
  const actual = await digest(path.join(install, relative));
  assert.equal(actual, await digest(path.join(release, 'win-unpacked', relative)),
    `Installed runtime differs from final package: ${relative}`);
  installedRuntimeHashes[relative] = actual;
}
const fusion = JSON.parse(await fs.readFile(path.join(install, 'resources/runtime/profile-web/node_modules/dsh-model-fusion/package.json'), 'utf8'));
assert.equal(fusion.version, '0.2.6');
let client;
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  try { client = await createInstalledHostClient(); break; }
  catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
}
assert.ok(client, 'Installed desktop Host did not become reachable');
const pluginInventory = await client.rpc('pluginManager', 'listPlugins');
const plugins = Array.isArray(pluginInventory) ? pluginInventory : pluginInventory.plugins;
const bundles = await client.rpc('pluginManager', 'listBundles');
assert.equal(bundles.find(row => row.name === 'dsh-model-fusion')?.enabled, true);
const activeFusionRows = plugins.filter(row => row.moduleName === 'dsh-model-fusion');
assert.equal(activeFusionRows.length, 1);
assert.equal(activeFusionRows[0].fiberPhase, 'active');
const webAllVersion = /^@linxin666\/dsh-web-all@(.+)$/.exec(version.webAll ?? '')?.[1];
// 0.4.11 removed /rows; the plugin manager inventory is the family ledger there.
const familyResponse = ['0.4.11', '0.4.12'].includes(webAllVersion) ? undefined : await client.request('/api/dsh-web-all/rows');
const degradedResponse = await client.request('/api/dsh-web-all/degraded');
const fusionResponse = await client.request('/api/model-fusion?view=settings');
if (familyResponse) assert.equal(familyResponse.status, 200);
assert.equal(degradedResponse.status, 200);
assert.equal(fusionResponse.status, 200);
const family = familyResponse ? await familyResponse.json() : { ok: true, children: activeWebFamilyRows(plugins) };
const degraded = await degradedResponse.json();
const settings = await fusionResponse.json();
assert.equal(family.ok, true);
assert.equal(degraded.ok, true);
assert.equal(degraded.degraded.length, 0);
const optionalIds = ['include:web-ui-ssh', 'include:web-ui-liangshen', 'include:web-ui-skill-explorer'];
const optional = optionalIds.map(id => {
  const row = plugins.find(item => item.entryId === id);
  assert.equal(typeof row?.enabled, 'boolean');
  assert.ok(row.enabled ? row.fiberPhase === 'active' : row.fiberPhase !== 'active');
  return { entryId: id, enabled: row.enabled, fiberPhase: row.fiberPhase ?? null };
});
if (['0.4.11', '0.4.12'].includes(webAllVersion)) assert.equal(hasCompleteWebFamily(family, webAllVersion), true);
else assert.equal(family.children.length, 11 + optional.filter(row => row.enabled).length);
const experimental = ['@deepseek-ai/dsh-experimental-agent-team-profile', '@deepseek-ai/dsh-experimental-auto-review'].map(name => {
  const row = bundles.find(item => item.name === name);
  assert.equal(row?.enabled, false);
  return { name, enabled: row.enabled };
});
const listing = await client.rpc('session', 'list', { _request: {} });
const receipt = { ok: true, phase, observedAt: new Date().toISOString(), installDir: install,
  version, appAsarSha256, installedRuntimeHashes, fusionVersion: fusion.version, familyChildren: family.children.length,
  degradedCount: degraded.degraded.length, optional, experimental,
  fusionSettings: { authorized: settings.authorized, pair: settings.pair, revision: settings.revision },
  runningSessionIds: listing.items.filter(item => item.running === true).map(item => item.sessionId) };
const output = path.resolve(`dist/fusion-installed-verification/closure-installed-${phase}.json`);
await fs.writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
