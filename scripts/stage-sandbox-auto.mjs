import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultLock = path.join(desktopDir, 'scripts', 'sandbox-auto-vendor-lock.json');
const assets = ['package.json', 'compatibility.json', 'cordis.patch.yml', 'README_ZH.md', 'LICENSE', 'lib'];

function assertRealTree(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error('Unsafe symlink in sandbox Auto plugin: ' + root);
  if (!stat.isDirectory()) {
    if (!stat.isFile()) throw new Error('Unsupported sandbox Auto asset: ' + root);
    return;
  }
  for (const entry of fs.readdirSync(root)) assertRealTree(path.join(root, entry));
}

export function sandboxAutoDigest(pluginDir) {
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
  if (manifest.name !== '@nanmicoder/dsh-auto-mode' || manifest.version !== '0.2.0' || manifest.main !== './lib/index.js') {
    throw new Error('Unexpected sandbox Auto plugin identity');
  }
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  if (lock.sha256 !== sandboxAutoDigest(pluginDir)) throw new Error('Sandbox Auto vendor integrity mismatch');
  return lock.sha256;
}

export function verifyStagedSandboxAuto(profileDir, pluginDir, lockFile = defaultLock) {
  const digest = verifySource(pluginDir, lockFile);
  const target = path.join(profileDir, 'node_modules', '@nanmicoder', 'dsh-auto-mode');
  if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) {
    throw new Error('Missing or unsafe staged sandbox Auto plugin');
  }
  if (sandboxAutoDigest(target) !== digest) throw new Error('Staged sandbox Auto plugin mismatch');
  return digest;
}

export function stageSandboxAutoPlugin(profileDir, pluginDir, lockFile = defaultLock) {
  verifySource(pluginDir, lockFile);
  const modules = path.join(profileDir, 'node_modules');
  if (!fs.lstatSync(modules).isDirectory() || fs.lstatSync(modules).isSymbolicLink()) {
    throw new Error('Unsafe sandbox Auto staging node_modules');
  }
  const scope = path.join(modules, '@nanmicoder');
  if (fs.existsSync(scope) && (!fs.lstatSync(scope).isDirectory() || fs.lstatSync(scope).isSymbolicLink())) {
    throw new Error('Unsafe sandbox Auto staging scope');
  }
  fs.mkdirSync(scope, { recursive: true });
  const target = path.join(scope, 'dsh-auto-mode');
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('Unsafe staged sandbox Auto plugin');
    }
    fs.rmSync(target, { recursive: true });
  }
  fs.mkdirSync(target);
  for (const asset of assets) fs.cpSync(path.join(pluginDir, asset), path.join(target, asset), { recursive: true });
  verifyStagedSandboxAuto(profileDir, pluginDir, lockFile);
  console.log('[build-runtime] staged sandbox Auto -> ' + path.relative(desktopDir, target));
}

// The seed keeps file:..\..\plugins\dsh-auto-mode: npm 0.2.0 lacks the rc.5
// adaptation, and applyProfileSeed provides that folder from the seeded copy.
export function assertSandboxAutoProfileManifest(profileDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  if (!String(manifest.dependencies?.['@nanmicoder/dsh-auto-mode']).startsWith('file:')) {
    throw new Error('Expected local sandbox Auto dependency');
  }
}
