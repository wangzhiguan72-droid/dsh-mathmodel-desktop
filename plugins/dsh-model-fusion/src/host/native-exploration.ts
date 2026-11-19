import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import type { ExplorationReport, ExplorationSource, WorkOrder } from '../contracts.js'
import { sha256Hex } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { changedPaths, workspacePath } from './workspace.js'
import type { WorkspaceSnapshot } from './workspace.js'

interface PreparedSource { source: ExplorationSource; text: string; digest: string }

function formatChanged(paths: readonly string[]): string {
  const shown = paths.slice(0, 12)
  if (!shown.length) return '(snapshot id changed with no listed path delta)'
  return `${shown.join(', ')}${paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : ''}`
}

const EMPTY_SCOPE_NOTE = 'Host verified: the workspace listing contains no files.'

/**
 * The model's sentence is required, and it is never proof. Callers must already
 * have seen an empty host listing. A search miss inside a workspace that still
 * has files does not match these phrases into an exception.
 */
function statesEmptyScope(summary: string): boolean {
  const text = summary.toLowerCase()
  return text.includes('no files')
    || text.includes('zero files')
    || text.includes('0 files')
    || text.includes('scope is empty')
    || text.includes('empty scope')
    || text.includes('directory is empty')
    || text.includes('folder is empty')
    || text.includes('workspace is empty')
    || summary.includes('没有文件')
    || summary.includes('无文件')
    || summary.includes('空目录')
    || summary.includes('范围为空')
    || summary.includes('目录为空')
}

/**
 * The filtered manifest is not proof of emptiness. `readdir` omits `.` and `..`
 * and nothing else: a hidden file, a gitignored file, `.git`, or an excluded
 * directory such as `node_modules` is a real entry. A listing failure is not emptiness.
 */
export function scopeDirectoryEmpty(root: string): boolean {
  try { return readdirSync(root).length === 0 }
  catch { return false }
}

/** Both listings are the host's, and the directory itself has no entries. A failed live snapshot is not an empty scope. */
function hostVerifiedEmptyScope(baseline: WorkspaceSnapshot, current: WorkspaceSnapshot | undefined): boolean {
  return current !== undefined && baseline.root === current.root
    && baseline.entries.length === 0 && current.entries.length === 0
    && scopeDirectoryEmpty(current.root)
}

/** Read cited ranges against the frozen baseline. Nothing is stored until every range is valid. */
function prepareSources(baseline: WorkspaceSnapshot, sources: readonly ExplorationSource[]): PreparedSource[] {
  if (sources.length > 12) throw new Error('A completed exploration requires 1–12 source ranges')
  let total = 0
  return sources.map(source => {
    const path = workspacePath(baseline.root, source.path)
    const entry = baseline.entries.find(item => item.path === source.path && item.kind === 'file')
    if (!entry) throw new Error('Exploration sources must be files in the frozen workspace manifest')
    if (!Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine)
      || source.startLine < 1 || source.endLine < source.startLine || source.endLine - source.startLine >= 80) {
      throw new Error('Exploration source ranges require 1–80 lines each')
    }
    let stat
    try { stat = lstatSync(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Exploration source is missing')
      throw error
    }
    // A FIFO or socket is not source text. Reject it before readFileSync, which would block on a pipe.
    if (!stat.isFile()) throw new Error(`Unsupported source file type: ${source.path}`)
    const bytes = readFileSync(path)
    if (sha256Hex(bytes) !== entry.digest) throw new Error('Exploration source changed during capture')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (content.includes('\0')) throw new Error('Exploration sources must be text files')
    const lines = content.split('\n')
    if (source.endLine > lines.length) throw new Error('Exploration source range exceeds the file')
    const text = lines.slice(source.startLine - 1, source.endLine).join('\n')
    total += Buffer.byteLength(text, 'utf8')
    if (total > 24_000) throw new Error('Exploration excerpts exceed 24000 bytes; select narrower ranges')
    return { source, text, digest: entry.digest }
  })
}

function storeSources(store: SqliteFusionStore, taskId: WorkOrder['taskId'], prepared: readonly PreparedSource[]): ExplorationReport['sources'] {
  return prepared.map(item => ({ ...item.source, fileDigest: item.digest,
    excerpt: store.putArtifact(taskId, Buffer.from(item.text), 'text/plain') }))
}

