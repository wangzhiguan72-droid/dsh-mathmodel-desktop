const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const excludedUserData = 'desktop-updates';

function ordinaryDirectory(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe data directory: ${filename}`);
}

function assertSafeRoot(filename) {
  const root = path.resolve(filename);
  if (root === path.parse(root).root || path.dirname(root) === root) throw new Error('Unsafe data root');
  let part = root;
  while (true) {
    ordinaryDirectory(part);
    const parent = path.dirname(part);
    if (parent === part) break;
    part = parent;
  }
  return root;
}

function ensurePrivateDirectory(filename) {
  const directory = path.resolve(filename);
  // The parent must already be a physical directory. In particular, never
  // follow a junction while creating a directory outside the intended home.
  assertSafeRoot(path.dirname(directory));
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return assertSafeRoot(directory);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertSeparateRoots(...roots) {
  const resolved = roots.map(assertSafeRoot);
  for (let i = 0; i < resolved.length; i++) for (let j = i + 1; j < resolved.length; j++) {
    if (inside(resolved[i], resolved[j]) || inside(resolved[j], resolved[i])) throw new Error('Bootstrap roots overlap');
  }
  return resolved;
}

function linkKinds(root, excludeCache = false) {
  const links = [];
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory)) {
      if (!prefix && excludeCache && name.toLowerCase() === excludedUserData) continue;
      const relative = prefix ? path.join(prefix, name) : name;
      const source = path.join(directory, name), stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) links.push({ source, relative });
      else if (stat.isDirectory()) visit(source, relative);
      else if (!stat.isFile()) throw new Error('Data contains an unsupported special file');
    }
  };
  visit(root);
  const kinds = new Map();
  if (!links.length) return kinds;
  if (process.platform !== 'win32') {
    for (const link of links) kinds.set(link.relative, 'file'); // POSIX ignores the type hint.
    return kinds;
  }
  // Node's lstat reports both junctions and symbolic links as links, with no
  // reparse tag. PowerShell 5 Get-Item cannot inspect long backup paths, so
  // batch a native FindFirstFileW query with extended-length paths. Its
  // WIN32_FIND_DATA reparse tag and directory bit never open the link target.
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-link-kinds-'));
  const request = path.join(probe, `${randomUUID()}.json`);
  try {
    fs.writeFileSync(request, JSON.stringify({ paths: links.map(link => link.source) }), { flag: 'wx', mode: 0o600 });
    const encodedPath = Buffer.from(request, 'utf8').toString('base64');
    const nativeSource = `using System;
using System.Runtime.InteropServices;
public static class DshReparseProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 4)]
  public struct FindData {
    public uint attributes;
    public long created, accessed, written;
    public uint sizeHigh, sizeLow, tag, reserved;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string alternateName;
  }
  [DllImport("kernel32.dll", EntryPoint = "FindFirstFileW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr FindFirstFile(string name, out FindData data);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool FindClose(IntPtr handle);
  public static string Kind(string path) {
    if (Marshal.SizeOf(typeof(FindData)) != 592) throw new InvalidOperationException("Unexpected native link metadata layout");
    string slash = new string((char)92, 1);
    string doubleSlash = slash + slash;
    string prefix = doubleSlash + "?" + slash;
    if (!path.StartsWith(prefix, StringComparison.Ordinal)) {
      path = path.StartsWith(doubleSlash, StringComparison.Ordinal)
        ? prefix + "UNC" + slash + path.Substring(2) : prefix + path;
    }
    FindData data;
    IntPtr handle = FindFirstFile(path, out data);
    if (handle == new IntPtr(-1)) throw new InvalidOperationException("Native reparse query failed: " + Marshal.GetLastWin32Error());
    try {
      if ((data.attributes & 0x400u) == 0) throw new InvalidOperationException("Path is not a reparse point");
      if (data.tag == 0xA0000003u) return "J";
      if (data.tag == 0xA000000Cu) return (data.attributes & 0x10u) != 0 ? "D" : "F";
      throw new InvalidOperationException("Unsupported reparse tag " + data.tag.ToString("X8"));
    } finally { FindClose(handle); }
  }
}`;
    const encodedSource = Buffer.from(nativeSource, 'utf8').toString('base64');
    const script = `$ErrorActionPreference='Stop'; $source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSource}')); Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop | Out-Null; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $request=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json; $kinds=@(foreach($p in $request.paths){[DshReparseProbe]::Kind([string]$p)}); [Console]::Out.Write(($kinds -join ','))`;
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    let output;
    try {
      output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
        { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(',');
    } catch {
      throw new Error('Windows native link metadata query failed');
    }
    if (output.length !== links.length || output.some(kind => !['J', 'D', 'F'].includes(kind))) {
      throw new Error(`Windows link metadata count or type mismatch (${links.length} links, ${output.join(',')})`);
    }
    for (let i = 0; i < links.length; i++) kinds.set(links[i].relative,
      output[i] === 'J' ? 'junction' : output[i] === 'D' ? 'dir' : 'file');
    return kinds;
  } finally {
    try { fs.unlinkSync(request); } catch { /* probe retained for diagnosis */ }
    try { fs.rmdirSync(probe); } catch { /* probe retained for diagnosis */ }
  }
}

