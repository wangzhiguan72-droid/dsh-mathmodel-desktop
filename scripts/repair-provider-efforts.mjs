// Repair only reasoning-level keys incompatible with the installed Harness.
// Credential values and endpoint configuration never enter the report.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function repairEffortKeys(source, YAML) {
  const document = YAML.parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (document.errors.length) throw new Error('Invalid profile YAML');
  const allowed = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const edits = [], models = [];
  const visit = node => {
    if (YAML.isSeq(node)) { node.items.forEach(visit); return; }
    if (!YAML.isMap(node)) return;
    const efforts = node.get('reasoningEfforts', true);
    if (YAML.isMap(efforts)) {
      const model = node.get('id');
      for (const pair of efforts.items) {
        const key = pair.key.value;
        if (allowed.has(key)) continue;
        if (!['none', 'ultra'].includes(key)) throw new Error(`Unknown unsupported reasoning key: ${key}`);
        // Change the public alias for "none" to "off", preserving its wire value.
        // Retain existing max; ultra is not a native public capability on this version.
        const rename = key === 'none' && !efforts.has('off');
        const start = pair.key.range[0];
        const lineStart = source.lastIndexOf('\n', start) + 1;
        const nextLine = source.indexOf('\n', pair.value.range[1]);
        if (rename) edits.push({ start, end: pair.key.range[1], text: 'off' });
        else edits.push({ start: lineStart, end: nextLine < 0 ? source.length : nextLine + 1, text: '' });
        models.push({ model, key, action: rename ? 'rename-to-off' : 'remove-unsupported-alias' });
      }
    }
    node.items.forEach(pair => visit(pair.value));
  };
  visit(document.contents);
  let candidate = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) candidate = candidate.slice(0, edit.start) + edit.text + candidate.slice(edit.end);
  const parsed = YAML.parseDocument(candidate, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (parsed.errors.length) throw new Error('Repaired YAML does not parse');
  return { candidate, models, data: parsed.toJS() };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const profile = path.join(process.env.USERPROFILE, '.dsh-mathmodel/profiles/mathmodel');
  const runtime = path.join(process.env.LOCALAPPDATA, 'Programs/dsh-mathmodel-desktop/resources/runtime/host/node_modules');
  const require = createRequire(path.join(runtime, '__repair__.cjs'));
  const YAML = require('yaml');
  const filename = path.join(profile, 'cordis.patch.yml');
  const original = fs.readFileSync(filename, 'utf8');
  const result = repairEffortKeys(original, YAML);
  const { Config } = await import(pathToFileURL(path.join(runtime, '@deepseek-ai/dsh-llm-pi-ai/lib/index.js')).href);
  const configs = [];
  const visit = rows => {
    for (const row of rows ?? []) {
      if (row.id === 'llm-pi-ai' && row.config) configs.push(row.config);
      if (Array.isArray(row.insert)) visit(row.insert);
    }
  };
  visit(result.data);
  if (!configs.length) throw new Error('Provider configuration not found');
  for (const config of configs) {
    try { Config(config); } catch { throw new Error('Installed adapter still rejects repaired configuration; no write performed'); }
  }
  const apply = process.argv.includes('--apply');
  let backup;
  if (apply && result.candidate !== original) {
    backup = `${filename}.bak-provider-efforts-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
    if (fs.readFileSync(filename, 'utf8') !== original) throw new Error('Profile changed during repair');
    const temporary = `${filename}.effort-repair.tmp`;
    fs.writeFileSync(temporary, result.candidate, { flag: 'wx' });
    fs.renameSync(temporary, filename);
  }
  console.log(JSON.stringify({ valid: true, applied: apply && result.candidate !== original, backup, repairs: result.models,
    providers: [...new Set(configs.flatMap(config => Object.keys(config.providers ?? {})))] }));
}
