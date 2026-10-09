import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planRelease, publishRelease } from '../scripts/publish-desktop-release.mjs';

const tempRoots = [];
const tag = 'v0.1.2';
const owner = 'wangzhiguan72-droid/dsh-mathmodel-desktop';
const commit = 'a'.repeat(40);
const digest = data => createHash('sha256').update(data).digest('hex');
const json = (status, value) => ({ status, text: async () => JSON.stringify(value) });

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-publication-'));
  tempRoots.push(root);
  const zipName = 'dsh-mathmodel-desktop-0.1.2-win-x64.zip';
  const exeName = 'dsh-mathmodel-desktop-0.1.2-win-x64.exe';
  const zip = Buffer.alloc(1_000_001, 23), exe = Buffer.alloc(1_000_003, 42);
  fs.writeFileSync(path.join(root, zipName), zip);
  fs.writeFileSync(path.join(root, exeName), exe);
  const zipHash = digest(zip), exeHash = digest(exe);
  fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({
    ok: true, unpackedFiles: 10001, zipAllFiles: 10001,
    artifactSha256: { [zipName]: zipHash, [exeName]: exeHash },
  }));
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), `${zipHash}  ${zipName}\n${exeHash}  ${exeName}\n`);
  fs.writeFileSync(path.join(root, 'desktop-update.json'), JSON.stringify({
    schema: 'dsh.desktop-update/v1', appId: 'com.deepseek.harness.mathmodel',
    channel: 'stable', version: '0.1.2', windows: { x64: {
      url: `https://github.com/${owner}/releases/download/${tag}/${zipName}`,
      sha256: zipHash, bytes: zip.length,
    } },
  }));
  fs.writeFileSync(path.join(root, 'release-notes-0.1.2.txt'), 'Verified release notes.\n');
  return root;
}

function miniPlan() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-api-'));
  tempRoots.push(root);
  const files = ['one.zip', 'two.exe', 'desktop-update.json', 'SHA256SUMS.txt', 'release-notes-0.1.2.txt']
    .map((name, index) => {
      const data = Buffer.from(`asset-${index}-${name}`), filename = path.join(root, name);
      fs.writeFileSync(filename, data);
      return { name, path: filename, bytes: data.length, sha256: digest(data) };
    });
  return { notes: 'Verified release notes.', files };
}

function api(plan, { tagSha = commit, uploadStatus = 201, digestMissing = false,
  sizeMismatch = false, tagChanges = false, existingDraft = false,
  initialAssets = [], patchResponseLost = false, recheckFails = false,
  createResponseLost = false, apiHangs = false } = {}) {
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
  const root = fixture();
  const plan = planRelease(root);
  assert.deepEqual(plan.files.map(file => file.name), [
    'dsh-mathmodel-desktop-0.1.2-win-x64.zip',
    'dsh-mathmodel-desktop-0.1.2-win-x64.exe',
    'desktop-update.json', 'SHA256SUMS.txt', 'release-notes-0.1.2.txt',
  ]);
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/publish-desktop-release.mjs');
  const output = JSON.parse(execFileSync(process.execPath, [script, '--release-dir', root, '--plan'],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }));
  assert.equal(output.files.length, 5);
  assert.equal(output.files[0].sha256, digest(fs.readFileSync(path.join(root, output.files[0].name))));
});

test('manifest with wrong release URL is rejected locally', () => {
  const root = fixture();
  const filename = path.join(root, 'desktop-update.json');
  const manifest = JSON.parse(fs.readFileSync(filename));
  manifest.windows.x64.url = 'https://example.com/other.zip';
  fs.writeFileSync(filename, JSON.stringify(manifest));
  assert.throws(() => planRelease(root), /manifest does not match/);
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
