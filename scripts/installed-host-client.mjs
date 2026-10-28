// Small Node client for the currently running, authenticated desktop Host.
// Importing this module has no network or Host side effects.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const defaultLog = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'),
  'dsh-mathmodel-desktop', 'logs', 'dsh-host.log');
const namePattern = /^[A-Za-z0-9_$.-]+$/;
const channelPattern = /^\/[A-Za-z0-9._~-]+$/;

export async function createInstalledHostClient({ logFile = defaultLog, fetchImpl = fetch } = {}) {
  const log = await fs.readFile(logFile, 'utf8');
  const urls = [...log.matchAll(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)(?: \(LAN: .*\))?\r?$/gm)];
  if (!urls.length) throw new Error('No authenticated loopback Host URL was found in the desktop log');
  // Only the last boot belongs to the installed desktop currently under test.
  const base = new URL(urls.at(-1)[1]);
  let first;
  try {
    first = await fetchImpl(base, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error('The latest logged desktop Host is not reachable');
  }
  const cookies = first.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  if (!cookies) throw new Error(`Desktop Host authentication did not issue a cookie (HTTP ${first.status})`);
  const origin = base.origin;

  async function request(pathname, options = {}) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
      throw new TypeError('Desktop Host request path must be an origin-relative path');
    }
    const target = new URL(pathname, origin);
    if (target.origin !== origin) throw new TypeError('Desktop Host request must stay on the authenticated loopback origin');
    const response = await fetchImpl(target, {
      ...options,
      headers: { ...options.headers, cookie: cookies },
      signal: options.signal ?? AbortSignal.timeout(30000),
    });
    return response;
  }

  async function call(channel, endpoint, payload = {}) {
    if (!channelPattern.test(channel) ||
        endpoint.split('/').some(segment => !namePattern.test(segment)) ||
        payload === null || Array.isArray(payload) || typeof payload !== 'object') {
      throw new TypeError('Connection call requires a valid channel, endpoint, and payload object');
    }
    const rpcId = randomUUID();
    let response;
    try {
      response = await request(`${channel}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error(`Desktop Host RPC transport failed: ${endpoint}`);
    }
    if (!response.ok) throw new Error(`Desktop Host RPC HTTP ${response.status}: ${endpoint}`);
    const envelope = await response.json();
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId ||
        typeof envelope.result?.ok !== 'boolean') {
      throw new Error(`Invalid Desktop Host RPC response: ${endpoint}`);
    }
    if (!envelope.result.ok) {
      const error = envelope.result.error;
      throw new Error(`Desktop Host RPC ${endpoint}: ${error?.code || 'unknown'}: ${error?.message || 'failed'}`);
    }
    return envelope.result.value;
  }
  function rpc(namespace, method, args = {}) {
    if (!namePattern.test(namespace) || !namePattern.test(method)) {
      throw new TypeError('RPC requires a valid namespace and method');
    }
    return call('/api', `${namespace}/${method}`, { args });
  }
  return { call, rpc, request };
}

// CLI: node scripts/installed-host-client.mjs namespace method '{"namedArg":"value"}'
// Use --log path when testing an explicitly selected isolated desktop instance.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const logFlag = argv.indexOf('--log');
  const logFile = logFlag < 0 ? defaultLog : argv.splice(logFlag, 2)[1];
  if (argv.length < 2 || argv.length > 3) {
    console.error('Usage: node scripts/installed-host-client.mjs namespace method [jsonArgs] [--log path]');
    process.exitCode = 2;
  } else {
    try {
      const client = await createInstalledHostClient({ logFile });
      const value = await client.rpc(argv[0], argv[1], JSON.parse(argv[2] || '{}'));
      console.log(JSON.stringify(value));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
