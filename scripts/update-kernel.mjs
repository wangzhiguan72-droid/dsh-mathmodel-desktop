#!/usr/bin/env node
'use strict';

/**
 * update-kernel — 数学建模桌面版的自动更新机制（借鉴 DSH-Desktop-EAC updater.js /
 * plugin-guard.js 与 dsh-vibe-pack 的事务性安装思路）。
 *
 * 策略：
 *  1. 工作期间始终使用当前锁定的稳定版运行时，脚本不运行就不会更新；
 *  2. 每次变更前自动快照（运行时载荷 + profile 清单 + 插件锁文件），失败逆序回滚；
 *  3. 内核更新后做启动验证（无头拉起宿主 + 探测 GUI），失败自动回滚到快照；
 *  4. 插件升级（--plugins）在锁定内核版本的前提下把 profile 的 npm 插件升到
 *     兼容的最新版，同样快照 + 验证 + 回滚；
 *  5. 变更后写 UPDATE-REMINDER.md，提醒做 dsh-mathmodel 版本门适配与预设回归。
 *
 * 用法：
 *   node scripts/update-kernel.mjs --check      只检查内核与插件的新版本
 *   node scripts/update-kernel.mjs --auto       全自动：内核 + 插件 + 验证 + 自动回滚
 *   node scripts/update-kernel.mjs              内核更新（备份 + 启动验证 + 自动回滚）
 *   node scripts/update-kernel.mjs --plugins    只升级 profile 插件
 *   node scripts/update-kernel.mjs --rollback   手动回滚到上一稳定快照
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSrc = path.join(desktopDir, 'runtime');
const stagingRoot = path.join(desktopDir, 'resources', 'runtime');
const hostPackage = path.join(runtimeSrc, 'host', 'package.json');
const profilePackage = path.join(runtimeSrc, 'profile-web', 'package.json');
const stableDir = path.join(stagingRoot, 'host-stable');
const snapshotDir = path.join(stagingRoot, 'update-snapshot');
const reminderFile = path.join(desktopDir, 'UPDATE-REMINDER.md');
/** The seeded profile the desktop app drives. */
const dshHome = path.join(os.homedir(), '.dsh-mathmodel');
const seededProfile = path.join(dshHome, 'profiles', 'mathmodel');

const mode = process.argv[2] ?? '';

/* ---------- helpers ---------- */

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pinnedVersion() {
  const manifest = readJson(hostPackage);
  const version = manifest.dependencies?.['@deepseek-ai/dsh'];
  if (version === undefined) throw new Error('runtime/host/package.json does not pin @deepseek-ai/dsh');
  return version;
}

function writePinnedVersion(version) {
  const manifest = readJson(hostPackage);
  manifest.dependencies['@deepseek-ai/dsh'] = version;
  fs.writeFileSync(hostPackage, JSON.stringify(manifest, null, 2) + '\n');
}

function npm(args) {
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('npm ' + args.join(' ') + ' failed: ' + String(result.stderr || result.stdout || '').slice(0, 300));
  return String(result.stdout).trim();
}

function pnpm(args, cwd) {
  const result = spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 8 * 1024 * 1024,
  });
  return result;
}

/** Snapshot everything an update can break, into one rolling directory. */
function takeSnapshot(label) {
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  fs.mkdirSync(snapshotDir, { recursive: true });
  const pieces = [
    [hostPackage, 'host-package.json'],
    [profilePackage, 'profile-package.json'],
    [path.join(runtimeSrc, 'profile-web', 'cordis.patch.yml'), 'profile-cordis.patch.yml'],
    [path.join(runtimeSrc, 'profile-web', 'pnpm-workspace.yaml'), 'profile-pnpm-workspace.yaml'],
  ];
  for (const [src, name] of pieces) {
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapshotDir, name));
  }
  // Plugin lockfile: the exact npm plugin set the profile resolves to.
  const lock = path.join(runtimeSrc, 'profile-web', 'pnpm-lock.yaml');
  if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(snapshotDir, 'pnpm-lock.yaml'));
  // Seeded profile manifests (the live copies inside $DSH_HOME).
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const src = path.join(seededProfile, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapshotDir, 'seeded-' + name));
  }
  fs.writeFileSync(path.join(snapshotDir, 'SNAPSHOT.json'), JSON.stringify({ label, at: new Date().toISOString(), kernel: pinnedVersion() }, null, 2) + '\n');
  console.log('[update-kernel] snapshot taken (' + label + ') -> resources/runtime/update-snapshot');
}

