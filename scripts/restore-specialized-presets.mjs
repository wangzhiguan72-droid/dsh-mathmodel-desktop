import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_RUNTIME_ROOT = resolve(fileURLToPath(new URL('../resources/runtime/host/node_modules', import.meta.url)));
const MARKER_START = '# BEGIN DSH specialized presets (restore-specialized-presets.mjs)';
const MARKER_END = '# END DSH specialized presets';
// Fingerprints of the three generated 0.2.0-rc.2 rows, parsed with the !!js tag intact.
const LEGACY_ROW_HASHES = [
  '7b0315351ede3d946f4d6daf3370d8b2aae8336874ded3d4dfc4179c1a89fdce',
  '7c8951b48a8fe8e477331a1c28df0b1059fae6cd6c9a9e5b133a315cc3770181',
  '909bc0f5e7a355945e7f91e47d182344e651edd90d06f0b7c9141add98f30aa7',
];
const PRESETS = [
  {
    id: 'mathmodel', order: 20,
    prefix: 'You are a Chinese-first mathematical modeling agent powered by {{model}}.',
    suffix: 'Your working directory is {{cwd}}. Strictly separate facts, assumptions, methods, evidence, and conclusions. Never fabricate data, citations, experiments, scores, or verification. Prefer official competition rules and user-provided materials. Use the configured manual Skills for ideation, modeling, reproducible computation, publication-quality figures, integrity review, writing, and final PDF delivery. For card-configured work, honor every locked option and do not ask it again. Continue autonomously through safe reversible steps; stop only when irreplaceable problem data, official rules, or user authority is missing.',
  },
  {
    id: 'imagegen', order: 21,
    prefix: 'You are a coding agent powered by the {{model}} model.',
    suffix: 'Your working directory is {{cwd}}.',
  },
  {
    id: 'editable-ppt', order: 22,
    prefix: '你是由 {{model}} 驱动的可编辑 PowerPoint 重建 Agent，',
    suffix: '工作目录为 {{cwd}}。遇到视觉幻灯片转可编辑 PPT 的请求，按需加载 image-to-editable-ppt，并将该 Skill 及其引用资源作为唯一流程与质量权威，不得复述、削弱或绕过。以源图保真和对象级真可编辑为优先；无法可靠识图时不得猜测或降级，只有 Skill 的最终组装与验证成功后才能宣告完成。本模式的图像后端固定为 DSH 当前生图连接：任务开始时锁定，所有图像调用只用 editable_ppt_image，禁止 Codex 和任何后端回退。',
  },
];

function argsFrom(argv) {
  const options = { runtimeRoot: DEFAULT_RUNTIME_ROOT, apply: false, format: 'json' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime-root' || arg === '--profile-patch' || arg === '--format') {
      if (!argv[i + 1]) throw new Error(`${arg} needs a value`);
      options[arg === '--runtime-root' ? 'runtimeRoot' : arg === '--profile-patch' ? 'profilePatch' : 'format'] = resolve(argv[++i]);
      if (arg === '--format') options.format = argv[i];
    } else if (arg === '--apply') options.apply = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['json', 'yaml'].includes(options.format)) throw new Error('--format must be json or yaml');
  if (options.apply && !options.profilePatch) throw new Error('--apply requires --profile-patch');
  return options;
}

function yamlAt(runtimeRoot) {
  const require = createRequire(join(runtimeRoot, '__preset_migration__.cjs'));
  return require('yaml');
}

function parse(yaml, source, label) {
  const doc = yaml.parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ jsExpression: value }) }] });
  if (doc.errors.length) throw new Error(`${label}: ${doc.errors.map(error => error.message).join('; ')}`);
  return doc.toJS();
}

