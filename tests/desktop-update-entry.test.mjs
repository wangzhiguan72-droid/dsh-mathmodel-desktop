import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { patchDesktopClientSource, patchDesktopServerSource, patchDesktopUpdateProfile } from '../scripts/patch-desktop-update-entry.mjs'

const root = path.resolve(import.meta.dirname, '..')
const scope = '@linxin666'
const runtime = path.join(root, 'runtime/profile-web/node_modules', scope)
const bundle = path.join(root, 'resources/runtime/profile-web/node_modules', scope, 'dsh-web-all/lib/client.js')
const clientNames = ['dsh-web-all', 'dsh-remote-web-ui']

function region(source, start, end) {
  const first = source.indexOf(start)
  assert.notEqual(first, -1, `missing real vendor region ${start}`)
  const last = source.indexOf(end, first)
  assert.ok(last > first)
  return source.slice(first, last)
}

function renderClient(source, desktopUpdates) {
  const code = region(source, 'function DesktopUpdateEntry({ wide }) {', '\t\t//#endregion')
  const slots = []
  const effects = []
  let cursor = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], next => { slots[index] = next }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useCallback(value) { return value },
    useEffect(effect) { effects.push(effect) },
  }
  const calls = []
  const context = {
    react, window: desktopUpdates === undefined ? {} : { desktopUpdates },
    react_jsx_runtime: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    remote_module_css_default: { trigger: 'trigger', updateBadgeText: 'text' },
    _deepseek_ai_dsh_client_ui_primitives: { IconDownloadOutline16: 'icon' },
    react_dom: { createPortal() { throw Error('legacy modal unexpectedly opened') } },
    fetchUpdateStatus: async () => { calls.push('legacy-fetch'); return { mode: 'npm', outdated: true } },
    setTimeout, console,
  }
  const components = vm.runInNewContext(`${code}\n({ DesktopUpdateEntry, UpdateEntry })`, context)
  return {
    calls, slots, effects,
    render(wide = true) {
      cursor = 0
      const element = components.UpdateEntry({ wide, t: key => key })
      return typeof element.type === 'function' ? element.type(element.props) : element
    },
    async flush() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() },
  }
}

test('both real pinned vendor clients use the desktop bridge and never probe pnpm in desktop mode', async () => {
  for (const name of clientNames) {
    const file = name === 'dsh-web-all' ? bundle : path.join(runtime, name, 'lib/client.js')
    const original = await readFile(file, 'utf8')
    const patched = patchDesktopClientSource(original)
    assert.equal(patchDesktopClientSource(patched), patched)
    const calls = []
    let listener
    let unsubscribed = false
    const bridge = {
      async getState() { calls.push('state'); return { phase: 'available', currentVersion: '0.1.1', availableVersion: '0.1.2' } },
      onState(callback) { calls.push('subscribe'); listener = callback; return () => { unsubscribed = true } },
      async open() { calls.push('open') },
    }
    const view = renderClient(patched, bridge)
    let seat = view.render()
    assert.equal(seat.type, 'button')
    const cleanup = view.effects[0]()
    await view.flush()
    seat = view.render()
    assert.equal(seat.props['data-desktop-update-entry'], 'true')
    assert.equal(seat.props['data-update-available'], 'true')
    assert.match(seat.props['aria-label'], /0\.1\.2/)
    assert.deepEqual(view.calls, [])
    seat.props.onClick()
    await view.flush()
    assert.deepEqual(calls, ['subscribe', 'state', 'open'])
    listener({ phase: 'downloading', currentVersion: '0.1.1' })
    seat = view.render()
    assert.equal(seat.props.disabled, true)
    assert.equal(seat.props['data-update-available'], undefined)
    // React calls each effect cleanup when this seat unmounts.
    cleanup()
    assert.equal(unsubscribed, true)
  }
})

test('regular browser keeps the vendor update implementation and availability probe', async () => {
  const patched = patchDesktopClientSource(await readFile(bundle, 'utf8'))
  const view = renderClient(patched)
  const seat = view.render()
  assert.equal(seat.props.children[0].type, 'button')
  for (const effect of view.effects) effect()
  await view.flush()
  assert.deepEqual(view.calls, ['legacy-fetch'])
})

