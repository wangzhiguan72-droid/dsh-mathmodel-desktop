// Adapt the pinned Git Graph 0.3.23 browser bundle to the rc.3 split between
// Workspace Controller data and uiWorkspace navigation. Run on a staged
// profile, before packaging; never edit a user's installed profile.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageName = '@linxin666/dsh-client-ui-git-graph'
const aggregateName = '@linxin666/dsh-web-all'
const expectedVersion = '0.3.23'
const markers = ['\t\t//#region src/client/auto-isolation.ts',
  '\t\t//#region ../dsh-git-graph/src/client/auto-isolation.ts']
const endMarker = '\t\t//#endregion'

function replaceOnce(source, before, after) {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Git Graph rc.3 patch anchor missing or ambiguous: ${before.slice(0, 80)}`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

export function patchGitGraphSource(source) {
  const found = markers.filter(marker => source.includes(marker))
  if (found.length !== 1) throw new Error('Git Graph auto-isolation region missing or ambiguous')
  const start = source.indexOf(found[0])
  if (source.indexOf(found[0], start + found[0].length) >= 0) throw new Error('Duplicate Git Graph auto-isolation region')
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error('Git Graph auto-isolation region missing')
  const before = source.slice(start, end)
  if (before.includes('const uiWorkspace = probeUiWorkspace(scope.uiWorkspace)')) {
    if (!source.includes('ctx.inject(["workspaces", "sessions", "uiWorkspace"], (worktreeScope) => {')) {
      throw new Error('Partial Git Graph rc.3 patch: navigation injection is missing')
    }
    return source
  }
  let section = before
  section = replaceOnce(section,
    'function probeWorkspaces(value) {\n\t\t\tif (typeof value !== "object" || value === null) return null;\n\t\t\tconst candidate = value;\n\t\t\tif (typeof candidate.startSession !== "function" || typeof candidate.create !== "function" || typeof candidate.connectWorkspace !== "function" || typeof candidate.list?.getSnapshot !== "function") return null;\n\t\t\treturn candidate;\n\t\t}',
    'function probeUiWorkspace(value) {\n\t\t\tif (typeof value !== "object" || value === null) return null;\n\t\t\tif (typeof value.startSession !== "function" || typeof value.connectWorkspace !== "function") return null;\n\t\t\treturn value;\n\t\t}')
  section = replaceOnce(section,
    'const workspaces = probeWorkspaces(scope.workspaces);\n\t\t\tif (workspaces === null) {',
    'const workspaces = scope.workspaces;\n\t\t\tconst uiWorkspace = probeUiWorkspace(scope.uiWorkspace);\n\t\t\tif (uiWorkspace === null || typeof workspaces?.create !== "function" || typeof workspaces.list?.getSnapshot !== "function" || typeof scope.sessions?.list?.getSnapshot !== "function") {')
  section = replaceOnce(section,
    'disabled: the workspaces service shape changed; using the official new-session behavior',
    'disabled: workspace data or navigation service shape changed; using the official new-session behavior')
  section = replaceOnce(section, 'original = workspaces.startSession;', 'original = uiWorkspace.startSession;')
  section = replaceOnce(section,
    'const resolveTarget = (workspaceId) => {\n\t\t\t\tconst snapshot = workspaces.list.getSnapshot();\n\t\t\t\tconst current = scope.sessions.list.getSnapshot().current;\n\t\t\t\tconst currentWorkspaceId = current === void 0 ? void 0 : snapshot.items.find((item) => item.sessionIds.includes(current))?.workspaceId;\n\t\t\t\treturn workspaceId ?? currentWorkspaceId ?? snapshot.recentWorkspaceId;\n\t\t\t};',
    `const resolveTarget = (workspaceId) => {
                const workspace = workspaces.list.getSnapshot();
                const sessions = scope.sessions.list.getSnapshot();
                const current = sessions.current;
                const currentWorkspaceId = current === void 0 ? void 0 : workspace.items.find((item) => item.sessionIds.includes(current))?.workspaceId;
                if (workspaceId !== void 0 || currentWorkspaceId !== void 0) return workspaceId ?? currentWorkspaceId;
                if (workspace.phase !== "ready" || sessions.phase !== "ready") return void 0;
                let selected;
                let selectedTime = Number.NEGATIVE_INFINITY;
                for (const item of workspace.items) {
                    let latest = Number.NEGATIVE_INFINITY;
                    for (const id of item.sessionIds) {
                        const session = sessions.byId[id];
                        if (session !== void 0) latest = Math.max(latest, session.updatedAt);
                    }
                    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(item.createdAt);
                    if (selected === void 0 || latest > selectedTime) {
                        selected = item.workspaceId;
                        selectedTime = latest;
                    }
                }
                return selected;
            };`)
  section = section.replaceAll('original.call(workspaces', 'original.call(uiWorkspace')
  section = replaceOnce(section, 'workspaces.startSession = routed;', 'uiWorkspace.startSession = routed;')
  section = replaceOnce(section, 'workspaces.startSession = original;', 'uiWorkspace.startSession = original;')
  let patched = source.slice(0, start) + section + source.slice(end)
  patched = replaceOnce(patched,
    'ctx.inject(["workspaces", "sessions"], (worktreeScope) => {',
    'ctx.inject(["workspaces", "sessions", "uiWorkspace"], (worktreeScope) => {')
  return patched
}

export async function patchGitGraphProfile(profileDir) {
  const patches = []
  for (const name of [packageName, aggregateName]) {
    const packageDir = path.join(profileDir, 'node_modules', ...name.split('/'))
    const meta = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
    if (meta.name !== name || meta.version !== expectedVersion) {
      throw new Error(`Unsupported Git Graph package: ${meta.name}@${meta.version}`)
    }
    const bundle = path.join(packageDir, 'lib', 'client.js')
    const before = await readFile(bundle, 'utf8')
    patches.push({ bundle, before, after: patchGitGraphSource(before) })
  }
  // Validate both embedded copies before writing either staged bundle.
  for (const { bundle, before, after } of patches) {
    if (after !== before) await writeFile(bundle, after)
  }
  return { changed: patches.some(({ before, after }) => before !== after),
    bundle: patches[0].bundle, bundles: patches.map(({ bundle }) => bundle) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileDir = process.argv[2]
  if (!profileDir) throw new Error('Usage: node scripts/patch-git-graph.mjs <staged-profile-directory>')
  const result = await patchGitGraphProfile(path.resolve(profileDir))
  console.log(`Git Graph rc.3 compatibility ${result.changed ? 'patched' : 'already applied'}: ${result.bundles.join(', ')}`)
}
