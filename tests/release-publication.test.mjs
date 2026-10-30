import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planRelease, publishRelease, cliArgs } from '../scripts/publish-desktop-release.mjs';

const tempRoots = [];
const bridgeVersion = '0.1.3-bridge.1';
const owner = 'wangzhiguan72-droid/dsh-mathmodel-desktop';
const commit = 'a'.repeat(40);
const digest = data => createHash('sha256').update(data).digest('hex');
const json = (status, value) => ({ status, text: async () => JSON.stringify(value) });

test('release CLI derives the directory from the selected version and preserves explicit paths', () => {
  for (const [version, directory] of [['0.1.3', 'kernel-upgrade-0.1.3'],
    [bridgeVersion, `updater-bridge-${bridgeVersion}`], ['0.1.4', 'release-0.1.4'],
    ['0.1.5', 'release-0.1.5'], ['0.1.6', 'release-0.1.6'], ['0.1.7', 'release-0.1.7'], ['0.1.8', 'release-0.1.8'],
    ['0.1.9', 'release-0.1.9'], ['0.2.0', 'release-0.2.0']]) {
    assert.equal(cliArgs(['--plan', '--version', version]).releaseDir, path.resolve('dist', directory));
    assert.equal(cliArgs(['--plan', '--version', version, '--release-dir', 'custom']).releaseDir, 'custom');
  }
  assert.equal(cliArgs(['--plan']).version, '0.2.0');
  assert.equal(cliArgs(['--plan', '--bridge-published']).bridgePublished, true);
  assert.throws(() => cliArgs(['--plan', '--bridge-published', '--bridge-dir', 'bridge']), /mutually exclusive/);
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(version = '0.1.3', bridgeDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-publication-'));
  tempRoots.push(root);
  const zipName = `dsh-mathmodel-desktop-${version}-win-x64.zip`;
  const exeName = `dsh-mathmodel-desktop-${version}-win-x64.exe`;
  const zip = Buffer.alloc(1_000_001, 23), exe = Buffer.alloc(1_000_003, 42);
  fs.writeFileSync(path.join(root, zipName), zip);
  fs.writeFileSync(path.join(root, exeName), exe);
  const zipHash = digest(zip), exeHash = digest(exe);
  fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({
    ok: true, unpackedFiles: 10001, zipAllFiles: 10001,
    artifactSha256: { [zipName]: zipHash, [exeName]: exeHash },
  }));
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), `${zipHash}  ${zipName}\n${exeHash}  ${exeName}\n`);
  const baseVersion = version === bridgeVersion ? version : bridgeVersion;
  const baseZipName = `dsh-mathmodel-desktop-${baseVersion}-win-x64.zip`;
  const baseZip = version === bridgeVersion ? zip : fs.readFileSync(path.join(bridgeDir, baseZipName));
  const manifest = {
    schema: 'dsh.desktop-update/v1', appId: 'com.deepseek.harness.mathmodel',
    channel: 'stable', version: baseVersion, windows: { x64: {
      url: `https://github.com/${owner}/releases/download/v${baseVersion}/${baseZipName}`,
      sha256: digest(baseZip), bytes: baseZip.length,
    } },
  };
  if (version !== bridgeVersion) manifest.upgrades = [{
    schema: manifest.schema, appId: manifest.appId, channel: manifest.channel,
    minVersion: bridgeVersion, version, windows: { x64: {
      url: `https://github.com/${owner}/releases/download/v${version}/${zipName}`,
      sha256: zipHash, bytes: zip.length,
    } },
  }];
  fs.writeFileSync(path.join(root, 'desktop-update.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, `release-notes-${version}.txt`), 'Verified release notes.\n');
  return root;
}

function kernelFixture() {
  const bridgeDir = fixture(bridgeVersion);
  return { root: fixture('0.1.3', bridgeDir), bridgeDir };
}

function miniPlan(version = '0.2.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-api-'));
  tempRoots.push(root);
  const files = ['one.zip', 'two.exe', 'desktop-update.json', 'SHA256SUMS.txt', `release-notes-${version}.txt`]
    .map((name, index) => {
      const data = Buffer.from(`asset-${index}-${name}`), filename = path.join(root, name);
      fs.writeFileSync(filename, data);
      return { name, path: filename, bytes: data.length, sha256: digest(data) };
    });
  return { notes: 'Verified release notes.', files, repository: owner,
    version, tag: `v${version}`, releaseUrl: `https://github.com/${owner}/releases/tag/v${version}` };
}

