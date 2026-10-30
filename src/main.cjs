'use strict';

/**
 * DeepSeek Harness desktop — Electron main process.
 *
 * The app owns one dsh host child process: it seeds $DSH_HOME/profiles/<name>
 * (this edition's dedicated `mathmodel` profile, overridable via DSH_PROFILE)
 * from the bundled profile when needed, spawns the bundled Node runtime on a
 * dedicated loopback port (never the plain `dsh web` defaults 3080/3081),
 * waits for the GUI, and loads the tokenized URL the host prints. The host is
 * this app's own separate instance — it runs next to any `dsh web` the user
 * starts themselves, and this app owns its full lifecycle (graceful stop on
 * quit, forced after 5s).
 */

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdateController } = require('./update-controller.cjs');
const { acknowledgeBoot } = require('./desktop-updates.cjs');
const { assertUpdateBootSafe } = require('./update-boot-safety.cjs');
const { createStartupTiming, configureHostCompileCache } = require('./startup-timing.cjs');
const {
  resolveRuntimePaths,
  resolveDshHome,
  resolveProfileName,
  profileSeedStamp,
  childEnv,
  readStampFile,
  profileAction,
    isDesktopSeededProfile,
  applyProfileSeed,
  findHostPort,
  waitForGui,
  parseTokenUrlLine,
  ensureProfileFallbacks,
  ensureFrameworkCohort,
  activeWebFamilyRows,
  hasCompleteWebFamily,
  checkVcRuntime,
  isProgrammaticLaunch,
} = require('./runtime.cjs');

const READY_TIMEOUT_MS = 180000;
const LOG_TAIL_LINES = 200;
/** The host prints its tokenized GUI URL on this stdout line. */

// Isolate desktop cookies, caches, logs and the single-instance lock alongside
// an explicitly selected test/development home, before Electron becomes ready.
if (process.env.DSH_DESKTOP_USER_DATA?.trim()) {
  const dataHome = resolveDshHome({ DSH_HOME: process.env.DSH_DESKTOP_USER_DATA }, os.homedir());
  fs.mkdirSync(dataHome, { recursive: true });
  app.setPath('userData', dataHome);
  app.setPath('sessionData', dataHome);
  const crashDumps = path.join(dataHome, 'crash-dumps');
  fs.mkdirSync(crashDumps, { recursive: true });
  app.setPath('crashDumps', crashDumps);
  app.setAppLogsPath(path.join(dataHome, 'logs'));
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let hostChild = null;
let quitting = false;
let logStream = null;
/** URL printed by the host (with the per-process token), set once seen. */
let tokenUrl = null;
let updateController = null;
/** Ring buffer of recent host output for the error page. */
const logTail = [];
const startupTiming = createStartupTiming();

function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
}

function logFilePath() {
  return path.join(app.getPath('logs'), 'dsh-host.log');
}

function pushLogLine(line) {
  // Parse the original host line before adding timing to our own desktop logs.
  const url = parseTokenUrlLine(line);
  if (url !== undefined) tokenUrl = url;
  const output = startupTiming.annotate(line);
  logTail.push(output);
  if (logTail.length > LOG_TAIL_LINES) logTail.shift();
  if (logStream !== null) logStream.write(output + '\n');
}

function setStatus(text) {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:status', text);
}

function startHost(runtime, home, port, profileName) {
  const nodePaths = [
    path.join(runtime.runtimeRoot, 'host', 'node_modules'),
    path.join(home, 'profiles', 'node_modules'),
  ];
  if (process.platform === 'win32' && process.env.APPDATA) {
    const globalNpm = path.join(process.env.APPDATA, 'npm', 'node_modules');
    if (fs.existsSync(globalNpm)) nodePaths.push(globalNpm);
  }
  // `dsh web` is hardcoded to the `web` profile; a custom profile boots via
  // `dsh --profile <name>` with the web app's own flags following.
  const args = [runtime.hostBin, '--profile', profileName, '--no-open', '--host', '127.0.0.1', '--port', String(port)];
  if (process.env.DSH_DESKTOP_UPDATE_JOB) {
    const nonce = process.env.DSH_DESKTOP_UPDATE_NONCE;
    const filename = path.resolve(process.env.DSH_DESKTOP_UPDATE_JOB);
    if (!/^[a-f0-9-]{36}$/.test(nonce || '')
      || path.dirname(filename) !== path.join(app.getPath('userData'), 'desktop-updates')) {
      throw new Error('Pending update host identity mismatch');
    }
    const job = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (job.nonce !== nonce || job.installDir !== path.dirname(app.getPath('exe'))
      || job.toVersion !== app.getVersion() || job.state !== 'prepared') {
      throw new Error('Pending update host identity mismatch');
    }
    args.unshift(`--title=dsh-desktop-update-host-${nonce}`);
  }
  const launch = configureHostCompileCache(args,
    { ...childEnv(home, runtime.nodeHome, process.platform, process.env, nodePaths),
      DSH_DESKTOP_MANAGED_UPDATES: '1' },
    { hostBin: runtime.hostBin,
      preloadPath: path.join(runtime.runtimeRoot, 'host', 'startup-cache.cjs'),
      cacheDir: path.join(home, 'cache', 'node-compile'),
      preloadExists: fs.existsSync });
  const child = spawn(runtime.nodeBin, launch.args, {
    cwd: home,
    env: launch.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
      if (line !== '') pushLogLine(line);
    });
  }
  return child;
}

