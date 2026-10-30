import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import vm from 'node:vm'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const legacyFixture = path.join(root, 'tests/fixtures/git-graph-0.3.23-auto-isolation.js')
const vendor = path.join(root, 'runtime/profile-web/node_modules/@linxin666/dsh-client-ui-git-graph/lib/client.js')
const aggregateVendor = path.join(root, 'runtime/profile-web/node_modules/@linxin666/dsh-web-all/lib/client.js')
const installedFamily = JSON.parse(await readFile(path.join(path.dirname(aggregateVendor), '..', 'package.json'), 'utf8')).version
// From 0.4.11 the aggregate is a thin loader without its own Git Graph copy.
const thinAggregate = ['0.4.11', '0.4.12'].includes(installedFamily)
const begin = '\t\t//#region src/client/auto-isolation.ts'
const end = '\t\t//#endregion'

async function installFromLegacyBundle(aggregate = false) {
  const original = (await readFile(legacyFixture, 'utf8')).replace(begin,
    aggregate ? '\t\t//#region ../dsh-git-graph/src/client/auto-isolation.ts' : begin)
  const source = (await import('../scripts/patch-git-graph.mjs')).patchGitGraphSource(original)
  const first = source.indexOf(aggregate ? '\t\t//#region ../dsh-git-graph/src/client/auto-isolation.ts' : begin)
  const last = source.indexOf(end, first)
  assert.ok(first !== -1 && last > first, 'legacy auto-isolation fixture is available')
  const warnings = []
  const install = vm.runInNewContext(`${source.slice(first, last)}\ninstallAutoIsolation`, {
    console: { warn: (...args) => warnings.push(args) },
  })
  return { install, warnings }
}

