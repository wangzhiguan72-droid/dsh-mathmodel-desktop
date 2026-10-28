import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const policyReason = Symbol('benchmark-policy-reason');
function deny(reason) { const error = new Error('Benchmark file policy rejected'); error[policyReason] = reason; throw error; }

// A deliberately narrow policy for generated code fixtures, not a global Host sandbox.
export function createBenchmarkFileGuard({ workspace, auditFile }) {
  const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const root = fs.realpathSync(workspace), rootIdentity = identity(root);
  if (fs.lstatSync(workspace).isSymbolicLink()) throw new Error('Benchmark workspace must not be a link');
  const files = new Set(['TASK.md', 'public.test.cjs', 'solution.cjs']);
  return exec => {
    let reason, logicalPath = null, requestPath;
    try {
      if (!['read', 'write', 'edit'].includes(exec.name)) deny('tool-not-allowed');
      const args = typeof exec.arguments === 'string' ? JSON.parse(exec.arguments) : exec.arguments;
      requestPath = args?.file_path;
      if (typeof requestPath !== 'string' || !requestPath || /[\x00-\x1f]/.test(requestPath)) deny('invalid-file-path');
      const segments = requestPath.split(/[\\/]/);
      if (segments.includes('..') || segments.some(part => part !== '.' && /[ .]$/.test(part))) deny('noncanonical-file-path');
      if (/^[\\/]{2}/.test(requestPath) || /^[\\/]/.test(requestPath) && !path.isAbsolute(requestPath)) deny('device-or-root-relative-path');
      const withoutDrive = requestPath.replace(/^[a-z]:[\\/]/i, '');
      if (withoutDrive.includes(':')) deny('drive-stream-or-uri-path');
      const candidate = path.resolve(workspace, requestPath), basename = path.basename(candidate);
      if (!files.has(basename)) deny('file-not-allowed');
      if (exec.name !== 'read' && basename !== 'solution.cjs') deny('fixture-is-read-only');
      if (identity(fs.realpathSync(workspace)) !== rootIdentity || fs.lstatSync(workspace).isSymbolicLink()) deny('workspace-identity-changed');
      if (identity(fs.realpathSync(path.dirname(candidate))) !== rootIdentity) deny('outside-workspace');
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) deny('linked-or-nonregular-file');
      if (identity(fs.realpathSync(candidate)) !== identity(path.join(root, basename))) deny('file-identity-changed');
      logicalPath = basename;
    } catch (error) { reason = error[policyReason] ?? (error.code ? 'unavailable-file-or-path' : 'invalid-tool-arguments'); }
    // No file contents, edit payloads, credential values or rejected absolute paths.
    if (auditFile) fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), callId: exec.callId,
      tool: exec.name, allowed: !reason, logicalPath, reason: reason ?? null,
      requestPathSha256: typeof requestPath === 'string' ? createHash('sha256').update(requestPath).digest('hex') : null }) + '\n');
    return reason ? `Benchmark file policy denied: ${reason}. Only read TASK.md/public.test.cjs/solution.cjs, and write/edit solution.cjs.` : undefined;
  };
}
