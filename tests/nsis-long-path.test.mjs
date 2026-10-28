import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const customNsis = fileURLToPath(new URL('../build/installer.nsh', import.meta.url));
const sevenZip = fileURLToPath(new URL('../node_modules/electron-winstaller/vendor/7z-x64.exe', import.meta.url));
const expectedBytes = Buffer.from('dsh-nsis7z-payload-2026');

async function cachedBinary(cachePrefix, suffix) {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  if (!existsSync(cache)) return null;
  for (const dir of await readdir(cache)) {
    if (!dir.startsWith(cachePrefix)) continue;
    for (const extraction of await readdir(path.join(cache, dir))) {
      const binary = path.join(cache, dir, extraction, suffix);
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

function execute(binary, args, cwd, timeout = 60000, verbatim = false) {
  const result = spawnSync(binary, args, { cwd, timeout, windowsHide: true, windowsVerbatimArguments: verbatim, encoding: 'utf8' });
  assert.equal(result.error?.code, undefined, `${binary} timed out or failed: ${result.error}`);
  assert.equal(result.status, 0, `${binary} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
}

function nsisLiteral(value) {
  return value.replaceAll('$', '$$').replaceAll('"', '$\\"');
}

test('production NSIS extraction handles long paths, restores output directory, and uninstalls only its payload', async t => {
  if (process.platform !== 'win32') return t.skip('Requires Windows NSIS');
  const makensis = await cachedBinary('nsis-3', 'makensis.exe');
  const plugin = await cachedBinary('nsis-resources-', path.join('plugins', 'x86-unicode', 'nsis7z.dll'));
  if (!makensis || !plugin || !existsSync(sevenZip)) return t.skip('Cached NSIS, nsis7z or 7z binary unavailable');

  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-nsis-longpath-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^dsh-nsis-longpath-test-[\w-]+$/);
    await rm(resolved, { recursive: true, force: true });
  });
  const externalDir = path.join(root, 'external-skills');
  await mkdir(externalDir);
  const externalSentinel = path.join(externalDir, 'external-sentinel.txt');
  await writeFile(externalSentinel, 'preserve external data');

  const relatives = [
    ['short', 'control.txt'],
    ['broken', 'control.txt'],
    ['locked', 'optional.txt'],
    ['long', path.join('resources', 'runtime', 'node_modules',
      ...[1, 2, 3, 4, 5].map(i => `segment${i}-0123456789abcdefghij`), 'long-path-check.txt')],
  ];
  for (const [name, relative] of relatives) {
    const sourceRoot = path.join(root, `source-${name}`);
    const sourceFile = path.join(sourceRoot, relative);
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, expectedBytes);
    for (const required of ['Probe.exe', 'resources/runtime/VERSION.json',
      'resources/runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js']) {
      const requiredFile = path.join(sourceRoot, required);
      await mkdir(path.dirname(requiredFile), { recursive: true });
      await writeFile(requiredFile, 'required entry point');
    }
    const archive = path.join(root, `${name}.7z`);
    if (name === 'broken') await writeFile(archive, 'corrupt archive');
    else execute(sevenZip, ['a', '-t7z', '-mx=1', archive, '.'], sourceRoot);

    const installRoot = path.join(root, `安装 测试 ${name}`);
    const installedFile = path.join(installRoot, relative);
    if (name === 'long') assert.ok(installedFile.length > 260, `Fixture is too short: ${installedFile.length}`);
    const source = path.join(root, `${name}.nsi`);
    const installer = path.join(root, `${name}.exe`);
    const installReceipt = path.join(root, `${name}-install.txt`);
    const uninstallReceipt = path.join(root, `${name}-uninstall.txt`);
    const script = `Unicode true
!addplugindir "${nsisLiteral(path.dirname(plugin))}"
!include "LogicLib.nsh"
!define BUILD_UNINSTALLER
!define APP_EXECUTABLE_FILENAME "Probe.exe"
!include "${nsisLiteral(customNsis)}"
!include "${nsisLiteral(path.join(path.dirname(customNsis), 'nsis/extractAppPackage.nsh'))}"
!ifndef DSH_LONG_PATH_EXTRACTION_WRAPPER
  !error "The production extraction wrapper was not selected"
!endif
Name "NSIS long path test"
OutFile "${nsisLiteral(installer)}"
RequestExecutionLevel user
SilentInstall silent
Section
  StrCpy $INSTDIR "${nsisLiteral(installRoot)}"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=payload.7z "${nsisLiteral(archive)}"
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  StrCpy $0 "$OUTDIR"
  CreateDirectory "$PLUGINSDIR\\7z-out"
  FileOpen $8 "$PLUGINSDIR\\7z-out\\trap.txt" w
  FileWrite $8 "trap"
  FileClose $8
  !insertmacro extractUsing7za "$PLUGINSDIR\\payload.7z"
  StrCpy $1 "no"
  StrCmp "$OUTDIR" "$0" 0 +2
    StrCpy $1 "yes"
  StrCpy $2 "no"
  IfFileExists "$INSTDIR\\trap.txt" 0 +2
    StrCpy $2 "yes"
  FileOpen $8 "${nsisLiteral(installReceipt)}" w
  FileWrite $8 "restored=$1$\\r$\\ntrapCopied=$2$\\r$\\n"
  FileClose $8
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd
Section "Uninstall"
  StrCmp "$INSTDIR" "${nsisLiteral(installRoot)}" +3
    SetErrorLevel 42
    Quit
  StrCpy $0 "$INSTDIR"
  SetOutPath "$TEMP"
  StrCpy $dshCheckOnly 1
  StrCpy $dshRemovalFailed 0
  !insertmacro dshExtendedPath "$INSTDIR" $R0
  Push "$R0"
  Call un.dshRemoveTree
  StrCmp $dshRemovalFailed 1 +3
    SetErrorLevel 43
    Quit
  IfFileExists "$INSTDIR\\Probe.exe" +3
    SetErrorLevel 44
    Quit
  StrCpy $dshCheckOnly 0
  StrCpy $dshRemovalFailed 0
  !insertmacro dshExtendedPath "$INSTDIR" $R0
  Push "$R0"
  Call un.dshRemoveTree
  StrCmp $dshRemovalFailed 0 +3
    SetErrorLevel 2
    Quit
  StrCpy $1 "no"
  IfFileExists "$0\\*.*" 0 +2
    StrCpy $1 "yes"
  FileOpen $8 "${nsisLiteral(uninstallReceipt)}" w
  FileWrite $8 "payloadRemaining=$1$\\r$\\n"
  FileClose $8
SectionEnd
`;
    await writeFile(source, `\ufeff${script}`);
    execute(makensis, ['/V2', source], root);
    if (name === 'broken') {
      // Old entry points must not turn a corrupt extraction into success.
      for (const required of ['Probe.exe', 'resources/runtime/VERSION.json']) {
        const oldFile = path.join(installRoot, required);
        await mkdir(path.dirname(oldFile), { recursive: true });
        await writeFile(oldFile, 'stale entry point');
      }
      const failed = spawnSync(installer, ['/S'], { timeout: 60000, windowsHide: true, stdio: 'ignore' });
      assert.equal(failed.error, undefined, 'Corrupt archive did not exit within the bounded timeout');
      assert.equal(failed.status, 2, 'Corrupt archive was accepted');
      assert.equal(existsSync(installReceipt), false);
      assert.equal(existsSync(path.join(installRoot, 'Probe.exe')), false);
      assert.equal(existsSync(path.join(installRoot, 'resources/runtime/VERSION.json')), false);
      continue;
    }
    if (name === 'locked') {
      const oldBytes = Buffer.from('old optional file must not count as extracted');
      await mkdir(installRoot, { recursive: true });
      await writeFile(installedFile, oldBytes);
      const ready = path.join(root, 'locked-ready.txt');
      const lockScript = `$ErrorActionPreference='Stop'; $handle=[System.IO.File]::Open($env:DSH_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { [System.IO.File]::WriteAllText($env:DSH_LOCK_READY,'ready'); [Console]::ReadLine() | Out-Null } finally { $handle.Dispose() }`;
      const lock = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lockScript, 'utf16le').toString('base64')], {
        windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, DSH_LOCK_FILE: installedFile, DSH_LOCK_READY: ready },
      });
      try {
        const started = Date.now();
        while (!existsSync(ready) && lock.exitCode === null && Date.now() - started < 10000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(existsSync(ready), true, 'Optional file lock was not acquired');
        const failed = spawnSync(installer, ['/S'], { timeout: 60000, windowsHide: true, stdio: 'ignore' });
        assert.equal(failed.error, undefined, 'Locked optional file did not exit within the bounded timeout');
        assert.equal(failed.status, 2, 'Partial extraction was accepted');
        assert.equal(existsSync(installReceipt), false);
      } finally {
        lock.stdin.end('\n');
        if (lock.exitCode === null) await new Promise(resolve => lock.once('exit', resolve));
      }
      assert.deepEqual(await readFile(installedFile), oldBytes, 'Old optional bytes changed despite the lock');
      continue;
    }
    execute(installer, ['/S'], root);
    assert.deepEqual(await readFile(installedFile), expectedBytes, `${name} payload bytes changed during extraction`);
    assert.equal(await readFile(installReceipt, 'utf8'), 'restored=yes\r\ntrapCopied=no\r\n');

    await symlink(externalDir, path.join(installRoot, 'external-skills-link'), 'junction');
    const uninstall = path.join(root, `${name}-uninstall.exe`);
    await copyFile(path.join(installRoot, 'Uninstall.exe'), uninstall);
    execute(uninstall, ['/S', `_?=${installRoot}`], root, 60000, true);
    assert.equal(existsSync(installedFile), false, `${name} payload survived NSIS uninstall`);
    assert.equal(existsSync(installRoot), false, `${name} install directory survived NSIS uninstall`);
    assert.equal(await readFile(uninstallReceipt, 'utf8'), 'payloadRemaining=no\r\n');
    assert.equal(await readFile(externalSentinel, 'utf8'), 'preserve external data');
  }
});
