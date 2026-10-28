#!/usr/bin/env node

// The installed desktop updates as a whole. A host-only update would leave the
// bundled profile, compatibility gate, and installer at different versions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function runUpdateKernelCLI(args, {
  root = desktopDir,
  log = console.log,
  error = console.error,
} = {}) {
  if (args.length === 1 && args[0] === '--check') {
    const hostManifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'host', 'package.json'), 'utf8'));
    const desktopManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const kernel = hostManifest.dependencies?.['@deepseek-ai/dsh'];
    if (typeof kernel !== 'string' || !kernel) throw new Error('runtime/host/package.json must pin @deepseek-ai/dsh');
    log(`Desktop ${desktopManifest.version}; pinned host @deepseek-ai/dsh@${kernel}`);
    log('This check reads local manifests only. Available desktop releases appear in the app update control.');
    return 0;
  }

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    log('Usage: node scripts/update-kernel.mjs --check');
    log('Desktop updates must be selected and confirmed in the app.');
    return 0;
  }

  error('Host-only update and rollback commands are disabled: they cannot validate or restore the complete desktop release.');
  error('Select and confirm a verified desktop release in the app update control. For a source build, pin versions, run the full test and package verification, then publish the whole installer.');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runUpdateKernelCLI(process.argv.slice(2));
  } catch (cause) {
    console.error(`[update-kernel] ${cause.message}`);
    process.exitCode = 1;
  }
}
