import fs, { readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const DEFAULT_RUNTIME_ROOT = fileURLToPath(new URL('../resources/runtime/host/node_modules', import.meta.url));
const BEGIN = '# BEGIN DSH task capabilities v1';
const END = '# END DSH task capabilities v1';
const GROUPS = [['联网', 1, ['tool-web']], ['Skills', 2, ['skill-filesystem', 'tool-skill']], ['子代理', 4, ['delegation']], ['外部视觉/生图', 8, []]];
const STANDARD_PLUGIN_IDS = [
  'persona', 'agent-instructions', 'time-context', 'tool-bash', 'tool-pwsh',
  'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-schedule', 'skill-filesystem',
  'tool-skill', 'command-goal', 'tool-goal', 'planning', 'compaction',
  'delegation', 'tool-ask-user', 'tool-todo', 'tool-web', 'present',
  'tool-plugin-manager', 'tool-plugin-market',
];
const LEGACY_STANDARD_PLUGIN_IDS = STANDARD_PLUGIN_IDS.filter(id => !['time-context', 'tool-schedule', 'tool-plugin-market'].includes(id));
const LEGACY_MANAGED_SHA256 = '732f70039fac7f21dbc6557c56fe5e102ede059673539399665ce036d9290af1';
const parseOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
function document(yaml, text) {
  const doc = yaml.parseDocument(text, parseOptions);
  if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('; '));
  return doc;
}
function yamlAt(runtimeRoot) { return createRequire(join(runtimeRoot, '__task_capabilities__.cjs'))('yaml'); }