function stopHost(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const force = setTimeout(() => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolvePromise());
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        resolvePromise();
      }
    }, 5000);
    child.once('exit', () => {
      clearTimeout(force);
      resolvePromise();
    });
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T'], () => { /* graceful attempt only */ });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  });
}

function createWindow() {
  const window = new BrowserWindow({
    show: process.env.DSH_DESKTOP_HEADLESS !== '1',
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek 数学建模版',
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url) && !url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  return window;
}

async function showError(message) {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  await mainWindow.loadFile(path.join(__dirname, 'error.html'));
  mainWindow.webContents.send('desktop:error', {
    message,
    log: logTail.join('\n'),
    logFile: logFilePath(),
  });
}

async function boot() {
  pushLogLine(startupTiming.stage('boot-start'));
  setStatus('正在检查配置…');
  const runtime = resolveRuntimePaths(resourcesRoot(), process.platform, process.arch, app.isPackaged);
  const home = resolveDshHome(process.env, os.homedir());
  assertUpdateBootSafe({ jobPath: process.env.DSH_DESKTOP_UPDATE_JOB,
    nonce: process.env.DSH_DESKTOP_UPDATE_NONCE, installDir: path.dirname(app.getPath('exe')),
    userDataDir: app.getPath('userData'), homeDir: home, version: app.getVersion() });
  pushLogLine('[desktop] dsh home: ' + home);
  pushLogLine('[desktop] Electron user data: ' + app.getPath('userData'));
  pushLogLine('[desktop] Electron session data: ' + app.getPath('sessionData'));
  if (process.env.DSH_DESKTOP_VERIFY !== '1') {
    try {
      const bridge = await require('./kimi-bridge.cjs').ensureKimiBridge({resourcesRoot: resourcesRoot()});
      pushLogLine('[desktop] Kimi browser bridge: ' + (bridge.running ? (bridge.extension_connected ? 'extension connected' : 'waiting for browser extension') : bridge.reason));
    } catch { pushLogLine('[desktop] Kimi browser bridge unavailable; start it or check the browser extension.'); }
  }
  pushLogLine(startupTiming.stage('kimi'));

  if (process.platform === 'win32' && !checkVcRuntime()) {
    pushLogLine('[desktop] warning: Visual C++ runtime (vcruntime140.dll) is missing');
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['前往微软官网下载 (Download)', '稍后手动安装 (Later)'],
        defaultId: 0,
        cancelId: 1,
        title: '缺少系统组件 (Prerequisite Missing)',
        message: '检测到当前系统缺少微软 Visual C++ 运行库（vcruntime140.dll）。',
        detail: '没有该运行库，后台 Node 宿主服务可能无法启动。建议立即安装后再使用。',
      }).then((result) => {
        if (result.response === 0) {
          void shell.openExternal('https://aka.ms/vs/17/release/vc_redist.x64.exe');
        }
      });
    }
  }

  if (!fs.existsSync(runtime.nodeBin)) throw new Error('bundled Node runtime is missing: ' + runtime.nodeBin);
  if (!fs.existsSync(runtime.hostBin)) throw new Error('bundled dsh host is missing: ' + runtime.hostBin);
  pushLogLine(startupTiming.stage('preflight'));

  const stamp = readStampFile(runtime.stampFile);
  const stampText = profileSeedStamp(stamp, runtime.runtimeRoot);
  const profileName = resolveProfileName(process.env);
  pushLogLine('[desktop] dsh profile: ' + profileName);
  const profileDir = path.join(home, 'profiles', profileName);
  const action = profileAction(profileDir, stampText);
  pushLogLine('[desktop] profile action: ' + action + ' (' + stampText + ')');
  if (action !== 'leave') {
    setStatus('正在准备配置…');
    applyProfileSeed(runtime.profileSeed, profileDir, action, stampText, { appVersion: app.getVersion() });
  }
  pushLogLine(startupTiming.stage('profile'));

  if (isDesktopSeededProfile(profileDir)) {
    const { migrateFusionBundle } = await import('../scripts/migrate-fusion-bundle.mjs');
    const fusionMigration = migrateFusionBundle({
      profileDir,
      runtimeRoot: path.join(runtime.runtimeRoot, 'host', 'node_modules'),
      apply: true,
    });
    if (fusionMigration.applied) pushLogLine('[desktop] migrated Fusion loader to bundle selection');
    const { restoreSpecializedPresets } = await import('../scripts/restore-specialized-presets.mjs');
    const presets = restoreSpecializedPresets({
      runtimeRoot: path.join(runtime.runtimeRoot, 'host', 'node_modules'),
      profilePatch: path.join(profileDir, 'cordis.patch.yml'),
      apply: true,
    });
    if (presets.applied) pushLogLine('[desktop] restored specialized presets; backup: ' + presets.backup);
    const { installTaskCapabilityPresets } = await import('../scripts/task-capabilities.mjs');
    const capabilities = installTaskCapabilityPresets({
      runtimeRoot: path.join(runtime.runtimeRoot, 'host', 'node_modules'),
      profilePatch: path.join(profileDir, 'cordis.patch.yml'),
      apply: true,
    });
    if (capabilities.applied) pushLogLine('[desktop] added task capability combinations; backup: ' + capabilities.backup);
  }
  pushLogLine(startupTiming.stage('migrations'));

  const cohort = ensureFrameworkCohort(home, path.join(runtime.runtimeRoot, 'host'), profileName, stampText);
  if (cohort.linked.length > 0) pushLogLine('[desktop] unified official framework packages: ' + cohort.linked.join(', '));
  if (cohort.backupDir) pushLogLine('[desktop] previous framework packages backed up at: ' + cohort.backupDir);
  pushLogLine(startupTiming.stage('cohort'));

  try {
    ensureProfileFallbacks(home, path.join(runtime.runtimeRoot, 'host'), profileName);
  } catch (error) {
    pushLogLine('[desktop] fallback healing warning: ' + String(error && error.message ? error.message : error));
  }
  pushLogLine(startupTiming.stage('fallback'));

  setStatus('Starting the dsh host…');
  setStatus('正在加载服务…');
  const port = await findHostPort();
  pushLogLine('[desktop] spawning the desktop host on 127.0.0.1:' + port
    + ' (the user\u2019s own dsh web defaults 3080/3081 are never taken)');
  hostChild = startHost(runtime, home, port, profileName);
  pushLogLine('[desktop] host pid: ' + hostChild.pid);
  const child = hostChild;
  let exited = false;
  child.once('exit', (code, signal) => {
    exited = true;
    pushLogLine('[desktop] host exited: code=' + String(code) + ' signal=' + String(signal));
    if (!quitting) void showError('The dsh host process stopped unexpectedly.');
  });
  const pendingUpdate = Boolean(process.env.DSH_DESKTOP_UPDATE_JOB);
  // The HTTP listener can answer while the plugin loader is still working.
  // Every window needs the host's authenticated readiness announcement.
  await waitForGui(port, { deadlineMs: pendingUpdate ? 15 * 60 * 1000 : READY_TIMEOUT_MS,
    isAlive: () => !exited,
    getTokenUrl: () => tokenUrl,
  });
  pushLogLine(startupTiming.stage('host-ready'));
  const target = tokenUrl;
  pushLogLine('[desktop] GUI ready, loading the tokenized URL');
  await mainWindow.loadURL(target);
  pushLogLine('[desktop] GUI loaded');
  pushLogLine(startupTiming.stage('gui-loaded'));
  if (process.env.DSH_DESKTOP_UPDATE_JOB) {
    if (!tokenUrl || exited || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Updated host did not publish its own live GUI endpoint');
    }
    const first = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const cookie = first.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const response = await fetch(new URL('/api/dsh-web-all/degraded', target), {
      headers: { cookie }, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Updated host health route failed: ' + response.status);
    const health = await response.json();
    if (!Array.isArray(health.degraded) || health.degraded.length) throw new Error('Updated host has degraded plugins');
    const familyVersion = /^@linxin666\/dsh-web-all@([^\s]+)$/.exec(stamp?.webAll ?? '')?.[1];
    let family = {};
    if (['0.4.11', '0.4.12'].includes(familyVersion)) {
      // 0.4.11 removed /rows; read the active family rows from the plugin manager.
      const rpcId = crypto.randomUUID();
      const response = await fetch(new URL('/api/pluginManager/listPlugins', target), {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'pluginManager/listPlugins', payload: { args: {} } }),
        signal: AbortSignal.timeout(30000),
      });
      const envelope = response.ok ? await response.json() : undefined;
      const children = envelope?.type === 'server-response' && envelope.rpcId === rpcId && envelope.result?.ok === true
        ? activeWebFamilyRows(envelope.result.value) : null;
      if (children) family = { children };
    } else {
      const rows = await fetch(new URL('/api/dsh-web-all/rows', target), {
        headers: { cookie }, signal: AbortSignal.timeout(30000),
      });
      family = rows.ok ? await rows.json() : {};
    }
    if (!hasCompleteWebFamily(family, familyVersion || 'unknown')) throw new Error('Updated host plugin family is incomplete');
    if (exited || child.exitCode !== null || child.signalCode !== null) throw new Error('Updated host exited during boot verification');
    await acknowledgeBoot({ jobPath: process.env.DSH_DESKTOP_UPDATE_JOB,
      nonce: process.env.DSH_DESKTOP_UPDATE_NONCE, installDir: path.dirname(app.getPath('exe')),
      userDataDir: app.getPath('userData'), version: app.getVersion(), pid: process.pid });
    pushLogLine('[desktop] update boot health verified');
  }
  void updateController?.start();
}

