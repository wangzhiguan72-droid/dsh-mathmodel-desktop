// Restore files missing from the installed desktop tree from a verified unpacked release.
// Never overwrites: copies use COPYFILE_EXCL. Refuses any link on the destination path.
// Dry run by default; pass --apply to write. Usage: node restore-missing-install-files.mjs <installed> <candidate> <receiptDir> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [installed, candidate, receiptDir] = args.filter(arg => arg !== '--apply').map(arg => path.resolve(arg));
if (!installed || !candidate || !receiptDir) throw new Error('Usage: <installed> <candidate> <receiptDir> [--apply]');

const sha = file => {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
};

// Every existing component from the installed root down must be a real directory, never a junction or symlink.
function assertRealDirChain(dir) {
  const rel = path.relative(installed, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Destination escapes installed root: ' + dir);
  let cur = installed;
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    cur = part ? path.join(cur, part) : cur;
    let st;
    try { st = fs.lstatSync(cur); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Unsafe destination component: ' + cur);
  }
}

const missing = [];
function walk(rel) {
  for (const entry of fs.readdirSync(path.join(candidate, rel), { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Candidate contains a link: ' + child);
    if (entry.isDirectory()) walk(child);
    else if (entry.isFile()) {
      let exists = true;
      try { fs.lstatSync(path.join(installed, child)); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
      if (!exists) missing.push(child);
    }
  }
}
walk('');
const bytes = missing.reduce((sum, rel) => sum + fs.statSync(path.join(candidate, rel)).size, 0);
const receipt = { schema: 'dsh.install-restore/v1', installed, candidate, applied: apply, startedAt: new Date().toISOString(),
  missing: missing.length, bytes, restored: [] };
if (apply) {
  fs.mkdirSync(receiptDir, { recursive: true });
  for (const rel of missing) {
    const src = path.join(candidate, rel);
    const dest = path.join(installed, rel);
    assertRealDirChain(path.dirname(dest));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    assertRealDirChain(path.dirname(dest));
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    const want = sha(src);
    if (sha(dest) !== want) throw new Error('Hash mismatch after copy: ' + rel);
    receipt.restored.push({ rel, sha256: want });
  }
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 1), { flag: 'wx' });
}
console.log(JSON.stringify({ applied: apply, missing: missing.length, mb: Math.round(bytes / 1048576), restored: receipt.restored.length,
  sample: missing.slice(0, 5), receipt: apply ? path.join(receiptDir, 'receipt.json') : null }, null, 1));
