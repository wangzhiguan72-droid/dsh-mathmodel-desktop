#!/usr/bin/env node
'use strict';

/**
 * Install the runtime payload (dsh host + preinstalled web profile) with the
 * pinned versions from runtime/<part>/package.json, then stage the result
 * into desktop/resources/runtime/ for electron-builder's extraResources.
 *
 * Both payloads install with a hoisted, multi-platform pnpm layout (see each
 * pnpm-workspace.yaml) so the staged trees are real files that cover every
 * shipped OS/arch and survive being copied into the user's $DSH_HOME.
 *
 * Usage: node scripts/build-runtime.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchGitGraphProfile } from './patch-git-graph.mjs';
import { patchDesktopUpdateProfile } from './patch-desktop-update-entry.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSrc = path.join(desktopDir, 'runtime');
const stagingRoot = path.join(desktopDir, 'resources', 'runtime');

/** Files copied from runtime/<part> into the staged payload. */
const PART_FILES = {
  host: ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'node_modules'],
  'profile-web': ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.patch.yml', 'node_modules'],
};

function readPinnedVersion(part, packageName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeSrc, part, 'package.json'), 'utf8'));
  const version = manifest.dependencies?.[packageName];
  if (version === undefined) throw new Error(part + '/package.json does not pin ' + packageName);
  return version;
}

function pnpmInstall(part) {
  console.log('[build-runtime] pnpm install in runtime/' + part);
  // stdio is piped and relayed: inheriting a non-TTY stdout can stall pnpm's
  // progress renderer in background job contexts.
  //
  // pnpm >= 11.24 was observed exiting 1 with empty stderr on the live
  // supply-chain policy verification of a cold install (CI runner, run
  // 33824501455), and once locally behind a flaky proxy; a second attempt
  // passes. Retry a few times and relay the captured output as text so the
  // real diagnosis is not lost to a byte-array dump.
  const attempts = 3;
  // Windows resolves pnpm through a .cmd shim, which spawnSync cannot
  // execute without a shell (ENOENT on every retry). The shell is only
  // needed there, and every argument is a constant literal, so routing
  // through cmd.exe adds no injection surface. Same fix as the dsh-trading
  // desktop runtime; failure class surfaced by release run 34077107610.
  const spawnOptions = {
    cwd: path.join(runtimeSrc, part),
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // pnpm 9 does not read these options from pnpm-workspace.yaml. Keep its
    // install layout and peer policy consistent with the existing lockfiles.
    const result = spawnSync('pnpm', [
      'install', '--config.node-linker=hoisted',
      '--config.auto-install-peers=' + String(part === 'host'),
    ], spawnOptions);
    if (result.status === 0) {
      console.log(String(result.stdout).split('\n').slice(-6).join('\n'));
      return;
    }
    console.log('[build-runtime] pnpm install failed (attempt ' + attempt + '/' + attempts + '), status=' + result.status);
    if (result.stdout) console.log(String(result.stdout).split('\n').slice(-15).join('\n'));
    if (result.stderr) console.log(String(result.stderr).split('\n').slice(-15).join('\n'));
    if (/ERR_PNPM_(?:LOCKFILE_CONFIG_MISMATCH|OUTDATED_LOCKFILE)/.test(String(result.stdout) + String(result.stderr))) {
      throw new Error('runtime/' + part + ' lockfile does not match its install configuration');
    }
    if (attempt < attempts) {
      // Synchronous, dependency-free sleep that works on every platform.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    } else result.error && console.log(result.error);
  }
  throw new Error('pnpm install kept failing in runtime/' + part + ' after ' + attempts + ' attempts');
}

/** Remove every node_modules command-shim directory (.bin) at any depth. */
function removeBinDirs(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === '.bin') fs.rmSync(full, { recursive: true, force: true });
    else removeBinDirs(full);
  }
}

/**
 * Hoist every package from pnpm's virtual store to the top level: the host
 * payload must match an npm global install's closure, and ESM resolution from
 * the host bin.js does not consult pnpm's virtual store or fallback dir (nor
 * NODE_PATH). pnpm < 11 hoisted layouts keep transitive deps inside
 * .pnpm/<name>@<version>/node_modules, which breaks `dsh` boot with
 * ERR_MODULE_NOT_FOUND. Only real package directories are hoisted (junction
 * on win32, fallback to a dereferencing copy); existing top-level entries win.
 */
