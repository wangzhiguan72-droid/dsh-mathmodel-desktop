import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const source = path.join(root, 'src', 'desktop-updates.cjs');

test('Chromium update transport follows three checked redirects and rejects unsafe or excessive redirects',
  { skip: process.platform !== 'win32' || !fs.existsSync(electron), timeout: 60000 }, async t => {
    const temporary = fs.mkdtempSync(path.join(root, 'dist', 'update-transport-'));
    const script = path.join(temporary, 'probe.cjs');
    const profile = path.join(temporary, 'profile');
    const launcher = path.join(temporary, 'launch.ps1');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ source, profile }));
    fs.writeFileSync(script, `
      const { app } = require('electron');
      const fs = require('node:fs');
      const { source, profile } = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
      const base = fs.readFileSync(__dirname + '/base.txt', 'utf8');
      fs.writeFileSync(profile + '/pid.txt', String(process.pid));
      process.on('uncaughtException', error => {
        fs.writeFileSync(profile + '/step.txt', error.stack); app.exit(1);
      });
      app.setPath('userData', profile);
      fs.writeFileSync(profile + '/step.txt', 'profile-ready');
      app.whenReady().then(async () => {
        fs.writeFileSync(profile + '/step.txt', 'app-ready');
        const { checkForUpdate } = require(source);
        const result = {};
        for (const key of ['three', 'four', 'unsafe', 'credentials']) {
          try {
            const value = await checkForUpdate({ feedUrl: base + '/' + key,
              currentVersion: '0.1.1', allowLoopbackHttp: true });
            result[key] = { available: value.available, version: value.release.version };
          } catch (error) { result[key] = { error: error.message }; }
        }
        fs.writeFileSync(profile + '/result.json', JSON.stringify(result));
        app.exit(0);
      }).catch(error => {
        fs.writeFileSync(profile + '/step.txt', error.stack);
        process.stderr.write(error.stack + '\\n'); app.exit(1);
      });
    `);
    fs.writeFileSync(launcher, `
      param([string]$Electron, [string]$Script)
      $scriptArg = '"' + $Script + '"'
      Start-Process -FilePath $Electron -ArgumentList $scriptArg -WindowStyle Hidden
    `);
    const hit = [];
    const feed = { schema: 'dsh.desktop-update/v1', appId: 'com.deepseek.harness.mathmodel',
      channel: 'stable', version: '0.1.2', windows: { x64: {
        url: 'https://example.test/release.zip', sha256: 'a'.repeat(64), bytes: 128 } } };
    const routes = { '/three': '/a', '/a': '/b', '/b': '/feed',
      '/four': '/c', '/c': '/d', '/d': '/e', '/e': '/feed',
      '/unsafe': 'http://example.test/feed',
      '/credentials': 'http://user:password@127.0.0.1/feed' };
    const server = http.createServer((request, response) => {
      hit.push(request.url);
      if (routes[request.url]) {
        response.writeHead(302, { location: routes[request.url] }); response.end();
      } else if (request.url === '/feed') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(feed));
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      server.close();
      const pidPath = path.join(profile, 'pid.txt');
      if (fs.existsSync(pidPath)) {
        const pid = Number(fs.readFileSync(pidPath, 'utf8'));
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          try { process.kill(pid, 0); }
          catch { break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      assert.equal(path.dirname(temporary), path.join(root, 'dist'));
      await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(temporary, 'base.txt'), base);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', launcher, electron, script], {
      cwd: root, env, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const resultPath = path.join(profile, 'result.json');
    const until = Date.now() + 20000;
    while (!fs.existsSync(resultPath) && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const stepPath = path.join(profile, 'step.txt');
    assert.ok(fs.existsSync(resultPath), fs.existsSync(stepPath)
      ? fs.readFileSync(stepPath, 'utf8') : 'Electron did not write a probe result');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.deepEqual(result.three, { available: true, version: '0.1.2' });
    assert.match(result.four.error, /Too many update redirects/);
    assert.match(result.unsafe.error, /Update URL must use HTTPS/);
    assert.match(result.credentials.error, /credentials or fragment/);
    assert.deepEqual(hit, ['/three', '/a', '/b', '/feed', '/four', '/c', '/d', '/e', '/unsafe', '/credentials']);
  });
