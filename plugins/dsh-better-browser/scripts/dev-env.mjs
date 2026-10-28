#!/usr/bin/env node
/**
 * Prepare the local dev environment for @dsh-external/dsh-better-browser.
 *
 * The DSH official packages (`@deepseek-ai/dsh-*` and the rescoped Cordis
 * packages) are not published to the public npm registry, so this plugin
 * cannot `pnpm install` them. Dev and test tooling instead resolves against a
 * DSH source checkout:
 *
 * 1. `node_modules` gets symlinks for the toolchain (vitest,
 *    vite-tsconfig-paths, typescript, @types/node, .bin entries) taken from
 *    the checkout's own node_modules.
 * 2. `.dsh/tsconfig.paths.json` is generated from the checkout's
 *    `tsconfig.base.json` paths map (absolute-ized), so tsc resolves every
 *    `@deepseek-ai/*` import to the checkout's `src` (source
 *    plane, never stale `lib/`).
 * 3. `.dsh/alias.json` maps every concrete package name to its source entry
 *    for vite/vitest `resolve.alias`.
 *
 * The checkout is resolved from `DSH_CHECKOUT` first, then the
 * `.dsh/source/current` symlink (created by `pnpm link:dsh -- <path>`).
 * Idempotent; safe to run before every `pnpm test` / `pnpm typecheck`.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Resolve the DSH source checkout, or exit with a clear error. */
function resolveCheckout() {
  const candidates = []
  if (process.env.DSH_CHECKOUT !== undefined && process.env.DSH_CHECKOUT !== '') {
    candidates.push(resolve(process.env.DSH_CHECKOUT))
  }
  const link = join(root, '.dsh', 'source', 'current')
  if (existsSync(link)) {
    try {
      candidates.push(resolve(dirname(link), readlinkSync(link)))
    } catch {
      // broken symlink; fall through to the error path
    }
  }
  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, 'AGENTS.md'))
      && existsSync(join(candidate, 'vendor', 'cordis', 'src'))
    ) {
      return candidate
    }
  }
  throw new Error(
    'Cannot find a DSH source checkout. Set DSH_CHECKOUT=/path/to/dsh '
    + '(the deepseek-harness source checkout) or run `pnpm link:dsh -- /path/to/dsh` first.',
  )
}

/** Link one entry into the plugin node_modules (directory or file symlink). */
function linkOne(source, dest) {
  if (existsSync(dest)) return
  mkdirSync(dirname(dest), { recursive: true })
  const isDir = lstatSync(source).isDirectory()
  symlinkSync(source, dest, isDir ? 'dir' : 'file')
}

/** Link the toolchain from the checkout into this repo's node_modules. */
function linkToolchain(checkout) {
  const nodeModules = join(root, 'node_modules')
  rmSync(nodeModules, { recursive: true, force: true })
  mkdirSync(nodeModules, { recursive: true })
  const checkoutModules = join(checkout, 'node_modules')
  for (const name of ['vitest', 'vite-tsconfig-paths', 'typescript', '@types/node', 'oxlint']) {
    const source = join(checkoutModules, name)
    if (!existsSync(source)) throw new Error(`dev-env: ${name} not found in the DSH checkout's node_modules`)
    linkOne(source, join(nodeModules, name))
  }
  const bin = join(nodeModules, '.bin')
  mkdirSync(bin, { recursive: true })
  for (const name of ['vitest', 'tsc', 'tsdown', 'oxlint']) {
    const source = join(checkoutModules, '.bin', name)
    if (existsSync(source)) {
      // Symlink the checkout's .bin entry so the resolved real file (inside
      // the pnpm store) keeps its own relative imports intact.
      linkOne(source, join(bin, name))
    }
  }
}

/** Strip JSONC line comments (the checkout tsconfigs carry `//` lines). */
function parseJsonc(text) {
  const lines = text.split('\n').filter(line => !line.trimStart().startsWith('//'))
  return JSON.parse(lines.join('\n'))
}

/** Resolve the source entry of one DSH package directory. */
function sourceEntry(dir) {
  for (const candidate of ['src/index.ts', 'src', 'index.ts']) {
    const full = join(dir, candidate)
    if (existsSync(full)) return full
  }
  return null
}

/** Read the `name` of a package.json, or null when absent/invalid. */
function packageNameOf(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).name
  } catch {
    return null
  }
}