function copyEntry(source, target, kinds, relative) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    const targetValue = fs.readlinkSync(source);
    const linkType = kinds.get(relative);
    if (!linkType) throw new Error('Link metadata missing during data copy');
    fs.symlinkSync(targetValue, target, linkType);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(target);
    for (const name of fs.readdirSync(source)) copyEntry(path.join(source, name), path.join(target, name), kinds, path.join(relative, name));
    fs.utimesSync(target, stat.atime, stat.mtime);
  } else if (stat.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.utimesSync(target, stat.atime, stat.mtime);
  } else throw new Error('Data contains an unsupported special file');
}

function removeEntry(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(filename);
  else if (stat.isDirectory()) {
    for (const name of fs.readdirSync(filename)) removeEntry(path.join(filename, name));
    fs.rmdirSync(filename);
  } else throw new Error('Data contains an unsupported special file');
}

function digest(root, excludeCache) {
  const hash = createHash('sha256');
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!prefix && excludeCache && name.toLowerCase() === excludedUserData) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) hash.update(`L\0${relative}\0${fs.readlinkSync(file)}\n`);
      else if (stat.isDirectory()) { hash.update(`D\0${relative}\n`); visit(file, relative); }
      else if (stat.isFile()) {
        const fileHash = createHash('sha256');
        const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
        try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) fileHash.update(buffer.subarray(0, bytes)); }
        finally { fs.closeSync(fd); }
        hash.update(`F\0${relative}\0${stat.size}\0${fileHash.digest('hex')}\n`);
      } else throw new Error('Data contains an unsupported special file');
    }
  };
  visit(root);
  return hash.digest('hex');
}

function assertSnapshotBackup(record) {
  if (!record || record.schema !== 'dsh.desktop-bootstrap-data/v1' || !/^[a-f0-9-]{36}$/.test(record.nonce)) {
    throw new Error('Invalid desktop data snapshot');
  }
  const [home, userData, backupRoot] = assertSeparateRoots(record.home, record.userData, path.dirname(record.backup));
  if (record.backup !== path.join(backupRoot, `dsh-desktop-bootstrap-${record.nonce}`)) throw new Error('Snapshot path mismatch');
  assertSafeRoot(record.backup);
  assertSafeRoot(path.join(record.backup, 'home'));
  assertSafeRoot(path.join(record.backup, 'user-data'));
  if (digest(path.join(record.backup, 'home'), false) !== record.homeSha256
    || digest(path.join(record.backup, 'user-data'), false) !== record.userDataSha256) throw new Error('Desktop backup changed');
  return { home, userData };
}

