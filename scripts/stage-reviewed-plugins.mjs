import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultLock = path.join(repo, 'scripts/reviewed-plugin-lock.json');
export const reviewedPackages = {
  '@nanmicoder/dsh-agent-teams': 'dsh-agent-teams',
  'dsh-context': 'dsh-context',
};
const excluded = new Set(['node_modules', '.git', 'test', 'tests']);

function realDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe reviewed plugin directory: ' + directory);
}

/** Seal the reviewed distribution, including source/provenance and worker entries. */
export function reviewedPluginDigest(pluginDir) {
  realDirectory(pluginDir);
  const hash = createHash('sha256');
  function walk(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      if (excluded.has(name)) continue;
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      const key = relative ? relative + '/' + name : name;
      if (stat.isSymbolicLink()) throw new Error('Unsafe reviewed plugin symlink: ' + file);
      if (stat.isDirectory()) walk(file, key);
      else if (stat.isFile()) hash.update(key + '\0').update(fs.readFileSync(file)).update('\0');
      else throw new Error('Unsupported reviewed plugin file: ' + file);
    }
  }
  walk(pluginDir);
  return hash.digest('hex');
}

function sourceRecord(pluginDir, name, lockFile) {
  if (!Object.hasOwn(reviewedPackages, name)) throw new Error('Unknown reviewed plugin identity');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json')));
  const record = JSON.parse(fs.readFileSync(lockFile)).plugins[name];
  if (manifest.name !== name || manifest.version !== record?.version) throw new Error('Reviewed plugin identity mismatch: ' + name);
  if (reviewedPluginDigest(pluginDir) !== record.sha256) throw new Error('Reviewed plugin integrity mismatch: ' + name);
  return record;
}

export function verifyReviewedPlugin(profileDir, pluginDir, name, lockFile = defaultLock) {
  const record = sourceRecord(pluginDir, name, lockFile);
  realDirectory(profileDir);
  realDirectory(path.join(profileDir, 'node_modules'));
  if (name.startsWith('@')) realDirectory(path.join(profileDir, 'node_modules', name.split('/')[0]));
  const target = path.join(profileDir, 'node_modules', ...name.split('/'));
  if (reviewedPluginDigest(target) !== record.sha256) throw new Error('Staged reviewed plugin mismatch: ' + name);
  return record;
}

export function stageReviewedPlugin(profileDir, pluginDir, name, lockFile = defaultLock) {
  sourceRecord(pluginDir, name, lockFile);
  realDirectory(profileDir);
  const modules = path.join(profileDir, 'node_modules');
  realDirectory(modules);
  const scope = name.startsWith('@') ? path.join(modules, name.split('/')[0]) : modules;
  if (!fs.existsSync(scope)) fs.mkdirSync(scope);
  realDirectory(scope);
  const target = path.join(modules, ...name.split('/'));
  if (path.dirname(path.resolve(target)) !== path.resolve(scope)) throw new Error('Reviewed plugin target escaped scope');
  if (fs.existsSync(target)) {
    realDirectory(target);
    fs.rmSync(target, { recursive: true });
  }
  fs.cpSync(pluginDir, target, { recursive: true, filter: file => !excluded.has(path.basename(file)) });
  verifyReviewedPlugin(profileDir, pluginDir, name, lockFile);
}

export function stageReviewedPlugins(profileDir) {
  for (const [name, folder] of Object.entries(reviewedPackages)) stageReviewedPlugin(profileDir, path.join(repo, 'plugins', folder), name);
}

export function verifyReviewedPlugins(profileDir) {
  for (const [name, folder] of Object.entries(reviewedPackages)) verifyReviewedPlugin(profileDir, path.join(repo, 'plugins', folder), name);
}
