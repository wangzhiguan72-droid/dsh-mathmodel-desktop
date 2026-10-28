// Preserve the installed shell and replace only the verified window fix.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const asar = createRequire(import.meta.url)('@electron/asar');
const repo = path.resolve(import.meta.dirname, '..');
const installed = path.join(process.env.LOCALAPPDATA, 'Programs/dsh-mathmodel-desktop/resources/app.asar');
const backup = path.join(repo, 'dist/window-reopen', randomUUID());
const hash = value => createHash('sha256').update(value).digest('hex');
const before = await fs.readFile(installed);
if (hash(before) !== 'eade7bc1f9e2fb240544282c39692eab47965a21f5b13023d8fdeeffac4ae86e') {
  throw new Error('Installed archive changed since diagnosis; no write performed');
}
await fs.mkdir(backup, { recursive: true });
await fs.writeFile(path.join(backup, 'app.asar.before'), before, { flag: 'wx' });
const extracted = path.join(backup, 'extracted');
const candidate = path.join(backup, 'app.asar');
asar.extractAll(installed, extracted);
await fs.copyFile(path.join(repo, 'src/main.cjs'), path.join(extracted, 'src/main.cjs'));
await asar.createPackage(extracted, candidate);
for (const entry of asar.listPackage(installed)) {
  const file = entry.replace(/^[\\/]/, '').replaceAll('\\', '/');
  if (file === 'src/main.cjs' || asar.statFile(installed, path.normalize(file)).files) continue;
  if (hash(asar.extractFile(installed, path.normalize(file))) !== hash(asar.extractFile(candidate, path.normalize(file)))) {
    throw new Error(`Unexpected change: ${file}`);
  }
}
const apply = process.argv.includes('--apply');
if (apply) {
  if (hash(await fs.readFile(installed)) !== hash(before)) throw new Error('Installed archive changed before write');
  await fs.copyFile(candidate, installed);
  if (hash(await fs.readFile(installed)) !== hash(await fs.readFile(candidate))) throw new Error('Installed archive verification failed');
}
const receipt = { applied: apply, backup, replaced: ['src/main.cjs'], before: hash(before), after: hash(await fs.readFile(candidate)) };
await fs.writeFile(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
