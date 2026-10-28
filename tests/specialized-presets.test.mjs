import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { restoreSpecializedPresets } from '../scripts/restore-specialized-presets.mjs';
import runtime from '../src/runtime.cjs';

const root = resolve(import.meta.dirname, '..');
const runtimeRoot = join(root, 'resources', 'runtime', 'host', 'node_modules');
const yaml = createRequire(join(runtimeRoot, '__test__.cjs'))('yaml');
const script = join(root, 'scripts', 'restore-specialized-presets.mjs');
const parse = source => {
  const doc = yaml.parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  assert.equal(doc.errors.length, 0);
  return doc.toJS();
};
const entries = source => parse(source).flatMap(row => row.insert ?? []);
function invoke(...args) {
  return spawnSync(process.execPath, [script, '--runtime-root', runtimeRoot, ...args], { encoding: 'utf8' });
}

test('generated specialized presets retain standard roster and Persona contracts', () => {
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(result.stdout);
  const standard = entries(readFileSync(join(runtimeRoot, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'), 'utf8'))[0];
  const presets = entries(generated.yaml);
  assert.deepEqual(presets.map(row => row.config.id), ['mathmodel', 'imagegen', 'editable-ppt']);
  assert.deepEqual(presets.map(row => row.id), ['preset-mathmodel', 'preset-imagegen', 'preset-editable-ppt']);
  for (const row of presets) {
    assert.equal(row.name, '@deepseek-ai/dsh-agent-preset');
    assert.deepEqual(row.config.plugins.map(plugin => [plugin.id, plugin.name]), standard.config.plugins.map(plugin => [plugin.id, plugin.name]));
    assert.equal(row.config.plugins.filter(plugin => plugin.id === 'persona').length, 1);
  }
  const persona = row => row.config.plugins[0].config;
  assert.match(persona(presets[0]).prefix + ' ' + persona(presets[0]).suffix, /Never fabricate data, citations, experiments, scores, or verification/);
  assert.deepEqual(persona(presets[1]), persona(standard));
  assert.match(persona(presets[2]).prefix + persona(presets[2]).suffix, /所有图像调用只用 editable_ppt_image/);
  assert.match(generated.yaml, /disabled: !!js process\.platform/);
});

test('known rc.2 managed block upgrades to the bundled roster and preserves Host additions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-presets-upgrade-'));
  try {
    const profile = join(directory, 'cordis.patch.yml');
    const before = '# Personal note\n- insert:\n    - id: custom-plugin\n      name: example\n\n';
    const oldBlock = readFileSync(join(root, 'tests', 'fixtures', 'specialized-rc2-managed.yaml'), 'utf8')
      .replace('facts, assumptions', 'facts,\n                assumptions')
      .replace('# END DSH specialized presets', '- id: mathmodel\n  name: "@deepseek-harness/dsh-mathmodel"\n  config:\n    imageConnections: []\n\n# END DSH specialized presets');
    const after = '\n# Personal trailing note\n';
    const original = before + oldBlock + after;
    writeFileSync(profile, original);
    const preview = restoreSpecializedPresets({ runtimeRoot, profilePatch: profile });
    assert.equal(preview.changed, true);
    assert.equal(readFileSync(profile, 'utf8'), original);
    const result = restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true });
    assert.equal(result.applied, true);
    assert.equal(readFileSync(result.backup, 'utf8'), original);
    const upgraded = readFileSync(profile, 'utf8');
    assert.ok(upgraded.startsWith(before));
    assert.ok(upgraded.endsWith(after));
    assert.match(upgraded, /imageConnections: \[\]/);
    assert.deepEqual(entries(upgraded).slice(1, 4).map(row => row.config.id), ['mathmodel', 'imagegen', 'editable-ppt']);
    const standard = entries(readFileSync(join(runtimeRoot, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'), 'utf8'))[0];
    for (const row of entries(upgraded).slice(1, 4)) {
      assert.deepEqual(row.config.plugins.map(plugin => plugin.id), standard.config.plugins.map(plugin => plugin.id));
    }
    const repeated = restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true });
    assert.equal(repeated.applied, false);
    assert.equal(readFileSync(profile, 'utf8'), upgraded);
    assert.equal(readdirSync(directory).filter(name => name.includes('.bak-specialized-')).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('edited rc.2 managed block is rejected without a write or backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-presets-upgrade-edit-'));
  try {
    const profile = join(directory, 'cordis.patch.yml');
    const original = readFileSync(join(root, 'tests', 'fixtures', 'specialized-rc2-managed.yaml'), 'utf8')
      .replace('Never fabricate data, citations', 'Fabricate data, citations');
    writeFileSync(profile, original);
    assert.throws(() => restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true }), /Managed preset block differs/);
    assert.equal(readFileSync(profile, 'utf8'), original);
    assert.deepEqual(readdirSync(directory), ['cordis.patch.yml']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('apply preserves profile content, backs it up, and repeated apply is byte-identical', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-presets-'));
  try {
    const profile = join(directory, 'profile.cordis.patch.yml');
    const original = '# Personal note\r\n- insert:\r\n    - id: custom-plugin\r\n      name: example\r\n';
    writeFileSync(profile, original);
    const preview = invoke('--profile-patch', profile);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(readFileSync(profile, 'utf8'), original);
    const first = invoke('--profile-patch', profile, '--apply');
    assert.equal(first.status, 0, first.stderr);
    const data = JSON.parse(first.stdout);
    assert.equal(data.applied, true);
    assert.equal(readFileSync(data.backup, 'utf8'), original);
    const current = readFileSync(profile, 'utf8');
    assert.ok(current.startsWith(original));
    assert.ok(current.includes('\r\n# BEGIN DSH specialized presets'));
    assert.deepEqual(entries(current).map(row => row.id), ['custom-plugin', 'preset-mathmodel', 'preset-imagegen', 'preset-editable-ppt']);
    const second = invoke('--profile-patch', profile, '--apply');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).applied, false);
    assert.equal(readFileSync(profile, 'utf8'), current);
    assert.equal(readdirSync(directory).filter(name => name.includes('.bak-specialized-')).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('existing specialized ID is rejected without changing profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-presets-conflict-'));
  try {
    const profile = join(directory, 'profile.yml');
    const original = '- insert:\n    - id: preset-mathmodel\n      name: other\n';
    writeFileSync(profile, original);
    const result = invoke('--profile-patch', profile, '--apply');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already defines specialized preset/);
    assert.equal(readFileSync(profile, 'utf8'), original);
    assert.equal(readdirSync(directory).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restart accepts Host-wrapped Persona and unrelated settings appended inside markers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-presets-reserialized-'));
  try {
    const profile = join(directory, 'cordis.patch.yml');
    writeFileSync(profile, '- insert: []\n');
    const first = restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true });
    const initial = readFileSync(profile, 'utf8');
    const rewritten = initial
      .replace('facts, assumptions', 'facts,\n                assumptions')
      .replace('# END DSH specialized presets', '- id: mathmodel\n  name: "@deepseek-harness/dsh-mathmodel"\n  config:\n    imageConnections: []\n\n# END DSH specialized presets');
    assert.notEqual(rewritten, initial);
    assert.deepEqual(entries(rewritten).slice(0, 3).map(row => row.config?.id), ['mathmodel', 'imagegen', 'editable-ppt']);
    writeFileSync(profile, rewritten);
    const second = restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true });
    assert.equal(second.applied, false);
    assert.equal(readFileSync(profile, 'utf8'), rewritten);
    assert.equal(readdirSync(directory).filter(name => name.includes('.bak-specialized-')).length, 1);
    assert.equal(readFileSync(first.backup, 'utf8'), '- insert: []\n');

    const changedPersona = rewritten.replace('Never fabricate data, citations', 'Fabricate data, citations');
    writeFileSync(profile, changedPersona);
    assert.throws(() => restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true }), /Managed preset block differs/);
    assert.equal(readFileSync(profile, 'utf8'), changedPersona);
    const lostTag = rewritten.replace("disabled: !!js process.platform === 'win32'", "disabled: \"process.platform === 'win32'\"");
    writeFileSync(profile, lostTag);
    assert.throws(() => restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true }), /Managed preset block differs/);
    assert.equal(readFileSync(profile, 'utf8'), lostTag);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('desktop boot uses the same migration before starting the host and ships its module', () => {
  const main = readFileSync(join(root, 'src', 'main.cjs'), 'utf8');
  const packageConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  assert.match(packageConfig, /- scripts\/restore-specialized-presets\.mjs/);
  assert.match(main, /if \(isDesktopSeededProfile\(profileDir\)\)/);
  assert.doesNotMatch(main, /profileName === 'web'/);
  const migration = main.indexOf('restoreSpecializedPresets({');
  const startHost = main.indexOf("setStatus('Starting the dsh host…');", migration);
  assert.ok(migration > 0 && startHost > migration);
  const directory = mkdtempSync(join(tmpdir(), 'dsh-presets-boot-'));
  try {
    const profile = join(directory, 'cordis.patch.yml');
    writeFileSync(profile, '- insert: []\n');
    const first = restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true });
    const second = restoreSpecializedPresets({ runtimeRoot, profilePatch: profile, apply: true });
    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.deepEqual(entries(readFileSync(profile, 'utf8')).map(row => row.config?.id), ['mathmodel', 'imagegen', 'editable-ppt']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('default mathmodel and custom profiles migrate only with a desktop seed marker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-presets-selected-'));
  try {
    assert.equal(runtime.resolveProfileName({}), 'mathmodel');
    for (const name of ['mathmodel', 'team-1']) {
      const profile = join(directory, name);
      mkdirSync(profile);
      writeFileSync(join(profile, 'cordis.patch.yml'), '- insert: []\n');
      assert.equal(runtime.isDesktopSeededProfile(profile), false);
      writeFileSync(join(profile, runtime.SEED_MARKER), JSON.stringify({ stamp: 'runtime-rc2', appVersion: '0.1.3' }));
      assert.equal(runtime.isDesktopSeededProfile(profile), true);
      const result = restoreSpecializedPresets({ runtimeRoot, profilePatch: join(profile, 'cordis.patch.yml'), apply: true });
      assert.equal(result.applied, true);
      assert.deepEqual(entries(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).map(row => row.config?.id), ['mathmodel', 'imagegen', 'editable-ppt']);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
