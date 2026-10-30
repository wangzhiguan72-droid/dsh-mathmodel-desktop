import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseFiles } from './bootstrap-installed-desktop.mjs';

const OWNER = 'wangzhiguan72-droid';
const REPO = 'dsh-mathmodel-desktop';
const BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BRIDGE_VERSION = '0.1.3-bridge.1';
const KERNEL_VERSION = '0.1.3';
const FOLLOWUP_VERSION = '0.1.4';
const PREVIOUS_VERSION = '0.1.5';
const LAST_VERSION = '0.1.6';
const PRIOR_VERSION = '0.1.7';
const EARLIER_VERSION = '0.1.8';
const RECENT_VERSION = '0.1.9';
const CURRENT_VERSION = '0.2.0';
const RELEASES = Object.freeze({
  [BRIDGE_VERSION]: { tag: `v${BRIDGE_VERSION}` },
  [KERNEL_VERSION]: { tag: `v${KERNEL_VERSION}` },
  [FOLLOWUP_VERSION]: { tag: `v${FOLLOWUP_VERSION}` },
  [PREVIOUS_VERSION]: { tag: `v${PREVIOUS_VERSION}` },
  [LAST_VERSION]: { tag: `v${LAST_VERSION}` },
  [PRIOR_VERSION]: { tag: `v${PRIOR_VERSION}` },
  [EARLIER_VERSION]: { tag: `v${EARLIER_VERSION}` },
  [RECENT_VERSION]: { tag: `v${RECENT_VERSION}` },
  [CURRENT_VERSION]: { tag: `v${CURRENT_VERSION}` },
});
// Kernel feeds keep the bridge as their base route so pre-bridge installs migrate first.
const BRIDGE_ZIP = `dsh-mathmodel-desktop-${BRIDGE_VERSION}-win-x64.zip`;
const BRIDGE_URL = `https://github.com/${OWNER}/${REPO}/releases/download/v${BRIDGE_VERSION}/${BRIDGE_ZIP}`;
const API_VERSION = '2026-03-10';
const MAX_JSON_BYTES = 1024 * 1024;

function sha256(filename) {
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const descriptor = fs.openSync(filename, 'r');
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(descriptor); }
  return digest.digest('hex');
}

function ordinaryFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release file is unsafe: ${path.basename(filename)}`);
  return stat;
}

function asset(filename, expectedHash) {
  const stat = ordinaryFile(filename);
  const digest = sha256(filename);
  if (expectedHash && digest !== expectedHash) throw new Error(`Release SHA-256 mismatch: ${path.basename(filename)}`);
  return { name: path.basename(filename), path: filename, bytes: stat.size, sha256: digest };
}

export function planRelease(releaseDir, { version = CURRENT_VERSION, bridgeDir, bridgePublished = false } = {}) {
  const release = RELEASES[version];
  if (!release) throw new Error('Unsupported desktop release version');
  if (version === BRIDGE_VERSION && (bridgeDir || bridgePublished)) {
    throw new Error('Bridge publication cannot include --bridge-dir or --bridge-published');
  }
  if (version !== BRIDGE_VERSION && Boolean(bridgeDir) === Boolean(bridgePublished)) {
    throw new Error('Kernel publication requires --bridge-dir or --bridge-published (exactly one)');
  }
  const verified = releaseFiles(releaseDir, version);
  const manifestPath = path.join(releaseDir, 'desktop-update.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectedUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${release.tag}/${verified.zip.name}`;
  // A published bridge is pinned by the manifest here and checked against GitHub before publication.
  const pinned = manifest.windows?.x64;
  if (bridgePublished && (typeof pinned?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pinned.sha256)
    || !Number.isSafeInteger(pinned.bytes) || pinned.bytes < 1000000)) {
    throw new Error('Desktop update manifest does not pin a valid published bridge ZIP');
  }
  const expectedAsset = version === BRIDGE_VERSION ? verified.zip
    : bridgePublished ? { name: BRIDGE_ZIP, sha256: pinned.sha256, bytes: pinned.bytes }
      : releaseFiles(bridgeDir, BRIDGE_VERSION).zip;
  const expectedBaseUrl = version === BRIDGE_VERSION ? expectedUrl : BRIDGE_URL;
  if (manifest.schema !== 'dsh.desktop-update/v1' || manifest.appId !== 'com.deepseek.harness.mathmodel'
    || manifest.channel !== 'stable' || manifest.version !== (version === BRIDGE_VERSION ? version : BRIDGE_VERSION)
    || manifest.windows?.x64?.url !== expectedBaseUrl
    || manifest.windows.x64.sha256 !== expectedAsset.sha256
    || manifest.windows.x64.bytes !== expectedAsset.bytes) {
    throw new Error('Desktop update manifest does not match the verified ZIP and release URL');
  }
  if (version === BRIDGE_VERSION) {
    if (manifest.upgrades !== undefined) throw new Error('Bridge manifest cannot include upgrade routes');
  } else {
    const [upgrade] = Array.isArray(manifest.upgrades) ? manifest.upgrades : [];
    if (!Array.isArray(manifest.upgrades) || manifest.upgrades.length !== 1 || upgrade.schema !== manifest.schema
      || upgrade.appId !== manifest.appId || upgrade.channel !== manifest.channel
      || upgrade.minVersion !== BRIDGE_VERSION || upgrade.version !== version
      || upgrade.windows?.x64?.url !== expectedUrl
      || upgrade.windows.x64.sha256 !== verified.zip.sha256
      || upgrade.windows.x64.bytes !== verified.zip.bytes) {
      throw new Error('Desktop update upgrade route does not match the verified kernel ZIP');
    }
  }
  const files = [
    asset(verified.zip.entry, verified.zip.sha256),
    asset(verified.nsis.entry, verified.nsis.sha256),
    asset(manifestPath),
    asset(path.join(releaseDir, 'SHA256SUMS.txt')),
    asset(path.join(releaseDir, `release-notes-${version}.txt`)),
  ];
  const notes = fs.readFileSync(files[4].path, 'utf8');
  if (!notes.trim()) throw new Error('Release notes are empty');
  const plan = { schema: 'dsh.desktop-release-plan/v1', repository: `${OWNER}/${REPO}`,
    tag: release.tag, version, releaseUrl: `https://github.com/${OWNER}/${REPO}/releases/tag/${release.tag}`, files, notes };
  if (bridgePublished) {
    plan.publishedBridge = { tag: `v${BRIDGE_VERSION}`, name: BRIDGE_ZIP, url: BRIDGE_URL,
      sha256: expectedAsset.sha256, bytes: expectedAsset.bytes };
  }
  return plan;
}

export function readGitCredential() {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['credential', 'fill'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    let output = '', overflow = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Git credential lookup timed out')); }, 15000);
    child.stdout.on('data', data => {
      output += data.toString('utf8');
      if (Buffer.byteLength(output) > 65536) { overflow = true; child.kill(); }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Git credential lookup failed')); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (overflow || code !== 0) return reject(new Error('Git credential is unavailable'));
      const line = output.split(/\r?\n/).find(item => item.startsWith('password='));
      const token = line?.slice('password='.length);
      if (!token) return reject(new Error('Git credential is unavailable'));
      resolve(token);
    });
    child.stdin.end(`protocol=https\nhost=github.com\npath=${OWNER}/${REPO}.git\n\n`);
  });
}

function validateCommit(commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit || '')) {
    throw new Error('A complete 40- or 64-character commit SHA is required');
  }
  return commit.toLowerCase();
}

function safeUploadUrl(raw, releaseId) {
  const base = String(raw || '').split('{')[0];
  let url;
  try { url = new URL(base); } catch { throw new Error('Unsafe release upload URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'uploads.github.com' || url.port
    || url.username || url.password || url.hash || url.search
    || url.pathname !== `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets`) {
    throw new Error('Unsafe release upload URL');
  }
  return url;
}

async function readJsonResponse(response, operation, allowedStatuses) {
  if (!allowedStatuses.includes(response.status)) throw new Error(`${operation} failed (HTTP ${response.status})`);
  let body = '';
  if (response.body && Symbol.asyncIterator in response.body) {
    let length = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_JSON_BYTES) throw new Error(`${operation} response is too large`);
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
  } else {
    body = await response.text();
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new Error(`${operation} response is too large`);
  }
  try { return JSON.parse(body); } catch { throw new Error(`${operation} returned invalid JSON`); }
}