/** Restore the profile manifests and lockfile from the snapshot (runtime payload restore is rollback()'s job). */
function restoreSnapshotManifests() {
  const map = {
    'host-package.json': hostPackage,
    'profile-package.json': profilePackage,
    'profile-cordis.patch.yml': path.join(runtimeSrc, 'profile-web', 'cordis.patch.yml'),
    'profile-pnpm-workspace.yaml': path.join(runtimeSrc, 'profile-web', 'pnpm-workspace.yaml'),
    'pnpm-lock.yaml': path.join(runtimeSrc, 'profile-web', 'pnpm-lock.yaml'),
  };
  for (const [name, dest] of Object.entries(map)) {
    const src = path.join(snapshotDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
  }
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const src = path.join(snapshotDir, 'seeded-' + name);
    const dest = path.join(seededProfile, name);
    if (fs.existsSync(src) && fs.existsSync(path.dirname(dest))) fs.copyFileSync(src, dest);
  }
  console.log('[update-kernel] manifests restored from snapshot');
}

/** Headless boot verification: spawn the staged host on a free port and wait for its token URL. */
function bootVerify() {
  const nodeBin = path.join(stagingRoot, 'node-win-x64', 'node.exe');
  const hostBin = path.join(stagingRoot, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(nodeBin) || !fs.existsSync(hostBin)) throw new Error('staged runtime payload is incomplete');
  const env = { ...process.env, DSH_HOME: dshHome };
  env.PATH = path.join(stagingRoot, 'node-win-x64') + (env.PATH ? ';' + env.PATH : '');
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(nodeBin, [hostBin, '--profile', 'mathmodel', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: dshHome,
    env,
    encoding: 'utf8',
    timeout: 120000,
    input: '',
  });
  const output = String(result.stdout || '') + String(result.stderr || '');
  if (result.status === 0 || /dsh web: http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    console.log('[update-kernel] boot verification passed');
    return true;
  }
  console.log('[update-kernel] boot verification FAILED:\n' + output.slice(-600));
  return false;
}

/** One build cycle: pnpm install both payloads, stage, entrypoint assert. */
function runBuildRuntime() {
  const result = spawnSync(process.execPath, [path.join(desktopDir, 'scripts', 'build-runtime.mjs')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('build-runtime failed');
}

function writeReminder(title, lines) {
  const content = `# 更新待办（UPDATE REMINDER）\n\n- 时间：${new Date().toISOString()}\n- ${title}\n\n${lines.map((l) => '- ' + l).join('\n')}\n`;
  fs.writeFileSync(reminderFile, content);
  console.log('[update-kernel] reminder written -> ' + path.relative(desktopDir, reminderFile));
}

function mathmodelReminderSteps(next) {
  return [
    `把 \`${next}\` 加入 \`plugins/dsh-mathmodel/src/version.js\` 白名单并 \`npm test\``,
    '按 dsh-mathmodel README 回归：预设挂载、Skill 卡片、Skill 草稿、设置页',
    '`npm run prepare-runtime && npm run dist:win` 重新打包',
    '启动桌面端实测：新会话发消息 + 切换预设；异常则 `--rollback`',
  ];
}

/* ---------- flows ---------- */

/** 插件跟着内核适配：自动把新内核版本加入 dsh-mathmodel 版本门白名单并重建其 lib。 */
function adaptMathmodelGate(version) {
  const files = [
    path.join(desktopDir, 'plugins', 'dsh-mathmodel', 'src', 'version.js'),
    path.join(desktopDir, 'plugins', 'dsh-mathmodel', 'lib', 'version.js'),
  ];
  let touched = false;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, 'utf8');
    if (text.includes("'" + version + "'")) continue;
    const updated = text.replace(/SUPPORTED_DSH_VERSIONS = \[([^\]]+)\]/, (m, list) => 'SUPPORTED_DSH_VERSIONS = [' + list.trim() + ", '" + version + "']");
    if (updated !== text) { fs.writeFileSync(file, updated); touched = true; }
  }
  if (touched) {
    const build = spawnSync('npm', ['run', 'build'], { cwd: path.join(desktopDir, 'plugins', 'dsh-mathmodel'), encoding: 'utf8', shell: process.platform === 'win32' });
    console.log('[update-kernel] dsh-mathmodel version gate adapted to ' + version + (build.status === 0 ? ' (lib rebuilt)' : ' (lib rebuild FAILED)'));
  }
}

function backupStable() {
  if (!fs.existsSync(path.join(stagingRoot, 'host'))) {
    console.log('[update-kernel] no staged host payload yet, run scripts/build-runtime.mjs first');
    process.exit(1);
  }
  fs.rmSync(stableDir, { recursive: true, force: true });
  fs.cpSync(path.join(stagingRoot, 'host'), stableDir, { recursive: true, dereference: true });
  fs.writeFileSync(path.join(stableDir, 'STABLE-VERSION.txt'), pinnedVersion() + '\n');
  console.log('[update-kernel] stable backup: @deepseek-ai/dsh@' + pinnedVersion() + ' -> resources/runtime/host-stable');
}

