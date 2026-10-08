import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import vm from 'node:vm'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const vendor = path.join(root, 'resources/runtime/profile-web/node_modules/@linxin666/dsh-client-ui-git-graph/lib/client.js')
const aggregateVendor = path.join(root, 'resources/runtime/profile-web/node_modules/@linxin666/dsh-web-all/lib/client.js')
const patcher = path.join(root, 'scripts/patch-git-graph.mjs')
const begin = '\t\t//#region src/client/auto-isolation.ts'
const end = '\t\t//#endregion'

async function installFromStagedBundle(bundle = vendor) {
  const original = await readFile(bundle, 'utf8')
  const source = existsSync(patcher)
    ? (await import(`../scripts/patch-git-graph.mjs?test=${Date.now()}`)).patchGitGraphSource(original)
    : original
  const first = source.indexOf(bundle === aggregateVendor ? '\t\t//#region ../dsh-git-graph/src/client/auto-isolation.ts' : begin)
  const last = source.indexOf(end, first)
  assert.ok(first !== -1 && last > first, 'real vendor auto-isolation function is available')
  const warnings = []
  const install = vm.runInNewContext(`${source.slice(first, last)}\ninstallAutoIsolation`, {
    console: { warn: (...args) => warnings.push(args) },
  })
  return { install, warnings }
}

function fixture({ autoIsolate = true, addWorktree, create } = {}) {
  const events = []
  const workspaceItems = [{ workspaceId: 'main', path: 'C:/repo', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z' }]
  const workspaces = {
    list: { getSnapshot: () => ({ phase: 'ready', items: workspaceItems }) },
    async create(input) {
      assert.equal(this, workspaces)
      events.push(['register', input.path])
      if (create) return create(input)
      return { workspaceId: 'new' }
    },
    async delete(id) { assert.equal(this, workspaces); events.push(['delete', id]) },
  }
  const uiWorkspace = {
    startSession(id) { assert.equal(this, uiWorkspace); events.push(['navigate', id]) },
    async connectWorkspace() { assert.equal(this, uiWorkspace); return 's2' },
  }
  const git = {
    async config() { return { ok: true, value: { autoIsolate, worktreesHome: 'C:/managed', autoBaseline: 'current' } } },
    async status(p) { assert.equal(p, 'C:/repo'); return { ok: true, value: { branch: 'main' } } },
    async addWorktree(p) { assert.equal(p, 'C:/repo'); events.push(['add', p]); return addWorktree ? addWorktree() : { ok: true, value: { path: 'C:/managed/new' } } },
    async removeWorktree(p, worktree, opts) { events.push(['remove', p, worktree, opts.force]); return { ok: true, value: { removed: true } } },
  }
  const scope = {
    workspaces, uiWorkspace,
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', current: 's1', byId: { s1: { id: 's1', updatedAt: 1 } } }) } },
  }
  return { events, scope, git }
}

test('rc.3 new-session navigation registers a worktree and calls the UI service with its own this', async () => {
  const { install, warnings } = await installFromStagedBundle()
  const { events, scope, git } = fixture()
  const dispose = install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo'], ['register', 'C:/managed/new'], ['navigate', 'new']])
  assert.equal(warnings.length, 0)
  dispose()
})

test('disabled setting delegates to official navigation without creating a worktree', async () => {
  const { install } = await installFromStagedBundle()
  const { events, scope, git } = fixture({ autoIsolate: false })
  install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['navigate', 'main']])
})

test('registration failure removes the created worktree and delegates to main checkout', async () => {
  const { install } = await installFromStagedBundle()
  const { events, scope, git } = fixture({ create: async () => { throw Error('registration failed') } })
  install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo'], ['register', 'C:/managed/new'], ['remove', 'C:/repo', 'C:/managed/new', true], ['navigate', 'main']])
})

test('managed worktree sessions never create nested isolation', async () => {
  const { install, warnings } = await installFromStagedBundle()
  const { events, scope, git } = fixture()
  scope.workspaces.list.getSnapshot = () => ({ phase: 'ready', items: [
    { workspaceId: 'main', path: 'C:/managed/existing', sessionIds: ['s1'] },
  ] })
  install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['navigate', 'main']])
  assert.equal(warnings.length, 0)
})

test('failed Git worktree creation falls back without registering an unusable workspace', async () => {
  const { install, warnings } = await installFromStagedBundle()
  const { events, scope, git } = fixture({ addWorktree: () => ({ ok: false, error: 'missing baseline' }) })
  install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo'], ['navigate', 'main']])
  assert.match(warnings[0]?.[0] ?? '', /worktree creation failed/)
})