function api(plan, { tagSha = commit, uploadStatus = 201, digestMissing = false,
  sizeMismatch = false, tagChanges = false, existingDraft = false,
  initialAssets = [], patchResponseLost = false, recheckFails = false,
  createResponseLost = false, apiHangs = false, bridgeRelease } = {}) {
  const tag = plan.tag;
  const calls = [];
  const uploaded = new Set(initialAssets);
  let tagReads = 0, created = existingDraft, published = false;
  const fetch = async (url, options) => {
    const method = options.method;
    const target = new URL(url);
    calls.push({ method, url: target.toString(), options });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer unit-test-token');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    if (target.pathname.endsWith(`/git/ref/tags/${tag}`)) {
      tagReads++;
      if (apiHangs) return new Promise(() => {});
      return json(200, { ref: `refs/tags/${tag}`, object: { type: 'tag', sha: 'b'.repeat(40) } });
    }
    if (target.pathname.endsWith(`/git/tags/${'b'.repeat(40)}`)) {
      return json(200, { object: { type: 'commit', sha: tagChanges && tagReads > 1 ? 'c'.repeat(40) : tagSha } });
    }
    if (bridgeRelease && target.pathname.endsWith(`/releases/tags/v${bridgeVersion}`) && method === 'GET') {
      return json(200, bridgeRelease);
    }
    if (target.pathname.endsWith('/releases') && method === 'GET') {
      return json(200, created ? [{ id: 77, tag_name: tag, draft: !published }] : []);
    }
    if (target.pathname.endsWith('/releases') && method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.draft, true);
      assert.equal(body.target_commitish, commit);
      assert.equal(body.make_latest, 'false');
      created = true;
      if (createResponseLost) throw new Error('simulated response loss');
      return json(201, { id: 77, tag_name: tag, draft: true, prerelease: false,
        upload_url: `https://uploads.github.com/repos/${owner}/releases/77/assets{?name,label}` });
    }
    if (target.hostname === 'uploads.github.com') {
      assert.equal(target.pathname, `/repos/${owner}/releases/77/assets`);
      assert.equal(options.headers['Content-Length'], String(plan.files.find(file => file.name === target.searchParams.get('name')).bytes));
      let uploadedBytes = 0;
      for await (const chunk of options.body) uploadedBytes += chunk.length;
      assert.equal(uploadedBytes, Number(options.headers['Content-Length']));
      if (uploadStatus === 201) uploaded.add(target.searchParams.get('name'));
      return json(uploadStatus, { id: 1 });
    }
    if (target.pathname.endsWith('/releases/77/assets')) {
      return json(200, plan.files.filter(file => uploaded.has(file.name)).map((file, index) => ({
        name: file.name, state: 'uploaded', size: sizeMismatch && index === 0 ? file.bytes + 1 : file.bytes,
        digest: digestMissing && index === 0 ? null : `sha256:${file.sha256}`,
      })));
    }
    if (target.pathname.endsWith('/releases/77') && method === 'PATCH') {
      assert.deepEqual(JSON.parse(options.body), { draft: false, prerelease: false, make_latest: 'true' });
      published = true;
      if (patchResponseLost) throw new Error('simulated response loss');
      return json(200, { id: 77, tag_name: tag, draft: false });
    }
    if (target.pathname.endsWith('/releases/77') && method === 'GET') {
      if (published && recheckFails) throw new Error('simulated recheck failure');
      return json(200, { id: 77, tag_name: tag, draft: !published, prerelease: false,
        upload_url: `https://uploads.github.com/repos/${owner}/releases/77/assets{?name,label}` });
    }
    throw new Error(`Unexpected API call: ${method} ${target.pathname}`);
  };
  return { calls, fetch };
}