export function taskCapabilityPresets({ runtimeRoot = DEFAULT_RUNTIME_ROOT } = {}) {
  const yaml = yamlAt(runtimeRoot);
  const standard = document(yaml, readFileSync(join(runtimeRoot, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8'));
  const source = standard.toJS()?.[0]?.insert?.[0];
  const roster = source?.config?.plugins?.map(plugin => plugin.id);
  if (source?.id !== 'preset-standard' || !(isDeepStrictEqual(roster, STANDARD_PLUGIN_IDS) || isDeepStrictEqual(roster, LEGACY_STANDARD_PLUGIN_IDS))) {
    throw new Error('Unsupported standard preset roster; inspect upstream changes');
  }
  const blocks = [];
  const presets = [];
  for (let mask = 0; mask < 16; mask++) {
    const doc = standard.clone();
    const row = doc.contents.items[0].get('insert').items[0];
    const config = row.get('config');
    const id = `task-${mask.toString(16).padStart(2, '0')}`;
    const enabled = GROUPS.filter(group => mask & group[1]).map(group => group[0]);
    row.set('id', `preset-${id}`);
    config.set('id', id);
    config.set('name', `任务 · ${enabled.length ? enabled.join(' + ') : '基础'}`);
    config.set('description', '首轮开始前选择，开始后锁定。保留文件、终端、计划、压缩及权限。关闭模块不会向模型提供对应工具；不会自动启用 Host 的 Fusion、Teams、Auto 或 MCP，也不代表节省了费用。');
    config.set('order', 30 + mask);
    const plugins = config.get('plugins');
    const removed = GROUPS.filter(group => !(mask & group[1])).flatMap(group => group[2]);
    plugins.items = plugins.items.filter(plugin => !removed.includes(plugin.get('id')));
    plugins.add({ id: 'task-capabilities', name: '@deepseek-harness/dsh-mathmodel/capabilities', config: { images: Boolean(mask & 8) } });
    // Keep upstream !!js nodes intact; converting the whole composition to plain JSON loses their tags.
    doc.commentBefore = null;
    blocks.push(doc.toString().trimEnd());
    presets.push({ id, mask, enabled });
  }
  return { presets, yaml: `${BEGIN}\n${blocks.join('\n\n')}\n${END}\n` };
}

export function installTaskCapabilityPresets(options = {}) {
  const { runtimeRoot = DEFAULT_RUNTIME_ROOT, profilePatch, apply = false, io = fs } = options;
  const generated = taskCapabilityPresets({ runtimeRoot });
  if (!profilePatch) {
    if (apply) throw new Error('apply requires profilePatch');
    return { ...generated, applied: false, changed: true, backup: null };
  }
  const yaml = yamlAt(runtimeRoot);
  const original = readFileSync(profilePatch, 'utf8');
  const rows = document(yaml, original).toJS();
  if (!Array.isArray(rows)) throw new Error('Profile patch must be a top-level list');
  const expected = document(yaml, generated.yaml).toJS();
  const entries = value => value.flatMap(row => row?.insert ?? []);
  const owns = row => generated.presets.some(preset => row?.id === `preset-${preset.id}` || row?.config?.id === preset.id);
  const isHostSettingsRow = row => row?.id === 'mathmodel'
    && row.name === '@deepseek-harness/dsh-mathmodel'
    && Object.keys(row).every(key => ['id', 'name', 'config'].includes(key))
    && row.config?.skillRoot === "dshHomePath('skills')"
    && row.config.imageConnections?.schema === 'dsh.mathmodel.image-connections/v2'
    && Object.keys(row.config).every(key => ['skillRoot', 'imageConnections'].includes(key));
  if (rows.some(owns)) throw new Error('Task capability conflict: separate override targets a managed preset');
  const matches = entries(rows).filter(owns);
  let changed = true;
  let replacement = null;
  if (original.includes(BEGIN) || original.includes(END)) {
    const begin = original.indexOf(BEGIN), end = original.indexOf(END);
    if (begin < 0 || end < begin || begin !== original.lastIndexOf(BEGIN) || end !== original.lastIndexOf(END)) throw new Error('Task capability markers are damaged');
    const currentDoc = document(yaml, original.slice(begin, end + END.length));
    const current = currentDoc.toJS();
    // Host settings persistence appends its own mathmodel override before the
    // trailing marker comment. It is separate from the sixteen managed presets.
    const managed = current.length === expected.length + 1 && isHostSettingsRow(current.at(-1)) ? current.slice(0, -1) : current;
    if (matches.length !== 16 || managed.length !== expected.length) throw new Error('Task capability conflict: managed definitions differ');
    if (expected.every((row, i) => isDeepStrictEqual(row, managed[i]))) changed = false;
    else if (createHash('sha256').update(JSON.stringify(managed)).digest('hex') === LEGACY_MANAGED_SHA256) {
      const host = current.length > managed.length ? currentDoc.contents.items.at(-1) : null;
      const hostText = host ? original.slice(begin + host.range[0] - 2, end).trimEnd() : '';
      const newline = original.includes('\r\n') ? '\r\n' : '\n';
      const generatedBody = generated.yaml.slice(0, generated.yaml.indexOf(END)).trimEnd();
      replacement = `${original.slice(0, begin)}${generatedBody.replace(/\n/g, newline)}${hostText ? `${newline}${hostText}` : ''}${newline}${END}${original.slice(end + END.length)}`;
    } else throw new Error('Task capability conflict: managed definitions differ');
  } else if (matches.length) throw new Error('Task capability conflict: existing preset identity');
  let backup = null;
  if (apply && changed) {
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const candidate = replacement ?? `${original}${original.endsWith('\n') ? '' : newline}${newline}${generated.yaml.replace(/\n/g, newline)}`;
    document(yaml, candidate);
    backup = `${profilePatch}.bak-capabilities-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (io.existsSync(backup)) throw new Error('Task capability backup already exists');
    io.copyFileSync(profilePatch, backup);
    const temporary = join(dirname(profilePatch), `.${basename(profilePatch)}.capabilities-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = io.openSync(temporary, 'wx');
      io.writeFileSync(handle, candidate, 'utf8');
      io.fsyncSync(handle);
      io.closeSync(handle);
      handle = undefined;
      io.renameSync(temporary, profilePatch);
    } catch (error) {
      if (handle !== undefined) { try { io.closeSync(handle); } catch {} }
      try { io.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
      throw error;
    }
  }
  return { ...generated, applied: apply && changed, changed, backup };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--apply') options.apply = true;
      else if (arg === '--runtime-root' || arg === '--profile-patch') {
        if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${arg} requires a path`);
        options[arg === '--runtime-root' ? 'runtimeRoot' : 'profilePatch'] = resolve(process.argv[++i]);
      } else throw new Error(`Unknown argument: ${arg}`);
    }
    process.stdout.write(`${JSON.stringify(installTaskCapabilityPresets(options), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