/**
 * Source-backed handoff. Completed reports are checked against the files they cite,
 * not against every other file in a non-git root. blocked and needs-decision reports
 * are always recorded, with drift or a failed whole-tree snapshot named, and are not acceptance.
 *
 * A completed report normally cites 1–12 ranges. Zero ranges are accepted only when
 * the frozen baseline and the listing taken at submit time both contain no manifest
 * entries, the directory itself has no entries on disk, and the summary states that
 * the scope is empty. A filtered manifest is not that check: gitignored files, hidden
 * files and excluded directories still count. The sentence is not proof. A non-empty
 * directory still requires 1–12 ranges, including when a search matched nothing.
 *
 * `current` is omitted when snapshotting the tree threw. The failure is stored on a
 * non-completed report. A completed report ignores that unrelated failure and still
 * stands or falls on the cited files alone. Zero ranges cannot use that path, because
 * there is no cited file to check and the live listing was not confirmed empty.
 */
export function captureExploration(store: SqliteFusionStore, order: WorkOrder, baseline: WorkspaceSnapshot, current: WorkspaceSnapshot | undefined,
  submitted: Pick<ExplorationReport, 'summary' | 'status' | 'unresolved'>, sources: readonly ExplorationSource[], snapshotFailure?: string): ExplorationReport {
  if (order.mode !== 'explore' || baseline.id !== order.baseSnapshot || (current !== undefined && baseline.root !== current.root)) {
    throw new Error('Exploration capture requires the frozen explore baseline')
  }
  if (current === undefined && !snapshotFailure) throw new Error('Exploration capture requires a current snapshot or a recorded snapshot failure')
  const drifted = current !== undefined && baseline.id !== current.id
  const changed = drifted && current ? changedPaths(baseline, current) : []
  const driftDetail = drifted && current
    ? `Exploration workspace changed since frozen baseline ${baseline.id}; current snapshot ${current.id}; changed paths: ${formatChanged(changed)}. This is not acceptance. A completed report can cite only files that still match the baseline; blocked or needs-decision records this drift.`
    : undefined
  const snapshotDetail = current === undefined
    ? `Workspace snapshot failed: ${snapshotFailure}. Frozen baseline ${baseline.id}. This is not acceptance. The report is recorded so the blocker is not dropped; a completed report can cite only files that still match that baseline.`
    : undefined
  if (submitted.status !== 'completed') {
    const problems = [driftDetail, snapshotDetail].filter((item): item is string => item !== undefined)
    let prepared: PreparedSource[] = []
    if (sources.length) {
      try { prepared = prepareSources(baseline, sources) }
      catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }
    }
    return { schemaVersion: 1, workOrderId: order.id, revision: order.revision, summary: submitted.summary,
      status: submitted.status, unresolved: [...submitted.unresolved, ...problems], snapshot: baseline.id,
      sources: storeSources(store, order.taskId, prepared) }
  }
  if (sources.length > 12) throw new Error('A completed exploration requires 1–12 source ranges')
  if (!sources.length) {
    if (!hostVerifiedEmptyScope(baseline, current)) throw new Error('A completed exploration requires 1–12 source ranges')
    if (!statesEmptyScope(submitted.summary)) {
      throw new Error('The host listing contains no files. A completed report may omit source ranges only when the summary states that the scope is empty.')
    }
    const summary = submitted.summary.includes(EMPTY_SCOPE_NOTE) ? submitted.summary : `${submitted.summary}\n\n${EMPTY_SCOPE_NOTE}`
    return { schemaVersion: 1, workOrderId: order.id, revision: order.revision, ...submitted, summary,
      snapshot: baseline.id, sources: [] }
  }
  if (drifted && current) {
    const cited = new Set(sources.map(source => source.path))
    const citedChanged = changed.filter(path => cited.has(path))
    if (citedChanged.length) {
      throw new Error(`Cited exploration evidence changed: ${citedChanged.join(', ')}. Frozen baseline ${baseline.id}; current snapshot ${current.id}. Submit status "blocked" or "needs-decision" to record this drift; a completed report cannot cite files that no longer match the frozen baseline.`)
    }
  }
  const prepared = prepareSources(baseline, sources)
  return { schemaVersion: 1, workOrderId: order.id, revision: order.revision, ...submitted,
    snapshot: baseline.id, sources: storeSources(store, order.taskId, prepared) }
}

/** Path of the first cited file whose bytes no longer match the captured digest, if any. */
export function citedEvidenceChanged(root: string, baseline: WorkspaceSnapshot, report: Pick<ExplorationReport, 'sources'>): string | undefined {
  for (const source of report.sources) {
    const entry = baseline.entries.find(item => item.path === source.path && item.kind === 'file')
    if (!entry || entry.digest !== source.fileDigest) return source.path
    try {
      const path = workspacePath(root, source.path)
      if (!lstatSync(path).isFile()) return source.path
      const bytes = readFileSync(path)
      if (sha256Hex(bytes) !== source.fileDigest) return source.path
    } catch { return source.path }
  }
  return undefined
}