test('offline plan validates five local assets without requesting credentials', () => {
  const { root, bridgeDir } = kernelFixture();
  const plan = planRelease(root, { version: '0.1.3', bridgeDir });
  assert.deepEqual(plan.files.map(file => file.name), [
    'dsh-mathmodel-desktop-0.1.3-win-x64.zip',
    'dsh-mathmodel-desktop-0.1.3-win-x64.exe',
    'desktop-update.json', 'SHA256SUMS.txt', 'release-notes-0.1.3.txt',
  ]);
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/publish-desktop-release.mjs');
  const output = JSON.parse(execFileSync(process.execPath, [script, '--version', '0.1.3', '--release-dir', root, '--bridge-dir', bridgeDir, '--plan'],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }));
  assert.equal(output.files.length, 5);
  assert.equal(output.files[0].sha256, digest(fs.readFileSync(path.join(root, output.files[0].name))));
});

test('manifest with wrong release URL is rejected locally', () => {
  const { root, bridgeDir } = kernelFixture();
  const filename = path.join(root, 'desktop-update.json');
  const manifest = JSON.parse(fs.readFileSync(filename));
  manifest.windows.x64.url = 'https://example.com/other.zip';
  fs.writeFileSync(filename, JSON.stringify(manifest));
  assert.throws(() => planRelease(root, { version: '0.1.3', bridgeDir }), /manifest does not match/);
});

test('release plan permits only the verifier-declared NSIS elevation helper omission from ZIP', () => {
  const { root, bridgeDir } = kernelFixture();
  const file = path.join(root, 'verification.json');
  const receipt = JSON.parse(fs.readFileSync(file));
  receipt.zipAllFiles--;
  receipt.zipNsisOnlyOmissions = ['resources/elevate.exe'];
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.equal(planRelease(root, { version: '0.1.3', bridgeDir }).files.length, 5);
  receipt.zipNsisOnlyOmissions = ['resources/app.asar'];
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => planRelease(root, { version: '0.1.3', bridgeDir }), /incomplete/);
  receipt.zipNsisOnlyOmissions = ['resources/elevate.exe'];
  receipt.zipAllFiles--;
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => planRelease(root, { version: '0.1.3', bridgeDir }), /incomplete/);
});

test('bridge plan permits its standalone feed and kernel plan requires the verified bridge', () => {
  const bridgeDir = fixture(bridgeVersion);
  const bridgePlan = planRelease(bridgeDir, { version: bridgeVersion });
  assert.equal(bridgePlan.tag, `v${bridgeVersion}`);
  assert.equal(bridgePlan.files.length, 5);
  const root = fixture('0.1.3', bridgeDir);
  assert.throws(() => planRelease(root), /requires --bridge-dir/);
  assert.equal(planRelease(root, { version: '0.1.3', bridgeDir }).version, '0.1.3');
  const manifestPath = path.join(root, 'desktop-update.json');
  const original = fs.readFileSync(manifestPath, 'utf8');
  for (const change of [
    feed => { feed.upgrades[0].minVersion = '0.1.2'; },
    feed => { feed.upgrades[0].windows.x64.sha256 = '0'.repeat(64); },
    feed => { feed.windows.x64.sha256 = '0'.repeat(64); },
    feed => { feed.upgrades[0].channel = 'next'; },
    feed => { feed.upgrades.push(feed.upgrades[0]); },
  ]) {
    const feed = JSON.parse(original);
    change(feed);
    fs.writeFileSync(manifestPath, JSON.stringify(feed));
    assert.throws(() => planRelease(root, { version: '0.1.3', bridgeDir }));
  }
  fs.writeFileSync(manifestPath, original);
  assert.throws(() => planRelease(root, { version: '0.1.10', bridgeDir }), /Unsupported/);
});

