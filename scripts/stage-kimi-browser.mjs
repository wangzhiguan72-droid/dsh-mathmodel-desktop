import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultLock = path.join(desktopDir, 'scripts', 'kimi-browser-vendor-lock.json');
const assets = ['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'lib', 'src', 'scripts'];

function assertRealTree(full) {
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw new Error('Unsafe symlink in Kimi browser plugin: ' + full);
  if (stat.isFile()) return;
  if (!stat.isDirectory()) throw new Error('Unsupported Kimi browser asset: ' + full);
  for (const name of fs.readdirSync(full)) assertRealTree(path.join(full, name));
}

export function kimiBrowserDigest(pluginDir) {
  const hash = createHash('sha256');
  const walk = (full, relative) => {
    assertRealTree(full);
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) walk(path.join(full, name), relative + '/' + name);
    } else {
      hash.update(relative + '\0');
      hash.update(fs.readFileSync(full));
      hash.update('\0');
    }
  };
  for (const asset of assets) walk(path.join(pluginDir, asset), asset);
  return hash.digest('hex');
}

function verifySource(pluginDir, lockFile) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  if (manifest.name !== '@dsh-external/dsh-better-browser' || manifest.version !== '0.3.6' || manifest.main !== './lib/index.js') {
    throw new Error('Unexpected Kimi browser plugin identity');
  }
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const digest = kimiBrowserDigest(pluginDir);
  if (lock.sha256 !== digest) throw new Error('Kimi browser vendor integrity mismatch');
  return digest;
}

export function verifyStagedKimiBrowser(profileDir, pluginDir, lockFile = defaultLock) {
  const digest = verifySource(pluginDir, lockFile);
  const target = path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-better-browser');
  if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) {
    throw new Error('Missing or unsafe staged Kimi browser plugin');
  }
  if (kimiBrowserDigest(target) !== digest) throw new Error('Staged Kimi browser plugin mismatch');
  if (fs.existsSync(path.join(target, 'node_modules'))) throw new Error('Staged Kimi browser plugin contains development node_modules');
  return digest;
}

export function stageKimiBrowserPlugin(profileDir, pluginDir, lockFile = defaultLock) {
  verifySource(pluginDir, lockFile);
  const modules = path.join(profileDir, 'node_modules');
  if (!fs.lstatSync(modules).isDirectory() || fs.lstatSync(modules).isSymbolicLink()) {
    throw new Error('Unsafe Kimi browser staging node_modules');
  }
  const scope = path.join(modules, '@dsh-external');
  if (fs.existsSync(scope) && (!fs.lstatSync(scope).isDirectory() || fs.lstatSync(scope).isSymbolicLink())) {
    throw new Error('Unsafe Kimi browser staging scope');
  }
  fs.mkdirSync(scope, { recursive: true });
  const target = path.join(scope, 'dsh-better-browser');
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('Unsafe staged Kimi browser plugin');
    }
    fs.rmSync(target, { recursive: true });
  }
  fs.mkdirSync(target);
  for (const asset of assets) fs.cpSync(path.join(pluginDir, asset), path.join(target, asset), { recursive: true });
  verifyStagedKimiBrowser(profileDir, pluginDir, lockFile);
  console.log('[build-runtime] staged Kimi browser -> ' + path.relative(desktopDir, target));
}