function hoistPnpmFallbacks(part) {
  const root = path.join(runtimeSrc, part);
  const store = path.join(root, 'node_modules', '.pnpm');
  if (!fs.existsSync(store)) {
    console.log('[build-runtime] no .pnpm store in ' + part + ', nothing to hoist');
    return;
  }
  const sources = [];
  const fallback = path.join(store, 'node_modules');
  const pushPackageDirs = (nm) => {
    for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      if (entry.name.startsWith('@')) {
        // Scoped packages are two levels deep: node_modules/<scope>/<name>.
        const scopeDir = path.join(nm, entry.name);
        for (const child of fs.readdirSync(scopeDir, { withFileTypes: true })) {
          if (child.isDirectory()) sources.push(path.join(scopeDir, child.name));
        }
      } else {
        sources.push(path.join(nm, entry.name));
      }
    }
  };
  if (fs.existsSync(fallback)) pushPackageDirs(fallback);
  for (const project of fs.readdirSync(store, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name === 'node_modules') continue;
    const nm = path.join(store, project.name, 'node_modules');
    if (!fs.existsSync(nm)) continue;
    pushPackageDirs(nm);
  }
  let hoisted = 0;
  for (const source of sources) {
    const rel = path.relative(store, source);
    const name = rel.split('node_modules').pop().replace(/^[\\/]+/, '');
    const target = path.join(root, 'node_modules', name);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.symlinkSync(source, target, 'junction');
    } catch {
      fs.cpSync(source, target, { recursive: true, dereference: true });
    }
    hoisted++;
  }
  console.log('[build-runtime] hoisted ' + hoisted + ' package(s) from the .pnpm store in ' + part);
}

function assertNoSymlinks(root) {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) offenders.push(path.relative(root, full));
      else if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  if (offenders.length > 0) {
    throw new Error('staged payload contains symlinks (would break inside installers): ' + offenders.slice(0, 5).join(', '));
  }
}

export function copyRuntimeModules(source, destination) {
  const virtualStore = path.resolve(source, '.pnpm');
  // Hoisted runtime packages are copied as real files. An old root store
  // contains dependency junctions that would expand into redundant trees.
  // Active package links and any nested node_modules remain dereferenced.
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: entry => path.resolve(entry) !== virtualStore,
  });
  removeBinDirs(destination);
  assertNoSymlinks(destination);
}

function stage(part) {
  const dest = path.join(stagingRoot, part);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of PART_FILES[part]) {
    const source = part === 'profile-web' && name === 'cordis.patch.yml'
      ? path.join(desktopDir, 'build', 'profile.cordis.patch.yml')
      : path.join(runtimeSrc, part, name);
    if (!fs.existsSync(source)) {
      if (name === 'pnpm-lock.yaml') continue;
      throw new Error('expected ' + path.join('runtime', part, name) + ' after pnpm install');
    }
    if (name === 'node_modules') copyRuntimeModules(source, path.join(dest, name));
    else fs.cpSync(source, path.join(dest, name), { recursive: true, dereference: true });
  }
  // node_modules/.bin holds pnpm's command shims (symlinks) at any depth;
  // nothing at runtime resolves through them, and symlinks must not enter
  // the installer.
  console.log('[build-runtime] staged ' + part + ' -> ' + path.relative(desktopDir, dest));
}

// pnpm may reuse a cached file: package when its version is unchanged. Always
// stage the freshly built local plugin instead of that cached dependency.
export function stageLocalPlugin(profileDir, pluginDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  if (manifest.name !== '@deepseek-harness/dsh-mathmodel' || manifest.main !== 'lib/index.js') {
    throw new Error('Unexpected local plugin identity');
  }
  const lib = path.join(pluginDir, 'lib');
  if (!fs.lstatSync(lib).isDirectory() || fs.lstatSync(lib).isSymbolicLink()) throw new Error('Unsafe plugin build directory');
  assertNoSymlinks(lib);
  if (!fs.statSync(path.join(lib, 'index.js')).isFile()) throw new Error('Local plugin has not been built');
  const target = path.join(profileDir, 'node_modules', '@deepseek-harness', 'dsh-mathmodel');
  const scope = path.dirname(target);
  if (!fs.lstatSync(scope).isDirectory() || fs.lstatSync(scope).isSymbolicLink()) throw new Error('Unsafe plugin package scope');
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) throw new Error('Unsafe staged plugin');
    if (path.dirname(path.resolve(target)) !== path.resolve(scope)) throw new Error('Plugin target escaped staging scope');
    fs.rmSync(target, { recursive: true });
  }
  fs.mkdirSync(target);
  fs.copyFileSync(path.join(pluginDir, 'package.json'), path.join(target, 'package.json'));
  fs.cpSync(lib, path.join(target, 'lib'), { recursive: true });
}

