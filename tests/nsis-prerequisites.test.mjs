import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installerPath = fileURLToPath(new URL('../build/installer.nsh', import.meta.url));

async function findMakensis() {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  if (!existsSync(cache)) return null;
  for (const archive of await readdir(cache)) {
    if (!archive.startsWith('nsis-')) continue;
    const archivePath = path.join(cache, archive);
    for (const extraction of await readdir(archivePath)) {
      const binary = path.join(archivePath, extraction, 'makensis.exe');
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

function nsisPath(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('$', '$$').replaceAll('"', '$\\"');
}

function run(binary, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

test('NSIS customInit preserves the selected registry view and stays noninteractive in silent mode', async t => {
  if (process.platform !== 'win32') return t.skip('Requires Windows NSIS runtime');
  const makensis = await findMakensis();
  if (!makensis) return t.skip('Cached makensis.exe is unavailable');

  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-nsis-prerequisites-'));
  const guid = `{${randomUUID()}}`;
  const key = `Software\\Classes\\CLSID\\${guid}`;
  const output = path.join(root, 'probe.exe');
  const result = path.join(root, 'result.txt');
  const launched = path.join(root, 'would-open-browser.txt');
  const source = path.join(root, 'probe.nsi');
  const macro = path.join(root, 'controlled-installer.nsh');
  t.after(async () => {
    // Only the unique key created by this probe can be removed.
    await Promise.allSettled([
      run('reg.exe', ['delete', `HKCU\\${key}`, '/f', '/reg:32'], 5000),
      run('reg.exe', ['delete', `HKCU\\${key}`, '/f', '/reg:64'], 5000),
    ]);
    const resolved = path.resolve(root);
    const tmp = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), tmp);
    assert.equal(path.basename(resolved).startsWith('dsh-nsis-prerequisites-'), true);
    await rm(resolved, { recursive: true, force: true });
  });

  let installer = await readFile(installerPath, 'utf8');
  const replaceOnce = (pattern, replacement) => {
    const updated = installer.replace(pattern, replacement);
    assert.notEqual(updated, installer, `Probe could not isolate external input: ${pattern}`);
    installer = updated;
  };
  replaceOnce(/^\s*ReadRegDWORD \$0 HKLM .*$/m, '    StrCpy $0 0');
  replaceOnce(/\$WINDIR\\(?:System32|Sysnative)\\vcruntime140\.dll/g, `${nsisPath(root)}\\missing-vcruntime140.dll`);
  replaceOnce(/^\s*ExecShell "open" "https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe"\s*$/m,
    `        FileOpen $8 "${nsisPath(launched)}" w\n        FileWrite $8 "browser-open-requested"\n        FileClose $8`);
  await writeFile(macro, installer);

  await writeFile(source, `Unicode true
!include "LogicLib.nsh"
!define DSH_NSIS_HOOK_DIR "${nsisPath(path.dirname(installerPath))}"
!include "${nsisPath(macro)}"
Name "NSIS prerequisite probe"
OutFile "${nsisPath(output)}"
RequestExecutionLevel user
SilentInstall silent
Section
SectionEnd
Function .onInit
  SetRegView 32
  WriteRegStr HKCU "${key}" "view" "32"
  SetRegView 64
  WriteRegStr HKCU "${key}" "view" "64"
  SetRegView 32
  ReadRegStr $1 HKCU "${key}" "view"
  StrCmp $1 "32" +2
    Abort "Registry 32-bit view unavailable"
  SetRegView 64
  ReadRegStr $1 HKCU "${key}" "view"
  StrCmp $1 "64" +2
    Abort "Registry 64-bit view unavailable"
  !insertmacro customInit
  ReadRegStr $1 HKCU "${key}" "view"
  FileOpen $8 "${nsisPath(result)}" w
  FileWrite $8 "$1"
  FileClose $8
  Quit
FunctionEnd
`);

  const compile = await run(makensis, ['/V2', source], 15000);
  assert.equal(compile.timedOut, false, 'NSIS compiler timed out');
  assert.equal(compile.code, 0, `NSIS compilation failed:\n${compile.stdout}\n${compile.stderr}`);
  const execute = await run(output, ['/S'], 5000);
  assert.equal(execute.timedOut, false, 'Silent installer blocked on prerequisite UI');
  const observedView = await readFile(result, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(observedView, '64', `customInit changed the preselected 64-bit registry view or aborted (exit ${execute.code})`);
  assert.equal(existsSync(launched), false, 'Silent installer attempted to open the VC download page');
});

test('NSIS customInit checks the native x64 VC runtime rather than the redirected x86 DLL', async t => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('Requires x64 Windows');
  const makensis = await findMakensis();
  if (!makensis) return t.skip('Cached makensis.exe is unavailable');
  const nativeFile = path.join(process.env.WINDIR, 'System32', 'vcruntime140.dll');
  const redirectedFile = path.join(process.env.WINDIR, 'SysWOW64', 'vcruntime140.dll');
  if (!existsSync(nativeFile) || !existsSync(redirectedFile)) {
    return t.skip('Installed x64 and x86 VC runtimes are required for the redirection probe');
  }
  const native = await readFile(nativeFile);
  const redirected = await readFile(redirectedFile);
  const peMachine = bytes => bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4);
  assert.equal(peMachine(native), 0x8664, 'System32 fixture must contain an x64 PE');
  assert.equal(peMachine(redirected), 0x14c, 'SysWOW64 fixture must contain an x86 PE');

  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-nsis-vc-target-'));
  const source = path.join(root, 'probe.nsi');
  const macro = path.join(root, 'controlled-installer.nsh');
  const output = path.join(root, 'probe.exe');
  const result = path.join(root, 'observed-vc.txt');
  const launched = path.join(root, 'would-open-browser.txt');
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.equal(path.basename(resolved).startsWith('dsh-nsis-vc-target-'), true);
    await rm(resolved, { recursive: true, force: true });
  });

  let installer = await readFile(installerPath, 'utf8');
  const condition = installer.match(/^\s*\$\{IfNot\} \$\{FileExists\} "(\$WINDIR\\(?:System32|Sysnative)\\vcruntime140\.dll)"/m);
  assert.ok(condition, 'Could not locate the real x64 fallback FileExists operand');
  const probe = `
        FileOpen $8 "${condition[1]}" r
        FileSeek $8 60 SET
        FileReadByte $8 $0
        FileReadByte $8 $1
        FileReadByte $8 $2
        FileReadByte $8 $3
        IntOp $1 $1 << 8
        IntOp $2 $2 << 16
        IntOp $3 $3 << 24
        IntOp $0 $0 | $1
        IntOp $0 $0 | $2
        IntOp $0 $0 | $3
        IntOp $0 $0 + 4
        FileSeek $8 $0 SET
        FileReadByte $8 $1
        FileReadByte $8 $2
        IntOp $2 $2 << 8
        IntOp $1 $1 | $2
        FileSeek $8 0 END $3
        FileClose $8
        FileOpen $8 "${nsisPath(result)}" w
        FileWrite $8 "$1,$3"
        FileClose $8
`;
  installer = installer.replace(condition[0], probe + condition[0]);
  const controlled = installer.replace(/^\s*ReadRegDWORD \$0 HKLM .*$/m, '    StrCpy $0 0');
  assert.notEqual(controlled, installer, 'Could not force the x64 fallback branch');
  const safe = controlled.replace(/^\s*ExecShell "open" "https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe"\s*$/m,
    `        FileOpen $8 "${nsisPath(launched)}" w\n        FileClose $8`);
  assert.notEqual(safe, controlled, 'Could not isolate the external browser request');
  await writeFile(macro, safe);
  await writeFile(source, `Unicode true
!include "LogicLib.nsh"
!define DSH_NSIS_HOOK_DIR "${nsisPath(path.dirname(installerPath))}"
!include "${nsisPath(macro)}"
Name "NSIS VC target probe"
OutFile "${nsisPath(output)}"
RequestExecutionLevel user
SilentInstall silent
Section
SectionEnd
Function .onInit
  SetRegView 64
  !insertmacro customInit
  Quit
FunctionEnd
`);

  const compile = await run(makensis, ['/V2', source], 15000);
  assert.equal(compile.timedOut, false, 'NSIS compiler timed out');
  assert.equal(compile.code, 0, `NSIS compilation failed:\n${compile.stdout}\n${compile.stderr}`);
  const execute = await run(output, ['/S'], 5000);
  assert.equal(execute.timedOut, false, 'Silent installer blocked on prerequisite UI');
  const observed = await readFile(result, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(observed, `${peMachine(native)},${native.length}`,
    `The fallback targeted a redirected DLL (observed ${observed}; x86 is ${peMachine(redirected)},${redirected.length})`);
  assert.equal(existsSync(launched), false, 'The fallback attempted to open the VC download page');
});
