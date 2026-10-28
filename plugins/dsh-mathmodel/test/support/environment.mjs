import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { resolveDshHome, resolveProfileName } = require('../../../../src/runtime.cjs');

function overridePath(value, home) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(home, trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function resolveEnvironmentPaths(env = process.env, home = homedir()) {
  const dshHome = resolveDshHome(env, home);
  const skillRoot = overridePath(env.DSH_SKILL_ROOT, home) ?? resolve(dshHome, 'skills');
  const profileRoot = overridePath(env.DSH_TEST_PROFILE_ROOT, home)
    ?? resolve(dshHome, 'profiles', resolveProfileName(env));
  return { dshHome, skillRoot, profileRoot };
}

export const { dshHome, skillRoot, profileRoot } = resolveEnvironmentPaths();
