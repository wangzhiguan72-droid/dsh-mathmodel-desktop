#!/usr/bin/env node
/**
 * Point this repo's dev environment at a DSH source checkout.
 *
 * Usage: `pnpm link:dsh -- /absolute/path/to/dsh` (or `pnpm link:dsh /path`).
 * Creates the `.dsh/source/current` symlink that `scripts/dev-env.mjs`
 * resolves when `DSH_CHECKOUT` is unset. Idempotent.
 */
import { lstat, mkdir, readlink, symlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

let source = process.argv[2]
if (source === '--') source = process.argv[3]
if (source === undefined || !isAbsolute(source)) {
  throw new Error('usage: pnpm link:dsh -- /absolute/path/to/dsh')
}
const root = resolve(import.meta.dirname, '..')
for (const required of ['AGENTS.md', 'packages/core/tools', 'vendor/cordis']) {
  await lstat(resolve(source, required))
}
const link = resolve(root, '.dsh/source/current')
await mkdir(resolve(root, '.dsh/source'), { recursive: true })
try {
  const current = await readlink(link)
  if (resolve(resolve(link, '..'), current) !== resolve(source)) {
    throw new Error(`existing DSH link points to ${current}; remove .dsh/source/current to relink`)
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  await symlink(resolve(source), link, 'dir')
}
console.log(`${link} -> ${resolve(source)}`)