test('server desktop fence blocks legacy check/run but retains method and request fence', async () => {
  const original = await readFile(path.join(runtime, 'dsh-remote-web-ui/lib/index.js'), 'utf8')
  const patched = patchDesktopServerSource(original)
  assert.equal(patchDesktopServerSource(patched), patched)
  const code = region(patched, 'function makeUpdateRoutes(deps) {', '//#endregion')
  const env = { DSH_DESKTOP_MANAGED_UPDATES: '1' }
  const context = {
    process: { env }, UPDATE_PATHS: { status: '/status', run: '/run' },
    writeJson(res, status, body) { res.status = status; res.body = body },
  }
  const makeRoutes = vm.runInNewContext(`${code}\nmakeUpdateRoutes`, context)
  const calls = []
  const deps = {
    fence: req => req.allowed,
    check: async () => { calls.push('check'); return { mode: 'npm', outdated: true } },
    run: async () => { calls.push('run'); return { ok: true } },
  }
  const routes = makeRoutes(deps)
  async function request(index, method, allowed = true) {
    const res = { writeHead(status) { this.status = status }, end() {} }
    await routes[index].handler({ method, allowed }, res)
    return res
  }
  assert.equal((await request(0, 'POST')).status, 405)
  assert.equal((await request(1, 'GET')).status, 405)
  assert.equal((await request(0, 'GET', false)).status, 403)
  assert.equal((await request(1, 'POST', false)).status, 403)
  const status = await request(0, 'GET')
  assert.equal(status.status, 200)
  assert.equal(status.body.mode, 'desktop')
  assert.equal(status.body.outdated, false)
  const run = await request(1, 'POST')
  assert.equal(run.status, 409)
  assert.equal(run.body.errorCode, 'desktop-managed')
  assert.deepEqual(calls, [])
  delete env.DSH_DESKTOP_MANAGED_UPDATES
  assert.equal((await request(0, 'GET')).body.mode, 'npm')
  assert.equal((await request(1, 'POST')).body.ok, true)
  assert.deepEqual(calls, ['check', 'run'])
})

test('profile validation is atomic across both clients and server; successful patch is idempotent', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'desktop-update-entry-'))
  try {
    const webDir = path.join(temp, 'node_modules', scope, 'dsh-web-all')
    const remoteDir = path.join(temp, 'node_modules', scope, 'dsh-remote-web-ui')
    await mkdir(path.join(webDir, 'lib'), { recursive: true })
    await mkdir(path.join(remoteDir, 'lib'), { recursive: true })
    const webSource = '\t\tfunction UpdateEntry({ wide, t }) { return 1 }'
    const remoteSource = '\t\tfunction UpdateEntry({ wide, t }) { return 2 }'
    const serverSource = '\t\twriteJson(res, 200, await deps.check());\n\t\twriteJson(res, 200, await deps.run());'
    await writeFile(path.join(webDir, 'package.json'), JSON.stringify({ name: `${scope}/dsh-web-all`, version: '0.3.23' }))
    await writeFile(path.join(remoteDir, 'package.json'), JSON.stringify({ name: `${scope}/dsh-remote-web-ui`, version: '0.3.23' }))
    await writeFile(path.join(webDir, 'lib/client.js'), webSource)
    await writeFile(path.join(remoteDir, 'lib/client.js'), remoteSource)
    await writeFile(path.join(remoteDir, 'lib/index.js'), 'missing anchors')
    await assert.rejects(patchDesktopUpdateProfile(temp), /anchor missing/)
    assert.equal(await readFile(path.join(webDir, 'lib/client.js'), 'utf8'), webSource)
    assert.equal(await readFile(path.join(remoteDir, 'lib/client.js'), 'utf8'), remoteSource)
    await writeFile(path.join(remoteDir, 'lib/index.js'), serverSource)
    assert.equal((await patchDesktopUpdateProfile(temp)).changed, true)
    assert.equal((await patchDesktopUpdateProfile(temp)).changed, false)
    assert.match(await readFile(path.join(remoteDir, 'lib/index.js'), 'utf8'), /desktop-managed/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
