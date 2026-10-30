import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'

import {
  patchSshDesktopLinks,
  patchSshDesktopLinksProfile,
  patchWebAllDesktopLinks,
  patchWebAllDesktopLinksProfile,
} from '../scripts/patch-web-all-desktop-links.mjs'

const family = path.resolve(import.meta.dirname, '../runtime/profile-web/node_modules')

const original = `function l(e, t) {
  if (confirm(\`Do you want to navigate to \u0024{t}?\\n\\nWARNING: This link could potentially be dangerous\`)) {
    const e = window.open();
    if (e) {
      try { e.opener = null; } catch {}
      e.location.href = t;
    } else console.warn("Opening link blocked as opener could not be cleared");
  }
}`

test('OSC 8 links pass their destination to the desktop external-link handler', () => {
  const patched = patchWebAllDesktopLinks(original)
  assert.match(patched, /window\.open\(t, "_blank", "noopener,noreferrer"\);/)
  assert.doesNotMatch(patched, /window\.open\(\)/)
  assert.equal(patchWebAllDesktopLinks(patched), patched)

  const opened = []
  const handler = vm.runInNewContext(`${patched}\nl`, {
    confirm: () => true,
    window: { open: (...args) => opened.push(args) },
  })
  handler({}, 'https://example.test/path')
  assert.deepEqual(opened, [['https://example.test/path', '_blank', 'noopener,noreferrer']])
})

test('OSC 8 link confirmation still blocks when the user declines', () => {
  const patched = patchWebAllDesktopLinks(original)
  let opened = false
  const handler = vm.runInNewContext(`${patched}\nl`, {
    confirm: () => false,
    window: { open: () => { opened = true } },
  })
  handler({}, 'https://example.test/')
  assert.equal(opened, false)
})

test('standalone SSH OSC 8 links use the desktop external-link handler', () => {
  const patched = patchSshDesktopLinks(original)
  assert.match(patched, /window\.open\(t, "_blank", "noopener,noreferrer"\);/)
  assert.doesNotMatch(patched, /window\.open\(\)/)
  assert.equal(patchSshDesktopLinks(patched), patched)
})

test('installed published terminal bundles retain the audited OSC 8 shape', async () => {
  const installed = JSON.parse(await readFile(path.join(family, '@linxin666/dsh-web-all/package.json'), 'utf8')).version
  // From 0.4.11 the aggregate is a thin loader and dsh-ssh carries the only terminal.
  const thin = ['0.4.11', '0.4.12'].includes(installed)
  const packages = [
    ...(thin ? [] : [['dsh-web-all', path.join(family, '@linxin666/dsh-web-all'), patchWebAllDesktopLinks]]),
    ['dsh-ssh', path.join(family, '@linxin666/dsh-ssh'), patchSshDesktopLinks],
  ]
  if (thin) {
    const aggregate = await readFile(path.join(family, '@linxin666/dsh-web-all/lib/client.js'), 'utf8')
    assert.ok(!aggregate.includes('Do you want to navigate to ${t}?'), 'thin aggregate must not embed a terminal')
  }
  for (const [name, directory, patch] of packages) {
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(metadata.name, `@linxin666/${name}`)
    assert.equal(metadata.version, installed)
    const source = await readFile(path.join(directory, 'lib/client.js'), 'utf8')
    const patched = patch(source)
    assert.notEqual(patched, source)
    assert.match(patched, /window\.open\(t, "_blank", "noopener,noreferrer"\);/)
    assert.equal(patch(patched), patched)
  }
})

test('staged desktop adapter validates the pinned bundle and is idempotent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-all-desktop-links-'))
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir())
    await rm(root, { recursive: true, force: true })
  })
  const packageDir = path.join(root, 'node_modules', '@linxin666', 'dsh-web-all')
  const sshPackageDir = path.join(root, 'node_modules', '@linxin666', 'dsh-ssh')
  await mkdir(path.join(packageDir, 'lib'), { recursive: true })
  await mkdir(path.join(sshPackageDir, 'lib'), { recursive: true })
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-web-all', version: '0.4.7' }))
  await writeFile(path.join(packageDir, 'lib', 'client.js'), original)
  await writeFile(path.join(sshPackageDir, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-ssh', version: '0.4.7' }))
  await writeFile(path.join(sshPackageDir, 'lib', 'client.js'), original)

  assert.equal((await patchWebAllDesktopLinksProfile(root)).changed, true)
  const patched = await readFile(path.join(packageDir, 'lib', 'client.js'), 'utf8')
  assert.match(patched, /window\.open\(t, "_blank", "noopener,noreferrer"\);/)
  assert.equal((await patchWebAllDesktopLinksProfile(root)).changed, false)
  assert.equal(await readFile(path.join(packageDir, 'lib', 'client.js'), 'utf8'), patched)

  assert.equal((await patchSshDesktopLinksProfile(root)).changed, true)
  const patchedSsh = await readFile(path.join(sshPackageDir, 'lib', 'client.js'), 'utf8')
  assert.match(patchedSsh, /window\.open\(t, "_blank", "noopener,noreferrer"\);/)
  assert.equal((await patchSshDesktopLinksProfile(root)).changed, false)
  assert.equal(await readFile(path.join(sshPackageDir, 'lib', 'client.js'), 'utf8'), patchedSsh)
})

test('adapter fails closed when upstream changes the audited handler shape', () => {
  assert.throws(() => patchWebAllDesktopLinks('unrelated client bundle'), /confirmation anchor missing/)
  assert.throws(() => patchWebAllDesktopLinks(original + '\n' + original), /ambiguous/)
  assert.throws(() => patchSshDesktopLinks('unrelated client bundle'), /confirmation anchor missing/)
  assert.throws(() => patchSshDesktopLinks(original + '\n' + original), /ambiguous/)
})

test('0.4.11 thin aggregate skips the terminal adapter but refuses an embedded terminal', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-all-thin-links-'))
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir())
    await rm(root, { recursive: true, force: true })
  })
  const packageDir = path.join(root, 'node_modules', '@linxin666', 'dsh-web-all')
  await mkdir(path.join(packageDir, 'lib'), { recursive: true })
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@linxin666/dsh-web-all', version: '0.4.11' }))
  await writeFile(path.join(packageDir, 'lib', 'client.js'), 'window.__ModuleLoader__.load({})')
  const result = await patchWebAllDesktopLinksProfile(root)
  assert.equal(result.skipped, true)
  assert.equal(result.changed, false)
  await writeFile(path.join(packageDir, 'lib', 'client.js'), original)
  await assert.rejects(patchWebAllDesktopLinksProfile(root), /embeds xterm links again/)
  assert.equal(await readFile(path.join(packageDir, 'lib', 'client.js'), 'utf8'), original)
})
