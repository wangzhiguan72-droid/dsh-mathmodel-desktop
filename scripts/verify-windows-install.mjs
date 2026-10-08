#!/usr/bin/env node
/** Exercise a uniquely identified NSIS installer without touching the user's app. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { UUID } = require('builder-util-runtime');
const { extractFile } = require('@electron/asar');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appId = 'com.deepseek.harness.mathmodel.nsis-verify-20261004';
const packageName = 'dsh-mathmodel-desktop-nsis-verify-20261004';
const product = 'DeepSeek 数学建模版 安装验证';
const executable = `${product}.exe`;
const nsisNamespace = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3');
const testGuid = UUID.v5(appId, nsisNamespace);
const productionGuid = UUID.v5('com.deepseek.harness.mathmodel', nsisNamespace);
const installer = path.resolve(process.argv[2] ?? '');
const unpacked = path.resolve(process.argv[3] ?? '');
const skipAppSmoke = process.argv.slice(4).includes('--skip-app-smoke');
const expectedVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
// The full offline payload has more than 43,000 files. Leave room for a busy
// Windows filesystem without weakening any completion or ownership checks.
const timeoutInstall = 60 * 60 * 1000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function samePath(left, right) {
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US');
}
async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(500);
  }
  throw new Error(message);
}
async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function payloadFiles(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Payload must not contain directory links');
      if (entry.isDirectory()) visit(filename);
      else {
        assert.ok(entry.isFile(), 'Payload contains a non-file entry');
        files.push(path.relative(root, filename));
      }
    }
  };
  visit(root);
  return files.sort();
}
async function verifyInstalledPayload(sourceRoot, installedRoot) {
  const files = payloadFiles(sourceRoot);
  const installed = payloadFiles(installedRoot).filter(filename =>
    filename !== 'Uninstall ' + product + '.exe');
  if (installed.length !== files.length) {
    const expectedSet = new Set(files);
    const installedSet = new Set(installed);
    const missing = files.find(filename => !installedSet.has(filename));
    const extra = installed.find(filename => !expectedSet.has(filename));
    assert.fail(`Installed payload file count differs (${installed.length}/${files.length}); first missing=${missing ?? 'none'}; first extra=${extra ?? 'none'}`);
  }
  for (let index = 0; index < files.length; index++) {
    assert.equal(installed[index], files[index], 'Installed payload file set differs at index ' + index);
  }
  const digest = createHash('sha256');
  let bytes = 0;
  let longPaths = 0;
  let maxPathLength = 0;
  for (const relative of files) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(installedRoot, relative);
    const size = fs.statSync(source).size;
    assert.equal(fs.statSync(target).size, size, 'Installed file size differs: ' + relative);
    const expected = await sha256(source);
    assert.equal(await sha256(target), expected, 'Installed file contents differ: ' + relative);
    digest.update(relative.replaceAll(path.sep, '/') + '\0' + size + '\0' + expected + '\n');
    bytes += size;
    maxPathLength = Math.max(maxPathLength, target.length);
    if (target.length > 259) longPaths++;
  }
  return { files: files.length, bytes, manifestSha256: digest.digest('hex'),
    longPaths, maxPathLength };
}
async function fileState(filename) {
  if (!fs.existsSync(filename)) return null;
  const info = fs.lstatSync(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Expected an ordinary file: ${filename}`);
  return { bytes: info.size, sha256: await sha256(filename) };
}
function powerShell(script, env = process.env) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$ErrorActionPreference = 'Stop'\n${script}`,
      'utf16le').toString('base64'),
  ], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, env });
  assert.equal(result.status, 0, `PowerShell inspection failed: ${result.stderr?.slice(-1000)}`);
  return result.stdout.trim();
}
function powershellJson(script) {
  const output = powerShell(`$result = & { ${script} }\nConvertTo-Json -InputObject $result -Depth 10 -Compress`);
  return JSON.parse(output);
}
function registryState(guid) {
  assert.match(guid, /^[a-f0-9-]{36}$/i);
  return powershellJson(`
$guid = '${guid}'
$locations = @(
  @{hive='HKCU'; key=[Microsoft.Win32.RegistryHive]::CurrentUser},
  @{hive='HKLM'; key=[Microsoft.Win32.RegistryHive]::LocalMachine}
)
$names = @(
  @{label='install'; path="Software\\$guid"},
  @{label='uninstall'; path="Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$guid"}
)
$result = @{}
foreach ($location in $locations) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($location.key, $view)
    try {
      foreach ($name in $names) {
        $entry = $base.OpenSubKey($name.path)
        $identity = "$($location.hive)/$view/$($name.label)"
        if ($null -eq $entry) { $result[$identity] = $null; continue }
        try {
          $values = @{}
          foreach ($valueName in $entry.GetValueNames()) {
            $value = $entry.GetValue($valueName)
            $values[$valueName] = if ($null -eq $value) { $null } else { [string]$value }
          }
          $result[$identity] = $values
        } finally { $entry.Close() }
      }
    } finally { $base.Close() }
  }
}
$result`);
}
function shellPaths() {
  return powershellJson(`
@{
  desktop=[Environment]::GetFolderPath('DesktopDirectory')
  programs=[Environment]::GetFolderPath('Programs')
  roaming=[Environment]::GetFolderPath('ApplicationData')
  local=[Environment]::GetFolderPath('LocalApplicationData')
}`);
}
function shortcutTarget(filename) {
  assert.ok(fs.existsSync(filename), `Shortcut missing: ${filename}`);
  const env = { ...process.env, DSH_VERIFY_SHORTCUT: filename };
  const result = powerShell(`
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:DSH_VERIFY_SHORTCUT)
Write-Output $shortcut.TargetPath`, env);
  assert.ok(result, `Shortcut target missing: ${filename}`);
  return result;
}
function testAppProcesses() {
  const env = { ...process.env, DSH_VERIFY_EXECUTABLE_NAME: executable };
  const output = powerShell(`
$name = $env:DSH_VERIFY_EXECUTABLE_NAME
$ids = @(Get-CimInstance Win32_Process -Filter "Name='$name'" | Select-Object -ExpandProperty ProcessId)
ConvertTo-Json -InputObject $ids -Compress`, env);
  return JSON.parse(output);
}
function noTestProcesses() {
  const pids = testAppProcesses();
  assert.deepEqual(pids, [], `Test-name application process is still running: ${pids}`);
}
function noFixtureProcesses(root) {
  const env = { ...process.env, DSH_VERIFY_FIXTURE_ROOT: root,
    DSH_VERIFY_EXECUTABLE_NAME: executable };
  const output = powerShell(`
$prefix = [IO.Path]::GetFullPath($env:DSH_VERIFY_FIXTURE_ROOT).TrimEnd('\\') + '\\'
$name = $env:DSH_VERIFY_EXECUTABLE_NAME
$ids = @(Get-CimInstance Win32_Process -Filter "Name='installer.exe' OR Name='node.exe' OR Name='$name'" -Property ProcessId,ExecutablePath |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
  Select-Object -ExpandProperty ProcessId)
ConvertTo-Json -InputObject $ids -Compress`, env);
  assert.deepEqual(JSON.parse(output), [], 'A fixture installer or application process is still running');
}
function assertOrdinaryTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Refusing to remove a linked fixture entry: ${target}`);
    if (entry.isDirectory()) {
      assert.ok(!fs.lstatSync(target).isSymbolicLink());
      assertOrdinaryTree(target);
    }
  }
}
function peProductName(filename) {
  const env = { ...process.env, DSH_VERIFY_INSTALLER: filename };
  return powerShell(`(Get-Item -LiteralPath $env:DSH_VERIFY_INSTALLER).VersionInfo.ProductName`, env);
}
export async function runOwn(exe, args, timeout, label, env = process.env, verbatimArgs = false,
  onStdout = () => {}, onTimeout = async () => {}) {
  const child = spawn(exe, args, { windowsHide: true, windowsVerbatimArguments: verbatimArgs,
    stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '';
  let stderr = '';
  let callbackError;
  child.stdout.on('data', data => {
    stdout += data.toString();
    if (!callbackError) {
      try { onStdout(data.toString()); } catch (error) { callbackError = error; }
    }
  });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const result = await new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      try { await onTimeout(); } catch (error) { console.error('Cooperative timeout cleanup failed:', error.message); }
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // Let the child finish its own cleanup before the caller uninstalls its
      // payload. Stream callbacks run outside this promise's executor.
      if (callbackError) reject(callbackError);
      else if (timedOut) reject(new Error(`${label} timed out; original process handle exited`));
      else resolve({ code, signal });
    });
  });
  assert.equal(result.code, 0, `${label} exited ${result.code ?? result.signal}: ${stderr.slice(-1200)}`);
  return { stdout, stderr };
}
export function assertOwnedDirectory(root, target, pinnedPhysicalPath) {
  const resolved = fs.realpathSync.native(target);
  const parent = fs.realpathSync.native(root);
  if (pinnedPhysicalPath) assert.ok(samePath(resolved, pinnedPhysicalPath), 'Created directory changed physical identity');
  else assert.ok(inside(parent, resolved), `Directory escaped its test root: ${target}`);
  assert.ok(fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink());
}
async function productionState(shell) {
  return {
    registry: registryState(productionGuid),
    desktop: await fileState(path.join(shell.desktop, 'DeepSeek 数学建模版.lnk')),
    startMenu: await fileState(path.join(shell.programs, 'DeepSeek 数学建模版.lnk')),
    updaterInstaller: await fileState(path.join(shell.local, 'dsh-mathmodel-desktop-updater', 'installer.exe')),
  };
}
function testRegistryEntry(state, suffix) {
  return Object.entries(state).filter(([key, value]) => key.endsWith('/' + suffix) && value !== null);
}
function verifyRegistryInstalled(state, installDir) {
  const installEntries = testRegistryEntry(state, 'install');
  const uninstallEntries = testRegistryEntry(state, 'uninstall');
  assert.ok(installEntries.some(([key]) => key.startsWith('HKCU/')), 'No per-user installation registry key');
  assert.ok(uninstallEntries.some(([key]) => key.startsWith('HKCU/')), 'No per-user uninstall registry key');
  assert.ok(![...installEntries, ...uninstallEntries].some(([key]) => key.startsWith('HKLM/')),
    'Test installer wrote a machine-wide registration');
  for (const [, values] of installEntries) {
    assert.ok(samePath(values.InstallLocation, installDir), `Wrong InstallLocation: ${values.InstallLocation}`);
    assert.equal(values.ShortcutName, product);
  }
  for (const [, values] of uninstallEntries) {
    assert.equal(values.DisplayVersion, expectedVersion);
    assert.match(values.UninstallString, /Uninstall .*\.exe/i);
    assert.ok(values.UninstallString.includes(installDir), 'Uninstaller points outside test install directory');
  }
}

async function verifyBinding(installerFile, unpackedDir) {
  const bindingPath = path.join(path.dirname(installerFile), 'installer-binding.json');
  const info = fs.lstatSync(bindingPath);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Test installer binding is missing');
  const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
  assert.equal(binding.schema, 'dsh.nsis-lifecycle-binding/v1');
  assert.equal(binding.appId, appId);
  assert.equal(binding.packageName, packageName);
  assert.equal(binding.productName, product);
  assert.equal(binding.executableName, executable);
  assert.equal(binding.shortcutName, product);
  assert.equal(binding.guid, testGuid);
  assert.equal(binding.version, expectedVersion);
  assert.deepEqual(binding.capturedDefines, {
    APP_ID: appId, APP_GUID: testGuid, PRODUCT_NAME: product,
    PRODUCT_FILENAME: product, APP_PACKAGE_NAME: packageName,
    SHORTCUT_NAME: product,
  }, 'NSIS compiler did not receive the test-only identity');
  assert.equal(binding.installer, path.basename(installerFile));
  assert.equal(binding.installerSha256, await sha256(installerFile));
  assert.equal(binding.prepackaged, 'win-unpacked');
  assert.ok(samePath(path.join(path.dirname(installerFile), binding.prepackaged), unpackedDir));
  assert.equal(binding.appAsarSha256, await sha256(path.join(unpackedDir, 'resources/app.asar')));
  assert.equal(binding.appExeSha256, await sha256(path.join(unpackedDir, executable)));
  assert.equal(binding.nsisHook, 'build/installer.nsh');
  assert.equal(binding.nsisHookSha256, await sha256(path.join(repo, 'build/installer.nsh')));
  assert.equal(binding.nsisExtractionHook, 'build/nsis/extractAppPackage.nsh');
  assert.equal(binding.nsisExtractionHookSha256, await sha256(path.join(repo, binding.nsisExtractionHook)));
  return binding;
}

async function main() {
  assert.equal(process.platform, 'win32', 'NSIS lifecycle verification requires Windows');
  assert.equal(process.argv.length === 4 || (process.argv.length === 5 && skipAppSmoke), true,
    'Usage: node scripts/verify-windows-install.mjs <test-installer.exe> <test-win-unpacked> [--skip-app-smoke]');
  assert.equal(testGuid, 'e41ec8c8-0246-5d28-b690-113fff4a1364');
  assert.equal(productionGuid, '784a35cd-6f0d-51fe-aac7-c5a4f48a6ba1');
  assert.ok(fs.lstatSync(installer).isFile() && !fs.lstatSync(installer).isSymbolicLink());
  assert.ok(fs.lstatSync(unpacked).isDirectory() && !fs.lstatSync(unpacked).isSymbolicLink());
  const binding = await verifyBinding(installer, unpacked);
  assert.equal(peProductName(installer), product, 'Installer PE metadata is not test-only');
  const packageMeta = JSON.parse(extractFile(path.join(unpacked, 'resources/app.asar'), 'package.json'));
  assert.equal(packageMeta.name, packageName, 'Prepackaged app is not test-only');
  assert.equal(packageMeta.version, expectedVersion);
  const sourceExe = path.join(unpacked, executable);
  assert.ok(fs.lstatSync(sourceExe).isFile(), 'Test executable missing from prepackaged payload');
  assert.equal(peProductName(sourceExe), product, 'Prepackaged executable PE metadata is not test-only');

  const shell = shellPaths();
  for (const key of ['desktop', 'programs', 'roaming', 'local']) {
    assert.ok(path.isAbsolute(shell[key]) && fs.existsSync(shell[key]), `Windows ${key} folder not resolved`);
  }
  const testDesktopLink = path.join(shell.desktop, `${product}.lnk`);
  const testMenuLink = path.join(shell.programs, `${product}.lnk`);
  const testAppData = path.join(shell.roaming, product);
  const testCache = path.join(shell.local, `${packageName}-updater`);
  const beforeTestRegistry = registryState(testGuid);
  assert.ok(Object.values(beforeTestRegistry).every(value => value === null), 'Test GUID already has registry data');
  noTestProcesses();
  for (const target of [testDesktopLink, testMenuLink, testAppData, testCache]) {
    assert.ok(!fs.existsSync(target), `Test-only path already exists: ${target}`);
  }
  const productionBefore = await productionState(shell);
  const installerHash = await sha256(installer);
  // Keep lifecycle evidence outside the system's disposable Temp tree.
  const fixtureBase = path.join(shell.local, 'dsh-nsis-fixtures-20261005');
  fs.mkdirSync(fixtureBase, { recursive: true });
  assert.ok(!fs.lstatSync(fixtureBase).isSymbolicLink());
  const physicalBase = fs.realpathSync.native(fixtureBase);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(physicalBase, 'run-')));
  assert.equal(path.dirname(root), physicalBase);
  assert.ok(!/\s/.test(root), 'NSIS verbatim-argument fixture path contains whitespace');
  const installerCopy = path.join(root, 'installer.exe');
  fs.copyFileSync(installer, installerCopy, fs.constants.COPYFILE_EXCL);
  assert.equal(await sha256(installerCopy), installerHash, 'Copied installer differs from the verified artifact');
  const installDir = path.join(root, '中文 空格 安装目录');
  const uninstallerCopy = path.join(root, 'uninstaller-copy.exe');
  const receiptPath = path.join(root, 'receipt.json');
  fs.writeFileSync(path.join(root, 'production-before.json'), JSON.stringify(productionBefore, null, 2), { flag: 'wx' });
  const home = path.join(root, 'home');
  const userData = path.join(root, 'electron-data');
  const externalSkills = path.join(root, 'external-skills');
  for (const dir of [home, userData, externalSkills]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'profile-sentinel.txt'), 'test-owned profile survives\n', { flag: 'wx' });
  fs.writeFileSync(path.join(userData, 'user-data-sentinel.txt'), 'test-owned userdata survives\n', { flag: 'wx' });
  fs.writeFileSync(path.join(externalSkills, 'skill-sentinel.txt'), 'test-owned external skills survive\n', { flag: 'wx' });
  fs.symlinkSync(externalSkills, path.join(home, 'skills'), 'junction');
  const receipt = { fixture: root, startedAt: new Date().toISOString(), appId, packageName, product, testGuid, productionGuid,
    installerSha256: installerHash, binding: path.join(path.dirname(installer), 'installer-binding.json'),
    nsisHookSha256: binding.nsisHookSha256,
    nsisExtractionHookSha256: binding.nsisExtractionHookSha256, skipAppSmoke, steps: [] };
  console.log(`NSIS lifecycle fixture: ${root}`);
  const appDataMarker = path.join(testAppData, 'nsis-verify-sentinel.txt');
  let appDataPhysicalPath;
  let cachePhysicalPath;
  const cleanupOwnedData = async () => {
    if (fs.existsSync(testAppData)) {
      assert.ok(appDataPhysicalPath, 'No AppData creation identity recorded');
      assertOwnedDirectory(shell.roaming, testAppData, appDataPhysicalPath);
      assert.deepEqual(fs.readdirSync(testAppData), ['nsis-verify-sentinel.txt']);
      assert.equal(fs.readFileSync(appDataMarker, 'utf8'), `${testGuid}\n`);
      fs.rmSync(testAppData, { recursive: true });
    }
    if (fs.existsSync(testCache)) {
      assert.ok(cachePhysicalPath, 'No updater cache creation identity recorded');
      assertOwnedDirectory(shell.local, testCache, cachePhysicalPath);
      assert.deepEqual(fs.readdirSync(testCache), ['installer.exe']);
      assert.equal(await sha256(path.join(testCache, 'installer.exe')), installerHash);
      fs.rmSync(testCache, { recursive: true });
    }
  };
  const uninstallOwned = async () => {
    assertOwnedDirectory(root, installDir);
    verifyRegistryInstalled(registryState(testGuid), installDir);
    noTestProcesses();
    const original = path.join(installDir, `Uninstall ${product}.exe`);
    assert.ok(fs.lstatSync(original).isFile() && !fs.lstatSync(original).isSymbolicLink());
    if (!fs.existsSync(uninstallerCopy)) fs.copyFileSync(original, uninstallerCopy, fs.constants.COPYFILE_EXCL);
    assert.equal(await sha256(uninstallerCopy), await sha256(original));
    await runOwn(uninstallerCopy, ['/S', '/currentuser', `_?=${installDir}`], timeoutInstall,
      'test-only NSIS uninstallation', { ...process.env, DSH_HOME: home,
        DSH_DESKTOP_USER_DATA: userData }, true);
    await waitUntil(() => !fs.existsSync(installDir) &&
      Object.values(registryState(testGuid)).every(value => value === null) &&
      !fs.existsSync(testDesktopLink) && !fs.existsSync(testMenuLink),
    30000, 'Silent uninstall left its directory, registry, or shortcuts behind');
  };
  const cleanupPartialOwned = async () => {
    // A timed-out extraction can precede registration and uninstaller creation.
    // Its executable must still be the exact test payload, and it must have no
    // registered identity or live process before removing this owned directory.
    assertOwnedDirectory(root, installDir);
    assert.ok(Object.values(registryState(testGuid)).every(value => value === null));
    noTestProcesses();
    noFixtureProcesses(root);
    assert.equal(await sha256(path.join(installDir, executable)), binding.appExeSha256);
    assertOrdinaryTree(installDir);
    fs.rmSync(installDir, { recursive: true });
    assert.ok(!fs.existsSync(installDir));
  };
  try {
    // /D accepts an unquoted raw path only as the final NSIS argument.
    console.log('NSIS: installing test-only package');
    await runOwn(installerCopy, ['/S', '/currentuser', `/D=${installDir}`], timeoutInstall,
      'test-only NSIS installation', process.env, true);
    await waitUntil(() => fs.existsSync(path.join(installDir, executable)), 30000,
      'Installer reported success without the expected executable');
    assertOwnedDirectory(root, installDir);
    // Pin the installer-created cache before any later payload assertion can
    // fail, so the failure path can still perform verified test-only cleanup.
    cachePhysicalPath = fs.realpathSync.native(testCache);
    assertOwnedDirectory(shell.local, testCache, cachePhysicalPath);
    assert.equal(await sha256(path.join(testCache, 'installer.exe')), installerHash,
      'Updater cache does not contain the installed test artifact');
    receipt.payload = await verifyInstalledPayload(unpacked, installDir);
    verifyRegistryInstalled(registryState(testGuid), installDir);
    assert.ok(samePath(shortcutTarget(testDesktopLink), path.join(installDir, executable)));
    assert.ok(samePath(shortcutTarget(testMenuLink), path.join(installDir, executable)));
    assert.deepEqual(await productionState(shell), productionBefore, 'Production install changed during test install');
    receipt.steps.push('installed files, HKCU registry, shell links, and updater cache verified');
    console.log('NSIS: installed files, registry, shortcuts, and updater cache verified');

    // The real APPDATA sentinel is unique to this test identity and must
    // remain after uninstall; the app smoke uses its own isolated APPDATA.
    fs.mkdirSync(testAppData);
    appDataPhysicalPath = fs.realpathSync.native(testAppData);
    receipt.ownedPhysicalPaths = { appData: appDataPhysicalPath, cache: cachePhysicalPath };
    fs.writeFileSync(appDataMarker, `${testGuid}\n`, { flag: 'wx' });

    if (!skipAppSmoke) {
      console.log('NSIS: starting installed EXE smoke (first/restart/relocated)');
      const smokeEnv = { ...process.env, DSH_PACKAGE_EXECUTABLE: executable };
      delete smokeEnv.DSH_PACKAGE_SMOKE_HOLD;
      let smokeLine = '';
      let smokeRoot;
      const smoke = await runOwn(process.execPath, [path.join(repo, 'scripts/verify-windows-package.mjs'), installDir],
        75 * 60 * 1000, 'installed application smoke', smokeEnv, false, chunk => {
          smokeLine += chunk;
          const lines = smokeLine.split(/\r?\n/);
          smokeLine = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('Package verification fixture: ')) {
              const observed = fs.realpathSync.native(line.slice('Package verification fixture: '.length));
              assert.equal(path.dirname(observed), fs.realpathSync.native(os.tmpdir()));
              assert.ok(path.basename(observed).startsWith('dsh-package-rc3-'));
              smokeRoot = observed;
            }
            if (/^(first|restart|relocated): GUI loaded;|^Package verification passed:/.test(line)) {
              console.log(`NSIS smoke: ${line}`);
            }
          }
        }, async () => {
          if (!smokeRoot) return;
          const state = JSON.parse(fs.readFileSync(path.join(smokeRoot, 'state.json'), 'utf8'));
          assert.ok(samePath(state.root, smokeRoot));
          assert.ok(samePath(state.userData, path.join(smokeRoot, 'electron-data')));
          fs.writeFileSync(path.join(state.userData, 'desktop-quit-request'), 'quit\n');
          await pause(10000);
        });
      const smokeReceiptPath = /^Package verification passed: (.+)$/m.exec(smoke.stdout)?.[1]?.trim();
      assert.ok(smokeReceiptPath,
        'Installed application smoke did not finish its first/restart/relocated phases');
      const smokeReceipt = JSON.parse(fs.readFileSync(smokeReceiptPath, 'utf8'));
      assert.equal(smokeReceipt.ok, true);
      assert.deepEqual(smokeReceipt.receipts.map(item => item.phase), ['first', 'restart', 'relocated']);
      receipt.appSmoke = { receipt: smokeReceiptPath, phases: smokeReceipt.receipts.map(item => ({
        phase: item.phase, action: item.action, sharedPackages: item.sharedPackages,
        activeFamilyRows: item.activeFamilyRows, degraded: item.degraded,
      })) };
      receipt.steps.push('installed EXE first/restart/relocated app smoke passed');
    }

    // The uninstaller is copied outside $INSTDIR, so /S _?= may remove every
    // file in the installation without racing its own executable.
    fs.symlinkSync(externalSkills, path.join(installDir, 'verify-external-skills'), 'junction');
    console.log('NSIS: uninstalling test-only package');
    await uninstallOwned();
    assert.equal(fs.readFileSync(appDataMarker, 'utf8'), `${testGuid}\n`,
      'Uninstaller removed real APPDATA user data');
    assert.equal(fs.readFileSync(path.join(home, 'profile-sentinel.txt'), 'utf8'), 'test-owned profile survives\n');
    assert.equal(fs.readFileSync(path.join(userData, 'user-data-sentinel.txt'), 'utf8'), 'test-owned userdata survives\n');
    assert.equal(fs.readFileSync(path.join(externalSkills, 'skill-sentinel.txt'), 'utf8'),
      'test-owned external skills survive\n');
    assert.deepEqual(await productionState(shell), productionBefore,
      'Production install changed during test uninstall');
    receipt.steps.push('silent uninstall removed only test installation and preserved all data sentinels');

    // These two directories did not exist before this test. Verify exact
    // ownership before deleting only the test sentinel and test updater cache.
    await cleanupOwnedData();
    assert.deepEqual(await productionState(shell), productionBefore,
      'Production baseline changed during test cleanup');
    assert.ok(!fs.existsSync(testAppData) && !fs.existsSync(testCache),
      'Test-only AppData or updater cache remains after verified cleanup');
    receipt.steps.push('test-only AppData sentinel and updater cache cleaned');
    receipt.ok = true;
    receipt.completedAt = new Date().toISOString();
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(`NSIS lifecycle passed: ${receiptPath}`);
  } catch (error) {
    receipt.ok = false;
    receipt.failedAt = new Date().toISOString();
    receipt.error = error.stack ?? String(error);
    try {
      if (fs.existsSync(installDir)) {
        if (Object.values(registryState(testGuid)).every(value => value === null)) await cleanupPartialOwned();
        else await uninstallOwned();
      }
      assert.ok(Object.values(registryState(testGuid)).every(value => value === null), 'Test registry remains');
      assert.ok(!fs.existsSync(testDesktopLink) && !fs.existsSync(testMenuLink), 'Test shortcut remains');
      await cleanupOwnedData();
      assert.deepEqual(await productionState(shell), productionBefore, 'Production baseline changed');
      receipt.failureCleanup = 'test installation and owned shell data removed; production baseline preserved';
    } catch (cleanupError) {
      receipt.cleanupError = cleanupError.stack ?? String(cleanupError);
      console.error('Test-only cleanup failed; retained fixture:', root, cleanupError.message);
    }
    fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify(receipt, null, 2));
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