test('0.1.9 release plan updates existing 0.1.8 users through the migration bridge', async () => {
  const bridgeDir = fixture(bridgeVersion);
  const root = fixture('0.1.9', bridgeDir);
  const plan = planRelease(root, { version: '0.1.9', bridgeDir });
  assert.equal(plan.tag, 'v0.1.9');
  assert.equal(plan.files[0].name, 'dsh-mathmodel-desktop-0.1.9-win-x64.zip');
  const script = fileURLToPath(new URL('../scripts/publish-desktop-release.mjs', import.meta.url));
  const cliPlan = JSON.parse(execFileSync(process.execPath, [script, '--version', '0.1.9', '--release-dir', root,
    '--bridge-dir', bridgeDir, '--plan'], { encoding: 'utf8' }));
  assert.equal(cliPlan.version, '0.1.9');
  const { createRequire } = await import('node:module');
  const { checkForUpdate } = createRequire(import.meta.url)('../src/desktop-updates.cjs');
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => response.end(fs.readFileSync(path.join(root, 'desktop-update.json'))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const feedUrl = `http://127.0.0.1:${server.address().port}/desktop-update.json`;
    for (const [currentVersion, target] of [['0.1.2', bridgeVersion], [bridgeVersion, '0.1.9'],
      ['0.1.3', '0.1.9'], ['0.1.4', '0.1.9'], ['0.1.5', '0.1.9'], ['0.1.6', '0.1.9'], ['0.1.7', '0.1.9'],
      ['0.1.8', '0.1.9']]) {
      const result = await checkForUpdate({ feedUrl, currentVersion, allowLoopbackHttp: true });
      assert.equal(result.available, true);
      assert.equal(result.release.version, target);
    }
    assert.equal((await checkForUpdate({ feedUrl, currentVersion: '0.1.9', allowLoopbackHttp: true })).available, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('0.2.0 default release plan reuses the published bridge and reaches every earlier install', async () => {
  const bridgeDir = fixture(bridgeVersion);
  const root = fixture('0.2.0', bridgeDir);
  const bridgeZip = fs.readFileSync(path.join(bridgeDir, `dsh-mathmodel-desktop-${bridgeVersion}-win-x64.zip`));
  const plan = planRelease(root, { bridgePublished: true });
  assert.equal(plan.tag, 'v0.2.0');
  assert.deepEqual(plan.publishedBridge, { tag: `v${bridgeVersion}`, name: `dsh-mathmodel-desktop-${bridgeVersion}-win-x64.zip`,
    url: `https://github.com/${owner}/releases/download/v${bridgeVersion}/dsh-mathmodel-desktop-${bridgeVersion}-win-x64.zip`,
    sha256: digest(bridgeZip), bytes: bridgeZip.length });
  assert.equal(planRelease(root, { bridgeDir }).publishedBridge, undefined);
  assert.throws(() => planRelease(root), /requires --bridge-dir or --bridge-published/);
  assert.throws(() => planRelease(root, { bridgeDir, bridgePublished: true }), /exactly one/);
  const manifestPath = path.join(root, 'desktop-update.json');
  const original = fs.readFileSync(manifestPath, 'utf8');
  for (const change of [feed => { feed.windows.x64.sha256 = 'x'; }, feed => { feed.windows.x64.bytes = 10; },
    feed => { feed.windows.x64.url = 'https://example.com/bridge.zip'; }, feed => { feed.version = '0.1.3'; }]) {
    const feed = JSON.parse(original);
    change(feed);
    fs.writeFileSync(manifestPath, JSON.stringify(feed));
    assert.throws(() => planRelease(root, { bridgePublished: true }), /manifest does not/);
  }
  fs.writeFileSync(manifestPath, original);
  const script = fileURLToPath(new URL('../scripts/publish-desktop-release.mjs', import.meta.url));
  const cliPlan = JSON.parse(execFileSync(process.execPath, [script, '--release-dir', root,
    '--bridge-published', '--plan'], { encoding: 'utf8' }));
  assert.equal(cliPlan.version, '0.2.0');
  assert.equal(cliPlan.publishedBridge.sha256, digest(bridgeZip));
  const { createRequire } = await import('node:module');
  const { checkForUpdate } = createRequire(import.meta.url)('../src/desktop-updates.cjs');
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => response.end(original));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const feedUrl = `http://127.0.0.1:${server.address().port}/desktop-update.json`;
    for (const [currentVersion, target] of [['0.1.2', bridgeVersion], [bridgeVersion, '0.2.0'],
      ['0.1.3', '0.2.0'], ['0.1.8', '0.2.0'], ['0.1.9', '0.2.0']]) {
      const result = await checkForUpdate({ feedUrl, currentVersion, allowLoopbackHttp: true });
      assert.equal(result.available, true);
      assert.equal(result.release.version, target);
    }
    assert.equal((await checkForUpdate({ feedUrl, currentVersion: '0.2.0', allowLoopbackHttp: true })).available, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('0.1.8 release remains available as a historical publication plan', () => {
  const bridgeDir = fixture(bridgeVersion);
  const root = fixture('0.1.8', bridgeDir);
  const plan = planRelease(root, { version: '0.1.8', bridgeDir });
  assert.equal(plan.tag, 'v0.1.8');
  assert.equal(plan.files[0].name, 'dsh-mathmodel-desktop-0.1.8-win-x64.zip');
});

test('0.1.7 release remains available as a historical publication plan', () => {
  const bridgeDir = fixture(bridgeVersion);
  const root = fixture('0.1.7', bridgeDir);
  const plan = planRelease(root, { version: '0.1.7', bridgeDir });
  assert.equal(plan.tag, 'v0.1.7');
  assert.equal(plan.files[0].name, 'dsh-mathmodel-desktop-0.1.7-win-x64.zip');
});

test('0.1.6 release remains available as a historical publication plan', () => {
  const bridgeDir = fixture(bridgeVersion);
  const root = fixture('0.1.6', bridgeDir);
  const plan = planRelease(root, { version: '0.1.6', bridgeDir });
  assert.equal(plan.tag, 'v0.1.6');
  assert.equal(plan.files[0].name, 'dsh-mathmodel-desktop-0.1.6-win-x64.zip');
});

test('0.1.5 release plan retains the migration bridge and reaches existing 0.1.4 users', async () => {
  const bridgeDir = fixture(bridgeVersion);
  const root = fixture('0.1.5', bridgeDir);
  const plan = planRelease(root, { version: '0.1.5', bridgeDir });
  assert.equal(plan.tag, 'v0.1.5');
  assert.equal(plan.files[0].name, 'dsh-mathmodel-desktop-0.1.5-win-x64.zip');
  const script = fileURLToPath(new URL('../scripts/publish-desktop-release.mjs', import.meta.url));
  const cliPlan = JSON.parse(execFileSync(process.execPath, [script, '--version', '0.1.5', '--release-dir', root,
    '--bridge-dir', bridgeDir, '--plan'], { encoding: 'utf8' }));
  assert.equal(cliPlan.version, '0.1.5');
  const { createRequire } = await import('node:module');
  const { checkForUpdate } = createRequire(import.meta.url)('../src/desktop-updates.cjs');
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => response.end(fs.readFileSync(path.join(root, 'desktop-update.json'))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const feedUrl = `http://127.0.0.1:${server.address().port}/desktop-update.json`;
    for (const [currentVersion, target] of [['0.1.2', bridgeVersion], [bridgeVersion, '0.1.5'],
      ['0.1.3', '0.1.5'], ['0.1.4', '0.1.5']]) {
      const result = await checkForUpdate({ feedUrl, currentVersion, allowLoopbackHttp: true });
      assert.equal(result.available, true);
      assert.equal(result.release.version, target);
    }
    assert.equal((await checkForUpdate({ feedUrl, currentVersion: '0.1.5', allowLoopbackHttp: true })).available, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('0.1.4 delivery retains the migration bridge and is offered to existing 0.1.3 users', async () => {
  const bridgeDir = fixture(bridgeVersion);
  const root = fixture('0.1.4', bridgeDir);
  const plan = planRelease(root, { version: '0.1.4', bridgeDir });
  assert.equal(plan.tag, 'v0.1.4');
  assert.equal(plan.files[0].name, 'dsh-mathmodel-desktop-0.1.4-win-x64.zip');
  const script = fileURLToPath(new URL('../scripts/publish-desktop-release.mjs', import.meta.url));
  const cliPlan = JSON.parse(execFileSync(process.execPath, [script, '--version', '0.1.4',
    '--release-dir', root, '--bridge-dir', bridgeDir, '--plan'], { encoding: 'utf8' }));
  assert.equal(cliPlan.version, '0.1.4');
  const { createRequire } = await import('node:module');
  const { checkForUpdate } = createRequire(import.meta.url)('../src/desktop-updates.cjs');
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => response.end(fs.readFileSync(path.join(root, 'desktop-update.json'))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const feedUrl = `http://127.0.0.1:${server.address().port}/desktop-update.json`;
    for (const [currentVersion, target] of [['0.1.2', bridgeVersion], [bridgeVersion, '0.1.4'], ['0.1.3', '0.1.4']]) {
      const result = await checkForUpdate({ feedUrl, currentVersion, allowLoopbackHttp: true });
      assert.equal(result.available, true);
      assert.equal(result.release.version, target);
    }
    assert.equal((await checkForUpdate({ feedUrl, currentVersion: '0.1.4', allowLoopbackHttp: true })).available, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('bridge publication uses its fixed tag and refuses a mismatched plan before credentials', async () => {
  const plan = miniPlan(bridgeVersion), mock = api(plan);
  const result = await publishRelease({ releaseDir: '.', commit, version: bridgeVersion }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
  });
  assert.equal(result.state, 'published');
  assert.ok(mock.calls.some(call => call.url.includes(`/git/ref/tags/v${bridgeVersion}`)));
  let credentialCalled = false;
  await assert.rejects(publishRelease({ releaseDir: '.', commit, version: bridgeVersion }, {
    plan: () => ({ ...plan, tag: 'v0.1.4' }), credential: async () => { credentialCalled = true; return 'x'; },
  }), /identity is invalid/);
  assert.equal(credentialCalled, false);
});

test('published bridge must match GitHub before a 0.2.0 draft is created', async () => {
  const zip = Buffer.alloc(1_000_001, 7);
  const name = `dsh-mathmodel-desktop-${bridgeVersion}-win-x64.zip`;
  const url = `https://github.com/${owner}/releases/download/v${bridgeVersion}/${name}`;
  const plan = { ...miniPlan(), publishedBridge: { tag: `v${bridgeVersion}`, name, url, sha256: digest(zip), bytes: zip.length } };
  const release = { tag_name: `v${bridgeVersion}`, draft: false, prerelease: false, assets: [
    { name, state: 'uploaded', size: zip.length, digest: `sha256:${digest(zip)}`, browser_download_url: url }] };
  const deps = mock => ({ plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch });
  const good = api(plan, { bridgeRelease: release });
  assert.equal((await publishRelease({ releaseDir: '.', commit, bridgePublished: true }, deps(good))).state, 'published');
  const bridgeRead = good.calls.findIndex(call => call.url.endsWith(`/releases/tags/v${bridgeVersion}`));
  assert.ok(bridgeRead >= 0 && bridgeRead < good.calls.findIndex(call => call.method === 'POST'));
  for (const change of [asset => { asset.digest = `sha256:${'0'.repeat(64)}`; }, asset => { asset.size += 1; },
    asset => { asset.browser_download_url = 'https://example.com/other.zip'; }, (asset, rel) => { rel.draft = true; },
    (asset, rel) => { rel.assets = []; }]) {
    const changed = structuredClone(release);
    change(changed.assets[0], changed);
    const mock = api(plan, { bridgeRelease: changed });
    await assert.rejects(publishRelease({ releaseDir: '.', commit, bridgePublished: true }, deps(mock)),
      /does not match the pinned base route/);
    assert.equal(mock.calls.some(call => call.method === 'POST'), false);
  }
  let credentialCalled = false;
  await assert.rejects(publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => { credentialCalled = true; return 'x'; },
  }), /identity is invalid/);
  assert.equal(credentialCalled, false);
});

test('remote annotated tag mismatch stops before any release POST', async () => {
  const plan = miniPlan(), mock = api(plan, { tagSha: 'c'.repeat(40) });
  await assert.rejects(publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
  }), /tag does not match/);
  assert.equal(mock.calls.some(call => call.method === 'POST'), false);
});

test('upload failure leaves draft and never publishes', async () => {
  const plan = miniPlan(), mock = api(plan, { uploadStatus: 502 });
  await assert.rejects(publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
  }), /remains a draft or needs inspection: Upload one.zip failed \(HTTP 502\)/);
  assert.equal(mock.calls.some(call => call.method === 'PATCH'), false);
});

for (const option of ['digestMissing', 'sizeMismatch']) {
  test(`incomplete remote asset ${option} leaves draft`, async () => {
    const plan = miniPlan(), mock = api(plan, { [option]: true });
    await assert.rejects(publishRelease({ releaseDir: '.', commit }, {
      plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
    }), /remains a draft or needs inspection: Draft asset cannot be verified/);
    assert.equal(mock.calls.some(call => call.method === 'PATCH'), false);
  });
}

test('every exact asset must match before draft becomes public', async () => {
  const plan = miniPlan(), mock = api(plan);
  const result = await publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
  });
  assert.equal(result.state, 'published');
  assert.equal(result.onlineManifestVerified, false);
  assert.equal(mock.calls.filter(call => call.url.startsWith('https://uploads.github.com/')).length, 5);
  assert.equal(mock.calls.at(-1).method, 'PATCH');
});

test('tag moving after uploads blocks the publication PATCH', async () => {
  const plan = miniPlan(), mock = api(plan, { tagChanges: true });
  await assert.rejects(publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
  }), /tag changed before publication/);
  assert.equal(mock.calls.some(call => call.method === 'PATCH'), false);
});

test('PATCH response loss is reconciled by the release ID', async () => {
  const plan = miniPlan(), mock = api(plan, { patchResponseLost: true });
  const published = await publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
  });
  assert.equal(published.state, 'published');
  assert.equal(mock.calls.at(-1).method, 'GET');
  assert.match(mock.calls.at(-1).url, /\/releases\/77$/);
});

test('PATCH response and recheck loss reports an unknown outcome', async () => {
  const plan = miniPlan(), mock = api(plan, { patchResponseLost: true, recheckFails: true });
  await assert.rejects(publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
  }), /publication outcome unknown/);
  assert.equal(mock.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('existing draft requires explicit ID and resumes only verified assets', async () => {
  const plan = miniPlan(), mock = api(plan, { existingDraft: true, initialAssets: [plan.files[0].name] });
  const deps = { plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch };
  await assert.rejects(publishRelease({ releaseDir: '.', commit }, deps), /Draft release 77 already exists/);
  assert.equal(mock.calls.some(call => call.method === 'POST'), false);
  const result = await publishRelease({ releaseDir: '.', commit, resumeDraft: 77 }, deps);
  assert.equal(result.state, 'published');
  assert.equal(mock.calls.filter(call => call.url.startsWith('https://uploads.github.com/')).length, 4);
});

test('draft response loss is not reported as a safe retry', async () => {
  const plan = miniPlan(), mock = api(plan, { createResponseLost: true });
  await assert.rejects(publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
  }), /Draft creation outcome unknown/);
  assert.equal(mock.calls.some(call => call.url.startsWith('https://uploads.github.com/')), false);
});

test('short API deadline aborts a stalled request', async () => {
  const plan = miniPlan(), mock = api(plan, { apiHangs: true });
  await assert.rejects(publishRelease({ releaseDir: '.', commit }, {
    plan: () => plan, credential: async () => 'unit-test-token', fetch: mock.fetch,
    deadlines: { apiMs: 10, uploadMs: 1000 },
  }), /Read release tag timed out/);
  assert.equal(mock.calls[0].options.signal.aborted, true);
});

test('--plan and --publish cannot be combined', () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/publish-desktop-release.mjs');
  const result = spawnSync(process.execPath, [script, '--plan', '--publish', '--commit', commit],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mutually exclusive/);
});
