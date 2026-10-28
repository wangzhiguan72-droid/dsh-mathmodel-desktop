import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveEnvironmentPaths } from './support/environment.mjs';

const home = resolve('fixture-home');

test('环境路径默认使用数学建模桌面版专属 home 和 profile', () => {
  assert.deepEqual(resolveEnvironmentPaths({}, home), {
    dshHome: resolve(home, '.dsh-mathmodel'),
    skillRoot: resolve(home, '.dsh-mathmodel', 'skills'),
    profileRoot: resolve(home, '.dsh-mathmodel', 'profiles', 'mathmodel'),
  });
});

test('DSH_HOME 支持波浪号、空白回退和 profile 名称覆盖', () => {
  assert.deepEqual(resolveEnvironmentPaths({ DSH_HOME: '~/custom-dsh', DSH_PROFILE: ' research ' }, home), {
    dshHome: resolve(home, 'custom-dsh'),
    skillRoot: resolve(home, 'custom-dsh', 'skills'),
    profileRoot: resolve(home, 'custom-dsh', 'profiles', 'research'),
  });
  assert.deepEqual(resolveEnvironmentPaths({ DSH_HOME: '  ', DSH_PROFILE: '  ' }, home),
    resolveEnvironmentPaths({}, home));
});

test('显式 skills 和 profile 根目录分别覆盖默认路径', () => {
  const paths = resolveEnvironmentPaths({
    DSH_SKILL_ROOT: '~/shared-skills',
    DSH_TEST_PROFILE_ROOT: '~/test-profile',
  }, home);
  assert.equal(paths.skillRoot, resolve(home, 'shared-skills'));
  assert.equal(paths.profileRoot, resolve(home, 'test-profile'));
  assert.equal(paths.dshHome, resolve(home, '.dsh-mathmodel'));
});
