import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(repo, 'plugins/dsh-mathmodel/lib');
const files = ['host-capabilities.js', 'task-tool-switches.js', 'client.js', 'typert-shared.js'];
const targets = [
  path.join(repo, 'resources/runtime/profile-web/node_modules/@deepseek-harness/dsh-mathmodel'),
  path.join(process.env.LOCALAPPDATA, 'Programs/dsh-mathmodel-desktop/resources/runtime/profile-web/node_modules/@deepseek-harness/dsh-mathmodel'),
  path.join(process.env.USERPROFILE, '.dsh-mathmodel/profiles/mathmodel/node_modules/@deepseek-harness/dsh-mathmodel'),
];
const backup = path.join(repo, 'dist/task-tool-switches', `deployment-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const hash = data => createHash('sha256').update(data).digest('hex');
const receipt = { backup, applied: process.argv.includes('--apply'), files: [] };
for (const [index, target] of targets.entries()) {
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'));
  if (manifest.name !== '@deepseek-harness/dsh-mathmodel') throw new Error('Unexpected deployment package identity');
  for (const file of files) {
    const data = await fs.readFile(path.join(source, file));
    const dest = path.join(target, 'lib', file);
    const before = await fs.readFile(dest).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const row = { dest, before: before && hash(before), after: hash(data) };
    if (receipt.applied && row.before !== row.after) {
      if (before) {
        const saved = path.join(backup, String(index), file);
        await fs.mkdir(path.dirname(saved), { recursive: true });
        await fs.writeFile(saved, before, { flag: 'wx' });
      }
      await fs.writeFile(dest, data);
      if (hash(await fs.readFile(dest)) !== row.after) throw new Error('Deployment hash mismatch');
    }
    receipt.files.push(row);
  }
}
if (receipt.applied) {
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify(receipt));
