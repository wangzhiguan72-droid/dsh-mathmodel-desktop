// Repack the existing installed shell, replacing only startup-specific sources.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const repo = path.resolve(import.meta.dirname, '..');
const install = path.join(process.env.LOCALAPPDATA, 'Programs/dsh-mathmodel-desktop/resources');
const original = path.join(install, 'app.asar');
const receiptDir = path.join(repo, 'dist/startup-repair-20261022', `shell-${randomUUID()}`);
const extracted = path.join(receiptDir, 'extracted');
const candidate = path.join(receiptDir, 'app.asar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalBytes = await fs.readFile(original);
const sourceBefore = asar.extractFile(original, 'src/main.cjs');
if (hash(sourceBefore) !== hash(await fs.readFile(path.join(repo, 'dist/startup-repair-20261022/main.cjs.before')))) {
  throw new Error('Installed shell changed since diagnosis; no write performed');
}
await fs.mkdir(receiptDir, { recursive: true });
await fs.writeFile(path.join(receiptDir, 'app.asar.before'), originalBytes, { flag: 'wx' });
asar.extractAll(original, extracted);
const replacements = ['src/main.cjs', 'src/startup-timing.cjs'];
for (const file of replacements) await fs.copyFile(path.join(repo, file), path.join(extracted, file));
await asar.createPackage(extracted, candidate);
for (const file of asar.listPackage(original)) {
  const relative = file.replace(/^[\\/]/, '').replaceAll('\\', '/');
  if (replacements.includes(relative)) continue;
  const archivePath = path.normalize(relative);
  const stat = asar.statFile(original, archivePath);
  if (stat.files) continue;
  if (hash(asar.extractFile(original, archivePath)) !== hash(asar.extractFile(candidate, archivePath))) throw new Error(`Unexpected shell change: ${relative}`);
}
const apply = process.argv.includes('--apply');
if (apply) {
  await fs.copyFile(candidate, original);
  for (const host of [path.join(install, 'runtime/host'), path.join(repo, 'resources/runtime/host')]) {
    await fs.copyFile(path.join(repo, 'src/host-compile-cache.cjs'), path.join(host, 'startup-cache.cjs'));
  }
  // Remove the temporary diagnostic import from the official entry point.
  const bin = path.join(install, 'runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const expected = await fs.readFile(path.join(repo, 'dist/startup-repair-20261022/bin.js.original'));
  await fs.writeFile(bin, expected);
  if (hash(await fs.readFile(original)) !== hash(await fs.readFile(candidate))) throw new Error('Installed archive did not match candidate');
}
const receipt = { applied: apply, backup: receiptDir, replaced: replacements, before: hash(originalBytes), after: hash(await fs.readFile(candidate)) };
await fs.writeFile(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