async function timedRequest(fetchImpl, url, options, operation, milliseconds, allowedStatuses) {
  const controller = new AbortController();
  const timer = { id: undefined };
  try {
    return await Promise.race([
      (async () => readJsonResponse(await fetchImpl(url, { ...options, signal: controller.signal }),
        operation, allowedStatuses))(),
      new Promise((_, reject) => {
        timer.id = setTimeout(() => {
          controller.abort();
          reject(new Error(`${operation} timed out; remote outcome is unknown`));
        }, milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer.id); }
}

function githubClient(fetchImpl, token, deadlines) {
  const headers = {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'dsh-mathmodel-desktop-release',
  };
  return {
    json(method, url, operation, allowedStatuses = [200], body) {
      const options = { method, redirect: 'manual', headers: { ...headers } };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = String(Buffer.byteLength(options.body));
      }
      return timedRequest(fetchImpl, url, options, operation, deadlines.apiMs, allowedStatuses);
    },
    async upload(url, file) {
      const type = file.name.endsWith('.zip') ? 'application/zip' : file.name.endsWith('.exe')
        ? 'application/octet-stream' : file.name.endsWith('.json') ? 'application/json' : 'text/plain';
      const stream = fs.createReadStream(file.path);
      try {
        return await timedRequest(fetchImpl, url, { method: 'POST', redirect: 'manual', duplex: 'half',
          headers: { ...headers, 'Content-Type': type, 'Content-Length': String(file.bytes) }, body: stream },
        `Upload ${file.name}`, deadlines.uploadMs, [201]);
      } finally { stream.destroy(); }
    },
  };
}

async function resolveTagCommit(client, tagName) {
  const reference = await client.json('GET', `${BASE}/git/ref/tags/${tagName}`, 'Read release tag');
  if (reference.ref !== `refs/tags/${tagName}` || !reference.object) throw new Error('Release tag response is invalid');
  let object = reference.object;
  for (let depth = 0; depth < 8 && object.type === 'tag'; depth++) {
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(object.sha || '')) throw new Error('Annotated tag SHA is invalid');
    const tag = await client.json('GET', `${BASE}/git/tags/${object.sha}`, 'Read annotated tag');
    object = tag.object;
  }
  if (object?.type !== 'commit' || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(object.sha || '')) {
    throw new Error('Release tag does not resolve to a commit');
  }
  return object.sha.toLowerCase();
}

function verifyReleaseIdentity(release, tagName) {
  if (!Number.isSafeInteger(release?.id) || release.id <= 0 || release.tag_name !== tagName
    || release.draft !== true || release.prerelease !== false) {
    throw new Error('Created release identity is invalid');
  }
  safeUploadUrl(release.upload_url, release.id);
}

// Confirm GitHub still serves the exact bridge ZIP that the new feed keeps as its base route.
async function verifyPublishedBridge(client, bridge) {
  if (bridge.tag !== `v${BRIDGE_VERSION}` || bridge.name !== BRIDGE_ZIP || bridge.url !== BRIDGE_URL) {
    throw new Error('Published bridge pin is invalid');
  }
  const release = await client.json('GET', `${BASE}/releases/tags/${bridge.tag}`, 'Read published bridge release');
  const assets = Array.isArray(release?.assets) ? release.assets.filter(item => item?.name === bridge.name) : [];
  const [zip] = assets;
  if (release?.tag_name !== bridge.tag || release.draft !== false || release.prerelease !== false
    || assets.length !== 1 || zip.state !== 'uploaded' || zip.size !== bridge.bytes
    || zip.digest !== `sha256:${bridge.sha256}` || zip.browser_download_url !== bridge.url) {
    throw new Error('Published bridge release does not match the pinned base route');
  }
}

function verifyAssets(remote, local) {
  if (!Array.isArray(remote) || remote.length !== local.length) throw new Error('Draft assets are incomplete');
  const byName = new Map(remote.map(item => [item.name, item]));
  if (byName.size !== local.length) throw new Error('Draft assets have duplicate names');
  for (const item of local) {
    const actual = byName.get(item.name);
    if (!actual || actual.state !== 'uploaded' || actual.size !== item.bytes
      || actual.digest !== `sha256:${item.sha256}` || sha256(item.path) !== item.sha256) {
      throw new Error(`Draft asset cannot be verified: ${item.name}`);
    }
  }
}

function checkedExistingAssets(remote, local) {
  if (!Array.isArray(remote)) throw new Error('Draft asset listing is invalid');
  const expected = new Map(local.map(file => [file.name, file]));
  const present = new Set();
  for (const asset of remote) {
    const file = expected.get(asset.name);
    if (!file || present.has(asset.name) || asset.state !== 'uploaded'
      || asset.size !== file.bytes || asset.digest !== `sha256:${file.sha256}`) {
      throw new Error(`Draft contains an unverified asset: ${String(asset.name || 'unknown')}`);
    }
    present.add(asset.name);
  }
  return present;
}

async function listedReleases(client, tagName) {
  const found = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await client.json('GET', `${BASE}/releases?per_page=100&page=${page}`, 'List releases');
    if (!Array.isArray(batch)) throw new Error('Release listing is invalid');
    found.push(...batch.filter(release => release.tag_name === tagName));
    if (batch.length < 100) return found;
  }
  throw new Error('Release listing exceeded safe pagination limit');
}

function result(release, plan) {
  return { state: 'published', releaseId: release.id, url: plan.releaseUrl,
    assets: plan.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    onlineManifestVerified: false };
}

export async function publishRelease({ releaseDir, commit, resumeDraft, version = CURRENT_VERSION, bridgeDir,
  bridgePublished = false }, dependencies = {}) {
  const expectedCommit = validateCommit(commit);
  if (!RELEASES[version]) throw new Error('Unsupported desktop release version');
  const plan = (dependencies.plan || planRelease)(releaseDir, { version, bridgeDir, bridgePublished });
  const tagName = RELEASES[version].tag;
  if (plan.repository !== `${OWNER}/${REPO}` || plan.tag !== tagName || plan.version !== version
    || plan.releaseUrl !== `https://github.com/${OWNER}/${REPO}/releases/tag/${tagName}`
    || Boolean(plan.publishedBridge) !== Boolean(bridgePublished)) {
    throw new Error('Release plan identity is invalid');
  }
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const token = await (dependencies.credential || readGitCredential)();
  if (!token) throw new Error('Git credential is unavailable');
  const deadlines = { apiMs: dependencies.deadlines?.apiMs ?? 30000,
    uploadMs: dependencies.deadlines?.uploadMs ?? 1200000 };
  if (![deadlines.apiMs, deadlines.uploadMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Request deadline is invalid');
  }
  const client = githubClient(fetchImpl, token, deadlines);
  const tagCommit = await resolveTagCommit(client, tagName);
  if (tagCommit !== expectedCommit) throw new Error('Remote release tag does not match the approved commit');
  if (plan.publishedBridge) await verifyPublishedBridge(client, plan.publishedBridge);
  const existing = await listedReleases(client, tagName);
  if (existing.length > 1) throw new Error('Multiple releases use the fixed tag');
  let draft;
  if (resumeDraft !== undefined) {
    const id = Number(resumeDraft);
    if (!Number.isSafeInteger(id) || id <= 0 || existing.length !== 1 || existing[0].id !== id) {
      throw new Error('Requested draft ID does not match the fixed release tag');
    }
    draft = await client.json('GET', `${BASE}/releases/${id}`, 'Read requested draft');
    verifyReleaseIdentity(draft, tagName);
  } else {
    if (existing.length) throw new Error(existing[0].draft
      ? `Draft release ${existing[0].id} already exists; inspect it and use --resume-draft ${existing[0].id}`
      : 'Published release already exists; inspect it before publishing');
    try {
      draft = await client.json('POST', `${BASE}/releases`, 'Create draft release', [201],
        { tag_name: tagName, target_commitish: expectedCommit, name: tagName, body: plan.notes,
          draft: true, prerelease: false, make_latest: 'false', generate_release_notes: false });
      verifyReleaseIdentity(draft, tagName);
    } catch (error) {
      throw new Error(`Draft creation outcome unknown: ${error.message}. Inspect release listing before retrying`);
    }
  }
  const uploadBase = safeUploadUrl(draft.upload_url, draft.id);
  try {
    const present = checkedExistingAssets(await client.json('GET',
      `${BASE}/releases/${draft.id}/assets?per_page=100`, 'List draft assets'), plan.files);
    for (const file of plan.files) {
      if (ordinaryFile(file.path).size !== file.bytes || sha256(file.path) !== file.sha256) {
        throw new Error(`Local release file changed: ${file.name}`);
      }
      if (present.has(file.name)) continue;
      const uploadUrl = new URL(uploadBase);
      uploadUrl.searchParams.set('name', file.name);
      await client.upload(uploadUrl, file);
    }
    const listed = await client.json('GET', `${BASE}/releases/${draft.id}/assets?per_page=100`, 'List draft assets');
    verifyAssets(listed, plan.files);
    if (await resolveTagCommit(client, tagName) !== expectedCommit) {
      throw new Error('Remote release tag changed before publication');
    }
    const beforePublish = await client.json('GET', `${BASE}/releases/${draft.id}`, 'Read draft before publication');
    verifyReleaseIdentity(beforePublish, tagName);
    if (beforePublish.id !== draft.id) throw new Error('Draft identity changed before publication');
  } catch (error) {
    throw new Error(`Release ${draft.id} remains a draft or needs inspection: ${error.message}`);
  }
  try {
    const published = await client.json('PATCH', `${BASE}/releases/${draft.id}`, 'Publish release', [200],
      { draft: false, prerelease: false, make_latest: 'true' });
    if (published.id !== draft.id || published.tag_name !== tagName || published.draft !== false) {
      throw new Error('Published release response is invalid');
    }
    return result(published, plan);
  } catch (error) {
    let observed;
    try { observed = await client.json('GET', `${BASE}/releases/${draft.id}`, 'Recheck publication result'); }
    catch { throw new Error(`Release ${draft.id} publication outcome unknown; inspect GitHub before retrying`); }
    if (observed.id === draft.id && observed.tag_name === tagName && observed.draft === false) {
      return result(observed, plan);
    }
    if (observed.id === draft.id && observed.tag_name === tagName && observed.draft === true) {
      throw new Error(`Release ${draft.id} remains a draft: ${error.message}`);
    }
    throw new Error(`Release ${draft.id} publication outcome unknown; inspect GitHub before retrying`);
  }
}

export function cliArgs(argv) {
  const defaultReleaseDir = path.resolve('dist', `release-${CURRENT_VERSION}`);
  const parsed = { releaseDir: defaultReleaseDir,
    version: CURRENT_VERSION, publish: false, plan: false, bridgePublished: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--plan') { parsed.plan = true; continue; }
    if (key === '--publish') { parsed.publish = true; continue; }
    if (key === '--bridge-published') { parsed.bridgePublished = true; continue; }
    if (key === '--release-dir' || key === '--commit' || key === '--resume-draft'
      || key === '--version' || key === '--bridge-dir') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing ${key} value`);
      parsed[key === '--commit' ? 'commit' : key === '--resume-draft' ? 'resumeDraft'
        : key === '--bridge-dir' ? 'bridgeDir' : key === '--version' ? 'version' : 'releaseDir'] = argv[++i];
      continue;
    }
    throw new Error(`Unknown release option: ${key}`);
  }
  if (parsed.publish && parsed.plan) throw new Error('--plan and --publish are mutually exclusive');
  if (parsed.bridgePublished && parsed.bridgeDir) throw new Error('--bridge-published and --bridge-dir are mutually exclusive');
  if (!RELEASES[parsed.version]) throw new Error('Unsupported desktop release version');
  if (!argv.includes('--release-dir')) {
    parsed.releaseDir = path.resolve('dist', parsed.version === BRIDGE_VERSION
      ? `updater-bridge-${BRIDGE_VERSION}` : parsed.version === KERNEL_VERSION
        ? `kernel-upgrade-${KERNEL_VERSION}` : `release-${parsed.version}`);
  }
  if (parsed.publish) validateCommit(parsed.commit);
  else if (parsed.commit) throw new Error('--commit requires --publish');
  if (parsed.resumeDraft !== undefined && !parsed.publish) throw new Error('--resume-draft requires --publish');
  if (parsed.resumeDraft !== undefined && (!/^[1-9][0-9]*$/.test(parsed.resumeDraft)
    || !Number.isSafeInteger(Number(parsed.resumeDraft)))) throw new Error('--resume-draft requires a positive release ID');
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = cliArgs(process.argv.slice(2));
    const result = args.publish ? await publishRelease(args) : planRelease(args.releaseDir, args);
    const display = args.publish ? result : { ...result, notes: undefined,
      files: result.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) };
    process.stdout.write(`${JSON.stringify(display, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