/**
 * Align the profile's top-level @deepseek-ai framework copies with the host
 * closure: dsh-web-all's dependency dsh-better-sidebar@0.18.0 pins the whole
 * 0.1.2-rc.1 kernel cohort, whose copies shadow the 0.1.5 host closure in the
 * profile tree and break ESM imports (missing exports, old dsh-llm). pnpm
 * overrides are unavailable here (pnpm 9 ignores them in both homes; pnpm 11
 * needs the symlink privilege this machine lacks), so replace every
 * different-version @deepseek-ai copy with the host's real files.
 */
function reconcileProfileCohort(part) {
  const hostModules = path.join(runtimeSrc, 'host', 'node_modules', '@deepseek-ai');
  const profileScope = path.join(runtimeSrc, part, 'node_modules', '@deepseek-ai');
  if (!fs.existsSync(hostModules) || !fs.existsSync(profileScope)) return;
  let replaced = 0;
  for (const entry of fs.readdirSync(profileScope, { withFileTypes: true })) {
    // Junctions (created by the hoist step) report isSymbolicLink, not
    // isDirectory; both carry real package trees to reconcile.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const profilePkg = path.join(profileScope, entry.name);
    const hostPkg = path.join(hostModules, entry.name);
    if (!fs.existsSync(hostPkg)) continue;
    const versionOf = (dir) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
      } catch {
        return null;
      }
    };
    if (versionOf(profilePkg) === versionOf(hostPkg)) continue;
    fs.rmSync(profilePkg, { recursive: true, force: true });
    fs.cpSync(hostPkg, profilePkg, { recursive: true, dereference: true });
    replaced++;
  }
  if (replaced > 0) console.log('[build-runtime] reconciled ' + replaced + ' @deepseek-ai package(s) in ' + part + ' to the host closure');
}

/** A Windows PE image starts with the letters MZ. */
function isWindowsPe(file) {
  const header = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header[0] === 0x4d && header[1] === 0x5a;
}

const CLOUDFLARED_WIN_EXE_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

/**
 * The cloudflared package's postinstall installs the build machine's platform
 * binary only (bin/cloudflared); the staged profile payload must serve every
 * shipped OS. Fetch the Windows distribution under the name the package
 * resolves natively on win32 (bin/cloudflared.exe) so tunneling is
 * zero-setup there too. macOS x64 stays a runtime concern: one payload tree
 * cannot carry two same-named darwin binaries, so the tunnel plugin
 * validates the staged binary and re-fetches the matching arch on first use.
 */
export async function stageCloudflaredWindowsBinary() {
  const exe = path.join(stagingRoot, 'profile-web', 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe');
  const cached = path.join(runtimeSrc, 'cache', 'cloudflared-windows-amd64.exe');
  if (fs.existsSync(exe) && isWindowsPe(exe)) {
    console.log('[build-runtime] cloudflared.exe already staged, skipping');
    return;
  }
  // Profile staging replaces its tree. Keep the previously downloaded
  // official Windows binary outside that tree so rebuilds can work offline.
  if (fs.existsSync(cached) && isWindowsPe(cached)) {
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.copyFileSync(cached, exe);
    console.log('[build-runtime] staged cached cloudflared.exe');
    return;
  }
  console.log('[build-runtime] downloading ' + CLOUDFLARED_WIN_EXE_URL);
  try {
    const response = await fetch(CLOUDFLARED_WIN_EXE_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error('cloudflared.exe download failed: ' + response.status + ' ' + CLOUDFLARED_WIN_EXE_URL);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
      throw new Error('downloaded cloudflared.exe is not a Windows PE binary (' + buffer.length + ' bytes)');
    }
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, buffer);
    fs.writeFileSync(exe, buffer);
    console.log('[build-runtime] staged cloudflared.exe -> ' + path.relative(desktopDir, exe));
  } catch (error) {
    // cloudflared only backs the optional remote-tunnel plugin; the tunnel
    // plugin fetches a matching binary on first use, so a blocked download
    // must not fail the whole runtime build.
    console.log('[build-runtime] cloudflared.exe unavailable (optional, remote tunnel only): ' + error.message);
  }
}

