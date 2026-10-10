'use strict';

const fs = require('node:fs');
const path = require('node:path');

// An old updater must never start a new session format before taking a data
// snapshot. The bridge release stays on V3 and installs the protected worker.
function assertUpdateBootSafe({ jobPath, nonce, installDir, userDataDir, homeDir, version }) {
  if (!jobPath) return;
  const filename = path.resolve(jobPath);
  if (!/^[a-f0-9-]{36}$/.test(nonce || '')
    || path.dirname(filename) !== path.join(path.resolve(userDataDir), 'desktop-updates')) {
    throw new Error('Pending update boot identity mismatch');
  }
  const job = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (job.nonce !== nonce || job.installDir !== path.resolve(installDir)
    || job.toVersion !== version || job.state !== 'prepared') {
    throw new Error('Pending update boot identity mismatch');
  }
  const source = fs.readFileSync(path.join(installDir, 'resources/runtime/host/node_modules/@deepseek-ai/dsh-session/lib/index.js'), 'utf8');
  const matches = [...source.matchAll(/\bconst SESSION_FORMAT_VERSION\s*=\s*(\d+)\s*;/g)];
  if (matches.length !== 1) throw new Error('Cannot identify bundled session format');
  const target = Number(matches[0][1]);
  if (target < 4) return;
  if (job.sessionFormatTo !== target || !Number.isSafeInteger(job.sessionFormatFrom)
    || job.sessionFormatFrom < 1) {
    throw new Error('Protected updater required before upgrading the session format');
  }
  if (job.sessionFormatFrom !== target) {
    const snapshot = job.dataSnapshot;
    if (!snapshot || snapshot.nonce !== nonce || snapshot.home !== path.resolve(homeDir)
      || snapshot.userData !== path.resolve(userDataDir) || job.homeDir !== path.resolve(homeDir)) {
      throw new Error('Session format update data snapshot identity mismatch');
    }
    // Verifies the backup still exists and belongs to these exact data roots.
    require('./update-data-snapshot.cjs').assertSnapshotBackup(snapshot);
  }
}

module.exports = { assertUpdateBootSafe };
