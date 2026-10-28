/** Reproduce the installed-tree NSIS removal in a disposable, registry-free fixture. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Requires Windows NSIS');
const source = path.resolve(process.argv[2] ?? 'dist/fusion-installed-verification/previous-install');
assert.ok(existsSync(path.join(source, 'resources', 'app.asar')), 'Expected complete installed-tree snapshot');
const work = process.argv[3] ? path.resolve(process.argv[3]) : await mkdtemp(path.join(os.tmpdir(), 'dsh-ni-'));
assert.equal(path.dirname(work).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), 'Fixture must be directly under Temp');
assert.match(path.basename(work), /^dsh-ni-[\w-]+$/, 'Unexpected fixture name');
const install = path.join(work, 'old-install');
const log = path.join(work, 'move-failure.txt');
const hookSource = fileURLToPath(new URL('../build/installer.nsh', import.meta.url));
const vendorSource = fileURLToPath(new URL('../node_modules/app-builder-lib/templates/nsis/uninstaller.nsh', import.meta.url));
const nsisCache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis-3.0.4.1');
const makensis = (await readdir(nsisCache)).map(dir => path.join(nsisCache, dir, 'makensis.exe')).find(existsSync);
assert.ok(existsSync(makensis), `NSIS compiler missing: ${makensis}`);

function literal(value) { return value.replaceAll('$', '$$').replaceAll('"', '$\\"'); }
function run(binary, args, cwd, timeout = 120000) {
  const result = spawnSync(binary, args, { cwd, timeout, windowsHide: true, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

if (!existsSync(install)) {
  console.log(JSON.stringify({ phase: 'cloning', source, install, log }));
  const copy = run('robocopy.exe', [source, install, '/E', '/COPY:DAT', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS'], work, 900000);
  assert.ok(copy.status < 8, `Fixture clone failed: ${copy.status}\n${copy.stdout}\n${copy.stderr}`);
}
const original = await readFile(hookSource, 'utf8');
const needle = 'Rename "$R5\\$R2" "$R6\\$R2"\n              ${If} ${Errors}\n                StrCpy $dshRemovalFailed 1\n              ${EndIf}';
assert.equal(original.split(needle).length, 2, 'Cannot uniquely instrument NSIS move failure');
const replacement = `Push $R7\n              Push $R8\n              System::Call 'kernel32::MoveFileW(w "$R5\\$R2", w "$R6\\$R2") i .s ?e'\n              Pop $R7\n              Pop $R8\n              \${If} $R8 == 0\n                FileOpen $R8 "${literal(log)}" a\n                FileWrite $R8 "source=$R5\\$R2 | destination=$R6\\$R2 | win32=$R7$\\r$\\n"\n                FileClose $R8\n                StrCpy $dshRemovalFailed 1\n              \${EndIf}\n              Pop $R8\n              Pop $R7`;
const hook = path.join(work, 'diagnostic-hook.nsh');
await writeFile(hook, original.replace(needle, replacement));
const vendor = await readFile(vendorSource, 'utf8');
const vendorMoves = vendor.slice(vendor.indexOf('Function un.atomicRMDir'), vendor.indexOf('!ifndef UNINSTALL_SECTION_NAME'));
const bootstrap = path.join(work, 'bootstrap.exe');
const script = `Unicode true\r\n!include "LogicLib.nsh"\r\n!define BUILD_UNINSTALLER\r\n!define isUpdated "1 == 1"\r\n!define UNINSTALL_FILENAME "\\Probe-Uninstall.exe"\r\n!define DSH_NSIS_HOOK_DIR "${literal(path.dirname(hookSource))}"\r\n!include "${literal(hook)}"\r\n${vendorMoves}\r\nName "NSIS upgrade diagnostic"\r\nOutFile "${literal(bootstrap)}"\r\nInstallDir "${literal(install)}"\r\nRequestExecutionLevel user\r\nSilentInstall silent\r\nSection\r\n  WriteUninstaller "$INSTDIR\\Probe-Uninstall.exe"\r\nSectionEnd\r\nSection "Uninstall"\r\n  InitPluginsDir\r\n  !insertmacro customRemoveFiles\r\nSectionEnd\r\n`;
const nsi = path.join(work, 'diagnostic.nsi');
await writeFile(nsi, `\ufeff${script}`);
const compile = run(makensis, ['/V2', nsi], work);
assert.equal(compile.status, 0, `Diagnostic compilation failed:\n${compile.stdout}\n${compile.stderr}`);
const create = run(bootstrap, ['/S'], work);
assert.equal(create.status, 0, `Diagnostic uninstaller creation failed: ${create.status}`);
const copiedUninstaller = path.join(work, 'probe-outside.exe');
await copyFile(path.join(install, 'Probe-Uninstall.exe'), copiedUninstaller);
if (process.env.DSH_DIAG_COMPILE_ONLY === '1') {
  console.log(JSON.stringify({ phase: 'compiled', work, copiedUninstaller }));
  process.exit(0);
}
console.log(JSON.stringify({ phase: 'removing', install, log }));
const removal = run(copiedUninstaller, ['/S', `_?=${install}`], work, 900000);
console.log(JSON.stringify({ phase: 'result', exitCode: removal.status, log: existsSync(log) ? await readFile(log, 'utf8') : '', work }));