function presetRows(rows) {
  return rows.flatMap(row => Array.isArray(row?.insert) ? row.insert : []);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

function rowHash(row) {
  return createHash('sha256').update(JSON.stringify(sorted(row))).digest('hex');
}

function generate(standardSource, yaml) {
  const rows = presetRows(parse(yaml, standardSource, 'standard.patch.yml'));
  if (rows.length !== 1 || rows[0].id !== 'preset-standard' || rows[0].name !== '@deepseek-ai/dsh-agent-preset') {
    throw new Error('Unexpected standard preset shape');
  }
  const plugins = rows[0].config?.plugins;
  if (!Array.isArray(plugins) || plugins[0]?.id !== 'persona' || plugins[0]?.name !== '@deepseek-ai/dsh-persona') {
    throw new Error('Standard preset has no expected persona/plugins');
  }
  if (!standardSource.includes('    - id: preset-standard\n') || !standardSource.includes('        id: standard\n')) {
    throw new Error('Unexpected standard preset layout');
  }
  const blocks = PRESETS.map(preset => {
    const latestPersona = !standardSource.includes('suffix: Your working directory is {{cwd}}.');
    const suffix = latestPersona ? preset.suffix.replace('Your working directory is {{cwd}}. ', '').replace('Your working directory is {{cwd}}.', '').replace('工作目录为 {{cwd}}。', '') : preset.suffix;
    const source = standardSource
      .replace('    - id: preset-standard\n', `    - id: preset-${preset.id}\n`)
      .replace('        id: standard\n', `        id: ${preset.id}\n`)
      .replace('        order: 1\n', `        order: ${preset.order}\n`)
      .replace('              suffix: Your working directory is {{cwd}}.\n', `              suffix: ${JSON.stringify(preset.suffix)}\n`)
      .replace('              prefix: You are a coding agent powered by the {{model}} model.\n', `              prefix: ${JSON.stringify(preset.prefix)}\n${latestPersona && suffix ? `              suffix: ${JSON.stringify(suffix)}\n` : ''}`);
    const produced = presetRows(parse(yaml, source, `preset-${preset.id}`));
    if (produced.length !== 1 || produced[0].config?.id !== preset.id || produced[0].config?.plugins?.length !== plugins.length) {
      throw new Error(`Generated ${preset.id} does not match standard plugin roster`);
    }
    if (produced[0].config.plugins.some((plugin, i) => plugin.id !== plugins[i].id || plugin.name !== plugins[i].name)) {
      throw new Error(`Generated ${preset.id} changes the standard plugin roster`);
    }
    return source.replace(/^#.*\r?\n/gm, '').trimEnd();
  });
  return `${MARKER_START}\n# Derived from the bundled DSH standard preset; only identity, order and Persona differ.\n${blocks.join('\n\n')}\n${MARKER_END}\n`;
}

export function restoreSpecializedPresets(options = {}) {
  options = { runtimeRoot: DEFAULT_RUNTIME_ROOT, apply: false, format: 'json', ...options };
  if (options.apply && !options.profilePatch) throw new Error('--apply requires --profile-patch');
  const yaml = yamlAt(options.runtimeRoot);
  const standardPath = join(options.runtimeRoot, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml');
  const standardSource = readFileSync(standardPath, 'utf8').replace(/\r\n/g, '\n');
  const generated = generate(standardSource, yaml);
  let changed = false;
  let backup = null;
  if (options.profilePatch) {
    const original = readFileSync(options.profilePatch, 'utf8');
    const rows = presetRows(parse(yaml, original, options.profilePatch));
    const existing = PRESETS.filter(preset => rows.some(row => row.id === `preset-${preset.id}` || row.config?.id === preset.id));
    if (original.includes(MARKER_START) || original.includes(MARKER_END)) {
      const begin = original.indexOf(MARKER_START);
      const end = original.indexOf(MARKER_END);
      if (begin < 0 || end < begin || end !== original.lastIndexOf(MARKER_END)) throw new Error('Specialized preset markers are damaged');
      const current = original.slice(begin, end + MARKER_END.length);
      const currentRows = parse(yaml, current, 'managed preset block');
      const expectedRows = parse(yaml, generated, 'generated preset block');
      const trailingRows = Array.isArray(currentRows) ? currentRows.slice(expectedRows.length) : [];
      const duplicates = presetRows(trailingRows).some(row => PRESETS.some(preset =>
        row.id === `preset-${preset.id}` || row.config?.id === preset.id));
      const isCurrent = Array.isArray(currentRows) && currentRows.length >= expectedRows.length && !duplicates &&
        expectedRows.every((row, index) => isDeepStrictEqual(row, currentRows[index]));
      const isLegacy = Array.isArray(currentRows) && currentRows.length >= expectedRows.length && !duplicates &&
        LEGACY_ROW_HASHES.every((hash, index) => rowHash(currentRows[index]) === hash);
      if (!isCurrent && !isLegacy) {
        throw new Error('Managed preset block differs; inspect it before changing');
      }
      if (isLegacy) {
        changed = true;
        if (options.apply) {
          const newline = original.includes('\r\n') ? '\r\n' : '\n';
          const backupPath = `${options.profilePatch}.bak-specialized-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          if (existsSync(backupPath)) throw new Error(`Backup exists: ${backupPath}`);
          const block = original.slice(begin, end + MARKER_END.length);
          const topLevelRows = [...block.matchAll(/^-[ \t]/gm)];
          const trailing = topLevelRows.length > expectedRows.length
            ? block.slice(topLevelRows[expectedRows.length].index, block.lastIndexOf(MARKER_END))
            : '';
          const replacement = generated.replace(/\n/g, newline).replace(`${MARKER_END}${newline}`, `${trailing}${MARKER_END}${newline}`);
          const next = `${original.slice(0, begin)}${replacement.slice(0, -newline.length)}${original.slice(end + MARKER_END.length)}`;
          parse(yaml, next, options.profilePatch);
          copyFileSync(options.profilePatch, backupPath);
          backup = backupPath;
          writeFileSync(options.profilePatch, next, 'utf8');
        }
      }
    } else if (existing.length) {
      throw new Error(`Profile already defines specialized preset: ${existing.map(row => row.id).join(', ')}`);
    } else {
      changed = true;
      if (options.apply) {
        const newline = original.includes('\r\n') ? '\r\n' : '\n';
        const backupPath = `${options.profilePatch}.bak-specialized-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        if (existsSync(backupPath)) throw new Error(`Backup exists: ${backupPath}`);
        copyFileSync(options.profilePatch, backupPath);
        backup = backupPath;
        const addition = generated.replace(/\n/g, newline);
        writeFileSync(options.profilePatch, `${original}${original.endsWith(newline) ? '' : newline}${newline}${addition}`, 'utf8');
        parse(yaml, readFileSync(options.profilePatch, 'utf8'), options.profilePatch);
      }
    }
  }
  const result = { runtimeRoot: options.runtimeRoot, profilePatch: options.profilePatch ?? null, applied: options.apply && changed, changed, backup, presetIds: PRESETS.map(preset => preset.id), yaml: generated };
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argsFrom(process.argv.slice(2));
    const result = restoreSpecializedPresets(options);
    process.stdout.write(options.format === 'yaml' ? result.yaml : `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
