const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
async function bridgeStatus() {
  try {
    const response = await fetch('http://127.0.0.1:10086/status', {signal: AbortSignal.timeout(1500)});
    if (!response.ok) return null;
    const state = await response.json();
    return typeof state.extension_connected === 'boolean' ? {...state, running: true} : null;
  } catch { return null; }
}
async function ensureKimiBridge({platform = process.platform, resourcesRoot,
  status = bridgeStatus, exists = fs.existsSync,
  start = executable => run(executable, ['start'], {windowsHide: true, timeout: 15000})} = {}) {
  if (platform !== 'win32') return {running: false, reason: 'Windows bridge payload unavailable'};
  const existing = await status();
  if (existing?.running) return existing;
  const executable = path.join(resourcesRoot, 'runtime', 'kimi-webbridge', 'kimi-webbridge.exe');
  if (!exists(executable)) return {running: false, reason: 'Bridge binary missing'};
  await start(executable);
  return await status() ?? {running: false, reason: 'Bridge did not become ready'};
}
module.exports = {ensureKimiBridge};