async function installFromNativeBundle(bundle = vendor) {
  const source = await readFile(bundle, 'utf8')
  const { validateNativeGitGraphSource } = await import('../scripts/patch-git-graph.mjs')
  assert.equal(validateNativeGitGraphSource(source), source)
  const marker = bundle === aggregateVendor ? '\t\t//#region ../dsh-git-graph/src/client/auto-isolation.ts' : begin
  const first = source.indexOf(marker)
  const last = source.indexOf(end, first)
  assert.ok(first !== -1 && last > first, 'native 0.4.7 auto-isolation function is available')
  const warnings = []
  const mainViewSessionId = byId => Object.values(byId || {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
  const install = vm.runInNewContext(`${source.slice(first, last)}\ninstallAutoIsolation`, {
    console: { warn: (...args) => warnings.push(args) }, mainViewSessionId, mainViewSessionId$2: mainViewSessionId,
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
  const { install, warnings } = await installFromLegacyBundle()
  const { events, scope, git } = fixture()
  const dispose = install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo'], ['register', 'C:/managed/new'], ['navigate', 'new']])
  assert.equal(warnings.length, 0)
  dispose()
})

test('disabled setting delegates to official navigation without creating a worktree', async () => {
  const { install } = await installFromLegacyBundle()
  const { events, scope, git } = fixture({ autoIsolate: false })
  install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['navigate', 'main']])
})

test('registration failure removes the created worktree and delegates to main checkout', async () => {
  const { install } = await installFromLegacyBundle()
  const { events, scope, git } = fixture({ create: async () => { throw Error('registration failed') } })
  install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo'], ['register', 'C:/managed/new'], ['remove', 'C:/repo', 'C:/managed/new', true], ['navigate', 'main']])
})

test('managed worktree sessions never create nested isolation', async () => {
  const { install, warnings } = await installFromLegacyBundle()
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
  const { install, warnings } = await installFromLegacyBundle()
  const { events, scope, git } = fixture({ addWorktree: () => ({ ok: false, error: 'missing baseline' }) })
  install(scope, git)
  scope.uiWorkspace.startSession('main')
  await nextTurn()
  assert.deepEqual(events, [['add', 'C:/repo'], ['navigate', 'main']])
  assert.match(warnings[0]?.[0] ?? '', /worktree creation failed/)
})

test('concurrent new-session actions route once, and dispose restores official navigation', async () => {
  const { install } = await installFromLegacyBundle()
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
  const { install, warnings } = await installFromLegacyBundle()
  const { scope, git } = fixture()
  delete scope.uiWorkspace
  const before = scope.workspaces.create
  const dispose = install(scope, git)
  assert.equal(scope.workspaces.create, before)
  assert.match(warnings[0]?.[0] ?? '', /disabled: workspace data or navigation service shape changed/)
  dispose()
})

test('implicit target follows rc.3 most-recent workspace selection', async () => {
  const { install } = await installFromLegacyBundle()
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
  const { install, warnings } = await installFromLegacyBundle(true)
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
  await writeFile(path.join(bundleDir, 'lib', 'client.js'), await readFile(legacyFixture))
  const aggregateDir = path.join(ownTemp, 'node_modules', '@linxin666', 'dsh-web-all')
  await mkdir(path.join(aggregateDir, 'lib'), { recursive: true })
  await writeFile(path.join(aggregateDir, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-web-all', version: '0.3.23' }))
  await writeFile(path.join(aggregateDir, 'lib', 'client.js'),
    (await readFile(legacyFixture, 'utf8')).replace(begin,
      '\t\t//#region ../dsh-git-graph/src/client/auto-isolation.ts'))
  await patchGitGraphProfile(ownTemp)
  const first = await readFile(path.join(bundleDir, 'lib', 'client.js'), 'utf8')
  assert.match(first, /const uiWorkspace = probeUiWorkspace\(scope\.uiWorkspace\)/)
  assert.match(await readFile(path.join(aggregateDir, 'lib', 'client.js'), 'utf8'), /const uiWorkspace = probeUiWorkspace\(scope\.uiWorkspace\)/)
  assert.equal((await patchGitGraphProfile(ownTemp)).changed, false)
  assert.equal(await readFile(path.join(bundleDir, 'lib', 'client.js'), 'utf8'), first)
  await writeFile(path.join(bundleDir, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-client-ui-git-graph', version: '0.3.24' }))
  await assert.rejects(patchGitGraphProfile(ownTemp), /Unsupported Git Graph package/)
})

test('installed native Git Graph routes new sessions through uiWorkspace without patching any bundle', async (t) => {
  const { patchGitGraphProfile } = await import('../scripts/patch-git-graph.mjs')
  const ownTemp = await mkdtemp(path.join(os.tmpdir(), 'dsh-gitgraph-native-'))
  t.after(async () => {
    assert.equal(path.dirname(ownTemp), os.tmpdir())
    await rm(ownTemp, { recursive: true, force: true })
  })
  const sources = [
    ['dsh-client-ui-git-graph', vendor],
    ['dsh-web-all', aggregateVendor],
  ]
  const nativeBundles = thinAggregate ? [vendor] : [vendor, aggregateVendor]
  const copied = []
  for (const [name, source] of sources) {
    const packageDir = path.join(ownTemp, 'node_modules', '@linxin666', name)
    await mkdir(path.join(packageDir, 'lib'), { recursive: true })
    assert.equal(JSON.parse(await readFile(path.join(path.dirname(source), '..', 'package.json'), 'utf8')).version,
      installedFamily, `${name} fixture must use the real installed family source`)
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@linxin666/' + name, version: installedFamily }))
    const target = path.join(packageDir, 'lib', 'client.js')
    const bytes = await readFile(source)
    await writeFile(target, bytes)
    copied.push({ target, bytes })
  }
  const first = await patchGitGraphProfile(ownTemp)
  assert.equal(first.changed, false)
  assert.equal(first.version, installedFamily)
  for (const { target, bytes } of copied) assert.deepEqual(await readFile(target), bytes)
  assert.equal((await patchGitGraphProfile(ownTemp)).changed, false)

  for (const source of nativeBundles) {
    const { install, warnings } = await installFromNativeBundle(source)
    const { events, scope, git } = fixture()
    scope.sessions.list.getSnapshot = () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } })
    const dispose = install(scope, git)
    scope.uiWorkspace.startSession('main')
    await nextTurn()
    assert.deepEqual(events, [['add', 'C:/repo'], ['register', 'C:/managed/new'], ['navigate', 'new']])
    assert.equal(warnings.length, 0)
    dispose()
  }

  // The last validated bundle: the aggregate copy, or Git Graph itself once the aggregate is thin.
  const malformed = copied[nativeBundles.length - 1]
  await writeFile(malformed.target, String(malformed.bytes).replace('navigation.startSession = routed;', 'registry.startSession = routed;'))
  await assert.rejects(patchGitGraphProfile(ownTemp), /native isolation shape changed/)
  for (const { target, bytes } of copied) {
    if (target !== malformed.target) assert.deepEqual(await readFile(target), bytes, 'validation fails before writing any bundle')
  }
  await writeFile(malformed.target, malformed.bytes)
  await writeFile(path.join(path.dirname(malformed.target), '..', 'package.json'),
    JSON.stringify({ name: '@linxin666/dsh-web-all', version: '0.4.6' }))
  await assert.rejects(patchGitGraphProfile(ownTemp), /Unsupported Git Graph package/)
})