/**
 * Build the flat name → source-entry alias map: every concrete package in the
 * checkout's two-level packages tree and vendor tree maps to its source
 * entry, and
 * non-wildcard subpath keys from the checkout's paths map are kept verbatim.
 * Wildcard keys are not expanded from targets (their targets are all `*`
 * patterns); the tree scan covers the concrete names.
 */
function buildAliasMap(checkout) {
  const base = parseJsonc(readFileSync(join(checkout, 'tsconfig.base.json'), 'utf8'))
  const paths = base.compilerOptions.paths
  const aliases = {}
  for (const group of readdirSync(join(checkout, 'packages'))) {
    const groupDir = join(checkout, 'packages', group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const pkg of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, pkg)
      if (!statSync(pkgDir).isDirectory()) continue
      const name = packageNameOf(join(pkgDir, 'package.json'))
      if (name === null || !name.startsWith('@deepseek-ai/')) continue
      const entry = sourceEntry(pkgDir)
      if (entry !== null) aliases[name] = entry
    }
  }
  for (const name of readdirSync(join(checkout, 'vendor'))) {
    const vendorDir = join(checkout, 'vendor', name)
    if (!statSync(vendorDir).isDirectory()) continue
    const entry = sourceEntry(vendorDir)
    if (entry !== null) aliases[name] = entry
    // Scoped vendor packages (@cordisjs/plugin-*) live one level deeper.
    if (name.startsWith('@')) {
      for (const sub of readdirSync(vendorDir)) {
        const subDir = join(vendorDir, sub)
        if (!statSync(subDir).isDirectory()) continue
        const entry = sourceEntry(subDir)
        if (entry !== null) aliases[`${name}/${sub}`] = entry
      }
    }
  }
  for (const [key, targets] of Object.entries(paths)) {
    if (key.includes('*')) continue
    if (key in aliases) continue
    for (const target of targets) {
      if (target.includes('*')) continue
      const full = resolve(checkout, target)
      const entry = target.endsWith('.ts') ? full : sourceEntry(full) ?? full
      if (!(key in aliases)) aliases[key] = entry
    }
  }
  return aliases
}

/**
 * Map one checkout-relative path target to its built declaration entry
 * (`lib/types`), falling back to source when the artifact is missing.
 * `./X/src` → `./X/lib/types/index.d.ts`; `./X/src/foo.ts` → `./X/lib/types/foo.d.ts`.
 */
function builtEntry(checkout, target) {
  let built
  if (target.endsWith('/src')) {
    built = `${target}/index.d.ts`.replace('/src/index.d.ts', '/lib/types/index.d.ts')
  } else {
    built = target.replace('/src/', '/lib/types/').replace(/\.ts$/, '.d.ts')
  }
  if (built === target) return resolve(checkout, target)
  // Wildcard targets cannot be existence-checked; they resolve per concrete
  // package at substitution time. Directory targets fall back to index lookup.
  if (target.includes('*')) return resolve(checkout, built)
  if (existsSync(resolve(checkout, built))) return resolve(checkout, built)
  return resolve(checkout, target)
}

/**
 * Generate .dsh/tsconfig.paths.json from the checkout's paths map. Targets
 * resolve to the checkout's BUILT declarations (lib/types) so tsc checks
 * this plugin against the published package surface — exactly what the
 * plugin consumes at runtime — while vendor sources stay out of this
 * program (they compile under their own relaxed options in the checkout).
 */
function writeTsconfigPaths(checkout) {
  const base = parseJsonc(readFileSync(join(checkout, 'tsconfig.base.json'), 'utf8'))
  const source = base.compilerOptions.paths
  const paths = {}
  for (const [key, targets] of Object.entries(source)) {
    paths[key] = targets.map(target => builtEntry(checkout, target))
  }
  const output = join(root, '.dsh', 'tsconfig.paths.json')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify({ compilerOptions: { paths } }, null, 2)}\n`)
  return output
}

/** Generate .dsh/alias.json (flat name → source entry) for vite/vitest. */
function writeAliasMap(checkout) {
  const aliases = buildAliasMap(checkout)
  const output = join(root, '.dsh', 'alias.json')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(aliases, null, 2)}\n`)
  return output
}

const checkout = resolveCheckout()
linkToolchain(checkout)
const tsconfigOutput = writeTsconfigPaths(checkout)
const aliasOutput = writeAliasMap(checkout)
console.log(`dev-env: toolchain linked from ${checkout}`)
console.log(`dev-env: wrote ${relative(root, tsconfigOutput)} and ${relative(root, aliasOutput)}`)
