'use strict';

// Read-only validation runs outside Electron's UI thread. This file and its
// core module are copied from app.asar beside a nonce-bound request.
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const filename = path.resolve(process.argv[2]);
  const request = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const cache = path.dirname(filename);
  if (request.schema !== 'dsh.stage-validation/v1' || !/^[a-f0-9-]{36}$/.test(request.nonce)
    || filename !== path.join(cache, `${request.nonce}.validation-request.json`)
    || request.output !== path.join(cache, `${request.nonce}.validation-result.json`)
    || request.coreModule !== path.join(cache, `${request.nonce}.validator-core.cjs`)
    || request.treeModule !== path.join(cache, `${request.nonce}.validator-tree.cjs`)) {
    throw new Error('Invalid stage validation request');
  }
  const core = require(request.coreModule);
  const { treeDigestAsync } = require(request.treeModule);
  if (request.archiveManifest) core.verifyExtractedZip(request.candidateDir, request.archiveManifest);
  core.validateCandidate(request.candidateDir, request.identity);
  fs.writeFileSync(request.output, JSON.stringify({ nonce: request.nonce,
    candidateSha256: await treeDigestAsync(request.candidateDir) }), { flag: 'wx' });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