function assertRuntimeEntrypoints() {
  const hostBin = path.join(stagingRoot, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(hostBin)) throw new Error('staged host is missing ' + path.relative(desktopDir, hostBin));
  const bundle = path.join(stagingRoot, 'profile-web', 'node_modules', '@linxin666', 'dsh-web-all', 'cordis.patch.yml');
  if (!fs.existsSync(bundle)) throw new Error('staged profile is missing the dsh-web-all bundle patch');
  const cloudflaredExe = path.join(stagingRoot, 'profile-web', 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe');
  if (!fs.existsSync(cloudflaredExe)) console.log('[build-runtime] WARNING: staged profile is missing ' + path.relative(desktopDir, cloudflaredExe) + ' (the windows tunnel binary; optional, remote tunnel only)');
  // The extraResources glob `node-${os}-${arch}` uses the electron-builder os
  // spelling (mac/win). electron-builder only WARNS when a source is missing,
  // and the result is an app without a runtime — assert here instead. npm
  // ships inside the official distributions; pnpm is staged by
  // scripts/fetch-pnpm.mjs so in-app plugin flows work with zero tooling.
  const nodePayloads = [
    ['node-mac-arm64', [['bin', 'node'], ['bin', 'npm'], ['bin', 'pnpm']]],
    ['node-mac-x64', [['bin', 'node'], ['bin', 'npm'], ['bin', 'pnpm']]],
    ['node-win-x64', [['node.exe'], ['npm.cmd'], ['pnpm.cmd']]],
  ];
  for (const [dir, required] of nodePayloads) {
    for (const segments of required) {
      const bin = path.join(stagingRoot, dir, ...segments);
      if (!fs.existsSync(bin)) throw new Error('staged payload is missing ' + path.relative(desktopDir, bin) + ' (electron-builder resolves node-${os}-${arch} as node-<mac|win>-<arch>)');
    }
  }
}

async function main() {
  const hostVersion = readPinnedVersion('host', '@deepseek-ai/dsh');
  const webAllVersion = readPinnedVersion('profile-web', '@linxin666/dsh-web-all');

  const pluginDir = path.join(desktopDir, 'plugins', 'dsh-mathmodel');
  const pluginBuild = spawnSync(process.execPath, [path.join(pluginDir, 'scripts', 'build.mjs')],
    { cwd: pluginDir, stdio: 'inherit', windowsHide: true });
  if (pluginBuild.status !== 0) throw new Error('Local plugin build failed');
  pnpmInstall('host');
  pnpmInstall('profile-web');
  hoistPnpmFallbacks('host');
  hoistPnpmFallbacks('profile-web');
  reconcileProfileCohort('profile-web');
  stage('host');
  stage('profile-web');
  stageLocalPlugin(path.join(stagingRoot, 'profile-web'), pluginDir);
  await patchGitGraphProfile(path.join(stagingRoot, 'profile-web'));
  await patchDesktopUpdateProfile(path.join(stagingRoot, 'profile-web'));
  await stageCloudflaredWindowsBinary();
  assertRuntimeEntrypoints();

  const stamp = {
    node: 'see .node-version markers under node-<os>-<cpu>',
    host: '@deepseek-ai/dsh@' + hostVersion,
    webAll: '@linxin666/dsh-web-all@' + webAllVersion,
    builtAt: new Date().toISOString(),
  };
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, 'VERSION.json'), JSON.stringify(stamp, null, 2) + '\n');
  console.log('[build-runtime] runtime payload ready: ' + stamp.host + ' + ' + stamp.webAll);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
