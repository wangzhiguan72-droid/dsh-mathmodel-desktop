import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const fusionId = 'dsh-model-fusion';
export function migrateFusionBundle({ profileDir, runtimeRoot, apply = false }) {
  const yaml = createRequire(path.join(runtimeRoot, '__fusion_migration__.cjs'))('yaml');
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const manifestFile = path.join(profileDir, 'package.json');
  const originalPatch = fs.readFileSync(patchFile, 'utf8');
  const originalManifest = fs.readFileSync(manifestFile, 'utf8');
  const parse = source => {
    const doc = yaml.parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
    if (doc.errors.length || !yaml.isSeq(doc.contents)) throw new Error('Fusion migration requires a valid patch sequence');
    return doc;
  };
  const doc = parse(originalPatch);
  const matches = [];
  for (const [rowIndex, row] of doc.contents.items.entries()) {
    if (!yaml.isMap(row)) throw new Error('Unsupported profile patch row');
    const insert = row.get('insert', true);
    if (!insert) continue;
    if (!yaml.isSeq(insert)) throw new Error('Unsupported profile insert list');
    for (const [itemIndex, item] of insert.items.entries()) {
      if (yaml.isMap(item) && item.get('id') === fusionId) {
        if (item.get('name') !== fusionId) throw new Error('Fusion ID belongs to another module');
        matches.push({ rowIndex, row, insert, itemIndex, item });
      }
    }
  }
  if (matches.length > 1) throw new Error('Multiple manual Fusion loaders require review');
  if (!matches.length) return { changed: false, applied: false, backups: [] };
  const { rowIndex, row, insert, itemIndex, item } = matches[0];
  const override = item.clone();
  // Preserve override order: later personal overrides still win in the loader.
  if (insert.items.length === 1) {
    if (row.items.length !== 1) throw new Error('Ambiguous insert patch structure');
    override.commentBefore = [row.commentBefore, override.commentBefore].filter(Boolean).join('\n') || undefined;
    doc.contents.items.splice(rowIndex, 1, override);
  } else {
    insert.items.splice(itemIndex, 1);
    doc.contents.items.splice(rowIndex + 1, 0, override);
  }
  let disabled = item.get('disabled');
  for (const later of doc.contents.items.slice(rowIndex + 1)) {
    if (later.get?.('id') === fusionId && later.has('disabled')) disabled = later.get('disabled');
  }
  if (disabled !== undefined && typeof disabled !== 'boolean') throw new Error('Dynamic Fusion disable expression requires review');
  const manifest = JSON.parse(originalManifest);
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) throw new Error('Profile bundle selection is malformed');
  if (disabled !== true && !bundles.includes(fusionId)) bundles.push(fusionId);
  const nextPatch = doc.toString({ lineWidth: 0 });
  const nextManifest = JSON.stringify(manifest, null, 2) + '\n';
  parse(nextPatch);
  const result = { changed: true, applied: false, bundleSelected: bundles.includes(fusionId), backups: [] };
  if (!apply) return result;
  const suffix = `.bak-fusion-bundle-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const writes = [[manifestFile, originalManifest, nextManifest], [patchFile, originalPatch, nextPatch]]
    .filter(([, before, after]) => before !== after);
  for (const [filename] of writes) {
    fs.copyFileSync(filename, filename + suffix, fs.constants.COPYFILE_EXCL);
    result.backups.push(filename + suffix);
  }
  const atomic = (filename, source) => {
    const temp = filename + `.fusion-${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, source, { flag: 'wx' }); fs.renameSync(temp, filename); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  };
  const committed = [];
  try {
    for (const [filename, before, after] of writes) { atomic(filename, after); committed.push([filename, before]); }
  } catch (error) {
    for (const [filename, before] of committed.reverse()) atomic(filename, before);
    throw error;
  }
  result.applied = true;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [profileDir, runtimeRoot, action] = process.argv.slice(2);
  if (!profileDir || !runtimeRoot || action && action !== '--apply') throw new Error('Usage: profileDir runtimeRoot [--apply]');
  console.log(JSON.stringify(migrateFusionBundle({ profileDir: path.resolve(profileDir), runtimeRoot: path.resolve(runtimeRoot), apply: action === '--apply' })));
}