async function run() {
  mainWindow = createWindow();
  await mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  try {
    await boot();
  } catch (error) {
    pushLogLine('[desktop] boot failed: ' + String(error && error.message ? error.message : error));
    if (process.env.DSH_DESKTOP_UPDATE_JOB) { app.quit(); return; }
    await showError(String(error && error.message ? error.message : error));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    // Programmatic spawns of this executable (doctor supervisor and
    // provisioning children, CLI helpers) must never raise the window: they
    // are headless Node children that fail the single-instance lock on
    // purpose, and focusing on every retry is the #1382 popup loop.
    if (isProgrammaticLaunch(argv)) return;
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(run).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  if (hostChild !== null) {
    event.preventDefault();
    const child = hostChild;
    hostChild = null;
    void stopHost(child).then(() => app.quit());
  }
});

ipcMain.on('desktop:retry', () => {
  if (quitting) return;
  void run();
});

ipcMain.on('desktop:reveal-log', () => {
  shell.showItemInFolder(logFilePath());
});

ipcMain.on('desktop:quit', () => {
  app.quit();
});

app.whenReady().then(() => {
  try {
    fs.mkdirSync(path.dirname(logFilePath()), { recursive: true });
    logStream = fs.createWriteStream(logFilePath(), { flags: 'a' });
  } catch {
    logStream = null;
  }
  updateController = createUpdateController({ app, dialog, ipcMain, BrowserWindow,
    getWindow: () => mainWindow,
    getHomeDir: () => resolveDshHome(process.env, os.homedir()),
    getNodeBin: () => resolveRuntimePaths(resourcesRoot(), process.platform, process.arch, app.isPackaged).nodeBin,
    log: pushLogLine });
  setupDesktopMenu();
  // Only a validated update job can request a cooperative stop from the worker.
  if (process.env.DSH_DESKTOP_UPDATE_JOB && process.env.DSH_DESKTOP_UPDATE_NONCE) {
    const quitRequest = path.join(app.getPath('userData'), `desktop-update-quit-${process.env.DSH_DESKTOP_UPDATE_NONCE}.json`);
    const timer = setInterval(() => {
      try {
        const request = JSON.parse(fs.readFileSync(quitRequest, 'utf8'));
        if (request.nonce === process.env.DSH_DESKTOP_UPDATE_NONCE && request.pid === process.pid) app.quit();
      } catch { /* No owned shutdown request. */ }
    }, 500);
    timer.unref();
    app.once('will-quit', () => clearInterval(timer));
  }
  if (process.env.DSH_DESKTOP_VERIFY === '1' && process.env.DSH_DESKTOP_HEADLESS === '1'
    && process.env.DSH_DESKTOP_USER_DATA?.trim()) {
    // The isolated packaged-app check can exercise app.quit() without a
    // visible window or a numeric-PID termination of a hidden GUI process.
    const quitRequest = path.join(app.getPath('userData'), 'desktop-quit-request');
    const timer = setInterval(() => {
      if (!fs.existsSync(quitRequest)) return;
      clearInterval(timer);
      pushLogLine('[desktop] verification requested app.quit()');
      app.quit();
    }, 500);
    timer.unref();
    app.once('will-quit', () => clearInterval(timer));
  }
});

function setupDesktopMenu() {
  const template = [
    { label: '桌面更新', submenu: [
      { label: '检查桌面更新', click: () => { void updateController.check(true); } },
      { label: '查看并安装更新', click: () => { void updateController.open(); } },
      { label: '恢复上一个版本', click: () => { void updateController.rollback(); } },
      { type: 'separator' },
      { label: '更新设置', click: () => updateController.showSettings() },
    ] },
    { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'forceReload', label: '强制重新加载' }, { role: 'toggleDevTools', label: '切换开发者工具' }, { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '切换全屏' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