function rollback() {
  if (!fs.existsSync(stableDir)) {
    console.log('[update-kernel] no stable backup at resources/runtime/host-stable');
    process.exit(1);
  }
  const stableVersion = fs.existsSync(path.join(stableDir, 'STABLE-VERSION.txt'))
    ? fs.readFileSync(path.join(stableDir, 'STABLE-VERSION.txt'), 'utf8').trim()
    : 'unknown';
  fs.rmSync(path.join(stagingRoot, 'host'), { recursive: true, force: true });
  fs.cpSync(stableDir, path.join(stagingRoot, 'host'), { recursive: true, dereference: true });
  writePinnedVersion(stableVersion);
  console.log('[update-kernel] rolled back to @deepseek-ai/dsh@' + stableVersion + '; restart the desktop app.');
}

/** Kernel update: backup -> pin -> build -> boot-verify -> auto-rollback on failure. */
function updateKernel(latest) {
  const current = pinnedVersion();
  console.log('[update-kernel] kernel: ' + current + ' -> ' + latest);
  backupStable();
  takeSnapshot('kernel ' + current + ' -> ' + latest);
  writePinnedVersion(latest);
  adaptMathmodelGate(latest);
  try {
    runBuildRuntime();
    if (!bootVerify()) throw new Error('boot verification failed for @deepseek-ai/dsh@' + latest);
  } catch (error) {
    console.log('[update-kernel] ' + (error.message || error) + ' — auto-rolling back');
    rollback();
    restoreSnapshotManifests();
    runBuildRuntime();
    writeReminder('内核更新失败已自动回滚', [
      `目标版本 \`${latest}\` 启动验证未通过，已回滚到 \`${current}\``,
      '失败原因见上方日志；不要手动放宽版本门，等上游修复后重试 `--auto`',
    ]);
    throw new Error('kernel update rolled back automatically');
  }
  writeReminder('内核已更新到 ' + latest + '，待适配确认', mathmodelReminderSteps(latest));
  console.log('[update-kernel] kernel updated to ' + latest + '; restart the desktop app after the UPDATE-REMINDER checklist.');
}

/** Plugin update: snapshot -> pnpm update in the profile payload -> boot-verify -> restore on failure. */
function updatePlugins() {
  const profileDir = path.join(runtimeSrc, 'profile-web');
  const current = pinnedVersion();
  console.log('[update-kernel] updating profile plugins (kernel stays @' + current + ')');
  takeSnapshot('plugins @ kernel ' + current);
  const result = pnpm(['update'], profileDir);
  if (result.status !== 0) {
    console.log('[update-kernel] pnpm update failed:\n' + String(result.stderr || result.stdout || '').slice(-500));
  }
  // Re-run build-runtime so the staged payload + reconcile step land; then verify.
  try {
    runBuildRuntime();
    if (!bootVerify()) throw new Error('boot verification failed after plugin update');
  } catch (error) {
    console.log('[update-kernel] ' + (error.message || error) + ' — restoring plugin snapshot');
    restoreSnapshotManifests();
    fs.rmSync(path.join(profileDir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(path.join(profileDir, 'pnpm-lock.yaml'), { recursive: true, force: true });
    runBuildRuntime();
    writeReminder('插件升级失败已自动回滚', ['插件快照已恢复，profile 回到升级前状态', '失败插件如确认不兼容当前内核，等上游或作者修复后重试 `--plugins`']);
    throw new Error('plugin update rolled back automatically');
  }
  writeReminder('profile 插件已升级（内核保持 ' + current + '）', [
    '启动桌面端实测：新会话发消息 + 切换预设 + 插件卡片',
    '插件如有兼容问题告诉我具体报错，可 `--rollback` 后钉回旧版',
  ]);
  console.log('[update-kernel] plugins updated; restart the desktop app.');
}

async function main() {
  if (mode === '--rollback') {
    rollback();
    return;
  }
  const current = pinnedVersion();
  if (mode === '--check') {
    console.log('[update-kernel] pinned kernel: @deepseek-ai/dsh@' + current);
    console.log('[update-kernel] npm latest:      @deepseek-ai/dsh@' + npm(['view', '@deepseek-ai/dsh', 'version']));
    console.log('[update-kernel] run --auto for the full automatic update, --plugins for plugins only.');
    return;
  }
  if (mode === '--plugins') {
    updatePlugins();
    return;
  }
  const latest = npm(['view', '@deepseek-ai/dsh', 'version']);
  if (mode !== '--auto' && latest === current) {
    console.log('[update-kernel] already on @deepseek-ai/dsh@' + current + ', nothing to do.');
    return;
  }
  if (latest !== current) updateKernel(latest);
  else console.log('[update-kernel] kernel already @' + current + '; skipping kernel, running plugin update.');
  if (mode === '--auto') updatePlugins();
}

main().catch((error) => {
  console.error('[update-kernel] ' + (error && error.message ? error.message : error));
  process.exit(1);
});
