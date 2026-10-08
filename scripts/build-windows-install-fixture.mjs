#!/usr/bin/env node
/** Build only the fixed-identity NSIS lifecycle fixture and bind its bytes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractFile } = require('@electron/asar');
const { build, createTargets, Platform } = require('electron-builder');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appId = 'com.deepseek.harness.mathmodel.nsis-verify-20261004';
const packageName = 'dsh-mathmodel-desktop-nsis-verify-20261004';
const product = 'DeepSeek 数学建模版 安装验证';
const guid = 'e41ec8c8-0246-5d28-b690-113fff4a1364';
const hook = path.join(repo, 'build/installer.nsh');
const extractionHook = path.join(repo, 'build/nsis/extractAppPackage.nsh');

function inside(parent, target) {
  const rel = path.relative(parent, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const part of fs.createReadStream(filename)) hash.update(part);
  return hash.digest('hex');
}

async function main() {
  assert.equal(process.platform, 'win32', 'NSIS lifecycle fixture requires Windows');
  assert.equal(process.argv.length, 4,
    'Usage: node scripts/build-windows-install-fixture.mjs <test-win-unpacked> <dist-output-directory>');
  const unpacked = fs.realpathSync.native(path.resolve(process.argv[2]));
  const output = fs.realpathSync.native(path.resolve(process.argv[3]));
  const dist = fs.realpathSync.native(path.join(repo, 'dist'));
  assert.ok(inside(dist, output), 'Output must be a dedicated directory below this repository dist');
  assert.ok(inside(output, unpacked), 'Prepackaged payload must be inside the dedicated output');
  assert.equal(path.basename(unpacked), 'win-unpacked');
  assert.ok(fs.lstatSync(unpacked).isDirectory() && !fs.lstatSync(unpacked).isSymbolicLink());
  const asar = path.join(unpacked, 'resources/app.asar');
  const appExe = path.join(unpacked, `${product}.exe`);
  assert.ok(fs.lstatSync(asar).isFile() && fs.lstatSync(appExe).isFile(), 'Test payload files are missing');
  const metadata = JSON.parse(extractFile(asar, 'package.json'));
  assert.equal(metadata.name, packageName, 'Prepackaged asar package name is not the test identity');
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  assert.equal(metadata.version, version);
  const receiptPath = path.join(output, 'installer-binding.json');
  assert.ok(!fs.existsSync(receiptPath), 'Installer binding already exists');
  assert.ok(!fs.readdirSync(output).some(name => name.toLowerCase().endsWith('.exe')),
    'Output already contains an installer');
  const originalHookHash = await sha256(hook);
  const originalExtractionHookHash = await sha256(extractionHook);
  const originalAsarHash = await sha256(asar);
  const originalExeHash = await sha256(appExe);
  const zip64 = path.join(repo, 'node_modules/electron-winstaller/vendor/7z-x64.exe');
  assert.ok(fs.existsSync(zip64), 'Existing x64 7z runtime is missing');
  process.env.ELECTRON_BUILDER_7ZIP_PATH = zip64;
  process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = '1';
  let capturedDefines;
  const artifacts = await build({
    projectDir: repo,
    prepackaged: unpacked,
    targets: createTargets([Platform.WINDOWS], 'nsis', 'x64'),
    publish: 'never',
    effectiveOptionComputed: async ([defines]) => {
      const expected = {
        APP_ID: appId, APP_GUID: guid, PRODUCT_NAME: product,
        PRODUCT_FILENAME: product, APP_PACKAGE_NAME: packageName,
        SHORTCUT_NAME: product,
      };
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(defines[key], value, `NSIS ${key} escaped the test identity`);
      }
      capturedDefines = Object.fromEntries(Object.keys(expected).map(key => [key, defines[key]]));
      return false;
    },
    config: {
      extends: './electron-builder.yml',
      appId,
      productName: product,
      extraMetadata: { name: packageName },
      directories: { output: path.relative(repo, output) },
      win: {
        executableName: product,
        target: ['nsis'],
        artifactName: `${packageName}-\${version}-win-\${arch}.\${ext}`,
      },
      nsis: { guid, shortcutName: product, include: 'build/installer.nsh',
        deleteAppDataOnUninstall: false },
    },
  });
  assert.ok(capturedDefines, 'electron-builder did not compute NSIS defines');
  const installers = artifacts.filter(candidate => candidate.toLowerCase().endsWith('.exe'));
  assert.equal(installers.length, 1, 'Expected exactly one test-only NSIS installer');
  const installer = fs.realpathSync.native(installers[0]);
  assert.ok(inside(output, installer), 'Installer escaped its dedicated output');
  assert.equal(path.basename(installer), `${packageName}-${version}-win-x64.exe`);
  assert.equal(await sha256(hook), originalHookHash, 'Production NSIS hook changed during fixture build');
  assert.equal(await sha256(extractionHook), originalExtractionHookHash, 'Extraction hook changed during fixture build');
  assert.equal(await sha256(asar), originalAsarHash, 'Prepackaged asar changed during fixture build');
  assert.equal(await sha256(appExe), originalExeHash, 'Prepackaged EXE changed during fixture build');
  const binding = {
    schema: 'dsh.nsis-lifecycle-binding/v1', appId, packageName,
    productName: product, executableName: `${product}.exe`, shortcutName: product,
    guid, version, capturedDefines,
    installer: path.basename(installer), installerSha256: await sha256(installer),
    prepackaged: path.relative(output, unpacked).replaceAll(path.sep, '/'),
    appAsarSha256: originalAsarHash, appExeSha256: originalExeHash,
    nsisHook: 'build/installer.nsh', nsisHookSha256: originalHookHash,
    nsisExtractionHook: 'build/nsis/extractAppPackage.nsh', nsisExtractionHookSha256: originalExtractionHookHash,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
  console.log(`Test-only NSIS installer: ${installer}`);
  console.log(`Identity binding: ${receiptPath}`);
}

main().catch(error => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
