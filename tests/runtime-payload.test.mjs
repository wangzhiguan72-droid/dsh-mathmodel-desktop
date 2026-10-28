import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyRuntimeModules } from '../scripts/build-runtime.mjs';

test('runtime staging omits the unused root store but preserves active dependencies and nested stores', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-payload-fixture-')));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const dependency = path.join(source, '.pnpm/active/node_modules/active');
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'index.js'), 'export const alive = true;\n');
  fs.symlinkSync(dependency, path.join(source, 'active'), 'junction');
  fs.mkdirSync(path.join(source, 'normal/node_modules/.pnpm/nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'normal/node_modules/.pnpm/nested/index.js'), 'nested dependency\n');
  fs.mkdirSync(path.join(source, 'normal/node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(source, 'normal/node_modules/.bin/shim'), 'unused command shim');
  fs.mkdirSync(path.join(source, '.pnpm/unused'), { recursive: true });
  fs.writeFileSync(path.join(source, '.pnpm/unused/large-cache.bin'), 'unused store contents');
  try {
    copyRuntimeModules(source, destination);
    assert.equal(fs.existsSync(path.join(destination, '.pnpm')), false, 'unused root store entered the release');
    assert.equal(fs.readFileSync(path.join(destination, 'active/index.js'), 'utf8'), 'export const alive = true;\n');
    assert.equal(fs.lstatSync(path.join(destination, 'active')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(destination, 'normal/node_modules/.pnpm/nested/index.js'), 'utf8'), 'nested dependency\n');
    assert.equal(fs.existsSync(path.join(destination, 'normal/node_modules/.bin')), false);
  } finally {
    assert.ok(fs.realpathSync.native(root).startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
