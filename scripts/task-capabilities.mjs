import fs, { readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

const DEFAULT_RUNTIME_ROOT = fileURLToPath(new URL('../resources/runtime/host/node_modules', import.meta.url));
const BEGIN = '# BEGIN DSH task capabilities v2';
const END = '# END DSH task capabilities v2';
const BEGIN_V1 = '# BEGIN DSH task capabilities v1';
const END_V1 = '# END DSH task capabilities v1';
// Digests of the sixteen-row v1 blocks this desktop ever wrote (0.1.6 roster, 0.2.0 roster).
const V1_MANAGED_SHA256 = new Set([
  '732f70039fac7f21dbc6557c56fe5e102ede059673539399665ce036d9290af1',
  '7bc610548752387e5d45546affbfedbd22ef3aefee9c2d8882a335daa4685e2e',
]);
const LEGACY_PRESET = /"(?:agentPreset|presetId|preset)":"task-0[0-9a-f]"/;
export const STANDARD_PLUGIN_IDS = [
  'persona', 'agent-instructions', 'time-context', 'tool-bash', 'tool-pwsh',
  'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-schedule', 'skill-filesystem',
  'tool-skill', 'command-goal', 'tool-goal', 'planning', 'compaction',
  'delegation', 'tool-ask-user', 'tool-todo', 'tool-web', 'present',
  'tool-plugin-manager', 'tool-plugin-market',
];
const LEGACY_STANDARD_PLUGIN_IDS = STANDARD_PLUGIN_IDS.filter(id => !['time-context', 'tool-schedule', 'tool-plugin-market'].includes(id));
const parseOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
export function document(yaml, text) {
  const doc = yaml.parseDocument(text, parseOptions);
  if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('; '));
  return doc;
}
export function yamlAt(runtimeRoot) { return createRequire(join(runtimeRoot, '__task_capabilities__.cjs'))('yaml'); }

