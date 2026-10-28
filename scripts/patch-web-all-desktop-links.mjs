// Adapt xterm OSC 8 handlers in dsh-web-all and standalone dsh-ssh to
// Electron's external-link policy. The upstream handler opened an empty popup
// and navigated it later; Electron cannot see that destination in
// setWindowOpenHandler and correctly denies the popup. Passing the URL up front
// lets the desktop shell hand it to the system browser without another window.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageName = '@linxin666/dsh-web-all'
const supportedVersions = ['0.4.5', '0.4.7', '0.4.11']
const sshPackageName = '@linxin666/dsh-ssh'
const destinationOpen = 'window.open(t, "_blank", "noopener,noreferrer");'
const legacyOpen = /const e = window\.open\(\);\s*if \(e\) \{\s*try \{\s*e\.opener = null;\s*\} catch \{\}\s*e\.location\.href = t;\s*\} else console\.warn\("Opening link blocked as opener could not be cleared"\);/g
const confirmation = 'Do you want to navigate to ${t}?'

function requireOnce(source, pattern, label) {
  const matches = source.match(pattern) ?? []
  if (matches.length !== 1) throw new Error(`dsh-web-all ${label} missing or ambiguous`)
}

/** Replace the xterm OSC 8 popup flow, or validate an already-patched bundle. */
function patchOsc8DesktopLinks(source, label) {
  if (!source.includes(confirmation)) throw new Error(`${label} xterm link confirmation anchor missing`)
  requireOnce(source, /Do you want to navigate to \$\{t\}\?/g, `${label} xterm link confirmation`)
  const legacy = source.match(legacyOpen) ?? []
  if (legacy.length === 1) return source.replace(legacyOpen, destinationOpen)
  if (legacy.length > 1) throw new Error(`${label} xterm empty-popup handler is ambiguous`)
  requireOnce(source, /window\.open\(t, "_blank", "noopener,noreferrer"\);/g, `${label} desktop xterm link handler`)
  return source
}

export function patchWebAllDesktopLinks(source) {
  return patchOsc8DesktopLinks(source, 'dsh-web-all')
}

export function patchSshDesktopLinks(source) {
  return patchOsc8DesktopLinks(source, 'dsh-ssh')
}

async function patchDesktopLinksPackage(profileDir, { name, version, bundlePath, patch, skipVersions = [] }) {
  const packageDir = path.join(profileDir, 'node_modules', ...name.split('/'))
  const meta = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
  if (meta.name !== name || !version.includes(meta.version)) {
    throw new Error(`Unsupported ${name} desktop link adapter target: ${meta.name}@${meta.version}`)
  }
  const bundle = path.join(packageDir, ...bundlePath.split('/'))
  if (skipVersions.includes(meta.version)) {
    // Fail if the thin aggregate grows a terminal copy again without this adapter.
    if ((await readFile(bundle, 'utf8')).includes(confirmation)) throw new Error(name + '@' + meta.version + ' embeds xterm links again; extend the adapter')
    return { name, changed: false, version: meta.version, bundle, skipped: true }
  }
  const before = await readFile(bundle, 'utf8')
  const after = patch(before)
  if (after !== before) await writeFile(bundle, after)
  return { name, changed: after !== before, version: meta.version, bundle }
}

// From 0.4.11 the aggregate no longer embeds the terminal; dsh-ssh carries the only copy.
const thinAggregateVersions = ['0.4.11']

export function patchWebAllDesktopLinksProfile(profileDir) {
  return patchDesktopLinksPackage(profileDir, {
    skipVersions: thinAggregateVersions,
    name: packageName,
    version: supportedVersions,
    bundlePath: 'lib/client.js',
    patch: patchWebAllDesktopLinks,
  })
}

export function patchSshDesktopLinksProfile(profileDir) {
  return patchDesktopLinksPackage(profileDir, {
    name: sshPackageName,
    version: supportedVersions,
    bundlePath: 'lib/client.js',
    patch: patchSshDesktopLinks,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileDir = process.argv[2]
  if (!profileDir) throw new Error('Usage: node scripts/patch-web-all-desktop-links.mjs <staged-profile-directory>')
  const resolvedProfileDir = path.resolve(profileDir)
  for (const result of await Promise.all([
    patchWebAllDesktopLinksProfile(resolvedProfileDir),
    patchSshDesktopLinksProfile(resolvedProfileDir),
  ])) {
    console.log(`${result.name} ${result.version} desktop links ${result.changed ? 'patched' : 'validated'}: ${result.bundle}`)
  }
}