function snapshotData({ home, userData, backupRoot, nonce }) {
  [home, userData, backupRoot] = assertSeparateRoots(home, userData, backupRoot);
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid bootstrap nonce');
  const backup = path.join(backupRoot, `dsh-desktop-bootstrap-${nonce}`);
  fs.mkdirSync(backup);
  try {
    const copyRoot = (source, name, excludeCache) => {
      const destination = path.join(backup, name);
      const kinds = linkKinds(source, excludeCache);
      fs.mkdirSync(destination);
      for (const entry of fs.readdirSync(source)) {
        if (excludeCache && entry.toLowerCase() === excludedUserData) continue;
        copyEntry(path.join(source, entry), path.join(destination, entry), kinds, entry);
      }
      if (digest(source, excludeCache) !== digest(destination, false)) throw new Error(`Data snapshot changed: ${name}`);
      return digest(destination, false);
    };
    const record = { schema: 'dsh.desktop-bootstrap-data/v1', nonce, home, userData, backup,
      homeSha256: copyRoot(home, 'home', false), userDataSha256: copyRoot(userData, 'user-data', true) };
    fs.writeFileSync(path.join(backup, 'snapshot.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return record;
  } catch (error) { removeEntry(backup); throw error; }
}

function assertSnapshotCurrent(record) {
  if (!record || record.schema !== 'dsh.desktop-bootstrap-data/v1' || !/^[a-f0-9-]{36}$/.test(record.nonce)) {
    throw new Error('Invalid bootstrap data snapshot');
  }
  const [home, userData, backupRoot] = assertSeparateRoots(record.home, record.userData, path.dirname(record.backup));
  if (record.backup !== path.join(backupRoot, `dsh-desktop-bootstrap-${record.nonce}`)) throw new Error('Snapshot path mismatch');
  if (digest(home, false) !== record.homeSha256 || digest(userData, true) !== record.userDataSha256) {
    throw new Error('Desktop data changed after bootstrap snapshot');
  }
}

function restoreData(record) {
  const { home, userData } = assertSnapshotBackup(record);
  const homeStage = `${home}.dsh-restore-${record.nonce}`;
  const dataStage = `${userData}.dsh-restore-${record.nonce}`;
  const homeDisplaced = `${home}.dsh-displaced-${record.nonce}`;
  const dataDisplaced = `${userData}.dsh-displaced-${record.nonce}`;
  fs.mkdirSync(homeStage);
  const createdStages = [homeStage];
  try {
    fs.mkdirSync(dataStage);
    createdStages.push(dataStage);
    const backupHome = path.join(record.backup, 'home'), backupData = path.join(record.backup, 'user-data');
    const homeKinds = linkKinds(backupHome), dataKinds = linkKinds(backupData);
    for (const entry of fs.readdirSync(path.join(record.backup, 'home'))) {
      copyEntry(path.join(backupHome, entry), path.join(homeStage, entry), homeKinds, entry);
    }
    for (const entry of fs.readdirSync(path.join(record.backup, 'user-data'))) {
      copyEntry(path.join(backupData, entry), path.join(dataStage, entry), dataKinds, entry);
    }
    if (digest(homeStage, false) !== record.homeSha256) throw new Error('Home restore copy changed');
    if (digest(dataStage, false) !== record.userDataSha256) throw new Error('User data restore copy changed');
  } catch (error) {
    // A failed preparation leaves the original roots untouched. Cleanup is
    // best effort and must not hide the error that stopped recovery.
    for (const stage of createdStages) {
      try { if (fs.existsSync(stage)) removeEntry(stage); } catch { /* retained */ }
    }
    throw error;
  }
  let homeMoved = false, dataMoved = false, cacheMoved = false, homeInstalled = false, dataInstalled = false;
  const cacheInOld = path.join(dataDisplaced, excludedUserData);
  const cacheInStage = path.join(dataStage, excludedUserData);
  try {
    fs.renameSync(home, homeDisplaced); homeMoved = true;
    fs.renameSync(userData, dataDisplaced); dataMoved = true;
    if (fs.existsSync(cacheInOld)) {
      const cacheStat = fs.lstatSync(cacheInOld);
      if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) throw new Error('Unsafe desktop update cache during recovery');
      fs.renameSync(cacheInOld, cacheInStage); cacheMoved = true;
    }
    fs.renameSync(homeStage, home); homeInstalled = true;
    fs.renameSync(dataStage, userData); dataInstalled = true;
    if (digest(home, false) !== record.homeSha256 || digest(userData, true) !== record.userDataSha256) {
      throw new Error('Bootstrap data restore verification failed');
    }
  } catch (error) {
    try {
      if (dataInstalled) fs.renameSync(userData, dataStage);
      if (homeInstalled) fs.renameSync(home, homeStage);
      if (cacheMoved) fs.renameSync(cacheInStage, cacheInOld);
      if (dataMoved) fs.renameSync(dataDisplaced, userData);
      if (homeMoved) fs.renameSync(homeDisplaced, home);
    } catch (rollbackError) {
      throw new Error(`Bootstrap data restore failed: ${error.message}; rollback failed: ${rollbackError.message}`);
    }
    for (const stage of [homeStage, dataStage]) {
      try { if (fs.existsSync(stage)) removeEntry(stage); } catch { /* retained */ }
    }
    throw error;
  }
  const cleanupErrors = [];
  for (const displaced of [homeDisplaced, dataDisplaced]) {
    try { removeEntry(displaced); }
    catch (error) { cleanupErrors.push({ path: displaced, message: String(error.message || error) }); }
  }
  return { cleanupErrors, retainedPaths: cleanupErrors.map(item => item.path) };
}

module.exports = { assertSafeRoot, assertSeparateRoots, ensurePrivateDirectory,
  snapshotData, assertSnapshotCurrent, assertSnapshotBackup, restoreData };