test('concurrent new-session actions route once, and dispose restores official navigation', async () => {
  const { install } = await installFromStagedBundle()
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { events, scope, git } = fixture({ addWorktree: () => pending })
  const original = scope.uiWorkspace.startSession
  const dispose = install(scope, git)
  scope.uiWorkspace.startSession('main')
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo']])
  release({ ok: true, value: { path: 'C:/managed/new' } })
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo'], ['register', 'C:/managed/new'], ['navigate', 'new']])
  dispose()
  assert.equal(scope.uiWorkspace.startSession, original)
  scope.uiWorkspace.startSession('main')
  assert.deepEqual(events.at(-1), ['navigate', 'main'])
})

test('missing UI navigation surface leaves the data service untouched and reports incompatibility', async () => {
  const { install, warnings } = await installFromStagedBundle()
  const { scope, git } = fixture()
  delete scope.uiWorkspace
  const before = scope.workspaces.create
  const dispose = install(scope, git)
  assert.equal(scope.workspaces.create, before)
  assert.match(warnings[0]?.[0] ?? '', /disabled: workspace data or navigation service shape changed/)
  dispose()
})

test('implicit target follows rc.3 most-recent workspace selection', async () => {
  const { install } = await installFromStagedBundle()
  const { events, scope, git } = fixture({ autoIsolate: false })
  scope.workspaces.list.getSnapshot = () => ({ phase: 'ready', items: [
    { workspaceId: 'older', path: 'C:/older', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z' },
    { workspaceId: 'newer', path: 'C:/newer', sessionIds: ['s2'], createdAt: '2026-01-02T00:00:00Z' },
  ] })
  scope.sessions.list.getSnapshot = () => ({ phase: 'ready', current: undefined, byId: {
    s1: { id: 's1', updatedAt: 1 }, s2: { id: 's2', updatedAt: 2 },
  } })
  install(scope, git)
  scope.uiWorkspace.startSession()
  await nextTurn()
  assert.deepEqual(events, [['navigate', 'newer']])
})

test('the full-profile aggregate bundle also routes rc.3 new sessions into a real worktree workspace', async () => {
  const { install, warnings } = await installFromStagedBundle(aggregateVendor)
  const { events, scope, git } = fixture()
  install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo'], ['register', 'C:/managed/new'], ['navigate', 'new']])
  assert.equal(warnings.length, 0)
})

test('staging patch validates the pinned package and is idempotent', async (t) => {
  const { patchGitGraphProfile } = await import('../scripts/patch-git-graph.mjs')
  const ownTemp = await mkdtemp(path.join(os.tmpdir(), 'dsh-gitgraph-test-'))
  t.after(async () => {
    assert.equal(path.dirname(ownTemp), os.tmpdir())
    await rm(ownTemp, { recursive: true, force: true })
  })
  const bundleDir = path.join(ownTemp, 'node_modules', '@linxin666', 'dsh-client-ui-git-graph')
  await mkdir(path.join(bundleDir, 'lib'), { recursive: true })
  await writeFile(path.join(bundleDir, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-client-ui-git-graph', version: '0.3.23' }))
  await writeFile(path.join(bundleDir, 'lib', 'client.js'), await readFile(vendor))
  const aggregateDir = path.join(ownTemp, 'node_modules', '@linxin666', 'dsh-web-all')
  await mkdir(path.join(aggregateDir, 'lib'), { recursive: true })
  await writeFile(path.join(aggregateDir, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-web-all', version: '0.3.23' }))
  await writeFile(path.join(aggregateDir, 'lib', 'client.js'), await readFile(aggregateVendor))
  await patchGitGraphProfile(ownTemp)
  const first = await readFile(path.join(bundleDir, 'lib', 'client.js'), 'utf8')
  assert.match(first, /const uiWorkspace = probeUiWorkspace\(scope\.uiWorkspace\)/)
  assert.match(await readFile(path.join(aggregateDir, 'lib', 'client.js'), 'utf8'), /const uiWorkspace = probeUiWorkspace\(scope\.uiWorkspace\)/)
  assert.equal((await patchGitGraphProfile(ownTemp)).changed, false)
  assert.equal(await readFile(path.join(bundleDir, 'lib', 'client.js'), 'utf8'), first)
  await writeFile(path.join(bundleDir, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-client-ui-git-graph', version: '0.3.24' }))
  await assert.rejects(patchGitGraphProfile(ownTemp), /Unsupported Git Graph package/)
})
