import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { validateInBackground, treeDigest, assertOrdinaryTree } = require('../src/desktop-updates.cjs');

test('standalone validation keeps the caller responsive and binds its full-tree result',
  { skip: process.platform !== 'win32' }, async t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stage-validator-')));
    const candidate = path.join(root, 'stage'), cache = path.join(root, 'cache'), source = path.join(root, 'source');
    for (const dir of [candidate, cache, path.join(source, 'src')]) fs.mkdirSync(dir, { recursive: true });
    t.after(() => {
      assert.equal(path.dirname(root).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
      assertOrdinaryTree(root);
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'dsh-mathmodel-desktop', version: '0.1.2', main: 'src/main.cjs',
    }));
    for (const name of ['main', 'desktop-updates', 'update-worker', 'stage-validator']) {
      fs.writeFileSync(path.join(source, 'src', `${name}.cjs`), "'use strict';\n");
    }
    const runtime = path.join(candidate, 'resources', 'runtime');
    fs.mkdirSync(path.join(runtime, 'host/node_modules/@deepseek-ai/dsh/lib'), { recursive: true });
    fs.mkdirSync(path.join(runtime, 'node'));
    fs.writeFileSync(path.join(runtime, 'host/node_modules/@deepseek-ai/dsh/lib/bin.js'), '// fixture');
    fs.writeFileSync(path.join(runtime, 'node/node.exe'), 'MZfixture');
    fs.writeFileSync(path.join(candidate, 'app.exe'), 'MZfixture');
    fs.writeFileSync(path.join(candidate, 'bulk.dat'), Buffer.alloc(32 * 1024 * 1024, 7));
    await asar.createPackage(source, path.join(candidate, 'resources/app.asar'));
    const entries = [];
    const visit = (dir, prefix = '') => {
      for (const name of fs.readdirSync(dir)) {
        const filename = path.join(dir, name), relative = prefix + name, stat = fs.statSync(filename);
        if (stat.isDirectory()) visit(filename, relative + '/');
        else entries.push({ name: relative, size: stat.size });
      }
    };
    visit(candidate);
    const options = { candidateDir: candidate, archiveManifest: { files: entries.length, entries },
      executableName: 'app.exe', packageName: 'dsh-mathmodel-desktop', version: '0.1.2',
      cache, nonce: randomUUID(), nodeBin: process.execPath };
    const expected = treeDigest(candidate);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    let actual;
    try { actual = await validateInBackground(options); } finally { clearInterval(timer); }
    assert.equal(actual, expected);
    assert.ok(ticks > 0, 'standalone validation blocked the caller event loop');
    assert.equal(treeDigest(candidate), expected, 'validation changed candidate files');
    fs.unlinkSync(path.join(candidate, 'bulk.dat'));
    const invalidNonce = randomUUID();
    await assert.rejects(validateInBackground({ ...options, nonce: invalidNonce }), /count/);
    assert.equal(fs.existsSync(path.join(cache, `${invalidNonce}.validation-result.json`)), false);
  });
