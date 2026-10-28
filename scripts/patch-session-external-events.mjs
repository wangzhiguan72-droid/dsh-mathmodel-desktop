// The pinned Host accepts ignorable external events on read but its Session.append
// drops the marker. Patch only the staged copy; fail on an unfamiliar Host shape.
import fs from 'node:fs';
import path from 'node:path';

const before = [
  '\t\tconst surfaceMetadata = {',
  '\t\t\t...surfaceOpts?.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },',
  '\t\t\t...surfaceOpts?.surfaceOp === void 0 ? {} : { surfaceOp: surfaceOpts.surfaceOp }',
  '\t\t};',
].join('\n');
const after = [
  '\t\tconst surfaceMetadata = {',
  '\t\t\t...surfaceOpts?.ignorable === true ? { ignorable: true } : {},',
  '\t\t\t...surfaceOpts?.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },',
  '\t\t\t...surfaceOpts?.surfaceOp === void 0 ? {} : { surfaceOp: surfaceOpts.surfaceOp }',
  '\t\t};',
].join('\n');

export function patchSessionExternalEventsSource(source) {
  if (typeof source !== 'string') throw new TypeError('Session source must be text');
  const count = anchor => source.split(anchor).length - 1;
  if (!source.includes('append(type, data, ...opts) {') || !source.includes('const surfaceOpts = opts[0];')) {
    throw new Error('Pinned Session.append shape changed; external-event patch refused');
  }
  if (count(after) === 1 && count(before) === 0) return source;
  if (count(before) !== 1 || count(after) !== 0 ||
      !source.includes('append(type, data, ...opts) {') ||
      !source.includes('const surfaceOpts = opts[0];')) {
    throw new Error('Pinned Session.append shape changed; external-event patch refused');
  }
  return source.replace(before, after);
}

export function patchSessionExternalEvents({ runtimeRoot }) {
  if (!runtimeRoot) throw new TypeError('runtimeRoot is required');
  const target = path.join(runtimeRoot, '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
  const source = fs.readFileSync(target, 'utf8');
  const patched = patchSessionExternalEventsSource(source);
  if (patched !== source) fs.writeFileSync(target, patched);
  return { target, changed: patched !== source };
}