/** Clone the bundled standard preset as a YAML document, keeping its `!!js` nodes. */
export function standardPresetDocument(runtimeRoot) {
  const yaml = yamlAt(runtimeRoot);
  const standard = document(yaml, readFileSync(join(runtimeRoot, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8'));
  const source = standard.toJS()?.[0]?.insert?.[0];
  const roster = source?.config?.plugins?.map(plugin => plugin.id);
  if (source?.id !== 'preset-standard' || !(isDeepStrictEqual(roster, STANDARD_PLUGIN_IDS) || isDeepStrictEqual(roster, LEGACY_STANDARD_PLUGIN_IDS))) {
    throw new Error('Unsupported standard preset roster; inspect upstream changes');
  }
  const doc = standard.clone();
  doc.commentBefore = null;
  const row = doc.contents.items[0].get('insert').items[0];
  return { doc, row, config: row.get('config'), plugins: row.get('config').get('plugins') };
}

/** Swap the native delegation group for the handoff plugin, in place. */
export function replaceDelegation(doc, plugins) {
  const index = plugins.items.findIndex(plugin => plugin.get('id') === 'delegation');
  if (index < 0) throw new Error('Standard preset has no delegation group');
  plugins.items.splice(index, 1, doc.createNode({ id: 'handoff', name: '@deepseek-harness/dsh-mathmodel/handoff' }));
}

export function taskCapabilityPresets({ runtimeRoot = DEFAULT_RUNTIME_ROOT } = {}) {
  const { doc, row, config, plugins } = standardPresetDocument(runtimeRoot);
  row.set('id', 'preset-task');
  config.set('id', 'task');
  config.set('name', '任务');
  config.set('description', '保留文件、终端、计划、压缩及权限。联网、Skills、子代理交接、外部视觉/生图在「能力组合」面板按任务开关；首轮前关闭会移除工具，首轮后关闭只禁止调用。不会自动启用 Host 的 Fusion、Teams、Auto 或 MCP。');
  config.set('order', 30);
  replaceDelegation(doc, plugins);
  plugins.add({ id: 'task-capabilities', name: '@deepseek-harness/dsh-mathmodel/capabilities', config: { images: true } });
  return { presets: [{ id: 'task' }], yaml: `${BEGIN}\n${doc.toString().trimEnd()}\n${END}\n` };
}

/** Session logs are runs of zstd frames, or plain JSONL when compression is off. */
export function findLegacyPresetSessions(sessionsDir) {
  const found = [];
  const walk = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) {
        // Fail closed: a log we cannot read counts as referencing the old presets.
        const text = logText(path);
        if (text === null || LEGACY_PRESET.test(text)) found.push(path);
      }
    }
  };
  walk(sessionsDir);
  return found;
}
function logText(path) {
  try {
    const buffer = readFileSync(path);
    return path.endsWith('.zstd') ? framesText(buffer) : buffer.toString('utf8');
  } catch { return null; }
}
// zstdDecompressSync decodes only the first frame and returns partial output for a truncated one,
// so walk frame boundaries from the headers (RFC 8878 §3.1) and decode each frame on its own.
// Null when the layout does not add up.
function framesText(buffer) {
  const texts = [];
  let at = 0;
  while (at < buffer.length) {
    if (at + 4 > buffer.length) return null;
    const magic = buffer.readUInt32LE(at);
    if ((magic & 0xfffffff0) === 0x184d2a50) { // skippable frame
      if (at + 8 > buffer.length) return null;
      at += 8 + buffer.readUInt32LE(at + 4);
      continue;
    }
    if (magic !== 0xfd2fb528 || at + 5 > buffer.length) return null;
    const descriptor = buffer[at + 4], single = (descriptor >> 5) & 1, fcsFlag = descriptor >> 6;
    let end = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + [single, 2, 4, 8][fcsFlag];
    for (let last = 0; !last;) {
      if (end + 3 > buffer.length) return null;
      const header = buffer.readUIntLE(end, 3), type = (header >> 1) & 3;
      if (type === 3) return null;
      last = header & 1;
      end += 3 + (type === 1 ? 1 : header >>> 3);
    }
    if ((descriptor >> 2) & 1) end += 4;
    if (end > buffer.length) return null;
    texts.push(zstdDecompressSync(buffer.subarray(at, end)).toString('utf8'));
    at = end;
  }
  return texts.join('');
}
const isHostSettingsRow = row => row?.id === 'mathmodel'
  && row.name === '@deepseek-harness/dsh-mathmodel'
  && Object.keys(row).every(key => ['id', 'name', 'config'].includes(key))
  && row.config?.skillRoot === "dshHomePath('skills')"
  && row.config.imageConnections?.schema === 'dsh.mathmodel.image-connections/v2'
  && Object.keys(row.config).every(key => ['skillRoot', 'imageConnections'].includes(key));

/** Locate one marker-delimited block; the Host may append its own settings row before the end marker. */
export function managedBlock(yaml, original, begin, end) {
  if (!original.includes(begin) && !original.includes(end)) return null;
  const from = original.indexOf(begin), to = original.indexOf(end);
  if (from < 0 || to < from || from !== original.lastIndexOf(begin) || to !== original.lastIndexOf(end)) throw new Error(`Managed block markers are damaged: ${begin}`);
  const doc = document(yaml, original.slice(from, to + end.length));
  const current = doc.toJS() ?? [];
  const hasHost = current.length > 0 && isHostSettingsRow(current.at(-1));
  const host = hasHost ? doc.contents.items.at(-1) : null;
  return { from, to, managed: hasHost ? current.slice(0, -1) : current, hostText: host ? original.slice(from + host.range[0] - 2, to).trimEnd() : '' };
}

export function replaceBlock(original, block, end, generatedYaml, generatedEnd) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const body = generatedYaml.slice(0, generatedYaml.indexOf(generatedEnd)).trimEnd().replace(/\n/g, newline);
  return `${original.slice(0, block.from)}${body}${block.hostText ? `${newline}${block.hostText}` : ''}${newline}${generatedEnd}${original.slice(block.to + end.length)}`;
}

/** Drop a block; a Host settings row parked inside it stays, as a plain row. */
export function removeBlock(original, block, end) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const before = original.slice(0, block.from).replace(/(\r?\n)+$/, newline);
  const after = original.slice(block.to + end.length).replace(/^(\r?\n)+/, newline);
  return `${before}${block.hostText ? `${block.hostText}${newline}` : ''}${after}`;
}

