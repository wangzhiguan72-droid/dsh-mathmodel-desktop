import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installerHook = fileURLToPath(new URL('../build/installer.nsh', import.meta.url));
const vendorUninstaller = fileURLToPath(new URL('../node_modules/app-builder-lib/templates/nsis/uninstaller.nsh', import.meta.url));
const oldBytes = Buffer.from('old application bytes must survive a failed update');

async function cachedNsis() {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  if (!existsSync(cache)) return null;
  for (const dir of await readdir(cache)) {
    if (!dir.startsWith('nsis-3')) continue;
    for (const extraction of await readdir(path.join(cache, dir))) {
      const binary = path.join(cache, dir, extraction, 'makensis.exe');
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

function literal(value) {
  return value.replaceAll('$', '$$').replaceAll('"', '$\\"');
}

function run(binary, args, cwd, expected = 0, timeout = 15000, verbatim = false) {
  const result = spawnSync(binary, args, { cwd, timeout, windowsHide: true, windowsVerbatimArguments: verbatim, encoding: 'utf8' });
  assert.equal(result.error, undefined, `${binary} timed out or failed: ${result.error}`);
  assert.equal(result.status, expected, `${binary} exited ${result.status}, expected ${expected}:\n${result.stdout}\n${result.stderr}`);
}

async function lockFile(file, ready) {
  const script = `$ErrorActionPreference='Stop'; $h=[System.IO.File]::Open($env:DSH_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { [System.IO.File]::WriteAllText($env:DSH_LOCK_READY,'ready'); [Console]::ReadLine() | Out-Null } finally { $h.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, DSH_LOCK_FILE: file, DSH_LOCK_READY: ready },
  });
  const began = Date.now();
  while (!existsSync(ready) && child.exitCode === null && Date.now() - began < 10000) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(existsSync(ready), true, 'Fixture file lock was not acquired');
  return child;
}

test('production update removal moves long Unicode paths, rolls back locked files, and rejects junctions', async t => {
  if (process.platform !== 'win32') return t.skip('Requires Windows NSIS');
  const makensis = await cachedNsis();
  if (!makensis) return t.skip('Cached NSIS compiler unavailable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-nsis-update-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^dsh-nsis-update-[\w-]+$/);
    await rm(resolved, { recursive: true, force: true });
  });

  const vendorText = await readFile(vendorUninstaller, 'utf8');
  const vendorMoves = vendorText.slice(vendorText.indexOf('Function un.atomicRMDir'), vendorText.indexOf('!ifndef UNINSTALL_SECTION_NAME'));
  assert.match(vendorMoves, /Function un\.restoreFiles/);
  const longRelative = path.join('resources', 'runtime', 'node_modules',
    ...[1, 2, 3, 4, 5].map(i => `segment${i}-0123456789abcdefghij`), 'Unicode-测试-long.txt');
  for (const [scenario, relative, expected] of [
    ['short', 'old-short.txt', 0],
    ['long', longRelative, 0],
    ['locked', 'locked-old.txt', 2],
    ['long-locked', longRelative, 2],
    ['junction', 'old-with-junction.txt', 2],
  ]) {
    const installRoot = path.join(root, `中文 更新 ${scenario}`);
    const oldFile = path.join(installRoot, relative);
    await mkdir(path.dirname(oldFile), { recursive: true });
    await writeFile(oldFile, oldBytes);
    if (scenario.startsWith('long')) assert.ok(oldFile.length > 260, `Long-path fixture too short: ${oldFile.length}`);
    const lockedFile = scenario === 'long-locked' ? path.join(installRoot, 'z-locked.txt') : oldFile;
    if (scenario === 'long-locked') await writeFile(lockedFile, 'lock the last file');
    const external = path.join(root, `external-${scenario}`);
    const sentinel = path.join(external, 'sentinel.txt');
    if (scenario === 'junction') {
      await mkdir(external);
      await writeFile(sentinel, 'external data survives');
      await symlink(external, path.join(installRoot, 'linked-skills'), 'junction');
    }
    const source = path.join(root, `${scenario}.nsi`);
    const bootstrap = path.join(root, `${scenario}.exe`);
    const script = `Unicode true\r\n!include "LogicLib.nsh"\r\n!define BUILD_UNINSTALLER\r\n!define isUpdated "1 == 1"\r\n!define UNINSTALL_FILENAME "\\Uninstall.exe"\r\n!include "${literal(installerHook)}"\r\n${vendorMoves}\r\nName "NSIS update test"\r\nOutFile "${literal(bootstrap)}"\r\nInstallDir "${literal(installRoot)}"\r\nRequestExecutionLevel user\r\nSilentInstall silent\r\nSection\r\n  CreateDirectory "$INSTDIR"\r\n  WriteUninstaller "$INSTDIR\\Uninstall.exe"\r\nSectionEnd\r\nSection "Uninstall"\r\n  StrCmp "$INSTDIR" "${literal(installRoot)}" +3\r\n    SetErrorLevel 42\r\n    Quit\r\n  InitPluginsDir\r\n  !insertmacro customRemoveFiles\r\nSectionEnd\r\n`;
    await writeFile(source, `\ufeff${script}`);
    run(makensis, ['/V2', source], root);
    run(bootstrap, ['/S'], root);
    const uninstaller = path.join(root, `${scenario}-uninstall.exe`);
    await copyFile(path.join(installRoot, 'Uninstall.exe'), uninstaller);
    let lock;
    if (scenario.includes('locked')) lock = await lockFile(lockedFile, path.join(root, `${scenario}-ready.txt`));
    try {
      run(uninstaller, ['/S', `_?=${installRoot}`], root, expected, 20000, true);
    } finally {
      if (lock) {
        lock.stdin.end('\n');
        if (lock.exitCode === null) await new Promise(resolve => lock.once('exit', resolve));
      }
    }
    if (expected === 0) {
      assert.equal(existsSync(installRoot), false, `${scenario}: old installation directory survived update removal`);
    } else {
      assert.deepEqual(await readFile(oldFile), oldBytes, `${scenario}: old bytes changed after rejected update`);
    }
    if (scenario === 'junction') assert.equal(await readFile(sentinel, 'utf8'), 'external data survives');
  }
});
