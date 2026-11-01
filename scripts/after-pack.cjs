'use strict';

// afterPack hook: copy the staged runtime payload into the packaged app with
// plain fs copies. electron-builder's extraResources copier applies the app
// directory's node_modules exclusion glob to extra files as well (the
// exclusion patterns are shared between the files and extraResources
// matchers), which silently drops both payload node_modules trees — and a
// missing extraResources source only WARNS. Copying here, with hard
// existence assertions on the destination, keeps the payload whole and the
// build loud.

const fs = require('node:fs');
const path = require('node:path');

const stagingRoot = path.join(__dirname, '..', 'resources', 'runtime');

function configureArchiveFilter(platform) {
  // Current 7z auto-selects ARM64 BCJ for bundled cross-platform helpers.
  // Use the legacy-compatible BCJ codec for Windows installer payloads.
  if (platform === 'win32' && !process.env.ELECTRON_BUILDER_7Z_FILTER) {
    process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ';
  }
}

// builder-util's Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
const OS_NAMES = { darwin: 'mac', win32: 'win', linux: 'linux' };

function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const productName = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function copyPayload(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`after-pack: staged payload is missing: ${source} (run "npm run prepare-runtime" first)`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

function assertDestFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`after-pack: packaged app is missing ${file} — the runtime payload copy is broken`);
  }
}

async function copyStagedRuntime(context, sourceRoot, fusionPluginDir, fusionLockFile) {
  const os = OS_NAMES[context.electronPlatformName];
  const cpu = ARCH_NAMES[context.arch];
  if (os === undefined || cpu === undefined) {
    throw new Error(`after-pack: unsupported target ${context.electronPlatformName}-${context.arch}`);
  }
  const root = resourcesDir(context);
  const runtimeRoot = path.join(root, 'runtime');

  // electron-builder can be invoked directly with an old resources tree.
  // Refuse it before copyPayload mutates the packaged output.
  const { verifyStagedFusion } = await import('./build-runtime.mjs');
  verifyStagedFusion(path.join(sourceRoot, 'profile-web'), fusionPluginDir, fusionLockFile);
  configureArchiveFilter(context.electronPlatformName);

  copyPayload(path.join(sourceRoot, 'host'), path.join(runtimeRoot, 'host'));
  copyPayload(path.join(sourceRoot, 'profile-web'), path.join(runtimeRoot, 'profile-web'));
  copyPayload(path.join(sourceRoot, `node-${os}-${cpu}`), path.join(runtimeRoot, 'node'));
  // The reseed contract compares the seeded profile's stamp against this file;
  // without it a packaged app would never reseed after a runtime bump.
  copyPayload(path.join(sourceRoot, 'VERSION.json'), path.join(runtimeRoot, 'VERSION.json'));

  assertDestFile(path.join(runtimeRoot, 'node', os === 'win' ? 'node.exe' : path.join('bin', 'node')));
  // The bundled toolchain (npm from the official distribution, pnpm staged by
  // fetch-pnpm.mjs) must reach the packaged app or in-app `dsh plugin` flows
  // fail on machines without preinstalled tooling.
  assertDestFile(path.join(runtimeRoot, 'node', os === 'win' ? 'npm.cmd' : path.join('bin', 'npm')));
  assertDestFile(path.join(runtimeRoot, 'node', os === 'win' ? 'pnpm.cmd' : path.join('bin', 'pnpm')));
  assertDestFile(path.join(runtimeRoot, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  assertDestFile(path.join(runtimeRoot, 'profile-web', 'node_modules', '@linxin666', 'dsh-web-all', 'cordis.patch.yml'));
  // The windows tunnel binary is optional (remote tunnel only): a blocked
  // download at build time must not fail the whole package; the tunnel plugin
  // fetches a matching binary on first use.
  const cloudflared = path.join(runtimeRoot, 'profile-web', 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe');
  if (!fs.existsSync(cloudflared)) console.log(`[after-pack] WARNING: ${path.relative(path.join(__dirname, '..'), cloudflared)} missing (optional, remote tunnel only)`);
  console.log(`[after-pack] runtime payload staged into ${path.relative(path.join(__dirname, '..'), runtimeRoot)} (${os}-${cpu})`);
}

exports.copyStagedRuntime = copyStagedRuntime;
exports.configureArchiveFilter = configureArchiveFilter;
exports.default = async context => {
  const { verifyStagedSandboxAuto } = await import('./stage-sandbox-auto.mjs');
  verifyStagedSandboxAuto(path.join(stagingRoot, 'profile-web'), path.join(__dirname, '..', 'plugins', 'dsh-auto-mode'));
  return copyStagedRuntime(context, stagingRoot, path.join(__dirname, '..', 'plugins', 'dsh-model-fusion'));
};
