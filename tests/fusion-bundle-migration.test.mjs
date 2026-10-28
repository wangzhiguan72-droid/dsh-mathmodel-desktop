import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { migrateFusionBundle } from '../scripts/migrate-fusion-bundle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const runtimeRoot = path.join(root, 'resources/runtime/host/node_modules');
const yaml = createRequire(path.join(runtimeRoot, '__fusion_test__.cjs'))('yaml');
const parse = source => yaml.parse(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
function fixture(t, source) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fusion-migration-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(profileDir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(profileDir), /^dsh-fusion-migration-/);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });
  const patch = path.join(profileDir, 'cordis.patch.yml');
  const manifest = path.join(profileDir, 'package.json');
  fs.writeFileSync(patch, source);
  fs.writeFileSync(manifest, JSON.stringify({ dependencies: { 'dsh-model-fusion': '0.2.6' }, dsh: { profile: { bundles: ['base'] } }, custom: 'keep' }));
  return { profileDir, patch, manifest };
}
test('Fusion migration preserves tagged config, other plugins, later overrides and preset scopes', t => {
  const source = `# Personal note\n- insert:\n    - id: custom\n      name: custom-plugin\n    # Fusion config comment\n    - id: dsh-model-fusion\n      name: dsh-model-fusion\n      config:\n        databasePath: !!js dshHomePath('my-state.sqlite')\n        customValue: keep\n    - id: preset\n      name: preset\n      config:\n        plugins:\n          - id: dsh-model-fusion\n            name: scoped-plugin\n- id: dsh-model-fusion\n  name: dsh-model-fusion\n  config:\n    customValue: later-wins\n`;
  const f = fixture(t, source);
  const options = { profileDir: f.profileDir, runtimeRoot };
  assert.equal(migrateFusionBundle(options).changed, true);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), source, 'Preview mutated profile');
  const first = migrateFusionBundle({ ...options, apply: true });
  assert.equal(first.applied, true);
  const after = fs.readFileSync(f.patch, 'utf8');
  const rows = parse(after);
  assert.deepEqual(rows[0].insert.map(row => row.id), ['custom', 'preset']);
  assert.deepEqual(rows[0].insert[1], parse(source)[0].insert[2]);
  assert.deepEqual(rows[1].config, parse(source)[0].insert[1].config);
  assert.deepEqual(rows[2], parse(source)[1], 'Later override order changed');
  assert.match(after, /!!js dshHomePath\('my-state.sqlite'\)/);
  assert.match(after, /Personal note/);
  assert.match(after, /Fusion config comment/);
  const manifest = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['base', 'dsh-model-fusion']);
  assert.equal(manifest.custom, 'keep');
  assert.equal(first.backups.length, 2);
  assert.equal(fs.readFileSync(first.backups.find(file => file.startsWith(f.patch)), 'utf8'), source);
  const second = migrateFusionBundle({ ...options, apply: true });
  assert.equal(second.changed, false);
  assert.equal(second.applied, false);
  assert.deepEqual(second.backups, []);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), after);
  manifest.dsh.profile.bundles = ['base'];
  fs.writeFileSync(f.manifest, JSON.stringify(manifest));
  assert.equal(migrateFusionBundle({ ...options, apply: true }).changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest, 'utf8')).dsh.profile.bundles, ['base'], 'Restart re-enabled a user-disabled bundle');
});
test('an explicitly disabled legacy loader stays disabled and does not select the bundle', t => {
  const f = fixture(t, '- insert:\n    - id: dsh-model-fusion\n      name: dsh-model-fusion\n      disabled: true\n      config:\n        custom: keep\n');
  const result = migrateFusionBundle({ profileDir: f.profileDir, runtimeRoot, apply: true });
  assert.equal(result.bundleSelected, false);
  assert.equal(parse(fs.readFileSync(f.patch, 'utf8'))[0].disabled, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest, 'utf8')).dsh.profile.bundles, ['base']);
});
test('conflicting IDs and duplicate legacy loaders refuse mutation', t => {
  for (const source of [
    '- insert:\n    - id: dsh-model-fusion\n      name: another-plugin\n',
    '- insert:\n    - id: dsh-model-fusion\n      name: dsh-model-fusion\n    - id: dsh-model-fusion\n      name: dsh-model-fusion\n',
  ]) {
    const f = fixture(t, source);
    const beforeManifest = fs.readFileSync(f.manifest, 'utf8');
    assert.throws(() => migrateFusionBundle({ profileDir: f.profileDir, runtimeRoot, apply: true }));
    assert.equal(fs.readFileSync(f.patch, 'utf8'), source);
    assert.equal(fs.readFileSync(f.manifest, 'utf8'), beforeManifest);
    assert.equal(fs.readdirSync(f.profileDir).length, 2);
  }
});
test('packaged seed selects Fusion and configures it without inserting another loader', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime/profile-web/package.json'), 'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-model-fusion'));
  const rows = parse(fs.readFileSync(path.join(root, 'build/profile.cordis.patch.yml'), 'utf8'));
  assert.equal(rows.flatMap(row => row.insert ?? []).filter(row => row.id === 'dsh-model-fusion').length, 0);
  assert.equal(rows.filter(row => row.id === 'dsh-model-fusion').length, 1);
});