export function appendBlock(original, generatedYaml) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  return `${original}${original.endsWith('\n') ? '' : newline}${newline}${generatedYaml.replace(/\n/g, newline)}`;
}

/** Back up, then replace the patch through a synced temporary file. */
export function writePatch(profilePatch, candidate, { io = fs, yaml, suffix }) {
  document(yaml, candidate);
  const backup = `${profilePatch}.bak-${suffix}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (io.existsSync(backup)) throw new Error('Profile patch backup already exists');
  io.copyFileSync(profilePatch, backup);
  const temporary = join(dirname(profilePatch), `.${basename(profilePatch)}.${suffix}-${randomUUID()}.tmp`);
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
  return backup;
}

export function installTaskCapabilityPresets(options = {}) {
  const { runtimeRoot = DEFAULT_RUNTIME_ROOT, profilePatch, sessionsDir, apply = false, io = fs } = options;
  const generated = taskCapabilityPresets({ runtimeRoot });
  const result = (fields) => ({ ...generated, applied: false, changed: false, backup: null, migrated: false, ...fields });
  if (!profilePatch) {
    if (apply) throw new Error('apply requires profilePatch');
    return result({ changed: true });
  }
  const yaml = yamlAt(runtimeRoot);
  const original = readFileSync(profilePatch, 'utf8');
  const rows = document(yaml, original).toJS();
  if (!Array.isArray(rows)) throw new Error('Profile patch must be a top-level list');
  const expected = document(yaml, generated.yaml).toJS();
  const owns = row => row?.id === 'preset-task' || row?.config?.id === 'task';
  if (rows.some(owns)) throw new Error('Task capability conflict: separate override targets a managed preset');
  let candidate, migrated = false, skipped;
  const current = managedBlock(yaml, original, BEGIN, END);
  const legacy = managedBlock(yaml, original, BEGIN_V1, END_V1);
  if (current && !(current.managed.length === expected.length && expected.every((row, i) => isDeepStrictEqual(row, current.managed[i])))) {
    throw new Error('Task capability conflict: managed definitions differ');
  }
  if (legacy) {
    // Old sessions or a hand-edited block keep v1; v2 sits beside it until v1 can go.
    if (!V1_MANAGED_SHA256.has(createHash('sha256').update(JSON.stringify(legacy.managed)).digest('hex'))) skipped = '旧 task 预设块被手动修改过，保留未删';
    else {
      const referenced = sessionsDir ? findLegacyPresetSessions(sessionsDir) : [];
      if (referenced.length) skipped = `有 ${referenced.length} 个会话引用旧 task 预设，旧预设保留未删`;
    }
    if (skipped && current) return result({ skipped });
    if (skipped) candidate = appendBlock(original, generated.yaml);
    else if (current) { candidate = removeBlock(original, legacy, END_V1); migrated = true; }
    else { candidate = replaceBlock(original, legacy, END_V1, generated.yaml, END); migrated = true; }
  } else if (current) return result({});
  else {
    if (rows.flatMap(row => row?.insert ?? []).some(owns)) throw new Error('Task capability conflict: existing preset identity');
    candidate = appendBlock(original, generated.yaml);
  }
  if (!apply) return result({ changed: true, migrated, skipped });
  return result({ changed: true, applied: true, migrated, skipped, backup: writePatch(profilePatch, candidate, { io, yaml, suffix: 'capabilities' }) });
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--apply') options.apply = true;
      else if (arg === '--runtime-root' || arg === '--profile-patch' || arg === '--sessions-dir') {
        if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${arg} requires a path`);
        options[{ '--runtime-root': 'runtimeRoot', '--profile-patch': 'profilePatch', '--sessions-dir': 'sessionsDir' }[arg]] = resolve(process.argv[++i]);
      } else throw new Error(`Unknown argument: ${arg}`);
    }
    process.stdout.write(`${JSON.stringify(installTaskCapabilityPresets(options), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
